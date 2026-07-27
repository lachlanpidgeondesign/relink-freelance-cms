# Puzzlr Live API Sync (`tools/puzzlr_api.py`)

Sync Relink levels between the local CMS (`save-data/l*.json`, which carry full
PDL) and the **live Puzzlr management API** (`api.puzzlr.net`).

Runs on **system Python 3** with only the standard library (no `pip install`,
like `tools/pdl_analysis.py`).

---

## What the API can and can't do

The public API is **create + read only**:

| Operation | Supported? | How |
|-----------|-----------|-----|
| List levels | ✅ | `GET /games/{game}/levels` |
| Read one level | ✅ | `GET /games/{game}/levels/{levelId}` |
| **Create** a level | ✅ | `POST /games/levels` (date-unique per game) |
| **Update** a level | ❌ | no `PUT`/`PATCH` — **edit in the live CMS UI** |
| **Delete** a level | ❌ | no working route — **delete in the live CMS UI** |

Consequences:

- **Uploading new puzzles works great.** `push` creates a level and writes the
  returned `levelId` back into the local file as `canonicalId`.
- **Editing or deleting an existing live level must be done in the live CMS UI**
  (`cms.puzzlr.net`). The API cannot change a level once created.
- `POST` is **date-unique**: re-posting a level for a date that already has one
  returns HTTP 409 (so you can't accidentally duplicate a scheduled date).
  Undated posts are *not* unique and would create duplicates.

---

## #0 safety rule — never touch a LIVE puzzle

A puzzle is **LIVE** if its `date` / `publishDate` is **today or earlier**
(already playable). The tool **refuses to mutate a live puzzle** in
auto/non-interactive mode, and otherwise requires `--allow-live` plus an
interactive typed confirmation. All mutating commands are **dry-run by default**;
pass `--apply` to perform writes. `pull` only ever writes local files, so it can
never affect the live system.

---

## Setup

Create an API key in the live CMS (Configuration → Public API), then provide it
to the tool one of two ways (checked in this order):

1. **Env vars:** `PUZZLR_API_KEY` (and optionally `PUZZLR_GAME_ID`).
2. **Config file:** copy `.puzzlr.local.example` → `.puzzlr.local` (repo root)
   and fill in your key:
   ```json
   { "apiKey": "your-key", "gameId": "30454bd0-3a84-4ea0-8d6f-9ef560d8f31a" }
   ```
   `.puzzlr.local` is untracked (the `*.local` rule in `.gitignore`). **Never
   commit your key** — it doubles as the JWT signing secret.

---

## Commands

```bash
# List every live level, with the matched local id and a LIVE flag
python3 tools/puzzlr_api.py list

# Backfill canonicalId onto local files (dry-run, then --apply)
python3 tools/puzzlr_api.py pull
python3 tools/puzzlr_api.py pull --apply

# Content-sync ONE linked puzzle down from live (dry-run, then --apply); keeps PDL
python3 tools/puzzlr_api.py pull l86
python3 tools/puzzlr_api.py pull l86 --apply

# Create NEW local puzzles from live-only levels (dry-run, then --apply)
python3 tools/puzzlr_api.py import mqknerld-uohu0pi mqjn8mh7-u0sbexh
python3 tools/puzzlr_api.py import --all-new            # every live level with no local
python3 tools/puzzlr_api.py import mqknerld-uohu0pi --apply

# Library-wide live -> local sync: content-sync every linked puzzle + import new ones
python3 tools/puzzlr_api.py sync
python3 tools/puzzlr_api.py sync --apply

# Upload a NEW local puzzle (dry-run prints the payload; --apply creates it)
python3 tools/puzzlr_api.py push l90
python3 tools/puzzlr_api.py push l90 --apply

# Compare a local puzzle against its live level
python3 tools/puzzlr_api.py diff l90
```

### `list`
Read-only. Prints `levelId`, `publishDate`, a `LIVE` marker, the matched local
id, and the answer.

### `pull` (bulk) / `pull <id>` (one puzzle)
Read-only against the live system; **dry-run by default** (writes need `--apply`).

- **`pull`** (no id) matches each live level to a local puzzle by a **16-word
  fingerprint** and backfills the live `levelId` into the local file as
  `canonicalId` (and the index). Reports conflicts and live-only levels.
- **`pull <id>`** content-syncs one already-linked puzzle: it pulls live row /
  relink edits back down into the local file, **preserving PDL and tile ids**.
  Only ever writes local files, so it can never affect the live system.

### `import <levelId...>` / `import --all-new`
Read-only against the live system; **dry-run by default**. Creates **new** local
`l{N}.json` files from **live-only** levels (ones with no local match) — the
reverse of `push`, and the way to bring puzzles authored in the live CMS into the
local store. Each new file gets the next free `l{N}` id, the live content (rows,
imposters, relink) via the same converter `pull <id>` uses, the live `name`, the
`canonicalId`, and a date-sorted index entry. The file takes the live
`publishDate`; **an undated live level stays undated locally** (no `date` is
invented). **PDL is left empty** (`pdlComplete: false`) for tagging in the CMS.
Skips any level already linked or whose content already exists locally.
`--all-new` imports every unmatched live level at once.

### `sync`
Read-only against the live system; **dry-run by default**. The library-wide
live → local sync behind the CMS **Sync** button — it does two things in one pass,
preserving every bit of local-only data (all PDL, tile ids, decoys,
`impostorColumn`, `board`, and the editorial `name`):

1. **Content-syncs** every already-linked local puzzle down from its live level
   (rows / relink / date), so edits made in the live CMS land locally — the bulk
   equivalent of running `pull <id>` on each linked puzzle.
2. **Imports** every live-only level (no local match yet) as a new `l{N}.json`
   with empty PDL, ready to tag — the same as `import --all-new`.

The single bulk `GET /levels` already carries each level's full data, so it needs
no per-puzzle calls. Only ever writes local files (a linked-but-deleted-on-live
puzzle is reported and left unchanged), so it can never touch a live puzzle.

### `push <id>`
Creates a **new** level from a local puzzle. Refuses a puzzle that already has a
`canonicalId` (edit those in the CMS UI; `--force` is a raw re-POST escape hatch).
On success, writes the returned `levelId` into the local file as `canonicalId`
and updates the index. Refuses puzzles that aren't writing-complete.

### `diff <id>`
Read-only. Converts the local puzzle to the API shape and compares it against the
live level — useful for spotting drift between local and live.

---

## How local maps to the API

| Local (`l*.json`) | API |
|-------------------|-----|
| `name` (puzzle title) | `data.name` |
| `rows[].category` | `rows[].connection` |
| 3 non-impostor tiles (in order) | `rows[].words` |
| the impostor tile | `rows[].imposter` |
| impostor's index in `tiles[]` | `rows[].imposterIndex` |
| row position 0–3 | `rows[].color` = `purple, blue, green, yellow` |
| `relink.tiles` with `source:"grid"` | `relink.answerWords` (flat, in order) |
| consecutive grid tiles joined by `joinNext` | `relink.answerGroups` (only when a real compound exists) |
| ordered tiles, grid → `{}`, fodder → literal text | `relink.connection` |

Notes on `connection`: one `{}` per **group** (a `joinNext` run), fodder tiles
render as literal text, adjacent group placeholders have **no** space between
them, and fodder is space-separated from its neighbours. Example: `l20`
("Cleaning Products") → `answerWords:["Clean","Ing","Products"]`,
`answerGroups:[["Clean","Ing"],["Products"]]`, `connection:"{}{}"`.

**PDL is local-only** — the live system never sees it, so pushing/pulling never
touches your PDL.

---

## Typical workflows

**Publish a new puzzle**
1. Write and tag it in the local CMS (`l90.json`).
2. `python3 tools/puzzlr_api.py push l90` (review the dry-run payload).
3. `python3 tools/puzzlr_api.py push l90 --apply` → it goes live, and `l90.json`
   gains its `canonicalId`.

**Reconcile after editing a level in the live CMS UI**
1. Make the edit in `cms.puzzlr.net` (the API can't update levels).
2. `python3 tools/puzzlr_api.py diff l90` to see what changed.
3. `python3 tools/puzzlr_api.py pull l90 --apply` to sync it down (PDL preserved).

**Bring live-only puzzles into the local CMS**
1. `python3 tools/puzzlr_api.py list` — the `local` column shows `—` for levels
   authored in the live CMS that have no local file yet.
2. `python3 tools/puzzlr_api.py import <levelId> [<levelId> ...]` (review the
   dry-run), then `--apply` to create them as new `l{N}.json` files.
3. Open each in the local CMS and tag its PDL.

> Or just click **Sync** in the CMS header — it runs `sync` (preview then apply)
> to content-sync every already-linked puzzle *and* pull in every live-only level
> at once, ready to tag.

**Link already-live puzzles to analytics**
- `python3 tools/puzzlr_api.py pull --apply` backfills `canonicalId` on any local
  puzzle that's live but not yet linked.

---

## CMS UI buttons (Push / Pull / Sync)

The `push` / `pull` / `sync` operations are available as **Push**,
**Pull**, and **Sync** buttons in the local CMS. Push/Pull sit next to the
*Canonical ID* field in the puzzle header; **Sync** is in the top header toolbar
(next to *Connect Folder*) because it's library-wide, not tied to the open
puzzle. They call three POST endpoints in `server.py` (`/api/push`, `/api/pull`,
`/api/sync`) that shell out to this CLI, so **the API key never leaves the
server** — it stays in `.puzzlr.local` and is never sent to the browser.

- **Push** — creates a NEW live level from the saved puzzle, then reloads it so
  the returned `canonicalId` appears. Refused (client-side) if the puzzle is
  already linked; the CLI additionally refuses non-writing-complete puzzles.
- **Pull** — runs a dry-run first and shows the live changes for confirmation,
  then applies them, **preserving local PDL**. Disabled-by-message if the puzzle
  isn't linked yet.
- **Sync** — runs `sync` as a dry-run first, then on confirmation applies it. It
  **content-syncs every already-linked puzzle** down from live (rows / relink /
  date, **local PDL preserved**) *and* **creates new `l{N}.json` files** with
  **empty PDL** for every live-only level (authored in the live CMS, no local
  file yet), then reloads the open puzzle + list. The preview lists every change
  (including any date shifts) before you confirm; says so plainly when there's
  nothing to do.

Safety: the endpoints are **localhost-only** (non-loopback callers get `403`).
Push/Pull validate the puzzle id against `^l\d+$` before it reaches the
subprocess (no shell, args passed as a list); Sync takes no id and only ever
writes local files (content-sync + create-new), so it can't touch a live puzzle.
Because the
subprocess is **non-interactive**, the #0 live-puzzle guard treats it as auto
mode — **a LIVE puzzle is hard-refused; no button can bypass it.** Use the CLI
with `--allow-live` for those rare cases.

The CMS saves the puzzle to disk first (when a folder is connected) so the CLI
sees your latest edits, then reloads the file + index after the sync. Use
Chrome/Edge at `localhost:8080` — the buttons won't work in the VS Code Simple
Browser.

---

## Roadmap

- **Bulk/scheduled push** from the CMS (e.g. push a week of puzzles at once).
- **Conflict UI** for `pull` when local and live have diverged on the same field.

---

## Gotchas (already handled in the tool)

- **SSL / CA bundle** — python.org Python ships no CA store; the tool locates a
  valid bundle (`certifi` → system → `/etc/ssl/cert.pem`) and never disables
  verification.
- **Cloudflare** — fronts the API and blocks urllib's default User-Agent
  (error 1010); the tool sends a normal browser UA.
- **Unicode** — local files are written with `ensure_ascii=False` so em-dashes
  etc. are preserved and diffs stay minimal.

---

## Submission platform — browser publish (Edge Function)

The CLI above serves the single-user, file-based CMS. The **submission platform**
(`platform.html` + `js/platform/`) publishes from the **browser** instead, so the
Puzzlr key can't live on the client at all. The push goes through a gated
Supabase **Edge Function** that holds the key server-side.

**Path:** editor/admin clicks **Push to Puzzlr** (the `ready` state in the editing
view) → `db.js` `publishPuzzle()` → `supabase.functions.invoke('publish-puzzle')`
→ the function transforms the puzzle, POSTs to `api.puzzlr.net`, writes back
`puzzles.puzzlr_level_id`, and transitions `ready → published`.

**Why a function, not the CLI:** the browser must never see the key. The function
holds it (`PUZZLR_API_KEY` secret) and calls Puzzlr on the caller's behalf. It
runs under the **caller's** JWT, so RLS and the `ready → published` transition
trigger are the real gate; the function adds the action checks: caller is
**editor/admin**, puzzle is **`ready`**, and a **live-date guard** (force-over-live
is admin-only, sent as `allowLive`). PDL is stripped by the shared transform
(`supabase/functions/_shared/transform.ts`), a faithful TS port of
`puzzle_to_api_data` / `_build_relink`.

### Files

| Path | What |
|------|------|
| `supabase/functions/publish-puzzle/index.ts` | The gated publish function |
| `supabase/functions/_shared/transform.ts` | TS port of the payload transform (PDL-stripping) |
| `supabase/functions/_shared/cors.ts` | CORS headers for the browser call |
| `supabase/config.toml` | `verify_jwt = true` for the function |
| `js/platform/db.js` → `publishPuzzle()` | The data-access wrapper |

### Deploy & secrets (one-time)

```bash
# From the repo root (the supabase/ project dir lives here). Use the CLI in bin/.
bin/supabase login
bin/supabase link --project-ref <your-project-ref>

# Set the secret(s) on the hosted project (the key NEVER goes in git):
bin/supabase secrets set PUZZLR_API_KEY=your-puzzlr-api-key
bin/supabase secrets set PUZZLR_GAME_ID=30454bd0-3a84-4ea0-8d6f-9ef560d8f31a  # optional

# Deploy the function:
bin/supabase functions deploy publish-puzzle
```

> You've already created the secrets — just confirm they're named `PUZZLR_API_KEY`
> (and optionally `PUZZLR_GAME_ID`) with `bin/supabase secrets list`, then deploy.

For local function runs, copy `supabase/functions/.env.example` →
`supabase/functions/.env` (gitignored) and `bin/supabase functions serve
publish-puzzle`.

### Notes

- The API is **create-only**: the function refuses a puzzle that already has a
  `puzzlr_level_id` (edit those in the live CMS UI).
- A Puzzlr **409** means the publish date is already taken — surfaced to the UI.
- If Puzzlr accepts but the local write-back fails, the function returns a loud
  `pushedButNotRecorded` error with the `levelId` so you can reconcile before
  re-pushing (avoids a duplicate).

