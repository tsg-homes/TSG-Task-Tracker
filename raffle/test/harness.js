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
  const alerts = [];
  const qa = { active: !!opts.qaMode };
  const triggers = [];
  const templates = [];

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
      // Real sheets report the widest populated column; the header row is what
      // sets that here, which is exactly what raffleEnsureHeaders_ reads to
      // decide whether the tab needs widening.
      getLastColumn: () => (r[0] ? r[0].length : 0),
      getRange: (row, c, nr, nc) => ({
        // Sheets semantics, modelled: a cell whose stored text begins with '='
        // IS a formula, and a leading apostrophe is a text marker that getValue
        // and getValues strip and getFormula never sees. raffleSafeCell_ relies
        // on exactly this, so the fake has to reproduce it or the test proves
        // nothing.
        getValues: () => r.slice(row - 1, row - 1 + nr)
          .map(x => x.slice(c - 1, c - 1 + nc)
            .map(v => (typeof v === 'string' ? v.replace(/^'/, '') : v))),
        getValue: () => {
          const v = r[row - 1][c - 1];
          return typeof v === 'string' ? v.replace(/^'/, '') : v;
        },
        getFormula: () => {
          const v = r[row - 1][c - 1];
          return (typeof v === 'string' && v.charAt(0) === '=') ? v : '';
        },
        setValue: v => {
          if (!r[row - 1]) r[row - 1] = [];
          r[row - 1][c - 1] = v;
          return { setFontWeight: () => ({}) };
        },
        setValues: vals => {
          vals.forEach((rowVals, ri) => {
            const target = row - 1 + ri;
            if (!r[target]) r[target] = [];
            rowVals.forEach((v, ci) => { r[target][c - 1 + ci] = v; });
          });
          return { setFontWeight: () => ({ setFontSize: () => {}, setBackground: () => {} }) };
        },
        setFontWeight: () => ({ setFontSize: () => {}, setBackground: () => {} })
      }),
      getName: () => sh.name,
      setName: n => { sh.name = n; }, setFrozenRows: () => {}, clear: () => {},
      deleteRows: (start, n) => { r.splice(start - 1, n); }
    };
    tabs[name] = sh;
    return sh;
  }
  const sheet = makeSheet('Entries', rows);
  const shared = [];
  const ss = {
    getOwner: () => ({ getEmail: () => opts.sheetOwner || 'durand@thestawaszgroup.com' }),
    addEditor: e => { shared.push(e); },
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
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.runAs || 'info@tsg.homes' }) },
    DriveApp: { getFileById: () => ({ getBlob: () => ({ getContentType: () => 'image/png', getBytes: () => [1, 2, 3] }) }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://x/exec' }),
      getProjectTriggers: () => triggers.slice(),
      newTrigger: fn => ({ timeBased: () => ({ at: () => ({ create: () => {
        triggers.push({ getHandlerFunction: () => fn }); } }) }) }),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); }
    },
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
    // Route-aware FUB fake. opts.fubPeople seeds records that already exist, so
    // the match-and-update path can be exercised for real rather than assumed.
    UrlFetchApp: {
      fetch: (url, o) => {
        fetches.push({ url, o });
        const code = opts.fubStatus || 200;
        const people = opts.fubPeople || [];
        const json = b => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(b) });
        const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const dig  = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d; };

        if (/\/v1\/people\?email=/.test(url)) {
          const q = norm(decodeURIComponent(url.split('email=')[1]));
          return json({ people: people.filter(p => (p.emails || []).some(e => norm(e.value) === q)) });
        }
        if (/\/v1\/people\?phone=/.test(url)) {
          const q = dig(decodeURIComponent(url.split('phone=')[1]));
          return json({ people: people.filter(p => (p.phones || []).some(x => dig(x.value) === q)) });
        }
        const m = url.match(/\/v1\/people\/(\d+)$/);
        if (m && (!o || (o.method || 'get') === 'get')) {
          return json(people.find(p => String(p.id) === m[1]) || {});
        }
        if (m && o && o.method === 'put') return json({ id: Number(m[1]) });
        return json({ id: 999 });
      }
    },
    // The template fake records what the server assigned and renders bodyHtml, so
    // a test can assert on what the consent page would actually emit. A fake that
    // returned a constant would make every XSS assertion on that page vacuous.
    HtmlService: {
      createHtmlOutput: h => h,
      createTemplateFromFile: name => {
        const t = {
          __file: name,
          evaluate: () => {
            const out = String(t.bodyHtml === undefined ? 'page' : t.bodyHtml);
            templates.push({ file: name, props: Object.assign({}, t), rendered: out });
            return { setTitle: () => ({ addMetaTag: () => out }) };
          }
        };
        return t;
      }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => JSON.parse(t) }) },

    // Helpers that live in Code.gs (shared global scope in a real project).
    collapseSpaces: s => String(s || '').replace(/\s+/g, ' ').trim(),
    makeValidationError: m => { const e = new Error(m); e.isValidation = true; return e; },
    validateEmailField: e => { if (e && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e)) { const x = new Error('bad email'); x.isValidation = true; throw x; } },
    validatePhoneField: p => { const d = String(p || '').replace(/\D/g, ''); if (p && (d.length < 10 || d.length > 15)) { const x = new Error('bad phone'); x.isValidation = true; throw x; } },
    splitName: n => { const p = String(n).trim().split(/\s+/); const f = p.shift(); return { first: f, last: p.join(' ') }; },
    jsonOut: o => {
      // Faithful to ContentService: a TextOutput carries no payload properties,
      // only getContent(). Anything that wants the data must parse it.
      const body = JSON.stringify(o);
      return { getContent: () => body, setMimeType() { return this; } };
    },
    sendErrorAlert: (context, detail) => { alerts.push({ context, detail }); },
    getSubmitToken: () => 'tok',
    // Live-from-FUB timeframe list (Code.gs getFubTimeframes). These labels are
    // this account's real ones, taken from the 2026-09-15 live response, so the
    // "default to the 1-year bucket" matching is exercised against real data.
    getFubTimeframes: () => (opts.timeframes || [
      { id: 1, name: '0-3 Months' }, { id: 2, name: '3-6 Months' },
      { id: 3, name: '7-12 Months' }, { id: 4, name: '12+ Months' }
    ]),
    resolveTimeframeId: name => {
      const list = opts.timeframes || [
        { id: 1, name: '0-3 Months' }, { id: 2, name: '3-6 Months' },
        { id: 3, name: '7-12 Months' }, { id: 4, name: '12+ Months' }
      ];
      const hit = list.find(t => t.name === name);
      return hit ? hit.id : null;
    },
    applyQaTestPersonMarking_: p => {
      if (!qa.active) return p;
      p.tags = (p.tags || []).slice();
      if (p.tags.indexOf('QA Test — Safe to Delete') === -1) p.tags.push('QA Test — Safe to Delete');
      return p;
    },
    safeJsonForScript_: v => JSON.stringify(v),
    CONSENT_CUSTOM_FIELD: 'customConsentCapturedDate',
    // The project's existing QA test-mode surface, stubbed. `qaMode` is what a
    // test flips to simulate ?qatest= having matched.
    QA_TEST_PREFIX: '[QA TEST] ',
    QA_TEST_TAG: 'QA Test — Safe to Delete',
    QA_TEST_NOTIFY_EMAIL: 'durand@thestawaszgroup.com',
    QA_TEST_SECRET_PROPERTY: 'QA_TEST_SECRET',
    QA_TEST_BACKGROUND_LEAD_IN: '[QA TEST] Created by a TSG QA test submission.',
    isQaTestMode_: () => qa.active,
    setQaTestModeFromPayload_: d => {
      qa.active = !!(d && d.qaTestToken && cache['qa_test_' + d.qaTestToken] === '1');
      return qa.active;
    },
    QA_TEST_CACHE_PREFIX: 'qa_test_',
    QA_TEST_TOKEN_TTL_SECONDS: 1800,
    FUB_SUBDOMAIN: 'homes571',
    issueQaTestToken_: () => (opts.qaMode ? 'tok-uuid' : ''),
    qaTestRecipients_: list => (opts.qaMode ? ['durand@thestawaszgroup.com']
                                            : (Array.isArray(list) ? list : [list])),
    Date, JSON, Math, String, Number, Object, Array, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../RaffleCode.gs'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../RaffleReferral.gs'), 'utf8'), sandbox);
  sandbox.__sent = sent; sandbox.__fetches = fetches; sandbox.__templates = templates;
  sandbox.__props = props; sandbox.__tabs = tabs; sandbox.__alerts = alerts;
  sandbox.__shared = shared;
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
// Unwrap a ContentService TextOutput the way real calling code must.
const J = r => (r && typeof r.getContent === 'function') ? JSON.parse(r.getContent()) : r;

// Step 1+2 only: details -> emailed code -> verified session. Returns the verify
// response, which now carries a vid instead of entering anybody.
function verifySession(s, d, when) {
  const r1 = J(at(when, () => s.raffleHandleSubmission_(Object.assign({ step: 'request' }, d))));
  if (!r1 || !r1.ok || !r1.needsCode) return r1;
  const mail = s.__sent[s.__sent.length - 1];      // the code email just sent
  if (!mail) throw new Error('needsCode but no email sent; result=' + JSON.stringify(r1));
  const m = String(mail.subject).match(/(\d{6})/);
  if (!m) throw new Error('no 6-digit code in subject: ' + mail.subject);
  return J(at(when, () => s.raffleHandleSubmission_({ step: 'verify', vid: r1.vid, code: m[1] })));
}

const referral = o => Object.assign({
  referralName: 'Robin Vale', referralEmail: 'robin@mail-test.co',
  referralPhone: '(215) 555-9001', referralRole: 'Buyer',
  referralTimeframe: '7-12 Months', consent: 'Yes'
}, o);

// The whole thing, end to end, the way a real entrant plus a real referral drive
// it: verify -> submit the referral -> send the invite -> the referred person
// consents. Only after that last step does a row count as an entry, so any test
// that wants an eligible entry has to go all the way through.
//
// `opts.skipConsent` stops before the referral consents, which is how you build
// the pending-but-not-yet-an-entry state.
function enterFull(s, d, when, opts) {
  opts = opts || {};
  const v = verifySession(s, d, when);
  if (!v || !v.ok || !v.verified) return v;

  const ref = referral(opts.referral || {});
  const staged = J(at(when, () => s.raffleHandleSubmission_(
    Object.assign({ step: 'referral', vid: v.vid }, ref))));
  if (!staged || !staged.ok || !staged.staged) return staged;

  const invited = J(at(when, () => s.raffleHandleSubmission_(
    { step: 'invite', vid: v.vid, token: staged.token })));
  if (opts.skipConsent) return Object.assign({ token: staged.token }, invited);

  const consented = J(at(when, () => s.raffleHandleSubmission_(Object.assign(
    { step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes' },
    { referralName: ref.referralName, referralEmail: ref.referralEmail,
      referralPhone: ref.referralPhone, referralRole: ref.referralRole,
      referralTimeframe: ref.referralTimeframe }))));
  return Object.assign({ token: staged.token, vid: v.vid }, consented);
}
// Draw-result emails only -- the inbox also holds verification codes now.
const drawMail = s => s.__sent.filter(m => /Winner/i.test(m.subject));

module.exports = {
  makeSandbox, at, entry, enterFull, verifySession, referral, drawMail, J, check, eq,
  HEADERS, DURING, BEFORE, AFTER,
  counts: () => ({ passes, fails })
};
