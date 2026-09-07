const crypto = require('crypto');
const config = require('../config/env');

const COOKIE_NAME = 'classync_csrf';
const HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Mounted globally, ahead of every route — seeds the double-submit cookie on
// the very first response to this browser (any route, not just a mutating
// one) so it already exists by the time a mutating request ever happens.
// Not httpOnly: the client's own fetch patch (client/js/csrf.js) has to be
// able to read it to echo it back as a header.
function ensureCsrfCookie(req, res, next) {
  if (!readCookie(req, COOKIE_NAME)) {
    res.cookie(COOKIE_NAME, crypto.randomBytes(32).toString('hex'), {
      httpOnly: false,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      path: '/',
    });
  }
  next();
}

// Every automated test — Jest unit tests (supertest calls routes directly)
// and Playwright e2e (page.request bypasses the page's own JS entirely) —
// turns TEST_AUTH_BYPASS on the same way the login bypass and rate limiting
// are already gated by it. Neither goes through the browser fetch patch that
// echoes this cookie back as a header, so real enforcement would reject
// virtually every existing mutating-route test. Real rejection behavior is
// covered directly in tests/unit/csrf.test.js, against this same middleware
// with the skip forced off; the client patch itself is covered in
// tests/e2e/csrf.spec.js by inspecting outgoing request headers rather than
// relying on server-side enforcement being live.
function defaultSkip() {
  return config.testAuthBypass;
}

function buildCsrfMiddleware({ skip = defaultSkip } = {}) {
  return function requireCsrfToken(req, res, next) {
    if (SAFE_METHODS.has(req.method) || skip(req)) return next();
    const cookieToken = readCookie(req, COOKIE_NAME);
    const headerToken = req.headers[HEADER_NAME];
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return res.status(403).json({ error: 'Missing or invalid CSRF token.' });
    }
    next();
  };
}

module.exports = {
  ensureCsrfCookie,
  buildCsrfMiddleware,
  requireCsrfToken: buildCsrfMiddleware(),
  COOKIE_NAME,
  HEADER_NAME,
};
