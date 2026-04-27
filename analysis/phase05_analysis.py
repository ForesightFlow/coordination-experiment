"""
Phase 0.5 follow-up analysis bundle.

Runs analyses 2–6 from the post-Phase-0.5 plan, plus a redraw of
Figure 4 (REL×RES scatter) with the legend placed outside the plot
so it cannot occlude any data points.

Inputs:
    --results-json path to results-validation-05.json (required)
    --fixture-jsonl path to data/fixture_phase05.jsonl
                    (optional but enables per-category analysis,
                    since results JSON does not embed category)
    --outdir directory for figures and tables (default: ./phase05_analysis)

Outputs (in --outdir):
    fig4_rel_res_redraw.png          — Figure 4 with legend outside
    table_per_category_brier.csv      — analysis 2
    table_per_category_brier.txt      — same, human-readable
    fig5_pareto.png                   — analysis 3
    table_pairwise_ttest.csv          — analysis 4
    table_pairwise_ttest.txt          — same, human-readable
    table_top_disagreements.txt       — analysis 5 (top 10 disagreements)
    table_role_tokens.csv             — analysis 6
    table_role_tokens.txt             — same, human-readable

Run:
    python3 phase05_analysis.py \
        --results-json results-validation-05.json \
        --fixture-jsonl data/fixture_phase05.jsonl \
        --outdir phase05_analysis/
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import stats


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_results(path: Path) -> list[dict]:
    """One row per (config, market) successful prediction."""
    with open(path) as f:
        data = json.load(f)
    rows = []
    for r in data:
        for m in r["markets"]:
            if m.get("_failure"):
                continue
            rows.append({
                "config": r["configName"],
                "market_index": m["marketIndex"],
                "question": m["question"],
                "p": float(m["probability"]),
                "y": int(m["outcome"]) if m.get("outcome") is not None else None,
                "baseline": m.get("baseline"),
                "tokens": m["trace"]["totalTokens"],
                "cost": m["trace"].get("totalCostUsd", 0.0),
                "n_calls": len(m["trace"].get("calls", [])),
                "calls": m["trace"].get("calls", []),
            })
    return [r for r in rows if r["y"] is not None]


def load_categories(jsonl_path: Path) -> dict[int, str]:
    """Map market_index → category from the fixture JSONL.
    The fixture is line-ordered; market_index is the line number (0-based)."""
    out: dict[int, str] = {}
    with open(jsonl_path) as f:
        for i, line in enumerate(f):
            row = json.loads(line)
            out[i] = row.get("category", "unknown")
    return out


# ---------------------------------------------------------------------------
# Figure 4 — REL×RES scatter with external legend
# ---------------------------------------------------------------------------

CONFIG_COLORS = {
    "independent_ensemble":    "#5B8DEF",
    "peer_critique_debate":    "#E25C5C",
    "orchestrator_specialist": "#E68A2E",
    "sequential_pipeline":     "#5BB85B",
    "consensus_alignment":     "#9D5BCB",
}
CONFIG_SHORT = {
    "independent_ensemble":    "IE",
    "peer_critique_debate":    "PC",
    "orchestrator_specialist": "OS",
    "sequential_pipeline":     "SP",
    "consensus_alignment":     "CA",
}


def murphy_decompose(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = 10):
    """Brier = UNC + REL - RES, with K probability-decile bins."""
    o_bar = float(outcomes.mean())
    uncertainty = o_bar * (1 - o_bar)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    bin_idx = np.clip(np.digitize(probs, edges, right=False) - 1, 0, n_bins - 1)
    rel = res = 0.0
    for k in range(n_bins):
        mask = bin_idx == k
        n_k = int(mask.sum())
        if n_k == 0:
            continue
        p_bar = float(probs[mask].mean())
        o_bar_k = float(outcomes[mask].mean())
        rel += n_k * (p_bar - o_bar_k) ** 2
        res += n_k * (o_bar_k - o_bar) ** 2
    rel /= len(probs)
    res /= len(probs)
    return uncertainty, rel, res


def fig4_redraw(rows: list[dict], outdir: Path) -> None:
    df = pd.DataFrame(rows)
    fig, ax = plt.subplots(figsize=(8.5, 5.5))

    points = []
    for cfg, sub in df.groupby("config"):
        _, rel, res = murphy_decompose(sub["p"].to_numpy(), sub["y"].to_numpy(dtype=float))
        points.append((cfg, res, rel))

    for cfg, res, rel in points:
        ax.scatter(
            res, rel, s=260, c=CONFIG_COLORS.get(cfg, "#444"),
            edgecolors="black", linewidths=0.8, zorder=3,
        )
        ax.annotate(
            CONFIG_SHORT.get(cfg, cfg[:3].upper()),
            (res, rel), ha="center", va="center", fontsize=8.5, zorder=4,
        )

    ax.set_xlabel("RES (resolution, ↑ better)")
    ax.set_ylabel("REL (reliability error, ↓ better)")
    ax.set_title("Observed Murphy-decomposition signatures (Phase 0.5, n=100)")
    ax.grid(True, alpha=0.3)

    # Legend OUTSIDE the plot, on the right.
    legend_handles = [
        plt.Line2D(
            [], [], marker="o", linestyle="",
            markerfacecolor=CONFIG_COLORS[c], markeredgecolor="black",
            markersize=11, label=c.replace("_", " "),
        )
        for c in CONFIG_COLORS
        if c in {p[0] for p in points}
    ]
    ax.legend(handles=legend_handles, loc="center left",
              bbox_to_anchor=(1.02, 0.5), borderaxespad=0., fontsize=9)
    fig.subplots_adjust(right=0.72)

    out = outdir / "fig4_rel_res_redraw.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  wrote {out}")


# ---------------------------------------------------------------------------
# Analysis 2 — Per-category Brier
# ---------------------------------------------------------------------------

def per_category_brier(rows: list[dict], categories: dict[int, str], outdir: Path) -> None:
    df = pd.DataFrame(rows)
    df["category"] = df["market_index"].map(categories).fillna("unknown")

    pivot = df.groupby(["config", "category"]).apply(
        lambda g: float(((g["p"] - g["y"]) ** 2).mean())
    ).unstack().round(4)

    # Add overall column
    pivot["overall"] = df.groupby("config").apply(
        lambda g: float(((g["p"] - g["y"]) ** 2).mean())
    ).round(4)

    # Sort columns: categories alphabetical then 'overall'
    cat_cols = [c for c in pivot.columns if c != "overall"]
    pivot = pivot[sorted(cat_cols) + ["overall"]]
    # Sort rows by overall Brier
    pivot = pivot.sort_values("overall")

    pivot.to_csv(outdir / "table_per_category_brier.csv")
    with open(outdir / "table_per_category_brier.txt", "w") as f:
        f.write("Per-(config, category) Brier scores (lower is better)\n")
        f.write("=" * 60 + "\n\n")
        f.write(pivot.to_string())
        f.write("\n\nN by category:\n")
        f.write(df["category"].value_counts().sort_index().to_string())
    print(f"  wrote table_per_category_brier.{{csv,txt}}")
    print()
    print(pivot.to_string())


# ---------------------------------------------------------------------------
# Analysis 3 — Pareto frontier
# ---------------------------------------------------------------------------

def pareto_frontier(rows: list[dict], outdir: Path) -> None:
    df = pd.DataFrame(rows)
    summary = df.groupby("config").agg(
        brier=("p", lambda s: float(((s - df.loc[s.index, "y"]) ** 2).mean())),
        cost_per_market=("cost", "mean"),
        n=("p", "count"),
    ).reset_index()

    fig, ax = plt.subplots(figsize=(8.5, 5.5))
    for _, row in summary.iterrows():
        c = CONFIG_COLORS.get(row["config"], "#444")
        ax.scatter(row["cost_per_market"], row["brier"], s=260,
                   c=c, edgecolors="black", linewidths=0.8, zorder=3)
        ax.annotate(
            row["config"].replace("_", " "),
            (row["cost_per_market"], row["brier"]),
            xytext=(10, 0), textcoords="offset points",
            fontsize=9, va="center",
        )

    # Pareto frontier line: points that are not dominated
    pts = summary.sort_values("cost_per_market").reset_index(drop=True)
    pareto = []
    best_brier = float("inf")
    for _, p in pts.iterrows():
        if p["brier"] < best_brier:
            pareto.append((p["cost_per_market"], p["brier"]))
            best_brier = p["brier"]
    if len(pareto) >= 2:
        xs, ys = zip(*pareto)
        ax.plot(xs, ys, "k--", alpha=0.4, linewidth=1.2, zorder=2,
                label="Pareto frontier")
        ax.legend(loc="lower right", fontsize=9)

    ax.set_xlabel("Cost per market (USD)")
    ax.set_ylabel("Brier score (lower is better)")
    ax.set_title("Cost-quality Pareto frontier (Phase 0.5, n=100 per config)")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    out = outdir / "fig5_pareto.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  wrote {out}")


# ---------------------------------------------------------------------------
# Analysis 4 — Pairwise paired t-test
# ---------------------------------------------------------------------------

def pairwise_t(rows: list[dict], outdir: Path) -> None:
    """Paired t-test on per-market squared errors across configs."""
    by_market: dict[int, dict[str, float]] = defaultdict(dict)
    for r in rows:
        by_market[r["market_index"]][r["config"]] = (r["p"] - r["y"]) ** 2

    configs = sorted({r["config"] for r in rows})
    common = [m for m, d in by_market.items() if all(c in d for c in configs)]

    print(f"  Common scored markets across all configs: {len(common)}")
    if len(common) < 30:
        print("  Too few common markets for stable paired t-tests.")

    table = []
    for i, ca in enumerate(configs):
        for cb in configs[i + 1:]:
            a = np.array([by_market[m][ca] for m in common])
            b = np.array([by_market[m][cb] for m in common])
            diff = b - a  # positive => ca is better (lower squared error)
            t_stat, p_val = stats.ttest_rel(a, b)
            table.append({
                "config_a": ca,
                "config_b": cb,
                "mean_brier_a": float(a.mean()),
                "mean_brier_b": float(b.mean()),
                "mean_diff_b_minus_a": float(diff.mean()),
                "diff_sem": float(diff.std(ddof=1) / np.sqrt(len(diff))),
                "t_statistic": float(t_stat),
                "p_value": float(p_val),
                "n_paired": len(common),
            })

    df = pd.DataFrame(table).sort_values("p_value")
    df.to_csv(outdir / "table_pairwise_ttest.csv", index=False)

    with open(outdir / "table_pairwise_ttest.txt", "w") as f:
        f.write("Pairwise paired t-tests on per-market squared errors\n")
        f.write("=" * 80 + "\n")
        f.write("Positive mean_diff means config_a has LOWER Brier than config_b\n")
        f.write("(i.e. config_a is better on this paired sample).\n\n")
        f.write(f"Common scored markets: {len(common)}\n\n")
        f.write(f"{'config_a':<25} {'config_b':<25} {'Δbrier':>9} {'t':>7} {'p':>9} {'sig':>6}\n")
        f.write("-" * 86 + "\n")
        for _, row in df.iterrows():
            sig = "***" if row["p_value"] < 0.001 else \
                  "**"  if row["p_value"] < 0.01 else \
                  "*"   if row["p_value"] < 0.05 else \
                  ""
            f.write(
                f"{row['config_a']:<25} {row['config_b']:<25} "
                f"{row['mean_diff_b_minus_a']:>+9.4f} "
                f"{row['t_statistic']:>+7.2f} "
                f"{row['p_value']:>9.4f}  {sig:>4}\n"
            )
        # Bonferroni line
        f.write("\nBonferroni-corrected α=0.05 across "
                f"{len(df)} pairs: each test must have p<{0.05/len(df):.4f}\n")
    print(f"  wrote table_pairwise_ttest.{{csv,txt}}")
    print()
    print(df.to_string(index=False))


# ---------------------------------------------------------------------------
# Analysis 5 — Top disagreements
# ---------------------------------------------------------------------------

def top_disagreements(rows: list[dict], outdir: Path, top_n: int = 10) -> None:
    by_market: dict[int, dict] = {}
    for r in rows:
        idx = r["market_index"]
        info = by_market.setdefault(idx, {
            "question": r["question"],
            "baseline": r["baseline"],
            "outcome": r["y"],
            "configs": {},
        })
        info["configs"][r["config"]] = r["p"]

    ranked = []
    for idx, info in by_market.items():
        if len(info["configs"]) < 5:
            continue
        probs = list(info["configs"].values())
        ranked.append((idx, float(np.std(probs)), info))
    ranked.sort(key=lambda x: -x[1])

    out_path = outdir / "table_top_disagreements.txt"
    with open(out_path, "w") as f:
        f.write(f"Top {top_n} markets by inter-config probability stdev\n")
        f.write("=" * 80 + "\n\n")
        for idx, sd, info in ranked[:top_n]:
            f.write(
                f"market {idx}  stdev={sd:.3f}  "
                f"baseline={info['baseline']:.3f}  outcome={info['outcome']}\n"
            )
            f.write(f"  Q: {info['question'][:90]}\n")
            for c in sorted(info["configs"]):
                f.write(f"    {c:<25} {info['configs'][c]:.3f}\n")
            f.write("\n")
    print(f"  wrote {out_path}")
    # Print first 3 to stdout for quick scan
    for idx, sd, info in ranked[:3]:
        print(f"  example: market {idx} stdev={sd:.3f}  Q: {info['question'][:60]}")


# ---------------------------------------------------------------------------
# Analysis 6 — Per-role token breakdown
# ---------------------------------------------------------------------------

def role_token_breakdown(rows: list[dict], outdir: Path) -> None:
    role_stats = defaultdict(lambda: {
        "calls": 0, "in_tokens": 0, "out_tokens": 0, "cost": 0.0,
    })
    for r in rows:
        for c in r["calls"]:
            role = c["agentRole"]
            u = c.get("usage", {})
            role_stats[role]["calls"] += 1
            role_stats[role]["in_tokens"] += int(u.get("promptTokens", 0))
            role_stats[role]["out_tokens"] += int(u.get("completionTokens", 0))
            role_stats[role]["cost"] += float(c.get("costUsd") or 0.0)

    df = pd.DataFrame([
        {
            "role": role,
            "calls": s["calls"],
            "total_in_tokens": s["in_tokens"],
            "total_out_tokens": s["out_tokens"],
            "in_per_call": s["in_tokens"] / max(s["calls"], 1),
            "out_per_call": s["out_tokens"] / max(s["calls"], 1),
            "out_in_ratio": s["out_tokens"] / max(s["in_tokens"], 1),
            "total_cost_usd": s["cost"],
            "cost_per_call_usd": s["cost"] / max(s["calls"], 1),
        }
        for role, s in role_stats.items()
    ]).sort_values("total_cost_usd", ascending=False)

    df.to_csv(outdir / "table_role_tokens.csv", index=False)
    with open(outdir / "table_role_tokens.txt", "w") as f:
        f.write("Token consumption breakdown by agent role\n")
        f.write("=" * 80 + "\n\n")
        f.write(df.round(2).to_string(index=False))
    print(f"  wrote table_role_tokens.{{csv,txt}}")
    print()
    print(df.round(2).to_string(index=False))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--results-json", type=Path, required=True)
    p.add_argument("--fixture-jsonl", type=Path, default=None)
    p.add_argument("--outdir", type=Path, default=Path("phase05_analysis"))
    args = p.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)

    print(f"Loading results from {args.results_json}...")
    rows = load_results(args.results_json)
    print(f"Loaded {len(rows)} successful (config, market) predictions.\n")

    print("[fig4] Redrawing REL×RES scatter (legend outside)...")
    fig4_redraw(rows, args.outdir)
    print()

    if args.fixture_jsonl:
        print(f"[2] Per-category Brier (categories from {args.fixture_jsonl})...")
        cats = load_categories(args.fixture_jsonl)
        per_category_brier(rows, cats, args.outdir)
        print()
    else:
        print("[2] Skipped per-category analysis (no --fixture-jsonl).\n")

    print("[3] Cost-quality Pareto frontier...")
    pareto_frontier(rows, args.outdir)
    print()

    print("[4] Pairwise paired t-tests...")
    pairwise_t(rows, args.outdir)
    print()

    print("[5] Top inter-config disagreements...")
    top_disagreements(rows, args.outdir, top_n=10)
    print()

    print("[6] Per-role token breakdown...")
    role_token_breakdown(rows, args.outdir)
    print()

    print(f"\nAll outputs written to {args.outdir.resolve()}/")


if __name__ == "__main__":
    main()