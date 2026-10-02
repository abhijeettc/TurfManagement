-- Accounts, roles and sessions.
--
-- The data model was already multi-tenant: every table carries venue_id. What
-- was missing was any way to say WHICH venue a request is allowed to touch.
-- Until now resolveVenue() returned whichever venue was first in the table,
-- which is single-tenant by accident rather than by design.

-- ---------------------------------------------------------------- accounts

create table if not exists accounts (
  id            uuid primary key default gen_random_uuid(),
  -- Stored lowercased. A case-insensitive unique index would need citext;
  -- normalising on write is one line in the app and no extension in the DB.
  email         text not null,
  password_hash text,
  name          text,
  phone         text,
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,

  constraint accounts_email_uniq  unique (email),
  constraint accounts_email_lower check (email = lower(email))
);

-- ---------------------------------------------------------------- membership

do $$ begin
  create type venue_role_t as enum ('owner','staff','partner');
exception when duplicate_object then null; end $$;

-- One account can hold several venues (a chain owner), and one venue can be
-- held by several accounts with different roles (the owner, the counter staff,
-- and the silent partners who only ever see the money).
create table if not exists account_venues (
  account_id uuid not null references accounts(id) on delete cascade,
  venue_id   uuid not null references venues(id)   on delete cascade,
  role       venue_role_t not null,
  created_at timestamptz not null default now(),
  primary key (account_id, venue_id)
);

create index if not exists account_venues_venue_idx on account_venues (venue_id);

-- A partner row can now point at a login, so the read-only partner dashboard
-- shows that partner their own split and nothing else.
alter table partners add column if not exists account_id uuid references accounts(id) on delete set null;

-- ---------------------------------------------------------------- sessions

-- Opaque tokens. Only the SHA-256 of the token is stored, so a database dump
-- does not hand over live sessions.
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  user_agent   text,
  ip           text
);

create index if not exists sessions_account_idx on sessions (account_id);
create index if not exists sessions_expiry_idx  on sessions (expires_at);

-- ---------------------------------------------------------------- devices

-- Replaces the single shared DEVICE_TOKEN env var. With more than one venue on
-- the install, a shared secret cannot say which venue a notification came from
-- — and any counter tablet could post into any venue's board.
create table if not exists device_tokens (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues(id) on delete cascade,
  label        text not null default 'Counter tablet',
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  paired_at    timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz
);

create index if not exists device_tokens_venue_idx on device_tokens (venue_id) where revoked_at is null;

-- Same idea for inbound email: venue-{id}@in.turfsync.in already routes per
-- venue, but nothing verified the sender. This gives each venue its own secret
-- for the webhook to present.
alter table venues add column if not exists inbound_secret text;
