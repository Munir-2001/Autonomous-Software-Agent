// PRS-style plan library (slide-03 §8). Each plan declares:
//   context: predicate that must hold to instantiate this plan
//   goal:    predicate that signals success
//   build:   given (beliefs, intention) returns a plan body (sequence of steps)
//
// Plan body steps are: { type: 'action', name, args } | { type: 'subgoal', goal, args }
//
// Intentions and Plans are kept distinct (slide-02 test slide #7).

import { plan as runPlanner } from '../planner/index.js';
import { bfs } from '../planner/bfs.js';
import { manhattan, tileKey } from '../utils/geometry.js';
import { log } from '../utils/log.js';
import { deliveryMultiplierAt } from '../shared/policy-reader.js';

/**
 * Plan: pickup a parcel.
 * Steps: goto(parcel.tile) → pick_up.
 */
export const pickupPlan = {
  name: 'pickup',
  context: (beliefs, intention) =>
    intention.type === 'pickup' && beliefs.parcels.has(intention.parcelId),
  goal: (beliefs, intention) =>
    beliefs.carrying.has(intention.parcelId),
  build: async (beliefs, intention) => {
    const parcel = beliefs.parcels.get(intention.parcelId);
    if (!parcel) {
      log.debug(`pickupPlan: parcel ${intention.parcelId} not in beliefs`);
      return null;
    }

    if (parcel.carriedBy && parcel.carriedBy !== beliefs.me.id) {
      log.debug(`pickupPlan: parcel ${parcel.id} now carried by ${parcel.carriedBy}; skipping`);
      beliefs.markUnreachable(parcel.id, 30);
      return null;
    }

    const me = beliefs.myTile();
    const target = { x: Math.round(parcel.x), y: Math.round(parcel.y) };
    const route = await runPlanner(beliefs, target, intention);
    if (!route) {
      log.warn(`pickupPlan: no path from (${me.x},${me.y}) to parcel ${parcel.id} at (${target.x},${target.y}) — blacklisting for 8 ticks`);
      beliefs.markUnreachable(parcel.id, 8);
      return null;
    }
    // The planner returns actions. PDDL pickup plans already end with a
    // `pickup` action; BFS plans only contain moves so we append pickup.
    const body = [...route.actions];
    const last = body[body.length - 1];
    if (!last || last.type !== 'pickup') body.push({ type: 'pickup' });
    return body;
  },
};

/**
 * Plan: deliver carried parcels at the best currently-reachable delivery tile.
 *
 * Recomputes target on every plan-build so a transiently-blocked delivery
 * tile (enemy parked on it) gets bypassed in favor of an alternative.
 */
export const deliverPlan = {
  name: 'deliver',
  context: (beliefs, intention) =>
    intention.type === 'deliver' && beliefs.carriedCount() > 0,
  goal: (beliefs /*, intention */) => beliefs.carriedCount() === 0,
  build: async (beliefs, intention) => {
    const target = bestDelivery(beliefs);
    if (!target) return null;
    intention.deliveryTile = target;
    intention.target = target;
    const route = await runPlanner(beliefs, target, intention);
    if (!route) return null;
    // PDDL deliver plans end with a `putdown` action; BFS plans don't.
    const body = [...route.actions];
    const last = body[body.length - 1];
    if (!last || last.type !== 'putdown') body.push({ type: 'putdown' });
    return body;
  },
};

/**
 * Plan: explore. Random walk toward a spawning tile when no parcels are
 * believed to exist. (Slide-01 §3: when no parcels visible, camp near
 * spawning tiles for fastest opportunity.)
 */
export const explorePlan = {
  name: 'explore',
  context: (beliefs, intention) => intention.type === 'explore',
  goal: () => false, // never satisfied; intention drops when other options appear
  build: async (beliefs, intention) => {
    const me = beliefs.myTile();
    let target = intention.target;
    if (!target || (me.x === target.x && me.y === target.y)) {
      target = pickExplorationTarget(beliefs);
      intention.target = target;
    }
    if (!target) return null;
    const route = await runPlanner(beliefs, target, intention);
    if (!route || !route.actions || route.actions.length === 0) {
      intention.target = null;
      return null;
    }
    // Only take the first few moves; we re-deliberate after each.
    // Filter out any non-move actions (explore shouldn't pickup/putdown).
    return route.actions.filter((a) => a.type === 'move').slice(0, 3);
  },
};

/**
 * Plan: goto a tile. Used for sub-goals from other plans, but also as a
 * fallback "I'm idle, move toward something useful."
 */
export const gotoPlan = {
  name: 'goto',
  context: (beliefs, intention) => intention.type === 'goto',
  goal: (beliefs, intention) => {
    const me = beliefs.myTile();
    return me.x === intention.target.x && me.y === intention.target.y;
  },
  build: async (beliefs, intention) => {
    const route = await runPlanner(beliefs, intention.target, intention);
    if (!route) return null;
    return route.actions.filter((a) => a.type === 'move');
  },
};

// ----- Helpers -----

function nearestDelivery(beliefs) {
  const me = beliefs.myTile();
  let best = null;
  let bestD = Infinity;
  for (const t of beliefs.map?.deliveryTiles ?? []) {
    const d = manhattan(me, t);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// Best currently-usable delivery tile.
//   1) Prefer tiles that are NOT transient-blocked.
//   2) Score by *true BFS distance* (Manhattan can mislead through walls;
//      sometimes the "farther" tile by Manhattan is actually closer
//      because of corridor topology).
//   3) Tie-break: prefer tiles with no enemy currently on an adjacent
//      tile (avoids walking into a congested zone).
//   4) If every tile is blocked, fall back to the Manhattan-nearest one.
function bestDelivery(beliefs) {
  const me = beliefs.myTile();
  const all = beliefs.map?.deliveryTiles ?? [];
  if (all.length === 0) return null;

  // Level-2 policy: drop tiles flagged as zero-reward, and only
  // exclude transient-blocked when at least one free tile exists.
  const filteredByPolicy = all.filter((t) => deliveryMultiplierAt(t.x, t.y) > 0);
  const policyAllowed = filteredByPolicy.length > 0 ? filteredByPolicy : all;
  const free = policyAllowed.filter((t) => !beliefs.isTransientBlocked(t.x, t.y));
  const candidates = free.length > 0 ? free : policyAllowed;

  // Compute BFS distance for each candidate; null means unreachable.
  // Apply per-tile policy multiplier — a 5× bonus tile beats a closer
  // normal tile when the bonus outweighs the extra travel.
  const occ = beliefs.occupiedByOthers();
  const scored = candidates.map((t) => {
    const route = bfs(beliefs, me, t);
    const dist = route ? route.cost : null;
    // Congestion = number of adjacent tiles occupied by other agents.
    let congestion = 0;
    for (const dir of ['left', 'right', 'up', 'down']) {
      const dx = dir === 'right' ? 1 : dir === 'left' ? -1 : 0;
      const dy = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
      if (occ.has(tileKey(t.x + dx, t.y + dy))) congestion += 1;
    }
    const mult = deliveryMultiplierAt(t.x, t.y);
    // Effective cost = distance ÷ multiplier. A 5× bonus tile that's
    // 10 tiles away beats a 1× tile that's 3 tiles away (eff 2 vs 3).
    const effCost = dist != null ? dist / mult : null;
    return { tile: t, dist, congestion, mult, effCost };
  }).filter((s) => s.dist !== null);

  if (scored.length === 0) {
    // Nothing reachable — fall back to Manhattan-nearest among policy-allowed.
    let best = null;
    let bestD = Infinity;
    for (const t of candidates) {
      const d = manhattan(me, t);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  // Sort by effective cost (distance ÷ policy multiplier) ASC, then
  // congestion ASC (less congested wins ties).
  scored.sort((a, b) => a.effCost - b.effCost || a.congestion - b.congestion);
  return scored[0].tile;
}

// Pick the next spawning tile to patrol.
//
//   1) Exclude the tile we're already on (zero-length route is useless).
//   2) Exclude unreachable tiles (BFS returns null) so we don't commit
//      to a target the planner can't path to.
//   3) Strongly prefer tiles we've NEVER visited — they give the agent a
//      reason to actually tour the map instead of bouncing near one tile.
//   4) Among visited tiles, pick the LEAST-RECENTLY-visited one (oldest
//      `lastSpawnTileVisit` tick).
//   5) Tie-break by predicted-next-spawn ETA when known (cadence model
//      from beliefs), else by closest tile.
//
// Falls back to delivery tiles if no spawning tiles exist on the map.
function pickExplorationTarget(beliefs) {
  const me = beliefs.myTile();
  const spawning = beliefs.map?.spawningTiles ?? [];
  if (spawning.length === 0) {
    const dels = beliefs.map?.deliveryTiles ?? [];
    if (dels.length === 0) return null;
    return dels[Math.floor(Math.random() * dels.length)];
  }

  // Pre-build a set of all spawning-tile keys for fast "is this tile on
  // the path a spawn tile?" lookups.
  const spawnKeys = new Set(spawning.map((s) => tileKey(s.x, s.y)));

  const candidates = [];
  for (const t of spawning) {
    if (t.x === me.x && t.y === me.y) continue;
    const route = bfs(beliefs, me, t);
    if (!route) continue;
    const k = tileKey(t.x, t.y);
    const lastVisit = beliefs.lastSpawnTileVisit.get(k);   // undefined if never
    const visited = lastVisit != null;
    const nextSpawn = beliefs.predictNextSpawnTick(t.x, t.y);

    // Linear-sweep bonus: count how many OTHER spawning tiles lie on the
    // BFS path from us to this target. When pickup points are arranged
    // in a line/cluster, the path naturally passes through several of
    // them — picking the target whose path covers the most spawn tiles
    // turns one walk into a multi-pickup sweep. (Opportunistic-pickup
    // hook in the control loop grabs any parcel sitting on a path tile.)
    let spawnTilesOnPath = 0;
    for (const step of route.path || []) {
      if (step.x === t.x && step.y === t.y) continue;          // exclude the target itself
      if (step.x === me.x && step.y === me.y) continue;        // exclude start
      if (spawnKeys.has(tileKey(step.x, step.y))) spawnTilesOnPath += 1;
    }

    candidates.push({
      t,
      visited,
      lastVisit: visited ? lastVisit : -1,
      pathCost: route.cost,
      etaToSpawn: nextSpawn != null ? Math.max(0, nextSpawn - beliefs.tick) : Infinity,
      spawnTilesOnPath,
    });
  }

  if (candidates.length === 0) {
    // Every spawning tile is unreachable from here — fall back to a delivery
    // tile so the agent still moves toward something useful.
    const dels = beliefs.map?.deliveryTiles ?? [];
    if (dels.length === 0) return null;
    return dels[Math.floor(Math.random() * dels.length)];
  }

  // Sort priority:
  //   1) Unvisited first (we want full coverage).
  //   2) MOST spawn tiles on the BFS path — turns one walk into a sweep
  //      when pickup points are linear/clustered.
  //   3) Oldest last-visit (rotate stale tiles back into rotation).
  //   4) Soonest predicted spawn (race ahead of competitors).
  //   5) Shortest path (cheapest if all else equal).
  candidates.sort((a, b) => {
    if (a.visited !== b.visited) return a.visited ? 1 : -1;
    if (a.spawnTilesOnPath !== b.spawnTilesOnPath) return b.spawnTilesOnPath - a.spawnTilesOnPath;
    if (a.lastVisit !== b.lastVisit) return a.lastVisit - b.lastVisit;
    if (a.etaToSpawn !== b.etaToSpawn) return a.etaToSpawn - b.etaToSpawn;
    return a.pathCost - b.pathCost;
  });

  const choice = candidates[0];
  log.debug(
    `explore → spawn(${choice.t.x},${choice.t.y}) ` +
    `${choice.visited ? `last=${choice.lastVisit}` : 'unvisited'} ` +
    `sweep=${choice.spawnTilesOnPath} ` +
    `eta=${choice.etaToSpawn === Infinity ? '?' : choice.etaToSpawn} ` +
    `cost=${choice.pathCost}`
  );
  return choice.t;
}

// Library lookup
export const PLAN_LIBRARY = [pickupPlan, deliverPlan, gotoPlan, explorePlan];

export async function selectPlan(beliefs, intention) {
  for (const p of PLAN_LIBRARY) {
    if (p.context(beliefs, intention)) {
      const body = await p.build(beliefs, intention);
      if (body && body.length > 0) {
        return { name: p.name, body, intention };
      }
    }
  }
  return null;
}
