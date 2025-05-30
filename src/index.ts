import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ManaMurahApiClient } from './utils/api-client';
import { QueryParser } from './utils/query-parser';
import { ResponseFormatter } from './utils/response-formatter';
import { RateLimiter } from './utils/rate-limiter';

/**
 * ManaMurah MCP Server
 * Provides Malaysian price data tools for Claude Desktop and AI applications
 */
export class ManaMurahMCPAgent extends McpAgent {
  server = new McpServer({
    name: 'ManaMurah Data API',
    version: '1.0.0',
  });

  private apiClient: ManaMurahApiClient;
  private queryParser: QueryParser;
  private responseFormatter: ResponseFormatter;
  private rateLimiter: RateLimiter;

  constructor() {
    super();

    // Initialize utilities
    this.apiClient = new ManaMurahApiClient();
    this.queryParser = new QueryParser();
    this.responseFormatter = new ResponseFormatter();
    this.rateLimiter = new RateLimiter();
  }

  async init() {
    this.setupTools();
  }

  private setupTools() {
    // Price Search Tool - Natural language price queries
    this.server.tool('get_malaysian_prices', {
      description: 'Search for current prices of consumer goods in Malaysia from official KPDN Pricecatcher data. Supports natural language queries.',
      inputSchema: z.object({
        query: z.string().describe('Natural language query (e.g., "rice prices in Kuala Lumpur", "cheapest chicken in Penang")'),
        item: z.string().optional().describe('Specific item name (e.g., "rice", "chicken", "cooking oil")'),
        location: z.string().optional().describe('Malaysian state, city, or district'),
        retailer_type: z.enum(['hypermarket', 'supermarket', 'convenience', 'grocery']).optional().describe('Type of retail outlet'),
        max_price: z.number().optional().describe('Maximum price filter in Malaysian Ringgit (RM)'),
        min_price: z.number().optional().describe('Minimum price filter in Malaysian Ringgit (RM)')
      })
    }, async (input) => {
      return await this.handlePriceSearch(input);
    });

    // Price Comparison Tool
    this.server.tool('compare_prices', {
      description: 'Compare prices across different Malaysian states, districts, or retail chains. Useful for finding regional price differences.',
      inputSchema: z.object({
        item: z.string().describe('Item to compare (e.g., "rice", "chicken")'),
        regions: z.array(z.string()).optional().describe('List of states or regions to compare (e.g., ["Kuala Lumpur", "Penang", "Johor"])'),
        comparison_type: z.enum(['states', 'retailers', 'districts']).default('states').describe('Type of comparison to perform'),
        include_statistics: z.boolean().default(true).describe('Include statistical analysis (averages, ranges)')
      })
    }, async (input) => {
      return await this.handlePriceComparison(input);
    });

    // Trend Analysis Tool
    this.server.tool('analyze_price_trends', {
      description: 'Analyze price trends and market patterns for Malaysian consumer goods over time.',
      inputSchema: z.object({
        items: z.array(z.string()).describe('List of items to analyze (e.g., ["rice", "chicken", "cooking oil"])'),
        analysis_type: z.enum(['trend', 'volatility', 'seasonal', 'regional']).describe('Type of analysis to perform'),
        time_period: z.enum(['last_week', 'last_month', 'last_quarter']).default('last_month').describe('Time range for analysis'),
        location: z.string().optional().describe('Focus analysis on specific state or region')
      })
    }, async (input) => {
      return await this.handleTrendAnalysis(input);
    });

    // Market Insights Tool
    this.server.tool('get_market_insights', {
      description: 'Get market intelligence and insights about Malaysian consumer goods prices, including anomalies and notable changes.',
      inputSchema: z.object({
        focus: z.enum(['overview', 'anomalies', 'price_changes', 'regional_differences']).default('overview').describe('Type of insights to generate'),
        categories: z.array(z.string()).optional().describe('Specific item categories to focus on'),
        timeframe: z.enum(['today', 'this_week', 'this_month']).default('this_week').describe('Timeframe for insights')
      })
    }, async (input) => {
      return await this.handleMarketInsights(input);
    });
  }

  /**
   * Handle price search queries with natural language processing
   */
  private async handlePriceSearch(input: any) {
    try {
      // Check rate limits
      const clientId = this.getClientId();
      if (!await this.rateLimiter.checkLimit(clientId)) {
        return this.responseFormatter.formatError('Rate limit exceeded. Please try again later.');
      }

      // Parse natural language query if provided
      let queryParams = { ...input };
      if (input.query) {
        const parsedQuery = this.queryParser.parseNaturalLanguage(input.query);
        queryParams = { ...queryParams, ...parsedQuery };
      }

      // Call ManaMurah API
      const results = await this.apiClient.searchPrices(queryParams);
      
      // Format response for MCP
      return this.responseFormatter.formatPriceResults(results, input.query);

    } catch (error) {
      return this.responseFormatter.formatError(`Price search failed: ${error.message}`);
    }
  }

  /**
   * Handle price comparison across regions or retailers
   */
  private async handlePriceComparison(input: any) {
    try {
      const clientId = this.getClientId();
      if (!await this.rateLimiter.checkLimit(clientId)) {
        return this.responseFormatter.formatError('Rate limit exceeded. Please try again later.');
      }

      const comparison = await this.apiClient.comparePrices(input);
      return this.responseFormatter.formatComparisonResults(comparison, input);

    } catch (error) {
      return this.responseFormatter.formatError(`Price comparison failed: ${error.message}`);
    }
  }

  /**
   * Handle trend analysis requests
   */
  private async handleTrendAnalysis(input: any) {
    try {
      const clientId = this.getClientId();
      if (!await this.rateLimiter.checkLimit(clientId)) {
        return this.responseFormatter.formatError('Rate limit exceeded. Please try again later.');
      }

      const trends = await this.apiClient.analyzeTrends(input);
      return this.responseFormatter.formatTrendResults(trends, input);

    } catch (error) {
      return this.responseFormatter.formatError(`Trend analysis failed: ${error.message}`);
    }
  }

  /**
   * Handle market insights requests
   */
  private async handleMarketInsights(input: any) {
    try {
      const clientId = this.getClientId();
      if (!await this.rateLimiter.checkLimit(clientId)) {
        return this.responseFormatter.formatError('Rate limit exceeded. Please try again later.');
      }

      const insights = await this.apiClient.getMarketInsights(input);
      return this.responseFormatter.formatInsightResults(insights, input);

    } catch (error) {
      return this.responseFormatter.formatError(`Market insights failed: ${error.message}`);
    }
  }

  /**
   * Get client identifier for rate limiting
   */
  private getClientId(): string {
    // In a real implementation, this would extract client IP or session ID
    // For now, use a placeholder
    return 'anonymous-client';
  }
}

/**
 * Main worker handler
 */
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    try {
      const agent = new ManaMurahMCPAgent();
      await agent.init();
      return await agent.run(request, { env, ctx });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'MCP Server Error', 
        message: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};