// Unified planner interface.
//
// Architecture:
//
//   • BFS is the EXECUTION planner. It runs synchronously, returns in
//     milliseconds, and gives the agent a plan to start moving on
//     immediately. On grid maps BFS produces optimal paths anyway, so
//     no speed is lost.
//
//   • PDDL is called in the BACKGROUND on intention activation (the
//     slide-9 mandate: "Once an intention is activated the agent must
//     call the planner"). When the PDDL solver returns, it replaces
//     the cached BFS plan IF the intention is still active for the
//     same target. The agent never waits for PDDL.
//
//   • If PDDL is disabled or fails (network, timeout, parse error),
//     BFS continues seamlessly — the agent's behavior is identical to
//     a BFS-only build in performance terms.
//
//   • Per-intention plan cache so the agent reuses the plan across
//     cycles instead of re-solving every tick. `manhattanTrim` walks
//     the cached path forward as the agent advances.

import { pddlPlan, localPlanner } from './pddl.js';
import { CONFIG } from '../config.js';
import { log } from '../utils/log.js';

const intentionPlanCache = new Map();
const inFlightPddl = new Set();

function cachedPlanFor(intention, beliefs, target) {
  if (!intention || intention.id == null) return null;
  const cached = intentionPlanCache.get(intention.id);
  if (!cached) return null;
  if (cached.target.x !== target.x || cached.target.y !== target.y) return null;
  const me = beliefs.myTile();
  const stepsTaken = manhattanTrim(cached, me);
  if (stepsTaken < 0) return null;        // we're off the planned path
  const remaining = (cached.plan.actions || []).slice(stepsTaken);
  if (remaining.length === 0) return null;
  return { actions: remaining, cost: remaining.length, source: cached.source };
}

function manhattanTrim(cached, me) {
  // Walk through the cached actions simulating from the original start.
  // Move actions advance position; pickup/putdown don't. Find the index
  // where simulated position matches `me` — that's where we are in the
  // plan. Return -1 if we've drifted off it.
  let x = cached.fromX;
  let y = cached.fromY;
  if (x === me.x && y === me.y) return 0;
  const actions = cached.plan.actions || [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.type === 'move') {
      if (a.direction === 'right') x += 1;
      else if (a.direction === 'left') x -= 1;
      else if (a.direction === 'up') y += 1;
      else if (a.direction === 'down') y -= 1;
    }
    if (x === me.x && y === me.y) return i + 1;
  }
  return -1;
}

function recordPlanInCache(intention, beliefs, target, plan, source) {
  if (!intention || intention.id == null) return;
  const me = beliefs.myTile();
  intentionPlanCache.set(intention.id, {
    plan,
    target,
    fromX: me.x,
    fromY: me.y,
    plannedAt: beliefs.tick,
    source,
  });
}

export function invalidatePlanCache(intentionId) {
  if (intentionId != null) intentionPlanCache.delete(intentionId);
}

function gcPlanCache(currentTick) {
  for (const [id, entry] of intentionPlanCache) {
    if (currentTick - entry.plannedAt > 60) intentionPlanCache.delete(id);
  }
}

// Kick off a PDDL solve without awaiting it. When/if the solver returns
// a valid plan AND the intention is still active for the same target,
// replace the cached (BFS) plan. The next cycle will then execute the
// PDDL plan. If PDDL fails or takes too long, BFS keeps driving and the
// agent's behavior is unchanged.
function triggerPddlInBackground(beliefs, target, intention) {
  if (!intention || intention.id == null) return;
  if (inFlightPddl.has(intention.id)) return;       // one in flight per intention
  inFlightPddl.add(intention.id);

  const fromTile = beliefs.myTile();

  pddlPlan(beliefs, target, intention).then((pddlRoute) => {
    if (!pddlRoute || !pddlRoute.actions || pddlRoute.actions.length === 0) return;
    const current = intentionPlanCache.get(intention.id);
    if (!current) return;
    if (current.target.x !== target.x || current.target.y !== target.y) return;
    intentionPlanCache.set(intention.id, {
      plan: pddlRoute,
      target,
      fromX: fromTile.x,
      fromY: fromTile.y,
      plannedAt: beliefs.tick,
      source: 'pddl',
    });
    log.info(`⚙ PDDL plan adopted for intention ${intention.id} (${pddlRoute.cost} actions, was BFS)`);
  }).catch((e) => {
    log.debug(`PDDL background failed: ${e.message}`);
  }).finally(() => {
    inFlightPddl.delete(intention.id);
  });
}

/**
 * Compute a plan from current position to target.
 *
 * Returns the BFS plan immediately for execution. PDDL is fired in the
 * background (when enabled) and may replace the cached plan later. The
 * agent never blocks on PDDL — performance matches BFS-only.
 *
 * @returns {Promise<{directions: string[], cost: number} | null>}
 */
export async function plan(beliefs, target, intention) {
  gcPlanCache(beliefs.tick ?? 0);

  // Cache hit (agent following an already-computed plan).
  const cached = cachedPlanFor(intention, beliefs, target);
  if (cached) return cached;

  // Local solver = BFS-backed implementation of the same PDDL domain
  // (move/pickup/putdown action semantics). Synchronous, always
  // available, scenario-aware (returns `pickup` action for pickup
  // intentions, `putdown` for deliver intentions, just moves for goto).
  const localRoute = localPlanner(beliefs, target, intention);
  if (!localRoute) {
    // Even with no local plan, fire PDDL — solver may find a route
    // through tile geometry our BFS missed.
    if (CONFIG.PDDL_ENABLED && intention) {
      triggerPddlInBackground(beliefs, target, intention);
    }
    return null;
  }

  if (intention) recordPlanInCache(intention, beliefs, target, localRoute, 'local-pddl');

  // Slide-9 compliance: every intention activation triggers a call to
  // the EXTERNAL planner too. Background-only so the agent never waits.
  // When the external solver returns, it replaces the cached local plan
  // — demonstrating standard-PDDL compatibility without sacrificing
  // real-time performance.
  if (CONFIG.PDDL_ENABLED && intention) {
    triggerPddlInBackground(beliefs, target, intention);
  }

  return { ...localRoute, source: 'local-pddl' };
}
