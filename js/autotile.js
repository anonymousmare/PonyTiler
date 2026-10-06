// RPG Maker MV tileset layouts and autotile drawing.
// Block positions follow Tilemap.prototype._drawAutotile in rpg_core.js;
// quarter-tile picking reproduces FLOOR/WALL/WATERFALL_AUTOTILE_TABLE from neighbours.
(function () {
  'use strict';

  var TYPES = {
    normal: { label: 'Normal (B–E, A5, objects…)', auto: false, cols: 16 },
    A1: { label: 'A1 – Animated water', auto: true, cols: 16, rows: 12, kinds: 16 },
    A2: { label: 'A2 – Ground autotiles', auto: true, cols: 16, rows: 12, kinds: 32 },
    A3: { label: 'A3 – Building (roofs/walls)', auto: true, cols: 16, rows: 8, kinds: 32 },
    A4: { label: 'A4 – Walls', auto: true, cols: 16, rows: 15, kinds: 48 }
  };

  // Returns {bx, by, mode} in tile units for an autotile kind, or null.
  function kindInfo(type, k) {
    var tx, ty, bx, by, mode = 'floor';
    if (type === 'A1') {
      if (k === 0) { bx = 0; by = 0; }
      else if (k === 1) { bx = 0; by = 3; }
      else if (k === 2) { bx = 6; by = 0; }
      else if (k === 3) { bx = 6; by = 3; }
      else {
        tx = k % 8; ty = Math.floor(k / 8);
        bx = Math.floor(tx / 4) * 8;
        by = ty * 6 + Math.floor(tx / 2) % 2 * 3;
        if (k % 2 === 1) { bx += 6; mode = 'waterfall'; }
      }
      return { bx: bx, by: by, mode: mode, w: 2, h: mode === 'waterfall' ? 1 : 3 };
    }
    tx = k % 8; ty = Math.floor(k / 8);
    if (type === 'A2') return { bx: tx * 2, by: ty * 3, mode: 'floor', w: 2, h: 3 };
    if (type === 'A3') return { bx: tx * 2, by: ty * 2, mode: 'wall', w: 2, h: 2 };
    if (type === 'A4') {
      by = Math.floor(ty * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
      return ty % 2 === 1
        ? { bx: tx * 2, by: by, mode: 'wall', w: 2, h: 2 }
        : { bx: tx * 2, by: by, mode: 'floor', w: 2, h: 3 };
    }
    return null;
  }

  // Kinds whose source block actually fits inside the (processed) image.
  function validKinds(type, imgW, imgH, ts) {
    var t = TYPES[type], out = [];
    if (!t || !t.auto) return out;
    var cols = Math.floor(imgW / ts), rows = Math.floor(imgH / ts);
    for (var k = 0; k < t.kinds; k++) {
      var info = kindInfo(type, k);
      if (info.bx + info.w <= cols && info.by + info.h <= rows) out.push(k);
    }
    return out;
  }

  // Draws one autotile cell. same(dx, dy) -> true if the neighbour is the same autotile.
  function draw(ctx, img, type, k, dx, dy, ts, same, scale) {
    var info = kindInfo(type, k);
    if (!info) return;
    scale = scale || 1;
    var hs = ts / 2, ds = hs * scale;
    for (var i = 0; i < 4; i++) {
      var sx = i % 2, sy = i >> 1;
      var nx = sx ? 1 : -1, ny = sy ? 1 : -1;
      var h = same(nx, 0), v = same(0, ny);
      var qx = h ? (sx ? 1 : 2) : (sx ? 3 : 0);
      var qy;
      if (info.mode === 'floor') {
        if (h && v && !same(nx, ny)) { qx = 2 + sx; qy = sy; }
        else qy = v ? (sy ? 3 : 4) : (sy ? 5 : 2);
      } else if (info.mode === 'wall') {
        qy = v ? (sy ? 1 : 2) : (sy ? 3 : 0);
      } else {
        qy = sy;
      }
      ctx.drawImage(img,
        (info.bx * 2 + qx) * hs, (info.by * 2 + qy) * hs, hs, hs,
        dx + sx * ds, dy + sy * ds, ds, ds);
    }
  }

  // Guess type from RPG Maker naming (e.g. "Outside_A2.png", "Inside_B").
  function guessType(name) {
    var m = /(?:^|[_\-\s])(A[1-5]|[B-E])(?:[_\-\s.]|$)/i.exec(name.replace(/\.[^.]+$/, '') + '.');
    if (!m) return 'normal';
    var t = m[1].toUpperCase();
    return TYPES[t] ? t : 'normal';
  }

  // Columns RPG Maker uses for a sheet type, to guess the source tile size.
  function sheetCols(name, type) {
    var m = /(?:^|[_\-\s])A5(?:[_\-\s.]|$)/i.exec(name.replace(/\.[^.]+$/, '') + '.');
    if (m) return 8;
    if (type !== 'normal') return 16;
    if (/(?:^|[_\-\s])[B-E](?:[_\-\s.]|$)/i.test(name.replace(/\.[^.]+$/, '') + '.')) return 16;
    return 0;
  }

  window.Autotile = {
    TYPES: TYPES,
    kindInfo: kindInfo,
    validKinds: validKinds,
    draw: draw,
    guessType: guessType,
    sheetCols: sheetCols
  };
})();
