/**
 * Regression: no tool input_schema may use a top-level anyOf/oneOf/allOf/not.
 * The Anthropic Messages API rejects that shape ("does not support oneOf,
 * allOf, or anyOf at the top level"), 400-ing the whole request and taking
 * down every client that sends the tool (it poisoned all jin cron sessions
 * via find_cheapest). The "item_code OR category" constraint now lives in the
 * tool-call handler instead. Run: pnpm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';

async function rpc(method: string, params?: unknown) {
	const req = new Request('https://mcp.manamurah.com/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'user-agent': 'test/1.0' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const resp = await worker.fetch(req, {} as never);
	return (await resp.json()) as { result?: any; error?: any };
}

const TOP_LEVEL_REJECTED = ['anyOf', 'oneOf', 'allOf', 'not'];

test('no tool input_schema has a top-level combinator (Anthropic API 400 guard)', async () => {
	const { result } = await rpc('tools/list');
	assert.ok(Array.isArray(result?.tools), 'tools/list returns an array');
	for (const tool of result.tools) {
		const schema = tool.inputSchema ?? {};
		for (const key of TOP_LEVEL_REJECTED) {
			assert.ok(
				!(key in schema),
				`tool "${tool.name}" must not declare top-level "${key}" in input_schema`,
			);
		}
	}
});

test('find_cheapest rejects calls with neither item_code nor category', async () => {
	const { result, error } = await rpc('tools/call', { name: 'find_cheapest', arguments: {} });
	assert.equal(result, undefined, 'no result when args invalid');
	assert.equal(error?.code, -32602, 'invalid-params error code');
	assert.match(error?.message ?? '', /item_code.*category|category.*item_code/i);
});
