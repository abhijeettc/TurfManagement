# Draft: Hudle

Send via: hudle.in/list-your-sports-venue as a fallback channel, but strongly
prefer a named BD/partnerships contact found on LinkedIn — Hudle's terms
(§2.2 of `06-Multi-Platform-Channel-Sync.md`) explicitly call out "reverse
engineer... to build a competitive product" as prohibited, and TurfSync sits
close enough to that line that this draft addresses it head-on rather than
hoping it goes unnoticed. Transparency here is the safer move, not just the
more honest one — asking openly costs nothing; being found automating
without having asked costs the venue's listing.

---

**Subject: Inventory-sync tool for venues listed on Hudle and other platforms — asking before building further**

Hi [name],

I'm building TurfSync, a sync layer for sports-venue owners who list their
courts on more than one platform — Hudle, Playo, KheloMore, and their own
direct bookings — so the same slot doesn't get sold twice. Today it works
entirely by reading booking alerts the owner already receives on their own
phone and prompting staff to manually block the slot elsewhere; it does not
log into any partner dashboard automatically.

I want to be upfront about why I'm writing rather than just building further:
Hudle's terms prohibit automated access aimed at building a competing
product, and depending on how you read "competing," a sync tool sits close
enough to that line that I'd rather ask than assume. Two questions:

1. **Is there a partner or developer API** — public or private — that would
   let a sync tool read bookings and block/unblock a slot on a venue's
   behalf, with that venue's explicit authorization?

2. **If not, would Hudle consider written consent** for a narrow, disclosed
   integration — read-only booking visibility and block/unblock on one
   mapped court, rate-limited, fully audit-logged, opt-in per venue? I'd
   rather build this with your knowledge than without it.

To be clear about intent: this isn't a booking marketplace competing for
Hudle's players — venues keep listing and taking bookings on Hudle exactly as
they do now. The only thing TurfSync touches is keeping Hudle's own calendar
accurate when a slot sells somewhere else first, which should mean fewer
double-bookings and fewer support tickets on your side as well.

Open to a call if that's easier than email.

[Your name]
[Phone]
[Email]
TurfSync
