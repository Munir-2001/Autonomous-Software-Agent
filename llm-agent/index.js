// Entry point for the LLM agent (Challenge 2).
//
// Architecture:
//   - Connects to Deliveroo with its OWN token (LLM_AGENT_TOKEN).
//   - Tracks self-state via socket.onYou (used by the get_my_position tool).
//   - Listens for incoming chat messages via socket.onMsg.
//   - Every chat message is fed to the LLM agent's ReAct loop, which
//     can interpret it as a special mission and act using the tools.
//
// This first version does NOT yet:
//   - Coordinate with the BDI agent (the bridge is a TODO)
//   - Classify missions as accept/reject (trap detection is a TODO)
//   - Play standard parcel-collection autonomously (still TODO)
//
// For round-2 we start with chat-driven Level-1 missions. Level 2/3
// land in follow-up commits.

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { runAgentTurn } from './react-loop.js';
import { buildTools } from './tools.js';
import { LLM_CONFIG } from './llm-client.js';
import { shouldProcess, describeFilter } from './sender-filter.js';

// ----- Connection config -----
const HOST  = process.env.HOST  || 'https://deliveroojs.bears.disi.unitn.it/';
const TOKEN = process.env.LLM_AGENT_TOKEN;
const NAME  = process.env.LLM_AGENT_NAME || 'MI6-LLM';
const SMOKE = process.argv.includes('--smoke');

if (SMOKE) {
  console.log(`[llm-agent] smoke: modules loaded ok (model=${LLM_CONFIG.MODEL})`);
  process.exit(0);
}

if (!TOKEN) {
  console.error('FATAL: LLM_AGENT_TOKEN missing from .env (mint a separate token for the LLM agent)');
  process.exit(1);
}

// ----- Connect -----
console.log(`[llm-agent] connecting to ${HOST} as ${NAME}…`);
const socket = DjsConnect(HOST, TOKEN, NAME);

// ----- Self-state tracking -----
const me = { id: null, name: null, x: null, y: null, score: 0 };
socket.onYou((you) => {
  me.id = you.id;
  me.name = you.name;
  me.x = you.x;
  me.y = you.y;
  me.score = you.score ?? me.score;
});

socket.onConnect(() => console.log('[llm-agent] socket connected'));
socket.onDisconnect((reason) => console.warn(`[llm-agent] disconnected: ${reason}`));

// ----- Tools + memory -----
const TOOLS = buildTools(socket, me);
// Long-lived visible memory: starts with a placeholder system msg so
// runAgentTurn's `messages.slice(1)` produces an empty history first time.
const messages = [{ role: 'system', content: '__placeholder__' }];

// ----- Chat listener (the special-mission delivery channel) -----
//
// Signature: (id, name, msg, reply?) => void
//   id    — sender agent id
//   name  — sender agent name
//   msg   — message body (string OR object — we handle both)
//   reply — callback to send reply (only present if sender used emitAsk)
//
// We feed the message text straight into runAgentTurn. If the sender
// used emitAsk, we call `reply` with the final answer so they get
// our response back synchronously.
// Echo guard: remember a few recent outgoing message bodies so we
// don't process them as new instructions if the server echoes them
// back. Keyed by exact text; 30-second TTL is plenty.
const recentOutgoing = new Map();   // text -> timestamp
function rememberOutgoing(text) {
  recentOutgoing.set(text, Date.now());
  // Garbage-collect anything older than 30s
  const cutoff = Date.now() - 30_000;
  for (const [t, ts] of recentOutgoing) if (ts < cutoff) recentOutgoing.delete(t);
}
function isOwnEcho(text) {
  return recentOutgoing.has(text);
}

socket.onMsg(async (id, name, msg, reply) => {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);

  // Echo guard: skip messages that look like our own recent outputs.
  if (isOwnEcho(text)) {
    console.log(`[llm-agent] ignoring echo of our own message`);
    return;
  }

  // Sender whitelist + rate limit.
  // In a 25-team competition the shout channel is full of spam from
  // competitors. We only process messages from:
  //   - the mission-agent (id set at pre-test)
  //   - our own BDI agent
  //   - our own LLM-agent self-id (for testing via 3D client)
  // Plus a 2s-per-sender rate limit.
  const gate = shouldProcess(id, name, me.id);
  if (!gate.ok) {
    console.log(`[llm-agent] dropped msg: ${gate.reason}`);
    return;
  }

  // Include sender context so the LLM knows whom to reply to when a
  // mission says "tell the sender X" or similar.
  const enriched =
    `Message from ${name} (${id}):\n${text}`;

  console.log(`\n=== INCOMING from ${name} (${id}) ===\n${text}\n`);

  try {
    const answer = await runAgentTurn(enriched, messages, TOOLS);
    console.log(`=== FINAL ANSWER ===\n${answer}\n`);

    // Two delivery paths:
    //   1. If the sender used emitAsk, they're awaiting a reply callback.
    //   2. Otherwise emit say so the sender sees it in their chat.
    if (typeof reply === 'function') {
      try { reply(answer); } catch (e) { console.warn(`reply() threw: ${e.message}`); }
    } else {
      try {
        rememberOutgoing(answer);
        await socket.emitSay(id, answer);
      } catch (e) {
        console.warn(`emitSay back to ${id} failed: ${e?.message || e}`);
      }
    }
  } catch (e) {
    console.error(`[llm-agent] turn failed: ${e?.message || e}`);
  }
});

// ----- Process-level safety nets (mirroring the BDI agent) -----
process.on('unhandledRejection', (reason) => {
  console.warn(`[llm-agent] unhandled rejection: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  console.warn(`[llm-agent] uncaught exception: ${err?.message || err}`);
});
process.on('SIGINT', () => {
  console.log('[llm-agent] shutting down…');
  try { socket.disconnect(); } catch {}
  process.exit(0);
});

console.log('[llm-agent] ready — listening for chat messages');
console.log(`[llm-agent] sender filter: ${JSON.stringify(describeFilter())}`);
