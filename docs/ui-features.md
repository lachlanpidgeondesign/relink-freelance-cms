# UI Features

## Puzzle List (Left Sidebar)

### Search

Instant filter-as-you-type search input with configurable search fields (name, id, tiles, categories, answer, decoy descriptions). Field selection persists in localStorage (`search-fields` key).

### Date Range Filters

Two flatpickr date inputs (`From` / `To`) that filter puzzles by their `date` field.

### Completeness Filters

A dedicated filter dropdown (filter icon button, next to date pickers) provides two three-state toggles:

- **Writing filter**: Off / Complete (✓) / Incomplete (✗)
- **PDL filter**: Off / Complete (✓) / Incomplete (✗)

Both filters use AND logic when active simultaneously. State persists in localStorage (`completeness-filters` key).

**Writing complete** (`isPuzzleWritingComplete()` in state.js) requires:
- Puzzle name non-empty
- All 4 row categories non-empty
- All 16 tiles have text
- Exactly 1 impostor per row
- At least 1 relink tile per row
- Relink answer non-empty

**PDL complete** (`isPuzzlePDLComplete()` in state.js) requires all row group/impostor PDL, connection identification PDL, answer construction PDL, and decoy PDL fields filled.

Both fields are stored in the puzzle index (`writingComplete`, `pdlComplete`) via `buildIndexEntry()` in fileio.js.

### Status Indicators

Each puzzle in the sidebar list shows a colour-coded status dot:

| Dot | Meaning |
|-----|---------|
| **Green** | Has `canonicalId` AND `date` ≤ today — currently live |
| **Amber** | Has `canonicalId` but no date or future date — linked but not yet released |
| **Green + amber outline** | Has `date` but no `canonicalId` — released/scheduled but not linked to analytics |
| **Grey** | No `date` and no `canonicalId` — design only |

### Sort Control

Sort puzzles by date, name, or ID (ascending/descending). Stored in localStorage (`sort-pref` key).

## Editor (Centre Panel)

- Puzzle header: read-only ID with copy-to-clipboard, name field, date picker, canonical ID input
- 4 colour-coded rows with category label and 4 tile inputs
- Tile toggle buttons for relink/impostor flags
- Row drag handles for reorder (pointer events, FLIP animation)
- Per-row **bank** and **import** buttons (see [Row Bank](#row-bank))
- Relink section: grid-sourced chips + fodder text inputs + answer field. Adjacent chips have a **link/unlink toggle** in the gap between them — clicking it smooshes the two tiles into a compound word (joined corners + split-colour bridge); click again to separate
- Decoy section: colour-coded cards with tile selector and PDL fields

## Row Bank

A reusable store of orphaned rows, persisted as `save-data/row-bank.json`. It replaces the old "holding puzzle" workflow (parking spare rows in a dummy puzzle).

### Opening

- **Header button** (`Row Bank`, box-archive icon) — opens the bank in *manage* mode.
- **Import button** (file-import icon) on any row — opens the bank in *pick* mode for that slot.

### Banking a row (extract)

Each row card has a **bank button** (box-archive icon), enabled only when the row has content. Clicking it:

- Copies the row (category, tiles, impostor/relink flags, group PDL) into the bank.
- Replaces the row in place with a fresh empty row, so the puzzle keeps its 4 rows.
- Strips the row's tiles from any decoys (deleting decoys left empty) and removes its relink contributions, then recomputes the answer and board stats.

### Authoring in the bank

In manage mode, **+ New row** adds a blank bank row you can edit inline (category, 4 tile inputs, one impostor toggle per tile). Edits autosave (debounced). The trash icon deletes a bank row (with confirmation).

### Importing a row

In pick mode, each bank card shows a preview and a **Use** button:

- **Empty target slot** — the banked row drops straight in and is removed from the bank.
- **Target slot has content** — a prompt asks what to do with the displaced row: **Save it to the bank**, **Discard it**, or **Cancel**.

Imported rows get fresh tile/row IDs and re-add their relink contributions automatically.

### Persistence & undo

`row-bank.json` is written whenever the bank changes (only when a folder is connected; in read-only HTTP mode the bank stays in memory). Banking and importing are **transactional with undo** — a single Ctrl/Cmd+Z reverses both the puzzle change and the matching bank change. Bank-only edits (authoring) are also undoable, even with no puzzle open.

## PDL Panel (Right Sidebar)

- Group PDL per row (multi-select dropdowns)
- Impostor domain per row
- Connection Identification PDL
- Answer Construction PDL
- Board-level auto-computed stats
- Schema editor modal (gear icon) for customising dropdown options

## Resizable Sidebars

- Left sidebar: 200–500px, drag handle on right edge
- Right sidebar: 250–500px, drag handle on left edge
- Pointer-based resize (not HTML5 drag)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd+S | Save |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z | Redo |
| Ctrl/Cmd+N | New puzzle |
| Escape | Clear selection / close modals |
