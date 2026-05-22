# MCP3 Prompts — Cost Review

**Date:** 2026-05-22
**Persona:** Cost Reviewer
**Scope:** Cost impact + minimization of adding MCP **Prompts** (`prompts/list` / `prompts/get`) and the absorbed **Completions** (`completion/complete`, in-memory, 10%-sampled) to the manamurah MCP Worker (`docs/2026-05-22-spec-mcp-prompts.md`). Grounded against `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`, and the #1/#2 specs.

---

## Executive summary

**Overall cost-risk rating: MEDIUM** — but with one **HIGH-severity indirect driver** that the spec under-emphasises.

The direct cost of this feature is **negligible**. `prompts/get` is pure string assembly + an embedded const (no `fetch`, by type — spec §3, §10), `prompts/list` is static, and `completion/complete` is in-memory off the embedded catalogue (no ES). On the CF Workers bill these are rounding error: even at 1M prompt invocations/month they add **well under $1** in requests + CPU, all absorbed inside the existing $5 Workers Paid base + its 10M-request / 30M-CPU-ms included allowance ([CF Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

The real cost story is **indirect and is the headline finding**: a prompt is a *workflow amplifier*. `prompts/get` for `semak-dakwaan-harga` returns instructions that tell the LLM to run **5–15 manamurah tool calls** (`search_items`, `price_history`, `price_change`, `compare_prices`, `top_movers`, optionally `fama_margin`/`find_cheapest`). Every one of those is an upstream→ES query on the **capacity-constrained, RAM-hour-billed Elastic Cloud cluster** that the #1/#3 reviews repeatedly flag as the project's main cost risk. So one cheap, free `prompts/get` can fan out to a 5–15× ES-query multiplier vs an ad-hoc single-tool question. If prompts get popular (their entire purpose — they ship as one-click slash commands on Claude.ai/Desktop/ChatGPT), this is a **real ES capacity-creep vector**. It must be bounded by *prompt-text discipline* (instruct the LLM to use the cached catalogue/resources, resolve once, avoid redundant queries, cap the tool budget), not by infrastructure.

The 10%-completion-sampling decision (#2) carries forward correctly and adds no new cost. `prompts/get` telemetry at 100% is fine — it is once-per-invocation, not per-keystroke.

---

## Findings table

| ID | Severity | Title | Cost driver | Recommendation |
|---|---|---|---|---|
| C1 | **High** | Prompts amplify ES fan-out 5–15× vs ad-hoc tool use | Each prompt invocation drives many `tools/call`→ES queries on the capacity-constrained cluster | Bound the fan-out *in the prompt text*: explicit tool-budget cap, "resolve item once", "lean on the cached catalogue/resources, don't re-query reference data", "skip `fama_margin` unless the claim is value-chain". Add a CI assertion on the rendered tool list. (§C1) |
| C2 | Medium | `basket-bulanan` unbounded basket → unbounded ES fan-out | `barang` is a free CSV list; N items → N `price_change` calls + a `basket_watch` | Cap the basket in the prompt text (e.g. "≤ 12 items") and in arg validation; instruct one batched `basket_watch` over per-item loops. (§C2) |
| C3 | Low | Embedded methodology inflates end-user LLM context tokens every invocation | Methodology const inlined in `prompts/get` messages = input tokens billed to the *client's* LLM, every call | Keep methodology terse (≤ ~400 tokens); embed on `semak-dakwaan-harga` (+ compare) only, not basket — confirms spec §16-Q2 lean. (§C3) |
| C4 | Info | `prompts/get` direct Worker cost is trivial | Workers request + CPU for string assembly | Confirmed: < $0.55 per **million** invocations, inside the included allowance. No action. (§C4) |
| C5 | Info | Completion 10% sampling carries forward | WAE data-points-written | Confirmed no new cost; 10% holds (#2 §10). Worst-case viral spike ~$13.50/mo vs ~$135/mo at 100%. (§C5) |
| C6 | Info | `prompts/get` telemetry at 100% is fine | WAE writes, once per invocation | Confirmed — not per-keystroke. ~$0.25 per million invocations. Keep 100%. (§C6) |
| C7 | Low | Q4 — embedding live catalogue into `prompts/get` would move ES cost INTO `prompts/get` | Would couple the free path to upstream/ES | Reject (spec already leans reject). Keep `prompts/get` data-free. (§OQ-Q4) |

---

## Detailed findings ($ estimates + assumptions)

### Pricing basis (current, 2026)
- **Workers Paid:** $5/mo base; includes **10M requests + 30M CPU-ms**/mo; overage **$0.30 / M requests**, **$0.02 / M CPU-ms** ([CF Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). The Worker is already on Paid (resources spec).
- **Workers Analytics Engine:** **$0.25 / M data points written**; Paid plan includes 10M writes/mo; free tier 100k/day ([WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)). One `writeDataPoint()` = one data point; cardinality is free.
- **Egress:** $0 on Cloudflare.
- **Elasticsearch:** **Elastic Cloud is RAM-hour billed** (you pay for provisioned hot-tier RAM-hours, not per query). Capacity is fixed by the provisioned tier; excess query concurrency manifests as latency/queueing/forced tier upsize, *not* a linear per-query line item. The cost risk is therefore **capacity creep** — sustained higher QPS forcing a larger (more $/hr) deployment — which is exactly why fan-out amplification matters. (Model per [Elastic Cloud pricing](https://www.elastic.co/pricing); RAM-hour basis carried from the resources spec.)

---

### C1 — [HIGH] Prompts amplify ES fan-out 5–15× (the headline finding)

`prompts/get` is free, but it is a **force multiplier on the one expensive resource**. Worked example for `semak-dakwaan-harga` (spec §4, §6):

- If `barang` omitted → `search_items` (1 ES query) to resolve the item.
- `price_history` (1), `price_change` (1), `compare_prices` (1), `top_movers` (1) — the §6 instruction names these explicitly.
- Optionally `find_cheapest` (1) and, for value-chain claims, `fama_margin` + `fama_top_movers` (2).
- A realistic single fact-check therefore drives **5–9 ES queries**; a thorough/multi-item one **10–15**.

**Amplification vs ad-hoc use:** a casual user typically fires *one* tool call ("what's the price of X"). A prompt invocation fires **5–15**. So **1 prompt invocation ≈ 5–15 ad-hoc questions** in ES load terms.

**Why this is a real risk, not theoretical:** the entire goal (spec §1) is to make these one-click slash commands portable across Claude.ai, Desktop, and ChatGPT — i.e. to maximise invocation volume. Popularity is success, and success is the cost event. ES is capacity-constrained and RAM-hour billed, so the failure mode is: prompts go viral → sustained QPS climbs 5–15× per prompt user → hot-tier latency degrades → forced tier upsize. The deferred item-card template was flagged at "+$40–80/mo ES tier risk" (resources §10) for an N+1 on *one* tool; a popular fan-out prompt is a **larger and more diffuse** version of the same risk.

**Direct Worker/WAE cost of the fan-out is still trivial** — the tool calls themselves are existing `tools/call` requests already telemetered at 100%; the incremental WAE is ~$0.25/M *tool calls* and the requests sit in the 10M allowance. **The cost lives entirely on ES.**

**Mitigation — bound it in the prompt text (no infra needed):**
1. **Explicit tool budget** in the rendered instruction: *"Use at most ~5 tool calls; resolve the item once with `search_items`, then gather evidence with `price_history` + `price_change` (+ `compare_prices` only if the claim is comparative)."*
2. **Lean on cached reference data:** *"For item codes, states, categories and chains use the catalogue you already have in context (the `manamurah://catalogue/*` resources) — do NOT call a tool to look up reference data."* This converts would-be reference round-trips (which the #1 edge cache / KV already serves cheaply) away from fresh ES queries, and is the single biggest lever.
3. **Conditional expensive tools:** *"Call `fama_margin`/`fama_top_movers` ONLY if the claim is specifically about farm-gate vs retail markup."* (Spec §5 already says this — make it imperative + negative-framed.)
4. **No redundant queries:** *"Do not re-query the same item/period twice; one `price_history` covers the trend."*
5. **CI assertion:** the §13 render test should also assert the rendered text contains the budget/caching directives (a cheap regression guard that the cost-control language survives edits).

This keeps the *median* fan-out near the low end (5) instead of the high end (15) — roughly halving the ES amplification at zero infra cost.

---

### C2 — [MEDIUM] `basket-bulanan` unbounded basket → unbounded fan-out

`basket-bulanan` takes `barang` as a free CSV list (spec §4, §16-Q3). A 30-item basket, if the LLM loops `price_change` per item, is **30+ ES queries** from one invocation — an unbounded version of C1.

**Mitigation:** (a) clamp the basket in arg validation (the §12 length clamp already caps bytes, but add an explicit item-count cap, e.g. ≤ 12); (b) in the prompt text instruct **one batched `basket_watch`** (which already takes a list of `item_code`s as a single POST — see `POST_TOOLS` in `src/index.ts:610`) plus *one* `price_change` pass, not a per-item loop. `basket_watch` is the cost-efficient primitive here; the prompt must steer to it.

---

### C3 — [LOW] Embedded methodology inflates end-user LLM context tokens

The embedded methodology resource (spec §6 block 1) is inlined into the `prompts/get` response. CF egress is $0, and the Worker CPU to emit a const is negligible — but those bytes become **input tokens billed to the client's LLM** on *every* invocation. At, say, 400–600 tokens of methodology, a heavy user running the prompt hundreds of times/day pays a small but real recurring token tax (and consumes context budget that competes with the actual analysis).

**Mitigation:** keep `src/methodology.ts` **terse** (the #1 spec §5 already says "short and stable" — hold the line; target ≤ ~400 tokens). Embed it on `semak-dakwaan-harga` and `banding-bandar-vs-nasional` (caveat-heavy) but **not** `basket-bulanan` (a one-line coverage note suffices) — this is exactly the spec §16-Q2 lean, and it is the cost-correct call. Do not let methodology grow into a full playbook in the embedded const.

---

### C4 — [INFO] `prompts/get` direct Worker cost is trivial (confirmed with numbers)

Per invocation: 1 Workers request + sub-millisecond CPU (string interpolation + emitting an embedded const; no `await`, no `fetch` by type — spec §3/§10).

- **Requests:** 1M `prompts/get` calls = 1M requests. Overage rate $0.30/M, but these land inside the **10M included** allowance → effectively **$0**. Even fully marginal: **$0.30 per million**.
- **CPU:** assume a generous ~5 CPU-ms (it is realistically < 1ms). 1M × 5ms = 5M CPU-ms; overage $0.02/M CPU-ms = **$0.10 per million** (and inside the 30M included allowance → $0).
- **Total marginal: < $0.55 per million invocations**, and $0 until allowances are exhausted.

Conclusion: the embedded-methodology-const approach (spec §3) is correctly cheap. No action.

### C5 — [INFO] Completion 10% sampling carries forward; no new cost

Per #2 §10: completion is the highest-volume method (per keystroke), sampled at **10%**. WAE worst case at 100% during a viral spike was estimated ~$135/mo of pure writes; 10% → **~$13.50/mo**. This decision is preserved in spec §9.3 ("`completion/complete` at 10%"). No change, no new cost introduced by #3. **Confirmed — 10% holds.**

### C6 — [INFO] `prompts/get` telemetry at 100% is fine; confirmed

Spec §9.3 keeps `prompts/get` at 100% sampling. Unlike completion, `prompts/get` fires **once per prompt invocation**, not per keystroke — volume is low and every record is high-signal (which prompt, ok/error, latency). At $0.25/M data points, even 1M invocations/mo = **$0.25** (inside the 10M WAE allowance → $0). **100% sampling is correct; do not down-sample `prompts/get`.** Keep recording only the prompt *name*, never filled argument values (spec §9.3 — correct; the `dakwaan` free text is sensitive + high-cardinality).

---

## Recommended cost-minimizing configuration

1. **Write prompts to minimise ES fan-out (the #1 lever):** every prompt's `render` output must include (a) an explicit tool budget, (b) "use the in-context catalogue/resources for reference data, don't tool-call for it", (c) conditional gating of expensive FAMA tools, (d) "no redundant queries". Treat the prompt text as a cost-control surface, reviewed at PR time (spec §11 keeps BM text in `prompts.ts` — good).
2. **`prompts/get` stays data-free** (spec §3) — never pre-fetch/embed live numbers; that would move ES cost onto the free path (see Q4).
3. **Cap `basket-bulanan`** to ≤ 12 items in validation; steer to one batched `basket_watch`.
4. **Methodology const terse** (≤ ~400 tokens); embed on fact-check + compare only.
5. **Sampling:** `prompts/get` 100%, `completion/complete` 10% (both as specced). No change.
6. **No new bindings** beyond the #2 CF rate-limit binding scoped to `completion/complete` (already specced §7) — that binding also incidentally caps keystroke-driven WAE writes. No infra cost.
7. **Observability (recommended, cheap):** since fan-out is the risk, the WAE `prompt` field (spec §9.3) lets you GROUP BY prompt name and correlate prompt-invocation volume against `tools/call` volume on ES-backed tools — a free way to *watch* the amplification ratio and catch capacity creep before a forced tier upsize. Recommend the team add a one-line WAE SQL check to the existing cost-rollup cron.

---

## Open question answers (spec §16, cost lens)

- **Q4 — should `prompts/get` ever embed the live catalogue / pre-fetch data?** **No (cost-decisive).** Embedding live data moves ES query cost *into* the otherwise-free `prompts/get` path, makes it stale instantly, and duplicates what the LLM does with tools anyway. The spec's lean (reject; rely on completion + tools, keep data-free) is the cost-correct answer. Keep §3 as written.
- **Q2 — methodology embed scope?** **Embed on `semak-dakwaan-harga` + `banding-bandar-vs-nasional`; one-line coverage note for `basket-bulanan`.** Methodology = recurring client-side input-token tax (C3); scope it to the caveat-heavy prompts and keep it ≤ ~400 tokens. Matches the spec lean.
- **Q5 — 3 prompts enough for v1?** **Yes — ship 3 (cost-prudent).** Each new prompt is a new fan-out vector; prove the ES-amplification of 3 is bounded (via the C1 directives + the WAE watch) before adding `cari-termurah`/`trend-tahunan`/FAMA prompts. Fewer prompts = less surface for unbounded ES creep.

---

## Spec change requests

1. **§5 / §6 (mandatory, addresses C1):** make the cost-control directives **normative** in every prompt's rendered text — explicit tool budget, "use in-context catalogue/resources, don't tool-call reference data", conditional FAMA gating (imperative + negative-framed), "no redundant queries". Currently §5/§6 mention efficient tool use only descriptively.
2. **§4 / §12 (addresses C2):** add an explicit **item-count cap** (e.g. ≤ 12) for `basket-bulanan`'s `barang` CSV in arg validation, and instruct one batched `basket_watch` over a per-item `price_change` loop in the rendered text.
3. **§13 (addresses C1):** add a CI assertion that each rendered prompt contains the tool-budget + use-cached-catalogue directives (a regression guard so the cost language survives future edits).
4. **§9.3 (addresses C6, confirm):** keep `prompts/get` at 100% sampling; record prompt **name** only. (Already specced — flag as cost-confirmed, no change.)
5. **New (recommended, addresses C1 observability):** add a line to the existing cost-rollup cron computing the ratio of ES-backed `tools/call` volume to `prompts/get` volume (the live amplification factor) so capacity creep is caught early.

---

### Sources
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Elastic Cloud pricing (RAM-hour basis)](https://www.elastic.co/pricing)
