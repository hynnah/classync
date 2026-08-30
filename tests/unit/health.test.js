const request = require('supertest');
const { createApp } = require('../../server/src/app');

describe('server boots', () => {
  const app = createApp();

  test('GET /health returns 200 and ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
