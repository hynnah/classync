const rateLimit = require('express-rate-limit');
const config = require('../config/env');

// Every automated test (Jest unit tests and Playwright e2e alike) turns
// TEST_AUTH_BYPASS on the same way the login bypass itself is gated — real
// limiter behavior would otherwise trip on legitimate, repeated test traffic
// (the existing test suite alone calls /api/spaces/join well over a dozen
// times across its files, and e2e tests all share one dev-server IP) rather
// than anything resembling brute-forcing. Real trip behavior is still
// covered directly in tests/unit/rateLimit.test.js, against these same
// factories with the skip forced off.
function defaultSkip() {
  return config.testAuthBypass;
}

// Brute-forcing a 6-character join code to sneak into a Space is the actual
// threat this guards against — thresholds are Day 8's own spec (§8).
function buildJoinCodeLimiter({ skip = defaultSkip } = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: (req, res) => {
      res.status(429).json({ error: 'Too many join attempts. Please wait a few minutes and try again.' });
    },
  });
}

// The callback leg specifically (not /auth/google, the redirect-out step) —
// this is the endpoint a scripted attacker would actually hammer to try
// guessing/replaying a code or state value.
function buildOauthCallbackLimiter({ skip = defaultSkip } = {}) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    // auth.routes.js's own callback responses are plain text (res.send), not
    // JSON, on every other error path — matched here for consistency.
    handler: (req, res) => {
      res.status(429).send('Too many sign-in attempts from this network. Please wait a while and try again.');
    },
  });
}

module.exports = {
  buildJoinCodeLimiter,
  buildOauthCallbackLimiter,
  joinCodeLimiter: buildJoinCodeLimiter(),
  oauthCallbackLimiter: buildOauthCallbackLimiter(),
};
