# MCP Completions Spec — Performance Engineering Review

**Date:** 2026-05-22
**Persona:** Performance Engineer
**Scope:** `docs/2026-05-22-spec-mcp-completions.md` (the `completion/complete` handler and its
catalogue-backed completers). Grounding read-only against `src/index.ts`, `src/analytics.ts`,
`wrangler.toml`, `package.json`, and the dependency spec `docs/2026-05-22-spec-mcp-resources.md`.
Lens: per-keystroke cost path, in-memory match cost, catalogue load strategy, telemetry overhead,
response size, debounce/caching. REVIEW ONLY — no code changed.

---

## Executive summary

**Overall performance rating: Low risk** (with two Medium items to close before merge).

The design's central performance instinct is correct and well-defended: **no upstream/ES call per
keystroke** (§6, §7, §10 test). Completers are pure in-memory filters over small lists (item ~756,
state 16, chain ~50, category ~40). The raw match cost is genuinely trivial — sub-millisecond CPU
for a full scan + sort of 756 short strings, several orders of magnitude below the network and
JSON-RPC framing cost that dominates every request. Response size (≤100 short strings, a few KB) is
a non-issue. The headline "no ES per keystroke" goal is *achievable* — but the spec does **not yet
pin the mechanism that guarantees it**, and that gap is where the only real perf risk lives.

The two things to fix:

1. **Cold-isolate load is unquantified and unspecified (M1).** The spec says the catalogue is
   "either embedded, Cache-API-cached, or KV per the Resources caching phases" (§6) and leaves the
   choice open. For a *per-keystroke hot path* that openness is a latency trap: the Resources Phase-1
   default is **Cache API**, which is a per-isolate `caches.default.match` + (on miss) an
   upstream→ES fetch. If the completer naively reuses that path, the **first keystroke on a cold
   isolate blocks on the full catalogue fetch** — exactly the ES round-trip the spec swears it
   avoids, just moved from "every keystroke" to "every cold-isolate's first keystroke." The spec
   must mandate a hot-path-specific load strategy and a module-global memo. (Details + latency table
   below.)

2. **Telemetry sampling contradiction (M2).** §5.3 says "100% sampling is fine (low volume)" then
   immediately concedes completion "is the one method a client may call rapidly while typing." Those
   two sentences contradict. Per-keystroke + 100% WAE writes is the one new write-amplification path
   this feature introduces. `writeDataPoint` is fire-and-forget (no `await`, cannot add request
   latency — confirmed at `analytics.ts:92`), so it is **not a latency risk**, but it *is* a
   volume/cardinality and cost risk that the spec's own sentence undercuts. Recommend explicit
   per-keystroke sampling.

Everything else (match algorithm, response size, rate-limit posture) is sound. Q3 (fuzzy) and
Q5 (rate-limit) both resolve in favour of the spec's leanings on perf grounds.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|----|----------|-------|----------|----------------|
| M1 | Medium | Catalogue load strategy left open → cold-isolate first-keystroke can block on an ES round-trip | spec §6, §7; cf. Resources spec §6 Phase 1 | Mandate a module-global in-memory memo + name the lowest-latency backing store (KV ≥ embed > Cache API) for this hot path; quantify cold-start in the spec |
| M2 | Medium | Per-keystroke 100% telemetry sampling — internally contradictory; write-amplification | spec §5.3 | Replace "100% sampling is fine (low volume)" with explicit completion sampling (sample-on-miss, or 1-in-N, or aggregate). Not a latency risk; a volume/cost one |
| L1 | Low | Empty-value path returns all 756 then caps to 100 — wasteful sort, harmless | spec §6 (`item` scale), §2 (empty `value`) | Short-circuit empty/very-short `value` to a precomputed top-N (or skip the sort) |
| L2 | Low | Per-keystroke re-fold/re-lowercase of 756 names — recomputed every call | spec §6 (ASCII-fold matching) | Precompute folded/lowercased match keys once at catalogue load, not per request |
| L3 | Low | Prefix-rank requires a sort of all matches before cap — O(m log m) on worst-case m=756 | spec §4 (prefix-boost), §6 | Fine as-is; note a partial-select (top-100) is available if ever needed. No action required |
| I1 | Info | `value` length clamp (≤64) is also a perf guard against pathological long input | spec §9 | Keep; aligns with existing tool `maxLength: 64` convention |
| I2 | Info | Inert-machinery sequencing (Q1) has ~zero runtime perf cost | spec §3, §11 | Confirmed — registry + capability flag are static; no hot-path cost when unused |

---

## Detailed findings (with latency estimates)

### M1 — Catalogue load strategy is the only real perf risk, and it's left open

**The claim (§6/§7/§10):** "do not add upstream calls per keystroke … no upstream/ES call fires
during a completion (in-memory only)." Correct as a *goal*. But §6 sources the data from
"either embedded, Cache-API-cached, or KV per the Resources caching phases" — i.e. it defers the
mechanism to the Resources spec. The Resources spec §6 ships **Phase 1 = Cache API** as the v1
default; KV (Phase 2) is explicitly deferred until "the ETL gains a KV-write step."

That matters because the three options have very different *cold-isolate* behaviour, and completion
is a hot path where the cold path is hit on **every isolate's first keystroke** (Workers isolates
are short-lived and recycled; a typist who pauses and resumes can land on a fresh isolate):

| Backing store | Warm-isolate read (keystrokes 2..N) | Cold-isolate first keystroke | Notes |
|---|---|---|---|
| **Module-global memo** (load once per isolate) | in-memory array deref, **~0 ms** | one-time load (see rows below), then memoized | the missing piece — see below |
| Embedded in bundle | ~0 ms (already a JS const) | ~0 ms (parsed at isolate init) | +~60–80 KB to bundle (Resources §9 size budget); raises isolate cold-start parse a touch, but no fetch |
| **Cache API** (Resources Phase-1 default) | `caches.default.match` ~1–5 ms | **MISS → upstream→ES fetch, ~80–400 ms** ⚠ | this is the trap: first keystroke on a cold isolate blocks on the exact ES round-trip §7 swears off |
| Workers KV | `KV.get` ~5–30 ms (edge-cached read) | same ~5–30 ms (no isolate warmth needed) | per-read latency on *every* uncached read unless memoized; cheap and predictable |

**The gap:** the spec never says *"load the catalogue into a module-global once, then filter the
in-memory copy."* Without that explicit memo, a literal reading of "reuse the same in-memory/cached
lists" (§6) could mean "call the Resources read path per completion" — and the Resources read path,
on a Cache API miss, **fetches upstream→ES**. That would make the first keystroke after every
cold-start a ~80–400 ms blocking ES call. For autocomplete, where the entire UX budget is
"feels instant" (<100 ms ideal, <300 ms tolerable), a 400 ms first-keystroke stall is a visible
regression and it directly violates the §7 promise.

**Why this is Medium not High:** the *steady state* (keystrokes 2..N on a warm isolate) is fine
under any of the three; the regression is confined to the cold-isolate first keystroke, and only if
the implementer wires the completer to the Cache-API read path rather than a module-global. It is a
"design under-specifies → easy to implement wrong" risk, not a guaranteed breakage.

**Recommendation (lowest-latency for a hot path):**
1. **Mandate a module-global memo.** Load the four lists into module scope on first use
   (`let CATALOGUE: {...} | null = null; async function getCatalogue()`), so keystrokes 2..N within
   an isolate are pure array operations (~0 ms). This is the single highest-leverage perf fix and it
   makes the §7 promise *true by construction* for the warm path.
2. **For the cold-isolate first load, prefer (in order): KV (Phase 2) ≥ embedded > Cache-API.**
   - KV gives a flat, predictable ~5–30 ms cold load with **no upstream/ES dependency at all** — the
     cleanest fit for a hot path, and it removes the ES tier from the completion blast radius
     entirely. This is the strongest argument yet for pulling Resources Phase 2 (KV) forward *if*
     completions ship.
   - Embedded is ~0 ms cold but pays ~60–80 KB bundle weight and couples the catalogue to deploys
     (stale between weekly ETLs unless redeployed). Acceptable for the tiny state/chain/category
     lists; heavier for the 756-item list.
   - Cache-API is acceptable **only** behind the module-global memo, so the ES fetch happens at most
     once per isolate, never per keystroke. If Cache-API is the v1 choice, the spec must say "warm
     the memo on `initialize` via `ctx.waitUntil`" so the first *keystroke* never pays the fetch.
3. **Quantify it in the spec.** Add a one-line cold-start budget: "completion warm-path target
   <2 ms server CPU; cold-isolate first load <30 ms (KV) / <400 ms worst-case (Cache-API miss),
   amortized to ~0 by the module-global memo."

> Spec change: rewrite §6 first bullet from "either embedded, Cache-API-cached, or KV" (a
> non-decision) to a mandate: module-global memo + named backing store + cold-start budget.

---

### In-memory match cost — trivial, confirmed (supports L1/L2/L3)

Filtering 756 items per keystroke: case-insensitive substring + prefix-rank + ASCII-fold.

- A linear scan of 756 short strings doing `indexOf` + a fold is **single-digit microseconds to
  low-tens-of-microseconds** of CPU on a Workers isolate. The 16/50/40 lists are noise.
- The sort to apply prefix-boost is O(m log m) on the *match set* m (≤756). Worst case (empty value
  matches everything) is 756·log₂756 ≈ 7200 comparisons — still **well under 1 ms**.
- Conclusion: match cost is **trivial and does not scale to a concern** at this catalogue size. It
  would remain trivial at 10× the catalogue. The spec's "no index needed" (§6) is correct.

**L1 — empty-value path:** an empty/whitespace `value` matches all 756, sorts them, then caps to
100. Functionally fine, but it does the most work for the least-useful result (returning an
arbitrary alphabetical 100 of 756 is not a helpful completion). Cheap optimization: short-circuit
empty/1-char `value` to a precomputed top-N (e.g. by `premise_count` for chains, or just the first
100 alpha) and skip the full sort. Saves the worst-case sort and improves UX. **Low.**

**L2 — re-folding per call:** if each completion lowercases + ASCII-folds all 756 names *per
request*, that's 756 string allocations per keystroke. Negligible in absolute terms, but pure waste
on a per-keystroke path. **Precompute a folded match-key once at catalogue load** (alongside the
memo from M1) and match against the precomputed key. Turns per-keystroke allocation into a one-time
cost. **Low.**

**L3 — prefix-rank sort:** noted for completeness; O(m log m) is fine, no action. A top-100
partial-select exists if the catalogue ever grows orders of magnitude. **Low / no action.**

---

### M2 — Telemetry overhead on a per-keystroke path

§5.3: *"100% sampling is fine (low volume), but completion is the one method a client may call
rapidly while typing."* This is **self-contradictory** — it asserts low volume and per-keystroke
chattiness in the same breath.

**Latency angle — not a concern (confirmed):** `recordMcp` → `writeDataPoint` is **fire-and-forget**
(`analytics.ts:87-110`): synchronous-looking but the binding queues the write; there is no `await`,
and it's wrapped in try/catch that swallows everything. It runs *after* `handleMCP` returns
(`index.ts:863`), so it **cannot add latency to the completion response**. Good.

**Volume/cost angle — the real issue:** the existing telemetry doc and `wrangler.toml` comment both
state "100% sampled — volume is low and every call is high-signal." That assumption was written for
`initialize`/`tools/list`/`tools/call` — coarse-grained, one-per-user-action calls. **Per-keystroke
completion breaks that assumption by 1–2 orders of magnitude:** a single 8-character item search
fires up to 8 `completion/complete` calls, each writing a WAE point. A handful of active typists can
generate more WAE writes than the entire rest of the server. WAE has per-account write limits and
billing; flooding it with per-keystroke points also *dilutes* the high-signal dataset the comment
brags about.

**Recommendation:** Do **not** carry "100% sampling is fine" onto the completion path. Choose one:
- **Sample-on-result-change** — only write when the returned match-set meaningfully changes (e.g.
  log the first keystroke and the final committed value, skip intermediates). Best signal/noise.
- **1-in-N sampling** for `completion/complete` specifically (e.g. 1-in-10), keep 100% for the
  coarse methods.
- **Aggregate per ref** — count completions per `completionRef` in the isolate and flush one point.
  More code; only if volume proves high.

Either way, **rewrite the §5.3 sentence** so it doesn't assert a falsehood ("low volume") about the
one method that is by design high-volume. The `completionRef` design (ref+arg, never the typed
value — `analytics.ts` privacy model) is otherwise correct and should stay.

---

### Response size — trivial, confirmed

≤100 completion strings, each a short Malay name/label (~10–25 chars) → response body on the order of
**1–3 KB** JSON. Below the noise floor of JSON-RPC framing and TLS overhead. No streaming, no
pagination machinery needed (the `hasMore`/`total` fields are metadata, not paging). **No concern.**

### Debounce / client-side caching — implication noted

The spec correctly observes (§2, §9) that debouncing is client-side and uncontrollable. The perf
implication: **the server must assume the worst case — one un-debounced call per keystroke** — and
be cheap enough that even an un-debounced fast typist is harmless. With the M1 module-global memo in
place, each call is a ~microsecond in-memory scan, so even un-debounced the **CPU cost is
negligible**; the only un-debounced-amplified cost is the M2 telemetry writes (hence M2 matters more
once you accept you can't rely on client debounce). This reinforces both M1 (make warm path free)
and M2 (don't 100%-sample a path you've just admitted can fire per-keystroke).

---

## Open question answers (perf lens)

**Q3 — fuzzy quality (prefix/substring vs trigram): perf cost of each.**
- *Prefix + substring (spec's lean):* the in-memory scan + `indexOf` described above —
  **sub-millisecond, no index, no preprocessing beyond the L2 folded-key memo.** Effectively free.
- *Trigram / typo-tolerant:* requires building a trigram index (one-time, on the 756 names, at
  catalogue load — a few ms, fine if memoized) and per-query trigram set construction + scoring
  (O(query_len) to build, O(candidates · trigrams) to score). On 756 items this is still
  **low-single-digit milliseconds per keystroke** — not catastrophic, but ~10–100× the cost of
  substring, and it needs the index built and held in memory (more isolate state, more cold-load
  work). **Verdict: start with prefix+substring (spec is right).** The perf delta only justifies
  trigram if telemetry shows users typing typos that substring misses — and even then the cost is
  affordable, so this is a quality call, not a perf blocker. Defer.

**Q5 — rate-limit posture (perf/latency angle).**
The spec's lean (rely on the shared upstream 120/60s, no separate counter) is **correct on perf
grounds.** Because completers are in-memory (M1) with fire-and-forget telemetry (M2), the marginal
server cost of a completion is CPU-only and microscopic — there is nothing expensive to protect
against, so an in-Worker counter would add per-request state and latency to guard a near-zero-cost
operation. The one real amplified cost is WAE writes (M2), which is better fixed by sampling than by
rate-limiting. *Caveat:* if the catalogue load is wired to Cache-API-miss (the M1 trap) instead of a
module-global memo, then a cold-isolate burst *could* fan out to ES and rate-limiting would suddenly
matter — another reason to close M1. With M1 closed, **rely on the shared limit; no separate
counter.** Add an in-Worker counter only if telemetry later shows a single IP dominating the
120/60s budget.

**Q1 — sequencing: does building inert machinery now have any perf cost? (minor)**
**No measurable runtime perf cost.** The completion capability flag (`completions: {}`) is a static
object literal in `handleInitialize`; the `COMPLETERS` registry is a module-level const array. When
no client calls `completion/complete`, none of it executes on the hot path — `handleMCP`'s switch
simply never hits the new case. The only costs of building it inert are (a) a negligible bundle-size
increase (the registry + handler, a few KB of code, *not* the catalogue data unless embedded — see
M1), and (b) the cold-start parse of that extra code (microseconds). **Perf is not a reason to defer
or rush sequencing** — decide Q1 on product grounds (a capability with nothing to complete is a UX
wart, not a perf one).

---

## Spec change requests

1. **§6 (M1) — replace the open "embedded/Cache-API/KV" non-decision with a mandate:** completion
   reads a **module-global in-memory memo**, loaded once per isolate; name the backing store for the
   cold load (recommend **KV (Resources Phase 2) ≥ embedded > Cache-API**, and if Cache-API is the
   v1 reality, mandate warming the memo on `initialize` via `ctx.waitUntil`). State a cold-start
   budget. This is what makes "no ES per keystroke" (§7) true by construction rather than by hope.
2. **§5.3 (M2) — strike "100% sampling is fine (low volume)"** for the completion path; mandate
   explicit per-keystroke sampling (sample-on-change or 1-in-N). Note that `writeDataPoint` is
   fire-and-forget so it's a volume/cost fix, not a latency one. Keep the `completionRef`
   (ref+arg, never typed value) design.
3. **§6 (L2) — add:** precompute folded/lowercased match keys once at catalogue load, alongside the
   memo, so per-keystroke matching does no per-call string allocation.
4. **§6 (L1) — add:** short-circuit empty/1-char `value` to a precomputed top-N (skip the
   match-everything-then-sort path).
5. **§10 — strengthen the cost-guard test:** the existing "no upstream/ES call fires during a
   completion" test must specifically assert the **cold-isolate first keystroke** also fires no ES
   call (i.e. that the memo is warmed out-of-band, not lazily on the first completion). The current
   wording could pass against a warm isolate while the cold path still round-trips.
6. **§9 — minor:** keep the ≤64-char `value` clamp; note explicitly it doubles as a perf guard
   against pathological-length input (I1), matching the existing tool `maxLength: 64` convention.
