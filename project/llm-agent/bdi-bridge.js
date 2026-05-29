// BDI ↔ LLM bridge — read side.
//
// The BDI process writes `state/bdi-beliefs.json` every sensing
// tick (see src/shared/belief-writer.js). This module reads that
// file on demand so the LLM agent's tools can answer questions
// like "what parcels are nearby?" without re-implementing sensing.
//
// Slide-grounded rationale (Part-2 spec, slide 9):
//   "The two agents can communicate one another, exchanges beliefs
//    (e.g., beliefs about the environment that other cannot see or
//    beliefs about the intentions one agent is committed to) and
//    coordinate (e.g., the closest agent will commit to pickup a
//    new parcel)"
//
// File reads are sub-millisecond on local disk — fine for the LLM
// ReAct loop's tool-call cadence. If the file is missing (BDI not
// yet started) we return a structured error so the LLM can recover.
//
// Staleness: each read returns a `freshnessTicks` and `freshnessMs`
// so the LLM (or its tools) can decide whether the snapshot is
// recent enough to act on.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', 'state', 'bdi-beliefs.json');

let lastReadMtime = 0;
let cached = null;

/**
 * Read the latest BDI belief snapshot. Sync (file is local + tiny).
 * Caches based on mtime so repeated reads in the same tool turn don't
 * re-parse the same JSON.
 *
 * @returns {object|null} the snapshot, or null if not available yet
 */
export function readBeliefs() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const stat = statSync(STATE_FILE);
    const mtime = stat.mtimeMs;
    if (cached && mtime === lastReadMtime) return cached;
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    cached = parsed;
    lastReadMtime = mtime;
    return parsed;
  } catch (e) {
    // Race: file may be mid-rename. Return cached if we have one,
    // else null. (The writer uses atomic rename, but a partial parse
    // can still happen in extreme cases.)
    return cached;
  }
}

/**
 * How fresh is the latest snapshot? Tick-difference matters in-game;
 * wallclock matters for "is the BDI even alive?"
 */
export function freshness() {
  const snap = readBeliefs();
  if (!snap) return { stale: true, reason: 'no snapshot yet' };
  const ageMs = Date.now() - (snap.writtenAt ?? 0);
  return {
    stale: ageMs > 2000,
    ageMs,
    tick: snap.tick,
    reason: ageMs > 2000 ? `snapshot is ${ageMs}ms old` : 'fresh',
  };
}
