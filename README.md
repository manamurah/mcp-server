# ManaMurah MCP Server

A Model Context Protocol (MCP) server for Malaysian price data from KPDN Pricecatcher. This server enables direct integration with Claude Desktop and other MCP-compatible AI tools for querying Malaysian consumer goods prices.

## Features

🇲🇾 **Official Malaysian Price Data** - KPDN Pricecatcher data via OpenDOSM  
🤖 **AI-Optimized** - Natural language queries with intelligent parsing  
⚡ **Serverless** - Deployed on Cloudflare Workers for global performance  
🔒 **Rate Limited** - Built-in abuse protection and fair usage  
📊 **Rich Analytics** - Price comparisons, trends, and market insights  
🎯 **Claude Desktop Ready** - One-click setup for Claude Desktop integration  

## Live Demo

The MCP server is deployed and accessible at:
- **Production**: https://mcp.manamurah.com
- **API Endpoint**: https://mcp.manamurah.com/mcp
- **Status**: https://mcp.manamurah.com/ (returns server info)

## Quick Start

### Deploy to Cloudflare Workers

```bash
# Clone or create from template
npm create cloudflare@latest manamurah-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless

# Replace src/ contents with ManaMurah implementation
# (Copy files from this directory)

# Install dependencies
npm install

# Deploy to Cloudflare Workers
npm run deploy
```

### Connect to Claude Desktop

1. Get your deployed Workers URL (e.g., `https://mcp.manamurah.com`)
2. Add to Claude Desktop MCP configuration:

```json
{
  "manamurah": {
    "command": "node",
    "args": ["/path/to/mcp-client.js"],
    "env": {
      "MCP_SERVER_URL": "https://mcp.manamurah.com/sse"
    }
  }
}
```

3. Restart Claude Desktop
4. Start asking about Malaysian prices!

## Available Tools

### 🔍 get_malaysian_prices
Search for current prices with natural language queries.

**Examples:**
- "rice prices in Kuala Lumpur"
- "cheapest chicken in Penang hypermarkets"
- "cooking oil under RM20 in Selangor"

### 📊 compare_prices
Compare prices across different regions or retail chains.

**Examples:**
- Compare rice prices between KL and Penang
- Find price differences across retail chains
- Regional price analysis for specific items

### 📈 analyze_price_trends
Analyze price trends and market patterns over time.

**Examples:**
- Price volatility analysis
- Seasonal price patterns
- Regional market trends

### 💡 get_market_insights
Get market intelligence and insights about price anomalies.

**Examples:**
- Recent price changes
- Market anomaly detection
- Regional price differences

## Example Usage

### Basic Price Search
```
User: "What are rice prices in Kuala Lumpur?"

MCP Response:
📊 Summary: Rice prices in Kuala Lumpur range from RM15.20-RM25.80 per 5kg

💡 Key Insights:
• Hypermarkets offer 18% lower prices than convenience stores
• Significant price variation exists across different retailers

📈 Price Statistics:
• Average: RM18.50
• Range: RM15.20 - RM25.80
• Price Variation: 32%

[Detailed price listings follow...]
```

### Price Comparison
```
User: "Compare chicken prices between Penang and Johor"

MCP Response:
📊 Summary: Penang has lower average chicken prices (RM8.20) compared to Johor (RM9.10)

## Regional Comparison

### 1. Penang
• Average Price: RM8.20
• Price Range: RM7.50 - RM9.80
• Sample Size: 15 price points

### 2. Johor
• Average Price: RM9.10
• Price Range: RM8.20 - RM11.50
• Sample Size: 12 price points

💡 Comparison Insights:
• Most Affordable: Penang (RM8.20 average)
• Potential Savings: RM0.90 (9.9%) by choosing Penang
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Type checking
npm run type-check

# Linting
npm run lint
```

### Project Structure

```
src/
├── index.ts                 # Main MCP server implementation
├── utils/
│   ├── api-client.ts        # ManaMurah API client
│   ├── query-parser.ts      # Natural language query parsing
│   ├── response-formatter.ts # MCP response formatting
│   └── rate-limiter.ts      # Rate limiting implementation
└── types/
    └── manamurah.ts         # TypeScript type definitions
```

### Configuration

Environment variables in `wrangler.toml`:

```toml
[vars]
MANAMURAH_API_BASE = "https://api.manamurah.com"
RATE_LIMIT_ENABLED = "true"
CACHE_TTL = "300"
MAX_QUERIES_PER_MINUTE = "10"
MAX_QUERIES_PER_HOUR = "100"
```

## Rate Limits

- **Per Minute**: 10 requests
- **Per Hour**: 100 requests
- **Automatic Cleanup**: Old request data is cleaned up automatically

Rate limits help ensure fair usage and prevent abuse while allowing genuine research and analysis.

## Features

### Natural Language Processing
- Intelligent extraction of items, locations, and price constraints
- Support for Malaysian terms (e.g., "beras" for rice, "ayam" for chicken)
- Price range detection ("under RM20", "between RM10 and RM15")
- Location recognition for all Malaysian states and major cities

### Rich Response Formatting
- Markdown-formatted responses optimized for Claude Desktop
- Statistical analysis with averages, ranges, and insights
- Suggested follow-up questions for continued exploration
- Data source attribution and freshness indicators

### Error Handling
- User-friendly error messages with helpful suggestions
- Graceful degradation when data is unavailable
- Query improvement recommendations
- Comprehensive error logging for debugging

## Data Source

**Official Government Data**: KPDN Pricecatcher program via [OpenDOSM](https://open.dosm.gov.my)

- Daily data updates (subject to government publication schedules)
- Comprehensive coverage of Malaysian retail prices
- Data includes hypermarkets, supermarkets, convenience stores, and grocery shops
- Covers all Malaysian states and major urban centers

## Support

### Getting Help
- **Documentation**: [api.manamurah.com/docs](https://api.manamurah.com/docs)
- **AI Integration Guide**: [Complete guide for AI developers](../docs/ai-integration-guide.md)
- **Issues**: [GitHub Issues](https://github.com/manamurah/api/issues)

### Contact
- **General Support**: support@manamurah.com
- **AI Integration**: ai-support@manamurah.com
- **Enterprise**: enterprise@manamurah.com

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please read our contributing guidelines and submit pull requests for any improvements.

---

**Built with ❤️ for the Malaysian data community**

Making Malaysian price data accessible to AI tools and researchers worldwide.