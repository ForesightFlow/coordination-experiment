/**
 * Sequential Pipeline configuration.
 *
 * Three stages execute strictly in order, each consuming only the previous
 * stage's output:
 *   Stage 1 (researcher): gathers structured evidence using tools.
 *   Stage 2 (analyst): identifies decision-relevant factors from the research.
 *   Stage 3 (forecaster): commits the final probability from research+analysis.
 *
 * Predicted Murphy signature (paper §3.5, Prediction 4):
 *   - REL and RES both critically dependent on stage 1.
 *   - Best-case: comparable to a strong single-agent baseline if stage 1 is
 *     thorough; otherwise, downstream stages elaborate on a wrong frame.
 * Failure mode: early-stage errors cascade with no architectural opportunity
 * for correction (stage 2 sees only stage 1's output).
 */

import type { CoordinationConfig, PredictArgs, PredictResult } from '../types.js';
import { TraceLedger } from './base.js';
import {
  buildSystemPrompt,
  buildResearcherUserPrompt,
  buildPipelineAnalystUserPrompt,
  buildPipelineForecasterUserPrompt,
} from '../prompts.js';
import {
  parseResearchReport,
  parseAnalysisReport,
  parseFinalProbability,
} from '../parsing.js';

export class SequentialPipeline implements CoordinationConfig {
  readonly name = 'sequential_pipeline';

  async predict(args: PredictArgs): Promise<PredictResult> {
    const { market, llm, params } = args;
    const ledger = new TraceLedger(this.name);

    // Three stages → divide budget evenly. agentCount is unused for this config
    // (pipeline length is fixed at 3 by Prediction 4); the field is preserved
    // in CoordinationConfigParams for cross-config interface uniformity.
    const perCallBudget = Math.floor(params.maxTokensPerMarket / 3);

    // Stage 1: researcher.
    const researcherResp = await ledger.call(
      llm,
      'researcher',
      buildSystemPrompt('researcher'),
      buildResearcherUserPrompt(market),
      {
        maxTokens: perCallBudget,
        temperature: params.temperature,
        internalRound: 1,
      },
    );
    const research = parseResearchReport(researcherResp.text);

    // Stage 2: analyst.
    const analystResp = await ledger.call(
      llm,
      'pipelineAnalyst',
      buildSystemPrompt('pipelineAnalyst'),
      buildPipelineAnalystUserPrompt(market, research),
      {
        maxTokens: perCallBudget,
        temperature: params.temperature,
        internalRound: 2,
      },
    );
    const analysis = parseAnalysisReport(analystResp.text);

    // Stage 3: forecaster commits.
    const forecasterResp = await ledger.call(
      llm,
      'pipelineForecaster',
      buildSystemPrompt('pipelineForecaster'),
      buildPipelineForecasterUserPrompt(market, research, analysis),
      {
        maxTokens: perCallBudget,
        temperature: params.temperature,
        internalRound: 3,
      },
    );
    const probability = parseFinalProbability(forecasterResp.text);

    return { probability, trace: ledger.build() };
  }
}
