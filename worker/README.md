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

- **PostgreSQL bat buoc** (`DATABASE_URL` trong `QBR/.env`). SQLite khong con duoc ho tro.
- Local dev: `npm run dev` chay **3 worker** process + Postgres (Docker).
- Docker: `docker-compose.yml` co `worker-1`, `worker-2`, `worker-3` (moi worker co `WORKER_ID` rieng).
- Claim dung `UPDATE ... WHERE status='queued'` (atomic) — nhieu worker khong claim trung mot run.
- Stale requeue: heartbeat mat > `STALE_AFTER_SEC` (mac dinh 180s), co grace `STALE_CLAIM_GRACE_SEC` (60s) sau khi claim.
- Worker va backend phai cung thay `storage/artifacts` neu chay tach process/container (`QBR_ROOT` + volume `/app/storage` trong Docker).

## Entry point

- Main loop: `worker/jobs/worker_main.py`

## Chua hoan thanh

- Logging / observability van con toi thieu
