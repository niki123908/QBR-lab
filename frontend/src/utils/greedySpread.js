function buildAdjacencyFromGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return new Map();
  const adjacency = new Map(graph.nodes.map((node) => [node.node_id, new Set()]));
  const txRange = Number(graph.tx_range) || 0;
  const txRangeSq = txRange * txRange;
  const nodes = graph.nodes;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy <= txRangeSq) {
        adjacency.get(a.node_id)?.add(b.node_id);
        adjacency.get(b.node_id)?.add(a.node_id);
      }
    }
  }
  return adjacency;
}

export function derivePlaygroundCandidates(graph, coveredNodeIds) {
  const covered = new Set(coveredNodeIds ?? []);
  const adjacency = buildAdjacencyFromGraph(graph);
  const broadcasterCandidates = [];
  const receiverCandidatesSet = new Set();

  covered.forEach((nodeId) => {
    const neighbors = adjacency.get(nodeId) ?? new Set();
    const canReachUncovered = Array.from(neighbors).some((neighborId) => !covered.has(neighborId));
    if (canReachUncovered) {
      broadcasterCandidates.push(nodeId);
      neighbors.forEach((neighborId) => {
        if (!covered.has(neighborId)) {
          receiverCandidatesSet.add(neighborId);
        }
      });
    }
  });

  return {
    adjacency,
    broadcasterCandidates: broadcasterCandidates.sort((a, b) => a - b),
    receiverCandidates: Array.from(receiverCandidatesSet).sort((a, b) => a - b)
  };
}

function buildBfsTree(nodeIds, adjacency) {
  const distance = new Map(nodeIds.map((id) => [id, Number.POSITIVE_INFINITY]));
  const parent = new Map(nodeIds.map((id) => [id, null]));
  const children = new Map(nodeIds.map((id) => [id, []]));
  distance.set(0, 0);
  const queue = [0];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    visited += 1;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (distance.get(neighbor) === Number.POSITIVE_INFINITY) {
        distance.set(neighbor, distance.get(current) + 1);
        parent.set(neighbor, current);
        children.get(current).push(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return { distance, parent, children, connected: visited === nodeIds.length };
}

function computeLatencyAhead(nodeIds, children) {
  const la = new Map(nodeIds.map((id) => [id, -1]));
  function visit(nodeId) {
    const childIds = children.get(nodeId) ?? [];
    if (!childIds.length) {
      la.set(nodeId, 0);
      return 0;
    }
    const childValues = childIds.map((child) => visit(child));
    const value = Math.max(...childValues, 0) + 1;
    la.set(nodeId, value);
    return value;
  }
  visit(0);
  return la;
}

function countNeighborsInRcvCands(broadcaster, adjacency, rcvCands) {
  const rcvSet = new Set(rcvCands);
  return Array.from(adjacency.get(broadcaster) ?? []).filter((nbr) => rcvSet.has(nbr)).length;
}

function futureNeighborCount(receiver, adjacency, uncovered, brCands, rcvCands) {
  const brSet = new Set(brCands);
  const rcvSet = new Set(rcvCands);
  return Array.from(adjacency.get(receiver) ?? []).filter(
    (nbr) => uncovered.has(nbr) && !rcvSet.has(nbr) && !brSet.has(nbr)
  ).length;
}

function spreadBroadcaster({
  firstPick,
  brCands,
  rcvCands,
  adjacency,
  spreadMode,
  latencyAhead
}) {
  const brSet = [];
  const brTemp = [...brCands];
  const rcvSet = [];

  if (firstPick !== null && firstPick !== undefined && brTemp.includes(firstPick)) {
    brSet.push(firstPick);
    const covered = Array.from(adjacency.get(firstPick) ?? []).filter((nbr) => rcvCands.includes(nbr));
    rcvSet.push(...covered);
    brTemp.splice(brTemp.indexOf(firstPick), 1);
  }

  if (spreadMode === "la") {
    brTemp.sort(
      (a, b) =>
        (latencyAhead.get(b) ?? -1) - (latencyAhead.get(a) ?? -1) || b - a
    );
  } else {
    brTemp.sort(
      (a, b) => countNeighborsInRcvCands(b, adjacency, rcvCands) - countNeighborsInRcvCands(a, adjacency, rcvCands)
    );
  }

  let i = 0;
  while (i < brTemp.length) {
    const broadcaster = brTemp[i];
    const neighbors = Array.from(adjacency.get(broadcaster) ?? []).filter((nbr) => rcvCands.includes(nbr));
    if (neighbors.some((nbr) => rcvSet.includes(nbr))) {
      brTemp.splice(i, 1);
    } else {
      brSet.push(broadcaster);
      rcvSet.push(...neighbors);
      brTemp.splice(i, 1);
    }
  }

  return {
    transmitters: [...new Set(brSet)].sort((a, b) => a - b),
    receivers: [...new Set(rcvSet)].sort((a, b) => a - b)
  };
}

function receiverParent(receiver, brTemp, rcvTemp, rcvSet, adjacency) {
  const parents = brTemp.filter(
    (b) =>
      (adjacency.get(b) ?? new Set()).has(receiver) &&
      !Array.from(adjacency.get(b) ?? []).some((nbr) => rcvSet.includes(nbr))
  );
  if (!parents.length) return null;
  return [...parents].sort((a, b) => {
    const rcvTempSet = new Set(rcvTemp);
    const aCover = Array.from(adjacency.get(a) ?? []).filter((nbr) => rcvTempSet.has(nbr)).length;
    const bCover = Array.from(adjacency.get(b) ?? []).filter((nbr) => rcvTempSet.has(nbr)).length;
    if (bCover !== aCover) return bCover - aCover;
    return b - a;
  })[0];
}

function spreadReceiver({
  firstPick,
  brCands,
  rcvCands,
  adjacency,
  spreadMode,
  latencyAhead,
  uncovered
}) {
  const brSet = [];
  const brTemp = [...brCands];
  const rcvTemp = [...rcvCands];
  const rcvSet = [];

  function pickParentForReceiver(receiver) {
    const parent = receiverParent(receiver, brTemp, rcvTemp, rcvSet, adjacency);
    if (parent === null) return;
    brSet.push(parent);
    const covered = Array.from(adjacency.get(parent) ?? []).filter((nbr) => rcvTemp.includes(nbr));
    covered.forEach((nbr) => {
      const idx = rcvTemp.indexOf(nbr);
      if (idx >= 0) rcvTemp.splice(idx, 1);
    });
    rcvSet.push(...covered);
    brTemp.splice(brTemp.indexOf(parent), 1);
  }

  if (firstPick !== null && firstPick !== undefined && rcvTemp.includes(firstPick)) {
    pickParentForReceiver(firstPick);
  }

  if (spreadMode === "la") {
    rcvTemp.sort((a, b) => (latencyAhead.get(b) ?? -1) - (latencyAhead.get(a) ?? -1) || a - b);
  } else {
    rcvTemp.sort(
      (a, b) =>
        futureNeighborCount(b, adjacency, uncovered, brCands, rcvCands) -
          futureNeighborCount(a, adjacency, uncovered, brCands, rcvCands) || a - b
    );
  }

  while (brTemp.length && rcvTemp.length) {
    const receiver = rcvTemp[0];
    const beforeCount = rcvTemp.length;
    pickParentForReceiver(receiver);
    if (rcvTemp.length === beforeCount) {
      rcvTemp.shift();
    }
  }

  return {
    transmitters: [...new Set(brSet)].sort((a, b) => a - b),
    receivers: [...new Set(rcvSet)].sort((a, b) => a - b)
  };
}

export function simulateGreedySpread(graph, coveredNodeIds, mode, selectedNodeId, spreadMode = "normal") {
  if (!graph) return null;
  const covered = new Set(coveredNodeIds ?? []);
  const nodeIds = (graph.nodes ?? []).map((node) => node.node_id).sort((a, b) => a - b);
  const uncovered = new Set(nodeIds.filter((id) => !covered.has(id)));
  const { adjacency, broadcasterCandidates, receiverCandidates } = derivePlaygroundCandidates(graph, coveredNodeIds);
  const normalizedSpread = spreadMode === "la" ? "la" : "normal";

  const { children } = buildBfsTree(nodeIds, adjacency);
  const latencyAhead = normalizedSpread === "la" ? computeLatencyAhead(nodeIds, children) : new Map();

  let firstPick = null;
  if (mode === "receiver") {
    if (receiverCandidates.includes(selectedNodeId)) {
      firstPick = selectedNodeId;
    }
  } else if (broadcasterCandidates.includes(selectedNodeId)) {
    firstPick = selectedNodeId;
  }

  if (firstPick === null) return null;

  const spread =
    mode === "receiver"
      ? spreadReceiver({
          firstPick,
          brCands: broadcasterCandidates,
          rcvCands: receiverCandidates,
          adjacency,
          spreadMode: normalizedSpread,
          latencyAhead,
          uncovered
        })
      : spreadBroadcaster({
          firstPick,
          brCands: broadcasterCandidates,
          rcvCands: receiverCandidates,
          adjacency,
          spreadMode: normalizedSpread,
          latencyAhead
        });

  if (!spread.receivers.length) return null;

  return {
    firstPick,
    mode,
    spreadMode: normalizedSpread,
    transmitters: spread.transmitters,
    receivers: spread.receivers
  };
}
