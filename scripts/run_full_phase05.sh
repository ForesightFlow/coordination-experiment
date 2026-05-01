#!/usr/bin/env bash
# Reproduce Phase 0.5 results from scratch.
#
# Prerequisites:
#   - Node.js >= 18
#   - Python >= 3.10 with numpy/pandas/matplotlib (pip install -r analysis/requirements.txt)
#   - ANTHROPIC_API_KEY set in environment or .env file
#
# Expected cost:   ~$110 USD (100 markets × 5 configs × ~$0.22/prediction)
# Expected time:   ~3 hours (bottleneck: sequential_pipeline and orchestrator_specialist
#                  each require ~2 min/market due to multi-call orchestration)
# Output files:
#   results-validation-05.json   full results (consumed by murphy.py)
#   results-validation-05.jsonl  incremental log (resume safety, not for analysis)
#
# Resumability: if the run is interrupted, re-run this script unchanged.
# The runner reads results-validation-05.jsonl and skips completed predictions.

set -euo pipefail

echo "=== coordination-experiment Phase 0.5 reproduction ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 1. Build
echo "--- Step 1: Build ---"
npm install
npm run build
npm test
echo ""

# 2. Run validation
echo "--- Step 2: Run validate-05 ---"
echo "Expected: ~$110, ~3 hours, 500 predictions"
echo ""
EARLY_STOP=true \
VALIDATION_FIXTURE=data/fixture_phase05.jsonl \
VALIDATION_OUTPUT=results-validation-05.json \
VALIDATION_BUDGET=200 \
node dist/examples/run-validation.js
echo ""

# 3. Murphy decomposition (main leaderboard)
echo "--- Step 3: Murphy decomposition ---"
python3 analysis/murphy.py results-validation-05.json \
    --plot analysis/phase05_output/fig4_rel_res.png \
    --table analysis/phase05_output/table_leaderboard.csv
echo ""

# 4. Per-category and pairwise analysis (paper §6)
echo "--- Step 4: Per-category + pairwise t-tests ---"
python3 analysis/phase05_analysis.py results-validation-05.json
echo ""

# 5. Bootstrap power analysis
echo "--- Step 5: Bootstrap power analysis ---"
python3 analysis/phase05_bootstrap.py results-validation-05.json
echo ""

echo "=== Done ==="
echo "Primary output: results-validation-05.json"
echo "Leaderboard:    analysis/phase05_output/table_leaderboard.csv"
echo "REL×RES figure: analysis/phase05_output/fig4_rel_res.png"
