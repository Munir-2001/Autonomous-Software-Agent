// Policy writer — LLM side of the LLM → BDI reverse bridge.
//
// The LLM calls `set_policy(key, value)` whenever it interprets a
// Level-2 special mission as needing a BDI strategy change. This
// module owns the persistence: read the current policy file, merge
// in the change, write atomically.
//
// Atomic via write-then-rename (same pattern as belief-writer.js).
// Concurrent set_policy calls from the LLM agent are serialised in
// JS's single-threaded event loop, so no locking is needed.
//
// Schema must match src/shared/policy-reader.js — keep them in sync.
// Validation happens here (refuse to write garbage) AND on read
// (defensive — if a future writer breaks the contract, the BDI
// still falls back to defaults).

import { existsSync, readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', 'state');
const TARGET = join(STATE_DIR, 'llm-policy.json');
const TMP    = join(STATE_DIR, '.llm-policy.tmp.json');

// Allowlist of policy keys and per-key validation. Keep this aligned
// with the schema in src/shared/policy-reader.js.
const VALIDATORS = {
  requiredStackSize: (v) =>
    Number.isInteger(v) && v > 0 && v <= 50
      ? { ok: true, value: v }
      : { ok: false, error: 'requiredStackSize must be a positive integer ≤ 50' },

  forbiddenTiles: (v) => {
    if (!Array.isArray(v)) return { ok: false, error: 'forbiddenTiles must be an array of [x,y]' };
    const clean = [];
    for (const t of v) {
      if (!Array.isArray(t) || t.length !== 2 || !Number.isFinite(t[0]) || !Number.isFinite(t[1])) {
        return { ok: false, error: `invalid tile entry ${JSON.stringify(t)} — must be [x,y]` };
      }
      clean.push([Math.round(t[0]), Math.round(t[1])]);
    }
    return { ok: true, value: clean };
  },

  bonusDeliveryTiles: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, error: 'bonusDeliveryTiles must be an object like {"x|y": multiplier}' };
    }
    const clean = {};
    for (const [k, mult] of Object.entries(v)) {
      if (!/^-?\d+\|-?\d+$/.test(k)) return { ok: false, error: `invalid tile key ${k} — must be "x|y"` };
      const m = Number(mult);
      if (!Number.isFinite(m) || m <= 0) return { ok: false, error: `bad multiplier for ${k} — must be positive number` };
      clean[k] = m;
    }
    return { ok: true, value: clean };
  },

  zeroRewardDeliveryTiles: (v) => {
    if (!Array.isArray(v)) return { ok: false, error: 'zeroRewardDeliveryTiles must be an array of "x|y" strings' };
    const clean = [];
    for (const k of v) {
      if (typeof k !== 'string' || !/^-?\d+\|-?\d+$/.test(k)) {
        return { ok: false, error: `invalid tile key ${k} — must be "x|y"` };
      }
      clean.push(k);
    }
    return { ok: true, value: clean };
  },

  maxParcelRewardAtDelivery: (v) =>
    Number.isFinite(v) && v >= 0
      ? { ok: true, value: v }
      : { ok: false, error: 'maxParcelRewardAtDelivery must be a non-negative number' },

  rendezvousTarget: (v) => {
    if (v === null) return { ok: true, value: null };
    if (!v || typeof v !== 'object') return { ok: false, error: 'rendezvousTarget must be {x,y,deadline?} or null' };
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return { ok: false, error: 'rendezvousTarget needs numeric x,y' };
    return {
      ok: true,
      value: {
        x: Math.round(v.x),
        y: Math.round(v.y),
        deadline: Number.isFinite(v.deadline) ? v.deadline : null,
      },
    };
  },
};

const KEYS = Object.keys(VALIDATORS);

let ensuredDir = false;
async function ensureDir() {
  if (ensuredDir) return;
  await mkdir(STATE_DIR, { recursive: true });
  ensuredDir = true;
}

function readCurrent() {
  if (!existsSync(TARGET)) return {};
  try {
    return JSON.parse(readFileSync(TARGET, 'utf-8'));
  } catch {
    // Corrupt file — start over rather than propagate the parse error.
    return {};
  }
}

async function writeAtomic(obj) {
  await ensureDir();
  await writeFile(TMP, JSON.stringify(obj, null, 2), 'utf-8');
  await rename(TMP, TARGET);
}

/**
 * Set one policy key. Validates the value; refuses bad input.
 *
 * @param {string} key
 * @param {any} value
 * @returns {Promise<{ ok: true, written: object } | { ok: false, error: string }>}
 */
export async function setPolicy(key, value) {
  if (!KEYS.includes(key)) {
    return { ok: false, error: `unknown policy key '${key}'. Valid: ${KEYS.join(', ')}` };
  }
  const v = VALIDATORS[key](value);
  if (!v.ok) return v;
  const current = readCurrent();
  current[key] = v.value;
  await writeAtomic(current);
  return { ok: true, written: { [key]: v.value } };
}

/**
 * Remove one policy key (or all if key === '*').
 */
export async function clearPolicy(key) {
  const current = readCurrent();
  if (key === '*' || key === 'all') {
    await writeAtomic({});
    return { ok: true, cleared: 'all' };
  }
  if (!KEYS.includes(key)) {
    return { ok: false, error: `unknown policy key '${key}'. Valid: ${KEYS.join(', ')}, or '*' to clear all` };
  }
  delete current[key];
  await writeAtomic(current);
  return { ok: true, cleared: key };
}

/**
 * Read the current policy snapshot (raw, as stored on disk).
 */
export function listPolicies() {
  return readCurrent();
}

export const POLICY_KEYS = KEYS;
