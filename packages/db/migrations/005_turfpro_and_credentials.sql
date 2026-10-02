-- TurfPro as a first-class platform, plus sealed platform logins and an
-- audit trail of every time the blocking worker used them.

-- A new enum value cannot be used in the transaction that adds it; nothing in
-- this file uses it, so adding it here is safe.
alter type platform_t add value if not exists 'turfpro';

-- ---------------------------------------------------------------- credentials
--
-- Usernames and passwords for the apps TurfSync blocks slots on.
--
-- Nothing in this table is readable by whoever can read the database. The
-- dashboard seals each login with the WORKER's public key (hybrid RSA-OAEP +
-- AES-256-GCM, see apps/api/src/credentials/seal.js); only the blocking worker
-- holds the private key. The API therefore cannot decrypt a login it stored —
-- it can only replace it or delete it — and neither can a superadmin with a
-- database dump. `sealed` is the whole envelope as JSON text.
create table if not exists platform_credentials (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  platform    platform_t not null,
  sealed      text not null,
  -- Which worker key sealed it, so a key rotation can find what to re-seal.
  key_id      text not null,
  updated_by  uuid references accounts(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (venue_id, platform)
);

-- ---------------------------------------------------------------- activity
--
-- One row per use of a saved login, written by the worker. Records WHAT was
-- done and WHY, never the login itself.
create table if not exists credential_activity (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  platform    platform_t not null,
  -- login_attempt | login_ok | login_failed | session_reused | read_slots
  -- | block_slot | unblock_slot | credential_saved | credential_removed
  action      text not null,
  outcome     text not null default 'ok',
  -- Human-readable context: which ground/slot, which booking caused it.
  detail      text,
  actor       text not null default 'worker',
  at          timestamptz not null default now()
);

create index if not exists credential_activity_venue_idx
  on credential_activity (venue_id, at desc);
create index if not exists credential_activity_platform_idx
  on credential_activity (venue_id, platform, at desc);
