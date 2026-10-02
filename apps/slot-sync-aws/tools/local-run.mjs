/**
 * End-to-end local test: a real captured booking text goes in one end, and
 * out the other comes a blocked slot on the OTHER platforms — with no AWS
 * account, no real platform credentials, and no real browser automation
 * (ADAPTER_MOCK=1 swaps in MockAdapter). What IS real: DynamoDB/S3/SQS calls
 * against LocalStack, the actual parser, the actual dedupe/echo/court-mapping
 * logic, and a real (if pointless — MockAdapter never navigates it anywhere)
 * headless Chromium page, so `page.screenshot()` in slotState.mjs has
 * something real to call.
 *
 * Runs TWO scenarios, sourced on two different platforms, specifically so
 * every platform is seen both as a source (excluded from its own fan-out)
 * and as a target (blocked because a booking happened elsewhere) — otherTargets()
 * always excludes the booking's own source platform, which is correct, not a
 * bug, but is easy to misread from a single-scenario run.
 *
 * Requires: `npm run local:up` first (starts LocalStack + bootstraps it),
 * and Chromium installed for Playwright (`npx playwright install chromium`).
 */
import { applyLocalEnv } from './localEnv.mjs';
applyLocalEnv();

import { chromium } from 'playwright';
import { ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { sqs } from '../src/lib/sqsClient.mjs';
import { ddb } from '../src/lib/ddbClient.mjs';
import { ingestPayload } from '../src/lib/ingestCore.mjs';
import { runBlockJob } from '../src/lib/slotState.mjs';
import { sendAlert } from '../src/lib/alerts.mjs';

// A genuine captured WhatsApp booking — packages/parsers/fixtures/real.json's
// "khelomore-notification-01" (Pickle & Pitch Club, Hinjewadi Phase 2, 27 Sep
// 2026). Source platform: khelomore. Expected targets: hudle, playo.
const KHELOMORE_BOOKING =
  'KheloMore\nNew Booking Alert\nA new booking has been received at Pickle And Pitch Club.\n' +
  '👤 Customer: Rohan Desai\n📅 Game Day: 27 Sep \'26\n⏰ Slot: 07:00 PM - 08:00 PM\n' +
  '🏓 Property: Synthetic Ball\n💰 Amount Paid: 637.0\n' +
  'Review booking details here: http://rml.fm/tG1xgp. Prepare accordingly!\nTeam KheloMore';

// packages/parsers/fixtures/invented.json's "playo-notification-evening".
// Source platform: playo. Expected targets: hudle, khelomore — this is what
// proves khelomore DOES get a block job, just never one for a booking that
// originated on khelomore itself.
const PLAYO_BOOKING =
  'New Booking Confirmed\nTurf A · Sat, 02 Sep\n07:00 PM - 08:00 PM\n' +
  'Rohit Menon · 9912345651\nBooking ID: PLY-4471902';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function ingestTwice(label, bookingText, expectedTargets) {
  section(`Ingest a real captured ${label} booking`);
  const first = await ingestPayload({ rawText: bookingText, channel: 'notification' });
  console.log(first);
  if (first.outcome !== 'queued') {
    throw new Error(`expected outcome "queued", got "${first.outcome}" — check court_mapping seed matches courtLabel`);
  }
  const gotTargets = [...first.targets].sort();
  const wantTargets = [...expectedTargets].sort();
  if (JSON.stringify(gotTargets) !== JSON.stringify(wantTargets)) {
    throw new Error(`expected fan-out targets ${wantTargets}, got ${gotTargets}`);
  }

  section(`Re-ingest the same ${label} text — dedupe should catch it`);
  const second = await ingestPayload({ rawText: bookingText, channel: 'notification' });
  console.log(second);
  if (second.outcome !== 'duplicate') {
    throw new Error(`expected outcome "duplicate" on re-ingest, got "${second.outcome}"`);
  }
}

async function drainAndBlock(browser) {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: process.env.BLOCK_QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
  );
  if (!Messages?.length) return [];

  const blockedOn = [];
  for (const message of Messages) {
    const job = JSON.parse(message.Body);
    console.log(`\n-- job: block ${job.slot.courtName} on ${job.targetPlatform} --`);

    const page = await browser.newPage();
    const result = await runBlockJob({
      page,
      venueSlug: process.env.VENUE_SLUG,
      platform: job.targetPlatform,
      slot: job.slot,
      eventKey: job.eventKey,
      alertTo: process.env.ALERT_PHONE,
    });
    console.log(result);
    await page.close();

    // Mirrors block-worker/handler.mjs's handleOne — the same targets-map
    // update and success alert the real Lambda sends, not just runBlockJob's
    // own bare result.
    await ddb.send(
      new UpdateCommand({
        TableName: process.env.SLOT_SYNC_EVENTS_TABLE,
        Key: { pk: job.eventKey },
        UpdateExpression: 'SET targets.#p = :v',
        ExpressionAttributeNames: { '#p': job.targetPlatform },
        ExpressionAttributeValues: { ':v': result.outcome },
      }),
    );
    if (result.outcome === 'blocked') {
      await sendAlert(process.env.ALERT_PHONE, 'block_succeeded', {
        court: job.slot.courtName,
        slot: `${job.slot.startTime}-${job.slot.endTime}`,
        platforms: [job.targetPlatform],
      });
      blockedOn.push(job.targetPlatform);
    }

    await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.BLOCK_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
  }
  return blockedOn;
}

await ingestTwice('KheloMore', KHELOMORE_BOOKING, ['turfpro']);
await ingestTwice('Playo', PLAYO_BOOKING, ['turfpro']);

section('Drain the block-jobs queue and run every job (MockAdapter)');
const browser = await chromium.launch();
let blockedOn;
try {
  blockedOn = await drainAndBlock(browser);
} finally {
  await browser.close();
}

const unexpected = blockedOn.filter((p) => p !== 'turfpro');
if (unexpected.length || blockedOn.length !== 2) {
  throw new Error(`expected exactly two TurfPro blocks (one per scenario) and nothing else; got: ${blockedOn}`);
}

section('done');
console.log('Both bookings (KheloMore- and Playo-sourced) were blocked on TurfPro only — no other platform was targeted.');
