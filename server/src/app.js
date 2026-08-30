const path = require('path');
const express = require('express');
const config = require('./config/env');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'client')));

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
