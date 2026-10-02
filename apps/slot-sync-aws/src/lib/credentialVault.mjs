import { createDecipheriv, createPrivateKey, privateDecrypt, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';

/**
 * Opens a login the dashboard sealed for this worker (the counterpart of
 * apps/api/src/credentials/seal.js). This is the ONLY place a saved username
 * and password ever exist in plaintext, and only for the length of one login.
 *
 * Key custody:
 *   - WORKER_KMS_KEY_ID set  -> the data key is unwrapped inside AWS KMS
 *     (an RSA_3072 key with RSAES_OAEP_SHA_256). The private key never leaves
 *     KMS and its policy can allow Decrypt to this worker's role alone.
 *     (Written to the KMS API contract; not exercised against real AWS yet.)
 *   - otherwise              -> WORKER_PRIVATE_KEY_FILE, a PEM only this
 *     process reads. The dashboard/API never gets this path.
 *
 * Nothing here is logged, cached or written anywhere.
 */

const DASHBOARD_URL = () => (process.env.DASHBOARD_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

async function unwrapDataKey(wrapped) {
  const kmsKey = process.env.WORKER_KMS_KEY_ID;
  if (kmsKey) {
    const { Plaintext } = await new KMSClient({}).send(
      new DecryptCommand({ KeyId: kmsKey, CiphertextBlob: wrapped, EncryptionAlgorithm: 'RSAES_OAEP_SHA_256' }),
    );
    return Buffer.from(Plaintext);
  }
  const file = process.env.WORKER_PRIVATE_KEY_FILE;
  if (!file) throw new Error('worker has no private key configured (WORKER_KMS_KEY_ID or WORKER_PRIVATE_KEY_FILE)');
  const key = createPrivateKey(readFileSync(file, 'utf8'));
  return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
}

/** @returns {Promise<{username: string, password: string}>} */
export async function getLogin(platform) {
  const venueId = process.env.TURFSYNC_VENUE_ID;
  if (!venueId) throw new Error('TURFSYNC_VENUE_ID is not set');

  const res = await fetch(`${DASHBOARD_URL()}/internal/credentials/${venueId}/${platform}`, {
    headers: { 'x-worker-token': process.env.WORKER_TOKEN ?? '' },
  });
  if (res.status === 404) throw Object.assign(new Error(`no ${platform} login saved — add it under Setup → App logins`), { code: 'NO_LOGIN_SAVED' });
  if (!res.ok) throw new Error(`could not fetch the sealed ${platform} login (HTTP ${res.status})`);
  const { sealed } = await res.json();
  const env = JSON.parse(sealed);

  const dataKey = await unwrapDataKey(Buffer.from(env.wk, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(env.iv, 'base64'));
  // Bound to (venue, platform): a login copied onto another row fails here.
  decipher.setAAD(Buffer.from(`${venueId}|${platform}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  const { username, password } = JSON.parse(plain.toString('utf8'));
  if (!username || !password) throw new Error(`the saved ${platform} login is incomplete`);
  return { username, password };
}
