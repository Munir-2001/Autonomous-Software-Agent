# ASA BDI Agent — Deliveroo.js

Hybrid BDI agent for the UNITN Autonomous Software Agents course project.

See [PROJECT.md](PROJECT.md) for the full spec and [KEY_TAKEAWAYS.md](KEY_TAKEAWAYS.md) for the implementation playbook (the slide notes in `slides/` are the deeper backing material).

## Architecture (Part 1)

```
ENVIRONMENT ──sensing──▶ BELIEFS (brf)
                            │
                       options(B,I)        ← desires.js
                            │
                       filter(B,D,I)       ← intentions.js (open-minded, margin)
                            │
                       plan(B,I,Ac)        ← plans/library.js (PRS-style)
                            │              │
                            │       goto subgoal → planner/ (BFS now, PDDL slot reserved)
                            │
                       reactive layer      ← reactive.js (Brooks subsumption)
                            │
                       executor.js
                            │
                            └────actions────▶ ENVIRONMENT
```

### Competitive differentiators (slide-07 §6–§8)

- **Bayesian belief decay** for out-of-range parcels: `P(still there) = e^(-λd)`
- **Game-theoretic competitor model**: predicts what rival agents will rationally chase, then targets parcels they're unlikely to pursue (often the biggest score lever).
- **Open-minded commitment with margin** — re-deliberate every cycle, switch only when a new option beats the current by ≥ `INTENTION_MARGIN` (avoids thrashing).
- **Reactive reflex layer** — collision avoidance + opportunistic pickup/drop bypass BDI deliberation.
- **Time-as-failure validation** — every score factors in decay during travel; late arrivals are pruned.

## Run it

1. Get a token from the 3D client (`https://deliveroojs.azurewebsites.net/` or local `http://localhost:8080`).
2. Copy `.env.example` to `.env` and fill in `TOKEN`, `HOST`, `NAME`.
3. Install + start:

```bash
npm install
npm start
```

For a smoke test (just verifies all modules load, no socket connection):

```bash
npm run smoke
```

## Tuning

All tunables live in [src/config.js](src/config.js):

| Constant | What | Default |
|---|---|---|
| `LAMBDA` | Bayesian decay rate | 0.3 |
| `CONFIDENCE_THRESHOLD` | Drop parcels below this confidence | 0.25 |
| `INTENTION_MARGIN` | Switch threshold (open-minded commitment) | 0.10 |
| `CARRY_FORCE_DELIVER` | Force delivery at this carrying count | 3 |
| `DELIBERATION_BUDGET_MS` | Cap per BDI cycle | 80 |

## Module map

| File | Role | Slide ref |
|---|---|---|
| `src/beliefs.js` | Belief base + `brf` (facts + IC, no deduction) | 07 |
| `src/scoring.js` | EV scoring with Bayesian decay + competitor model | 07 §6–§8 |
| `src/desires.js` | Option generation (`options(B,I)`) | 07 §9, 03 §3 |
| `src/intentions.js` | Filter + lifecycle (open-minded with margin) | 03 §6, 07 §16 |
| `src/plans/library.js` | PRS-style plan library | 03 §8 |
| `src/planner/` | BFS path planner (+ PDDL slot for M6) | 08 |
| `src/reactive.js` | Brooks-style reflex layer | 02 §3 |
| `src/executor.js` | Action emission + retry | — |
| `src/index.js` | Wires the BDI control loop | 03 §4, 07 §15 |

## What's not done yet

- **PDDL planner** (currently BFS only). M6 in [KEY_TAKEAWAYS.md §9](KEY_TAKEAWAYS.md). Slot reserved at `src/planner/pddl.js`.
- **LLM agent (Part 2)** — coordination with this BDI agent via the same public API as a tool catalog. Starts after Part 1 is tuned.
- **Empirical tuning** of `LAMBDA`, `INTENTION_MARGIN`, etc. against actual game data.
- **Ablation studies** for the report (M9).
