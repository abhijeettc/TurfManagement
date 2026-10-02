import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The dashboard side seals; the worker side opens. These tests pin the claims
// the product makes about saved logins: ciphertext only at rest, openable by
// the worker's private key alone, and bound to the venue + app they belong to.

const dir = mkdtempSync(path.join(tmpdir(), 'vault-test-'));
const realFetch = globalThis.fetch;
let sealLogin;
let getLogin;
let store; // what the "database" holds

before(async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(path.join(dir, 'pub.pem'), publicKey);
  writeFileSync(path.join(dir, 'priv.pem'), privateKey);
  process.env.WORKER_PUBLIC_KEY_FILE = path.join(dir, 'pub.pem');
  process.env.WORKER_PRIVATE_KEY_FILE = path.join(dir, 'priv.pem');
  delete process.env.WORKER_KMS_KEY_ID;
  process.env.WORKER_TOKEN = 'test-token';

  ({ sealLogin } = await import('../../api/src/credentials/seal.js'));
  ({ getLogin } = await import('../src/lib/credentialVault.mjs'));

  // Stand in for the dashboard's /internal route: returns whatever is stored.
  globalThis.fetch = async (url) => {
    const m = /\/internal\/credentials\/([^/]+)\/([^/]+)$/.exec(String(url));
    const row = m && store?.[`${m[1]}|${m[2]}`];
    return row
      ? { ok: true, status: 200, json: async () => row }
      : { ok: false, status: 404, json: async () => ({}) };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const USERNAME = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';

test('what is stored contains neither the username nor the password', () => {
  const { sealed } = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD });
  assert.ok(!sealed.includes(USERNAME));
  assert.ok(!sealed.includes(PASSWORD));
  assert.ok(!sealed.includes(Buffer.from(PASSWORD).toString('base64')));
});

test('the worker opens a login the dashboard sealed', async () => {
  process.env.TURFSYNC_VENUE_ID = 'v1';
  const { sealed, keyId } = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD });
  store = { 'v1|turfpro': { sealed, keyId } };
  assert.deepEqual(await getLogin('turfpro'), { username: USERNAME, password: PASSWORD });
});

test('sealing twice gives different ciphertext (no reusable fingerprint)', () => {
  const a = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD }).sealed;
  const b = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD }).sealed;
  assert.notEqual(a, b);
});

test('a login copied onto another venue or another app will not open', async () => {
  const { sealed, keyId } = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD });

  process.env.TURFSYNC_VENUE_ID = 'v2'; // another venue's worker, same ciphertext
  store = { 'v2|turfpro': { sealed, keyId } };
  await assert.rejects(() => getLogin('turfpro'));

  process.env.TURFSYNC_VENUE_ID = 'v1'; // same venue, different app
  store = { 'v1|playo': { sealed, keyId } };
  await assert.rejects(() => getLogin('playo'));
});

test('a tampered login will not open', async () => {
  process.env.TURFSYNC_VENUE_ID = 'v1';
  const { sealed, keyId } = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD });
  const env = JSON.parse(sealed);
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff;
  env.ct = ct.toString('base64');
  store = { 'v1|turfpro': { sealed: JSON.stringify(env), keyId } };
  await assert.rejects(() => getLogin('turfpro'));
});

test('without the worker private key a stored login cannot be opened', async () => {
  process.env.TURFSYNC_VENUE_ID = 'v1';
  const { sealed, keyId } = sealLogin({ venueId: 'v1', platform: 'turfpro', username: USERNAME, password: PASSWORD });
  store = { 'v1|turfpro': { sealed, keyId } };

  const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(path.join(dir, 'other.pem'), other.privateKey);
  const keep = process.env.WORKER_PRIVATE_KEY_FILE;
  process.env.WORKER_PRIVATE_KEY_FILE = path.join(dir, 'other.pem'); // a different key, e.g. the API's or an admin's
  await assert.rejects(() => getLogin('turfpro'));
  process.env.WORKER_PRIVATE_KEY_FILE = keep;
});
