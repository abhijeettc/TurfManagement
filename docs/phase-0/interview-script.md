# Owner interview script

15 owners. Ahmedabad and Gandhinagar. **At their counter, during evening peak** —
not on the phone, not over coffee. The whole point is to watch the manual
blocking happen rather than hear it described.

Budget eight days. Record each one with `node tools/interview.js`.

---

## Rules

**Time it, do not ask for it.** "How long does blocking take you?" gets you an
estimate shaped by how annoyed they are. Sit there with a stopwatch during three
bookings and take the median. The number you want is minutes per day, and the
only honest way to get it is to multiply an observed per-booking time by an
observed booking count.

**Do not pitch until the end.** The moment they know you are selling a sync
tool, every answer bends toward the sale. Say you are researching how multi-app
venues run. Ask to sit for an hour. Buy a tea.

**Write down what they do, not what they say.** If they say they always block
immediately and you watch a slot sit open for eleven minutes, the eleven minutes
is the finding.

---

## 1. Setup — the shape of the venue

- How many courts? What sports?
- Which apps are you listed on? *(Count them. This is the number the whole
  product depends on — the thesis is 4–5, and if the median is 2 the pain is
  much smaller than we think.)*
- How long on each?
- Which one brings the most bookings? The most money? *(These are usually
  different, and the difference is a Phase 4 feature.)*
- Roughly how many bookings a day? On a Saturday?

## 2. Observation — the hour you actually came for

Sit quietly. For each booking that lands during the hour:

- Which platform did it come from?
- How did they find out — app notification, phone, walk-in?
- **Start the stopwatch when they pick up the phone. Stop it when the last
  other app is blocked.** Record the seconds.
- Did they block on every other platform, or skip some?
- If they skipped, ask afterwards why. *(The answer is usually "that one's slow"
  or "we don't get many from there" — both are useful.)*
- How long between the booking landing and them noticing it?

Record at least three timed observations per venue. If none land in the hour,
that is a finding too — write down what time you sat and what the venue told
you their peak was.

## 3. Double-bookings

- Has the same slot ever been sold twice?
- How often? Last month? *(Push for a number, not "sometimes".)*
- What happened the last time? Walk me through it.
- What did it cost — refund, free slot, a bad review?
- Who found out first, you or the customer?

## 4. Cancellations

- When someone cancels on one app, do you reopen the slot on the others?
- Always? *(Watch the face.)*
- Roughly how many slots a month go unsold because nobody reopened them?

## 5. Money

- Do you know what each platform's commission is?
- Do you check that the payout matches what you were owed? How?
- Has a payout ever been short? Did you catch it?
- Can you tell me what last Saturday 8pm earned you, net? *(Watch them try.
  How long it takes, and whether they can, is the Phase 2 pitch in one moment.)*
- Cash walk-ins — how are those recorded?

## 6. Staff and partners

- Who works the counter when you are not here?
- Do you have partners in the venue? How is the split settled?
- Has that ever been a source of friction? *(Underrated. If this lands hard,
  the partner dashboard is a headline feature and not a Phase 2 detail.)*

## 7. Software today

- Do you use any software for this? What?
- What does it cost?
- If you stopped paying for it tomorrow, what would break?

## 8. Only now, the pitch

Describe it in one sentence: *"One calendar for all your apps. A booking on any
one blocks the same slot on the others automatically, within about fifteen
seconds."*

- Would that be useful? What would you want it to do that I have not said?
- What would you pay a month for it? *(Let them say a number first. Silence is
  the tool here.)*
- If it were free for two months while we get it right, would you use it?
- **Would you be a design partner?** — free, in exchange for telling us your own
  booking count each night so we can measure whether we are catching everything.

## 9. The device question

- Is there a phone or tablet that stays at the counter?
- Is it shared, or someone's personal phone?
- Is it plugged in? Does it stay on overnight?

*(This changes the companion app's entire battery and permission strategy, and
it is the cheapest question on this page.)*

---

## After each interview

```bash
node tools/interview.js
```

Then, once you have all fifteen:

```bash
node tools/gate.js
```

---

## What kills the product

Listen for these. They are not objections to overcome — they are the signal that
the pain is not acute enough to carry ₹3,000 a month:

- **"I only list on one or two apps."** No sync problem exists.
- **"My staff handles it, it's fine."** The pain is delegated, and delegated pain
  does not get budget.
- **"Double-booking? Maybe twice a year."** The headline number is not there.
- **"I'd just stop using the other apps."** They want a replacement, not a sync
  layer — a different, harder product.

If most of the fifteen say these, the pivot is reconciliation-first: that pain is
universal, the same ingestion work serves it, and nothing built so far is wasted.
