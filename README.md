# manamurah-mcp-server

Remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server for Malaysian PriceCatcher consumer price data. Deployed on
Cloudflare Workers. 15 strongly-typed tools for AI agents.

**Live endpoint:** `https://mcp.manamurah.com/mcp` (POST, JSON-RPC 2.0)

**Data source:** [data.gov.my](https://data.gov.my) PriceCatcher —
~3,800 premises × ~756 items across all 16 Malaysian states/territories,
collected daily and published as weekly averages. 100% public government
data. No credentials needed anywhere in the stack.

---

## Install

The server speaks streamable HTTP at `https://mcp.manamurah.com/mcp`.
Pick the block for your client:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS (or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "manamurah": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.manamurah.com/mcp"]
    }
  }
}
```

Claude Desktop only speaks stdio, so the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
shim is the bridge. Restart the app — you'll see the 15 tools under
the 🔌 icon. Ask *"harga tembikai di Selangor?"* or *"what's the
cheapest chicken in KL this week?"* and Claude will chain
`search_items` → `find_cheapest` automatically.

### Claude Code (CLI)

One command, native streamable HTTP — no shim:

```bash
claude mcp add manamurah --transport http https://mcp.manamurah.com/mcp
```

Confirm with `claude mcp list`. Tools become available the next time
you start a Claude Code session. Add `--scope user` to make it
available across every project.

### Cursor

User-level (every project): create or edit `~/.cursor/mcp.json`.
Project-level: `<project-root>/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "manamurah": {
      "url": "https://mcp.manamurah.com/mcp"
    }
  }
}
```

Cursor 0.46+ supports remote MCP via `url` directly. Reload the
window (`Cmd-Shift-P` → *Developer: Reload Window*) and the
`manamurah` row appears under Settings → MCP with all 15 tools
listed.

### Cline (VS Code extension)

Open Cline's sidebar → ⚙️ → **MCP Servers** → **Add Server** →
select **Remote** → paste `https://mcp.manamurah.com/mcp` → name it
`manamurah`. Cline writes the config to its VS Code global storage
itself; no JSON editing needed.

For headless setup, the same JSON shape Claude Desktop uses also
works in Cline's `cline_mcp_settings.json`.

### ChatGPT (Custom Connectors)

For ChatGPT Pro / Team / Enterprise: **chatgpt.com/connectors** →
**Add custom connector** → MCP server URL
`https://mcp.manamurah.com/mcp` → no auth required (public read-only).
After approval the connector shows up in the message-input ⊕ menu.

For OpenAI Apps SDK / programmatic use (the `codex_apps.manamurah_*`
tool family in Codex): the server URL field in the app manifest at
**platform.openai.com/apps** must be exactly
`https://mcp.manamurah.com/mcp` — *not* `https://manamurah.com` (which
will fail the streamable transport probe with HTTP 403, since that's
the consumer site, not an MCP endpoint).

### Other MCP clients

Any client that supports streamable-HTTP MCP transport points
directly at `https://mcp.manamurah.com/mcp`. Stdio-only clients shim
via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) using
the same recipe as Claude Desktop above.

Quick smoke test from any shell:

```bash
curl -sS -X POST https://mcp.manamurah.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

You should see fourteen tool names — eleven KPDN PriceCatcher tools
(weekly cadence) plus three FAMA Panduan Harga Harian tools (daily
cadence, three price levels). The richer
[self-describing manifest](https://mcp.manamurah.com/) (full input
schemas + versioning policy) is also a single GET away.

## Tools

All 15 tools are read-only, public, and capped on response size to
keep LLM contexts compact. Every tool carries a detailed description
+ JSON-Schema input so the LLM picks the right one without guessing.

### KPDN PriceCatcher (weekly averages)

Retail prices only. ~3,800 premises × ~756 items, collected daily and
published as weekly averages from the
[data.gov.my PriceCatcher dataset](https://data.gov.my).

| Tool                | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `search_items`      | Find items by name in Malay / English / Chinese / Tamil    |
| `find_cheapest`     | Up to 10 cheapest premises for one item this week          |
| `price_history`     | Weekly price trend at national/state/district/chain/urban  |
| `nearby_premises`   | Premises within a geographic radius of a coordinate        |
| `compare_prices`    | One item's price across national + state + district + more |
| `list_chains`       | Directory of retail chains + premise counts + coverage     |
| `price_change`      | Delta between current week and 1 / 3 / 6 / 12 months ago   |
| `top_movers`        | Biggest weekly risers + fallers                            |
| `category_trends`   | Per-category movement over a window                        |
| `basket_watch`      | Total cost for a 1–20 item basket over time                |
| `region_gap`        | Semenanjung vs Borneo top-N price gap, both directions     |

### FAMA daily prices (Panduan Harga Harian)

Three price levels — **RUNCIT** (retail), **BORONG** (wholesale),
**LADANG** (farm-gate) — tracked daily and independently. ~46 items
(fresh produce, eggs, poultry). FAMA's catalogue is independent of
PriceCatcher: `item_id` here is FAMA's own 1..46, not the KPDN
`item_code`.

| Tool                | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `fama_price_history`| Daily series for one item at chosen level + geographic grain |
| `fama_margin`       | LADANG → BORONG → RUNCIT value-chain spread per day        |
| `fama_top_movers`   | Daily movers per level, anchored on latest index date      |

`fama_margin` and `fama_top_movers` reject `grain='daerah'` because
LADANG/BORONG coverage at daerah grain is too sparse for an honest
cut. `fama_price_history` accepts daerah for retail-only callers.

All tools require zero setup beyond the MCP config above. No API
keys. No rate limiting on the client side (upstream has a 12h KV
edge cache so repeat queries are essentially free).

## Example conversation

> **You:** Berapa harga tembikai merah tanpa biji di Selangor minggu ini?
>
> **Claude** *(calls `search_items(query="tembikai")` → gets item_code 21
> → calls `find_cheapest(item_code=21, state="Selangor")`)*:
>
> Tembikai merah tanpa biji di Selangor untuk minggu 2026-04-20:
> hanya ada 1 kedai yang melaporkan data PriceCatcher —
> **Jaya Grocer D'Pulze Cyberjaya** di daerah Sepang pada **RM 5.20/kg**.
> Data lain di KL menunjukkan NSK Seputeh/Cheras/Kepong menjual tembikai
> serupa pada RM 1.69/kg — mungkin berbaloi keluar PJ/KL jika anda di
> Selangor Selatan.

The structured response the LLM worked from:

```json
{
  "item_code": 21,
  "item_name": "TEMBIKAI MERAH TANPA BIJI",
  "weekdate": "2026-04-20",
  "results": [
    {
      "weekdate": "2026-04-20",
      "price": 5.20,
      "premise_name": "JAYA GROCER D`PULZE CYBERJAYA",
      "chain": "JAYA GROCER",
      "chain_type": "SUPERMARKET",
      "state": "Selangor",
      "district": "Sepang"
    }
  ],
  "scope": { "state": "Selangor", "district": null, "chain": null, "chain_type": null },
  "status": "ok",
  "reason": null,
  "warnings": []
}
```

## Architecture

```
 Claude Desktop ─ stdio ─ mcp-remote ─ HTTPS ─ mcp.manamurah.com
                                                    │
                                               (Cloudflare Worker, this repo)
                                                    │
                                                  fetch
                                                    ▼
                                        manamurah.com/api/v2/mcp/*
                                                    │
                                               (SvelteKit site +
                                                Cloudflare KV edge cache,
                                                12h TTL)
                                                    │
                                                    ▼
                                            public price data
```

This Worker is a thin protocol shim — it speaks MCP JSON-RPC on one
side and standard `fetch()` on the other. No business logic, no
credentials, no database binding. Every tool call goes to exactly
one upstream `/api/v2/mcp/<tool>` endpoint and passes the JSON
response through.

Keeping the shim thin means:
- The ~400 lines here are almost all tool-description JSON.
- Query/caching/index logic lives upstream where it's co-located
  with the data layer.
- Updating a tool's behaviour rarely requires a Worker redeploy.

## Self-host / fork

```bash
git clone https://github.com/manamurah/mcp-server
cd mcp-server
pnpm install

# Local dev — hot-reloads on src/ changes, binds to 127.0.0.1:8787
pnpm dev

# Exercise it:
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'

# Deploy to your own Cloudflare account:
pnpm deploy
```

To point at a staging copy of the upstream (useful when
[manamurah_20240322](https://gitlab.com/agagroup/apps/manamurah_20240322)
ships new `/api/v2/mcp/*` endpoints), override the base URL in
`wrangler.toml`:

```toml
[vars]
MANAMURAH_API_BASE = "https://staging.manamurah.com"
```

## Protocol notes

- **Transport:** HTTP POST at `/mcp`, JSON-RPC 2.0. CORS-open so
  browser-based MCP clients work without a proxy.
- **Methods supported:** `initialize`, `tools/list`, `tools/call`,
  `prompts/list` (empty), `resources/list` (empty), `ping`.
- **Tool response shape:** MCP `content: [{ type: "text", text: ... }]`
  blocks with the raw JSON payload also attached as
  `structuredContent` for clients that prefer it.
- **Error handling:** business-level issues (invalid args, no data
  for this week) come back as `{ "status": "no_data", "reason": ... }`
  at HTTP 200 so the LLM can narrate them. Only transport/infra
  failures raise JSON-RPC errors.
- **Upstream errors:** 5xx on `/api/v2/mcp/*` bubbles up as JSON-RPC
  `code: -32603` with the upstream status in `data`. 4xx passes
  through unchanged (client validation error already shaped as a
  JSON envelope on the upstream side).

## Related

- **[manamurah-mcp-2026](https://gitlab.com/agagroup/data/manamurah-mcp-2026)**
  — Python stdio MCP server covering the same 15 tools. Use this
  instead if you want a local-only MCP binary (no Cloudflare, no
  Worker hop).
- **[manamurah_20240322](https://gitlab.com/agagroup/apps/manamurah_20240322)**
  — the SvelteKit site at manamurah.com. Hosts both the public
  website and the `/api/v2/mcp/*` proxy endpoints this Worker calls.
- **[manamurah-data-2026](https://gitlab.com/agagroup/data/manamurah-data-2026)**
  — the Python ETL that populates the indices behind everything
  else. Nightly pipeline, data.gov.my PriceCatcher source of truth.

## License

MIT. See [LICENSE](LICENSE).
