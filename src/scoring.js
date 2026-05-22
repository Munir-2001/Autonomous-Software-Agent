// Expected-value scoring with Bayesian decay + game-theoretic competitor model.
// All math from slide-07 §6–§8. This is THE differentiator vs other lab agents.

import { CONFIG } from './config.js';
import { manhattan } from './utils/geometry.js';

// Decay function: confidence drops with distance from us.
//   D(d) = e^{-λd}
function decay(distance) {
  return Math.exp(-CONFIG.LAMBDA * distance);
}

// Risk function: probability another agent has reached the parcel.
//   R(d_other) = e^{-λ d_other}
function risk(distanceOther) {
  return Math.exp(-CONFIG.LAMBDA * distanceOther);
}

// Distance from "us" to parcel. Manhattan is a cheap admissible heuristic;
// the actual BFS path used at execution time will be at least this long.
function distanceToParcel(parcel, fromTile) {
  return manhattan(fromTile, parcel);
}

function nearestDelivery(beliefs, fromTile) {
  let best = null;
  let bestD = Infinity;
  for (const t of beliefs.map?.deliveryTiles ?? []) {
    const d = manhattan(fromTile, t);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { tile: best, distance: bestD === Infinity ? null : bestD };
}

// Project the reward of a parcel at the moment of pickup, after decay
// during the travel from `fromTile`. Slide-06 §9: time-as-failure.
function projectedRewardAtArrival(parcel, fromTile, decayPerStep) {
  const dist = distanceToParcel(parcel, fromTile);
  return Math.max(0, parcel.reward - decayPerStep * dist);
}

/**
 * Predict, for each candidate parcel, the probability the named competitor
 * will rationally pursue it (slide-07 §8). Distribute mass over candidates
 * by competitor's own EV; if competitor's max-EV is 0, distribute uniformly.
 */
function predictCompetitorTargets(competitor, candidates, beliefs) {
  const evs = candidates.map((p) => {
    const d = manhattan(competitor, p);
    const projReward = Math.max(0, p.reward - (beliefs.parcelDecayPerTick ?? 1) * d);
    return { parcelId: p.id, ev: projReward * decay(d) };
  });
  const total = evs.reduce((s, e) => s + e.ev, 0);
  if (total <= 0) {
    const uniform = 1 / Math.max(1, candidates.length);
    return new Map(candidates.map((p) => [p.id, uniform]));
  }
  return new Map(evs.map((e) => [e.parcelId, e.ev / total]));
}

/**
 * Score a single parcel as a pickup target.
 * Returns:
 *   {
 *     parcelId, score,
 *     pickupDistance, deliverDistance,
 *     projectedReward,    // reward at arrival
 *     pAvailable,         // P(parcel still available)
 *     deliveryReward,     // reward at delivery point (after both legs decay)
 *     viable              // false if expected reward at delivery <= 0
 *   }
 */
export function scoreParcel(parcel, beliefs) {
  const me = beliefs.myTile();
  const competitors = [...beliefs.agents.values()];

  const decayPerStep = beliefs.parcelDecayPerTick ?? 1;
  const dSelf = distanceToParcel(parcel, me);
  const projAtPickup = projectedRewardAtArrival(parcel, me, decayPerStep);

  // P(still there) — start from our existing belief in the parcel.
  // For visible parcels, confidence is 1.0; for out-of-range, brf has
  // already applied distance/time decay so we don't double-count it here.
  let pAvailable = parcel.confidence ?? 1.0;
  if (competitors.length > 0) {
    // Game-theoretic step: we're a candidate (so are other parcels). The
    // competitor's likely target distribution scales their threat per parcel.
    // We approximate using just the parcel set we know about.
    const cands = beliefs.candidateParcels();
    let combinedRisk = 1.0;
    for (const c of competitors) {
      const probTargets = predictCompetitorTargets(c, cands, beliefs);
      const probThis = probTargets.get(parcel.id) ?? 0;
      const dOther = manhattan(c, parcel);
      // Threat = probability they target it × how close they already are.
      combinedRisk *= 1 - probThis * risk(dOther);
    }
    pAvailable *= combinedRisk;
  }

  // Delivery leg: from parcel position to nearest delivery tile.
  const { tile: delivTile, distance: dDelivery } = nearestDelivery(beliefs, parcel);
  if (delivTile === null) {
    return { parcelId: parcel.id, score: 0, viable: false, reason: 'no-delivery-tile' };
  }

  // Pre-pickup viability check (slide-06 §9 — "a correct plan delivered
  // too late is a failed plan"). Total distance = us → parcel → delivery,
  // plus a safety margin because real BFS paths usually exceed Manhattan.
  const totalDist = dSelf + dDelivery + CONFIG.PATH_SAFETY_TILES;
  const deliveryReward = Math.max(0, parcel.reward - decayPerStep * totalDist);

  // When we're already carrying parcels, picking up X and continuing to
  // delivery brings the carried parcels along for the ride. Their value
  // at delivery is part of the chain's payoff and must be credited so
  // we compare apples-to-apples against `scoreDeliverNow`. Track whether
  // every carried parcel survives the (longer) pickup path.
  let carriedAtDelivery = 0;
  let allCarriedSurviveChain = true;
  for (const c of beliefs.carrying.values()) {
    if (c.reward <= 0) continue; // skip expired ghosts
    const cAtDelivery = Math.max(0, c.reward - decayPerStep * totalDist);
    carriedAtDelivery += cAtDelivery;
    // Lenient: any positive arrival counts as "survives". A parcel
    // arriving with reward 0.5 is still better than not picking up the
    // new parcel at all.
    if (cAtDelivery <= 0) allCarriedSurviveChain = false;
  }

  // Viability — close parcels use a different rule than far parcels:
  //   - Far parcels: must yield ≥ MIN_VIABLE_REWARD at delivery time.
  //   - Close parcels (within CLOSE_PICKUP_DISTANCE): only need positive
  //     reward AT PICKUP. Even if full decay across delivery wipes the
  //     reward, having the parcel in hand still has value (denies it to
  //     competitors, contributes to chain bonus, may find a better
  //     delivery angle later).
  const isClose = dSelf <= CONFIG.CLOSE_PICKUP_DISTANCE;
  const viable = isClose
    ? (projAtPickup > 0 && pAvailable >= CONFIG.CONFIDENCE_THRESHOLD)
    : (deliveryReward >= CONFIG.MIN_VIABLE_REWARD && pAvailable >= CONFIG.CONFIDENCE_THRESHOLD);

  let score = pAvailable * (deliveryReward + carriedAtDelivery);

  // Close-pickup boost: for nearby parcels, use the pickup-time value as
  // a floor (since delivery-time value may be zero from full decay) and
  // multiply by the boost so close parcels beat far ones in the ranking.
  if (isClose) {
    const pickupValue = projAtPickup * pAvailable;
    score = Math.max(score, pickupValue) * CONFIG.CLOSE_PICKUP_BOOST;
  }

  // Visibility floor: a parcel we can SEE right now (confidence == 1.0
  // before competitor risk) is guaranteed to exist. Don't let competitor
  // risk alone collapse the score to near-zero — we'd rather attempt a
  // contested pickup and lose the race than ignore a visible parcel.
  // Apply a baseline = projAtPickup (no risk multiplier), so the score
  // floor reflects the parcel's intrinsic value at our arrival time.
  const isVisible = (parcel.confidence ?? 0) >= 0.99;
  if (isVisible && projAtPickup > 0) {
    score = Math.max(score, projAtPickup);
  }

  // Chain-safe boost: when we're carrying and BOTH (a) the new parcel
  // would be delivered with positive value AND (b) every live carried
  // parcel would also still be valuable at delivery via the pickup path,
  // strongly prefer chaining over delivering. Without this boost the
  // INTENTION_MARGIN can prevent switching from a deliver intention to
  // a clearly-better pickup chain. (User-requested behavior.)
  const carriedCount = beliefs.carriedCount();
  const chainIsSafe = carriedCount > 0
    && viable
    && allCarriedSurviveChain;
  if (chainIsSafe) {
    score *= CONFIG.CHAIN_SAFE_BOOST;
  }

  // Chain-encourage boost: any viable pickup option, while carrying,
  // gets a small extra multiplier. The intuition: we're walking to
  // delivery anyway and grabbing a parcel along the way is mostly free
  // marginal cost. This pushes pickup over the INTENTION_MARGIN bar
  // when chain-safe doesn't fire (e.g. one carried parcel marginal).
  if (carriedCount > 0 && viable) {
    score *= CONFIG.CHAIN_CARRY_BOOST;
  }

  return {
    parcelId: parcel.id,
    score,
    pickupDistance: dSelf,
    deliverDistance: dDelivery,
    projectedReward: projAtPickup,
    pAvailable,
    deliveryReward,
    deliveryTile: delivTile,
    viable,
  };
}

/**
 * Score the "deliver now" option (when carrying parcels).
 * Worth doing if the carried sum decays enough during a long detour.
 */
export function scoreDeliverNow(beliefs) {
  if (beliefs.carriedCount() === 0) return null;
  const me = beliefs.myTile();
  const { tile, distance } = nearestDelivery(beliefs, me);
  if (!tile) return null;
  const decayPerStep = beliefs.parcelDecayPerTick ?? 1;
  // Sum of carried rewards minus total decay across the delivery leg.
  let total = 0;
  for (const c of beliefs.carrying.values()) {
    total += Math.max(0, c.reward - decayPerStep * distance);
  }
  return {
    deliveryTile: tile,
    distance,
    score: total,
    viable: total > 0,
  };
}

/**
 * Rank all candidate parcels. Returns sorted desc by score.
 */
export function rankParcels(beliefs) {
  const cands = beliefs.candidateParcels();
  return cands
    .map((p) => scoreParcel(p, beliefs))
    .filter((s) => s.viable)
    .sort((a, b) => b.score - a.score);
}
