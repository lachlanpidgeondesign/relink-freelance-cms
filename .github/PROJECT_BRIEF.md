# Relink Submission Platform — Project Brief

> Context document for GitHub Copilot and any contributor. This is the source of
> truth for **what** we're building and **which decisions are already made**.
> Read it before proposing structure. The database schema lives in
> `relink_platform_schema.sql`; this brief explains the intent behind it.

---

## 1. What we're building

A web platform where freelance writers compose **Relink** puzzles and submit them
for editorial review, and where editors review, edit, tag, and publish approved
puzzles to the live Puzzlr CMS.

It's built on an existing single-user, file-based CMS (cloned into this repo).
That tool already knows how to construct a valid Relink and push it to Puzzlr;
this project adds the things it lacks — accounts, roles, a review workflow, and
editorial tooling — while reusing its puzzle-construction core.

**This is a proof of concept.** It runs on Supabase for the POC and will later be
re-platformed onto our own database by the innovation team. Consequence: keep the
data-access layer thin and isolated so the DB swap is a one-file change, not a
rewrite.

---

## 2. Core workflow

The guiding principle: **the writer portal is deliberately simple; all editorial
intelligence lives on the editor/admin side.**

- **Writers** compose drafts, save for later, and — when ready — send a draft to
  the editor. That's it. No checks, no validation, no difficulty tagging in the
  writer portal.
- **Editors/admin** do everything else: review, play, comment, bounce back,
  edit, run the smart checks, tag PDL, and publish.

Lifecycle:

```
draft  --(writer sends)-->  submitted  --(claim)-->  in_review
   ^                                                     |
   |                                          +----------+----------+
   |                                          |                     |
   +---- changes_requested <--(bounce back)---+          (mark ready)|
   |          |                                                     v
   +----------+  (writer revises & resubmits)                     ready
                                                                    |
                                                          (push to Puzzlr)
                                                                    v
                                                                published
```

"Save for later" = stays in `draft`. "Send to editor" = the `draft -> submitted`
transition.

---

## 3. Roles & permissions

Four roles. In practice the MVP likely runs on **writer + admin (you)**, with
editor and reviewer available as the team grows.

| Capability                                   | Writer | Reviewer | Editor | Admin |
|----------------------------------------------|:------:|:--------:|:------:|:-----:|
| Create/edit own drafts, save, submit         |   ✓    |          |   ✓    |   ✓   |
| See own bounce-back feedback, resubmit       |   ✓    |          |   ✓    |   ✓   |
| Read the review queue                        |        |    ✓     |   ✓    |   ✓   |
| Play a submission                            |        |    ✓     |   ✓    |   ✓   |
| Comment (internal), bounce back, mark ready  |        |    ✓     |   ✓    |   ✓   |
| Edit puzzle content directly                 |        |          |   ✓    |   ✓   |
| Run smart checks, tag PDL                     |        |          |   ✓    |   ✓   |
| Publish (push new levels forward to Puzzlr)  |        |          |   ✓    |   ✓   |
| Assign roles, invite/deactivate users        |        |          |        |   ✓   |
| Puzzlr key / game-id / endpoint config       |        |          |        |   ✓   |
| Edit the Writer's-Guide / PDL rule-set config |        |          |        |   ✓   |
| Force-push over an already-LIVE puzzle       |        |          |        |   ✓   |

**Governance line:** editors do everything content-related; admin alone owns
people, integrations, and rule-set governance. Role assignment being admin-only
is the guard against a writer promoting themselves.

**Reviewer's distinct job:** gatekeep without touching — triage the queue and
bounce back, but no content edits and no publishing. A tier for a junior/freelance
vetter. Kept in the enum even if unused at launch.

Enforcement is two-layer: **RLS at the database is what actually protects data**
(a writer physically cannot read another writer's puzzle or any comment);
role-based UI rendering is convenience on top.

---

## 4. State machine

States: `draft, submitted, in_review, changes_requested, ready, published`.

| From              | To                | Who                     |
|-------------------|-------------------|-------------------------|
| draft             | submitted         | writer (owner)          |
| submitted         | in_review         | reviewer/editor/admin   |
| in_review         | changes_requested | reviewer/editor/admin   |
| in_review         | ready             | reviewer/editor/admin   |
| changes_requested | submitted         | writer (owner)          |
| ready             | published         | editor/admin            |

Enforced by a DB trigger (`validate_puzzle_transition`) so the rule holds
regardless of client, and every transition is written to `puzzle_state_history`.
Force-over-live is **not** a state transition — it's a push-time guard in the
Edge Function, admin-only.

---

## 5. Data model (see `relink_platform_schema.sql`)

Key points that aren't obvious:

- **A Relink is structured, not a phrase.** Four rows; each row has 4 tiles, one
  is the imposter, zero-or-more are tagged `is_relink`. The Phase-2 relink
  (`relink_tiles`) is an ordered sequence of grid tiles + literal "fodder", with
  `join_next` marking compounds. The human-readable answer is *derived*, never
  stored.
- **PDL is edit-stage, editor-only, local-only.** Lives in `row_pdl` /
  `puzzle_pdl` (separate tables so writers can't write it). Never uploaded to
  Puzzlr. Feeds the analytics pipeline. Allowable tag values are configurable via
  `app_config`.
- **Comments are internal-only for now** but the `visibility` column exists so
  writer-facing comments can be switched on later without a migration.
- **Bounce-backs are a history**, not one overwritten field — a puzzle sent back
  twice keeps both notes.
- **Dates are unique slots.** One puzzle per publish date, enforced from `ready`
  onward so clashes surface before push, not as a Puzzlr 409.

---

## 6. Puzzlr integration & the upload contract

The existing `tools/puzzlr_api.py` **is the spec** for the finish line. It's a
local Python CLI and will NOT run in a Supabase Edge Function — port its logic to
TypeScript, don't copy it. The payload shape and transform are already decided by
it.

**Upload:** `POST /games/levels` with `Authorization: Bearer {key}`. Payload:

```json
{
  "gameName": "<game-id>",
  "date": "YYYY-MM-DD",
  "data": {
    "name": "<editorial name>",
    "rows": [
      { "color": "purple", "connection": "<category>",
        "words": ["w1","w2","w3"], "imposter": "<word>", "imposterIndex": 0 }
      /* 4 rows; colour derived from row position 0-3: purple/blue/green/yellow */
    ],
    "relink": {
      "answerWords": ["...","...","..."],
      "connection": "{} {} {}s"   /* one {} per group; fodder inlined as literal */
    }
  }
}
```

Transform from our schema (mirrors `puzzle_to_api_data`):
`words` = the 3 non-imposter tiles in order; `imposter`/`imposterIndex` = the
imposter tile; `color` = derived from row position; `relink.answerWords` = grid
tiles in order; `relink.connection` = the sequence with fodder as literal text;
`answerGroups` only when a real compound exists. **PDL is stripped — never sent.**

On success, Puzzlr returns a level id — store it as `puzzles.puzzlr_level_id`
(the existing tool's `canonicalId`). Non-null == live.

**Read** (for the archive / duplicate corpus): `GET /games/{game}/levels`
returns every level. Don't hit this live on every check — sync it into local
tables, embed once, and query the local copy.

### API key handling (non-negotiable)

- The key **never** reaches the browser. Not in client code, not in a client-read
  `.env`, never committed.
- It lives in **Edge Function secrets** (`supabase secrets set PUZZLR_API_KEY=...`).
  Locally, a `.env` that is in `.gitignore` **from the first commit**.
- The browser calls **our** Edge Function, which holds the key and calls Puzzlr.
- The publish function verifies the caller is **editor/admin** AND the puzzle is
  in **`ready`** before doing anything. RLS protects the data; this protects the
  action.
- Two separate functions: a low-risk **read** path (archive sync) and the
  gated **publish** path — so read can't inherit write access.

---

## 7. Reuse / rebuild / strip (from the CMS analysis)

**Port to TypeScript (reference, don't copy):** `tools/puzzlr_api.py` — payload
transform, read/pull, response parsing, the live-puzzle guard.

**Lift & adapt (highest-value reuse):** the composer UI — the rows/tiles/
imposter/relink construction, the joinNext smoosh, the auto-derived answer. It
already builds a *valid* Relink. Swap its persistence (File System Access API →
Supabase) and wrap it in auth it doesn't currently have.

**Build net-new:** auth, the four roles, RLS, the state machine, the review/play/
comment surface, bounce-backs, the admin queue, PDL tagging UI, the smart checks.
(Review and auth are *additions*, not bloat removal — this is the real work.)

**Strip:** analytics pipeline, deep-dive page, row bank, seed puzzles, most of
`tools/` (keep `puzzlr_api.py` + `rebuild_index.py`), CSV exporters, the macOS
launcher, bulk import/sync.

**Stack:** keep it framework-free like the existing tool (vanilla HTML/JS/ES
modules) so the composer lifts cleanly, plus Supabase for auth/DB/Edge Functions.
React is a reasonable alternative if the production rebuild wants it, but for a
throwaway POC that reuses the composer, matching the existing stack wins.

---

## 8. Settled decisions (do not silently undo)

1. Supabase for the POC; thin, isolated data-access layer for a clean DB swap.
2. Four roles: writer / reviewer / editor / admin (reviewer kept even if unused).
3. Editors publish forward; force-over-live is admin-only.
4. Comments internal-only now; `visibility` column present for later.
5. Bounce-backs are a history table with required feedback text.
6. Members normalised (not JSONB) so structural checks are clean SQL.
7. **PDL is in scope** — hand-tagged at the edit stage, editor-only, local-only,
   never uploaded. Stored in `row_pdl` / `puzzle_pdl`.
8. Date-uniqueness enforced from `ready` onward.
9. **All smart checks run on the editor/admin side only** — no submit-time
   preflight. Writer portal has zero checks.
10. Puzzlr push wired into this product (existing tool's logic, ported).

---

## 9. Smart checks (edit-side, later phase)

All advisory — nothing auto-rejects; the editor always has final say. Two
mechanisms: LLM judgement checks (structural rules, style, difficulty, obscurity)
returning structured pass/flag + reason, and embedding-based duplicate detection
against the published archive.

Accuracy is *measured*, not asserted: build a ground-truth set from past
accept/reject decisions and score each check against it before trusting it. Tune
hard against false positives. Persist results in `check_results`; the `overridden`
flag is the log to mine for improvement. Reliability varies — structural rules are
exact, dedup is tunable, obscurity needs correcting for the model's over-knowledge,
difficulty is a rough hint not a measurement.

---

## 10. Build sequence

1. **Scaffold + Supabase + schema.** Auth, four roles, RLS live and tested.
   Prove a writer cannot read another writer's puzzle before building on top.
2. **State machine.** Wire transitions + trigger; confirm illegal moves fail.
3. **Composer, adapted.** Lift the editor, repoint persistence at Supabase. A
   writer creates and submits a valid puzzle end to end. No checks yet.
4. **Review surface.** Embed the real playable engine; comments (internal);
   bounce-back with feedback. The full write→review→bounce→resubmit loop turns.
5. **Admin: edit + PDL + publish.** Editing view, PDL tagging, and the gated
   Edge Function that pushes to Puzzlr.
6. **Smart checks last.** Structural first (cheapest, highest-value), then the
   LLM ones, then dedup. They bolt on and don't care what's underneath.

Get 1–3 solid before anything clever.

---

## 11. Repo prep checklist

- [ ] This brief at the repo root.
- [ ] `relink_platform_schema.sql` in the repo.
- [ ] `.gitignore` with `.env` in it, committed **first**, before any secret exists.
- [ ] The Writer's Guide (structural + style rules) as a file — feeds the checks
      and is useful few-shot material. (The `relink-rows` / `relink-hints` skill
      files are close to ready.)
- [ ] Puzzlr API notes: the two endpoints, payload/response shapes (above).
- [ ] CMS design references translated into words/screenshots (Copilot can't read
      Figma) so the composer mirrors the current CMS.

---

## 12. Open questions

- **Decoys:** the current tool has a decoy authoring aid (+ decoy PDL), never
  uploaded. In scope for this product or dropped? Currently not modelled.
- **Puzzlr response body:** the full JSON returned by `POST /games/levels` and
  `GET /games/{game}/levels` isn't documented in the repo — the code only reads
  specific fields. Confirm against a live call before relying on other fields.
