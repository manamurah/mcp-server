# Cost Review — MCP Completions spec

**Date:** 2026-05-22
**Persona:** Cost Reviewer
**Scope:** Cost impact + minimization of adding `completion/complete` to the
manamurah MCP server (`docs/2026-05-22-spec-mcp-completions.md`). Reads grounding:
`src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`, and the prior
cost finding in `docs/2026-05-22-spec-mcp-resources.md`.
**Constraint:** REVIEW ONLY — findings, no edits.

---

## Executive summary

The spec gets the **single most important cost decision right**: completers run
**in-memory over the cached catalogue, with no ES round-trip per keystroke** (§6, §7,
§10 test). That decision is the headline cost win and it caps the marginal cost of the
*highest-volume MCP method* at "a CPU-cheap in-memory filter + one WAE datapoint" — it
keeps completion entirely off the capacity-constrained, RAM-hour-billed Elastic Cloud
tier the Resources review flagged as the cost risk. Confirmed and endorsed.

There is, however, **one wrong cost claim that must be fixed before merge**: §5.3 and
the §5.3 comment assert "100% sampling is fine (low volume)" for completion telemetry.
**Completion is not low-volume — it is the per-keystroke method and therefore the
single highest-volume JSON-RPC method on the server.** WAE bills *data points written*.
Recording every keystroke at 100% multiplies WAE datapoint volume by roughly 5–15x over
the tool-call baseline. That doesn't break the bank at current manamurah volumes (WAE is
generous and still pre-billing), but it is avoidable waste, it sets a bad precedent, and
the spec's own justification for the policy is factually inverted. **Sample completion
telemetry at 5–10%, not 100%.**

Net: the design is cheap by construction. The only real cost defect is a documentation/
config error (telemetry sampling) plus the spec carrying forward the parent's claim that
WAE sampling can stay at 100%.

**Overall cost-risk rating: Low.** (No ES capacity exposure; no recurring spend that
moves off the $5 Workers Paid base at any realistic volume. The one High-severity finding
is "avoidable recurring WAE waste + an inverted cost claim in the spec," not a spend spike.)

---

## Findings table

| ID | Severity | Title | Cost driver | Recommendation |
|---|---|---|---|---|
| C-1 | High | "100% sampling is fine (low volume)" is inverted — completion is the highest-volume method | WAE data points written | Sample completion telemetry at 5–10%; keep 100% on every other method. Fix the §5.3 claim. |
| C-2 | Info (endorse) | In-memory completers avoid ES per keystroke — the headline win | ES RAM-hour capacity (avoided) | Keep §6/§7 as-is; harden the §10 "no ES call fires" test into a CI gate. |
| C-3 | Low | Workers requests + CPU-ms scale with keystrokes but stay in base tier | Workers requests ($0.30/M) + CPU-ms ($0.02/M) | No action beyond a 64-char value clamp (already in §9) and a 100-result cap (already §5.2). |
| C-4 | Low | KV reads per cold isolate (Phase-2 catalogue source) | KV reads ($0.50/M, 10M free) | Read catalogue once per isolate into module scope; never per-keystroke. Trivial. |
| C-5 | Info | Egress per completion is ≤100 short strings | Worker egress (unmetered) | Confirmed negligible; no action. |
| C-6 | Medium | Building inert completion machinery now (Q1) spends review/maintenance budget on a dormant capability | Eng + future-review cost | Co-ship with #3 Prompts (spec's own lean). Don't advertise `completions: {}` until a completer exists. |
| C-7 | Low | Shared 120/60s IP rate-limit is the only abuse cap (Q5) | Worker requests under burst | Acceptable given in-memory cost; revisit only if WAE shows a single IP dominating. |

---

## Detailed findings

### Pricing baseline (current, 2026)

All figures from Cloudflare docs (cited below). Worker is on **Workers Paid, $5/mo base**
(established by the Resources cost review).

| Resource | Included (Paid) | Overage |
|---|---|---|
| Workers requests | 5 M / mo | $0.30 / million |
| Workers CPU | 30 M CPU-ms / mo | $0.02 / million CPU-ms |
| WAE data points written | 10 M / mo | **$0.25 / million** |
| WAE read queries (SQL API) | 1 M / mo | $1.00 / million |
| KV reads | 10 M / mo | $0.50 / million |

WAE billing note: writes are billed per `writeDataPoint()` call; **adding dimensions/
cardinality is free** — so the *only* WAE cost lever for completion is the **number of
datapoints written**, i.e. the sampling rate. WAE is also still in a pre-billing grace
period, but the spec should be costed against the published forward prices, not the
current $0.

---

### C-1 — [High] "100% sampling is fine (low volume)" is inverted

**Where:** spec §5.3 ("100% sampling is fine (low volume)") and the parent claim in
`src/analytics.ts:5` ("100% sampled — volume is low").

**The error.** Completion fires **per keystroke** (§9 even calls it "uniquely chatty…
one call per keystroke"). The spec contradicts itself: §9 correctly says completion is
the chattiest method, while §5.3 calls it low-volume to justify 100% sampling. Completion
is the **highest-volume** JSON-RPC method on the server, not the lowest.

**Volume model.** A single resolved tool call is typically preceded by 5–15 completion
keystrokes (client debouncing trims this, but debounce is best-effort and client-
dependent). So completion datapoints ≈ **5–15x the tool-call datapoint count.**

**WAE cost at 100% sampling** (each keystroke = 1 datapoint @ $0.25/M, after 10 M free):

| Scenario | Tool calls/mo | Completion keystrokes/mo (×10) | Total WAE datapoints/mo | Billable (over 10 M) | WAE cost/mo |
|---|---|---|---|---|---|
| Low | 50 K | 500 K | ~0.55 M | 0 | $0.00 |
| Mid | 1 M | 10 M | ~11 M | 1 M | **$0.25** |
| High | 10 M | 100 M | ~110 M | 100 M | **$25.00** |
| Stress (viral) | 50 M | 500 M | ~550 M | 540 M | **$135.00** |

**Same scenarios with completion sampled at 10%** (tool/other methods stay 100%):

| Scenario | Total WAE datapoints/mo | Billable | WAE cost/mo | Saved vs 100% |
|---|---|---|---|---|
| Low | ~0.10 M | 0 | $0.00 | $0.00 |
| Mid | ~2 M | 0 | $0.00 | $0.25 |
| High | ~20 M | 10 M | **$2.50** | $22.50 |
| Stress | ~100 M | 90 M | **$22.50** | $112.50 |

**Read-out.** At today's manamurah volumes (Low/Mid) the absolute saving is cents — but
the design defect is real: the spec records the chattiest signal at the most expensive
rate while *also* throwing away the per-value privacy benefit is moot (it already drops
the typed value, good). The reason to sample isn't the few-cents today; it's (a) the
spec literally states a false rationale, (b) at High/Stress the cost is the difference
between $2.50 and $25/mo of pure telemetry, and (c) completion datapoints are *low-signal
per unit* (you don't need every keystroke to know "the `item` completer on prompt X is
used a lot and returns N matches at P50 latency" — a 10% sample answers that with full
fidelity). WAE has no per-call sampling knob; sampling here means **a `Math.random() <
RATE` guard around the completion `recordMcp` call**, with the rate as a module const.

**Recommendation.** Sample `completion/complete` telemetry at **5–10%** (suggest 10% —
enough to keep per-completer match-count/latency histograms statistically sound). Keep
**100% on initialize / tools/call / tools/list / resources/* / prompts/*** — those stay
genuinely low-volume and high-signal. **Fix the §5.3 claim** to read: "completion is the
highest-volume method; sample at 10%, not 100%." Optionally record a coarse `sampled`
flag or scale counts up by 1/RATE at query time so dashboards report true volume.

---

### C-2 — [Info / strongly endorse] In-memory completers avoid ES per keystroke (headline win)

**Where:** §6 ("do not add upstream calls per keystroke — that would be an ES round-trip
on every character"), §7 (rejects `search_items`-backed completion), §10 test ("No
upstream/ES call fires during a completion").

This is the correct and decisive cost call. Quantifying the **rejected** `search_items`-
per-keystroke design (§7) to show what was avoided:

- `search_items` is an ES query (the Resources review established ES is the cost risk,
  billed on **RAM-hours**, capacity-constrained, not per-request).
- At the same volume model (5–15 ES queries per tool call from completion alone),
  completion would have become the **dominant ES query source** — outweighing all actual
  tool resolution. At the High scenario that's **~100 M extra ES queries/mo** layered onto
  a fixed-capacity cluster.
- ES on Elastic Cloud doesn't bill per query; the damage is **capacity creep** — the
  cluster must be sized for peak QPS, so completion-per-keystroke would force a **tier
  bump**. The Resources review priced the analogous unbatched item-template N+1 at
  **~+$40–80/mo ES tier risk if hammered** (`resources spec §10`). Completion-per-keystroke
  is *strictly worse* (every character, not every item read), so the avoided cost is **at
  least that band and plausibly multiples of it under a typing burst**, plus latency the
  user feels on every key.

The in-memory approach (756 items + ~50 chains + ~40 categories + 16 states — all tiny)
reduces this to **CPU-only, sub-millisecond, zero ES**. Confirmed: the spec avoids the
single largest cost exposure the feature could have introduced.

**Ask:** promote the §10 "no ES/upstream call fires during completion" test from a listed
test to an **enforced CI gate** (assert `fetch` is not called on the completion path).
This is the guard that protects the entire cost finding from a future regression where
someone "improves" fuzzy quality by reaching for `search_items` (the §7 escape hatch).

---

### C-3 — [Low] Workers requests + CPU-ms

**Requests.** Each keystroke is one POST to `/mcp` = one Worker request. Using the same
volume model:

| Scenario | Total Worker requests/mo (tool + completion + handshake) | Billable (over 5 M) | Request cost/mo |
|---|---|---|---|
| Low | ~0.6 M | 0 | $0.00 |
| Mid | ~11 M | 6 M | $1.80 |
| High | ~110 M | 105 M | **$31.50** |

Note: at High, the request line ($31.50) dwarfs the WAE line — but this is **inherent to
exposing a per-keystroke method at all**, not specific to the telemetry choice, and it
only materialises at 10 M tool-calls/mo (far beyond current manamurah traffic). It's also
the same cost whether or not telemetry is sampled. No mitigation available short of not
shipping completion; flagged for awareness, not action.

**CPU.** In-memory matching over ≤756 short strings with a substring/prefix scan is
**~0.1–0.5 CPU-ms per completion** (string lowercase + includes/startsWith over <1 K
items; no allocation-heavy work if the cap-100 truncation happens during the scan). At
the High scenario (100 M completions) that's ~10–50 M CPU-ms — i.e. it can nudge past the
30 M free CPU-ms allotment, costing **$0.20–$1.00/mo** at the very top end. Negligible and
well within base tier at any realistic volume. The §9 value clamp (≤64 chars) and §5.2
cap (100) bound worst-case CPU per call — keep both. **In-memory matching is CPU-cheap
enough to stay in the base tier.**

---

### C-4 — [Low] KV reads if completers read KV per cold isolate (Phase-2 source)

Per Resources spec §6 Phase 2, the catalogue may live in Workers KV. If completers read
KV they MUST read **once per isolate into module-scope memory** (cold-start only), never
per keystroke. Cost of the correct pattern: KV reads ≈ number of cold isolate spins
(low-thousands/mo), against **10 M free reads** — **$0.00**, rounding error even at
$0.50/M. The anti-pattern (KV read per keystroke) would be 100 M reads at High = 90 M
billable = **$45/mo** *and* re-introduce a per-keystroke I/O round-trip (a softer rerun of
the C-2 mistake). The spec already says "in-memory/cached lists" (§6) — make the
"hydrate-once-per-isolate, never-per-keystroke" rule **explicit** so a Phase-2 implementer
doesn't wire KV into the hot path. Trivial cost, but cheap insurance to state it.

---

### C-5 — [Info] Egress

A completion response is `{ values: string[] ≤100, total?, hasMore }` — at most 100 short
catalogue names (item names ~20–40 bytes each) ≈ **2–4 KB/response**, typically far less
mid-type. Cloudflare does not meter Worker egress bandwidth. **Negligible — confirmed, no
action.** (The 100-cap in §5.2 also bounds it.)

---

### C-6 — [Medium] Cost of building inert machinery now (Q1)

If the capability + handler + registry ship **before** any completable surface (Prompts
#3 / Resources-v2 template), the server advertises `completions: {}` with **zero
completers that return anything** — every `completion/complete` returns `{ values: [] }`.
Cost of that:

- **Eng/review budget** spent now on a code path with no user value (this very review
  cycle is part of that cost).
- **Recurring drift/maintenance** — a fourth hand-maintained surface (the Resources review
  already flagged 3-way drift in C-13/§13 of that spec) that must stay in sync but does
  nothing.
- **WAE noise** — clients that probe `completion/complete` against the advertised
  capability generate datapoints for empty results (compounds C-1 if 100%-sampled).

This is avoidable waste, not a spend spike — hence Medium. The spec's own lean (Q1, §3,
§11: "co-ship with #3") is the cost-correct answer. **Recommendation: do not advertise
`completions: {}` or write the dispatch case until at least one real completer (a Prompt
argument) exists in the same release.** If scaffolding must land early for sequencing
reasons, keep the capability **unadvertised** until a completer is wired — an unadvertised
handler costs nothing because no compliant client will call it.

---

### C-7 — [Low] Rate-limit posture cost angle (Q5)

The spec relies on the shared upstream **120 req/60s/IP** limit and adds no completion-
specific counter. Cost angle: because completers are in-memory (C-2/C-3), a fast typist
burning the IP budget on completion costs only **Worker requests + CPU** — the C-3 numbers
— never ES. So the cost case for a *separate, tighter* completion limiter is weak: it would
spend code/maintenance to save fractions of a cent. **Endorse the spec's lean (rely on the
shared 120/60s).** The only cost trigger to add one later is if WAE telemetry (sampled, per
C-1) shows a **single IP/client dominating completion request volume** in a way that pushes
the *Workers request* line (C-3) into overage — a dashboard alert, not a pre-emptive build.

---

## Recommended cost-minimizing configuration

1. **Completion telemetry: sample at 10%** (`Math.random() < 0.10` guard around the
   completion-path `recordMcp` call). Keep 100% on every other method. This is the single
   actionable cost change. Fix the §5.3 "low volume → 100% is fine" claim, which is
   inverted. (C-1)
2. **No ES / no upstream fetch on the completion path — ever.** Keep §6/§7; turn the §10
   "no fetch fires" test into an enforced CI gate. This protects the headline win. (C-2)
3. **Hydrate catalogue into module-scope memory once per isolate** (embedded, or one KV
   read on cold start under Phase 2). Never read KV/upstream per keystroke. (C-4)
4. **Keep the §9 ≤64-char value clamp and §5.2 ≤100-result cap** — they bound worst-case
   CPU and egress per call. (C-3, C-5)
5. **Co-ship with #3 Prompts; don't advertise `completions: {}` until a real completer
   exists.** No inert capability in production. (C-6)
6. **Rely on the shared 120/60s IP limit**; add a completion-specific counter only if
   sampled telemetry shows a single IP pushing the Workers request line into overage. (C-7)

**Bottom line cost at current (Low/Mid) volume:** stays on the **$5/mo Workers Paid base**;
WAE/KV/egress all round to $0. The configuration above keeps it there and prevents the
High-scenario WAE line from being 10x larger than it needs to be.

---

## Open question answers (cost lens)

- **Q1 (sequencing):** Co-ship with #3 Prompts. Building inert machinery now spends
  eng/review/drift budget on a dormant, value-free capability (C-6). If scaffolding lands
  early, leave `completions: {}` **unadvertised** so no client calls it — zero runtime cost.

- **Q3 (fuzzy quality — does trigram/typo-tolerance add cost?):** Marginally, and it stays
  in-memory either way. A trigram index over 756 short strings is a few hundred KB of
  module memory built once per isolate (cold-start CPU, not per-keystroke) and makes each
  match *cheaper* (set-lookup vs full scan), not dearer. The real cost trap isn't trigram —
  it's the §7 temptation to fix fuzzy quality by calling `search_items` (ES per keystroke),
  which C-2 forbids. **Verdict: start with prefix+substring (free); if revisited, a local
  trigram is cost-neutral; never reach for ES.**

- **Q5 (rate-limit posture):** Rely on the shared 120/60s IP limit. Because completion is
  in-memory, abuse costs only Workers request+CPU (C-3/C-7), never ES — so a bespoke
  limiter isn't worth its build cost. Add one only if sampled telemetry shows a single IP
  pushing the request line into overage.

---

## Spec change requests

1. **§5.3 — fix the inverted cost claim and set a sampling rate.** Replace "100% sampling
   is fine (low volume)" with: "Completion is the **highest-volume** JSON-RPC method (per
   keystroke). Sample completion telemetry at **10%** (`Math.random()` guard); all other
   methods stay 100%. WAE bills per datapoint written, so the sampling rate is the only WAE
   cost lever here." (C-1)
2. **§10 — promote the no-ES test to a CI gate.** Reword "No upstream/ES call fires during
   a completion (in-memory only) — guards the cost finding" as a **required CI assertion**
   that `fetch` is not invoked on the completion path. (C-2)
3. **§6 — state the hydration rule explicitly.** Add: "Completers read the catalogue from
   **module-scope memory, hydrated once per isolate** (embedded, or a single KV read on
   cold start under Phase 2). Never read KV/upstream per keystroke." (C-4)
4. **§3 / §11 — gate the advertised capability on a live completer.** Add: "Do not advertise
   `completions: {}` in `initialize`/manifest until at least one real completer ships in the
   same release; inert scaffolding, if it lands early, stays unadvertised." (C-6)

---

## Sources

- [Cloudflare Workers — Pricing](https://developers.cloudflare.com/workers/platform/pricing/) — $5/mo base; 5 M requests + 30 M CPU-ms included; $0.30/M requests, $0.02/M CPU-ms.
- [Workers Analytics Engine — Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) — 10 M data points written included; $0.25/M overage; 1 M read queries included; $1.00/M overage; cardinality/dimensions free; currently pre-billing.
- [Workers KV — Pricing](https://developers.cloudflare.com/kv/platform/pricing/) — 10 M reads/mo included; $0.50/M read overage.
- Internal: `docs/2026-05-22-spec-mcp-resources.md` (cost review: $5 Workers Paid base; ES = RAM-hour-billed capacity risk; item-template N+1 ≈ +$40–80/mo ES tier risk; WAE 100% on low-volume resource methods).
- Code: `src/analytics.ts` (one `writeDataPoint` per JSON-RPC request, unconditional, no sampling guard), `src/index.ts:730–874` (dispatch + boundary `recordMcp`), `wrangler.toml` (WAE binding `manamurah_mcp`, Workers Paid).
