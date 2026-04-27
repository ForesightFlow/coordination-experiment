/**
 * Experiment runner.
 *
 * Drives a set of coordination configurations across rounds of binary
 * markets. For each (config, market) pair, calls the config's `predict`
 * method and records the result, including the full reasoning trace.
 *
 * Output: an array of `RoundResult`, JSON-serializable, consumed by the
 * Python analysis pipeline (analysis/murphy.py).
 */

import type {
  AgentTools,
  CoordinationConfig,
  CoordinationConfigParams,
  LLMClient,
  Market,
  MarketResult,
  MarketSet,
  RoundResult,
} from './types.js';

export interface RunnerOptions {
  /** All coordination configurations to evaluate (in pre-registered order). */
  configurations: CoordinationConfig[];
  /** Single LLM model used across all configurations (Principle 1). */
  llm: LLMClient;
  /** Single tools instance shared across all configurations. */
  tools: AgentTools;
  /** Configuration-uniform parameters; same across configs by Principle 1. */
  params: CoordinationConfigParams;
  /** Identifier for the underlying model (recorded in results). */
  modelId: string;
  /** Optional per-market progress callback. */
  onProgress?: (info: ProgressInfo) => void;
  /** Maximum concurrent (config, market) pairs in flight. Default 4. */
  concurrency?: number;
  /**
   * Keys "configName::marketIndex" already completed in a prior run.
   * Matching predictions are skipped; their results are read from resumedResults.
   */
  skipPredictions?: Set<string>;
  /** Pre-loaded MarketResult for each skipped prediction. Required when skipPredictions is non-empty. */
  resumedResults?: Map<string, MarketResult>;
  /** Called after each NEWLY computed prediction (not called for resumed/skipped ones). */
  onMarketComplete?: (configName: string, result: MarketResult) => void;
}

export interface ProgressInfo {
  configName: string;
  roundIndex: number;
  marketIndex: number;
  marketsCompletedInRound: number;
  marketsTotalInRound: number;
}

/**
 * Run a single round across all configurations.
 *
 * Markets and configurations are processed with bounded concurrency. For each
 * (config, market) the runner invokes config.predict and aggregates results.
 */
export async function runRound(
  marketSet: MarketSet,
  options: RunnerOptions,
): Promise<RoundResult[]> {
  const {
    configurations, llm, tools, params, modelId, onProgress,
    skipPredictions, resumedResults, onMarketComplete,
  } = options;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  // For each configuration, run all markets with bounded concurrency.
  return Promise.all(
    configurations.map(async config => {
      const completed: MarketResult[] = [];
      let progressCount = 0;

      // Simple bounded-parallel queue.
      const queue = [...marketSet.markets];
      async function worker(): Promise<void> {
        while (queue.length > 0) {
          const market = queue.shift();
          if (!market) return;
          const key = `${config.name}::${market.index}`;
          let result: MarketResult;
          if (skipPredictions?.has(key)) {
            // Resume from prior run — result was already persisted; don't re-invoke LLM.
            result = resumedResults!.get(key)!;
          } else {
            result = await predictOne(config, market, llm, tools, params);
            onMarketComplete?.(config.name, result);
          }
          completed.push(result);
          progressCount += 1;
          onProgress?.({
            configName: config.name,
            roundIndex: marketSet.roundIndex,
            marketIndex: market.index,
            marketsCompletedInRound: progressCount,
            marketsTotalInRound: marketSet.markets.length,
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, marketSet.markets.length) }, worker),
      );

      // Sort to restore the input order so downstream analysis is deterministic.
      completed.sort((a, b) => a.marketIndex - b.marketIndex);

      return {
        roundIndex: marketSet.roundIndex,
        configName: config.name,
        modelId,
        executedAt: new Date().toISOString(),
        markets: completed,
      };
    }),
  );
}

async function predictOne(
  config: CoordinationConfig,
  market: Market,
  llm: LLMClient,
  tools: AgentTools,
  params: CoordinationConfigParams,
): Promise<MarketResult> {
  try {
    const { probability, trace } = await config.predict({
      market,
      llm,
      tools,
      params,
    });
    return {
      marketIndex: market.index,
      question: market.question,
      probability,
      baseline: market.midPrice,
      trace,
    };
  } catch (err) {
    // Failure handling (paper §3.2, element vii): record the failure as a
    // 0.5 fallback probability with a marker in the trace. Excluding from
    // scoring is the analyst's choice; we always record the attempt.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      marketIndex: market.index,
      question: market.question,
      probability: 0.5,
      baseline: market.midPrice,
      trace: {
        configName: config.name,
        calls: [],
        totalTokens: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
      },
      // @ts-expect-error: extension field for diagnostic; analysts opt to filter
      _failure: reason,
    };
  }
}

/**
 * Convenience: run multiple rounds sequentially. Each round writes one
 * `RoundResult[]` (one per configuration). Results are accumulated; caller
 * is responsible for serializing to disk.
 */
export async function runRounds(
  marketSets: MarketSet[],
  options: RunnerOptions,
): Promise<RoundResult[]> {
  const allResults: RoundResult[] = [];
  for (const marketSet of marketSets) {
    const roundResults = await runRound(marketSet, options);
    allResults.push(...roundResults);
  }
  return allResults;
}
