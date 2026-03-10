# Dependency Tree

Maps every file, component, endpoint, and CSS class in the rotations_app project. Use this to trace how a change in one place ripples through the stack.

---

## Backend (`backend/`)

### `main.py` — FastAPI server

#### Endpoints

| Route | Method | Description |
|---|---|---|
| `/` | GET | Health check |
| `/api/baskets` | GET | List all baskets (Themes, Sectors, Industries) |
| `/api/baskets/{name}` | GET | Basket OHLCV data, signals, correlation, weighted tickers |
| `/api/baskets/{name}/summary` | GET | Open signals, 21-day correlation matrix, 1-year cumulative returns |
| `/api/baskets/{name}/correlation` | GET | Correlation matrix for a specific date (optional `?date=`) |
| `/api/baskets/{name}/contributions` | GET | Per-constituent contribution data (see details below) |
| `/api/baskets/{name}/candle-detail` | GET | Per-constituent weights/returns/contributions for a single day |
| `/api/tickers` | GET | List all 500 tickers |
| `/api/tickers/{ticker}` | GET | Daily OHLCV with optional live Databento merge |
| `/api/live-signals` | GET | Live signal tickers |
| `/ws/live/{ticker}` | WebSocket | Real-time 1-minute bars from Databento Live API |

#### `/api/baskets/{name}/contributions` endpoint (detail)

Query params: `?start=YYYY-MM-DD&end=YYYY-MM-DD`

Processing pipeline:
1. Reads `{slug}_contributions.parquet` via `_find_basket_contributions()`
2. Computes per-ticker `first_date`, `last_date` from full dataset **before** date filtering
3. Computes `current_weight` — `Weight_BOD` on the dataset max date; `null` if ticker has exited
4. Applies `start`/`end` date filtering
5. Builds equity curve: daily `sum(Contribution)` per date, then `(1 + daily_return).cumprod()` to produce `equity_dates[]` and `equity_values[]`
6. Aggregates per-ticker: `total_contribution`, `initial_weight` (first `Weight_BOD`), `final_weight` (last `Weight_BOD`)
7. Sorts tickers worst-to-best by `total_contribution`
8. Merges `ticker_meta` (first_date, last_date, current_weight) into the sorted agg dataframe so arrays align with `tickers[]`

Response fields:
- `tickers`, `total_contributions`, `initial_weights`, `final_weights`
- `first_dates`, `last_dates`, `current_weights`
- `equity_dates`, `equity_values`
- `dates`, `date_range { min, max }`

### `signals_engine.py` — Signal calculation engine

- `_build_signals_from_df()` — 3-phase rotation algorithm (Trend & Pivots, Ranges & Targets, Entry/Exit & Stats)
- Called by `main.py` when merging live Databento bars with historical cached data

---

## Frontend (`frontend/src/`)

### `main.tsx`

Entry point. Renders `<App />` into DOM.

### `App.tsx`

Top-level orchestration component.

| Dependency | Type | Purpose |
|---|---|---|
| `TVChart` | Component import | Multi-pane chart |
| `BasketSummary` | Component import | Tabbed summary panel |
| `axios` | Library | API requests |
| `API_BASE` | Constant | `http://{hostname}:8000/api` — dynamic host detection |

Manages: view switching (Themes/Sectors/Industries/Tickers), date range filtering, WebSocket lifecycle, sidebar with basket/ticker lists.

### `components/TVChart.tsx`

Multi-pane TradingView lightweight-charts component.

| Dependency | Type | Purpose |
|---|---|---|
| `lightweight-charts` | Library | Candlestick/line/histogram rendering |

Panes: Price (candlesticks + pivots + targets), Volume, Breadth, Breakout, Correlation. Synchronized crosshairs, drag-resizable, live WebSocket updates, chart export.

### `components/BasketSummary.tsx`

Tabbed summary panel. Exports `BasketSummary` component.

| Dependency | Type | Purpose |
|---|---|---|
| `axios` | Library | API requests (correlation date fetch, contributions fetch) |
| `react` | Library | `useState`, `useMemo`, `useRef`, `useEffect` |

#### Tabs (via `TabType`)

`'breakout' | 'rotation' | 'btfd' | 'correlation' | 'returns' | 'contribution'`

#### Interfaces

| Interface | Fields | Used by |
|---|---|---|
| `OpenSignal` | Ticker, Signal_Type, Entry_Date, Close, Entry_Price, Current_Performance, Win_Rate, Avg_Winner, Avg_Loser, Avg_Winner_Bars, Avg_Loser_Bars, Avg_MFE, Avg_MAE, Std_Dev, Historical_EV, EV_Last_3, Risk_Adj_EV, Risk_Adj_EV_Last_3, Count, Is_Live? | `SignalsTable` |
| `CorrelationData` | labels, matrix, min_date?, max_date? | `CorrelationHeatmap` |
| `CumulativeReturnsData` | dates, series[]{ticker, values, join_date?} | `ReturnsChart` |
| `ContributionData` | tickers, total_contributions, initial_weights, final_weights, first_dates, last_dates, current_weights, equity_dates, equity_values, dates, date_range{min,max} | `ContributionChart` |
| `BasketSummaryProps` | data{open_signals, correlation, cumulative_returns}, loading, basketName, apiBase | `BasketSummary` |

#### Internal components

##### `SignalsTable`

Props: `{ signals: OpenSignal[] }`

- Sortable table with 19 columns
- Color-coded performance/EV cells (blue positive, pink negative)
- LIVE row highlighting via `LIVE_ROW_COLORS`

##### `CorrelationHeatmap`

Props: `{ data: CorrelationData; basketName: string; apiBase: string }`

- Fetches date bounds from `/api/baskets/{name}/correlation`
- Date picker to view correlation as-of a specific date
- HTML table with cells colored via `corrColor()` (blue positive, pink negative, white at 0)
- Color legend bar

##### `ReturnsChart`

Props: `{ data: CumulativeReturnsData }`

State:
- `hoveredTicker` — highlights a single series
- `startDate`, `endDate` — date range (defaults to 1Y lookback)
- `presetMode` — `'Q' | 'Y'` toggle

Key logic:
- `quarterPresets` useMemo — all quarters newest-first, loops from `maxD` down to `minD`
- `annualPresets` useMemo — loops `maxYear` down to `minYear`
- `activePresets` — switches based on `presetMode`
- `windowedData` useMemo — slices + rebases series to window start (0% at window start or join date)
- `sortedSeries` useMemo — sorts by latest return value

Canvas rendering: cumulative return line chart, grid, zero line, X-axis labels. Lines colored per `COLORS[]` array with hover dimming.

Sidebar JSX structure: `contrib-sidebar` class
1. Date controls (start/end inputs + 1Y/All buttons)
2. Q/Y toggle (`.contrib-preset-toggle`)
3. Scrollable presets (`.contrib-quarter-presets`)

Right legend: ticker list with return values, hover interaction.

##### `ContributionChart`

Props: `{ basketName: string; apiBase: string }`

State:
- `contribData` — fetched `ContributionData`
- `startDate`, `endDate` — defaults to current quarter on mount
- `dateBounds` — full date range from API
- `hoveredIdx` — bar hover index
- `presetMode` — `'Q' | 'Y'` toggle

Data flow:
1. Mount: fetches `/api/baskets/{name}/contributions` for date bounds, defaults to current quarter
2. Date change: re-fetches with `?start=...&end=...`

Key logic:
- `quarterPresets` useMemo — all quarters newest-first (push, not unshift)
- `annualPresets` useMemo — loops `maxYear` down to `minYear`
- `activePresets` — switches based on `presetMode`

Canvas rendering (split layout):
- **Top 25%**: Equity % return area chart — blue fill above 0%, pink fill below 0%, line colored by sign (blue >= 0, pink < 0), date labels, grid with right Y-axis labels
- **Separator**: dashed line between regions
- **Bottom 75%**: Horizontal bar chart — bars sorted worst-to-best (from backend), blue for positive, pink for negative, angled ticker labels on X-axis, left Y-axis % labels

Hover panel (sidebar, fixed position):
- Ticker name
- Contribution (colored)
- Initial Weight, Final Weight, Drift (colored)
- Entry date (`first_dates[]`)
- Exit date (`last_dates[]`, shows "Active" if `current_weight` is not null)
- Current Weight (`current_weights[]`, shown only if not null)

Sidebar JSX structure: `contrib-sidebar` class
1. Fixed hover detail (`.contrib-legend-header`)
2. Q/Y toggle (`.contrib-preset-toggle`)
3. Scrollable presets (`.contrib-quarter-presets`)

#### Shared helpers

| Function | Purpose |
|---|---|
| `pctFmt(v)` | Format number as percentage string |
| `pctFmtCell(v)` | Cell-safe percentage formatter |
| `colorForPerf(v)` | Blue for positive, pink for negative |
| `colorForPerfCell(v)` | Cell-safe color |
| `dollarFmtCell(v)` | Dollar format |
| `corrColor(v)` | Correlation heatmap color (blue/pink gradient) |

#### Shared constants

| Constant | Purpose |
|---|---|
| `COLORS[28]` | Color palette for chart series |
| `SIGNAL_FILTERS` | Maps tab key to signal type arrays |
| `LIVE_ROW_COLORS` | Background tint per signal type |

---

## Styles (`frontend/src/index.css`)

### Global

| Selector | Purpose |
|---|---|
| `:root` | Solarized Light palette variables, pink/blue accent colors |
| `html, body, #root` | Full viewport, monospace font stack, no overflow |
| `*` | No border-radius, no box-shadow (terminal aesthetic) |
| `::-webkit-scrollbar*` | Custom scrollbar (sidebar background, base1 thumb) |

### Layout

| Selector | Purpose |
|---|---|
| `.app-container` | Flex row, full viewport |
| `.sidebar` | 300px wide, flex column, border-right |
| `.sidebar-header` | Title + view toggles |
| `.sidebar-scrollable-content` | Flex-1 overflow-y auto |
| `.sidebar-item` | List items with active/hover states |
| `.main-content` | Flex-1 column |
| `.main-header` | Controls bar (date range, toggles) |
| `.content-stack` | Chart + summary vertical stack |

### Chart

| Selector | Purpose |
|---|---|
| `.chart-container` | Flex-1 relative container |
| `.tv-chart-wrapper` | 100% fill |
| `.chart-overlay-toggles` | Absolute-positioned toggle panel |
| `.loading-overlay` | Semi-transparent loading state |

### Summary panel

| Selector | Purpose |
|---|---|
| `.summary-panel` | Flex column container |
| `.summary-tabs` | Tab bar (flex row, gap 2px) |
| `.summary-tab` | Individual tab button (active = blue) |
| `.summary-content` | Flex-1 overflow hidden |
| `.summary-table-wrapper` | Scrollable table container |
| `.summary-table` | Full-width collapsed borders |
| `.summary-th` | Header cells (base1 background, uppercase) |
| `.summary-td` | Data cells |
| `.live-tag` | LIVE badge on signal rows |

### Correlation tab

| Selector | Purpose |
|---|---|
| `.corr-wrapper` | Flex column, centered, overflow hidden |
| `.corr-scroll` | Overflow hidden container |
| `.corr-row-label`, `.corr-header-text` | 10px font, no wrap |
| `.corr-legend` | Gradient legend bar |

### Returns tab

| Selector | Purpose |
|---|---|
| `.returns-container` | Flex row (sidebar + chart + legend) |
| `.returns-legend-left` | 120px sidebar, overflow-y auto |
| `.returns-legend-right` | 120px right legend, overflow-y auto |
| `.returns-right` | Flex-1 column (date controls + chart) |
| `.returns-chart` | Flex-1 canvas container |
| `.returns-legend-item` | Ticker entry with hover highlight |
| `.returns-date-controls` | Flex column, date inputs + quick buttons |
| `.returns-quick-btns` | 1Y / All buttons row |

### Contribution tab

| Selector | Purpose |
|---|---|
| `.returns-legend-left.contrib-sidebar` | Override: flex column, hidden overflow (used by both Contribution and Returns sidebars) |
| `.contrib-legend-header` | Hover detail panel: padding, border-bottom, min-height 80px, flex-shrink 0 |
| `.contrib-detail-ticker` | Bold 13px ticker name |
| `.contrib-detail-row` | Flex space-between, 10px font |
| `.contrib-hint` | Italic placeholder text |
| `.contrib-preset-toggle` | Q/Y toggle row: flex, flex-shrink 0, border-bottom |
| `.contrib-toggle-btn` | Toggle button: flex-1, transparent bg, 10px font, active = base01 bg |
| `.contrib-quarter-presets` | Scrollable preset list: flex column, overflow-y auto, flex 1, min-height 0 |
| `.contrib-quarter-btn` | Preset button: transparent bg, 1px border, active = base01 bg |

### Shared UI

| Selector | Purpose |
|---|---|
| `.analysis-date-controls` | Date picker bar (correlation, contributions) |
| `.analysis-date-label` | "As of:" label |
| `.analysis-loading-hint` | Italic loading text |
| `.date-input` | Borderless date input |
| `.control-btn` | Generic button (bold, uppercase, 2px border) |
| `.control-btn.primary` | Pink accent button |
| `.candle-detail-overlay` | Absolute-positioned candle detail popup |

---

## API Data Flow

```
/api/baskets/{name}/summary
  → App.tsx fetches on basket select
    → BasketSummary receives { open_signals, correlation, cumulative_returns }
      → SignalsTable (breakout/rotation/btfd tabs)
      → CorrelationHeatmap (correlation tab)
      → ReturnsChart (returns tab)

/api/baskets/{name}/contributions
  → ContributionChart fetches directly (date bounds on mount, data on date change)
    → Response: tickers, total_contributions, initial_weights, final_weights,
                first_dates, last_dates, current_weights,
                equity_dates, equity_values, dates, date_range

/api/baskets/{name}/correlation
  → CorrelationHeatmap fetches directly (date bounds on mount, data on date change)

/api/baskets/{name}/candle-detail
  → TVChart fetches on crosshair hover
```

---

## Cross-cutting patterns

### Q/Y Preset Toggle (shared by ContributionChart and ReturnsChart)

Both components implement the same pattern:
- `presetMode` state: `'Q' | 'Y'`
- `quarterPresets` useMemo: walks backwards from max date, all quarters newest-first
- `annualPresets` useMemo: loops `maxYear` down to `minYear`
- `activePresets` = `presetMode === 'Q' ? quarterPresets : annualPresets`
- Sidebar CSS: `.contrib-sidebar` class with `.contrib-preset-toggle` and `.contrib-quarter-presets`

### Color scheme

- Positive / bullish: `rgb(50, 50, 255)` (blue)
- Negative / bearish: `rgb(255, 50, 150)` (pink)
- Background: `#fdf6e3` (Solarized Light base3)
- Secondary background: `#eee8d5` (Solarized Light base2)
