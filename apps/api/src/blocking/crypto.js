/**
 * Envelope encryption for platform session blobs.
 *
 * `platform_accounts.session_blob` will hold cookies or tokens captured by
 * Playwright — credentials that let someone act as the venue on a real
 * marketplace. AES-256-GCM: authenticated (a tampered blob fails to decrypt
 * rather than silently returning garbage), unique IV per record, and the key
 * version travels with the row so rotating the master key doesn't strand
 * every session encrypted under the old one at once.
 *
 * SESSION_ENCRYPTION_KEY in `.env` is a development convenience. In
 * production this must come from a real secrets manager (AWS KMS, GCP Secret
 * Manager, etc.), not a flat environment variable sitting next to the rest of
 * the config — the whole point of encrypting these blobs is defeated if the
 * key lives beside them.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const CURRENT_KEY_VERSION = 1;

function deriveKey(secret, version) {
  // sha256 normalises any reasonably long secret to exactly 32 bytes, so the
  // operator does not have to hand-generate key material in the right shape.
  // Versioning the derivation (not just the stored key) means "rotate the
  // key" is "change the env var and bump CURRENT_KEY_VERSION" — no separate
  // key-storage format to get wrong.
  return createHash('sha256').update(`${secret}:v${version}`).digest();
}

function masterKey(version) {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'SESSION_ENCRYPTION_KEY is not set. Required before any platform session can be stored.',
    );
  }
  if (secret.length < 16) {
    throw new Error('SESSION_ENCRYPTION_KEY is too short — use at least 16 characters of real entropy.');
  }
  return deriveKey(secret, version);
}

/**
 * @param {object} plaintextObj — the session data (cookies, tokens, whatever
 *   Playwright captured). Never logged, never returned from an API route.
 * @returns {{ blob: Buffer, keyVersion: number }} ready for
 *   `platform_accounts.session_blob` / `session_key_version`.
 */
export function encryptSession(plaintextObj, keyVersion = CURRENT_KEY_VERSION) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey(keyVersion), iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { blob: Buffer.concat([iv, tag, ciphertext]), keyVersion };
}

/**
 * @param {Buffer} blob — from `platform_accounts.session_blob`
 * @param {number} keyVersion — from `platform_accounts.session_key_version`
 * @returns {object} the original session data
 * @throws if the blob was tampered with, or the key version is unknown
 */
export function decryptSession(blob, keyVersion = CURRENT_KEY_VERSION) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, masterKey(keyVersion), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export { CURRENT_KEY_VERSION };
