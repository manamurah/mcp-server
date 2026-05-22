# MCP2 (Completions) — Architecture Review

**Date:** 2026-05-22
**Persona:** Architecture Reviewer (sequencing/dependency design, coupling, separation of concerns, schema source-of-truth, drift, extensibility, statelessness)
**Scope:** `docs/2026-05-22-spec-mcp-completions.md` (primary); context from `docs/2026-05-22-spec-mcp-resources.md` and `docs/2026-05-22-mcp-enhancement-proposals.md`. Grounding read of `src/index.ts` (`handleMCP` dispatch `:730`, `handleInitialize` `:661`, capabilities `:667` + `:964`, server card `:902`, root manifest `:946`, `PROTOCOL_VERSION` `:75`, `SERVER_VERSION` `:74`), `src/analytics.ts`, `src/changelog.ts`, `wrangler.toml`, `package.json`, the prior MCP1 architecture review, and the sibling Python ref (`manamurah-mcp-2026`) for completion precedent. **Review only — no code changed.**

---

## Executive summary

The spec's headline finding is correct and important: MCP `completion/complete` attaches only to `ref/prompt` and `ref/resource`, never to tools. The proposal (#2) was written against a surface that does not exist, and the spec rightly catches this. That single correction is worth the document.

The **load-bearing decision (Open Q1) — co-ship #2 with #3 and reorder the roadmap to #1 → #3+#2 — is the right architectural call, and I would go further: #2 is not a standalone deliverable at all.** It is the autocomplete *aspect* of #3's prompt arguments. Treating it as its own tier, its own spec, its own version bump, and its own `COMPLETERS` registry manufactures coupling and a drift surface that disappears entirely if completers are folded into the Prompts (#3) work as a property of each prompt argument. The spec gets 80% of the way there ("co-ship") but stops short of the structural conclusion ("co-locate, don't co-ship").

The two material architecture findings are: (1) the **separate `COMPLETERS` registry keyed by stringly-typed `(refKey, argumentName)` is a new drift surface** — it duplicates prompt argument names that live in the (not-yet-written) `PROMPTS` const, repeating exactly the `TOOLS`-vs-Python-ref drift the MCP1 review (A1) flagged as *already live*; and (2) **the spec is built on a data layer (#1's cached catalogue) and a surface layer (#3's prompts) that neither exist in code today** — capabilities at `:667`/`:964` still read `resources: {}`, there is no `RESOURCES` table, no `caches.default`, no `src/methodology.ts`, no prompts. `SERVER_VERSION` is already `2.7.0` but the 2.7.0 Resources feature is not in the tree, so #2's "reuse #1's catalogue" rests on vapor.

Neither is fatal. The completion *machinery* (handler, dispatch case, empty-on-miss semantics, value-length clamp, telemetry field) is well-specified and protocol-faithful, and the security-by-construction argument (public catalogue only) is sound. The fixes are about *where the code lives* and *what it depends on*, not whether it works.

**Overall rating: Medium.** The design will hold, but as written it spends a tier, a spec, and a registry on something that should be a sub-section of #3. The recommendation is to demote #2 from "feature with its own spec" to "Prompts-spec section: argument completers," collapsing the triple coupling to a single co-located one.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| C1 | High | #2 is not a standalone unit; co-*ship* understates it — co-*locate* completers with prompt defs | spec §3, §11, Open Q1 | Fold completers into the #3 Prompts spec as a per-argument property; drop the standalone #2 spec/tier/version. Revise roadmap to #1 → #3 (Prompts **with** built-in arg completion) |
| C2 | High | Separate `COMPLETERS` registry keyed by stringly-typed `(refKey, argumentName)` is a new drift surface | spec §5.2 | Co-locate the completer with each prompt argument definition (`PROMPTS[].arguments[].complete`); derive the lookup, don't hand-maintain a parallel keyed list |
| C3 | High | #2 depends on #1's catalogue + #3's prompts, but **neither exists in code** (caps still `resources:{}` at `:667`/`:964`; no `RESOURCES`/cache/prompts) | `src/index.ts:667`, `:746`, `:964`; spec §4, §6 | State the hard prerequisite explicitly: #2 cannot be implemented until #1 ships its cached catalogue and #3 defines prompt args. Do not begin #2 against an unbuilt data layer |
| A1 | Medium | Triple coupling (data #1 + surface #3 + protocol version) under-managed; spec couples to a moving target | spec §4, §6, §8 | Document each coupling edge and its failure mode; gate completer registration on the prompt arg actually existing (fail-closed) |
| A2 | Medium | Capabilities declared in two sites (`:667`, `:964`); spec only references one and uses stale line numbers | spec §5.1; `src/index.ts:667`, `:964` | Introduce a shared `const CAPABILITIES` (MCP1 review A8 already asked for this) and add `completions:{}` once; refresh line anchors |
| A3 | Medium | Inert-scaffolding option (capability + empty handler now) is offered but is an anti-pattern — advertises a capability with zero completable refs | spec §3 ("inert scaffolding"), Open Q1 | Reject the inert-now path. An advertised `completions:{}` with no `ref/prompt` or `ref/resource` to attach to is a false signal to clients |
| A4 | Medium | WAE blob layout is positional/fixed; adding `completionRef` repeats MCP1 A7 unresolved question | spec §5.3; `analytics.ts:15-29`, `:48-58` | Decide reuse-blob2-as-"primary subject" vs append-new-blob *once* for resources+completions together; document in the `analytics.ts` header to prevent column drift |
| A5 | Low | `{item_code}` template completer (Open Q2) correctly deferred, but rationale is UX not architecture | spec §3, Open Q2 | Confirm the deferral on coupling grounds too: a code-typed completer would couple #2 to the deferred Resources-v2 template AND invert the name→code direction `search_items` owns |
| A6 | Low | Protocol-version bump (Open Q4) deferred cleanly, but "its own review" leaves a latent fork if a dependent completer is wanted | spec §8, Open Q4; `src/index.ts:75` | Keep `PROTOCOL_VERSION` single-sourced (it already is, `:75`); when/if bumping, do it as a server-wide decision, never per-completer — avoid two negotiated versions |
| A7 | Info | Statelessness preserved; in-memory completers add no DO/KV state — good | spec §6, §9 | None — keep completers pure functions over cached lists |

---

## Detailed findings

### C1 — #2 is not a standalone unit; "co-ship" understates the structural truth (High)

The spec's §3 recommendation — "build #2 together with #3 (Prompts)" — is correct, but it frames #2 as a *separate feature that happens to release alongside* #3. The architecture says something stronger: **argument autocomplete is a property of a prompt argument, not a feature in its own right.** A prompt argument named `item` that is name-typed *is the thing being completed*; the completer is its behaviour. There is no coherent version of "#2 ships" that is independent of "a prompt argument exists to complete."

Evidence the spec already half-knows this:
- §2 closing line: "completion `values` are the strings inserted as the argument value… This is the core reason Completions pairs best with Prompts." That is an argument that completion is *intrinsic* to the argument, not adjacent to it.
- §3: the only viable completable surface is prompt args (resource template is "weak" and deferred; tools are impossible). So 100% of #2's value comes from #3.
- §11 build sequence lists #3 as "Pre-req / co-release" — i.e. #2 has no build step that precedes a #3 build step.

When a "feature" has zero surface, zero data, and zero value without another feature, it is not a feature — it is a facet of that other feature. The cost of pretending otherwise: a separate spec, a separate version-bump decision (§ header: "version TBD by sequencing"), a separate tier in the roadmap, a separate `COMPLETERS` registry (C2), and a separate review (this one) — all of which evaporate if completers are a sub-section of the Prompts spec.

**Recommendation:** Demote #2 from a Tier-1 line item with its own spec to a **section of the #3 Prompts spec titled "Argument completion."** The roadmap becomes **#1 Resources (data) → #3 Prompts, which natively include argument completers.** This is also what the MCP1 architecture review anticipated (its §97: "a completions registry keyed off the same catalogue" was described as part of the Prompts/Resources scaffold, not a free-standing tier).

### C2 — Separate `COMPLETERS` registry keyed by `(refKey, argumentName)` is a fresh drift surface (High)

§5.2 proposes:
```ts
interface CompletionEntry { refKey: string; argument: string; complete: Completer }
const COMPLETERS: CompletionEntry[] = [ /* item/state/chain/category */ ];
```
`refKey` is `prompt:<name>` and `argument` is the prompt's argument name — both **strings duplicated from the (future) `PROMPTS` const.** This is the precise failure mode the MCP1 review called out as *already live*: the Worker's `TOOLS` array and the Python ref's models have drifted by a whole tool (`chain_mom_movers`), and README/package.json say "14" while the ref says "15" (and the server card at `src/index.ts:909` even says "15 strongly-typed tools" while `TOOLS.length` is 14 — the drift is in *this* file). A hand-maintained `COMPLETERS` keyed by stringly-typed prompt-name + arg-name will drift from `PROMPTS` the first time a prompt argument is renamed or removed: the completer silently points at a `(prompt, arg)` pair that no longer exists, and an argument added to a prompt silently has no completer. Nothing fails loudly; the autocomplete just quietly stops matching.

**The completer belongs on the argument definition, not in a parallel registry.** When #3 defines its `PROMPTS` const, each argument is an object; give it an optional `complete` field:
```ts
interface PromptArgument { name: string; description: string; required?: boolean; complete?: Completer }
```
`completion/complete` then resolves the prompt by name, finds the argument by name *within that prompt*, and calls its `complete` — no second list. Rename an argument and its completer moves with it because they are the same object. This mirrors the MCP1 A2 verdict ("table-driven; the allowlist *is* the table's key set; no second inline list") applied to prompts. The `(refKey, argumentName)` map should be *derived* from `PROMPTS` at module load if a flat lookup is wanted, never hand-authored.

For the `ref/resource` case (deferred per Open Q2), the same principle: the completer hangs off the `RESOURCES` template entry, not a separate list.

### C3 — #2's stated dependencies do not exist in the codebase yet (High)

The spec repeatedly says "reuse #1" (§4: "backed by the same catalogue data #1 already loads"; §6: "the #1 catalogue… either embedded, Cache-API-cached, or KV"). Grounding check of the live tree:
- `src/index.ts:667` and `:964` — capabilities still `{ tools: {}, prompts: {}, resources: {} }`. The MCP1 spec's mandatory `resources: { listChanged: false }` change is **not applied.**
- `handleMCP` dispatch (`:745`) — `resources/list` still returns `{ resources: [] }`; no `resources/read`, no `resources/templates/list`.
- No `RESOURCES` const, no `RESOURCE_BY_URI`, no `caches.default`, no `src/methodology.ts`. (`grep` finds only the word "catalogue" in tool descriptions and changelog prose.)
- `prompts/list` (`:743`) returns `[]`; no `PROMPTS`, no `prompts/get`.
- `SERVER_VERSION` is `2.7.0` (`:74`) — the version the Resources spec reserves for #1 — yet the 2.7.0 feature is absent. So the version number has run ahead of the feature, which is itself a small contract-integrity smell worth flagging to whoever owns versioning.

So #2 currently rests on a data layer (#1) and a surface layer (#3) that are both unbuilt. This reinforces C1: #2 cannot even be *started* meaningfully. The spec should state, as a hard gate at the top: **"Prerequisite: #1 Resources must have shipped its cached catalogue (`RESOURCES`/cache phase), and #3 Prompts must define the name-typed arguments. Until both land, this work has no data and no surface."** Right now §11 buries this as "Pre-req" line items; it deserves a blocking callout because the spec's own §4 tables assume catalogue lists that do not exist.

### A1 — Triple coupling is real and under-managed (Medium)

#2 couples to three independently-moving things: (a) #1's catalogue data + cache lifecycle, (b) #3's prompt argument *names*, (c) the MCP protocol version. The spec treats each in isolation (§4/§6 for data, §5.2 for names, §8 for protocol) but never assesses the *combination*: a completer is only correct when all three align. Concretely, if #3 renames `item` → `barang`, the §5.2 registry is now wrong (C2); if #1 switches the catalogue from embedded to KV (Phase 2), the completer's backing read changes (acceptable — it reads the same logical list — but the spec should assert the completer reads through #1's accessor, not its own copy); if the protocol bumps for `context.arguments`, a context-free completer must still degrade gracefully. **Recommendation:** add a short "coupling ledger" to the spec naming each edge and its fail-closed behaviour. Folding completers into prompt args (C1/C2) collapses edge (b) entirely — the strongest argument for that restructure.

### A2 — Two capability sites; spec references one with stale anchors (Medium)

§5.1's diff shows only `handleInitialize`. There are **two** capability declarations: `handleInitialize` (`:667`) and the root manifest (`:964`) — both currently `{ tools: {}, prompts: {}, resources: {} }`. The spec's line anchors (632, 929, 701, 867) are all stale (the file has grown; initialize is now `:661`, dispatch `:730`, server card `:902`, manifest `:946`). The MCP1 review (A8) already requested a shared `const CAPABILITIES` so the two sites cannot drift; that fix is still un-done in the tree. **#2 should not add a third hand-edit of capabilities.** Land the shared `CAPABILITIES` const (ideally during #1) and add `completions: {}` to it once. Refresh the anchors before this spec is actioned.

### A3 — Reject the "inert scaffolding now" option (Medium)

§3 and Open Q1 float building "the completion machinery (capability, handler, completer registry) … first as inert scaffolding." Architecturally this is worse than doing nothing: advertising `capabilities.completions: {}` while no `ref/prompt` or `ref/resource` is completable tells every client (Claude.ai, Claude Desktop, ChatGPT) the server supports completion, then returns empty for everything they try. That is a false capability signal — clients may surface an autocomplete affordance that never produces values. Capabilities are a contract; do not advertise one with no backing surface. **Recommendation:** advertise `completions` *only* in the same release that ships at least one completable prompt argument. This is the inverse of inert scaffolding and aligns with C1.

### A4 — WAE blob layout drift (Medium)

§5.3 adds a `completionRef` telemetry field. `analytics.ts` blobs are positional and fixed (`:15-29`, `:48-58`); MCP1's A7 left open whether to reuse `blob2` as a generic "primary subject" or append a new blob. #2 hits the same wall. **Decide once for resources + completions together:** either repurpose `blob2` (`tool`) into a generic subject column carrying tool-name / resource-name / `completionRef`, or append `blob8`. Either way, update the schema comment in `analytics.ts:15-29` in the same PR — the header is the only documentation of the positional layout, and silent column drift there is unrecoverable in WAE SQL.

### A5 — `{item_code}` template completer deferral is right, on coupling grounds too (Low)

Open Q2 leans toward leaving the resource template uncompletable. Correct — and not only for the UX name/code-mismatch reason the spec gives. Adding a code completer would (a) couple #2 to the **deferred** Resources-v2 template (coupling to a thing that does not exist), and (b) invert the name→code resolution direction that `search_items` already owns (§7), duplicating responsibility. Confirm the deferral in the spec on these architecture grounds, not just UX.

### A6 — Protocol bump deferral is clean; guard against a latent fork (Low)

§8/Open Q4 ship context-free on `2024-11-05` and defer the `2025-06-18` bump. `PROTOCOL_VERSION` is single-sourced (`src/index.ts:75`, also referenced in the server card `:926` and manifest `:963`), so a future bump is a one-line change — clean. The latent risk: if a single dependent completer (state→district) is later wanted, do **not** bump the protocol for that one completer in isolation. The protocol version is a server-wide negotiation contract; bump it as a deliberate server-wide decision (re-validated against live clients, as §8 notes) or not at all. Keeping the single source means there is never a per-feature fork — preserve that.

### A7 — Statelessness preserved (Info)

Completers are pure in-memory filters over small cached lists (§6, §9); no Durable Objects, no per-request upstream call (§7 correctly rejects `search_items`-per-keystroke). This keeps the Worker's stateless thin-shim architecture intact. No action.

---

## Open question answers (architecture lens)

**Q1 — Sequencing (the big one).** Co-ship is correct but too weak. **Do not build #2 as a standalone feature at all.** Argument completion is a facet of a prompt argument, not an independent capability — it has no data, no surface, and no value without #1 (data) and #3 (surface), and 100% of its value comes from #3. **Roadmap revision: #1 Resources → #3 Prompts (with argument completers built in as a section of the Prompts spec). Delete #2 as a separate tier/spec/version.** Reject the "inert scaffolding now" alternative (A3) — advertising a capability with nothing to complete is a false signal to clients.

**Q2 — `{item_code}` template completer.** Leave the template uncompletable. Beyond the name/code UX mismatch, a code completer couples #2 to the deferred Resources-v2 template and duplicates the name→code resolution `search_items` owns. The prompt `item` completer (name-typed) is the right surface; the resource template is the wrong one.

**Q4 — Protocol bump to 2025-06-18.** Defer — ship context-free on `2024-11-05`. It is single-sourced (`src/index.ts:75`) so a future bump is clean and low-risk. Architectural rule: if a dependent completer is ever wanted, bump the protocol as a deliberate server-wide decision, never per-completer — never run two negotiated protocol versions.

---

## Spec change requests

1. **Demote #2 from a standalone spec/tier to a section of the #3 Prompts spec** ("Argument completion"); revise the roadmap to #1 → #3-with-completers (C1, Q1). If kept separate for process reasons, retitle to make the dependency unmissable.
2. **Replace the `COMPLETERS` registry with a `complete` field on each prompt argument definition** in #3's `PROMPTS` const; derive any flat lookup, never hand-maintain a parallel `(refKey, argumentName)` list (C2).
3. **Add a blocking "Prerequisites" callout at the top:** #1's cached catalogue and #3's prompt arguments must both exist in code first; today neither does (capabilities still `resources:{}` at `:667`/`:964`; no `RESOURCES`, no cache, no prompts) (C3).
4. **Require a shared `const CAPABILITIES`** (per MCP1 A8) and add `completions:{}` to it once, covering both `:667` and `:964`; refresh all stale line anchors (632/929/701/867 → 661/730/702/746/902/946/964) (A2).
5. **Strike the "inert scaffolding now" option** from §3/Open Q1 — advertise `completions` only when a completable surface ships (A3).
6. **Resolve the WAE blob-layout question once for resources + completions together** and document it in the `analytics.ts:15-29` header (A4).
7. **Add a short coupling ledger** naming the three coupling edges (data/name/protocol) and each fail-closed behaviour (A1).
8. **Flag the version drift** (`SERVER_VERSION` already `2.7.0` while the 2.7.0 Resources feature is absent from the tree) to whoever owns versioning — out of scope for #2 but a contract-integrity smell adjacent to it (C3).
