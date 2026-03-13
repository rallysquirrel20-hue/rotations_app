# Cross-Repo Integration Map

Last updated: 2026-03-13

## Overview

**Producer**: `rotations_signals` (`rotations.py`, `rotations_old_outputs.py`)
**Consumer**: `rotations_app` (`backend/main.py`, `backend/signals_engine.py`)
**Shared data root**: `~/Documents/Python_Outputs/Data_Storage/`

---

## Version Constants (must stay in sync)

| Constant | rotations_signals location | rotations_app location | Current value |
|---|---|---|---|
| `EQUITY_SIGNAL_LOGIC_VERSION` | `rotations.py:98` | (not duplicated; app reads cached data) | `'2026-03-13-btfd-stfr-prev-trend'` |

When the version changes in `rotations_signals`, all signal caches are invalidated and rebuilt. The app has no version constant of its own but must read parquets produced under the current version.

---

## Shared Files & Data Contracts

### 1. `signals_500.parquet` (individual ticker signals)

- **Producer**: `rotations.py` Cell 3 — writes via `_save_signals_cache_500()`
- **Consumer**: `main.py` reads as `INDIVIDUAL_SIGNALS_FILE`
- **Key columns read by app**:
  - Identity: `Ticker`, `Date`
  - OHLCV: `Open`, `High`, `Low`, `Close`, `Volume`
  - Trend/Pivots: `Trend` (float32: 1.0=up, 0.0=down), `Resistance_Pivot`, `Support_Pivot`
  - Targets: `Upper_Target`, `Lower_Target`
  - Signals: `Is_Up_Rotation`, `Is_Down_Rotation`, `Is_Breakout`, `Is_Breakdown`, `Is_BTFD`, `Is_STFR`
  - Regime: `Is_Breakout_Sequence`, `Rotation_ID`
  - BTFD/STFR state: `BTFD_Triggered`, `STFR_Triggered`
  - Trade tracking: `{Signal}_Entry_Price`, `{Signal}_Exit_Date`, `{Signal}_Exit_Price`, `{Signal}_Final_Change`, `{Signal}_MFE`, `{Signal}_MAE`
  - Rolling stats: `{Signal}_Win_Rate`, `{Signal}_Historical_EV`, etc.
  - Misc: `RV`, `RV_EMA`, `Rotation_Open`, `Up_Range`, `Down_Range`, `Up_Range_EMA`, `Down_Range_EMA`
- **Dtype notes**: `Trend` stored as `float32` (1.0/0.0); bool cols (`Is_*`, `*_Triggered`) stored as `bool`; `Rotation_ID` as `int32`.

### 2. `live_signals_500.parquet` (intraday live signals)

- **Producer**: `rotations_signals` Cell 10 live pipeline (or `rotations_app` live engine)
- **Consumer**: `main.py` reads as `LIVE_SIGNALS_FILE`
- **Key columns read by app**:
  - `Ticker`, `Date`, `Close` (used by `_tally_breadth()` and `_compute_live_breadth()`)
- **Used for**: live breadth overlay in `get_basket_breadth()` and `_compute_live_breadth()`

### 3. `live_basket_signals_500.parquet` (intraday basket-level signals)

- **Producer**: `rotations_signals` Cell 10 live pipeline
- **Consumer**: `main.py` reads as `LIVE_BASKET_SIGNALS_FILE`
- **Key columns read by app**:
  - `BasketName` (or `Basket`), `Date`, `Close`, `Open`, `High`, `Low`, `Volume`
- **Used for**: live basket OHLC overlay in `get_basket_data()` and live trend/regime overlay in `get_basket_breadth()`

### 4. Basket signal parquets (`{slug}_N_of_500_signals.parquet`)

- **Producer**: `rotations.py` `_finalize_basket_signals_output()` in Cell 7
- **Location**: `{thematic,sector,industry}_basket_cache/`
- **Consumer**: `main.py` `get_basket_data()` (full read) and `get_basket_breadth()` (selective column read)
- **Columns read by `get_basket_breadth()`** (the expanded set as of 2026-03-13):
  - `Date`, `Close` — for pct_change calculation
  - `Uptrend_Pct`, `Breakout_Pct`, `Correlation_Pct` — breadth metrics
  - `Trend`, `Is_Breakout_Sequence` — short-term / long-term trend labels
  - `Resistance_Pivot`, `Support_Pivot`, `Upper_Target`, `Lower_Target` — stashed as `_pivots` for live overlay
  - `BTFD_Entry_Price`, `BTFD_Exit_Date`, `STFR_Entry_Price`, `STFR_Exit_Date` — mean-reversion signal state
- **Columns produced by pipeline** (superset): all of the above plus OHLCV, `Source`, breadth EMA columns (`Breadth_EMA`, `BO_Breadth_EMA`), breadth pivot columns (`B_Trend`, `B_Resistance`, `B_Support`, etc.), and full signal trade-tracking columns.

### 5. `top500stocks.json` (quarterly universe)

- **Producer**: `rotations.py` Cell 1
- **Consumer**: `main.py` reads as `TOP_500_FILE`
- **Format**: `{ "2024Q1": ["AAPL", ...], ... }`

### 6. `gics_mappings_500.json` (sector/industry mappings)

- **Producer**: `rotations.py` Cell 1
- **Consumer**: `main.py` reads as `GICS_MAPPINGS_FILE`
- **Format**: `{ "sector_u": { "Information Technology": { "2024Q1": [...] } }, "industry_u": { ... } }`

### 7. Thematic basket config JSONs

- **Producer**: `rotations.py` Cell 6 (thematic basket definitions)
- **Location**: `thematic_basket_cache/*.json`
- **Consumer**: `main.py` `THEMATIC_CONFIG` dict maps basket names to `(filename, key)` pairs

### 8. `correlation_cache/within_osc_500.parquet`

- **Producer**: `rotations.py` Cell 5
- **Consumer**: `main.py` (pre-computed correlations for basket summary endpoint)

---

## Signal Logic Contracts (must match across repos)

### BTFD/STFR prev_trend requirement (added 2026-03-13)

BTFD and STFR signals now require that the **previous day's trend matches the current day's trend** before firing. This prevents false signals on trend-change days.

| Check | Condition |
|---|---|
| BTFD fires | `trend == False AND prev_trend == False AND low <= prev_lower AND not btfd_triggered` |
| STFR fires | `trend == True AND prev_trend == True AND high >= prev_upper AND not stfr_triggered` |

**Implementations that must stay in sync**:

| Location | Function | Style |
|---|---|---|
| `rotations_signals/rotations.py:1470-1485` | `_numba_passes_1_to_4()` | Numba batch — uses `trends[i]==0` / `trends[i-1]==0` (int8: 0=down, 1=up) |
| `rotations_signals/rotations.py:2040-2061` | `_build_signals_next_row()` | Python incremental — uses `prev_trend == False` / `prev_trend == True` (bool) |
| `rotations_app/backend/signals_engine.py:200-209` | `_build_signals_from_df()` batch loop | Python batch — uses `trends[i] is False` / `trends[i] is True` (object) |
| `rotations_app/backend/signals_engine.py:464-474` | `_build_signals_next_row()` | Python incremental — uses `prev_trend == False` / `prev_trend == True` (bool) |

**Trend representation varies by context**: numba uses `int8` (0/1), Python batch uses `object` (True/False/None), incremental uses `bool`. The parquet serializes as `float32` (0.0/1.0). All four implementations produce identical signal sequences.

### Core signal types (6 total)

`Up_Rot`, `Down_Rot`, `Breakout`, `Breakdown`, `BTFD`, `STFR`

Defined as `SIGNALS` list in:
- `rotations_signals/rotations.py:1215`
- `rotations_app/backend/signals_engine.py:5`

### 3-Phase signal algorithm

1. **Phase 1 — Trend & Pivots**: RV with 10-day EMA, support/resistance pivots scaled by `sqrt(252/21)`
2. **Phase 2 — Ranges & Targets**: EMA-smoothed up/down ranges, upper/lower price targets
3. **Phase 3 — Entry/Exit & Stats**: 6 signal types with `RollingStatsAccumulator` for rolling win rate, EV, MFE/MAE

---

## Live Breadth Pipeline

### `_tally_breadth()` (new helper, 2026-03-13)

Extracted shared breadth computation logic used by both `get_basket_breadth()` and `_compute_live_breadth()`.

- **Inputs**: ticker list, `live_close` dict (ticker -> price), `last_hist` DataFrame indexed by Ticker
- **Required columns from `last_hist`**: `Resistance_Pivot`, `Support_Pivot`, `Trend`, `Upper_Target`, `Lower_Target`, `Is_Breakout_Sequence`
- **Returns**: `{ 'Uptrend_Pct': float, 'Breakout_Pct': float }` or `None`
- **Logic**: For each ticker, determines live trend from close vs pivots, then counts uptrend and breakout-sequence tickers as percentages.

### `get_basket_breadth()` flow

1. Reads basket signal parquets (expanded column set) for last-row historical breadth
2. Overlays live constituent breadth via `_tally_breadth()` using `live_signals_500.parquet` + `signals_500.parquet`
3. Overlays live basket-level trend/regime via `live_basket_signals_500.parquet` + cached pivots

### `_compute_live_breadth()` flow

1. Reads `live_signals_500.parquet` for live Close prices
2. Reads `signals_500.parquet` for last historical row per ticker (needs `Close`, `Trend`, pivots, targets, `Is_Breakout_Sequence`)
3. Calls `_tally_breadth()` for Uptrend/Breakout pct
4. Computes live `Correlation_Pct` from 21-day returns + live prices

---

## Code Extraction (2026-03-13)

Group B report cells were extracted from `rotations.py` to `rotations_old_outputs.py` in the `rotations_signals` repo. This is an internal refactor with no impact on cross-repo data contracts.

---

## Breaking Change Checklist

When modifying signal logic in either repo:

1. Update **all four** BTFD/STFR implementations listed above
2. Bump `EQUITY_SIGNAL_LOGIC_VERSION` in `rotations.py`
3. Verify column names match between producer (`rotations.py`) and consumer (`main.py` column lists)
4. If adding new columns to basket parquets, update the `sig_cols` list in `get_basket_breadth()` (`main.py:419`)
5. If adding new columns to `signals_500.parquet`, update `needed_cols` in `_compute_live_breadth()` (`main.py:322`) and the live breadth overlay in `get_basket_breadth()` (`main.py:471`)
6. Run both repos' signal pipelines end-to-end to verify cache compatibility
