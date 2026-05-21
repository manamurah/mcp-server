/**
 * Workers Analytics Engine telemetry for the MCP protocol boundary.
 *
 * One datapoint per JSON-RPC request (100% sampled — volume is low and
 * every call is high-signal). Never throws: a telemetry failure must
 * never break a tool call.
 *
 * Dataset: `manamurah_mcp` (binding `WAE`, see wrangler.toml). Created
 * implicitly on first write.
 *
 * Privacy: tool *arguments* and *response payloads* are never recorded.
 * Only the tool name, outcome, latency, coarse error class, the calling
 * client (from `initialize`), and the User-Agent are captured.
 *
 * Schema (WAE SQL exposes blobs/doubles 1-indexed):
 *
 *   index1            tool name (tools/call) or method otherwise  [GROUP BY key]
 *   blob1  method     'initialize' | 'tools/list' | 'tools/call' | 'ping' |
 *                     'prompts/list' | 'resources/list' | '<parse_error>' | other
 *   blob2  tool       tool name for tools/call, else '-'
 *   blob3  outcome    'ok' | 'error'
 *   blob4  err_class  '-' | 'parse' | 'method_not_found' | 'invalid_params' |
 *                     'internal' | 'rpc_error'
 *   blob5  client     MCP clientInfo.name from initialize, else '-'
 *   blob6  client_ver MCP clientInfo.version from initialize, else '-'
 *   blob7  user_agent truncated to 128 chars, else '-'
 *   double1 latency_ms   wall-clock around handleMCP
 *   double2 backend_status  upstream /api/v2/mcp HTTP status (tools/call), else 0
 */

/** Mutable per-request context threaded through the MCP dispatch. */
export interface CallMeta {
	/** Resolved tool name (set by handleToolCall). */
	tool?: string;
	/** Upstream /api/v2/mcp HTTP status (set by callUpstream). */
	backendStatus?: number;
}

/** Minimal structural type — decouples this module from global env typing. */
interface WaeBinding {
	writeDataPoint: (point: {
		indexes?: string[];
		blobs?: string[];
		doubles?: number[];
	}) => void;
}

export interface McpTelemetryPoint {
	method: string;
	tool?: string;
	ok: boolean;
	errorCode?: number;
	backendStatus?: number;
	clientName?: string;
	clientVersion?: string;
	userAgent?: string | null;
	latencyMs: number;
}

function trunc(s: string | null | undefined, n: number): string {
	if (!s) return '-';
	return s.length > n ? s.slice(0, n) : s;
}

/** Map a JSON-RPC error code to a coarse, low-cardinality class. */
function errClass(code: number | undefined): string {
	switch (code) {
		case undefined:
			return '-';
		case -32700:
			return 'parse';
		case -32601:
			return 'method_not_found';
		case -32602:
			return 'invalid_params';
		case -32603:
			return 'internal';
		default:
			return 'rpc_error';
	}
}

/**
 * Write one MCP usage datapoint. Silently no-ops when the WAE binding is
 * absent (local dev / unbound deploy) and swallows any write error.
 */
export function recordMcp(wae: WaeBinding | undefined, p: McpTelemetryPoint): void {
	if (!wae) return;
	try {
		const tool = p.tool || '-';
		const index = trunc(p.tool || p.method || '-', 96);
		wae.writeDataPoint({
			indexes: [index],
			blobs: [
				p.method || '-',
				tool,
				p.ok ? 'ok' : 'error',
				errClass(p.errorCode),
				trunc(p.clientName, 64),
				trunc(p.clientVersion, 32),
				trunc(p.userAgent, 128)
			],
			doubles: [
				Number.isFinite(p.latencyMs) ? p.latencyMs : 0,
				Number.isFinite(p.backendStatus as number) ? (p.backendStatus as number) : 0
			]
		});
	} catch {
		// Telemetry must never break the request.
	}
}
