# Security Review — MCP Completions spec (`completion/complete`)

**Date:** 2026-05-22
**Persona:** Security Auditor
**Type:** REVIEW (findings only — no code changed)
**Target:** `docs/2026-05-22-spec-mcp-completions.md`
**Context:** `docs/2026-05-22-spec-mcp-resources.md` (dependency #1), `docs/2026-05-22-mcp-enhancement-proposals.md` (#2)
**Grounding read:** `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`
**Spec verified against:** MCP completion utility spec, protocol `2025-06-18` (fetched 2026-05-22).

---

## Executive summary

The Completions design is **low-risk by construction** and the spec is unusually
security-aware: it already mandates input clamping, telemetry value-suppression,
and an in-memory-only completer path that keeps every keystroke off Elasticsearch.
That removes the two scariest classes of risk for a per-keystroke endpoint —
upstream amplification (no ES round-trip per character) and info disclosure (the
completers only filter the same public catalogue lists that Resources #1 already
serve verbatim). The MCP protocol claims in the spec (ref types, no `ref/tool`,
`context` arrives in 2025-06-18, error codes, capability shape) all check out
against the live spec.

What's missing is **defense-in-depth around the per-request inputs**, because the
current Worker has *zero* in-process validation — it forwards whatever it parses.
Completion adds a new handler that must validate `ref`, `argument`, and (later)
`context.arguments` itself, since there is no schema layer behind it the way
tools have JSON-Schema-ish hints (which are advisory anyway — `callUpstream`
does no validation). The spec's `argument.value ≤64 / reject non-string` clamp is
necessary but **not sufficient**: it omits `argument.name` bounds, `ref.uri`/`ref.name`
bounds, `context.arguments` key/value bounds and count, and a global
serialized-body cap. None of these are exploitable for data loss (no DB, no auth,
no SSRF on this path because completers never fetch), so they sit at Medium/Low —
but on a per-keystroke endpoint, unbounded `context.arguments` is a cheap CPU/GC
amplifier worth closing before the protocol bump enables it.

**Overall risk rating: Low.** No Critical/High. The findings are defense-in-depth
hardening that should be folded into the handler spec before implementation, plus
two forward-looking guards (info-disclosure governance as prompts grow; bounding
`context.arguments` ahead of the 2025-06-18 bump).

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| SEC-C1 | Medium | `context.arguments` unbounded — keystroke-rate CPU/GC amplifier | spec §5.2, §8 | Bound key count (≤16), key length (≤64), value length (≤64); ignore unknown keys; reject non-string values. Land *with* the 2025-06-18 bump, not after. |
| SEC-C2 | Medium | Validation surface narrower than stated — `argument.name`, `ref.name`, `ref.uri` unbounded | spec §5.2, §9 | Clamp/validate all string inputs, not just `argument.value`. Cap `ref.name`/`ref.uri` (≤256), `argument.name` (≤64). Add a global request-body byte cap at the `/mcp` entrypoint. |
| SEC-C3 | Medium | Info-disclosure "satisfied by construction" is a point-in-time claim with no guardrail | spec §4, §9 | Add a normative rule: a completer MAY only read from the §2 fixed catalogue lists; **never** premise-level, geo-precise, or any non-public field. Make it a CI/test invariant so future prompts can't widen it. |
| SEC-C4 | Medium | Completion shares the upstream IP budget; no protection for legit `/mcp` traffic | spec §9, Open Q5 | Recommend a **separate in-Worker token bucket scoped to `completion/complete`** (e.g. 30 req / 10s / IP) so a fast typist can't starve real tool calls. See Q5 answer. |
| SEC-C5 | Low | Unknown `(ref,arg)` returns empty success — correct, but confirm it never fetches/errors | spec §5.2 step 2, §10 | Keep the empty-`{values:[]}` behaviour; add a test asserting unknown `(ref,arg)` causes **zero** upstream calls and no exception (oracle-avoidance + cost guard). |
| SEC-C6 | Low | `ref/resource` URI is not validated against the known template set | spec §5.2 | For `ref/resource`, require the `uri` to match a registered URI-template literally (Map lookup, not interpolation) — mirror the Resources SSRF guard. Unmatched → empty result, never a fetch. |
| SEC-C7 | Low | Protocol bump to 2025-06-18 changes negotiation for all methods, not just completion | spec §8, Open Q4 | Defer the bump (ship context-free on 2024-11-05). When bumped, re-validate `initialize` against Claude.ai/Desktop/ChatGPT and ship SEC-C1 in the same PR. See Q4 answer. |
| SEC-C8 | Info | `completions: {}` capability surface is inert beyond the handler | spec §5.1 | No action — adding the capability only advertises one new method; no new fetch path, auth, or state. Confirmed against `src/index.ts`. |
| SEC-C9 | Info | Telemetry value-suppression is correct; watch `completionRef` cardinality | spec §5.3 | Keep "never the typed value." Ensure `completionRef` is the static `prompt:<name>#<arg>` (bounded set), not anything derived from user input — otherwise WAE index cardinality blows up. |

---

## Detailed findings

### SEC-C1 (Medium) — `context.arguments` is an unbounded keystroke-rate amplifier
**Evidence.** The protocol fetch confirms `context.arguments` is *"a mapping of
already-resolved argument names to their values"* — an arbitrary client-supplied
object. The spec (§8) defers `context` to the 2025-06-18 bump but says nothing
about bounding it. The current Worker does no input validation anywhere
(`callUpstream` at `src/index.ts:616` forwards args as-is; tool `inputSchema`
hints are never enforced server-side). A client sending `completion/complete`
once per keystroke with a multi-megabyte `context.arguments` object forces the
Worker to JSON-parse and iterate it every keystroke — pure CPU/GC burn on the
Worker (paid wall-clock), with no upstream involved to absorb or rate-limit it.
**Recommendation.** Before reading `context`: cap key count (≤16), reject
non-string values, clamp each key (≤64) and value (≤64), and ignore keys not in
the completer's known dependency set. This MUST land in the same PR as the
2025-06-18 bump — never enable the field without the bound.

### SEC-C2 (Medium) — validation surface narrower than the spec states
**Evidence.** §9 mandates only "clamp `argument.value` length (≤64), reject
non-string, malformed `ref` → -32602." But `argument.name`, `ref.name` (prompt),
and `ref.uri` (resource) are equally client-controlled and equally unbounded.
A 1 MB `ref.name` or `argument.name` would be parsed and string-compared per
keystroke. There is also no global cap on the JSON-RPC body — the entrypoint
(`src/index.ts:807`) does `request.json()` with no size guard, so this gap is
pre-existing but completion is the first endpoint where it's hit at keystroke
rate.
**Recommendation.** Validate *all* completion string inputs, not just
`argument.value`: `argument.name` ≤64, `ref.name`/`ref.uri` ≤256, reject
non-strings → -32602. Add a defensive body-size cap (e.g. reject `Content-Length`
> 16 KB on `/mcp`) — cheap, protects every method.

### SEC-C3 (Medium) — info-disclosure "by construction" needs a standing guardrail
**Evidence.** §9 asserts "no information disclosure … satisfied by construction"
because completers read only the §2 catalogue. The MCP spec is explicit:
implementations **MUST** *"Control access to sensitive suggestions"* and
*"Prevent completion-based information disclosure."* The claim is **true today**
but is a point-in-time property: completers are wired per `(ref, argumentName)`
(§5.2), and §11 explicitly anticipates *new prompts* arriving. The day someone
adds a prompt arg like `premise` or `outlet` and points a completer at
premise-level data, the "by construction" guarantee silently breaks — completion
would then leak the existence/spelling of individual premises (a finer grain than
any public tool returns) keystroke by keystroke, which is exactly the disclosure
oracle MCP warns about.
**Recommendation.** Promote the claim to a **normative invariant**: completers
may bind only to the six §2 fixed catalogue lists (items/states/categories/
chains, plus their names). No premise-level, lat/long-precise, or non-public
field may ever back a completer. Enforce with a test that fails if a `COMPLETERS`
entry references anything outside the catalogue source set.

### SEC-C4 (Medium) — completion shares and can monopolise the IP budget
**Evidence.** §9: "the upstream 120 req/60s/IP limit covers `/mcp`, but a fast
typist on one resource could dominate it." That is the real risk: the limit is
shared, so an undebounced or scripted client emitting completion requests per
keystroke can consume the **entire** 120/60s window, starving that IP's
legitimate `tools/call` traffic (a 429 on a price query the user actually wanted).
Note the limit is enforced *upstream* (`src/index.ts:9`, root manifest
`rate_limit` field) — but completion never reaches upstream (in-memory), so
**completion requests may not even be counted by the upstream limiter** depending
on where it sits. If completion is uncounted, the CPU-burn is unbounded; if it is
counted, it cannibalises the tool budget. Either way the shared budget is wrong
for a per-keystroke method.
**Recommendation.** Add a dedicated in-Worker counter for `completion/complete`
(see Q5). This is the one finding I'd push hardest on, because it's the difference
between "completion degrades only itself" and "completion degrades the whole
server for that IP."

### SEC-C5 (Low) — unknown `(ref,arg)` empty-success is right; lock it with a test
**Evidence.** §5.2 step 2 returns `{values:[], hasMore:false}` for unknown
`(ref,arg)` rather than an error. This is correct (avoids a probing oracle that
distinguishes "valid completable arg with no matches" from "unknown arg") **and**
it is the cost guard. The risk is a future refactor accidentally routing the
unknown case through a fetch.
**Recommendation.** Keep as-is; add the §10 test "no upstream/ES call fires
during a completion" and extend it to explicitly cover the unknown-`(ref,arg)`
branch.

### SEC-C6 (Low) — validate `ref/resource` URI against the registered template set
**Evidence.** Resources #1 already established the SSRF guard: never derive an
upstream path from an inbound URI, always Map-lookup a literal (Resources spec
§3.2, SEC-1/SEC-2). Completion's `ref/resource` carries a `uri` *template* the
client picks; the completion handler should treat it the same way — match it
against the registered template keys, not interpolate it.
**Recommendation.** For `ref/resource`, resolve via the `(refKey, argumentName)`
registry where `refKey` is the *literal* registered template string. Unmatched →
empty result. No completer path should ever construct a fetch URL from the inbound
`uri`. (Today this is moot — v1 has no completable resource template — but bake
the rule in so it holds when the v2 `{item_code}` template lands.)

### SEC-C7 (Low) — protocol bump is a server-wide negotiation change
**Evidence.** §8 correctly scopes the bump as "its own review." `PROTOCOL_VERSION`
(`src/index.ts:75`) is advertised in `initialize` (`:666`), the server card
(`:926`, `supportedProtocolVersions`), and gates client behaviour for *every*
method — not just completion. Bumping to 2025-06-18 changes the negotiated
contract for tools/resources/prompts too. The security implication is low
(2025-06-18 is additive over 2024-11-05 for this server's surface) but the
*compatibility* risk is real: a client that only speaks 2024-11-05 must still
negotiate cleanly.
**Recommendation.** Hold at 2024-11-05; ship context-free completers (Q4 answer).
When a dependent completer genuinely justifies the bump, do it in a dedicated PR
with the SEC-C1 `context.arguments` bounds included and re-validation against
Claude.ai / Claude Desktop / ChatGPT.

### SEC-C8 (Info) — capability surface is contained
Adding `completions: {}` to `capabilities` (§5.1, mirroring `src/index.ts:667`,
`:964`, `:926`) only advertises one new JSON-RPC method. It introduces no new
fetch authority, no auth, no shared state (the Worker is stateless,
`src/index.ts:13`). Attack surface = the single new handler. No action.

### SEC-C9 (Info) — telemetry privacy correct; guard `completionRef` cardinality
§5.3 records `completionRef` (`prompt:<name>#<arg>`) and explicitly **never** the
typed value — matching `src/analytics.ts`'s existing "arguments never recorded"
posture (`analytics.ts:11-13`). Correct. One caveat: WAE `index1` cardinality
(`analytics.ts:91`) must stay bounded — ensure `completionRef` is composed only
from the *static* registered ref/arg names (a small fixed set), never anything
derived from `argument.value` or `ref.uri`, or the dataset index cardinality
explodes.

---

## Open question answers

**Q5 — rate-limit posture (shared upstream vs in-Worker counter).**
**Recommendation: add a separate, looser in-Worker limiter for
`completion/complete` — do not rely solely on the shared upstream 120/60s.**
Rationale: completion is the only per-keystroke method, and it never touches
upstream, so the upstream limiter either doesn't see it (→ unbounded Worker CPU)
or counts it against the tool budget (→ a fast typist 429s their own price
queries). A small per-IP token bucket scoped to completion (start ~30 req/10s/IP,
tune on telemetry) isolates the blast radius: completion can only degrade itself,
never tool calls. Implementation note — the Worker is stateless, so a precise
counter needs a Durable Object or KV (cost/complexity); a pragmatic v1 is a
coarse per-isolate in-memory bucket (best-effort, resets on cold start) plus the
existing upstream limit as backstop, with the WAE `completionRef` telemetry
watched for abuse. If telemetry shows no abuse after launch, the in-memory bucket
can stay; if it shows distributed abuse, escalate to DO-backed. The spec's
"lean on shared limit, add a counter only if telemetry shows abuse" is too
permissive given the keystroke cadence — ship at least the coarse in-memory
guard from day one.

**Q4 — protocol bump to 2025-06-18 (security implications).**
**Recommendation: do NOT bump now; ship context-free on 2024-11-05.** Security
implications of bumping: (1) it changes `initialize` negotiation for the whole
server, so all live clients (Claude.ai, Desktop, ChatGPT) must be re-validated —
a compatibility risk, low security risk. (2) Enabling `context.arguments` *opens
a new unbounded client-controlled input* (SEC-C1) processed at keystroke rate;
the bump and that input-bounding MUST ship together or you create the amplifier
without the guard. (3) No new secret/auth/SSRF exposure — 2025-06-18 is additive
for this server's read-only surface. Net: the bump is safe *if* gated behind a
dedicated PR that includes SEC-C1 bounds and client re-validation, but there's no
security reason to do it for v1, and good reason (SEC-C1) not to until a dependent
completer actually needs it.

---

## Spec change requests

1. **§9 — broaden the validation MUST** beyond `argument.value`: clamp/validate
   `argument.name` (≤64), `ref.name`/`ref.uri` (≤256), reject all non-string
   inputs → -32602, and add a `/mcp` request-body byte cap (≤16 KB). (SEC-C2)
2. **§5.2 / §8 — bound `context.arguments`** the moment it's enabled: ≤16 keys,
   per-key ≤64, per-value ≤64, string-only, unknown keys ignored. Tie this to the
   2025-06-18 bump PR. (SEC-C1, Q4)
3. **§4 / §9 — make info-disclosure a normative invariant**, not a "by
   construction" assertion: completers may bind only to the six §2 fixed
   catalogue lists; no premise-level/geo-precise/non-public field, ever. Add a
   test/CI invariant. (SEC-C3)
4. **§9 / Open Q5 — change the rate-limit recommendation** from "rely on shared
   limit" to "ship a dedicated completion limiter (coarse in-memory v1, DO/KV if
   abuse appears)." (SEC-C4)
5. **§5.2 — add a `ref/resource` literal-template-match rule** mirroring the
   Resources SSRF guard: resolve via the registry, never interpolate the inbound
   `uri` into a fetch. (SEC-C6)
6. **§10 — add tests:** unknown `(ref,arg)` fires zero upstream calls; value/name/
   ref length clamps enforced; `context.arguments` bounds enforced (when present);
   completer-source invariant (no non-catalogue field). (SEC-C3, SEC-C5)
7. **§5.3 — note the `completionRef` cardinality constraint**: composed only from
   static registered ref/arg names, never user input. (SEC-C9)
