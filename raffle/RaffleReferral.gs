// RaffleReferral.gs — referral-based entry for the TSG Block Party 2026 drawing
//
// Added 2026-09-17, per Durand. This replaces "fill in your details to enter"
// with "refer someone who is thinking of buying or selling in the next year,
// and each confirmed referral is worth five more entries".
//
// The flow, in order. Each step is a separate POST and each one is enforced
// server-side, because the page can be bypassed:
//
//   1. The entrant gives their name, email and phone, accepts the rules, and
//      verifies the email with a 6-digit code (raffleRequestCode_ /
//      raffleVerifyCode_).
//   2. On verification the server resolves them against FUB SILENTLY -- one
//      confident match updates that contact, no match creates one -- and the
//      response is identical either way. There is no lookup screen and no "we
//      found your record", so an entrant never learns whether they were already
//      in the database. (Durand, 2026-09-17.)
//   3. They give the referral's name, email, phone, Buyer/Seller and timeframe.
//   4. The referral is created in FUB, linked to the entrant both ways, and a
//      row is written with status 'pending-consent'.
//   5. The entrant presses a button; the referral gets an HTML email -- copied
//      to the entrant and to info@ -- asking them to confirm or correct their
//      details and give consent.
//   6. The referral opens the link and consents. Only then does the row become
//      'eligible', and only eligible rows are drawn from.
//
// THE ENUMERATION PROBLEM, stated plainly because it is the real residual cost.
// Step 3 tells a member of the public whether a given address is already in
// TSG's CRM: "you can't refer this person" means "this person is already a
// client". That is inherent in "existing contacts don't count", so it is bounded
// rather than removed:
//   * the response never contains a name, a record id, or any detail;
//   * one generic refusal covers BOTH "already a contact" and "already referred
//     by someone else", so the two cannot be told apart;
//   * step 3 is reachable only after verifying an email the visitor controls, and
//     each verified address gets RAFFLE_LOOKUP_MAX_PER_ENTRANT lookups, so
//     walking a list of 1,000 addresses would take ~125 working inboxes; and
//   * a global ceiling alerts and then refuses, so a burst is visible.
// Step 2 leaks nothing at all, by construction.

// ---------- Configuration ----------
var RAFFLE_ENTRANT_TAGS  = ['Block Party 2026', 'Block Party Raffle Entrant',
                            'Event Lead', 'Referrer'];
var RAFFLE_REFERRAL_TAGS = ['Block Party 2026', 'Referred Lead', 'Event Lead'];

// The two roles the radio buttons offer. FUB has no native buyer/seller field on
// a person in this account, so these go on as TAGS -- the same convention the
// Buyer and Seller intake forms already use (Code.gs buildBuyerPersonPayload /
// buildSellerPersonPayload both start from tags: ['Buyer'] / ['Seller']).
var RAFFLE_ROLES = ['Buyer', 'Seller'];

// The role is stored as a NOUN ("Buyer") because that is what FUB tags it as, but
// prose needs the verb: "looking to sell", not "looking to seller". Every place
// that drops the role into a sentence goes through here.
function raffleRoleVerb_(role) {
  var r = String(role || '').toLowerCase();
  if (r.indexOf('sell') === 0) return 'sell';
  if (r.indexOf('buy') === 0) return 'buy';
  return r;
}

// Durand: "the same timeframe dropdown live linked to fub as the other forms,
// defaulted to the 1 year bucket". The list comes from getFubTimeframes() in
// Code.gs (live GET /v1/timeframes, cached 30 min) so there is no second
// hardcoded copy of FUB's labels to drift -- that was the 2026-09-07 fix.
//
// The default is matched against that live list rather than hardcoded, because
// this account's labels are its own ("0-3 Months", "7-12 Months", ...) and could
// be renamed in FUB tomorrow. Patterns are tried in order and the first that
// matches a real label wins; nothing matching leaves the dropdown unset rather
// than picking an arbitrary bucket.
var RAFFLE_DEFAULT_TIMEFRAME_PATTERNS = [
  /\b7\s*-\s*12\b/i,        // "7-12 Months" — this account's 1-year bucket
  /\b6\s*-\s*12\b/i,
  /\b9\s*-\s*12\b/i,
  /\b12\s*months?\b/i,
  /\b1\s*year\b/i,
  /\byear\b/i
];

// Consent links have to keep working after the party: someone who opens the
// email on Sunday should still be able to confirm their details and consent, so
// TSG gets a clean contact record even though the drawing is over. What they
// CANNOT do is win an entry -- see raffleConsentSubmit_.
var RAFFLE_CONSENT_ACTION = 'consent';

// Referral-lookup caps. Same shape and the same reasoning as the verification
// email caps in RaffleCode.gs: bound the abuse without blocking a real queue.
var RAFFLE_LOOKUP_PREFIX = 'raffle_lookup_';
var RAFFLE_LOOKUP_MAX_PER_ENTRANT = 8;
var RAFFLE_LOOKUP_ENTRANT_WINDOW_SECONDS = 3600;
var RAFFLE_LOOKUP_GLOBAL_PREFIX = 'raffle_lookup_all_';
var RAFFLE_LOOKUP_MAX_GLOBAL = 600;
var RAFFLE_LOOKUP_GLOBAL_WINDOW_SECONDS = 21600;

// Custom fields. FUB custom fields are per-account and this project has been
// bitten by assuming one exists (Code.gs stripUnverifiedIntakeFields_ exists
// precisely because customBirthday / customReferredBy were guessed at once).
// So nothing here is hardcoded: the real field list is read from
// /v1/customFields and matched by label. A field that does not exist is skipped
// and reported once, never invented.
var RAFFLE_CUSTOM_FIELD_CACHE_KEY = 'raffle_fub_customfields_v1';
var RAFFLE_CUSTOM_FIELD_CACHE_SECONDS = 1800;
var RAFFLE_REFERRAL_COUNT_LABELS = ['referral count', 'referrals', 'number of referrals',
                                    '# of referrals', 'total referrals'];
var RAFFLE_REFERRED_BY_LABELS    = ['referred by', 'referral source', 'referrer'];

// ---------- FUB plumbing ----------
function raffleFubKey_() {
  return PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
}

function raffleFubAuth_(apiKey) {
  return { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') };
}

// One place that knows how to talk to FUB and how to fail. Returns
// { ok, code, body } and never throws: every caller here is best-effort on top
// of a sheet row that has already been written, and an entrant must never be
// turned away because the CRM was slow.
function raffleFubCall_(url, method, payload, apiKey) {
  var options = {
    method: method || 'get',
    headers: raffleFubAuth_(apiKey),
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  try {
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    var body = null;
    try { body = JSON.parse(text); } catch (parseErr) { body = null; }
    return { ok: code >= 200 && code < 300, code: code, body: body, text: text };
  } catch (err) {
    Logger.log('raffleFubCall_ ' + method + ' ' + url + ' threw: ' + err);
    return { ok: false, code: 0, body: null, text: String(err) };
  }
}

// The account's custom fields, by lowercased label -> API key ("customReferredBy").
// Cached for 30 minutes like getFubTimeframes. Returns {} on any failure, which
// makes every caller's "field not found" branch the same branch.
function raffleFubCustomFields_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(RAFFLE_CUSTOM_FIELD_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (err) { /* fall through and refetch */ }
  }
  var apiKey = raffleFubKey_();
  if (!apiKey) return {};
  var res = raffleFubCall_('https://api.followupboss.com/v1/customFields', 'get', null, apiKey);
  if (!res.ok) {
    Logger.log('raffleFubCustomFields_: fetch failed ' + res.code + ': ' + String(res.text).slice(0, 200));
    return {};
  }
  var list = (res.body && (res.body.customfields || res.body.customFields)) || [];
  var map = {};
  list.forEach(function (f) {
    if (!f) return;
    var label = String(f.label || f.name || '').trim().toLowerCase();
    var key = String(f.name || '').trim();
    if (label && key) map[label] = key;
  });
  cache.put(RAFFLE_CUSTOM_FIELD_CACHE_KEY, JSON.stringify(map), RAFFLE_CUSTOM_FIELD_CACHE_SECONDS);
  return map;
}

// First label in `labels` that this account actually has, or null. Null means
// "skip this field", never "make one up".
function raffleCustomFieldKey_(labels) {
  var map = raffleFubCustomFields_();
  for (var i = 0; i < labels.length; i++) {
    if (map[labels[i]]) return map[labels[i]];
  }
  return null;
}

// ---------- Timeframes ----------
// Wraps Code.gs's getFubTimeframes so a FUB outage degrades to an empty list
// (the dropdown then renders with just the placeholder) rather than an exception
// on the page load of a public form.
function raffleTimeframes_() {
  try {
    var list = getFubTimeframes();
    return Array.isArray(list) ? list : [];
  } catch (err) {
    Logger.log('raffleTimeframes_: getFubTimeframes threw: ' + err);
    return [];
  }
}

// The label to preselect. Matched against the live list; null if nothing looks
// like a one-year bucket, which leaves the dropdown on its placeholder.
function raffleDefaultTimeframe_(list) {
  list = list || [];
  for (var p = 0; p < RAFFLE_DEFAULT_TIMEFRAME_PATTERNS.length; p++) {
    for (var i = 0; i < list.length; i++) {
      var name = String((list[i] && list[i].name) || '');
      if (RAFFLE_DEFAULT_TIMEFRAME_PATTERNS[p].test(name)) return name;
    }
  }
  Logger.log('raffleDefaultTimeframe_: no timeframe in ' +
    JSON.stringify(list.map(function (t) { return t && t.name; })) +
    ' looked like a 1-year bucket; the dropdown will open unset.');
  return null;
}

// ---------- Lookup abuse caps ----------
function raffleReferralLookupQuota_(entrantEmailKey) {
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try { haveLock = lock.tryLock(1000); } catch (lockErr) { haveLock = false; }
  if (!haveLock) {
    throw makeValidationError('We are busy for a moment — try that again.');
  }
  try {
    var key = RAFFLE_LOOKUP_PREFIX + entrantEmailKey;
    var n = Number(cache.get(key) || 0);
    if (n >= RAFFLE_LOOKUP_MAX_PER_ENTRANT) {
      Logger.log('Raffle: referral-lookup cap hit for one entrant (' + n + ').');
      throw makeValidationError('That is a lot of lookups. Grab someone from TSG and ' +
        'we will help you finish your entry.');
    }
    var gKey = RAFFLE_LOOKUP_GLOBAL_PREFIX +
      Math.floor(Date.now() / (RAFFLE_LOOKUP_GLOBAL_WINDOW_SECONDS * 1000));
    var g = Number(cache.get(gKey) || 0);
    if (g >= RAFFLE_LOOKUP_MAX_GLOBAL) {
      Logger.log('Raffle: GLOBAL referral-lookup ceiling hit (' + g + '). Possible enumeration.');
      try {
        sendErrorAlert('Raffle: referral-lookup ceiling hit',
          'The rolling ' + (RAFFLE_LOOKUP_GLOBAL_WINDOW_SECONDS / 3600) + '-hour ceiling of ' +
          RAFFLE_LOOKUP_MAX_GLOBAL + ' referral lookups has been reached and further ' +
          'lookups are being refused.\n\nThis endpoint reveals whether an address is ' +
          'already a FUB contact, so a burst of lookups is what a CRM-enumeration ' +
          'attempt looks like. Check the raffle sheet before raising the ceiling.');
      } catch (alertErr) { /* never let the alert swallow the response */ }
      throw makeValidationError('We cannot check referrals right now. Grab someone from ' +
        'TSG and we will get you entered.');
    }
    cache.put(key, String(n + 1), RAFFLE_LOOKUP_ENTRANT_WINDOW_SECONDS);
    cache.put(gKey, String(g + 1), RAFFLE_LOOKUP_GLOBAL_WINDOW_SECONDS);
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }
}

// ---------- Step 3: can this person be referred? ----------
// Two ways the answer is no, and the caller must not be able to tell them apart:
//   * they are already a FUB contact, or
//   * someone else already referred them (any row, pending or eligible).
// Existing contacts never count, per Durand, and a referral counts for exactly
// one entrant -- the first to get their consent.
function raffleReferralEligibility_(email, phone, test) {
  var emailKey = raffleEmailKey_(email);
  var phoneKey = rafflePhoneKey_(phone);

  // The claim check first: it is local, free, and catches the common case.
  var rows = raffleReadEntries_(test);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    // A DECLINED referral is deliberately NOT skipped: somebody who said "do not
    // contact me" must not be put through the same email again by the next person
    // who happens to think of them. Superseded rows are skipped, because that
    // person did confirm -- just for somebody else's entry.
    if (r.status === RAFFLE_STATUS_SUPERSEDED) continue;
    if ((emailKey && r.referralEmailKey === emailKey) ||
        (phoneKey && r.referralPhoneKey === phoneKey)) {
      return { ok: false, reason: 'already-claimed' };
    }
  }

  var apiKey = raffleFubKey_();
  if (!apiKey) {
    // No key means no way to check FUB. Refusing everyone would kill the form;
    // accepting everyone would create duplicate contacts. Accept, and mark the
    // row so it is obvious afterwards which rows were never checked.
    Logger.log('raffleReferralEligibility_: FUB_API_KEY unset — referral accepted UNCHECKED.');
    return { ok: true, unchecked: true };
  }
  var matches;
  try {
    matches = raffleFindCandidates_(email, phoneKey, apiKey) || [];
  } catch (err) {
    Logger.log('raffleReferralEligibility_: FUB search failed: ' + err);
    return { ok: true, unchecked: true };
  }
  if (matches.length) return { ok: false, reason: 'already-a-contact' };
  return { ok: true };
}

// The one refusal message. Deliberately identical for both reasons, and it never
// names the person or says which check failed.
function raffleReferralRefusal_() {
  return 'We already know that person — a referral has to be someone new to us. ' +
         'Try a different friend or family member.';
}

// ---------- Step 3/4: create the referral and stage the entry ----------
function raffleSubmitReferral_(d, test) {
  var state = raffleEntryState_();
  if (test) {
    Logger.log('RAFFLE TEST MODE: entry-window check BYPASSED for a referral submission ' +
      '(real state was "' + state + '").');
  } else if (state === 'before') {
    throw makeValidationError('Entries are not open yet. Come find us at the party!');
  } else if (state === 'closed') {
    throw makeValidationError('Entries are closed — the winner is announced at ' +
      RAFFLE_ANNOUNCE_AT + '. Thanks for coming out!');
  }

  // The entrant half comes from the verified-entry cache, never from this
  // request: the same rule as raffleVerifyCode_. Someone who verified their own
  // address cannot then submit a referral "from" somebody else.
  var vid = String(d.vid || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(vid)) {
    throw makeValidationError('That session expired. Start again.');
  }
  var cache = CacheService.getScriptCache();
  var raw = cache.get(RAFFLE_VERIFIED_PREFIX + vid);
  if (!raw) {
    throw makeValidationError('That session expired. Start again and we will send a new code.');
  }
  var entrant = JSON.parse(raw);

  var refName = collapseSpaces(d.referralName);
  if (!refName) throw makeValidationError("Enter your referral's full name.");
  if (refName.indexOf(' ') === -1) {
    throw makeValidationError("Enter your referral's first and last name.");
  }
  var refEmail  = raffleRejectJunkEmail_(d.referralEmail);
  var refDigits = raffleRejectJunkPhone_(d.referralPhone);
  var refPhone  = collapseSpaces(d.referralPhone);

  var role = String(d.referralRole || '').trim();
  if (RAFFLE_ROLES.indexOf(role) === -1) {
    throw makeValidationError('Tell us whether they are looking to buy or to sell.');
  }
  var timeframe = collapseSpaces(d.referralTimeframe);

  // You cannot refer yourself. Checked on both keys, because the whole point of
  // the two-key dedupe elsewhere is that people vary one and not the other.
  if (raffleEmailKey_(refEmail) === raffleEmailKey_(entrant.email) ||
      (refDigits && rafflePhoneKey_(entrant.phone) === refDigits)) {
    throw makeValidationError('A referral has to be someone other than you.');
  }

  if (d.consent !== 'Yes') {
    throw makeValidationError('You must accept the Official Rules to enter a referral.');
  }

  raffleReferralLookupQuota_(raffleEmailKey_(entrant.email));

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw makeValidationError('We are busy for a moment — tap Submit again.');
  }
  var appended, token;
  try {
    // Re-checked inside the lock: two people referring the same person at the
    // same moment is exactly the race this exists for.
    var eligibility = raffleReferralEligibility_(refEmail, refPhone, test);
    if (!eligibility.ok) {
      return jsonOut({ ok: false, error: raffleReferralRefusal_(), refused: 'referral' });
    }
    token = Utilities.getUuid();
    appended = raffleAppendReferralEntry_({
      entrant: entrant,
      refName: refName, refEmail: refEmail, refPhone: refPhone,
      role: role, timeframe: timeframe, token: token,
      unchecked: !!eligibility.unchecked
    }, test);
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }

  // NOTHING IS WRITTEN TO FUB HERE. Per Durand, 2026-09-17: a referral becomes a
  // FUB contact when they CONSENT, not when somebody types their name into a form
  // at a street party.
  //
  // The old behaviour created the contact immediately, marked "no consent given",
  // and relied on a note to stop anyone working it. That meant the CRM filled up
  // with people who had never heard of us and might never reply -- and it made the
  // form a way for a stranger to inject contacts into the database. Now the row in
  // the sheet is the only record until they answer.
  //
  // Nobody is lost either way: anyone still unconfirmed at draw time is swept into
  // FUB, flagged, by raffleLogUnconfirmedReferrals_.

  return jsonOut({
    ok: true,
    staged: true,
    row: appended.row,
    token: token,
    referralName: refName,
    referralEmail: refEmail,
    message: 'Almost. Send ' + refName.split(' ')[0] + ' the confirmation email — ' +
             'you get ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
             ' more entries as soon as they confirm.'
  });
}

// Writes the pending row. Every entrant-supplied cell goes through
// raffleSafeCell_ for the same reason the original entry path does.
function raffleAppendReferralEntry_(x, test) {
  var sh = raffleSheet_(test);
  var e = x.entrant;
  var row = [];
  row[RAFFLE_COL['Timestamp (ET)']]   = raffleFmt_(raffleNow_());
  row[RAFFLE_COL['Full Name']]        = raffleSafeCell_(e.name);
  row[RAFFLE_COL['Email']]            = raffleSafeCell_(e.email);
  row[RAFFLE_COL['Phone']]            = raffleSafeCell_(e.phone);
  row[RAFFLE_COL['Consent']]          = 'Yes';
  row[RAFFLE_COL['Consent Version']]  = RAFFLE_CONSENT_VERSION;
  row[RAFFLE_COL['Entry Source']]     = test ? (QA_TEST_PREFIX + RAFFLE_EVENT_NAME) : RAFFLE_EVENT_NAME;
  // The entrant's FUB id comes off the verified session, where raffleVerifyCode_
  // put it. It has to be written onto the ROW here: the row is what the consent
  // step reads later, and without it there is nothing to link the referral to.
  // (Caught by test_raffle.js when the FUB write moved to consent time.)
  row[RAFFLE_COL['FUB Status']]       = e.personId ? 'entrant ok; referral pending consent'
                                                   : 'entrant push failed; referral pending consent';
  row[RAFFLE_COL['FUB Person ID']]    = e.personId || '';
  row[RAFFLE_COL['Eligible']]         = 'Yes';
  row[RAFFLE_COL['Email Verified']]   = 'Yes (code confirmed)';
  row[RAFFLE_COL['Entry Status']]     = RAFFLE_STATUS_PENDING;
  row[RAFFLE_COL['Referral Name']]    = raffleSafeCell_(x.refName);
  row[RAFFLE_COL['Referral Email']]   = raffleSafeCell_(x.refEmail);
  row[RAFFLE_COL['Referral Phone']]   = raffleSafeCell_(x.refPhone);
  row[RAFFLE_COL['Referral Role']]    = x.role;
  row[RAFFLE_COL['Referral Timeframe']] = raffleSafeCell_(x.timeframe);
  row[RAFFLE_COL['Referral FUB ID']]  = '';
  row[RAFFLE_COL['Referral Consent At']] = x.unchecked ? '(FUB not checked at entry)' : '';
  row[RAFFLE_COL['Referral Emailed At']] = '';
  row[RAFFLE_COL['Consent Token']]    = x.token;
  for (var i = 0; i < RAFFLE_SHEET_HEADERS.length; i++) {
    if (row[i] === undefined) row[i] = '';
  }
  sh.appendRow(row);
  return { row: sh.getLastRow() };
}

function raffleRecordReferralFub_(row, fub, test) {
  var sh = raffleSheet_(test);
  sh.getRange(row, RAFFLE_COL['FUB Status'] + 1)
    .setValue(fub.ok ? 'ok' : ('failed: ' + String(fub.error || '').slice(0, 200)));
  if (fub.entrantId)  sh.getRange(row, RAFFLE_COL['FUB Person ID'] + 1).setValue(fub.entrantId);
  if (fub.referralId) sh.getRange(row, RAFFLE_COL['Referral FUB ID'] + 1).setValue(fub.referralId);
}

// ---------- FUB writes ----------
// Creates/updates the entrant, creates the referral, links them both ways, sets
// the custom fields that this account actually has, and notes both records.
function raffleReferralToFub_(x, test) {
  var apiKey = raffleFubKey_();
  if (!apiKey) return { ok: false, error: 'FUB_API_KEY script property is not set.' };

  try {
    // -- the entrant. They were already resolved against FUB when they verified
    //    their email (raffleVerifyCode_), and the resulting person id is on the
    //    verified session. REUSE IT. Calling rafflePushToFub_ again here created
    //    a SECOND contact for the same person on every referral -- the confident
    //    match only fires on email/phone the CRM already has, and the record it
    //    had just created was not yet visible to the search. Caught by
    //    test_raffle.js's FUB-payload count, 2026-09-17.
    var entrantId = x.entrant.personId || '';
    if (!entrantId) {
      // The verify-time push failed. One retry here, so a referral is not
      // orphaned just because FUB was briefly down a minute ago.
      var retry = rafflePushToFub_(x.entrant.name, x.entrant.email, x.entrant.phone, test);
      entrantId = (retry && retry.personId) || '';
    }

    // -- the referral. Checked as new before we got here, so this is a create.
    var parts = splitName(x.refName);
    var tags = RAFFLE_REFERRAL_TAGS.concat([x.role]);
    var createPayload = {
      firstName: parts.first,
      lastName: parts.last,
      source: RAFFLE_SOURCE + ' (referral)',
      tags: tags,
      emails: [{ value: x.refEmail, type: 'home' }],
      phones: x.refPhone ? [{ value: x.refPhone, type: 'mobile' }] : [],
      background: raffleReferralBackground_(x)
    };
    var timeframeId = null;
    try { timeframeId = resolveTimeframeId(x.timeframe); } catch (tfErr) { timeframeId = null; }
    if (timeframeId !== null && timeframeId !== undefined) createPayload.timeframeId = timeframeId;

    // "Referred By" on the referral's own record, if this account has the field.
    var referredByKey = raffleCustomFieldKey_(RAFFLE_REFERRED_BY_LABELS);
    if (referredByKey) createPayload[referredByKey] = x.entrant.name;
    else raffleReportMissingField_('Referred By', RAFFLE_REFERRED_BY_LABELS);

    applyQaTestPersonMarking_(createPayload);

    var created = raffleFubCall_('https://api.followupboss.com/v1/people', 'post',
                                 createPayload, apiKey);
    if (!created.ok && referredByKey) {
      // Same defensive retry Code.gs uses for guessed-at custom fields: if the
      // create was rejected, drop the custom field and try once more rather
      // than losing the contact over one optional attribute.
      Logger.log('raffleReferralToFub_: create failed ' + created.code +
                 '; retrying without ' + referredByKey);
      delete createPayload[referredByKey];
      created = raffleFubCall_('https://api.followupboss.com/v1/people', 'post',
                               createPayload, apiKey);
    }
    if (!created.ok) {
      return { ok: false, entrantId: entrantId,
               error: 'FUB referral create returned ' + created.code + ': ' +
                      String(created.text).slice(0, 300) };
    }
    var referralId = created.body && created.body.id;

    // -- link them, both directions, through FUB's own relationships feature.
    if (entrantId && referralId) {
      raffleLinkPeople_(entrantId, referralId, 'Referred', apiKey);
      raffleLinkPeople_(referralId, entrantId, 'Referred by', apiKey);
    }

    // -- the entrant's referral count, if the field exists.
    if (entrantId) raffleBumpReferralCount_(entrantId, apiKey);

    // -- notes on both records, so the relationship is legible without leaving
    //    the contact you happen to be looking at.
    if (referralId) {
      raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
        personId: referralId,
        subject: (test ? QA_TEST_PREFIX : '') + 'Referred at the TSG Block Party',
        body: raffleReferralNote_(x),
        isHtml: false
      }, apiKey);
    }
    if (entrantId) {
      raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
        personId: entrantId,
        subject: (test ? QA_TEST_PREFIX : '') + 'Referred ' + x.refName + ' at the Block Party',
        body: raffleEntrantNote_(x),
        isHtml: false
      }, apiKey);
    }

    return { ok: true, entrantId: entrantId, referralId: referralId };
  } catch (err) {
    Logger.log('raffleReferralToFub_ threw: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: String(err) };
  }
}

// 2026-09-17: EVERY link was failing, silently, and had been from the start:
//   400 {"errorMessage":"Invalid fields in the request body: relatedPersonId."}
// So the entrant/referral relationship the deck advertises as "linked both ways"
// has never once been written. It failed quietly because this logged and
// returned false and nobody read the log, and because the QA suite asserted
// nothing about FUB at all -- it reported 102 of 102 green over the top of it.
//
// The field name is NOT guessed here. FUB's own docs domain is unreachable from
// the build environment, so raffleInspectFubRelationships() asks the API which
// keys it accepts and prints the answer; RAFFLE_LINK_FIELD is set from that.
// Until it is confirmed, this function still tries, still logs, and now ALERTS
// once per execution so a silent failure cannot repeat.
var RAFFLE_LINK_FIELD = 'relatedPersonId';   // pending raffleInspectFubRelationships()
var raffleLinkAlerted_ = false;

function raffleLinkPeople_(personId, relatedId, type, apiKey) {
  var payload = { personId: personId, type: type };
  payload[RAFFLE_LINK_FIELD] = relatedId;
  var res = raffleFubCall_('https://api.followupboss.com/v1/peopleRelationships', 'post',
                           payload, apiKey);
  if (!res.ok) {
    Logger.log('raffleLinkPeople_: ' + personId + ' -> ' + relatedId + ' (' + type + ') ' +
      'returned ' + res.code + ': ' + String(res.text).slice(0, 200));
    // One alert per execution, not one per pair: a broken field name breaks
    // every link, and twelve identical emails would get filtered and ignored.
    if (!raffleLinkAlerted_) {
      raffleLinkAlerted_ = true;
      try {
        sendErrorAlert('Raffle: FUB relationship linking is FAILING',
          'Every entrant/referral link is being rejected by FUB, so the "Referred" ' +
          'and "Referred by" relationships are NOT being written. The contacts and ' +
          'the notes are fine; only the relationship is missing, and the sheet has ' +
          'who referred whom either way.\n\n' +
          'FUB said (' + res.code + '): ' + String(res.text).slice(0, 300) + '\n\n' +
          'Field being sent: "' + RAFFLE_LINK_FIELD + '". Run ' +
          'raffleInspectFubRelationships() from the editor to have FUB name the ' +
          'field it actually wants, then set RAFFLE_LINK_FIELD to it.');
      } catch (alertErr) { Logger.log('link alert failed: ' + alertErr); }
    }
  }
  return res.ok;
}

// ---------------------------------------------------------------------------
// DIAGNOSTIC, editor-only. Asks FUB what it accepts instead of guessing.
//
// Run it from the editor and read the log. It does three things:
//   1. GETs existing relationships and prints the KEYS FUB returns, which is the
//      authoritative naming;
//   2. reads the relationship types the account has;
//   3. if two QA contacts are supplied, tries each candidate field name against
//      them and reports which one FUB accepts.
// Pass two ids from a "[QA TEST]" pair to get step 3 -- never a real pair.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DELETING THE QA CONTACTS THE SUITE CREATES
//
// The rehearsal makes REAL FUB people. Leaving them behind is not untidy, it is
// self-sabotage: the referral check matches on email OR phone, so yesterday's QA
// referrals make today's run refuse its own with "we already know that person".
// That is what turned the 15:14 run on 2026-09-17 into 23 failures.
//
// DOUBLE-GATED, because this deletes real records through the API. A contact is
// only removed if BOTH hold: it carries the QA tag, and its name starts with the
// QA prefix. Anything else is skipped and counted, never deleted -- so pointing
// this at a real person's id does nothing.
function raffleDeleteFubContactsById_(ids) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
  var deleted = 0, failed = 0, skipped = 0;
  var seen = {};
  (ids || []).forEach(function (id) {
    if (!id || seen[id]) return;
    seen[id] = true;
    try {
      var who = raffleFubCall_('https://api.followupboss.com/v1/people/' + id,
                               'get', null, apiKey);
      if (!who.ok || !who.body) { skipped++; return; }
      var tags = who.body.tags || [];
      var name = String(who.body.firstName || '') + ' ' + String(who.body.lastName || '');
      var tagged = tags.some(function (t) { return String(t) === QA_TEST_TAG; });
      var prefixed = name.indexOf(QA_TEST_PREFIX.trim()) !== -1;
      if (!tagged || !prefixed) {
        Logger.log('raffleDeleteFubContactsById_: REFUSING to delete ' + id +
                   ' (tagged=' + tagged + ', prefixed=' + prefixed + ') — ' + name);
        skipped++;
        return;
      }
      var del = raffleFubCall_('https://api.followupboss.com/v1/people/' + id,
                               'delete', null, apiKey);
      if (del.ok) { deleted++; }
      else {
        failed++;
        Logger.log('raffleDeleteFubContactsById_: DELETE ' + id + ' -> ' + del.code +
                   ': ' + String(del.text).slice(0, 160));
      }
    } catch (err) {
      failed++;
      Logger.log('raffleDeleteFubContactsById_ threw for ' + id + ': ' + err);
    }
  });
  var summary = deleted + ' deleted, ' + failed + ' failed, ' + skipped + ' skipped';
  Logger.log('raffleDeleteFubContactsById_: ' + summary);
  return { deleted: deleted, failed: failed, skipped: skipped, summary: summary };
}

// The backlog: every QA contact left behind by a run that predates the cleanup
// above. Editor-only. Same double gate, so it can only ever remove QA records.
// Scans newest-first and stops after `maxScan` contacts (default 500).
function raffleDeleteQaContactsFromFub(maxScan) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
  var cap = maxScan || 500, offset = 0, ids = [], scanned = 0;
  while (scanned < cap) {
    var page = raffleFubCall_('https://api.followupboss.com/v1/people?limit=100&offset=' +
                              offset + '&sort=-created', 'get', null, apiKey);
    if (!page.ok || !page.body) {
      Logger.log('raffleDeleteQaContactsFromFub: list failed ' + page.code + ': ' +
                 String(page.text).slice(0, 200));
      break;
    }
    var people = page.body.people || [];
    if (!people.length) break;
    people.forEach(function (p) {
      scanned++;
      var tags = p.tags || [];
      if (tags.some(function (t) { return String(t) === QA_TEST_TAG; })) ids.push(p.id);
    });
    if (people.length < 100) break;
    offset += 100;
  }
  Logger.log('raffleDeleteQaContactsFromFub: scanned ' + scanned + ', found ' +
             ids.length + ' QA-tagged.');
  var res = raffleDeleteFubContactsById_(ids);
  return 'Scanned ' + scanned + ' contacts, found ' + ids.length +
         ' tagged "' + QA_TEST_TAG + '": ' + res.summary;
}

// ---------------------------------------------------------------------------
// LOGGING OUTBOUND EMAIL TO THE CONTACT'S FUB TIMELINE
//
// Durand, 2026-09-17: "all emails should be sent through fub so they're logged
// to the contact's comms."
//
// WHY THIS LOGS RATHER THAN SENDS. Routing delivery through FUB would make FUB
// the mail transport for the verification code -- the one email on the critical
// path of entering at all. The API key was returning 401 for every call earlier
// this same afternoon; had delivery depended on it, nobody could have entered
// for as long as that lasted, and the form would have sat saying "check your
// email" to every guest at the table. MailApp is the account's own mail and has
// no such coupling, so it keeps the delivery and FUB gets the record.
//
// Best-effort and silent on failure, always: a timeline entry is bookkeeping,
// and it must never be the reason an email fails to go or an entry fails to
// record. Called AFTER the send, never before.
//
// The note is the mechanism because notes demonstrably work on this account.
// If FUB turns out to expose a real email-activity endpoint,
// raffleInspectFubEmailLogging() will say so and this is the single place to
// point at it.
function raffleLogEmailToFub_(personId, subject, bodyText, test) {
  if (!personId) return false;
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
    if (!apiKey) return false;
    var body = String(bodyText || '').replace(/\r/g, '');
    if (body.length > 4000) body = body.slice(0, 4000) + '\n[truncated]';
    var res = raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
      personId: personId,
      subject: (test ? QA_TEST_PREFIX : '') + 'Email sent: ' + subject,
      body: 'This is the email the raffle sent to this contact, logged here so the\n' +
            'timeline shows what they were told.\n\n' +
            '----------------------------------------\n' + body,
      isHtml: false
    }, apiKey);
    if (!res.ok) {
      Logger.log('raffleLogEmailToFub_: ' + res.code + ': ' + String(res.text).slice(0, 160));
    }
    return res.ok;
  } catch (err) {
    Logger.log('raffleLogEmailToFub_ threw (non-fatal): ' + err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// DIAGNOSTIC, editor-only: does FUB expose a way to LOG or SEND an email?
//
// Durand, 2026-09-17: "all emails should be sent through fub so they're logged
// to the contact's comms". Two different things are possible and only FUB can
// say which:
//   * LOGGING an email we sent ourselves, so it appears on the contact timeline;
//   * SENDING through FUB, so FUB is the mail transport.
// FUB's docs domain is blocked from the build environment, so this asks the API
// which endpoints answer at all rather than guessing a payload. Read the log.
// ---------------------------------------------------------------------------
function raffleInspectFubEmailLogging() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
  var out = [];
  function say(line) { out.push(line); Logger.log(line); }
  say('Probing FUB for an email endpoint. 200/201 = exists, 404 = does not, ' +
      '405 = exists but not for this verb.');
  ['emails', 'textMessages', 'calls', 'events', 'notes'].forEach(function (path) {
    var r = raffleFubCall_('https://api.followupboss.com/v1/' + path + '?limit=1',
                           'get', null, apiKey);
    var keys = '';
    if (r.ok && r.body) {
      var arrKey = Object.keys(r.body).filter(function (k) {
        return Object.prototype.toString.call(r.body[k]) === '[object Array]'; })[0];
      var arr = arrKey ? r.body[arrKey] : [];
      keys = arr.length ? '  record keys: ' + Object.keys(arr[0]).join(', ')
                        : '  (no records to read keys from)';
    }
    say('GET /v1/' + path + ' -> ' + r.code + (keys ? '\n' + keys : ''));
  });
  say('');
  say('If /v1/emails exists, its record keys name the fields an email log needs ' +
      'and raffleLogEmailToFub_ can be pointed at it. If it does not, the note ' +
      'fallback already in place is the whole of what is available.');
  return out.join('\n');
}

function raffleInspectFubRelationships(qaPersonId, qaRelatedId) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
  var out = [];
  function say(line) { out.push(line); Logger.log(line); }

  var list = raffleFubCall_(
    'https://api.followupboss.com/v1/peopleRelationships?limit=3', 'get', null, apiKey);
  say('GET /peopleRelationships -> ' + list.code);
  if (list.ok && list.body) {
    say('  top-level keys: ' + Object.keys(list.body).join(', '));
    var arr = list.body.peoplerelationships || list.body.peopleRelationships ||
              list.body.relationships || [];
    if (arr.length) {
      say('  A RECORD\'S KEYS (this is the answer): ' + Object.keys(arr[0]).join(', '));
      say('  sample: ' + JSON.stringify(arr[0]).slice(0, 400));
    } else {
      say('  no relationships exist yet, so no record to read keys from.');
    }
  } else {
    say('  body: ' + String(list.text).slice(0, 300));
  }

  if (qaPersonId && qaRelatedId) {
    ['relatedPersonId', 'relatedId', 'toPersonId', 'personIdTo', 'relatedPerson']
      .forEach(function (field) {
        var payload = { personId: qaPersonId, type: 'Referred' };
        payload[field] = qaRelatedId;
        var t = raffleFubCall_('https://api.followupboss.com/v1/peopleRelationships',
                               'post', payload, apiKey);
        say('  POST with "' + field + '" -> ' + t.code + ' ' +
            (t.ok ? 'ACCEPTED — set RAFFLE_LINK_FIELD to this'
                  : String(t.text).slice(0, 140)));
      });
  } else {
    say('Pass two [QA TEST] contact ids to probe field names: ' +
        'raffleInspectFubRelationships(33228, 33241)');
  }
  return out.join('\n');
}

// Reads the current value and writes value+1. Skipped entirely, with one log
// line, if this account has no such field -- never created on the fly.
function raffleBumpReferralCount_(personId, apiKey) {
  var key = raffleCustomFieldKey_(RAFFLE_REFERRAL_COUNT_LABELS);
  if (!key) { raffleReportMissingField_('Referral Count', RAFFLE_REFERRAL_COUNT_LABELS); return; }
  var person = raffleFubCall_('https://api.followupboss.com/v1/people/' + personId, 'get', null, apiKey);
  var current = 0;
  if (person.ok && person.body && person.body[key] !== undefined && person.body[key] !== null) {
    var parsed = parseInt(String(person.body[key]).replace(/\D/g, ''), 10);
    if (!isNaN(parsed)) current = parsed;
  }
  var payload = {};
  payload[key] = current + 1;
  var res = raffleFubCall_('https://api.followupboss.com/v1/people/' + personId, 'put', payload, apiKey);
  if (!res.ok) {
    Logger.log('raffleBumpReferralCount_: PUT returned ' + res.code + ': ' +
      String(res.text).slice(0, 200));
  }
}

// One alert per field per 6 hours, so a missing custom field is reported once
// rather than on every single entry all afternoon.
function raffleReportMissingField_(label, labels) {
  var cache = CacheService.getScriptCache();
  var key = 'raffle_missing_field_' + label.toLowerCase().replace(/\W+/g, '_');
  if (cache.get(key)) return;
  cache.put(key, '1', 21600);
  Logger.log('Raffle: no FUB custom field matching ' + JSON.stringify(labels) +
    ' — "' + label + '" is being skipped.');
  try {
    sendErrorAlert('Raffle: FUB custom field "' + label + '" does not exist',
      'The raffle wanted to write the "' + label + '" custom field on a FUB contact, but ' +
      'this account has no custom field whose label matches any of:\n  ' +
      labels.join('\n  ') + '\n\nEverything else about the entry was saved — only this one ' +
      'field was skipped, and the same information is in the contact\'s note either way.\n\n' +
      'To turn it on: create the custom field in FUB (Admin > Custom Fields), then it will ' +
      'be picked up within 30 minutes with no code change.');
  } catch (alertErr) { /* never let the alert swallow the write */ }
}

// ---------- Note bodies (plain text; FUB notes are posted isHtml:false) ----------
function raffleReferralBackground_(x) {
  return [
    'Referred by ' + x.entrant.name + ' at the ' + RAFFLE_EVENT_NAME +
      ' on Saturday, September 19, 2026 (1342 N Hancock St, Philadelphia).',
    '',
    'Looking to: ' + x.role,
    'Timeframe:  ' + (x.timeframe || '(not given)'),
    '',
    'CONSENT: NOT YET GIVEN at the time this record was created. This person was',
    'named by someone else and has not yet confirmed anything themselves. They are',
    'being emailed a link to confirm their details and give consent; until they do,',
    'do NOT add them to any automated sequence.',
    '',
    'Referrer: ' + x.entrant.name + ' / ' + x.entrant.email + ' / ' + x.entrant.phone
  ].join('\n');
}

function raffleReferralNote_(x) {
  return [
    'Referred by ' + x.entrant.name + ' at the TSG Block Party, Sat 9/19/2026.',
    '',
    'Looking to: ' + x.role,
    'Timeframe:  ' + (x.timeframe || '(not given)'),
    '',
    'The referrer is entered in the ' + RAFFLE_PRIZE_SHORT + ' drawing and earns ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' bonus entries once this person confirms',
    'their details and consents, so a confirmation email has been sent here.',
    '',
    'UNTIL THAT CONFIRMATION ARRIVES this contact has given no consent of their own.',
    'Reach out personally; do not drip.',
    '',
    'Referrer: ' + x.entrant.name + ' / ' + x.entrant.email + ' / ' + x.entrant.phone
  ].join('\n');
}

function raffleEntrantNote_(x) {
  return [
    'Entered the ' + RAFFLE_EVENT_NAME + ' drawing (' + RAFFLE_PRIZE_SHORT + ') by',
    'referring someone at the party.',
    '',
    'Referred: ' + x.refName,
    '  Email:     ' + x.refEmail,
    '  Phone:     ' + (x.refPhone || '(not given)'),
    '  Looking to: ' + x.role,
    '  Timeframe:  ' + (x.timeframe || '(not given)'),
    '',
    'ATTENDED the TSG Block Party on Saturday, September 19, 2026.',
    'Email address verified at entry (a code was emailed and typed back).',
    '',
    'CONSENT: accepted the Official Rules and gave express written consent to be',
    'contacted by call, text and email about real estate services.',
    'Consent language version: ' + RAFFLE_CONSENT_VERSION + '.'
  ].join('\n');
}

// ---------- Step 5: the invite email ----------
// Durand, 2026-09-17: "put both the entrant and referral on the email."
// So: TO the referral, CC the entrant and info@. The entrant sees exactly what
// was sent in their name, which is the honest thing to do when a message goes
// out on someone's behalf, and it doubles as their receipt.
//
// WHAT THIS IS NOT: it is not sent FROM the entrant. Apps Script's MailApp
// always sends as the account executing the script (info@), and no flag changes
// that. The closest honest version is what is built here -- it comes from TSG,
// says in the first line who referred them, and sets replyTo to the entrant so
// a reply goes to the person they actually know. A mailto: link would genuinely
// originate from the entrant's phone, but it cannot carry HTML, cannot force the
// CC, and we would never know whether they pressed send.
function raffleSendReferralInvite_(d, test) {
  var vid = String(d.vid || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(vid)) {
    throw makeValidationError('That session expired. Start again.');
  }
  var raw = CacheService.getScriptCache().get(RAFFLE_VERIFIED_PREFIX + vid);
  if (!raw) throw makeValidationError('That session expired. Start again.');
  var entrant = JSON.parse(raw);

  var token = String(d.token || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(token)) {
    throw makeValidationError('We lost track of that referral. Start again.');
  }
  var found = raffleFindRowByToken_(token);
  if (!found) throw makeValidationError('We lost track of that referral. Start again.');

  // The token alone must not be enough to make us send mail: it also has to be
  // THIS entrant's referral. Otherwise a token leaked from a URL would let
  // anyone re-trigger the email at the referred person.
  if (raffleEmailKey_(found.entry.email) !== raffleEmailKey_(entrant.email)) {
    throw makeValidationError('That referral belongs to a different entry.');
  }

  // One send per referral, plus the shared per-address cap. Re-pressing the
  // button must not become a way to mail a stranger repeatedly.
  if (found.entry.emailedAt) {
    return jsonOut({ ok: true, alreadySent: true,
      message: 'Already sent to ' + found.entry.referralEmail + '. ' +
               'Ask them to check spam if it has not turned up.' });
  }
  raffleCheckCodeSendQuota_(raffleEmailKey_(found.entry.referralEmail));

  var url = raffleConsentUrl_(token);
  // Lead with what THEY get. "X referred you" is the referrer's news; a referral
  // who has no reason of their own to open this is a referral who does not, and
  // an unconfirmed referral is worth nothing to anybody.
  var subject = (test ? QA_TEST_PREFIX : '') + entrant.name +
    ' referred you — confirm and you are in the $300 drawing too';

  // TWO MESSAGES, NOT ONE CC'd MESSAGE.
  //
  // Durand asked for "both the entrant and referral on the email", and this
  // still does that -- they both get one. What it no longer does is hand the
  // entrant the CONSENT TOKEN.
  //
  // The consent link is a bearer credential: whoever holds it can tick the
  // consent box as that person. Cc'ing the entrant put it in the inbox of the
  // one person with a motive to use it, and when a confirmed referral became
  // worth RAFFLE_BONUS_TICKETS_PER_REFERRAL that motive went up sixfold. Worse
  // than the tickets: a self-confirmed referral leaves a FUB record reading
  // "CONSENT GIVEN BY THIS PERSON" for somebody who never saw the page, which
  // is the one claim this whole design exists to be able to make honestly.
  //
  // So the link goes only to the address it belongs to, and the entrant gets a
  // receipt showing exactly what was sent in their name, minus the credential.
  MailApp.sendEmail({
    to: found.entry.referralEmail,
    replyTo: raffleReplyTo_(entrant.email),
    bcc: raffleOversightBcc_(test),
    name: 'The Stawasz Group',
    subject: subject,
    htmlBody: raffleInviteHtml_(entrant, found.entry, url, test),
    body: raffleInvitePlain_(entrant, found.entry, url)   // for text-only clients
  });

  raffleSheet_(found.test).getRange(found.row, RAFFLE_COL['Referral Emailed At'] + 1)
    .setValue(raffleFmt_(raffleNow_()));

  // The referral has no FUB contact yet -- referrals only reach FUB on consent --
  // so this lands on the ENTRANT's timeline, which is whose behalf it went out on.
  raffleLogEmailToFub_(entrant.personId, subject,
    raffleInvitePlain_(entrant, found.entry, url), test);

  // Best-effort, and deliberately after the row is marked: the invite is the
  // thing that had to happen, and a failed receipt must not make the entrant
  // press the button again and re-mail their friend.
  try {
    MailApp.sendEmail({
      to: entrant.email,
      cc: RAFFLE_SHARED_INBOX,
      replyTo: RAFFLE_SHARED_INBOX,
      bcc: raffleOversightBcc_(test),
      name: 'The Stawasz Group',
      subject: (test ? QA_TEST_PREFIX : '') + 'Sent to ' +
               String(found.entry.referralName || '').split(' ')[0] +
               ' — here is exactly what went out',
      htmlBody: raffleInviteReceiptHtml_(entrant, found.entry, test),
      body: raffleInviteReceiptPlain_(entrant, found.entry)
    });
    raffleLogEmailToFub_(entrant.personId, 'Your copy of the referral invitation',
      raffleInviteReceiptPlain_(entrant, found.entry), test);
  } catch (receiptErr) {
    Logger.log('Invite receipt to the entrant failed (non-fatal): ' + receiptErr);
  }

  return jsonOut({ ok: true, sent: true,
    message: 'Sent to ' + found.entry.referralEmail + '. We have emailed you a copy of it. ' +
             'You get ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
             ' more entries as soon as they confirm.' });
}

// The entrant's copy. Every detail the invite carried EXCEPT the consent link,
// and it says why the link is missing -- an email that looks like it lost its
// button reads as broken, and the honest explanation is also the reassuring one.
function raffleInviteReceiptHtml_(entrant, entry, test) {
  var e = raffleEsc_;
  var refFirst = String(entry.referralName || '').split(' ')[0];
  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px;',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;",
    'color:#1d2b2c;line-height:1.55;">',
    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:16px;">QA TEST — not a real referral</div>' : '',
    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;padding:26px 24px;">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.8;">THE STAWASZ GROUP</div>',
    '<div style="font-size:22px;font-weight:700;margin-top:6px;">',
    'Sent to ' + e(refFirst) + '</div>',
    '</div>',
    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;">',
    '<p style="margin:0 0 14px;">Thanks ' + e(String(entrant.name).split(' ')[0]) + ' — ',
    'this is what we sent, word for word, so you know exactly what went out in your name.</p>',
    '<div style="background:#f4f6f6;border-radius:8px;padding:16px;margin:0 0 20px;font-size:15px;">',
    '<div><strong>To</strong><br>' + e(entry.referralEmail) + '</div>',
    '<div style="margin-top:10px;"><strong>Name</strong><br>' + e(entry.referralName) + '</div>',
    entry.referralPhone ? '<div style="margin-top:10px;"><strong>Phone</strong><br>' +
      e(entry.referralPhone) + '</div>' : '',
    '<div style="margin-top:10px;"><strong>Looking to</strong><br>' + e(entry.referralRole) + '</div>',
    entry.timeframe ? '<div style="margin-top:10px;"><strong>Timeframe</strong><br>' +
      e(entry.timeframe) + '</div>' : '',
    '</div>',
    '<p style="margin:0 0 14px;">We asked them to confirm those details and give us ',
    'permission to get in touch. <b>When they confirm, you get ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more entries</b> and we will email you.</p>',
    '<div style="background:#f0f4f4;border-radius:8px;padding:16px 18px;margin:0 0 18px;">',
    '<p style="margin:0;font-size:14px;color:#55696a;">The confirmation link went only to ',
    e(refFirst) + '&rsquo;s own inbox, not to this copy. That is on purpose: it is how we ',
    'can say honestly that they confirmed for themselves. If they cannot find it, a nudge ',
    'from you is worth more than anything we can send &mdash; and we will send one reminder ',
    'at 5:00 PM Saturday.</p></div>',
    '<p style="margin:0;font-size:14px;color:#55696a;">Want to refer somebody else? Scan the ',
    'sign again, or reply to this email and we will take it down for you.</p>',
    '</div>',
    '<div style="text-align:center;padding:18px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower<br>',
    '728 S Broad St, Philadelphia, PA 19146 &middot; (215) 760-6291 &middot; info@tsg.homes',
    '</div></div></div>'
  ].join('');
}

function raffleInviteReceiptPlain_(entrant, entry) {
  var refFirst = String(entry.referralName || '').split(' ')[0];
  return [
    'Thanks ' + String(entrant.name).split(' ')[0] + ' - this is what we sent, word for',
    'word, so you know exactly what went out in your name.',
    '',
    'To:         ' + entry.referralEmail,
    'Name:       ' + entry.referralName,
    'Phone:      ' + (entry.referralPhone || '(not given)'),
    'Looking to: ' + entry.referralRole,
    'Timeframe:  ' + (entry.timeframe || '(not given)'),
    '',
    'We asked them to confirm those details and give us permission to get in touch.',
    'When they confirm you get ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
      ' more entries, and we will email you.',
    '',
    'The confirmation link went only to ' + refFirst + "'s own inbox, not to this copy.",
    'That is on purpose: it is how we can say honestly that they confirmed for',
    'themselves. If they cannot find it, a nudge from you is worth more than anything',
    'we can send - and we will send one reminder at 5:00 PM Saturday.',
    '',
    'The Stawasz Group - Keller Williams Empower',
    '728 S Broad St, Philadelphia, PA 19146 - (215) 760-6291 - info@tsg.homes'
  ].join('\n');
}

// Finds the row carrying a consent token, across BOTH tabs. The token is the
// only thing the referred person has, so it has to resolve without them knowing
// or caring whether they are part of a rehearsal.
function raffleFindRowByToken_(token) {
  var tabs = [false, true];
  for (var t = 0; t < tabs.length; t++) {
    var rows;
    try { rows = raffleReadEntries_(tabs[t]); } catch (err) { continue; }
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].consentToken && rows[i].consentToken === token) {
        var sh = raffleSheet_(tabs[t]);
        var vals = sh.getRange(rows[i].row, 1, 1, RAFFLE_SHEET_HEADERS.length).getValues()[0];
        rows[i].emailedAt = String(vals[RAFFLE_COL['Referral Emailed At']] || '');
        rows[i].timeframe = String(vals[RAFFLE_COL['Referral Timeframe']] || '');
        return { entry: rows[i], row: rows[i].row, test: tabs[t] };
      }
    }
  }
  return null;
}

function raffleConsentUrl_(token) {
  return ScriptApp.getService().getUrl() +
    '?form=raffle&action=' + RAFFLE_CONSENT_ACTION + '&t=' + encodeURIComponent(token);
}

// ---------- The invite email body ----------
// Inline styles only, table-free where possible, and a plain-text alternative
// alongside: Gmail strips <style> blocks and Outlook ignores half of flexbox, so
// anything clever here degrades into an unreadable mess on someone's phone.
// Every entrant-supplied value is escaped -- this is an HTML sink like any other.
function raffleInviteHtml_(entrant, entry, url, test) {
  var e = raffleEsc_;
  var refFirst = String(entry.referralName || '').split(' ')[0];
  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px;',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;',
    'color:#1d2b2c;line-height:1.55;">',
    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:16px;">QA TEST — not a real referral</div>' : '',
    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;padding:26px 24px;">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.8;">THE STAWASZ GROUP</div>',
    '<div style="font-size:22px;font-weight:700;margin-top:6px;">',
    e(entrant.name) + ' referred you to us</div>',
    '</div>',
    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;">',
    '<p style="margin:0 0 14px;">Hi ' + e(refFirst) + ',</p>',
    '<p style="margin:0 0 14px;"><strong>' + e(entrant.name) + '</strong> mentioned you ',
    'at our Block Party and thought we might be able to help you ',
    e(raffleRoleVerb_(entry.referralRole)) + ' in the next year.</p>',
    '<p style="margin:0 0 18px;">Here is what they gave us. If it is right, confirm below. ',
    'If something is wrong, you can fix it on the same page.</p>',
    '<div style="background:#FFF8E6;border:1px solid #F0DFAE;border-radius:8px;',
    'padding:16px 18px;margin:0 0 20px;font-size:15px;color:#6B5720;line-height:1.5;">',
    '<b>Confirming enters you in the drawing too.</b> $300 toward any Ticketmaster ',
    'purchase, drawn 6:15 PM Saturday. One entry for you, and ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' extra for ' +
      e(String(entrant.name).split(' ')[0]) + '. No purchase necessary, and you do not ',
    'need to be at the party to win.</div>',
    '<div style="background:#f4f6f6;border-radius:8px;padding:16px;margin:0 0 20px;font-size:15px;">',
    '<div><strong>Name</strong><br>' + e(entry.referralName) + '</div>',
    '<div style="margin-top:10px;"><strong>Email</strong><br>' + e(entry.referralEmail) + '</div>',
    entry.referralPhone ? '<div style="margin-top:10px;"><strong>Phone</strong><br>' +
      e(entry.referralPhone) + '</div>' : '',
    '<div style="margin-top:10px;"><strong>Looking to</strong><br>' + e(entry.referralRole) + '</div>',
    entry.timeframe ? '<div style="margin-top:10px;"><strong>Timeframe</strong><br>' +
      e(entry.timeframe) + '</div>' : '',
    '</div>',
    '<div style="text-align:center;margin:0 0 20px;">',
    '<a href="' + e(url) + '" style="display:inline-block;background:#15464A;color:#fff;',
    'text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px;">',
    'Confirm my details</a></div>',
    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">',
    'Confirming also gives us your permission to get in touch. Nothing happens until you do — ',
    'and if you would rather we did not, simply ignore this email and we will not contact you.</p>',
    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">',
    e(String(entrant.name).split(' ')[0]) + ' is copied on this, which is why: ',
    'confirming is worth ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' extra entries to them ',
    'as well as one to you. No pressure either way.</p>',
    '<p style="margin:0 0 4px;font-size:14px;color:#55696a;">If the button does not work, ',
    'paste this into your browser:<br><span style="word-break:break-all;">' + e(url) + '</span></p>',
    '</div>',
    '<div style="text-align:center;padding:18px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower<br>',
    '728 S Broad St, Philadelphia, PA 19146 &middot; (215) 760-6291 &middot; info@tsg.homes',
    '</div></div></div>'
  ].join('');
}

function raffleInvitePlain_(entrant, entry, url) {
  return [
    entrant.name + ' referred you to The Stawasz Group.',
    '',
    'They mentioned you at our Block Party and thought we might be able to help you ' +
      raffleRoleVerb_(entry.referralRole) + ' in the next year.',
    '',
    'Here is what they gave us:',
    '  Name:       ' + entry.referralName,
    '  Email:      ' + entry.referralEmail,
    '  Phone:      ' + (entry.referralPhone || '(not given)'),
    '  Looking to: ' + entry.referralRole,
    '  Timeframe:  ' + (entry.timeframe || '(not given)'),
    '',
    'Confirm (or correct) your details here:',
    url,
    '',
    'CONFIRMING ENTERS YOU IN THE DRAWING TOO: ' + RAFFLE_PRIZE_SHORT + ', drawn 6:15 PM',
    'Saturday. One entry for you, and ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' extra for ' +
      String(entrant.name).split(' ')[0] + '. No purchase necessary,',
    'and you do not need to be at the party to win.',
    '',
    'Confirming also gives us your permission to get in touch. Nothing happens until',
    'you do -- if you would rather we did not, just ignore this email.',
    '',
    'The Stawasz Group - Keller Williams Empower',
    '728 S Broad St, Philadelphia, PA 19146 - (215) 760-6291 - info@tsg.homes'
  ].join('\n');
}

// ---------- Step 6: the referred person confirms ----------
// Reached from the emailed link: ?form=raffle&action=consent&t=<token>
//
// The token is a bearer credential in a URL, which is the standard shape for an
// email confirmation link and carries the standard caveat: anyone holding the
// link can act as that person. It is a v4 UUID (122 bits), it is never shown to
// anyone but the recipient and the CC'd entrant, and the worst it can do is
// consent on behalf of someone who was already going to be asked. That is an
// accepted trade -- the alternative is asking a cold referral to create an
// account, which nobody would do.
function raffleConsentPage_(e) {
  var token = String((e && e.parameter && e.parameter.t) || '');
  var found = /^[0-9a-fA-F-]{36}$/.test(token) ? raffleFindRowByToken_(token) : null;

  if (!found) {
    return raffleConsentShell_('<h2 style="margin:0 0 10px">That link has expired</h2>' +
      '<p>We could not find that referral. If someone told you they referred you to ' +
      'The Stawasz Group, reply to their email or call us on (215) 760-6291 and we will ' +
      'sort it out.</p>', false);
  }

  var entry = found.entry;
  if (entry.status === RAFFLE_STATUS_ELIGIBLE) {
    return raffleConsentShell_('<h2 style="margin:0 0 10px">You are all set</h2>' +
      '<p>You already confirmed your details — there is nothing else to do. ' +
      'Someone from The Stawasz Group will be in touch.</p>', found.test);
  }
  if (entry.status === RAFFLE_STATUS_DECLINED) {
    return raffleConsentShell_('<h2 style="margin:0 0 10px">Already handled</h2>' +
      '<p>You told us not to get in touch, and we have not. Nothing further is needed.</p>',
      found.test);
  }

  var timeframes = raffleTimeframes_();
  var esc = raffleEsc_;
  var opts = timeframes.map(function (t) {
    var sel = String(t.name) === String(entry.timeframe) ? ' selected' : '';
    return '<option value="' + esc(t.name) + '"' + sel + '>' + esc(t.name) + '</option>';
  }).join('');

  // Whether confirming also ENTERS them is a question of the clock, and the page
  // must not promise an entry it cannot give: after 6:15 the consent page still
  // works (we want the contact record) but there is no drawing left to join.
  var stillOpen = !!found.test || raffleEntryState_() === 'open';
  var rulesUrl = '';
  try { rulesUrl = ScriptApp.getService().getUrl() + '?form=raffle'; } catch (urlErr) { rulesUrl = ''; }

  var body = [
    '<h2 style="margin:0 0 6px">' + esc(entry.name) + ' referred you to us</h2>',
    '<p style="color:#55696a;margin:0 0 20px">Check that this is right, fix anything that ',
    'is not, and confirm at the bottom. It takes about twenty seconds.</p>',
    stillOpen ? '<div style="background:#FFF8E6;border:1px solid #F0DFAE;border-radius:8px;' +
      'padding:14px 16px;margin:0 0 18px;font-size:14px;color:#6B5720;line-height:1.5;">' +
      '<b>Confirming enters you in the drawing too.</b> One entry for you, and ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' extra for ' +
      esc(String(entry.name).split(' ')[0]) + ' for introducing us. $300 toward any ' +
      'Ticketmaster purchase, drawn 6:15 PM Saturday. No purchase necessary.</div>' : '',
    '<form id="f" onsubmit="return false">',
    '<label>Full name<input id="rName" type="text" value="' + esc(entry.referralName) + '"></label>',
    // Shown, but not editable: see the note in raffleConsentSubmit_. `readonly`
    // rather than `disabled` so it still renders as their address rather than
    // greying out to look broken, and a line underneath says why, because a field
    // you cannot type in with no explanation reads as a bug.
    '<label>Email<input id="rEmail" type="email" value="' + esc(entry.referralEmail) + '" ',
    'readonly style="background:#f4f6f6; color:#55696a"></label>',
    '<p class="locknote">This is the address we emailed, so it cannot be changed here. ',
    'If it is wrong, reply to that email or call us on (215) 760-6291.</p>',
    '<label>Phone<input id="rPhone" type="tel" value="' + esc(entry.referralPhone) + '"></label>',
    '<label>Are you looking to buy or sell?</label>',
    '<div class="roles">',
    RAFFLE_ROLES.map(function (r) {
      var on = r === entry.referralRole ? ' checked' : '';
      return '<label class="radio"><input type="radio" name="role" value="' + esc(r) + '"' +
             on + '><span>' + esc(r) + '</span></label>';
    }).join(''),
    '</div>',
    '<label>When are you thinking of moving?<select id="rTimeframe">',
    '<option value="">Select…</option>' + opts,
    '</select></label>',
    // ONE box, covering both things, because confirming now does two things: it
    // gives consent AND it enters them. A box that only mentioned consent while
    // the server entered them in a prize drawing would be entering somebody who
    // never accepted the Official Rules.
    '<label class="check"><input type="checkbox" id="consent">',
    '<span>I confirm these details are mine, and I give The Stawasz Group ',
    '(Keller Williams Empower) permission to contact me by phone, text and email — ',
    'including autodialed or prerecorded calls and texts — about real estate services. ',
    'Consent is not a condition of any purchase. Message and data rates may apply. ',
    'I can opt out at any time by replying STOP or emailing info@tsg.homes.',
    stillOpen ? ' I am 18 or over and a legal U.S. resident, and I have read and agree to the ' +
      (rulesUrl ? '<a href="' + esc(rulesUrl) + '" target="_blank" ' +
                  'style="color:#15464A">Official Rules</a>' : 'Official Rules') +
      ' of the prize drawing.' : '',
    '</span></label>',
    '<div id="err" class="err"></div>',
    '<button id="go" class="primary">Confirm my details</button>',
    '<button id="no" class="ghost">No thanks — do not contact me</button>',
    '</form>'
  ].join('');

  var tmpl = HtmlService.createTemplateFromFile('RaffleConsent');
  tmpl.bodyHtml     = body;
  tmpl.token        = token;
  tmpl.submitToken  = getSubmitToken();
  tmpl.isTest       = found.test ? '1' : '';
  tmpl.entrantFirst = String(entry.name || '').split(' ')[0];
  tmpl.prizeShort   = RAFFLE_PRIZE_SHORT;
  return tmpl.evaluate()
    .setTitle((found.test ? QA_TEST_PREFIX : '') + 'Confirm your details | The Stawasz Group')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Terminal states (expired link, already done) render through the same chrome as
// the form itself so they do not look like an error page from a different site.
function raffleConsentShell_(inner, test) {
  var tmpl = HtmlService.createTemplateFromFile('RaffleConsent');
  tmpl.bodyHtml     = inner;
  tmpl.token        = '';
  tmpl.submitToken  = '';
  tmpl.isTest       = test ? '1' : '';
  tmpl.entrantFirst = '';
  tmpl.prizeShort   = RAFFLE_PRIZE_SHORT;
  return tmpl.evaluate()
    .setTitle('The Stawasz Group')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// The write that turns a staged row into an actual entry.
function raffleConsentSubmit_(d) {
  var token = String(d.token || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(token)) {
    throw makeValidationError('That link has expired. Ask the person who referred you to resend it.');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw makeValidationError('We are busy for a moment — tap Confirm again.');
  }
  try {
    var found = raffleFindRowByToken_(token);
    if (!found) {
      throw makeValidationError('That link has expired. Ask the person who referred you to resend it.');
    }
    var sh = raffleSheet_(found.test);
    var entry = found.entry;

    if (entry.status === RAFFLE_STATUS_ELIGIBLE || entry.status === RAFFLE_STATUS_DECLINED) {
      return jsonOut({ ok: true, already: true,
        message: 'You have already answered — nothing else to do.' });
    }

    // Declining is a first-class outcome, not a dead end: it is recorded so
    // nobody on the team calls them anyway.
    if (String(d.decision || '') === 'decline') {
      sh.getRange(found.row, RAFFLE_COL['Entry Status'] + 1).setValue(RAFFLE_STATUS_DECLINED);
      // NOT Eligible='No'. That column is Durand's manual disqualification switch,
      // and raffleReadEntries_ drops those rows entirely -- which would hide the
      // decline from the claim check and let the next person refer them all over
      // again. 'Entry Status' already keeps a declined row out of the draw.
      var declinedId = raffleMarkDeclinedInFub_(entry, found.test);
      if (declinedId && !entry.referralFubId) {
        sh.getRange(found.row, RAFFLE_COL['Referral FUB ID'] + 1).setValue(declinedId);
      }
      return jsonOut({ ok: true, declined: true,
        message: 'Understood — we will not contact you. Sorry for the interruption.' });
    }

    var name  = collapseSpaces(d.referralName);
    if (!name || name.indexOf(' ') === -1) {
      throw makeValidationError('Please give your first and last name.');
    }

    // THE EMAIL IS LOCKED. Per Durand, 2026-09-17.
    //
    // It is read from the ROW, never from this request, and the page renders it
    // read-only. The consent link is a bearer credential sitting in an inbox:
    // while the address was editable, whoever held the link could point it at a
    // third party and tick the consent box on their behalf, and the substituted
    // address was never re-verified. Flagging that afterwards (the previous
    // mitigation) told the team about it; locking the field means it cannot
    // happen. The cost is that a genuine typo in the address now has to be fixed
    // by a person -- which is the right trade, because an address typed by
    // somebody else is exactly the case we cannot tell apart from an attack.
    //
    // Everything else on the page stays editable: name, phone, buying or selling,
    // and timeframe are all things this person can correct about themselves.
    var email = entry.referralEmail;
    if (!email) {
      throw makeValidationError('We cannot find the email address for this referral. ' +
        'Please call us on (215) 760-6291 and we will sort it out.');
    }
    var phone  = collapseSpaces(d.referralPhone);
    var digits = raffleRejectJunkPhone_(d.referralPhone);   // the row's email already passed the junk check at referral time
    var role   = String(d.referralRole || '').trim();
    if (RAFFLE_ROLES.indexOf(role) === -1) {
      throw makeValidationError('Let us know whether you are looking to buy or to sell.');
    }
    var timeframe = collapseSpaces(d.referralTimeframe);
    if (d.consent !== 'Yes') {
      throw makeValidationError('Tick the consent box, or choose "do not contact me".');
    }

    // First consent wins. Re-checked here, under the lock, against everything
    // already consented -- the submit-time check cannot cover a referral who
    // changed their own email address on this very page.
    var emailKey = raffleEmailKey_(email), phoneKey = rafflePhoneKey_(phone);
    var rows = raffleReadEntries_(found.test);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].row === found.row) continue;
      if (rows[i].status !== RAFFLE_STATUS_ELIGIBLE) continue;
      if ((emailKey && rows[i].referralEmailKey === emailKey) ||
          (phoneKey && rows[i].referralPhoneKey === phoneKey)) {
        sh.getRange(found.row, RAFFLE_COL['Entry Status'] + 1).setValue(RAFFLE_STATUS_SUPERSEDED);
        // Their details and consent are still worth having even though the
        // entry does not count, so the FUB write below still runs.
        raffleUpdateReferralInFub_(entry, { name: name, email: email, phone: phone,
                                            role: role, timeframe: timeframe }, found.test);
        return jsonOut({ ok: true, superseded: true,
          message: 'Thanks — you are confirmed. Someone had already referred you, so ' +
                   'this one does not add entries to the drawing, but we have your details.' });
      }
    }

    var now = raffleFmt_(raffleNow_());
    // Test mode relaxes the entry window everywhere else (see RaffleCode.gs), and
    // it has to here too: a rehearsal run at any hour must be able to produce a
    // genuinely eligible row, or there would be nothing for a test draw to draw.
    var closed = !found.test && Date.now() >= new Date(RAFFLE_CLOSE_AT).getTime();

    sh.getRange(found.row, RAFFLE_COL['Referral Name'] + 1).setValue(raffleSafeCell_(name));
    sh.getRange(found.row, RAFFLE_COL['Referral Email'] + 1).setValue(raffleSafeCell_(email));
    sh.getRange(found.row, RAFFLE_COL['Referral Phone'] + 1).setValue(raffleSafeCell_(phone));
    sh.getRange(found.row, RAFFLE_COL['Referral Role'] + 1).setValue(role);
    sh.getRange(found.row, RAFFLE_COL['Referral Timeframe'] + 1).setValue(raffleSafeCell_(timeframe));
    sh.getRange(found.row, RAFFLE_COL['Referral Consent At'] + 1).setValue(
      raffleAddressWasSubstituted_(entry, { email: email })
        ? now + ' (ADDRESS CHANGED from ' + entry.referralEmail + ' — not re-verified)'
        : now);
    // Consent after the draw still updates FUB, but it cannot retroactively
    // create an entry in a drawing that has already happened.
    sh.getRange(found.row, RAFFLE_COL['Entry Status'] + 1)
      .setValue(closed ? RAFFLE_STATUS_SUPERSEDED : RAFFLE_STATUS_ELIGIBLE);

    var newPersonId = raffleUpdateReferralInFub_(entry,
      { name: name, email: email, phone: phone, role: role, timeframe: timeframe }, found.test);
    if (newPersonId && !entry.referralFubId) {
      sh.getRange(found.row, RAFFLE_COL['Referral FUB ID'] + 1).setValue(newPersonId);
      entry.referralFubId = newPersonId;
    }
    // AND ENTER THEM, here, on the strength of the same box they just ticked.
    //
    // This is the answer to the one thing that can sink the whole design: a
    // referral has no reason of their own to click. Confirming used to buy them
    // nothing but somebody else's five entries, and then an email inviting them
    // to go and refer a third person. Now the box says "confirming enters you in
    // the drawing too" and it is true the moment they press it -- no second
    // click, no form, one ticket.
    //
    // The consent box carries the 18+/US-resident attestation and agreement to
    // the Official Rules whenever the drawing is still open (see
    // raffleConsentPage_), which is what makes entering them legitimate; when it
    // is closed the box asks for neither, and nobody is entered.
    if (!closed) {
      raffleEnsureSelfEntry_(name, email, phone, entry.referralFubId || '', found.test);
    }

    raffleNotifyEntrantEntered_(entry, name, found.test, closed);
    // A row only just became a real entry, so this is the moment the count moved.
    if (!closed) raffleMaybeNotifyMilestone_(found.test);

    // They proved this inbox is theirs, so they can enter by referring someone
    // without verifying anything again. The token is minted whether or not the
    // invite sends, so the link keeps working if the send is throttled -- and it
    // is NOT minted after the draw, because there is nothing left to enter.
    if (!closed) {
      var chainToken = entry.chainToken || Utilities.getUuid();
      sh.getRange(found.row, RAFFLE_COL['Chain Token'] + 1).setValue(chainToken);
      raffleLogEmailToFub_(entry.referralFubId || newPersonId,
        'You are in - refer someone', 'We invited them to refer somebody in turn, ' +
        'which enters them with one ticket of their own.', found.test);
      if (raffleSendChainInvite_(entry, { name: name, email: email }, chainToken, found.test)) {
        sh.getRange(found.row, RAFFLE_COL['Chain Emailed At'] + 1)
          .setValue(raffleFmt_(raffleNow_()));
      }
    }

    return jsonOut({ ok: true, confirmed: true, closed: closed,
      message: closed
        ? 'Thank you — you are confirmed and someone will be in touch. The drawing has ' +
          'already taken place, so this one came in after the close.'
        : 'Thank you — you are confirmed, and you are in the drawing too. ' +
          String(entry.name).split(' ')[0] + ' just picked up ' +
          RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more entries.' });
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }
}

// ---------- FUB writes triggered by the referral's own answer ----------
// The referral record already exists (created at submit time, with consent
// recorded as NOT GIVEN). This is the update that turns it into a contact the
// team is actually allowed to work.
// True when the consented address differs from the referred one.
//
// As of 2026-09-17 the email field is LOCKED (see raffleConsentSubmit_), so this
// cannot fire through the page. It is kept deliberately, as a tripwire: if the
// field is ever re-opened, or a future path starts taking the address from the
// request again, the FUB note goes back to warning the team instead of failing
// silently. A guard that costs nothing while it is unreachable is worth keeping.
function raffleAddressWasSubstituted_(entry, edited) {
  var was = raffleEmailKey_(entry.referralEmail);
  var now = raffleEmailKey_(edited.email);
  return !!(was && now && was !== now);
}

// The ONE place a referral becomes a FUB contact, or an already-swept one is
// upgraded. Since 2026-09-17 nothing writes the referral to FUB before this
// point, so the usual case here is a create; an update happens only when the
// draw-time sweep got there first (they consented afterwards) .
function raffleUpdateReferralInFub_(entry, edited, test) {
  var apiKey = raffleFubKey_();
  if (!apiKey) return null;
  var personId = entry.referralFubId;
  if (!personId) {
    var parts = splitName(edited.name);
    var payload = {
      firstName: parts.first, lastName: parts.last,
      source: RAFFLE_SOURCE + ' (referral)',
      tags: RAFFLE_REFERRAL_TAGS.concat([edited.role, 'Consented']),
      emails: [{ value: edited.email, type: 'home' }],
      phones: edited.phone ? [{ value: edited.phone, type: 'mobile' }] : [],
      background: raffleConsentedBackground_(entry, edited)
    };
    var timeframeIdNew = null;
    try { timeframeIdNew = resolveTimeframeId(edited.timeframe); } catch (tfErr) { timeframeIdNew = null; }
    if (timeframeIdNew !== null && timeframeIdNew !== undefined) payload.timeframeId = timeframeIdNew;
    applyQaTestPersonMarking_(payload);
    var created = raffleFubCall_('https://api.followupboss.com/v1/people', 'post', payload, apiKey);
    personId = created.ok && created.body && created.body.id;
    if (!personId) {
      Logger.log('raffleUpdateReferralInFub_: create failed ' + created.code + ': ' +
        String(created.text).slice(0, 200));
      try {
        sendErrorAlert('Raffle: could not create a CONSENTED referral in FUB',
          'This person confirmed their details and gave consent, and we failed to write ' +
          'them to FUB. The raffle sheet has everything -- add them by hand.\n\n' +
          edited.name + ' / ' + edited.email + ' / ' + (edited.phone || '(none)') + '\n' +
          'Referred by ' + entry.name + ' (' + entry.email + ')');
      } catch (alertErr) { /* never swallow the visitor's response */ }
      return null;
    }
    // The relationship and the referrer's count belong to a CONFIRMED referral,
    // so they are established here rather than when the name was typed in.
    if (entry.fubId) {
      raffleLinkPeople_(entry.fubId, personId, 'Referred', apiKey);
      raffleLinkPeople_(personId, entry.fubId, 'Referred by', apiKey);
      raffleBumpReferralCount_(entry.fubId, apiKey);
      raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
        personId: entry.fubId,
        subject: (test ? QA_TEST_PREFIX : '') + 'Referred ' + edited.name + ' — confirmed',
        body: raffleEntrantNote_({ entrant: { name: entry.name, email: entry.email,
          phone: entry.phone }, refName: edited.name, refEmail: edited.email,
          refPhone: edited.phone, role: edited.role, timeframe: edited.timeframe }),
        isHtml: false
      }, apiKey);
    }
    var referredByKey = raffleCustomFieldKey_(RAFFLE_REFERRED_BY_LABELS);
    if (referredByKey) {
      var rb = {};
      rb[referredByKey] = entry.name;
      raffleFubCall_('https://api.followupboss.com/v1/people/' + personId, 'put', rb, apiKey);
    }
  }

  // Additive by the same rule as the entry path: never overwrite a populated
  // name, add emails and phones rather than replacing them.
  var update = { tags: RAFFLE_REFERRAL_TAGS.concat([edited.role, 'Consented']) };
  var timeframeId = null;
  try { timeframeId = resolveTimeframeId(edited.timeframe); } catch (tfErr) { timeframeId = null; }
  if (timeframeId !== null && timeframeId !== undefined) update.timeframeId = timeframeId;
  var consentKey = CONSENT_CUSTOM_FIELD;
  if (consentKey) update[consentKey] = Utilities.formatDate(raffleNow_(), RAFFLE_TZ, 'yyyy-MM-dd');

  var res = raffleFubCall_('https://api.followupboss.com/v1/people/' + personId, 'put', update, apiKey);
  if (!res.ok && consentKey) {
    delete update[consentKey];
    res = raffleFubCall_('https://api.followupboss.com/v1/people/' + personId, 'put', update, apiKey);
  }
  if (!res.ok) {
    Logger.log('raffleUpdateReferralInFub_: PUT returned ' + res.code + ': ' +
      String(res.text).slice(0, 200));
  }
  var createdPersonId = personId;

  raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
    personId: personId,
    subject: (test ? QA_TEST_PREFIX : '') + 'Confirmed their details and consented',
    body: [
      'This person opened the referral link and confirmed their own details.',
      '',
      raffleAddressWasSubstituted_(entry, edited)
        ? ['*** THE EMAIL ADDRESS WAS CHANGED ON THE CONSENT PAGE ***',
           'Referred under: ' + entry.referralEmail,
           'Consented as:   ' + edited.email,
           '',
           'Usually this is a typo being corrected. It can also mean the person holding',
           'the link put in a different address, and the new one was NOT re-verified --',
           'no code was sent to it. Treat this consent as weaker than the others: confirm',
           'by phone before adding this contact to anything automated.',
           ''].join('\n')
        : '',
      'Confirmed: ' + raffleFmt_(raffleNow_()) + ' ET',
      '  Name:       ' + edited.name,
      '  Email:      ' + edited.email,
      '  Phone:      ' + (edited.phone || '(not given)'),
      '  Looking to: ' + edited.role,
      '  Timeframe:  ' + (edited.timeframe || '(not given)'),
      '',
      'CONSENT GIVEN BY THIS PERSON THEMSELVES: express written consent to be contacted',
      'by call, text and email (including autodialed/prerecorded messages) about real',
      'estate services. Consent language version: ' + RAFFLE_CONSENT_VERSION + '.',
      '',
      'They were referred by ' + entry.name + ' (' + entry.email + ').'
    ].join('\n'),
    isHtml: false
  }, apiKey);

  return createdPersonId;
}

// The background written on a referral at the moment they consent -- which, since
// 2026-09-17, is the moment the record is created at all.
function raffleConsentedBackground_(entry, edited) {
  return [
    'Referred by ' + entry.name + ' at the ' + RAFFLE_EVENT_NAME + '.',
    '',
    'Looking to: ' + edited.role,
    'Timeframe:  ' + (edited.timeframe || '(not given)'),
    '',
    'CONSENT GIVEN BY THIS PERSON THEMSELVES. They opened a link sent only to this',
    'email address, confirmed their own details and ticked the consent box: express',
    'written consent to be contacted by call, text and email (including autodialed or',
    'prerecorded messages) about real estate services.',
    'Consent language version: ' + RAFFLE_CONSENT_VERSION + '.',
    '',
    'Referrer: ' + entry.name + ' / ' + entry.email + ' / ' + entry.phone
  ].join('\n');
}

// A decline is recorded loudly, because the cost of missing it is calling
// somebody who explicitly said no.
function raffleMarkDeclinedInFub_(entry, test) {
  var apiKey = raffleFubKey_();
  if (!apiKey) return null;
  var personId = entry.referralFubId;

  // Since referrals are no longer created in FUB up front, a decline usually has
  // no record to mark -- so it creates one. That reads backwards at first glance
  // ("they said don't contact me, so we made a file on them"), and it is right:
  // a suppression record is the only way the next person who tries to refer them,
  // or an agent who meets them next year, finds out they already said no. Holding
  // nothing means we email them again in six months.
  if (!personId) {
    var parts = splitName(entry.referralName || '');
    var payload = {
      firstName: parts.first, lastName: parts.last,
      source: RAFFLE_SOURCE + ' (referred, declined)',
      tags: ['Do Not Contact', 'Referral Declined', 'Block Party 2026'],
      emails: entry.referralEmail ? [{ value: entry.referralEmail, type: 'home' }] : [],
      phones: entry.referralPhone ? [{ value: entry.referralPhone, type: 'mobile' }] : [],
      background: [
        'DO NOT CONTACT. This person was named as a referral at the ' + RAFFLE_EVENT_NAME +
          ' and',
        'explicitly chose "do not contact me" on the confirmation page.',
        '',
        'They gave no consent and actively refused it. This record exists ONLY so that',
        'nobody contacts them by accident and so a second referral of the same person is',
        'refused. Do not call, text, email or drip this contact.',
        '',
        'Referred by: ' + entry.name + ' (' + entry.email + ')'
      ].join('\n')
    };
    applyQaTestPersonMarking_(payload);
    var created = raffleFubCall_('https://api.followupboss.com/v1/people', 'post', payload, apiKey);
    personId = created.ok && created.body && created.body.id;
    if (!personId) {
      Logger.log('raffleMarkDeclinedInFub_: could not create the suppression record: ' +
        created.code + ' ' + String(created.text).slice(0, 200));
      return null;
    }
  } else {
    raffleFubCall_('https://api.followupboss.com/v1/people/' + personId, 'put', {
      tags: ['Do Not Contact', 'Referral Declined', 'Block Party 2026']
    }, apiKey);
  }

  raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
    personId: personId,
    subject: (test ? QA_TEST_PREFIX : '') + 'DECLINED — do not contact',
    body: [
      'This person opened the referral link and explicitly chose "do not contact me".',
      '',
      'Declined: ' + raffleFmt_(raffleNow_()) + ' ET',
      'Referred by: ' + entry.name + ' (' + entry.email + ')',
      '',
      'DO NOT call, text or email this contact. They gave no consent and actively',
      'refused it. The record is kept only so nobody re-adds them by accident.'
    ].join('\n'),
    isHtml: false
  }, apiKey);

  return personId;
}

// Tells the entrant their entry has landed. This matters more than it looks:
// they were told at the party that their entry depends on someone else, and
// without this they have no way to know whether it ever happened.
function raffleNotifyEntrantEntered_(entry, referralName, test, closed) {
  try {
    MailApp.sendEmail({
      to: entry.email,
      replyTo: RAFFLE_SHARED_INBOX,     // this one IS to the referrer, so info@ alone
      bcc: raffleOversightBcc_(test),
      name: 'The Stawasz Group',
      subject: (test ? QA_TEST_PREFIX : '') +
        (closed ? 'Your referral confirmed (after the drawing closed)'
                : referralName + ' confirmed — ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
                  ' more entries for you'),
      body: [
        (closed
          ? referralName + ' confirmed their details, but it came in after entries closed at ' +
            '6:15 PM, so it did not make the drawing. Thank you for the referral all the same —'
          : referralName + ' confirmed their details, so you just picked up ' +
            RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more entries in the ' +
            RAFFLE_PRIZE_SHORT + ' drawing.'),
        '',
        (closed ? 'we will look after them.' :
          'The winner is drawn at 6:15 PM on Saturday and announced at ' + RAFFLE_ANNOUNCE_AT +
          ' at the Block Party. You do not need to be present to win — we will call you.'),
        '',
        'Thanks for thinking of us.',
        '',
        'The Stawasz Group · Keller Williams Empower',
        '728 S Broad St, Philadelphia, PA 19146 · (215) 760-6291'
      ].join('\n')
    });
  } catch (err) {
    Logger.log('raffleNotifyEntrantEntered_ failed: ' + err);
  }
  try {
    raffleLogEmailToFub_(entry.fubId,
      referralName + ' confirmed', 'We told them their referral confirmed and that ' +
      'they gained ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more entries.', test);
  } catch (logErr) {
    Logger.log('raffleNotifyEntrantEntered_ FUB log failed: ' + logErr);
  }
}

// ---------- Telling the winner ----------
// DELIBERATELY NOT AUTOMATIC. The draw runs at 6:15 and Durand announces at 6:30,
// so an email fired by the draw would land in the winner's pocket fifteen minutes
// before he says the name out loud -- which spoils the one moment the whole thing
// is built around. This is a separate, explicit action: raffleNotifyWinner() from
// the editor, or the admin URL raffleAdminLinks() prints, pressed AFTER the
// announcement.
var RAFFLE_WINNER_EMAILED_PROP = 'RAFFLE_WINNER_EMAILED_AT';
var RAFFLE_TEST_WINNER_EMAILED_PROP = 'RAFFLE_TEST_WINNER_EMAILED_AT';

function raffleWinnerEmailedProp_(test) {
  return test ? RAFFLE_TEST_WINNER_EMAILED_PROP : RAFFLE_WINNER_EMAILED_PROP;
}

// Editor-callable. Returns a human-readable string, the same way raffleAdminLinks
// does, so running it from the Apps Script editor tells you what happened.
function raffleNotifyWinner() { return raffleSendWinnerEmail_(false).message; }
function raffleNotifyWinnerTEST() { return raffleSendWinnerEmail_(true).message; }

function raffleSendWinnerEmail_(test, pickIndex, reason) {
  var props = PropertiesService.getScriptProperties();
  var stored = raffleStoredWinner_(test);
  if (!stored) {
    return { ok: false, message: 'No winner has been drawn yet' +
      (test ? ' on the test tab' : '') + ', so there is nobody to email.' };
  }
  var already = props.getProperty(raffleWinnerEmailedProp_(test));
  if (already) {
    return { ok: false, alreadySent: true,
      message: 'The winner was already emailed at ' + already + '. ' +
               'Not sending a second one — if you need to resend, clear the "' +
               raffleWinnerEmailedProp_(test) + '" script property first.' };
  }

  // Which of the three. 0 is the drawn winner and is the only one that sends
  // without a reason; see the console header for why the others are awkward.
  var picks = rafflePicks_(stored);
  var idx = Math.max(0, Math.min(picks.length - 1, Number(pickIndex) || 0));
  var w = picks[idx];
  if (idx > 0) {
    props.setProperty(rafflePickReasonProp_(test),
      'Sent to pick ' + (idx + 1) + ' (' + (w && w.name) + ') instead of the drawn winner (' +
      stored.winner.name + '). Reason given: ' + (reason || '(none)'));
    Logger.log('RAFFLE: winner email sent to ALTERNATE pick ' + (idx + 1) + '. Reason: ' + reason);
    raffleAppendDrawAudit_(test, [
      raffleFmt_(raffleNow_()),
      'ALTERNATE PICK',
      'Prize awarded to pick ' + (idx + 1) + ': ' + (w && w.name) + ' (' + (w && w.email) + ')',
      'Drawn winner was ' + stored.winner.name + ' (' + stored.winner.email + ')',
      reason || '(none)'
    ]);
  }
  if (!w || !w.email) {
    return { ok: false, message: 'The stored winner has no email address on it. ' +
      'Something is wrong with the draw record — tell Claude before doing anything else.' };
  }

  // qaTestRecipients_ on the CC, like raffleEmailResult_ does. Without it a
  // rehearsal at 4pm on a Thursday copies Ryan on a "you won" that nobody won --
  // which is exactly the thing this project's test mode exists to prevent, and it
  // was the one new surface that had been left out. (test_redteam.js T9,
  // 2026-09-17.) The `to` needs no such treatment: in test mode the winner IS a
  // QA entry, so w.email is already a QA address.
  MailApp.sendEmail({
    to: w.email,
    cc: qaTestRecipients_(RAFFLE_RESULT_EMAIL.split(',')).join(','),
    // Ryan fields winner replies, so that is where a reply lands -- plus the
    // shared inbox, per the standing rule that a reply never reaches only one place.
    replyTo: raffleReplyTo_(RAFFLE_WINNER_REPLY_TO),
    name: 'The Stawasz Group',
    subject: (test ? QA_TEST_PREFIX : '🎉 ') + 'You won! ' + RAFFLE_PRIZE_SHORT +
             ' — TSG Block Party',
    htmlBody: raffleWinnerHtml_(w, stored, test),
    body: raffleWinnerPlain_(w, stored)
  });

  var when = raffleFmt_(raffleNow_());
  props.setProperty(raffleWinnerEmailedProp_(test), when);
  Logger.log('Raffle: winner email sent to ' + w.email + ' at ' + when + ' (test=' + !!test + ').');
  return { ok: true, when: when, pick: idx,
    message: 'Sent to ' + w.name + ' <' + w.email + '> at ' + when + ' ET, copied to ' +
             RAFFLE_RESULT_EMAIL + '.' +
             (idx > 0 ? ' NOTE: this was alternate pick ' + (idx + 1) +
                        ', not the drawn winner. Your reason is recorded.' : '') };
}

// Same construction rules as the referral invite: inline styles only (Gmail strips
// <style> blocks), a plain-text alternative alongside, and EVERY value escaped --
// the winner's own name came from a public text box like everything else.
function raffleWinnerHtml_(w, result, test) {
  var e = raffleEsc_;
  var first = String(w.name || '').split(' ')[0];
  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px;',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;',
    'color:#1d2b2c;line-height:1.55;">',

    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:16px;">QA TEST — this is a rehearsal, not a real win</div>' : '',

    // Header
    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;',
    'padding:30px 24px;text-align:center;">',
    '<div style="font-size:11px;letter-spacing:2.5px;opacity:.8;">THE STAWASZ GROUP</div>',
    '<div style="font-size:13px;letter-spacing:1.5px;opacity:.75;margin-top:4px;">',
    'BLOCK PARTY 2026</div>',
    '<div style="font-size:30px;font-weight:700;margin-top:14px;line-height:1.2;">',
    'You won, ' + e(first) + '!</div>',
    '</div>',

    // Prize
    '<div style="background:#0f3336;color:#fff;padding:26px 24px;text-align:center;">',
    '<div style="font-size:11px;letter-spacing:2px;opacity:.75;">YOUR PRIZE</div>',
    '<div style="font-size:46px;font-weight:700;margin:6px 0 2px;letter-spacing:-1px;">$300</div>',
    '<div style="font-size:15px;font-weight:600;opacity:.92;">toward any Ticketmaster purchase</div>',
    '</div>',

    // Body
    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;">',
    '<p style="margin:0 0 14px;">Your name was drawn at random at 6:15 PM and announced at ',
    'the party at 6:30. Congratulations &mdash; and thank you for the referral, which is what ',
    'put you in the drawing in the first place.</p>',

    '<div style="background:#f4f6f6;border-radius:8px;padding:16px;margin:0 0 20px;font-size:15px;">',
    '<div style="font-weight:700;margin-bottom:8px;">How to claim it</div>',
    '<div>Just reply to this email, or call us on ',
    '<a href="tel:+12157606291" style="color:#15464A;font-weight:600;">(215) 760-6291</a>. ',
    'We will arrange the $300 Ticketmaster gift card with you directly &mdash; there is ',
    'nothing to fill in and nothing to pay.</div>',
    '</div>',

    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">',
    'Drawn from ' + e(result.totalEligible) + ' eligible ',
    (Number(result.totalEligible) === 1 ? 'entry' : 'entries') + ' &mdash; ' +
      e(rafflePlural_(result.totalPeople, 'person', 'people')) + ' holding ' +
      e(rafflePlural_(result.totalTickets, 'ticket')) + ' ',
    '&mdash; at ' + e(result.drawnAt) + ' ET. ',
    'The prize is a gift card redeemable toward any Ticketmaster purchase, subject to ',
    'Ticketmaster&rsquo;s own terms. Approximate retail value ' + e(RAFFLE_PRIZE_ARV) + '. ',
    'Any taxes on the prize are the winner&rsquo;s responsibility.</p>',

    '<p style="margin:0;font-size:14px;color:#55696a;">',
    'This promotion is not sponsored, endorsed by, or associated with Ticketmaster, ',
    'Live Nation, the Philadelphia Eagles or the NFL. All trademarks are the property of ',
    'their respective owners.</p>',
    '</div>',

    // Footer
    '<div style="text-align:center;padding:18px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower<br>',
    '728 S Broad St, Philadelphia, PA 19146 &middot; (215) 760-6291 &middot; info@tsg.homes',
    '</div></div></div>'
  ].join('');
}

function raffleWinnerPlain_(w, result) {
  var first = String(w.name || '').split(' ')[0];
  return [
    'You won, ' + first + '!',
    '',
    'Your prize: ' + RAFFLE_PRIZE_SHORT + '.',
    '',
    'Your name was drawn at random at 6:15 PM and announced at the party at 6:30.',
    'Congratulations - and thank you for the referral, which is what put you in the',
    'drawing in the first place.',
    '',
    'HOW TO CLAIM IT',
    'Just reply to this email, or call us on (215) 760-6291. We will arrange the $300',
    'Ticketmaster gift card with you directly - there is nothing to fill in and nothing',
    'to pay.',
    '',
    'Drawn from ' + result.totalEligible + ' eligible ' +
      (Number(result.totalEligible) === 1 ? 'entry' : 'entries') + ' - ' +
      rafflePlural_(result.totalPeople, 'person', 'people') +
      ' holding ' + rafflePlural_(result.totalTickets, 'ticket') +
      ' - at ' + result.drawnAt + ' ET.',
    'Approximate retail value ' + RAFFLE_PRIZE_ARV + '. Any taxes on the prize are the',
    "winner's responsibility. This promotion is not sponsored, endorsed by, or associated",
    'with Ticketmaster, Live Nation, the Philadelphia Eagles or the NFL.',
    '',
    'The Stawasz Group - Keller Williams Empower',
    '728 S Broad St, Philadelphia, PA 19146 - (215) 760-6291 - info@tsg.homes'
  ].join('\n');
}

// ============================================================================
// THE DRAW CONSOLE — where Durand and Ryan actually work the result
// ============================================================================
// Durand asked for the 6:15 email to carry all three picks, links into FUB, a
// way to choose, a preview, a confirmation and only then a send button, plus an
// emergency redraw.
//
// THE INTERACTIVE HALF CANNOT LIVE IN AN EMAIL. Every mail client strips
// JavaScript, so "select a pick, which enables a button, which shows a preview,
// which you then confirm" is not something an inbox can do. The email therefore
// carries the three picks, the FUB links and a single prominent link to THIS
// page, which is where the choosing happens. Key-gated, same key as the other
// admin endpoints.
//
// WHY PICKING IS DELIBERATELY AWKWARD. The Official Rules published on the entry
// form say the winner is drawn at random. If the console let you pick freely
// among three names, that would stop being true -- and for a promotion with
// published rules that is an integrity problem, not a UX preference. So pick #1
// sends with one confirmation, and picks #2 and #3 require a written reason that
// is recorded on the draw tab and repeated in the email trail. The alternates are
// a fallback for an ineligible or unreachable winner, not a menu.

var RAFFLE_PICK_REASON_PROP = 'RAFFLE_PICK_REASON';
var RAFFLE_TEST_PICK_REASON_PROP = 'RAFFLE_TEST_PICK_REASON';

function rafflePickReasonProp_(test) {
  return test ? RAFFLE_TEST_PICK_REASON_PROP : RAFFLE_PICK_REASON_PROP;
}

// Ryan fields the replies to a winner, so that is where a reply should land --
// not info@, which five people share and nobody owns.
// NOTE: Ryan has two addresses in play (ryan@thestawaszgroup.com on the calendar,
// ryan@tsg.homes in this project's agent roster). The business domain is used
// here to match info@tsg.homes; both are still copied on the email itself.
var RAFFLE_WINNER_REPLY_TO = 'ryan@tsg.homes';

// Per Durand, 2026-09-17: a reply to anything we send about a referral must reach
// BOTH info@ and the person who made the referral. The referrer is the one the
// recipient actually knows, and info@ is the one that is always watched -- either
// alone drops half the cases (a referrer on a listing appointment all Saturday, or
// an info@ inbox that has no idea who this person is).
//
// CAVEAT worth knowing: Apps Script documents MailApp's replyTo as a single
// address. RFC 5322 allows several and mail clients generally honour a
// comma-separated list, but this is the one thing here that cannot be proved from
// a sandbox -- it needs a real send. If only the first address survives, the fix
// is to swap these calls to the Gmail service with an explicit Reply-To header,
// which would also pull in a full-mailbox scope on a project whose web app is
// anonymous -- so it is a decision, not a tidy-up. Flagged for
// the live QA run rather than assumed.
var RAFFLE_SHARED_INBOX = 'info@tsg.homes';

// Durand on every outbound email, per his request 2026-09-17.
//
// BCC, not CC, on anything a member of the public receives. A client-facing email
// that visibly copies a third person they have never heard of reads as odd at
// best and as a data-handling mistake at worst; BCC gives Durand the same
// visibility without putting an internal address in front of a stranger. On the
// internal emails (the 6:15 result, the entry counts) he is already a named
// recipient, so nothing changes there.
//
// ONE DELIBERATE EXCEPTION: the verification-code email is NOT copied. That code
// is a credential — anyone holding it can complete somebody else's entry — and
// routing every entrant's code to a second inbox turns a one-time secret into a
// standing collection of them. The exception is enforced in code, not left to
// whoever edits this next.
// Durand, 2026-09-17: "bcc ryan and i on all". Both, on every outbound email --
// with ONE deliberate exception, the verification code, for the reason spelled
// out at that send site: the six-digit code is a credential, and copying every
// entrant's code to two more mailboxes turns a one-time secret into a standing
// collection of them. It is the same reasoning that took the consent link out of
// the entrant's copy of the invite earlier today. Say the word and it goes on
// that one too, but it should be a decision rather than a side effect of "all".
//
// NOTE ON QUOTA: Apps Script's daily limit counts RECIPIENTS, not messages, so
// two oversight copies make every email cost three. The suite prints the
// remaining quota on each run (section 5c) precisely so this stays visible.
var RAFFLE_OVERSIGHT_BCC = 'durand@thestawaszgroup.com,ryan@tsg.homes';

function raffleOversightBcc_(test) {
  // In test mode qaTestRecipients_ already collapses everything to Durand, so a
  // BCC would just duplicate the message to him -- and Ryan is never paged about
  // a rehearsal, which is a rule the red-team suite enforces.
  return test ? '' : RAFFLE_OVERSIGHT_BCC;
}

function raffleReplyTo_(referrerEmail) {
  var who = String(referrerEmail || '').trim();
  if (!who || raffleEmailKey_(who) === raffleEmailKey_(RAFFLE_SHARED_INBOX)) {
    return RAFFLE_SHARED_INBOX;
  }
  return who + ',' + RAFFLE_SHARED_INBOX;
}

function raffleFubLink_(personId) {
  if (!personId) return '';
  return 'https://' + FUB_SUBDOMAIN + '.followupboss.com/2/people/view/' + personId;
}

// All three picks as one list, so the email and the console never disagree about
// what "pick 2" means.
function rafflePicks_(result) {
  var picks = [result.winner].concat(result.backups || []);
  return picks.filter(function (p) { return !!p; });
}

// ---------- The 6:15 email, in HTML ----------
function raffleResultHtml_(result, test, consoleUrl) {
  var e = raffleEsc_;
  var picks = rafflePicks_(result);
  var rows = picks.map(function (p, i) {
    var isWinner = i === 0;
    var fub = raffleFubLink_(p.fubId);
    var refFub = raffleFubLink_(p.referralFubId);
    return [
      '<div style="border:1px solid ' + (isWinner ? '#15464A' : '#dfe6e6') + ';',
      'border-radius:8px;padding:16px;margin:0 0 12px;',
      (isWinner ? 'background:#f2f7f7;' : 'background:#fff;') + '">',
      '<div style="font-size:11px;letter-spacing:1.5px;color:' +
        (isWinner ? '#15464A' : '#7d8f90') + ';font-weight:700;">',
      isWinner ? 'PICK 1 &mdash; WINNER' : ('PICK ' + (i + 1) + ' &mdash; ALTERNATE'),
      '</div>',
      '<div style="font-size:19px;font-weight:700;margin:4px 0 2px;">' + e(p.name) + '</div>',
      '<div style="font-size:14px;color:#55696a;">',
      '<a href="tel:' + e(String(p.phone).replace(/[^0-9+]/g, '')) + '" ',
      'style="color:#15464A;font-weight:600;text-decoration:none;">' + e(p.phone) + '</a>',
      ' &middot; <a href="mailto:' + e(p.email) + '" style="color:#15464A;">' + e(p.email) + '</a>',
      '</div>',
      fub ? '<div style="margin-top:8px;"><a href="' + e(fub) + '" ' +
            'style="color:#15464A;font-weight:600;font-size:14px;">Open in Follow Up Boss &rarr;</a></div>' : '',
      '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e7eded;font-size:14px;">',
      // Most winners will have referred nobody -- an own entry is a whole entry.
      // "(unknown)" read like a missing value; this says what is actually true.
      p.referralName
        ? '<span style="color:#7d8f90;">Referred</span> <b>' + e(p.referralName) + '</b>'
        : '<span style="color:#7d8f90;">Referred nobody &mdash; entered on their own</span>',
      p.referralName && p.referralRole ? ' <span style="color:#7d8f90;">&mdash; looking to ' +
        e(raffleRoleVerb_(p.referralRole)) + '</span>' : '',
      p.referralName && p.referralTimeframe
        ? ' <span style="color:#7d8f90;">(' + e(p.referralTimeframe) + ')</span>' : '',
      refFub ? '<br><a href="' + e(refFub) + '" style="color:#15464A;font-weight:600;">' +
               'Open the referral in Follow Up Boss &rarr;</a>' : '',
      '</div>',
      '</div>'
    ].join('');
  }).join('');

  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:600px;margin:0 auto;padding:24px 16px;',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;',
    'color:#1d2b2c;line-height:1.5;">',

    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:14px;text-align:center;">TEST DRAW &mdash; the real ' +
           '6:15 draw is untouched</div>' : '',

    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;padding:22px 24px;">',
    '<div style="font-size:11px;letter-spacing:2.5px;opacity:.8;">TSG BLOCK PARTY 2026</div>',
    '<div style="font-size:22px;font-weight:700;margin-top:6px;">Raffle result</div>',
    '<div style="font-size:14px;opacity:.85;margin-top:6px;">Drawn ' + e(result.drawnAt) +
      ' ET from ' + e(result.totalEligible) + ' eligible ' +
      (Number(result.totalEligible) === 1 ? 'entry' : 'entries') + ' &middot; ' +
      e(rafflePlural_(result.totalPeople, 'person', 'people')) + ' &middot; ' +
      e(rafflePlural_(result.totalTickets, 'ticket')) + '</div>',
    '</div>',

    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:20px;">',
    rows,

    '<div style="background:#15464A;border-radius:8px;padding:18px;margin:18px 0 10px;text-align:center;">',
    '<div style="color:#fff;font-size:15px;font-weight:600;margin-bottom:12px;">',
    'Nothing has been sent to the winner yet.</div>',
    '<a href="' + e(consoleUrl) + '" style="display:inline-block;background:#fff;color:#15464A;',
    'text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:8px;">',
    'Open the draw console</a>',
    '<div style="color:#cfe0e0;font-size:13px;margin-top:12px;line-height:1.45;">',
    'Choose a pick, preview the email, confirm, then send. The console also has the ',
    'emergency redraw. This link carries the admin key &mdash; do not forward it.</div>',
    '</div>',

    '<p style="font-size:13px;color:#7d8f90;margin:14px 0 0;">',
    'The alternates are a fallback if pick 1 turns out ineligible or cannot be reached &mdash; ',
    'not a choice between three names. The published rules say the winner is drawn at random, ',
    'so the console asks for a written reason before it will send to pick 2 or 3, and records it.',
    '</p>',
    '<p style="font-size:13px;color:#7d8f90;margin:10px 0 0;">',
    'This draw is recorded and is not repeatable &mdash; re-running it returns this same ',
    'result by design.</p>',
    '</div>',

    '<div style="text-align:center;padding:16px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower</div>',
    '</div></div>'
  ].join('');
}

// ---------- The console page ----------
function raffleWinnerConsolePage_(test, key) {
  var stored = raffleStoredWinner_(test);
  if (!stored) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;padding:24px;max-width:560px">' +
      '<h2>No draw yet</h2><p>Nothing has been drawn' + (test ? ' on the test tab' : '') +
      ', so there is nobody to send to. The draw runs automatically at 6:15 PM.</p></div>');
  }
  var props = PropertiesService.getScriptProperties();
  var sentAt = props.getProperty(raffleWinnerEmailedProp_(test));
  var picks = rafflePicks_(stored);
  var e = raffleEsc_;

  var cards = picks.map(function (p, i) {
    var fub = raffleFubLink_(p.fubId), refFub = raffleFubLink_(p.referralFubId);
    return [
      '<label class="pick" for="p' + i + '">',
      '<input type="radio" name="pick" id="p' + i + '" value="' + i + '"' +
        (i === 0 ? ' checked' : '') + '>',
      '<div class="body">',
      '<div class="rank">' + (i === 0 ? 'PICK 1 — WINNER' : 'PICK ' + (i + 1) + ' — ALTERNATE') + '</div>',
      '<div class="nm">' + e(p.name) + '</div>',
      '<div class="ct"><a href="tel:' + e(String(p.phone).replace(/[^0-9+]/g, '')) + '">' +
        e(p.phone) + '</a> · <a href="mailto:' + e(p.email) + '">' + e(p.email) + '</a></div>',
      fub ? '<div class="lk"><a href="' + e(fub) + '" target="_blank">Open in Follow Up Boss →</a></div>' : '',
      '<div class="ref">' +
        (p.referralName
          ? '<span>Referred</span> <b>' + e(p.referralName) + '</b>' +
            (p.referralRole ? ' — looking to ' + e(raffleRoleVerb_(p.referralRole)) : '') +
            (p.referralTimeframe ? ' (' + e(p.referralTimeframe) + ')' : '')
          : '<span>Referred nobody — entered on their own</span>') +
        (refFub ? '<br><a href="' + e(refFub) + '" target="_blank">Open the referral in FUB →</a>' : '') +
      '</div>',
      '</div></label>'
    ].join('');
  }).join('');

  var tmpl = HtmlService.createTemplateFromFile('RaffleConsole');
  tmpl.cards      = cards;
  tmpl.isTest     = test ? '1' : '';
  // JSON-encoded, not concatenated. These land inside a <script> block, and a
  // value carrying a double quote would otherwise close the string literal and
  // run as code. The admin key is hex today, which is why this was not already
  // exploitable -- but "the current value happens to be safe" is not a control,
  // and the next person to set that property by hand would not know.
  tmpl.adminKeyJson    = safeJsonForScript_(key || '');
  tmpl.submitTokenJson = safeJsonForScript_(getSubmitToken());
  tmpl.isTestJson      = safeJsonForScript_(test ? '1' : '');
  tmpl.adminKey   = key || '';
  tmpl.submitToken = getSubmitToken();
  tmpl.drawnAt    = e(stored.drawnAt);
  tmpl.totalEligible = String(stored.totalEligible);
  tmpl.totalPeople = String(stored.totalPeople === undefined ? '?' : stored.totalPeople);
  tmpl.totalTickets = String(stored.totalTickets === undefined ? '?' : stored.totalTickets);
  tmpl.sentAt     = sentAt ? e(sentAt) : '';
  tmpl.sentAtJson = safeJsonForScript_(sentAt || '');
  tmpl.announceAt = RAFFLE_ANNOUNCE_AT;
  return tmpl.evaluate()
    .setTitle((test ? QA_TEST_PREFIX : '') + 'Draw console | TSG Block Party')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Renders the winner email exactly as it would be sent, for the preview step.
// Deliberately the SAME function that sends it -- a preview built by a second
// code path is a preview of something that does not exist.
function raffleWinnerPreview_(test, pickIndex) {
  var stored = raffleStoredWinner_(test);
  if (!stored) return { ok: false, error: 'Nothing has been drawn yet.' };
  var picks = rafflePicks_(stored);
  var i = Math.max(0, Math.min(picks.length - 1, Number(pickIndex) || 0));
  return { ok: true, pick: i, name: picks[i].name, email: picks[i].email,
           html: raffleWinnerHtml_(picks[i], stored, test) };
}

// ---------- The console's POST actions ----------
function raffleConsoleAction_(d) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(RAFFLE_ADMIN_PROP);
  // Same gate as the GET. The page carries the key; a POST without it is refused
  // with the same message as a wrong one, so it cannot be probed.
  if (!key || String(d.key || '') !== key) {
    throw makeValidationError('Not found.');
  }
  var test = String(d.test || '') === '1';
  var action = String(d.consoleAction || '').toLowerCase();

  if (action === 'preview') {
    return jsonOut(raffleWinnerPreview_(test, d.pick));
  }

  if (action === 'send') {
    var pick = Number(d.pick) || 0;
    var reason = collapseSpaces(d.reason);
    // Picks 2 and 3 need a written reason. See the header note: the published
    // rules say "drawn at random", and going past pick 1 without recording why
    // would quietly make that untrue.
    if (pick > 0 && reason.length < 10) {
      throw makeValidationError('Going past pick 1 needs a reason (at least a few words). ' +
        'It is recorded on the draw tab, because the Official Rules say the winner is ' +
        'drawn at random.');
    }
    var res = raffleSendWinnerEmail_(test, pick, reason);
    if (!res.ok) throw makeValidationError(res.message);
    return jsonOut({ ok: true, message: res.message });
  }

  if (action === 'redraw') {
    var why = collapseSpaces(d.reason);
    if (why.length < 10) {
      throw makeValidationError('A redraw needs a reason (at least a few words). ' +
        'It replaces a recorded result, so it has to leave a trail.');
    }
    var out = raffleRedraw_(test, why);
    if (!out.ok) throw makeValidationError(out.message);
    return jsonOut({ ok: true, message: out.message });
  }

  throw makeValidationError('Unknown console action.');
}

// Emergency redraw. Clears the recorded winner, notes WHY on the draw tab, and
// draws again. Refuses once the winner has already been emailed -- at that point
// a redraw is not a correction, it is taking a prize back off somebody, and that
// is a conversation to have with a person rather than a button to press.
function raffleRedraw_(test, reason) {
  var props = PropertiesService.getScriptProperties();
  var previous = raffleStoredWinner_(test);
  if (!previous) return { ok: false, message: 'Nothing has been drawn yet, so there is nothing to redraw.' };
  if (props.getProperty(raffleWinnerEmailedProp_(test))) {
    return { ok: false, message: 'The winner has already been emailed (' +
      props.getProperty(raffleWinnerEmailedProp_(test)) + '). A redraw now would be taking ' +
      'the prize back off somebody who has been told they won — that needs a phone call, ' +
      'not this button. Clear the "' + raffleWinnerEmailedProp_(test) +
      '" script property by hand if you really mean to.' };
  }

  Logger.log('RAFFLE REDRAW (test=' + !!test + '). Previous winner: ' +
    previous.winner.name + '. Reason: ' + reason);
  // NOT via raffleWriteDrawTab_: that tab is a clear-and-rewrite snapshot of the
  // CURRENT result, so writing the audit there would have it wiped by the very
  // next draw -- which is the one moment it matters. The audit is its own
  // append-only tab. (Caught by test_raffle.js, 2026-09-17.)
  raffleAppendDrawAudit_(test, [
    raffleFmt_(raffleNow_()),
    'REDRAWN',
    'Previous winner: ' + previous.winner.name + ' (' + previous.winner.email + ')',
    'Drawn from ' + previous.totalEligible + ' eligible entries (' +
      previous.totalPeople + ' people, ' + previous.totalTickets + ' tickets) at ' +
      previous.drawnAt,
    reason
  ]);

  props.deleteProperty(raffleWinnerProp_(test));
  props.deleteProperty(rafflePickReasonProp_(test));
  var fresh = raffleDrawWinner_(test, true);
  if (!fresh.ok) {
    return { ok: false, message: 'Redraw failed: ' + fresh.error };
  }
  return { ok: true, message: 'Redrawn. New winner: ' + fresh.result.winner.name +
    '. The previous result and your reason are recorded on the draw tab.' };
}

// ============================================================================
// ENTRY NOTIFICATIONS
// ============================================================================
// Durand, 2026-09-17: "until opening notify me via email every 10 valid entries,
// then during the event notify me periodically throughout the day."
//
// Two regimes, because the useful signal changes at 3:00 PM on the day:
//
//   BEFORE THE PARTY  entries trickle in from the pre-event email over days, so a
//                     time-based digest would mostly say "nothing happened". A
//                     milestone every 10 PEOPLE is the real news. People, not rows:
//                     one entrant owns an "own entry" row plus a row per referral,
//                     so counting rows would say "20 entries" for ten people. A
//                     pending referral row is likewise not counted, or the number
//                     would flatter itself.
//
//   DURING THE PARTY  entries arrive in bursts and Durand is standing in a street,
//                     so a milestone email every ten is noise. An hourly digest
//                     with the current count is what is actually readable.
//
// Both go to Durand only (not Ryan): these are operational nudges, not results.
var RAFFLE_MILESTONE_EVERY = 10;
var RAFFLE_MILESTONE_PROP = 'RAFFLE_LAST_MILESTONE';
var RAFFLE_TEST_MILESTONE_PROP = 'RAFFLE_TEST_LAST_MILESTONE';
// Durand, 2026-09-17: "bcc ryan and i on all". These two are the internal
// operational notes rather than client mail, and the original decision was
// deliberately Durand-only ("operational nudges, not results"). Ryan is on them
// now because "all" was explicit -- but this is the line to trim if an hourly
// counter during the party turns out to be noise he does not want.
var RAFFLE_NOTIFY_EMAIL = 'durand@thestawaszgroup.com,ryan@tsg.homes';

function raffleMilestoneProp_(test) {
  return test ? RAFFLE_TEST_MILESTONE_PROP : RAFFLE_MILESTONE_PROP;
}

// Called whenever a row becomes eligible: from the verification step (a new
// person is in) and from the consent step (a referral confirmed, so that
// entrant's ticket count jumped). Best-effort and completely silent on failure:
// a notification must never be the reason a referral's consent fails to record.
function raffleMaybeNotifyMilestone_(test) {
  try {
    // Once the party has started the hourly digest takes over; firing both would
    // double-notify during exactly the window Durand is least able to read email.
    if (Date.now() >= new Date(RAFFLE_EVENT_AT).getTime()) return;

    var eligible = raffleReadEntries_(test).filter(function (r) {
      return r.status === RAFFLE_STATUS_ELIGIBLE; });
    // Count PEOPLE, not rows. Under the multiplier model one entrant owns an "own
    // entry" row plus one row per referral, so rows would announce "20 entries"
    // for ten people and the number would flatter itself exactly the way a
    // pending row would. The unit Durand is tracking is how many people are in.
    var people = {}, tickets = 0;
    eligible.forEach(function (r) {
      people[r.emailKey || ('row' + r.row)] = true;
      tickets += Math.max(1, Number(r.tickets) || 1);
    });
    var count = Object.keys(people).length;
    if (count < RAFFLE_MILESTONE_EVERY) return;

    var milestone = Math.floor(count / RAFFLE_MILESTONE_EVERY) * RAFFLE_MILESTONE_EVERY;
    var props = PropertiesService.getScriptProperties();
    var last = Number(props.getProperty(raffleMilestoneProp_(test)) || 0);
    if (milestone <= last) return;          // already reported this one
    props.setProperty(raffleMilestoneProp_(test), String(milestone));

    var daysLeft = Math.max(0, Math.ceil(
      (new Date(RAFFLE_EVENT_AT).getTime() - Date.now()) / 86400000));
    MailApp.sendEmail({
      to: qaTestRecipients_([RAFFLE_NOTIFY_EMAIL]).join(','),
      name: 'TSG Block Party Raffle',
      subject: (test ? QA_TEST_PREFIX : '') + count + ' people in the Block Party raffle',
      body: (function () {
        // Three numbers, because they answer three different questions: how many
        // people are in, how many chances are in the draw, and how much upside is
        // still sitting in unanswered referrals. One number alone is misleading
        // now that a confirmed referral is worth RAFFLE_BONUS_TICKETS_PER_REFERRAL.
        var pending = raffleReadEntries_(test).filter(function (r) {
          return r.status === RAFFLE_STATUS_PENDING; }).length;
        return [
        count + ' people are entered so far.',
        tickets + ' tickets in the draw (each own entry is 1; each confirmed referral is ' +
          RAFFLE_BONUS_TICKETS_PER_REFERRAL + ').',
        '',
        'Everyone who verified their email is entered. A referral who CONFIRMS adds',
        RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more entries for whoever referred them.',
        '',
        'Still pending: ' + pending + ' referral(s) yet to reply — worth ' +
          (pending * RAFFLE_BONUS_TICKETS_PER_REFERRAL) + ' more tickets if they do.',
        '',
        daysLeft > 0 ? daysLeft + ' day(s) until the party. Entries close at 6:15 PM Saturday.'
                     : 'The party is today. Entries close at 6:15 PM.',
        '',
        'Next note at ' + (milestone + RAFFLE_MILESTONE_EVERY) + ' people.'
        ].join('\n');
      })()
    });
    Logger.log('Raffle: milestone notification sent at ' + count + ' people.');
  } catch (err) {
    Logger.log('raffleMaybeNotifyMilestone_ failed (non-fatal): ' + err);
  }
}

// Hourly during the party, armed by setupRaffle. Silent outside the window, so a
// trigger that survives the weekend does not mail anybody on Monday.
function raffleEventDigest() {
  try {
    var now = Date.now();
    var start = new Date(RAFFLE_EVENT_AT).getTime();
    var end = new Date(RAFFLE_CLOSE_AT).getTime();
    if (now < start || now > end + 3600000) return;

    var rows = raffleReadEntries_(false);
    var eligible = rows.filter(function (r) { return r.status === RAFFLE_STATUS_ELIGIBLE; });
    var pending  = rows.filter(function (r) { return r.status === RAFFLE_STATUS_PENDING; });
    var minsLeft = Math.max(0, Math.round((end - now) / 60000));

    // Who came in since the last digest, so the email says what CHANGED rather
    // than just restating a number.
    var props = PropertiesService.getScriptProperties();
    var lastCount = Number(props.getProperty('RAFFLE_LAST_DIGEST_COUNT') || 0);
    props.setProperty('RAFFLE_LAST_DIGEST_COUNT', String(eligible.length));
    var added = eligible.length - lastCount;

    MailApp.sendEmail({
      to: RAFFLE_NOTIFY_EMAIL,
      name: 'TSG Block Party Raffle',
      subject: eligible.length + ' entries · ' +
        (minsLeft > 0 ? minsLeft + ' min to the draw' : 'entries closed'),
      body: [
        eligible.length + ' valid entries' + (added > 0 ? ' (+' + added + ' since the last note)' : ''),
        pending.length + ' still waiting on a referral to confirm',
        '',
        minsLeft > 0
          ? 'Entries close and the draw runs in ' + minsLeft + ' minutes (6:15 PM).'
          : 'Entries are closed. The draw has run — check for the result email.',
        '',
        pending.length > 0 && minsLeft > 0 && minsLeft < 90
          ? 'Worth a nudge: ' + pending.length + ' people have referred someone who has not ' +
            'replied yet. Those entries will not count unless the referral confirms before 6:15.'
          : '',
        '',
        'Most recent valid entries:',
        eligible.slice(-5).map(function (r) {
          return '  ' + r.name +
            (r.referralName ? ' — referred ' + r.referralName : ' — own entry, no referral');
        }).join('\n') || '  (none yet)'
      ].join('\n')
    });
    Logger.log('Raffle: event digest sent (' + eligible.length + ' eligible).');
  } catch (err) {
    Logger.log('raffleEventDigest failed (non-fatal): ' + err);
  }
}


// Append-only record of anything that overrode a draw: a redraw, or a winner
// email sent to an alternate. Never cleared, never rewritten. If the fairness of
// this drawing is ever questioned, this tab is the answer -- which is why it does
// not share a sheet with anything that gets overwritten.
function raffleAppendDrawAudit_(test, cells) {
  try {
    var ss = SpreadsheetApp.openById(
      PropertiesService.getScriptProperties().getProperty(RAFFLE_SHEET_PROP));
    var name = test ? 'Draw Audit (TEST)' : 'Draw Audit';
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(['Timestamp (ET)', 'Action', 'Detail', 'Context', 'Reason given']);
      sh.setFrozenRows(1);
    }
    sh.appendRow(cells.map(raffleSafeCell_));
  } catch (err) {
    Logger.log('raffleAppendDrawAudit_ failed: ' + err);
  }
}


// ============================================================================
// DRAW-TIME SWEEP — the referrals who never answered
// ============================================================================
// Per Durand, 2026-09-17: "those that haven't consented by the draw time will get
// logged and flagged, if at any point they submit consent after that their contact
// gets updated."
//
// So silence is not nothing. Someone was named, an email reached them, and they
// did not reply -- that is still a person worth having on file, provided the file
// is honest about what it is. Each gets a contact tagged so nobody can mistake it
// for a lead that opted in, with a background that says in plain words what we do
// and do not know. If they consent later, raffleUpdateReferralInFub_ finds this
// record by its id and upgrades it rather than making a second one.
//
// Their referrer's entry stays invalid regardless: no consent, no entry.
var RAFFLE_UNCONFIRMED_TAGS = ['Block Party 2026', 'Referred Lead',
  'Needs Consent', 'Unconfirmed Contact Info'];

function raffleLogUnconfirmedReferrals_(test) {
  var apiKey = raffleFubKey_();
  if (!apiKey) {
    Logger.log('raffleLogUnconfirmedReferrals_: FUB_API_KEY unset; nothing swept.');
    return { swept: 0, failed: 0 };
  }
  var sh = raffleSheet_(test);
  var rows = raffleReadEntries_(test);
  var swept = 0, failed = 0;

  rows.forEach(function (r) {
    if (r.status !== RAFFLE_STATUS_PENDING) return;      // consented, declined or superseded
    if (r.referralFubId || r.referralLoggedAt) return;   // already in FUB
    if (!r.referralEmail) return;

    // Belt and braces: never create a duplicate of somebody FUB already holds.
    // The submit-time check said they were new, but that was hours or days ago.
    try {
      var existing = raffleFindCandidates_(r.referralEmail,
        rafflePhoneKey_(r.referralPhone), apiKey) || [];
      if (existing.length) {
        sh.getRange(r.row, RAFFLE_COL['Referral Logged At'] + 1)
          .setValue(raffleFmt_(raffleNow_()) + ' (already in FUB — not created again)');
        return;
      }
    } catch (searchErr) {
      Logger.log('raffleLogUnconfirmedReferrals_: search failed for row ' + r.row + ': ' + searchErr);
    }

    var parts = splitName(r.referralName || '');
    var payload = {
      firstName: parts.first, lastName: parts.last,
      source: RAFFLE_SOURCE + ' (referred, never confirmed)',
      tags: RAFFLE_UNCONFIRMED_TAGS.concat(r.referralRole ? [r.referralRole] : []),
      emails: [{ value: r.referralEmail, type: 'home' }],
      phones: r.referralPhone ? [{ value: r.referralPhone, type: 'mobile' }] : [],
      background: [
        'NAMED AS A REFERRAL AT THE ' + RAFFLE_EVENT_NAME.toUpperCase() + ' — NEVER CONFIRMED.',
        '',
        'THIS PERSON HAS GIVEN NO CONSENT. They were named by ' + r.name + ', we emailed',
        'them a link asking them to confirm their details and consent, and they did not',
        'reply before the drawing closed. Everything below came from the person who',
        'referred them, NOT from them:',
        '',
        '  Name:       ' + (r.referralName || '(not given)'),
        '  Email:      ' + r.referralEmail + '   (we emailed this; it did not bounce as far as we know)',
        '  Phone:      ' + (r.referralPhone || '(not given)'),
        '  Looking to: ' + (r.referralRole || '(not given)'),
        '  Timeframe:  ' + (r.referralTimeframe || '(not given)'),
        '',
        'DO NOT call, text or drip this contact on the strength of this record.',
        'Confirm the contact details and get consent from the person first. The record',
        'exists so the referral is not lost, not so it can be worked.',
        '',
        'Referred by: ' + r.name + ' / ' + r.email + ' / ' + r.phone,
        'Emailed:     ' + (r.chainEmailedAt || r.referralEmail ? 'yes' : 'unknown')
      ].join('\n')
    };
    applyQaTestPersonMarking_(payload);

    var created = raffleFubCall_('https://api.followupboss.com/v1/people', 'post', payload, apiKey);
    if (created.ok && created.body && created.body.id) {
      sh.getRange(r.row, RAFFLE_COL['Referral FUB ID'] + 1).setValue(created.body.id);
      sh.getRange(r.row, RAFFLE_COL['Referral Logged At'] + 1).setValue(raffleFmt_(raffleNow_()));
      raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
        personId: created.body.id,
        subject: (test ? QA_TEST_PREFIX : '') + 'Referred but never confirmed — needs consent',
        body: payload.background,
        isHtml: false
      }, apiKey);
      swept++;
    } else {
      failed++;
      Logger.log('raffleLogUnconfirmedReferrals_: create failed for row ' + r.row +
        ' (' + created.code + '): ' + String(created.text).slice(0, 200));
    }
  });

  if (swept || failed) {
    Logger.log('raffleLogUnconfirmedReferrals_: ' + swept + ' swept into FUB, ' + failed + ' failed.');
  }
  return { swept: swept, failed: failed };
}


// ============================================================================
// THE CHAIN — a confirmed referral can enter by referring somebody themselves
// ============================================================================
// Per Durand, 2026-09-17: "once a referral submits with consent they get the send
// a referral to enter email as well, already linked to them so they don't need to
// enter their own information, creating a potentially endless referral chain."
//
// WHY THEY DO NOT RE-VERIFY. The whole point of the consent step is that only
// their inbox could have received that link. Having proved that, asking for a
// six-digit code to the same address would prove nothing new and would cost most
// of them. So consenting mints a CHAIN TOKEN on their row, and that token buys
// exactly one thing: a verified session in their name.
//
// WHAT BOUNDS THE CHAIN. Nothing bounds its DEPTH, and that is deliberate -- a
// chain of confirmed people who each consented is the best thing this raffle can
// produce. What is bounded is the BRANCHING and the mail volume:
//   * one referral at a time per person, and a referral already in FUB is refused,
//     so a chain cannot loop back onto anyone who has already consented;
//   * RAFFLE_LOOKUP_MAX_PER_ENTRANT caps how many people one person can try;
//   * every invite goes through the same per-address and global send caps as a
//     verification code, so the chain cannot outrun the daily send quota; and
//   * after the draw, no chain invite is sent at all (Durand: "no new entry
//     emails get sent after the draw").
var RAFFLE_CHAIN_ACTION = 'refer';

function raffleChainUrl_(token) {
  return ScriptApp.getService().getUrl() +
    '?form=raffle&action=' + RAFFLE_CHAIN_ACTION + '&t=' + encodeURIComponent(token);
}

// Sent right after someone consents. Silent after the draw.
function raffleSendChainInvite_(entry, edited, chainToken, test) {
  if (!chainToken) return false;
  if (!test && Date.now() >= new Date(RAFFLE_CLOSE_AT).getTime()) {
    Logger.log('Raffle: chain invite suppressed — entries are closed.');
    return false;
  }
  try {
    raffleCheckCodeSendQuota_(raffleEmailKey_(edited.email));
  } catch (quotaErr) {
    Logger.log('Raffle: chain invite skipped (send quota): ' + quotaErr);
    return false;
  }
  var url = raffleChainUrl_(chainToken);
  var first = String(edited.name || '').split(' ')[0];
  try {
    MailApp.sendEmail({
      to: edited.email,
      name: 'The Stawasz Group',
      replyTo: raffleReplyTo_(entry.name ? entry.email : ''),
      bcc: raffleOversightBcc_(test),
      subject: (test ? QA_TEST_PREFIX : '') + first + ', you can win ' + RAFFLE_PRIZE_SHORT + ' too',
      htmlBody: raffleChainHtml_(entry, edited, url, test),
      body: raffleChainPlain_(entry, edited, url)
    });
    return true;
  } catch (err) {
    Logger.log('raffleSendChainInvite_ failed: ' + err);
    return false;
  }
}

function raffleChainHtml_(entry, edited, url, test) {
  var e = raffleEsc_;
  var first = String(edited.name || '').split(' ')[0];
  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px;',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;',
    'color:#1d2b2c;line-height:1.55;">',
    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:16px;">QA TEST — not a real invitation</div>' : '',
    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;padding:26px 24px;">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.8;">THE STAWASZ GROUP</div>',
    '<div style="font-size:22px;font-weight:700;margin-top:6px;">Thanks, ' + e(first) + '</div>',
    '</div>',
    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;">',
    '<p style="margin:0 0 14px;">You are all set &mdash; we have your details and we will be ',
    'in touch. And because you confirmed, <strong>' + e(entry.name) + '</strong> just earned ',
    RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' extra entries in our drawing for ' +
      e(RAFFLE_PRIZE_SHORT) + '.</p>',
    '<p style="margin:0 0 18px;"><b>You are in it too.</b> Opening the link below enters you ',
    'with one entry &mdash; we already have your details, so there is nothing to fill in about ',
    'yourself. Name someone who is considering buying or selling in the next year and you get ',
    RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more.</p>',
    '<div style="text-align:center;margin:0 0 20px;">',
    '<a href="' + e(url) + '" style="display:inline-block;background:#15464A;color:#fff;',
    'text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px;">',
    'Enter me and refer someone</a></div>',
    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">Same rules for everyone: one ',
    'entry for entering, ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more for each person you ',
    'name who confirms their own details and gives their own permission. ',
    'Entries close at 6:15 PM on Saturday 19 September, when the winner is drawn. ',
    'You do not need to be at the party to enter or to win.</p>',
    '<p style="margin:0;font-size:14px;color:#55696a;">Not interested? Ignore this &mdash; ',
    'nothing changes and we will not chase you about it.</p>',
    '</div>',
    '<div style="text-align:center;padding:18px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower<br>',
    '728 S Broad St, Philadelphia, PA 19146 &middot; (215) 760-6291 &middot; info@tsg.homes',
    '</div></div></div>'
  ].join('');
}

function raffleChainPlain_(entry, edited, url) {
  var first = String(edited.name || '').split(' ')[0];
  return [
    'Thanks, ' + first + '.',
    '',
    'You are all set - we have your details and we will be in touch. And because you',
    'confirmed, ' + entry.name + ' just earned ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
      ' extra entries in our drawing for ' + RAFFLE_PRIZE_SHORT + '.',
    '',
    'You are in it too. Opening this link enters you with one entry - we already have',
    'your details, so there is nothing to fill in about yourself. Name someone',
    'considering buying or selling in the next year and you get ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' more:',
    '',
    url,
    '',
    'Same rules for everyone: one entry for entering, ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
      ' more for each person you name who',
    'confirms their own details and gives their own permission. Entries close at 6:15 PM',
    'on Saturday 19 September. You do not need to be at the party to enter or to win.',
    '',
    'Not interested? Ignore this - nothing changes.',
    '',
    'The Stawasz Group - Keller Williams Empower',
    '728 S Broad St, Philadelphia, PA 19146 - (215) 760-6291 - info@tsg.homes'
  ].join('\n');
}

// Finds the row whose CHAIN token this is, across both tabs, and returns the
// person that token speaks for -- who is the REFERRAL on that row, and becomes the
// ENTRANT on the new one.
function raffleFindChain_(token) {
  var tabs = [false, true];
  for (var t = 0; t < tabs.length; t++) {
    var rows;
    try { rows = raffleReadEntries_(tabs[t]); } catch (err) { continue; }
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].chainToken && rows[i].chainToken === token) {
        return { row: rows[i], test: tabs[t] };
      }
    }
  }
  return null;
}

// GET ?form=raffle&action=refer&t=<chainToken>
// Mints a verified session for that person and serves the ordinary entry form,
// opened at the referral step with their details already known.
function raffleChainStart_(e) {
  var token = String((e && e.parameter && e.parameter.t) || '');
  var found = /^[0-9a-fA-F-]{36}$/.test(token) ? raffleFindChain_(token) : null;
  if (!found) {
    return raffleConsentShell_('<h2 style="margin:0 0 10px">That link has expired</h2>' +
      '<p>We could not find that invitation. If you would like to refer someone, ' +
      'call us on (215) 760-6291 and we will take it down for you.</p>', false);
  }
  var r = found.row;
  if (r.status !== RAFFLE_STATUS_ELIGIBLE && r.status !== RAFFLE_STATUS_SUPERSEDED) {
    return raffleConsentShell_('<h2 style="margin:0 0 10px">Confirm your own details first</h2>' +
      '<p>Use the link in the email we sent you to confirm your details and give ' +
      'permission, and we will invite you to refer someone straight afterwards.</p>',
      found.test);
  }

  // The session this token buys. Same shape raffleVerifyCode_ writes, because the
  // referral step must not be able to tell the difference -- a chain entrant IS a
  // verified entrant, proved by a link only their inbox received.
  var vid = Utilities.getUuid();
  CacheService.getScriptCache().put(RAFFLE_VERIFIED_PREFIX + vid, JSON.stringify({
    name: r.referralName, email: r.referralEmail, phone: r.referralPhone,
    personId: r.referralFubId || '',
    test: !!found.test, verifiedAt: raffleFmt_(raffleNow_()),
    viaChain: true
  }), RAFFLE_VERIFIED_TTL_SECONDS);

  // A BACKSTOP, not the entry point. They were entered when they consented
  // (raffleConsentSubmit_), which is where the box they ticked lives. This
  // catches the one case that misses: a row that reached 'eligible' before
  // consent started entering people, or a consent whose self-entry write failed.
  // raffleEnsureSelfEntry_ is idempotent, so on the normal path it does nothing.
  // Entries are only written while the raffle is open, which it does not check,
  // so the gate is here.
  if (raffleEntryState_() === 'open' || found.test) {
    raffleEnsureSelfEntry_(r.referralName, r.referralEmail, r.referralPhone,
                           r.referralFubId || '', !!found.test);
  }

  // The action MUST be stripped before handing back to raffleServeForm_. Passing
  // `e` through unchanged means it sees action=refer again, calls straight back
  // into here, and recurses until the stack blows -- which is what the chain link
  // did until test_raffle.js exercised it end to end (2026-09-17). A caught
  // infinite loop is why the test drives the real route rather than the helper.
  var inner = { parameter: {} };
  Object.keys((e && e.parameter) || {}).forEach(function (k) {
    if (k !== 'action' && k !== 't') inner.parameter[k] = e.parameter[k];
  });

  return raffleServeForm_(inner, ScriptApp.getService().getUrl(), {
    chainVid: vid,
    chainFirst: String(r.referralName || '').split(' ')[0],
    chainTest: found.test
  });
}

// ============================================================================
// LAST-CHANCE REMINDER — the referrals who have not answered yet
// ============================================================================
// Per Durand, 2026-09-17: one nudge, with enough time left before the drawing
// that answering it can still change the outcome.
//
// The window is deliberately BOUNDED AT BOTH ENDS. Too early and it is not a last
// chance, it is nagging. Too late and it is worse than nothing: a "you have
// minutes left" email that arrives after someone stopped checking their phone
// wastes their goodwill and the referrer's entry alike. So the sweep fires only
// between RAFFLE_REMINDER_LEAD_HOURS and RAFFLE_REMINDER_MIN_LEAD_MINUTES before
// the close, and each person gets exactly one.
//
// Who is skipped, and why it matters:
//   * anyone who already consented or declined -- obviously;
//   * anyone who was never actually emailed the first time (no invite, nothing to
//     remind them of);
//   * anyone already reminded, tracked on the row rather than in cache, because
//     the trigger runs hourly and cache does not survive long enough to be a
//     safe idempotency key across a whole day; and
//   * everyone, once the draw has run.
// ONE BATCH, ONE MOMENT. Per Durand, 2026-09-17: every reminder goes out at the
// same time, not dribbled over an hourly sweep. That is the right call and not
// only for tidiness -- a staggered nudge means two people referred by the same
// person get "last chance" emails hours apart, which reads as a system that does
// not know what it is doing. A single send is also one thing to check afterwards
// rather than twenty.
//
// 5:00 PM, 75 minutes before the draw. Durand asked for this over my earlier
// 10:00 AM, and he is right for a reason I had missed: AT 5PM THE REFERRER IS
// STANDING IN THE STREET WITH THEIR PHONE. A morning email is read alone and
// deferred; a 5pm one lands while the person who made the referral is at the party
// and can text their friend directly — which converts far better than any email we
// could write. So the batch also nudges the REFERRER (raffleSendReferrerNudges_),
// and that pairing is what makes 5pm the better time rather than a tighter one.
//
// The cost, stated plainly: anyone who does not look at their phone in those 75
// minutes is gone, where a morning send would have reached them. That is the trade
// — fewer people reached, far more of the ones reached acting on it.
var RAFFLE_REMINDER_AT = '2026-09-19T17:00:00-04:00';
// 30, not 90: a 5pm batch leaves 75 minutes, so a 90-minute floor would have
// silently refused to send the very batch it was configured for. The floor exists
// to stop a catch-up firing at 6:10, not to second-guess the chosen time.
var RAFFLE_REMINDER_MIN_LEAD_MINUTES = 30;
// Records when the one batch went, so it can never go twice -- a script property
// rather than the cache, because the cache does not outlive the gap between the
// trigger firing and anyone noticing it did not.
var RAFFLE_REMINDER_BATCH_PROP = 'RAFFLE_REMINDER_BATCH_AT';
var RAFFLE_TEST_REMINDER_BATCH_PROP = 'RAFFLE_TEST_REMINDER_BATCH_AT';

function raffleReminderBatchProp_(test) {
  return test ? RAFFLE_TEST_REMINDER_BATCH_PROP : RAFFLE_REMINDER_BATCH_PROP;
}

// Hourly trigger, armed by setupRaffle. Silent outside the window, so the trigger
// can sit there all week without mailing anybody.
// The one-shot trigger armed at RAFFLE_REMINDER_AT, and the hourly catch-up, both
// land here. The batch marker makes that safe: whichever arrives first sends, the
// other finds the marker and does nothing. The catch-up exists because a one-shot
// trigger that fails to fire fails silently, and nobody would find out until the
// draw.
function raffleConsentReminderSweep() {
  try { return raffleSendConsentReminders_(false); }
  catch (err) {
    Logger.log('raffleConsentReminderSweep failed (non-fatal): ' + err);
    return { sent: 0, skipped: 0, reason: String(err) };
  }
}

// Editor-callable rehearsal: same code, test tab, and it ignores the timing
// window so a reminder can actually be seen before Saturday.
function raffleSendConsentRemindersTEST() {
  return raffleSendConsentReminders_(true, true).summary;
}

function raffleSendConsentReminders_(test, ignoreWindow) {
  var closeMs = new Date(RAFFLE_CLOSE_AT).getTime();
  var now = Date.now();
  var minsLeft = Math.round((closeMs - now) / 60000);
  var props = PropertiesService.getScriptProperties();

  if (!ignoreWindow) {
    var alreadyRan = props.getProperty(raffleReminderBatchProp_(test));
    if (alreadyRan) {
      return { sent: 0, skipped: 0,
        summary: 'The reminder batch already went out at ' + alreadyRan +
                 '. There is only ever one.' };
    }
    if (now >= closeMs) {
      return { sent: 0, skipped: 0, summary: 'Entries are closed — no reminders sent.' };
    }
    if (now < new Date(RAFFLE_REMINDER_AT).getTime()) {
      return { sent: 0, skipped: 0,
        summary: 'Not yet — the batch goes out at ' +
                 raffleFmt_(new Date(RAFFLE_REMINDER_AT)) + ' ET, all at once.' };
    }
    if (minsLeft < RAFFLE_REMINDER_MIN_LEAD_MINUTES) {
      return { sent: 0, skipped: 0,
        summary: 'Too late — a reminder now would leave under ' +
                 RAFFLE_REMINDER_MIN_LEAD_MINUTES + ' minutes to act (' + minsLeft +
                 ' to go), so none sent.' };
    }
    // Claimed BEFORE the sending loop, not after. If the send half-finishes and
    // the execution dies, the catch-up trigger must not start again from the top
    // and re-mail everyone it already reached.
    props.setProperty(raffleReminderBatchProp_(test), raffleFmt_(raffleNow_()));
  }

  var sh = raffleSheet_(test);
  var rows = raffleReadEntries_(test);
  var sent = 0, skipped = 0;

  rows.forEach(function (r) {
    if (r.status !== RAFFLE_STATUS_PENDING) { skipped++; return; }
    if (!r.referralEmailedAt && !r.referralEmail) { skipped++; return; }
    if (r.reminderSentAt) { skipped++; return; }
    if (!r.consentToken) { skipped++; return; }

    try {
      raffleCheckCodeSendQuota_(raffleEmailKey_(r.referralEmail));
    } catch (quotaErr) {
      Logger.log('Reminder skipped (send quota) for ' + r.referralEmail + ': ' + quotaErr);
      skipped++;
      return;
    }

    var url = raffleConsentUrl_(r.consentToken);
    var first = String(r.referralName || '').split(' ')[0];
    try {
      MailApp.sendEmail({
        to: r.referralEmail,
        replyTo: raffleReplyTo_(r.email),      // the referrer AND the shared inbox
        bcc: raffleOversightBcc_(test),
        name: 'The Stawasz Group',
        // Same reasoning as the invite subject: lead with what THEY get. "X is
        // counting on it" is a guilt appeal on somebody else's behalf, which is
        // exactly the ask that got ignored the first time.
        subject: (test ? QA_TEST_PREFIX : '') +
                 'Last chance — confirm and you are in the $300 drawing',
        htmlBody: raffleReminderHtml_(r, url, minsLeft, test),
        body: raffleReminderPlain_(r, url, minsLeft)
      });
      sh.getRange(r.row, RAFFLE_COL['Reminder Sent At'] + 1).setValue(raffleFmt_(raffleNow_()));
      raffleLogEmailToFub_(r.referralFubId, 'Last chance to confirm',
        raffleReminderPlain_(r, url, minsLeft), test);
      sent++;
    } catch (mailErr) {
      Logger.log('Reminder send failed for ' + r.referralEmail + ': ' + mailErr);
      skipped++;
    }
  });

  // The other half of the 5pm batch: tell each waiting REFERRER to nudge their
  // person. They are at the party, they have the phone, and they know them.
  var nudged = raffleSendReferrerNudges_(test, rows, minsLeft);

  var summary = sent + ' reminder(s) sent, ' + skipped + ' skipped, ' +
    nudged + ' referrer nudge(s) sent' +
    (ignoreWindow ? ' (timing window ignored — rehearsal)' : '') + '.';
  if (sent || nudged) Logger.log('Raffle: ' + summary);
  return { sent: sent, skipped: skipped, nudged: nudged, summary: summary };
}

// One email per WAITING REFERRER, not one per pending referral: somebody who
// referred two people who have both gone quiet gets a single email listing both,
// because two near-identical "go chase someone" emails a minute apart is how you
// teach a person to ignore you.
function raffleSendReferrerNudges_(test, rows, minsLeft) {
  var byReferrer = {};
  rows.forEach(function (r) {
    if (r.status !== RAFFLE_STATUS_PENDING) return;
    if (!r.email) return;
    var key = raffleEmailKey_(r.email);
    if (!byReferrer[key]) byReferrer[key] = { name: r.name, email: r.email, waiting: [] };
    byReferrer[key].waiting.push(r);
  });

  var sent = 0;
  Object.keys(byReferrer).forEach(function (key) {
    var g = byReferrer[key];
    try {
      MailApp.sendEmail({
        to: g.email,
        replyTo: RAFFLE_SHARED_INBOX,
        bcc: raffleOversightBcc_(test),
        name: 'The Stawasz Group',
        subject: (test ? QA_TEST_PREFIX : '') +
          (g.waiting.length === 1
            ? 'A nudge would do it — ' + String(g.waiting[0].referralName).split(' ')[0] +
              ' has not confirmed yet'
            : g.waiting.length + ' of your referrals have not confirmed yet'),
        htmlBody: raffleReferrerNudgeHtml_(g, minsLeft, test),
        body: raffleReferrerNudgePlain_(g, minsLeft)
      });
      sent++;
    } catch (err) {
      Logger.log('Referrer nudge failed for ' + g.email + ': ' + err);
    }
  });
  return sent;
}

function raffleReferrerNudgeHtml_(g, minsLeft, test) {
  var e = raffleEsc_;
  var first = String(g.name || '').split(' ')[0];
  var left = raffleTimeLeftPhrase_(minsLeft);
  var list = g.waiting.map(function (r) {
    return '<li style="margin:0 0 8px;"><b>' + e(r.referralName) + '</b> &mdash; ' +
           e(r.referralEmail) + '</li>';
  }).join('');
  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px;',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;",
    'color:#1d2b2c;line-height:1.55;">',
    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:16px;">QA TEST — not a real nudge</div>' : '',
    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;padding:24px;">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.8;">TSG BLOCK PARTY 2026</div>',
    '<div style="font-size:21px;font-weight:700;margin-top:6px;">',
    left + ' left &mdash; one text would do it</div>',
    '</div>',
    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;">',
    '<p style="margin:0 0 14px;">Hi ' + e(first) + ',</p>',
    '<p style="margin:0 0 14px;">We have emailed ',
    g.waiting.length === 1 ? 'the person you referred' : 'the people you referred',
    ' asking them to confirm, and ',
    g.waiting.length === 1 ? 'they have' : 'they have',
    ' not replied yet &mdash; so those bonus entries are not yours yet:</p>',
    '<ul style="margin:0 0 18px;padding-left:22px;font-size:15px;">' + list + '</ul>',
    '<div style="background:#FFF8E6;border:1px solid #F0DFAE;border-radius:8px;',
    'padding:16px;margin:0 0 18px;">',
    '<p style="margin:0;font-size:15px;color:#6B5720;">The winner is drawn at ',
    '<b>6:15 PM</b>. A text from you saying &ldquo;check your email, it takes twenty ',
    'seconds&rdquo; will do more than anything we can send.</p>',
    '</div>',
    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">You are already in the ',
    'drawing either way &mdash; this is only about the ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' extra entries ',
    'each confirmation is worth.</p>',
    '<p style="margin:0;font-size:14px;color:#55696a;">Nothing for you to do here &mdash; ',
    'the link is in their inbox, not yours. And if they would rather not, that is ',
    'genuinely fine; the same page lets them say so.</p>',
    '</div>',
    '<div style="text-align:center;padding:18px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower<br>',
    '728 S Broad St, Philadelphia, PA 19146 &middot; (215) 760-6291 &middot; info@tsg.homes',
    '</div></div></div>'
  ].join('');
}

function raffleReferrerNudgePlain_(g, minsLeft) {
  return [
    'Hi ' + String(g.name || '').split(' ')[0] + ',',
    '',
    raffleTimeLeftPhrase_(minsLeft) + ' left, and your bonus entries are not counted yet.',
    '',
    'We emailed these people asking them to confirm and have not heard back:',
    g.waiting.map(function (r) {
      return '  ' + r.referralName + ' - ' + r.referralEmail; }).join('\n'),
    '',
    'The winner is drawn at 6:15 PM. A text from you saying "check your email, it takes',
    'twenty seconds" will do more than anything we can send.',
    '',
    'You are already in the drawing either way - this is only about the ' + RAFFLE_BONUS_TICKETS_PER_REFERRAL +
      ' extra',
    'entries each confirmation is worth.',
    '',
    'Nothing for you to do here - the link is in their inbox, not yours. And if they',
    'would rather not, that is genuinely fine; the same page lets them say so.',
    '',
    'The Stawasz Group - Keller Williams Empower',
    '728 S Broad St, Philadelphia, PA 19146 - (215) 760-6291 - info@tsg.homes'
  ].join('\n');
}

// How long is left, in words a person reads rather than a number they decode.
function raffleTimeLeftPhrase_(minsLeft) {
  if (minsLeft <= 0) return 'any moment now';
  if (minsLeft < 90) return minsLeft + ' minutes';
  var hours = Math.round(minsLeft / 60);
  if (hours < 24) return 'about ' + hours + ' hours';
  return 'about a day';
}

function raffleReminderHtml_(r, url, minsLeft, test) {
  var e = raffleEsc_;
  var first = String(r.referralName || '').split(' ')[0];
  var left = raffleTimeLeftPhrase_(minsLeft);
  return [
    '<div style="margin:0;padding:0;background:#f4f6f6;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px;',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;',
    'color:#1d2b2c;line-height:1.55;">',

    test ? '<div style="background:#b3271e;color:#fff;font-weight:700;padding:10px 12px;' +
           'border-radius:6px;margin-bottom:16px;">QA TEST — not a real reminder</div>' : '',

    '<div style="background:#15464A;color:#fff;border-radius:10px 10px 0 0;padding:24px;">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.8;">THE STAWASZ GROUP</div>',
    '<div style="font-size:21px;font-weight:700;margin-top:6px;">',
    'One click and you are in the $300 drawing</div>',
    '</div>',

    '<div style="background:#fff;border-radius:0 0 10px 10px;padding:24px;">',
    '<p style="margin:0 0 14px;">Hi ' + e(first) + ',</p>',
    '<p style="margin:0 0 14px;">A few days ago <strong>' + e(r.name) + '</strong> referred ',
    'you to us, and we asked you to confirm your details. We have not heard back ',
    '&mdash; which is completely fine. It does mean you are not in our ' +
      e(RAFFLE_PRIZE_SHORT) + ' drawing, though, and neither are the ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' bonus entries you are worth to them. ',
    'Confirming takes about twenty seconds and enters you both.</p>',

    '<div style="background:#FFF8E6;border:1px solid #F0DFAE;border-radius:8px;',
    'padding:16px;margin:0 0 20px;">',
    '<p style="margin:0;font-size:15px;color:#6B5720;">',
    'The winner is drawn at <b>6:15 PM this Saturday</b> &mdash; ' + e(left) + ' from now. ',
    'After that those entries cannot be added, however kind you are about it.</p>',
    '</div>',

    '<div style="text-align:center;margin:0 0 20px;">',
    '<a href="' + e(url) + '" style="display:inline-block;background:#15464A;color:#fff;',
    'text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px;">',
    'Confirm my details</a></div>',

    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">It takes about twenty ',
    'seconds. You can correct anything they got wrong, and confirming is also how you ',
    'tell us it is alright to get in touch.</p>',
    '<p style="margin:0 0 14px;font-size:14px;color:#55696a;">',
    '<b>Would rather we did not?</b> The same page has a button for that, and we will ',
    'leave you alone. Either answer is better than none &mdash; and this is the only ',
    'reminder we will send.</p>',
    '<p style="margin:0;font-size:13px;color:#7d8f90;">If the button does not work, paste ',
    'this into your browser:<br><span style="word-break:break-all;">' + e(url) + '</span></p>',
    '</div>',

    '<div style="text-align:center;padding:18px 8px;font-size:12px;color:#7d8f90;">',
    'The Stawasz Group &middot; Keller Williams Empower<br>',
    '728 S Broad St, Philadelphia, PA 19146 &middot; (215) 760-6291 &middot; info@tsg.homes',
    '</div></div></div>'
  ].join('');
}

function raffleReminderPlain_(r, url, minsLeft) {
  var first = String(r.referralName || '').split(' ')[0];
  return [
    'Hi ' + first + ',',
    '',
    'A few days ago ' + r.name + ' referred you to us and we asked you to confirm your',
    'details. We have not heard back - which is completely fine. It does mean you are',
    'not in our ' + RAFFLE_PRIZE_SHORT + ' drawing, though, and neither are the ' +
      RAFFLE_BONUS_TICKETS_PER_REFERRAL + ' bonus entries',
    'you are worth to them. Confirming takes about twenty seconds and enters you both.',
    '',
    'The winner is drawn at 6:15 PM this Saturday - ' + raffleTimeLeftPhrase_(minsLeft) +
      ' from now.',
    'After that those entries cannot be added.',
    '',
    'Confirm your details here (about twenty seconds):',
    url,
    '',
    'You can correct anything they got wrong, and confirming is also how you tell us it',
    'is alright to get in touch. Would rather we did not? The same page has a button for',
    'that. Either answer is better than none - and this is the only reminder we will send.',
    '',
    'The Stawasz Group - Keller Williams Empower',
    '728 S Broad St, Philadelphia, PA 19146 - (215) 760-6291 - info@tsg.homes'
  ].join('\n');
}


// The entrant's own entry: one ticket, no referral, eligible straight away. Kept
// beside raffleAppendReferralEntry_ so the two row shapes stay legible together.
function raffleAppendSelfEntry_(name, email, phone, personId, test) {
  var sh = raffleSheet_(test);
  var row = [];
  row[RAFFLE_COL['Timestamp (ET)']]   = raffleFmt_(raffleNow_());
  row[RAFFLE_COL['Full Name']]        = raffleSafeCell_(name);
  row[RAFFLE_COL['Email']]            = raffleSafeCell_(email);
  row[RAFFLE_COL['Phone']]            = raffleSafeCell_(phone);
  row[RAFFLE_COL['Consent']]          = 'Yes';
  row[RAFFLE_COL['Consent Version']]  = RAFFLE_CONSENT_VERSION;
  row[RAFFLE_COL['Entry Source']]     = (test ? QA_TEST_PREFIX : '') + RAFFLE_EVENT_NAME +
                                        ' — own entry';
  row[RAFFLE_COL['FUB Status']]       = personId ? 'ok' : 'entrant push failed';
  row[RAFFLE_COL['FUB Person ID']]    = personId || '';
  row[RAFFLE_COL['Eligible']]         = 'Yes';
  row[RAFFLE_COL['Email Verified']]   = 'Yes (code confirmed)';
  // Eligible immediately: nothing is waiting on anybody else.
  row[RAFFLE_COL['Entry Status']]     = RAFFLE_STATUS_ELIGIBLE;
  for (var i = 0; i < RAFFLE_SHEET_HEADERS.length; i++) {
    if (row[i] === undefined) row[i] = '';
  }
  sh.appendRow(row);
  return { row: sh.getLastRow() };
}
