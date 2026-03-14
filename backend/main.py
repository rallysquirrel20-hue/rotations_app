from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import numpy as np
import os
from pathlib import Path
import json
import databento as db
from dotenv import load_dotenv
from datetime import datetime, timedelta
import asyncio
import logging
import signals_engine
import re
from zoneinfo import ZoneInfo
from pydantic import BaseModel
from typing import List, Optional

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Load .env: check local backend dir first, then shared ~/Documents/Repositories/.env
_local_env = Path(__file__).parent / ".env"
_shared_env = Path.home() / "Documents" / "Repositories" / ".env"
env_path = _local_env if _local_env.exists() else _shared_env
load_dotenv(dotenv_path=env_path, override=True)

app = FastAPI()

# Databento Configuration
DB_API_KEY = os.getenv("DATABENTO_API_KEY")
DB_DATASET = os.getenv("DATABENTO_DATASET", "EQUS.MINI")
DB_STYPE_IN = os.getenv("DATABENTO_STYPE_IN", "raw_symbol")

logger.info(f"--- STARTING BACKEND ---")
logger.info(f"DATASET: {DB_DATASET}")
logger.info(f"STYPE_IN: {DB_STYPE_IN}")
masked_key = DB_API_KEY[:5] + "..." + DB_API_KEY[-5:] if DB_API_KEY and len(DB_API_KEY) > 10 else "NOT SET"
logger.info(f"API_KEY: {masked_key}")
logger.info(f"------------------------")

db_client = db.Historical(DB_API_KEY) if DB_API_KEY and "YOUR_API_KEY" not in DB_API_KEY else None

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# PORTABILITY FIX:
# Look for 'DATA_PATH' in environment variables,
# otherwise default to the relative path where your data usually is.
DEFAULT_PATH = Path.home() / "Documents" / "Python_Outputs"
BASE_DIR = Path(os.getenv("PYTHON_OUTPUTS_DIR", str(DEFAULT_PATH))).expanduser()

DATA_STORAGE = BASE_DIR / "Data_Storage"
THEMATIC_BASKET_CACHE = DATA_STORAGE / "thematic_basket_cache"
SECTOR_BASKET_CACHE = DATA_STORAGE / "sector_basket_cache"
INDUSTRY_BASKET_CACHE = DATA_STORAGE / "industry_basket_cache"
BASKET_CACHE_FOLDERS = [THEMATIC_BASKET_CACHE, SECTOR_BASKET_CACHE, INDUSTRY_BASKET_CACHE, DATA_STORAGE]
INDIVIDUAL_SIGNALS_FILE = DATA_STORAGE / "signals_500.parquet"
LIVE_SIGNALS_FILE = DATA_STORAGE / "live_signals_500.parquet"
LIVE_BASKET_SIGNALS_FILE = DATA_STORAGE / "live_basket_signals_500.parquet"
TOP_500_FILE = DATA_STORAGE / "top500stocks.json"
GICS_MAPPINGS_FILE = DATA_STORAGE / "gics_mappings_500.json"

THEMATIC_CONFIG = {
    "High_Beta": ("beta_universes_500.json", "high"),
    "Low_Beta": ("beta_universes_500.json", "low"),
    "Momentum_Leaders": ("momentum_universes_500.json", "winners"),
    "Momentum_Losers": ("momentum_universes_500.json", "losers"),
    "High_Dividend_Yield": ("dividend_universes_500.json", "high_yield"),
    "Dividend_Growth": ("dividend_universes_500.json", "div_growth"),
    "Risk_Adj_Momentum": ("risk_adj_momentum_500.json", None),
}

def _read_live_parquet(path):
    """Read a live parquet file. Returns None if missing, empty, or contains empty dict."""
    if not path.exists():
        return None
    try:
        df = pd.read_parquet(path)
        if df.empty:
            return None
        return df
    except Exception:
        return None

def _find_basket_parquet(slug):
    """Glob for a basket parquet by slug prefix across basket cache folders. Returns path or None."""
    for folder in BASKET_CACHE_FOLDERS:
        if not folder.exists():
            continue
        matches = list(folder.glob(f'{slug}_*_of_*_signals.parquet'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_signals.parquet'))
        if matches:
            return matches[0]
    return None

def _find_basket_meta(slug):
    """Glob for a basket meta JSON by slug prefix across basket cache folders. Returns path or None."""
    for folder in BASKET_CACHE_FOLDERS:
        if not folder.exists():
            continue
        matches = list(folder.glob(f'{slug}_*_of_*_signals_meta.json'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_signals_meta.json'))
        if matches:
            return matches[0]
    return None


def clean_data_for_json(df):
    return json.loads(df.to_json(orient="records", date_format="iso"))

def get_latest_universe_tickers(basket_name):
    if GICS_MAPPINGS_FILE.exists():
        with open(GICS_MAPPINGS_FILE, 'r') as f:
            gics = json.load(f)
            search_name = basket_name.replace("_", " ")
            # Search in sector_u and industry_u sub-dicts
            for group_key in ('sector_u', 'industry_u'):
                group = gics.get(group_key, {})
                if search_name in group:
                    d = group[search_name]
                    qs = sorted(d.keys())
                    if qs: return list(d[qs[-1]])
    if basket_name in THEMATIC_CONFIG:
        fn, key = THEMATIC_CONFIG[basket_name]
        p_path = THEMATIC_BASKET_CACHE / fn
        if p_path.exists():
            with open(p_path, 'r') as f:
                data = json.load(f)
                ud = data[key] if key is not None else data
                qs = sorted(ud.keys())
                if qs: return list(ud[qs[-1]])
    return []


def get_meta_file_tickers(basket_name):
    meta_file = _find_basket_meta(basket_name)
    if not meta_file:
        return []
    try:
        with open(meta_file, 'r') as f:
            meta = json.load(f)
        weights = meta.get('state', {}).get('weights', {})
        return list(weights.keys())
    except Exception:
        return []




def _get_universe_history(basket_name):
    """Return the quarterly universe dict for a basket: {'2025 Q4': ['AAPL', ...], ...}"""
    if GICS_MAPPINGS_FILE.exists():
        with open(GICS_MAPPINGS_FILE, 'r') as f:
            gics = json.load(f)
        search_name = basket_name.replace("_", " ")
        for group_key in ('sector_u', 'industry_u'):
            group = gics.get(group_key, {})
            if search_name in group:
                return group[search_name]
    if basket_name in THEMATIC_CONFIG:
        fn, key = THEMATIC_CONFIG[basket_name]
        p_path = THEMATIC_BASKET_CACHE / fn
        if p_path.exists():
            with open(p_path, 'r') as f:
                data = json.load(f)
            return data[key] if key is not None else data
    return {}


def _quarter_str_to_date(q_str):
    """Convert '2025 Q4' to pd.Timestamp('2025-10-01')."""
    parts = q_str.split()
    year = int(parts[0])
    qn = int(parts[1][1])
    month = (qn - 1) * 3 + 1
    return pd.Timestamp(year=year, month=month, day=1)


def _get_universe_tickers_for_range(basket_name, start_date, end_date):
    """Return the union of tickers across all quarters overlapping [start_date, end_date]."""
    history = _get_universe_history(basket_name)
    if not history:
        return []
    tickers = set()
    for q_str, q_tickers in history.items():
        q_start = _quarter_str_to_date(q_str)
        qn = int(q_str.split()[1][1])
        q_end_month = qn * 3
        q_end = pd.Timestamp(year=q_start.year, month=q_end_month, day=1) + pd.offsets.MonthEnd(0)
        # Quarter overlaps with range if q_end >= start_date and q_start <= end_date
        if q_end >= start_date and q_start <= end_date:
            tickers.update(q_tickers)
    return list(tickers)


def _get_ticker_join_dates(basket_name, tickers):
    """Return dict of ticker -> pd.Timestamp for when each ticker first appeared in the basket."""
    quarter_data = _get_universe_history(basket_name)
    if not quarter_data:
        return {}
    ticker_set = set(tickers)
    join_dates = {}
    for q in sorted(quarter_data.keys()):
        q_tickers = set(quarter_data[q])
        for t in ticker_set:
            if t in q_tickers and t not in join_dates:
                join_dates[t] = _quarter_str_to_date(q)
    return join_dates


def _get_tickers_for_date(basket_name, target_date):
    """Return the list of tickers that were in the basket at a given date."""
    quarter_data = _get_universe_history(basket_name)
    if not quarter_data:
        return []
    target_ts = pd.Timestamp(target_date)
    # Find the quarter that contains this date (latest quarter start <= target_date)
    best_q = None
    best_ts = None
    for q in sorted(quarter_data.keys()):
        q_ts = _quarter_str_to_date(q)
        if q_ts <= target_ts:
            best_q = q
            best_ts = q_ts
    if best_q is None:
        # Target is before any quarter — use earliest
        qs = sorted(quarter_data.keys())
        best_q = qs[0] if qs else None
    return list(quarter_data[best_q]) if best_q else []



def get_basket_weights_from_contributions(basket_name):
    """Read the latest Weight_BOD per ticker from the contributions parquet."""
    contrib_file = _find_basket_contributions(basket_name)
    if not contrib_file:
        return {}
    try:
        df = pd.read_parquet(contrib_file, columns=['Date', 'Ticker', 'Weight_BOD'])
        if df.empty:
            return {}
        df['Date'] = pd.to_datetime(df['Date'])
        latest = df[df['Date'] == df['Date'].max()]
        return {
            str(row['Ticker']): float(row['Weight_BOD'])
            for _, row in latest.iterrows()
            if pd.notna(row['Weight_BOD'])
        }
    except Exception:
        return {}

def _tally_breadth(tickers, live_close, last_hist):
    """Count uptrend and breakout tickers given live prices and last historical signals."""
    uptrend = bo_seq = total = 0
    for t in tickers:
        if t not in live_close or t not in last_hist.index:
            continue
        total += 1
        lc = live_close[t]
        r = last_hist.loc[t]

        prev_res = r['Resistance_Pivot']
        prev_sup = r['Support_Pivot']
        prev_trend = r['Trend']
        prev_upper = r['Upper_Target']
        prev_lower = r['Lower_Target']
        prev_bo = r['Is_Breakout_Sequence']

        is_up_rot = pd.notna(prev_res) and lc > prev_res
        is_down_rot = pd.notna(prev_sup) and lc < prev_sup

        if is_up_rot:
            trend = True
        elif is_down_rot:
            trend = False
        else:
            trend = bool(prev_trend) if pd.notna(prev_trend) else False

        if trend:
            uptrend += 1

        is_bo = is_up_rot and pd.notna(prev_upper) and lc > prev_upper
        is_bd = is_down_rot and pd.notna(prev_lower) and lc < prev_lower

        if is_bo:
            live_bo = True
        elif is_bd:
            live_bo = False
        else:
            live_bo = bool(prev_bo) if pd.notna(prev_bo) else False

        if live_bo:
            bo_seq += 1

    if total == 0:
        return None
    return {'Uptrend_Pct': round(uptrend / total * 100, 1), 'Breakout_Pct': round(bo_seq / total * 100, 1)}


def _compute_live_breadth(basket_name):
    """Compute live-bar Uptrend_Pct, Breakout_Pct, Correlation_Pct from constituent ticker data."""
    tickers = get_latest_universe_tickers(basket_name)
    if not tickers:
        return {}

    live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
    if live_df is None:
        return {}

    live_prices = live_df[live_df['Ticker'].isin(tickers)].set_index('Ticker')
    if live_prices.empty:
        return {}
    live_close = live_prices['Close'].to_dict()

    needed_cols = ['Ticker', 'Date', 'Close', 'Trend', 'Resistance_Pivot', 'Support_Pivot',
                   'Upper_Target', 'Lower_Target', 'Is_Breakout_Sequence']
    hist = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=needed_cols, filters=[('Ticker', 'in', tickers)])
    last = hist.sort_values('Date').groupby('Ticker').tail(1).set_index('Ticker')

    breadth = _tally_breadth(tickers, live_close, last)
    if breadth is None:
        return {}

    result = dict(breadth)

    # Correlation_Pct: avg pairwise correlation of last 21 days of returns including live
    try:
        close_df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Ticker', 'Date', 'Close'],
                                   filters=[('Ticker', 'in', tickers)])
        pivot = close_df.pivot_table(index='Date', columns='Ticker', values='Close').sort_index()

        # Add live prices as new row
        live_date = pd.to_datetime(live_df['Date'].iloc[0])
        live_series = pd.Series(live_close, name=live_date)
        pivot = pd.concat([pivot, live_series.to_frame().T]).sort_index()

        returns = pivot.pct_change()
        recent = returns.tail(21)
        valid = [c for c in recent.columns if recent[c].notna().sum() >= 10]
        if len(valid) >= 2:
            corr = recent[valid].corr()
            mask = np.triu(np.ones(corr.shape, dtype=bool), k=1)
            vals = corr.values[mask]
            vals = vals[~np.isnan(vals)]
            if len(vals) > 0:
                result['Correlation_Pct'] = round(float(np.mean(vals) * 100), 2)
    except Exception:
        pass

    return result


@app.get("/")
def read_root(): return {"status": "ok", "data_path": str(BASE_DIR)}

@app.get("/api/baskets")
def list_baskets():
    if not DATA_STORAGE.exists(): return {"Themes": [], "Sectors": [], "Industries": []}
    t_names = list(THEMATIC_CONFIG.keys())
    s_names = ["Communication_Services", "Consumer_Discretionary", "Consumer_Staples", "Energy", "Financials", "Health_Care", "Industrials", "Information_Technology", "Materials", "Real_Estate", "Utilities"]
    cats = {"Themes": [], "Sectors": [], "Industries": []}
    for folder in BASKET_CACHE_FOLDERS:
        if not folder.exists():
            continue
        for f in folder.glob("*_of_*_signals.parquet"):
            name = f.stem.rsplit("_signals", 1)[0]
            slug = re.sub(r'(_\d+)?_of_\d+$', '', name)
            if slug in t_names: cats["Themes"].append(slug)
            elif slug in s_names: cats["Sectors"].append(slug)
            else: cats["Industries"].append(slug)
    for k in cats: cats[k] = sorted(set(cats[k]))
    return cats

@app.get("/api/baskets/compositions")
def get_basket_compositions():
    """Return per-quarter ticker lists for every basket (sectors, industries, themes)."""
    result = {}
    # Sectors and Industries from GICS mappings
    if GICS_MAPPINGS_FILE.exists():
        with open(GICS_MAPPINGS_FILE, 'r') as f:
            gics = json.load(f)
        for group_key in ('sector_u', 'industry_u'):
            group = gics.get(group_key, {})
            for name, quarter_dict in group.items():
                slug = name.replace(" ", "_")
                result[slug] = {q: sorted(tickers) for q, tickers in quarter_dict.items()}
    # Themes from thematic config JSON files
    for basket_name, (fn, key) in THEMATIC_CONFIG.items():
        p_path = THEMATIC_BASKET_CACHE / fn
        if p_path.exists():
            try:
                with open(p_path, 'r') as f:
                    data = json.load(f)
                ud = data[key] if key is not None else data
                result[basket_name] = {q: sorted(tickers) for q, tickers in ud.items()}
            except Exception:
                pass
    return result

@app.get("/api/baskets/breadth")
def get_basket_breadth():
    """Return latest Uptrend_Pct and Breakout_Pct for every basket."""
    result = {}
    for folder in BASKET_CACHE_FOLDERS:
        if not folder.exists():
            continue
        for f in folder.glob("*_of_*_signals.parquet"):
            slug = re.sub(r'(_\d+)?_of_\d+_signals$', '', f.stem)
            if slug in result:
                continue
            try:
                sig_cols = ['Date', 'Close', 'Uptrend_Pct', 'Breakout_Pct', 'Correlation_Pct',
                            'Trend', 'Is_Breakout_Sequence',
                            'Resistance_Pivot', 'Support_Pivot', 'Upper_Target', 'Lower_Target',
                            'BTFD_Entry_Price', 'BTFD_Exit_Date', 'STFR_Entry_Price', 'STFR_Exit_Date']
                df = pd.read_parquet(f, columns=sig_cols)
                if df.empty:
                    continue
                df = df.sort_values('Date')
                last = df.iloc[-1]
                entry = {}
                if pd.notna(last.get('Uptrend_Pct')):
                    entry['uptrend_pct'] = round(float(last['Uptrend_Pct']), 1)
                if pd.notna(last.get('Breakout_Pct')):
                    entry['breakout_pct'] = round(float(last['Breakout_Pct']), 1)
                if pd.notna(last.get('Correlation_Pct')):
                    entry['corr_pct'] = round(float(last['Correlation_Pct']), 1)
                entry['st_trend'] = 'UP' if last.get('Trend') else 'DN'
                entry['lt_trend'] = 'BO' if last.get('Is_Breakout_Sequence') else 'BD'
                # Mean reversion
                btfd_open = pd.notna(last.get('BTFD_Entry_Price')) and pd.isna(last.get('BTFD_Exit_Date'))
                stfr_open = pd.notna(last.get('STFR_Entry_Price')) and pd.isna(last.get('STFR_Exit_Date'))
                if btfd_open and stfr_open:
                    entry['mean_rev'] = 'BTFD'  # prefer BTFD for baskets
                elif btfd_open:
                    entry['mean_rev'] = 'BTFD'
                elif stfr_open:
                    entry['mean_rev'] = 'STFR'
                # Pct change from last 2 closes
                if len(df) >= 2:
                    prev_close = df.iloc[-2]['Close']
                    curr_close = last['Close']
                    if pd.notna(prev_close) and pd.notna(curr_close) and prev_close != 0:
                        entry['pct_change'] = round(float(curr_close / prev_close - 1) * 100, 2)
                # Stash pivots and prev close for live overlay
                entry['_pivots'] = {
                    'Trend': last.get('Trend'),
                    'Is_Breakout_Sequence': last.get('Is_Breakout_Sequence'),
                    'Resistance_Pivot': last.get('Resistance_Pivot'),
                    'Support_Pivot': last.get('Support_Pivot'),
                    'Upper_Target': last.get('Upper_Target'),
                    'Lower_Target': last.get('Lower_Target'),
                }
                entry['_prev_close'] = float(last['Close']) if pd.notna(last.get('Close')) else None
                result[slug] = entry
            except Exception:
                continue

    # Overlay live breadth values (single batch read of signals parquet)
    try:
        live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
        if live_df is not None:
            live_close = live_df.set_index('Ticker')['Close'].to_dict()
            needed_cols = ['Ticker', 'Date', 'Trend', 'Resistance_Pivot', 'Support_Pivot',
                           'Upper_Target', 'Lower_Target', 'Is_Breakout_Sequence']
            hist = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=needed_cols,
                                   filters=[('Ticker', 'in', list(live_close.keys()))])
            last_hist = hist.sort_values('Date').groupby('Ticker').tail(1).set_index('Ticker')

            for slug in list(result.keys()):
                tickers = get_latest_universe_tickers(slug)
                if not tickers:
                    continue
                breadth = _tally_breadth(tickers, live_close, last_hist)
                if breadth:
                    result[slug]['uptrend_pct'] = breadth['Uptrend_Pct']
                    result[slug]['breakout_pct'] = breadth['Breakout_Pct']
    except Exception:
        pass

    # Overlay live basket equity curve signals using live basket OHLC + cached pivots
    try:
        live_basket_df = _read_live_parquet(LIVE_BASKET_SIGNALS_FILE)
        if live_basket_df is not None:
            name_col = 'BasketName' if 'BasketName' in live_basket_df.columns else 'Basket'
            for slug, entry in result.items():
                pivots = entry.get('_pivots')
                if not pivots:
                    continue
                basket_name_spaced = slug.replace('_', ' ')
                live_row = live_basket_df[live_basket_df[name_col].str.endswith(basket_name_spaced)]
                if live_row.empty:
                    continue
                lc = float(live_row.iloc[0]['Close'])

                prev_res = pivots['Resistance_Pivot']
                prev_sup = pivots['Support_Pivot']
                is_up = pd.notna(prev_res) and lc > prev_res
                is_dn = pd.notna(prev_sup) and lc < prev_sup

                if is_up:
                    entry['st_trend'] = 'UP'
                elif is_dn:
                    entry['st_trend'] = 'DN'

                prev_upper = pivots['Upper_Target']
                prev_lower = pivots['Lower_Target']
                is_bo = is_up and pd.notna(prev_upper) and lc > prev_upper
                is_bd = is_dn and pd.notna(prev_lower) and lc < prev_lower

                if is_bo:
                    entry['lt_trend'] = 'BO'
                elif is_bd:
                    entry['lt_trend'] = 'BD'

                # Live pct_change from cached prev close
                prev_close = entry.get('_prev_close')
                if prev_close and prev_close != 0:
                    entry['pct_change'] = round(float(lc / prev_close - 1) * 100, 2)
    except Exception:
        pass

    # Strip internal fields before returning
    for entry in result.values():
        entry.pop('_pivots', None)
        entry.pop('_prev_close', None)

    return result

logger.info(f"BASE_DIR: {BASE_DIR} (exists={BASE_DIR.exists()})")
logger.info(f"DATA_STORAGE: {DATA_STORAGE} (exists={DATA_STORAGE.exists()})")
logger.info(f"INDIVIDUAL_SIGNALS_FILE: {INDIVIDUAL_SIGNALS_FILE} (exists={INDIVIDUAL_SIGNALS_FILE.exists()})")

@app.get("/api/baskets/{basket_name}")
def get_basket_data(basket_name: str):
    basket_file = _find_basket_parquet(basket_name)
    if not basket_file:
        raise HTTPException(status_code=404, detail=f"Basket file not found for {basket_name}")
    try:
        df = pd.read_parquet(basket_file)
        df['Date'] = pd.to_datetime(df['Date'])

        # Merge live basket data for today's candle with recomputed signals
        live_basket_df = _read_live_parquet(LIVE_BASKET_SIGNALS_FILE)
        if live_basket_df is not None:
            name_col = 'BasketName' if 'BasketName' in live_basket_df.columns else 'Basket'
            basket_name_spaced = basket_name.replace('_', ' ')
            live_row = live_basket_df[live_basket_df[name_col].str.endswith(basket_name_spaced)]
            if not live_row.empty:
                live_row = live_row.copy()
                live_row['Date'] = pd.to_datetime(live_row['Date'])
                live_row = live_row.drop(columns=[name_col])

                # Recompute basket-level signals (pivots, targets) on combined OHLC
                ohlc_cols = [c for c in ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'] if c in df.columns]
                live_ohlc = live_row[[c for c in ohlc_cols if c in live_row.columns]].copy()
                if 'Volume' not in live_ohlc.columns:
                    live_ohlc['Volume'] = 0
                combined_ohlc = pd.concat([df[ohlc_cols], live_ohlc], ignore_index=True)
                combined_ohlc = combined_ohlc.drop_duplicates(subset=['Date'], keep='last').sort_values('Date')

                ticker_label = df['Ticker'].iloc[0] if 'Ticker' in df.columns and not df['Ticker'].isna().all() else basket_name.upper()
                recomputed = signals_engine._build_signals_from_df(combined_ohlc.set_index('Date'), ticker_label)

                if recomputed is not None and not recomputed.empty:
                    # Take only the live bar's recomputed signals
                    live_computed = recomputed.iloc[[-1]].copy()

                    # Compute breadth metrics for the live bar
                    breadth = _compute_live_breadth(basket_name)
                    for col, val in breadth.items():
                        live_computed[col] = val

                    df = pd.concat([df, live_computed], ignore_index=True)
                    df = df.drop_duplicates(subset=['Date'], keep='last')
                else:
                    # Fallback: just append OHLC
                    df = pd.concat([df, live_row], ignore_index=True)
                    df = df.drop_duplicates(subset=['Date'], keep='last')

        current_weights = get_basket_weights_from_contributions(basket_name)
        if current_weights:
            tickers = sorted([{"symbol": s, "weight": float(w)} for s, w in current_weights.items()], key=lambda x: x['weight'], reverse=True)
        else:
            latest_universe = get_latest_universe_tickers(basket_name)
            tickers = [{"symbol": symbol, "weight": 0.0} for symbol in latest_universe]

        return {"chart_data": clean_data_for_json(df), "tickers": tickers}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tickers")
def list_tickers():
    if TOP_500_FILE.exists():
        try:
            with open(TOP_500_FILE, 'r') as f:
                data = json.load(f)
                qs = sorted(data.keys())
                if qs: return sorted(list(data[qs[-1]]))
        except: pass
    if not INDIVIDUAL_SIGNALS_FILE.exists(): return []
    try:
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Ticker'])
        return sorted(df['Ticker'].dropna().unique().tolist())
    except: raise HTTPException(status_code=500)

@app.get("/api/tickers/quarters")
def list_tickers_by_quarter():
    """Return all quarters and their ticker universes from top500stocks.json."""
    if not TOP_500_FILE.exists():
        return {"quarters": [], "tickers_by_quarter": {}}
    try:
        with open(TOP_500_FILE, 'r') as f:
            data = json.load(f)
        quarters = sorted(data.keys(), reverse=True)
        tickers_by_quarter = {q: sorted(data[q]) for q in quarters}
        return {"quarters": quarters, "tickers_by_quarter": tickers_by_quarter}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/live-signals")
def list_live_signal_tickers():
    """Return sorted list of tickers where a signal fires TODAY (recomputed with live prices)."""
    if not INDIVIDUAL_SIGNALS_FILE.exists():
        return []
    try:
        # Universe filter
        universe = None
        if TOP_500_FILE.exists():
            try:
                with open(TOP_500_FILE, 'r') as f:
                    data = json.load(f)
                    qs = sorted(data.keys())
                    if qs:
                        universe = set(data[qs[-1]])
            except:
                pass

        # Only read columns needed by _build_signals_next_row (avoids loading 50+ unused columns)
        _SIGNAL_COLS = [
            'Ticker', 'Date', 'Close',
            'RV_EMA', 'Trend', 'Resistance_Pivot', 'Support_Pivot',
            'Rotation_ID', 'Up_Range_EMA', 'Down_Range_EMA', 'Up_Range', 'Down_Range',
            'Rotation_Open', 'Upper_Target', 'Lower_Target',
            'BTFD_Triggered', 'STFR_Triggered',
            'Is_Breakout', 'Is_Breakdown', 'Is_Breakout_Sequence',
        ]
        cutoff = pd.Timestamp(datetime.now() - timedelta(days=14))
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=_SIGNAL_COLS,
                             filters=[('Date', '>=', cutoff)])
        df = df.sort_values('Date')
        latest = df.groupby('Ticker').tail(1)

        # Exclude delisted tickers
        max_date = latest['Date'].max()
        latest = latest[latest['Date'] >= max_date]
        if universe is not None:
            latest = latest[latest['Ticker'].isin(universe)]

        # Read live OHLC
        live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
        if live_df is None or live_df.empty:
            return []  # No live data → no live signals

        live_ohlc = {}
        for _, lr in live_df.iterrows():
            t = lr.get('Ticker')
            if t and pd.notna(lr.get('Close')):
                live_ohlc[t] = {
                    'Close': float(lr['Close']),
                    'Open': float(lr['Open']) if pd.notna(lr.get('Open')) else None,
                    'High': float(lr['High']) if pd.notna(lr.get('High')) else None,
                    'Low': float(lr['Low']) if pd.notna(lr.get('Low')) else None,
                }

        now = datetime.now()

        signal_flag_to_name = {
            'Is_Up_Rotation': 'Up_Rot', 'Is_Down_Rotation': 'Down_Rot',
            'Is_Breakout': 'Breakout', 'Is_Breakdown': 'Breakdown',
            'Is_BTFD': 'BTFD', 'Is_STFR': 'STFR',
        }

        results = []
        for _, row in latest.iterrows():
            ticker = row['Ticker']
            if ticker not in live_ohlc:
                continue
            ohlc = live_ohlc[ticker]
            new_row = signals_engine._build_signals_next_row(
                row, ohlc['Close'], now,
                live_high=ohlc.get('High'),
                live_low=ohlc.get('Low'),
                live_open=ohlc.get('Open'),
            )
            if new_row is None:
                continue
            fired = [name for flag_col, name in signal_flag_to_name.items()
                     if bool(new_row.get(flag_col, False))]
            if fired:
                results.append({"symbol": ticker, "signals": fired})

        results.sort(key=lambda x: x["symbol"])
        return results
    except Exception as e:
        logger.exception("live-signals failed")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/ticker-signals")
def get_ticker_signals():
    """Return per-ticker signal summary: LT trend, ST trend, mean reversion, and daily % change."""
    if not INDIVIDUAL_SIGNALS_FILE.exists():
        return {}
    try:
        cols = ['Ticker', 'Date', 'Close', 'Volume', 'Trend', 'Is_Breakout_Sequence',
                'Is_BTFD', 'Is_STFR', 'BTFD_Entry_Price', 'BTFD_Exit_Date',
                'STFR_Entry_Price', 'STFR_Exit_Date']
        cutoff = pd.Timestamp(datetime.now() - timedelta(days=14))
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=cols,
                             filters=[('Date', '>=', cutoff)])
        df = df.sort_values(['Ticker', 'Date'])

        # Track last BTFD/STFR entry dates per ticker
        btfd_last_entry = {}
        stfr_last_entry = {}
        for _, r in df.iterrows():
            t = r['Ticker']
            if r.get('Is_BTFD', False):
                btfd_last_entry[t] = r['Date']
            if r.get('Is_STFR', False):
                stfr_last_entry[t] = r['Date']

        # Get last 2 rows per ticker for pct_change calculation
        last2 = df.groupby('Ticker').tail(2)

        result = {}
        for ticker, group in last2.groupby('Ticker'):
            rows = group.sort_values('Date')
            final = rows.iloc[-1]

            # LT Trend from Is_Breakout_Sequence
            lt = None
            val = final.get('Is_Breakout_Sequence')
            if pd.notna(val):
                lt = 'BO' if bool(val) else 'BD'

            # ST Trend from Trend
            st = None
            trend_val = final.get('Trend')
            if pd.notna(trend_val):
                st = 'Up' if int(trend_val) == 1 else 'Dn'

            # Mean Reversion (open trade state from Entry_Price/Exit_Date)
            mr = None
            btfd_open = pd.notna(final.get('BTFD_Entry_Price')) and pd.isna(final.get('BTFD_Exit_Date'))
            stfr_open = pd.notna(final.get('STFR_Entry_Price')) and pd.isna(final.get('STFR_Exit_Date'))
            if btfd_open and stfr_open:
                bd = btfd_last_entry.get(ticker)
                sd = stfr_last_entry.get(ticker)
                mr = 'STFR' if sd and (not bd or sd > bd) else 'BTFD'
            elif btfd_open:
                mr = 'BTFD'
            elif stfr_open:
                mr = 'STFR'

            # Pct change from last 2 closes
            pct = None
            if len(rows) >= 2:
                prev_close = rows.iloc[-2]['Close']
                curr_close = final['Close']
                if pd.notna(prev_close) and pd.notna(curr_close) and prev_close != 0:
                    pct = round(float(curr_close / prev_close - 1) * 100, 2)

            # Dollar volume from latest row
            dv = None
            if pd.notna(final.get('Close')) and pd.notna(final.get('Volume')):
                dv = round(float(final['Close']) * float(final['Volume']))

            result[ticker] = {
                'lt_trend': lt,
                'st_trend': st,
                'mean_rev': mr,
                'pct_change': float(pct) if pct is not None else None,
                'dollar_vol': int(dv) if dv is not None else None,
            }

        # Override pct_change with live data if available
        live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
        if live_df is not None and not live_df.empty:
            for _, lr in live_df.iterrows():
                t = lr.get('Ticker')
                if t and pd.notna(lr.get('Close')) and t in result:
                    ticker_rows = last2[last2['Ticker'] == t].sort_values('Date')
                    if len(ticker_rows) >= 1:
                        prev_close = ticker_rows.iloc[-1]['Close']
                        live_close = float(lr['Close'])
                        if pd.notna(prev_close) and prev_close != 0:
                            result[t]['pct_change'] = round(float(live_close / prev_close - 1) * 100, 2)

        return result
    except Exception as e:
        logger.exception("ticker-signals failed")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tickers/{ticker}")
def get_ticker_data(ticker: str):
    if not INDIVIDUAL_SIGNALS_FILE.exists(): raise HTTPException(status_code=404)
    try:
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, filters=[('Ticker', '==', ticker)])
        df['Date'] = pd.to_datetime(df['Date'])

        # Merge live bar using incremental signal computation (matches live-signals endpoint)
        live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
        if live_df is not None:
            live_row = live_df[live_df['Ticker'] == ticker]
            if not live_row.empty:
                lr = live_row.iloc[0]
                live_date = pd.to_datetime(lr['Date'])

                # Drop any existing row for today (in case cached parquet already has it)
                df = df[df['Date'] < live_date]

                # Use last cached row + _build_signals_next_row (same path as /api/live-signals)
                prev = df.sort_values('Date').iloc[-1]
                ohlc = {
                    'Close': float(lr['Close']) if pd.notna(lr.get('Close')) else None,
                    'Open':  float(lr['Open'])  if pd.notna(lr.get('Open'))  else None,
                    'High':  float(lr['High'])  if pd.notna(lr.get('High'))  else None,
                    'Low':   float(lr['Low'])   if pd.notna(lr.get('Low'))   else None,
                }
                if ohlc['Close'] is not None:
                    new_row = signals_engine._build_signals_next_row(
                        prev, ohlc['Close'], live_date,
                        live_high=ohlc.get('High'),
                        live_low=ohlc.get('Low'),
                        live_open=ohlc.get('Open'),
                    )
                    if new_row is not None:
                        live_bar = pd.DataFrame([new_row])
                        live_bar['Source'] = 'live'
                        df = pd.concat([df, live_bar], ignore_index=True)

        df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')
        return {"chart_data": clean_data_for_json(df.sort_values('Date')), "tickers": []}
    except Exception: raise HTTPException(status_code=500)


SIGNAL_TYPES = ['Breakout', 'Breakdown', 'Up_Rot', 'Down_Rot', 'BTFD', 'STFR']
SIGNAL_PAIRS = [('Breakout', 'Breakdown'), ('Up_Rot', 'Down_Rot'), ('BTFD', 'STFR')]
# The Is_ columns in the parquet use different names for rotations
SIGNAL_IS_COL = {
    'Breakout': 'Is_Breakout', 'Breakdown': 'Is_Breakdown',
    'Up_Rot': 'Is_Up_Rotation', 'Down_Rot': 'Is_Down_Rotation',
    'BTFD': 'Is_BTFD', 'STFR': 'Is_STFR',
}
BACKTEST_DIRECTION = {
    "Up_Rot": "long", "Down_Rot": "short",
    "Breakout": "long", "Breakdown": "short",
    "BTFD": "long", "STFR": "short",
}


def safe_float(value, digits=4):
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)


def safe_int(value):
    if value is None or pd.isna(value):
        return 0
    return int(value)

@app.get("/api/baskets/{basket_name}/summary")
def get_basket_summary(basket_name: str, start: str = None, end: str = None):
    if not INDIVIDUAL_SIGNALS_FILE.exists():
        raise HTTPException(status_code=404, detail="Signals file not found")
    try:
        range_start = pd.Timestamp(start) if start else None
        range_end = pd.Timestamp(end) if end else None
        is_range_mode = range_start is not None and range_end is not None

        # Build per-quarter membership lookup for range mode
        quarter_membership = {}  # quarter_str -> set of tickers
        last_quarter_tickers = set()
        if is_range_mode:
            history = _get_universe_history(basket_name)
            for q_str, q_tickers in history.items():
                q_start = _quarter_str_to_date(q_str)
                qn = int(q_str.split()[1][1])
                q_end = pd.Timestamp(year=q_start.year, month=qn * 3, day=1) + pd.offsets.MonthEnd(0)
                if q_end >= range_start and q_start <= range_end:
                    quarter_membership[q_str] = set(q_tickers)
            # Last quarter in range = the one with the latest start date
            if quarter_membership:
                last_q = sorted(quarter_membership.keys())[-1]
                last_quarter_tickers = quarter_membership[last_q]
            # Union of all tickers for data loading
            tickers = list(set().union(*quarter_membership.values())) if quarter_membership else []
        else:
            tickers = get_latest_universe_tickers(basket_name)
        if not tickers:
            tickers = get_meta_file_tickers(basket_name)
        if not tickers:
            raise HTTPException(status_code=404, detail="No tickers found for basket")

        # --- Open Signals ---
        STAT_SUFFIXES = [
            'Entry_Price', 'Exit_Date',
            'Win_Rate', 'Avg_Winner', 'Avg_Loser', 'Avg_Winner_Bars', 'Avg_Loser_Bars',
            'Avg_MFE', 'Avg_MAE',
            'Std_Dev', 'Historical_EV', 'EV_Last_3',
            'Risk_Adj_EV', 'Risk_Adj_EV_Last_3', 'Count',
        ]
        cols_needed = ['Ticker', 'Date', 'Close', 'Trend', 'Is_Breakout_Sequence',
                       'Resistance_Pivot', 'Support_Pivot', 'Upper_Target', 'Lower_Target',
                       'BTFD_Triggered', 'STFR_Triggered']
        for st in SIGNAL_TYPES:
            cols_needed.append(SIGNAL_IS_COL[st])
            for suf in STAT_SUFFIXES:
                cols_needed.append(f'{st}_{suf}')
        df = pd.read_parquet(
            INDIVIDUAL_SIGNALS_FILE,
            columns=cols_needed,
            filters=[('Ticker', 'in', tickers)],
        )
        df = df.sort_values('Date')

        # Filter by end date if range mode
        if range_end is not None:
            df = df[df['Date'] <= range_end]

        # For each ticker and signal pair, find which signal fired most recently
        # so we only report one open signal per pair per ticker.
        # Also track closed trades when in range mode.
        SHORT_SIGNALS = {'Down_Rot', 'Breakdown', 'STFR'}
        last_fired = {}  # (ticker, pair_index) -> (signal_type, entry_date, entry_price)
        closed_signals = []
        btfd_last_entry = {}  # ticker -> (entry_date, entry_price)
        stfr_last_entry = {}  # ticker -> (entry_date, entry_price)
        btfd_prev_exit_date = {}  # ticker -> previous BTFD_Exit_Date
        stfr_prev_exit_date = {}  # ticker -> previous STFR_Exit_Date
        for _, row in df.iterrows():
            ticker = row['Ticker']
            row_date = row['Date']
            for pi, (s1, s2) in enumerate(SIGNAL_PAIRS[:2]):
                # Determine which signal fires on this row (s2 wins if both fire)
                new_sig = None
                if row.get(SIGNAL_IS_COL[s1], False):
                    new_sig = s1
                if row.get(SIGNAL_IS_COL[s2], False):
                    new_sig = s2

                if new_sig is not None:
                    key = (ticker, pi)
                    prev = last_fired.get(key)
                    # If signal changed, the previous trade is closed
                    if is_range_mode and prev is not None and prev[0] != new_sig and row_date >= range_start:
                        prev_sig, prev_entry_date, prev_entry_price = prev
                        exit_price = row['Close']
                        perf = None
                        if pd.notna(prev_entry_price) and prev_entry_price:
                            ep = float(prev_entry_price)
                            xp = float(exit_price)
                            perf = (ep - xp) / ep if prev_sig in SHORT_SIGNALS else (xp - ep) / ep
                        entry_date_str = pd.Timestamp(prev_entry_date).strftime('%Y-%m-%d') if pd.notna(prev_entry_date) else None
                        exit_date_str = pd.Timestamp(row_date).strftime('%Y-%m-%d') if pd.notna(row_date) else None
                        closed_signals.append({
                            'Ticker': ticker, 'Signal_Type': prev_sig,
                            'Entry_Date': entry_date_str, 'Exit_Date': exit_date_str,
                            'Close': safe_float(exit_price, 2),
                            'Entry_Price': safe_float(prev_entry_price, 2),
                            'Current_Performance': safe_float(perf, 4),
                            'Win_Rate': safe_float(row.get(f'{prev_sig}_Win_Rate')),
                            'Avg_Winner': safe_float(row.get(f'{prev_sig}_Avg_Winner')),
                            'Avg_Loser': safe_float(row.get(f'{prev_sig}_Avg_Loser')),
                            'Avg_Winner_Bars': safe_float(row.get(f'{prev_sig}_Avg_Winner_Bars'), 1),
                            'Avg_Loser_Bars': safe_float(row.get(f'{prev_sig}_Avg_Loser_Bars'), 1),
                            'Avg_MFE': safe_float(row.get(f'{prev_sig}_Avg_MFE')),
                            'Avg_MAE': safe_float(row.get(f'{prev_sig}_Avg_MAE')),
                            'Std_Dev': safe_float(row.get(f'{prev_sig}_Std_Dev')),
                            'Historical_EV': safe_float(row.get(f'{prev_sig}_Historical_EV')),
                            'EV_Last_3': safe_float(row.get(f'{prev_sig}_EV_Last_3')),
                            'Risk_Adj_EV': safe_float(row.get(f'{prev_sig}_Risk_Adj_EV')),
                            'Risk_Adj_EV_Last_3': safe_float(row.get(f'{prev_sig}_Risk_Adj_EV_Last_3')),
                            'Count': safe_int(row.get(f'{prev_sig}_Count')),
                            'Is_Live': False,
                        })
                    # Store entry price at fire time so it's available when the trade closes
                    new_entry_price = row.get(f'{new_sig}_Entry_Price')
                    last_fired[key] = (new_sig, row_date, new_entry_price)

            # Track BTFD/STFR independently (not paired)
            if row.get(SIGNAL_IS_COL['BTFD'], False):
                btfd_last_entry[ticker] = (row_date, row.get('BTFD_Entry_Price'))
            if row.get(SIGNAL_IS_COL['STFR'], False):
                stfr_last_entry[ticker] = (row_date, row.get('STFR_Entry_Price'))

            # Detect BTFD/STFR closes via Exit_Date transition (for range mode)
            if is_range_mode and row_date >= range_start:
                for mr_sig, mr_entry_dict, mr_prev_exit_dict, mr_exit_col in [
                    ('BTFD', btfd_last_entry, btfd_prev_exit_date, 'BTFD_Exit_Date'),
                    ('STFR', stfr_last_entry, stfr_prev_exit_date, 'STFR_Exit_Date'),
                ]:
                    cur_exit = row.get(mr_exit_col)
                    prev_exit = mr_prev_exit_dict.get(ticker)
                    if pd.notna(cur_exit) and (prev_exit is None or pd.isna(prev_exit)):
                        prev_info = mr_entry_dict.get(ticker)
                        if prev_info is not None:
                            prev_entry_date, prev_entry_price = prev_info
                            exit_price = row['Close']
                            perf = None
                            if pd.notna(prev_entry_price) and prev_entry_price:
                                ep = float(prev_entry_price)
                                xp = float(exit_price)
                                perf = (ep - xp) / ep if mr_sig in SHORT_SIGNALS else (xp - ep) / ep
                            entry_date_str = pd.Timestamp(prev_entry_date).strftime('%Y-%m-%d') if pd.notna(prev_entry_date) else None
                            exit_date_str = pd.Timestamp(row_date).strftime('%Y-%m-%d') if pd.notna(row_date) else None
                            closed_signals.append({
                                'Ticker': ticker, 'Signal_Type': mr_sig,
                                'Entry_Date': entry_date_str, 'Exit_Date': exit_date_str,
                                'Close': safe_float(exit_price, 2),
                                'Entry_Price': safe_float(prev_entry_price, 2),
                                'Current_Performance': safe_float(perf, 4),
                                'Win_Rate': safe_float(row.get(f'{mr_sig}_Win_Rate')),
                                'Avg_Winner': safe_float(row.get(f'{mr_sig}_Avg_Winner')),
                                'Avg_Loser': safe_float(row.get(f'{mr_sig}_Avg_Loser')),
                                'Avg_Winner_Bars': safe_float(row.get(f'{mr_sig}_Avg_Winner_Bars'), 1),
                                'Avg_Loser_Bars': safe_float(row.get(f'{mr_sig}_Avg_Loser_Bars'), 1),
                                'Avg_MFE': safe_float(row.get(f'{mr_sig}_Avg_MFE')),
                                'Avg_MAE': safe_float(row.get(f'{mr_sig}_Avg_MAE')),
                                'Std_Dev': safe_float(row.get(f'{mr_sig}_Std_Dev')),
                                'Historical_EV': safe_float(row.get(f'{mr_sig}_Historical_EV')),
                                'EV_Last_3': safe_float(row.get(f'{mr_sig}_EV_Last_3')),
                                'Risk_Adj_EV': safe_float(row.get(f'{mr_sig}_Risk_Adj_EV')),
                                'Risk_Adj_EV_Last_3': safe_float(row.get(f'{mr_sig}_Risk_Adj_EV_Last_3')),
                                'Count': safe_int(row.get(f'{mr_sig}_Count')),
                                'Is_Live': False,
                            })
            btfd_prev_exit_date[ticker] = row.get('BTFD_Exit_Date')
            stfr_prev_exit_date[ticker] = row.get('STFR_Exit_Date')

        latest = df.groupby('Ticker').tail(1)

        if is_range_mode:
            # In range mode, don't exclude delisted tickers
            pass
        else:
            # Exclude delisted tickers whose data ends before the most recent date
            max_date = latest['Date'].max()
            latest = latest[latest['Date'] >= max_date]

        # Read live closes for intraday price updates (skip in range mode)
        live_closes = {}
        if not is_range_mode:
            live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
            if live_df is not None:
                for _, lr in live_df.iterrows():
                    t = lr.get('Ticker')
                    c = lr.get('Close')
                    if t and pd.notna(c):
                        live_closes[t] = float(c)

        open_signals = []
        for _, row in latest.iterrows():
            ticker = row['Ticker']
            hist_close = row['Close']

            # --- Live state recomputation (same pivot logic as _compute_live_breadth) ---
            if ticker in live_closes:
                close = live_closes[ticker]
                prev_res = row.get('Resistance_Pivot')
                prev_sup = row.get('Support_Pivot')
                prev_upper = row.get('Upper_Target')
                prev_lower = row.get('Lower_Target')
                is_up_rot = pd.notna(prev_res) and close > prev_res
                is_down_rot = pd.notna(prev_sup) and close < prev_sup

                if is_up_rot:
                    live_trend = 1.0
                elif is_down_rot:
                    live_trend = 0.0
                else:
                    live_trend = row.get('Trend')

                is_bo = is_up_rot and pd.notna(prev_upper) and close > prev_upper
                is_bd = is_down_rot and pd.notna(prev_lower) and close < prev_lower
                if is_bo:
                    live_bos = True
                elif is_bd:
                    live_bos = False
                else:
                    live_bos = row.get('Is_Breakout_Sequence', False)
            else:
                close = hist_close
                live_trend = row.get('Trend')
                live_bos = row.get('Is_Breakout_Sequence', False)

            # --- LT Trend (Breakout/Breakdown): always present for every ticker ---
            bos = live_bos
            lt_active = 'Breakout' if bos else 'Breakdown'
            lt_is_live = bool(bos != row.get('Is_Breakout_Sequence', False)) and ticker in live_closes
            lt_fired = last_fired.get((ticker, 0))
            lt_entry_date = lt_fired[1] if lt_fired and lt_fired[0] == lt_active else None
            lt_entry_price = row.get(f'{lt_active}_Entry_Price')
            if pd.notna(lt_entry_price) and lt_entry_price:
                lt_perf = ((lt_entry_price - close) / lt_entry_price if lt_active in SHORT_SIGNALS
                           else (close - lt_entry_price) / lt_entry_price)
            else:
                lt_perf = None
            lt_date_str = pd.Timestamp(lt_entry_date).strftime('%Y-%m-%d') if pd.notna(lt_entry_date) else None
            open_signals.append({
                'Ticker': ticker, 'Signal_Type': lt_active,
                'Entry_Date': lt_date_str,
                'Close': safe_float(close, 2),
                'Entry_Price': safe_float(lt_entry_price, 2),
                'Current_Performance': safe_float(lt_perf, 4),
                'Win_Rate': safe_float(row.get(f'{lt_active}_Win_Rate')),
                'Avg_Winner': safe_float(row.get(f'{lt_active}_Avg_Winner')),
                'Avg_Loser': safe_float(row.get(f'{lt_active}_Avg_Loser')),
                'Avg_Winner_Bars': safe_float(row.get(f'{lt_active}_Avg_Winner_Bars'), 1),
                'Avg_Loser_Bars': safe_float(row.get(f'{lt_active}_Avg_Loser_Bars'), 1),
                'Avg_MFE': safe_float(row.get(f'{lt_active}_Avg_MFE')),
                'Avg_MAE': safe_float(row.get(f'{lt_active}_Avg_MAE')),
                'Std_Dev': safe_float(row.get(f'{lt_active}_Std_Dev')),
                'Historical_EV': safe_float(row.get(f'{lt_active}_Historical_EV')),
                'EV_Last_3': safe_float(row.get(f'{lt_active}_EV_Last_3')),
                'Risk_Adj_EV': safe_float(row.get(f'{lt_active}_Risk_Adj_EV')),
                'Risk_Adj_EV_Last_3': safe_float(row.get(f'{lt_active}_Risk_Adj_EV_Last_3')),
                'Count': safe_int(row.get(f'{lt_active}_Count')),
                'Is_Live': lt_is_live,
            })

            # --- ST Trend (Up_Rot/Down_Rot): always present for every ticker ---
            trend_val = live_trend
            if pd.notna(trend_val):
                st_active = 'Up_Rot' if trend_val == 1.0 else 'Down_Rot'
            else:
                st_active = 'Down_Rot'  # default to downtrend if unknown
            hist_trend = row.get('Trend')
            st_is_live = bool(
                ticker in live_closes
                and pd.notna(live_trend) and pd.notna(hist_trend)
                and live_trend != hist_trend
            )
            st_fired = last_fired.get((ticker, 1))
            st_entry_date = st_fired[1] if st_fired and st_fired[0] == st_active else None
            st_entry_price = row.get(f'{st_active}_Entry_Price')
            if pd.notna(st_entry_price) and st_entry_price:
                st_perf = ((st_entry_price - close) / st_entry_price if st_active in SHORT_SIGNALS
                           else (close - st_entry_price) / st_entry_price)
            else:
                st_perf = None
            st_date_str = pd.Timestamp(st_entry_date).strftime('%Y-%m-%d') if pd.notna(st_entry_date) else None
            open_signals.append({
                'Ticker': ticker, 'Signal_Type': st_active,
                'Entry_Date': st_date_str,
                'Close': safe_float(close, 2),
                'Entry_Price': safe_float(st_entry_price, 2),
                'Current_Performance': safe_float(st_perf, 4),
                'Win_Rate': safe_float(row.get(f'{st_active}_Win_Rate')),
                'Avg_Winner': safe_float(row.get(f'{st_active}_Avg_Winner')),
                'Avg_Loser': safe_float(row.get(f'{st_active}_Avg_Loser')),
                'Avg_Winner_Bars': safe_float(row.get(f'{st_active}_Avg_Winner_Bars'), 1),
                'Avg_Loser_Bars': safe_float(row.get(f'{st_active}_Avg_Loser_Bars'), 1),
                'Avg_MFE': safe_float(row.get(f'{st_active}_Avg_MFE')),
                'Avg_MAE': safe_float(row.get(f'{st_active}_Avg_MAE')),
                'Std_Dev': safe_float(row.get(f'{st_active}_Std_Dev')),
                'Historical_EV': safe_float(row.get(f'{st_active}_Historical_EV')),
                'EV_Last_3': safe_float(row.get(f'{st_active}_EV_Last_3')),
                'Risk_Adj_EV': safe_float(row.get(f'{st_active}_Risk_Adj_EV')),
                'Risk_Adj_EV_Last_3': safe_float(row.get(f'{st_active}_Risk_Adj_EV_Last_3')),
                'Count': safe_int(row.get(f'{st_active}_Count')),
                'Is_Live': st_is_live,
            })

            # --- BTFD/STFR: check independently, both can be open ---
            btfd_is_live = False
            stfr_is_live = False
            if ticker in live_closes:
                prev_lower = row.get('Lower_Target')
                prev_upper = row.get('Upper_Target')
                hist_btfd_triggered = bool(row.get('BTFD_Triggered', False))
                hist_stfr_triggered = bool(row.get('STFR_Triggered', False))
                # BTFD: prev candle was downtrend, still in downtrend, close <= lower target, not triggered
                if (pd.notna(prev_lower) and close <= prev_lower
                        and hist_trend == 0.0 and live_trend == 0.0
                        and not hist_btfd_triggered):
                    btfd_is_live = True
                # STFR: prev candle was uptrend, still in uptrend, close >= upper target, not triggered
                if (pd.notna(prev_upper) and close >= prev_upper
                        and hist_trend == 1.0 and live_trend == 1.0
                        and not hist_stfr_triggered):
                    stfr_is_live = True

            for mr_sig, mr_entry_dict, mr_is_live in [
                ('BTFD', btfd_last_entry, btfd_is_live),
                ('STFR', stfr_last_entry, stfr_is_live),
            ]:
                entry_col = f'{mr_sig}_Entry_Price'
                exit_col = f'{mr_sig}_Exit_Date'
                entry_price = row.get(entry_col) if entry_col in row.index else None
                exit_date_val = row.get(exit_col) if exit_col in row.index else None
                if pd.notna(entry_price) and pd.isna(exit_date_val):
                    entry_info = mr_entry_dict.get(ticker)
                    entry_date = entry_info[0] if entry_info else None
                    if mr_sig in SHORT_SIGNALS:
                        perf = (entry_price - close) / entry_price if entry_price else 0
                    else:
                        perf = (close - entry_price) / entry_price if entry_price else 0
                    entry_date_str = pd.Timestamp(entry_date).strftime('%Y-%m-%d') if pd.notna(entry_date) else None
                    open_signals.append({
                        'Ticker': ticker, 'Signal_Type': mr_sig,
                        'Entry_Date': entry_date_str,
                        'Close': safe_float(close, 2),
                        'Entry_Price': safe_float(entry_price, 2),
                        'Current_Performance': safe_float(perf, 4),
                        'Win_Rate': safe_float(row.get(f'{mr_sig}_Win_Rate')),
                        'Avg_Winner': safe_float(row.get(f'{mr_sig}_Avg_Winner')),
                        'Avg_Loser': safe_float(row.get(f'{mr_sig}_Avg_Loser')),
                        'Avg_Winner_Bars': safe_float(row.get(f'{mr_sig}_Avg_Winner_Bars'), 1),
                        'Avg_Loser_Bars': safe_float(row.get(f'{mr_sig}_Avg_Loser_Bars'), 1),
                        'Avg_MFE': safe_float(row.get(f'{mr_sig}_Avg_MFE')),
                        'Avg_MAE': safe_float(row.get(f'{mr_sig}_Avg_MAE')),
                        'Std_Dev': safe_float(row.get(f'{mr_sig}_Std_Dev')),
                        'Historical_EV': safe_float(row.get(f'{mr_sig}_Historical_EV')),
                        'EV_Last_3': safe_float(row.get(f'{mr_sig}_EV_Last_3')),
                        'Risk_Adj_EV': safe_float(row.get(f'{mr_sig}_Risk_Adj_EV')),
                        'Risk_Adj_EV_Last_3': safe_float(row.get(f'{mr_sig}_Risk_Adj_EV_Last_3')),
                        'Count': safe_int(row.get(f'{mr_sig}_Count')),
                        'Is_Live': mr_is_live,
                    })
        open_signals.sort(key=lambda x: x['Ticker'])
        closed_signals.sort(key=lambda x: x['Ticker'])

        # In range mode, filter signals by basket membership
        if is_range_mode and quarter_membership:
            # Open signals: only tickers in the LAST quarter of the range
            open_signals = [s for s in open_signals if s['Ticker'] in last_quarter_tickers]

            # Closed signals: only trades where ticker was in the basket at exit time
            def _ticker_in_basket_at_date(ticker, date_str):
                if not date_str:
                    return False
                dt = pd.Timestamp(date_str)
                for q_str, q_tickers in quarter_membership.items():
                    q_start = _quarter_str_to_date(q_str)
                    qn = int(q_str.split()[1][1])
                    q_end = pd.Timestamp(year=q_start.year, month=qn * 3, day=1) + pd.offsets.MonthEnd(0)
                    if q_start <= dt <= q_end and ticker in q_tickers:
                        return True
                return False
            closed_signals = [s for s in closed_signals if _ticker_in_basket_at_date(s['Ticker'], s.get('Exit_Date'))]

        # --- 21-Day Correlation ---
        close_df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Ticker', 'Date', 'Close'],
                                   filters=[('Ticker', 'in', tickers)])
        close_pivot = close_df.pivot_table(index='Date', columns='Ticker', values='Close')
        returns = close_pivot.pct_change()
        recent_returns = returns.sort_index().tail(21)
        valid_cols = [c for c in recent_returns.columns if recent_returns[c].notna().sum() >= 10]
        corr_labels = sorted(valid_cols)
        corr_matrix = recent_returns[corr_labels].corr()
        corr_values = corr_matrix.values.tolist()
        # Replace NaN with null for JSON
        corr_values = [[None if (v != v) else round(v, 3) for v in row] for row in corr_values]

        # --- Cumulative Returns (respects active basket membership via contributions) ---
        contrib_file = _find_basket_contributions(basket_name)
        if contrib_file:
            cdf = pd.read_parquet(contrib_file)
            cdf['Date'] = pd.to_datetime(cdf['Date']).dt.normalize()
            cdf = cdf.drop_duplicates(subset=['Date', 'Ticker'], keep='last')
            ret_pivot = cdf.pivot_table(index='Date', columns='Ticker', values='Daily_Return')
            ret_pivot = ret_pivot.sort_index()
            active_mask = ret_pivot.notna()
            # Fill inactive days with 0% return (factor=1) so cumprod passes through
            factors = ret_pivot.fillna(0) + 1
            equity = factors.cumprod()
            cum_ret = equity - 1
            # Mask inactive days back to NaN
            cum_ret[~active_mask] = float('nan')
            dates = [d.strftime('%Y-%m-%d') for d in ret_pivot.index]
            cum_series = []
            for t in sorted(ret_pivot.columns):
                vals = [None if pd.isna(v) else round(float(v), 4) for v in cum_ret[t].tolist()]
                cum_series.append({'ticker': t, 'values': vals, 'join_date': None})
        else:
            # Fallback: use close prices and join dates (no contributions file)
            join_dates = _get_ticker_join_dates(basket_name, tickers)
            close_sorted = close_pivot.sort_index()
            if close_sorted.empty:
                dates = []
                cum_series = []
            else:
                dates = [d.strftime('%Y-%m-%d') for d in close_sorted.index]
                cum_series = []
                for t in sorted(close_sorted.columns):
                    col = close_sorted[t]
                    jd = join_dates.get(t)
                    if jd:
                        valid = col[col.index >= jd].dropna()
                    else:
                        valid = col.dropna()
                    if valid.empty:
                        vals = [None] * len(dates)
                    else:
                        base_price = valid.iloc[0]
                        rebased = col / base_price - 1
                        if jd:
                            rebased[rebased.index < jd] = float('nan')
                        vals = [None if pd.isna(v) else round(float(v), 4) for v in rebased.tolist()]
                    jd_str = jd.strftime('%Y-%m-%d') if jd else None
                    cum_series.append({'ticker': t, 'values': vals, 'join_date': jd_str})

        return {
            'open_signals': open_signals,
            'closed_signals': closed_signals,
            'correlation': {'labels': corr_labels, 'matrix': corr_values},
            'cumulative_returns': {'dates': dates, 'series': cum_series},
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_basket_summary for {basket_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/baskets/{basket_name}/correlation")
def get_basket_correlation(basket_name: str, date: str = None):
    """Return 21-day trailing correlation matrix for tickers in the basket at a given date."""
    try:
        if date:
            target_date = pd.Timestamp(date)
        else:
            target_date = None

        # Get tickers for the target date's quarter (or latest)
        if target_date:
            corr_tickers = _get_tickers_for_date(basket_name, target_date)
        else:
            corr_tickers = get_latest_universe_tickers(basket_name)
            if not corr_tickers:
                corr_tickers = get_meta_file_tickers(basket_name)
        if not corr_tickers:
            raise HTTPException(status_code=404, detail="No tickers found for basket")

        close_df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Ticker', 'Date', 'Close'],
                                   filters=[('Ticker', 'in', corr_tickers)])
        close_pivot = close_df.pivot_table(index='Date', columns='Ticker', values='Close').sort_index()

        if target_date:
            close_pivot = close_pivot[close_pivot.index <= target_date]

        returns = close_pivot.pct_change()
        recent_returns = returns.tail(21)
        valid_cols = [c for c in recent_returns.columns if recent_returns[c].notna().sum() >= 10]
        corr_labels = sorted(valid_cols)
        corr_matrix = recent_returns[corr_labels].corr()
        corr_values = corr_matrix.values.tolist()
        corr_values = [[None if (v != v) else round(v, 3) for v in row] for row in corr_values]

        # Return available date range for the date picker
        all_dates = [d.strftime('%Y-%m-%d') for d in close_pivot.index]
        return {
            'labels': corr_labels,
            'matrix': corr_values,
            'min_date': all_dates[0] if all_dates else None,
            'max_date': all_dates[-1] if all_dates else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_basket_correlation for {basket_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _find_basket_contributions(slug):
    """Glob for a basket contributions parquet by slug prefix across basket cache folders."""
    for folder in BASKET_CACHE_FOLDERS:
        if not folder.exists():
            continue
        matches = list(folder.glob(f'{slug}_*_of_*_contributions.parquet'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_contributions.parquet'))
        if matches:
            return matches[0]
    return None


@app.get("/api/baskets/{basket_name}/contributions")
def get_basket_contributions(basket_name: str, start: str = None, end: str = None):
    """Return per-constituent contribution data for a date range."""
    try:
        contrib_file = _find_basket_contributions(basket_name)
        if not contrib_file:
            raise HTTPException(status_code=404, detail=f"Contributions file not found for {basket_name}")

        df = pd.read_parquet(contrib_file)
        df['Date'] = pd.to_datetime(df['Date']).dt.normalize()

        # Per-ticker metadata from full dataset (before date filtering)
        full_max_date = df['Date'].max()
        ticker_meta = df.groupby('Ticker').agg(
            first_date=('Date', 'min'),
            last_date=('Date', 'max'),
        ).reset_index()
        # Current weight: Weight_BOD on the dataset max date (null if ticker exited)
        max_day = df[df['Date'] == full_max_date][['Ticker', 'Weight_BOD']].rename(
            columns={'Weight_BOD': 'current_weight'}
        )
        ticker_meta = ticker_meta.merge(max_day, on='Ticker', how='left')

        # Full date range (for the date picker)
        full_min_str = df['Date'].min().strftime('%Y-%m-%d')
        full_max_str = full_max_date.strftime('%Y-%m-%d')

        # Apply date filtering
        if start:
            df = df[df['Date'] >= pd.Timestamp(start)]
        if end:
            df = df[df['Date'] <= pd.Timestamp(end)]

        if df.empty:
            return {
                "tickers": [], "dates": [], "total_contributions": [],
                "initial_weights": [], "final_weights": [],
                "first_dates": [], "last_dates": [], "current_weights": [],
                "equity_dates": [], "equity_values": [],
                "date_range": {"min": full_min_str, "max": full_max_str},
            }

        # Equity curve: daily basket return then cumulative product
        daily_return = df.groupby('Date')['Contribution'].sum().sort_index()
        equity = (1 + daily_return).cumprod()
        equity_dates = [d.strftime('%Y-%m-%d') for d in equity.index]
        equity_values = equity.tolist()

        # Aggregate per-ticker over the period
        agg = df.groupby('Ticker').agg(
            total_contribution=('Contribution', 'sum'),
            initial_weight=('Weight_BOD', 'first'),
            final_weight=('Weight_BOD', 'last'),
        ).reset_index()

        # Sort worst to best
        agg = agg.sort_values('total_contribution').reset_index(drop=True)

        # Merge ticker metadata so arrays align with tickers[]
        agg = agg.merge(ticker_meta, on='Ticker', how='left')

        # Date range info
        all_dates = sorted(df['Date'].unique())
        date_strs = [d.strftime('%Y-%m-%d') for d in all_dates]

        return {
            "tickers": agg['Ticker'].tolist(),
            "total_contributions": agg['total_contribution'].tolist(),
            "initial_weights": agg['initial_weight'].tolist(),
            "final_weights": agg['final_weight'].tolist(),
            "first_dates": [d.strftime('%Y-%m-%d') for d in agg['first_date']],
            "last_dates": [d.strftime('%Y-%m-%d') for d in agg['last_date']],
            "current_weights": [None if pd.isna(w) else float(w) for w in agg['current_weight']],
            "equity_dates": equity_dates,
            "equity_values": equity_values,
            "dates": date_strs,
            "date_range": {
                "min": full_min_str,
                "max": full_max_str,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_basket_contributions for {basket_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/baskets/{basket_name}/candle-detail")
def get_basket_candle_detail(basket_name: str, date: str = None):
    """Return per-constituent weights, returns, and contributions for a single day."""
    try:
        contrib_file = _find_basket_contributions(basket_name)
        if not contrib_file:
            raise HTTPException(status_code=404, detail=f"Contributions file not found for {basket_name}")

        df = pd.read_parquet(contrib_file)
        df['Date'] = pd.to_datetime(df['Date']).dt.normalize()

        if date:
            target = pd.Timestamp(date).normalize()
        else:
            target = df['Date'].max()

        day = df[df['Date'] == target]
        if day.empty:
            return {"date": target.strftime('%Y-%m-%d'), "constituents": []}

        # Sort by contribution descending
        day = day.sort_values('Contribution', ascending=False)

        constituents = []
        for _, row in day.iterrows():
            constituents.append({
                "ticker": row['Ticker'],
                "weight": round(float(row['Weight_BOD']), 6),
                "daily_return": round(float(row['Daily_Return']), 6),
                "contribution": round(float(row['Contribution']), 6),
            })

        basket_return = float(day['Contribution'].sum())

        return {
            "date": target.strftime('%Y-%m-%d'),
            "constituents": constituents,
            "basket_return": round(basket_return, 6),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_basket_candle_detail for {basket_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/ticker-baskets/{ticker}")
def get_ticker_baskets(ticker: str):
    """Return list of basket names containing this ticker that also have parquet data."""
    candidates = []
    if GICS_MAPPINGS_FILE.exists():
        with open(GICS_MAPPINGS_FILE, 'r') as f:
            gics = json.load(f)
        for group_key in ('sector_u', 'industry_u'):
            group = gics.get(group_key, {})
            for name, quarter_dict in group.items():
                for q_tickers in quarter_dict.values():
                    if ticker in q_tickers:
                        candidates.append(name.replace(" ", "_"))
                        break
    for basket_name, (fn, key) in THEMATIC_CONFIG.items():
        p_path = THEMATIC_BASKET_CACHE / fn
        if p_path.exists():
            try:
                with open(p_path, 'r') as f:
                    data = json.load(f)
                ud = data[key] if key is not None else data
                for q_tickers in ud.values():
                    if ticker in q_tickers:
                        candidates.append(basket_name)
                        break
            except Exception:
                pass
    # Only return baskets that have a signals parquet file
    return sorted(set(b for b in candidates if _find_basket_parquet(b)))


class BacktestFilter(BaseModel):
    metric: str
    condition: str
    value: Optional[float] = None
    source: str = "self"

class BacktestRequest(BaseModel):
    target: str
    target_type: str
    entry_signal: str
    filters: List[BacktestFilter] = []
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    position_size: float = 1.0
    initial_equity: float = 100000
    max_leverage: float = 2.5

@app.get("/api/date-range/{target_type}/{target}")
def get_date_range(target_type: str, target: str):
    """Return min/max date for a basket or ticker so the frontend can constrain date pickers."""
    if target_type in ('basket', 'basket_tickers'):
        basket_file = _find_basket_parquet(target)
        if not basket_file:
            raise HTTPException(status_code=404, detail=f"Basket file not found for {target}")
        dates = pd.read_parquet(basket_file, columns=['Date'])['Date']
    else:
        if not INDIVIDUAL_SIGNALS_FILE.exists():
            raise HTTPException(status_code=404, detail="Signals file not found")
        dates = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Ticker', 'Date'],
                                filters=[('Ticker', '==', target)])['Date']
    dates = pd.to_datetime(dates)
    if dates.empty:
        raise HTTPException(status_code=404, detail="No data found")
    return {"min": dates.min().strftime('%Y-%m-%d'), "max": dates.max().strftime('%Y-%m-%d')}

@app.post("/api/backtest")
def run_backtest(req: BacktestRequest):
    sig = req.entry_signal
    is_col = SIGNAL_IS_COL.get(sig)
    if not is_col:
        raise HTTPException(status_code=400, detail=f"Unknown signal: {sig}")
    direction = BACKTEST_DIRECTION[sig]

    # Trade data columns for entry signal
    trade_cols = [f'{sig}_Entry_Price', f'{sig}_Exit_Date', f'{sig}_Exit_Price',
                  f'{sig}_Final_Change', f'{sig}_MFE', f'{sig}_MAE']

    # Regime filter metrics we may need
    pct_metrics = {'Uptrend_Pct', 'Breakout_Pct', 'Correlation_Pct', 'RV_EMA', 'Breakdown_Pct', 'Downtrend_Pct'}
    bool_metrics = {'Is_Breakout_Sequence', 'Trend', 'BTFD_Triggered', 'STFR_Triggered'}

    is_multi_ticker = req.target_type == 'basket_tickers'

    # 1. Load target data
    if req.target_type == 'basket':
        basket_file = _find_basket_parquet(req.target)
        if not basket_file:
            raise HTTPException(status_code=404, detail=f"Basket file not found for {req.target}")
        base_cols = ['Date', 'Close', is_col] + trade_cols
        # Add self-filter metrics
        for flt in req.filters:
            if flt.source == 'self' and flt.metric not in base_cols:
                base_cols.append(flt.metric)
        try:
            df = pd.read_parquet(basket_file, columns=[c for c in base_cols if c])
        except Exception:
            df = pd.read_parquet(basket_file)
            df = df[[c for c in base_cols if c in df.columns]]
    elif req.target_type == 'basket_tickers':
        # Load individual ticker signals for all tickers in the basket
        if not INDIVIDUAL_SIGNALS_FILE.exists():
            raise HTTPException(status_code=404, detail="Signals file not found")
        basket_tickers = get_latest_universe_tickers(req.target)
        if not basket_tickers:
            basket_tickers = get_meta_file_tickers(req.target)
        if not basket_tickers:
            raise HTTPException(status_code=404, detail=f"No tickers found for basket {req.target}")
        base_cols = ['Ticker', 'Date', 'Close', is_col] + trade_cols
        for flt in req.filters:
            if flt.source == 'self' and flt.metric not in base_cols:
                base_cols.append(flt.metric)
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE,
                             columns=[c for c in base_cols if c],
                             filters=[('Ticker', 'in', basket_tickers)])
    else:
        if not INDIVIDUAL_SIGNALS_FILE.exists():
            raise HTTPException(status_code=404, detail="Signals file not found")
        base_cols = ['Ticker', 'Date', 'Close', is_col] + trade_cols
        for flt in req.filters:
            if flt.source == 'self' and flt.metric not in base_cols:
                base_cols.append(flt.metric)
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE,
                             columns=[c for c in base_cols if c],
                             filters=[('Ticker', '==', req.target)])

    df['Date'] = pd.to_datetime(df['Date'])
    if is_multi_ticker:
        df = df.sort_values(['Ticker', 'Date']).reset_index(drop=True)
    else:
        df = df.sort_values('Date').reset_index(drop=True)

    # Capture full date range before any filtering
    date_range = {
        "min": df['Date'].min().strftime('%Y-%m-%d'),
        "max": df['Date'].max().strftime('%Y-%m-%d'),
    }

    # 2. Date range filter
    if req.start_date:
        df = df[df['Date'] >= pd.Timestamp(req.start_date)]
    if req.end_date:
        df = df[df['Date'] <= pd.Timestamp(req.end_date)]

    if df.empty:
        return {"trades": [], "trade_paths": [], "equity_curve": {"dates": [], "filtered": [], "unfiltered": []},
                "stats": {"filtered": {}, "unfiltered": {}}, "date_range": date_range}

    # 3. Load external filter sources and merge
    external_sources = {}
    failed_sources = set()
    needs_ext_merge = any(flt.source != 'self' for flt in req.filters)
    if needs_ext_merge and is_multi_ticker:
        # merge_asof requires Date-sorted df; re-sort after merges
        df = df.sort_values('Date').reset_index(drop=True)
    for flt in req.filters:
        if flt.source != 'self' and flt.source not in external_sources and flt.source not in failed_sources:
            ext_file = _find_basket_parquet(flt.source)
            if not ext_file:
                failed_sources.add(flt.source)
                continue
            ext_cols = ['Date']
            for f2 in req.filters:
                if f2.source == flt.source and f2.metric not in ext_cols:
                    ext_cols.append(f2.metric)
            try:
                ext_df = pd.read_parquet(ext_file, columns=ext_cols)
            except Exception:
                ext_df = pd.read_parquet(ext_file)
                ext_df = ext_df[[c for c in ext_cols if c in ext_df.columns]]
            ext_df['Date'] = pd.to_datetime(ext_df['Date'])
            ext_df = ext_df.sort_values('Date')
            suffix = f'__{flt.source}'
            rename_map = {c: f'{c}{suffix}' for c in ext_df.columns if c != 'Date'}
            ext_df = ext_df.rename(columns=rename_map)
            df = pd.merge_asof(df, ext_df, on='Date', direction='backward')
            external_sources[flt.source] = suffix
    if needs_ext_merge and is_multi_ticker:
        df = df.sort_values(['Ticker', 'Date']).reset_index(drop=True)

    # 4. Add shift columns for increasing/decreasing conditions
    for flt in req.filters:
        col_name = flt.metric
        if flt.source != 'self':
            col_name = f'{flt.metric}__{flt.source}'
        if flt.condition in ('increasing', 'decreasing') and col_name in df.columns:
            if is_multi_ticker:
                df[f'{col_name}__prev'] = df.groupby('Ticker')[col_name].shift(1)
            else:
                df[f'{col_name}__prev'] = df[col_name].shift(1)

    # 5. Find entry rows
    entries = df[df[is_col] == True].copy()

    # 6. Build trades from pre-computed data
    trades = []
    for _, row in entries.iterrows():
        entry_price = row.get(f'{sig}_Entry_Price')
        exit_date = row.get(f'{sig}_Exit_Date')
        exit_price = row.get(f'{sig}_Exit_Price')
        final_change = row.get(f'{sig}_Final_Change')
        mfe = row.get(f'{sig}_MFE')
        mae = row.get(f'{sig}_MAE')

        # Skip open trades (no exit)
        if pd.isna(exit_date) or pd.isna(exit_price):
            continue

        entry_date = row['Date']

        # Compute bars held
        exit_dt = pd.Timestamp(exit_date)
        # Count trading days between entry and exit using business days
        bars_held = max(1, int(np.busday_count(
            entry_date.date(), exit_dt.date())))

        # Apply direction: for short signals, the raw Final_Change is already
        # from the perspective of the signal (positive = profitable short).
        # We use Final_Change as-is since the signals engine already accounts for direction.
        trade_return = float(final_change) if pd.notna(final_change) else 0.0

        # Apply regime filters
        regime_pass = True
        for flt in req.filters:
            # Skip filters whose external source had no data
            if flt.source != 'self' and flt.source in failed_sources:
                continue
            col_name = flt.metric
            if flt.source != 'self':
                col_name = f'{flt.metric}__{flt.source}'
            val = row.get(col_name)
            if flt.condition == 'above':
                regime_pass = regime_pass and (pd.notna(val) and float(val) > flt.value)
            elif flt.condition == 'below':
                regime_pass = regime_pass and (pd.notna(val) and float(val) < flt.value)
            elif flt.condition == 'increasing':
                prev_val = row.get(f'{col_name}__prev')
                regime_pass = regime_pass and (pd.notna(val) and pd.notna(prev_val) and float(val) > float(prev_val))
            elif flt.condition == 'decreasing':
                prev_val = row.get(f'{col_name}__prev')
                regime_pass = regime_pass and (pd.notna(val) and pd.notna(prev_val) and float(val) < float(prev_val))
            elif flt.condition == 'equals_true':
                regime_pass = regime_pass and (pd.notna(val) and bool(val))
            elif flt.condition == 'equals_false':
                regime_pass = regime_pass and (pd.notna(val) and not bool(val))

        trade_dict = {
            'entry_date': entry_date.strftime('%Y-%m-%d'),
            'exit_date': exit_dt.strftime('%Y-%m-%d'),
            'entry_price': safe_float(entry_price, 2),
            'exit_price': safe_float(exit_price, 2),
            'change': safe_float(trade_return, 4),
            'mfe': safe_float(mfe, 4),
            'mae': safe_float(mae, 4),
            'bars_held': bars_held,
            'regime_pass': regime_pass,
        }
        if is_multi_ticker:
            trade_dict['ticker'] = row.get('Ticker', '')
        trades.append(trade_dict)

    # 6b. Compute trade paths (daily cumulative return from entry to exit)
    trade_paths = []
    if is_multi_ticker:
        # Build per-ticker close series for path lookup
        ticker_closes = {}
        for tkr, grp in df.groupby('Ticker'):
            ticker_closes[tkr] = grp.set_index('Date')['Close'].sort_index()
        for t in trades:
            ep = t['entry_price']
            tkr = t.get('ticker', '')
            if ep is None or ep == 0 or tkr not in ticker_closes:
                trade_paths.append([])
                continue
            ed = pd.Timestamp(t['entry_date'])
            xd = pd.Timestamp(t['exit_date'])
            cs = ticker_closes[tkr]
            segment = cs[(cs.index >= ed) & (cs.index <= xd)]
            path = [round(float(c) / ep - 1, 6) for c in segment.values]
            trade_paths.append(path)
    else:
        closes = df.set_index('Date')['Close'].sort_index()
        for t in trades:
            ep = t['entry_price']
            if ep is None or ep == 0:
                trade_paths.append([])
                continue
            ed = pd.Timestamp(t['entry_date'])
            xd = pd.Timestamp(t['exit_date'])
            mask = (closes.index >= ed) & (closes.index <= xd)
            segment = closes[mask]
            path = [round(float(c) / ep - 1, 6) for c in segment.values]
            trade_paths.append(path)

    # Ensure ticker_closes is available for both modes
    if not is_multi_ticker:
        ticker_closes = {'': closes}

    # 7. Build daily mark-to-market equity curves with position sizing
    paired = sorted(zip(trades, trade_paths), key=lambda p: p[0]['exit_date'])
    sorted_trades = [p[0] for p in paired]
    sorted_paths = [p[1] for p in paired]
    initial = req.initial_equity
    pos_size = req.position_size
    max_lev = req.max_leverage
    is_long = direction == 'long'

    # Build daily date index
    all_dates = sorted(df['Date'].unique())

    # Build entry/exit date maps for O(1) lookup
    entry_map = {}
    exit_map = {}
    trade_map = {i: t for i, t in enumerate(sorted_trades)}
    for i, t in enumerate(sorted_trades):
        ed = pd.Timestamp(t['entry_date'])
        xd = pd.Timestamp(t['exit_date'])
        entry_map.setdefault(ed, []).append(i)
        exit_map.setdefault(xd, []).append(i)

    def mtm_equity(open_pos, cash, close_date):
        """Compute mark-to-market equity: cash + sum of position values."""
        total = cash
        for info in open_pos.values():
            tkr = info.get('ticker', '')
            ep = info['entry_price']
            cs = ticker_closes.get(tkr)
            if cs is None or ep == 0:
                total += info['alloc']
                continue
            cv = cs.asof(close_date)
            if pd.isna(cv):
                total += info['alloc']
                continue
            cp = float(cv)
            if is_long:
                total += info['alloc'] * (cp / ep)
            else:
                total += info['alloc'] * (2 - cp / ep)
        return total

    cash_all = initial
    cash_filt = initial
    open_all = {}   # trade_index -> {alloc, entry_price, ticker}
    open_filt = {}
    eq_dates = []
    eq_all_vals = []
    eq_filt_vals = []
    blew_up = None

    for date in all_dates:
        # Process exits first (frees capital before new entries)
        for idx in exit_map.get(date, []):
            t = trade_map[idx]
            ret = t['change'] or 0.0
            if idx in open_all:
                a = open_all.pop(idx)
                cash_all += a['alloc'] * (1 + ret)
            if idx in open_filt:
                a = open_filt.pop(idx)
                cash_filt += a['alloc'] * (1 + ret)

        # Process entries (allocate capital)
        for idx in entry_map.get(date, []):
            t = trade_map[idx]
            eq_est = mtm_equity(open_all, cash_all, date)
            if eq_est <= 0:
                continue
            wanted = eq_est * pos_size
            exposure = sum(info['alloc'] for info in open_all.values())
            room = max(0, eq_est * max_lev - exposure)
            alloc = min(wanted, room)
            if alloc > 0:
                open_all[idx] = {'alloc': alloc, 'entry_price': t['entry_price'] or 0,
                                  'ticker': t.get('ticker', '')}
                cash_all -= alloc
            if t['regime_pass']:
                eq_est_f = mtm_equity(open_filt, cash_filt, date)
                if eq_est_f > 0:
                    wanted_f = eq_est_f * pos_size
                    exposure_f = sum(info['alloc'] for info in open_filt.values())
                    room_f = max(0, eq_est_f * max_lev - exposure_f)
                    alloc_f = min(wanted_f, room_f)
                    if alloc_f > 0:
                        open_filt[idx] = {'alloc': alloc_f, 'entry_price': t['entry_price'] or 0,
                                           'ticker': t.get('ticker', '')}
                        cash_filt -= alloc_f

        # Record daily mark-to-market equity
        equity_all = mtm_equity(open_all, cash_all, date)
        equity_filt = mtm_equity(open_filt, cash_filt, date)
        eq_dates.append(pd.Timestamp(date).strftime('%Y-%m-%d'))
        eq_all_vals.append(round(equity_all, 2))
        eq_filt_vals.append(round(equity_filt, 2))
        if equity_all <= 0 and blew_up is None:
            blew_up = {"date": eq_dates[-1], "trade_index": -1, "equity": "unfiltered"}
        if equity_filt <= 0 and blew_up is None:
            blew_up = {"date": eq_dates[-1], "trade_index": -1, "equity": "filtered"}

    # Build buy-and-hold curve (aligned to equity curve dates)
    if is_multi_ticker:
        basket_file_bh = _find_basket_parquet(req.target)
        if basket_file_bh:
            bh_raw = pd.read_parquet(basket_file_bh, columns=['Date', 'Close'])
            bh_raw['Date'] = pd.to_datetime(bh_raw['Date'])
            bh_raw = bh_raw.sort_values('Date')
            if req.start_date:
                bh_raw = bh_raw[bh_raw['Date'] >= pd.Timestamp(req.start_date)]
            if req.end_date:
                bh_raw = bh_raw[bh_raw['Date'] <= pd.Timestamp(req.end_date)]
            bh_series = bh_raw.set_index('Date')['Close'].sort_index()
        else:
            bh_series = pd.Series(dtype=float)
    else:
        bh_series = df.drop_duplicates('Date').set_index('Date')['Close'].sort_index()

    bh_vals = []
    if not bh_series.empty:
        first_bh = float(bh_series.iloc[0])
        for d in all_dates:
            v = bh_series.asof(pd.Timestamp(d))
            if pd.notna(v) and first_bh > 0:
                bh_vals.append(round(initial * float(v) / first_bh, 2))
            else:
                bh_vals.append(round(initial, 2))
    else:
        bh_vals = [round(initial, 2)] * len(all_dates)

    # 8. Compute stats
    def compute_stats(trade_list, equity_vals):
        if not trade_list:
            return {'trades': 0, 'win_rate': 0, 'avg_winner': 0, 'avg_loser': 0,
                    'ev': 0, 'profit_factor': 0, 'max_dd': 0, 'avg_bars': 0}
        returns = [t['change'] for t in trade_list if t['change'] is not None]
        winners = [r for r in returns if r > 0]
        losers = [r for r in returns if r <= 0]
        total = len(returns)
        win_rate = len(winners) / total if total > 0 else 0
        avg_winner = sum(winners) / len(winners) if winners else 0
        avg_loser = sum(losers) / len(losers) if losers else 0
        ev = sum(returns) / total if total > 0 else 0
        gross_profit = sum(winners)
        gross_loss = abs(sum(losers))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else (999 if gross_profit > 0 else 0)
        # Max drawdown from equity curve values (peak-to-trough / peak)
        max_dd = 0.0
        if equity_vals:
            peak = equity_vals[0]
            for v in equity_vals:
                peak = max(peak, v)
                if peak > 0:
                    dd = (peak - v) / peak
                    max_dd = max(max_dd, dd)
        avg_bars = sum(t['bars_held'] for t in trade_list) / len(trade_list) if trade_list else 0
        return {
            'trades': total,
            'win_rate': round(win_rate, 4),
            'avg_winner': round(avg_winner, 4),
            'avg_loser': round(avg_loser, 4),
            'ev': round(ev, 4),
            'profit_factor': round(profit_factor, 2),
            'max_dd': round(max_dd, 4),
            'avg_bars': round(avg_bars, 1),
        }

    filtered_trades = [t for t in trades if t['regime_pass']]
    stats_filtered = compute_stats(filtered_trades, eq_filt_vals)
    stats_unfiltered = compute_stats(trades, eq_all_vals)

    resp = {
        "trades": sorted_trades,
        "trade_paths": sorted_paths,
        "equity_curve": {"dates": eq_dates, "filtered": eq_filt_vals, "unfiltered": eq_all_vals, "buy_hold": bh_vals},
        "stats": {"filtered": stats_filtered, "unfiltered": stats_unfiltered},
        "date_range": date_range,
    }
    if blew_up:
        resp["blew_up"] = blew_up
    return resp


@app.websocket("/ws/live/{ticker}")
async def websocket_endpoint(websocket: WebSocket, ticker: str):
    await websocket.accept()
    if not DB_API_KEY:
        await websocket.send_text(json.dumps({"error": "Databento API key missing"}))
        await websocket.close()
        return

    try:
        # Initialize Databento Live client
        live_client = db.Live(key=DB_API_KEY)
        live_client.subscribe(
            dataset=DB_DATASET,
            schema="ohlcv-1m",
            symbols=[ticker],
            stype_in=DB_STYPE_IN
        )

        queue = asyncio.Queue()

        def handle_record(record):
            if not hasattr(record, 'open'):
                return

            # Format record for frontend - Convert UTC to NY
            dt_utc = datetime.fromtimestamp(record.ts_event / 1e9, tz=ZoneInfo("UTC"))
            dt_ny = dt_utc.astimezone(ZoneInfo("America/New_York"))

            # FILTER RTH: Drop anything outside 09:30 - 16:00
            if dt_ny.hour < 9 or (dt_ny.hour == 9 and dt_ny.minute < 30) or dt_ny.hour >= 16:
                return

            data = {
                "time": dt_ny.strftime('%Y-%m-%dT%H:%M:%S'),
                "open": record.open,
                "high": record.high,
                "low": record.low,
                "close": record.close,
                "volume": record.volume
            }
            asyncio.run_coroutine_threadsafe(queue.put(data), asyncio.get_event_loop())

        live_client.add_callback(handle_record)
        thread = asyncio.create_task(asyncio.to_thread(live_client.start))

        try:
            while True:
                data = await queue.get()
                await websocket.send_json(data)
        except WebSocketDisconnect:
            pass
        finally:
            live_client.stop()
            thread.cancel()
    except Exception as e:
        logger.error(f"Error in websocket for {ticker}: {e}")
        await websocket.send_json({"error": str(e)})
    finally:
        try:
            await websocket.close()
        except:
            pass

if __name__ == "__main__":
    import uvicorn
    # Use 0.0.0.0 to allow access from other devices on the network
    uvicorn.run(app, host="0.0.0.0", port=8000)
