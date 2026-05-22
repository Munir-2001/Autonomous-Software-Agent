// Reactive reflex layer — Brooks-style subsumption (slide-02 §3).
// Sits ABOVE the executor. The BDI loop suggests an action; this layer can:
//   - veto the action if it would collide with a known agent
//   - inject a higher-priority opportunistic action (pickup, putdown, divert)
//
// Priority order (high → low):
//   0. Avoid collision (block move into another agent's tile)
//   1. Drop on delivery (we are carrying AND on a delivery tile)
//   2. Pick up parcel on tile (visible parcel under us, not yet carried)
//   2.5. Divert to ADJACENT uncarried parcel (free pickup nearby)
//   3. BDI-suggested action
//   4. Explore (idle fallback handled at intention layer)

import { applyDirection, tileKey } from './utils/geometry.js';
import { log } from './utils/log.js';
import { CONFIG } from './config.js';

/**
 * Decide the next concrete action to emit, given the BDI suggestion and
 * current beliefs.
 *
 * Returns one of:
 *   { action: 'pickup' }
 *   { action: 'putdown' }
 *   { action: 'move', direction }
 *   { action: 'wait' }                    (skipped this tick)
 *   { action: null }
 */
export function reactiveDecide(beliefs, suggested) {
  const me = beliefs.myTile();

  // Reflex 1: drop on delivery if carrying.
  if (beliefs.carriedCount() > 0 && beliefs.isDeliveryTile(me.x, me.y)) {
    return { action: 'putdown', reason: 'reflex:delivery-tile' };
  }

  // Reflex 2: pickup if a visible parcel sits on our tile.
  for (const p of beliefs.parcels.values()) {
    if (p.x === me.x && p.y === me.y && (!p.carriedBy || p.carriedBy === beliefs.me.id)) {
      // Only opportunistic-pickup if we don't already have it.
      if (!beliefs.carrying.has(p.id)) {
        return { action: 'pickup', reason: 'reflex:on-parcel' };
      }
    }
  }

  // Reflex 2.5: divert one tile to grab an ADJACENT uncarried parcel.
  // Skip when we're under force-deliver pressure — at that point getting
  // home matters more than grabbing one more parcel. Only meaningful when
  // we ARE carrying something (otherwise minCarriedReward()=0 would
  // misread as force-deliver).
  const forceDeliverActive = beliefs.carriedCount() > 0 && (
    beliefs.carriedCount() >= CONFIG.CARRY_FORCE_DELIVER
    || beliefs.minCarriedReward() <= CONFIG.CARRIED_DECAY_FORCE_DELIVER
  );

  if (!forceDeliverActive) {
    for (const direction of ['left', 'right', 'up', 'down']) {
      const adj = applyDirection(me, direction);
      if (!adj) continue;
      if (!beliefs.isWalkable(adj.x, adj.y)) continue;
      if (beliefs.isTransientBlocked(adj.x, adj.y)) continue;
      // Don't step into another agent.
      const occ = beliefs.occupiedByOthers();
      if (occ.has(tileKey(adj.x, adj.y))) continue;

      // Is there an uncarried, non-zero-reward parcel sitting there?
      for (const p of beliefs.parcels.values()) {
        if (p.x !== adj.x || p.y !== adj.y) continue;
        if (p.carriedBy && p.carriedBy !== beliefs.me.id) continue;
        if (beliefs.carrying.has(p.id)) continue;
        if ((p.reward ?? 0) <= 0) continue;
        log.info(`◇ adjacent parcel ${p.id} at (${adj.x},${adj.y}) — diverting ${direction}`);
        return { action: 'move', direction, reason: 'reflex:adj-parcel' };
      }
    }
  }

  // No reflex applies — defer to BDI suggestion.
  if (!suggested) return { action: null };

  // Reflex 0: collision avoidance for move actions.
  if (suggested.action === 'move') {
    const target = applyDirection(me, suggested.direction);
    if (!target) return { action: null };

    // Tile must be walkable.
    if (!beliefs.isWalkable(target.x, target.y)) {
      log.debug(`Reflex veto: target (${target.x},${target.y}) not walkable`);
      return { action: 'wait', reason: 'reflex:not-walkable' };
    }

    // Other agent on target tile? Check current beliefs.
    // Mark as transient-blocked so the next plan routes around instead of
    // hammering the same path; if the enemy moves on, the block expires
    // (see beliefs.markBlocked TTL) and we can re-attempt.
    const occ = beliefs.occupiedByOthers();
    if (occ.has(tileKey(target.x, target.y))) {
      beliefs.markBlocked(target.x, target.y);
      log.info(`⊘ enemy on (${target.x},${target.y}); rerouting`);
      return { action: 'wait', reason: 'reflex:enemy-on-target' };
    }
  }

  return suggested;
}
