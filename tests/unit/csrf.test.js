const { ensureCsrfCookie, buildCsrfMiddleware, COOKIE_NAME, HEADER_NAME } = require('../../server/src/auth/csrf');

function mockRes() {
  const res = {};
  res.cookie = jest.fn(() => res);
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function reqWithCookie(method, cookieValue, headerValue) {
  const cookieHeader = cookieValue !== undefined ? `${COOKIE_NAME}=${cookieValue}` : undefined;
  return {
    method,
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(headerValue !== undefined ? { [HEADER_NAME]: headerValue } : {}),
    },
  };
}

describe('ensureCsrfCookie', () => {
  test('sets a fresh cookie when the request has none yet', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    ensureCsrfCookie(req, res, next);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe(COOKIE_NAME);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(options.httpOnly).toBe(false);
    expect(next).toHaveBeenCalled();
  });

  test('leaves an existing cookie alone', () => {
    const req = { headers: { cookie: `${COOKIE_NAME}=already-here` } };
    const res = mockRes();
    const next = jest.fn();
    ensureCsrfCookie(req, res, next);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('requireCsrfToken (skip forced off, as it is under TEST_AUTH_BYPASS everywhere else)', () => {
  const requireCsrfToken = buildCsrfMiddleware({ skip: () => false });

  test('GET (a safe method) is never blocked, even with no cookie or header at all', () => {
    const req = reqWithCookie('GET');
    const res = mockRes();
    const next = jest.fn();
    requireCsrfToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('POST with no cookie at all is rejected', () => {
    const req = reqWithCookie('POST', undefined, 'whatever');
    const res = mockRes();
    const next = jest.fn();
    requireCsrfToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('POST with a cookie but no header is rejected', () => {
    const req = reqWithCookie('POST', 'secret-token');
    const res = mockRes();
    const next = jest.fn();
    requireCsrfToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('POST with a mismatched cookie/header pair is rejected', () => {
    const req = reqWithCookie('POST', 'secret-token', 'a-different-value');
    const res = mockRes();
    const next = jest.fn();
    requireCsrfToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('POST with a matching cookie/header pair is allowed through', () => {
    const req = reqWithCookie('POST', 'secret-token', 'secret-token');
    const res = mockRes();
    const next = jest.fn();
    requireCsrfToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('DELETE and PATCH are gated the same way POST is', () => {
    for (const method of ['DELETE', 'PATCH']) {
      const req = reqWithCookie(method, 'secret-token');
      const res = mockRes();
      const next = jest.fn();
      requireCsrfToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
});

describe('requireCsrfToken default export (skip active, matching real app behavior under TEST_AUTH_BYPASS)', () => {
  const ORIGINAL_TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS;

  afterEach(() => {
    process.env.TEST_AUTH_BYPASS = ORIGINAL_TEST_AUTH_BYPASS;
  });

  test('a POST with no cookie/header at all still passes when TEST_AUTH_BYPASS is on', () => {
    jest.resetModules();
    process.env.TEST_AUTH_BYPASS = 'true';
    const { requireCsrfToken: skippedMiddleware } = require('../../server/src/auth/csrf');
    const req = { method: 'POST', headers: {} };
    const res = mockRes();
    const next = jest.fn();
    skippedMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
