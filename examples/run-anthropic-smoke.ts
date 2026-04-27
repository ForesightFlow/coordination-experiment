/**
 * Phase 0 smoke test: Anthropic API + IndependentEnsemble on one synthetic market.
 *
 * Validates that the AnthropicClient can drive IndependentEnsemble end-to-end.
 * NOT paper data — this is shakedown only.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=<key> npm run build
 *   ANTHROPIC_API_KEY=<key> node dist/examples/run-anthropic-smoke.js
 *
 * Expected cost: < $0.10 per run (1 agent, 800 max tokens per call).
 * Fails immediately with a clear message if ANTHROPIC_API_KEY is unset.
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

// Load .env from working directory before anything reads process.env.
(function loadDotEnv() {
  try {
    const lines = readFileSync('.env', 'utf-8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const eq = t.indexOf('=');
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env — fine */ }
})();
import { AnthropicClient } from '../src/clients/anthropic-client.js';
import {
  IndependentEnsemble,
  MockAgentTools,
  type CoordinationConfigParams,
  type Market,
} from '../src/index.js';

async function main() {
  // Fail fast so the user gets a useful message before spending any tokens.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is not set.');
    console.error('Export it in your shell before running this script.');
    process.exit(1);
  }

  // Single synthetic market for shakedown.
  const market: Market = {
    index: 0,
    question: 'Will Bitcoin trade above $100,000 by end of April 2026?',
    description:
      'Resolves YES if BTC/USD trades above $100,000 on any major centralised exchange ' +
      '(Binance, Coinbase, Kraken) between 00:00 UTC 2026-04-01 and 23:59 UTC 2026-04-30.',
    midPrice: 0.55,
  };

  // Mock tools — no Polymarket or Tavily keys required for the smoke test.
  const tools = new MockAgentTools(
    [
      {
        index: 0,
        question: market.question,
        description: market.description,
        currentYesPrice: market.midPrice,
        volume: 250_000,
        liquidity: 80_000,
        tags: ['crypto', 'bitcoin'],
      },
    ],
    new Map([
      [
        0,
        [
          { timestamp: Date.now() - 6 * 86400_000, yesPrice: 0.48 },
          { timestamp: Date.now() - 3 * 86400_000, yesPrice: 0.52 },
          { timestamp: Date.now() - 86400_000, yesPrice: 0.55 },
        ],
      ],
    ]),
  );

  // Rates as of 2026-04-27 for claude-opus-4-6.
  const llm = new AnthropicClient({
    modelId: 'claude-opus-4-6',
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 25,
    tools,
  });

  // Minimal params: 1 agent, tight token budget to keep cost < $0.10.
  const params: CoordinationConfigParams = {
    agentCount: 1,
    maxTokensPerMarket: 800,
    maxTokensPerCall: 800,
    temperature: 0.3,
  };

  const config = new IndependentEnsemble();

  console.log(`Running ${config.name} on: "${market.question}"`);
  console.log('Model: claude-opus-4-6 (Anthropic direct API)');
  console.log('');

  const startedAt = Date.now();
  const result = await config.predict({ market, tools, llm, params });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`Probability: ${result.probability.toFixed(4)}`);
  console.log(`Total tokens: ${result.trace.totalTokens}`);
  console.log(`Total cost: $${result.trace.totalCostUsd.toFixed(4)}`);
  console.log(`Wall time: ${elapsed}s`);
  console.log('');

  // Print agent text for manual inspection.
  for (const call of result.trace.calls) {
    console.log(`--- Call ${call.callIndex} | role: ${call.agentRole} ---`);
    console.log(call.response.text);
    if (call.response.toolCalls.length > 0) {
      console.log('Tool calls:', JSON.stringify(call.response.toolCalls, null, 2));
    }
  }

  const outputPath = 'results-smoke.json';
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        configName: result.trace.configName,
        market: { index: market.index, question: market.question },
        probability: result.probability,
        trace: result.trace,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outputPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
