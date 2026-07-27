// ============================================================================
//  EDGE FUNCTION: admin-list-users
// ============================================================================
// Admin-only. Returns every user with their email, current role and join date.
//
// WHY AN EDGE FUNCTION: emails and join dates live in auth.users, which RLS
// cannot expose to the browser, and `profiles` has no email column. Reading them
// needs the Admin API (service-role). Gating that behind an admin check keeps
// emails reachable ONLY by an admin, and the service-role key server-side.
//
// The response carries only { id, email, role, created_at } — nothing sensitive
// (no tokens, no metadata, no password hashes).
// ============================================================================
import { adminClient, json, requireAdmin } from '../_shared/admin.ts';
import { corsHeaders } from '../_shared/cors.ts';

interface UserRow {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const gate = await requireAdmin(req);
  if ('error' in gate) return gate.error;

  const admin = adminClient();

  // Roles from profiles (service-role read; we're already admin-gated).
  const { data: profiles, error: profErr } = await admin.from('profiles').select('id, role');
  if (profErr) return json({ error: 'Could not read profiles.' }, 500);
  const roleById = new Map<string, string>((profiles ?? []).map((p) => [p.id, p.role]));

  // Emails + join dates from auth.users, via the Admin API. Paginate defensively
  // — a POC won't exceed one page, but this stays correct if it grows.
  const users: UserRow[] = [];
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return json({ error: 'Could not list users.' }, 500);
    for (const u of data.users) {
      users.push({
        id: u.id,
        email: u.email ?? '',
        role: roleById.get(u.id) ?? 'writer',
        created_at: u.created_at ?? '',
      });
    }
    if (data.users.length < perPage) break;
  }

  return json({ ok: true, users });
});
