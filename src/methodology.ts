/**
 * Canonical, hand-reviewed single source of the manamurah price-analysis
 * discipline. NOT generated.
 *
 * This is the ONE place the coverage thresholds, the canonical verdict set,
 * and the Ringkas-lede rule are defined. Consumers:
 *   - #1 Resources serves METHODOLOGY_MD as `manamurah://docs/methodology`.
 *   - #3 Prompts `render` references these consts (does NOT restate them).
 *   - the jin `manamurah-price-analysis` skill is a documented downstream
 *     consumer that should cite these values (reconcile its verdict strings
 *     to VERDICTS below — it historically carried two divergent encodings).
 *
 * A CI tripwire should assert prompt/render text matches these values
 * (see docs/2026-05-22-mcp-build-prerequisites.md §4). Keep METHODOLOGY_MD
 * ≤ ~400 tokens. This is reference/control content — English by design
 * (the "control plane"); prompts render the BM "answer plane" from it.
 */

/** The ONE canonical verdict set (BM, verbatim — the bolded scannable payload). */
export const VERDICTS = ['sahih', 'tidak tepat', 'separa tepat', 'data tidak cukup'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** English gloss, for descriptions / cross-referencing the source skill. */
export const VERDICT_GLOSS: Record<Verdict, string> = {
	sahih: 'affirms',
	'tidak tepat': 'rebuts',
	'separa tepat': 'partial',
	'data tidak cukup': 'data-insufficient',
};

/** Reporting-premise coverage thresholds — the anti-false-signal rule. */
export const COVERAGE = {
	/** Headline figure / lead movers list. */
	headlineMinPremises: 30,
	/** Cross-state comparison needs a fat national pool AND per-state depth. */
	crossStateMinNational: 100,
	crossStateMinPerState: 10,
	/** Mention-with-caveat floor (always print the n=N). */
	mentionWithCaveatMinPremises: 5,
	/** Below this on the claim's own item → verdict `data tidak cukup`. */
	dataInsufficientBelow: 5,
} as const;

/** Ringkas lede: lead with the claim restatement, bold the verdict word. */
export const RINGKAS = { minWords: 40, maxWords: 60 } as const;

/** Served verbatim as the `manamurah://docs/methodology` resource (text/markdown). */
export const METHODOLOGY_MD = `# manamurah methodology & caveats

**Source.** Retail prices are from KPDN PriceCatcher (data.gov.my), ~3,800 premises × ~750 items,
collected daily and published as **weekly averages**. FAMA value-chain prices (LADANG/BORONG/RUNCIT)
are a separate daily dataset covering ~46 fresh items.

**How averages are built.** Each premise contributes equally to a week's average regardless of how
many days it reported (equal-premise weighting). Daily-grain outliers are filtered before averaging.
Prices are RM in the item's stated unit.

**Coverage thresholds (cite these before reporting any figure).**
- Headline figure / lead mover: needs **≥ 30** reporting premises that week.
- Cross-state comparison: needs **≥ 100** premises nationally **and ≥ 10 per state** compared.
- Below 30: print as a caveated mention with the sample size, e.g. "(n=N premis; tidak boleh
  ditafsir sebagai trend)". Below **5** on the claim's own item: the data cannot evaluate it.
- A premise count above threshold is necessary but not sufficient: if the price range across
  premises is wide (> 2×), the item code may mix product variants — avoid single-figure framings.

**Verdict taxonomy.** \`sahih\` (affirms) / \`tidak tepat\` (rebuts) / \`separa tepat\` (partial) /
\`data tidak cukup\` (data-insufficient).

**Value-chain claims.** For "where did the price move" (farm-gate vs retail markup), use the FAMA
tools (\`fama_margin\`, \`fama_top_movers\`); PriceCatcher tracks retail only.`;
