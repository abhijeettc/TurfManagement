import { checkRequest, startSweeper } from './rateLimit.js';

/**
 * Cheap, response-only hardening. A CSP is deliberately not set here: the board
 * is one page with its own inline markup, and a policy loose enough not to
 * break it would give a false sense of cover. That belongs with the move off
 * static HTML.
 */
const HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * Called on the root instance, not registered as a plugin: a plugin's hooks are
 * scoped to its own routes, and these must cover every route and the static files.
 */
export function applySecurity(app) {
  const stopSweeper = startSweeper();
  app.addHook('onClose', async () => stopSweeper());

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/health') return;

    const limited = checkRequest({
      method: request.method,
      path,
      ip: request.ip,
      deviceToken: request.headers['x-device-token'],
    });
    if (!limited) return;

    request.log.warn({ policy: limited.policy, ip: request.ip, path }, 'rate limited');
    reply
      .header('retry-after', String(limited.retryAfterSec))
      .code(429)
      .send({ error: 'Too many requests. Please wait a moment and try again.' });
    return reply;
  });

  app.addHook('onSend', async (request, reply) => {
    for (const [k, v] of Object.entries(HEADERS)) reply.header(k, v);
    if (process.env.NODE_ENV === 'production') {
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    }
    // Board data and sessions must never be served from a shared cache.
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) {
      reply.header('cache-control', 'no-store');
    }
  });
}
