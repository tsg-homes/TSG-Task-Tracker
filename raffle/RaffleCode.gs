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

var RAFFLE_SHEET_PROP   = 'RAFFLE_SHEET_ID';
var RAFFLE_WINNER_PROP  = 'RAFFLE_WINNER_JSON';
var RAFFLE_ADMIN_PROP   = 'RAFFLE_ADMIN_KEY';
var RAFFLE_BACKUP_COUNT = 2;

// Consent language version stamped onto every row. Bump this string if the
// consent copy in RaffleForm.html changes, so the audit trail stays honest
// about which wording a given entrant actually saw.
var RAFFLE_CONSENT_VERSION = 'raffle-v1 (2026-09-16)';

var RAFFLE_SHEET_HEADERS = [
  'Timestamp (ET)', 'Full Name', 'Email', 'Phone',
  'Consent', 'Consent Version', 'Entry Source',
  'FUB Status', 'FUB Person ID', 'Eligible'
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

function raffleSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP);
  if (!id) throw new Error(RAFFLE_SHEET_PROP + ' is not set. Run setupRaffle() once from the editor.');
  return SpreadsheetApp.openById(id).getSheets()[0];
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
    base + '?form=raffle&action=draw&key=' + key;
  Logger.log(msg);
  return msg;
}


// ---------- doGet branch (reached from Code.gs's one-line hook) ----------
function raffleServeForm_(e, baseUrl) {
  var action = (e.parameter.action || '').toString().toLowerCase();

  if (action === 'status' || action === 'draw') {
    var key = PropertiesService.getScriptProperties().getProperty(RAFFLE_ADMIN_PROP);
    // Constant-ish comparison and an identical response for a wrong key as for
    // no key, so this can't be probed.
    if (!key || (e.parameter.key || '').toString() !== key) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Not found.</p>');
    }
    if (action === 'status') return raffleStatusPage_();
    return raffleDrawPage_();
  }

  var tmpl = HtmlService.createTemplateFromFile('RaffleForm');
  tmpl.submitToken   = getSubmitToken();
  tmpl.baseUrl       = baseUrl;
  tmpl.kiosk         = (e.parameter.kiosk || '') ? '1' : '';
  tmpl.prizeShort    = RAFFLE_PRIZE_SHORT;
  tmpl.announceAt    = RAFFLE_ANNOUNCE_AT;
  // The page runs its own clock: it counts down to 3:00, opens itself, and goes
  // dead at 6:15 -- all without a reload. It measures against the SERVER clock,
  // not the visitor's, so a phone with a wrong clock still opens and closes on
  // time. The server re-checks the window on every submit regardless.
  tmpl.openAtMs      = String(new Date(RAFFLE_OPEN_AT).getTime());
  tmpl.closeAtMs     = String(new Date(RAFFLE_CLOSE_AT).getTime());
  tmpl.serverNowMs   = String(Date.now());
  return tmpl.evaluate()
    .setTitle('Enter to Win | ' + RAFFLE_EVENT_NAME)
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

function raffleStatusPage_() {
  var rows = raffleReadEntries_();
  var winner = raffleStoredWinner_();
  var html = '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
    '<h2 style="margin:0 0 4px">' + RAFFLE_EVENT_NAME + '</h2>' +
    '<p style="color:#666;margin:0 0 20px">Entry state: <b>' + raffleEntryState_() + '</b></p>' +
    '<div style="font-size:64px;font-weight:700;color:#15464A;line-height:1">' + rows.length + '</div>' +
    '<div style="color:#666;margin-bottom:20px">eligible entries</div>';
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

function raffleDrawPage_() {
  var res = raffleDrawWinner_();
  if (!res.ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;padding:24px"><h2>Draw not completed</h2><p>' +
      res.error + '</p></div>');
  }
  var w = res.result.winner;
  var html = '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
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
  try {
    var name  = collapseSpaces(d.fullName);
    var email = String(d.email || '').trim().toLowerCase();
    var phone = String(d.phone || '').trim();

    // All three fields and the consent box are required, per Durand
    // (2026-09-16). Enforced server-side, not just by the page's `required`
    // attributes, because doPost can be hit directly.
    if (!name)  throw makeValidationError('Enter your full name.');
    if (!email) throw makeValidationError('Enter your email address.');
    if (!phone) throw makeValidationError('Enter your phone number.');
    validateEmailField(email);
    validatePhoneField(phone);
    if (name.indexOf(' ') === -1) {
      throw makeValidationError('Enter your first and last name.');
    }
    if (d.consent !== 'Yes') {
      throw makeValidationError('You must accept the Official Rules to enter.');
    }

    // Entry window. Re-checked here so a link saved from the event can't be
    // used to enter after the draw, and so nobody can enter before it opens.
    var state = raffleEntryState_();
    if (state === 'before') {
      throw makeValidationError('Entries are not open yet. Come find us at the party!');
    }
    if (state === 'closed') {
      throw makeValidationError('Entries are closed — the winner is announced at ' +
        RAFFLE_ANNOUNCE_AT + '. Thanks for coming out!');
    }

    var emailKey = raffleEmailKey_(email);
    var phoneKey = rafflePhoneKey_(phone);

    // One entry per person. The duplicate check and the append have to be a
    // single atomic step, or two people hitting submit at the same instant
    // both read "not yet entered" and both get written.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      throw makeValidationError('We are busy for a moment — tap Enter again.');
    }
    var appended;
    try {
      var existing = raffleReadEntries_();
      for (var i = 0; i < existing.length; i++) {
        if ((emailKey && existing[i].emailKey === emailKey) ||
            (phoneKey && existing[i].phoneKey === phoneKey)) {
          // Not an error the entrant did anything wrong about — tell them
          // they're in, rather than showing a failure for a working entry.
          return jsonOut({
            ok: true,
            already: true,
            message: 'You are already entered! Winner announced at ' + RAFFLE_ANNOUNCE_AT + '.'
          });
        }
      }
      appended = raffleAppendEntry_(name, email, phone);
    } finally {
      try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
    }

    // The entry is now safely recorded. Everything past this point is
    // best-effort and must never turn a saved entry into a visible failure.
    var fub = rafflePushToFub_(name, email, phone);
    try {
      raffleRecordFubOutcome_(appended.row, fub);
    } catch (recErr) {
      Logger.log('raffleRecordFubOutcome_ failed: ' + recErr);
    }
    if (!fub.ok) {
      // Durand finds out now, not on Monday when he wonders why 40 leads
      // never showed up in FUB.
      try {
        sendErrorAlert('Raffle: FUB write failed for ' + name,
          'Entry IS saved in the raffle sheet (row ' + appended.row + ') and is eligible ' +
          'for the draw. Only the FUB push failed; raffleRetryFubFailures() can re-push it.\n\n' +
          fub.error);
      } catch (alertErr) { Logger.log('Raffle FUB alert failed: ' + alertErr); }
    }

    return jsonOut({
      ok: true,
      message: 'You are entered! Winner announced at ' + RAFFLE_ANNOUNCE_AT + '.'
    });

  } catch (err) {
    if (err && err.isValidation) return jsonOut({ ok: false, error: err.message });
    Logger.log('raffleHandleSubmission_ error: ' + (err && err.stack ? err.stack : err));
    try {
      sendErrorAlert('Raffle: submission exception', (err && err.stack ? err.stack : String(err)));
    } catch (alertErr) { /* never let the alert swallow the response */ }
    return jsonOut({ ok: false, error: 'Something went wrong. Grab someone from TSG and we will get you entered.' });
  }
}

function raffleAppendEntry_(name, email, phone) {
  var sh = raffleSheet_();
  sh.appendRow([
    raffleFmt_(raffleNow_()), name, email, phone,
    'Yes', RAFFLE_CONSENT_VERSION, RAFFLE_EVENT_NAME,
    'pending', '', 'Yes'
  ]);
  return { row: sh.getLastRow() };
}

function raffleRecordFubOutcome_(row, fub) {
  var sh = raffleSheet_();
  sh.getRange(row, 8).setValue(fub.ok ? 'ok' : ('failed: ' + String(fub.error).slice(0, 200)));
  if (fub.personId) sh.getRange(row, 9).setValue(fub.personId);
}

// Reads every entry row into objects. Small by construction (the party is
// capped at 125), so a full read per submission is cheap and keeps the
// duplicate check reading the same source of truth the draw will.
function raffleReadEntries_() {
  var sh = raffleSheet_();
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
function rafflePushToFub_(name, email, phone) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
    if (!apiKey) return { ok: false, error: 'FUB_API_KEY script property is not set.' };

    var parts = splitName(name);
    var payload = {
      firstName: parts.first,
      lastName: parts.last,
      source: RAFFLE_SOURCE,
      tags: RAFFLE_TAGS.slice(),
      emails: [{ value: email }],
      phones: [{ value: phone.replace(/\D/g, '') }],
      background: raffleBackground_(name, email, phone)
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
      try { raffleAddNote_(personId, name, apiKey); }
      catch (noteErr) { Logger.log('Raffle note failed for person ' + personId + ': ' + noteErr); }
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
    'CONSENT: accepted the Official Rules and gave express written consent to be',
    'contacted by call, text and email (including autodialed/prerecorded messages)',
    'about real estate services. Consent language version: ' + RAFFLE_CONSENT_VERSION + '.'
  ].join('\n');
}

function raffleAddNote_(personId, name, apiKey) {
  var resp = UrlFetchApp.fetch('https://api.followupboss.com/v1/notes', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
    payload: JSON.stringify({
      personId: personId,
      subject: 'Block Party 2026 — raffle entry',
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
function raffleStoredWinner_() {
  var raw = PropertiesService.getScriptProperties().getProperty(RAFFLE_WINNER_PROP);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

// Deliberately NOT repeatable. Once a winner is recorded it is returned as-is
// on every subsequent call, so a double-fired trigger, a refreshed admin page
// or a second tap can never re-roll a drawing that has already happened.
function raffleDrawWinner_() {
  var props = PropertiesService.getScriptProperties();
  var existing = raffleStoredWinner_();
  if (existing) return { ok: true, alreadyDrawn: true, result: existing };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Could not acquire the draw lock; try again.' };
  try {
    existing = raffleStoredWinner_();               // re-read inside the lock
    if (existing) return { ok: true, alreadyDrawn: true, result: existing };

    var entries = raffleReadEntries_();
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
      drawnAt: raffleFmt_(raffleNow_()),
      totalEligible: entries.length,
      winner: slim(pool[0]),
      backups: pool.slice(1, 1 + RAFFLE_BACKUP_COUNT).map(slim)
    };

    props.setProperty(RAFFLE_WINNER_PROP, JSON.stringify(result));
    try { raffleWriteDrawTab_(result); } catch (tabErr) { Logger.log('Draw tab write failed: ' + tabErr); }
    try { raffleEmailResult_(result); } catch (mailErr) {
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
  var res = raffleDrawWinner_();
  if (!res.ok) {
    Logger.log('Scheduled draw did not complete: ' + res.error);
    try {
      sendErrorAlert('Raffle: 6:15 draw did NOT complete', res.error +
        '\n\nDraw manually from the admin link (raffleAdminLinks() in the editor).');
    } catch (alertErr) { /* nothing more we can do */ }
  }
}

function raffleWriteDrawTab_(result) {
  var ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP));
  var sh = ss.getSheetByName('Draw Result') || ss.insertSheet('Draw Result');
  sh.clear();
  var rows = [
    ['Event', RAFFLE_EVENT_NAME],
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

function raffleEmailResult_(result) {
  var w = result.winner;
  var lines = [
    RAFFLE_EVENT_NAME + ' — RAFFLE RESULT',
    '',
    'WINNER: ' + w.name,
    'Phone:  ' + w.phone,
    'Email:  ' + w.email,
    '',
    'Prize:            ' + RAFFLE_PRIZE_SHORT + ' (ARV ' + RAFFLE_PRIZE_ARV + ')',
    'Drawn at:         ' + result.drawnAt + ' ET',
    'Eligible entries: ' + result.totalEligible,
    'Announce at:      ' + RAFFLE_ANNOUNCE_AT,
    ''
  ];
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

  MailApp.sendEmail({
    to: RAFFLE_RESULT_EMAIL,
    subject: '🏈 Block Party Raffle Winner: ' + w.name + ' (' + result.totalEligible + ' entries)',
    body: lines.join('\n')
  });
}

// Break-glass: clears the recorded winner so a draw can be re-run. Only for a
// genuine mistake (e.g. the draw fired before entries closed). Deliberately
// not reachable from any URL — it has to be run by hand from the editor.
function raffleResetDrawDANGER() {
  PropertiesService.getScriptProperties().deleteProperty(RAFFLE_WINNER_PROP);
  Logger.log('Recorded winner cleared. The next draw will pick a NEW winner.');
}
