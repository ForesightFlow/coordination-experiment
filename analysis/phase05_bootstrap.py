"""
Bootstrap and power-projection analysis for the coordination experiment.

This script extends the Phase 0.5 analysis with three procedures that extract
maximum information from the existing 100-market sample without requiring new
LLM calls:

  1. Bootstrap distributions for the per-pair Brier difference (10 pairs).
  2. Required-n curves: for each pair and observed effect size, the sample size
     needed to reach Bonferroni-corrected significance (alpha = 0.005, power = 0.80).
  3. Type-S and Type-M error analysis (Gelman & Carlin 2014): even when a result
     is "statistically significant", what is the probability the sign is wrong
     (S-error) and how inflated is the magnitude estimate (M-error)?

The methodology is standard observational power analysis (Cohen 1988) adapted
for paired-design effect-size estimation. It is not a simulation of LLM responses
- the resampling is done on observed per-market squared errors, which is the
  resampling unit appropriate for the paired comparisons in the paper.

Usage:
    python3 phase05_bootstrap.py \\
        --results-json results-validation-05.json \\
        --outdir analysis/phase05_bootstrap/ \\
        --n-bootstrap 10000 \\
        --seed 42
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
# Data loading
# ---------------------------------------------------------------------------

def load_squared_errors(path: Path) -> dict[str, dict[int, float]]:
    """Return {config_name: {market_index: squared_error}} for all successes."""
    with open(path) as f:
        data = json.load(f)
    out: dict[str, dict[int, float]] = defaultdict(dict)
    for r in data:
        cfg = r["configName"]
        for m in r["markets"]:
            if m.get("_failure") or m.get("outcome") is None:
                continue
            sq = (float(m["probability"]) - int(m["outcome"])) ** 2
            out[cfg][int(m["marketIndex"])] = sq
    return dict(out)


# ---------------------------------------------------------------------------
# Bootstrap of pairwise Brier differences
# ---------------------------------------------------------------------------

def bootstrap_pair_diff(
    a: np.ndarray, b: np.ndarray, n_bootstrap: int, rng: np.random.Generator,
) -> dict:
    """
    Paired bootstrap: resample (a_i, b_i) tuples with replacement, recompute
    mean(b - a). Returns the bootstrap distribution and key quantiles.

    Positive value of (mean_b - mean_a) means a has lower mean squared error
    (i.e., config_a is better).
    """
    assert len(a) == len(b), "paired samples must have equal length"
    n = len(a)
    diffs = b - a  # observed paired differences
    observed = float(diffs.mean())

    # Standard paired bootstrap: resample indices with replacement
    indices = rng.integers(0, n, size=(n_bootstrap, n))
    boot_means = diffs[indices].mean(axis=1)

    return {
        "observed": observed,
        "boot_mean": float(boot_means.mean()),
        "boot_std": float(boot_means.std(ddof=1)),
        "ci90_lo": float(np.quantile(boot_means, 0.05)),
        "ci90_hi": float(np.quantile(boot_means, 0.95)),
        "ci95_lo": float(np.quantile(boot_means, 0.025)),
        "ci95_hi": float(np.quantile(boot_means, 0.975)),
        "ci99_lo": float(np.quantile(boot_means, 0.005)),
        "ci99_hi": float(np.quantile(boot_means, 0.995)),
        "p_above_zero": float((boot_means > 0).mean()),
        "boot_distribution": boot_means,  # kept for downstream plots
    }


def all_pairs_bootstrap(
    errors: dict[str, dict[int, float]],
    n_bootstrap: int = 10000,
    seed: int = 42,
) -> pd.DataFrame:
    """Bootstrap every pair of configs over their common scored markets."""
    rng = np.random.default_rng(seed)
    configs = sorted(errors.keys())
    common = sorted(set.intersection(*[set(errors[c].keys()) for c in configs]))
    if not common:
        raise ValueError("No common scored markets across all configs.")

    rows = []
    for i, ca in enumerate(configs):
        for cb in configs[i + 1:]:
            a = np.array([errors[ca][m] for m in common])
            b = np.array([errors[cb][m] for m in common])
            r = bootstrap_pair_diff(a, b, n_bootstrap, rng)
            rows.append({
                "config_a": ca,
                "config_b": cb,
                "n_paired": len(common),
                "observed_diff": r["observed"],
                "bootstrap_se": r["boot_std"],
                "ci90_lo": r["ci90_lo"],
                "ci90_hi": r["ci90_hi"],
                "ci95_lo": r["ci95_lo"],
                "ci95_hi": r["ci95_hi"],
                "ci99_lo": r["ci99_lo"],
                "ci99_hi": r["ci99_hi"],
                "p_a_better": r["p_above_zero"],
            })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Required-n analysis under observed effect size
# ---------------------------------------------------------------------------

def required_n_curve(
    a: np.ndarray, b: np.ndarray,
    alpha_targets: tuple[float, ...] = (0.05, 0.005, 0.001),
    power: float = 0.80,
) -> pd.DataFrame:
    """
    For a paired design with observed mean and std of differences, compute
    the sample size n required to detect the observed effect at each alpha
    target, holding observed (effect / std) constant.

    Uses the standard formula:
        n >= ((z_{1-alpha/2} + z_{power}) / (effect / std))^2

    For paired design the std is std of (b - a). Two-sided test assumed.
    """
    diffs = b - a
    effect = float(np.abs(diffs.mean()))
    sd = float(diffs.std(ddof=1))
    if effect == 0:
        # No effect to detect; required n is infinity.
        return pd.DataFrame([
            {"alpha": a, "n_required": float("inf")} for a in alpha_targets
        ])
    z_pow = stats.norm.ppf(power)
    rows = []
    for alpha in alpha_targets:
        z_alpha = stats.norm.ppf(1 - alpha / 2)
        n = ((z_alpha + z_pow) / (effect / sd)) ** 2
        rows.append({
            "alpha": alpha,
            "n_required": int(np.ceil(n)),
            "observed_effect": effect,
            "observed_diff_sd": sd,
            "effect_per_sd": effect / sd,
        })
    return pd.DataFrame(rows)


def all_pairs_required_n(
    errors: dict[str, dict[int, float]],
) -> pd.DataFrame:
    configs = sorted(errors.keys())
    common = sorted(set.intersection(*[set(errors[c].keys()) for c in configs]))
    rows = []
    for i, ca in enumerate(configs):
        for cb in configs[i + 1:]:
            a = np.array([errors[ca][m] for m in common])
            b = np.array([errors[cb][m] for m in common])
            n_table = required_n_curve(a, b)
            for _, row in n_table.iterrows():
                rows.append({
                    "config_a": ca,
                    "config_b": cb,
                    "alpha": row["alpha"],
                    "n_required": row["n_required"],
                    "observed_diff": float(np.abs((b - a).mean())),
                })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Type-S and Type-M errors (Gelman & Carlin 2014)
# ---------------------------------------------------------------------------

def type_s_m_errors(
    observed_effect: float, se: float,
    n_simulations: int = 100000, alpha: float = 0.05,
    rng: np.random.Generator | None = None,
) -> dict:
    """
    Gelman & Carlin (2014): given an estimated effect of magnitude
    `observed_effect` with standard error `se`, simulate from a normal
    distribution centered at observed_effect with std=se. Among "significant"
    estimates (|estimate| / se > z_{1-alpha/2}):
        - Type-S error rate: probability sign is wrong
        - Type-M error: ratio of |estimate| / |true effect|, averaged

    This works as a sensitivity diagnostic: if you're confident in your
    point estimate, what would future replications look like?

    Returns dict with type_s, type_m, n_significant_in_simulation.
    """
    if rng is None:
        rng = np.random.default_rng(42)
    if observed_effect == 0:
        return {"type_s": float("nan"), "type_m": float("nan"),
                "n_significant": 0}

    # Treat the observed effect as the "true" effect for the sensitivity
    # analysis (this is the conservative interpretation of Gelman-Carlin).
    true_effect = observed_effect
    z_crit = stats.norm.ppf(1 - alpha / 2)
    estimates = rng.normal(true_effect, se, n_simulations)
    z_scores = np.abs(estimates) / se
    sig_mask = z_scores > z_crit
    n_sig = int(sig_mask.sum())
    if n_sig == 0:
        return {"type_s": float("nan"), "type_m": float("nan"),
                "n_significant": 0}

    sig_estimates = estimates[sig_mask]
    type_s = float(np.mean(np.sign(sig_estimates) != np.sign(true_effect)))
    type_m = float(np.mean(np.abs(sig_estimates) / np.abs(true_effect)))
    return {
        "type_s": type_s,
        "type_m": type_m,
        "n_significant": n_sig,
        "n_simulations": n_simulations,
    }


def all_pairs_type_s_m(
    bootstrap_df: pd.DataFrame, alpha: float = 0.05, seed: int = 42,
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for _, row in bootstrap_df.iterrows():
        result = type_s_m_errors(
            row["observed_diff"], row["bootstrap_se"], alpha=alpha, rng=rng,
        )
        rows.append({
            "config_a": row["config_a"],
            "config_b": row["config_b"],
            "observed_diff": row["observed_diff"],
            "se": row["bootstrap_se"],
            "type_s": result["type_s"],
            "type_m": result["type_m"],
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Visualisation
# ---------------------------------------------------------------------------

def plot_bootstrap_distributions(
    errors: dict[str, dict[int, float]], outdir: Path,
    n_bootstrap: int = 10000, seed: int = 42,
):
    """Forest plot: bootstrap CIs for every pairwise Brier difference."""
    rng = np.random.default_rng(seed)
    configs = sorted(errors.keys())
    common = sorted(set.intersection(*[set(errors[c].keys()) for c in configs]))

    pairs_data = []
    for i, ca in enumerate(configs):
        for cb in configs[i + 1:]:
            a = np.array([errors[ca][m] for m in common])
            b = np.array([errors[cb][m] for m in common])
            r = bootstrap_pair_diff(a, b, n_bootstrap, rng)
            pairs_data.append({
                "label": f"{ca[:18]} - {cb[:18]}",
                "obs": r["observed"],
                "ci95": (r["ci95_lo"], r["ci95_hi"]),
                "ci99": (r["ci99_lo"], r["ci99_hi"]),
            })

    pairs_data.sort(key=lambda x: x["obs"])

    fig, ax = plt.subplots(figsize=(9, 6))
    y_pos = np.arange(len(pairs_data))
    obs = [p["obs"] for p in pairs_data]
    ci99_lo = [p["ci99"][0] for p in pairs_data]
    ci99_hi = [p["ci99"][1] for p in pairs_data]
    ci95_lo = [p["ci95"][0] for p in pairs_data]
    ci95_hi = [p["ci95"][1] for p in pairs_data]

    # 99% CI (thin)
    ax.errorbar(
        obs, y_pos,
        xerr=[np.array(obs) - ci99_lo, ci99_hi - np.array(obs)],
        fmt="none", elinewidth=1, color="gray", alpha=0.5, capsize=3,
    )
    # 95% CI (thicker)
    ax.errorbar(
        obs, y_pos,
        xerr=[np.array(obs) - ci95_lo, ci95_hi - np.array(obs)],
        fmt="none", elinewidth=2.5, color="black", capsize=0,
    )
    ax.scatter(obs, y_pos, s=80, c="#5B8DEF", edgecolors="black",
               linewidths=0.8, zorder=5)
    ax.axvline(0, color="red", linewidth=1, linestyle="--", alpha=0.6,
               label="zero-effect line")

    ax.set_yticks(y_pos)
    ax.set_yticklabels([p["label"] for p in pairs_data], fontsize=8)
    ax.set_xlabel("Brier difference (config_b − config_a)\n"
                  "positive = config_a is better")
    ax.set_title("Bootstrap distributions of pairwise Brier differences\n"
                 f"(95% inner / 99% outer CIs from {n_bootstrap} resamples, "
                 f"n={len(common)})")
    ax.grid(True, alpha=0.3, axis="x")
    ax.legend(loc="lower right", fontsize=8)
    fig.tight_layout()
    fig.savefig(outdir / "fig_bootstrap_pairwise.png", dpi=150,
                bbox_inches="tight")
    plt.close(fig)


def plot_required_n(required_n_df: pd.DataFrame, outdir: Path):
    """Heatmap-style bar chart: required n for each pair at three alpha levels."""
    pivot = required_n_df.pivot_table(
        index=["config_a", "config_b"],
        columns="alpha",
        values="n_required",
    )
    # Sort by alpha=0.005 column descending (hardest pairs at top)
    pivot = pivot.sort_values(by=0.005, ascending=False)

    fig, ax = plt.subplots(figsize=(9, 6))
    labels = [f"{a[:18]} vs {b[:18]}" for a, b in pivot.index]
    y_pos = np.arange(len(labels))
    width = 0.27
    colors = {"0.05": "#5B8DEF", "0.005": "#E68A2E", "0.001": "#9D5BCB"}
    for i, alpha in enumerate([0.05, 0.005, 0.001]):
        if alpha not in pivot.columns:
            continue
        values = pivot[alpha].values
        # Cap at 50000 for visualisation
        capped = np.minimum(values, 50000)
        ax.barh(y_pos + (i - 1) * width, capped, width,
                label=f"α = {alpha}", color=colors[str(alpha)],
                edgecolor="black", linewidth=0.5)
        # Annotate actual values
        for j, v in enumerate(values):
            x = capped[j]
            ax.text(x + 200, y_pos[j] + (i - 1) * width,
                    f"{int(v):,}" if v < 50000 else f">{int(v):,}",
                    va="center", fontsize=7)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlabel("Required sample size n (capped at 50,000 for display)")
    ax.set_title("Sample size required to resolve each pair at given α "
                 "(power = 0.80, two-sided paired test)")
    ax.axvline(100, color="red", linewidth=1, linestyle="--", alpha=0.5)
    ax.text(110, len(labels) - 0.5, "n=100\n(current)", fontsize=8, color="red")
    ax.legend(loc="lower right", fontsize=9)
    ax.grid(True, alpha=0.3, axis="x")
    fig.tight_layout()
    fig.savefig(outdir / "fig_required_n.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--results-json", type=Path, required=True)
    p.add_argument("--outdir", type=Path, default=Path("analysis/phase05_bootstrap"))
    p.add_argument("--n-bootstrap", type=int, default=10000)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)

    print(f"Loading from {args.results_json}...")
    errors = load_squared_errors(args.results_json)
    common = sorted(set.intersection(*[set(v.keys()) for v in errors.values()]))
    print(f"  {len(errors)} configs, {len(common)} common scored markets")
    print()

    # === Bootstrap ===
    print(f"[1/4] Bootstrap pairwise Brier differences "
          f"({args.n_bootstrap} resamples)...")
    boot_df = all_pairs_bootstrap(errors, args.n_bootstrap, args.seed)
    boot_df = boot_df.sort_values("observed_diff", key=np.abs, ascending=False)
    boot_df.to_csv(args.outdir / "table_bootstrap_pairs.csv", index=False)

    with open(args.outdir / "table_bootstrap_pairs.txt", "w") as f:
        f.write("Bootstrap pairwise Brier differences\n")
        f.write("=" * 80 + "\n")
        f.write("Positive observed_diff means config_a has LOWER Brier "
                "(is better) on the paired sample.\n\n")
        f.write(f"n_paired = {boot_df['n_paired'].iloc[0]}\n")
        f.write(f"n_bootstrap = {args.n_bootstrap}\n\n")
        cols = ["config_a", "config_b", "observed_diff", "bootstrap_se",
                "ci95_lo", "ci95_hi", "ci99_lo", "ci99_hi", "p_a_better"]
        f.write(boot_df[cols].round(4).to_string(index=False))
    print(boot_df[["config_a", "config_b", "observed_diff",
                   "ci95_lo", "ci95_hi", "p_a_better"]].round(4).to_string(index=False))
    print()

    plot_bootstrap_distributions(errors, args.outdir,
                                  args.n_bootstrap, args.seed)
    print(f"  wrote fig_bootstrap_pairwise.png")
    print()

    # === Required n ===
    print("[2/4] Required-n curves for each pair...")
    n_req = all_pairs_required_n(errors)
    n_req.to_csv(args.outdir / "table_required_n.csv", index=False)

    with open(args.outdir / "table_required_n.txt", "w") as f:
        f.write("Required sample size n to detect the observed effect "
                "at each alpha\n")
        f.write("=" * 80 + "\n")
        f.write("Power = 0.80, two-sided paired test, std assumed stable.\n")
        f.write("Bonferroni-corrected alpha across 10 pairs = 0.005.\n\n")
        pivot = n_req.pivot_table(index=["config_a", "config_b"],
                                   columns="alpha", values="n_required")
        f.write(pivot.to_string())
    print(pivot.to_string())
    print()

    plot_required_n(n_req, args.outdir)
    print(f"  wrote fig_required_n.png")
    print()

    # === Type S / M ===
    print("[3/4] Type-S and Type-M error analysis (Gelman & Carlin 2014)...")
    sm_df = all_pairs_type_s_m(boot_df, alpha=0.05, seed=args.seed)
    sm_df.to_csv(args.outdir / "table_type_s_m.csv", index=False)

    with open(args.outdir / "table_type_s_m.txt", "w") as f:
        f.write("Type-S (sign error) and Type-M (magnitude error) for each "
                "pair\n")
        f.write("=" * 80 + "\n")
        f.write("Both computed at alpha=0.05 conditional on detection.\n")
        f.write("Type-S: probability of getting the wrong sign.\n")
        f.write("Type-M: average |detected| / |true|. >1 means inflation.\n\n")
        f.write(sm_df.round(4).to_string(index=False))
    print(sm_df.round(4).to_string(index=False))
    print()

    # === Sensitivity ===
    print("[4/4] Effect-size sensitivity (50% smaller / 50% larger)...")
    sens_rows = []
    for _, row in boot_df.iterrows():
        for scale, label in [(0.5, "half"), (1.0, "observed"), (1.5, "1.5x")]:
            effect = row["observed_diff"] * scale
            sd = row["bootstrap_se"] * np.sqrt(row["n_paired"])
            if effect == 0:
                n_req_a = float("inf")
            else:
                z_alpha = stats.norm.ppf(1 - 0.005 / 2)
                z_pow = stats.norm.ppf(0.80)
                n_req_a = int(np.ceil(((z_alpha + z_pow) / (effect / sd)) ** 2))
            sens_rows.append({
                "config_a": row["config_a"],
                "config_b": row["config_b"],
                "effect_scale": label,
                "effect_value": effect,
                "n_required_alpha_005": n_req_a,
            })
    sens_df = pd.DataFrame(sens_rows)
    sens_df.to_csv(args.outdir / "table_sensitivity.csv", index=False)

    with open(args.outdir / "table_sensitivity.txt", "w") as f:
        f.write("Sensitivity of required n to assumed effect size\n")
        f.write("=" * 80 + "\n")
        f.write("If true effect is half / observed / 1.5x of observed,\n")
        f.write("how much data is needed at Bonferroni-corrected alpha=0.005?\n\n")
        pivot = sens_df.pivot_table(
            index=["config_a", "config_b"],
            columns="effect_scale",
            values="n_required_alpha_005",
        )
        f.write(pivot.to_string())
    print(pivot.to_string())
    print()

    print(f"\nAll outputs written to {args.outdir.resolve()}")


if __name__ == "__main__":
    main()
