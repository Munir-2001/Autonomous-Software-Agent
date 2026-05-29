// Blocker opponent.
//
// Strategy: pick a delivery tile (configurable via TARGET env or random
// choice) and walk there. Once arrived, sit on it forever — denying
// that delivery point to any agent that wants to use it.
//
// Purpose: tests our BDI agent's congestion-aware delivery selection
// (`bestDelivery` should switch to the unblocked tile) AND its panic-
// mode waypoint escape if both deliveries get blocked.

import { connectAndState, myTile, sleep } from './shared/connect.js';
import { bfs } from './shared/grid.js';

const HOST = process.env.HOST || 'http://localhost:8080';
const NAME = process.env.NAME || 'Blocker';
const TOKEN = process.env.TOKEN;
// Which delivery tile to camp on. Format "X,Y" via TARGET env, else random.
const TARGET_ENV = process.env.TARGET;

const { socket, state } = connectAndState({ host: HOST, name: NAME, token: TOKEN });

let running = true;
let target = null;
process.on('SIGINT', () => { running = false; try { socket.disconnect(); } catch {} process.exit(0); });

function pickTarget() {
  if (TARGET_ENV) {
    const [x, y] = TARGET_ENV.split(',').map(Number);
    return { x, y };
  }
  const dels = state.map.deliveryTiles;
  if (!dels || dels.length === 0) return null;
  return dels[Math.floor(Math.random() * dels.length)];
}

async function controlLoop() {
  while (!state.ready && running) await sleep(50);
  if (!running) return;

  target = pickTarget();
  if (!target) {
    console.error(`[${NAME}] no delivery tile to camp on, exiting`);
    return;
  }
  console.log(`[${NAME}] camping on (${target.x},${target.y})`);

  while (running) {
    const me = myTile(state);

    if (me.x === target.x && me.y === target.y) {
      // Arrived. Just sit. Sleep a beat to avoid busy-spinning.
      await sleep(500);
      continue;
    }

    const route = bfs(state, me, target);
    if (!route || route.directions.length === 0) {
      await sleep(200);
      continue;
    }
    await socket.emitMove(route.directions[0]);
  }
}

socket.on('connect', () => {
  controlLoop().catch((e) => console.error(`[${NAME}] crashed:`, e));
});
