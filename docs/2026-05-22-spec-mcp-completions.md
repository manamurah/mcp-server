# Spec: MCP Completions (argument autocomplete) for manamurah MCP server

**Status:** Reviewed & revised (v2, 2026-05-22) — incorporates the 7-persona review in
[`reviews/2026-05-22-MCP2-COMPLETIONS/`](./reviews/2026-05-22-MCP2-COMPLETIONS/) (see
[`CONSOLIDATION.md`](./reviews/2026-05-22-MCP2-COMPLETIONS/CONSOLIDATION.md)).
**This is a DESIGN REFERENCE, not a standalone build.** The review's unanimous structural
finding: argument completion is a *facet of a prompt argument*, not a feature — it has no
surface, data, or value without #1 (data) and #3 (prompt arguments). **It folds into the #3
Prompts spec and ships in the #3 release.** Implements Tier-1 item #2 of
[`2026-05-22-mcp-enhancement-proposals.md`](./2026-05-22-mcp-enhancement-proposals.md), now
demoted from a standalone tier.
**Created:** 2026-05-22 · **Revised:** 2026-05-22 (post-review)
**Version impact:** none of its own — part of the #3 Prompts release.
**Protocol version:** ship **context-free on `2024-11-05`**; the `context.arguments` dependent-
completion feature (needs `2025-06-18`) is deferred to a separate server-wide bump (§8).

> **Headline finding (read first):** the proposal framed #2 as "autocomplete the
> `item`/`state`/`chain`/`category` **tool** parameters." **MCP does not support tool-argument
> completion.** `completion/complete` attaches **only** to **prompt** arguments (`ref/prompt`)
> and **resource URI-template** arguments (`ref/resource`). So completion is meaningless until
> #3 Prompts exist, and pairs with their *name-typed* arguments. **Do not build #2 standalone;
> build the completers into the #3 prompt-argument definitions.** This document specifies the
> machinery + completers so #3 can absorb them.

## 1. Goal

IDE-style autocomplete for the high-friction Malaysian-data arguments — item, state, chain,
category — on the **#3 prompt arguments**, so users/agents don't need exact codes or spellings.
Same friction the #1 catalogue attacks from the data side; completion attacks the input side.

## 2. What MCP completion actually is (grounding — verified against the live spec)

- Capability: `"capabilities": { "completions": {} }`.
- `completion/complete` params:
  - `ref`: **`{ type: "ref/prompt", name }`** OR **`{ type: "ref/resource", uri }`** (URI
    *template*). **No `ref/tool`.**
  - `argument`: `{ name, value }` (the arg + partial value).
  - `context` *(optional, 2025-06-18+ only)*: `{ arguments: { <name>: <value> } }` for dependent
    completions.
- Result: `{ completion: { values: string[] /* ≤100 */, total?: number, hasMore: boolean } }`.
- SHOULD: relevance sort, fuzzy match, rate-limit, validate inputs.
- Errors: `-32601` (capability/ref unsupported), `-32602` (bad ref/args), `-32603` (internal).
- **`values` are inserted verbatim as the argument value** → completers for a name-typed arg
  return names; a code-typed arg could only return bare codes (why `{item_code}` stays
  uncompletable, §11).

## 3. Decision: fold into #3 Prompts (resolved — was "sequencing")

Completion needs a completable surface. The only viable one is **#3 prompt arguments** (name-
typed → natural). The Resources-v2 `{item_code}` template is a weak surface (code vs name
mismatch) and stays uncompletable (§11); tools are not completable in MCP.

**Therefore:** the completer machinery and the four completers below are **specified here but
implemented inside #3**, with each completer **hanging off its prompt-argument definition** (not
a separate `COMPLETERS` registry — a separate registry would duplicate prompt-arg names and
become a drift surface, the same class as the tool/Python-ref drift MCP1 flagged). The advertised
`completions: {}` capability is **gated on a non-empty live completer** — never advertise an
empty completion surface.

## 4. Completers (built into #3 prompt arguments)

For #3 prompts exposing these name-typed arguments, register a completer per prompt-argument:

| Completer | Backing data (embedded catalogue, §7) | Match | Returns (verbatim values) |
|---|---|---|---|
| `item` | `catalogue/items` `name` **+ `name_en`** | case-insensitive substring + prefix-boost, ASCII-fold | canonical item **names** (cap 100, `hasMore`) |
| `state` | `catalogue/states` (16) | prefix, fold | canonical state names (`Selangor`, `W.P. Kuala Lumpur` — verbatim, case-sensitive) |
| `chain` | `catalogue/chains` (~50) | substring, fold | chain names (`AEON`, `MYDIN`) |
| `category` | `catalogue/categories` (~40) | prefix, fold | category labels (`SAYUR-SAYURAN`) |

**English-typist gap (MCP2 UX-1) is closed at the source:** the #1 `catalogue/items` now carries
`name_en` (required) and is recent-active filtered (user decision 2026-05-22). The `item`
completer matches on `name` **and** `name_en`, so "watermelon" resolves to `TEMBIKAI…`. No
separate alias map needed. Returned values are the canonical names (UX-4: verbatim, correctly
cased — matching is fold-insensitive, output is not).

## 5. Protocol changes (Worker, `src/index.ts`)

### 5.1 Capability (`handleInitialize` ~`:667`, root manifest ~`:964`)

```diff
- capabilities: { tools: {}, prompts: {}, resources: { listChanged: false } }
+ capabilities: { tools: {}, prompts: {}, resources: { listChanged: false }, completions: {} }
```
**Gate this flag on a live completer existing** (i.e. it appears with #3, not before).

### 5.2 `completion/complete` handler (`handleMCP` ~`:736`)

Add `case 'completion/complete'`:
1. Runtime-narrow params via a type guard (§6) → `{ ref, argument, context? }`.
2. Resolve the completer for `(ref, argument.name)` from the **prompt-argument definitions**
   (#3). Unknown `(ref,arg)` → `{ values: [], hasMore: false }` (not an error). Malformed `ref` /
   missing `argument` → `-32602`.
3. Clamp `argument.value` (≤64 chars), match over the embedded list, sort (prefix > substring,
   then alpha / `premise_count`), truncate to 100, set `total` + `hasMore`.

## 6. Required TypeScript (matches the Resources bar — Type-safety High)

```ts
interface PromptReference   { type: 'ref/prompt';   name: string }
interface ResourceReference { type: 'ref/resource'; uri: string }
type CompletionRef = PromptReference | ResourceReference;          // discriminated union
interface CompletionContext { arguments: Record<string, string> } // 2025-06-18+ only
interface CompleteParams { ref: CompletionRef; argument: { name: string; value: string }; context?: CompletionContext }
interface CompleteResult { completion: { values: string[]; total?: number; hasMore: boolean } }
type Completer = (partial: string, ctx?: CompletionContext) => string[]; // pre-cap full matches
```

- `ctx` is **optional** — it is protocol-gated (absent on 2024-11-05). A required `ctx` would
  type a lie.
- Resolve the ref via an **exhaustive** `switch (ref.type)` with a `never` default — never
  blind-cast the union (the existing `handleToolCall` flat-cast must not be copied onto `ref`).
- Mandate an `isCompleteParams(p: unknown): p is CompleteParams` guard before use (no zod in
  repo). Use `Map.get`/`.find` (already `T | undefined` under the repo's `noUncheckedIndexedAccess`
  default), never bare `[]`.

## 7. Backing data — embed the catalogue (CF + Perf High)

Completers read an **embedded catalogue const bundled into the Worker** (mirrors
`methodology.ts`/`changelog.ts`), NOT the #1 Cache-API/KV phases. Rationale: those are async
network reads, so a cold isolate's **first keystroke** would block on a fetch — the worst place
for latency. Embedding (~75–90 KB with `name_en` + recent-active filter; trivial vs the bundle
limit) makes every keystroke, including the first, **zero-network** and makes the "no ES call"
property structurally true. Parse/fold once into a **module-global memo** (per-isolate); CF
doesn't guarantee isolate persistence, which is fine for read-only ETL-derived data.

**Refresh tradeoff:** an embedded catalogue is only as fresh as the last deploy. Acceptable —
item *names* don't change weekly and recent-active *membership* tolerates a few days' lag.
Regenerate the const on the existing CF Workers Builds cadence if weekly membership freshness
matters. (Build-step detail for #3.)

**Do NOT back completions with `search_items`** — that is an ES round-trip per keystroke (the
exact cost/capacity risk the reviews forbid). Reserve `search_items` for actual resolution.

## 8. Protocol-version consideration

Ship completers **context-free on `2024-11-05`** (each arg completes independently). Dependent
completions (e.g. district filtered by chosen state) need `context.arguments` from `2025-06-18`.
If ever wanted, bump the advertised `PROTOCOL_VERSION` (`src/index.ts:75`) **server-wide** in a
dedicated PR with live-client re-validation (Claude.ai, Claude Desktop, ChatGPT) — never gate it
per-completer.

## 9. Security & rate limiting (Security + CF — MUST)

- **Rate limiting (Q5 resolved):** add the **native CF Workers Rate Limiting binding** (GA
  2025-09) scoped to `completion/complete` — one `[[ratelimits]]` block, keyed on
  `Mcp-Session-Id`→IP, returning an empty completion set (not an error) on trip. **The advertised
  "120/60s upstream" limit does NOT cover completion** — completion is in-memory and never reaches
  the upstream that enforces it, so without this binding completion is uncapped. (Machine-local
  counter, ~0 latency; scopes to the method without throttling tool calls.)
- **Validate all inputs** (not just `argument.value`): clamp/validate `argument.name`, `ref.name`,
  `ref.uri`, and a global body-size cap. The Worker does no in-process validation today — the
  handler owns it.
- **Public-data-only invariant (normative + CI test):** completers surface ONLY public catalogue
  values already available via tools/resources — no premise-level/non-public data. True today by
  construction; the CI test prevents the first future prompt arg from silently breaking it.
- **No secrets/values in telemetry** (§10).

## 10. Telemetry (Cost + Perf High)

- **Sample completion at 10%** (`Math.random() < 0.10` around the completion-path `recordMcp`);
  keep 100% on all other methods. Completion is the **highest-volume** method (per keystroke) —
  the draft's "100% is fine (low volume)" was inverted; at 100% a viral spike is ~$135/mo of pure
  WAE writes, ~$13.50 at 10%.
- Record `completionRef` (`prompt:<name>#<arg>`) + match count + latency — **never the typed
  `argument.value`** (sensitive + high-cardinality).
- Add a value-free **`zeroMatch` counter** (the ref+arg that returned no values) so the
  English-typist / fuzzy-quality gap is observable without logging input.

## 11. Out of scope — `{item_code}` resource-template completion

Leave the (deferred) `manamurah://item/{item_code}` template **uncompletable**. MCP `values` are
inserted verbatim, so a code arg could only return bare numeric codes (unreadable) — display
strings like `"123 — TEMBIKAI…"` violate the insert-this invariant and are un-typeable. Name→code
resolution belongs to `search_items`. (Unanimous: type-safety, UX, architecture.)

## 12. Testing / eval (built with #3)

- `completion/complete` `ref/prompt` + `item`, partial `"ayam"` → ayam* names; `"watermelon"` →
  `TEMBIKAI…` (via `name_en`); ≤100, `hasMore` correct.
- `state` `"pul"` → `Pulau Pinang` (fold/prefix), returned **verbatim/cased**.
- Unknown `(ref, argument)` → `{ values: [], hasMore: false }` (not an error).
- Malformed `ref` / missing `argument` → `-32602`.
- Input clamps enforced (`value`, `name`, `ref.*`, body size).
- **CI gate:** no upstream/ES fetch fires during a completion (in-memory only).
- **CI test:** public-data-only invariant (no completer wired to non-public data).
- Capability advertised only when a live completer exists.

## 13. Build sequence (inside #3 Prompts)

1. **(Pre-req) #1 Resources** — embedded/cached catalogue incl. required `name_en` + recent-active
   filter (Resources spec §2/§9).
2. **#3 Prompts** — define prompts + their name-typed arguments; **attach a completer to each
   completable argument** (this spec's §4 completers, reading the embedded catalogue §7).
3. **Worker** — `completions: {}` capability (gated on a live completer); `completion/complete`
   handler (§5) + types (§6); CF rate-limit binding (§9); 10%-sampled telemetry + `zeroMatch`
   (§10); discovery surfaces.
4. **Tests** — §12.
5. **Deploy** — `wrangler deploy`; verify `completion/complete` against a real #3 prompt argument;
   confirm `capabilities.completions` in `initialize`.

## 14. Resolved decisions (was "open questions")

1. **Sequencing:** fold into #3; no standalone spec/tier/version/registry; capability gated on a
   live completer.
2. **`{item_code}` template:** leave uncompletable (§11).
3. **Fuzzy quality:** prefix + substring + ASCII-fold; trigram deferrable (cost-neutral in-memory);
   English-typist gap closed by required `name_en`; add `zeroMatch` counter.
4. **Protocol bump:** defer; ship context-free on 2024-11-05; bump server-wide later if needed.
5. **Rate limiting:** native CF Workers Rate Limiting binding scoped to completion (the shared
   upstream limit does not apply).

## 15. References

- Review folder: [`reviews/2026-05-22-MCP2-COMPLETIONS/`](./reviews/2026-05-22-MCP2-COMPLETIONS/)
  (7 persona files + `CONSOLIDATION.md`).
- Parent proposal: `docs/2026-05-22-mcp-enhancement-proposals.md` (#2)
- Resources spec (catalogue data, now incl. required `name_en` + recent-active filter):
  `docs/2026-05-22-spec-mcp-resources.md` §2/§9.
- MCP completion spec: <https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion>
- Code anchors (current, post-`chain_mom_movers`): capabilities `src/index.ts:667` + root manifest
  `:964`; dispatch `handleMCP:736`; server card `:909`; root manifest `:952`; `PROTOCOL_VERSION`
  `:75`; telemetry `src/analytics.ts`; `tsconfig.json` (`noUncheckedIndexedAccess` default).
