/**
 * ManaMurah MCP Server — Cloudflare Workers
 *
 * A remote MCP (Model Context Protocol) server that exposes 11
 * strongly-typed tools for Malaysian PriceCatcher consumer price data.
 *
 * Architecture: this Worker is a thin JSON-RPC shim over the public
 * https://manamurah.com/api/v2/mcp/* surface. No credentials, no
 * backing database, no rate limiting of its own — upstream handles
 * caching + access. The Worker adds:
 *   - MCP JSON-RPC protocol framing
 *   - CORS for browser-based clients
 *   - Per-request isolation (no shared state between calls)
 *
 * Data: data.gov.my PriceCatcher — ~3,800 premises × ~756 items,
 * collected daily and published as weekly averages. 100% public
 * government data.
 */

// ---------------------------------------------------------------------
// MCP JSON-RPC types
// ---------------------------------------------------------------------

interface MCPTool {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, JSONSchemaProp>;
		required?: string[];
		additionalProperties?: boolean;
	};
}

interface JSONSchemaProp {
	type?: string;
	description?: string;
	enum?: readonly (string | number)[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	items?: JSONSchemaProp;
	minItems?: number;
	maxItems?: number;
	examples?: unknown[];
}

interface MCPRequest {
	jsonrpc: '2.0';
	id: number | string | null;
	method: string;
	params?: Record<string, unknown>;
}

interface MCPResponse {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

import { CHANGELOG_MARKDOWN } from './changelog.js';
import { recordMcp, type CallMeta } from './analytics.js';
import { RESOURCES, listResources, readResource } from './resources.js';
import { PROMPTS, listPrompts, getPrompt, resolveCompleter } from './prompts.js';
import type { CompletionRef } from './mcp-types.js';

// ---------------------------------------------------------------------
// Server identity — single source of truth for serverInfo.version,
// the version field on GET /, and what registries display. Bump
// per the policy embedded in the root response (see ROOT_VERSIONING).
// ---------------------------------------------------------------------

const SERVER_NAME = 'manamurah';                  // MCP serverInfo.name
const SERVER_PACKAGE_NAME = 'manamurah-mcp-server'; // human-facing
const SERVER_VERSION = '2.9.0';
const PROTOCOL_VERSION = '2024-11-05';

const ROOT_VERSIONING = {
	scheme: 'semver',
	current: SERVER_VERSION,
	policy: {
		major:
			'Breaking: tool removed, required input added, output shape change, enum value removed.',
		minor:
			'Additive: new tool, new optional input field, new output field, broader enum.',
		patch: 'Bug fixes, performance, response stability — no schema change.',
	},
	deprecation_window_days: 90,
	changelog: '/changelog',
} as const;

/** Native CF Workers Rate Limiting binding (GA). Minimal structural type. */
interface RateLimitBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
	/** Base URL for the proxy surface. Default: https://manamurah.com */
	MANAMURAH_API_BASE?: string;
	/** Analytics Engine dataset (manamurah_mcp) for usage telemetry. */
	WAE?: AnalyticsEngineDataset;
	/** Rate limiter scoped to completion/complete (optional — absent in tests/dev). */
	COMPLETION_RL?: RateLimitBinding;
}

// ---------------------------------------------------------------------
// Shared JSON Schema fragments
// ---------------------------------------------------------------------

const CHAIN_TYPES = [
	'HYPERMARKET',
	'SUPERMARKET',
	'MINIMART',
	'SUNDRY',
	'CONVENIENCE',
	'WET_MARKET',
	'BORONG',
	'RESTAURANT',
	'FOODCOURT',
] as const;

const SCOPES = [
	'national',
	'state',
	'district',
	'chain',
	'urbanisation',
	'region',
	'chain_group',
] as const;
const MONTHS_WINDOW = [1, 3, 6, 12] as const;

const STATES_HINT =
	"Malaysian state or federal territory, e.g. 'Selangor', 'W.P. Kuala Lumpur', 'Pulau Pinang'. Case-sensitive.";

// FAMA-specific enums. The catalogue is independent of KPDN/PriceCatcher —
// items are FAMA's own 1..46 ids and three price levels are tracked daily
// and independently. See manamurah-data-2026 `manamurah_etl/fama/`.
const FAMA_LEVELS = ['RUNCIT', 'BORONG', 'LADANG'] as const;
const FAMA_GRAINS_FULL = ['national', 'state', 'daerah'] as const;
const FAMA_GRAINS_NO_DAERAH = ['national', 'state'] as const;

// ---------------------------------------------------------------------
// Tool catalogue — mirrors manamurah-mcp-2026's Pydantic models
// ---------------------------------------------------------------------

const TOOLS: MCPTool[] = [
	{
		name: 'search_items',
		description:
			'Search the Malaysian PriceCatcher item catalogue by name in any language (Malay/English/Chinese/Tamil). Use this FIRST when the user mentions a food item by name to resolve it to the item_code that every other tool requires. Returns up to 20 matches with translations. Do not use for prices — chain to find_cheapest or price_history next. Tip: the full active item list (code + Malay/English name + category) is also available as the `manamurah://catalogue/items` resource — read it once to skip repeated lookups.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					minLength: 1,
					maxLength: 64,
					description:
						"Search text in any supported language. Examples: 'watermelon', 'tembikai', 'ayam', '鸡肉'.",
				},
				category: {
					type: 'string',
					maxLength: 64,
					description:
						"Optional item_category filter. Examples: 'BUAH-BUAHAN' (fruits), 'SAYUR-SAYURAN' (vegetables), 'DAGING' (meat), 'IKAN-IKAN' (fish). Case-sensitive.",
				},
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
	{
		name: 'find_cheapest',
		description:
			"Return up to 10 premises with the lowest price for a specific item this week, sorted ascending. Use when the user asks 'where is X cheapest' or 'which shop has the best price for X'. Requires item_code — call search_items first if the user only gave a name.",
		inputSchema: {
			type: 'object',
			properties: {
				item_code: {
					type: 'integer',
					minimum: 1,
					description: 'Numeric item ID from search_items.',
				},
				state: { type: 'string', maxLength: 64, description: STATES_HINT },
				district: {
					type: 'string',
					maxLength: 64,
					description: "Exact district name — e.g. 'Petaling', 'Klang', 'Kota Bharu'.",
				},
				chain: {
					type: 'string',
					maxLength: 64,
					description: "Exact chain name — e.g. 'AEON', 'MYDIN', 'LOTUS'S'.",
				},
				chain_type: {
					type: 'string',
					enum: CHAIN_TYPES,
					description: 'Filter by chain category.',
				},
			},
			required: ['item_code'],
			additionalProperties: false,
		},
	},
	{
		name: 'price_history',
		description:
			"Get weekly price trend for one item at a rollup scope (national / state / district / chain / urbanisation / region / chain_group). Oldest-first time series, up to 52 weeks. Use for questions like 'how has X trended over 3 months'. scope='region' compares peninsular vs East Malaysia ('semenanjung' vs 'borneo') — useful for headline averages that aren't peninsular-weighted like 'national'. scope='chain_group' rolls premises up by storefront type (slug values: 'supermarket', 'kedai-runcit', 'pasar') and is monthly-only — the upstream API only has chain_group rollups in the monthly index, so weekly history is not available.",
		inputSchema: {
			type: 'object',
			properties: {
				item_code: { type: 'integer', minimum: 1 },
				scope: {
					type: 'string',
					enum: SCOPES,
					description: "Rollup scope. Non-'national' scopes require scope_value.",
				},
				scope_value: {
					type: 'string',
					maxLength: 64,
					description:
						"Required when scope != 'national'. State name for scope='state', chain name for 'chain', 'URBAN'/'SUBURBAN'/'RURAL' for 'urbanisation', 'semenanjung'/'borneo' for 'region', 'supermarket'/'kedai-runcit'/'pasar' for 'chain_group' (note hyphen in 'kedai-runcit').",
				},
				weeks: {
					type: 'integer',
					minimum: 1,
					maximum: 52,
					description: 'How many weeks of history to return (1-52, default 26).',
				},
			},
			required: ['item_code'],
			additionalProperties: false,
		},
	},
	{
		name: 'nearby_premises',
		description:
			"Find premises within a geographic radius of a coordinate. Up to 25 premises sorted by distance. Use when the user gives a location or asks 'shops near me'. Chain with find_cheapest for price checks at specific premises.",
		inputSchema: {
			type: 'object',
			properties: {
				latitude: {
					type: 'number',
					minimum: 0,
					maximum: 8,
					description: 'Latitude in degrees. Malaysia bbox is roughly 0.85–7.5.',
				},
				longitude: {
					type: 'number',
					minimum: 99,
					maximum: 120,
					description: 'Longitude in degrees. Malaysia bbox is roughly 99.5–119.5.',
				},
				radius_km: {
					type: 'number',
					minimum: 0.1,
					maximum: 50,
					description: 'Search radius in km (default 5).',
				},
				chain_type: { type: 'string', enum: CHAIN_TYPES },
				chain: { type: 'string', maxLength: 64 },
			},
			required: ['latitude', 'longitude'],
			additionalProperties: false,
		},
	},
	{
		name: 'compare_prices',
		description:
			"Compare one item's current-week price across national / state / district / chain / urbanisation dimensions in a single call. Use for 'is this a good price' or 'how does X compare across states'. Resolve names to ids/slugs via the `manamurah://catalogue/items` and `manamurah://catalogue/states` resources.",
		inputSchema: {
			type: 'object',
			properties: {
				item_code: { type: 'integer', minimum: 1 },
				weekdate: {
					type: 'string',
					description:
						"Optional ISO-8601 week starting Monday, e.g. '2026-04-20'. Defaults to latest available.",
				},
			},
			required: ['item_code'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_chains',
		description:
			'Enumerate known retail chains with premise counts and geographic spread. Up to 50 chains sorted by premise count. Use to discover valid chain names before filtering find_cheapest or nearby_premises. The whole active chain set is also available as the `manamurah://catalogue/chains` resource.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					maxLength: 64,
					description: 'Substring match on chain name (case-insensitive).',
				},
				chain_type: { type: 'string', enum: CHAIN_TYPES },
				state: { type: 'string', maxLength: 64, description: STATES_HINT },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'price_change',
		description:
			"Compare one item's current week to its price 1/3/6/12 months ago at any rollup scope (national / state / district / chain / urbanisation / region / chain_group). Returns current_week, comparison_week, absolute_change, pct_change, and direction (up/down/stable). Use for 'how much has X changed' questions. scope='chain_group' rolls premises up by storefront type — slug values 'supermarket', 'kedai-runcit', 'pasar' — and resolves on the monthly index (no period flag needed).",
		inputSchema: {
			type: 'object',
			properties: {
				item_code: { type: 'integer', minimum: 1 },
				months: {
					type: 'integer',
					enum: MONTHS_WINDOW,
					description: 'Comparison window. One of 1, 3, 6, 12.',
				},
				scope: { type: 'string', enum: SCOPES },
				scope_value: { type: 'string', maxLength: 64 },
			},
			required: ['item_code'],
			additionalProperties: false,
		},
	},
	{
		name: 'top_movers',
		description:
			"The items that moved most in price this week vs last week (or month vs prev month with period='monthly'). Returns top N risers and fallers sorted by absolute percentage change. Use for 'what went up/down this week' or 'biggest price changes'. The scope filters (state / region / chain_group) are mutually exclusive — pass at most one. chain_group requires period='monthly' (storefront-type rollups only exist in the monthly index).",
		inputSchema: {
			type: 'object',
			properties: {
				category: {
					type: 'string',
					maxLength: 64,
					description: 'Optional item_category filter.',
				},
				state: {
					type: 'string',
					maxLength: 64,
					description:
						'When set, movements are computed on the state rollup. Mutually exclusive with region and chain_group.',
				},
				region: {
					type: 'string',
					enum: ['semenanjung', 'borneo'],
					description:
						"When set, movements are computed on the region rollup ('semenanjung' = peninsular, 'borneo' = Sabah/Sarawak/Labuan). Mutually exclusive with state and chain_group.",
				},
				chain_group: {
					type: 'string',
					enum: ['supermarket', 'kedai-runcit', 'pasar'],
					description:
						"When set, movements are computed on the chain_group (storefront-type) rollup. Slug values: 'supermarket', 'kedai-runcit' (note hyphen), 'pasar'. Monthly-only — must be paired with period='monthly'. Mutually exclusive with state and region.",
				},
				period: {
					type: 'string',
					enum: ['weekly', 'monthly'],
					description:
						"Comparison grain. 'weekly' (default) = WoW; 'monthly' = MoM and surfaces yoy_pct per row. Required to be 'monthly' when chain_group is set.",
				},
				limit: { type: 'integer', minimum: 1, maximum: 20 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'category_trends',
		description:
			"Summarise price movement per item_category over 1/3/6/12 months at any rollup scope (national / state / district / chain / urbanisation / region / chain_group). Groups items by category, returns avg_pct_change + top riser + top faller per category. Use for 'which categories went up' or 'food inflation by category'. scope='chain_group' rolls premises up by storefront type — slug values 'supermarket', 'kedai-runcit', 'pasar' — and resolves on the monthly index.",
		inputSchema: {
			type: 'object',
			properties: {
				months: { type: 'integer', enum: MONTHS_WINDOW },
				scope: { type: 'string', enum: SCOPES },
				scope_value: { type: 'string', maxLength: 64 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'basket_watch',
		description:
			"Track total cost for a 1–20 item basket over 1/3/6/12 months at any rollup scope (national / state / district / chain / urbanisation / region / chain_group). Returns current_total, comparison_total, pct_change, and per-item breakdown. Items missing from either week are listed as missing_items and excluded from totals (no silent zero-fill). scope='chain_group' rolls premises up by storefront type — slug values 'supermarket', 'kedai-runcit', 'pasar' — and resolves on the monthly index.",
		inputSchema: {
			type: 'object',
			properties: {
				item_codes: {
					type: 'array',
					items: { type: 'integer', minimum: 1 },
					minItems: 1,
					maxItems: 20,
					description: 'List of 1–20 item_codes from search_items.',
				},
				months: { type: 'integer', enum: MONTHS_WINDOW },
				scope: { type: 'string', enum: SCOPES },
				scope_value: { type: 'string', maxLength: 64 },
			},
			required: ['item_codes'],
			additionalProperties: false,
		},
	},
	{
		name: 'chain_mom_movers',
		description:
			"Find the biggest month-over-month price movers within a chain (or across all chains). Returns top risers and fallers with MoM and YoY per row, plus the premise_count backing each average. Use for 'what's up at AEON this month', 'biggest monthly movers at MYDIN', or 'which DAGING items rose most across hypermarkets'. For week-over-week use top_movers (period='weekly'); for one item's full history use price_history.",
		inputSchema: {
			type: 'object',
			properties: {
				chain: {
					type: 'string',
					maxLength: 64,
					description:
						"Restrict to one chain — e.g. 'AEON', 'MYDIN', 'LOTUS'S'. Omit to rank movers across all chains; each row then carries its own chain field.",
				},
				chain_type: {
					type: 'string',
					enum: CHAIN_TYPES,
					description:
						"Restrict to one chain category. Combine with category to ask 'which DAGING items moved most across hypermarkets this month'.",
				},
				category: {
					type: 'string',
					maxLength: 64,
					description: 'Optional item_category filter.',
				},
				limit: { type: 'integer', minimum: 1, maximum: 20 },
				min_premises: {
					type: 'integer',
					minimum: 1,
					description:
						'Minimum reporting premises per chain-item bucket to include (noise gate). Default 3.',
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: 'region_gap',
		description:
			"Rank items by Semenanjung vs Borneo regional price gap. Returns top N items where Borneo is pricier (positive gap) and top N where Semenanjung is pricier (negative gap), in one round-trip. Built on the region monthly/weekly rollup. Use for surfacing regional disparities ('what items are notably more expensive in Borneo this month?') without double-querying scope='region' and diffing client-side. Tunable: `category` filter, `period` (monthly default), `limit`, `min_pct` to ignore parity-grade gaps.",
		inputSchema: {
			type: 'object',
			properties: {
				category: {
					type: 'string',
					maxLength: 64,
					description:
						"Optional item_category filter. Examples: 'BUAH-BUAHAN', 'SAYUR-SAYURAN', 'DAGING', 'IKAN-IKAN'. Case-sensitive.",
				},
				period: {
					type: 'string',
					enum: ['weekly', 'monthly'],
					description:
						"Rollup grain. 'monthly' (default) resolves on the latest available month; 'weekly' on the latest ISO Monday week.",
				},
				weekdate: {
					type: 'string',
					description:
						"Weekly mode only. ISO Monday in YYYY-MM-DD form, e.g. '2026-04-20'. Defaults to latest available when omitted.",
				},
				month: {
					type: 'string',
					description:
						"Monthly mode only. YYYY-MM, e.g. '2026-04'. Defaults to latest available when omitted.",
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 20,
					description:
						'Items per direction (default 10). Returns up to `limit` borneo_pricier rows and up to `limit` semenanjung_pricier rows.',
				},
				min_pct: {
					type: 'number',
					minimum: 0,
					description:
						'Minimum |gap_pct| (in percent) for an item to qualify. Default 1.0 — items within ±1% are treated as parity and excluded.',
				},
			},
			additionalProperties: false,
		},
	},
	// --- FAMA daily prices (independent catalogue from PriceCatcher) ---
	// Backed by the manamurah_fama_prices_daily ES index, populated daily
	// at 10:00 from FAMA's "Panduan Harga Harian" Power BI report. Three
	// price levels (RUNCIT/BORONG/LADANG) tracked independently — the
	// three-tier view is the analytical edge over weekly KPDN.
	{
		name: 'fama_price_history',
		description:
			"Daily FAMA price time series for one item at a chosen price level (RUNCIT retail / BORONG wholesale / LADANG farm-gate) and geographic grain. FAMA is a separate catalogue from PriceCatcher — item_id here is FAMA's own 1..46 (not KPDN item_code). Common items: 13=AYAM PROSES STANDARD, 22=AYAM HIDUP, 46=TELUR AYAM, 31=TIMUN HIJAU, 10=KACANG PANJANG HIJAU, 44=BAYAM. Returns up to 90 days oldest-first; missing days (FAMA's publishing lag often hides the last 1–3 days) are listed in missing_dates rather than zero-filled. Do not use for KPDN items (use price_history) or for value-chain spread (use fama_margin).",
		inputSchema: {
			type: 'object',
			properties: {
				item_id: {
					type: 'integer',
					minimum: 1,
					description: "FAMA item.id (1..46). Not the PriceCatcher item_code.",
				},
				level: {
					type: 'string',
					enum: FAMA_LEVELS,
					description:
						"Price level: RUNCIT (retail), BORONG (wholesale), or LADANG (farm-gate).",
				},
				grain: {
					type: 'string',
					enum: FAMA_GRAINS_FULL,
					description:
						"Geographic rollup. 'national' (default) for a single aggregate per day; 'state' for one of 16 states; 'daerah' for a specific district (sparse coverage).",
				},
				state_slug: {
					type: 'string',
					maxLength: 32,
					description:
						"Required when grain='state' or 'daerah'. Lowercase FAMA state slug (e.g. 'johor', 'selangor', 'pulau-pinang').",
				},
				daerah_slug: {
					type: 'string',
					maxLength: 64,
					description:
						"Required when grain='daerah'. Lowercase FAMA daerah slug scoped within the chosen state (e.g. 'johor-bahru').",
				},
				days: {
					type: 'integer',
					minimum: 1,
					maximum: 90,
					description:
						'Trailing window in days (1-90, default 30).',
				},
			},
			required: ['item_id', 'level'],
			additionalProperties: false,
		},
	},
	{
		name: 'fama_margin',
		description:
			"Pivot FAMA's three price levels for one item into per-day rows with all three prices side-by-side and the inter-leg markup percentages already computed (ladang_to_borong_pct, borong_to_runcit_pct, ladang_to_runcit_pct). The unique value FAMA enables over weekly KPDN — answering 'where in the value chain did the price move?'. Spread fields are null on days a leg is missing; the coverage block (ladang_days/borong_days/runcit_days/full_chain_days) tells you how reliable the analysis is — a near-zero full_chain_days means the item lacks farm-gate coverage. grain='daerah' is intentionally unsupported because LADANG/BORONG coverage at daerah grain is too sparse. Use fama_price_history if you only need one level.",
		inputSchema: {
			type: 'object',
			properties: {
				item_id: {
					type: 'integer',
					minimum: 1,
					description: "FAMA item.id (1..46). Items with all-three-level coverage include 22=AYAM HIDUP, 13=AYAM PROSES STANDARD, 46=TELUR AYAM, and the leafy vegetables.",
				},
				grain: {
					type: 'string',
					enum: FAMA_GRAINS_NO_DAERAH,
					description: "Geographic rollup. 'national' (default) or 'state'.",
				},
				state_slug: {
					type: 'string',
					maxLength: 32,
					description: "Required when grain='state'. Lowercase FAMA state slug.",
				},
				days: {
					type: 'integer',
					minimum: 1,
					maximum: 90,
					description: 'Trailing window in days (1-90, default 14).',
				},
			},
			required: ['item_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'fama_top_movers',
		description:
			"Daily-cadence movers per FAMA price level — daily counterpart to top_movers, separable by level so callers can ask 'what jumped at the farm-gate' (level='LADANG') distinctly from 'what jumped at retail' (level='RUNCIT'). The comparison is anchored on the latest available date in the index (often 2-4 days behind today due to FAMA's publishing lag), not on today; days_actual echoes the realised gap. Items lacking either anchor or comparison observation are excluded — no zero-fill. LADANG coverage is the patchiest — expect shorter lists at level='LADANG' even with min_pct lowered. grain='daerah' is unsupported (sparse coverage).",
		inputSchema: {
			type: 'object',
			properties: {
				level: {
					type: 'string',
					enum: FAMA_LEVELS,
					description:
						"Price level to rank. RUNCIT and BORONG have the densest coverage; LADANG is usable but may return shorter lists.",
				},
				grain: {
					type: 'string',
					enum: FAMA_GRAINS_NO_DAERAH,
					description: "'national' (default) or 'state'.",
				},
				state_slug: {
					type: 'string',
					maxLength: 32,
					description: "Required when grain='state'.",
				},
				days: {
					type: 'integer',
					minimum: 1,
					maximum: 30,
					description:
						'Lookback distance from the anchor date (1-30, default 7). Anchor is the latest available index date, not today.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 25,
					description: 'How many items per direction (1-25, default 10).',
				},
				min_pct: {
					type: 'number',
					minimum: 0,
					description:
						'Minimum |pct_change| required for an item to qualify (default 1.0). Raise to filter to headline-grade moves only.',
				},
			},
			required: ['level'],
			additionalProperties: false,
		},
	},
];

// basket_watch is POST (JSON body of item_codes); every other tool is GET.
const POST_TOOLS = new Set(['basket_watch']);

// ---------------------------------------------------------------------
// Upstream proxy call
// ---------------------------------------------------------------------

async function callUpstream(
	baseUrl: string,
	toolName: string,
	args: Record<string, unknown>,
	meta?: CallMeta
): Promise<unknown> {
	const path = `/api/v2/mcp/${toolName}`;

	let url = `${baseUrl}${path}`;
	let init: RequestInit = {
		headers: { 'User-Agent': 'manamurah-mcp-server/2.0' },
	};

	if (POST_TOOLS.has(toolName)) {
		init = {
			...init,
			method: 'POST',
			headers: { ...init.headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(args),
		};
	} else {
		// Build query string from non-null scalar args.
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(args)) {
			if (v === null || v === undefined) continue;
			qs.set(k, String(v));
		}
		const query = qs.toString();
		if (query) url = `${url}?${query}`;
	}

	const resp = await fetch(url, init);
	if (meta) meta.backendStatus = resp.status;
	if (!resp.ok && resp.status >= 500) {
		throw new Error(`Upstream ${resp.status}: ${await resp.text()}`);
	}
	// 200 and 4xx both carry a structured {status, reason, ...} envelope.
	// Pass through so the LLM sees the business-level message.
	return await resp.json();
}

// ---------------------------------------------------------------------
// MCP handlers
// ---------------------------------------------------------------------

function handleInitialize(request: MCPRequest): MCPResponse {
	return {
		jsonrpc: '2.0',
		id: request.id,
		result: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {
				tools: {},
				prompts: { listChanged: false },
				resources: { listChanged: false },
				completions: {},
			},
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
		},
	};
}

function handleToolsList(request: MCPRequest): MCPResponse {
	return { jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } };
}

function handleResourcesRead(request: MCPRequest, meta?: CallMeta): MCPResponse {
	const params = (request.params ?? {}) as { uri?: string };
	const uri = params.uri;
	if (typeof uri !== 'string' || uri.length === 0) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: {
				code: -32602,
				message: 'Missing resource uri. Call resources/list for the catalogue.',
			},
		};
	}
	const result = readResource(uri);
	if (!result.ok) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: { code: result.code, message: result.message },
		};
	}
	if (meta) meta.resource = result.resourceName;
	return { jsonrpc: '2.0', id: request.id, result: { contents: result.contents } };
}

function handlePromptsGet(request: MCPRequest, meta?: CallMeta): MCPResponse {
	const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
	if (typeof params.name !== 'string' || params.name.length === 0) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: { code: -32602, message: 'Missing prompt name. Call prompts/list for the catalogue.' },
		};
	}
	const rawArgs =
		params.arguments && typeof params.arguments === 'object'
			? (params.arguments as Record<string, unknown>)
			: {};
	const res = getPrompt(params.name, rawArgs);
	if (!res.ok) {
		return { jsonrpc: '2.0', id: request.id, error: { code: res.code, message: res.message } };
	}
	if (meta) meta.prompt = params.name;
	return {
		jsonrpc: '2.0',
		id: request.id,
		result: { description: res.description, messages: res.messages },
	};
}

interface CompleteParams {
	ref: CompletionRef;
	argument: { name: string; value: string };
}

function isCompleteParams(p: unknown): p is CompleteParams {
	if (!p || typeof p !== 'object') return false;
	const o = p as Record<string, unknown>;
	const ref = o.ref as Record<string, unknown> | undefined;
	if (!ref || typeof ref !== 'object') return false;
	const okRef =
		(ref.type === 'ref/prompt' && typeof ref.name === 'string') ||
		(ref.type === 'ref/resource' && typeof ref.uri === 'string');
	if (!okRef) return false;
	const arg = o.argument as Record<string, unknown> | undefined;
	return !!arg && typeof arg === 'object' && typeof arg.name === 'string';
}

function handleCompletion(request: MCPRequest, meta?: CallMeta): MCPResponse {
	const params = request.params;
	if (!isCompleteParams(params)) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: { code: -32602, message: 'Invalid completion params: expected { ref, argument }.' },
		};
	}
	const completer = resolveCompleter(params.ref, params.argument.name);
	// Unknown (ref, argument) is a normal empty result, NOT an error (spec §5.2).
	if (!completer) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			result: { completion: { values: [], total: 0, hasMore: false } },
		};
	}
	const value = String(params.argument.value ?? '').slice(0, 64);
	const all = completer(value);
	const values = all.slice(0, 100);
	if (meta) {
		const refId = params.ref.type === 'ref/prompt' ? params.ref.name : params.ref.uri;
		meta.completionRef = `${params.ref.type === 'ref/prompt' ? 'prompt' : 'resource'}:${refId}#${params.argument.name}`;
		meta.matchCount = all.length;
	}
	return {
		jsonrpc: '2.0',
		id: request.id,
		result: { completion: { values, total: all.length, hasMore: all.length > 100 } },
	};
}

async function handleToolCall(
	request: MCPRequest,
	baseUrl: string,
	meta?: CallMeta
): Promise<MCPResponse> {
	const params = (request.params ?? {}) as {
		name?: string;
		arguments?: Record<string, unknown>;
	};
	const name = params.name;
	const args = params.arguments ?? {};
	if (meta && name) meta.tool = name;

	if (!name) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: { code: -32602, message: 'Missing tool name' },
		};
	}
	if (!TOOLS.find((t) => t.name === name)) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: { code: -32602, message: `Unknown tool: ${name}` },
		};
	}

	try {
		const data = await callUpstream(baseUrl, name, args, meta);
		return {
			jsonrpc: '2.0',
			id: request.id,
			result: {
				// MCP content convention: text blocks for serialisation,
				// with the raw payload also attached for structured clients.
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
			},
		};
	} catch (err) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: {
				code: -32603,
				message: 'Tool execution failed',
				data: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

async function handleMCP(
	request: MCPRequest,
	baseUrl: string,
	meta?: CallMeta
): Promise<MCPResponse> {
	try {
		switch (request.method) {
			case 'initialize':
				return handleInitialize(request);
			case 'tools/list':
				return handleToolsList(request);
			case 'tools/call':
				return await handleToolCall(request, baseUrl, meta);
			case 'prompts/list':
				return { jsonrpc: '2.0', id: request.id, result: { prompts: listPrompts() } };
			case 'prompts/get':
				return handlePromptsGet(request, meta);
			case 'completion/complete':
				return handleCompletion(request, meta);
			case 'resources/list':
				return { jsonrpc: '2.0', id: request.id, result: { resources: listResources() } };
			case 'resources/read':
				return handleResourcesRead(request, meta);
			case 'resources/templates/list':
				return { jsonrpc: '2.0', id: request.id, result: { resourceTemplates: [] } };
			case 'ping':
				return { jsonrpc: '2.0', id: request.id, result: {} };
			default:
				return {
					jsonrpc: '2.0',
					id: request.id,
					error: { code: -32601, message: `Method not found: ${request.method}` },
				};
		}
	} catch (err) {
		return {
			jsonrpc: '2.0',
			id: request.id,
			error: {
				code: -32603,
				message: 'Internal error',
				data: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

// ---------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const baseUrl = env.MANAMURAH_API_BASE ?? 'https://manamurah.com';

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		// MCP JSON-RPC endpoint
		if (path === '/mcp' || path === '/mcp/') {
			if (request.method !== 'POST') {
				return new Response('Method not allowed', {
					status: 405,
					headers: CORS_HEADERS,
				});
			}
			const userAgent = request.headers.get('user-agent');
			let body: MCPRequest;
			try {
				body = (await request.json()) as MCPRequest;
			} catch (err) {
				recordMcp(env.WAE, {
					method: '<parse_error>',
					ok: false,
					errorCode: -32700,
					userAgent,
					latencyMs: 0,
				});
				return jsonResponse(
					{
						jsonrpc: '2.0',
						id: null,
						error: {
							code: -32700,
							message: 'Parse error',
							data: err instanceof Error ? err.message : String(err),
						},
					},
					400
				);
			}
			const meta: CallMeta = {};
			const startedAt = Date.now();

			// JSON-RPC notifications (no `id`, e.g. `notifications/initialized`
			// that clients send right after `initialize`) expect no response.
			// Ack with 202 and record as ok instead of running the method
			// switch, which would 404 them as `method_not_found` and inflate
			// the error count.
			const isNotification =
				(typeof body?.method === 'string' && body.method.startsWith('notifications/')) ||
				body?.id === undefined ||
				body?.id === null;
			if (isNotification) {
				recordMcp(env.WAE, {
					method: body?.method ?? '-',
					ok: true,
					userAgent,
					latencyMs: Date.now() - startedAt
				});
				return new Response(null, { status: 202, headers: CORS_HEADERS });
			}

			// Rate-limit completion/complete (highest-volume, in-memory method —
			// the upstream 120/60s limit never sees it). Native CF binding, keyed
			// on Mcp-Session-Id → IP. On trip, return an empty completion set (not
			// an error). Fail-open if the binding is absent or throws.
			const isCompletion = body?.method === 'completion/complete';
			if (isCompletion && env.COMPLETION_RL) {
				const key =
					request.headers.get('mcp-session-id') ||
					request.headers.get('cf-connecting-ip') ||
					'anon';
				try {
					const { success } = await env.COMPLETION_RL.limit({ key });
					if (!success) {
						if (Math.random() < 0.1)
							recordMcp(env.WAE, {
								method: 'completion/complete',
								ok: true,
								completionRef: '<ratelimited>',
								matchCount: 0,
								userAgent,
								latencyMs: Date.now() - startedAt,
							});
						return jsonResponse({
							jsonrpc: '2.0',
							id: body.id,
							result: { completion: { values: [], total: 0, hasMore: false } },
						});
					}
				} catch {
					// fail open — availability over strict limiting
				}
			}

			const response = await handleMCP(body, baseUrl, meta);
			// clientInfo is only present on the `initialize` request; for
			// every other method it stays '-' (the per-call client signal
			// is the User-Agent, captured on all requests).
			const clientInfo =
				body?.method === 'initialize'
					? (
							body?.params as
								| { clientInfo?: { name?: string; version?: string } }
								| undefined
						)?.clientInfo
					: undefined;
			// Completion is per-keystroke (highest volume) — sample at 10%; keep
			// 100% on every other method.
			if (!isCompletion || Math.random() < 0.1) {
				recordMcp(env.WAE, {
					method: body?.method,
					tool: meta.tool,
					resource: meta.resource,
					prompt: meta.prompt,
					completionRef: meta.completionRef,
					matchCount: meta.matchCount,
					ok: !response.error,
					errorCode: response.error?.code,
					backendStatus: meta.backendStatus,
					clientName: clientInfo?.name,
					clientVersion: clientInfo?.version,
					userAgent,
					latencyMs: Date.now() - startedAt,
				});
			}
			return jsonResponse(response);
		}

		// Changelog — markdown so registry crawlers / curl users can read
		// release notes without cloning the repo. Mirror of CHANGELOG.md
		// at repo root (kept in sync via src/changelog.ts).
		if (path === '/changelog' || path === '/changelog/') {
			return new Response(CHANGELOG_MARKDOWN, {
				status: 200,
				headers: {
					'Content-Type': 'text/markdown; charset=utf-8',
					'Cache-Control': 'public, max-age=300',
					...CORS_HEADERS,
				},
			});
		}

		// MCP Server Card (SEP-2127 / .well-known discovery) — lets agents
		// like ChatGPT, Claude Desktop, and registry crawlers
		// auto-discover this server's transport, name, and version
		// without speaking JSON-RPC. Path is the one isitagentready.com's
		// validator probes; SEP-2127 also accepts /.well-known/mcp-server-card
		// (extensionless) so we serve there too as an alias.
		if (
			path === '/.well-known/mcp/server-card.json' ||
			path === '/.well-known/mcp-server-card' ||
			path === '/.well-known/mcp-server-card/'
		) {
			return jsonResponse({
				$schema:
					'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
				name: 'com.manamurah/mcp-server',
				version: SERVER_VERSION,
				title: 'ManaMurah MCP Server',
				description:
					'MCP server for Malaysian PriceCatcher consumer price data — 15 strongly-typed tools (search items, find cheapest premise, price history, MoM/YoY trends, basket watch, top movers, chain monthly movers, region gap ranker, more) + 6 reference resources (item catalogue, states, categories, chains, data freshness, methodology) + 3 guided prompts (fact-check a price claim, monthly basket cost, state-vs-national) with argument autocomplete, sourced from data.gov.my PriceCatcher.',
				websiteUrl: 'https://mcp.manamurah.com/',
				repository: {
					url: 'https://github.com/manamurah/mcp-server',
					source: 'github',
				},
				icons: [
					{
						src: 'https://manamurah.com/apple-touch-icon.png',
						sizes: ['180x180'],
						mimeType: 'image/png',
					},
				],
				remotes: [
					{
						type: 'streamable-http',
						url: 'https://mcp.manamurah.com/mcp',
						supportedProtocolVersions: [PROTOCOL_VERSION],
					},
				],
				_meta: {
					license: 'MIT',
					publisher: 'manamurah.com',
					data_source: 'https://data.gov.my PriceCatcher',
					data_license: 'Open Data Licence (Malaysia)',
					auth: 'none — public read-only',
					rate_limit: '120 req / 60s per IP',
					tool_count: TOOLS.length,
					resource_count: RESOURCES.length,
					prompt_count: PROMPTS.length,
				},
			});
		}

		// Root — self-describing manifest for registries, crawlers, and
		// humans hitting the URL in a browser. Includes the full tool
		// catalogue (with input schemas) so a directory can index every
		// tool's contract in one GET, no JSON-RPC needed. Lightweight
		// (~6 KB) and served from edge — fine to leave uncached client-
		// side so a fresh deploy is reflected immediately.
		if (path === '/' || path === '') {
			return jsonResponse({
				// Identity
				name: SERVER_PACKAGE_NAME,
				version: SERVER_VERSION,
				description:
					'MCP server for Malaysian PriceCatcher consumer price data. 15 strongly-typed tools proxied from manamurah.com, plus 6 embedded reference resources and 3 guided prompts with argument autocomplete.',
				publisher: 'manamurah.com',
				license: 'MIT',

				// Discovery
				homepage: 'https://manamurah.com',
				documentation: 'https://mcp.manamurah.com/',
				changelog: 'https://mcp.manamurah.com/changelog',
				icon: 'https://manamurah.com/apple-touch-icon.png',

				// Protocol
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {
					tools: {},
					prompts: { listChanged: false },
					resources: { listChanged: false },
					completions: {},
				},
				endpoints: {
					mcp: '/mcp',
					changelog: '/changelog',
					server_card: '/.well-known/mcp/server-card.json',
				},

				// Tool catalogue — full schemas so registries can index in one GET.
				tool_count: TOOLS.length,
				tools: TOOLS,

				// Reference resources — descriptors (read them over JSON-RPC
				// resources/read; payloads are embedded reference data, no prices).
				resource_count: RESOURCES.length,
				resources: listResources(),

				// Guided prompts — slash-command templates (run via prompts/get;
				// arguments autocomplete via completion/complete). BM output.
				prompt_count: PROMPTS.length,
				prompts: listPrompts(),

				// Versioning policy
				versioning: ROOT_VERSIONING,

				// Data lineage
				data_source: 'https://data.gov.my PriceCatcher',
				data_license: 'Open Data Licence (Malaysia) — public government data',
				upstream: baseUrl,

				// Operational
				rate_limit: '120 req / 60s per IP (enforced upstream)',
				auth: 'none — public read-only',
			});
		}

		return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
	},
};
