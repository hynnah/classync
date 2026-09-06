const express = require('express');
const { requireLogin } = require('../auth/guard');
const sseHub = require('../realtime/sseHub');

const router = express.Router();

// A heartbeat comment line every 25s — under most proxy/load-balancer idle
// timeouts (commonly 30-60s) — keeps the connection from being silently
// dropped by anything sitting between the browser and this server. A comment
// line (":" prefix) is invisible to EventSource's own event/message parsing.
const HEARTBEAT_MS = 25000;

router.get('/sse/updates', requireLogin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  sseHub.subscribe(req.user.id, res);

  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseHub.unsubscribe(req.user.id, res);
  });
});

module.exports = { sseRouter: router };
