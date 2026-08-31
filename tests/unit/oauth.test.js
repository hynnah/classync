const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');

afterAll(async () => {
  await sessionStore.close();
  await getPool().end();
});

describe('GET /auth/google', () => {
  const app = createApp();

  test('rejects when ageConfirmed=true was not supplied', async () => {
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(400);
  });

  test('rejects ageConfirmed=false the same as missing', async () => {
    const res = await request(app).get('/auth/google?ageConfirmed=false');
    expect(res.status).toBe(400);
  });

  test('redirects to Google with ageConfirmed=true', async () => {
    const res = await request(app).get('/auth/google?ageConfirmed=true');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');
  });
});

describe('GET /auth/google/callback', () => {
  const app = createApp();

  test('rejects a request with no matching oauthState in session', async () => {
    const res = await request(app).get('/auth/google/callback?code=abc&state=whatever');
    expect(res.status).toBe(400);
  });

  test('rejects when Google reports an error', async () => {
    const res = await request(app).get('/auth/google/callback?error=access_denied');
    expect(res.status).toBe(400);
  });

  test('a state minted by /auth/google is required for the callback to proceed past validation', async () => {
    const agent = request.agent(app);
    const start = await agent.get('/auth/google?ageConfirmed=true');
    const state = new URL(start.headers.location).searchParams.get('state');

    const mismatched = await agent.get(`/auth/google/callback?code=abc&state=${state}not-it`);
    expect(mismatched.status).toBe(400);
  });
});

describe('UserRepo.upsertFromGoogle', () => {
  const createdIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM users WHERE id IN (?)', [createdIds]);
    }
  });

  test('creates a new user, setting age_confirmed_at only when ageConfirmed is true', async () => {
    const googleSub = 'oauth-test-' + Date.now();
    const user = await UserRepo.upsertFromGoogle({
      googleSub,
      email: `oauth-test-${Date.now()}@example.com`,
      firstName: 'Ada',
      lastName: 'Lovelace',
      ageConfirmed: true,
    });
    createdIds.push(user.id);

    expect(user.google_sub).toBe(googleSub);
    expect(user.age_confirmed_at).not.toBeNull();
  });

  test('creates a new user without age_confirmed_at when ageConfirmed is falsy', async () => {
    const googleSub = 'oauth-test-noage-' + Date.now();
    const user = await UserRepo.upsertFromGoogle({
      googleSub,
      email: `oauth-test-noage-${Date.now()}@example.com`,
      firstName: 'Grace',
      lastName: 'Hopper',
      ageConfirmed: false,
    });
    createdIds.push(user.id);

    expect(user.age_confirmed_at).toBeNull();
  });

  test('refreshes email/name on an existing google_sub instead of creating a duplicate', async () => {
    const googleSub = 'oauth-test-refresh-' + Date.now();
    const first = await UserRepo.upsertFromGoogle({
      googleSub,
      email: `before-${Date.now()}@example.com`,
      firstName: 'Old',
      lastName: 'Name',
      ageConfirmed: true,
    });
    createdIds.push(first.id);

    const second = await UserRepo.upsertFromGoogle({
      googleSub,
      email: `after-${Date.now()}@example.com`,
      firstName: 'New',
      lastName: 'Name',
      ageConfirmed: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.first_name).toBe('New');
  });
});
