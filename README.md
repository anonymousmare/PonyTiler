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
- **Stamps**: right-drag on the map to copy part of the active layer as a stamp. The last 3 stamps are listed bottom right and saved with the project.
- **Walls**: the Wall tool (`V`) marks tiles as walls. Walls only show while the tool is active. **Export walls** saves them as a separate PNG for the Foundry VTT module below. Tiles on a layer named `WALLACCESSORY` are framed in yellow and marked in that PNG too.
- **Axes**: tile x/y coordinates along the map edges (toggle with `X`).
- **Map size**: resize any time with an anchor. Tile size can be changed too.
- **Export PNG** at 1×–8× (or a custom width) with nearest-neighbour scaling, so pixels stay sharp. You can use a transparent or solid background.
- **Save/Open** projects as `.ponytiler.json` (images are embedded). Your work is also autosaved in the browser.

## Controls
| Action | Input |
| --- | --- |
| Paint | Left drag |
| Save a stamp | Right drag on the map (copies the active layer) |
| Mark / clear walls | Wall tool (`V`): left drag / right drag, Shift+drag for a rectangle |
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

## Foundry VTT walls module
`foundry/ponytiler-walls` is a Foundry VTT module (v12 and v13) that turns the walls PNG into real walls.

1. Copy the `ponytiler-walls` folder into `{userData}/Data/modules/` and enable **PonyTiler Walls** in your world.
2. In PonyTiler, export the map PNG and the walls PNG **at the same scale**.
3. In Foundry, use the map PNG as the scene background and place the walls PNG as a tile on top of it, at the same position and size.
4. Click the dungeon button. It's in the Walls tools on the left, and also in the tile's right-click HUD.

This is what you get:
- **Edge walls** along the outline of every wall area. They block movement but not sight, so players can see the rim of a wall.
- **Sight-blocking walls** set a bit inside the wall area (25% of a tile by default), so nobody sees through a wall or deep into it.
- Around **WALLACCESSORY** tiles the sight blocker moves back, with some extra room (25% by default), so decorations hung on walls stay visible. Where a wall is too thin for that, the blocker squeezes down to a thin line instead of opening a hole.

Running it again replaces the walls it made from that tile. By default the tile is hidden afterwards.

PNG colours: red = wall, green = accessory, yellow = both. The grid size is stored inside the PNG.
