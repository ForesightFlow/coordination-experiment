/**
 * Tool definitions and a mock implementation.
 *
 * The set of tools is identical across all coordination configurations
 * (Principle 1): the only thing that varies between configs is orchestration.
 */

import type { AgentTools, MarketDetails, PricePoint, SearchResult, ToolDefinition } from './types.js';

// ==========================================================================
// Tool definitions exposed to the LLM (JSON schema parameter shape)
// ==========================================================================

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'getMarketDetails',
    description:
      'Retrieve full Polymarket metadata for a market by its integer index: question, description, end date, current YES price, volume, liquidity, tags.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Market index in the round.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'getPriceHistory',
    description:
      'Retrieve recent CLOB YES-price time series for a market (sampled, last 7 days).',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Market index in the round.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'searchWeb',
    description:
      'Web search for current news and context. Returns a list of titles, URLs, snippets, and publication dates.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concise search query.' },
      },
      required: ['query'],
    },
  },
];

// ==========================================================================
// Mock tools (no network access; returns synthetic-but-plausible data)
// ==========================================================================

export class MockAgentTools implements AgentTools {
  constructor(
    private readonly markets: Array<MarketDetails & { index: number }>,
    private readonly priceHistories: Map<number, PricePoint[]> = new Map(),
    private readonly searchResults: SearchResult[] = [],
  ) {}

  async getMarketDetails(index: number): Promise<MarketDetails> {
    const m = this.markets.find(m => m.index === index);
    if (!m) throw new Error(`Mock tools: no market with index ${index}`);
    // Return a copy without the synthetic `index` field
    const { index: _ignored, ...rest } = m;
    return rest;
  }

  async getPriceHistory(index: number): Promise<PricePoint[]> {
    return this.priceHistories.get(index) ?? [];
  }

  async searchWeb(_query: string): Promise<SearchResult[]> {
    return this.searchResults.slice(0, 5);
  }
}
