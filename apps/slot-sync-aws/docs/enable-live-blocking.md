# Enabling live blocking — one venue, one checklist

Right now this system detects a booking and alerts correctly, but every
block *action* fails with `ADAPTER_NEEDS_CODEGEN` — nobody has ever logged
into Hudle's, Playo's, or KheloMore's real partner panel from this codebase
and recorded what clicking "Block" actually does. This checklist is
everything that has to happen, in the owner's own systems, to close that gap
for one venue. Do it once per platform; a second venue on the same platform
does not repeat the codegen steps, only the account/secrets ones.

Work through it top to bottom. Nothing here is optional if you want real
auto-block instead of "detect + tell the owner to block it by hand."

---

## 0. Before you start

- [ ] Written consent captured from the owner (automated blocking, ToS risk
      acknowledged). See `README.md`'s top section — this project's default
      posture is *not* to automate without it; you decided otherwise for this
      venue, on the record.
- [ ] `cdk deploy` has run at least once into the owner's own AWS account
      (see `README.md` → *Deploying*). Note the `IngestUrl`, `EventsTableName`,
      `CourtMappingTableName`, `SessionsBucketName`, `BlockQueueUrl` outputs —
      you'll reference them below.

---

## 1. Secrets — in the owner's AWS account, not yours

Real values, not placeholders — blocking reads these for real now.

- [ ] `turfsync/<venue>/hudle` → `{"email": "...", "password": "..."}`
- [ ] `turfsync/<venue>/playo` → `{"email": "...", "password": "..."}`
- [ ] `turfsync/<venue>/khelomore` → `{"email": "...", "password": "..."}`
- [ ] `turfsync/<venue>/device-token` → `{"token": "..."}` (already needed for
      detection; confirm it's there)
- [ ] `turfsync/<venue>/imap` → `{"host", "port", "user", "pass"}` for the
      booking inbox (email backup channel)
- [ ] `turfsync/<venue>/gupshup` → real Gupshup credentials, **and**
      `WHATSAPP_PROVIDER=gupshup` set on the ingest / email-poller / block-worker
      / health-check / dlq-alert Lambdas. Left as `console` (the default),
      every alert only reaches CloudWatch logs — the owner sees nothing. This
      is the single most common thing people forget, because local testing
      hides it (console alerts print right in your terminal).
  - [ ] Register all 6 templates this system sends in the Gupshup dashboard —
        `block_succeeded`, `block_failed`, `already_booked`, `parse_failure`,
        `health_check_failed`, `tablet_silent` — and put their ids in
        `templateIds` inside the secret (see `src/lib/alerts.mjs`'s
        `TEMPLATES` object for the exact copy each one sends).
- [ ] **Ideally**, a dedicated staff login on each platform, not the owner's
      own — so the owner changing their personal password doesn't silently
      break blocking, and access can be revoked independently. Doc's own
      recommendation; not enforced by any code here.

## 2. Court mapping — real court names, per platform

- [ ] In `slot-sync-<venue>-court-mapping` (DynamoDB), one row per physical
      court: `canonicalCourt`, plus that court's exact name as it appears on
      each platform's own dashboard, plus `enabledPlatforms` and
      `slotMinutes`. Get these by actually logging into each platform's
      partner app/dashboard with the owner present — typed-from-memory court
      names will not match and the court will silently never sync
      (`courtMapping.mjs`'s `findByExternalLabel` is an exact
      case/whitespace-insensitive match, not fuzzy).
- [ ] Confirm slot start times and durations are aligned across all three
      platforms with the owner — a mismatched grid breaks matching even with
      correct court names.

## 3. Per-platform adapter — repeat for each of hudle / playo / khelomore

This is the actual gap. Each of `src/lib/adapters/{hudle,playo,khelomore}.mjs`
throws `ADAPTER_NEEDS_CODEGEN` at every method. You're replacing that with
real Playwright steps, recorded against a REAL logged-in session — there is
no way to do this without actually being logged into that platform's real
panel, which means doing it either on-site with the owner or over a
screen-share where they log in.

- [ ] **Find the real panel URL.** `docs/partner-outreach/*.md` in the repo
      root has what's known so far — for Hudle it's a guess
      (`partner.hudle.in`, unconfirmed for this purpose); for Playo and
      KheloMore there's no confirmed URL at all. Ask the platform's own
      support, or inspect the partner app's network traffic
      (`com.hudle.partner.app` / `com.techmash.playobooking` /
      `com.khelomore.pnp.vendor` — package names from
      `apps/android-spike/.../PlatformApps.kt`).
- [ ] **Passive recon before logging in** — costs nothing, no login, no
      action, so do it the moment you have a candidate URL:
      ```bash
      curl -sI --max-time 10 <panel URL> | grep -iE "cf-ray|datadome|perimeterx|akamai|__cf_bm|_px|ak_bmsc"
      curl -s --max-time 10 <panel URL> | grep -iE "datadome|perimeterx|cloudflare|akamai"
      ```
      A hit on either means enterprise bot detection is plausibly in play —
      doesn't prove it'll flag a scripted login, but raises the bar before
      you find out the hard way. Also just read the page source: Hudle's
      `partner.hudle.in` turned out to be a Flutter web app (canvas-rendered,
      likely no real DOM for Playwright's role/text selectors to find) — a
      feasibility problem distinct from bot detection, and one you want to
      know about before, not after, a codegen session. See the note at the
      top of `src/lib/adapters/hudle.mjs` for what was found there.
- [ ] **Record login + block + unblock with codegen:**
      ```bash
      cd apps/slot-sync-aws
      npx playwright codegen <panel URL>
      ```
      This opens two windows: a real Chromium browser (where you act, logged
      in as the owner) and the **Playwright Inspector** (shows the generated
      code live as you click). In the browser: log in with the owner's real
      credentials → navigate to the slot grid → click a genuinely free slot
      → click "Block" → click "Unblock"/"Release" → stop recording. The
      Inspector now holds real code, e.g.:
      ```js
      await page.getByLabel('Email').fill('owner@example.com');
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByRole('cell', { name: '7:00 PM' }).click();
      await page.getByRole('button', { name: 'Block' }).click();
      ```
      Note whether OTP was required — if it was, this platform can't run
      unattended in a Lambda at all; it needs **alert-only mode** instead
      (see §5).
- [ ] **Copy the generated lines into the adapter file**, method by method,
      replacing each `needsCodegen(...)` call — swap the specific court/date/
      time you clicked for the `slot` argument, and the typed credentials for
      `creds.email`/`creds.password` from `getSecretJson(...)`:
  - `login(page)` — the recorded email/password/submit steps. Fetch
    credentials via `getSecretJson(process.env.<PLATFORM>_CREDENTIALS_SECRET_ID)`
    first (the TODO comment in each file already shows the exact call).
  - `isLoggedIn(page)` and `getSlotState(page, slot)` are *reads*, not
    actions — codegen won't give you these, since it only records clicks.
    Right-click → Inspect (DevTools) on a free slot, a booked slot, and a
    blocked slot and note what actually differs (a class name, a color, a
    tooltip, an ARIA label) — that's what the function checks. Same idea for
    `isLoggedIn`: find something only present once authenticated (a
    venue-name header, a logout button) and check for it.
  - `getSlotState` also needs to navigate to the grid for `slot.date` first —
    check whether the platform supports a direct date URL or only
    click-through, since that materially affects how fast/reliable this
    method is.
  - `blockSlot(page, slot)` — the recorded block action. Must be safe to call
    twice (idempotent) — calling it on an already-blocked slot should not
    error.
  - `unblockSlot(page, slot)` — the recorded release action.
  - `healthCheck(page)` — usually just `login` + `getSlotState`'s navigation
    step, nothing more.
  - Prefer `page.getByRole(...)` / `page.getByText(...)` over CSS classes —
    they survive a redesign; classes don't.
- [ ] **Test that one adapter for real** with `tools/test-adapter-live.mjs` —
      it uses your real adapter code (not `MockAdapter`) against a real
      visible browser, while still pulling credentials from LocalStack so you
      don't need a real AWS deploy just to test one platform:
      ```bash
      npm run local:up   # once, if LocalStack isn't already running
      node tools/set-local-secret.mjs turfsync/local/hudle '{"email":"...","password":"..."}'
      node tools/test-adapter-live.mjs hudle "Football Court 1" 2026-10-15 19:00 20:00
      ```
      This runs read-only (`isLoggedIn` → `login` if needed → `getSlotState`)
      and leaves the browser open so you can see exactly what state it ended
      in. Once that passes, add `--block` to also block, re-check state,
      unblock, and re-check again — only against a slot you know is
      genuinely free and have told the owner you're testing, since it's a
      real write to their real calendar. `npm run local:test` won't exercise
      this — it forces `MockAdapter` by design.
- [ ] Repeat this whole section for the other two platforms.

## 4. Turn it on

- [ ] Confirm the deployed block-worker Lambda's environment does **not**
      have `ADAPTER_MOCK=1` set (the CDK stack never sets it, so this should
      already be true — just don't add it by hand while debugging and forget
      to remove it).
- [ ] Book one real slot on each platform, confirm it actually blocks on the
      other two (not just an alert saying it will) — check the target
      platform's own dashboard with your own eyes, and check
      `sessions/<platform>.json` and a fresh `proof/<date>/...png` landed in
      the `SessionsBucketName` S3 bucket.
- [ ] Cancel all three test bookings.
- [ ] Watch the daily `health-check` Lambda's CloudWatch logs for the first
      few real days — a broken login or a platform UI change shows up there
      first, before an owner ever notices a missed block.

## 5. When a platform can't be automated

If a platform requires OTP on every login, or you can't get consistent
selectors, or the owner doesn't want that specific platform automated —
leave its adapter throwing. The pipeline already degrades correctly: the
block job retries, exhausts retries, lands in the DLQ, and `dlq-alert` tells
the owner to block it by hand for that one platform — functionally identical
to `apps/api`'s assisted-blocking design, just scoped to one platform instead
of all three. Nothing else needs to change.
