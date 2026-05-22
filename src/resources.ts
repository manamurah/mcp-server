/**
 * #1 MCP Resources (2.8.0) — embed-only.
 *
 * Six fixed reference resources served from the bundled, generated catalogue
 * (`src/generated/catalogue.ts`) + the hand-written methodology const. Zero
 * network at request time (architecture decision: embed, don't proxy). The
 * Worker is stateless, so no subscriptions / listChanged.
 *
 * `RESOURCES` is the single source for both `resources/list` AND the
 * `resources/read` allowlist (`RESOURCE_BY_URI`) — a URI not in the table can
 * never be read. There is no upstream path to confuse-deputy: every payload is
 * a literal bundled const selected by a `switch` over the canonical URI.
 *
 * strict + noUncheckedIndexedAccess:false — use Map.get, never bare [].
 */
import {
	ITEMS,
	STATES,
	CATEGORIES,
	CHAINS,
	LATEST_WEEK,
	LATEST_WEEK_META,
} from './generated/catalogue.js';
import { METHODOLOGY_MD } from './methodology.js';
import type { MCPResource, ResourceContents } from './mcp-types.js';

export const RESOURCES: readonly MCPResource[] = [
	{
		uri: 'manamurah://catalogue/items',
		name: 'items',
		title: 'Item catalogue',
		description:
			'All currently-active PriceCatcher items (observed in the last 12 months): code, Malay name, English name, unit, category. No prices — use the price tools. Discontinued items are excluded; for Chinese/Tamil names, aliases, or fuzzy search, call search_items.',
		mimeType: 'application/json',
		kind: 'embedded',
	},
	{
		uri: 'manamurah://catalogue/states',
		name: 'states',
		title: 'States & federal territories',
		description:
			'16 states / federal territories with id, name, slug, and region (semenanjung/borneo).',
		mimeType: 'application/json',
		kind: 'embedded',
	},
	{
		uri: 'manamurah://catalogue/categories',
		name: 'categories',
		title: 'Item categories',
		description:
			'Item categories among recent-active items, with item counts. Use a value as the `category` filter on search_items.',
		mimeType: 'application/json',
		kind: 'embedded',
	},
	{
		uri: 'manamurah://catalogue/chains',
		name: 'chains',
		title: 'Retail chains',
		description:
			'Retail chains and standalone premises observed recently, with premise_count and chain_type, sorted by premise_count. The whole-set companion to the list_chains tool.',
		mimeType: 'application/json',
		kind: 'embedded',
	},
	{
		uri: 'manamurah://meta/latest-week',
		name: 'latest-week',
		title: 'Data freshness',
		description:
			'Current data week + coverage: latest_weekdate, premises_reporting, items_with_data. Read this to know how fresh the prices are.',
		mimeType: 'application/json',
		kind: 'embedded',
	},
	{
		uri: 'manamurah://docs/methodology',
		name: 'methodology',
		title: 'Methodology & caveats',
		description:
			'How prices are computed: weekly-average cadence, equal-premise weighting, outlier filtering, and the n>=30 reliability guidance. Cite these caveats when reporting figures.',
		mimeType: 'text/markdown',
		kind: 'embedded',
	},
];

const RESOURCE_BY_URI: Map<string, MCPResource> = new Map(RESOURCES.map((r) => [r.uri, r]));

// Lazy module-global memo: serialize each payload once per isolate on first
// read (keeps module init cheap under CF's ~1s startup-CPU budget — we do not
// stringify the ~67 KB items payload at import time).
const textCache: Map<string, string> = new Map();

function buildText(uri: string): string {
	switch (uri) {
		case 'manamurah://catalogue/items':
			return JSON.stringify({ weekdate: LATEST_WEEK, items: ITEMS });
		case 'manamurah://catalogue/states':
			return JSON.stringify({ weekdate: LATEST_WEEK, states: STATES });
		case 'manamurah://catalogue/categories':
			return JSON.stringify({ weekdate: LATEST_WEEK, categories: CATEGORIES });
		case 'manamurah://catalogue/chains':
			return JSON.stringify({ weekdate: LATEST_WEEK, chains: CHAINS });
		case 'manamurah://meta/latest-week':
			return JSON.stringify(LATEST_WEEK_META);
		case 'manamurah://docs/methodology':
			return METHODOLOGY_MD;
		default:
			// Unreachable: RESOURCE_BY_URI gates before we get here.
			throw new Error(`No builder for resource ${uri}`);
	}
}

/** `resources/list` payload — descriptors only (no content). */
export function listResources(): Array<Omit<MCPResource, 'kind'>> {
	return RESOURCES.map(({ uri, name, title, description, mimeType }) => ({
		uri,
		name,
		title,
		description,
		mimeType,
	}));
}

export type ReadResult =
	| { ok: true; resourceName: string; contents: ResourceContents[] }
	| { ok: false; code: number; message: string };

/** `resources/read` — allowlist-gated, serves the bundled const. */
export function readResource(uri: string): ReadResult {
	const r = RESOURCE_BY_URI.get(uri);
	if (!r) {
		return {
			ok: false,
			code: -32602,
			message: `Unknown resource ${uri}. Call resources/list for the catalogue.`,
		};
	}
	let text = textCache.get(uri);
	if (text === undefined) {
		text = buildText(uri);
		textCache.set(uri, text);
	}
	return {
		ok: true,
		resourceName: r.name,
		contents: [{ uri, mimeType: r.mimeType, text }],
	};
}
