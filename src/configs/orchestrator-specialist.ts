/**
 * Orchestrator-Specialist configuration.
 *
 * 1. Planner agent decomposes the market question into N sub-questions.
 * 2. N specialist agents investigate sub-questions in parallel and produce
 *    structured reports (no probability).
 * 3. Integrator agent synthesizes the reports into a single probability.
 *
 * Predicted Murphy signature (paper §3.5, Prediction 3):
 *   - low REL       (integrator imposes a final calibration step)
 *   - moderate RES  (specialization helps if decomposition is good, but
 *                    integrator-mediated fusion homogenizes outputs)
 * Failure mode: orchestrator becomes a single-point error source; a wrong
 * decomposition cascades through to all specialists with no recovery path.
 */

import type { CoordinationConfig, PredictArgs, PredictResult } from '../types.js';
import { TraceLedger } from './base.js';
import {
  buildSystemPrompt,
  buildPlannerUserPrompt,
  buildSpecialistUserPrompt,
  buildIntegratorUserPrompt,
} from '../prompts.js';
import {
  parseSubQuestions,
  parseSpecialistReport,
  parseFinalProbability,
} from '../parsing.js';

export class OrchestratorSpecialist implements CoordinationConfig {
  readonly name = 'orchestrator_specialist';

  async predict(args: PredictArgs): Promise<PredictResult> {
    const { market, llm, params } = args;
    const ledger = new TraceLedger(this.name);

    const N = params.agentCount; // specialists count; planner sees this many sub-qs

    // Budget allocation: 1 planner + N specialists + 1 integrator = N + 2 calls.
    const perCallBudget = Math.floor(params.maxTokensPerMarket / (N + 2));

    // Stage 1: planner decomposes the question.
    const plannerSystem = buildSystemPrompt('planner');
    const plannerUser = buildPlannerUserPrompt(market);
    const plannerResponse = await ledger.call(
      llm,
      'planner',
      plannerSystem,
      plannerUser,
      {
        maxTokens: perCallBudget,
        temperature: params.temperature,
      },
    );
    const allSubQuestions = parseSubQuestions(plannerResponse.text);
    // The planner protocol is fixed at 3 sub-questions in prompts.ts; if we
    // configured fewer specialists, take the first N; if more, repeat the
    // 3rd sub-question to fill the slots (rare; primarily covers N != 3).
    const subQuestions = Array.from({ length: N }, (_, i) =>
      allSubQuestions[i] ?? allSubQuestions[allSubQuestions.length - 1],
    );

    // Stage 2: specialists investigate sub-questions in parallel.
    const specialistSystem = buildSystemPrompt('specialist');
    const specialistResponses = await Promise.all(
      subQuestions.map((subQ, i) =>
        ledger.call(
          llm,
          `specialist_${i + 1}`,
          specialistSystem,
          buildSpecialistUserPrompt(market, subQ),
          {
            maxTokens: perCallBudget,
            temperature: params.temperature,
          },
        ),
      ),
    );
    const reports = specialistResponses.map((r, i) => ({
      subQuestion: subQuestions[i],
      report: parseSpecialistReport(r.text).report,
    }));

    // Stage 3: integrator synthesizes a single probability.
    const integratorSystem = buildSystemPrompt('integrator');
    const integratorUser = buildIntegratorUserPrompt(market, reports);
    const integratorResponse = await ledger.call(
      llm,
      'integrator',
      integratorSystem,
      integratorUser,
      {
        maxTokens: perCallBudget,
        temperature: params.temperature,
      },
    );
    const probability = parseFinalProbability(integratorResponse.text);

    return { probability, trace: ledger.build() };
  }
}
