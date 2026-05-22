# Spec: MCP Resources for manamurah MCP server

**Status:** Reviewed & revised (v2, 2026-05-22) — incorporates the 7-persona review in
[`reviews/2026-05-22-MCP1-FEATURES/`](./reviews/2026-05-22-MCP1-FEATURES/) (see
[`CONSOLIDATION.md`](./reviews/2026-05-22-MCP1-FEATURES/CONSOLIDATION.md)). Not yet implemented.
Implements Tier-1 item #1 of [`2026-05-22-mcp-enhancement-proposals.md`](./2026-05-22-mcp-enhancement-proposals.md).
**Created:** 2026-05-22 · **Revised:** 2026-05-22 (post-review)
**Target server:** `manamurah-mcp-server` (this repo) — TS Cloudflare Worker, `src/index.ts`.
**Server version impact:** minor bump `2.6.0 → 2.7.0` (additive; new capability, no breaking change).
**Protocol version:** `2024-11-05` (Resources supported; unchanged).

> **Review outcome:** ship v1 with **fixed resources only** (item template deferred to
> v2). Four changes are mandatory before merge — table-driven allowlist dispatch,
> edge-caching, TypeScript interfaces, and literal `resources/list` copy. No reviewer
> found a Critical issue; architecture rates the design Low risk.

## 1. Goal

Expose stable **reference data** as MCP Resources so a Host loads it as context
without spending a tool call. Whitepaper rationale: Resources are "contextual
data accessed by the Host"; "use external systems for data storage" over pushing
bulk reference data through tools. Concretely this kills the recurring
`search_items → item_code → real tool` round-trip and hands an agent the
catalogue, geography, chains, data freshness, and methodology up front.

### Non-goals (deliberate)

- **No subscriptions / `listChanged`.** The Worker is stateless; reference data
  changes only on the weekly ETL. Clients re-read. Capability advertised as
  `{ listChanged: false }`. (Whitepaper warns stateful connections add cost; if
  ever wanted, Durable Objects are the mechanism — not in scope.)
- **No query results as resources.** Price history / cheapest / movers stay
  **tools** (verbs). Only the unparameterised reference sets + docs become
  resources (nouns). See the **noun/verb principle** (§7).
- **No item template in v1.** The `manamurah://item/{item_code}` URI template is
  **deferred to v2** (§10) — it is the only injection surface and an unbatched
  N+1; `resources/templates/list` returns `[]` in v1.
- **No new auth.** Same posture as tools: public, read-only.

## 2. Resource catalogue (v1)

Six fixed resources returned by `resources/list`. **Literal copy is normative** —
descriptions must state "no prices", languages carried, and freshness.

| URI | name / title | mimeType | upstreamPath (sole fetch authority) | description (normative) |
|---|---|---|---|---|
| `manamurah://catalogue/items` | `items` / "Item catalogue" | `application/json` | `catalogue/items` *(new)* | "All ~756 PriceCatcher items: code, Malay name, unit, category. No prices — use price tools for those. For English/Chinese/Tamil names, call `search_items`." |
| `manamurah://catalogue/states` | `states` / "States & federal territories" | `application/json` | `catalogue/states` *(new)* | "16 states/FTs with id, name, slug, region (semenanjung/borneo)." |
| `manamurah://catalogue/categories` | `categories` / "Item categories" | `application/json` | `catalogue/categories` *(new)* | "~40 item categories with item counts. Use as the `category` filter on `search_items`." |
| `manamurah://catalogue/chains` | `chains` / "Retail chains" | `application/json` | `list_chains` *(reuse)* | "~50 retail chains with premise counts, chain_type, states. The whole-set companion to the `list_chains` tool." |
| `manamurah://meta/latest-week` | `latest-week` / "Data freshness" | `application/json` | `meta/latest-week` *(new)* | "Current data week + coverage: `latest_weekdate, premises_reporting, items_with_data`. Read this to know how fresh prices are." |
| `manamurah://docs/methodology` | `methodology` / "Methodology & caveats" | `text/markdown` | *embedded — see §5* | "How prices are computed: weekly-average cadence, equal-premise weighting, outlier filtering, the n≥30 reliability guidance. Cite these caveats when reporting figures." |

**`catalogue/items` field set — LEAN, 4 fields (all required):**
`item_code` (int), `name` (Malay), `unit` (string), `item_category` (string).
**`name_en` and zh/ta are deliberately excluded** — they triple the standing
context-token cost (~16 K tokens lean vs ~45 K full) for marginal value, and
`search_items` already returns all translations on demand. (Review Q2/Q5; the
single conflict, resolved in CONSOLIDATION.md.) Revisit only if telemetry shows
English-locale agents repeatedly round-tripping after reading the catalogue.

**`meta/latest-week` contract is frozen** to those 3 fields. Proposal #4 (the
coverage tool) MUST reuse the same upstream view rather than duplicate-aggregate;
do not grow per-item coverage onto this resource (that's what would turn it into
dead code).

## 3. Protocol changes (Worker, `src/index.ts`)

### 3.1 Capabilities (`handleInitialize:632`, root manifest `:929`)

```diff
- capabilities: { tools: {}, prompts: {}, resources: {} }
+ capabilities: { tools: {}, prompts: {}, resources: { listChanged: false } }
```

### 3.2 Table-driven `RESOURCES` (the allowlist is the dispatch table)

One typed const is the **single source** for `resources/list`, the read
allowlist, AND the upstream-path map. The upstream path is **never** derived from
the inbound URI (SSRF / confused-deputy guard — Security SEC-1/SEC-2 + Arch #2).

```ts
interface MCPResource {
  uri: string;            // canonical, what resources/list advertises
  name: string;
  title: string;
  description: string;    // normative copy from §2
  mimeType: 'application/json' | 'text/markdown';
  kind: 'upstream' | 'embedded';
  upstreamPath?: string;  // required when kind==='upstream'; the SOLE fetch path
}
const RESOURCES: readonly MCPResource[] = [ /* the six rows from §2 */ ];
const RESOURCE_BY_URI: Map<string, MCPResource> = new Map(RESOURCES.map(r => [r.uri, r]));
```

`callUpstream` currently hardcodes `path = /api/v2/mcp/${toolName}` (`:587`) and
does **no `encodeURIComponent`**. Add an explicit `path` override param (or a thin
`callUpstreamPath(baseUrl, path, ...)`) so resources can target `catalogue/items`,
reuse `list_chains`, etc. Tools keep their existing name=path behaviour.

### 3.3 New / changed JSON-RPC methods (`handleMCP:701`)

- `resources/list` — replace the empty stub (`:710`) with `RESOURCES` mapped to
  `{ uri, name, title, description, mimeType }`.
- `resources/read` — **new.** Params `{ uri }`:
  1. `const r = RESOURCE_BY_URI.get(uri)` — `Map.get`, not `[]` (see §4 typing).
  2. Miss → JSON-RPC `-32602`, **actionable**: `"Unknown resource <uri>. Call resources/list for the catalogue."`
  3. `kind==='embedded'` (methodology) → return the bundled text directly (no fetch).
  4. `kind==='upstream'` → fetch **`r.upstreamPath`** (never `uri`) via the
     edge-cached path helper (§6). 5xx → JSON-RPC `-32603`.
  5. Return `{ contents: [{ uri, mimeType, text }] }`. `text` is **compact**
     `JSON.stringify(data)` (NOT the pretty `null, 2` tools use at `:678`) for
     JSON resources; raw markdown for methodology.
- `resources/templates/list` — **new, returns `[]` in v1** (template deferred, §10).

### 3.4 Telemetry (`src/analytics.ts`)

- Add an optional `resource` field to `CallMeta` and the WAE point — the resolved
  resource `name` (or, in v2, the template id — **never a concrete `item_code`**).
- `resources/list` / `resources/read` already flow through the boundary recorder
  (`:828`). Keep 100% sampling (volume is trivial). URIs are non-sensitive.

### 3.5 Discovery surfaces

- **Tool cross-linking (mandatory, UX High):** amend `search_items`,
  `list_chains`, `compare_prices` descriptions to point at the relevant
  `manamurah://catalogue/*` resource. Without this, agents won't discover the
  resources and the round-trip-killing goal fails.
- **Server card** (`:867`): note "…tools + 6 reference resources" + `_meta.resource_count`.
- **Root manifest** (`:911`): add `resource_count` + a `resources` array mirroring
  how `tools` is exposed.
- **Changelog** (`src/changelog.ts` + `CHANGELOG.md`): add the `2.7.0` entry.

## 4. Required TypeScript (Type-safety High — T1/T2/T3)

The existing code is `strict: true` and `tsc` is clean; keep it that way by
mandating these (the spec must not introduce an untyped boundary):

```ts
interface ResourceContents { uri: string; mimeType: string; text: string }
interface ResourceReadParams { uri: string }
interface CatalogueItem { item_code: number; name: string; unit: string; item_category: string }
// Generic the upstream boundary instead of returning `unknown` (src/index.ts:586):
async function callUpstream<T>(/* ... */): Promise<T> { /* ... */ }
```

- `tsconfig.json:15` has `noUncheckedIndexedAccess: false`. Do **not** index the
  allowlist or any capture group with bare `[]`; use `Map.get()` / `.find()`
  (already `T | undefined`) so the miss path is type-forced. (Either keep the flag
  and follow this rule, or flip it for `src/` — implementer's call, documented.)
- `CatalogueItem` is the **one** shape shared by the catalogue resource and (later)
  the item card — divergent field sets are the drift proposal #7 warns about.

## 5. Methodology = embedded, not proxied (Q3, unanimous)

Ship the methodology as `src/methodology.ts` exporting a date-stamped markdown
const, mirroring `src/changelog.ts`. Zero round-trip, no upstream endpoint, no
live-tamper window, reviewable at PR time. `resources/read` serves it directly
(`kind: 'embedded'`). Keep it short and stable; bump its date stamp when edited.

## 6. Caching strategy (CF-infra + Cost — phased)

**Phase 1 (v1, ship now): Cache API at the Worker edge.** Wrap upstream resource
fetches in `caches.default`, keyed on a **synthetic GET cache-key Request**
(POST JSON-RPC bodies can't be keyed directly), with the current `weekdate` in the
key and `Cache-Control: max-age=21600` (6 h). Widen the Worker entrypoint from
`fetch(request, env)` to `fetch(request, env, ctx)` and use `ctx.waitUntil` for
the async `cache.put`. Free; eliminates ~99 % of redundant catalogue→ES load.
Embedded methodology needs no cache.

**Phase 2 (target state; needs an ETL change): catalogues in Workers KV.** ETL
writes `cat:items|states|categories|chains` + `meta:latest-week` weekly; the
Worker reads KV instead of proxying the SvelteKit upstream + ES at all. One new KV
binding. Defer until Phase 1 is proven and the ETL gains a KV-write step.

**Rejected:** D1 (whole-object reads = KV's job), R2 (payloads too small; future
bulk-export home only), Workers Static Assets (worse than embed/KV here), Durable
Objects (subscriptions are a non-goal).

## 7. Architecture principles to honour

- **Noun/verb rule (Arch):** a dataset may be exposed as *both* a Resource and a
  Tool **only** when the Resource is the whole unparameterised reference set (a
  noun / ambient context) and the Tool is a parameterised query (a verb). This is
  why `catalogue/chains` (resource) + `list_chains` (tool) is legitimate, and why
  the item *card* (parameterised) should not also be a standing resource.
- **Trust assumption (Security SEC-3):** resource content is auto-loaded into agent
  context, so it is a poisoning surface. Trust chain: ES → SvelteKit upstream →
  Worker (verbatim passthrough) → client. Risk is low (public gov data, no
  transformation) but is hereby stated; do not start interpolating untrusted text
  into resource payloads.

## 8. Content shape (`resources/read` result)

```json
{ "contents": [ { "uri": "manamurah://catalogue/states",
  "mimeType": "application/json",
  "text": "{\"weekdate\":\"2026-05-18\",\"states\":[{\"stateid\":1,\"name\":\"Johor\",\"slug\":\"johor\",\"region\":\"semenanjung\"}]}" } ] }
```

Every JSON payload carries a top-level `weekdate` (envelope level only — not
per-row, which would add ~15 KB) so clients reason about freshness without a
second read.

## 9. Size / token discipline

`catalogue/items` is the only sizable resource. At 4 fields, compact-serialized:
**≈ 60–65 KB / ~16 K tokens** (vs ~95 KB / ~25 K with `name_en`, ~176 KB full
multilingual). Others are < 5 KB. **CI gate: `catalogue/items` serialized size
< 80 KB** (passes comfortably). Whitepaper: "design for concise output."

## 10. Deferred to v2 — item card template

`manamurah://item/{item_code}` (a single item's reference card). Deferred because
it is the only attacker-influenced input meeting URL construction (Security) and
an unbatched N+1 (Perf/Cost: ~+$40–80/mo ES tier risk if hammered). **When it
ships it MUST:**

- Validate the captured `{item_code}` with a strict contract: extract → match
  `^[0-9]{1,7}$` → coerce to number → map to a **literal** upstream path. Never
  string-interpolate the raw capture into the fetch URL.
- Reuse the Phase-1 edge cache (per-item key), or be gated behind KV (Phase 2).
- May carry `name_en` (single item = cheap), reusing/extending `CatalogueItem`.
- Land with its SSRF / path-traversal tests in the same PR (§11).

## 11. Testing / eval (this repo has no tests today)

- `resources/list` returns the 6 URIs with all required fields + normative copy.
- `resources/read` for each fixed URI → valid `contents`, correct `mimeType`.
- Unknown URI → `-32602` with the actionable message.
- **Allowlist/SSRF:** a crafted URI not in `RESOURCE_BY_URI` never triggers a fetch.
- `resources/templates/list` → `[]` (v1).
- **Size gate:** `catalogue/items` < 80 KB serialized.
- **Edge cache:** second read within TTL serves from `caches.default` (no upstream hit).
- *(v2)* item-template `{item_code}` rejects non-numeric / overlong / traversal inputs.

## 12. Build sequence

1. **Upstream** — add `catalogue/items|states|categories`, `meta/latest-week`
   (thin ES lookups the SvelteKit app already does); reuse `list_chains`. Each
   returns the standard `{ status, reason, warnings, data }` envelope.
2. **Worker** — `src/methodology.ts`; typed `RESOURCES` + `RESOURCE_BY_URI`;
   `callUpstream` path-override + generic `<T>`; `resources/list` / `resources/read`
   (edge-cached) / `resources/templates/list:[]`; capabilities; `resource`
   telemetry field; tool-description cross-links; discovery surfaces; `2.7.0` bump;
   widen entrypoint to `(request, env, ctx)`.
3. **Tests** — §11.
4. **Deploy** — `wrangler deploy`, then verify `resources/list` / `resources/read`
   live and confirm server card / root manifest reflect the count.

## 13. Adjacent (do alongside; not strictly Resources)

- **Tool error quality (UX High):** upgrade `Unknown tool: X` / `Tool execution
  failed` (`src/index.ts:666,688`) to actionable messages, matching the new
  resource-error standard.
- **Schema-drift CI check (Arch High, proposal #7):** Worker = 14 tools, Python ref
  = 15 (`chain_mom_movers`), README/package.json = 14 — already drifted. Resources
  add a 3rd hand-maintained surface. Add a name-parity check.

## 14. References

- Review folder: [`reviews/2026-05-22-MCP1-FEATURES/`](./reviews/2026-05-22-MCP1-FEATURES/)
  (7 persona files + `CONSOLIDATION.md`).
- Parent proposal: `docs/2026-05-22-mcp-enhancement-proposals.md`
- Whitepaper: <https://www.kaggle.com/whitepaper-agent-tools-and-interoperability-with-mcp>
- Code anchors: capabilities `src/index.ts:632` + `:929`; dispatch `:701`;
  `resources/list` stub `:710`; `callUpstream` `:581` (hardcoded path `:587`,
  returns `unknown` `:586`); pretty-print `:678`; tool errors `:666,:688`; server
  card `:867`; root manifest `:911`; telemetry `src/analytics.ts`; `tsconfig.json:15`.
