# Cost Review — MCP Resources for manamurah MCP server

**Date:** 2026-05-22
**Persona:** Cost Reviewer
**Scope:** Cost impact (Cloudflare Workers, WAE telemetry, Elasticsearch load, bandwidth/egress, client-token cost, KV/D1/R2 trade) of adding MCP Resources per `docs/2026-05-22-spec-mcp-resources.md` and parent `docs/2026-05-22-mcp-enhancement-proposals.md`. Mandate: quantify cost and recommend the cost-minimizing configuration. Review only — no code touched.

---

## Executive summary

The Resources feature is **cheap on Cloudflare's side and a non-event for WAE**, but it introduces one materially under-managed cost: **uncached `resources/read` proxy traffic landing on the capacity-constrained paid Elastic Cloud cluster**. Catalogues are weekly-static yet, as specced, every read re-queries upstream (mitigated only by the upstream's 12h KV cache, which is a coarse cache, not a per-resource one). The `manamurah://item/{item_code}` template is the real tail risk: an N+1 pattern where a Host loads 50–500 item cards in one task, each a distinct ES lookup, with poor cache reuse.

The good news: Elastic Cloud is billed on **provisioned RAM-hours, not per-query** ([Elastic Cloud Hosted billing](https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/cloud-hosted-deployment-billing-dimensions)). So resource reads do **not** cost money per query — they cost money only if the added query load forces the cluster onto a larger (more RAM-GB) tier or degrades latency on the existing tier. Given ES has been "strained historically" on this project, the cost risk is **headroom consumption**, not a metered bill. Caching catalogues at the edge converts a recurring, unbounded query stream into a near-zero one, protecting the headroom that has historically been the bottleneck.

**Overall cost-risk rating: Medium** — Low on the metered platforms (Workers/WAE/KV all comfortably inside Paid-plan free allocations at realistic MCP volume), but **Medium-to-High on ES headroom** if the item-card template ships without per-resource edge caching. With the recommended caching config, the whole feature is **Low**.

---

## Pricing assumptions (cited)

| Resource | Unit price (Workers Paid, 2026) | Included / month | Source |
|---|---|---|---|
| Workers requests | $0.30 / million (overage) | 10 M | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers CPU | $0.02 / million CPU-ms (overage) | 30 M CPU-ms | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| WAE data points written | $0.25 / million (overage; **not yet billed**) | 10 M | [WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| WAE read queries (SQL API) | $1.00 / million (overage) | 1 M | [WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| KV reads | $0.50 / million (overage) | 10 M | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| KV writes / deletes / lists | $5.00 / million each (overage) | 1 M each | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| KV storage | $0.50 / GB-month (overage) | 1 GB | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Elastic Cloud Hosted | RAM-GB-hour provisioned (~$0.06/hr for 1GB ref node → ~$40/mo); **no per-query charge** | n/a | [Elastic pricing](https://www.elastic.co/pricing/cloud-hosted), [billing dims](https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/cloud-hosted-deployment-billing-dimensions) |

**Plan inference:** `wrangler.toml` binds Workers Analytics Engine (`[[analytics_engine_datasets]]`). WAE write access requires the **Workers Paid** plan (Free is dashboard-only / limited). The Worker is therefore on **Workers Paid ($5/mo base)**. This is favourable — the $5 base already bundles 10 M requests, 30 M CPU-ms, 10 M WAE writes, and 10 M KV reads, so all marginal Resource volume at realistic MCP scale is **absorbed inside the included tier** (i.e. $0 marginal until volume is ~100×+ current).

**Volume model (stated assumption):** WAE is 100% sampled, one datapoint per JSON-RPC request. Today's request volume is described as "low / high-signal." I model three scenarios for monthly `resources/*` requests: **Low = 50 K**, **Mid = 1 M**, **High = 20 M** (a popular registry listing + agents that read catalogues on every session). All math below uses these.

---

## Findings table

| ID | Severity | Title | Cost driver | Recommendation |
|---|---|---|---|---|
| C1 | **High** | Item-card template (`item/{item_code}`) is an N+1 ES query amplifier | ES headroom | Defer template to v2, OR ship only behind a per-item edge cache + document the N+1 risk; never let one task fan out to hundreds of uncached ES lookups |
| C2 | **Medium** | Catalogues re-queried on every read despite weekly-static data | ES headroom + redundant Worker→upstream round-trips | Add a per-resource edge/KV cache keyed on `weekdate`; rely on Worker `cache.put` (free) before reaching for KV |
| C3 | **Medium** | `catalogue/items` full multilingual payload inflates egress + client token cost | Bandwidth + end-user token cost | Ship LEAN fields (spec §9 Q2 leaning); enforce the <80 KB budget assertion (spec §6) |
| C4 | **Low** | Methodology proxied vs embedded = one upstream call per read | Worker→upstream round-trip (ES not hit if static) | Embed in bundle like `changelog.ts` — zero marginal request cost (spec §9 Q3) |
| C5 | **Low** | WAE datapoints from `resources/list`/`read` at 100% sampling | WAE writes (not yet billed) | Keep 100% — even High scenario is inside the 10 M included tier; do NOT add resource-specific sampling (would lose signal for no saving) |
| C6 | **Low** | Worker request + CPU cost of new method types | Workers requests/CPU | None needed — inside included tier at all modelled volumes; note in capacity doc |
| C7 | **Info** | `meta/latest-week` overlaps future coverage tool (#4) | Duplicated ES aggregation if both ship uncached | Ship now (it is the cheapest, most-cacheable resource); make #4 reuse the same cached upstream (spec §9 Q4) |

---

## Detailed findings (with $ estimates)

### C1 — Item-card template is an N+1 ES amplifier — **High**

Spec §2 templates table + §9 Q1. `manamurah://item/{item_code}` maps each concrete URI to `GET /api/v2/mcp/catalogue/item/{item_code}` → an ES lookup. Unlike the five fixed catalogues (bounded set, ≤6 distinct URIs), the template has a **756-wide key space** and is invoked with a *concrete* URI per `resources/read`.

**Cost mechanics.** A Host doing "summarise this basket of 40 items" or "annotate every fruit" can issue 40–756 `resources/read` calls in one task. Each is:
- 1 Worker request (free-tier absorbed),
- 1 Worker→upstream round-trip,
- on a 12h-KV-cache *miss*, **1 ES query** against the strained cluster.

The upstream 12h KV cache helps for *popular* items but not for a long-tail sweep across many distinct item codes shortly after a weekly ETL invalidation — exactly the cold-cache window where ES gets hammered. Because ES is provisioned (not per-query billed), the dollar impact is **indirect but real**: sustained N+1 fan-outs raise p95 query latency and CPU on the cluster, which is what historically forced capacity up. A single tier bump (e.g. doubling hot-node RAM-GB) is on the order of **+$40–$80/month** of *permanent* provisioned cost ([Elastic example node ≈ $40/mo](https://pulse.support/kb/elastic-cloud-pricing-guide)) — and that increment never goes away, unlike a one-off query spike.

**Recommendation.** Either (a) **defer the template to v2** (spec's own §9 Q1 fallback) until the fixed catalogues prove out the cache pattern, or (b) ship it **only** with a per-item edge cache (Worker `cache.put`, TTL = time-to-next-Monday-ETL) so a fan-out of N items hits ES at most once per item per week, not once per read. The spec's "leaning: ship the one item-card template" should be **conditioned on the cache being in place first**. Caching here is what converts an unbounded ES-query stream into ≤756 reads/week.

### C2 — Catalogues re-queried every read despite weekly-static data — **Medium**

Spec §1 non-goals explicitly relies on "the upstream 12h KV cache" and §5 calls the new endpoints "thin ES aggregations." But the catalogues (`items`, `states`, `categories`, `chains`, `meta/latest-week`) change **only on the weekly ETL** — their natural cache TTL is ~7 days, not 12 hours. As specced, the Worker re-proxies on every read; the only thing standing between a read and ES is the upstream's coarse 12h KV cache, which still forces **2 cold ES re-aggregations per resource per day** (and a thundering-herd at each weekly invalidation).

**Waste quantified.** Five static resources × 2 forced cold misses/day × 30 days = **~300 avoidable ES aggregations/month** at the upstream layer, plus every Worker read that the 12h cache *does* serve still costs a Worker→upstream HTTP round-trip (the Worker has no cache of its own). At Mid volume (1 M reads), that's ~1 M redundant upstream round-trips that a Worker-side `cache.match`/`cache.put` (the Cloudflare **Cache API is free** — no per-op charge, uses the colo cache) would collapse to a handful of origin fills per colo per week.

**Recommendation.** Add a Worker-side edge cache (`caches.default`) for all five fixed resources, keyed by URI + `weekdate`, TTL until next Monday. This is **$0** (Cache API has no usage billing) and eliminates ~99% of catalogue-driven upstream/ES traffic. Reach for **KV only if** cross-colo consistency matters — and even then KV is cheap here (see KV math below). Cross-ref the infra reviewer's mechanism choice; the $ verdict is: **Cache API first (free), KV second (negligible), never leave it uncached.**

### C3 — `catalogue/items` payload size: egress + client token cost — **Medium**

Spec §2 / §6 / §9 Q2. ~756 items. **Lean** (5 fields: `item_code, name, name_en, unit, item_category`) ≈ 40–60 KB serialized; **full** (add zh/ta/ms aliases) ≈ 120–180 KB (3–4× heavier).

- **Cloudflare egress:** $0 — Cloudflare does **not** bill Worker response bandwidth ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) bills requests + CPU only). So the manamurah-billed egress delta is zero.
- **End-user token cost (real, just not billed to manamurah):** This is the dominant size cost. At ~3.5 chars/token, lean ≈ **14–17 K tokens**, full ≈ **34–51 K tokens** per read injected into the agent's context. On a frontier model at ~$3–$15 / M input tokens, **one full-catalogue read costs the END USER ~$0.05–$0.77 in context tokens vs ~$0.02–$0.26 lean** — and Resources are loaded into context *per session*, so this recurs. The whole point of Resources (spec §1) is saving a tool round-trip; shipping a 50 K-token blob undoes that saving.

**Recommendation.** Ship **lean** (matches spec leaning). Enforce the §6 <80 KB budget assertion as a CI test. If multilingual is ever needed, expose it via the *template* (`item/{item_code}` returns full translations for one item — bounded) rather than fattening the bulk catalogue. **Answer to Q2: lean, decisively — the cost is the user's context, and full is 3–4× for marginal agent value.**

### C4 — Methodology: embed vs proxy — **Low**

Spec §5 / §9 Q3. Methodology is stable prose. Proxying = 1 upstream round-trip per read (no ES if served static upstream, but still a Worker→origin hop + origin compute). Embedding in the bundle (like `src/changelog.ts`) = **zero marginal request cost, zero upstream dependency, served from the isolate**. Worker bundle-size impact of a few KB of markdown is negligible (well inside the 10 MB compressed limit; no startup-CPU concern at this size). **Answer to Q3: embed.** Saves one round-trip per read at the cost of a redeploy when methodology text changes (rare — acceptable, same cadence as `changelog.ts`).

### C5 — WAE datapoints from resource traffic — **Low**

Each `resources/list`/`resources/read` flows through `recordMcp` at `src/index.ts:828` → one `writeDataPoint`. WAE writes are **$0.25/M** beyond **10 M included/month**, and crucially **not yet billed at all** ([WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)).

| Scenario | resource req/mo | WAE writes added | Inside 10 M included? | Marginal $ (if billed) |
|---|---|---|---|---|
| Low | 50 K | 50 K | Yes | $0 |
| Mid | 1 M | 1 M | Yes | $0 |
| High | 20 M | 20 M | No (10 M over) | $2.50/mo |

Even the High scenario is **$2.50/month** *if* billing turns on. There is **no case for sampling resource reads differently from tool calls** — the spec's plan to add a `resource` field to `CallMeta` and keep 100% sampling is correct. Down-sampling would forfeit the per-resource usage signal (which catalogues are actually read, item-card hit distribution — exactly the data you need to tune the C1/C2 caches) to save cents. **Keep 100%.** Note one cardinality nit: do **not** put raw `item/{item_code}` concrete URIs into the WAE *index* (756-wide, fine) but be aware index1 is the GROUP BY key — using the template id (`item/{item_code}`) rather than the resolved code keeps read-query cost (the $1/M dimension) and dashboard cardinality sane. The spec §3.3 wording ("resolved resource name or template id") is right; ensure the template *id*, not the concrete code, lands in index1.

### C6 — Worker request + CPU cost — **Low**

New method types (`resources/list`, `resources/read`, `resources/templates/list`) are just more JSON-RPC requests through the same handler. CPU per call is trivial (allowlist lookup + one `fetch` + `JSON.stringify`) — comparable to existing `tools/call`, well under 1 ms CPU typical.

| Scenario | added requests/mo | added CPU-ms (~0.5ms ea) | Inside 10 M req / 30 M CPU-ms? | Marginal $ |
|---|---|---|---|---|
| Low | 50 K | 25 K | Yes | $0 |
| Mid | 1 M | 500 K | Yes | $0 |
| High | 20 M | 10 M | Requests over by 10 M; CPU inside | 10 M × $0.30 = **$3.00/mo** requests; CPU $0 |

Per-million marginal cost of resource reads on Workers = **$0.30 (requests) + ~$0.01 (CPU at 0.5 ms) ≈ $0.31 / million**, and only after the 10 M included tier is exhausted. Negligible.

### C7 — `meta/latest-week` vs coverage tool #4 overlap — **Info / Low**

Spec §9 Q4. `meta/latest-week` is the **single cheapest, most-cacheable** resource (one tiny aggregation, changes weekly, ~200 bytes). Shipping it now costs essentially nothing and gives every agent a freshness signal. The only cost risk is **double-aggregating** the same ES data when proposal #4 (richer per-item coverage) later ships. **Answer to Q4: ship now**, but make the upstream `meta/latest-week` endpoint a thin view that #4's coverage endpoint can reuse, so you don't pay for the freshness aggregation twice. Cache it like the other catalogues (C2).

---

## KV / D1 / R2 trade (if the infra reviewer recommends a durable cache)

If a durable (cross-colo) catalogue cache is chosen over the free Cache API, here is the $ trade vs the ES query load avoided:

- **KV:** catalogues refreshed weekly = ~5 resources × ~4 writes/mo = **~20 KV writes/mo** (essentially free; 1 M included). Reads served from KV: even High (20 M) is **2× the 10 M included → 10 M over × $0.50/M = $5.00/mo**. Storage: all catalogues < 1 MB → **$0** (1 GB included). **KV total ≤ ~$5/mo at High, $0 at Low/Mid.** Versus ES: avoids the headroom pressure that risks a **+$40–$80/mo permanent tier bump**. KV wins decisively *if* you need cross-colo; otherwise Cache API is free and sufficient.
- **D1:** rows-read billing makes D1 a poor fit for a hot read-through cache vs KV's flat read price; no advantage here. Skip.
- **R2:** zero egress fee is irrelevant (Cloudflare doesn't bill Worker egress anyway) and R2 Class-B ops + latency are worse than KV for small hot JSON. Skip.

**Verdict:** **Cache API (free) → KV (≤$5/mo) → nothing else.** Both are >10× cheaper than one ES tier bump.

---

## Recommended cost-minimizing configuration

1. **Cache all five fixed catalogues at the Worker edge** via `caches.default`, keyed `URI + weekdate`, TTL = seconds-to-next-Monday-00:00 MYT. Cost: **$0** (Cache API unbilled). Eliminates ~99% of catalogue→upstream→ES traffic. *(C2)*
2. **Embed `docs/methodology`** in the bundle like `changelog.ts` — no upstream call, no ES. *(C4)*
3. **Ship `catalogue/items` LEAN** (5 fields), enforce <80 KB CI budget assertion. Protects end-user token cost (3–4× saving). *(C3)*
4. **Defer the `item/{item_code}` template, OR gate it on a per-item edge cache** (TTL to next ETL) so N-item fan-outs hit ES ≤ once/item/week, not once/read. This is the single highest-leverage cost control. *(C1)*
5. **Ship `meta/latest-week` now**, cached, and have proposal #4 reuse the same upstream view. *(C7)*
6. **Keep WAE 100% sampling for resources**; record the template *id* (not concrete code) in index1. *(C5)*
7. **Stay on Workers Paid** — all marginal Resource volume is inside the $5 base tier's included allocations until ~10–20× current traffic; no plan change needed.

With this config the feature's incremental **metered** cost is **$0 at Low/Mid volume** and **< $6/month even at the 20 M-read High scenario** (Workers requests + WAE if billing turns on), while the **ES headroom — the project's historically strained, expensive resource — is fully protected.**

---

## Open question answers (through the cost lens)

- **Q2 (items lean vs full):** **Lean.** Cloudflare egress is $0 either way, but full is **3–4× the end-user context-token cost** (~14–17 K tokens lean vs ~34–51 K full per read; ~$0.02–$0.26 vs ~$0.05–$0.77 per read on frontier models). Full undercuts the entire Resources value prop. Expose multilingual only via the bounded item-card template.
- **Q3 (methodology embed vs proxy):** **Embed.** Zero marginal request cost, zero upstream/ES dependency, served from the isolate — same model as `changelog.ts`. Proxy buys nothing but a per-read round-trip and a redeploy you avoid anyway.
- **Q4 (`meta/latest-week` now vs fold into #4):** **Now.** It is the cheapest and most-cacheable resource; ship it cached and make #4's coverage endpoint reuse the same upstream view to avoid paying for the freshness aggregation twice.

---

## Spec change requests

- **§2 / §9 Q1 (templates):** Add a hard precondition — the `item/{item_code}` template ships **only with a per-item edge cache** (TTL to next ETL). If caching isn't in v1, defer the template to v2. State the N+1 ES-headroom risk explicitly. *(C1)*
- **§3.2 / §5 (resources/read):** Add a Worker-side `caches.default` read-through layer for the five fixed resources, keyed `URI + weekdate`, before `callUpstream`. Note it is $0 (Cache API unbilled) and is the primary ES-load mitigation — the upstream 12h KV cache is too coarse for weekly-static data. *(C2)*
- **§5 (methodology):** Change "could be a static markdown blob… or embedded" to **prefer embed** (decided), citing zero round-trip cost. *(C4)*
- **§3.3 (telemetry):** Clarify that the WAE `resource` field / index1 stores the **template id** (`item/{item_code}`), not the resolved `item_code`, to bound read-query cost and dashboard cardinality. Confirm 100% sampling is retained (no resource-specific down-sampling). *(C5)*
- **§6 (size discipline):** Promote the <80 KB `catalogue/items` budget from "an assertion in tests" to a **required CI gate**, and add a one-line note that the real cost is end-user context tokens, not manamurah egress. *(C3)*
- **§9 Q4 / proposal #4:** Add a note that the `meta/latest-week` upstream view must be reusable by the future coverage tool to avoid double-aggregation cost. *(C7)*
