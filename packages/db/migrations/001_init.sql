-- TurfSync — Phase 1 schema.
-- Ranges are the core primitive. Everything else is bookkeeping.

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums

do $$ begin
  create type platform_t as enum ('playo','khelomore','hudle','district','direct');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status_t as enum ('confirmed','cancelled','conflicted','no_show');
exception when duplicate_object then null; end $$;

-- How a row reached us. 'worker' is Phase 3 (session worker reconciliation).
do $$ begin
  create type source_t as enum ('notification','email','worker','manual');
exception when duplicate_object then null; end $$;

-- 'turfsync' marks a row we caused ourselves. See echo_expectations.
do $$ begin
  create type origin_t as enum ('external','turfsync');
exception when duplicate_object then null; end $$;

do $$ begin
  create type block_state_t as enum
    ('queued','leased','submitted','verified','retrying','failed','superseded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type parse_status_t as enum ('template','fallback','failed','echo_suppressed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- venues

create table if not exists venues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  locality    text,
  city        text not null,
  timezone    text not null default 'Asia/Kolkata',
  plan        text not null default 'pro',
  status      text not null default 'active',
  -- Venues run past midnight. The operating day rolls over at this hour local
  -- time, so a 01:30 slot belongs to the previous evening's business_date.
  day_rollover_hour int not null default 6,
  opens_at    time not null default '06:00',
  closes_at   time not null default '02:00',
  created_at  timestamptz not null default now()
);

create table if not exists courts (
  id        uuid primary key default gen_random_uuid(),
  venue_id  uuid not null references venues(id) on delete cascade,
  name      text not null,
  sport     text not null,
  position  int  not null default 0,
  created_at timestamptz not null default now(),
  unique (venue_id, name)
);

-- ---------------------------------------------------------------- platform wiring

create table if not exists platform_accounts (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues(id) on delete cascade,
  platform         platform_t not null,
  -- Phase 1 never logs in anywhere. auth_method/session_blob exist so Phase 3
  -- is a migration-free change; they stay null until then.
  auth_method      text,
  session_blob     bytea,
  commission_bps   int not null default 0,   -- basis points; negotiated per venue
  payout_cycle     text,
  status           text not null default 'active',
  last_event_at    timestamptz,
  session_expires_at timestamptz,
  unique (venue_id, platform)
);

-- One-time onboarding wizard writes this. Getting it wrong blocks the wrong
-- pitch, so nothing is trusted until verified_at is set by a live test block.
create table if not exists court_mappings (
  id                uuid primary key default gen_random_uuid(),
  court_id          uuid not null references courts(id) on delete cascade,
  platform          platform_t not null,
  external_court_id text,
  external_label    text not null,
  verified_at       timestamptz,
  unique (court_id, platform)
);

create index if not exists court_mappings_lookup
  on court_mappings (platform, lower(external_label));

-- ---------------------------------------------------------------- bookings

create table if not exists bookings (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues(id) on delete cascade,
  court_id            uuid not null references courts(id) on delete cascade,
  platform            platform_t not null,
  external_booking_id text,

  -- Absolute instants, stored UTC. Cross-midnight needs no special case:
  -- 23:00 IST to 01:00 IST is one contiguous range like any other.
  slot                tstzrange not null,

  -- The operating day a slot belongs to: 01:30 Sunday is Saturday night.
  -- Written by the normalizer, NOT generated — `at time zone` is STABLE, not
  -- IMMUTABLE, so Postgres rejects it in a GENERATED column.
  business_date       date not null,

  status              booking_status_t not null default 'confirmed',

  -- Money in paise. Never a float.
  gross_paise         bigint,
  commission_paise    bigint,
  net_paise           bigint,

  customer_name       text,
  customer_phone      text,          -- E.164 — the Phase 4 cross-platform identity key
  payment_mode        text,
  staff_name          text,          -- who took the cash, for walk-ins
  source_channel      source_t not null,
  origin              origin_t not null default 'external',
  dedupe_key          text not null,
  rebook_seq          int  not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  cancelled_at        timestamptz,

  constraint bookings_dedupe_uniq unique (venue_id, platform, dedupe_key),
  constraint bookings_slot_forward check (lower(slot) < upper(slot)),

  -- The database itself refuses to hold two live bookings on one pitch.
  -- A violation (23P01) IS a double-booking: the ingest pipeline catches it and
  -- opens a conflict. It must never surface as a 500.
  constraint bookings_no_overlap exclude using gist (
    court_id with =,
    slot     with &&
  ) where (status = 'confirmed')
);

create index if not exists bookings_board_idx
  on bookings (venue_id, business_date)
  where status in ('confirmed','conflicted');

create index if not exists bookings_phone_idx
  on bookings (customer_phone) where customer_phone is not null;

-- Maintenance / tournaments / the owner's own game. Not a booking: it earns
-- nothing and belongs to no platform, but it does occupy the pitch.
create table if not exists court_blocks (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues(id) on delete cascade,
  court_id      uuid not null references courts(id) on delete cascade,
  slot          tstzrange not null,
  business_date date not null,
  reason        text not null,
  created_at    timestamptz not null default now()
);

create index if not exists court_blocks_board_idx on court_blocks (venue_id, business_date);

-- ---------------------------------------------------------------- conflicts

create table if not exists conflicts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues(id) on delete cascade,
  court_id      uuid not null references courts(id) on delete cascade,
  slot          tstzrange not null,
  business_date date not null,
  booking_ids   uuid[] not null,
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  resolution    text,
  cost_paise    bigint not null default 0,
  cause         text
);

create index if not exists conflicts_open_idx
  on conflicts (venue_id, detected_at desc) where resolved_at is null;

-- ---------------------------------------------------------------- echo suppression
--
-- Finding 1 in the build plan. When we block 19:00 on Hudle, Hudle's partner app
-- fires a notification. Without this table the listener reads it back and ingests
-- our own write as a fresh external booking, which enqueues blocks on the other
-- three platforms — one of which is where the booking originated.
--
-- Phase 1 writes no rows here (nothing blocks yet) but the check runs on every
-- ingest from day one, so Phase 3 cannot forget to add it.

create table if not exists echo_expectations (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues(id) on delete cascade,
  platform          platform_t not null,
  external_court_id text,
  slot              tstzrange not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '15 minutes',
  consumed_at       timestamptz
);

create index if not exists echo_lookup_idx
  on echo_expectations (venue_id, platform, expires_at)
  where consumed_at is null;

-- ---------------------------------------------------------------- Phase 3 tables
--
-- Created now so the Phase 3 rollout is code-only. Nothing writes to them in
-- Phase 1: a venue on read-only produces zero block jobs by construction.

create table if not exists block_jobs (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references bookings(id) on delete cascade,
  target_platform platform_t not null,
  state           block_state_t not null default 'queued',
  attempts        int not null default 0,
  priority        int not null default 0,   -- slot proximity; lower runs first
  last_error      text,
  enqueued_at     timestamptz not null default now(),
  leased_until    timestamptz,
  completed_at    timestamptz,
  unique (booking_id, target_platform)
);

create index if not exists block_jobs_runnable_idx
  on block_jobs (state, priority, enqueued_at) where state in ('queued','retrying');

-- `submitted` is not success. Only a verification re-fetch that reads the slot
-- as blocked writes one of these.
create table if not exists block_receipts (
  id                  uuid primary key default gen_random_uuid(),
  block_job_id        uuid not null references block_jobs(id) on delete cascade,
  verified_at         timestamptz not null default now(),
  latency_ms          int,
  verification_method text not null,
  raw_response        jsonb
);

-- ---------------------------------------------------------------- observability

-- Raw payload stored verbatim, always — before parsing, before anything.
-- This is the fixtures corpus in production form.
create table if not exists notification_logs (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid references venues(id) on delete set null,
  platform      platform_t,
  source_channel source_t not null,
  raw_text      text not null,
  parsed_json   jsonb,
  parse_status  parse_status_t not null,
  parse_error   text,
  template_version text,
  booking_id    uuid references bookings(id) on delete set null,
  received_at   timestamptz not null default now(),
  latency_ms    int
);

create index if not exists notification_logs_recent_idx
  on notification_logs (venue_id, received_at desc);

create index if not exists notification_logs_failures_idx
  on notification_logs (venue_id, received_at desc) where parse_status = 'failed';

-- Finding 5: a silent listener looks exactly like a quiet evening.
create table if not exists device_heartbeats (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues(id) on delete cascade,
  device_label        text not null,
  battery_pct         int,
  notification_access boolean not null default false,
  queued_offline      int not null default 0,
  app_last_seen       jsonb,        -- { playo: iso8601, hudle: iso8601, ... }
  received_at         timestamptz not null default now()
);

create index if not exists device_heartbeats_recent_idx
  on device_heartbeats (venue_id, received_at desc);

-- ---------------------------------------------------------------- money

create table if not exists settlements (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues(id) on delete cascade,
  platform        platform_t not null,
  period_start    date not null,
  period_end      date not null,
  expected_paise  bigint not null default 0,
  received_paise  bigint,
  received_at     timestamptz,
  unique (venue_id, platform, period_start, period_end)
);

create table if not exists partners (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  name        text not null,
  role        text,
  share_type  text not null default 'percentage',  -- percentage | fixed
  share_value numeric(6,3) not null
);
