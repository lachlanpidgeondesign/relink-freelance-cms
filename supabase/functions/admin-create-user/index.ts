// ============================================================================
//  EDGE FUNCTION: admin-create-user
// ============================================================================
// Admin-only. Creates a new user with a temporary password and assigns their
// initial role. The temporary password is returned to the admin (shown once) so
// they can relay it via a second channel (Teams/Slack/in-person). The user is
// forced to change their password on first sign-in via user_metadata flag.
//
// This avoids reliance on clickable invite links, which corporate email scanners
// (Outlook Safe Links) consume before the user can click them.
// ============================================================================
import { adminClient, json, requireAdmin, VALID_ROLES } from '../_shared/admin.ts';
import { corsHeaders } from '../_shared/cors.ts';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Generate a cryptographically random temporary password (alphanumeric, 20 chars). */
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // 1. Admin gate.
  const gate = await requireAdmin(req);
  if ('error' in gate) return gate.error;

  // 2. Validate input.
  let payload: { email?: string; role?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const email = (payload.email ?? '').trim().toLowerCase();
  const role = payload.role ?? '';
  if (!EMAIL_RE.test(email)) return json({ error: 'A valid email address is required.' }, 400);
  if (!VALID_ROLES.includes(role)) return json({ error: 'Please choose a valid role.' }, 400);

  const admin = adminClient();
  const tempPassword = generateTempPassword();

  // 3. Create the user with a temporary password (email pre-confirmed).
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message || 'Could not create the user.' }, 400);
  }

  // 4. Assign the admin-chosen role (service-role, RLS bypassed).
  const { error: roleErr } = await admin
    .from('profiles')
    .upsert({ id: created.user.id, role }, { onConflict: 'id' });
  if (roleErr) {
    return json(
      { error: `User created, but the role could not be set: ${roleErr.message}` },
      500,
    );
  }

  // Return the temp password to the admin (shown once, never logged or persisted).
  return json({ ok: true, email, tempPassword });
});
