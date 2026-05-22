# Type Safety Review — MCP Completions spec

**Date:** 2026-05-22
**Persona:** Type Safety Reviewer (TypeScript)
**Scope:** `docs/2026-05-22-spec-mcp-completions.md`, reviewed against the interface bar set
by `docs/2026-05-22-spec-mcp-resources.md` §4 and the live code at `src/index.ts`,
`src/analytics.ts`, `tsconfig.json`, `package.json`.
**Mode:** Review only — no files changed except this one. `npx tsc --noEmit` confirmed
the current baseline is clean (exit 0).

---

## Executive summary

The Completions spec is architecturally sound (the "no `ref/tool`, sequence with Prompts"
headline is correct) but is **under-typed relative to the Resources spec it explicitly
promises to match**. The Resources spec earned a mandatory §4 "Required TypeScript" block
that ships concrete interfaces (`MCPResource`, `ResourceContents`, `ResourceReadParams`,
`CatalogueItem`) and a `Map.get`-only indexing rule. The Completions spec has **no equivalent
section** — its only typing is the four lines at §5.2, and those lines contain three concrete
unsoundness traps:

1. The `ref` discriminated union — the single most important type in the feature, and the one
   the persona brief calls out first — is **never declared as a type**. The spec describes it
   in prose ("`{type:'ref/prompt',name}` OR `{type:'ref/resource',uri}`") but the only TS
   artifact, `Completer = (partial, ctx) => string[]`, has already flattened `ref` away into a
   pre-computed `refKey: string`. There is no exhaustive `switch` model, no `never` check, and
   nothing forces the handler to narrow `params.ref` before building that `refKey`.
2. `ctx: Record<string,string>` is typed as **required and total**, but §8 says `context` is
   optional and protocol-gated to 2025-06-18. The signature lies about an input that is absent
   on the current `2024-11-05` protocol version — every completer body will assume a value the
   runtime may not provide.
3. `request.params` parsing is hand-waved. §5.2 step 1 says "Parse `ref`, `argument.name`…"
   with no narrowing contract. The existing code's loose cast at `handleToolCall` (`src/index.ts:682`)
   is the **wrong** model to copy here, because `ref` is a *discriminated union* (cast-then-trust
   is unsound for unions in a way it merely isn't-great for a flat `{name?, arguments?}` bag).

None of these reach the live `tsc`-clean codebase (the feature is unbuilt), so they are not
Critical *today*. But the spec is the contract the implementer will follow, and as written it
licenses an `any`-shaped union boundary. **Overall rating: High.** One finding (T-1, the
un-narrowed union) is the boundary between High and Critical: if the implementer copies the
`handleToolCall` cast pattern verbatim onto `ref`, it becomes a Critical unsound-type→runtime-bug.

The fix is cheap and mechanical: add a "§X Required TypeScript" block mirroring Resources §4,
with the six interfaces below, an exhaustive-`switch` mandate on `ref.type`, and an explicit
runtime-narrowing contract for `params`. Do that and the feature inherits the same type floor
the Resources reviewers already won.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| T-1 | High | `ref` discriminated union never declared; no exhaustive handling | spec §2, §5.2 | Add `PromptReference`/`ResourceReference`/`CompletionRef` union + exhaustive `switch(ref.type)` with `never` default, modelled on `handleMCP` (`src/index.ts:736`) |
| T-2 | High | `Completer` ctx typed required+total, but `context` is optional/version-gated | spec §5.2:107, §8 | Type ctx as `CompletionContext \| undefined` (or `Readonly<Record<string,string>> = {}`); never assume presence on 2024-11-05 |
| T-3 | High | No runtime narrowing contract for `params.ref` / `params.argument` (no zod) | spec §5.2 step 1; cf. `src/index.ts:682` | Mandate a type-guard (`isCompleteParams`) before use; do NOT copy the `handleToolCall` blind cast onto a union |
| T-4 | Medium | No "Required TypeScript" section; breaks parity with Resources §4 | whole spec; cf. resources spec §4 | Add a normative interface block (the 6 interfaces below) as a merge gate |
| T-5 | Medium | `CompleteResult` / `completion` envelope shape untyped | spec §2:41, §5.2 | Declare `CompletionResult`/`CompleteResult`; `hasMore` required, `total`/`values` typed; cap as branded or documented invariant |
| T-6 | Medium | Registry keyed by composite `string` refKey — stringly-typed, collision-prone | spec §5.2:108-109 | Use `Map<string, Completer>` with a single `completerKey(ref, arg)` builder as the SOLE key source; or structured `Map<RefKey, Map<string, Completer>>` |
| T-7 | Medium | `total` / `hasMore` derivation unsound if `values` pre-cap vs post-cap confused | spec §5.2 step 4 | Type the completer as returning full matches; compute `{values: full.slice(0,cap), total: full.length, hasMore: full.length > cap}` in ONE typed helper |
| T-8 | Low | If any completer ever calls upstream, it inherits `callUpstream` `Promise<unknown>` | spec §6, §7; `src/index.ts:621` | Spec already forbids upstream-in-completer; state the `Completer` return type is **sync** `string[]` to make the boundary unrepresentable |
| T-9 | Low | `analytics.ts` `completionRef` field not typed into `CallMeta` | spec §5.3; `src/analytics.ts:32` | Add `completionRef?: string` to `CallMeta` + a blob slot, mirroring the Resources `resource?` field |
| T-10 | Info | Dead-type risk if registry types land inert before Prompts (Q1) | spec §3, §12 Q1 | Land the *types* now (cheap, no runtime), gate the *registry data* + handler `case` on Prompts; types unused at runtime are not dead code |

---

## Detailed findings

### T-1 (High) — Declare `ref` as a real discriminated union with exhaustive handling

§2 and §5.2 describe `ref` only in prose and a comment. The single TS artifact, the
`Completer` signature, operates on a **pre-flattened** `refKey: string` and `partial: string` —
by the time a completer runs, the union has already been collapsed to a string, so the type
system never sees it. That means the *handler* (which does see `params.ref`) has no compiler
help to (a) prove it handled both arms and (b) reject a malformed third arm.

The existing `handleMCP` method switch (`src/index.ts:736-755`) is the in-repo model the brief
points at: a `switch` over a string-literal-ish discriminant with a `default` that produces an
error. Apply the same shape to `ref.type`, but with a `never`-typed default so a future third
ref kind is a **compile error**, not a silent runtime miss.

```ts
// The protocol's two — and only two — ref kinds (no ref/tool).
interface PromptReference {
  type: 'ref/prompt';
  name: string;            // the prompt name being completed
}
interface ResourceReference {
  type: 'ref/resource';
  uri: string;             // a URI *template*, e.g. manamurah://item/{item_code}
}
type CompletionRef = PromptReference | ResourceReference;
```

Exhaustive narrowing in the handler (mandate this shape, not a cast):

```ts
function refKeyFor(ref: CompletionRef): string {
  switch (ref.type) {
    case 'ref/prompt':   return `prompt:${ref.name}`;
    case 'ref/resource': return `resource:${ref.uri}`;
    default: {
      const _exhaustive: never = ref;   // compile error if a new ref kind is added
      throw new Error(`Unsupported ref type: ${(_exhaustive as { type?: string }).type}`);
    }
  }
}
```

This is the boundary between High and Critical: if the implementer instead writes
`const ref = params.ref as { type: string; name: string; uri: string }` (the natural extension
of the `handleToolCall` cast at `:682`), every downstream access is unsound — `name` is
`undefined` on a resource ref and `uri` is `undefined` on a prompt ref, and TS will not warn.

### T-2 (High) — `context` is optional and version-gated; the `Completer` signature must say so

`Completer = (partial, ctx: Record<string,string>) => string[]` (§5.2:107) types `ctx` as a
**present, total** record. But §8 is explicit: `context.arguments` only exists from protocol
`2025-06-18`, and the spec ships v1 **context-free on `2024-11-05`**. So on the shipped version,
`ctx` is *always absent*. The signature is lying about its own input.

Two acceptable fixes:

```ts
interface CompletionContext { arguments: Readonly<Record<string, string>> }

// Option A — honest optionality (preferred; matches §8):
type Completer = (partial: string, ctx?: CompletionContext) => string[];

// Option B — always pass a frozen empty object so bodies need no guard,
// but the *params* type still marks context optional:
type Completer = (partial: string, ctx: CompletionContext) => string[];
//   …with the handler defaulting:  completer(value, params.context ?? { arguments: {} })
```

Either is fine; what is **not** fine is the spec's current `Record<string,string>` (non-optional,
un-nested — it also drops the `arguments` wrapper the protocol actually uses: the wire shape is
`context: { arguments: {...} }`, not `context: {...}`). Fixing this now prevents every v1
completer body from being written against a shape that can't arrive.

### T-3 (High) — Mandate runtime narrowing of `params`; do not copy the `handleToolCall` cast

§5.2 step 1 ("Parse `ref`, `argument.name`, …") has no narrowing contract, and the repo has no
zod. The existing precedent is the loose cast at `src/index.ts:682`:

```ts
const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
```

That is tolerable for a flat optional bag, but **unsound for `ref`** because `ref` is a
discriminated union — a cast asserts both arms simultaneously. The spec must mandate an explicit
type guard that validates the discriminant and the arm-specific field before any use:

```ts
interface CompleteRequestParams {
  ref: CompletionRef;
  argument: { name: string; value: string };
  context?: CompletionContext;       // 2025-06-18+ only; absent on 2024-11-05
}

function isCompleteParams(p: unknown): p is CompleteRequestParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  const ref = o.ref as Record<string, unknown> | undefined;
  if (!ref || typeof ref !== 'object') return false;
  const okRef =
    (ref.type === 'ref/prompt'   && typeof ref.name === 'string') ||
    (ref.type === 'ref/resource' && typeof ref.uri  === 'string');
  if (!okRef) return false;
  const arg = o.argument as Record<string, unknown> | undefined;
  if (!arg || typeof arg.name !== 'string' || typeof arg.value !== 'string') return false;
  if (o.context !== undefined) {
    const ctx = o.context as Record<string, unknown>;
    if (typeof ctx !== 'object' || ctx === null || typeof ctx.arguments !== 'object') return false;
  }
  return true;
}
```

`isCompleteParams(request.params)` failing → `-32602` (the spec already reserves this for
malformed `ref`/missing `argument`, §5.2 step 2). After the guard, `request.params` is a real
`CompleteRequestParams` and every downstream access is sound. The §9 "clamp `argument.value`
length ≤ 64, reject non-string" rule also belongs in this guard path.

### T-4 (Medium) — Add a "Required TypeScript" section to match Resources §4

The Resources spec carries a normative §4 "Required TypeScript (Type-safety High — T1/T2/T3)"
that lists concrete interfaces and a `noUncheckedIndexedAccess` indexing rule, and the review
outcome made it a **merge gate**. The Completions spec promises (headline + §1) to attack the
same friction "from the input side" and should inherit the same bar. Add a section mandating:
`PromptReference`, `ResourceReference`, `CompletionRef`, `CompletionContext`,
`CompleteRequestParams`, `Completer`, `CompletionResult`/`CompleteResult`, plus the
`isCompleteParams` guard and the exhaustive-`switch` rule. Reuse the Resources §4
`noUncheckedIndexedAccess: false` note verbatim (see T-6).

### T-5 (Medium) — Type the result envelope

§2:41 describes the result shape in prose only. Declare it:

```ts
interface CompletionResult {
  values: string[];     // ≤ COMPLETION_CAP (100)
  total?: number;       // full match count before cap
  hasMore: boolean;     // total > values.length
}
interface CompleteResult { completion: CompletionResult }
```

`hasMore` is **required** by the protocol — typing it optional would let the handler omit it.
`total` is genuinely optional (protocol allows omission), so `?` is correct there.

### T-6 (Medium) — Registry key: one builder, one `Map`, never a bare `[]`

The spec's `CompletionEntry[]` + linear `find` (implied) works but is loose: the composite key
`(refKey, argumentName)` lives in two places (the entry fields and wherever lookup happens),
inviting drift. Prefer a single composite-key `Map` whose key is produced by **one** builder so
the write side and read side cannot disagree:

```ts
const COMPLETION_CAP = 100;
const completerKey = (ref: CompletionRef, argName: string) => `${refKeyFor(ref)}#${argName}`;
const COMPLETERS: Map<string, Completer> = new Map([
  // [`prompt:semak-dakwaan-harga#item`, itemCompleter], … per §4, populated when Prompts land
]);
```

`tsconfig.json:15` has `noUncheckedIndexedAccess: false`. As the Resources spec already
mandated, this makes `Map.get(key)` correctly `Completer | undefined` (good — the miss path is
type-forced), but a bare object/array index `obj[key]` would be silently typed as present
(unsafe). **The spec must repeat the Resources rule: use `Map.get()`/`.find()`, never bare `[]`,
on the registry and on any regex capture group used to parse a `{template}` arg name.** Miss →
`{ values: [], hasMore: false }` (§5.2 step 2 — correctly *not* an error).

(A structured `Map<string /*refKey*/, Map<string /*arg*/, Completer>>` is also acceptable and
avoids string concatenation entirely; either is sound as long as one builder owns the key.)

### T-7 (Medium) — Cap/total/hasMore in one typed helper

§5.2 step 4 ("Truncate to 100, set `total`… `hasMore = total > returned`") is correct logic but
splitting it across prose invites an off-by-one (pre-cap vs post-cap length). The `Completer`
contract is "full matches, pre-cap" (the spec comment says so) — lock that in with one helper so
`total` is always full length and `hasMore` is always derived, never hand-set:

```ts
function capCompletion(full: string[], cap = COMPLETION_CAP): CompletionResult {
  const values = full.slice(0, cap);
  return { values, total: full.length, hasMore: full.length > values.length };
}
```

### T-8 (Low) — Make "completers never call upstream" unrepresentable

§6/§7 correctly forbid per-keystroke upstream calls. Reinforce it in the **type**: declare
`Completer` as **synchronous** (`=> string[]`, not `=> Promise<string[]>`). A sync return type
makes "await an ES round-trip inside a completer" a compile error, not just a guideline. This
also sidesteps the carried-over Resources finding that `callUpstream` returns `Promise<unknown>`
(`src/index.ts:621`) — if completers can't be async, they can't touch that untyped boundary at
all. (If a future dependent completer genuinely needs cached data, it reads the same in-memory
catalogue list the Resources layer already holds — still sync.)

### T-9 (Low) — Type the telemetry field

§5.3 adds a `completionRef` telemetry field but `CallMeta` (`src/analytics.ts:32`) has no slot.
Mirror the Resources spec's `resource?: string` addition:

```ts
export interface CallMeta {
  tool?: string;
  backendStatus?: number;
  resource?: string;       // (from Resources spec)
  completionRef?: string;  // refKey + '#' + argName, e.g. 'prompt:semak-dakwaan-harga#item'
}
```

…and a corresponding blob slot in `McpTelemetryPoint` + `recordMcp`. Spec already (correctly,
§5.3) forbids recording the typed partial value — keep that; only the low-cardinality ref+arg.

### T-10 (Info) — Dead-type risk if landed inert (Q1)

If the machinery lands before Prompts (§3 "inert scaffolding" option), the *types* themselves
are not dead code — unused exported interfaces cost nothing at runtime and `tsc` won't flag
them under the current config (no `noUnusedLocals`). The dead-code risk is in the **runtime
registry data** (`COMPLETERS` populated with completers whose `(ref,arg)` keys don't yet exist)
and the handler `case`, which would advertise a capability with nothing behind it. See Q1 answer.

---

## Open question answers

**Q1 (sequencing / inert machinery — does typing the registry now create dead-type risk?)**
No dead-*type* risk; types are free and `tsc`-invisible under this config. There **is** dead-
*runtime* risk if `COMPLETERS` is populated and the handler `case` advertises `completions: {}`
before any completable surface exists. Recommendation, type-lens: **land the interfaces and the
guard now (they're the contract and cost nothing), but keep `COMPLETERS` empty and gate the
capability advertisement + handler `case` on Prompts shipping.** An empty registry + the
"unknown (ref,arg) → empty result" rule (§5.2 step 2) means an early-advertised capability would
return `{values:[], hasMore:false}` for everything — harmless but pointless, so co-ship per the
spec's own recommendation. The types are not the thing to defer; the wiring is.

**Q2 (`{item_code}` template completer — return codes vs display strings, type-shape angle)**
Type-shape strongly favors **leaving the template uncompletable** (the spec's leaning). MCP
completion `values` are *the literal string inserted as the argument value* (§2 implication). A
`{item_code}` arg is `code-typed` (the URI template wants a number-as-string like `"123"`), so a
sound completer there must return `string[]` of bare codes — useless to a human typing a name.
Returning display strings (`"123 — TEMBIKAI"`) would make `values[i]` **not** a valid argument
value, breaking the protocol's insert-this contract: the type `string[]` is honored but its
*semantic* invariant ("each element is insertable as-is") is violated. There is no type that
expresses "display vs insert" in the MCP completion result, so any display-string completer is an
un-typeable hack. Keep `{item_code}` uncompletable; route name→code through `search_items`. The
name-typed *prompt* `item` arg is the only one whose `string[]` values are both well-typed and
semantically valid.

---

## Spec change requests

1. **Add a normative "Required TypeScript" section** (mirrors Resources §4), declaring:
   `PromptReference`, `ResourceReference`, `CompletionRef`, `CompletionContext`,
   `CompleteRequestParams`, `Completer`, `CompletionResult`, `CompleteResult` — bodies as in
   T-1/T-2/T-3/T-5. Make it a merge gate, as Resources §4 was.
2. **Replace** the §5.2:107 `Completer` line: ctx becomes `ctx?: CompletionContext` (T-2), and
   the return type stays **synchronous** `string[]` (T-8). Drop the bare `Record<string,string>`.
3. **Add** an `isCompleteParams` type-guard mandate to §5.2 step 1, with an explicit "do not
   blind-cast `params.ref` (it is a discriminated union)" warning citing `src/index.ts:682` (T-3).
4. **Add** the exhaustive-`switch(ref.type)` + `never` rule, citing `handleMCP` (`:736`) as the
   model (T-1).
5. **Repeat** the Resources `noUncheckedIndexedAccess: false` / `Map.get`-not-`[]` rule for the
   registry and any template-arg regex capture (T-6), and specify one `completerKey` builder.
6. **Add** the `capCompletion` helper as the single place `total`/`hasMore`/cap are computed (T-7).
7. **Add** `completionRef?: string` to `CallMeta` and a blob slot to `analytics.ts` (T-9).
8. **Note** in §12 Q1 that the *types/guard* land now, the *registry data + capability + case*
   gate on Prompts (T-10).
