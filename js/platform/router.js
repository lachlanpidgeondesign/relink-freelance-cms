// ============================================================================
//  ROUTER  —  role-based view selection
// ============================================================================
// After sign-in the user is routed by role:
//   writer                     -> the composer (index.html) — the writer portal,
//                                 which has its own "My drafts" sidebar + editor
//   reviewer                   -> Queue + review view (play + comments + decisions)
//   editor / admin             -> Queue + editing view (the composer superset,
//                                 with the Puzzlr publish path)
//
// IMPORTANT: this routing is a CONVENIENCE only — it decides which screen to
// show, not what data anyone may touch. Row-Level Security (RLS) in the database
// is the actual security boundary and was verified separately. A user who
// reached the "wrong" view still cannot read or write anything RLS forbids.
// ============================================================================
import { esc } from './dom.js';
import {
  getQueue, getPuzzleForReview,
  claimPuzzle, markReady, bounceBack,
  getComments, addComment, getBounceBacks,
  adminDeletePuzzle, publishPuzzle,
  listUsers, inviteUser, updateUserRole, USER_ROLES,
} from './db.js';
import { mountRelinkGame } from '../relink-game/relink-game.js';

const STAFF_ROLES = ['reviewer', 'editor', 'admin'];

// Human-readable state labels (British English), shared by the queue and review
// views so the wording stays consistent.
const STATE_LABEL = {
  submitted: 'Submitted',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  ready: 'Ready',
  published: 'Published',
  draft: 'Draft',
};

// The queue is grouped into these sections, in pipeline order. Only groups with
// puzzles in them are rendered.
const QUEUE_GROUPS = [
  { state: 'submitted', label: 'Submitted — ready to claim' },
  { state: 'in_review', label: 'In review' },
  { state: 'changes_requested', label: 'Changes requested' },
  { state: 'ready', label: 'Ready to publish' },
];

// Format an ISO timestamp as a short British date-time (e.g. "24 Jul 2026, 14:03").
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function displayName(rel) {
  return (rel && rel.display_name) ? rel.display_name : 'Unknown';
}

// Capitalise a role for display (e.g. 'editor' -> 'Editor').
function roleLabel(role) {
  const r = String(role || '');
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : '—';
}

// ── "Opened" tracking (per staff user, client-side) ──────────────────────────
// A lightweight, no-spoiler read-receipt: we remember which queue puzzles this
// user has opened, keyed by the puzzle's `updated_at`, so a puzzle that later
// changes (a resubmission or an edit) surfaces as unopened again. Stored in
// localStorage — this is convenience UI only, not a security boundary. Keyed by
// email so different staff sharing a browser don't clobber each other.
function openedKey(email) {
  return `relink-queue-opened:${email || 'anon'}`;
}
function getOpenedMap(email) {
  try { return JSON.parse(localStorage.getItem(openedKey(email))) || {}; }
  catch { return {}; }
}
function isUnopened(p, email) {
  return getOpenedMap(email)[p.id] !== p.updated_at;
}
function markOpened(p, email) {
  const map = getOpenedMap(email);
  map[p.id] = p.updated_at;
  try { localStorage.setItem(openedKey(email), JSON.stringify(map)); } catch { /* private mode etc. */ }
}

// The nav title for the open (review / editing) views. The puzzle NAME is a
// potential spoiler, so it's only shown once the puzzle is `ready`; before that
// we lead with the author and when it was submitted. (Editors can always read the
// name inside the Edit composer regardless.)
function navTitleHtml(item) {
  const author = displayName(item.author);
  if (item.state === 'ready') {
    return `${esc(item.title || 'Untitled puzzle')}
      <span class="review-nav-by">by <em>${esc(author)}</em></span>`;
  }
  return `${esc(author)}
    <span class="review-nav-by">Submitted ${esc(fmtTime(item.updated_at)) || '—'}</span>`;
}

// Route the signed-in user by role. Writers go to the full composer; staff get
// the queue shell rendered into `mount`. `onSignOut` handles staff sign-out.
export function routeByRole(mount, role, { email, onSignOut } = {}) {
  if (!STAFF_ROLES.includes(role)) {
    // Writers use the composer at index.html (its own drafts sidebar + editor).
    window.location.replace('index.html');
    return;
  }

  const isAdmin = role === 'admin';

  mount.innerHTML = `
    <div class="app-shell">
      <header class="app-topbar">
        <div class="app-topbar-left">
          <span class="app-brand">Relink</span>
          <nav class="app-nav">
            <button class="app-nav-link is-active" data-nav="queue">Queue</button>
            ${isAdmin ? '<button class="app-nav-link" data-nav="team">Team</button>' : ''}
          </nav>
        </div>
        <div class="app-topbar-right">
          <span class="app-user">${esc(email || '')}</span>
          <span class="app-role-badge">${esc(role || 'unknown')}</span>
          <button id="btn-signout" class="auth-btn">Sign out</button>
        </div>
      </header>
      <main id="view-root" class="app-view"></main>
    </div>`;

  mount.querySelector('#btn-signout').addEventListener('click', () => onSignOut?.());

  const viewRoot = mount.querySelector('#view-root');
  const nav = mount.querySelector('.app-nav');
  const ctx = { role, email };

  function setActiveNav(name) {
    nav?.querySelectorAll('.app-nav-link').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.nav === name));
  }

  // Top-level nav. Opening a puzzle re-renders view-root internally (and leaving
  // it returns to the queue), so those flows all live under the "queue" section;
  // only "team" swaps to the admin view. The Team link only exists for admins,
  // and the Edge Functions + RLS are the real gate regardless of the UI.
  nav?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    if (btn.dataset.nav === 'team') {
      setActiveNav('team');
      renderAdminView(viewRoot, ctx);
    } else {
      setActiveNav('queue');
      renderQueueView(viewRoot, ctx);
    }
  });

  renderQueueView(viewRoot, ctx);
}

// ── Queue view: the working review pipeline, grouped by state ────────────────
// Reviewers/editors/admins see the in-flight puzzles grouped into "submitted"
// (to claim), "in review" (who's on it), and the later stages. RLS decides which
// rows actually come back; this just presents them.
async function renderQueueView(root, ctx = {}) {
  root.classList.remove('is-wide'); // the queue uses the normal centred width
  const isEditor = ctx.role === 'editor' || ctx.role === 'admin';
  const openLabel = isEditor ? 'Open' : 'Review';
  root.innerHTML = `
    <section class="view">
      <div class="view-header"><h2>Review queue</h2></div>
      <div id="queue-list" class="queue-groups">Loading…</div>
    </section>`;

  const list = root.querySelector('#queue-list');
  try {
    const queue = await getQueue();
    if (!queue.length) {
      list.innerHTML = `<p class="view-empty">The queue is empty.</p>`;
      return;
    }

    const byState = {};
    for (const p of queue) (byState[p.state] ||= []).push(p);

    const sections = QUEUE_GROUPS
      .filter((g) => byState[g.state]?.length)
      .map((g) => {
        const rows = byState[g.state].map((p) => {
          const claimed = p.state === 'in_review'
            ? `<span class="view-row-claim">Claimed by ${esc(displayName(p.claimer))}</span>`
            : '';
          // `ready` puzzles are safe to name; everything earlier hides the title
          // (spoiler) and leads with the author + submission time instead.
          const primary = p.state === 'ready'
            ? `${esc(p.title || 'Untitled puzzle')}
               <small class="view-row-submitted">by ${esc(displayName(p.author))}</small>`
            : `${esc(displayName(p.author))}
               <small class="view-row-submitted">Submitted ${esc(fmtTime(p.updated_at)) || '—'}</small>`;
          const newBadge = isUnopened(p, ctx.email)
            ? `<span class="view-row-new" title="You haven't opened this yet">New</span>`
            : '';
          return `
            <div class="view-row${newBadge ? ' is-unopened' : ''}">
              ${newBadge}
              <span class="view-row-title">${primary}</span>
              ${claimed}
              <span class="view-row-date">${esc(p.publish_date || '—')}</span>
              <span class="view-row-action">
                <button class="btn-play" data-review-id="${esc(p.id)}">${openLabel}</button>
              </span>
            </div>`;
        }).join('');
        return `
          <div class="queue-group">
            <h3 class="queue-group-title">${esc(g.label)}
              <span class="queue-group-count">${byState[g.state].length}</span>
            </h3>
            <div class="view-list">${rows}</div>
          </div>`;
      }).join('');

    list.innerHTML = sections;

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-review-id]');
      if (!btn) return;
      const item = queue.find((p) => p.id === btn.dataset.reviewId);
      if (!item) return;
      // Remember we've opened this (at its current version) so the "New" badge
      // clears — it'll return if the puzzle changes and is re-fetched.
      markOpened(item, ctx.email);
      // Editors/admins open the editing view (a superset: edit + a play toggle);
      // reviewers open the play-and-decide review view. RLS is the real gate.
      const isEditor = ctx.role === 'editor' || ctx.role === 'admin';
      (isEditor ? renderEditingView : renderReviewView)(root, item, ctx);
    });
  } catch (err) {
    list.innerHTML = `<p class="view-error">Could not load the queue: ${esc(err.message)}</p>`;
  }
}

// ── Admin: Team view (user & role management) ────────────────────────────────
// Admin-only. Lists everyone (email, role, join date), lets an admin change any
// role, and invites new people by email. Every action is gated server-side (the
// admin-* Edge Functions + the profiles_admin_write RLS policy); this UI is only
// shown to admins and is a convenience layer, never the security boundary.
async function renderAdminView(root, ctx = {}) {
  root.classList.remove('is-wide');

  // Defensive: this view is only linked for admins, but never render it for
  // anyone else even if reached some other way. (The real gate is server-side.)
  if (ctx.role !== 'admin') {
    root.innerHTML = `<section class="view">
      <p class="view-error">This area is restricted to admins.</p></section>`;
    return;
  }

  root.innerHTML = `
    <section class="view">
      <div class="view-header"><h2>Team</h2></div>

      <div class="admin-panel">
        <h3 class="admin-subhead">Invite a new person</h3>
        <form id="invite-form" class="admin-invite" autocomplete="off">
          <input id="invite-email" class="admin-input" type="email" required
                 placeholder="name@example.com" aria-label="Email address">
          <select id="invite-role" class="admin-select" aria-label="Initial role">
            ${USER_ROLES.map((r) =>
              `<option value="${esc(r)}"${r === 'writer' ? ' selected' : ''}>${esc(roleLabel(r))}</option>`,
            ).join('')}
          </select>
          <button type="submit" class="btn-primary btn-sm">Send invite</button>
        </form>
        <p id="invite-msg" class="admin-msg" role="status" aria-live="polite" hidden></p>
      </div>

      <div class="admin-panel">
        <h3 class="admin-subhead">People</h3>
        <div id="users-list" class="admin-users">Loading…</div>
      </div>
    </section>`;

  const usersList = root.querySelector('#users-list');
  const inviteForm = root.querySelector('#invite-form');
  const inviteEmail = root.querySelector('#invite-email');
  const inviteRole = root.querySelector('#invite-role');
  const inviteMsg = root.querySelector('#invite-msg');

  const myEmail = (ctx.email || '').toLowerCase();

  function setInviteMsg(text, kind = 'info') {
    inviteMsg.hidden = false;
    inviteMsg.textContent = text;
    inviteMsg.className = `admin-msg admin-msg-${kind}`;
  }

  // ── The people list ────────────────────────────────────────────────────────
  async function loadUsers() {
    usersList.innerHTML = 'Loading…';
    try {
      const users = await listUsers();
      if (!users.length) {
        usersList.innerHTML = `<p class="view-empty">No users found.</p>`;
        return;
      }
      users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
      usersList.innerHTML = users.map((u) => {
        const isMe = !!myEmail && (u.email || '').toLowerCase() === myEmail;
        return `
          <div class="admin-user">
            <div class="admin-user-main">
              <span class="admin-user-email">${esc(u.email || '—')}${
                isMe ? ' <span class="admin-you">you</span>' : ''
              }</span>
              <span class="admin-user-joined">Joined ${esc(fmtTime(u.created_at)) || '—'}</span>
            </div>
            <div class="admin-user-actions">
              <select class="admin-select admin-role-select"
                      data-user-id="${esc(u.id)}" data-current="${esc(u.role)}"${
                        isMe ? ' data-self="1"' : ''
                      } aria-label="Role for ${esc(u.email || 'user')}">
                ${USER_ROLES.map((r) =>
                  `<option value="${esc(r)}"${r === u.role ? ' selected' : ''}>${esc(roleLabel(r))}</option>`,
                ).join('')}
              </select>
              <span class="admin-row-msg" data-row-msg></span>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      usersList.innerHTML = `<p class="view-error">Could not load users: ${esc(err.message)}</p>`;
    }
  }

  // Role changes (event-delegated on the list).
  usersList.addEventListener('change', async (e) => {
    const sel = e.target.closest('.admin-role-select');
    if (!sel) return;
    const userId = sel.dataset.userId;
    const newRole = sel.value;
    const prev = sel.dataset.current;
    const rowMsg = sel.closest('.admin-user').querySelector('[data-row-msg]');
    if (newRole === prev) return;

    // Friendly confirm before an admin demotes THEMSELVES (the DB also blocks the
    // very last admin outright; this just avoids a surprising self-lockout).
    if (sel.dataset.self && prev === 'admin' && newRole !== 'admin') {
      if (!confirm('Change your own role away from admin?\n\nYou will immediately lose access to this Team area.')) {
        sel.value = prev;
        return;
      }
    }

    sel.disabled = true;
    rowMsg.textContent = 'Saving…';
    rowMsg.className = 'admin-row-msg';
    try {
      await updateUserRole(userId, newRole);
      sel.dataset.current = newRole;
      rowMsg.textContent = 'Saved';
      rowMsg.className = 'admin-row-msg admin-row-msg-ok';
      // If I just demoted myself out of admin, reload so the app re-routes me.
      if (sel.dataset.self && newRole !== 'admin') {
        setTimeout(() => window.location.reload(), 700);
      }
    } catch (err) {
      sel.value = prev; // revert the control to its real value
      rowMsg.textContent = err.message;
      rowMsg.className = 'admin-row-msg admin-row-msg-err';
    } finally {
      sel.disabled = false;
    }
  });

  // ── Invite a new person ────────────────────────────────────────────────────
  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = inviteEmail.value.trim();
    const invRole = inviteRole.value;
    if (!email) { setInviteMsg('Enter an email address.', 'error'); return; }
    const btn = inviteForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    setInviteMsg('Sending invite…', 'info');
    try {
      await inviteUser(email, invRole);
      setInviteMsg(`Invite sent to ${email}.`, 'ok');
      inviteEmail.value = '';
      inviteRole.value = 'writer';
      loadUsers(); // the invited user now shows up in the list
    } catch (err) {
      setInviteMsg(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  loadUsers();
}

// ── Shared comments panel (used by the review and editing views) ─────────────
// Builds the right-hand "Comments" column exactly as the review shell uses it: a
// general (whole-puzzle) internal thread backed by db.getComments / db.addComment.
// Returns the column element (already a grid child with class `rcol rcol-comments`),
// which loads and wires itself. Both the review view and the editing view mount it,
// so the comments experience stays identical across the two.
function createCommentsPanel(puzzleId) {
  const el = document.createElement('div');
  el.className = 'rcol rcol-comments';
  el.innerHTML = `
    <div class="rcol-head">
      <span class="rcol-title">Comments</span>
      <span class="rcol-count" data-count>0</span>
    </div>
    <div class="comment-feed" data-feed>Loading…</div>
    <form class="general-form" data-form>
      <textarea class="review-textarea" data-body rows="2" placeholder="Add a comment…"></textarea>
      <div class="general-foot">
        <button type="submit" class="btn-primary btn-sm">Comment</button>
        <span class="inline-msg" data-msg></span>
      </div>
    </form>`;

  const countEl = el.querySelector('[data-count]');
  const feedEl = el.querySelector('[data-feed]');
  const form = el.querySelector('[data-form]');
  const bodyEl = el.querySelector('[data-body]');
  const msgEl = el.querySelector('[data-msg]');
  let comments = [];

  function renderFeed() {
    countEl.textContent = String(comments.length);
    if (!comments.length) {
      feedEl.innerHTML = `<p class="feed-empty">No comments yet. Add the first one below.</p>`;
      return;
    }
    feedEl.innerHTML = comments.map((c) => `
        <div class="cmt">
          <div class="cmt-top">
            <span class="cmt-author">${esc(displayName(c.author))}</span>
            <span class="cmt-time">${esc(fmtTime(c.created_at))}</span>
          </div>
          <div class="cmt-body">${esc(c.body)}</div>
        </div>`).join('');
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = bodyEl.value.trim();
    msgEl.textContent = '';
    msgEl.className = 'inline-msg';
    if (!body) { msgEl.classList.add('inline-msg-error'); msgEl.textContent = 'Enter a comment.'; return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const created = await addComment(puzzleId, body, null);
      comments.push(created);
      renderFeed();
      bodyEl.value = '';
    } catch (err) {
      msgEl.classList.add('inline-msg-error');
      msgEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  getComments(puzzleId)
    .then((rows) => { comments = rows; renderFeed(); })
    .catch((err) => { feedEl.innerHTML = `<p class="view-error">Could not load comments: ${esc(err.message)}</p>`; });

  return el;
}

// ── Send back to writer (shared modal) ───────────────────────────────────────
// A focused modal: a required reason plus the history of anything sent back
// before. On success the puzzle returns to its author (in_review →
// changes_requested) and `onDone` fires. Used by both the reviewer's review view
// and the editor's editing view, so the send-back experience is identical.
async function openSendBackModal(root, puzzleId, { onDone } = {}) {
  if (root.querySelector('#sendback-modal')) return;

  const overlay = document.createElement('div');
  overlay.id = 'sendback-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Send back to writer">
      <div class="modal-head">
        <h3 class="modal-title">Send back to writer</h3>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <p class="modal-sub">The puzzle returns to its author with your note (state → changes requested).</p>
      <div id="sendback-history" class="sendback-history"></div>
      <textarea id="sendback-body" class="review-textarea" rows="4"
                placeholder="A short reason for the changes… (required)"></textarea>
      <div class="modal-foot">
        <span id="sendback-msg" class="inline-msg"></span>
        <div class="modal-foot-actions">
          <button id="sendback-cancel" class="btn-ghost">Cancel</button>
          <button id="sendback-send" class="btn-danger">Send back</button>
        </div>
      </div>
    </div>`;
  root.appendChild(overlay);

  const bodyEl = overlay.querySelector('#sendback-body');
  const msgEl = overlay.querySelector('#sendback-msg');
  bodyEl.focus();

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#sendback-cancel').addEventListener('click', close);

  // Prior send-backs, if any.
  try {
    const history = await getBounceBacks(puzzleId);
    const histEl = overlay.querySelector('#sendback-history');
    histEl.innerHTML = history.length
      ? `<div class="sendback-history-label">Previously sent back</div>` + history.map((b) => `
          <div class="sendback-entry">
            <div class="cmt-top">
              <span class="cmt-author">${esc(displayName(b.author))}</span>
              <span class="cmt-time">${esc(fmtTime(b.created_at))}</span>
            </div>
            <div class="cmt-body">${esc(b.feedback)}</div>
          </div>`).join('')
      : '';
  } catch { /* history is a nice-to-have; ignore load errors here */ }

  overlay.querySelector('#sendback-send').addEventListener('click', async () => {
    const feedback = bodyEl.value.trim();
    msgEl.textContent = '';
    msgEl.className = 'inline-msg';
    if (!feedback) { msgEl.classList.add('inline-msg-error'); msgEl.textContent = 'A reason is required.'; return; }
    const sendBtn = overlay.querySelector('#sendback-send');
    sendBtn.disabled = true;
    try {
      await bounceBack(puzzleId, feedback);
      close();
      onDone?.();
    } catch (err) {
      sendBtn.disabled = false;
      msgEl.classList.add('inline-msg-error');
      msgEl.textContent = err.message;
    }
  });
}

// ── Review view: nav bar + Game / Comments split ─────────────────────────────
// Layout:
//   • a top nav bar — back to the queue, the puzzle's title + author on the left;
//     the state pill and the decision actions (Claim / Send back / Mark ready) on
//     the right.
//   • below it, two columns: the playable puzzle (Game) on the left and the shared
//     Comments feed on the right. Comments are general (whole-puzzle) — everyone on
//     the review sees the same thread.
// This is the REVIEWER's view; editors/admins get the richer editing view instead.
// "Send back to writer" opens a small modal for the required reason. All data flows
// through the data-access layer; RLS is the real gate.
async function renderReviewView(root, item, ctx = {}) {
  root.classList.add('is-wide');
  const puzzleId = item.id;

  let game = null;

  root.innerHTML = `
    <section class="review-view">
      <div class="review-nav">
        <div class="review-nav-left">
          <button id="btn-back" class="btn-ghost btn-sm">← Queue</button>
          <span id="review-nav-title" class="review-nav-title">${navTitleHtml(item)}</span>
        </div>
        <div class="review-nav-right">
          <span id="review-state" class="state-pill">${esc(STATE_LABEL[item.state] || item.state)}</span>
          <div id="decisions" class="decisions"></div>
        </div>
      </div>
      <p id="decision-msg" class="decision-msg" hidden></p>

      <div class="review-workspace">
        <!-- LEFT: the playable puzzle -->
        <div class="rcol rcol-play">
          <p id="review-status" class="rcol-loading">Loading puzzle…</p>
          <div id="game-stage" class="game-stage"></div>
        </div>

        <!-- RIGHT: the shared comments feed -->
        <div id="comments-slot"></div>
      </div>
    </section>`;

  root.querySelector('#comments-slot').replaceWith(createCommentsPanel(puzzleId));

  const status = root.querySelector('#review-status');
  const stage = root.querySelector('#game-stage');
  const decisionMsg = root.querySelector('#decision-msg');

  const showDecisionError = (msg) => {
    decisionMsg.hidden = false;
    decisionMsg.className = 'decision-msg decision-msg-error';
    decisionMsg.textContent = msg;
  };

  function leaveToQueue() {
    if (game) { game.destroy(); game = null; }
    renderQueueView(root, ctx);
  }
  root.querySelector('#btn-back').addEventListener('click', leaveToQueue);

  // ── Decision actions (in the nav) ─────────────────────────────────────────
  const decisions = root.querySelector('#decisions');

  function renderDecisions() {
    decisionMsg.hidden = true;
    if (item.state === 'submitted') {
      decisions.innerHTML = `<button id="d-claim" class="btn-primary btn-sm">Claim to review</button>`;
      decisions.querySelector('#d-claim').addEventListener('click', () =>
        runTransition(() => claimPuzzle(puzzleId), { after: 'stay' }));
    } else if (item.state === 'in_review') {
      decisions.innerHTML = `
        <button id="d-back" class="btn-danger-ghost btn-sm">Send back</button>
        <button id="d-ready" class="btn-primary btn-sm">Mark ready</button>`;
      decisions.querySelector('#d-ready').addEventListener('click', () =>
        runTransition(() => markReady(puzzleId), { after: 'leave' }));
      decisions.querySelector('#d-back').addEventListener('click', () =>
        openSendBackModal(root, puzzleId, { onDone: leaveToQueue }));
    } else if (item.state === 'ready') {
      decisions.innerHTML = `<span class="decision-note">Ready to publish</span>`;
    } else {
      decisions.innerHTML = '';
    }
  }

  async function runTransition(fn, { after }) {
    decisions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    decisionMsg.hidden = true;
    try {
      const res = await fn();
      item.state = res.state;
      root.querySelector('#review-state').textContent = STATE_LABEL[item.state] || item.state;
      root.querySelector('#review-nav-title').innerHTML = navTitleHtml(item);
      if (after === 'leave') { leaveToQueue(); return; }
      renderDecisions();
    } catch (err) {
      decisions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      showDecisionError(err.message);
    }
  }

  // ── Load the puzzle, mount the game, wire everything up ────────────────────
  try {
    const puzzle = await getPuzzleForReview(puzzleId);
    status.remove();
    game = mountRelinkGame(stage, puzzle, { onComplete: () => {}, onFail: () => {} });

    renderDecisions();
  } catch (err) {
    if (status.isConnected) {
      status.className = 'view-error';
      status.textContent = `Could not load this puzzle: ${err.message}`;
    } else {
      showDecisionError(`Could not load this puzzle: ${err.message}`);
    }
  }
}

// ── Editing view: nav bar + Composer / Comments split (editors & admins) ─────
// Structurally identical to the review view — same page shell, same right-hand
// comments panel — but the centre swaps the playable game for the writer's phase-4
// composer. The composer runs in an iframe pointed at index.html?edit=<id> (embed
// mode), so it is the SAME editor writers use, just loaded with this puzzle's data
// for direct editing. A panel toolbar flips the centre between "Play" (the same
// game engine the review view uses — the default) and "Edit" (the composer).
//
// The state-machine decisions (Claim / Send back / Mark ready) live in the top nav,
// mirroring the review view: this view is the editor's superset. Publish (ready ->
// published) runs from here via the gated Puzzlr Edge Function. Saving is edit-in-place — it persists via the composer's existing
// db.saveDraft and does NOT move the puzzle between states. Editors/admins may edit
// ANY puzzle — the is_editor_plus() RLS policies are the gate, so there is no extra
// access logic here.
async function renderEditingView(root, item, ctx = {}) {
  root.classList.add('is-wide');
  const puzzleId = item.id;

  let game = null;
  let mode = 'play';        // 'play' (game) is the default | 'edit' (composer)
  let composerReady = false;
  let composerLoaded = false;
  let dirty = false;

  root.innerHTML = `
    <section class="review-view">
      <div class="review-nav">
        <div class="review-nav-left">
          <button id="btn-back" class="btn-ghost btn-sm">← Queue</button>
          <span id="review-nav-title" class="review-nav-title">${navTitleHtml(item)}</span>
        </div>
        <div class="review-nav-right">
          <span id="review-state" class="state-pill">${esc(STATE_LABEL[item.state] || item.state)}</span>
          <div id="decisions" class="decisions"></div>
        </div>
      </div>
      <p id="edit-msg" class="decision-msg" hidden></p>

      <div class="review-workspace">
        <!-- LEFT: the game (Play, default) / the composer (Edit) -->
        <div class="rcol rcol-play rcol-compose">
          <div class="panel-toolbar">
            <div class="view-toggle" role="group" aria-label="Play or edit">
              <button id="tab-play" class="view-toggle-btn is-active" aria-pressed="true">
                <i class="fa-solid fa-play"></i> Play
              </button>
              <button id="tab-edit" class="view-toggle-btn" aria-pressed="false">
                <i class="fa-solid fa-pen-ruler"></i> Edit
              </button>
            </div>
            <div class="toolbar-actions">
              <button id="btn-toggle-comments" class="btn-ghost btn-sm" aria-pressed="true"
                title="Show or hide the comments panel">
                <i class="fa-solid fa-comments"></i> Hide comments
              </button>
              <button id="btn-save" class="btn-primary btn-sm" hidden disabled>Save</button>
            </div>
          </div>
          <div id="play-stage" class="game-stage"><p class="rcol-loading">Loading puzzle…</p></div>
          <iframe id="composer-frame" class="composer-frame" title="Puzzle composer" hidden></iframe>
        </div>

        <!-- RIGHT: the shared comments feed -->
        <div id="comments-slot"></div>
      </div>
    </section>`;

  root.querySelector('#comments-slot').replaceWith(createCommentsPanel(puzzleId));

  const frame = root.querySelector('#composer-frame');
  const playStage = root.querySelector('#play-stage');
  const saveBtn = root.querySelector('#btn-save');
  const tabEdit = root.querySelector('#tab-edit');
  const tabPlay = root.querySelector('#tab-play');
  const editMsg = root.querySelector('#edit-msg');
  const decisions = root.querySelector('#decisions');
  const statePill = root.querySelector('#review-state');

  const showMsg = (text, isError = false) => {
    editMsg.hidden = false;
    editMsg.className = 'decision-msg' + (isError ? ' decision-msg-error' : '');
    editMsg.textContent = text;
  };

  function leaveToQueue() {
    window.removeEventListener('message', onMessage);
    if (game) { game.destroy(); game = null; }
    renderQueueView(root, ctx);
  }
  root.querySelector('#btn-back').addEventListener('click', leaveToQueue);

  // ── Decision actions (in the nav) ─────────────────────────────────────────
  // The editor's state-machine controls, mirroring the review view. Send back and
  // Mark ready are the two live transitions from `in_review`; Claim brings a fresh
  // submission into review. A `ready` puzzle can still be sent back to the writer
  // (ready → changes_requested). Admins additionally get an outright Delete in any
  // state. Publish (ready → published) runs from the editor's decisions via the
  // gated Puzzlr Edge Function.
  const isAdmin = ctx.role === 'admin';

  function renderDecisions() {
    editMsg.hidden = true;
    if (item.state === 'submitted') {
      decisions.innerHTML = `<button id="d-claim" class="btn-primary btn-sm">Claim to review</button>`;
      decisions.querySelector('#d-claim').addEventListener('click', () =>
        runTransition(() => claimPuzzle(puzzleId)));
    } else if (item.state === 'in_review') {
      decisions.innerHTML = `
        <button id="d-back" class="btn-danger-ghost btn-sm">Send back</button>
        <button id="d-ready" class="btn-primary btn-sm">Mark ready</button>`;
      decisions.querySelector('#d-back').addEventListener('click', () =>
        openSendBackModal(root, puzzleId, { onDone: leaveToQueue }));
      decisions.querySelector('#d-ready').addEventListener('click', () =>
        runTransition(() => markReady(puzzleId)));
    } else if (item.state === 'changes_requested') {
      decisions.innerHTML = `<span class="decision-note">Sent back — awaiting the writer</span>`;
    } else if (item.state === 'ready') {
      decisions.innerHTML = `
        <button id="d-back" class="btn-danger-ghost btn-sm">Send back</button>
        <button id="d-publish" class="btn-primary btn-sm">Push to Puzzlr</button>`;
      decisions.querySelector('#d-back').addEventListener('click', () =>
        openSendBackModal(root, puzzleId, { onDone: leaveToQueue }));
      decisions.querySelector('#d-publish').addEventListener('click', () => runPublish());
    } else if (item.state === 'published') {
      decisions.innerHTML = `<span class="decision-note">Published${
        item.puzzlrLevelId ? ` — level ${esc(item.puzzlrLevelId)}` : ''
      }</span>`;
    } else {
      decisions.innerHTML = '';
    }
    // Admin-only destructive escape hatch, available in every state.
    if (isAdmin && item.state !== 'published') {
      const del = document.createElement('button');
      del.id = 'd-delete';
      del.className = 'btn-danger btn-sm';
      del.textContent = 'Delete';
      del.addEventListener('click', runDelete);
      decisions.appendChild(del);
    }
  }

  async function runDelete() {
    if (!confirm('Delete this puzzle permanently? This cannot be undone.')) return;
    decisions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    editMsg.hidden = true;
    try {
      await adminDeletePuzzle(puzzleId);
      leaveToQueue();
    } catch (err) {
      decisions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      showMsg(err.message, true);
    }
  }

  async function runTransition(fn) {
    decisions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    editMsg.hidden = true;
    try {
      const res = await fn();
      item.state = res.state;
      statePill.textContent = STATE_LABEL[item.state] || item.state;
      root.querySelector('#review-nav-title').innerHTML = navTitleHtml(item);
      renderDecisions();
    } catch (err) {
      decisions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      showMsg(err.message, true);
    }
  }

  // Publish to Puzzlr (ready -> published) via the gated Edge Function. The key
  // never touches the browser — publishPuzzle() calls the function, which holds
  // it. On an admin live-date refusal we offer a force retry; other errors just
  // surface. `force` maps to the admin-only allowLive override.
  async function runPublish({ force = false } = {}) {
    decisions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    editMsg.hidden = true;
    showMsg('Publishing to Puzzlr…');
    try {
      const res = await publishPuzzle(puzzleId, { allowLive: force });
      item.state = 'published';
      if (res?.levelId) item.puzzlrLevelId = res.levelId;
      statePill.textContent = STATE_LABEL[item.state] || item.state;
      root.querySelector('#review-nav-title').innerHTML = navTitleHtml(item);
      renderDecisions();
      showMsg(res?.levelId ? `Published to Puzzlr (level ${res.levelId}).` : 'Published to Puzzlr.');
    } catch (err) {
      decisions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      if (err.liveGuard && err.isAdmin && !force) {
        if (confirm(`${err.message}\n\nForce-publish over this live date? (admin only)`)) {
          return runPublish({ force: true });
        }
        showMsg('Publish cancelled.', false);
        return;
      }
      showMsg(err.message, true);
    }
  }

  // Mount (or re-mount) the playable game into the stage from the latest SAVED
  // content — the same engine the review view uses.
  async function mountPlay() {
    if (game) { game.destroy(); game = null; }
    playStage.innerHTML = '<p class="rcol-loading">Loading puzzle…</p>';
    try {
      const puzzle = await getPuzzleForReview(puzzleId);
      if (mode !== 'play') return; // switched away while loading
      playStage.innerHTML = '';
      game = mountRelinkGame(playStage, puzzle, { onComplete: () => {}, onFail: () => {} });
    } catch (err) {
      playStage.innerHTML = `<p class="view-error">Could not load the puzzle: ${esc(err.message)}</p>`;
    }
  }

  // ── Composer bridge (postMessage, same-origin only) ────────────────────────
  // The composer runs in the iframe. It tells us when it's ready, reports its
  // dirty state (so Save can enable/disable), and reports the result of a save we
  // ask it to run. We never reach into its internals — just this small protocol.
  function onMessage(e) {
    if (e.origin !== window.location.origin) return;
    if (!e.data || e.source !== frame.contentWindow) return;
    switch (e.data.type) {
      case 'relink:ready':
        composerReady = true;
        break;
      case 'relink:dirty':
        dirty = !!e.data.dirty;
        if (mode === 'edit') saveBtn.disabled = !dirty;
        break;
      case 'relink:saved':
        dirty = false;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Save';
        showMsg('Saved.');
        break;
      case 'relink:save-error':
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        showMsg(`Save failed: ${e.data.message || 'unknown error'}`, true);
        break;
    }
  }
  window.addEventListener('message', onMessage);

  saveBtn.addEventListener('click', () => {
    if (!composerReady) return;
    editMsg.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    frame.contentWindow.postMessage({ type: 'relink:save' }, window.location.origin);
  });

  // ── Collapse / expand the comments panel ───────────────────────────────────
  // The composer (with its PDL + decoy sidebars) needs the room, so editors can
  // fold the comments column away to give the editor full width, and bring it
  // back when they want to read or reply.
  const workspace = root.querySelector('.review-workspace');
  const toggleComments = root.querySelector('#btn-toggle-comments');
  toggleComments.addEventListener('click', () => {
    const collapsed = workspace.classList.toggle('comments-collapsed');
    toggleComments.setAttribute('aria-pressed', String(!collapsed));
    toggleComments.innerHTML = collapsed
      ? '<i class="fa-solid fa-comments"></i> Show comments'
      : '<i class="fa-solid fa-comments"></i> Hide comments';
  });

  // ── Play / Edit toggle ─────────────────────────────────────────────────────
  // Play is the default so an editor isn't spoilt by the composer's revealed
  // answers. The composer iframe is loaded lazily — only the first time Edit is
  // chosen — so it never even fetches the answer until asked.
  async function setMode(next) {
    if (next === mode) return;
    mode = next;
    const editing = mode === 'edit';
    tabEdit.classList.toggle('is-active', editing);
    tabPlay.classList.toggle('is-active', !editing);
    tabEdit.setAttribute('aria-pressed', String(editing));
    tabPlay.setAttribute('aria-pressed', String(!editing));
    frame.hidden = !editing;
    playStage.hidden = editing;
    saveBtn.hidden = !editing;
    editMsg.hidden = true;

    if (editing) {
      if (game) { game.destroy(); game = null; }
      if (!composerLoaded) {
        composerLoaded = true;
        frame.src = `index.html?edit=${encodeURIComponent(puzzleId)}`;
      }
      saveBtn.disabled = !dirty;
      return;
    }
    // Back to Play: re-mount from the latest saved content.
    await mountPlay();
  }
  tabPlay.addEventListener('click', () => setMode('play'));
  tabEdit.addEventListener('click', () => setMode('edit'));

  // Start in Play, with the decisions rendered for the current state.
  renderDecisions();
  mountPlay();
}

