// Desires (option generation): given current beliefs and intentions, generate
// the set of candidate options the agent could pursue.
//
// Slide-07 §9: intention rules of the form
//     if (belief condition) then add option
// Slide-03 §4 signature: options(B, I) -> D
//
// In Deliveroo:
//   - For each visible/tracked uncarried parcel: option `pickup(parcel)`
//   - When carrying: option `deliver` to nearest delivery tile
//   - When carry-cap or decay-pressure: forced `deliver`
//   - When no parcels known: option `explore`

import { CONFIG } from './config.js';
import { rankParcels, scoreDeliverNow } from './scoring.js';
import { manhattan } from './utils/geometry.js';
import { getPolicy } from './shared/policy-reader.js';

/**
 * Generate the set of options.
 * Options are returned ranked (best first), so filter() can pick top-N.
 */
export function generateOptions(beliefs) {
  // Forced-explore override: set by the control loop's panic-mode when
  // the agent gets persistently stuck. Send it to a far waypoint to
  // approach delivery from a new direction.
  if (beliefs.exploreOverride) {
    const me = beliefs.myTile();
    const tgt = beliefs.exploreOverride;
    if (me.x === tgt.x && me.y === tgt.y) {
      beliefs.exploreOverride = null;          // arrived
    } else {
      return [{
        type: 'explore',
        score: 1e9,                            // outranks everything
        meta: { target: tgt, override: true },
      }];
    }
  }

  const options = [];

  const carrying = beliefs.carriedCount();
  const ranked = rankParcels(beliefs);

  // Pickup options for each viable parcel.
  for (const r of ranked) {
    options.push({
      type: 'pickup',
      parcelId: r.parcelId,
      score: r.score,
      meta: {
        pickupDistance: r.pickupDistance,
        deliverDistance: r.deliverDistance,
        deliveryTile: r.deliveryTile,
        deliveryReward: r.deliveryReward,
        pAvailable: r.pAvailable,
      },
    });
  }

  // Spawn-anticipation options: race to a spawning tile JUST BEFORE a
  // parcel materializes there. Beats reactive competitors who wait to
  // see a parcel before reacting.
  //
  // Score = expected reward × (we'll arrive in time?) — only emit if
  // we can plausibly reach the tile by the predicted spawn tick.
  const me = beliefs.myTile();
  const upcoming = beliefs.upcomingSpawns(30);
  for (const s of upcoming) {
    const dist = manhattan(me, s);
    // We need to be there by spawn time. Slack = 2 ticks tolerance.
    if (dist > s.etaTicks + 2) continue;
    // Synthetic option: treat as an explore-style goto with positive
    // expected reward. Use a conservative reward estimate (default
    // average of seen parcels — can be tuned).
    const expectedReward = 8;
    const score = expectedReward * 0.7;     // 0.7 = baseline confidence
    options.push({
      type: 'explore',
      score,
      meta: {
        target: { x: s.x, y: s.y },
        spawnAnticipation: true,
        etaTicks: s.etaTicks,
      },
    });
  }

  // Level-2 policy override: requiredStackSize.
  // Mission: "deliver stacks of exactly N parcels". The LLM has
  // written this into the policy file. We honor it by:
  //   1) Suppressing the normal deliver option until carrying === N
  //      (so the agent keeps collecting).
  //   2) Suppressing the decay-race force when carrying < N (so we
  //      don't deliver too early). Capacity force still applies as
  //      a safety valve (we can't carry infinity).
  const requiredStackSize = getPolicy('requiredStackSize');
  // `>=` not `===` so an accidental overshoot doesn't deadlock the
  // agent. The LLM should clear/adjust the policy once the mission
  // is satisfied; until then we deliver as soon as we have enough.
  const stackComplete = requiredStackSize == null || carrying >= requiredStackSize;

  // Deliver option (only if carrying AND policy allows).
  if (carrying > 0 && stackComplete) {
    const dn = scoreDeliverNow(beliefs);
    if (dn && dn.viable) {
      // Pickup-density damper: while there are still several viable
      // pickup options visible nearby, soften the deliver score so the
      // agent keeps collecting instead of leaving early. The hard
      // force-deliver triggers below (capacity, decay-race) bypass this
      // damper via the +1e6 priority bump, so delivery is still
      // guaranteed when it actually matters.
      //
      //   ≥3 visible pickups → 0.55× deliver score (collect aggressively)
      //   2  visible pickups → 0.75× deliver score (mild damper)
      //   ≤1 visible pickup  → 1.00× (normal — single chain decision)
      const viablePickupCount = ranked.length;
      let damper = 1.0;
      if (viablePickupCount >= 3) damper = 0.55;
      else if (viablePickupCount === 2) damper = 0.75;

      options.push({
        type: 'deliver',
        score: dn.score * damper,
        meta: {
          deliveryTile: dn.deliveryTile,
          distance: dn.distance,
          rawScore: dn.score,
          damper,
          visiblePickups: viablePickupCount,
        },
      });
    }

    // Force-deliver triggers (priority-bump the deliver option). Only
    // LIVE carried parcels (reward > 0) count — once a parcel has decayed
    // to zero it's a worthless ghost and shouldn't drag us back to a
    // delivery tile. We can drop the ghost on the way out next time we
    // happen to pass through delivery.
    //   1) Capacity: live-carrying ≥ CARRY_FORCE_DELIVER parcels.
    //   2) Decay race: any live carried parcel would arrive at delivery
    //      with reward at or below CARRIED_DECAY_FORCE_DELIVER.
    const liveCarried = [...beliefs.carrying.values()].filter((c) => c.reward > 0);
    let force = false;
    let forceReason = '';
    if (liveCarried.length >= CONFIG.CARRY_FORCE_DELIVER) {
      force = true;
      forceReason = `cap(${liveCarried.length})`;
    } else if (dn && liveCarried.length > 0) {
      const decayPerStep = beliefs.parcelDecayPerTick ?? 1;
      const reserve = decayPerStep * dn.distance + CONFIG.CARRIED_DECAY_FORCE_DELIVER;
      for (const c of liveCarried) {
        if (c.reward <= reserve) {
          force = true;
          forceReason = `parcel ${c.id} decay`;
          break;
        }
      }
    }

    if (force && dn && dn.deliveryTile) {
      options.push({
        type: 'deliver',
        score: (dn.score || 0) + 1e6, // priority bump
        meta: { deliveryTile: dn.deliveryTile, forced: true, forceReason },
      });
    }

    // H2 (learnings.md): patrol-while-carrying.
    //
    // Round 1 had us committing to delivery as soon as the deliver
    // option won the score comparison. On long-delivery maps this
    // meant we wasted the trip carrying few parcels. Top agents kept
    // patrolling spawn tiles while carrying small loads until either
    // the chain was full or decay forced them in.
    //
    // We emit an `explore` option whose score grows with:
    //   - distance to delivery (longer trip → more time to gather more)
    //   - remaining carry capacity (more room → more value in waiting)
    //
    // It loses to actual pickup options (those are scored on real
    // parcel rewards) and to forced-deliver. It can WIN against the
    // ordinary deliver option when we're undersupplied + the trip is
    // long — exactly the case where it should.
    //
    // Note: when `stackComplete` is false (requiredStackSize policy
    // active and we haven't hit N), we skip this block entirely
    // (deliver isn't emitted, so the empty-options fallback at the
    // bottom emits explore with the LRV-spawn-tile target). That's
    // the patrol-while-collecting case, handled separately.
    if (!force && dn && dn.deliveryTile && carrying < CONFIG.CARRY_FORCE_DELIVER) {
      const cap = CONFIG.CARRY_FORCE_DELIVER;
      const dist = dn.distance ?? Infinity;
      // distanceFactor: 0 when dist ≤ 4, →1 as dist grows
      const distanceFactor = Math.max(0, Math.min(1, (dist - 4) / 10));
      // fillFactor: 1 when empty, 0 when full
      const fillFactor = Math.max(0, (cap - carrying) / cap);
      // Expected marginal value of one more parcel grabbed en route.
      // ~5 is a conservative midpoint of typical parcel rewards.
      const expectedExtraValue = 5;
      const patrolScore = expectedExtraValue * distanceFactor * fillFactor;
      if (patrolScore > 0) {
        options.push({
          type: 'explore',
          score: patrolScore,
          meta: {
            patrol: true,
            distanceToDelivery: dist,
            remainingCapacity: cap - carrying,
            reason: 'patrol-while-carrying',
          },
        });
      }
    }
  }

  // Explore fallback when nothing else has a positive score.
  if (options.length === 0) {
    options.push({ type: 'explore', score: 0.001, meta: {} });
  }

  options.sort((a, b) => b.score - a.score);
  return options;
}
