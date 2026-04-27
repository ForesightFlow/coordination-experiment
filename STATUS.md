# STATUS

Append-only log of work completed on this repository. Each entry is one line:
date in ISO format, task identifier, one-line summary including any cost or
benchmark numbers worth tracking.

The intent is for any session (Claude Code, the authors, future contributors)
to scan this file in 30 seconds and know exactly where the project stands.

Reference: see `CLAUDE.md` for the phase roadmap and task definitions.

---

## Phase 0 — Method validation

2026-04-27: Task 0.1 complete — AnthropicClient in src/clients/anthropic-client.ts; smoke test in examples/run-anthropic-smoke.ts (agentCount=1, 800 tokens, expected <$0.01/run). Run: ANTHROPIC_API_KEY=<key> npm run smoke.
2026-04-27: Task 0.2 complete — ConfigurableAgentTools in src/tools/configurable-tools.ts; 9/9 unit tests pass (npm run test); searchWeb returns [] and description patched to [DISABLED] when webSearchEnabled=false.
2026-04-27: Task 0.3 complete — PolymarketAgentTools in src/tools/polymarket-tools.ts; Gamma+CLOB+Tavily; in-memory caching; ≤200-point price sampling; 18/18 unit tests pass; integration test skipped without POLYMARKET_CONDITION_ID.
2026-04-27: Task 0.4 complete — ForesightFlow source in src/sources/foresightflow.ts; Zod schema aligned to actual fixture (marketId/resolutionOutcome/volumeUsdc); JsonlForesightFlowSource + ApiForesightFlowSource stub + loadFixtureWithOutcomes; 33/33 tests pass.
2026-04-27: Task 0.5 complete — Phase 0 validation runner in examples/run-validation.ts; loads 10 post-cutoff markets, PolymarketAgentTools+ConfigurableAgentTools (web OFF), all 5 configs, annotates outcomes, murphy.py leaderboard. Run: ANTHROPIC_API_KEY=<key> npm run validate.
2026-04-27: Phase 0 shakedown PASSED — 50/50 predictions, $11.22 cost, 1.75M tokens, 19min. Leaderboard: sequential_pipeline Brier=0.027, consensus_alignment=0.031, orchestrator_specialist=0.032, peer_critique_debate=0.040, independent_ensemble=0.044. All RES=0.25 (max discriminability on 10-market set). Fix log: (1) improved ApiError to include HTTP status+body; (2) .env auto-loader in examples; (3) retry w/ full-jitter backoff for 429s; (4) agentCount=1 for Phase 0 to stay under 30K-token/min limit.

2026-04-27: Phase 0.5 complete — 100 markets × 5 configs = 500 predictions, completed all 500, $109.65, 189.4 min. Leaderboard: sequential_pipeline Brier=0.153 (best), independent_ensemble=0.159, orchestrator_specialist=0.162, peer_critique_debate=0.170, consensus_alignment=0.181 (worst). Signal clearer than Phase 0: yes (10× more markets, balanced categories, spread 0.028 vs 0.017 in Phase 0; ranking shifted — consensus_alignment dropped from 2nd to last). 6 failures (transient network errors): 2 each in peer_critique/orchestrator/sequential, 0 in ensemble/alignment. Total tokens: 17.1M.

## Phase 1A — Historical sandbox

(blocked by Phase 0)

## Phase 1B — API sandbox

(blocked by Phase 1A or parallel if budget permits)

## Phase 3 — Production deployment

(parallel, lives in Foresight Arena repo, not tracked here)
