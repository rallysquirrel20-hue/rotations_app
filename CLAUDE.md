# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Full-stack financial analysis dashboard for visualizing stock rotation signals, basket composition, correlations, and cumulative returns. Consumes pre-computed signal data from the `rotations_signals` project and adds real-time intraday capabilities via Databento.

## Tech Stack

- **Backend:** FastAPI (Python), Pandas, NumPy, Databento API
- **Frontend:** React 18 + TypeScript, Vite, lightweight-charts (TradingView), Axios
- **Data:** Parquet/Pickle caches from `rotations_signals`, Databento for live/intraday

## Commands

```bash
# Backend
cd backend
pip install fastapi uvicorn pandas numpy databento python-dotenv pyarrow
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Frontend
cd frontend
npm install
npm run dev        # Dev server on http://localhost:5173
npm run build      # tsc -b && vite build
npm run lint       # eslint .
```

## Environment Variables (backend `.env`)

- `DATABENTO_API_KEY` — Required for live/intraday data
- `DATABENTO_DATASET` — Default: `EQUS.MINI`
- `DATABENTO_STYPE_IN` — Default: `raw_symbol`
- `DATABENTO_LOOKBACK_DAYS` — Default: 90 (intraday history depth)
- `DATABENTO_SYMBOL_CHUNK` — Default: 200 (symbols per API call)
- `INTRADAY_RTH_ONLY` — Default: True (filter to 09:30–15:59 NY)
- `FORCE_REBUILD_INTRADAY_CACHE` — Default: False
- `PYTHON_OUTPUTS_DIR` — Base path for cached data (default: `~/Documents/Python_Outputs`)

## Architecture

### Backend (`backend/`)

**`main.py`** — FastAPI server with REST endpoints and WebSocket streaming.

API endpoints:
- `GET /api/baskets` — Lists all baskets (Themes, Sectors, Industries)
- `GET /api/baskets/{name}` — Basket OHLCV data, signals, correlation, weighted tickers
- `GET /api/baskets/{name}/summary` — Open signals, 21-day correlation matrix, 1-year cumulative returns
- `GET /api/tickers` — Lists all 500 tickers
- `GET /api/tickers/{ticker}` — Daily OHLCV with optional live Databento merge
- `GET /api/tickers/{ticker}/intraday?interval={1m|5m|30m}` — Intraday bars (RTH only, max 5000 rows)
- `WebSocket /ws/live/{ticker}` — Real-time 1-minute bars from Databento Live API

Data sources (read from `PYTHON_OUTPUTS_DIR`):
- `Pickle_Files/signals_cache_500.parquet` — Individual ticker signals
- `Pickle_Files/basket_equity_cache/{slug}_equity_ohlc.parquet` — Basket OHLC
- `Pickle_Files/basket_signals_cache/{slug}_basket_signals.parquet` — Basket signals
- `Pickle_Files/correlation_cache/within_osc_500.parquet` — Pre-computed correlations
- `Pickle_Files/gics_mappings_500.json` — Sector/industry ticker mappings
- `Pickle_Files/top500stocks.json` — Quarterly universe

**`signals_engine.py`** — Intraday signal calculation engine. Fetches 1-minute bars from Databento, resamples to 30-minute, and runs the same 3-phase rotation algorithm used in `rotations_signals`:

1. **Phase 1 — Trend & Pivots**: RV with 10-day EMA, support/resistance pivots scaled by `sqrt(252/21)`
2. **Phase 2 — Ranges & Targets**: EMA-smoothed up/down ranges, upper/lower price targets
3. **Phase 3 — Entry/Exit & Stats**: 6 signal types (`Up_Rot`, `Down_Rot`, `Breakout`, `Breakdown`, `BTFD`, `STFR`) with `RollingStatsAccumulator` for rolling win rate, EV, MFE/MAE

Caches intraday 30m bars and signals as Parquet with universe signature validation (SHA256 of ticker list).

### Frontend (`frontend/`)

**`App.tsx`** — Main orchestration component. Manages view switching (Themes/Sectors/Industries/Tickers), timeframe selection (Daily/1m/5m/30m), date range filtering, and WebSocket lifecycle. Uses `window.location.hostname` for dynamic API host detection (enables mobile-to-PC access).

**`TVChart.tsx`** — Multi-pane chart using `lightweight-charts`. Synchronized crosshairs and time scales across panes:
- **Price pane**: Candlesticks + resistance pivots (pink) + support pivots (blue) + upper/lower targets
- **Volume pane**: Histogram
- **Breadth pane**: Uptrend_Pct line
- **Breakout pane**: Breakout_Pct line
- **Correlation pane**: Correlation_Pct line

Panes are drag-resizable (min 40px, default 80px). Supports live WebSocket updates, date range navigation, and chart export.

**`BasketSummary.tsx`** — Tabbed summary panel with three views:
- **Signals tab**: Sortable table of open signals with performance metrics
- **Correlation tab**: Canvas-rendered heatmap of 21-day correlation matrix
- **Returns tab**: Canvas-rendered cumulative returns line chart with hover interaction

### Styling

Solarized Light color scheme. Monospace font (Fira Code / Cascadia Code / Consolas). Flexbox layout with 300px sidebar. No border-radius or box-shadows (terminal aesthetic).

## Data Flow

```
rotations_signals pipeline (offline)
  → Parquet/JSON caches in Python_Outputs/
    → backend/main.py serves via REST API
      → frontend App.tsx fetches and renders
        → TVChart.tsx (lightweight-charts)
        → BasketSummary.tsx (signals/correlation/returns)

Databento Live API (real-time)
  → backend/main.py WebSocket proxy
    → frontend TVChart.tsx live updates
  → backend/signals_engine.py (intraday signal calc)
    → backend/main.py intraday endpoint
```

## Debug Scripts

- `check_data.py` — Inspect cached data files
- `check_pivots.py` — Validate pivot calculations
- `debug_pickles.py` / `debug_pickles_v2.py` — Inspect pickle cache contents
