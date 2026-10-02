import { ImapFlow } from 'imapflow';
import { getSecretJson } from '../lib/secrets.mjs';
import { ingestPayload } from '../lib/ingestCore.mjs';

/**
 * EventBridge-triggered, every 1 minute. Backup channel to the tablet
 * listener — same parse path, just a different source of raw text.
 */
export async function handler() {
  const creds = await getSecretJson(process.env.IMAP_SECRET_ID);
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port ?? 993,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  await client.connect();
  const results = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const message of client.fetch({ seen: false }, { source: true, envelope: true })) {
        const raw = message.source.toString('utf8');
        const outcome = await ingestPayload({ rawText: raw, channel: 'email' });
        results.push({ uid: message.uid, outcome: outcome.outcome });
        await client.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { processed: results.length, results };
}
