/**
 * PolymarketAgentTools — read-only AgentTools backed by Polymarket Gamma + CLOB APIs.
 *
 * No order submission. No SDK dependency. Plain fetch throughout.
 *
 * API endpoints used (as of 2026-04):
 *   Gamma: https://gamma-api.polymarket.com/markets?condition_id=<conditionId>
 *   CLOB:  https://clob.polymarket.com/prices-history?market=<tokenId>&interval=max&fidelity=60
 *   Tavily search: https://api.tavily.com/search (POST)
 *
 * The constructor takes the round's Market[] so it can map integer indices to
 * conditionIds without the caller managing that mapping.
 *
 * Responses are cached in-memory per PolymarketAgentTools instance (i.e. per process
 * per run). Reconstruct the instance to clear cache.
 */

import type { AgentTools, Market, MarketDetails, PricePoint, SearchResult } from '../types.js';

// --------------------------------------------------------------------------
// Error type
// --------------------------------------------------------------------------

export class PolymarketError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PolymarketError';
  }
}

// --------------------------------------------------------------------------
// Raw Gamma API shapes (subset — only fields we need)
// --------------------------------------------------------------------------

interface GammaMarket {
  question: string;
  description: string;
  endDate?: string;           // ISO date string
  endDateIso?: string;        // some API versions use this key
  bestBid?: string;
  bestAsk?: string;
  volume?: string | number;
  liquidity?: string | number;
  tags?: Array<{ id: string; label: string } | string>;
  // CLOB token IDs: index 0 = YES token, index 1 = NO token
  clobTokenIds?: string[];
}

// --------------------------------------------------------------------------
// Raw CLOB price-history shape
// --------------------------------------------------------------------------

interface ClobPriceHistory {
  history: Array<{
    t: number; // Unix timestamp in seconds
    p: number; // YES price in [0, 1]
  }>;
}

// --------------------------------------------------------------------------
// Tavily search response shape
// --------------------------------------------------------------------------

interface TavilyResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
    published_date?: string;
  }>;
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

export interface PolymarketToolsConfig {
  /**
   * Tavily API key for web search. If absent, searchWeb() throws unless the
   * caller wraps in ConfigurableAgentTools with webSearchEnabled=false.
   */
  tavilyApiKey?: string;
  /**
   * Injected fetch implementation. Defaults to globalThis.fetch.
   * Pass a mock in unit tests.
   */
  fetch?: typeof globalThis.fetch;
  /** Override Gamma base URL (for testing). */
  gammaBaseUrl?: string;
  /** Override CLOB base URL (for testing). */
  clobBaseUrl?: string;
  /** Override Tavily base URL (for testing). */
  tavilyBaseUrl?: string;
}

const DEFAULT_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE = 'https://clob.polymarket.com';
const DEFAULT_TAVILY_BASE = 'https://api.tavily.com';

const MAX_PRICE_POINTS = 200;

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

export class PolymarketAgentTools implements AgentTools {
  private readonly markets: Market[];
  private readonly config: PolymarketToolsConfig;
  private readonly fetchFn: typeof globalThis.fetch;

  // In-memory cache keyed by conditionId / tokenId
  private readonly detailsCache = new Map<string, MarketDetails>();
  private readonly historyCache = new Map<string, PricePoint[]>();

  constructor(markets: Market[], config: PolymarketToolsConfig = {}) {
    this.markets = markets;
    this.config = config;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async getMarketDetails(index: number): Promise<MarketDetails> {
    const conditionId = this.resolveConditionId(index);
    if (this.detailsCache.has(conditionId)) {
      return this.detailsCache.get(conditionId)!;
    }

    const gammaBase = this.config.gammaBaseUrl ?? DEFAULT_GAMMA_BASE;
    const url = `${gammaBase}/markets?condition_id=${encodeURIComponent(conditionId)}`;

    let raw: GammaMarket;
    try {
      const res = await this.fetchFn(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new PolymarketError(`Gamma API returned ${res.status} for conditionId ${conditionId}`);
      }
      const body = (await res.json()) as GammaMarket[] | GammaMarket;
      raw = Array.isArray(body) ? body[0] : body;
    } catch (err) {
      if (err instanceof PolymarketError) throw err;
      throw new PolymarketError(`Gamma API fetch failed for conditionId ${conditionId}`, err);
    }

    if (!raw) {
      throw new PolymarketError(`No market found in Gamma for conditionId ${conditionId}`);
    }

    const endDate = raw.endDate ?? raw.endDateIso;
    const currentYesPrice = midFromBidAsk(raw.bestBid, raw.bestAsk);
    const tags = normaliseTags(raw.tags);

    const details: MarketDetails = {
      question: raw.question,
      description: raw.description ?? '',
      ...(endDate !== undefined && { endDate }),
      ...(currentYesPrice !== undefined && { currentYesPrice }),
      ...(raw.volume !== undefined && { volume: Number(raw.volume) }),
      ...(raw.liquidity !== undefined && { liquidity: Number(raw.liquidity) }),
      ...(tags.length > 0 && { tags }),
    };

    this.detailsCache.set(conditionId, details);

    // Populate token cache from the same response so getPriceHistory avoids
    // a redundant Gamma request when called after getMarketDetails.
    const yesTokenId = raw.clobTokenIds?.[0];
    if (yesTokenId) {
      this.tokenIdCache.set(conditionId, yesTokenId);
    }

    return details;
  }

  async getPriceHistory(index: number): Promise<PricePoint[]> {
    const conditionId = this.resolveConditionId(index);

    const cacheKey = `${conditionId}:history`;
    if (this.historyCache.has(cacheKey)) {
      return this.historyCache.get(cacheKey)!;
    }

    // resolveYesTokenId fetches Gamma if not already cached; getMarketDetails
    // populates tokenIdCache as a side effect when called first.
    const tokenId = await this.resolveYesTokenId(conditionId);

    const clobBase = this.config.clobBaseUrl ?? DEFAULT_CLOB_BASE;
    // fidelity=60 = 1-hour candles; interval=max = full history available
    const url = `${clobBase}/prices-history?market=${encodeURIComponent(tokenId)}&interval=max&fidelity=60`;

    let raw: ClobPriceHistory;
    try {
      const res = await this.fetchFn(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new PolymarketError(`CLOB API returned ${res.status} for token ${tokenId}`);
      }
      raw = (await res.json()) as ClobPriceHistory;
    } catch (err) {
      if (err instanceof PolymarketError) throw err;
      throw new PolymarketError(`CLOB API fetch failed for token ${tokenId}`, err);
    }

    const all = (raw.history ?? []).map(p => ({
      timestamp: p.t * 1000, // convert seconds → milliseconds
      yesPrice: p.p,
    }));

    // Trim to last 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = all.filter(p => p.timestamp >= cutoff);

    const sampled = sampleDown(recent, MAX_PRICE_POINTS);
    this.historyCache.set(cacheKey, sampled);
    return sampled;
  }

  async searchWeb(query: string): Promise<SearchResult[]> {
    const apiKey = this.config.tavilyApiKey ?? process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new PolymarketError(
        'searchWeb requires TAVILY_API_KEY. Either set the env var or wrap in ConfigurableAgentTools with webSearchEnabled=false.',
      );
    }

    const tavilyBase = this.config.tavilyBaseUrl ?? DEFAULT_TAVILY_BASE;
    let raw: TavilyResponse;
    try {
      const res = await this.fetchFn(`${tavilyBase}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: 5, include_answer: false }),
      });
      if (!res.ok) {
        throw new PolymarketError(`Tavily returned ${res.status}`);
      }
      raw = (await res.json()) as TavilyResponse;
    } catch (err) {
      if (err instanceof PolymarketError) throw err;
      throw new PolymarketError('Tavily search failed', err);
    }

    return (raw.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 500),
      ...(r.published_date !== undefined && { publishedAt: r.published_date }),
    }));
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private resolveConditionId(index: number): string {
    const market = this.markets.find(m => m.index === index);
    if (!market) {
      throw new PolymarketError(`No market with index ${index} in this round`);
    }
    if (!market.conditionId) {
      throw new PolymarketError(`Market at index ${index} has no conditionId`);
    }
    return market.conditionId;
  }

  // Second in-memory cache: conditionId → YES token ID
  private readonly tokenIdCache = new Map<string, string>();

  private async resolveYesTokenId(conditionId: string): Promise<string> {
    if (this.tokenIdCache.has(conditionId)) {
      return this.tokenIdCache.get(conditionId)!;
    }

    const gammaBase = this.config.gammaBaseUrl ?? DEFAULT_GAMMA_BASE;
    const url = `${gammaBase}/markets?condition_id=${encodeURIComponent(conditionId)}`;

    let raw: GammaMarket;
    try {
      const res = await this.fetchFn(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new PolymarketError(`Gamma API returned ${res.status} fetching token IDs`);
      }
      const body = (await res.json()) as GammaMarket[] | GammaMarket;
      raw = Array.isArray(body) ? body[0] : body;
    } catch (err) {
      if (err instanceof PolymarketError) throw err;
      throw new PolymarketError('Gamma API fetch failed resolving YES token ID', err);
    }

    const tokenId = raw?.clobTokenIds?.[0];
    if (!tokenId) {
      throw new PolymarketError(`Gamma returned no clobTokenIds for conditionId ${conditionId}`);
    }

    this.tokenIdCache.set(conditionId, tokenId);
    return tokenId;
  }
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function midFromBidAsk(bid?: string, ask?: string): number | undefined {
  const b = bid !== undefined ? parseFloat(bid) : NaN;
  const a = ask !== undefined ? parseFloat(ask) : NaN;
  if (!isNaN(b) && !isNaN(a)) return (b + a) / 2;
  if (!isNaN(b)) return b;
  if (!isNaN(a)) return a;
  return undefined;
}

function normaliseTags(tags?: Array<{ id: string; label: string } | string>): string[] {
  if (!tags) return [];
  return tags.map(t => (typeof t === 'string' ? t : t.label));
}

/**
 * Evenly sub-sample `points` to at most `max` elements, preserving first and last.
 * If points.length <= max, returns the original array unchanged.
 */
function sampleDown(points: PricePoint[], max: number): PricePoint[] {
  if (points.length <= max) return points;
  const result: PricePoint[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    result.push(points[Math.round(i * step)]);
  }
  return result;
}
