/**
 * Unit tests for ConfigurableAgentTools.
 *
 * Uses Node's built-in node:test — no external test runner.
 * Run: node dist/tests/configurable-tools.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurableAgentTools } from '../src/tools/configurable-tools.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import type { AgentTools, MarketDetails, PricePoint, SearchResult } from '../src/types.js';

// --------------------------------------------------------------------------
// Minimal mock backing tools
// --------------------------------------------------------------------------

const MOCK_DETAILS: MarketDetails = {
  question: 'Test question?',
  description: 'Test description.',
  currentYesPrice: 0.6,
  volume: 10_000,
};

const MOCK_HISTORY: PricePoint[] = [
  { timestamp: 1_000_000, yesPrice: 0.5 },
  { timestamp: 2_000_000, yesPrice: 0.6 },
];

const MOCK_RESULTS: SearchResult[] = [
  { title: 'Result A', url: 'https://example.com/a', snippet: 'Snippet A' },
];

function makeMockBacking(): AgentTools & { searchCallCount: number } {
  return {
    searchCallCount: 0,
    getMarketDetails(_index: number): Promise<MarketDetails> {
      return Promise.resolve(MOCK_DETAILS);
    },
    getPriceHistory(_index: number): Promise<PricePoint[]> {
      return Promise.resolve(MOCK_HISTORY);
    },
    searchWeb(_query: string): Promise<SearchResult[]> {
      this.searchCallCount++;
      return Promise.resolve(MOCK_RESULTS);
    },
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('ConfigurableAgentTools — delegation', () => {
  it('getMarketDetails delegates to backing (enabled)', async () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), true);
    assert.deepEqual(await tools.getMarketDetails(0), MOCK_DETAILS);
  });

  it('getMarketDetails delegates to backing (disabled)', async () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), false);
    assert.deepEqual(await tools.getMarketDetails(0), MOCK_DETAILS);
  });

  it('getPriceHistory delegates to backing (enabled)', async () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), true);
    assert.deepEqual(await tools.getPriceHistory(0), MOCK_HISTORY);
  });

  it('getPriceHistory delegates to backing (disabled)', async () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), false);
    assert.deepEqual(await tools.getPriceHistory(0), MOCK_HISTORY);
  });
});

describe('ConfigurableAgentTools — web search disabled', () => {
  it('searchWeb returns [] without calling backing', async () => {
    const backing = makeMockBacking();
    const tools = new ConfigurableAgentTools(backing, false);
    const results = await tools.searchWeb('any query');
    assert.deepEqual(results, []);
    assert.equal(backing.searchCallCount, 0, 'backing.searchWeb must not be called');
  });

  it('toolDefinitions marks searchWeb description as disabled', () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), false);
    const def = tools.toolDefinitions.find(t => t.name === 'searchWeb');
    assert.ok(def, 'searchWeb definition must exist');
    assert.match(def.description, /DISABLED/i);
  });

  it('toolDefinitions preserves non-search tool descriptions unchanged', () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), false);
    for (const original of TOOL_DEFINITIONS) {
      if (original.name === 'searchWeb') continue;
      const patched = tools.toolDefinitions.find(t => t.name === original.name);
      assert.ok(patched, `${original.name} must be present`);
      assert.equal(patched.description, original.description);
    }
  });
});

describe('ConfigurableAgentTools — web search enabled', () => {
  it('searchWeb delegates to backing and returns results', async () => {
    const backing = makeMockBacking();
    const tools = new ConfigurableAgentTools(backing, true);
    const results = await tools.searchWeb('test query');
    assert.deepEqual(results, MOCK_RESULTS);
    assert.equal(backing.searchCallCount, 1);
  });

  it('toolDefinitions uses the original searchWeb description', () => {
    const tools = new ConfigurableAgentTools(makeMockBacking(), true);
    const def = tools.toolDefinitions.find(t => t.name === 'searchWeb');
    const original = TOOL_DEFINITIONS.find(t => t.name === 'searchWeb');
    assert.equal(def?.description, original?.description);
  });
});
