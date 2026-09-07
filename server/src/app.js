const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config/env');
const { sessionStore } = require('./auth/sessionStore');
const { requireLogin } = require('./auth/guard');
const { ensureCsrfCookie, requireCsrfToken } = require('./auth/csrf');
const { mountTestBypass } = require('./auth/testBypass');
const { authRouter } = require('./routes/auth.routes');
const { pagesRouter } = require('./routes/pages.routes');
const { itemsRouter } = require('./routes/items.routes');
const { spacesRouter } = require('./routes/spaces.routes');
const { accountRouter } = require('./routes/account.routes');
const { calendarAuthRouter } = require('./routes/calendarAuth.routes');
const { adminRouter } = require('./routes/admin.routes');
const { sseRouter } = require('./routes/sse.routes');

function createApp() {
  const app = express();

  // Only trust the reverse proxy's X-Forwarded-For in production — that's
  // the one environment actually sitting behind one (school server/Clever
  // Cloud, per .env.example). Trusting it in dev would just let a client
  // spoof its own rate-limit key via the header.
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);

  app.use(express.json());

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

  // Global: ensureCsrfCookie seeds the double-submit cookie on any response
  // that doesn't have one yet; requireCsrfToken then gates every mutating
  // request (GET/HEAD/OPTIONS pass through untouched) behind that cookie
  // being echoed back as a header. Mounted ahead of every router so nothing
  // downstream — including /auth/logout, defined further below in this same
  // file — can be reached without passing through it first.
  app.use(ensureCsrfCookie);
  app.use(requireCsrfToken);

  app.use(pagesRouter);
  app.use(itemsRouter);
  app.use(spacesRouter);
  app.use(accountRouter);
  app.use(calendarAuthRouter);
  app.use(adminRouter);
  app.use(sseRouter);

  app.use(express.static(path.join(__dirname, '..', '..', 'client')));

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

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
