/**
 * Prompt templates.
 *
 * Methodological discipline (Principle 1, paper §4.1): the structure of prompts
 * is held constant across coordination configurations. Only the role-specific
 * instruction block varies. Output format (the FINAL_PROBABILITY trailer) and
 * tool specifications are identical.
 *
 * To audit information-fixing claims, diff the rendered system prompts across
 * configs: only the `roleInstructions` portion should differ.
 */

import type { Market } from './types.js';

// ==========================================================================
// Common scaffolding
// ==========================================================================

export const COMMON_SYSTEM_HEADER = `\
You are a probability forecaster operating on a binary prediction market. \
Your task is to assess the probability that the YES outcome will occur given \
the available evidence. You reason carefully, consider multiple perspectives, \
and avoid both overconfidence and excessive hedging. You are calibrated: when \
you say 70%, the event happens about 70% of the time across many such estimates.`;

export const COMMON_TOOL_REMINDER = `\
You have access to tools for retrieving market metadata, recent price history, \
and web search. Use tools when they would meaningfully reduce your uncertainty; \
do not use them when you already have sufficient evidence. Each tool call \
consumes part of your token budget.`;

export const COMMON_OUTPUT_FORMAT = `\
End your response with a line containing exactly:
FINAL_PROBABILITY: <number between 0.00 and 1.00>
For example: FINAL_PROBABILITY: 0.42

Before that line, write your concise reasoning. Avoid restating the question. \
Avoid disclaimers about your uncertainty being inherent; quantify it instead.`;

// ==========================================================================
// Role-specific instruction blocks
// ==========================================================================

export const ROLE_INSTRUCTIONS = {
  /** Independent ensemble: solo forecaster, no awareness of other agents. */
  forecaster: `\
Role: Independent forecaster. Produce your best probability estimate for the \
YES outcome. Reason from first principles using the evidence you can gather. \
You are not aware of any other forecasters; commit to your own assessment.`,

  /** Peer-critique debate: agent considers peer estimates and revises. */
  debateRevise: `\
Role: Forecaster in a peer-critique loop. You will be shown other forecasters' \
probability estimates and their stated reasoning. Update your own estimate \
where you find their reasoning compelling, and hold your ground where you do \
not. Express disagreement explicitly. Avoid converging just to converge.`,

  /** Orchestrator-specialist: planner agent decomposes the question. */
  planner: `\
Role: Planner. Decompose the market question into 3 sub-questions whose answers \
together determine the final probability. Sub-questions must be empirically \
addressable using available tools (market data, price history, web search). \
Avoid sub-questions that merely restate the main question.

Output format:
1. <sub-question 1>
2. <sub-question 2>
3. <sub-question 3>

Do not output a probability; that is the integrator's job.`,

  /** Orchestrator-specialist: specialist answers one sub-question. */
  specialist: `\
Role: Specialist. You are answering one sub-question of a larger forecasting \
problem. Investigate the sub-question using the available tools. Produce a \
concise factual report with the key facts you found, their source, and any \
relevant uncertainty.

Do not output a final probability for the main question; output a report on \
your sub-question. The integrator will combine your report with others.

Output format: 2-4 short paragraphs of findings, then a line:
SUBANSWER: <your concise answer to the sub-question>`,

  /** Orchestrator-specialist: integrator combines specialist outputs. */
  integrator: `\
Role: Integrator. You will be shown 3 specialist reports addressing 3 \
sub-questions of a binary market. Synthesize them into a single probability \
estimate for the YES outcome. Weigh the reports' evidence; do not simply \
average their implicit views. Note where reports conflict and resolve the \
conflict in your reasoning.`,

  /** Sequential pipeline: researcher gathers information. */
  researcher: `\
Role: Researcher. Pipeline stage 1 of 3. Your task is to gather evidence \
relevant to the market question using available tools. Produce a structured \
report with: (a) key facts, (b) recent developments, (c) base rates if \
applicable, (d) sources. Do not analyze or forecast; that is downstream.

Output format: structured prose with clearly labeled sections. End with:
RESEARCH_COMPLETE`,

  /** Sequential pipeline: analyst processes research into analysis. */
  pipelineAnalyst: `\
Role: Analyst. Pipeline stage 2 of 3. You will be shown a research report. \
Identify the 3-5 most decision-relevant factors, the direction in which each \
points (toward YES or NO), and the strength of each signal. Note any \
inconsistencies in the research that warrant downstream attention.

Do not output a final probability; that is the forecaster's job in stage 3.

Output format: numbered list of factors with directions and strengths. End with:
ANALYSIS_COMPLETE`,

  /** Sequential pipeline: forecaster commits final probability. */
  pipelineForecaster: `\
Role: Forecaster. Pipeline stage 3 of 3. You will be shown a research report \
and an analysis of its decision-relevant factors. Produce the final \
probability for the YES outcome. Do not gather new evidence; rely on the \
upstream stages. Note explicitly any factor you down-weighted relative to \
the analyst's framing.`,

  /** Consensus alignment: agent revises toward inter-agent agreement. */
  consensusRevise: `\
Role: Forecaster in a consensus protocol. You will be shown your own previous \
estimate and the estimates of other forecasters in the group. The protocol \
asks you to update toward agreement where you find the group's reasoning \
sound. Do not maintain disagreement for its own sake. The protocol terminates \
when the group converges within a small tolerance.`,
};

// ==========================================================================
// Prompt assembly
// ==========================================================================

export function buildSystemPrompt(role: keyof typeof ROLE_INSTRUCTIONS): string {
  return [
    COMMON_SYSTEM_HEADER,
    '',
    ROLE_INSTRUCTIONS[role],
    '',
    COMMON_TOOL_REMINDER,
    '',
    // Roles that do not output a probability suppress the FINAL_PROBABILITY trailer.
    isProbabilityEmittingRole(role) ? COMMON_OUTPUT_FORMAT : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function isProbabilityEmittingRole(role: keyof typeof ROLE_INSTRUCTIONS): boolean {
  return (
    role === 'forecaster' ||
    role === 'debateRevise' ||
    role === 'integrator' ||
    role === 'pipelineForecaster' ||
    role === 'consensusRevise'
  );
}

// ==========================================================================
// User-message templates (per call type)
// ==========================================================================

export function marketBlock(market: Market): string {
  const parts = [`Question: ${market.question}`];
  if (market.description) parts.push(`Description: ${market.description}`);
  if (market.resolutionDate) parts.push(`Resolution date: ${market.resolutionDate}`);
  if (typeof market.midPrice === 'number') {
    parts.push(`Current market mid-price: ${market.midPrice.toFixed(3)}`);
  }
  return parts.join('\n');
}

export function buildForecasterUserPrompt(market: Market): string {
  return `${marketBlock(market)}\n\nProduce your probability estimate.`;
}

export function buildDebateUserPrompt(
  market: Market,
  ownPrior: { probability: number; reasoning: string } | null,
  peers: { agentId: string; probability: number; reasoning: string }[],
): string {
  const peerBlocks = peers
    .map(
      p =>
        `--- Agent ${p.agentId} (probability ${p.probability.toFixed(2)}) ---\n${p.reasoning.trim()}`,
    )
    .join('\n\n');

  const priorBlock = ownPrior
    ? `Your own previous estimate: ${ownPrior.probability.toFixed(2)}\nYour previous reasoning:\n${ownPrior.reasoning.trim()}\n\n`
    : '';

  return `${marketBlock(market)}\n\n${priorBlock}Other agents' estimates and reasoning:\n\n${peerBlocks}\n\nProduce your revised probability estimate.`;
}

export function buildPlannerUserPrompt(market: Market): string {
  return `${marketBlock(market)}\n\nDecompose this market into 3 sub-questions.`;
}

export function buildSpecialistUserPrompt(
  market: Market,
  subQuestion: string,
): string {
  return `${marketBlock(market)}\n\nSub-question to investigate:\n${subQuestion}\n\nInvestigate and produce a report.`;
}

export function buildIntegratorUserPrompt(
  market: Market,
  reports: { subQuestion: string; report: string }[],
): string {
  const reportBlocks = reports
    .map((r, i) => `=== Sub-question ${i + 1}: ${r.subQuestion} ===\n${r.report.trim()}`)
    .join('\n\n');
  return `${marketBlock(market)}\n\nSpecialist reports:\n\n${reportBlocks}\n\nProduce your integrated probability estimate.`;
}

export function buildResearcherUserPrompt(market: Market): string {
  return `${marketBlock(market)}\n\nGather relevant evidence.`;
}

export function buildPipelineAnalystUserPrompt(
  market: Market,
  research: string,
): string {
  return `${marketBlock(market)}\n\nResearch report:\n\n${research.trim()}\n\nIdentify decision-relevant factors.`;
}

export function buildPipelineForecasterUserPrompt(
  market: Market,
  research: string,
  analysis: string,
): string {
  return `${marketBlock(market)}\n\nResearch report:\n${research.trim()}\n\nAnalysis:\n${analysis.trim()}\n\nProduce the final probability.`;
}

export function buildConsensusUserPrompt(
  market: Market,
  ownPrevious: { probability: number; reasoning: string },
  peers: { agentId: string; probability: number; reasoning: string }[],
  iteration: number,
): string {
  const peerBlocks = peers
    .map(
      p =>
        `--- Agent ${p.agentId} (probability ${p.probability.toFixed(2)}) ---\n${p.reasoning.trim()}`,
    )
    .join('\n\n');
  return `${marketBlock(market)}\n\nConsensus iteration: ${iteration}\nYour previous estimate: ${ownPrevious.probability.toFixed(2)}\n\nOther agents' current estimates:\n\n${peerBlocks}\n\nProduce your updated probability estimate.`;
}
