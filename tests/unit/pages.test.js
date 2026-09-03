const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');

afterAll(async () => {
  process.env.TEST_AUTH_BYPASS = ORIGINAL_TEST_AUTH_BYPASS;
  await sessionStore.close();
  await getPool().end();
});

describe('GET /app and /firstrun.html', () => {
  const app = createApp();
  const createdEmails = [];

  afterAll(async () => {
    if (createdEmails.length) {
      await getPool().query('DELETE FROM users WHERE email IN (?)', [createdEmails]);
    }
  });

  test('unauthenticated visitor hitting /app is redirected to sign-in with next=app', async () => {
    const res = await request(app).get('/app');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/signin.html?next=app');
  });

  test('unauthenticated visitor hitting /firstrun.html is redirected to sign-in with next=firstrun', async () => {
    const res = await request(app).get('/firstrun.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/signin.html?next=firstrun');
  });

  test('a brand-new (not-yet-onboarded) signed-in user hitting /app is bounced to first-run', async () => {
    const email = `pages-new-${Date.now()}@example.com`;
    createdEmails.push(email);
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);

    const res = await agent.get('/app');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/firstrun.html');
  });

  test('a not-yet-onboarded user can actually view /firstrun.html itself', async () => {
    const email = `pages-firstrun-${Date.now()}@example.com`;
    createdEmails.push(email);
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);

    const res = await agent.get('/firstrun.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  test('an already-onboarded user hitting /firstrun.html is bounced to /app instead', async () => {
    const email = `pages-onboarded-${Date.now()}@example.com`;
    createdEmails.push(email);
    const agent = request.agent(app);
    const bypassRes = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    await UserRepo.markOnboarded(bypassRes.body.userId);

    const res = await agent.get('/firstrun.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');
  });

  test('an already-onboarded user hitting /app gets the real page, not bounced anywhere', async () => {
    const email = `pages-onboarded2-${Date.now()}@example.com`;
    createdEmails.push(email);
    const agent = request.agent(app);
    const bypassRes = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    await UserRepo.markOnboarded(bypassRes.body.userId);

    const res = await agent.get('/app');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});

describe('GET /continue-solo', () => {
  const app = createApp();
  const createdEmails = [];

  afterAll(async () => {
    if (createdEmails.length) {
      await getPool().query('DELETE FROM users WHERE email IN (?)', [createdEmails]);
    }
  });

  test('unauthenticated visitor is redirected to sign-in with next=solo', async () => {
    const res = await request(app).get('/continue-solo');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/signin.html?next=solo');
  });

  test('signed-in user is marked onboarded and lands on /app', async () => {
    const email = `pages-solo-${Date.now()}@example.com`;
    createdEmails.push(email);
    const agent = request.agent(app);
    const bypassRes = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);

    const res = await agent.get('/continue-solo');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app');

    const user = await UserRepo.findById(bypassRes.body.userId);
    expect(user.onboarded_at).not.toBeNull();

    const again = await agent.get('/continue-solo');
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe('/app');
  });
});

describe('UserRepo.markOnboarded', () => {
  const createdIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM users WHERE id IN (?)', [createdIds]);
    }
  });

  test('sets onboarded_at once, and a second call is a no-op rather than resetting it', async () => {
    const user = await UserRepo.create({
      googleSub: 'onboard-test-' + Date.now(),
      email: `onboard-test-${Date.now()}@example.com`,
      firstName: 'Test',
      lastName: 'User',
    });
    createdIds.push(user.id);
    expect(user.onboarded_at).toBeNull();

    const onboarded = await UserRepo.markOnboarded(user.id);
    expect(onboarded.onboarded_at).not.toBeNull();

    const firstTimestamp = onboarded.onboarded_at;
    const onboardedAgain = await UserRepo.markOnboarded(user.id);
    expect(onboardedAgain.onboarded_at).toBe(firstTimestamp);
  });
});
