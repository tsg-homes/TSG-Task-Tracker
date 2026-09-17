// RaffleReferral.gs — referral-based entry for the TSG Block Party 2026 drawing
//
// Added 2026-09-17, per Durand. This replaces "fill in your details to enter"
// with "refer someone who is thinking of buying or selling in the next year,
// and your entry counts once THEY confirm".
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
    if (r.status === RAFFLE_STATUS_DECLINED || r.status === RAFFLE_STATUS_SUPERSEDED) continue;
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

  // Everything below is best-effort on top of a row that already exists.
  var fub = raffleReferralToFub_({
    entrant: entrant, refName: refName, refEmail: refEmail, refPhone: refPhone,
    role: role, timeframe: timeframe
  }, test);
  try { raffleRecordReferralFub_(appended.row, fub, test); }
  catch (recErr) { Logger.log('raffleRecordReferralFub_ failed: ' + recErr); }

  if (!fub.ok) {
    try {
      sendErrorAlert('Raffle: referral FUB write failed for ' + refName,
        'The raffle row IS saved (row ' + appended.row + ') and the consent link works, ' +
        'so the entry is not lost. Only the FUB write failed.\n\n' + fub.error);
    } catch (alertErr) { Logger.log('Raffle referral alert failed: ' + alertErr); }
  }

  return jsonOut({
    ok: true,
    staged: true,
    row: appended.row,
    token: token,
    referralName: refName,
    referralEmail: refEmail,
    message: 'Nearly there. Send ' + refName.split(' ')[0] + ' the confirmation email — ' +
             'your entry counts as soon as they confirm.'
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
  row[RAFFLE_COL['FUB Status']]       = 'pending';
  row[RAFFLE_COL['FUB Person ID']]    = '';
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

function raffleLinkPeople_(personId, relatedId, type, apiKey) {
  var res = raffleFubCall_('https://api.followupboss.com/v1/peopleRelationships', 'post', {
    personId: personId, relatedPersonId: relatedId, type: type
  }, apiKey);
  if (!res.ok) {
    Logger.log('raffleLinkPeople_: ' + personId + ' -> ' + relatedId + ' (' + type + ') ' +
      'returned ' + res.code + ': ' + String(res.text).slice(0, 200));
  }
  return res.ok;
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
    'The referrer entered the ' + RAFFLE_PRIZE_SHORT + ' drawing by naming this person.',
    'Their entry only counts once this person confirms their details and consents,',
    'so a confirmation email has been sent here.',
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
  var subject = (test ? QA_TEST_PREFIX : '') + entrant.name +
    ' referred you to The Stawasz Group';

  MailApp.sendEmail({
    to: found.entry.referralEmail,
    cc: [entrant.email, 'info@tsg.homes'].join(','),
    replyTo: entrant.email,
    name: 'The Stawasz Group',
    subject: subject,
    htmlBody: raffleInviteHtml_(entrant, found.entry, url, test),
    body: raffleInvitePlain_(entrant, found.entry, url)   // for text-only clients
  });

  raffleSheet_(found.test).getRange(found.row, RAFFLE_COL['Referral Emailed At'] + 1)
    .setValue(raffleFmt_(raffleNow_()));

  return jsonOut({ ok: true, sent: true,
    message: 'Sent to ' + found.entry.referralEmail + ' (copied to you). ' +
             'Your entry counts as soon as they confirm.' });
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
    e(String(entry.referralRole || '').toLowerCase()) + ' in the next year.</p>',
    '<p style="margin:0 0 18px;">Here is what they gave us. If it is right, confirm below. ',
    'If something is wrong, you can fix it on the same page.</p>',
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
    'One more thing: ' + e(String(entrant.name).split(' ')[0]) + ' is entered in our ',
    e(RAFFLE_PRIZE_SHORT) + ' drawing, and their entry only counts once you confirm. ',
    'No pressure — but that is why they are copied on this.</p>',
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
      String(entry.referralRole || '').toLowerCase() + ' in the next year.',
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
    'Confirming also gives us your permission to get in touch. Nothing happens until',
    'you do -- if you would rather we did not, just ignore this email.',
    '',
    String(entrant.name).split(' ')[0] + ' is entered in our ' + RAFFLE_PRIZE_SHORT +
      ' drawing, and their entry only counts once you confirm.',
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

  var body = [
    '<h2 style="margin:0 0 6px">' + esc(entry.name) + ' referred you to us</h2>',
    '<p style="color:#55696a;margin:0 0 20px">Check that this is right, fix anything that ',
    'is not, and confirm at the bottom. It takes about twenty seconds.</p>',
    '<form id="f" onsubmit="return false">',
    '<label>Full name<input id="rName" value="' + esc(entry.referralName) + '"></label>',
    '<label>Email<input id="rEmail" type="email" value="' + esc(entry.referralEmail) + '"></label>',
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
    '<label class="check"><input type="checkbox" id="consent">',
    '<span>I confirm these details are mine, and I give The Stawasz Group ',
    '(Keller Williams Empower) permission to contact me by phone, text and email — ',
    'including autodialed or prerecorded calls and texts — about real estate services. ',
    'Consent is not a condition of any purchase. Message and data rates may apply. ',
    'I can opt out at any time by replying STOP or emailing info@tsg.homes.</span></label>',
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
      sh.getRange(found.row, RAFFLE_COL['Eligible'] + 1).setValue('No');
      raffleMarkDeclinedInFub_(entry, found.test);
      return jsonOut({ ok: true, declined: true,
        message: 'Understood — we will not contact you. Sorry for the interruption.' });
    }

    var name  = collapseSpaces(d.referralName);
    if (!name || name.indexOf(' ') === -1) {
      throw makeValidationError('Please give your first and last name.');
    }
    var email  = raffleRejectJunkEmail_(d.referralEmail);
    var phone  = collapseSpaces(d.referralPhone);
    var digits = raffleRejectJunkPhone_(d.referralPhone);
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
                   'this one does not count toward the drawing, but we have your details.' });
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
    sh.getRange(found.row, RAFFLE_COL['Referral Consent At'] + 1).setValue(now);
    // Consent after the draw still updates FUB, but it cannot retroactively
    // create an entry in a drawing that has already happened.
    sh.getRange(found.row, RAFFLE_COL['Entry Status'] + 1)
      .setValue(closed ? RAFFLE_STATUS_SUPERSEDED : RAFFLE_STATUS_ELIGIBLE);

    raffleUpdateReferralInFub_(entry, { name: name, email: email, phone: phone,
                                        role: role, timeframe: timeframe }, found.test);
    raffleNotifyEntrantEntered_(entry, name, found.test, closed);

    return jsonOut({ ok: true, confirmed: true, closed: closed,
      message: closed
        ? 'Thank you — you are confirmed and someone will be in touch. The drawing has ' +
          'already taken place, so this one came in after the close.'
        : 'Thank you — you are confirmed, and ' + String(entry.name).split(' ')[0] +
          "'s entry now counts." });
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) { /* non-fatal */ }
  }
}

// ---------- FUB writes triggered by the referral's own answer ----------
// The referral record already exists (created at submit time, with consent
// recorded as NOT GIVEN). This is the update that turns it into a contact the
// team is actually allowed to work.
function raffleUpdateReferralInFub_(entry, edited, test) {
  var apiKey = raffleFubKey_();
  if (!apiKey) return;
  var personId = entry.referralFubId;
  if (!personId) {
    // The submit-time create failed. Create now rather than losing a consented
    // lead -- this is the one case where a consented person has no record.
    var parts = splitName(edited.name);
    var payload = {
      firstName: parts.first, lastName: parts.last,
      source: RAFFLE_SOURCE + ' (referral)',
      tags: RAFFLE_REFERRAL_TAGS.concat([edited.role, 'Consented']),
      emails: [{ value: edited.email, type: 'home' }],
      phones: edited.phone ? [{ value: edited.phone, type: 'mobile' }] : []
    };
    applyQaTestPersonMarking_(payload);
    var created = raffleFubCall_('https://api.followupboss.com/v1/people', 'post', payload, apiKey);
    personId = created.ok && created.body && created.body.id;
    if (!personId) {
      Logger.log('raffleUpdateReferralInFub_: no person to update and create failed.');
      return;
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

  raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
    personId: personId,
    subject: (test ? QA_TEST_PREFIX : '') + 'Confirmed their details and consented',
    body: [
      'This person opened the referral link and confirmed their own details.',
      '',
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
}

// A decline is recorded loudly, because the cost of missing it is calling
// somebody who explicitly said no.
function raffleMarkDeclinedInFub_(entry, test) {
  var apiKey = raffleFubKey_();
  if (!apiKey || !entry.referralFubId) return;
  raffleFubCall_('https://api.followupboss.com/v1/people/' + entry.referralFubId, 'put', {
    tags: ['Do Not Contact', 'Referral Declined', 'Block Party 2026']
  }, apiKey);
  raffleFubCall_('https://api.followupboss.com/v1/notes', 'post', {
    personId: entry.referralFubId,
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
}

// Tells the entrant their entry has landed. This matters more than it looks:
// they were told at the party that their entry depends on someone else, and
// without this they have no way to know whether it ever happened.
function raffleNotifyEntrantEntered_(entry, referralName, test, closed) {
  try {
    MailApp.sendEmail({
      to: entry.email,
      name: 'The Stawasz Group',
      subject: (test ? QA_TEST_PREFIX : '') +
        (closed ? 'Your referral confirmed (after the drawing closed)'
                : 'You are entered — ' + referralName + ' confirmed'),
      body: [
        (closed
          ? referralName + ' confirmed their details, but it came in after entries closed at ' +
            '6:15 PM, so it did not make the drawing. Thank you for the referral all the same —'
          : referralName + ' confirmed their details, so your entry in the ' +
            RAFFLE_PRIZE_SHORT + ' drawing now counts.'),
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
}
