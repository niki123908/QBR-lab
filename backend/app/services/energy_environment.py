"""Deterministic slot physics, independent of any learning algorithm."""
from copy import deepcopy

class EnergyEnvironment:
    def __init__(self, topology):
        self.topology = deepcopy(topology)
        self.nodes = {n["node_id"]: n for n in topology["nodes"]}
        if len(self.nodes) < 2 or 0 not in self.nodes:
            raise ValueError("At least a source and one sensor are required.")
        self.config = topology["energy_defaults"]
        self.neighbors = {i: {j for j in self.nodes if j != i and
            (n["x"]-self.nodes[j]["x"])**2 + (n["y"]-self.nodes[j]["y"])**2 <= topology["tx_range"]**2}
            for i, n in self.nodes.items()}
        self.reset()

    def reset(self):
        self.slot = 0
        self.energy = {i: 0.0 for i in self.nodes if i != 0}
        self.received = {0: 0}
        return self.snapshot()

    def snapshot(self):
        return deepcopy(dict(slot=self.slot, energy=self.energy, received=self.received,
            completed=len(self.received)==len(self.nodes), truncated=self.slot>=100 and len(self.received)<len(self.nodes)))

    def step(self, tx_nodes=(), rx_nodes=()):
        tx, rx = set(tx_nodes), set(rx_nodes)
        if (tx | rx) - self.nodes.keys():
            raise ValueError("Unknown node ID.")
        if self.snapshot()["completed"] or self.slot >= 100:
            raise ValueError("Episode has ended.")
        before = self.snapshot()
        skipped = []
        overlap = tx & rx
        for i in sorted(overlap):
            skipped.append(dict(node=i, activity="rx", reason="TX takes priority over RX"))
        rx -= tx
        actual_tx, actual_rx = set(), set()
        for i in sorted(tx):
            reason = "No packet" if i not in self.received else ("Insufficient TX energy" if i != 0 and self.energy[i] < self.config["tx_cost"] else None)
            if reason: skipped.append(dict(node=i, activity="tx", reason=reason))
            else: actual_tx.add(i)
        for i in sorted(rx):
            reason = "Already received" if i in self.received else ("Insufficient RX energy" if self.energy[i] < self.config["rx_cost"] else None)
            if reason: skipped.append(dict(node=i, activity="rx", reason=reason))
            else: actual_rx.add(i)
        heard = {i: sorted(self.neighbors[i] & actual_tx) for i in sorted(actual_rx)}
        new = [i for i, senders in heard.items() if len(senders)==1]
        collision = [i for i, senders in heard.items() if len(senders)>1]
        idle = [i for i, senders in heard.items() if not senders]
        for i in actual_tx - {0}: self.energy[i] -= self.config["tx_cost"]
        for i in actual_rx: self.energy[i] -= self.config["rx_cost"]
        after_activity = dict(self.energy)
        harvested, overflow = {}, {}
        for i in self.energy:
            rate = self.nodes[i]["harvest_rate"]
            harvested[i] = min(rate, self.config["capacity"]-self.energy[i])
            overflow[i] = rate-harvested[i]
            self.energy[i] += harvested[i]
        self.slot += 1
        for i in new: self.received[i] = self.slot
        return dict(slot=self.slot, requested_tx=sorted(tx), requested_rx=sorted(set(rx_nodes)),
            tx=sorted(actual_tx), rx=sorted(actual_rx), heard=heard, new_received=new, collisions=collision,
            no_signal=idle, skipped=skipped, before=before, after_activity=after_activity,
            harvested=harvested, overflow=overflow, after=self.snapshot())


def spread_energy_slot(env, first_pick, spread_mode="normal"):
    """Shared spread policy for Playground and future Energy runners."""
    if spread_mode not in {"normal", "energy"}:
        raise ValueError("Unsupported Energy spread mode.")
    if first_pick is None:
        return env.step(), []
    uncovered = set(env.nodes) - env.received.keys()
    # All eligibility and conflict checks use energy at the start of the slot.
    ready = {i for i in uncovered if env.energy[i] >= env.config["rx_cost"]}
    receivers_by_tx = {i: env.neighbors[i] & ready for i in env.received}
    candidates = [i for i in env.received if (i == 0 or env.energy[i] >= env.config["tx_cost"])
                  and receivers_by_tx[i]]
    if first_pick not in candidates:
        raise ValueError("Node needs TX energy and at least one uncovered receiver with RX energy.")
    def priority(i):
        if spread_mode == "energy":
            rate = float("inf") if i == 0 else env.nodes[i]["harvest_rate"]
            energy = float("inf") if i == 0 else env.energy[i]
            return (-rate, -len(receivers_by_tx[i]), -energy, i)
        return (-len(receivers_by_tx[i]), i)

    order = [first_pick] + sorted((i for i in candidates if i != first_pick), key=priority)
    transmitters, targeted, blocked = [], set(), set()
    for i in order:
        receivers = receivers_by_tx[i]
        if receivers & targeted:
            continue
        transmitters.append(i)
        targeted |= receivers
        # Keep unavailable neighbors for the lightning preview; they do not listen.
        blocked |= (env.neighbors[i] & uncovered) - ready
    return env.step(transmitters, sorted(targeted)), sorted(blocked)



def playground_energy(topology, actions, first_pick, energy=None, spread_mode="normal"):
    topology = deepcopy(topology)
    if energy:
        from app.energy_schemas import EnergyDefaults
        topology["energy_defaults"] = EnergyDefaults(**{**topology["energy_defaults"], **energy}).model_dump()
    env = EnergyEnvironment(topology)
    for action in actions:
        if isinstance(action, dict):
            spread_energy_slot(env, action["first_pick"], action.get("spread_mode", "normal"))
        else:
            spread_energy_slot(env, action)
    result, blocked = spread_energy_slot(env, first_pick, spread_mode)
    return dict(firstPick=first_pick, spreadMode=spread_mode, transmitters=result["tx"], receivers=result["new_received"],
                blocked=blocked, energyResult=result)
