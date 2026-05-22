// Entry point — wires the BDI control loop:
//
//   loop:
//     1. brf(beliefs, percept)           — belief revision
//     2. options(beliefs, intentions)    — desire generation
//     3. filter(beliefs, options, I)     — intention selection (margin-based)
//     4. plan(beliefs, intention, Ac)    — pick or build a plan from library
//     5. execute(plan)                   — through reactive layer + executor
//
// Per slide-07 §16, module names mirror the BDI theory.

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { CONFIG } from './config.js';
import { log } from './utils/log.js';
import { Beliefs } from './beliefs.js';
import { generateOptions } from './desires.js';
import { IntentionManager } from './intentions.js';
import { selectPlan } from './plans/library.js';
import { reactiveDecide } from './reactive.js';
import { Executor } from './executor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = process.env.HOST || 'http://localhost:8080';
// Authenticate via TOKEN if one is set (gives a stable team identity);
// otherwise the SDK falls back to NAME and the server mints a fresh
// token on connect — fine for local play and matches the opponents'
// auth path.
const RAW_TOKEN = process.env.TOKEN;
const TOKEN = (RAW_TOKEN && RAW_TOKEN !== 'your-token-from-3D-client-here'
               && RAW_TOKEN.split('.').length === 3)   // looks like a JWT
              ? RAW_TOKEN
              : undefined;
const NAME = process.env.NAME || 'ASA-BDI';
const SMOKE = process.argv.includes('--smoke');

if (SMOKE) {
  log.info('Smoke mode: loaded all modules OK');
  process.exit(0);
}

if (!TOKEN && !NAME) {
  log.error('Either TOKEN or NAME must be set in .env');
  process.exit(1);
}

// ===== Connect =====
log.info(`Connecting to ${HOST} ${TOKEN ? 'with token' : `as ${NAME}`}…`);
const socket = DjsConnect(HOST, TOKEN, NAME);

const beliefs = new Beliefs();
const intentions = new IntentionManager();
const executor = new Executor(socket, beliefs);

let running = false;
let mapReady = false;
let meReady = false;

socket.on('connect',    () => log.info('socket connected'));
socket.on('disconnect', (reason) => log.warn(`socket disconnected: ${reason}`));

// Process-level safety nets: a stray unhandled rejection (e.g. an SDK
// ack timeout that escaped a try/catch we didn't think of) MUST NOT
// kill the agent. Log and keep going.
process.on('unhandledRejection', (reason) => {
  log.warn(`unhandled rejection: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  log.warn(`uncaught exception: ${err?.message || err}`);
});

socket.on('config', (cfg) => {
  beliefs.setConfig(cfg);
  maybeStart();
});

socket.on('map', (width, height, tiles) => {
  beliefs.setMap(width, height, tiles);
  mapReady = true;
  maybeStart();
});

// Penalty kick threshold on the server is < -1000. Warn early so the
// user can see when invalid moves / mutex conflicts are accumulating.
let lastPenaltyWarn = 0;
socket.on('you', (agent) => {
  beliefs.setMe(agent);
  if (typeof agent.penalty === 'number' && agent.penalty <= -200
      && agent.penalty < lastPenaltyWarn - 50) {
    log.warn(`⚠ penalty=${agent.penalty} (server kicks at -1000)`);
    lastPenaltyWarn = agent.penalty;
  }
  meReady = true;
  maybeStart();
});

socket.on('sensing', (sensing) => {
  if (!sensing) return;
  beliefs.brf(sensing);
});

function maybeStart() {
  if (running || !mapReady || !meReady) return;
  running = true;
  log.info(`Agent ${beliefs.me.name} (id=${beliefs.me.id}) starting at (${beliefs.me.x},${beliefs.me.y})`);
  // Resilient loop: a single unexpected error (network blip, SDK ack
  // timeout, transient parse error) shouldn't kill the agent. Log,
  // wait, and restart the loop. Only fatal-exit if restarts cascade.
  let restartCount = 0;
  const startLoop = () => {
    controlLoop().catch((err) => {
      restartCount += 1;
      log.error(`Control loop error (restart ${restartCount}): ${err?.message || err}`);
      if (restartCount > 20) {
        log.error('Too many control-loop restarts — exiting.');
        process.exit(1);
      }
      setTimeout(startLoop, 250);
    });
  };
  startLoop();
}

// ===== Control loop =====
async function controlLoop() {
  // Idle delay between deliberation cycles when nothing is happening.
  const IDLE_TICK_MS = 50;

  // Stuck-detector state: track our recent positions across cycles. If
  // we haven't moved while the intention is active, force a sidestep to
  // break out of any deadlock the planner can't solve on its own.
  let stuckCounter = 0;
  let consecutiveStuckEvents = 0;
  let lastPos = { x: -1, y: -1 };
  const STUCK_THRESHOLD = 6;        // cycles of no movement before action
  const PANIC_THRESHOLD = 3;        // consecutive stuck events → clear blocks
  const STUCK_WAIT_MS = 200;        // patience after stuck — let world change

  // No-progress detector: separate from stuck-counter. Catches the case
  // where the agent moves (e.g. 1 detour tile then 1 tile back) but
  // makes no net progress toward its goal. Distance-to-target should
  // decrease over time; if it hasn't dropped in NO_PROGRESS_THRESHOLD
  // cycles while delivering, we're flip-flopping and need to escape.
  let lastBestDist = Infinity;
  let lastBestDistCycle = 0;
  let cycleNum = 0;
  const NO_PROGRESS_THRESHOLD = 6;   // cycles without distance improvement
                                     // (lowered for faster delivery escape)

  while (running) {
    const cycleStart = Date.now();

    // Pre-cycle opportunistic pickup: if we're already standing on a
    // visible parcel (e.g. one just spawned under us, or we drifted onto
    // it via a sidestep, or we just delivered and a new parcel landed),
    // grab it immediately before any deliberation. Cheapest possible
    // pickup — costs one emit and zero moves.
    {
      const here = beliefs.myTile();
      const parcelHere = parcelAtTile(beliefs, here.x, here.y);
      if (parcelHere) {
        log.info(`◉ standing on parcel ${parcelHere.id} (R=${parcelHere.reward}) — pickup first`);
        await executor.pickup();
      }
    }

    // Step 2: options (desires).
    const opts = generateOptions(beliefs);

    // Step 3: filter / intention revision.
    const intention = intentions.filter(beliefs, opts);

    if (!intention) {
      await sleep(IDLE_TICK_MS);
      continue;
    }

    // Stuck-detection — count cycles where our position hasn't moved.
    cycleNum += 1;
    const me = beliefs.myTile();
    if (me.x === lastPos.x && me.y === lastPos.y) {
      stuckCounter += 1;
    } else {
      stuckCounter = 0;
      consecutiveStuckEvents = 0;   // movement = we're unstuck
      lastPos = { x: me.x, y: me.y };
    }

    // No-progress detector: catches the flip-flop case where the agent
    // moves (1 detour tile, 1 tile back) but Manhattan distance to the
    // intention's target never improves. Distinct from the position-
    // based stuck check.
    let noProgressTrigger = false;
    const targetTile = intention.deliveryTile || intention.target;
    if (targetTile) {
      const dist = Math.abs(me.x - targetTile.x) + Math.abs(me.y - targetTile.y);
      if (dist < lastBestDist) {
        lastBestDist = dist;
        lastBestDistCycle = cycleNum;
      } else if (cycleNum - lastBestDistCycle >= NO_PROGRESS_THRESHOLD) {
        noProgressTrigger = true;
        // Reset so we don't trigger on every subsequent cycle.
        lastBestDist = dist;
        lastBestDistCycle = cycleNum;
      }
    } else {
      lastBestDist = Infinity;
      lastBestDistCycle = cycleNum;
    }

    if (stuckCounter >= STUCK_THRESHOLD || noProgressTrigger) {
      if (noProgressTrigger) {
        log.info(`◆ no progress toward (${targetTile.x},${targetTile.y}) for ${NO_PROGRESS_THRESHOLD} cycles — escalating`);
      }
      consecutiveStuckEvents += 1;

      // Panic mode: if we've been stuck for several consecutive events,
      // a stationary blocker is forcing us to retry the same dead route.
      // Force a directed exploration to a tile far away from the current
      // obstruction. After the agent reaches the waypoint, BFS re-plans
      // delivery from a totally different position — usually finding a
      // route the planner never considered before.
      if (consecutiveStuckEvents >= PANIC_THRESHOLD) {
        const cleared = beliefs.transientBlocked.size;
        beliefs.transientBlocked.clear();
        beliefs.blockMarkCount.clear();
        beliefs.blockMarkLastTick.clear();
        const waypoint = pickEscapeWaypoint(beliefs);
        if (waypoint) {
          beliefs.exploreOverride = waypoint;
          log.warn(`!!! PANIC stuck ${consecutiveStuckEvents}× — cleared ${cleared} blocks; forcing explore to (${waypoint.x},${waypoint.y}) to find new approach`);
        } else {
          log.warn(`!!! PANIC stuck ${consecutiveStuckEvents}× — cleared ${cleared} blocks (no waypoint candidate)`);
        }
        consecutiveStuckEvents = 0;
      } else {
        log.info(`↪ stuck for ${stuckCounter} cycles (event ${consecutiveStuckEvents}/${PANIC_THRESHOLD})`);
      }

      // Drop the current intention so the next cycle re-deliberates from
      // scratch. Don't blacklist the target — we want to keep trying
      // the same goal, just via a different route.
      intentions.drop('stuck — re-deliberating');
      stuckCounter = 0;

      // Small perturbation (sidestep) + patience window so the world has
      // a chance to change before we plan again.
      const sidestep = await tryForcedSidestep(beliefs, executor);
      if (sidestep) log.info(`↪ sidestep ${sidestep}`);
      await sleep(STUCK_WAIT_MS);
      continue;
    }

    // Step 4: plan selection from library. Async because PDDL may run
    // an HTTP solver call here on intention activation (slide-9 spec).
    const plan = await selectPlan(beliefs, intention);
    if (!plan) {
      intentions.markFailed('no plan available');
      await sleep(IDLE_TICK_MS);
      continue;
    }

    // Step 5: execute plan body, but with re-deliberation hooks between steps.
    let stepOk = true;
    for (let i = 0; i < plan.body.length; i++) {
      // Per-step budget — slide-02 §2 calculative-rationality: don't deliberate too long.
      const elapsed = Date.now() - cycleStart;
      if (elapsed > CONFIG.DELIBERATION_BUDGET_MS && i > 0) break; // re-deliberate

      const step = plan.body[i];
      const suggested = stepToAction(step);
      const decided = reactiveDecide(beliefs, suggested);
      const result = await executor.perform(decided);

      if (decided.action === 'wait') {
        // Reflex told us to wait — break out and re-deliberate.
        stepOk = false;
        break;
      }
      if (!result.ok && !result.noop && !result.waited) {
        stepOk = false;
        break;
      }

      // Opportunistic pickup: after every successful move, if there's a
      // visible parcel on our new tile, grab it before continuing. This
      // lets the agent collect parcels along the delivery path "for free"
      // — no re-planning, just one extra emit. Maximizes chain pickups.
      if (decided.action === 'move' && result.ok) {
        const here = beliefs.myTile();
        const parcelHere = parcelAtTile(beliefs, here.x, here.y);
        if (parcelHere) {
          log.info(`◉ opportunistic pickup of ${parcelHere.id} (R=${parcelHere.reward}) en route`);
          await executor.pickup();
        }
      }

      // After every executed step, peek at re-deliberation triggers:
      // if the active intention is no longer the top-scored option, abort
      // and re-deliberate.
      if (shouldReconsider(intention, beliefs)) {
        log.debug('Reconsidering intention mid-plan');
        break;
      }
    }

    // Mark intention status.
    // A failed plan step (transient block, enemy in the way) is NOT an
    // intention failure — it's a replan trigger. The next cycle will
    // call selectPlan again and the BFS will route around the now-marked
    // transient blocks. Only count as intention failure if many cycles
    // in a row can't even progress.
    if (planAchievesGoal(plan, beliefs)) {
      intentions.markSucceeded();
    } else if (!stepOk) {
      intention.consecutiveStepFailures = (intention.consecutiveStepFailures || 0) + 1;
      if (intention.consecutiveStepFailures >= 5) {
        intentions.markFailed('persistent plan step failures');
        // Reset so subsequent cycles don't immediately re-trigger.
        intention.consecutiveStepFailures = 0;
      }
    } else {
      // Made progress this cycle — reset the failure counter.
      intention.consecutiveStepFailures = 0;
    }

    // Tiny yield so we don't peg the CPU.
    await sleep(5);
  }
}

// Find a visible, uncarried parcel sitting on the given tile (if any).
// Used by the opportunistic-pickup hook so the agent grabs anything it
// happens to step on, even mid-delivery.
function parcelAtTile(beliefs, x, y) {
  for (const p of beliefs.parcels.values()) {
    if (p.x !== x || p.y !== y) continue;
    if (p.carriedBy) continue;            // someone else holds it
    if (beliefs.carrying.has(p.id)) continue;
    if (p.reward <= 0) continue;
    return p;
  }
  return null;
}

// Step → executor action mapping.
function stepToAction(step) {
  switch (step.type) {
    case 'move':    return { action: 'move', direction: step.direction };
    case 'pickup':  return { action: 'pickup' };
    case 'putdown': return { action: 'putdown' };
    default:        return null;
  }
}

// Did the plan/library entry's `goal` predicate hold after execution?
function planAchievesGoal(plan, beliefs) {
  // We re-import the library entry by name. (Cheap, avoids circularity.)
  // For v1: pickup achieved iff parcel is now in carrying; deliver iff carrying empty.
  const it = plan.intention;
  if (it.type === 'pickup') return beliefs.carrying.has(it.parcelId);
  if (it.type === 'deliver') return beliefs.carriedCount() === 0;
  return false;
}

/**
 * Pick a waypoint tile FAR from the agent's current position AND far
 * from current enemies, so the agent can re-approach delivery from a
 * fresh angle. Used in panic mode when persistent stuck happens.
 *
 * Score = (distance from us) × 2 + (sum distances from enemies) × 0.5.
 * Heavier weight on distance-from-us so we actually go somewhere
 * meaningful, not just one tile from a closer enemy.
 */
function pickEscapeWaypoint(beliefs) {
  if (!beliefs.map) return null;
  const me = beliefs.myTile();
  const enemies = [...beliefs.agents.values()];
  let best = null;
  let bestScore = -Infinity;
  for (const tk of beliefs.map.walkable) {
    const [x, y] = tk.split('|').map(Number);
    const dMe = Math.abs(x - me.x) + Math.abs(y - me.y);
    if (dMe < 4) continue;        // too close to be useful
    let dEnemies = 0;
    for (const e of enemies) {
      dEnemies += Math.abs(x - Math.round(e.x)) + Math.abs(y - Math.round(e.y));
    }
    const score = dMe * 2 + dEnemies * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

/**
 * Last-resort stuck-breaker. When the agent has been stationary for many
 * cycles despite an active intention, the planner clearly can't find a
 * way through. Move to ANY safe adjacent tile (preferring tiles in the
 * direction roughly toward the current target) to perturb the deadlock —
 * the next BFS will plan from a fresh position and may discover a route
 * that wasn't visible from the stuck spot.
 */
async function tryForcedSidestep(beliefs, executor) {
  const me = beliefs.myTile();
  const occ = beliefs.occupiedByOthers();
  const candidates = [];
  for (const direction of ['up', 'right', 'down', 'left']) {
    let nx = me.x, ny = me.y;
    if (direction === 'up') ny += 1;
    else if (direction === 'down') ny -= 1;
    else if (direction === 'right') nx += 1;
    else if (direction === 'left') nx -= 1;
    if (!beliefs.isWalkable(nx, ny)) continue;
    if (occ.has(`${nx}|${ny}`)) continue;
    candidates.push({ direction, nx, ny });
  }
  if (candidates.length === 0) return null;
  // Pick a deterministic-ish candidate (first in order) to avoid jitter.
  const choice = candidates[0];
  const result = await executor.move(choice.direction);
  return result.ok ? choice.direction : null;
}

// Meta-level reconsideration trigger (slide-03 §7).
// We reconsider only when something materially changed.
function shouldReconsider(intention, beliefs) {
  if (!intention) return true;

  if (intention.type === 'pickup') {
    const p = beliefs.parcels.get(intention.parcelId);
    if (!p) return true;                                  // parcel disappeared
    if (p.carriedBy && p.carriedBy !== beliefs.me.id) return true;
  }
  if (intention.type === 'deliver') {
    if (beliefs.carriedCount() === 0) return true;
  }
  return false;
}

// ===== Graceful shutdown =====
process.on('SIGINT', () => {
  log.info('Shutting down…');
  running = false;
  try { socket.disconnect(); } catch {}
  process.exit(0);
});
