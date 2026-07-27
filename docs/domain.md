# Domain Concepts

## Puzzle Structure

- Each puzzle has an **id** (unique string, e.g. `l1`, `seed-1`, `p-{timestamp}-{counter}`), an optional **date**, and an optional **canonicalId**
- **canonicalId**: Links a CMS puzzle to its deployed instance in the live game. Format: two lowercase-alphanumeric segments joined by hyphen (validated by `CANONICAL_ID_RE = /^[a-z0-9]+-[a-z0-9]+$/`). Only assigned when a puzzle goes live. Used by the analytics pipeline to match player events to puzzle designs.
- Puzzles are stored as `{id}.json` files; the index keys on `id`
- **4 rows**, each with a **category** and **4 tiles**
- Each tile can be tagged as **relink** (goes to Phase 2) or **impostor** (doesn't belong) — these are mutually exclusive
- **Relink section** (Phase 2): Contains tiles tagged from the grid plus "fodder" tiles (free text). These form a meta-connection. The `relink.answer` string is **auto-derived** from these tiles + fodder joined in display order (not manually typed)
  - **Smoosh (compound link)**: adjacent relink tiles can be linked into a compound word (e.g. `Clean` + `Ing` → "Cleaning"). A linked tile carries `joinNext: true` in `relink.tiles[]`, meaning "no gap before the next tile". The flag is purely visual/structural — the derived `relink.answer` stays space-joined (see Auto-Computed Fields). The last tile can never be linked.
- **Decoys**: Groups of tiles within the same row (or across rows) that create a convincing false theme. Each decoy has colour-coded outlines and a corresponding card in the decoy section

## PDL (Puzzle Difficulty Level)

All PDL value fields are **arrays of strings** (e.g. `["Common cultural"]` or `["Science", "History"]`), or `null` when unset. The UI uses multi-select checkbox dropdowns.

### Per-Row PDL

| Dimension | Applies to | Fields |
|-----------|-----------|--------|
| **Group PDL** | Every row | knowledge, manipulation, abstraction, knowledgeDomain, nicheKnowledge |

> Note: an earlier draft of these docs described a per-row "Impostor PDL" field (`realIdentityDomain`). That field never existed in the CMS (it appears only in legacy v1 import data); impostor metadata lives at the puzzle-level `impostorColumn.pdl` since schema v3.

### Niche Knowledge (`nicheKnowledge`) — obscurity axis

A 3-level ordinal axis (`Ubiquitous` → `Mainstream` → `Niche`) tagged on **group rows** and the **impostor column**, separate from `knowledge`. Where `knowledge` rates the *breadth* of knowledge required, `nicheKnowledge` rates the *obscurity* of the specific tiles shown — two `Common cultural` rows can differ sharply (e.g. "School subjects" vs "PlayStation buttons"). Judge the actual tiles, not the category label, and treat `Niche` as the generous bucket. See [pdl-glossary.md §4b](pdl-glossary.md) for the binding rubric. Untagged elements carry an `Unrated` sentinel in analytics. Both the group-row axis (Phase-1 impostor spotting) and the connection axis (Phase-2 relink) feed the Monte-Carlo simulator, and the axis appears as a "Niche Knowledge" chart on the dashboard's Difficulty Drivers page.

### Relink PDL

Split into two independent tag sets stored at `puzzle.relink.pdl`:

- **Connection Identification**: `{ manipulation, knowledge, abstraction, knowledgeDomain }` — what connects the 4 impostors?
- **Answer Construction**: `{ manipulation, knowledge }` — how do tiles combine to spell the answer?

Manipulation options differ per side:
- Connection ID: None, Hidden word, Compound, Letter add-delete, Homophone
- Answer Construction: None, Compound, Word split, Hidden word, Phrase

Dispatch actions: `UPDATE_CONNECTION_ID_PDL`, `UPDATE_ANSWER_CONST_PDL`
Status functions: `getConnectionIdPDLStatus()`, `getAnswerConstPDLStatus()`

### Decoy PDL

- knowledge, manipulation, abstraction, description
- Auto-computed: completeness, groupsSpanned, **type** (Exclusive / Inclusive / Confusion)

### Board PDL

Auto-computed: specialistGroupCount, decoyCount, phase2TileCount + manual: isThemed, themeDomain

## Auto-Computed Fields

These fields derive from puzzle state — do NOT add manual inputs for them:

| Field | Logic |
|-------|-------|
| **Relink answer** | Relink tiles + fodder joined in display order via `deriveRelinkAnswer()`; kept in sync by `syncRelinkAnswer()` on every relink change and on load. Always **space-joined** — the `joinNext` smoosh flag does not affect this string |
| **Decoy completeness** | Full horizontal / Full vertical / Partial / Over-full (based on tile row distribution) |
| **Decoy groupsSpanned** | Row indices of selected tiles |
| **Decoy type** | Auto-classified via `computeDecoyType()` in app.js (see below) |
| **Board specialistGroupCount** | Count of rows where `knowledge` includes `'Specialist cultural'` |
| **Board decoyCount** | `puzzle.decoys.length` |
| **Board phase2TileCount** | Grid-sourced relink tiles count |

> **Refresh Index backfill:** `normalizeDerivedData()` (state.js) writes the derived relink answer and the board stats onto each puzzle file during `rebuildIndex()` (fileio.js). Files are only rewritten when a value actually changed, so a Refresh persists any drifted derived data to disk.

### Decoy Type Classification

- **Exclusive**: 3 tiles from 1 row including impostor — frames the unselected 4th tile as the impostor
- **Inclusive**: Single non-impostor tile (false suspect) or cross-row tiles forming a false answer set
- **Confusion**: Tiles share a secondary link that muddies the row category (2-tile pairs, 3 non-impostors, full row, mixed cross-row without impostor)
- **Invalid (PDL incomplete)**: Lone impostor selected — should use full row (H4) instead

## Schema Versioning

Current schema version is `3`. Files saved as earlier versions are auto-migrated via `migratePuzzle()` in state.js:

- **v1 → v2**: Single `metaConnection` PDL block split into `connectionIdentification` / `answerConstruction`
- **v2 → v3**: `relink.pdl.connectionIdentification` moved to puzzle-level `impostorColumn.pdl` (reflects that the impostor column is a board-level concept, not tied to the relink phase)

## Analytics Integration

The `/analytics/` folder contains the analysis pipeline:

- **Puzzle data**: Read from root `save-data/` (the CMS's canonical files)
- **Raw CSVs** (player events/sessions): Stored in `analytics/raw_data/` (gitignored, 900MB+)
- **Pipeline output**: Written to `analytics/outputs/data/` for the dashboard to consume
- Puzzles matched to player events via `canonicalId` → `level_id` in event properties
- Players cannot retry puzzles — one attempt per puzzle per day. Each `level_completed` event is a unique player.

## Vertical Decoys (Cross-Row Red Herrings)

A **vertical decoy** is a designed cross-row red herring — tiles drawn from **2+ different rows** that share a convincing but false theme. "Vertical" because they span *down* the grid (across rows), versus "horizontal" decoys within a single row.

### Decoy Completeness (Spatial Layout)

| Completeness | Condition |
|---|---|
| Full horizontal | All 4 tiles from 1 row |
| Partial horizontal | <4 tiles from 1 row |
| Full vertical | Exactly 1 tile from each of all 4 rows |
| Partial vertical | 1 tile per row, 2–3 rows only |
| Over-full | More tiles than rows spanned |

### How Vertical Decoys Create Mistakes

A vertical decoy works by making a tile in one row seem to "belong" with tiles in other rows. This causes two distinct mistake patterns:

1. **The wrong tile IS part of the vertical decoy**: Players exclude it from its correct row because they perceive it as part of the cross-row false theme. Example: Players exclude "Tesla" from "Silicon Valley firms" because they group it mentally with "Car" from another row (vertical decoy = "Car themed things").

2. **The wrong tile is NOT part of any vertical decoy**: Players simply misjudge which tile is the impostor within the row, based on the row's own category logic. Example: Players wrongly exclude "To kill" from "You need a licence for it" because "a licence to kill" feels too literal/obvious — not because of any cross-row pull.

### Deep Dive: "Was the link...?" (Perceived Link)

In each row, a player selects one tile as the impostor. The remaining 3 tiles form a group with an inferred link:
- **Correct selection**: The remaining 3's link = the real row category
- **Wrong selection**: The remaining 3 have a *perceived* link — what the player thought connected them

Two distinct error patterns:

**Horizontal mistake** (non-vertical): Player misjudged which tile was the impostor based on row logic alone. The perceived link describes the alternative connection between the 3 tiles they kept. Example:
- Row: "You need a licence for it" [Fishing, To kill, Pixel, TV], impostor=Pixel
- Wrong selection: To kill → kept Fishing, Pixel, TV
- Perceived link: "Things with TV licences" (they thought Fishing/Pixel/TV were connected differently)

**Vertical mistake**: Player excluded a tile because they perceived it as part of a cross-row group (the vertical decoy). They may have correctly identified the row's category but thought the excluded tile was the impostor because it seemed to "belong elsewhere." Example:
- Row: "Silicon Valley firms" [Google, Drive, Apple, Tesla], impostor=Drive
- Wrong selection: Tesla → kept Google, Drive, Apple
- Player thought Tesla was the impostor because it seemed like a "car company" not a tech firm (vertical decoy pulled it toward Car in another row)
- Perceived link: might still resemble the real category, or might be a narrower interpretation like "Tech brands"

### Vertical Inference Analysis

The analytics pipeline (`vertical_inference.py`) measures whether annotated vertical decoys actually attracted wrong selections:

| Metric | Meaning |
|--------|---------|
| Attraction ratio | `actual_selection_rate / expected_uniform_rate` — >1.0 means the decoy tile attracted more wrong guesses than chance |
| % fell for it | Fraction of players who made mistakes that hit at least one trap tile |
| Multi-hit | % who hit 2+ trap tiles from the same decoy group |
| isEffective | `avg_attraction > 1.0 AND pct_fell_for_it > 10%` |
