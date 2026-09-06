const sseHub = require('../../server/src/realtime/sseHub');

function mockRes() {
  return { write: jest.fn() };
}

describe('sseHub', () => {
  test('notifyUser writes a formatted SSE event to every connection subscribed for that user', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    sseHub.subscribe(90001, res1);
    sseHub.subscribe(90001, res2);

    sseHub.notifyUser(90001, 'role_changed', { spaceId: 5, role: 'organizer' });

    const expected = 'event: role_changed\ndata: {"spaceId":5,"role":"organizer"}\n\n';
    expect(res1.write).toHaveBeenCalledWith(expected);
    expect(res2.write).toHaveBeenCalledWith(expected);

    sseHub.unsubscribe(90001, res1);
    sseHub.unsubscribe(90001, res2);
  });

  test('notifyUser is a silent no-op for a user with no open connection', () => {
    expect(() => sseHub.notifyUser(90002, 'role_changed', {})).not.toThrow();
  });

  test('unsubscribe stops further events from reaching that connection', () => {
    const res = mockRes();
    sseHub.subscribe(90003, res);
    sseHub.unsubscribe(90003, res);

    sseHub.notifyUser(90003, 'item_updated', { itemId: 1 });
    expect(res.write).not.toHaveBeenCalled();
  });

  test('a second connection for the same user survives the first one unsubscribing (multi-tab)', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    sseHub.subscribe(90004, res1);
    sseHub.subscribe(90004, res2);
    sseHub.unsubscribe(90004, res1);

    sseHub.notifyUser(90004, 'item_updated', { itemId: 2 });
    expect(res1.write).not.toHaveBeenCalled();
    expect(res2.write).toHaveBeenCalled();

    sseHub.unsubscribe(90004, res2);
  });

  test('notifyUsers fans out to every listed user, skipping any with no connection', () => {
    const res = mockRes();
    sseHub.subscribe(90005, res);

    sseHub.notifyUsers([90005, 90006, 90007], 'item_updated', { itemId: 3 });
    expect(res.write).toHaveBeenCalledTimes(1);

    sseHub.unsubscribe(90005, res);
  });

  test('connectionCount reflects open connections and drops to 0 once all unsubscribe', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    expect(sseHub.connectionCount(90008)).toBe(0);
    sseHub.subscribe(90008, res1);
    sseHub.subscribe(90008, res2);
    expect(sseHub.connectionCount(90008)).toBe(2);
    sseHub.unsubscribe(90008, res1);
    expect(sseHub.connectionCount(90008)).toBe(1);
    sseHub.unsubscribe(90008, res2);
    expect(sseHub.connectionCount(90008)).toBe(0);
  });
});
