/**
 * Validation runner — Phase 0 / Phase 0.5.
 *
 * All tuneable values are read from environment variables so a single script
 * serves both Phase 0 (10 markets) and Phase 0.5 (100 markets) via different
 * npm scripts.
 *
 * Environment variables (all optional except ANTHROPIC_API_KEY):
 *   ANTHROPIC_API_KEY      — required; also loaded from .env automatically
 *   MODEL_TRAINING_CUTOFF  — ISO date, default 2025-08-01; markets resolved
 *                            before this date are excluded
 *   VALIDATION_FIXTURE     — path to JSONL fixture, default data/fixture_phase0.jsonl
 *   VALIDATION_OUTPUT      — path for results JSON, default results-validation.json
 *   VALIDATION_LIMIT       — max markets to load; 0 or unset = load all
 *   VALIDATION_BUDGET      — cost alarm threshold in USD; exit if crossed mid-run
 *
 * Usage:
 *   npm run build
 *   node dist/examples/run-validation.js
 *   # or via npm scripts: npm run validate / npm run validate-05
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

// Load .env from working directory before anything reads process.env.
// Only sets variables that are not already present in the environment.
(function loadDotEnv() {
  try {
    const lines = readFileSync('.env', 'utf-8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const eq = t.indexOf('=');
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env — fine */ }
})();
import { AnthropicClient } from '../src/clients/anthropic-client.js';
import {
  allConfigurations,
  ConfigurableAgentTools,
  loadFixtureWithOutcomes,
  PolymarketAgentTools,
  runRound,
  type CoordinationConfigParams,
  type Market,
  type MarketResult,
  type MarketSet,
  type RoundResult,
} from '../src/index.js';

// --------------------------------------------------------------------------
// Configuration (env-var overridable)
// --------------------------------------------------------------------------

const FIXTURE_PATH = process.env.VALIDATION_FIXTURE ?? 'data/fixture_phase0.jsonl';
const OUTPUT_PATH = process.env.VALIDATION_OUTPUT ?? 'results-validation.json';
// JSONL mirror of OUTPUT_PATH: one MarketResult+configName per line; written
// incrementally so a crash/alarm mid-run preserves completed predictions.
const JSONL_PATH = OUTPUT_PATH.replace(/\.json$/, '.jsonl');
// 0 or unset → load all; any positive integer → cap at that number.
const MARKET_LIMIT = (() => {
  const v = parseInt(process.env.VALIDATION_LIMIT ?? '0', 10);
  return v > 0 ? v : 100_000;
})();
// Cost alarm: exit if cumulative spend crosses this threshold mid-run.
// Default raised to $150 to cover Phase 0.5 (100 markets × 5 configs ≈ $112).
const BUDGET_ALARM_USD = parseFloat(process.env.VALIDATION_BUDGET ?? '150');
// Early-stop: abort when architectural signal is statistically resolved.
// Set EARLY_STOP=true to enable; off by default so legacy behaviour is preserved.
const EARLY_STOP = process.env.EARLY_STOP === 'true';

// Rates as of 2026-04-27 for claude-opus-4-6 — verify before each run.
const INPUT_USD_PER_MILLION = 5;
const OUTPUT_USD_PER_MILLION = 25;

// agentCount=1 for Phase 0/0.5 shakedown: single sequential agent per config
// so max simultaneous API calls = 5 (one per config), which sits within the
// 30K-token/min rate limit. Phase 1A will use agentCount=3 with a proper
// token-bucket rate limiter.
const PARAMS: CoordinationConfigParams = {
  agentCount: 1,
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
  console.log(`Fixture:              ${FIXTURE_PATH}`);
  console.log(`Output (JSON):        ${OUTPUT_PATH}`);
  console.log(`Output (JSONL):       ${JSONL_PATH}`);
  console.log(`Market limit:         ${MARKET_LIMIT >= 100_000 ? 'all' : MARKET_LIMIT}`);
  console.log(`Budget alarm:         $${BUDGET_ALARM_USD}`);
  console.log(`Early stop:           ${EARLY_STOP}`);
  console.log(`Model training cutoff: ${MODEL_TRAINING_CUTOFF.toISOString()}`);
  console.log('');

  // ---- Load markets ----
  const items = await loadFixtureWithOutcomes(FIXTURE_PATH, {
    resolvedAfter: MODEL_TRAINING_CUTOFF,
    resolvedBefore: new Date(),
    categories: ALL_CATEGORIES,
    minVolumeUsd: 0,
    limit: MARKET_LIMIT,
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

  console.log(`Loaded ${markets.length} markets (all post-cutoff).`);
  for (const m of markets) {
    console.log(`  [${m.index}] ${m.question}`);
  }
  console.log('');

  // ---- Bug 1: Resume from JSONL ----
  // Each line: MarketResult + configName. Populated incrementally during the run.
  type PersistedPrediction = MarketResult & { configName: string };
  const skipSet = new Set<string>();
  const resumedMap = new Map<string, MarketResult>();
  const configurations = allConfigurations();

  // Bug 3: Per-config completion maps for early-stop Brier computation.
  let globalCompletedCount = 0;
  const completedByConfig = new Map<string, Map<number, MarketResult>>();
  for (const cfg of configurations) completedByConfig.set(cfg.name, new Map());

  if (existsSync(JSONL_PATH)) {
    const rawLines = readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of rawLines) {
      try {
        const rec = JSON.parse(line) as PersistedPrediction;
        const key = `${rec.configName}::${rec.marketIndex}`;
        const { configName: _cn, ...rest } = rec;
        skipSet.add(key);
        resumedMap.set(key, rest as MarketResult);
        completedByConfig.get(rec.configName)?.set(rec.marketIndex, rest as MarketResult);
        globalCompletedCount++;
      } catch { /* skip malformed lines */ }
    }
  }
  const totalExpected = markets.length * configurations.length;
  const freshCount = totalExpected - skipSet.size;
  console.log(`Predictions: ${skipSet.size} resumed from JSONL, ${freshCount} scheduled fresh (${totalExpected} total).`);
  console.log('');

  // ---- Bug 3: Early-stop checker ----
  // Runs every 10 completions when EARLY_STOP=true.
  // Criterion (4-SE rule, §3 spec): if gap between worst and best per-config Brier
  // exceeds 4 × max(SE_best, SE_worst) AND n ≥ 50 common scored markets, the
  // architectural signal is resolved at roughly p < 0.001 and further markets add
  // cost without narrowing the conclusion.
  function checkEarlyStop(): void {
    const configNames = configurations.map(c => c.name);
    const allSets = configNames.map(n => new Set(completedByConfig.get(n)!.keys()));
    // Markets scored by every config AND with known ground-truth outcome.
    const commonIndices = [...allSets[0]].filter(i => allSets.every(s => s.has(i)));
    const scoreable = commonIndices.filter(i => outcomeByIndex.has(i));
    const n = scoreable.length;

    if (n < 25) {
      console.log(`  [early-stop] n=${n} common scored markets (need 25, skipping check)`);
      return;
    }

    const stats = configNames.map(name => {
      const configMap = completedByConfig.get(name)!;
      const errs = scoreable.map(i => {
        const res = configMap.get(i)!;
        const outcome = outcomeByIndex.get(i)!;
        const p = ('_failure' in res) ? 0.5 : res.probability;
        return (p - outcome) ** 2;
      });
      const brier = errs.reduce((a, b) => a + b, 0) / n;
      // SE of the Brier estimator: stddev(squared-errors) / sqrt(n).
      const variance = errs.reduce((a, b) => a + (b - brier) ** 2, 0) / n;
      const se = Math.sqrt(variance / n);
      return { name, brier, se };
    });

    stats.sort((a, b) => a.brier - b.brier);
    const best = stats[0];
    const worst = stats[stats.length - 1];
    const gap = worst.brier - best.brier;
    const threshold = 4 * Math.max(best.se, worst.se);
    const msg =
      `[early-stop] n=${n}: best=${best.name} Brier=${best.brier.toFixed(4)},` +
      ` worst=${worst.name} Brier=${worst.brier.toFixed(4)},` +
      ` gap=${gap.toFixed(4)}, threshold=${threshold.toFixed(4)}`;

    if (gap > threshold && n >= 50) {
      console.log(`\nArchitectural signal resolved at n=${n} — early stop triggered.`);
      console.log(msg);
      process.exit(0);
    }
    console.log(`  ${msg} (signal not yet resolved, continuing)`);
  }

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

  // ---- Bug 1: onMarketComplete — incremental JSONL persistence ----
  const startedAt = Date.now();

  const onMarketComplete = (configName: string, result: MarketResult): void => {
    appendFileSync(JSONL_PATH, JSON.stringify({ ...result, configName }) + '\n', 'utf-8');
    completedByConfig.get(configName)?.set(result.marketIndex, result);
    globalCompletedCount++;

    // Bug 2: print cost checkpoint every 10 completions.
    if (globalCompletedCount % 10 === 0) {
      const cost = llm.getCumulativeCostUsd();
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log(
        `  [checkpoint] ${globalCompletedCount} predictions done` +
          ` | $${cost.toFixed(2)} | ${elapsedMin}min`,
      );
    }

    // Bug 3: early-stop check every 10 completions.
    if (EARLY_STOP && globalCompletedCount % 10 === 0) {
      checkEarlyStop();
    }
  };

  // ---- Run all 5 configs ----
  const marketSet: MarketSet = { roundIndex: 0, markets };
  console.log(`Running all 5 configurations across ${markets.length} markets (concurrency=1)...`);

  const results: RoundResult[] = await runRound(marketSet, {
    configurations,
    llm,
    tools: configurableTools,
    params: PARAMS,
    modelId: 'claude-opus-4-6',
    concurrency: 1,
    skipPredictions: skipSet,
    resumedResults: resumedMap,
    onMarketComplete,
    onProgress: info => {
      const pct = Math.round(
        (info.marketsCompletedInRound / info.marketsTotalInRound) * 100,
      );
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const cumulativeCost = llm.getCumulativeCostUsd();
      console.log(
        `  [${info.configName}] market ${info.marketIndex}` +
          ` (${info.marketsCompletedInRound}/${info.marketsTotalInRound}, ${pct}%)` +
          ` | $${cumulativeCost.toFixed(2)} | ${elapsedMin}min`,
      );
      // Mid-run budget alarm: JSONL persistence means completed work is already on disk.
      if (cumulativeCost > BUDGET_ALARM_USD) {
        console.error(
          `\nBUDGET ALARM: cumulative cost $${cumulativeCost.toFixed(2)} crossed` +
            ` $${BUDGET_ALARM_USD} threshold. Stopping run.`,
        );
        process.exit(2);
      }
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

  if (totalCost > BUDGET_ALARM_USD) {
    console.warn(`Warning: cost $${totalCost.toFixed(2)} exceeded $${BUDGET_ALARM_USD} budget.`);
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
