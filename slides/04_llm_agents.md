# Slide 04 — LLM Agents (Memory, RAG, Long Context)

**Source:** "LLM Agents" deck, Prof. Giorgini, ASA A.A. 2025-2026

This deck is broad — it covers the whole LLM-agent / RAG curriculum. **Most of the RAG depth (BM25, embeddings, chunking, reranking, vector DBs, text-to-SQL) is not load-bearing for our Deliveroo Part 2 agent**, because we don't have a static document corpus — our "memory" is the live game state. This note keeps only what is actionable for us, with the broader RAG content captured at survey level for the exam/report.

---

## 1. The headline distinction (slide 2-3) — the framing for Part 2

| | LLM | **LLM agent** |
|---|---|---|
| Behavior | **Responds** to a prompt with text | **Acts** in the world to achieve a goal |
| Output | Information / suggestions | Actions via tools / APIs |
| Slide quote | *"LLM responds."* | *"LLM agent acts."* |

For our project, Part 2 is explicitly an LLM **agent**: it must read a natural-language objective, reason, decide actions, and call tools that affect the game.

---

## 2. The four core components of an LLM agent (slide 3) — must-haves for Part 2

The slides list these as **required components**:

1. **LLM as controller** ("brain") — decides what to do.
2. **Planning module** — decomposes the objective into steps.
3. **Memory module** — stores context, past actions, observations.
4. **Tool-usage module** — calls APIs / tools.

The course will provide the **tool catalog** on a server (per the project description deck). So our work on Part 2 is: controller prompt + planning loop + memory management + tool dispatcher.

---

## 3. The three memory mechanisms (slides 11-15)

Slide gives a clean three-tier model. Map each tier to our agent:

| Tier | What it is | In our Deliveroo LLM agent |
|---|---|---|
| **Internal knowledge** | Baked into model weights (training, fine-tuning) | The LLM's general world knowledge — we don't touch it. |
| **Short-term memory** | The context window: current task, conversation, intermediate reasoning | **Where 90% of our work lives.** Holds: current objective, BDI beliefs snapshot, current intention, recent observations, tool catalog, last few tool results. |
| **Long-term memory** | External (vector DB, logs, RAG) | Mostly overkill for us. *Maybe* useful for: cross-game learning ("strategies that worked"), failure logs, past objectives the user issued. Can be implemented as a JSON file, not a vector DB. |

### The key takeaway for us

> **Don't build a RAG stack we don't need.** Our agent operates on game state, not a document corpus. Short-term context is sufficient. If we hit context limits, summarize old observations into a "world summary" string — same idea as RAG but without the infrastructure.

The slides explicitly note (slide 14, "Memory hierarchy"): *"Information that is rarely needed → long-term memory."* For Deliveroo, almost everything is needed *now*. So short-term dominates.

---

## 4. Memory management strategies (slides 17-18) — what we'll actually use

The slides walk through:

- **FIFO** — remove oldest first. Cheap, but loses important early context.
- **Remove redundancy** — collapse duplicate observations.
- **Summarize conversations** — compress old turns into summaries. ✅ This is what we'll use.
- **Track named entities** — keep parcel IDs, player IDs, key tile coordinates pinned even when summarizing.

### Reflection-based memory (slide 18) — directly applicable

> After each action, the agent reflects on new information and decides whether to **add, merge, or replace** memory.

**This is exactly what our LLM agent needs after each tool call.** Pattern:

```
1. Call tool → get result
2. Reflect: is this consistent with current beliefs?
3. If consistent: add to memory
4. If contradictory: merge or replace (slide says: "keep newest" or "ask model to judge")
5. If redundant: skip
```

Maps directly to Bratman's belief revision (slide 03) — the LLM agent's `brf` is implemented as a reflection step.

### Handling contradictions

The slide gives two strategies:
1. Keep newest information.
2. Ask the model to judge which to keep.

For Deliveroo: **default to "keep newest"** for game-state observations (positions decay fast); **ask the model to judge** when there's a strategic contradiction (e.g., BDI agent says parcel X is mine, LLM observation suggests another agent is closer).

---

## 5. RAG (slides 19-32) — capture at survey level only

We will **not** implement RAG. But the report should mention we considered it and rejected it. Brief survey:

- **Term-based (BM25, TF-IDF):** keyword overlap, cheap, brittle to paraphrase.
- **Embedding-based:** semantic, supports paraphrase / synonyms, costs more.
- **Hybrid (rerank):** cheap retrieval first, then expensive reranker on top-k.
- **Query rewriting** — rewrite ambiguous queries with LLM/heuristics.
- **Contextual retrieval** — augment chunks with metadata, summaries, FAQ-style questions.

Why we reject it for Deliveroo:
- Documents we'd retrieve from = game observations, which are tiny and structured.
- Retrieval latency would compete with our deliberation budget.
- The decay-fast / change-fast nature of game state means cached embeddings go stale.
- For us, "memory" is just a JSON object passed in the prompt.

---

## 6. Long-context models vs RAG (slides 43-46) — directly relevant to our choice

Slide makes the case **for long context**:

- "Brute force" — 4K → 1M+ tokens.
- No infrastructure: no chunking, no embedding model, no vector DB, no reranker.
- No "retrieval lottery" — no silent failures.
- No "whole book" problem.

Slide 44 shows current windows (Gemini/GPT 1M, Claude 200K, etc.). For us:

- **Our entire game state** (map + visible parcels + visible players + history) easily fits in **<5K tokens** if represented compactly.
- We don't need 1M context. **8K-32K is plenty.**
- This validates "no RAG" — we just dump the world into context.

But slide 45 warns:

- **"Re-reading tax"** — long context is reprocessed every query. Mitigation: **prompt caching** (Claude/OpenAI both support this) — pin static parts of the prompt (tool catalog, system instructions) and only the variable observations change.
- **"Needle in haystack"** — performance degrades on long inputs. Mitigation: keep our prompt compact and structured; don't dump raw event logs.
- **Performance degrades as context grows** (slide 46).

### Concrete takeaway

Use a moderate context window (Claude Sonnet 4.6 = 200K is way more than enough). Use prompt caching. Compact representations of game state (JSON, not prose).

---

## 7. Context compaction (slide 47) — applicable when sessions get long

> Long context isn't free; maintaining it requires compression, which can degrade quality.

Tools like Codex, Claude, and antigravity **summarize** old context. We adopt the same pattern:

- Recent ticks: keep verbatim observations.
- Older than N ticks: collapse to a per-parcel/per-agent **summary** ("agent X was last seen at (4,7) heading north, score 12, 3 ticks ago").
- Summary regenerated every M ticks by a cheap LLM call (or a JS reducer).

---

## 8. Agentic memory / agentic search (slides 48-58)

The deck cites a 2026 MIT CSAIL paper on **agentic file search**: the agent treats memory as a file system / Python environment and reads/manipulates it via tool calls (`read_index`, `read_page`, etc.) instead of vector retrieval.

> *High accuracy — no semantic search.*

For our purposes, this is **the model**:

- The LLM agent's "memory" is a structured object (JSON / dict).
- It has tools: `getBeliefs()`, `getCurrentIntention()`, `getParcels()`, `getPlayers()`, `getMap()`, `proposeIntention()`.
- The LLM calls these on demand instead of having everything dumped into context every turn.

This is **lighter than RAG, cleaner than long-context dumps, and matches the "tool-based agent" framing the project description deck assumes.**

### Memu (slides 53-58)

Mentioned as another agentic memory approach. Not core to our design but worth a one-line mention in the report's related-work section.

---

## 9. Direct implications for our LLM agent (Part 2)

Locked-in design choices for Part 2 based on this deck:

1. **No RAG / no vector DB.** Memory = structured JSON + LLM context.
2. **Three memory tiers, but skewed:**
   - Internal knowledge: rely on the LLM's training (Claude 4.x).
   - Short-term: structured prompt with current beliefs, intention, recent observations, tool catalog.
   - Long-term: optional, simple JSON log of past objectives + reflections (no embeddings).
3. **Reflection-based update after each tool call** — add/merge/replace memory entries. This is the LLM agent's `brf`.
4. **Compaction by summarization** — agents and parcels older than N ticks collapse into a one-line summary entry.
5. **Agentic search pattern (MIT-style):** the LLM agent has tools to *query* its own memory rather than receiving everything in context. Tools at minimum:
   - `get_beliefs()` — full BDI belief snapshot
   - `get_parcels(filter?)` — parcels matching a filter
   - `get_players()` — known agents and their last-seen state
   - `get_intention()` — current BDI intention (for handoff / coordination)
   - `propose_intention(intention)` — LLM tells BDI to commit
   - `claim_parcel(parcelId)` — claim coordination (shared belief)
6. **Prompt caching** for static parts (system prompt, tool catalog, immutable map). Only observations change per turn.
7. **Compact JSON representations** of game state — never prose dumps.
8. **Planner = LLM with ReAct / Reflexion** — but Chain-of-Thought is the floor (cheapest). Use Reflexion only on failure (after a plan didn't work, ask the LLM to reflect and retry).

---

## 10. Two-agent coordination (Part 2 — referenced from earlier slides, reinforced here)

The earlier project-description deck said the LLM agent and BDI agent must:
- Exchange beliefs
- Coordinate (e.g., closest agent commits to a parcel)

This deck adds **the mechanism**: the LLM agent calls **tools** to read BDI beliefs and propose commitments. So the BDI agent's public API (already planned in our `ARCHITECTURE.md`) becomes the **tool catalog** for the LLM agent.

Mapping:

| BDI public API method | Becomes LLM tool |
|---|---|
| `getBeliefs()` | `get_beliefs` |
| `proposeCommitment(parcelId)` | `propose_commitment` |
| `claimParcel(parcelId)` | `claim_parcel` |
| `getCurrentIntention()` | `get_current_intention` |

This means **Part 1 architecture decisions force Part 2 structure**. Worth explicitly designing the BDI public API now even though Part 2 is later.

---

## 11. Things to AVOID

- **Don't build RAG.** No vector DB, no embeddings, no chunking. Wrong tool for the job.
- **Don't dump raw event streams** into the LLM context — use compact JSON; the slides show context degrades on noisy long inputs.
- **Don't have the LLM make every game decision.** Latency kills us. The LLM is for: understanding natural-language objectives, replanning when BDI is stuck, multi-agent coordination decisions. Routine action selection stays in BDI.
- **Don't rely on FIFO** for memory — slide explicitly notes early information may still be important.
- **Don't conflate** the LLM-agent's "context" (short-term) with the BDI-agent's "belief base" — they're different objects that share data via the tool API.

---

## 12. Open / TBD

- **Which LLM model** does the course server provide via API? (Slides reference Gemini/GPT/Claude, but the project description says "LLMs available on a server, accessible via API using an access token.") Affects context size and prompt-caching availability.
- **Tool catalog** — exact list and shape will be provided by the course. Until then, we design the BDI public API as the *minimal* tool surface and assume the course catalog is a superset.
- **Latency budget** for an LLM call vs a BDI cycle. If LLM latency >> tick rate, the LLM agent must run *out of band* (background "reflection thread") rather than in the main loop.
