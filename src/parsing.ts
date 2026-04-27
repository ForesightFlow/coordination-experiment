/**
 * Parsing utilities for LLM output.
 *
 * The output contracts in prompts.ts use sentinel tokens:
 *   - `FINAL_PROBABILITY: <num>` for forecaster/integrator/pipeline-forecaster/etc.
 *   - `SUBANSWER: <text>` for specialists.
 *   - `RESEARCH_COMPLETE` / `ANALYSIS_COMPLETE` as terminators.
 *
 * Parsers here are deliberately strict to surface format violations early; the
 * runner can then retry the call with a corrective re-prompt rather than
 * silently propagating malformed output (cf. failure-handling element of the
 * coordination layer specification, paper §3.2).
 */

export class ParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const FINAL_PROB_REGEX = /FINAL_PROBABILITY:\s*([01](?:\.\d+)?|0?\.\d+)/i;

/**
 * Extract the FINAL_PROBABILITY value from an LLM response.
 * Throws ParseError if the trailer is missing or out of [0, 1].
 */
export function parseFinalProbability(text: string): number {
  const match = FINAL_PROB_REGEX.exec(text);
  if (!match) {
    throw new ParseError('FINAL_PROBABILITY trailer not found', text);
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ParseError(`FINAL_PROBABILITY out of [0, 1]: ${match[1]}`, text);
  }
  return value;
}

/**
 * Extract the reasoning portion of a forecaster response: everything before
 * the FINAL_PROBABILITY trailer. Used for peer-debate and consensus messages.
 */
export function extractReasoning(text: string): string {
  const match = FINAL_PROB_REGEX.exec(text);
  if (!match) return text.trim();
  return text.slice(0, match.index).trim();
}

/**
 * Parse the planner output: a numbered list of 3 sub-questions.
 * Tolerant of "1." / "1)" / "1:" delimiters and minor whitespace variation.
 */
export function parseSubQuestions(text: string): string[] {
  // Match lines like "1. ..." or "1) ..." or "1: ..."
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const numbered = lines
    .map(l => /^(\d+)[.)\s:]\s*(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);

  if (numbered.length < 3) {
    throw new ParseError(
      `Expected at least 3 numbered sub-questions, got ${numbered.length}`,
      text,
    );
  }
  // Take the first 3 in order
  return numbered.slice(0, 3).map(m => m[2].trim());
}

const SUBANSWER_REGEX = /SUBANSWER:\s*(.+?)(?:\n|$)/i;

/**
 * Extract specialist's structured sub-answer from the report.
 * Returns the full report text plus the explicit sub-answer.
 */
export function parseSpecialistReport(text: string): {
  report: string;
  subAnswer: string;
} {
  const match = SUBANSWER_REGEX.exec(text);
  if (!match) {
    // Tolerate missing trailer: the full text becomes the report and sub-answer.
    return { report: text.trim(), subAnswer: text.trim() };
  }
  return {
    report: text.slice(0, match.index).trim(),
    subAnswer: match[1].trim(),
  };
}

/** Parse research report (no probability expected). */
export function parseResearchReport(text: string): string {
  return text.replace(/RESEARCH_COMPLETE\s*$/i, '').trim();
}

/** Parse analysis report (no probability expected). */
export function parseAnalysisReport(text: string): string {
  return text.replace(/ANALYSIS_COMPLETE\s*$/i, '').trim();
}
