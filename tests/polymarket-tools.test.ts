/**
 * Unit tests for PolymarketAgentTools.
 *
 * Uses Node's built-in node:test. Fetch is injected via constructor so no
 * global monkey-patching is needed.
 *
 * Integration tests (marked skip) hit the real Gamma/CLOB APIs and require
 * a real conditionId. Run manually: POLYMARKET_CONDITION_ID=0x... node --test dist/tests/polymarket-tools.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketAgentTools, PolymarketError } from '../src/tools/polymarket-tools.js';
import type { Market } from '../src/types.js';

// --------------------------------------------------------------------------
// Shared test fixtures
// --------------------------------------------------------------------------

const CONDITION_ID = '0xabc123';
const YES_TOKEN_ID = 'token-yes-id';

const MARKETS: Market[] = [
  {
    index: 0,
    question: 'Test market?',
    description: 'Test description.',
    conditionId: CONDITION_ID,
  },
];

const GAMMA_RESPONSE: object = [
  {
    question: 'Test market?',
    description: 'A detailed description.',
    endDate: '2026-06-01T00:00:00Z',
    bestBid: '0.45',
    bestAsk: '0.47',
    volume: '100000',
    liquidity: '20000',
    tags: [{ id: '1', label: 'crypto' }],
    clobTokenIds: [YES_TOKEN_ID, 'token-no-id'],
  },
];

const CLOB_RESPONSE: object = {
  history: Array.from({ length: 300 }, (_, i) => ({
    t: Math.floor(Date.now() / 1000) - (299 - i) * 3600,
    p: 0.4 + (i % 10) * 0.01,
  })),
};

const TAVILY_RESPONSE: object = {
  results: [
    {
      title: 'Result A',
      url: 'https://example.com/a',
      content: 'Snippet about the market.',
      published_date: '2026-04-01',
    },
  ],
};

// --------------------------------------------------------------------------
// Mock fetch factory
// --------------------------------------------------------------------------

type FetchMock = typeof globalThis.fetch & { callCount: number; lastUrl: string };

function makeFetchMock(responses: Record<string, object>): FetchMock {
  let callCount = 0;
  let lastUrl = '';

  const mock = async (input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    lastUrl = url;
    callCount++;

    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('Not found', { status: 404 });
  };

  Object.defineProperty(mock, 'callCount', {
    get: () => callCount,
    enumerable: true,
  });
  Object.defineProperty(mock, 'lastUrl', {
    get: () => lastUrl,
    enumerable: true,
  });

  return mock as FetchMock;
}

// --------------------------------------------------------------------------
// Tests — getMarketDetails
// --------------------------------------------------------------------------

describe('PolymarketAgentTools.getMarketDetails', () => {
  it('returns correct MarketDetails shape', async () => {
    const fetch = makeFetchMock({ 'gamma-api': GAMMA_RESPONSE });
    const tools = new PolymarketAgentTools(MARKETS, {
      fetch,
      gammaBaseUrl: 'https://gamma-api',
      clobBaseUrl: 'https://clob-api',
    });

    const details = await tools.getMarketDetails(0);
    assert.equal(details.question, 'Test market?');
    assert.equal(details.description, 'A detailed description.');
    assert.equal(details.endDate, '2026-06-01T00:00:00Z');
    assert.ok(typeof details.currentYesPrice === 'number');
    // mid of 0.45 and 0.47
    assert.ok(Math.abs(details.currentYesPrice! - 0.46) < 0.001);
    assert.equal(details.volume, 100_000);
    assert.deepEqual(details.tags, ['crypto']);
  });

  it('caches: second call does not hit Gamma again', async () => {
    const fetch = makeFetchMock({ 'gamma-api': GAMMA_RESPONSE });
    const tools = new PolymarketAgentTools(MARKETS, { fetch, gammaBaseUrl: 'https://gamma-api' });

    await tools.getMarketDetails(0);
    await tools.getMarketDetails(0);
    assert.equal(fetch.callCount, 1, 'Expected exactly 1 Gamma fetch');
  });

  it('throws PolymarketError for unknown index', async () => {
    const tools = new PolymarketAgentTools(MARKETS, { fetch: makeFetchMock({}) });
    await assert.rejects(() => tools.getMarketDetails(99), PolymarketError);
  });

  it('throws PolymarketError on 404 response', async () => {
    const fetch = makeFetchMock({}); // no match → 404
    const tools = new PolymarketAgentTools(MARKETS, { fetch, gammaBaseUrl: 'https://gamma-api' });
    await assert.rejects(() => tools.getMarketDetails(0), PolymarketError);
  });
});

// --------------------------------------------------------------------------
// Tests — getPriceHistory
// --------------------------------------------------------------------------

describe('PolymarketAgentTools.getPriceHistory', () => {
  it('returns sampled price points (≤200) from CLOB', async () => {
    const fetch = makeFetchMock({
      'gamma-api': GAMMA_RESPONSE,
      'clob-api': CLOB_RESPONSE,
    });
    const tools = new PolymarketAgentTools(MARKETS, {
      fetch,
      gammaBaseUrl: 'https://gamma-api',
      clobBaseUrl: 'https://clob-api',
    });

    const history = await tools.getPriceHistory(0);
    assert.ok(history.length > 0, 'History must not be empty');
    assert.ok(history.length <= 200, `Expected ≤200 points, got ${history.length}`);
    // Timestamps are in milliseconds
    assert.ok(history[0].timestamp > 1e12, 'Timestamps should be milliseconds');
    assert.ok(history.every(p => p.yesPrice >= 0 && p.yesPrice <= 1), 'Prices must be in [0,1]');
  });

  it('caches: second call does not hit CLOB again', async () => {
    const fetch = makeFetchMock({
      'gamma-api': GAMMA_RESPONSE,
      'clob-api': CLOB_RESPONSE,
    });
    const tools = new PolymarketAgentTools(MARKETS, {
      fetch,
      gammaBaseUrl: 'https://gamma-api',
      clobBaseUrl: 'https://clob-api',
    });

    await tools.getPriceHistory(0);
    const callsAfterFirst = fetch.callCount;
    await tools.getPriceHistory(0);
    assert.equal(fetch.callCount, callsAfterFirst, 'No additional fetches on second call');
  });

  it('shares Gamma cache with getMarketDetails (only one Gamma fetch total)', async () => {
    const fetch = makeFetchMock({
      'gamma-api': GAMMA_RESPONSE,
      'clob-api': CLOB_RESPONSE,
    });
    const tools = new PolymarketAgentTools(MARKETS, {
      fetch,
      gammaBaseUrl: 'https://gamma-api',
      clobBaseUrl: 'https://clob-api',
    });

    await tools.getMarketDetails(0);   // fetches Gamma, populates tokenIdCache
    await tools.getPriceHistory(0);    // uses cached token ID, fetches only CLOB

    // Expect exactly 2 fetches: 1 Gamma + 1 CLOB
    assert.equal(fetch.callCount, 2);
  });
});

// --------------------------------------------------------------------------
// Tests — searchWeb
// --------------------------------------------------------------------------

describe('PolymarketAgentTools.searchWeb', () => {
  it('returns results from Tavily when API key is set', async () => {
    const fetch = makeFetchMock({ 'tavily-api': TAVILY_RESPONSE });
    const tools = new PolymarketAgentTools(MARKETS, {
      fetch,
      tavilyApiKey: 'test-key',
      tavilyBaseUrl: 'https://tavily-api',
    });

    const results = await tools.searchWeb('bitcoin');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Result A');
    assert.equal(results[0].url, 'https://example.com/a');
    assert.ok(results[0].snippet.length > 0);
    assert.equal(results[0].publishedAt, '2026-04-01');
  });

  it('throws PolymarketError when no Tavily API key', async () => {
    const tools = new PolymarketAgentTools(MARKETS, {
      fetch: makeFetchMock({}),
      // no tavilyApiKey, and TAVILY_API_KEY env var should not be set in CI
    });
    // Remove env var for this test scope
    const saved = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      await assert.rejects(() => tools.searchWeb('test'), PolymarketError);
    } finally {
      if (saved !== undefined) process.env.TAVILY_API_KEY = saved;
    }
  });
});

// --------------------------------------------------------------------------
// Integration test (skipped without env var)
// --------------------------------------------------------------------------

const conditionId = process.env.POLYMARKET_CONDITION_ID;

describe('PolymarketAgentTools integration (real API)', { skip: !conditionId }, () => {
  it('fetches real market details', async () => {
    const markets: Market[] = [{ index: 0, question: 'Real market', description: '', conditionId }];
    const tools = new PolymarketAgentTools(markets);
    const details = await tools.getMarketDetails(0);
    assert.ok(details.question.length > 0, 'question must be non-empty');
    console.log('Real market details:', details);
  });
});
