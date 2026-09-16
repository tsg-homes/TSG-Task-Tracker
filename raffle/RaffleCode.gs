// RaffleCode.gs — TSG Block Party 2026 prize drawing (entry form + draw + FUB sync)
//
// Added 2026-09-16, per Durand. Lives in the "TSG Open House Sign-In + Client
// Intake Forms" project ON PURPOSE rather than in a new standalone project:
// this project is ALREADY the public, anonymous, no-login form host under
// info@, it already holds FUB_API_KEY, and it already carries the hardening a
// public endpoint needs (submit token, rate limit, honeypot, dedupe claims,
// contact-enumeration protection, error alerts). A greenfield project would
// have meant reimplementing all of that from scratch, untested, in three days
// — strictly more risk, not less. Nothing here touches the task-tracker script
// or its Anthropic key / script token.
//
// This file is ADDITIVE. It defines only raffle* symbols and reads a handful of
// existing helpers out of Code.gs's shared global scope (checkSubmitToken and
// checkRateLimit have already run in doPost before anything here is reached).
// The only edits to Code.gs are the two one-line route hooks in PATCH-Code.gs.md.
//
// Storage is a Google Sheet, not FUB: an entry is a contest record and has to
// survive a FUB outage, a bad API key, or a rate-limited CRM. The sheet row is
// written FIRST and the FUB push is best-effort on top of it, with its outcome
// recorded back on the row so raffleRetryFubFailures() can re-push later. An
// entrant is never turned away because the CRM was down.

// ---------- Event configuration ----------
var RAFFLE_EVENT_NAME   = 'TSG Block Party 2026';
var RAFFLE_TZ           = 'America/New_York';
// Entries open when the party opens and close at the draw. Both are enforced
// server-side, so a saved/shared link can't be used to enter days later.
var RAFFLE_OPEN_AT      = '2026-09-19T15:00:00-04:00';
var RAFFLE_CLOSE_AT     = '2026-09-19T18:15:00-04:00';
var RAFFLE_DRAW_AT      = '2026-09-19T18:15:00-04:00';
var RAFFLE_ANNOUNCE_AT  = '6:30 PM';
var RAFFLE_PRIZE_SHORT  = '$300 toward any Ticketmaster purchase';
var RAFFLE_PRIZE_ARV    = '$300.00';

// Ryan's calendar identity is ryan@thestawaszgroup.com; this project's agent
// roster has him as ryan@tsg.homes. Both are mailed rather than guessing which
// one he actually reads on a Saturday evening — see README "Open items".
var RAFFLE_RESULT_EMAIL = 'durand@thestawaszgroup.com,ryan@thestawaszgroup.com,ryan@tsg.homes';

var RAFFLE_SOURCE = 'TSG Block Party 2026 - Raffle';
var RAFFLE_TAGS   = ['Block Party 2026', 'Block Party Raffle Entrant', 'Event Lead'];

// ---------- Test mode vs live ----------
// Reuses this project's EXISTING QA test mode (see the QA_TEST_* block in
// Code.gs) rather than inventing a second one: ?form=raffle&qatest=<QA_TEST_SECRET>
// mints a token, the page carries it, and doPost resolves isQaTestMode_() before
// either of the raffle hooks is reached. One test-mode concept for the whole
// project.
//
// Test entries live in their OWN sheet tab and a test draw records its winner
// under its OWN script property. That separation is structural, not a filter:
// there is no code path by which a test entry can be drawn as the real winner,
// and a test draw cannot consume the real draw's one-shot idempotency lock.
//
// !! ONE DELIBERATE DIFFERENCE FROM Code.gs's TEST MODE. That one is documented
// as "a LABELLING and ROUTING change only; by construction it cannot relax a
// check". The raffle's test mode DOES relax exactly one check: the entry window.
// It has to -- entries are refused outside 3:00-6:15 PM on 19 Sep, so with the
// window enforced there is no way to test the form before the party, which is
// the entire point. Every other check still runs unchanged: form token, rate
// limit, honeypot, required fields, consent, and one-entry-per-person. The
// relaxation is logged loudly every time it happens.
// ---------- Email verification ----------
// Entry is two-step: details -> emailed 6-digit code -> entered. Nothing is
// written to the sheet or to FUB until the code is confirmed, so a typo'd or
// invented address never becomes a contact record.
//
// WHY EMAIL AND NOT SMS. The phone is the field TCPA actually cares about, so an
// SMS code would be the stronger check. It is not reachable for this event:
// Follow Up Boss's /v1/textMessages endpoint only LOGS an externally-sent text,
// it cannot send one, and a real SMS provider needs US A2P 10DLC registration,
// which is currently running 10-15 days for campaign review. The party is in
// three days. The phone is therefore hard-validated (below) rather than
// ownership-proven, and that limitation is stated plainly in the README.
var RAFFLE_CODE_TTL_SECONDS = 900;      // 15 minutes to type a 6-digit code
var RAFFLE_CODE_MAX_ATTEMPTS = 5;
var RAFFLE_PENDING_PREFIX = 'raffle_pending_';

// Junk rejection, applied to BOTH steps. This is not politeness -- FUB already
// carries "test@me.com / 1234567899" and "asdf@asdf.caf" from earlier form
// testing, and a raffle at a party is exactly where that gets typed on purpose.
var RAFFLE_DISPOSABLE_EMAIL_RE = new RegExp('@(?:' + [
  'mailinator\\.com', 'guerrillamail\\.[a-z]+', '10minutemail\\.[a-z]+',
  'tempmail\\.[a-z]+', 'temp-mail\\.[a-z]+', 'throwaway\\.[a-z]+',
  'yopmail\\.[a-z]+', 'trashmail\\.[a-z]+', 'sharklasers\\.com',
  'getnada\\.com', 'dispostable\\.com', 'maildrop\\.cc',
  'fakeinbox\\.com', 'mailnesia\\.com', 'example\\.(?:com|org|net)',
  'test\\.(?:com|org|net)'
].join('|') + ')$', 'i');
var RAFFLE_ROLE_LOCALPART_RE =
  /^(?:test|tester|testing|asdf|qwerty|admin|administrator|root|postmaster|abuse|noreply|no-reply|donotreply|nobody|none|null|na|n\/a|fake|foo|bar|baz|xxx|aaa|sample|example)[0-9]*$/i;

// Rejects a phone that cannot be a real North American number, plus the
// keyboard-mash patterns people actually type.
function raffleRejectJunkPhone_(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (!d) throw makeValidationError('Enter your phone number.');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  if (d.length !== 10) {
    throw makeValidationError('Enter a 10-digit US phone number.');
  }
  if (/^(\d)\1{9}$/.test(d)) {
    throw makeValidationError('That phone number does not look real. Please check it.');
  }
  if (d === '1234567890' || d === '0123456789' || d === '9876543210') {
    throw makeValidationError('That phone number does not look real. Please check it.');
  }
  var area = d.slice(0, 3), exch = d.slice(3, 6);
  // NANP: area and exchange codes never start 0 or 1, and N11 codes are service
  // codes (411, 911...), never subscriber numbers.
  if (area.charAt(0) === '0' || area.charAt(0) === '1' ||
      exch.charAt(0) === '0' || exch.charAt(0) === '1' ||
      /^\d11$/.test(area)) {
    throw makeValidationError('That is not a valid US phone number. Please check it.');
  }
  // 555-01xx is the reserved fictional range.
  if (exch === '555' && d.slice(6, 8) === '01') {
    throw makeValidationError('That phone number does not look real. Please check it.');
  }
  return d;
}

function raffleRejectJunkEmail_(email) {
  var e = String(email || '').trim().toLowerCase();
  // Code.gs's validateEmailField returns early on an empty value (it is used
  // where email is optional), so emptiness has to be caught here or a blank
  // address would sail through and we would "send a code" to nobody.
  if (!e) throw makeValidationError('Enter your email address.');
  validateEmailField(e);                       // shared shape check from Code.gs
  if (RAFFLE_DISPOSABLE_EMAIL_RE.test(e)) {
    throw makeValidationError('Please use a real email address you can check right now — we send your entry code to it.');
  }
  var local = e.split('@')[0];
  if (RAFFLE_ROLE_LOCALPART_RE.test(local)) {
    throw makeValidationError('Please use your own email address.');
  }
  return e;
}

var RAFFLE_LIVE_SHEET_NAME  = 'Entries';
var RAFFLE_TEST_SHEET_NAME  = 'Test Entries';
var RAFFLE_TEST_WINNER_PROP = 'RAFFLE_TEST_WINNER_JSON';

var RAFFLE_SHEET_PROP   = 'RAFFLE_SHEET_ID';
var RAFFLE_WINNER_PROP  = 'RAFFLE_WINNER_JSON';
var RAFFLE_ADMIN_PROP   = 'RAFFLE_ADMIN_KEY';
var RAFFLE_BACKUP_COUNT = 2;

// Consent language version stamped onto every row. Bump this string if the
// consent copy in RaffleForm.html changes, so the audit trail stays honest
// about which wording a given entrant actually saw.
var RAFFLE_CONSENT_VERSION = 'raffle-v2 (2026-09-16, email-verified entry)';

var RAFFLE_SHEET_HEADERS = [
  'Timestamp (ET)', 'Full Name', 'Email', 'Phone',
  'Consent', 'Consent Version', 'Entry Source',
  'FUB Status', 'FUB Person ID', 'Eligible', 'Email Verified'
];

// ---------- Small helpers ----------
function raffleNow_() { return new Date(); }

function raffleFmt_(d) {
  return Utilities.formatDate(d, RAFFLE_TZ, 'yyyy-MM-dd HH:mm:ss');
}

// Normalized identity keys. One entry per person is enforced on BOTH, because
// the same person entering twice will usually vary one and not the other
// (a nickname in the name field, gmail vs work email, phone typed two ways).
function raffleEmailKey_(email) {
  return String(email || '').trim().toLowerCase();
}

function rafflePhoneKey_(phone) {
  var digits = String(phone || '').replace(/\D/g, '');
  // Strip a leading US country code so 2155551212 and 12155551212 collide.
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  return digits;
}

// The live tab and the test tab are different sheets in the same spreadsheet,
// so Durand can see both side by side. The test tab is created on first use, so
// an existing setup does not need setupRaffle() re-run to gain one.
function raffleSheet_(test) {
  var id = PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP);
  if (!id) throw new Error(RAFFLE_SHEET_PROP + ' is not set. Run setupRaffle() once from the editor.');
  var ss = SpreadsheetApp.openById(id);
  if (!test) {
    return ss.getSheetByName(RAFFLE_LIVE_SHEET_NAME) || ss.getSheets()[0];
  }
  var sh = ss.getSheetByName(RAFFLE_TEST_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(RAFFLE_TEST_SHEET_NAME);
    sh.appendRow(RAFFLE_SHEET_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, RAFFLE_SHEET_HEADERS.length).setFontWeight('bold').setBackground('#fde2e1');
  }
  return sh;
}

function raffleWinnerProp_(test) {
  return test ? RAFFLE_TEST_WINNER_PROP : RAFFLE_WINNER_PROP;
}

// ---------- One-time setup ----------
// Run this ONCE from the Apps Script editor (Durand, as info@). It is
// idempotent: re-running reuses the existing sheet and re-points the trigger
// rather than creating duplicates.
function setupRaffle() {
  var props = PropertiesService.getScriptProperties();
  var out = [];

  var sheetId = props.getProperty(RAFFLE_SHEET_PROP);
  if (!sheetId) {
    var ss = SpreadsheetApp.create('TSG Block Party 2026 — Raffle Entries');
    var sh = ss.getSheets()[0];
    sh.setName('Entries');
    sh.appendRow(RAFFLE_SHEET_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, RAFFLE_SHEET_HEADERS.length).setFontWeight('bold');
    props.setProperty(RAFFLE_SHEET_PROP, ss.getId());
    sheetId = ss.getId();
    out.push('Created entries sheet: ' + ss.getUrl());
  } else {
    out.push('Entries sheet already exists: https://docs.google.com/spreadsheets/d/' + sheetId);
  }

  if (!props.getProperty(RAFFLE_ADMIN_PROP)) {
    props.setProperty(RAFFLE_ADMIN_PROP,
      Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
    out.push('Generated RAFFLE_ADMIN_KEY (see Project Settings > Script Properties).');
  } else {
    out.push('RAFFLE_ADMIN_KEY already set.');
  }

  // Drop any previously installed draw trigger before adding this one, so
  // re-running setup can never arm two draws.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'raffleScheduledDraw') ScriptApp.deleteTrigger(t);
  });
  var drawAt = new Date(RAFFLE_DRAW_AT);
  if (drawAt.getTime() > Date.now()) {
    ScriptApp.newTrigger('raffleScheduledDraw').timeBased().at(drawAt).create();
    out.push('Draw trigger armed for ' + raffleFmt_(drawAt) + ' ET.');
  } else {
    out.push('WARNING: RAFFLE_DRAW_AT is in the past; no trigger armed. Draw manually.');
  }

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// Prints the admin URLs. Run from the editor and copy the output; these carry
// the admin key, so treat them like a password (do not put them in a doc).
function raffleAdminLinks() {
  var key = PropertiesService.getScriptProperties().getProperty(RAFFLE_ADMIN_PROP);
  if (!key) throw new Error('Run setupRaffle() first.');
  var base = ScriptApp.getService().getUrl();
  var msg =
    'ENTRY FORM (this is the QR-code / public link — no key, safe to share):\n' +
    base + '?form=raffle\n\n' +
    'KIOSK MODE (iPad at the table; auto-resets for the next person):\n' +
    base + '?form=raffle&kiosk=1\n\n' +
    'LIVE ENTRY COUNT (private):\n' +
    base + '?form=raffle&action=status&key=' + key + '\n\n' +
    'MANUAL DRAW — backup if the 6:15 trigger misfires (private):\n' +
    base + '?form=raffle&action=draw&key=' + key + '\n\n' +
    '--- TEST MODE (needs the QA_TEST_SECRET script property) ---\n' +
    'TEST FORM — accepts entries any time, writes to the "' + RAFFLE_TEST_SHEET_NAME + '" tab:\n' +
    base + '?form=raffle&qatest=<QA_TEST_SECRET>\n\n' +
    'TEST ENTRY COUNT:\n' +
    base + '?form=raffle&action=status&key=' + key + '&test=1\n\n' +
    'TEST DRAW — rehearses the whole draw, emails only ' + QA_TEST_NOTIFY_EMAIL + ':\n' +
    base + '?form=raffle&action=draw&key=' + key + '&test=1\n\n' +
    'Run raffleResetTest() in the editor to wipe test data and rehearse again.';
  Logger.log(msg);
  return msg;
}


// ---------- doGet branch (reached from Code.gs's one-line hook) ----------
function raffleServeForm_(e, baseUrl) {
  var action = (e.parameter.action || '').toString().toLowerCase();
  // ?qatest=<QA_TEST_SECRET> mints the token AND flips this execution into test
  // mode. A wrong or absent value returns '' and renders the ordinary live page,
  // so nothing about the response reveals whether the secret was close.
  var qaTestToken = issueQaTestToken_(e);
  var isTest = !!qaTestToken;

  if (action === 'status' || action === 'draw') {
    var key = PropertiesService.getScriptProperties().getProperty(RAFFLE_ADMIN_PROP);
    // Constant-ish comparison and an identical response for a wrong key as for
    // no key, so this can't be probed.
    if (!key || (e.parameter.key || '').toString() !== key) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Not found.</p>');
    }
    // Admin endpoints pick their mode from ?test=1 rather than from the page
    // token, so a rehearsal draw can be fired straight from a bookmark.
    var adminTest = String(e.parameter.test || '') === '1';
    if (action === 'status') return raffleStatusPage_(adminTest);
    return raffleDrawPage_(adminTest);
  }

  var tmpl = HtmlService.createTemplateFromFile('RaffleForm');
  tmpl.submitToken   = getSubmitToken();
  tmpl.baseUrl       = baseUrl;
  tmpl.kiosk         = (e.parameter.kiosk || '') ? '1' : '';
  tmpl.qaTestToken   = qaTestToken;   // '' on every normal load
  tmpl.isTest        = isTest ? '1' : '';
  tmpl.prizeShort    = RAFFLE_PRIZE_SHORT;
  tmpl.announceAt    = RAFFLE_ANNOUNCE_AT;
  // The page runs its own clock: it counts down to 3:00, opens itself, and goes
  // dead at 6:15 -- all without a reload. It measures against the SERVER clock,
  // not the visitor's, so a phone with a wrong clock still opens and closes on
  // time. The server re-checks the window on every submit regardless.
  // Derived from RAFFLE_OPEN_AT, never typed a second time -- change the event
  // date in one place and every line on the page follows.
  tmpl.eventDate     = Utilities.formatDate(new Date(RAFFLE_OPEN_AT), RAFFLE_TZ, 'EEEE, MMMM d, yyyy');
  tmpl.eventDateShort= Utilities.formatDate(new Date(RAFFLE_OPEN_AT), RAFFLE_TZ, 'EEEE, MMMM d');
  tmpl.openTime      = Utilities.formatDate(new Date(RAFFLE_OPEN_AT), RAFFLE_TZ, 'h:mm a');
  tmpl.openAtMs      = String(new Date(RAFFLE_OPEN_AT).getTime());
  tmpl.closeAtMs     = String(new Date(RAFFLE_CLOSE_AT).getTime());
  tmpl.serverNowMs   = String(Date.now());
  return tmpl.evaluate()
    .setTitle((isTest ? QA_TEST_PREFIX : '') + 'Enter to Win | ' + RAFFLE_EVENT_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 'before' | 'open' | 'closed' — drives what the page shows on load. The same
// check is re-run server-side on submit; this is presentation only.
function raffleEntryState_() {
  var now = Date.now();
  if (now < new Date(RAFFLE_OPEN_AT).getTime()) return 'before';
  if (now >= new Date(RAFFLE_CLOSE_AT).getTime()) return 'closed';
  return 'open';
}

function raffleStatusPage_(test) {
  var rows = raffleReadEntries_(test);
  var winner = raffleStoredWinner_(test);
  var html = '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
    (test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
            'border-radius:6px;margin-bottom:14px">TEST DATA — not the live raffle</div>' : '') +
    '<h2 style="margin:0 0 4px">' + RAFFLE_EVENT_NAME + '</h2>' +
    '<p style="color:#666;margin:0 0 20px">Entry state: <b>' + raffleEntryState_() + '</b></p>' +
    '<div style="font-size:64px;font-weight:700;color:#15464A;line-height:1">' + rows.length + '</div>' +
    '<div style="color:#666;margin-bottom:20px">eligible ' + (test ? 'TEST ' : '') + 'entries</div>';
  if (winner) {
    html += '<div style="background:#15464A;color:#fff;padding:16px;border-radius:8px">' +
      '<div style="opacity:.8;font-size:12px;letter-spacing:1px">WINNER DRAWN ' + winner.drawnAt + '</div>' +
      '<div style="font-size:22px;font-weight:700;margin-top:4px">' + winner.winner.name + '</div></div>';
  } else {
    html += '<p style="color:#666">No winner drawn yet. Draw is armed for ' +
      raffleFmt_(new Date(RAFFLE_DRAW_AT)) + ' ET.</p>';
  }
  html += '</div>';
  return HtmlService.createHtmlOutput(html);
}

function raffleDrawPage_(test) {
  var res = raffleDrawWinner_(test);
  if (!res.ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;padding:24px"><h2>Draw not completed</h2><p>' +
      res.error + '</p></div>');
  }
  var w = res.result.winner;
  var html = '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
    (test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
            'border-radius:6px;margin-bottom:14px">TEST DRAW — the real 6:15 draw is untouched</div>' : '') +
    (res.alreadyDrawn ? '<p style="background:#fff3cd;padding:10px;border-radius:6px">' +
      'A winner was already drawn at ' + res.result.drawnAt + '. Showing that result — ' +
      'the draw is deliberately not repeatable.</p>' : '') +
    '<div style="background:#15464A;color:#fff;padding:24px;border-radius:8px;text-align:center">' +
    '<div style="opacity:.8;font-size:12px;letter-spacing:2px">WINNER</div>' +
    '<div style="font-size:30px;font-weight:700;margin:8px 0">' + w.name + '</div>' +
    '<div style="opacity:.9">' + w.phone + '<br>' + w.email + '</div></div>' +
    '<p style="color:#666">Drawn from ' + res.result.totalEligible + ' eligible entries at ' +
    res.result.drawnAt + ' ET.</p>';
  if (res.result.backups.length) {
    html += '<p style="color:#666"><b>Backups</b> (if the winner has left):<br>' +
      res.result.backups.map(function (b, i) {
        return (i + 1) + '. ' + b.name + ' — ' + b.phone;
      }).join('<br>') + '</p>';
  }
  html += '</div>';
  return HtmlService.createHtmlOutput(html);
}

// ---------- Entry submission (reached from Code.gs's one-line doPost hook) ----------
// checkSubmitToken() and checkRateLimit() have ALREADY run in doPost before this
// is called, as has sanitizeSubmission() and the honeypot check. Do not re-do
// them here; do not skip them by calling this from anywhere else.
function raffleHandleSubmission_(d) {
  // Resolved by setQaTestModeFromPayload_ in doPost, before this hook is
  // reached. Read once here so every branch below agrees on which mode it is.
  var test = isQaTestMode_();
  try {
    var step = String((d && d.step) || 'request').toLowerCase();
    if (step === 'verify') return raffleVerifyCode_(d, test);
    return raffleRequestCode_(d, test);
  } catch (err) {
    if (err && err.isValidation) return jsonOut({ ok: false, error: err.message });
    Logger.log('raffleHandleSubmission_ error: ' + (err && err.stack ? err.stack : err));
    try {
      sendErrorAlert('Raffle: submission exception', (err && err.stack ? err.stack : String(err)));
    } catch (alertErr) { /* never let the alert swallow the response */ }
    return jsonOut({ ok: false, error: 'Something went wrong. Grab someone from TSG and we will get you entered.' });
  }
}

// ---------- Step 1: validate, then email a code ----------
// Writes NOTHING durable. The entry only exists in the script cache, keyed by a
// server-generated id, until the code comes back.
function raffleRequestCode_(d, test) {
  // Window check FIRST. If entries are shut, say so -- do not make someone fix a
  // typo in a field only to then be told they were too late anyway.
  // This is the one check test mode relaxes; see the RAFFLE_TEST_* block.
  var state = raffleEntryState_();
  if (test) {
    Logger.log('RAFFLE TEST MODE: entry-window check BYPASSED (real state was "' + state +
      '"). This is the only check test mode relaxes; the entry is being written to the "' +
      RAFFLE_TEST_SHEET_NAME + '" tab and cannot be drawn as the real winner.');
  } else {
    if (state === 'before') {
      throw makeValidationError('Entries are not open yet. Come find us at the party!');
    }
    if (state === 'closed') {
      throw makeValidationError('Entries are closed — the winner is announced at ' +
        RAFFLE_ANNOUNCE_AT + '. Thanks for coming out!');
    }
  }

  var name  = collapseSpaces(d.fullName);
  if (!name) throw makeValidationError('Enter your full name.');
  if (name.indexOf(' ') === -1) throw makeValidationError('Enter your first and last name.');
  var email  = raffleRejectJunkEmail_(d.email);
  var digits = raffleRejectJunkPhone_(d.phone);
  var phone  = String(d.phone || '').trim();
  if (d.consent !== 'Yes') throw makeValidationError('You must accept the Official Rules to enter.');

  // Tell them they are already in BEFORE making them wait for a code.
  var emailKey = raffleEmailKey_(email), phoneKey = rafflePhoneKey_(digits);
  var existing = raffleReadEntries_(test);
  for (var i = 0; i < existing.length; i++) {
    if ((emailKey && existing[i].emailKey === emailKey) ||
        (phoneKey && existing[i].phoneKey === phoneKey)) {
      return jsonOut({ ok: true, already: true,
        message: 'You are already entered! Winner announced at ' + RAFFLE_ANNOUNCE_AT + '.' });
    }
  }

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var vid  = Utilities.getUuid();
  CacheService.getScriptCache().put(RAFFLE_PENDING_PREFIX + vid, JSON.stringify({
    name: name, email: email, phone: phone, code: code, attempts: 0, test: !!test
  }), RAFFLE_CODE_TTL_SECONDS);

  MailApp.sendEmail({
    to: email,
    subject: (test ? QA_TEST_PREFIX : '') + 'Your TSG Block Party entry code: ' + code,
    body: [
      'Your entry code is ' + code,
      '',
      'Type it back on the entry page to finish entering the drawing for',
      RAFFLE_PRIZE_SHORT + ' at the TSG Block Party.',
      '',
      'This code expires in 15 minutes. If you did not request it, ignore this email —',
      'nothing has been entered and we will not contact you.',
      '',
      'The Stawasz Group · Keller Williams Empower',
      '728 S Broad St, Philadelphia, PA 19146 · (215) 760-6291'
    ].join('\n')
  });

  Logger.log('Raffle: verification code emailed (vid ' + vid + ', test=' + !!test + ').');
  return jsonOut({ ok: true, needsCode: true, vid: vid,
    message: 'We emailed a 6-digit code to ' + email + '.' });
}

// ---------- Step 2: confirm the code, then actually enter them ----------
function raffleVerifyCode_(d, test) {
  var cache = CacheService.getScriptCache();
  var vid = String(d.vid || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(vid)) {
    throw makeValidationError('That entry expired. Start again.');
  }
  var key = RAFFLE_PENDING_PREFIX + vid;
  var raw = cache.get(key);
  if (!raw) throw makeValidationError('That code expired. Start again and we will send a new one.');

  var pending = JSON.parse(raw);
  var supplied = String(d.code || '').replace(/\D/g, '');

  if (supplied !== pending.code) {
    pending.attempts = (pending.attempts || 0) + 1;
    if (pending.attempts >= RAFFLE_CODE_MAX_ATTEMPTS) {
      cache.remove(key);
      throw makeValidationError('Too many wrong codes. Start again and we will send a new one.');
    }
    cache.put(key, JSON.stringify(pending), RAFFLE_CODE_TTL_SECONDS);
    throw makeValidationError('That code is not right. Check your email and try again.');
  }

  // Verified. The entry is written from the CACHED values, never from anything
  // the client sent with this second request -- otherwise someone could verify
  // one address and enter a different one.
  cache.remove(key);
  var name = pending.name, email = pending.email, phone = pending.phone;
  var isTest = !!pending.test;

  var emailKey = raffleEmailKey_(email), phoneKey = rafflePhoneKey_(phone);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw makeValidationError('We are busy for a moment — tap Enter again.');
  var appended;
  try {
    var existing = raffleReadEntries_(isTest);
    for (var i = 0; i < existing.length; i++) {
      if ((emailKey && existing[i].emailKey === emailKey) ||
          (phoneKey && existing[i].phoneKey === phoneKey)) {
        return jsonOut({ ok: true, already: true,
          message: 'You are already entered! Winner announced at ' + RAFFLE_ANNOUNCE_AT + '.' });
      }
    }
    appended = raffleAppendEntry_(name, email, phone, isTest);
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }

  var fub = rafflePushToFub_(name, email, phone, isTest);
  try { raffleRecordFubOutcome_(appended.row, fub, isTest); }
  catch (recErr) { Logger.log('raffleRecordFubOutcome_ failed: ' + recErr); }
  if (!fub.ok) {
    try {
      sendErrorAlert('Raffle: FUB write failed for ' + name,
        'Entry IS saved in the raffle sheet (row ' + appended.row + ') and is eligible ' +
        'for the draw. Only the FUB push failed; raffleRetryFubFailures() can re-push it.\n\n' +
        fub.error);
    } catch (alertErr) { Logger.log('Raffle FUB alert failed: ' + alertErr); }
  }

  return jsonOut({ ok: true, verified: true,
    message: 'You are entered! Winner announced at ' + RAFFLE_ANNOUNCE_AT + '.' });
}

function raffleAppendEntry_(name, email, phone, test) {
  var sh = raffleSheet_(test);
  sh.appendRow([
    raffleFmt_(raffleNow_()), name, email, phone,
    'Yes', RAFFLE_CONSENT_VERSION,
    test ? (QA_TEST_PREFIX + RAFFLE_EVENT_NAME) : RAFFLE_EVENT_NAME,
    'pending', '', 'Yes', 'Yes (code confirmed)'
  ]);
  return { row: sh.getLastRow() };
}

function raffleRecordFubOutcome_(row, fub, test) {
  var sh = raffleSheet_(test);
  sh.getRange(row, 8).setValue(fub.ok ? 'ok' : ('failed: ' + String(fub.error).slice(0, 200)));
  if (fub.personId) sh.getRange(row, 9).setValue(fub.personId);
}

// Reads every entry row into objects. Small by construction (the party is
// capped at 125), so a full read per submission is cheap and keeps the
// duplicate check reading the same source of truth the draw will.
function raffleReadEntries_(test) {
  var sh = raffleSheet_(test);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, RAFFLE_SHEET_HEADERS.length).getValues();
  var out = [];
  values.forEach(function (r, idx) {
    var name = String(r[1] || '').trim();
    if (!name) return;
    if (String(r[9] || 'Yes').toLowerCase() === 'no') return; // manually disqualified
    out.push({
      row: idx + 2,
      timestamp: r[0],
      name: name,
      email: String(r[2] || '').trim(),
      phone: String(r[3] || '').trim(),
      emailKey: raffleEmailKey_(r[2]),
      phoneKey: rafflePhoneKey_(r[3]),
      fubStatus: String(r[7] || '')
    });
  });
  return out;
}

// ---------- FUB ----------
function rafflePushToFub_(name, email, phone, test) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
    if (!apiKey) return { ok: false, error: 'FUB_API_KEY script property is not set.' };

    var parts = splitName(name);
    var payload = {
      firstName: (test ? QA_TEST_PREFIX : '') + parts.first,
      lastName: parts.last,
      source: RAFFLE_SOURCE,
      tags: test ? RAFFLE_TAGS.concat([QA_TEST_TAG]) : RAFFLE_TAGS.slice(),
      emails: [{ value: email }],
      phones: [{ value: phone.replace(/\D/g, '') }],
      background: (test ? (QA_TEST_BACKGROUND_LEAD_IN + '\n\n') : '') +
                  raffleBackground_(name, email, phone)
    };
    // Same structured consent capture the open-house and intake forms use
    // (FUB custom field id 23, "Consent — Captured Date"). Entry requires
    // consent, so by the time this runs it is always a Yes.
    payload[CONSENT_CUSTOM_FIELD] = Utilities.formatDate(raffleNow_(), RAFFLE_TZ, 'yyyy-MM-dd');

    var resp = UrlFetchApp.fetch('https://api.followupboss.com/v1/people', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      return { ok: false, error: 'FUB /v1/people returned ' + code + ': ' + resp.getContentText().slice(0, 400) };
    }

    var personId = null;
    try { personId = JSON.parse(resp.getContentText()).id; } catch (parseErr) { /* non-fatal */ }

    // The note is a separate call and a separate failure mode: a missing note
    // is a much smaller problem than a missing contact, so a note failure does
    // not fail the push.
    if (personId) {
      try { raffleAddNote_(personId, name, apiKey, test); }
      catch (noteErr) { Logger.log('Raffle note failed for person ' + personId + ': ' + noteErr); }

      // FUB does NOT merge on email -- posting an address that already exists
      // creates a SECOND person record. That is established by this project's
      // own flagPossibleDuplicatesByEmail_, which the open-house and both intake
      // paths already call after every create. The raffle has to do the same or
      // a block-party entrant who is already a TSG contact quietly becomes a
      // duplicate with nothing marking it. Best-effort by the same contract as
      // the other callers: the entry already succeeded and must never be
      // reported as failed because this secondary step broke.
      try { flagPossibleDuplicatesByEmail_(email, personId, apiKey); }
      catch (dupErr) { Logger.log('Raffle duplicate flagging failed: ' + dupErr); }
    }
    return { ok: true, personId: personId };

  } catch (err) {
    return { ok: false, error: 'FUB fetch threw: ' + (err && err.message ? err.message : String(err)) };
  }
}

function raffleBackground_(name, email, phone) {
  return [
    'Entered the ' + RAFFLE_EVENT_NAME + ' prize drawing (' + RAFFLE_PRIZE_SHORT + ').',
    'ATTENDED the TSG Block Party on Saturday, September 19, 2026 (1342 N Hancock St, Philadelphia).',
    '',
    'Entry submitted: ' + raffleFmt_(raffleNow_()) + ' ET',
    'Name: ' + name,
    'Email: ' + email,
    'Phone: ' + phone,
    '',
    'EMAIL VERIFIED: this address was confirmed at entry -- a 6-digit code was',
    'emailed to it and typed back before the entry was accepted. The phone number',
    'was format- and plausibility-checked but NOT ownership-verified (no SMS).',
    '',
    'CONSENT: accepted the Official Rules and gave express written consent to be',
    'contacted by call, text and email (including autodialed/prerecorded messages)',
    'about real estate services. Consent language version: ' + RAFFLE_CONSENT_VERSION + '.'
  ].join('\n');
}

function raffleAddNote_(personId, name, apiKey, test) {
  var resp = UrlFetchApp.fetch('https://api.followupboss.com/v1/notes', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
    payload: JSON.stringify({
      personId: personId,
      subject: (test ? QA_TEST_PREFIX : '') + 'Block Party 2026 — raffle entry',
      body: 'Met at the TSG Block Party, Sat 9/19/2026, 1342 N Hancock St. Entered the ' +
            RAFFLE_PRIZE_SHORT + ' drawing and consented to follow-up. ' +
            'Warm event lead — worth a personal call, not just a drip.',
      isHtml: false
    }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('Raffle note POST returned ' + code + ': ' + resp.getContentText().slice(0, 300));
  }
}

// Re-pushes any entry whose FUB write failed. Safe to run repeatedly — it only
// touches rows still marked failed, and rewrites their status on success.
function raffleRetryFubFailures() {
  var rows = raffleReadEntries_().filter(function (r) {
    return r.fubStatus.indexOf('failed') === 0 || r.fubStatus === 'pending';
  });
  var fixed = 0;
  rows.forEach(function (r) {
    var res = rafflePushToFub_(r.name, r.email, r.phone);
    raffleRecordFubOutcome_(r.row, res);
    if (res.ok) fixed++;
  });
  var msg = 'Retried ' + rows.length + ' entries; ' + fixed + ' now in FUB.';
  Logger.log(msg);
  return msg;
}

// ---------- The draw ----------
function raffleStoredWinner_(test) {
  var raw = PropertiesService.getScriptProperties().getProperty(raffleWinnerProp_(test));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

// Deliberately NOT repeatable. Once a winner is recorded it is returned as-is
// on every subsequent call, so a double-fired trigger, a refreshed admin page
// or a second tap can never re-roll a drawing that has already happened.
function raffleDrawWinner_(test) {
  var props = PropertiesService.getScriptProperties();
  var existing = raffleStoredWinner_(test);
  if (existing) return { ok: true, alreadyDrawn: true, result: existing };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Could not acquire the draw lock; try again.' };
  try {
    existing = raffleStoredWinner_(test);          // re-read inside the lock
    if (existing) return { ok: true, alreadyDrawn: true, result: existing };

    var entries = raffleReadEntries_(test);
    if (!entries.length) {
      return { ok: false, error: 'No eligible entries — nothing to draw.' };
    }

    // Fisher-Yates over a copy: the winner is element 0 and the backups follow,
    // so winner and backups come from one unbiased shuffle rather than
    // repeated independent picks that could land on the same person.
    var pool = entries.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }

    var slim = function (e) { return { name: e.name, email: e.email, phone: e.phone, row: e.row }; };
    var result = {
      test: !!test,
      drawnAt: raffleFmt_(raffleNow_()),
      totalEligible: entries.length,
      winner: slim(pool[0]),
      backups: pool.slice(1, 1 + RAFFLE_BACKUP_COUNT).map(slim)
    };

    props.setProperty(raffleWinnerProp_(test), JSON.stringify(result));
    try { raffleWriteDrawTab_(result, test); } catch (tabErr) { Logger.log('Draw tab write failed: ' + tabErr); }
    try { raffleEmailResult_(result, test); } catch (mailErr) {
      Logger.log('Draw email failed: ' + mailErr);
      return { ok: true, alreadyDrawn: false, result: result, emailFailed: true };
    }
    return { ok: true, alreadyDrawn: false, result: result };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }
}

// The 6:15 trigger target. Thin on purpose: all the logic (and the
// already-drawn guard) lives in raffleDrawWinner_.
function raffleScheduledDraw() {
  var res = raffleDrawWinner_(false);   // the 6:15 trigger is always the LIVE draw
  if (!res.ok) {
    Logger.log('Scheduled draw did not complete: ' + res.error);
    try {
      sendErrorAlert('Raffle: 6:15 draw did NOT complete', res.error +
        '\n\nDraw manually from the admin link (raffleAdminLinks() in the editor).');
    } catch (alertErr) { /* nothing more we can do */ }
  }
}

function raffleWriteDrawTab_(result, test) {
  var ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP));
  var tab = test ? 'Draw Result (TEST)' : 'Draw Result';
  var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
  sh.clear();
  var rows = [
    ['Event', (test ? QA_TEST_PREFIX : '') + RAFFLE_EVENT_NAME],
    ['Prize', RAFFLE_PRIZE_SHORT],
    ['Drawn at (ET)', result.drawnAt],
    ['Eligible entries', result.totalEligible],
    [],
    ['WINNER', result.winner.name],
    ['Phone', result.winner.phone],
    ['Email', result.winner.email]
  ];
  result.backups.forEach(function (b, i) {
    rows.push([], ['Backup ' + (i + 1), b.name], ['Phone', b.phone], ['Email', b.email]);
  });
  sh.getRange(1, 1, rows.length, 2).setValues(rows.map(function (r) {
    return [r[0] === undefined ? '' : r[0], r[1] === undefined ? '' : r[1]];
  }));
  sh.getRange(6, 1, 1, 2).setFontWeight('bold').setFontSize(14);
}

function raffleEmailResult_(result, test) {
  var w = result.winner;
  var lines = [
    (test ? QA_TEST_PREFIX : '') + RAFFLE_EVENT_NAME + ' — RAFFLE RESULT',
    ''];
  if (test) {
    lines.push('*** THIS IS A TEST DRAW. Not the real winner. ***',
      'Drawn from the "' + RAFFLE_TEST_SHEET_NAME + '" tab. The real 6:15 draw is',
      'untouched and still pending.', '');
  }
  lines = lines.concat([
    'WINNER: ' + w.name,
    'Phone:  ' + w.phone,
    'Email:  ' + w.email,
    '',
    'Prize:            ' + RAFFLE_PRIZE_SHORT + ' (ARV ' + RAFFLE_PRIZE_ARV + ')',
    'Drawn at:         ' + result.drawnAt + ' ET',
    'Eligible entries: ' + result.totalEligible,
    'Announce at:      ' + RAFFLE_ANNOUNCE_AT,
    ''
  ]);
  if (result.backups.length) {
    lines.push('BACKUPS (in order, if the winner has already left):');
    result.backups.forEach(function (b, i) {
      lines.push('  ' + (i + 1) + '. ' + b.name + ' — ' + b.phone + ' — ' + b.email);
    });
    lines.push('');
  }
  lines.push('Full entry list: https://docs.google.com/spreadsheets/d/' +
    PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP));
  lines.push('');
  lines.push('This draw is recorded and is not repeatable — re-running the draw');
  lines.push('returns this same winner by design.');

  // In test mode this collapses to QA_TEST_NOTIFY_EMAIL only -- Ryan does not
  // get paged about a rehearsal.
  MailApp.sendEmail({
    to: qaTestRecipients_(RAFFLE_RESULT_EMAIL.split(',')).join(','),
    subject: (test ? QA_TEST_PREFIX : '🏈 ') + 'Block Party Raffle Winner: ' + w.name +
             ' (' + result.totalEligible + ' entries)',
    body: lines.join('\n')
  });
}

// Break-glass: clears the recorded winner so a draw can be re-run. Only for a
// genuine mistake (e.g. the draw fired before entries closed). Deliberately
// not reachable from any URL — it has to be run by hand from the editor.
function raffleResetDrawDANGER() {
  PropertiesService.getScriptProperties().deleteProperty(RAFFLE_WINNER_PROP);
  Logger.log('Recorded LIVE winner cleared. The next live draw will pick a NEW winner.');
}

// Wipes the test tab and the test winner so a rehearsal can be run again from
// clean. Touches nothing live -- safe to run as often as you like, including
// during the party.
function raffleResetTest() {
  PropertiesService.getScriptProperties().deleteProperty(RAFFLE_TEST_WINNER_PROP);
  var sh = raffleSheet_(true);
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  var ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP));
  var tab = ss.getSheetByName('Draw Result (TEST)');
  if (tab) ss.deleteSheet(tab);
  var msg = 'Test entries and test draw cleared. Live entries and the live draw are untouched.';
  Logger.log(msg);
  return msg;
}
