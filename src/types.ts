/**
 * Core type definitions for the coordination experiment harness.
 *
 * The information-fixing principle (Principle 1 in the paper) is encoded here
 * as TypeScript contracts: every coordination configuration consumes the same
 * `LLMClient`, the same `MarketContext`, and the same `AgentTools`. They differ
 * only in orchestration logic.
 */

// --------------------------------------------------------------------------
// Market input (provided by Foresight Arena sandbox or any compatible source)
// --------------------------------------------------------------------------

export interface Market {
  /** Stable integer index used for tool calls. */
  index: number;
  /** Human-readable question (e.g., "Will X happen by Y?"). */
  question: string;
  /** Free-form description with resolution criteria, source, etc. */
  description: string;
  /** Polymarket condition ID or any external identifier. */
  conditionId?: string;
  /** ISO date string for market resolution. */
  resolutionDate?: string;
  /** Mid-price at commit-deadline; used as the market-consensus baseline. */
  midPrice?: number;
}

export interface MarketSet {
  roundIndex: number;
  markets: Market[];
}

// --------------------------------------------------------------------------
// Tools exposed to agents (mirrors the Foresight Arena tool stack)
// --------------------------------------------------------------------------

export interface MarketDetails {
  question: string;
  description: string;
  endDate?: string;
  currentYesPrice?: number;
  volume?: number;
  liquidity?: number;
  tags?: string[];
}

export interface PricePoint {
  timestamp: number;
  yesPrice: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface AgentTools {
  getMarketDetails(index: number): Promise<MarketDetails>;
  getPriceHistory(index: number): Promise<PricePoint[]>;
  searchWeb(query: string): Promise<SearchResult[]>;
}

// --------------------------------------------------------------------------
// LLM client interface (user plugs in Foresight Arena agent here)
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON-schema style; the user's adapter converts to whatever their SDK expects
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface GenerateRequest {
  /** Required system prompt; defines role identity and output contract. */
  systemPrompt: string;
  /** User-side message; typically the market question + relevant context. */
  userPrompt: string;
  /** Tool stack made available to this call. Identical across configs by Principle 1. */
  tools?: ToolDefinition[];
  /** Soft per-call cap; sum across calls is bounded by per-market budget at runner level. */
  maxTokens?: number;
  /** Sampling temperature; identical across configs by Principle 1. */
  temperature?: number;
  /** Optional response format hint ("text" or "json_object"). */
  responseFormat?: 'text' | 'json_object';
  /** Tag for trace recording (does not affect LLM input). */
  metadata?: { agentRole: string; configName: string };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerateResponse {
  /** Final assistant text (post tool use). */
  text: string;
  /** Tool calls executed during the generation, in order. */
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** Optional cost in USD; set by client if available. */
  costUsd?: number;
  /** Identifier of the underlying model invocation. */
  modelId: string;
  /** Wall-clock latency in milliseconds. */
  durationMs: number;
}

export interface LLMClient {
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

// --------------------------------------------------------------------------
// Trace recording (consumed by the Python analysis pipeline)
// --------------------------------------------------------------------------

export interface CallRecord {
  agentRole: string;
  callIndex: number;
  request: { systemPrompt: string; userPrompt: string };
  response: { text: string; toolCalls: ToolCall[] };
  usage: TokenUsage;
  costUsd?: number;
  durationMs: number;
  /** Round index within the config's internal protocol (e.g., debate round). */
  internalRound?: number;
}

export interface ReasoningTrace {
  configName: string;
  calls: CallRecord[];
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface MarketResult {
  marketIndex: number;
  question: string;
  /** Final probability emitted by the configuration, in [0, 1]. */
  probability: number;
  /** Set after market resolution; absent during prediction phase. */
  outcome?: 0 | 1;
  /** Polymarket mid-price at commit-deadline; used as Alpha baseline. */
  baseline?: number;
  trace: ReasoningTrace;
}

export interface RoundResult {
  roundIndex: number;
  configName: string;
  modelId: string;
  /** ISO timestamp of round execution. */
  executedAt: string;
  markets: MarketResult[];
}

// --------------------------------------------------------------------------
// Coordination configuration interface
// --------------------------------------------------------------------------

export interface CoordinationConfigParams {
  /** Number of agents in the configuration; meaning depends on config. */
  agentCount: number;
  /** Maximum protocol rounds (debate, consensus); ignored where not applicable. */
  maxInternalRounds?: number;
  /** Convergence tolerance for consensus alignment, in probability units. */
  convergenceTolerance?: number;
  /** Per-market token budget across all calls. */
  maxTokensPerMarket: number;
  /** Per-call max tokens (soft cap). */
  maxTokensPerCall?: number;
  /** Sampling temperature applied uniformly to all calls. */
  temperature: number;
}

export interface PredictArgs {
  market: Market;
  tools: AgentTools;
  llm: LLMClient;
  params: CoordinationConfigParams;
}

export interface PredictResult {
  probability: number;
  trace: ReasoningTrace;
}

export interface CoordinationConfig {
  name: string;
  predict(args: PredictArgs): Promise<PredictResult>;
}
