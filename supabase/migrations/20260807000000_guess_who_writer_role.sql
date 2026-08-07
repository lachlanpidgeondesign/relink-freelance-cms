-- ============================================================================
--  GUESS-WHO WRITER ROLE  —  add a new assignable user_role value
-- ============================================================================
-- `guess_who_writer` is a NEW role on a SEPARATE axis — it authors for a
-- different game, and is NOT part of the writer -> reviewer -> editor -> admin
-- progression. It does not rank above or below any existing role.
--
-- This migration only makes the value LEGAL and assignable (via the existing
-- admin role dropdown). No routing, RLS, or permission changes here.
--
-- The handle_new_user trigger is deliberately left untouched: new signups still
-- default to 'writer'.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in
-- older Postgres, and must not be bundled with statements that reference the new
-- value in the same transaction. It is therefore the ONLY statement in this
-- migration — run it on its own.
-- ============================================================================

alter type user_role add value if not exists 'guess_who_writer';
