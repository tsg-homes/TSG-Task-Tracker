# TSG Block Party 2026 — Raffle Entry Form

Public entry form + automatic 6:15 drawing + Follow Up Boss sync for the
**$300 Ticketmaster** prize at the TSG Block Party, **Saturday 19 September 2026,
3:00–7:00 PM, 1342 N Hancock St**.

## Where this deploys

Into the existing **"TSG Open House Sign-In + Client Intake Forms"** Apps Script
project (owned by `info@tsg.homes`, script id
`1ZPZIHv8ocQyN23ikKf3rTgpyIU9pktRqjlaFJEGamwNziWWjUqLGvBRf`) — *not* a new
project and *not* the task tracker.

That project is already the public, anonymous, no-login form host under `info@`,
already holds `FUB_API_KEY`, and already carries the hardening a public endpoint
needs: page-issued submit token, shared rate limit, honeypot, dedupe claims,
consent audit log, and the fix that stopped FUB error text leaking to anonymous
visitors. Standing that up again from scratch in a new project, untested, in
three days would have been strictly more risk. The task tracker's script is
untouched — nothing public goes anywhere near its Anthropic key or script token.

## Files

| File | What it is |
|---|---|
| `RaffleCode.gs` | New server file. Paste into the project as `RaffleCode`. All symbols are `raffle*`-prefixed. |
| `RaffleForm.html` | **Built** page. Paste into the project as `RaffleForm`. Do not hand-edit. |
| `RaffleForm.template.html` | Source for the above. Edit this. |
| `tools/build-form.js` | `node tools/build-form.js` → regenerates `RaffleForm.html`. |
| `assets/` | All four pinned marks (Eagles, Ticketmaster, TSG, KW) + their base64. |
| `PATCH-Code.gs.md` | The two one-line edits to the existing `Code.gs`. |
| `test/test_raffle.js` | 72 unit tests for `RaffleCode.gs`. |
| `test/test_form.js` | 47 browser tests for the built page (countdown, open/close flips, payload). |

## Setup (about 15 minutes, all on your machine)

1. **Add the two files** to the Apps Script project: `RaffleCode` (.gs) and
   `RaffleForm` (.html). Names are case-sensitive and must match exactly, or
   `createTemplateFromFile('RaffleForm')` throws.
2. **Apply the two one-line hooks** in `PATCH-Code.gs.md`.
3. **Run `setupRaffle()`** once from the editor. It creates the entries
   spreadsheet, generates `RAFFLE_ADMIN_KEY`, and arms the 6:15 PM draw trigger.
   Re-running is safe — it reuses the sheet and never arms two draws.
4. **Re-authorize.** The raffle adds Spreadsheet, Mail and Trigger scopes, so
   Google will prompt. This is unavoidable and it is why step 6 matters. (It
   does *not* add a Drive scope — all four logos are baked into the page.)
5. **Deploy** a new version of the existing deployment (same exec URL).
6. **Re-test the Open House form** (`?form=openhouse` or the bare URL) and the
   intake form (`?form=buyer-seller`) before you walk away. Re-authorization
   touches the whole project, not just the new code.
7. **Run `raffleAdminLinks()`** and keep the output. It prints four URLs.

## The four URLs

| URL | Share? |
|---|---|
| `<exec>?form=raffle` | **Yes** — this is the QR code. No key, safe to print. |
| `<exec>?form=raffle&kiosk=1` | For the iPad at the table. Auto-resets 6s after each entry. |
| `<exec>?form=raffle&action=status&key=…` | **Private.** Live entry count. |
| `<exec>?form=raffle&action=draw&key=…` | **Private.** Manual draw, if the trigger misfires. |

The two `key=` URLs carry the admin key — treat them like a password. A wrong key
and a missing key both return an identical "Not found", so neither can be probed.

## How the day runs

- **Before 3:00 PM** — the page shows a live **"Goes live in" countdown**
  (days / hours / mins / secs) ticking down to 3:00. Entries are refused
  server-side too, so a link shared early can't be used.
- **3:00:00 PM** — the countdown runs out and the page **turns itself into the
  live form**, no reload. Same server-clock basis as the close.
- **3:00 PM – 6:15 PM** — form is live. One entry per person, matched on **both**
  email and phone (country code and formatting normalized, so `+1 215.555.0123`
  and `(215) 555-0123` are the same person). A repeat entrant is told they're
  already in rather than shown an error.
- **6:15:00 PM** — the page **goes dead by itself**, no reload needed, and shows
  "Entries are closed — winner announced at 6:30." It measures this against the
  *server* clock, so a phone with a wrong clock still closes on time. The trigger
  fires, picks a winner plus **two backups** from one unbiased shuffle, and emails
  you and Ryan.
- **6:30 PM** — announce. The winner need not be present; the rules give a
  14-day claim window and the backups are there in case they've left.

## What lands in FUB

Each entrant becomes a person record with:

- tags `Block Party 2026`, `Block Party Raffle Entrant`, `Event Lead`
- source `TSG Block Party 2026 - Raffle`
- the `Consent — Captured Date` custom field set (same field the other two forms use)
- a background note recording block party attendance and the exact consent given
- a timeline note: *"Met at the TSG Block Party… Warm event lead — worth a personal call, not just a drip."*

**A FUB outage cannot cost anyone their entry.** The sheet row is written first
and the FUB push is best-effort on top of it; a failure is recorded on the row,
alerted to you by email, and re-pushed later with `raffleRetryFubFailures()`.

## Open items for you

1. **Ryan's email.** His calendar identity is `ryan@thestawaszgroup.com`; this
   project's FUB roster has `ryan@tsg.homes`. Results go to **both** rather than
   me guessing which one he reads on a Saturday evening. Trim
   `RAFFLE_RESULT_EMAIL` if you want just one.
2. **Buy the gift card before Saturday.** Nothing here does that.
3. **The consent decision is yours and it's live.** You asked for all fields
   required, so entry is conditioned on consent to autodialed/pre-recorded calls
   and texts. That is the exact fact pattern TCPA plaintiffs' firms target, at
   $500–$1,500 per message. The wording is accurate about it (it says consent is
   required to enter, and does not falsely claim otherwise). Making the
   marketing half optional later is a one-line change.
4. **Trademarks.** The Ticketmaster and Eagles marks are on the page at your
   direction. The standard mitigation is in place — a non-affiliation disclaimer
   visible above the button, and again as section 12 of the rules — but it is a
   mitigation, not permission.
5. **"Raffle" is never written on the page.** A paid raffle in Pennsylvania needs
   a Small Games of Chance licence; a free-entry prize drawing does not. The page
   says "prize drawing" and leads with NO PURCHASE NECESSARY. Call it a raffle out
   loud all you like — just don't put it in print or charge for entry.
6. **Rules placeholders are filled**, not stubs: sponsor address, phone and email
   are the real TSG Center City details. Per your instruction no licence number
   is printed; the brokerage is still identified as Keller Williams Empower.

## Branding

All four marks are **baked into the built page**, not fetched at runtime: the
bytes that were reviewed are the bytes that ship, nobody can swap a trademark in
by dropping a file in Drive, and the page needs no Drive scope and no external
image requests. Sourced from TSG's own Drive and optimized — Eagles 263 KB →
12.6 KB, TSG wordmark (cropped from `TSG_2024_LOGO-01.png`) 3.2 MB → 4.1 KB,
KW Empower 676 KB → 4.6 KB, Ticketmaster inlined as vector. Whole page: 55 KB.

To change a logo: replace the file in `assets/`, run `node tools/build-form.js`,
re-paste `RaffleForm.html`.

## Tests

```
node test/test_raffle.js     # 72 server-side tests
node test/test_form.js       # 47 browser tests (needs: npm install playwright)
```

Covers identity normalization, the entry window, required fields and consent,
one-entry-per-person across both keys and all phone formats, FUB-outage
behaviour, the FUB payload shape, draw fairness and **non-repeatability** (a
double-fired trigger cannot re-roll a winner or send a second email), manual
disqualification, and admin-endpoint key gating.

The browser suite covers the countdown maths, the 3:00 open flip and the 6:15
close flip (both verified to happen with no reload), validation, phone
formatting, consent gating the POST, the exact payload shape, that all four
logos actually load, that the contact block is right, and that the word
"raffle" never appears anywhere on the page.
