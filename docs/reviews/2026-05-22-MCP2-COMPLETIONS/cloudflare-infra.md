# Review: MCP Completions — Cloudflare Infrastructure

**Date:** 2026-05-22
**Persona:** Cloudflare Infrastructure Reviewer (platform-optimization lens)
**Target:** `docs/2026-05-22-spec-mcp-completions.md`
**Context:** `docs/2026-05-22-spec-mcp-resources.md` §6 (Phase-1 Cache API → Phase-2 KV caching)
**Grounding (read-only):** `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`
**Mandate:** REVIEW ONLY. No file mutations except this output; no `wrangler deploy`; no CF resource changes.

---

## Executive summary

The completion design is, from a CF-platform standpoint, **the cheapest endpoint on the
server** — pure in-isolate CPU over ~756 strings, no upstream/ES call per keystroke (spec §6,
§9, §10). That is correct and should be preserved as a hard invariant. The platform risks are
*not* in the matching cost; they are in three secondary mechanics the spec under-specifies:

1. **The hot-path catalogue load.** The spec inherits Resources §6's phased caching (Phase-1
   Cache API, Phase-2 KV) but does not resolve what a *fresh isolate's first keystroke* pays.
   Both Cache API and KV are an **async network round-trip on cold start**, on the latency-
   sensitive path where the user is mid-typing. For the completion catalogue specifically
   (states/chains/categories are <5 KB; items ~60–65 KB / §9 of Resources) the right answer is
   **embed-or-memoize**, not "reuse the Resources cache verbatim." This is the single highest-
   value finding (CF-1).

2. **Rate limiting (Open Q5).** The spec leans "rely on the shared upstream 120/60s." That
   limit is **not enforced in this Worker** — it is an *advertised* number in the server card
   (`src/index.ts:935`) and (presumably) an upstream concern. The Worker has no limiter today.
   Since completion is the one method a client calls per-keystroke, and CF shipped the
   **Workers Rate Limiting binding to GA in Sept 2025**, this is the textbook use case for a
   cheap, local, latency-free in-Worker counter scoped to completion only (CF-2).

3. **WAE write volume (spec §5.3).** "100% sampling is fine (low volume)" was true for
   tools/resources. It is **questionable for per-keystroke completion**: a single 10-char item
   search = up to 10 `writeDataPoint` calls = 10 datapoints. The CF limits (250 datapoints /
   invocation; 100k/day free, 10M/mo paid) won't be *hit* at current scale, but the assumption
   "low volume" no longer holds by construction, and sampling completion telemetry is trivial
   insurance (CF-3).

**Overall assessment: LOW risk, HIGH optimization upside.** Nothing here blocks the build, and
no finding is Critical (no CF hard limit is breached at plausible scale). But the spec should
(a) pin the completion catalogue to embed/module-global rather than defer to the Cache/KV
phases, (b) adopt the native Rate Limiting binding scoped to completion, and (c) sample
completion WAE. The infra verdict on **sequencing (Q1)** aligns with the spec's own
recommendation: there is **no infra reason to build the inert machinery early** — the cheapest
endpoint adds the least platform value when it has nothing to complete.

---

## Findings / Opportunities

| ID | Severity/Impact | Title | Mechanism | Recommendation |
|---|---|---|---|---|
| CF-1 | **High** | First-keystroke pays a Cache/KV round-trip | Embed catalogue + module-global memo | Pin completion catalogue to **embedded const** (or module-global memo of first load), not the Resources Cache/KV phases. Zero network on the hot path. |
| CF-2 | **High** | No in-Worker rate limit; completion is per-keystroke | CF Workers **Rate Limiting binding** (GA 2025-09) | Add one `[[ratelimits]]` binding scoped to `completion/complete`, `period=10`, generous limit. Local, ~0-latency. Endorse Q5 *with* this, not bare shared limit. |
| CF-3 | **Medium** | Per-keystroke WAE datapoints; "low volume" no longer holds | WAE `writeDataPoint` sampling | Sample completion telemetry (e.g. 1-in-N or count-only aggregate), or drop per-keystroke points and emit one summary point per completion *session*. |
| CF-4 | **Medium** | Entrypoint not yet widened to `ctx`; `waitUntil` needed for both cache writes and async limiter housekeeping | `fetch(request, env, ctx)` | Confirm the Resources-spec entrypoint widening (Resources §6) lands first; completion's optional async work (sampled WAE, cache refresh) uses `ctx.waitUntil`. |
| CF-5 | **Low** | Smart Placement irrelevant / counterproductive here | (none) | Do **not** enable Smart Placement. Completion is CPU-only at the edge; SP optimizes for back-of-Worker upstream latency, which completion deliberately avoids. |
| CF-6 | **Low** | Bindings hygiene — what completion adds to `wrangler.toml` | `[[ratelimits]]` only | Only CF-2's rate-limit binding is new. If catalogue is embedded (CF-1), **no KV binding is needed for completion** even in Resources Phase-2. Document this. |
| CF-7 | **Info** | Server-card `rate_limit` copy will drift | `src/index.ts:935` | If CF-2 adds a completion-specific limit, update the advertised `rate_limit` string so the manifest stays truthful. |

---

## Detailed opportunities

### CF-1 (High) — Embed the completion catalogue; don't make the first keystroke pay a fetch

**The problem.** Spec §6 says completers read "the same in-memory/cached lists" sourced from
"the #1 catalogue (post-#1 this is either embedded, Cache-API-cached, or KV per the Resources
caching phases)." But Resources §6's two phases are both **network reads**:

- **Phase 1 (Cache API):** `caches.default.match(...)` is a read against the colo cache; on a
  cold isolate (or a cache miss / TTL expiry) it falls through to a `fetch` to the SvelteKit
  upstream → ES. The Cache API "allows fine grained control of reading and writing from the
  Cloudflare global network cache" — it is *not* in-isolate memory; the `match` is an async
  call. ([Cache docs](https://developers.cloudflare.com/workers/runtime-apis/cache/))
- **Phase 2 (KV):** `env.KV.get(...)` is always an async network read (fast, but a round-trip;
  cold reads can be tens of ms from the central store before the colo caches it).

For *Resources* this is fine — a `resources/read` is a one-shot, the client isn't blocked
mid-interaction. For **completion it is the wrong tradeoff**: the user is typing, the client
debounces and fires `completion/complete`, and the *first* call after a fresh isolate spins up
would block on a Cache/KV fetch before the first suggestion appears. Subsequent keystrokes are
fine (warm), but the cold first-keystroke latency is exactly the impression a completion UX
lives or dies on.

**The win.** The completion catalogue is **small and changes only on the weekly ETL**
(Resources §1 non-goals). The minimal field set the completers need is even smaller than the
Resources payload — completers only need `name` (+ `item_category` for the category completer,
+ `premise_count` for chain tie-break, §6). That is well under the
[Worker bundle size limits](https://developers.cloudflare.com/workers/platform/limits/) (1 MB
gzipped Free / 10 MB paid). So:

- **Preferred: embed a completion-shaped catalogue as a bundled const** (mirror
  `src/methodology.ts` / `src/changelog.ts`, which Resources §5 already establishes as the
  embed pattern). The names list is parsed once at module init and lives in the isolate for
  the isolate's whole life. **Zero network on every keystroke, including the first.** The
  weekly-ETL staleness is acceptable for an autocomplete hint list (the spec already accepts
  weekly cadence for the whole catalogue), and a redeploy refreshes it — same cadence the
  embedded methodology already uses.
- **Acceptable fallback: module-global memoization of a single load** (see CF-1b below) — but
  this still pays *one* fetch per fresh isolate; embedding pays zero.

**Why this diverges from "reuse Resources #1 caching."** Resources caching optimizes a
one-shot read; completion optimizes a tight per-keystroke loop with a cold-start corner. The
*data* is shared, but the *delivery mechanism into the isolate* should differ. Recommend the
spec state explicitly: **completers source from an embedded names const, derived from the same
ETL output that feeds the Resources catalogue, not from a live Cache/KV read.** This also
makes the §10 test "no upstream/ES call fires during a completion" trivially, structurally
true rather than dependent on a warm cache.

**Complexity:** Low. One generated const file (could be ETL-emitted at build time, or a
checked-in `src/completion-catalogue.ts`). Adds a build-time sync concern (the schema-drift CI
check Resources §13 already proposes can cover it).

**CF limits cited:** bundle size 1 MB gz Free / 10 MB paid
([limits](https://developers.cloudflare.com/workers/platform/limits/)); embedding ~60–65 KB of
item names is a rounding error.

### CF-1b — Module-global memoization (the per-isolate cache)

Even if the team prefers a live source (Phase-2 KV) over embedding, the parsed catalogue
**must be memoized in module scope** so only the first keystroke on a fresh isolate touches the
network and all subsequent keystrokes are pure CPU:

```ts
// module scope — survives across requests on the SAME warm isolate
let CATALOGUE: ParsedCatalogue | null = null;
async function getCatalogue(env: Env): Promise<ParsedCatalogue> {
  if (CATALOGUE) return CATALOGUE;            // warm: pure CPU
  CATALOGUE = parse(await loadFromKVorCache(env)); // cold: one fetch, then cached
  return CATALOGUE;
}
```

**CF isolate lifecycle caveat (must be documented):** Cloudflare explicitly warns *not to rely
on global state persisting* — "there is no guarantee that any two user requests will be routed
to the same … instance," though "an isolate … may persist between requests as an optimisation."
([How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)).
For a **read-only, ETL-derived, idempotent cache** this is the *sanctioned* use of module
globals — the only failure mode is a cold isolate paying one extra fetch, never correctness.
This is materially different from mutable cross-request state (which is the anti-pattern).
**Embedding (CF-1) sidesteps even this** because the const is part of the bundle, present in
every isolate from init with no fetch at all. Recommend embedding; if not, mandate the
module-global memo and document the lifecycle caveat in §6.

### CF-2 (High) — Use the native Workers Rate Limiting binding, scoped to completion (answers Q5)

**The gap.** The spec (§9, Q5) leans on "the shared upstream 120 req/60s/IP limit." Reading the
Worker, **there is no rate limiting in this Worker at all** — the "120 req/60s per IP" is an
*advertised string* in the server card `_meta.rate_limit` (`src/index.ts:935`) and the root
manifest, presumably enforced upstream at manamurah.com. So "rely on the shared limit" actually
means "rely on an upstream limiter that completion's in-memory completers **never reach**"
(completion does no `callUpstream`). A completion flood therefore burns **Worker CPU/invocation
budget and WAE writes** without ever tripping the upstream counter. The shared limit does not,
in fact, protect the completion path.

**The mechanism.** Cloudflare made the **Workers Rate Limiting binding GA on 2025-09-19**
("Rate Limiting within Cloudflare Workers is now Generally Available … the `ratelimit` binding
is now stable and recommended for all production workloads").
([GA changelog](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/))
Crucially for a latency-sensitive path: "*the underlying counters are cached on the same
machine that your Worker runs in … while in your code you `await` a call to the `limit()`
method you are not waiting on a network request. You can use the Rate Limiting API without
introducing any meaningful latency.*"
([rate-limit binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/))
That is the perfect property for completion: a guard that costs ~0 ms per keystroke.

**Config (single binding, `wrangler.toml`):**
```toml
[[ratelimits]]
name = "COMPLETION_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 60       # generous — a fast typist, debounced, won't approach this
  period = 10      # 10 or 60 only
```
```ts
const { success } = await env.COMPLETION_LIMITER.limit({ key });
if (!success) return { completion: { values: [], hasMore: false } }; // graceful, not -32xxx
```

**Key choice — a caveat to flag.** CF docs say keys "should represent stable user identifiers
… not recommended to use IP addresses." This Worker has **no auth and no stable user id** — the
only per-caller signal is the client IP (`CF-Connecting-IP`) or the MCP session header
(`Mcp-Session-Id`, already in CORS allow-list `src/index.ts:776`). Recommend keying on
`Mcp-Session-Id` when present, falling back to IP. Accept that the binding is "permissive,
eventually consistent, and intentionally designed to not be used as an accurate accounting
system" — which is exactly right for a *flood guard* (not billing). On flood, return an empty
completion set, **not** a JSON-RPC error — completion degrading to "no suggestions" is benign.

**Alternative considered — WAF Rate Limiting Rules:** could rate-limit at the edge before the
Worker runs, but (a) it's plan-gated and rule-count-limited, (b) it can't see the JSON-RPC
*method* (all completion + tools share the `/mcp` POST path), so it would throttle real tool
calls too. **Rejected** — the in-Worker binding can scope to `completion/complete` specifically.
This is the decisive advantage over both WAF and the shared upstream limit.

**Win:** completion-specific flood protection, ~0 added latency, scoped so it never throttles
tool calls. **Complexity:** Low — one binding, ~5 lines. **Plan note:** the GA changelog and
binding docs do not gate the binding by plan; it's part of the standard Workers runtime
bindings surface (verify on the account's plan at implement time).

### CF-3 (Medium) — Sample completion WAE writes; "low volume" is no longer the regime

**The shift.** Today WAE is "one 100%-sampled datapoint per JSON-RPC request"
(`wrangler.toml:19-26`, `src/analytics.ts`). For tools/resources that's genuinely low volume.
**Completion inverts this:** a single user typing a 10-char query, even debounced, can emit
several `completion/complete` requests, each → one `recordMcp` → one `writeDataPoint`. Multiply
by concurrent users.

**The CF limits (for grounding, not because they're hit):**
- **250 data points per Worker invocation.** Not a risk — each `/mcp` POST is one JSON-RPC
  request = one invocation = one datapoint. We're nowhere near 250.
- **Free: 100,000 data points written / day; Paid: 10M/mo, +$0.25/additional million.**
  ([WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/),
  [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)) Billing is
  *currently not enforced* ("you will not be billed … actual billing expected in coming
  months") but the spec should not bank on that.

**At current manamurah scale, 100k/day is unlikely to be hit.** So this is **Medium, not
Critical** — but the spec's stated rationale ("100% sampling is fine, low volume") becomes
*false* the moment completion ships, and that's worth correcting before it's load-bearing.

**Recommendation (pick one):**
- **(a) Aggregate per-session:** emit one WAE point per completion *interaction* (e.g. on a
  debounce boundary or first-result), not per keystroke. Cleanest signal-to-noise.
- **(b) Probabilistic sample:** write completion points 1-in-N (e.g. 1-in-10), tag the point so
  read queries can scale up. Trivial: `if (Math.random() < 0.1) recordMcp(...)`.
- **(c) Count-only:** keep the per-request latency/match-count, but gate completion datapoints
  behind a sampler while keeping tools/resources at 100%.

Either keeps the existing `completionRef` privacy design (§5.3 — ref+arg, never the typed
value, which is the right call and avoids the 96-byte index / 16 KB blob limits anyway). Note
the WAE schema (`src/analytics.ts:15-29`) will need a `completion` method value and the
`completionRef` blob — additive, within the 20-blob / 16 KB-total limits.

**Win:** removes the only path by which this server could approach the WAE free-tier write
ceiling, and keeps telemetry honest. **Complexity:** Very low (one sampler).

### CF-4 (Medium) — Entrypoint must already be `(request, env, ctx)`; completion uses `waitUntil`

The Worker entrypoint today is `fetch(request, env)` (`src/index.ts:787`) — **no `ctx`**.
Resources §6 already mandates widening to `fetch(request, env, ctx)` for `ctx.waitUntil` on the
async `cache.put`. Completion piggybacks on this:

- If CF-3(a/b) sampling does any **async** WAE flush or aggregation, do it under
  `ctx.waitUntil` so it never adds to response latency (WAE `writeDataPoint` is fire-and-forget
  today and synchronous-looking, so this is mostly about *future* async housekeeping and any
  sampled cache refresh).
- If CF-1b memoization is chosen over embedding and a background catalogue refresh is wanted,
  `ctx.waitUntil(refresh())` is the mechanism.

**Recommendation:** make the completion spec **depend on** the Resources entrypoint widening
(it's a co-release per spec §3/§11 anyway). If completion somehow ships before Resources lands
(it shouldn't — see Q1), widen the entrypoint in the completion PR. **Complexity:** trivial,
already planned upstream.

### CF-5 (Low) — Do not enable Smart Placement

Smart Placement relocates a Worker closer to its **back-end origin** to cut Worker→origin
latency. Completion is **deliberately origin-free** (in-isolate CPU, CF-1). Enabling SP would
(a) do nothing for completion and (b) potentially *move the Worker away from the user* for the
`/mcp` tool calls that *do* hit upstream but benefit from edge proximity for the JSON-RPC
framing/CORS. **Recommendation: leave SP off** (it is off — not in `wrangler.toml`). No change;
documented so a future "optimize latency" impulse doesn't reach for it. Cold starts on Workers
are single-digit ms ([eliminating cold
starts](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/)) and
embedding (CF-1) removes the only cold-start network cost completion would otherwise have, so
there is no cold-start problem left to solve.

### CF-6 (Low) — Bindings hygiene

What completion adds to `wrangler.toml`:
- **CF-2:** one `[[ratelimits]]` block (`COMPLETION_LIMITER`). This is the **only mandatory new
  binding**.
- **No new KV binding for completion** if CF-1 (embed) is adopted — even in Resources Phase-2,
  the completion path does not need to read KV because the names list is bundled. This keeps
  the completion feature binding-light and decoupled from the Resources Phase-2 ETL/KV work.
- `WAE` binding already exists (`wrangler.toml:24`); completion reuses it (with CF-3 sampling).
- `[vars] MANAMURAH_API_BASE` unchanged — completion makes no upstream call.

**Recommendation:** spec §5 / a new "Bindings" subsection should list exactly one added binding
(`ratelimits`) and explicitly state "no KV binding required for completion."

### CF-7 (Info) — Keep advertised rate-limit copy truthful

`src/index.ts:935` (server card) and the root manifest advertise `rate_limit: "120 req / 60s
per IP"`. That string already over-promises (it's not Worker-enforced today). If CF-2 adds a
completion-specific limiter, update the advertised metadata so the manifest matches reality
(e.g. note completion's separate budget). Low effort, avoids a "documented behaviour ≠ actual
behaviour" drift that a registry crawler could surface.

---

## Open-question answers (spec §12), through the infra lens

**Q5 — Rate-limit posture.** **Do not rely on the bare shared upstream 120/60s — it does not
protect the completion path** (completion never reaches upstream; the "limit" is an advertised
string, not Worker-enforced). **Recommend adding the native CF Workers Rate Limiting binding
(GA 2025-09) scoped to `completion/complete`**, keyed on `Mcp-Session-Id`→IP fallback,
`period=10`, generous `limit`, returning an empty completion set (not an error) on trip. It's
~0-latency (counters are machine-local), permissive-by-design (correct for a flood guard, not
billing), and — unlike WAF rules or the upstream limit — can be scoped to the completion method
without throttling real tool calls. See CF-2.

**Q1 — Sequencing (infra angle).** **No infra reason to build the inert machinery early; build
#2 with #3 (Prompts) as the spec recommends.** From the platform side completion is the
cheapest, most self-contained endpoint (in-isolate CPU, no upstream, one rate-limit binding,
sampled WAE) — there is no infra de-risking, capacity provisioning, or cold-path warming that
benefits from landing it ahead of its surface. The one genuine cross-dependency
(`fetch(request, env, ctx)` widening, CF-4) is owned by the Resources spec and lands first
regardless. Building completion early would mean carrying a `[[ratelimits]]` binding and WAE
schema fields for an endpoint that returns `{ values: [] }` to every call until a prompt arg
exists. Co-ship.

---

## Spec change requests

1. **§6 (Backing data) — pin the completion catalogue to *embedded* (or module-global memo),
   NOT a live Cache/KV read** (CF-1). Add: "Completers source from a bundled names const
   derived from the same weekly ETL output as the Resources catalogue. No Cache API / KV read
   occurs on the completion hot path; the first keystroke on a fresh isolate pays zero network.
   If a live source is preferred over embedding, the parsed catalogue MUST be memoized in
   module scope (per-isolate), with the documented caveat that CF does not guarantee isolate
   persistence — acceptable because the cache is read-only and ETL-derived." (CF-1, CF-1b)

2. **§9 / Q5 — replace "rely on shared 120/60s" with the CF Rate Limiting binding** (CF-2). Add
   a `[[ratelimits]]` config block scoped to completion, keyed on session→IP, returning an
   empty completion set on trip. Note explicitly that the upstream/advertised limit does NOT
   cover the completion path because completion makes no upstream call.

3. **§5.3 — sample completion WAE writes** (CF-3). Replace "100% sampling is fine (low volume)"
   with one of: per-session aggregation, 1-in-N probabilistic sampling, or a completion-only
   sampler — and note the 100k/day Free write ceiling as the reason. Keep the `completionRef`
   privacy rule (ref+arg only, never the typed value).

4. **Add a "Bindings" note** (CF-6): completion adds exactly one binding (`ratelimits`); **no KV
   binding is required for completion** even under Resources Phase-2; `WAE` reused with
   sampling; entrypoint must be `(request, env, ctx)` (inherited from Resources §6, CF-4).

5. **§5.4 / discovery — update advertised `rate_limit` metadata** (`src/index.ts:935`) if CF-2
   adds a completion-specific limit, so the server card / root manifest stay truthful (CF-7).

6. **§5 / non-goals — explicitly state Smart Placement stays off** (CF-5): completion is
   origin-free; SP offers no benefit and risks pulling the Worker away from users for the
   upstream-bound tool calls.

---

## CF docs cited

- Workers Rate Limiting binding (GA, latency, accuracy caveat, config):
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- Rate Limiting in Workers GA changelog (2025-09-19):
  <https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/>
- Workers Analytics Engine limits (250 datapoints/invocation, 20 blobs, 16 KB total, 96-byte index):
  <https://developers.cloudflare.com/analytics/analytics-engine/limits/>
- WAE pricing (100k/day Free, 10M/mo paid, +$0.25/M; billing not yet enforced):
  <https://developers.cloudflare.com/analytics/analytics-engine/pricing/>
- Cache API (global-network cache, not in-isolate; async):
  <https://developers.cloudflare.com/workers/runtime-apis/cache/>
- How Workers works (isolate lifecycle, no-guarantee on global persistence):
  <https://developers.cloudflare.com/workers/reference/how-workers-works/>
- Workers platform limits (bundle size 1 MB gz Free / 10 MB paid):
  <https://developers.cloudflare.com/workers/platform/limits/>
- Eliminating cold starts (single-digit-ms isolate starts):
  <https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/>
