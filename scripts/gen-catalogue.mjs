#!/usr/bin/env node
/**
 * Catalogue generator — reads scripts/catalogue.json (produced by
 * manamurah-data-2026/scripts/export_catalogue.sql, run on AGALLM) and emits
 * src/generated/catalogue.ts: typed, sorted, embedded reference consts plus a
 * provenance header.
 *
 * The embed is the SOLE data source for #1 Resources (resources/read) and #3
 * Completions — zero network at request time (the architecture decision:
 * embed, don't proxy). The recent-active filter is single-sourced upstream in
 * the data repo; this generator only CONSUMES catalogue.json — it does NOT
 * re-derive recency.
 *
 *   Regenerate:  node scripts/gen-catalogue.mjs
 *   (re-export catalogue.json first if the data week moved — see the SQL header)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const IN = join(HERE, 'catalogue.json');
const OUT = join(HERE, '..', 'src', 'generated', 'catalogue.ts');

// Borneo = Sabah, Sarawak, W.P. Labuan; everything else is Peninsular.
const BORNEO_SLUGS = new Set(['sabah', 'sarawak', 'w-p-labuan']);

function fail(msg) {
	console.error(`gen-catalogue: ${msg}`);
	process.exit(1);
}

function num(v) {
	// MariaDB JSON_OBJECT renders COUNT()/BIGINT as JSON strings — coerce.
	const n = typeof v === 'string' ? Number(v) : v;
	if (typeof n !== 'number' || !Number.isFinite(n)) fail(`expected a number, got ${JSON.stringify(v)}`);
	return n;
}

const raw = readFileSync(IN, 'utf8');
let cat;
try {
	cat = JSON.parse(raw);
} catch (e) {
	fail(`catalogue.json is not valid JSON: ${e.message}`);
}

for (const k of ['latest_week', 'items', 'states', 'categories', 'chains']) {
	if (cat[k] == null) fail(`catalogue.json missing top-level "${k}"`);
}
if (!Array.isArray(cat.items) || cat.items.length === 0) fail('items[] empty');

// ── items: validate name_en, fall back to Malay name when missing ──
const missingEn = [];
const items = cat.items
	.map((it) => {
		let name_en = it.name_en;
		if (name_en == null || name_en === '') {
			missingEn.push(it.item_code);
			name_en = it.name; // keep the embed valid; name_en stays a non-null string
		}
		return {
			item_code: num(it.item_code),
			name: String(it.name),
			name_en: String(name_en),
			unit: String(it.unit ?? ''),
			item_category: String(it.item_category ?? ''),
		};
	})
	.sort((a, b) => a.item_code - b.item_code);

if (missingEn.length) {
	console.warn(
		`gen-catalogue: WARNING ${missingEn.length} item(s) lack an English translation; ` +
			`name_en fell back to the Malay name: ${missingEn.join(', ')}`
	);
}

// ── states: attach region ──
const states = cat.states
	.map((s) => ({
		stateid: num(s.stateid),
		name: String(s.name),
		slug: String(s.slug),
		region: BORNEO_SLUGS.has(String(s.slug)) ? 'borneo' : 'semenanjung',
	}))
	.sort((a, b) => a.stateid - b.stateid);

// ── categories: sort by name ──
const categories = cat.categories
	.map((c) => ({ category: String(c.category), item_count: num(c.item_count) }))
	.sort((a, b) => a.category.localeCompare(b.category));

// ── chains: sort by premise_count desc, then chain asc (meaningful chains first) ──
const chains = cat.chains
	.map((c) => ({
		chain: String(c.chain),
		chain_type: String(c.chain_type ?? ''),
		premise_count: num(c.premise_count),
	}))
	.sort((a, b) => b.premise_count - a.premise_count || a.chain.localeCompare(b.chain));

const latestWeekMeta = {
	latest_weekdate: String(cat.latest_week),
	premises_reporting: num(cat.premises_reporting),
	items_with_data: num(cat.items_with_data),
};

const provenance = {
	source: String(cat.source ?? 'manamurah-data-2026/scripts/export_catalogue.sql'),
	generated_at: String(cat.generated_at ?? ''),
	latest_week: String(cat.latest_week),
	recent_active_window: String(cat.recent_active_window ?? ''),
};

const j = (v) => JSON.stringify(v);
const arr = (rows) => rows.map((r) => `\t${j(r)},`).join('\n');

const out = `/**
 * GENERATED — DO NOT EDIT BY HAND.
 *
 * Source:        ${provenance.source}
 * Generated at:  ${provenance.generated_at}
 * Data week:     ${provenance.latest_week}
 * Recency:       ${provenance.recent_active_window}
 *
 * Produced by scripts/gen-catalogue.mjs from scripts/catalogue.json.
 * To refresh: re-run export_catalogue.sql on AGALLM, copy catalogue.json
 * into scripts/, then \`node scripts/gen-catalogue.mjs\`. Embedded as the
 * sole data source for #1 Resources + #3 Completions (zero-network).
 */
import type {
	CatalogueItem,
	CatalogueState,
	CatalogueCategory,
	CatalogueChain,
	LatestWeekMeta,
	CatalogueProvenance,
} from '../mcp-types.js';

export const PROVENANCE: CatalogueProvenance = ${j(provenance)};

/** Data week embedded in every JSON resource payload (envelope-level freshness). */
export const LATEST_WEEK = ${j(provenance.latest_week)} as const;

export const LATEST_WEEK_META: LatestWeekMeta = ${j(latestWeekMeta)};

/** Recent-active items (≥1 observation in the last 12 months), sorted by item_code. */
export const ITEMS: readonly CatalogueItem[] = [
${arr(items)}
];

/** 16 states / federal territories, sorted by stateid. */
export const STATES: readonly CatalogueState[] = [
${arr(states)}
];

/** Item categories among recent-active items, with counts, sorted by name. */
export const CATEGORIES: readonly CatalogueCategory[] = [
${arr(categories)}
];

/** Retail chains / standalone premises, sorted by premise_count desc. */
export const CHAINS: readonly CatalogueChain[] = [
${arr(chains)}
];
`;

writeFileSync(OUT, out, 'utf8');
console.log(
	`gen-catalogue: wrote ${OUT}\n` +
		`  items=${items.length} states=${states.length} categories=${categories.length} chains=${chains.length}\n` +
		`  latest_week=${provenance.latest_week} premises_reporting=${latestWeekMeta.premises_reporting} items_with_data=${latestWeekMeta.items_with_data}\n` +
		`  output bytes=${out.length}`
);
