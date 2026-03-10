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
        # New naming: *_signals.parquet
        matches = list(folder.glob(f'{slug}_*_of_*_signals.parquet'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_signals.parquet'))
        # Legacy fallback: *_basket.parquet
        if not matches:
            matches = list(folder.glob(f'{slug}_*_of_*_basket.parquet'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_basket.parquet'))
        if matches:
            return matches[0]
    return None

def _find_basket_meta(slug):
    """Glob for a basket meta JSON by slug prefix across basket cache folders. Returns path or None."""
    for folder in BASKET_CACHE_FOLDERS:
        if not folder.exists():
            continue
        # New naming: *_signals_meta.json
        matches = list(folder.glob(f'{slug}_*_of_*_signals_meta.json'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_signals_meta.json'))
        # Legacy fallback: *_basket_meta.json
        if not matches:
            matches = list(folder.glob(f'{slug}_*_of_*_basket_meta.json'))
        if not matches:
            matches = list(folder.glob(f'{slug}_of_*_basket_meta.json'))
        if matches:
            return matches[0]
    return None

_DV_DATA = None

def get_dv_data():
    global _DV_DATA
    if _DV_DATA is not None: return _DV_DATA
    if not INDIVIDUAL_SIGNALS_FILE.exists(): return None
    try:
        latest_date_df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Date'])
        latest_date = latest_date_df['Date'].max()
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE,
                             columns=['Ticker', 'Date', 'Close', 'Volume'],
                             filters=[('Date', '==', latest_date)])
        df['Dollar_Vol'] = df['Close'] * df['Volume']
        _DV_DATA = df.set_index('Ticker')['Dollar_Vol'].to_dict()
        return _DV_DATA
    except: return None

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


def get_meta_file_weights(basket_name):
    meta_file = _find_basket_meta(basket_name)
    if not meta_file:
        return {}
    try:
        with open(meta_file, 'r') as f:
            meta = json.load(f)
        weights = meta.get('state', {}).get('weights', {})
        if not isinstance(weights, dict):
            return {}
        return {
            str(symbol): float(weight)
            for symbol, weight in weights.items()
            if weight is not None
        }
    except Exception:
        return {}


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


def _quarter_start(ts):
    month = ((int(ts.month) - 1) // 3) * 3 + 1
    return pd.Timestamp(year=int(ts.year), month=month, day=1)


def compute_current_basket_weights(tickers):
    if not tickers or not INDIVIDUAL_SIGNALS_FILE.exists():
        return {}

    df = pd.read_parquet(
        INDIVIDUAL_SIGNALS_FILE,
        columns=['Ticker', 'Date', 'Close', 'Volume'],
        filters=[('Ticker', 'in', tickers)],
    )
    if df.empty:
        return {}

    df['Date'] = pd.to_datetime(df['Date']).dt.normalize()
    df = df.dropna(subset=['Close']).sort_values(['Ticker', 'Date'])
    latest_date = df['Date'].max()
    if pd.isna(latest_date):
        return {}

    quarter_start = _quarter_start(latest_date)

    qtd_df = df[df['Date'] >= quarter_start].copy()
    if qtd_df.empty:
        return {}

    qtd_df['Dollar_Vol'] = qtd_df['Close'] * qtd_df['Volume']
    dv_means = qtd_df.groupby('Ticker')['Dollar_Vol'].mean()
    initial = dv_means.reindex(tickers).dropna()
    initial = initial[initial > 0]
    if initial.empty:
        return {}

    weights = initial / initial.sum()

    close_pivot = (
        df.pivot_table(index='Date', columns='Ticker', values='Close')
        .sort_index()
    )
    returns = close_pivot.pct_change()
    quarter_returns = returns[returns.index >= quarter_start]

    current_weights = weights.astype(float)
    for _, row in quarter_returns.iterrows():
        common = current_weights.index.intersection(row.index[row.notna()])
        if len(common) == 0:
            continue
        updated = current_weights[common] * (1.0 + row[common].astype(float))
        total = updated.sum()
        if total > 0:
            current_weights = updated / total
        else:
            current_weights = updated

    return {
        str(symbol): float(weight)
        for symbol, weight in current_weights.items()
        if pd.notna(weight)
    }

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

    # Read last historical row per constituent
    needed_cols = ['Ticker', 'Date', 'Close', 'Trend', 'Resistance_Pivot', 'Support_Pivot',
                   'Upper_Target', 'Lower_Target', 'Is_Breakout_Sequence']
    hist = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=needed_cols, filters=[('Ticker', 'in', tickers)])
    last = hist.sort_values('Date').groupby('Ticker').tail(1).set_index('Ticker')

    uptrend = 0
    bo_seq = 0
    total = 0

    for t in tickers:
        if t not in live_close or t not in last.index:
            continue
        total += 1
        lc = live_close[t]
        r = last.loc[t]

        prev_res = r['Resistance_Pivot']
        prev_sup = r['Support_Pivot']
        prev_trend = r['Trend']
        prev_upper = r['Upper_Target']
        prev_lower = r['Lower_Target']
        prev_bo = r['Is_Breakout_Sequence']

        # Incremental trend from pivots
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

        # Incremental breakout sequence from pivots + targets
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
        return {}

    result = {
        'Uptrend_Pct': round(uptrend / total * 100, 1),
        'Breakout_Pct': round(bo_seq / total * 100, 1),
    }

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
        for f in list(folder.glob("*_of_*_signals.parquet")) + list(folder.glob("*_of_*_basket.parquet")):
            name = f.stem
            name = name.rsplit("_signals", 1)[0].rsplit("_basket", 1)[0]
            slug = re.sub(r'(_\d+)?_of_\d+$', '', name)
            if slug in t_names: cats["Themes"].append(slug)
            elif slug in s_names: cats["Sectors"].append(slug)
            else: cats["Industries"].append(slug)
    for k in cats: cats[k] = sorted(set(cats[k]))
    return cats

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

        latest_universe = get_latest_universe_tickers(basket_name)
        tickers = []
        current_weights = compute_current_basket_weights(latest_universe) if latest_universe else {}
        if current_weights:
            tickers = sorted([{"symbol": s, "weight": float(w)} for s, w in current_weights.items()], key=lambda x: x['weight'], reverse=True)
        elif latest_universe:
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

@app.get("/api/tickers/{ticker}")
def get_ticker_data(ticker: str):
    if not INDIVIDUAL_SIGNALS_FILE.exists(): raise HTTPException(status_code=404)
    try:
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, filters=[('Ticker', '==', ticker)])
        df['Date'] = pd.to_datetime(df['Date'])

        # Merge live data and recompute signals for today's candle
        live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
        if live_df is not None:
            live_row = live_df[live_df['Ticker'] == ticker]
            if not live_row.empty:
                live_row = live_row.copy()
                live_row['Date'] = pd.to_datetime(live_row['Date'])

                # Build combined OHLC and recompute all signals including live bar
                ohlc_cols = ['Date', 'Open', 'High', 'Low', 'Close']
                if 'Volume' in df.columns:
                    ohlc_cols.append('Volume')
                live_ohlc = live_row[[c for c in ohlc_cols if c in live_row.columns]].copy()
                if 'Volume' not in live_ohlc.columns:
                    live_ohlc['Volume'] = 0
                combined = pd.concat([df[ohlc_cols], live_ohlc], ignore_index=True)
                combined = combined.drop_duplicates(subset=['Date'], keep='last').sort_values('Date')

                result = signals_engine._build_signals_from_df(combined.set_index('Date'), ticker)
                if result is not None:
                    result['Date'] = pd.to_datetime(result['Date']).dt.strftime('%Y-%m-%d')
                    return {"chart_data": clean_data_for_json(result.sort_values('Date')), "tickers": []}

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


def safe_float(value, digits=4):
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)


def safe_int(value):
    if value is None or pd.isna(value):
        return 0
    return int(value)

@app.get("/api/baskets/{basket_name}/summary")
def get_basket_summary(basket_name: str):
    if not INDIVIDUAL_SIGNALS_FILE.exists():
        raise HTTPException(status_code=404, detail="Signals file not found")
    try:
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
                       'Resistance_Pivot', 'Support_Pivot', 'Upper_Target', 'Lower_Target']
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

        # For each ticker and signal pair, find which signal fired most recently
        # so we only report one open signal per pair per ticker.
        SHORT_SIGNALS = {'Down_Rot', 'Breakdown', 'STFR'}
        last_fired = {}  # (ticker, pair_index) -> (signal_type, entry_date)
        for _, row in df.iterrows():
            ticker = row['Ticker']
            row_date = row['Date']
            for pi, (s1, s2) in enumerate(SIGNAL_PAIRS):
                if row.get(SIGNAL_IS_COL[s1], False):
                    last_fired[(ticker, pi)] = (s1, row_date)
                if row.get(SIGNAL_IS_COL[s2], False):
                    last_fired[(ticker, pi)] = (s2, row_date)

        latest = df.groupby('Ticker').tail(1)

        # Exclude delisted tickers whose data ends before the most recent date
        max_date = latest['Date'].max()
        latest = latest[latest['Date'] >= max_date]

        # Read live closes for intraday price updates
        live_df = _read_live_parquet(LIVE_SIGNALS_FILE)
        live_closes = {}
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

            # --- BTFD/STFR: only show open (unexited) signals ---
            # Only flag live when live price crosses a target the historical close hadn't
            btfd_is_live = False
            if ticker in live_closes:
                prev_lower = row.get('Lower_Target')
                prev_upper = row.get('Upper_Target')
                if pd.notna(prev_lower) and close < prev_lower and hist_close >= prev_lower:
                    btfd_is_live = True
                if pd.notna(prev_upper) and close > prev_upper and hist_close <= prev_upper:
                    btfd_is_live = True

            pi = 2
            s1, s2 = SIGNAL_PAIRS[pi]
            fired = last_fired.get((ticker, pi))
            if fired is not None:
                active, entry_date = fired
                entry_col = f'{active}_Entry_Price'
                exit_col = f'{active}_Exit_Date'
                entry_price = row.get(entry_col) if entry_col in row.index else None
                exit_date = row.get(exit_col) if exit_col in row.index else None
                if pd.notna(entry_price) and pd.isna(exit_date):
                    if active in SHORT_SIGNALS:
                        perf = (entry_price - close) / entry_price if entry_price else 0
                    else:
                        perf = (close - entry_price) / entry_price if entry_price else 0
                    entry_date_str = pd.Timestamp(entry_date).strftime('%Y-%m-%d') if pd.notna(entry_date) else None
                    open_signals.append({
                        'Ticker': ticker, 'Signal_Type': active,
                        'Entry_Date': entry_date_str,
                        'Close': safe_float(close, 2),
                        'Entry_Price': safe_float(entry_price, 2),
                        'Current_Performance': safe_float(perf, 4),
                        'Win_Rate': safe_float(row.get(f'{active}_Win_Rate')),
                        'Avg_Winner': safe_float(row.get(f'{active}_Avg_Winner')),
                        'Avg_Loser': safe_float(row.get(f'{active}_Avg_Loser')),
                        'Avg_Winner_Bars': safe_float(row.get(f'{active}_Avg_Winner_Bars'), 1),
                        'Avg_Loser_Bars': safe_float(row.get(f'{active}_Avg_Loser_Bars'), 1),
                        'Avg_MFE': safe_float(row.get(f'{active}_Avg_MFE')),
                        'Avg_MAE': safe_float(row.get(f'{active}_Avg_MAE')),
                        'Std_Dev': safe_float(row.get(f'{active}_Std_Dev')),
                        'Historical_EV': safe_float(row.get(f'{active}_Historical_EV')),
                        'EV_Last_3': safe_float(row.get(f'{active}_EV_Last_3')),
                        'Risk_Adj_EV': safe_float(row.get(f'{active}_Risk_Adj_EV')),
                        'Risk_Adj_EV_Last_3': safe_float(row.get(f'{active}_Risk_Adj_EV_Last_3')),
                        'Count': safe_int(row.get(f'{active}_Count')),
                        'Is_Live': btfd_is_live,
                    })
        open_signals.sort(key=lambda x: x['Ticker'])

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
