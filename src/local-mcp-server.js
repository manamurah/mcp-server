#!/usr/bin/env node

/**
 * Local MCP Server for Claude Desktop
 * Implements MCP protocol locally and fetches data from ManaMurah API
 */

const MANAMURAH_API_URL = 'https://data.manamurah.com';

/**
 * Local MCP Server Implementation
 */
class LocalMCPServer {
  constructor() {
    this.tools = [
      {
        name: "get_malaysian_prices",
        description: "Search for Malaysian price data by item, location, or natural language query",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string"
            },
            item: {
              type: "string"
            },
            location: {
              type: "string"
            }
          }
        }
      },
      {
        name: "compare_prices",
        description: "Compare prices across different regions or time periods",
        inputSchema: {
          type: "object",
          properties: {
            item: {
              type: "string"
            },
            regions: {
              type: "array",
              items: { 
                type: "string" 
              }
            },
            comparison_type: {
              type: "string"
            }
          },
          required: ["item", "regions"]
        }
      },
      {
        name: "analyze_price_trends",
        description: "Analyze price trends and patterns over time",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { 
                type: "string" 
              }
            },
            time_period: {
              type: "string"
            },
            analysis_type: {
              type: "string"
            }
          },
          required: ["items"]
        }
      },
      {
        name: "get_market_insights",
        description: "Get market insights and economic indicators",
        inputSchema: {
          type: "object",
          properties: {
            focus: {
              type: "string"
            },
            timeframe: {
              type: "string"
            }
          }
        }
      }
    ];
    
    this.setupHandlers();
  }

  setupHandlers() {
    // Handle incoming messages from Claude Desktop
    process.stdin.on('data', async (data) => {
      try {
        const message = JSON.parse(data.toString().trim());
        await this.handleMessage(message);
      } catch (error) {
        this.logError('Failed to parse incoming message:', error);
        this.sendError(null, -32700, 'Parse error', error.message);
      }
    });

    // Handle process termination
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async handleMessage(message) {
    this.logDebug('Received message:', JSON.stringify(message));

    try {
      switch (message.method) {
        case 'initialize':
          await this.handleInitialize(message);
          break;
        
        case 'tools/list':
          await this.handleToolsList(message);
          break;
        
        case 'tools/call':
          await this.handleToolCall(message);
          break;
        
        default:
          this.sendError(message.id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      this.logError('Error handling message:', error);
      this.sendError(message.id, -32603, 'Internal error', error.message);
    }
  }

  async handleInitialize(message) {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "ManaMurah Data API",
          version: "1.0.0"
        }
      }
    };
    
    this.sendResponse(response);
    this.logDebug('Initialized MCP server');
  }

  async handleToolsList(message) {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: this.tools
      }
    };
    
    this.sendResponse(response);
    this.logDebug(`Listed ${this.tools.length} tools`);
  }

  async handleToolCall(message) {
    const { name, arguments: args } = message.params || {};
    
    if (!name) {
      this.sendError(message.id, -32602, 'Missing tool name');
      return;
    }

    const tool = this.tools.find(t => t.name === name);
    if (!tool) {
      this.sendError(message.id, -32602, `Unknown tool: ${name}`);
      return;
    }

    this.logDebug(`Calling tool: ${name} with args:`, JSON.stringify(args));

    try {
      let result;
      
      // Execute tool locally with real API calls
      switch (name) {
        case 'get_malaysian_prices':
          result = await this.getMalaysianPrices(args);
          break;
        case 'compare_prices':
          result = await this.comparePrices(args);
          break;
        case 'analyze_price_trends':
          result = await this.analyzeTrends(args);
          break;
        case 'get_market_insights':
          result = await this.getMarketInsights(args);
          break;
        default:
          throw new Error(`Tool not implemented: ${name}`);
      }

      const response = {
        jsonrpc: "2.0",
        id: message.id,
        result
      };
      
      this.sendResponse(response);
      this.logDebug(`Tool ${name} executed successfully`);
      
    } catch (error) {
      this.logError(`Tool ${name} failed:`, error);
      this.sendError(message.id, -32603, 'Tool execution failed', error.message);
    }
  }

  sendResponse(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  sendError(id, code, message, data = null) {
    const error = {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data && { data })
      }
    };
    process.stdout.write(JSON.stringify(error) + '\n');
  }

  logDebug(message, ...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [DEBUG] ${message}`, ...args);
  }

  /**
   * Get Malaysian prices using real API
   */
  async getMalaysianPrices(args) {
    const { query, item, location } = args;
    const searchTerm = query || `${item || 'items'} in ${location || 'Malaysia'}`;
    
    try {
      // Call the real AI search API
      const apiUrl = `${MANAMURAH_API_URL}/api/ai/v1/prices/search-simple`;
      const searchUrl = `${apiUrl}?q=${encodeURIComponent(searchTerm)}`;
      
      const response = await fetch(searchUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ManaMurah-MCP-Server/1.0.0'
        }
      });
      
      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }
      
      const apiData = await response.json();
      
      // Check if we have data
      if (!apiData.data || apiData.data.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `# Malaysian Price Search Results

**Search Query**: ${searchTerm}

## No Results Found

No matching items found for "${searchTerm}". Try:
- Using different keywords (e.g., 'ayam' instead of 'chicken')
- Broadening your search criteria
- Checking spelling of item names

## Available Items
Common items in our database include:
- **Ayam** (Chicken products)
- **Beras** (Rice varieties)  
- **Minyak** (Cooking oils)
- **Ikan** (Fish and seafood)
- **Sayur** (Vegetables)

**Data Source**: KPDN Pricecatcher Initiative`
            }
          ]
        };
      }
      
      // Format the real data for display
      const responseText = `# Malaysian Price Search Results

**Search Query**: ${searchTerm}

## Current Prices (${new Date().toLocaleDateString()})

${apiData.data.slice(0, 10).map((price) => `
### ${price.item}
- **Price**: RM ${price.price}
- **Unit**: ${price.unit || 'per item'}
- **Outlet**: ${price.premise}
- **Location**: ${price.district}, ${price.state}
- **Retailer Type**: ${price.retailer_type}
- **Last Updated**: ${price.date}
`).join('\n')}

## Market Summary
${apiData.ai_context?.summary || 'Price data aggregated from multiple outlets across Malaysia'}

## Key Insights
${apiData.ai_context?.key_insights?.map((insight) => `- ${insight}`).join('\n') || '- Real-time data from government price monitoring program'}

## Price Statistics
- **Average Price**: RM ${apiData.ai_context?.price_statistics?.average}
- **Price Range**: RM ${apiData.ai_context?.price_statistics?.min} - RM ${apiData.ai_context?.price_statistics?.max}
- **Price Variation**: ${apiData.ai_context?.price_statistics?.range_percentage}%

## Data Source
- **Provider**: KPDN (Kementerian Perdagangan Dalam Negeri)
- **Program**: Pricecatcher Initiative  
- **Coverage**: ${apiData.meta?.total} outlets nationwide
- **Update Frequency**: Daily
- **Data Confidence**: ${Math.round((apiData.ai_context?.data_confidence || 0.95) * 100)}%

## About ManaMurah Data API
This data is provided through the ManaMurah Data API, which aggregates real-time Malaysian price information from government monitoring programs to help consumers make informed purchasing decisions.

*Note: Prices may vary by location and are subject to change. Always verify current prices at the point of purchase.*`;

      return {
        content: [
          {
            type: "text",
            text: responseText
          }
        ]
      };
      
    } catch (error) {
      // Fallback error response
      return {
        content: [
          {
            type: "text",
            text: `# Malaysian Price Search Results

**Search Query**: ${searchTerm}

## Service Temporarily Unavailable

We're experiencing technical difficulties accessing the price database. Please try again in a few minutes.

**Error Details**: ${error.message}

## Alternative Actions
- Try again in a few minutes
- Visit https://data.manamurah.com directly
- Contact support if the issue persists

**Data Source**: KPDN Pricecatcher Initiative`
          }
        ]
      };
    }
  }

  /**
   * Compare prices implementation (placeholder)
   */
  async comparePrices(args) {
    return {
      content: [
        {
          type: "text",
          text: "Price comparison feature coming soon. Currently showing individual price searches only."
        }
      ]
    };
  }

  /**
   * Analyze trends implementation (placeholder)
   */
  async analyzeTrends(args) {
    return {
      content: [
        {
          type: "text",
          text: "Price trend analysis feature coming soon. Currently showing individual price searches only."
        }
      ]
    };
  }

  /**
   * Get market insights implementation (placeholder)
   */
  async getMarketInsights(args) {
    return {
      content: [
        {
          type: "text",
          text: "Market insights feature coming soon. Currently showing individual price searches only."
        }
      ]
    };
  }

  logError(message, ...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] ${message}`, ...args);
  }

  shutdown() {
    this.logDebug('Shutting down ManaMurah MCP server');
    process.exit(0);
  }
}

// Start the MCP server
const server = new LocalMCPServer();
console.error('[INFO] ManaMurah MCP Server started - ready for Claude Desktop');