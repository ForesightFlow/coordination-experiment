/**
 * Unit tests for ForesightFlow source (JSONL loader and schema validation).
 *
 * Uses Node's built-in node:test. Creates temporary JSONL fixtures in-memory
 * using a tmpfile approach — no permanent test files needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonlForesightFlowSource,
  ApiForesightFlowSource,
  loadFixtureWithOutcomes,
  ForesightFlowError,
  ConfigError,
} from '../src/sources/foresightflow.js';
import type { FetchCriteria } from '../src/sources/foresightflow.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ff-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRow(overrides: Record<string, unknown> = {}): object {
  return {
    marketId: '0xabc123',
    question: 'Will X happen?',
    category: 'crypto',
    resolvedAt: '2026-01-15T12:00:00+00:00',
    resolutionOutcome: 1,
    baselineMidPrice: 0.75,
    volumeUsdc: 100_000,
    ilsScore: null,
    ...overrides,
  };
}

const WIDE_CRITERIA: FetchCriteria = {
  resolvedAfter: new Date('2020-01-01'),
  resolvedBefore: new Date('2030-01-01'),
  categories: ['crypto', 'politics', 'sports', 'economics', 'geopolitics', 'entertainment'],
  minVolumeUsd: 0,
  limit: 1000,
};

// --------------------------------------------------------------------------
// JsonlForesightFlowSource — happy path
// --------------------------------------------------------------------------

describe('JsonlForesightFlowSource — happy path', () => {
  it('loads and parses a valid JSONL file', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(path, JSON.stringify(makeRow()) + '\n');
      const source = new JsonlForesightFlowSource(path);
      const markets = await source.fetchMarkets(WIDE_CRITERIA);
      assert.equal(markets.length, 1);
      assert.equal(markets[0].question, 'Will X happen?');
      assert.equal(markets[0].conditionId, '0xabc123');
      assert.equal(markets[0].midPrice, 0.75);
    });
  });

  it('assigns sequential integer indices starting at 0', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      const lines = [
        makeRow({ marketId: '0x001', question: 'Q1?' }),
        makeRow({ marketId: '0x002', question: 'Q2?' }),
        makeRow({ marketId: '0x003', question: 'Q3?' }),
      ]
        .map(r => JSON.stringify(r))
        .join('\n');
      await writeFile(path, lines + '\n');
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets(WIDE_CRITERIA);
      assert.deepEqual(
        markets.map(m => m.index),
        [0, 1, 2],
      );
    });
  });

  it('defaults description to "" when field is absent', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(path, JSON.stringify(makeRow()) + '\n'); // no description field
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets(WIDE_CRITERIA);
      assert.equal(markets[0].description, '');
    });
  });

  it('skips blank lines', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(path, '\n' + JSON.stringify(makeRow()) + '\n\n');
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets(WIDE_CRITERIA);
      assert.equal(markets.length, 1);
    });
  });
});

// --------------------------------------------------------------------------
// JsonlForesightFlowSource — filtering
// --------------------------------------------------------------------------

describe('JsonlForesightFlowSource — filtering', () => {
  it('filters by resolvedAfter', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      const lines = [
        makeRow({ resolvedAt: '2025-06-01T00:00:00+00:00' }), // too early
        makeRow({ resolvedAt: '2026-02-01T00:00:00+00:00' }), // in range
      ]
        .map(r => JSON.stringify(r))
        .join('\n');
      await writeFile(path, lines);
      const criteria: FetchCriteria = {
        ...WIDE_CRITERIA,
        resolvedAfter: new Date('2026-01-01'),
        resolvedBefore: new Date('2027-01-01'),
      };
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets(criteria);
      assert.equal(markets.length, 1);
    });
  });

  it('filters by category', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      const lines = [
        makeRow({ category: 'crypto' }),
        makeRow({ category: 'politics' }),
      ]
        .map(r => JSON.stringify(r))
        .join('\n');
      await writeFile(path, lines);
      const criteria: FetchCriteria = { ...WIDE_CRITERIA, categories: ['crypto'] };
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets(criteria);
      assert.equal(markets.length, 1);
    });
  });

  it('filters by minVolumeUsd', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      const lines = [
        makeRow({ volumeUsdc: 49_999 }), // below threshold
        makeRow({ volumeUsdc: 50_000 }), // exactly at threshold
      ]
        .map(r => JSON.stringify(r))
        .join('\n');
      await writeFile(path, lines);
      const criteria: FetchCriteria = { ...WIDE_CRITERIA, minVolumeUsd: 50_000 };
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets(criteria);
      assert.equal(markets.length, 1);
    });
  });

  it('respects limit', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      const lines = Array.from({ length: 10 }, () => makeRow())
        .map(r => JSON.stringify(r))
        .join('\n');
      await writeFile(path, lines);
      const markets = await new JsonlForesightFlowSource(path).fetchMarkets({
        ...WIDE_CRITERIA,
        limit: 3,
      });
      assert.equal(markets.length, 3);
    });
  });
});

// --------------------------------------------------------------------------
// JsonlForesightFlowSource — validation errors
// --------------------------------------------------------------------------

describe('JsonlForesightFlowSource — schema validation', () => {
  it('throws ForesightFlowError on invalid JSON', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(path, 'not json\n');
      await assert.rejects(
        () => new JsonlForesightFlowSource(path).fetchMarkets(WIDE_CRITERIA),
        ForesightFlowError,
      );
    });
  });

  it('throws ForesightFlowError with field name when schema fails', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      // baselineMidPrice out of [0, 1]
      await writeFile(path, JSON.stringify(makeRow({ baselineMidPrice: 1.5 })) + '\n');
      await assert.rejects(
        async () => {
          const source = new JsonlForesightFlowSource(path);
          await source.fetchMarkets(WIDE_CRITERIA);
        },
        (err: unknown) => {
          assert.ok(err instanceof ForesightFlowError);
          assert.match(err.message, /baselineMidPrice/);
          return true;
        },
      );
    });
  });

  it('throws ForesightFlowError for unknown category', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(path, JSON.stringify(makeRow({ category: 'memes' })) + '\n');
      await assert.rejects(
        () => new JsonlForesightFlowSource(path).fetchMarkets(WIDE_CRITERIA),
        ForesightFlowError,
      );
    });
  });

  it('throws ForesightFlowError for invalid outcome value', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(path, JSON.stringify(makeRow({ resolutionOutcome: 2 })) + '\n');
      await assert.rejects(
        () => new JsonlForesightFlowSource(path).fetchMarkets(WIDE_CRITERIA),
        ForesightFlowError,
      );
    });
  });
});

// --------------------------------------------------------------------------
// loadFixtureWithOutcomes
// --------------------------------------------------------------------------

describe('loadFixtureWithOutcomes', () => {
  it('returns outcome and volumeUsd alongside market', async () => {
    await withTmpDir(async dir => {
      const path = join(dir, 'markets.jsonl');
      await writeFile(
        path,
        JSON.stringify(makeRow({ resolutionOutcome: 0, volumeUsdc: 75_000 })) + '\n',
      );
      const items = await loadFixtureWithOutcomes(path, WIDE_CRITERIA);
      assert.equal(items.length, 1);
      assert.equal(items[0].outcome, 0);
      assert.equal(items[0].volumeUsd, 75_000);
      assert.ok(items[0].market.question.length > 0);
    });
  });
});

// --------------------------------------------------------------------------
// ApiForesightFlowSource
// --------------------------------------------------------------------------

describe('ApiForesightFlowSource', () => {
  it('throws ConfigError when baseUrl is not set', () => {
    const source = new ApiForesightFlowSource();
    assert.throws(() => source.fetchMarkets(WIDE_CRITERIA), ConfigError);
  });

  it('throws ConfigError even when baseUrl is set (not implemented)', () => {
    const source = new ApiForesightFlowSource({ baseUrl: 'https://api.foresightflow.io' });
    assert.throws(() => source.fetchMarkets(WIDE_CRITERIA), ConfigError);
  });
});
