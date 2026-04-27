/**
 * ConfigurableAgentTools — AgentTools wrapper with a web-search on/off toggle.
 *
 * Phase 1A runs with webSearchEnabled=false (historical sandbox, no leakage).
 * Phase 1B runs with webSearchEnabled=true (real-future-event markets).
 *
 * When disabled, searchWeb() returns [] immediately so the model never blocks
 * on a network call, and the tool description is updated to signal the model
 * that web search is unavailable — reducing prompt-wasted tool attempts.
 */

import type { AgentTools, MarketDetails, PricePoint, SearchResult, ToolDefinition } from '../types.js';
import { TOOL_DEFINITIONS } from '../tools.js';

export class ConfigurableAgentTools implements AgentTools {
  /**
   * Tool definitions to pass to GenerateRequest.tools.
   * The searchWeb description is patched when web search is disabled so the
   * model knows not to call it.
   */
  readonly toolDefinitions: ToolDefinition[];

  constructor(
    private readonly backing: AgentTools,
    public readonly webSearchEnabled: boolean,
  ) {
    if (webSearchEnabled) {
      this.toolDefinitions = TOOL_DEFINITIONS;
    } else {
      this.toolDefinitions = TOOL_DEFINITIONS.map(t =>
        t.name === 'searchWeb'
          ? {
              ...t,
              description:
                '[DISABLED — web search is not available in this run. Do not call this tool.]',
            }
          : t,
      );
    }
  }

  getMarketDetails(index: number): Promise<MarketDetails> {
    return this.backing.getMarketDetails(index);
  }

  getPriceHistory(index: number): Promise<PricePoint[]> {
    return this.backing.getPriceHistory(index);
  }

  searchWeb(_query: string): Promise<SearchResult[]> {
    if (!this.webSearchEnabled) {
      return Promise.resolve([]);
    }
    return this.backing.searchWeb(_query);
  }
}
