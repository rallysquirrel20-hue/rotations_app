# Integration Map

Cross-reference of how backend endpoints, frontend components, and CSS classes connect.

---

## Backend Endpoints (`backend/main.py`)

### `GET /`
- Health check / root

### `GET /api/baskets`
- Lists all baskets (Themes, Sectors, Industries)
- Consumer: `App.tsx` sidebar basket list

### `GET /api/baskets/{name}`
- Basket OHLCV data, signals, correlation, weighted tickers
- Consumer: `App.tsx` -> `TVChart.tsx` candlestick/volume/breadth/breakout/correlation panes

### `GET /api/baskets/{name}/summary`
- Returns `open_signals`, `correlation` (21-day matrix), `cumulative_returns` (per-ticker equity curves)
- Cumulative returns: uses contributions file if available (active membership aware), else falls back to close prices + join dates
- Consumer: `BasketSummary.tsx` -> `SignalsTable`, `CorrelationHeatmap`, `ReturnsChart`

### `GET /api/baskets/{name}/correlation`
- 21-day trailing correlation matrix at a specific date
- Consumer: `CorrelationHeatmap` (date-specific lookup on click)

### `GET /api/baskets/{name}/contributions`
- Per-constituent contribution data for a date range (`?start=&end=`)
- Loads `{slug}_*_contributions.parquet` via `_find_basket_contributions()`
- Computes per-ticker `first_date`, `last_date` from full dataset (before date filtering)
- Computes `current_weight` (Weight_BOD on dataset max date; null if ticker has exited)
- Builds equity curve: daily `sum(Contribution)` -> cumulative product -> `equity_dates[]`, `equity_values[]`
- Aggregates per-ticker: `total_contribution`, `initial_weight`, `final_weight` (within filtered range)
- Response fields:
  - `tickers[]`, `dates[]`, `total_contributions[]`
  - `initial_weights[]`, `final_weights[]`
  - `first_dates[]`, `last_dates[]`, `current_weights[]`
  - `equity_dates[]`, `equity_values[]`
  - `date_range { min, max }`
- Consumer: `BasketSummary.tsx` -> `ContributionChart`

### `GET /api/baskets/{name}/candle-detail`
- Per-constituent weights, returns, contributions for a single day
- Consumer: `TVChart.tsx` (candle click detail)

### `GET /api/tickers`
- Lists all 500 tickers
- Consumer: `App.tsx` ticker search/list

### `GET /api/tickers/{ticker}`
- Daily OHLCV with optional live Databento merge
- Consumer: `App.tsx` -> `TVChart.tsx` individual ticker chart

### `GET /api/live-signals`
- Live signal scan results
- Consumer: `App.tsx`

### `WebSocket /ws/live/{ticker}`
- Real-time 1-minute bars from Databento Live API
- Consumer: `TVChart.tsx` live updates

---

## Frontend Components (`frontend/src/`)

### `App.tsx`
- Main orchestration: view switching (Themes/Sectors/Industries/Tickers), date range, WebSocket lifecycle
- Fetches: `/api/baskets`, `/api/baskets/{name}`, `/api/tickers`, `/api/tickers/{ticker}`, `/api/live-signals`
- Renders: `TVChart`, `BasketSummary`

### `TVChart.tsx`
- Multi-pane `lightweight-charts` component (price, volume, breadth, breakout, correlation)
- Drag-resizable panes, synchronized crosshairs, live WebSocket updates
- Fetches: `/api/baskets/{name}/candle-detail` on candle click

### `BasketSummary.tsx`
- Tabbed summary panel with six tabs:

| Tab | Component | Data Source |
|---|---|---|
| Breakout | `SignalsTable` | `/api/baskets/{name}/summary` -> `open_signals` |
| Rotation | `SignalsTable` | `/api/baskets/{name}/summary` -> `open_signals` |
| BTFD | `SignalsTable` | `/api/baskets/{name}/summary` -> `open_signals` |
| Correlation | `CorrelationHeatmap` | `/api/baskets/{name}/summary` -> `correlation` (+ `/api/baskets/{name}/correlation` for date drill-down) |
| Returns | `ReturnsChart` | `/api/baskets/{name}/summary` -> `cumulative_returns` |
| Contribution | `ContributionChart` | `/api/baskets/{name}/contributions` |

#### `ReturnsChart`
- Canvas-rendered cumulative returns line chart with hover interaction
- `presetMode` state (`'Q'` | `'Y'`) with Q/Y toggle buttons
- `quarterPresets`: all quarters newest-first (no limit)
- `annualPresets`: full-year presets
- `activePresets` switches between quarter/annual based on `presetMode`
- Sidebar uses `contrib-sidebar` class and `contrib-toggle-btn` for Q/Y toggle

#### `ContributionChart`
- `ContributionData` interface:
  - `tickers`, `dates`, `total_contributions`, `initial_weights`, `final_weights`
  - `first_dates`, `last_dates`, `current_weights` (per-ticker metadata from full dataset)
  - `equity_dates`, `equity_values` (basket equity curve)
  - `date_range { min, max }`
- `presetMode` state (`'Q'` | `'Y'`) with Q/Y toggle buttons
- `quarterPresets`: all quarters newest-first (no limit)
- `annualPresets`: full-year presets
- `activePresets` switches between quarter/annual based on `presetMode`
- Canvas layout:
  - Top 25%: equity % return area chart (blue fill when positive, pink fill when negative)
  - Bottom 75%: horizontal bar chart of per-ticker total contribution
- Hover panel: shows ticker name, total contribution, Entry date (`first_dates`), Exit date (`last_dates`), Current Weight (`current_weights`)
- Sidebar uses `contrib-sidebar` class with `contrib-toggle-btn` for Q/Y toggle

#### `CorrelationHeatmap`
- Canvas-rendered 21-day correlation matrix
- Fetches date-specific matrix via `/api/baskets/{name}/correlation?date=`

#### `SignalsTable`
- Sortable table of open signals with performance metrics

---

## CSS Classes (`frontend/src/index.css`)

### Contribution / Returns Sidebar
| Class | Purpose |
|---|---|
| `.contrib-sidebar` | Sidebar layout for ContributionChart and ReturnsChart (applied alongside `.returns-legend-left`) |
| `.contrib-preset-toggle` | Container for Q/Y toggle button group |
| `.contrib-toggle-btn` | Individual Q/Y toggle button (border, hover, `.active` variant) |
| `.contrib-quarter-presets` | Scrollable overflow container for quarter/annual preset buttons |

---

## Data Flow

```
rotations_signals pipeline (offline)
  -> Parquet/JSON caches in Python_Outputs/
    -> backend/main.py serves via REST API
      -> frontend App.tsx fetches and renders
        -> TVChart.tsx (lightweight-charts)
        -> BasketSummary.tsx
             -> SignalsTable (Breakout/Rotation/BTFD tabs)
             -> CorrelationHeatmap
             -> ReturnsChart (cumulative returns + Q/Y presets)
             -> ContributionChart (bar chart + equity curve + Q/Y presets)

Databento Live API (real-time)
  -> backend/main.py WebSocket proxy
    -> frontend TVChart.tsx live updates
```

---

## Key Data Files

| File Pattern | Used By |
|---|---|
| `signals_cache_500.parquet` | `/api/baskets/{name}/summary` (open signals) |
| `{slug}_equity_ohlc.parquet` | `/api/baskets/{name}` (basket OHLCV) |
| `{slug}_basket_signals.parquet` | `/api/baskets/{name}` (basket signals) |
| `within_osc_500.parquet` | `/api/baskets/{name}/summary` (correlation) |
| `{slug}_*_contributions.parquet` | `/api/baskets/{name}/contributions`, `/api/baskets/{name}/candle-detail`, `/api/baskets/{name}/summary` (cumulative returns) |
| `gics_mappings_500.json` | Sector/industry ticker mappings |
| `top500stocks.json` | Quarterly universe |
