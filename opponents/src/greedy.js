// Greedy opponent.
//
// Strategy: always go for the highest-reward visible parcel. Once carrying,
// walk to the nearest delivery tile and drop. Repeat. No game theory, no
// chaining, no anticipation — pure "see parcel, grab parcel".
//
// Purpose: a simple, non-trivial baseline that approximates what an
// undergraduate would write in a first lab. Our BDI agent should
// consistently outperform it via competitor modeling and chaining.

import { connectAndState, myTile, sleep } from './shared/connect.js';
import { bfs, manhattan } from './shared/grid.js';

const HOST = process.env.HOST || 'http://localhost:8080';
const NAME = process.env.NAME || 'Greedy';
const TOKEN = process.env.TOKEN;

const { socket, state } = connectAndState({ host: HOST, name: NAME, token: TOKEN });

let running = true;
process.on('SIGINT', () => { running = false; try { socket.disconnect(); } catch {} process.exit(0); });

function nearestDelivery(state, from) {
  let best = null, bestD = Infinity;
  for (const t of state.map.deliveryTiles) {
    const d = manhattan(from, t);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function pickBestVisibleParcel(state, from) {
  let best = null, bestScore = -Infinity;
  for (const p of state.parcels.values()) {
    if (p.carriedBy && p.carriedBy !== state.me.id) continue;
    if (p.reward <= 0) continue;
    // Score = reward minus rough travel cost (Manhattan).
    const score = p.reward - manhattan(from, p);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

async function controlLoop() {
  while (!state.ready && running) await sleep(50);
  if (!running) return;
  console.log(`[${NAME}] starting at (${state.me.x},${state.me.y})`);

  while (running) {
    const me = myTile(state);

    // 1. On a delivery tile while carrying → drop.
    if (state.me.carrying.size > 0
        && state.map.deliveryTiles.some(t => t.x === me.x && t.y === me.y)) {
      const dropped = await socket.emitPutdown([...state.me.carrying.keys()]);
      if (Array.isArray(dropped) && dropped.length > 0) {
        for (const d of dropped) state.me.carrying.delete(d.id);
      }
      continue;
    }

    // 2. Standing on a parcel → pick up.
    const onParcel = [...state.parcels.values()].find(
      p => p.x === me.x && p.y === me.y && (!p.carriedBy || p.carriedBy === state.me.id)
    );
    if (onParcel) {
      const picked = await socket.emitPickup();
      if (Array.isArray(picked) && picked.length > 0) {
        for (const p of picked) {
          state.me.carrying.set(p.id, { id: p.id, reward: p.reward ?? 0 });
          state.parcels.delete(p.id);
        }
      }
      continue;
    }

    // 3. Decide target.
    let target;
    if (state.me.carrying.size > 0) {
      target = nearestDelivery(state, me);
    } else {
      const p = pickBestVisibleParcel(state, me);
      target = p ? { x: p.x, y: p.y } : null;
    }

    if (!target) {
      // No goal — random walk to discover parcels.
      const dirs = ['up', 'right', 'down', 'left'];
      const d = dirs[Math.floor(Math.random() * dirs.length)];
      await socket.emitMove(d);
      await sleep(80);
      continue;
    }

    const route = bfs(state, me, target);
    if (!route || route.directions.length === 0) {
      await sleep(100);
      continue;
    }

    const dir = route.directions[0];
    const result = await socket.emitMove(dir);
    if (!result) {
      // Move failed (someone in the way). Brief wait, retry next loop.
      await sleep(80);
    }
  }
}

socket.on('connect', () => {
  controlLoop().catch((e) => console.error(`[${NAME}] crashed:`, e));
});
