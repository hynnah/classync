const { encrypt, decrypt } = require('../../server/src/auth/tokenCrypto');

describe('tokenCrypto', () => {
  test('round-trips a refresh token through encrypt/decrypt', () => {
    const plaintext = '1//0g-fake-refresh-token-value';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  test('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
    const plaintext = 'same-value';
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  test('tampered ciphertext fails to decrypt instead of silently returning garbage', () => {
    const encoded = encrypt('some-refresh-token');
    const raw = Buffer.from(encoded, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a byte in the ciphertext
    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });
});
