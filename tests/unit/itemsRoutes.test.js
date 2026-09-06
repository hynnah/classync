const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;
process.env.TEST_AUTH_BYPASS = 'true';

// Inert for every describe block below except "Google Calendar sync wiring"
// — no other test here ever connects a user's calendar, so syncItemForUser
// exits before it would call into this module either way. Mocked file-wide
// so nothing in this file can ever make a real Google API call by accident.
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

describe('note vs. task validation on /api/items', () => {
  const app = createApp();
  const createdIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'itemsroutes-%@example.com'");
  });

  async function loggedInAgent() {
    const email = `itemsroutes-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return agent;
  }

  test('POST rejects a note with a category', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'note', title: 'n', category: 'Assignment' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/i);
  });

  test('POST rejects a note with a dueDate', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'note', title: 'n', dueDate: '2026-09-10' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/due date/i);
  });

  test('POST rejects a note with a dueTime', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'note', title: 'n', dueTime: '09:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/due time/i);
  });

  test('POST accepts a note with just a title and description', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'note', title: 'Real note', description: 'stuff' });
    expect(res.status).toBe(201);
    createdIds.push(res.body.item.id);
    expect(res.body.item.category).toBeNull();
    expect(res.body.item.due_date).toBeNull();
  });

  test('POST still accepts a task with category/dueDate/dueTime (no regression)', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'task', title: 'Real task', category: 'Quiz', dueDate: '2026-09-10', dueTime: '09:00' });
    expect(res.status).toBe(201);
    createdIds.push(res.body.item.id);
    expect(res.body.item.category).toBe('Quiz');
  });

  test('PATCH rejects setting a category on an existing note', async () => {
    const agent = await loggedInAgent();
    const created = await agent.post('/api/items').send({ kind: 'note', title: 'note to edit' });
    createdIds.push(created.body.item.id);

    const res = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'note to edit', category: 'Exam' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/i);
  });

  test('PATCH rejects setting a dueDate on an existing note', async () => {
    const agent = await loggedInAgent();
    const created = await agent.post('/api/items').send({ kind: 'note', title: 'note to edit 2' });
    createdIds.push(created.body.item.id);

    const res = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'note to edit 2', dueDate: '2026-09-11' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/due date/i);
  });

  test('PATCH on a note that does not touch category/dueDate/dueTime still succeeds', async () => {
    const agent = await loggedInAgent();
    const created = await agent.post('/api/items').send({ kind: 'note', title: 'note to edit 3', description: 'old' });
    createdIds.push(created.body.item.id);

    const res = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'note to edit 3', description: 'new' });
    expect(res.status).toBe(200);
    expect(res.body.item.description).toBe('new');
  });

  test('PATCH still accepts category/dueDate/dueTime changes on an existing task (no regression)', async () => {
    const agent = await loggedInAgent();
    const created = await agent.post('/api/items').send({ kind: 'task', title: 'task to edit' });
    createdIds.push(created.body.item.id);

    const res = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'task to edit', category: 'Exam', dueDate: '2026-09-12', dueTime: '11:00' });
    expect(res.status).toBe(200);
    expect(res.body.item.category).toBe('Exam');
    expect(res.body.item.due_date).toBe('2026-09-12');
  });

  test('POST rejects a note with a color', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'note', title: 'n', color: 'salmon' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color/i);
  });

  test('POST rejects an invalid color value on a task', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'task', title: 'bad color', color: 'not-a-real-color' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color/i);
  });

  test('POST accepts a valid color on a task', async () => {
    const agent = await loggedInAgent();
    const res = await agent.post('/api/items').send({ kind: 'task', title: 'colored task', color: 'mint' });
    expect(res.status).toBe(201);
    createdIds.push(res.body.item.id);
    expect(res.body.item.color).toBe('mint');
  });

  test('PATCH rejects setting a color on an existing note', async () => {
    const agent = await loggedInAgent();
    const created = await agent.post('/api/items').send({ kind: 'note', title: 'note to color' });
    createdIds.push(created.body.item.id);

    const res = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'note to color', color: 'peach' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color/i);
  });

  test('PATCH can change and clear a task\'s color', async () => {
    const agent = await loggedInAgent();
    const created = await agent.post('/api/items').send({ kind: 'task', title: 'task color edit', color: 'salmon' });
    createdIds.push(created.body.item.id);

    const changed = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'task color edit', color: 'lavender' });
    expect(changed.status).toBe(200);
    expect(changed.body.item.color).toBe('lavender');

    const cleared = await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'task color edit', color: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.item.color).toBeNull();
  });
});

describe('Space-scoped items on /api/items', () => {
  const app = createApp();
  const createdIds = [];
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'itemsspaces-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `itemsspaces-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    const res = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return { agent, userId: res.body.userId };
  }

  async function makeSpaceWithMember() {
    const { agent: orgAgent, userId: orgId } = await loggedInAgent('org');
    const created = await orgAgent.post('/api/spaces').send({ name: 'Items test space ' + Date.now() });
    createdSpaceIds.push(created.body.space.id);
    const { agent: memberAgent, userId: memberId } = await loggedInAgent('member');
    await memberAgent.post('/api/spaces/join').send({ joinCode: created.body.space.joinCode });
    return { orgAgent, orgId, memberAgent, memberId, spaceId: created.body.space.id };
  }

  test('a plain Member gets 403 creating a Space item', async () => {
    const { memberAgent, memberId, spaceId } = await makeSpaceWithMember();
    const res = await memberAgent.post('/api/items').send({
      spaceId, kind: 'task', title: 'nope', dueDate: '2026-09-20', assigneeUserIds: [memberId],
    });
    expect(res.status).toBe(403);
  });

  test('a non-member gets 404, not 403, creating an item in a Space they do not belong to', async () => {
    const { spaceId } = await makeSpaceWithMember();
    const { agent: outsiderAgent } = await loggedInAgent('outsider');
    const res = await outsiderAgent.post('/api/items').send({ spaceId, kind: 'task', title: 'nope', dueDate: '2026-09-20' });
    expect(res.status).toBe(404);
  });

  test('rejects kind=note for a Space item', async () => {
    const { orgAgent, orgId, spaceId } = await makeSpaceWithMember();
    const res = await orgAgent.post('/api/items').send({ spaceId, kind: 'note', title: 'nope', assigneeUserIds: [orgId] });
    expect(res.status).toBe(400);
  });

  // Regression: an Event with no due date is invisible everywhere in the
  // app forever — unlike a Task, it has no undated home (the Tasks tab
  // filters kind='task' only) and the calendar can't place a dateless pill.
  // Confirmed live: a real account created several via the modal (its due-
  // date field had no `required` attribute at the time) and could never see
  // or reach them again through the UI once saved.
  test('rejects an Event with no due date', async () => {
    const { orgAgent, orgId, spaceId } = await makeSpaceWithMember();
    const res = await orgAgent.post('/api/items').send({
      spaceId, kind: 'event', title: 'Dateless event', isOpenToAll: true, assigneeUserIds: [orgId],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/due date/i);
  });

  test('an undated Task is still allowed — only Events require a due date', async () => {
    const { orgAgent, orgId, spaceId } = await makeSpaceWithMember();
    const res = await orgAgent.post('/api/items').send({
      spaceId, kind: 'task', title: 'Undated task', isOpenToAll: true, assigneeUserIds: [orgId],
    });
    expect(res.status).toBe(201);
    expect(res.body.item.due_date).toBeNull();
  });

  test('an edit cannot clear an Event\'s due date to null either', async () => {
    const { orgAgent, orgId, spaceId } = await makeSpaceWithMember();
    const created = await orgAgent.post('/api/items').send({
      spaceId, kind: 'event', title: 'Dated event', dueDate: '2026-09-20', isOpenToAll: true, assigneeUserIds: [orgId],
    });
    expect(created.status).toBe(201);

    const res = await orgAgent.patch(`/api/items/${created.body.item.id}`).send({ title: 'Dated event', dueDate: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/due date/i);
  });

  test('rejects a color on a Space task', async () => {
    const { orgAgent, orgId, spaceId } = await makeSpaceWithMember();
    const res = await orgAgent.post('/api/items').send({
      spaceId, kind: 'task', title: 'nope', dueDate: '2026-09-20', color: 'mint', assigneeUserIds: [orgId],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color/i);
  });

  test('rejects an assignee who is not a member of the Space', async () => {
    const { orgAgent, spaceId } = await makeSpaceWithMember();
    const res = await orgAgent.post('/api/items').send({
      spaceId, kind: 'task', title: 'nope', dueDate: '2026-09-20', assigneeUserIds: [999999999],
    });
    expect(res.status).toBe(400);
  });

  test('rejects specific-assignee creation with no assignees and isOpenToAll not set', async () => {
    const { orgAgent, spaceId } = await makeSpaceWithMember();
    const res = await orgAgent.post('/api/items').send({ spaceId, kind: 'task', title: 'nope', dueDate: '2026-09-20' });
    expect(res.status).toBe(400);
  });

  test('an Organizer creates a task assigned to a specific Member, who can see it and mark it done — but not edit it', async () => {
    const { orgAgent, memberAgent, memberId, spaceId } = await makeSpaceWithMember();
    const created = await orgAgent.post('/api/items').send({
      spaceId, kind: 'task', title: 'Reading response', category: 'Assignment', dueDate: '2026-09-20', assigneeUserIds: [memberId],
    });
    expect(created.status).toBe(201);
    createdIds.push(created.body.item.id);
    const itemId = created.body.item.id;

    const list = await memberAgent.get(`/api/items?from=2026-01-01&to=2026-12-31&spaceId=${spaceId}`);
    expect(list.body.items.map((i) => i.id)).toContain(itemId);

    const statusRes = await memberAgent.patch(`/api/items/${itemId}/status`).send({ status: 'completed' });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.item.status).toBe('completed');

    const editRes = await memberAgent.patch(`/api/items/${itemId}`).send({ title: 'Hijacked' });
    expect(editRes.status).toBe(404);
  });

  test('an open-to-all event is visible to every current Member, and only the creator can edit it', async () => {
    const { orgAgent, memberAgent, spaceId } = await makeSpaceWithMember();
    const created = await orgAgent.post('/api/items').send({
      spaceId, kind: 'event', title: 'Class trip', dueDate: '2026-09-21', dueTime: '09:00', isOpenToAll: true,
    });
    expect(created.status).toBe(201);
    createdIds.push(created.body.item.id);
    const itemId = created.body.item.id;

    const list = await memberAgent.get(`/api/items?from=2026-01-01&to=2026-12-31&spaceId=${spaceId}`);
    expect(list.body.items.map((i) => i.id)).toContain(itemId);

    const memberStatusRes = await memberAgent.patch(`/api/items/${itemId}/status`).send({ status: 'completed' });
    expect(memberStatusRes.status).toBe(404);

    const orgEditRes = await orgAgent.patch(`/api/items/${itemId}`).send({ title: 'Class trip (rescheduled)' });
    expect(orgEditRes.status).toBe(200);
    expect(orgEditRes.body.item.title).toBe('Class trip (rescheduled)');

    const memberEditRes = await memberAgent.patch(`/api/items/${itemId}`).send({ title: 'Hijacked' });
    expect(memberEditRes.status).toBe(404);
  });

  test('a non-member gets 404 listing items for a Space they do not belong to', async () => {
    const { spaceId } = await makeSpaceWithMember();
    const { agent: outsiderAgent } = await loggedInAgent('listoutsider');
    const res = await outsiderAgent.get(`/api/items?from=2026-01-01&to=2026-12-31&spaceId=${spaceId}`);
    expect(res.status).toBe(404);
  });
});

describe('/api/items/todo — the To Do view', () => {
  const app = createApp();
  const createdIds = [];
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'itemstodo-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `itemstodo-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return agent;
  }

  test('requires login', async () => {
    const res = await request(app).get('/api/items/todo');
    expect(res.status).toBe(401);
  });

  test('only returns the caller\'s own personal items — an undated task and a note included, another user\'s items excluded', async () => {
    const mine = await loggedInAgent('mine');
    const theirs = await loggedInAgent('theirs');

    const undatedTask = await mine.post('/api/items').send({ kind: 'task', title: 'Undated task, mine' });
    const note = await mine.post('/api/items').send({ kind: 'note', title: 'A note, mine', description: 'body' });
    createdIds.push(undatedTask.body.item.id, note.body.item.id);

    const othersNote = await theirs.post('/api/items').send({ kind: 'note', title: 'Not mine at all' });
    createdIds.push(othersNote.body.item.id);

    const res = await mine.get('/api/items/todo');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i) => i.id);
    expect(ids).toContain(undatedTask.body.item.id);
    expect(ids).toContain(note.body.item.id);
    expect(ids).not.toContain(othersNote.body.item.id);
  });

  test('?spaceId scopes to that Space\'s own Tasks tab — undated tasks included, events excluded', async () => {
    const agent = await loggedInAgent('spacescope');
    const created = await agent.post('/api/spaces').send({ name: 'Tasks tab route test' });
    const spaceId = created.body.space.id;
    createdSpaceIds.push(spaceId);

    const undatedTask = await agent.post('/api/items').send({
      spaceId, kind: 'task', title: 'Space tab undated task', isOpenToAll: true,
    });
    const spaceEvent = await agent.post('/api/items').send({
      spaceId, kind: 'event', title: 'Space tab event', dueDate: '2026-09-20', isOpenToAll: true,
    });
    createdIds.push(undatedTask.body.item.id, spaceEvent.body.item.id);

    const res = await agent.get(`/api/items/todo?spaceId=${spaceId}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i) => i.id);
    expect(ids).toContain(undatedTask.body.item.id);
    expect(ids).not.toContain(spaceEvent.body.item.id);
  });

  test('?spaceId for a Space the caller doesn\'t belong to is a 404, not a data leak', async () => {
    const owner = await loggedInAgent('spacescope-owner');
    const outsider = await loggedInAgent('spacescope-outsider');
    const created = await owner.post('/api/spaces').send({ name: 'Tasks tab outsider test' });
    createdSpaceIds.push(created.body.space.id);

    const res = await outsider.get(`/api/items/todo?spaceId=${created.body.space.id}`);
    expect(res.status).toBe(404);
  });
});

describe('/api/items/all — the unified All-calendar (FR-M1)', () => {
  const app = createApp();
  const createdIds = [];
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'itemsall-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `itemsall-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return agent;
  }

  test('requires login and validates from/to', async () => {
    const anon = await request(app).get('/api/items/all?from=2026-01-01&to=2026-01-31');
    expect(anon.status).toBe(401);

    const agent = await loggedInAgent('validate');
    const badRange = await agent.get('/api/items/all?from=nope&to=2026-01-31');
    expect(badRange.status).toBe(400);
  });

  test('merges Personal items with every joined Space\'s open-to-all items', async () => {
    const agent = await loggedInAgent('merge');
    const personal = await agent.post('/api/items').send({ kind: 'task', title: 'All-route personal', dueDate: '2026-08-10' });
    createdIds.push(personal.body.item.id);

    const created = await agent.post('/api/spaces').send({ name: 'All-route space' });
    createdSpaceIds.push(created.body.space.id);
    const spaceItem = await agent.post('/api/items').send({
      spaceId: created.body.space.id, kind: 'event', title: 'All-route space event',
      dueDate: '2026-08-11', isOpenToAll: true,
    });

    const res = await agent.get('/api/items/all?from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i) => i.id);
    expect(ids).toContain(personal.body.item.id);
    expect(ids).toContain(spaceItem.body.item.id);
  });
});

describe('/api/items/all/todo — the merged All To Do list (FR-M1)', () => {
  const app = createApp();
  const createdIds = [];
  const createdSpaceIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'itemsalltodo-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `itemsalltodo-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return agent;
  }

  test('requires login', async () => {
    const anon = await request(app).get('/api/items/all/todo');
    expect(anon.status).toBe(401);
  });

  test('merges an undated Personal task with a Space task, excludes a Space event', async () => {
    const agent = await loggedInAgent('merge');
    const personal = await agent.post('/api/items').send({ kind: 'task', title: 'All-todo-route personal undated' });
    createdIds.push(personal.body.item.id);

    const created = await agent.post('/api/spaces').send({ name: 'All-todo-route space' });
    createdSpaceIds.push(created.body.space.id);
    const spaceTask = await agent.post('/api/items').send({
      spaceId: created.body.space.id, kind: 'task', title: 'All-todo-route space task', isOpenToAll: true,
    });
    const spaceEvent = await agent.post('/api/items').send({
      spaceId: created.body.space.id, kind: 'event', title: 'All-todo-route space event',
      dueDate: '2026-08-12', isOpenToAll: true,
    });

    const res = await agent.get('/api/items/all/todo');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i) => i.id);
    expect(ids).toContain(personal.body.item.id);
    expect(ids).toContain(spaceTask.body.item.id);
    expect(ids).not.toContain(spaceEvent.body.item.id);
  });
});

describe('Google Calendar sync wiring on /api/items', () => {
  const app = createApp();
  const createdIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'itemsroutes-calsync-%@example.com'");
  });

  beforeEach(() => {
    googleCalendar.clientForRefreshToken.mockReset();
  });

  async function connectedAgent(label) {
    const email = `itemsroutes-calsync-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    const res = await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    await CalendarTokenRepo.connect(res.body.userId, encrypt('fake-refresh-token'));
    return agent;
  }

  test('creating a dated task pushes it to the connected creator\'s Google Calendar', async () => {
    const agent = await connectedAgent('create');
    const insert = jest.fn().mockResolvedValue({ data: { id: 'evt-created' } });
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { insert, update: jest.fn(), delete: jest.fn() } });

    const res = await agent.post('/api/items').send({ kind: 'task', title: 'Synced task', dueDate: '2026-09-15' });
    createdIds.push(res.body.item.id);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].requestBody.summary).toBe('Synced task');
  });

  test('editing a synced item pushes an update, not a second insert', async () => {
    const agent = await connectedAgent('edit');
    const insert = jest.fn().mockResolvedValue({ data: { id: 'evt-edit' } });
    const update = jest.fn().mockResolvedValue({ data: {} });
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { insert, update, delete: jest.fn() } });

    const created = await agent.post('/api/items').send({ kind: 'task', title: 'Edit me', dueDate: '2026-09-15' });
    createdIds.push(created.body.item.id);
    await agent.patch(`/api/items/${created.body.item.id}`).send({ title: 'Edited title' });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('deleting a synced item removes the Google Calendar event', async () => {
    const agent = await connectedAgent('delete');
    const insert = jest.fn().mockResolvedValue({ data: { id: 'evt-delete' } });
    const del = jest.fn().mockResolvedValue({});
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { insert, update: jest.fn(), delete: del } });

    const created = await agent.post('/api/items').send({ kind: 'task', title: 'Delete me', dueDate: '2026-09-15' });
    const res = await agent.delete(`/api/items/${created.body.item.id}`);

    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-delete' }));
  });

  test('marking a task done does not touch Google Calendar — nothing calendar-relevant changed', async () => {
    const agent = await connectedAgent('status');
    const insert = jest.fn().mockResolvedValue({ data: { id: 'evt-status' } });
    const update = jest.fn().mockResolvedValue({ data: {} });
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { insert, update, delete: jest.fn() } });

    const created = await agent.post('/api/items').send({ kind: 'task', title: 'Status only', dueDate: '2026-09-15' });
    createdIds.push(created.body.item.id);
    insert.mockClear();
    await agent.patch(`/api/items/${created.body.item.id}/status`).send({ status: 'completed' });

    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('creating an undated task never touches Google Calendar', async () => {
    const agent = await connectedAgent('undated');
    const insert = jest.fn();
    googleCalendar.clientForRefreshToken.mockReturnValue({ events: { insert, update: jest.fn(), delete: jest.fn() } });

    const res = await agent.post('/api/items').send({ kind: 'task', title: 'No date' });
    createdIds.push(res.body.item.id);

    expect(insert).not.toHaveBeenCalled();
  });
});
