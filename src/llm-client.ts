/**
 * LLM client implementations.
 *
 * The harness depends only on the `LLMClient` interface (declared in
 * `types.ts`). Production deployment plugs in a real client that wraps the
 * Foresight Arena Vercel AI SDK / OpenRouter integration.
 *
 * `MockLLMClient` is provided so the harness can be exercised end-to-end
 * without API keys, including in CI. Its outputs are deterministic given
 * a seed, enabling reproducible smoke tests of the orchestration logic.
 */

import type {
  GenerateRequest,
  GenerateResponse,
  LLMClient,
  ToolCall,
} from './types.js';

// ==========================================================================
// MockLLMClient
// ==========================================================================

interface MockBehavior {
  /**
   * Optional override: given a request, return a custom response.
   * The runner uses this for scenario tests (e.g., inject a specific
   * probability, simulate malformed output, force a specific subquestion list).
   */
  respond?(req: GenerateRequest): string;

  /** Bias for forecaster-like roles, in [0, 1]. Default 0.5. */
  defaultProbability?: number;

  /** Stddev of probability noise per call, in [0, 0.5]. Default 0.05. */
  probabilityNoise?: number;

  /** Random seed for deterministic output. */
  seed?: number;
}

/** Deterministic PRNG (mulberry32). */
function makePRNG(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockLLMClient implements LLMClient {
  private rng: () => number;
  constructor(private readonly behavior: MockBehavior = {}) {
    this.rng = makePRNG(behavior.seed ?? 42);
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const startedAt = Date.now();
    const role = req.metadata?.agentRole ?? 'unknown';

    let text: string;
    if (this.behavior.respond) {
      text = this.behavior.respond(req);
    } else {
      text = this.synthesize(role, req);
    }

    const promptTokens = approxTokenCount(req.systemPrompt + req.userPrompt);
    const completionTokens = approxTokenCount(text);

    return {
      text,
      toolCalls: [],
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      costUsd: 0,
      modelId: 'mock-model-v0',
      durationMs: Date.now() - startedAt,
    };
  }

  private synthesize(role: string, req: GenerateRequest): string {
    const base = this.behavior.defaultProbability ?? 0.5;
    const noise = this.behavior.probabilityNoise ?? 0.05;
    const p = clamp01(base + (this.rng() - 0.5) * 2 * noise);

    switch (role) {
      case 'planner':
        return [
          '1. What is the current state of the relevant indicator?',
          '2. What recent events bear on the probability of YES?',
          '3. What are comparable historical base rates?',
        ].join('\n');

      case 'specialist':
        return [
          'Mock specialist report: based on available evidence, the picture is mixed.',
          'Recent developments lean slightly toward YES but uncertainty remains material.',
          '',
          'SUBANSWER: Mixed signal, modest tilt toward YES.',
        ].join('\n');

      case 'researcher':
        return [
          '## Key facts',
          '- Mock fact A.',
          '- Mock fact B.',
          '## Recent developments',
          '- Mock development X.',
          '## Base rates',
          '- Historical base rate ~50% on similar questions.',
          '## Sources',
          '- Mock source 1, Mock source 2.',
          '',
          'RESEARCH_COMPLETE',
        ].join('\n');

      case 'pipelineAnalyst':
        return [
          '1. Factor A: leans YES (moderate strength)',
          '2. Factor B: leans NO (weak strength)',
          '3. Factor C: ambiguous (low strength)',
          '',
          'ANALYSIS_COMPLETE',
        ].join('\n');

      // Probability-emitting roles share a tail format.
      default:
        return [
          'Mock reasoning: weighing available evidence and base rates,',
          'I assign a moderate probability that the YES outcome materializes.',
          '',
          `FINAL_PROBABILITY: ${p.toFixed(3)}`,
        ].join('\n');
    }
  }
}

// ==========================================================================
// Helpers
// ==========================================================================

function approxTokenCount(s: string): number {
  // Rough heuristic: ~4 chars per token. Matches OpenAI/Anthropic ballpark.
  return Math.max(1, Math.ceil(s.length / 4));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ==========================================================================
// Adapter scaffolding for the Foresight Arena Vercel AI SDK client
// ==========================================================================

/**
 * Reference adapter shape. The Foresight Arena LLM benchmark agent already
 * wraps Vercel AI SDK + OpenRouter; the integration is a thin function that
 * conforms its `generateText` call to our `LLMClient` interface.
 *
 * Pseudocode (for the Foresight Arena repo):
 *
 *   import { generateText } from 'ai';
 *   import { openrouter } from '@openrouter/ai-sdk-provider';
 *
 *   export function makeOpenRouterClient(modelId: string): LLMClient {
 *     return {
 *       async generate(req) {
 *         const startedAt = Date.now();
 *         const result = await generateText({
 *           model: openrouter(modelId),
 *           system: req.systemPrompt,
 *           prompt: req.userPrompt,
 *           tools: req.tools ? toAiSdkTools(req.tools) : undefined,
 *           temperature: req.temperature,
 *           maxOutputTokens: req.maxTokens,
 *         });
 *         return {
 *           text: result.text,
 *           toolCalls: result.toolCalls.map(tc => ({
 *             toolName: tc.toolName,
 *             arguments: tc.args,
 *             result: tc.result,
 *           })),
 *           usage: {
 *             promptTokens: result.usage.promptTokens,
 *             completionTokens: result.usage.completionTokens,
 *             totalTokens: result.usage.totalTokens,
 *           },
 *           modelId,
 *           durationMs: Date.now() - startedAt,
 *         };
 *       },
 *     };
 *   }
 *
 * The user keeps this adapter in their Foresight Arena repo so that this
 * harness package has zero dependency on Vercel AI SDK / OpenRouter.
 */
