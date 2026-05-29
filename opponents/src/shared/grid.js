// Minimal BFS pathfinder for opponent agents. Cheaper than the BDI
// agent's planner — no transient blocks, no enemy avoidance, no PDDL.
// Just shortest walkable path. Opponents are *meant* to be naive.

const tileKey = (x, y) => `${x}|${y}`;

const DIRS = [
  ['up',    0,  1],
  ['right', 1,  0],
  ['down',  0, -1],
  ['left', -1,  0],
];

export function bfs(state, from, target) {
  if (!state.map) return null;
  const startKey = tileKey(from.x, from.y);
  const targetKey = tileKey(target.x, target.y);
  if (startKey === targetKey) return { directions: [], cost: 0 };

  const queue = [{ x: from.x, y: from.y }];
  const cameFrom = new Map([[startKey, null]]);

  while (queue.length > 0) {
    const cur = queue.shift();
    const curKey = tileKey(cur.x, cur.y);
    if (curKey === targetKey) {
      const path = [];
      let k = curKey;
      while (k !== null) {
        const [xs, ys] = k.split('|').map(Number);
        path.unshift({ x: xs, y: ys });
        k = cameFrom.get(k);
      }
      const directions = [];
      for (let i = 1; i < path.length; i++) {
        const dx = path[i].x - path[i - 1].x;
        const dy = path[i].y - path[i - 1].y;
        if (dx === 1) directions.push('right');
        else if (dx === -1) directions.push('left');
        else if (dy === 1) directions.push('up');
        else if (dy === -1) directions.push('down');
      }
      return { directions, cost: directions.length };
    }
    for (const [dirName, dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nk = tileKey(nx, ny);
      if (cameFrom.has(nk)) continue;
      const isTarget = nk === targetKey;
      if (!state.map.walkable.has(nk)) continue;
      cameFrom.set(nk, curKey);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
