// Simple hash router utilities

export function showView(key) {
  // Support optional query string (e.g., person?pid=...)
  const baseKey = String(key || '').split('?')[0];
  const views = Array.from(document.querySelectorAll('[data-view]'));
  for (const v of views) v.hidden = v.dataset.view !== baseKey;
  window.location.hash = `#/${baseKey}`;
  document.querySelectorAll('[data-route]').forEach(btn => {
    const route = btn.getAttribute('data-route') || '';
    const isActive = route === `#/${baseKey}`;
    btn.setAttribute('aria-current', String(isActive));
  });
}

export function initRouter(defaultKey = 'take') {
  function applyHash() {
    const raw = window.location.hash.replace('#/', '') || defaultKey;
    const key = String(raw).split('?')[0];
    showView(key);
  }
  window.addEventListener('hashchange', applyHash);
  applyHash();
}
