import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const kms = new KMSClient({});
const s3 = new S3Client({});

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

const BUCKET = () => process.env.SESSIONS_BUCKET;
const KMS_KEY_ID = () => process.env.SESSION_KMS_KEY_ID;

/**
 * Same scheme as apps/api/src/blocking/crypto.js — AES-256-GCM, unique IV per
 * record, an authenticated tag (a tampered blob fails to decrypt rather than
 * silently returning garbage), and key material versioned alongside the
 * ciphertext so rotation doesn't strand old sessions. What changes: instead of
 * a sha256-derived key from a flat env var, this uses real envelope
 * encryption via KMS GenerateDataKey/Decrypt — the encrypted data key travels
 * in the object body, the master key never leaves KMS.
 */
export async function saveSession(platform, plaintextObj) {
  const { Plaintext: dataKey, CiphertextBlob: encryptedDataKey } = await kms.send(
    new GenerateDataKeyCommand({ KeyId: KMS_KEY_ID(), KeySpec: 'AES_256' }),
  );

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, dataKey, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const body = JSON.stringify({
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    encryptedDataKey: Buffer.from(encryptedDataKey).toString('base64'),
    keyId: KMS_KEY_ID(),
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: `sessions/${platform}.json`,
      Body: body,
      ContentType: 'application/json',
    }),
  );
}

/** @returns the saved storageState, or null if this platform has never logged in. */
export async function loadSession(platform) {
  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET(), Key: `sessions/${platform}.json` }));
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }

  const raw = await obj.Body.transformToString();
  const { iv, tag, ciphertext, encryptedDataKey, keyId } = JSON.parse(raw);

  const { Plaintext: dataKey } = await kms.send(
    new DecryptCommand({ CiphertextBlob: Buffer.from(encryptedDataKey, 'base64'), KeyId: keyId }),
  );

  const decipher = createDecipheriv(ALGO, dataKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

/** Screenshot proof, one per block attempt — `proof/<date>/<eventKey>-<platform>.png`. */
export async function saveProofScreenshot(eventKey, platform, buffer) {
  const date = new Date().toISOString().slice(0, 10);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: `proof/${date}/${eventKey}-${platform}.png`,
      Body: buffer,
      ContentType: 'image/png',
    }),
  );
}
