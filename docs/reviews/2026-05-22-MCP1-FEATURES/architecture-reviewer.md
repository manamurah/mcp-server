# Architecture Review — MCP Resources for manamurah MCP server

**Date:** 2026-05-22
**Persona:** Architecture Reviewer (separation of concerns, coupling, dead code, schema source-of-truth, extensibility, statelessness)
**Scope:** `docs/2026-05-22-spec-mcp-resources.md` (primary) and `docs/2026-05-22-mcp-enhancement-proposals.md` (context). Grounding read of `src/index.ts`, `src/analytics.ts`, `src/changelog.ts`, `wrangler.toml`, `package.json`, `README.md`, and the sibling Python reference (`manamurah-mcp-2026`) for drift assessment. **Review only — no code changed.**

---

## Executive summary

The spec is well-reasoned and architecturally sober. It correctly frames Resources as **stateless, allowlisted, read-through reference data** and explicitly refuses the two things that would have hurt most: subscriptions/`listChanged` (statefulness) and query-results-as-resources (tool/resource boundary collapse). The non-goals in §1 are the strongest part of the document — they pre-empt the classic MCP-Resources mistakes.

The design holds. My concerns are about **debt the spec creates or defers rather than design that won't work**:

1. The biggest latent risk is **schema/contract drift across three surfaces** (TS Worker, Pydantic ref, and now Resources). This already exists today — the Python ref registers **15 tools incl. `chain_mom_movers`, which the Worker does not expose** (14 tools). Adding a hand-maintained `RESOURCES` const + 5 upstream endpoints widens the same fault line. The spec acknowledges this (proposal #7) but defers it; the Resources work is the moment to at least *not make it worse*.
2. The dispatch design (per-method `switch` branch + an internal allowlist lookup) is fine for v1, but the spec under-specifies the **URI→upstream-path mapping table** as the single source of truth. Done as a table it sets good precedent for completions/prompts; done as inline branches it becomes another hand-maintained list that drifts from `RESOURCES`.
3. Two concrete overlaps need an explicit governing **principle**, not case-by-case calls: `catalogue/chains` vs the `list_chains` tool, and `meta/latest-week` vs the future coverage tool (proposal #4). Without a stated principle these will recur for every future resource.

**Overall architecture rating: Low risk** (the design will hold and is reversible; the issues are debt-management and precedent-setting, not structural flaws). Two findings are High because they govern long-term maintainability, but none are Critical.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|----|----------|-------|----------|----------------|
| A1 | High | Three hand-maintained schema surfaces; drift already live | proposal §99-103; ref `server.py` (15 tools vs Worker 14) | Don't single-source now, but make the new surface table-driven and add a CI drift check (tool/resource name parity) before, not after, shipping |
| A2 | High | URI→upstream mapping not specified as the single source of truth | spec §70-79 (`resources/read` steps) | Define one `RESOURCES` table carrying `{uri, …, upstreamPath, kind}`; derive `resources/list`, the allowlist, and the fetch path from it. No second inline list |
| A3 | Medium | `catalogue/chains` duplicates `list_chains` tool with no governing principle | spec §40 | Legitimate dual-surface, but state the principle (see Open-Q / §"Principle"); ship chains-resource as the *unfiltered* catalogue, keep `list_chains` for *filtered* queries |
| A4 | Medium | `meta/latest-week` overlaps future coverage tool (#4) → migration burden | spec §41, §173-175; proposal §71-77 | Ship now, but freeze its contract to `{latest_weekdate, premises_reporting, items_with_data}` and document it as the stable freshness primitive the #4 tool will *consume*, not duplicate |
| A5 | Medium | Item template ⇒ 6th upstream endpoint + RFC-6570 matcher = disproportionate v1 surface | spec §44-54, §165-167 | Defer the template to v2. Fixed resources first; prove the dispatch + allowlist pattern before adding URI-pattern matching |
| A6 | Medium | Methodology embed-vs-proxy unresolved; embed is consistent but adds a 2nd drift-prone blob | spec §42, §124-127, §170-172 | Embed (consistent with `changelog.ts`), but co-locate as `src/methodology.ts` and add it to the same "paste-mirror" review discipline already noted for changelog |
| A7 | Low | `CallMeta.resource` field is additive and clean, but WAE blob layout is fixed/positional | spec §83-89; `analytics.ts` §15-29 | Reuse `blob2` (currently `tool`) as a generic "primary subject" or append a new blob; document the schema change in `analytics.ts` header to avoid silent column drift |
| A8 | Low | Capability object inconsistency between `initialize` and root manifest | spec §58-63; `index.ts:632`, `:929` | Bump *both* sites in lockstep; consider a shared `CAPABILITIES` const so they can't drift |
| A9 | Info | Resources design is good precedent for completions/prompts | proposal §59-69 | The table-driven dispatch (A2) is the reusable asset; prompts/completions should register into analogous consts |

---

## Detailed findings

### A1 — Three schema surfaces; drift is already live (High)

The proposal (§99-103) flags that schemas are hand-written twice (TS `TOOLS`, Pydantic `models.py`). Resources make it three. **This is not hypothetical:** the Python ref `server.py` registers 15 tools including `chain_mom_movers` (ref `server.py:410`), which the Worker's `TOOLS` array does not contain — the Worker is at 14. So the two tool surfaces have *already drifted* by one whole tool. The README and package.json both say "14 tools"; the ref says 15. Adding `RESOURCES` to the Worker without addressing this means a third hand-list maintained against the same upstream.

I am **not** recommending the full single-source build (proposal #7) as a blocker — that is a larger project and would delay Resources. But the Resources PR is the right moment to install a cheap guard rather than widen the gap:

- A CI assertion (the spec already proposes a test harness in §139-149) that cross-checks Worker resource/tool *names* against a canonical list — even a checked-in JSON manifest the upstream serves — catches the next drift at review time, the way the changelog "paste-mirror" discipline (`changelog.ts:7-11`) is supposed to.
- At minimum, the Resources spec should state which surface is canonical for resource names (the upstream `/api/v2/mcp/*` route set) so the Worker is provably a derived view.

Architectural debt verdict: **single-sourcing is not required for this feature, but a name-parity drift check is, because the feature demonstrably worsens an already-broken invariant.**

### A2 — Make the dispatch table-driven, not branch-driven (High)

§70-79 describes `resources/read` as: look up URI in "the `RESOURCES` array + template matcher", then "map allowlisted URI → fixed upstream path", then proxy via `callUpstream` (`index.ts:581`). The intent is right (allowlist, no raw-URI interpolation — good SSRF posture). But the spec leaves the *mapping* implicit. There are two ways to build this:

- **Table-driven (recommended):** one `const RESOURCES` whose entries carry everything — `{ uri, name, title, description, mimeType, upstreamPath, kind }`. `resources/list` projects the display fields; the allowlist *is* the table's key set; `resources/read` reads `upstreamPath` from the matched entry. One list, zero duplication, and the URI→path map cannot drift from the advertised catalogue.
- **Branch-driven (avoid):** a `switch (uri)` inside `resources/read` with the upstream path hardcoded per case, separate from the `RESOURCES` array used by `resources/list`. This is the trap — two lists, guaranteed to drift, exactly the `TOOLS`-vs-ref problem in miniature.

Note the current tool path is *implicitly* derived: `callUpstream` does `path = /api/v2/mcp/${toolName}` (`index.ts:587`), i.e. tool name == upstream segment. Resources break that 1:1 assumption (`catalogue/items` URI vs `/api/v2/mcp/catalogue/items`, and `catalogue/chains` reusing the `list_chains` upstream). So `callUpstream` needs either a path override parameter or a sibling `callUpstreamPath(baseUrl, path, …)`. The spec says "proxy via the existing `callUpstream` pattern" — it should explicitly say the resource path is taken from the table, not inferred from the URI, otherwise an implementer will overload the name-equals-path convention and it will silently work for `catalogue/items` but mismap `chains`.

This finding is the **load-bearing one for extensibility**: a clean `RESOURCES` table is the template prompts (`PROMPTS` const) and completions will copy. Worth doing now (A9).

### A3 — `catalogue/chains` vs `list_chains`: legitimate dual-surface, but state the principle (Medium)

The `catalogue/chains` resource (spec §40) returns the same data as the `list_chains` tool (`index.ts:278-295`) and even reuses its upstream. Is this duplication or a legitimate dual-surface? **Legitimate — but only under a stated principle**, otherwise every future addition reopens the debate.

Recommended principle (add to spec §2 non-goals or a new "tool/resource split" section):

> **A dataset may appear as both a Resource and a Tool when, and only when, the Resource is the *whole, unparameterised* reference set loaded as ambient context, and the Tool is a *parameterised query/filter* over it.** Resources are nouns the Host pre-loads; Tools are verbs the agent invokes with arguments.

Under this principle: `catalogue/chains` (the full ~50-row list, no filter) is a resource; `list_chains(query, chain_type, state)` (filtered) stays a tool. The overlap is intentional and bounded — the resource is the "L1 cache" the Host reads once, the tool is the "query" for narrowing. Without the principle, someone will later argue `find_cheapest` results should be a resource too, and the boundary the spec worked hard to draw (§19-28) erodes. The principle also resolves Open-Q implicitly for every future resource.

One concrete note: `catalogue/chains` reuses the `list_chains` upstream, which is *parameterised and capped at 50*. The resource should hit it with **no filters** to get the canonical full list, and the spec should say so — otherwise the resource silently inherits the tool's filter/cap semantics.

### A4 — `meta/latest-week` overlaps proposal #4 coverage tool (Medium — strong opinion below)

See Open-Q #4 for the full argument. Summary: ship it now, but **freeze the contract narrow** so #4 consumes it rather than replaces it. The risk is not building it now; the risk is building it *wide* (creeping per-item coverage into the resource) so that #4 has to either duplicate or deprecate it.

### A5 — Item template is disproportionate v1 surface (Medium)

The `manamurah://item/{item_code}` template (spec §44-54) requires: a 6th new upstream endpoint (`catalogue/item/{item_code}`), an RFC-6570 template matcher, a `resources/templates/list` handler, and template-aware allowlist logic (you allowlist a *pattern*, not a literal — a different and slightly riskier validation path). For v1 whose entire point is "load stable reference data as context", a per-item card is a *query by another name* and sits awkwardly against the §19-28 boundary the spec just drew. It also overlaps `compare_prices` / `price_history` data. Defer it (see Open-Q #1).

### A6 — Methodology embed-vs-proxy (Medium)

Embedding a methodology blob in the Worker is **consistent** with the existing `changelog.ts` pattern (`changelog.ts:1-12` documents exactly this "Workers can't read the FS, embed as template literal" rationale). So structurally it fits. The cost: a second prose blob that must be paste-mirrored and can drift from the canonical `/about`. Recommendation: embed as `src/methodology.ts`, mirror the changelog's maintainer-note discipline, and keep it short. See Open-Q #3.

### A7 — Telemetry field (Low)

Adding `resource?: string` to `CallMeta` (spec §83) is clean and symmetric with `tool`. But `analytics.ts` writes a **fixed positional blob layout** (`analytics.ts:92-107`): `blob2` is `tool`. The spec says "analogous to `tool`" but doesn't say whether `resource` gets its own blob (changing the documented schema in the header comment, §15-29) or reuses `blob2`. Recommend: reuse `blob2` as a generic "subject" (tool name OR resource name OR '-') since a single request is never both, and update the header doc. Adding a 9th blob is also fine but must be documented or the WAE SQL columns silently shift meaning.

### A8 — Capability object must move in lockstep (Low)

`capabilities` is declared in two places: `handleInitialize` (`index.ts:632`) and the root manifest (`index.ts:929`). Both currently say `{ tools: {}, prompts: {}, resources: {} }`. The spec's diff (§58-63) only shows the `initialize` site. Both must change to `resources: { listChanged: false }`, and `prompts: {}` should arguably stay `{}` (no prompt capability yet). Recommend a shared `const CAPABILITIES` so the two sites can't drift — a micro-instance of the same drift theme as A1/A2.

### A9 — Precedent for completions/prompts (Info)

If A2 is done as a table, the Resources work becomes the reusable scaffold for the rest of Tier 1: `PROMPTS` const + `prompts/list`/`prompts/get`, and a completions registry keyed off the same catalogue. The handler/dispatch refactor (turning the `handleMCP` switch into thin handlers that each read a static const) is **worth doing now** precisely because three more primitives are queued behind it. Doing Resources as one-off branches would mean re-litigating the structure three more times.

### Stateless purity — validated

The design introduces **no state**. `resources/list` returns a const; `resources/read` is a pure read-through to upstream via `fetch`; no subscriptions, no `listChanged`, no session affinity (the Worker already runs per-request-isolated, README:226-237). `{ listChanged: false }` is the correct and honest capability. Nothing in the resource design sneaks in state. The only thing to watch: do **not** add a Worker-side cache for resource bodies "to save upstream calls" — that would introduce TTL state and a staleness-coherence problem the upstream 12h KV cache already owns. The spec correctly leaves caching upstream (§22-24); keep it there.

### Coupling — assessed

The Worker is tightly coupled to upstream URL shapes (`/api/v2/mcp/<tool>`, `index.ts:587`). Resources add ~5 endpoints, *deepening* that coupling. This is acceptable given the deliberate thin-shim architecture (README:226-237) — the coupling is the design, not an accident. The mitigations that matter: (1) the table-driven map (A2) localises the coupling to one editable structure; (2) the allowlist (spec §70-74) is the right security boundary and correctly prevents the coupling from becoming an SSRF surface. The one real new coupling risk is the `catalogue/chains`→`list_chains` upstream reuse (A3) — it couples a *resource's* stability to a *tool's* upstream contract; if `list_chains` upstream changes its filter/cap semantics, the resource silently changes too. Document the dependency.

---

## Open-question answers

**Q1 — Item template in v1 or defer? → Defer to v2.** (A5) The template is the only part of the spec that crosses the noun/verb boundary the rest of the design defends, and it costs the most surface (6th endpoint + RFC-6570 matcher + pattern-allowlist). Ship fixed resources first, prove the table-driven dispatch + allowlist, then add templates once the pattern-matching validation path can get its own focused test. Shipping it in v1 front-loads the riskiest, least-reference-like piece.

**Q4 — `meta/latest-week` now vs fold into #4 coverage tool? → Ship now, but freeze the contract narrow.** Strong opinion: the freshness *resource* and the coverage *tool* are different primitives under the A3 principle — freshness is an unparameterised ambient fact ("what's the latest week, how many premises reported"), coverage (#4) is a *parameterised* per-item/per-scope reliability query (the n≥30 enforcement, proposal §71-77). They are not the same surface and `meta/latest-week` will **not** become dead code if its contract stays exactly `{latest_weekdate, premises_reporting, items_with_data}`. The deprecation/migration burden only materialises if `meta/latest-week` is allowed to grow per-item coverage fields — then it overlaps #4 and one must die. Recommendation: ship it now, document it explicitly as "the global freshness primitive; per-item/scope reliability is out of scope and lives in the future coverage tool," and have the eventual #4 tool *cite/consume* the same `latest_weekdate` rather than recompute it. No fold, no defer.

**Q3 — Methodology embed vs proxy? → Embed.** (A6) Embedding is consistent with the established `changelog.ts` pattern (same FS-less-Worker rationale, `changelog.ts:1-12`), removes a round-trip on a stable text, and keeps the resource available even if `/about` upstream is down. The cost is a paste-mirror drift risk identical to the changelog's — manageable with the same maintainer-note discipline. Put it in `src/methodology.ts`, keep it short (weekly cadence, equal-premise weighting, outlier filtering, n≥30 caveat), and add it to the test harness's "resource reads return valid content" check. Proxy only if the methodology text starts changing frequently or grows large — neither is true today.

---

## Spec change requests

1. **Add a "Tool/Resource split principle" subsection** to §2 stating the noun/verb rule from A3, and apply it to justify `catalogue/chains` and to scope `meta/latest-week`. This converts case-by-case calls into a reusable governing rule.
2. **§70-79: specify the dispatch as table-driven.** Make `RESOURCES` entries carry `upstreamPath` (and `kind: 'json' | 'markdown' | 'embedded'`). State that `resources/list`, the allowlist, and the read-path all derive from this one table, and that `callUpstream` gains a path-override (or a sibling) because the URI no longer equals the upstream segment. Forbid a second inline URI→path list.
3. **§139-149 (testing): add a name-parity drift check** between Worker resources/tools and the canonical upstream route set, and reference the existing `chain_mom_movers` 14-vs-15 drift as the motivating regression. Tie this to proposal #7 as the cheap precursor.
4. **§44-54 + Q1: move the item template to an explicit "v2 / deferred" section.** Keep `resources/templates/list` returning `[]` in v1 so the capability shape is stable, but don't build the endpoint or matcher yet.
5. **§41 + Q4: freeze `meta/latest-week`'s contract** to the three named fields and add a one-line note that per-item coverage is reserved for proposal #4, which will consume (not duplicate) this freshness signal.
6. **§58-63: bump `capabilities` in both `initialize` (`index.ts:632`) and the root manifest (`index.ts:929`)**, ideally via a shared `CAPABILITIES` const. The diff currently shows only one site.
7. **§42, §124-127, Q3: commit to embed**, name the module `src/methodology.ts`, and add it to the changelog-style paste-mirror maintainer note.
8. **§83-89: specify the WAE blob placement** for the new `resource` subject (reuse `blob2` as generic subject, or document a new blob) and update the `analytics.ts` header schema comment in the same PR.
