#!/usr/bin/env node
/*
 * Phase 0 payload capture.
 *
 * Takes a raw notification or confirmation email exactly as a partner app sent
 * it, redacts the personal data, and appends it to the real fixture corpus.
 *
 *   node tools/capture.js                       paste the payload, end with Ctrl-D
 *   node tools/capture.js --file msg.txt
 *   node tools/capture.js --file msg.txt --channel email --platform hudle
 *   node tools/capture.js --file msg.txt --note "after their Oct app update"
 *
 * It then runs the payload through the current templates and prints what they
 * made of it, so you find out at the counter — not three weeks later — that a
 * platform's real format is nothing like the one we guessed.
 *
 * Redaction is deliberately aggressive. The wording, punctuation and field
 * order are what matter to a parser; the customer's name and number are not,
 * and this corpus gets committed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseWithTemplates } from '@turfsync/parsers';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(here, '..', 'packages', 'parsers', 'fixtures', 'real.json');

const PLATFORMS = ['playo', 'khelomore', 'hudle', 'district'];
const CHANNELS = ['notification', 'email'];

// Stand-in names, so a redacted payload still reads like a real one and still
// exercises whatever name-shaped regex a template uses.
const NAMES = ['Asha Kulkarni', 'Rohan Desai', 'Priya Nair', 'Imran Qadri', 'Neel Bhatt', 'Sara Menon'];

function args() {
  const out = { channel: null, platform: null, file: null, note: null, id: null };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    const key = a[i].replace(/^--/, '');
    if (key in out) out[key] = a[i + 1], i += 1;
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

/**
 * Redact in place, preserving shape. A ten-digit number stays a ten-digit
 * number; a two-word name stays two words. Anything that changes the length or
 * structure of a field would change what the regex sees.
 */
const NOT_A_NAME = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Booking|Court|Ground|Turf|New|Order|Guest|Customer|Player|Total|Amount|Slot|Date|Time|Net|Venue|Hi|Team|Open|Review|Pitch|Practice|Synthetic|Cricket|Pickle)\b/;

// Two strictnesses, used in different places on purpose.
//   STRICT (2-3 words) for the unanchored sweep over a line that merely
//   happens to contain a phone number — loose matching there would eat court
//   names and venue names.
//   LOOSE (1-3 words) only where the surrounding text already proves it is a
//   name: right after "Customer:", or right before "is scheduled to play".
//   Real customers are very often mononymous — "Harsh", "Goutham" — and a
//   two-word minimum silently left those in a corpus that gets committed.
const NAME_STRICT = /\b[A-Z][a-z]{1,14}(?: [A-Z][a-z]{1,14}){1,2}\b/g;
const NAME_LOOSE = String.raw`\b[A-Z][a-z]{1,14}(?: [A-Z][a-z]{1,14}){0,2}\b`;
const PHONE = /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/;
const NAME_MARKER = /\b(?:customer|guest|player|booked by|by)\b\s*[:·|]?/i;

/**
 * Places where the text itself says "the thing next to me is a person".
 * Each pattern captures exactly the name in group 1.
 */
function nameContexts() {
  return [
    // "Customer: Harsh"  ·  "Guest: Yusuf Ansari"  ·  "by Sana Qureshi"
    new RegExp(`${NAME_MARKER.source}\\s*(${NAME_LOOSE})`, 'gi'),
    // "Siddhant Barve is scheduled to play …" — District and Hudle both use
    // this sentence, and the name is the subject of it.
    new RegExp(`(${NAME_LOOSE})(?=\\s+is scheduled to play\\b)`, 'g'),
  ];
}

function redact(raw, seed) {
  const replacement = NAMES[seed % NAMES.length];
  const found = { phones: 0, names: 0, emails: 0 };

  // Names are found line by line, because position alone cannot separate a
  // customer from a court. Playo puts both at the start of a line before a
  // middot — "Turf A · Sat, 04 Oct" and "Devendra Rao · 9812345318" have the
  // same shape. What distinguishes them is the rest of the line: a name line
  // carries a phone number, or a "Customer:"-style marker.
  const lines = raw.split('\n').map((line) => {
    // A labelled name — "Customer: Rohit Menon", "Guest: Yusuf Ansari",
    // "by Sana Qureshi". Replace only the run directly after the label. A
    // blanket pass over the whole line would also eat "District Partner" and
    // "Football Court", and a fixture without its court label is useless.
    let hitContext = false;
    let out = line;
    for (const pattern of nameContexts()) {
      out = out.replace(pattern, (match, name) => {
        if (!name || NOT_A_NAME.test(name)) return match;
        hitContext = true;
        found.names += 1;
        // `match` may be wider than the name (it includes the marker), so
        // swap only the captured portion and leave the label intact.
        return match.replace(name, replacement);
      });
    }
    if (hitContext) return out;

    // Otherwise a line carrying a phone number is a name line — that is what
    // separates "Devendra Rao · 98123…" from "Turf A · Sat, 04 Oct".
    if (!PHONE.test(line)) return out;
    return out.replace(NAME_STRICT, (match) => {
      if (NOT_A_NAME.test(match)) return match;
      found.names += 1;
      return replacement;
    });
  });

  // Pipe-delimited formats (Hudle) put the customer in the trailing field with
  // no phone and no label — nothing for the rules above to key on. In a line of
  // three or more piped fields, the last one is the candidate.
  if (found.names === 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const parts = lines[i].split('|');
      if (parts.length < 3) continue;
      const last = parts[parts.length - 1].trim();
      if (!last || NOT_A_NAME.test(last)) continue;
      const m = last.match(new RegExp(`^${NAME_STRICT.source}$`));
      if (!m) continue;
      parts[parts.length - 1] = parts[parts.length - 1].replace(last, replacement);
      lines[i] = parts.join('|');
      found.names += 1;
    }
  }

  let text = lines.join('\n');

  // Phones after names, so the phone is still present while names are detected.
  text = text.replace(new RegExp(PHONE.source, 'g'), () => {
    found.phones += 1;
    return `98${String(10000000 + ((seed * 7919 + found.phones * 104729) % 89999999)).slice(0, 8)}`;
  });

  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, () => {
    found.emails += 1;
    return 'player@example.com';
  });

  return { text, found };
}

function guessPlatform(raw) {
  const t = raw.toLowerCase();
  if (/playo|\bply-/.test(t)) return 'playo';
  if (/khelomore|\bkm-/.test(t)) return 'khelomore';
  if (/hudle|\bhdl-/.test(t)) return 'hudle';
  if (/district|\bdst-/.test(t)) return 'district';
  return null;
}

function guessChannel(raw) {
  // Emails carry headers, subjects and labelled fields; pushes are one blob.
  return /^(subject|from|to)\s*:/im.test(raw) || raw.split('\n').length > 8 ? 'email' : 'notification';
}

const opts = args();

const raw = opts.file
  ? await readFile(path.resolve(opts.file), 'utf8')
  : await readStdin();

if (!raw.trim()) {
  console.error('Nothing to capture. Paste the payload and press Ctrl-D, or pass --file.');
  process.exit(1);
}

const platform = opts.platform || guessPlatform(raw);
const channel = opts.channel || guessChannel(raw);

if (!PLATFORMS.includes(platform)) {
  console.error(`Could not tell which platform this is from. Pass --platform <${PLATFORMS.join('|')}>.`);
  process.exit(1);
}
if (!CHANNELS.includes(channel)) {
  console.error(`--channel must be one of: ${CHANNELS.join(', ')}`);
  process.exit(1);
}

const corpus = JSON.parse(await readFile(REAL, 'utf8'));
const seed = corpus.cases.length + 1;
const { text, found } = redact(raw.trimEnd(), seed);

const id = opts.id || `${platform}-${channel}-${String(seed).padStart(2, '0')}`;

// Run it through the templates as they stand today. This is the whole point of
// capturing at the counter rather than in a notebook.
const hit = parseWithTemplates(text, { channel });

const entry = {
  id,
  channel,
  platform,
  capturedAt: new Date().toISOString().slice(0, 10),
  note: opts.note || null,
  raw: text,
  // Filled in from what the template read, then corrected by hand. A field the
  // payload genuinely does not carry stays null — that absence is data.
  expect: hit
    ? {
        platform: hit.parsed.platform,
        externalBookingId: hit.parsed.externalBookingId,
        courtLabel: hit.parsed.courtLabel,
        date: hit.parsed.date,
        startHhmm: hit.parsed.startHhmm,
        endHhmm: hit.parsed.endHhmm,
        customerName: hit.parsed.customerName,
        grossPaise: hit.parsed.grossPaise,
        commissionPaise: hit.parsed.commissionPaise,
      }
    : { platform },
};

corpus.cases.push(entry);
await writeFile(REAL, JSON.stringify(corpus, null, 2) + '\n');

console.log(`\ncaptured  ${id}`);
console.log(`redacted  ${found.phones} phone(s), ${found.names} name(s), ${found.emails} email(s)`);

// Under-redaction is the failure that matters: this corpus gets committed, and
// a customer's number in git history is not fixed by deleting the line later.
if (found.names === 0) {
  console.log('\n!! No customer name was detected, and almost every booking payload has one.');
  console.log('   Open real.json and check the `raw` field by hand before committing.');
}
console.log(`saved to  packages/parsers/fixtures/real.json  (${corpus.cases.length} real payload${corpus.cases.length === 1 ? '' : 's'})\n`);

if (hit) {
  console.log(`PARSED by ${hit.templateVersion}`);
  for (const [k, v] of Object.entries(entry.expect)) {
    console.log(`   ${k.padEnd(18)} ${v === null ? '—' : v}`);
  }
  console.log('\nCheck every line above against the payload. The template can be');
  console.log('confidently wrong — that is exactly what this exercise is for.');
} else {
  console.log('NOT PARSED — no template matched.');
  console.log('\nThis is the expected outcome for a real payload right now, and it is');
  console.log('useful: fill in `expect` by hand in real.json, then make the template');
  console.log('match it. Corpus first, template second.');
}
console.log(`\nnext: node tools/recon.js\n`);
