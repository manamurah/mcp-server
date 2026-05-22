/**
 * Tests for #1 MCP Resources (2.8.0) + the generated catalogue.
 * Run: npm test  (node --import tsx --test tests/*.test.ts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listResources, readResource, RESOURCES } from '../src/resources.ts';
import {
	ITEMS,
	STATES,
	CATEGORIES,
	CHAINS,
	LATEST_WEEK,
	LATEST_WEEK_META,
} from '../src/generated/catalogue.ts';
import worker from '../src/index.ts';

const ALL_URIS = [
	'manamurah://catalogue/items',
	'manamurah://catalogue/states',
	'manamurah://catalogue/categories',
	'manamurah://catalogue/chains',
	'manamurah://meta/latest-week',
	'manamurah://docs/methodology',
];

// ── generated catalogue sanity ──

test('generated catalogue: shapes + recent-active filter', () => {
	assert.ok(ITEMS.length > 0, 'ITEMS non-empty');
	assert.equal(STATES.length, 16, '16 states/FTs');
	assert.ok(CATEGORIES.length > 0);
	assert.ok(CHAINS.length > 0);

	// name_en required (non-empty string) on every item.
	for (const it of ITEMS) {
		assert.equal(typeof it.name_en, 'string');
		assert.ok(it.name_en.length > 0, `item ${it.item_code} has name_en`);
	}

	// recent-active: discontinued 1201 absent, known-active 1 present.
	assert.ok(!ITEMS.some((i) => i.item_code === 1201), '1201 (discontinued) excluded');
	assert.ok(ITEMS.some((i) => i.item_code === 1), 'item 1 (active) present');

	// items sorted by item_code ascending.
	for (let i = 1; i < ITEMS.length; i++) {
		assert.ok(ITEMS[i].item_code > ITEMS[i - 1].item_code, 'items strictly ascending by code');
	}

	// region map.
	for (const s of STATES) assert.ok(s.region === 'semenanjung' || s.region === 'borneo');
	assert.equal(STATES.find((s) => s.slug === 'sabah')?.region, 'borneo');
	assert.equal(STATES.find((s) => s.slug === 'sarawak')?.region, 'borneo');
	assert.equal(STATES.find((s) => s.slug === 'w-p-labuan')?.region, 'borneo');
	assert.equal(STATES.find((s) => s.slug === 'selangor')?.region, 'semenanjung');

	// chains sorted by premise_count descending.
	for (let i = 1; i < CHAINS.length; i++) {
		assert.ok(CHAINS[i].premise_count <= CHAINS[i - 1].premise_count, 'chains desc by premise_count');
	}

	// latest-week meta: 3 numeric fields.
	assert.equal(typeof LATEST_WEEK_META.latest_weekdate, 'string');
	assert.equal(typeof LATEST_WEEK_META.premises_reporting, 'number');
	assert.equal(typeof LATEST_WEEK_META.items_with_data, 'number');
	assert.equal(LATEST_WEEK_META.latest_weekdate, LATEST_WEEK);
});

// ── listResources ──

test('listResources: 6 descriptors, required fields, no kind leak', () => {
	const list = listResources();
	assert.equal(list.length, 6);
	assert.deepEqual(
		list.map((r) => r.uri).sort(),
		[...ALL_URIS].sort()
	);
	for (const r of list) {
		for (const f of ['uri', 'name', 'title', 'description', 'mimeType'] as const) {
			assert.ok(typeof r[f] === 'string' && r[f].length > 0, `${r.uri} has ${f}`);
		}
		assert.ok(!('kind' in r), 'kind not leaked into resources/list');
	}
});

test('listResources: normative copy', () => {
	const byUri = new Map(listResources().map((r) => [r.uri, r]));
	const items = byUri.get('manamurah://catalogue/items')!;
	assert.match(items.description, /No prices|no prices/);
	assert.match(items.description, /12 months/);
	assert.match(items.description, /search_items/);
	assert.match(byUri.get('manamurah://catalogue/states')!.description, /region/);
	assert.match(byUri.get('manamurah://docs/methodology')!.description, /n>=30|n≥30/);
});

// ── readResource ──

test('readResource: every fixed URI returns valid contents', () => {
	for (const uri of ALL_URIS) {
		const res = readResource(uri);
		assert.ok(res.ok, `${uri} ok`);
		if (!res.ok) continue;
		assert.equal(res.contents.length, 1);
		const c = res.contents[0];
		assert.equal(c.uri, uri);
		const expectedMime = RESOURCES.find((r) => r.uri === uri)!.mimeType;
		assert.equal(c.mimeType, expectedMime);
		assert.ok(c.text.length > 0);
		if (expectedMime === 'application/json') {
			const parsed = JSON.parse(c.text); // must be valid JSON
			assert.ok(parsed);
		}
	}
});

test('readResource: JSON catalogue payloads carry weekdate envelope', () => {
	for (const uri of [
		'manamurah://catalogue/items',
		'manamurah://catalogue/states',
		'manamurah://catalogue/categories',
		'manamurah://catalogue/chains',
	]) {
		const res = readResource(uri);
		assert.ok(res.ok);
		if (!res.ok) continue;
		const parsed = JSON.parse(res.contents[0].text);
		assert.equal(parsed.weekdate, LATEST_WEEK, `${uri} weekdate`);
	}
});

test('readResource: methodology is markdown', () => {
	const res = readResource('manamurah://docs/methodology');
	assert.ok(res.ok);
	if (!res.ok) return;
	assert.equal(res.contents[0].mimeType, 'text/markdown');
	assert.match(res.contents[0].text, /methodology/i);
});

test('readResource: unknown URI → -32602 actionable', () => {
	const res = readResource('manamurah://catalogue/bogus');
	assert.ok(!res.ok);
	if (res.ok) return;
	assert.equal(res.code, -32602);
	assert.match(res.message, /resources\/list/);
});

test('readResource: empty URI is not in allowlist → -32602', () => {
	const res = readResource('');
	assert.ok(!res.ok);
});

// ── size + recent-active gates (on the served payload) ──

test('size gate: catalogue/items serialized < 100KB', () => {
	const res = readResource('manamurah://catalogue/items');
	assert.ok(res.ok);
	if (!res.ok) return;
	const bytes = Buffer.byteLength(res.contents[0].text, 'utf8');
	assert.ok(bytes < 100 * 1024, `items payload ${bytes} bytes < 100KB`);
});

test('served catalogue/items: 1201 absent, item 1 present', () => {
	const res = readResource('manamurah://catalogue/items');
	assert.ok(res.ok);
	if (!res.ok) return;
	const { items } = JSON.parse(res.contents[0].text) as { items: { item_code: number }[] };
	assert.ok(!items.some((i) => i.item_code === 1201));
	assert.ok(items.some((i) => i.item_code === 1));
});

// ── worker JSON-RPC dispatch (the wiring in src/index.ts) ──

async function rpc(method: string, params?: unknown) {
	const req = new Request('https://mcp.manamurah.com/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'user-agent': 'test/1.0' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const resp = await worker.fetch(req, {} as never);
	return (await resp.json()) as { result?: any; error?: any };
}

test('dispatch: initialize advertises resources capability', async () => {
	const r = await rpc('initialize', { protocolVersion: '2024-11-05' });
	assert.deepEqual(r.result.capabilities.resources, { listChanged: false });
});

test('dispatch: resources/list returns 6', async () => {
	const r = await rpc('resources/list');
	assert.equal(r.result.resources.length, 6);
});

test('dispatch: resources/read returns contents', async () => {
	const r = await rpc('resources/read', { uri: 'manamurah://catalogue/states' });
	assert.equal(r.result.contents[0].uri, 'manamurah://catalogue/states');
	assert.equal(r.result.contents[0].mimeType, 'application/json');
});

test('dispatch: resources/read unknown URI → -32602', async () => {
	const r = await rpc('resources/read', { uri: 'manamurah://nope' });
	assert.equal(r.error.code, -32602);
});

test('dispatch: resources/read missing uri → -32602', async () => {
	const r = await rpc('resources/read', {});
	assert.equal(r.error.code, -32602);
});

test('dispatch: resources/templates/list → empty', async () => {
	const r = await rpc('resources/templates/list');
	assert.deepEqual(r.result.resourceTemplates, []);
});
