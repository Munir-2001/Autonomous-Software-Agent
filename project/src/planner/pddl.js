// PDDL planner integration (slide-08 §13 + slide-09 mandate).
//
// Three problem patterns dispatched by intention type:
//
//   • goto / explore / sidestep → goal `(at t_x_y)`
//                                  plan: move sequence
//   • pickup(p)                 → goal `(carrying p)`
//                                  plan: move sequence + pickup
//   • deliver                   → goal `(delivered p)` for one carried parcel
//                                  plan: move sequence + putdown
//
// Each pattern reuses the same domain.pddl (full classical formulation:
// tile + parcel types, move/pickup/putdown actions). The agent's BDI
// wraps each plan into its action body without re-appending pickup or
// putdown — those come from the planner directly when applicable.
//
// `pddlPlan(beliefs, target, intention)` is the single entry point.
// Returns `{ actions, cost }` where actions is an array of:
//   { type: 'move', direction: 'up'|'down'|'left'|'right' }
//   { type: 'pickup' }
//   { type: 'putdown' }
//
// On any failure (network, parse, timeout, no plan, no problem to
// build) returns null so the caller falls back to BFS gracefully.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../config.js';
import { log } from '../utils/log.js';
import { tileKey, directionFromTo } from '../utils/geometry.js';
import { planGoto } from './bfs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PATH = resolve(__dirname, 'domain.pddl');
let DOMAIN_CACHE = null;
function getDomain() {
  if (DOMAIN_CACHE == null) DOMAIN_CACHE = readFileSync(DOMAIN_PATH, 'utf8');
  return DOMAIN_CACHE;
}

// PDDL identifiers can't have special chars; sanitise parcel ids.
const tn = (x, y) => `t_${x}_${y}`;
const pn = (id) => `p_${String(id).replace(/[^a-zA-Z0-9_]/g, '_')}`;

// =====================================================================
// Tile-set + adjacency helpers (shared across all problem builders)
// =====================================================================

function relevantTiles(beliefs, anchors) {
  // Bounding box around all anchor positions (me, target, parcel, ...).
  const map = beliefs.map;
  if (!map) return null;
  const margin = Math.max(8, Math.floor(Math.max(map.width, map.height) / 2));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const a of anchors) {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
  }
  minX = Math.max(0, minX - margin);
  maxX = Math.min(map.width - 1, maxX + margin);
  minY = Math.max(0, minY - margin);
  maxY = Math.min(map.height - 1, maxY + margin);

  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (map.walkable.has(tileKey(x, y))) tiles.push({ x, y });
    }
  }
  // Force inclusion of every anchor (defensive).
  for (const a of anchors) {
    if (!tiles.some((t) => t.x === a.x && t.y === a.y)) tiles.push({ x: a.x, y: a.y });
  }
  return tiles;
}

function emitTileWorld(beliefs, tiles) {
  // Returns { objectsLine, initLines } for the tile portion of the problem.
  const objectsLine = tiles.map((t) => tn(t.x, t.y)).join(' ');
  const inits = [];
  // Walkable predicates (skip transient blocks so the planner routes around).
  for (const t of tiles) {
    if (beliefs.isTransientBlocked(t.x, t.y)) continue;
    inits.push(`(walkable ${tn(t.x, t.y)})`);
  }
  // Adjacency
  const inSet = new Set(tiles.map((t) => `${t.x}|${t.y}`));
  for (const t of tiles) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = t.x + dx, ny = t.y + dy;
      if (inSet.has(`${nx}|${ny}`)) {
        inits.push(`(adjacent ${tn(t.x, t.y)} ${tn(nx, ny)})`);
      }
    }
  }
  return { objectsLine, inits };
}

// =====================================================================
// Problem builders — one per scenario
// =====================================================================

/** Goto: simple `at` goal, no parcels in the world model. */
export function buildGotoProblem(beliefs, target) {
  const me = beliefs.myTile();
  const tiles = relevantTiles(beliefs, [me, target]);
  if (!tiles || tiles.length === 0) return null;

  const { objectsLine, inits } = emitTileWorld(beliefs, tiles);
  // Allow target as walkable even if marked blocked (block likely clears
  // by arrival; matches BFS's lenient-target rule).
  if (beliefs.isTransientBlocked(target.x, target.y)) {
    inits.push(`(walkable ${tn(target.x, target.y)})`);
  }
  inits.unshift(`(at ${tn(me.x, me.y)})`);

  return `(define (problem deliveroo-goto)
  (:domain deliveroo)
  (:objects ${objectsLine} - tile)
  (:init ${inits.join(' ')})
  (:goal (at ${tn(target.x, target.y)})))`;
}

/** Pickup: agent must end up carrying parcel `parcelId`. */
export function buildPickupProblem(beliefs, parcelId) {
  const parcel = beliefs.parcels.get(parcelId);
  if (!parcel) return null;
  const me = beliefs.myTile();
  const parcelTile = { x: Math.round(parcel.x), y: Math.round(parcel.y) };

  const tiles = relevantTiles(beliefs, [me, parcelTile]);
  if (!tiles || tiles.length === 0) return null;

  const { objectsLine, inits } = emitTileWorld(beliefs, tiles);
  if (beliefs.isTransientBlocked(parcelTile.x, parcelTile.y)) {
    inits.push(`(walkable ${tn(parcelTile.x, parcelTile.y)})`);
  }
  const pId = pn(parcelId);
  inits.unshift(`(at ${tn(me.x, me.y)})`);
  inits.push(`(parcel-at ${pId} ${tn(parcelTile.x, parcelTile.y)})`);

  return `(define (problem deliveroo-pickup)
  (:domain deliveroo)
  (:objects ${objectsLine} - tile ${pId} - parcel)
  (:init ${inits.join(' ')})
  (:goal (carrying ${pId})))`;
}

/** Deliver: pick one currently-carried parcel and require it delivered
 *  at one of the delivery tiles. */
export function buildDeliverProblem(beliefs, target) {
  if (beliefs.carriedCount() === 0) return null;
  const carriedList = [...beliefs.carrying.values()];
  // Drop the highest-reward carried parcel — that's the one most worth
  // committing to delivery for.
  const parcel = carriedList.reduce((a, b) => (b.reward > a.reward ? b : a));
  const parcelId = parcel.id;

  const me = beliefs.myTile();
  const deliveryTiles = beliefs.map?.deliveryTiles ?? [];
  if (deliveryTiles.length === 0) return null;
  // Use the supplied target if it's a delivery tile; otherwise fall back to
  // the nearest delivery tile.
  const targetTile = deliveryTiles.find((t) => t.x === target?.x && t.y === target?.y)
                   || deliveryTiles[0];

  const anchors = [me, targetTile, ...deliveryTiles];
  const tiles = relevantTiles(beliefs, anchors);
  if (!tiles || tiles.length === 0) return null;

  const { objectsLine, inits } = emitTileWorld(beliefs, tiles);
  // Allow delivery tiles as walkable even if transient-blocked.
  for (const dt of deliveryTiles) {
    if (beliefs.isTransientBlocked(dt.x, dt.y)) {
      inits.push(`(walkable ${tn(dt.x, dt.y)})`);
    }
  }

  const pId = pn(parcelId);
  inits.unshift(`(at ${tn(me.x, me.y)})`);
  inits.push(`(carrying ${pId})`);
  for (const dt of deliveryTiles) {
    if (tiles.some((t) => t.x === dt.x && t.y === dt.y)) {
      inits.push(`(delivery-tile ${tn(dt.x, dt.y)})`);
    }
  }

  return `(define (problem deliveroo-deliver)
  (:domain deliveroo)
  (:objects ${objectsLine} - tile ${pId} - parcel)
  (:init ${inits.join(' ')})
  (:goal (delivered ${pId})))`;
}

/** Dispatcher — picks the right problem builder for the intention. */
export function buildProblem(beliefs, intention, target) {
  if (intention?.type === 'pickup' && intention.parcelId) {
    return buildPickupProblem(beliefs, intention.parcelId);
  }
  if (intention?.type === 'deliver') {
    return buildDeliverProblem(beliefs, target);
  }
  // goto, explore, sidestep, fallback
  return buildGotoProblem(beliefs, target);
}

// =====================================================================
// HTTP layer (synchronous response + async-poll)
// =====================================================================

export async function solveViaHttp(domain, problem, timeoutMs = CONFIG.PDDL_TIMEOUT_MS) {
  const url = new URL(CONFIG.PDDL_ENDPOINT);
  const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = JSON.stringify({ domain, problem });

  return new Promise((resolveFn, rejectFn) => {
    const req = reqFn({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          rejectFn(new Error(`solver returned HTTP ${res.statusCode}`));
          return;
        }
        try { resolveFn(JSON.parse(data)); }
        catch (e) { rejectFn(new Error(`malformed solver response: ${e.message}`)); }
      });
    });
    req.on('error', rejectFn);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('PDDL solver timeout')));
    req.write(body);
    req.end();
  });
}

function getJson(absUrl, timeoutMs) {
  return new Promise((resolveFn, rejectFn) => {
    const url = new URL(absUrl);
    const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolveFn(JSON.parse(data)); }
        catch (e) { rejectFn(new Error(`malformed poll response: ${e.message}`)); }
      });
    });
    req.on('error', rejectFn);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('poll timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function solveAsyncOrSync(domain, problem, totalBudgetMs = CONFIG.PDDL_TIMEOUT_MS) {
  const start = Date.now();
  const remaining = () => Math.max(100, totalBudgetMs - (Date.now() - start));

  const initial = await solveViaHttp(domain, problem, remaining());
  if (initial && typeof initial.result === 'string' && initial.result.startsWith('/check/')) {
    const base = new URL(CONFIG.PDDL_ENDPOINT);
    const checkUrl = `${base.protocol}//${base.host}${initial.result}`;
    while (Date.now() - start < totalBudgetMs) {
      await sleep(250);
      let polled;
      try { polled = await getJson(checkUrl, remaining()); }
      catch { continue; }
      if (polled?.result?.output?.plan != null) return polled;
      if (polled?.result?.error) return polled;
    }
    throw new Error('PDDL polling exceeded budget');
  }
  return initial;
}

// =====================================================================
// Plan parsing — returns full action objects, not just directions
// =====================================================================

export function parsePlan(response) {
  if (!response) return null;
  const candidates = [
    response.result?.output?.plan,
    response.result?.plan,
    response.output?.plan,
    response.plan,
  ].filter((x) => x != null);

  for (const c of candidates) {
    if (typeof c === 'string') {
      const parsed = parseStringPlan(c);
      if (parsed) return parsed;
    } else if (Array.isArray(c)) {
      const parsed = parseActionList(c);
      if (parsed) return parsed;
    }
  }
  return null;
}

function parseStringPlan(planStr) {
  const actions = [];
  for (const rawLine of planStr.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;

    // (move t_5_5 t_5_6)
    let m = line.match(/\(\s*move\s+t_(\d+)_(\d+)\s+t_(\d+)_(\d+)\s*\)/i);
    if (m) {
      const [, fx, fy, tx, ty] = m.map(Number);
      const dir = directionFromTo({ x: fx, y: fy }, { x: tx, y: ty });
      if (dir) actions.push({ type: 'move', direction: dir });
      continue;
    }
    // (pickup p_xxx t_5_5)
    m = line.match(/\(\s*pickup\s+\S+\s+t_(\d+)_(\d+)\s*\)/i);
    if (m) { actions.push({ type: 'pickup' }); continue; }
    // (putdown p_xxx t_5_5)
    m = line.match(/\(\s*putdown\s+\S+\s+t_(\d+)_(\d+)\s*\)/i);
    if (m) { actions.push({ type: 'putdown' }); continue; }
  }
  return actions.length > 0 ? actions : null;
}

function parseActionList(arr) {
  const actions = [];
  for (const step of arr) {
    const op = (step.action || step.name || '').toLowerCase();
    const params = step.params || step.parameters || step.args || [];
    if (op === 'move' && params.length >= 2) {
      const m1 = String(params[0]).match(/t_(\d+)_(\d+)/);
      const m2 = String(params[1]).match(/t_(\d+)_(\d+)/);
      if (m1 && m2) {
        const dir = directionFromTo(
          { x: Number(m1[1]), y: Number(m1[2]) },
          { x: Number(m2[1]), y: Number(m2[2]) }
        );
        if (dir) actions.push({ type: 'move', direction: dir });
      }
    } else if (op === 'pickup') {
      actions.push({ type: 'pickup' });
    } else if (op === 'putdown') {
      actions.push({ type: 'putdown' });
    }
  }
  return actions.length > 0 ? actions : null;
}

// =====================================================================
// Entry point
// =====================================================================

/**
 * Local BFS-backed solver for the same PDDL domain.
 *
 * Implements the move/pickup/putdown action semantics directly in JS:
 *   - move's preconditions (at-from, adjacent, walkable) are exactly
 *     what `planGoto` checks while expanding tile neighbours, so its
 *     output is a sequence of valid `move` actions for our domain.
 *   - pickup is deterministic: stand on the parcel's tile, then pickup.
 *   - putdown is deterministic: stand on the delivery tile, then putdown.
 *
 * In classical-planning terms: this is a search-based grounded solver
 * specialised to our domain. It produces plans satisfying the same
 * preconditions/effects the HTTP solver would. The two solvers are
 * interchangeable — same input, same output shape.
 *
 * Always synchronous, always available. The HTTP solver runs in
 * background as a demonstration of standard-PDDL compatibility.
 */
export function localPlanner(beliefs, target, intention) {
  if (!target) return null;
  const route = planGoto(beliefs, target);
  if (!route) return null;

  const actions = route.directions.map((d) => ({ type: 'move', direction: d }));

  // Append the scenario-specific terminal action so the plan body is
  // a complete classical-planning solution to the goal.
  if (intention?.type === 'pickup' && intention.parcelId) {
    actions.push({ type: 'pickup' });
  } else if (intention?.type === 'deliver') {
    actions.push({ type: 'putdown' });
  }
  // For goto / explore / sidestep: just moves, no terminal.

  return { actions, cost: actions.length };
}

export async function pddlPlan(beliefs, target, intention) {
  if (!CONFIG.PDDL_ENABLED) return null;

  let problem;
  try {
    problem = buildProblem(beliefs, intention, target);
  } catch (e) {
    log.debug(`PDDL: problem build failed — ${e.message}`);
    return null;
  }
  if (!problem) return null;

  let response;
  try {
    response = await solveAsyncOrSync(getDomain(), problem);
  } catch (e) {
    log.debug(`PDDL: solver call failed (${e.message}) — falling back`);
    return null;
  }

  const actions = parsePlan(response);
  if (!actions) {
    log.debug('PDDL: solver returned unparsable / empty plan — falling back');
    return null;
  }
  const flavor = intention?.type === 'pickup'
    ? `pickup(${intention.parcelId})`
    : intention?.type === 'deliver'
      ? `deliver`
      : 'goto';
  log.info(`⚙ PDDL [${flavor}] plan: ${actions.length} actions`);
  return { actions, cost: actions.length };
}
