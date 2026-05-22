# Spec: MCP Prompts (+ absorbed Completions) for manamurah MCP server

**Status:** Draft spec — not yet implemented. Implements Tier-1 item #3 of
[`2026-05-22-mcp-enhancement-proposals.md`](./2026-05-22-mcp-enhancement-proposals.md), and
**absorbs Tier-1 #2 (Completions)** per the MCP2 review (completion is a facet of a prompt
argument — see [`spec-mcp-completions.md`](./2026-05-22-spec-mcp-completions.md), now a design
reference).
**Created:** 2026-05-22
**Depends on:** #1 Resources (the embedded catalogue + methodology consts) — see
[`spec-mcp-resources.md`](./2026-05-22-spec-mcp-resources.md).
**Target server:** `manamurah-mcp-server` (this repo) — TS Cloudflare Worker, `src/index.ts`.
**Version impact:** minor bump → **2.9.0** (2.7.0 shipped = chain_mom_movers; 2.8.0 reserved for
Resources v1; this release = Prompts + Completions).
**Protocol version:** `2024-11-05` unchanged — prompts, embedded resources, and (context-free)
completion all exist there.

## 1. Goal

Ship reusable, client-agnostic **prompt templates** that encode manamurah's price-analysis
discipline so any MCP client (Claude.ai, Desktop, ChatGPT) can run a rigorous, caveat-aware
price analysis as a one-click slash command — turning the in-house `manamurah-price-analysis`
playbook into a portable asset. Whitepaper: Prompts are "reusable prompt templates related to
[the server's] Tools and Resources" — these stitch the existing 15 tools + the #1 catalogue/
methodology resources into guided tasks, and their arguments are the surface that #2's completers
attach to.

## 2. MCP Prompts grounding (verified against the live spec)

- Capability: `"prompts": { "listChanged": bool }`.
- `prompts/list` → `{ prompts: [{ name, title?, description?, arguments?: [{name, description, required}] }], nextCursor? }`. Paginated (we have 3 → no cursor).
- `prompts/get` `{ name, arguments }` → `{ description?, messages: [{ role: "user"|"assistant", content }] }`.
- Content types: `text`, `image`, `audio`, **embedded `resource`** (`{type:"resource", resource:{uri, mimeType, text|blob}}`) — lets a prompt inline server content (we use it for methodology).
- Prompt **arguments are auto-completed via `completion/complete`** (`ref/prompt`) — this is the #2 hook.
- Errors: unknown prompt / missing required arg → `-32602`; internal → `-32603`.
- Security: "carefully validate all prompt inputs and outputs to prevent injection."

## 3. Design approach — static templates, LLM orchestrates the tools

`prompts/get` returns **instructions** (a templated message) telling the LLM how to run the
analysis using the manamurah tools/resources — it does **not** fetch data itself. Arguments are
substituted into the template; the methodology resource is embedded inline. **No upstream/ES call
in `prompts/get`** — it's pure string assembly + the embedded const, so it's cheap, stateless,
and edge-fast.

**Rejected: server-side data pre-fetch** (having `prompts/get` call tools/ES and embed live
numbers). It couples `prompts/get` to upstream (latency, the ES-cost risk the reviews keep
flagging), duplicates what the LLM will do with the tools anyway, and goes stale instantly. Keep
`prompts/get` data-free; the LLM pulls fresh data via tools when it runs the prompt.

## 4. The prompt set (v1 — 3 prompts)

Each is a *task*, not an API-call wrapper (whitepaper). `(c)` marks a **completable** argument
(completer from §7).

| name | title | arguments | what the rendered prompt makes the LLM do |
|---|---|---|---|
| `semak-dakwaan-harga` | "Semak dakwaan harga (fact-check a price claim)" | `dakwaan` (req, free text), `barang` (opt, c), `negeri` (opt, c) | Resolve the item, pull evidence via the price tools, apply the coverage thresholds, return a verdict (sahih/tidak tepat/separa tepat/data tidak cukup) with a 40–60-word **Ringkas** lede + structured body, citing methodology. |
| `basket-bulanan` | "Kos basket bulanan (monthly basket cost)" | `barang` (req, list/csv, c per token), `negeri` (opt, c) | Use `basket_watch` (+ `price_change`) to total a basket's current vs prior-month cost, flag the biggest movers, note any low-coverage items. |
| `banding-bandar-vs-nasional` | "Banding negeri vs nasional (state vs national)" | `barang` (req, c), `negeri` (req, c) | Use `compare_prices`/`region_gap` to compare the item's price in the chosen state vs the national average, with the coverage caveat (n≥100 nat + ≥10/state) and a plain-BM verdict on whether the gap is real. |

Naming is Malay (the audience + slash-command discoverability). Output is **neutral journalistic
Bahasa Melayu** (matching the house style). A `bahasa` arg for EN output is an open question (§16).

## 5. Encoded discipline (distilled from `manamurah-price-analysis`)

The prompt templates encode the **data-analysis core only** — NOT the jin-specific publish
pipeline (deception-screen logging, warroom cross-link, email, git, IndexNow, BM-humanizer skill
calls are out of scope for a portable MCP prompt). What carries over:

- **Verdict taxonomy:** `sahih` (affirms) / `tidak tepat` (rebuts) / `separa tepat` (partial) /
  `data tidak cukup` (data-insufficient).
- **Coverage thresholds (the anti-false-signal rule):** headline figure needs **n ≥ 30**
  reporting premises; cross-state comparison needs **n ≥ 100 national AND ≥ 10 per state**;
  mention-with-caveat n ≥ 5 (always print `(n=N)`); below 5 on the claim's own item → verdict
  `data tidak cukup`. (This is the discipline that prevents the "Topside +14.8% n=11" class of
  error.)
- **Ringkas lede:** 40–60 words, lead with the claim restatement, **bold the verdict word**.
- **Methodology citation:** the embedded methodology resource (weekly-average cadence, equal-
  premise weighting, outlier filtering) is inlined so the LLM cites correct caveats.
- **FAMA value-chain note:** if the claim is about *where* a price moved (farm-gate vs retail
  markup), instruct use of the `fama_margin`/`fama_top_movers` tools.

## 6. Rendered-message design (representative — `semak-dakwaan-harga`)

`prompts/get` returns two content blocks in one `user` message (or two messages):

1. **Embedded resource** — the methodology (`{type:"resource", resource:{uri:"manamurah://docs/methodology", mimeType:"text/markdown", text:<embedded const>}}`), zero-fetch.
2. **Text** — the templated instruction, e.g. (BM in production; English gist here):

   > Fact-check this claim against Malaysian PriceCatcher data. Claim: "{dakwaan}".
   > {if barang}Focus item: {barang}.{else}First resolve the item with `search_items`.{/if}
   > {if negeri}Scope: {negeri}.{/if}
   > Gather evidence with the manamurah tools (`price_history`, `price_change`, `compare_prices`,
   > `top_movers`, `find_cheapest`; `fama_margin` if the claim is about value-chain markup).
   > Apply coverage rules: headline figures need ≥30 reporting premises; state comparisons need
   > ≥100 national and ≥10 per state; if the claim's item has <5 premises this week, the verdict
   > is "data tidak cukup". Output neutral Bahasa Melayu: a 40–60-word **Ringkas** lede leading
   > with the claim and a **bold verdict** (sahih / tidak tepat / separa tepat / data tidak cukup),
   > then Hasil ringkas, Kesimpulan, and a methodology note. Cite the methodology above.

Required-arg validation: missing `dakwaan` → `-32602`. The other two prompts follow the same
shape (embedded methodology optional for them; basket/compare are less caveat-heavy).

## 7. Argument completion (absorbs #2 Completions)

Completers attach to the completable arguments above, per
[`spec-mcp-completions.md`](./2026-05-22-spec-mcp-completions.md) (the design reference):

- `barang` → item completer (matches `name` + **`name_en`** from the embedded catalogue — closes
  the English-typist gap; returns canonical names).
- `negeri` → state completer (16, verbatim-cased).
- (Future prompts) `chain`/`category` completers as needed.

Implementation per the Completions spec: `completions: {}` capability **gated on these live
completers**; `completion/complete` handler resolving `(ref/prompt:<name>, argumentName)` to a
completer **co-located with the prompt-argument definition** (no separate registry — avoids a
drift surface); completers read the **embedded catalogue** (zero-network keystrokes); native CF
rate-limit binding scoped to `completion/complete`; completion telemetry sampled at 10%.

## 8. Methodology + catalogue reuse (#1)

Both come from #1 as embedded consts (`src/methodology.ts`; the catalogue const per the
Resources/Completions embed decision). Prompts embed methodology in messages; completers read the
catalogue. **No new upstream endpoints** for #3 itself. (If #1 ships methodology/catalogue as
Cache/KV rather than embedded, #3 still embeds for `prompts/get` + completion to stay data-free —
reconcile in build.)

## 9. Protocol changes (Worker, `src/index.ts`)

### 9.1 Capabilities (`handleInitialize:667`, root manifest `:964`)

```diff
- capabilities: { tools: {}, prompts: {}, resources: {} }
+ capabilities: { tools: {}, prompts: { listChanged: false }, resources: { listChanged: false }, completions: {} }
```
`prompts.listChanged: false` — the prompt set is static (defined in code). (`resources` shown with
its #1 value for context.)

### 9.2 Methods (`handleMCP:736`)

- `prompts/list` — replace the `[]` stub (`:744`) with the `PROMPTS` definitions (name/title/
  description/arguments). No cursor (3 prompts).
- `prompts/get` — **new.** Validate `name` (unknown → `-32602`) + required args (missing →
  `-32602`); clamp arg lengths; render messages via the prompt's `render(args)` fn; return
  `{ description, messages }`.
- `completion/complete` — **new** (from #2): resolve `(ref, argName)` → completer → ≤100 values.

### 9.3 Discovery + telemetry

- Server card (`:909`) / root manifest (`:952`): advertise `prompts`/`completions`; add a
  `prompts` array + `prompt_count`.
- Telemetry (`src/analytics.ts`): add a `prompt` field to `CallMeta` (the prompt name, never the
  filled argument values). `prompts/get` 100% sampled (low volume); `completion/complete` at 10%
  (per #2).

## 10. Required TypeScript

```ts
interface PromptArgument { name: string; description: string; required: boolean }
interface PromptDef {
  name: string; title: string; description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, string>) => PromptMessage[];   // pure, data-free
}
type PromptMessage = { role: 'user' | 'assistant'; content: PromptContent };
type PromptContent =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } };
interface GetPromptParams { name: string; arguments?: Record<string, string> }
```

- `render` is pure (no `await`, no upstream) — enforce by type (`=> PromptMessage[]`, not a Promise).
- Runtime-narrow `request.params` via an `isGetPromptParams` guard (no blind cast). Validate
  required args against the `PromptDef.arguments` before `render`.
- Reuse the `CompletionRef` discriminated union + guard from the Completions spec §6.

## 11. Module structure (`src/`)

- `src/prompts.ts` — `PROMPTS: PromptDef[]` with each prompt's `render` + its argument completers
  **co-located** (a prompt owns its args and their completion). Mirrors the `methodology.ts` /
  `changelog.ts` embed pattern.
- `src/index.ts` — wire `prompts/list`, `prompts/get`, `completion/complete` into `handleMCP`;
  capability flags; discovery surfaces.
- Keep the prompt BM text in `prompts.ts` (reviewable at PR time, like the changelog).

## 12. Security

- **Validate inputs:** required args present; clamp each arg length (e.g. `dakwaan` ≤ 2 KB,
  `barang`/`negeri` ≤ 64); reject non-string. Unknown prompt / missing req → `-32602`.
- **Injection / trust model:** the `dakwaan` free-text arg is interpolated into the instruction
  the LLM receives — a user could embed instructions in it. This is inherent to "fact-check this
  text" and acceptable (the content is the thing under analysis), but: (a) never interpolate args
  into the *embedded resource* block or into anything the Worker itself executes; (b) the template
  frames `{dakwaan}` as quoted claim data, not as instructions. Document the trust boundary.
- **Output:** prompts surface only public catalogue/methodology — no non-public data (same
  invariant as Completions §9).

## 13. Testing / eval (built with #3)

- `prompts/list` → 3 prompts with correct args (required flags).
- `prompts/get semak-dakwaan-harga {dakwaan:"…"}` → messages incl. the embedded methodology +
  templated text with the claim substituted; no upstream fetch fires (CI gate, like Completions).
- Missing required `dakwaan` → `-32602`; unknown prompt → `-32602`; arg-length clamps enforced.
- `render` purity: a static-analysis/test check that `render` performs no `fetch`.
- Completion on `barang` (`"watermelon"` → `TEMBIKAI…`) + `negeri` (`"pul"` → `Pulau Pinang`).
- Capability flags present in `initialize` + root manifest; `prompt_count` correct.

## 14. Build sequence

1. **(Pre-req) #1 Resources** — embedded methodology + catalogue consts.
2. **`src/prompts.ts`** — 3 `PromptDef`s with `render` + co-located completers.
3. **Worker** — `prompts/list` + `prompts/get` + `completion/complete`; capabilities
   (`prompts.listChanged:false`, `completions:{}`); CF rate-limit binding (completion); telemetry
   (`prompt` field, 10% completion sampling); discovery surfaces; `2.9.0` bump + changelog.
4. **Tests** — §13.
5. **Deploy** — `wrangler deploy`; verify `prompts/list`/`prompts/get`/`completion/complete` live;
   confirm `capabilities.prompts` + `completions` in `initialize`.

## 15. Out of scope / deferred

- The jin publish pipeline (deception logging, warroom, email, git, IndexNow, BM-humanizer) —
  stays in the `manamurah-price-analysis` skill; the MCP prompt is the portable analysis core only.
- `assistant`-role seed messages / multi-turn prompt scaffolds — v1 is single user-message templates.
- Additional prompts (`cari-termurah`, `trend-tahunan`, FAMA-specific) — add once the 3 prove out.
- `listChanged` notifications — prompt set is static.

## 16. Open questions

1. **Output language:** BM-only (matches audience/house style) or add a `bahasa: ms|en` arg?
   (Leaning: BM default; add `bahasa` only if telemetry shows EN demand — keeps templates simple.)
2. **Embed methodology in all three prompts, or only `semak-dakwaan-harga`?** Basket/compare are
   less caveat-heavy. (Leaning: methodology embed on fact-check + compare; basket gets a one-line
   coverage note instead.)
3. **`basket-bulanan` `barang` arg shape:** CSV string vs repeated arg? MCP args are flat
   string→string, so a CSV string parsed server-side is likely; how do completers handle per-token
   completion of a CSV? (Leaning: CSV string; completer completes the last token — but confirm the
   protocol/client handles mid-string completion. Possible flag for review.)
4. **Should `prompts/get` ever embed the live catalogue** (e.g. inline the item list for the
   `barang` arg) or strictly rely on completion + tools? (Leaning: rely on completion + tools;
   keep `prompts/get` data-free per §3.)
5. **3 prompts enough for v1**, or include a 4th high-value one now? (Leaning: ship 3, prove out.)

## 17. References

- Parent proposal: `docs/2026-05-22-mcp-enhancement-proposals.md` (#3, #2)
- Completions design reference (absorbed): `docs/2026-05-22-spec-mcp-completions.md`
- Resources spec (catalogue + methodology data): `docs/2026-05-22-spec-mcp-resources.md`
- Source playbook being distilled: `manamurah-price-analysis` jin skill (coverage thresholds,
  verdict taxonomy, Ringkas lede).
- MCP prompts spec: <https://modelcontextprotocol.io/specification/2025-06-18/server/prompts>
- Code anchors (current): capabilities `src/index.ts:667` + `:964`; `prompts/list` stub `:744`;
  dispatch `handleMCP:736`; server card `:909`; root manifest `:952`; `PROTOCOL_VERSION` `:75`;
  telemetry `src/analytics.ts`.
