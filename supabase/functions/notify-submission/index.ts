// ============================================================================
//  notify-submission — email admins when a puzzle enters review
// ============================================================================
// Fired (fire-and-forget) from db.submitPuzzle right after a puzzle moves into
// the 'submitted' state. It emails every admin the WHO (submitter name + email)
// and WHEN (submission timestamp) of the new puzzle awaiting review.
//
// Trust model:
//   • verify_jwt=true gates this to signed-in callers only.
//   • The caller must be the AUTHOR of the puzzle they're announcing — every
//     submit path (writer composer + editor "submit for review") is the author
//     acting on their own puzzle, so this is the natural, tight gate.
//   • A SERVICE-ROLE client then reads admin emails from auth.users (which RLS
//     hides from ordinary users) and sends the mail. Its key is read from the
//     environment and NEVER accepted as input or returned to the browser.
//
// Email transport: Resend (https://resend.com). Set two secrets:
//   • RESEND_API_KEY   — the Resend API key
//   • NOTIFY_FROM_EMAIL — a verified sender, e.g. "Puzzles <notify@yourdomain>"
// If either is missing the function no-ops gracefully (logs + returns ok:false)
// so a mail-config gap never breaks puzzle submission.
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header.' }, 401);

  let payload: { puzzleId?: string; appUrl?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const puzzleId = (payload.puzzleId ?? '').trim();
  if (!puzzleId) return json({ error: 'puzzleId is required.' }, 400);

  // 1) Identify the caller under their own RLS context.
  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Not signed in.' }, 401);
  const callerId = userData.user.id;

  // 2) Service-role client for the privileged reads/sends.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 3) Load the puzzle and confirm it's genuinely awaiting review, and that the
  //    caller is its author. This keeps the function from being used to spam
  //    admins about puzzles the caller didn't submit.
  const { data: puzzle, error: pErr } = await admin
    .from('puzzles')
    .select('id, title, state, author_id, updated_at')
    .eq('id', puzzleId)
    .single();
  if (pErr || !puzzle) return json({ error: 'Puzzle not found.' }, 404);
  if (puzzle.state !== 'submitted') return json({ error: 'Puzzle is not awaiting review.' }, 409);
  if (puzzle.author_id !== callerId) {
    return json({ error: 'Only the puzzle author can announce its submission.' }, 403);
  }

  // 4) Resolve the submitter's name + email.
  const { data: authorProfile } = await admin
    .from('profiles')
    .select('display_name')
    .eq('id', puzzle.author_id)
    .single();
  const { data: authorUser } = await admin.auth.admin.getUserById(puzzle.author_id);
  const submitterName = authorProfile?.display_name?.trim()
    || authorUser?.user?.email
    || 'A writer';
  const submitterEmail = authorUser?.user?.email ?? '';

  // 5) Collect admin recipient emails (auth.users, RLS-bypassed).
  const { data: adminProfiles, error: aErr } = await admin
    .from('profiles')
    .select('id')
    .eq('role', 'admin');
  if (aErr) return json({ error: 'Could not list admins.' }, 500);

  const recipients: string[] = [];
  for (const p of adminProfiles ?? []) {
    const { data: au } = await admin.auth.admin.getUserById(p.id);
    const email = au?.user?.email;
    if (email) recipients.push(email);
  }
  if (recipients.length === 0) return json({ ok: false, reason: 'no-admins' });

  // 6) Send via Resend (no-op gracefully if unconfigured).
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('NOTIFY_FROM_EMAIL');
  if (!resendKey || !fromEmail) {
    console.log('notify-submission: RESEND_API_KEY / NOTIFY_FROM_EMAIL not set; skipping send.');
    return json({ ok: false, reason: 'email-not-configured' });
  }

  const when = new Date(puzzle.updated_at).toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London',
  });
  const title = puzzle.title || puzzle.id;
  const appUrl = (payload.appUrl || '').replace(/\/+$/, '');
  const queueLink = appUrl ? `${appUrl}/platform.html` : '';

  const subject = `New puzzle for review: ${title}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111;line-height:1.5">
      <p>A new puzzle has been submitted for review.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#555">Puzzle</td><td style="padding:4px 0"><strong>${esc(title)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Submitted by</td><td style="padding:4px 0">${esc(submitterName)}${submitterEmail ? ` &lt;${esc(submitterEmail)}&gt;` : ''}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">When</td><td style="padding:4px 0">${esc(when)}</td></tr>
      </table>
      ${queueLink ? `<p><a href="${esc(queueLink)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px">Open the review queue</a></p>` : ''}
    </div>`;
  const text = [
    'A new puzzle has been submitted for review.',
    '',
    `Puzzle: ${title}`,
    `Submitted by: ${submitterName}${submitterEmail ? ` <${submitterEmail}>` : ''}`,
    `When: ${when}`,
    queueLink ? `\nReview queue: ${queueLink}` : '',
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to: recipients, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('notify-submission: Resend error', res.status, body);
      return json({ ok: false, reason: 'send-failed', status: res.status });
    }
  } catch (e) {
    console.error('notify-submission: send threw', e);
    return json({ ok: false, reason: 'send-threw' });
  }

  return json({ ok: true, recipients: recipients.length });
});
