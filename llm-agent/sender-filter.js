// Sender filter for incoming chat messages.
//
// In a 25-team competition, the shout channel is a firehose. We must
// process only messages from trusted senders:
//   - the course mission-agent (id learned at pre-test, set via env)
//   - our own BDI agent
//   - our own LLM-agent self-id (so user-typed messages from the 3D
//     client logged in as MI6-LLM still work for testing)
//
// We also apply a per-sender rate limit so a misbehaving trusted
// agent (or a misconfigured loop) can't burn through our LLM quota.

const TRUSTED_IDS = new Set();
let TRUSTED_NAME_PATTERN = null;

(function init() {
  const bdiId = process.env.BDI_AGENT_ID?.trim();
  const missionId = process.env.MISSION_AGENT_ID?.trim();
  if (bdiId) TRUSTED_IDS.add(bdiId);
  if (missionId) TRUSTED_IDS.add(missionId);

  const pattern = process.env.MISSION_AGENT_NAME_PATTERN;
  if (pattern) {
    try {
      TRUSTED_NAME_PATTERN = new RegExp(pattern, 'i');
    } catch (e) {
      console.warn(`[sender-filter] invalid MISSION_AGENT_NAME_PATTERN: ${e.message}`);
    }
  }
})();

const RATE_LIMIT_MS = 2000;
const lastSeenBySender = new Map();   // id -> timestamp of last accepted message

/**
 * Should we process this incoming message?
 *
 * @param {string} id      sender id
 * @param {string} name    sender name
 * @param {string} selfId  our own LLM-agent id (always trusted for self-testing)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function shouldProcess(id, name, selfId) {
  const trusted =
    id === selfId ||
    TRUSTED_IDS.has(id) ||
    (TRUSTED_NAME_PATTERN && TRUSTED_NAME_PATTERN.test(name || ''));

  if (!trusted) {
    return { ok: false, reason: `untrusted sender (${name}@${id})` };
  }

  const now = Date.now();
  const last = lastSeenBySender.get(id) || 0;
  if (now - last < RATE_LIMIT_MS) {
    return { ok: false, reason: `rate-limited (${name}@${id}, < ${RATE_LIMIT_MS}ms since last)` };
  }
  lastSeenBySender.set(id, now);

  return { ok: true };
}

/**
 * Register an id as trusted at runtime (e.g. once we learn the
 * mission-agent's id during the pre-test).
 */
export function trust(id) {
  if (id) TRUSTED_IDS.add(id);
}

export function describeFilter() {
  return {
    trustedIds: [...TRUSTED_IDS],
    namePattern: TRUSTED_NAME_PATTERN?.source ?? null,
    rateLimitMs: RATE_LIMIT_MS,
  };
}
