/**
 * The block-job lifecycle, as pure functions.
 *
 * queued → leased → submitted → verified
 *                 ↘ retrying (attempt <= 3) → failed
 *   (any pre-terminal state) → superseded
 *
 * `submitted` is not success — only a verification re-fetch that reads the
 * slot as blocked earns `verified`. `superseded` is what a cancellation does
 * to a job that never got to run, or undoes on one that already succeeded.
 *
 * Nothing here touches Postgres, Redis, or an adapter. That is deliberate: the
 * backoff schedule and the legal-transition graph are exactly the part of
 * Phase 3 that has nothing to do with any specific platform, and they should
 * be testable without either.
 */

// 5s, 30s, 3m — from the build plan's write-back sequence.
export const BACKOFF_MS = [5_000, 30_000, 180_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

const TRANSITIONS = {
  queued: ['leased', 'superseded'],
  leased: ['submitted', 'retrying', 'failed', 'superseded'],
  submitted: ['verified', 'retrying', 'failed', 'superseded'],
  retrying: ['leased', 'superseded'],
  verified: ['superseded'], // a cancellation can still undo an already-verified block
  failed: [],
  superseded: [],
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// Deliberately its own list, not derived from the transition graph's
// out-degree: 'verified' has exactly one legal edge (a cancellation can still
// move it to 'superseded'), but it is terminal in the sense that matters to
// the worker's own retry logic — nothing more is ever attempted on it. Only
// 'queued', 'leased' and 'retrying' are states where the forward attempt is
// still in progress.
const TERMINAL_STATES = new Set(['verified', 'failed', 'superseded']);

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * What happens after an attempt fails (the adapter threw, or verification
 * came back false). `attemptsSoFar` is the count going in, before this one.
 */
export function nextAfterFailure(attemptsSoFar, error) {
  const attempts = attemptsSoFar + 1;
  if (attempts > MAX_ATTEMPTS) {
    return { state: 'failed', attempts, delayMs: null, terminal: true, error };
  }
  return { state: 'retrying', attempts, delayMs: BACKOFF_MS[attempts - 1], terminal: false, error };
}

/** A verification re-fetch confirmed the slot is genuinely blocked. */
export function afterVerified() {
  return { state: 'verified', terminal: true };
}

/** The venue or platform kill switch is off. We chose not to act, not that we tried and failed. */
export function afterKillSwitch(reason) {
  return { state: 'failed', terminal: true, error: `alert-only mode: ${reason}` };
}

/** A cancellation reached this job before or after it ran. */
export function afterSuperseded() {
  return { state: 'superseded', terminal: true };
}
