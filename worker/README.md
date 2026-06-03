# Worker

Worker process hien tai co cac trach nhiem:

- Poll queue tren bang `runs`
- Claim `Run(status="queued")`
- Uu tien `single-run` cao hon `batch-run` thong qua `queue_priority`
- Heartbeat cho run dang chay
- Execute runner cho `single-run` va `batch-run`
- Persist metric / artifact thong qua execution core trong backend
- Reconcile batch status sau moi batch item

## Runtime notes

- Worker mode support chinh thuc tren Postgres.
- SQLite van co the chay cho local/dev, nhung **khong nen chay nhieu worker process** (2–3+) cung luc: moi process + API tranh ghi `storage/db/qbr.db` → API co the treo / localhost khong load.
- Neu can 2–3 worker song song: dung Postgres (`DATABASE_URL=postgresql://...`) hoac chi chay **1 worker** tren SQLite.
- `npm run dev` da start **1 worker** (`dev:worker`); backend dev (`dev_server.py`) tat embedded worker (`QBR_AUTO_WORKER=0`). Tranh mo them 2–3 worker thu cong neu van dung SQLite.
- Neu chi chay `uvicorn` (khong qua `dev_server.py`): mac dinh **khong** bat embedded worker; can worker rieng hoac `QBR_AUTO_WORKER=1` (chi khi chi co 1 process).
- Worker va backend phai cung thay `storage/artifacts` neu chay tach process/container.

## Entry point

- Main loop: `worker/jobs/worker_main.py`

## Chua hoan thanh

- Stale recovery loop chua duoc bat trong worker main loop
- Logging / observability van con toi thieu
- Docker runtime chua duoc verify end-to-end tren may test hien tai vi Docker daemon offline
