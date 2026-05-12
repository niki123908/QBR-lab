# QBR Worker Migration TODO

Muc tieu da chot: dung `Run` lam queue item, worker process doc lap consume ca `single` va `batch`, single-run co priority cao hon batch-run, khong auto retry, batch co run fail van aggregate la `completed`.

## 1. Da hoan thanh

- [x] Chot architecture direction:
  - Backend API chi enqueue / doc status / doc result.
  - Worker chi claim / execute / heartbeat / persist.
- [x] Chot queue semantics:
  - Queue theo `Run`, khong tao bang `run_jobs`.
  - Single-run priority cao hon batch-run.
  - Resume = requeue cac run `stopped`.
  - Stop chi o muc batch.
- [x] Mo rong `runs` cho worker mode:
  - `worker_id`
  - `heartbeat_at`
  - `claimed_at`
  - `attempt_count`
  - `queue_priority`
  - `payload_json`
- [x] Backward-compatible DB init:
  - auto-add queue columns neu DB cu chua co
  - normalize `pending -> queued`
- [x] Repository queue core:
  - enqueue single run
  - enqueue batch runs
  - claim next queued run theo priority
  - heartbeat run
  - mark run stopped
  - requeue stale runs
  - batch state reconciliation
- [x] Execution path:
  - `_execute_run(...)` duoc reuse cho worker
  - `execute_queued_single_run(run_id)`
  - `execute_queued_batch_run(run_id)`
- [x] Single-run cutover:
  - `POST /api/runs/single` khong con synchronous
  - frontend doi sang flow accepted + poll run detail
- [x] Batch cutover:
  - `POST /api/runs/batch` khong con spawn thread trong backend
  - worker claim tung `Run(mode="batch")`
  - stop/resume batch chay theo queue semantics moi
- [x] Worker process:
  - `worker/jobs/worker_main.py` khong con la stub
  - claim duoc `single` va `batch`
  - co heartbeat thread
- [x] Runtime wiring:
  - worker Dockerfile copy backend code + requirements
  - `docker-compose.yml` share `storage` volume giua backend va worker
  - worker co `DATABASE_URL`
- [x] Manual runtime verification:
  - backend compile pass
  - worker compile pass
  - frontend build pass
  - local runtime test pass cho:
    - single-run accepted -> done
    - batch-run queued/running/completed
    - stop batch
    - resume batch
    - result/artifact loading

## 2. Con lai

### High priority

- [ ] Them stale recovery loop that trong `worker/jobs/worker_main.py`
  - poll `requeue_stale_runs(...)` theo interval rieng
  - log ro run nao bi reclaim
- [ ] Them logging/observability toi thieu:
  - queue claim
  - run completed / failed
  - batch stop requested / stopped / resumed
  - stale recovery event
- [ ] Kiem tra runtime bang Docker that
  - Docker daemon tren may test local dang offline, chua verify `docker compose up` end-to-end
- [ ] Review policy delete run/batch khi dang `running`
  - hien tai chua co policy nghiem ngat cho delete trong luc worker dang xu ly

### Medium priority

- [ ] Viet test tu dong cho queue logic:
  - single priority > batch
  - claim queued run
  - batch reconcile
  - stop/resume
  - stale reclaim
- [ ] Cap nhat `README.md`
- [ ] Cap nhat `docs/ui_backend_spec_v1.md`
- [ ] Cap nhat `docs/TODO_REQUIRED_LIST.md` neu van dung file nay de theo doi roadmap tong

### Nice to have

- [ ] Feature flag `USE_EXTERNAL_WORKER`
  - hien tai da cat sang worker mode luon, chua them flag fallback
- [ ] Xem xet index DB cho queue path neu khoi luong run tang
- [ ] Can nhac worker health/admin endpoint
- [ ] Can nhac move tu SQLite local sang Postgres ngay ca cho local dev worker mode

## 3. Risks / Notes

- [ ] SQLite local co the chay, nhung Postgres moi la target chinh cho worker multi-process.
- [ ] `batch_status = completed` ngay ca khi co mot vai `Run.status = failed` la chu y da duoc chot theo UX hien tai.
- [ ] `stop` la graceful stop theo boundary tung topology run, khong stop giua execution cua mot topology.

## 4. Definition of done cho dot migration nay

- [x] Khong con `threading.Thread` de xu ly batch trong backend path chinh.
- [x] Worker process consume duoc single-runs va batch runs.
- [x] Frontend single-run da doi sang async polling.
- [x] Batch progress/result van doc duoc qua API cu.
- [x] Stop/resume batch chay duoc theo semantics moi.
- [x] Artifact va metrics van duoc persist.
- [ ] Docker compose runtime duoc verify end-to-end.
- [ ] Co test tu dong cho queue / worker path chinh.
