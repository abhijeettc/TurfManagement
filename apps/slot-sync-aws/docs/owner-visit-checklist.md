# Owner visit checklist

One file for tomorrow. Realistic scope for a first visit: get detection +
alerting fully working (booking on any platform → owner gets a WhatsApp alert
within seconds, and a "please block it manually" nudge). **Real automated
blocking is a separate, later step** — see the last section — because it
needs `playwright codegen` work per platform that can't honestly be rushed
in one sitting.

---

## Tonight, before you leave

- [ ] `cdk bootstrap` + `cdk deploy` this venue's stack into the owner's own
      AWS account (needs their account created + you added as an IAM user
      with MFA beforehand — do this over a call tonight if it isn't done).
      Note the `IngestUrl` output.
- [ ] Create the `turfsync/<venue>/device-token` secret — pick a random
      token now, write it down, you'll type it into the tablet tomorrow.
- [ ] Confirm the APK is built and on your laptop/USB:
      `apps/android-spike/app/build/outputs/apk/debug/app-debug.apk`.
- [ ] Bring: laptop, USB cable, the device token you generated, this file.

---

## At the venue, in order

### 1. Consent (do this before touching anything else)
- [ ] Owner signs written consent for automated blocking and acknowledges
      the platform-policy risk (possible account suspension on Hudle/Playo/
      KheloMore for automation — see `apps/slot-sync-aws/README.md`'s top
      section for why that risk is real).

### 2. Platform housekeeping
- [ ] Confirm slot start times/durations match across Hudle, Playo,
      KheloMore. Mismatches break matching even with everything else right.
- [ ] Log into each platform's partner app/dashboard with the owner and
      write down every court's *exact* name on each platform (copy-paste or
      screenshot, don't retype from memory — the match is exact, not fuzzy).
      Enter these as one row per court in the `court_mapping` DynamoDB table
      (`canonicalCourt`, `hudle`, `playo`, `khelomore`, `enabledPlatforms`,
      `slotMinutes`).

### 3. Secrets (AWS Secrets Manager, in the owner's account)
- [ ] `turfsync/<venue>/imap` — IMAP host/port/user/pass for the inbox that
      will receive booking emails (backup channel).
- [ ] Set up a Gmail filter forwarding booking emails from all three
      platforms to that inbox.
- [ ] `turfsync/<venue>/gupshup` — real Gupshup WhatsApp credentials, **and**
      set `WHATSAPP_PROVIDER=gupshup` on the Lambdas. Skip this and every
      alert only reaches CloudWatch logs — the owner sees nothing. If Gupshup
      isn't set up yet, it's fine to leave as `console` for today and come
      back to this — just tell the owner alerts aren't live yet.
- [ ] `turfsync/<venue>/hudle`, `/playo`, `/khelomore` — capture real logins
      now even though blocking can't use them yet (see the last section).
      Ideally a dedicated staff login per platform, not the owner's personal
      one.

### 4. The tablet
- [ ] Install the APK: `adb install app-debug.apk` (device connected, USB
      debugging on).
- [ ] Open **TurfSync Owner** — it auto-opens the pairing screen.
- [ ] API URL = the `IngestUrl` from tonight's deploy. Device token = the one
      you generated.
- [ ] Tap **Grant Access** → enable TurfSync Owner in notification-listener
      settings.
- [ ] Tap **Save** — it fires a test heartbeat to confirm the URL/token work.
- [ ] Confirm WhatsApp is installed and signed into the number that actually
      receives the platforms' booking messages.
- [ ] Settings → Battery → exclude TurfSync Owner from battery optimization.
- [ ] Leave it powered, charged, connected.

### 5. Live test
- [ ] Book one real slot on each platform. Confirm the owner gets a WhatsApp
      alert for each within seconds.
- [ ] Cancel all three test bookings.

---

## What to tell the owner, in plain words

*"Right now, when a booking comes in on any platform, you'll get a WhatsApp
message immediately telling you which slot got booked and which other
platforms to go block it on by hand. That part works today. Automatic
blocking — where the system logs in and blocks it for you — needs one more
round of setup per platform before it's live; I'll be back for that once
[Hudle/Playo/KheloMore] is ready."*

Do not promise automatic blocking is live today. It isn't, and the honest
version of this system is strictly better than an oversold one that quietly
fails.

---

## After today — getting real blocking working

Not for tomorrow. Once you're back at a desk, work through
`apps/slot-sync-aws/docs/enable-live-blocking.md` — the `playwright codegen`
session per platform, filling in `src/lib/adapters/{hudle,playo,khelomore}.mjs`,
and testing each one for real with `tools/test-adapter-live.mjs` before
trusting it against the owner's actual calendar.
