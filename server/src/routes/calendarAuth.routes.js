const express = require('express');
const crypto = require('crypto');
const { requireLogin } = require('../auth/guard');
const { buildCalendarAuthUrl, exchangeCalendarCode } = require('../auth/oauth');
const { encrypt } = require('../auth/tokenCrypto');
const { CalendarTokenRepo } = require('../db/repositories/CalendarTokenRepo');
const { backfillForUser } = require('../calendar/sync');

const router = express.Router();

// A separate, later consent step — never bundled into /auth/google. Only
// reachable once already signed in (requireLogin), matching "opt-in, revocable
// any time" rather than something forced at sign-in.
router.get('/calendar/connect/start', requireLogin, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.calendarOauthState = state;
  req.session.save(() => {
    res.redirect(buildCalendarAuthUrl(state));
  });
});

router.get('/calendar/connect/callback', requireLogin, async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.session.calendarOauthState;
  delete req.session.calendarOauthState;

  if (error || !state || !expectedState || state !== expectedState) {
    return res.redirect('/app?calendar=error');
  }

  try {
    const refreshToken = await exchangeCalendarCode(code);
    await CalendarTokenRepo.connect(req.user.id, encrypt(refreshToken));
  } catch (err) {
    console.error('Calendar connect callback failed:', err.message);
    return res.redirect('/app?calendar=error');
  }

  // Backfill is best-effort — a partial/failed backfill doesn't mean the
  // connect itself failed, the token is already saved either way.
  try {
    await backfillForUser(req.user.id);
  } catch (err) {
    console.error(`Calendar backfill failed for user ${req.user.id}:`, err.message);
  }

  res.redirect('/app?calendar=connected');
});

module.exports = { calendarAuthRouter: router };
