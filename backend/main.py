from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import os
from pathlib import Path
import json
import pickle

app = FastAPI()

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
DEFAULT_PATH = r"C:\Users\xbtsq\Documents\Python_Outputs\Pickle_Files"
BASE_DIR = Path(os.getenv("TRADING_DATA_PATH", DEFAULT_PATH))

BASKET_EQUITY_CACHE = BASE_DIR / "basket_equity_cache"
BASKET_SIGNALS_CACHE = BASE_DIR / "basket_signals_cache"
INDIVIDUAL_SIGNALS_FILE = BASE_DIR / "signals_cache_500.parquet"
TOP_500_FILE = BASE_DIR / "top500stocks.pkl"
GICS_MAPPINGS_FILE = BASE_DIR / "gics_mappings_500.pkl"

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
        p_path = BASE_DIR / fn
        if p_path.exists():
            with open(p_path, 'rb') as f:
                data = pickle.load(f)
                ud = data[idx] if idx is not None else data
                qs = sorted(ud.keys())
                if qs: return list(ud[qs[-1]])
    return []

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

@app.get("/api/baskets/{basket_name}")
def get_basket_data(basket_name: str):
    ohlc_file = BASKET_EQUITY_CACHE / f"{basket_name}_equity_ohlc.parquet"
    signals_file = BASKET_SIGNALS_CACHE / f"{basket_name}_basket_signals.parquet"
    meta_file = BASKET_EQUITY_CACHE / f"{basket_name}_equity_meta.json"
    if not ohlc_file.exists(): raise HTTPException(status_code=404)
    try:
        df_ohlc = pd.read_parquet(ohlc_file)
        if 'Date' in df_ohlc.columns: df_ohlc['Date'] = pd.to_datetime(df_ohlc['Date']).dt.strftime('%Y-%m-%d')
        if signals_file.exists():
            df_s = pd.read_parquet(signals_file)
            if 'Date' in df_s.columns: df_s['Date'] = pd.to_datetime(df_s['Date']).dt.strftime('%Y-%m-%d')
            df = pd.merge(df_ohlc, df_s.drop(columns=[c for c in ['Open','High','Low','Close','Volume'] if c in df_s.columns]), on='Date', how='left')
        else: df = df_ohlc
        tl = get_latest_universe_tickers(basket_name)
        dv = get_dv_data()
        tickers = []
        if tl and dv:
            w = {t: dv.get(t, 0) for t in tl}
            tot = sum(w.values())
            if tot > 0: tickers = sorted([{"symbol": k, "weight": v / tot} for k, v in w.items()], key=lambda x: x['weight'], reverse=True)
            else: tickers = [{"symbol": t, "weight": 0} for t in tl]
        if not tickers and meta_file.exists():
            with open(meta_file, 'r') as f:
                m = json.load(f)
                w = m.get('state', {}).get('weights', {})
                tickers = sorted([{"symbol": k, "weight": v} for k, v in w.items()], key=lambda x: x['weight'], reverse=True)
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
        return {"chart_data": clean_data_for_json(df.sort_values('Date')), "tickers": []}
    except: raise HTTPException(status_code=500)

if __name__ == "__main__":
    import uvicorn
    # Use 0.0.0.0 to allow access from other devices on the network
    uvicorn.run(app, host="0.0.0.0", port=8000)
