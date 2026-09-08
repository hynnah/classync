const request = require('supertest');
const { createApp } = require('../../server/src/app');
const { sessionStore } = require('../../server/src/auth/sessionStore');
const { getPool } = require('../../server/src/db/pool');

afterAll(async () => {
  await sessionStore.close();
  await getPool().end();
});

describe('security headers', () => {
  const app = createApp();

  test('every response sets CSP, X-Content-Type-Options, Referrer-Policy, and X-Frame-Options', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBeTruthy();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  test("CSP allows Google Fonts (style-src/font-src) without allowing arbitrary third-party script origins", async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    // script-src stays 'self' (plus 'unsafe-inline' for the app's own inline
    // <script type="module"> tags) — never opened up to a remote host.
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src '));
    expect(scriptSrc).not.toContain('http');
  });

  // HSTS on localhost sticks in the browser's HSTS cache long after this app
  // stops running there and breaks plain http:// dev on that host later —
  // this asserts it stays off outside production, not just that it exists.
  test('HSTS is not set outside production', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
