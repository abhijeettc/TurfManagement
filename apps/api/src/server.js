import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, close } from '@turfsync/db';
import { bus } from './bus.js';
import { requireVenue } from './auth/guard.js';
import { startWatchdog } from './watchdog.js';
import { applySecurity } from './security/index.js';
import authRoutes from './routes/auth.js';
import ingestRoutes from './routes/ingest.js';
import boardRoutes from './routes/board.js';
import conflictRoutes from './routes/conflicts.js';
import moneyRoutes from './routes/money.js';
import setupRoutes from './routes/setup.js';
import syncRoutes from './routes/sync.js';
import credentialRoutes from './routes/credentials.js';
import blockStatusRoutes from './routes/blockStatus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..', '..', 'web', 'public');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2 * 1024 * 1024,
  // Behind a load balancer every request otherwise arrives from the proxy's
  // address, which makes per-IP limits and session records meaningless. Set
  // TRUST_PROXY to a hop count (1) or `true`; leave unset when exposed directly.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
});

function parseTrustProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

applySecurity(app);

// A POST with `content-type: application/json` and no body is rejected by the
// default parser with FST_ERR_CTP_EMPTY_JSON_BODY. Logout, heartbeat and any
// webhook that pings with no payload all legitimately do that, so treat an
// empty body as an empty object rather than a 400.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  if (!body || !String(body).trim()) return done(null, {});
  try {
    done(null, JSON.parse(body));
  } catch (error) {
    error.statusCode = 400;
    done(error);
  }
});

app.setErrorHandler((error, request, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) request.log.error({ err: error }, 'request failed');
  reply.code(status).send({ error: error.message });
});

await app.register(fastifyCookie);
await app.register(fastifyWebsocket);

/**
 * Live board updates. A booking landing on the counter tablet must appear on
 * the owner's phone without a refresh — the two screens are looking at the same
 * pitch, and a stale one is how a slot gets sold twice.
 */
app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, async (socket, request) => {
    // The live feed carries booking activity, so it needs the same membership
    // check the REST board gets. Without it the WebSocket is a hole straight
    // through the access layer.
    let venue;
    try {
      ({ venue } = await requireVenue(request, 'board:read'));
    } catch {
      socket.send(JSON.stringify({ type: 'unauthorized' }));
      socket.close(1008, 'unauthorized');
      return;
    }

    const onChange = (event) => {
      if (event.venueId !== venue.id) return;
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    };

    bus.on('board', onChange);
    socket.on('close', () => bus.off('board', onChange));
    socket.send(JSON.stringify({ type: 'hello', venueId: venue.id }));
  });
});

await app.register(authRoutes);
await app.register(ingestRoutes);
await app.register(boardRoutes);
await app.register(conflictRoutes);
await app.register(moneyRoutes);
await app.register(setupRoutes);
await app.register(syncRoutes);
await app.register(credentialRoutes);
await app.register(blockStatusRoutes);

app.get('/health', async () => {
  const { rows } = await pool.query('select 1 as ok');
  return { ok: rows[0].ok === 1, phase: 1, mode: 'read-only' };
});

// The board is one page. Serving it statically keeps the prototype's markup
// byte-for-byte intact; Next.js arrives when there is a second route worth
// server-rendering.
await app.register(fastifyStatic, { root: WEB_ROOT });

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  startWatchdog(app.log);
  app.log.info(`TurfSync board → http://localhost:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    await close();
    process.exit(0);
  });
}
