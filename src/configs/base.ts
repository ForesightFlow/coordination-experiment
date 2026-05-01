/**
 * Shared utilities for coordination configurations.
 *
 * `TraceLedger` is the per-market accumulator that every config writes to.
 * It centralizes token accounting, cost rollup, and call recording so that
 * each config focuses solely on its orchestration logic.
 */

import type {
  CallRecord,
  GenerateRequest,
  GenerateResponse,
  LLMClient,
  ReasoningTrace,
  ToolDefinition,
} from '../types.js';
import { TOOL_DEFINITIONS } from '../tools.js';

export class TraceLedger {
  private calls: CallRecord[] = [];
  private nextCallIndex = 0;
  private totalTokens = 0;
  private totalCostUsd = 0;
  private totalDurationMs = 0;

  constructor(public readonly configName: string) {}

  /**
   * Issue a request through the LLM client and record the call.
   * `internalRound` is an optional protocol-level round index used for
   * debate / consensus configs.
   */
  async call(
    llm: LLMClient,
    agentRole: string,
    systemPrompt: string,
    userPrompt: string,
    options: {
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature: number;
      internalRound?: number;
    },
  ): Promise<GenerateResponse> {
    const callIndex = this.nextCallIndex++;
    const req: GenerateRequest = {
      systemPrompt,
      userPrompt,
      tools: options.tools ?? TOOL_DEFINITIONS,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      metadata: { agentRole, configName: this.configName },
    };

    const response = await llm.generate(req);

    const record: CallRecord = {
      agentRole,
      callIndex,
      request: { systemPrompt, userPrompt },
      response: { text: response.text, toolCalls: response.toolCalls },
      usage: response.usage,
      costUsd: response.costUsd,
      durationMs: response.durationMs,
      internalRound: options.internalRound,
    };
    this.calls.push(record);

    this.totalTokens += response.usage.totalTokens;
    if (typeof response.costUsd === 'number') this.totalCostUsd += response.costUsd;
    this.totalDurationMs += response.durationMs;

    return response;
  }

  build(): ReasoningTrace {
    return {
      configName: this.configName,
      calls: this.calls.slice(),
      totalTokens: this.totalTokens,
      totalCostUsd: this.totalCostUsd,
      totalDurationMs: this.totalDurationMs,
    };
  }

  get tokensSoFar(): number {
    return this.totalTokens;
  }
}

/**
 * Aggregate a vector of probabilities into a single probability.
 * Default is the median, which is robust to a single outlier among 3+ agents
 * and matches "wisdom of crowds" practice for binary forecasts.
 */
export function aggregate(
  probabilities: number[],
  method: 'mean' | 'median' = 'median',
): number {
  if (probabilities.length === 0) {
    throw new Error('aggregate(): empty input');
  }
  if (method === 'mean') {
    return probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  }
  const sorted = probabilities.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Maximum absolute pairwise spread; used as the consensus convergence proxy. */
export function spread(probabilities: number[]): number {
  if (probabilities.length === 0) return 0;
  return Math.max(...probabilities) - Math.min(...probabilities);
}
