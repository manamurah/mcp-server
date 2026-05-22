# Security Audit — MCP Resources for manamurah MCP server

**Date:** 2026-05-22
**Persona:** Security Auditor (review only — no code or spec changes made)
**Scope reviewed:**
- `docs/2026-05-22-spec-mcp-resources.md` (primary target)
- `docs/2026-05-22-mcp-enhancement-proposals.md` (parent context)
- Grounding (read-only): `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`, `tsconfig.json`, `README.md`

---

## Executive summary

The proposed Resources feature is **architecturally low-risk** — it is additive, stays public/read-only over already-public government data, advertises no subscriptions, and (correctly) keeps the Worker credential-free. The spec already names the right defence (§3.2: "fixed allowlist… never interpolate the raw URI into a fetch"). However, the **single most security-relevant decision in the spec — the `manamurah://item/{item_code}` URI template — is left under-specified on exactly the dimension that matters: how `{item_code}` is validated and how it is concatenated into the upstream path.** The existing `callUpstream` (`src/index.ts:587`) interpolates its path segment **without `encodeURIComponent`**, and its query builder uses `String(v)` with no per-key validation. Today that is safe only because every value reaching it is pre-validated by the static `TOOLS` allowlist and JSON-Schema-typed args. Reusing that same code path for a *templated* resource without an explicit "extract → strictly validate → numeric-coerce → fixed path map" contract would introduce a real path-injection/SSRF surface. There is no exploitable issue **today** (no code is written), so this is a **design-stage High** on the template path and Medium/Low elsewhere.

**Overall risk rating: Medium** (drops to **Low** if the template is deferred or the §3.2 allowlist + the SEC-1 validation contract are made mandatory and testable before merge).

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| SEC-1 | High | URI-template `{item_code}` validation + upstream interpolation contract is unspecified; reuses an unencoded path-builder | spec §2 (templates), §3.2 step 3, §5; `src/index.ts:587`,`:603-609` | Mandate: regex-validate `{item_code}` as `^[0-9]{1,7}$`, coerce to int, reject otherwise with `-32602`; build upstream path from the validated integer only (never the raw URI). Add a "no raw URI reaches fetch" SSRF test (spec §7 already gestures at this — make it cover the template). |
| SEC-2 | Medium | `resources/read` allowlist relies on a guarantee that exists only in prose | spec §3.2 step 1 | Specify the allowlist as code-enforced: an exact-match `Map<uri, upstreamPath>` for fixed resources + one explicit template matcher. No `RESOURCES.find(...)`-then-`fetch(uri)` shortcut. |
| SEC-3 | Medium | Resource content is untrusted agent context (resource poisoning) — trust chain ES→upstream→Worker→client not addressed | spec §1, §2 (`docs/methodology`, `catalogue/items` names/`name_en`) | Add a "resource content trust" note: catalogue text originates from gov data + curated methodology; Worker must not transform/augment it; flag that free-text fields (`name`, `name_en`) flow verbatim into agent context. Prefer embedded (curated, version-controlled) methodology over live proxy (SEC-7). |
| SEC-4 | Medium | DoS / payload-size: only `catalogue/items` is budgeted; `resources/read` is otherwise unbounded; template enables enumeration | spec §6, §7; upstream rate-limit 120 req/60s | Apply a hard serialized-byte ceiling to **every** resource (not just items); document that the upstream IP rate-limit also governs `resources/read`; note template reads count against the same budget (enumeration is rate-limited, not free). |
| SEC-5 | Low | CORS `*` extended to resources | `src/index.ts:738-742`; spec (implicit) | Acceptable — data is public, no credentials, no cookies. Confirm explicitly in spec that `*` is intentional for resources and that no `Access-Control-Allow-Credentials: true` is ever added. |
| SEC-6 | Low | New upstream endpoints widen the attack surface / envelope-conformance + auth posture must match existing tools | spec §5 (`catalogue/*`, `meta/latest-week`, `catalogue/item/{code}`) | Require new `/api/v2/mcp/*` endpoints to: stay read-only, return only public reference data, enforce the same IP rate-limit, and reject malformed `item_code` server-side too (defence in depth — don't trust the Worker as sole validator). |
| SEC-7 | Low | Methodology embed-vs-proxy is a tamper/trust decision | spec §5, §9 Q3 | Recommend **embed** (like `changelog.ts`): version-controlled, reviewable in PR, no live-tamper window, no extra round-trip. A live `/about` proxy makes agent-facing guidance mutable outside code review. |
| SEC-8 | Info | Telemetry `resource` field is non-sensitive but confirm no URI args/payloads logged | spec §3.3; `src/analytics.ts:11-13`,`:91` | Fine as specified (URIs are allowlisted, non-PII). Keep the existing "no args/payloads" invariant; the resolved resource name/template id is safe to record. |
| SEC-9 | Info | Server card / root manifest will now advertise resources to crawlers | spec §3.4; `src/index.ts:867`,`:911` | No secret leakage risk (all public). Just ensure the manifest `resources` array does not embed full catalogue *bodies* (only descriptors) to avoid bloating an uncached root response. |

---

## Detailed findings

### SEC-1 (High) — Template `{item_code}` validation + the unencoded path-builder

**Evidence.** `callUpstream` builds the upstream path by raw template-literal interpolation:

```
const path = `/api/v2/mcp/${toolName}`;        // src/index.ts:587
let url = `${baseUrl}${path}`;                  // :589
```

`toolName` is **not** `encodeURIComponent`-wrapped. The query builder is also permissive:

```
qs.set(k, String(v));                           // :606  — String() coercion, no per-key validation
```

Today this is safe **only** because:
1. `handleToolCall` rejects any `name` not in the static `TOOLS` array before calling `callUpstream` (`:662-668`), so the interpolated path segment is always one of 14 known-safe literals; and
2. tool arguments are JSON-Schema-typed (`integer`, enums, `maxLength`) so `String(v)` of a validated `item_code` is always digits.

The spec proposes (§2) `manamurah://item/{item_code}` backed by `GET /api/v2/mcp/catalogue/item/{item_code}` and (§3.2 step 3) "proxy via the existing `callUpstream` pattern." **The template breaks invariant (1):** `{item_code}` is now a *free path segment extracted from a client-supplied URI*, not a static literal. If the implementation does the obvious thing — parse `manamurah://item/<x>`, take `<x>`, and feed it into a path-interpolating fetch — then `<x>` values like `../search_items?query=`, `99/../../`, `%2e%2e%2f`, an absurdly long string, or a non-numeric token can:
- traverse to a different upstream endpoint (confused-deputy: the Worker speaks to upstream with its trusted UA),
- or, if a future refactor ever lets the URI host/scheme through, become a full SSRF.

The spec's mitigation text ("never interpolate the raw URI into a fetch") addresses the *URI*, but the **extracted variable** is the actual injection vector and the spec gives it no validation rule.

**Why it matters.** This is the one place where attacker-controlled input meets URL construction in a credential-bearing-UA proxy. Path traversal into other `/api/v2/mcp/*` endpoints is plausibly reachable; it is the highest-severity item in this otherwise-benign feature.

**Recommendation (make these spec-mandatory, not optional):**
1. Template match must **extract** `{item_code}` and validate it against a strict regex — `^[0-9]{1,7}$` (item codes are positive integers; the catalogue is ~756 items, so ≤7 digits is generous). Reject anything else with `-32602` and the actionable message.
2. **Coerce to `Number`** and build the upstream path from the integer, never from the raw substring: `\`/api/v2/mcp/catalogue/item/${Number(code)}\``. A numeric value cannot carry `/`, `?`, `%`, or `..`.
3. For fixed resources, do **not** interpolate at all — use a literal-to-literal `Map<uri, upstreamPath>`.
4. Add `encodeURIComponent` on any path segment in `callUpstream` (or a resources-specific caller) as belt-and-braces, even though strict numeric validation already neutralises the vector. This also future-proofs the existing tool path.
5. Test (extend spec §7): a crafted URI `manamurah://item/..%2fsearch_items` (and `item/9999999999`, `item/abc`, `item/1;2`) must return `-32602` and **must not** issue any upstream `fetch`.

### SEC-2 (Medium) — Allowlist must be code-enforced, not prose-enforced

**Evidence.** Spec §3.2 step 1 says "Look up `uri` in a fixed allowlist… map allowlisted URI → fixed upstream path." Good intent, but the spec elsewhere (§3.2 first bullet) describes `RESOURCES` as a descriptor array (`{ uri, name, title, description, mimeType }`) with **no upstream-path field**. If the descriptor array is the allowlist but carries no path mapping, an implementer is nudged toward deriving the path *from the URI*, which reopens SEC-1.

**Recommendation.** Specify two distinct structures: (a) the public `RESOURCES` descriptor array for `resources/list`, and (b) an internal `RESOURCE_ROUTES: Map<uri, upstreamPath>` that is the actual fetch authority. `resources/read` resolves via (b) only; a URI absent from (b) (and not matching the one template) is `-32602`. This makes "never derive path from URI" a structural property, not a discipline.

### SEC-3 (Medium) — Resource content is untrusted agent context (resource/tool poisoning)

**Evidence.** The whitepaper threat the task cites — "malicious tool/resource definitions manipulate agent planners" — applies because resource *content* (catalogue item names, `name_en`, methodology markdown) is loaded into the Host as context. Trust chain: data.gov.my → ES → `manamurah.com` upstream → Worker (verbatim passthrough, `src/index.ts:619`,`:678`) → client. The catalogue free-text fields (`name`, `name_en`) are government-sourced and not user-editable today, so practical risk is **low** — but the spec never states the trust assumption, and `docs/methodology` (if proxied live, see SEC-7) is mutable outside code review.

**Why it matters.** If any upstream field ever becomes attacker-influenceable (e.g., a future user-suggested-item pipeline), a crafted item name like `IGNORE PREVIOUS INSTRUCTIONS…` would land directly in agent context with the server's implied authority. Resources are *higher* poisoning-risk than tool outputs because Hosts auto-load them as ambient context without an explicit tool call.

**Recommendation.** Add a "Resource content trust" subsection to the spec: (a) state that all resource content originates from public gov data + a curated methodology blob and is passed through verbatim — the Worker neither adds nor sanitises; (b) note free-text fields flow into agent context unmodified; (c) on any future change that lets external parties influence item metadata, re-audit; (d) prefer embedded methodology (SEC-7) precisely to keep agent-facing instructional text under code review.

### SEC-4 (Medium) — DoS / payload size beyond the items catalogue

**Evidence.** Spec §6 budgets only `catalogue/items` (<80 KB) and asserts the rest are "trivially small." But `resources/read` has no specified global ceiling, and the upstream rate-limit (120 req/60s/IP, §README) is the only abuse control. The template (SEC-1) also enables enumeration — an agent could `resources/read` `item/1..756`.

**Recommendation.** (a) Apply a hard serialized-byte ceiling to *every* resource response (e.g., reject/truncate >100 KB) — defence against an upstream regression that bloats `states`/`chains`. (b) State explicitly that `resources/read` (incl. template reads) is governed by the same upstream 120/60s IP limit, so enumeration is rate-bounded, not free. (c) Keep the §6 size-budget test, and add one for each resource, not just items.

### SEC-5 (Low) — CORS `*` for resources

**Evidence.** `CORS_HEADERS` sets `Access-Control-Allow-Origin: *` (`src/index.ts:739`) with no credentials header. Resources inherit this.

**Assessment.** **Appropriate.** The data is fully public, the Worker holds no cookies/credentials/tokens, and `*` without `Allow-Credentials: true` cannot leak authenticated state (there is none). No change needed.

**Recommendation.** Add one sentence to the spec confirming `*` is intentional for resources and that `Access-Control-Allow-Credentials` must never be introduced (doing so with `*` is itself invalid/insecure).

### SEC-6 (Low) — New upstream endpoints widen surface

**Evidence.** Spec §5 adds 4–5 new `/api/v2/mcp/*` endpoints. These are out of this repo but in the same trust boundary.

**Recommendation.** Require the new endpoints to: remain GET/read-only; serve only public reference data; enforce the same IP rate-limit and 12h KV cache; and **independently** validate `item_code` server-side (don't make the Worker the sole guard — defence in depth). Note this as an upstream acceptance criterion in §5/§8.

### SEC-7 (Low) — Methodology embed vs proxy (tamper/trust)

**Evidence.** Spec §5 / §9 Q3 leaves methodology source open (embed like `changelog.ts` vs proxy live `/about`).

**Recommendation — embed.** Embedding puts agent-facing methodology text under git/PR review (matching how `CHANGELOG_MARKDOWN` is handled, `src/index.ts:63`,`:846`), removes a live-tamper window, removes an upstream round-trip and dependency, and is consistent with the content being "stable" (spec's own word). A live `/about` proxy makes instructional content mutable outside code review and couples the resource to a page whose markup may change. Embed.

### SEC-8 (Info) — Telemetry `resource` field

The proposed `resource` field on `CallMeta` (spec §3.3) records only the resolved resource name / template id — non-sensitive, allowlisted, no PII. Consistent with the existing "no args/payloads" invariant (`src/analytics.ts:11-13`). No concern; keep the invariant.

### SEC-9 (Info) — Discovery surfaces advertise resources

Adding `resource_count` + a `resources` array to the server card (`:867`) and root manifest (`:911`) leaks no secrets (all public). Ensure the manifest exposes only resource **descriptors**, never full catalogue **bodies**, to keep the uncached root response small (it already inlines all tool schemas at ~6 KB; don't compound it).

---

## Secrets exposure — confirmation

Confirmed the Worker holds **no secrets**: `wrangler.toml` has only a public `MANAMURAH_API_BASE` var and the `WAE` analytics binding (write-only telemetry, no read surface); no `[[kv_namespaces]]`, no `[[d1_databases]]`, no `[secrets]`, no bound tokens. `Env` (`src/index.ts:91-96`) exposes only those two. The proxy forwards a static UA (`:591`) and no `Authorization` header upstream. New endpoints must preserve this — none of the proposed resources require credentials, and none should introduce a binding. No methodology-embed or new-endpoint path leaks internal info provided SEC-6 (read-only, public-data-only upstreams) holds.

---

## Open-question answers (through the security lens)

**Q1 — Ship `manamurah://item/{item_code}` template in v1, or defer?**
**Recommendation: defer to v2 unless SEC-1 + SEC-2 are implemented and tested as written.** The template is the *only* part of this feature that introduces attacker-controlled input into URL construction; everything else is static allowlisted literals over public data. The spec's value case ("high value, low cost") is real, but the cost is non-zero precisely on the security axis. Two acceptable paths: **(a)** ship it, but **only** with the strict `^[0-9]{1,7}$` validation, integer-coercion, literal path map (not URI-derived), the SSRF/traversal test, and `encodeURIComponent` belt-and-braces — all mandatory, not "leaning"; or **(b)** ship fixed resources only in v1 (zero added injection surface — every URI is a known literal) and add the template in v2 once (a)'s contract is codified. Given the repo currently has **no tests** (spec §7 admits this) and validation is the entire safety story, **(b) is the safer default**; choose **(a)** only if the SEC-1 tests land in the same PR.

**Q3 — Methodology: embed in Worker vs proxy live `/about`?**
**Recommendation: embed.** See SEC-7. Embedding keeps agent-facing instructional content under code review (no live-tamper window), eliminates an upstream dependency/round-trip, and matches the existing `changelog.ts` precedent. A live proxy turns a piece of *agent guidance* into mutable runtime content — the worst category to leave outside version control given the resource-poisoning concern in SEC-3. Embed a curated, versioned blob; re-review it on change like any other source.

---

## Spec change requests (for the consolidation step)

1. **§2 (templates) + §3.2 step 3 — add a mandatory `{item_code}` validation contract** (SEC-1): regex `^[0-9]{1,7}$`, integer-coerce, build upstream path from the integer only, `-32602` on mismatch. State explicitly "the extracted template variable, not just the URI, must be validated before any fetch."
2. **§3.2 step 1 — split the allowlist into a public descriptor array and an internal `Map<uri, upstreamPath>`** (SEC-2); `resources/read` resolves the fetch path exclusively from the Map / template matcher, never derived from the inbound URI.
3. **§3 / `callUpstream` note — require `encodeURIComponent` on interpolated path segments** (SEC-1 belt-and-braces); note the current path-builder at `:587` is unencoded and safe only via the static `TOOLS` allowlist.
4. **§6 / §7 — extend the size budget + a hard byte ceiling to every resource**, not just `catalogue/items`; add a per-resource size test (SEC-4).
5. **§7 — make the SSRF/allowlist test cover the template** with explicit traversal/injection payloads (`item/..%2fsearch_items`, `item/abc`, `item/9999999999`) asserting `-32602` and **zero** upstream fetch (SEC-1, SEC-2).
6. **New subsection "Resource content trust"** (SEC-3): document the ES→upstream→Worker→client chain, verbatim passthrough, free-text fields entering agent context, and the re-audit trigger if item metadata ever becomes externally influenceable.
7. **§5 / §8 — add upstream acceptance criteria** (SEC-6): new `/api/v2/mcp/*` endpoints stay GET/read-only, public-data-only, IP-rate-limited, and validate `item_code` independently.
8. **§9 Q1 — record the recommendation: defer template to v2** unless the SEC-1 validation + tests ship in the same PR.
9. **§9 Q3 — record the recommendation: embed methodology** (SEC-7).
10. **CORS note** (SEC-5): state `*` is intentional for resources and `Access-Control-Allow-Credentials: true` must never be added.
