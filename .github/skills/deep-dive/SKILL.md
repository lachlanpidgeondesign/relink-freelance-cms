---
name: deep-dive
description: 'Relink Deep Dive page — the post-game analytics page for a single puzzle. Use when: editing deep-dive/ files, generating data, modifying unlinked cards, vertical decoys, share grid, replay, charts, or any deep-dive UI/data work.'
---

# Relink Deep Dive

## What It Is

A single-page scrolling analytics report shown to players after completing a Relink puzzle. Displays solve rates, mistake breakdowns, replay animations, and a shareable results grid.

## Project Structure

```
deep-dive/
├── index.html          # Page shell (sections rendered by JS)
├── css/styles.css      # All styles (single file)
├── js/
│   ├── app.js          # Main controller: inits sections, scroll observer
│   ├── data.js         # Generated data module (DO NOT HAND-EDIT)
│   ├── charts.js       # Bar charts, solve order, wrong guesses
│   ├── grid.js         # Share grid rendering + copy
│   └── replay.js       # Animated puzzle replay
└── generate-data.py    # Pipeline: analytics JSON → data.js
```

## Running

```bash
cd deep-dive && python3 ../server.py 3000
# Open http://127.0.0.1:3000/deep-dive/index.html in Chrome/Edge
```

## Data Pipeline

`generate-data.py` produces `js/data.js`. Inputs:
- `save-data/{lid}.json` — CMS puzzle definition (rows, tiles, impostors, relink)
- `analytics/outputs/data/puzzle-explorer.json` — aggregated player stats
- `analytics/outputs/data/vertical-inference.json` — vertical decoy detection

Usage:
```bash
python3 generate-data.py --date 2026-05-09
python3 generate-data.py --lid l44
```

Interactive prompt asks for **perceived links** — what connection players thought the 3 kept tiles shared when they selected the wrong impostor.

### Exports in data.js

| Export | Purpose |
|--------|---------|
| `puzzle` | Metadata: id, name, date, rows (tiles, impostor, colour), relink |
| `stats` | Aggregate: solveRate, difficulty, rowFailureRates, mistakeDistribution, phiMatrix, solveOrderDist |
| `player` | Sample player journey (median-like) |
| `mistakeExplanations` | Per-row top wrong tile + pct + perceivedLink |
| `relinkMistakes` | Relink first-try pct, most common wrong tiles |
| `verticalInference` | Vertical decoy data (hasVertical, tiles, coherenceDetail) |

## Game Domain (Critical)

### Puzzle Structure
- 4 rows × 4 tiles. Each row has 1 **impostor** (doesn't belong) + 3 genuine group members.
- Players select 1 tile per row as the impostor. The other 3 form the group.
- After 4 rows, the 4 impostors spell out a **relink** connection.
- Players get 4 lives total. Each wrong guess = 1 life lost. 0 lives = game over.
- **No retries** — one attempt per puzzle per player per day.

### Mistakes (Unlinked Cards Section)
- A **mistake** = player selected a genuine tile as the impostor (wrong exclusion).
- `mistakeExplanations[i].topWrong` = the genuine tile most often wrongly selected.
- `mistakeExplanations[i].pct` = % of all players who made THIS specific mistake.
- The 3 tiles kept when a mistake is made = `row.tiles.filter(t => t !== topWrong)`.

### Vertical vs Horizontal Mistakes
- **Horizontal mistake**: Player misjudged within a single row (thought a genuine tile was the odd one out).
- **Vertical mistake**: Player excluded a tile because a **cross-row decoy** (vertical red herring) made it look like it belonged to another row's theme.
  - Example: "Tesla" excluded from "Silicon Valley firms" because Tesla + Car (another row) = "Car themed things"
- `verticalInference.hasVertical` indicates whether the puzzle has detected vertical decoys.
- Only tiles appearing in `verticalInference.vertical.tiles` are vertical mistakes.

### Perceived Links ("Was the link...?")
- For each mistake, the perceived link = the connection a player imagined among the 3 **kept** tiles (the ones left after they wrongly removed the top-wrong tile).
- **Derive it from the kept tiles alone — ignore the real category, the puzzle theme, and any cross-row context.** The only question is: "someone thought these three tiles were linked; what did they think it was?"
- Anchor on the **two strongest** tiles that share an obvious link; the third only needs to *sort of* fit. It often won't fit cleanly — that's expected, don't force all three.
- Keep it to a short **noun phrase**. The template appends "?" automatically, so don't add one and don't write a full sentence or reference the actual answer.
  - e.g. kept Medal/Stones/World Cup → `Prizes`; Pickford/Charlton/Moore → `Famous England footballers`; Vindaloo/Burn/Nah → `Things that burn`; West Ham/Squad/Rice → `West Ham`.
- The prompt is interactive (press Enter to skip). If skipped, you can hand-fill `perceivedLink` in the generated `data.js` afterwards — but it's a generated file, so re-running `generate-data.py` will overwrite it (re-enter at the prompt instead when regenerating).
- Empty `perceivedLink` = not yet filled in (shows as "Was the link... ?").

## UI Architecture

### Sections (scroll order)
1. **Header** — Puzzle name, date
2. **Stats** — Solve rate, difficulty badge, time
3. **Unlinked Cards** (sticky within `.vertical-scroll-track`) — Per-row mistake cards
4. **Relink** — Impostor assembly + relink mistakes
5. **Charts** — Solve order, wrong guess distributions
6. **Share** — Grid + copy button

### Unlinked Cards Detail
- Column header: "% of players who made this mistake" (above first card)
- Each card shows: category, wrong tile + pct, 3 kept tiles, perceived link
- Impostor tile gets `2px solid #1a1a2e` outline + arrow annotation (first card only)
- Vertical tiles marked with `.unlinked-card__wrong-col--vertical` class
- Scroll-driven transition: at 30% through scroll track, switches to "vertical red herring" mode

### CSS Conventions
- Custom properties: `--row-purple`, `--row-blue`, `--row-green`, `--row-orange` (+ `-bg` variants)
- Card accent: `--card-accent` / `--card-accent-bg` set per-card via inline style
- `[data-reveal]` + `--delay` for staggered entrance animations
- Single stylesheet, no preprocessor

### JS Conventions
- ES modules (`<script type="module">`)
- No framework — vanilla DOM manipulation
- `app.js` imports from `data.js` and orchestrates init functions
- Scroll observer uses IntersectionObserver for reveal animations
- Event delegation where appropriate

## Common Tasks

### Adding a new stat/section
1. Add HTML shell in `index.html`
2. Create `initSectionName()` in `app.js`
3. Call it from the init block at bottom of `app.js`
4. Add data export from `generate-data.py` if needed

### Changing unlinked card layout
- Edit `initUnlinked()` in `app.js` (builds cards via DOM)
- Styles in `css/styles.css` under `.unlinked-card*` selectors
- Grid layout: `.unlinked-cards__header` matches card grid

### Regenerating data for a puzzle
```bash
cd deep-dive
python3 generate-data.py --date YYYY-MM-DD
```
Then refresh the browser. The perceived links prompt is interactive — press Enter to skip.

### Changing vertical scroll behavior
- `setupVerticalScroll()` in `app.js`
- Track element: `#vertical-scroll-track` wraps the sticky section
- Threshold at `progress > 0.3` triggers vertical mode

## Gotchas
- **Never hand-edit `data.js`** — it's generated. Changes will be overwritten.
- **Impostor arrow** is only on the first card (i===0) to avoid clutter.
- **SVG close tags** required in innerHTML (use `<path></path>` not `<path/>`).
- **Port 3000** for deep-dive server (vs 8080 for main CMS).
- `perceivedLink` can be empty string — UI shows "Was the link... ?" regardless.
