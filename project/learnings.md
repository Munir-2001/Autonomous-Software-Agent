# Competition Learnings — Round 1 (10/29)

Recorded after the first live multi-agent round (5 May 2026, Challenge 1).
Source of truth for the round-2 plan. Updated after reading the official
leaderboard and rules PDFs.

---

## Actual result (corrected from initial estimate)

- **Final position: 10th out of 29 teams.**
- **Final score: 24 points.**
- Round 1 had **10 maps**. Points per map: 10 → 1 to top-10 finishers,
  blank/0 for 11th and below. Final = sum across maps.

Per-map breakdown for MI6 (point → placement):

| Map | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| MI6 | — | — | 5 (6th) | 6 (5th) | 4 (7th) | 3 (8th) | 1 (10th) | — | 5 (6th) | — |

- **Best**: map 4 — 5th place
- **Worst**: map 7 — 10th place (1 point, last scoring slot)
- **Zero-rounds (failed to place top 10)**: maps 1, 2, 8, 10 — four out of ten.

---

## The "rule violation" hypothesis is FALSE

The rules PDF says exactly three things:

1. One agent per group.
2. 10 rounds (maps).
3. Top-10 placement per round earns 10→1 points; final = sum.

**There is no "rule violation → no mark" mechanic.** Our four zero-rounds
were simply 11th-place-or-worse finishes (or disconnects). The
directional-tile fix from round 1 was correctness, not a "no-mark bug"
fix.

---

## Leaderboard tiers

| Tier | Range | Examples | What separates them |
|---|---|---|---|
| 1 (winner) | 79 | agent_007 | Six 10s + one 8 — *dominated*, scored top-3 on almost every map. Distinct strategy. |
| 2 | 58–61 | ORA CONSEGNO IO, DeliveryNotFound | Consistent top-3 placements; rarely below 5th. |
| 3 | 32–53 | filobus, Magnagatti, French, Dalla A alla T | Solid middle-pack; scored in most rounds. |
| 4 (us) | 24–26 | MI6, davide², JustEat | Scored in some rounds, missed several. |
| 5 | 0–19 | many | Scored once or twice or never. |

**Most impactful gap to close: we lost 4 entire rounds.** Even placing
10th in each missing round would have lifted us to 28 (8th place
overall). Placing 5th in each would have put us at 48 (5th overall).

---

## Score-shape observation

On the rounds we *did* score, our score rose **linearly** — many small
deliveries (1–3 parcels). Top agents' scores rose in **bursts**: long
silence, then big jumps from delivering 10–20 parcels at once.

Per tile traveled, batching is ~5–7× more efficient than the
steady-trickle pattern. In a 3–5 min round this compounding gap is what
keeps us tier 4 instead of tier 1–2.

---

## Behaviors observed in our agent

1. **Hard cap on stacking around 3–4 carried.** Once the deliver-now
   score grew large, the agent committed to delivery even when fresh
   parcels were visible. The cap was implemented (CARRY_FORCE_DELIVER =
   5 in current code) AND emergent from how the deliver score scales
   linearly with carried-sum.

2. **No batch-then-deliver behavior.** We deliver as soon as the
   deliver score wins the comparison; we do not patrol pickup points
   while carrying, even when delivery is far and parcels are sparse.

3. **Linear, predictable score growth.** Frequent small deliveries
   instead of occasional big ones.

4. **Random-looking step interjected mid-mission.** Sometimes the
   agent takes a step that isn't toward the current pickup / delivery
   target. Candidates: stuck-detector sidestep, panic waypoint,
   transient-block replan. **Open — instrument next round to confirm.**

5. **Visible parcels sometimes skipped.** When carrying ≥3, a visible
   parcel within sensing range can fail to win over deliver, especially
   if chain-safe (`allCarriedSurviveChain`) breaks because one old
   carried parcel projects to zero on the longer chain path.

6. **Linear / clustered pickup points under-exploited.** Linear-sweep
   logic exists but only fires inside the explore plan — once we're
   carrying, it doesn't influence target selection.

7. **No "global map situation awareness".** The agent does not reason
   about *the overall layout* relative to what it has seen — e.g.,
   "drop-off is in the corner, spawn cluster is near me, therefore
   collect more before committing to the long delivery trip." Decisions
   are local per-cycle on current scores. This is probably the biggest
   architectural gap behind tier 4 vs tier 1.

---

## Possible rule-correctness issue: directional tile EXIT

On maps with arrow tiles (`↑`, `↓`, `←`, `→`), the open-source backend's
`allowsExitInDirection` has an early `return true;` — exit unrestricted,
only entry is gated. We currently honor the entry rule (good).

**But the live competition server may run a different version where
exit IS restricted** (must move in the arrow direction when standing on
a directional tile). If true, on maps with many arrow tiles our BFS
plans some moves the server then rejects → penalty accumulation →
silent kick → blank-round result. This is the most likely explanation
for at least one of our four zero-rounds.

**Verify**: cross-check live-server behavior on a small arrow-heavy
map and watch for hidden penalty accumulation. If confirmed, add the
exit-direction restriction to our BFS expansion the same way we did
for entry.

---

## Map-type pattern (hypothesis, not yet confirmed)

| Map type | Delivery distance | Optimal stack | Our stack | Top stack |
|---|---|---|---|---|
| Short — delivery tiles everywhere | 2–4 | 3–5 | 3–4 ✓ | 4–5 |
| Medium | 5–8 | 6–8 | 3–4 ✗ | 7–9 |
| Long — delivery in one corner | 10+ | 8–12 | 3–5 ✗✗ | 10+ |

We hold our own on short-delivery maps. The 6–8th avg is dragged down
by medium and long-delivery maps where batching matters most.
**Open — log delivery distance per round next time.**

---

## Strategic hypotheses to test next round

Directions, not commitments. Each evaluated against round-2 results.

### TOP PRIORITY — H0: eliminate zero-rounds

The 4 missed rounds cost more than any single tuning change can buy
back. Two sub-tasks:

- **H0a — directional EXIT rule**: implement and test on an arrow-heavy
  map. If the live server enforces it, this alone may unblock 1–2
  rounds.
- **H0b — robustness telemetry**: log every disconnect, penalty
  accumulation, and "no plan found" event with map id, so we can
  pinpoint why specific maps fail.

### H1 — Stack more, but bounded

Top no-cap agents lost to top capped-stack agents. Optimal cap is map-
dependent: ~5 short-delivery, ~10 long-delivery. Static ~10 is a
reasonable first step; map-adaptive is the eventual right answer.

### H2 — Patrol while carrying

When `carrying < cap` AND no visible pickup AND not in decay race,
walk toward an LRV spawn tile instead of delivering. Only commit to
delivery when (a) cap hit, (b) decay race, or (c) a sweep yielded
no new parcels in N moves. **Biggest single behavior change to match
top agents.**

### H3 — Loosen chain-safe from binary to marginal

Replace all-or-nothing `allCarriedSurviveChain` with marginal-value
test: accept the chain pickup iff *total delivered value (with
pickup) > total delivered value (without pickup)*, even if some old
parcels lose value. Unlocks stacks past 4.

### H4 — Distance-aware deliver discount

Multiply `scoreDeliverNow` by `1 / (1 + distance × k)` so long
delivery trips become per-parcel less attractive. Specifically targets
the medium- and long-delivery maps where we currently underperform.

### H5 — Linear sweep through pickup clusters while carrying

Extend the existing linear-sweep bonus so it also influences target
selection during the deliver-or-pickup decision, not just during
explore. The "pick up many parcels in a tight cluster, then deliver"
pattern needs this.

### H6 — Global map situation awareness (architectural)

Build an internal map model from sensing that tracks:

- Spawn-cluster centroid and density per region.
- Delivery-tile positions and which spawn clusters they serve.
- Rough "distance to nearest delivery" per spawn cluster.

Use this in the deliver/pickup decision: if the current spawn cluster
is "far from any delivery and densely packed with spawns," prefer to
stack more. If "close to delivery and spawns are sparse," deliver
sooner.

This is the *qualitative* gap behind tier 4 → tier 1. Bigger lift than
H1–H5 combined, but also a bigger refactor.

---

## Open questions to instrument before round 2

1. **What causes the random-looking mid-mission step?** Explicit logs
   at sidestep / panic / transient-block-replan branches.
2. **Per-map delivery distance.** Log spawn-centroid → nearest-delivery
   distance per round.
3. **Why are visible parcels sometimes skipped?** Log every option
   ranking in a deliberation cycle (top 3 with scores + winner) so we
   can see whether the parcel was scored low or scored high but lost
   to deliver on margin.
4. **Per-round stats.** Final stack size per delivery, deliveries
   count, parcels seen-but-missed, total penalty accumulated.
5. **Are we being silently penalty-kicked?** Log every penalty change
   so we can detect a slow drift toward -1000.

---

## Decision queue (before code changes)

- [ ] **Confirm H0a is the first item to ship.** A correctness fix
  for directional-exit (if live server enforces it) plausibly turns
  one or two zero-rounds into ≥1 point each.
- [ ] Decide on telemetry depth (H0b + open questions 1–5). Pick
  bare-minimum logs vs full instrumentation.
- [ ] Decide H1's static cap value (5? 8? 10?) vs deferring to map-
  adaptive in H6.
- [ ] Whether H6 (global map awareness) is in scope for round 2 or
  deferred to round 3. Big lift, big payoff.
- [ ] Ordering: H0a → instrument → H3 + H2 + H1 → measure → H4 →
  H6. Adjust based on what round 2 reveals.
