// ============================================================================
//  EDGE FUNCTION: admin-create-user  (code-based invite)
// ============================================================================
// Admin-only. Onboards a new person WITHOUT any clickable one-click link, which
// corporate mail scanners (Outlook Safe Links) pre-fetch and consume. Instead:
//
//   1. requireAdmin() confirms the CALLER is an admin.
//   2. The Admin API creates the auth user (email pre-confirmed, no password)
//      and flags `must_change_password` so onboarding forces a password + name.
//   3. The chosen role is written to `profiles` (service-role, RLS bypassed).
//   4. A 6-digit sign-in CODE is emailed via signInWithOtp. The code lives in
//      the email body ({{ .Token }}), so there is no URL for a scanner to break.
//
// The invitee then: opens the platform -> "Sign in with a code" -> enters email
// + the code -> sets their full name and a password. Future logins use the
// password; a fresh code can always be requested if the emailed one expires.
// ============================================================================
import { adminClient, json, requireAdmin, VALID_ROLES } from '../_shared/admin.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // 1. Admin gate.
  const gate = await requireAdmin(req);
  if ('error' in gate) return gate.error;

  // 2. Validate input.
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
  const redirectTo = typeof payload.redirectTo === 'string' ? payload.redirectTo : undefined;

  const admin = adminClient();

  // 3. Create the user: email pre-confirmed (so the code email sends), no
  //    password yet, and flagged to set a password + name on first sign-in.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message || 'Could not create the user.' }, 400);
  }

  // 4. Assign the admin-chosen role authoritatively (service-role, RLS bypassed).
  const { error: roleErr } = await admin
    .from('profiles')
    .upsert({ id: created.user.id, role }, { onConflict: 'id' });
  if (roleErr) {
    return json(
      { error: `User created, but the role could not be set: ${roleErr.message}` },
      500,
    );
  }

  // 5. Email the 6-digit sign-in code. signInWithOtp is an anon-key call; the
  //    user already exists, so shouldCreateUser:false just sends their code.
  const anon = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error: otpErr } = await anon.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
  });
  if (otpErr) {
    // The account exists and has its role; only the email send failed. Tell the
    // admin so they can retry (the invitee can also self-serve a code later).
    return json(
      { error: `Account created, but the code email could not be sent: ${otpErr.message}` },
      502,
    );
  }

  return json({ ok: true, email });
});
