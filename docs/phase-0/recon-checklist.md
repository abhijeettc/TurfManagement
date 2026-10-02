# Technical recon checklist

Fill this in once per platform, on a real device, against a real venue. Four
platforms × the questions below. Budget four days; the write-back column is the
slow part.

Everything here feeds a decision that is already waiting on it, so record the
answer even when it is "no" — especially when it is "no".

---

## Setup, once

- [ ] Dedicated Android test device, not your personal phone
- [ ] All four partner apps installed and logged in as the venue
- [ ] `apps/android-spike` installed, notification access granted
- [ ] A friendly owner who will let you make and refund four real bookings
- [ ] mitmproxy on the laptop, device configured to trust it (for the app-only platforms)

---

## Per platform

Repeat for **Playo**, **KheloMore**, **Hudle**, **District**.

### Channel 1 — notifications

- [ ] Exact package name (`adb shell pm list packages | grep -i <platform>`)
- [ ] Does a confirmed booking fire a push at all?
- [ ] Does the text include the **court label**?
- [ ] Does it include the **date** and the **slot times**?
- [ ] Does it include the **customer name**? A **phone number**?
- [ ] Does it include a **booking id**? — this is what makes the dedupe key stable
- [ ] Does it include the **amount**? (Expect no.)
- [ ] Is the body in `android.text` or only in `android.bigText`?
- [ ] Does a **cancellation** fire a push too? — Phase 3's unblock depends on it
- [ ] Capture it: `node tools/capture.js --file <payload>.txt`

### Channel 2 — email

- [ ] Does the platform email the owner on a confirmed booking?
- [ ] Does the email carry the **gross amount**?
- [ ] Does it carry the **commission**, or only the net payout?
- [ ] Does it carry the same **booking id** as the notification? — this is what
      lets the two channels enrich one row instead of creating two
- [ ] How long after the booking does it arrive?
- [ ] Capture it: `node tools/capture.js --file <email>.txt --channel email`

### Channel 3 — write-back (Phase 3 feasibility)

- [ ] Is there a **web dashboard**, or is it app-only?
- [ ] Login: **OTP or password**? If OTP, to the owner's phone or email?
- [ ] How long does a session last before it forces re-auth?
- [ ] Find the **block-slot** request. Record: method, URL, headers, body shape.
- [ ] Find the **unblock** request.
- [ ] Is there a **read-calendar** endpoint? — needed for verification and the
      nightly reconciliation
- [ ] Does blocking a slot from the dashboard fire a notification to the app?
      — if yes, that is the echo loop, and confirms why `echo_expectations` exists
- [ ] Any obvious rate limiting or bot detection?

### Court naming

- [ ] Exactly how does this platform name each of the venue's courts?
      Write the strings down verbatim — they go straight into `court_mappings`.

---

## Then

```bash
node tools/recon.js
```

It prints the 4×3 channel matrix, what each channel actually carries, and
whether the ≥3-of-4 gate is met.

---

## The decisions waiting on this

| Finding | What it changes |
|---|---|
| A platform fires no notification | It becomes email-only. Latency goes from seconds to a minute for that platform. |
| No booking id in either channel | The dedupe key falls back to the slot hash + rebook sequence for that platform. Already implemented, but worth knowing. |
| Email omits the commission | That platform cannot be reconciled from our side. Either the owner exports a settlement report or the ±2% Phase 2 target excludes it. |
| App-only, no web dashboard | Write-back needs Appium against an emulator holding the venue session. Heavier infrastructure, same logic. |
| OTP login with a short session | The session-health monitor and the WhatsApp re-login flow move from "nice" to "required on day one of Phase 3". |
| Blocking fires a notification | Confirms the echo loop is real. The suppression is already built and running on every ingest. |
| Fewer than 3 platforms reachable | Stop. The unified board cannot be unified, and the product needs rethinking before any more code. |
