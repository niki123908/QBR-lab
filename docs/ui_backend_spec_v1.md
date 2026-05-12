# QBR Spec v1 (Agreed Scope)

## Key decisions

- New codebase root: `QBR/`
- Topology status filter in list: `new`, `done`
- Node-count quick filter: 50..1000 with step 50
- Done card display: `topology_name - finished_delay - lower_bound`
- Track metric: `best_delay_explored`

## Run modes

- Single run:
  - Full artifacts allowed.
  - Detailed replay and Q update inspection.
- Batch run:
  - Live table updates in panel 2.
  - Graceful stop: finish current topology then stop.
  - Resume continues `pending` items.
  - Full artifacts can be enabled for selected runs only.

## Compare modes

- `same_topology`
- `same_batch`
- A and B can be different algorithms.
- Boxplot includes:
  - config A
  - config B
  - lower bound
- Greedy series excluded.

## Topology editing

- Edit table columns: `node_id`, `x`, `y`
- `x`, `y` are integer.
- Out-of-bound values are clamped to boundary.
- Duplicate positions are invalid.
- Enter/blur: temp save + immediate main-panel redraw.
- Save button: persist overwrite to DB.
- Historical runs show warning icon when topology changed after run.
- Historical runs can be deleted manually.
