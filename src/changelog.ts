/**
 * Changelog text served by `GET /changelog` on the Worker.
 *
 * Mirror of the human-canonical CHANGELOG.md at the repo root. Workers
 * cannot read filesystem files at runtime (the bundle is the entire
 * universe), so the markdown is embedded here as a template literal.
 *
 * Maintainer note: when editing CHANGELOG.md, paste the same text here
 * (or vice-versa). Both files are checked into the repo so drift is
 * caught at review time.
 */
export const CHANGELOG_MARKDOWN = `# Changelog

All notable changes to \`manamurah-mcp-server\` are documented here.
The project follows [semver](https://semver.org).

## [2.2.0] — 2026-05-08

### Added

- **\`scope='region'\`** is now declared on the four scope-aware tools
  (\`price_history\`, \`price_change\`, \`category_trends\`,
  \`basket_watch\`). Pair with \`scope_value\` of \`'semenanjung'\`
  (peninsular) or \`'borneo'\` (Sabah/Sarawak/Labuan). Closes the
  schema gap with the upstream API which has accepted \`region\` since
  the SK B6-v2-api MR merged earlier today — the route worked, but the
  tool schema didn't advertise it, so LLMs reading the catalogue had
  no way to know.
- **\`top_movers\` gains \`region\` and \`period\`.** \`region\`
  mirrors \`state\` (mutually exclusive); \`period\` exposes the
  existing \`'weekly'\`/\`'monthly'\` upstream toggle which surfaces
  YoY % on each row when monthly.

## [2.1.0] — 2026-05-08

### Added

- **Self-describing root expanded.** \`GET /\` now returns the full
  tool catalogue (name + description + JSON-Schema for each input) so
  registries and crawlers can index every tool's contract in one GET
  without speaking JSON-RPC. New top-level fields: \`publisher\`,
  \`license\`, \`homepage\`, \`documentation\`, \`changelog\`, \`icon\`,
  \`capabilities\`, \`versioning\`, \`data_license\`, \`rate_limit\`,
  \`auth\`.
- **\`GET /changelog\`** — returns this file as \`text/markdown\` so
  consumers can pull release notes without cloning the repo.
- **Versioning policy declared** as a structured object on the root
  response. Major bumps for breaking changes (tool removal, required
  input added, output shape change, enum value removed); minor for
  additive changes (new tool, new optional field, broader enum); patch
  for bug fixes and perf with no schema change. Deprecation window
  before tool removal: 90 days, announced via this changelog.
- **Branding metadata** for registry directories: \`icon\` URL points
  at \`https://manamurah.com/apple-touch-icon.png\`.

### Changed

- \`serverInfo.version\` returned by \`initialize\` is now \`2.1.0\`.

## [2.0.0] — 2026-04-22

### Changed

- **Revamped as thin JSON-RPC shim** over the public
  \`https://manamurah.com/api/v2/mcp/*\` surface. No credentials, no
  backing database, no rate-limiting of its own — upstream handles
  caching (12 h KV TTL) and per-IP rate limits.
- 10 tools: \`search_items\`, \`find_cheapest\`, \`price_history\`,
  \`nearby_premises\`, \`compare_prices\`, \`list_chains\`,
  \`price_change\`, \`top_movers\`, \`category_trends\`,
  \`basket_watch\`.
`;
