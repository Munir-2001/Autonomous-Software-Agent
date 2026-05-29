# ASA Project — Deliveroo.js Autonomous Agent

**Course:** Autonomous Software Agents — A.A. 2025-2026
**Instructors:** Prof. Paolo Giorgini, Dr. Marco Robol, Dr. Marco Bombieri
**University:** University of Trento

---

## 1. Objective

Build an autonomous agent that plays Deliveroo.js (2D grid parcel-delivery game) on the user's behalf and earns points by **picking up parcels and delivering them in the delivery zone**, competing against other agents.

The score of a delivered parcel = its remaining timer at drop-off, so faster routes and shorter detours = more points.

---

## 2. Project Scope (Two Parts)

### Part 1 — BDI Agent (current focus)

A BDI (Belief–Desire–Intention) agent that:

1. **Senses** the environment (limited radius `x_offset + y_offset < 5`) and maintains a belief base.
2. **Manages beliefs** with revision — e.g., a parcel previously seen but no longer visible is *not deleted*; we track it as a hypothesis until contradicted.
3. **Activates intentions** from desires (deliver-this-parcel, explore, return-to-delivery) and revises them when the world changes.
4. **Uses predefined plans** for known sub-goals (pickup, deliver, move-to).
5. **Calls an external planner** (PDDL) once an intention is activated, to compute the action sequence.
6. **Replans / re-deliberates** if env changes invalidate the current plan.

**Constraint for now:** *single agent competing against other agents.* Multi-agent comms is Part 2.

### Part 2 — LLM-based Second Agent

Add a second agent driven by an LLM that:
- Reads natural-language objectives and observations into LLM memory (context).
- Reasons over memory (Chain-of-Thought / ReAct / Reflexion) to produce a plan.
- Calls a predefined catalog of **tools** exposed via the course server API.
- Communicates with the BDI agent: exchanges beliefs and coordinates (e.g., closest agent commits to a parcel).

LLM + tool API endpoints will be provided by the course.

---

## 3. Game Reference (Mechanics That Shape Design)

| Aspect | Detail |
|---|---|
| Grid | M × N tiles |
| Tile types | `0` non-walkable, `1` spawning, `2` delivery, `3` walkable |
| Actions | `move_right` `move_left` `move_up` `move_down` `pick_up` `put_down` |
| Move duration | Not instantaneous: 0.6 of distance moved at start, 0.4 on completion. Start + target tiles locked. |
| Move collision | Fails + penalty. Cannot enter a tile occupied by another player. |
| Pickup | Instantaneous, must be on parcel's tile. Multiple parcels can be carried. |
| Putdown | Instantaneous, anywhere. Score awarded **only** on delivery tile (type `2`). |
| Sensing range | `x_offset + y_offset < 5` |
| Parcel sensing | `{id, x, y, carriedBy, reward}` |
| Player sensing | `{id, name, x, y, score}` |
| Self | `{id, name, x, y, score, penalty}` |
| Parcel reward | Decays with a timer, locally computable. Score on delivery = remaining reward. |

---

## 4. Architecture (chosen for Part 1, see ARCHITECTURE.md)

A classic BDI control loop:

```
sense → revise beliefs → generate desires → filter intentions → plan → execute → repeat
```

External planner (PDDL) called at the "plan" step. Predefined plans available as fallback / for trivial intentions.

---

## 5. Deliverables

| Item | Notes |
|---|---|
| **JavaScript code** | The agent itself. Runs against course server. |
| **Final report** | Max 10 pages. What was done and how. |
| **Oral presentation** | Discussion of the project. |
| **Submission** | Portal link to be provided. Deadline: ≥ 1 week before the exam. |

---

## 6. Running the Game (Reference)

| Target | URL / Command |
|---|---|
| Local server | `cd Deliveroo.js && npm install && npm run build && npm start` → http://localhost:8080 |
| Public cloud (slow) | https://deliveroojs.azurewebsites.net/ |
| UNITN internal (needs GlobalProtect VPN) | https://deliveroojs.bears.disi.unitn.it/ (fallback `…rtibdi…`) |
| Render | https://deliveroojs.onrender.com/ |

Get a token from the 3D client, put it in `.env`. Local admin password: `admin` (god mode).

---

## 7. Open Questions / TBD

- Exact submission deadline (will be announced later in the course).
- Final tool catalog and LLM API endpoint for Part 2.
- Which map(s) the project will be evaluated on (slides hint at "predefined simulation runs, all together").
