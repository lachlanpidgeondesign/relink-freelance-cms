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
import { onAuthChange, signOut, renderAuthView, renderSetPasswordView, getSession } from './auth.js';
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
  renderAuthView(mount);
  // Surface an expired/invalid invite or reset link, if that's why we're here.
  if (_hashError) {
    const msg = mount.querySelector('#auth-message');
    if (msg) { msg.textContent = `That link is no longer valid: ${_hashError}`; msg.className = 'auth-message auth-message-error'; }
  }
}

// Invite / recovery: let the user set a password, then route them onward. The
// role was assigned server-side at invite time, so we clear the role cache and
// re-fetch a fresh session before routing.
function showSetPassword(session) {
  const mode = _authAction === 'recovery' ? 'recovery' : 'invite';
  // Drop the token hash from the address bar so a refresh doesn't re-trigger.
  history.replaceState(null, document.title, window.location.pathname + window.location.search);
  renderSetPasswordView(mount, {
    mode,
    email: session.user?.email,
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
