# Frontend (Planned)

Planned UI zones:

- Left menu: Generate / Run single / Run batch / Compare
- Left-bottom list: Topologies and batches
- Main panel 1: topology canvas (single, grid, compare)
- Main panel 2: run config, live batch table, replay details, artifacts

## Immediate next tasks

1. Build static shell matching current wireframe.
2. Connect topology list and filters (`new`/`done`, node-count quick filter).
3. Add compare page with A/B config selector.

## API base URL configuration

Create `frontend/.env` from `frontend/.env.example`.

- Local:
  - `VITE_API_BASE=http://localhost:8000/api`
- LAN:
  - `VITE_API_BASE=http://<HOST_IP>:8000/api`
