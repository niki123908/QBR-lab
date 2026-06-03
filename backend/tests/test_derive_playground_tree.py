from __future__ import annotations

from pathlib import Path

from app.services.playground_tree_service import _tree_from_run_decision_graph_artifact
from app.services.run_artifacts import read_artifact_file, write_gzip_json


def test_read_gzip_run_decision_graph_and_extract_tree(tmp_path: Path) -> None:
    tree = {
        "nodes": [{"id": "n1", "state_hash": "0", "depth": 0}],
        "edges": [{"from": "n1", "to": "n2", "action": 1, "mode": "broadcaster"}],
    }
    graph_path = tmp_path / "run_decision_graph.json.gz"
    write_gzip_json(graph_path, {"schema_version": 1, "tree": tree})

    raw = read_artifact_file(graph_path)
    extracted = _tree_from_run_decision_graph_artifact(raw)

    assert extracted is not None
    assert len(extracted["edges"]) == 1
