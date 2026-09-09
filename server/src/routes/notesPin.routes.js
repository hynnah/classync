const express = require('express');
const { requireLogin } = require('../auth/guard');
const { verifyPin } = require('../auth/notesPin');
const { notesPinLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Unlock is a session flag, not anything persisted — a fresh page load
// starts locked again (client.js calls /lock once at bootstrap), staying
// unlocked only for as long as this one page stays open. Wrong-PIN attempts
// are rate-limited (notesPinLimiter) since a 4-digit PIN has only 10,000
// possible values.
router.post('/api/notes-pin/verify', requireLogin, notesPinLimiter, async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    if (!req.user.notes_pin_hash) {
      req.session.notesUnlocked = true;
      return res.json({ unlocked: true });
    }
    if (typeof pin !== 'string' || !verifyPin(pin, req.user.notes_pin_hash)) {
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }
    req.session.notesUnlocked = true;
    res.json({ unlocked: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/notes-pin/lock', requireLogin, async (req, res, next) => {
  try {
    req.session.notesUnlocked = false;
    res.json({ unlocked: false });
  } catch (err) {
    next(err);
  }
});

module.exports = { notesPinRouter: router };
