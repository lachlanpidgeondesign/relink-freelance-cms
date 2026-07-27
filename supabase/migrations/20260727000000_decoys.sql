-- ============================================================================
-- MIGRATION: decoys  (resolves the brief's "decoys" open question)
-- ============================================================================
-- Decoys are an EDITORIAL authoring aid with their own PDL, editor/admin-only
-- and LOCAL-ONLY (never uploaded to Puzzlr). One table: the decoy's PDL as JSONB
-- plus an ORDERED array of the row_members ids it groups. The member-id array
-- (rather than a join table) mirrors how the app rewrites rows/members wholesale
-- on every save — the data-access layer remaps editor tile ids to the freshly
-- inserted member ids on save, exactly as it already does for relink_tiles.
--
-- Apply on the hosted project via the Supabase SQL editor, or with
--   ./bin/supabase db push
-- once the project is linked.
-- ============================================================================

create table if not exists decoys (
  id              uuid primary key default gen_random_uuid(),
  puzzle_id       uuid not null references puzzles(id) on delete cascade,
  position        smallint not null,                     -- decoy order (Decoy 1, 2, …)
  tile_member_ids jsonb not null default '[]'::jsonb,    -- ordered row_members.id values
  pdl             jsonb,                                 -- {knowledge, manipulation,
                                                         --  abstraction, description, …}
  unique (puzzle_id, position)
);

create index if not exists decoys_puzzle_idx on decoys(puzzle_id);

-- RLS: identical access to PDL — staff read, editor/admin write, writers NONE.
alter table decoys enable row level security;

create policy decoys_read  on decoys for select using (is_staff());
create policy decoys_write on decoys for all    using (is_editor_plus());
