// Turns a PonyTiler wall grid into wall segments. No Foundry APIs in here: the same file runs in the
// PonyTiler editor (as a plain script, for the live preview) and in the Foundry module.
//
// Two kinds of segments come out, both in tile units (1 = one map tile):
//  - edges: the outline of every wall area. Meant to block movement but not sight, so the
//    outer rim of a wall stays visible.
//  - cores: the outline of the wall area shrunk by `inset`. Meant to block sight (and movement),
//    so nobody can see through a wall or deep into it.
// Outwall tiles (value 2 in the grid) only get edges: you bump into them but can see straight through.
// Side outwalls (value 16 + side mask: 1 top, 2 right, 4 bottom, 8 left) are just an edge wall along
// those sides of the tile; the tile itself stays open.
// Decorations (WALLACCESSORY pixels) each face a direction. The core is carved away from the side
// they're seen from, plus `pad` of room, wherever that can be done without opening a hole through the wall.
(function (root) {
  'use strict';

  // Each tile is split into SUB×SUB sub-cells when working out the core.
  var SUB = 8;

  // Facing directions as stored by PonyTiler: 0 = ↑ (seen from below), 1 = → (seen from the left),
  // 2 = ↓ (seen from above), 3 = ← (seen from the right). VIEW is the step from a decoration towards its viewer.
  var DIRS = ['up', 'right', 'down', 'left'];
  var VIEW = [[0, 1], [-1, 0], [0, -1], [1, 0]];

  // Chebyshev min-filter of radius r; cells outside the grid count as `oob`.
  function erode(src, w, h, r, oob) {
    if (r <= 0) return src.slice();
    var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), x, y, i, v;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        v = 1;
        for (i = x - r; i <= x + r && v; i++) v = i < 0 || i >= w ? oob : src[y * w + i];
        tmp[y * w + x] = v;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        v = 1;
        for (i = y - r; i <= y + r && v; i++) v = i < 0 || i >= h ? oob : tmp[i * w + x];
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function dilate(src, w, h, r) {
    var inv = src.map(function (v) { return v ? 0 : 1; });
    return erode(inv, w, h, r, 1).map(function (v) { return v ? 0 : 1; });
  }

  // Neighbours clockwise from top-left: NW N NE E SE S SW W.
  var RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

  // Simple-point table for (4, 8) connectivity: the core is 4-connected and open space 8-connected, so
  // removing a simple point can never let open space touch across a diagonal (a corner a ray could slip through).
  var SIMPLE = (function () {
    var table = new Uint8Array(256);
    function components(members, adjacent, mustTouch) {
      var seen = {}, n = 0;
      members.forEach(function (a) {
        if (seen[a]) return;
        var stack = [a], touches = false;
        seen[a] = true;
        while (stack.length) {
          var c = stack.pop();
          if (!mustTouch || mustTouch(c)) touches = true;
          members.forEach(function (b) { if (!seen[b] && adjacent(c, b)) { seen[b] = true; stack.push(b); } });
        }
        if (touches) n++;
      });
      return n;
    }
    function adj4(a, b) { return Math.abs(RING[a][0] - RING[b][0]) + Math.abs(RING[a][1] - RING[b][1]) === 1; }
    function adj8(a, b) { return Math.max(Math.abs(RING[a][0] - RING[b][0]), Math.abs(RING[a][1] - RING[b][1])) === 1; }
    for (var m = 0; m < 256; m++) {
      var fg = [], bg = [];
      for (var i = 0; i < 8; i++) (m & (1 << i) ? fg : bg).push(i);
      table[m] = components(fg, adj4, function (i) { return i % 2 === 1; }) === 1 && components(bg, adj8, null) === 1 ? 1 : 0;
    }
    return table;
  })();

  // Boundary segments of a binary grid, merged into long runs. Edges on the grid border are skipped.
  // `extra` (optional, cols×rows side masks as in the wall grid) adds single tile sides on top.
  function outline(g, w, h, scale, extra) {
    var hz = new Uint8Array(w * (h + 1)), vt = new Uint8Array((w + 1) * h), x, y, m;
    for (y = 1; y < h; y++) for (x = 0; x < w; x++) hz[y * w + x] = g[(y - 1) * w + x] !== g[y * w + x] ? 1 : 0;
    for (y = 0; y < h; y++) for (x = 1; x < w; x++) vt[y * (w + 1) + x] = g[y * w + x - 1] !== g[y * w + x] ? 1 : 0;
    if (extra) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          if (!(m = extra[y * w + x])) continue;
          if (m & 1) hz[y * w + x] = 1;
          if (m & 4) hz[(y + 1) * w + x] = 1;
          if (m & 8) vt[y * (w + 1) + x] = 1;
          if (m & 2) vt[y * (w + 1) + x + 1] = 1;
        }
      }
    }
    var segs = [], start, on;
    for (y = 0; y <= h; y++) {
      start = -1;
      for (x = 0; x <= w; x++) {
        on = x < w && hz[y * w + x] === 1;
        if (on && start < 0) start = x;
        if (!on && start >= 0) { segs.push([start / scale, y / scale, x / scale, y / scale]); start = -1; }
      }
    }
    for (x = 0; x <= w; x++) {
      start = -1;
      for (y = 0; y <= h; y++) {
        on = y < h && vt[y * (w + 1) + x] === 1;
        if (on && start < 0) start = y;
        if (!on && start >= 0) { segs.push([x / scale, start / scale, x / scale, y / scale]); start = -1; }
      }
    }
    return segs;
  }

  /**
   * @param {object} o
   * @param {number} o.cols, o.rows  grid size in tiles
   * @param {Uint8Array} o.wall      cols×rows, 1 where the tile is a wall, 2 where it is an outwall (edges only),
   *                                 16 + side mask for a side outwall (an edge along those sides only)
   * @param {Uint8Array} [o.acc]     (cols·SUB)×(rows·SUB) decoration mask: 0 = none, 1 + direction otherwise
   * @param {number} [o.inset=2]     how far the sight blocker sits inside the wall, in sub-cells (1 … SUB/2-1)
   * @param {number} [o.pad=2]       extra room kept clear around decorations, in sub-cells
   */
  function buildWalls(o) {
    var cols = o.cols, rows = o.rows, wall = o.wall, acc = o.acc;
    var inset = Math.max(1, Math.min(SUB / 2 - 1, Math.round(o.inset === undefined ? 2 : o.inset)));
    var pad = Math.max(0, Math.round(o.pad === undefined ? 2 : o.pad));
    var solid = wall.map(function (v) { return v === 1 || v === 2 ? 1 : 0; });
    var sides = wall.map(function (v) { return v > 16 ? v & 15 : 0; });
    var edges = outline(solid, cols, rows, 1, sides);

    var W = cols * SUB, H = rows * SUB, fine = new Uint8Array(W * H), x, y, i;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) fine[y * W + x] = wall[((y / SUB) | 0) * cols + ((x / SUB) | 0)] === 1 ? 1 : 0;
    // Walls carry on past the map edge, so the core reaches the border instead of leaving a gap there.
    var core = erode(fine, W, H, inset, 1);
    var at = function (x, y) { return x < 0 || y < 0 || x >= W || y >= H ? 1 : core[y * W + x]; };
    var isSimple = function (i) {
      var x = i % W, y = (i / W) | 0, m = 0;
      for (var k = 0; k < 8; k++) if (at(x + RING[k][0], y + RING[k][1])) m |= 1 << k;
      return SIMPLE[m] === 1;
    };

    // Per direction: the area to clear is the decoration plus padding, stretched towards its viewer
    // until it leaves the wall. The core is then peeled from the viewer's side only, so it bulges
    // around the decoration and stays whole behind it.
    var groups = [];
    if (acc) {
      for (var d = 0; d < 4; d++) {
        var mask = new Uint8Array(W * H), any = false;
        for (i = 0; i < W * H; i++) if (acc[i] === d + 1) { mask[i] = 1; any = true; }
        if (!any) continue;
        var clear = dilate(mask, W, H, pad), vx = VIEW[d][0], vy = VIEW[d][1];
        var xs = vx < 0 ? W - 1 : 0, xe = vx < 0 ? -1 : W, xd = vx < 0 ? -1 : 1;
        var ys = vy < 0 ? H - 1 : 0, ye = vy < 0 ? -1 : H, yd = vy < 0 ? -1 : 1;
        for (y = ys; y !== ye; y += yd) {
          for (x = xs; x !== xe; x += xd) {
            var px = x - vx, py = y - vy, j = y * W + x;
            if (!clear[j] && fine[j] && px >= 0 && py >= 0 && px < W && py < H && clear[py * W + px]) clear[j] = 1;
          }
        }
        var cand = [];
        for (i = 0; i < W * H; i++) if (clear[i] && core[i]) cand.push(i);
        groups.push({ vx: vx, vy: vy, cand: cand });
      }
    }
    var changed = true;
    while (changed) {
      changed = false;
      groups.forEach(function (g) {
        g.cand.forEach(function (i) {
          if (core[i] && !at(i % W + g.vx, ((i / W) | 0) + g.vy) && isSimple(i)) { core[i] = 0; changed = true; }
        });
        g.cand = g.cand.filter(function (i) { return core[i]; });
      });
    }

    return { edges: edges, cores: outline(core, W, H, SUB) };
  }

  // Reads a tEXt chunk with the given keyword out of PNG bytes, or null.
  function readPngText(buf, keyword) {
    var b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), p = 8;
    var latin1 = function (a) { var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return s; };
    while (p + 12 <= b.length) {
      var len = dv.getUint32(p), type = latin1(b.subarray(p + 4, p + 8));
      if (type === 'tEXt') {
        var data = b.subarray(p + 8, p + 8 + len), z = data.indexOf(0);
        if (z > 0 && latin1(data.subarray(0, z)) === keyword) return latin1(data.subarray(z + 1));
      }
      if (type === 'IEND') break;
      p += 12 + len;
    }
    return null;
  }

  root.PonyWalls = { SUB: SUB, DIRS: DIRS, buildWalls: buildWalls, readPngText: readPngText };
})(typeof globalThis !== 'undefined' ? globalThis : window);
