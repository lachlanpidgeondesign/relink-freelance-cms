# Code Conventions & Pitfalls

## Conventions

- **DOM lookups**: `const $ = id => document.getElementById(id)`
- **XSS prevention**: Use `esc()` for all user text rendered in HTML
- **Puzzle IDs**: Sequential `l{N}` codes auto-generated via `generatePuzzleId()` (finds highest existing l-number in the index, returns `l{max+1}`)
- **Tile/row/decoy IDs**: Format `{type}-{timestamp}-{counter}`
- **Relink sync**: Call `rebuildRelinkTiles()` whenever tile text changes or relink toggles change — syncs grid-sourced chips with current tile text
- **Relink answer is derived**: `relink.answer` is auto-computed from the relink tiles + fodder (display order) via `deriveRelinkAnswer()` / `syncRelinkAnswer()`; there is no manual answer input. `normalizeDerivedData()` backfills it (and board stats) to disk on Refresh Index
- **Drag system**: Custom pointer-event-based system for row reordering, not HTML5 drag-and-drop
- **SVG in innerHTML**: Always use explicit close tags (`<path ...></path>`, `<line ...></line>`) — self-closing tags break

## Common Pitfalls

### Focus loss on typing

If `innerHTML` rebuilds a parent while an input is focused, the user loses their cursor. Check for focused inputs and use in-place DOM patching instead.

### SVG icons not rendering

Use explicit close tags in innerHTML context. Add `xmlns` on dynamically created SVGs if needed.

### Click handlers missing child elements

Buttons with Font Awesome `<i>` icons or SVG require `t.closest('#btn-id')` instead of `t.id === 'btn-id'`.

### Grid auto tracks not collapsing

Collapsed sidebars need `max-width: 0` in addition to `width: 0` when the grid uses `auto` track sizing.

### Relink tiles stale text

Always call `rebuildRelinkTiles()` in state.js when tile text changes, not just when relink is toggled.

### VS Code Simple Browser

Does not support File System Access API — use Chrome/Edge at localhost:8080.

### Server port conflicts

If the server fails with "Address already in use", a stale process occupies the port. Run `kill -9 $(lsof -ti :8080)` to free it. The launcher script does this automatically on start.
