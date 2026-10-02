import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sealing platform logins so that this process — and the database it writes to
 * — can never read them back.
 *
 * The dashboard holds only the blocking worker's PUBLIC key. A login is
 * encrypted with a fresh AES-256-GCM key, and that key is wrapped with the
 * worker's public key (RSA-OAEP, SHA-256). Unwrapping needs the private key,
 * which lives with the worker alone (a KMS key in production, a key file the
 * API never reads on a laptop). So:
 *
 *   - a database dump, or a superadmin running SQL, sees only ciphertext;
 *   - this API can store, replace and delete a login but cannot decrypt one;
 *   - only the worker can open it, at the moment it logs in.
 *
 * The envelope is bound to (venue, platform) as GCM additional data, so a
 * sealed login copied onto another venue's row, or another platform's, fails
 * to open instead of silently logging in as someone else.
 *
 * The matching `open` lives in apps/slot-sync-aws/src/lib/credentialVault.mjs.
 * It is deliberately not exported from here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_KEY = path.resolve(here, '../../../slot-sync-aws/.keys/worker-public.pem');

let cached = null;

function loadPublicKey() {
  if (cached) return cached;
  const file = process.env.WORKER_PUBLIC_KEY_FILE || DEFAULT_PUBLIC_KEY;
  let pem;
  try {
    pem = readFileSync(file, 'utf8');
  } catch {
    throw Object.assign(
      new Error('The blocking worker has no encryption key yet, so logins cannot be saved. Run: node apps/slot-sync-aws/tools/gen-worker-key.mjs'),
      { statusCode: 503 },
    );
  }
  const key = createPublicKey(pem);
  const der = key.export({ type: 'spki', format: 'der' });
  cached = { key, keyId: createHash('sha256').update(der).digest('hex').slice(0, 16) };
  return cached;
}

export const sealAad = (venueId, platform) => Buffer.from(`${venueId}|${platform}`, 'utf8');

/** @returns {{ sealed: string, keyId: string }} sealed is JSON text, safe to store. */
export function sealLogin({ venueId, platform, username, password }) {
  const { key, keyId } = loadPublicKey();

  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(sealAad(venueId, platform));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ username, password }), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const wrappedKey = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dataKey,
  );

  return {
    keyId,
    sealed: JSON.stringify({
      v: 1,
      alg: 'RSA-OAEP-256+A256GCM',
      kid: keyId,
      wk: wrappedKey.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    }),
  };
}
