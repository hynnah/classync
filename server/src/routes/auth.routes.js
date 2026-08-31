const express = require('express');
const crypto = require('crypto');
const { buildAuthUrl, exchangeCodeForProfile } = require('../auth/oauth');
const { UserRepo } = require('../db/repositories/UserRepo');

const router = express.Router();

router.get('/auth/google', (req, res) => {
  if (req.query.ageConfirmed !== 'true') {
    return res.status(400).json({ error: 'Age confirmation is required before signing in.' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.ageConfirmed = true;
  req.session.save(() => {
    res.redirect(buildAuthUrl(state));
  });
});

router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send('Google sign-in was cancelled or denied.');
  }
  if (!state || !req.session.oauthState || state !== req.session.oauthState) {
    return res.status(400).send('Invalid or expired sign-in attempt. Please try again.');
  }

  const ageConfirmed = !!req.session.ageConfirmed;
  delete req.session.oauthState;
  delete req.session.ageConfirmed;

  try {
    const profile = await exchangeCodeForProfile(code);
    const user = await UserRepo.upsertFromGoogle({ ...profile, ageConfirmed });

    if (!user.is_active) {
      return res.status(403).send('This account has been deactivated.');
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).send('Sign-in failed. Please try again.');
      }
      req.session.userId = user.id;
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) {
    console.error('Google OAuth callback failed:', err);
    res.status(500).send('Sign-in failed. Please try again.');
  }
});

module.exports = { authRouter: router };
