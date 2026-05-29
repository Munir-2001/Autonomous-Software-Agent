// Arena orchestrator — spawns the BDI agent and all selected opponents
// against the running Deliveroo.js server, in a single terminal.
//
// Pre-req: server already running at HOST (default http://localhost:8080).
//          We don't manage the server here — start it separately so it
//          can keep running across multiple matches.
//
// Usage:
//   node arena.js                                  # default: BDI + greedy + random + blocker
//   node arena.js --opponents=greedy,blocker       # custom opponent mix
//   node arena.js --no-bdi --opponents=greedy      # opponents only
//   node arena.js --opponents=greedy,greedy        # two greedies (each gets unique name)
//
// All children share stdout (color-prefixed). Ctrl+C kills all.

import { spawn, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { request as httpRequest, get as httpGet } from 'node:http';
import { request as httpsRequest } from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_DIR    = resolve(__dirname, 'project');
const OPPONENTS_DIR  = resolve(__dirname, 'opponents');
const SERVER_DIR     = resolve(__dirname, 'Deliveroo.js');
const VALID_OPPONENT = new Set(['greedy', 'random', 'blocker']);
const HOST = process.env.HOST || 'http://localhost:8080';
const PORT = (() => { try { return new URL(HOST).port || '8080'; } catch { return '8080'; } })();

// ---- server lifecycle helpers (used when --map=<name> is given) ----

// Best-effort kill anything LISTENING on PORT (the server). We deliberately
// scope to LISTEN sockets so we don't accidentally kill browser tabs,
// agent clients, or anything else that just has an outbound connection
// to that port.
function killStaleServer() {
  try {
    const out = execSync(`lsof -t -i :${PORT} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pids = out.split('\n').filter(Boolean);
    if (pids.length === 0) return;
    console.log(`Killing previous server PID(s) listening on port ${PORT}: ${pids.join(', ')}`);
    for (const pid of pids) {
      try { execSync(`kill -INT ${pid}`); } catch {}
    }
  } catch { /* nothing on the port */ }
}

// Best-effort kill any leftover BDI / opponent / arena agent processes
// from a previous run so we start clean.
function killStaleAgents() {
  const patterns = [
    'project/src/index.js',
    'opponents/src/greedy.js',
    'opponents/src/random.js',
    'opponents/src/blocker.js',
  ];
  for (const p of patterns) {
    try { execSync(`pkill -INT -f '${p}' 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  }
}

// Poll until the server's HTTP layer responds (or timeout).
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const req = httpGet(`${HOST}/api`, (r) => { r.resume(); res(true); });
      req.on('error', () => res(false));
      req.setTimeout(500, () => { req.destroy(); res(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function spawnServer(mapName) {
  const color = nextColor();
  const prefix = `${color}[server     ]${RESET}`;
  console.log(`${prefix} starting Deliveroo.js with GAME_NAME=${mapName}`);
  const child = spawn('npm', ['start'], {
    cwd: SERVER_DIR,
    env: { ...process.env, GAME_NAME: mapName },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ name: 'server', child });
  pipeWithPrefix(child, prefix);
}

// Fetch a fresh token from the Deliveroo.js server's `/api/tokens` endpoint
// for a given player name. The handshake middleware would auto-mint one
// from a `?name=` query param too, but pre-minting avoids any timing or
// query-string ambiguity and is the same path the 3D client uses.
async function fetchToken(host, name) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/tokens', host);
    url.searchParams.set('name', name);
    const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn(url, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`token fetch ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.token) resolve(json.token);
          else reject(new Error(json.message || 'no token in response'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('token fetch timeout')); });
    req.end();
  });
}

// ---- args parsing ----
const args = process.argv.slice(2);
function flagValue(name, def = null) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  if (args.includes(`--${name}`)) return true;
  return def;
}
const includeBdi   = !flagValue('no-bdi');
const opponentsArg = flagValue('opponents', 'greedy,random,blocker');
const opponentList = String(opponentsArg).split(',').map((s) => s.trim()).filter(Boolean);
const mapName      = flagValue('map', null);   // if set, manage server lifecycle

for (const name of opponentList) {
  if (!VALID_OPPONENT.has(name)) {
    console.error(`✗ unknown opponent: ${name} (valid: ${[...VALID_OPPONENT].join(', ')})`);
    process.exit(1);
  }
}
if (!includeBdi && opponentList.length === 0) {
  console.error('Nothing to spawn (--no-bdi and no opponents).');
  process.exit(1);
}

// ---- color prefixes ----
const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m', '\x1b[31m', '\x1b[96m'];
const RESET  = '\x1b[0m';
let colorIdx = 0;
const nextColor = () => COLORS[colorIdx++ % COLORS.length];

// ---- spawn helpers ----
const children = [];

function pipeWithPrefix(child, prefix) {
  const onLine = (stream) => (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const ln of lines) {
      if (ln.trim()) process[stream].write(`${prefix} ${ln}\n`);
    }
  };
  child.stdout.on('data', onLine('stdout'));
  child.stderr.on('data', onLine('stderr'));
  child.on('exit', (code) => console.log(`${prefix} exited (code=${code})`));
}

function spawnBdi() {
  if (!existsSync(resolve(PROJECT_DIR, 'src/index.js'))) {
    console.error(`✗ BDI agent not found at ${PROJECT_DIR}/src/index.js`);
    return;
  }
  if (!existsSync(resolve(PROJECT_DIR, '.env'))) {
    console.error(`✗ ${PROJECT_DIR}/.env missing — copy .env.example and set TOKEN`);
    return;
  }
  const color = nextColor();
  const prefix = `${color}[ASA-BDI    ]${RESET}`;
  console.log(`${prefix} spawning BDI agent`);
  const child = spawn(
    process.execPath,
    ['-r', 'dotenv/config', 'src/index.js'],
    { cwd: PROJECT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push({ name: 'BDI', child });
  pipeWithPrefix(child, prefix);
}

async function spawnOpponent(strategy, idx) {
  const file = resolve(OPPONENTS_DIR, 'src', `${strategy}.js`);
  if (!existsSync(file)) {
    console.error(`✗ opponent script missing: ${file}`);
    return;
  }
  const baseName = strategy[0].toUpperCase() + strategy.slice(1);
  const name = `${baseName}_${idx}`;
  const color = nextColor();
  const prefix = `${color}[${name.padEnd(11)}]${RESET}`;

  // Mint a token via /api/tokens. Same auth path the 3D client uses.
  let token;
  try {
    token = await fetchToken(HOST, name);
    console.log(`${prefix} got token ${token.slice(0, 10)}…`);
  } catch (err) {
    console.error(`${prefix} token fetch failed: ${err.message} — is the server running at ${HOST}?`);
    return;
  }

  console.log(`${prefix} spawning ${strategy} as ${name}`);
  const child = spawn(
    process.execPath,
    ['-r', 'dotenv/config', file],
    {
      cwd: OPPONENTS_DIR,
      env: { ...process.env, NAME: name, TOKEN: token, HOST },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push({ name, child });
  pipeWithPrefix(child, prefix);
}

// ---- spawn everything ----
async function main() {
  // If --map=<name> given, the arena owns the server lifecycle:
  //   1. Kill any prior server on the port.
  //   2. Kill any stale BDI / opponent processes from a previous run.
  //   3. Spawn the Deliveroo.js server with GAME_NAME=<name>.
  //   4. Wait for the HTTP layer to come up.
  // Otherwise we assume the user has the server running externally.
  if (mapName) {
    killStaleServer();
    killStaleAgents();
    await new Promise((r) => setTimeout(r, 500));
    spawnServer(mapName);
    console.log(`Waiting for server to be ready at ${HOST}...`);
    const ok = await waitForServer(20000);
    if (!ok) {
      console.error('✗ server failed to come up in 20s — aborting');
      shutdown();
      return;
    }
    console.log(`✓ server ready (map=${mapName})\n`);
  } else {
    console.log(`Arena starting. Server expected at ${HOST}\n`);
  }

  if (includeBdi) spawnBdi();
  // Spawn opponents sequentially (each first mints a token via REST).
  for (let i = 0; i < opponentList.length; i++) {
    await spawnOpponent(opponentList[i], i + 1);
  }
  console.log(`\n→ ${children.length} process(es) running. Ctrl+C to stop all.\n`);
}
main().catch((e) => {
  console.error('Arena failed to start:', e);
  process.exit(1);
});

// ---- shutdown ----
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down arena...');
  for (const { child } of children) {
    try { child.kill('SIGINT'); } catch {}
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
