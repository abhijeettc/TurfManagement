import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// scrypt from node:crypto — memory-hard, in the standard library, and no
// dependency to keep patched. Parameters are the Node defaults except N, which
// is raised to 2^15: roughly 100ms per hash on a laptop, which is the right
// order of magnitude for a login form and painful at scale for an attacker.
const N = 32768;
// scrypt needs ~128 * N * r bytes (r defaults to 8), which at N=32768 is just
// over Node's default 32 MB maxmem and throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
// Raise the ceiling rather than weaken the parameter.
const MAXMEM = 64 * 1024 * 1024;
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters.'), { statusCode: 400 });
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(plain, salt, KEYLEN, { N, maxmem: MAXMEM });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  if (!stored || typeof plain !== 'string') return false;

  const [scheme, n, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(plain, salt, expected.length, { N: Number(n), maxmem: MAXMEM });

  // Constant-time: a length mismatch alone would otherwise leak through timing.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
