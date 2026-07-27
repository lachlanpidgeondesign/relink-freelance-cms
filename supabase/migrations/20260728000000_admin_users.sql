-- ============================================================================
--  ADMIN USER MANAGEMENT  —  new-user profile trigger + last-admin guard
-- ============================================================================
-- Two safety triggers underpinning the admin "Team" area:
--
--   1. handle_new_user      — every new auth.users row gets a matching profile,
--                             ALWAYS seeded as 'writer'. Client-supplied metadata
--                             is deliberately ignored for role: the anon key is
--                             public, so a hand-crafted signUp({ data:{ role } })
--                             must never be able to self-assign a higher tier.
--                             The admin invite path elevates the role afterwards,
--                             server-side, with the service-role key.
--
--   2. prevent_last_admin_demotion — refuses any role change that would remove the
--                             final remaining admin, so the system can never be
--                             locked out with nobody able to manage users.
-- ============================================================================

-- ---- 1. Auto-create a profile for every new user ---------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public as $$
begin
  insert into profiles (id, role, display_name)
  values (
    new.id,
    'writer',                                        -- lowest tier, always;
                                                     -- never trust client metadata
                                                     -- for role (escalation guard)
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

-- ---- 2. Never demote the last admin ----------------------------------------
create or replace function prevent_last_admin_demotion()
returns trigger
language plpgsql
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
