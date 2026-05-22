# UX / Accessibility Review — MCP Prompts spec

**Date:** 2026-05-22
**Persona:** UX / Accessibility Reviewer. For an MCP server, "UX" = the experience of (a) the **human** invoking the prompt — typically as a slash command in Claude.ai / Claude Desktop / ChatGPT, including mobile — and (b) the **agent** that executes the returned instruction by chaining tools. Accessibility = whether the prompt is discoverable and usable across input languages (BM / English), across clients, and on small screens.
**Scope:** `docs/2026-05-22-spec-mcp-prompts.md` (primary). Context: `docs/2026-05-22-spec-mcp-completions.md` (completion on prompt args — absorbed), `docs/2026-05-22-spec-mcp-resources.md`, `README.md`. Grounding (read-only): `src/index.ts` (tool tone), `README.md`, `~/.jinn/skills/manamurah-price-analysis/SKILL.md` (source discipline being distilled).
**Constraint:** Review only — no code/spec edits except this file.

---

## Executive summary

This is a strong, ship-ready spec from a UX standpoint. The core decision — `prompts/get` returns *instructions* that drive the LLM to run the manamurah tools, data-free (§3) — is exactly right for the slash-command mental model and keeps the latency-sensitive "expand the command" step instant. The encoded discipline (verdict taxonomy, coverage thresholds, Ringkas lede — §5) is the spec's best UX asset: it turns a one-click command into trustworthy, scannable output, and it correctly drops the jin-specific publish pipeline that has no place in a portable prompt (§5, §15). The English-typist gap that dominated the MCP1/MCP2 reviews is **already closed at the source** here — Resources now carries required `name_en` and the `barang` completer matches on it (§7), so "watermelon" → `TEMBIKAI…`. That removes the one prior High.

The remaining UX work is **copy and expectation-setting**, not architecture. Three issues rise above polish:

1. **The "nothing happened immediately" gap (UX-1, High).** A user who invokes `semak-dakwaan-harga` sees a prompt expand into a wall of methodology + instructions, then the agent silently runs ~5–10 tool calls. Nowhere in the spec does the *rendered text* address the human reader — it is written entirely as agent instructions. The human who sees the expansion (most clients show it) gets no "I'm checking PriceCatcher data now, one moment" framing and may think the command is inert or broken.

2. **Title/description copy is gisted, not literal (UX-2, High).** The spec gives titles (§4) but leaves `description` strings — the *only* bridge for an English-speaking Claude.ai/ChatGPT user scanning a Malay-named slash-command list — unspecified. MCP1 made literal `resources/list` copy a mandatory pre-merge change for exactly this reason; Prompts needs the same bar.

3. **The Ringkas verdict word `tidak tepat` (UX-5, Medium).** The encoded verdict taxonomy is good and trustworthy, but `tidak tepat` ("inaccurate") sits adjacent to the jin house rule (recorded in project memory) to prefer "mengelirukan"/"salah tafsir" over accusatory framing. Worth a deliberate copy decision since this word is *bolded* and is the scannable payload.

Everything else is Low/Info: completion on `barang`/`negeri` materially helps (§7), required/optional split is sensible, mobile payload is a non-issue for a one-shot expansion, and the CSV-basket open question (Q3) is a real but bounded completer-UX wrinkle.

**Overall UX rating: Medium-High** (would be High with literal description copy + a one-line human-facing preamble in the rendered text). No Critical. Two High (both copy/framing, cheap to fix), the rest Medium/Low/Info.

---

## Findings table

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| UX-1 | High | "Nothing happened" — rendered prompt addresses only the agent; the human who sees the expansion gets no "I'm working" framing | spec §3, §6 | Lead the rendered `text` with one human-facing sentence ("Saya akan semak dakwaan ini terhadap data PriceCatcher / I'll check this against PriceCatcher data — sekejap.") before the agent instructions |
| UX-2 | High | `description` strings unspecified — the only bridge for English-speaking users of a Malay-named slash command | spec §4, §9.2; cf. Resources §2 (literal copy mandatory) | Make literal bilingual `description` copy normative in §4, same bar MCP1 set. Each must say what the prompt does + that output is BM |
| UX-3 | Medium | `dakwaan` free-text arg under-explained for the user-facing field | spec §4, §6, §12 | Specify literal arg `description`: what to paste (the viral claim / headline text), an example, and that it can be BM or EN |
| UX-4 | Medium | Verdict taxonomy uses `tidak tepat` in some places, `data tidak cukup` vs `data-insufficient` in others — inconsistent encoded strings | spec §4, §5, §6 vs source skill | Pin the exact four verdict strings once (normative), reuse verbatim everywhere the template bolds them |
| UX-5 | Medium | `tidak tepat` ("inaccurate") as the bolded verdict word — tonal mismatch with house "mengelirukan/salah tafsir" guidance | spec §5, §6; cf. jin memory `feedback_tone_malay` | Deliberate copy decision: keep `tidak tepat` (neutral-journalistic, defensible) but document the choice; avoid drift to "menipu" |
| UX-6 | Medium | Q3 CSV `barang` for `basket-bulanan` — per-token completion of a CSV string is a fragile client UX | spec §4, §16 Q3 | Confirm completer completes the *last* token only; set the arg `description` to show the CSV format literally ("ayam, beras, telur"); flag if a target client can't mid-string complete |
| UX-7 | Medium | Prompt set may be missing the highest-intent task — "where's cheapest" | spec §4, §16 Q5, §15 | Add `cari-termurah` as the 4th v1 prompt (rationale in Open Q5 below); it is the README's headline use case and the lowest-discipline / highest-volume query |
| UX-8 | Low | Embedded methodology in `prompts/get` adds bulk to the expansion the user may see (mobile) | spec §6, §16 Q2 | Acceptable; embed methodology only where it earns its place (fact-check + compare), one-line coverage note for basket — matches the §16 Q2 lean |
| UX-9 | Low | Required/optional arg split is sensible but the *effect* of omitting optional `barang`/`negeri` isn't surfaced to the user | spec §4, §6 | The template already branches (`{if barang}…{else}resolve with search_items{/if}`) — good; mirror that branch into the arg `description` so the user knows omission is safe |
| UX-10 | Info | Completion on `barang`/`negeri` materially helps; English-typist gap closed at source | spec §7; Resources §2 | No change. `name_en`-aware `barang` completer + verbatim-cased `negeri` is the right call |
| UX-11 | Info | Slash-command discoverability of Malay names is good for the core audience | spec §4 | No change. Malay names + bilingual titles/descriptions (UX-2) is the right balance |

---

## Detailed findings

### UX-1 (High) — The "nothing happened immediately" gap

This is the most user-visible issue and it is a framing problem, not an architecture one.

Mental model of a slash command in Claude.ai / Desktop / ChatGPT: the user types `/semak-dakwaan-harga`, fills `dakwaan`, hits enter, and expects *something to happen*. What the spec produces (§6) is a `user` message containing (1) an embedded methodology resource block and (2) a templated instruction written entirely in the imperative addressed to the model ("Fact-check this claim… Gather evidence with the manamurah tools… Apply coverage rules…"). Most clients render the expanded prompt to the user before/while the model acts. So the human's first experience is a wall of *instructions to a third party* plus a methodology doc — and then a pause while the agent runs 5–10 tool calls with no narration.

Two failure modes:
- **Perceived inertness.** A non-technical user reads instruction text addressed to "you" (the model) and isn't sure anything is running. On mobile, the methodology block pushes the actual claim and any acknowledgement off-screen.
- **No expectation of latency.** Chaining `search_items` → `price_history` → `compare_prices` → `top_movers` etc. is several seconds. Without a "one moment, checking PriceCatcher data" beat, the gap reads as a hang.

Fix is one sentence. Lead the rendered `text` block with a short, human-readable, bilingual-friendly preamble that doubles as a model instruction to *acknowledge before working*:

> "Saya akan menyemak dakwaan ini terhadap data PriceCatcher Malaysia — beri saya sekejap untuk kumpul bukti. (I'll check this claim against Malaysian PriceCatcher data — one moment while I gather the evidence.)"

This costs nothing (still data-free, still pure string assembly), sets latency expectation, tells the human the command is live, and nudges the model to emit an acknowledgement turn before the tool storm. Add an explicit "begin with a one-line acknowledgement to the user, then run the tools" directive to the instruction body.

### UX-2 (High) — `description` strings are gisted, not literal

§4 gives good `title` strings ("Semak dakwaan harga (fact-check a price claim)") — the bilingual title pattern is exactly right and should be praised. But `prompts/list` returns `{ name, title?, description?, arguments? }` (§2), and the spec never pins the `description` copy. For an English-speaking user of Claude.ai or ChatGPT scrolling a slash-command palette, the `name` (`semak-dakwaan-harga`) is opaque and the `title` is half-Malay; the `description` is the **only** place to fully bridge. MCP1 made literal `resources/list` copy a *mandatory pre-merge change* (Resources §2 "Literal copy is normative") for precisely this discoverability reason — Prompts must match that bar. Recommend §4 carry normative `description` strings, e.g.:

- `semak-dakwaan-harga`: "Fact-check a Malaysian price claim or viral headline against official PriceCatcher data. You provide the claim; the assistant pulls the evidence, applies coverage thresholds, and returns a verdict (output in Bahasa Melayu)."
- `basket-bulanan`: "Total a basket of grocery items' current vs prior-month cost from PriceCatcher and flag the biggest movers (output in Bahasa Melayu)."
- `banding-bandar-vs-nasional`: "Compare one item's price in a chosen state vs the national average, with a data-coverage caveat (output in Bahasa Melayu)."

The "(output in Bahasa Melayu)" tag is important — it sets language expectation up front (ties to Open Q1).

### UX-3 (Medium) — `dakwaan` free-text arg under-explained

`dakwaan` is the one arg a user must type from scratch (no completion). The spec marks it "req, free text" (§4) and discusses its injection trust boundary well (§12), but never specifies the user-facing `description`. A user staring at an empty `dakwaan` field needs to know *what* to paste. Recommend a literal arg description: "The price claim to check — paste the viral message, headline, or statement (Bahasa Melayu or English). Example: 'Harga ayam naik 40% bulan ni di Selangor.'" Without this, the field's purpose is ambiguous on first contact.

### UX-4 (Medium) — Verdict-string inconsistency

The four verdict labels appear with slightly different surface forms across the spec: §4 "(sahih/tidak tepat/separa tepat/data tidak cukup)", §5 verdict taxonomy "`data tidak cukup`" but elsewhere the source skill uses `data-insufficient`. Since the verdict word is the *bolded, scannable payload* a user trusts, the exact four strings must be pinned once and reused verbatim in the template. Recommend a normative line: verdicts are exactly `sahih` / `tidak tepat` / `separa tepat` / `data tidak cukup` (bold the matched one). Avoids the LLM improvising near-synonyms that break scannability.

### UX-5 (Medium) — Tone of the `tidak tepat` verdict word

`tidak tepat` ("not accurate") is defensible and journalistic, and is materially softer than "menipu" (lie) — which jin project memory (`feedback_tone_malay`) explicitly bans in favour of "mengelirukan"/"salah tafsir". So the spec is *already* on the right side of the house tone rule. The Medium flag is only to make this a **deliberate, documented** copy decision rather than incidental, because (a) the word is bolded and high-visibility, and (b) a future LLM rendering could drift toward stronger phrasing. Keep `tidak tepat`; document that "menipu" must never be substituted.

### UX-6 (Medium) — CSV `barang` per-token completion (Open Q3)

`basket-bulanan` takes `barang` as a CSV string (Q3 lean) with the completer completing the last token. This is a genuine client-UX risk: not all clients support mid-string `completion/complete` cleanly, and a user who has typed "ayam, beras, te" expects "te" to complete to TELUR while "ayam, beras," is preserved. If a target client (especially mobile) re-inserts the completion as the *whole* value, the prior tokens are clobbered — a silent data-loss UX. Recommendations: (1) the completer must complete only the trailing token and the inserted value must include the preserved prefix, or the client must support partial replacement — confirm against Claude.ai/Desktop/ChatGPT before shipping; (2) the `barang` arg `description` must show the CSV format literally ("comma-separated, e.g. `ayam, beras, telur`"); (3) if any target client mishandles mid-string completion, fall back to no-completion on this arg rather than a broken one (an empty/clobbering dropdown is worse than none).

### UX-7 (Medium) — Missing the highest-intent prompt (Open Q5)

See Open Q5 answer below. In short: the README's #1 marketed query is "where's the cheapest X" and `find_cheapest` is the most-used tool; a `cari-termurah` prompt is the obvious high-value 4th. The current 3 skew analytical (fact-check, basket, region-gap) and under-serve the everyday consumer who just wants the cheapest shop.

### UX-8 (Low) — Methodology bulk on mobile (Open Q2)

The embedded methodology block (§6) is helpful for the fact-check prompt's trustworthiness but is dead weight on a small screen for the lighter prompts. The §16 Q2 lean (embed on fact-check + compare; one-line coverage note for basket) is the right UX call — see Open Q2 answer.

### UX-9 (Low) — Surface the effect of omitting optional args

The fact-check template already branches gracefully when `barang`/`negeri` are omitted (`{else}First resolve the item with search_items{/if}`, §6) — good. Mirror that into the arg `description` ("optional — leave blank and the assistant will resolve the item from your claim text") so the user knows omission is safe and doesn't feel forced to fill it.

---

## Open question answers

**Q1 — Output language: BM-only vs a `bahasa: ms|en` arg. STRONG recommendation: ship BM-only in v1; do NOT add `bahasa` yet — but make BM-output *explicit in the description copy*.**

Reasoning through the user's chair:
- The core audience is Malaysian and the highest-value, highest-volume use case is fact-checking a *viral BM claim* — that user wants BM output, full stop. A claim spreading in BM must be rebutted in BM to be shareable into the same channels.
- The international-client argument (Claude.ai/ChatGPT English users) is real but weaker: an English researcher invoking a Malay-named slash command with BM-labelled output is already self-selecting into a localised tool, and the *agent* can trivially translate BM output to English on request in the next turn. A dedicated `bahasa` arg buys little the client can't already do, and it doubles the template surface (every verdict string, every Ringkas constraint, the methodology citation) — a maintenance and consistency cost (UX-4 shows string-pinning is already a risk with one language).
- The decisive UX move is not an arg, it's **honesty in the description** (UX-2): every `description` should end "(output in Bahasa Melayu)". That sets expectation so an English user isn't surprised, and lets them decide up front. An empty `bahasa` toggle that most users never touch is worse UX than a clear "this answers in Malay" label.
- Revisit only if the §10 telemetry `prompt` field plus a future client-locale signal shows real EN demand — matches the spec's own lean. The spec is right here; the only addition is making BM explicit in copy, not silent.

**Q2 — Embed methodology in all three prompts, or only some? Recommendation: embed on `semak-dakwaan-harga` and `banding-bandar-vs-nasional`; a one-line coverage note (not the full block) on `basket-bulanan`.**

UX angle: inlined methodology *helps* exactly where the output is a contested verdict the user must trust — the fact-check (the whole point is defensible caveats) and the state-vs-national compare (the n≥100/≥10 coverage caveat is the credibility load-bearing wall). For those, the methodology block is signal, not clutter. For `basket-bulanan` the output is a cost total + movers — far less caveat-heavy — and the full methodology block is mobile clutter that pushes the actual numbers below the fold. A one-line "harga ialah purata mingguan; item dengan liputan rendah ditanda" note carries the necessary humility without the bulk. This matches the §16 Q2 lean exactly; endorse it.

**Q5 — 3 prompts enough, or add a 4th? Recommendation: add a 4th — `cari-termurah` (where's cheapest) — in v1.**

The current 3 are all analytical/journalistic (fact-check, monthly basket, region gap). They serve the analyst and the rebuttal-writer well but under-serve the **everyday consumer**, who is the README's headline persona ("what's the cheapest chicken in KL this week?", README:40). `find_cheapest` is the lowest-friction, highest-intent, highest-volume query in the whole tool set, and it maps to a trivially-encodable prompt: arg `barang` (req, completable), `negeri` (opt, completable), optional `daerah` — render → run `search_items` → `find_cheapest`, return a ranked list + the coverage caveat. It needs almost none of the verdict discipline (no Ringkas lede, light methodology), so it's cheap to add and proves the prompt machinery against a non-fact-check shape. Shipping it in v1 means the prompt set covers both the "fact-check / analyse" and the "just help me buy cheaper" intents — a materially more complete first impression. (The spec lists `cari-termurah` under §15 "add once the 3 prove out"; I'd promote it into v1 precisely because it's the safest, highest-demand one to validate the feature with.)

---

## Spec change requests

1. **§6 (and §4 per-prompt):** Lead each rendered `text` block with a one-sentence, human-facing, bilingual-friendly preamble that also instructs the model to acknowledge before running tools (UX-1). Keep it data-free.
2. **§4:** Make literal bilingual `description` strings normative for all prompts, each ending "(output in Bahasa Melayu)" (UX-2, Q1). Same bar Resources §2 set.
3. **§4 / §12:** Specify literal user-facing `description` copy for every argument — especially `dakwaan` (what to paste + example) and the CSV `barang` (format example) (UX-3, UX-6).
4. **§5 / §6:** Pin the four verdict strings verbatim (`sahih` / `tidak tepat` / `separa tepat` / `data tidak cukup`) and reuse them everywhere; document that "menipu" must never be substituted (UX-4, UX-5).
5. **§16 Q3 / §4:** Confirm the CSV `barang` completer completes only the trailing token and preserves the prefix on insert; validate against target clients; fall back to no-completion if any client clobbers (UX-6).
6. **§4 / §15:** Promote `cari-termurah` into the v1 prompt set as a 4th prompt (UX-7, Q5).
7. **§16 Q2:** Adopt the lean — embed methodology on fact-check + compare, one-line coverage note on basket (UX-8, Q2).
8. **§4 arg descriptions:** Surface that omitting optional `barang`/`negeri` is safe and what the assistant does instead (UX-9).
