# manamurah MCP — Enhancement Proposals (from Google/Kaggle MCP whitepaper)

**Status:** Proposal — not yet scoped or built. Revisit when prioritising MCP work.
**Created:** 2026-05-22
**Source whitepaper:** "Agent Tools & Interoperability with MCP", Google/Kaggle 5-Day AI Agents Intensive (Nov 2025).
<https://www.kaggle.com/whitepaper-agent-tools-and-interoperability-with-mcp>

## Why this doc exists

Audited the live manamurah MCP server against the whitepaper's tool-design and
MCP-interoperability principles. This captures where we already align and the
gaps worth closing, tiered by leverage. Nothing here is committed work.

## Current state (as audited 2026-05-22)

- **Live server:** `manamurah-mcp-server` (this repo) — pure TypeScript on a
  Cloudflare Worker, zero deps, hand-written JSON-RPC 2.0. Entry `src/index.ts`.
- **Endpoint / transport:** `https://mcp.manamurah.com/mcp`, Streamable HTTP, CORS `*`.
- **Tools:** 14 total (11 KPDN PriceCatcher weekly + 3 FAMA daily), statically
  defined in `src/index.ts:139–572` with inline JSON Schema inputs.
- **Architecture:** thin proxy → `manamurah.com/api/v2/mcp/<tool>` → Elasticsearch,
  with a 12h KV edge cache upstream. Worker holds no creds, no DB access.
- **Output envelope:** `{ status:"ok"|"error", reason?, warnings:[], data:{...} }`,
  wrapped into MCP `content` + `structuredContent`.
- **MCP primitives implemented:** Tools only. No Resources (`src/index.ts:711`),
  Prompts (`:709`), Sampling, Elicitation, Roots, Completions, or cursor pagination.
- **Auth:** none — public, read-only. Rate limit 120 req/60s per IP (enforced upstream).
- **Observability:** Workers Analytics Engine telemetry at the JSON-RPC boundary
  (`src/analytics.ts`, `recordMcp`), 100% sampled, metadata only (no args/payloads).
- **Reference impl:** Python/Pydantic server at
  `manamurah-data/.../manamurah-mcp-2026` (separate repo) — defines the same tool
  schemas a second time.

## Where we already align (don't re-propose)

| Whitepaper principle | manamurah status |
|---|---|
| "Publish tasks, not API calls; no thin wrappers" | ✅ `find_cheapest`, `basket_watch`, `region_gap`, `top_movers` are task-shaped |
| "Use validation effectively" (strict input schemas) | ✅ inline JSON Schema, `additionalProperties:false`, enums, min/max |
| "Streamable HTTP is the recommended remote transport" | ✅ |
| "MCP lacks observability primitives" (a gap they flag) | ✅ we already have WAE telemetry — ahead of baseline |
| "Least privilege; scoped credentials" | ✅ public read-only is risk-matched for open price data; no OAuth needed |

Gaps cluster in: **MCP primitives beyond tools**, **output token discipline**,
and **schema-as-single-source**.

## Proposed enhancements (tiered)

### Tier 1 — high leverage, directly whitepaper-driven

1. **Expose MCP Resources for reference data.**
   Today: zero resources (`src/index.ts:711`). Publish item catalogue, state list,
   chain list, latest-week metadata, and the `/about` methodology as Resources
   (e.g. `manamurah://catalogue/items`, `manamurah://meta/latest-week`).
   *Whitepaper:* Resources = "contextual data accessed by the Host"; "use external
   systems for data storage" rather than pushing bulk data through tools.
   *Win:* agents stop burning a `search_items` call just to learn item codes.

2. **Argument completions (autocomplete).**
   Add a `completion/complete` handler for `item` / `state` / `chain` / `category`
   params. Kills the constant `search_items → item_code → real tool` round-trip —
   the single biggest friction in the current toolset. Low risk.

3. **MCP Prompts that encode our analysis discipline.**
   Today: zero prompts (`src/index.ts:709`). Ship templates: `semak-dakwaan-harga`
   (fact-check a price claim), `basket-bulanan`, `banding-bandar-vs-nasional`.
   These mirror the existing `manamurah-price-analysis` jin skill — surfacing them
   as MCP prompts makes the same rigor portable to any MCP client.
   *Whitepaper:* Prompts = "reusable prompt templates related to its Tools and Resources."

4. **Make coverage/freshness first-class.**
   Add a `data_coverage` tool/resource returning `premise_count`, latest `weekdate`,
   and a reliability flag per item/scope.
   *Why it matters:* the `manamurah-price-analysis` skill enforces an n≥30 threshold
   *manually* to avoid sparse-data false signals (ref incident: 2026-05-04 weekly
   recap headlined "Daging Topside +14.8%" at n=11, RM19.99–72.90 spread). Exposing
   coverage as structured data lets any agent self-enforce it.
   *Whitepaper:* "structured outputs, annotations on fields"; descriptive/actionable design.

### Tier 2 — token efficiency & contract quality

5. **Output conciseness + declare `outputSchema`.**
   *Whitepaper:* "Design for Concise Output… don't return large responses [that]
   swamp the output context." `category_trends` returns ~25 categories each with
   nested riser/faller objects — heavy. Add: (a) a `summary` mode dropping nested
   objects; (b) cursor pagination for `top_movers` / `find_cheapest` /
   `category_trends`; (c) declare `outputSchema` per tool (we already emit
   `structuredContent`) so clients validate without parsing prose.

6. **Actionable error messages.**
   The `{status, reason, warnings}` envelope has good structure, but the whitepaper
   insists errors "give instructions to the LLM about what to do to address [it]."
   Upgrade `reason` from "no data" to e.g. "no data for item 1201 this week; it was
   discontinued after May 2022 — try `search_items` for an active substitute or
   widen scope to `region`."

### Tier 3 — maintainability & eval

7. **Single-source the tool schemas (anti-drift).**
   Schemas are hand-written twice — TS Worker (`src/index.ts:139–572`) and Pydantic
   (`manamurah-mcp-2026/.../models.py`). The whitepaper treats the schema as the
   contract; two copies will drift. Generate the Worker `TOOLS` array from the
   Python models, or fetch the tool list from upstream at deploy time.

8. **Eval / test harness.**
   No tests in this Worker repo. Add a golden-query suite asserting schema
   conformance, **output-size budgets** (catches token-bloat regressions), and
   latency SLOs in CI. Whitepaper flags evaluation as a systemic MCP gap.

## Recommendation

- **Minimum viable trio:** 1 (Resources) + 2 (Completions) + 4 (Coverage) — they
  remove the most agent friction and are low-risk additions to a stateless Worker.
- **Highest strategic value:** 3 (Prompts) — turns the price-analysis playbook into
  a portable, multi-client asset.
- **Main tradeoff:** every new primitive adds surface area to a currently dead-simple
  proxy. Each needs its own upstream `/api/v2/mcp/*` endpoint + a telemetry line.
  Resources + Completions share the catalogue backend, so brainstorm them together.

## Not recommended (deliberately out of scope)

- Heavy auth / OAuth / scopes — the whitepaper spends pages here, but it's aimed at
  write-capable, multi-tenant, enterprise servers. Our data is public and read-only;
  adding auth would be cost without risk reduction. Reassess only if a write tool
  (beyond the existing read-only `basket_watch` POST) is ever introduced.
- RAG-style tool discovery (the whitepaper's fix for "context window bloat") — only
  matters at dozens-to-hundreds of tools. At 14 tools our bloat risk is in tool
  *outputs*, not tool *count*; address via Tier 2 instead.

## Key references

- Whitepaper: <https://www.kaggle.com/whitepaper-agent-tools-and-interoperability-with-mcp>
- Review notes (verbatim principles): <https://medium.com/@patmcc1979/reviewing-googles-agent-tools-interoperability-with-mcp-whitepaper-74f153e8edb3>
- Course guide: <https://sharehub.zorro.hk/documents/2025-11-17-kaggle-5day-ai-agents-complete-guide.html>
- Live server entry: `src/index.ts` (tools `:139–572`, resources `:711`, prompts `:709`)
- Telemetry: `src/analytics.ts` (`recordMcp`)
- Reference impl + Pydantic schemas: `manamurah-mcp-2026` repo
