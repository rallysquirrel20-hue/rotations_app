import os
import pickle
import hashlib
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import databento as db
import numpy as np
import pandas as pd
from dotenv import load_dotenv


SIZE = int(os.getenv("UNIVERSE_SIZE", "500"))
SIGNALS = ["Up_Rot", "Down_Rot", "Breakout", "Breakdown", "BTFD", "STFR"]
RV_MULT = np.sqrt(252) / np.sqrt(21)
EMA_MULT = 2.0 / 11.0
RV_EMA_ALPHA = 2.0 / 11.0

ET = ZoneInfo("America/New_York")
BASE_OUTPUT_FOLDER = Path(os.getenv("PYTHON_OUTPUTS_DIR", Path.home() / "Documents" / "Python_Outputs"))
PICKLE_FOLDER = BASE_OUTPUT_FOLDER / "Pickle_Files"
PICKLE_FOLDER.mkdir(parents=True, exist_ok=True)

UNIVERSE_PICKLE_PATH = Path(os.getenv("UNIVERSE_PICKLE_PATH", PICKLE_FOLDER / f"top{SIZE}stocks.pkl"))
INTRADAY_ROOT = BASE_OUTPUT_FOLDER / "Intraday_30m"
INTRADAY_ROOT.mkdir(parents=True, exist_ok=True)
INTRADAY_CACHE_FILE = INTRADAY_ROOT / f"intraday_30m_cache_top_{SIZE}.pkl"
INTRADAY_SIGNALS_CACHE_FILE = INTRADAY_ROOT / f"intraday_30m_signals_top_{SIZE}.pkl"
SIGNAL_EXPORT_FOLDER = INTRADAY_ROOT / "Signal_Exports"
SIGNAL_EXPORT_FOLDER.mkdir(parents=True, exist_ok=True)

DATABENTO_API_KEY = os.getenv("DATABENTO_API_KEY", "")
DATABENTO_DATASET = os.getenv("DATABENTO_DATASET", "EQUS.MINI")
DATABENTO_STYPE_IN = os.getenv("DATABENTO_STYPE_IN", "raw_symbol")
DATABENTO_LOOKBACK_DAYS = int(os.getenv("DATABENTO_LOOKBACK_DAYS", "90"))
DATABENTO_SYMBOL_CHUNK = int(os.getenv("DATABENTO_SYMBOL_CHUNK", "200"))
RTH_ONLY = os.getenv("INTRADAY_RTH_ONLY", "1").strip() not in ("0", "false", "False")
FORCE_REBUILD_INTRADAY_CACHE = os.getenv("FORCE_REBUILD_INTRADAY_CACHE", "0").strip() in ("1", "true", "True")


def _load_env_file():
    try:
        base_path = Path(__file__).resolve().parent
    except NameError:
        base_path = Path.cwd()
    load_dotenv(base_path / ".env", override=False)


def _refresh_runtime_config():
    global DATABENTO_API_KEY
    global DATABENTO_DATASET
    global DATABENTO_STYPE_IN
    global DATABENTO_LOOKBACK_DAYS
    global DATABENTO_SYMBOL_CHUNK
    global RTH_ONLY
    global FORCE_REBUILD_INTRADAY_CACHE

    DATABENTO_API_KEY = os.getenv("DATABENTO_API_KEY", "")
    DATABENTO_DATASET = os.getenv("DATABENTO_DATASET", "EQUS.MINI")
    DATABENTO_STYPE_IN = os.getenv("DATABENTO_STYPE_IN", "raw_symbol")
    DATABENTO_LOOKBACK_DAYS = int(os.getenv("DATABENTO_LOOKBACK_DAYS", "90"))
    DATABENTO_SYMBOL_CHUNK = int(os.getenv("DATABENTO_SYMBOL_CHUNK", "200"))
    RTH_ONLY = os.getenv("INTRADAY_RTH_ONLY", "1").strip() not in ("0", "false", "False")
    FORCE_REBUILD_INTRADAY_CACHE = os.getenv("FORCE_REBUILD_INTRADAY_CACHE", "0").strip() in ("1", "true", "True")


def _universe_signature(tickers):
    h = hashlib.sha256()
    for t in tickers:
        h.update(t.encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()


def _quarter_key_for_date(dt):
    return f"{dt.year} Q{(dt.month - 1) // 3 + 1}"


def _latest_quarter_key(universe):
    return max(universe.keys(), key=lambda k: (int(k.split()[0]), int(k.split()[1].replace("Q", ""))))


def load_universe_tickers(path):
    if not path.exists():
        raise FileNotFoundError(f"Universe pickle not found: {path}")
    with open(path, "rb") as f:
        universe = pickle.load(f)
    if not isinstance(universe, dict) or not universe:
        raise ValueError("Universe pickle must contain a non-empty dict: quarter -> set[ticker]")

    now_et = datetime.now(ET)
    current_key = _quarter_key_for_date(now_et)
    active_key = current_key if current_key in universe else _latest_quarter_key(universe)
    tickers = sorted(t for t in universe.get(active_key, set()) if isinstance(t, str) and "-" not in t)
    if not tickers:
        raise ValueError(f"No tickers found in universe for {active_key}")
    return active_key, tickers


def _fetch_1m_chunk(symbols, start_ts, end_ts):
    client = db.Historical(DATABENTO_API_KEY) if DATABENTO_API_KEY else db.Historical()
    data = client.timeseries.get_range(
        dataset=DATABENTO_DATASET,
        schema="ohlcv-1m",
        stype_in=DATABENTO_STYPE_IN,
        symbols=symbols,
        start=start_ts,
        end=end_ts,
    )
    df = data.to_df(price_type="float")
    if df.empty:
        return pd.DataFrame()

    if "ts_event" not in df.columns:
        df = df.reset_index()
    if "ts_event" not in df.columns:
        raise ValueError("Databento response missing ts_event")
    if "symbol" not in df.columns:
        if isinstance(df.index, pd.MultiIndex) and "symbol" in df.index.names:
            df = df.reset_index()
        else:
            raise ValueError("Databento response missing symbol")

    out = df[["ts_event", "symbol", "open", "high", "low", "close", "volume"]].copy()
    out.rename(
        columns={
            "ts_event": "DateTime",
            "symbol": "Ticker",
            "open": "Open",
            "high": "High",
            "low": "Low",
            "close": "Close",
            "volume": "Volume",
        },
        inplace=True,
    )
    out["DateTime"] = pd.to_datetime(out["DateTime"], utc=True).dt.tz_convert(ET)
    return out


def _resample_30m(df_1m):
    if df_1m.empty:
        return pd.DataFrame(columns=["Date", "Ticker", "Open", "High", "Low", "Close", "Volume"])

    all_rows = []
    for ticker, grp in df_1m.groupby("Ticker", sort=False):
        g = grp.sort_values("DateTime").copy()
        g = g.set_index("DateTime")
        if RTH_ONLY:
            g = g.between_time("09:30", "15:59")
        if g.empty:
            continue

        r = g.resample("30min", label="left", closed="left").agg(
            {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
        )
        r = r.dropna(subset=["Close"]).reset_index()
        if r.empty:
            continue
        r["Ticker"] = ticker
        r.rename(columns={"DateTime": "Date"}, inplace=True)
        all_rows.append(r[["Date", "Ticker", "Open", "High", "Low", "Close", "Volume"]])

    if not all_rows:
        return pd.DataFrame(columns=["Date", "Ticker", "Open", "High", "Low", "Close", "Volume"])
    out = pd.concat(all_rows, ignore_index=True).sort_values(["Ticker", "Date"]).reset_index(drop=True)
    out["Date"] = pd.to_datetime(out["Date"]).dt.tz_convert(ET).dt.tz_localize(None)
    return out


def load_or_build_intraday_30m(tickers):
    universe_sig = _universe_signature(tickers)
    today_et = datetime.now(ET).date().isoformat()
    if INTRADAY_CACHE_FILE.exists() and not FORCE_REBUILD_INTRADAY_CACHE:
        try:
            with open(INTRADAY_CACHE_FILE, "rb") as f:
                cached = pickle.load(f)
            meta = cached.get("meta", {})
            data = cached.get("data")
            if (
                isinstance(data, pd.DataFrame)
                and not data.empty
                and meta.get("universe_sig") == universe_sig
                and meta.get("dataset") == DATABENTO_DATASET
                and meta.get("generated_date_et") == today_et
            ):
                print("Loaded 30m intraday cache (current ET date).")
                return data
        except Exception:
            pass

    end = datetime.now(ET)
    start = end - timedelta(days=DATABENTO_LOOKBACK_DAYS)
    start_ts = start.strftime("%Y-%m-%dT%H:%M")
    end_ts = end.strftime("%Y-%m-%dT%H:%M")

    chunks = [tickers[i:i + DATABENTO_SYMBOL_CHUNK] for i in range(0, len(tickers), DATABENTO_SYMBOL_CHUNK)]
    all_1m = []
    for i, chunk in enumerate(chunks, start=1):
        print(f"Fetching Databento 1m bars: chunk {i}/{len(chunks)} ({len(chunk)} symbols)")
        part = _fetch_1m_chunk(chunk, start_ts, end_ts)
        if not part.empty:
            all_1m.append(part)

    if not all_1m:
        raise ValueError("No intraday data returned from Databento.")

    df_1m = pd.concat(all_1m, ignore_index=True).drop_duplicates(subset=["DateTime", "Ticker"], keep="last")
    bars_30m = _resample_30m(df_1m)
    if bars_30m.empty:
        raise ValueError("Resampling produced no 30m bars.")

    payload = {
        "meta": {
            "universe_sig": universe_sig,
            "dataset": DATABENTO_DATASET,
            "generated_date_et": today_et,
            "lookback_days": DATABENTO_LOOKBACK_DAYS,
            "rth_only": RTH_ONLY,
        },
        "data": bars_30m,
    }
    with open(INTRADAY_CACHE_FILE, "wb") as f:
        pickle.dump(payload, f)
    print(f"Saved 30m intraday cache: {INTRADAY_CACHE_FILE}")
    return bars_30m


class RollingStatsAccumulator:
    __slots__ = ("count", "n_winners", "sum_winners", "n_losers", "sum_losers", "sum_all", "sum_sq", "sum_mfe", "sum_mae", "last_3")

    def __init__(self):
        self.count = 0
        self.n_winners = 0
        self.sum_winners = 0.0
        self.n_losers = 0
        self.sum_losers = 0.0
        self.sum_all = 0.0
        self.sum_sq = 0.0
        self.sum_mfe = 0.0
        self.sum_mae = 0.0
        self.last_3 = []

    def add(self, change, mfe, mae):
        self.count += 1
        self.sum_all += change
        self.sum_sq += change * change
        self.last_3.append(change)
        if len(self.last_3) > 3:
            self.last_3.pop(0)
        if change > 0:
            self.n_winners += 1
            self.sum_winners += change
        else:
            self.n_losers += 1
            self.sum_losers += change
        self.sum_mfe += mfe
        self.sum_mae += mae

    def get_stats(self):
        if self.count == 0:
            return {}
        n = self.count
        win_rate = self.n_winners / n
        avg_winner = (self.sum_winners / self.n_winners) if self.n_winners > 0 else 0.0
        avg_loser = (self.sum_losers / self.n_losers) if self.n_losers > 0 else 0.0
        hist_ev = (win_rate * avg_winner) + ((1 - win_rate) * avg_loser)
        ev_last_3 = float(np.mean(self.last_3)) if len(self.last_3) >= 3 else np.nan
        mean = self.sum_all / n
        variance = (self.sum_sq / n) - (mean * mean)
        std_dev = np.sqrt(max(variance, 0.0)) if n >= 2 else np.nan
        if pd.notna(std_dev) and np.isfinite(std_dev) and std_dev > 0:
            risk_adj_ev = hist_ev / std_dev
            risk_adj_ev_last_3 = (ev_last_3 / std_dev) if not np.isnan(ev_last_3) else np.nan
        else:
            risk_adj_ev = np.nan
            risk_adj_ev_last_3 = np.nan
        return {
            "Win_Rate": win_rate,
            "Avg_Winner": avg_winner,
            "Avg_Loser": avg_loser,
            "Avg_MFE": self.sum_mfe / n,
            "Avg_MAE": self.sum_mae / n,
            "Historical_EV": hist_ev,
            "Std_Dev": std_dev,
            "Risk_Adj_EV": risk_adj_ev,
            "EV_Last_3": ev_last_3,
            "Risk_Adj_EV_Last_3": risk_adj_ev_last_3,
            "Count": n,
        }


def _build_signals_from_df(df, ticker):
    df = df.reset_index().rename(columns={"index": "Date"})
    n = len(df)
    if n < 2:
        return None

    closes = df["Close"].values
    highs = df["High"].values
    lows = df["Low"].values
    df["RV"] = abs(df["Close"] - df["Close"].shift(1)) / df["Close"].shift(1)
    df["RV_EMA"] = df["RV"].ewm(span=10, adjust=False).mean()
    rv_emas = df["RV_EMA"].values

    start_idx = df["RV_EMA"].first_valid_index()
    if start_idx is None:
        return None

    trends = np.full(n, None, dtype=object)
    resistance = np.full(n, np.nan)
    support = np.full(n, np.nan)
    is_up_rot = np.zeros(n, dtype=bool)
    is_down_rot = np.zeros(n, dtype=bool)

    trends[start_idx] = False
    resistance[start_idx] = closes[start_idx] * (1 + rv_emas[start_idx] * RV_MULT)
    for i in range(start_idx + 1, n):
        close = closes[i]
        rv = rv_emas[i] * RV_MULT
        prev_trend = trends[i - 1]
        prev_res = resistance[i - 1]
        prev_sup = support[i - 1]

        if prev_trend is False:
            resistance[i] = min(close * (1 + rv), prev_res)
            if close > prev_res:
                trends[i], support[i], resistance[i] = True, close * (1 - rv), prev_res
                is_up_rot[i] = True
            else:
                trends[i] = False
        else:
            support[i] = max(close * (1 - rv), prev_sup) if not np.isnan(prev_sup) else close * (1 - rv)
            if close < prev_sup:
                trends[i], resistance[i], support[i] = False, close * (1 + rv), prev_sup
                is_down_rot[i] = True
            else:
                trends[i] = True

    rotation_open = np.full(n, np.nan)
    up_range = np.full(n, np.nan)
    down_range = np.full(n, np.nan)
    up_range_ema = np.full(n, np.nan)
    down_range_ema = np.full(n, np.nan)
    upper_target = np.full(n, np.nan)
    lower_target = np.full(n, np.nan)

    rot_open_price = None
    up_ema = None
    down_ema = None
    prev_upper = None
    prev_lower = None
    for i in range(start_idx, n):
        curr_trend = trends[i]
        prev_trend = trends[i - 1] if i > start_idx else None
        if i == start_idx or curr_trend != prev_trend:
            if rot_open_price is not None and i > start_idx:
                if prev_trend is True:
                    final_range = up_range[i - 1]
                    up_ema = final_range if up_ema is None else (final_range * EMA_MULT) + (up_ema * (1 - EMA_MULT))
                else:
                    final_range = down_range[i - 1]
                    down_ema = final_range if down_ema is None else (final_range * EMA_MULT) + (down_ema * (1 - EMA_MULT))
            rot_open_price = closes[i - 1] if i > start_idx else closes[i]
            rotation_open[i] = rot_open_price
            if curr_trend is True and up_ema is not None:
                calculated = closes[i] * (1 + up_ema)
                if prev_upper is None or closes[i] > prev_upper or calculated < prev_upper:
                    prev_upper = calculated
            if curr_trend is False and down_ema is not None:
                calculated = closes[i] * (1 - down_ema)
                if prev_lower is None or closes[i] < prev_lower or calculated > prev_lower:
                    prev_lower = calculated

        if rot_open_price is not None and np.isfinite(rot_open_price) and rot_open_price > 0:
            if curr_trend is True and np.isfinite(highs[i]):
                up_range[i] = abs((highs[i] - rot_open_price) / rot_open_price)
            elif curr_trend is not True and np.isfinite(lows[i]):
                down_range[i] = abs((lows[i] - rot_open_price) / rot_open_price)

        up_range_ema[i] = up_ema if up_ema else np.nan
        down_range_ema[i] = down_ema if down_ema else np.nan
        upper_target[i] = prev_upper if prev_upper else np.nan
        lower_target[i] = prev_lower if prev_lower else np.nan

    is_breakout = np.zeros(n, dtype=bool)
    is_breakdown = np.zeros(n, dtype=bool)
    is_btfd = np.zeros(n, dtype=bool)
    is_stfr = np.zeros(n, dtype=bool)
    btfd_entry_price = np.full(n, np.nan)
    stfr_entry_price = np.full(n, np.nan)
    rotation_id = 0
    rotation_ids = np.zeros(n, dtype=int)
    btfd_rotations = set()
    stfr_rotations = set()
    btfd_triggered_state = np.zeros(n, dtype=bool)
    stfr_triggered_state = np.zeros(n, dtype=bool)

    for i in range(start_idx + 1, n):
        if trends[i] != trends[i - 1]:
            rotation_id += 1
        rotation_ids[i] = rotation_id
        if is_up_rot[i] and not np.isnan(upper_target[i - 1]) and closes[i] > upper_target[i - 1]:
            is_breakout[i] = True
        if is_down_rot[i] and not np.isnan(lower_target[i - 1]) and closes[i] < lower_target[i - 1]:
            is_breakdown[i] = True
        if trends[i] is False and not np.isnan(lower_target[i]) and lows[i] <= lower_target[i]:
            if rotation_id not in btfd_rotations:
                is_btfd[i] = True
                btfd_entry_price[i] = lower_target[i]
                btfd_rotations.add(rotation_id)
        if trends[i] is True and not np.isnan(upper_target[i]) and highs[i] >= upper_target[i]:
            if rotation_id not in stfr_rotations:
                is_stfr[i] = True
                stfr_entry_price[i] = upper_target[i]
                stfr_rotations.add(rotation_id)
        btfd_triggered_state[i] = rotation_id in btfd_rotations
        stfr_triggered_state[i] = rotation_id in stfr_rotations

    is_breakout_seq = np.zeros(n, dtype=bool)
    last_signal = None
    for i in range(n):
        is_breakout_seq[i] = (last_signal == "breakout")
        if is_breakout[i]:
            last_signal = "breakout"
        elif is_breakdown[i]:
            last_signal = "breakdown"

    signal_configs = {
        "Up_Rot": {"entry": is_up_rot, "exit": is_down_rot, "entry_prices": None, "direction": "long"},
        "Down_Rot": {"entry": is_down_rot, "exit": is_up_rot, "entry_prices": None, "direction": "short"},
        "Breakout": {"entry": is_breakout, "exit": is_breakdown, "entry_prices": None, "direction": "long"},
        "Breakdown": {"entry": is_breakdown, "exit": is_breakout, "entry_prices": None, "direction": "short"},
        "BTFD": {"entry": is_btfd, "exit": is_breakdown, "entry_prices": btfd_entry_price, "direction": "long"},
        "STFR": {"entry": is_stfr, "exit": is_breakout, "entry_prices": stfr_entry_price, "direction": "short"},
    }

    dates = df["Date"].values
    new_cols = {
        "Trend": trends,
        "Resistance_Pivot": resistance,
        "Support_Pivot": support,
        "Is_Up_Rotation": is_up_rot,
        "Is_Down_Rotation": is_down_rot,
        "Rotation_Open": rotation_open,
        "Up_Range": up_range,
        "Down_Range": down_range,
        "Up_Range_EMA": up_range_ema,
        "Down_Range_EMA": down_range_ema,
        "Upper_Target": upper_target,
        "Lower_Target": lower_target,
        "Is_Breakout": is_breakout,
        "Is_Breakdown": is_breakdown,
        "Is_BTFD": is_btfd,
        "Is_STFR": is_stfr,
        "BTFD_Target_Entry": btfd_entry_price,
        "STFR_Target_Entry": stfr_entry_price,
        "Is_Breakout_Sequence": is_breakout_seq,
        "Rotation_ID": rotation_ids,
        "BTFD_Triggered": btfd_triggered_state,
        "STFR_Triggered": stfr_triggered_state,
    }

    for sig_name, cfg in signal_configs.items():
        entry_arr = cfg["entry"]
        exit_arr = cfg["exit"]
        custom_entry_prices = cfg["entry_prices"]
        direction = cfg["direction"]

        entry_price_col = np.full(n, np.nan)
        exit_date_col = np.full(n, np.nan, dtype=object)
        exit_price_col = np.full(n, np.nan)
        final_change_col = np.full(n, np.nan)
        mfe_col = np.full(n, np.nan)
        mae_col = np.full(n, np.nan)
        stats_cols = {k: np.full(n, np.nan) for k in ["Win_Rate", "Avg_Winner", "Avg_Loser", "Avg_MFE", "Avg_MAE", "Historical_EV", "Std_Dev", "Risk_Adj_EV", "EV_Last_3", "Risk_Adj_EV_Last_3", "Count"]}

        open_positions = []
        accumulator = RollingStatsAccumulator()
        current_stats = {}

        for i in range(n):
            if open_positions:
                for pos in open_positions:
                    pos["max_high"] = max(pos["max_high"], highs[i])
                    pos["min_low"] = min(pos["min_low"], lows[i])

            if open_positions and exit_arr[i]:
                for pos in open_positions:
                    if direction == "short":
                        final_change = (pos["entry_price"] - closes[i]) / pos["entry_price"]
                        mfe = (pos["entry_price"] - pos["min_low"]) / pos["entry_price"]
                        mae = (pos["entry_price"] - pos["max_high"]) / pos["entry_price"]
                    else:
                        final_change = (closes[i] - pos["entry_price"]) / pos["entry_price"]
                        mfe = (pos["max_high"] - pos["entry_price"]) / pos["entry_price"]
                        mae = (pos["min_low"] - pos["entry_price"]) / pos["entry_price"]
                    accumulator.add(final_change, mfe, mae)
                    exit_date_col[pos["entry_idx"]] = dates[i]
                    exit_price_col[pos["entry_idx"]] = closes[i]
                    final_change_col[pos["entry_idx"]] = final_change
                    mfe_col[pos["entry_idx"]] = mfe
                    mae_col[pos["entry_idx"]] = mae
                current_stats = accumulator.get_stats()
                open_positions = []

            if entry_arr[i]:
                entry_price = custom_entry_prices[i] if custom_entry_prices is not None and not np.isnan(custom_entry_prices[i]) else closes[i]
                open_positions.append({"entry_idx": i, "entry_price": entry_price, "max_high": highs[i], "min_low": lows[i]})

            if open_positions:
                entry_price_col[i] = open_positions[-1]["entry_price"]
            for stat_name, stat_val in current_stats.items():
                stats_cols[stat_name][i] = stat_val

        if open_positions:
            exit_idx = n - 1
            exit_px = closes[exit_idx]
            for pos in open_positions:
                if direction == "short":
                    final_change = (pos["entry_price"] - exit_px) / pos["entry_price"]
                    mfe = (pos["entry_price"] - pos["min_low"]) / pos["entry_price"]
                    mae = (pos["entry_price"] - pos["max_high"]) / pos["entry_price"]
                else:
                    final_change = (exit_px - pos["entry_price"]) / pos["entry_price"]
                    mfe = (pos["max_high"] - pos["entry_price"]) / pos["entry_price"]
                    mae = (pos["min_low"] - pos["entry_price"]) / pos["entry_price"]
                accumulator.add(final_change, mfe, mae)
                exit_date_col[pos["entry_idx"]] = dates[exit_idx]
                exit_price_col[pos["entry_idx"]] = exit_px
                final_change_col[pos["entry_idx"]] = final_change
                mfe_col[pos["entry_idx"]] = mfe
                mae_col[pos["entry_idx"]] = mae
            current_stats = accumulator.get_stats()
            for stat_name, stat_val in current_stats.items():
                stats_cols[stat_name][exit_idx:] = stat_val

        new_cols[f"{sig_name}_Entry_Price"] = entry_price_col
        new_cols[f"{sig_name}_Exit_Date"] = exit_date_col
        new_cols[f"{sig_name}_Exit_Price"] = exit_price_col
        new_cols[f"{sig_name}_Final_Change"] = final_change_col
        new_cols[f"{sig_name}_MFE"] = mfe_col
        new_cols[f"{sig_name}_MAE"] = mae_col
        for stat_name, arr in stats_cols.items():
            new_cols[f"{sig_name}_{stat_name}"] = arr

    new_cols["Ticker"] = ticker
    return pd.concat([df, pd.DataFrame(new_cols, index=df.index)], axis=1)


def build_all_signals_30m(bars_30m):
    frames = []
    grouped = list(bars_30m.groupby("Ticker"))
    total = len(grouped)
    for i, (ticker, grp) in enumerate(grouped, start=1):
        out = _build_signals_from_df(grp.set_index("Date"), ticker)
        if out is not None and not out.empty:
            frames.append(out)
        if i % 50 == 0 or i == total:
            print(f"Signal build progress: {i}/{total}")
    if not frames:
        raise ValueError("No signals built for any ticker.")
    all_signals = pd.concat(frames, ignore_index=True)
    all_signals["Date"] = pd.to_datetime(all_signals["Date"])
    return all_signals


def load_or_build_signals_30m(bars_30m, tickers):
    universe_sig = _universe_signature(tickers)
    latest_bar = pd.to_datetime(bars_30m["Date"]).max()

    if INTRADAY_SIGNALS_CACHE_FILE.exists() and not FORCE_REBUILD_INTRADAY_CACHE:
        try:
            with open(INTRADAY_SIGNALS_CACHE_FILE, "rb") as f:
                cached = pickle.load(f)
            meta = cached.get("meta", {})
            data = cached.get("data")
            if (
                isinstance(data, pd.DataFrame)
                and not data.empty
                and meta.get("universe_sig") == universe_sig
                and pd.to_datetime(meta.get("latest_bar")) == latest_bar
            ):
                print("Loaded 30m signals cache.")
                return data
        except Exception:
            pass

    out = build_all_signals_30m(bars_30m)
    payload = {"meta": {"universe_sig": universe_sig, "latest_bar": latest_bar.isoformat()}, "data": out}
    with open(INTRADAY_SIGNALS_CACHE_FILE, "wb") as f:
        pickle.dump(payload, f)
    print(f"Saved 30m signals cache: {INTRADAY_SIGNALS_CACHE_FILE}")
    return out


def _make_signal_export(signals_df, target_date):
    signal_flags = {
        "Up_Rot": "Is_Up_Rotation",
        "Down_Rot": "Is_Down_Rotation",
        "Breakout": "Is_Breakout",
        "Breakdown": "Is_Breakdown",
        "BTFD": "Is_BTFD",
        "STFR": "Is_STFR",
    }
    day_df = signals_df[signals_df["Date"].dt.date == target_date].copy()
    day_df = day_df.loc[:, ~day_df.columns.duplicated(keep="last")]
    if day_df.empty:
        return pd.DataFrame()

    common_cols = ["Date", "Ticker", "Close"]
    stat_suffixes = [
        "Entry_Price",
        "Win_Rate", "Avg_Winner", "Avg_Loser",
        "Avg_MFE", "Avg_MAE", "Std_Dev",
        "Historical_EV", "EV_Last_3",
        "Risk_Adj_EV", "Risk_Adj_EV_Last_3", "Count",
    ]

    rows = []
    for sig_name, flag_col in signal_flags.items():
        sig_df = day_df[day_df[flag_col] == True].copy()
        if sig_df.empty:
            continue
        prefixed = [f"{sig_name}_{s}" for s in stat_suffixes]
        sig_df = sig_df.reindex(columns=common_cols + prefixed).copy()
        sig_df.rename(columns={f"{sig_name}_{s}": s for s in stat_suffixes}, inplace=True)
        sig_df.insert(3, "Signal_Type", sig_name)
        rows.append(sig_df)
    if not rows:
        return pd.DataFrame()
    return pd.concat(rows, ignore_index=True)


def export_today_yesterday(signals_df):
    signals_df = signals_df.copy()
    signals_df["Date"] = pd.to_datetime(signals_df["Date"])
    today_et = datetime.now(ET).date()
    available_dates = sorted(signals_df["Date"].dt.date.unique())
    yesterday_et = max([d for d in available_dates if d < today_et], default=None)

    out_today = _make_signal_export(signals_df, today_et)
    today_file = SIGNAL_EXPORT_FOLDER / f"{today_et.strftime('%Y_%m_%d')}_30m_signals_today_top_{SIZE}.csv"
    out_today.to_csv(today_file, index=False)
    print(f"Today signals: {len(out_today)} rows -> {today_file}")

    if yesterday_et is not None:
        out_yday = _make_signal_export(signals_df, yesterday_et)
        yday_file = SIGNAL_EXPORT_FOLDER / f"{yesterday_et.strftime('%Y_%m_%d')}_30m_signals_yesterday_top_{SIZE}.csv"
        out_yday.to_csv(yday_file, index=False)
        print(f"Yesterday signals: {len(out_yday)} rows -> {yday_file}")
    else:
        print("No prior available trading date found for yesterday export.")


def main():
    _load_env_file()
    _refresh_runtime_config()
    if not DATABENTO_API_KEY:
        raise ValueError("Missing DATABENTO_API_KEY in environment/.env")

    active_key, tickers = load_universe_tickers(UNIVERSE_PICKLE_PATH)
    print(f"Using universe: {active_key} ({len(tickers)} tickers)")

    bars_30m = load_or_build_intraday_30m(tickers)
    print(f"30m bars: {len(bars_30m)} rows from {bars_30m['Date'].min()} to {bars_30m['Date'].max()}")

    signals_30m = load_or_build_signals_30m(bars_30m, tickers)
    print(f"Signals rows: {len(signals_30m)}")

    export_today_yesterday(signals_30m)


if __name__ == "__main__":
    main()
