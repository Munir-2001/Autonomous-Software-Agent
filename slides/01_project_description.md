# Slide 01 — Project Description

**Source:** Project intro deck (slides 1–19), Prof. Giorgini / Dr. Robol / Dr. Bombieri, ASA A.A. 2025-2026

This file captures **only what is actionable for our agent design**, not a recap of every line.

---

## Things to USE in the agent

### From "Game environment" (slide 3)

- **Tile-type lookup is fundamental.** Hardcode the tile-type meaning into the belief base:
  - `0` non-walkable → never plan a path through these
  - `1` spawning → drives `explore` desire when no parcels are visible (camp near these)
  - `2` delivery → target tiles for `deliver` intention
  - `3` walkable → free path
- **Multiple parcels can spawn simultaneously** → must score & rank all known parcels each tick, not just chase the first one seen.
- **Parcels disappear when timer expires OR when delivered** → in belief revision, distinguish `expired` (we can compute this locally from the timer) from `picked_up_by_other` (we infer when a parcel we expected to find is gone). Don't conflate.

### From "Players" (slide 4)

- **Multi-parcel carrying** is allowed. Strategy implication: it can be optimal to chain pickups before going to delivery, especially if the delivery tile is far. Intention scoring must handle "carry N parcels then deliver" as a single intention, not just one parcel at a time.
- **Sensing radius**: `x_offset + y_offset < sensing_distance`. The `5` constant is the default but **may differ per map** — read it from the server config, don't hardcode.
- **`me` includes a `penalty` field** — track this in the belief base. A rising penalty is a signal our movement strategy is bad (collisions).
- **Score awarded = remaining timer when delivered** → optimization target is `Σ (reward − travel_time)` not `Σ reward`. Plan around the decay.

### From "Actions" (slide 5)

- **Moves are NOT instant**. Two phases: 0.6 then 0.4. Implication for planning:
  - When planning a path of length L, the wall-clock time is `L × move_duration`, not L.
  - Parcel decay during travel must use real move duration from server config.
- **Start + target tiles are locked during a move.** This means a moving agent occupies *two* tiles. When predicting other agents' positions for collision avoidance, treat in-flight agents as blocking both tiles.
- **Move into occupied tile → fail + penalty.** Implication: build a 1-step lookahead — before emitting a move, check if any sensed agent is on the target. If yes, replan or wait.
- **Direction conventions** (must match exactly):
  - `right`: `x + 1`
  - `left`: `x - 1`
  - `up`: `y + 1`
  - `down`: `y - 1`
  - (Note `up` increases `y` — opposite of screen-coordinate intuition. Easy bug source.)
- **Pickup/putdown are instantaneous and free actions** → no reason to defer them. Always try pickup on arrival; always try putdown on a delivery tile when carrying.
- **Putdown anywhere is allowed** but only delivery tiles award score → use this strategically? E.g., drop a parcel temporarily to free up multi-pickup slot? **Probably not worth it** unless slots are limited (slides say no slot limit, so ignore).

### From "Sensing" (slide 6)

- **Map is sent ONCE on connect** as a list of tiles → cache it as immutable in beliefs. Don't re-derive.
- **Sensing events fire on world change** (parcel timer tick, agent moves, etc.) → control loop should be event-driven, not pure polling. React to `sensing` events for belief updates; run deliberation on a tick or on intention completion.
- **Reward timer of parcels can be computed locally** → we don't need to wait for sensing to know a parcel has decayed; subtract elapsed time from `lastSeen` reward. Saves API calls and improves planning accuracy.
- **Position of previously observed players can be guessed** → store `lastSeen` for every player. Use last-known velocity (delta between two recent observations) to predict their next tile for collision avoidance.
- **Anything outside sensing is unknowable** → the belief base must explicitly model uncertainty. A parcel out of range is *believed to exist* until it's been long enough that the timer would have expired.

### From "Architecture" (slide 7)

- The game is **Socket.IO over WebSocket**, no game logic on the client.
- We can run multiple clients (3D + our agent) on the same token to **watch our agent live**. → use this for debugging.

### From "Authentication" (slide 8)

- Tokens are **per-server-instance** (signed with a server passphrase) — a token from local won't work on UNITN deploy.
- **No token expiry**, no rate limit on number of tokens.
- **NPC removed after 10 s of disconnection** → for testing, our agent must reconnect cleanly if the socket drops.

### From "The project" (slide 9)

- Phase 1 explicitly requires:
  1. Belief management **with belief revision**
  2. Intention activation **with intention revision**
  3. Predefined plans
  4. **External automated planner** integration (parcels are known since the beginning — the planner gets called once an intention is activated)
- "Parcels are known since the beginning" — interpret this as: at intention-activation time, we plan for the parcels we currently believe to exist. Not "we know all parcels for the whole game in advance."
- **Validation = predefined simulation runs, all together** → multiple agents run on the same map at evaluation time. Implication: our agent must handle adversarial / competitive scenarios, not just empty maps.

### From "LLM agent / Part 2" (slides 10–14)

- LLM agent uses: **memory (context), planner, replanner**, with techniques like **Chain-of-Thought, ReAct, Reflexion**.
- The two agents must:
  - Exchange beliefs
  - Coordinate (e.g., the closest agent commits to a parcel)
- Tool catalog will be on a course-provided server, called via API.
- **Implication for Part 1:** design the BDI agent's belief base and intention scorer with a **clean public API** (`getBeliefs()`, `proposeCommitment(parcelId)`, `claimParcel(parcelId)`) so the LLM agent can plug in without rewrites.

### From "Delivery" (slide 15)

- **JS code + max-10-page report + oral** — start jotting report-worthy decisions in a `notes/` log as we go (architecture trade-offs, why we chose X). Cheaper than reconstructing them at the end.

---

## Things to AVOID / WATCH OUT FOR

- **Don't hardcode constants** that come from the server config (sensing distance, move duration, parcel decay rate, map dimensions). Read them dynamically.
- **Don't delete beliefs aggressively** — see user's notes (14April.rtf): a parcel out of range is still hypothetically there. Premature deletion = the agent forgets opportunities.
- **Don't assume `up = y - 1`** (screen convention). It's `up = y + 1` per the slides.
- **Don't ignore `penalty`** — accumulating penalties on the `me` belief is a feedback signal that collision avoidance is failing.
- **Don't build the agent as one big file.** The architecture (BDI → LLM extension → multi-agent coord) needs clean module boundaries from day one.

---

## Open / TBD

- Does "predefined simulation runs" mean a fixed map known to us, or randomized at evaluation? Slide says "all together" but not "same map every time."
- What's the **PDDL planner** the course expects us to use? (planning.domains HTTP API? Fast Downward locally? Course-provided?)
- **Tool catalog** for Part 2 — exact list will come later; until then, design tool-using code as a generic dispatcher.
