# Partner outreach — asking for the thing that removes manual blocking

Three drafts, one per platform: [playo.md](playo.md), [hudle.md](hudle.md),
[khelomore.md](khelomore.md). Each asks the same two questions in order:

1. Is there a partner/developer API already (even a private one shared only
   with strategic partners — the public web search in `06-Multi-Platform-
   Channel-Sync.md` §2 found nothing, but that doesn't rule one out)?
2. If not, will the platform give **written consent** for a narrow,
   disclosed, audit-logged sync connector — read bookings, block/unblock a
   slot, nothing else?

That second question matters specifically because Playo's own terms carry a
clause for it ("without express written consent from TechMash") — this is
asking them to use their own escape hatch, not asking for an exception to a
rule that has none.

## Before sending: fill in the blanks

Each draft has `[bracketed placeholders]` — your name, a reachable phone
number, and the venue(s) you can point to. Replace those; don't send with
placeholders in.

## The honest gap: these go out weaker than the plan recommends

`06-Multi-Platform-Channel-Sync.md` §9.3 says the outreach should follow a
pilot: 5–10 multi-listed venues running on the safe approaches (notification
ingestion + assisted blocking + partitioning), with real numbers — bookings
synced, conflicts avoided, staff-minutes saved — attached to the ask. Right
now there's one venue (Pickle & Pitch Club) and no pilot data yet. These
drafts are honest about that rather than inventing numbers: they lead with
the *product* and the *ask*, not a traction claim that isn't real yet.

Two ways to use them:
- **Send now anyway.** A cold "do you have a partner program" question costs
  the platform nothing to answer and starts the clock on a reply that could
  take weeks. Nothing about it commits you to anything.
- **Wait for a small pilot first**, then resend with real numbers in place of
  the current second paragraph — that version lands harder, per the doc's own
  reasoning in §9.1 ("owner demand," "precedent," data-backed framing).

Doing both isn't wrong: send the discovery question now (it's cheap and slow
to get answered anyway), and follow up with numbers once you have them.

## Where to send them

- **KheloMore** — `info@khelomore.com` (listed publicly; no named BD contact
  found). Worth also checking khelomore.com/partnerships for a form.
- **Playo** — playo.co/partner-with-us has a partner signup flow; use it, and
  also try to find a BD/partnerships contact on LinkedIn (TechMash Solutions)
  for a warmer, person-addressed version of the same ask.
- **Hudle** — hudle.in/list-your-sports-venue is venue-signup, not BD, but is
  the most visible channel; same LinkedIn-contact suggestion applies (Hudle
  the company, not to be confused with Huddle or Hudl — see the doc's own
  warning in §2.1).

A message addressed to a real name at the company will get further than one
sent into a general inbox. Treat the general-inbox address as the fallback,
not the first move.

## What a reply actually unlocks

- **"Yes, here's our API"** → §9.2 of the research doc has the minimum
  capability list to ask for once that conversation starts (booking webhooks,
  block/unblock, availability read, court list, OAuth2).
- **"Yes, consent granted"** → `apps/api/src/blocking/adapter.js` already
  defines the interface a real adapter implements. One new class, no changes
  to the queue, state machine, or worker.
- **Silence or no** → nothing changes. The assisted-task flow (`sync_tasks`)
  keeps working exactly as it does today; this was never load-bearing for
  the product to function, only for it to eventually need less manual work.
