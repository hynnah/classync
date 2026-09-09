const crypto = require('crypto');

const PIN_RE = /^\d{4}$/;
const KEY_LENGTH = 64;

// Salted scrypt, not a fast hash — a 4-digit PIN only has 10,000 possible
// values, so the hash alone can't be the only defense (see the rate limiter
// on POST /api/notes-pin/verify for that). This just keeps a leaked
// users.notes_pin_hash column from being a instant lookup table.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(pin, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { PIN_RE, hashPin, verifyPin };
