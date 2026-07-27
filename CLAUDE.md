# Relink Puzzle CMS — Claude Code Guide

## Project Overview

Vanilla HTML/CSS/JS web application — **no build step, no Node.js, no frameworks**. Two companion pieces share the repo: the editorial **CMS** (create/edit puzzles), a player-facing **deep-dive** analytics page, and a Python **analytics pipeline**. Runs via `python3 server.py 8080`. Must be opened in **Chrome/Edge** (the File System Access API is required; Firefox, Safari, and the VS Code Simple Browser will not work).

## Quick Start / Running

```bash
# CMS — main editorial app
python3 server.py 8080
# → open http://localhost:8080 in Chrome/Edge.  Port busy? kill -9 $(lsof -ti :8080)

# Deep-dive — post-game analytics page for a single puzzle
cd deep-dive && python3 ../server.py 3000
# → http://127.0.0.1:3000/deep-dive/index.html

# Analytics — main pipeline runs on SYSTEM Python (no Docker needed)
python3 analytics/scripts/pdl_analysis.py
python3 analytics/scripts/pdl_analysis.py --cache          # forecast-only refresh (undated edits); carries the prior LOO forward
python3 analytics/scripts/pdl_analysis.py --cache --loo    # recompute the honest leave-one-out validation (after DATED-puzzle edits)
# Every OTHER analytics script needs Docker (see analytics-pipeline skill)
```

## Repo Map

| Path | What it is |
|------|------------|
| `server.py` | Custom Python HTTP server (`/shutdown`; `/api/push` + `/api/pull` live-sync proxy); serves CMS and deep-dive |
| `js/` | Frontend ES modules — `app.js` (rendering, drag/drop, events), `state.js` (store + undo/redo), `schema.js` (PDL schema getters), `fileio.js`, `export.js`, `constants.js`, `seed-puzzles.js` |
| `css/styles.css` | All CMS styles (shadcn/ui-inspired tokens, row colours, grid) |
| `save-data/` | Canonical puzzle JSON files `l{N}.json` + `puzzles-index.json` + `pdl-schema.json` |
| `tools/` | Python/Node utilities — `puzzlr_api.py` (live API sync), `check_pdl.py`, `add_decoys.py`, `rebuild_index.py`, migrations |
| `analytics/` | Player-behaviour pipeline (`scripts/`, `lib/`, `outputs/`) + Chart.js `dashboard/` |
| `deep-dive/` | Post-game scrollytelling page (`index.html`, `js/`, `generate-data.py`) |
| `docs/` | Project documentation (see below) |

## Tech Stack

- **Frontend:** vanilla HTML/CSS + ES modules (`<script type="module">`), no bundler. CDN libs: Font Awesome 6.5.1, flatpickr (date picker), Chart.js v4 (dashboard/deep-dive). Browser APIs: File System Access, IndexedDB.
- **Backend/Analytics:** Python 3.12. Key libs (in `requirements.txt`): pandas, numpy, scipy, scikit-learn, statsmodels, CatBoost, matplotlib. Docker (Compose) for the analytics environment; the CMS itself needs no Docker.

## Documentation

- [docs/architecture.md](docs/architecture.md) — files, key patterns, state management, rendering, persistence, design system
- [docs/domain.md](docs/domain.md) — puzzle structure, PDL system, decoys, auto-computed fields, analytics
- [docs/ui-features.md](docs/ui-features.md) — search, filters, status indicators, keyboard shortcuts, sidebars
- [docs/conventions.md](docs/conventions.md) — code conventions, common gotchas
- [docs/puzzlr-api.md](docs/puzzlr-api.md) — live Puzzlr API sync: push/pull CLI (`tools/puzzlr_api.py`) + CMS Push/Pull buttons
- [analytics/README.md](analytics/README.md) — game rules, PDL reference, full pipeline docs (note: some figures predate the current schema; trust `docs/domain.md` and the `pdl-tagger` skill for PDL specifics)
- `deep-dive/docs/` — deep-dive sections, data model, charts

## AI-Specific Guidance

### State Mutations
- Always mutate `_state` **in place** inside `dispatch()` — never replace the state object.
- Call `rebuildRelinkTiles()` whenever tile text or relink toggles change.
- Non-mutating actions are excluded from undo history: `SET_SELECTION`, `TOGGLE_TILE_SELECTION`, `CLEAR_SELECTION`, `SET_DIR_HANDLE`, `SET_INDEX`, `MARK_SAVED`.

### Rendering
- `render()` uses `innerHTML` — check for focused inputs before rebuilding parents (use in-place DOM patching to avoid focus loss).
- SVG in innerHTML: always use explicit close tags (`<path ...></path>`, not `<path/>`).
- Click handlers on icon buttons: use `t.closest('#btn-id')`, not `t.id === 'btn-id'`.

### Auto-Computed Fields — Do NOT Add Manual Inputs
These derive from puzzle state automatically:
- Decoy: `completeness`, `groupsSpanned`, `type`
- Board: `specialistGroupCount`, `decoyCount`, `phase2TileCount`

### File Patterns
- All JS is ES modules via `<script type="module">`.
- DOM lookups: `const $ = id => document.getElementById(id)`.
- XSS: use `esc()` for all user text rendered in HTML.
- Puzzle IDs: `l{N}` auto-generated; tile/row/decoy IDs use `{type}-{timestamp}-{counter}`.
- Icons: Font Awesome 6.5.1 (`<i class="fa-solid fa-...">`). No emoji icons.
- Event delegation: top-level `click` + `input` listeners on `document`, dispatching via `e.target` / `e.target.closest()`.

### PDL Schema
`app.js` calls getter functions (e.g. `getKnowledgeLevels()`) from `schema.js` — never import constants directly. The schema is user-editable and persisted as `pdl-schema.json`.

### Server
VS Code Simple Browser doesn't work — always use Chrome/Edge at localhost:8080. If the port is busy: `kill -9 $(lsof -ti :8080)`.

### Analytics (Docker)
Most Python analytics scripts run inside Docker. **Exception: `pdl_analysis.py` runs with system Python** (no Docker). New player data (raw CSVs changed) → `docker compose run --rm refresh`; the behaviour cache updates incrementally (only new/boundary spreadsheets are re-parsed), so host-warming is only needed for a cold/first-time cache. The refresh's long loops (honest LOO + derive-params sweep) checkpoint per fold under `analytics/.cache/`, so an interrupted run resumes from the last fold rather than restarting. Add Python libraries by appending to `requirements.txt`, then `docker compose up --build`. See the `analytics-pipeline` skill for details.

## Skills

Four project skills are available (`.claude/skills/`, symlinked to `.github/skills/` so Copilot shares them):

- **`pdl-tagger`** — tag a puzzle with PDL metadata, identify/label decoys, suggest schema changes. Reach for it on requests like "tag l10".
- **`deep-dive`** — any work in `deep-dive/`: data generation, unlinked cards, vertical decoys, share grid, replay, charts.
- **`analytics-pipeline`** — running/regenerating analytics, editing `analytics/scripts/**`, the simulator, or dashboard data.
- **`hint-article-generator`** — generate Relink Dispatch hint articles and choose useful non-impostor hint tiles (random by default, index-guided when needed).
