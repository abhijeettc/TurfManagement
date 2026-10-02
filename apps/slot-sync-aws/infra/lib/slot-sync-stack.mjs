import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_sqs as sqs,
  aws_kms as kms,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_secretsmanager as secretsmanager,
  aws_logs as logs,
} from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/slot-sync-aws/infra/lib -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const APP_ROOT = path.resolve(__dirname, '../../');
const LOCK_FILE = path.join(REPO_ROOT, 'package-lock.json');

/**
 * One stack per venue (the doc's "one venue per deployment" scope). Resource
 * names are suffixed with `venueSlug` so multiple venues can each get their
 * own stack in the same AWS account without colliding.
 */
export class SlotSyncStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { venueSlug, enabledPlatforms, alertPhone } = props;

    // ---------------------------------------------------------------- data

    const eventsTable = new dynamodb.Table(this, 'SlotSyncEventsTable', {
      tableName: `slot-sync-${venueSlug}-events`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const courtMappingTable = new dynamodb.Table(this, 'CourtMappingTable', {
      tableName: `slot-sync-${venueSlug}-court-mapping`,
      partitionKey: { name: 'canonicalCourt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const echoExpectationsTable = new dynamodb.Table(this, 'EchoExpectationsTable', {
      tableName: `slot-sync-${venueSlug}-echo-expectations`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // KMS key for session-blob envelope encryption (src/lib/session.mjs) and
    // the bucket's own SSE-KMS. A dedicated CMK, not the AWS-managed S3 key,
    // so IAM can grant GenerateDataKey/Decrypt to exactly the two Lambdas
    // that need it and no one else.
    const sessionKey = new kms.Key(this, 'SessionKey', {
      description: `TurfSync Slot Sync session encryption key (${venueSlug})`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const sessionsBucket = new s3.Bucket(this, 'SessionsBucket', {
      bucketName: `turfsync-${venueSlug}-private`.toLowerCase(),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: sessionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ prefix: 'proof/', expiration: Duration.days(90) }],
    });

    // ---------------------------------------------------------------- queue

    // FIFO, grouped by target platform (see ingestCore.mjs's MessageGroupId).
    // Lambda's SQS-FIFO integration guarantees it never runs two messages
    // from the same group concurrently — so two sessions never open on the
    // same platform at once, which both avoids racing each other and avoids
    // the stronger bot-detection signal of simultaneous logins on one
    // account. Different platforms still process in parallel; a FIFO queue's
    // DLQ must also be FIFO. Throughput cap (3000 msg/s with batching) is
    // nowhere near a concern at this scale.
    const dlq = new sqs.Queue(this, 'BlockJobsDlq', {
      queueName: `slot-sync-${venueSlug}-block-jobs-dlq.fifo`,
      fifo: true,
      retentionPeriod: Duration.days(14),
    });

    const blockQueue = new sqs.Queue(this, 'BlockJobsQueue', {
      queueName: `slot-sync-${venueSlug}-block-jobs.fifo`,
      fifo: true,
      // >= block-worker's own timeout (90s) plus headroom, so SQS never
      // redelivers a message a still-running invocation is holding.
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ---------------------------------------------------------------- secrets
    // Referenced by name, not provisioned here — the owner creates these by
    // hand post-deploy (see README.md). Secrets Manager charges per secret
    // whether or not this stack "owns" it, and provisioning empty credential
    // secrets from IaC would just mean deploying twice.
    const deviceTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'DeviceTokenSecret', `turfsync/${venueSlug}/device-token`,
    );
    const imapSecret = secretsmanager.Secret.fromSecretNameV2(this, 'ImapSecret', `turfsync/${venueSlug}/imap`);
    const gupshupSecret = secretsmanager.Secret.fromSecretNameV2(this, 'GupshupSecret', `turfsync/${venueSlug}/gupshup`);
    const platformSecrets = Object.fromEntries(
      enabledPlatforms.map((platform) => [
        platform,
        secretsmanager.Secret.fromSecretNameV2(this, `${capitalize(platform)}Secret`, `turfsync/${venueSlug}/${platform}`),
      ]),
    );

    // ---------------------------------------------------------------- env

    const commonEnv = {
      VENUE_SLUG: venueSlug,
      ENABLED_PLATFORMS: enabledPlatforms.join(','),
      ALERT_PHONE: alertPhone ?? '',
      TURFPRO_URL: props.turfproUrl ?? 'http://turfpro.local',
      SLOT_SYNC_EVENTS_TABLE: eventsTable.tableName,
      COURT_MAPPING_TABLE: courtMappingTable.tableName,
      ECHO_EXPECTATIONS_TABLE: echoExpectationsTable.tableName,
      BLOCK_QUEUE_URL: blockQueue.queueUrl,
      SESSIONS_BUCKET: sessionsBucket.bucketName,
      SESSION_KMS_KEY_ID: sessionKey.keyId,
      GUPSHUP_SECRET_ID: gupshupSecret.secretName,
      // WHATSAPP_PROVIDER and ANTHROPIC_API_KEY are deliberately left unset
      // here — the same "missing = fail loudly, not console vs. real by
      // accident" default the rest of the repo uses (.env.example). Set them
      // by hand post-deploy once Gupshup templates / the Anthropic key exist.
      PARSER_FALLBACK_MODEL: 'claude-haiku-4-5',
    };

    const nodeFnDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      depsLockFilePath: LOCK_FILE,
      projectRoot: REPO_ROOT,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      bundling: { format: 'esm', mainFields: ['module', 'main'], target: 'node20' },
    };

    // ---------------------------------------------------------------- ingest

    const ingestFn = new NodejsFunction(this, 'IngestFunction', {
      ...nodeFnDefaults,
      entry: path.join(APP_ROOT, 'src/ingest/handler.mjs'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { ...commonEnv, DEVICE_TOKEN_SECRET_ID: deviceTokenSecret.secretName },
    });
    eventsTable.grantReadWriteData(ingestFn);
    echoExpectationsTable.grantReadWriteData(ingestFn);
    courtMappingTable.grantReadData(ingestFn);
    blockQueue.grantSendMessages(ingestFn);
    gupshupSecret.grantRead(ingestFn);
    deviceTokenSecret.grantRead(ingestFn);

    // Auth is the tablet's X-Device-Token header, checked in-app (see
    // src/ingest/handler.mjs) — AWS_IAM auth would require the tablet to sign
    // requests with SigV4, which the existing Android app does not do.
    const ingestUrl = ingestFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // ---------------------------------------------------------------- email poller

    const emailPollerFn = new NodejsFunction(this, 'EmailPollerFunction', {
      ...nodeFnDefaults,
      entry: path.join(APP_ROOT, 'src/email-poller/handler.mjs'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: { ...commonEnv, IMAP_SECRET_ID: imapSecret.secretName },
    });
    eventsTable.grantReadWriteData(emailPollerFn);
    echoExpectationsTable.grantReadWriteData(emailPollerFn);
    courtMappingTable.grantReadData(emailPollerFn);
    blockQueue.grantSendMessages(emailPollerFn);
    gupshupSecret.grantRead(emailPollerFn);
    imapSecret.grantRead(emailPollerFn);

    new events.Rule(this, 'EmailPollerSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(emailPollerFn)],
    });

    // ---------------------------------------------------------------- block-worker / health-check
    // Both share one Playwright container image (see docker/block-worker.Dockerfile),
    // built once from the repo root, with `cmd` overridden per function.

    const dockerImageDefaults = {
      code: (cmd) =>
        lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
          file: 'apps/slot-sync-aws/docker/block-worker.Dockerfile',
          cmd: [cmd],
        }),
      memorySize: 2048,
      logRetention: logs.RetentionDays.TWO_WEEKS,
    };

    const platformSecretEnv = Object.fromEntries(
      enabledPlatforms.map((platform) => [
        `${platform.toUpperCase()}_CREDENTIALS_SECRET_ID`,
        platformSecrets[platform].secretName,
      ]),
    );

    const blockWorkerFn = new lambda.DockerImageFunction(this, 'BlockWorkerFunction', {
      ...dockerImageDefaults,
      code: dockerImageDefaults.code('src/block-worker/handler.handler'),
      timeout: Duration.seconds(90),
      environment: { ...commonEnv, ...platformSecretEnv },
    });
    eventsTable.grantReadWriteData(blockWorkerFn);
    echoExpectationsTable.grantReadWriteData(blockWorkerFn);
    sessionsBucket.grantReadWrite(blockWorkerFn, 'sessions/*');
    sessionsBucket.grantWrite(blockWorkerFn, 'proof/*');
    sessionKey.grantEncryptDecrypt(blockWorkerFn);
    gupshupSecret.grantRead(blockWorkerFn);
    for (const secret of Object.values(platformSecrets)) secret.grantRead(blockWorkerFn);
    blockWorkerFn.addEventSource(new eventSources.SqsEventSource(blockQueue, { batchSize: 1 }));

    const healthCheckFn = new lambda.DockerImageFunction(this, 'HealthCheckFunction', {
      ...dockerImageDefaults,
      code: dockerImageDefaults.code('src/health-check/handler.handler'),
      timeout: Duration.seconds(120),
      environment: { ...commonEnv, ...platformSecretEnv },
    });
    gupshupSecret.grantRead(healthCheckFn);
    for (const secret of Object.values(platformSecrets)) secret.grantRead(healthCheckFn);

    new events.Rule(this, 'HealthCheckSchedule', {
      // 06:00 IST == 00:30 UTC.
      schedule: events.Schedule.cron({ minute: '30', hour: '0' }),
      targets: [new eventTargets.LambdaFunction(healthCheckFn)],
    });

    // ---------------------------------------------------------------- dlq-alert

    const dlqAlertFn = new NodejsFunction(this, 'DlqAlertFunction', {
      ...nodeFnDefaults,
      entry: path.join(APP_ROOT, 'src/dlq-alert/handler.mjs'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: commonEnv,
    });
    gupshupSecret.grantRead(dlqAlertFn);
    dlqAlertFn.addEventSource(new eventSources.SqsEventSource(dlq, { batchSize: 1 }));

    // ---------------------------------------------------------------- outputs

    new CfnOutput(this, 'IngestUrl', { value: ingestUrl.url });
    new CfnOutput(this, 'EventsTableName', { value: eventsTable.tableName });
    new CfnOutput(this, 'CourtMappingTableName', { value: courtMappingTable.tableName });
    new CfnOutput(this, 'SessionsBucketName', { value: sessionsBucket.bucketName });
    new CfnOutput(this, 'BlockQueueUrl', { value: blockQueue.queueUrl });
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
