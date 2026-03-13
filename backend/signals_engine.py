import numpy as np
import pandas as pd


SIGNALS = ["Up_Rot", "Down_Rot", "Breakout", "Breakdown", "BTFD", "STFR"]
RV_MULT = np.sqrt(252) / np.sqrt(21)
EMA_MULT = 2.0 / 11.0
RV_EMA_ALPHA = 2.0 / 11.0


class RollingStatsAccumulator:
    __slots__ = ("count", "n_winners", "sum_winners", "n_losers", "sum_losers", "sum_all", "sum_sq", "sum_mfe", "sum_mae", "last_3", "sum_winner_bars", "sum_loser_bars")

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
        self.sum_winner_bars = 0.0
        self.sum_loser_bars = 0.0

    def add(self, change, mfe, mae, bars=None):
        self.count += 1
        self.sum_all += change
        self.sum_sq += change * change
        self.last_3.append(change)
        if len(self.last_3) > 3:
            self.last_3.pop(0)
        if change > 0:
            self.n_winners += 1
            self.sum_winners += change
            if bars is not None:
                self.sum_winner_bars += bars
        else:
            self.n_losers += 1
            self.sum_losers += change
            if bars is not None:
                self.sum_loser_bars += bars
        self.sum_mfe += mfe
        self.sum_mae += mae

    def get_stats(self):
        if self.count == 0:
            return {}
        n = self.count
        win_rate = self.n_winners / n
        avg_winner = (self.sum_winners / self.n_winners) if self.n_winners > 0 else 0.0
        avg_loser = (self.sum_losers / self.n_losers) if self.n_losers > 0 else 0.0
        avg_winner_bars = (self.sum_winner_bars / self.n_winners) if self.n_winners > 0 else np.nan
        avg_loser_bars = (self.sum_loser_bars / self.n_losers) if self.n_losers > 0 else np.nan
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
            "Avg_Winner_Bars": avg_winner_bars,
            "Avg_Loser_Bars": avg_loser_bars,
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
    opens = df["Open"].values
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
        if trends[i] is False and not np.isnan(lower_target[i - 1]) and lows[i] <= lower_target[i - 1]:
            if rotation_id not in btfd_rotations:
                is_btfd[i] = True
                btfd_entry_price[i] = opens[i] if opens[i] <= lower_target[i - 1] else lower_target[i - 1]
                btfd_rotations.add(rotation_id)
        if trends[i] is True and not np.isnan(upper_target[i - 1]) and highs[i] >= upper_target[i - 1]:
            if rotation_id not in stfr_rotations:
                is_stfr[i] = True
                stfr_entry_price[i] = opens[i] if opens[i] >= upper_target[i - 1] else upper_target[i - 1]
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
        stats_cols = {k: np.full(n, np.nan) for k in ["Win_Rate", "Avg_Winner", "Avg_Loser", "Avg_Winner_Bars", "Avg_Loser_Bars", "Avg_MFE", "Avg_MAE", "Historical_EV", "Std_Dev", "Risk_Adj_EV", "EV_Last_3", "Risk_Adj_EV_Last_3", "Count"]}

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
                    bars = i - pos["entry_idx"]
                    accumulator.add(final_change, mfe, mae, bars)
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
                bars = exit_idx - pos["entry_idx"]
                accumulator.add(final_change, mfe, mae, bars)
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


def _build_signals_next_row(prev_row, live_price, live_dt,
                             live_high=None, live_low=None, live_open=None):
    """Incremental one-bar update using cached last row state.

    Ported from rotations_signals/rotations.py for use in the web app's
    live-signals endpoint. For EOD updates, pass actual OHLC via
    live_high/live_low/live_open so that BTFD (fires when low <= lower_target)
    and STFR (fires when high >= upper_target) are detected correctly.
    """
    if prev_row is None or pd.isna(live_price):
        return None

    prev = prev_row.to_dict()
    prev_date = pd.to_datetime(prev.get('Date'))
    live_dt = pd.to_datetime(live_dt)
    if pd.notna(prev_date) and live_dt <= prev_date:
        live_dt = prev_date + pd.Timedelta(minutes=1)

    close = float(live_price)
    high  = float(live_high)  if live_high  is not None else close
    low   = float(live_low)   if live_low   is not None else close
    open_ = float(live_open)  if live_open  is not None else close
    prev_close = prev.get('Close', np.nan)
    if pd.isna(prev_close) or prev_close == 0:
        return None

    rv = abs(close - prev_close) / prev_close
    prev_rv_ema = prev.get('RV_EMA', np.nan)
    rv_ema = rv if pd.isna(prev_rv_ema) else (rv * RV_EMA_ALPHA + prev_rv_ema * (1 - RV_EMA_ALPHA))

    prev_trend = prev.get('Trend', False)
    prev_res = prev.get('Resistance_Pivot', np.nan)
    prev_sup = prev.get('Support_Pivot', np.nan)

    is_up_rot = False
    is_down_rot = False
    rv_mult = rv_ema * RV_MULT

    if prev_trend == False:
        base_res = close * (1 + rv_mult)
        resistance = base_res if pd.isna(prev_res) else min(base_res, prev_res)
        if not pd.isna(prev_res) and close > prev_res:
            trend = True
            support = close * (1 - rv_mult)
            resistance = prev_res
            is_up_rot = True
        else:
            trend = False
            support = prev_sup
    else:
        support = close * (1 - rv_mult) if pd.isna(prev_sup) else max(close * (1 - rv_mult), prev_sup)
        if not pd.isna(prev_sup) and close < prev_sup:
            trend = False
            resistance = close * (1 + rv_mult)
            support = prev_sup
            is_down_rot = True
        else:
            trend = True
            resistance = prev_res

    rotation_change = (trend != prev_trend)
    rotation_id = int(prev.get('Rotation_ID', 0))
    if rotation_change:
        rotation_id += 1

    prev_up_ema = prev.get('Up_Range_EMA', np.nan)
    prev_down_ema = prev.get('Down_Range_EMA', np.nan)
    prev_up_range = prev.get('Up_Range', np.nan)
    prev_down_range = prev.get('Down_Range', np.nan)

    up_ema = prev_up_ema
    down_ema = prev_down_ema
    if rotation_change:
        if prev_trend == True:
            if not pd.isna(prev_up_range):
                up_ema = prev_up_range if pd.isna(prev_up_ema) else (prev_up_range * EMA_MULT + prev_up_ema * (1 - EMA_MULT))
        else:
            if not pd.isna(prev_down_range):
                down_ema = prev_down_range if pd.isna(prev_down_ema) else (prev_down_range * EMA_MULT + prev_down_ema * (1 - EMA_MULT))

    prev_rot_open = prev.get('Rotation_Open', np.nan)
    if rotation_change:
        rot_open = prev_close
    else:
        rot_open = prev_rot_open if not pd.isna(prev_rot_open) else prev_close

    if trend == True:
        up_range = abs((high - rot_open) / rot_open) if rot_open else np.nan
        down_range = np.nan
    else:
        down_range = abs((low - rot_open) / rot_open) if rot_open else np.nan
        up_range = np.nan

    prev_upper = prev.get('Upper_Target', np.nan)
    prev_lower = prev.get('Lower_Target', np.nan)
    upper_target = prev_upper
    lower_target = prev_lower

    if rotation_change and trend == True and not pd.isna(up_ema):
        calculated = close * (1 + up_ema)
        if pd.isna(prev_upper) or close > prev_upper or calculated < prev_upper:
            upper_target = calculated
    if rotation_change and trend == False and not pd.isna(down_ema):
        calculated = close * (1 - down_ema)
        if pd.isna(prev_lower) or close < prev_lower or calculated > prev_lower:
            lower_target = calculated

    btfd_triggered = bool(prev.get('BTFD_Triggered', False))
    stfr_triggered = bool(prev.get('STFR_Triggered', False))
    if rotation_change:
        btfd_triggered = False
        stfr_triggered = False

    is_breakout = is_up_rot and not pd.isna(prev_upper) and close > prev_upper
    is_breakdown = is_down_rot and not pd.isna(prev_lower) and close < prev_lower

    is_btfd = False
    btfd_entry = np.nan
    if trend == False and prev_trend == False and not pd.isna(prev_lower) and low <= prev_lower and not btfd_triggered:
        is_btfd = True
        btfd_entry = open_ if open_ <= prev_lower else prev_lower
        btfd_triggered = True

    is_stfr = False
    stfr_entry = np.nan
    if trend == True and prev_trend == True and not pd.isna(prev_upper) and high >= prev_upper and not stfr_triggered:
        is_stfr = True
        stfr_entry = open_ if open_ >= prev_upper else prev_upper
        stfr_triggered = True

    if prev.get('Is_Breakout', False):
        last_signal = 'breakout'
    elif prev.get('Is_Breakdown', False):
        last_signal = 'breakdown'
    elif prev.get('Is_Breakout_Sequence', False):
        last_signal = 'breakout'
    else:
        last_signal = 'breakdown'
    is_breakout_seq = (last_signal == 'breakout')

    new_row = prev.copy()
    new_row.update({
        'Date': live_dt,
        'Open': open_,
        'High': high,
        'Low': low,
        'Close': close,
        'Volume': 0,
        'Turnover': np.nan,
        'RV': rv,
        'RV_EMA': rv_ema,
        'Trend': trend,
        'Resistance_Pivot': resistance,
        'Support_Pivot': support,
        'Is_Up_Rotation': is_up_rot,
        'Is_Down_Rotation': is_down_rot,
        'Rotation_Open': rot_open,
        'Up_Range': up_range,
        'Down_Range': down_range,
        'Up_Range_EMA': up_ema,
        'Down_Range_EMA': down_ema,
        'Upper_Target': upper_target,
        'Lower_Target': lower_target,
        'Is_Breakout': is_breakout,
        'Is_Breakdown': is_breakdown,
        'Is_BTFD': is_btfd,
        'Is_STFR': is_stfr,
        'BTFD_Target_Entry': btfd_entry,
        'STFR_Target_Entry': stfr_entry,
        'Is_Breakout_Sequence': is_breakout_seq,
        'Rotation_ID': rotation_id,
        'BTFD_Triggered': btfd_triggered,
        'STFR_Triggered': stfr_triggered,
    })

    if is_up_rot:
        new_row['Up_Rot_Entry_Price'] = close
    if is_down_rot:
        new_row['Down_Rot_Entry_Price'] = close
    if is_breakout:
        new_row['Breakout_Entry_Price'] = upper_target
    if is_breakdown:
        new_row['Breakdown_Entry_Price'] = lower_target
    if is_btfd:
        new_row['BTFD_Entry_Price'] = btfd_entry
    if is_stfr:
        new_row['STFR_Entry_Price'] = stfr_entry

    return pd.Series(new_row)
