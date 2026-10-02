import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

// Module-level cache: Lambda reuses a warm execution environment across
// invocations, and a platform credential or device token does not change
// mid-flight, so paying the Secrets Manager round trip once per cold start
// (not once per invocation) is the right tradeoff.
const cache = new Map();

export async function getSecretJson(secretId) {
  if (!secretId) throw new Error('getSecretJson called with no secretId');
  if (cache.has(secretId)) return cache.get(secretId);
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = JSON.parse(SecretString);
  cache.set(secretId, value);
  return value;
}

/** Test-only: forget cached secrets between test cases. */
export function clearSecretsCache() {
  cache.clear();
}
