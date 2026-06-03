# QBR Platform

This folder contains the new end-to-end QBR experiment platform:

- Topology generation and batch management
- Single and batch experiment execution
- A/B comparison (`same_topology` and `same_batch`)
- Interactive replay and algorithm introspection
- Metadata and artifact management

## Project layout

- `backend/`: FastAPI service (API, validation, orchestration hooks)
- `frontend/`: React + Vite web UI
- `worker/`: background jobs (batch execution, resume/stop flow)
- `storage/`: local storage roots for DB and artifacts
- `configs/`: runtime and experiment presets
- `docs/`: specifications and notes

## Quick start (local dev)

Prerequisites:

- Node.js 20+
- Python 3.11+

From `QBR/`:

1. Install frontend/dev task dependencies:
   - `npm install`
   - create frontend env file:
     - `copy frontend\\.env.example frontend\\.env` (Windows)
     - `cp frontend/.env.example frontend/.env` (Linux/macOS)
   - set API URL for local or LAN usage:
     - local: `VITE_API_BASE=http://localhost:8000/api`
     - LAN: `VITE_API_BASE=http://<HOST_IP>:8000/api`
2. Install backend dependencies:
   - `pip install -r backend/requirements.txt`
3. Start all local services:
   - `npm run dev` (frontend + backend + **one** worker)

**Workers / SQLite:** `npm run dev` already runs a background worker. On the default SQLite DB, do not start extra worker processes (2–3 manual workers often lock the DB and freeze the API). For multiple workers, use PostgreSQL (`DATABASE_URL` in `.env`) or see `worker/README.md`.

Default URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8000`
- Health check: `http://localhost:8000/health`

## Quick start (Docker)

From `QBR/`:

1. Copy env file:
   - `copy .env.example .env` (Windows)
   - `cp .env.example .env` (Linux/macOS)
2. Start stack:
   - `docker compose up --build`

Default container endpoints:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8000`
- PostgreSQL: `localhost:5432`

## Build commands

- Frontend + backend sanity checks:
  - `npm run build`

## Notes

- Current status: scaffold and API stubs are in place.
- Core algorithm integration and persistent DB repositories are the next phase.
