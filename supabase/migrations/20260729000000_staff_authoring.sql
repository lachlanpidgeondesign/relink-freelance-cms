-- ============================================================================
--  STAFF AUTHORING  —  let editors & admins create their own levels
-- ============================================================================
-- The platform gains a "Create" tab for editors/admins so they can author a
-- Relink themselves and move it forward (submit to the queue, or — admins only —
-- fast-track straight to published). This is squarely within the roles table in
-- PROJECT_BRIEF §3 ("Create/edit own drafts, save, submit" is ticked for editor
-- and admin); the original policies/trigger simply only wired it for writers.
--
-- Two changes, both additive and owner-scoped:
--   1. puzzles_editor_insert  — editors/admins may INSERT a puzzle they own
--                               (the writer INSERT policy is role='writer' only).
--   2. validate_puzzle_transition — the draft/changes_requested -> submitted
--                               transitions now also permit an editor/admin who
--                               OWNS the puzzle (still owner-scoped; a staffer
--                               cannot submit someone else's draft).
--
-- Nothing here loosens who may publish or review; those tiers are unchanged.
-- ============================================================================

-- ---- 1. Editors/admins may create their own puzzles ------------------------
-- Permissive INSERT policy (OR'd with puzzles_writer_insert). Owner-scoped:
-- author_id must be the caller, so an editor can only create puzzles as
-- themselves — exactly as writers do.
drop policy if exists puzzles_editor_insert on puzzles;
create policy puzzles_editor_insert on puzzles
  for insert with check (author_id = auth.uid() and is_editor_plus());

-- ---- 2. Owner editors/admins may submit their own draft --------------------
-- Same rule set as before, with the two "-> submitted" rows widened from
-- writer-only to "the owner, if writer/editor/admin". Everything else is
-- byte-for-byte the original.
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
  -- The two "-> submitted" moves are owner-scoped: the author submits their own
  -- draft, whether they are a writer or a staff author (editor/admin).
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
