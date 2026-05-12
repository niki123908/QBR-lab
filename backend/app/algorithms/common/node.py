class Node:
    def __init__(self, ID: int = 0, x: float = 0.0, y: float = 0.0, timeslot: int = -1):
        self.ID = ID
        self.x = x
        self.y = y
        self.active_slot = timeslot
        self.latency_ahead = -1
        self.overheared = 0
        self.parentID = None
        self.childrenIDs: list[int] = []
        self.neighbors: list[int] = []
        self.distance = -1
        self.rcv_ts = 0
        self.has_msg = False
        self.descendants: list[int] = []
        self.hop_distance = 0

    def set_parent(self, pID: int | None) -> bool:
        if pID is None:
            print("Please specify a valid parent ID")
            return False
        if pID == self.ID:
            print(f"Node {self.ID}: Cannot take itself as a parent")
            return False
        self.parentID = pID
        return True

    def set_rcv_ts(self, time_slot: int) -> None:
        if self.rcv_ts == -1:
            self.rcv_ts = time_slot
        else:
            print(f"Oops!! node {self.ID} already has a receiving time slot, unable to assign new")

    def reset(self) -> None:
        self.latency_ahead = -1
        self.overheared = 0
        self.parentID = None
        self.childrenIDs = []
        self.distance = -1
        self.rcv_ts = -1
        self.has_msg = False
