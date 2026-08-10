-- ============================================================================
--  PROFILE NAME SYNC  —  let a user set their own display name, securely
-- ============================================================================
-- Onboarding captures the user's full name AFTER they verify an email code. A
-- normal user cannot write `profiles` directly (the only UPDATE policy is
-- `profiles_admin_write`, so role can never be self-served). Rather than open a
-- self-write hole on profiles, the user sets their name into their OWN
-- auth.users metadata (`display_name`), which Supabase always allows, and this
-- trigger mirrors it into profiles.
--
-- Only `display_name` is ever copied — role stays admin-assigned, so the
-- governance line in the schema is preserved.
-- ============================================================================
create or replace function sync_profile_display_name()
returns trigger
language plpgsql
security definer set search_path = public as $$
begin
  -- Only act when the display_name metadata actually changed.
  if (new.raw_user_meta_data->>'display_name')
       is distinct from (old.raw_user_meta_data->>'display_name') then
    update profiles
      set display_name = nullif(new.raw_user_meta_data->>'display_name', '')
      where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_profile_display_name on auth.users;
create trigger trg_sync_profile_display_name
  after update on auth.users
  for each row execute function sync_profile_display_name();
