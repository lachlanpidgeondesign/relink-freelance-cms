# Relink CMS — design & code conventions

## ⚠️ The single most important fact: there are TWO separate, conflicting design systems

There is no shared stylesheet across the whole app. Two independent token sets exist, and they **disagree on the same variable names**:

1. **css/styles.css** — a shadcn/ui-inspired system, linked by composer.html and the relink-game. Primary is near-black.
2. **Inline `<style>` in platform.html** — a self-contained set with its own token names. Primary is indigo.

A new page must consciously pick one. (For reference, the guesswho.html stub currently links css/styles.css, so it inherits the shadcn tokens — **not** the platform's indigo look.)

---

## DESIGN TOKENS

### Where CSS lives
- **css/styles.css** — one big external stylesheet (~all composer/game styles). Linked via `<link rel="stylesheet" href="css/styles.css">`.
- **platform.html** — a single inline `<style>` block in the `<head>`. The submission platform has **no external CSS at all**; every class it uses is defined inline. Its own header comment calls it a scaffold: *"Minimal styling for the auth + stub views. The real design system arrives with the real UI in a later phase."*
- **No per-component CSS files, no CSS modules, no CSS-in-JS.**

### Colour values — they differ by file

**platform.html tokens:**
```css
:root {
  --bg: #f6f7f9; --card: #ffffff; --fg: #1a1a1e; --muted: #6b7280;
  --border: #e5e7eb; --primary: #4f46e5; --primary-fg: #ffffff;
  --error: #dc2626; --radius: 10px;
}
```

**css/styles.css tokens:**
```css
--background: #ffffff;
--foreground: #0a0a0a;
--muted: #f4f4f5;
--muted-foreground: #71717a;
--border: #e4e4e7;
--input: #e4e4e7;
--ring: #3b82f6;
--primary: #18181b;
--primary-foreground: #fafafa;
--destructive: #ef4444;
--success: #22c55e;
```
Plus four puzzle row-accent colours: `--row-0:#9B95F0` (purple), `--row-1:#94CAFF` (blue), `--row-2:#66E0C4` (green), `--row-3:#F8CD8B` (orange).

| Role | platform.html | css/styles.css |
|---|---|---|
| Page background | `--bg: #f6f7f9` | `--background: #ffffff` |
| Card/panel | `--card: #ffffff` | `--background` (no dedicated card token) |
| Primary text | `--fg: #1a1a1e` | `--foreground: #0a0a0a` |
| Muted text | `--muted: #6b7280` | `--muted-foreground: #71717a` (note: `--muted` here is a *background* `#f4f4f5`) |
| Border | `--border: #e5e7eb` | `--border: #e4e4e7` |
| Accent/primary | `--primary: #4f46e5` (indigo) | `--primary: #18181b` (near-black); focus accent `--ring: #3b82f6` |
| Error/destructive | `--error: #dc2626` | `--destructive: #ef4444` |

Note the naming trap: `--muted` means *muted text* in platform.html but a *muted background fill* in styles.css. They are not interchangeable.

Also note some **hardcoded hex outside the token system** — e.g. success greens in the admin invite result are inline literals, not tokens: `background:#f0fdf4; border:1px solid #bbf7d0; color:#15803d`. The admin message "ok" colour is likewise a literal `#15803d`.

### Fonts
- **Plus Jakarta Sans**, loaded from Bunny Fonts (privacy-friendly Google Fonts mirror) in both files:
  ```html
  <link rel="preconnect" href="https://fonts.bunny.net" crossorigin>
  <link href="https://fonts.bunny.net/css?family=plus-jakarta-sans:400,500,600,700" rel="stylesheet">
  ```
- **Weights loaded: 400, 500, 600, 700.**
- Stack: `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- Base `font-size: 14px`, `line-height: 1.5`.

### Type scale
Ad-hoc (px values per component), but consistent in practice:
- Page heading (`.auth-title`): 26px. Section `<h2>` (`.view-header h2`): 20px. Panel `<h3>` (`.admin-subhead`): 15px, `.rcol-title`/`.review-nav-title`: 15–17px.
- Body/input: 14px. Labels (`.auth-label`): 13px, weight 500. Helper/muted text (`.auth-subtitle`, `.view-hint`, `.inline-msg`): 12.5–14px in `--muted`.
- Badges/pills: 11–12px, weight 600–700, often `text-transform: uppercase` with `letter-spacing: .03em`.

### Spacing, radius, elevation
- **No spacing scale / no spacing variables.** Padding and gap are ad-hoc px, though values cluster on a rough 4px rhythm (6, 8, 10, 12, 14, 18, 24).
- **Border radius:** ad-hoc. platform.html: `--radius: 10px` (defined but most components use literal `8px`; pills use `999px`; modals `14px`). styles.css: consistent `6px` on buttons/inputs, `3px` scrollbars.
- **Shadows:** light and ad-hoc. Cards: `box-shadow: 0 1px 3px rgba(0,0,0,.06)`; inputs in styles.css: `0 1px 2px 0 rgb(0 0 0 / 0.05)`; modal: `0 20px 50px rgba(0,0,0,.25)`. No elevation scale/tokens.
- **Transitions:** styles.css uses `transition: all 0.15s` on buttons/inputs; platform.html mostly relies on default (hover colour swaps only).

---

## COMPONENTS

### Buttons
Two different kits.

**styles.css kit** (composer): `.btn-primary`, `.btn-ghost`, `.btn-ghost-sm`, `.btn-icon`, `.btn-sm`. Primary is a filled near-black button:
```css
.btn-primary {
  background: var(--primary); color: var(--primary-foreground);
  font-weight: 500; font-size: 14px; height: 36px; padding: 0 16px;
  border-radius: 6px;
}
```
`.btn-ghost` = transparent with border; `.btn-icon` = 28×28 square icon button. **There is no destructive button class in styles.css.**

**platform.html kit** (a fuller set, "Shared button kit"): `.btn-primary` (indigo fill), `.btn-ghost` (bordered), `.btn-danger` (red fill), `.btn-danger-ghost` (red text/tinted), plus `.btn-sm` modifier and a bespoke `.btn-play`. So **primary/secondary/destructive all exist only in platform.html**; styles.css has primary + ghost only.

The two kits collide: `.btn-primary`, `.btn-ghost`, `.btn-sm` are defined in *both* files with different values. Whichever stylesheet the page loads wins.

### Form fields
No shared form helper — markup is hand-rolled per view. The most complete example is the auth form (label + input + status paragraph):
```html
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
```
Conventions: explicit `<label for>`, native `required`/`type`/`minlength` validation, `placeholder` for examples, and a single status `<p role="status" aria-live="polite">` for messages. **There is no dedicated per-field error state / no `.field-error` class** — errors surface through the one shared status paragraph (see below), whose class is swapped to an `-error` variant.

### Status badges / pills
Two distinct pill styles, and a colour mapping that is **effectively single-colour, not per-state**:
- `.state-pill` (review header): indigo on `#eef2ff`, used for the workflow state via `STATE_LABEL`:
  ```html
  <span id="review-state" class="state-pill">${esc(STATE_LABEL[item.state] || item.state)}</span>
  ```
- `.app-role-badge`, `.queue-group-count`, `.admin-you`, `.view-row-new` — same indigo-on-`#eef2ff` treatment.

**State→label map** (js/platform/router.js):
```js
const STATE_LABEL = {
  submitted: 'Submitted', in_review: 'In review',
  changes_requested: 'Changes requested', ready: 'Ready',
  published: 'Published', draft: 'Draft',
};
```
Gap to flag: **there is no per-state colour mapping.** Every state renders the same indigo pill. A `.view-row-state` grey-pill class *is defined* in platform.html but is **not used anywhere** (the queue groups by state via headings instead), so it's dead CSS. If you want colour-coded states, you'd be inventing it.

### Tables / list rows
No `<table>` anywhere. Lists are flex rows. Queue row shape (js/platform/router.js):
```html
<div class="view-row${newBadge ? ' is-unopened' : ''}">
  ${newBadge}
  <span class="view-row-title">${primary}</span>
  ${claimed}
  <span class="view-row-date">${esc(p.publish_date || '—')}</span>
  <span class="view-row-action">
    <button class="btn-play" data-review-id="${esc(p.id)}">${openLabel}</button>
  </span>
</div>
```
Pattern: a `.view-row` flex container, a flex-1 `.view-row-title` (with a `<small>` subtitle), trailing metadata, and an action button carrying a `data-*` id for event delegation. The admin "People" list follows the same idea with `.admin-user` rows.

### Feedback: toasts / inline messages
**There is no toast system anywhere** — no `toast`, `notify`, or snackbar helper exists. Feedback is always an **inline status element** whose text and class are set imperatively. Example helper (defined inline per-view, not shared):
```js
function setInviteMsg(text, kind = 'info') {
  inviteMsg.hidden = false;
  inviteMsg.textContent = text;
  inviteMsg.className = `admin-msg admin-msg-${kind}`;
}
```
Variants: `.admin-msg-info` (muted), `.admin-msg-ok` (`#15803d` green), `.admin-msg-error` (red). The auth view uses the parallel `.auth-message` / `.auth-message-error`, and review views use `.inline-msg` / `.inline-msg-error`. Every view re-implements this rather than calling one utility.

### Empty & loading states
Both exist, as plain text (no spinner component):
- **Loading:** `<div class="app-loading">Loading…</div>` (the initial mount in platform.html), and lists set `innerHTML = 'Loading…'` before fetch.
- **Empty:** `<p class="view-empty">The queue is empty.</p>` / `"No users found."`.
- **Error:** `<p class="view-error">…</p>`.

---

## ICONS

- **Font Awesome 6.5.1**, loaded as a **webfont via CDN** in every page:
  ```html
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  ```
- **Rendering syntax:** an empty `<i>` with solid-style classes, e.g. `<i class="fa-solid fa-plus"></i> New level`. No inline SVG sprite system for icons (though hand-written inline `<svg>` appears in composer's header for the drafts hamburger).
- **Icons already in use** (platform side): `fa-plus` (new level), `fa-play` (play), `fa-pen-ruler` (edit), `fa-comments` (show/hide comments). Composer header adds `fa-rotate-left`/`fa-rotate-right` (undo/redo), `fa-floppy-disk` (save), `fa-paper-plane` (send to editor), `fa-arrow-right-from-bracket` (sign out), `fa-magnifying-glass`, `fa-xmark`, `fa-sliders`, `fa-filter`, `fa-arrow-down-wide-short`, arrows, `fa-check`.
- Convention (from CLAUDE.md): **Font Awesome solid only, no emoji icons.**

---

## CODE PATTERNS

### Page module structure
- **Vanilla ES modules**, no framework/bundler. Each HTML page loads exactly one entry module: platform.html → `<script type="module" src="js/platform/main.js">`; composer.html → `js/app.js`.
- **Layered platform modules** under js/platform/: `config.js` (project constants) → `client.js` (the Supabase singleton) → `auth.js` / `db.js` (thin wrappers; db.js is the **only** file allowed to call `supabase.from(...)`) → `router.js` (all views) → `main.js` (bootstrap). `dom.js` holds shared helpers.
- **Init-after-auth:** the app hangs off `onAuthChange`. main.js fetches the role then routes:
  ```js
  const role = await getCurrentUserRole();
  routeByRole(mount, role, { email: session.user?.email, onSignOut: … });
  ```
  The composer uses a simpler gate: `const session = await getSession(); if (!session) { location.replace('platform.html'); return; }`.

### Supabase client
One shared singleton, imported from CDN, created once (js/platform/client.js):
```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
```
Every module imports **this** `supabase`; a second client is explicitly forbidden (would fight over token refresh). Config values are the public URL + publishable key (js/platform/config.js); secrets never live client-side.

### View switching within a page
Yes, in the staff shell only, and it's **imperative `innerHTML` swapping** — no router library, no hash routes, no History API. `routeByRole()` renders a shell then a delegated nav-click handler re-renders `#view-root`:
```js
nav?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav]');
  if (!btn) return;
  if (btn.dataset.nav === 'team') { setActiveNav('team'); renderAdminView(viewRoot, ctx); }
  else if (btn.dataset.nav === 'create') { setActiveNav('create'); renderCreateView(viewRoot, ctx); }
  else { setActiveNav('queue'); renderQueueView(viewRoot, ctx); }
});
```
Each `render*View(root, ctx)` builds a template string into `root.innerHTML`, queries its own elements, and wires event listeners. Cross-page navigation is `window.location.replace('…html')`.

### Shared helpers for forms / tables / toasts?
**Essentially none.** The only shared UI helper is `esc()` for XSS-safe interpolation (js/platform/dom.js):
```js
export function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
```
Formatting helpers (`fmtTime`, `roleLabel`, `displayName`) live locally in router.js, not a shared util. There is **no `renderForm`, `renderTable`, `renderToast`, or component library** — every view hand-rolls its markup as a template literal and repeats patterns (the status-message setter, the loading/empty strings) inline. Event handling is consistently **delegation via `e.target.closest('[data-*]')`**.

---

## Gaps to know before building a new page
1. **Pick a design system deliberately** — the two token sets clash on `--primary`, `--muted`, `--border`, and on `.btn-primary`/`.btn-ghost`/`.btn-sm`. There's no merged/shared theme.
2. **No per-state colour coding** — all pills are indigo; `.view-row-state` is dead CSS.
3. **No destructive button in css/styles.css** — only platform.html has `.btn-danger`.
4. **No shared form/table/toast helpers and no toast system** — expect to hand-roll markup and reuse the inline status-`<p>` pattern.
5. **No spacing scale and inconsistent radii** (10px token vs 8px/6px literals).
6. **Some colours are hardcoded literals** (success greens `#15803d`/`#f0fdf4`/`#bbf7d0`) rather than tokens.
7. **Routing is manual `innerHTML` swapping** — there's no framework to lean on.
