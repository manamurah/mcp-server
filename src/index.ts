/**
 * ManaMurah MCP Server — Cloudflare Workers
 *
 * A remote MCP (Model Context Protocol) server that exposes 10
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
 * refreshed weekly. 100% public government data.
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

// ---------------------------------------------------------------------
// Server identity — single source of truth for serverInfo.version,
// the version field on GET /, and what registries display. Bump
// per the policy embedded in the root response (see ROOT_VERSIONING).
// ---------------------------------------------------------------------

const SERVER_NAME = 'manamurah';                  // MCP serverInfo.name
const SERVER_PACKAGE_NAME = 'manamurah-mcp-server'; // human-facing
const SERVER_VERSION = '2.2.0';
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

interface Env {
	/** Base URL for the proxy surface. Default: https://manamurah.com */
	MANAMURAH_API_BASE?: string;
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

const SCOPES = ['national', 'state', 'district', 'chain', 'urbanisation', 'region'] as const;
const MONTHS_WINDOW = [1, 3, 6, 12] as const;

const STATES_HINT =
	"Malaysian state or federal territory, e.g. 'Selangor', 'W.P. Kuala Lumpur', 'Pulau Pinang'. Case-sensitive.";

// ---------------------------------------------------------------------
// Tool catalogue — mirrors manamurah-mcp-2026's Pydantic models
// ---------------------------------------------------------------------

const TOOLS: MCPTool[] = [
	{
		name: 'search_items',
		description:
			'Search the Malaysian PriceCatcher item catalogue by name in any language (Malay/English/Chinese/Tamil). Use this FIRST when the user mentions a food item by name to resolve it to the item_code that every other tool requires. Returns up to 20 matches with translations. Do not use for prices — chain to find_cheapest or price_history next.',
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
			"Get weekly price trend for one item at a rollup scope (national / state / district / chain / urbanisation / region). Oldest-first time series, up to 52 weeks. Use for questions like 'how has X trended over 3 months'. scope='region' compares peninsular vs East Malaysia ('semenanjung' vs 'borneo') — useful for headline averages that aren't peninsular-weighted like 'national'.",
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
						"Required when scope != 'national'. State name for scope='state', chain name for 'chain', 'URBAN'/'SUBURBAN'/'RURAL' for 'urbanisation', 'semenanjung'/'borneo' for 'region'.",
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
			"Compare one item's current-week price across national / state / district / chain / urbanisation dimensions in a single call. Use for 'is this a good price' or 'how does X compare across states'.",
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
			'Enumerate known retail chains with premise counts and geographic spread. Up to 50 chains sorted by premise count. Use to discover valid chain names before filtering find_cheapest or nearby_premises.',
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
			"Compare one item's current week to its price 1/3/6/12 months ago at any rollup scope. Returns current_week, comparison_week, absolute_change, pct_change, and direction (up/down/stable). Use for 'how much has X changed' questions.",
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
			"The items that moved most in price this week vs last week (or month vs prev month with period='monthly'). Returns top N risers and fallers sorted by absolute percentage change. Use for 'what went up/down this week' or 'biggest price changes'.",
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
						'When set, movements are computed on the state rollup. Mutually exclusive with region.',
				},
				region: {
					type: 'string',
					enum: ['semenanjung', 'borneo'],
					description:
						"When set, movements are computed on the region rollup ('semenanjung' = peninsular, 'borneo' = Sabah/Sarawak/Labuan). Mutually exclusive with state.",
				},
				period: {
					type: 'string',
					enum: ['weekly', 'monthly'],
					description:
						"Comparison grain. 'weekly' (default) = WoW; 'monthly' = MoM and surfaces yoy_pct per row.",
				},
				limit: { type: 'integer', minimum: 1, maximum: 20 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'category_trends',
		description:
			"Summarise price movement per item_category over 1/3/6/12 months. Groups items by category, returns avg_pct_change + top riser + top faller per category. Use for 'which categories went up' or 'food inflation by category'.",
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
			"Track total cost for a 1–20 item basket over 1/3/6/12 months. Returns current_total, comparison_total, pct_change, and per-item breakdown. Items missing from either week are listed as missing_items and excluded from totals (no silent zero-fill).",
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
];

// basket_watch is POST (JSON body of item_codes); every other tool is GET.
const POST_TOOLS = new Set(['basket_watch']);

// ---------------------------------------------------------------------
// Upstream proxy call
// ---------------------------------------------------------------------

async function callUpstream(
	baseUrl: string,
	toolName: string,
	args: Record<string, unknown>
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
			capabilities: { tools: {}, prompts: {}, resources: {} },
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
		},
	};
}

function handleToolsList(request: MCPRequest): MCPResponse {
	return { jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } };
}

async function handleToolCall(
	request: MCPRequest,
	baseUrl: string
): Promise<MCPResponse> {
	const params = (request.params ?? {}) as {
		name?: string;
		arguments?: Record<string, unknown>;
	};
	const name = params.name;
	const args = params.arguments ?? {};

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
		const data = await callUpstream(baseUrl, name, args);
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
	baseUrl: string
): Promise<MCPResponse> {
	try {
		switch (request.method) {
			case 'initialize':
				return handleInitialize(request);
			case 'tools/list':
				return handleToolsList(request);
			case 'tools/call':
				return await handleToolCall(request, baseUrl);
			case 'prompts/list':
				return { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
			case 'resources/list':
				return { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
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
			let body: MCPRequest;
			try {
				body = (await request.json()) as MCPRequest;
			} catch (err) {
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
			const response = await handleMCP(body, baseUrl);
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
					'MCP server for Malaysian PriceCatcher consumer price data. 10 strongly-typed tools proxied from manamurah.com.',
				publisher: 'manamurah.com',
				license: 'MIT',

				// Discovery
				homepage: 'https://manamurah.com',
				documentation: 'https://mcp.manamurah.com/',
				changelog: 'https://mcp.manamurah.com/changelog',
				icon: 'https://manamurah.com/apple-touch-icon.png',

				// Protocol
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {}, prompts: {}, resources: {} },
				endpoints: {
					mcp: '/mcp',
					changelog: '/changelog',
				},

				// Tool catalogue — full schemas so registries can index in one GET.
				tool_count: TOOLS.length,
				tools: TOOLS,

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
