// ============================================================================
//  EDGE FUNCTION: admin-invite-user
// ============================================================================
// Admin-only. Invites a new person by email and assigns their initial role.
//
//   1. verify_jwt (config.toml) requires a valid session token.
//   2. requireAdmin() confirms the CALLER is an admin — anyone else is refused
//      before a single privileged call runs.
//   3. The Supabase Admin API (inviteUserByEmail) creates the auth user and
//      emails them an invite. This needs the service-role key, read from
//      Deno.env only — never a parameter, never logged, never in the response.
//   4. The chosen role is then written to `profiles` with the service-role
//      client (an upsert, so it holds even if the new-user trigger is absent on
//      a drifted DB). The handle_new_user trigger seeds every profile as
//      'writer'; this is the ONLY path that grants anything higher.
// ============================================================================
import { adminClient, json, requireAdmin, VALID_ROLES } from '../_shared/admin.ts';
import { corsHeaders } from '../_shared/cors.ts';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // 1 + 2. Admin gate.
  const gate = await requireAdmin(req);
  if ('error' in gate) return gate.error;

  // Validate input.
  let payload: { email?: string; role?: string; redirectTo?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const email = (payload.email ?? '').trim().toLowerCase();
  const role = payload.role ?? '';
  if (!EMAIL_RE.test(email)) return json({ error: 'A valid email address is required.' }, 400);
  if (!VALID_ROLES.includes(role)) return json({ error: 'Please choose a valid role.' }, 400);

  // Where the invite link returns to. Supabase enforces its own Redirect URL
  // allowlist, so a bad value simply won't be honoured — we only forward it.
  const redirectTo = typeof payload.redirectTo === 'string' ? payload.redirectTo : undefined;

  const admin = adminClient();

  // 3. Create the user + send the invite email.
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );
  if (inviteErr || !invited?.user) {
    // inviteErr.message is a plain human string (e.g. already registered) with no
    // secrets; surface it so the admin gets a useful reason.
    return json({ error: inviteErr?.message || 'Could not send the invite.' }, 400);
  }

  // 4. Assign the admin-chosen role authoritatively (service-role, RLS bypassed).
  const { error: roleErr } = await admin
    .from('profiles')
    .upsert({ id: invited.user.id, role }, { onConflict: 'id' });
  if (roleErr) {
    return json(
      { error: `The invite was sent, but the role could not be set: ${roleErr.message}` },
      500,
    );
  }

  // Never echo any Admin API detail (ids, tokens, action links) — just confirm.
  return json({ ok: true, email });
});
