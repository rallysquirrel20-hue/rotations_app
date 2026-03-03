from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import numpy as np
import os
from pathlib import Path
import json
import pickle
import databento as db
from dotenv import load_dotenv
from datetime import datetime, timedelta
import asyncio
import logging
import signals_engine
from zoneinfo import ZoneInfo

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

env_path = Path(__file__).parent / ".env"
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
BASE_DIR = Path(os.getenv("PYTHON_OUTPUTS_DIR", str(DEFAULT_PATH)))

BASKET_EQUITY_CACHE = BASE_DIR / "Pickle_Files" / "basket_equity_cache"
BASKET_SIGNALS_CACHE = BASE_DIR / "Pickle_Files" / "basket_signals_cache"
INDIVIDUAL_SIGNALS_FILE = BASE_DIR / "Pickle_Files" / "signals_cache_500.parquet"
TOP_500_FILE = BASE_DIR / "Pickle_Files" / "top500stocks.pkl"
GICS_MAPPINGS_FILE = BASE_DIR / "Pickle_Files" / "gics_mappings_500.pkl"

THEMATIC_CONFIG = {
    "High_Beta": ("beta_universes_500.pkl", 0),
    "Low_Beta": ("beta_universes_500.pkl", 1),
    "Momentum_Leaders": ("momentum_universes_500.pkl", 0),
    "Momentum_Losers": ("momentum_universes_500.pkl", 1),
    "High_Dividend_Yield": ("dividend_universes_500.pkl", 0),
    "Dividend_Growth": ("dividend_universes_500.pkl", 1),
    "Risk_Adj_Momentum": ("risk_adj_momentum_500.pkl", None),
}

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
        with open(GICS_MAPPINGS_FILE, 'rb') as f:
            gics = pickle.load(f)
            search_name = basket_name.replace("_", " ")
            if search_name in gics:
                d = gics[search_name]
                qs = sorted(d.keys())
                if qs: return list(d[qs[-1]])
    if basket_name in THEMATIC_CONFIG:
        fn, idx = THEMATIC_CONFIG[basket_name]
        p_path = BASE_DIR / "Pickle_Files" / fn
        if p_path.exists():
            with open(p_path, 'rb') as f:
                data = pickle.load(f)
                ud = data[idx] if idx is not None else data
                qs = sorted(ud.keys())
                if qs: return list(ud[qs[-1]])
    return []


def get_meta_file_tickers(basket_name):
    meta_file = BASKET_EQUITY_CACHE / f"{basket_name}_equity_meta.json"
    if not meta_file.exists():
        return []
    try:
        with open(meta_file, 'r') as f:
            meta = json.load(f)
        weights = meta.get('state', {}).get('weights', {})
        return list(weights.keys())
    except Exception:
        return []


def get_meta_file_weights(basket_name):
    meta_file = BASKET_EQUITY_CACHE / f"{basket_name}_equity_meta.json"
    if not meta_file.exists():
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

@app.get("/")
def read_root(): return {"status": "ok", "data_path": str(BASE_DIR)}

@app.get("/api/baskets")
def list_baskets():
    if not BASKET_EQUITY_CACHE.exists(): return {"Themes": [], "Sectors": [], "Industries": []}
    t_names = list(THEMATIC_CONFIG.keys())
    s_names = ["Communication_Services", "Consumer_Discretionary", "Consumer_Staples", "Energy", "Financials", "Health_Care", "Industrials", "Information_Technology", "Materials", "Real_Estate", "Utilities"]
    cats = {"Themes": [], "Sectors": [], "Industries": []}
    for f in BASKET_EQUITY_CACHE.glob("*_equity_ohlc.parquet"):
        bn = f.name.replace("_equity_ohlc.parquet", "")
        if bn in t_names: cats["Themes"].append(bn)
        elif bn in s_names: cats["Sectors"].append(bn)
        else: cats["Industries"].append(bn)
    for k in cats: cats[k].sort()
    return cats

CORRELATION_FILE = BASE_DIR / "Pickle_Files" / "correlation_cache" / "within_osc_500.parquet"

logger.info(f"BASE_DIR: {BASE_DIR} (exists={BASE_DIR.exists()})")
logger.info(f"BASKET_SIGNALS_CACHE: {BASKET_SIGNALS_CACHE} (exists={BASKET_SIGNALS_CACHE.exists()})")
logger.info(f"CORRELATION_FILE: {CORRELATION_FILE} (exists={CORRELATION_FILE.exists()})")

def get_basket_correlation(basket_name):
    if not CORRELATION_FILE.exists():
        return pd.Series(dtype=float)
    try:
        df_all = pd.read_parquet(CORRELATION_FILE)
        
        # Try exact match first
        search_name = basket_name.replace("_", " ")
        col_name = f"21|{search_name}"
        
        if col_name not in df_all.columns:
            # Fallback: case-insensitive partial match, normalizing & vs and
            search_norm = search_name.lower().replace(" & ", " and ")
            for col in df_all.columns:
                col_norm = col.lower().replace(" & ", " and ")
                if search_norm in col_norm:
                    col_name = col
                    break
        
        if col_name not in df_all.columns:
            logger.warning(f"Correlation column not found for {basket_name}")
            return pd.Series(dtype=float)
            
        df = df_all[[col_name]].copy()
        df = df.reset_index()
        df.columns = ['Date', 'Correlation_Pct']
        df['Date'] = pd.to_datetime(df['Date'])
        return df
    except Exception as e:
        logger.error(f"Error loading pre-calculated correlation for {basket_name}: {e}")
        return pd.Series(dtype=float)

@app.get("/api/baskets/{basket_name}")
def get_basket_data(basket_name: str):
    ohlc_file = BASKET_EQUITY_CACHE / f"{basket_name}_equity_ohlc.parquet"
    signals_file = BASKET_SIGNALS_CACHE / f"{basket_name}_basket_signals.parquet"
    if not ohlc_file.exists(): raise HTTPException(status_code=404)
    try:
        df_ohlc = pd.read_parquet(ohlc_file)
        if signals_file.exists():
            df_s = pd.read_parquet(signals_file)
            df_ohlc['Date'] = pd.to_datetime(df_ohlc['Date'])
            df_s['Date'] = pd.to_datetime(df_s['Date'])
            df = pd.merge(df_ohlc, df_s.drop(columns=[c for c in ['Open','High','Low','Close','Volume'] if c in df_s.columns]), on='Date', how='left')
        else:
            df = df_ohlc
            df['Date'] = pd.to_datetime(df['Date'])

        # LOAD PRE-CALCULATED CORRELATION
        corr_df = get_basket_correlation(basket_name)
        logger.info(f"Loaded correlation data for {basket_name}: {len(corr_df)} rows")
        
        if not corr_df.empty:
            df = pd.merge(df, corr_df, on='Date', how='left')
            logger.info(f"Merged chart data rows: {len(df)}, Non-null Correlation: {df['Correlation_Pct'].notna().sum()}")
        
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
            with open(TOP_500_FILE, 'rb') as f:
                data = pickle.load(f)
                qs = sorted(data.keys())
                if qs: return sorted(list(data[qs[-1]]))
        except: pass
    if not INDIVIDUAL_SIGNALS_FILE.exists(): return []
    try:
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, columns=['Ticker'])
        return sorted(df['Ticker'].dropna().unique().tolist())
    except: raise HTTPException(status_code=500)

@app.get("/api/tickers/{ticker}")
def get_ticker_data(ticker: str):
    if not INDIVIDUAL_SIGNALS_FILE.exists(): raise HTTPException(status_code=404)
    try:
        df = pd.read_parquet(INDIVIDUAL_SIGNALS_FILE, filters=[('Ticker', '==', ticker)])
        if 'Date' in df.columns: df['Date'] = pd.to_datetime(df['Date']).dt.strftime('%Y-%m-%d')
        
        # Merge with live data if client is available
        if db_client:
            try:
                # Fetch today's data from Databento (ohlcv-1d)
                # We use today's date and a large enough lookback to ensure we catch the current bar
                start = datetime.now().strftime("%Y-%m-%d")
                live_data = db_client.timeseries.get_range(
                    dataset=DB_DATASET,
                    symbols=ticker,
                    schema="ohlcv-1d",
                    start=start,
                    stype_in=DB_STYPE_IN
                )
                if not live_data.empty:
                    live_df = live_data.to_df()
                    live_df['Date'] = live_df.index.strftime('%Y-%m-%d')
                    # Rename columns to match local schema
                    live_df = live_df.rename(columns={
                        'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close', 'volume': 'Volume'
                    })
                    # Combine and drop duplicates (preferring live data for today)
                    df = pd.concat([df, live_df[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']]])
                    df = df.drop_duplicates(subset=['Date'], keep='last')
            except Exception as live_e:
                print(f"Error fetching live daily data for {ticker}: {live_e}")

        return {"chart_data": clean_data_for_json(df.sort_values('Date')), "tickers": []}
    except: raise HTTPException(status_code=500)

@app.get("/api/tickers/{ticker}/intraday")
def get_intraday_data(ticker: str, response: Response, interval: str = "1m"):
    # Force browser to never cache intraday data
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    
    # Target the new Intraday_Data parquet files
    intraday_file = BASE_DIR / "Intraday_Data" / f"{ticker}_1m.parquet"
    
    try:
        if not intraday_file.exists():
            # Fallback to Databento API if parquet hasn't been built yet
            if not db_client: 
                raise HTTPException(status_code=503, detail="Databento client not configured and parquet not found")
            
            fetch_interval = "1m" if interval in ["5m", "30m"] else interval
            schema = f"ohlcv-{fetch_interval}"
            start = (datetime.now() - timedelta(days=4)).strftime("%Y-%m-%d")
            data = db_client.timeseries.get_range(
                dataset=DB_DATASET, symbols=ticker, schema=schema, start=start, stype_in=DB_STYPE_IN
            )
            df = data.to_df()
            if df.empty: return {"chart_data": []}
            
            # Standardize column names
            rename_map = {'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close', 'volume': 'Volume'}
            df = df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns})
            
            # Convert to NY and Filter RTH
            df.index = df.index.tz_convert('America/New_York')
            df = df.between_time('09:30', '15:59')
        else:
            # Parquet flow
            df = pd.read_parquet(intraday_file)
            df['Date'] = pd.to_datetime(df['Date'])
            df.index = df['Date']
            
            # Convert to NY and Filter RTH
            df.index = df.index.tz_convert('America/New_York')
            df = df.between_time('09:30', '15:59')

        # Resample logic (applies to both fallback and parquet)
        if interval in ["5m", "30m"]:
            resample_rule = '5min' if interval == "5m" else '30min'
            # Resample OHLCV
            df = df.resample(resample_rule).agg({
                'Open': 'first', 'High': 'max', 'Low': 'min', 'Close': 'last', 'Volume': 'sum'
            }).dropna().reset_index()
            # Recalculate signals for the specific timeframe
            df = signals_engine._build_signals_from_df(df, ticker)
        elif 'Resistance_Pivot' not in df.columns:
            # Recalculate signals for 1m if not present (likely API fallback)
            df = signals_engine._build_signals_from_df(df.reset_index(), ticker)

        # Limit rows strictly to prevent lightweight-charts from crashing the browser
        df = df.tail(5000).copy()

        # Format as Nominal Local Time (No Z)
        if 'Date' not in df.columns: df = df.reset_index()
        df['Date'] = pd.to_datetime(df['Date']).dt.strftime('%Y-%m-%dT%H:%M:%S')
        
        return {"chart_data": clean_data_for_json(df.sort_values('Date'))}
    except Exception as e:
        logger.error(f"Error in get_intraday_data for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

SIGNAL_TYPES = ['Breakout', 'Breakdown', 'Up_Rot', 'Down_Rot', 'BTFD', 'STFR']


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
        cols_needed = ['Ticker', 'Date', 'Close']
        for st in SIGNAL_TYPES:
            cols_needed.extend([
                f'{st}_Entry_Price', f'{st}_Exit_Date', f'{st}_Win_Rate',
                f'{st}_Historical_EV', f'{st}_Risk_Adj_EV',
                f'{st}_Avg_Winner', f'{st}_Avg_Loser', f'{st}_Count',
            ])
        df = pd.read_parquet(
            INDIVIDUAL_SIGNALS_FILE,
            columns=cols_needed,
            filters=[('Ticker', 'in', tickers)],
        )
        latest = df.sort_values('Date').groupby('Ticker').tail(1)

        open_signals = []
        for _, row in latest.iterrows():
            ticker = row['Ticker']
            close = row['Close']
            for st in SIGNAL_TYPES:
                entry_col = f'{st}_Entry_Price'
                exit_col = f'{st}_Exit_Date'
                if entry_col not in row.index:
                    continue
                entry_price = row.get(entry_col)
                exit_date = row.get(exit_col)
                if pd.isna(entry_price) or pd.notna(exit_date):
                    continue
                perf = (close / entry_price - 1) if entry_price else 0
                open_signals.append({
                    'Ticker': ticker,
                    'Signal_Type': st.replace('_', ' ') if st in ('Up_Rot', 'Down_Rot') else st,
                    'Close': safe_float(close, 2),
                    'Current_Performance': safe_float(perf, 4),
                    'Entry_Price': safe_float(entry_price, 2),
                    'Win_Rate': safe_float(row.get(f'{st}_Win_Rate')),
                    'Historical_EV': safe_float(row.get(f'{st}_Historical_EV')),
                    'Risk_Adj_EV': safe_float(row.get(f'{st}_Risk_Adj_EV')),
                    'Avg_Winner': safe_float(row.get(f'{st}_Avg_Winner')),
                    'Avg_Loser': safe_float(row.get(f'{st}_Avg_Loser')),
                    'Count': safe_int(row.get(f'{st}_Count')),
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

        # --- 1Y Cumulative Returns ---
        one_year_ago = close_pivot.index.max() - pd.DateOffset(years=1)
        yearly = close_pivot[close_pivot.index >= one_year_ago].sort_index()
        # Rebase to first available price per ticker
        if yearly.empty:
            dates = []
            cum_series = []
        else:
            first_prices = yearly.bfill().iloc[0]
            rebased = yearly.divide(first_prices.where(first_prices.notna()), axis='columns') - 1
            dates = [d.strftime('%Y-%m-%d') for d in rebased.index]
            cum_series = []
            for t in sorted(rebased.columns):
                vals = [None if pd.isna(v) else round(float(v), 4) for v in rebased[t].tolist()]
                cum_series.append({'ticker': t, 'values': vals})

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
