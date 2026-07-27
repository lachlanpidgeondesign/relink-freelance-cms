// ============================================================================
//  AUTH  —  email/password sign-in, plus session helpers
// ============================================================================
// Thin wrappers over supabase.auth so the rest of the app never touches the auth
// namespace directly. Session reactivity is driven by onAuthChange() (a wrapper
// over supabase.auth.onAuthStateChange) — the app reacts to sign-in / sign-out
// without any manual polling.
//
// Access is INVITE-ONLY: there is no public sign-up. Accounts are created by an
// admin (the Team area -> admin-invite-user Edge Function), and the invitee sets
// their password via the invite link (see renderSetPasswordView below).
// ============================================================================
import { supabase } from './client.js';

// ── Operations ──────────────────────────────────────────────────────────────
export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Set a new password for the CURRENTLY signed-in user. Used to complete an invite
// (the invitee arrives signed-in but password-less) and to finish a password
// reset. Requires an active session, which the invite/recovery link establishes.
export async function updatePassword(password) {
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return data;
}

// Send a password-reset email. The link returns to `redirectTo` with a recovery
// session in the URL, which main.js routes to the set-password screen.
export async function sendPasswordReset(email, redirectTo) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// Subscribe to auth state changes. Returns the subscription so the caller can
// unsubscribe if needed. The callback receives (event, session).
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
  return data.subscription;
}

// ── View: sign in ────────────────────────────────────────────────
// Renders the sign-in screen into `mount`. Access is invite-only, so there is no
// sign-up — just sign-in and a password-reset link. Re-rendered only on auth-state
// changes, so a plain innerHTML build is fine (no keystroke re-render to lose
// focus to).
export function renderAuthView(mount) {
  mount.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1 class="auth-title">Relink</h1>
        <p class="auth-subtitle">Sign in to your account.</p>
        <form id="auth-form" class="auth-form" autocomplete="on">
          <label class="auth-label" for="auth-email">Email</label>
          <input id="auth-email" class="auth-input" type="email" name="email"
                 autocomplete="email" required placeholder="you@example.com">

          <label class="auth-label" for="auth-password">Password</label>
          <input id="auth-password" class="auth-input" type="password" name="password"
                 autocomplete="current-password" required placeholder="••••••••" minlength="6">

          <div class="auth-actions">
            <button type="submit" id="auth-signin" class="auth-btn auth-btn-primary">Sign in</button>
          </div>
          <button type="button" id="auth-forgot" class="auth-link">Forgot your password?</button>
          <p id="auth-message" class="auth-message" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>`;

  const form = mount.querySelector('#auth-form');
  const emailEl = mount.querySelector('#auth-email');
  const passwordEl = mount.querySelector('#auth-password');
  const messageEl = mount.querySelector('#auth-message');
  const signInBtn = mount.querySelector('#auth-signin');
  const forgotBtn = mount.querySelector('#auth-forgot');

  function setBusy(busy, verb) {
    signInBtn.disabled = busy;
    if (busy) setMessage(`${verb}…`, 'info');
  }

  function setMessage(text, kind = 'info') {
    messageEl.textContent = text;
    messageEl.className = `auth-message auth-message-${kind}`;
  }

  async function run(verb, fn) {
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      setMessage('Please enter your email and password.', 'error');
      return;
    }
    setBusy(true, verb);
    try {
      await fn(email, password);
      // On success, onAuthChange in main.js takes over and routes the user.
    } catch (err) {
      setMessage(err?.message || `${verb} failed. Please try again.`, 'error');
    } finally {
      setBusy(false, verb);
    }
  }

  // Enter / the primary button sign in.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run('Signing in', signInWithPassword);
  });

  // Forgot password: email a reset link that returns to this same page (which
  // main.js routes to the set-password screen via the recovery session).
  forgotBtn.addEventListener('click', async () => {
    const email = emailEl.value.trim();
    if (!email) { setMessage('Enter your email above, then tap “Forgot your password?”.', 'error'); return; }
    setBusy(true, 'Sending reset link');
    try {
      await sendPasswordReset(email, `${window.location.origin}${window.location.pathname}`);
      setMessage('If that email has an account, a reset link is on its way.', 'info');
    } catch (err) {
      setMessage(err?.message || 'Could not send the reset link.', 'error');
    } finally {
      setBusy(false);
    }
  });
}

// ── View: set / reset password ───────────────────────────────────────────────
// Shown when the user arrives via an INVITE or a password-RECOVERY link. In both
// cases they land already signed in (the link carried a session) but need to set
// a password before using the app. main.js detects the link type and renders
// this; on success it calls `onDone`, which routes the now-ready user onward.
export function renderSetPasswordView(mount, { mode = 'invite', email, onDone } = {}) {
  const isInvite = mode === 'invite';
  const title = isInvite ? 'Welcome to Relink' : 'Reset your password';
  const subtitle = isInvite
    ? 'Set a password to finish setting up your account.'
    : 'Choose a new password for your account.';

  mount.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1 class="auth-title">${title}</h1>
        <p class="auth-subtitle">${subtitle}</p>
        <form id="pw-form" class="auth-form" autocomplete="on">
          ${email ? `<p class="auth-account">Signing in as <strong>${email}</strong></p>` : ''}
          <label class="auth-label" for="pw-new">New password</label>
          <input id="pw-new" class="auth-input" type="password" name="new-password"
                 autocomplete="new-password" required placeholder="••••••••" minlength="6">

          <label class="auth-label" for="pw-confirm">Confirm password</label>
          <input id="pw-confirm" class="auth-input" type="password" name="confirm-password"
                 autocomplete="new-password" required placeholder="••••••••" minlength="6">

          <div class="auth-actions">
            <button type="submit" id="pw-submit" class="auth-btn auth-btn-primary">
              ${isInvite ? 'Set password & continue' : 'Update password'}
            </button>
          </div>
          <p id="pw-message" class="auth-message" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>`;

  const form = mount.querySelector('#pw-form');
  const newEl = mount.querySelector('#pw-new');
  const confirmEl = mount.querySelector('#pw-confirm');
  const submitBtn = mount.querySelector('#pw-submit');
  const messageEl = mount.querySelector('#pw-message');

  function setMessage(text, kind = 'info') {
    messageEl.textContent = text;
    messageEl.className = `auth-message auth-message-${kind}`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = newEl.value;
    const confirm = confirmEl.value;
    if (pw.length < 6) { setMessage('Password must be at least 6 characters.', 'error'); return; }
    if (pw !== confirm) { setMessage('Those passwords don’t match.', 'error'); return; }

    submitBtn.disabled = true;
    setMessage('Saving…', 'info');
    try {
      await updatePassword(pw);
      setMessage('Password set. Taking you in…', 'info');
      onDone?.();
    } catch (err) {
      submitBtn.disabled = false;
      setMessage(err?.message || 'Could not set your password. Please try again.', 'error');
    }
  });
}
