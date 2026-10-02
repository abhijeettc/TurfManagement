import { sendAlert } from '../lib/alerts.mjs';

/** SQS-triggered from block-jobs-dlq. A message here means block-worker exhausted its retries. */
export async function handler(event) {
  const alertPhone = process.env.ALERT_PHONE;

  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    await sendAlert(alertPhone, 'block_failed', {
      court: job.slot?.courtName ?? 'unknown court',
      slot: job.slot ? `${job.slot.startTime}-${job.slot.endTime}` : 'unknown slot',
      platform: job.targetPlatform ?? 'unknown platform',
      error: 'automated block failed after retries — please block it manually',
    });
  }
}
