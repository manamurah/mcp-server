# MCP3 Prompts — Performance Engineer Review

**Date:** 2026-05-22
**Persona:** Performance Engineer
**Scope:** `docs/2026-05-22-spec-mcp-prompts.md` (primary), with context from
`spec-mcp-completions.md` (#2, absorbed) and `spec-mcp-resources.md` (#1, dependency).
Grounding: `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`.
**Review only** — no code changed.

---

## Executive summary

The performance posture of this spec is **strong**. The central design choice — `prompts/get`
is **data-free** (pure string assembly + an embedded const, no upstream/ES) — is correct, and
the spec earns it structurally by typing `render` as a **synchronous** `=> PromptMessage[]`
(§10:172). That single type decision makes "no fetch in `prompts/get`" a *compile-time* property,
not a discipline you hope holds. There is no hidden async on the `prompts/get` path: the only
content sources are interpolated string args and a bundled markdown const, both in-isolate.

`prompts/list` is trivial (3 static defs, no cursor, no I/O) — confirmed cheap.

Completion (absorbed from #2) is the only per-keystroke hot path, and #2 already nailed it:
in-memory match over an embedded catalogue, 10% telemetry sampling, native CF rate-limit binding.
Nothing in #3 regresses it. The one genuinely #3-specific completion question — **CSV per-token
completion in `basket-bulanan`** (Open Q3) — is a non-issue *for the server* (last-token slice +
the same in-memory match) but has a real client-compatibility caveat the spec already flags.

The one item worth a decision (not a blocker) is **Open Q2** — embedding the full methodology
const in all 3 prompts vs only the fact-check. The numbers below show it is a **small** payload
concern at realistic methodology size (a few KB), but it is pure dead weight on the two prompts
that don't need the caveat apparatus, and it scales linearly with call volume in *both* response
bytes and *LLM context tokens*. The spec's own lean (§16 Q2: embed on fact-check + compare, basket
gets a one-line note) is the right call; I'd tighten it further (fact-check only).

Bundle size is **not** a concern: prompts.ts + methodology (~few KB) + embedded catalogue
(~75–90 KB per #1 §9) sum to well under 200 KB against CF's 3 MB (free) / 10 MB (paid) compressed
Worker limit. Comfortable headroom; flag only as a future watch-item if more prompts/consts land.

**Overall performance rating: LOW RISK (well-designed).** No Critical/High perf findings. One
Medium (methodology embed scope), the rest Low/Info.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| PERF-1 | Info | `prompts/get` is genuinely data-free — confirmed, no hidden async | spec §3:37-48, §10:172; `index.ts:616-655` | Confirm. Keep the sync `render` type as the enforcement mechanism. |
| PERF-2 | Medium | Methodology embedded in all 3 prompts is linear dead-weight on basket/compare | spec §6:85-88, §16 Q2:231-233 | Embed on fact-check only (or fact-check + compare); basket gets a one-line coverage note. ~2–4 KB / ~600–1000 tokens saved per non-fact-check `prompts/get`. |
| PERF-3 | Low | Methodology const size is unstated — no CI size gate like #1 has | spec §5:78, §8 (resources §9 has one) | Pin a target (≤4 KB) + add a serialized-size CI gate mirroring resources §9's `<100 KB` items gate. |
| PERF-4 | Info | `render` typed sync (no Promise) correctly enforces no-fetch + min latency | spec §10:164,172, §13:204 | Confirm. Add the static-analysis "no `fetch` in render" CI check the spec already proposes (§13:204). |
| PERF-5 | Low | Cumulative bundle (prompts + methodology + embedded catalogue) — within limits, future watch | spec §8:124, §11; #2 §7:124; `wrangler.toml` | No action now (~<200 KB vs 3 MB free limit). Add a `wrangler deploy` bundle-size check to CI as consts accrete. |
| PERF-6 | Info | CSV per-token completion (`basket-bulanan`) is cheap server-side; client-compat is the only risk | spec §4 (basket row), §16 Q3:234-237 | Server: slice last CSV token, run existing in-memory item completer — O(catalogue), same as single-value. Keep the spec's "confirm client handles mid-string completion" flag. |
| PERF-7 | Info | Completion path (from #2) not regressed by #3 | #2 §7,§9,§10; spec §7:104-118 | Confirm — embedded-catalogue read, 10% sampling, CF rate-limit binding all carried over intact. |
| PERF-8 | Low | `prompts/get` 100% telemetry sampling is fine *only if* it stays low-volume | spec §9.3:153-154; `analytics.ts` | Correct for now (per-invocation, not per-keystroke). Add a one-line note: if a client pre-fetches all prompts on every `initialize`, revisit. Completion stays 10% (correct). |
| PERF-9 | Info | `prompts/list` is trivial (3 static, no cursor, no I/O) | spec §9.2:140-141, §2:30 | Confirm. |

---

## Detailed findings

### PERF-1 (Info) — `prompts/get` cost path is genuinely data-free

Verified against the source. The current Worker's only latency-bearing operation is
`callUpstream` (`index.ts:616-655`), which does `await fetch(...)` to `manamurah.com/api/v2/mcp/*`
→ ES. `prompts/get` per the spec **does not touch `callUpstream`** at all (§3:42 "No upstream/ES
call in `prompts/get`"; §3:47 "Keep `prompts/get` data-free"). Its content sources are exactly two,
both in-isolate:

1. **String interpolation** of `args` into the template (`{dakwaan}`, `{barang}`, `{negeri}`) —
   `String.replace`-class work, microseconds.
2. **An embedded markdown const** attached as an `{type:"resource"}` block (§6:87) — a module-level
   string literal already resident in the isolate's heap after first load. No fetch, no parse.

**No hidden async.** The `render` signature is `(args) => PromptMessage[]` (§10:164) — synchronous,
no `Promise`, so the type system forbids an `await` inside. The validation/clamp steps (§9.2,
§12:188 — required-arg check, length clamp) are also pure string ops. The cost of a `prompts/get`
is therefore: param-guard + arg-validate + a handful of `replace`s + array construction. This is
**edge-CPU-only, sub-millisecond, zero-network** — strictly cheaper than any `tools/call` (which
pays a cross-origin fetch + ES query). The spec's claim is **confirmed**.

The only payload-side cost is the bytes/tokens of the rendered message (see PERF-2), which is a
*response-size* concern, not a *latency* or *upstream-load* concern.

### PERF-2 (Medium) — Methodology embed scope (Open Q2), with size numbers

**The mechanism:** every `prompts/get` for a methodology-embedding prompt inlines the *entire*
methodology markdown const into the response `messages[]` (§6:87). That const then travels twice:

- **On the wire** — added to the JSON-RPC response body the Worker emits.
- **Into LLM context** — the Host loads the embedded resource as model context (that is the *point*
  of an embedded resource), so it consumes input tokens **on every invocation of that prompt**.

**Size estimate of the methodology const.** The spec (Resources §5:166-171) mandates it be "short
and stable," mirroring `src/changelog.ts`. Measured anchors:

- `changelog.ts` on disk = **9,954 bytes** (but that includes the TS wrapper + the full multi-release
  changelog; the methodology is described as a *short* distilled doc).
- The source playbook `manamurah-price-analysis/SKILL.md` = **55,904 bytes** — but §5:64-68
  explicitly distills only the **data-analysis core** (verdict taxonomy, coverage thresholds,
  Ringkas lede rule, cadence/weighting/outlier note), NOT the publish pipeline.

A faithful distillation of just those five bullets (§5) lands realistically at **~2–4 KB of
markdown** (≈ a 40–80 line doc). At the LLM-token rule of thumb (~4 chars/token, English/markdown),
that is **~500–1,000 tokens per embed**.

**Per-call payload for each prompt:**

| Prompt | Embeds methodology? (spec lean §16 Q2) | Per-call added bytes | Per-call added tokens |
|---|---|---|---|
| `semak-dakwaan-harga` (fact-check) | yes — needed | ~2–4 KB | ~500–1,000 |
| `banding-bandar-vs-nasional` (compare) | spec leans yes | ~2–4 KB | ~500–1,000 |
| `basket-bulanan` (basket) | spec leans no (1-line note) | ~0.1 KB | ~30 |

**Is embedding in all 3 a meaningful concern?** At ~2–4 KB it is **not large in absolute terms**,
so this is **Medium, not High**. But it is *pure dead weight* for the prompts that don't need the
caveat apparatus, and it is **linear in call volume on both axes** (bytes + tokens). The
token axis is the one that actually costs the user money downstream — every basket/compare run that
ships the full coverage-threshold methodology pays for context the model doesn't need to total a
basket.

**Recommendation:** embed methodology **only on `semak-dakwaan-harga`** (the verdict/coverage
discipline is its whole reason to exist). `banding-bandar-vs-nasional` needs *one* caveat — the
n≥100-national / ≥10-per-state coverage rule (§4 compare row) — which is **one sentence inline**,
not the whole methodology block. `basket-bulanan` needs only a one-line low-coverage note. This
matches the spec's §16 Q2 lean and tightens it: the spec leans "fact-check + compare"; I'd argue
**fact-check only**, with compare carrying its single inline coverage sentence. Net saving: ~2–4 KB
/ ~500–1,000 tokens on *every* compare and basket invocation.

### PERF-3 (Low) — No size discipline on the methodology const

The Resources spec put a hard **CI size gate** on its one sizable payload (resources §9:225
`catalogue/items < 100 KB`). The methodology const has no equivalent ceiling in this spec — only
the soft "keep it short and stable" prose (resources §5:171). Because the const is embedded into
*every* fact-check `prompts/get` (and travels into LLM context), an unbounded methodology doc is a
silent per-call token tax. **Recommendation:** pin a target (≤ 4 KB serialized) and add a trivial
CI assertion on `METHODOLOGY_MARKDOWN.length`, mirroring resources §9.

### PERF-4 (Info) — `render` purity via sync type is the right latency call

Confirmed. `render: (args) => PromptMessage[]` (§10:164) being **non-Promise** is the correct
performance decision for two reasons:

1. **Enforces no-fetch.** You cannot `await fetch(...)` in a function the compiler types as
   returning a plain array without a `// @ts-expect-error`-grade hack. This makes the data-free
   property structural (same philosophy #2 §7 used for embedding the catalogue: "makes the 'no ES
   call' property structurally true").
2. **Minimises latency.** No microtask/event-loop hop, no promise allocation — `prompts/get`
   resolves entirely on the synchronous CPU path before the handler awaits anything. (The outer
   `handleMCP` is `async`, but `render` itself adds zero await points.)

The spec also already proposes a static-analysis test that `render` performs no `fetch` (§13:204) —
keep it; it's belt-and-braces over the type.

### PERF-5 (Low) — Cumulative bundle size: within limits, future watch-item

Bundle contents that ship to the Worker isolate after #3:

| Const | Source | Est. size |
|---|---|---|
| Existing tool defs + code | `index.ts` | ~35 KB (source; minified less) |
| `changelog.ts` | existing | ~10 KB |
| `methodology.ts` (from #1) | new | ~2–4 KB |
| embedded catalogue (from #2 §7 / #1) | new | **~75–90 KB** |
| `prompts.ts` (3 defs + render + completers) | new | ~5–10 KB |

Sum of the *embedded data* consts ≈ **~95–115 KB**, plus minified code. CF's Worker size limit is
**3 MB (free)** / **10 MB (paid)** *compressed*. Even uncompressed-source-as-proxy, this is **<5%
of the free ceiling**. Bundle size is **not a concern** for #3. Flag only as a watch-item: the
embedded catalogue is the dominant term and it *grows* with the item universe; combined with future
prompts/consts, add a `wrangler deploy`-time bundle-size check to CI so the trend is visible before
it ever matters. (`wrangler` already reports gzip size on deploy.)

### PERF-6 (Info) — Basket CSV per-token completion (Open Q3): cheap server-side

The `basket-bulanan` `barang` arg is a CSV string completed per-token (§4 basket row; §16 Q3).
**Performance of mid-string completion, server-side:**

1. The completer receives the partial `argument.value` (e.g. `"ayam, telur, temb"`).
2. It splits on the last comma, takes the trailing token (`"temb"`), trims whitespace.
3. Runs the **same in-memory item completer** (#2 §4) over the embedded catalogue — O(catalogue
   size), identical cost to a single-value completion. No extra fetch, no extra ES, no quadratic
   blow-up: the already-typed earlier tokens are *ignored* by the matcher (or, if echoed back as a
   prefix per UX, a single string concat).

So **mid-string matching is NOT costly** — it's one extra `split`/`slice` over a single completion.
The real risk Q3 names is **client-side**: whether the MCP client inserts the returned value
verbatim (replacing the whole field) vs appends to the last token. That's a UX/protocol-compat
question (the spec correctly flags it for review), **not a perf one**. Server cost is flat.

### PERF-7 (Info) — Completion path from #2 not regressed

Cross-checked #2's perf-relevant decisions against #3's §7:104-118 — all carried intact:
- **Embedded catalogue, zero-network keystrokes** (#2 §7; #3 §7:117 "read the embedded catalogue
  (zero-network keystrokes)").
- **10% telemetry sampling** on `completion/complete` (#2 §10; #3 §7:118, §9.3:154).
- **Native CF rate-limit binding** scoped to completion (#2 §9; #3 §7:118).
- **Co-located completers** (no separate registry) — a *maintainability* win, perf-neutral.

Nothing in #3 adds an upstream call, a larger per-keystroke scan, or removes the sampling/rate
limit. **No regression.**

### PERF-8 (Low) — `prompts/get` 100% telemetry sampling

§9.3:153-154 keeps `prompts/get` at 100% sampling ("low volume") while completion drops to 10%.
This is **correct** as specified: `prompts/get` fires **once per prompt invocation** (a user picks
a slash command), not per keystroke, so it's genuinely low-volume — the #2 review's "100% is
inverted" critique applied specifically to the *per-keystroke* completion path, which #3 keeps at
10%. **One caveat to note in the spec:** some clients pre-fetch *all* prompt definitions, and a
poorly-behaved client could call `prompts/get` speculatively on every `initialize`. If telemetry
ever shows `prompts/get` volume approaching `tools/call`, revisit the 100% rate. Low priority —
just document the assumption.

### PERF-9 (Info) — `prompts/list` is trivial

Confirmed. 3 static `PROMPTS` defs, no pagination cursor needed (§2:30, §9.2:140-141), no I/O —
it's the prompts analogue of the existing `tools/list` (`index.ts:673-675`), which simply returns
a const array. Negligible cost.

---

## Open question answers (through the perf lens)

**Q2 — Embed methodology in all 3 prompts vs fact-check only?**
**Embed on fact-check only.** At a realistic methodology size of **~2–4 KB / ~500–1,000 tokens**,
embedding in all 3 is not *large*, but it is **linear dead weight** in both response bytes and LLM
input tokens on every basket/compare run that doesn't need the full coverage apparatus. Compare
needs *one inline sentence* (the n≥100/≥10 coverage rule), not the whole block; basket needs a
one-line low-coverage note. Tightens the spec's own §16 lean (which says fact-check + compare).
See PERF-2 for the per-call table. Add a ≤4 KB CI size gate on the const (PERF-3).

**Q3 — `basket-bulanan` CSV per-token completion perf?**
**Cheap server-side; no perf problem.** Mid-string completion = split on last comma + run the same
O(catalogue) in-memory item completer on the trailing token. No extra fetch, no quadratic cost —
flat vs single-value completion. The genuine risk is **client-side** (does the client insert
verbatim or append to the last token), which is a compat question, not a perf one. Keep the spec's
"confirm client handles mid-string completion" flag.

**Q4 — Should `prompts/get` ever embed the live catalogue?**
**No — keep it data-free.** Embedding a live item list would (a) re-introduce the exact
upstream/ES coupling §3 rejected — turning a sub-ms in-isolate op into a fetch-bound one with the
ES-cost risk the prior reviews keep flagging, (b) bloat every `prompts/get` response by the
catalogue's ~75–90 KB / ~20–24 K tokens (per resources §9) — orders of magnitude more than the
methodology, (c) go stale instantly (§3:47). The item universe is already reachable two cheaper
ways: **completion** (in-memory, per-keystroke) and **the catalogue Resource** (#1, edge-cached,
loaded once as ambient context). `prompts/get` embedding it would duplicate both *and* pay the
worst latency. The spec's lean (rely on completion + tools) is the correct perf call.

---

## Spec change requests

1. **§16 Q2 → resolve to "methodology embedded on `semak-dakwaan-harga` only."** Compare carries a
   single inline coverage sentence; basket a one-line note. Update §4/§6 to reflect this so the
   two non-fact-check renders don't ship the full const. *(PERF-2, Medium.)*
2. **§5 / §8 → add a methodology const size target + CI gate** (≤ 4 KB serialized), mirroring
   resources §9's `catalogue/items < 100 KB`. *(PERF-3, Low.)*
3. **§13 → keep the static "no `fetch` in `render`" check** already proposed, and explicitly note
   the **sync `render` type** as the primary enforcement (the test is secondary). *(PERF-4, Info —
   confirmation, no change of substance.)*
4. **§14 (build) / CI → add a Worker bundle-size check** on `wrangler deploy` output as embedded
   consts (catalogue + methodology + prompts) accrete. No limit concern today; this is a trend
   tripwire. *(PERF-5, Low.)*
5. **§9.3 → add a one-line note** that `prompts/get` 100% sampling assumes per-invocation (not
   speculative pre-fetch) volume; revisit if telemetry shows otherwise. *(PERF-8, Low.)*
