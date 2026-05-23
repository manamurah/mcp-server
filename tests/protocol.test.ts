/** Phase 1 — protocol negotiation + context plumbing (2.11.0). Run: pnpm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';

async function rpc(method: string, params?: unknown, env: unknown = {}) {
	const req = new Request('https://mcp.manamurah.com/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'user-agent': 'test/1.0' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const resp = await worker.fetch(req, env as never);
	return (await resp.json()) as { result?: any; error?: any };
}

test('initialize: echoes a supported requested protocol version', async () => {
	const a = await rpc('initialize', { protocolVersion: '2024-11-05' });
	assert.equal(a.result.protocolVersion, '2024-11-05');
	const b = await rpc('initialize', { protocolVersion: '2025-06-18' });
	assert.equal(b.result.protocolVersion, '2025-06-18');
});

test('initialize: unknown/missing version → server latest 2025-06-18', async () => {
	const a = await rpc('initialize', { protocolVersion: '1999-01-01' });
	assert.equal(a.result.protocolVersion, '2025-06-18');
	const b = await rpc('initialize', {});
	assert.equal(b.result.protocolVersion, '2025-06-18');
});
