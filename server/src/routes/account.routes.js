const express = require('express');
const { requireLogin } = require('../auth/guard');
const { UserRepo } = require('../db/repositories/UserRepo');
const { CalendarTokenRepo } = require('../db/repositories/CalendarTokenRepo');
const { SpaceRepo } = require('../db/repositories/SpaceRepo');
const { disconnectAndCleanup } = require('../calendar/sync');
const { PIN_RE, hashPin } = require('../auth/notesPin');

const router = express.Router();

const WEEK_STARTS_ON_VALUES = ['sunday', 'monday'];
const OPENING_VIEW_VALUES = ['all', 'personal'];

router.get('/api/account', requireLogin, async (req, res, next) => {
  try {
    const [token, spaces] = await Promise.all([
      CalendarTokenRepo.getForUser(req.user.id),
      SpaceRepo.listSpacesForUser(req.user.id),
    ]);
    res.json({
      id: req.user.id,
      email: req.user.email,
      firstName: req.user.first_name,
      lastName: req.user.last_name,
      isAdmin: !!req.user.is_admin,
      createdAt: req.user.created_at,
      weekStartsOn: req.user.week_starts_on,
      openingView: req.user.opening_view,
      calendarConnected: !!(token && token.is_connected),
      spacesCount: spaces.length,
      organizerCount: spaces.filter((s) => s.role === 'organizer').length,
      hasNotesPin: !!req.user.notes_pin_hash,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/api/account/preferences', requireLogin, async (req, res, next) => {
  try {
    const { weekStartsOn, openingView } = req.body || {};
    if (!WEEK_STARTS_ON_VALUES.includes(weekStartsOn)) {
      return res.status(400).json({ error: `weekStartsOn must be one of: ${WEEK_STARTS_ON_VALUES.join(', ')}` });
    }
    if (!OPENING_VIEW_VALUES.includes(openingView)) {
      return res.status(400).json({ error: `openingView must be one of: ${OPENING_VIEW_VALUES.join(', ')}` });
    }
    await UserRepo.updatePreferences(req.user.id, { weekStartsOn, openingView });
    res.json({ weekStartsOn, openingView });
  } catch (err) {
    next(err);
  }
});

// Setting or changing the PIN never needs the *old* one — being signed in
// already is the recovery path for a forgotten PIN (the "Reset via Settings"
// design decision). Unlocks the session immediately after, so setting a
// fresh PIN doesn't lock the person out of the notes they're looking at.
router.post('/api/account/notes-pin', requireLogin, async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }
    await UserRepo.setNotesPinHash(req.user.id, hashPin(pin));
    req.session.notesUnlocked = true;
    res.json({ hasNotesPin: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/account/notes-pin', requireLogin, async (req, res, next) => {
  try {
    await UserRepo.setNotesPinHash(req.user.id, null);
    req.session.notesUnlocked = true;
    res.json({ hasNotesPin: false });
  } catch (err) {
    next(err);
  }
});

// Connecting is a real Google consent round-trip (GET /calendar/connect/start,
// a redirect — see calendarAuth.routes.js), not a JSON POST: there's no
// meaningful "connect" without the user actually granting Calendar access.
router.post('/api/calendar/disconnect', requireLogin, async (req, res, next) => {
  try {
    await disconnectAndCleanup(req.user.id);
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/account', requireLogin, async (req, res, next) => {
  try {
    const result = await UserRepo.deleteAccount(req.user.id);
    if (result.error === 'sole_organizer') {
      return res.status(409).json({
        error: `You're the only Organizer of "${result.spaceName}" and other Members remain — promote someone or remove everyone first.`,
      });
    }
    req.session.destroy(() => {
      res.clearCookie('classync_sid');
      res.status(204).end();
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { accountRouter: router };
