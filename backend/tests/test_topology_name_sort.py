from app.repositories.topology_memory_repo import _natural_topology_name_key


def test_natural_topology_name_key_orders_suffixes() -> None:
    names = ["tp_250_49", "tp_250_00", "tp_250_200", "tp_250_01", "tp_250_10"]
    ordered = sorted(names, key=_natural_topology_name_key)
    assert ordered == ["tp_250_00", "tp_250_01", "tp_250_10", "tp_250_49", "tp_250_200"]
