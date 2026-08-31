const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');

describe('TEST_AUTH_BYPASS flow', () => {
  const app = createApp();

  afterAll(async () => {
    process.env.TEST_AUTH_BYPASS = ORIGINAL_TEST_AUTH_BYPASS;
    await sessionStore.close();
    await getPool().end();
  });

  test('logs in via bypass, /api/me reflects it, logout blocks it again', async () => {
    const email = `bypass-${Date.now()}@example.com`;
    const agent = request.agent(app);

    const bypassRes = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    expect(bypassRes.status).toBe(200);
    expect(bypassRes.body.email).toBe(email);

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe(email);
    expect(meRes.body.isAdmin).toBe(false);

    await agent.post('/auth/logout');

    const meAfterLogout = await agent.get('/api/me');
    expect(meAfterLogout.status).toBe(401);

    await getPool().query('DELETE FROM users WHERE email = ?', [email]);
  });

  test('admin=true grants admin, admin=false revokes it on the same identity', async () => {
    const email = `bypass-admin-${Date.now()}@example.com`;
    const agent = request.agent(app);

    const asAdmin = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}&admin=true`);
    expect(asAdmin.body.isAdmin).toBe(true);

    const asNonAdmin = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}&admin=false`);
    expect(asNonAdmin.body.isAdmin).toBe(false);

    await getPool().query('DELETE FROM users WHERE email = ?', [email]);
  });
});
