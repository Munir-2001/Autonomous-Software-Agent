// Shared SDK boilerplate for opponent agents.
//
// Each opponent imports `connectAndState(name)` and gets a (socket, state)
// pair where `state` is a minimal but normalized view of the world:
//   state.me        — { id, name, x, y, score, carrying: Map<id, parcel> }
//   state.map       — { width, height, walkable: Set<tk>, deliveryTiles, spawningTiles }
//   state.parcels   — Map<id, { id, x, y, reward, carriedBy }>
//   state.agents    — Map<id, { id, name, x, y, score }>
//
// Opponents shouldn't need to touch the SDK directly.

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

const tileKey = (x, y) => `${x}|${y}`;

export function connectAndState({ host, name, token }) {
  // Prefer an explicit token (the arena mints one via /api/tokens before
  // spawning each opponent — most reliable auth path). Fall back to a
  // name-only connection if no token provided.
  const socket = DjsConnect(host, token, name);

  const state = {
    me: { id: null, name: null, x: 0, y: 0, score: 0, carrying: new Map() },
    map: null,
    parcels: new Map(),
    agents: new Map(),
    ready: false,
  };

  socket.on('you', (agent) => {
    state.me.id = agent.id;
    state.me.name = agent.name;
    if (typeof agent.x === 'number') state.me.x = agent.x;
    if (typeof agent.y === 'number') state.me.y = agent.y;
    state.me.score = agent.score ?? state.me.score;
  });

  socket.on('map', (width, height, tiles) => {
    const walkable = new Set();
    const deliveryTiles = [];
    const spawningTiles = [];
    for (const t of tiles) {
      // Match the server: anything not type '0' (wall) is walkable.
      // Includes '5' / '5!' crate tiles, arrows, etc.
      if (t.type !== '0') {
        walkable.add(tileKey(t.x, t.y));
      }
      if (t.type === '2') deliveryTiles.push({ x: t.x, y: t.y });
      if (t.type === '1') spawningTiles.push({ x: t.x, y: t.y });
    }
    state.map = { width, height, walkable, deliveryTiles, spawningTiles };
    state.ready = true;
  });

  socket.on('sensing', (sensing) => {
    if (!sensing) return;

    // Parcels — refresh visible, drop ones we should no longer believe in.
    const seen = new Set();
    for (const p of (sensing.parcels || [])) {
      seen.add(p.id);
      // Carried-by-me parcels: track in carrying, not in parcels.
      if (p.carriedBy === state.me.id) {
        state.me.carrying.set(p.id, { id: p.id, reward: p.reward });
        state.parcels.delete(p.id);
        continue;
      }
      state.parcels.set(p.id, {
        id: p.id,
        x: Math.round(p.x),
        y: Math.round(p.y),
        reward: p.reward,
        carriedBy: p.carriedBy ?? null,
      });
    }
    // Drop carried entries that no sensing event reaffirmed (we delivered or lost them).
    for (const id of [...state.me.carrying.keys()]) {
      if (!seen.has(id)) state.me.carrying.delete(id);
    }

    // Agents — keep the simplest tracking.
    for (const a of (sensing.agents || [])) {
      if (a.id === state.me.id) continue;
      state.agents.set(a.id, {
        id: a.id,
        name: a.name,
        x: a.x,
        y: a.y,
        score: a.score,
      });
    }
  });

  return { socket, state };
}

export function myTile(state) {
  return { x: Math.round(state.me.x), y: Math.round(state.me.y) };
}

export function isWalkable(state, x, y) {
  return state.map?.walkable.has(tileKey(x, y)) ?? false;
}

export function isDeliveryTile(state, x, y) {
  return state.map?.deliveryTiles.some((t) => t.x === x && t.y === y) ?? false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
