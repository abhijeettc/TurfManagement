# TurfSync Owner

The single highest-information experiment in Phase 0. It answers one question:

> **Do Playo, KheloMore, Hudle and District actually fire an Android push
> notification when a booking is confirmed, and does that notification contain
> enough text to identify the court, the slot and the customer?**

If yes, TurfSync is buildable as designed. If no, inbound email becomes the
primary channel, ingestion latency goes from seconds to a minute, and Phase 3
needs rethinking. Either way you want to know in week one.

This module is the installable owner app. It opens the authenticated TurfSync
board inside the phone: bookings, conflicts, money, setup, device heartbeat,
and parser status are all the same views as the web dashboard. The owner signs
in with their TurfSync account; no notification access or device token is
needed on the owner phone.

> **Not compiled or run.** The source was written without an Android SDK
> available, so treat it as a starting point that will need the usual
> first-build fixes — not as something known to work.
>
> **JDK 17 is installed** — Temurin 17.0.20.1, unpacked under
> `%LOCALAPPDATA%/Programs/jdk/`, with `JAVA_HOME` and `PATH` set for your user.
> It went in user-scope rather than through winget because a machine-wide
> install needs an elevation prompt nobody can click from a script.
> What is still missing is the Android SDK
> itself; the simplest route is to open this folder in Android Studio, which
> downloads the SDK and the Gradle wrapper for you.

---

## Build and install

Needs Android Studio (or a JDK 17 + the Android SDK) and a real device —
notification behaviour on an emulator is not evidence of anything, because the
partner apps have to actually receive pushes.

```bash
cd apps/android-spike
./gradlew installDebug
```

Then on the owner's device:

1. Open **TurfSync Owner**.
2. Enter the TurfSync server address.
3. Tap **Open TurfSync**.
4. Sign in with the owner's TurfSync account.

For a physical device, the API URL must use the laptop's LAN address, such as
`http://192.168.1.7:3000`, not `localhost`. The default `10.0.2.2` is for an
Android emulator reaching the host machine.

## Use it

1. Install all four partner apps and log in as the venue.
2. Make one real booking per platform on a friendly owner's venue. Refund each
   immediately.
3. Every notification any app posts is appended to:

   ```
   /Android/data/in.turfsync.spike/files/notifications.log
   ```

   Pull it off with:

   ```bash
   adb shell run-as in.turfsync.spike cat files/notifications.log > captured.log
   ```

4. Feed each payload into the corpus:

   ```bash
   node tools/capture.js --file captured-playo.txt
   node tools/recon.js
   ```

The counter/listener device remains a separate future companion. This APK is
for the owner dashboard and does not request notification-listener access.

## What to record

For each of the four platforms, the recon checklist in `docs/phase-0/` asks:

- Does a booking fire a notification at all?
- Does the text contain the court label, the date, the slot, the customer?
- Does it contain a booking id? (This is what makes the dedupe key stable.)
- Does it contain the amount? (Assume not — that is why email is mandatory.)
- Does a *cancellation* fire a notification too? (Phase 3's unblock depends on it.)
- What is the exact package name? Filtering by package is more reliable than
  filtering by text.

The package names are worth capturing precisely — put them in
`PARTNER_PACKAGES` and the production companion app can filter on them from
day one.
