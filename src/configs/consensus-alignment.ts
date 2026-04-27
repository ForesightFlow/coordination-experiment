/**
 * Consensus Alignment configuration.
 *
 * Round 0: each of N agents produces an independent forecast.
 * Rounds 1..R: each agent observes all peers' previous-round estimates and
 *              updates toward agreement. Termination: spread (max - min) of
 *              estimates falls below `convergenceTolerance`, OR maximum
 *              round budget is exhausted.
 * Final: mean over the final-round estimates.
 *
 * Predicted Murphy signature (paper §3.5, Prediction 5):
 *   - very low REL relative to the convergence point
 *   - very low RES (forced agreement collapses discriminative variance)
 * Failure mode: market-tracking collapse — the convergence point anchors on
 * the most salient initial signal (often the market mid-price, or the most
 * confident initial proposal). Reproduces the negative-Alpha signature
 * observed in the Foresight Arena evaluation for grok-4-1 and glm-4-7
 * INDEPENDENT OF THE UNDERLYING MODEL.
 */

import type { CoordinationConfig, PredictArgs, PredictResult } from '../types.js';
import { aggregate, spread, TraceLedger } from './base.js';
import {
  buildSystemPrompt,
  buildForecasterUserPrompt,
  buildConsensusUserPrompt,
} from '../prompts.js';
import { extractReasoning, parseFinalProbability } from '../parsing.js';

interface AgentState {
  agentId: string;
  probability: number;
  reasoning: string;
}

export class ConsensusAlignment implements CoordinationConfig {
  readonly name = 'consensus_alignment';

  async predict(args: PredictArgs): Promise<PredictResult> {
    const { market, llm, params } = args;
    const ledger = new TraceLedger(this.name);

    const N = params.agentCount;
    const Rmax = params.maxInternalRounds ?? 3;
    const epsilon = params.convergenceTolerance ?? 0.05;

    // Worst-case calls: N initial + N × Rmax revisions = N × (Rmax + 1).
    const perCallBudget = Math.floor(
      params.maxTokensPerMarket / (N * (Rmax + 1)),
    );

    // Round 0: independent initial forecasts.
    const initialSystem = buildSystemPrompt('forecaster');
    const initialUser = buildForecasterUserPrompt(market);
    const initialResponses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ledger.call(llm, `consensus_${i + 1}`, initialSystem, initialUser, {
          maxTokens: perCallBudget,
          temperature: params.temperature,
          internalRound: 0,
        }),
      ),
    );
    let states: AgentState[] = initialResponses.map((r, i) => ({
      agentId: `${i + 1}`,
      probability: parseFinalProbability(r.text),
      reasoning: extractReasoning(r.text),
    }));

    // Iterate until convergence or budget exhaustion.
    const reviseSystem = buildSystemPrompt('consensusRevise');
    for (let round = 1; round <= Rmax; round++) {
      const currentSpread = spread(states.map(s => s.probability));
      if (currentSpread <= epsilon) break;

      const revised = await Promise.all(
        states.map((own, i) => {
          const peers = states.filter((_, j) => j !== i);
          const userPrompt = buildConsensusUserPrompt(
            market,
            { probability: own.probability, reasoning: own.reasoning },
            peers,
            round,
          );
          return ledger
            .call(llm, `consensus_${i + 1}`, reviseSystem, userPrompt, {
              maxTokens: perCallBudget,
              temperature: params.temperature,
              internalRound: round,
            })
            .then(r => ({
              agentId: own.agentId,
              probability: parseFinalProbability(r.text),
              reasoning: extractReasoning(r.text),
            }));
        }),
      );
      states = revised;
    }

    // Final: mean (the "speaks with one voice" aggregator).
    const probability = aggregate(states.map(s => s.probability), 'mean');
    return { probability, trace: ledger.build() };
  }
}
