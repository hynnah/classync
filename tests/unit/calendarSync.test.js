jest.mock('../../server/src/calendar/googleCalendar');

const { getPool } = require('../../server/src/db/pool');
const { ItemRepo } = require('../../server/src/db/repositories/ItemRepo');
const { CalendarTokenRepo } = require('../../server/src/db/repositories/CalendarTokenRepo');
const { ItemCalendarEventRepo } = require('../../server/src/db/repositories/ItemCalendarEventRepo');
const { encrypt, decrypt } = require('../../server/src/auth/tokenCrypto');
const googleCalendar = require('../../server/src/calendar/googleCalendar');
const {
  buildEventResource,
  syncItemForUser,
  syncItemForUsers,
  deleteCalendarEventsForItem,
  backfillForUser,
  disconnectAndCleanup,
} = require('../../server/src/calendar/sync');

function fakeCalendarClient() {
  return {
    events: {
      insert: jest.fn().mockResolvedValue({ data: { id: 'evt-' + Math.random().toString(36).slice(2) } }),
      update: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
}

let createdUserIds = [];
let createdItemIds = [];

async function makeUser(label) {
  const email = `calsync-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const [result] = await getPool().query(
    `INSERT INTO users (google_sub, email, first_name, last_name, age_confirmed_at, onboarded_at)
     VALUES (?, ?, 'Cal', 'Sync', NOW(), NOW())`,
    [`calsync-sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`, email]
  );
  createdUserIds.push(result.insertId);
  return result.insertId;
}

async function makeItem({ userId, title = 'Test item', dueDate = null, dueTime = null, description = null }) {
  const item = await ItemRepo.create({
    createdBy: userId,
    spaceId: null,
    kind: 'task',
    title,
    description,
    category: null,
    dueDate,
    dueTime,
    color: null,
    isOpenToAll: false,
    assigneeUserIds: undefined,
  });
  createdItemIds.push(item.id);
  return item;
}

async function connectCalendar(userId, refreshTokenValue = 'fake-refresh-token') {
  await CalendarTokenRepo.connect(userId, encrypt(refreshTokenValue));
}

afterAll(async () => {
  if (createdItemIds.length) {
    await getPool().query('DELETE FROM items WHERE id IN (?)', [createdItemIds]);
  }
  if (createdUserIds.length) {
    await getPool().query('DELETE FROM users WHERE id IN (?)', [createdUserIds]);
  }
  await getPool().end();
});

beforeEach(() => {
  googleCalendar.clientForRefreshToken.mockReset();
  googleCalendar.revokeToken.mockReset().mockResolvedValue();
});

describe('buildEventResource', () => {
  test('returns null for an item with no due date', () => {
    expect(buildEventResource({ title: 'x', due_date: null, due_time: null })).toBeNull();
  });

  test('builds an all-day event when there is a date but no time', () => {
    const resource = buildEventResource({ title: 'Essay due', description: null, due_date: '2026-09-10', due_time: null });
    expect(resource.start).toEqual({ date: '2026-09-10' });
    expect(resource.end).toEqual({ date: '2026-09-11' });
  });

  test('builds a timed event with a 1-hour span when there is a due time', () => {
    const resource = buildEventResource({ title: 'Standup', description: null, due_date: '2026-09-10', due_time: '14:30:00' });
    expect(resource.start).toEqual({ dateTime: '2026-09-10T14:30:00', timeZone: 'Asia/Manila' });
    expect(resource.end).toEqual({ dateTime: '2026-09-10T15:30:00', timeZone: 'Asia/Manila' });
  });

  test('a timed event rolls over into the next day correctly', () => {
    const resource = buildEventResource({ title: 'Late task', description: null, due_date: '2026-09-10', due_time: '23:45:00' });
    expect(resource.end).toEqual({ dateTime: '2026-09-11T00:45:00', timeZone: 'Asia/Manila' });
  });
});

describe('syncItemForUser', () => {
  test('does nothing when the user has not connected Calendar', async () => {
    const userId = await makeUser('unconnected');
    const item = await makeItem({ userId, dueDate: '2026-09-10' });

    await syncItemForUser(item, userId);

    expect(googleCalendar.clientForRefreshToken).not.toHaveBeenCalled();
  });

  test('creates a new Google event and records the mapping on first sync', async () => {
    const userId = await makeUser('create');
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);
    const item = await makeItem({ userId, title: 'New task', dueDate: '2026-09-10' });

    await syncItemForUser(item, userId);

    expect(client.events.insert).toHaveBeenCalledTimes(1);
    const mapping = await ItemCalendarEventRepo.getForItemUser(item.id, userId);
    expect(mapping).not.toBeNull();
  });

  test('updates the existing Google event on a second sync instead of creating another', async () => {
    const userId = await makeUser('update');
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);
    const item = await makeItem({ userId, title: 'Edit me', dueDate: '2026-09-10' });

    await syncItemForUser(item, userId);
    await syncItemForUser({ ...item, title: 'Edited title' }, userId);

    expect(client.events.insert).toHaveBeenCalledTimes(1);
    expect(client.events.update).toHaveBeenCalledTimes(1);
  });

  test('recreates the event if the stored one was already deleted on the Google side (404)', async () => {
    const userId = await makeUser('gone');
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    client.events.update.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { code: 404 }));
    googleCalendar.clientForRefreshToken.mockReturnValue(client);
    const item = await makeItem({ userId, title: 'Resync me', dueDate: '2026-09-10' });

    await syncItemForUser(item, userId);
    await syncItemForUser(item, userId);

    expect(client.events.update).toHaveBeenCalledTimes(1);
    expect(client.events.insert).toHaveBeenCalledTimes(2);
  });

  test('deletes the synced event when the due date is cleared away', async () => {
    const userId = await makeUser('clear-date');
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);
    const item = await makeItem({ userId, title: 'Undate me', dueDate: '2026-09-10' });

    await syncItemForUser(item, userId);
    await syncItemForUser({ ...item, due_date: null }, userId);

    expect(client.events.delete).toHaveBeenCalledTimes(1);
    const mapping = await ItemCalendarEventRepo.getForItemUser(item.id, userId);
    expect(mapping).toBeNull();
  });
});

describe('syncItemForUsers', () => {
  test('a failure for one user does not stop the others from syncing', async () => {
    const failingUser = await makeUser('multi-fail');
    const okUser = await makeUser('multi-ok');
    await connectCalendar(failingUser, 'token-fail');
    await connectCalendar(okUser, 'token-ok');

    const failingClient = fakeCalendarClient();
    failingClient.events.insert.mockRejectedValue(new Error('quota exceeded'));
    const okClient = fakeCalendarClient();
    // Routed by decrypting the token rather than by call order — the two
    // syncs run concurrently (Promise.allSettled), so which DB lookup
    // resolves first, and therefore which one calls clientForRefreshToken
    // first, isn't guaranteed.
    googleCalendar.clientForRefreshToken.mockImplementation((encryptedToken) => (
      decrypt(encryptedToken) === 'token-fail' ? failingClient : okClient
    ));

    const item = await makeItem({ userId: failingUser, title: 'Shared-shape item', dueDate: '2026-09-10' });

    await syncItemForUsers(item, [failingUser, okUser]);

    const okMapping = await ItemCalendarEventRepo.getForItemUser(item.id, okUser);
    expect(okMapping).not.toBeNull();
  });
});

describe('deleteCalendarEventsForItem', () => {
  test('deletes the Google event for each connected mapping', async () => {
    const userId = await makeUser('delete-item');
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);

    await deleteCalendarEventsForItem([{ user_id: userId, google_event_id: 'evt-123' }]);

    expect(client.events.delete).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-123' }));
  });

  test('skips a mapping for a user who is no longer connected', async () => {
    const userId = await makeUser('delete-item-disconnected');
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);

    await deleteCalendarEventsForItem([{ user_id: userId, google_event_id: 'evt-orphan' }]);

    expect(client.events.delete).not.toHaveBeenCalled();
  });
});

describe('backfillForUser', () => {
  test('syncs every pre-existing dated item once connected', async () => {
    const userId = await makeUser('backfill');
    await makeItem({ userId, title: 'Old dated task', dueDate: '2026-09-05' });
    await makeItem({ userId, title: 'Old undated task', dueDate: null });
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);

    await backfillForUser(userId);

    expect(client.events.insert).toHaveBeenCalledTimes(1);
  });
});

describe('disconnectAndCleanup', () => {
  test('deletes synced events, revokes the token, and erases the token row', async () => {
    const userId = await makeUser('disconnect');
    await connectCalendar(userId);
    const client = fakeCalendarClient();
    googleCalendar.clientForRefreshToken.mockReturnValue(client);
    const item = await makeItem({ userId, title: 'Will be disconnected', dueDate: '2026-09-10' });
    await syncItemForUser(item, userId);

    await disconnectAndCleanup(userId);

    expect(client.events.delete).toHaveBeenCalledTimes(1);
    expect(googleCalendar.revokeToken).toHaveBeenCalledTimes(1);
    const token = await CalendarTokenRepo.getForUser(userId);
    expect(token).toBeNull();
    const mapping = await ItemCalendarEventRepo.getForItemUser(item.id, userId);
    expect(mapping).toBeNull();
  });

  test('is a no-op beyond the token delete when the user was never connected', async () => {
    const userId = await makeUser('disconnect-noop');
    await expect(disconnectAndCleanup(userId)).resolves.toBeUndefined();
    expect(googleCalendar.clientForRefreshToken).not.toHaveBeenCalled();
  });
});
