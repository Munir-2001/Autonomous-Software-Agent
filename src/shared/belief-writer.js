// Belief-snapshot writer for the BDI ↔ LLM bridge.
//
// Every BDI control cycle, we serialise a SUBSET of the BDI's
// beliefs into `state/bdi-beliefs.json`. The LLM agent's tools read
// this file on demand to answer questions like "what parcels are
// nearby?" without us re-implementing sensing on the LLM side.
//
// Why a file (not a socket or in-memory bus)?
//   • The two agents are independent processes (each has its own
//     Deliveroo token). A shared filesystem location is the simplest
//     IPC primitive that works across processes.
//   • Reads are sub-millisecond on local disk; the LLM's ReAct loop
//     calls tools at most a few times per turn — no I/O bottleneck.
//   • Atomic via write-then-rename: the LLM never sees a partial file.
//
// Throttling: we coalesce writes via a 100ms debounce so even a
// noisy sensing loop doesn't hammer the disk. The latest call always
// wins (we always end up with the freshest snapshot).
//
// Failure mode: writes are best-effort. If the disk is full or the
// directory missing, we log a warning and continue — the BDI agent
// must not crash because the LLM bridge is broken.

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../utils/log.js';

// Resolve `<project_root>/state/bdi-beliefs.json` relative to this
// module's own location so the script works regardless of cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', '..', 'state');
const TARGET = join(STATE_DIR, 'bdi-beliefs.json');
const TMP    = join(STATE_DIR, '.bdi-beliefs.tmp.json');

const DEBOUNCE_MS = 100;
let pendingTimer = null;
let pendingSnapshot = null;
let dirEnsured = false;

async function ensureDir() {
  if (dirEnsured) return;
  try {
    await mkdir(STATE_DIR, { recursive: true });
    dirEnsured = true;
  } catch (e) {
    log.warn(`belief-writer: mkdir failed: ${e.message}`);
  }
}

async function flush() {
  pendingTimer = null;
  const snap = pendingSnapshot;
  pendingSnapshot = null;
  if (!snap) return;

  try {
    await ensureDir();
    // Atomic: write to .tmp then rename. POSIX rename is atomic, so
    // the LLM never reads a half-written file.
    await writeFile(TMP, JSON.stringify(snap), 'utf-8');
    await rename(TMP, TARGET);
  } catch (e) {
    log.warn(`belief-writer: write failed: ${e.message}`);
  }
}

/**
 * Build a snapshot of the BDI's current beliefs in a shape friendly
 * to LLM tool consumption. We deliberately flatten and rename for
 * readability — the LLM doesn't care about our internal Map types.
 *
 * @param {import('../beliefs.js').Beliefs} beliefs
 * @param {{ describe: () => string, type?: string, parcelId?: string|null, target?: object|null } | null} currentIntention
 * @returns {object} snapshot
 */
function buildSnapshot(beliefs, currentIntention) {
  const me = beliefs.myTile();

  const parcels = [];
  for (const p of beliefs.parcels.values()) {
    if (p.carriedBy && p.carriedBy !== beliefs.me.id) {
      // Held by an enemy — still useful for LLM to see, but mark it.
    }
    parcels.push({
      id: p.id,
      x: p.x,
      y: p.y,
      reward: Math.round(p.reward),
      confidence: Number((p.confidence ?? 1).toFixed(3)),
      carriedBy: p.carriedBy ?? null,
    });
  }

  const agents = [];
  for (const a of beliefs.agents.values()) {
    agents.push({
      id: a.id,
      name: a.name,
      x: Math.round(a.x),
      y: Math.round(a.y),
      lastSeenTick: a.lastSeenTick,
      confidence: Number((a.confidence ?? 1).toFixed(3)),
    });
  }

  const carrying = [];
  for (const c of beliefs.carrying.values()) {
    carrying.push({ id: c.id, reward: Math.round(c.reward) });
  }

  return {
    tick: beliefs.tick,
    writtenAt: Date.now(),
    me: {
      id: beliefs.me.id,
      name: beliefs.me.name,
      x: me.x,
      y: me.y,
      score: beliefs.me.score,
      penalty: beliefs.me.penalty,
      carrying,
      carriedCount: beliefs.carriedCount(),
    },
    map: beliefs.map
      ? {
          width: beliefs.map.width,
          height: beliefs.map.height,
          deliveryTiles: beliefs.map.deliveryTiles,
          spawningTiles: beliefs.map.spawningTiles,
        }
      : null,
    parcels,
    agents,
    currentIntention: currentIntention
      ? {
          type: currentIntention.type,
          parcelId: currentIntention.parcelId ?? null,
          target: currentIntention.target ?? currentIntention.deliveryTile ?? null,
          description: typeof currentIntention.describe === 'function'
            ? currentIntention.describe()
            : null,
        }
      : null,
  };
}

/**
 * Public entry point. Call from the BDI control loop each cycle.
 * Coalesces calls via debounce so a noisy loop doesn't thrash the disk.
 *
 * @param {import('../beliefs.js').Beliefs} beliefs
 * @param {object | null} currentIntention
 */
export function publishBeliefs(beliefs, currentIntention) {
  pendingSnapshot = buildSnapshot(beliefs, currentIntention);
  if (pendingTimer) return;
  pendingTimer = setTimeout(flush, DEBOUNCE_MS);
}
