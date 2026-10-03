/**
 * A small fixed-window limiter, in memory.
 *
 * The API is one process (the worker is separate and never serves HTTP), so a
 * Map is the honest store: no Redis round trip on every request, and nothing
 * to go down. If the API is ever scaled out, swap `store` for Redis INCR with
 * the same shape — the callers only see `consume`, `peek` and `reset`.
 */
export class Limiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.store = new Map(); // key -> { count, resetAt }
  }

  #entry(key) {
    const t = this.now();
    let e = this.store.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.store.set(key, e);
    }
    return e;
  }

  /** Count one attempt. */
  consume(key) {
    const e = this.#entry(key);
    e.count += 1;
    return this.#verdict(e);
  }

  /** Look without counting — used to refuse before doing expensive work. */
  peek(key) {
    const e = this.store.get(key);
    if (!e || e.resetAt <= this.now()) return { allowed: true, remaining: this.limit, retryAfterSec: 0 };
    return this.#verdict(e);
  }

  reset(key) {
    this.store.delete(key);
  }

  /** Drop expired windows so a scan of random keys cannot grow the Map forever. */
  sweep() {
    const t = this.now();
    for (const [key, e] of this.store) if (e.resetAt <= t) this.store.delete(key);
  }

  #verdict(e) {
    return {
      allowed: e.count <= this.limit,
      remaining: Math.max(0, this.limit - e.count),
      retryAfterSec: Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000)),
    };
  }
}

const MINUTE = 60_000;

/**
 * Policies by route. Numbers are chosen from who actually calls the route:
 * a person typing a password, a tablet that heartbeats every five minutes and
 * flushes a queue when it reconnects, a worker on the same host.
 */
export const POLICIES = [
  { name: 'signup',    match: (r) => r.method === 'POST' && r.path === '/auth/signup',       limit: 5,   windowMs: 60 * MINUTE },
  // Unauthenticated, and a success hands over a venue's write credential. The
  // per-code attempt cap in setup.js kills a targeted guess; this is what makes
  // spraying across codes expensive too. A real tablet calls it once.
  { name: 'pair',      match: (r) => r.method === 'POST' && r.path === '/devices/claim',     limit: 10,  windowMs: 15 * MINUTE },
  { name: 'login',     match: (r) => r.method === 'POST' && r.path === '/auth/login',        limit: 30,  windowMs: 15 * MINUTE },
  { name: 'ingest',    match: (r) => r.path.startsWith('/ingest/') || r.path === '/devices/heartbeat', limit: 240, windowMs: MINUTE },
  { name: 'internal',  match: (r) => r.path.startsWith('/internal/'),                        limit: 60,  windowMs: MINUTE },
  { name: 'api',       match: (r) => r.path.startsWith('/api/') || r.path.startsWith('/auth/'), limit: 300, windowMs: MINUTE },
];

/**
 * Failed-login throttle, keyed on email + IP. Per-IP alone lets one attacker
 * rotate through many accounts; per-email alone lets anyone lock the owner out
 * from anywhere. The pair slows guessing at one account from one place, which
 * is the attack that matters, without a lockout anyone else can trigger.
 */
export const loginFailures = new Limiter({ limit: 8, windowMs: 15 * MINUTE });

const limiters = new Map(POLICIES.map((p) => [p.name, new Limiter(p)]));

/** @returns null if the request may proceed, else { policy, retryAfterSec }. */
export function checkRequest({ method, path, ip, deviceToken }) {
  const policy = POLICIES.find((p) => p.match({ method, path }));
  if (!policy) return null;
  // A paired tablet is identified by its token, so one noisy device cannot burn
  // the budget of the shop's shared NAT address (and vice versa).
  const key = policy.name === 'ingest' && deviceToken ? `dev:${deviceToken.slice(0, 16)}` : `ip:${ip}`;
  const verdict = limiters.get(policy.name).consume(key);
  return verdict.allowed ? null : { policy: policy.name, retryAfterSec: verdict.retryAfterSec };
}

export function startSweeper() {
  const timer = setInterval(() => {
    loginFailures.sweep();
    for (const l of limiters.values()) l.sweep();
  }, 5 * MINUTE);
  timer.unref();
  return () => clearInterval(timer);
}
