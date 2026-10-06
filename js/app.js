(function () {
  'use strict';

  var AT = window.Autotile;
  var $ = function (id) { return document.getElementById(id); };
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
    selTs: null,
    selTree: null,
    palSel: null,
    brush: null,
    tool: 'brush',
    zoom: 1, ox: 0, oy: 0,
    grid: true, dim: false,
    hover: null
  };

  function uid(p) { return p + (S.nextId++); }
  function activeLayer() { return S.map.layers[S.active] || null; }
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

  function rebuildLayerCanvas(layer) {
    layer.canvas = makeCanvas(S.map.w * S.ts, S.map.h * S.ts);
    layer.ctx = layer.canvas.getContext('2d');
    layer.ctx.imageSmoothingEnabled = false;
    layer.dirty = new Set();
    for (var i = 0; i < layer.cells.length; i++) if (layer.cells[i]) layer.dirty.add(i);
  }

  function rebuildAllCanvases() {
    S.map.layers.forEach(rebuildLayerCanvas);
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
    S.map.layers.forEach(function (l) {
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
      w: S.map.w, h: S.map.h, active: S.active,
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
      var l = S.map.layers.find(function (x) { return x.id === ch.layerId; });
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
  function brushOffset() {
    var b = S.brush;
    return b ? { x: Math.floor((b.w - 1) / 2), y: Math.floor((b.h - 1) / 2) } : { x: 0, y: 0 };
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
      selectTileset(t.id, true);
      S.palSel = { x0: px, y0: py, x1: px, y1: py };
      buildBrushFromPalette();
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

  function drawOverlay(ox, oy, d) {
    if (drag && drag.mode === 'rect') {
      var x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
      var w = Math.abs(drag.x1 - drag.x0) + 1, h = Math.abs(drag.y1 - drag.y0) + 1;
      if (!drag.erase && S.brush) {
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
    if (S.tool === 'brush' && S.brush && !erasing) {
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
      outline(ox + p.x * d, oy + p.y * d, d, d, erasing ? '#ff6b6b' : '#ffffff');
    }
  }

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
    if (e.button !== 0 && e.button !== 2) return;
    var rightBtn = e.button === 2;
    if (!rightBtn && (e.altKey || S.tool === 'picker')) return pick(p);

    var layer = activeLayer();
    if (!layer) return flash('Add a layer first');
    if (!layer.visible) return flash('Layer "' + layer.name + '" is hidden');
    if (layer.locked) return flash('Layer "' + layer.name + '" is locked');

    if (S.tool === 'fill') return floodFill(p, rightBtn);
    if (S.tool === 'rect') {
      drag = { mode: 'rect', erase: rightBtn, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      requestRender();
      return;
    }
    var erase = rightBtn || S.tool === 'eraser';
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
    } else if (drag.mode === 'rect') {
      if (drag.x1 !== p.x || drag.y1 !== p.y) { drag.x1 = p.x; drag.y1 = p.y; requestRender(); }
    } else if (drag.last.x !== p.x || drag.last.y !== p.y) {
      lineCells(drag.last.x, drag.last.y, p.x, p.y, function (x, y) { paintStep({ x: x, y: y }); });
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
    else if (d.mode === 'paint' || d.mode === 'erase') endStroke();
    requestRender();
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
  var pal = $('palette'), palCtx = pal.getContext('2d'), palDrag = null;

  function palZoom() {
    var v = $('paletteZoom').value, t = S.tsMap[S.selTs];
    if (v === 'fit' && t) return Math.max(0.25, ($('paletteWrap').clientWidth - 2) / (t.palCols * S.ts));
    return parseFloat(v) || 1;
  }

  function renderPalette() {
    var t = S.tsMap[S.selTs];
    $('paletteEmpty').hidden = !!t;
    pal.hidden = !t;
    $('paletteTitle').textContent = t ? 'Palette — ' + t.name : 'Palette';
    if (!t) return;
    var z = palZoom(), ts = S.ts, d = ts * z;
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
    if (S.palSel) {
      var s = S.palSel;
      var x0 = Math.min(s.x0, s.x1), y0 = Math.min(s.y0, s.y1);
      var w = Math.abs(s.x1 - s.x0) + 1, h = Math.abs(s.y1 - s.y0) + 1;
      palCtx.fillStyle = 'rgba(200,111,216,0.25)';
      palCtx.fillRect(x0 * d, y0 * d, w * d, h * d);
      palCtx.lineWidth = 2;
      palCtx.strokeStyle = '#e9a6f5';
      palCtx.strokeRect(x0 * d + 1, y0 * d + 1, w * d - 2, h * d - 2);
    }
  }

  function palPos(e) {
    var r = pal.getBoundingClientRect(), d = S.ts * palZoom();
    return { x: Math.floor((e.clientX - r.left) / d), y: Math.floor((e.clientY - r.top) / d) };
  }

  pal.addEventListener('pointerdown', function (e) {
    var t = S.tsMap[S.selTs];
    if (!t || e.button !== 0) return;
    pal.setPointerCapture(e.pointerId);
    var p = palPos(e);
    p.x = Math.max(0, Math.min(t.palCols - 1, p.x));
    p.y = Math.max(0, Math.min(t.palRows - 1, p.y));
    palDrag = true;
    S.palSel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    renderPalette();
  });
  pal.addEventListener('pointermove', function (e) {
    if (!palDrag) return;
    var t = S.tsMap[S.selTs], p = palPos(e);
    p.x = Math.max(0, Math.min(t.palCols - 1, p.x));
    p.y = Math.max(0, Math.min(t.palRows - 1, p.y));
    if (p.x !== S.palSel.x1 || p.y !== S.palSel.y1) {
      S.palSel.x1 = p.x; S.palSel.y1 = p.y;
      renderPalette();
    }
  });
  pal.addEventListener('pointerup', function () {
    if (!palDrag) return;
    palDrag = false;
    buildBrushFromPalette();
    if (S.tool !== 'fill' && S.tool !== 'rect') setTool('brush');
  });
  $('paletteZoom').addEventListener('change', renderPalette);
  new ResizeObserver(function () { if ($('paletteZoom').value === 'fit') renderPalette(); }).observe($('paletteWrap'));

  function buildBrushFromPalette() {
    var t = S.tsMap[S.selTs], s = S.palSel;
    if (!t || !s) { S.brush = null; renderBrushInfo(); return; }
    var x0 = Math.min(s.x0, s.x1), y0 = Math.min(s.y0, s.y1);
    var w = Math.abs(s.x1 - s.x0) + 1, h = Math.abs(s.y1 - s.y0) + 1;
    var cells = [], any = false;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var c = paletteCell(t, x0 + x, y0 + y);
      cells.push(c);
      if (c) any = true;
    }
    S.brush = any ? { w: w, h: h, cells: cells, name: t.name, type: t.type } : null;
    renderPalette();
    renderBrushInfo();
    requestRender();
  }

  function renderBrushInfo() {
    var b = S.brush, bp = $('brushPreview');
    if (!b) {
      bp.width = 1; bp.height = 1;
      $('brushInfo').textContent = 'Nothing selected';
      return;
    }
    var z = Math.max(1, Math.min(2, Math.floor(220 / (b.w * S.ts))));
    bp.width = b.w * S.ts * z; bp.height = b.h * S.ts * z;
    var g = bp.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (var y = 0; y < b.h; y++) for (var x = 0; x < b.w; x++) {
      var c = b.cells[y * b.w + x];
      if (c) drawCellTo(g, c, x * S.ts * z, y * S.ts * z, z, noSame);
    }
    $('brushInfo').textContent = b.w + '×' + b.h + ' from ' + b.name + (isAuto(b.type) ? ' (autotile)' : '');
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
    S.selTs = id;
    S.selTree = { kind: 'ts', id: id };
    S.palSel = null;
    if (reveal) {
      var t = S.tsMap[id], fid = t && t.folder;
      while (fid) {
        var f = S.folders.find(function (x) { return x.id === fid; });
        if (!f) break;
        f.open = true;
        fid = f.parent;
      }
    }
    renderTree();
    renderPalette();
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
    n.addEventListener('click', function () {
      f.open = !f.open;
      S.selTree = { kind: 'folder', id: f.id };
      renderTree();
      changed(true);
    });
    n.addEventListener('dblclick', function (e) { e.preventDefault(); renameFolder(f); });
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
    n.append(icon, name, tag, acts);
    n.addEventListener('click', function () { selectTileset(t.id); });
    n.addEventListener('dblclick', function (e) { e.preventDefault(); editTileset(t); });
    return n;
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
    if (S.selTs === t.id) { S.selTs = null; S.palSel = null; renderPalette(); }
    if (S.brush && S.brush.cells.some(function (c) { return c && c.t === t.id; })) { S.brush = null; renderBrushInfo(); }
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
        if (S.selTs === t.id) S.palSel = null;
        if (S.brush && S.brush.cells.some(function (c) { return c && c.t === t.id; })) { S.brush = null; renderBrushInfo(); }
      }
      renderTree(); renderPalette(); requestRender(); changed();
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
      folders: S.folders.map(function (f) { return { id: f.id, name: f.name, parent: f.parent, open: !!f.open }; }),
      tilesets: S.tilesets.map(function (t) {
        return { id: t.id, name: t.name, type: t.type, folder: t.folder, src: t.src, srcTile: t.srcTile, resample: t.resample };
      }),
      map: {
        w: S.map.w, h: S.map.h, active: S.active,
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
      S.selTs = null; S.palSel = null; S.brush = null; S.selTree = null;
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
    S.active = 0;
    S.selTs = null; S.palSel = null; S.brush = null; S.selTree = null;
    clearHistory();
    rebuildAllCanvases();
    renderAll();
    fitView();
    changed();
  }

  function renderAll() {
    renderTree(); renderPalette(); renderLayers(); renderBrushInfo(); updateStatus(); syncToolButtons();
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
          S.map.layers.forEach(function (l) {
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

  function exportDialog() {
    if (!$('exCustomW').value) $('exCustomW').value = S.map.w * S.ts * 2;
    updateExportInfo();
    showDialog($('dlgExport')).then(function (ok) {
      if (!ok) return;
      flushDirty();
      var s = exportScale();
      var w = Math.round(S.map.w * S.ts * s), h = Math.round(S.map.h * S.ts * s);
      var out = makeCanvas(w, h), g = out.getContext('2d');
      g.imageSmoothingEnabled = false;
      if ($('exBgOn').checked) { g.fillStyle = $('exBg').value; g.fillRect(0, 0, w, h); }
      var hidden = $('exHidden').checked;
      S.map.layers.forEach(function (l) {
        if (!l.visible && !hidden) return;
        g.globalAlpha = l.opacity;
        g.drawImage(l.canvas, 0, 0, w, h);
      });
      out.toBlob(function (blob) {
        if (!blob) return alert('Export failed — the image is probably too large for this browser. Try a smaller scale.');
        download(blob, ($('exName').value || 'map').replace(/[^\w\-. ]+/g, '_') + '.png');
        flash('Exported ' + w + '×' + h + ' PNG');
      }, 'image/png');
    });
  }

  // ---------------------------------------------------------------------------
  // Toolbar & keyboard
  // ---------------------------------------------------------------------------
  function setTool(t) {
    S.tool = t;
    syncToolButtons();
    requestRender();
  }

  function syncToolButtons() {
    document.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === S.tool); });
    $('btnGrid').classList.toggle('active', S.grid);
    $('btnDim').classList.toggle('active', S.dim);
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
    zoomIn: function () { stepZoom(1); },
    zoomOut: function () { stepZoom(-1); },
    resize: resizeDialog,
    export: exportDialog,
    newFolder: function () { createFolder(); },
    addLayer: addLayer, dupLayer: dupLayer, delLayer: delLayer,
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
    if (mod && k === 'e') { e.preventDefault(); exportDialog(); return; }
    if (mod) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; if (!drag) canvas.style.cursor = 'grab'; }
      return;
    }
    var map = { b: 'brush', e: 'eraser', g: 'fill', r: 'rect', i: 'picker' };
    if (map[k]) return setTool(map[k]);
    if (k === 'h') return actions.grid();
    if (k === 'f') return actions.dim();
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
