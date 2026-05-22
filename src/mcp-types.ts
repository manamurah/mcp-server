/**
 * Shared MCP protocol-envelope types — the single source for the manamurah
 * MCP server's Resources / Completions / Prompts features.
 *
 * Consolidated here per docs/2026-05-22-mcp-build-prerequisites.md so the
 * envelope shapes are NOT re-declared per feature (the reviews flagged
 * per-spec re-declaration + a widened `mimeType` as a drift surface).
 *
 * strict: true; noUncheckedIndexedAccess: false — use `Map.get` / `.find`
 * (already `T | undefined`), never bare `[]` indexing on these.
 *
 * Section tags mark which release first uses each type. Declaring the 2.9.0
 * types now is free (types are erased at build) and keeps one authoritative
 * source from the start.
 */

// ──────────────────────────────────────────────────────────────────
// Resources (2.8.0)
// ──────────────────────────────────────────────────────────────────

/** Embedded = served from a bundled const (zero-network). v1 is embed-only. */
export type ResourceKind = 'embedded';

export interface MCPResource {
	uri: string; // canonical URI advertised by resources/list
	name: string;
	title: string;
	description: string; // normative copy (states "no prices", languages, freshness)
	mimeType: 'application/json' | 'text/markdown';
	kind: ResourceKind;
}

/** MCP resources/read result content block. */
export interface ResourceContents {
	uri: string;
	mimeType: string;
	text: string;
}

// ── Catalogue data shapes ──
// The generated `src/generated/catalogue.ts` consts conform to these. Defined
// here (hand-reviewed) so regeneration cannot silently drift the shapes. One
// shape per dataset; `CatalogueItem` is the single item shape reused by the
// (v2-deferred) item card. `name_en` is REQUIRED (user decision 2026-05-22).
export interface CatalogueItem {
	item_code: number;
	name: string; // Malay (PriceCatcher canonical)
	name_en: string; // English; generator falls back to `name` if a translation is missing
	unit: string;
	item_category: string;
}

export interface CatalogueState {
	stateid: number;
	name: string;
	slug: string;
	region: 'semenanjung' | 'borneo';
}

export interface CatalogueCategory {
	category: string;
	item_count: number;
}

export interface CatalogueChain {
	chain: string;
	chain_type: string;
	premise_count: number;
}

/** Frozen 3-field contract for the `manamurah://meta/latest-week` resource. */
export interface LatestWeekMeta {
	latest_weekdate: string;
	premises_reporting: number;
	items_with_data: number;
}

/** Provenance header carried by the generated catalogue module. */
export interface CatalogueProvenance {
	source: string;
	generated_at: string;
	latest_week: string;
	recent_active_window: string;
}

// ──────────────────────────────────────────────────────────────────
// Completions (2.9.0) — completion attaches to prompt args + resource
// TEMPLATE args only (never tool args). Hence ResourceTemplateReference.
// ──────────────────────────────────────────────────────────────────

export interface PromptReference {
	type: 'ref/prompt';
	name: string;
}

export interface ResourceTemplateReference {
	type: 'ref/resource';
	uri: string; // a URI *template*
}

export type CompletionRef = PromptReference | ResourceTemplateReference;

/** Optional; protocol-gated to 2025-06-18+. Absent on 2024-11-05. */
export interface CompletionContext {
	arguments: Record<string, string>;
}

/** Pure, in-memory; returns full matches (pre-cap). */
export type Completer = (partial: string, ctx?: CompletionContext) => string[];

// ──────────────────────────────────────────────────────────────────
// Prompts (2.9.0)
// ──────────────────────────────────────────────────────────────────

export interface PromptArgument {
	name: string;
	description: string;
	required: boolean;
	/** Co-located completer (avoids a separate registry / drift surface). */
	complete?: Completer;
}

/** Closed union — text | embedded resource. We never emit image/audio. */
export type PromptContent =
	| { type: 'text'; text: string }
	| { type: 'resource'; resource: { uri: string; mimeType: 'text/markdown'; text: string } };

export interface PromptMessage {
	role: 'user' | 'assistant';
	content: PromptContent;
}

/** Validated args reaching render: required → string, optional → string | undefined. */
export type ValidatedArgs = Record<string, string | undefined>;

export interface PromptDef {
	name: string;
	title: string;
	description: string; // literal bilingual copy; notes BM output
	arguments: PromptArgument[];
	/** Pure + sync — `=> PromptMessage[]` makes "no fetch/await" a compile-time guarantee. */
	render: (args: ValidatedArgs) => PromptMessage[];
}
