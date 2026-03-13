# Dependency Tree — rotations_app

> Auto-maintained by dependency-mapper agent. Last updated: 2026-03-13.

---

## backend/signals_engine.py

### Classes

#### `RollingStatsAccumulator` (L11-82)
- **Methods:** `__init__`, `add`, `get_stats`
- **Used by:** `_build_signals_from_df`

### Functions

#### `_build_signals_from_df(df, ticker)` (L85-343)
- **Calls:** `RollingStatsAccumulator`
- **Uses:** numpy, pandas
- **Constants:** `SIGNALS`, `RV_MULT`, `EMA_MULT`, `RV_EMA_ALPHA`
- **Returns:** DataFrame with full signal columns (Trend, Pivots, Targets, 6 signal types + rolling stats)
- **Called by:** `main.py` — used to recompute signals when merging live bars with historical data

#### `_build_signals_next_row(prev_row, live_price, live_dt, live_high, live_low, live_open)` (L346-534)
- **Uses:** numpy, pandas
- **Constants:** `RV_MULT`, `EMA_MULT`, `RV_EMA_ALPHA`
- **Logic:** Incremental one-bar signal update from previous row state
- **BTFD entry:** `trend == False and prev_trend == False and low <= prev_lower` (L464)
- **STFR entry:** `trend == True and prev_trend == True and high >= prev_upper` (L471)
- **Called by:** `main.py` — live-signals endpoint

---

## backend/main.py

### Module-level Setup (L1-67)
- **Imports:** fastapi, pandas, numpy, databento, signals_engine, etc.
- **Constants:** `DB_API_KEY`, `DB_DATASET`, `DB_STYPE_IN`, `BASE_DIR`, `DATA_STORAGE`
- **Path constants:** `THEMATIC_BASKET_CACHE`, `SECTOR_BASKET_CACHE`, `INDUSTRY_BASKET_CACHE`, `BASKET_CACHE_FOLDERS`, `INDIVIDUAL_SIGNALS_FILE`, `LIVE_SIGNALS_FILE`, `LIVE_BASKET_SIGNALS_FILE`, `TOP_500_FILE`, `GICS_MAPPINGS_FILE`
- **Config:** `THEMATIC_CONFIG` dict (L68-76)

### Utility Functions

#### `_read_live_parquet(path)` (L78-88)
- **Returns:** DataFrame or None
- **Called by:** `_compute_live_breadth`, `get_basket_breadth`, `get_basket_data`, `get_ticker_data`

#### `_find_basket_parquet(slug)` (L90-100)
- **Uses:** `BASKET_CACHE_FOLDERS`
- **Called by:** `get_basket_data`, `get_basket_summary`

#### `_find_basket_meta(slug)` (L102-112)
- **Uses:** `BASKET_CACHE_FOLDERS`
- **Called by:** `get_meta_file_tickers`

#### `clean_data_for_json(df)` (L115-116)
- **Called by:** `get_basket_data`, `get_ticker_data`

#### `get_latest_universe_tickers(basket_name)` (L118-139)
- **Uses:** `GICS_MAPPINGS_FILE`, `THEMATIC_CONFIG`, `THEMATIC_BASKET_CACHE`
- **Called by:** `_compute_live_breadth`, `get_basket_breadth` (live overlay loop), `get_basket_summary`

#### `get_meta_file_tickers(basket_name)` (L142-152)
- **Calls:** `_find_basket_meta`
- **Called by:** `get_basket_data`

#### `_get_universe_history(basket_name)` (L157-174)
- **Uses:** `GICS_MAPPINGS_FILE`, `THEMATIC_CONFIG`, `THEMATIC_BASKET_CACHE`
- **Called by:** `_get_universe_tickers_for_range`, `_get_ticker_join_dates`, `_get_tickers_for_date`

#### `_quarter_str_to_date(q_str)` (L177-183)
- **Called by:** `_get_universe_tickers_for_range`, `_get_ticker_join_dates`, `_get_tickers_for_date`

#### `_get_universe_tickers_for_range(basket_name, start_date, end_date)` (L186-200)
- **Calls:** `_get_universe_history`, `_quarter_str_to_date`
- **Called by:** `get_basket_summary`

#### `_get_ticker_join_dates(basket_name, tickers)` (L203-215)
- **Calls:** `_get_universe_history`, `_quarter_str_to_date`
- **Called by:** `get_basket_summary`

#### `_get_tickers_for_date(basket_name, target_date)` (L218-236)
- **Calls:** `_get_universe_history`, `_quarter_str_to_date`
- **Called by:** `get_basket_candle_detail`

#### `get_basket_weights_from_contributions(basket_name)` (L240-257)
- **Calls:** `_find_basket_contributions`
- **Called by:** `get_basket_data`

#### `_tally_breadth(tickers, live_close, last_hist)` (L259-304)
- **Logic:** Counts uptrend and breakout-sequence tickers given live prices and last historical signals. Computes live trend/breakout by comparing live close to previous day's pivots and targets.
- **Returns:** `{Uptrend_Pct, Breakout_Pct}` dict or None
- **Called by:** `_compute_live_breadth`, `get_basket_breadth` (live overlay loop)

#### `_compute_live_breadth(basket_name)` (L307-357)
- **Calls:** `get_latest_universe_tickers`, `_read_live_parquet`, `_tally_breadth`
- **Reads:** `LIVE_SIGNALS_FILE`, `INDIVIDUAL_SIGNALS_FILE`
- **Returns:** dict with `Uptrend_Pct`, `Breakout_Pct`, `Correlation_Pct`
- **Called by:** (available for per-basket live breadth computation)

### API Endpoints

#### `GET /` — `read_root()` (L360-361)

#### `GET /api/baskets` — `list_baskets()` (L363-379)
- **Uses:** `BASKET_CACHE_FOLDERS`, `THEMATIC_CONFIG`

#### `GET /api/baskets/compositions` — `get_basket_compositions()` (L381-405)
- **Uses:** `GICS_MAPPINGS_FILE`, `THEMATIC_CONFIG`, `THEMATIC_BASKET_CACHE`

#### `GET /api/baskets/breadth` — `get_basket_breadth()` (L407-535)
- **Calls:** `_read_live_parquet`, `get_latest_universe_tickers`, `_tally_breadth`
- **Reads:** Basket signals parquets, `LIVE_SIGNALS_FILE`, `INDIVIDUAL_SIGNALS_FILE`, `LIVE_BASKET_SIGNALS_FILE`
- **Logic (3 phases):**
  1. Read last row of each basket signals parquet for EOD breadth/signals (Uptrend_Pct, Breakout_Pct, Correlation_Pct, Trend, Is_Breakout_Sequence, BTFD/STFR state, pct_change)
  2. Overlay live constituent breadth via `_tally_breadth` using `LIVE_SIGNALS_FILE` + `INDIVIDUAL_SIGNALS_FILE`
  3. Overlay live basket equity curve signals (LT/ST/MR/Chg) via `LIVE_BASKET_SIGNALS_FILE` using cached pivots
- **Returns:** `{slug: {uptrend_pct, breakout_pct, corr_pct, lt_trend, st_trend, mean_rev, pct_change}}`

#### `GET /api/baskets/{basket_name}` — `get_basket_data()` (L541-597)
- **Calls:** `_find_basket_parquet`, `_read_live_parquet`, `get_meta_file_tickers`, `get_basket_weights_from_contributions`, `clean_data_for_json`, `signals_engine._build_signals_from_df`

#### `GET /api/tickers` — `list_tickers()` (L599-612)

#### `GET /api/tickers/by-quarter` — `list_tickers_by_quarter()` (L614-626)

#### `GET /api/tickers/live-signals` — `list_live_signal_tickers()` (L628-714)

#### `GET /api/tickers/signals` — `get_ticker_signals()` (L716-810)

#### `GET /api/tickers/{ticker}` — `get_ticker_data()` (L812-862)
- **Calls:** `_read_live_parquet`, `clean_data_for_json`, `signals_engine._build_signals_from_df`

#### `safe_float(value, digits)` (L864-868)
#### `safe_int(value)` (L870-874)

#### `GET /api/baskets/{basket_name}/summary` — `get_basket_summary()` (L876-1328)
- **Calls:** `_find_basket_parquet`, `get_latest_universe_tickers`, `_get_universe_tickers_for_range`, `_get_ticker_join_dates`, `safe_float`, `safe_int`

#### `GET /api/baskets/{basket_name}/correlation` — `get_basket_correlation()` (L1330-1376)

#### `_find_basket_contributions(slug)` (L1378-1390)
- **Called by:** `get_basket_weights_from_contributions`, `get_basket_contributions`

#### `GET /api/baskets/{basket_name}/contributions` — `get_basket_contributions()` (L1392-1478)

#### `GET /api/baskets/{basket_name}/candle-detail` — `get_basket_candle_detail()` (L1480-1524)
- **Calls:** `_get_tickers_for_date`

#### `WebSocket /ws/live/{ticker}` — `websocket_endpoint()` (L1526-1570+)
- **Calls:** `signals_engine._build_signals_next_row`

---

## frontend/src/App.tsx

### Types (L45-79)
- `BasketsData`, `TickerWeight`, `LiveSignalTicker`, `OpenSignal`, `CorrelationData`, `CumulativeReturnsData`, `BasketSummaryData`
- `ViewType`, `SearchCategory`, `SearchResult`, `TickerSignalSummary`
- `SignalSortCol` = `'ticker' | 'wt' | 'lt' | 'st' | 'mr' | 'pct'`
- `BasketSortCol` = `'name' | 'bo' | 'br' | 'cor' | 'lt' | 'st' | 'mr' | 'chg'`

### Top-level Functions

#### `quarterToDateRange(start, end)` (L13-22)
- **Called by:** data fetch effects in `App`

#### `getSigSortVal(ticker, col, sigs)` (L81-93)
- **Called by:** `applySortFilter`, constituent sort logic inside `App`

#### `applySortFilter(tickers, sortCol, sortDir, fLT, fST, fMR, sigs)` (L95-108)
- **Calls:** `getSigSortVal`
- **Called by:** `sortedTickers` memo, `sortedLiveSignals` memo

### `App()` Component (L110+)

#### State — Basket sort/filter (L166-171)
- `bSortCol` (BasketSortCol), `bSortDir`, `bFilterLT`, `bFilterST`, `bFilterMR`, `bFilterOpen`

#### Memos
- `rangeQuarters` (L191)
- `quarterBasketTickers` (L206)
- `quarterFilteredTickers` (L217)
- `filteredTickers` (L229)
- `[effectiveSignals, liveOverrides]` (L235) — merges tickerSignals with live signal overrides
- `sortedTickers` (L261) — calls `applySortFilter`
- `sortedLiveSignals` (L266) — calls `applySortFilter`
- `searchResults` (L271)
- `dateBounds` (L322)

#### Key Functions

##### `handleSearchSelect(result)` (L291)
##### `handleSearchKeyDown(e)` (L314)

##### Data fetch effects (~L340-455)
- Fetches `/api/tickers/{ticker}` or `/api/baskets/{basket_name}`
- Manages WebSocket lifecycle for live updates
- Fetches basket compositions, breadth, ticker signals, live signal tickers

##### `toggleView(view)` (L456)
##### `handleBasketSelect(item, view)` (L465)
##### `handleItemSelect(item, view)` (L478)

##### `doSort(col, curCol, curDir, setCol, setDir)` (L487)
- **Called by:** `renderColHeader`

##### `renderColHeader(sortCol, sortDir, setCol, setDir, filterLT, ...)` (L493-581)
- **Calls:** `doSort`
- **Renders:** Column headers with sort arrows and filter dropdowns for ticker/constituent lists

##### `getBasketSortVal(slug, col)` (L583-597)
- **Uses:** `basketBreadth` state
- **Called by:** `sortBaskets`

##### `sortBaskets(items)` (L599-610)
- **Calls:** `getBasketSortVal`
- **Uses:** `bSortCol`, `bSortDir`, `bFilterLT`, `bFilterST`, `bFilterMR`, `basketBreadth`
- **Called by:** Basket section render (L795)

##### `renderBasketColHeader()` (L612-696)
- **Uses:** `bSortCol`, `bSortDir`, `bFilterLT`, `bFilterST`, `bFilterMR`, `bFilterOpen`
- **Renders:** Column headers (Basket, BO%, Br%, Cor%, LT, ST, MR, Chg) with sort/filter dropdowns
- **Called by:** Basket section render (L794)

##### `fmtDV(dv)` (L698-703)
- **Called by:** `renderSignalCols`

##### `renderSignalCols(ticker, weight?, showDV?)` (L705-730)
- **Calls:** `fmtDV`
- **Uses:** `effectiveSignals`, `liveOverrides`
- **Called by:** Ticker rows, Live Signal rows, Constituent rows

#### Render — Basket rows (L795-877)
- Calls `sortBaskets(baskets[view])` to sort/filter basket list
- Renders `renderBasketColHeader()` above basket rows
- Each row shows: name, BO%, Br%, Cor%, LT, ST, MR, Chg columns from `basketBreadth`
- Expanded basket shows constituents with `renderColHeader` + `renderSignalCols`

---

## frontend/src/components/TVChart.tsx

### Types (L5-28)
- `RangeTrigger`, `TVChartProps`, `PaneId`, `CandleConstituent`, `CandleDetail`

### Constants (L39-48)
- `COLOR_PINK`, `COLOR_BLUE`, `SOLAR_BASE3`, `SOLAR_BASE01`, `SOLAR_BASE1`
- `DEFAULT_PANE_HEIGHT`, `MIN_PANE_HEIGHT`

### `TVChart` Component (L63-602)

#### Refs & State (L66-93)
- Chart refs: `pRef`, `vRef`, `bRef`, `boRef`, `cRef`
- `charts`, `seriesRefs`, `dataLengthRef`, `timesRef`, `savedRangeRef`
- `paneHeights` state, `candleDetail`, `pinnedDetail`, `candleDetailCache`

#### `fetchCandleDetail(dateStr)` (L125-144)
- **Calls:** axios GET `/baskets/{name}/candle-detail`

#### Chart creation effect (L213-438)
- Creates 5 synchronized charts: price, volume, breadth, breakout, correlation
- **Price pane:** Candlesticks + pivot markers + target lines
- **BTFD/STFR entry arrows** (L271-289): Renders arrow markers on price chart for `Is_BTFD` (green arrowUp below bar) and `Is_STFR` (pink arrowDown above bar)
- **Indicator panes:** Volume histogram, Breadth line, Breakout line, Correlation line
- **Crosshair sync:** All 5 charts synced for visible range and crosshair position
- **Candle detail:** Hover/click on price chart fetches constituent detail for basket view

#### Resize effect (L441-467)
#### Range update effect (L470-500)

#### Render (L511-601)
- Wrapper with flex column layout
- Price pane (flex:1) with candle detail overlay
- Indicator panes in unified loop with drag resizers

---

## frontend/src/index.css

### Key Class Groups
- **Layout:** `.app-container`, `.sidebar` (width: 460px), `.main-content`, `.content-stack`, `.chart-container`
- **Column widths:** `.col-ticker`, `.col-wt`, `.col-lt`, `.col-st`, `.col-mr`, `.col-pct`, `.col-bkt` (all 40px, L248-250)
- **Signal colors:** `.sig-bull` (blue), `.sig-bear` (pink), `.sig-corr` (#586e75), `.sig-live` (solid bg)
- **Basket headers:** `.basket-col-header` (L140-151), `.accordion-basket-header` (L116-136)
- **Filter dropdowns:** `.col-filter-dropdown`, `.cfd-btn`, `.cfd-check`, `.col-hdr.filtered`
- **Chart overlays:** `.candle-detail-overlay`, `.chart-overlay-toggles`
- **Summary panel:** `.summary-panel`, `.summary-tabs`, `.summary-table`

---

## Cross-file Dependency Summary

```
signals_engine.py
  _build_signals_from_df  -->  main.py: get_basket_data, get_ticker_data
  _build_signals_next_row -->  main.py: websocket_endpoint

main.py
  _tally_breadth          <--  _compute_live_breadth, get_basket_breadth
  _compute_live_breadth   <--  (standalone per-basket live breadth)
  get_basket_breadth      -->  App.tsx: basketBreadth state (via /api/baskets/breadth)
  get_basket_data         -->  App.tsx: chartData state (via /api/baskets/{name})
  get_ticker_data         -->  App.tsx: chartData state (via /api/tickers/{ticker})
  list_live_signal_tickers-->  App.tsx: liveSignalTickers state
  get_ticker_signals      -->  App.tsx: tickerSignals state

App.tsx
  basketBreadth           -->  sortBaskets, getBasketSortVal, renderBasketColHeader, basket row render
  sortBaskets             -->  basket section render
  renderBasketColHeader   -->  basket section render
  renderSignalCols        -->  ticker rows, constituent rows, live signal rows
  effectiveSignals        -->  renderSignalCols, constituent sort, applySortFilter

TVChart.tsx
  data (prop)             <--  App.tsx: chartData
  BTFD/STFR markers       <--  data[].Is_BTFD, data[].Is_STFR (from signals_engine via main.py)
```
