# Draft: KheloMore

Send to: `info@khelomore.com` (publicly listed). Also worth checking
khelomore.com/partnerships for a submission form, though that page targets
coaching/tournament/event partners, not software integrations, per
`06-Multi-Platform-Channel-Sync.md` §2.1.

KheloMore's terms page couldn't be retrieved (JavaScript-rendered, per the
research doc) — this draft doesn't assume a specific clause the way the
Playo and Hudle ones do, and asks KheloMore to point to whatever their
actual policy is rather than guessing at it.

---

**Subject: Inventory-sync integration for venues listed on KheloMore — API availability and access permission**

Hi,

I'm building TurfSync, a tool for sports-venue owners who list on multiple
booking platforms — KheloMore, Playo, Hudle, and their own direct bookings —
to stop the same court slot from being sold twice across them. It currently
works by reading the booking alerts the owner already receives, and
prompting staff to manually block a slot on the other platforms when one
sells. It does not log into any partner dashboard automatically today.

Two questions before I build anything closer to KheloMore's systems:

1. **Does KheloMore have a partner or developer API** — public or private —
   that would let a sync tool read a venue's bookings and block/unblock a
   slot on their behalf, with the venue's own authorization?

2. **If not, does KheloMore have a policy on automated access on a venue's
   behalf**, and would you consider written permission for a narrow,
   disclosed integration — read-only booking visibility and block/unblock on
   one mapped court, rate-limited, fully audit-logged, opt-in per venue? I
   wasn't able to find KheloMore's terms of service to check this myself, so
   I'd rather ask directly than assume either way.

This is an inventory-sync layer, not a competing booking marketplace — venues
keep taking bookings through KheloMore exactly as they do now. The aim is
fewer double-bookings and fewer refund/support situations caused by a slot
selling on two platforms at once, which should help on your side as much as
the venue's.

Happy to share more on the design, or talk it through on a call.

[Your name]
[Phone]
[Email]
TurfSync
