# MCP3 Prompts spec — Architecture Review

**Date:** 2026-05-22
**Persona:** Architecture Reviewer
**Spec under review:** `docs/2026-05-22-spec-mcp-prompts.md` (+ absorbed `spec-mcp-completions.md`)
**Context:** `spec-mcp-resources.md` (#1), `mcp-enhancement-proposals.md`, prior consolidations
`reviews/2026-05-22-MCP1-FEATURES/` and `reviews/2026-05-22-MCP2-COMPLETIONS/`
**Grounding (read-only):** `src/index.ts`, `src/analytics.ts`, `wrangler.toml`, `package.json`,
the jin skill `~/.jinn/skills/manamurah-price-analysis/SKILL.md`.
**Mode:** REVIEW ONLY — findings, no code changes.

---

## Executive summary

The spec is architecturally sound and well-disciplined. The static-template / data-free
`prompts/get` decision (§3) is correct, the co-located completer boundary (§11) follows MCP2's
recommendation cleanly, and the absorption of Completions into the prompt-argument surface is the
right structural call. The required-TypeScript section (§10) holds the type bar #1 set.

The dominant architectural risk is **skill-vs-prompt discipline drift**: the price-analysis
discipline — coverage thresholds, the four-verdict taxonomy, the 40–60-word Ringkas lede — now
exists verbatim in **both** the jin `manamurah-price-analysis` skill (`SKILL.md` §"Coverage
threshold" L588–636, lede L235–243, verdict L93–100/L240) **and** the MCP prompt template (§5/§6).
There is no shared source and no sync mechanism. This is the same drift class MCP1 flagged for the
tool/Python-ref schema (14-vs-15) and MCP2 flagged for the completer registry — the spec correctly
identifies the lens but does not yet resolve its own instance of it. I treat this as the headline
finding (High).

A second-order finding: the rendered prompt text **names 6 of the 15 tools by string** (§6:
`search_items`, `price_history`, `price_change`, `compare_prices`, `top_movers`, `find_cheapest`,
`fama_margin`). That couples free-text prompt strings to tool identifiers with no compile-time
link — rename a tool and the prompt silently misdirects the LLM. Worth a guard.

I also flag a shared-types decision the three specs are deferring: `PromptDef` (#3), `MCPResource`
(#1), `CompletionRef` (#2) are accreting per-spec with no `src/mcp-types.ts` home. The boundary is
defensible per-spec but a one-paragraph decision is owed.

**Overall rating: Low–Medium risk.** No Critical. One High (skill drift), the rest Medium/Low.
The roadmap collapse (#2 → #3) is clean and the #1 → #3 sequencing is correct. 2.9.0 is the right
bump *if* a 2.8.0 Resources release actually ships first (see F8 — version-ordering hazard).

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| F1 | **High** | Skill↔prompt discipline drift (thresholds/verdict/lede duplicated, no source of truth) | spec §5, §6; `SKILL.md` L588–636/L235–243 | Single-source the discipline numbers; cross-link skill ⇄ prompt; add a parity note + (cheap) CI assertion. See F1 detail for the recommended resolution. |
| F2 | Medium | Prompt-text → tool-name coupling is string-only, no compile-time link | spec §6 (template names 6 tools) | Reference the live `TOOLS` names when rendering, or add a CI check that every tool named in a template exists in `TOOLS`. |
| F3 | Medium | No shared `src/mcp-types.ts` — PromptDef/MCPResource/CompletionRef accrete per-spec | spec §10; #1 §4; #2 §6 | Decide explicitly: shared `mcp-types.ts` vs per-module. Recommend a thin shared module for the protocol-envelope types; keep domain defs (PromptDef, MCPResource) in their feature module. |
| F4 | Medium | Verdict taxonomy is a hardcoded literal in two layers (skill BM labels vs spec) — already subtly divergent | spec §5; `SKILL.md` L146 (`affirms\|rebuts\|partial`) vs L240 (`sahih/tidak tepat/separa tepat`) | Treat the BM verdict words as the shared constant; the skill's internal `affirms/rebuts/partial` is an English alias — document the mapping so neither side re-coins labels. |
| F5 | Low | `completions: {}` capability gating vs the two specs' diff baselines can collide | spec §9.1 vs #2 §5.1 vs #1 §3.1 | The three specs each show the capabilities object with a different baseline. Reconcile to one canonical post-#1 object in #3 since #3 ships last; state that #3's diff is authoritative. |
| F6 | Low | `prompts/get` content-shape ambiguity: "two blocks in one message (or two messages)" | spec §6 | Pick one. Recommend one `user` message with `[resource, text]` content array — simpler client contract, matches the embedded-resource intent. |
| F7 | Low | CSV `barang` arg (Q3) mid-string completion is a protocol/client unknown baked into v1 | spec §4, §16 Q3 | Don't ship the CSV-token completer until a client is verified to support mid-string completion; degrade to whole-value completion or repeated single-item prompt for v1. |
| F8 | Low | Version-ordering hazard: 2.9.0 assumes 2.8.0 (Resources) ships first; `package.json` is 2.7.0 now | spec §intro; `package.json:3`; `src/index.ts:74` | If #1 slips, #3 must not jump 2.7.0→2.9.0 leaving a phantom 2.8.0. Make the bump relative ("minor bump over whatever #1 lands") not absolute. |
| F9 | Info | Stale line anchors carried from earlier specs | spec §9, §17 | Capabilities are at `src/index.ts:667` + `:964`, dispatch `:736`, card `:909`, manifest `:952`, `prompts/list` stub `:744`. §9 already uses the right ones; §17 mixes — verify before implementation. |
| F10 | Info | "15 tools" is correct (contra MCP1's 14-vs-15) — don't regress it | `src/index.ts` TOOLS=15, card `:909` says 15 | The drift MCP1 flagged is resolved in code; the prompt spec should not reintroduce a "14" anywhere. |

---

## Detailed findings

### F1 (High) — Skill↔prompt discipline drift: the headline architectural risk

The spec §5 distils the price-analysis discipline into the prompt template, and §6 hardcodes it
into the rendered instruction text:

- Coverage thresholds — `n ≥ 30` headline, `n ≥ 100 national AND ≥ 10 per state`, `n ≥ 5`
  mention-with-caveat, `< 5 → data tidak cukup`.
- Verdict taxonomy — `sahih / tidak tepat / separa tepat / data tidak cukup`.
- Ringkas lede — 40–60 words, claim-first, bold verdict.

Every one of those values is **also** authored in the jin skill, independently:

- `SKILL.md` L611–614 — the identical threshold table (`n ≥ 30`, `n ≥ 100 … AND ≥ 10 per state`,
  `n ≥ 5`), L633 (`n < 5 → verdict data tidak cukup`).
- `SKILL.md` L240/L243 — the Ringkas lede definition (40–60 words, claim restatement first, bold
  verdict word).
- `SKILL.md` L240 — the BM verdict words.

This is a textbook duplication/drift surface, and it is **exactly the class the review brief asks
me to weigh** (same family as MCP1's 14-vs-15 tool/Python-ref drift and MCP2's completer-registry
drift). The danger is asymmetric and silent: the skill is edited far more often than a deployed
Worker (it is a living playbook with publish-pipeline coupling), so the skill's thresholds will
evolve and the embedded prompt template will quietly go stale. A consumer running
`semak-dakwaan-harga` from Claude.ai would then get a *different, older* discipline than the
in-house pipeline applies — and there is no signal that they diverged.

The spec is aware of the drift class (it cites it in the brief framing and §11 "no separate
registry — avoids a drift surface") but does not close its own largest instance.

**Recommended resolution (ranked):**

1. **Best — promote the discipline to the embedded methodology const and reference, don't restate.**
   #1 already ships `src/methodology.ts` as the single embedded methodology source, and §6 already
   embeds it as a `resource` block. Move the *numeric* discipline (the threshold table + the verdict
   taxonomy + the lede rule) into that one const, and have the §6 template **point at the embedded
   block** ("apply the coverage rules in the methodology above") rather than re-typing `≥30 / ≥100 /
   ≥10` inline. Then there is one authored copy of the numbers in this repo. The jin skill stays its
   own copy (it has pipeline-specific framing the MCP prompt deliberately drops, §5/§15), but it
   should **cite `manamurah://docs/methodology` as the canonical source** and carry a comment "keep
   in sync with methodology.ts". This collapses three template restatements to one and makes the
   skill a documented downstream consumer rather than a silent fork.

2. **Acceptable — accept duplication but make it observable.** Keep both copies but add (a) a
   reciprocal cross-link comment in both `SKILL.md` and `prompts.ts`/`methodology.ts`, and (b) a
   cheap CI/string assertion that the threshold tokens (`30`, `100`, `10`, `5`) and the four verdict
   words appear in the embedded methodology const. This doesn't prevent semantic drift but flags the
   day someone changes one side's number.

3. **Reject — leave undocumented.** This is the current spec state and the source of the finding.

The spec should also state the **direction of authority** explicitly: when the skill and the MCP
prompt disagree, which is canonical? My recommendation: the embedded `methodology.ts` const is the
canonical *published* discipline (it's the thing under MCP-client eyes and PR review); the skill's
pipeline steps are additive on top. Put that one sentence in §5.

### F2 (Medium) — Prompt-text → tool-name coupling

§6's template literally enumerates tool names inside an instruction string: `search_items`,
`price_history`, `price_change`, `compare_prices`, `top_movers`, `find_cheapest`, `fama_margin`.
These are free-text today — nothing links them to the actual `TOOLS` array in `src/index.ts`. If a
tool is renamed (the repo has form here: `chain_mom_movers` was added recently; renames are
plausible), the prompt text keeps naming the dead tool and the LLM is told to call something that
no longer exists. This is a weaker cousin of F1 (the prompt couples to a moving target with no
compile link).

**Recommend:** either interpolate the tool names from a shared `const TOOL_NAMES` (so a rename is a
compile error), or — lighter — add a CI assertion in the §13 test set: "every tool name string
appearing in a rendered prompt exists in `TOOLS`." The §13 suite already does
purity/`prompts/list` checks; this is one more cheap string-membership test on the same harness.

### F3 (Medium) — Shared types: is the design accreting coherently?

Three specs each introduce protocol types in their own module:
- #1: `MCPResource`, `ResourceContents`, `ResourceReadParams`, `CatalogueItem` (Resources spec §4).
- #2/§6 (now in #3): `CompletionRef` (discriminated union), `CompleteParams`, `CompleteResult`,
  `Completer`.
- #3 §10: `PromptArgument`, `PromptDef`, `PromptMessage`, `PromptContent`, `GetPromptParams`.

There is no `src/mcp-types.ts`. The accretion is *coherent per-spec* (each module owns its domain
shape), and that is a reasonable boundary — `PromptDef` genuinely belongs with `prompts.ts`,
`MCPResource` with the resource module. But two things cut across all three: (a) the JSON-RPC
envelope shapes (`MCPRequest`/`MCPResponse` already exist in `index.ts`), and (b) `CompletionRef`'s
`ref/prompt` arm references prompt *names* that `PromptDef` owns — so #3's completion handler must
import a type defined for #2's machinery and resolve it against #3's `PROMPTS`. That cross-module
reference is the seam where a thin shared module pays off.

**Recommend:** the spec should make a one-paragraph explicit decision rather than letting it
default. My lean: keep domain defs in their feature module (`PromptDef` in `prompts.ts`,
`MCPResource` in the resource module) but put the **protocol-shared** types — `CompletionRef`,
`CompleteParams`/`CompleteResult`, and the request/response envelopes — in a `src/mcp-types.ts` so
the completion handler and the prompt module share one `CompletionRef` definition instead of one
re-declaring the other's. This is the minimal shared surface that prevents the `ref/prompt`
contract from being typed twice.

### F4 (Medium) — Verdict taxonomy is already subtly divergent across the two sources

The skill carries the verdict in **two encodings**: an English internal triplet `affirms | rebuts |
partial` (`SKILL.md` L146) used in the deception/screen logic, and the BM publication labels
`sahih / tidak tepat / separa tepat` (L240) plus `data tidak cukup` / `data-insufficient`
(L89/L240). The spec §5 hardcodes only the BM four-tuple. So there is already a mapping
(`affirms↔sahih`, `rebuts↔tidak tepat`, `partial↔separa tepat`, `data-insufficient↔data tidak
cukup`) that lives nowhere as a single artefact. If the skill ever adds a fifth verdict (the brief's
"deception screen" already has `monitor`/`ignore`/`engage` outcomes that the prompt deliberately
omits), the prompt's closed four-tuple silently lags.

**Recommend:** fold the verdict taxonomy into the same single-source decision as F1 (put the BM
labels in `methodology.ts`), and document the English-alias mapping once. The MCP prompt's scope
correctly excludes the screen outcomes (§5/§15) — just make that exclusion explicit so a reader
doesn't think the prompt is missing verdicts.

### F5 (Low) — Capabilities-diff baselines disagree across the three specs

- #1 §3.1 diffs to `resources: { listChanged: false }`.
- #2 §5.1 diffs to add `completions: {}` on top of a `resources: { listChanged: false }` base.
- #3 §9.1 diffs to `prompts: { listChanged: false }, resources: { listChanged: false },
  completions: {}`.

Each is internally right, but they're three different "before" states. Since #3 ships **last and
absorbs #2**, #3's §9.1 object is the one that will actually land. State that explicitly: "#3 §9.1
is the authoritative final capabilities object; #1 and #2's diffs are intermediate." Otherwise an
implementer applying them in sequence has to reconcile three overlapping diffs by hand.

### F6 (Low) — `prompts/get` content shape: pick one

§6 says the result is "two content blocks in one `user` message (or two messages)." Leaving it
optional pushes a contract decision onto the implementer and risks per-prompt inconsistency.
**Recommend** one `user` message whose `content` is the `[{type:'resource',…},{type:'text',…}]`
pair (when methodology is embedded) — the MCP `messages[].content` field takes a content object;
clients render a single user turn with both blocks. Per §16 Q2, basket/compare may drop the
resource block and carry text only. Make the shape uniform: always one `user` message, content
array of 1–2 blocks.

### F7 (Low) — CSV `barang` mid-string completion is an unverified protocol assumption (Q3)

§4 + §16 Q3 propose a CSV `barang` arg for `basket-bulanan` with the completer completing "the last
token." Mid-string / partial-token completion against a flat string→string arg is **not a
guaranteed client behaviour** — the `completion/complete` contract returns whole verbatim values to
insert as the argument value (MCP2 §2: "values are inserted verbatim"), so a client that replaces
the entire arg value with a single completion would clobber the earlier CSV tokens. This is an
architecture risk hiding in an open question.

**Recommend:** do not ship CSV-token completion in v1. Either (a) make `barang` a single item for
`basket-bulanan` v1 and defer multi-item, or (b) accept CSV with **no** completer on that arg
(completion is opt-in per-arg). Revisit only after verifying a real client (Claude.ai/Desktop)
handles mid-value completion without clobbering.

### F8 (Low) — Version-ordering hazard

`package.json:3` and `src/index.ts:74` are both `2.7.0` *today* (the chain_mom_movers release). The
#1 Resources spec claims `2.7.0` for itself, while #3 asserts "2.8.0 reserved for Resources;
2.9.0 = Prompts." There is a numbering collision: 2.7.0 is already consumed. So #1 Resources must
actually land as **2.8.0** (not 2.7.0 as its own spec says — that spec predates the chain_mom_movers
bump), and #3 as 2.9.0 only holds **if** #1 ships first. If #1 slips and #3 lands first, jumping
2.7.0 → 2.9.0 leaves a phantom 2.8.0.

**Recommend:** express #3's bump *relative* — "minor bump over whatever #1 lands as" — and note the
2.7.0-already-shipped collision so #1's spec gets corrected to 2.8.0. Cheap to fix, annoying if missed.

### F9 / F10 (Info) — Anchors and tool count

§9 uses the correct current anchors (`:667`, `:736`, `:909`, `:952`, `:744`); §17's "Code anchors
(current)" list largely matches but should be spot-verified at implementation (capabilities `:667`
+ `:964`, `prompts/list` stub `:744`, dispatch `:736`). Separately, the live code has **15** tools
and the server card already says 15 — the MCP1 "14 vs 15" drift is resolved in code; the prompt
spec must not reintroduce a "14" in any new discovery surface.

---

## Open-question answers (through the architecture lens)

**Q4 — Should `prompts/get` ever embed the live catalogue, or stay data-free?**
Stay **data-free** (the spec's lean is correct). Embedding a live item list into `prompts/get`
re-introduces the exact upstream coupling §3 rejects: latency on a hot path, the ES-cost risk the
reviews keep flagging, and instant staleness. The architecture already has two better channels for
"what items exist": the #1 catalogue **resource** (the agent loads it as ambient context) and the
**completers** (keystroke-time, embedded, zero-network). A prompt is a *task template*, not a data
carrier — embedding the catalogue would blur the noun/verb boundary #1 §7 established. Keep
`prompts/get` = pure string assembly + the embedded methodology const.

**Q5 — Are 3 prompts the right scope for one release?**
Yes — ship 3. The three chosen (`semak-dakwaan-harga`, `basket-bulanan`, `banding-bandar-vs-nasional`)
are non-overlapping task archetypes (fact-check / aggregate / compare) that exercise distinct tool
sets, so they validate the architecture broadly without bloating the surface. The real scope
concern for this release is **not** prompt count — it's that #3 absorbs prompts **+** completions
**+** the discipline encoding in one go (see roadmap note). Holding prompts to 3 keeps the absorbed
load reviewable. Defer `cari-termurah`/`trend-tahunan`/FAMA prompts (§15) until the 3 prove out and
the F1 single-sourcing is in place — otherwise every new prompt multiplies the drift surface.

**The skill-vs-prompt drift — recommended resolution (the brief's central question):**
**Single-source the numbers into the embedded `methodology.ts` const; make the jin skill a
documented downstream consumer; reciprocal cross-link; cheap CI token-assertion.** Do not accept
silent duplication, and do not try to make the MCP prompt import the jin skill (wrong direction —
the skill is a private playbook with publish-pipeline coupling the portable prompt deliberately
sheds). The portable, PR-reviewed `methodology.ts` const is the natural canonical home for the
*published* discipline; the skill cites it. This converts an invisible fork into an explicit,
testable dependency. (Full ranking in F1.)

**Roadmap collapse (#2 → #3) and #1 → #3 sequencing — is #3 over-reaching?**
The collapse is **clean** — MCP2's "completion is a facet of a prompt argument" is correct, and
co-locating completers on the prompt-arg def (§11) is the right boundary; it avoids the separate
`COMPLETERS` registry that would itself be a drift surface. `prompts/get` (render) and
`completion/complete` (completers) share the `PromptDef` cleanly: render reads `PromptDef.render`,
the completion handler resolves `(ref/prompt:name, argName)` → the completer hanging off that
prompt's argument. One owner, two read paths. The #1 → #3 sequencing is correct (#3 hard-depends on
#1's embedded consts).

The **one over-reach risk**: #3 ships prompts + completions + the discipline single-sourcing in a
single release. That's three architectural concerns at once. It's acceptable *because* completions
have no surface without prompts (so they can't ship separately) and the discipline encoding is
intrinsic to what a prompt *is*. But it makes F1 (single-sourcing) a **release-gating** concern, not
a nice-to-have: if you ship the prompts with inline restated thresholds now, you bake the drift in
on day one and the fix becomes a follow-up that may never come. Do F1 in the same PR.

---

## Spec change requests

1. **[F1, High] Add a §5.1 "Single source of discipline" subsection.** State that the threshold
   table, verdict taxonomy, and Ringkas-lede rule live in **one** place — the embedded
   `methodology.ts` const — and that §6's template *references* the embedded block rather than
   restating `≥30/≥100/≥10/5`. Add a reciprocal cross-link requirement in the jin
   `manamurah-price-analysis` skill ("canonical numbers: `manamurah://docs/methodology`"). Make the
   discipline single-sourcing **part of the #3 PR**, not a follow-up.

2. **[F1/F4] Add to §13 testing** a token-level CI assertion: the four BM verdict words and the four
   threshold numbers appear in the embedded methodology const (drift tripwire).

3. **[F2] Add to §13** a CI assertion that every tool name string appearing in any rendered prompt
   exists in `TOOLS` (prompt-text → tool-name parity), and/or interpolate tool names from a shared
   const in §10/§11.

4. **[F3] Add a §10 sentence** deciding the shared-types boundary: protocol-shared types
   (`CompletionRef`, `CompleteParams`/`Result`, request/response envelopes) in `src/mcp-types.ts`;
   domain defs (`PromptDef`) stay in `prompts.ts`. Resolve the duplicate `CompletionRef` declaration
   between #2 §6 and #3.

5. **[F5] Mark §9.1 as the authoritative final capabilities object**, superseding #1/#2's
   intermediate diffs.

6. **[F6] §6 — fix the message shape** to one `user` message with a 1–2-block content array (resource
   + text); drop the "or two messages" option.

7. **[F7] §16 Q3 / §4 — pull CSV-token completion out of v1.** Ship `basket-bulanan` with single-item
   `barang` (or CSV with no completer) until mid-value completion is verified against a real client.

8. **[F8] §intro — make the version bump relative** ("minor over whatever #1 lands"), and correct the
   #1 Resources spec's stale `2.7.0` → `2.8.0` (2.7.0 is already shipped per `package.json:3`).

9. **[F9] Spot-verify §17 anchors** before implementation; §9's are current.
