/**
 * Wraps the ingest Lambda handler in a plain HTTP server, so a REAL phone on
 * the same Wi-Fi can point its DeviceConfig.apiUrl at your laptop and you can
 * test the actual physical path — phone -> WhatsApp -> NotificationListener
 * -> this laptop -> parse/dedupe/fan-out against LocalStack — before ever
 * deploying to AWS or visiting the owner. `npm run local:test` (local-run.mjs)
 * only proves the backend logic; this proves the phone side too.
 *
 * An Android emulator is NOT a substitute here — it can't receive real
 * WhatsApp notifications. Use a real device (apps/android-spike/README.md
 * says the same about the original notification-capture spike, for the same
 * reason).
 *
 * Requires `npm run local:up` first.
 */
import { applyLocalEnv, LOCAL_ENV, readBridge } from './localEnv.mjs';
applyLocalEnv();
// REAL_ADAPTER=1 drives the real TurfPro panel instead of MockAdapter.
if (process.env.REAL_ADAPTER === '1') delete process.env.ADAPTER_MOCK;

import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import { handler as ingestHandler } from '../src/ingest/handler.mjs';
import { chromium } from 'playwright';
import { ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { sqs } from '../src/lib/sqsClient.mjs';
import { ddb } from '../src/lib/ddbClient.mjs';
import { runBlockJob } from '../src/lib/slotState.mjs';
import { CONTEXT_OPTIONS, LAUNCH_ARGS } from '../src/lib/adapters/turfpro.mjs';
import { sendAlert } from '../src/lib/alerts.mjs';
import { recordMessages, recordBlock, resolveEntry, completeBrowserBlock, noteLoginNeeded, failBrowserBlock, statusHtml, statusJson } from './status-page.mjs';

// Stands in for the block-worker Lambda: consumes the SQS queue the ingest
// handler fills, so a phone notification ends in a (mock or real) block.
// HEADED=1 shows the browser while it works.
async function blockWorkerLoop() {
  for (;;) {
    try {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: process.env.BLOCK_QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 5 }),
      );
      for (const message of Messages ?? []) {
        const job = JSON.parse(message.Body);
        console.log(`[worker] block ${job.slot.courtName} ${job.slot.date} ${job.slot.startTime}-${job.slot.endTime} on ${job.targetPlatform}`);

        // TurfPro is blocked from the owner's own, already logged-in tablet browser:
        // the app opens TurfPro's /turfsync/block page from a notification (see
        // android-spike BlockNotifier). Set TURFPRO_BLOCK_MODE=playwright to drive a
        // headless browser instead.
        if (job.targetPlatform === 'turfpro' && process.env.TURFPRO_BLOCK_MODE !== 'playwright') {
          recordBlock(job, 'awaiting_browser');
          console.log('[worker] waiting for the owner to tap the block notification on the tablet');
          await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.BLOCK_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
          continue;
        }

        const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: LAUNCH_ARGS });
        try {
          const page = await (await browser.newContext(CONTEXT_OPTIONS)).newPage();
          const result = await runBlockJob({
            page, venueSlug: process.env.VENUE_SLUG, platform: job.targetPlatform,
            slot: job.slot, eventKey: job.eventKey, alertTo: process.env.ALERT_PHONE,
          });
          console.log('[worker] result:', result);
          recordBlock(job, result.outcome);
          await ddb.send(new UpdateCommand({
            TableName: process.env.SLOT_SYNC_EVENTS_TABLE, Key: { pk: job.eventKey },
            UpdateExpression: 'SET targets.#p = :v', ExpressionAttributeNames: { '#p': job.targetPlatform },
            ExpressionAttributeValues: { ':v': result.outcome },
          }));
          if (result.outcome === 'blocked') {
            await sendAlert(process.env.ALERT_PHONE, 'block_succeeded', {
              court: job.slot.courtName, slot: `${job.slot.startTime}-${job.slot.endTime}`, platforms: [job.targetPlatform],
            });
          }
          await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.BLOCK_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
        } catch (err) {
          // Left on the queue: SQS redelivers, then the DLQ takes it (maxReceiveCount=3).
          console.error('[worker] job failed:', err.message);
          recordBlock(job, 'failed', err.message);
        } finally {
          await browser.close();
        }
      }
    } catch (err) {
      console.error('[worker] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
blockWorkerLoop();

/**
 * Also hand each message to the dashboard's own ingest, so the booking shows on
 * its calendar (with the app it came from). Independent of the blocking path:
 * if the dashboard is down or rejects it, blocking is unaffected.
 */
function recordOnDashboard(path, body) {
  const bridge = readBridge();
  if (!bridge?.deviceToken) return;
  fetch(`${process.env.DASHBOARD_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': bridge.deviceToken },
    body,
  }).catch((err) => console.warn('[bridge] dashboard not reachable:', err.message));
}

const PORT = Number(process.env.LOCAL_SERVER_PORT ?? 8787);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 3001);

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  const path = (req.url ?? '/').split('?')[0];

  // The tablet app opens this address in a browser view: `/` is the blocking
  // status page, whose button leads to the original TurfSync dashboard.
  if (req.method === 'GET' && (path === '/' || path === '/status')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(statusHtml());
    return;
  }
  if (req.method === 'GET' && path === '/status.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(statusJson()));
    return;
  }

  // Pinged by TurfPro's /turfsync/block page (no-cors, text/plain body) once the
  // slot is blocked, or when it finds the owner signed out of TurfPro.
  if (req.method === 'POST' && (path === '/status/browser-done' || path === '/status/browser-login-needed')) {
    let ok = false;
    try {
      const id = JSON.parse(body || '{}').id;
      ok = path === '/status/browser-done' ? completeBrowserBlock(id) : noteLoginNeeded(id);
    } catch { /* bad body */ }
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (req.method === 'POST' && path === '/status/browser-failed') {
    let ok = false;
    try {
      const b = JSON.parse(body || '{}');
      ok = failBrowserBlock(b.id, b.outcome, b.detail);
    } catch { /* bad body */ }
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (req.method === 'POST' && path === '/status/resolve') {
    let ok = false;
    try { ok = resolveEntry(JSON.parse(body || '{}').id); } catch { /* bad body */ }
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // The dashboard's worker-only routes must never be reachable from the
  // tablet-facing address; the worker talks to the dashboard directly.
  if (path.startsWith('/internal')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // Everything else except the two device endpoints is the original TurfSync
  // dashboard (apps/api on :3001, `PORT=3001 npm run dev`), proxied through.
  if (!['/ingest/notification', '/devices/heartbeat'].includes(path)) {
    const upstream = http.request(
      { host: '127.0.0.1', port: DASHBOARD_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${DASHBOARD_PORT}` } },
      (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<h2>Dashboard not running</h2><p>Start it with <code>npm run dev</code> in the repo root.</p>');
    });
    upstream.end(body);
    return;
  }

  const event = {
    rawPath: path,
    headers: req.headers, // Node already lower-cases these, matching handler.mjs's lookup
    body,
    requestContext: { http: { method: req.method, path } },
  };

  let result;
  try {
    result = await ingestHandler(event);
  } catch (err) {
    console.error('handler threw', err);
    result = { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }

  if (path === '/devices/heartbeat') recordOnDashboard(path, body); // keeps the dashboard's tablet status live
  if (path === '/ingest/notification') {
    recordOnDashboard(path, body);
    try {
      const parsedBody = JSON.parse(body || '{}');
      const items = Array.isArray(parsedBody.items) ? parsedBody.items : [parsedBody];
      recordMessages(items, JSON.parse(result.body ?? '{}').results);
    } catch {
      /* status history only — an unreadable body was already answered by the handler */
    }
  }

  res.writeHead(result.statusCode, result.headers ?? {});
  res.end(result.body ?? '');
  console.log(`${req.method} ${path} -> ${result.statusCode}`);
});

server.on('upgrade', (req, socket, head) => {
  const up = net.connect(DASHBOARD_PORT, '127.0.0.1', () => {
    const CRLF = String.fromCharCode(13, 10);
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join(CRLF);
    up.write(`${req.method} ${req.url} HTTP/1.1${CRLF}${headers}${CRLF}${CRLF}`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Local ingest server listening on port ${PORT}\n`);
  const addrs = lanAddresses();
  if (addrs.length) {
    console.log('Point the phone\'s API URL field at one of:');
    for (const addr of addrs) console.log(`  http://${addr}:${PORT}`);
  } else {
    console.log('No LAN address found — phone must be on the same network as this machine, reachable by its IP.');
  }
  console.log(`\nDevice token: ${LOCAL_ENV.DEVICE_TOKEN}`);
  console.log('\nWaiting for requests (Ctrl+C to stop)...');
});
