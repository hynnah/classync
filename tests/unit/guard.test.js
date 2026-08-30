const { requireLogin, requireRole } = require('../../server/src/auth/guard');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');
const { getPool } = require('../../server/src/db/pool');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireLogin', () => {
  let testUser;

  beforeAll(async () => {
    testUser = await UserRepo.create({
      googleSub: 'test-guard-' + Date.now(),
      email: `guard-test-${Date.now()}@example.com`,
      firstName: 'Test',
      lastName: 'User',
    });
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM users WHERE id = ?', [testUser.id]);
    await getPool().end();
  });

  test('blocks a request with no session', async () => {
    const req = { session: {} };
    const res = mockRes();
    const next = jest.fn();
    await requireLogin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows a request with a valid session, attaches req.user', async () => {
    const req = { session: { userId: testUser.id } };
    const res = mockRes();
    const next = jest.fn();
    await requireLogin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe(testUser.id);
  });

  test('blocks a deactivated user even with a valid session', async () => {
    await getPool().query('UPDATE users SET is_active = FALSE WHERE id = ?', [testUser.id]);
    const req = { session: { userId: testUser.id, destroy: (cb) => cb() } };
    const res = mockRes();
    const next = jest.fn();
    await requireLogin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  test('throws for anything other than admin — per-Space roles are not a blanket middleware', () => {
    expect(() => requireRole('organizer')).toThrow();
  });

  test("returns [requireLogin, adminCheck] for 'admin'", () => {
    const middlewares = requireRole('admin');
    expect(Array.isArray(middlewares)).toBe(true);
    expect(middlewares).toHaveLength(2);
  });
});
