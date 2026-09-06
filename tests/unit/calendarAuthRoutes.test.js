const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

jest.mock('../../server/src/auth/oauth', () => ({
  ...jest.requireActual('../../server/src/auth/oauth'),
  buildCalendarAuthUrl: jest.fn((state) => `https://accounts.google.com/mock-consent?state=${state}`),
  exchangeCalendarCode: jest.fn(),
}));
jest.mock('../../server/src/calendar/googleCalendar');

const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');
const { CalendarTokenRepo } = require('../../server/src/db/repositories/CalendarTokenRepo');
const { decrypt } = require('../../server/src/auth/tokenCrypto');
const { buildCalendarAuthUrl, exchangeCalendarCode } = require('../../server/src/auth/oauth');
const googleCalendar = require('../../server/src/calendar/googleCalendar');

afterAll(async () => {
  process.env.TEST_AUTH_BYPASS = ORIGINAL_TEST_AUTH_BYPASS;
  await sessionStore.close();
  await getPool().end();
});

describe('GET /calendar/connect/start and /calendar/connect/callback', () => {
  const app = createApp();

  beforeEach(() => {
    exchangeCalendarCode.mockReset();
    googleCalendar.clientForRefreshToken.mockReset();
  });

  afterAll(async () => {
    await getPool().query("DELETE FROM users WHERE email LIKE 'calendarauthroutes-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `calendarauthroutes-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    const res = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return { agent, userId: res.body.userId };
  }

  test('GET /calendar/connect/start requires login', async () => {
    const res = await request(app).get('/calendar/connect/start');
    expect(res.status).toBe(401);
  });

  test('GET /calendar/connect/start redirects to the mocked consent URL with a fresh state', async () => {
    const { agent } = await loggedInAgent('start');
    const res = await agent.get('/calendar/connect/start');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com/mock-consent');
    expect(buildCalendarAuthUrl).toHaveBeenCalledTimes(1);
  });

  test('callback rejects when Google reports the consent was denied', async () => {
    const { agent } = await loggedInAgent('denied');
    await agent.get('/calendar/connect/start');
    const res = await agent.get('/calendar/connect/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app?calendar=error');
  });

  test('callback rejects a state that does not match the one /start minted', async () => {
    const { agent } = await loggedInAgent('bad-state');
    await agent.get('/calendar/connect/start');
    const res = await agent.get('/calendar/connect/callback?code=abc&state=not-the-real-state');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app?calendar=error');
  });

  test('callback with no prior /start call (no session state at all) is rejected', async () => {
    const { agent } = await loggedInAgent('no-start');
    const res = await agent.get('/calendar/connect/callback?code=abc&state=whatever');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app?calendar=error');
  });

  test('a failed code exchange redirects to an error and leaves no token row behind', async () => {
    const { agent, userId } = await loggedInAgent('exchange-fail');
    const start = await agent.get('/calendar/connect/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    exchangeCalendarCode.mockRejectedValue(new Error('invalid_grant'));

    const res = await agent.get(`/calendar/connect/callback?code=bad-code&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app?calendar=error');

    const token = await CalendarTokenRepo.getForUser(userId);
    expect(token).toBeNull();
  });

  test('a successful exchange stores the encrypted refresh token and redirects to connected', async () => {
    const { agent, userId } = await loggedInAgent('success');
    const start = await agent.get('/calendar/connect/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    exchangeCalendarCode.mockResolvedValue('real-fake-refresh-token');
    googleCalendar.clientForRefreshToken.mockReturnValue({
      events: { insert: jest.fn().mockResolvedValue({ data: { id: 'evt-backfill' } }) },
    });

    const res = await agent.get(`/calendar/connect/callback?code=good-code&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app?calendar=connected');

    const token = await CalendarTokenRepo.getForUser(userId);
    expect(token).not.toBeNull();
    expect(token.is_connected).toBe(1);
    expect(decrypt(token.encrypted_refresh_token)).toBe('real-fake-refresh-token');
  });

  test('a state can only be consumed once — reusing it after a successful callback fails', async () => {
    const { agent } = await loggedInAgent('replay');
    const start = await agent.get('/calendar/connect/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    exchangeCalendarCode.mockResolvedValue('replay-refresh-token');
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { insert: jest.fn().mockResolvedValue({ data: { id: 'evt' } }) } });

    await agent.get(`/calendar/connect/callback?code=first&state=${state}`);
    const replay = await agent.get(`/calendar/connect/callback?code=second&state=${state}`);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe('/app?calendar=error');
  });
});
