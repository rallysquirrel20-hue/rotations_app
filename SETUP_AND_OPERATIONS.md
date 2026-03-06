# Rotations App - Setup & Operations Guide

## Prerequisites

- Node.js installed
- Python installed
- PM2 installed globally: `npm install -g pm2`
- PM2 Windows startup: `npm install -g pm2-windows-startup`

## First Time Setup

### 1. Backend (Python venv + dependencies)

```
cd C:\Users\dwilson\Documents\repositories\rotations_app\backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install fastapi uvicorn pandas numpy databento python-dotenv pyarrow
```

### 2. Frontend (npm dependencies)

```
cd C:\Users\dwilson\Documents\repositories\rotations_app\frontend
npm install
```

### 3. Start both with PM2

```
pm2 start C:\Users\dwilson\Documents\repositories\ecosystem.config.js
pm2 save
pm2-startup install
```

### 4. Open the app

Go to http://localhost:5173

---

## Ecosystem Config

Location: `C:\Users\dwilson\Documents\repositories\ecosystem.config.js`

This file tells PM2 how to run both processes:
- **rotations-backend** — runs `main.py` with the venv Python interpreter
- **rotations-frontend** — runs Vite dev server via `node_modules\vite\bin\vite.js`

---

## PM2 Commands

### Status & Logs

| Command | What it does |
|---|---|
| `pm2 list` | See status of both processes |
| `pm2 logs` | Live tail of all logs |
| `pm2 logs rotations-backend` | Backend logs only |
| `pm2 logs rotations-frontend` | Frontend logs only |
| `pm2 monit` | Live dashboard (CPU/memory/logs) |

### Start / Stop / Restart

| Command | What it does |
|---|---|
| `pm2 restart all` | Restart both |
| `pm2 restart rotations-backend` | Restart just backend |
| `pm2 restart rotations-frontend` | Restart just frontend |
| `pm2 stop all` | Stop both |
| `pm2 stop rotations-backend` | Stop just backend |
| `pm2 stop rotations-frontend` | Stop just frontend |

### Managing Processes

| Command | What it does |
|---|---|
| `pm2 delete all` | Remove both from PM2 |
| `pm2 delete rotations-frontend` | Remove just frontend |
| `pm2 save` | Save current process list (persists across reboots) |
| `pm2 start C:\Users\dwilson\Documents\repositories\ecosystem.config.js` | Start both from config |
| `pm2 start C:\Users\dwilson\Documents\repositories\ecosystem.config.js --only rotations-backend` | Start just backend |
| `pm2 start C:\Users\dwilson\Documents\repositories\ecosystem.config.js --only rotations-frontend` | Start just frontend |

---

## After Code Changes

- **Frontend:** Vite auto-reloads — no restart needed
- **Backend:** Run `pm2 restart rotations-backend`

---

## Troubleshooting

### Process shows "stopped" or "errored"

1. Check logs: `pm2 logs <process-name>`
2. Fix the issue
3. Delete and re-add: `pm2 delete <process-name>` then `pm2 start ... --only <process-name>`
4. Save: `pm2 save`

### Backend won't start (interpreter not found)

The venv doesn't exist. Create it:
```
cd C:\Users\dwilson\Documents\repositories\rotations_app\backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install fastapi uvicorn pandas numpy databento python-dotenv pyarrow
```

### Frontend won't start (vite not found)

Node modules not installed. Run:
```
cd C:\Users\dwilson\Documents\repositories\rotations_app\frontend
npm install
```

### Environment Variables

The backend needs a `.env` file with `DATABENTO_API_KEY`. It looks in:
1. `C:\Users\dwilson\Documents\repositories\rotations_app\backend\.env`
2. `C:\Users\dwilson\Documents\Repositories\.env` (fallback)
