-- ============================================================================
--  RECALL PUBLISHED  —  send a live (published) puzzle back to the writer
-- ============================================================================
-- New workflow: after a puzzle has been pushed to Puzzlr (state 'published'),
-- an editor/admin may decide it needs more work and RECALL it — moving it back
-- to the writer as 'changes_requested', exactly like an ordinary bounce-back.
--
-- Scope of this change (intentionally narrow):
--   * ONE new transition:  published -> changes_requested  (editor/admin only).
--     Reviewers cannot recall; force-over-live remains a push-time admin guard.
--   * This does NOT touch the live Puzzlr level. The recall only affects OUR
--     platform state. The app layer (db.recallPublished) additionally clears
--     puzzles.puzzlr_level_id / published_at so the puzzle can be re-published
--     later once it comes back through the pipeline (the publish Edge Function
--     refuses a puzzle that already carries a puzzlr_level_id).
--
-- Note on the settled state machine (PROJECT_BRIEF §2/§8): the pipeline was
-- one-directional past `ready`. This adds a single, deliberate backward move,
-- gated to editors/admins, mirroring the existing ready->changes_requested and
-- in_review->changes_requested bounce-backs. Everything else is byte-for-byte
-- the previous definition (see 20260729000000_staff_authoring.sql).
--
-- Moving out of 'published' also releases the shared publish_date slot: the
-- puzzles_publish_date_uq partial index only covers state in ('ready',
-- 'published'), so a recalled puzzle no longer occupies that date.
-- ============================================================================

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
  -- NEW: recall a live puzzle back to the writer (editor/admin only).
  elsif (old.state, new.state) = ('published','changes_requested')
        and r in ('editor','admin') then null;
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
