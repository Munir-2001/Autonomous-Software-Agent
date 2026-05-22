# Slide 07 — Belief Revision + Implementing the BDI Control Loop

**Source:** "Beliefs representation and management" + "Implementing the BDI Control Loop" decks, Prof. Giorgini, ASA A.A. 2025-2026.

This is the single most implementation-relevant deck so far. Two huge things:

1. **An explicit course directive:** *"For the project, we do NOT use logical deduction. We only use facts and integrity constraints."* This overrides any earlier note that hinted at theorem-proving.
2. **Concrete, Deliveroo-specific belief-revision math** (Bayesian decay + competitor modeling) that we can implement directly.

---

## 1. Course directive — facts + integrity constraints, NOT deduction

Direct quote from the final slide of the belief-revision deck:

> "For the project, we do **not** use logical deduction.
> `B = {α, α ⊢ β}` means also that `β ∈ B` — we don't do this.
> We only use **facts (true/false)** and **environmental constraints** (integrity constraints like a DB)."
>
> Example:
> - **fact:** `t: In(Ag_1, 1, 2)`
> - **constraint:** `t: In(Ag_1, 1, 2) → t+1: In(Ag_1, 1, 2) ∨ In(Ag_1, 1, 1) ∨ In(Ag_1, 2, 2)`

### What this means concretely

- Our belief base is a **flat collection of facts**, each timestamped.
- We don't run a theorem prover or compute logical closure.
- We **do** validate beliefs against integrity constraints (like a DB):
  - "An agent cannot move >1 tile per tick."
  - "A parcel cannot teleport."
  - "Walls cannot move."
- When new sensor data **violates** a constraint relative to existing beliefs → it's an inconsistency, and we apply our resolution policy.

### Implementation shape

```js
// beliefs.js
const facts = {
  agents: new Map(),     // id → { x, y, score, lastSeen, ...}
  parcels: new Map(),    // id → { x, y, reward, lastSeen, ...}
  me: { x, y, score, carrying },
  map: { ... }           // immutable after first sensing
};

const constraints = [
  // Movement constraint
  (prev, next) => manhattan(prev.pos, next.pos) <= 1,
  // Parcel-teleport constraint
  (prev, next, type) => type !== 'parcel' || sameOrAdjacent(prev, next),
  // Wall-immutability constraint
  (prev, next, tile) => tile.type !== '0' || sameTile(prev, next)
];
```

This is **simpler** than what we had in the architecture doc (no derived beliefs, no closure). Win.

---

## 2. Updates vs Revisions (Katsuno & Mendelzon 1992)

The slide makes a distinction we should reflect in code:

| | Revision | Update |
|---|---|---|
| **World** | Static | Changed |
| **What's wrong** | Our prior belief was incorrect | Our prior belief was correct *for then*, but world has moved on |
| **Trigger** | New info corrects misperception | New info describes a change |

For Deliveroo:
- **Update** is the dominant case (world changes every tick — agents move, parcels decay).
- **Revision** kicks in when sensor data contradicts what we thought (e.g., we believed parcel P was at (2,4); we sense (2,4) and it's not there).

### Implementation
- Default behavior: **update** — apply new sensing as the new state, keep timestamps.
- **Revision** is a special case triggered when a sensing event directly contradicts a current belief (we're at the tile and the parcel isn't). In that case, we don't just overwrite — we may need to mark the belief as "actively confirmed missing" rather than "stale."

The user's notes (14April.rtf) — "if I don't get the package, the package may have been picked up by another agent" — is exactly the **revision** case.

---

## 3. Preservation principle (slide 4)

> If new info φ is **compatible** with current beliefs B, then **all of B is retained** (B ⊆ B*φ).

In code: belief updates are **additive when consistent**. We only drop or modify beliefs when new info contradicts them. No gratuitous deletion.

This formalizes our "don't delete beliefs prematurely" rule (carried over from slide 01 / user's notes).

---

## 4. Three methodological design questions (the slide asks; we answer)

| Q | Our answer |
|---|---|
| **How are beliefs represented?** | Flat facts indexed by entity (agents, parcels, me, map) with timestamps. No rule base, no inference engine. |
| **Relation between explicit and implicit beliefs?** | All beliefs are explicit. Anything "derived" (e.g., parcel decay) is *recomputed on demand*, not stored as a fact. |
| **How to choose what to retract?** | **Minimal-change principle** for revisions: prefer the explanation that requires changing the fewest other facts. Backed by integrity constraints to prune impossible alternatives. |

---

## 5. Belief models (slide on "Beliefs models") — pick the right one per entity

The slide lists three:

| Model | Use it for |
|---|---|
| **No memory** | Things that change every tick anyway (e.g., own current position — always overwrite from sensing). |
| **With memory (keep old true beliefs not yet updated)** | Map tiles (immutable), recent agent positions (decay-based stale check). |
| **With uncertainty (probabilistic)** | Out-of-range parcels and agents — see §6 below. |

Per-entity choice:

| Entity | Model | Why |
|---|---|---|
| `me` | No memory | We always know our current state from sensing. |
| `map` | With memory (immutable) | Sent once on connect; never changes. |
| Visible parcels | No memory | Sensor is authoritative. |
| Out-of-range parcels | With uncertainty | Don't know if still there → Bayesian decay. |
| Visible agents | No memory | Sensor is authoritative. |
| Out-of-range agents | With memory (decaying confidence) | Last-seen + inferred velocity. |

---

## 6. Bayesian belief revision — the formula we implement

The slide walks through a concrete Deliveroo example. Adopt the math directly.

### Scenario
- Agent A2 saw parcel P1 at (2,4) at t=1 with confidence 0.9.
- At t=2, P1 is out of A2's view. A2 knows other agents may have picked it up.
- At t=3, agent A1 enters the area and broadcasts "did not see P1."

### Update rule

```
P(P1@2,4 | ¬Seen) = P(¬Seen | P1@2,4) × P(P1@2,4) / P(¬Seen)
```

Slide assumes:
- If P1 is at (2,4) → A1 has 80% chance of seeing it → P(¬Seen | P1@2,4) = 0.2
- If P1 is NOT at (2,4) → P(¬Seen | ¬P1@2,4) = 1.0

Computation:
```
P(P1@2,4 | ¬Seen) = (0.5 × 0.2) / (0.5 × 0.2 + 0.5 × 1.0) = 0.167
```

Confidence drops below threshold (0.3) → A2 stops considering P1 as a target.

### What we implement

A **belief-confidence field** on every "stale" entity:

```js
parcel = {
  id,
  x, y,
  reward,           // local-decayed timer
  lastSeenAt,
  confidence,       // ∈ [0, 1] — initialized at 1.0 on direct sighting
  lastUpdate
};
```

**Update events:**
- Direct sighting → `confidence = 1.0`, refresh fields.
- Tick passes without sighting (in-range) → contradiction → `confidence = 0` (parcel gone).
- Tick passes without sighting (out-of-range) → apply decay (see §7).
- Other agent reports "didn't see" → Bayesian update (formula above).

**Decision rule:** the intention scorer multiplies `expectedReward × confidence × P(reachable)`. If `confidence < THRESHOLD` (e.g., 0.3), drop from candidates.

---

## 7. Belief estimation under uncertainty — decay + competitor risk

The slide provides explicit formulas. Implement them.

### Decay function (uncertainty grows with distance from us)

```
D(d) = e^(-λ × d)
```

- `d` = Manhattan distance from us to the believed parcel location.
- `λ` = decay constant (slide uses 0.3).
- Interpretation: the farther the parcel, the more time has passed since we could have observed it → lower confidence it's still there.

### Risk function (other agent might steal it)

```
R = e^(-λ × d_other)
```

- `d_other` = Manhattan distance from competing agent to parcel.
- Interpretation: closer competitor = higher chance they grabbed it.

### Combined belief

```
P(parcel still available) = D(d_self) × (1 − R(d_other))
```

For a parcel at distance 3 from us, distance 2 from competitor, λ=0.3:
- D = e^(-0.9) ≈ 0.406
- R = e^(-0.6) ≈ 0.549
- Belief = 0.406 × (1 − 0.549) ≈ 0.183

### Expected Value scoring

```
EV(parcel) = P(available) × reward
```

Pick the parcel with highest EV — accounts for both "still there" and "worth getting."

---

## 8. Game-theoretic competitor modeling (the second worked example)

The slide goes a step further — model the competitor's *rational choice*.

If competitor A1 has multiple parcels in its decision space, A1 will likely pick the one with highest EV (from A1's perspective).

```
P(A1 → P_i) = EV_A1(P_i) / Σ EV_A1(P_k)
```

Then A2's belief becomes:
```
P(P_i still there) = D(d_self) × (1 − P(A1 → P_i) × D(d_other))
```

### Why this matters for winning

This is **the** strategic differentiator. Most lab agents:
- See a parcel → go for the closest one.

A competent agent:
- Models which parcels the competitor will go for.
- **Picks the parcel the competitor is least likely to chase.**

Even when a parcel is "closer" to a competitor, if both parcels' EVs make the competitor likely to ignore one of them, we should target the one the competitor will ignore.

### Implementation

```js
function expectedValueWithCompetition(parcels, me, competitor) {
  // First pass: compute competitor's likely choice
  const evForCompetitor = parcels.map(p => ({
    p,
    ev: parcelReward(p) * decay(manhattan(competitor.pos, p.pos))
  }));
  const totalEvComp = sum(evForCompetitor.map(x => x.ev));
  const probCompetitorTargets = evForCompetitor.map(x => ({
    p: x.p, prob: x.ev / totalEvComp
  }));

  // Second pass: my EV adjusted for competitor
  return parcels.map(p => {
    const dSelf  = manhattan(me.pos, p.pos);
    const dOther = manhattan(competitor.pos, p.pos);
    const compProb = probCompetitorTargets.find(x => x.p.id === p.id).prob;
    const decaySelf  = Math.exp(-LAMBDA * dSelf);
    const decayOther = Math.exp(-LAMBDA * dOther);
    const pStillThere = decaySelf * (1 - compProb * decayOther);
    return {
      p,
      ev: pStillThere * parcelReward(p)
    };
  });
}
```

This goes directly into our intention scorer.

---

## 9. The BDI control loop — concrete walkthrough (BDI deck, slides on t=0..t=9)

The slide gives us the canonical 5-step loop with a worked Deliveroo example. Adopt it as the reference implementation.

```
Given a set of beliefs B:
  1. Decide about possible intentions to adopt          → Options(B, I) → O
  2. Select new intentions to adopt                     → Select(B, I, O) → S
  3. Revise the Intention set I                         → I_revision(B, I, S) → I
  4. Revise and/or select new plans P for I             → planning(B, I, P) → P
  5. Execute plans
```

### Intention rules — concrete pattern from the slide

```
if (carry(Pck) ∧ del_zone(X, Y)) { O += in(Pck, X, Y) }
```

Read: "if I am carrying parcel `Pck` and `(X, Y)` is a delivery zone, then I should add the option of bringing `Pck` to `(X, Y)`."

Generalized: each intention rule is `(condition on beliefs) → (option to add to O)`.

For Deliveroo, our intention rules:

| Rule | Triggers option |
|---|---|
| `parcel_visible(P) ∧ ¬carrying(P)` | `pickup(P)` |
| `carrying(P) ∧ delivery_zone(X,Y)` | `deliver_to(P, X, Y)` |
| `carrying_count() ≥ MAX_CARRY` ∨ `nearest_delivery_decay > THRESH` | `goto_delivery()` (force return) |
| `no_visible_parcels` | `explore()` |

Each rule maps to a constructor for an Option object.

### Plan failure handling — straight from the slide

When `move(UP)` fails because of a block at the target tile, the plan is no longer sound. The slide shows:
```
Re-Planning: P = planning(B, I, P) → P = {} (no valid plan for current intention)
```

Then: re-deliberate (intention may need to drop if no path exists at all).

This matches our slide-03 "commitment to ends, not means" — keep the intention, replan; only drop if no plan exists.

### Schizophrenic vs opportunistic (slide on "Order and timing")

Direct quote: *"checking beliefs at any decision point may bring the agent to a schizophrenic behaviour but it could be useful to have agents that are opportunistic."*

For Deliveroo, **opportunistic > stable** — high γ environment. Check at every decision point but use the **margin threshold + meta-level controller** from slide-03 to prevent thrashing.

---

## 10. Multiple intentions — scheduling (slide on intention revision)

The slide shows intentions can run **sequential (with priority)** or **parallel**. For Deliveroo, only sequential makes sense (a single agent does one thing at a time).

### Intention-set revision example from the slide

At t=2, A2 has `I = {in(pack_1, 0, 2)}` and now sees pack_2 and pack_3. New options trigger:

```
S = {pickup(pack_2), pickup(pack_3)}
```

Now we have to **schedule**. Possible orders:
- `[in(pack_1,0,2), pickup(pack_2), pickup(pack_3)]`
- `[pickup(pack_2), in(pack_1,0,2), pickup(pack_3)]`
- `[pickup(pack_3), in(pack_1,0,2), pickup(pack_2)]`
- ...

**Re-planning is always needed when the intention set changes.**

### Implementation

The intention queue is **ordered by total expected score**, computed by simulating each order:

```
score_order = Σ ( EV(intention_k) × Π_{j<k} P(still_feasible_after_j) )
```

The order with the highest projected total wins. Heuristic shortcut: greedy nearest-first when reward differences are small.

---

## 11. Inconsistent options (the "options conflict with intention" example)

The slide shows: at t=2, current intention is `in(pack_1, 4, 4)` (deliver to far corner) and new option is `in(pack_1, 0, 2)` (deliver to near corner).

These are mutually exclusive (same parcel, different deliveries). Resolution:
- Pick one based on EV.
- Drop the other.

This is **Bratman's intention-as-filter** (slide-03) made concrete: filter out options that conflict with the better-scored intention; keep the rest as candidates.

---

## 12. Moving obstacles (slide on moving blocks)

Three strategies listed:

| Strategy | Description | Verdict for us |
|---|---|---|
| **Treat as permanent** | Plan around it as if it'll never move | Safe but pessimistic. Wastes opportunities. |
| **Probability-of-trajectory model** | Predict where the obstacle will be; plan based on collision probability | ✅ Our pick. |
| **Other (game theory, stay-away)** | Avoid contested zones | Useful as fallback. |

### The probability calculation (from the slide)

If competing agent A2 can equally move to one of 5 options (UP, DOWN, LEFT, RIGHT, stay), then for our plan P1:
```
P(A2 blocks P1) = P(A2 moves into our path) + P(A2 stays in our path)
                = 1/5 + 1/5 = 0.4
```

When we have multiple candidate plans, score them by `P(plan stays sound)` and pick the best.

### Implementation

For each candidate plan:
1. Identify "contested tiles" (tiles in the plan that another agent could occupy in the relevant ticks).
2. For each contested tile, compute `P(competitor_at_tile_t)` from competitor's possible moves.
3. Plan score = `Π over plan steps of (1 - P(contest at step))`.

Simple and cheap. Doesn't require a full game-theory solver.

---

## 13. Introspection and beliefs about other agents

Slides cover both:
- **Introspective beliefs** — "do I believe I intend G?" — useful for self-consistent reasoning.
- **Beliefs about other agents' beliefs/intentions/plans** — for coordination, prediction, competition.

For Part 1 (single competing agent):
- Introspection: lightweight. Track our own intention queue, expose it via API.
- Other agents: **belief about their intentions** is what enables the competitor model in §8. We don't need to fully model their plans; we just need to predict their next likely target.

For Part 2 (multi-agent coordination): the LLM agent handles richer modeling of the other (cooperating) agent — beliefs about beliefs, etc.

---

## 14. The "consequences" problem (final slide)

> If the agent intends α and α ⊢ β (β is a derived intention), and we drop α, do we drop β?
>
> Example: intend `in(pack_1, 0, 2)` (deliver pack_1 to delivery zone). Derived: `carry(pack_1)` (must be carrying it). Drop the deliver intention. Do we drop the carry?

**Answer:** distinguish **derived from non-derived intentions** in the intention store. When a parent intention drops, derived intentions drop too **unless** they are independently justified.

### Implementation

```js
class Intention {
  id;
  type;            // 'pickup' | 'deliver' | 'goto' | 'explore'
  parentId;        // null if user-level; otherwise derived from parent
  derived;         // boolean
  ...
}
```

When dropping intention I:
1. Find children where `parentId === I.id`.
2. For each child: drop unless another non-dropped intention also requires it.

Concretely: if we drop `deliver(pack_1)`, we drop `pickup(pack_1)` *unless* there's some other intention that needs us to be carrying pack_1.

---

## 15. The full architecture diagram (slide near end of BDI deck)

The slide gives a clean architecture view we should mirror:

```
                ┌────────────────┐
                │  Environment   │
                └───┬────────┬───┘
                Perception  Action
                    │        │
                    ▼        │
              ┌──────────┐   │
              │ Beliefs  │   │
              └────┬─────┘   │
                   │         │
              Options &      │
              Filtering      │
                   │         │
                   ▼         │
              ┌──────────┐   │
              │Intentions│   │
              └────┬─────┘   │
                   │         │
              Plan library + │
                  Planner    │
                   │         │
                   ▼         │
              ┌──────────┐   │
              │  Plans   │───┘
              └──────────┘

   Introspection arrows go between Beliefs ↔ Intentions
   Plan failure → Archive → re-deliberation
   Revision arrows on every box
```

This becomes the **architecture diagram in our final report**.

---

## 16. Locked-in implementation decisions (synthesizes everything above)

1. **Belief base = flat fact store + integrity constraints**, no theorem prover (course directive).
2. **Per-entity belief models:** no-memory for sensed, with-memory for static, with-uncertainty for out-of-range.
3. **Confidence field** on every belief, in [0,1].
4. **Bayesian decay** for out-of-range parcels with `D(d) = e^(-λd)`.
5. **Competitor risk model** with `R(d_other)` and combined belief `D × (1 − R)`.
6. **Game-theoretic competitor prediction** — score parcels with `P(competitor_targets_p)` factored in.
7. **5-step BDI loop** (Options → Select → Revise I → Plan → Execute) implemented per the slide's pseudocode.
8. **Intention rules** as `(belief condition) → (option)` mappings.
9. **Sequential intention scheduling** (no parallel intentions). Order by total expected score.
10. **Moving obstacles modeled probabilistically** — score plans by `P(plan stays sound)`.
11. **Derived vs non-derived intentions** explicitly tracked; cascade drops correctly.
12. **Re-deliberate at every decision point** but use margin threshold + meta-level controller to prevent thrashing.
13. **Update vs Revision distinction** — default is update; revision only on direct contradiction.

---

## 17. Things to AVOID

- **Don't run logical deduction over the belief base.** Course directive — keep it flat.
- **Don't delete beliefs gratuitously.** Preservation principle: only retract on contradiction.
- **Don't ignore the competitor.** A non-game-theoretic agent loses to one that models its rival.
- **Don't use a single belief model for all entities.** Pick per-entity.
- **Don't run `select()` and `plan()` on every tick without throttling** — meta-level controller from slide-03 still applies.
- **Don't conflate derived intentions with parent intentions** — the consequences problem is real.

---

## 18. Open / TBD

- **Decay constant λ** — slide uses 0.3 as illustration. Tune empirically per map.
- **Confidence threshold** — slide uses 0.3 as cutoff. Tune.
- **How many competitor agents to model?** Slide examples have 1. With 3+ competitors, the game-theoretic step becomes more expensive. Decide whether to model them individually or aggregated.
- **Bayesian update with multiple "no-see" reports** — needs prior choice and update mechanics. Probably fine to use the simple form from §6 and iterate per report.
