# Changelog

All notable changes to `manamurah-mcp-server` are documented here. The
project follows [semver](https://semver.org). The published versioning
policy lives at `GET https://mcp.manamurah.com/` under the `versioning`
key — keep this file in sync with the `current` version reported there
and the `serverInfo.version` returned by the MCP `initialize` method.

## [2.13.0] — 2026-05-26

### Added

- **`find_cheapest`: category mode.** New `category` argument (e.g. `BERAS`,
  `AYAM`) as an alternative to `item_code` — searches across every SKU in that
  item_category and returns each store's single cheapest one. Use it when the
  user names a staple ("rice", "chicken") rather than one specific product.
- **`find_cheapest`: geo radius.** New `latitude`/`longitude`/`radius_km`
  arguments restrict results to stores near a coordinate ("cheapest near me");
  rows carry `distance_km`. The model geocodes a named place itself.
- **`find_cheapest`: auto-widening.** When the most-specific scope has no rows
  this week (PriceCatcher samples only a few SKUs per store/week), the upstream
  now progressively widens — chain → radius → geo → district → state — and
  reports `widened` + `widen_note` + `scope_applied`. The `cari-termurah` prompt
  surfaces the widen note instead of implying a store is out of stock.

All additive — `item_code`-only calls are unchanged (the input now accepts
`item_code` OR `category` via `anyOf`).

## [2.12.0] — 2026-05-23

### Added

- **Dependent completion: `daerah` (district) on `cari-termurah`.** New optional
  `daerah` argument whose autocomplete is filtered by the chosen `negeri` via the
  `2025-06-18` `context.arguments` rails (2.11.0). The completer returns bare
  canonical district names (insert-verbatim) from a new embedded `DISTRICTS`
  dataset; with a valid `negeri` it scopes to that state, otherwise it returns a
  global de-duped list. The prompt instructs the model to handle cross-state name
  ambiguity when a district is given without a state.
- **`DISTRICTS` catalogue embed.** Recent-active `(state, district)` pairs from the
  price table (`prices_district_weekly` × `districts` × `states`, 12-month window),
  embedded zero-network like the rest of the catalogue.

## [2.11.0] — 2026-05-23

### Added

- **Dependent-completion protocol rails.** `initialize` now negotiates the
  protocol version honestly (echoes `2024-11-05` or `2025-06-18` when the client
  requests it, else returns the server's latest `2025-06-18`). `completion/complete`
  accepts the optional `context.arguments` field (protocol `2025-06-18`),
  self-gating by field presence — a `2024-11-05` client that omits it is
  unaffected. Context is shape-validated (`-32602` on malformed), per-value
  sanitised (non-string values dropped, strings clamped to 64 chars, ≤16 entries),
  and never recorded in telemetry. No completion-result behaviour change yet — no
  completer reads context until 2.12.0.

### Changed

- Server card `supportedProtocolVersions` lists both `2025-06-18` and `2024-11-05`.

## [2.10.0] — 2026-05-23

### Added

- **`cari-termurah` prompt (4th).** "Where is X cheapest" — the README's
  headline demand and the designated fast-follow from the prompts spec.
  Low fan-out (≤ ~2 calls): resolve the item from the embedded catalogue,
  then a single `find_cheapest` call, optionally scoped to a state via the
  `negeri` argument. Both `barang` and `negeri` autocomplete from the embedded
  catalogue (zero network). Carries the mention-with-caveat coverage floor
  (print `n=N`) and a wide-spread variant-mixing caveat; `render` is data-free
  like the other three prompts.

### Changed

- Stale protocol-notes line in `README.md` now lists the full method set
  (`prompts/get`, `resources/read`, `completion/complete`, …) instead of
  the obsolete "prompts/list (empty), resources/list (empty)".

## [2.9.0] — 2026-05-23

### Added

- **MCP Prompts.** Three client-agnostic, static-template prompts that encode
  the manamurah price-analysis discipline as one-click slash commands (BM
  output, English control plane):
  - `semak-dakwaan-harga` — fact-check a price claim, return a caveat-aware
    verdict (sahih / tidak tepat / separa tepat / data tidak cukup).
  - `basket-bulanan` — total a monthly grocery basket and flag the movers.
  - `banding-bandar-vs-nasional` — state vs national price comparison.
  - `prompts/list` + `prompts/get`; `capabilities.prompts {listChanged:false}`.
  - `prompts/get` is data-free (pure string assembly + the embedded
    methodology resource); the LLM pulls fresh data via tools when it runs.
  - Coverage thresholds + verdict taxonomy are single-sourced from
    `src/methodology.ts` (interpolated into the templates; a test guards drift).
  - Untrusted free-text args are wrapped in hard-to-forge `⟦CLAIM⟧`/`⟦ARG⟧`
    markers, framed as DATA-not-instructions, and delimiter chars are stripped
    from args before interpolation.
- **MCP Completions (argument autocomplete).** `completion/complete` +
  `capabilities.completions {}`. Completers are co-located on prompt arguments
  and read the embedded catalogue (zero network per keystroke): `barang`
  matches item `name` + `name_en` (English-typist friendly), `negeri` matches
  the 16 states/FTs (returned verbatim-cased). Native CF Workers Rate Limiting
  binding scoped to `completion/complete`; completion telemetry sampled at 10%
  with a `zeroMatch` (match-count) signal — argument values are never recorded.

### Changed

- Server card and root manifest now advertise `prompts` + `completions` and
  report `prompt_count` (+ the prompt descriptors on the root manifest).

## [2.8.0] — 2026-05-23

### Added

- **MCP Resources.** The server now advertises `resources` capability
  (`listChanged: false`) and exposes six fixed reference resources, served
  from the bundled, generated catalogue (zero network at request time):
  - `manamurah://catalogue/items` — active items (last 12 months) with
    code, Malay + English name, unit, category. No prices.
  - `manamurah://catalogue/states` — 16 states/FTs with id, slug, region.
  - `manamurah://catalogue/categories` — categories with item counts.
  - `manamurah://catalogue/chains` — chains/premises with premise counts.
  - `manamurah://meta/latest-week` — data week + reporting coverage.
  - `manamurah://docs/methodology` — pricing methodology & caveats.
- `resources/list`, `resources/read`, and `resources/templates/list`
  (empty in v1 — the item-card URI template is deferred to v2).
- Catalogue is generated from the manamurah DB via
  `scripts/export_catalogue.sql` → `scripts/gen-catalogue.mjs` →
  `src/generated/catalogue.ts`. Recent-active filtering is single-sourced
  upstream in the data repo; the generator only consumes it.
- Telemetry: a `resource` field (blob8) records the resolved resource name.

### Changed

- `search_items`, `list_chains`, and `compare_prices` descriptions now
  point at the relevant `manamurah://catalogue/*` resource so agents
  discover the round-trip-saving reference data.
- Server card and root manifest now report `resource_count` and (root) the
  full resource descriptor list.

## [2.7.0] — 2026-05-22

### Added

- **`chain_mom_movers` tool.** Biggest month-over-month price movers
  within a chain (or across all chains), with MoM + YoY per row and the
  `premise_count` behind each average. Restores parity with the upstream
  `/api/v2/mcp/chain_mom_movers` endpoint and the Python reference server,
  which both already exposed it — the Worker had drifted to 14 tools; now 15.

### Fixed

- Server-card and root-manifest descriptions reported "11 tools" (stale
  copy); they now state the correct tool count.

### Changed

- Dev tooling: `wrangler` `3.90` → `4.x` to clear transitive security
  advisories in `undici` (CRLF injection, request smuggling) and `defu`
  (prototype pollution). Dev/build-only — the deployed Worker bundle does
  not include these packages and is unaffected.

## [2.6.0] — 2026-05-11

### Added

- **`fama_price_history` tool.** Daily FAMA price time series for one
  item at a chosen level (`RUNCIT` retail, `BORONG` wholesale, `LADANG`
  farm-gate) and grain (`national`, `state`, `daerah`). Returns up to
  90 days oldest-first; missing days are listed in `missing_dates`
  rather than zero-filled. FAMA's catalogue is independent of
  PriceCatcher — `item_id` here is FAMA's own 1..46.
- **`fama_margin` tool.** Pivots FAMA's three price levels for one
  item into per-day rows with all three prices side-by-side and the
  inter-leg markup percentages already computed
  (`ladang_to_borong_pct`, `borong_to_runcit_pct`,
  `ladang_to_runcit_pct`). The unique value FAMA enables over weekly
  KPDN — answering "where in the value chain did the price move?".
  `grain='daerah'` intentionally unsupported (sparse LADANG/BORONG
  coverage at daerah grain).
- **`fama_top_movers` tool.** Daily-cadence movers per FAMA price
  level. Anchored on the latest available index date (not "today")
  because FAMA's publishing lag puts the most-recent 2-4 days
  frequently unpublished; `days_actual` echoes the realised gap.
  Same `daerah`-exclusion as `fama_margin`.
- **Use case.** Editorial skills (`manamurah-weekly-recap`,
  `manamurah-watch-daily`, `manamurah-price-analysis`) can now ask
  "did this retail spike come from rising farm-gate or expanding
  retail markup?" without leaving the MCP surface.

### Notes

- **Data source.** `manamurah_fama_prices_daily` ES index, populated
  daily at 10:00 from FAMA's "Panduan Harga Harian" Power BI report by
  manamurah-data-2026. The crawler's trailing window was widened from
  8d to 14d in the same release cycle to catch FAMA's ~1-week backfill.
- **Upstream contract** is the SK API at
  `https://manamurah.com/api/v2/mcp/fama_{price_history,margin,top_movers}`
  — this Worker just advertises the schema; the SK API enforces it.

### Changed

- `serverInfo.version` returned by `initialize` is now `2.6.0`.
- Tool count on `GET /` and the MCP Server Card is now 14 (was 11).

## [2.5.0] — 2026-05-11

### Added

- **`region_gap` tool.** New top-level tool that ranks items by
  Semenanjung-vs-Borneo regional price gap in either direction.
  Returns up to `limit` `borneo_pricier` rows (positive `gap_pct`)
  and up to `limit` `semenanjung_pricier` rows (negative `gap_pct`)
  in a single round-trip, built on the existing region monthly/weekly
  rollup. Tunable inputs: `category` (item_category filter),
  `period` (`'weekly'` or `'monthly'`, default monthly), `weekdate` /
  `month` to pin a specific period, `limit` (1–20, default 10), and
  `min_pct` (default 1.0) to ignore parity-grade noise.
- **Use case.** The `/manamurah-weekly-recap` pipeline can now surface
  newsworthy regional disparities ("which items are notably more
  expensive in Borneo this month?") in one call instead of double-
  querying `scope='region'` with `scope_value='semenanjung'` and
  `scope_value='borneo'` and diffing client-side.

### Notes

- **Upstream contract** is defined by the SK MR
  [agagroup/apps/manamurah_20240322!6](https://gitlab.com/agagroup/apps/manamurah_20240322/-/merge_requests/6)
  — this Worker just advertises the schema; the SK API enforces it.

### Changed

- `serverInfo.version` returned by `initialize` is now `2.5.0`.
- Tool count on `GET /` and the MCP Server Card is now 11 (was 10).

## [2.4.0] — 2026-05-08

### Added

- **`scope='chain_group'`** is now declared on the four scope-aware tools
  (`price_history`, `price_change`, `category_trends`, `basket_watch`).
  Pair with `scope_value` of `'supermarket'`, `'kedai-runcit'` (note
  hyphen), or `'pasar'` — the three storefront-type buckets the upstream
  monthly index aggregates premises into. Closes the schema gap with the
  upstream API which already accepts `chain_group` as a scope; the
  Worker schema now advertises it so LLMs reading the catalogue know
  it's valid.
- **`top_movers` gains `chain_group`.** Mutually exclusive with `state`
  and `region`. Pairs with `period='monthly'` because storefront-type
  rollups only live in the monthly index — week-over-week chain_group
  movement isn't computed upstream.

### Notes

- **Monthly-only.** `chain_group` is exposed in the schema for the four
  scope-aware tools, but the upstream `/api/v2/mcp/*` routes will reject
  weekly windows for it (no `manamurah_prices_chain_group_weekly` index
  exists). `price_change`, `category_trends`, and `basket_watch` already
  resolve on the monthly index by design (1/3/6/12-month windows), so
  the constraint is invisible there. `price_history` and `top_movers`
  enforce the constraint at runtime via the SK API; this Worker just
  forwards the call. Tool descriptions now flag the constraint up-front
  so LLMs don't try `period='weekly'` with a chain_group scope.

### Changed

- `serverInfo.version` returned by `initialize` is now `2.4.0`.

## [2.3.0] — 2026-05-08

### Added

- **MCP Server Card** at `/.well-known/mcp/server-card.json` per
  [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127).
  Lets agents (ChatGPT Custom Connectors, Claude Desktop, IDE
  extensions) and registry crawlers auto-discover the server's
  transport URL, name, version, license, repository, and icon
  without speaking JSON-RPC. The card carries `name` in reverse-DNS
  format (`com.manamurah/mcp-server`), the `streamable-http` remote
  pointing at `/mcp`, branding (`icons[]`, `websiteUrl`), and a
  `_meta` block echoing the data-license / rate-limit / auth fields
  from the root manifest. SEP path alias `/.well-known/mcp-server-card`
  (extensionless) serves the same payload — both validators that
  probe either path get a hit.

### Changed

- `serverInfo.version` returned by `initialize` is now `2.3.0`.
- Root manifest's `endpoints` block gains a `server_card` pointer at
  the new well-known URL.

## [2.2.0] — 2026-05-08

### Added

- **`scope='region'`** is now declared on the four scope-aware tools
  (`price_history`, `price_change`, `category_trends`, `basket_watch`).
  Pair with `scope_value` of `'semenanjung'` (peninsular) or
  `'borneo'` (Sabah/Sarawak/Labuan). Closes the schema gap with the
  upstream API which has accepted `region` since the SK B6-v2-api MR
  merged earlier today — the route worked, but the tool schema didn't
  advertise it, so LLMs reading the catalogue had no way to know.
- **`top_movers` gains `region` and `period`.** `region` mirrors
  `state` (mutually exclusive); `period` exposes the existing
  `'weekly'`/`'monthly'` upstream toggle which surfaces YoY % on each
  row when monthly.

## [2.1.0] — 2026-05-08

### Added

- **Self-describing root expanded.** `GET /` now returns the full tool
  catalogue (name + description + JSON-Schema for each input) so
  registries and crawlers can index every tool's contract in one GET
  without speaking JSON-RPC. New top-level fields: `publisher`,
  `license`, `homepage`, `documentation`, `changelog`, `icon`,
  `capabilities`, `versioning`, `data_license`, `rate_limit`, `auth`.
- **`GET /changelog`** — returns this file as `text/markdown` so
  consumers can pull release notes without cloning the repo.
- **Versioning policy declared** as a structured object on the root
  response. Major bumps for breaking changes (tool removal, required
  input added, output shape change, enum value removed); minor for
  additive changes (new tool, new optional field, broader enum); patch
  for bug fixes and perf with no schema change. Deprecation window
  before tool removal: 90 days, announced via this changelog.
- **Branding metadata** for registry directories: `icon` URL points at
  `https://manamurah.com/apple-touch-icon.png`.

### Changed

- `serverInfo.version` returned by `initialize` is now `2.1.0`.

## [2.0.0] — 2026-04-22

### Changed

- **Revamped as thin JSON-RPC shim** over the public
  `https://manamurah.com/api/v2/mcp/*` surface. No credentials, no
  backing database, no rate-limiting of its own — upstream handles
  caching (12 h KV TTL) and per-IP rate limits.
- 10 tools: `search_items`, `find_cheapest`, `price_history`,
  `nearby_premises`, `compare_prices`, `list_chains`, `price_change`,
  `top_movers`, `category_trends`, `basket_watch`.
