const { google } = require('googleapis');
const config = require('../config/env');
const { decrypt } = require('../auth/tokenCrypto');

function oauthClientForRefreshToken(encryptedRefreshToken) {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  client.setCredentials({ refresh_token: decrypt(encryptedRefreshToken) });
  return client;
}

function clientForRefreshToken(encryptedRefreshToken) {
  return google.calendar({ version: 'v3', auth: oauthClientForRefreshToken(encryptedRefreshToken) });
}

async function revokeToken(encryptedRefreshToken) {
  await oauthClientForRefreshToken(encryptedRefreshToken).revokeCredentials();
}

module.exports = { clientForRefreshToken, revokeToken };
