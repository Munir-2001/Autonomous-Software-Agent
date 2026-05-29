# Arena — running everything in one terminal

The Deliveroo.js server is the shared world; every agent that connects to `localhost:8080` plays in the same sandbox simultaneously. The arena script just orchestrates the agent processes from one terminal.

## What the arena does

`arena.js` (top-level) spawns:
- The BDI agent (from `project/`) using your `project/.env` token.
- One or more opponents (from `opponents/`) using fresh server-issued identities (no token files needed).

All children share stdout, color-prefixed by name. Single Ctrl+C kills everyone cleanly.

## Pre-requisites

```bash
# Terminal A (leave running across matches):
cd Deliveroo.js && npm start

# Make sure project/.env has your TOKEN.
# opponents/.env exists from setup.
```

## Running

From the `autonomous_software/` directory:

```bash
# Default: BDI + greedy + random + blocker (assumes server is running)
node arena.js

# Custom opponent mix
node arena.js --opponents=greedy,blocker

# Two greedy opponents (each gets a unique name)
node arena.js --opponents=greedy,greedy

# Just opponents, no BDI
node arena.js --no-bdi --opponents=greedy,random,blocker
```

## Switching maps in one command

`--map=<name>` makes the arena manage the **entire** lifecycle: kill any prior server + leftover agents, start a fresh server with the chosen map, wait for it to be ready, then spawn the BDI + opponents. Single Ctrl+C tears everything down.

```bash
# Pick a map and run a full match. No need to start the server separately.
node arena.js --map=wide_paths
node arena.js --map=crossroads --opponents=greedy,greedy
node arena.js --map=empty_10 --no-bdi --opponents=random,random,random
```

The BDI agent's code and `.env` token are preserved — it just gets respawned fresh each time. Maps available in `Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games/`. Common picks:

| Map | Size | Character |
|---|---|---|
| `small_two_wide` | 20×20 | 2-wide corridors (default) |
| `wide_paths` | 30×30 | Big with corridors + open areas |
| `crossroads` | 25×25 | Mazey, balanced |
| `empty_10` | 10×10 | Wide-open 10×10, lots of action |
| `crates_maze` | 10×10 | Tight maze with crate tiles |
| `hallway` | 1×20 | Single-file line — chokepoint test |

To switch maps mid-session: just hit Ctrl+C and re-run with a different `--map=...`. The arena cleans up before starting.

## What you'll see

```
Arena starting. Server expected at http://localhost:8080

[ASA-BDI    ] spawning BDI agent
[Greedy_1   ] spawning greedy as Greedy_1
[Random_2   ] spawning random as Random_2
[Blocker_3  ] spawning blocker as Blocker_3

→ 4 agent(s) running. Ctrl+C to stop all.

[ASA-BDI    ] Connecting to http://localhost:8080 with token eyJhb...QcUbY
[Greedy_1   ] Connecting to http://localhost:8080 as Greedy_1
[Random_2   ] Connecting to http://localhost:8080 as Random_2
[Blocker_3  ] Connecting to http://localhost:8080 as Blocker_3
[ASA-BDI    ] socket connected
[Greedy_1   ] [Greedy_1] starting at (5,5)
[Random_2   ] [Random_2] starting at (8,3)
[Blocker_3  ] [Blocker_3] camping on (1,18)
[ASA-BDI    ] Map 19x19, 177 walkable, 2 delivery, 10 spawning
[ASA-BDI    ] + pickup(p_xxx) (score=14.00)
...
```

Each color-coded prefix tells you who's saying what. Open `http://localhost:8080` in a browser to watch them all on the grid.

## Comparing scores at end of match

Watch the **server console** (terminal A). It logs every successful delivery:

```
ASA-BDI(daf2c8) putDown 2 parcels (+ 18 pti -> 312 pti)
Greedy_1(a3b1c2) putDown 1 parcels (+ 5 pti -> 145 pti)
```

The `pti -> N` is the player's running total. At Ctrl+C time, the highest `pti` is the winner.

## Stopping

Single Ctrl+C in the arena terminal stops the BDI and all opponents (forwards SIGINT to each child). The Deliveroo.js server keeps running so you can immediately start another match.
