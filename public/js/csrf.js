// Patches window.fetch once, globally, so every mutating same-origin request
// this app makes automatically echoes the server's double-submit CSRF cookie
// back as a header — no per-call-site changes needed anywhere else in the
// app, now or for anything added later. Loaded first, before any other
// script that calls fetch(), on every page that performs a mutating request
// (app.html, firstrun.html).
(function () {
  const COOKIE_NAME = 'classync_csrf';
  const HEADER_NAME = 'X-CSRF-Token';
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function isSameOrigin(input) {
    try {
      const url = typeof input === 'string' ? input : input.url;
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
      return false;
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method) || !isSameOrigin(input)) {
      return originalFetch(input, init);
    }
    const token = readCookie(COOKIE_NAME);
    if (!token) return originalFetch(input, init);
    const headers = new Headers(init.headers || (input && input.headers) || undefined);
    headers.set(HEADER_NAME, token);
    return originalFetch(input, Object.assign({}, init, { headers }));
  };
})();
