-- Short-lived pairing codes, so a venue owner never has to type a 43-character
-- device token into a phone.
--
-- The token itself does not change: /devices/claim still mints exactly what
-- POST /api/devices mints, and device_tokens stays the only thing the tablet
-- ever authenticates with. This is only a nicer way to hand one over.
--
-- Why a separate table rather than a column on device_tokens: the token is
-- created at claim time, not at code-generation time. device_tokens stores
-- only a hash and can never reveal a token again, so a row created up front
-- would have nothing to hand the tablet when it finally called in.
create table if not exists device_pairings (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  -- sha256 of the code, same helper as device_tokens. An 8-digit code is of
  -- course brute-forceable from a hash offline — the point is only that a
  -- database dump does not hand over codes that are still live, and they stop
  -- being live within minutes.
  code_hash   text not null,
  label       text,
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- There is deliberately no per-code attempt counter here. It would do nothing:
-- the code is the only lookup key, so a wrong guess matches no row and there is
-- nothing to count it against — and a guess that *does* match has already
-- succeeded. What actually bounds guessing is the combination of 10^8 codes, a
-- ten-minute life, single use, and the per-IP 'pair' policy in
-- apps/api/src/security/rateLimit.js. The entropy is sized for that: ten
-- guesses per address per fifteen minutes against a code that lives ten
-- minutes means covering the space needs an implausible number of addresses.

-- The claim path looks a code up by hash on every attempt.
create index if not exists device_pairings_code_idx on device_pairings (code_hash);

-- Sweeping expired rows is a plain range delete.
create index if not exists device_pairings_expiry_idx on device_pairings (expires_at);
