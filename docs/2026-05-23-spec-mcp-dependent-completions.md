# Spec: Dependent completions (`context.arguments`) for manamurah MCP server

**Status:** Draft (2026-05-23) — brainstormed & approved design; not yet built.
**Created:** 2026-05-23
**Builds on:** [`2026-05-22-spec-mcp-completions.md`](./2026-05-22-spec-mcp-completions.md) §8
(the deferred-protocol-bump note) and the 2.9.0 Completions ship.
**Version impact:** Phase 1 → minor (`2.11.0`); Phase 2 → minor (`2.12.0`). Independent ship gates.
**Protocol version:** introduces `2025-06-18` to the **supported** set via honest negotiation; the
server keeps answering `2024-11-05` clients context-free.

> **Read first.** Dependent completion is the MCP feature where one argument's completer can read
> the values the user has *already* chosen for sibling arguments — e.g. completing a `daerah`
> (district) argument using the `negeri` (state) the user already picked. The mechanism is the
> optional `context.arguments` field on `completion/complete`, added in protocol `2025-06-18`. The
> type rails for this (`CompletionContext`, `Completer(partial, ctx?)`) were already laid down in
> 2.9.0 (`src/mcp-types.ts:103-109`) anticipating this work; they are currently unused.

This is split into **two independently-shippable phases**:

- **Phase 1 — Protocol rails.** Negotiate `2025-06-18`, plumb `context.arguments` through the
  handler to completers, validate it, keep it out of telemetry. **No user-visible behaviour change**
  (no completer reads context yet). Ship gate: live clients still work on both protocol versions.
- **Phase 2 — District consumer.** Embed a `DISTRICTS` dataset, add an optional `daerah` argument to
  the `cari-termurah` prompt, and give it a context-aware completer that filters districts by the
  chosen `negeri`. Ship gate: dependent filtering verified against live clients; national/explicit-
  `negeri` execution unaffected.

**Do not bump the advertised protocol version before Phase 1's negotiation is in place** — the
current `handleInitialize` returns a hardcoded version (the key risk; see §2.1).

---

## 1. Goal & non-goals

**Goal.** Let a `2025-06-18` client narrow an argument's suggestions using sibling arguments already
filled, starting with the highest-value real case in this domain: **district suggestions filtered by
the chosen state**. Do it without breaking `2024-11-05` clients and without adding server-side
session state.

**Non-goals.**
- No per-session storage of the negotiated protocol version (the Worker is stateless; see §2.1).
- No new network/ES calls in the completion path — completers stay pure, in-memory, zero-network.
- No tool-argument completion (MCP has none; completion attaches to `ref/prompt` + `ref/resource`
  templates only — unchanged from the 2.9.0 spec).
- No `"District, State"` display strings (violates the insert-verbatim invariant; see §3.3).

---

## 2. Current state (grounding)

- `PROTOCOL_VERSION = '2024-11-05'` (`src/index.ts:78`), returned **unconditionally** by
  `handleInitialize` (`src/index.ts:671-685`) and advertised in the server card
  (`supportedProtocolVersions: [PROTOCOL_VERSION]`, `src/index.ts:1091`) and root manifest
  (`src/index.ts:1131`).
- `handleCompletion` (`src/index.ts:760-791`) narrows params via `isCompleteParams`
  (`src/index.ts:747-758`), resolves a completer with `resolveCompleter(ref, argument.name)`, calls
  `completer(value)` with **no context**, caps results at 100, and records telemetry
  (`completionRef`, `matchCount` — never the typed value).
- `src/mcp-types.ts:103-109` **already** defines `CompletionContext { arguments: Record<string,
  string> }` and `Completer = (partial: string, ctx?: CompletionContext) => string[]`. Phase 1 wires
  these up; it does not invent them.
- `completion/complete` is rate-limited via the native CF binding `COMPLETION_RL` and telemetry is
  sampled at 10% (`src/index.ts:975-1000`, `:1028`). Unchanged by this work.
- The embedded catalogue (`src/generated/catalogue.ts`) has `ITEMS`, `STATES`
  (stateid/name/slug/region), `CATEGORIES`, `CHAINS` — **no districts**. Phase 2 adds them.

### 2.1 The stateless-Worker constraint (the crux)

The Worker handles each JSON-RPC POST independently. It keys `Mcp-Session-Id`→IP for rate-limiting
but **persists nothing** between an `initialize` call and a later `completion/complete`. So the
completion handler *cannot* look up "which protocol version did this client negotiate." Any design
that says "if the session negotiated 2024-11-05, ignore context" would require a session store
(KV/DO) — rejected as overkill.

**Resolution (approved):** separate the two concerns.
- `initialize` negotiates **honestly** (echo the requested version if supported, else return latest).
- `completion/complete` is **self-gating by field presence**: honour `context.arguments` whenever it
  is present and well-formed; ignore it when absent. A compliant `2024-11-05` client never sends the
  field (→ context-free, identical to today); a `2025-06-18` client sends it (→ dependent filtering).
  Malformed context (present but wrong shape) → `-32602`.

This yields exactly the intended per-version behaviour with zero session state.

---

## 3. Design

### 3.1 Phase 1 — protocol rails

**(a) Version negotiation in `handleInitialize`.**

```ts
const PROTOCOL_VERSION = '2025-06-18';                       // server's preferred/latest
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;

function negotiateProtocol(requested: unknown): string {
  return typeof requested === 'string'
    && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested                       // honour what the client asked for
    : PROTOCOL_VERSION;               // unknown/missing → our latest (MCP SHOULD behaviour)
}
```

`handleInitialize` reads `request.params.protocolVersion`, runs it through `negotiateProtocol`, and
returns that in `result.protocolVersion`. Capabilities are unchanged (`completions: {}` already
advertised — completion support is not itself version-gated; only the *context* facet is).

- Server card `supportedProtocolVersions` becomes the full `SUPPORTED_PROTOCOL_VERSIONS` array
  (`src/index.ts:1091`).
- Root manifest `protocolVersion` reports the preferred `PROTOCOL_VERSION` (`src/index.ts:1131`).

**(b) Type plumbing.** Already present in `src/mcp-types.ts:103-109`. Phase 1 adds the request-side
type so the guard can narrow it:

```ts
interface CompleteParams {
  ref: CompletionRef;
  argument: { name: string; value: string };
  context?: CompletionContext;          // { arguments: Record<string, string> }
}
```

**(c) Handler self-gating + validation.** Extend `isCompleteParams` and `handleCompletion`:

- If `context` is **absent** → behave exactly as today (`completer(value)`).
- If `context` is **present**, it MUST be `{ arguments: <object of string→string> }`. Anything else
  (non-object `context`, non-object `arguments`, non-string values) → `-32602` "Invalid completion
  params: malformed context."
- **Sanitise** the accepted context before passing to the completer:
  - Drop any key whose value is not a string.
  - Clamp each value to 64 chars (same cap as `argument.value`).
  - Cap the number of context entries (e.g. ≤ 16) to bound work.
  - **Unknown keys are kept but harmless** — a completer only reads the sibling names it cares about
    (e.g. the `daerah` completer reads `ctx.arguments.negeri` and ignores the rest). No need to
    reject unknown keys.
- Call `completer(value, sanitisedCtx)`. Completers that ignore `ctx` (all of today's) are
  unaffected — `ctx` is an optional trailing param.

**(d) Telemetry (unchanged invariant, made explicit).** Record only `completionRef`
(`prompt:<name>#<arg>`), `matchCount`, the existing `zeroMatch` signal, and latency. **Never** log
`argument.value` or **any** `context.arguments` value (same sensitivity + high-cardinality reason).
Sampling stays at 10%.

**(e) Phase 1 ship gate.** No completer reads context yet, so behaviour is unchanged for every
existing client. Gate = the live-client revalidation checklist (§6) passes on both protocol versions.

### 3.2 Phase 2 — district consumer

**(a) Embedded `DISTRICTS` dataset.** Add to the embed pipeline (data repo
`scripts/export_catalogue.sql` → MCP `scripts/gen-catalogue.mjs` → `src/generated/catalogue.ts`):

```ts
export interface CatalogueDistrict {
  state: string;        // canonical state name, matches STATES[].name
  state_slug: string;   // matches STATES[].slug
  district: string;     // canonical district name — the value find_cheapest's `district` expects
  district_slug: string;
}
export const DISTRICTS: readonly CatalogueDistrict[] = [ /* generated */ ];
```

- **Source:** the data repo's district dimension — `district_urbanisation`
  (stateid/districtid/state/district) joined to the states lookup, or `prices_district_weekly`'s
  distinct (state, district) pairs. Restrict to districts that actually appear in recent price data
  (same recent-active window the rest of the catalogue uses) so suggestions match queryable values.
- **Public-data-only invariant** (carried from the completions spec §9): districts are public
  geographic labels already exposed via `find_cheapest`/`nearby_premises`. The CI public-data test
  extends to cover `DISTRICTS`.
- Bundle-size note: ~150-200 districts × ~4 short fields is negligible vs the existing item embed.

**(b) Prompt surface.** Add an **optional** `daerah` argument to `cari-termurah` (its `render`
already issues a single `find_cheapest` call, and `find_cheapest` accepts an exact `district`
filter). `negeri` stays optional; `daerah` is optional. When `daerah` is supplied, `render` instructs
the model to pass it as the `district` filter (scoped within `negeri` when both are present).

**(c) `daerah` completer semantics (context-aware).**

```ts
const districtCompleter: Completer = (partial, ctx) => {
  const negeri = ctx?.arguments?.negeri;          // sibling value, may be absent
  const pool = isValidState(negeri)
    ? DISTRICTS.filter(d => foldEq(d.state, negeri))   // filtered to that state
    : dedupeByName(DISTRICTS);                          // global de-duped fallback
  return fuzzyMatch(partial, pool.map(d => d.district)); // prefix→substring, ASCII-fold (as itemCompleter)
};
```

- **Always returns bare canonical district names** — directly insertable as the `daerah` value and
  matchable by `find_cheapest`. Never `"District, State"` (see §3.3).
- **Valid `ctx.arguments.negeri`** → only that state's districts.
- **Missing/invalid `negeri`** → global, **de-duplicated by district name** (so a name appearing in
  two states shows once). Bare names; matched by the same fuzzy logic as `itemCompleter`/
  `stateCompleter`.
- Reuses the existing `fold`/prefix-then-substring matching and the 100-cap in `handleCompletion`.
- Co-located on the `daerah` `PromptArgument.complete`, like every other completer (no registry).

**(d) Ambiguity rule (must be in the prompt text).** When the global fallback is used (no `negeri`),
a bare district name can be **ambiguous across states**. `cari-termurah`'s `render` MUST instruct: if
a `daerah` is given without a `negeri` and that district name exists in more than one state, either
ask the user for the `negeri` or report results nationally and state the ambiguity — never silently
pick one state. Dependent completion is a **UX enhancement, not a correctness dependency**: prompt
execution stays correct nationally or with an explicit `negeri` regardless of what the client
completed.

**(e) Phase 2 ship gate.** Dependent filtering verified against live clients that send context (§6),
embed regenerated + committed, and `cari-termurah` still renders correctly with `daerah` absent.

### 3.3 Why bare names only (invariant)

The completions spec §11 is normative: **`completion/complete` `values` are inserted verbatim into
the argument field.** A value like `"Hulu Langat, Selangor"` would be typed literally into `daerah`,
and `find_cheapest`'s exact district-name filter would then fail to match. So the completer returns
only canonical district names. Cross-state duplicate names are tolerated because `find_cheapest`
scopes by `negeri` at query time (and with no `negeri` the result is national by definition) — the
ambiguity is handled at execution (§3.2d), not by corrupting the inserted value.

---

## 4. Type guard & error surface (Phase 1)

`isCompleteParams` extends to validate optional `context`:

| Input | Result |
|---|---|
| no `context` | accepted, context-free (today's behaviour) |
| `context: { arguments: { negeri: "Selangor" } }` | accepted, sanitised, passed to completer |
| `context` not an object | `-32602` malformed context |
| `context.arguments` not an object | `-32602` malformed context |
| `context.arguments` has non-string value | that key dropped (sanitise), rest accepted |
| unknown sibling key (e.g. `context.arguments.foo`) | kept, ignored by completers |
| `> 16` context entries | excess dropped after a deterministic cap |

Unknown `(ref, arg)` still returns an **empty** completion result, not an error (spec §5.2,
unchanged). Rate-limit trip still returns an empty set, not an error (unchanged).

---

## 5. Testing

**Phase 1 (`tests/`):**
- `initialize` with `protocolVersion: '2025-06-18'` → echoes `2025-06-18`.
- `initialize` with `protocolVersion: '2024-11-05'` → echoes `2024-11-05`.
- `initialize` with an unknown/missing version → returns latest `2025-06-18`.
- `completion/complete` **without** `context` → unchanged behaviour (existing tests stay green).
- `completion/complete` **with** well-formed `context` on a context-free completer → context ignored,
  same results (proves backward-compatibility of existing completers).
- malformed `context` (non-object; `arguments` non-object) → `-32602`.
- sanitise: non-string context value dropped; value clamped to 64 chars; entry cap enforced.
- telemetry assertion: no `argument.value` and no `context.arguments` value reaches the recorded
  payload (extend the existing "no value in telemetry" test).
- server card `supportedProtocolVersions` lists both versions; root manifest reports preferred.

**Phase 2:**
- `negeri=Selangor`, partial `"hu"` → includes `Hulu Langat`, excludes other states' districts.
- `negeri=Pulau Pinang`, partial `"se"` → only Penang districts (e.g. `Seberang Perai *`).
- **no context**, partial `"hu"` → global de-duped names including `Hulu Langat` (national fallback).
- duplicate-name district with no `negeri` → appears once (de-dupe), and the render text carries the
  ambiguity instruction (assert the instruction string is present).
- `render` performs **no fetch** (extend the existing purity test to `cari-termurah` + `daerah`).
- result set capped at 100.
- tool-name parity: `cari-termurah` still references only real tools.
- public-data invariant test extended over `DISTRICTS`.

Test runner unchanged: `pnpm test` = `node --import tsx --test tests/*.test.ts`; `npm run build` =
`tsc --noEmit`.

---

## 6. Live-client revalidation checklist (both ship gates)

Because the advertised protocol version changes, manually revalidate the real clients after deploy
(the completions spec §8 mandate). For each of **Claude.ai (web)**, **Claude Desktop**, **ChatGPT
(if connected)**:

1. Server connects; `initialize` succeeds; the negotiated `protocolVersion` is sensible (echoes the
   client's request when it's one we support).
2. `tools/list`, `prompts/list`, `resources/list` still populate.
3. Existing completions still fire (item/state) — Phase 1 must not regress them.
4. (Phase 2) typing in `daerah` after choosing a `negeri` returns that state's districts; with no
   `negeri`, returns the global fallback.
5. No client errors/disconnects on the bumped version.

Deploy is manual (`npm run deploy`, no CI). Roll back by reverting `PROTOCOL_VERSION` if a client
breaks on `2025-06-18`.

---

## 7. Out of scope

- Resource-template (`ref/resource`) dependent completion — `resolveCompleter` still returns
  `undefined` for `ref/resource` (no completable templates exist; the `{item_code}` template stays
  uncompletable per completions spec §11).
- Dependent completion on `barang` (the embed has no per-state item-availability data; would need
  network — violates the zero-network completer invariant).
- Any new tool, or any change to `find_cheapest`'s schema.

---

## 8. File-change inventory

**Phase 1 (≈ 2.11.0):**
- `src/index.ts` — `PROTOCOL_VERSION` → `2025-06-18`; add `SUPPORTED_PROTOCOL_VERSIONS` +
  `negotiateProtocol`; `handleInitialize` negotiates; `isCompleteParams` validates `context`;
  `handleCompletion` sanitises + passes `ctx`; server card / root manifest version fields.
- `src/mcp-types.ts` — add the request-side `CompleteParams.context?` (the `CompletionContext` /
  `Completer(ctx?)` types already exist).
- `tests/prompts.test.ts` (+ a small `tests/protocol.test.ts` if cleaner) — Phase 1 tests.
- `package.json`, `src/index.ts` `SERVER_VERSION`, `CHANGELOG.md`, `src/changelog.ts` — version bump.

**Phase 2 (≈ 2.12.0):**
- data repo `scripts/export_catalogue.sql` — emit the districts query.
- MCP `scripts/gen-catalogue.mjs` + `scripts/catalogue.json` — include `DISTRICTS`.
- `src/generated/catalogue.ts` — regenerated `DISTRICTS` + `CatalogueDistrict` type.
- `src/prompts.ts` — `districtCompleter`; add optional `daerah` arg to `cari-termurah`; render text
  for the district filter + ambiguity instruction; `MAX_LEN` entry if needed.
- `tests/prompts.test.ts` — Phase 2 tests.
- `README.md`, `package.json` description, `CHANGELOG.md`, `src/changelog.ts` — docs + version bump.

---

## 9. References

- MCP completion spec (with `context`):
  <https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion>
- Completions design reference: [`2026-05-22-spec-mcp-completions.md`](./2026-05-22-spec-mcp-completions.md)
  (§8 protocol bump, §9 security, §11 insert-verbatim invariant).
- Code anchors: `PROTOCOL_VERSION` `src/index.ts:78`; `handleInitialize` `:671`; `handleCompletion`
  `:760`; server card `:1091`; root manifest `:1131`; completion types `src/mcp-types.ts:103-109`.
