// ============================================================================
//  APP BAR  —  shared brand + (admin-only) CMS switcher
// ============================================================================
// The platform hosts two separate editorial areas that share one sign-in:
//   • Relink   — the submission/review platform (platform.html)
//   • Guess Who — the standalone Guess Who editor (guesswho.html)
//
// The product is branded "Puzzles"; each area keeps its own name. Admins can
// move between the two areas via a dropdown on the brand. Everyone else only has
// access to one area, so they see a static brand (no switcher). This is a
// CONVENIENCE affordance only — RLS + the per-page role gates are the real
// boundary; the switcher just links to the other page.
// ============================================================================
import { esc } from './dom.js';

// The switchable areas. `id` matches what each page passes as `current`.
export const APPS = [
  { id: 'relink', label: 'Relink', href: 'platform.html' },
  { id: 'guesswho', label: 'Guess Who', href: 'guesswho.html' },
];

// Build the brand markup. `current` is 'relink' | 'guesswho'; only admins get the
// interactive switcher (others see the current area as a static label).
export function brandHtml(current, isAdmin) {
  const app = APPS.find((a) => a.id === current) || APPS[0];

  if (!isAdmin) {
    return `<div class="app-brand-wrap">
      <span class="app-brand">Puzzles</span>
      <span class="app-brand-sep">/</span>
      <span class="app-brand-area">${esc(app.label)}</span>
    </div>`;
  }

  const items = APPS.map((a) =>
    `<a class="app-switcher-item${a.id === current ? ' is-current' : ''}" href="${a.href}" role="menuitem">
       <span>${esc(a.label)} CMS</span>
       ${a.id === current ? '<i class="fa-solid fa-check"></i>' : ''}
     </a>`).join('');

  return `<div class="app-brand-wrap">
    <span class="app-brand">Puzzles</span>
    <span class="app-brand-sep">/</span>
    <button class="app-brand-switch" data-brand-toggle aria-haspopup="true" aria-expanded="false">
      ${esc(app.label)} <i class="fa-solid fa-chevron-down"></i>
    </button>
    <div class="app-switcher-menu" data-brand-menu hidden role="menu">${items}</div>
  </div>`;
}

// Wire the dropdown: toggle on click, close on outside-click or Escape. `scope`
// is the element containing the brand markup (e.g. the topbar). No-op when the
// brand is static (non-admin), since the toggle/menu won't be present.
export function wireBrand(scope) {
  const toggle = scope?.querySelector('[data-brand-toggle]');
  const menu = scope?.querySelector('[data-brand-menu]');
  if (!toggle || !menu) return;

  const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); };

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !scope.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
