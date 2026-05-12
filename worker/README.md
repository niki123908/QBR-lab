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
- SQLite van co the chay cho local/dev, nhung khong phai target chinh cho multi-process worker mode.
- Worker va backend phai cung thay `storage/artifacts` neu chay tach process/container.

## Entry point

- Main loop: `worker/jobs/worker_main.py`

## Chua hoan thanh

- Stale recovery loop chua duoc bat trong worker main loop
- Logging / observability van con toi thieu
- Docker runtime chua duoc verify end-to-end tren may test hien tai vi Docker daemon offline
