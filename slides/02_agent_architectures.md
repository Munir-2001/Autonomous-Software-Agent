# Slide 02 — Agent Architectures

**Source:** "Agents' architectures" deck, Prof. Giorgini, ASA A.A. 2025-2026

Compares Logic-based, Reactive, Hybrid, BDI, and LLM architectures. **For our project we are committed to BDI for Part 1 + LLM for Part 2.** This note captures what is actionable.

---

## 1. The four classical architectures (one-line summary)

| Architecture | Idea | Why it matters for us |
|---|---|---|
| **Logic-based / Symbolic / Deductive** | Theorem-prove the next action from a logic theory + DB. | Intractable, slow, suffers from **calculative rationality** — irrelevant for us as a runtime, but the *failure mode* (deciding too slowly so the world has changed) is exactly the trap our re-deliberation logic must avoid. |
| **Reactive (Brooks subsumption)** | No world model. Stack of "behaviors", lower = higher priority, perception → action mapping. | Relevant: our **collision avoidance** and **opportunistic pickup/putdown** should be implemented as low-level reactive behaviors, not deliberated. Lab 1 was essentially purely reactive. |
| **Hybrid / Layered** | Deliberative layer + reactive layer; reactive usually has precedence. Two flavors: horizontal (each layer sees raw sensors) and vertical (sensors flow up through one layer). | Our agent will be effectively a **hybrid**: a BDI deliberative core with a reactive "safety layer" for moves and instant pickups. |
| **BDI (deliberative)** | Beliefs + Desires + Intentions + Plans. Most used in agent community. | This is our Part 1 architecture. |

Slide ordering also positions **LLM agents (2023)** as the next step — directly maps to Part 2.

---

## 2. Calculative rationality — the big warning

> An agent enjoys *calculative rationality* iff its decision will be optimal **for the world state when deliberation began**, not when the action fires.
>
> This is **not acceptable** in environments that change faster than the agent can decide.

Deliveroo is such an environment: parcels decay, agents move, paths get blocked.

**Implications for our design:**
- The deliberation pass must be **fast** (milliseconds, not seconds). Cap planner time-outs aggressively. Prefer cheap JS scoring over PDDL when both work.
- After every external event (`sensing` update), check whether the current intention is still optimal. If a higher-value intention emerges → drop and re-deliberate.
- Don't model the world the way classical logic agents do — pre-compute / cache / amortize. The slide says explicitly: *"shift the emphasis of reasoning from run time to design time."* For us this means precomputing maps, distance tables, walkability graphs once on connect.

---

## 3. Reactive ideas to STEAL into our hybrid agent

Brooks-style subsumption rules give a clean priority hierarchy. Translated to Deliveroo:

```
Priority 0 (highest, reactive): avoid collision
        if move target tile is occupied → wait or replan path
Priority 1 (reactive): drop on delivery
        if carrying parcels AND on a delivery tile → put_down
Priority 2 (reactive): pick up
        if standing on a parcel AND not at carry cap → pick_up
Priority 3 (deliberative): execute current intention's next action
Priority 4 (deliberative fallback): explore (random walk to spawning tiles)
```

This is exactly the layered structure: priorities 0-2 are *reactive reflexes* implemented as guards in the executor; priorities 3-4 come from the BDI core.

**Why this matters:** the slide explicitly notes lower (reactive) layers have precedence. We never want our BDI loop to plan a move into another agent because the plan was made 500 ms ago.

---

## 4. BDI — definitive definitions for our agent

The slides define each component precisely. Match these in code (and in the report — the examiners use these definitions).

### 4.1 Beliefs
> Information about the world, the past, … cached because the world is dynamic and the agent has a local view.

- **Beliefs ≠ knowledge.** A belief can be wrong. Important: the slide flags as ❌ the statement *"if the agent believes it is at a pickup cell, then this must be true in the real world."* Our belief base must allow for stale / incorrect entries.
- Cache **plans (recipes)** alongside beliefs — same reason: re-deriving is wasteful.

For Deliveroo specifically, valid beliefs include:
- `me.x, me.y, me.carrying`
- `parcels.byId[...]` with last-seen timestamp
- `players.byId[...]` with last-seen position and inferred velocity
- `map.tiles[...]` (immutable after first sensing)

### 4.2 Desires (a.k.a. Goals)
> Desired end states. Capture *why* code is executing. Useful for failure recovery and goal-interaction reasoning.

In Deliveroo:
- `maximize-score` (root desire)
- `deliver(parcelId)` for each parcel we know about
- `pickup(parcelId)` for each non-carried parcel we know about
- `explore` when no parcels are visible

**An agent can have many desires; only a limited number become intentions** (✅ in test slide).

### 4.3 Intentions
> Selected course of action (a *plan instance*). The selected, currently-running thing. Persistent by default, internally consistent, and "fleshed out by the time they need to be executed."

- Intention ≠ plan-in-the-library. Intentions are **instantiated, committed-to** plan executions. (Slide flags ❌ the statement *"a plan stored in the plan library is already an intention"* — must distinguish in our code.)
- Intentions must be persistent — we don't reconsider on every tick, only on triggers.
- "Fleshed out by execution time" → the planner is called *when* an intention activates, not earlier.

### 4.4 Plans
> Pre-known recipes / "know-how", not "the chosen course of action." Library of templates the agent can instantiate into intentions.

So in our code:
- `plans/` folder = library of recipes (`pickup`, `deliver`, `goto`, `explore`)
- Selecting one and instantiating it for a specific parcel = creating an intention
- Multiple intentions can exist; one is currently active

---

## 5. Commitment & re-planning rules (slide 53 — copy verbatim into report)

> A deliberating agent has many available options (too many to consider!), so we want to reduce the options to consider:
> 1. Don't consider options that conflict with selected intentions
> 2. Don't reconsider chosen options (unless there's a good reason)
> 3. When doing further planning, assume that intentions will have been achieved

These three rules go directly into our intention manager:

1. **Conflict pruning:** when scoring desires, skip any whose plan would invalidate the current intention (e.g., if we're carrying a parcel for delivery, don't propose dropping it for a marginally higher-reward parcel).
2. **Stickiness:** the current intention's score must be beaten by a margin (configurable threshold) before we drop it. Otherwise we thrash.
3. **Look-ahead consistency:** when scoring future desires, treat the current intention as completed and update beliefs accordingly (e.g., we're at the delivery tile with empty hands).

---

## 6. The "test slide" — Deliveroo BDI quiz

The slide ends with seven true/false statements. Memorize these — they're exam-grade definitions.

| # | Statement | Verdict |
|---|---|---|
| 1 | "The belief of the agent is that it wants to deliver a package" | ❌ — wanting is a *desire*, not a belief. |
| 2 | "The desire of the agent can be to maximize the score" | ✅ |
| 3 | "The intention of the agent is the path currently being executed to reach a delivery cell" | ✅ |
| 4 | "If the agent believes it is at a pickup cell, then this must be true in the real world" | ❌ — beliefs can be wrong; this is the **belief vs knowledge** distinction. |
| 5 | "An agent can have multiple desires but only a limited set of intentions" | ✅ |
| 6 | "In Deliveroo, `carrying = true` is a belief" | ✅ |
| 7 | "A plan stored in the plan library is already an intention" | ❌ — a plan is a recipe; an intention is a *committed instance*. |

**Use these as labels in code and comments.** A reviewer should be able to see at a glance which line corresponds to which BDI concept.

---

## 7. Concrete updates to our architecture (overrides ARCHITECTURE.md where they conflict)

1. **Make the agent explicitly hybrid.** Add a thin `reactive/` module above the executor with the Brooks-style priority rules. The BDI loop emits an *intended action*; the reactive layer can override it with a higher-priority reflex (collision avoid, opportunistic pickup, drop on delivery).
2. **Belief base must support staleness/uncertainty** (already in our plan, this slide reinforces it).
3. **Intention scoring must use a margin to be sticky** (slide rule #2).
4. **Look-ahead in scoring assumes current intention completes** (slide rule #3).
5. **Cap deliberation time** — calculative rationality says slow deliberation in a fast world = wrong action. Add a hard time budget per BDI cycle.
6. **Don't conflate plan and intention in code** — keep `plans/` as templates and a separate `Intention` class that holds the instantiated plan + state.

---

## 8. Things to AVOID (per slides)

- **Avoid pure reactive** — the slide warns reactive agents have only "short-term view," can't reason about non-local info, and don't learn. Lab 1 already showed this — we'd never beat competitors with patrol-and-grab.
- **Avoid pure logic-based** — undecidable, intractable, doesn't fit our latency budget.
- **Avoid horizontal layering with too many layers** — slide notes `m^n` interaction explosion. Our hybrid stays simple: one reactive layer + one BDI deliberative layer.
- **Avoid re-planning on every tick** (rule 2 above) — but also avoid never re-planning. The trigger-based middle ground is the design.

---

## 9. Open / TBD

- The slides reference **Jack** (a BDI implementation): Beliefs as DB, Events as goals, Plans as scripts, Intentions as running plans. Worth checking whether the course expects us to use a specific BDI framework or just structure our JS code "BDI-style." (No instruction yet — assume free choice.)
- Slide also mentions PRS, dMARS, JAM, JADEX as BDI implementations. None of these have great JS bindings for our purposes — we'll roll our own minimal BDI runtime in JS.
