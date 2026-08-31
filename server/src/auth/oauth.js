const { google } = require('googleapis');
const config = require('../config/env');

const SCOPES = ['openid', 'email', 'profile'];

function createOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

function buildAuthUrl(state) {
  return createOAuthClient().generateAuthUrl({
    scope: SCOPES,
    state,
    prompt: 'select_account',
  });
}

async function exchangeCodeForProfile(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload.email_verified) {
    throw new Error('Google account email is not verified.');
  }
  return {
    googleSub: payload.sub,
    email: payload.email,
    firstName: payload.given_name || '',
    lastName: payload.family_name || '',
  };
}

module.exports = { buildAuthUrl, exchangeCodeForProfile };
