# Type Safety Review — MCP Resources spec

**Date:** 2026-05-22
**Persona:** Type Safety Reviewer (TypeScript)
**Scope:** `docs/2026-05-22-spec-mcp-resources.md` (primary), `docs/2026-05-22-mcp-enhancement-proposals.md` (proposal #1, #7), grounded against `src/index.ts`, `src/analytics.ts`, `tsconfig.json`, `package.json`. REVIEW ONLY — no source modified.

---

## Executive summary

The spec is functionally well-reasoned (allowlist dispatch, freshness `weekdate`, size budget) but is **almost entirely silent on TypeScript type design**. It describes JSON shapes in prose and JSON examples, but mandates zero interfaces. If implemented as-described, the resource code will inherit the existing codebase's two structural weaknesses:

1. `callUpstream` returns `Promise<unknown>` (`src/index.ts:586`), and the spec proxies resource payloads "via the existing `callUpstream` pattern" (§3.2 step 3) then stringifies `data` into `text`. So every resource payload is `unknown` then stringified — no compile-time guarantee that `catalogue/items` actually carries the lean 5-field shape, and the `weekdate`-on-every-payload invariant (§4) is unenforceable at the type level.
2. The `RESOURCES` const, `resources/read` params, the `contents` result, and the URI-template descriptor have **no proposed interfaces**, mirroring the loose `request.params as {...}` casts already in `handleToolCall` (`:647`) and the `MCPResponse.result?: unknown` design (`:59`).

`tsconfig` is good — `strict: true` is on and `tsc --noEmit` passes clean today — but **`noUncheckedIndexedAccess: false`** (`tsconfig.json:15`) is the single highest-risk gap for the new code: URI-template matching and allowlist array lookups will index into arrays/records and silently produce non-`undefined` types for possibly-absent elements.

The schema-as-source-of-truth risk (proposal #7) gets **worse** with this spec: resources add a *third* hand-maintained schema surface (TS Worker + Pydantic ref repo + now resource shapes), and unlike tools these shapes aren't even validated by an inline JSON Schema.

**Overall type-safety rating: Medium.** No unsound types ship today (the existing code compiles clean and the `unknown` boundaries are honest), but the spec institutionalises an untyped data boundary at exactly the place that needs typing, and leaves the implementer to invent every interface ad hoc. Raising this to Low is cheap: mandate ~5 interfaces and flip `noUncheckedIndexedAccess`.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| T1 | High | Resource payloads are `unknown` end-to-end; per-payload `weekdate` invariant unenforceable | spec §3.2 step 3-4, §4; `src/index.ts:586,619` | Type `callUpstream` generically or define per-resource payload interfaces; require `weekdate`/`generated_at` in a base type |
| T2 | High | No interfaces mandated for `RESOURCES`, `resources/read` params, `contents`, or templates | spec §3.2, §2 | Spec must declare `MCPResource`, `ResourceContents`, `ResourceReadParams`, `ResourceTemplate` (snippets below) |
| T3 | High | `noUncheckedIndexedAccess: false` makes allowlist + URI-template indexing unsound | `tsconfig.json:15`; spec §3.2 step 1 | Enable the flag (or use `.find()`/`Map.get()` whose return is already `T \| undefined`); never bare-index the matched template's capture groups |
| T4 | Medium | `resources/read` params parsed via untyped cast, repeating `handleToolCall` pattern | spec §3.2 step 1; `src/index.ts:647` | Mandate a typed `parseReadParams(request.params): { uri: string }` with runtime narrowing, not `as` |
| T5 | Medium | `MCPResponse.result` stays `unknown` — no discriminated union for new methods | `src/index.ts:59`; spec §3.2 | Optional: introduce a `result` union; at minimum type each handler's return literal |
| T6 | Medium | `handleMCP` switch is not exhaustive; new cases added by hand with no compiler guard | `src/index.ts:701`; spec §3.2 | Keep `default` arm (good) but consider a `MCPMethod` union + `never` check on known methods |
| T7 | Medium | Third hand-maintained schema surface; resource shapes not even JSON-Schema-validated | proposal #7; spec §5 | Define resource payload types in one module; long-term, generate from upstream envelope or Pydantic |
| T8 | Medium | Template `{item_code}` extracted from URI string is `string`, must become validated `number` | spec §2 templates, §3.2 | Mandate `parseInt` + `Number.isInteger` + `>= 1` guard before passing to `callUpstream`; type the path param |
| T9 | Low | `CallMeta.resource` added untyped/loosely; should be `string` not free-form | spec §3.3; `src/analytics.ts:32` | Add `resource?: string` to `CallMeta`; thread to a `blob8`/index choice consciously (see T11) |
| T10 | Low | `RESOURCES` entries `{uri,name,title,description,mimeType}` — `mimeType`/`uri` should be string-literal-narrowed | spec §3.2 | Use `as const` on `RESOURCES` so `uri` becomes a literal union usable as the allowlist key type |
| T11 | Info | WAE schema (`analytics.ts:15-28`) documents fixed blob1-7/double1-2 layout; adding `resource` needs a slot decision | `src/analytics.ts:91-107` | If `resource` rides in `blob2` (reuse `tool` slot) vs a new `blob8`, document it; keep `index` cardinality low |

---

## Detailed findings

### T1 (High) — Untyped resource payload boundary

`callUpstream` is declared `Promise<unknown>` (`src/index.ts:586`) and returns parsed JSON (`:619`) with no parse/validation. For tools this is acceptable: the payload is immediately re-serialised into a `text` block and dropped into `structuredContent: data` (`:679`) which the MCP `result` types as `unknown` anyway.

The spec carries this same pattern into resources (§3.2 step 3-4): "Proxy via the existing `callUpstream` pattern … `text` = stringified `data`". The consequence the spec doesn't acknowledge: its own §4 invariant — *"Every JSON resource payload carries a `weekdate`"* — is a **pure runtime convention with zero compile-time backing**. If an upstream endpoint forgets `weekdate`, nothing in the Worker catches it; the size-budget test (§7) won't catch it either.

Recommendation — make the boundary typed by giving `callUpstream` a generic and defining per-resource payload types:

```ts
// Base every JSON resource payload must satisfy (enforces §4).
// One of weekdate | generated_at is REQUIRED — express as a union:
type FreshStamped =
  | { weekdate: string; generated_at?: never }
  | { generated_at: string; weekdate?: never };

interface ItemsCatalogue extends FreshStamped {
  items: ReadonlyArray<{
    item_code: number;
    name: string;
    name_en: string;
    unit: string;
    item_category: string;
  }>;
}
interface StatesCatalogue extends FreshStamped {
  states: ReadonlyArray<{ stateid: number; name: string; slug: string; region: string }>;
}
// generic upstream — opt-in typing at call sites without breaking existing `unknown` callers
async function callUpstream<T = unknown>(/* … */): Promise<T> { /* … */ }
```

The Worker is a passthrough proxy, so a *full* runtime validator (zod) is out of scope and rightly avoided (zero-deps is a design goal). But the compile-time shape is free and worth mandating for the handful of resource payloads.

### T2 (High) — Missing mandated interfaces

The spec describes `RESOURCES` entries (§3.2: "Each entry: `{ uri, name, title, description, mimeType }`"), the `contents` result (§4), `resources/read` params (`{uri}`), and the template descriptor (§2 table) entirely in prose/JSON. No `interface`. Compare the existing code, which *does* define `MCPTool` (`src/index.ts:24`) — the resource code deserves the same. Mandate:

```ts
type ResourceMime = 'application/json' | 'text/markdown';

interface MCPResource {
  uri: string;          // see T10 — narrow to literal union via `as const`
  name: string;
  title: string;
  description: string;
  mimeType: ResourceMime;
}

interface ResourceContents {
  uri: string;
  mimeType: ResourceMime;
  text: string;         // stringified payload | raw markdown
}
interface ResourceReadResult { contents: ResourceContents[]; }

interface ResourceReadParams { uri: string; }

interface ResourceTemplate {
  uriTemplate: string;  // RFC 6570, e.g. 'manamurah://item/{item_code}'
  name: string;
  title: string;
  description: string;
  mimeType: ResourceMime;
}
```

`const RESOURCES: readonly MCPResource[]` parallels `const TOOLS: MCPTool[]` and lets `resources/list` return a typed array.

### T3 (High) — `noUncheckedIndexedAccess: false`

`tsconfig.json:15` explicitly disables `noUncheckedIndexedAccess`. With it off, `arr[i]` and `record[key]` are typed as `T`, not `T | undefined`. The spec's allowlist dispatch (§3.2 step 1) and any URI-template capture-group extraction will index into structures where the element may be absent — and the compiler will not force a guard, the exact class of bug `-32602` is supposed to catch.

Two safe routes:
- Prefer lookups whose return type is *already* `T | undefined`: `RESOURCES.find(r => r.uri === uri)` and `new Map(...).get(uri)`. These narrow correctly even with the flag off.
- Or flip `noUncheckedIndexedAccess: true`. Note this may surface new errors in existing code; if a full repo-wide flip is too broad for this change, at minimum **the spec must require `.find()`/`Map.get()` (never bare `[]`) for allowlist and template matching.**

### T4 (Medium) — Untyped param cast

The existing `handleToolCall` does `const params = (request.params ?? {}) as { name?; arguments? }` (`src/index.ts:647`) — an unchecked cast. The spec's `resources/read` will be tempted to copy `request.params as { uri: string }`. That is unsound: `uri` could be missing or non-string at runtime. Mandate a narrowing parse:

```ts
function parseReadParams(params: Record<string, unknown> | undefined): ResourceReadParams | null {
  const uri = params?.['uri'];
  return typeof uri === 'string' && uri.length > 0 ? { uri } : null;
}
// null -> -32602 "Missing or invalid 'uri'. Call resources/list for the catalogue."
```

### T5 / T6 (Medium) — `result: unknown` and switch exhaustiveness

`MCPResponse.result` is `unknown` (`src/index.ts:59`), so every handler's `result` payload is structurally unchecked at the response boundary. The `handleMCP` switch (`:701`) has a sound `default -> -32601` arm, so adding `resources/read` / `resources/templates/list` cases won't *silently* fall through. But there's no compiler guarantee the set of handled methods is complete or that a typo'd case label is caught. A low-cost hardening:

```ts
type MCPMethod =
  | 'initialize' | 'tools/list' | 'tools/call'
  | 'prompts/list' | 'resources/list' | 'resources/read'
  | 'resources/templates/list' | 'ping';
```

Then type each handler's return as `MCPResponse & { result: ResourceReadResult }` etc., so the result literal is checked against the interfaces from T2. Full exhaustiveness via `never` is optional given the `default` arm, but typing the result is high value.

### T7 (Medium) — Schema-as-source-of-truth drift (proposal #7)

Proposal #7 already flags that tool schemas are hand-written twice (TS Worker `src/index.ts:139` + Pydantic `manamurah-mcp-2026`). Resources add a **third** surface — and a weaker one: tool inputs are at least guarded by inline JSON Schema with `additionalProperties:false` and enums, but resource *payload* shapes (the lean 5-field item, the states row) are described only in spec prose and produced by upstream. There is no single source. Recommendation: at minimum, co-locate the resource payload interfaces (T1) in one module (e.g. `src/resources.ts`) next to `RESOURCES`, so the type and the catalogue entry live together. Longer term, the upstream `{status,reason,warnings,data}` envelope (§5) is the real contract — generating these types from the upstream OpenAPI/Pydantic would collapse the drift surface, but that's a Tier-3 effort, not a blocker for this spec.

### T8 (Medium) — Template `{item_code}` is a string until validated

If templates ship (Open Q1), `manamurah://item/{item_code}` yields `item_code` as a `string` from URI parsing, but the upstream tool surface treats `item_code` as `integer` (`src/index.ts:172,205,267`). The spec is silent on the string-to-number bridge. Mandate:

```ts
const m = /^manamurah:\/\/item\/(\d+)$/.exec(uri);   // \d+ rejects non-numeric up front
if (!m) return /* -32602 */;
const itemCode = Number(m[1]);
if (!Number.isInteger(itemCode) || itemCode < 1) return /* -32602 */;
```

This gives both a compile-time `number` and a runtime guard, consistent with the `minimum:1, type:integer` contract the tools already enforce declaratively.

### T9 / T11 (Low / Info) — `CallMeta.resource` typing and WAE slot

`CallMeta` (`src/analytics.ts:32`) should gain `resource?: string` (parallel to `tool?: string`). The WAE schema doc (`analytics.ts:15-28`) hard-codes blob1-7/double1-2. The spec (§3.3) says `recordMcp` already captures `method` and resources flow through — but `recordMcp`'s `McpTelemetryPoint` (`:48`) has no `resource` field, and `recordMcp` writes a fixed blob array (`:92`). Adding `resource` requires either reusing `blob2` (the `tool` slot — semantically "the thing called") or appending `blob8` and updating the schema comment. The spec should make this decision explicit and keep `index` (the GROUP BY key, `:91`) low-cardinality — resource names are bounded (~6 + 1 template), so indexing them is fine.

### T10 (Low) — `as const` on `RESOURCES`

Declaring `const RESOURCES = [...] as const` (or `satisfies readonly MCPResource[]`) narrows each `uri` to a string literal, letting the allowlist key type be a literal union (`'manamurah://catalogue/items' | ...`). That makes the URI-to-upstream-path map (§3.2 step 1) a `Record<ResourceUri, string>` the compiler checks for completeness — strictly better than a runtime `.find()` for the *fixed* (non-template) resources.

---

## Open question answers (through the type lens)

**Q2 — Items catalogue: lean 5 fields vs full (zh/ta/ms aliases).**
Type/maintainability angle: **lean is the better-typed choice, with one caveat.** A 5-field flat record (`{item_code, name, name_en, unit, item_category}`) is a stable, easily-typed shape with no optionality — every item has all five. Adding zh/ta/ms aliases introduces *optional* fields (not every item has every translation), forcing `name_zh?: string | null` and pushing `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` concerns onto every consumer. Lean keeps the resource type a clean required-fields record and honours the §6 size budget. Caveat: make the lean type *the* canonical `CatalogueItem` interface and reuse it for the item-card template payload (T8) so the two surfaces don't diverge.

**Q5 — `name_en` only vs full multilingual in the item card.**
Type-shape consistency angle: **match whatever Q2 decides — do not let the catalogue and the item-card template carry different field sets.** If the catalogue is `name + name_en` (lean), the single-item template card must be `name + name_en` plus the card-only extras (latest avg, premise count, freshness), i.e. `CatalogueItem & ItemCardExtras`. Introducing zh/ta on the card but not the catalogue (or vice-versa) creates two near-identical-but-incompatible types and is exactly the drift T7 warns about. Pick one multilingual policy and express it as a single shared interface used by both `manamurah://catalogue/items` and `manamurah://item/{item_code}`.

---

## Spec change requests

1. **Add a "Types" subsection to §3** mandating the interfaces in T2 (`MCPResource`, `ResourceContents`, `ResourceReadResult`, `ResourceReadParams`, `ResourceTemplate`) and the payload base in T1 (`FreshStamped`, `ItemsCatalogue`, etc.). The spec currently mandates behaviour but no types.
2. **§3.2 step 1:** require allowlist matching via `.find()` / `Map.get()` (or `as const` literal-keyed `Record`), explicitly forbid bare array/record indexing, given `noUncheckedIndexedAccess` is off (T3).
3. **§3.2 step 1 (params):** require a typed `parseReadParams` narrowing function — no `request.params as {uri:string}` cast (T4).
4. **§4:** state that the per-payload `weekdate`/`generated_at` invariant must be encoded in a `FreshStamped` union type, not left as a runtime-only convention (T1).
5. **Templates (§2 / Open Q1):** if shipped, mandate the string-to-`number` validation for `{item_code}` (T8) and reuse the shared `CatalogueItem` type (Q2/Q5).
6. **§3.3:** add `resource?: string` to `CallMeta` *and* `resource?: string` to `McpTelemetryPoint`, and specify the WAE blob slot (reuse `blob2` vs new `blob8`) — currently `recordMcp` has no field to carry it (T9/T11).
7. **tsconfig:** add a note that resource code must be written to be sound under `noUncheckedIndexedAccess` (and ideally flip the flag), so the new code doesn't bank on the loose default (T3).
8. **§7 (tests):** add a compile-time assertion (e.g. a `satisfies` check or a type-level test) that each `RESOURCES` entry conforms to `MCPResource` and each payload to its interface — cheap given there's no runtime validator.
