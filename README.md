# PonyTiler

A small Tiled-style map editor that understands **RPG Maker MV tilesets** (A1–A5, B–E) and exports crisp, pixel-perfect PNGs. It runs entirely in the browser, with no install or build step.

## Run it
Open `index.html` in Chrome, Edge or Firefox. That's it.

## Features
- **RPG Maker MV images**: A1 (water/waterfalls), A2 (ground), A3 (buildings) and A4 (walls) work as real **autotiles** that join up with their neighbours. A5 and B–E sheets, or any other sprite sheet, work as normal tiles.
- **Any tile size** (default **32×32**). MV's 48 px sheets are detected from the file name (`Outside_A2.png`, `Inside_B.png`, …) and rescaled to your tile size on import.
- **Folders**: sort tilesets into nested folders by drag-and-drop. You can rename, filter and delete them.
- **Layers**: add, duplicate, delete, reorder (drag or ▲▼), show/hide, lock, opacity, and "Focus layer" to dim the others. Each layer has a **colour** (click the round button next to its name and pick a hue); the whole UI switches to that colour while the layer is active, so you always know which layer you're on.
- **Tools**: brush (drag in the palette to grab multi-tile objects), eraser, bucket fill, rectangle fill, eyedropper, select & move, undo/redo.
- **Two palettes**: the left one shows the tileset picked in the list. Drag any tileset onto the right one to keep a second sheet open.
- **Dice**: paints a random tile from everything you've selected. Ctrl/Shift+drag in either palette adds more tiles to the mix, which is handy for sprinkling grass.
- **Stamps**: right-drag on the map to copy part of the active layer as a stamp. The last 3 stamps are listed bottom right and saved with the project.
- **Walls**: the Wall tool (`T`) marks tiles as walls. Walls only show while the tool is active. **Export walls** saves them as a separate PNG for the Foundry VTT module below. While the tool is active you also see a live preview of the walls Foundry will get: blue = see-through edge, black = blocks sight.
- **Outwalls**: with the Wall tool active, the **Outwall** button (or `T` again) switches to painting outwalls (cyan). Only their outline becomes walls: you bump into them but can see straight through, with no sight-blocking core inside.
- **Wall decorations**: the **+ Wall deco** button in the Layers panel adds a `WALLACCESSORY` layer (it greys out once that layer exists). Paint posters, banners and so on onto it. Their real pixels are used, so a decoration several tiles long counts as one shape. Each decoration faces a direction, set with the **arrow keys** before you paint: ↑ (default) means it's seen from below, ↓ from above, → from the left, ← from the right. An arrow on the brush shows the current direction. To turn decorations you already placed, select them on that layer and press an arrow key.
- **Axes**: tile x/y coordinates along the map edges (toggle with `X`).
- **Map size**: resize any time with an anchor. Tile size can be changed too.
- **Export PNG** at 1×–8× (or a custom width) with nearest-neighbour scaling, so pixels stay sharp. You can use a transparent or solid background.
- **Choose where to save**: exporting the map PNG or the walls PNG always opens a save dialog, reopening the folder you used last. Works in Chrome and Edge; other browsers download the file as usual.
- **Save/Open** projects as `.ponytiler.json` (images are embedded). Your work is also autosaved in the browser.
- **Maps in the browser**: File → **Save in browser** (`Ctrl+Shift+S`) keeps named maps in this browser; saving again updates the open one. File → **Browser maps…** lists them with thumbnails to open, rename, delete, or download each as its own `.ponytiler.json` (or **Download all** as separate files).
- The **grid opacity** level is remembered between sessions.

## Controls
| Action | Input |
| --- | --- |
| Paint | Left drag |
| Save a stamp | Right drag on the map (copies the active layer) |
| Mark / clear walls | Wall tool (`T`): left drag / right drag, Shift+drag for a rectangle |
| Wall ↔ outwall | `T` again while the Wall tool is active, or the Outwall button |
| Wall decoration facing | Arrow keys (turns the selection too, on the `WALLACCESSORY` layer) |
| Pan | Space + drag, or middle-mouse drag |
| Zoom | Mouse wheel, `+` / `-`, `0` = fit, Ctrl+0 = 100% and centre |
| Tools | `W` brush, `A` eraser, `S` fill, `D` rect, `F` pick (or Alt+click), `E` select |
| Previous brush | `Q` |
| Move the palette selection | Shift+`W` `A` `S` `D` (skips empty tiles) |
| Clear brush | Shift+Space |
| Unselect brush / selection | `Esc`, or ✕ next to the palette zoom |
| Selection | Drag inside to move, `Del` to clear, Ctrl+C to make a stamp |
| Grid / axes / focus layer | `G` / `X` / `L` |
| Layer up / down | `C` / `V` (or `]` / `[`) |
| Rename tileset or folder | Double-click it |
| Set tileset icon | Middle-click a tile in the palette (again to reset) |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Save / open / export | Ctrl+S / Ctrl+O / Ctrl+E |
| Save in browser | Ctrl+Shift+S |

## Foundry VTT walls module
`foundry/ponytiler-walls` is a Foundry VTT module (v12 and v13) that turns the walls PNG into real walls.

1. Copy the `ponytiler-walls` folder into `{userData}/Data/modules/` and enable **PonyTiler Walls** in your world.
2. In PonyTiler, export the map PNG and the walls PNG **at the same scale**.
3. In Foundry, use the map PNG as the scene background and place the walls PNG as a tile on top of it, at the same position and size.
4. Click the dungeon button. It's in the Walls tools on the left, and also in the tile's right-click HUD.

This is what you get:
- **Edge walls** along the outline of every wall area (walls and outwalls together). They block movement but not sight, so players can see the rim of a wall.
- **Sight-blocking walls** set a bit inside the wall area (not inside outwalls) (25% of a tile by default), so nobody sees through a wall or deep into it.
- Around **wall decorations** the sight blocker bulges away from the side the decoration faces, with some extra room (25% by default). A poster facing ↑ can be read from below, but from above you only see wall. Where a wall is too thin for that, the blocker squeezes down to a thin line instead of opening a hole.

Running it again replaces the walls it made from that tile. By default the tile is hidden afterwards.

PNG colours: red = wall tile (half-strength red = outwall), green = decoration pixel (yellow where both overlap). The blue channel stores the decoration's facing. The grid size is stored inside the PNG.
