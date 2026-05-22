# Key Takeaways for Competition

**Single source of truth, synthesized from slide notes 01–08.**
Use this for every implementation decision. When in doubt, this file wins over earlier `ARCHITECTURE.md` notes.

---

## 0. Mission

Build a **single autonomous agent** that competes against other agents in **Deliveroo.js**, scoring points by picking up parcels and delivering them to delivery tiles. Score per parcel = remaining decay timer at drop-off, so **fast routing + smart targeting** is the win condition.

Two-part deliverable:
- **Part 1 (now):** BDI agent with belief revision, intention revision, predefined plans, and **PDDL planner** integration.
- **Part 2 (later):** add a second LLM-based agent that coordinates with the BDI agent (exchange beliefs, claim parcels, etc.).

Grade depends on: **JS code + ≤10-page report + oral**, all weighted heavily on the project.

---

## 1. Architecture — locked in

**Hybrid agent: BDI deliberative core + reactive reflex layer + PDDL planner for `goto` + LLM agent (Part 2) for strategy.**

```
┌─────────────────────────────────────────────────────────┐
│                   ENVIRONMENT (Deliveroo)               │
└──────────────┬──────────────────────────────────────────┘
               │ sensing                       ▲ actions
               ▼                               │
       ┌───────────────┐                       │
       │  BELIEF BASE  │ ──────────────────────┤
       │ (facts + IC)  │                       │
       └───────┬───────┘                       │
               │                               │
       ┌───────▼─────────┐  options    ┌───────▼─────────┐
       │ DESIRES (rules) │────────────▶│ INTENTIONS      │
       └─────────────────┘              │ (one active +   │
                                        │ scheduled queue)│
                                        └───┬─────────────┘
                                            │ active intention
                                            ▼
                              ┌───────────────────────┐
                              │ PLAN LIBRARY (PRS)    │
                              │ context+goal recipes  │
                              └───────────┬───────────┘
                                          │ goto sub-goal
                                          ▼
                              ┌───────────────────────┐
                              │ PDDL planner (HTTP)   │
                              │ + BFS fallback        │
                              └───────────┬───────────┘
                                          │ action sequence
                                          ▼
                              ┌───────────────────────┐
                              │ EXECUTOR              │
                              └───────────┬───────────┘
                                          │ proposed action
                                          ▼
                              ┌───────────────────────┐
                              │ REACTIVE REFLEX LAYER │
                              │ (Brooks subsumption)  │
                              └───────────┬───────────┘
                                          │ final action
                                          └─────► socket
```

**Reactive reflex priorities (high → low):** avoid collision → drop on delivery tile → pickup on parcel tile → BDI suggested action → explore.

**Part 2 plug-in:** the BDI's public API doubles as the **tool catalog** for the LLM agent. Same surface, two consumers.

---

## 2. The five competition differentiators

Most lab agents won't do these. Each one is worth points.

### 2.1 Bayesian belief decay + competitor risk
For every out-of-range parcel, track confidence:
```
P(still there) = e^(−λ × d_self) × (1 − e^(−λ × d_competitor))
EV(parcel) = P(still there) × reward
```
Threshold: drop from candidates if `confidence < 0.3`. Tune λ empirically.

### 2.2 Game-theoretic competitor modeling
Don't just compute distance — predict what the competitor will rationally pursue:
```
P(competitor → parcel_i) = EV_competitor(i) / Σ EV_competitor(k)
```
Then **target parcels the competitor is unlikely to chase**, even if they're not the closest to us. This is the single biggest scoring lever.

### 2.3 Open-minded commitment with margin
Re-deliberate every tick, but only switch intentions if a new option beats the current by a margin (configurable, start ~10%). Avoids both blind commitment (slide-03 trap: stuck on doomed paths) and thrashing (slide-03 trap: never finishes anything).

### 2.4 Hybrid reactive + deliberative
Reflex layer overrides BDI when needed: collision avoidance, opportunistic pickup, drop-on-delivery. BDI suggests; reflex has veto.

### 2.5 Time-as-failure
Every plan validates `estimated_arrival_time + decay_during_travel < parcel.timer` before commit. A correct plan that arrives late is a failed plan.

---

## 3. The BDI control loop (canonical)

Per slide-07, this is **the** loop. Implement it verbatim.

```
1.  brf(beliefs, percept)        → beliefs       // belief revision
2.  options(beliefs, intentions) → desires       // intention rules fire
3.  filter(beliefs, desires, intentions) → new intentions  // scoring + margin
4.  plan(beliefs, intention, actions) → plan     // library or PDDL
5.  execute(plan)                                 // action through reactive layer
loop
```

**Module names must match `brf`, `options`, `filter`, `plan`** for clean report mapping to theory.

**Meta-level controller** decides whether to actually re-deliberate. Triggers:
1. New parcel appeared with EV > current intention's EV by margin M.
2. Current target parcel disappeared.
3. Plan + replan both failed.
4. Intention complete.
5. Projected reward < 0.

---

## 4. Belief base — implementation rules

**Course directive (non-negotiable):** facts + integrity constraints, **no logical deduction**, no theorem proving. Flat fact store, DB-style.

**Per-entity belief models:**
| Entity | Model |
|---|---|
| `me` | No memory (overwrite from sensing) |
| `map` | Immutable after first sensing |
| Visible parcels/agents | No memory |
| Out-of-range parcels | Bayesian decay (§2.1) |
| Out-of-range agents | Last-seen + inferred velocity |
| Static walls | Permanent |

**Preservation principle:** new info compatible with current B → keep all of B. Only drop on direct contradiction.

**Update vs Revision:**
- Update (default): world changed; apply new sensing as new state.
- Revision: sensor data contradicts belief (we're on the parcel's tile, pickup fails). Mark "actively confirmed missing."

**Confidence field** on every belief, in [0,1].

---

## 5. Intentions — the rules

Per Bratman (slide-03), intentions:
1. Pose problems → agent devotes resources to achieving them.
2. Filter conflicting options → prune desires that conflict with current intention.
3. Track success and retry → replan on failure, don't drop the goal.
4. Are believed possible → feasibility-check before commit.
5. Are not believed certain → use score margin, not hard threshold.
6. Don't import side effects → side effects are computed, not committed.

**Intention lifecycle:** `pending → active → succeeded | failed | dropped`.

**Single active intention** for v1. Scheduled queue if v2 demands. Order by total expected score.

**Derived vs non-derived intentions** — track `parentId`. Drop derived when parent drops, unless independently justified.

**Commitment to ends, not means:** plan fails → replan, don't abandon. Only drop intention when *no* plan can achieve it.

---

## 6. Plans — PRS-style library + PDDL for `goto`

**Plan = recipe; intention = committed instance.** Don't conflate.

**Plan library** (procedural, fast):
- `pickup_plan(parcel)` — goto + pick_up
- `deliver_plan(parcel, deliveryTile)` — goto + put_down
- `goto_plan(target)` — wraps PDDL/BFS
- `explore_plan()` — random walk to spawning tile

Each plan declares: **`context`** (precondition predicate) + **`goal`** (postcondition predicate) + **`body`** (steps, may include sub-goals).

**PDDL** for `goto` only:
- Domain file (hand-written, committed): types `tile / parcel / agent`, predicates `at / walkable / delivery / adjacent / occupied / parcel-at / carrying`, action `move(from, to)`.
- Problem file generated per call from current beliefs.
- Closed-world assumption: only positive facts.
- HTTP planner primary (planning.domains), **JS BFS fallback always available**.
- Time-budget every call (e.g., 200 ms).
- Other agents modeled as `occupied` snapshots.

---

## 7. Game mechanics that shape design

| Rule | Implication |
|---|---|
| Sensing radius `x_offset + y_offset < 5` | Belief base must model out-of-range entities with uncertainty |
| Move duration: 0.6 + 0.4 phases, both tiles locked | In-flight agents block 2 tiles |
| Move into occupied tile fails + penalty | Reactive layer must check target tile before emit |
| Direction conventions: `up = y+1`, `down = y-1` | Don't apply screen-coordinate intuition |
| Multiple parcels can be carried | Plan multi-pickup chains when EV > delivery-and-return |
| Score = remaining timer at drop-off | Optimize Σ(reward − travel) not Σ(reward) |
| Sensing distance / move duration / decay rate are server config | Read dynamically, never hardcode |

---

## 8. Non-negotiables (course directives + critical constraints)

1. **No logical deduction in beliefs.** Facts + integrity constraints only.
2. **Use BDI architecture explicitly.** Module names match theory (`brf`, `options`, `filter`, `plan`).
3. **Use an external planner** for at least one component (the course requires it). Goto-PDDL satisfies this.
4. **Belief revision and intention revision must be visible** — separate, named, observable.
5. **Replanning on plan failure**, not goal abandonment.
6. **Predefined plan library + planner** — both must be present; can't use only one.
7. **The BDI's public API is the LLM agent's tool catalog** — design once.

---

## 9. Implementation priority order

Build in this order. Each milestone is shippable and testable.

| M | Goal | Test |
|---|---|---|
| **M1** | Connect, receive map, log beliefs to console | Agent appears in 3D client, console shows tile/parcel/agent events |
| **M2** | Reactive baseline: greedy "go to nearest visible parcel" | Agent picks up parcels, delivers; no BDI structure yet |
| **M3** | Explicit BDI modules (`brf`, `options`, `filter`, `plan`); plan library; single active intention with margin | Agent behavior matches M2 but code is BDI-shaped |
| **M4** | Bayesian decay + EV scoring (§2.1) | Agent prioritizes high-EV parcels, ignores stale ones |
| **M5** | Game-theoretic competitor modeling (§2.2) | In games against others, agent avoids contested parcels |
| **M6** | PDDL `goto` planner with BFS fallback | Solver returns paths; fallback works on outage |
| **M7** | Reactive reflex layer (collision avoid, opportunistic pickup/drop) | Penalty count drops; never walks into another agent |
| **M8** | Tuning (λ, margin M, decay threshold, time budgets) | Score-per-game improves measurably |
| **M9** | Report v1 + ablation studies | Each diff differentiator measured for impact |
| **Part 2 — M10+** | LLM agent + tool catalog + ReAct loop + Reflexion log | LLM coordinates with BDI; multi-game improvement visible |

---

## 10. Things to AVOID

- **Don't use blind or single-minded commitment.** Open-minded with margin is the only choice for high-γ envs.
- **Don't reconsider every tick without throttling.** Meta-level controller decides.
- **Don't delete out-of-range beliefs.** Decay them, don't drop them.
- **Don't have the LLM make per-tick decisions.** Compound errors (95% × 100 = 0.6%). LLM is strategic only.
- **Don't generate huge PDDL problem files.** Restrict to relevance radius.
- **Don't build RAG.** No vector DB, no embeddings — game state isn't a document corpus.
- **Don't conflate plans (recipes) and intentions (committed instances).**
- **Don't import side effects as intentions.**
- **Don't trust LLM-generated parameters without validation.** Schema + server-side check.
- **Don't ignore time-as-failure.** A late-arriving plan is a failed plan.
- **Don't hardcode server constants** (sensing distance, move duration, decay rate).
- **Don't run logical inference over facts.** Course directive.
- **Don't skip the report data collection.** Log per-failure-type frequency from day one.

---

## 11. Evaluation rubric (= our internal QA gate)

Adopted verbatim from slide-06 failure-modes taxonomy. Every game logs:

- **Score** (primary metric).
- **Penalties** — collision count.
- **Failed moves** — replanning frequency.
- **Stale-belief expirations** — parcels we tracked too long after they decayed.
- **Reflection failures** (Part 2) — LLM claimed success when not.
- **Tool failures** (Part 2) — wrong-output rate per tool.
- **Steps per delivery** (efficiency).
- **Latency per BDI cycle** (efficiency).
- **Tool transitions** (Part 2) — call sequence patterns.

---

## 12. Report-worthy decisions log

We log these as we make them. Plug straight into the report:

- Why hybrid (slide-02): reactive layer for safety, BDI for deliberation, PDDL for `goto`, LLM for strategy.
- Why open-minded commitment (slide-03): high-γ environment.
- Why facts + integrity constraints (slide-07): course directive + simpler implementation.
- Why Bayesian decay + game-theoretic competitor model (slide-07): biggest scoring differentiator.
- Why no RAG (slide-04): wrong tool for game state.
- Why ReAct + Reflexion for LLM (slide-06): feedback loops + cross-game learning.
- Ablation results (M9): which differentiator contributed which fraction of the score.

---

## 13. Open / TBD

- **Tuning constants:** λ (decay), M (margin), confidence threshold, planner time budget.
- **PDDL planner endpoint** — verify exact API at planning.domains.
- **Course-provided LLM API + tool catalog** for Part 2 — wait on course release.
- **Local PDDL solver fallback** — JS BFS first; consider Fast Downward via Docker if BFS is insufficient.
- **Multi-competitor modeling** — slide examples have one competitor; how to handle 3+ rivals.
