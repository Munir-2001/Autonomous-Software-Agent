import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

// -----------------------------------------------------------------------------
// Lab 1 — Introduction to Agent Development
//
// This agent:
//   1. Connects to a running Deliveroo.js server (token or name via .env)
//   2. Walks a PREDEFINED PATH in a loop
//   3. Attempts pickup after every step
//   4. When carrying parcels, attempts putdown (succeeds only on delivery tiles)
//   5. Survives a blocking move by retrying, then giving up on that step
// -----------------------------------------------------------------------------

const HOST = process.env.HOST || 'http://localhost:8080';
const TOKEN = process.env.TOKEN;
const NAME = process.env.NAME || 'Lab1Agent';

const socket = DjsConnect(HOST, TOKEN, NAME);

// Predefined path: a small rectangular patrol. Edit to fit your map.
const PATH = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];

// How many times we retry a single move before moving on.
const MAX_MOVE_RETRIES = 5;
// Delay between retries (ms).
const RETRY_DELAY_MS = 300;

// ---- Agent state (kept in-memory, updated by event listeners) ---------------

const me = { id: null, name: null, x: 0, y: 0, score: 0 };
const carried = new Map();   // parcelId -> parcel
let mapInfo = { width: 0, height: 0, tiles: [] };
let started = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Event listeners --------------------------------------------------------

socket.on('you', (agent) => {
    me.id = agent.id;
    me.name = agent.name;
    me.x = agent.x;
    me.y = agent.y;
    me.score = agent.score;
});

socket.on('map', (width, height, tiles) => {
    mapInfo = { width, height, tiles };
    console.log(`Received map ${width}x${height} with ${tiles.length} tiles`);

    // Start the control loop once, after the first map event.
    if (!started) {
        started = true;
        controlLoop().catch((err) => console.error('Control loop crashed:', err));
    }
});

socket.on('sensing', (sensing) => {
    // Keep the carried set in sync: remove any parcel no longer on us.
    // (Sensing lists parcels currently visible; those carried by me have carriedBy === me.id.)
    if (!sensing || !Array.isArray(sensing.parcels)) return;
    const stillCarried = new Set(
        sensing.parcels.filter((p) => p.carriedBy === me.id).map((p) => p.id)
    );
    for (const id of [...carried.keys()]) {
        if (!stillCarried.has(id)) carried.delete(id);
    }
});

// ---- Helpers ---------------------------------------------------------------

function tileAt(x, y) {
    return mapInfo.tiles.find((t) => t.x === x && t.y === y);
}

function isDeliveryHere() {
    const t = tileAt(me.x, me.y);
    return t && t.type === '2';
}

/**
 * Try to move; retry a few times when the server rejects the action
 * (e.g. another agent stands on the target tile).
 * Returns the new {x,y} on success, or null if we gave up.
 */
async function resilientMove(direction) {
    for (let i = 0; i < MAX_MOVE_RETRIES; i++) {
        const result = await socket.emitMove(direction);
        if (result) {
            me.x = result.x;
            me.y = result.y;
            return result;
        }
        console.log(`Move ${direction} failed, retry ${i + 1}/${MAX_MOVE_RETRIES}...`);
        await sleep(RETRY_DELAY_MS);
    }
    console.log(`Giving up on move ${direction} at (${me.x},${me.y})`);
    return null;
}

async function tryPickup() {
    const picked = await socket.emitPickup();
    if (picked && picked.length > 0) {
        for (const p of picked) carried.set(p.id, p);
        console.log(`Picked up ${picked.length} parcel(s); carrying ${carried.size}`);
    }
    return picked;
}

async function tryDeliver() {
    if (carried.size === 0) return [];
    if (!isDeliveryHere()) return [];
    const dropped = await socket.emitPutdown();
    if (dropped && dropped.length > 0) {
        for (const p of dropped) carried.delete(p.id);
        console.log(`Delivered ${dropped.length} parcel(s) at (${me.x},${me.y})`);
    }
    return dropped;
}

// ---- Main control loop ------------------------------------------------------

async function controlLoop() {
    console.log(`Starting agent ${me.name || ''} at (${me.x},${me.y})`);

    // Opportunistic pickup at the spawn tile before moving.
    await tryPickup();
    await tryDeliver();

    while (true) {
        for (const direction of PATH) {
            await resilientMove(direction);
            await tryPickup();
            await tryDeliver();
        }
    }
}

// Graceful shutdown on Ctrl+C.
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    socket.disconnect();
    process.exit(0);
});
