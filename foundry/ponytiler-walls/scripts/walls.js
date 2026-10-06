// Turns a PonyTiler wall grid into wall segments. No Foundry APIs in here, so it can be tested on its own.
//
// Two kinds of segments come out, both in tile units (1 = one map tile):
//  - edges: the outline of every wall area. Meant to block movement but not sight, so the
//    outer rim of a wall stays visible.
//  - cores: the outline of the wall area shrunk by `inset`. Meant to block sight (and movement),
//    so nobody can see through a wall or deep into it.
// Tiles flagged as accessories are cut out of the core (plus `pad` of room around them) wherever
// that can be done without opening a hole through the wall.

// Each tile is split into SUB×SUB sub-cells when working out the core.
export const SUB = 8;

// Chebyshev min-filter of radius r; cells outside the grid count as `oob`.
function erode(src, w, h, r, oob) {
  if (r <= 0) return src.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let i = x - r; i <= x + r && v; i++) v = i < 0 || i >= w ? oob : src[y * w + i];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let j = y - r; j <= y + r && v; j++) v = j < 0 || j >= h ? oob : tmp[j * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

function dilate(src, w, h, r) {
  const inv = src.map(v => (v ? 0 : 1));
  return erode(inv, w, h, r, 1).map(v => (v ? 0 : 1));
}

// Neighbours clockwise from top-left: NW N NE E SE S SW W.
const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

// Simple-point table for (4, 8) connectivity: the core is 4-connected and the open space 8-connected,
// so removing a simple point can never let open space touch across a diagonal (a corner a ray could slip through).
const SIMPLE = (() => {
  const table = new Uint8Array(256);
  const components = (members, adjacent, mustTouch) => {
    const seen = new Set();
    let n = 0;
    for (const a of members) {
      if (seen.has(a)) continue;
      const stack = [a], comp = [];
      seen.add(a);
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        for (const b of members) if (!seen.has(b) && adjacent(c, b)) { seen.add(b); stack.push(b); }
      }
      if (!mustTouch || comp.some(mustTouch)) n++;
    }
    return n;
  };
  const adj4 = (a, b) => Math.abs(RING[a][0] - RING[b][0]) + Math.abs(RING[a][1] - RING[b][1]) === 1;
  const adj8 = (a, b) => Math.max(Math.abs(RING[a][0] - RING[b][0]), Math.abs(RING[a][1] - RING[b][1])) === 1;
  for (let m = 0; m < 256; m++) {
    const fg = [], bg = [];
    for (let i = 0; i < 8; i++) (m & (1 << i) ? fg : bg).push(i);
    const t4 = components(fg, adj4, i => i % 2 === 1);
    const t8 = components(bg, adj8, null);
    table[m] = t4 === 1 && t8 === 1 ? 1 : 0;
  }
  return table;
})();

// Boundary segments of a binary grid, merged into long runs. Edges on the grid border are skipped.
function outline(g, w, h, scale) {
  const segs = [];
  for (let y = 1; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && g[(y - 1) * w + x] !== g[y * w + x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) { segs.push([start / scale, y / scale, x / scale, y / scale]); start = -1; }
    }
  }
  for (let x = 1; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && g[y * w + x - 1] !== g[y * w + x];
      if (on && start < 0) start = y;
      if (!on && start >= 0) { segs.push([x / scale, start / scale, x / scale, y / scale]); start = -1; }
    }
  }
  return segs;
}

/**
 * @param {object} o
 * @param {number} o.cols, o.rows  grid size in tiles
 * @param {Uint8Array} o.wall      1 where the tile is a wall
 * @param {Uint8Array} [o.acc]     1 where the tile has a WALLACCESSORY decoration
 * @param {number} [o.inset=2]     how far the sight blocker sits inside the wall, in sub-cells (1 … SUB/2-1)
 * @param {number} [o.pad=2]       extra room kept clear around accessories, in sub-cells
 */
export function buildWalls({ cols, rows, wall, acc, inset = 2, pad = 2 }) {
  inset = Math.max(1, Math.min(SUB / 2 - 1, Math.round(inset)));
  pad = Math.max(0, Math.round(pad));
  const edges = outline(wall, cols, rows, 1);

  const W = cols * SUB, H = rows * SUB;
  const fine = new Uint8Array(W * H), fineAcc = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = ((y / SUB) | 0) * cols + ((x / SUB) | 0);
      fine[y * W + x] = wall[c] ? 1 : 0;
      fineAcc[y * W + x] = acc && acc[c] ? 1 : 0;
    }
  }
  // Walls carry on past the map edge, so the core reaches the border instead of leaving a gap there.
  const core = erode(fine, W, H, inset, 1);

  if (acc && acc.some(Boolean)) {
    const clear = dilate(fineAcc, W, H, pad);
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 1 : core[y * W + x]);
    const isSimple = i => {
      const x = i % W, y = (i / W) | 0;
      let m = 0;
      for (let k = 0; k < 8; k++) if (at(x + RING[k][0], y + RING[k][1])) m |= 1 << k;
      return SIMPLE[m] === 1;
    };
    let cand = [];
    for (let i = 0; i < W * H; i++) if (clear[i] && core[i]) cand.push(i);
    // Peel the core away from accessories one side at a time (keeps what's left centred), only
    // removing sub-cells whose loss can't join two separate open areas.
    const DIRS = [[0, -1], [0, 1], [1, 0], [-1, 0]];
    let changed = true;
    while (changed && cand.length) {
      changed = false;
      for (const [dx, dy] of DIRS) {
        const border = cand.filter(i => core[i] && !at(i % W + dx, ((i / W) | 0) + dy));
        for (const i of border) if (isSimple(i)) { core[i] = 0; changed = true; }
      }
      cand = cand.filter(i => core[i]);
    }
  }

  return { edges, cores: outline(core, W, H, SUB) };
}

// Reads a tEXt chunk with the given keyword out of PNG bytes, or null.
export function readPngText(buf, keyword) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'tEXt') {
      const data = b.subarray(p + 8, p + 8 + len), z = data.indexOf(0);
      if (z > 0 && new TextDecoder('latin1').decode(data.subarray(0, z)) === keyword) {
        return new TextDecoder('latin1').decode(data.subarray(z + 1));
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return null;
}
