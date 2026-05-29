// Random opponent.
//
// Strategy: walk in a random direction every tick. Pick up anything we
// happen to step on. Drop on delivery tiles (free score for us).
//
// Purpose: noise floor / sanity check. Our BDI agent should crush this
// since the random walker won't even target spawn tiles.

import { connectAndState, myTile, isWalkable, sleep } from './shared/connect.js';

const HOST = process.env.HOST || 'http://localhost:8080';
const NAME = process.env.NAME || 'Random';
const TOKEN = process.env.TOKEN;

const { socket, state } = connectAndState({ host: HOST, name: NAME, token: TOKEN });

let running = true;
process.on('SIGINT', () => { running = false; try { socket.disconnect(); } catch {} process.exit(0); });

const DIRS = ['up', 'right', 'down', 'left'];

async function controlLoop() {
  while (!state.ready && running) await sleep(50);
  if (!running) return;
  console.log(`[${NAME}] starting at (${state.me.x},${state.me.y})`);

  while (running) {
    const me = myTile(state);

    // Reflex: drop on delivery if carrying.
    if (state.me.carrying.size > 0
        && state.map.deliveryTiles.some(t => t.x === me.x && t.y === me.y)) {
      const dropped = await socket.emitPutdown([...state.me.carrying.keys()]);
      if (Array.isArray(dropped) && dropped.length > 0) {
        for (const d of dropped) state.me.carrying.delete(d.id);
      }
      continue;
    }

    // Reflex: pickup if on a parcel.
    const onParcel = [...state.parcels.values()].find(
      p => p.x === me.x && p.y === me.y && !p.carriedBy
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

    // Random walkable direction.
    const candidates = DIRS.map((d) => {
      let nx = me.x, ny = me.y;
      if (d === 'up') ny += 1;
      else if (d === 'down') ny -= 1;
      else if (d === 'right') nx += 1;
      else if (d === 'left') nx -= 1;
      return { d, nx, ny, ok: isWalkable(state, nx, ny) };
    }).filter(c => c.ok);

    if (candidates.length === 0) {
      await sleep(100);
      continue;
    }
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    await socket.emitMove(choice.d);
  }
}

socket.on('connect', () => {
  controlLoop().catch((e) => console.error(`[${NAME}] crashed:`, e));
});
