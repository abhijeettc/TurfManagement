/**
 * Creates every resource the pipeline needs inside LocalStack — the
 * DynamoDB tables, the S3 bucket, the SQS queue + DLQ, the device-token
 * secret, and one seed court-mapping row — so tools/local-run.mjs has
 * something real (if local) to read and write. Idempotent: safe to re-run.
 *
 * Requires `docker compose up -d localstack` (see docker-compose.yml) to
 * already be running.
 */
import { applyLocalEnv, LOCAL_ENV } from './localEnv.mjs';
applyLocalEnv();

import { DynamoDBClient, CreateTableCommand, ListTablesCommand, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { KMSClient, CreateKeyCommand, CreateAliasCommand } from '@aws-sdk/client-kms';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  ResourceExistsException,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const ddb = new DynamoDBClient({});
const ddbDoc = DynamoDBDocumentClient.from(ddb);
const kms = new KMSClient({});
const s3 = new S3Client({ forcePathStyle: true });
const sqs = new SQSClient({});
const secretsManager = new SecretsManagerClient({});

async function waitForLocalStack(retries = 30, delayMs = 2000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      await ddb.send(new ListTablesCommand({}));
      return;
    } catch (err) {
      if (i === retries - 1) throw new Error(`LocalStack not reachable at ${LOCAL_ENV.AWS_ENDPOINT_URL}: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function createTable(tableName, keyAttr) {
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: keyAttr, AttributeType: 'S' }],
        KeySchema: [{ AttributeName: keyAttr, KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    console.log(`created table ${tableName}`);
  } catch (err) {
    if (err instanceof ResourceInUseException) console.log(`table ${tableName} already exists`);
    else throw err;
  }
}

async function createSessionKey() {
  // session.mjs envelope-encrypts saved browser sessions with this key.
  try {
    const { KeyMetadata } = await kms.send(new CreateKeyCommand({ Description: 'slot-sync local session key' }));
    await kms.send(new CreateAliasCommand({ AliasName: LOCAL_ENV.SESSION_KMS_KEY_ID, TargetKeyId: KeyMetadata.KeyId }));
    console.log(`created KMS key ${LOCAL_ENV.SESSION_KMS_KEY_ID}`);
  } catch (err) {
    if (err.name === 'AlreadyExistsException') console.log(`KMS alias ${LOCAL_ENV.SESSION_KMS_KEY_ID} already exists`);
    else throw err;
  }
}

async function createBucket(bucket) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created bucket ${bucket}`);
  } catch (err) {
    if (err.name === 'BucketAlreadyOwnedByYou' || err.name === 'BucketAlreadyExists') {
      console.log(`bucket ${bucket} already exists`);
    } else throw err;
  }
}

async function createQueues() {
  // FIFO — matches infra/lib/slot-sync-stack.mjs. ContentBasedDeduplication
  // is off because ingestCore.mjs always sends an explicit MessageDeduplicationId.
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: LOCAL_ENV.BLOCK_DLQ_NAME, Attributes: { FifoQueue: 'true' } }),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const mainQueue = await sqs.send(
    new CreateQueueCommand({ QueueName: LOCAL_ENV.BLOCK_QUEUE_NAME, Attributes: { FifoQueue: 'true' } }),
  );
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: mainQueue.QueueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes.QueueArn, maxReceiveCount: '3' }),
      },
    }),
  );
  console.log(`created queues ${LOCAL_ENV.BLOCK_QUEUE_NAME} (+ DLQ, redrive maxReceiveCount=3)`);
}

async function createDeviceTokenSecret() {
  const secretString = JSON.stringify({ token: LOCAL_ENV.DEVICE_TOKEN });
  try {
    await secretsManager.send(
      new CreateSecretCommand({ Name: LOCAL_ENV.DEVICE_TOKEN_SECRET_ID, SecretString: secretString }),
    );
    console.log(`created secret ${LOCAL_ENV.DEVICE_TOKEN_SECRET_ID}`);
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      await secretsManager.send(
        new PutSecretValueCommand({ SecretId: LOCAL_ENV.DEVICE_TOKEN_SECRET_ID, SecretString: secretString }),
      );
      console.log(`secret ${LOCAL_ENV.DEVICE_TOKEN_SECRET_ID} already existed, value refreshed`);
    } else throw err;
  }
}

async function seedCourtMapping() {
  // The two real TurfPro grounds. hudle/playo/khelomore labels only recognise
  // an incoming booking's court (the khelomore one matches the captured
  // fixture in packages/parsers/fixtures/real.json); blocking is TurfPro-only.
  // Source labels are placeholders until real ones are captured per ground.
  const courts = [
    { canonicalCourt: 'city-football-turf', turfpro: 'City Football Turf', aliases: ['Synthetic Ball'], khelomore: 'Synthetic Ball', playo: 'City Football Turf' },
    { canonicalCourt: 'raj-arena', turfpro: 'Raj Cricket & Football Arena', aliases: ['Raj Arena'], khelomore: 'Raj Arena', playo: 'Turf A' },
  ];
  for (const court of courts) {
    await ddbDoc.send(
      new PutCommand({
        TableName: LOCAL_ENV.COURT_MAPPING_TABLE,
        Item: { ...court, enabledPlatforms: ['turfpro'], slotMinutes: 60 },
      }),
    );
    console.log(`seeded court_mapping: ${court.canonicalCourt} -> turfpro "${court.turfpro}"`);
  }
  await ddbDoc.send(new DeleteCommand({ TableName: LOCAL_ENV.COURT_MAPPING_TABLE, Key: { canonicalCourt: 'turf-a' } }));
}

console.log(`waiting for LocalStack at ${LOCAL_ENV.AWS_ENDPOINT_URL}...`);
await waitForLocalStack();

await createTable(LOCAL_ENV.SLOT_SYNC_EVENTS_TABLE, 'pk');
await createTable(LOCAL_ENV.COURT_MAPPING_TABLE, 'canonicalCourt');
await createTable(LOCAL_ENV.ECHO_EXPECTATIONS_TABLE, 'pk');
await createBucket(LOCAL_ENV.SESSIONS_BUCKET);
await createSessionKey();
await createQueues();
await createDeviceTokenSecret();
await seedCourtMapping();

console.log('\nLocalStack bootstrap complete. Run: npm run local:test');
