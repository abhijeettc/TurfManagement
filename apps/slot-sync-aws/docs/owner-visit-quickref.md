# Owner visit — quick reference

Short version. Full detail (exact commands, field names, wording for the
owner) is in `owner-visit-checklist.md` in this same folder — open that one
at the venue. This page is just the shape of it at a glance.

## Tonight

1. Deploy the AWS stack into the owner's AWS account (`cdk bootstrap` +
   `cdk deploy`). Needs their account + you added as an IAM user already.
2. Create the device-token secret — a random string, write it down.
3. Grab the APK onto your laptop/USB:
   `apps/android-spike/app/build/outputs/apk/debug/app-debug.apk`.

## Tomorrow, at the venue, in order

1. Get **written consent** from the owner first.
2. Get **exact court names** from each platform's dashboard, enter them into
   the court-mapping table.
3. Set up **secrets** — IMAP inbox, Gupshup (or alerts never reach the
   owner), platform logins.
4. **Install and pair the tablet** — APK, notification access, API URL +
   device token, disable battery optimization.
5. **Test it** — book one slot on each platform, confirm a WhatsApp alert
   each time, then cancel all three.
6. Tell the owner honestly: alerts work today, automatic blocking doesn't
   yet — that needs another visit (see `enable-live-blocking.md`).
