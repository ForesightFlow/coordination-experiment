# AGENT_INSTRUCTIONS.md

> This file documents the development process and was used as instruction context
> for AI-assisted coding (Anthropic's Claude Code). It is preserved for
> transparency about how the harness was built. Methodology details for
> reproducing the experiment are in README.md and in the accompanying paper.

---

## Project context

This repository is the experimental harness for the paper **"Coordination as an
Architectural Layer for LLM-Based Multi-Agent Systems"** (Nechepurenko & Shuvalov, 2026).
The paper argues that coordination should be treated as a configurable architectural
layer, separable from agent logic and information access. Five reference configurations
are pre-registered with falsifiable Murphy-decomposition signatures. This repo runs the
experiment that confirms or falsifies those predictions.

The paper itself lives in a sibling repo `coordination-paper/`. **You should not modify
the paper's claims, predictions, or methodology** — your job is to build the experimental
infrastructure that produces the data sections §5–§8 will report.

## What is already built (do not rewrite)

The following files exist and have been validated end-to-end with a mock LLM client.
Read them before changing anything.

```
src/
├── types.ts                      Core type contracts. Stable. Do NOT change interface
│                                 shapes without updating all configs simultaneously.
├── prompts.ts                    Role-keyed prompt templates with a shared scaffold
│                                 (COMMON_SYSTEM_HEADER + COMMON_TOOL_REMINDER +
│                                 COMMON_OUTPUT_FORMAT). The information-fixing
│                                 principle is enforced here: only `roleInstructions`
│                                 differs between roles. DO NOT introduce per-config
│                                 differences in scaffold blocks.
├── parsing.ts                    Strict parsers (FINAL_PROBABILITY, SUBANSWER,
│                                 RESEARCH_COMPLETE, ANALYSIS_COMPLETE).
├── tools.ts                      TOOL_DEFINITIONS + MockAgentTools.
├── llm-client.ts                 LLMClient interface + MockLLMClient + adapter
│                                 scaffolding for a real Anthropic/OpenAI/OpenRouter
│                                 client (currently as comments).
├── runner.ts                     runRound, runRounds. Bounded concurrency.
│                                 Failure handling returns a 0.5 fallback with a
│                                 marker rather than crashing the whole round.
├── configs/
│   ├── base.ts                   TraceLedger, aggregate, spread.
│   ├── independent-ensemble.ts   Pre-registered as Prediction 1 in paper §3.5.
│   ├── peer-critique-debate.ts   Prediction 2.
│   ├── orchestrator-specialist.ts Prediction 3.
│   ├── sequential-pipeline.ts    Prediction 4.
│   └── consensus-alignment.ts    Prediction 5.
├── index.ts                      Public API.
examples/run-mock-experiment.ts   Smoke test that runs all 5 configs through mock LLM.
analysis/murphy.py                Murphy decomposition (B = UNC + REL - RES),
                                  Brier, Alpha, REL×RES scatter plot, CSV export.
```

Sanity check command (must pass before any new work):

```bash
npm install && npm run build && node dist/examples/run-mock-experiment.js \
  && python3 analysis/murphy.py results-mock.json --synthetic-outcomes \
       --plot /tmp/check.png --table /tmp/check.csv
```

## Architectural invariants (NEVER violate)

These are pre-registered methodological claims of the paper. Violating any of them
invalidates the experiment.

1. **Information fixing.** Across all five configurations, the LLMClient, AgentTools,
   prompt scaffolding (COMMON_SYSTEM_HEADER / COMMON_TOOL_REMINDER /
   COMMON_OUTPUT_FORMAT), token budget, and temperature are IDENTICAL. Only
   `roleInstructions` and orchestration logic vary. To audit this: diff rendered
   system prompts between configs — only the role-specific block should differ.

2. **Single model per experiment.** One model across all configs in a given run.
   Cross-model robustness is FUTURE WORK, not this paper.

3. **Pre-registered predictions.** The five Murphy signatures in paper §3.5 are
   pre-registered. Report ALL five regardless of result. Failed predictions are
   reported as failed, not hidden.

4. **Strict propriety.** Brier and Alpha are the primary metrics. Do NOT introduce
   PnL, accuracy, or any non-proper metric as a primary score.

5. **No leakage.** Historical sandbox markets MUST be post-cutoff for the model
   under test, AND web search MUST be disabled in that sandbox. API sandbox uses
   real future events with web search enabled.

## Build & test commands

```bash
npm install                       # install deps (TypeScript, @types/node)
npm run build                     # compile TS to dist/
npm run typecheck                 # tsc --noEmit
npm run mock                      # build + run mock smoke test
npm run clean                     # rm -rf dist
pip install -r analysis/requirements.txt
```

## Locked experimental design

### Phase 0 — Method validation (CURRENT FOCUS)

Goal: prove the harness works end-to-end with a real LLM on a small set of real
markets. Catch prompt failures, parsing edge cases, real-API quirks. NOT for paper
data — this is shakedown.

- 1 model: `claude-opus-4-6` via Anthropic direct API (uses ANTHROPIC_API_KEY).
  Rationale: training-data cutoff is August 2025, the earliest among current
  frontier-class Claude models — this gives the largest historical-sandbox
  window in Phase 1A (~8 months of post-cutoff resolved markets vs ~3 months
  for Opus 4.7 and Sonnet 4.6). Pricing is $5/$25 per million tokens with no
  Opus 4.7 tokenizer-inflation penalty.
- 10 markets from ForesightFlow, post-cutoff, web search OFF.
- All 5 configurations.
- Total expected cost: ~$2–3.
- Output: traces inspected manually. Look for: malformed parsings, role drift,
  budget overruns, identical-looking outputs across configs (would suggest a
  bug in information fixing).

### Phase 1A — Historical sandbox (after Phase 0 passes)

- Source: ForesightFlow DB. Markets WHERE `resolved_at` between
  model-training-cutoff and `now()`, category IN target-categories, volume > $50K.
- Categories: Crypto, Politics, Sports, Economics, Geopolitics, Entertainment.
- Web search OFF (no leakage from post-resolution news).
- Baseline mid-price: latest available ≥ 24h before resolution event.
- 1 model: claude-opus-4-6.
- All 5 configs. ~1500–2000 markets (the cheaper-than-Opus-4.7 model lets us
  scale up versus the original ~500–700 plan; bigger N tightens the power
  envelope).
- Expected cost: ~$45–60.

**ILS handling.** Primary analysis runs WITHOUT an ILS filter — all markets
matching the criteria above are included. A separate sensitivity analysis
re-runs the Murphy decomposition on ILS-thresholded subsets (if ForesightFlow
ILS is production-grade by experiment time) to verify that REL/RES architectural
signatures are robust to insider-driven markets. The sensitivity result will
be a sub-section of paper §6, not a primary claim. If ForesightFlow ILS is
not ready in time, the sensitivity moves to Future Work — primary analysis
stands either way. Do NOT make the primary metric depend on ILS.

### Phase 1B — API sandbox (after Phase 1A or in parallel if budget permits)

- Source: Foresight Arena short-resolution-window API (existing infrastructure
  in the user's Foresight Arena repo).
- Real future events, web search ON.
- 1 model: claude-opus-4-6.
- All 5 configs. ~200–300 markets.
- Expected cost: ~$15–25.
- Purpose: cross-validate that REL×RES signatures from Phase 1A reproduce on
  real-future-event markets. Methodological insurance against historical-data
  contamination.

### Phase 3 — Production deployment (parallel, in Foresight Arena repo, not here)

- Deploy Orchestrator-Specialist as a Foresight Arena agent in production.
- Records on-chain via ERC-8004.
- Owned by Pavel; this repo provides only the configuration code.
- Do NOT do this work here.

### Future work (NOT this paper)

- Cross-model robustness (gpt-5-2, gemini-3-pro, etc.) — separate paper planned.
- Hybrid / adaptive coordination configurations.
- ILS-stratified analysis as a primary methodology (rather than sensitivity)
  if ForesightFlow's ILS metric matures and shows architectural effects depend
  on it.

## Phase 0 — concrete tasks

Work through these sequentially. Each task has acceptance criteria. Run all
existing tests after every task. Do not start the next task until the current one
passes acceptance.

### Task 0.1 — Anthropic LLMClient implementation

Add `src/clients/anthropic-client.ts`. It must:
- Implement `LLMClient` from `src/types.ts`.
- Use `@anthropic-ai/sdk` (add to package.json dependencies).
- Read API key from `ANTHROPIC_API_KEY` env var.
- Translate `req.tools` (our `ToolDefinition[]`) to Anthropic's tool-use format.
- Execute tool calls returned by the model (looping until model returns text-only
  response or `req.maxTokens` is reached).
- Return `GenerateResponse` with accurate `usage`, `costUsd`, `modelId`, and
  `durationMs`.

Per-million-token rates must be passed to the constructor, NOT hardcoded
(rates change). Suggested constructor shape:

```typescript
new AnthropicClient({
  modelId: 'claude-opus-4-6',
  inputUsdPerMillion: 5,     // override at construction time
  outputUsdPerMillion: 25,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

Document current rates inline in a comment with the date checked. Whoever runs
Phase 1A is responsible for verifying rates at run time.

**Acceptance:** new file `examples/run-anthropic-smoke.ts` that runs
`IndependentEnsemble` on 1 synthetic market via real Anthropic API and prints the
trace. Works when `ANTHROPIC_API_KEY` is set; fails fast with a useful message
when not. Costs less than $0.10 per run.

### Task 0.2 — Configurable AgentTools with web-search toggle

Add `src/tools/configurable-tools.ts`. It must:
- Wrap an existing `AgentTools` instance.
- Expose a `webSearchEnabled: boolean` flag in its constructor.
- When `webSearchEnabled === false`, `searchWeb()` returns `[]` and the tool
  description in `TOOL_DEFINITIONS` is updated to indicate it is disabled (so
  the model knows not to spam it).

**Acceptance:** unit test in `tests/configurable-tools.test.ts` (use Node's
built-in `node:test`) confirming both modes. Mock backing tools.

### Task 0.3 — Polymarket Gamma read-only adapter

Add `src/tools/polymarket-tools.ts` implementing `AgentTools` against the public
Gamma API and CLOB endpoints. Reference: see Foresight Arena paper §4 for the
existing tool set; replicate read-only paths only (no order submission). Use
plain `fetch`, no SDK dependency.

- `getMarketDetails(index)` — looks up `Market` by `conditionId` via Gamma.
- `getPriceHistory(index)` — last 7 days of mid-price via CLOB. Sample to ≤200
  points to keep tool output compact.
- `searchWeb(query)` — Tavily via HTTP if `TAVILY_API_KEY` set, otherwise throws.

The constructor takes the round's `Market[]` so it can map indices to
conditionIds. Cache responses in-memory per process.

**Acceptance:** unit test with mocked `fetch` confirming each endpoint shape.
Integration test (skipped without env vars) that hits one real market.

### Task 0.4 — ForesightFlow market source

Add `src/sources/foresightflow.ts`. ForesightFlow already parses Polymarket
into a database (911K markets, 865K resolved, with price history). We do not
re-parse anything — we query ForesightFlow.

Define an interface and provide TWO implementations:

- Interface `ForesightFlowSource` with `fetchMarkets(criteria): Promise<Market[]>`.
  Criteria: `{ resolvedAfter: Date, resolvedBefore: Date, categories: string[],
  minVolumeUsd: number, limit: number }`.

- `JsonlForesightFlowSource(path: string)` — loads from a local JSONL fixture.
  Used for Phase 0 validation and unit tests. The user produces
  `data/foresightflow-fixture.jsonl` (~50 markets) for Phase 0 shakedown.

- `ApiForesightFlowSource(config)` — hits the ForesightFlow REST API (or
  whatever transport the user provides; document the assumed shape). Used for
  Phase 1A when the real query against the full DB is needed. The user wires
  up the actual endpoint and credentials. Until provided, leave a clearly
  marked stub: `throw new ConfigError('ForesightFlow API endpoint not configured')`.

Each market record (in JSONL or API response) must include `outcome` (0 or 1)
and a baseline mid-price computed as the last mid-price ≥ 24h before resolution.
Schema is documented below.

**JSONL row schema (validated with zod):**
```
{
  conditionId: string,
  question: string,
  description: string,
  category: "crypto" | "politics" | "sports" | "economics" | "geopolitics" | "entertainment",
  resolvedAt: string (ISO date),
  outcome: 0 | 1,
  baselineMidPrice: number (in [0, 1]),
  volumeUsd: number,
  ilsScore?: number  // optional; populated if ForesightFlow has it
}
```

**Acceptance:** loader validates each row against the Zod schema; mismatch
produces a clear error pointing at the failing row index and field. Add zod
to dependencies.

### Task 0.5 — Phase 0 runner

Add `examples/run-validation.ts`. It:
1. Loads 10 markets from a ForesightFlow JSONL fixture.
2. Asserts each market is post-`MODEL_TRAINING_CUTOFF` (env var, ISO date).
3. Constructs an Anthropic client, configurable tools with web search OFF.
4. Runs all 5 configurations.
5. Writes `results-validation.json`.
6. Runs `analysis/murphy.py` on the result and prints the leaderboard table.

**Acceptance:** end-to-end run completes for under $5 and produces a non-empty
leaderboard. Fail loudly if any config has zero successful predictions.

## Phase 1A — historical sandbox (after Phase 0 passes)

- Scale Task 0.5 to 500–700 markets across 6 categories.
- Add round-batching: split into rounds of ~7 markets each so the per-round
  trace structure matches Foresight Arena's existing analysis tooling.
- Add cost-aware concurrency: respect Anthropic rate limits.
- Add resumability: if the run crashes mid-way, restarting picks up from the
  last completed round (write incrementally to `results/round_NNN.jsonl`).
- Update `analysis/murphy.py` to load multi-round results and produce per-category
  REL×RES tables.

Detailed task list will be added to this file when Phase 0 completes.

## Phase 1B — API sandbox

Will integrate with the Foresight Arena short-resolution API. The user will
provide endpoint specs and credentials. Adapter goes in
`src/sources/foresight-arena.ts` mirroring the ForesightFlow source interface.
Web search ON. Pull markets, run all configs, store results.

## Code conventions

- **TypeScript strict mode.** All new files must pass `npm run typecheck` with
  zero warnings.
- **No default exports** in new modules. Named exports only.
- **No `any`.** Use `unknown` and narrow.
- **No top-level side effects** in library files. Bootstrap goes in
  `examples/` or a dedicated `bin/` script.
- **Errors are typed.** Throw `ParseError`, `ApiError`, etc. — not `Error`.
- **Cost in USD is always a number, never a string.** Currency formatting is
  the analysis layer's job.
- **No emoji in source code.** Logs are for humans reading terminals; keep them
  greppable.
- **Tests use Node's built-in `node:test`.** No Jest, no Vitest, no Mocha —
  keep dev deps minimal.
- **Comments explain WHY, not WHAT.** The why frequently references paper
  sections (e.g., "// Principle 1, paper §4.1: budget is shared across calls").

## Anti-patterns (do not do)

1. **Do not change prompt scaffolding to fix one config's behavior.** If
   `consensus_alignment` is mis-converging, fix it in its orchestration
   (`src/configs/consensus-alignment.ts`) or its role instructions — never by
   changing `COMMON_SYSTEM_HEADER`.
2. **Do not fall back to `0.5` silently when a config fails.** The runner's
   existing fallback writes a `_failure` field; the analysis pipeline must
   surface failed predictions in its summary, not bury them.
3. **Do not add a "smarter" config because the existing five didn't show
   significance.** That is p-hacking via architecture search. The five are
   pre-registered.
4. **Do not log API keys, prompts to stdout, or full transcripts in CI.**
   Tracing goes to JSON files, redacted in logs.
5. **Do not use `Math.random()` for any decision that affects results.** Use a
   seeded PRNG passed through explicit args.
6. **Do not bypass the `LLMClient` interface from inside a config.** A config
   that calls Anthropic directly violates information fixing.

## Where to ask questions

Open a TODO comment with `// TODO(claude-code):` and a clear question. The user
or Pavel will resolve. Do not silently make a methodology call yourself — the
methodology is paper-locked.

## Status tracking

After each completed task, append a one-line entry to `STATUS.md` (create if
absent):

```
2026-MM-DD: Task 0.1 complete — Anthropic client, smoke test costs $0.06.
```

Reference this file when planning the next session.
