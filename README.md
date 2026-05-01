# coordination-experiment

Experimental harness for **"Coordination as an Architectural Layer for LLM-Based
Multi-Agent Systems"** (Nechepurenko & Shuvalov, 2026).

The paper argues that coordination should be treated as a configurable architectural
layer, separable from agent logic and information access. Five reference configurations
(IndependentEnsemble, PeerCritiqueDebate, OrchestratorSpecialist, SequentialPipeline,
ConsensusAlignment) are pre-registered with falsifiable Murphy-decomposition signatures
and evaluated on 100 real prediction markets from ForesightFlow under strict
information-fixing: every configuration receives the same model, the same tools, the
same token budget, and the same temperature. Only orchestration logic varies. The
companion dataset (traces, leaderboard) is published at
[ForesightFlow/datasets/coordination-traces-100](https://github.com/ForesightFlow/datasets/tree/main/coordination-traces-100).

---

## Repository layout

```
src/
├── types.ts                      core type contracts (stable; pre-registered methodology)
├── prompts.ts                    role-keyed prompt templates; information-fixing
│                                 enforced here — COMMON_SYSTEM_HEADER,
│                                 COMMON_TOOL_REMINDER, COMMON_OUTPUT_FORMAT are
│                                 identical across all configs; only roleInstructions
│                                 differs
├── parsing.ts                    strict parsers (FINAL_PROBABILITY, SUBANSWER, etc.)
├── tools.ts                      TOOL_DEFINITIONS + MockAgentTools
├── llm-client.ts                 LLMClient interface + MockLLMClient
├── runner.ts                     runRound, runRounds — bounded concurrency,
│                                 incremental JSONL persistence, resume on restart
├── clients/
│   └── anthropic-client.ts       Anthropic Messages API adapter with retry
├── tools/
│   ├── configurable-tools.ts     web-search on/off toggle (Phase 0.5: OFF)
│   └── polymarket-tools.ts       Polymarket Gamma + CLOB read-only adapter
├── sources/
│   └── foresightflow.ts          JSONL fixture loader + ForesightFlow API stub
└── configs/
    ├── base.ts                   TraceLedger, aggregate, spread
    ├── independent-ensemble.ts   Prediction 1 (paper §3.5)
    ├── peer-critique-debate.ts   Prediction 2
    ├── orchestrator-specialist.ts Prediction 3
    ├── sequential-pipeline.ts    Prediction 4
    └── consensus-alignment.ts    Prediction 5
examples/
├── run-mock-experiment.ts        smoke test — no API keys needed
├── run-anthropic-smoke.ts        single-market live API test (~$0.05)
└── run-validation.ts             Phase 0 / Phase 0.5 validation runner
analysis/
├── murphy.py                     Brier, Alpha, Murphy decomposition, REL×RES scatter
├── phase05_analysis.py           per-category and pairwise t-test tables
├── phase05_bootstrap.py          bootstrap power analysis
└── requirements.txt              numpy / pandas / matplotlib
data/
├── fixture_phase0.jsonl          10-market shakedown fixture
└── fixture_phase05.jsonl         100-market balanced fixture (6 categories ×
                                  10 baseline-decile buckets, all post-cutoff)
scripts/
└── run_full_phase05.sh           exact reproduction sequence with cost estimate
tests/
├── configurable-tools.test.ts    9 tests
├── polymarket-tools.test.ts      18 tests + 1 skipped integration test
└── foresightflow.test.ts         33 tests
```

---

## Installation and build

Requires Node.js ≥ 18.

```bash
npm install
npm run build        # compile TypeScript → dist/
npm run typecheck    # tsc --noEmit (zero warnings required)
npm test             # build + run 33 unit tests via node:test
```

Python analysis dependencies (optional):

```bash
pip install -r analysis/requirements.txt
```

---

## Smoke test — no API keys

```bash
npm run mock
python3 analysis/murphy.py results-mock.json --synthetic-outcomes \
    --plot rel_res.png --table summary.csv
```

---

## Running validate-05 against an arbitrary fixture

The validation runner is parameterised via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `VALIDATION_FIXTURE` | `data/fixture_phase0.jsonl` | Path to JSONL fixture |
| `VALIDATION_OUTPUT` | `results-validation.json` | Output path |
| `VALIDATION_BUDGET` | `150` | Cost alarm threshold in USD |
| `VALIDATION_LIMIT` | `0` (all) | Max markets to load |
| `MODEL_TRAINING_CUTOFF` | `2025-08-01` | Exclude markets resolved before this date |
| `EARLY_STOP` | `false` | Enable statistical early-stop check |

To run against `data/fixture_phase05.jsonl`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run validate-05
```

To run against your own fixture, supply a JSONL file where each row matches
`ForesightFlowRowSchema` in `src/sources/foresightflow.ts`:

```jsonl
{"marketId":"0xabc...","question":"Will X happen?","description":"...","category":"crypto","resolvedAt":"2026-01-15T00:00:00Z","resolutionOutcome":1,"baselineMidPrice":0.62,"volumeUsdc":125000}
```

**Resume after interruption:** restart with the same command. The runner reads the
incremental `.jsonl` log and skips already-completed (config, market) pairs.

See `scripts/run_full_phase05.sh` for the full sequence with expected wall time and cost.

---

## Reproducing the paper's numbers

Phase 0.5 results (500 predictions) are in the companion dataset at
[ForesightFlow/datasets/coordination-traces-100](https://github.com/ForesightFlow/datasets/tree/main/coordination-traces-100).

To reproduce from scratch (~$110, ~3 hours):

```bash
bash scripts/run_full_phase05.sh
```

For per-category breakdowns and pairwise t-tests (paper §6):

```bash
python3 analysis/phase05_analysis.py results-validation-05.json
python3 analysis/phase05_bootstrap.py results-validation-05.json
```

---

## Adding a new coordination configuration

See [CONTRIBUTING.md](CONTRIBUTING.md) for the four-step guide.

---

## Information-fixing audit

The methodological claim is that only orchestration logic varies between configs.
To audit, diff the rendered system prompts across role keys — `COMMON_SYSTEM_HEADER`,
`COMMON_TOOL_REMINDER`, and `COMMON_OUTPUT_FORMAT` must be byte-identical; only
`roleInstructions` should differ. See `src/prompts.ts`.

---

## License

[MIT License](LICENSE). Copyright (c) 2026 Maksym Nechepurenko, Pavel Shuvalov.

---

## Cite this work

If you use this code, please cite the paper it implements:

### Coordination as an Architectural Layer for LLM-Based Multi-Agent Systems

```bibtex
@misc{nechepurenko2026coordination,
  title  = {Coordination as an Architectural Layer for LLM-Based Multi-Agent Systems: An Information-Controlled Empirical Study on Prediction Markets},
  author = {Nechepurenko, Maksym and Shuvalov, Pavel},
  year   = {2026},
  url    = {https://papers.ssrn.com/abstract=6687518},
  note   = {SSRN Working Paper 6687518}
}
```

Full preprint, links, and supplementary material: <https://foresightflow.org/publications/coordination-architectural-layer>.
