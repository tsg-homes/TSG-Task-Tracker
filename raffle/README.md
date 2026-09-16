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

## Deployment status

**Live as version @31, deployed 2026-09-16 by `info@tsg.homes`.**

All six project files pushed and then verified byte-for-byte by re-pulling the
live project — including `OpenHouseForm.html` and `ClientIntake.html`, which this
work must not disturb. Deployed to the *existing* deployment, so the public URL
and any printed QR are unchanged.

Deployed **as info@ deliberately**. The web app is `executeAs: USER_DEPLOYING`,
so the deploying account is the one the script runs as — and therefore the one
`MailApp` sends from. Gmail shows the identity had drifted to durand@ between
2 and 8 September (an earlier redeploy); @31 puts all three forms back on info@.
**If you ever redeploy this project, do it as info@ or the sending identity
silently moves again.**

### One step left, and only you can do it

`setupRaffle()` must be run once **from the editor while signed in as info@** —
not as durand@. It could not be run remotely (`clasp run` needs the project
linked to a standard GCP project; it is not).

Signed in as info@ matters for a concrete reason: the entries Sheet and the 6:15
trigger are owned by whoever creates them. Created under durand@ while the web
app runs as info@, `SpreadsheetApp.openById` would fail and **every entry on
Saturday would be refused**.

1. Open the project as info@ → select `setupRaffle` → **Run** → approve.
   The only new scope is trigger creation; Mail and Spreadsheet were already
   granted by `sendErrorAlert` and `logConsentRecord`.
2. Expect: the entries sheet, a generated `RAFFLE_ADMIN_KEY`, and
   `Draw trigger armed for 2026-09-19 18:15:00 ET`.
3. Run `raffleAdminLinks()` and keep the output.

**Must happen before 3:00 PM Saturday.** Until then the form renders but cannot
save an entry and the draw is not armed. Harmless in the meantime: the
entry-window check runs before anything touches the sheet.

### Then verify by hand (this session's proxy blocks `script.google.com`)

- `<exec>?form=raffle` → countdown page
- `<exec>?form=raffle&qatest=<QA_TEST_SECRET>` → test mode, red banner, usable now
- bare `<exec>` → Open House Sign-In, unchanged
- `<exec>?form=buyer-seller` → intake form, unchanged

The last two matter: @31 republished the whole project, not just the raffle.

### Entry is open to anyone

`"access": "ANYONE_ANONYMOUS"` — no Google account or sign-in of any kind. Any
phone, any browser, any email domain. The email field is free text and is not
verified against a Google identity. (The domain-restricted Deal Forms live on a
different deployment and are unaffected.)

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

## Test mode vs live

You cannot test the live form before Saturday — the entry window refuses
everything outside 3:00–6:15 PM on 19 Sep. Test mode exists for exactly that.

It reuses the project's **existing** QA test mode (the `QA_TEST_*` block in
`Code.gs`), so there is one test-mode concept across all three forms, not two.
It needs the `QA_TEST_SECRET` script property set — the same one the open-house
and intake forms already use.

| | Live | Test |
|---|---|---|
| URL | `?form=raffle` | `?form=raffle&qatest=<QA_TEST_SECRET>` |
| Entry window | enforced (Sat 3:00–6:15) | **bypassed** — works any time |
| Entries land in | `Entries` tab | `Test Entries` tab |
| FUB record | normal | name prefixed `[QA TEST] `, tagged `QA Test — Safe to Delete` |
| Winner stored as | `RAFFLE_WINNER_JSON` | `RAFFLE_TEST_WINNER_JSON` |
| Draw result tab | `Draw Result` | `Draw Result (TEST)` |
| Result email | Durand + Ryan | Durand only |
| On-screen | normal page | red TEST MODE banner, impossible to miss |

**Test entries can never win the real prize.** That is structural, not a filter:
the live draw reads the `Entries` tab and the test draw reads `Test Entries`,
and there is no code path joining them. A test draw also writes its own winner
property, so it cannot consume the live draw's one-shot lock — you can rehearse
as often as you like and the real 6:15 draw is still pending and unaffected. The
6:15 trigger itself calls `raffleDrawWinner_(false)` explicitly, so it is always
the live draw even if something else is in test mode.

**Test mode relaxes exactly one check — the entry window.** `Code.gs`'s own test
mode is documented as "a LABELLING and ROUTING change only; by construction it
cannot relax a check", and this is a deliberate, single departure from that,
logged loudly every time it fires. The form token, rate limit, honeypot,
required fields, consent and one-entry-per-person all still apply in test mode,
and there are tests asserting each of those.

### Rehearsing the whole thing

1. `<exec>?form=raffle&qatest=<secret>` → enter a few fake people.
2. `<exec>?form=raffle&action=status&key=<admin key>&test=1` → check the count.
3. `<exec>?form=raffle&action=draw&key=<admin key>&test=1` → rehearse the draw.
   You get the winner page and the result email, exactly as Saturday will look.
4. `raffleResetTest()` in the editor → wipes test entries, the test winner and
   the `Draw Result (TEST)` tab. Touches nothing live. Safe to run at any time,
   including during the party.

`raffleAdminLinks()` prints all of these with the key filled in.

Clean-up note: test entries **are** written to FUB for real, because that is the
point of a rehearsal — but they are prefixed and tagged, so filter FUB on
`QA Test — Safe to Delete` and delete them when you are done.

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
