"""
Murphy decomposition and Alpha analysis for the coordination experiment.

Loads experiment results (JSON written by `runner.runRound`) and computes:
  - Brier score per (config, round)
  - Alpha = Brier_market - Brier_agent (paper §6.4 of Foresight Arena)
  - Murphy decomposition: B = UNC + REL - RES with K probability-decile bins
  - Per-category breakdowns
  - REL x RES scatter plot (the central figure of the paper)

This module is the analysis side of the information-controlled comparison
methodology described in paper §4. The expected falsifiable signatures from
paper §3.5 are visualized in the REL x RES scatter and compared against
predictions in Figure 3 of the paper.

Usage (Python):
    >>> from murphy import load_results, compute_metrics, plot_signatures
    >>> rounds = load_results("results-mock.json", inject_synthetic_outcomes=True)
    >>> metrics = compute_metrics(rounds)
    >>> plot_signatures(metrics, output_path="rel_res.png")

CLI:
    python murphy.py results-mock.json --synthetic-outcomes \\
        --plot rel_res.png --table summary.csv
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------


@dataclass
class MarketRecord:
    """One per (config, round, market)."""

    config_name: str
    round_index: int
    market_index: int
    question: str
    probability: float
    outcome: int | None  # 0 or 1; may be None if not yet resolved
    baseline: float | None
    total_tokens: int
    total_cost_usd: float
    total_duration_ms: int
    n_calls: int
    category: str | None = None  # e.g., "crypto", "politics", "sports"


@dataclass
class MurphyDecomposition:
    """Murphy (1973) partition: B = UNC + REL - RES with K decile bins."""

    brier: float
    uncertainty: float
    reliability: float
    resolution: float
    n_observations: int
    n_bins_nonempty: int


@dataclass
class ConfigMetrics:
    """Aggregate metrics for one configuration across all rounds."""

    config_name: str
    n_markets: int
    mean_brier: float
    mean_alpha: float
    sem_alpha: float  # standard error of the mean
    murphy: MurphyDecomposition
    mean_tokens_per_market: float
    mean_cost_usd_per_market: float
    by_category: dict[str, MurphyDecomposition] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_results(
    path: str | Path,
    inject_synthetic_outcomes: bool = False,
    seed: int = 42,
) -> list[MarketRecord]:
    """
    Load experiment results from JSON. Optionally inject synthetic outcomes
    for testing the analysis pipeline before real markets resolve.

    With `inject_synthetic_outcomes=True`: each market's outcome is drawn
    from Bernoulli(baseline) if baseline is set, else Bernoulli(0.5).
    """
    raw = json.loads(Path(path).read_text())
    rng = np.random.default_rng(seed)

    records: list[MarketRecord] = []
    for round_result in raw:
        for market in round_result["markets"]:
            outcome = market.get("outcome")
            if outcome is None and inject_synthetic_outcomes:
                p = market.get("baseline") if market.get("baseline") is not None else 0.5
                outcome = int(rng.random() < p)
            records.append(
                MarketRecord(
                    config_name=round_result["configName"],
                    round_index=round_result["roundIndex"],
                    market_index=market["marketIndex"],
                    question=market["question"],
                    probability=float(market["probability"]),
                    outcome=outcome,
                    baseline=market.get("baseline"),
                    total_tokens=market["trace"]["totalTokens"],
                    total_cost_usd=market["trace"].get("totalCostUsd", 0.0),
                    total_duration_ms=market["trace"].get("totalDurationMs", 0),
                    n_calls=len(market["trace"].get("calls", [])),
                    category=market.get("category"),
                )
            )
    return records


def to_dataframe(records: list[MarketRecord]) -> pd.DataFrame:
    """Convert records to a flat DataFrame for ad-hoc analysis."""
    return pd.DataFrame(
        {
            "config": r.config_name,
            "round": r.round_index,
            "market": r.market_index,
            "question": r.question,
            "p": r.probability,
            "y": r.outcome,
            "baseline": r.baseline,
            "tokens": r.total_tokens,
            "cost": r.total_cost_usd,
            "duration_ms": r.total_duration_ms,
            "n_calls": r.n_calls,
            "category": r.category,
        }
        for r in records
    )


# ---------------------------------------------------------------------------
# Murphy decomposition
# ---------------------------------------------------------------------------


def murphy_decomposition(
    probabilities: np.ndarray,
    outcomes: np.ndarray,
    n_bins: int = 10,
) -> MurphyDecomposition:
    """
    Compute Murphy's vector partition of the Brier score on probability deciles.

    B = UNC + REL - RES where:
        UNC = o_bar * (1 - o_bar)            [outcome variance]
        REL = (1/N) sum_k n_k * (p_bar_k - o_bar_k)^2   [calibration error]
        RES = (1/N) sum_k n_k * (o_bar_k - o_bar)^2     [discriminative power]

    Lower REL is better calibration; higher RES is better discrimination.
    """
    p = np.asarray(probabilities, dtype=float)
    y = np.asarray(outcomes, dtype=float)
    if p.shape != y.shape:
        raise ValueError("probabilities and outcomes must have the same shape")
    if len(p) == 0:
        raise ValueError("empty input")

    # Brier (direct, for the identity check)
    brier = float(np.mean((p - y) ** 2))
    o_bar = float(np.mean(y))
    uncertainty = o_bar * (1.0 - o_bar)

    # Bin by probability deciles on [0, 1].
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    # np.digitize: edges[i-1] <= x < edges[i]; clamp last bin to include 1.0
    bin_idx = np.clip(np.digitize(p, edges, right=False) - 1, 0, n_bins - 1)

    n_total = len(p)
    rel = 0.0
    res = 0.0
    n_nonempty = 0
    for k in range(n_bins):
        mask = bin_idx == k
        n_k = int(mask.sum())
        if n_k == 0:
            continue
        n_nonempty += 1
        p_bar_k = float(p[mask].mean())
        o_bar_k = float(y[mask].mean())
        rel += n_k * (p_bar_k - o_bar_k) ** 2
        res += n_k * (o_bar_k - o_bar) ** 2

    rel /= n_total
    res /= n_total

    return MurphyDecomposition(
        brier=brier,
        uncertainty=uncertainty,
        reliability=rel,
        resolution=res,
        n_observations=n_total,
        n_bins_nonempty=n_nonempty,
    )


# ---------------------------------------------------------------------------
# Alpha (excess Brier over market consensus)
# ---------------------------------------------------------------------------


def alpha_score(
    agent_probabilities: np.ndarray,
    baselines: np.ndarray,
    outcomes: np.ndarray,
) -> tuple[float, float]:
    """
    Per-market Alpha = (b - y)^2 - (p - y)^2.
    Returns (mean Alpha, SEM Alpha) across the input markets.

    Reference: Foresight Arena paper Proposition 2 (closed-form variance) and
    Proposition 3 (sample-size formula).
    """
    p = np.asarray(agent_probabilities, dtype=float)
    b = np.asarray(baselines, dtype=float)
    y = np.asarray(outcomes, dtype=float)
    delta = (b - y) ** 2 - (p - y) ** 2
    mean = float(np.mean(delta))
    sem = float(np.std(delta, ddof=1) / np.sqrt(len(delta))) if len(delta) > 1 else 0.0
    return mean, sem


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def compute_metrics(
    records: list[MarketRecord], n_bins: int = 10
) -> dict[str, ConfigMetrics]:
    """Aggregate per-configuration metrics across all rounds."""
    out: dict[str, ConfigMetrics] = {}
    df = to_dataframe(records)
    df = df.dropna(subset=["y"])  # exclude unresolved markets
    if df.empty:
        return out

    for config_name, sub in df.groupby("config"):
        probs = sub["p"].to_numpy()
        outs = sub["y"].to_numpy(dtype=float)
        baselines = sub["baseline"].fillna(0.5).to_numpy()

        murphy = murphy_decomposition(probs, outs, n_bins=n_bins)
        mean_alpha, sem_alpha = alpha_score(probs, baselines, outs)

        # Per-category breakdown (only categories with >= 5 markets)
        by_category: dict[str, MurphyDecomposition] = {}
        if "category" in sub.columns:
            for cat, cat_sub in sub.dropna(subset=["category"]).groupby("category"):
                if len(cat_sub) < 5:
                    continue
                by_category[str(cat)] = murphy_decomposition(
                    cat_sub["p"].to_numpy(),
                    cat_sub["y"].to_numpy(dtype=float),
                    n_bins=min(n_bins, max(2, len(cat_sub) // 2)),
                )

        out[str(config_name)] = ConfigMetrics(
            config_name=str(config_name),
            n_markets=len(sub),
            mean_brier=float(np.mean((probs - outs) ** 2)),
            mean_alpha=mean_alpha,
            sem_alpha=sem_alpha,
            murphy=murphy,
            mean_tokens_per_market=float(sub["tokens"].mean()),
            mean_cost_usd_per_market=float(sub["cost"].mean()),
            by_category=by_category,
        )
    return out


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def summary_table(metrics: dict[str, ConfigMetrics]) -> pd.DataFrame:
    """Produce the leaderboard table (paper §6.2 analogue)."""
    rows = []
    for cm in metrics.values():
        rows.append(
            {
                "config": cm.config_name,
                "n": cm.n_markets,
                "brier": cm.mean_brier,
                "alpha": cm.mean_alpha,
                "alpha_sem": cm.sem_alpha,
                "UNC": cm.murphy.uncertainty,
                "REL": cm.murphy.reliability,
                "RES": cm.murphy.resolution,
                "tokens_per_market": cm.mean_tokens_per_market,
                "cost_usd_per_market": cm.mean_cost_usd_per_market,
            }
        )
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values("brier")
    return df


def plot_signatures(
    metrics: dict[str, ConfigMetrics],
    output_path: str | Path = "rel_res.png",
    market_baseline: dict[str, float] | None = None,
) -> None:
    """
    Render the central figure: REL x RES scatter (analogue of Figure 3 of the
    paper, but with observed values rather than predicted positions).

    If `market_baseline` is provided as {"REL": x, "RES": y}, plots an "M" marker.
    """
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7.0, 5.0))
    cmap = {
        "independent_ensemble": "#5B8DEF",
        "peer_critique_debate": "#E25C5C",
        "orchestrator_specialist": "#E68A2E",
        "sequential_pipeline": "#5BB85B",
        "consensus_alignment": "#9D5BCB",
    }
    label_short = {
        "independent_ensemble": "IE",
        "peer_critique_debate": "PC",
        "orchestrator_specialist": "OS",
        "sequential_pipeline": "SP",
        "consensus_alignment": "CA",
    }

    for name, cm in metrics.items():
        color = cmap.get(name, "#444444")
        short = label_short.get(name, name[:3].upper())
        ax.scatter(
            cm.murphy.resolution,
            cm.murphy.reliability,
            s=180,
            c=color,
            edgecolors="black",
            linewidths=0.8,
            label=name.replace("_", " "),
            zorder=3,
        )
        ax.annotate(
            short,
            (cm.murphy.resolution, cm.murphy.reliability),
            ha="center",
            va="center",
            fontsize=8,
            zorder=4,
        )

    if market_baseline is not None:
        ax.scatter(
            market_baseline["RES"],
            market_baseline["REL"],
            s=200,
            c="lightgray",
            edgecolors="black",
            linewidths=0.8,
            zorder=2,
        )
        ax.annotate(
            "M",
            (market_baseline["RES"], market_baseline["REL"]),
            ha="center",
            va="center",
            fontsize=8,
            zorder=4,
        )

    ax.set_xlabel("RES (resolution, ↑ better)")
    ax.set_ylabel("REL (reliability error, ↓ better)")
    ax.set_title("Observed Murphy-decomposition signatures by configuration")
    ax.grid(True, alpha=0.3)
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9)
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("results", help="Path to results JSON")
    parser.add_argument(
        "--synthetic-outcomes",
        action="store_true",
        help="Inject synthetic outcomes (for pipeline testing only)",
    )
    parser.add_argument("--plot", help="Output path for REL x RES scatter PNG")
    parser.add_argument("--table", help="Output path for summary CSV")
    parser.add_argument("--n-bins", type=int, default=10, help="Murphy bin count")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    records = load_results(
        args.results,
        inject_synthetic_outcomes=args.synthetic_outcomes,
        seed=args.seed,
    )
    metrics = compute_metrics(records, n_bins=args.n_bins)

    if not metrics:
        print("No resolved markets to score.")
        return

    table = summary_table(metrics)
    print(table.to_string(index=False))

    if args.table:
        table.to_csv(args.table, index=False)
        print(f"\nWrote {args.table}")
    if args.plot:
        plot_signatures(metrics, output_path=args.plot)
        print(f"Wrote {args.plot}")


if __name__ == "__main__":
    main()
