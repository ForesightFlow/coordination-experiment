/**
 * ForesightFlow market source.
 *
 * ForesightFlow maintains a DB of ~911K Polymarket markets (865K resolved)
 * with price history. We query it — we do NOT re-parse raw Polymarket data.
 *
 * Two implementations:
 *   JsonlForesightFlowSource  — loads from a local JSONL fixture (Phase 0 / tests)
 *   ApiForesightFlowSource    — stubs until the user provides endpoint config
 *
 * TODO(claude-code): The actual fixture field names differ from the CLAUDE.md
 * spec. The fixture uses: marketId, resolutionOutcome, volumeUsdc, and has no
 * description field. The Zod schema below is aligned to the REAL fixture.
 * If ForesightFlow's API uses the spec names (conditionId, outcome, volumeUsd),
 * adjust ApiForesightFlowSource's schema when wiring up the real endpoint.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Market } from '../types.js';

// --------------------------------------------------------------------------
// Error types
// --------------------------------------------------------------------------

export class ForesightFlowError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ForesightFlowError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// --------------------------------------------------------------------------
// JSONL row schema (Zod) — aligned to actual fixture field names
// --------------------------------------------------------------------------

const CATEGORIES = [
  'crypto',
  'politics',
  'sports',
  'economics',
  'geopolitics',
  'entertainment',
] as const;

/**
 * Schema for one JSONL row as it appears in the fixture (and expected from
 * the ForesightFlow DB export). Field mapping to Market:
 *   marketId          → conditionId
 *   resolutionOutcome → outcome
 *   volumeUsdc        → volumeUsd
 *   description       → optional (absent in current fixture, defaults to "")
 */
const ForesightFlowRowSchema = z.object({
  marketId: z.string().min(1),
  question: z.string().min(1),
  description: z.string().optional().default(''),
  category: z.enum(CATEGORIES),
  resolvedAt: z.string().datetime({ offset: true }),
  resolutionOutcome: z.union([z.literal(0), z.literal(1)]),
  baselineMidPrice: z.number().min(0).max(1),
  volumeUsdc: z.number().nonnegative(),
  ilsScore: z.number().nullable().optional(),
});

export type ForesightFlowRow = z.infer<typeof ForesightFlowRowSchema>;

// --------------------------------------------------------------------------
// Fetch criteria
// --------------------------------------------------------------------------

export interface FetchCriteria {
  resolvedAfter: Date;
  resolvedBefore: Date;
  categories: ReadonlyArray<(typeof CATEGORIES)[number]>;
  minVolumeUsd: number;
  limit: number;
}

// --------------------------------------------------------------------------
// Interface
// --------------------------------------------------------------------------

export interface ForesightFlowSource {
  fetchMarkets(criteria: FetchCriteria): Promise<Market[]>;
}

// --------------------------------------------------------------------------
// Module-level JSONL loader (used by both class and helper below)
// --------------------------------------------------------------------------

export async function loadJsonlRows(path: string): Promise<ForesightFlowRow[]> {
  const rows: ForesightFlowRow[] = [];
  let lineIndex = 0;

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      throw new ForesightFlowError(`Invalid JSON at line ${lineIndex + 1} of ${path}`, err);
    }

    const result = ForesightFlowRowSchema.safeParse(raw);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new ForesightFlowError(
        `Schema validation failed at row ${lineIndex} of ${path}: ` +
          `field "${first.path.join('.')}" — ${first.message}`,
        result.error,
      );
    }

    rows.push(result.data);
    lineIndex++;
  }

  return rows;
}

function applyFilter(rows: ForesightFlowRow[], criteria: FetchCriteria): ForesightFlowRow[] {
  return rows
    .filter(row => {
      const resolvedAt = new Date(row.resolvedAt);
      if (resolvedAt <= criteria.resolvedAfter) return false;
      if (resolvedAt >= criteria.resolvedBefore) return false;
      if (!criteria.categories.includes(row.category)) return false;
      if (row.volumeUsdc < criteria.minVolumeUsd) return false;
      return true;
    })
    .slice(0, criteria.limit);
}

function rowToMarket(row: ForesightFlowRow, index: number): Market {
  return {
    index,
    question: row.question,
    description: row.description,
    conditionId: row.marketId,
    resolutionDate: row.resolvedAt,
    midPrice: row.baselineMidPrice,
  };
}

// --------------------------------------------------------------------------
// JSONL loader (Phase 0 fixture)
// --------------------------------------------------------------------------

export class JsonlForesightFlowSource implements ForesightFlowSource {
  constructor(private readonly path: string) {}

  async fetchMarkets(criteria: FetchCriteria): Promise<Market[]> {
    const rows = await loadJsonlRows(this.path);
    return applyFilter(rows, criteria).map((row, i) => rowToMarket(row, i));
  }
}

// --------------------------------------------------------------------------
// API source (stub — wired up when ForesightFlow API endpoint is provided)
// --------------------------------------------------------------------------

export interface ApiForesightFlowConfig {
  /** HTTP(S) base URL of the ForesightFlow REST API. */
  baseUrl?: string;
  /** Bearer token or API key (if required). */
  apiKey?: string;
}

export class ApiForesightFlowSource implements ForesightFlowSource {
  constructor(private readonly config: ApiForesightFlowConfig = {}) {}

  fetchMarkets(_criteria: FetchCriteria): Promise<Market[]> {
    if (!this.config.baseUrl) {
      throw new ConfigError(
        'ForesightFlow API endpoint not configured. ' +
          'Pass baseUrl in ApiForesightFlowConfig or use JsonlForesightFlowSource for Phase 0.',
      );
    }
    // TODO(claude-code): implement real HTTP query once the user supplies the
    // ForesightFlow REST API spec and credentials. Expected shape: API accepts
    // FetchCriteria fields as query params and returns JSON rows matching
    // ForesightFlowRowSchema (verify field names against real API first).
    throw new ConfigError(
      'ApiForesightFlowSource.fetchMarkets: HTTP implementation not yet wired up.',
    );
  }
}

// --------------------------------------------------------------------------
// Helper: load JSONL retaining raw outcome + volume for the Phase 0 runner
// --------------------------------------------------------------------------

/**
 * Like fetchMarkets but also returns the raw outcome and volumeUsd per row,
 * which the runner needs to populate MarketResult.outcome after resolution.
 */
export async function loadFixtureWithOutcomes(
  path: string,
  criteria: FetchCriteria,
): Promise<Array<{ market: Market; outcome: 0 | 1; volumeUsd: number }>> {
  const rows = await loadJsonlRows(path);
  return applyFilter(rows, criteria).map((row, i) => ({
    market: rowToMarket(row, i),
    outcome: row.resolutionOutcome,
    volumeUsd: row.volumeUsdc,
  }));
}
