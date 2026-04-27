/**
 * Mock end-to-end smoke test.
 *
 * Demonstrates the complete experimental flow with the Mock LLM client and
 * Mock tools — no API keys required. Runs all five configurations across
 * a small synthetic round and writes results to results-mock.json.
 *
 * Usage:
 *   npm run build
 *   node dist/examples/run-mock-experiment.js
 *
 * Expected output: a JSON file containing 5 RoundResult objects (one per
 * coordination configuration) with traces, probabilities, and token counts.
 */

import { writeFile } from 'node:fs/promises';
import {
  allConfigurations,
  type CoordinationConfigParams,
  type Market,
  type MarketSet,
  MockAgentTools,
  MockLLMClient,
  runRound,
} from '../src/index.js';

async function main() {
  // ---- Synthetic markets (mock) ----
  const markets: Market[] = [
    {
      index: 0,
      question: 'Will the S&P 500 close above 6,200 on Friday?',
      description: 'Resolves YES if the S&P 500 closes above 6,200 at end-of-day Friday.',
      midPrice: 0.42,
    },
    {
      index: 1,
      question: 'Will Bitcoin trade above $130,000 by month end?',
      description: 'Resolves YES if BTC/USD trades above 130,000 on any major exchange before EOM.',
      midPrice: 0.31,
    },
    {
      index: 2,
      question: 'Will Hurricane X make landfall in Florida this week?',
      description: 'Resolves YES if NHC declares landfall in Florida between Mon and Sun.',
      midPrice: 0.68,
    },
  ];

  const marketSet: MarketSet = { roundIndex: 0, markets };

  // ---- Configuration parameters (held identical across configs) ----
  const params: CoordinationConfigParams = {
    agentCount: 3,
    maxInternalRounds: 2,
    convergenceTolerance: 0.05,
    maxTokensPerMarket: 6000,
    maxTokensPerCall: 800,
    temperature: 0.3,
  };

  // ---- Mock LLM client + mock tools ----
  const llm = new MockLLMClient({
    seed: 42,
    defaultProbability: 0.45,
    probabilityNoise: 0.10,
  });
  const tools = new MockAgentTools(
    markets.map(m => ({
      index: m.index,
      question: m.question,
      description: m.description,
      currentYesPrice: m.midPrice,
    })),
  );

  // ---- Run all configurations ----
  const results = await runRound(marketSet, {
    configurations: allConfigurations(),
    llm,
    tools,
    params,
    modelId: 'mock-model-v0',
    onProgress: info => {
      const pct = Math.round(
        (info.marketsCompletedInRound / info.marketsTotalInRound) * 100,
      );
      console.log(
        `[${info.configName}] round ${info.roundIndex} market ${info.marketIndex} (${info.marketsCompletedInRound}/${info.marketsTotalInRound}, ${pct}%)`,
      );
    },
  });

  await writeFile('results-mock.json', JSON.stringify(results, null, 2));
  console.log('\n=== Summary ===');
  for (const r of results) {
    const probs = r.markets.map(m => m.probability.toFixed(3)).join(', ');
    const totalTokens = r.markets.reduce(
      (sum, m) => sum + m.trace.totalTokens,
      0,
    );
    console.log(
      `${r.configName}: probabilities = [${probs}], total tokens = ${totalTokens}`,
    );
  }
  console.log('\nWrote results-mock.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
