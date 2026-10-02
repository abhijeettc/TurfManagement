/**
 * The seam a future OFFICIAL or WRITTEN-CONSENT integration would implement.
 *
 * `worker.js` does not call this file at all — it never logs into a partner
 * dashboard, by design. Automating Playo's or Hudle's dashboard without their
 * agreement is against both platforms' published terms (Playo requires
 * written consent for automated access; Hudle bans it outright for a
 * competing product), and risks the venue's own listing being suspended.
 * See 06-Multi-Platform-Channel-Sync.md §2.2 and §8.
 *
 * This interface stays because the day a platform grants an official API or
 * written consent (§8.9/§9 of that doc), that is the only new code needed:
 * one class implementing these five methods, still tested against the
 * MockAdapter below, still with nothing above it (queue.js, the state
 * machine) needing to change. Until then it is documentation, not a live
 * code path.
 *
 * @typedef {object} PlatformAdapter
 * @property {(session: {venueId: string}) => Promise<{sessionBlob: object}>} login
 *   Establish a session with the owner's own credentials. Called once, and
 *   again whenever verifySession reports the session has expired.
 * @property {(args: {externalCourtId: string, startMs: number, endMs: number}) => Promise<{ok: boolean, raw: unknown}>} blockSlot
 *   Make the slot unavailable on this platform. Must be idempotent — calling
 *   it twice on an already-blocked slot is a success, not an error.
 * @property {(args: {externalCourtId: string, startMs: number, endMs: number}) => Promise<{ok: boolean, raw: unknown}>} unblockSlot
 *   Release a slot this system previously blocked. Called on cancellation.
 * @property {(args: {externalCourtId: string, startMs: number, endMs: number}) => Promise<boolean>} verifySlotBlocked
 *   Re-read the slot and confirm it is genuinely blocked. `submitted` is not
 *   `verified` — only this call earns that state.
 * @property {(args: {externalCourtId: string, fromMs: number, toMs: number}) => Promise<Array<{startMs: number, endMs: number}>>} readCalendar
 *   The platform's own idea of what is blocked in a window. Feeds nightly
 *   reconciliation and onboarding backfill.
 */

/**
 * What every real platform is, until its recon lands. Throwing loudly here is
 * the point: a silent no-op would let a venue believe auto-block is running
 * when nothing is actually happening.
 */
export class NotImplementedAdapter {
  constructor(platform) {
    this.platform = platform;
  }

  #unimplemented(method) {
    throw Object.assign(
      new Error(
        `No adapter is implemented for "${this.platform}" yet (${method}). ` +
          `This needs the Phase 0 endpoint recon — DevTools or mitmproxy against ` +
          `a real login and a real block-slot action — before it can be written.`,
      ),
      { code: 'ADAPTER_NOT_IMPLEMENTED', platform: this.platform },
    );
  }

  async login() { this.#unimplemented('login'); }
  async blockSlot() { this.#unimplemented('blockSlot'); }
  async unblockSlot() { this.#unimplemented('unblockSlot'); }
  async verifySlotBlocked() { this.#unimplemented('verifySlotBlocked'); }
  async readCalendar() { this.#unimplemented('readCalendar'); }
}

/**
 * An in-memory stand-in for a platform's calendar, used by every test in this
 * subsystem. It is deliberately capable of failing on command — the whole
 * point of the queue and the state machine is to survive a platform that
 * fails, times out, or reports a slot as free when it should be blocked.
 */
export class MockAdapter {
  constructor(platform) {
    this.platform = platform;
    /** @type {Map<string, Array<{startMs: number, endMs: number}>>} */
    this.blocked = new Map();
    this.calls = [];
    // Test hooks: set these to make the next call to that method fail once.
    this.failNextBlock = false;
    this.failNextUnblock = false;
    this.failNextVerify = false;
    this.verifyReturnsFalseOnce = false;
  }

  #key(externalCourtId) {
    return `${this.platform}:${externalCourtId}`;
  }

  #overlaps(a, b) {
    return a.startMs < b.endMs && b.startMs < a.endMs;
  }

  async login() {
    this.calls.push(['login']);
    return { sessionBlob: { platform: this.platform, mock: true, at: Date.now() } };
  }

  async blockSlot({ externalCourtId, startMs, endMs }) {
    this.calls.push(['blockSlot', externalCourtId, startMs, endMs]);
    if (this.failNextBlock) {
      this.failNextBlock = false;
      throw new Error('mock: platform rejected the block request');
    }
    const key = this.#key(externalCourtId);
    const existing = this.blocked.get(key) ?? [];
    existing.push({ startMs, endMs });
    this.blocked.set(key, existing);
    return { ok: true, raw: { mock: true } };
  }

  async unblockSlot({ externalCourtId, startMs, endMs }) {
    this.calls.push(['unblockSlot', externalCourtId, startMs, endMs]);
    if (this.failNextUnblock) {
      this.failNextUnblock = false;
      throw new Error('mock: platform rejected the unblock request');
    }
    const key = this.#key(externalCourtId);
    const existing = this.blocked.get(key) ?? [];
    this.blocked.set(
      key,
      existing.filter((r) => !(r.startMs === startMs && r.endMs === endMs)),
    );
    return { ok: true, raw: { mock: true } };
  }

  async verifySlotBlocked({ externalCourtId, startMs, endMs }) {
    this.calls.push(['verifySlotBlocked', externalCourtId, startMs, endMs]);
    if (this.failNextVerify) {
      this.failNextVerify = false;
      throw new Error('mock: verification request timed out');
    }
    if (this.verifyReturnsFalseOnce) {
      this.verifyReturnsFalseOnce = false;
      return false;
    }
    const ranges = this.blocked.get(this.#key(externalCourtId)) ?? [];
    return ranges.some((r) => this.#overlaps(r, { startMs, endMs }));
  }

  async readCalendar({ externalCourtId, fromMs, toMs }) {
    this.calls.push(['readCalendar', externalCourtId, fromMs, toMs]);
    const ranges = this.blocked.get(this.#key(externalCourtId)) ?? [];
    return ranges.filter((r) => this.#overlaps(r, { startMs: fromMs, endMs: toMs }));
  }
}

// One MockAdapter per platform, not a fresh one per call. A real platform's
// calendar persists between the moment we block a slot and the moment a
// later, unrelated call (verification, nightly reconciliation) asks it about
// that same slot — a throwaway instance per call would silently forget
// everything the instant the calling function returned.
const mockInstances = new Map();

/**
 * @param {string} platform
 * @param {{mock?: boolean}} [opts]
 * @returns {PlatformAdapter}
 */
export function getAdapter(platform, { mock = false } = {}) {
  if (mock) {
    if (!mockInstances.has(platform)) mockInstances.set(platform, new MockAdapter(platform));
    return mockInstances.get(platform);
  }
  // One line changes per platform once recon lands:
  //   if (platform === 'playo') return new PlayoAdapter();
  return new NotImplementedAdapter(platform);
}

/** Test-only: start every mock platform's calendar empty again. */
export function resetMockAdapters() {
  mockInstances.clear();
}
