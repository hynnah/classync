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

describe('Notes PIN lock — /api/notes-pin/*, /api/notes, and gating on /api/items', () => {
  const app = createApp();
  const createdIds = [];

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    await getPool().query("DELETE FROM users WHERE email LIKE 'notespin-%@example.com'");
  });

  async function loggedInAgent(label) {
    const email = `notespin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const agent = request.agent(app);
    await agent.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
    return agent;
  }

  test('with no PIN set, /api/notes serves notes normally and verify is a trivial no-op', async () => {
    const agent = await loggedInAgent('nopin');
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Unlocked note', description: 'visible' });
    createdIds.push(note.body.item.id);

    const list = await agent.get('/api/notes');
    expect(list.status).toBe(200);
    expect(list.body.hasNotesPin).toBe(false);
    expect(list.body.items.map((i) => i.id)).toContain(note.body.item.id);

    const verify = await agent.post('/api/notes-pin/verify').send({ pin: '0000' });
    expect(verify.status).toBe(200);
    expect(verify.body.unlocked).toBe(true);
  });

  test('once a PIN is set, /api/notes 423s until verified, and locks again after /api/notes-pin/lock', async () => {
    const agent = await loggedInAgent('lockflow');
    await agent.post('/api/account/notes-pin').send({ pin: '1234' });
    // Setting a PIN unlocks the session that set it — lock explicitly to
    // simulate the fresh-page-load state the bootstrap always starts from.
    await agent.post('/api/notes-pin/lock');

    const locked = await agent.get('/api/notes');
    expect(locked.status).toBe(423);
    expect(locked.body.hasNotesPin).toBe(true);

    const wrongPin = await agent.post('/api/notes-pin/verify').send({ pin: '9999' });
    expect(wrongPin.status).toBe(401);

    const rightPin = await agent.post('/api/notes-pin/verify').send({ pin: '1234' });
    expect(rightPin.status).toBe(200);
    expect(rightPin.body.unlocked).toBe(true);

    const unlocked = await agent.get('/api/notes');
    expect(unlocked.status).toBe(200);

    const relock = await agent.post('/api/notes-pin/lock');
    expect(relock.status).toBe(200);
    expect(relock.body.unlocked).toBe(false);

    const lockedAgain = await agent.get('/api/notes');
    expect(lockedAgain.status).toBe(423);
  });

  test('locked notes are stripped from /api/items/todo, and a plain task in the same response is unaffected', async () => {
    const agent = await loggedInAgent('todostrip');
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Should be hidden while locked' });
    const task = await agent.post('/api/items').send({ kind: 'task', title: 'Task, unaffected by the notes lock' });
    createdIds.push(note.body.item.id, task.body.item.id);

    await agent.post('/api/account/notes-pin').send({ pin: '5555' });
    await agent.post('/api/notes-pin/lock');

    const todo = await agent.get('/api/items/todo');
    expect(todo.status).toBe(200);
    const ids = todo.body.items.map((i) => i.id);
    expect(ids).not.toContain(note.body.item.id);
    expect(ids).toContain(task.body.item.id);
  });

  test('creating, editing, and deleting a note are all 423 while locked, and succeed once unlocked', async () => {
    const agent = await loggedInAgent('mutategate');
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Pre-lock note' });
    createdIds.push(note.body.item.id);

    await agent.post('/api/account/notes-pin').send({ pin: '7777' });
    await agent.post('/api/notes-pin/lock');

    const createBlocked = await agent.post('/api/items').send({ kind: 'note', title: 'Blocked create' });
    expect(createBlocked.status).toBe(423);

    const editBlocked = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Blocked edit' });
    expect(editBlocked.status).toBe(423);

    const deleteBlocked = await agent.delete(`/api/items/${note.body.item.id}`);
    expect(deleteBlocked.status).toBe(423);

    await agent.post('/api/notes-pin/verify').send({ pin: '7777' });

    const editOk = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Unblocked edit' });
    expect(editOk.status).toBe(200);
    expect(editOk.body.item.title).toBe('Unblocked edit');

    const createOk = await agent.post('/api/items').send({ kind: 'note', title: 'Unblocked create' });
    expect(createOk.status).toBe(201);
    createdIds.push(createOk.body.item.id);
  });
});
