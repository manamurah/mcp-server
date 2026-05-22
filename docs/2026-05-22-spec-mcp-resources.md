# Spec: MCP Resources for manamurah MCP server

**Status:** Draft spec — not yet implemented. Implements Tier-1 item #1 of
[`2026-05-22-mcp-enhancement-proposals.md`](./2026-05-22-mcp-enhancement-proposals.md).
**Created:** 2026-05-22
**Target server:** `manamurah-mcp-server` (this repo) — TS Cloudflare Worker, `src/index.ts`.
**Server version impact:** minor bump `2.6.0 → 2.7.0` (additive; new capability, no breaking change).
**Protocol version:** `2024-11-05` (Resources are supported; unchanged).

## 1. Goal

Expose stable **reference data** as MCP Resources so a Host can load it as
context without spending a tool call. Whitepaper rationale: Resources are
"contextual data accessed by the Host"; "use external systems for data storage"
rather than pushing bulk reference data through tools. Concretely this kills the
recurring `search_items → item_code → real tool` round-trip and gives any agent
the catalogue, geography, chain list, data freshness, and methodology up front.

### Non-goals (deliberate)

- **No subscriptions / `listChanged` notifications.** The Worker is stateless and
  reference data changes only on the weekly ETL. Clients re-read; we rely on the
  upstream 12h KV cache. (Whitepaper warns stateful persistent connections add
  architectural cost.) Capability advertised as `{ listChanged: false }`.
- **No query results as resources.** Price history / cheapest / movers stay as
  **tools** (they are actions/queries, not contextual reference data). Only stable
  reference data and docs become resources. This keeps the tool/resource split
  clean per the whitepaper.
- **No new auth.** Same posture as tools: public, read-only.

## 2. Resource catalogue (proposed)

Fixed resources (returned by `resources/list`):

| URI | Name | MIME | Source (upstream) | Notes / size |
|---|---|---|---|---|
| `manamurah://catalogue/items` | Item catalogue | `application/json` | `GET /api/v2/mcp/catalogue/items` *(new)* | ~756 items. **Lean fields only:** `item_code, name, name_en, unit, item_category`. Omit zh/ta + aliases to control size (~40–60 KB). Include `weekdate` for freshness. |
| `manamurah://catalogue/states` | States & federal territories | `application/json` | `GET /api/v2/mcp/catalogue/states` *(new)* | 16 rows: `stateid, name, slug, region`. Tiny. |
| `manamurah://catalogue/categories` | Item categories | `application/json` | `GET /api/v2/mcp/catalogue/categories` *(new)* | ~40 rows: `category, item_count`. Tiny. |
| `manamurah://catalogue/chains` | Retail chains | `application/json` | reuse `list_chains` upstream | ~50 rows: `name, premise_count, chain_type, states`. Mirrors the `list_chains` tool output. |
| `manamurah://meta/latest-week` | Data freshness | `application/json` | `GET /api/v2/mcp/meta/latest-week` *(new)* | `{ latest_weekdate, premises_reporting, items_with_data }`. The canonical freshness signal; lightweight precursor to proposal #4 (coverage). |
| `manamurah://docs/methodology` | Methodology & caveats | `text/markdown` | `GET /api/v2/mcp/docs/methodology` *(new, or static)* | The `/about` essentials: weekly-average cadence, equal-premise weighting, outlier filtering, sparse-data caveats (n≥30 guidance). Lets any agent cite correct caveats. |

### Resource templates (RFC 6570) — `resources/templates/list`

Optional in v1 (see Open Questions). Candidate:

| URI template | Purpose | Source |
|---|---|---|
| `manamurah://item/{item_code}` | Single item "reference card": name, unit, category, latest national avg price, premise count, freshness. | `GET /api/v2/mcp/catalogue/item/{item_code}` *(new)* |

Templates let a Host read one entity as context (`resources/read` with a concrete
URI) without a query tool. Kept minimal — only the entity card, not history
(history is a tool).

## 3. Protocol changes (Worker, `src/index.ts`)

### 3.1 Capabilities (`handleInitialize:632`, root manifest `:929`)

```diff
- capabilities: { tools: {}, prompts: {}, resources: {} }
+ capabilities: { tools: {}, prompts: {}, resources: { listChanged: false } }
```

### 3.2 New / changed JSON-RPC methods (`handleMCP:701`)

- `resources/list` — replace the current empty stub (`:710`) with the fixed
  catalogue (mirror the `TOOLS`-style static array → new `const RESOURCES`).
  Each entry: `{ uri, name, title, description, mimeType }`.
- `resources/read` — **new.** Params `{ uri }`. Steps:
  1. Look up `uri` in a **fixed allowlist** (the `RESOURCES` array + template
     matcher). **Never interpolate the raw URI into a fetch** — map allowlisted
     URI → fixed upstream path. (Security: prevents SSRF / confused-deputy; the
     whitepaper's strict-allowlist + input-validation guidance.)
  2. Unknown/again-not-allowlisted URI → JSON-RPC `-32602` with an **actionable**
     message (e.g. `"Unknown resource <uri>. Call resources/list for the catalogue."`).
  3. Proxy via the existing `callUpstream` pattern (`:581`).
  4. Return `{ contents: [{ uri, mimeType, text }] }` (JSON resources: `text` =
     `JSON.stringify(data)`; methodology: raw markdown).
- `resources/templates/list` — **new.** Return the URI templates (or `[]` if we
  defer templates to v2).

### 3.3 Telemetry (`src/analytics.ts`, `CallMeta`)

- Add an optional `resource` field to `CallMeta` (the resolved resource name or
  template id), analogous to `tool`. Populate in the `resources/read` handler.
- `recordMcp` already captures `method`; `resources/list` and `resources/read`
  flow through the same boundary instrumentation at `:828`. No privacy concern —
  URIs are non-sensitive.

### 3.4 Discovery surfaces

- **Server card** (`:867`) — add a short note in `description` ("…tools + N
  reference resources") and optionally a `_meta.resource_count`.
- **Root manifest** (`:911`) — add `resource_count` and a `resources` array
  mirroring how `tools` is exposed, so registries index resources in one GET.
- **Changelog** (`src/changelog.ts` + root `CHANGELOG.md`) — add the `2.7.0` entry.

## 4. Content shape (MCP `resources/read` result)

```json
{
  "contents": [
    {
      "uri": "manamurah://catalogue/states",
      "mimeType": "application/json",
      "text": "{\"weekdate\":\"2026-05-18\",\"states\":[{\"stateid\":1,\"name\":\"Johor\",\"slug\":\"johor\",\"region\":\"semenanjung\"}, ...]}"
    }
  ]
}
```

Every JSON resource payload carries a `weekdate` (or `generated_at`) so clients
can reason about freshness without reading `meta/latest-week` separately.

## 5. Upstream work (manamurah.com `/api/v2/mcp/*`)

The Worker is a thin proxy; resources need backing endpoints. Audit + build:

- **Reuse:** `chains` (existing `list_chains` upstream).
- **New, thin (ES aggregations / lookups already used by the SvelteKit app):**
  `catalogue/items`, `catalogue/states`, `catalogue/categories`, `meta/latest-week`,
  `catalogue/item/{item_code}` (if templates land).
- **New, static-ish:** `docs/methodology` — could be a static markdown blob
  (mirror of `/about`) served by the upstream, or embedded in the Worker like
  `changelog.ts`. Embedding avoids an upstream round-trip; prefer embed if the
  text is short and stable.

Each new endpoint must return the standard `{ status, reason, warnings, data }`
envelope for passthrough consistency.

## 6. Size / token discipline

Whitepaper: "design for concise output." Only `catalogue/items` is sizable.
Mitigations: lean field set (5 fields), no inline translations beyond `name_en`,
and an assertion in tests that the serialized items resource stays under a budget
(target < 80 KB). States/categories/chains are trivially small.

## 7. Testing / eval

Add (this repo currently has no tests):

- `resources/list` returns the expected URIs + required fields.
- `resources/read` for each fixed URI returns valid `contents` with correct MIME.
- Unknown URI → `-32602` with the actionable message.
- Allowlist enforcement: a crafted URI that isn't in the catalogue never triggers
  an upstream fetch (SSRF guard).
- `resources/templates/list` returns valid RFC-6570 templates (if shipped).
- Size budget assertion on `catalogue/items`.

## 8. Build sequence

1. **Upstream** — add the 4–5 new `/api/v2/mcp/*` endpoints (+ envelope), or
   confirm existing aggregations can be reused.
2. **Worker** — `RESOURCES` const + `resources/list` + `resources/read`
   (allowlisted dispatch) + `resources/templates/list` + capabilities + telemetry
   field + version bump `2.7.0` + discovery surfaces.
3. **Tests** — section 7.
4. **Deploy** — `wrangler deploy` (auto via the `manamurah5`-style flow), then
   verify `resources/list` / `resources/read` over the live `/mcp` endpoint and
   confirm the server card / root manifest reflect the new count.

## 9. Open questions for review

1. **Templates in v1?** Ship `manamurah://item/{item_code}` now, or fixed
   resources only and add templates later? (Leaning: ship the one item-card
   template — high value, low cost.)
2. **Items catalogue fields** — lean (`code, name, name_en, unit, category`) vs
   include all translations (zh/ta/ms aliases)? (Leaning: lean, for size.)
3. **Methodology source** — embed a curated MCP methodology blob in the Worker
   (like `changelog.ts`), or proxy the live `/about` content? (Leaning: embed —
   stable, no round-trip.)
4. **`meta/latest-week` now vs fold into proposal #4 (coverage tool)?** The
   freshness resource overlaps the future coverage work. (Leaning: ship the
   lightweight freshness resource now; richer per-item coverage stays in #4.)
5. **`name_en` only or full multilingual** in the item card — depends on expected
   client locales.

## 10. References

- Parent proposal: `docs/2026-05-22-mcp-enhancement-proposals.md`
- Whitepaper: <https://www.kaggle.com/whitepaper-agent-tools-and-interoperability-with-mcp>
- Code anchors: capabilities `src/index.ts:632` + `:929`; method dispatch `:701`;
  empty `resources/list` stub `:710`; `callUpstream` `:581`; server card `:867`;
  root manifest `:911`; telemetry `src/analytics.ts` (`recordMcp`, `CallMeta`).
