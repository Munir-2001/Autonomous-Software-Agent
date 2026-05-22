# Competition Learnings — Round 1 (7/25)

Recorded after the first live multi-agent round. Source of truth for the
next iteration's tuning and strategy decisions. Not a fix list — that
comes after we agree on direction.

---

## Result

- Final position: **7/25**.
- Per-map ranking: consistently **6th–8th**, occasionally lower.
- Round length: **3–5 minutes** (varies by map).

---

## Score-shape observation (the central finding)

Our score rose **linearly** over each round. Top agents' scores rose in
**bursts** — long stretches of no score, then big jumps when they
delivered a stack of 10–20 parcels at once.

That is the difference between a *steady-trickle* strategy and a
*batch-delivery* strategy. The math favors batches:

- Each delivery trip has a fixed travel-time tax (round-trip distance).
- Delivering 1 parcel pays that tax for 1 reward.
- Delivering 10 parcels pays roughly the same tax for 10 rewards.

So per tile traveled, batching is **~5–7× more efficient**. Over 3–5 min
the compounding gap is exactly what put us at 7/25 instead of top 3.

---

## Behaviors observed in our agent

1. **Abandoned stacking around 3–4 carried.** When carrying parcels and
   a new one became visible, the agent often kept walking toward
   delivery instead of diverting. Even when a visible parcel was nearby,
   the agent ignored it — likely because the deliver-now score had
   already grown large enough to win the comparison.
2. **Linear, predictable score growth.** Frequent small deliveries
   (1–3 parcels each) instead of occasional big ones.
3. **Random-looking step interjected mid-mission.** Sometimes the agent
   takes a single step that isn't toward the current delivery or
   pickup target. Need to confirm cause — candidates: stuck-detector
   sidestep firing too eagerly, panic-mode waypoint, or transient block
   re-routing. **Open question — instrument logs next round to confirm.**
4. **No tour-while-carrying.** Once carrying, the agent goes deliver.
   It does not patrol pickup points to look for more parcels first.
5. **Linear pickup clusters under-exploited.** When pickup points are
   in a row or tight cluster, the explore plan can sweep them — but
   that mode dies after parcel #1 (we exit explore once carrying).

---

## Behaviors observed in top agents

1. **Stacks of 10–20 parcels** before any delivery commitment.
2. **Long sweeps along linear pickup-point corridors**, opportunistically
   grabbing parcels as they spawn.
3. **Few but big deliveries** — clear bursts of score growth.
4. **Counter-example: agents with no carry cap at all** appeared to
   over-collect and never deliver — they didn't outscore us. So the
   cap matters, but ours is set too low.

---

## Map-type pattern (hypothesis, needs confirmation)

| Map type | Delivery distance | Likely optimal stack | Our stack | Top stack |
|---|---|---|---|---|
| Short — delivery tiles everywhere | 2–4 | 3–5 | 3–4 | 4–5 |
| Medium | 5–8 | 6–8 | 3–4 | 7–9 |
| Long — delivery in one corner | 10+ | 8–12 | 3–5 | 10+ |

We hold our own on short-delivery maps. The 6–8 average is dragged down
by the medium- and long-delivery maps. **Open question — confirm by
logging delivery distance per round next time.**

---

## Strategic hypotheses to test next round

These are **directions, not commitments**. Each needs to be evaluated
against the next round's results before locking in.

### H1 — Stack more, but bounded

Top no-cap agents lost to top capped-stack agents. Implication: there
is an optimal cap, and ours is too low. **Hypothesis: optimal cap is
~10 on long-delivery maps, ~5 on short-delivery maps.** A static
higher cap (e.g. 10) might be a reasonable compromise; map-adaptive
would be better but harder to implement.

### H2 — Patrol-while-carrying

When carrying < cap and no visible pickup, walk toward an unvisited /
LRV spawn tile rather than committing to delivery. Only commit to
delivery when (a) cap hit, (b) decay race, or (c) a sweep yielded no
new parcels in N moves. This is the single biggest behavior change
needed to match top agents.

### H3 — Loosen chain-safe from binary to marginal

Today: pickup boost only fires if **every** carried parcel still
arrives with positive reward through the longer chain path. Once any
single old parcel fails this, the boost vanishes and pickup loses to
deliver.

Hypothesis: replace with marginal value — accept the chain pickup if
**total delivered value (with pickup) > total delivered value (without
pickup)**, even if some old parcels lose value. This is what makes
8–10 stacks possible.

### H4 — Distance-aware deliver discount

Multiply `scoreDeliverNow` by something like `1 / (1 + distance × k)`.
Long deliveries become per-parcel less attractive — pushes the agent
to stack more before committing to a far trip. Lever for handling the
medium/long-delivery maps where we currently underperform.

### H5 — Linear sweep through pickup clusters when carrying

Currently the linear-sweep bonus only fires inside the explore plan.
Extend it: when looking for the next pickup target while carrying,
also prefer paths that pass through the most spawn tiles. This is
the "pick a lot of parcels in a tight cluster, then deliver" pattern
the user identified as a likely top-agent strategy.

---

## Open questions to instrument before next round

1. **What causes the random-looking mid-mission step?** Add explicit
   logs at sidestep / panic / transient-block-replan branches so we
   can correlate user-observed jitter with code path.
2. **Per-map delivery distance.** Log distance from spawn-cluster
   centroid to nearest delivery tile so we can confirm the
   short/medium/long classification empirically.
3. **Why are visible parcels sometimes skipped?** Log every option
   ranking in a deliberation cycle (top 3 with scores) to see whether
   the visible parcel was scored low or scored high but lost to
   deliver via margin.
4. **Per-round stats.** Log final stack size at each delivery, total
   deliveries, total parcels picked, total parcels missed (visible but
   not collected). Without these we're guessing.

---

## Decision queue (before code changes)

- [ ] Confirm H2 (patrol-while-carrying) is the priority change. The
  user's instinct from the round matches the data.
- [ ] Decide static-cap value (5? 8? 10?) vs map-adaptive cap.
- [ ] Decide whether to keep `CARRIED_DECAY_FORCE_DELIVER` as the only
  hard delivery trigger or add a "long-walk-no-progress" trigger.
- [ ] Whether to add the per-cycle option-ranking log for next round.

Once H2 is in and we have one more round of data, revisit this file.
