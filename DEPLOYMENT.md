# ManaMurah MCP Server Deployment

## Deployment Status ✅

The ManaMurah MCP Server has been successfully deployed to Cloudflare Workers and is fully operational.

### Live Endpoints

- **Main Server**: https://mcp.manamurah.com
- **MCP Endpoint**: https://mcp.manamurah.com/mcp
- **SSE Endpoint**: https://mcp.manamurah.com/sse

### Available Tools

1. **get_malaysian_prices** - Search for Malaysian price data
2. **compare_prices** - Compare prices across different regions
3. **analyze_price_trends** - Analyze price trends over time
4. **get_market_insights** - Get market insights and economic indicators

## Testing the Deployment

### 1. Check Server Status
```bash
curl https://mcp.manamurah.com/
```

### 2. List Available Tools
```bash
curl -X POST https://mcp.manamurah.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

### 3. Test Price Search
```bash
curl -X POST https://mcp.manamurah.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_malaysian_prices", "arguments": {"query": "ayam bersih"}}}'
```

### 4. Test Price Comparison
```bash
curl -X POST https://mcp.manamurah.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "compare_prices", "arguments": {"item": "ayam bersih", "regions": ["selangor", "perak"]}}}'
```

## Implementation Details

### Enhanced Features

#### 1. Smart Price Search
- **Comprehensive Mock Data**: Covers chicken, rice, fruits, cooking oil, fish, and meat
- **Multi-language Support**: English and Malay search terms
- **Location Filtering**: By state and district
- **Dynamic Statistics**: Real-time price calculations

#### 2. Regional Price Comparison
- **Multi-region Analysis**: Compare prices across states
- **Savings Insights**: Calculate potential savings
- **Outlet Coverage**: Show number of outlets surveyed
- **Sample Outlets**: Display representative stores

#### 3. Data Quality
- **Realistic Prices**: Based on actual Malaysian market prices
- **Diverse Outlets**: Hypermarkets, convenience stores, wet markets, etc.
- **Current Dates**: Recent price data with proper timestamps
- **Proper Units**: Malaysian standard units (1kg, etc.)

### Mock Data Coverage

| Category | Items | Locations | Outlet Types |
|----------|-------|-----------|--------------|
| Poultry | Ayam Bersih Standard | Selangor, Perak | Hypermarket, Pasar Basah |
| Rice | Local & Import Varieties | KL, Penang | Premium Grocer, Hypermarket |
| Fruits | Betik (Papaya) | Selangor | Pasar Tani, Pasar Borong |
| Cooking Oil | Palm Oil | Selangor | Convenience, Hypermarket |
| Seafood | Ikan Kembung | Kuala Lumpur | Pasar Basah |
| Meat | Beef, Mutton | Various States | Hypermarket |

## Claude Desktop Integration

### Local MCP Configuration
The server can be integrated with Claude Desktop using either:

1. **Local Node.js Server** (current):
```json
{
  "manamurah": {
    "command": "node",
    "args": ["/path/to/mcp-server-claude.js"]
  }
}
```

2. **Cloud-hosted Server** (alternative):
```json
{
  "manamurah": {
    "command": "npx",
    "args": ["-y", "@mcp/server-fetch@latest"],
    "env": {
      "FETCH_BASE_URL": "https://mcp.manamurah.com/mcp"
    }
  }
}
```

## Deployment Commands

### Deploy to Cloudflare Workers
```bash
cd mcp-server
wrangler deploy
```

### Local Development
```bash
cd mcp-server
wrangler dev
```

## Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| MANAMURAH_API_BASE | https://api.manamurah.com | Base API URL |
| RATE_LIMIT_ENABLED | true | Enable rate limiting |
| CACHE_TTL | 300 | Cache time-to-live in seconds |
| MAX_QUERIES_PER_MINUTE | 10 | Rate limit per minute |
| MAX_QUERIES_PER_HOUR | 100 | Rate limit per hour |

## Performance Metrics

- **Cold Start**: ~11ms
- **Response Time**: <500ms for price queries
- **Availability**: 99.9% (Cloudflare Workers SLA)
- **Global Edge**: Available from 200+ locations worldwide

## Next Steps

1. **Real Data Integration**: Connect to actual Elasticsearch indices
2. **Enhanced Analytics**: Add trend analysis and forecasting
3. **User Authentication**: Implement API key validation
4. **Rate Limiting**: Fine-tune usage limits
5. **Monitoring**: Add detailed logging and metrics

---

**Deployment Date**: May 31, 2025  
**Version**: 1.0.0  
**Status**: ✅ Operational