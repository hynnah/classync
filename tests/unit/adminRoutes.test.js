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

describe('/api/admin', () => {
  const app = createApp();
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'adminroutes-%@example.com'");
  });

  async function loggedInAgent(label, { admin = false } = {}) {
    const email = `adminroutes-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    const res = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}${admin ? '&admin=true' : ''}`);
    return { agent, userId: res.body.userId, email };
  }

  test('every /api/admin route requires login', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  test('every /api/admin route requires is_admin, not just login', async () => {
    const { agent } = await loggedInAgent('plain');
    const res = await agent.get('/api/admin/stats');
    expect(res.status).toBe(403);
  });

  test('GET /api/admin/stats reports real counts', async () => {
    const { agent } = await loggedInAgent('stats', { admin: true });
    const res = await agent.get('/api/admin/stats');
    expect(res.status).toBe(200);
    expect(res.body.users.total).toBeGreaterThanOrEqual(1);
    expect(res.body.users.active).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.spaces.total).toBe('number');
    expect(typeof res.body.items.total).toBe('number');
  });

  test('GET /api/admin/users searches by email/name and reports admin/active flags', async () => {
    const { agent } = await loggedInAgent('search-admin', { admin: true });
    const { userId: targetId, email: targetEmail } = await loggedInAgent('search-target');

    const res = await agent.get(`/api/admin/users?search=${encodeURIComponent('search-target')}`);
    expect(res.status).toBe(200);
    const found = res.body.users.find((u) => u.id === targetId);
    expect(found).toBeTruthy();
    expect(found.email).toBe(targetEmail);
    expect(found.isActive).toBe(true);
    expect(found.isAdmin).toBe(false);
  });

  test('an admin cannot deactivate their own account', async () => {
    const { agent, userId } = await loggedInAgent('self-deactivate', { admin: true });
    const res = await agent.post(`/api/admin/users/${userId}/deactivate`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/i);
  });

  test('deactivating a user blocks their next authenticated request; reactivating restores it', async () => {
    const { agent: adminAgent } = await loggedInAgent('moderator', { admin: true });
    const { agent: targetAgent, userId: targetId } = await loggedInAgent('moderated');

    const stillIn = await targetAgent.get('/api/me');
    expect(stillIn.status).toBe(200);

    const deactivate = await adminAgent.post(`/api/admin/users/${targetId}/deactivate`);
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.user.isActive).toBe(false);

    const blocked = await targetAgent.get('/api/me');
    expect(blocked.status).toBe(401);

    const reactivate = await adminAgent.post(`/api/admin/users/${targetId}/activate`);
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.user.isActive).toBe(true);
  });

  test('POST /api/admin/users/:id/deactivate on an unknown id is a 404', async () => {
    const { agent } = await loggedInAgent('unknown-user-target', { admin: true });
    const res = await agent.post('/api/admin/users/999999999/deactivate');
    expect(res.status).toBe(404);
  });

  test('GET /api/admin/spaces reports a live member count, even for an admin-deactivated Space with members still in it', async () => {
    const { agent: adminAgent } = await loggedInAgent('space-admin', { admin: true });
    const { agent: ownerAgent } = await loggedInAgent('space-owner');
    const created = await ownerAgent.post('/api/spaces').send({ name: 'Admin routes test space' });
    createdSpaceIds.push(created.body.space.id);
    const { agent: memberAgent } = await loggedInAgent('space-member');
    await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });

    const deactivate = await adminAgent.post(`/api/admin/spaces/${created.body.space.id}/deactivate`);
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.space.isActive).toBe(false);
    expect(deactivate.body.space.memberCount).toBe(2);

    const list = await adminAgent.get(`/api/admin/spaces?search=${encodeURIComponent('Admin routes test space')}`);
    const found = list.body.spaces.find((s) => s.id === created.body.space.id);
    expect(found.memberCount).toBe(2);
    expect(found.isActive).toBe(false);

    // deactivating hides it from the member's own sidebar switcher (existing
    // listSpacesForUser filter — no new logic needed for this, just verified
    // here as part of the admin flow)
    const memberSpaces = await memberAgent.get('/api/spaces');
    expect(memberSpaces.body.spaces.some((s) => s.id === created.body.space.id)).toBe(false);

    const reactivate = await adminAgent.post(`/api/admin/spaces/${created.body.space.id}/activate`);
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.space.isActive).toBe(true);
  });

  test('GET /api/admin/activity lists logged actions, newest first, with the actor name resolved', async () => {
    const { agent: adminAgent } = await loggedInAgent('activity-admin', { admin: true });
    const { agent: targetAgent, userId: targetId } = await loggedInAgent('activity-target');
    await targetAgent.get('/api/me');

    await adminAgent.post(`/api/admin/users/${targetId}/deactivate`);
    await adminAgent.post(`/api/admin/users/${targetId}/activate`);

    const res = await adminAgent.get('/api/admin/activity?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.activity.length).toBeGreaterThanOrEqual(2);
    const [mostRecent, secondMostRecent] = res.body.activity;
    expect(mostRecent.actionType).toBe('user_activated');
    expect(secondMostRecent.actionType).toBe('user_deactivated');
    expect(mostRecent.actorName).toBeTruthy();
    expect(mostRecent.targetType).toBe('user');
  });
});
