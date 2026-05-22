# Cloudflare Infrastructure Review — MCP Resources feature

**Date:** 2026-05-22
**Persona:** Cloudflare Infrastructure Reviewer
**Scope:** Design proposal `docs/2026-05-22-mcp-enhancement-proposals.md` + spec `docs/2026-05-22-spec-mcp-resources.md` (the MCP Resources feature). Grounding: `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`. Mandate: find Cloudflare-platform optimizations for the resources feature and note any for the broader server. **REVIEW ONLY — no files changed except this one, no CF resources mutated.**

---

## Executive summary

The spec is architecturally sound for a stateless thin proxy: it keeps the Worker credential-less, defers subscriptions, and reuses the existing `callUpstream` pattern. From a Cloudflare-platform lens the design is **correct but leaves a large, cheap latency-and-load win on the table**: the resources are explicitly *weekly-static* (they only change on the ETL), yet the spec proxies every `resources/read` straight through to SvelteKit → ES on every call (spec §3.2 step 3, §5). That is the single biggest optimization opportunity.

Overall assessment: **APPROVE WITH RECOMMENDATIONS.** The feature is safe to ship as specified (the upstream 12h KV cache already absorbs most repeat load), but two cheap edge primitives — the **Cache API** for `resources/read` and a **KV catalogue snapshot written by the ETL** — convert a 3-hop (Worker → SvelteKit → ES) read into a 0- or 1-hop edge read for data that is identical for a week at a time. There are no Critical issues: nothing in the current design will hit a CF limit (the `catalogue/items` payload at a < 80 KB budget is far under every relevant ceiling). The recommendations are latency/load/cost optimizations and one bindings-hygiene note.

Key numbers that frame the recommendations:
- `catalogue/items` target < 80 KB (spec §6). KV value limit is **25 MB**, Cache API and Static Assets per-file limit **25 MiB** — the largest resource is ~0.3% of any ceiling. Size is a non-constraint; **freshness/consistency and hop-count are the real design axes.**
- All resources combined: ~756 items (~40–60 KB) + 16 states + ~40 categories + ~50 chains + tiny meta + a short markdown blob ≈ well under 100 KB total.

---

## Findings / Opportunities table

| ID | Severity/Impact | Title | Mechanism | Recommendation |
|---|---|---|---|---|
| CF-1 | High | `resources/read` re-proxies weekly-static data on every call | Cache API (`caches.default`) with a synthetic GET cache-key + `Cache-Control: max-age` in the Worker | Add edge caching to `resources/read`; key on resolved URI; TTL ~6–12h aligned to the upstream 12h KV cache |
| CF-2 | High | Catalogues could bypass SvelteKit+ES entirely | Workers KV namespace written by the weekly ETL/cron, read by the Worker | Recommend as the **target-state** design for the 4 catalogues + meta; ship CF-1 first (zero upstream coupling), adopt CF-2 when the ETL can write KV |
| CF-3 | Medium | `docs/methodology` round-trip is avoidable | Embed-in-bundle (like `changelog.ts`) — answers Open Q3 | Embed the curated methodology blob in the Worker; do **not** proxy `/about`, do not use R2/Assets for this one small static doc |
| CF-4 | Medium | `meta/latest-week` is the ideal first KV key | Single KV key `meta:latest-week` written by ETL | Answers Open Q4: ship it now; if CF-2 is adopted it is one extra `KV.put`. Cheap either way |
| CF-5 | Low | D1 not warranted for catalogue / item-card | — | Reject D1 for v1. KV (CF-2) covers list resources; item-card template proxies upstream or reads a KV hash. Revisit only if per-item card volume explodes |
| CF-6 | Low | R2 not warranted for current resource set | — | Reject R2 for v1. Largest payload (~60 KB) is far below the bundle/KV/Assets threshold where R2 wins. Note R2 as the home for *future* bulk snapshot/export resources |
| CF-7 | Low | Static Assets viable but not better than embed/KV | Workers Assets binding | Note as an option; embed (CF-3) and KV (CF-2) beat it for this content shape. Adds a binding + redeploy-to-update coupling |
| CF-8 | Info | Bindings hygiene — resources feature adds 0–1 bindings | `wrangler.toml` audit | Document: feature ships with **no new binding** (CF-1 uses the global cache, needs none) or **one KV binding** (CF-2). Keep `WAE` as-is |
| CF-9 | Info | Subscriptions → Durable Objects (future only) | DO as `listChanged`/subscribe coordinator | Endorse the spec's stateless decision (§Non-goals). DO is the right tool *if* subscriptions are ever wanted — keep stateless for now |
| CF-10 | Info | Smart Placement / Tiered Cache for the Worker→SvelteKit→ES hop | Smart Placement + Tiered Cache (Argo) | Low marginal value once CF-1/CF-2 cut the hop for resources; note for the tool path |
| CF-11 | Info | Vectorize / Workers AI / AI Gateway | Forward-looking | Out of scope for resources. Vectorize is the right substrate for the proposal's deferred "RAG tool-discovery" idea; AI Gateway only if LLM calls ever appear. Do not scope into this feature |

---

## Detailed opportunities

### CF-1 (High) — Edge-cache `resources/read` via the Cache API

**Mechanism.** The resources are weekly-static (spec §1, Non-goals: "reference data changes only on the weekly ETL"). Instead of calling `callUpstream` on every `resources/read` (spec §3.2 step 3), wrap the upstream fetch in the Workers Cache API. Because `resources/read` arrives as a **POST JSON-RPC** request, you cannot key on the inbound `Request` directly — `cache.put` rejects any method other than GET ([CF docs: Cache](https://developers.cloudflare.com/workers/runtime-apis/cache/), [Cache POST requests example](https://developers.cloudflare.com/workers/examples/cache-post-request/)). The standard workaround is a **synthetic GET cache-key Request** built from the resolved resource URI:

```ts
// pseudocode — illustrative, not for commit
const cache = caches.default;
const cacheKey = new Request(
  `https://mcp.manamurah.com/__rescache/${encodeURIComponent(resolvedUri)}`,
  { method: 'GET' }
);
let resp = await cache.match(cacheKey);
if (!resp) {
  const data = await callUpstream(...);          // existing path
  resp = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json',
               'Cache-Control': 'public, max-age=21600' } // 6h
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
}
```

Note: the current `fetch(request, env)` signature in `src/index.ts:752` omits `ctx: ExecutionContext` — adding the Cache API means widening the handler signature to `fetch(request, env, ctx)` so `ctx.waitUntil` can finish the `cache.put` without blocking the response.

**Win.** First read per colo per ~6h pays the full Worker→SvelteKit→ES cost; every subsequent read in that colo is an edge cache hit (sub-ms, no subrequest billed against the upstream, no ES load). For an MCP server where many agents repeatedly read the same catalogue at session start, this is a large cut in upstream load and tail latency. Cache API hits don't count as subrequests in the same way a `fetch` does and never touch SvelteKit.

**Complexity.** Low. ~15 lines around `callUpstream`, a handler-signature change for `ctx`, and a TTL constant. **Zero upstream coordination** — works the day it ships, regardless of whether the ETL ever learns to write KV. This is why CF-1 should land *before* CF-2.

**CF limits / caveats.**
- `cache.put` fails on non-GET requests → synthetic GET key required (above). [Cache docs](https://developers.cloudflare.com/workers/runtime-apis/cache/).
- `cache.match` in Workers does **not** support `ignoreSearch`/`ignoreVary` or `stale-while-revalidate`/`stale-if-error` ([Cache docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)) — fine here, since the synthetic key is exact and we don't need SWR.
- Cache is **per-colo, not global** ([How the Cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)) — eventual, best-effort, can be evicted early. Acceptable for weekly-static data; on a miss we fall through to upstream (which itself has the 12h KV cache).
- Cache API calls share the subrequest quota ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) — one `match` + one `put` per read, well within bounds.
- **Invalidation:** TTL-only is simplest. A 6h `max-age` means at most 6h of staleness past an ETL run — acceptable for weekly data and strictly better than the spec's per-call proxy when the upstream cache is cold. Each JSON resource already carries `weekdate` (spec §4) so clients can detect their own staleness.

### CF-2 (High) — Catalogues in Workers KV, written by the ETL

**Mechanism.** Make the weekly ETL (or a cron) the **writer** and the Worker the **reader** of a KV namespace, so the 4 list catalogues + `meta/latest-week` never touch SvelteKit or ES on a `resources/read`. Concrete design:

| KV key | Value | Writer | TTL |
|---|---|---|---|
| `cat:items` | lean items JSON (~40–60 KB) | weekly ETL | none (overwritten weekly); optional 14d expiry as a safety net |
| `cat:states` | states JSON | ETL (rarely changes) | none |
| `cat:categories` | categories JSON | weekly ETL | none |
| `cat:chains` | chains JSON | weekly ETL | none |
| `meta:latest-week` | `{latest_weekdate, premises_reporting, items_with_data}` | weekly ETL (last step) | none |

Worker `resources/read` does `env.CATALOGUE_KV.get(key, 'text')` and returns it verbatim as `contents[0].text`. Add one binding to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CATALOGUE_KV"
id = "<namespace-id>"
```

**Win.** Eliminates the SvelteKit + ES hop entirely for catalogue reads — KV global read latency is typically single-digit to low-tens of ms at the edge after first colo warm, with no upstream load and no ES query. Combined with CF-1, KV becomes the cold-miss backstop and Cache API the hot path. It also **decouples resource freshness from the upstream 12h cache** — the ETL writes the exact new week atomically at publish time.

**Complexity.** Medium, and the cost is **upstream/ETL coupling**: someone has to teach the ETL to `wrangler kv key put` (or use the KV REST API / a binding in the ETL Worker) at the end of each weekly run. That writer doesn't exist yet (the spec assumes new SvelteKit endpoints instead, §5). Until the ETL can write KV, CF-1 delivers most of the benefit with none of this coupling — hence **ship CF-1 first, adopt CF-2 as target-state** when the ETL gains a KV-write step.

**CF limits / trade-offs.**
- KV value limit **25 MB**, key name limit **512 bytes** ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)). The largest value (~60 KB) is ~0.24% of the limit; values > 1 MB need the chunked upload API — not applicable here. ([KV write docs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- KV is **eventually consistent** — up to ~60s for a write to be globally visible. For weekly data, a sub-minute propagation window after the ETL is irrelevant.
- KV write rate: **max 1 write/sec to the same key** ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)). A weekly ETL writing 5 distinct keys once is nowhere near this.
- Existing pattern: the broader stack already uses a KV namespace (`MCP_RL_MIN` referenced in the proposal/server context for rate-limit minutes), so a second namespace is a known, low-friction operation for this team.
- **Note:** this Worker currently has **no KV binding** in `wrangler.toml` (only `WAE`, lines 24–26). CF-2 is the only recommendation that adds infra surface to the Worker.

### CF-3 (Medium) — Embed `docs/methodology` in the bundle (answers Open Q3)

**Mechanism.** The repo already embeds static markdown in the Worker bundle: `CHANGELOG_MARKDOWN` from `src/changelog.ts`, served at `/changelog` (`src/index.ts:63, 845–854`). Do the same for methodology — a `src/methodology.ts` exporting a `METHODOLOGY_MARKDOWN` const, returned directly by `resources/read` for `manamurah://docs/methodology`. No fetch, no upstream endpoint.

**Win.** Zero round-trip, zero upstream coupling, served from the bundle in the V8 isolate (fastest possible). The methodology text is short, stable (weekly-average cadence, equal-premise weighting, outlier filtering, n≥30 caveat) and changes far less than weekly. Avoids building the `/api/v2/mcp/docs/methodology` endpoint the spec lists as "new, or static" (§2, §5).

**Complexity.** Trivial — mirrors an existing, proven pattern. The only discipline cost: methodology edits require a redeploy (same as `changelog.ts` today). That is acceptable for a doc that changes rarely and is part of the server's contract anyway.

**Why not R2/Assets/proxy for this one.** Proxying `/about` adds a hop for static text (worst option). R2 (CF-6) and Static Assets (CF-7) both add a binding and an out-of-band update path for a < 5 KB blob — overkill versus a string in the bundle.

### CF-4 (Medium) — `meta/latest-week` now, as a cheap KV key (answers Open Q4)

**Mechanism.** Ship the freshness resource now. Infra-wise it is the *cheapest possible* resource: a single small object. If CF-2 lands, it is one KV key (`meta:latest-week`) the ETL writes as its final step — the natural place to stamp "this week is live." If CF-2 is deferred, it proxies the new `meta/latest-week` endpoint behind the CF-1 cache like the other resources.

**Win.** High signal-to-cost: it is the canonical freshness anchor every other resource references via `weekdate` (spec §4), and a precursor to proposal #4 (coverage). Decoupling it from the heavier per-item coverage work (proposal #4) is the right call — they have different cadence and cost profiles.

**Complexity.** Minimal. Recommend shipping it in v1 exactly as the spec leans (§9 Q4).

### CF-5 (Low) — D1 is not warranted

**Mechanism considered.** A D1 SQLite DB holding the catalogue and item cards, queried by the Worker for `manamurah://item/{item_code}` to avoid an ES round-trip.

**Assessment — reject for v1.** The catalogues are small, read-mostly, whole-object reads — exactly KV's sweet spot, not D1's. D1 shines for *relational queries / filtered selects* over larger datasets; here every "query" is "give me the whole list" or "give me one item by primary key," which KV `get` (CF-2) does with less latency and no SQL layer. The item-card template (`manamurah://item/{item_code}`) is better served by either proxying the existing upstream lookup (behind CF-1 cache) or, if KV is adopted, a per-item KV key / a single `cat:item-cards` hash. D1's free-plan **500 MB/db, 10 db/account** and read-replication features ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)) are irrelevant at this data size. Adding D1 also breaks the "Worker holds no DB access" property the architecture deliberately maintains (`src/index.ts:8–10`). Revisit only if item-card read volume + per-item field richness ever justify a relational store.

### CF-6 (Low) — R2 is not warranted for the current set

**Mechanism considered.** Serve `docs/methodology` and/or a full catalogue snapshot as an R2 object via the Worker.

**Assessment — reject for v1.** R2 wins for *large* objects (MBs+), binary blobs, or content you want addressable/downloadable independently. The largest resource here (~60 KB) is far below the threshold where R2 beats embed-in-bundle or KV — it would add a binding, an egress path, and an out-of-band update step for sub-100 KB JSON. **Note for the future:** if a proposal ever adds a *bulk export* resource (e.g. a full price-history dump, a multi-MB catalogue with all translations + aliases, or downloadable CSV/Parquet snapshots), R2 is the correct home and should be served via a Worker route with a signed/short-cache header. Not this feature.

### CF-7 (Low) — Static Assets is viable but not the best fit here

**Mechanism considered.** Ship methodology + catalogues as **Workers Static Assets** (`assets` binding), letting CF serve them directly without invoking Worker code.

**Assessment — note, don't adopt.** Static Assets per-file limit is **25 MiB**, up to **100k assets/version** on paid (20k on free) ([Static Assets limits](https://developers.cloudflare.com/workers/static-assets/), [billing & limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [increased limits changelog](https://developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/)) — size is a non-issue and asset requests are *free and unlimited*. But the content has to be wrapped in MCP `resources/read` JSON-RPC envelopes anyway, so "serve the file directly without Worker code" doesn't apply — the Worker must read and re-wrap it. That makes Static Assets equivalent to embed-in-bundle (CF-3) but with an extra binding and an asset-fetch hop, or equivalent to KV (CF-2) but without the ETL being able to update it without a redeploy. **Embed for the static doc, KV for the weekly catalogues.** Static Assets would be the choice only if the resources were served as plain files at HTTP routes (not MCP envelopes) — which they aren't.

### CF-9 (Info) — Durable Objects: endorse the stateless decision; DO is the future subscription mechanism

The spec explicitly avoids `resources/subscribe` + `listChanged` to stay stateless (§Non-goals, §3.1 `{ listChanged: false }`). **Concur fully.** A stateless Worker cannot hold the per-client subscription state or push notifications. The *correct* CF mechanism, **if** subscriptions are ever wanted, is a **Durable Object** as a per-resource (or per-client) coordinator that fans out `notifications/resources/list_changed` / `notifications/resources/updated` over the SSE/streamable-HTTP connections. That brings real architectural cost (connection state, hibernation handling, billing) that is unjustified for data changing once a week — clients re-reading is strictly cheaper. **Recommendation: stay stateless; document DO as the named upgrade path in the spec's Non-goals so the decision is traceable.**

### CF-10 (Info) — Smart Placement / Tiered Cache / Argo

Given the Worker → SvelteKit → ES hop, **Smart Placement** could move the Worker compute closer to the SvelteKit origin to cut the inter-service RTT, and **Tiered Cache** (Argo) could improve upstream cache-hit ratio. However, once CF-1 (edge cache) and especially CF-2 (KV) land, the resources path no longer makes that hop on the hot path, so the marginal value is small **for resources**. These remain worth a look for the **tool** path (the 14 query tools still proxy live every call), but that is outside this feature's scope — flag for a separate broader-server review. Don't scope into MCP-1.

### CF-11 (Info) — Vectorize / Workers AI / AI Gateway (forward-looking, out of scope)

- **Vectorize** is the right substrate for the parent proposal's deliberately-deferred "RAG-style tool discovery" idea (proposal "Not recommended" section) — at 14 tools it's premature, but if the tool count grows to dozens-plus, a Vectorize index of tool/resource descriptions read by the Worker is the canonical CF pattern. Note only.
- **AI Gateway** becomes relevant only if the server ever makes outbound LLM calls (caching, rate-limiting, observability for them). It currently makes none. Note only.
- **Workers AI** — no use case in a price-data proxy today.
Do not over-scope any of these into the resources feature.

---

## Open question answers (spec §9, infra lens)

**Q3 — Methodology: embed-in-bundle vs proxy `/about` vs third option (KV/R2/Assets)?**
**Embed in the bundle** (CF-3), mirroring `src/changelog.ts`. Reasons: zero round-trip, zero upstream coupling, fastest serve path, and the text is short + stable (rarely changes, definitely not weekly). Proxying `/about` adds a hop for static content; KV/R2/Static Assets all add a binding + out-of-band update path that a < 5 KB string in the bundle doesn't need. The only cost — redeploy to edit — already applies to `changelog.ts` and is acceptable for contract-level docs.

**Q4 — `meta/latest-week` now vs later? Infra angle (cheap KV key)?**
**Ship now** (CF-4). It is the cheapest resource to serve and the canonical freshness anchor the other resources reference via `weekdate`. Infra-wise it is a *single small KV key* in the target-state design (CF-2) — the ETL stamps it as the final step of each weekly run, which is the natural "this week is live" signal. If KV (CF-2) is deferred, it proxies its endpoint behind the CF-1 edge cache like the other resources. Either way it is trivial. Keep the richer per-item coverage in proposal #4 as the spec leans.

---

## Spec change requests

1. **§3.2 / §5 — Add an edge-caching layer to `resources/read` (CF-1).** Amend step 3 ("Proxy via the existing `callUpstream` pattern") to "Proxy via `callUpstream`, wrapped in the Workers Cache API using a synthetic GET cache-key derived from the resolved URI, with `Cache-Control: max-age=21600` (6h)." Note the required handler-signature widening to `fetch(request, env, ctx)` so `ctx.waitUntil(cache.put(...))` can run. This is the single highest-value change and has no upstream dependency.

2. **§5 / new §5.1 — Document the KV target-state for catalogues (CF-2).** Add a subsection: catalogues + `meta/latest-week` should ultimately be **written to a `CATALOGUE_KV` namespace by the weekly ETL** and read by the Worker, removing the SvelteKit+ES hop. Mark it target-state (depends on the ETL gaining a KV-write step) and CF-1 as the ship-first interim. Record the proposed key scheme (`cat:items`, `cat:states`, `cat:categories`, `cat:chains`, `meta:latest-week`).

3. **§9 Q3 — Resolve to "embed" (CF-3).** State methodology is embedded as `src/methodology.ts` (mirror of `changelog.ts`); drop the "new `/api/v2/mcp/docs/methodology` endpoint" option from §5.

4. **§9 Q4 — Resolve to "ship now" (CF-4).**

5. **Non-goals — Name Durable Objects as the explicit subscription upgrade path (CF-9).** Add one line: "If `resources/subscribe`/`listChanged` is ever required, the mechanism is a Durable Object coordinator; deliberately deferred to preserve statelessness." Makes the decision traceable.

6. **wrangler.toml note (CF-8).** Document that the feature adds **no new binding** if shipped with CF-1 only, or **one `kv_namespaces` binding** (`CATALOGUE_KV`) if CF-2 is adopted. `WAE` (lines 24–26) is unchanged; add a `resource`-dimension note to the WAE schema in `src/analytics.ts` per spec §3.3 (already planned — confirm the new `blob`/index slot doesn't collide with the documented 1-indexed schema).

7. **§6 — Add a CF-limits sanity note.** Record that the < 80 KB items budget is ~0.24% of the 25 MB KV value limit and ~0.3% of the 25 MiB Cache API / Static Assets per-file limit, so size is a non-constraint and the design axis is freshness + hop-count, not payload size.

---

## Sources

- [Limits · Cloudflare Workers KV docs](https://developers.cloudflare.com/kv/platform/limits/) — 25 MB value limit, 512-byte key, 1 write/sec/key
- [Write key-value pairs · Cloudflare Workers KV docs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) — chunked upload > 1 MB
- [Cache · Cloudflare Workers docs](https://developers.cloudflare.com/workers/runtime-apis/cache/) — `cache.put` GET-only, no `ignoreSearch`/SWR
- [Cache POST requests · Cloudflare Workers docs](https://developers.cloudflare.com/workers/examples/cache-post-request/) — synthetic GET key workaround
- [How the Cache works · Cloudflare Workers docs](https://developers.cloudflare.com/workers/reference/how-the-cache-works/) — per-colo, best-effort
- [Limits · Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/limits/) — Cache API shares subrequest quota
- [Static Assets · Cloudflare Workers docs](https://developers.cloudflare.com/workers/static-assets/) and [Billing and Limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) — 25 MiB/file, free asset requests
- [Increased static asset limits · Cloudflare Changelog](https://developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/) — 100k assets/version (paid), 20k (free)
- [Limits · Cloudflare D1 docs](https://developers.cloudflare.com/d1/platform/limits/) — 500 MB/db free, 10 GB/db paid
- [Global read replication · Cloudflare D1 docs](https://developers.cloudflare.com/d1/best-practices/read-replication/) — auto read replicas
