require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || '';
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:3000/auth/google/callback',
    // A separate registered redirect URI from the sign-in one above — Google
    // sends the browser back to whichever exact URI was used to build the
    // consent link, so the incremental Calendar-consent flow (a distinct
    // route, calendarAuth.routes.js) needs its own rather than reusing
    // auth.routes.js's callback.
    calendarRedirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI || 'http://localhost:3000/calendar/connect/callback',
  },
  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),
  testAuthBypass: process.env.TEST_AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production',
};
