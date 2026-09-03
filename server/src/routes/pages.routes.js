const path = require('path');
const express = require('express');
const { UserRepo } = require('../db/repositories/UserRepo');

const CLIENT_DIR = path.join(__dirname, '..', '..', '..', 'client');

const router = express.Router();

async function loadSessionUser(req) {
  if (!req.session || !req.session.userId) {
    return null;
  }
  const user = await UserRepo.findById(req.session.userId);
  if (!user || !user.is_active) {
    req.session.destroy(() => {});
    return null;
  }
  return user;
}

router.get('/app', async (req, res, next) => {
  try {
    const user = await loadSessionUser(req);
    if (!user) {
      return res.redirect('/signin.html?next=app');
    }
    if (!user.onboarded_at) {
      return res.redirect('/firstrun.html');
    }
    res.sendFile(path.join(CLIENT_DIR, 'app.html'));
  } catch (err) {
    next(err);
  }
});

router.get('/firstrun.html', async (req, res, next) => {
  try {
    const user = await loadSessionUser(req);
    if (!user) {
      return res.redirect('/signin.html?next=firstrun');
    }
    if (user.onboarded_at) {
      return res.redirect('/app');
    }
    res.sendFile(path.join(CLIENT_DIR, 'firstrun.html'));
  } catch (err) {
    next(err);
  }
});

router.get('/continue-solo', async (req, res, next) => {
  try {
    const user = await loadSessionUser(req);
    if (!user) {
      return res.redirect('/signin.html?next=solo');
    }
    await UserRepo.markOnboarded(user.id);
    res.redirect('/app');
  } catch (err) {
    next(err);
  }
});

module.exports = { pagesRouter: router };
