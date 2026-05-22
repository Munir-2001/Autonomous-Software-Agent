// Geometry helpers. Note Deliveroo direction conventions (slide 01):
//   up = y+1, down = y-1, right = x+1, left = x-1
// (NOT the screen-coordinate intuition.)

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function tileKey(x, y) {
  return `${x}|${y}`;
}

export function adjacent(a, b) {
  return manhattan(a, b) === 1;
}

export function directionFromTo(from, to) {
  if (to.x === from.x + 1 && to.y === from.y) return 'right';
  if (to.x === from.x - 1 && to.y === from.y) return 'left';
  if (to.x === from.x && to.y === from.y + 1) return 'up';
  if (to.x === from.x && to.y === from.y - 1) return 'down';
  return null;
}

export function applyDirection(pos, dir) {
  switch (dir) {
    case 'right': return { x: pos.x + 1, y: pos.y };
    case 'left':  return { x: pos.x - 1, y: pos.y };
    case 'up':    return { x: pos.x, y: pos.y + 1 };
    case 'down':  return { x: pos.x, y: pos.y - 1 };
    default: return null;
  }
}

// Round agent's mid-move coordinate (e.g. 1.6) to its current logical tile.
// Player coordinates can be fractional during the 0.6/0.4 move phases.
export function roundPos(p) {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
