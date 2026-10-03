import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, checkRequest } from '../apps/api/src/security/rateLimit.js';

test('limiter allows up to the limit, then refuses with a retry hint', () => {
  let t = 0;
  const l = new Limiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.equal(l.consume('k').allowed, true);
  assert.equal(l.consume('k').allowed, true);
  assert.equal(l.consume('k').allowed, true);
  const refused = l.consume('k');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSec >= 1);
});

test('limiter window rolls over and keys are independent', () => {
  let t = 0;
  const l = new Limiter({ limit: 1, windowMs: 1000, now: () => t });
  l.consume('a');
  assert.equal(l.consume('a').allowed, false);
  assert.equal(l.consume('b').allowed, true);
  t = 1001;
  assert.equal(l.consume('a').allowed, true);
});

test('peek does not count, reset clears', () => {
  const l = new Limiter({ limit: 1, windowMs: 1000 });
  for (let i = 0; i < 5; i += 1) assert.equal(l.peek('k').allowed, true);
  l.consume('k');
  l.consume('k');
  assert.equal(l.peek('k').allowed, false);
  l.reset('k');
  assert.equal(l.peek('k').allowed, true);
});

test('sweep drops expired windows', () => {
  let t = 0;
  const l = new Limiter({ limit: 1, windowMs: 1000, now: () => t });
  l.consume('a');
  t = 2000;
  l.sweep();
  assert.equal(l.store.size, 0);
});

test('signup is capped at 5 an hour per address; other addresses are unaffected', () => {
  const req = (ip) => checkRequest({ method: 'POST', path: '/auth/signup', ip });
  for (let i = 0; i < 5; i += 1) assert.equal(req('203.0.113.9'), null);
  assert.equal(req('203.0.113.9')?.policy, 'signup');
  assert.equal(req('203.0.113.10'), null);
});

test('ingest budget is per device token, not per shared shop address', () => {
  const noisy = () => checkRequest({ method: 'POST', path: '/ingest/notification', ip: '198.51.100.1', deviceToken: 'noisy-token-aaaaaaaa' });
  for (let i = 0; i < 241; i += 1) noisy();
  assert.equal(noisy()?.policy, 'ingest');
  const quiet = checkRequest({ method: 'POST', path: '/devices/heartbeat', ip: '198.51.100.1', deviceToken: 'quiet-token-bbbbbbbb' });
  assert.equal(quiet, null);
});

test('unlisted paths (static assets, websocket) are not limited', () => {
  assert.equal(checkRequest({ method: 'GET', path: '/app.js', ip: '1.1.1.1' }), null);
  assert.equal(checkRequest({ method: 'GET', path: '/ws', ip: '1.1.1.1' }), null);
});
