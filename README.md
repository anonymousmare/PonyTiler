# PonyTiler

A small Tiled-style map editor that understands **RPG Maker MV tilesets** (A1–A5, B–E) and exports crisp, pixel-perfect PNGs. It runs entirely in the browser, with no install or build step.

## Run it
Open `index.html` in Chrome, Edge or Firefox. That's it.

## Features
- **RPG Maker MV images**: A1 (water/waterfalls), A2 (ground), A3 (buildings) and A4 (walls) work as real **autotiles** that join up with their neighbours. A5 and B–E sheets, or any other sprite sheet, work as normal tiles.
- **Any tile size** (default **32×32**). MV's 48 px sheets are detected from the file name (`Outside_A2.png`, `Inside_B.png`, …) and rescaled to your tile size on import.
- **Folders**: sort tilesets into nested folders by drag-and-drop. You can rename, filter and delete them.
- **Layers**: add, duplicate, delete, reorder (drag or ▲▼), show/hide, lock, opacity, and "Focus layer" to dim the others.
- **Tools**: brush (drag in the palette to grab multi-tile objects), eraser, bucket fill, rectangle fill, eyedropper, select & move, undo/redo.
- **Two palettes**: the left one shows the tileset picked in the list. Drag any tileset onto the right one to keep a second sheet open.
- **Dice**: paints a random tile from everything you've selected. Ctrl/Shift+drag in either palette adds more tiles to the mix, which is handy for sprinkling grass.
- **Stamps**: right-drag on the map to copy part of the active layer as a stamp. Stamps are listed bottom right and saved with the project.
- **Axes**: tile x/y coordinates along the map edges (toggle with `X`).
- **Map size**: resize any time with an anchor. Tile size can be changed too.
- **Export PNG** at 1×–8× (or a custom width) with nearest-neighbour scaling, so pixels stay sharp. You can use a transparent or solid background.
- **Save/Open** projects as `.ponytiler.json` (images are embedded). Your work is also autosaved in the browser.

## Controls
| Action | Input |
| --- | --- |
| Paint | Left drag |
| Save a stamp | Right drag on the map (copies the active layer) |
| Pan | Space + drag, or middle-mouse drag |
| Zoom | Mouse wheel, `+` / `-`, `0` = fit, Ctrl+0 = 100% and centre |
| Tools | `W` brush, `A` eraser, `S` fill, `D` rect, `F` pick (or Alt+click), `E` select |
| Previous brush | `Q` |
| Unselect brush / selection | `Esc`, or ✕ next to the palette zoom |
| Selection | Drag inside to move, `Del` to clear, Ctrl+C to make a stamp |
| Grid / axes / focus layer | `H` / `X` / `L` |
| Switch layer | `[` / `]` |
| Rename tileset or folder | Double-click it |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Save / open / export | Ctrl+S / Ctrl+O / Ctrl+E |
