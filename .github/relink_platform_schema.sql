-- ============================================================================
-- RELINK SUBMISSION PLATFORM — POC SCHEMA
-- Target: Supabase (PostgreSQL 15+)
-- ============================================================================
--
-- Purpose: freelance writers compose Relink puzzles, reviewers play & bounce
-- them back or mark ready, admin edits & pushes to the Puzzlr CMS.
--
-- PORTABILITY NOTE for the innovation team:
--   Supabase-specific bits (won't map 1:1 to a different platform):
--     - references to auth.users            -> your own users/identity table
--     - Row-Level Security (RLS) policies    -> your platform's authz layer
--     - the vector type (pgvector)           -> your vector store / similarity svc
--   Everything else (table shapes, enums, the transition trigger) is plain
--   Postgres and ports directly.
--
-- CONVENTIONS:
--   - A puzzle has 4 rows; a row has 4 members; one member per row is the
--     imposter. This 4x4 convention is enforced in the APP, not the schema,
--     so content shape can flex during the POC. Uniqueness of (parent,
--     position) is enforced here.
-- ============================================================================

create extension if not exists vector;      -- pgvector, for duplicate detection
create extension if not exists pgcrypto;    -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- ENUMS
-- ----------------------------------------------------------------------------
-- Enums are used for clarity of intent. Trade-off: ALTER TYPE ... ADD VALUE is
-- slightly awkward if the set changes. If you expect churn, swap any of these
-- for text + a CHECK constraint. Roles and states are stable, so enums are fine.

create type user_role         as enum ('writer', 'reviewer', 'editor', 'admin');
create type puzzle_state       as enum ('draft', 'submitted', 'in_review',
                                        'changes_requested', 'ready', 'published');
create type comment_visibility as enum ('internal', 'writer_facing');
create type check_kind         as enum ('duplicate', 'structural', 'style', 'spell');
create type check_status       as enum ('pass', 'flag');
create type relink_source      as enum ('grid', 'fodder');  -- see relink_tiles

-- ----------------------------------------------------------------------------
-- PROFILES  (extends Supabase auth.users with an app role)
-- ----------------------------------------------------------------------------
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         user_role not null default 'writer',
  display_name text,
  created_at   timestamptz not null default now()
);
-- NOTE: role is assigned by admins, never self-served (see RLS below) — this is
-- the guard against a writer promoting themselves to reviewer/admin.

-- ----------------------------------------------------------------------------
-- PUZZLES  (the submission — the core entity the state machine hangs off)
-- ----------------------------------------------------------------------------
create table puzzles (
  id               uuid primary key default gen_random_uuid(),
  author_id        uuid not null references profiles(id),
  state            puzzle_state not null default 'draft',
  title            text,                        -- editorial working name, e.g. "Record
                                                -- player components" -> API data.name.
                                                -- LOCAL-ONLY beyond that; not the relink.
  publish_date     date,                        -- target Puzzlr publish date (data.date).
                                                -- Puzzlr rejects a taken date with 409;
                                                -- see uniqueness note below.
  puzzlr_level_id  text,                        -- the id Puzzlr returns on push
                                                -- (the existing tool's `canonicalId`).
                                                -- NULL until pushed; non-null == live.
  claimed_by       uuid references profiles(id),-- reviewer currently on it (nullable)
  relink_embedding vector(1536),                -- dedup on the RELINK IDEA (on publish)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  published_at     timestamptz
);
-- The relink itself is NOT a single phrase — it's a structured assembly of tiles.
-- See the relink_tiles table below.

create index puzzles_state_idx  on puzzles(state);
create index puzzles_author_idx on puzzles(author_id);

-- Date-uniqueness: Puzzlr enforces one level per date (409 on collision). Mirror
-- that here so a clash is caught BEFORE push, not at push. Partial-unique on the
-- states that "own" a slot; drafts may still collide and are resolved at schedule
-- time. DECISION: whether to include 'ready' or only 'published' is yours.
create unique index puzzles_publish_date_uq
  on puzzles(publish_date)
  where publish_date is not null and state in ('ready', 'published');

-- ----------------------------------------------------------------------------
-- PUZZLE_ROWS  (the four coloured category rows)
-- ----------------------------------------------------------------------------
create table puzzle_rows (
  id                uuid primary key default gen_random_uuid(),
  puzzle_id         uuid not null references puzzles(id) on delete cascade,
  position          smallint not null,          -- 1..4, row order
  category_text     text not null,              -- the category clue/description
  hidden_element    text,                       -- for position-locked hidden-word
                                                -- rows; NULL when not that type
  concept_embedding vector(1536),               -- dedup on the ROW IDEA (on publish)
  unique (puzzle_id, position)
);

-- ----------------------------------------------------------------------------
-- ROW_MEMBERS  (the words in a row; exactly one is the imposter, by convention)
-- ----------------------------------------------------------------------------
-- Normalised (rather than a JSONB blob on the row) so the STRUCTURAL VALIDATOR
-- can query directly — e.g. "count imposters per row = 1" becomes a clean
-- aggregate rather than JSON-poking. If innovation prefers a document shape,
-- a JSONB members[] column on puzzle_rows is a valid simplification.
-- CONVENTION (from the real payload): 4 tiles per row. Exactly one is the
-- imposter; zero or more are tagged is_relink (they feed the Phase-2 relink).
-- A tile is imposter XOR relink, never both.
--
-- API TRANSFORM (matches puzzle_to_api_data in tools/puzzlr_api.py):
--   rows[].words        = the 3 non-imposter tiles, in position order
--   rows[].imposter     = the is_imposter tile's word
--   rows[].imposterIndex= that tile's position (0-3)
--   rows[].color        = DERIVED from puzzle_rows.position: 0>purple 1>blue
--                         2>green 3>yellow (never stored)
create table row_members (
  id          uuid primary key default gen_random_uuid(),
  row_id      uuid not null references puzzle_rows(id) on delete cascade,
  position    smallint not null,                -- tile order within the row (0-3)
  word        text not null,
  is_imposter boolean not null default false,
  is_relink   boolean not null default false,   -- tagged as a Phase-2 relink source
  unique (row_id, position),
  constraint imposter_xor_relink check (not (is_imposter and is_relink))
);

-- ----------------------------------------------------------------------------
-- RELINK_TILES  (the structured Phase-2 relink — NOT a plain phrase)
-- ----------------------------------------------------------------------------
-- The relink is an ordered sequence of tiles. Each is either:
--   source='grid'   -> a real grid tile (references the is_relink row_member)
--   source='fodder' -> literal connective text typed by the writer (e.g. "s", "the")
-- join_next marks a smoosh/compound run with the following tile.
--
-- API TRANSFORM (matches _build_relink in tools/puzzlr_api.py):
--   relink.answerWords  = the grid tiles' words, in order
--   relink.connection   = the sequence rendered as one {} per group, with fodder
--                         inlined as literal text (e.g. "{} {} {}s")
--   relink.answerGroups = emitted only when a real compound exists (join_next runs)
-- The human-readable answer string is DERIVED from this, never stored.
create table relink_tiles (
  id         uuid primary key default gen_random_uuid(),
  puzzle_id  uuid not null references puzzles(id) on delete cascade,
  position   smallint not null,                 -- order in the relink assembly
  source     relink_source not null,
  member_id  uuid references row_members(id) on delete cascade,  -- when source='grid'
  text       text,                              -- literal, when source='fodder'
  join_next  boolean not null default false,    -- compound with the next tile
  unique (puzzle_id, position),
  constraint grid_has_member check (
    (source = 'grid'   and member_id is not null) or
    (source = 'fodder' and text is not null))
);

-- ----------------------------------------------------------------------------
-- PDL  (Puzzle Difficulty Language — editorial difficulty/classification tags)
-- ----------------------------------------------------------------------------
-- Applied at the EDIT stage by editors/admin. Writers NEVER touch PDL — that's
-- why it lives in its own tables the writer-write policies don't cover, so the
-- "editors only" rule is enforced at the DB, not just hidden in the UI.
-- LOCAL-ONLY: PDL is NEVER sent to Puzzlr (the upload transform strips it, same
-- as the existing tool). It exists to feed the separate analytics pipeline.
-- Stored as JSONB because the allowable tag values are configurable (see
-- app_config 'pdl_schema') and each field holds an array of tag strings.

-- Per-row "group" PDL (one row per puzzle_row).
create table row_pdl (
  row_id     uuid primary key references puzzle_rows(id) on delete cascade,
  group_pdl  jsonb,      -- {knowledge:[], manipulation:[], abstraction:[],
                         --  knowledgeDomain:[], nicheKnowledge:[]}
  updated_at timestamptz not null default now()
);

-- Puzzle-level PDL (one row per puzzle).
create table puzzle_pdl (
  puzzle_id           uuid primary key references puzzles(id) on delete cascade,
  impostor_column     jsonb,   -- impostor-column PDL
  answer_construction jsonb,   -- relink answer-construction PDL
  board               jsonb,   -- {specialistGroupCount, decoyCount, phase2TileCount,
                               --  isThemed, themeDomain}; some fields derivable
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- DECOYS  (resolves the "decoys" open question — an editorial authoring aid)
-- ----------------------------------------------------------------------------
-- Decoys are an EDITOR-only authoring aid with their own PDL, LOCAL-ONLY (never
-- uploaded to Puzzlr — the upload transform ignores them). A decoy groups a set
-- of grid tiles and carries a small PDL blob. Access matches PDL: staff read,
-- editor/admin write, writers NONE (their own table the writer policies don't
-- cover), so the "editors only" rule is enforced at the DB.
--
-- `tile_member_ids` is an ORDERED array of row_members.id values (a JSONB array
-- rather than a join table) because the app rewrites rows/members wholesale on
-- every save; the data-access layer remaps editor tile ids to the freshly
-- inserted member ids on save, exactly as it already does for relink_tiles.
create table decoys (
  id              uuid primary key default gen_random_uuid(),
  puzzle_id       uuid not null references puzzles(id) on delete cascade,
  position        smallint not null,                     -- decoy order (Decoy 1, 2, …)
  tile_member_ids jsonb not null default '[]'::jsonb,    -- ordered row_members.id values
  pdl             jsonb,                                 -- {knowledge, manipulation,
                                                         --  abstraction, description, …}
  unique (puzzle_id, position)
);
create index decoys_puzzle_idx on decoys(puzzle_id);

-- ----------------------------------------------------------------------------
-- APP_CONFIG  (admin-governed settings: the PDL dropdown schema, Puzzlr game id,
-- check thresholds, etc.)  NOT the Puzzlr API key — that stays in Edge Function
-- secrets, never in the database.
-- ----------------------------------------------------------------------------
create table app_config (
  key        text primary key,   -- 'pdl_schema' | 'puzzlr_game_id' | 'dedup_threshold' ...
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- COMMENTS  (internal reviewer/admin notes; can pin to a specific row)
-- ----------------------------------------------------------------------------
-- MVP: everything is 'internal' — writers never see comments. The visibility
-- column is present from day one so writer-facing comments can be switched on
-- later WITHOUT a migration. The MVP UI simply hard-codes 'internal'.
create table comments (
  id         uuid primary key default gen_random_uuid(),
  puzzle_id  uuid not null references puzzles(id) on delete cascade,
  row_id     uuid references puzzle_rows(id) on delete cascade,  -- nullable: pin to row
  author_id  uuid not null references profiles(id),
  body       text not null,
  visibility comment_visibility not null default 'internal',
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- BOUNCE_BACKS  (writer-facing feedback that accompanies a send-back)
-- ----------------------------------------------------------------------------
-- A HISTORY, not a single overwritten field: if a puzzle goes back twice, both
-- notes survive so the writer (and admin) can see what was asked for each time.
create table bounce_backs (
  id         uuid primary key default gen_random_uuid(),
  puzzle_id  uuid not null references puzzles(id) on delete cascade,
  author_id  uuid not null references profiles(id),  -- the reviewer
  feedback   text not null,                          -- required
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- CHECK_RESULTS  (output of the smart checks; advisory, never auto-rejects)
-- ----------------------------------------------------------------------------
-- Persisting these does double duty: reviewers/admin see the flags at review
-- time, AND `overridden` becomes the override log we can mine later to improve
-- accuracy and feed new few-shot examples.
create table check_results (
  id         uuid primary key default gen_random_uuid(),
  puzzle_id  uuid not null references puzzles(id) on delete cascade,
  row_id     uuid references puzzle_rows(id) on delete cascade,  -- nullable
  kind       check_kind not null,
  status     check_status not null,
  detail     jsonb,        -- e.g. {word, reason, confidence, matched_puzzle_id, matched_row}
  overridden boolean not null default false,   -- human accepted despite a flag
  created_at timestamptz not null default now()
);

create index check_results_puzzle_idx on check_results(puzzle_id);

-- ----------------------------------------------------------------------------
-- PUZZLE_STATE_HISTORY  (audit trail of every transition)
-- ----------------------------------------------------------------------------
create table puzzle_state_history (
  id         uuid primary key default gen_random_uuid(),
  puzzle_id  uuid not null references puzzles(id) on delete cascade,
  actor_id   uuid not null references profiles(id),
  from_state puzzle_state,
  to_state   puzzle_state not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- STATE MACHINE — allowed transitions
-- ============================================================================
--   draft             -> submitted            (writer, owner)      [send to editor]
--   submitted         -> in_review            (reviewer/editor/admin) [claim]
--   in_review         -> changes_requested    (reviewer/editor/admin) [bounce back]
--   in_review         -> ready                (reviewer/editor/admin) [mark ready]
--   changes_requested -> submitted            (writer, owner)      [resubmit]
--   ready             -> published            (editor/admin)       [push to Puzzlr]
--
-- Editor/admin edits to a puzzle in 'ready' do NOT change state (edit-in-place).
-- Enforced here in a trigger so the rule holds no matter which client writes.
-- (You may alternatively enforce in the app data-access layer; belt & braces
--  is fine.)
-- ----------------------------------------------------------------------------

create or replace function current_app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

-- Role-tier helpers. Defining the tiers once keeps policies readable and means a
-- future change to "who counts as staff/editor" happens in one place.
--   is_editor_plus() : editor or admin  -> can edit content + publish forward
--   is_staff()       : reviewer/editor/admin -> can see the pipeline & comment
create or replace function is_editor_plus() returns boolean
language sql stable security definer set search_path = public as $$
  select current_app_role() in ('editor','admin')
$$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select current_app_role() in ('reviewer','editor','admin')
$$;

create or replace function validate_puzzle_transition()
returns trigger language plpgsql
security definer set search_path = public as $$
declare
  r user_role := current_app_role();
begin
  -- no state change -> nothing to validate here
  if new.state = old.state then
    return new;
  end if;

  -- (from, to, permitted roles). Reviewers and editors both drive the review
  -- transitions; editors and admin publish forward. Force-over-live is NOT a
  -- state transition — it's a push-time guard in the Edge Function, admin-only.
  if    (old.state, new.state) = ('draft','submitted')
        and old.author_id = auth.uid() and r in ('writer','editor','admin') then null;
  elsif (old.state, new.state) = ('submitted','in_review')
        and r in ('reviewer','editor','admin') then null;
  elsif (old.state, new.state) = ('in_review','changes_requested')
        and r in ('reviewer','editor','admin') then null;
  elsif (old.state, new.state) = ('in_review','ready')
        and r in ('reviewer','editor','admin') then null;
  elsif (old.state, new.state) = ('changes_requested','submitted')
        and old.author_id = auth.uid() and r in ('writer','editor','admin') then null;
  elsif (old.state, new.state) = ('ready','published')
        and r in ('editor','admin') then null;
  elsif (old.state, new.state) = ('ready','changes_requested')
        and r in ('reviewer','editor','admin') then null;
  else
    raise exception 'Illegal transition % -> % for role %',
      old.state, new.state, r;
  end if;

  -- record it
  insert into puzzle_state_history(puzzle_id, actor_id, from_state, to_state)
  values (new.id, auth.uid(), old.state, new.state);

  return new;
end;
$$;

create trigger trg_validate_puzzle_transition
  before update of state on puzzles
  for each row execute function validate_puzzle_transition();

-- ----------------------------------------------------------------------------
-- USER LIFECYCLE TRIGGERS  (profile bootstrap + last-admin guard)
-- ----------------------------------------------------------------------------
-- Every new auth.users row gets a matching profile, ALWAYS seeded as 'writer'.
-- Client-supplied metadata is deliberately ignored for role: the anon key is
-- public, so a hand-crafted signUp({ data:{ role } }) must never self-assign a
-- higher tier. The admin invite path (Edge Function) elevates the role after,
-- server-side, with the service-role key.
create or replace function handle_new_user()
returns trigger language plpgsql
security definer set search_path = public as $$
begin
  insert into profiles (id, role, display_name)
  values (
    new.id,
    'writer',
    nullif(new.raw_user_meta_data->>'display_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function handle_new_user();

-- Never let a role change remove the FINAL admin — otherwise the system could be
-- locked out with nobody able to manage users. (Demoting yourself when other
-- admins remain, or demoting someone else, is fine.)
create or replace function prevent_last_admin_demotion()
returns trigger language plpgsql
security definer set search_path = public as $$
begin
  if old.role = 'admin' and new.role <> 'admin' then
    if (select count(*) from profiles where role = 'admin') <= 1 then
      raise exception
        'Cannot remove the last admin. Promote another admin first.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_last_admin_demotion on profiles;
create trigger trg_prevent_last_admin_demotion
  before update of role on profiles
  for each row execute function prevent_last_admin_demotion();

-- ============================================================================
-- ROW-LEVEL SECURITY  (Supabase-specific — the layer that actually protects
-- data; the UI-level view switching is convenience only)
-- ============================================================================

alter table profiles             enable row level security;
alter table puzzles              enable row level security;
alter table puzzle_rows          enable row level security;
alter table row_members          enable row level security;
alter table relink_tiles         enable row level security;
alter table row_pdl              enable row level security;
alter table puzzle_pdl           enable row level security;
alter table decoys               enable row level security;
alter table app_config           enable row level security;
alter table comments             enable row level security;
alter table bounce_backs         enable row level security;
alter table check_results        enable row level security;
alter table puzzle_state_history enable row level security;

-- ---- PROFILES --------------------------------------------------------------
-- Staff can read profiles (needed to show author/reviewer names in the queue).
create policy profiles_read on profiles
  for select using (id = auth.uid() or is_staff());
-- Role changes are ADMIN-ONLY (guards against self-promotion; editors can't
-- grant roles or invite — that's the governance line).
create policy profiles_admin_write on profiles
  for update using (current_app_role() = 'admin');

-- ---- PUZZLES ---------------------------------------------------------------
-- Writers: see + edit only their OWN, and only while editable.
create policy puzzles_writer_read on puzzles
  for select using (author_id = auth.uid());
create policy puzzles_writer_insert on puzzles
  for insert with check (author_id = auth.uid() and current_app_role() = 'writer');
-- Editors/admins may also create their OWN puzzles (the "Create a level" tab).
-- Owner-scoped: author_id must be the caller, so staff author as themselves.
create policy puzzles_editor_insert on puzzles
  for insert with check (author_id = auth.uid() and is_editor_plus());
create policy puzzles_writer_update on puzzles
  for update using (author_id = auth.uid()
                    and state in ('draft','changes_requested'))
  with check (author_id = auth.uid()
              and state in ('draft','changes_requested','submitted'));
create policy puzzles_writer_delete on puzzles
  for delete using (author_id = auth.uid()
                    and state in ('draft','changes_requested'));

-- Reviewers: see the pipeline; update only to drive review transitions
-- (the trigger enforces WHICH transitions). No direct content edits.
create policy puzzles_reviewer_read on puzzles
  for select using (current_app_role() = 'reviewer'
                    and state in ('submitted','in_review','changes_requested','ready'));
create policy puzzles_reviewer_update on puzzles
  for update using (current_app_role() = 'reviewer'
                    and state in ('submitted','in_review'));

-- Editors & admin: full read; edit content + publish forward.
create policy puzzles_editor_read on puzzles
  for select using (is_editor_plus());
create policy puzzles_editor_update on puzzles
  for update using (is_editor_plus());
-- Admin only: delete a puzzle outright (an escape hatch for spam/mistakes, any
-- state). Editors do NOT get delete — content lifecycle is bounce-back, not
-- destruction. The FK cascades drop the puzzle's rows/tiles/comments/history.
create policy puzzles_admin_delete on puzzles
  for delete using (current_app_role() = 'admin');

-- ---- PUZZLE_ROWS, ROW_MEMBERS, RELINK_TILES -------------------------------
-- Access inherits from the parent puzzle: if you can see the puzzle, you can
-- see its rows/members/relink. Writers edit their own while editable; editors
-- and admin edit any (content editing is the editor tier, not reviewer).
create policy rows_read on puzzle_rows
  for select using (exists (select 1 from puzzles p where p.id = puzzle_id));
create policy rows_writer_write on puzzle_rows
  for all using (exists (select 1 from puzzles p
                         where p.id = puzzle_id
                           and p.author_id = auth.uid()
                           and p.state in ('draft','changes_requested')));
create policy rows_editor_write on puzzle_rows
  for all using (is_editor_plus());

create policy members_read on row_members
  for select using (exists (select 1 from puzzle_rows pr where pr.id = row_id));
create policy members_writer_write on row_members
  for all using (exists (
    select 1 from puzzle_rows pr join puzzles p on p.id = pr.puzzle_id
    where pr.id = row_id and p.author_id = auth.uid()
      and p.state in ('draft','changes_requested')));
create policy members_editor_write on row_members
  for all using (is_editor_plus());

create policy relink_read on relink_tiles
  for select using (exists (select 1 from puzzles p where p.id = puzzle_id));
create policy relink_writer_write on relink_tiles
  for all using (exists (select 1 from puzzles p
                         where p.id = puzzle_id
                           and p.author_id = auth.uid()
                           and p.state in ('draft','changes_requested')));
create policy relink_editor_write on relink_tiles
  for all using (is_editor_plus());

-- ---- PDL  (staff read; editor/admin write; writers have NO access at all) --
create policy row_pdl_read on row_pdl
  for select using (is_staff());
create policy row_pdl_write on row_pdl
  for all using (is_editor_plus());
create policy puzzle_pdl_read on puzzle_pdl
  for select using (is_staff());
create policy puzzle_pdl_write on puzzle_pdl
  for all using (is_editor_plus());

-- ---- DECOYS  (staff read; editor/admin write; writers have NO access) ------
create policy decoys_read on decoys
  for select using (is_staff());
create policy decoys_write on decoys
  for all using (is_editor_plus());

-- ---- APP_CONFIG  (staff read; ADMIN write — governance) --------------------
create policy app_config_read on app_config
  for select using (is_staff());
create policy app_config_write on app_config
  for all using (current_app_role() = 'admin');

-- ---- COMMENTS  (internal: writers CANNOT read) -----------------------------
create policy comments_staff_read on comments
  for select using (is_staff());
create policy comments_staff_write on comments
  for insert with check (is_staff() and author_id = auth.uid());
-- When writer_facing comments are switched on later, add:
--   for select using (
--     is_staff()
--     or (visibility = 'writer_facing'
--         and exists (select 1 from puzzles p
--                     where p.id = puzzle_id and p.author_id = auth.uid())))

-- ---- BOUNCE_BACKS  (writer-facing) ----------------------------------------
create policy bounce_read on bounce_backs
  for select using (
    is_staff()
    or exists (select 1 from puzzles p
               where p.id = puzzle_id and p.author_id = auth.uid()));
create policy bounce_write on bounce_backs
  for insert with check (is_staff() and author_id = auth.uid());

-- ---- CHECK_RESULTS  (staff-visible; system writes) -------------------------
create policy checks_staff_read on check_results
  for select using (is_staff());
-- Writes typically come from a service role (bypasses RLS). If written client-
-- side, add an appropriate insert policy.

-- ---- STATE HISTORY  (staff-visible; written by the trigger) ---------------
create policy history_staff_read on puzzle_state_history
  for select using (is_staff());

-- ============================================================================
-- OPTIONAL: vector similarity indexes for duplicate detection
-- (create once you have embeddings populated on published puzzles)
-- ============================================================================
-- create index puzzle_rows_embed_idx on puzzle_rows
--   using hnsw (concept_embedding vector_cosine_ops);
-- create index puzzles_relink_embed_idx on puzzles
--   using hnsw (relink_embedding vector_cosine_ops);
-- ============================================================================
