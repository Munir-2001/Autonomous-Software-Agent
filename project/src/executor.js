// Executor: emits actions to the SDK and reports results back to the loop.
// Handles per-action retries and sleep semantics.

import { CONFIG } from './config.js';
import { log } from './utils/log.js';
import { applyDirection } from './utils/geometry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Executor {
  constructor(socket, beliefs) {
    this.socket = socket;
    this.beliefs = beliefs;
  }

  async move(direction) {
    let timedOut = false;
    for (let i = 0; i <= CONFIG.MAX_MOVE_RETRIES; i++) {
      // The SDK's emitMove uses socket.io's timeout(1000).emitWithAck — when
      // the ack doesn't arrive in 1s the promise REJECTS. We must catch:
      // an unhandled rejection bubbles to the control loop's top-level
      // .catch and kills the process. Treat ack timeouts as soft retries.
      let res;
      let thisAttemptTimedOut = false;
      try {
        res = await this.socket.emitMove(direction);
      } catch (e) {
        timedOut = true;
        thisAttemptTimedOut = true;
        log.debug(`emitMove(${direction}) ack timeout — retrying`);
        res = null;
      }
      if (res) {
        this.beliefs.me.x = res.x;
        this.beliefs.me.y = res.y;
        return { ok: true, x: res.x, y: res.y };
      }
      if (i < CONFIG.MAX_MOVE_RETRIES) {
        // After an ack timeout the server may still be processing the move.
        // Sending another emit too quickly causes an ActionMutex conflict
        // (penalty -1 each — accumulates to a server kick at -1000). Wait
        // longer than MOVEMENT_DURATION (50ms default) to let the previous
        // action settle. After a clean rejection (res === false) a short
        // backoff is enough — the server already finished processing.
        const backoff = thisAttemptTimedOut ? 300 : CONFIG.RETRY_DELAY_MS;
        await sleep(backoff);
      }
    }
    // All retries exhausted. Distinguish two failure modes:
    //   - SERVER REJECTED (res === false): tile is genuinely impassable
    //     right now (wall, enemy, locked, directional rule). Mark transient
    //     blocked so the next plan routes around it.
    //   - ACK TIMEOUT (timedOut): we don't know if the move was rejected
    //     or just lost in flight. Don't mark blocked — that would
    //     blacklist tiles based on transient network/server lag and
    //     poison the BFS map. Just wait briefly and let the next cycle
    //     re-deliberate.
    const me = this.beliefs.myTile();
    const target = applyDirection(me, direction);
    if (!timedOut && target) this.beliefs.markBlocked(target.x, target.y, 4);
    return { ok: false, blockedAt: target, timedOut };
  }

  async pickup() {
    let picked;
    try {
      picked = await this.socket.emitPickup();
    } catch (e) {
      log.debug(`emitPickup ack timeout — treating as no-op`);
      return { ok: false, timedOut: true };
    }
    if (Array.isArray(picked) && picked.length > 0) {
      const totalReward = picked.reduce((s, p) => s + (p.reward ?? 0), 0);
      // Some server configurations omit parcel IDs in the pickup response.
      // Fall back to synthetic IDs so our local carrying state has stable
      // keys and the rest of the agent doesn't reference `undefined`.
      const ids = picked.map((p, i) =>
        p.id != null ? p.id : `local_${this.beliefs.tick}_${i}`
      );
      log.info(`Picked up ${picked.length} (Σreward=${totalReward}): ${ids.join(',')}`);
      for (let i = 0; i < picked.length; i++) {
        const p = picked[i];
        const id = ids[i];
        this.beliefs.carrying.set(id, {
          id,
          reward: this.beliefs.parcels.get(p.id)?.reward ?? p.reward ?? 0,
          lastReward: this.beliefs.tick,
        });
        if (p.id != null) this.beliefs.parcels.delete(p.id);
      }
      return { ok: true, picked };
    }
    return { ok: false };
  }

  async putdown() {
    if (this.beliefs.carriedCount() === 0) return { ok: false, noop: true };

    // Explicit IDs (defensive — avoids any default-arg ambiguity in the SDK).
    // Catch ack timeouts the same way move() does — an unhandled rejection
    // here would kill the control loop.
    const tryOnce = async () => {
      const ids = [...this.beliefs.carrying.keys()];
      try {
        return await this.socket.emitPutdown(ids);
      } catch (e) {
        log.debug(`emitPutdown ack timeout`);
        return null;
      }
    };

    // First attempt.
    let dropped = await tryOnce();
    if (!Array.isArray(dropped) || dropped.length === 0) {
      // Could be a transient ActionMutex conflict (the previous action's
      // promise hasn't fully unwound on the server). Brief wait + one retry.
      await sleep(80);
      dropped = await tryOnce();
    }

    if (Array.isArray(dropped) && dropped.length > 0) {
      const at = this.beliefs.myTile();
      const onDelivery = this.beliefs.isDeliveryTile(at.x, at.y);
      // Sum the rewards we just delivered (server-reported).
      const reward = dropped.reduce((s, d) => s + (d.reward ?? 0), 0);
      const tag = onDelivery
        ? ` (DELIVERED +${reward.toFixed(0)})`
        : ' (no-score-tile)';
      log.info(`Put down ${dropped.length}${tag} at (${at.x},${at.y})`);
      for (const d of dropped) this.beliefs.carrying.delete(d.id);
      return { ok: true, dropped, delivered: onDelivery };
    }

    // Server says we have nothing to drop. Trust it — our local belief is
    // stale. This handles the case where a reflex-driven putdown succeeded
    // server-side but the response was lost / empty (e.g. earlier mutex
    // collision drained the carrying set on the server).
    log.warn(`putdown empty after retry; resyncing local carrying (was ${this.beliefs.carriedCount()})`);
    this.beliefs.carrying.clear();
    return { ok: false, resynced: true };
  }

  async perform(action) {
    if (!action || !action.action) return { ok: false, noop: true };
    switch (action.action) {
      case 'move':    return this.move(action.direction);
      case 'pickup':  return this.pickup();
      case 'putdown': return this.putdown();
      case 'wait':    await sleep(120); return { ok: false, waited: true };
      default:        return { ok: false };
    }
  }
}
