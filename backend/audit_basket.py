"""
Diagnostic: Momentum Leaders Basket Equity Curve Audit
======================================================
Runs THREE equity curves in parallel to isolate the source of inflated returns:
  1. Dollar-volume weighted (same-quarter) — original formula
  2. Dollar-volume weighted (PREVIOUS quarter) — fixes look-ahead bias
  3. Equal-weighted — baseline with no weighting bias

Usage:
    cd backend && source venv/Scripts/activate && python audit_basket.py
"""

import bisect
import json
from pathlib import Path

import numpy as np
import pandas as pd

# ── Paths ────────────────────────────────────────────────────────────────────
DATA_DIR = Path.home() / "Documents" / "Python_Outputs" / "Data_Storage"
SIGNALS_PATH = DATA_DIR / "signals_500.parquet"
UNIVERSE_PATH = DATA_DIR / "thematic_basket_cache" / "momentum_universes_500.json"
ACTUAL_EQUITY_PATH = DATA_DIR / "thematic_basket_cache" / "Momentum_Leaders_equity_ohlc.parquet"


# ── Helper functions (copied from rotations_original.py) ─────────────────────

def _quarter_end_from_key(key: str) -> pd.Timestamp:
    year_str, q_str = key.split()
    year = int(year_str)
    quarter = int(q_str.replace("Q", ""))
    return pd.Period(f"{year}Q{quarter}").end_time.normalize()


def _quarter_start_from_key(key: str) -> pd.Timestamp:
    year_str, q_str = key.split()
    year = int(year_str)
    quarter = int(q_str.replace("Q", ""))
    return pd.Period(f"{year}Q{quarter}").start_time.normalize()


def _prev_quarter_key(key: str) -> str:
    year_str, q_str = key.split()
    year = int(year_str)
    quarter = int(q_str.replace("Q", ""))
    if quarter == 1:
        return f"{year - 1} Q4"
    return f"{year} Q{quarter - 1}"


def _build_quarter_lookup(universe_by_date):
    quarter_keys = [(k, _quarter_start_from_key(k)) for k in universe_by_date.keys()]
    quarter_keys.sort(key=lambda x: x[1])
    quarter_labels = [k for k, _ in quarter_keys]
    quarter_ends = [dt for _, dt in quarter_keys]
    return quarter_labels, quarter_ends


def _find_active_quarter(d, quarter_labels, quarter_ends):
    idx = bisect.bisect_right(quarter_ends, d) - 1
    if idx < 0:
        return None
    return quarter_labels[idx]


def walk_equity(dates, date_groups, universe_by_date, quarter_labels, quarter_ends,
                quarter_weights):
    """Walk through dates accumulating equity. Returns list of (quarter, equity) tuples."""
    current_weights_series = None
    current_quarter = None
    equity_prev_close = 1.0
    quarter_results = []
    q_start_eq = 1.0
    q_day_count = 0

    for d in dates:
        active_key = _find_active_quarter(d, quarter_labels, quarter_ends)
        if active_key is None:
            continue

        if active_key != current_quarter:
            if current_quarter is not None and q_day_count > 0:
                quarter_results.append((current_quarter, q_start_eq, equity_prev_close))

            current_quarter = active_key
            w_dict = quarter_weights.get(current_quarter, {})
            if not w_dict:
                current_weights_series = None
                continue
            current_weights_series = pd.Series(w_dict)
            q_start_eq = equity_prev_close
            q_day_count = 0

        if current_weights_series is None:
            continue

        day_df = date_groups.get(d)
        if day_df is None or day_df.empty:
            continue
        day_df = day_df[day_df["Ticker"].isin(universe_by_date[current_quarter])]
        if day_df.empty:
            continue

        day_data = day_df.set_index("Ticker")
        common = current_weights_series.index.intersection(day_data.index)
        if len(common) == 0:
            continue
        w = current_weights_series[common]
        c_ret = (w * day_data.loc[common, "Ret"].fillna(0)).sum()
        equity_prev_close = equity_prev_close * (1 + c_ret)
        q_day_count += 1

        # Drift weights
        rets = day_data.loc[common, "Ret"].fillna(0.0)
        updated = w * (1 + rets)
        total = updated.sum()
        if total > 0:
            current_weights_series = updated / total
        else:
            current_weights_series = updated

    # Final quarter
    if current_quarter is not None and q_day_count > 0:
        quarter_results.append((current_quarter, q_start_eq, equity_prev_close))

    return quarter_results, equity_prev_close


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("Loading data...")

    # 1. Load universe
    with open(UNIVERSE_PATH) as f:
        raw = json.load(f)
    universe_by_date = raw["winners"]

    all_tickers = set()
    for tickers in universe_by_date.values():
        all_tickers.update(tickers)
    print(f"  Universe: {len(universe_by_date)} quarters, {len(all_tickers)} unique tickers")

    # 2. Load signals
    df = pd.read_parquet(
        SIGNALS_PATH,
        columns=["Date", "Ticker", "Open", "High", "Low", "Close", "Volume"],
    )
    df["Date"] = pd.to_datetime(df["Date"]).dt.normalize()
    df = df[df["Ticker"].isin(all_tickers)]
    df = df.dropna(subset=["Close"])
    df = df.sort_values(["Ticker", "Date"])
    print(f"  Signals: {len(df):,} rows")

    # 3. Compute returns
    df["Ret"] = df.groupby("Ticker")["Close"].pct_change()
    df["Dollar_Vol"] = df["Close"] * df["Volume"]

    dates = sorted(df["Date"].unique())
    date_groups = {d: g for d, g in df.groupby("Date")}

    # 4. Quarter lookup
    quarter_labels, quarter_ends = _build_quarter_lookup(universe_by_date)

    # 5. Dollar-volume by quarter
    dv_q = (
        df[["Date", "Ticker", "Dollar_Vol"]]
        .dropna(subset=["Dollar_Vol"])
        .groupby(["Ticker", pd.Grouper(key="Date", freq="QE-DEC")])["Dollar_Vol"]
        .mean()
    )

    # ── Build three weight schemes ───────────────────────────────────────────

    # Scheme A: Same-quarter dollar-volume (original — potential look-ahead)
    weights_same_q = {}
    for label in quarter_labels:
        if label not in universe_by_date:
            continue
        tickers = universe_by_date[label]
        ranking_date = _quarter_end_from_key(label)
        w, total = {}, 0.0
        for t in tickers:
            val = dv_q.get((t, ranking_date), np.nan)
            if pd.notna(val) and val > 0:
                w[t] = float(val)
                total += float(val)
        if total > 0:
            weights_same_q[label] = {t: v / total for t, v in w.items()}

    # Scheme B: Previous-quarter dollar-volume (no look-ahead)
    weights_prev_q = {}
    for label in quarter_labels:
        if label not in universe_by_date:
            continue
        tickers = universe_by_date[label]
        prev_key = _prev_quarter_key(label)
        ranking_date = _quarter_end_from_key(prev_key)
        w, total = {}, 0.0
        for t in tickers:
            val = dv_q.get((t, ranking_date), np.nan)
            if pd.notna(val) and val > 0:
                w[t] = float(val)
                total += float(val)
        if total > 0:
            weights_prev_q[label] = {t: v / total for t, v in w.items()}

    # Scheme C: Equal-weight
    weights_equal = {}
    for label in quarter_labels:
        if label not in universe_by_date:
            continue
        tickers = universe_by_date[label]
        n = len(tickers)
        if n > 0:
            weights_equal[label] = {t: 1.0 / n for t in tickers}

    print(f"  Quarters with weights — Same-Q: {len(weights_same_q)}, "
          f"Prev-Q: {len(weights_prev_q)}, Equal: {len(weights_equal)}")
    print()

    # ── Run all three ────────────────────────────────────────────────────────
    print("Running equity curves...")
    res_same, final_same = walk_equity(
        dates, date_groups, universe_by_date, quarter_labels, quarter_ends, weights_same_q)
    res_prev, final_prev = walk_equity(
        dates, date_groups, universe_by_date, quarter_labels, quarter_ends, weights_prev_q)
    res_equal, final_equal = walk_equity(
        dates, date_groups, universe_by_date, quarter_labels, quarter_ends, weights_equal)
    print()

    # ── Load actual equity for reference ─────────────────────────────────────
    actual_eq = pd.read_parquet(ACTUAL_EQUITY_PATH)
    actual_eq["Date"] = pd.to_datetime(actual_eq["Date"]).dt.normalize()
    first_date = actual_eq["Date"].iloc[0]
    last_date = actual_eq["Date"].iloc[-1]
    years = (last_date - first_date).days / 365.25

    # ── Quarter-by-quarter comparison ────────────────────────────────────────
    # Build lookup dicts
    same_q_lookup = {q: (s, e) for q, s, e in res_same}
    prev_q_lookup = {q: (s, e) for q, s, e in res_prev}
    equal_lookup = {q: (s, e) for q, s, e in res_equal}

    all_quarters = sorted(set(list(same_q_lookup) + list(prev_q_lookup) + list(equal_lookup)))

    # Also show top-weight per quarter for same-q scheme
    print(f"{'Quarter':<12} {'SameQ Ret':>10} {'SameQ Eq':>10} {'PrevQ Ret':>10} "
          f"{'PrevQ Eq':>10} {'Equal Ret':>10} {'Equal Eq':>10}   "
          f"{'Top Ticker (SameQ)':<20} {'Wt':>6}")
    print("-" * 120)

    for q in all_quarters:
        s_start, s_end = same_q_lookup.get(q, (None, None))
        p_start, p_end = prev_q_lookup.get(q, (None, None))
        e_start, e_end = equal_lookup.get(q, (None, None))

        s_ret = f"{(s_end / s_start - 1) * 100:+.1f}%" if s_start else "N/A"
        s_eq = f"{s_end:.2f}" if s_end else "N/A"
        p_ret = f"{(p_end / p_start - 1) * 100:+.1f}%" if p_start else "N/A"
        p_eq = f"{p_end:.2f}" if p_end else "N/A"
        e_ret = f"{(e_end / e_start - 1) * 100:+.1f}%" if e_start else "N/A"
        e_eq = f"{e_end:.2f}" if e_end else "N/A"

        # Top weight in same-q scheme
        top_t, top_w = "", ""
        if q in weights_same_q:
            wts = weights_same_q[q]
            max_t = max(wts, key=wts.get)
            top_t = max_t
            top_w = f"{wts[max_t]*100:.1f}%"

        print(f"{q:<12} {s_ret:>10} {s_eq:>10} {p_ret:>10} {p_eq:>10} "
              f"{e_ret:>10} {e_eq:>10}   {top_t:<20} {top_w:>6}")

    # ── Summary ──────────────────────────────────────────────────────────────
    print()
    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)

    def cagr(final_val, yrs):
        if final_val <= 0 or yrs <= 0:
            return 0.0
        return (final_val ** (1 / yrs) - 1) * 100

    print(f"{'Scheme':<35} {'Final Equity':>14} {'Total Return':>14} {'CAGR':>8}")
    print("-" * 75)
    print(f"{'Same-Q Dollar-Vol (original)':<35} {final_same:>14.2f} {final_same:>13.1f}x {cagr(final_same, years):>7.2f}%")
    print(f"{'Prev-Q Dollar-Vol (no lookahead)':<35} {final_prev:>14.2f} {final_prev:>13.1f}x {cagr(final_prev, years):>7.2f}%")
    print(f"{'Equal-Weight':<35} {final_equal:>14.2f} {final_equal:>13.1f}x {cagr(final_equal, years):>7.2f}%")

    print()
    print("Interpretation:")
    print(f"  Same-Q vs Prev-Q gap:  {final_same / final_prev:.1f}x — measures look-ahead bias from same-quarter volume")
    print(f"  Same-Q vs Equal gap:   {final_same / final_equal:.1f}x — measures total dollar-volume weighting effect")
    print(f"  Prev-Q vs Equal gap:   {final_prev / final_equal:.1f}x — measures legitimate dollar-volume concentration effect")

    # ── Biggest divergence quarters ──────────────────────────────────────────
    print()
    print("BIGGEST DIVERGENCES (Same-Q vs Equal, by quarterly return difference):")
    print(f"{'Quarter':<12} {'SameQ Ret':>10} {'Equal Ret':>10} {'Diff':>10}   {'Top Ticker':>20} {'Wt':>6}")
    print("-" * 80)

    divergences = []
    for q in all_quarters:
        s_start, s_end = same_q_lookup.get(q, (None, None))
        e_start, e_end = equal_lookup.get(q, (None, None))
        if s_start and e_start:
            s_ret = (s_end / s_start - 1) * 100
            e_ret = (e_end / e_start - 1) * 100
            divergences.append((q, s_ret, e_ret, s_ret - e_ret))

    divergences.sort(key=lambda x: abs(x[3]), reverse=True)
    for q, s_ret, e_ret, diff in divergences[:20]:
        top_t, top_w = "", ""
        if q in weights_same_q:
            wts = weights_same_q[q]
            max_t = max(wts, key=wts.get)
            top_t = max_t
            top_w = f"{wts[max_t]*100:.1f}%"
        print(f"{q:<12} {s_ret:>+9.1f}% {e_ret:>+9.1f}% {diff:>+9.1f}%   {top_t:>20} {top_w:>6}")


if __name__ == "__main__":
    main()
