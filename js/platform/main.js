// ============================================================================
//  MAIN  —  bootstrap: auth state drives which screen is shown
// ============================================================================
// The whole app hangs off supabase.auth.onAuthStateChange (via onAuthChange):
//   - a session present  -> fetch the user's role and route them
//   - no session         -> show the sign-in screen (invite-only; no sign-up)
// No manual polling anywhere.
//
// Two special entry points arrive as links carrying a session in the URL hash:
// an INVITE (a new user finishing setup) and a password RECOVERY. Both land the
// user signed-in but needing to set a password, so they're routed to the
// set-password screen instead of straight into the app.
// ============================================================================
import { onAuthChange, signOut, renderAuthView, renderSetPasswordView, renderCodeSignInView, consumeResetIntent, getSession } from './auth.js';
import { getCurrentUserRole, clearRoleCache } from './db.js';
import { routeByRole } from './router.js';

const mount = document.getElementById('app-root');

// Capture the invite/recovery intent from the URL hash SYNCHRONOUSLY, before
// supabase-js (detectSessionInUrl) consumes and clears it. `type` is 'invite' or
// 'recovery'; an expired/invalid link instead carries an error description.
const _hashParams = new URLSearchParams(window.location.hash.slice(1));
let _authAction = _hashParams.get('type');            // 'invite' | 'recovery' | null
const _hashError = _hashParams.get('error_description');

function showLoading(text = 'Loading…') {
  mount.innerHTML = `<div class="app-loading">${text}</div>`;
}

async function showApp(session) {
  showLoading();
  try {
    // Force password change for users created with a temporary password.
    if (session.user?.user_metadata?.must_change_password) {
      showSetPassword(session, 'first_login');
      return;
    }
    // A code sign-in started from "Forgot your password?" — let them set a new
    // password now (the code got them in; this replaces the old emailed link).
    if (consumeResetIntent()) {
      showSetPassword(session, 'recovery');
      return;
    }
    const role = await getCurrentUserRole();
    routeByRole(mount, role, {
      email: session.user?.email,
      onSignOut: async () => {
        // clearRoleCache first so a fast re-login can't read a stale role; the
        // SIGNED_OUT event then re-renders the auth screen.
        clearRoleCache();
        await signOut();
      },
    });
  } catch (err) {
    mount.innerHTML = `<div class="app-loading">Could not load your account: ${err.message}</div>`;
  }
}

function showAuth() {
  clearRoleCache();
  // The invitation email's plain link lands here with ?signin=code, so drop the
  // invitee straight onto the email-code screen instead of the password form.
  if (new URLSearchParams(window.location.search).get('signin') === 'code') {
    renderCodeSignInView(mount, {});
    return;
  }
  renderAuthView(mount);
  // Surface a broken invite / reset link (expired or already-used token) with
  // actionable guidance. Clear the error hash so a refresh gives a clean screen.
  if (_hashError) {
    const msg = mount.querySelector('#auth-message');
    if (msg) {
      msg.textContent =
        `This invite or reset link has expired or was already used. Ask an admin to ` +
        `send a new invite, or use “Forgot your password?” to set your password.`;
      msg.className = 'auth-message auth-message-error';
    }
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }
}

// Invite / recovery: let the user set a password, then route them onward. The
// role was assigned server-side at invite time, so we clear the role cache and
// re-fetch a fresh session before routing.
function showSetPassword(session, overrideMode) {
  const mode = overrideMode || (_authAction === 'recovery' ? 'recovery' : 'invite');
  // Onboarding (never a password reset) collects the full name if we don't have
  // one yet — a brand-new, code-invited user has no profile name.
  const hasName = !!session.user?.user_metadata?.display_name;
  const needsName = mode !== 'recovery' && !hasName;
  // Drop the token hash AND the ?signin=code entry hint from the address bar so a
  // refresh (or a later sign-out) doesn't re-trigger onboarding.
  history.replaceState(null, document.title, window.location.pathname);
  renderSetPasswordView(mount, {
    mode,
    email: session.user?.email,
    needsName,
    onDone: async () => {
      _authAction = null;   // consumed — route normally from here on
      clearRoleCache();
      const fresh = await getSession();
      if (fresh) showApp(fresh);
      else showAuth();
    },
  });
}

showLoading();

// Supabase advises against awaiting further supabase calls *inside* the
// onAuthStateChange callback (it can deadlock token refresh), so we defer the
// role fetch / render to a fresh task with setTimeout(0).
//
// We only (re)route when the signed-in user actually changes — signed-out ->
// signed-in, signed-in -> signed-out, or a switch of user. Repeat events for the
// SAME user (token refreshes, and — crucially — the embedded composer iframe
// re-emitting SIGNED_IN on the shared same-origin auth storage) are ignored, so
// opening the editing view doesn't tear down and snap back to the queue.
let _currentUserId = null;
let _routedOnce = false;
onAuthChange((event, session) => {
  // A broken invite/recovery link (expired or already-used token) arrives with an
  // error in the hash and no usable new session. Show the sign-in screen with the
  // explanation, and do NOT silently fall through to any session already stored in
  // this browser — that would drop the visitor into someone else's account (e.g.
  // the admin who sent the invite, testing in the same browser).
  if (_hashError) {
    _routedOnce = true;
    _currentUserId = session?.user?.id ?? null;
    setTimeout(showAuth, 0);
    return;
  }

  // An invite or recovery link: intercept BEFORE normal routing so the user sets
  // a password first. supabase-js fires PASSWORD_RECOVERY for recovery links; for
  // invites we rely on the `type` captured from the URL hash above.
  if (session && (event === 'PASSWORD_RECOVERY' || _authAction === 'invite' || _authAction === 'recovery')) {
    _currentUserId = session.user?.id ?? null;
    _routedOnce = true;
    setTimeout(() => showSetPassword(session), 0);
    return;
  }

  const userId = session?.user?.id ?? null;
  if (_routedOnce && userId === _currentUserId) return;
  _currentUserId = userId;
  _routedOnce = true;
  setTimeout(() => {
    if (session) showApp(session);
    else showAuth();
  }, 0);
});
