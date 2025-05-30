/**
 * TypeScript type definitions for ManaMurah Data API
 */

// Price data item structure
export interface PriceItem {
  item: string;
  item_code?: string;
  item_category?: string;
  item_group?: string;
  price: number;
  premise: string;
  premise_code?: string;
  premise_category?: string;
  chain?: string;
  retailer_type?: string;
  address?: string;
  state?: string;
  district?: string;
  date: string;
  coordinates?: {
    lat: number;
    lon: number;
  };
}

// API response structure
export interface ApiResponse {
  data: PriceItem[];
  ai_context?: {
    summary: string;
    key_insights: string[];
    data_confidence: number;
    last_updated: string;
    regional_context: string;
    market_conditions: string;
    anomalies: any[];
    price_statistics?: {
      average: string;
      min: string;
      max: string;
      range_percentage: string;
    };
  };
  narrative?: {
    brief: string;
    detailed: string;
    context: string;
  };
  suggested_questions?: string[];
  meta: {
    total: number;
    data_source: string;
    api_version?: string;
    query_type?: string;
    original_query?: string;
    cache_hit?: boolean;
    request_id?: string;
    response_time?: string;
  };
}

// Price search parameters
export interface PriceSearchParams {
  query?: string;
  item?: string;
  location?: string;
  state?: string;
  district?: string;
  retailer_type?: 'hypermarket' | 'supermarket' | 'convenience' | 'grocery';
  chain?: string;
  max_price?: number;
  min_price?: number;
  limit?: number;
  offset?: number;
}

// Price comparison parameters
export interface PriceComparisonParams {
  item: string;
  regions?: string[];
  comparison_type?: 'states' | 'retailers' | 'districts';
  include_statistics?: boolean;
}

// Trend analysis parameters
export interface TrendAnalysisParams {
  items: string[];
  analysis_type: 'trend' | 'volatility' | 'seasonal' | 'regional';
  time_period?: 'last_week' | 'last_month' | 'last_quarter';
  location?: string;
}

// Market insights parameters
export interface MarketInsightsParams {
  focus?: 'overview' | 'anomalies' | 'price_changes' | 'regional_differences';
  categories?: string[];
  timeframe?: 'today' | 'this_week' | 'this_month';
}

// Statistical data structure
export interface PriceStatistics {
  average: number;
  min: number;
  max: number;
  count: number;
  range?: number;
}

// Comparison result structure
export interface ComparisonResult {
  item: string;
  comparison_type: string;
  comparisons: {
    region: string;
    data: PriceItem[];
    statistics: PriceStatistics;
  }[];
  summary: string;
}

// Trend analysis result structure
export interface TrendResult {
  items: string[];
  analysis_type: string;
  time_period: string;
  current_data: ApiResponse;
  trend_summary: {
    current_average: number;
    price_range: string;
    sample_size: number;
    analysis: string;
  };
  insights: string[];
}

// Market insights result structure
export interface MarketInsightsResult {
  focus: string;
  timeframe: string;
  data_points: number;
  insights: string[];
  summary: string;
  last_updated: string;
}

// MCP tool response structure
export interface MCPResponse {
  content: {
    type: 'text';
    text: string;
  }[];
}

// Rate limit information
export interface RateLimitStatus {
  allowed: boolean;
  remaining: {
    perMinute: number;
    perHour: number;
  };
  resetTime: {
    perMinute: number;
    perHour: number;
  };
}

// Error response structure
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    ai_guidance?: string;
    suggested_correction?: string;
    error_type?: string;
  };
}

// Query parsing result
export interface ParsedQuery {
  item?: string;
  location?: string;
  retailer_type?: string;
  max_price?: number;
  min_price?: number;
  confidence_score?: number;
}

// Malaysian location data
export type MalaysianState = 
  | 'kuala lumpur'
  | 'selangor'
  | 'johor'
  | 'penang'
  | 'perak'
  | 'kedah'
  | 'kelantan'
  | 'terengganu'
  | 'pahang'
  | 'negeri sembilan'
  | 'melaka'
  | 'perlis'
  | 'sabah'
  | 'sarawak'
  | 'putrajaya'
  | 'labuan';

// Retailer types
export type RetailerType = 'hypermarket' | 'supermarket' | 'convenience' | 'grocery';

// Analysis types
export type AnalysisType = 'trend' | 'comparison' | 'volatility' | 'regional' | 'seasonal';

// Time periods
export type TimePeriod = 'last_week' | 'last_month' | 'last_quarter' | 'last_year';

// Query intents
export type QueryIntent = 
  | 'general_search'
  | 'comparison'
  | 'trend_analysis'
  | 'find_cheapest'
  | 'find_expensive'
  | 'get_average'
  | 'market_insights';