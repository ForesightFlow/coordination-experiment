/**
 * Phase 0 validation runner.
 *
 * Runs all five coordination configurations against 10 real historical markets
 * from the ForesightFlow JSONL fixture, using the Anthropic API directly with
 * web search disabled (no leakage). Results are written to results-validation.json
 * and scored with the Murphy decomposition.
 *
 * This is shakedown, NOT paper data. The purpose is to catch prompt failures,
 * parsing edge cases, and API quirks before Phase 1A.
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY  — required
 *   MODEL_TRAINING_CUTOFF — ISO date (default: 2025-08-01); all loaded
 *                            markets must have resolvedAt after this date
 *
 * Cost estimate: ~$2–5 depending on agent verbosity and tool call depth.
 *
 * Usage:
 *   npm run build
 *   ANTHROPIC_API_KEY=<key> node dist/examples/run-validation.js
 */

import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { AnthropicClient } from '../src/clients/anthropic-client.js';
import {
  allConfigurations,
  ConfigurableAgentTools,
  loadFixtureWithOutcomes,
  PolymarketAgentTools,
  runRound,
  type CoordinationConfigParams,
  type Market,
  type MarketSet,
  type RoundResult,
} from '../src/index.js';

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const FIXTURE_PATH = 'data/fixture_phase0.jsonl';
const OUTPUT_PATH = 'results-validation.json';
const MARKET_COUNT = 10;

// Rates as of 2026-04-27 for claude-opus-4-6 — verify before each run.
const INPUT_USD_PER_MILLION = 5;
const OUTPUT_USD_PER_MILLION = 25;

const PARAMS: CoordinationConfigParams = {
  agentCount: 3,
  maxInternalRounds: 2,
  convergenceTolerance: 0.05,
  maxTokensPerMarket: 4000,
  maxTokensPerCall: 1000,
  temperature: 0.3,
};

const ALL_CATEGORIES = [
  'crypto',
  'politics',
  'sports',
  'economics',
  'geopolitics',
  'entertainment',
] as const;

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

async function main() {
  // ---- Guard: API key ----
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }

  const MODEL_TRAINING_CUTOFF = new Date(
    process.env.MODEL_TRAINING_CUTOFF ?? '2025-08-01T00:00:00Z',
  );
  console.log(`Model training cutoff: ${MODEL_TRAINING_CUTOFF.toISOString()}`);
  console.log(`Loading up to ${MARKET_COUNT} markets from ${FIXTURE_PATH}...`);

  // ---- Load markets ----
  const items = await loadFixtureWithOutcomes(FIXTURE_PATH, {
    resolvedAfter: MODEL_TRAINING_CUTOFF,
    resolvedBefore: new Date(),
    categories: ALL_CATEGORIES,
    minVolumeUsd: 0,
    limit: MARKET_COUNT,
  });

  if (items.length === 0) {
    console.error(
      `Error: no markets found in ${FIXTURE_PATH} after MODEL_TRAINING_CUTOFF (${MODEL_TRAINING_CUTOFF.toISOString()}).`,
    );
    process.exit(1);
  }

  // ---- Assert post-cutoff ----
  for (const { market } of items) {
    const resolvedAt = new Date(market.resolutionDate!);
    if (resolvedAt <= MODEL_TRAINING_CUTOFF) {
      console.error(
        `Error: market "${market.question}" resolved at ${resolvedAt.toISOString()} which is NOT after MODEL_TRAINING_CUTOFF (${MODEL_TRAINING_CUTOFF.toISOString()}).`,
      );
      process.exit(1);
    }
  }

  const markets: Market[] = items.map(it => it.market);
  // Build lookup for outcomes and categories keyed by market index.
  const outcomeByIndex = new Map(items.map(it => [it.market.index, it.outcome]));
  const volumeByIndex = new Map(items.map(it => [it.market.index, it.volumeUsd]));

  console.log(`Loaded ${markets.length} markets (all post-cutoff). Questions:`);
  for (const m of markets) {
    console.log(`  [${m.index}] ${m.question}`);
  }
  console.log('');

  // ---- Build tools ----
  // PolymarketAgentTools hits real Gamma + CLOB APIs for market data.
  // Wrapped in ConfigurableAgentTools with web search OFF (no leakage).
  const polymarketTools = new PolymarketAgentTools(markets);
  const configurableTools = new ConfigurableAgentTools(polymarketTools, false);

  // ---- Build LLM client ----
  // configurableTools is the executor so searchWeb returns [] when the model calls it.
  const llm = new AnthropicClient({
    modelId: 'claude-opus-4-6',
    inputUsdPerMillion: INPUT_USD_PER_MILLION,
    outputUsdPerMillion: OUTPUT_USD_PER_MILLION,
    tools: configurableTools,
  });

  // ---- Run all 5 configs ----
  const marketSet: MarketSet = { roundIndex: 0, markets };
  console.log('Running all 5 configurations (concurrency=2 to respect rate limits)...');
  const startedAt = Date.now();

  const results: RoundResult[] = await runRound(marketSet, {
    configurations: allConfigurations(),
    llm,
    tools: configurableTools,
    params: PARAMS,
    modelId: 'claude-opus-4-6',
    concurrency: 2,
    onProgress: info => {
      const pct = Math.round(
        (info.marketsCompletedInRound / info.marketsTotalInRound) * 100,
      );
      const tokens = info.marketsCompletedInRound; // proxy for progress
      void tokens;
      console.log(
        `  [${info.configName}] market ${info.marketIndex} (${info.marketsCompletedInRound}/${info.marketsTotalInRound}, ${pct}%)`,
      );
    },
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nAll configs finished in ${elapsed}s.`);

  // ---- Check for failures ----
  let totalFailures = 0;
  for (const round of results) {
    const failures = round.markets.filter(m => '_failure' in m);
    if (failures.length === round.markets.length) {
      console.error(
        `ERROR: config "${round.configName}" had ZERO successful predictions — all ${failures.length} markets failed.`,
      );
    }
    totalFailures += failures.length;
  }
  if (totalFailures > 0) {
    console.warn(`\nWarning: ${totalFailures} prediction failure(s) across all configs (replaced with 0.5 fallback).`);
  }

  // ---- Annotate results with outcomes and categories ----
  // murphy.py reads outcome, baseline, and category from each market entry.
  const annotated = results.map(round => ({
    ...round,
    markets: round.markets.map(m => ({
      ...m,
      outcome: outcomeByIndex.get(m.marketIndex) ?? null,
      volumeUsd: volumeByIndex.get(m.marketIndex) ?? null,
    })),
  }));

  // ---- Write results ----
  await writeFile(OUTPUT_PATH, JSON.stringify(annotated, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);

  // ---- Cost summary ----
  const totalCost = results.reduce(
    (sum, r) => sum + r.markets.reduce((s, m) => s + (m.trace.totalCostUsd ?? 0), 0),
    0,
  );
  const totalTokens = results.reduce(
    (sum, r) => sum + r.markets.reduce((s, m) => s + m.trace.totalTokens, 0),
    0,
  );
  console.log(`Total tokens: ${totalTokens}`);
  console.log(`Total cost:   $${totalCost.toFixed(3)}`);

  if (totalCost > 5) {
    console.warn(`Warning: cost $${totalCost.toFixed(2)} exceeded $5 Phase 0 budget.`);
  }

  // ---- Run Murphy decomposition ----
  console.log('\n--- Murphy decomposition leaderboard ---');
  try {
    const murphyOutput = execSync(
      `python3 analysis/murphy.py ${OUTPUT_PATH} --table /dev/stderr`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(murphyOutput);
  } catch (err) {
    console.warn(
      'murphy.py failed (analysis dependencies may not be installed). ' +
        'Run: pip install -r analysis/requirements.txt',
    );
    if (err instanceof Error && 'stderr' in err) {
      console.warn(String((err as NodeJS.ErrnoException & { stderr: string }).stderr));
    }
  }

  // Fail hard if any config had all predictions fail.
  if (results.some(r => r.markets.every(m => '_failure' in m))) {
    console.error('Fatal: at least one config had zero successful predictions. See above.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
