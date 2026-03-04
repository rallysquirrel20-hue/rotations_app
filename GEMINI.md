# Rotations App - Gemini Context

This document provides foundational context and instructions for AI agents working on the Rotations App project.

## Project Overview
The Rotations App is a financial analysis tool designed to track and visualize stock rotations, thematic universes (e.g., High Beta, Momentum), and sector performance using data from Databento.

## Tech Stack
### Backend
- **Framework:** FastAPI (Python)
- **Data Processing:** Pandas, NumPy
- **Data Source:** Databento (API-based historical and real-time data)
- **Caching/Storage:** Pickle files, Parquet (using `fastparquet` or `pyarrow`)
- **Key Modules:**
    - `backend/main.py`: FastAPI application entry point, WebSocket management, and API endpoints.
    - `backend/signals_engine.py`: Core logic for calculating rotation signals and technical indicators.

### Frontend
- **Framework:** React (TypeScript)
- **Build Tool:** Vite
- **Charting:** `lightweight-charts` (TradingView)
- **Communication:** Axios for REST API, WebSockets for real-time updates.
- **Styling:** CSS (Modular or Vanilla as per conventions).

## Project Structure
- `/backend`: Contains the FastAPI server and data processing scripts.
- `/frontend`: Contains the React/Vite application.
- `/Documents/Python_Outputs`: External data directory for cache files (Pickle, Parquet).

## Development Guidelines
### Backend
- **Environment Variables:** All secrets and paths (API keys, data directories) must be managed via `.env`.
- **Data Consistency:** Ensure dataframes are properly indexed by `Date` and `Ticker` before processing signals.
- **Error Handling:** Use explicit HTTPExceptions in FastAPI and robust logging for data ingestion issues.

### Frontend
- **Type Safety:** Maintain strict TypeScript typing for all API responses and component props.
- **Performance:** Optimize chart rendering, especially when handling large datasets or high-frequency WebSocket updates.
- **State Management:** Use React hooks (useState, useEffect) for local state; consider more robust solutions only if complexity increases significantly.

## Key Files & Paths
- **Backend Entry:** `backend/main.py`
- **Signals Logic:** `backend/signals_engine.py`
- **Frontend Source:** `frontend/src/`
- **Data Cache (Local):** Defined by `PYTHON_OUTPUTS_DIR` in `.env`.
