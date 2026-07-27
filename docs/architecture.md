# Architecture

## Technology

Vanilla HTML/CSS/JS — no build step, no Node.js, no frameworks. ES modules loaded directly via `<script type="module">`. Runs via a custom Python HTTP server (`python3 server.py 8080`). Must be opened in Chrome or Edge (File System Access API required).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page app shell (3-column grid layout). `pagehide` listener fires `navigator.sendBeacon('/shutdown')` to stop the server on tab close. |
| `server.py` | Custom Python HTTP server. Adds `POST /shutdown` endpoint that stops the server and kills the parent shell process. `allow_reuse_address = True` for immediate port reuse. |
| `Launch CMS.command` | macOS double-click launcher (bash). Kills stale servers, starts `server.py`, opens Chrome. EXIT trap cleans up on Terminal close. |
| `css/styles.css` | All styles — shadcn/ui-inspired design tokens as CSS variables. |
| `js/app.js` | Rendering, event delegation, drag-and-drop (~1200 lines). |
| `js/state.js` | Observable store: `dispatch(action)` / `subscribe(fn)` + undo/redo history. |
| `js/constants.js` | PDL dropdown defaults, row colours, decoy colours, connection types, `CANONICAL_ID_RE` regex. |
| `js/schema.js` | User-editable PDL schema: getters, load/save, change subscription. Falls back to constants.js. |
| `js/fileio.js` | File System Access API persistence + IndexedDB handle storage. |
| `js/export.js` | CSV, TSV, JSON, PDL summary export utilities. |
| `js/seed-puzzles.js` | 9 built-in example puzzles. |
| `tools/` | Python/Node utility scripts (CSV converter, decoy injector, migration, etc.). |
| `analytics/` | Integrated analytics pipeline — scripts, raw data, outputs, and dashboard. |

## Key Patterns

### State Management

Single `_state` object mutated inside `dispatch()`. Listeners notified via `notify()`. Never replace the state object — always mutate in place.

### Undo/Redo

History stack of JSON-serialised snapshots (max 50), each capturing **both** the current puzzle and the row bank so coupled actions (e.g. banking a row) undo atomically. Snapshots taken before every mutating dispatch. Non-mutating actions (`SET_SELECTION`, `TOGGLE_TILE_SELECTION`, `CLEAR_SELECTION`, `SET_DIR_HANDLE`, `SET_INDEX`, `MARK_SAVED`, `SET_ROW_BANK`) are excluded. Row-bank actions record history even when no puzzle is loaded. History resets on puzzle switch. Exports: `undo()`, `redo()`, `canUndo()`, `canRedo()`.

### Event Delegation

Two top-level listeners on `document` — one for `click`, one for `input`. All UI events handled by checking `e.target` or `e.target.closest()`. Always use `closest()` for buttons containing SVG/Font Awesome icons.

### Rendering

`render()` rebuilds DOM via `innerHTML`. When a focused input exists inside rows, in-place DOM patching is used to avoid losing focus.

### Persistence

File System Access API writes JSON files to a user-selected folder. IndexedDB stores the directory handle across sessions (Chrome will prompt for re-authorization on each new session). Falls back to client-side download if no folder connected. **No auto-save** — saving is manual only (Save button or Ctrl/Cmd+S).

- **Save**: Overwrites the current `{id}.json` file.
- **Save As**: Deep-copies the puzzle, assigns a new auto-generated ID, saves as a new file.

### Server Lifecycle

`server.py` has a `/shutdown` POST endpoint. `index.html` fires `navigator.sendBeacon('/shutdown')` on `pagehide` (tab close). The server calls `server.shutdown()` for clean socket release, then sends `SIGTERM` to its parent shell process.

### PDL Schema

Option lists for PDL dropdowns are user-editable via `schema.js`. Defaults come from `constants.js`. Schema is persisted as `pdl-schema.json` in the connected directory. `app.js` calls getter functions (e.g. `getKnowledgeLevels()`) instead of importing constant arrays directly. The schema modal (gear icon in header) uses tag-input UI to add/remove options per field.

### Row Bank

A reusable store of orphaned rows, held in `_state.rowBank` and persisted as `row-bank.json` in the connected directory (HTTP fallback is read-only, in-memory only). Lets editors lift a row out of a puzzle (`BANK_ROW`), author rows directly (`ADD_BANK_ROW` and friends), and drop a banked row back into a slot (`IMPORT_ROW`). `BANK_ROW`/`IMPORT_ROW` run cleanup (strip relink contributions + decoy tile references, recompute derived data) and are transactional with undo. Loaded via `loadRowBank()` / written via `saveRowBank()` in `fileio.js`. See [ui-features.md](ui-features.md#row-bank).

## Design System

- **Font**: Plus Jakarta Sans (Bunny Fonts CDN)
- **Icons**: Font Awesome 6.5.1 (cdnjs CDN) — `<i class="fa-solid fa-...">`. No emoji icons.
- **Row colours**: Purple `#9B95F0`, Blue `#94CAFF`, Green `#66E0C4`, Orange `#F8CD8B`
- **Decoy colours**: 12-colour palette in `DECOY_COLOURS` (constants.js), cycling across decoy groups
- **CSS variables**: `--background`, `--foreground`, `--muted`, `--border`, `--ring`, `--destructive`, `--success`, `--row-0` through `--row-3`
- **Date pickers**: flatpickr (CDN)
- **Decoy ring wrapper**: `.decoy-ring` div around each tile input — transparent by default, coloured border when tile is in a decoy group. Multi-decoy tiles use `::before` pseudo-element with `conic-gradient` and mask-composite for segmented outlines.
