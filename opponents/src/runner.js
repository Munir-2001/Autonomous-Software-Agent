// Runner: spawns multiple opponent processes in parallel against the
// local Deliveroo.js server. Each opponent gets its own NAME, prefixed
// stdout, and is cleaned up on Ctrl+C.
//
// Usage:
//   node src/runner.js                          # default mix
//   node src/runner.js greedy random blocker    # specify which opponents
//   node src/runner.js greedy:Greedy1 greedy:Greedy2 random
//
// Each arg is "<strategy>" or "<strategy>:<name>". Strategy must match a
// file in src/ (greedy, random, blocker).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STRATEGIES = ['greedy', 'random', 'blocker'];

const args = process.argv.slice(2);
const specs = args.length > 0
  ? args
  : ['greedy:Greedy', 'random:Random', 'blocker:Blocker'];   // default mix

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m', '\x1b[31m'];
const RESET = '\x1b[0m';

const children = [];

function spawnOpponent(spec, idx) {
  const [strategy, ...nameParts] = spec.split(':');
  const name = nameParts.join(':') || `${strategy[0].toUpperCase()}${strategy.slice(1)}_${idx}`;

  if (!STRATEGIES.includes(strategy)) {
    console.error(`✗ unknown strategy: ${strategy} (valid: ${STRATEGIES.join(', ')})`);
    return null;
  }

  const scriptPath = resolve(__dirname, `${strategy}.js`);
  const env = { ...process.env, NAME: name };
  const color = COLORS[idx % COLORS.length];
  const prefix = `${color}[${name.padEnd(12)}]${RESET}`;

  console.log(`${prefix} spawning ${strategy} as ${name}`);

  const child = spawn(process.execPath, ['-r', 'dotenv/config', scriptPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onLine = (stream) => (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const ln of lines) {
      if (ln.trim()) process[stream].write(`${prefix} ${ln}\n`);
    }
  };
  child.stdout.on('data', onLine('stdout'));
  child.stderr.on('data', onLine('stderr'));
  child.on('exit', (code) => console.log(`${prefix} exited (code=${code})`));

  return child;
}

specs.forEach((spec, i) => {
  const child = spawnOpponent(spec, i);
  if (child) children.push(child);
});

if (children.length === 0) {
  console.error('No opponents spawned. Exiting.');
  process.exit(1);
}

console.log(`\n→ ${children.length} opponent(s) running. Ctrl+C to stop all.\n`);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down opponents...');
  for (const c of children) {
    try { c.kill('SIGINT'); } catch {}
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
