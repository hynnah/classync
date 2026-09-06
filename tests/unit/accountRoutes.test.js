const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');

afterAll(async () => {
  process.env.TEST_AUTH_BYPASS = ORIGINAL_TEST_AUTH_BYPASS;
  await sessionStore.close();
  await getPool().end();
});

describe('/api/account and /api/calendar', () => {
  const app = createApp();
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'accountroutes-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `accountroutes-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    const res = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return { agent, userId: res.body.userId, email };
  }

  test('GET /api/account requires login', async () => {
    const res = await request(app).get('/api/account');
    expect(res.status).toBe(401);
  });

  test('GET /api/account reports calendarConnected: false with no prior opt-in', async () => {
    const { agent } = await loggedInAgent('me-default');
    const res = await agent.get('/api/account');
    expect(res.status).toBe(200);
    expect(res.body.calendarConnected).toBe(false);
  });

  test('connect then disconnect flips calendarConnected, and disconnect actually erases the row', async () => {
    const { agent, userId } = await loggedInAgent('calendar-toggle');

    const connect = await agent.post('/api/calendar/connect');
    expect(connect.status).toBe(200);
    expect(connect.body.connected).toBe(true);
    let me = await agent.get('/api/account');
    expect(me.body.calendarConnected).toBe(true);

    const disconnect = await agent.post('/api/calendar/disconnect');
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.connected).toBe(false);
    me = await agent.get('/api/account');
    expect(me.body.calendarConnected).toBe(false);

    const [rows] = await getPool().query('SELECT * FROM google_calendar_tokens WHERE user_id = ?', [userId]);
    expect(rows).toHaveLength(0);
  });

  test('DELETE /api/account removes the account and destroys the session', async () => {
    const { agent } = await loggedInAgent('delete-happy');
    const res = await agent.delete('/api/account');
    expect(res.status).toBe(204);

    const after = await agent.get('/api/me');
    expect(after.status).toBe(401);
  });

  test('DELETE /api/account is blocked with 409 when the caller is the sole Organizer of a Space with other Members', async () => {
    const { agent: ownerAgent, userId: ownerId } = await loggedInAgent('delete-blocked-owner');
    const created = await ownerAgent.post('/api/spaces').send({ name: 'Delete blocked route test' });
    createdSpaceIds.push(created.body.space.id);

    const { agent: memberAgent } = await loggedInAgent('delete-blocked-member');
    await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });

    const res = await ownerAgent.delete('/api/account');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only Organizer/i);

    const stillIn = await ownerAgent.get('/api/me');
    expect(stillIn.status).toBe(200);
    expect(stillIn.body.id).toBe(ownerId);
  });
});
