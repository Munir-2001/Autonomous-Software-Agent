# Session Findings — Deliveroo BDI Agent

A consolidated record of everything we built, debugged, and learned in one working session.

---

## 1. What we built

A working **hybrid BDI agent** for Deliveroo.js (UNITN ASA course):

```
ENVIRONMENT ──sensing──▶ BELIEFS (brf)
                            │
                       options(B,I)        ← desires.js
                            │
                       filter(B,D,I)       ← intentions.js (open-minded, margin)
                            │
                       plan(B,I,Ac)        ← plans/library.js (PRS-style)
                            │
                       reactive layer      ← reactive.js (Brooks subsumption)
                            │
                       executor.js         ← action emission
                            │
                            └────actions───▶ ENVIRONMENT
```

~1.4k lines of focused JavaScript. The slide notes in `slides/` (8 numbered deck summaries) trace every architectural decision back to a specific course slide.

---

## 2. Server-side discoveries (Deliveroo.js internals we read)

These are **non-obvious** facts about the game we discovered by reading the server source directly. They drove several bug fixes.

| Finding | Source | Implication |
|---|---|---|
| `ActionMutex.execute` returns `false` (not the action result) when called while another action is in progress, **and applies a penalty** | `backend/src/utils/ActionMutex.js` | If our agent emits actions back-to-back without letting the previous mutex unwind, we get phantom failures + penalties. Affected `putdown`. |
| `Controller.putDown` does `... \|\| []` after `actionMutex.execute` | `backend/src/deliveroo/Controller.js:243` | A mutex conflict on putdown → server returns `[]` to the client. We initially read this as "putdown failed" and got stuck. |
| `Controller.pickUp` and `putDown` both use `agent.xy.rounded` | `backend/src/deliveroo/Controller.js` | Even at fractional in-motion coordinates, the server uses rounded position. So our position-rounding was correct. |
| Parcel positions can be **fractional** when carried by an agent mid-move | observed in agent log: `parcel p2560 at (9.4,9)` | Carried parcels inherit the carrier's position. Our BFS lookup (integer-keyed) failed on fractional targets → we now round at ingest. |
| `Parcel.delete()` is called only on delivery tile, otherwise parcel stays | `Controller.js putDown` | Putdown anywhere succeeds; only delivery yields score. |
| Pickup response can omit `id` field on some server configs | observed in log: `Picked up 1 (Σreward=9):` with empty id list | We now synthesize `local_<tick>_<i>` IDs as fallback. |
| Sensing range is `x_offset + y_offset < 5` (Manhattan) | course slides + `IOSensing.js` | Drove our `STALE_AGENT_TICKS` decision. |

---

## 3. Major bugs found & fixed (chronological)

### Bug 1: All moves failing immediately after connect
**Cause:** the user had used the same token for the browser tab and the agent. Server treats one token = one character; both clients fight for control.
**Fix:** documented browser-setup procedure (one token per identity, incognito for second).

### Bug 2: Agent stuck behind enemy on the same tile, infinite loop
**Cause:** `planGoto` tried "BFS without enemies" first (optimistic). The first plan went straight through the enemy. Reactive vetoed but BFS produced the same plan next cycle.
**Fix:** flipped order — `planGoto` now tries **enemy-as-obstacle BFS first**, falls back only if no detour exists.

### Bug 3: "deliver loop" — putdown returning empty repeatedly
**Cause:** ActionMutex contention (see §2). `putdown` got `[]` from the server, our code interpreted as "still carrying", looped forever marking `+ deliver`/`! failure`.
**Fix:** `executor.putdown` now retries once on empty response, and resyncs `beliefs.carrying` from the server's truth if persistent (`putdown empty after retry; resyncing`).

### Bug 4: "no plan available" infinite cycling on a parcel
**Cause:** parcel position was fractional `(9.4, 9)` because another agent was carrying it mid-move. Our BFS keyed walkable tiles by integer `'9|9'`, so the lookup failed.
**Fix:** `pickupPlan.build` now (a) skips parcels carried by other agents and (b) rounds the target position. Also: parcel positions rounded at ingest in `brf`.

### Bug 5: Pickup loop — agent picks up same parcel repeatedly
**Cause:** after a successful pickup, sensing re-included the parcel with `carriedBy = me.id`. `brf` re-added it to `beliefs.parcels`. `candidateParcels` filter only excluded *others'* carried parcels, not ours. Agent generated `pickup(p_X)` over and over for a parcel it already had.
**Fix:** `candidateParcels` now skips parcels in `this.carrying`. Defensive cleanup: `brf` deletes `carriedBy === me.id` parcels from `beliefs.parcels`.

### Bug 6: Stuck-detector firing constantly, agent making no progress
**Cause:** `markBlocked` refreshed the TTL on every call, so a stationary blocker pinned the tile forever AND the count couldn't accumulate to escalation. Worse, my own stuck-detector was clearing the count on every block expiry.
**Fix:**
- `markBlocked` keeps the **earliest expiry** if existing block hasn't expired (no refresh-by-call).
- `blockMarkCount` **persists across block expiries** (only ages out after 60-tick quiet window).
- `brf` refreshes blocks based on actual enemy presence using `this.agents` (current + stale-tracked, not just current sensing) — so blockers out of sensing range still keep their block alive.

### Bug 7: Agent flip-flops between original blocked path and detour
**Cause:** when block expired (TTL=10 too short for long detours), BFS reverted to the now-clear shortest path → walked back into blocker → marked → detoured. Loop.
**Fix:**
- Lowered escalation threshold from 3 marks → **2 marks** — second hit immediately bumps TTL.
- Block TTL bumped: base 10 → **30 when carrying** (delivery urgency), escalated 30 → **60**.
- `STALE_AGENT_TICKS` extended 12 → **30** so blockers remain "remembered" during long detours, keeping their block refreshed.
- Added **no-progress detector**: if Manhattan distance to target hasn't improved in 6 cycles while an intention is active, escalate to panic mode (separate from position-based stuck detection).

### Bug 8: Lost parcel timeout → agent goes to delivery anyway
**Cause:** when a carried parcel decays to 0, `minCarriedReward()` returned 0, which triggered the `≤ CARRIED_DECAY_FORCE_DELIVER` force-deliver branch with score `1e6`. Agent walks all the way to delivery for a 0-point putdown.
**Fix:** force-deliver triggers now filter `carrying.values()` for `reward > 0` first. If nothing live is carried, no force-deliver fires; the agent picks up new parcels instead.

### Bug 9: Agent never carries more than 1 parcel (no chaining)
**Cause:** when scoring `pickup(P2)` while carrying `P1`, the score formula didn't credit `P1`'s value at delivery via the chained path. Comparison was unfair: `pickup(P2)` looked like just P2's value, while `deliver` had `P1`'s full value. Deliver always won.
**Fix:** scoring now adds `carriedAtDelivery` (sum of carried rewards minus decay across the longer pickup-then-delivery path) to the pickup score. Plus a **chain-safe boost** (`× 1.6`) when all parcels would survive the chained path with positive reward.

### Bug 10: Agent ignores nearby visible parcels
**Cause:** scoring used **delivery-time reward** (parcel.reward minus decay across pickup leg + delivery leg). For low-reward parcels far from delivery, this is 0 → not viable → ignored, even when very close to the agent.
**Fix:** for parcels within **`CLOSE_PICKUP_DISTANCE = 4`**, viability uses **pickup-time reward** instead. Even if the parcel will fully decay before delivery, grabbing it has value (denies it to competitors, contributes to chain bonus, may find a better delivery angle later). Score boosted **× 2.5**.

### Bug 11: Wrong delivery checkpoint chosen
**Cause:** `bestDelivery` used Manhattan distance, which always picked the same one in the typical x-range the agent operated in.
**Fix:** uses **BFS distance** (true walkable distance) with **congestion tie-break** (count of adjacent-tile enemies). Agent now alternates between checkpoints based on real reachability.

### Bug 12: Reactive layer didn't grab adjacent parcels
**Cause:** reactive only had pickup-on-tile reflex, not pickup-from-adjacent-tile.
**Fix:** added **reflex 2.5** — if a free uncarried parcel is on an adjacent walkable tile and not in force-deliver mode, override BDI suggestion and step onto it.

### Bug 13: Agent loops on blocker even when alternate paths visible
**Cause:** even with all the above, when **both** primary AND backup paths got blocked, BFS Tier 3 fallback would keep returning the same direct (blocked) path. And the position-based stuck detector didn't fire if the agent moved at all (1 detour tile out, 1 tile back = position changes → counter resets).
**Fix:** added **forced-explore waypoint** mechanism — when stuck panic threshold hits, `pickEscapeWaypoint` selects a tile **far from the agent and far from current enemies**, sets `beliefs.exploreOverride`. `desires.generateOptions` returns ONLY that explore option (score 1e9). The agent is forced to walk to the waypoint, re-approach delivery from a totally different position. Auto-clears on arrival.

---

## 4. Final tuning knobs ([config.js](src/config.js))

| Knob | Default | Role |
|---|---|---|
| `LAMBDA` | 0.3 | Bayesian decay rate for confidence (slide-07 §7) |
| `CONFIDENCE_THRESHOLD` | 0.25 | Drop parcels below this confidence |
| `STALE_PARCEL_TICKS` | 30 | Force-expire parcels not seen in this many ticks |
| `STALE_AGENT_TICKS` | **30** | Track enemy positions for this long after last sighting |
| `INTENTION_MARGIN` | 0.10 | New option must beat current by this margin to switch |
| `MAX_MOVE_RETRIES` | 2 | Move retries before giving up the step |
| `RETRY_DELAY_MS` | 60 | Delay between move retries |
| `DELIBERATION_BUDGET_MS` | 80 | Cap per BDI cycle (calculative-rationality, slide-02) |
| `CARRY_FORCE_DELIVER` | 3 | Force delivery at this carrying count |
| `CARRIED_DECAY_FORCE_DELIVER` | 4 | Force delivery if any live parcel will arrive ≤ this reward |
| `MIN_VIABLE_REWARD` | **1** | Minimum delivery-time reward to consider a parcel |
| `PATH_SAFETY_TILES` | **1** | Padding added to Manhattan path estimates |
| `CHAIN_SAFE_BOOST` | 1.6 | Multiplier when all parcels survive the chain |
| `CLOSE_PICKUP_DISTANCE` | **4** | Parcels within this many tiles get rush treatment |
| `CLOSE_PICKUP_BOOST` | **2.5** | Score multiplier for close parcels |
| `ENEMY_AVOID_DISTANCE` | 1 | Reactive collision-avoidance range |

Bold values changed at least once during the session as we tuned for live behavior.

---

## 5. Key learnings about agent design (lessons for the report)

1. **Server quirks dominate strategy.** The `ActionMutex` quirk (returns `false` on conflict) and the `null`-id pickup response are not in the documentation; we found them by reading the server. A robust agent must handle these.

2. **Belief revision must distinguish "we have it" from "we lost track".** A parcel staying in `beliefs.parcels` after we've picked it up creates infinite intention loops. Carrying state must be tracked separately AND filtered out of candidate generation.

3. **TTL design for transient blocks is a 3-axis problem:**
   - Long enough to commit to a detour (avoid flip-flop).
   - Short enough that recovery is fast when the world clears.
   - Refreshable by sensing (only while blocker is still there).
   We landed on: base 10 → 30 (carrying) → 60 (escalated), refreshed via `this.agents` (stale-aware), with a count-persistent escalation across expiries.

4. **BFS alone isn't enough.** When stationary blockers exist and BFS keeps finding the same shortest path, you need:
   - Multi-tier fallback (`planGoto` Tier 1/2/3).
   - Persistence across block expiries (count escalation).
   - **Forced-explore waypoint** (escape from the local optimum entirely).
   - Stuck detection that catches both "no movement" AND "no progress" cases.

5. **Scoring needs a "rush" mode for close opportunities.** Pure delivery-time scoring discards close parcels with low long-trip value. Adding pickup-time scoring as a floor (× boost) for nearby parcels matches human intuition: "it's right there, grab it."

6. **Open-minded commitment requires margins.** Per slide-03 §6, switching freely between intentions thrashes; never switching loses opportunities. The `INTENTION_MARGIN = 0.10` plus the `CHAIN_SAFE_BOOST = 1.6` together give a tunable balance between commitment and opportunism.

7. **Reactive reflexes (Brooks subsumption) save the day for opportunism.** The deliberative layer can't react fast enough to "you're standing on a parcel" or "an enemy walked into your target tile". Adjacent-parcel diversion (reflex 2.5) and drop-on-delivery (reflex 1) are essential.

---

## 6. What's intentionally not done yet

- **PDDL planner** — planning.domains HTTP solver integration. BFS is the runtime; PDDL slot reserved at [src/planner/pddl.js](src/planner/pddl.js). Course requires it for the report; we'll wire it once the BFS-based agent is competition-ready.
- **LLM agent (Part 2)** — the BDI public API was designed to double as the Part-2 tool catalog. Not yet implemented.
- **Ablation studies** — quantitative measurement of which differentiator (Bayesian decay, competitor model, chain bonus, close-pickup boost) contributes how much to the score. Needed for the report.
- **Map-specific tuning** — all defaults are reasonable for `small_two_wide`. Other maps may need different `LAMBDA` (decay rate), `CARRY_FORCE_DELIVER` cap, or `CLOSE_PICKUP_DISTANCE`.

---

## 7. Files of record

| File | Purpose |
|---|---|
| [PROJECT.md](PROJECT.md) | Full project spec from the slides |
| [KEY_TAKEAWAYS.md](KEY_TAKEAWAYS.md) | Single source of truth for design decisions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | BDI architecture details |
| [README.md](README.md) | How to run + module map |
| [slides/](slides/) | Per-deck actionable notes (01–08) |
| [src/](src/) | All agent code |
| **[SESSION_FINDINGS.md](SESSION_FINDINGS.md)** | **(this file)** Forensic record of bugs + tunings |

---

## 8. Snapshot for the report

If asked to write a one-paragraph summary of the agent for the 10-page report:

> The agent implements a hybrid BDI architecture (Bratman 1987, slides 02–03, 07) with four layers: a flat fact-based belief base with integrity constraints (per course directive — no logical deduction), an open-minded-commitment intention manager with margin-based switching, a PRS-style plan library covering pickup/deliver/goto/explore, and a Brooks-subsumption reactive layer for collision avoidance and opportunistic pickups. Path planning uses BFS over the walkable-tile graph with a 3-tier fallback (enemy-aware → enemy-permissive → ignore-stale-blocks) and a transient-block memory that persists while blockers remain in stale-tracked sensing range. Strategic differentiators include Bayesian belief decay for out-of-range parcels, a game-theoretic competitor model that predicts what rivals will rationally pursue and discounts our score accordingly (slide-07 §8), chain-safe pickup scoring that credits carried parcels' projected delivery value through the longer pickup path, close-pickup boost for nearby visible parcels, escalating block TTLs that commit to detours when the same blocker is hit twice, and a forced-explore waypoint mechanism that breaks deadlocks by sending the agent far across the map to re-approach delivery from a different angle. PDDL integration and an LLM-coordinated second agent (Part 2) are scaffolded but not yet implemented.
