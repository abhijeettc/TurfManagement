/**
 * Stores one secret in LocalStack Secrets Manager, for local adapter
 * development — never used against real AWS (see docker-compose.yml /
 * localEnv.mjs). Creates the secret if it's new, overwrites the value if it
 * already exists.
 *
 * Usage:
 *   node tools/set-local-secret.mjs turfsync/local/hudle '{"email":"o@venue.example","password":"..."}'
 *
 * Matches the *_CREDENTIALS_SECRET_ID names in tools/localEnv.mjs — for a
 * platform's real credentials, use exactly `turfsync/local/<platform>`.
 */
import { applyLocalEnv } from './localEnv.mjs';
applyLocalEnv();

import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';

const [, , name, jsonValue] = process.argv;
if (!name || !jsonValue) {
  console.error('Usage: node tools/set-local-secret.mjs <secret-name> \'<json-value>\'');
  console.error('Example: node tools/set-local-secret.mjs turfsync/local/hudle \'{"email":"...","password":"..."}\'');
  process.exit(1);
}

try {
  JSON.parse(jsonValue);
} catch {
  console.error('The value must be valid JSON — wrap it in single quotes so your shell leaves the double quotes alone.');
  process.exit(1);
}

const client = new SecretsManagerClient({});

try {
  await client.send(new CreateSecretCommand({ Name: name, SecretString: jsonValue }));
  console.log(`created secret ${name}`);
} catch (err) {
  if (err instanceof ResourceExistsException) {
    await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: jsonValue }));
    console.log(`secret ${name} already existed, value updated`);
  } else {
    throw err;
  }
}
