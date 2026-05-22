// Intentions: filter options into the active intention set, with open-minded
// commitment (slide-03 §6) and a margin to prevent thrashing.
//
// Lifecycle (slide-07 §16): pending → active → succeeded | failed | dropped
// Single active intention at a time for v1.

import { CONFIG } from './config.js';
import { log } from './utils/log.js';

let nextIntentionId = 1;

export class Intention {
  constructor({ type, parcelId, deliveryTile, target, score, meta }) {
    this.id = nextIntentionId++;
    this.type = type;             // 'pickup' | 'deliver' | 'goto' | 'explore'
    this.parcelId = parcelId ?? null;
    this.deliveryTile = deliveryTile ?? null;
    this.target = target ?? null;
    this.score = score ?? 0;
    this.meta = meta ?? {};
    this.status = 'pending';      // pending | active | succeeded | failed | dropped
    this.failures = 0;            // count of failed plan executions
    this.parentId = null;
    this.derived = false;
  }

  describe() {
    if (this.type === 'pickup') return `pickup(${this.parcelId})`;
    if (this.type === 'deliver') {
      const dt = this.deliveryTile;
      const tag = this.meta.forced
        ? `! ${this.meta.forceReason || 'forced'}`
        : '';
      return `deliver→(${dt?.x},${dt?.y})${tag}`;
    }
    if (this.type === 'explore') return 'explore';
    if (this.type === 'goto') return `goto(${this.target?.x},${this.target?.y})`;
    return this.type;
  }
}

export class IntentionManager {
  constructor() {
    this.current = null;          // active Intention
    this.lastSwitchTick = 0;
  }

  /**
   * filter(): given the ranked options from desires(), decide whether to
   * keep the current intention or switch.
   *
   * Slide-03 §6 / §11: open-minded commitment. Switch iff a new option
   * beats the current by a margin OR the current is no longer viable.
   */
  filter(beliefs, options) {
    if (options.length === 0) {
      // No options at all — drop current (rare).
      if (this.current) {
        log.debug(`Drop intention ${this.current.describe()}: no options`);
        this.current.status = 'dropped';
        this.current = null;
      }
      return this.current;
    }

    const top = options[0];

    // No active intention: adopt the top option.
    if (!this.current || this.current.status !== 'active') {
      this.current = makeIntentionFromOption(top);
      this.current.status = 'active';
      this.lastSwitchTick = beliefs.tick;
      log.info(`+ ${this.current.describe()} (score=${top.score.toFixed(2)})`);
      return this.current;
    }

    // Check if the current intention is still viable.
    if (!isStillViable(this.current, beliefs)) {
      log.info(`✗ ${this.current.describe()} no longer viable, switching`);
      this.current.status = 'dropped';
      this.current = makeIntentionFromOption(top);
      this.current.status = 'active';
      this.lastSwitchTick = beliefs.tick;
      log.info(`+ ${this.current.describe()} (score=${top.score.toFixed(2)})`);
      return this.current;
    }

    // Find an option that matches the current intention to compare scores.
    const sameOption = options.find((o) => sameAsIntention(o, this.current));
    const currentScore = sameOption?.score ?? 0;

    // Switch only if top beats current by margin (slide-03 sticky commitment).
    if (top.score > currentScore * (1 + CONFIG.INTENTION_MARGIN)
        && !sameAsIntention(top, this.current)) {
      log.info(`↻ switch ${this.current.describe()} → ${describeOption(top)} (${currentScore.toFixed(2)}→${top.score.toFixed(2)})`);
      this.current.status = 'dropped';
      this.current = makeIntentionFromOption(top);
      this.current.status = 'active';
      this.lastSwitchTick = beliefs.tick;
    }

    return this.current;
  }

  markSucceeded() {
    if (this.current) {
      log.info(`✓ ${this.current.describe()}`);
      this.current.status = 'succeeded';
      this.current = null;
    }
  }

  markFailed(reason) {
    if (!this.current) return;
    this.current.failures += 1;
    log.warn(`! ${this.current.describe()} failure (${this.current.failures}): ${reason}`);
    if (this.current.failures >= 3) {
      this.current.status = 'failed';
      // Note: the dropped intention may have been targeting a blocked tile.
      // The transient-block memory in beliefs persists, so the next
      // intention will route differently.
      this.current = null;
    }
  }

  drop(reason) {
    if (this.current) {
      log.info(`× drop ${this.current.describe()}: ${reason}`);
      this.current.status = 'dropped';
      this.current = null;
    }
  }
}

function makeIntentionFromOption(option) {
  return new Intention({
    type: option.type,
    parcelId: option.parcelId,
    deliveryTile: option.meta?.deliveryTile,
    // For explore options, prefer meta.target (used by exploreOverride
    // waypoints) so the explore plan goes to the right tile.
    target: option.meta?.target ?? option.meta?.deliveryTile,
    score: option.score,
    meta: option.meta,
  });
}

function sameAsIntention(option, intention) {
  if (option.type !== intention.type) return false;
  if (option.type === 'pickup') return option.parcelId === intention.parcelId;
  if (option.type === 'deliver') return true;
  if (option.type === 'explore') return true;
  return false;
}

function describeOption(o) {
  if (o.type === 'pickup') return `pickup(${o.parcelId})`;
  if (o.type === 'deliver') return 'deliver';
  if (o.type === 'explore') return 'explore';
  return o.type;
}

function isStillViable(intention, beliefs) {
  if (intention.type === 'pickup') {
    const p = beliefs.parcels.get(intention.parcelId);
    if (!p) return false;
    if (p.carriedBy && p.carriedBy !== beliefs.me.id) return false;
    if (p.reward <= 0) return false;
    return true;
  }
  if (intention.type === 'deliver') {
    return beliefs.carriedCount() > 0;
  }
  if (intention.type === 'explore') {
    return true;
  }
  return false;
}
