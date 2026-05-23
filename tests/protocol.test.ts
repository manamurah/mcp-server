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

test('completion: malformed context shape → -32602', async () => {
	const a = await rpc('completion/complete', {
		ref: { type: 'ref/prompt', name: 'banding-bandar-vs-nasional' },
		argument: { name: 'negeri', value: 'pul' },
		context: 'not-an-object',
	});
	assert.equal(a.error.code, -32602);
	const b = await rpc('completion/complete', {
		ref: { type: 'ref/prompt', name: 'banding-bandar-vs-nasional' },
		argument: { name: 'negeri', value: 'pul' },
		context: { arguments: 'nope' },
	});
	assert.equal(b.error.code, -32602);
});

test('completion: well-formed context on a context-free completer is ignored, not error', async () => {
	const a = await rpc('completion/complete', {
		ref: { type: 'ref/prompt', name: 'banding-bandar-vs-nasional' },
		argument: { name: 'negeri', value: 'pul' },
		context: { arguments: { barang: 'ayam' } },
	});
	assert.ok(a.result.completion.values.includes('Pulau Pinang'));
});

test('telemetry: neither argument.value nor context value is ever recorded', async () => {
	const points: unknown[] = [];
	const env = { WAE: { writeDataPoint: (p: unknown) => points.push(p) } };
	const origRandom = Math.random;
	Math.random = () => 0; // force the 10% completion sampler to fire
	try {
		await rpc(
			'completion/complete',
			{
				ref: { type: 'ref/prompt', name: 'banding-bandar-vs-nasional' },
				argument: { name: 'negeri', value: 'SECRET_VALUE_XYZ' },
				context: { arguments: { barang: 'SECRET_CTX_QRS' } },
			},
			env
		);
	} finally {
		Math.random = origRandom;
	}
	assert.ok(points.length > 0, 'a data point was recorded (sampler forced on)');
	const blob = JSON.stringify(points);
	assert.ok(!blob.includes('SECRET_VALUE_XYZ'), 'argument.value must not be logged');
	assert.ok(!blob.includes('SECRET_CTX_QRS'), 'context value must not be logged');
});
