# MCP enhancements — cross-cutting build prerequisites

**Status:** Prerequisite note — must be in place before implementing #1 Resources and #3 Prompts.
**Created:** 2026-05-22 (from the three 7-persona reviews + user direction)

Three themes recurred across every review (Resources, Completions, Prompts): **drift**, **ES
fan-out**, and **output/context bloat**. They are not per-feature problems — they are shared
foundations. Build these first; do **not** start Prompts until Resources + the shared
methodology/types exist.

## 1. `src/mcp-types.ts` — one source for protocol-envelope types

Today the protocol types are re-declared per spec (and already diverging: #3 widened the
embedded-resource `mimeType` to bare `string`). Consolidate into a single module:

- `MCPResource`, `ResourceContents` (Resources #1)
- `CompletionRef = PromptReference | ResourceTemplateReference`, `Completer`, `CompletionContext`
  (Completions #2). Note: the resource-template ref type is **`ResourceTemplateReference`**, not a
  generic `ResourceReference` (per the MCP completion spec).
- `PromptDef`, `PromptArgument`, `PromptMessage`, `PromptContent` (text | resource, **closed**
  union, `mimeType: 'text/markdown'`) (Prompts #3)
- The JSON-RPC envelope helpers if useful.

Everything stays `strict: true`; use `Map.get`/`.find` (already `T | undefined`) — never bare `[]`
under the repo's `noUncheckedIndexedAccess: false`.

## 2. `src/methodology.ts` — canonical discipline source (single-source)

The price-analysis discipline currently lives verbatim in BOTH the jin
`manamurah-price-analysis` skill AND (proposed) the Prompts template — and the **skill itself
already carries two divergent verdict encodings** (`affirms/rebuts/partial` vs
`sahih/tidak tepat/separa tepat`). Fix the drift at the root:

- `methodology.ts` is the **one** place that defines:
  - the **coverage thresholds**: headline n≥30; cross-state n≥100 national + ≥10/state;
    mention-with-caveat n≥5; <5 on the claim's item → `data tidak cukup`.
  - the **canonical verdict set** (pin ONE): `sahih` / `tidak tepat` / `separa tepat` /
    `data tidak cukup`.
  - the **Ringkas-lede rule** (40–60 words, lead with claim, bold verdict).
  - the methodology prose (weekly-average cadence, equal-premise weighting, outlier filtering),
    kept **≤ ~400 tokens**.
- It is the embedded const the Prompts `render` references (don't restate) AND the methodology
  Resource served by #1.
- The jin `manamurah-price-analysis` skill becomes a **documented downstream consumer** that cites
  it; reconcile its two verdict encodings to the canonical set.

## 3. One generated catalogue source — feeds BOTH the resource and the completers

`catalogue/items` (the Resource) and the completion completers BOTH need item data. **Generate
both from one source — do not hand-curate two shapes** (user direction 2026-05-22). Concretely:

- A single generator (ETL-side or a build step) emits the canonical catalogue: `item_code, name`
  (Malay), `name_en` (**required** — user decision), `unit`, `item_category`, **filtered to items
  active in the last ~12 weeks** (recent-active; drops discontinued like 1201).
- The Resource `catalogue/items` serves it; the completer reads the **embedded** form (zero-network
  keystrokes). Same bytes, one generator — no drift between "what the catalogue lists" and "what
  completion suggests".
- Size budget: < 100 KB serialized (the recent-active filter is the lever that keeps it bounded).
- Refresh: regenerate on the CF Workers Builds cadence (embedded = fresh-as-of-deploy; acceptable
  for names + recent-active membership).

## 4. CI drift checks (make drift impossible to merge)

Drift was flagged in all three reviews. Add these as CI gates:

- **Tool-name parity:** Worker `TOOLS` vs the Python ref (`manamurah-mcp-2026`) vs README/
  package.json counts (already drifted once: 14 vs 15). Assert equal.
- **Prompt→tool-name parity:** every tool named in a prompt `render` template exists in `TOOLS`.
- **Discipline tripwire:** the thresholds/verdict strings used in `render` match the
  `methodology.ts` const (catches skill↔prompt drift).
- **Type consolidation:** no protocol-envelope type re-declared outside `mcp-types.ts`.
- **No-ES-in-hot-path:** `prompts/get`, `completion/complete`, and `render` perform no `fetch`
  (in-memory only).
- **Catalogue size gate:** `catalogue/items` serialized < 100 KB.

## 5. ES / tool-call budget rules (functional safety, not docs)

`prompts/get` is free, but **executing** an analytical prompt fans out to 5–15 tool calls = ES
queries on the capacity-constrained, RAM-hour-billed cluster — popularity is the cost event. Treat
the budget language as **functional safety baked into every prompt's `render`**, not
documentation:

- Explicit **tool-call budget** in each analytical prompt (≤ ~6 calls for fact-check).
- "Read reference data (item/state/chain lists) from the **in-context catalogue/resources** — do
  NOT tool-call to enumerate them."
- **Conditional FAMA** (only for value-chain-markup claims).
- `basket-bulanan` MUST use **one batched `basket_watch`**, not a per-item loop; basket capped at
  the `basket_watch` maxItems (20).
- No redundant re-queries.

## 6. Build order

1. **`mcp-types.ts` + `methodology.ts` + the generated catalogue source** (this note).
2. **#1 Resources** (`2.8.0`) — embedded methodology + catalogue consts, fixed resources only,
   recent-active + `name_en` catalogue, edge-cache, allowlist `Map<uri,upstreamPath>`.
3. **#3 Prompts + Completions** (`2.9.0`) — 3 prompts (English control plane / BM answer plane),
   completers co-located on prompt args, CF rate-limit binding, 10%-sampled completion telemetry,
   the CI drift checks above.

Do not start step 3 until step 2 and the shared foundation (step 1) are in place.

## References

- Specs: `2026-05-22-spec-mcp-resources.md` (#1), `2026-05-22-spec-mcp-completions.md` (#2,
  design reference), `2026-05-22-spec-mcp-prompts.md` (#3).
- Reviews: `reviews/2026-05-22-MCP1-FEATURES/`, `.../MCP2-COMPLETIONS/`, `.../MCP3-PROMPTS/`
  (each with `CONSOLIDATION.md`).
- MCP completion spec: <https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion>
