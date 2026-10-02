# TurfSync Slot Sync (AWS)

A second, independent write-back system, alongside — not instead of —
`apps/api`'s Postgres/Fastify/BullMQ assisted-blocking flow. That system asks
a human to tap "Done" after blocking a slot themselves, because Playo's and
Hudle's terms require written consent (or ban it outright) for automated
dashboard access; see `apps/api/src/blocking/adapter.js`.

This system automates it instead: Lambda drives a real headless browser
against each platform's own partner panel, using the venue owner's own
credentials. **That is a deliberate, accepted deviation from the caution
`apps/api` was built with** — the owner has chosen to take on the ToS /
account-suspension risk that entails. Read `docs/partner-outreach/*.md` in
the repo root before turning any adapter on for a real venue.

## Architecture

```
booking on any platform
  -> tablet (WhatsApp listener) or email-poller
  -> ingest Lambda: parse, echo-check, dedupe, court-map, fan out
  -> one SQS message per other enabled platform
  -> block-worker Lambda: Playwright login, check slot state, block, verify, screenshot
  -> WhatsApp alert (success, failure, or "already booked elsewhere")
```

Detection is WhatsApp text (via the same tablet listener already written at
`apps/android-spike`), not raw partner-app push notifications — see the plan
note on why: a real capture found bookings arrive as WhatsApp Business
messages, not readable partner-app pushes. The ingest Lambda's wire contract
(`POST {url}/ingest/notification`, header `X-Device-Token`) matches the
Android app's existing `IngestClient`, so pointing the tablet here instead of
(or as well as) the Fastify app is a config change, not a code change.

## Reused from the rest of the monorepo

- `@turfsync/core` — canonical booking shape, slot arithmetic, dedupe-key
  derivation. Pure functions, no changes needed.
- `@turfsync/parsers` — per-platform WhatsApp/email templates + Claude Haiku
  fallback. Needs `ANTHROPIC_API_KEY` in the ingest Lambda's environment for
  the fallback path to work; left unset it fails loudly instead of guessing,
  same as the rest of the repo.
- Patterns mirrored, not imported (`apps/api/src` isn't a workspace package):
  echo-suppression (`ingest/echo.js`), session envelope encryption
  (`blocking/crypto.js`), the WhatsApp template/provider pattern
  (`notify.js`).

## What's real vs. what needs filling in

The pipeline — ingest, dedupe, echo-suppression, court mapping, fan-out,
queueing, retries, alerting — is real and runs today against `MockAdapter`.

The three platform adapters (`src/lib/adapters/{hudle,playo,khelomore}.mjs`)
are **not**. `docs/partner-outreach/*.md` and `docs/phase-0/recon-checklist.md`
confirm nobody has actually logged into any of these three partner panels and
watched a block-slot request happen — the panel URLs, login flows and OTP
requirements are all unconfirmed. Each adapter method throws
`ADAPTER_NEEDS_CODEGEN` at the exact point a real selector is needed, with the
`npx playwright codegen <url>` command to run to fill it in. This is the doc's
own prescribed process, not a shortcut — nobody can write a correct selector
for a page they haven't seen.

**`docs/enable-live-blocking.md`** is the step-by-step checklist for closing
that gap for one real venue — secrets, court mapping, and the codegen work
for each platform, in order.

## Testing locally — no AWS account needed

`docker-compose.yml` runs [LocalStack](https://localstack.cloud) (a local
stand-in for DynamoDB, S3, SQS and Secrets Manager) so the whole pipeline —
parse, dedupe, echo-suppression, court-mapping, fan-out, the block-worker's
block/verify/alert logic — runs and can be watched end to end, with
`ADAPTER_MOCK=1` swapping in `MockAdapter` so nothing tries to reach a real
platform.

```bash
cd apps/slot-sync-aws
npx playwright install chromium   # once — the local run still uses a real
                                   # headless page for the screenshot step
npm run local:up                  # starts LocalStack, creates the tables/
                                   # bucket/queues/secret, seeds one court
npm run local:test                # runs the pipeline end to end, prints
                                   # every step
npm run local:down                # tears LocalStack down when you're done
```

`tools/local-run.mjs` replays a genuine captured WhatsApp booking (the same
one in `packages/parsers/fixtures/real.json`) through `ingestPayload`, shows
it fan out to the other two platforms' SQS jobs, re-sends the identical text
to prove dedupe catches the repeat, then drains the queue and runs each job
through the real `runBlockJob` orchestration (session load, slot-state check,
block, verify, screenshot, DynamoDB update, WhatsApp alert) against
`MockAdapter`. A clean run ends with two `block_succeeded` alerts logged to
the console.

This proves the pipeline's own logic is correct. It does **not** prove any
platform adapter works — that's the one thing local testing can't cover; see
"What's real vs. what needs filling in" above.

## Deploying — one stack per owner's own AWS account

Per the doc's own design goal ("run entirely in the owner's AWS account"):
**every venue deploys this stack into that venue owner's own AWS account**,
under that owner's own credentials — never a shared account holding every
venue's platform passwords and browser sessions in one place. `infra/bin/app.mjs`
never hardcodes an account; `env.account`/`env.region` come from
`CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`, which the CDK CLI fills in from
whatever AWS credentials are active when you run it — an AWS named profile is
the natural way to switch between owners:

```bash
# One-time, per person who runs deploys: register each owner's account.
aws configure --profile turf-<venue-slug>          # access key, or...
aws sso login --profile turf-<venue-slug>           # ...SSO, if the owner set that up

cd apps/slot-sync-aws
npm install   # from repo root, via workspaces

# One-time per (account, region): CDK's own deploy infrastructure.
npx cdk bootstrap --profile turf-<venue-slug> \
  --app "node infra/bin/app.mjs" -c venueSlug=<venue-slug>

# Validate the template without touching AWS:
npx cdk synth --app "node infra/bin/app.mjs" -o infra/cdk.out \
  -c venueSlug=<venue-slug> -c enabledPlatforms=hudle,playo,khelomore -c alertPhone=+91...

# Deploy into that owner's account:
npx cdk deploy --profile turf-<venue-slug> \
  --app "node infra/bin/app.mjs" \
  -c venueSlug=<venue-slug> -c enabledPlatforms=hudle,playo,khelomore -c alertPhone=+91...
```

Nothing in this package ever needs credentials for more than one AWS account
at a time — the stack, the Lambdas, and every secret it reads are scoped to
whichever account `--profile` points at for that command. Running this for a
second venue is the same four commands again with a different `--profile` and
`-c venueSlug=`.

After `cdk deploy`, create these secrets by hand in that same owner's account
before turning anything on:

- `turfsync/<venue>/hudle`, `turfsync/<venue>/playo`, `turfsync/<venue>/khelomore`
  — `{ "email": "...", "password": "..." }` per platform.
- `turfsync/<venue>/device-token` — `{ "token": "..." }`, matching the
  `X-Device-Token` the tablet sends.
- `turfsync/<venue>/imap` — `{ "host", "port", "user", "pass" }` for the
  booking inbox.
- `turfsync/<venue>/gupshup` — Gupshup WhatsApp credentials, only if
  `WHATSAPP_PROVIDER=gupshup` (otherwise alerts just log).

Then, for each platform you want live: run
`npx playwright codegen <panel URL>` against a real logged-in session and fill
in that platform's adapter file. Until that's done, `block-worker` will retry,
exhaust its retries, land in the DLQ, and `dlq-alert` will tell the owner to
block that slot by hand — the pipeline degrades to exactly the "alert-only
mode" the doc describes, never a silent no-op.

## Current scope: TurfPro only

Only one platform is a live block **target** right now: the TurfPro venue-owner
panel (`http://turfpro.local`, `src/lib/adapters/turfpro.mjs`). Hudle, Playo and
KheloMore adapters are unregistered in `registry.mjs`, so no job can drive
them (`ADAPTER_UNKNOWN`); their WhatsApp messages are still parsed as booking
**sources**. Default `enabledPlatforms` is `turfpro`.

Flow: a player books on any source platform -> WhatsApp message reaches the
tablet -> ingest Lambda parses/dedupes -> one SQS job for `turfpro` ->
block-worker Playwright logs into TurfPro as the venue owner and blocks the slot.

Court mapping rows need a `turfpro` attribute (the court's exact name in the
TurfPro panel) and `enabledPlatforms: ['turfpro']`.

Verify the adapter against the real panel (selectors are unrecorded guesses —
see the header of `turfpro.mjs`):

```bash
node tools/set-local-secret.mjs turfsync/local/turfpro '{"email":"...","password":"..."}'
node tools/test-adapter-live.mjs turfpro "Turf A" 2026-10-15 19:00 20:00 --block
```

Deployed Lambdas run in AWS and cannot resolve a LAN name like `turfpro.local`;
a real deploy needs `TURFPRO_URL` set to a publicly reachable address.

## Local dashboard + saved logins

```bash
node apps/slot-sync-aws/tools/gen-worker-key.mjs   # once: the worker's key pair (.keys/, gitignored)
node tools/local-setup.mjs reset                   # wipes the dashboard DB — no demo data (stop the dashboard first)
node tools/dev-local.mjs                           # dashboard on :3001 (TurfPro itself uses :3000)
node tools/local-setup.mjs venue                   # one empty venue, two grounds, tablet paired; prints the owner login
cd apps/slot-sync-aws && npm run local:up
REAL_ADAPTER=1 npm run local:server                # tablet-facing address :8787 + the block worker
```

Platform logins are saved under Setup → App logins. They are sealed with the
worker's **public** key (`apps/api/src/credentials/seal.js`) and opened only
by the worker's private key (`src/lib/credentialVault.mjs`) at the moment of
login, so the dashboard, the database and an administrator cannot read them;
they can only be replaced or removed. Every use is written to Setup → Login
activity (action and context, never the login). In AWS, hold the private key in
KMS (`WORKER_KMS_KEY_ID`) — that path is written to the KMS API but not yet
exercised against real AWS.
