# Spec: MCP Completions (argument autocomplete) for manamurah MCP server

**Status:** Draft spec — not yet implemented. Implements Tier-1 item #2 of
[`2026-05-22-mcp-enhancement-proposals.md`](./2026-05-22-mcp-enhancement-proposals.md).
**Created:** 2026-05-22
**Target server:** `manamurah-mcp-server` (this repo) — TS Cloudflare Worker, `src/index.ts`.
**Server version impact:** minor bump, **version TBD by sequencing** (lands with or after
Prompts #3 / Resources-v2 templates — see §3). Not 2.7.0 (already shipped) and not 2.8.0
(reserved for Resources v1).
**Protocol version:** `2024-11-05` today. Basic completions are supported there; **dependent
completions (`context.arguments`) require upgrading the advertised version to `2025-06-18`** (§8).

> **Headline finding (read first):** the proposal framed #2 as "autocomplete the
> `item`/`state`/`chain`/`category` **tool** parameters." **MCP does not support tool-argument
> completion.** `completion/complete` attaches **only** to (a) **prompt** arguments
> (`ref/prompt`) and (b) **resource URI-template** arguments (`ref/resource`). So Completions
> has *no surface to attach to* until Prompts (#3) and/or the Resources-v2 item template (#1)
> exist. This spec defines the completion machinery and the catalogue-backed completers, and
> **recommends sequencing #2 to land together with #3 (Prompts)** — that is where it delivers
> the most user value. Building #2 standalone now would ship a capability with nothing to complete.

## 1. Goal

Give agents/users IDE-style autocomplete for the high-friction Malaysian-data
arguments — item, state, chain, category — so they don't have to know exact
codes or spellings. This is the same friction the Resources catalogue (#1)
attacks from the data side; Completions attacks it from the *input* side. The
whitepaper's "concise, low-friction tool use" applies.

## 2. What MCP completion actually is (grounding)

Per the MCP spec (utilities/completion):

- Server declares the capability: `"capabilities": { "completions": {} }`.
- Client sends `completion/complete` with:
  - `ref`: **`{ type: "ref/prompt", name }`** OR **`{ type: "ref/resource", uri }`** (a URI
    *template*). **No `ref/tool`.**
  - `argument`: `{ name, value }` (the arg being typed + its partial value).
  - `context` *(optional, 2025-06-18+)*: `{ arguments: { <resolvedName>: <value> } }` for
    dependent completions (e.g. district suggestions filtered by an already-chosen state).
- Server returns `{ completion: { values: string[] /* ≤100 */, total?: number, hasMore: boolean } }`.
- SHOULD: rank by relevance, fuzzy-match, **rate-limit**, validate inputs.
- Errors: `-32601` (capability/ref unsupported), `-32602` (bad ref/args), `-32603` (internal).

**Implication:** completion `values` are the *strings inserted as the argument value*. That
shapes completer design — a completer for a `{item_code}` template arg must return codes
(awkward when the user types a name), whereas a completer for a name-typed *prompt* argument
returns names (natural). This is the core reason Completions pairs best with **Prompts**.

## 3. Dependency & sequencing (the load-bearing decision)

Completions cannot ship value alone. It needs at least one completable surface:

| Surface | Status | Completable args it would expose |
|---|---|---|
| **Prompts (#3)** | not built | `item`, `state`, `chain`, `category` arguments on prompts like `semak-dakwaan-harga`, `basket-bulanan`, `banding-bandar` — **name-typed → natural completion** |
| **Resource templates (#1 v2)** | deferred to v2 (Resources spec §10) | `{item_code}` on `manamurah://item/{item_code}` — **code-typed → awkward** (user types a name, arg wants a number) |
| **Tools** | live | ❌ not completable in MCP |

**Recommendation: build #2 together with #3 (Prompts).** Prompt arguments are name-typed and
user-facing, which is exactly what completion is good at. The Resources-v2 `{item_code}`
template is a weak completion surface (code vs name mismatch) and is itself deferred.

Concretely, the build order becomes: **#1 Resources (data) → #3 Prompts (surface) + #2
Completions (autocomplete on those prompt args), shipped together.** This spec is written so
the completion *machinery* (capability, handler, completer registry) can land first as inert
scaffolding if desired, but the *useful* completers switch on with the prompt arguments.

## 4. Completable surfaces & completers (when Prompts exist)

Assuming the #3 prompts expose these arguments, register a completer per `(ref, argumentName)`:

| Completer | Backing data (reuse #1) | Match | Returns (values) |
|---|---|---|---|
| `item` | `catalogue/items` (Malay `name`) | case-insensitive substring + prefix-boost on `name` | item **names** (the prompt arg is name-typed); cap 100, `hasMore` when more |
| `state` | `catalogue/states` (16) | prefix on `name` | canonical state names (e.g. `Selangor`, `W.P. Kuala Lumpur`) |
| `chain` | `catalogue/chains` (~50) | substring on `name` | chain names (e.g. `AEON`, `MYDIN`) |
| `category` | `catalogue/categories` (~40) | prefix on `category` | category labels (e.g. `SAYUR-SAYURAN`) |

All four are backed by the **same catalogue data #1 already loads** — no new upstream
endpoints. The completers are pure in-memory filters over small lists (states/chains/categories
are tiny; items ~756). This is the synergy: #1 provides the data, #2 filters it, #3 surfaces it.

## 5. Protocol changes (Worker, `src/index.ts`)

### 5.1 Capability (`handleInitialize:632`, root manifest `:929`)

```diff
- capabilities: { tools: {}, prompts: {}, resources: { listChanged: false } }
+ capabilities: { tools: {}, prompts: {}, resources: { listChanged: false }, completions: {} }
```

### 5.2 `completion/complete` handler (`handleMCP:701`)

Add a `case 'completion/complete'`. Dispatch:

1. Parse `ref`, `argument.name`, `argument.value`, optional `context.arguments`.
2. Resolve a completer from a **registry** keyed by `(refKey, argumentName)`, where
   `refKey` is `prompt:<name>` or `resource:<uriTemplate>`. Unknown `(ref,arg)` → empty
   `{ values: [], hasMore: false }` (NOT an error — the spec says return suggestions; an
   unknown completable arg just has none). Reserve `-32602` for a malformed `ref`/missing
   `argument`.
3. Run the completer over the backing list, fuzzy/prefix match on `argument.value`.
4. Truncate to 100, set `total` (full match count) and `hasMore = total > returned`.

```ts
type Completer = (partial: string, ctx: Record<string,string>) => string[]; // full matches, pre-cap
interface CompletionEntry { refKey: string; argument: string; complete: Completer }
const COMPLETERS: CompletionEntry[] = [ /* item/state/chain/category, per §4 */ ];
const COMPLETION_CAP = 100;
```

### 5.3 Telemetry (`src/analytics.ts`)

- Reuse the `resource`/`tool` pattern: add a `completionRef` field (the `refKey` +
  `argumentName`, e.g. `prompt:semak-dakwaan-harga#item`) — **never the partial value typed**
  (could be sensitive / high-cardinality). Record match count + latency.
- 100% sampling is fine (low volume), but completion is the one method a client may call
  rapidly while typing — see rate-limiting (§9).

### 5.4 Discovery

- Server card (`:867`) + root manifest (`:929`): advertise `completions` in `capabilities`.
- No tool/resource description changes (completions are invisible until a client uses them).

## 6. Backing data & matching

- **Source:** the #1 catalogue (post-#1 this is either embedded, Cache-API-cached, or KV per
  the Resources caching phases). Completers read the same in-memory/cached lists — **do not add
  upstream calls per keystroke** (that would be an ES round-trip on every character; see §9).
- **Matching:** case-insensitive; ASCII-fold (so `pulau pinang` matches `Pulau Pinang`); prefix
  matches rank above substring matches; ties broken by `premise_count` (chains) or alpha.
- **`item` scale:** 756 items in memory is trivial to filter per request; no index needed.

## 7. Why not back completions with `search_items`?

Tempting (it already does multilingual item search), but: (a) it's an ES round-trip per
keystroke — latency + the exact ES-load/cost the reviews warned about; (b) it returns rich
records, not completion strings. Use the **cached catalogue list** for completion; reserve
`search_items` for actual resolution. (If fuzzy quality proves insufficient from the flat list,
revisit — but start cheap.)

## 8. Protocol-version consideration

The server advertises `2024-11-05`, where `completion/complete` exists **without** the
`context` field. Dependent completions (e.g. "suggest districts within the already-chosen
state") require the `context.arguments` field added in **`2025-06-18`**. Decision: ship v1
completers **context-free** (each arg completes independently) on the current protocol version;
only bump the advertised `protocolVersion` to `2025-06-18` if/when a dependent completer is
actually wanted. Bumping the protocol version is its own review (it changes initialize
negotiation and should be validated against the live clients: Claude.ai, Claude Desktop, ChatGPT).

## 9. Security & rate limiting (spec MUST)

- **Rate limiting:** completion is uniquely chatty (one call per keystroke, debounced
  client-side at best). The upstream 120 req/60s/IP limit covers the `/mcp` endpoint, but a
  fast typist on one resource could dominate it. Since completers are in-memory (no upstream
  call), the marginal cost is CPU only — acceptable — but document that completion shares the
  IP budget and consider a separate, looser in-Worker counter only if telemetry shows abuse.
- **Validate inputs:** clamp `argument.value` length (e.g. ≤ 64 chars) before matching;
  reject non-string. Malformed `ref` → `-32602`.
- **No information disclosure:** completers only ever surface **public catalogue data** already
  available via tools/resources — no premise-level or non-public values. (Spec's "prevent
  completion-based information disclosure" is satisfied by construction.)
- **No secrets in telemetry:** record the ref+arg, never the typed value (§5.3).

## 10. Testing / eval

- `completion/complete` with `ref/prompt` + `item`, partial `"ayam"` → returns ayam* item
  names, `hasMore` correct, ≤ 100.
- `state` completer: `"pul"` → `Pulau Pinang` (ASCII-fold/prefix).
- Unknown `(ref, argument)` → `{ values: [], hasMore: false }` (not an error).
- Malformed `ref` / missing `argument` → `-32602`.
- Capability advertised in `initialize` + root manifest.
- Value-length clamp enforced.
- No upstream/ES call fires during a completion (in-memory only) — guards the cost finding.

## 11. Build sequence

Gated on #3 (Prompts) for real value:

1. **(Pre-req) #1 Resources** — provides the cached catalogue lists. (Shipping/shipped.)
2. **(Pre-req / co-release) #3 Prompts** — provides the name-typed arguments to complete.
3. **Worker** — `completions: {}` capability; `completion/complete` handler; `COMPLETERS`
   registry wired to the cached catalogue; telemetry `completionRef`; discovery surfaces;
   version bump.
4. **Tests** — §10.
5. **Deploy** — `wrangler deploy`; verify `completion/complete` over the live endpoint against a
   real prompt argument; confirm `capabilities.completions` in `initialize`.

## 12. Open questions

1. **Sequencing (the big one):** ship #2 **with #3 (Prompts)** as recommended, or build the
   inert completion machinery now and switch on completers as surfaces appear? (Leaning:
   co-ship with #3 — avoid a capability with nothing to complete.)
2. **`{item_code}` template completion:** when the Resources-v2 item template lands, do we add a
   code completer (return `"123 — TEMBIKAI…"` display strings? or bare codes?) despite the
   name/code mismatch, or leave that template uncompletable and rely on the prompt `item`
   completer? (Leaning: leave the template uncompletable; name→code resolution belongs to
   `search_items`.)
3. **Fuzzy quality:** is flat substring/prefix over the cached catalogue good enough, or do we
   need typo-tolerance (e.g. trigram)? (Leaning: start with prefix+substring; revisit on
   telemetry.)
4. **Protocol bump to 2025-06-18:** do any target clients need dependent completions
   (state→district) badly enough to justify the protocol-version upgrade + re-validation now?
   (Leaning: no — ship context-free on 2024-11-05.)
5. **Rate-limit posture:** rely on the shared upstream 120/60s, or add a looser in-Worker
   completion counter? (Leaning: rely on shared limit; completers are CPU-only/in-memory.)

## 13. References

- Parent proposal: `docs/2026-05-22-mcp-enhancement-proposals.md` (#2)
- Resources spec (data + template deferral): `docs/2026-05-22-spec-mcp-resources.md`
- MCP completion spec: <https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion>
- Code anchors: capabilities `src/index.ts:632` + `:929`; method dispatch `handleMCP:701`;
  telemetry `src/analytics.ts`; protocol version `src/index.ts:75` (`PROTOCOL_VERSION`).
