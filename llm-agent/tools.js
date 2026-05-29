// Tool inventory for the LLM agent.
//
// Each tool returns a STRING — either a result message or an error
// message starting with "Error:". The string becomes the Observation
// in the next ReAct iteration. Tools never throw; they catch and
// stringify any error so the LLM gets a chance to recover.
//
// Patterns kept consistent with the course reference
// (lab8-LLMs/9_07C_DeliverooAgent-prompt-from-env_SOL.mjs):
//   - move() validates direction before emitting
//   - get_my_position guards against null state
//   - all socket emits are wrapped in try/catch (the SDK rejects on
//     1s ack timeout — we mustn't crash the loop)
//
// `me` is a reference to the live agent-state object owned by index.js
// (updated by socket.onYou). The tools read its current values each
// time they're invoked.
//
// World-awareness tools (get_nearby_parcels, get_visible_agents, etc.)
// piggyback on the BDI agent's beliefs via the bdi-bridge file.
// Slides Part-2 §9: "exchange beliefs about the environment that
// other cannot see." The LLM consumes BDI's richer sensing without
// us re-implementing it.

import { readBeliefs, freshness } from './bdi-bridge.js';
import { setPolicy, clearPolicy, listPolicies, POLICY_KEYS } from './policy-writer.js';

const DIRECTIONS = ['up', 'down', 'left', 'right'];

// Helper: cheap Manhattan distance for nearby-sorts.
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Build a tool registry bound to a given socket + me state.
 *
 * @param {object} socket  the DjsConnect socket
 * @param {{ id: string|null, name: string|null, x: number|null, y: number|null, score: number }} me
 * @returns {Record<string, (input: string) => Promise<string>>}
 */
export function buildTools(socket, me) {
  /* ----- calculate ----- */
  // Safer than the course's raw eval: only allow digits, basic ops,
  // parentheses, decimal points. Blocks any code injection from
  // mission text passed straight into the expression.
  function calculate(expression) {
    console.log('[tool] calculate', expression);
    const expr = String(expression).trim();
    if (!/^[\d\s+\-*/().,%]+$/.test(expr)) {
      return `Error: only arithmetic expressions allowed (digits, + - * / ( ) . %). Got: "${expression}"`;
    }
    try {
      // eslint-disable-next-line no-eval
      const result = eval(expr);
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        return `Error: expression did not evaluate to a finite number`;
      }
      return String(result);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  /* ----- get_my_position ----- */
  async function get_my_position(/* unused input */) {
    console.log('[tool] get_my_position');
    if (me.x === null || me.y === null) {
      return 'Error: agent position is not available yet (still connecting).';
    }
    return JSON.stringify({
      id: me.id,
      name: me.name,
      x: me.x,
      y: me.y,
      score: me.score,
    });
  }

  /* ----- move ----- */
  async function move(direction) {
    console.log('[tool] move', direction);
    const dir = String(direction).trim().toLowerCase();
    if (!DIRECTIONS.includes(dir)) {
      return `Error: invalid direction "${direction}". Valid: ${DIRECTIONS.join(', ')}.`;
    }
    try {
      const result = await socket.emitMove(dir);
      if (result) {
        return `Moved ${dir}. New position: ${JSON.stringify(result)}.`;
      }
      return `Error: server rejected move ${dir} (wall, occupied tile, or directional-tile rule).`;
    } catch (e) {
      return `Error: move ${dir} failed: ${e.message}`;
    }
  }

  /* ----- pickup ----- */
  async function pickup(/* unused input */) {
    console.log('[tool] pickup');
    try {
      const picked = await socket.emitPickup();
      if (Array.isArray(picked) && picked.length > 0) {
        const total = picked.reduce((s, p) => s + (p.reward ?? 0), 0);
        return `Picked up ${picked.length} parcel(s) (total reward ${total}): ${JSON.stringify(picked)}.`;
      }
      return 'No parcels on this tile to pick up.';
    } catch (e) {
      return `Error: pickup failed: ${e.message}`;
    }
  }

  /* ----- putdown ----- */
  async function putdown(/* unused input */) {
    console.log('[tool] putdown');
    try {
      const dropped = await socket.emitPutdown();
      if (Array.isArray(dropped) && dropped.length > 0) {
        const total = dropped.reduce((s, p) => s + (p.reward ?? 0), 0);
        return `Put down ${dropped.length} parcel(s) (delivered reward ${total}): ${JSON.stringify(dropped)}.`;
      }
      return 'Nothing to put down.';
    } catch (e) {
      return `Error: putdown failed: ${e.message}`;
    }
  }

  /* ----- say (chat: send a message to a specific agent) -----
   * Input format: "toAgentId | message text"
   * Used when a mission says "send the answer to the agent who sent
   * the prompt." */
  async function say(input) {
    console.log('[tool] say', input);
    const sep = String(input).indexOf('|');
    if (sep < 0) return 'Error: say expects input "toAgentId | message" — separate with a pipe.';
    const toId = input.slice(0, sep).trim();
    const text = input.slice(sep + 1).trim();
    if (!toId)  return 'Error: missing target agent id before the pipe.';
    if (!text)  return 'Error: missing message text after the pipe.';
    try {
      const status = await socket.emitSay(toId, text);
      return `Sent to ${toId}: ${status ?? 'ok'}.`;
    } catch (e) {
      return `Error: say failed: ${e.message}`;
    }
  }

  /* ----- shout (broadcast to everyone) -----
   * Use sparingly — in a crowded competition this spams every agent.
   * Most legitimate uses are answered better with `say`. */
  async function shout(input) {
    console.log('[tool] shout', input);
    const text = String(input).trim();
    if (!text) return 'Error: shout requires a non-empty message.';
    try {
      const status = await socket.emitShout(text);
      return `Broadcast: ${status ?? 'ok'}.`;
    } catch (e) {
      return `Error: shout failed: ${e.message}`;
    }
  }

  /* ----- ask (send + await reply, with timeout) -----
   * Input format: "toAgentId | message text" (same as say)
   * Returns the reply text. Times out after 5s if no reply. */
  async function ask(input) {
    console.log('[tool] ask', input);
    const sep = String(input).indexOf('|');
    if (sep < 0) return 'Error: ask expects input "toAgentId | message" — separate with a pipe.';
    const toId = input.slice(0, sep).trim();
    const text = input.slice(sep + 1).trim();
    if (!toId)  return 'Error: missing target agent id before the pipe.';
    if (!text)  return 'Error: missing message text after the pipe.';
    try {
      const reply = await Promise.race([
        socket.emitAsk(toId, text),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ask timeout 5s')), 5000)),
      ]);
      return `Reply from ${toId}: ${typeof reply === 'string' ? reply : JSON.stringify(reply)}`;
    } catch (e) {
      return `Error: ask failed: ${e.message}`;
    }
  }

  /* ============================================================
   * World-awareness tools (backed by BDI's beliefs file)
   * ============================================================
   *
   * These tools read state/bdi-beliefs.json produced by the BDI
   * agent. They're how the LLM gets sensing without re-implementing
   * it. If the BDI isn't running, the tools return a clear error
   * so the LLM can decide what to do.
   */

  function ensureBeliefs() {
    const snap = readBeliefs();
    if (!snap) {
      return { error: 'Error: BDI beliefs file is not available yet. Is the BDI agent running?' };
    }
    const f = freshness();
    if (f.stale) {
      return { error: `Error: BDI beliefs are stale (${f.ageMs}ms old). BDI may be disconnected.` };
    }
    return { snap };
  }

  /* ----- get_nearby_parcels ----- */
  async function get_nearby_parcels(/* input ignored */) {
    console.log('[tool] get_nearby_parcels');
    const { snap, error } = ensureBeliefs();
    if (error) return error;
    if (snap.parcels.length === 0) return 'No parcels currently visible.';
    // Sort by distance from me for the LLM's convenience.
    const here = me.x !== null && me.y !== null ? me : snap.me;
    const sorted = [...snap.parcels].sort((a, b) => manhattan(here, a) - manhattan(here, b));
    return JSON.stringify(sorted.map((p) => ({
      id: p.id, x: p.x, y: p.y, reward: p.reward,
      distance: manhattan(here, p),
      carriedBy: p.carriedBy,
    })));
  }

  /* ----- get_visible_agents ----- */
  async function get_visible_agents(/* input ignored */) {
    console.log('[tool] get_visible_agents');
    const { snap, error } = ensureBeliefs();
    if (error) return error;
    if (snap.agents.length === 0) return 'No other agents currently visible.';
    const here = me.x !== null && me.y !== null ? me : snap.me;
    const sorted = [...snap.agents].sort((a, b) => manhattan(here, a) - manhattan(here, b));
    return JSON.stringify(sorted.map((a) => ({
      id: a.id, name: a.name, x: a.x, y: a.y,
      distance: manhattan(here, a),
      lastSeenTick: a.lastSeenTick,
    })));
  }

  /* ----- get_delivery_tiles ----- */
  async function get_delivery_tiles(/* input ignored */) {
    console.log('[tool] get_delivery_tiles');
    const { snap, error } = ensureBeliefs();
    if (error) return error;
    const tiles = snap.map?.deliveryTiles ?? [];
    if (tiles.length === 0) return 'No delivery tiles known yet.';
    const here = me.x !== null && me.y !== null ? me : snap.me;
    const sorted = [...tiles].sort((a, b) => manhattan(here, a) - manhattan(here, b));
    return JSON.stringify(sorted.map((t) => ({ x: t.x, y: t.y, distance: manhattan(here, t) })));
  }

  /* ----- get_spawning_tiles ----- */
  async function get_spawning_tiles(/* input ignored */) {
    console.log('[tool] get_spawning_tiles');
    const { snap, error } = ensureBeliefs();
    if (error) return error;
    const tiles = snap.map?.spawningTiles ?? [];
    if (tiles.length === 0) return 'No spawning tiles known yet.';
    const here = me.x !== null && me.y !== null ? me : snap.me;
    const sorted = [...tiles].sort((a, b) => manhattan(here, a) - manhattan(here, b));
    return JSON.stringify(sorted.map((t) => ({ x: t.x, y: t.y, distance: manhattan(here, t) })));
  }

  /* ----- get_map_info ----- */
  async function get_map_info(/* input ignored */) {
    console.log('[tool] get_map_info');
    const { snap, error } = ensureBeliefs();
    if (error) return error;
    if (!snap.map) return 'Error: map not known yet.';
    return JSON.stringify({
      width: snap.map.width,
      height: snap.map.height,
      deliveryTileCount: snap.map.deliveryTiles?.length ?? 0,
      spawningTileCount: snap.map.spawningTiles?.length ?? 0,
    });
  }

  /* ----- get_bdi_state ----- *
   * Lets the LLM see what the BDI agent is currently doing — its
   * intention, what it's carrying, its position. Matches Part-2
   * §9: "beliefs about the intentions one agent is committed to". */
  async function get_bdi_state(/* input ignored */) {
    console.log('[tool] get_bdi_state');
    const { snap, error } = ensureBeliefs();
    if (error) return error;
    return JSON.stringify({
      bdiPosition: { x: snap.me.x, y: snap.me.y },
      bdiScore: snap.me.score,
      bdiCarrying: snap.me.carrying,
      bdiCurrentIntention: snap.currentIntention,
      snapshotTick: snap.tick,
    });
  }

  /* ============================================================
   * Policy override tools (LLM → BDI, for Level-2 missions)
   * ============================================================
   *
   * Persistent strategy changes the BDI obeys until cleared. Backed
   * by state/llm-policy.json — atomic writes, BDI reads each cycle.
   * See policy-writer.js for the full schema + validation.
   */

  /* ----- set_policy ----- *
   * Input format: "key | jsonValue"
   *   e.g. "requiredStackSize | 3"
   *        "forbiddenTiles | [[5,7],[5,8]]"
   *        "bonusDeliveryTiles | {\"3|4\": 5}"
   *        "zeroRewardDeliveryTiles | [\"7|2\"]"
   *        "maxParcelRewardAtDelivery | 10"
   * The pipe separates the key from the JSON-encoded value. */
  async function set_policy(input) {
    console.log('[tool] set_policy', input);
    const sep = String(input).indexOf('|');
    if (sep < 0) {
      return `Error: set_policy expects "key | jsonValue". Valid keys: ${POLICY_KEYS.join(', ')}`;
    }
    const key = input.slice(0, sep).trim();
    const valueStr = input.slice(sep + 1).trim();
    let value;
    try {
      value = JSON.parse(valueStr);
    } catch (e) {
      return `Error: value after the pipe must be valid JSON. Got "${valueStr}". Parse error: ${e.message}`;
    }
    const res = await setPolicy(key, value);
    if (!res.ok) return `Error: ${res.error}`;
    return `Set policy ${key} = ${JSON.stringify(res.written[key])}. BDI will apply on next cycle.`;
  }

  /* ----- clear_policy ----- *
   * Input: a policy key, or "*" / "all" to clear everything. */
  async function clear_policy(input) {
    console.log('[tool] clear_policy', input);
    const key = String(input).trim();
    const res = await clearPolicy(key);
    if (!res.ok) return `Error: ${res.error}`;
    return `Cleared policy: ${res.cleared}. BDI will apply on next cycle.`;
  }

  /* ----- list_policies ----- *
   * Returns the currently-active policy overrides as JSON. */
  async function list_policies(/* input ignored */) {
    console.log('[tool] list_policies');
    const pol = listPolicies();
    if (!pol || Object.keys(pol).length === 0) return 'No active policy overrides (BDI using defaults).';
    return JSON.stringify(pol);
  }

  return {
    // Local primitives
    calculate,
    get_my_position,
    move,
    pickup,
    putdown,
    // Chat / coordination
    say,
    shout,
    ask,
    // World awareness (via BDI bridge)
    get_nearby_parcels,
    get_visible_agents,
    get_delivery_tiles,
    get_spawning_tiles,
    get_map_info,
    get_bdi_state,
    // Policy overrides (Level-2 missions)
    set_policy,
    clear_policy,
    list_policies,
  };
}
