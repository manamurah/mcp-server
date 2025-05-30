# ManaMurah MCP - Quick Start Guide

Get Malaysian price data in Claude Desktop in 5 minutes!

## What You'll Get

Ask Claude Desktop questions like:
- "What's the price of chicken in Malaysia?"
- "Find rice prices in Selangor"  
- "Cari harga ayam di KL"

And get **real Malaysian government price data** from 2,500+ retailers!

## Quick Install (5 Steps)

### 1. Check Node.js
```bash
node --version
# Need v18+? Download from nodejs.org
```

### 2. Download Files

Create folder and download these 2 files:
```bash
mkdir ~/manamurah-mcp
cd ~/manamurah-mcp
mkdir src
```

Download to `src/` folder:
- `local-mcp-server.js` - [Download link]
- `mcp-server-claude.js` - [Download link]

### 3. Test Server
```bash
node src/local-mcp-server.js
# Should see: "[INFO] ManaMurah MCP Server started"
# Press Ctrl+C to stop
```

### 4. Configure Claude Desktop

Find config file:
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add this (update the path):
```json
{
  "mcpServers": {
    "manamurah": {
      "command": "node",
      "args": ["/Users/YOURNAME/manamurah-mcp/src/local-mcp-server.js"],
      "env": {}
    }
  }
}
```

### 5. Restart Claude Desktop

1. Close Claude Desktop completely
2. Restart it
3. Look for 🔌 icon = Success!

## Test It

Try these queries in Claude Desktop:

```
Search for chicken prices in Malaysia
```

```
Find cooking oil prices in Selangor
```

```
Cari harga beras di Penang
```

You should get real Malaysian price data with:
- Actual prices from Malaysian retailers
- Real store names (Tesco, Giant, 99 Speedmart, etc.)
- Real locations across Malaysia
- Current dates and prices

## Troubleshooting

### No 🔌 icon?
- Check Node.js: `node --version`
- Test server: `node src/local-mcp-server.js`
- Check config file path is correct
- Restart Claude Desktop completely

### No search results?
- Use Malay terms: `ayam` not `chicken`
- Try simpler queries: just `ayam` 
- Check internet connection

### Still stuck?
- Test API: `curl "https://data.manamurah.com/api/ai/v1/prices/search-simple?q=ayam"`
- Verify file paths
- Check JSON syntax in config

## What You Can Search

**Food Items (English/Malay):**
- Chicken / Ayam
- Rice / Beras  
- Cooking Oil / Minyak
- Fish / Ikan
- Vegetables / Sayur
- Milk / Susu

**Locations:**
- All Malaysian states
- Kuala Lumpur, Selangor, Johor, Penang, etc.

**Retailers:**
- Hypermarkets: Tesco, Giant, Lotus
- Supermarkets: Cold Storage, Jaya Grocer
- Convenience: 99 Speedmart, 7-Eleven

## Sample Queries

**Basic:**
```
rice prices in Malaysia
ayam prices in Selangor
minyak masak prices
```

**Advanced:**
```
Compare chicken prices between KL and Penang
Show cheapest rice in hypermarkets
Find items under RM 10
```

**Malay:**
```
Harga ayam di Malaysia
Cari harga beras murah
Bandingkan harga minyak
```

## Data Source

Real government data from:
- **KPDN** (Ministry of Domestic Trade)
- **Pricecatcher Program**
- **2,500+ retail outlets**
- **Updated daily**

---

**🎉 Success!** You now have access to real Malaysian price data in Claude Desktop. Ask away!