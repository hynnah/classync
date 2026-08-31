const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config/env');
const { sessionStore } = require('./auth/sessionStore');
const { requireLogin } = require('./auth/guard');
const { mountTestBypass } = require('./auth/testBypass');
const { authRouter } = require('./routes/auth.routes');

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
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }));

  app.use(authRouter);

  if (config.testAuthBypass) {
    mountTestBypass(app);
  }

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('classync_sid');
      res.json({ ok: true });
    });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', env: config.nodeEnv });
  });

  app.get('/api/me', requireLogin, (req, res) => {
    res.json({
      id: req.user.id,
      email: req.user.email,
      firstName: req.user.first_name,
      lastName: req.user.last_name,
      isAdmin: !!req.user.is_admin,
    });
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
