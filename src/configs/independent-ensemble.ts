/**
 * Independent Ensemble configuration.
 *
 * N agents respond independently to the same market using identical prompts,
 * tools, and budget. Outputs are aggregated by median (robust to one outlier).
 *
 * Predicted Murphy signature (paper §3.5, Prediction 1):
 *   - moderate REL  (calibration averages out idiosyncratic bias)
 *   - high RES      (diversity is preserved through to aggregation)
 * Failure mode: correlated agent errors collapse the diversity benefit.
 */

import type { CoordinationConfig, PredictArgs, PredictResult } from '../types.js';
import { aggregate, TraceLedger } from './base.js';
import { buildSystemPrompt, buildForecasterUserPrompt } from '../prompts.js';
import { parseFinalProbability } from '../parsing.js';

export class IndependentEnsemble implements CoordinationConfig {
  readonly name = 'independent_ensemble';

  async predict(args: PredictArgs): Promise<PredictResult> {
    const { market, llm, params } = args;
    const ledger = new TraceLedger(this.name);

    // Per-agent budget: total budget split evenly across N independent calls.
    const perCallBudget = Math.floor(params.maxTokensPerMarket / params.agentCount);
    const systemPrompt = buildSystemPrompt('forecaster');
    const userPrompt = buildForecasterUserPrompt(market);

    // Issue all agent calls in parallel; they are by construction independent.
    const responses = await Promise.all(
      Array.from({ length: params.agentCount }, (_, i) =>
        ledger.call(llm, `forecaster_${i + 1}`, systemPrompt, userPrompt, {
          maxTokens: perCallBudget,
          temperature: params.temperature,
        }),
      ),
    );

    const probabilities = responses.map(r => parseFinalProbability(r.text));
    const probability = aggregate(probabilities, 'median');

    return { probability, trace: ledger.build() };
  }
}
