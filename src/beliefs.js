// Belief base — flat fact store + integrity constraints (course directive
// from slide-07: NO logical deduction, only facts + IC).
//
// Per-entity models (slide-07 §5):
//   me       → no memory (overwrite from sensing)
//   map      → immutable after first sensing
//   parcels  → no memory when visible; uncertainty model when out of range
//   agents   → no memory when visible; last-seen + decaying confidence otherwise

import { CONFIG } from './config.js';
import { manhattan, tileKey, roundPos } from './utils/geometry.js';
import { log } from './utils/log.js';
import { getPolicy } from './shared/policy-reader.js';

export class Beliefs {
  constructor() {
    this.me = { id: null, name: null, teamId: null, x: 0, y: 0, score: 0, penalty: 0 };
    this.carrying = new Map();    // parcelId -> { id, reward, lastReward }
    this.map = null;              // { width, height, tiles, walkable: Set<string> }
    this.parcels = new Map();     // parcelId -> parcel belief
    this.agents = new Map();      // agentId -> agent belief
    this.config = null;           // server-side game config
    this.tick = 0;                // local logical clock
    this.parcelDecayPerTick = null;   // computed from config when available

    // Transient-blocked tiles: tileKey -> expiresAtTick.
    // Populated when a move fails or reactive layer vetoes due to enemy.
    // Used by BFS to route AROUND temporarily-blocked tiles. Auto-expires
    // after a few sensing ticks so we re-attempt once the blocker has
    // (likely) moved on.
    this.transientBlocked = new Map();

    // Counts how many times each tile has been marked across recent
    // block episodes. Persists across expiries (we'd lose escalation
    // otherwise on every flip-flop) but ages out after a long quiet
    // window via blockMarkLastTick.
    this.blockMarkCount = new Map();
    this.blockMarkLastTick = new Map();   // tileKey -> last mark tick

    // Parcels we tried to plan a path to and BFS returned null. Skipped in
    // candidate scoring for a few ticks so we don't loop forever on a
    // currently-unreachable parcel.
    this.unreachableParcels = new Map();   // parcelId -> expiresAtTick

    // Forced-explore waypoint: when the agent gets persistently stuck on
    // a deliver intention, the control loop picks a tile far from the
    // current obstruction and sets it here. Desires generates a top-
    // priority `explore` option to that tile, overriding deliver/pickup,
    // until the agent reaches it. Then BFS re-plans delivery from a
    // totally different position, breaking the deadlock.
    this.exploreOverride = null;   // {x, y} | null

    // Spawn-cadence tracking: for each spawning tile, record when we
    // saw a parcel newly appear there. Lets us predict next-spawn time
    // and race ahead of competitors who only react to visible parcels.
    //   tileKey -> { observations: [tick, tick, ...], lastSeenParcelId: id }
    this.spawnHistory = new Map();
    this.knownParcelIds = new Set();   // for "is this parcel new?" detection

    // Patrol memory: tick when the agent last walked over each spawning
    // tile. Drives the explore plan's least-recently-visited selection so
    // the agent systematically tours all pickup points instead of sitting
    // near one. Tile never visited → key absent (treated as -∞).
    //   tileKey -> tick
    this.lastSpawnTileVisit = new Map();
  }

  markUnreachable(parcelId, ttlTicks = 8) {
    this.unreachableParcels.set(parcelId, this.tick + ttlTicks);
  }

  isUnreachable(parcelId) {
    const exp = this.unreachableParcels.get(parcelId);
    if (exp == null) return false;
    if (this.tick >= exp) {
      this.unreachableParcels.delete(parcelId);
      return false;
    }
    return true;
  }

  // Mark a tile as transiently impassable.
  //
  //   - Base TTL: 10 ticks (no urgency).
  //   - When carrying a parcel: minimum TTL bumped to 30 — long detours
  //     during delivery would otherwise see the block expire mid-walk
  //     and BFS would revert to the original blocked route.
  //   - 2nd+ mark at same tile: long TTL (60 ticks). After two reactive
  //     vetoes the enemy clearly isn't moving; commit to alternate.
  //   - Count PERSISTS across block expiries (flip-flop scenarios still
  //     accumulate). Resets after 60-tick quiet window (brf cleanup).
  //   - Never SHORTENS an existing block — keeps the maximum expiry.
  markBlocked(x, y, ttlTicks = 10) {
    const key = tileKey(x, y);
    const count = (this.blockMarkCount.get(key) || 0) + 1;
    this.blockMarkCount.set(key, count);
    this.blockMarkLastTick.set(key, this.tick);

    let effectiveTTL = ttlTicks;
    const carrying = this.carrying.size > 0;
    if (carrying) effectiveTTL = Math.max(effectiveTTL, 30);
    if (count >= 2) effectiveTTL = 60;

    const newExp = this.tick + effectiveTTL;
    const existing = this.transientBlocked.get(key);
    if (count >= 2) log.info(`⊗ block (${x},${y}) count=${count} TTL=${effectiveTTL} (persistent — committing to alternate)`);
    else log.info(`⊘ block (${x},${y}) count=${count} TTL=${effectiveTTL}${carrying ? ' (delivery-urgency)' : ''}`);
    if (existing != null && existing > this.tick) {
      this.transientBlocked.set(key, Math.max(existing, newExp));
      return;
    }
    this.transientBlocked.set(key, newExp);
  }

  isTransientBlocked(x, y) {
    const key = tileKey(x, y);
    const exp = this.transientBlocked.get(key);
    if (exp == null) return false;
    if (this.tick >= exp) {
      this.transientBlocked.delete(key);
      return false;
    }
    return true;
  }

  // ===== Initialization =====

  setMap(width, height, tiles) {
    const walkable = new Set();
    const deliveryTiles = [];
    const spawningTiles = [];
    const tileIndex = new Map();
    for (const t of tiles) {
      tileIndex.set(tileKey(t.x, t.y), t);
      // Match the server's walkable rule (Tile.js): anything that is NOT
      // type '0' (wall) is walkable. This includes:
      //   '1' parcel-spawner, '2' delivery, '3' open, '4' base,
      //   '5' / '5!' crate slide / spawner (yes — you can walk on them),
      //   '←↑→↓' directional tiles.
      // Type '0' (wall) is the only impassable kind.
      if (t.type !== '0') {
        walkable.add(tileKey(t.x, t.y));
      }
      if (t.type === '2') deliveryTiles.push({ x: t.x, y: t.y });
      if (t.type === '1') spawningTiles.push({ x: t.x, y: t.y });
    }
    this.map = { width, height, tiles, tileIndex, walkable, deliveryTiles, spawningTiles };
    log.info(`Map ${width}x${height}, ${walkable.size} walkable, ${deliveryTiles.length} delivery, ${spawningTiles.length} spawning`);
  }

  setConfig(config) {
    this.config = config;
    // Try to compute parcel decay per tick from config.
    // The exact field names vary between server versions — best-effort.
    const game = config?.GAME ?? {};
    const decayMs = game.PARCEL_REWARD_DECREASE ?? game.PARCEL_DECREASE ?? null;
    const clockMs = config?.CLOCK ?? null;
    if (decayMs && clockMs) {
      this.parcelDecayPerTick = clockMs / decayMs;
    } else {
      this.parcelDecayPerTick = 1; // safe default: assume 1 reward unit per tick
    }
    log.debug(`Config set; estimated decay-per-tick = ${this.parcelDecayPerTick}`);
  }

  setMe(agent) {
    this.me.id = agent.id;
    this.me.name = agent.name;
    this.me.teamId = agent.teamId;
    if (typeof agent.x === 'number') this.me.x = agent.x;
    if (typeof agent.y === 'number') this.me.y = agent.y;
    this.me.score = agent.score ?? this.me.score;
    this.me.penalty = agent.penalty ?? this.me.penalty;
  }

  myTile() {
    return roundPos(this.me);
  }

  // ===== Belief revision (brf) =====
  // Slide-07 §1: only facts + integrity constraints. No logical closure.

  brf(sensing) {
    this.tick += 1;

    // Patrol memory update: if we're standing on a spawning tile this
    // tick, mark it visited. Records walk-throughs as well as arrivals,
    // so the explore plan picks tiles the agent hasn't been near.
    const myPosForPatrol = this.myTile();
    if (this.tileType(myPosForPatrol.x, myPosForPatrol.y) === '1') {
      this.lastSpawnTileVisit.set(tileKey(myPosForPatrol.x, myPosForPatrol.y), this.tick);
    }

    // Prune expired unreachable parcels (transient blocks pruned later
    // after agent positions are updated, so we can refresh based on
    // current+stale enemy positions first).
    for (const [k, exp] of this.unreachableParcels) {
      if (this.tick >= exp) this.unreachableParcels.delete(k);
    }

    // Build a quick lookup of currently sensed tile keys for "out-of-range" detection.
    const sensedTiles = new Set();
    if (Array.isArray(sensing.positions)) {
      for (const p of sensing.positions) sensedTiles.add(tileKey(p.x, p.y));
    }

    // ----- Parcels -----
    const seenParcelIds = new Set();
    for (const p of (sensing.parcels || [])) {
      seenParcelIds.add(p.id);

      // Spawn detection: a parcel ID we've never seen before AND that
      // sits on a known spawning tile is a fresh spawn. Record it so
      // we can predict the cadence of this spawning tile.
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      if (p.id != null && !this.knownParcelIds.has(p.id)) {
        this.knownParcelIds.add(p.id);
        if (this.tileType(px, py) === '1') {
          const k = tileKey(px, py);
          let h = this.spawnHistory.get(k);
          if (!h) { h = { observations: [], lastSeenParcelId: null }; this.spawnHistory.set(k, h); }
          h.observations.push(this.tick);
          if (h.observations.length > 8) h.observations.shift();
          h.lastSeenParcelId = p.id;
        }
      }

      // Parcels we are CARRYING are tracked separately in `this.carrying`
      // (updated below). Don't also keep them in `this.parcels` — that
      // would make them show up as pickup candidates and trap us in a
      // pickup-the-thing-we-already-have loop.
      if (p.carriedBy === this.me.id) {
        this.parcels.delete(p.id);
        continue;
      }
      const decayedReward = p.reward; // server reports current reward
      // Round position at ingest. Parcels can have fractional coords
      // when carried by an agent mid-move; we want planner-friendly
      // integer tiles in our beliefs.
      this.parcels.set(p.id, {
        id: p.id,
        x: Math.round(p.x),
        y: Math.round(p.y),
        reward: decayedReward,
        rewardAtLastSeen: decayedReward,
        carriedBy: p.carriedBy ?? null,
        lastSeenTick: this.tick,
        confidence: 1.0,
      });
    }

    // For tracked parcels: revise.
    for (const [id, p] of this.parcels) {
      if (seenParcelIds.has(id)) continue;

      const inSensedTile = sensedTiles.has(tileKey(p.x, p.y));
      const myPos = this.myTile();
      const onMyTile = myPos.x === p.x && myPos.y === p.y;

      if (inSensedTile || onMyTile) {
        // We can see the tile and the parcel isn't there → CONTRADICTION (revision).
        // Drop the belief.
        log.debug(`Belief revised: parcel ${id} not at (${p.x},${p.y}) anymore`);
        this.parcels.delete(id);
        continue;
      }

      // Out of range — apply decay model (slide-07 §7).
      const ticksSince = this.tick - p.lastSeenTick;
      // Distance-based + time-based decay combined.
      const dSelf = manhattan(myPos, p);
      const distanceFactor = Math.exp(-CONFIG.LAMBDA * Math.max(0, dSelf - 1));
      const timeFactor = Math.exp(-CONFIG.LAMBDA * 0.3 * ticksSince);
      p.confidence = Math.max(0, distanceFactor * timeFactor);

      // Local reward decay since last sighting.
      const decayed = p.rewardAtLastSeen - (this.parcelDecayPerTick * ticksSince);
      p.reward = Math.max(0, decayed);

      // Hard expiry guards.
      if (ticksSince > CONFIG.STALE_PARCEL_TICKS || p.reward <= 0 || p.confidence < CONFIG.CONFIDENCE_THRESHOLD * 0.5) {
        this.parcels.delete(id);
      }
    }

    // ----- Agents -----
    const seenAgentIds = new Set();
    for (const a of (sensing.agents || [])) {
      if (a.id === this.me.id) continue;
      seenAgentIds.add(a.id);
      const prev = this.agents.get(a.id);
      const velocity = prev
        ? { dx: a.x - prev.x, dy: a.y - prev.y }
        : { dx: 0, dy: 0 };
      this.agents.set(a.id, {
        id: a.id,
        name: a.name,
        teamId: a.teamId,
        x: a.x,
        y: a.y,
        score: a.score,
        velocity,
        lastSeenTick: this.tick,
        confidence: 1.0,
      });
    }

    for (const [id, a] of this.agents) {
      if (seenAgentIds.has(id)) continue;
      const ticksSince = this.tick - a.lastSeenTick;
      a.confidence = Math.exp(-CONFIG.LAMBDA * 0.4 * ticksSince);
      if (ticksSince > CONFIG.STALE_AGENT_TICKS) {
        this.agents.delete(id);
      }
    }

    // ----- Refresh transient blocks based on enemy positions -----
    // Use this.agents (current + stale-tracked) instead of just sensing —
    // when our agent walks the detour and the blocker falls out of our
    // sensing radius, we must still treat their last-known tile as
    // occupied. Otherwise the block expires too early and BFS reverts to
    // the direct (still-blocked) path.
    const enemyTiles = new Set();
    for (const a of this.agents.values()) {
      enemyTiles.add(tileKey(Math.round(a.x), Math.round(a.y)));
    }
    for (const [key] of this.transientBlocked) {
      if (enemyTiles.has(key)) {
        // Refresh to base TTL. Keeps long TTLs (post-escalation) in
        // place via Math.max. Don't use a smaller TTL here or freshly
        // marked blocks would be shortened on the next sensing tick.
        const cur = this.transientBlocked.get(key);
        const refreshed = this.tick + 10;
        this.transientBlocked.set(key, Math.max(cur, refreshed));
      }
    }

    // Prune expired transient blocks. Note: we deliberately do NOT reset
    // blockMarkCount here — the count must persist across block episodes
    // so flip-flop scenarios (block expires → re-mark → expires → re-mark)
    // can still accumulate to the escalation threshold. Counts age out
    // after a long quiet window below.
    for (const [k, exp] of this.transientBlocked) {
      if (this.tick >= exp) {
        this.transientBlocked.delete(k);
      }
    }

    // Long-window cleanup: forget mark counts for tiles we haven't marked
    // in 60+ ticks (a chronic chokepoint that hasn't been hit recently
    // probably isn't a chokepoint anymore).
    for (const [k, lastTick] of this.blockMarkLastTick) {
      if (this.tick - lastTick > 60) {
        this.blockMarkLastTick.delete(k);
        this.blockMarkCount.delete(k);
      }
    }

    // ----- Carrying revision -----
    // Sync carrying set: a parcel I carry must be reported as carriedBy === me.id
    // (when in sensing range), otherwise I trust my own tracking.
    // Update carried rewards from server's current reading.
    for (const p of (sensing.parcels || [])) {
      if (p.carriedBy === this.me.id) {
        const existing = this.carrying.get(p.id) || { id: p.id, reward: p.reward };
        existing.reward = p.reward;
        existing.lastReward = this.tick;
        this.carrying.set(p.id, existing);
      }
    }
    // Locally decay rewards of carried parcels each tick.
    for (const c of this.carrying.values()) {
      const since = this.tick - (c.lastReward ?? this.tick);
      c.reward = Math.max(0, c.reward - this.parcelDecayPerTick * since);
      c.lastReward = this.tick;
    }
  }

  // ===== Helpers =====

  isWalkable(x, y) {
    return this.map?.walkable.has(tileKey(x, y)) ?? false;
  }

  tileType(x, y) {
    return this.map?.tileIndex.get(tileKey(x, y))?.type ?? null;
  }

  isDeliveryTile(x, y) {
    return this.tileType(x, y) === '2';
  }

  // Tiles currently believed occupied by another agent (last-known position).
  occupiedByOthers() {
    const set = new Set();
    for (const a of this.agents.values()) {
      set.add(tileKey(Math.round(a.x), Math.round(a.y)));
    }
    return set;
  }

  // Predict the next spawn tick for a spawning tile from observed
  // history. Uses mean inter-arrival time across recorded observations.
  // Returns null if we have insufficient data (need at least 2 spawns).
  predictNextSpawnTick(tileX, tileY) {
    const k = tileKey(tileX, tileY);
    const h = this.spawnHistory.get(k);
    if (!h || h.observations.length < 2) return null;
    const obs = h.observations;
    let totalInterval = 0;
    for (let i = 1; i < obs.length; i++) totalInterval += obs[i] - obs[i - 1];
    const meanInterval = totalInterval / (obs.length - 1);
    const lastSpawn = obs[obs.length - 1];
    return lastSpawn + meanInterval;
  }

  // Returns spawning tiles where a parcel is likely to appear soon
  // (within the next `horizonTicks` ticks). Each entry includes the
  // estimated spawn tick so the planner can race to be there in time.
  upcomingSpawns(horizonTicks = 30) {
    const out = [];
    for (const t of this.map?.spawningTiles ?? []) {
      // Skip if a parcel is currently sitting on this tile (already
      // a candidate via the normal pipeline).
      const occupied = [...this.parcels.values()].some(
        (p) => p.x === t.x && p.y === t.y
      );
      if (occupied) continue;
      const nextSpawnTick = this.predictNextSpawnTick(t.x, t.y);
      if (nextSpawnTick == null) continue;
      const eta = nextSpawnTick - this.tick;
      if (eta < -5 || eta > horizonTicks) continue;
      out.push({ x: t.x, y: t.y, etaTicks: Math.max(0, eta) });
    }
    return out;
  }

  // List visible-or-tracked uncarried parcels (potential targets).
  // Level-2 policy: maxParcelRewardAtDelivery — refuse to even chase
  // high-reward parcels when the mission says "no reward above N".
  candidateParcels() {
    const maxReward = getPolicy('maxParcelRewardAtDelivery');
    const out = [];
    for (const p of this.parcels.values()) {
      if (p.carriedBy && p.carriedBy !== this.me.id) continue;
      if (maxReward != null && p.reward > maxReward) continue;
      // Skip parcels WE already carry — sensing keeps reporting them
      // because they're at our position, but they shouldn't be re-pickup
      // candidates; that's an infinite loop trap.
      if (this.carrying.has(p.id)) continue;
      if (p.reward <= 0) continue;
      if (this.isUnreachable(p.id)) continue;
      out.push(p);
    }
    return out;
  }

  carriedTotal() {
    let s = 0;
    for (const c of this.carrying.values()) s += c.reward;
    return s;
  }

  carriedCount() {
    return this.carrying.size;
  }

  minCarriedReward() {
    let m = Infinity;
    for (const c of this.carrying.values()) if (c.reward < m) m = c.reward;
    return m === Infinity ? 0 : m;
  }
}
