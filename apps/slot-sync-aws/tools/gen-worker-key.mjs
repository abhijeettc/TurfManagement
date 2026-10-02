/**
 * Creates the blocking worker's key pair for sealing platform logins.
 *
 *   node apps/slot-sync-aws/tools/gen-worker-key.mjs
 *
 * worker-public.pem  — read by the dashboard API to SEAL logins. Not secret.
 * worker-private.pem — read ONLY by the worker (src/lib/credentialVault.mjs) to
 *                      open them. Never give this to the dashboard/API process.
 *
 * In AWS the private half belongs in a KMS asymmetric key whose policy allows
 * Decrypt to the block-worker role alone; this file is the laptop stand-in.
 * Refuses to overwrite an existing pair: replacing the private key makes every
 * saved login unreadable until it is entered again.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.keys');
const pub = path.join(dir, 'worker-public.pem');
const priv = path.join(dir, 'worker-private.pem');

if (existsSync(priv) || existsSync(pub)) {
  console.error(`A key pair already exists in ${dir}. Not overwriting — delete it by hand if you really mean to rotate.`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
writeFileSync(pub, publicKey);
writeFileSync(priv, privateKey, { mode: 0o600 });
try { chmodSync(priv, 0o600); } catch { /* best effort on Windows */ }
console.log(`Created ${pub}\nCreated ${priv}  (keep this one private)`);
