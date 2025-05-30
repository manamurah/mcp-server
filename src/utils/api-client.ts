/**
 * ManaMurah API Client for MCP Server
 * Handles communication with the main ManaMurah Data API
 */
export class ManaMurahApiClient {
  private baseUrl: string;
  private aiBaseUrl: string;

  constructor() {
    this.baseUrl = 'https://api.manamurah.com/api/v1';
    this.aiBaseUrl = 'https://api.manamurah.com/api/ai/v1';
  }

  /**
   * Search for prices using the AI-optimized endpoint
   */
  async searchPrices(params: any) {
    try {
      const queryParams = new URLSearchParams();
      
      // Add natural language query if provided
      if (params.query) {
        queryParams.append('q', params.query);
      }

      // Add structured parameters
      if (params.item) queryParams.append('item', params.item);
      if (params.location) queryParams.append('location', params.location);
      if (params.retailer_type) queryParams.append('retailer_type', params.retailer_type);
      if (params.max_price) queryParams.append('max_price', params.max_price.toString());
      if (params.min_price) queryParams.append('min_price', params.min_price.toString());

      const url = `${this.aiBaseUrl}/prices/search?${queryParams.toString()}`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ManaMurah-MCP-Server/1.0.0',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error.message || 'API returned an error');
      }

      return data;

    } catch (error) {
      console.error('Price search API error:', error);
      throw new Error(`Failed to search prices: ${(error as Error).message}`);
    }
  }

  /**
   * Compare prices across regions or retailers
   */
  async comparePrices(params: any) {
    try {
      // For comparison, we'll make multiple API calls and aggregate results
      const comparisons = [];
      
      if (params.regions && params.regions.length > 0) {
        for (const region of params.regions) {
          const result = await this.searchPrices({
            item: params.item,
            location: region,
            limit: 10
          });
          
          if (result.data && result.data.length > 0) {
            comparisons.push({
              region,
              data: result.data,
              statistics: this.calculateStatistics(result.data)
            });
          }
        }
      } else {
        // Default comparison across major states
        const majorStates = ['Kuala Lumpur', 'Selangor', 'Penang', 'Johor', 'Perak'];
        for (const state of majorStates) {
          try {
            const result = await this.searchPrices({
              item: params.item,
              location: state,
              limit: 5
            });
            
            if (result.data && result.data.length > 0) {
              comparisons.push({
                region: state,
                data: result.data,
                statistics: this.calculateStatistics(result.data)
              });
            }
          } catch (error) {
            // Continue with other states if one fails
            console.warn(`Failed to get data for ${state}:`, (error as Error).message);
          }
        }
      }

      return {
        item: params.item,
        comparison_type: params.comparison_type,
        comparisons,
        summary: this.generateComparisonSummary(comparisons)
      };

    } catch (error) {
      console.error('Price comparison error:', error);
      throw new Error(`Failed to compare prices: ${(error as Error).message}`);
    }
  }

  /**
   * Analyze price trends (mock implementation for now)
   */
  async analyzeTrends(params: any) {
    try {
      // This would typically call a trends endpoint
      // For now, we'll return mock trend data
      const currentPrices = await this.searchPrices({
        item: params.items[0], // Use first item for now
        limit: 20
      });

      return {
        items: params.items,
        analysis_type: params.analysis_type,
        time_period: params.time_period,
        current_data: currentPrices,
        trend_summary: this.generateTrendSummary(currentPrices, params),
        insights: [
          'Price data shows current market conditions',
          'Regional variations exist across different states',
          'Retailer type significantly affects pricing'
        ]
      };

    } catch (error) {
      console.error('Trend analysis error:', error);
      throw new Error(`Failed to analyze trends: ${(error as Error).message}`);
    }
  }

  /**
   * Get market insights
   */
  async getMarketInsights(params: any) {
    try {
      // Get current market data
      const recentData = await this.searchPrices({
        limit: 50 // Get broader sample
      });

      return {
        focus: params.focus,
        timeframe: params.timeframe,
        data_points: recentData.data?.length || 0,
        insights: this.generateMarketInsights(recentData, params),
        summary: 'Market analysis based on current KPDN Pricecatcher data',
        last_updated: new Date().toISOString()
      };

    } catch (error) {
      console.error('Market insights error:', error);
      throw new Error(`Failed to get market insights: ${(error as Error).message}`);
    }
  }

  /**
   * Calculate basic statistics for price data
   */
  private calculateStatistics(data: any[]) {
    if (!data || data.length === 0) {
      return { average: 0, min: 0, max: 0, count: 0 };
    }

    const prices = data.map(item => item.price).filter(price => typeof price === 'number');
    
    if (prices.length === 0) {
      return { average: 0, min: 0, max: 0, count: 0 };
    }

    const sum = prices.reduce((acc, price) => acc + price, 0);
    const average = sum / prices.length;
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    return {
      average: parseFloat(average.toFixed(2)),
      min,
      max,
      count: prices.length,
      range: parseFloat((max - min).toFixed(2))
    };
  }

  /**
   * Generate comparison summary
   */
  private generateComparisonSummary(comparisons: any[]) {
    if (comparisons.length === 0) {
      return 'No data available for comparison';
    }

    const regionStats = comparisons.map(comp => ({
      region: comp.region,
      avgPrice: comp.statistics.average
    })).filter(stat => stat.avgPrice > 0);

    if (regionStats.length === 0) {
      return 'No valid price data found for comparison';
    }

    const cheapest = regionStats.reduce((min, curr) => 
      curr.avgPrice < min.avgPrice ? curr : min
    );
    
    const mostExpensive = regionStats.reduce((max, curr) => 
      curr.avgPrice > max.avgPrice ? curr : max
    );

    const avgDifference = mostExpensive.avgPrice - cheapest.avgPrice;
    const percentDifference = ((avgDifference / cheapest.avgPrice) * 100).toFixed(1);

    return `${cheapest.region} has the lowest average prices (RM${cheapest.avgPrice}), while ${mostExpensive.region} has the highest (RM${mostExpensive.avgPrice}). Price difference: ${percentDifference}%.`;
  }

  /**
   * Generate trend summary
   */
  private generateTrendSummary(data: any, params: any) {
    const statistics = this.calculateStatistics(data.data || []);
    
    return {
      current_average: statistics.average,
      price_range: `RM${statistics.min} - RM${statistics.max}`,
      sample_size: statistics.count,
      analysis: `Current ${params.items[0]} prices show an average of RM${statistics.average} with ${statistics.count} data points across Malaysia.`
    };
  }

  /**
   * Generate market insights
   */
  private generateMarketInsights(data: any, params: any) {
    const insights = [];
    
    if (data.ai_context) {
      if (data.ai_context.key_insights) {
        insights.push(...data.ai_context.key_insights);
      }
      
      if (data.ai_context.anomalies && data.ai_context.anomalies.length > 0) {
        insights.push(`Detected ${data.ai_context.anomalies.length} price anomalies in current data`);
      }
    }

    if (data.data && data.data.length > 0) {
      const statistics = this.calculateStatistics(data.data);
      insights.push(`Current market sample includes ${statistics.count} price points with average RM${statistics.average}`);
      
      if (statistics.range > statistics.average * 0.3) {
        insights.push('Significant price variation detected across different retailers and locations');
      }
    }

    if (insights.length === 0) {
      insights.push('Market data analysis shows stable pricing conditions based on available data');
    }

    return insights;
  }
}