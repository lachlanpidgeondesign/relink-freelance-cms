---
name: analytics-pipeline
description: 'Relink analytics pipeline — cross-references puzzle PDL with player behaviour to produce the dashboard data. Use when: running or regenerating analytics, editing analytics/scripts/** or pdl_analysis.py, working on the simulator, IPW/transition/regression/clustering analyses, dashboard data, or any analytics output (analytics/outputs/data/*.json).'
---

# Relink Analytics Pipeline

## What It Is

`analytics/scripts/pdl_analysis.py` is the main orchestrator. It loads player event data and puzzle PDL metadata, cross-references design parameters against real player behaviour, and writes **15 core JSON files** to `analytics/outputs/data/` (plus `simulator_loo.json` when `--loo` runs and an `ability-index.json` diagnostic — ~17 in a full refresh). An interactive Chart.js dashboard in `analytics/dashboard/` renders those files.

```
pdl_analysis.py (orchestrator)
├── lib/data.py     → load CSVs + PDL, match events to sessions, build per-player trajectories
├── lib/metrics.py  → 9 analysis compute functions (crosstabs, correlations, regression, VI, decoys, relink, clustering, overview, explorer)
├── lib/model.py    → IPW weights, transition probabilities, correlated failures, Monte Carlo simulator
└── lib/stats.py    → mean, median, percentile, Pearson/Spearman, OLS, k-means
```

## Running

```bash
# Main pipeline — SYSTEM Python, no Docker needed (the exception among analytics scripts)
python3 analytics/scripts/pdl_analysis.py

# Fast re-run after editing puzzle PDL or dates only (raw data unchanged — skips the ~60s CSV parse).
# Only UNDATED forecast puzzles changed? Plain --cache refreshes their predictions and carries
# the previous leave-one-out validation forward, so the dashboard's Model Validation chart stays
# on the honest out-of-sample fit (no corruption).
python3 analytics/scripts/pdl_analysis.py --cache
# DATED puzzles changed (re-tagged a published puzzle / new player data)? Add --loo to recompute the LOO.
python3 analytics/scripts/pdl_analysis.py --cache --loo

# NEW PLAYER DATA (raw CSVs changed) — full refresh; refits the GLMM. See "New Player Data" below.
docker compose run --rm refresh

# All OTHER analytics scripts run inside Docker
docker compose run --rm analytics python analytics/scripts/solve_rates.py
docker compose run --rm analytics bash      # shell inside the container

# Jupyter Lab (interactive notebooks)
docker compose up                            # → http://localhost:8888
```

Project files are mounted at `/app` in the container, so outputs write straight to disk. Add Python libraries by appending to `requirements.txt` then `docker compose up --build`.

## New Player Data — Full Refresh

When **raw event CSVs change** (a new `daily-mail-events-*.csv` drop), `--cache` is NOT enough: the de-confounded GLMM `type-effects.json` was fit on the old snapshot and goes stale. `pdl_analysis.py` detects this via a raw-data fingerprint mismatch and **exits code 2** with `ERROR: type-effects.json is STALE` rather than silently mixing stale effects into the forecast.

The canonical fix is `refresh.py` (`docker compose run --rm refresh`), 3 deterministic steps that share one behaviour parse:

1. **Refit the GLMM type-effects** (`tools.estimate_type_effects`) — needs `statsmodels`, hence Docker (not on system Python).
2. **Re-derive simulator scale-params** (`derive_params.py` → `derived-params.json`).
3. **Regenerate all outputs + honest LOO** (`pdl_analysis.py --cache --loo`).

### Incremental parse — the usual drop just runs the Docker refresh

The behaviour cache (`analytics/.cache/behaviour.pkl`) updates **incrementally**: a new `daily-mail-events-*.csv` drop re-parses only the **new file(s)** plus any unchanged file sharing a **boundary date** (export ranges overlap by a day), then splices the rebuilt dates into the cached trajectories. Because only the new spreadsheets are parsed, peak memory stays a few hundred MB above the cached snapshot — well under the ~11.7 GB Docker VM cap. Even a large multi-day backfill is parsed in **bounded date-batches**, so peak memory stays bounded regardless of how many dates changed. So for the normal "one new CSV arrived" case, just run:

```bash
docker compose run --rm refresh
```

**Cold-cache fallback (host-warm first).** Only when there is *no* usable v2 cache — first run after this change, a deleted `.cache`, or a cache version bump — does the refresh do one **full** parse of all ~17 GB (slim event dicts, ~5.5 GB peak, ~50 min; the pre-slim full-row parse peaked ~20 GB and OOM-killed the Docker VM). To keep that one-off full parse clear of the Docker cap, warm on host Python first, then let the refresh unpickle it:

```bash
# 1. One-off full warm on host (run from repo root; parse is stdlib-only).
python3 -c "import sys; sys.path.insert(0,'analytics/scripts'); from lib.data import load_all; load_all('save-data','analytics/raw_data',cache_behaviour=True)"

# 2. Docker refresh — reuses the warm cache; later drops are incremental.
docker compose run --rm refresh
```

Safe because the cache keys off per-CSV `(name, mtime, size)`, identical across the bind mount, so Docker accepts the host-warmed cache as fresh. If the registry pull times out, use the cached image directly: `docker run --rm -v "$PWD":/app -w /app/analytics/scripts relink_cms_internal-analytics:latest python refresh.py`.

After touching the parse/cache code, validate it stays behaviour-preserving: `python3 analytics/scripts/verify_incremental_cache.py` byte-diffs an incremental merge against a full parse over the two newest overlapping CSVs (system Python, a few minutes).

### Pause-safe, resumable LOO (and derive sweep)

The two long loops — the honest leave-one-out (`pdl_analysis.py --loo`) and the `derive_params.py` scale-param sweep — **checkpoint each completed fold** to `analytics/.cache/` (keyed by a data/params signature). An interrupted refresh (lid close, Ctrl-C, OOM) **resumes from the last completed fold** on the next run instead of restarting; folds replay in sorted order so the aggregate is byte-identical whether or not it resumed. The checkpoint auto-invalidates when the data or params change, and is cleared on success.

Both loops use an **IPW-once incremental re-pool**: the IPW weights + per-date transition/relink pooling pieces are computed once, then each fold pools over all-dates-except-held in O(#dates) instead of rebuilding from ~3.7M observations — turning the old ~hours LOO tail into ~minutes. IPW is held fixed across folds (a deliberate approximation, within noise of a full per-fold re-pool; the LOO already approximates the all-data shipped model). Byte-exactness of the re-pool is checked by `python3 analytics/scripts/verify_incremental_loo.py`.

`--force` bypasses the staleness gate to proceed with the **old** type-effects — only for a quick local look, never for shipped numbers.

## The Outputs (`analytics/outputs/data/`)

| File | Analysis | Question answered |
|------|----------|-------------------|
| `overview.json` | Summary stats | Headline numbers, per-date solve rates, timing percentiles |
| `crosstabs.json` | PDL cross-tabs | First-try % by manipulation, abstraction, knowledge, domain |
| `heatmap.json` | 2D difficulty grid | Manipulation × abstraction interaction |
| `impostor-domain.json` | Domain analysis | Same vs different domain impostor deception |
| `correlations.json` | Scatter plots | Board features vs solve rate (Pearson + Spearman) |
| `regression.json` | OLS regression | Feature coefficients on solve rate, LOO cross-validation |
| `vertical.json` | Vertical inference | Speed/accuracy improvement across positions 0→3 |
| `decoys.json` | Decoy analysis | Decoy presence effect on solve rate; hit rates |
| `relink.json` | Relink phase | Phase 2 by connection identification, answer construction, tile count |
| `clustering.json` | k-means | Puzzle archetypes (k=3) and row archetypes (k=4) |
| `transitions.json` | Transition model | IPW-weighted wrong-guess distributions by features |
| `failures.json` | Correlated failures | Row-pair phi coefficients; PDL similarity effects |
| `simulator.json` | Monte Carlo | Simulated solve rates; undated-puzzle predictions |
| `puzzle-explorer.json` | Puzzle Explorer | Per-puzzle deep-dive: outcome-split wrong distributions, timing, PDL |
| `difficulty.json` | Difficulty ratings | Per-puzzle lives-lost rating (actual + predicted), 0–1 severity, PDL profile/composite, row scores |
| `simulator_loo.json` *(`--loo` only)* | Honest leave-one-out | Per-puzzle out-of-sample errors + coverage; `summary` holds the headline r/MAE |
| `ability-index.json` *(diagnostic)* | Player-ability index | Feeds the dashboard's Ability Index panel; derived from the simulator/difficulty/feat outputs (recomputes no analytics) |

> `type-effects.json` and `derived-params.json` are **inputs** `pdl_analysis.py` reads (written by the refresh's GLMM + derive steps, not this run); `simulator_feat.csv` / `simulator_feat_baseline.csv` are the feature-matrix dumps behind the feature model. Other JSON in the folder (`episodes.json`, `skill-growth.json`, `calendar-structure.json`, `reengagement.json`, `vertical-inference.json`, `episode-*.json`, `puzzle-personal-distribution.json`, `skill_trajectories.json`, `fix-leverage.json`) is produced by the **standalone Docker scripts**, not the main pipeline, so a `--cache` run won't refresh them.

## Key Concepts

### IPW (Inverse Probability Weighting)
Row-level stats are biased by survivorship — players who reach later rows are those who didn't lose all their lives earlier. IPW corrects this by weighting each observation by `1 / P(reaching that state)`, estimated from observed survival rates at each `(position, lives)` state. Implemented in `lib/model.py`.

### Monte Carlo simulator (`lib/model.py`)
Plays 10,000 trials per puzzle to capture cascading life-loss dynamics that regression can't.
- **Dated puzzles** (have player data): use empirical per-puzzle wrong-guess distributions observed at each position.
- **Undated puzzles** (design-only): use a full-feature ratio-shift model (`predict_row_dist()`) — a base distribution by `(manipulation, has_decoy)`, then multiplicative shifts for abstraction, knowledge, same_domain, position; relink phase keyed on construction manipulation. Rows are sorted easiest-first to model typical strategy.

### Derived structures (from `lib/data.py`)
- `players_by_date` — per-player trajectory: `position` (solve order 0–3), `lives_before`, `row`, `wrong_count`, `survived`, guess events, relink trajectory, outcome (WON/LOST/INCOMPLETE).
- `date_summaries` — per-date row metrics (first-try %, avg wrong, top wrong words), relink stats, timing curves.
- `pdl_puzzle_features` / `pdl_rows` — computed board-level and row-level PDL joined across puzzles.

## Standalone Text Analyses (Docker)

| Script | Output |
|--------|--------|
| `relink_analysis.py` | `relink-analysis.txt` — per-puzzle breakdown |
| `compare_dates.py` | `compare-all-dates.txt` — side-by-side dates |
| `failure_analysis.py` | `failure-analysis.txt` — loss causes |
| `abandonment_analysis.py` | `abandonment-analysis.txt` — players who didn't finish |
| `cross_date_failures.py` | `cross-date-failures.txt` — players tracked across dates |
| `solve_rates.py` | `solve-rates.txt` — solve rate summary by date |

## Dashboard

Static site in `analytics/dashboard/`. 15 ES-module renderers in `dashboard/js/` (one per analysis section), orchestrated by `main.js` with hash-based routing. Chart.js v4 from CDN. No build step.

```bash
python3 -m http.server 8000 -d analytics/dashboard
# → http://localhost:8000
```

## Gotchas

- **`pdl_analysis.py` is the system-Python exception** — every other analytics script needs Docker.
- **Regenerate before reading** — after editing puzzle PDL or dates in `save-data/`, re-run `pdl_analysis.py` so the dashboard reflects the change. For UNDATED forecast-puzzle edits, bare `--cache` is enough: it carries the previous leave-one-out validation forward (tagged `carried_forward`) so the Model Validation chart stays on the honest out-of-sample fit. Add `--loo` only when a DATED puzzle changed, to recompute the leave-one-out.
- **Never hand-edit `outputs/data/*.json`** — they're generated from `save-data/` and overwritten on the next run. To change what the dashboard shows (dates, PDL, …), edit `save-data/` and re-run `--cache --loo`.
- **New player data ≠ `--cache`** — when raw CSVs change you must run the full refresh (refits the GLMM). `pdl_analysis.py` exits code 2 (`type-effects.json is STALE`) to stop you from shipping stale effects. See **New Player Data — Full Refresh** above.
- **Incremental parse — usual drop needs no host-warm** — a new CSV drop re-parses only the new + boundary-overlapping spreadsheets and splices them into the cached trajectories, so `docker compose run --rm refresh` stays well under the ~11.7 GB Docker cap. Host-warm first ONLY for a cold/first-time cache (no v2 `behaviour.pkl`), which does one full ~5.5 GB parse. Byte-diff check after parse/cache edits: `verify_incremental_cache.py`.
- **LOO + derive sweep are pause-safe** — both long loops checkpoint each fold to `analytics/.cache/` (signature-gated, cleared on success), so an interrupted refresh resumes rather than restarts, with a byte-identical aggregate. They also re-pool incrementally (IPW-once) rather than rebuilding per fold, so the LOO tail is minutes not hours. Re-pool byte-exactness check: `verify_incremental_loo.py`.
- **Raw CSVs** in `analytics/raw_data/` are gitignored and excluded from the Docker build context (mounted at runtime).
- **New libraries** must go in `requirements.txt` + `docker compose up --build` — installing inside a running container won't persist.
- **Ports:** 8888 = Jupyter, 8000 = dashboard, 8080 = CMS. They don't collide.
- **Validation benchmarks** — the honest **leave-one-out** numbers are the headline; they live in `simulator_loo.json` → `summary` (and the dashboard's Model Validation page) and shift with each data drop, so read them **live** from there and don't claim an improvement without re-running `--loo`. Don't hardcode an r/MAE figure in this skill — it rots after the next drop. The in-sample empirical/feature-only fits run much higher (r≈0.99) but are diagnostic only — never quote them as the model's accuracy.
