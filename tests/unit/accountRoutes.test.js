const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

jest.mock('../../server/src/calendar/googleCalendar');

const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');
const { CalendarTokenRepo } = require('../../server/src/db/repositories/CalendarTokenRepo');
const { encrypt } = require('../../server/src/auth/tokenCrypto');
const googleCalendar = require('../../server/src/calendar/googleCalendar');

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

  test('GET /api/account reports calendarConnected: false and default preferences with no prior opt-in', async () => {
    const { agent } = await loggedInAgent('me-default');
    const res = await agent.get('/api/account');
    expect(res.status).toBe(200);
    expect(res.body.calendarConnected).toBe(false);
    expect(res.body.weekStartsOn).toBe('sunday');
    expect(res.body.openingView).toBe('personal');
    expect(res.body.spacesCount).toBe(0);
    expect(res.body.organizerCount).toBe(0);
    expect(res.body.createdAt).toBeTruthy();
  });

  test('GET /api/account counts Spaces and Organizer roles correctly', async () => {
    const { agent } = await loggedInAgent('stats-owner');
    const spaceA = await agent.post('/api/spaces').send({ name: 'Stats test space' });
    createdSpaceIds.push(spaceA.body.space.id);
    const { agent: memberAgent } = await loggedInAgent('stats-member');
    const created = await agent.post('/api/spaces').send({ name: 'Stats test space 2' });
    createdSpaceIds.push(created.body.space.id);
    await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });

    const ownerAccount = await agent.get('/api/account');
    expect(ownerAccount.body.spacesCount).toBe(2);
    expect(ownerAccount.body.organizerCount).toBe(2);

    const memberAccount = await memberAgent.get('/api/account');
    expect(memberAccount.body.spacesCount).toBe(1);
    expect(memberAccount.body.organizerCount).toBe(0);
  });

  test('PATCH /api/account/preferences validates and persists both fields', async () => {
    const { agent } = await loggedInAgent('prefs');

    const badWeek = await agent.patch('/api/account/preferences').send({ weekStartsOn: 'nope', openingView: 'all' });
    expect(badWeek.status).toBe(400);
    const badView = await agent.patch('/api/account/preferences').send({ weekStartsOn: 'monday', openingView: 'nope' });
    expect(badView.status).toBe(400);

    const ok = await agent.patch('/api/account/preferences').send({ weekStartsOn: 'monday', openingView: 'all' });
    expect(ok.status).toBe(200);

    const me = await agent.get('/api/account');
    expect(me.body.weekStartsOn).toBe('monday');
    expect(me.body.openingView).toBe('all');
  });

  test('POST /api/calendar/disconnect erases the token row (connecting itself is a real OAuth redirect, tested in calendarAuthRoutes.test.js)', async () => {
    const { agent, userId } = await loggedInAgent('calendar-toggle');
    await CalendarTokenRepo.connect(userId, encrypt('fake-refresh-token'));
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { delete: jest.fn().mockResolvedValue({}) } });
    googleCalendar.revokeToken.mockResolvedValue();

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

  describe('POST/DELETE /api/account/notes-pin', () => {
    test('requires login', async () => {
      const res = await request(app).post('/api/account/notes-pin').send({ pin: '1234' });
      expect(res.status).toBe(401);
    });

    test('rejects a non-4-digit PIN', async () => {
      const { agent } = await loggedInAgent('pin-invalid');
      const tooShort = await agent.post('/api/account/notes-pin').send({ pin: '12' });
      expect(tooShort.status).toBe(400);
      const notDigits = await agent.post('/api/account/notes-pin').send({ pin: 'abcd' });
      expect(notDigits.status).toBe(400);
    });

    test('sets the PIN, reports hasNotesPin on /api/account, and clearing it removes that', async () => {
      const { agent } = await loggedInAgent('pin-set');
      let me = await agent.get('/api/account');
      expect(me.body.hasNotesPin).toBe(false);

      const set = await agent.post('/api/account/notes-pin').send({ pin: '4242' });
      expect(set.status).toBe(200);
      expect(set.body.hasNotesPin).toBe(true);

      me = await agent.get('/api/account');
      expect(me.body.hasNotesPin).toBe(true);

      const cleared = await agent.delete('/api/account/notes-pin');
      expect(cleared.status).toBe(200);
      expect(cleared.body.hasNotesPin).toBe(false);

      me = await agent.get('/api/account');
      expect(me.body.hasNotesPin).toBe(false);
    });

    test('changing an existing PIN needs no proof of the old one — being signed in is the recovery path', async () => {
      const { agent } = await loggedInAgent('pin-change');
      await agent.post('/api/account/notes-pin').send({ pin: '1111' });
      const changed = await agent.post('/api/account/notes-pin').send({ pin: '9999' });
      expect(changed.status).toBe(200);
      expect(changed.body.hasNotesPin).toBe(true);
    });
  });
});
