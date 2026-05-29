// BFS pathfinder over the walkable-tile graph.
// Used as the primary planner for `goto` in v1; a PDDL backend can be swapped
// in here without changing the call sites.
//
// Slide-08 §13: PDDL is the spec'd planner; BFS is the reliable fallback.
// We expose the same interface either way: plan(beliefs, target) -> [actions]

import { tileKey, applyDirection, directionFromTo } from '../utils/geometry.js';
import { log } from '../utils/log.js';
import { isForbiddenTile } from '../shared/policy-reader.js';

const DIRECTIONS = ['up', 'right', 'down', 'left'];

// Directional tile entry rules (matches Deliveroo backend Tile.js).
// A directional tile FORBIDS entry from the side opposite to its arrow:
//   '↑' (allows up):    can't enter by moving DOWN onto it (from above)
//   '↓' (allows down):  can't enter by moving UP onto it (from below)
//   '→' (allows right): can't enter by moving LEFT onto it (from the right)
//   '←' (allows left):  can't enter by moving RIGHT onto it (from the left)
// Exit is unrestricted on the server.
const ALLOWED_DIR = {
  '↑': { dx: 0, dy: 1 },
  '→': { dx: 1, dy: 0 },
  '↓': { dx: 0, dy: -1 },
  '←': { dx: -1, dy: 0 },
};

function canEnterTile(beliefs, fromX, fromY, toX, toY) {
  const tileType = beliefs.tileType?.(toX, toY);
  const allowed = ALLOWED_DIR[tileType];
  if (!allowed) return true;          // not a directional tile
  const dx = toX - fromX;
  const dy = toY - fromY;
  // Prohibited entry = moving opposite to the arrow.
  return !(dx === -allowed.dx && dy === -allowed.dy);
}

/**
 * Find a shortest path from `from` to `target` using BFS.
 * `blocked` is a Set<tileKey> of tiles to treat as obstacles in addition to
 * non-walkable tiles in the map.
 *
 * Options:
 *   ignoreTransient — when true, BFS won't avoid transient-blocked tiles.
 *     Used as a last-resort fallback in `planGoto`.
 *
 * Returns:
 *   { path: [{x,y}, ...], directions: ['up','right',...], cost: N }
 *   or null if no path.
 */
export function bfs(beliefs, from, target, blocked = new Set(), { ignoreTransient = false } = {}) {
  if (!beliefs.map) return null;
  const startKey = tileKey(from.x, from.y);
  const targetKey = tileKey(target.x, target.y);
  if (startKey === targetKey) return { path: [from], directions: [], cost: 0 };

  // Treat target tile as walkable even if normally blocked (we want to arrive there).
  const isPassable = (x, y, isTarget) => {
    if (!beliefs.isWalkable(x, y)) return false;
    if (!isTarget && blocked.has(tileKey(x, y))) return false;
    // Transient blocks: skip mid-path so we route around. Allow them as
    // the final target — by the time we arrive, the block will likely
    // have expired.
    if (!ignoreTransient && !isTarget && beliefs.isTransientBlocked(x, y)) return false;
    // Level-2 policy: LLM-supplied forbidden tiles (e.g. "do not go
    // through tile (x,y)"). Treat like a permanent block — never as
    // a target either, since traversing INTO it is what's forbidden.
    if (isForbiddenTile(x, y)) return false;
    return true;
  };

  const queue = [{ x: from.x, y: from.y }];
  const cameFrom = new Map();
  cameFrom.set(startKey, null);

  while (queue.length > 0) {
    const cur = queue.shift();
    const curKey = tileKey(cur.x, cur.y);
    if (curKey === targetKey) {
      // Reconstruct path
      const path = [];
      let k = curKey;
      while (k !== null) {
        const [xs, ys] = k.split('|').map(Number);
        path.unshift({ x: xs, y: ys });
        k = cameFrom.get(k);
      }
      const directions = [];
      for (let i = 1; i < path.length; i++) {
        directions.push(directionFromTo(path[i - 1], path[i]));
      }
      return { path, directions, cost: directions.length };
    }
    for (const d of DIRECTIONS) {
      const nxt = applyDirection(cur, d);
      const nxtKey = tileKey(nxt.x, nxt.y);
      if (cameFrom.has(nxtKey)) continue;
      const isTarget = nxtKey === targetKey;
      if (!isPassable(nxt.x, nxt.y, isTarget)) continue;
      // Honor directional tile entry rules — server rejects moves into
      // a `↑/↓/←/→` tile from the side opposite to its arrow. BFS must
      // not route through a forbidden entry, even for the target tile.
      if (!canEnterTile(beliefs, cur.x, cur.y, nxt.x, nxt.y)) continue;
      cameFrom.set(nxtKey, curKey);
      queue.push(nxt);
    }
  }
  return null;
}

/**
 * Compute path with multi-attempt fallback so a chokepoint with a known
 * enemy doesn't deadlock us:
 *
 *   1. Try with current enemy positions treated as obstacles AND transient
 *      blocks honored. This finds a route that AVOIDS enemies right now.
 *   2. If no such path exists (enemy is the only way through), fall back
 *      to ignoring current enemy positions — we'll either succeed if they
 *      moved, or get reactive-vetoed and re-plan.
 *
 * Slide-07 §12: moving obstacles modeled probabilistically. We use the
 * cheap version: snapshot their current tile and route around.
 */
export function planGoto(beliefs, target) {
  const me = beliefs.myTile();

  // Tier 1: avoid both current enemy positions AND transient blocks.
  // This is the optimal route — sidesteps the enemy AND respects
  // recently-failed tiles.
  const blocked = beliefs.occupiedByOthers();
  let plan = bfs(beliefs, me, target, blocked);
  if (plan) return plan;

  // Tier 2: enemies might move — drop the enemy avoidance, keep transient
  // blocks. The reactive layer will re-veto if the enemy is still there.
  plan = bfs(beliefs, me, target);
  if (plan) {
    log.debug(`planGoto T2: enemy on every detour from (${me.x},${me.y}) to (${target.x},${target.y})`);
    return plan;
  }

  // Tier 3: last resort — ignore transient blocks too. They may have
  // accumulated and over-pruned the search. Better to send the agent down
  // a stale path and let the reactive layer rediscover the real obstacles
  // than to freeze with no plan at all.
  plan = bfs(beliefs, me, target, new Set(), { ignoreTransient: true });
  if (plan) {
    log.info(`↝ planGoto T3: bypassing ${beliefs.transientBlocked.size} stale block(s) — trying older route`);
    return plan;
  }

  log.warn(`planGoto: no path at all from (${me.x},${me.y}) to (${target.x},${target.y})`);
  return null;
}
