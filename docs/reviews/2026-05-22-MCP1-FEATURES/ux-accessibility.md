# UX / Accessibility Review — MCP Resources for manamurah MCP server

**Date:** 2026-05-22
**Persona:** UX / Accessibility Reviewer (for an MCP server, "users" = the consuming LLM agent, the integrating developer, and the end-user on constrained/mobile clients like Claude.ai)
**Scope:** `docs/2026-05-22-spec-mcp-resources.md` (primary) and `docs/2026-05-22-mcp-enhancement-proposals.md`. Grounded against `src/index.ts`, `src/analytics.ts`, `src/changelog.ts`, `README.md`. **Review only — no code changed.**

---

## Executive summary

The spec is well-grounded in MCP idioms and the whitepaper, and the core decisions (no subscriptions, allowlisted `resources/read`, lean `catalogue/items`, `weekdate` on every payload) are correct. From the agent-UX lens the design is sound but **under-specified on the surfaces that determine whether an agent actually finds and trusts the resources**:

1. The single `-32602` actionable error is the *only* error message specified; the existing tool error messages it is meant to model are themselves **not actionable** (`"Unknown tool: X"`, `"Tool execution failed"`) — so the spec aspires to a quality bar the codebase has not yet met, and doesn't say to raise it.
2. **The tool↔resource relationship is invisible to the agent.** The spec adds resources but never tells `search_items` / `list_chains` / `compare_prices` descriptions to point at the new catalogue resources. Resources that exist but aren't cross-referenced from the tools an agent already knows will simply not be discovered — defeating the stated "kill the `search_items` round-trip" goal.
3. **`resources/list` entry copy, the methodology resource content, and the empty/stale-week signalling are all left unspecified** — these are exactly the self-describing surfaces that make or break agent discoverability.

These are fixable in-spec and none is architectural. With the cross-referencing and error-quality fixes, this is a clean, low-risk additive feature.

**Overall UX rating: Medium.** (The feature is usable as drafted, but frequent agent confusion is likely around discoverability and error recovery until the High findings are addressed.)

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| UX-1 | High | Tools don't point at the new resources — agent won't discover them | spec §2, §3.4; `src/index.ts:143,281,263` | Add a one-line "Reference data also available as the `manamurah://catalogue/*` resources" to `search_items`, `list_chains`, `compare_prices` descriptions; spec must mandate this. |
| UX-2 | High | Existing tool errors aren't actionable — spec models a bar the code fails | `src/index.ts:659,666,688`; spec §3.2 step 2 | Spec should require the same actionable-message standard for the unknown-tool and exec-failure errors it is co-shipping, not just unknown-URI. |
| UX-3 | High | `resources/list` entry copy (`name`/`title`/`description`) unspecified | spec §3.2, §2 | Spec must give the literal `name`/`title`/`description`/`mimeType` strings per resource, incl. freshness + language coverage in the description. |
| UX-4 | Medium | Methodology resource content & format unspecified | spec §2 row 6, §5, §9 Q3 | Spec must enumerate the caveat list (n≥30, equal-premise weighting, outlier filter, weekly cadence) and require headings + a stale-data caveat. |
| UX-5 | Medium | No empty / stale-week UX for resources | spec §4; `meta/latest-week` | Define what `meta/latest-week` returns mid-ETL and require a top-level `weekdate` + `as_of`/`stale` hint so agents can narrate freshness. |
| UX-6 | Medium | `name_en`-only catalogue underserves Malaysian audience | spec §2 row 1, §9 Q5 | Carry `name` (ms) **and** `name_en`; drop zh/ta from the bulk list. (Detailed answer below.) |
| UX-7 | Medium | Item template adds a parallel mental model that overlaps tools | spec §2 templates, §9 Q1 | Defer the item template to v2 OR ship it only with a description that sharply delimits it from `compare_prices`/`price_history`. (Detailed answer below.) |
| UX-8 | Medium | URI scheme vs tool-naming inconsistency (`/` paths vs snake_case tools) | spec §2 | Acceptable, but document the convention so the agent's mental model is explicit; align `chains` resource field names to the `list_chains` tool output exactly. |
| UX-9 | Low | Token budget asserted on serialized bytes, not agent-context cost | spec §6 | Express the budget as an explicit ceiling (e.g. ≤ ~20k tokens) and note mobile/Claude.ai impact; consider documenting that `catalogue/items` is large. |
| UX-10 | Low | Developer-facing discovery surfaces partially specified | spec §3.4; `README.md:272` | Require README "Protocol notes" + a `resources/list` smoke-test snippet, and spell out the root-manifest `resources` array shape. |
| UX-11 | Info | `resources/templates/list` advertised only if templates ship | spec §3.2 | If templates deferred, still return `{ "resourceTemplates": [] }` (don't 404) so capable clients probe cleanly. |

---

## Detailed findings

### UX-1 (High) — Tools don't point at the new resources; the agent won't discover them

The whole premise (§1) is "kill the recurring `search_items → item_code → real tool` round-trip." But discovery in practice is asymmetric: an agent that has already loaded `tools/list` reaches for the tool it knows. Nothing in the spec connects the two surfaces. `resources/list` is a separate call many hosts only make lazily (or, on some clients, only when a human attaches a resource). If `search_items`'s description (`src/index.ts:143`) doesn't say "the full catalogue is also available as the `manamurah://catalogue/items` resource — read it once instead of repeated searches," the agent will keep calling `search_items`.

**The legibility of the tool/resource relationship is itself a UX deliverable.** The spec's §3.4 covers the *server card* and *root manifest* but not the tool descriptions, which are where the agent actually lives.

**Recommendation:** Spec must add an explicit task: append a one-sentence pointer to the resource in the descriptions of `search_items` (→ `catalogue/items` + `catalogue/categories`), `list_chains` (→ `catalogue/chains`), `compare_prices`/`price_history` (→ `meta/latest-week` for freshness; `catalogue/states` for valid `scope_value`s). This also reinforces UX-8 (valid enum values). It is a description-string change, low risk, no schema impact — but it's the difference between resources that are used and resources that are dead weight.

### UX-2 (High) — The actionable-error promise sets a bar the existing code fails

Spec §3.2 step 2 promises `-32602` "`Unknown resource <uri>. Call resources/list for the catalogue.`" — genuinely actionable, exactly per the whitepaper ("errors should give instructions to the LLM about what to do"). Good.

But auditing the tool errors this resource handler sits beside:
- `src/index.ts:659` — `"Missing tool name"` — not actionable.
- `src/index.ts:666` — `` `Unknown tool: ${name}` `` — names the problem but gives no recovery instruction (no "call `tools/list`").
- `src/index.ts:688` — `"Tool execution failed"` with the raw upstream string in `data` — the agent gets a stack-ish blob, not an instruction.

So the spec introduces a *better* error than its own neighbours, silently. An agent that hits `Unknown resource` learns to call `resources/list`; an agent that hits `Unknown tool` learns nothing. This is an inconsistency the user will feel as "the resources error is helpful, the tools error isn't." Proposal §6 ("Actionable error messages") already flags this as Tier-2 work, but the Resources spec is the natural moment to fix at least the symmetric `Unknown tool` case it is co-shipping with.

**Recommendation:** Spec should (a) lock the unknown-URI message wording, AND (b) add a sub-task to bring `Unknown tool` to the same standard (`Unknown tool '<name>'. Call tools/list to see the 14 available tools.`) so the two discovery errors are consistent. At minimum, call out the asymmetry so the implementer doesn't ship a half-actionable surface.

### UX-3 (High) — `resources/list` entry copy is unspecified

Spec §3.2 says each entry is `{ uri, name, title, description, mimeType }` and §2 gives a "Name" column, but no literal `description` or `title` strings. For tools, the *description is the entire UX* — the agent reads it to decide what to call. The same is true of resources: a thin `name: "Item catalogue"` with no `description` leaves the agent guessing whether `catalogue/items` includes prices (it doesn't), what languages it carries, and how fresh it is.

**Recommendation:** Spec must table the literal copy. Each `description` should state: what's in it, what's NOT in it (e.g. "names + codes only, no prices — use `find_cheapest`/`price_history` for prices"), the languages present, and that it carries a `weekdate`. Example for `catalogue/items`:
> "Full PriceCatcher item catalogue (~756 items): `item_code`, Malay `name`, English `name_en`, `unit`, `item_category`. No prices — resolve a name to an `item_code` here, then call `find_cheapest`/`price_history`. Carries `weekdate` for freshness."

This mirrors the (excellent) discipline already in the tool descriptions (e.g. `search_items` at `:143` ends with "Do not use for prices — chain to find_cheapest…"). Resources deserve the same.

### UX-4 (Medium) — Methodology resource content and format unspecified

`docs/methodology` (§2 row 6) is described only as "the `/about` essentials." But this resource exists to be **cited** by agents as caveats — the proposal explicitly ties it to the n≥30 incident ("Daging Topside +14.8% at n=11"). Its content quality directly determines whether an agent narrates correct caveats. An unspecified blob risks being either too thin (no n≥30 guidance) or a marketing-flavoured `/about` page.

**Recommendation:** Spec must enumerate the required caveats: weekly-average cadence, equal-premise weighting, outlier filtering, sparse-data / n≥30 guidance, FAMA-vs-PriceCatcher catalogue distinction, "averages are not peninsular-weighted under `scope=region`." Require markdown with headings (so agents can quote a section) and a leading one-line "as of `<weekdate>`" so a cited caveat is dated. This is readable and citable as agent caveats — and it should be terse (it's loaded into context).

### UX-5 (Medium) — No empty / stale-week ("no data this week") UX for resources

§4 mandates a `weekdate` on every payload — good. But the spec never says what `meta/latest-week` returns *during* the weekly ETL window, or how an agent should distinguish "fresh" from "last week's data because this week hasn't landed." For an end-user this is the difference between "prices as of this Monday" and a silently stale answer. Tools today surface this via the `{status, warnings}` envelope; resources need an equivalent.

**Recommendation:** `meta/latest-week` should return `{ latest_weekdate, generated_at, premises_reporting, items_with_data }` AND the catalogue payloads should echo the same `weekdate`. Consider an explicit `stale: boolean` or `as_of` so an agent can say "data as of 2026-05-18 (current)." Define the mid-ETL contract: does `latest-week` flip atomically, or can a catalogue read see a newer `weekdate` than `latest-week`? Spec should pin this so cross-resource freshness can't drift (also relevant to §9 Q3, below).

### UX-6 (Medium) — `name_en`-only underserves the Malaysian audience

See open-question answer Q5 below — strong opinion: ship `name` (Malay) **and** `name_en`.

### UX-7 (Medium) — Item template overlaps existing tools' mental model

See open-question answer Q1 below.

### UX-8 (Medium) — URI scheme vs tool-naming consistency

`manamurah://catalogue/items` (slash-pathed, lowercase) vs `search_items` (snake_case) is a different convention. This is fine — resources are URIs, tools are identifiers, and the `catalogue/`, `meta/`, `docs/` namespacing is *clearer* than a flat scheme. But two consistency hazards:

- The agent's mental model benefits from the namespaces being predictable. Document the convention (`catalogue/*` = reference lists, `meta/*` = freshness/ops, `docs/*` = prose) in the methodology or root manifest so it's legible.
- The `chains` resource (§2 row 4) "mirrors the `list_chains` tool output" — it must mirror it *exactly* (same field names: `name, premise_count, chain_type, states`). If the resource and tool disagree on field names for the same data, that's a real agent-confusion bug.

### UX-9 (Low) — Token budget framed as bytes, not agent-context cost

§6 targets "< 80 KB" serialized and asserts in tests. Good discipline, but the constraint that matters for mobile/Claude.ai is **context tokens**, not KB. ~60 KB of JSON catalogue is roughly 15k–20k tokens — a meaningful chunk of a small-context or mobile session, and it's loaded *whole* (resources have no pagination here). The spec correctly keeps it lean but should (a) state the budget in tokens as the primary metric, (b) acknowledge that `catalogue/items` is the one resource an agent should read deliberately, not reflexively, and (c) note this in the resource's own `description` ("large — ~756 items") so a token-budget-aware host can decide.

### UX-10 (Low) — Developer-facing discovery surfaces partially specified

§3.4 updates the server card and root manifest, and §3 mentions the changelog. But:
- `README.md:272` "Methods supported" lists `resources/list (empty)` — must be updated to describe the populated catalogue and `resources/read` / `resources/templates/list`.
- README should gain a `resources/list` curl smoke-test mirroring the `tools/list` one at `README.md:111` — this is the first thing an integrating developer runs.
- The root-manifest `resources` array shape (§3.4) should be spelled out (mirror `tools`: `uri, name, title, description, mimeType`), so registry crawlers index it deterministically.

### UX-11 (Info) — `resources/templates/list` should return `[]`, not 404, if deferred

If templates are deferred (Q1), still implement `resources/templates/list` returning `{ "resourceTemplates": [] }`. A capable host probing for templates should get a clean empty list, not a `-32601 Method not found`, which looks like a broken server.

---

## Open-question answers (through the UX lens)

**Q5 — `name_en` only vs full multilingual in the item card / catalogue? (strong opinion wanted)**
**Carry both `name` (Malay) and `name_en`; drop zh/ta from the bulk catalogue.** The spec's §2 lean set lists `name, name_en` but §9 Q5 and §6 waver toward "`name_en` only." For a Malaysian audience, **Malay is the primary language of the source data and the end-user** — PriceCatcher item names are natively Malay (`TEMBIKAI MERAH TANPA BIJI`), the README's own example conversation is in Malay, and Claude.ai users in Malaysia query in Malay (`"harga tembikai…"`). Shipping `name_en` *only* would force the agent to round-trip back to `search_items` to recover the Malay label it needs to echo to the user — re-introducing exactly the round-trip Resources exist to kill. So: **`name` (ms) is mandatory, `name_en` is the valuable bilingual aid, both stay.** zh/ta are correctly dropped from the *bulk* list for token discipline — but `search_items` already searches all four languages (`:143`), so zh/ta lookup is preserved via the tool. (If an item-card template ships, that single-entity card *can* afford full ms/en/zh/ta — see Q1.)

**Q3 — Methodology embed vs proxy `/about`? (content-freshness/consistency angle)**
**Embed a curated methodology blob in the Worker** (like `changelog.ts`), not a proxy of live `/about`. Rationale through the freshness/consistency lens: methodology is *stable* (cadence, weighting, n≥30 guidance change rarely), so a live proxy buys nothing and adds an upstream round-trip + a failure mode (if `/about` is down, a core resource 500s). More importantly, `/about` is *marketing-audience prose*; the agent-citable caveat list is a *different document* with different emphasis (the n≥30 guidance isn't on the public `/about`). Embedding lets you version it in the changelog and review its wording at PR time — content consistency is *higher* embedded, because it's not coupled to website copy edits. Caveat: embedded text must carry a "reviewed as of `<date>`" line (see UX-4) so it doesn't silently rot; add a maintainer note like the one already at `changelog.ts:8`.

**Q1 — Item template (`manamurah://item/{item_code}`) in v1 or defer? (agent mental-model angle)**
**Defer to v2** (mild lean — the spec leans ship; I lean defer, but it's close). The mental-model risk: the item card returns "latest national avg price, premise count, freshness" — which **overlaps `compare_prices` and `price_history`**. An agent now has *two* ways to get a price-ish answer for one item (a resource read and a tool call) with subtly different shapes, and must learn when to use which. That ambiguity is a net UX cost on a server whose tool descriptions are otherwise admirably disambiguated ("Do not use for prices — chain to…"). The fixed catalogue resources have *no* such overlap — they're pure reference, clearly not tools — so they're safe to ship now. The item card straddles the reference/query line. **If shipped in v1 anyway**, its description must aggressively delimit it: "single-item reference card — name, unit, category, and one latest national average for orientation only. For price comparisons across states/chains use `compare_prices`; for trends use `price_history`." Without that guardrail it muddies the clean tool/resource split the spec rightly prizes. Either way, ship `resources/templates/list` (see UX-11).

**(Bonus) Q2 / Q4 — lean fields / ship `meta/latest-week` now:** both leanings in the spec are correct from the UX lens. Lean fields = better mobile/context behaviour (UX-9). Shipping the lightweight freshness resource now is *the* enabler for the empty/stale-week UX (UX-5) and for agents self-enforcing the n≥30 discipline — high UX value, ship it.

---

## Spec change requests

1. **Add a task (§3 / §8 step 2):** append resource-pointer sentences to `search_items`, `list_chains`, `compare_prices`, `price_history` descriptions. (UX-1) — *blocking for the stated goal.*
2. **Tighten §3.2 errors:** lock the `-32602` unknown-URI wording AND bring `Unknown tool` (`src/index.ts:666`) to the same actionable standard; note the asymmetry explicitly. (UX-2)
3. **Add a sub-section to §2:** the literal `name` / `title` / `description` / `mimeType` for every resource, with "what it is NOT" and language/freshness notes baked into each `description`. (UX-3)
4. **Expand §2 row 6 / §5:** enumerate the methodology caveat list and require dated, headed markdown. (UX-4, Q3)
5. **Extend §4:** define `meta/latest-week`'s mid-ETL contract and a `stale`/`as_of` freshness hint; require `weekdate` echo across catalogue payloads. (UX-5)
6. **Resolve §9 Q5 in-spec:** `name` (ms) + `name_en` mandatory in `catalogue/items`. (UX-6)
7. **Resolve §9 Q1 in-spec:** defer item template to v2 (or ship with the delimiting description in CR-3); either way return `resources/templates/list: []`. (UX-7, UX-11)
8. **Add §6 framing:** state the budget in tokens (primary) as well as KB; flag `catalogue/items` as the one "read deliberately" resource. (UX-9)
9. **Add a developer-UX task:** update `README.md` "Methods supported" (`:272`) + add a `resources/list` smoke-test snippet; spell out the root-manifest `resources` array shape. (UX-10)
10. **Field-name parity:** spec must require the `catalogue/chains` resource to use the exact field names emitted by the `list_chains` tool. (UX-8)
