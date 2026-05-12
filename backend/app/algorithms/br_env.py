import copy
import math

import numpy as np

from app.algorithms.common import trees


def hash_state(state) -> str:
    if type(state) != list:
        print("Input of a hashing function must be of type list!!")
    return "/".join(str(x) for x in sorted(state))


class Br_Env:
    V = []
    V_ids = []
    V_s = []
    V_ns = []
    br_cands = []
    rcv_cands = []
    T = None
    cur_time = 0
    done = False
    lowerbound = None

    def __init__(self, node_list, T):
        self.__initialize(node_list, T)
        self.done = False

    def __initialize(self, node_list, T):
        self.V = copy.deepcopy(node_list)
        self.V_ids = [i for i in range(0, len(self.V))]
        self.V_s = [0]
        self.V_ns = copy.deepcopy(self.V_ids)
        self.V_ns.remove(0)
        self.T = T
        self.lowerbound = self.network_diameter()

    def reset(self):
        self.V_s = [0]
        self.V_ns = copy.deepcopy(self.V_ids)
        self.V_ns.remove(0)
        self.cur_time = 0
        self.done = False
        for u in self.V:
            u.reset()
        return False

    def _find_br_rcv_cands(self):
        br_cands = set()
        rcv_cands = set()
        for u in self.V_s:
            for v in self.V[u].neighbors:
                if v in self.V_ns:
                    br_cands.add(u)
                    rcv_cands.add(v)
        self.br_cands = list(br_cands)
        self.rcv_cands = list(rcv_cands)

    def _greedy_spread_broadcaster(self, first_picked):
        br_set = []
        br_temp = copy.deepcopy(self.br_cands)
        rcv_set = []

        if first_picked is not None and first_picked in br_temp:
            br_set.append(first_picked)
            covered = [v for v in self.V[first_picked].neighbors if v in self.rcv_cands]
            rcv_set.extend(covered)
            br_temp.remove(first_picked)

        def count_neighbors_in_rcv_cands(b):
            return len([v for v in self.V[b].neighbors if v in self.rcv_cands])

        br_temp.sort(key=count_neighbors_in_rcv_cands, reverse=True)

        i = 0
        while i < len(br_temp):
            b = br_temp[i]
            neighbors_in_rcv_cands = [v for v in self.V[b].neighbors if v in self.rcv_cands]
            if any(v in rcv_set for v in neighbors_in_rcv_cands):
                br_temp.pop(i)
            else:
                br_set.append(b)
                rcv_set.extend(neighbors_in_rcv_cands)
                br_temp.pop(i)

        return br_set, rcv_set

    def _receiver_parent(self, receiver, br_temp, rcv_temp, rcv_set):
        parents = [
            b
            for b in br_temp
            if receiver in self.V[b].neighbors and not any(v in rcv_set for v in self.V[b].neighbors)
        ]
        if not parents:
            return None
        return max(
            parents,
            key=lambda b: (
                len([v for v in self.V[b].neighbors if v in rcv_temp]),
                -int(b),
            ),
        )

    def _mark_receivers(self, broadcaster, rcv_temp):
        covered = [v for v in self.V[broadcaster].neighbors if v in rcv_temp]
        for receiver in covered:
            rcv_temp.remove(receiver)
        return covered

    def _greedy_spread_receiver(self, first_picked):
        br_set = []
        br_temp = copy.deepcopy(self.br_cands)
        rcv_temp = copy.deepcopy(self.rcv_cands)
        rcv_set = []

        def pick_parent_for_receiver(receiver):
            parent = self._receiver_parent(receiver, br_temp, rcv_temp, rcv_set)
            if parent is None:
                return
            br_set.append(parent)
            rcv_set.extend(self._mark_receivers(parent, rcv_temp))
            br_temp.remove(parent)

        if first_picked is not None and first_picked in rcv_temp:
            pick_parent_for_receiver(first_picked)

        rcv_temp.sort(key=lambda x: (-int(getattr(self.V[x], "latency_ahead", -1)), int(x)))
        while br_temp and rcv_temp:
            receiver = rcv_temp[0]
            before_count = len(rcv_temp)
            pick_parent_for_receiver(receiver)
            if len(rcv_temp) == before_count:
                rcv_temp.pop(0)

        return list(dict.fromkeys(br_set)), list(dict.fromkeys(rcv_set))

    def random_action(self):
        return np.random.choice(self.br_cands)

    def strategic_action(self, qtable):
        if len(self.br_cands) > 0:
            hashed_state = hash_state(self.V_s)
            state_actions = qtable.get(hashed_state, {})
            return max(self.br_cands, key=lambda a: state_actions.get(a, 0.0))
        print("Broadcaster candidate empty!!")
        return None

    def proceed_action(self, first_pick, completion_bonus_multiplier=1.0, action_axis="broadcaster"):
        if str(action_axis) == "receiver":
            br_set, rcv_set = self._greedy_spread_receiver(first_pick)
        else:
            br_set, rcv_set = self._greedy_spread_broadcaster(first_pick)
        completion_bonus = 0
        total_nodes_covered = len(set(self.V_s).union(rcv_set))
        total_nodes_in_topo = len(self.V_ids)
        if total_nodes_covered >= total_nodes_in_topo:
            completion_bonus = (
                float(completion_bonus_multiplier) * total_nodes_in_topo * math.exp(self.lowerbound - self.cur_time)
            )

        reward = len(rcv_set) + completion_bonus
        self.V_ns = list(set(self.V_ns) - set(rcv_set))
        done = len(self.V_ns) == 0
        next_state = self.V_s + rcv_set
        return next_state, reward, done, br_set, rcv_set

    def network_diameter(self):
        trees.build_bfs(self.V)
        farthest_node = max(self.V, key=lambda x: x.distance)
        return farthest_node.distance
