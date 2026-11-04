from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class EnergyDefaults(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    harvest_min: float = Field(default=1, gt=0)
    harvest_max: float = Field(default=10, gt=0)
    capacity: float = Field(default=100, gt=0)
    tx_cost: float = Field(default=20, gt=0)
    rx_cost: float = Field(default=10, gt=0)
    distribution: Literal["uniform", "triangular"] = "uniform"
    harvest_mode: float | None = Field(default=None, gt=0)
    initial_energy: Literal[0] = 0

    @model_validator(mode="after")
    def validate_energy(self):
        if self.harvest_min > self.harvest_max:
            raise ValueError("Harvest min must not exceed harvest max.")
        if self.distribution == "triangular" and (
            self.harvest_mode is None or not self.harvest_min <= self.harvest_mode <= self.harvest_max
        ):
            raise ValueError("Triangular peak must be between harvest min and max.")
        if self.capacity < max(self.tx_cost, self.rx_cost):
            raise ValueError("Capacity must cover both a TX operation and an RX operation individually.")
        return self


class EnergyGenerate(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    num_nodes: int = Field(default=50, ge=2, le=1000)
    space_width: int = Field(gt=0, le=100000)
    space_height: int = Field(gt=0, le=100000)
    tx_range: float = Field(gt=0)
    sink_mode: Literal["manual", "center", "corner_tl", "corner_tr", "corner_bl", "corner_br"] = "center"
    sink_x: int | None = None
    sink_y: int | None = None
    seed: int | None = Field(default=None, ge=0, le=2147483647)
    max_retry: int = Field(default=200, ge=1, le=500)
    batch_id: str | None = None
    energy: EnergyDefaults = Field(default_factory=EnergyDefaults)


class EnergyMultiGenerate(EnergyGenerate):
    node_counts: list[int] = Field(min_length=1, max_length=30)
    count_per_node_count: int = Field(default=1, ge=1, le=100)

    @model_validator(mode="after")
    def validate_counts(self):
        if any(n < 2 or n > 1000 for n in self.node_counts):
            raise ValueError("Node counts must be between 2 and 1000.")
        if len(set(self.node_counts)) != len(self.node_counts):
            raise ValueError("Node counts must be unique.")
        if len(self.node_counts) * self.count_per_node_count > 100:
            raise ValueError("Generate at most 100 topologies per request.")
        return self
