# Slide 06 — LLM Agents: Planning and Reasoning

**Source:** "LLM Agents – Planning and Reasoning" deck, Prof. Giorgini, ASA A.A. 2025-2026

This deck gives us the **reasoning-loop pattern** for the LLM agent (ReAct + Reflexion), the **planning-style taxonomy** for the report (Symbolic / RL / FM), and a **failure-modes catalog** that doubles as our evaluation framework.

---

## 1. Decouple planning from execution (slides 5-6) — locked-in pattern

> Planning should be decoupled from execution: you can review the plan, correct it before execution, and operate more efficiently.

### Implications for our LLM agent

- LLM emits a **plan object** (sequence of structured steps), not raw actions.
- Plan goes through a **validator** before any tool call fires.
- Validator can edit, reject, or accept the plan.

### Validation heuristics (slide 6)

The slide gives a concrete checklist. We adopt all of them:

1. **Eliminate invalid actions** — references tools not in inventory.
2. **Eliminate plans with too many steps** — set a hard cap (e.g., 8 steps per LLM-issued plan).
3. **AI-judge validation (optional)** — for hard cases, ask the LLM in a separate call to evaluate the plan.

### What this looks like in code

```
LLM agent ──(plan: [step1, step2, ...])──▶ Plan validator
                                              │
                                              ├─ valid → execute via tool dispatcher
                                              ├─ fixable → repair and execute
                                              └─ invalid → reject, ask LLM to retry
```

---

## 2. Natural-language plans (slide 4) — flexibility, but with translation cost

The slide pitches NL plans as **robust to tool API changes** and easier to reuse. But:

- **For our project:** we already control the tool inventory. There's no external API drift to absorb. Use **structured plans (JSON)**, not NL plans.
- **Why:** structured plans skip the translation step entirely → fewer hallucinations, easier validation, easier logging.

**Decision: structured JSON plans, not NL plans.** Mention NL plans in the report's "alternatives considered" section.

---

## 3. Control flow beyond sequential (slides 8-10) — what we need

Slide lists 4 control-flow types: sequential, parallel, conditional, loops.

| Control flow | Need for Part 2? |
|---|---|
| **Sequential** | ✅ Default for most plans. |
| **Parallel** | ✅ When LLM agent and BDI agent operate concurrently. (Not within a single plan.) |
| **Conditional (if)** | ✅ E.g., "if parcel X visible, claim it; else explore." Implement as plan steps that read a belief and branch. |
| **Loops** | Probably not. Long-running loops are a foot-gun for LLM agents (compound errors). Cap iterations strictly if needed. |

**Decision:** support sequential + conditional in our plan format. Skip loops. Document in plan-spec README.

---

## 4. The four reasoning patterns (slides 19-24) — pick one

The deck compares four planning patterns:

| Pattern | Behavior | Use case for us |
|---|---|---|
| **CoT** (Chain of Thought) | Linear, single-path reasoning | Cheap and clean. Good as the *baseline* for simple decisions. |
| **ReWOO** | Plan first, execute later, no feedback | Useful when the world is static, but Deliveroo is fast-changing. ❌ Don't use. |
| **CoT-SC** (Self-Consistency) | Multiple paths + majority vote | Expensive (multiple LLM calls). Overkill except for high-stakes calls (e.g., "should we coordinate with the other agent now?"). |
| **ToT** (Tree of Thoughts) / RAP / LMZSP | Multi-path with selection | Most expressive but most expensive. ❌ Skip for runtime; mention in report. |

**For our LLM agent runtime: CoT for cheap decisions, ReAct for action loops** (see §5). CoT-SC reserved for occasional high-stakes coordination calls if budget allows.

---

## 5. ReAct (slides 26-34) — THE loop pattern for our LLM agent

> ReAct interleaves **reasoning, action, observation**.

### The pattern

```
loop:
  Thought:    LLM reasons about state and goal
  Action:     LLM emits a tool call
  Observation: tool returns result
  → repeat until reflection signals completion
```

### Why this is the right choice for Deliveroo

- **Feedback loop** — Deliveroo is dynamic; we need observations to feed back into the next decision.
- **Tool-native** — pairs perfectly with our MCP-style tool catalog from slide-05 notes.
- **Stoppable** — the LLM decides when the task is done; no fixed step count.
- **Auditable** — every Thought/Action/Observation is logged → great evaluation data.

### Concrete loop for our LLM agent

```
Thought:    "I see parcels at (4,7) reward 9 decaying fast,
             and (1,2) reward 5. The other agent is closer to (4,7).
             I should claim (1,2)."
Action:     claim_parcel(parcelId="P_12")
Observation: { "claimed": true }
Thought:    "Now propose a deliver intention to the BDI."
Action:     propose_intention({ type: "deliver", parcelId: "P_12" })
Observation: { "accepted": true, "estimatedReward": 4.2 }
Thought:    "Plan accepted. Done for now."
[STOP]
```

### Zero-shot ReAct prompt (slide 30) — what we adapt

The slide shows the canonical zero-shot prompt: tool descriptions + instruction to interleave Thought/Action/Observation. We copy this template and parameterize:
- System prompt = role + tool catalog + game rules summary
- User prompt = current objective + current beliefs (compact JSON)
- Output format = strict Thought/Action/Observation grammar

---

## 6. Reflexion (slides 36-38) — for between-game learning

ReAct = within-task. **Reflexion = across-tasks.** The pattern:

```
After a failed/poor attempt:
  1. Evaluator scores the trajectory (plan + actions + outcome)
  2. Self-reflection module analyzes what went wrong
  3. New trajectory proposed for next attempt
```

### Where we use Reflexion in Deliveroo

- **End of each evaluation game:** LLM agent reviews the trajectory (claimed parcels, missed parcels, total score, key decisions), produces a reflection.
- **Reflection persisted** to long-term memory (simple JSON log — no vector DB).
- **Next game:** reflections from past games are injected into the system prompt as "lessons learned."

### Concrete reflection format

```json
{
  "game_id": "g_2025_05_02_001",
  "score": 84,
  "duration_ticks": 2400,
  "lessons": [
    "Claimed P_42 too early; another agent reached it first because it was farther for me.",
    "Should have factored in agent positions when claiming, not just distance.",
    "Long detour through (2,3)-(2,4)-(2,5) cost 3 ticks — PDDL planner found a better route the second time."
  ]
}
```

This becomes a **report-worthy artifact** even if it only improves performance modestly.

---

## 7. Symbolic vs RL vs FM planners (slide 12) — for the report

The slide cleanly contrasts three families:

| Type | Strengths | Limitations | Our use |
|---|---|---|---|
| **Symbolic** (PDDL) | Correct, interpretable plans | Manual modeling, fragile | ✅ For the `goto` subproblem (Part 1). |
| **RL** | Handles stochastic envs | Expensive training, low interpretability | ❌ Not used. Mention as future work. |
| **FM** (LLM) | Flexible, no world model needed | No formal guarantees, may produce inefficient plans | ✅ For high-level strategy (Part 2). |

> Slide quote: *"Likely future: hybrid systems. FM planners augmented with symbolic constraints and RL-based optimization."*

**Our project IS a hybrid system: FM (LLM) for strategy + symbolic (PDDL) for pathfinding + procedural (BDI) for tactical loop.** This is a strong framing for the report's introduction.

---

## 8. Hierarchical planning (slide 18) — already what we have

Slide notes the trade-off:
- High-level plans: easier to generate, harder to execute.
- Detailed plans: harder to generate, easier to execute.

> Common solution: hierarchical — generate high-level first, refine each step.

**This is exactly our architecture:**

| Layer | Granularity | Owner |
|---|---|---|
| Strategy | "Pursue parcel X, coordinate with other agent" | LLM agent |
| Intentions | `deliver(parcel_X)` | BDI core |
| Subgoals | `goto(target_tile)`, `pickup`, `putdown` | Plan library |
| Actions | `move_left`, `pick_up` | Executor |
| Reflexes | "Don't walk into another player" | Reactive layer |

Hierarchical planning is implicit in the BDI + LLM split — no extra work needed. Document it that way.

---

## 9. Failure modes (slides 40-46) — our evaluation framework

This is the most useful operational content in the deck. We adopt the **failure taxonomy verbatim** as our evaluation rubric.

### Planning failures (tool use)

| Failure | Mitigation in our system |
|---|---|
| **Invalid tool** (not in inventory) | Tool dispatcher rejects unknown tool names with a structured error. |
| **Valid tool, invalid params** (wrong arity) | JSON schema validation. |
| **Valid tool, incorrect param values** (e.g., wrong parcel ID) | Server-side check against current beliefs (parcel ID exists in `parcels.byId`). |

### Goal failures

| Failure | Mitigation |
|---|---|
| Plan doesn't solve task | Validator runs a feasibility check (target reachable, parcel still alive). |
| Plan violates constraints | Constraint check: budget = remaining tick time; parcel reward must be > expected travel cost. |
| **Time** — correct answer too late | **HUGE for Deliveroo.** Every plan has a time budget; if estimated arrival > parcel's remaining timer, plan is invalid. |

### Reflection failures (slide 44 — "the model fails twice")

> "The model fails twice: it makes a mistake and fails to detect it."

This is the silent-error case. Mitigation:

- **External evaluator**, not self-critique alone. The BDI agent verifies LLM claims ("you said the parcel was delivered — was it?") against ground truth.
- **Multi-agent setting**: LLM acts, BDI evaluates outcome. The slide explicitly endorses this pattern.

### Tool failures

- Correct tool used, wrong output. Mitigation: every tool has an idempotent "verify" companion when applicable. E.g., after `claim_parcel`, the next `get_intention` should reflect the claim.

### Efficiency

Slide gives three metrics — we adopt them for the report:
- Average **number of steps** per task
- Average **cost** per task (here: latency, since we have no $ budget for self-hosted LLM)
- **Time per action**

---

## 10. Evaluation strategy for the report (slide 45)

Direct adoption:

- Create a **planning dataset** of `(objective, tool inventory, game state)` pairs.
- For each: generate K plans, measure:
  - Fraction of **valid** plans
  - Average number of plans before getting one valid
  - Per-failure-type frequency
- Output goes into the report's evaluation chapter.

This is high-value, low-cost data — easy to generate, looks rigorous in the report.

---

## 11. Concrete additions to our architecture

Refining choices from earlier slide notes:

1. **LLM agent uses ReAct as its main loop** — Thought / Action / Observation, capped iterations.
2. **CoT** for cheap one-off decisions (e.g., "summarize game state").
3. **CoT-SC reserved for high-stakes calls** — multi-agent coordination decisions, max 3 sampled paths.
4. **Reflexion runs end-of-game** — produces a JSON lesson log injected into the next game's prompt.
5. **Plan validator** sits between LLM output and tool execution; rejects invalid actions, oversized plans, and infeasible goals.
6. **Structured JSON plans**, not natural-language plans. Reason: control over validation, fewer translation hallucinations.
7. **External evaluator (BDI verifies LLM claims)** to catch reflection failures.
8. **Time-as-constraint** in every plan: arrival time + parcel decay rate must be checked before commit.
9. **Hierarchical layering** explicit in the report: Strategy (LLM) → Intentions (BDI) → Subgoals → Actions → Reflexes.
10. **Failure-modes taxonomy** = the report's evaluation rubric. We log every failure-type frequency.

---

## 12. Things to AVOID

- **Don't use ReWOO** — plan first, execute without feedback. Wrong for a dynamic environment.
- **Don't use ToT/RAP at runtime** — too expensive. Mention as alternative in report.
- **Don't have the LLM self-evaluate without an external check** (slide 44 — "the model fails twice").
- **Don't generate uncapped plans.** Every LLM-issued plan has a max-step cap.
- **Don't ignore time** — a correct plan delivered late is a failed plan in Deliveroo.
- **Don't trust LLM-generated parameter values.** Validate every param against current beliefs.
- **Don't run the LLM in the hot path** of action selection. Compound errors will kill us.

---

## 13. Open / TBD

- **Iteration cap for ReAct** — start at 5, tune empirically. The compound-error math from slide-05 (95%^N) gives us a soft ceiling.
- **Reflection format** — the JSON shape in §6 is a strawman; refine after first runs.
- **Whether to expose the BDI's internal scorer to the LLM** as a tool. Pro: better LLM decisions. Con: more tools, harder selection (slide 33). Decide after ablation.
