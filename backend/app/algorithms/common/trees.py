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
