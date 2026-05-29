// Tunable constants for the BDI agent.
// All thresholds defaulted from slide-07 examples; tune empirically per map.

export const CONFIG = {
  // --- Belief revision ---
  // Decay constant for parcel-still-there confidence (slide 07 §7).
  // Larger = faster decay with distance.
  LAMBDA: 0.3,

  // Confidence floor: parcels below this are dropped from consideration.
  // Lowered so we still pursue parcels even when competitors are close
  // (their proximity drops pAvailable). We'd rather attempt a contested
  // pickup and lose than ignore a visible parcel.
  CONFIDENCE_THRESHOLD: 0.15,

  // Ticks an out-of-range parcel is kept before forced expiry.
  STALE_PARCEL_TICKS: 30,

  // Ticks a non-visible enemy agent is kept (last-seen position).
  // Extended so blockers remain "remembered" during long detours
  // around them — otherwise brf can't refresh transient blocks once the
  // blocker passes out of sensing range, and the block expires mid-detour.
  STALE_AGENT_TICKS: 30,

  // --- Intention selection ---
  // Open-minded commitment: new intention must beat current by this margin
  // before we switch (avoids thrashing). Slide-03 §11.
  // Lowered from 0.10 so the agent is quicker to abandon a deliver
  // intention when a fresh parcel becomes visible nearby — maximizes
  // pickup chains.
  INTENTION_MARGIN: 0.05,

  // Hard cap on total intentions in the queue (we only run 1 active at a time
  // but can pre-schedule).
  MAX_INTENTION_QUEUE: 4,

  // --- Plan execution ---
  // Retries on a single failed move before giving up the plan step.
  MAX_MOVE_RETRIES: 2,

  // Delay between move retries (ms).
  RETRY_DELAY_MS: 60,

  // Hard wall-clock cap per BDI cycle (ms). Slide-02 calculative-rationality.
  DELIBERATION_BUDGET_MS: 80,

  // --- Carrying strategy ---
  // Force return-to-delivery when carrying this many parcels. Round-1
  // post-mortem (learnings.md): top agents stacked 10-20 before
  // delivering for ~5-7x per-tile efficiency. Bumped 5 → 10 to match.
  // Decay-race trigger below still ensures we deliver before parcels
  // rot; H3 marginal chain-safe is what makes stacks past 4 feasible.
  CARRY_FORCE_DELIVER: 10,

  // If the highest-decay carried parcel has fewer than this many ticks left
  // (after travel cost), force delivery. This is the safety valve that
  // prevents holding too long even when CARRY_FORCE_DELIVER is high.
  CARRIED_DECAY_FORCE_DELIVER: 4,

  // --- Pickup viability (slide-06 §9: time-as-failure) ---
  // Don't bother walking to a parcel if its projected reward at delivery
  // (after decay across pickup leg + delivery leg) is below this floor.
  // Set to 0 so any parcel with strictly positive net delivery reward is
  // considered worth grabbing — even a "barely beneficial" parcel still
  // adds to total score.
  MIN_VIABLE_REWARD: 0,

  // Add this many "safety" tiles to the Manhattan path estimate when
  // checking viability. Real BFS path is usually longer than Manhattan
  // due to walls / obstacles; this buffer prevents over-optimism.
  PATH_SAFETY_TILES: 1,

  // Close pickups: parcels within this Manhattan distance get a score
  // boost so the agent prioritizes grabbing nearby visible parcels
  // ("rush mode") even if their solo delivery would only break even.
  // Server sensing range is 5 — anything visible is already "close".
  // Boost pushed up so the agent reliably diverts for any visible parcel.
  CLOSE_PICKUP_DISTANCE: 8,
  CLOSE_PICKUP_BOOST: 4.0,

  // While carrying, apply this extra boost to pickup options. The
  // intuition: we're walking to delivery anyway, and grabbing more
  // parcels along the way is mostly free. Helps the chain decision win
  // over the INTENTION_MARGIN. Bumped to make mid-delivery diverts
  // happen more reliably whenever a parcel comes into sensing range.
  CHAIN_CARRY_BOOST: 1.5,

  // Chain-safe pickup boost: when we're already carrying and a new parcel
  // is reachable AND every parcel (carried + new) survives the pickup path
  // with reward ≥ MIN_VIABLE_REWARD, multiply pickup score by this factor
  // so it reliably beats the deliver-now option. Must exceed
  // (1 + INTENTION_MARGIN) to overcome the open-minded-commitment margin.
  // Bumped from 1.6 → 2.0 so chain pickups dominate when safe.
  CHAIN_SAFE_BOOST: 2.0,

  // --- Exploration ---
  // When no parcels are believed to exist, walk toward a random spawning tile.
  // Re-pick exploration target after this many failed steps.
  EXPLORE_REPICK_AFTER: 10,

  // --- Reactive layer ---
  // If a sensed enemy is within this Manhattan distance and on our planned next
  // tile, pause/replan instead of pushing in.
  ENEMY_AVOID_DISTANCE: 1,

  // --- Logging ---
  LOG_LEVEL: process.env.LOG_LEVEL || 'info', // 'debug' | 'info' | 'warn' | 'error'

  // --- Automated planning (PDDL) ---
  // Slide 9: "Once an intention is activated the agent must call the
  // planner to have the plan to execute." When enabled, an HTTP PDDL
  // solver computes the plan on intention activation; BFS in bfs.js
  // remains the fallback for solver outages, timeouts, and in-flight
  // replanning.
  //
  // Set PDDL_ENABLED=false to disable (forces BFS-only) — useful when
  // running on a network without internet access or for A/B testing
  // BFS-only vs PDDL-primary performance.
  PDDL_ENABLED: (process.env.PDDL_ENABLED ?? 'false').toLowerCase() !== 'false',

  // Hard cap per overall PDDL call (submit + polling combined). Doesn't
  // affect the agent's responsiveness — PDDL runs in background, BFS
  // handles execution. Long timeout just means the solver has a chance
  // to finish on a busy server. On timeout we silently fall back.
  PDDL_TIMEOUT_MS: Number(process.env.PDDL_TIMEOUT_MS ?? 12000),

  // PDDL-as-a-service endpoint. Default is the dual-bfws-ffparser
  // package on solver.planning.domains (the slide-08 reference). User
  // can override with PDDL_ENDPOINT env to point at a private solver.
  PDDL_ENDPOINT: process.env.PDDL_ENDPOINT
    || 'https://solver.planning.domains:5001/package/dual-bfws-ffparser/solve',
};
