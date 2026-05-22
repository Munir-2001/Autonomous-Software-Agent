# Slide 03 — BDI Agents (Practical Reasoning, Commitment, Reconsideration)

**Source:** "BDI agents" deck, Prof. Giorgini, ASA A.A. 2025-2026

This is the most implementation-relevant deck so far. The control loop, the formal function signatures, and the three commitment strategies map almost line-for-line to code we'll write.

---

## 1. Practical reasoning: two activities

The slides split practical reasoning into:

| Activity | What it produces | Our equivalent |
|---|---|---|
| **Deliberation** | "What state of affairs do I want to achieve?" — outputs **intentions** | `desires.js` + `intentions.js` (option generation + filter) |
| **Means-end reasoning** | "How do I achieve it?" — outputs a **plan** | `plans/` library + PDDL planner |

Both must run within a **resource budget** (slide 11) — agents cannot deliberate indefinitely. They have to commit to *some* state of affairs, even if not optimal. **This is the justification for our hybrid approach** (cheap JS scoring, fall back to PDDL only for hard subproblems, hard time budget per cycle).

---

## 2. Bratman's properties of intentions — exam-grade, copy into the report

The slides list 6 properties (Bratman 1990). Each one has a direct implementation consequence in our agent.

| # | Property (Bratman) | What it means | How we implement it |
|---|---|---|---|
| 1 | **Intentions pose problems** — agents devote resources to achieving them | Once committed, the agent must allocate compute / actions toward the intention | The active intention "owns" the next action emitted by the executor — no random walks while an intention is active. |
| 2 | **Intentions filter** other intentions — they must not conflict | New options that conflict with current intentions are pruned | In `intentions.js`, when scoring desires, drop any whose plan would invalidate the current commitment. |
| 3 | **Agents track success and retry** | If a plan fails, replan toward the same goal before abandoning | If a `goto` leg fails (collision, blocked path), keep the intention `deliver(parcel_X)` and replan a new path. Don't abandon until impossible. |
| 4 | **Agents believe their intentions are possible** | Don't commit to obviously-impossible goals | Before activating `deliver(parcel_X)`, check feasibility: parcel is reachable AND timer hasn't already expired by the time we'd arrive. |
| 5 | **Agents don't believe they will *not* achieve them** | Asymmetric: confident enough to commit, but not certain | Score-based commitment with margin (matches our slide-02 thrash-prevention). |
| 6 | **Don't intend all side-effects** (package deal problem) | "Intend f, believe f→y, doesn't mean intend y" | In Deliveroo: I intend to deliver parcel A. Side effect: I block tile (1,3) for 2 ticks. I don't *intend* to block — but I'd better account for it when planning around teammates (Part 2). |

### Bratman quote worth keeping in the report

> "My desire to play basketball this afternoon is merely a potential influencer of my conduct […] In contrast, once I intend to play basketball this afternoon, the matter is settled. I normally need not continue to weigh the pros and cons. When the afternoon arrives, I will normally just proceed to execute my intentions." — Bratman 1990

This is the philosophical justification for **commitment** — without it, every tick is a fresh deliberation and the agent never gets anything done.

---

## 3. Formal function signatures — use these names verbatim in code

The slides give crisp signatures (slides 13-15). Mirror them exactly so the report can reference them.

```
brf:    Bel × Per → Bel        // belief revision function
options: Bel × Int → Des       // option (desire) generator
filter: Bel × Des × Int → Int  // filters/picks intentions
plan:   Bel × Int × Ac → Plan  // means-end (PDDL)
```

In our project this becomes:

```js
beliefs.revise(percept)             // brf
desires.generate(beliefs, intentions)   // options
intentions.filter(beliefs, desires, intentions)  // filter
plans.compute(beliefs, intention, actions)       // plan
```

---

## 4. The control loop (slide 18) — our master loop

The slides give the canonical version:

```
Agent Control Loop Version 1
1. while true
2.   observe the world
3.   update internal world model
4.   deliberate about what intention to achieve next
5.   use means-ends reasoning to get a plan for the intention
6.   execute the plan
7. end while
```

This is the skeleton of `src/index.js`. We'll extend it with:

- **Step 2** is event-driven (Socket.IO `sensing` events), not polling.
- **Step 6** is interrupted by reactive reflexes (slide-02 hybrid layer).
- **Between steps 6 and 1** is where intention reconsideration happens — see §6.

---

## 5. Belief revision — the temperature example (slide 14)

The slide shows `brf` translating successive percepts (15 °C → 0 °C → -5 °C) into successive beliefs. The lesson: **beliefs are time-indexed**. We never overwrite blindly.

For Deliveroo:
- Each parcel/player belief carries a `lastSeen` timestamp.
- `brf` merges new percepts: positions update, rewards update, but **out-of-range entries are kept** (with their `lastSeen`) until the timer would have expired (parcels) or until contradicted (players).
- This implements the "don't delete beliefs prematurely" rule from the user's notes (14April.rtf).

---

## 6. Commitment strategies — choose one, defend it in the report

The slides walk through three strategies with concrete Deliveroo-style examples (slides 23-31). Memorize this table — it'll be on the exam *and* drives our design.

| Strategy | Definition | Behavior on world change | Verdict for Deliveroo |
|---|---|---|---|
| **Blind / Fanatical** | Maintain intention until *believed achieved*. | Keeps trying even when impossible. Slide example: tile blocked → still tries to move there → stuck. | ❌ Don't use. Deliveroo paths get blocked routinely. |
| **Single-minded** | Maintain intention until achieved OR believed *impossible*. | Replans on failure (commitment to *ends*, not *means*). Drops only when truly stuck. Slide example: blocked path → replan around it; if no path → drop. | ✅ Acceptable baseline. Matches our resilient `goto`. |
| **Open-minded** | Reconsider intentions **after every action**. Drop if a better one appears. | Slide example: while delivering pack_1, pack_2 spawns nearby → switch immediately if score advantage. | ✅✅ **Best for Deliveroo** — competitive, fast-decaying parcels, frequent state change. This is our choice. |

### What "open-minded" means in code

- After every executed action, run `options()` and `filter()` again.
- If the new top intention differs from the current one *by a significant margin*, drop and switch.
- If new intention == current intention, keep going (don't replan from scratch).

### Commitment to ends vs means (slide 25)

> "An agent has commitment both to ends and to means. If a plan goes wrong → replan, keeping the commitment."

So when a plan step fails:
- **Default action:** replan, same intention. (Don't abandon the parcel just because one move failed.)
- **Only re-deliberate the intention** if replanning fails too, or if a much better intention has appeared.

---

## 7. The reconsideration dilemma (slide 34) — and how to solve it

Direct quote from the slides:

> - An agent that does **not stop to reconsider** sufficiently often will continue attempting to achieve intentions even after they cannot be achieved.
> - An agent that **constantly reconsiders** may spend insufficient time actually working to achieve them.
>
> **Solution:** incorporate an explicit **meta-level control component** that decides whether or not to reconsider.

This is the core trade-off and the slides explicitly call out the meta-level controller as the answer.

### Bold vs cautious (Kinny & Georgeff, slide 36)

| | **Low dynamism (γ low)** | **High dynamism (γ high)** |
|---|---|---|
| **Bold** (no reconsideration) | Wins | Loses (sticks with doomed intentions) |
| **Cautious** (reconsider every step) | Loses (overhead) | Wins (catches new opportunities) |

Deliveroo is **high γ**. So we lean cautious — but we add a meta-level controller to avoid the overhead trap.

### Our meta-level reconsideration policy (concrete)

Reconsider intention iff **any** of:

1. A new parcel appeared in sensing range AND its potential score > current intention's score by margin M.
2. The current parcel disappeared from sensing for longer than `max_unseen_ticks`.
3. A move in the current plan failed AND replanning failed.
4. We arrived at the intention's target tile (intention complete).
5. Current intention's projected reward (reward − decay over remaining travel) drops below 0.

This is cheap — no full deliberation per tick — but covers the cases that matter.

---

## 8. PRS — Procedural Reasoning System (slide 37)

The slides cite PRS (Georgeff, Lansky) as the first influential BDI architecture. The key design choices we copy:

- **Plan library** of pre-written recipes — agents don't generate plans from scratch every time.
- **Plans have:**
  - **Context (precondition)** — when this plan is applicable.
  - **Goal (postcondition)** — what state it achieves.
  - **Body** — sequence of actions *and sub-goals*. (Sub-goals → recursive deliberation.)
- **Options are determined by which plans match the current beliefs.**

For Deliveroo, this means our `plans/` directory should look like:

```js
// plans/pickup.js
export const pickupPlan = {
  context: (beliefs, intention) =>
    intention.type === 'pickup' &&
    beliefs.parcels.has(intention.parcelId),
  goal: (beliefs, intention) =>
    beliefs.me.carrying.has(intention.parcelId),
  body: [
    { type: 'subgoal', name: 'goto', target: 'parcel.position' },
    { type: 'action',  name: 'pick_up' }
  ]
};
```

The control loop:
1. Active intention selects a plan from the library whose `context` matches.
2. Body is expanded — sub-goals become new (nested) intentions.
3. Actions go to the executor.

This gives us **fast reactive replanning** for known cases and a **clear extension point** for the PDDL planner (slide 39's "combining procedural and planning"):
- Plan library handles common Deliveroo cases (pickup, deliver, explore).
- PDDL planner handles the `goto` sub-goal when the path is non-trivial.

---

## 9. Goal types (Jadex, slide 48) — useful taxonomy

Jadex has four goal types. We probably only need 2-3 but the taxonomy is exam-grade:

| Goal type | Meaning | Deliveroo example |
|---|---|---|
| **Perform** (do an action) | Just do X | `perform(explore)` — wander |
| **Achieve** (reach state) | Make S true | `achieve(deliver-parcel-X)` — primary goal type for us |
| **Query** (get info) | Acquire some belief | (rarely useful in Part 1) |
| **Maintain** (sustain state) | Keep S true | `maintain(no-collision)` — what the reactive layer does |

Mapping:
- Most Deliveroo intentions are **achieve** goals.
- The reactive collision-avoidance layer is implementing a **maintain** goal.
- `explore` is a **perform** goal.

---

## 10. JACK & JADE notes (slides 40-46) — for the report's "related work" only

We're **not** using these (no JS bindings, overkill for Deliveroo), but the slides expect us to know they exist:

- **JACK** — Java extension; plans are sequences of actions; **no automated planning**; events split into external/internal/motivations; capabilities cluster reasoning elements; FIPA ACL for comms.
- **JADE** — Java multi-agent platform; FIPA-compliant; peer-to-peer comms; yellow pages discovery.
- **Jadex** — built on JADE; **explicit goal representation** with the four goal types above; goal creation/drop conditions.

In the report, mention we implement BDI from scratch in JS because the JS Deliveroo SDK is the constraint and JACK/JADE are Java-only.

---

## 11. Concrete updates to our architecture (overrides earlier notes where they conflict)

1. **Adopt open-minded commitment** with a margin-based threshold and the 5-rule meta-level reconsideration policy from §7.
2. **Function names in code** must match `brf`, `options`, `filter`, `plan` from the slides — at least as comments / module exports — so the report cleanly maps to theory.
3. **Add an `Intention` lifecycle** with explicit states: `pending → active → succeeded | failed | dropped`. Track this for replanning logic.
4. **Plans must have `context` and `goal` predicates** (PRS-style), not just bodies. The intention manager picks plans whose context matches.
5. **Goals get a type** (`achieve` / `perform` / `maintain`) — labeled in code so the report can reference Jadex.
6. **Belief revision keeps `lastSeen` timestamps** (already in our plan, this slide formalizes it as `brf: Bel × Per → Bel` — implement as a pure function, not in-place mutation).
7. **Hard time budget per BDI cycle** + meta-level controller deciding whether to deliberate this tick. Otherwise we hit the calculative-rationality trap from slide 02.

---

## 12. Things to AVOID

- **Don't use blind commitment.** Slide explicitly shows it failing on a blocked path. We will be tempted to write a "just keep retrying" loop — resist; use single-minded as the floor and open-minded as the default.
- **Don't reconsider on every tick.** Slide explicitly warns of the overhead trap. The meta-level controller decides.
- **Don't abandon the goal on first plan failure** (slide 25). Replan with the same intention first.
- **Don't conflate plans (recipes) and intentions (committed instances)** — already flagged in slide-02 notes; this deck reinforces it (PRS plan library vs running intention).
- **Don't try to import side-effect intentions** — package deal problem. Side effects are computed, not committed.

---

## 13. Open / TBD

- The slides give a single "Optimal intention reconsideration" criterion (Kinny-Georgeff) but no formula for our M (margin threshold). We'll tune empirically in M5 of the milestones.
- Slide-39 "combining procedural and planning" diagram suggests both library and planner sit between desires and intentions. Our split (library always, planner only for hard `goto`) is one choice — we should defend it in the report or revisit if the course expects planner-first.
