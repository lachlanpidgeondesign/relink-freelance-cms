// Tiny shared DOM helpers for the platform views.

// Escape user/DB text before it goes into innerHTML, to prevent XSS. Mirrors the
// esc() used by the existing composer (js/app.js).
export function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
