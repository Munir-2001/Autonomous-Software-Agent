# Slide 08 — Intro to Planning (PDDL)

**Source:** "Intro to Planning" deck, Prof. Giorgini, ASA A.A. 2025-2026.

This deck locks in **PDDL as our automated planner** for the Part 1 requirement *"once an intention is activated the agent must call the planner."* The deck covers:
- What model-based planning is (and isn't)
- STRIPS / PDDL formalism
- Domain file vs Problem file split
- The online planner the course recommends: https://editor.planning.domains/

Some slides have predicate/action declarations rendered as images we can't extract directly — but the shape is standard PDDL and we know the formalism. Where exact syntax matters (action schemas), we'll verify against the planner during implementation.

---

## 1. What model-based planning is — and where it fits in our agent

### From the deck

> Planning is the **reasoning side of acting** — explicit deliberation that **chooses and organises actions on the basis of expected outcomes** to achieve an objective as best as possible.
>
> "...planning is the model-based approach to action selection..."

### When model-based planning fits (slide checklist)

The slide gives criteria. For Deliveroo:

| Criterion | Deliveroo? |
|---|---|
| Domain can be described explicitly (actions, preconditions, effects) | ✅ Movement, pickup, putdown are simple. |
| Goals are clear and change per problem | ✅ Each intention defines a different goal state. |
| Need goal-directed reasoning | ✅ For pathfinding around obstacles. |
| Tasks are novel/combinatorial | ✅ Path topology changes per game. |
| Explainability matters | ✅ The report benefits from inspectable plans. |
| Limited data for learning | ✅ No pre-training, single agent. |

When **less suitable** (slide):
- Highly uncertain environment ← Deliveroo IS dynamic
- Actions with unknown effects ← Deliveroo actions are deterministic
- Fast reactive behavior beats deliberation ← Reflexes go in the reactive layer, not PDDL
- Good policies can be learned ← N/A

### Conclusion

Use PDDL for the **deterministic sub-problems** where reasoning shines:
- **`goto(target_tile)`** — the primary use case. Path through a known walkable graph with possible static obstacles.
- **Optionally:** sequence planning ("pick up A then B then deliver") if PDDL is fast enough — see §8.

Don't use PDDL for:
- Per-tick action selection (too slow, env too dynamic).
- Probabilistic reasoning (closed-world, deterministic — wrong tool).

---

## 2. The four planning approaches (slide 2) — for the report's framing

The slide explicitly says these are **not orthogonal**:

| Approach | What it is | Our use |
|---|---|---|
| **Programming-based** | Hand-written agent control | The BDI tactical loop, plan library |
| **Learning-based** (RL) | Inferred from experience | ❌ Not used |
| **Model-based** (PDDL) | Reasoning over an explicit model | `goto` planner |
| **LLM-based** | NL reasoning (CoT, ToT, ReAct) | Strategic layer (Part 2) |

**Our agent uses three of the four.** This is a strong framing for the report's introduction — we don't pick one paradigm, we compose them at the right level.

---

## 3. AI Planning Problem — formal definition (slide 7)

> Given:
> - A description of (possible) **initial state(s)**
> - A description of desired **goal states**
> - A description of a set of **possible actions**
>
> Generate:
> - **A sequence of actions** that leads to one of the goal states.

For our `goto` planner per intention activation:
- **Initial state:** `at(me, currentX, currentY)` + map facts (walkable tiles, occupied tiles).
- **Goal:** `at(me, targetX, targetY)`.
- **Actions:** four `move-*` schemas + (optional) `pickup`, `putdown` if we extend to full sequence planning.

---

## 4. Simplifying assumptions (slide 11) — what we have to fake

The slide lists the classical-planning assumptions:

| Assumption | True for Deliveroo? | Workaround |
|---|---|---|
| Known initial state | ✅ Yes (from beliefs) | None needed |
| Deterministic actions | ✅ Yes | None needed |
| Simple action representation | ✅ Yes | STRIPS-level |
| Instantaneous actions | ❌ Moves take 0.6 + 0.4 phases | Plan in tile-units, executor handles timing |
| No deadlines, sufficient resources | ❌ Parcels decay | Time-budget the plan call; if path > parcel timer, plan is invalid |
| Fully observable | ❌ Sensing radius limited | Plan only over known walkable graph + treat unknowns as worst-case |
| Single agent | ❌ Multiple agents | Snapshot competitors as static obstacles (slide-07 §12 strategy) |
| No concurrent actions | ✅ One action per tick | None needed |

**The mismatches are fine.** PDDL solves a *snapshot* of the world. If the world changes, we replan. That's the BDI control-loop pattern from slide-07.

---

## 5. STRIPS / PDDL formalism (slides on STRIPS and PDDL)

Locked-in formalism for our domain:

- **State** = set of ground literals. Anything not in the set is false (**closed-world assumption**).
- **Action** = preconditions + effects (add list + delete list).
- **No explicit time** in classical PDDL.
- **No logical inference rules** — preconditions are direct lookups, not derivations.

### Closed-world assumption (CWA)

The slide flags this. For us it means:
- "The tile at (3, 3) is walkable" must be in the state, or it's treated as not walkable.
- "There is no other agent at (3, 3)" doesn't need to be stated — absence of `agent-at(_, 3, 3)` implies it.

This **simplifies our problem-file generation** significantly: only include positive facts.

---

## 6. PDDL file split (slides on Domain file / Problem file)

Two files, written separately:

| File | Contains | When generated |
|---|---|---|
| **Domain file** (`deliveroo.pddl`) | Types, predicates, action schemas | **Once**, hand-written, committed to repo. |
| **Problem file** (`problem-XXX.pddl`) | Objects, initial state (facts), goal | **Per intention**, generated at runtime from current beliefs. |

This is good architecture — the domain file is reusable across all `goto` problems, only the problem file changes.

---

## 7. Our Deliveroo PDDL design (proposed)

### Types

```pddl
(:types
  tile
  parcel
  agent)
```

### Predicates (proposed)

```pddl
(:predicates
  (at ?a - agent ?t - tile)               ; agent location
  (walkable ?t - tile)                     ; tile is walkable
  (delivery ?t - tile)                     ; tile is a delivery tile
  (adjacent ?t1 - tile ?t2 - tile)         ; adjacency relation
  (occupied ?t - tile)                     ; another agent or obstacle
  (parcel-at ?p - parcel ?t - tile)        ; parcel location
  (carrying ?a - agent ?p - parcel))       ; agent is carrying parcel
```

### Actions (proposed)

```pddl
(:action move
  :parameters (?a - agent ?from - tile ?to - tile)
  :precondition (and (at ?a ?from)
                     (adjacent ?from ?to)
                     (walkable ?to)
                     (not (occupied ?to)))
  :effect (and (not (at ?a ?from)) (at ?a ?to)))

(:action pickup
  :parameters (?a - agent ?p - parcel ?t - tile)
  :precondition (and (at ?a ?t) (parcel-at ?p ?t))
  :effect (and (carrying ?a ?p) (not (parcel-at ?p ?t))))

(:action putdown
  :parameters (?a - agent ?p - parcel ?t - tile)
  :precondition (and (at ?a ?t) (carrying ?a ?p))
  :effect (and (not (carrying ?a ?p)) (parcel-at ?p ?t)))
```

This is the **starter shape**. The action schemas may need typing/conditional-effects refinement when we test against the actual planner.

### Why one `move` action with `from`/`to` parameters instead of four directional actions

- Cleaner — no `move-up` / `move-down` / `move-left` / `move-right` duplication.
- Direction is computed by the executor *after* the planner returns a sequence of `(at A T1) → (at A T2)` transitions.
- This works because of the `(adjacent ?from ?to)` predicate enumerating the topology.

**Trade-off:** the problem file gets bigger (we have to enumerate adjacency for every walkable tile pair). Mitigation: only enumerate tiles within a relevance radius of `me` and the target.

---

## 8. Granularity decision: goto-only vs full-sequence PDDL

### Option A — `goto`-only (our default)

PDDL solves: "find a path from current tile to target tile."
The high-level "which parcel, in what order" stays in JS BDI scoring.

**Pros:** small problem files (only spatial reasoning), fast solver, replanning is cheap.
**Cons:** can't optimize "pick up A then B then deliver" globally — BDI scores them sequentially.

### Option B — full-sequence PDDL

PDDL solves: "starting empty-handed at (x, y), end with all parcels delivered."

**Pros:** globally optimal sequence.
**Cons:** problem file is huge (every parcel × every tile × every time-step), solver may not finish in our time budget, replanning every tick is impractical.

### Decision: Option A

Mention Option B in the report as an alternative. Possibly explore as a stretch goal if Option A is fast enough.

---

## 9. The online planner (slide on "Next") — https://editor.planning.domains/

The course recommends this. Useful properties (verified at integration time):
- Web-based PDDL editor for testing domain files.
- HTTP solver endpoint (the planning.domains "solver" service is publicly accessible).
- Multiple planner backends.

### Integration plan

1. Start the development phase by hand-running `domain.pddl` + sample `problem.pddl` in the editor to verify domain correctness.
2. At runtime, our agent POSTs `{ domain, problem }` JSON to the solver endpoint and parses the returned plan.
3. **Fallback:** if the HTTP planner is slow / unavailable, fall back to a local BFS over the walkable-tile graph (already in our architecture). Same input, same output, but no PDDL.

### TBD at implementation time

- Exact HTTP endpoint and request/response shape (verify before coding the client).
- Which solver backend to request (multiple are exposed; pick one with low latency).
- Whether to install a local PDDL solver as a more reliable fallback (probably yes — Fast Downward via Docker, if HTTP is flaky).

---

## 10. Plan representations (slide on "What is a plan?")

The slide lists four:

| Form | Meaning | Use? |
|---|---|---|
| **Sequence** | Ordered list, executed one after another | ✅ Default for `goto` |
| **Set** | Unordered, executor decides order | ❌ Not needed |
| **Tree** | Conditional branches (non-deterministic envs) | ❌ PDDL is deterministic |
| **Policy** | State → action mapping (RL/MDP) | ❌ Not RL |

Output of our PDDL solver is a **sequence**. The executor walks it step by step.

---

## 11. Replanning is not optional

The slide flags that classical-planning assumptions (single-agent, fully observable, no resource limits) don't hold in Deliveroo. The cure is replanning, not better planning.

For our integration:
- Each `goto` intention triggers ONE planner call to get a plan.
- The executor walks the plan.
- If a step fails (target tile occupied), the executor reports back to the BDI loop.
- The BDI loop re-issues the `goto` with updated beliefs (or drops the intention if no path).

This is **the meta-level controller from slide-03 in action** — we don't replan on every tick, only on triggers.

---

## 12. PDDL extras — what we use vs skip

Slides reference three extras: **typing**, **type hierarchy**, **conditional effects**.

| Extra | Use? |
|---|---|
| **Typing** | ✅ Definitely. `tile`, `parcel`, `agent` are distinct types. Solver speed-up + clarity. |
| **Type hierarchy** | Probably not needed for v1. If we add `walkable-tile` and `delivery-tile` as subtypes of `tile`, we could remove the `walkable` predicate. But it's just nicer syntax — skip until needed. |
| **Conditional effects** | Useful for the `pickup` action (effect depends on whether the parcel was sensed). v1 — skip. |

---

## 13. Concrete locked-in decisions for our planner module

1. **Use PDDL via planning.domains HTTP solver** as primary, with **local BFS fallback**.
2. **Goto-only granularity** for v1. Full-sequence is a stretch.
3. **Domain file** hand-written, committed at `project/planner/domain.pddl`.
4. **Problem file generated per call** from current beliefs. Generated as a string, sent over HTTP.
5. **Single `move` action** with `from`/`to` params; adjacency enumerated in the problem file.
6. **Closed-world assumption** — only positive facts in the problem file.
7. **Typed objects** (tile, parcel, agent).
8. **Plan = sequence** of actions; executor walks step by step.
9. **Tile-graph snapshotting** — the problem file uses our current belief about walkable + occupied tiles. Re-snapshot on each call.
10. **Other agents = `occupied` predicate** at their last-known position. Conservative; if they've moved, our plan may need to replan but we won't crash into them.
11. **Time-budget the planner** — if no plan returns in N ms, fall back to BFS or drop the intention.

---

## 14. Things to AVOID

- **Don't try to solve full-game optimization with PDDL.** Too combinatorial, too slow, too noisy. Use PDDL for clean sub-problems.
- **Don't model probabilistic state in PDDL.** Use Bayesian belief in the BDI layer; pass deterministic snapshots to PDDL.
- **Don't generate huge problem files.** Restrict tile graph to relevant region (BFS radius around `me` + `target`).
- **Don't replan inside the planner call.** Replanning is the BDI loop's job.
- **Don't trust the HTTP solver to always be up.** Always have a local fallback.

---

## 15. Open / TBD (verify when we code the planner module)

- **Exact planning.domains HTTP API shape** (endpoint, request body, response format). Verify against current docs at integration time.
- **Solver backend choice** — multiple available; pick the fastest for our problem size.
- **Local fallback planner choice** — BFS in JS is the cheap baseline; Fast Downward via Docker is more capable. Decide based on whether BFS is fast enough.
- **Problem-file size threshold** — at what tile count does the planner get too slow? Tune.
- **Whether to use type hierarchy and conditional effects** — defer to v2 if v1 works.
