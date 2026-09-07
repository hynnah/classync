const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

const express = require('express');
const request = require('supertest');
const {
  buildJoinCodeLimiter,
  buildOauthCallbackLimiter,
  joinCodeLimiter,
} = require('../../server/src/middleware/rateLimit');

afterAll(() => {
  process.env.TEST_AUTH_BYPASS = ORIGINAL_TEST_AUTH_BYPASS;
});

function appWithLimiter(limiter) {
  const app = express();
  app.get('/probe', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('rate limiting', () => {
  test('the join-code limiter allows exactly its limit (10), then trips with a JSON 429', async () => {
    const app = appWithLimiter(buildJoinCodeLimiter({ skip: () => false }));
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/probe');
      expect(res.status).toBe(200);
    }
    const tripped = await request(app).get('/probe');
    expect(tripped.status).toBe(429);
    expect(tripped.body.error).toMatch(/too many join attempts/i);
  });

  test('the OAuth callback limiter allows exactly its limit (20), then trips with a plain-text 429', async () => {
    const app = appWithLimiter(buildOauthCallbackLimiter({ skip: () => false }));
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/probe');
      expect(res.status).toBe(200);
    }
    const tripped = await request(app).get('/probe');
    expect(tripped.status).toBe(429);
    expect(tripped.text).toMatch(/too many sign-in attempts/i);
  });

  test('the real, app-mounted limiter is skipped under TEST_AUTH_BYPASS — why the rest of the suite hammering these routes never trips it', async () => {
    const app = appWithLimiter(joinCodeLimiter);
    for (let i = 0; i < 15; i++) {
      const res = await request(app).get('/probe');
      expect(res.status).toBe(200);
    }
  });
});
