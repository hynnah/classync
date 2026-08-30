const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config/env');
const { sessionStore } = require('./auth/sessionStore');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'client')));

  app.use(session({
    name: 'classync_sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', env: config.nodeEnv });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Classync listening on port ${config.port} (${config.nodeEnv})`);
  });
}

module.exports = { createApp };
