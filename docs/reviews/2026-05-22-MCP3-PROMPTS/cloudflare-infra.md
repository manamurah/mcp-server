# MCP3 Prompts (+ absorbed Completions) — Cloudflare Infrastructure Review

**Date:** 2026-05-22
**Persona:** Cloudflare Infrastructure Reviewer
**Spec under review:** `docs/2026-05-22-spec-mcp-prompts.md` (v2.9.0)
**Context:** `docs/2026-05-22-spec-mcp-completions.md` (CF rate-limit binding, embedded catalogue), `docs/2026-05-22-spec-mcp-resources.md` §6 (caching/embed phases)
**Grounding read:** `src/index.ts`, `src/analytics.ts`, `src/changelog.ts`, `wrangler.toml`, `package.json`
**Scope:** CF-platform fit, optimisation, limits. REVIEW ONLY — no files changed except this one; no `wrangler deploy`; no CF mutation.

---

## Executive summary

**Overall assessment: GREEN — ship as specified.** MCP3 is the most CF-friendly of the three MCP features. `prompts/get` is pure in-memory string assembly over bundled consts — zero origin hop, zero subrequest, no Smart Placement need, and it executes well inside the 1 s startup-CPU budget. The cumulative embed (methodology + ~75–90 KB catalogue + existing code) is **trivially within** the CF Worker size limit: the limit is **3 MiB Free / 10 MiB Paid measured *after gzip*** (64 MB uncompressed), and text/JSON consts compress ~2.4× (measured: this repo's 10 KB `changelog.ts` → 4.3 KB gzipped). Even a generous 120 KB raw embed lands ≈40–50 KB gzipped against a 10 MiB ceiling — **>200× headroom**. No Critical findings.

The one genuinely load-bearing infra carry-over from #2 is the **native CF Rate Limiting binding** (GA 2025-09-19) for `completion/complete` — it is correct and necessary because in-memory completion never reaches the "120/60s upstream" limiter. `prompts/get` does **not** need its own rate limit (data-free, ~one call per slash-command invocation, not per-keystroke). MCP3 inherits the `fetch(request, env, ctx)` widening from #1/#2 but introduces **no new `ctx`/Cache-API requirement of its own**, and adds **no new `wrangler.toml` binding beyond the one `[[ratelimits]]` block from #2**.

Recommendations are optimisations and hygiene, not blockers.

---

## Findings / Opportunities

| ID | Severity/Impact | Title | Mechanism | Recommendation |
|---|---|---|---|---|
| CF-1 | Info | Cumulative embed nowhere near the size limit | Limit is 3 MiB Free / **10 MiB Paid after gzip** (64 MB uncompressed). Embed ~75–90 KB raw → ~30–40 KB gzipped. | Endorse the embed approach. Keep the existing **<100 KB CI gate on `catalogue/items`** (Resources §9) — it caps the only growth lever long before any CF limit. |
| CF-2 | Info | `prompts/get` is ideal edge work | Pure string assembly + bundled const; no `fetch`, no subrequest, no DB. Runs in the isolate, sub-ms. | Confirm no Smart Placement, no origin hop. `render: () => PromptMessage[]` (non-Promise) type already structurally forbids an await — endorse §10. |
| CF-3 | Low | Don't Cache-API `prompts/list`/`get` | Responses are static but generated in <1 ms from RAM. A `caches.default` round-trip (synthetic key + `waitUntil put`) costs *more* than regenerating, and burns the per-request Cache-API call quota (50 Free / 1000 Paid, shared with subrequests). | **Do not** cache prompt responses at the edge. Optionally set a response `Cache-Control` header so MCP clients/CDN may cache the HTTP response. Not worth Worker-side caching. |
| CF-4 | Medium | `prompts/get` needs no dedicated rate limit; completion does | Data-free + low-volume (per slash-command, not per-keystroke) → upstream/none is fine for `prompts/get`. Completion is per-keystroke and bypasses the upstream 120/60s limiter entirely. | Keep the `[[ratelimits]]` binding scoped to `completion/complete` only (per #2 §9). Do **not** extend it to `prompts/get`. If a global JSON-RPC body-size cap exists (Completions §9), it already covers `prompts/get` abuse. |
| CF-5 | Low | One new binding total across #1+#2+#3 | #1 adds optional KV (Phase 2, deferred). #2/#3 add exactly one `[[ratelimits]]` block. No prompt-specific binding. | Add only the `[[ratelimits]]` block (CF-6). Document in `wrangler.toml` next to the existing `WAE` block. Confirm `wrangler >= 4.36.0` (repo pins `^4.93.1` — satisfied). |
| CF-6 | Info | Rate-limit binding wrangler syntax | GA binding format. | Add to `wrangler.toml` (see Detailed §CF-6). `simple.period` **must be 10 or 60**; key on `Mcp-Session-Id`→IP; trip returns empty completion set, not an error (per #2). |
| CF-7 | Info | Handler signature inherited, no new requirement | #1/#2 widen `fetch(request, env)` → `fetch(request, env, ctx)` for Cache API + `waitUntil`. MCP3's own paths use neither. | MCP3 inherits the widened signature; **no new `ctx` requirement**. If MCP3 ever shipped standalone (it won't — depends on #1), it would still need the widening only for #2's telemetry `waitUntil`, not for prompts. |
| CF-8 | Low | Startup CPU budget — parse the embed lazily | Global scope (top-level code) must parse+execute within **1 s**. A large embedded const string is parsed at module load. JSON parse of the catalogue should be lazy/memoised, not eager at top level. | Per Completions §7, parse/fold the catalogue into a **module-global memo on first use**, not at import time. Keep methodology as a raw string const (no parse). This keeps startup CPU well clear of 1 s even as the embed grows. |
| CF-9 | Info | Workers AI not relevant to v1 prompts | Prompts are static templates the *client's* LLM executes; the Worker does no inference. Workers AI would re-introduce an origin-side model call, cost, and latency — contrary to the data-free design (§3). | Note and **decline** for v1. No scope. (A future server-side reranker for completion *could* use Workers AI, but Completions §3 already chose in-memory fold — keep it.) |
| CF-10 | Low | Telemetry write amplification under spike | `completion/complete` is highest-volume (per-keystroke); each WAE write is billable. | #2 §10 already mandates **10% sampling on completion** (100% on `prompts/get`, which is low-volume). Endorse — this is the correct split. Verify the sampling wraps the completion-path `recordMcp` only. |

---

## Detailed opportunities

### CF-1 — Bundle size: enormous headroom (Info)
**Mechanism.** CF Worker size is capped at **3 MiB (Free) / 10 MiB (Paid) after gzip compression**, with a separate 64 MB *uncompressed* ceiling ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). The spec embeds: methodology const (small markdown, single-KB), the ~75–90 KB catalogue const (Completions §7 / Resources §9), plus existing `src/index.ts` (~35 KB) + `changelog.ts` (~10 KB). Text/JSON compresses well — measured on this repo, `changelog.ts` 10 KB → **4.3 KB gzipped** (≈2.4×). So a 90 KB catalogue ≈ 35–40 KB gzipped; total bundle gzipped is comfortably **under ~200 KB** against a **10 MiB** Paid ceiling.

**Win.** The cumulative embed is **not** approaching any CF limit — not even on the Free plan's 3 MiB. The binding limit here is the spec's own **`catalogue/items` < 100 KB CI gate** (Resources §9), which trips two orders of magnitude before CF cares. That gate, plus the recent-active filter that shrinks the catalogue as discontinued items age out, is the right control. No CF-driven action needed.

### CF-2 — `prompts/get` at the edge (Info)
**Mechanism.** `render(args)` returns `PromptMessage[]` synchronously (§10 types it non-Promise). No `fetch`, no `callUpstream`, no ES. The handler validates args, clamps lengths, substitutes strings, and inlines the methodology const. This is pure isolate CPU, sub-millisecond.

**Win.** Confirmed **ideal edge work**: no Smart Placement (which exists to move *origin-bound* Workers closer to a backend — irrelevant when there's no backend call), no origin hop, no cold-fetch tail latency. The §13 CI gate ("no upstream fetch fires during `prompts/get`") structurally guarantees this property — endorse it.

### CF-3 — No Cache API for prompt responses (Low)
**Mechanism.** Cache API (`caches.default`) costs a synthetic-GET key build + a `match()` lookup + (on miss) a `waitUntil(put())`. Each `match`/`put` counts against the per-request Cache-API quota (**50 Free / 1000 Paid**, shared with subrequests — [limits](https://developers.cloudflare.com/workers/platform/limits/)). For an output that regenerates from RAM in <1 ms, caching is net-negative: it adds I/O and quota pressure to save nothing.

**Win.** Skip Worker-side caching for `prompts/list` and `prompts/get`. The Cache API is the right tool for #1's *upstream* resource fetches (Resources §6 Phase 1), not for data-free assembly. If clients re-fetch frequently, an HTTP `Cache-Control: public, max-age=...` response header lets the *client/CDN* cache cheaply — zero Worker cost — but even that is marginal given the low call volume.

### CF-4 — Rate limiting: completion yes, prompts no (Medium)
**Mechanism.** The advertised "120 requests / 60 s" limit is enforced *upstream* (manamurah.com). `completion/complete` is answered **in-memory from the embedded catalogue and never reaches the upstream** (Completions §9) — so without a dedicated limiter it is uncapped, and it's the per-keystroke (highest-volume) method. The native CF Rate Limiting binding (GA 2025-09-19, [changelog](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/)) is a machine-local counter with ~0 added latency — perfect for capping an in-isolate method without touching tool calls.

`prompts/get`, by contrast, is invoked roughly **once per slash-command run** (not per-keystroke), is data-free and cheap, and the realistic abuse ceiling is bounded by the global JSON-RPC body-size cap (Completions §9).

**Win.** Keep the `[[ratelimits]]` binding **scoped to `completion/complete`** (key `Mcp-Session-Id`→client IP, trip → empty completion set per #2). Do **not** add a second limiter for `prompts/get` — it would add config surface and a counter for negligible risk. Upstream/none is the correct posture for `prompts/get`.

### CF-6 — Binding hygiene / wrangler config (Info)
**Mechanism.** The cumulative `wrangler.toml` binding set across #1+#2+#3:
- existing: `[vars] MANAMURAH_API_BASE`, `[[routes]]` custom domain, `[[analytics_engine_datasets]] WAE`
- #1 (deferred Phase 2): one optional KV namespace — **not in #3's scope**
- #2/#3: **one** `[[ratelimits]]` block (the only addition #3 lands)
- #3 prompts: **nothing** — prompts are pure code, no binding

**Win.** Add exactly this to `wrangler.toml` (GA syntax, [rate-limit docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)):
```toml
[[ratelimits]]
name = "COMPLETION_RL"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 60       # tune per #2; per-session/IP keystroke cap
  period = 60      # MUST be 10 or 60
```
Called as `await env.COMPLETION_RL.limit({ key })`. Requires `wrangler >= 4.36.0` — repo pins `^4.93.1` (satisfied). Free, no separate billing line. Add a comment block mirroring the existing `WAE` documentation. Add `COMPLETION_RL` to the `Env` interface in `src/index.ts`.

### CF-8 — Lazy-parse the embed to protect startup CPU (Low)
**Mechanism.** The **startup CPU limit is 1 s** for global-scope execution ([limits](https://developers.cloudflare.com/workers/platform/limits/)). If the catalogue const is `JSON.parse`d (or eagerly folded) at module top-level, that work runs on every cold isolate before the first request. At ~90 KB it's still fast, but eager top-level parse is a bad habit as the embed grows.

**Win.** Completions §7 already prescribes a **module-global memo populated on first use** (per-isolate, lazy) — endorse it explicitly for MCP3. Methodology stays a raw string const (no parse). This keeps cold-start CPU negligible regardless of catalogue growth.

---

## Open question answers (infra lens)

- **Q2 (embed methodology in all 3 prompts vs only `semak-dakwaan-harga`):** *Infra-neutral — embed in all where the discipline applies.* The methodology const is single-KB; embedding it in 3 rendered messages instead of 1 has **zero bundle cost** (the const is bundled once; rendering inlines a reference to the same string, and even the worst case — three full copies in three response payloads — is KB-scale per response, not bundle-scale). The only cost is **client context tokens** at `prompts/get` time, which is a prompt-design call, not infra. From the CF side, embed wherever the analysis genuinely needs the caveats (the spec's lean — fact-check + compare, one-line note for basket — is fine). No infra reason to restrict.

- **Q4 (`prompts/get` strictly data-free):** *Strongly endorsed — keep it data-free.* This is the property that makes `prompts/get` zero-subrequest, zero-origin-hop, edge-fast, and immune to the recurring ES-cost risk. Embedding the live catalogue into `prompts/get` would couple it to upstream/embed-staleness and bloat every response payload for no benefit — the LLM pulls fresh data via tools, and `barang` is served by the completer. Reject server-side pre-fetch (spec §3 already does). Maintain the §13 "no fetch fires" CI gate.

---

## Spec change requests

1. **§9.2 / §11 (CF-8):** State explicitly that the embedded catalogue is parsed/folded into a **lazy module-global memo on first use**, never at top-level module scope — to stay clear of the 1 s startup-CPU limit as the embed grows. (Reinforces Completions §7; make it normative in #3 too.)
2. **§14 build step 3 (CF-6):** Pin the `wrangler.toml` `[[ratelimits]]` block to the GA `simple.{limit,period}` syntax with `period ∈ {10,60}`, and note the **`wrangler >= 4.36.0`** floor (already satisfied by `^4.93.1`). Add `COMPLETION_RL` to the `Env` interface.
3. **§3 / §6 (CF-3):** Add a one-line normative note that `prompts/list`/`prompts/get` responses are **not** Cache-API cached at the Worker (data-free, regenerated from RAM cheaper than a cache round-trip; caching would burn the shared 50/1000 Cache-API call quota). Distinguish from #1, where the Cache API *is* correct for upstream resource fetches.
4. **§7 / §16-Q (CF-4):** Make explicit that the `[[ratelimits]]` binding is scoped to `completion/complete` **only**, and that `prompts/get` is intentionally **not** rate-limited (data-free, low-volume, covered by the global body-size cap).
5. **§15 (CF-9):** Add Workers AI to out-of-scope: prompts are client-LLM-executed static templates; no server-side inference in v1 (would re-introduce origin cost/latency the data-free design avoids).

---

## Sources

- [Limits · Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/limits/) — Worker size 3 MiB Free / 10 MiB Paid *after gzip* (64 MB uncompressed); startup CPU 1 s; Cache API 50/1000 calls per request, 512 MB max object
- [Rate Limiting · Cloudflare Workers docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — `[[ratelimits]]` syntax, `simple.limit`/`simple.period` (10 or 60), `.limit({ key })`, wrangler ≥ 4.36.0
- [Rate Limiting in Workers is now GA · Changelog (2025-09-19)](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/)
- [Pricing · Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/pricing/)
