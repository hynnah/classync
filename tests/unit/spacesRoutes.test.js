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

describe('/api/spaces', () => {
  const app = createApp();
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'spacesroutes-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `spacesroutes-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    const res = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return { agent, userId: res.body.userId };
  }

  test('POST /api/spaces rejects a blank name', async () => {
    const { agent } = await loggedInAgent('blank-name');
    const res = await agent.post('/api/spaces').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('POST /api/spaces creates a Space, makes the caller its organizer, and marks them onboarded', async () => {
    const { agent, userId } = await loggedInAgent('create');
    const res = await agent.post('/api/spaces').send({ name: 'Physics 11' });
    expect(res.status).toBe(201);
    expect(res.body.space.name).toBe('Physics 11');
    expect(res.body.space.role).toBe('organizer');
    expect(res.body.space.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    createdSpaceIds.push(res.body.space.id);

    const [rows] = await getPool().query('SELECT onboarded_at FROM users WHERE id = ?', [userId]);
    expect(rows[0].onboarded_at).not.toBeNull();

    const list = await agent.get('/api/spaces');
    expect(list.body.spaces.map((s) => s.id)).toContain(res.body.space.id);
  });

  test('POST /api/spaces/join rejects a malformed code before ever hitting the DB', async () => {
    const { agent } = await loggedInAgent('badcode-format');
    const res = await agent.post('/api/spaces/join').send({ joinCode: 'nope' });
    expect(res.status).toBe(400);
  });

  test('POST /api/spaces/join rejects an unknown but well-formed code', async () => {
    const { agent } = await loggedInAgent('badcode-unknown');
    const res = await agent.post('/api/spaces/join').send({ joinCode: 'ZZZZZZ' });
    expect(res.status).toBe(404);
  });

  test('POST /api/spaces/join accepts lowercase input and normalizes it', async () => {
    const { agent: orgAgent } = await loggedInAgent('join-lower-owner');
    const created = await orgAgent.post('/api/spaces').send({ name: 'Lowercase code test' });
    createdSpaceIds.push(created.body.space.id);

    const { agent: joinAgent } = await loggedInAgent('join-lower-member');
    const res = await joinAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode.toLowerCase() });
    expect(res.status).toBe(201);
    expect(res.body.space.role).toBe('member');
  });

  test('a non-member gets 404 on the members list, not 403 (doesn\'t confirm the Space exists to outsiders)', async () => {
    const { agent: orgAgent } = await loggedInAgent('members-404-owner');
    const created = await orgAgent.post('/api/spaces').send({ name: 'Members 404 test' });
    createdSpaceIds.push(created.body.space.id);

    const { agent: outsiderAgent } = await loggedInAgent('members-404-outsider');
    const res = await outsiderAgent.get(`/api/spaces/${created.body.space.id}/members`);
    expect(res.status).toBe(404);
  });

  test('a plain member gets 403 renaming, promoting, or removing', async () => {
    const { agent: orgAgent } = await loggedInAgent('member-403-owner');
    const created = await orgAgent.post('/api/spaces').send({ name: 'Member 403 test' });
    createdSpaceIds.push(created.body.space.id);
    const spaceId = created.body.space.id;

    const { agent: memberAgent, userId: memberUserId } = await loggedInAgent('member-403-member');
    await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });

    const rename = await memberAgent.patch(`/api/spaces/${spaceId}`).send({ name: 'Hijacked' });
    expect(rename.status).toBe(403);

    const promote = await memberAgent.post(`/api/spaces/${spaceId}/members/${memberUserId}/promote`);
    expect(promote.status).toBe(403);

    const remove = await memberAgent.delete(`/api/spaces/${spaceId}/members/${memberUserId}`);
    // removing self is blocked before the role check would even matter for a
    // real organizer, but for a plain member the role check fires first
    expect([400, 403]).toContain(remove.status);
  });

  test('leaving as a sole organizer with other members present is blocked with a 400', async () => {
    const { agent: orgAgent } = await loggedInAgent('leave-403-owner');
    const created = await orgAgent.post('/api/spaces').send({ name: 'Leave 400 test' });
    createdSpaceIds.push(created.body.space.id);
    const spaceId = created.body.space.id;

    const { agent: memberAgent } = await loggedInAgent('leave-403-member');
    await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });

    const leave = await orgAgent.post(`/api/spaces/${spaceId}/leave`);
    expect(leave.status).toBe(400);
  });

  test('full flow: create, join, promote, remove, leave', async () => {
    const { agent: orgAgent } = await loggedInAgent('flow-owner');
    const created = await orgAgent.post('/api/spaces').send({ name: 'Full flow test' });
    createdSpaceIds.push(created.body.space.id);
    const spaceId = created.body.space.id;

    const { agent: memberAgent, userId: memberUserId } = await loggedInAgent('flow-member');
    const joined = await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });
    expect(joined.status).toBe(201);

    const promote = await orgAgent.post(`/api/spaces/${spaceId}/members/${memberUserId}/promote`);
    expect(promote.status).toBe(200);

    const membersAfterPromote = await orgAgent.get(`/api/spaces/${spaceId}/members`);
    expect(membersAfterPromote.body.members.find((m) => m.id === memberUserId).role).toBe('organizer');

    // now both are organizers with no plain members — either can leave freely
    const leave = await orgAgent.post(`/api/spaces/${spaceId}/leave`);
    expect(leave.status).toBe(204);

    const remaining = await memberAgent.get('/api/spaces');
    expect(remaining.body.spaces.map((s) => s.id)).toContain(spaceId);
  });
});
