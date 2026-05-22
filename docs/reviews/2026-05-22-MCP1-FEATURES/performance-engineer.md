# Performance Review — MCP Resources for manamurah MCP server

**Date:** 2026-05-22
**Persona:** Performance Engineer
**Scope:** `docs/2026-05-22-spec-mcp-resources.md` (primary) + `docs/2026-05-22-mcp-enhancement-proposals.md`. Grounding: `src/index.ts`, `src/analytics.ts`, `src/changelog.ts`, `wrangler.toml`, `package.json`, `tsconfig.json`. REVIEW ONLY — no code changed.

---

## Executive summary

The spec is performance-conscious by design — it keeps the Worker stateless, leans on the existing upstream 12h KV cache, defers subscriptions, and writes resources as reference data (not query results). That said, three issues materially threaten the stated goals:

1. **The 80 KB budget for `catalogue/items` is not met by the proposed 5-field lean set.** My byte-count estimate puts the 5-field compact payload at **~95–98 KB** (~25K tokens), 19–22% over budget. The spec's own "~40–60 KB" note (§2) is optimistic by roughly 2x. The budget is achievable, but only by dropping `name_en` (→ ~63 KB) or by gzip transport (which MCP `text` content does not give you) — so the spec must either raise the budget number to ~100 KB or trim a field. As written, the size-assertion test in §7 will fail on first run.

2. **The `manamurah://item/{item_code}` template is an N+1 amplifier with no batch escape hatch.** Each `resources/read` is exactly one Worker→manamurah.com→ES round-trip (`callUpstream`, `src/index.ts:581`). A client hydrating 50 item cards = 50 sequential JSON-RPC POSTs = 50 upstream fetches. There is no list/batch variant. Defer the template to v2, or pair it with a documented "use `catalogue/items` for bulk" steer.

3. **The Worker is stateless with zero edge caching on its own responses** — every `resources/read` re-proxies even though the data is identical for ~12h (upstream KV) to a week (ETL cadence). The biggest, most static payload (`catalogue/items`) is re-fetched and re-serialized on every single read. A `cache: { cacheTtl }` hint on the upstream `fetch` (or the Cloudflare Cache API) would collapse repeat reads to edge hits at ~0 upstream cost.

**Overall performance-risk rating: Medium.** Nothing here breaks under load — read volume is low, payloads are bounded, and the stateless proxy scales horizontally for free on Workers. But the items-catalogue size miss is a real budget violation, and the template + no-edge-cache combination leaves easy latency/cost wins on the table. None are Critical because the worst case (a client reading the full catalogue every turn) burns context, not the server.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| P1 | High | `catalogue/items` lean set busts the 80 KB budget (~95–98 KB est.) | spec §2 (line 37), §6 (line 137) | Drop `name_en` (→~63 KB) OR raise budget to ~100 KB; fix the §7 size assertion accordingly |
| P2 | Medium | Item template `{item_code}` is an unbatched N+1 (1 upstream fetch per read) | spec §2 templates (line 50), §9 Q1 | Defer to v2, or ship with explicit "bulk → catalogue/items" guidance + monitor read fan-out |
| P3 | Medium | No Worker-side / edge cache on resource reads — static catalogues re-proxied every call | spec §1 non-goals (line 21), §3.2 (line 70); `src/index.ts:581,612` | Add `fetch(..., { cf: { cacheTtl, cacheEverything:true } })` on resource upstream calls (TTL ~3600s) |
| P4 | Low | `resources/read` uses no pagination/cursor; `catalogue/items` is all-or-nothing | spec §3.2 (line 70), §4 | Acceptable for v1 given <100 KB; note cursor as a v2 lever if items grow past ~1500 |
| P5 | Low | Pretty-print risk: tools use `JSON.stringify(data,null,2)` (`:678`); resources must use compact | spec §4 (line 79); `src/index.ts:678` | Confirm resources serialize with compact `JSON.stringify(data)` — pretty-print adds ~40% bytes |
| P6 | Info | Embedded methodology markdown adds to bundle but is negligible (~3–6 KB) | spec §5 (line 124), §9 Q3 | Embed (Q3 leaning is correct) — bundle stays well under Workers' 1 MB (gzip) limit |
| P7 | Info | `resources/list` / `resources/templates/list` are static — no upstream fan-out | spec §3.2 (line 67) | Good. Keep them as static `const RESOURCES` arrays like `TOOLS` — zero round-trips |
| P8 | Low | Per-resource `weekdate` duplication across every payload | spec §4 (line 113) | Cheap (~20 bytes/resource); fine. Don't add it per-row inside `catalogue/items` (would add ~15 KB) |

---

## Detailed findings

### P1 (High) — `catalogue/items` lean set exceeds the 80 KB budget

**Evidence.** Spec §2 (line 37) proposes lean fields `item_code, name, name_en, unit, item_category` plus a top-level `weekdate`, and estimates "~40–60 KB". §6 (line 137) sets the test budget at "< 80 KB".

Byte estimate for 756 items, compact JSON (`JSON.stringify`, no whitespace), realistic Malaysian field lengths (`name` avg ~22 chars, `name_en` ~22, `item_category` ~14, `unit` ~4, numeric `item_code` ~4):

- Per-item object incl. all 5 keys, quotes, colons, commas, braces: **~132 bytes**
- 756 × 132 ≈ **97.5 KB** compact (≈ **~25,000 tokens**)
- A conservative floor (very short names, no `name_en`): ~85 bytes/item → **~63 KB**

So the **5-field lean set lands at ~95–98 KB**, roughly **19–22% over** the 80 KB budget and ~1.6–2.4x the spec's own "40–60 KB" guess. The spec's estimate appears to have undercounted JSON key overhead (the five repeated keys cost ~50 bytes/row before any values).

**Token-cost angle.** ~25K tokens is a meaningful slice of a client context window — the whitepaper's "concise output" concern. If a Host auto-loads this resource on every session, that is 25K tokens of standing context. Dropping `name_en` removes the per-row English string AND its 10-byte key → ~63 KB / ~16K tokens, a ~35% reduction.

**Recommendation (pick one):**
- **(a) Drop `name_en`** from the catalogue. Clients that need English can call `search_items` (which returns translations). → ~63 KB, comfortably under 80 KB. *Tradeoff:* English-only agents lose up-front readability.
- **(b) Raise the budget to ~100 KB** and keep `name_en`, accepting ~25K tokens. Update §6 and the §7 assertion to `< 100 KB`.
- **(c) Two resources:** `catalogue/items` (4-field, ~63 KB) + `catalogue/items-i18n` (full multilingual, on demand). Lets the Host choose. Best long-term, slightly more surface area.

Either way, **the §7 size-budget test must be set to a number the lean set actually meets** — as specified (`< 80 KB` with 5 fields) it fails on first run.

---

### P2 (Medium) — Item template is an unbatched N+1

**Evidence.** Spec §2 (line 50) defines `manamurah://item/{item_code}` backed by `GET /api/v2/mcp/catalogue/item/{item_code}`. The Worker proxies one URI per `resources/read` via `callUpstream` (`src/index.ts:581`), which issues exactly one `fetch` (`:612`) → manamurah.com → ES. There is no array/batch read in MCP `resources/read` (one `uri` param, one `contents` result).

**Amplification.** A client building a comparison table for, say, a 20-item basket via the template = **20 JSON-RPC POSTs = 20 upstream fetches**, sequential unless the client parallelizes. Each carries full HTTP + JSON-RPC framing overhead. The 12h upstream KV cache softens *cost* (warm reads are cheap ES-side) but not *round-trip count* — the Worker still does N network hops, N TLS sessions' worth of latency from the client's perspective.

**Contrast:** `catalogue/items` gives all 756 cards in **one** read. The template is strictly worse for any multi-item workload; it only wins for a single-entity "what is item 1411" lookup — which `search_items` already serves.

**Recommendation:** This is the **N+1 risk that argues for deferring the template** (Open Q1). If shipped in v1, the template `description` must steer bulk consumers to `catalogue/items` ("for multiple items, read the full catalogue resource instead"), and `src/analytics.ts` should track `resource` reads (already proposed in §3.3) so we can watch for fan-out abuse. Do **not** ship the template without that telemetry — you'd be blind to the amplification.

---

### P3 (Medium) — No Worker-side / edge caching; static catalogues re-proxied on every read

**Evidence.** Spec §1 non-goals (line 21–24) correctly avoids subscriptions and relies on "the upstream 12h KV cache." But the Worker itself is stateless (`src/index.ts` header comment, lines 7–13: "No credentials, no backing database… Per-request isolation") and `callUpstream` (`:612`) issues a plain `fetch(url, init)` with **no Cloudflare cache directives**. Every `resources/read` of `catalogue/items` therefore:

1. Round-trips to manamurah.com (even if upstream serves from KV in ~ms, it's still a hop), AND
2. Re-runs `JSON.stringify` over the ~95 KB payload in the Worker on every call.

For data that is byte-identical for 12h (upstream) to a week (ETL), this is pure repeat work.

**Recommendation (high-level — infra specifics are another reviewer's lane):** Add a Cloudflare cache hint to the resource-backing fetches:

```ts
fetch(url, { ...init, cf: { cacheTtl: 3600, cacheEverything: true } })
```

This lets the Worker's own colo edge-cache the upstream GET, collapsing repeat reads of the big static catalogue to local edge hits (~0 upstream cost, no re-fetch latency). TTL of ~1h is safely under the weekly ETL cadence and the 12h upstream window. Tools should *not* get this (they're parameterized queries); scope it to the resource read path only. This is the single best latency+cost win in the spec and it's a ~2-line change. Note the serialization cost (#2 above) still recurs unless you also cache the serialized string — minor, deprioritize.

---

### P4 (Low) — No cursor pagination on `catalogue/items`

`resources/read` returns the whole catalogue in one `contents` block (spec §4). At ~95 KB / 756 items this is fine — MCP has no hard payload cap and the data is bounded. Flag only as a v2 lever: if the item catalogue grows past ~1,500 items the payload crosses ~190 KB and pagination (or the i18n split in P1c) becomes worthwhile. No action for v1.

### P5 (Low) — Confirm compact serialization for resources

`handleToolCall` serializes with `JSON.stringify(data, null, 2)` (`src/index.ts:678`) — pretty-printed, ~40% byte inflation. Spec §4 (line 79) correctly specifies resources use `JSON.stringify(data)` (compact). **Ensure the `resources/read` handler does NOT copy the tool path's pretty-print** — a 95 KB compact catalogue becomes ~135 KB pretty-printed, blowing past any budget and wasting tokens. Add this as an explicit implementation note.

### P6 (Info) — Embedded methodology markdown: negligible bundle impact

`changelog.ts` is 9,114 bytes embedded as a template literal and ships fine. A methodology blob of similar size (~3–6 KB of the `/about` essentials) adds trivially to the bundle. `src/index.ts` is 33 KB source; total source is ~42 KB; the deployed Worker (minified) is far under the 1 MB gzip limit. Cold-start impact is sub-millisecond for a few KB of static string. **Embed it (Open Q3 leaning is correct)** — it removes one upstream round-trip per methodology read at no meaningful bundle/cold-start cost.

### P7 (Info) — `resources/list` is static — good

Spec §3.2 (line 67) builds `resources/list` from a static `const RESOURCES` array, mirroring the existing static `TOOLS` array (`src/index.ts:139`). This means **`resources/list` does NOT fan out to upstream** — zero round-trips, pure in-memory. Correct and important; do not let it drift into per-resource liveness probes.

### P8 (Low) — `weekdate` duplication

Per-resource top-level `weekdate` (spec §4 line 113) costs ~20 bytes per resource — negligible. **Do not** push `weekdate` into each of the 756 item rows inside `catalogue/items`; that would add ~15 KB (756 × ~20 bytes) and worsen P1. Keep it at the envelope level only.

---

## Open question answers (through the performance lens)

**Q2 — Items catalogue: lean vs full multilingual? (size/latency)**
Lean. But the proposed **5-field lean set is ~95–98 KB / ~25K tokens — over the 80 KB budget** (see P1). Full multilingual (adding `name_zh`, `name_ta`, aliases) ≈ **~176 KB / ~45K tokens** — nearly 2.2x and clearly unacceptable for standing context. Recommended: **4 fields (drop `name_en`) → ~63 KB / ~16K tokens**, or keep 5 fields and raise the budget to ~100 KB. Full multilingual only as a separate on-demand resource (P1c).

**Q4 — `meta/latest-week` now vs fold into proposal #4 coverage tool? (round-trip/duplication)**
Ship `meta/latest-week` **now**, as a resource. It's tiny (~3 fields, <1 KB) and, more importantly, it *removes* round-trips: the spec already stamps `weekdate` into every resource payload (§4), so a freshness resource lets clients check staleness without re-reading a big catalogue. Folding it into the future coverage *tool* (#4) would force a tool *call* (a query round-trip) for what is pure reference data — the wrong primitive. The overlap is acceptable: `meta/latest-week` = global freshness signal (resource, cached, free); coverage tool #4 = per-item/per-scope reliability (parameterized query, tool). No real duplication, and the resource is the cheaper path. **Leaning in spec is correct.**

**Q1 — Ship the item template in v1 or defer? (N+1 risk)**
**Defer to v2** on performance grounds. The template is an unbatched N+1 (P2): N item cards = N upstream fetches, with no batch alternative, and `catalogue/items` + `search_items` already cover both bulk and single-lookup needs. The marginal value over those two is small; the amplification risk is real. If product insists on v1, gate it on: (a) the `resource` telemetry field (§3.3) being live so fan-out is observable, and (b) a template description that explicitly routes bulk consumers to `catalogue/items`. (The spec's "high value, low cost" leaning underweights the per-read round-trip cost.)

---

## Spec change requests (concrete edits)

1. **§2, line 37 + §6, line 137 (P1):** Change the items-catalogue size note from "~40–60 KB" to "**~95–98 KB at 5 fields (~25K tokens); ~63 KB at 4 fields**". Change the §6 budget from "< 80 KB" to either "**< 100 KB** (5-field)" or, if dropping `name_en`, "**< 70 KB** (4-field)". Make the §7 size-assertion match whichever set ships.
2. **§2, line 37 (P1):** Either remove `name_en` from the lean field list, or add an explicit decision note that the 80 KB budget is being raised to ~100 KB to retain it.
3. **§3.2 / §5 (P3):** Add an implementation note: resource-backing upstream fetches use `fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })` so the Worker edge-caches static catalogues; tool calls do not.
4. **§3.2, line 79 + §4 (P5):** Add an explicit note: "`resources/read` serializes JSON with compact `JSON.stringify(data)` — NOT the `null, 2` pretty-print used by `tools/call` at `src/index.ts:678`."
5. **§9 Q1 / §2 templates (P2):** Record the recommendation to **defer the `{item_code}` template to v2**; if shipped in v1, require (a) `resource`-field telemetry live, and (b) a description that steers bulk reads to `catalogue/items`.
6. **§4, line 113 (P8):** Add: "`weekdate` lives at the resource envelope level only — never per-row inside `catalogue/items`."
