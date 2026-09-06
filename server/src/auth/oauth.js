const { google } = require('googleapis');
const config = require('../config/env');

const SCOPES = ['openid', 'email', 'profile'];

// Event-level access only (not the broader `calendar` scope) — least privilege
// for what Day 7 actually needs: creating/updating/deleting the events Classync
// itself pushes, not reading or managing the rest of a user's calendar.
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function createOAuthClient(redirectUri = config.google.redirectUri) {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUri
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

// A separate, later consent step (FR/Day 7) — never bundled into sign-in.
// `prompt: 'consent'` forces Google to hand back a refresh_token every time,
// even for a user who granted this scope before and disconnected since (Google
// otherwise only returns one on a scope's *first* grant), which matters because
// disconnect deletes the stored token outright rather than just hiding it.
function buildCalendarAuthUrl(state) {
  return createOAuthClient(config.google.calendarRedirectUri).generateAuthUrl({
    scope: CALENDAR_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
  });
}

async function exchangeCalendarCode(code) {
  const client = createOAuthClient(config.google.calendarRedirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token for the Calendar consent grant.');
  }
  return tokens.refresh_token;
}

module.exports = { buildAuthUrl, exchangeCodeForProfile, buildCalendarAuthUrl, exchangeCalendarCode };
