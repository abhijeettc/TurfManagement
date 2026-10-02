/**
 * The interface every platform adapter implements. Mirrors the doc's
 * TypeScript `PlatformAdapter`, and the documentation style of
 * apps/api/src/blocking/adapter.js's `PlatformAdapter` typedef — this file
 * exists to be read, not imported; adapters and the registry reference the
 * shape by convention, checked by `test/adapters.registry.test.mjs`.
 *
 * @typedef {object} SlotRef
 * @property {string} courtName  the TARGET platform's own name for the court
 * @property {string} date       'YYYY-MM-DD'
 * @property {string} startTime  'HH:MM'
 * @property {string} endTime    'HH:MM'
 *
 * @typedef {object} PlatformAdapter
 * @property {string} id
 * @property {(page: import('playwright').Page) => Promise<void>} login
 *   Establish a session with the owner's own credentials (fetched internally
 *   from Secrets Manager — see each adapter's `credentialsSecretId`). Called
 *   only when `isLoggedIn` reports false.
 * @property {(page: import('playwright').Page) => Promise<boolean>} isLoggedIn
 * @property {(page: import('playwright').Page, slot: SlotRef) => Promise<'free'|'booked'|'blocked'>} getSlotState
 * @property {(page: import('playwright').Page, slot: SlotRef) => Promise<void>} blockSlot
 *   Must be idempotent — calling it on an already-blocked slot is a success.
 * @property {(page: import('playwright').Page, slot: SlotRef) => Promise<void>} unblockSlot
 * @property {(page: import('playwright').Page) => Promise<void>} healthCheck
 *   Login + open the slot grid. Nothing more.
 */

export {};
