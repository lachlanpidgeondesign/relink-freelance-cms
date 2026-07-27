---
name: hint-article-generator
description: 'Relink hint-article generator — create the Relink Dispatch article from a puzzle and choose useful non-impostor hint tiles. Use when: generating hint articles, deciding which safe tile to reveal in each row, or editing the hint-article template / selection heuristic.'
---

# Relink Hint Article Generator

Generate a Relink Dispatch hint article from a puzzle, using the puzzle JSON, the difficulty output, and a practical hint-selection heuristic.

## When to use

Use this skill when the user asks for:
- a hint article for a specific puzzle
- a better choice of hint tiles
- a way to decide which non-impostor tile to reveal in each row
- a reusable workflow for generating tomorrow's article

## Workflow

### 1. Load the puzzle

Read `save-data/l{N}.json` and confirm:
- the puzzle name and date
- the four rows sorted by `position`
- each row's tiles and which tile is the impostor

### 2. Load the article rating

Use `analytics/outputs/data/difficulty.json` as the default source of the article's rating.
- Prefer the algorithm's prediction when present.
- For undated or future puzzles, use the stored puzzle `rating` if `predicted_rating` is absent or null.
- Allow an explicit override when the user supplies one.

### 3. Choose the hint tile for each row

Think like a player who has already been playing the puzzle mid-game and may have made one or two mistakes.

Pick the non-impostor tile that is most likely to be useful **at that moment**, not necessarily the most obviously misleading tile.

Heuristic:
- Prefer a tile that gives the player something concrete to reason about.
- Prefer a tile that suggests a property, association, or structure they can test against the rest of the row.
- If a row has one obviously better teaching tile, choose that one.
- If several safe tiles are roughly equally useful, pick randomly.
- Do not overthink it; the goal is a helpful nudge, not a perfect spoiler strategy.

When a hint index is provided, use it as an explicit row-slot choice if it points at a non-impostor tile.

### 4. Generate the article

Fill the Relink Dispatch template with:
- the long-form date
- the difficulty rating and pip graphic
- one spoilered hint per row
- the row colours in easy-to-hard order: purple, blue, green, orange

## CLI convention

Use the generator script in `tools/`.

Example:
```bash
python3 tools/generate_hint_article.py l65
python3 tools/generate_hint_article.py l65 --hint-index 2
python3 tools/generate_hint_article.py l65 --hint-index 2,0,1,2
```

The `--hint-index` flag is a single flag that can take either:
- one value, broadcast to all four rows
- four comma-separated values, one per row

Each value is a raw tile slot index in the row, from `0` to `3`, and should point to a non-impostor slot.

## Decision style

Keep the decision lightweight.
- Imagine the reader is using the article as a mid-game hint.
- Prefer a hint that prompts a useful thought about the tile's properties and how those properties might combine with one or two other tiles in the row.
- If the row is ambiguous and no tile stands out, choose randomly.

## Output expectation

The generated article should be ready to paste into the content workflow as plain text. Keep the template tone aligned with the existing Relink Dispatch copy and the algorithm-based difficulty framing.