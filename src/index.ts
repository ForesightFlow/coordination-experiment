/**
 * Coordination Experiment harness — main entry point.
 *
 * Companion to: "Coordination as an Architectural Layer for LLM-Based
 * Multi-Agent Systems" (Nechepurenko & Shuvalov, 2026).
 *
 * Public API:
 *   - All type definitions (Market, CoordinationConfig, ...)
 *   - Five reference configurations (allConfigurations)
 *   - Runner (runRound, runRounds)
 *   - LLM client interface + MockLLMClient
 *   - Tool definitions + MockAgentTools
 */

export * from './types.js';
export * from './configs/index.js';
export * from './runner.js';
export { MockLLMClient } from './llm-client.js';
export { AnthropicClient, ApiError } from './clients/anthropic-client.js';
export { TOOL_DEFINITIONS, MockAgentTools } from './tools.js';
export { ConfigurableAgentTools } from './tools/configurable-tools.js';
export { ParseError } from './parsing.js';
