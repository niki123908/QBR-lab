# Run artifact bundle (implemented)

## Files per QBR run

| File | Role |
|------|------|
| `resolved_run_config.json` | Preset + resolved hyperparameters |
| `run_bundle.json.gz` | Metrics, policy config, `episodes[]`, `transmission.{last,best}` |
| `trace_epochs.json.gz` | Full step trace for last + best episode |
| `q_table.json.gz` | Q-table |
| `run_decision_graph.json.gz` | Pre-merged decision graph for playground |

## Removed (new runs)

- `run_summary.json`, `transmission_*.json`, `state_action_*.json`
- `delay_per_episode.csv`, `path_signatures.csv`, `policy_trace.csv`, `path_action_transitions.csv`

## Policy trace

- **ε-greedy / softmax:** computed on the frontend from `run_bundle.policy` or `resolved_run_config`.
- **UCB:** not stored or charted.

## API compatibility

`GET /runs/{id}/artifacts/{legacy_type}` resolves from bundle/trace files on disk when present.

## Batch partial artifacts

- **Path signature:** `run_bundle`, `run_decision_graph`, `trace_epochs`
- **Delay per episode:** `run_bundle` only
