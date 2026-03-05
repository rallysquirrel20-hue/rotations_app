# 🚀 Rotations App - Startup Guide

This file contains machine-agnostic commands to run the Rotations App on any PC.

## 1. Environment Setup
The backend auto-loads `.env` from the local `backend/` directory first, falling back to `~/Documents/Repositories/.env`. No manual copying needed — just ensure the `.env` file exists in either location.

## 2. Backend (FastAPI)
Open a **new** PowerShell tab and run:
```powershell
cd "$HOME\Documents\Repositories\rotations_app\backend"
# Install dependencies (only needed once)
python -m pip install fastapi uvicorn pandas numpy databento python-dotenv pyarrow

# Start the server
python -m uvicorn main:app --reload
```
*The API will be live at http://localhost:8000*

## 3. Frontend (React + Vite)
Open a **second** PowerShell tab and run:
```powershell
cd "$HOME\Documents\Repositories\rotations_app\frontend"
# Install dependencies (only needed once)
npm install

# Start the dashboard
npm run dev
```
*The App will be live at http://localhost:5173*

## 4. Troubleshooting
- **Data Not Found:** Ensure `PYTHON_OUTPUTS_DIR` in `.env` points to your local outputs folder (defaults to `~/Documents/Python_Outputs`).
- **Node/NPM Errors:** Ensure Node.js is installed. Run `node -v` to check.
- **Python Errors:** Ensure Python 3.10+ is installed. Run `python --version` to check.
