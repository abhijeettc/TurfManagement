/**
 * In-memory stand-in for a platform's calendar, used by every test in this
 * subsystem and by the pipeline when ADAPTER_MOCK=1. Mirrors
 * apps/api/src/blocking/adapter.js's MockAdapter — deliberately capable of
 * failing on command, since the point of the retry/DLQ path is surviving a
 * platform that fails, times out, or reports a slot as free when it isn't.
 *
 * Unlike the real adapters, methods here take no `page` — there is nothing to
 * drive a browser against.
 */
export class MockAdapter {
  constructor(platform) {
    this.id = platform;
    /** @type {Map<string, Array<{startTime: string, endTime: string}>>} */
    this.blocked = new Map();
    this.calls = [];
    this.failNextBlock = false;
    this.verifyReturnsWrongOnce = false;
  }

  #key(courtName, date) {
    return `${this.id}:${courtName}:${date}`;
  }

  #overlaps(a, b) {
    return a.startTime < b.endTime && b.startTime < a.endTime;
  }

  async login() {
    this.calls.push(['login']);
  }

  async isLoggedIn() {
    this.calls.push(['isLoggedIn']);
    return true;
  }

  async getSlotState(page, slot) {
    this.calls.push(['getSlotState', slot]);
    if (this.verifyReturnsWrongOnce) {
      this.verifyReturnsWrongOnce = false;
      return 'free';
    }
    const ranges = this.blocked.get(this.#key(slot.courtName, slot.date)) ?? [];
    return ranges.some((r) => this.#overlaps(r, slot)) ? 'blocked' : 'free';
  }

  async blockSlot(page, slot) {
    this.calls.push(['blockSlot', slot]);
    if (this.failNextBlock) {
      this.failNextBlock = false;
      throw new Error('mock: platform rejected the block request');
    }
    const key = this.#key(slot.courtName, slot.date);
    const existing = this.blocked.get(key) ?? [];
    existing.push({ startTime: slot.startTime, endTime: slot.endTime });
    this.blocked.set(key, existing);
  }

  async unblockSlot(page, slot) {
    this.calls.push(['unblockSlot', slot]);
    const key = this.#key(slot.courtName, slot.date);
    const existing = this.blocked.get(key) ?? [];
    this.blocked.set(
      key,
      existing.filter((r) => !(r.startTime === slot.startTime && r.endTime === slot.endTime)),
    );
  }

  async healthCheck() {
    this.calls.push(['healthCheck']);
  }
}
