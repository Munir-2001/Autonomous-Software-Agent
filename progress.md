# Progress — Round 2 prep snapshot

Last update: **2026-05-24**. Picking up later? Start here.

Companion docs:
- [learnings.md](learnings.md) — round-1 post-mortem, hypotheses for tuning
- [slides/ASA/_INDEX.md](slides/ASA/_INDEX.md) — distilled notes from every course PDF
- [slides/ASA/DeliverooAgent_repo_findings.md](slides/ASA/DeliverooAgent_repo_findings.md) — analysis of the professor's code repo

---

## Where we are

### Round 1 (done)
- **10th of 29** with 24 points (BDI-only agent). See learnings.md for the per-map breakdown and hypotheses.

### Round 2 prep — current branch `round-2`
- **BDI agent** (unchanged from round 1, in `src/`) — still works, smoke-tested.
- **LLM agent skeleton** (new, in `llm-agent/`) — ReAct loop, chat listener, basic tools, sender filter, runtime safety checks. Confirmed working end-to-end against the live UNITN server.
- **BDI ↔ LLM bridge** (new, in `src/shared/` and `llm-agent/bdi-bridge.js`) — BDI writes beliefs to `state/bdi-beliefs.json` each tick; LLM reads them via tools.
- **API access confirmed**: LiteLLM @ `llm.bears.disi.unitn.it/v1`, model `llama-3.3-70b-lmstudio`, key `sk-Ut4M1zIf4PRVzF_6evlrxQ`.
- **Two Deliveroo tokens minted**: BDI = `MI6` (id `31bcf5`), LLM = `MI6-LLM` (id `c57099`).

### Round 2 — still TODO
- **LLM → BDI write side**: `set_policy` tool + BDI's policy reader (for Level-2 missions like "deliver stacks of exactly 3").
- **Chat-based coordination protocol**: `claim_parcel` / `release_parcel` between BDI and LLM (matches the `7pickup.js` pattern from the professor's repo). Slide-mandated by Part-2 §9 ("closest agent commits to pickup").
- **Mission classifier**: CoT-SC to detect trap missions (e.g., "Move to (4,7) for -10pts") before executing.
- **BDI tuning** (from learnings.md): H1 (raise CARRY_FORCE_DELIVER), H2 (patrol-while-carrying), H3 (marginal chain-safe), H4 (distance-aware deliver).
- **Directional EXIT rule check** (H0a from learnings.md) — confirm whether live server enforces exit direction on `↑↓←→` tiles.
- **PDDL re-enable** for the exam (PDDL is 20% of grade; currently disabled).

---

## Architecture (current)

```
┌─────────────────────────────────────────────────────────────────┐
│  Deliveroo.js server (UNITN)                                    │
│  https://deliveroojs.bears.disi.unitn.it/                       │
└─────────────────────────────────────────────────────────────────┘
                 ▲                              ▲
                 │ token: MI6 (31bcf5)          │ token: MI6-LLM (c57099)
                 │                              │
       ┌─────────┴─────────┐          ┌─────────┴───────────┐
       │   BDI agent       │          │   LLM agent         │
       │   src/            │          │   llm-agent/        │
       │                   │          │                     │
       │  Beliefs → brf    │          │  Chat listener      │
       │  Desires/Intent.  │          │     ↓               │
       │  Plan library     │          │  Sender filter      │
       │  Reactive layer   │          │  (only trust BDI    │
       │  Executor         │          │   + mission-agent)  │
       │       │           │          │     ↓               │
       │       ▼           │          │  ReAct loop ──→ LLM │
       └───────┼───────────┘          └─────────┬───────────┘
               │                                │
               │  writes every tick      reads on tool call
               ▼                                ▲
       ┌─────────────────────────────────────────────┐
       │  state/bdi-beliefs.json                     │
       │  { tick, me, map, parcels, agents,          │
       │    currentIntention }                       │
       └─────────────────────────────────────────────┘
```

**Communication channels**:
1. **Shared file** (`state/bdi-beliefs.json`) — BDI → LLM, sub-millisecond reads, debounced 100ms writes. **In place**.
2. **Game chat** (`emitSay` / `emitAsk`) — used for coordination decisions (closest-agent rule, claim/release). **Tools exposed to LLM, but coordination protocol not yet wired both ways**.
3. **Reverse file** (`state/llm-policy.json`) — LLM → BDI for Level-2 policy overrides. **Not yet built**.

Slide grounding for this design: see [slides/ASA/06_project_part2_spec.md](slides/ASA/06_project_part2_spec.md) and learnings.md §"Strategic hypotheses".

---

## File map

### BDI agent — `src/` (unchanged from round 1 except the bridge hook)
```
src/
├── index.js            ← control loop; hooks publishBeliefs() after brf()
├── beliefs.js          ← belief base + brf
├── desires.js          ← option generation + scoring
├── intentions.js       ← IntentionManager with open-minded commitment
├── executor.js         ← emit move/pickup/putdown with try/catch on SDK timeouts
├── reactive.js         ← subsumption layer (veto + sidestep)
├── scoring.js          ← Bayesian decay + game-theoretic competitor model
├── config.js           ← all tunable knobs
├── plans/library.js    ← PRS plan library (pickup/deliver/explore/goto)
├── planner/
│   ├── index.js        ← unified planner interface
│   ├── bfs.js          ← BFS with directional-entry rules
│   ├── pddl.js         ← PDDL HTTP client (disabled by default)
│   └── domain.pddl
├── shared/
│   └── belief-writer.js  ← NEW: writes state/bdi-beliefs.json
└── utils/
    ├── geometry.js
    └── log.js
```

### LLM agent — `llm-agent/` (new)
```
llm-agent/
├── index.js            ← entry; connects, listens on socket.onMsg, runs ReAct
├── llm-client.js       ← OpenAI client → BEARS LiteLLM (Llama 3.3 70B)
├── prompts.js          ← AGENT_PROMPT with full tool catalog
├── parsers.js          ← extractAction, extractFinalAnswer, runtime checks
├── react-loop.js       ← runAgentTurn — 20-iter cap, scratchpad memory
├── tools.js            ← 14 tools (see below)
├── sender-filter.js    ← whitelist + 2s rate-limit on incoming chat
└── bdi-bridge.js       ← reads state/bdi-beliefs.json with mtime cache
```

### Shared state
```
state/
└── bdi-beliefs.json    ← generated each cycle, gitignored
```

---

## Tool inventory (LLM agent)

| Tool | Source | Use |
|---|---|---|
| `calculate(expr)` | local (sandboxed eval) | arithmetic in mission text |
| `get_my_position()` | local (socket.onYou) | LLM's own coords |
| `move(direction)` | local (socket.emitMove) | one tile per call |
| `pickup()` | local (socket.emitPickup) | pick up parcels here |
| `putdown()` | local (socket.emitPutdown) | drop carried parcels |
| `say(toId\|msg)` | local (socket.emitSay) | direct chat to one agent |
| `shout(msg)` | local (socket.emitShout) | broadcast |
| `ask(toId\|msg)` | local (socket.emitAsk) | direct + await reply (5s timeout) |
| `get_nearby_parcels()` | BDI bridge | visible parcels w/ reward + distance |
| `get_visible_agents()` | BDI bridge | other players sensed by BDI |
| `get_delivery_tiles()` | BDI bridge | known delivery zones |
| `get_spawning_tiles()` | BDI bridge | known spawn zones |
| `get_map_info()` | BDI bridge | width/height/counts |
| `get_bdi_state()` | BDI bridge | BDI position + carried + intention |

---

## Hard deadlines

| Date | Milestone |
|---|---|
| **2026-05-26** | Pre-test (mission-agent will be visible — capture its id, set `MISSION_AGENT_ID` in `.env`) |
| **2026-05-27** | Registration form deadline |
| **2026-06-03** | Challenge 2 (live) |
| **2026-06-17** | Suggested exam-session submission deadline (22 June session) |

---

## Quick-start commands

From `project/`:

```bash
# Run BDI agent (writes state/bdi-beliefs.json each cycle)
npm start

# Run LLM agent (reads state, listens on chat)
npm run llm

# Smoke tests (no network)
npm run smoke
npm run llm:smoke
```

Open the 3D client (UNITN VPN required) at https://deliveroojs.bears.disi.unitn.it/ — log in with each token to see each agent in action.

---

## Key decisions made (with slide grounding)

1. **Architecture: 3-layer hybrid** (reactive + BDI + LLM). LLM strictly above BDI; never computes paths. [slides/ASA/03_agent_architectures.md]
2. **Two processes, one repo** — separate tokens / sockets, shared file for fast IPC. [slides/ASA/02_agents_multi_agent_systems.md]
3. **Coordination via chat** (per slide-mandated speech-act style + closest-agent rule from Part-2 §9), **belief exchange via file** (for tick-cadence freshness). [slides/ASA/06_project_part2_spec.md]
4. **`openai` npm package** with BEARS LiteLLM endpoint — matches course tutorial exactly. [slides/ASA/01_llm_agents_tutorial.md]
5. **ReAct + runtime safety checks** copied verbatim from `lab8-LLMs/07C` (counts actions, detects mixed Action+Final-Answer). [slides/ASA/DeliverooAgent_repo_findings.md]
6. **Sender filter** with whitelist + 2s rate limit because the shout channel will be flooded in a 25-team competition.
7. **Wider `CLOSE_PICKUP_DISTANCE`, lower `INTENTION_MARGIN`**, opportunistic pickup hooks — round-1 emergency tuning (see learnings.md for rationale).
8. **Directional-tile ENTRY rule** honored in BFS; EXIT rule TBD pending live confirmation. [learnings.md H0a]

---

## Decisions still open

- [ ] **Static `CARRY_FORCE_DELIVER` value**: 5 (current), 8, or 10? Map-adaptive later.
- [ ] **Mission classifier model**: simple regex on `-pts` / `lose` keywords, or CoT-SC LLM call? CoT-SC is slower but more robust.
- [ ] **PDDL re-enable timing**: pre-challenge (risk of latency regression) or post-challenge for the report?
- [ ] **Report exam session**: 22 June (tight, submit by 17/06) or 14 July (more polish time)?
- [ ] **Whether team has 1 or 2 students**: confirm with course staff at pre-test.

---

## Next session — recommended pickup

In priority order:

1. **Test the BDI ↔ LLM bridge live**: start both agents, ask the LLM agent in chat "where are parcels?" — should call `get_nearby_parcels` and return BDI-sensed parcels with distance. (Validates the architecture before adding more.)
2. **Build the reverse channel** — `llm-agent/policy-writer.js` + `src/shared/policy-reader.js` + the `set_policy` tool. Unlocks Level-2 missions.
3. **Build the claim/release coordination protocol** (chat-based, follows `lab6/7pickup.js`). Unlocks Level-3 missions.
4. **Mission classifier** — even a regex-based first pass to refuse obvious trap missions.
5. **At pre-test (26/05)**: capture mission-agent's id, set `MISSION_AGENT_ID` in `.env`.

If short on time before challenge: ship 1+2+5 only; defer 3+4. Even partial L1 + L2 support per the slides earns points.

---

## Risks / known issues

- **`teamId` mismatch**: our two tokens have different `teamId` despite same `teamName: MI6`. Unclear if course scoring sums by name or by id. Confirm at pre-test.
- **`mathjs` not used**: `calculate` tool uses `eval()` with a regex guard. Probably safe for mission text but swap to `mathjs` if we have time.
- **PDDL disabled**: re-enable for exam (20% of grade rests on it). Already wired up with background-only architecture; toggle `PDDL_ENABLED=true` in env.
- **Echo guard is text-match only**: tracks last 30s of outgoing strings. If the model legitimately repeats itself it could be filtered. Unlikely but worth knowing.
- **LLM agent currently has no autonomous parcel-collection**: it only responds to chat. The BDI handles standard missions; LLM only handles special missions. Decide before round 2 whether the LLM should ALSO collect parcels autonomously when no mission is active.
