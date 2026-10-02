import { parse, ParseFailure } from '@turfsync/parsers';
import { slotFromCalendarDate } from '@turfsync/core/time.js';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from './sqsClient.mjs';
import { claimEvent, dedupeKey } from './dedupe.mjs';
import { claimEcho } from './echoExpectations.mjs';
import { findByExternalLabel, otherTargets } from './courtMapping.mjs';
import { sendAlert } from './alerts.mjs';

/**
 * Shared by the ingest Function URL handler and the email-poller — one place
 * for parse -> echo-check -> court-map -> dedupe -> fan-out, mirroring
 * apps/api/src/ingest/pipeline.js's shape (steps 2-7 of its own comment),
 * ported to DynamoDB + SQS.
 *
 * Cancellations are alert-only in v1, same caution apps/api's design applies:
 * a wrongly released slot is worse than one left blocked.
 */
export async function ingestPayload({ rawText, channel = 'notification', platformHint = null }) {
  const venueSlug = process.env.VENUE_SLUG;
  const alertPhone = process.env.ALERT_PHONE;

  let parsed, parseStatus;
  try {
    ({ parsed, parseStatus } = await parse(rawText, { channel, platformHint }));
  } catch (err) {
    const message = err instanceof ParseFailure ? err.message : `unexpected: ${err.message}`;
    await sendAlert(alertPhone, 'parse_failure', { platform: platformHint ?? 'unknown', raw: rawText });
    return { outcome: 'parse_failed', error: message };
  }

  const { startMs, endMs } = slotFromCalendarDate(parsed.date, parsed.startHhmm, parsed.endHhmm);

  // ---- echo check: is this our own block/unblock coming back as a "booking"?
  const echo = await claimEcho({
    venueSlug,
    platform: parsed.platform,
    externalCourtId: parsed.courtLabel,
    startMs,
    endMs,
  });
  if (echo) return { outcome: 'echo_suppressed' };

  // ---- map the source platform's court label to the canonical court
  const mapping = await findByExternalLabel(parsed.platform, parsed.courtLabel);
  if (!mapping) return { outcome: 'unmapped_court', courtLabel: parsed.courtLabel };

  if (parsed.cancelled) {
    return { outcome: 'cancelled_noop' };
  }

  const eventKey = `${parsed.platform}#${mapping.canonicalCourt}#${parsed.date}#${parsed.startHhmm}`;
  const key = dedupeKey({
    externalBookingId: parsed.externalBookingId,
    platform: parsed.platform,
    externalCourtId: parsed.courtLabel,
    businessDate: parsed.date,
    startIso: new Date(startMs).toISOString(),
  });

  const claimed = await claimEvent({
    pk: eventKey,
    dedupeKey: key,
    type: 'booked',
    endTime: parsed.endHhmm,
    sourceRef: parsed.externalBookingId ?? null,
    targets: {},
    createdAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + 90 * 86400,
  });
  if (!claimed) return { outcome: 'duplicate' };

  const selfBlock = (process.env.SELF_BLOCK_PLATFORMS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const targets = otherTargets(mapping, parsed.platform, { selfBlock });
  for (const target of targets) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.BLOCK_QUEUE_URL,
        MessageBody: JSON.stringify({
          eventKey,
          kind: 'block',
          targetPlatform: target.platform,
          slot: {
            courtName: target.courtName,
            date: parsed.date,
            startTime: parsed.startHhmm,
            endTime: parsed.endHhmm,
          },
        }),
        // The queue is FIFO, grouped by target platform — this is what stops
        // two sessions ever being open on the same platform at once (see
        // infra/lib/slot-sync-stack.mjs). DeduplicationId reuses this fan-out
        // message's own natural idempotency key; claimEvent() above already
        // stops a duplicate ingest from reaching this line at all, so this is
        // a second, cheap layer, not the primary dedupe mechanism.
        MessageGroupId: target.platform,
        MessageDeduplicationId: `${eventKey}#${target.platform}`,
      }),
    );
  }

  return { outcome: 'queued', targets: targets.map((t) => t.platform), parseStatus };
}
