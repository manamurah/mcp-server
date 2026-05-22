# MCP3 Prompts — Type Safety Review

**Date:** 2026-05-22
**Persona:** Type Safety Reviewer (TypeScript)
**Scope:** `docs/2026-05-22-spec-mcp-prompts.md` (esp. §10 Required TypeScript), cross-referenced
against `docs/2026-05-22-spec-mcp-completions.md` §6 (`CompletionRef`) and
`docs/2026-05-22-spec-mcp-resources.md` §4 (`MCPResource`/`ResourceContents`). Grounded in
`src/index.ts` (`MCPRequest`/`MCPResponse`, `handleMCP`, `handleToolCall` casts), `src/analytics.ts`
(`CallMeta`), `tsconfig.json` (`strict:true`, `noUncheckedIndexedAccess:false`), `package.json`
(TS ^5.5). Baseline `npx tsc --noEmit` = **clean** (exit 0).

**Review only — no files modified except this one.**

---

## Executive summary

The §10 type sketch is directionally sound and shares the Resources/Completions discipline
(discriminated unions, guards-not-casts, `Map.get` over bare index). Three things lift it from
"good sketch" to "compile-safe contract":

1. **The biggest soundness hole is `render: (args: Record<string,string>) => PromptMessage[]`
   under `noUncheckedIndexedAccess:false`.** TS will type `args['barang']` as `string` even when
   the optional arg is absent at runtime — so the spec's own §6 template (`{if barang}`) is built on
   an access pattern the compiler *cannot* catch as unsafe. This is the one place the type system
   actively lies to the implementer. It must be addressed by typing `render` to receive validated
   args (required present, optional explicitly `string | undefined`), not the raw flat map.

2. **`PromptContent` should stay a closed 2-member union (`text | resource`), not model
   `image`/`audio`.** The spec only emits text + embedded-resource (§6); a closed union gives an
   exhaustive `switch` with a `never` default — the same pattern §6 of the Completions spec mandates
   for `CompletionRef`. Modelling unused image/audio variants adds dead exhaustiveness arms with no
   call site and invites partial handling.

3. **Type drift across the 3 specs is real and avoidable.** `ResourceReference`/embedded-resource
   shape appears in all three (`MCPResource.mimeType` in #1, `CompletionRef`/`ResourceReference` in
   #2, `PromptContent`'s `resource:{uri,mimeType,text}` in #3) with *subtly different field sets*
   (#1 unions the mimeType literal; #3 widens it to `string`). Consolidate the shared protocol types
   into one `src/mcp-types.ts` before the second consumer copies the third declaration.

`render`-as-sync (`=> PromptMessage[]`, not `Promise`) is the right call and is structurally sound —
with one caveat about smuggled async (F4). The arg-validation question is **inherently runtime** (MCP
hands you `Record<string,string>`), but it can be made type-*safe* with a guard + a checker that
narrows the map against the `PromptDef.arguments` before `render` ever runs.

**Overall rating: APPROVE WITH CHANGES.** No Critical defects; one High (F1, the `args[...]` lie) and
two High (F2 closed union, F6 consolidation) that should land before implementation. The contract is
buildable today against `strict:true` without flipping any flag.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| F1 | High | `render(args: Record<string,string>)` lies about optional args under `noUncheckedIndexedAccess:false` | spec §10 L163, §6 L92 | Type `render` to receive validated args; never let the template do bare `args['barang']` |
| F2 | High | `PromptContent` should be a closed `text\|resource` union, not model image/audio | spec §10 L166-168, §2 L32 | Keep 2-member union + exhaustive `switch` with `never` default; document the closure decision |
| F6 | High | Shared protocol types re-declared across 3 specs (drift surface) | §10 L168 vs resources §4 L152, completions §6 L100-105 | Extract `src/mcp-types.ts`; single `EmbeddedResource`/`ResourceContents`/`CompletionRef` source |
| F3 | Medium | No `isGetPromptParams` guard specified; required-arg check left implicit | spec §10 L173-174, §9.2 L143-145 | Mandate `isGetPromptParams(p): p is GetPromptParams` + `validateArgs(def, args)` returning a discriminated result |
| F4 | Medium | Sync `render` purity is enforceable but smuggleable via the *handler*, not the type | spec §10 L172, §13 L204 | Add the spec's static no-`fetch` test AND state the type only bars async *inside* render |
| F5 | Medium | `GetPromptParams.arguments?` optional but template assumes presence | spec §10 L169 | Normalise `arguments ?? {}` at the boundary; validate before passing to `render` |
| F7 | Medium | `PromptContent.resource.mimeType: string` widens the #1 `'application/json'\|'text/markdown'` literal union | spec §10 L168 vs resources §4 L100 | Reuse the literal-union `mimeType` type from `mcp-types.ts` |
| F8 | Low | `PromptArgument` lacks the per-arg "completable" marker the co-location design (§7/§11) needs | spec §10 L159, §11 L179 | Add `complete?: Completer` to `PromptArgument` so the completer hangs off the def (matches completions §3) |
| F9 | Low | CSV `barang` (Q3) has no list type; flat `string` invites split-without-validation | spec §16 Q3 L234-237 | Type a `parseCsvArg(): string[]` helper; cap token count; keep wire type `string` |
| F10 | Info | Version drift: spec says 2.9.0 but resources §3.5 ships 2.7.0 changelog as #1 | prompts §0 L12, resources §3.5 L144 | Reconcile the SERVER_VERSION sequence in the build step (not a type issue) |

---

## Detailed findings

### F1 (High) — `render(args: Record<string,string>)` is unsound for optional args under the repo's tsconfig

`tsconfig.json:15` sets `noUncheckedIndexedAccess: false`. Under that flag, indexing a
`Record<string,string>` yields `string`, **never `string | undefined`** — even for keys that are
absent at runtime. The spec's §6 template explicitly branches on optional args:

> `{if barang}Focus item: {barang}.{else}First resolve the item…{/if}`

So the implementer will write something like:

```ts
render: (args) => {
  const barang = args['barang'];        // typed `string`, but `undefined` at runtime when optional+absent
  const focus = barang ? `Fokus: ${barang}.` : 'Cari item dulu…';
  // ...
}
```

The `barang ?` truthiness check *happens* to save it here, but the type says `string`, so the next
careless author writes `args['barang'].trim()` or interpolates `${args['negeri']}` directly and ships
a runtime `"undefined"` string into the prompt with **zero compiler warning**. This is the single
place in the spec where the type system actively misinforms. The Completions spec §6 anticipated the
sibling of this exact problem ("Use `Map.get`/`.find` … never bare `[]`"); §10 here regresses it for
prompt args.

**Recommendation — type `render` against validated args, not the raw map.** Give each `PromptDef` a
typed arg contract so `render` receives required args as `string` and optional args as
`string | undefined`, forcing the branch:

```ts
// Derive the render-arg shape from the declared arguments.
type RenderArgs = {
  required: Record<string, string>;          // guaranteed present (validated)
  optional: Record<string, string | undefined>;
};
interface PromptDef {
  name: string; title: string; description: string;
  arguments: PromptArgument[];
  render: (args: RenderArgs) => PromptMessage[];   // pure, data-free
}
```

Minimal alternative if `RenderArgs` is too heavy: keep `Record<string,string>` on the wire but pass
`render` a `Readonly<Record<string, string | undefined>>` so optional access is `| undefined` and the
truthiness branch is *compiler-required*. Either way, **forbid bare `args['x']` returning a bare
`string` for optionals** — that is the load-bearing fix. (No tsconfig flip needed; this is achieved by
typing the parameter, not the index.)

---

### F2 (High) — `PromptContent`: keep the closed `text | resource` union; do not model image/audio

§2 L32 notes MCP allows `text`, `image`, `audio`, and embedded `resource`. §10 declares only
`text | resource` — **correct for what we emit** (§6 emits exactly those two). The MCP spec permitting
more variants is not a reason to declare them: we never construct an `image`/`audio` block, so adding
those arms produces dead code in the exhaustive `switch` and tempts a future author to half-implement
them.

Recommend an explicitly *closed* union with an exhaustive consumer, mirroring the `CompletionRef`
`never`-default pattern the Completions spec §6 mandates:

```ts
type PromptContent =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: EmbeddedResource };

// Anywhere PromptContent is consumed (e.g. a serialiser/validator):
function assertContent(c: PromptContent): void {
  switch (c.type) {
    case 'text':     return;
    case 'resource': return;
    default: {
      const _exhaustive: never = c;   // compile error the day someone adds 'image'
      throw new Error(`unhandled content ${(_exhaustive as { type: string }).type}`);
    }
  }
}
```

Document in §10 that the union is **intentionally closed to the two block types this server emits**;
if a future prompt needs image/audio, widening the union flags every consumer via the `never` arm —
which is the desired forcing function. **Recommendation: closed union, text+resource only.**

---

### F3 (Medium) — Specify `isGetPromptParams` guard + a discriminated required-arg checker

§10 L173-174 says "Runtime-narrow `request.params` via an `isGetPromptParams` guard" and "Validate
required args" but gives no signature, so each implementer invents one. The Completions spec §6 set the
bar by *mandating* `isCompleteParams(p: unknown): p is CompleteParams`. Match it. Required-arg
validation against the def is **inherently runtime** (MCP delivers an untyped `Record<string,string>`;
TS cannot know which keys arrived) — but it can be made type-*safe* by returning a discriminated result
that narrows the map:

```ts
function isGetPromptParams(p: unknown): p is GetPromptParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  if (typeof o.name !== 'string') return false;
  if (o.arguments === undefined) return true;
  if (typeof o.arguments !== 'object' || o.arguments === null) return false;
  // every arg value must be a string (MCP arg map is flat string→string)
  return Object.values(o.arguments as Record<string, unknown>).every(v => typeof v === 'string');
}

type ArgCheck =
  | { ok: true; args: Record<string, string> }
  | { ok: false; missing: string[] };

function validateArgs(def: PromptDef, raw: Record<string, string>): ArgCheck {
  const missing = def.arguments
    .filter(a => a.required && (raw[a.name] === undefined || raw[a.name] === ''))
    .map(a => a.name);
  return missing.length ? { ok: false, missing } : { ok: true, args: raw };
}
```

The handler then maps `missing` → `-32602` ("missing required argument: dakwaan") before ever calling
`render`, satisfying §6 L101. Pair this with F1: `validateArgs` is the natural place to also clamp arg
lengths (§12) and partition into required/optional for `RenderArgs`.

---

### F4 (Medium) — Sync `render` enforces purity at the type level, but the *handler* can still smuggle async

`render: (args) => PromptMessage[]` (not `Promise`) is the **right pattern** and *is* sound for what
it claims: you cannot `await` inside a function whose return type is a non-Promise array without a
compile error (an `async` function body is a type mismatch). So no `fetch` result can be awaited inside
`render`. Confirmed good.

The residual gap is not in `render`'s type — it's that `prompts/get` *handler* could (against the
spec's intent) `await` something *around* the `render` call. The type system can't forbid the handler
from being async (it must be, to fit `handleMCP`'s `Promise<MCPResponse>` signature). So §13 L204's
"static-analysis/test check that `render` performs no `fetch`" is **necessary and not redundant** —
keep it, and also lint that the `prompts/get` case does no `fetch`/`callUpstream` between narrowing and
returning. State explicitly in §10: *the sync return type bars async inside `render`; the no-upstream
property of the handler is enforced by test, not by types.*

---

### F5 (Medium) — `GetPromptParams.arguments?` optional vs. template presence assumption

`interface GetPromptParams { name: string; arguments?: Record<string, string> }` (L169) makes
`arguments` optional, but every prompt has at least one required arg (`dakwaan`, `barang`). When a
client sends `prompts/get` with no `arguments` at all, the handler must not pass `undefined` into
`validateArgs`/`render`. Normalise once at the boundary (mirrors `handleToolCall:687`
`const args = params.arguments ?? {}`):

```ts
const params = request.params;
if (!isGetPromptParams(params)) return rpcError(request.id, -32602, 'Invalid prompts/get params');
const args = params.arguments ?? {};   // normalise BEFORE validateArgs
```

This keeps the `?` honest on the wire type while guaranteeing `render` never sees `undefined` for the
whole map.

---

### F6 (High) — Consolidate shared protocol types into `src/mcp-types.ts`

The same embedded-resource / reference shapes are declared independently in all three specs:

- **#1 Resources** §4: `interface ResourceContents { uri: string; mimeType: string; text: string }`
  and `MCPResource.mimeType: 'application/json' | 'text/markdown'` (literal union).
- **#2 Completions** §6: `ResourceReference { type: 'ref/resource'; uri: string }`,
  `CompletionRef`, `CompleteParams`, `CompleteResult`, `Completer`.
- **#3 Prompts** §10: `PromptContent`'s `resource: { uri: string; mimeType: string; text: string }`
  — **structurally identical to #1's `ResourceContents`** but re-typed inline, and with `mimeType`
  *widened* to `string` (see F7).

Three copies of "an embedded resource is `{uri, mimeType, text}`" is exactly the drift class MCP1
flagged (tool/Python-ref drift) and that Completions §3 cited as the reason to co-locate completers.
When #1 later tightens `ResourceContents` (e.g. adds `blob?` for binary), #3's inline copy silently
diverges and the embedded-resource block in a prompt no longer matches what `resources/read` returns —
a client that round-trips a prompt's embedded resource URI back through `resources/read` gets a
shape mismatch no compiler caught.

**Recommendation:** create `src/mcp-types.ts` as the single source for protocol-level types shared by
≥2 of the three features, and have `index.ts`, `prompts.ts`, and the resources/completions handlers
import from it:

```ts
// src/mcp-types.ts
export type McpMimeType = 'application/json' | 'text/markdown';
export interface ResourceContents { uri: string; mimeType: McpMimeType; text: string }
export interface EmbeddedResource extends ResourceContents {}        // the {type:'resource'} payload
export interface PromptReference   { type: 'ref/prompt';   name: string }
export interface ResourceReference { type: 'ref/resource'; uri: string }
export type CompletionRef = PromptReference | ResourceReference;
// MCPRequest/MCPResponse (currently inline in index.ts) also belong here.
```

Then `PromptContent` becomes `{ type: 'resource'; resource: EmbeddedResource }` — no re-declaration.
Keep feature-*local* types (`PromptDef`, `PromptMessage`, `CompleteParams`) in their feature module;
only the genuinely shared protocol primitives move. Add it as a §11 module-structure line:
`src/mcp-types.ts — protocol primitives shared across resources/prompts/completions`.

---

### F7 (Medium) — `mimeType: string` widens the #1 literal union

Sub-finding of F6, called out separately because it's a concrete weakening. §10's
`resource: { ... mimeType: string ... }` accepts any string, but #1 (`MCPResource.mimeType`) and the
methodology embed only ever produce `'text/markdown'` (or `'application/json'`). Using a bare `string`
loses the literal narrowing — a typo'd `'text/markdwon'` compiles. Reuse `McpMimeType` from
`mcp-types.ts` (F6). For the methodology embed specifically the value is always `'text/markdown'`, so
the prompt's embedded-resource block can even be `mimeType: 'text/markdown'`.

---

### F8 (Low) — `PromptArgument` needs a completable marker for the §7/§11 co-location design

§7/§11 commit to completers **co-located with the prompt-argument definition** ("no separate
registry"). But §10's `PromptArgument { name; description; required }` has nowhere to hang the
completer, so `completion/complete` can't resolve `(ref/prompt:<name>, argName)` → completer from the
def alone — forcing exactly the side-registry §3 of the Completions spec rejected. Add the field:

```ts
import type { Completer } from './mcp-types.js';   // (partial: string, ctx?) => string[]
interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
  complete?: Completer;   // co-located completer (completions §3/§4); absent ⇒ not completable
}
```

Resolution becomes `PROMPTS.find(p => p.name === ref.name)?.arguments.find(a => a.name === argName)?.complete`
— `Map.get`/`.find` style (`T | undefined`, miss path type-forced, per completions §6). The advertised
`completions: {}` capability gate (§7) is then "any `PromptArgument.complete` exists" — a structural,
type-checkable predicate rather than a hand-maintained flag.

---

### F9 (Low) — CSV `barang` (Q3) has no list type

See open-question Q3 below. The wire type stays `string` (MCP args are flat string→string), but the
spec should mandate a typed `parseCsvArg(raw: string): string[]` boundary helper with a token cap, so
`basket-bulanan`'s `render` operates on a `string[]` of validated tokens rather than re-splitting ad
hoc in template code.

### F10 (Info) — version drift (not a type issue)

§0 L12 targets `2.9.0` and says "2.7.0 shipped = chain_mom_movers; 2.8.0 reserved for Resources v1",
yet resources §3.5 L144 says its changelog entry is `2.7.0`, and `src/index.ts:74` / `package.json:3`
are both `2.7.0` today. The SERVER_VERSION sequence across #1/#3 needs reconciling in the build step.
Flagged for completeness; outside the type-safety lens.

---

## Open question answers (through the type-safety lens)

**Q3 — `basket-bulanan` `barang`: CSV string vs repeated arg (type-shape angle).**
MCP prompt arguments are a flat `Record<string, string>` — there is **no array arg type** and no
repeated-key semantics on the wire. So a list *must* be a single `string` value. Type it as `string` on
`PromptArgument`/`GetPromptParams` (no change to the wire contract), and add a validated boundary
parser the `render` consumes:

```ts
function parseCsvArg(raw: string, max = 20): string[] {
  const toks = raw.split(',').map(s => s.trim()).filter(Boolean);
  return toks.slice(0, max);   // cap mirrors basket_watch's maxItems:20 (index.ts:382)
}
```

Keep the cap aligned with the existing `basket_watch` tool schema (`minItems:1, maxItems:20`,
`index.ts:380-383`) so the prompt can't instruct the LLM to assemble a basket the tool will reject.
**Verdict: CSV string on the wire, `string[]` after a typed parser — repeated args are not
representable in MCP, so this is the only type-shape available.** (Per-token *completion* of a CSV is a
separate, protocol-level concern flagged in completions §16 Q3; the type shape is unaffected.)

**Q1 — `bahasa` arg: does it complicate render typing?**
Minimally, and cleanly. Add `bahasa` as an **optional** `PromptArgument` (`required:false`) whose value
is constrained to a literal union, validated at the boundary into the render contract:

```ts
type Bahasa = 'ms' | 'en';
function parseBahasa(raw: string | undefined): Bahasa { return raw === 'en' ? 'en' : 'ms'; }
```

Because it's optional, F1 applies directly — do not let `render` read `args['bahasa']` as a bare
`string`; funnel it through `parseBahasa` so the default (`'ms'`) is type-guaranteed and `render`
branches on a `Bahasa` literal, not a free string. This adds **one** narrowing helper, no structural
change to `PromptDef`/`render`. It does *not* complicate the union or the message shape (output language
only affects the text content string). Net: low type cost; the only discipline is "validate the literal,
don't index the raw map" — which F1 already mandates for every optional arg. Leaning BM-default (§16 Q1)
is compatible.

---

## Spec change requests

1. **§10 (F1, must):** Change `render`'s parameter from raw `Record<string,string>` to a validated
   shape where optional args are `string | undefined` (or a `RenderArgs` split). Add a sentence:
   "never read optional args via bare `args['x']` — under `noUncheckedIndexedAccess:false` that types
   as `string` while being `undefined` at runtime."
2. **§10 (F2, should):** Document `PromptContent` as an **intentionally closed** `text | resource`
   union; mandate an exhaustive `switch` with a `never` default at every consumer. Explicitly reject
   modelling `image`/`audio` until a prompt emits them.
3. **§10/§11 (F6, should):** Add `src/mcp-types.ts` to §11 as the single source for shared protocol
   primitives (`ResourceContents`/`EmbeddedResource`, `McpMimeType`, `CompletionRef` family, and the
   `MCPRequest`/`MCPResponse` currently inline in `index.ts`). `PromptContent.resource` imports
   `EmbeddedResource`; #1 and #2 import their refs from here.
4. **§10 (F3, should):** Specify `isGetPromptParams(p): p is GetPromptParams` and a discriminated
   `validateArgs(def, args): {ok:true;args} | {ok:false;missing}` (signatures above), mirroring the
   Completions §6 `isCompleteParams` mandate. Map `missing` → `-32602` before `render`.
5. **§10 (F7, should):** Type `resource.mimeType` as the `McpMimeType` literal union, not `string`.
6. **§10/§7 (F8, nice):** Add `complete?: Completer` to `PromptArgument` so completers co-locate on the
   def (no side registry, per completions §3) and the `completions:{}` capability gate is a structural
   predicate.
7. **§16 Q3 (F9):** State the CSV-string wire type + a `parseCsvArg(): string[]` boundary helper capped
   at 20 to match `basket_watch`.
8. **§9.3 (consistency):** When adding the `prompt` field to `CallMeta` (`src/analytics.ts:32`), type it
   `prompt?: string` and keep it parallel to the existing optional `tool?`/`resource?` (#1) fields — and
   never the filled arg values (matches §9.3 + completions §10).
9. **§0 (F10, non-type):** Reconcile the 2.7.0/2.8.0/2.9.0 version sequence against #1 in the build step.
