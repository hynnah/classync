const { PIN_RE, hashPin, verifyPin } = require('../../server/src/auth/notesPin');

describe('notesPin', () => {
  test('PIN_RE accepts exactly 4 digits, rejects anything else', () => {
    expect(PIN_RE.test('1234')).toBe(true);
    expect(PIN_RE.test('0000')).toBe(true);
    expect(PIN_RE.test('123')).toBe(false);
    expect(PIN_RE.test('12345')).toBe(false);
    expect(PIN_RE.test('12a4')).toBe(false);
  });

  test('hashPin produces a salt:hash pair that verifyPin accepts for the right PIN and rejects for the wrong one', () => {
    const stored = hashPin('4242');
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPin('4242', stored)).toBe(true);
    expect(verifyPin('0000', stored)).toBe(false);
  });

  test('two hashes of the same PIN differ (random salt) but both still verify', () => {
    const a = hashPin('1111');
    const b = hashPin('1111');
    expect(a).not.toBe(b);
    expect(verifyPin('1111', a)).toBe(true);
    expect(verifyPin('1111', b)).toBe(true);
  });

  test('verifyPin is false for a missing/malformed stored value, not a throw', () => {
    expect(verifyPin('1234', null)).toBe(false);
    expect(verifyPin('1234', '')).toBe(false);
    expect(verifyPin('1234', 'not-a-valid-format')).toBe(false);
  });
});
