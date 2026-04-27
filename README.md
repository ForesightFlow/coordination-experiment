# Coordination Experiment Harness

Companion code for **"Coordination as an Architectural Layer for LLM-Based Multi-Agent Systems"** (Nechepurenko & Shuvalov, 2026).

This repository implements the five reference coordination configurations specified in the paper (§3.5) and provides the experimental machinery to evaluate them under the information-fixing principle (§4.1) on real prediction markets via the Foresight Arena sandbox.

## What is in here

```
src/
├── types.ts                          shared type contracts
├── prompts.ts                        prompt templates (role-keyed)
├── parsing.ts                        LLM output parsers (FINAL_PROBABILITY, etc.)
├── tools.ts                          tool spec + MockAgentTools
├── llm-client.ts                     LLMClient interface + MockLLMClient
├── runner.ts                         experiment runner
├── configs/
│   ├── base.ts                       trace ledger + aggregation helpers
│   ├── independent-ensemble.ts       Prediction 1: parallel forecasters, median
│   ├── peer-critique-debate.ts       Prediction 2: N agents × R debate rounds
│   ├── orchestrator-specialist.ts    Prediction 3: planner + N specialists + integrator
│   ├── sequential-pipeline.ts        Prediction 4: research → analyze → forecast
│   └── consensus-alignment.ts        Prediction 5: iterate to convergence
│   └── index.ts                      allConfigurations()
└── index.ts                          public API
examples/
└── run-mock-experiment.ts            end-to-end smoke test (no API keys needed)
analysis/
├── murphy.py                         Brier, Alpha, Murphy decomposition
└── requirements.txt                  numpy / pandas / matplotlib
```

## Architectural discipline

Every configuration in `src/configs/` consumes the same `LLMClient`, the same `AgentTools`, and the same `CoordinationConfigParams` (see `types.ts`). They differ only in orchestration logic. The information-fixing principle (paper §4.1) is enforced at the type level: a config that needs different information from another is forced to declare that change explicitly, since it must call the tool/LLM through the shared interfaces.

To audit information-fixing claims, diff the rendered system prompts: the `COMMON_SYSTEM_HEADER`, `COMMON_TOOL_REMINDER`, and `COMMON_OUTPUT_FORMAT` are identical across roles; only the `roleInstructions` block differs. See `prompts.ts`.

## Quick start (no API keys)

```bash
npm install
npm run build
node dist/examples/run-mock-experiment.js
python3 analysis/murphy.py results-mock.json --synthetic-outcomes \
    --plot rel_res.png --table summary.csv
```

Expected output: a `results-mock.json` with one `RoundResult` per configuration (5 total), and an `rel_res.png` showing the observed Murphy signatures of the five configurations on synthetic data. With real markets and real LLMs, this is the central figure of the paper (paper Figure 4).

## Integrating with Foresight Arena

The harness depends only on the `LLMClient` interface, not on Vercel AI SDK or OpenRouter. To run on real markets:

### 1. Implement the LLMClient adapter

Inside the Foresight Arena codebase (where the AI SDK and OpenRouter dependencies already live), wrap `generateText` to conform to our interface:

```typescript
import { generateText } from 'ai';
import { openrouter } from '@openrouter/ai-sdk-provider';
import type { LLMClient } from 'coordination-experiment';

export function makeOpenRouterClient(modelId: string): LLMClient {
  return {
    async generate(req) {
      const startedAt = Date.now();
      const result = await generateText({
        model: openrouter(modelId),
        system: req.systemPrompt,
        prompt: req.userPrompt,
        tools: req.tools ? toAiSdkTools(req.tools) : undefined,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
      });
      return {
        text: result.text,
        toolCalls: result.toolCalls.map(tc => ({
          toolName: tc.toolName,
          arguments: tc.args,
          result: tc.result,
        })),
        usage: { ...result.usage },
        modelId,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
```

### 2. Implement the AgentTools adapter

Wrap the existing Foresight Arena tool implementations (Polymarket Gamma API, CLOB, Tavily) into the `AgentTools` interface declared in `types.ts`. The signatures match by design.

### 3. Drive a real round

```typescript
import { runRound, allConfigurations } from 'coordination-experiment';

const llm = makeOpenRouterClient('claude-sonnet-4-6');
const tools = makePolymarketTools(/* ... */);

const results = await runRound(
  { roundIndex: 1, markets: roundMarkets },
  {
    configurations: allConfigurations(),
    llm,
    tools,
    params: {
      agentCount: 3,
      maxInternalRounds: 2,
      convergenceTolerance: 0.05,
      maxTokensPerMarket: 12000,
      maxTokensPerCall: 1500,
      temperature: 0.3,
    },
    modelId: 'claude-sonnet-4-6',
    concurrency: 4,
  },
);

await fs.writeFile(`results-r${roundIndex}.json`, JSON.stringify(results, null, 2));
```

### 4. After markets resolve

When the Polymarket conditions resolve, populate `outcome` (0 or 1) on each `MarketResult` from the Gnosis CTF and write the augmented JSON. Then run the analysis:

```bash
python3 analysis/murphy.py results-r1.json --plot rel_res_r1.png
```

## Configuration parameters

All five configurations share `CoordinationConfigParams` (`types.ts`):

| Parameter | Purpose | Recommended value (paper experiment) |
|---|---|---|
| `agentCount` | Number of peer agents (`N`) | 3 |
| `maxInternalRounds` | Debate / consensus rounds (`R`) | 2 |
| `convergenceTolerance` | Spread threshold for consensus | 0.05 |
| `maxTokensPerMarket` | Total token budget per market | 12000 |
| `maxTokensPerCall` | Soft per-call cap | 1500 |
| `temperature` | Sampling temperature | 0.3 |

These are held identical across configurations — that's the methodological point. Internal budget allocation differs by config (debate splits across `N × (R+1)` calls, pipeline across 3 stages, etc.).

## Output format

Each `RoundResult` records all calls made for each market, with full reasoning traces. This is the input to the Python analysis. Schema:

```json
{
  "roundIndex": 1,
  "configName": "peer_critique_debate",
  "modelId": "claude-sonnet-4-6",
  "executedAt": "2026-04-26T18:00:00.000Z",
  "markets": [
    {
      "marketIndex": 0,
      "question": "Will X happen by Y?",
      "probability": 0.42,
      "outcome": 1,            // populated after market resolves
      "baseline": 0.38,        // mid-price at commit deadline
      "trace": {
        "configName": "peer_critique_debate",
        "calls": [ /* array of CallRecord */ ],
        "totalTokens": 14500,
        "totalCostUsd": 0.18,
        "totalDurationMs": 24300
      }
    }
  ]
}
```

## Statistical power

Per Foresight Arena Proposition 3: detecting a true Alpha difference of `α* = 0.02` at significance `0.05` with power `0.80` requires approximately 350 resolved binary predictions per condition. With 5 coordination configurations, that is approximately 50 rounds × 7 markets each per configuration. Inter-configuration architectural effects are predicted to exceed this threshold (paper §3.5 implies effect sizes in the 0.02–0.05 range).

## Pre-registration

The qualitative predictions in the paper §3.5 (Predictions 1–5, summarized in Figure 3) are the pre-registered hypotheses for this experimental phase. All five configurations will be reported regardless of whether observed signatures match predictions; failed predictions will be reported as such. See `analysis/murphy.py::plot_signatures` for the planned visualization.

## Citation

```bibtex
@misc{nechepurenko2026coordination,
  author    = {Nechepurenko, Maksym and Shuvalov, Pavel},
  title     = {Coordination as an Architectural Layer for {LLM}-Based Multi-Agent Systems:
               A Position Paper with an Information-Controlled Empirical Design},
  year      = {2026},
  note      = {Working paper}
}
```

## License

MIT.
