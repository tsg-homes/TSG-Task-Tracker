/**
 * Node `vm`-based unit tests for RaffleCode.gs, in the same style as the task
 * tracker's test/test_codegs.js: load the real file into a sandbox with stubbed
 * Apps Script globals, then exercise the logic against a fake Sheet.
 *
 *   node test/test_raffle.js
 */
const { makeSandbox, at, entry, enterFull, verifySession, referral, drawMail, J, check, eq, HEADERS, DURING, BEFORE, AFTER, counts } = require('./harness');

// Read a row cell BY COLUMN NAME. Magic indexes are how a schema change turns a
// test green against the wrong column -- writing 21 for "Chain Token" when the
// header list had moved it to 22 is exactly the mistake this prevents.
// Row selectors. With a self entry AND a referral entry per journey, __data()[0]
// is no longer "the entry" — grabbing it blindly is how a test ends up asserting
// against the wrong row.
const refRows  = s => s.__data().filter(r => cell(s, r, 'Referral Name') !== '');
const selfRows = s => s.__data().filter(r => cell(s, r, 'Referral Name') === '');

const cell = (s, row, name) => {
  const i = s.RAFFLE_SHEET_HEADERS.indexOf(name);
  if (i === -1) throw new Error('no such column: ' + name);
  return String(row[i] === undefined ? '' : row[i]);
};

// ---- Identity normalization ------------------------------------------------
{
  const s = makeSandbox();
  eq('phone key strips formatting', s.rafflePhoneKey_('(215) 555-8123'), '2155558123');
  eq('phone key strips +1 country code', s.rafflePhoneKey_('+1 215-555-8123'), '2155558123');
  check('phone keys collide across formats',
    s.rafflePhoneKey_('215.555.8123') === s.rafflePhoneKey_('1 (215) 555 8123'));
  eq('email key lowercases and trims', s.raffleEmailKey_('  Dana@Mail-Test.CO '), 'dana@mail-test.co');
}

// ---- Entry window ----------------------------------------------------------
{
  // 2026-09-17: entries open AHEAD of the party, not just during it. Entry now
  // depends on a third party replying to an email, and a three-hour Saturday
  // window was not enough time for that to happen. The CLOSE is still hard --
  // it has to be, or the draw would be from a pool that is still moving.
  const s = makeSandbox();
  eq('entries are open days before the party', at(BEFORE, () => s.raffleEntryState_()), 'open');
  eq('state during the party',  at(DURING, () => s.raffleEntryState_()), 'open');
  eq('state after the 6:15 draw', at(AFTER, () => s.raffleEntryState_()), 'closed');

  const early = enterFull(s, entry(), BEFORE);
  check('an entry days before the party is accepted', early.ok === true, JSON.stringify(early));
  // THREE rows per full journey now: the entrant's own entry (1 ticket), the
  // referral entry (5 tickets once confirmed), and the referred person's own
  // entry (1 ticket), written on the strength of the box they ticked to consent.
  eq('and all three rows are written', s.__data().length, 3);

  const s2 = makeSandbox();
  const late = enterFull(s2, entry(), AFTER);
  check('entry rejected after 6:15 PM', late.ok === false);
  check('late rejection names the 6:30 announcement', /6:30 PM/.test(late.error));
  check('no row written after close', s2.__data().length === 0);
}

// ---- Required fields + consent ---------------------------------------------
{
  const s = makeSandbox();
  const run = d => enterFull(s, d, DURING);
  check('name required',    run(entry({ fullName: '' })).ok === false);
  check('email required',   run(entry({ email: '' })).ok === false);
  check('phone required',   run(entry({ phone: '' })).ok === false);
  check('single-word name rejected', run(entry({ fullName: 'Cher' })).ok === false);
  check('bad email rejected', run(entry({ email: 'nope' })).ok === false);
  const noConsent = run(entry({ consent: 'No' }));
  check('consent is required to enter', noConsent.ok === false);
  check('consent error names the Official Rules', /Official Rules/.test(noConsent.error));
  check('a forged consent value is not treated as Yes',
    run(entry({ consent: true })).ok === false);
  check('nothing was written for any invalid entry', s.__data().length === 0);
}

// ---- One FREE entry per person, but come back as often as you like ----------
//
// Under the multiplier rules a returning visitor is no longer a duplicate to turn
// away: they are somebody back to refer another person and collect another five
// entries, which is the behaviour the whole thing exists to encourage. What must
// NOT happen is a second SELF entry — that would be a free extra ticket for
// clearing the browser and starting again.
{
  const s = makeSandbox();
  const first = enterFull(s, entry(), DURING);
  check('first entry accepted', first.ok === true);
  eq('three rows: two own entries and the referral', s.__data().length, 3);
  // Two self entries: the entrant's, and the referred person's from consenting.
  eq('two self entries, one each', selfRows(s).length, 2);
  eq('and exactly one for the entrant',
    selfRows(s).filter(r => cell(s, r, 'Email') === 'dana@mail-test.co').length, 1);

  // Same person, same email, different phone. Verifying again must not mint a
  // second free ticket.
  verifySession(s, entry({ phone: '(267) 555-9999' }), DURING);
  eq('still exactly one self entry for them', selfRows(s).length, 2);

  // Same phone, different email.
  verifySession(s, entry({ email: 'other@mail-test.co' }), DURING);
  eq('and still one after a different email, same phone', selfRows(s).length, 2);

  // Formatting games on the phone.
  verifySession(s, entry({ email: 'third@mail-test.co', phone: '+1 215.555.8123' }), DURING);
  eq('formatting variations do not mint one either', selfRows(s).length, 2);

  eq('no extra rows at all from the repeat attempts', s.__data().length, 3);

  // But a SECOND referral from the same person is welcome, and worth another five.
  const v = verifySession(s, entry(), DURING);
  const second = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid },
    referral({ referralName: 'Second Friend', referralEmail: 'second@mail-test.co',
               referralPhone: '(215) 555-9777' })))));
  check('a second referral from the same person is accepted',
    second.ok === true && second.staged === true, JSON.stringify(second));
  eq('which is a fourth row', s.__data().length, 4);

  // A different entrant AND a different referral: one entry per referred person
  // is the rule now, so reusing the default referral here would be refused --
  // which is itself asserted in the referral section below.
  const other = enterFull(s,
    entry({ fullName: 'Sam Ortiz', email: 'sam@mail-test.co', phone: '(267) 555-8100' }),
    DURING,
    { referral: { referralName: 'Casey Wren', referralEmail: 'casey@mail-test.co',
                  referralPhone: '(215) 555-9002' } });
  check('a genuinely different person is accepted', other.ok === true, JSON.stringify(other));
  eq('seven rows now — the four above plus a second journey\'s three',
     s.__data().length, 7);
}

// ---- FUB outage must never cost an entry -----------------------------------
{
  const s = makeSandbox({ fubStatus: 500 });
  const res = enterFull(s, entry(), DURING);
  check('entrant still gets a success when FUB is down', res.ok === true);
  eq('all three rows are still recorded in the sheet', s.__data().length, 3);
  check('row records the FUB failure for later retry',
    /failed/.test(String(s.__data()[0][7])), String(s.__data()[0][7]));
  check('entry is still eligible for the draw', s.__data()[0][9] === 'Yes');
}

// ---- FUB payload -----------------------------------------------------------
{
  const s = makeSandbox();
  enterFull(s, entry(), DURING);
  // The people endpoint is now also hit for candidate searches, so count only
  // the actual create.
  const people = s.__fetches.filter(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post');
  const notes  = s.__fetches.filter(f => /\/v1\/notes/.test(f.url));
  // Two creates: the entrant (at verification) and the referral (at CONSENT, not
  // when their name was typed -- see raffleLogUnconfirmedReferrals_ for why).
  eq('two people created in FUB (entrant + referral)', people.length, 2);
  check('at least two notes written in FUB', notes.length >= 2, 'got ' + notes.length);
  const body = JSON.parse(people[0].o.payload);
  eq('first name split', body.firstName, 'Dana');
  eq('last name split', body.lastName, 'Reid');
  eq('phone sent as digits only', body.phones[0].value, '2155558123');
  check('tagged as a block party raffle entrant',
    body.tags.indexOf('Block Party Raffle Entrant') !== -1);
  check('tagged with the event', body.tags.indexOf('Block Party 2026') !== -1);
  check('source names the event', /Block Party 2026/.test(body.source));
  check('structured consent date captured', !!body.customConsentCapturedDate);
  check('background records block party attendance', /ATTENDED/.test(body.background));

  // The referral's own record, created from the same submission.
  const refBody = JSON.parse(people[1].o.payload);
  eq('referral first name split', refBody.firstName, 'Robin');
  check('referral tagged with the role they were referred for',
    refBody.tags.indexOf('Buyer') !== -1, JSON.stringify(refBody.tags));
  check('referral tagged as a referred lead', refBody.tags.indexOf('Referred Lead') !== -1);
  check('referral carries the live FUB timeframe id', refBody.timeframeId === 3,
    JSON.stringify(refBody.timeframeId));
  // The referral record is only ever created once they have consented, so its
  // background says so rather than warning that consent is missing.
  check('referral background records consent given by them personally',
    /CONSENT GIVEN BY THIS PERSON THEMSELVES/.test(refBody.background), refBody.background);
  check('referral background names the referrer', /Dana Reid/.test(refBody.background));
  check('referral is tagged as having consented', refBody.tags.indexOf('Consented') !== -1,
    JSON.stringify(refBody.tags));

  // Both directions of the relationship, so the link is visible from either record.
  const links = s.__fetches.filter(f => /peopleRelationships/.test(f.url));
  eq('two relationship links written', links.length, 2);
  const types = links.map(l => JSON.parse(l.o.payload).type).sort();
  check('linked as Referred / Referred by', types.join(',') === 'Referred,Referred by',
    types.join(','));
  const note = JSON.parse(notes[0].o.payload);
  check('note mentions the block party', /Block Party/.test(note.subject));
  check('note carries the date and address', /9\/19\/2026/.test(note.body));
}

// ---- The draw --------------------------------------------------------------
{
  const s = makeSandbox();
  ['a', 'b', 'c', 'd'].forEach((n, i) => enterFull(s, entry({
    fullName: 'Person ' + n, email: n + '@mail-test.co', phone: '(215) 555-810' + i
  }), DURING, {
    referral: { referralName: 'Ref ' + n.toUpperCase() + ' Person',
                referralEmail: 'ref' + n + '@mail-test.co',
                referralPhone: '(215) 555-91' + (10 + i) }
  }));
  // Four journeys x three rows: each entrant's own entry, their referral, and
  // that referral's own entry from consenting.
  eq('four journeys, twelve rows', s.__data().length, 12);

  const first = at(AFTER, () => s.raffleDrawWinner_());
  check('draw succeeds', first.ok === true);
  check('draw is not flagged as already drawn', first.alreadyDrawn !== true);
  eq('twelve eligible rows', first.result.totalEligible, 12);
  // Eight people: four entrants and the four who confirmed a referral.
  eq('eight distinct people', first.result.totalPeople, 8);
  // 4 x (1 own + 5 referral bonus) + 4 x 1 own = 28 tickets.
  eq('twenty-eight tickets', first.result.totalTickets, 28);
  check('winner is one of the eight',
    ['Person a', 'Person b', 'Person c', 'Person d',
     'Ref A Person', 'Ref B Person', 'Ref C Person', 'Ref D Person']
      .indexOf(first.result.winner.name) !== -1, first.result.winner.name);
  eq('two backups named', first.result.backups.length, 2);
  const names = [first.result.winner.name].concat(first.result.backups.map(b => b.name));
  eq('winner and backups are all distinct people', new Set(names).size, 3);

  eq('results emailed once', drawMail(s).length, 1);
  check('email goes to Durand', /durand@thestawaszgroup\.com/.test(drawMail(s)[0].to));
  check('email goes to Ryan', /ryan@/.test(drawMail(s)[0].to));
  check('email subject names the winner', drawMail(s)[0].subject.indexOf(first.result.winner.name) !== -1);
  check('email body carries the winner phone', drawMail(s)[0].body.indexOf(first.result.winner.phone) !== -1);
  check('email body lists the backups', /BACKUPS/.test(drawMail(s)[0].body));

  // The draw must never be re-rollable.
  const again = at(AFTER, () => s.raffleDrawWinner_());
  check('second draw reports already drawn', again.alreadyDrawn === true);
  eq('same winner returned', again.result.winner.name, first.result.winner.name);
  eq('no second results email', drawMail(s).length, 1);

  const third = at(AFTER, () => s.raffleScheduledDraw());
  eq('a double-fired trigger still sends only one email', drawMail(s).length, 1);
}

// ---- Draw with no entries --------------------------------------------------
{
  const s = makeSandbox();
  const res = at(AFTER, () => s.raffleDrawWinner_());
  check('empty draw fails cleanly instead of throwing', res.ok === false);
  check('empty draw explains itself', /No eligible entries/.test(res.error));
  eq('no email sent for an empty draw', drawMail(s).length, 0);
}

// ---- Manual disqualification ------------------------------------------------
{
  const s = makeSandbox();
  enterFull(s, entry(), DURING);
  enterFull(s, entry({
    fullName: 'Sam Ortiz', email: 'sam@mail-test.co', phone: '(267) 555-8100' }), DURING,
    { referral: { referralName: 'Casey Wren', referralEmail: 'casey@mail-test.co',
                  referralPhone: '(215) 555-9002' } });
  // Disqualify EVERY row belonging to Dana — the self entry AND the referral.
  // Marking only one would leave the other in the draw, which is the real risk
  // now that one person owns more than one row. The people they referred are
  // entrants in their own right and are deliberately NOT disqualified with them.
  s.__tabs['Entries'].rows.forEach((r, i) => {
    if (i > 0 && String(r[1]) === 'Dana Reid') r[9] = 'No';
  });
  const res = at(AFTER, () => s.raffleDrawWinner_());
  eq('Dana is gone and the other three remain', res.result.totalPeople, 3);
  check('Dana cannot win', res.result.winner.name !== 'Dana Reid', res.result.winner.name);
  check('and neither can Dana as a backup',
    res.result.backups.every(b => b.name !== 'Dana Reid'),
    JSON.stringify(res.result.backups.map(b => b.name)));
}

// ---- Telling the winner ------------------------------------------------------
// The one thing that must NOT happen automatically: the draw runs at 6:15 and the
// announcement is at 6:30, so a winner email fired by the draw would reach them
// before Durand says the name out loud.
{
  const s = makeSandbox();
  enterFull(s, entry(), DURING);
  const noWinnerYet = at(AFTER, () => s.raffleSendWinnerEmail_(false));
  check('refuses to email a winner before one is drawn', noWinnerYet.ok === false);
  check('and says why', /No winner has been drawn/.test(noWinnerYet.message));

  at(AFTER, () => s.raffleDrawWinner_(false));
  const winnerMail = () => s.__sent.filter(m => /You won/i.test(m.subject));
  eq('the draw does NOT email the winner', winnerMail().length, 0);
  eq('the draw DOES email Durand and Ryan', drawMail(s).length, 1);

  const sent = at(AFTER, () => s.raffleSendWinnerEmail_(false));
  check('the winner email sends when explicitly asked', sent.ok === true, sent.message);
  eq('exactly one winner email', winnerMail().length, 1);
  const m = winnerMail()[0];
  // Two people are in this draw -- the entrant and the referral who consented --
  // so read the winner from the result rather than assuming it.
  const drawn = JSON.parse(s.__props.RAFFLE_WINNER_JSON);
  eq('addressed to the winner', m.to, drawn.winner.email);
  check('and that is one of the two people in it',
    ['dana@mail-test.co', 'robin@mail-test.co'].indexOf(m.to) !== -1, m.to);
  check('Durand and Ryan are copied', String(m.cc).indexOf('durand@thestawaszgroup.com') !== -1 &&
    String(m.cc).indexOf('ryan@') !== -1, String(m.cc));
  // Ryan fields winner replies, per Durand 2026-09-17 — not info@, which five
  // people share and nobody owns.
  check('replies go to Ryan', /ryan@tsg\.homes/.test(String(m.replyTo)), String(m.replyTo));
  check('and to the shared inbox as well', /info@tsg\.homes/.test(String(m.replyTo)),
    String(m.replyTo));
  // Durand: "there is no hat." Word-boundary matched, or this passes on "that".
  check('the email does not claim there was a hat',
    !/\bhats?\b/i.test(m.htmlBody + m.body));
  check('it says the draw was at random', /drawn at random/i.test(m.htmlBody));
  check('the subject says they won', /You won/.test(m.subject));
  check('it is an HTML email', !!m.htmlBody && m.htmlBody.indexOf('<div') === 0);
  check('with a plain-text alternative for text-only clients', !!m.body && m.body.length > 100);
  check('the HTML names the prize', /\$300/.test(m.htmlBody));
  check('the HTML says how to claim it', /\(215\) 760-6291/.test(m.htmlBody));
  check('the HTML carries the non-affiliation disclaimer',
    /not sponsored, endorsed by, or associated with Ticketmaster/.test(m.htmlBody));
  check('the plain text carries it too',
    /not sponsored, endorsed by, or associated/.test(m.body));

  const again = at(AFTER, () => s.raffleSendWinnerEmail_(false));
  check('it cannot be sent twice by accident', again.ok === false && again.alreadySent === true);
  eq('still exactly one winner email', winnerMail().length, 1);
  check('and it says how to deliberately resend', /script property/.test(again.message));
}

// The winner's name came from a public text box like everything else.
{
  const s = makeSandbox();
  const payload = '<img src=x onerror=alert(1)>';
  enterFull(s, entry({ fullName: payload + ' Winner' }), DURING);
  at(AFTER, () => s.raffleDrawWinner_(false));
  at(AFTER, () => s.raffleSendWinnerEmail_(false));
  const m = s.__sent.filter(x => /You won/i.test(x.subject)).pop();
  check('winner email produced (setup)', !!m);
  check('the winner email does not carry the raw payload',
    !!m && m.htmlBody.indexOf(payload) === -1, 'raw payload in the winner email');
  check('and emits no injected tag',
    !!m && !/<(script|img|svg|iframe|object|embed)\b/i.test(m.htmlBody));
}

// ---- The draw console --------------------------------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'secret', RAFFLE_SHEET_ID: 'sheet1',
                                   FUB_API_KEY: 'key' } });
  ['a', 'b', 'c', 'd'].forEach((n, i) => enterFull(s, entry({
    fullName: 'Person ' + n, email: n + '@mail-test.co', phone: '(215) 555-820' + i
  }), DURING, {
    referral: { referralName: 'Ref ' + n.toUpperCase() + ' Person',
                referralEmail: 'cref' + n + '@mail-test.co',
                referralPhone: '(215) 555-93' + (10 + i) }
  }));
  const drawn = at(AFTER, () => s.raffleDrawWinner_(false));
  check('draw ran (setup)', drawn.ok === true, JSON.stringify(drawn));

  // The draw record has to carry enough to build the FUB links and show the referral.
  // A pick may legitimately be a SELF entry with no referral attached, so the
  // assertion is that the field exists and is carried, not that it is populated.
  check('the draw record carries a referral field for each pick',
    'referralName' in drawn.result.winner, JSON.stringify(drawn.result.winner));
  check('and at least one pick has a referral on it',
    [drawn.result.winner].concat(drawn.result.backups).some(p => !!p.referralName));
  eq('and two alternates', drawn.result.backups.length, 2);

  // The 6:15 email is HTML now, with all three picks and a console link.
  const ops = drawMail(s).pop();
  check('the result email is HTML', !!ops.htmlBody);
  check('it keeps a plain-text alternative', !!ops.body && ops.body.length > 100);
  check('it shows all three picks',
    /PICK 1/.test(ops.htmlBody) && /PICK 2/.test(ops.htmlBody) && /PICK 3/.test(ops.htmlBody));
  check('it links into FUB', /followupboss\.com\/2\/people\/view\//.test(ops.htmlBody));
  check('it names who each pick referred', /Referred/.test(ops.htmlBody));
  // "looking to seller" was the first render's copy bug. The role is a noun in
  // FUB and a verb in prose.
  check('the role reads as a verb, not a noun',
    /looking to (buy|sell)\b/.test(ops.htmlBody) && !/looking to (buyer|seller)/.test(ops.htmlBody));
  check('it links to the draw console', /action=console/.test(ops.htmlBody));
  check('it says nothing has been sent to the winner yet',
    /Nothing has been sent to the winner yet/.test(ops.htmlBody));

  // The console page itself is key-gated exactly like the other admin endpoints.
  const noKey = String(at(AFTER, () => s.raffleServeForm_({ parameter: { action: 'console' } }, 'u')));
  const badKey = String(at(AFTER, () => s.raffleServeForm_({ parameter: { action: 'console', key: 'guess' } }, 'u')));
  check('console refuses with no key', /Not found/.test(noKey));
  check('console refuses with a wrong key', /Not found/.test(badKey));
  check('and the two refusals are identical', noKey === badKey);

  const page = String(at(AFTER, () => s.raffleServeForm_(
    { parameter: { action: 'console', key: 'secret' } }, 'u')));
  check('the console renders all three picks',
    /PICK 1/.test(page) && /PICK 2/.test(page) && /PICK 3/.test(page), page.slice(0, 200));
  check('with radio inputs to choose between them', /name="pick"/.test(page));
  check('and FUB links for the referral too', /Open the referral in FUB/.test(page));

  // A console POST is gated on the same key.
  const forged = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'send', pick: 0, key: 'guess' })));
  check('a console POST with a wrong key is refused', forged.ok === false);
  check('and gives nothing away', /Not found/.test(String(forged.error)));

  // Preview must come from the same function that sends.
  const prev = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'preview', pick: 0, key: 'secret' })));
  check('preview returns the real winner email HTML', prev.ok === true && /\$300/.test(prev.html));
  eq('preview names the pick it is for', prev.pick, 0);

  // Picks 2 and 3 need a written reason. This is the draw-integrity gate.
  const noReason = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'send', pick: 1, key: 'secret', reason: 'nope' })));
  check('sending to an alternate without a real reason is refused', noReason.ok === false);
  check('and the refusal explains why', /drawn at random/.test(String(noReason.error)));
  eq('nothing was emailed', s.__sent.filter(m => /You won/i.test(m.subject)).length, 0);

  const withReason = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'send', pick: 1, key: 'secret',
    reason: 'pick 1 is a TSG agent and is not eligible' })));
  check('with a reason it sends', withReason.ok === true, JSON.stringify(withReason));
  check('and the confirmation flags that it was not the drawn winner',
    /not the drawn winner/.test(String(withReason.message)));
  const won = s.__sent.filter(m => /You won/i.test(m.subject));
  eq('exactly one winner email', won.length, 1);
  check('addressed to the alternate, not the drawn winner',
    won[0].to === drawn.result.backups[0].email, won[0].to);
  check('the reason is recorded', /TSG agent/.test(String(s.__props.RAFFLE_PICK_REASON)));
}

// ---- Emergency redraw ---------------------------------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'secret', RAFFLE_SHEET_ID: 'sheet1',
                                   FUB_API_KEY: 'key' } });
  ['a', 'b', 'c'].forEach((n, i) => enterFull(s, entry({
    fullName: 'Redraw ' + n, email: 'rd' + n + '@mail-test.co', phone: '(215) 555-830' + i
  }), DURING, {
    referral: { referralName: 'RdRef ' + n, referralEmail: 'rdref' + n + '@mail-test.co',
                referralPhone: '(215) 555-94' + (10 + i) }
  }));
  at(AFTER, () => s.raffleDrawWinner_(false));

  const thin = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'redraw', key: 'secret', reason: 'oops' })));
  check('a redraw without a real reason is refused', thin.ok === false);

  const before = JSON.parse(s.__props.RAFFLE_WINNER_JSON).winner.name;
  const re = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'redraw', key: 'secret',
    reason: 'drawn winner turned out to be a TSG agent' })));
  check('a redraw with a reason works', re.ok === true, JSON.stringify(re));
  check('a fresh winner is recorded', !!s.__props.RAFFLE_WINNER_JSON);
  check('the previous result is written to the draw tab as an audit row',
    JSON.stringify(s.__tabs).indexOf('REDRAWN') !== -1);
  check('and the audit row carries the reason given',
    JSON.stringify(s.__tabs).indexOf('turned out to be a TSG agent') !== -1);

  // Once the winner has been told, a redraw is a phone call, not a button.
  at(AFTER, () => s.raffleSendWinnerEmail_(false));
  const late = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'console', consoleAction: 'redraw', key: 'secret',
    reason: 'changed my mind about the whole thing' })));
  check('a redraw AFTER the winner was emailed is refused', late.ok === false);
  check('and says why in human terms', /phone call/.test(String(late.error)));
}

// ---- The invite has to give the REFERRAL a reason to open it ------------------
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  enterFull(s, entry(), DURING, { skipConsent: true });
  const inv = s.__sent.filter(m => /referred you/i.test(m.subject));
  eq('the invite was sent', inv.length, 1);
  check('the subject leads with what they get',
    /in the \$300 drawing too/.test(inv[0].subject), inv[0].subject);
  check('the body says confirming enters them',
    /Confirming enters you in the drawing too/.test(inv[0].htmlBody));
  check('and the plain-text twin says it too',
    /CONFIRMING ENTERS YOU IN THE DRAWING TOO/.test(inv[0].body));
  check('it still says what the referrer gets',
    /5 extra entries to them/.test(inv[0].htmlBody));
  check('and that they need not attend', /not[\s\S]{0,30}at the party to win/.test(inv[0].htmlBody));
}

// ---- Consenting enters the referral too ---------------------------------------
// The one thing that can sink the design is a referral with no reason of their
// own to click: confirming used to buy them nothing but somebody else's five
// entries. Now the same box enters them, and the page says so before they tick it.
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const v = verifySession(s, entry(), DURING);
  const staged = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid }, referral({})))));
  check('referral staged (setup)', !!staged.staged, JSON.stringify(staged));

  const page = String(at(DURING, () => s.raffleConsentPage_({ parameter: { t: staged.token } })));
  // Every text field must carry a type, or it misses the stylesheet's selector
  // and renders inline and unstyled beside its label while its neighbours are
  // full-width boxes. That shipped on the name field and was only visible in a
  // real render, so it is asserted here rather than left to the eye.
  const fields = page.match(/<input id="r[A-Za-z]+"[^>]*>/g) || [];
  check('the consent page renders its fields (guards a vacuous test)',
    fields.length >= 3, JSON.stringify(fields));
  check('every consent field declares a type',
    fields.every(f => /\stype=/.test(f)), JSON.stringify(fields.filter(f => !/\stype=/.test(f))));
  check('the consent page promises them an entry',
    /Confirming enters you in the drawing too/.test(page), page.slice(0, 1400));
  check('and the box carries the 18+ and US-resident attestation',
    /18 or over and a legal U\.S\. resident/.test(page));
  check('and agreement to the Official Rules', /agree to the[\s\S]{0,120}Official Rules/.test(page));
  eq('nobody is entered by merely opening the page', selfRows(s).length, 1);

  J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: 'Robin Vale', referralPhone: '(215) 555-9001',
    referralRole: 'Buyer', referralTimeframe: '7-12 Months' })));
  eq('consenting writes their own entry', selfRows(s).length, 2);
  const theirs = selfRows(s).filter(r => cell(s, r, 'Email') === 'robin@mail-test.co');
  eq('one row, in their name', theirs.length, 1);
  eq('and it is eligible at once', cell(s, theirs[0], 'Entry Status'), 'eligible');
  check('with their own consent version stamped',
    cell(s, theirs[0], 'Consent Version').length > 0);

  const drawn = at(AFTER, () => s.raffleDrawWinner_(false));
  eq('two people in the draw', drawn.result.totalPeople, 2);
  // Dana: 1 own + 5 bonus. Robin: 1 own.
  eq('seven tickets between them', drawn.result.totalTickets, 7);
}

{
  // After the close the page still works -- we want the contact record -- but it
  // must not promise an entry it cannot give, and must not ask them to accept
  // the rules of a drawing that is over.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const v = verifySession(s, entry(), DURING);
  const staged = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid }, referral({})))));
  const page = String(at(AFTER, () => s.raffleConsentPage_({ parameter: { t: staged.token } })));
  check('after the close the page promises no entry',
    !/enters you in the drawing/.test(page), page.slice(0, 1400));
  check('and asks for no rules attestation', !/Official Rules/.test(page));

  const late = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: 'Robin Vale', referralPhone: '(215) 555-9001',
    referralRole: 'Buyer', referralTimeframe: '7-12 Months' })));
  check('late consent still records', late.ok === true, JSON.stringify(late));
  eq('but enters nobody', selfRows(s).length, 1);
}

// ---- The live suite's own new assertions -------------------------------------
{
  // Two of the live suite's checks are about the mail service rather than the
  // code, so they can only be trusted if the fake can fail them. Prove the
  // quota-delta assertion is real by starving the account.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const before = s.MailApp.getRemainingDailyQuota();
  check('the sandbox models a send quota', before > 0, String(before));
  at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry())));
  check('and sending a code moves it', s.MailApp.getRemainingDailyQuota() < before,
    before + ' -> ' + s.MailApp.getRemainingDailyQuota());

  const starved = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1' }, quota: 0 });
  eq('a starved account reports zero', starved.MailApp.getRemainingDailyQuota(), 0);
}

// ---- Migrating a sheet that predates the referral columns --------------------
// Not hypothetical: the live sheet on 2026-09-17 still carried the original 11
// columns, because it was created before the referral work and setupRaffle only
// reported that it already existed. Every access has to widen it, and setup has
// to do it up front rather than on the first real entrant's request.
{
  const ELEVEN = ['Timestamp (ET)', 'Full Name', 'Email', 'Phone', 'Consent',
                  'Consent Version', 'Entry Source', 'FUB Status', 'FUB Person ID',
                  'Eligible', 'Email Verified'];
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' },
                          rows: [ELEVEN.slice()] });
  const hdr = () => s.__tabs['Entries'].rows[0];
  const WIDTH = s.RAFFLE_SHEET_HEADERS.length;
  // Guards this whole block: the harness fixture now matches the code's schema,
  // so if the two ever drift the migration test stops meaning anything.
  eq('the fixture matches the code schema', HEADERS.length, WIDTH);
  eq('the tab starts on the old schema', hdr().length, 11);

  // Merely touching the sheet migrates it -- reads included.
  at(DURING, () => s.raffleStatusPage_(false));
  eq('touching the sheet widens it', hdr().length, WIDTH);
  check('the original columns are untouched',
    ELEVEN.every((h, i) => hdr()[i] === h), JSON.stringify(hdr().slice(0, 11)));
  check('and the referral columns are named',
    hdr()[11] === 'Entry Status' && hdr().indexOf('Reminder Sent At') !== -1,
    JSON.stringify(hdr().slice(11)));

  // And a full journey then works on the migrated tab.
  const res = enterFull(s, entry(), DURING);
  check('a journey works on a migrated sheet', res.ok === true, JSON.stringify(res));
  eq('writing three rows as usual', s.__data().length, 3);
  eq('and the entrant is eligible',
    selfRows(s).filter(r => cell(s, r, 'Entry Status') === 'eligible').length, 2);
}

{
  // setupRaffle has to REPORT the migration it just did. Measuring the width
  // through raffleSheet_ reported "up to date" in the same call that added
  // fourteen columns, because raffleSheet_ migrates before it returns.
  const ELEVEN = ['Timestamp (ET)', 'Full Name', 'Email', 'Phone', 'Consent',
                  'Consent Version', 'Entry Source', 'FUB Status', 'FUB Person ID',
                  'Eligible', 'Email Verified'];
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' },
                          rows: [ELEVEN.slice()] });
  const msg = String(at(BEFORE, () => s.setupRaffle()));
  check('setup reports the migration it performed',
    /Schema migrated: 11 -> 25 columns/.test(msg), msg);
  check('and not that nothing changed', !/Schema up to date/.test(msg), msg);

  // A sheet already on the current schema reports the truth too.
  const s2 = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const msg2 = String(at(BEFORE, () => s2.setupRaffle()));
  check('a current sheet reports up to date', /Schema up to date \(25 columns\)/.test(msg2), msg2);
  check('and claims no migration', !/Schema migrated/.test(msg2), msg2);
}

{
  // A tab whose columns were RENAMED must be refused, not silently reindexed:
  // the reader addresses columns by position, so a shifted sheet would attribute
  // one person's consent to another.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1' },
                          rows: [['Timestamp (ET)', 'Name', 'Email']] });
  let err = '';
  try { at(DURING, () => s.raffleStatusPage_(false)); } catch (e) { err = String(e.message || e); }
  check('a renamed column refuses to migrate', /Refusing to migrate/.test(err), err);
  check('and the error names the column', /column 2/.test(err), err);
}

// ---- The admin status page ----------------------------------------------------
{
  // raffleReadEntries_ hands back every row, pending ones included, so the
  // headline number is computed. It used to be rows.length under the label
  // "eligible entries", which counted referrals nobody had consented to.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  enterFull(s, entry(), DURING);            // Dana 1+5, Robin 1 for consenting
  enterFull(s, entry({ fullName: 'Pending Person', email: 'pend@mail-test.co',
                       phone: '(215) 555-8600' }), DURING, {
    skipConsent: true,
    referral: { referralName: 'PRef Person', referralEmail: 'pref@mail-test.co',
                referralPhone: '(215) 555-9600' } });                // +1 person, +1 ticket

  const page = String(at(DURING, () => s.raffleStatusPage_(false)));
  // Four rows, three people: the sheet has more rows than people and the page
  // has to say the smaller, true number.
  eq('five rows on the sheet', s.__data().length, 5);
  check('the status page counts people, not rows', />3</.test(page), page.slice(0, 1100));
  check('and says they are people', /people entered/.test(page));
  check('and reports the ticket count', /8 tickets in the draw/.test(page), page.slice(0, 1100));
  check('and reports what is still pending',
    /1 referral\(s\) still pending/.test(page), page.slice(0, 1100));
  check('and what that pending referral is worth', /worth 5 more/.test(page));
  check('it no longer calls a pending row eligible',
    !/>5<[\s\S]{0,80}people entered/.test(page), page.slice(0, 1100));
}

// ---- Entry notifications -------------------------------------------------------
{
  // Before the party: one email every 10 VALID entries. Pending rows must not count.
  const s = makeSandbox();
  const note = () => s.__sent.filter(m => /(entries|people) in the Block Party raffle/.test(m.subject));
  // The milestone counts PEOPLE, not rows. Nine people who entered and referred
  // nobody: nine rows, nine people, no email. (A full journey enters TWO people
  // and writes three rows, so driving this with full journeys would tell us
  // nothing about which of the two the code counts.)
  for (let i = 0; i < 9; i++) {
    verifySession(s, entry({ fullName: 'Early Person ' + i, email: 'e' + i + '@mail-test.co',
                             phone: '(215) 555-84' + (10 + i) }), BEFORE);
  }
  eq('no milestone email at 9 people', note().length, 0);
  eq('and nine rows, one each', s.__data().length, 9);

  // The tenth person refers somebody who confirms, so the same action crosses
  // the milestone AND lands a bonus: 11 people, 15 tickets.
  enterFull(s, entry({ fullName: 'Early Person 9', email: 'e9@mail-test.co',
                       phone: '(215) 555-8499' }), BEFORE, {
    referral: { referralName: 'ERef Person', referralEmail: 'eref9@mail-test.co',
                referralPhone: '(215) 555-9599' } });
  eq('one milestone email at 10 people', note().length, 1);
  check('it reports the count in people, not rows', /10 people/.test(note()[0].subject),
    note()[0].subject);
  check('and never calls twenty rows twenty entries', !/20/.test(note()[0].subject),
    note()[0].subject);
  // Three numbers, because one alone is misleading once a referral is worth five.
  check('it reports how many people are in', /10 people are entered/.test(note()[0].body),
    note()[0].body.slice(0, 160));
  // 10, not 15: the milestone fires the moment the tenth PERSON verifies, which
  // is before their referral has replied. Ten own entries, no bonus yet.
  check('it reports the ticket count', /10 tickets in the draw/.test(note()[0].body),
    note()[0].body.slice(0, 200));
  check('it explains the multiplier', /5 more entries/.test(note()[0].body),
    note()[0].body.slice(0, 400));
  check('it says when the next one comes', /Next note at 20 people/.test(note()[0].body));

  // A PENDING referral must not count toward the next milestone. The entrant's
  // own entry does count -- they are genuinely entered -- so the twelfth and
  // thirteenth people still do not reach twenty.
  enterFull(s, entry({ fullName: 'Pending Person', email: 'pend@mail-test.co',
                       phone: '(215) 555-8600' }), BEFORE, {
    skipConsent: true,
    referral: { referralName: 'PRef Person', referralEmail: 'pref@mail-test.co',
                referralPhone: '(215) 555-9600' } });
  eq('a twelfth person does not reach the next milestone', note().length, 1);

  // And it does not re-fire on the same milestone.
  eq('still only one milestone email', note().length, 1);
}

{
  // During the party the hourly digest takes over and the milestone email goes quiet,
  // so Durand is not double-notified while standing in a street.
  const s = makeSandbox();
  for (let i = 0; i < 10; i++) {
    enterFull(s, entry({ fullName: 'Party ' + i, email: 'p' + i + '@mail-test.co',
                         phone: '(267) 555-86' + (10 + i) }), DURING, {
      referral: { referralName: 'PRef ' + i, referralEmail: 'pref' + i + '@mail-test.co',
                  referralPhone: '(267) 555-96' + (10 + i) } });
  }
  eq('no milestone emails during the party', 
    s.__sent.filter(m => /(entries|people) in the Block Party raffle/.test(m.subject)).length, 0);

  at(DURING, () => s.raffleEventDigest());
  const digest = s.__sent.filter(m => /min to the draw|entries closed/.test(m.subject));
  eq('the hourly digest sends during the party', digest.length, 1);
  check('it reports the valid count', /valid entries/.test(digest[0].body), digest[0].body.slice(0, 120));
  check('it counts down to the draw', /minutes \(6:15 PM\)/.test(digest[0].body));
  check('it goes to Durand only', digest[0].to === 'durand@thestawaszgroup.com');

  // Outside the window it must stay silent, so a surviving trigger does not mail
  // anybody on Monday.
  const s2 = makeSandbox();
  at(BEFORE, () => s2.raffleEventDigest());
  eq('the digest is silent before the party', s2.__sent.length, 0);
}

// ---- Referrals reach FUB only when they consent -------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const v = verifySession(s, entry(), DURING);
  const creates = () => s.__fetches.filter(f => /\/v1\/people$/.test(f.url) &&
                                                f.o && f.o.method === 'post');
  eq('verifying creates the ENTRANT in FUB', creates().length, 1);

  J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid }, referral({})))));
  eq('naming a referral creates NOBODY in FUB', creates().length, 1);
  eq('two rows: their own entry and the pending referral', s.__data('Entries').length, 2);
  check('and the referral row carries the entrant FUB id for later linking',
    cell(s, refRows(s)[0], 'FUB Person ID').length > 0,
    cell(s, refRows(s)[0], 'FUB Person ID'));

  const token = cell(s, refRows(s)[0], 'Consent Token');
  J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: token, consent: 'Yes',
    referralName: 'Robin Vale', referralPhone: '(215) 555-9001',
    referralRole: 'Buyer', referralTimeframe: '7-12 Months' })));
  eq('consenting is what creates the referral', creates().length, 2);
  const refBody = JSON.parse(creates()[1].o.payload);
  check('created with consent recorded', /CONSENT GIVEN BY THIS PERSON/.test(refBody.background));
  const links = s.__fetches.filter(f => /peopleRelationships/.test(f.url));
  eq('and only now are they linked to the referrer', links.length, 2);
}

// ---- The draw sweeps up everyone who never answered ---------------------------
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  // One who confirms, one who never does.
  enterFull(s, entry(), DURING);
  enterFull(s, entry({ fullName: 'Quiet Entrant', email: 'quiet@mail-test.co',
                       phone: '(267) 555-8400' }), DURING, {
    skipConsent: true,
    referral: { referralName: 'Silent Person', referralEmail: 'silent@mail-test.co',
                referralPhone: '(215) 555-9400' } });
  const before = s.__fetches.filter(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post').length;

  const drawn = at(AFTER, () => s.raffleDrawWinner_(false));
  // Four eligible rows: both entrants' own entries, the one confirmed referral,
  // and that referral's own entry from consenting. The unanswered referral is
  // NOT among them, and neither is an own entry for the person who never replied.
  check('the draw sees three own entries and the one confirmed referral',
    drawn.ok && drawn.result.totalEligible === 4,
    JSON.stringify(drawn && drawn.result && drawn.result.totalEligible));
  eq('which is three people', drawn.result.totalPeople, 3);
  // Dana 1 + 5, Robin 1 for consenting, the quiet entrant 1 because theirs
  // never replied. The silent person gets nothing at all.
  eq('and eight tickets, not thirteen', drawn.result.totalTickets, 8);

  const after = s.__fetches.filter(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post');
  eq('the silent referral is swept into FUB by the draw', after.length, before + 1);
  const swept = JSON.parse(after[after.length - 1].o.payload);
  check('flagged as needing consent', swept.tags.indexOf('Needs Consent') !== -1,
    JSON.stringify(swept.tags));
  check('flagged as unconfirmed contact info',
    swept.tags.indexOf('Unconfirmed Contact Info') !== -1, JSON.stringify(swept.tags));
  check('and the record says plainly it has no consent',
    /HAS GIVEN NO CONSENT/.test(swept.background), swept.background.slice(0, 200));
  check('and says not to work it', /DO NOT call, text or drip/.test(swept.background));
  // The referrer IS entered — that is the point of the change — but they got no
  // bonus for a referral who never answered.
  check('the quiet referrer is still entered themselves',
    s.__data().some(r => cell(s, r, 'Full Name') === 'Quiet Entrant' &&
                         cell(s, r, 'Entry Status') === 'eligible'));
  check('but their unanswered referral earned them nothing',
    s.__data().some(r => cell(s, r, 'Referral Name') === 'Silent Person' &&
                         cell(s, r, 'Entry Status') === 'pending-consent'));

  // Idempotency has to be tested on the SWEEP itself, not by drawing twice: the
  // draw is once-only, so a second raffleDrawWinner_ returns the stored result and
  // never reaches the sweep at all. Calling it that way passed happily with the
  // duplicate guard deleted — a vacuous test.
  at(AFTER, () => s.raffleLogUnconfirmedReferrals_(false));
  at(AFTER, () => s.raffleLogUnconfirmedReferrals_(false));
  eq('running the sweep again creates nobody twice',
    s.__fetches.filter(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post').length,
    before + 1);
  check('the swept row records when it was logged',
    refRows(s).some(r => cell(s, r, 'Referral Logged At').length > 0));
}

// ---- The referral chain --------------------------------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  enterFull(s, entry(), DURING);

  const chainMail = s.__sent.filter(m => /you can win/i.test(m.subject));
  eq('a confirmed referral is invited to enter too', chainMail.length, 1);
  eq('sent to the person who confirmed', chainMail[0].to, 'robin@mail-test.co');
  check('it says they need not re-enter their own details',
    /nothing to fill in about yourself/i.test(chainMail[0].htmlBody));
  // The & is HTML-escaped in an href, which is correct markup -- match the parts.
  check('it carries a chain link',
    /action=refer/.test(chainMail[0].htmlBody) && /t=[0-9a-f-]{36}/.test(chainMail[0].htmlBody));
  check('chain-invite replies reach the referrer and the shared inbox',
    /dana@mail-test\.co/.test(String(chainMail[0].replyTo)) &&
    /info@tsg\.homes/.test(String(chainMail[0].replyTo)), String(chainMail[0].replyTo));

  const chainToken = cell(s, refRows(s)[0], 'Chain Token');
  check('the chain token is on the row', /^[0-9a-fA-F-]{36}$/.test(chainToken), chainToken);

  // The link opens the form already past verification.
  const page = String(at(DURING, () => s.raffleServeForm_(
    { parameter: { action: 'refer', t: chainToken } }, 'u')));
  check('the chain link serves the entry form', page.length > 1000);

  // Opening the chain link ENTERS them, before they refer anybody. They proved
  // their inbox by clicking a link only it received, so they get the same single
  // ticket the code path gives -- otherwise the email says "you can enter too"
  // and hands them a referral form that enters them only if someone else replies.
  check('opening the chain link enters them on the spot',
    selfRows(s).some(r => cell(s, r, 'Full Name') === 'Robin Vale' &&
                          cell(s, r, 'Entry Status') === 'eligible'),
    JSON.stringify(selfRows(s).map(r => cell(s, r, 'Full Name'))));
  const selfCount = selfRows(s).length;
  at(DURING, () => s.raffleServeForm_({ parameter: { action: 'refer', t: chainToken } }, 'u'));
  eq('and opening it twice does not enter them twice', selfRows(s).length, selfCount);
  const vidLine = (page.match(/var\s+CHAIN_VID\s*=\s*(.*?);/) || [])[1];
  check('with a session already minted', !!vidLine && JSON.parse(vidLine).length === 36, vidLine);
  check('and greets them by name',
    JSON.parse((page.match(/var\s+CHAIN_FIRST\s*=\s*(.*?);/) || [])[1]) === 'Robin');

  // That session can refer somebody, creating a second entry in Robin's name.
  const vid = JSON.parse(vidLine);
  const chained = J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'referral', vid: vid, consent: 'Yes',
    referralName: 'Third Person', referralEmail: 'third@mail-test.co',
    referralPhone: '(215) 555-9500', referralRole: 'Seller',
    referralTimeframe: '0-3 Months' })));
  check('a chain entrant can refer somebody', chained.ok === true && chained.staged === true,
    JSON.stringify(chained));
  check('which adds rows for them', s.__data('Entries').length > 2,
    'rows=' + s.__data('Entries').length);
  check('with the confirmed referral as the entrant',
    s.__data().some(r => cell(s, r, 'Full Name') === 'Robin Vale'),
    JSON.stringify(s.__data().map(r => cell(s, r, 'Full Name'))));
}

{
  // Durand: "no new entry emails get sent after the draw."
  //
  // The scenario that matters is a referral who was named in time and replies
  // LATE: the consent page still works (we want their details and their consent
  // in FUB), but there is nothing left for them to enter, so inviting them to
  // refer somebody would be a lie.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const v = verifySession(s, entry(), DURING);
  const staged = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'referral', vid: v.vid }, referral({})))));
  check('staged before the close (setup)', !!staged.staged, JSON.stringify(staged));

  const late = J(at(AFTER, () => s.raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: 'Robin Vale', referralPhone: '(215) 555-9001',
    referralRole: 'Buyer', referralTimeframe: '7-12 Months' })));
  check('late consent still works', late.ok === true, JSON.stringify(late));
  check('and is honest that it missed the draw', late.closed === true);
  check('their details still reach FUB',
    s.__fetches.some(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post' &&
      /robin@mail-test\.co/.test(String(f.o.payload))));
  eq('but no chain invite is sent after the draw',
    s.__sent.filter(m => /you can win/i.test(m.subject)).length, 0);
  check('and no chain token is minted', cell(s, refRows(s)[0], 'Chain Token') === '',
    cell(s, refRows(s)[0], 'Chain Token'));
  check('and the referral row did not become an entry',
    cell(s, refRows(s)[0], 'Entry Status') !== 'eligible',
    cell(s, refRows(s)[0], 'Entry Status'));
}

{
  // And after the close nothing can even be staged.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  const r = enterFull(s, entry(), AFTER);
  check('a fresh entry after the close is refused', !(r && r.ok), JSON.stringify(r));
  eq('and writes no row', s.__data('Entries').length, 0);
}

// ---- The last-chance consent reminder ------------------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  // One who confirmed, one who has not.
  enterFull(s, entry(), DURING);
  enterFull(s, entry({ fullName: 'Waiting Entrant', email: 'waiting@mail-test.co',
                       phone: '(267) 555-8500' }), DURING, {
    skipConsent: true,
    referral: { referralName: 'Unsure Person', referralEmail: 'unsure@mail-test.co',
                referralPhone: '(215) 555-9600' } });
  const reminders = () => s.__sent.filter(m => /^Last chance/.test(m.subject));

  // Before the batch time: nothing, however close it is.
  const early = at(BEFORE, () => s.raffleSendConsentReminders_(false));
  eq('no reminders before the batch time', reminders().length, 0);
  check('and it says when they go', /all at once/.test(early.summary), early.summary);
  const nearly = at(new Date('2026-09-19T16:30:00-04:00').getTime(),
                    () => s.raffleSendConsentReminders_(false));
  eq('still nothing half an hour before the batch', reminders().length, 0);
  check('still explained', /Not yet/.test(nearly.summary), nearly.summary);

  // Too late: minutes to go, the email cannot change anything.
  const late = at(new Date('2026-09-19T18:05:00-04:00').getTime(),
                  () => s.raffleSendConsentReminders_(false));
  eq('no reminders in the last minutes', reminders().length, 0);
  check('and it says why', /Too late/.test(late.summary), late.summary);

  // At the batch time: everything goes at once.
  const res = at(new Date('2026-09-19T17:00:00-04:00').getTime(),
                 () => s.raffleSendConsentReminders_(false));
  eq('the batch sends at the batch time', reminders().length, 1);
  // The subject has to give the REFERRAL a reason. "X is counting on it" is a
  // guilt appeal on somebody else's behalf, which is the ask they ignored once.
  check('the reminder subject leads with what they get',
    /in the \$300 drawing/.test(reminders()[0].subject), reminders()[0].subject);

  // The other half of the 5pm batch: the referrer gets told to nudge, because at
  // 5pm they are at the party with their phone.
  const nudges = s.__sent.filter(m => /nudge would do it|have not confirmed yet/.test(m.subject));
  eq('the waiting referrer is nudged too', nudges.length, 1);
  eq('addressed to the referrer', nudges[0].to, 'waiting@mail-test.co');
  check('it names who has gone quiet', /Unsure Person/.test(nudges[0].htmlBody));
  check('it tells them a text beats anything we send', /one text|check your email/i.test(nudges[0].htmlBody));
  check('it does not ask them to do our job', /link is in their inbox/.test(nudges[0].htmlBody));
  check('and Durand is bcc\'d on that too',
    String(nudges[0].bcc || '').indexOf('durand@') !== -1, String(nudges[0].bcc));
  eq('and the sweep counts it', res.nudged, 1);
  eq('sent to the referral who has not answered', reminders()[0].to, 'unsure@mail-test.co');
  check('never to one who already confirmed',
    reminders().every(m => m.to !== 'robin@mail-test.co'));
  eq('and the sweep reports it', res.sent, 1);

  // It is a real HTML email and says the things that make it actionable.
  const m = reminders()[0];
  check('it is HTML', !!m.htmlBody && m.htmlBody.indexOf('<div') === 0);
  check('with a plain-text alternative', !!m.body && m.body.length > 150);
  check('it names the referrer', /Waiting Entrant/.test(m.htmlBody));
  check('it carries the consent link', /action=consent/.test(m.htmlBody));
  check('it says when the draw is', /6:15 PM/.test(m.htmlBody));
  check('and how little time is left, in words',
    /\b(minutes|hours)\b/.test(m.htmlBody), 'no human time phrase');
  // Durand on every public-facing email, BCC so a stranger never sees an internal
  // address (2026-09-17).
  check('Durand is bcc\'d, not cc\'d',
    String(m.bcc || '').indexOf('durand@thestawaszgroup.com') !== -1 &&
    String(m.cc || '').indexOf('durand@') === -1, 'bcc=' + m.bcc + ' cc=' + m.cc);
  check('it offers the decline route too', /button for that|Would rather we did not/.test(m.htmlBody));
  check('it promises not to nag again', /only reminder/.test(m.htmlBody));
  // The nudge has to give THEM a reason, not just report somebody else's loss.
  check('it says they are not in the drawing yet',
    /not in our[\s\S]{0,80}drawing/.test(m.htmlBody), m.htmlBody.slice(0, 900));
  check('and that confirming enters them both',
    /enters you both/.test(m.htmlBody), m.htmlBody.slice(0, 900));
  check('the plain-text twin says it too', /enters you both/.test(m.body), m.body.slice(0, 600));
  // Durand, 2026-09-17: a reply must reach BOTH the referrer and the shared inbox.
  check('replies reach the person who referred them',
    String(m.replyTo).indexOf('waiting@mail-test.co') !== -1, String(m.replyTo));
  check('and the shared inbox',
    String(m.replyTo).indexOf('info@tsg.homes') !== -1, String(m.replyTo));

  // There is only ever ONE batch: the hourly catch-up must find the marker and do
  // nothing, or reminders would stagger out over the afternoon.
  const again = at(new Date('2026-09-19T17:20:00-04:00').getTime(),
                   () => s.raffleSendConsentReminders_(false));
  at(new Date('2026-09-19T17:40:00-04:00').getTime(),
     () => s.raffleSendConsentReminders_(false));
  eq('the catch-up does not send a second batch', reminders().length, 1);
  check('and says the batch already went', /already went out/.test(again.summary), again.summary);
  check('the batch time is recorded', !!s.__props.RAFFLE_REMINDER_BATCH_AT);
  check('the row records when it went',
    refRows(s).some(r => cell(s, r, 'Reminder Sent At').length > 0));

  // And once someone answers, no reminder can follow.
  const s2 = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
  enterFull(s2, entry(), DURING);
  at(new Date('2026-09-19T17:00:00-04:00').getTime(),
     () => s2.raffleSendConsentReminders_(false));
  eq('a confirmed referral is never reminded',
    s2.__sent.filter(m => /Last chance/.test(m.subject)).length, 0);
}

{
  // The trigger must be armed, or none of the above ever runs.
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1' } });
  at(BEFORE, () => s.setupRaffle());
  const armed = n => s.ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === n).length;
  // One batch trigger at the fixed moment, plus one hourly catch-up.
  eq('the reminder batch and its catch-up are armed', armed('raffleConsentReminderSweep'), 2);
  at(BEFORE, () => s.setupRaffle());
  eq('re-running setup does not accumulate triggers', armed('raffleConsentReminderSweep'), 2);
}

// ---- Admin endpoints are key-gated -----------------------------------------
{
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'secret' } });
  const nokey  = s.raffleServeForm_({ parameter: { action: 'draw' } }, 'u');
  const badkey = s.raffleServeForm_({ parameter: { action: 'draw', key: 'guess' } }, 'u');
  check('draw endpoint refuses a missing key', /Not found/.test(nokey));
  check('draw endpoint refuses a wrong key', /Not found/.test(badkey));
  check('a wrong key is indistinguishable from no key', nokey === badkey);
  check('status endpoint is gated too',
    /Not found/.test(s.raffleServeForm_({ parameter: { action: 'status' } }, 'u')));
  eq('no winner was drawn by an unauthorized probe', s.__props.RAFFLE_WINNER_JSON, undefined);
}


// ---- TEST MODE vs LIVE ---------------------------------------------------
// The whole point of this block: a rehearsal must be impossible to confuse with
// the real thing, in either direction.
{
  const s = makeSandbox({ qaMode: true });

  // 1. The one check test mode relaxes: the entry window.
  const early = enterFull(s, entry(), BEFORE);
  check('test mode: entry accepted OUTSIDE the Sat 3:00-6:15 window', early.ok === true);
  const late = enterFull(s, entry({
    fullName: 'Late Tester', email: 'late@mail-test.co', phone: '(267) 555-8111' }), AFTER,
    { referral: { referralName: 'Late Referral', referralEmail: 'lateref@mail-test.co',
                  referralPhone: '(215) 555-9099' } });
  check('test mode: entry accepted after the 6:15 close too', late.ok === true,
    JSON.stringify(late));

  // 2. Test entries are in their own tab, and the live tab is empty.
  check('test mode: wrote to the "Test Entries" tab', !!s.__tabs['Test Entries']);
  eq('test mode: six rows on the test tab (two journeys)', s.__data('Test Entries').length, 6);
  eq('test mode: LIVE tab still empty', s.__data('Entries').length, 0);

  // 3. Every other check still runs.
  check('test mode does NOT relax consent',
    enterFull(s, entry({ consent: 'No', email: 'x@y.com' }), BEFORE).ok === false);
  check('test mode does NOT relax required fields',
    enterFull(s, entry({ fullName: '', email: 'q@y.com' }), BEFORE).ok === false);
  // One FREE entry per person still holds in test mode: repeating the journey
  // must not mint a second self entry, however many referrals get added.
  const selfBefore = s.__data('Test Entries').filter(r => cell(s, r, 'Referral Name') === '').length;
  enterFull(s, entry(), BEFORE);
  eq('test mode does NOT relax one free entry per person',
    s.__data('Test Entries').filter(r => cell(s, r, 'Referral Name') === '').length, selfBefore);

  // 4. FUB records are marked so nobody mistakes them for leads.
  const people = s.__fetches.filter(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post');
  const body = JSON.parse(people[0].o.payload);
  check('test mode: FUB first name is prefixed', /^\[QA TEST\] /.test(body.firstName));
  check('test mode: FUB record carries the QA tag',
    body.tags.indexOf('QA Test — Safe to Delete') !== -1);
  check('test mode: FUB background flags it as a test',
    /\[QA TEST\]/.test(body.background));
  check('test mode: still carries the real raffle tags',
    body.tags.indexOf('Block Party Raffle Entrant') !== -1);

  // 5. A test draw is a rehearsal: own winner property, own tab, Durand only.
  const tRes = at(AFTER, () => s.raffleDrawWinner_(true));
  check('test draw: succeeds', tRes.ok === true);
  check('test draw: result flagged as a test', tRes.result.test === true);
  // Read the pool off the tab rather than hardcoding names: a referral who
  // consents is now in it too, so any fixed list goes stale the moment the
  // journey above changes.
  check('test draw: winner came from the test pool',
    s.__data('Test Entries').some(r => cell(s, r, 'Email') === tRes.result.winner.email),
    tRes.result.winner.name + ' / ' + tRes.result.winner.email);
  check('test draw: winner is on no LIVE row',
    !s.__data('Entries').some(r => cell(s, r, 'Email') === tRes.result.winner.email));
  check('test draw: recorded under the TEST property', !!s.__props.RAFFLE_TEST_WINNER_JSON);
  check('test draw: LIVE winner property untouched',
    s.__props.RAFFLE_WINNER_JSON === undefined);
  eq('test draw: exactly one email', drawMail(s).length, 1);
  check('test draw: email went to Durand only', drawMail(s)[0].to === 'durand@thestawaszgroup.com');
  check('test draw: Ryan was NOT emailed about a rehearsal', !/ryan@/.test(drawMail(s)[0].to));
  check('test draw: subject is marked as a test', /\[QA TEST\]/.test(drawMail(s)[0].subject));
  check('test draw: body says it is not the real winner',
    /THIS IS A TEST DRAW/.test(drawMail(s)[0].body));
  check('test draw: writes a separate Draw Result (TEST) tab', !!s.__tabs['Draw Result (TEST)']);
  check('test draw: does not write the live Draw Result tab', !s.__tabs['Draw Result']);

  // 6. Having rehearsed, the real draw is still entirely available.
  const liveAfter = at(AFTER, () => s.raffleDrawWinner_(false, true));
  check('a test draw does NOT consume the live draw', liveAfter.alreadyDrawn !== true);
  check('live draw finds no real entries (test ones are not eligible)',
    liveAfter.ok === false && /No eligible entries/.test(liveAfter.error));
}

// A test entry can never be drawn as the real winner, even when both exist.
{
  const s = makeSandbox();
  enterFull(s, entry({
    fullName: 'Real Person', email: 'real@mail-test.co', phone: '(215) 555-8199' }), DURING);
  s.__props.__qa = true;                       // flip to test mode for the next write
  const t = makeSandbox({ qaMode: true });
  // Same spreadsheet shape, so assert on the separation rule directly.
  enterFull(t, entry({
    fullName: 'Fake Tester', email: 'fake@mail-test.co', phone: '(267) 555-8222' }), DURING);
  eq('live sandbox: real entry on the live tab', s.__data('Entries').length, 3);
  eq('test sandbox: nothing on the live tab', t.__data('Entries').length, 0);
  const res = at(AFTER, () => s.raffleDrawWinner_(false, true));
  // The point is the separation, not who wins: the live journey has two people
  // in it now (the entrant and the referral who consented).
  check('live draw picks somebody from the live tab',
    ['Real Person', 'Robin Vale'].indexOf(res.result.winner.name) !== -1,
    res.result.winner.name);
  check('and never the test entrant', res.result.winner.name !== 'Fake Tester');
  eq('live draw pool excludes test entries entirely', res.result.totalPeople, 2);
}

// The 6:15 trigger is hard-wired to the live draw.
{
  const s = makeSandbox({ qaMode: true });
  enterFull(s, entry(), DURING);   // goes to the test tab
  at(AFTER, () => s.raffleScheduledDraw());
  check('scheduled 6:15 draw is ALWAYS live, even under test mode',
    s.__props.RAFFLE_WINNER_JSON === undefined && s.__props.RAFFLE_TEST_WINNER_JSON === undefined);
  check('scheduled draw with no real entries alerts instead of drawing a test one',
    drawMail(s).length === 0);
}

// Resetting test data leaves live data alone.
{
  const s = makeSandbox({ qaMode: true });
  enterFull(s, entry(), DURING);
  at(AFTER, () => s.raffleDrawWinner_(true));
  eq('before reset: test rows present', s.__data('Test Entries').length, 3);
  s.raffleResetTest();
  eq('after reset: test rows cleared', s.__data('Test Entries').length, 0);
  check('after reset: test winner cleared', s.__props.RAFFLE_TEST_WINNER_JSON === undefined);
  check('after reset: Draw Result (TEST) tab removed', !s.__tabs['Draw Result (TEST)']);
}

// Admin endpoints: ?test=1 selects the rehearsal, and is still key-gated.
{
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'secret' } });
  const blocked = s.raffleServeForm_({ parameter: { action: 'draw', test: '1' } }, 'u');
  check('test draw endpoint still requires the admin key', /Not found/.test(blocked));
  const page = s.raffleServeForm_({ parameter: { action: 'status', key: 'secret', test: '1' } }, 'u');
  check('test status page is labelled as test data', /TEST DATA/.test(page));
  const live = s.raffleServeForm_({ parameter: { action: 'status', key: 'secret' } }, 'u');
  check('live status page carries no test label', !/TEST DATA/.test(live));
}


// ---- EMAIL VERIFICATION ---------------------------------------------------
{
  const s = makeSandbox();
  const req = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry()))));
  check('step 1 asks for a code', req.ok === true && req.needsCode === true);
  check('step 1 returns a verification id', /^[0-9a-f-]{36}$/.test(req.vid));
  eq('step 1 writes NOTHING to the sheet', s.__data().length, 0);
  eq('step 1 makes no FUB call', s.__fetches.length, 0);
  eq('step 1 sends exactly one email', s.__sent.length, 1);
  check('the code email goes to the entrant', s.__sent[0].to === 'dana@mail-test.co');
  const code = String(s.__sent[0].subject).match(/(\d{6})/)[1];
  check('the code is 6 digits', /^\d{6}$/.test(code));
  check('the code email explains what it is for', /entry code/i.test(s.__sent[0].subject));
  check('the code email says it expires', /expires/i.test(s.__sent[0].body));

  // Wrong code does not enter anyone.
  const bad = J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: '000000' })));
  check('a wrong code is rejected', bad.ok === false);
  eq('a wrong code writes nothing', s.__data().length, 0);

  // The right code no longer enters anyone -- it opens a verified session. Under
  // the referral rules an entry does not exist until a referred person consents,
  // so a row appears at the REFERRAL step, not here.
  const good = J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: code })));
  check('the right code verifies them', good.ok === true && good.verified === true);
  check('verification hands back a session id', /^[0-9a-fA-F-]{36}$/.test(String(good.vid)));
  // Verification now DOES write one row: the entrant's own entry, worth one
  // ticket. That is the change that made a zero-entry drawing impossible.
  eq('verification writes the entrant\'s own entry', s.__data().length, 1);
  eq('and it is eligible immediately', cell(s, s.__data()[0], 'Entry Status'), 'eligible');
  eq('with no referral attached', cell(s, s.__data()[0], 'Referral Name'), '');
  check('the response says nothing about whether they were already in FUB',
    !/found|existing|already a|welcome back/i.test(JSON.stringify(good)), JSON.stringify(good));
  const created = JSON.parse(s.__fetches.find(
    f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post').o.payload);
  check('FUB background states the email was verified',
    /EMAIL VERIFIED/.test(created.background));
  check('FUB background is honest that the phone was NOT ownership-verified',
    /NOT ownership-verified/.test(created.background));

  // The id is single-use.
  const replay = J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: code })));
  check('the same code cannot be replayed', replay.ok === false);
  eq('a replay adds no second row', s.__data().length, 1);
}

// You cannot verify one address and enter a different one.
{
  const s = makeSandbox();
  const req = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry()))));
  const code = String(s.__sent[0].subject).match(/(\d{6})/)[1];
  // Step 2 smuggles different details alongside the valid code...
  const v = J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'verify', vid: req.vid, code: code,
    fullName: 'Someone Else', email: 'attacker@mail-test.co', phone: '(267) 555-8777'
  })));
  // ...and step 3 tries again, since the row is written there now.
  J(at(DURING, () => s.raffleHandleSubmission_({
    step: 'referral', vid: v.vid, consent: 'Yes',
    fullName: 'Someone Else', email: 'attacker@mail-test.co', phone: '(267) 555-8777',
    referralName: 'Robin Vale', referralEmail: 'robin@mail-test.co',
    referralPhone: '(215) 555-9001', referralRole: 'Buyer', referralTimeframe: '7-12 Months'
  })));
  eq('entry written from the VERIFIED values, not a later request', s.__data()[0][2], 'dana@mail-test.co');
  eq('smuggled name ignored', s.__data()[0][1], 'Dana Reid');
  check('smuggled phone ignored', String(s.__data()[0][3]).indexOf('8777') === -1);
}

// Attempt cap, then the pending entry is destroyed.
{
  const s = makeSandbox();
  const req = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry()))));
  let last;
  for (let i = 0; i < 5; i++) {
    last = J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: '000000' })));
  }
  check('repeated wrong codes are eventually cut off', /Too many wrong codes/.test(last.error));
  const code = String(s.__sent[0].subject).match(/(\d{6})/)[1];
  const after = J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: code })));
  check('even the correct code fails after the cap', after.ok === false);
  eq('nothing was ever written', s.__data().length, 0);
}

// An unknown or malformed id is refused.
{
  const s = makeSandbox();
  check('unknown id refused',
    J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', code: '123456' }))).ok === false);
  check('malformed id refused',
    J(at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: 'nope', code: '123456' }))).ok === false);
  eq('neither wrote anything', s.__data().length, 0);
}

// ---- JUNK REJECTION -------------------------------------------------------
{
  const s = makeSandbox();
  const reject = (label, d) => {
    const r = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry(d)))));
    check('rejects ' + label, r.ok === false);
  };
  reject('a disposable address',      { email: 'x@mailinator.com' });
  reject('10minutemail',             { email: 'x@10minutemail.com' });
  reject('example.com',              { email: 'x@example.com' });
  reject('test@ role address',       { email: 'test@mail-test.co' });
  reject('asdf@ keyboard mash',      { email: 'asdf@mail-test.co' });
  reject('an empty email',           { email: '' });
  reject('all-same digits',          { phone: '5555555555' });
  reject('1234567890',               { phone: '1234567890' });
  reject('an area code starting 1',  { phone: '1152345678' });
  reject('an area code starting 0',  { phone: '0152345678' });
  reject('an N11 area code',         { phone: '9112345678' });
  reject('an exchange starting 1',   { phone: '2151234567' });
  reject('the reserved 555-01xx range', { phone: '(215) 555-0123' });
  reject('an empty phone',           { phone: '' });
  eq('no junk entry produced a row', s.__data().length, 0);
  eq('no junk entry sent an email', s.__sent.length, 0);

  // A real-looking pair still gets through.
  const okRes = J(at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' },
    entry({ email: 'jane.oh@inbox-two.co', phone: '(267) 234-5678' })))));
  check('a plausible real entrant is accepted', okRes.ok === true && okRes.needsCode === true);
}



// ---- ALREADY-IN-FUB: confident match -> update, never a duplicate -----------
//
// These two sections are about the ENTRANT's match-or-create only, so they drive
// verifySession rather than the whole referral flow: the entrant is resolved
// against FUB the moment they verify their email, and going further would add the
// referral's own create and consent-update to every count below and make the
// assertions say nothing about the thing they are testing.
const fubPerson = o => Object.assign({
  id: 501, firstName: 'Dana', lastName: 'Reid',
  emails: [{ value: 'dana@mail-test.co' }], phones: [{ value: '2155558123' }],
  tags: ['Sphere', 'Past Client'], source: 'Zillow 2023'
}, o);

const puts    = s => s.__fetches.filter(f => /\/v1\/people\/\d+$/.test(f.url) && f.o && f.o.method === 'put');
const creates = s => s.__fetches.filter(f => /\/v1\/people$/.test(f.url) && f.o && f.o.method === 'post');
const noteBody = s => JSON.parse(s.__fetches.filter(f => /\/v1\/notes/.test(f.url)).pop().o.payload).body;

// email + last name + phone all agree -> update, and NOT a second record.
{
  const s = makeSandbox({ fubPeople: [fubPerson()] });
  verifySession(s, entry(), DURING);
  eq('confident match updates the existing contact', puts(s).length, 1);
  eq('confident match creates NO duplicate', creates(s).length, 0);
  check('updated the right person', /\/v1\/people\/501$/.test(puts(s)[0].url));

  const body = JSON.parse(puts(s)[0].o.payload);
  check('existing tags are kept', body.tags.indexOf('Sphere') !== -1 && body.tags.indexOf('Past Client') !== -1);
  check('raffle tags are added to the EXISTING contact',
    body.tags.indexOf('Block Party Raffle Entrant') !== -1 && body.tags.indexOf('Block Party 2026') !== -1);
  check('original lead source is left alone', body.source === undefined);
  check('an already-correct name is not overwritten',
    body.firstName === undefined && body.lastName === undefined);
  eq('no duplicate email added', body.emails.length, 1);
  eq('no duplicate phone added', body.phones.length, 1);
  check('consent date is refreshed on the existing contact', !!body[ 'customConsentCapturedDate' ]);

  const n = noteBody(s);
  check('note says it updated rather than created', /UPDATED that contact/.test(n));
  check('note records what the contact looked like before', /AS IT WAS BEFORE THIS ENTRY/.test(n));
  check('note preserves the prior tags', /Sphere/.test(n) && /Past Client/.test(n));
  check('note preserves the prior source', /Zillow 2023/.test(n));
  check('note states what it matched on', /matched on/.test(n));
}

// New information is ADDED, never swapped in over the old.
{
  const s = makeSandbox({ fubPeople: [fubPerson({ phones: [{ value: '2679990000' }] })] });
  verifySession(s, entry(), DURING);   // same email + same surname, a new mobile
  const body = JSON.parse(puts(s)[0].o.payload);
  eq('both phones now on the record', body.phones.length, 2);
  check('the old number survives', body.phones.some(p => p.value === '2679990000'));
  check('the new number is added', body.phones.some(p => /2155558123/.test(String(p.value).replace(/\D/g,''))));
  check('note reports the added phone', /phone added/.test(noteBody(s)));
}

// A blank name gets filled in; a populated one does not.
{
  const s = makeSandbox({ fubPeople: [fubPerson({ firstName: '', lastName: '' , emails:[{value:'dana@mail-test.co'}], phones:[{value:'2155558123'}]})] });
  verifySession(s, entry(), DURING);
  const body = JSON.parse(puts(s)[0].o.payload);
  eq('blank first name filled from the entry', body.firstName, 'Dana');
  eq('blank last name filled from the entry', body.lastName, 'Reid');
}

// ---- NOT confident: these must NOT merge two different people --------------
{
  // Shared household email, different surname and different phone.
  const s = makeSandbox({ fubPeople: [fubPerson({
    firstName: 'Chris', lastName: 'Alvarez', phones: [{ value: '2679990000' }] })] });
  verifySession(s, entry(), DURING);
  eq('email alone does NOT merge two people', puts(s).length, 0);
  eq('a new contact is created instead', creates(s).length, 1);
  check('note says no confident match', /no existing FUB record matched confidently/.test(noteBody(s)));
}
{
  // Shared household phone, different name and different email.
  const s = makeSandbox({ fubPeople: [fubPerson({
    firstName: 'Chris', lastName: 'Alvarez', emails: [{ value: 'chris@mail-test.co' }] })] });
  verifySession(s, entry(), DURING);
  eq('phone alone does NOT merge two people', puts(s).length, 0);
  eq('a new contact is created instead', creates(s).length, 1);
}
{
  // Phone + first name only (a father and son sharing a landline).
  const s = makeSandbox({ fubPeople: [fubPerson({
    lastName: 'Alvarez', emails: [{ value: 'other@mail-test.co' }] })] });
  verifySession(s, entry(), DURING);
  eq('phone + first name alone is not enough', puts(s).length, 0);
}

// Ambiguous: two records clear the bar -> update nothing, tell Durand.
{
  const s = makeSandbox({ fubPeople: [fubPerson({ id: 501 }), fubPerson({ id: 502 })] });
  verifySession(s, entry(), DURING);
  eq('ambiguity updates nothing', puts(s).length, 0);
  eq('ambiguity still captures the lead', creates(s).length, 1);
  const alerts = s.__alerts || [];
  check('ambiguity is reported for a human to merge',
    alerts.some(a => /ambiguous FUB match/i.test(a.context)));
  check('the alert names both candidate records',
    alerts.some(a => /#501/.test(a.detail) && /#502/.test(a.detail)));
}


// ---- setupRaffle shares the sheet with BOTH accounts ------------------------
// Whoever runs setup owns the sheet; the web app runs as the DEPLOYING account.
// If those differ and the sheet is not shared, every entry on the day is refused.
{
  const s = makeSandbox({ sheetOwner: 'durand@thestawaszgroup.com', runAs: 'durand@thestawaszgroup.com' });
  const out = s.setupRaffle();
  check('setup shares the sheet with info@',
    s.__shared.indexOf('info@tsg.homes') !== -1);
  check('setup does not try to re-share with the owner',
    s.__shared.indexOf('durand@thestawaszgroup.com') === -1);
  check('setup reports the sheet owner', /Entries sheet owner/.test(out));
  check('setup reports which account the trigger will run as', /Trigger will run as/.test(out));
}
{
  // Run by info@ instead: durand@ should then be the one added.
  const s = makeSandbox({ sheetOwner: 'info@tsg.homes', runAs: 'info@tsg.homes' });
  s.setupRaffle();
  check('run as info@, durand@ gets access',
    s.__shared.indexOf('durand@thestawaszgroup.com') !== -1);
  check('run as info@, info@ is not re-added',
    s.__shared.indexOf('info@tsg.homes') === -1);
}


// ---- raffleAdminLinks prints COMPLETE urls, never placeholders -------------
{
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'ADMINKEY', QA_TEST_SECRET: 'QASECRET' } });
  const out = s.raffleAdminLinks();
  check('no angle-bracket placeholder survives', !/<[A-Z_]+>/.test(out));
  check('admin key is substituted', out.indexOf('key=ADMINKEY') !== -1);
  check('QA secret is substituted', out.indexOf('qatest=QASECRET') !== -1);
  check('public entry link present', /\?form=raffle\n/.test(out + '\n'));
  check('kiosk link present', out.indexOf('kiosk=1') !== -1);
  check('test draw link present', out.indexOf('action=draw&key=ADMINKEY&test=1') !== -1);
  check('entries sheet link present', out.indexOf('docs.google.com/spreadsheets') !== -1);
}
{
  // No QA secret: must say so plainly rather than print a link that cannot work.
  const s = makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'ADMINKEY' } });
  const out = s.raffleAdminLinks();
  check('missing QA secret is called out', /NOT AVAILABLE/.test(out));
  // The explanatory text may mention ?qatest= while telling you it does nothing;
  // what must not appear is an actual clickable URL carrying it.
  check('no qatest LINK is offered when it would not work',
    !/https?:\/\/\S*qatest=/.test(out));
  check('admin links still work without the QA secret', out.indexOf('key=ADMINKEY') !== -1);
}
{
  // Before setup there is no key at all.
  const s = makeSandbox();
  let threw = false;
  try { s.raffleAdminLinks(); } catch (e) { threw = /setupRaffle/.test(e.message); }
  check('tells you to run setupRaffle first', threw);
}


// ---- The QA suite itself ---------------------------------------------------
// It drives real writes against live FUB when Durand runs it, so it had better
// work. Run it here first and require a clean sweep.
{
  const s = makeSandbox({ props: { RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'k' } });
  at(DURING, () => s.setupRaffle());          // arms the trigger the suite checks for
  const report = at(DURING, () => s.raffleRunQaSuite());

  const failLines = report.split('\n').filter(l => l.indexOf('FAIL') === 0);
  check('the QA suite reports no failures of its own', failLines.length === 0,
        failLines.join(' | '));
  const m = report.match(/(\d+) passed, (\d+) failed/);
  check('the QA suite summary parses', !!m);
  if (m) {
    check('suite ran a meaningful number of checks', Number(m[1]) > 30, m[1] + ' checks');
    eq('suite reports zero failures', Number(m[2]), 0);
  }
  check('suite asserts the live raffle is untouched', /LIVE raffle is untouched/.test(report));
  check('suite tells you how to clean up FUB', /FUB CLEANUP/.test(report));
  check('suite cleaned up after itself', s.__data('Test Entries').length === 0);
  eq('suite left the live tab empty', s.__data('Entries').length, 0);
  check('suite left no live winner', s.__props.RAFFLE_WINNER_JSON === undefined);
}

const { passes, fails } = counts();
console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
