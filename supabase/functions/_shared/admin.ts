// ============================================================================
//  SHARED: admin-gate + service-role client
// ============================================================================
// Helpers for the admin-only Edge Functions. TWO clients are involved:
//
//   • the CALLER client — bound to the requester's JWT, used only to prove who
//     they are and read their own role. It runs under their RLS context.
//   • the SERVICE-ROLE client (adminClient) — bypasses RLS entirely, used to
//     invite users and read auth.users. Its key is read from Deno.env and NEVER
//     accepted as input, logged, or returned to the browser.
//
// Both new admin functions verify the caller is an admin BEFORE any privileged
// action, so the service-role power is only ever exercised on an admin's behalf.
// ============================================================================
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from './cors.ts';

export const VALID_ROLES = ['writer', 'reviewer', 'editor', 'admin'];

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// A service-role client. RLS is bypassed, so this must live ONLY inside the
// function runtime — never hand it, or its key, to a client.
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// Verify the caller (by their bearer token) is a signed-in admin. Returns their
// user id on success, or a ready-to-return error Response. Reads the role under
// the caller's OWN RLS context, so it can only ever see their own profile row.
export async function requireAdmin(
  req: Request,
): Promise<{ userId: string } | { error: Response }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return { error: json({ error: 'Missing Authorization header.' }, 401) };

  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return { error: json({ error: 'Not signed in.' }, 401) };

  const { data: profile, error: profErr } = await caller
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();
  if (profErr) return { error: json({ error: 'Could not verify your account.' }, 403) };
  if (profile?.role !== 'admin') {
    return { error: json({ error: 'This action is restricted to admins.' }, 403) };
  }

  return { userId: userData.user.id };
}
