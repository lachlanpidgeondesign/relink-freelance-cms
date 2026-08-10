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

// ── Email code (OTP) sign-in ────────────────────────────────────────────────
// Onboarding and password-less recovery without any clickable link. Supabase
// emails a 6-digit code ({{ .Token }} in the email template); the user types it
// in. `shouldCreateUser: false` keeps access invite-only — a code is only sent
// to an email an admin has already created. A fresh code can be requested any
// time (the previous one is invalidated), which is the fix for an expired code.
export async function sendSignInCode(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });
  if (error) throw error;
}

// Verify a 6-digit email code. On success a session is established and
// onAuthChange (main.js) routes the user onward (into onboarding for a new user).
export async function verifySignInCode(email, token) {
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
  return data;
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
// Renders the sign-in screen into `mount`. Access is INVITE-ONLY — there is no
// sign-up. Existing users sign in with their password; the two secondary links
// both lead to the email-code screen: one for invited users completing setup,
// one for anyone who's forgotten their password (a code, never a link, so it
// survives corporate mail scanners). Re-rendered only on auth-state changes, so a
// plain innerHTML build is fine (no keystroke re-render to lose focus to).
export function renderAuthView(mount) {
  mount.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1 class="auth-title">Puzzles</h1>
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
          <button type="button" id="auth-usecode" class="auth-link">Have an invite? Set up your account</button>
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
  const useCodeBtn = mount.querySelector('#auth-usecode');

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

  // Forgot password: use the SAME code screen (no emailed link — those get eaten
  // by corporate scanners). In 'reset' mode, once the code signs them in they're
  // taken straight to a "set a new password" step.
  forgotBtn.addEventListener('click', () => {
    renderCodeSignInView(mount, { email: emailEl.value.trim(), mode: 'reset' });
  });

  // Invited user completing setup: switch to the email-code screen, carrying over
  // whatever email was already typed.
  useCodeBtn.addEventListener('click', () => {
    renderCodeSignInView(mount, { email: emailEl.value.trim(), mode: 'code' });
  });
}

// ── View: sign in with an email code ─────────────────────────────────────────
// Passwordless entry via an emailed numeric code — used for two things:
//   • mode 'code'  — an invited user completing setup (they then set name +
//     password; main.js drives that via the must_change_password flag).
//   • mode 'reset' — someone who forgot their password. The code signs them in,
//     then main.js takes them straight to a "set a new password" step (flagged
//     via sessionStorage just before the code is verified).
// No clickable link is ever involved, so corporate mail scanners can't break it.
// (Code length is a Supabase dashboard setting — 6 to 10 digits — so we don't
// hard-code it; we just require 6+ digits.) `email` pre-fills from the sign-in view.
const RESET_INTENT_KEY = 'puzzles-reset-password';

export function renderCodeSignInView(mount, { email = '', mode = 'code' } = {}) {
  const isReset = mode === 'reset';
  const heading = isReset ? 'Reset your password' : 'Set up your account';
  const blurb = isReset
    ? 'We\u2019ll email you a code to sign in — no link to click — then you can choose a new password.'
    : 'Enter your email and the code from your invitation. Accounts are invite-only, so if you haven\u2019t been invited, ask an admin to add you.';

  mount.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1 class="auth-title">${heading}</h1>
        <p class="auth-subtitle">${blurb}</p>
        <form id="code-form" class="auth-form" autocomplete="off">
          <label class="auth-label" for="code-email">Email</label>
          <input id="code-email" class="auth-input" type="email" name="email"
                 autocomplete="email" required placeholder="you@example.com" value="${email}">

          <label class="auth-label" for="code-token">Code from your email</label>
          <input id="code-token" class="auth-input" type="text" name="one-time-code"
                 inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
                 maxlength="10" placeholder="Enter the code">

          <div class="auth-actions">
            <button type="submit" id="code-verify" class="auth-btn auth-btn-primary">Verify &amp; continue</button>
          </div>
          <button type="button" id="code-send" class="auth-link">Email me a code / send a new one</button>
          <button type="button" id="code-back" class="auth-link">Back to sign in</button>
          <p id="code-message" class="auth-message" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>`;

  const form = mount.querySelector('#code-form');
  const emailEl = mount.querySelector('#code-email');
  const tokenEl = mount.querySelector('#code-token');
  const verifyBtn = mount.querySelector('#code-verify');
  const sendBtn = mount.querySelector('#code-send');
  const backBtn = mount.querySelector('#code-back');
  const messageEl = mount.querySelector('#code-message');

  function setMessage(text, kind = 'info') {
    messageEl.textContent = text;
    messageEl.className = `auth-message auth-message-${kind}`;
  }

  // Send / resend a code.
  sendBtn.addEventListener('click', async () => {
    const addr = emailEl.value.trim();
    if (!addr) { setMessage('Enter your email above first.', 'error'); return; }
    sendBtn.disabled = true;
    verifyBtn.disabled = true;
    setMessage('Sending a code…', 'info');
    try {
      await sendSignInCode(addr);
      setMessage(`A code is on its way to ${addr}. It expires after a while — request a new one if it stops working.`, 'info');
      tokenEl.focus();
    } catch (err) {
      // Invite-only: an unknown email is refused. Keep the message generic so we
      // don't reveal which addresses have accounts.
      setMessage(err?.message || 'Could not send a code. Check the email address, or ask an admin for an invite.', 'error');
    } finally {
      sendBtn.disabled = false;
      verifyBtn.disabled = false;
    }
  });

  // Verify the entered code.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = emailEl.value.trim();
    const token = tokenEl.value.trim();
    if (!addr) { setMessage('Enter your email.', 'error'); return; }
    if (!/^\d{6,10}$/.test(token)) { setMessage('Enter the numeric code from your email.', 'error'); return; }
    verifyBtn.disabled = true;
    sendBtn.disabled = true;
    setMessage('Checking your code…', 'info');
    // Set the reset intent BEFORE verifying: verifyOtp fires onAuthChange, and
    // main.js reads this flag to force the set-new-password step. Cleared on error.
    if (isReset) sessionStorage.setItem(RESET_INTENT_KEY, '1');
    try {
      await verifySignInCode(addr, token);
      setMessage('Success — taking you in…', 'info');
      // onAuthChange in main.js takes over from here (routes onward).
    } catch (err) {
      if (isReset) sessionStorage.removeItem(RESET_INTENT_KEY);
      verifyBtn.disabled = false;
      sendBtn.disabled = false;
      setMessage(
        (err?.message && /expired|invalid/i.test(err.message))
          ? 'That code has expired or is incorrect. Tap “Email me a code / send a new one” for a fresh code.'
          : (err?.message || 'Could not verify that code. Please try again.'),
        'error',
      );
    }
  });

  backBtn.addEventListener('click', () => renderAuthView(mount));
}

// Whether a code sign-in was started from "Forgot your password?" — main.js reads
// this to route the now-signed-in user to the set-new-password step. Reading it
// consumes it (single-use).
export function consumeResetIntent() {
  const had = sessionStorage.getItem(RESET_INTENT_KEY) === '1';
  if (had) sessionStorage.removeItem(RESET_INTENT_KEY);
  return had;
}


// ── View: set / reset password ───────────────────────────────────────────────
// Shown when the user arrives via an INVITE or a password-RECOVERY link. In both
// cases they land already signed in (the link carried a session) but need to set
// a password before using the app. main.js detects the link type and renders
// this; on success it calls `onDone`, which routes the now-ready user onward.
//
// During onboarding a new user has no profile name yet, so `needsName: true`
// adds a required "Full name" field. The name is written to the user's own
// auth metadata (`display_name`), which a DB trigger mirrors into profiles.
export function renderSetPasswordView(mount, { mode = 'invite', email, needsName = false, onDone } = {}) {
  const titles = {
    invite: ['Welcome to Puzzles', 'Just a couple of details to finish setting up your account.'],
    recovery: ['Reset your password', 'Choose a new password for your account.'],
    first_login: ['Welcome to Puzzles', 'Set your name and a password to finish setting up your account.'],
  };
  const [title, subtitle] = titles[mode] || titles.invite;

  mount.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1 class="auth-title">${title}</h1>
        <p class="auth-subtitle">${subtitle}</p>
        <form id="pw-form" class="auth-form" autocomplete="on">
          ${email ? `<p class="auth-account">Signing in as <strong>${email}</strong></p>` : ''}
          ${needsName ? `
          <label class="auth-label" for="pw-name">Full name</label>
          <input id="pw-name" class="auth-input" type="text" name="name"
                 autocomplete="name" required placeholder="Jane Doe" maxlength="120">` : ''}
          <label class="auth-label" for="pw-new">New password</label>
          <input id="pw-new" class="auth-input" type="password" name="new-password"
                 autocomplete="new-password" required placeholder="••••••••" minlength="10">

          <label class="auth-label" for="pw-confirm">Confirm password</label>
          <input id="pw-confirm" class="auth-input" type="password" name="confirm-password"
                 autocomplete="new-password" required placeholder="••••••••" minlength="10">

          <div class="auth-actions">
            <button type="submit" id="pw-submit" class="auth-btn auth-btn-primary">
              ${mode === 'invite' || mode === 'first_login' ? 'Save & continue' : 'Update password'}
            </button>
          </div>
          <p id="pw-message" class="auth-message" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>`;

  const form = mount.querySelector('#pw-form');
  const nameEl = mount.querySelector('#pw-name');
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
    const fullName = needsName ? (nameEl.value.trim()) : null;
    const pw = newEl.value;
    const confirm = confirmEl.value;
    if (needsName && !fullName) { setMessage('Please enter your full name.', 'error'); return; }
    if (pw.length < 10) { setMessage('Password must be at least 10 characters.', 'error'); return; }
    if (pw !== confirm) { setMessage('Those passwords don\u2019t match.', 'error'); return; }

    submitBtn.disabled = true;
    setMessage('Saving…', 'info');
    try {
      // One update: set the password, clear the must-change flag, and (if
      // onboarding) store the full name. A DB trigger syncs display_name into
      // profiles — the user cannot write profiles.role themselves.
      const data = { must_change_password: false };
      if (needsName) data.display_name = fullName;
      await supabase.auth.updateUser({ password: pw, data });
      setMessage('All set. Taking you in…', 'info');
      onDone?.();
    } catch (err) {
      submitBtn.disabled = false;
      setMessage(err?.message || 'Could not save your details. Please try again.', 'error');
    }
  });
}
