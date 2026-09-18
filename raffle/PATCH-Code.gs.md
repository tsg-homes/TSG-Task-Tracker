# Two one-line edits to `Code.gs`

These are the *only* changes to the existing "TSG Open House Sign-In + Client
Intake Forms" project. Everything else the raffle needs lives in the two new
files (`RaffleCode.gs`, `RaffleForm.html`). Nothing below touches the Open House
or Buyer/Seller Intake code paths — each edit adds one branch that fires only
when `form=raffle` / `formType: 'raffle'` is present, which no existing form
ever sends.

---

## 1. `doGet` — serve the raffle page

Find this line (it's the start of the intake-form routing):

```js
  var formParam = (e.parameter.form || '').toString().toLowerCase();
```

Add **one line directly beneath it**:

```js
  var formParam = (e.parameter.form || '').toString().toLowerCase();
  if (formParam === 'raffle') return raffleServeForm_(e, baseUrl);   // <-- ADD THIS
```

It is placed *before* the `INTAKE_FORM_FILES` lookup on purpose: `'raffle'` is
not a key in that map, so an exact-match check here can never shadow an intake
form, and an unrecognized `?form=` value still falls through to the Open House
Sign-In default exactly as before.

---

## 2. `doPost` — accept the raffle entry

Find this line inside `doPost`:

```js
    var formType = (data.formType || '').toString().toLowerCase();
```

Add **one line directly beneath it**:

```js
    var formType = (data.formType || '').toString().toLowerCase();
    if (formType === 'raffle') return raffleHandleSubmission_(data);   // <-- ADD THIS
```

Position matters here too. By this point `doPost` has already run, in order:

1. the honeypot check (`data.website`),
2. `sanitizeSubmission(data)` — field length caps,
3. `setQaTestModeFromPayload_(data)`,
4. `checkSubmitToken(data)` — the page-issued form token,
5. `checkRateLimit()` — the shared 15/minute cap.

So the raffle inherits all five without duplicating any of them, and
`raffleHandleSubmission_` deliberately does **not** re-implement them. Do not
call `raffleHandleSubmission_` from anywhere else, or it would run unguarded.

---

## Note on the shared rate limit

`checkRateLimit()` allows 15 submissions per minute across **both** public forms.
Across a 3-hour party with a 125-person cap that is not close to binding, and a
throttled entrant just sees "try again in a minute". But if you announce the QR
code from the mic and get a stampede, the cap is the thing that would bite.

If you want headroom for Saturday only, change the `15` in `checkRateLimit()` to
`40` and change it back afterwards. It is one number, in one place:

```js
    if (count >= 15) {      // -> 40 for the block party
```

I have left it at 15 — raising a shared safety limit on a public endpoint isn't
something to do silently on your behalf.
