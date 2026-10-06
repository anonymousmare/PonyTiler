import './walls.js';

const { buildWalls, readPngText, SUB } = globalThis.PonyWalls;

const MOD = 'ponytiler-walls';
const ICON = 'fa-solid fa-dungeon';

// Button in the Walls controls (left toolbar). v13 passes an object of controls, v12 an array.
Hooks.on('getSceneControlButtons', controls => {
  const tool = { name: MOD, title: 'PonyTiler: build walls from wall PNG tile', icon: ICON, button: true, visible: game.user.isGM };
  if (Array.isArray(controls)) {
    controls.find(c => c.name === 'walls')?.tools.push({ ...tool, onClick: () => run() });
  } else if (controls.walls) {
    controls.walls.tools[MOD] = { ...tool, order: Object.keys(controls.walls.tools).length, onChange: () => run() };
  }
});

// Button on the tile HUD (right-click the wall PNG tile).
Hooks.on('renderTileHUD', (hud, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const col = root?.querySelector('.col.right');
  if (!col) return;
  const v13 = (game.release?.generation ?? 12) >= 13;
  const btn = document.createElement(v13 ? 'button' : 'div');
  if (v13) btn.type = 'button';
  btn.className = 'control-icon';
  btn.title = 'PonyTiler: build walls from this tile';
  btn.innerHTML = `<i class="${ICON}"></i>`;
  btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); run(hud.object?.document); });
  col.appendChild(btn);
});

function pickTile() {
  const controlled = canvas.tiles?.controlled ?? [];
  if (controlled.length === 1) return controlled[0].document;
  const named = canvas.scene.tiles.filter(t => /-walls\.png$/i.test(t.texture?.src ?? ''));
  return named.length === 1 ? named[0] : null;
}

async function loadPixels(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Couldn't load ${src} (${res.status})`);
  const buf = await res.arrayBuffer();
  let meta = null;
  try { meta = JSON.parse(readPngText(buf, 'ponytiler') ?? 'null'); } catch (e) { /* no metadata */ }
  const bmp = await createImageBitmap(new Blob([buf]));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return { meta, w: bmp.width, h: bmp.height, data: g.getImageData(0, 0, bmp.width, bmp.height).data };
}

async function askOptions(cols, rows, fromFile) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const content = `
    <p>${fromFile ? 'Grid size read from the PNG.' : 'This PNG has no PonyTiler info — check the grid size (map tiles across / down).'}</p>
    <div class="form-group"><label>Tiles across</label><input name="cols" type="number" min="1" value="${cols}"></div>
    <div class="form-group"><label>Tiles down</label><input name="rows" type="number" min="1" value="${rows}"></div>
    <div class="form-group"><label>Visible wall edge (% of a tile)</label><input name="inset" type="number" min="13" max="37" step="1" value="25"></div>
    <div class="form-group"><label>Room around wall decorations (% of a tile)</label><input name="pad" type="number" min="0" max="200" step="1" value="25"></div>
    <div class="form-group"><label>Replace walls made from this tile before</label><input name="replace" type="checkbox" checked></div>
    <div class="form-group"><label>Hide the wall PNG tile afterwards</label><input name="hide" type="checkbox" checked></div>`;
  return DialogV2.prompt({
    window: { title: 'PonyTiler walls' },
    content,
    rejectClose: false,
    ok: {
      label: 'Build walls',
      callback: (event, button) => {
        const f = button.form.elements;
        return {
          cols: f.cols.valueAsNumber, rows: f.rows.valueAsNumber,
          inset: f.inset.valueAsNumber, pad: f.pad.valueAsNumber,
          replace: f.replace.checked, hide: f.hide.checked
        };
      }
    }
  });
}

async function run(tile) {
  if (!game.user.isGM) return ui.notifications.warn('Only the GM can build walls.');
  tile ??= pickTile();
  if (!tile) return ui.notifications.warn('Select the walls PNG tile first (Tiles layer), or right-click it and use the dungeon button.');
  if (tile.rotation) ui.notifications.warn('The wall tile is rotated — rotation is ignored.');

  let img;
  try { img = await loadPixels(tile.texture.src); }
  catch (e) { return ui.notifications.error(`PonyTiler walls: ${e.message}`); }

  const grid = canvas.grid.size;
  const guessCols = img.meta?.cols ?? Math.max(1, Math.round(tile.width / grid));
  const guessRows = img.meta?.rows ?? Math.max(1, Math.round(tile.height / grid));
  const opt = await askOptions(guessCols, guessRows, !!img.meta);
  if (!opt || !(opt.cols > 0) || !(opt.rows > 0)) return;

  // Red at the middle of each tile = wall. Every green pixel is part of a decoration, and its blue
  // value says which way it faces (0 ↑, 64 →, 128 ↓, 192 ←).
  const { cols, rows } = opt;
  const wall = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = Math.min(img.w - 1, Math.floor((x + 0.5) * img.w / cols));
      const py = Math.min(img.h - 1, Math.floor((y + 0.5) * img.h / rows));
      const o = (py * img.w + px) * 4;
      wall[y * cols + x] = img.data[o + 3] >= 128 && img.data[o] >= 128 ? 1 : 0;
    }
  }
  const W = cols * SUB, H = rows * SUB, acc = new Uint8Array(W * H);
  for (let y = 0; y < img.h; y++) {
    const row = Math.min(H - 1, Math.floor(y * H / img.h)) * W;
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      if (img.data[o + 3] < 128 || img.data[o + 1] < 128) continue;
      acc[row + Math.min(W - 1, Math.floor(x * W / img.w))] = 1 + (Math.round(img.data[o + 2] / 64) & 3);
    }
  }
  if (!wall.some(Boolean)) return ui.notifications.warn('No wall tiles (red/yellow) found in that PNG.');

  const { edges, cores } = buildWalls({
    cols, rows, wall, acc,
    inset: (opt.inset / 100) * SUB,
    pad: (opt.pad / 100) * SUB
  });

  const cw = tile.width / cols, ch = tile.height / rows;
  const M = CONST.WALL_MOVEMENT_TYPES, SENSE = CONST.WALL_SENSE_TYPES;
  const toWall = (s, kind) => {
    const c = [
      Math.round(tile.x + s[0] * cw), Math.round(tile.y + s[1] * ch),
      Math.round(tile.x + s[2] * cw), Math.round(tile.y + s[3] * ch)
    ];
    if (c[0] === c[2] && c[1] === c[3]) return null;
    const sense = kind === 'edge' ? SENSE.NONE : SENSE.NORMAL;
    return { c, move: M.NORMAL, sight: sense, light: sense, sound: sense, flags: { [MOD]: { tile: tile.id, kind } } };
  };
  const data = [
    ...edges.map(s => toWall(s, 'edge')),
    ...cores.map(s => toWall(s, 'core'))
  ].filter(Boolean);

  const scene = tile.parent;
  if (opt.replace) {
    const old = scene.walls.filter(w => w.getFlag(MOD, 'tile') === tile.id).map(w => w.id);
    if (old.length) await scene.deleteEmbeddedDocuments('Wall', old);
  }
  await scene.createEmbeddedDocuments('Wall', data);
  if (opt.hide && !tile.hidden) await tile.update({ hidden: true });
  ui.notifications.info(`PonyTiler: made ${edges.length} edge walls and ${cores.length} sight-blocking walls.`);
}
