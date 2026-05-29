# BDI Agent Architecture — Part 1

This document describes the architecture of the single BDI agent for Part 1 (competing against other agents — no multi-agent comms yet).

---

## 1. The BDI Control Loop

```
        ┌─────────────────────────────────────────────────┐
        │                                                 │
        ▼                                                 │
   ┌─────────┐    ┌───────────────┐    ┌───────────────┐  │
   │  SENSE  │───▶│ REVISE BELIEFS│───▶│GENERATE DESIRES│ │
   └─────────┘    └───────────────┘    └───────┬───────┘  │
                                               │          │
                                               ▼          │
                                    ┌────────────────────┐│
                                    │ FILTER → INTENTION ││
                                    └─────────┬──────────┘│
                                              ▼           │
                                       ┌────────────┐     │
                                       │    PLAN    │     │
                                       │ (lib+PDDL) │     │
                                       └─────┬──────┘     │
                                             ▼            │
                                       ┌────────────┐     │
                                       │  EXECUTE   │─────┘
                                       └────────────┘
```

If at any step the world changes meaningfully (new parcel, blocked path, intention obsolete) → drop current intention and re-deliberate.

---

## 2. Components

### 2.1 Belief Base
Authoritative model of the world from sensing.

- `me`: `{id, name, x, y, score, penalty, carrying: Map<parcelId, parcel>}`
- `map`: `{width, height, tiles[]}` — static, received once
- `parcels`: `Map<parcelId, {id, x, y, reward, lastSeen, carriedBy?}>`
  - Reward timer is **decremented locally** between sensing events using game clock.
  - Parcels not seen for N ticks become **stale** but are NOT deleted — a hypothesis the parcel may still exist.
- `players`: `Map<playerId, {id, name, x, y, score, lastSeen, predictedDirection?}>`
  - Last-seen positions kept; can guess direction from successive sightings.

**Belief revision rule:** when sensed data contradicts a belief (e.g., we are on the parcel's tile and pickup returns nothing), drop only that specific belief, not the whole hypothesis space.

### 2.2 Desires (candidate goals)
At every iteration, generate the set of goals worth pursuing:

- `deliver(parcelId)` — for each parcel currently believed to exist
- `pickup(parcelId)` — for each non-carried parcel believed to exist
- `goto-delivery` — when carrying parcels and a delivery tile is reachable
- `explore` — when no parcels are known (default fallback)

### 2.3 Intention Selection (filter)
A scoring function picks **one active intention** at a time (configurable to allow a pipeline later).

```
score(intention) =
    expected_reward(parcel)
  - travel_cost(me → parcel → nearest_delivery)
  - risk_penalty(other_agents_competing)
```

`expected_reward` accounts for parcel decay over the projected travel time. We commit to the intention with the highest score and **monitor** it: if a higher-value intention emerges or the current one becomes infeasible, we drop and re-deliberate.

### 2.4 Plans
Two layers:

**Plan Library (predefined):** for trivial sub-goals.
- `plan_pickup(parcel)` — go-to + pick_up
- `plan_deliver(deliveryTile)` — go-to + put_down
- `plan_explore()` — random walk to a spawning tile

**External Planner (PDDL):** for the `go-to` sub-problem when the path is non-trivial (other agents in the way, multi-step routing through walkable tiles only).
- Domain: walkable-tile graph
- Initial state: agent position
- Goal: target `(x, y)`
- Output: action sequence consumed by the executor.

### 2.5 Executor
Translates plan steps into SDK calls (`emitMove`, `emitPickup`, `emitPutdown`) with:
- Resilient move (retry N times on collision before giving up).
- Per-step belief check — if a move's precondition is now broken, abort the plan and bubble up to the control loop.

### 2.6 Re-deliberation triggers
The control loop drops the current intention and re-deliberates when:
- A new parcel appears with score > current intention.
- The current parcel disappears (either delivered by another agent or expired).
- A move fails repeatedly (path blocked).
- We finish carrying parcels (score collected).

---

## 3. Code Layout (proposed)

```
project/
├── PROJECT.md           ← spec / deliverables
├── ARCHITECTURE.md      ← this file
├── package.json
├── .env                 ← HOST, TOKEN
├── src/
│   ├── index.js         ← entrypoint: connects, starts the loop
│   ├── beliefs.js       ← belief base + revision
│   ├── desires.js       ← desire generator
│   ├── intentions.js    ← scoring + intention queue
│   ├── plans/
│   │   ├── pickup.js
│   │   ├── deliver.js
│   │   ├── explore.js
│   │   └── goto.js      ← wraps planner call
│   ├── planner/
│   │   └── pddl.js      ← PDDL domain + problem builder + planner client
│   └── utils/
│       ├── pathfinding.js   ← BFS over walkable tiles, fallback if planner unavailable
│       └── geometry.js
└── tests/
    └── (unit tests for belief revision, scoring, pathfinding)
```

---

## 4. Forward-Compatibility With Part 2

- Belief base will be exposed via a small message API so the LLM agent can read/write shared beliefs.
- Intention scoring will accept "external commitment" hints (e.g., "the other agent already committed to parcel X") so multi-agent coordination plugs in without rewriting the core loop.

---

## 5. Milestones

1. **M1 — Skeleton:** connect, receive map + sensing, log belief base.
2. **M2 — Reactive baseline:** greedy "always go to highest-reward visible parcel" agent, no PDDL.
3. **M3 — BDI loop:** explicit beliefs / desires / intentions modules with re-deliberation.
4. **M4 — PDDL integration:** swap goto pathfinding for external planner.
5. **M5 — Tuning:** intention scoring weights, exploration heuristic, collision recovery.
6. **M6 — Report + presentation prep.**

(Part 2 — LLM agent + comms — starts after M5.)
