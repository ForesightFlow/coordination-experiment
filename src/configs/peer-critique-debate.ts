/**
 * Peer-critique Debate configuration.
 *
 * Round 0: each of N agents produces an independent forecast.
 * Rounds 1..R: each agent observes the previous-round estimates of all peers
 *              (and its own previous reasoning) and produces a revised estimate.
 * Final: median over the last round's estimates.
 *
 * Predicted Murphy signature (paper §3.5, Prediction 2):
 *   - REL improves over rounds (mutual cross-correction)
 *   - RES declines over rounds (alignment pressure suppresses dissent)
 * Failure mode: premature convergence on a plausible-but-wrong answer that
 * no agent has the architectural authority to override.
 */

import type { CoordinationConfig, PredictArgs, PredictResult } from '../types.js';
import { aggregate, TraceLedger } from './base.js';
import {
  buildSystemPrompt,
  buildForecasterUserPrompt,
  buildDebateUserPrompt,
} from '../prompts.js';
import { extractReasoning, parseFinalProbability } from '../parsing.js';

interface AgentState {
  agentId: string;
  probability: number;
  reasoning: string;
}

export class PeerCritiqueDebate implements CoordinationConfig {
  readonly name = 'peer_critique_debate';

  async predict(args: PredictArgs): Promise<PredictResult> {
    const { market, llm, params } = args;
    const ledger = new TraceLedger(this.name);

    const N = params.agentCount;
    const R = params.maxInternalRounds ?? 2;

    // Budget allocation: N agents × (R + 1) calls (1 initial + R revision rounds).
    const perCallBudget = Math.floor(params.maxTokensPerMarket / (N * (R + 1)));

    // Round 0: parallel independent forecasts.
    const initialSystem = buildSystemPrompt('forecaster');
    const initialUser = buildForecasterUserPrompt(market);
    const initialResponses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ledger.call(llm, `debate_${i + 1}`, initialSystem, initialUser, {
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

    // Rounds 1..R: revisions in parallel, conditioned on prior peer state.
    const reviseSystem = buildSystemPrompt('debateRevise');
    for (let round = 1; round <= R; round++) {
      const revised = await Promise.all(
        states.map((own, i) => {
          const peers = states.filter((_, j) => j !== i);
          const userPrompt = buildDebateUserPrompt(
            market,
            { probability: own.probability, reasoning: own.reasoning },
            peers,
          );
          return ledger
            .call(llm, `debate_${i + 1}`, reviseSystem, userPrompt, {
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

    const probability = aggregate(states.map(s => s.probability), 'median');
    return { probability, trace: ledger.build() };
  }
}
