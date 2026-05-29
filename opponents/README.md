# Opponent Zoo

Adversarial agents for evaluating the BDI agent in `../project/`.

Each opponent is a self-contained Node process that connects to the local Deliveroo.js server using a different `NAME` (no token needed — the server creates a fresh player per name). Multiple opponents can run simultaneously to simulate competitive scenarios.

## Strategies

| Strategy | Behavior | What it tests in the BDI agent |
|---|---|---|
| `greedy` | Always pursues the highest-(reward − distance) visible parcel; nearest-delivery routing | Competitor-prediction logic + chaining |
| `random` | Random walkable direction each tick; reflex pickup/dropoff | Noise floor / sanity baseline |
| `blocker` | Walks to a delivery tile and sits forever (camps it) | `bestDelivery` congestion-aware switching + panic mode |

## Setup

```bash
cd opponents
npm install
cp .env.example .env  # default config
```

## Running

### One opponent at a time

```bash
NAME=Greedy1 npm run greedy
NAME=RandWalker npm run random
NAME=BlockA TARGET=1,18 npm run blocker
NAME=BlockB TARGET=2,18 npm run blocker
```

`TARGET=X,Y` in the blocker tells it which tile to camp on (defaults to a random delivery tile).

### Multiple in parallel via runner

Default mix (greedy + random + blocker):
```bash
npm run match
```

Custom mix:
```bash
node src/runner.js greedy:Hunter random:Drunkard blocker:Camper
```

Each spec is `<strategy>` or `<strategy>:<name>`. The runner color-codes each opponent's stdout and forwards Ctrl+C to all children.

## Match flow

```
┌─────────────────────┐    ┌─────────────────────┐
│ Terminal 1: server  │    │  Terminal 2: BDI     │
│ cd Deliveroo.js     │    │  cd project          │
│ npm start           │    │  npm start           │
└─────────────────────┘    └─────────────────────┘
              ↑                       ↑
              └──── connects to ──────┴──────────┐
                                                  │
                       ┌─────────────────────────────┐
                       │  Terminal 3: opponent zoo    │
                       │  cd opponents                │
                       │  npm run match               │
                       └─────────────────────────────┘
```

Open the 3D viewer at <http://localhost:8080> to watch all the agents play.

## Tip — match score logging

To collect end-of-match scores, watch the server console for `putDown` lines (`a0(a0) putDown 1 parcels (+ 5 pti -> 25 pti)`). The `pti` is each player's running total. Compare across agents at match end.

## Adding new strategies

Drop a new file in `src/<strategy>.js`, follow the pattern of `greedy.js`:
1. `import { connectAndState, ... } from './shared/connect.js'`.
2. Implement an async `controlLoop` that consumes `state` and emits actions.
3. Add the strategy name to `STRATEGIES` in `runner.js`.
