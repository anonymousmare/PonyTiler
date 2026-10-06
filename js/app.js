(function () {
  'use strict';

  var AT = window.Autotile;
  var $ = function (id) { return document.getElementById(id); };
  var MAX_STAMPS = 3;
  var ZOOMS = [0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var S = {
    ts: 32,
    nextId: 1,
    map: { w: 40, h: 30, layers: [] },
    active: 0,
    folders: [],
    tilesets: [],
    tsMap: {},
    selTree: null,
    brush: null,
    prevBrush: null,
    stamps: [],
    walls: null,
    marquee: null,
    tool: 'brush',
    dice: false,
    zoom: 1, ox: 0, oy: 0,
    grid: true, dim: false, axes: true,
    hover: null
  };

  function uid(p) { return p + (S.nextId++); }
  function activeLayer() { return S.map.layers[S.active] || null; }
  function layerById(id) { return id === 'walls' ? S.walls : S.map.layers.find(function (l) { return l.id === id; }); }
  function isAuto(type) { return !!(AT.TYPES[type] && AT.TYPES[type].auto); }
  function cellsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.t === b.t && a.x === b.x && a.y === b.y && a.k === b.k;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  var flashTimer = null;
  function flash(msg) {
    $('statusMsg').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { $('statusMsg').textContent = ''; }, 3500);
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load image')); };
      img.src = src;
    });
  }

  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  }

  function showDialog(dlg) {
    return new Promise(function (resolve) {
      dlg.returnValue = '';
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      });
      dlg.showModal();
    });
  }

  function promptText(title, value) {
    $('promptTitle').textContent = title;
    $('promptInput').value = value || '';
    var p = showDialog($('dlgPrompt'));
    $('promptInput').select();
    return p.then(function (ok) {
      var v = $('promptInput').value.trim();
      return ok && v ? v : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Tilesets
  // ---------------------------------------------------------------------------
  function processTileset(t) {
    var src = t.srcImg;
    var scale = S.ts / t.srcTile;
    var w = Math.round(src.width * scale), h = Math.round(src.height * scale);
    var c = makeCanvas(w, h);
    var ctx = c.getContext('2d');
    var smooth = t.resample === 'smooth' || (t.resample === 'auto' && scale < 1);
    ctx.imageSmoothingEnabled = smooth && scale !== 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    t.img = c;
    t.cols = Math.floor(w / S.ts);
    t.rows = Math.floor(h / S.ts);
    if (isAuto(t.type)) {
      t.kinds = AT.validKinds(t.type, w, h, S.ts);
      t.kindSet = {};
      t.kinds.forEach(function (k) { t.kindSet[k] = true; });
      t.palCols = 8;
      t.palRows = Math.ceil(AT.TYPES[t.type].kinds / 8);
    } else {
      t.palCols = t.cols;
      t.palRows = t.rows;
      t.empty = new Uint8Array(t.cols * t.rows);
      if (t.cols && t.rows) {
        var data = ctx.getImageData(0, 0, t.cols * S.ts, t.rows * S.ts).data, rowLen = t.cols * S.ts * 4;
        for (var ty = 0; ty < t.rows; ty++) {
          for (var tx = 0; tx < t.cols; tx++) {
            var empty = 1;
            for (var y = 0; y < S.ts && empty; y++) {
              var o = (ty * S.ts + y) * rowLen + tx * S.ts * 4 + 3;
              for (var x = 0; x < S.ts; x++, o += 4) if (data[o] !== 0) { empty = 0; break; }
            }
            t.empty[ty * t.cols + tx] = empty;
          }
        }
      }
    }
  }

  function rebuildTsMap() {
    S.tsMap = {};
    S.tilesets.forEach(function (t) { S.tsMap[t.id] = t; });
  }

  // Cell picked from palette grid coordinate, or null.
  function paletteCell(t, px, py) {
    if (px < 0 || py < 0 || px >= t.palCols || py >= t.palRows) return null;
    if (isAuto(t.type)) {
      var k = py * 8 + px;
      return t.kindSet[k] ? { t: t.id, k: k } : null;
    }
    if (t.empty[py * t.cols + px]) return null;
    return { t: t.id, x: px, y: py };
  }

  function addTileset(opts) {
    var t = {
      id: opts.id || uid('t'),
      name: opts.name,
      type: opts.type,
      folder: opts.folder || null,
      src: opts.src,
      srcTile: opts.srcTile,
      resample: opts.resample || 'auto',
      srcImg: opts.srcImg
    };
    processTileset(t);
    S.tilesets.push(t);
    rebuildTsMap();
    return t;
  }

  // ---------------------------------------------------------------------------
  // Layers & cells
  // ---------------------------------------------------------------------------
  function newLayer(name) {
    return {
      id: uid('l'), name: name, visible: true, locked: false, opacity: 1,
      cells: new Array(S.map.w * S.map.h).fill(null), canvas: null, dirty: new Set()
    };
  }

  // Walls are a mask kept beside the layers: a cell is 1 when that tile is marked as wall.
  // They are only drawn while the wall tool is active and are exported as their own PNG.
  function newWallLayer(cells) {
    return { id: 'walls', name: 'Walls', isWall: true, cells: cells || new Array(S.map.w * S.map.h).fill(null), dirty: new Set() };
  }

  // Tiles on a layer named WALLACCESSORY are decorations on walls; the Foundry module keeps them visible.
  function isAccessoryLayer(l) { return l.name.trim().toUpperCase() === 'WALLACCESSORY'; }
  function accessoryMask() {
    var m = new Uint8Array(S.map.w * S.map.h);
    S.map.layers.forEach(function (l) {
      if (!isAccessoryLayer(l)) return;
      for (var i = 0; i < l.cells.length; i++) if (l.cells[i]) m[i] = 1;
    });
    return m;
  }

  function rebuildLayerCanvas(layer) {
    layer.canvas = makeCanvas(S.map.w * S.ts, S.map.h * S.ts);
    layer.ctx = layer.canvas.getContext('2d');
    layer.ctx.imageSmoothingEnabled = false;
    layer.dirty = new Set();
    for (var i = 0; i < layer.cells.length; i++) if (layer.cells[i]) layer.dirty.add(i);
  }

  function rebuildAllCanvases() {
    S.map.layers.forEach(rebuildLayerCanvas);
    rebuildLayerCanvas(S.walls);
    requestRender();
  }

  function sameAt(layer, x, y, c) {
    if (x < 0 || y < 0 || x >= S.map.w || y >= S.map.h) return true; // map edge counts as connected, like RPG Maker
    var o = layer.cells[y * S.map.w + x];
    return !!o && o.t === c.t && o.k === c.k;
  }

  function drawCellTo(ctx, c, dx, dy, scale, same) {
    var t = S.tsMap[c.t];
    if (!t || !t.img) return;
    var ts = S.ts, d = ts * scale;
    if (c.k !== undefined) {
      if (isAuto(t.type)) AT.draw(ctx, t.img, t.type, c.k, dx, dy, ts, same, scale);
    } else if (!isAuto(t.type) && c.x < t.cols && c.y < t.rows) {
      ctx.drawImage(t.img, c.x * ts, c.y * ts, ts, ts, dx, dy, d, d);
    }
  }

  function redrawCell(layer, i) {
    var w = S.map.w, x = i % w, y = (i / w) | 0, ts = S.ts;
    layer.ctx.clearRect(x * ts, y * ts, ts, ts);
    var c = layer.cells[i];
    if (!c) return;
    if (layer.isWall) {
      layer.ctx.fillStyle = '#ff4040';
      layer.ctx.fillRect(x * ts, y * ts, ts, ts);
      return;
    }
    drawCellTo(layer.ctx, c, x * ts, y * ts, 1, function (dx, dy) { return sameAt(layer, x + dx, y + dy, c); });
  }

  function markDirty(layer, x, y) {
    var w = S.map.w, h = S.map.h;
    layer.dirty.add(y * w + x);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
          var n = layer.cells[ny * w + nx];
          if (n && n.k !== undefined) layer.dirty.add(ny * w + nx);
        }
      }
    }
  }

  function flushDirty() {
    S.map.layers.concat(S.walls ? [S.walls] : []).forEach(function (l) {
      if (!l.dirty.size) return;
      l.dirty.forEach(function (i) { redrawCell(l, i); });
      l.dirty.clear();
    });
  }

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------
  var undoStack = [], redoStack = [], stroke = null;

  function setCell(layer, x, y, c) {
    if (x < 0 || y < 0 || x >= S.map.w || y >= S.map.h) return;
    var i = y * S.map.w + x, old = layer.cells[i];
    if (cellsEqual(old, c)) return;
    if (stroke) {
      var key = layer.id + ':' + i;
      var ch = stroke.changes.get(key);
      if (ch) ch.after = c;
      else stroke.changes.set(key, { layerId: layer.id, i: i, before: old, after: c });
    }
    layer.cells[i] = c;
    markDirty(layer, x, y);
  }

  function beginStroke() { stroke = { type: 'cells', changes: new Map() }; }
  function endStroke() {
    if (stroke) stroke.changes.forEach(function (ch, key) { if (cellsEqual(ch.before, ch.after)) stroke.changes.delete(key); });
    if (stroke && stroke.changes.size) {
      undoStack.push(stroke);
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
      changed();
    }
    stroke = null;
    requestRender();
  }

  function snapshot() {
    return {
      w: S.map.w, h: S.map.h, active: S.active, walls: S.walls.cells.slice(),
      layers: S.map.layers.map(function (l) {
        return { id: l.id, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, cells: l.cells.slice() };
      })
    };
  }

  function restore(snap) {
    S.map.w = snap.w; S.map.h = snap.h;
    // Reuse layer objects by id so older cell strokes in the history still find them.
    var byId = {};
    S.map.layers.forEach(function (l) { byId[l.id] = l; });
    S.map.layers = snap.layers.map(function (s) {
      var l = byId[s.id] || { id: s.id, dirty: new Set() };
      l.name = s.name; l.visible = s.visible; l.locked = s.locked; l.opacity = s.opacity;
      l.cells = s.cells.slice();
      return l;
    });
    S.active = Math.min(snap.active, S.map.layers.length - 1);
    S.walls.cells = snap.walls.slice();
    rebuildAllCanvases();
    renderLayers();
    updateStatus();
  }

  // Wrap a structural change so it can be undone as a whole.
  function structural(fn) {
    var before = snapshot();
    fn();
    undoStack.push({ type: 'snap', before: before, after: snapshot() });
    redoStack = [];
    changed();
  }

  function applyCellChanges(st, useBefore) {
    st.changes.forEach(function (ch) {
      var l = layerById(ch.layerId);
      if (!l || ch.i >= l.cells.length) return;
      l.cells[ch.i] = useBefore ? ch.before : ch.after;
      markDirty(l, ch.i % S.map.w, (ch.i / S.map.w) | 0);
    });
  }

  function undo() {
    var st = undoStack.pop();
    if (!st) return flash('Nothing to undo');
    if (st.type === 'cells') applyCellChanges(st, true);
    else restore(st.before);
    redoStack.push(st);
    changed(); requestRender();
  }

  function redo() {
    var st = redoStack.pop();
    if (!st) return flash('Nothing to redo');
    if (st.type === 'cells') applyCellChanges(st, false);
    else restore(st.after);
    undoStack.push(st);
    changed(); requestRender();
  }

  function clearHistory() { undoStack = []; redoStack = []; }

  // ---------------------------------------------------------------------------
  // Painting operations
  // ---------------------------------------------------------------------------
  function diceOn() { return S.dice && S.brush && S.brush.pool.length > 0; }
  function diceCell() { var pool = S.brush.pool; return pool[(Math.random() * pool.length) | 0]; }

  function brushOffset() {
    var b = S.brush;
    return b && !diceOn() ? { x: Math.floor((b.w - 1) / 2), y: Math.floor((b.h - 1) / 2) } : { x: 0, y: 0 };
  }

  function stampAt(layer, tlx, tly) {
    var b = S.brush;
    for (var y = 0; y < b.h; y++) {
      for (var x = 0; x < b.w; x++) {
        var c = b.cells[y * b.w + x];
        if (c) setCell(layer, tlx + x, tly + y, c);
      }
    }
  }

  function lineCells(x0, y0, x1, y1, fn) {
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function paintStep(p) {
    var layer = activeLayer();
    if (drag.mode === 'erase') {
      setCell(layer, p.x, p.y, null);
      return;
    }
    if (diceOn()) {
      var k = p.x + ',' + p.y;
      if (!drag.stamped[k]) { drag.stamped[k] = true; setCell(layer, p.x, p.y, diceCell()); }
      return;
    }
    // Multi-tile brushes snap to a grid anchored at the first stamp so patterns tile cleanly.
    var b = S.brush, off = brushOffset();
    var tlx = p.x - off.x, tly = p.y - off.y;
    tlx = drag.ax + Math.floor((tlx - drag.ax) / b.w) * b.w;
    tly = drag.ay + Math.floor((tly - drag.ay) / b.h) * b.h;
    var key = tlx + ',' + tly;
    if (drag.stamped[key]) return;
    drag.stamped[key] = true;
    stampAt(layer, tlx, tly);
  }

  function patternCell(x, y, ox, oy) {
    if (diceOn()) return diceCell();
    var b = S.brush;
    var bx = ((x - ox) % b.w + b.w) % b.w, by = ((y - oy) % b.h + b.h) % b.h;
    return b.cells[by * b.w + bx];
  }

  function floodFill(p, erase) {
    var layer = activeLayer(), w = S.map.w, h = S.map.h;
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) return;
    if (!erase && !S.brush) return flash('Pick a tile from the palette first');
    var target = layer.cells[p.y * w + p.x];
    var seen = new Uint8Array(w * h), stack = [p.y * w + p.x], region = [];
    seen[stack[0]] = 1;
    while (stack.length) {
      var i = stack.pop(), x = i % w, y = (i / w) | 0;
      region.push(i);
      var nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (var n = 0; n < 4; n++) {
        var j = nb[n];
        if (j >= 0 && !seen[j] && cellsEqual(layer.cells[j], target)) { seen[j] = 1; stack.push(j); }
      }
    }
    beginStroke();
    region.forEach(function (i) {
      var x = i % w, y = (i / w) | 0;
      if (erase) setCell(layer, x, y, null);
      else {
        var c = patternCell(x, y, p.x, p.y);
        if (c) setCell(layer, x, y, c);
      }
    });
    endStroke();
  }

  function fillRect(r, erase) {
    var layer = activeLayer();
    var x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
    var y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
    if (!erase && !S.brush) return flash('Pick a tile from the palette first');
    beginStroke();
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (erase) setCell(layer, x, y, null);
        else {
          var c = patternCell(x, y, x0, y0);
          if (c) setCell(layer, x, y, c);
        }
      }
    }
    endStroke();
  }

  function pick(p) {
    if (p.x < 0 || p.y < 0 || p.x >= S.map.w || p.y >= S.map.h) return;
    var i = p.y * S.map.w + p.x;
    for (var li = S.map.layers.length - 1; li >= 0; li--) {
      var l = S.map.layers[li];
      if (!l.visible || !l.cells[i]) continue;
      var c = l.cells[i], t = S.tsMap[c.t];
      if (!t) continue;
      var px = c.k !== undefined ? c.k % 8 : c.x, py = c.k !== undefined ? Math.floor(c.k / 8) : c.y;
      var P = palettes[1].tsId === t.id ? palettes[1] : palettes[0];
      if (P === palettes[0]) selectTileset(t.id, true);
      palettes.forEach(function (q) { q.sels = []; });
      P.sels = [{ x0: px, y0: py, x1: px, y1: py }];
      S.lastPal = P;
      buildBrushFromPalettes();
      setTool('brush');
      flash('Picked from layer "' + l.name + '"');
      return;
    }
    flash('Nothing to pick here');
  }

  // ---------------------------------------------------------------------------
  // Map view
  // ---------------------------------------------------------------------------
  var view = $('viewport'), canvas = $('mapCanvas'), ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var renderQueued = false, drag = null, spaceDown = false;

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; render(); });
  }

  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(view.clientWidth * dpr);
    canvas.height = Math.round(view.clientHeight * dpr);
    requestRender();
  }

  function screenToTile(e) {
    var r = canvas.getBoundingClientRect();
    var sx = e.clientX - r.left, sy = e.clientY - r.top;
    var d = S.ts * S.zoom;
    return { x: Math.floor((sx - S.ox) / d), y: Math.floor((sy - S.oy) / d) };
  }

  function render() {
    flushDirty();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#15161a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    var d = S.ts * S.zoom, mw = S.map.w * d, mh = S.map.h * d;
    var ox = Math.round(S.ox * dpr) / dpr, oy = Math.round(S.oy * dpr) / dpr;

    ctx.fillStyle = checkerPattern();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillRect(0, 0, mw, mh);
    ctx.restore();

    S.map.layers.forEach(function (l, i) {
      if (!l.visible) return;
      ctx.globalAlpha = l.opacity * (S.dim && i !== S.active ? 0.3 : 1);
      ctx.drawImage(l.canvas, ox, oy, mw, mh);
    });
    ctx.globalAlpha = 1;
    if (S.tool === 'wall') drawWalls(ox, oy, d);

    if (S.grid && d >= 6) {
      ctx.beginPath();
      var px = 1 / dpr;
      for (var x = 0; x <= S.map.w; x++) { var gx = ox + x * d; ctx.rect(gx, oy, px, mh); }
      for (var y = 0; y <= S.map.h; y++) { var gy = oy + y * d; ctx.rect(ox, gy, mw, px); }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(200,111,216,0.6)';
    ctx.lineWidth = 1 / dpr;
    ctx.strokeRect(ox, oy, mw, mh);

    drawOverlay(ox, oy, d);
    drawAxes(ox, oy, d);
  }

  function drawWalls(ox, oy, d) {
    ctx.globalAlpha = 0.5;
    ctx.drawImage(S.walls.canvas, ox, oy, S.map.w * d, S.map.h * d);
    ctx.globalAlpha = 1;
    // Tiles on a WALLACCESSORY layer get a yellow frame so it's clear the wall's vision blocker will avoid them.
    var acc = accessoryMask(), w = S.map.w, in2 = Math.max(1, d * 0.12);
    ctx.lineWidth = Math.max(1, d * 0.08);
    ctx.strokeStyle = '#ffd166';
    for (var i = 0; i < acc.length; i++) {
      if (acc[i]) ctx.strokeRect(ox + (i % w) * d + in2, oy + ((i / w) | 0) * d + in2, d - 2 * in2, d - 2 * in2);
    }
  }

  // Tile coordinates along the top and left edges of the map; they stick to the viewport edge when scrolled.
  var AXIS_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  function axisStep(d, minPx) {
    for (var i = 0; i < AXIS_STEPS.length; i++) if (AXIS_STEPS[i] * d >= minPx) return AXIS_STEPS[i];
    return AXIS_STEPS[AXIS_STEPS.length - 1];
  }

  function drawAxes(ox, oy, d) {
    if (!S.axes) return;
    var vw = view.clientWidth, vh = view.clientHeight, mw = S.map.w * d, mh = S.map.h * d;
    var th = 16, lw = 8 + 7 * String(S.map.h - 1).length;
    var ty = Math.max(0, Math.min(vh - th, oy - th)), lx = Math.max(0, Math.min(vw - lw, ox - lw));
    var hx = S.hover && S.hover.x >= 0 && S.hover.x < S.map.w ? S.hover.x : -1;
    var hy = S.hover && S.hover.y >= 0 && S.hover.y < S.map.h ? S.hover.y : -1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    var x0 = Math.max(ox, lx + lw), x1 = Math.min(ox + mw, vw);
    if (x1 > x0) {
      ctx.fillStyle = 'rgba(30,31,36,0.85)';
      ctx.fillRect(x0, ty, x1 - x0, th);
      var sx = axisStep(d, 8 + 7 * String(S.map.w - 1).length);
      var first = Math.max(0, Math.floor((x0 - ox) / d)), last = Math.min(S.map.w - 1, Math.ceil((x1 - ox) / d));
      for (var x = first; x <= last; x++) {
        if (x % sx && x !== hx) continue;
        var cx = ox + (x + 0.5) * d;
        if (cx < x0 || cx > x1) continue;
        ctx.fillStyle = x === hx ? '#e9a6f5' : '#9095a3';
        ctx.fillText(String(x), cx, ty + th / 2);
      }
    }
    var y0 = Math.max(oy, ty + th), y1 = Math.min(oy + mh, vh);
    if (y1 > y0) {
      ctx.fillStyle = 'rgba(30,31,36,0.85)';
      ctx.fillRect(lx, y0, lw, y1 - y0);
      var sy = axisStep(d, 14);
      var firstY = Math.max(0, Math.floor((y0 - oy) / d)), lastY = Math.min(S.map.h - 1, Math.ceil((y1 - oy) / d));
      for (var y = firstY; y <= lastY; y++) {
        if (y % sy && y !== hy) continue;
        var cy = oy + (y + 0.5) * d;
        if (cy < y0 || cy > y1) continue;
        ctx.fillStyle = y === hy ? '#e9a6f5' : '#9095a3';
        ctx.fillText(String(y), lx + lw / 2, cy);
      }
    }
    ctx.fillStyle = 'rgba(30,31,36,0.95)';
    ctx.fillRect(lx, ty, lw, th);
  }

  var checker = null;
  function checkerPattern() {
    if (!checker) {
      var c = makeCanvas(16, 16), g = c.getContext('2d');
      g.fillStyle = '#2b2d35'; g.fillRect(0, 0, 16, 16);
      g.fillStyle = '#25272e'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
      checker = ctx.createPattern(c, 'repeat');
    }
    return checker;
  }

  function normRect(r) {
    var x0 = Math.max(0, Math.min(r.x0, r.x1)), y0 = Math.max(0, Math.min(r.y0, r.y1));
    var x1 = Math.min(S.map.w - 1, Math.max(r.x0, r.x1)), y1 = Math.min(S.map.h - 1, Math.max(r.y0, r.y1));
    if (x1 < x0 || y1 < y0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function dashed(x, y, w, h, color) {
    outline(x, y, w, h, color);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -(performance.now() / 60) % 8;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawOverlay(ox, oy, d) {
    var m = S.marquee;
    if (drag && drag.mode === 'move') {
      ctx.globalAlpha = 0.9;
      for (var my = 0; my < m.h; my++) for (var mx = 0; mx < m.w; mx++) {
        var mc = drag.cells[my * m.w + mx];
        if (mc) drawCellTo(ctx, mc, ox + (m.x + drag.dx + mx) * d, oy + (m.y + drag.dy + my) * d, S.zoom, noSame);
      }
      ctx.globalAlpha = 1;
      dashed(ox + (m.x + drag.dx) * d, oy + (m.y + drag.dy) * d, m.w * d, m.h * d, '#7fd8ff');
      return;
    }
    if (m) dashed(ox + m.x * d, oy + m.y * d, m.w * d, m.h * d, '#7fd8ff');
    if (drag && (drag.mode === 'select' || drag.mode === 'grab')) {
      var r = normRect(drag);
      if (r) dashed(ox + r.x * d, oy + r.y * d, r.w * d, r.h * d, drag.mode === 'grab' ? '#ffd166' : '#7fd8ff');
      return;
    }
    if (drag && drag.mode === 'wallrect') {
      var wr = normRect(drag);
      if (wr) {
        if (drag.val) { ctx.fillStyle = 'rgba(255,64,64,0.4)'; ctx.fillRect(ox + wr.x * d, oy + wr.y * d, wr.w * d, wr.h * d); }
        outline(ox + wr.x * d, oy + wr.y * d, wr.w * d, wr.h * d, drag.val ? '#ff4040' : '#ffffff');
      }
      return;
    }
    if (drag && drag.mode === 'rect') {
      var x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
      var w = Math.abs(drag.x1 - drag.x0) + 1, h = Math.abs(drag.y1 - drag.y0) + 1;
      if (!drag.erase && S.brush && !diceOn()) {
        ctx.globalAlpha = 0.6;
        for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
          var c = patternCell(x0 + xx, y0 + yy, x0, y0);
          if (c) drawCellTo(ctx, c, ox + (x0 + xx) * d, oy + (y0 + yy) * d, S.zoom, noSame);
        }
        ctx.globalAlpha = 1;
      }
      outline(ox + x0 * d, oy + y0 * d, w * d, h * d, drag.erase ? '#ff6b6b' : '#ffffff');
      return;
    }
    var p = S.hover;
    if (!p || (drag && drag.mode === 'pan')) return;
    var erasing = S.tool === 'eraser' || (drag && drag.mode === 'erase');
    if (S.tool === 'brush' && S.brush && !erasing && !diceOn()) {
      var b = S.brush, off = brushOffset();
      var tlx = p.x - off.x, tly = p.y - off.y;
      ctx.globalAlpha = 0.65;
      for (var y = 0; y < b.h; y++) for (var x = 0; x < b.w; x++) {
        var cc = b.cells[y * b.w + x];
        if (cc) drawCellTo(ctx, cc, ox + (tlx + x) * d, oy + (tly + y) * d, S.zoom, noSame);
      }
      ctx.globalAlpha = 1;
      outline(ox + tlx * d, oy + tly * d, b.w * d, b.h * d, '#ffffff');
    } else {
      outline(ox + p.x * d, oy + p.y * d, d, d, erasing ? '#ff6b6b' : S.tool === 'select' ? '#7fd8ff' : S.tool === 'wall' ? '#ff4040' : '#ffffff');
    }
  }

  // Marching ants need a steady redraw while a selection is visible.
  (function antsLoop() {
    if (S.marquee || (drag && (drag.mode === 'select' || drag.mode === 'grab' || drag.mode === 'move'))) requestRender();
    setTimeout(antsLoop, 120);
  })();

  function noSame() { return false; }

  function outline(x, y, w, h, color) {
    ctx.lineWidth = 2 / dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(x - 1 / dpr, y - 1 / dpr, w + 2 / dpr, h + 2 / dpr);
    ctx.lineWidth = 1 / dpr;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
  }

  function setZoom(z, cx, cy) {
    z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    if (cx === undefined) { cx = view.clientWidth / 2; cy = view.clientHeight / 2; }
    S.ox = cx - (cx - S.ox) * z / S.zoom;
    S.oy = cy - (cy - S.oy) * z / S.zoom;
    S.zoom = z;
    $('zoomLabel').textContent = Math.round(z * 100) + '%';
    requestRender();
  }

  function stepZoom(dir, cx, cy) {
    var i = 0;
    while (i < ZOOMS.length && ZOOMS[i] < S.zoom - 1e-6) i++;
    if (dir > 0) i = ZOOMS[i] > S.zoom + 1e-6 ? i : i + 1;
    else i = i - 1;
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i))], cx, cy);
  }

  function actualSize() {
    S.zoom = 1;
    S.ox = Math.round((view.clientWidth - S.map.w * S.ts) / 2);
    S.oy = Math.round((view.clientHeight - S.map.h * S.ts) / 2);
    $('zoomLabel').textContent = '100%';
    requestRender();
  }

  function fitView() {
    var vw = view.clientWidth - 40, vh = view.clientHeight - 40;
    var fit = Math.min(vw / (S.map.w * S.ts), vh / (S.map.h * S.ts));
    var z = ZOOMS[0];
    ZOOMS.forEach(function (v) { if (v <= fit) z = v; });
    S.zoom = z;
    S.ox = Math.round((view.clientWidth - S.map.w * S.ts * z) / 2);
    S.oy = Math.round((view.clientHeight - S.map.h * S.ts * z) / 2);
    $('zoomLabel').textContent = Math.round(z * 100) + '%';
    requestRender();
  }

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('pointerdown', function (e) {
    if (drag) return;
    canvas.setPointerCapture(e.pointerId);
    var p = screenToTile(e);
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: S.ox, oy: S.oy };
      canvas.style.cursor = 'grabbing';
      return;
    }
    // Wall tool: left marks walls, right clears them, Shift+drag does a rectangle.
    if (S.tool === 'wall' && (e.button === 0 || e.button === 2)) {
      var val = e.button === 0 ? 1 : null;
      if (e.shiftKey) drag = { mode: 'wallrect', val: val, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      else {
        drag = { mode: 'wall', val: val, last: p };
        beginStroke();
        setCell(S.walls, p.x, p.y, val);
      }
      requestRender();
      return;
    }
    var layer = activeLayer();
    if (e.button === 2) {
      if (!layer) return flash('Add a layer first');
      drag = { mode: 'grab', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      requestRender();
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey || S.tool === 'picker') return pick(p);

    if (!layer) return flash('Add a layer first');
    var m = S.marquee;
    if (S.tool === 'select' && !(m && p.x >= m.x && p.y >= m.y && p.x < m.x + m.w && p.y < m.y + m.h)) {
      S.marquee = null;
      drag = { mode: 'select', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      requestRender();
      return;
    }
    if (!layer.visible) return flash('Layer "' + layer.name + '" is hidden');
    if (layer.locked) return flash('Layer "' + layer.name + '" is locked');

    if (S.tool === 'select') return startMove(layer, p);
    if (S.tool === 'fill') return floodFill(p, false);
    if (S.tool === 'rect') {
      drag = { mode: 'rect', erase: false, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      requestRender();
      return;
    }
    var erase = S.tool === 'eraser';
    if (!erase && !S.brush) return flash('Pick a tile from the palette first');
    var off = brushOffset();
    drag = { mode: erase ? 'erase' : 'paint', last: p, ax: p.x - off.x, ay: p.y - off.y, stamped: {} };
    beginStroke();
    paintStep(p);
    requestRender();
  });

  canvas.addEventListener('pointermove', function (e) {
    var p = screenToTile(e);
    var inMap = p.x >= 0 && p.y >= 0 && p.x < S.map.w && p.y < S.map.h;
    $('statusPos').textContent = inMap ? 'x ' + p.x + ', y ' + p.y : '–';
    if (!S.hover || S.hover.x !== p.x || S.hover.y !== p.y) { S.hover = p; requestRender(); }
    if (!drag) return;
    if (drag.mode === 'pan') {
      S.ox = drag.ox + e.clientX - drag.sx;
      S.oy = drag.oy + e.clientY - drag.sy;
      requestRender();
    } else if (drag.mode === 'rect' || drag.mode === 'select' || drag.mode === 'grab' || drag.mode === 'wallrect') {
      if (drag.x1 !== p.x || drag.y1 !== p.y) { drag.x1 = p.x; drag.y1 = p.y; requestRender(); }
    } else if (drag.mode === 'move') {
      var dx = p.x - drag.sx, dy = p.y - drag.sy;
      if (dx !== drag.dx || dy !== drag.dy) { drag.dx = dx; drag.dy = dy; requestRender(); }
    } else if (drag.last.x !== p.x || drag.last.y !== p.y) {
      var wd = drag;
      lineCells(drag.last.x, drag.last.y, p.x, p.y, function (x, y) {
        if (wd.mode === 'wall') setCell(S.walls, x, y, wd.val);
        else paintStep({ x: x, y: y });
      });
      drag.last = p;
      requestRender();
    }
  });

  function endDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    canvas.style.cursor = spaceDown ? 'grab' : '';
    if (d.mode === 'rect') fillRect(d, d.erase);
    else if (d.mode === 'paint' || d.mode === 'erase' || d.mode === 'wall') endStroke();
    else if (d.mode === 'wallrect') {
      var wr = normRect(d);
      if (wr) {
        beginStroke();
        for (var y = wr.y; y < wr.y + wr.h; y++) for (var x = wr.x; x < wr.x + wr.w; x++) setCell(S.walls, x, y, d.val);
        endStroke();
      }
    }
    else if (d.mode === 'select') S.marquee = normRect(d);
    else if (d.mode === 'grab') { var r = normRect(d); if (r) captureStamp(r); }
    else if (d.mode === 'move') finishMove(d);
    requestRender();
  }

  // Lift the selected cells off the active layer; they're put down again in finishMove.
  function startMove(layer, p) {
    var m = S.marquee, cells = [];
    beginStroke();
    for (var y = 0; y < m.h; y++) for (var x = 0; x < m.w; x++) {
      cells.push(layer.cells[(m.y + y) * S.map.w + m.x + x]);
      setCell(layer, m.x + x, m.y + y, null);
    }
    drag = { mode: 'move', layer: layer, cells: cells, sx: p.x, sy: p.y, dx: 0, dy: 0 };
    requestRender();
  }

  function finishMove(d) {
    var m = S.marquee;
    for (var y = 0; y < m.h; y++) for (var x = 0; x < m.w; x++) {
      var c = d.cells[y * m.w + x];
      if (c) setCell(d.layer, m.x + d.dx + x, m.y + d.dy + y, c);
    }
    endStroke();
    S.marquee = normRect({ x0: m.x + d.dx, y0: m.y + d.dy, x1: m.x + d.dx + m.w - 1, y1: m.y + d.dy + m.h - 1 });
  }

  function clearMarquee() {
    var m = S.marquee, layer = activeLayer();
    if (!m || !layer) return;
    if (layer.locked) return flash('Layer "' + layer.name + '" is locked');
    beginStroke();
    for (var y = 0; y < m.h; y++) for (var x = 0; x < m.w; x++) setCell(layer, m.x + x, m.y + y, null);
    endStroke();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', function () { if (!drag) { S.hover = null; requestRender(); } });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      stepZoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    } else {
      S.ox -= e.deltaY; requestRender();
    }
  }, { passive: false });

  new ResizeObserver(resizeCanvas).observe(view);

  // ---------------------------------------------------------------------------
  // Palette
  // ---------------------------------------------------------------------------
  // Two palettes: the left one follows the tileset list, the right one takes whatever is dropped on it.
  function makePalette(ids) {
    var P = {
      tsId: null, sels: [], drag: false,
      canvas: $(ids.canvas), wrap: $(ids.wrap), zoomSel: $(ids.zoom), title: $(ids.title), emptyEl: $(ids.empty), label: ids.label
    };
    P.ctx = P.canvas.getContext('2d');

    function clampPos(e) {
      var t = S.tsMap[P.tsId], r = P.canvas.getBoundingClientRect(), d = S.ts * palZoom(P);
      return {
        x: Math.max(0, Math.min(t.palCols - 1, Math.floor((e.clientX - r.left) / d))),
        y: Math.max(0, Math.min(t.palRows - 1, Math.floor((e.clientY - r.top) / d)))
      };
    }
    P.canvas.addEventListener('pointerdown', function (e) {
      if (!S.tsMap[P.tsId] || e.button !== 0) return;
      P.canvas.setPointerCapture(e.pointerId);
      var p = clampPos(e);
      // Ctrl/Shift adds another rectangle to the selection (handy with the dice).
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) palettes.forEach(function (q) { q.sels = []; renderPalette(q); });
      P.sels.push({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      P.drag = true;
      S.lastPal = P;
      renderPalette(P);
    });
    P.canvas.addEventListener('pointermove', function (e) {
      if (!P.drag) return;
      var p = clampPos(e), s = P.sels[P.sels.length - 1];
      if (p.x !== s.x1 || p.y !== s.y1) { s.x1 = p.x; s.y1 = p.y; renderPalette(P); }
    });
    P.canvas.addEventListener('pointerup', function () {
      if (!P.drag) return;
      P.drag = false;
      buildBrushFromPalettes();
      if (S.tool !== 'fill' && S.tool !== 'rect') setTool('brush');
    });
    P.zoomSel.addEventListener('change', function () { renderPalette(P); });
    new ResizeObserver(function () { if (P.zoomSel.value === 'fit') renderPalette(P); }).observe(P.wrap);

    // Tilesets can be dragged from the list straight onto a palette.
    P.wrap.addEventListener('dragover', function (e) {
      if (!e.dataTransfer.types.includes('application/x-ponytiler')) return;
      e.preventDefault();
      P.wrap.classList.add('drop');
    });
    P.wrap.addEventListener('dragleave', function () { P.wrap.classList.remove('drop'); });
    P.wrap.addEventListener('drop', function (e) {
      P.wrap.classList.remove('drop');
      var data = e.dataTransfer.getData('application/x-ponytiler');
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      var parts = data.split(':');
      if (parts[0] !== 'ts') return flash('Drop a tileset, not a folder');
      if (P === palettes[0]) selectTileset(parts[1]);
      else showInPalette(P, parts[1]);
      changed(true);
    });
    return P;
  }

  var palettes = [
    makePalette({ canvas: 'palette', wrap: 'paletteWrap', zoom: 'paletteZoom', title: 'paletteTitle', empty: 'paletteEmpty', label: 'Palette' }),
    makePalette({ canvas: 'palette2', wrap: 'paletteWrap2', zoom: 'paletteZoom2', title: 'paletteTitle2', empty: 'paletteEmpty2', label: 'Palette 2' })
  ];

  function showInPalette(P, id) {
    if (P.tsId !== id) P.sels = [];
    P.tsId = id;
    renderPalette(P);
  }

  function renderPalettes() { palettes.forEach(renderPalette); }

  function palZoom(P) {
    var v = P.zoomSel.value, t = S.tsMap[P.tsId];
    if (v === 'fit' && t) return Math.max(0.25, (P.wrap.clientWidth - 2) / (t.palCols * S.ts));
    return parseFloat(v) || 1;
  }

  function renderPalette(P) {
    var t = S.tsMap[P.tsId], pal = P.canvas, palCtx = P.ctx;
    P.emptyEl.hidden = !!t;
    pal.hidden = !t;
    P.title.textContent = t ? P.label + ' — ' + t.name : P.label;
    if (!t) return;
    var z = palZoom(P), ts = S.ts, d = ts * z;
    pal.width = Math.max(1, Math.round(t.palCols * d));
    pal.height = Math.max(1, Math.round(t.palRows * d));
    palCtx.imageSmoothingEnabled = false;
    palCtx.fillStyle = '#202127';
    palCtx.fillRect(0, 0, pal.width, pal.height);
    if (isAuto(t.type)) {
      t.kinds.forEach(function (k) {
        AT.draw(palCtx, t.img, t.type, k, (k % 8) * d, Math.floor(k / 8) * d, ts, noSame, z);
      });
    } else {
      palCtx.drawImage(t.img, 0, 0, t.cols * ts, t.rows * ts, 0, 0, t.cols * d, t.rows * d);
    }
    palCtx.fillStyle = 'rgba(255,255,255,0.08)';
    for (var x = 1; x < t.palCols; x++) palCtx.fillRect(Math.round(x * d), 0, 1, pal.height);
    for (var y = 1; y < t.palRows; y++) palCtx.fillRect(0, Math.round(y * d), pal.width, 1);
    P.sels.forEach(function (s) {
      var x0 = Math.min(s.x0, s.x1), y0 = Math.min(s.y0, s.y1);
      var w = Math.abs(s.x1 - s.x0) + 1, h = Math.abs(s.y1 - s.y0) + 1;
      palCtx.fillStyle = 'rgba(200,111,216,0.25)';
      palCtx.fillRect(x0 * d, y0 * d, w * d, h * d);
      palCtx.lineWidth = 2;
      palCtx.strokeStyle = '#e9a6f5';
      palCtx.strokeRect(x0 * d + 1, y0 * d + 1, w * d - 2, h * d - 2);
    });
  }

  // ---------------------------------------------------------------------------
  // Brushes & stamps
  // ---------------------------------------------------------------------------
  // A brush is the last palette rectangle (or a stamp); its pool is every tile selected, used by the dice.
  function makeBrush(w, h, cells, name, type, pool) {
    pool = pool || cells.filter(Boolean);
    if (!pool.length) return null;
    return { w: w, h: h, cells: cells, name: name, type: type, pool: pool };
  }

  function rectCells(t, s) {
    var x0 = Math.min(s.x0, s.x1), y0 = Math.min(s.y0, s.y1);
    var w = Math.abs(s.x1 - s.x0) + 1, h = Math.abs(s.y1 - s.y0) + 1, cells = [];
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) cells.push(paletteCell(t, x0 + x, y0 + y));
    return { w: w, h: h, cells: cells };
  }

  function buildBrushFromPalettes() {
    var pool = [], last = null, lastT = null, n = 0;
    palettes.forEach(function (P) {
      var t = S.tsMap[P.tsId];
      if (!t) return;
      P.sels.forEach(function (s) {
        var r = rectCells(t, s);
        n++;
        r.cells.forEach(function (c) { if (c) pool.push(c); });
        if (P === S.lastPal || !last) { last = r; lastT = t; }
      });
    });
    var b = last ? makeBrush(last.w, last.h, last.cells, n > 1 ? n + ' selections' : lastT.name, lastT.type, pool) : null;
    if (b) b.src = palettes.map(function (P) { return { ts: P.tsId, sels: P.sels.map(function (s) { return Object.assign({}, s); }) }; });
    setBrush(b);
  }

  function setBrush(b) {
    if (S.brush && S.brush !== b) S.prevBrush = S.brush;
    S.brush = b;
    // Restore the palette highlight that belongs to this brush (stamps and "none" clear it).
    palettes.forEach(function (P, i) {
      var src = b && b.src && b.src[i];
      P.sels = src && src.ts === P.tsId ? src.sels.map(function (s) { return Object.assign({}, s); }) : [];
    });
    renderPalettes();
    renderBrushInfo();
    renderStamps();
    requestRender();
  }

  function swapBrush() {
    if (!S.prevBrush) return flash('No previous brush');
    var b = S.prevBrush;
    if (S.tool !== 'fill' && S.tool !== 'rect') setTool('brush');
    setBrush(b);
  }

  function renderBrushInfo() {
    var b = S.brush;
    $('statusBrush').textContent = !b ? 'No brush' :
      'Brush: ' + (b.stampId ? 'stamp ' : '') + b.w + '×' + b.h + ' · ' + b.name + (isAuto(b.type) ? ' (autotile)' : '') +
      (S.dice ? ' · 🎲 ' + b.pool.length + ' tiles' : '');
  }

  function captureStamp(r) {
    var layer = activeLayer(), cells = [];
    for (var y = 0; y < r.h; y++) for (var x = 0; x < r.w; x++) cells.push(layer.cells[(r.y + y) * S.map.w + r.x + x] || null);
    if (!cells.some(Boolean)) return flash('Nothing on layer "' + layer.name + '" there');
    var st = { id: uid('s'), w: r.w, h: r.h, cells: cells };
    S.stamps.unshift(st);
    if (S.stamps.length > MAX_STAMPS) S.stamps.length = MAX_STAMPS;
    useStamp(st);
    if (S.tool !== 'fill' && S.tool !== 'rect') setTool('brush');
    flash('Saved a ' + r.w + '×' + r.h + ' stamp');
    changed();
  }

  function useStamp(st) {
    var first = st.cells.find(Boolean), t = first && S.tsMap[first.t];
    var b = makeBrush(st.w, st.h, st.cells, t ? t.name : '?', t ? t.type : 'normal');
    if (!b) return;
    b.stampId = st.id;
    setBrush(b);
  }

  function renderStamps() {
    var box = $('stamps');
    box.innerHTML = '';
    if (!S.stamps.length) {
      box.innerHTML = '<div class="empty">Right-drag on the map to save a stamp.</div>';
      return;
    }
    S.stamps.forEach(function (st) {
      var el = document.createElement('div');
      el.className = 'stamp' + (S.brush && S.brush.stampId === st.id ? ' active' : '');
      el.title = st.w + '×' + st.h + ' stamp';
      var z = Math.min(48 / (st.w * S.ts), 48 / (st.h * S.ts));
      var c = makeCanvas(Math.round(st.w * S.ts * z), Math.round(st.h * S.ts * z)), g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      for (var y = 0; y < st.h; y++) for (var x = 0; x < st.w; x++) {
        var cell = st.cells[y * st.w + x];
        if (cell) drawCellTo(g, cell, x * S.ts * z, y * S.ts * z, z, noSame);
      }
      el.appendChild(c);
      el.appendChild(actBtn('✕', 'Delete stamp', function () {
        S.stamps = S.stamps.filter(function (x) { return x !== st; });
        renderStamps();
        changed();
      }));
      el.addEventListener('click', function () {
        useStamp(st);
        if (S.tool !== 'fill' && S.tool !== 'rect') setTool('brush');
      });
      box.appendChild(el);
    });
  }

  function brushUses(b, tid) {
    return !!b && b.pool.some(function (c) { return c.t === tid; });
  }

  // ---------------------------------------------------------------------------
  // Folder tree
  // ---------------------------------------------------------------------------
  var tree = $('tree');

  function folderPath(id) {
    var parts = [], f = S.folders.find(function (x) { return x.id === id; });
    while (f) {
      parts.unshift(f.name);
      var pid = f.parent;
      f = S.folders.find(function (x) { return x.id === pid; });
    }
    return parts.join(' / ');
  }

  function byName(a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); }

  function selectTileset(id, reveal) {
    S.selTree = { kind: 'ts', id: id };
    if (reveal) {
      var t = S.tsMap[id], fid = t && t.folder;
      while (fid) {
        var f = S.folders.find(function (x) { return x.id === fid; });
        if (!f) break;
        f.open = true;
        fid = f.parent;
      }
    }
    if (reveal) renderTree();
    else tree.querySelectorAll('.node').forEach(function (n) { n.classList.toggle('selected', n.dataset.ts === id); });
    showInPalette(palettes[0], id);
  }

  function renderTree() {
    tree.innerHTML = '';
    var q = $('assetSearch').value.trim().toLowerCase();
    if (q) {
      S.tilesets.filter(function (t) { return t.name.toLowerCase().indexOf(q) >= 0; }).sort(byName).forEach(function (t) {
        var n = tsNode(t, 0);
        if (t.folder) n.title = folderPath(t.folder);
        tree.appendChild(n);
      });
      if (!tree.children.length) tree.innerHTML = '<div class="empty">No matches</div>';
      return;
    }
    (function walk(parent, depth) {
      S.folders.filter(function (f) { return f.parent === parent; }).sort(byName).forEach(function (f) {
        tree.appendChild(folderNode(f, depth));
        if (f.open) walk(f.id, depth + 1);
      });
      S.tilesets.filter(function (t) { return t.folder === parent; }).sort(byName).forEach(function (t) {
        tree.appendChild(tsNode(t, depth));
      });
    })(null, 0);
    var root = document.createElement('div');
    root.className = 'root-drop';
    root.textContent = S.tilesets.length || S.folders.length ? 'Drop here to move to top level' : 'No tilesets yet — click "+ Import images" or drop PNGs anywhere.';
    makeDropTarget(root, null);
    tree.appendChild(root);
  }

  function countIn(fid) {
    var n = S.tilesets.filter(function (t) { return t.folder === fid; }).length;
    S.folders.forEach(function (f) { if (f.parent === fid) n += countIn(f.id); });
    return n;
  }

  function nodeBase(depth, kind, id) {
    var n = document.createElement('div');
    n.className = 'node';
    n.style.paddingLeft = (4 + depth * 14) + 'px';
    n.draggable = true;
    n.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('application/x-ponytiler', kind + ':' + id);
      e.dataTransfer.effectAllowed = 'move';
    });
    if (S.selTree && S.selTree.kind === kind && S.selTree.id === id) n.classList.add('selected');
    return n;
  }

  function actBtn(label, title, fn) {
    var b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }

  function folderNode(f, depth) {
    var n = nodeBase(depth, 'folder', f.id);
    n.innerHTML = '<span class="caret">' + (f.open ? '▾' : '▸') + '</span><span class="icon">📁</span>';
    var name = document.createElement('span');
    name.className = 'name'; name.textContent = f.name;
    var tag = document.createElement('span');
    tag.className = 'tag'; tag.textContent = countIn(f.id);
    var acts = document.createElement('span');
    acts.className = 'acts';
    acts.append(
      actBtn('+', 'New subfolder', function () { createFolder(f.id); }),
      actBtn('✎', 'Rename', function () { renameFolder(f); }),
      actBtn('🗑', 'Delete folder (contents move up)', function () { deleteFolder(f); })
    );
    n.append(name, tag, acts);
    n.addEventListener('click', function (e) {
      f.open = !f.open;
      S.selTree = { kind: 'folder', id: f.id };
      renderTree();
      changed(true);
      // The tree is rebuilt on every click, so a double-click is caught here instead of via 'dblclick'.
      if (e.detail === 2) { f.open = !f.open; renderTree(); renameFolder(f); }
    });
    makeDropTarget(n, f.id);
    return n;
  }

  function tsNode(t, depth) {
    var n = nodeBase(depth, 'ts', t.id);
    n.innerHTML = '<span class="caret"></span>';
    var icon = document.createElement('canvas');
    icon.className = 'icon';
    icon.width = 16; icon.height = 16;
    var g = icon.getContext('2d');
    g.imageSmoothingEnabled = false;
    var c = isAuto(t.type) ? (t.kinds.length ? { t: t.id, k: t.kinds[0] } : null) : firstTile(t);
    if (c) drawCellTo(g, c, 0, 0, 16 / S.ts, noSame);
    var name = document.createElement('span');
    name.className = 'name'; name.textContent = t.name;
    var tag = document.createElement('span');
    tag.className = 'tag'; tag.textContent = t.type === 'normal' ? t.cols + '×' + t.rows : t.type;
    var acts = document.createElement('span');
    acts.className = 'acts';
    acts.append(
      actBtn('⚙', 'Settings', function () { editTileset(t); }),
      actBtn('🗑', 'Delete tileset', function () { deleteTileset(t); })
    );
    n.dataset.ts = t.id;
    n.append(icon, name, tag, acts);
    n.addEventListener('click', function () { selectTileset(t.id); });
    n.addEventListener('dblclick', function (e) { e.preventDefault(); renameTileset(t); });
    return n;
  }

  function renameTileset(t) {
    promptText('Rename tileset', t.name).then(function (name) {
      if (!name) return;
      t.name = name;
      renderTree(); renderPalettes(); changed();
    });
  }

  function firstTile(t) {
    for (var i = 0; i < t.empty.length; i++) if (!t.empty[i]) return { t: t.id, x: i % t.cols, y: (i / t.cols) | 0 };
    return null;
  }

  function isDescendant(fid, ancestor) {
    while (fid) {
      if (fid === ancestor) return true;
      var f = S.folders.find(function (x) { return x.id === fid; });
      fid = f && f.parent;
    }
    return false;
  }

  function makeDropTarget(el, folderId) {
    el.addEventListener('dragover', function (e) {
      if (!e.dataTransfer.types.includes('application/x-ponytiler')) return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop'); });
    el.addEventListener('drop', function (e) {
      el.classList.remove('drop');
      var data = e.dataTransfer.getData('application/x-ponytiler');
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      var parts = data.split(':'), kind = parts[0], id = parts[1];
      if (kind === 'ts') {
        S.tsMap[id].folder = folderId;
      } else {
        if (folderId && isDescendant(folderId, id)) return flash("Can't move a folder into itself");
        S.folders.find(function (f) { return f.id === id; }).parent = folderId;
      }
      if (folderId) S.folders.find(function (f) { return f.id === folderId; }).open = true;
      renderTree();
      changed();
    });
  }

  function currentFolder() {
    var s = S.selTree;
    if (!s) return null;
    if (s.kind === 'folder') return S.folders.some(function (f) { return f.id === s.id; }) ? s.id : null;
    var t = S.tsMap[s.id];
    return t ? t.folder : null;
  }

  function createFolder(parent) {
    promptText('New folder name', 'New folder').then(function (name) {
      if (!name) return;
      var f = { id: uid('f'), name: name, parent: parent === undefined ? currentFolder() : parent, open: true };
      if (f.parent) S.folders.find(function (x) { return x.id === f.parent; }).open = true;
      S.folders.push(f);
      S.selTree = { kind: 'folder', id: f.id };
      renderTree();
      changed();
    });
  }

  function renameFolder(f) {
    promptText('Rename folder', f.name).then(function (name) {
      if (!name) return;
      f.name = name;
      renderTree();
      changed();
    });
  }

  function deleteFolder(f) {
    if (!confirm('Delete folder "' + f.name + '"? Anything inside moves up one level.')) return;
    S.folders.forEach(function (x) { if (x.parent === f.id) x.parent = f.parent; });
    S.tilesets.forEach(function (t) { if (t.folder === f.id) t.folder = f.parent; });
    S.folders = S.folders.filter(function (x) { return x !== f; });
    renderTree();
    changed();
  }

  function deleteTileset(t) {
    var used = S.map.layers.some(function (l) { return l.cells.some(function (c) { return c && c.t === t.id; }); });
    if (!confirm('Delete tileset "' + t.name + '"?' + (used ? '\nTiles from it will be removed from the map (can\'t be undone).' : ''))) return;
    S.tilesets = S.tilesets.filter(function (x) { return x !== t; });
    rebuildTsMap();
    S.map.layers.forEach(function (l) {
      for (var i = 0; i < l.cells.length; i++) if (l.cells[i] && l.cells[i].t === t.id) { l.cells[i] = null; l.dirty.add(i); }
    });
    palettes.forEach(function (P) { if (P.tsId === t.id) showInPalette(P, null); });
    if (brushUses(S.prevBrush, t.id)) S.prevBrush = null;
    if (brushUses(S.brush, t.id)) { S.brush = null; renderBrushInfo(); }
    S.stamps = S.stamps.filter(function (st) {
      st.cells = st.cells.map(function (c) { return c && c.t === t.id ? null : c; });
      return st.cells.some(Boolean);
    });
    renderStamps();
    clearHistory();
    renderTree();
    requestRender();
    changed();
  }

  function fillTypeSelect(sel, value) {
    sel.innerHTML = '';
    Object.keys(AT.TYPES).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = AT.TYPES[k].label;
      sel.appendChild(o);
    });
    sel.value = value;
  }

  function editTileset(t) {
    $('tsName').value = t.name;
    fillTypeSelect($('tsType'), t.type);
    $('tsSrcTile').value = t.srcTile;
    $('tsResample').value = t.resample;
    showDialog($('dlgTileset')).then(function (ok) {
      if (!ok) return;
      t.name = $('tsName').value.trim() || t.name;
      var type = $('tsType').value, src = parseInt($('tsSrcTile').value, 10) || t.srcTile;
      var res = $('tsResample').value;
      if (type !== t.type || src !== t.srcTile || res !== t.resample) {
        t.type = type; t.srcTile = src; t.resample = res;
        processTileset(t);
        S.map.layers.forEach(function (l) {
          l.cells.forEach(function (c, i) { if (c && c.t === t.id) l.dirty.add(i); });
        });
        palettes.forEach(function (P) { if (P.tsId === t.id) P.sels = []; });
        if (brushUses(S.prevBrush, t.id)) S.prevBrush = null;
        if (brushUses(S.brush, t.id)) { S.brush = null; renderBrushInfo(); }
      }
      renderTree(); renderPalettes(); renderStamps(); requestRender(); changed();
    });
  }

  $('assetSearch').addEventListener('input', renderTree);

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------
  function folderOptions(sel, value) {
    sel.innerHTML = '';
    var o = document.createElement('option');
    o.value = ''; o.textContent = '(top level)';
    sel.appendChild(o);
    S.folders.map(function (f) { return { id: f.id, path: folderPath(f.id) }; })
      .sort(function (a, b) { return a.path.localeCompare(b.path); })
      .forEach(function (f) {
        var op = document.createElement('option');
        op.value = f.id; op.textContent = f.path;
        sel.appendChild(op);
      });
    sel.value = value || '';
  }

  function importFiles(files) {
    files = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type) || /\.(png|gif|bmp|webp|jpe?g)$/i.test(f.name); });
    if (!files.length) return;
    Promise.all(files.map(function (f) {
      return readFileAsDataURL(f).then(function (src) {
        return loadImage(src).then(function (img) { return { file: f, src: src, img: img }; });
      });
    })).then(function (items) {
      var tbody = $('importRows'), defFolder = currentFolder();
      tbody.innerHTML = '';
      items.forEach(function (it) {
        var base = it.file.name.replace(/\.[^.]+$/, '');
        var type = AT.guessType(it.file.name);
        var cols = AT.sheetCols(it.file.name, type);
        var src = cols ? Math.round(it.img.width / cols) : S.ts;
        if (src % 2) src += 1;
        var tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td><input type="text" class="nm"></td><td><select class="tp"></select></td>' +
          '<td><input type="number" class="st" min="2" step="2"></td><td><select class="fd"></select></td>';
        var thumb = document.createElement('img');
        thumb.src = it.src;
        tr.children[0].appendChild(thumb);
        tr.querySelector('.nm').value = base;
        fillTypeSelect(tr.querySelector('.tp'), type);
        tr.querySelector('.st').value = src;
        folderOptions(tr.querySelector('.fd'), defFolder);
        tr.querySelector('.tp').addEventListener('change', function () {
          var c = AT.sheetCols(it.file.name, this.value) || (this.value !== 'normal' ? 16 : 0);
          if (c) tr.querySelector('.st').value = Math.round(it.img.width / c);
        });
        it.row = tr;
        tbody.appendChild(tr);
      });
      return showDialog($('dlgImport')).then(function (ok) {
        if (!ok) return;
        var resample = $('importResample').value, last = null;
        items.forEach(function (it) {
          var r = it.row;
          var st = parseInt(r.querySelector('.st').value, 10) || S.ts;
          last = addTileset({
            name: r.querySelector('.nm').value.trim() || it.file.name,
            type: r.querySelector('.tp').value,
            folder: r.querySelector('.fd').value || null,
            src: it.src, srcImg: it.img, srcTile: st, resample: resample
          });
        });
        if (last) selectTileset(last.id, true);
        flash('Imported ' + items.length + ' image' + (items.length > 1 ? 's' : ''));
        changed();
      });
    }).catch(function (err) { alert('Import failed: ' + err.message); });
  }

  $('fileImages').addEventListener('change', function () {
    importFiles(this.files);
    this.value = '';
  });

  document.addEventListener('dragover', function (e) {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    var f = e.dataTransfer.files[0];
    if (/\.json$/i.test(f.name)) openProjectFile(f);
    else importFiles(e.dataTransfer.files);
  });

  // ---------------------------------------------------------------------------
  // Layers panel
  // ---------------------------------------------------------------------------
  function renderLayers() {
    var box = $('layers');
    box.innerHTML = '';
    for (var i = S.map.layers.length - 1; i >= 0; i--) box.appendChild(layerRow(S.map.layers[i], i));
    $('btnAccLayer').disabled = S.map.layers.some(isAccessoryLayer);
    var l = activeLayer();
    $('layerOpacity').value = l ? Math.round(l.opacity * 100) : 100;
    $('layerOpacityVal').textContent = $('layerOpacity').value + '%';
  }

  function layerRow(l, i) {
    var row = document.createElement('div');
    row.className = 'layer' + (i === S.active ? ' active' : '');
    var eye = document.createElement('button');
    eye.className = 'tog' + (l.visible ? '' : ' off');
    eye.textContent = '👁'; eye.title = 'Show/hide';
    eye.addEventListener('click', function (e) { e.stopPropagation(); l.visible = !l.visible; renderLayers(); requestRender(); changed(); });
    var lock = document.createElement('button');
    lock.className = 'tog' + (l.locked ? '' : ' off');
    lock.textContent = '🔒'; lock.title = 'Lock/unlock';
    lock.addEventListener('click', function (e) { e.stopPropagation(); l.locked = !l.locked; renderLayers(); changed(); });
    var name = document.createElement('span');
    name.className = 'name'; name.textContent = l.name;
    row.append(eye, lock, name);
    row.addEventListener('click', function () { S.active = i; renderLayers(); requestRender(); });
    row.addEventListener('dblclick', function () {
      promptText('Rename layer', l.name).then(function (n) { if (n) { l.name = n; renderLayers(); changed(); } });
    });
    // drag to reorder
    row.draggable = true;
    row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('application/x-ponytiler-layer', String(i)); });
    row.addEventListener('dragover', function (e) {
      if (e.dataTransfer.types.includes('application/x-ponytiler-layer')) { e.preventDefault(); row.classList.add('dragover'); }
    });
    row.addEventListener('dragleave', function () { row.classList.remove('dragover'); });
    row.addEventListener('drop', function (e) {
      row.classList.remove('dragover');
      var from = parseInt(e.dataTransfer.getData('application/x-ponytiler-layer'), 10);
      if (isNaN(from) || from === i) return;
      e.preventDefault();
      structural(function () {
        var act = S.map.layers[S.active];
        var moved = S.map.layers.splice(from, 1)[0];
        S.map.layers.splice(i, 0, moved);
        S.active = S.map.layers.indexOf(act);
      });
      renderLayers(); requestRender();
    });
    return row;
  }

  $('layerOpacity').addEventListener('input', function () {
    var l = activeLayer();
    if (!l) return;
    l.opacity = this.value / 100;
    $('layerOpacityVal').textContent = this.value + '%';
    requestRender();
    changed();
  });

  function addLayer() {
    structural(function () {
      var l = newLayer('Layer ' + (S.map.layers.length + 1));
      rebuildLayerCanvas(l);
      S.map.layers.splice(S.active + 1, 0, l);
      S.active = S.active + 1;
      if (S.map.layers.length === 1) S.active = 0;
    });
    renderLayers(); requestRender();
  }

  function addAccessoryLayer() {
    if (S.map.layers.some(isAccessoryLayer)) return flash('There is already a WALLACCESSORY layer');
    structural(function () {
      var l = newLayer('WALLACCESSORY');
      rebuildLayerCanvas(l);
      S.map.layers.push(l);
      S.active = S.map.layers.length - 1;
    });
    renderLayers(); requestRender();
    flash('Added the WALLACCESSORY layer — paint wall decorations on it');
  }

  function dupLayer() {
    var src = activeLayer();
    if (!src) return;
    structural(function () {
      var l = newLayer(src.name + ' copy');
      l.cells = src.cells.slice(); l.opacity = src.opacity; l.visible = src.visible;
      rebuildLayerCanvas(l);
      S.map.layers.splice(S.active + 1, 0, l);
      S.active++;
    });
    renderLayers(); requestRender();
  }

  function delLayer() {
    var l = activeLayer();
    if (!l) return;
    if (S.map.layers.length === 1) return flash("Can't delete the last layer");
    structural(function () {
      S.map.layers.splice(S.active, 1);
      S.active = Math.max(0, S.active - 1);
    });
    renderLayers(); requestRender();
  }

  function moveLayer(dir) {
    var j = S.active + dir;
    if (j < 0 || j >= S.map.layers.length) return;
    structural(function () {
      var a = S.map.layers;
      var tmp = a[j]; a[j] = a[S.active]; a[S.active] = tmp;
      S.active = j;
    });
    renderLayers(); requestRender();
  }

  // ---------------------------------------------------------------------------
  // Project: new / save / load / autosave
  // ---------------------------------------------------------------------------
  function serialize() {
    return {
      app: 'PonyTiler', version: 1,
      tileSize: S.ts, nextId: S.nextId,
      palette2: palettes[1].tsId,
      stamps: S.stamps.map(function (st) { return { w: st.w, h: st.h, cells: st.cells }; }),
      folders: S.folders.map(function (f) { return { id: f.id, name: f.name, parent: f.parent, open: !!f.open }; }),
      tilesets: S.tilesets.map(function (t) {
        return { id: t.id, name: t.name, type: t.type, folder: t.folder, src: t.src, srcTile: t.srcTile, resample: t.resample };
      }),
      map: {
        w: S.map.w, h: S.map.h, active: S.active,
        walls: S.walls.cells.map(function (c) { return c ? '1' : '0'; }).join(''),
        layers: S.map.layers.map(function (l) {
          // Cells are stored as indexes into a per-layer list of unique tiles to keep files small.
          var uniq = [], keyIdx = {}, data = new Array(l.cells.length);
          for (var i = 0; i < l.cells.length; i++) {
            var c = l.cells[i];
            if (!c) { data[i] = 0; continue; }
            var key = c.t + '|' + (c.k !== undefined ? 'k' + c.k : c.x + ',' + c.y);
            if (keyIdx[key] === undefined) { uniq.push(c); keyIdx[key] = uniq.length; }
            data[i] = keyIdx[key];
          }
          return { id: l.id, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, tiles: uniq, data: data };
        })
      }
    };
  }

  function loadProject(p) {
    if (!p || p.app !== 'PonyTiler') return Promise.reject(new Error('Not a PonyTiler project file'));
    return Promise.all(p.tilesets.map(function (t) {
      return loadImage(t.src).then(function (img) { t.srcImg = img; return t; });
    })).then(function (tss) {
      S.ts = p.tileSize || 32;
      S.nextId = p.nextId || 1;
      S.folders = (p.folders || []).map(function (f) { return { id: f.id, name: f.name, parent: f.parent || null, open: !!f.open }; });
      S.tilesets = [];
      tss.forEach(function (t) { addTileset(t); });
      rebuildTsMap();
      S.map.w = p.map.w; S.map.h = p.map.h;
      S.map.layers = p.map.layers.map(function (l) {
        var tiles = l.tiles.map(function (c) { return c.k !== undefined ? { t: c.t, k: c.k } : { t: c.t, x: c.x, y: c.y }; });
        var cells = l.data.map(function (v) { return v ? tiles[v - 1] : null; });
        return { id: l.id, name: l.name, visible: l.visible !== false, locked: !!l.locked, opacity: l.opacity === undefined ? 1 : l.opacity, cells: cells, dirty: new Set() };
      });
      S.active = Math.min(p.map.active || 0, S.map.layers.length - 1);
      S.stamps = (p.stamps || []).slice(0, MAX_STAMPS).map(function (st) { return { id: uid('s'), w: st.w, h: st.h, cells: st.cells }; });
      var walls = typeof p.map.walls === 'string' && p.map.walls.length === S.map.w * S.map.h ? p.map.walls : '';
      S.walls = newWallLayer(Array.prototype.map.call(walls || '0'.repeat(S.map.w * S.map.h), function (ch) { return ch === '1' ? 1 : null; }));
      resetSelection();
      palettes[1].tsId = p.palette2 && S.tsMap[p.palette2] ? p.palette2 : null;
      clearHistory();
      rebuildAllCanvases();
      renderAll();
      fitView();
    });
  }

  function newProject(w, h, ts, keepTilesets) {
    var old = keepTilesets ? { folders: S.folders, tilesets: S.tilesets } : null;
    S.ts = ts;
    S.map.w = w; S.map.h = h;
    if (!old) { S.folders = []; S.tilesets = []; }
    else S.tilesets.forEach(processTileset);
    rebuildTsMap();
    S.map.layers = [newLayer('Ground'), newLayer('Objects')];
    S.walls = newWallLayer();
    S.active = 0;
    if (!old) S.stamps = [];
    resetSelection();
    clearHistory();
    rebuildAllCanvases();
    renderAll();
    fitView();
    changed();
  }

  function resetSelection() {
    palettes.forEach(function (P) { P.tsId = null; P.sels = []; });
    S.brush = null; S.prevBrush = null; S.selTree = null; S.marquee = null; S.lastPal = null;
  }

  function renderAll() {
    renderTree(); renderPalettes(); renderLayers(); renderBrushInfo(); renderStamps(); updateStatus(); syncToolButtons();
  }

  function updateStatus() {
    $('statusMap').textContent = S.map.w + '×' + S.map.h + ' tiles · ' + (S.map.w * S.ts) + '×' + (S.map.h * S.ts) + ' px · ' + S.ts + 'px tiles';
  }

  var saveTimer = null;
  function changed(light) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      Store.set('autosave', serialize()).catch(function () { /* autosave is best-effort */ });
    }, light ? 2000 : 800);
  }

  function saveNow() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    Store.set('autosave', serialize()).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', saveNow);

  function saveProject() {
    var name = ($('exName').value || 'map').replace(/[^\w\-. ]+/g, '_');
    var blob = new Blob([JSON.stringify(serialize())], { type: 'application/json' });
    download(blob, name + '.ponytiler.json');
    flash('Project saved');
  }

  function openProjectFile(file) {
    var r = new FileReader();
    r.onload = function () {
      var p;
      try { p = JSON.parse(r.result); } catch (e) { return alert('That file is not valid JSON.'); }
      loadProject(p).then(function () {
        $('exName').value = file.name.replace(/(\.ponytiler)?\.json$/i, '');
        flash('Opened ' + file.name);
        changed();
      }).catch(function (e) { alert(e.message); });
    };
    r.readAsText(file);
  }

  $('fileProject').addEventListener('change', function () {
    if (this.files[0]) openProjectFile(this.files[0]);
    this.value = '';
  });

  // ---------------------------------------------------------------------------
  // Resize / export
  // ---------------------------------------------------------------------------
  var anchor = 0;
  $('anchor').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    anchor = +b.dataset.a;
    syncAnchor();
  });
  function syncAnchor() {
    Array.prototype.forEach.call($('anchor').children, function (b) { b.classList.toggle('active', +b.dataset.a === anchor); });
  }

  function resizeDialog() {
    $('rsW').value = S.map.w; $('rsH').value = S.map.h; $('rsTs').value = S.ts;
    syncAnchor();
    showDialog($('dlgResize')).then(function (ok) {
      if (!ok) return;
      var nw = Math.max(1, Math.min(500, parseInt($('rsW').value, 10) || S.map.w));
      var nh = Math.max(1, Math.min(500, parseInt($('rsH').value, 10) || S.map.h));
      var nts = parseInt($('rsTs').value, 10) || S.ts;
      if (nts % 2) nts += 1;
      if (nw !== S.map.w || nh !== S.map.h) {
        structural(function () {
          var ax = anchor % 3, ay = Math.floor(anchor / 3);
          var offX = ax === 0 ? 0 : ax === 1 ? Math.floor((nw - S.map.w) / 2) : nw - S.map.w;
          var offY = ay === 0 ? 0 : ay === 1 ? Math.floor((nh - S.map.h) / 2) : nh - S.map.h;
          S.map.layers.concat([S.walls]).forEach(function (l) {
            var cells = new Array(nw * nh).fill(null);
            for (var y = 0; y < S.map.h; y++) for (var x = 0; x < S.map.w; x++) {
              var nx = x + offX, ny = y + offY;
              if (nx >= 0 && ny >= 0 && nx < nw && ny < nh) cells[ny * nw + nx] = l.cells[y * S.map.w + x];
            }
            l.cells = cells;
          });
          S.map.w = nw; S.map.h = nh;
          rebuildAllCanvases();
        });
      }
      if (nts !== S.ts) {
        S.ts = nts;
        S.tilesets.forEach(processTileset);
        rebuildAllCanvases();
        renderAll();
        changed();
      }
      updateStatus();
      fitView();
    });
  }

  function exportScale() {
    var v = $('exScale').value;
    if (v !== 'custom') return parseFloat(v);
    var w = parseInt($('exCustomW').value, 10) || S.map.w * S.ts;
    return w / (S.map.w * S.ts);
  }

  function updateExportInfo() {
    $('exCustomRow').hidden = $('exScale').value !== 'custom';
    var s = exportScale();
    var w = Math.round(S.map.w * S.ts * s), h = Math.round(S.map.h * S.ts * s);
    $('exSize').textContent = 'Output: ' + w + ' × ' + h + ' px' + (w > 16384 || h > 16384 ? ' — too large for most browsers!' : '');
    $('exWarn').hidden = Math.abs(s - Math.round(s)) < 1e-9 && s >= 1;
  }
  ['exScale', 'exCustomW'].forEach(function (id) { $(id).addEventListener('input', updateExportInfo); });

  // PNG chunks need a CRC-32; used to embed the wall grid size into the walls PNG.
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Insert a tEXt chunk right after IHDR (8-byte signature + 25-byte IHDR chunk).
  function pngWithText(buf, key, text) {
    var src = new Uint8Array(buf), data = new TextEncoder().encode(key + '\0' + text);
    var chunk = new Uint8Array(12 + data.length), dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk.set([116, 69, 88, 116], 4);
    chunk.set(data, 8);
    dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return new Blob([src.subarray(0, 33), chunk, src.subarray(33)], { type: 'image/png' });
  }

  // Walls PNG: red = wall, green = WALLACCESSORY tile, yellow = both. Same size as the map PNG so it lines up.
  var WALL_COLORS = [null, '#ff0000', '#00ff00', '#ffff00'];
  function drawWallMask(g, w, h) {
    var acc = accessoryMask(), cw = w / S.map.w, ch = h / S.map.h;
    for (var i = 0; i < acc.length; i++) {
      var v = (S.walls.cells[i] ? 1 : 0) | (acc[i] ? 2 : 0);
      if (!v) continue;
      var x = i % S.map.w, y = (i / S.map.w) | 0;
      var x0 = Math.round(x * cw), y0 = Math.round(y * ch);
      g.fillStyle = WALL_COLORS[v];
      g.fillRect(x0, y0, Math.round((x + 1) * cw) - x0, Math.round((y + 1) * ch) - y0);
    }
  }

  function exportDialog(mode) {
    var walls = mode === 'walls';
    if (walls && !S.walls.cells.some(Boolean)) return flash('No walls yet — pick the Wall tool (V) and paint some');
    if (!$('exCustomW').value) $('exCustomW').value = S.map.w * S.ts * 2;
    $('exTitle').textContent = walls ? 'Export walls PNG' : 'Export PNG';
    $('exHiddenRow').hidden = $('exBgRow').hidden = walls;
    $('exWallNote').hidden = !walls;
    updateExportInfo();
    showDialog($('dlgExport')).then(function (ok) {
      if (!ok) return;
      flushDirty();
      var s = exportScale();
      var w = Math.round(S.map.w * S.ts * s), h = Math.round(S.map.h * S.ts * s);
      var out = makeCanvas(w, h), g = out.getContext('2d');
      g.imageSmoothingEnabled = false;
      var base = ($('exName').value || 'map').replace(/[^\w\-. ]+/g, '_');
      if (walls) {
        drawWallMask(g, w, h);
        var meta = JSON.stringify({ app: 'PonyTiler', kind: 'walls', cols: S.map.w, rows: S.map.h, tileSize: S.ts });
        out.toBlob(function (blob) {
          if (!blob) return alert('Export failed — the image is probably too large for this browser. Try a smaller scale.');
          blob.arrayBuffer().then(function (buf) {
            download(pngWithText(buf, 'ponytiler', meta), base + '-walls.png');
            flash('Exported ' + w + '×' + h + ' walls PNG');
          });
        }, 'image/png');
        return;
      }
      if ($('exBgOn').checked) { g.fillStyle = $('exBg').value; g.fillRect(0, 0, w, h); }
      var hidden = $('exHidden').checked;
      S.map.layers.forEach(function (l) {
        if (!l.visible && !hidden) return;
        g.globalAlpha = l.opacity;
        g.drawImage(l.canvas, 0, 0, w, h);
      });
      out.toBlob(function (blob) {
        if (!blob) return alert('Export failed — the image is probably too large for this browser. Try a smaller scale.');
        download(blob, base + '.png');
        flash('Exported ' + w + '×' + h + ' PNG');
      }, 'image/png');
    });
  }

  // ---------------------------------------------------------------------------
  // Toolbar & keyboard
  // ---------------------------------------------------------------------------
  function setTool(t) {
    if (t === 'wall' && S.tool !== 'wall') flash('Walls: left-drag marks, right-drag clears, Shift+drag for a rectangle');
    S.tool = t;
    syncToolButtons();
    requestRender();
  }

  function syncToolButtons() {
    document.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === S.tool); });
    $('btnGrid').classList.toggle('active', S.grid);
    $('btnDim').classList.toggle('active', S.dim);
    $('btnAxes').classList.toggle('active', S.axes);
    $('btnDice').classList.toggle('active', S.dice);
  }

  var actions = {
    new: function () {
      $('newW').value = S.map.w; $('newH').value = S.map.h; $('newTs').value = S.ts;
      showDialog($('dlgNew')).then(function (ok) {
        if (!ok) return;
        var ts = parseInt($('newTs').value, 10) || 32;
        if (ts % 2) ts += 1;
        newProject(
          Math.max(1, Math.min(500, parseInt($('newW').value, 10) || 40)),
          Math.max(1, Math.min(500, parseInt($('newH').value, 10) || 30)),
          ts, $('newKeepTs').checked);
      });
    },
    open: function () { $('fileProject').click(); },
    save: saveProject,
    import: function () { $('fileImages').click(); },
    undo: undo, redo: redo,
    grid: function () { S.grid = !S.grid; syncToolButtons(); requestRender(); },
    dim: function () { S.dim = !S.dim; syncToolButtons(); requestRender(); },
    axes: function () { S.axes = !S.axes; syncToolButtons(); requestRender(); },
    dice: function () { S.dice = !S.dice; syncToolButtons(); renderBrushInfo(); requestRender(); },
    unselect: function () { setBrush(null); },
    help: function () { showDialog($('dlgHelp')); },
    zoomIn: function () { stepZoom(1); },
    zoomOut: function () { stepZoom(-1); },
    resize: resizeDialog,
    export: function () { exportDialog('map'); },
    exportWalls: function () { exportDialog('walls'); },
    newFolder: function () { createFolder(); },
    addLayer: addLayer, addAccessoryLayer: addAccessoryLayer, dupLayer: dupLayer, delLayer: delLayer,
    layerUp: function () { moveLayer(1); },
    layerDown: function () { moveLayer(-1); }
  };

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action],[data-tool]');
    if (!b || b.closest('dialog')) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else if (actions[b.dataset.action]) actions[b.dataset.action]();
  });

  // Cancel buttons must not trigger form validation.
  document.querySelectorAll('dialog button[value=cancel]').forEach(function (b) { b.formNoValidate = true; });

  document.addEventListener('keydown', function (e) {
    if (document.querySelector('dialog[open]')) return;
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && k === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && k === 'o') { e.preventDefault(); actions.open(); return; }
    if (mod && k === 'e') { e.preventDefault(); exportDialog('map'); return; }
    if (mod && e.key === '0') { e.preventDefault(); actualSize(); return; }
    if (mod && k === 'c' && S.marquee) { e.preventDefault(); captureStamp(S.marquee); return; }
    if (mod) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; if (!drag) canvas.style.cursor = 'grab'; }
      return;
    }
    var map = { w: 'brush', a: 'eraser', s: 'fill', d: 'rect', f: 'picker', e: 'select', v: 'wall', b: 'brush', g: 'fill', r: 'rect', i: 'picker' };
    if (map[k]) return setTool(map[k]);
    if (k === 'q') return swapBrush();
    if (k === 'h') return actions.grid();
    if (k === 'x') return actions.axes();
    if (k === 'l') return actions.dim();
    if (drag && (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace')) return;
    if (e.key === 'Escape') {
      if (S.marquee) { S.marquee = null; requestRender(); } else setBrush(null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.marquee) { e.preventDefault(); clearMarquee(); return; }
    if (e.key === '+' || e.key === '=') return stepZoom(1);
    if (e.key === '-') return stepZoom(-1);
    if (e.key === '0') return fitView();
    if (e.key === '[' || e.key === ']') {
      S.active = Math.max(0, Math.min(S.map.layers.length - 1, S.active + (e.key === ']' ? 1 : -1)));
      renderLayers(); requestRender();
    }
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === ' ') { spaceDown = false; if (!drag) canvas.style.cursor = ''; }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  resizeCanvas();
  Store.get('autosave').then(function (p) {
    if (p) return loadProject(p).then(function () { flash('Restored your last session'); });
    newProject(40, 30, 32, false);
  }).catch(function () {
    newProject(40, 30, 32, false);
  });

  // Exposed for debugging and automated tests.
  window.PonyTiler = { state: S, serialize: serialize, loadProject: loadProject, addTileset: addTileset, render: render };
})();
