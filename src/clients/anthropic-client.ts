/**
 * Anthropic LLMClient implementation.
 *
 * Wraps the Anthropic Messages API, handles the tool-use loop, and returns a
 * GenerateResponse with accurate token counts, cost, and timing.
 *
 * Tool call execution requires an AgentTools instance passed at construction
 * time. If the model issues a tool call without one, the call throws ApiError.
 *
 * Rates as of 2026-04-27 — verify before each major run (Phase 1A, 1B):
 *   claude-opus-4-6:  $5 / $25 per million input / output tokens
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentTools,
  GenerateRequest,
  GenerateResponse,
  LLMClient,
  ToolCall,
} from '../types.js';

// --------------------------------------------------------------------------
// Error type
// --------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// --------------------------------------------------------------------------
// Client configuration
// --------------------------------------------------------------------------

export interface AnthropicClientConfig {
  modelId: string;
  /** Input token price; pass current rates — do NOT hardcode in callers. */
  inputUsdPerMillion: number;
  /** Output token price; pass current rates. */
  outputUsdPerMillion: number;
  /** API key override; falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /**
   * Tool implementations. Required if the model is expected to call tools.
   * The method names must match the tool names in TOOL_DEFINITIONS exactly.
   */
  tools?: AgentTools;
  /**
   * Maximum 429 retry attempts per API call (exponential backoff + jitter).
   * Default 6. Set to 0 to disable retry logic.
   */
  maxRetries?: number;
}

// --------------------------------------------------------------------------
// Error detail extraction
// --------------------------------------------------------------------------

/**
 * Produce a human-readable summary of an SDK or network error.
 * Covers Anthropic.APIError (has status + parsed body) and plain Errors.
 */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const parts: string[] = [`[${err.name}]`];
    if (err.status !== undefined) parts.push(`HTTP ${err.status}`);
    parts.push(err.message);
    if (err.error != null) {
      const body = JSON.stringify(err.error);
      parts.push(`body: ${body.slice(0, 500)}`);
    }
    // requestID is present on HTTP errors (not on connection errors)
    const reqId = (err as { requestID?: string }).requestID;
    if (reqId) parts.push(`requestID: ${reqId}`);
    return parts.join(' | ');
  }
  if (err instanceof Error) {
    return `[${err.name}] ${err.message}`;
  }
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err);
  }
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export class AnthropicClient implements LLMClient {
  private readonly sdk: Anthropic;
  private readonly maxRetries: number;

  constructor(private readonly config: AnthropicClientConfig) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ApiError(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY or pass apiKey in config.',
      );
    }
    // Disable the SDK's built-in retry so our own backoff logic is the only one.
    this.sdk = new Anthropic({ apiKey, maxRetries: 0 });
    this.maxRetries = config.maxRetries ?? 6;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const startedAt = Date.now();

    // Convert our ToolDefinition[] to Anthropic tool format.
    const anthropicTools: Anthropic.Messages.Tool[] | undefined = req.tools?.map(
      t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      }),
    );

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: req.userPrompt },
    ];

    const recordedToolCalls: ToolCall[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = '';

    // Tool-use loop: continue until model stops calling tools or hits max_tokens.
    for (;;) {
      const response = await this.callWithRetry({
        model: this.config.modelId,
        system: req.systemPrompt,
        messages,
        tools: anthropicTools,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      if (response.stop_reason !== 'tool_use') {
        finalText = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        break;
      }

      // Append assistant message with tool_use blocks.
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool call and build tool_result blocks.
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        const args = block.input as Record<string, unknown>;
        let result: unknown;
        try {
          result = await this.executeTool(block.name, args);
        } catch (err) {
          // Return the error to the model so it can adapt rather than crashing.
          result = { error: String(err) };
        }

        recordedToolCalls.push({
          toolName: block.name,
          arguments: args,
          result,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    const durationMs = Date.now() - startedAt;
    const costUsd =
      (totalInputTokens * this.config.inputUsdPerMillion +
        totalOutputTokens * this.config.outputUsdPerMillion) /
      1_000_000;

    return {
      text: finalText,
      toolCalls: recordedToolCalls,
      usage: {
        promptTokens: totalInputTokens,
        completionTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
      costUsd,
      modelId: this.config.modelId,
      durationMs,
    };
  }

  /**
   * Single API call with exponential-backoff retry on 429.
   * Respects the `retry-after` response header when present.
   */
  private async callWithRetry(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Messages.Message> {
    const BASE_MS = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sdk.messages.create(params);
      } catch (err) {
        const is429 = err instanceof Anthropic.APIError && err.status === 429;
        if (is429 && attempt < this.maxRetries) {
          const retryAfterSec = Number(
            (err as { headers?: { get?: (k: string) => string | null } }).headers?.get?.('retry-after') ?? 0,
          );
          // Full-jitter backoff: random in [0, cap] so concurrent callers
          // don't all retry at the same instant (thundering herd).
          const cap = Math.min(BASE_MS * Math.pow(2, attempt), 60_000);
          const delayMs = retryAfterSec > 0
            ? retryAfterSec * 1000
            : Math.random() * cap;
          process.stderr.write(
            `[AnthropicClient] 429 rate-limited, retry ${attempt + 1}/${this.maxRetries} in ${Math.round(delayMs / 1000)}s\n`,
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw new ApiError(`Anthropic API call failed: ${describeError(err)}`, err);
      }
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.config.tools) {
      throw new ApiError(
        `Tool "${name}" called but no AgentTools provided to AnthropicClient.`,
      );
    }
    const tools = this.config.tools;
    switch (name) {
      case 'getMarketDetails':
        return tools.getMarketDetails(args['index'] as number);
      case 'getPriceHistory':
        return tools.getPriceHistory(args['index'] as number);
      case 'searchWeb':
        return tools.searchWeb(args['query'] as string);
      default:
        throw new ApiError(`Unknown tool: "${name}"`);
    }
  }
}
