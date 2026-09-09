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

describe('Notes PIN lock — per-note is_locked, /api/notes-pin/*, /api/notes, and gating on /api/items', () => {
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
    const found = list.body.items.find((i) => i.id === note.body.item.id);
    expect(found.title).toBe('Unlocked note');

    const verify = await agent.post('/api/notes-pin/verify').send({ pin: '0000' });
    expect(verify.status).toBe(200);
    expect(verify.body.unlocked).toBe(true);
  });

  test('locking requires a PIN to exist, then a locked note redacts until verified and re-redacts after /api/notes-pin/lock', async () => {
    const agent = await loggedInAgent('lockflow');
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Diary entry', description: 'private stuff' });
    createdIds.push(note.body.item.id);

    // Can't lock without a PIN set at all.
    const noPin = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Diary entry', isLocked: true });
    expect(noPin.status).toBe(400);

    await agent.post('/api/account/notes-pin').send({ pin: '1234' });
    // Setting a PIN unlocks the session that set it — lock explicitly to
    // simulate the fresh-page-load state the bootstrap always starts from.
    await agent.post('/api/notes-pin/lock');

    // Locking itself needs no proof of the PIN — only reading/editing/
    // unlocking a locked note does.
    const lock = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Diary entry', isLocked: true });
    expect(lock.status).toBe(200);
    expect(lock.body.item.is_locked).toBeTruthy();

    const redacted = await agent.get('/api/notes');
    expect(redacted.status).toBe(200);
    const hiddenRow = redacted.body.items.find((i) => i.id === note.body.item.id);
    // Title stays visible even while redacted — only the body is hidden —
    // so the list can still show which note this is; `redacted` is the
    // explicit signal for "still locked," not a null-title check (a
    // genuinely empty, unlocked note also has a null description).
    expect(hiddenRow.title).toBe('Diary entry');
    expect(hiddenRow.description).toBeNull();
    expect(hiddenRow.redacted).toBe(true);
    expect(hiddenRow.is_locked).toBeTruthy();

    const wrongPin = await agent.post('/api/notes-pin/verify').send({ pin: '9999' });
    expect(wrongPin.status).toBe(401);

    const rightPin = await agent.post('/api/notes-pin/verify').send({ pin: '1234' });
    expect(rightPin.status).toBe(200);

    const revealed = await agent.get('/api/notes');
    const revealedRow = revealed.body.items.find((i) => i.id === note.body.item.id);
    expect(revealedRow.title).toBe('Diary entry');
    expect(revealedRow.description).toBe('private stuff');
    expect(revealedRow.redacted).toBeFalsy();

    const relock = await agent.post('/api/notes-pin/lock');
    expect(relock.status).toBe(200);

    const redactedAgain = await agent.get('/api/notes');
    const redactedAgainRow = redactedAgain.body.items.find((i) => i.id === note.body.item.id);
    expect(redactedAgainRow.title).toBe('Diary entry');
    expect(redactedAgainRow.description).toBeNull();
    expect(redactedAgainRow.redacted).toBe(true);
  });

  test('an unlocked note is never redacted, even with a PIN set and the session freshly re-locked', async () => {
    const agent = await loggedInAgent('unlockednote');
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Never locked' });
    createdIds.push(note.body.item.id);

    await agent.post('/api/account/notes-pin').send({ pin: '4242' });
    await agent.post('/api/notes-pin/lock');

    const list = await agent.get('/api/notes');
    const row = list.body.items.find((i) => i.id === note.body.item.id);
    expect(row.title).toBe('Never locked');
    expect(row.is_locked).toBeFalsy();
  });

  test('notes, locked or not, are never included in /api/items/todo — Notes has its own GET /api/notes', async () => {
    const agent = await loggedInAgent('todostrip');
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Should never appear here' });
    const task = await agent.post('/api/items').send({ kind: 'task', title: 'Task, unaffected' });
    createdIds.push(note.body.item.id, task.body.item.id);

    const todo = await agent.get('/api/items/todo');
    expect(todo.status).toBe(200);
    const ids = todo.body.items.map((i) => i.id);
    expect(ids).not.toContain(note.body.item.id);
    expect(ids).toContain(task.body.item.id);
  });

  test('creating a note is never blocked; editing/deleting/unlocking a locked note requires session proof, and succeeds once verified', async () => {
    const agent = await loggedInAgent('mutategate');
    await agent.post('/api/account/notes-pin').send({ pin: '7777' });
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Locked target' });
    createdIds.push(note.body.item.id);
    await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Locked target', isLocked: true });
    await agent.post('/api/notes-pin/lock');

    const createOk = await agent.post('/api/items').send({ kind: 'note', title: 'Unrelated new note' });
    expect(createOk.status).toBe(201);
    createdIds.push(createOk.body.item.id);

    const editBlocked = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Blocked edit' });
    expect(editBlocked.status).toBe(423);

    const unlockBlocked = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Locked target', isLocked: false });
    expect(unlockBlocked.status).toBe(423);

    const deleteBlocked = await agent.delete(`/api/items/${note.body.item.id}`);
    expect(deleteBlocked.status).toBe(423);

    await agent.post('/api/notes-pin/verify').send({ pin: '7777' });

    const editOk = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Unblocked edit' });
    expect(editOk.status).toBe(200);
    expect(editOk.body.item.title).toBe('Unblocked edit');

    const unlockOk = await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Unblocked edit', isLocked: false });
    expect(unlockOk.status).toBe(200);
    expect(unlockOk.body.item.is_locked).toBeFalsy();
  });

  test('removing the PIN entirely unlocks every note it was protecting', async () => {
    const agent = await loggedInAgent('pinremoval');
    await agent.post('/api/account/notes-pin').send({ pin: '3333' });
    const note = await agent.post('/api/items').send({ kind: 'note', title: 'Orphaned by PIN removal' });
    createdIds.push(note.body.item.id);
    await agent.patch(`/api/items/${note.body.item.id}`).send({ title: 'Orphaned by PIN removal', isLocked: true });

    const removed = await agent.delete('/api/account/notes-pin');
    expect(removed.status).toBe(200);

    const list = await agent.get('/api/notes');
    const row = list.body.items.find((i) => i.id === note.body.item.id);
    expect(row.is_locked).toBeFalsy();
    expect(row.title).toBe('Orphaned by PIN removal');
  });
});
