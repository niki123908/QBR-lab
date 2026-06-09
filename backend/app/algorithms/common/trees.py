import queue
import sys

INFINITY = sys.maxsize - 1


def build_bfs(node_list) -> bool:
    for each_node in node_list:
        each_node.distance = INFINITY
    node_list[0].distance = 0

    q = queue.Queue()
    q.put(node_list[0])
    count = 0
    while not q.empty():
        current = q.get()
        count += 1
        for each_node_id in current.neighbors:
            if node_list[each_node_id].distance == INFINITY:
                node_list[each_node_id].distance = current.distance + 1
                node_list[each_node_id].set_parent(current.ID)
                current.childrenIDs.append(each_node_id)
                q.put(node_list[each_node_id])

    if count < len(node_list):
        print("Disconnected network!!!")
        return False
    return True


def compute_latency_ahead(node_list) -> None:
    """Post-order on BFS SPT rooted at node 0: distance to farthest leaf in subtree."""

    def visit(node_id: int) -> int:
        children = list(node_list[node_id].childrenIDs)
        if not children:
            node_list[node_id].latency_ahead = 0
            return 0
        child_values = [visit(child) for child in children]
        value = max(child_values) + 1 if child_values else 0
        node_list[node_id].latency_ahead = value
        return value

    visit(0)


def prepare_latency_ahead(node_list) -> None:
    """Build BFS tree from sink and compute latency_ahead on each node."""
    build_bfs(node_list)
    compute_latency_ahead(node_list)
