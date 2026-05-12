# QBR TODO (Active Items Only)

Các mục dưới đây chỉ giữ việc **chưa xong / còn thiếu**.

---

## 1) Backend Core

- [x] Mark historical runs invalidated (`!`) after topology overwrite (end-to-end warning flow).
- [x] Add full artifact table/reference persistence in DB (not only disk path map).

---

## 2) Batch Run Engine

- [x] Implement real `POST /api/runs/batch` execution flow (không còn stub).
- [x] Queue and execute all selected topologies in batch.
- [x] Persist per-topology status transitions (`pending` -> `running` -> `done`/`failed`).
- [x] Persist batch group metadata (`batch_run_groups`: status, payload, counts, timestamps).
- [x] Implement stop flow:
  - [x] stop requested flag
  - [x] finish current topology then halt
  - [x] keep completed items
- [x] Implement resume flow:
  - [x] continue pending items only
- [x] Implement selected-artifact policy for batch runs (store only selected artifact types).

---

## 3) Compare Mode

- [ ] Implement real `POST /api/compare/ab` logic (không còn stub).
- [ ] Same-topology comparison flow.
- [ ] Same-batch comparison flow with fixed pairing rule.
- [ ] Render A/B boxplot + lower-bound series (exclude greedy series by default).

---

## 4) Results & Replay Completion

- [ ] Complete results panel scope theo spec:
  - [x] batch summary chỉ gồm:
    - [x] total topologies
    - [x] successful
    - [x] failed
  - [x] live batch progress table
- [ ] Batch results visualization (không làm topo detail panel ở phase này):
  - [x] Summary view (Block A):
    - [x] boxplot cho tất cả density (theo format hình Fig.3)
    - [x] chỉ 3 series: `last_delay`, `best_delay`, `lower_bound` (không có greedy)
  - [x] Density detail view (Block B):
    - [x] chart 1: XY scatter theo từng density
      - [x] X: topology id/index
      - [x] Y: delay
      - [x] chỉ 3 series: `last_delay`, `best_delay`, `lower_bound` (không có greedy)
      - [x] áp dụng x-offset cố định theo series để tránh chồng điểm:
        - [x] `best`: x-0.18
        - [x] `last`: x+0.18
        - [x] `lower_bound`: x
    - [x] chart 2: path metrics theo topology id
      - [x] bar chart (trục Y trái): `unique_path_count`
      - [x] line chart (trục Y phải): `best_delay_unique_path_count`
      - [x] dùng dual-axis vì 2 hệ đếm lệch nhau nhiều
  - [x] UI flow:
    - [x] results chỉ hiển thị batch đã run multi
    - [x] label batch-result phải phân biệt theo preset (`batch_name -- preset_name`)
    - [x] click batch-result -> mở trang chi tiết gồm Block A + Block B
    - [x] filter density theo các density tồn tại trong run result
- [x] Explicitly skip for now:
  - [x] no per-topology click detail panel in multi-run results (để tránh nặng)
- [ ] Complete replay/introspection scope:
  - [ ] selected/concurrent node symbol overlays
  - [ ] per-timeslot formula details (`Q before/reward/update/Q after`)
  - [ ] q-table / reward-table viewers hoàn chỉnh

---

## 5) History & Reproducibility

- [x] `GET /api/runs/{id}` endpoint.
- [ ] Add run snapshot metadata:
  - [ ] topology identity/hash
  - [ ] algorithm version
  - [ ] config hash
  - [ ] artifact pointers
- [ ] Implement rerun-from-history.
- [ ] Implement fork-run-from-history.

---

## 6) API Remaining (Checklist)

- [x] `POST /api/runs/batch`
- [x] `POST /api/runs/batch/{id}/stop`
- [x] `POST /api/runs/batch/{id}/resume`
- [x] `GET /api/runs/batch/{id}/progress`
- [ ] `POST /api/compare/ab`

---

## 7) Quality Gate Before Freeze

- [ ] Error response policy unify:
  - [ ] short message only
  - [ ] no verbose internal detail in user-facing payload
- [ ] Clone-and-run verification:
  - [ ] fresh clone (local path)
  - [ ] docker compose path
  - [ ] troubleshooting in README

---

## 8) Implementation Steps (Batch Multi-Run Results)

- [x] Step 1 - Backend batch run real execution (async worker):
  - [x] implement real `POST /api/runs/batch` (enqueue + background worker)
  - [x] run sequentially all selected topologies
  - [x] persist item status (`pending/running/done/failed`)
  - [x] persist per-item metrics (`best_delay`, `last_delay`, `lower_bound`)
- [x] Step 2 - Batch result data contract:
  - [x] define response schema for batch summary + density groups
  - [x] include data points needed by Block A and Block B charts
  - [x] include preset label for result naming
- [x] Step 3 - Results list view:
  - [x] show only batch-runs that have multi-run results
  - [x] display result label with preset suffix (`batch -- preset`)
  - [x] show count of topologies in each result item
- [x] Step 4 - Batch detail view:
  - [x] Block A boxplot (`last`, `best`, `lower_bound`)
  - [x] Block B density filter + scatter with x-offset
  - [x] Block B path metrics combo chart (bar+line dual-axis)
- [x] Step 5 - UX polish & perf:
  - [x] chart tooltips + legends (SVG title + dual-axis labels; hint khi thiếu artifact path)
  - [x] empty/error/loading states (batch results list + batch detail + progress poll)
  - [x] keep no per-topology detail panel in multi-run
- [ ] Step 6 - Validation:
  - [ ] compare chart numbers with exported artifact files
  - [ ] test densities with overlapping best/last points
  - [ ] verify preset-specific result separation in list

