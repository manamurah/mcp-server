import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Simple ManaMurah MCP Server
 * Basic implementation for testing MCP functionality
 */
export class ManaMurahMCPAgent extends McpAgent {
  server = new McpServer({
    name: 'ManaMurah Data API',
    version: '1.0.0',
  });

  async init() {
    // Simple price search tool
    this.server.tool('get_malaysian_prices', {
      query: z.string().describe('Natural language query like "rice prices in KL"'),
      item: z.string().optional().describe('Specific item name'),
      location: z.string().optional().describe('Malaysian state or city'),
    }, async (input) => {
      try {
        // Simple mock response for testing
        const response = `# Price Search Results

**Query**: ${input.query || `${input.item} in ${input.location}`}

## Sample Price Data
- **Beras Super Tempatan 5kg**: RM18.50 at Tesco Subang Jaya
- **Location**: Subang Jaya, Selangor
- **Date**: ${new Date().toLocaleDateString()}

## Summary
This is a test response from the ManaMurah MCP Server. In production, this would return real Malaysian price data from KPDN Pricecatcher.

**Data Source**: KPDN Pricecatcher via OpenDOSM`;

        return {
          content: [
            {
              type: 'text',
              text: response
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text', 
              text: `Error: ${(error as Error).message}`
            }
          ]
        };
      }
    });
  }
}

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return ManaMurahMCPAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return ManaMurahMCPAgent.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("ManaMurah MCP Server - Use /sse or /mcp endpoints", { status: 200 });
  },
};