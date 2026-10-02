# TurfSync

Channel manager for Indian sports-turf venues. One unified calendar across Playo,
KheloMore, Hudle, District, and direct bookings.

**This repository is Phase 1: the read-only board, now multi-tenant.** Bookings from every platform
land on one screen. Nothing is written back to any marketplace yet — that is
Phase 3, and the plan is deliberate about not shipping it until a venue has run
read-only for two weeks at ≥98% parse accuracy.

---

## Run it

```bash
npm install
npm run setup      # starts Postgres in Docker, migrates, seeds a demo venue
npm run dev        # http://localhost:3000
```

`npm run setup` is `db:up` + `migrate` + `seed`. To wipe and start over:
`npm run db:reset`.

The seeded venue — Kickoff Arena, Bopal — opens on tonight's board with 19
bookings, one open double-booking, and a month of completed business behind it so
the money view aggregates real rows rather than displaying constants.

### Signing in

`npm run seed` prints three logins, all with the password `turfsync123`:

| Login | Role | Sees |
|---|---|---|
| `owner@kickoffarena.in` | owner | everything |
| `counter@kickoffarena.in` | staff | the board and conflicts — never the money or setup |
| `ruchi@kickoffarena.in` | partner | the money, read-only — never the board |

The three roles are drawn from how a turf actually runs rather than a generic
admin/user split. Staff work the counter at 9pm with a queue forming and have no
business seeing the venue's margins; a partner put money in and wants to verify
the numbers without touching the calendar.

Signing up at `/login.html` creates an account and its first venue together — an
account with no venue has no screen in this product that means anything — and
lands on the onboarding wizard at `/onboarding.html`.

Everything is scoped by membership. `resolveVenue()` used to return whichever
venue was first in the table, which was single-tenant by accident; it now proves
the signed-in account holds a role on the venue *and* that the role carries the
permission being used. A venue id in a query string or request body cannot
override that, and a venue you cannot see is reported identically to one that
does not exist — distinguishing them would let anyone enumerate real venue ids.

### Simulating the counter tablet

The Android companion does not exist yet. `tools/simulate.js` does its job —
POSTing notification text and heartbeats — so the whole ingest path can be
exercised without a device in the room:

```bash
node tools/simulate.js booking      # one booking, right now
node tools/simulate.js conflict     # two platforms sell the same slot
node tools/simulate.js drift        # a payload no template can read
node tools/simulate.js evening      # a burst — watch the board repaint live
node tools/simulate.js heartbeat    # a device check-in
```

Keep the board open while these run. It repaints over a WebSocket.

### Phase 0 — recon and validation

Phase 0 has not been done. Until it is, the parsers are written against payloads
we invented, so **parser accuracy is unknown, not high**, and the Phase 1 capture
gate cannot be claimed. The tooling for it lives in the repo:

```bash
npm run capture -- --file payload.txt   # redact a real payload into the corpus
npm run recon                           # the 4×3 channel matrix and what it means
npm run interview                       # record one owner interview
npm run gate                            # score the Phase 0 exit gate
```

- `apps/android-spike/` — the listener spike. One question: do the four partner
  apps actually fire a readable push on a confirmed booking?
- `docs/phase-0/recon-checklist.md` — what to record per platform, and what each
  answer changes downstream.
- `docs/phase-0/interview-script.md` — the counter-side script, including the
  phrases that mean stop.

`packages/parsers/fixtures/` is split deliberately: `invented.json` is regression
cover for the parsing machinery, `real.json` is evidence. Only the second one
counts, and the test suite is written so the first can never be mistaken for it.

### Tests

```bash
npm test
```

Pure unit tests run anywhere. The database tests skip themselves with a message
if Postgres is not up, so `npm test` stays useful on a laptop with nothing
running.

They run against their own database (`turfsync_test`, created on first run — see
`.env.test`) because they truncate between runs. Pointed at the dev database they
would silently delete the venue you were looking at.

---

## What is actually built

| Piece | State |
|---|---|
| Postgres schema, exclusion constraint, business-date model | done |
| Accounts, sessions, owner/staff/partner roles | done |
| Self-serve signup + onboarding wizard | done |
| Per-venue device tokens and inbound-email secrets | done |
| Notification ingest (Channel 1) | done |
| Inbound email ingest + money enrichment (Channel 2) | done |
| Versioned templates for all four platforms + fixture corpus | done |
| Claude Haiku fallback parser | done (needs `ANTHROPIC_API_KEY`) |
| Court mapping, dedupe, conflict detection | done |
| Counter entry for walk-ins and WhatsApp bookings | done |
| Live board, drawer, conflicts, money, setup | done |
| WebSocket fan-out | done |
| Device heartbeat + silent-listener watchdog | done |
| WhatsApp alerts | Gupshup provider done (needs `WHATSAPP_PROVIDER=gupshup`, Gupshup credentials, and 9 Meta-approved templates registered — see `.env.example`); logs to console otherwise |
| Session worker, block queue, write-back (Phase 3) | schema only, inert |
| Android companion (Kotlin) | not started — `tools/simulate.js` stands in |

---

## Layout

```
apps/
  api/     Fastify — ingest, REST, WebSocket, watchdog
    src/ingest/pipeline.js    the nine-step pipeline; start here
    src/auth/guard.js         who may touch which venue; start here for tenancy
  web/     the board, login and onboarding (static; see "Why not Next.js yet")
  android-spike/  the Phase 0 listener experiment (Kotlin, uncompiled)
packages/
  core/    canonical types, slot arithmetic, money, dedupe
  parsers/ per-platform templates + fixture corpus + Haiku fallback
  db/      schema, migrations, seed
tools/     simulate.js — stands in for the Android companion
test/
```

---

## The five corrections

The build plan identified five places where the product spec breaks in
production. All five are implemented and covered by tests in `test/db.test.js`.

**1 — Our own blocks come back in as bookings.** Blocking 19:00 on Hudle makes
Hudle's app fire a notification, which the listener ingests as a fresh booking,
which enqueues blocks on the other three platforms. `echo_expectations` claims
the payload before it becomes a booking. Phase 1 writes no expectations (nothing
blocks yet) but the check runs on every ingest from day one, so Phase 3 cannot
ship without it.

**2 — The idempotency key collides on resold slots.** The spec's
`sha256(platform + court + date + start)` is identical for a cancelled booking
and its replacement, so the upsert eats the cancellation. We prefer the
platform's own booking id, and fall back to a slot hash with a rebook sequence.
That preference is also what lets the notification and the confirmation email
enrich one row instead of racing to create two.

**3 — The overlap constraint turns a real conflict into a 500.** A genuine
double-booking is exactly what violates `EXCLUDE USING gist`. Every ingest insert
runs in a savepoint; on SQLSTATE `23P01` the booking is stored as `conflicted`
(outside the partial index), a conflict row is opened holding both claimants, and
the owner is alerted. The constraint detects; it never rejects.

**4 — Email is not a backup channel.** Push notifications carry who and when;
they almost never carry commission. Phase 2 is priced on ±2% reconciliation
accuracy, so inbound email is mandatory at onboarding, not optional.

**5 — A silent listener looks exactly like a quiet evening.** The device
heartbeats every five minutes with battery, notification-access status and
per-app last-seen. `watchdog.js` alerts on twenty minutes of silence during
opening hours. Capture rate is meaningless without liveness.

---

## Decisions worth knowing

**Money is paise, always an integer.** Rupees exist only at the edges. Note that
`sum()` over a `bigint` returns `NUMERIC`, which `pg` hands back as a *string* —
`packages/db/src/pool.js` registers parsers for both, or totals silently
concatenate instead of adding.

**`business_date` is written by the normalizer, never generated.** `at time zone`
is STABLE, not IMMUTABLE, so Postgres rejects it in a `GENERATED` column. A slot
starting at 01:30 belongs to the previous evening's business.

**Slots are absolute instants in a `tstzrange`.** Cross-midnight needs no special
case: 23:00→01:00 is one contiguous range like any other. The exclusion
constraint handles it for free — see the first test in `test/db.test.js`.

**IST is a fixed +05:30 with no DST,** so `packages/core/src/time.js` is integer
minute arithmetic rather than a timezone library. `venue.timezone` is still
stored; the day a venue outside IST onboards, only that file changes.

**The board's axis is 16:00–02:00,** the traded evening. Bookings outside it are
still counted in the day's totals — they just have nowhere to be drawn.

### Deviations from the plan, and why

- **npm workspaces, not pnpm.** Same layout, one fewer thing to install.
- **Plain ESM JavaScript, not TypeScript.** No build step: `node` runs the repo
  as-is. Worth revisiting when a second engineer joins.
- **Raw SQL and `pg`, not Drizzle.** The exclusion constraint, partial indexes,
  and savepoint/`23P01` handling all sit outside Drizzle's expressive core, and
  the schema is the part of this system most worth reading as SQL.
- **Static page, not Next.js.** The board is one page, and serving it statically
  keeps the design prototype's markup and CSS byte-for-byte intact. Next.js earns
  its place when there is a second route worth server-rendering — the partner
  dashboard, or the Phase 5 booking page.
- **No Redis or BullMQ yet.** A read-only venue produces no block jobs by
  construction, so there is nothing to queue until Phase 3.

---

## Configuration

Copy `.env.example` to `.env`. Everything has a working dev default except the
Anthropic key.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres. Host port 5434, to avoid colliding with other local instances. |
| `DEVICE_TOKEN` | Shared secret the companion app sends as `X-Device-Token`. |
| `INBOUND_EMAIL_TOKEN` | Postmark/Mailgun inbound webhook auth. |
| `ANTHROPIC_API_KEY` | Enables the fallback parser. Unset, an unreadable payload is logged as a parse failure instead of guessed at — which is the right behaviour locally. |
| `PARSER_FALLBACK_MODEL` | Defaults to `claude-haiku-4-5`. |

---

## Next

1. The Kotlin companion app — `NotificationListenerService`, foreground service,
   QR pairing, offline queue, heartbeat. The one piece worth contracting out.
2. Phase 0 recon on all four platforms: does each fire a push notification, does
   each email carry the amount, what does the block-slot request look like.
3. Run a venue read-only for two weeks and measure capture nightly against the
   owner's own count. That number is the Phase 1 gate, and it cannot be computed
   from our own data without being circular.
