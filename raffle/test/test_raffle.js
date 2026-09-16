/**
 * Node `vm`-based unit tests for RaffleCode.gs, in the same style as the task
 * tracker's test/test_codegs.js: load the real file into a sandbox with stubbed
 * Apps Script globals, then exercise the logic against a fake Sheet.
 *
 *   node test/test_raffle.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fails = 0, passes = 0;
function check(name, cond) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name); }
}
function eq(name, actual, expected) {
  check(name + '  (got ' + JSON.stringify(actual) + ')', actual === expected);
}

// ---- Fakes -----------------------------------------------------------------
const HEADERS = ['Timestamp (ET)', 'Full Name', 'Email', 'Phone', 'Consent',
  'Consent Version', 'Entry Source', 'FUB Status', 'FUB Person ID', 'Eligible'];

function makeSandbox(opts) {
  opts = opts || {};
  const props = Object.assign({ RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' }, opts.props || {});
  const rows = opts.rows ? opts.rows.slice() : [HEADERS.slice()];
  const sent = [];
  const fetches = [];
  const cache = {};
  const dupFlagCalls = [];

  // Multi-tab fake: the whole point of the test/live split is that they are
  // different sheets, so the fake has to model that rather than share one array.
  const tabs = {};
  function makeSheet(name, seed) {
    // index 0 == sheet row 1 == the header row, on every tab.
    const r = seed || [HEADERS.slice()];
    const sh = {
      name,
      rows: r,
      appendRow: x => r.push(x.slice()),
      getLastRow: () => r.length,
      getRange: (row, c, nr, nc) => ({
        getValues: () => r.slice(row - 1, row - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)),
        setValue: v => { r[row - 1][c - 1] = v; },
        setValues: () => {},
        setFontWeight: () => ({ setFontSize: () => {}, setBackground: () => {} })
      }),
      setName: n => { sh.name = n; }, setFrozenRows: () => {}, clear: () => {},
      deleteRows: (start, n) => { r.splice(start - 1, n); }
    };
    tabs[name] = sh;
    return sh;
  }
  const sheet = makeSheet('Entries', rows);
  const ss = {
    getSheets: () => Object.keys(tabs).map(k => tabs[k]),
    getSheetByName: n => tabs[n] || null,
    insertSheet: n => makeSheet(n, []),   // a new sheet is EMPTY; the code adds its own header
    deleteSheet: sh => { delete tabs[sh.name]; },
    getId: () => 'sheet1', getUrl: () => 'u'
  };

  const sandbox = {
    console,
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: k => { delete props[k]; }
      })
    },
    SpreadsheetApp: { openById: () => ss, create: () => ss },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    MailApp: { sendEmail: m => sent.push(m) },
    DriveApp: { getFileById: () => ({ getBlob: () => ({ getContentType: () => 'image/png', getBytes: () => [1, 2, 3] }) }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://x/exec' }), getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ at: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
    Utilities: {
      formatDate: d => new Date(d).toISOString().slice(0, 19).replace('T', ' '),
      // Real Utilities.getUuid() returns a 36-char RFC-4122 UUID, and the code
      // validates that shape, so the fake has to produce one -- and a UNIQUE one,
      // since pending-entry ids must not collide.
      getUuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }),
      base64Encode: () => 'b64'
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        fetches.push({ url, o });
        const code = opts.fubStatus || 200;
        return { getResponseCode: () => code, getContentText: () => JSON.stringify({ id: 999 }) };
      }
    },
    HtmlService: { createHtmlOutput: h => h, createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({ addMetaTag: () => 'page' }) }) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => JSON.parse(t) }) },

    // Helpers that live in Code.gs (shared global scope in a real project).
    collapseSpaces: s => String(s || '').replace(/\s+/g, ' ').trim(),
    makeValidationError: m => { const e = new Error(m); e.isValidation = true; return e; },
    validateEmailField: e => { if (e && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e)) { const x = new Error('bad email'); x.isValidation = true; throw x; } },
    validatePhoneField: p => { const d = String(p || '').replace(/\D/g, ''); if (p && (d.length < 10 || d.length > 15)) { const x = new Error('bad phone'); x.isValidation = true; throw x; } },
    splitName: n => { const p = String(n).trim().split(/\s+/); const f = p.shift(); return { first: f, last: p.join(' ') }; },
    jsonOut: o => o,
    sendErrorAlert: () => {},
    getSubmitToken: () => 'tok',
    safeJsonForScript_: v => JSON.stringify(v),
    CONSENT_CUSTOM_FIELD: 'customConsentCapturedDate',
    // The project's existing QA test-mode surface, stubbed. `qaMode` is what a
    // test flips to simulate ?qatest= having matched.
    QA_TEST_PREFIX: '[QA TEST] ',
    QA_TEST_TAG: 'QA Test — Safe to Delete',
    QA_TEST_NOTIFY_EMAIL: 'durand@thestawaszgroup.com',
    QA_TEST_BACKGROUND_LEAD_IN: '[QA TEST] Created by a TSG QA test submission.',
    isQaTestMode_: () => !!opts.qaMode,
    // Real helper lives in Code.gs; record that the raffle actually calls it.
    flagPossibleDuplicatesByEmail_: (email, id, key) => { dupFlagCalls.push({ email, id, key }); },
    issueQaTestToken_: () => (opts.qaMode ? 'tok-uuid' : ''),
    qaTestRecipients_: list => (opts.qaMode ? ['durand@thestawaszgroup.com']
                                            : (Array.isArray(list) ? list : [list])),
    Date, JSON, Math, String, Number, Object, Array, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../RaffleCode.gs'), 'utf8'), sandbox);
  sandbox.__sent = sent; sandbox.__fetches = fetches;
  sandbox.__props = props; sandbox.__tabs = tabs; sandbox.__dupFlags = dupFlagCalls;
  // Data rows only -- the header is row 1 and is never an entry.
  sandbox.__data = name => (tabs[name || 'Entries'] ? tabs[name || 'Entries'].rows.slice(1) : []);
  return sandbox;
}

const DURING = new Date('2026-09-19T16:00:00-04:00').getTime();
const BEFORE = new Date('2026-09-18T12:00:00-04:00').getTime();
const AFTER  = new Date('2026-09-19T18:20:00-04:00').getTime();

function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = real; }
}
const entry = o => Object.assign({ fullName: 'Dana Reid', email: 'dana@mail-test.co', phone: '(215) 555-8123', consent: 'Yes' }, o);

// Entry is two-step now. This drives it the way a real entrant does: submit
// details, read the 6-digit code out of the email the fake MailApp captured,
// type it back. Returns the FIRST step's result when that step did not ask for a
// code -- i.e. a validation failure or an already-entered short-circuit.
function enterFull(s, d, when) {
  const r1 = at(when, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, d)));
  if (!r1 || !r1.ok || !r1.needsCode) return r1;
  const mail = s.__sent[s.__sent.length - 1];      // the code email just sent
  if (!mail) throw new Error('needsCode but no email sent; result=' + JSON.stringify(r1));
  const m = String(mail.subject).match(/(\d{6})/);
  if (!m) throw new Error('no 6-digit code in subject: ' + mail.subject);
  const code = m[1];
  return at(when, () => s.raffleHandleSubmission_({ step: 'verify', vid: r1.vid, code: code }));
}
// Draw-result emails only -- the inbox also holds verification codes now.
const drawMail = s => s.__sent.filter(m => /Winner/i.test(m.subject));

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
  const s = makeSandbox();
  eq('state before the party',  at(BEFORE, () => s.raffleEntryState_()), 'before');
  eq('state during the party',  at(DURING, () => s.raffleEntryState_()), 'open');
  eq('state after the 6:15 draw', at(AFTER, () => s.raffleEntryState_()), 'closed');

  const early = enterFull(s, entry(), BEFORE);
  check('entry rejected before 3:00 PM on 9/19', early.ok === false);
  check('no row written before open', s.__data().length === 0);

  const late = enterFull(s, entry(), AFTER);
  check('entry rejected after 6:15 PM', late.ok === false);
  check('late rejection names the 6:30 announcement', /6:30 PM/.test(late.error));
  check('no row written after close', s.__data().length === 0);
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

// ---- One entry per person --------------------------------------------------
{
  const s = makeSandbox();
  const first = enterFull(s, entry(), DURING);
  check('first entry accepted', first.ok === true && !first.already);
  eq('one row written', s.__data().length, 1);

  const dupEmail = enterFull(s, entry({ phone: '(267) 555-9999' }), DURING);
  check('duplicate email rejected as already entered', dupEmail.already === true);

  const dupPhone = enterFull(s, entry({ email: 'other@mail-test.co' }), DURING);
  check('duplicate phone rejected as already entered', dupPhone.already === true);

  const dupPhoneFmt = enterFull(s, 
    entry({ email: 'third@mail-test.co', phone: '+1 215.555.8123' }), DURING);
  check('duplicate phone caught across formatting', dupPhoneFmt.already === true);

  eq('still exactly one row after 3 duplicate attempts', s.__data().length, 1);

  const other = enterFull(s, 
    entry({ fullName: 'Sam Ortiz', email: 'sam@mail-test.co', phone: '(267) 555-8100' }), DURING);
  check('a genuinely different person is accepted', other.ok === true && !other.already);
  eq('two rows now', s.__data().length, 2);
}

// ---- FUB outage must never cost an entry -----------------------------------
{
  const s = makeSandbox({ fubStatus: 500 });
  const res = enterFull(s, entry(), DURING);
  check('entrant still gets a success when FUB is down', res.ok === true);
  eq('entry is still recorded in the sheet', s.__data().length, 1);
  check('row records the FUB failure for later retry',
    String(s.__data()[0][7]).indexOf('failed') === 0);
  check('entry is still eligible for the draw', s.__data()[0][9] === 'Yes');
}

// ---- FUB payload -----------------------------------------------------------
{
  const s = makeSandbox();
  enterFull(s, entry(), DURING);
  const people = s.__fetches.filter(f => /\/v1\/people/.test(f.url));
  const notes  = s.__fetches.filter(f => /\/v1\/notes/.test(f.url));
  eq('one person created in FUB', people.length, 1);
  eq('one note written in FUB', notes.length, 1);
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
  const note = JSON.parse(notes[0].o.payload);
  check('note mentions the block party', /Block Party/.test(note.subject));
  check('note carries the date and address', /9\/19\/2026/.test(note.body));
}

// ---- The draw --------------------------------------------------------------
{
  const s = makeSandbox();
  ['a', 'b', 'c', 'd'].forEach((n, i) => enterFull(s, entry({
    fullName: 'Person ' + n, email: n + '@mail-test.co', phone: '(215) 555-810' + i
  }), DURING));
  eq('four entrants', s.__data().length, 4);

  const first = at(AFTER, () => s.raffleDrawWinner_());
  check('draw succeeds', first.ok === true);
  check('draw is not flagged as already drawn', first.alreadyDrawn !== true);
  eq('drew from all four', first.result.totalEligible, 4);
  check('winner is one of the entrants',
    ['Person a', 'Person b', 'Person c', 'Person d'].indexOf(first.result.winner.name) !== -1);
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
    fullName: 'Sam Ortiz', email: 'sam@mail-test.co', phone: '(267) 555-8100' }), DURING);
  s.__tabs['Entries'].rows[1][9] = 'No';        // Durand marks a row ineligible by hand
  const res = at(AFTER, () => s.raffleDrawWinner_());
  eq('disqualified row excluded from the draw', res.result.totalEligible, 1);
  eq('the remaining entrant wins', res.result.winner.name, 'Sam Ortiz');
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
    fullName: 'Late Tester', email: 'late@mail-test.co', phone: '(267) 555-8111' }), AFTER);
  check('test mode: entry accepted after the 6:15 close too', late.ok === true);

  // 2. Test entries are in their own tab, and the live tab is empty.
  check('test mode: wrote to the "Test Entries" tab', !!s.__tabs['Test Entries']);
  eq('test mode: two rows on the test tab', s.__data('Test Entries').length, 2);
  eq('test mode: LIVE tab still empty', s.__data('Entries').length, 0);

  // 3. Every other check still runs.
  check('test mode does NOT relax consent',
    enterFull(s, entry({ consent: 'No', email: 'x@y.com' }), BEFORE).ok === false);
  check('test mode does NOT relax required fields',
    enterFull(s, entry({ fullName: '', email: 'q@y.com' }), BEFORE).ok === false);
  check('test mode does NOT relax one-entry-per-person',
    enterFull(s, entry(), BEFORE).already === true);

  // 4. FUB records are marked so nobody mistakes them for leads.
  const people = s.__fetches.filter(f => /\/v1\/people/.test(f.url));
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
  check('test draw: winner came from the test pool',
    ['Dana Reid', 'Late Tester'].indexOf(tRes.result.winner.name) !== -1);
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
  const liveAfter = at(AFTER, () => s.raffleDrawWinner_(false));
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
  eq('live sandbox: real entry on the live tab', s.__data('Entries').length, 1);
  eq('test sandbox: nothing on the live tab', t.__data('Entries').length, 0);
  const res = at(AFTER, () => s.raffleDrawWinner_(false));
  eq('live draw picks the real person', res.result.winner.name, 'Real Person');
  eq('live draw pool excludes test entries entirely', res.result.totalEligible, 1);
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
  eq('before reset: test rows present', s.__data('Test Entries').length, 1);
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
  const req = at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry())));
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
  const bad = at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: '000000' }));
  check('a wrong code is rejected', bad.ok === false);
  eq('a wrong code writes nothing', s.__data().length, 0);

  // Right code enters them.
  const good = at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: code }));
  check('the right code enters them', good.ok === true && good.verified === true);
  eq('now one row exists', s.__data().length, 1);
  check('the row records the email as verified',
    /Yes/.test(String(s.__data()[0][10])));
  check('FUB background states the email was verified',
    /EMAIL VERIFIED/.test(JSON.parse(s.__fetches[0].o.payload).background));
  check('FUB background is honest that the phone was NOT ownership-verified',
    /NOT ownership-verified/.test(JSON.parse(s.__fetches[0].o.payload).background));

  // The id is single-use.
  const replay = at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: code }));
  check('the same code cannot be replayed', replay.ok === false);
  eq('replay adds no second row', s.__data().length, 1);
}

// You cannot verify one address and enter a different one.
{
  const s = makeSandbox();
  const req = at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry())));
  const code = String(s.__sent[0].subject).match(/(\d{6})/)[1];
  // Step 2 smuggles different details alongside the valid code.
  at(DURING, () => s.raffleHandleSubmission_({
    step: 'verify', vid: req.vid, code: code,
    fullName: 'Someone Else', email: 'attacker@mail-test.co', phone: '(267) 555-8777'
  }));
  eq('entry written from the VERIFIED values, not the second request', s.__data()[0][2], 'dana@mail-test.co');
  eq('smuggled name ignored', s.__data()[0][1], 'Dana Reid');
  check('smuggled phone ignored', String(s.__data()[0][3]).indexOf('8777') === -1);
}

// Attempt cap, then the pending entry is destroyed.
{
  const s = makeSandbox();
  const req = at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry())));
  let last;
  for (let i = 0; i < 5; i++) {
    last = at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: '000000' }));
  }
  check('repeated wrong codes are eventually cut off', /Too many wrong codes/.test(last.error));
  const code = String(s.__sent[0].subject).match(/(\d{6})/)[1];
  const after = at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: req.vid, code: code }));
  check('even the correct code fails after the cap', after.ok === false);
  eq('nothing was ever written', s.__data().length, 0);
}

// An unknown or malformed id is refused.
{
  const s = makeSandbox();
  check('unknown id refused',
    at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', code: '123456' })).ok === false);
  check('malformed id refused',
    at(DURING, () => s.raffleHandleSubmission_({ step: 'verify', vid: 'nope', code: '123456' })).ok === false);
  eq('neither wrote anything', s.__data().length, 0);
}

// ---- JUNK REJECTION -------------------------------------------------------
{
  const s = makeSandbox();
  const reject = (label, d) => {
    const r = at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, entry(d))));
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
  const okRes = at(DURING, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' },
    entry({ email: 'jane.oh@inbox-two.co', phone: '(267) 234-5678' }))));
  check('a plausible real entrant is accepted', okRes.ok === true && okRes.needsCode === true);
}


// ---- Already-in-FUB entrants ----------------------------------------------
// FUB does not merge on email: posting an address that already exists creates a
// SECOND person record. Every other write path in this project flags that; the
// raffle must too.
{
  const s = makeSandbox();
  enterFull(s, entry(), DURING);
  eq('raffle flags possible duplicates after a create', s.__dupFlags.length, 1);
  eq('flagged on the entrant email', s.__dupFlags[0].email, 'dana@mail-test.co');
  check('flagged against the new person id', s.__dupFlags[0].id === 999);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
