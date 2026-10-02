-- Phase 3 write-back infrastructure.
--
-- Everything here is inert by default. auto_block_enabled defaults false, so a
-- venue produces zero block jobs until someone explicitly turns it on — the
-- build plan's risk gate (>=14 days read-only, >=98% parse accuracy per venue)
-- enforced at the schema level, not only by policy or code review.

alter table venues
  add column if not exists auto_block_enabled boolean not null default false;

-- Envelope-encrypted session blobs record which master key version encrypted
-- them, so rotating SESSION_ENCRYPTION_KEY does not silently break every
-- stored session at once — old rows keep decrypting under their own version
-- until they are next re-encrypted.
alter table platform_accounts
  add column if not exists session_key_version int;

-- Nightly full-calendar reconciliation writes one row per venue per platform
-- per run. This is the safety net that catches whatever the listener missed —
-- a booking we never saw, or a block that silently fell off the platform's
-- own calendar.
create table if not exists reconciliation_runs (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues(id) on delete cascade,
  platform         platform_t not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  bookings_checked int not null default 0,
  -- [{courtId, kind: 'missing_block'|'unexpected_block', slot, bookingId}]
  drift            jsonb not null default '[]',
  error            text
);

create index if not exists reconciliation_runs_venue_idx
  on reconciliation_runs (venue_id, started_at desc);
