const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');

describe('server boots', () => {
  const app = createApp();

  beforeAll(() => sessionStore.onReady());
  afterAll(async () => {
    await sessionStore.close();
    await getPool().end();
  });

  test('GET /health returns 200 and ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
