// Policy reader — BDI side of the LLM → BDI reverse bridge.
//
// The LLM agent writes `state/llm-policy.json` whenever a Level-2
// special mission demands a strategy change. The BDI agent reads
// these overrides each cycle (sub-millisecond mtime-cached read)
// and adjusts its desires / scoring / planning accordingly.
//
// Slide grounding (Part-2 spec §11):
//   "The agent must also be able to execute the plan and adapt it
//    dynamically if observations from the environment change or if
//    the current objective is modified or replaced."
//
// Policy schema (all keys optional, absent = no override):
//
//   requiredStackSize        : int   — only deliver when carrying exactly N parcels
//   forbiddenTiles           : [[x,y], ...]  — BFS treats these as walls
//   bonusDeliveryTiles       : { "x|y": multiplier }  — boost score at these tiles
//   zeroRewardDeliveryTiles  : ["x|y", ...]  — treat as no-score
//   maxParcelRewardAtDelivery: int   — refuse to deliver parcels valued above this
//   rendezvousTarget         : { x, y, deadline }  — wait/meet for L3 missions
//
// Defaults: see DEFAULTS below. Use `getPolicy(key)` from BDI modules;
// never read the file directly — the cache + schema validation lives here.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../utils/log.js';
import { tileKey } from '../utils/geometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = join(__dirname, '..', '..', 'state', 'llm-policy.json');

const DEFAULTS = Object.freeze({
  requiredStackSize: null,
  forbiddenTiles: [],
  bonusDeliveryTiles: {},
  zeroRewardDeliveryTiles: [],
  maxParcelRewardAtDelivery: null,
  rendezvousTarget: null,
});

let cached = { ...DEFAULTS };
let lastMtime = 0;

/**
 * Normalize / validate raw policy JSON into a canonical shape.
 * Unknown keys are dropped (with a warning logged once per fresh file).
 */
function normalize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;

  if (Number.isInteger(raw.requiredStackSize) && raw.requiredStackSize > 0) {
    out.requiredStackSize = raw.requiredStackSize;
  }
  if (Array.isArray(raw.forbiddenTiles)) {
    out.forbiddenTiles = raw.forbiddenTiles
      .filter((t) => Array.isArray(t) && t.length === 2 && Number.isFinite(t[0]) && Number.isFinite(t[1]))
      .map(([x, y]) => [Math.round(x), Math.round(y)]);
  }
  if (raw.bonusDeliveryTiles && typeof raw.bonusDeliveryTiles === 'object') {
    out.bonusDeliveryTiles = {};
    for (const [k, v] of Object.entries(raw.bonusDeliveryTiles)) {
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) out.bonusDeliveryTiles[k] = num;
    }
  }
  if (Array.isArray(raw.zeroRewardDeliveryTiles)) {
    out.zeroRewardDeliveryTiles = raw.zeroRewardDeliveryTiles.filter((k) => typeof k === 'string');
  }
  if (Number.isFinite(raw.maxParcelRewardAtDelivery)) {
    out.maxParcelRewardAtDelivery = raw.maxParcelRewardAtDelivery;
  }
  if (raw.rendezvousTarget && typeof raw.rendezvousTarget === 'object') {
    const r = raw.rendezvousTarget;
    if (Number.isFinite(r.x) && Number.isFinite(r.y)) {
      out.rendezvousTarget = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        deadline: Number.isFinite(r.deadline) ? r.deadline : null,
      };
    }
  }
  return out;
}

/**
 * Refresh the cache iff the file's mtime changed since last read.
 * Returns the (cached) normalized policy object.
 */
function refresh() {
  if (!existsSync(POLICY_FILE)) {
    if (lastMtime !== 0) {
      // File was deleted — fall back to defaults.
      cached = { ...DEFAULTS };
      lastMtime = 0;
      log.info('policy-reader: llm-policy.json removed — reset to defaults');
    }
    return cached;
  }
  try {
    const stat = statSync(POLICY_FILE);
    if (stat.mtimeMs === lastMtime) return cached;
    const raw = JSON.parse(readFileSync(POLICY_FILE, 'utf-8'));
    const norm = normalize(raw);
    cached = norm;
    lastMtime = stat.mtimeMs;
    log.info(`policy-reader: refreshed (${Object.entries(norm).filter(([, v]) => v != null && (Array.isArray(v) ? v.length : Object.keys(v ?? {}).length)).map(([k]) => k).join(', ') || 'all defaults'})`);
    return cached;
  } catch (e) {
    log.warn(`policy-reader: parse failed: ${e.message}; using last cached`);
    return cached;
  }
}

/**
 * Read one policy key. Lazy refresh on access.
 *
 * @param {keyof typeof DEFAULTS} key
 * @returns the current policy value (or the default if unset)
 */
export function getPolicy(key) {
  const pol = refresh();
  return pol[key];
}

/**
 * Get the whole policy object (read-only snapshot).
 */
export function getAllPolicy() {
  return { ...refresh() };
}

/**
 * Convenience: is a tile forbidden by policy?
 * Wraps `forbiddenTiles` with a Set lookup for hot paths.
 */
let forbiddenSetCache = null;
let forbiddenSetMtime = -1;
export function isForbiddenTile(x, y) {
  const pol = refresh();
  if (forbiddenSetMtime !== lastMtime) {
    forbiddenSetCache = new Set(pol.forbiddenTiles.map(([fx, fy]) => tileKey(fx, fy)));
    forbiddenSetMtime = lastMtime;
  }
  return forbiddenSetCache.has(tileKey(x, y));
}

/**
 * Convenience: per-tile delivery score multiplier.
 *   - Returns 0 if tile is in zeroRewardDeliveryTiles
 *   - Returns the explicit multiplier if in bonusDeliveryTiles
 *   - Returns 1.0 otherwise
 */
export function deliveryMultiplierAt(x, y) {
  const pol = refresh();
  const k = tileKey(x, y);
  if (pol.zeroRewardDeliveryTiles.includes(k)) return 0;
  return pol.bonusDeliveryTiles[k] ?? 1.0;
}
