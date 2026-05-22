# UX / Accessibility Review — MCP Completions spec

**Date:** 2026-05-22
**Persona:** UX / Accessibility Reviewer. For an MCP server, "UX" = the experience of (a) the AI agent consuming the protocol and (b) the human typing in a completion-capable client (Claude.ai web + mobile, Claude Desktop). Accessibility = whether the autocomplete is usable across input languages/locales, on small screens, and without prior knowledge of catalogue codes.
**Scope:** `docs/2026-05-22-spec-mcp-completions.md` (primary). Context: `docs/2026-05-22-spec-mcp-resources.md`, `docs/2026-05-22-mcp-enhancement-proposals.md`. Grounding (read-only): `src/index.ts`, `README.md`.
**Constraint:** Review only — no code/spec edits.

---

## Executive summary

The spec is unusually self-aware for a UX surface: it has already absorbed the single biggest UX trap — the proposal's framing ("autocomplete the **tool** parameters") is impossible in MCP, and the spec leads with that correction (Headline, §2). That alone prevents the worst outcome: shipping a feature the user can never see. The remaining UX questions are about *where* the machinery attaches, *what strings* get inserted, and whether a Malay-only catalogue silently excludes English typists.

From the user's chair, completion is a near-invisible affordance: it only fires while typing a **prompt argument** (or, later, a resource-template argument). It is never advertised, never discoverable, and produces no visible artifact when idle. That makes the *sequencing* decision (Open Q1) a pure-upside / pure-downside fork: co-shipped with Prompts (#3) it is delightful and zero-friction; shipped alone it is genuinely invisible — not confusing, just **dead weight with a maintenance cost and a misleading `capabilities.completions` advertisement**. I land firmly on co-ship.

The one real UX *hole* — not polish — is the English-typist gap (Open Q3). The Resources decision deliberately strips `name_en`/zh/ta from the catalogue (Resources §2, §9) to save tokens, and this spec's completers read that flat Malay-only catalogue (§4, §7). So a human (or agent) typing "watermelon", "chicken", "rice" into a prompt's `item` field gets `{values:[]}` — an empty dropdown that looks like a broken feature, when in fact the data exists one tool-call away in `search_items`. The README's own headline examples are bilingual ("what's the cheapest chicken in KL"), so this is a first-contact failure mode for exactly the audience the README courts.

Everything else is sound: empty-not-error states (§5.2, §10) are correct UX; mobile payload size is a non-issue; the `{item_code}` template should stay uncompletable (Open Q2 — a code-completer that shows names but inserts numbers is a textbook mode error).

**Overall UX rating: Medium.** No Critical (the headline correction defuses the only would-be-Critical). One High (English-typist empty-dropdown gap), one High (silent inert capability if shipped standalone), the rest Medium/Low/Info.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| UX-1 | High | English/locale typists hit an empty dropdown — Malay-only catalogue excludes the README's own example queries | spec §4, §7; Resources §2/§9; `src/index.ts:143` | Add a `name_en`-aware completer path (alias map) OR document the limitation in the prompt arg description so the empty state is expected, not a bug |
| UX-2 | High | Inert capability if shipped standalone — `capabilities.completions:{}` advertises a feature with zero attachable surfaces | spec §3, §6 (5.2 std-alone scaffolding), Open Q1 | Do NOT ship standalone. Co-ship with #3 (Prompts). If scaffolding lands early, gate the capability advertisement on ≥1 registered completer |
| UX-3 | Medium | `{item_code}` template completion is a mode error (shows names, inserts numbers) | Open Q2; spec §2, §3 | Confirm: leave template uncompletable. Name→code resolution stays in `search_items`. Documented here as the UX rationale |
| UX-4 | Medium | State completer case-sensitivity mismatch — tools demand exact case (`Case-sensitive.`) but the spec doesn't state completers return canonical-cased values | spec §4 (state row), §6; `src/index.ts:126` | Make explicit: state/chain/category completers MUST return canonical-cased strings (the value the downstream arg requires verbatim) |
| UX-5 | Medium | No diacritic / fold guarantee in the user-facing direction is stated for items | spec §6 (fold mentioned for matching, not for display value) | Confirm fold applies to the *match*, while the *inserted value* is the catalogue's canonical name; add an item example to §10 tests like the `pul`→`Pulau Pinang` one |
| UX-6 | Low | "≤100 values" with `hasMore:true` gives the user no way to narrow except keep typing — acceptable, but no UX guidance | spec §2, §5.2 | Note in spec that `hasMore` is informational; ranking (prefix-boost) is what makes the top-of-list useful on mobile. Already mostly covered by §6 ranking |
| UX-7 | Low | Telemetry never records the typed partial (good), but also can't measure empty-result rate by *what users typed* — limits ability to detect the UX-1 gap in production | spec §5.3 | Record a coarse `matchCount==0` boolean + ref+arg so the English-typist gap is *measurable* without logging the value |
| UX-8 | Info | Discoverability: nothing to advertise in tool descriptions — confirmed correct | spec §5.4 | No change. Completion is a typing-time affordance; surfacing it in tool prose would mislead agents into thinking tool args complete |
| UX-9 | Info | Empty/no-match returns `{values:[],hasMore:false}` not an error — confirmed correct UX | spec §5.2, §10 | No change. Matches MCP intent; an error here would surface as a client-side failure toast for a normal "no suggestion yet" state |

---

## Detailed findings

### UX-1 (High) — English typists hit an empty dropdown

This is the only finding I'd call a genuine *hole* rather than a refinement.

The chain of decisions:
1. Resources spec §2/§9 deliberately strips `name_en`, zh, ta from `catalogue/items` to keep standing context lean (~16 K vs ~45 K tokens). Reasonable for a *resource*.
2. This spec §4 + §7 builds the `item` completer over **that same flat Malay-only list** and explicitly rejects backing completion with `search_items` (the one component that *does* know "watermelon" = "TEMBIKAI") for cost reasons.
3. Net effect: a user typing into a prompt's `item` argument in English gets `{values:[]}`.

Why this is High, not Medium:
- The **README's own headline examples are English** ("what's the cheapest chicken in KL this week?", line 40) and bilingual ("harga tembikai…"). The product markets itself to English speakers. An English speaker's *first* interaction with the autocomplete returns nothing.
- An empty dropdown is read by humans as **"this feature is broken"**, not "type in Malay." There is no in-band signal telling them to switch languages. This is precisely the accessibility failure mode — the affordance silently excludes a language group.
- The agent UX is also degraded: the agent may interpret an empty completion as "no such item" and give up or hallucinate, rather than falling through to `search_items`.

The spec's Open Q3 leaning ("start with prefix+substring; revisit on telemetry") is the wrong instinct *for this specific gap*, because (a) §5.3 telemetry deliberately never logs the typed value, so you **cannot** detect "users typed English and got nothing" from telemetry as specified (see UX-7), and (b) the cost objection to `search_items` (§7) is about per-keystroke ES round-trips — it does not apply to a small in-memory **alias map** (English/common-name → canonical Malay name) shipped alongside the catalogue.

Recommended fix (cheapest first):
- **Minimum:** add to the #3 prompt `item` argument description a literal hint: "type the item name in Malay (e.g. `tembikai`, `ayam`, `beras`)." This converts a silent empty state into an *expected* one. Cheap, no new data.
- **Better:** ship a small static English→Malay alias table (the top ~100 staples — ayam/chicken, beras/rice, tembikai/watermelon, telur/egg…) folded into the item completer's match keys, still in-memory, still zero ES calls. The completer matches on alias keys but **returns the canonical Malay name** (the value the prompt arg wants). This is the bilingual-search win without the per-keystroke cost.
- This should be called out as an explicit cross-reference: the Resources spec's token-saving exclusion of `name_en` has a **downstream UX cost on Completions** that the Resources review didn't price in.

### UX-2 (High) — inert capability if shipped standalone

The spec is honest that completion "has no surface to attach to" until Prompts/Resources-v2 exist (§2 headline), and offers a path where "the completion *machinery* … can land first as inert scaffolding" (§3, §6 of body / §11). From a UX lens this standalone path is **net-negative**:

- A client that reads `capabilities.completions:{}` in `initialize` may surface a UI affordance or behavioural assumption ("this server completes arguments") that is then **never satisfied** — there are zero completable refs. That is a worse UX than not advertising at all: it's a promise with no payload.
- There is no user-visible benefit to the scaffolding. Unlike a half-built tool (which at least shows up in `tools/list`), inert completion machinery is invisible *and* useless *and* carries a misleading capability flag.
- It adds a maintained code path (handler, registry, telemetry field) and a protocol-version conversation (§8) for zero user value until #3 lands.

**Strong opinion:** do not ship #2 standalone. Co-ship with #3 (Prompts), exactly as the spec recommends in §3/§12-Q1. If there is an engineering reason to land scaffolding early (e.g. to de-risk the handler), then **gate the `capabilities.completions` advertisement** on the registry being non-empty — never advertise a capability you can't fulfil. That single guard turns "harmful inert" into "harmless dormant."

The other reviewed surface, the Resources-v2 `{item_code}` template, is too weak to count as a real co-ship target (see UX-3), so Prompts (#3) is the *only* sequencing partner that delivers user value.

### UX-3 (Medium) — `{item_code}` template completion is a mode error

Open Q2 asks whether a future `{item_code}` template should get a completer returning `"123 — TEMBIKAI…"` display strings, or stay uncompletable. From the user's mental model:

- MCP completion `values` are **the strings inserted verbatim** as the argument value (spec §2 implication). If the completer returns `"123 — TEMBIKAI MERAH"`, that whole string gets inserted into a `{item_code}` slot that wants a bare integer. The resource read then fails validation (Resources §10 demands `^[0-9]{1,7}$`).
- If instead the completer returns bare `"123"`, the dropdown shows the user a list of **naked numbers** with no way to tell which is watermelon — useless to a human, and an agent typing a name gets nothing.
- Either way it's a **mode error**: the thing the user reads is not the thing that gets inserted, or the thing inserted is unreadable. Classic UX anti-pattern (the "looks like a label, behaves like a value" trap).

**Recommendation:** confirm the spec's leaning — leave the `{item_code}` template **uncompletable**. Name→code resolution is `search_items`' job (and the prompt `item` completer already covers name-typing for the prompt path). Do not build a code-completer. If discoverability of items-by-name on the resource side is ever wanted, the right fix is a *name-keyed* resource URI, not a code-completer with display strings.

### UX-4 (Medium) — state/chain/category completers must return canonical case

`src/index.ts:126` (`STATES_HINT`) tells the tool layer state names are **`Case-sensitive.`** The spec §4 says the state completer returns "canonical state names (e.g. `Selangor`, `W.P. Kuala Lumpur`)" — good — but does not state as a **MUST** that the returned value is byte-for-byte what the downstream prompt/tool requires. If a completer ever returned a folded/lowercased form (the §6 matching is case-insensitive + ASCII-fold), the inserted value would silently fail downstream.

**Recommendation:** spec should state explicitly: matching is fold-insensitive, but the **returned `value` is always the canonical catalogue casing** — the exact string the consuming argument needs verbatim. Add a test mirroring the existing `pul`→`Pulau Pinang` one but asserting the *casing* of the returned value.

### UX-5 (Medium) — diacritic/fold direction for item display values

§6 says matching ASCII-folds (`pulau pinang` matches `Pulau Pinang`) — good for the *input* side. The spec doesn't explicitly say the **inserted value** is the un-folded canonical name. Same class as UX-4 but for items. Confirm + add an item test to §10.

### UX-6 (Low) — `hasMore` UX with 100-cap

When >100 items match (e.g. typing a single letter), the user sees a truncated list with `hasMore:true`. The only narrowing path is to keep typing. That's acceptable and standard, but the **ranking** (§6 prefix-boost over substring) is what makes the visible top-100 useful — especially on mobile where only ~5 rows are visible. The spec already specifies ranking; just affirm it's load-bearing for the truncated case, not optional polish.

### UX-7 (Low) — telemetry can't measure the UX-1 gap

§5.3 correctly refuses to log the typed partial (privacy/cardinality). But that means you cannot answer "how often do users type something that returns zero matches" — which is exactly the signal you'd need to confirm/deny UX-1 in production, and the spec's Q3 leaning ("revisit on telemetry") *depends* on having that signal. Add a coarse, value-free counter: record `matchCount` (or just a `zeroMatch` boolean) alongside the existing ref+arg. Zero matches on a populated catalogue is a strong UX-failure signal without logging anything sensitive.

### UX-8 (Info) — discoverability is correctly a non-issue

Completion is a typing-time affordance the client renders; there is nothing to advertise in tool descriptions, and §5.4 correctly makes no tool/resource prose changes. Adding "this argument autocompletes" to a tool description would actively mislead, since tool arguments do **not** complete in MCP. Confirmed: no UX gap here.

### UX-9 (Info) — empty-not-error is correct

Returning `{values:[],hasMore:false}` for unknown args / no matches (§5.2, §10) is the right call. An error code (`-32601`/`-32602`) for "no suggestion right now" would surface in some clients as a failure toast/log line for an entirely normal typing state. Reserving `-32602` for *malformed* refs only (§5.2) is the correct boundary. Confirmed good UX.

---

## Open question answers

**Q1 — Sequencing (strong opinion):** **Co-ship #2 with #3 (Prompts). Do not ship standalone.** Standalone, completion is not merely "harmless inert" — it advertises `capabilities.completions:{}` to clients while having literally zero completable refs, which is a promise with no payload (UX-2). The user-visible value is *strictly zero* until name-typed prompt arguments exist; the `{item_code}` template is too weak to count. If scaffolding must land early for engineering reasons, gate the capability advertisement on a non-empty completer registry so you never advertise what you can't fulfil.

**Q2 — `{item_code}` template completion:** **Leave it uncompletable.** A code-completer is a mode error: returning `"123 — TEMBIKAI…"` inserts an invalid value into a numeric slot (fails the `^[0-9]{1,7}$` contract); returning bare `"123"` shows the user unreadable naked numbers. The inserted value (a code) can never match what a name-typist reads. Name→code resolution belongs to `search_items`; the prompt `item` completer already serves name-typing. Build no code-completer.

**Q3 — Fuzzy quality + Malay-only-catalogue for English typists:** **Yes, this is a real UX hole, not just polish (UX-1).** ASCII-fold + prefix/substring is fine *within Malay*, and typo-tolerance (trigram) is genuinely deferrable. But the Resources decision to strip `name_en`/zh/ta from the catalogue means an English typist ("watermelon", "chicken", "rice") gets an empty dropdown — and the README markets English queries as a headline use case. Fix is cheap and stays in-memory (no per-keystroke ES): either (a) document the Malay-only expectation in the prompt arg description, or preferably (b) ship a small static English→Malay alias map folded into the item completer's match keys while still returning the canonical Malay name. Crucially, the spec's "revisit on telemetry" plan can't even *see* this gap as written (§5.3 logs no value) — so add a value-free `zeroMatch` counter (UX-7) before relying on telemetry to decide.

---

## Spec change requests

1. **§4 / §7 + new cross-ref to Resources §2/§9:** Add the English-typist gap (UX-1) as a named risk and adopt at minimum the prompt-arg-description hint; preferably the static English→Malay alias map (in-memory, no ES). State explicitly that the Resources `name_en` exclusion has a downstream Completions UX cost.
2. **§3 / §12-Q1:** Make co-ship with #3 normative. If scaffolding lands early, add a MUST: gate `capabilities.completions` advertisement on a non-empty completer registry (UX-2).
3. **§12-Q2:** Promote the "leave `{item_code}` uncompletable" leaning to a decision, with the mode-error rationale (UX-3).
4. **§4 / §6 / §10:** Add a MUST that all completers return canonical-cased / un-folded **values** (the verbatim string the consuming argument requires), independent of the fold-insensitive matching. Add tests asserting returned-value casing for state and item (UX-4, UX-5).
5. **§5.3:** Add a value-free `zeroMatch`/`matchCount` telemetry field so the UX-1 gap and Q3's "revisit on telemetry" plan are actually measurable (UX-7).
6. **§5.4:** Affirm (no change) that discoverability is intentionally absent and tool-description prose must NOT claim argument autocomplete (UX-8).
