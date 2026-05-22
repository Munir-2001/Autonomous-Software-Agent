# Slide 05 — LLM Agents: Tools

**Source:** "LLM Agents - Tools" deck, Prof. Giorgini, ASA A.A. 2025-2026

This deck is about how tools transform an LLM into an agent, the trade-offs of tool inventory design, function calling mechanics, and MCP. The first slide alone (compound errors) is the most important constraint on our Part 2 design.

---

## 1. Compound mistakes — the constraint that defines our division of labor (slide 2)

> 95% accuracy per step:
> - 10 steps → ~60% overall accuracy
> - 100 steps → ~0.6% overall accuracy

**This is the single most important slide in the deck for us.** Translated to Deliveroo:

- A typical game = hundreds of micro-decisions (each move).
- If the LLM agent decided every move at 95% accuracy, we'd be at <1% by mid-game. Catastrophic.
- **Therefore: the LLM does NOT make per-tick decisions.** The LLM operates at a higher abstraction level.

### Locked-in division of labor

| Layer | Owns | Why |
|---|---|---|
| **Reactive reflexes** | Collision avoid, opportunistic pickup, drop-on-delivery | Must be deterministic; sub-millisecond. |
| **BDI core** | Per-tick action selection, intention scoring, replanning | Fast, deterministic, hundreds of decisions per game. |
| **PDDL planner** | `goto` subproblem when path is non-trivial | Called only when needed; bounded by time budget. |
| **LLM agent** | Strategic reasoning: parse natural-language objectives, multi-agent coordination, replanning when BDI is stuck | A handful of decisions per game, where one error is recoverable. |

The LLM agent's role is **few-shot, high-leverage** decisions. Everything else stays in code.

---

## 2. Higher stakes (slide 2) — agents have real consequences

Translated to Deliveroo: a bad LLM call could:
- Drop a high-value parcel.
- Send the BDI agent on a wild goose chase.
- Issue a "claim" message that desyncs us from the second agent.

**Mitigation:** the LLM's outputs go through validation in the BDI layer before execution. The BDI layer treats LLM tool calls as *suggestions*, not commands — it can reject malformed or conflicting ones.

---

## 3. What determines agent success (slide 4)

The slide says:

> Strong agents are defined as much by their tools and planning as by the model itself.

Two levers:

1. **Tool inventory** — what's available, how expressive, how reliable.
2. **Planner strength** — plan, decide what's next, recover from partial failures.

### What this means for us

- **Spend serious time on tool design.** Slide 33: "Tool selection is a design decision, not a solved problem." We will iterate on the tool catalog.
- **Reliability > expressiveness.** Each tool must do exactly one thing predictably. Avoid magic tools that change behavior based on context.

---

## 4. Tool categories (slides 12, 14, 15) — applied to Deliveroo

### Read-only vs write tools

The slide is explicit:

| Type | Definition | Our examples |
|---|---|---|
| **Read-only** | Retrieve info, observe state | `get_beliefs`, `get_parcels`, `get_players`, `get_map`, `get_intention` |
| **Write** | Modify data, trigger effects | `propose_intention`, `claim_parcel`, `release_parcel`, `request_replan`, `send_message_to_other_agent` |

**Design rule:** every tool declares its category. Read-only tools are safe to call freely. Write tools require validation and idempotency.

### Knowledge-augmentation tools (slide 14)

For Deliveroo: **none**. We don't have external knowledge to retrieve. The "knowledge" is the game state, which is already in the LLM's context.

### Capability-extension tools (slide 15)

For Deliveroo, candidates:
- `compute_path(from, to)` — wraps the BDI's pathfinder; LLMs are bad at grid navigation.
- `score_parcel(parcelId)` — wraps the BDI's intention scorer; deterministic answer.
- `simulate_intention(intention)` — predicts outcome (used parcels, predicted score) without executing.
- `summarize_observations(window)` — collapses old observations into a one-line summary.

**Pattern:** wrap every BDI capability the LLM could mess up if it tried to do it itself.

---

## 5. Function calling workflow (slides 16-18) — concrete shape of our tool catalog

The slide gives a 2-step workflow:

**Step 1 — Declare tools.** Each tool needs:
- Function name
- Parameter schema (types, required fields)
- Documentation (what it does, how to use it)

**Step 2 — Per-call usage mode:**
- `required` — model must use a tool
- `none` — model must not use a tool
- `auto` — model decides

### Our shape

```js
// Example tool declaration
{
  name: "claim_parcel",
  category: "write",
  description: "Tell the BDI agent that this LLM agent commits to picking up parcel `parcelId`. The BDI agent will not target the same parcel. Use only when you are confident this is the best parcel for the LLM agent to pursue.",
  parameters: {
    parcelId: { type: "string", required: true, description: "ID of the parcel from get_parcels()" },
    reason:   { type: "string", required: false, description: "Free-text rationale, logged for evaluation" }
  }
}
```

**Per-call mode usage:**
- `required` when we explicitly ask the LLM "decide which parcel to claim now."
- `none` when we ask the LLM to summarize / analyze without acting.
- `auto` is the default for the main reasoning loop.

---

## 6. Parameter hallucination (slide 18) — the open challenge

> The API guarantees only valid tools are called.
> But it cannot guarantee correct parameters.
> Parameter hallucination remains a key challenge.

**Mitigations we apply:**

1. **Strict JSON schema** for every tool (types + enum constraints where possible).
2. **Server-side validation** in the BDI layer — reject calls with non-existent parcel IDs, out-of-bounds coordinates, etc.
3. **Echo back rejections** as structured error responses so the LLM can self-correct (matches the MCP "structured errors, no fragile parsing" pattern, slide 25).
4. **Constrain values via descriptions** — e.g., always tell the LLM "parcel IDs come from `get_parcels()`" so it doesn't invent them.

---

## 7. MCP — Model Context Protocol (slides 21-32)

Anthropic's open standard for LLM ↔ tool integration. The slide pitches it as "USB-C for AI."

### Architecture

| Layer | Role | Our analog |
|---|---|---|
| **Agent / LLM** | Reasons, plans, decides | Our LLM agent (Part 2) |
| **MCP Client** | Translates LLM decisions to tool calls; handles errors | Our LLM-side runtime — sits next to the model |
| **MCP Server** | Exposes tools, resources, prompts; security/policy boundary | Our BDI agent's public API (the BDI layer becomes our "MCP server") |
| **MCP Host** | Runtime environment | Our Node.js process |

### Key MCP properties (slide 24)

- **Tool discovery is dynamic** — agents don't assume which tools exist; they query at runtime.
- **Tool calls are structured** — name + structured arguments, not free-form text.
- **Errors are structured objects**, not strings. No fragile parsing.

### Should we actually USE MCP?

**Probably not as a library, but yes as a pattern.** Reasons:

- The course's "tools available on a server" (per project description deck) is likely a course-specific format, not MCP-compliant.
- Adding @modelcontextprotocol/sdk for our internal BDI ↔ LLM bridge would be over-engineering — they're in the same Node process.
- But the **architectural separation MCP enforces** (LLM doesn't know API details; tool discovery; structured errors) is the right pattern for us regardless of whether we use the SDK.

### Locked-in pattern: MCP-style boundaries even without MCP

```
LLM agent ──(tool call: name + params)──▶ Tool dispatcher ──▶ BDI public API
LLM agent ◀──(structured result or error)── Tool dispatcher ◀── BDI public API
```

The BDI agent never receives free-form LLM text. It only receives structured tool calls. This is the boundary that makes Part 2 robust.

### Tool composition for the report

Slide 27: *"planning ≠ execution. MCP is the controlled bridge."* This is a clean line for our report — we cite the same separation: LLM plans, BDI executes, tool layer validates.

---

## 8. Tool selection (slides 13, 33-34) — guidelines for trimming our catalog

The slide is blunt about the trade-off:

> More tools ⇒ more capabilities. More tools ⇒ harder selection and usage.
>
> Tool overload can reduce performance, despite higher theoretical capability.

**Implications:**

1. **Start small.** Minimum viable tool catalog for Part 2:
   - `get_beliefs`, `get_parcels`, `get_players`, `get_intention`
   - `propose_intention`, `claim_parcel`, `release_parcel`
   - `compute_path`, `score_parcel`
   - That's ~9 tools. Don't add more until ablation says we need them.

2. **Run ablation studies (slide 34) for the report.**
   - Remove each tool, run N games, measure score delta.
   - Tools whose removal doesn't hurt → cut.
   - Tools the LLM frequently misuses → revise description or replace with constrained version.

3. **Keep tool descriptions short.** Slide warns descriptions can exceed the context window or confuse selection. Each tool gets ≤ 2 sentences of doc.

---

## 9. Skill accumulation (slide 37, Voyager) — interesting but not for us

Voyager-style skill libraries (each new skill = executable code added to the inventory) are cool but **overkill for Deliveroo**:

- Game has a fixed action set (move, pickup, putdown).
- We don't need new "skills" emerging — we need our existing tools used well.

**One-liner for the report:** mention Voyager as related work, note we don't need it because Deliveroo's action space is small and fixed.

---

## 10. Tool transitions (slide 36, Chameleon) — useful for evaluation

> After tool X, how likely is tool Y?

For our project this is **a free piece of analysis for the report**:

- Log every tool call sequence during evaluation games.
- Build a transition matrix.
- Insights: "after `get_parcels`, the LLM uses `score_parcel` 80% of the time → consider merging into a single `get_scored_parcels` tool."

This is exactly the kind of data-driven design refinement the slide advocates and looks great in the final report.

---

## 11. Concrete locked-in design decisions for Part 2

Adding to / refining the choices from `04_llm_agents.md`:

1. **LLM is strategic, not tactical.** Per-tick decisions stay in BDI. LLM is invoked for: parsing NL objectives, coordination decisions, replanning when BDI is stuck, end-of-game reflection.
2. **Compound-error budget:** target ≤ 10 LLM decisions per game. If we need more, we're using the LLM wrong.
3. **MCP-style architecture, no MCP library.** Tool dispatcher in front of BDI public API. Structured errors. Dynamic tool discovery (LLM can call `list_tools()`).
4. **Tool catalog v0** = 9 tools (listed in §8). Refine via ablation.
5. **Every tool declares `category: "read" | "write"`.** Write tools go through extra validation.
6. **Strict JSON schemas** + server-side parameter validation + structured rejections so the LLM can self-correct.
7. **Tool transitions logged** for the report's evaluation section.
8. **No Voyager-style skill accumulation.** Static catalog is fine.

---

## 12. Things to AVOID

- **Don't let the LLM emit raw actions** (move, pickup) directly. It must go through tools that route to BDI.
- **Don't put every BDI internal in the tool catalog.** More tools = worse selection. Only expose what the LLM strategically needs.
- **Don't write long tool descriptions.** Slide explicitly warns about description bloat → context exhaustion.
- **Don't trust LLM-generated parameter values without validation.** Param hallucination is real.
- **Don't make tool calls free-text.** Structured args, structured errors.

---

## 13. Open / TBD

- **What is the course-provided tool catalog?** The project deck says it'll be on a server but we haven't seen the schema. Until then, our internal tools are our concern; the course-provided ones plug in alongside when revealed.
- **LLM API choice for Part 2.** Course says "LLM available on a server, accessible via API using an access token." Function-calling format depends on which model — we'll abstract via a thin adapter layer.
- **Latency budget per LLM call.** If LLM is slow (>1s), we must ensure no game-critical decision blocks on it. The LLM agent runs *concurrently* with the BDI loop, not serially.
