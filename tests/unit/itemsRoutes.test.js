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
