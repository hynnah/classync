const express = require('express');
const { requireLogin } = require('../auth/guard');
const { UserRepo } = require('../db/repositories/UserRepo');
const { CalendarTokenRepo } = require('../db/repositories/CalendarTokenRepo');

const router = express.Router();

router.get('/api/account', requireLogin, async (req, res, next) => {
  try {
    const token = await CalendarTokenRepo.getForUser(req.user.id);
    res.json({
      id: req.user.id,
      email: req.user.email,
      firstName: req.user.first_name,
      lastName: req.user.last_name,
      calendarConnected: !!(token && token.is_connected),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/api/calendar/connect', requireLogin, async (req, res, next) => {
  try {
    await CalendarTokenRepo.connect(req.user.id);
    res.json({ connected: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/calendar/disconnect', requireLogin, async (req, res, next) => {
  try {
    await CalendarTokenRepo.disconnect(req.user.id);
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
