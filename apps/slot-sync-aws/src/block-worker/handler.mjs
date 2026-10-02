import { chromium } from 'playwright';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/ddbClient.mjs';
import { runBlockJob } from '../lib/slotState.mjs';
import { CONTEXT_OPTIONS, LAUNCH_ARGS } from '../lib/adapters/turfpro.mjs';
import { sendAlert } from '../lib/alerts.mjs';

/**
 * SQS-triggered, batch size 1. Retries are SQS's own redelivery (visibility
 * timeout) up to the queue's redrive policy maxReceiveCount, then the message
 * moves to the DLQ, which dlq-alert picks up. Coarser than apps/api's
 * 5s/30s/3m backoff ladder (blocking/stateMachine.js) — SQS has no per-message
 * custom backoff — but the shape (bounded retries, then a terminal alert to
 * the owner) is the same idea.
 */
export async function handler(event) {
  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    await handleOne(job);
  }
}

async function handleOne(job) {
  const { eventKey, targetPlatform, slot } = job;
  const venueSlug = process.env.VENUE_SLUG;
  const alertPhone = process.env.ALERT_PHONE;

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--single-process', '--disable-dev-shm-usage', ...LAUNCH_ARGS],
  });

  try {
    // IST: TurfPro renders slot times in the browser's timezone, and a Lambda is UTC.
    const page = await (await browser.newContext(CONTEXT_OPTIONS)).newPage();
    const result = await runBlockJob({ page, venueSlug, platform: targetPlatform, slot, eventKey, alertTo: alertPhone });

    await ddb.send(
      new UpdateCommand({
        TableName: process.env.SLOT_SYNC_EVENTS_TABLE,
        Key: { pk: eventKey },
        UpdateExpression: 'SET targets.#p = :v',
        ExpressionAttributeNames: { '#p': targetPlatform },
        ExpressionAttributeValues: { ':v': result.outcome },
      }),
    );

    if (result.outcome === 'blocked') {
      await sendAlert(alertPhone, 'block_succeeded', {
        court: slot.courtName,
        slot: `${slot.startTime}-${slot.endTime}`,
        platforms: [targetPlatform],
      });
    }
  } catch (err) {
    // Re-throw: SQS redelivers per the queue's redrive policy. The terminal
    // failure (DLQ) is where dlq-alert takes over and tells the owner.
    throw err;
  } finally {
    await browser.close();
  }
}
