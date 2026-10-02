import { EventEmitter } from 'node:events';

/**
 * In-process fan-out from the ingest pipeline to open WebSocket boards.
 *
 * One venue's board is open on the counter tablet and the owner's phone at the
 * same time; both must show a new booking without a refresh. A single process
 * is enough at Phase 1 scale — when the API runs on more than one node this
 * becomes Redis pub/sub and nothing upstream of it changes.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitBoardChange(venueId, payload) {
  bus.emit('board', { venueId, ...payload });
}
