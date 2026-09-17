const TRACKER_FOLDER_ID = '1PEyP4X_k1TxOfqZeGSbHyyaM8K64GwQ-';
const INBOX_FOLDER_ID = '1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi';

// File IDs, not names — renaming these files in Drive will never break lookup again.
const OWNER_EMAIL = 'durand@thestawaszgroup.com';

// Access mode (2026-09-14). MUST agree with appsscript.json webapp.access — a test checks.
//   'ANONYMOUS': anyone with the URL; identity calls are forbidden (they abort the request).
//   'DOMAIN':    only signed-in TSG Workspace accounts; every request carries an identity,
//                the owner gets the full dashboard, everyone else a per-person view.
const TSG_ACCESS_MODE = 'DOMAIN';
// Both spellings are the same Workspace organization (tsg.homes is an alias domain).
const TSG_DOMAINS = ['thestawaszgroup.com', 'tsg.homes'];

// Deployed-code version stamp (2026-09-14). Apps Script exposes no deployment/version
// number at runtime, so this is the only way to tell from the browser which Code.gs is
// actually serving. BUMP IT ON EVERY DEPLOY (date + counter). It is returned by
// ?api=version and stamped into the dashboard footer by the bare doGet below.
const TSG_CODE_VERSION = '2026-09-17.5';

const FILE_IDS = {
  // html: '1gvrLx4RcVh3mrnVOeiD5ExSbK9mKUnkv' — "Systems — Task Tracker Dashboard", RETIRED
  // 2026-09-14: the dashboard now lives in this script project (dashboard_final.html) and
  // is served by doGet from there. The Drive file is kept only as a historical copy.
  data: '1SRdNiNhHdAfaB-agj9OcXRIPA5xNLidt',     // Systems — Task Tracker Data.json
  rulesets: '1RKkNUEfh6Q0qlQXbNlME7aIfh_h8FE-R'  // Systems — Task Tracker Rulesets.json
};

function getTrackerFile_(key) {
  const id = FILE_IDS[key];
  if (!id) throw new Error('Unknown tracker file key: ' + key);
  try {
    return DriveApp.getFileById(id);
  } catch (err) {
    throw new Error('Tracker file not found for key "' + key + '" (id ' + id + '): ' + err.message);
  }
}

/**
 * ============================================================================
 * SINGLE-WRITER GUARANTEE — added 2026-08-26
 *
 * This function, and only this function, ever calls setContent() on the data or
 * rulesets file. As of this change, doPost()'s target=data handler no longer writes
 * directly either — it drops a "replace_all" patch into the same _Inbox folder every
 * other data write goes through, then calls processInbox_() immediately. That closes
 * the original data-loss bug: the dashboard's own full-document save and an _Inbox
 * patch used to be two unlocked, uncoordinated writers racing for the same file, and
 * whichever landed second silently won. Now every write — dashboard or patch — is
 * serialized under the same lock and checked against the same version counter
 * (doc.meta.docVersion, bumped in applyDataPatch_ on every successful mutation), so a
 * stale full-document save is rejected instead of clobbering newer data.
 *
 * 2026-09-02: target=rulesets now takes the same route. It had been left on the direct
 * setContent() path on the reasoning that "rulesets isn't edited from two uncoordinated
 * places the way task data was" — which stopped being true once Claude sessions began
 * pushing threads/current patches into _Inbox alongside the dashboard's own Settings
 * save. Rulesets therefore has its own meta.docVersion counter (see applyRulesetPatch_)
 * with the same conflict semantics. Only 'html' still writes directly, and it still has
 * exactly one writer.
 * ============================================================================
 */
function processInbox_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('[inbox] lock busy after 10s; this pass skipped, patches stay queued');
    return { ok: false, busy: true, applied: 0 };
  }
  try {
    const inbox = DriveApp.getFolderById(INBOX_FOLDER_ID);
    const it = inbox.getFiles();
    const patches = [];
    while (it.hasNext()) {
      const f = it.next();
      if (f.isTrashed()) continue;
      try {
        patches.push({ file: f, patch: JSON.parse(f.getBlob().getDataAsString()), created: f.getDateCreated() });
      } catch (err) {
        Logger.log('[inbox] malformed patch file "' + f.getName() + '" trashed: ' + err);
        try { f.setName('MALFORMED-' + f.getName()); } catch (e2) {}
        f.setTrashed(true);
      }
    }
    if (patches.length === 0) {
      tsgCachePut_('inboxEmptyUntil', '1', TSG_INBOX_EMPTY_TTL_SEC);
      return { ok: true, applied: 0 };
    }
    patches.sort(function(a, b) { return a.created - b.created; });

    // Load each target document ONCE, outside the per-patch try. An unreadable document
    // leaves every patch queued and says so in the log; it never trashes them.
    let rulesetsDoc = null, rulesetsFile = null, dataDoc = null, dataFile = null;
    try {
      if (patches.some(function(p) { return p.patch && p.patch.target === 'rulesets'; })) {
        rulesetsFile = getTrackerFile_('rulesets');
        rulesetsDoc = JSON.parse(rulesetsFile.getBlob().getDataAsString());
      }
      if (patches.some(function(p) { return p.patch && p.patch.target === 'data'; })) {
        dataFile = getTrackerFile_('data');
        dataDoc = JSON.parse(dataFile.getBlob().getDataAsString());
      }
    } catch (loadErr) {
      Logger.log('[inbox] cannot load a target document; ' + patches.length + ' patch(es) left queued: ' + loadErr);
      return { ok: false, error: String(loadErr), applied: 0 };
    }

    const applied = [], failed = [];
    patches.forEach(function(p) {
      const patch = p.patch;
      try {
        if (patch.target === 'rulesets') applyRulesetPatch_(rulesetsDoc, patch);
        else if (patch.target === 'data') applyDataPatch_(dataDoc, patch);
        else throw new Error('unknown target: ' + patch.target);
        applied.push(p);
      } catch (err) {
        Logger.log('[inbox] patch "' + p.file.getName() + '" failed and was dropped: ' + err);
        failed.push(p);
      }
    });

    if (rulesetsDoc && applied.some(function(p) { return p.patch.target === 'rulesets'; })) {
      const rsJson = JSON.stringify(rulesetsDoc);
      rulesetsFile.setContent(rsJson);
      try { backupTrackerFile_('rulesets', rsJson); }
      catch (backupErr) { Logger.log('Backup snapshot failed for rulesets: ' + backupErr); }
    }
    if (dataDoc && applied.some(function(p) { return p.patch.target === 'data'; })) {
      tsgAutoScheduleDoc_(dataDoc);
      var hb = tsgCurrentHeartbeat_();
      if (hb) { dataDoc.meta = dataDoc.meta || {}; dataDoc.meta.lastLiveHeartbeat = hb; }
      const dataJson = JSON.stringify(dataDoc);
      dataFile.setContent(dataJson);
      tsgCachePut_('docVersion', String(dataDoc.meta && dataDoc.meta.docVersion), 21600);
      try { backupTrackerFile_('data', dataJson); }
      catch (backupErr) { Logger.log('Backup snapshot failed for data: ' + backupErr); }
    }
    // Trash only now, after the writes succeeded. A write that throws leaves every file in
    // place for the next pass: at-least-once, never silently lost.
    applied.forEach(function(p) { p.file.setTrashed(true); });
    failed.forEach(function(p) { try { p.file.setName('FAILED-' + p.file.getName()); } catch (e2) {} p.file.setTrashed(true); });
    return { ok: true, applied: applied.length, failed: failed.length };
  } finally {
    lock.releaseLock();
  }
}

// Script-cache helpers: every call is best-effort, the cache is an optimization only.
var TSG_INBOX_EMPTY_TTL_SEC = 50;
function tsgCachePut_(k, v, ttlSec) { try { CacheService.getScriptCache().put(k, v, ttlSec); } catch (err) {} }
function tsgCacheGet_(k) { try { return CacheService.getScriptCache().get(k); } catch (err) { return null; } }
function tsgCacheRemove_(k) { try { CacheService.getScriptCache().remove(k); } catch (err) {} }

/**
 * Thread names are used as object keys, so a few JS-reserved ones can never be honest
 * own-properties: threads['__proto__'] = {...} assigns to the prototype and silently
 * creates nothing, and threads['constructor'] reads back truthy from Object.prototype
 * even when no such thread exists. Rather than special-case the storage, reject these
 * names outright with a clear error — a thread called "__proto__" is not a real use case,
 * and a loud refusal beats a silent no-op (2026-09-02).
 */
var TSG_RESERVED_THREAD_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
function tsgAssertSafeThreadName_(op, name) {
  var n = String(name == null ? '' : name);
  if (!n) throw new Error(op + ': thread name is required');
  if (TSG_RESERVED_THREAD_KEYS[n]) {
    throw new Error(op + ': "' + n + '" is a reserved JavaScript object key and cannot be used as a thread name. Rename the thread.');
  }
  return n;
}
/** Own-property existence check — never walks the prototype chain (see above). */
function tsgHasThread_(doc, name) {
  return Object.prototype.hasOwnProperty.call(doc.threads, String(name));
}

/**
 * RULESETS VERSIONING (2026-09-02) — meta.docVersion.
 *
 * The Rulesets document had no version check whatsoever: target=rulesets was a blind
 * whole-document overwrite. It now has two genuinely uncoordinated writers (the
 * dashboard's Settings UI, and Claude sessions pushing threads/current patches through
 * _Inbox), so a stale Settings save could silently erase a memory pushed thirty seconds
 * earlier. This wrapper gives the document the same counter + conflict semantics the data
 * document already has.
 *
 * meta.docVersion is a MONOTONIC WRITE COUNTER for conflict detection. It is NOT
 * meta.version, which stays exactly what it always was: a static schema version (1).
 * Existing documents with no docVersion start at 1.
 */
function applyRulesetPatch_(doc, patch) {
  if (!doc.meta) doc.meta = {};
  if (typeof doc.meta.docVersion !== 'number') doc.meta.docVersion = 1;
  if (!doc.threads) doc.threads = {};

  if (patch.op === 'replace_all') {
    // Whole-document save from the dashboard's Settings UI, submitted as a patch like
    // everything else instead of written straight to disk. Only applied if nothing has
    // changed server-side since the client loaded the version it's saving against;
    // otherwise a full snapshot would silently erase whatever changed in between. A
    // rejection is recorded, not thrown, so it doesn't jam the rest of the batch — the
    // client reads it back by nonce (see doPost's target=rulesets handler) and surfaces
    // a conflict error to the user.
    const rsNow = patch.ts || new Date().toISOString();
    const currentVersion = doc.meta.docVersion;
    if (typeof patch.baseVersion !== 'number' || patch.baseVersion !== currentVersion) {
      doc.meta.rejectedSaves = doc.meta.rejectedSaves || [];
      doc.meta.rejectedSaves.push({ ts: rsNow, nonce: patch.nonce || null, reason: (typeof patch.baseVersion !== 'number') ? 'missing_baseVersion' : 'stale_version', baseVersion: patch.baseVersion, currentVersion: currentVersion });
      if (doc.meta.rejectedSaves.length > 20) doc.meta.rejectedSaves = doc.meta.rejectedSaves.slice(-20);
      return; // no mutation, no version bump — this save did not happen
    }
    const incoming = patch.doc || {};
    if (incoming.current) doc.current = incoming.current;
    if (incoming.threads) doc.threads = incoming.threads;
    if (Array.isArray(incoming.history)) doc.history = incoming.history;
    // meta stays server-owned apart from the descriptive fields — in particular
    // docVersion is never taken from the client, and meta.version (the static schema
    // version) is left alone unless the client explicitly restates it.
    const metaIn = incoming.meta || {};
    ['version', 'created', 'owner'].forEach(function(k) {
      if (Object.prototype.hasOwnProperty.call(metaIn, k)) doc.meta[k] = metaIn[k];
    });
    doc.meta.last_updated = rsNow.slice(0, 10);
    doc.meta.docVersion = currentVersion + 1;
    return;
  }

  applyRulesetPatchOp_(doc, patch);
  doc.meta.docVersion = doc.meta.docVersion + 1;
}

function applyRulesetPatchOp_(doc, patch) {
  const now = patch.ts || new Date().toISOString();
  if (!doc.threads) doc.threads = {};

  if (patch.op === 'append_category') {
    doc.current[patch.category].content += '\n\n' + patch.text;
    doc.current[patch.category].pushed = now;
  } else if (patch.op === 'replace_category_text') {
    const cur = doc.current[patch.category].content;
    if (cur.indexOf(patch.find) === -1) throw new Error('replace_category_text: find text not present');
    doc.current[patch.category].content = cur.split(patch.find).join(patch.replace);
    doc.current[patch.category].pushed = now;
  } else if (patch.op === 'set_category') {
    doc.current[patch.category].content = patch.text;
    doc.current[patch.category].pushed = now;

  } else if (patch.op === 'add_thread') {
    // Reserved-key guard + own-property existence check — see tsgAssertSafeThreadName_.
    const addName = tsgAssertSafeThreadName_('add_thread', patch.name);
    if (tsgHasThread_(doc, addName)) throw new Error('add_thread: thread already exists: ' + addName);
    doc.threads[addName] = {
      instructions: patch.instructions || '',
      memories: patch.memories || [],
      history: [{ ts: now, action: 'baseline', summary: (patch.historyEntry && patch.historyEntry.summary) || 'Thread added.' }]
    };
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (patch.op === 'update_thread_instructions') {
    if (!tsgHasThread_(doc, patch.name)) throw new Error('update_thread_instructions: thread not found: ' + patch.name);
    doc.threads[patch.name].instructions = patch.instructions || '';
    doc.threads[patch.name].history.push({
      ts: now,
      action: (patch.historyEntry && patch.historyEntry.action) || 'update',
      summary: (patch.historyEntry && patch.historyEntry.summary) || 'Instructions updated.'
    });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (patch.op === 'add_thread_memory') {
    if (!tsgHasThread_(doc, patch.name)) throw new Error('add_thread_memory: thread not found: ' + patch.name);
    doc.threads[patch.name].memories.push(patch.memory);
    doc.threads[patch.name].history.push({
      ts: now,
      action: (patch.historyEntry && patch.historyEntry.action) || 'update',
      summary: (patch.historyEntry && patch.historyEntry.summary) || ('Memory added: "' + patch.memory + '"')
    });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (patch.op === 'remove_thread_memory') {
    if (!tsgHasThread_(doc, patch.name)) throw new Error('remove_thread_memory: thread not found: ' + patch.name);
    if (typeof patch.index !== 'number' || patch.index < 0) throw new Error('remove_thread_memory: index must be a non-negative number');
    doc.threads[patch.name].memories.splice(patch.index, 1);
    doc.threads[patch.name].history.push({
      ts: now,
      action: (patch.historyEntry && patch.historyEntry.action) || 'update',
      summary: (patch.historyEntry && patch.historyEntry.summary) || 'Memory removed.'
    });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (patch.op === 'remove_thread') {
    delete doc.threads[patch.name];
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else {
    throw new Error('Unknown ruleset patch op: ' + patch.op);
  }

  doc.meta.last_updated = now.slice(0, 10);
  if (patch.historyEntry) doc.history.push(Object.assign({ ts: now }, patch.historyEntry));
}

// ---------------------------------------------------------------------------------------
// Judgment queue (2026-09-16, per Durand: "i dont have a claude api" -> "use method 2 to
// bypass the need for a key"). With no ANTHROPIC_API_KEY, every judgment the script would
// have asked Claude for (a new task's estimate/type/subitems/priority/group/dependency/tags/
// progress plus its Drive and calendar matches, a notes-progress read, a Tidy rewrite) is
// written to doc.meta.judgments instead of being dropped. A scheduled Claude Code Routine
// (hourly on weekdays) reads the data file, answers each request under its own judgment,
// and sends {target:'data', op:'judgment', id, answer} inbox ops; applyDataPatch_ applies an
// answer through the SAME field logic the live path uses (tsgApplyEstimateToTask_,
// tsgSetProgressFromNotes_, tsgTidyValidate_) and removes the request. The queue is
// server-owned: replace_all and set_meta never write it. Request shapes are documented in
// README "Judgment queue". Nothing here runs when a key IS set: then the live call happens.
// ---------------------------------------------------------------------------------------
var TSG_JUDGMENT_QUEUE_CAP = 200;
var TSG_CURRENT_DOC = null; // the document applyDataPatch_ is working on, for queueing from deep helpers
function tsgJudgmentMode_() { return !tsgApiKey_(); }
function tsgQueueJudgment_(doc, req) {
  if (!doc || !req || req.taskId == null) return null;
  doc.meta = doc.meta || {};
  var q = Array.isArray(doc.meta.judgments) ? doc.meta.judgments : [];
  var sub = (req.subIdx == null) ? null : req.subIdx;
  // One pending request per kind + target: a newer one replaces the older.
  q = q.filter(function(r) { return !(r && r.kind === req.kind && r.taskId === req.taskId && ((r.subIdx == null) ? null : r.subIdx) === sub); });
  doc.meta.judgmentSeq = (doc.meta.judgmentSeq || 0) + 1;
  req.id = 'J' + doc.meta.judgmentSeq;
  req.ts = new Date().toISOString();
  q.push(req);
  if (q.length > TSG_JUDGMENT_QUEUE_CAP) q = q.slice(-TSG_JUDGMENT_QUEUE_CAP);
  doc.meta.judgments = q;
  return req.id;
}
/** Applies one answered request. Unknown / superseded ids are logged and ignored. */
function tsgApplyJudgmentOp_(doc, patch, now) {
  doc.meta = doc.meta || {};
  var q = Array.isArray(doc.meta.judgments) ? doc.meta.judgments : [];
  var req = q.filter(function(r) { return r && r.id === patch.id; })[0];
  doc.meta.judgments = q.filter(function(r) { return !(r && r.id === patch.id); });
  if (!req) { Logger.log('[judgment] unknown id ' + patch.id + ' (already applied or superseded)'); return; }
  var answer = patch.answer;
  if (!answer || typeof answer !== 'object') { Logger.log('[judgment] ' + req.id + ' dropped: no answer'); return; }
  var source = patch.source || 'Claude';
  var t = (doc.tasks || []).filter(function(x) { return x && x.id === req.taskId; })[0];
  if (!t) { Logger.log('[judgment] ' + req.id + ': task #' + req.taskId + ' no longer exists'); return; }
  if (req.kind === 'enrich' || req.kind === 'estimate' || req.kind === 'tidy') {
    var target = t;
    if (req.subIdx != null) {
      // A subtask: by index, falling back to its title if the list was reordered meanwhile.
      target = (t.subitems || [])[req.subIdx] || null;
      if (!target || (req.subTitle && String(target.title || '') !== String(req.subTitle))) {
        target = (t.subitems || []).filter(function(s) { return s && req.subTitle && String(s.title || '') === String(req.subTitle); })[0] || null;
      }
      if (!target) { Logger.log('[judgment] ' + req.id + ': subtask no longer found on #' + t.id); return; }
    }
    var need = req.need || ['title', 'notes', 'priority', 'taskType', 'group', 'estHours', 'tags'];
    var est = tsgEstimateParse_(JSON.stringify(answer), need, target.title, {
      driveCandidateCount: (req.driveCandidates || []).length, calendarCandidateCount: (req.calendarCandidates || []).length, mailCandidateCount: (req.mailCandidates || []).length });
    if (est.source === 'none') return;
    tsgApplyEstimateToTask_(doc, target, est, need, {
      now: now, source: source, personCreated: !!req.personCreated, batchSiblings: req.batchSiblings || [],
      driveCands: req.driveCandidates ? { files: req.driveCandidates } : null,
      calCands: req.calendarCandidates ? { events: req.calendarCandidates } : null,
      mailCands: req.mailCandidates ? { threads: req.mailCandidates } : null,
      currentSteps: req.currentSteps || null,
      deferred: true, sinceTs: req.ts || null, reqNotes: req.notes, force: !!req.force,
      subitem: req.subIdx != null, parent: t
    });
  } else if (req.kind === 'progress') {
    var item = (req.subIdx == null) ? t : ((t.subitems || [])[req.subIdx] || null);
    if (!item) return;
    if (String(item.notes || '').trim() !== String(req.notes || '').trim()) { Logger.log('[judgment] ' + req.id + ' stale: notes changed since it was queued'); return; }
    var status = item.done ? 'Done' : (item.status || 'Not Started');
    if (status === 'Done') return;
    if (typeof answer.progress !== 'number' || !isFinite(answer.progress)) return;
    var pct = Math.max(0, Math.min(100, Math.round(answer.progress)));
    var prev = item.progress;
    tsgSetProgressFromNotes_(item, pct);
    var hist = (req.subIdx == null) ? (t.history = t.history || []) : (item.history = item.history || []);
    hist.push({ ts: now, field: 'progress', from: (typeof prev === 'number') ? prev : null, to: pct, source: source });
  } else {
    Logger.log('[judgment] ' + req.id + ': unknown kind ' + req.kind);
  }
}

function applyDataPatch_(doc, patch) {
  const now = patch.ts || new Date().toISOString();
  TSG_CURRENT_DOC = doc;

  if (patch.op === 'bulk') {
    // 2026-09-10 per Durand: dependsOnTitle inference should see every task in this same
    // batch, not just ones already applied earlier in it — otherwise a task listed FIRST
    // that actually depends on one listed LATER in the same push could never detect that
    // dependency (its estimator call runs before the later sibling exists in doc.tasks).
    // Titles are pre-cleaned here (tsgCleanTitle_) so they match what'll actually land in
    // doc.tasks once each sibling is processed, not its raw pre-cleanup form.
    var batchTitles = (patch.ops || [])
      .filter(function(sub) { return sub && sub.op === 'add_task' && sub.task && sub.task.title; })
      .map(function(sub) { return tsgCleanTitle_(sub.task.title); });
    // Board context computed ONCE per push so every sibling's estimator call carries the
    // identical (prompt-cached) block — see tsgEstimatePrompt_.
    var batchContext = tsgBoardContext_(doc);
    (patch.ops || []).forEach(function(sub) {
      // A bulk envelope's own top-level source (if any) applies to every sub-op unless
      // that sub-op sets its own — Object.assign's key ordering means `sub`'s own
      // `source`, if present, wins over the spread-in default.
      var subPatch = Object.assign({ ts: now, source: patch.source }, sub);
      if (subPatch.op === 'add_task') { subPatch.__batchSiblingTitles = batchTitles; subPatch.__batchContext = batchContext; }
      applyDataPatch_(doc, subPatch);
    });
    // Knowing the right title isn't enough on its own when it belongs to a sibling added
    // LATER in this same batch — that sibling doesn't have an id yet at the moment its
    // earlier dependent was processed, so add_task below stashes a '~title:' placeholder
    // instead of silently dropping the dependency. Now that every op in the batch has run,
    // every real task has a real id — resolve every placeholder in one final pass. Anything
    // that still can't resolve (e.g. the referenced task got deduped/merged away instead of
    // added as its own task) is cleared rather than left with a placeholder string sitting
    // in a field everything else expects to be a numeric id or empty.
    (doc.tasks || []).forEach(function(t) {
      if (typeof t.depends === 'string' && t.depends.indexOf('~title:') === 0) {
        var wantTitle = t.depends.slice(7);
        var resolved = doc.tasks.find(function(x) { return x.title === wantTitle; });
        t.depends = resolved ? String(resolved.id) : '';
      }
    });
    doc.meta.last_updated = now;
    return;
  }

  if (patch.op === 'add_task') {
    const task = patch.task;
    // 2026-09-09 per Durand: standardize title formatting on the way in, before dedup
    // matching even runs (tsgClassifyIncoming_ already normalizes case for matching, so
    // this doesn't change match behavior either way). originalTitleForCleanup is only
    // used below, if this turns out to be a genuinely new task, to log what changed.
    var originalTitleForCleanup = task.title;
    if (task.title) task.title = tsgCleanTitle_(task.title);
    // Every new task is run past the same classifier tsgSweepDuplicates
    // already use (tsgClassifyIncoming_), before it's allowed onto the board — added
    // 2026-08-26 so a duplicate is caught at the door instead of needing a sweep to
    // clean it up after the fact:
    //   exact title match, or matches an existing SUBITEM's title  -> true duplicate.
    //     Nothing added; the attempt is logged onto the matching task so it's never
    //     silently lost, but the board doesn't get a redundant entry.
    //   near-duplicate title (fuzzy match, not exact)  -> treated as an update to that
    //     same task: incoming notes/tags/due-date/doc-link fold into the existing task
    //     instead of spawning a near-copy of it.
    //   same topic, different wording ("flag" tier)  -> related but distinct enough to
    //     keep separate: merged in as a new subitem of the matched task rather than a
    //     new top-level entry, fragmenting the board.
    //   no match  -> genuinely new, added normally.
    // Set patch.skipDedup: true to bypass this and force a plain add (escape hatch for
    // a false positive — tsgTestDedup() showed 0 false positives on the live board as
    // of this change, but titles evolve).
    const verdict = patch.skipDedup ? { verdict: 'new' } : tsgClassifyIncoming_(task.title, doc.tasks);
    let addResult;

    if (verdict.verdict === 'skip' && (verdict.reason === 'exact title' || verdict.reason === 'subitem')) {
      // 2026-09-09 per Durand: an EXACT match used to just suppress the push and log a
      // text line — any updated notes/due-date/tags/docs on the incoming push were
      // silently thrown away, unlike the near-duplicate ('title'/'subitem' fuzzy) branch
      // just below, which already merges those in. That was backwards: an exact-title
      // re-push is the MOST likely to be a genuine update to the same real task, not
      // less. Now merges the same way, into whichever object actually matched — the
      // task itself for an 'exact title' hit, or the specific matching SUBITEM (not the
      // parent task's own fields) for a 'subitem' hit, since those are different real
      // things and a subitem-level update shouldn't leak onto the parent's due date/notes.
      const match = verdict.task;
      const target = (verdict.reason === 'subitem')
        ? (match.subitems || []).find(function(s) { return s && s.title === verdict.via; })
        : match;
      if (target) {
        if (task.notes && task.notes.trim() && target.notes !== task.notes) {
          target.notes = (target.notes ? target.notes + '\n\n' : '') + '[Auto-merged update ' + now.slice(0, 10) + '] ' + task.notes;
        }
        if (!target.doc && task.doc) target.doc = task.doc;
        if (!target.timelineEnd && task.timelineEnd) target.timelineEnd = task.timelineEnd;
        if (task.tags && task.tags.length) {
          target.tags = Array.from(new Set((target.tags || []).concat(task.tags)));
        }
        if (task.docs && task.docs.length) {
          target.docs = (target.docs || []).concat(task.docs);
        }
      }
      match.history = match.history || [];
      match.history.push({
        ts: now, field: 'duplicate-push-merged', from: null,
        to: task.title + (task.notes ? ' — ' + task.notes : '') +
            ' (matched via ' + verdict.reason + ': "' + verdict.via + '" — updated fields merged in, not discarded)'
      });
      addResult = { verdict: 'duplicate', matchedTaskId: match.id, title: task.title };
    } else if (verdict.verdict === 'skip') {
      const match = verdict.task;
      if (task.notes && task.notes.trim() && match.notes !== task.notes) {
        match.notes = (match.notes ? match.notes + '\n\n' : '') + '[Auto-merged update ' + now.slice(0, 10) + '] ' + task.notes;
      }
      if (!match.doc && task.doc) match.doc = task.doc;
      if (!match.timelineEnd && task.timelineEnd) match.timelineEnd = task.timelineEnd;
      if (task.tags && task.tags.length) {
        match.tags = Array.from(new Set((match.tags || []).concat(task.tags)));
      }
      match.history = match.history || [];
      match.history.push({
        ts: now, field: 'auto-merged-update', from: null,
        to: 'Folded a near-duplicate push into this task instead of creating a new one (' +
            Math.round(verdict.score * 100) + '% title match): "' + task.title + '"'
      });
      addResult = { verdict: 'merged-update', matchedTaskId: match.id, title: task.title };
    } else if (verdict.verdict === 'flag') {
      const match = verdict.task;
      match.subitems = match.subitems || [];
      match.subitems.push({
        title: task.title, done: false, delegate: task.owner || '', status: task.status || 'Not Started',
        priority: task.priority || match.priority || 'Medium', tags: task.tags || [],
        timelineEnd: task.timelineEnd || '', progress: 0, depends: '', doc: task.doc || '',
        notes: task.notes || '', estHours: null, estDays: null, estSource: 'none',
        taskType: task.taskType || 'Actionable Task',
        history: [{ ts: now, field: 'created', from: null, to: null, source: patch.source || 'unknown' }]
      });
      match.history = match.history || [];
      match.history.push({
        ts: now, field: 'auto-merged-subitem', from: null,
        to: 'Merged as a related subitem (' + Math.round(verdict.score * 100) + '% match on "' +
            verdict.via + '"): "' + task.title + '"'
      });
      var mergedSub = match.subitems[match.subitems.length - 1];
      if (!patch.personCreated && tsgIsDelegatePerson_(mergedSub.delegate)) {
        tsgHoldForReview_(mergedSub, match.history, now, 'Merged subitem "' + task.title + '" held off ' + mergedSub.delegate + "'s view until reviewed");
      }
      addResult = { verdict: 'merged-subitem', matchedTaskId: match.id, title: task.title };
    } else {
      // Genuinely new. Structural fields with an obvious, non-judgment default get one
      // directly — no reason to ask a model what status a brand-new task starts in.
      if (!task.owner) task.owner = 'Durand';
      if (Object.prototype.hasOwnProperty.call(task, 'assignee')) { if (!task.delegate && task.assignee) task.delegate = task.assignee; delete task.assignee; }
      if (!task.status) task.status = 'Not Started';
      if (task.progress == null) task.progress = (task.status === 'Done') ? 100 : 0;
      if (!Array.isArray(task.tags)) task.tags = [];
      if (!Array.isArray(task.history)) task.history = [];
      if (task.depends == null) task.depends = '';
      if (task.doc == null) task.doc = '';
      if (task.notes == null) task.notes = '';
      if (task.timelineEnd == null) task.timelineEnd = '';
      // A value Durand typed into the New Task form is hand-set from the start (2026-09-17):
      // a history line with his name is what protects it from later enrichment passes.
      if (patch.ownerCreated) {
        ['priority', 'group', 'estHours', 'taskType', 'timelineEnd', 'location', 'delegate'].forEach(function(f) {
          if (task[f] != null && task[f] !== '') task.history.push({ ts: now, field: f, from: null, to: task[f], source: 'Durand' });
        });
      }
      if (originalTitleForCleanup && originalTitleForCleanup !== task.title) {
        task.history.push({ ts: now, field: 'title-cleaned', from: originalTitleForCleanup, to: task.title });
      }

      // Everything else is a real judgment call, so it goes through the same estimator
      // used to backfill hours on existing tasks (tsgEstimateTask_) rather than a guess —
      // added 2026-08-26 so a task pushed with gaps gets those gaps actually determined,
      // including breaking it into subtasks and finding a real dependency, instead of
      // sitting incomplete until someone notices. Never overrides a field already given.
      const need = [];
      if (task.estHours == null) need.push('estHours');
      if (!task.taskType) need.push('taskType');
      if (!Array.isArray(task.subitems) || !task.subitems.length) need.push('subitems');
      if (!task.priority) need.push('priority');
      if (!task.group) need.push('group');
      if (!task.depends && !task.dependsNone) need.push('dependsOnTitle');
      // 2026-09-09 per Durand: infer topical tags instead of leaving the field blank.
      // There's no formal tags catalog yet (flagged separately as future work) — this
      // reuses whatever's already in use across the board as its de facto vocabulary,
      // via EXISTING_TAGS below, so tags converge on a real shared set over time instead
      // of each task inventing its own wording for the same idea.
      var topicalTags = task.tags.filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) === -1 && tg !== 'Self-created'; });
      if (!topicalTags.length) need.push('tags');
      // Progress follows the notes board-wide (2026-09-15, per Durand): a new task with
      // notes has its bar read from them, whoever pushed it.
      if (String(task.notes || '').trim() && task.status !== 'Done' && !(typeof task.progress === 'number' && task.progress > 0)) need.push('progress');
      // Free-flow notes (2026-09-16, per Durand: "write a free flow thought into a task note
      // and Claude populates all fields from that and polishes the note itself"): with notes
      // present the title and the notes are polished, and a stated place / deadline is lifted
      // into location / due when those are empty.
      if (String(task.notes || '').trim()) {
        need.push('title', 'notes');
        if (!String(task.location || '').trim()) need.push('location');
        if (!task.timelineEnd) need.push('due');
      }

      // One merged call per new task (2026-09-16): the Drive and calendar candidates are
      // gathered up front and judged in the SAME estimator request as the other fields
      // (NEEDED_FIELDS 'driveMatch' / 'meetingMatch'), instead of two further round-trips.
      // Calendar candidates are offered whenever the type is Meeting or still unknown; the
      // link is applied below only once the resolved type is Meeting.
      if (!Array.isArray(task.docs)) task.docs = [];
      var driveCands = null, calCands = null, mailCands = null;
      if (!patch.skipEnrich) {
        // 2026-09-17 per Durand: "still perform link match searches even if links are added
        // manually" — Drive and Gmail candidates are gathered whatever is already linked
        // (an already-linked url is skipped on apply), plus named sites (webLinks).
        driveCands = tsgDriveCandidates_(task.title); if (driveCands) need.push('driveMatch');
        mailCands = tsgMailCandidates_(task.title); if (mailCands) need.push('mailMatch');
        need.push('webLinks');
        if (!task.meetingDate && (task.taskType === 'Meeting' || !task.taskType)) { calCands = tsgCalendarCandidates_(task.timelineEnd); if (calCands) need.push('meetingMatch'); }
      }
      var est = null;
      if (need.length && !patch.skipEnrich) {
        // Batch siblings (see the 'bulk' handler above) are listed so a task listed
        // before one it actually depends on can still detect that dependency — batch
        // order stops mattering. Own title excluded so a task can't "depend on itself".
        var batchSiblings = (patch.__batchSiblingTitles || []).filter(function(title) { return title !== task.title; });
        var board = patch.__batchContext || tsgBoardContext_(doc);
        const context = {
          groups: board.groups,
          openTitles: board.openTitles,
          existingTags: board.existingTags,
          batchSiblings: batchSiblings,
          current: tsgCurrentSnapshot_(task),
          driveCandidates: driveCands ? driveCands.listText : '',
          driveCandidateCount: driveCands ? driveCands.files.length : 0,
          calendarCandidates: calCands ? calCands.listText : '',
          calendarCandidateCount: calCands ? calCands.events.length : 0,
          driveList: driveCands ? driveCands.files : null,
          calendarList: calCands ? calCands.events : null,
          mailCandidates: mailCands ? mailCands.listText : '',
          mailCandidateCount: mailCands ? mailCands.threads.length : 0,
          mailList: mailCands ? mailCands.threads : null
        };
        est = tsgEstimateTask_(task.title, task.notes, task.priority, need, context);
        tsgApplyEstimateToTask_(doc, task, est, need, { now: now, source: patch.source || 'unknown', personCreated: !!patch.personCreated,
          batchSiblings: batchSiblings, driveCands: driveCands, calCands: calCands, mailCands: mailCands });
      }

      // 2026-09-09 per Durand: nothing should be SET BY DEFAULT if it can instead be
      // inferred. priority/group used to fall straight to a flat 'Medium'/'Unsorted' the
      // moment the estimator came back empty (Claude unreachable, or genuinely unable to
      // tell). Now, before falling back to a flat placeholder, try one more real signal:
      // the single most similar EXISTING task on the board (same title-token-overlap
      // method the dedup classifier already uses) is a far better basis than a constant —
      // inheriting a real neighbor's priority/group is an actual inference, not a guess
      // dressed up as one. Only when there's no comparable task at all (empty/near-empty
      // board) does this still fall back to Medium/Unsorted — and even then, ANY path
      // through this block means the estimator itself could not determine the field
      // directly, so it always gets tagged Triage and explained in notes rather than
      // silently applied. (Read as: no flat default ever ships un-flagged.)
      if (!task.priority || !task.group) {
        var neighbor = null, neighborScore = 0;
        (doc.tasks || []).forEach(function(t) {
          if (!t || !t.title) return;
          var sc = tsgTitleSimilarity_(task.title, t.title);
          if (sc > neighborScore) { neighborScore = sc; neighbor = t; }
        });
        var neighborUsable = neighbor && neighborScore >= 0.2; // loose — this is a fallback of a fallback
        var triageNotes = [];
        if (!task.priority) {
          if (neighborUsable && neighbor.priority) {
            task.priority = neighbor.priority;
            triageNotes.push('Priority inferred from the most similar existing task, #' + neighbor.id +
              ' ("' + neighbor.title + '", ' + Math.round(neighborScore * 100) + '% title match) — the estimator ' +
              'could not determine it directly. Please confirm.');
          } else {
            task.priority = 'Medium';
            triageNotes.push('Priority could not be determined by the estimator and no comparable existing task ' +
              'was found to infer from — set to Medium as a last resort. Please confirm.');
          }
        }
        if (!task.group) {
          if (neighborUsable && neighbor.group) {
            task.group = neighbor.group;
            triageNotes.push('Group inferred from the most similar existing task, #' + neighbor.id +
              ' ("' + neighbor.title + '", ' + Math.round(neighborScore * 100) + '% title match) — the estimator ' +
              'could not determine it directly. Please confirm.');
          } else {
            task.group = 'Unsorted';
            triageNotes.push('Group could not be determined by the estimator and no comparable existing task ' +
              'was found to infer from — filed under Unsorted as a last resort. Please confirm.');
          }
        }
        task.tags = Array.from(new Set(task.tags.concat(['Triage'])));
        task.notes = (task.notes ? task.notes + '\n\n' : '') + triageNotes.join(' ');
        task.history.push({ ts: now, field: 'triage-flagged', from: null, to: triageNotes.join(' ') });
      }

      task.id = doc.meta.next_id;
      doc.meta.next_id += 1;
      // No API key: the estimator handed back the request it would have sent; queue it now
      // that the task has an id. The Routine's answer lands through tsgApplyJudgmentOp_.
      if (est && est.source === 'queued' && est.request) {
        tsgQueueJudgment_(doc, Object.assign({ taskId: task.id, personCreated: !!patch.personCreated }, est.request));
      }
      // A patch-created task needs the same 'created' history entry the dashboard's own
      // "+ Add" form writes, because that entry is the ONLY creation timestamp
      // tsgFlagAgingTasks_ will accept ("no reliable creation timestamp — don't guess").
      // Without it, every task Claude ever pushed was structurally invisible to the aging
      // sweep and could sit open forever without being flagged (2026-09-02).
      task.history = task.history || [];
      task.history.push({ ts: new Date().toISOString(), field: 'created', from: null, to: null });
      // ownerCreated: the dashboard's own add (owner-only RPC); a delegate chosen there is
      // deliberate, so no hold. personCreated: the person's own page. Everything else
      // pointing at a person is automation and waits for review.
      if (!patch.personCreated && !patch.ownerCreated && tsgTaskNeedsDelegateReview_(task)) {
        tsgHoldForReview_(task, task.history, now, 'Held off the delegate views until Durand clears the Triage tag');
      }
      doc.tasks.push(task);
      addResult = { verdict: 'added', taskId: task.id, title: task.title };
    }
    // Audit trail a caller can read back by nonce (see doPost's target=data handler) to
    // learn what actually happened to the task it just submitted — necessary now that
    // the dashboard's own "+ Add" button goes through this same path and needs to know
    // whether to add a new local card, or reload because the push got merged elsewhere.
    doc.meta.addResults = doc.meta.addResults || [];
    doc.meta.addResults.push(Object.assign({ ts: now, nonce: patch.nonce || null }, addResult));
    if (doc.meta.addResults.length > 30) doc.meta.addResults = doc.meta.addResults.slice(-30);
  } else if (patch.op === 'update_task') {
    const t = doc.tasks.find(function(x) { return x.id === patch.id; });
    if (!t) throw new Error('update_task: task id not found: ' + patch.id);
    // Snapshot the task's current field values AND its subitems (full shallow copies, not
    // just done/status) BEFORE the assign below overwrites them, so both the task-level
    // fields and a whole-array subitems replacement can be diffed afterward — 2026-09-10,
    // "for sub/tasks every change and its source should be logged." patch.source is
    // whatever the caller set on the envelope (e.g. "Claude" for an Inbox patch) —
    // defaults to 'unknown' if not given; see the tsg-task-tracker-protocol skill for the
    // envelope shape this expects going forward.
    const prevTaskSnapshot = Object.assign({}, t);
    const prevSubitems = Array.isArray(t.subitems)
      ? t.subitems.map(function(s) { return Object.assign({}, s); })
      : [];
    if (patch.fields) { ['id', 'history'].forEach(function(k) { delete patch.fields[k]; }); }  // server-owned
    if (patch.fields && Object.prototype.hasOwnProperty.call(patch.fields, 'assignee')) {   // legacy name for delegate
      if (!Object.prototype.hasOwnProperty.call(patch.fields, 'delegate')) patch.fields.delegate = patch.fields.assignee;
      delete patch.fields.assignee;
    }
    Object.assign(t, patch.fields);
    if (Object.prototype.hasOwnProperty.call(t, 'assignee')) { if (!t.delegate && t.assignee) t.delegate = t.assignee; delete t.assignee; }
    if (patch.fields && patch.fields.depends) delete t.dependsNone;
    var notesChanged = tsgNotesChanged_(t, prevTaskSnapshot.notes);
    t.history = t.history || [];
    tsgLogFieldChanges_(t.history, prevTaskSnapshot, t, TSG_TASK_DIFF_FIELDS, now, patch.source);
    // Free-flow notes (2026-09-16): a notes change re-judges the whole task (title/notes
    // polish, fields left blank or set by automation, progress). Runs AFTER the field log so
    // the enrichment's own history lines carry their own source, not this patch's.
    if (notesChanged) tsgEnrichTask_(doc, t, now, patch.source || 'unknown', { progressExplicit: !!patch.fields && Object.prototype.hasOwnProperty.call(patch.fields, 'progress') });
    tsgStampLifecycleTimestamps_(t, now);
    if (patch.fields && Object.prototype.hasOwnProperty.call(patch.fields, 'subitems')) {
      tsgStampSubitemTouchesForTask_(prevSubitems, t.subitems, now, patch.source);
      // The parent's own enrich above already carried every open step; otherwise the new or
      // changed steps get ONE steps-only call between them (2026-09-17).
      if (!notesChanged) { var changedIdx = tsgChangedStepIndices_(prevSubitems, t.subitems); if (changedIdx.length) tsgEnrichSteps_(doc, t, now, patch.source || 'unknown', changedIdx); }
      (t.subitems || []).forEach(function(s, i) {
        var p = prevSubitems[i];
        var fresh = !p || String(p.title || '') !== String(s.title || '') || String(p.delegate || '') !== String(s.delegate || '');
        if (s && fresh && tsgIsDelegatePerson_(s.delegate)) {
          tsgHoldForReview_(s, t.history, now, 'Subitem "' + s.title + '" held off ' + s.delegate + "'s view until reviewed");
        }
      });
    }
    if (patch.fields && ((Object.prototype.hasOwnProperty.call(patch.fields, 'delegate') && !tsgValuesEqual_(tsgTaskDelegate_(prevTaskSnapshot), t.delegate) && tsgIsDelegatePerson_(t.delegate)) ||
                         (Object.prototype.hasOwnProperty.call(patch.fields, 'owner') && !tsgValuesEqual_(prevTaskSnapshot.owner, t.owner) && tsgIsDelegatePerson_(t.owner)))) {
      tsgHoldForReview_(t, t.history, now, 'Re-pointed at ' + (t.delegate || t.owner) + ' by a patch; held off their view until reviewed');
    }
    // A changed estHours invalidates the whole plan built from the OLD estHours —
    // scheduledStart/scheduledDays/estDays/timelineEnd were all derived from it. Left in
    // place they'd stay frozen at the old shape (the auto-scheduler only ever fills in
    // work items that are UNSCHEDULED), so a task re-estimated from 4h to 40h would keep
    // its old one-day plan forever and estDays and estHours would silently disagree.
    // Clearing them puts the task back in the scheduler's candidate set so the next pass
    // re-plans it cleanly from scratch (2026-09-02). A field the same patch set
    // explicitly is honored rather than wiped — an explicit value is never a stale
    // derivation.
    if (patch.fields && Object.prototype.hasOwnProperty.call(patch.fields, 'estHours')) {
      if (!Object.prototype.hasOwnProperty.call(patch.fields, 'scheduledStart')) t.scheduledStart = null;
      if (!Object.prototype.hasOwnProperty.call(patch.fields, 'scheduledDays')) t.scheduledDays = null;
      if (!Object.prototype.hasOwnProperty.call(patch.fields, 'estDays')) t.estDays = null;
      if (!Object.prototype.hasOwnProperty.call(patch.fields, 'timelineEnd')) t.timelineEnd = '';
    }
    // a manual/patch-driven due-date change wins permanently over the Google Tasks auto-sync,
    // which otherwise keeps stomping curated due dates back to the stale imported one
    if (patch.fields && Object.prototype.hasOwnProperty.call(patch.fields, 'timelineEnd')) {
      t.dueOverride = true;
    }
    if (patch.fields && Object.prototype.hasOwnProperty.call(patch.fields, 'estHours')) {
      tsgCaptureOwnHours_(t, patch.fields.estHours);
    }
  } else if (patch.op === 'delete_task') {
    const idx = doc.tasks.findIndex(function(x) { return x.id === patch.id; });
    if (idx === -1) throw new Error('delete_task: task id not found: ' + patch.id);
    // Used to also track deleted tasks' googleTaskId into meta.dismissedGoogleTaskIds to
    // suppress re-importing them — removed 2026-08-26 along with the rest of the Google
    // Tasks import machinery, which was already retired and no longer re-imports anything.
    doc.tasks.splice(idx, 1);
  } else if (patch.op === 'remove_dismissed_google_task_ids') {
    // One-time cleanup op: drops the now-inert meta.dismissedGoogleTaskIds list left over
    // from the retired Google Tasks import. Single-purpose and parameter-free by design —
    // not a general "clear any meta field" op.
    delete doc.meta.dismissedGoogleTaskIds;
  } else if (patch.op === 'update_subitem') {
    // One subitem by parent id + index (subitems have no ids). expectTitle guards against
    // the index having shifted under a concurrent reorder: mismatch -> rejected, not misapplied.
    const pt = doc.tasks.find(function(x) { return x.id === patch.id; });
    if (!pt) throw new Error('update_subitem: task id not found: ' + patch.id);
    const subs = Array.isArray(pt.subitems) ? pt.subitems : [];
    const sub = subs[patch.index];
    if (!sub) throw new Error('update_subitem: no subitem at index ' + patch.index + ' on task ' + patch.id);
    if (patch.expectTitle != null && String(sub.title || '') !== String(patch.expectTitle)) {
      throw new Error('update_subitem: subitem at index ' + patch.index + ' is not "' + patch.expectTitle + '" any more (stale)');
    }
    const prevSubs = subs.map(function(x) { return Object.assign({}, x); });
    const f = Object.assign({}, patch.fields || {});
    delete f.history;
    if (Object.prototype.hasOwnProperty.call(f, 'status')) { f.done = (f.status === 'Done'); if (f.done) f.progress = 100; }
    else if (Object.prototype.hasOwnProperty.call(f, 'done')) { f.status = f.done ? 'Done' : (sub.status === 'Done' ? 'In Progress' : (sub.status || 'Not Started')); if (f.done) f.progress = 100; }
    Object.assign(sub, f);
    var subNotesChanged = tsgNotesChanged_(sub, prevSubs[patch.index].notes);
    tsgStampSubitemTouchesForTask_(prevSubs, subs, now, patch.source);
    // A subtask's notes change re-judges the subtask the same way a task's does (2026-09-16).
    if (subNotesChanged) tsgEnrichItem_(doc, pt, sub, patch.index, now, patch.source || 'unknown', { progressExplicit: Object.prototype.hasOwnProperty.call(f, 'progress') });
  } else if (patch.op === 'add_subitem') {
    const t = doc.tasks.find(function(x) { return x.id === patch.id; });
    if (!t) throw new Error('add_subitem: task id not found: ' + patch.id);
    if (!Array.isArray(patch.subitem.history)) {
      patch.subitem.history = [{ ts: now, field: 'created', from: null, to: null, source: patch.source || 'unknown' }];
    }
    t.subitems = t.subitems || [];
    t.subitems.push(patch.subitem);
    tsgEnrichItem_(doc, t, patch.subitem, t.subitems.length - 1, now, patch.source || 'unknown', { allowEmptyNotes: true });
    if (tsgIsDelegatePerson_(patch.subitem.delegate)) {
      t.history = t.history || [];
      tsgHoldForReview_(patch.subitem, t.history, now, 'Subitem "' + patch.subitem.title + '" held off ' + patch.subitem.delegate + "'s view until reviewed");
    }
  } else if (patch.op === 'set_meta') {
    // Generic, reusable merge into doc.meta — unlike remove_dismissed_google_task_ids
    // above (one-time, parameter-free), this is meant for any future top-level meta
    // field a caller needs to set wholesale. First user: doc.meta.standingItems, the
    // recurring Ops Manual duties (SOP-sourced, dated by cadence) that feed the Today
    // view's Admin checklist client-side — see dash_fixed2.html's buildStandingItemChecks.
    var metaFields = Object.assign({}, patch.fields || {});
    // comments is server-owned too (2026-09-16): use add_comment / update_comment so two
    // writers (the dashboard, a Claude session) never overwrite each other's threads.
    ['next_id', 'docVersion', 'rejectedSaves', 'addResults', 'lastLiveHeartbeat', 'comments', 'judgments', 'judgmentSeq', 'tidyProposals'].forEach(function(k) { delete metaFields[k]; });  // server-owned
    Object.assign(doc.meta, metaFields);
    if (Object.prototype.hasOwnProperty.call(metaFields, 'homeBase')) {
      try { PropertiesService.getScriptProperties().setProperty('TSG_HOME_BASE', String(metaFields.homeBase || '')); } catch (err) {}
    }
  } else if (patch.op === 'judgment') {
    tsgApplyJudgmentOp_(doc, patch, now);
  } else if (patch.op === 'request_steps') {
    // Backfill (2026-09-17): one steps-only call for the open steps of a task that still have
    // no estimate (or the given indices). Steps that already carry hours are left alone.
    const st = doc.tasks.find(function(x) { return x.id === patch.id; });
    if (!st) throw new Error('request_steps: task id not found: ' + patch.id);
    var want = Array.isArray(patch.indices) ? patch.indices : (st.subitems || []).map(function(x, i) { return (x && !x.done && x.status !== 'Done' && !(typeof x.estHours === 'number' && x.estHours > 0)) ? i : -1; }).filter(function(i) { return i >= 0; });
    if (want.length) tsgEnrichSteps_(doc, st, now, patch.source || 'unknown', want);
  } else if (patch.op === 'request_tidy') {
    // The Tidy button (2026-09-16, per Durand: "the tidy should now just be automatic"): a
    // full re-run of the enrichment on one task, applied when the answer lands, no review
    // step. force: even fields Durand set by hand are re-judged this once.
    var tidyTask = (doc.tasks || []).filter(function(x) { return x && x.id === patch.id; })[0];
    if (!tidyTask) throw new Error('request_tidy: no task ' + patch.id);
    tsgEnrichTask_(doc, tidyTask, now, patch.source || 'Durand', { force: true });
  } else if (patch.op === 'clear_tidy_proposal') {
    if (doc.meta && doc.meta.tidyProposals) delete doc.meta.tidyProposals[String(patch.id)];
  } else if (patch.op === 'add_comment') {
    // Comment mode (2026-09-16, #250, per Durand: "a toggle where I can comment on any
    // visible element like Claude artifacts"). A comment is { id, ts, author, text,
    // anchor: { kind: 'task'|'sub'|'group'|'tile'|'element', id?, idx?, label, path? },
    // resolved, replies: [] }. Stored in meta.comments; Claude sessions read them from the
    // data file and answer with add_comment (author 'Claude', replyTo) or update_comment.
    var cm = patch.comment || {};
    if (!String(cm.text || '').trim()) throw new Error('add_comment: text required');
    doc.meta.comments = Array.isArray(doc.meta.comments) ? doc.meta.comments : [];
    var entry = {
      id: cm.id || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      ts: cm.ts || now, author: cm.author || patch.source || 'unknown', text: String(cm.text),
      anchor: cm.anchor || { kind: 'element', label: 'board' }, resolved: !!cm.resolved,
      replyTo: cm.replyTo || null
    };
    doc.meta.comments.push(entry);
  } else if (patch.op === 'update_comment') {
    var list = Array.isArray(doc.meta.comments) ? doc.meta.comments : [];
    var target = list.filter(function(x) { return x && x.id === patch.id; })[0];
    if (!target) throw new Error('update_comment: no comment ' + patch.id);
    if (patch.remove) { doc.meta.comments = list.filter(function(x) { return x.id !== patch.id && x.replyTo !== patch.id; }); }
    else {
      var cf = Object.assign({}, patch.fields || {});
      ['id', 'ts', 'author'].forEach(function(k) { delete cf[k]; });
      Object.assign(target, cf);
      if (Object.prototype.hasOwnProperty.call(cf, 'resolved')) { target.resolvedTs = cf.resolved ? now : null; target.resolvedBy = cf.resolved ? (patch.source || 'unknown') : null; }
    }
  } else if (patch.op === 'replace_all') {
    // A whole-document save — today this is only ever the dashboard's own doSave(),
    // submitted as a patch like everything else instead of written straight to disk
    // (see doPost). Only applied if nothing has changed server-side since the client
    // loaded the version it's saving against; otherwise a full snapshot would silently
    // erase whatever changed in between — that was the original data-loss bug. A
    // rejection is logged, not thrown, so it doesn't jam the rest of the batch.
    // What the client actually does with a "conflict" response today (corrected
    // 2026-09-02 — the previous version of this comment claimed an automatic reload-and-
    // retry that has never existed): dash_fixed2.html's doSave() surfaces a conflict
    // error to the user and the edit is NOT re-applied — the user has to reload and redo
    // it by hand. If a real auto-retry is ever implemented dashboard-side, this comment
    // needs updating again.
    const currentVersion = doc.meta.docVersion || 0;
    if (typeof patch.baseVersion !== 'number' || patch.baseVersion !== currentVersion) {
      doc.meta.rejectedSaves = doc.meta.rejectedSaves || [];
      doc.meta.rejectedSaves.push({ ts: now, nonce: patch.nonce || null, reason: (typeof patch.baseVersion !== 'number') ? 'missing_baseVersion' : 'stale_version', baseVersion: patch.baseVersion, currentVersion: currentVersion });
      if (doc.meta.rejectedSaves.length > 20) doc.meta.rejectedSaves = doc.meta.rejectedSaves.slice(-20);
      return; // no mutation, no version bump — this save did not happen
    }
    const incoming = patch.doc || {};
    const nextTasks = incoming.tasks || doc.tasks;
    tsgCaptureExplicitEditsFromSave_(doc.tasks, nextTasks);
    tsgApplyProgressFromNotesOnSave_(doc.tasks, nextTasks, doc, now);
    tsgStampStatusChanges_(doc.tasks, nextTasks, now, 'Durand');
    tsgStampSubitemTouches_(doc.tasks, nextTasks, now, 'Durand');
    doc.tasks = nextTasks;
    // A full save can carry client-minted ids; never let next_id fall behind them.
    var maxId = (nextTasks || []).reduce(function(m, t) { return (t && typeof t.id === 'number' && t.id > m) ? t.id : m; }, 0);
    if (typeof doc.meta.next_id !== 'number' || doc.meta.next_id <= maxId) doc.meta.next_id = maxId + 1;
    // next_id stays server-owned (only add_task ever advances it) — a client can't be
    // trusted to know the true max if something else added a task in the meantime, and
    // the version check above already guarantees nothing did if we got this far.
    const metaIn = incoming.meta || {};
    ['version', 'created', 'owner', 'status_values', 'priority_values', 'teamRoster'].forEach(function(k) {
      if (Object.prototype.hasOwnProperty.call(metaIn, k)) doc.meta[k] = metaIn[k];
    });
  } else {
    throw new Error('Unknown data patch op: ' + patch.op);
  }
  doc.meta.last_updated = now;
  doc.meta.docVersion = (doc.meta.docVersion || 0) + 1;
}

/**
 * ============================================================================
 * SHARED-SECRET AUTH — added 2026-09-02
 *
 * This web app is deployed "Anyone" so a credential-less curl (a Claude session) and
 * Durand's own browser can both reach it. That meant every data-returning endpoint was
 * world-readable and every write endpoint world-writable. The gate below is a shared
 * secret read ONLY from Script Properties (SCRIPT_TOKEN) — the value is never written
 * into this file, so reading Code.gs never leaks it.
 *
 * Fails OPEN when SCRIPT_TOKEN is unset, deliberately: deploying this code before the
 * property exists must not lock Durand (or the patch pipeline) out of his own tracker.
 * The moment the property is set, enforcement begins with no further code change. The
 * open state is logged on every call, so it's obvious in the Apps Script execution log
 * that auth is currently OFF.
 *
 * Callers pass ?token=... on the query string — for doPost too (the POST body is the
 * payload and is never used to carry the token).
 * ============================================================================
 */
function tsgCheckToken_(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('SCRIPT_TOKEN');
  if (!expected) {
    // Refuses (2026-09-15). The anonymous deployment that once justified the open default
    // is gone, and google.script.run can reach doPost from any page this script serves.
    Logger.log('[auth] SCRIPT_TOKEN is not set; refusing. Set it in Project Settings > Script Properties.');
    return false;
  }
  return !!(e && e.parameter && e.parameter.token === expected);
}

/** The exec URL of the deployment handling the current request ('' if unavailable). */
function tsgServiceUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (err) { return ''; }
}

/** The one unauthorized response shape, in the same ContentService/JSON style as everything else here. */
function tsgUnauthorized_() {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** True only for a real 'YYYY-MM-DD' string naming an actual calendar date. */
function tsgIsValidIsoDate_(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  var d = tsgParseIsoDate_(s);
  return !!d && !isNaN(d.getTime());
}

/**
 * LIVE HEARTBEAT (2026-09-02) — meta.lastLiveHeartbeat.
 *
 * Deliberately NOT the same thing as meta.lastRedeployVerification. That field means
 * "Durand confirmed this Code.gs is the deployed one," and per this project's standing
 * rule only he can ever set it — code must never infer a redeploy from its own behavior.
 * lastLiveHeartbeat claims something much weaker and automatically true: "the deployed
 * code was observed responding at time X."
 *
 * It is never worth a Drive write of its own. The timestamp is stamped cheaply into a
 * Script Property (throttled to at most once every TSG_HEARTBEAT_THROTTLE_SEC via
 * CacheService, so a burst of GETs doesn't burn Properties quota), and folded into
 * Data.json's meta only when processInbox_() is already writing that file for some other
 * reason. So doGet never gains a write of its own, the single-writer guarantee above is
 * untouched, and docVersion is never bumped by a heartbeat — a heartbeat can't
 * manufacture a save conflict for the dashboard.
 */
var TSG_HEARTBEAT_THROTTLE_SEC = 300;
var TSG_HEARTBEAT_TS = null; // set per-execution by tsgNoteLiveHeartbeat_()

function tsgNoteLiveHeartbeat_() {
  TSG_HEARTBEAT_TS = new Date().toISOString();
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('heartbeatStamped')) return TSG_HEARTBEAT_TS; // throttled — in-memory value still used below
    PropertiesService.getScriptProperties().setProperty('LAST_LIVE_HEARTBEAT', TSG_HEARTBEAT_TS);
    cache.put('heartbeatStamped', '1', TSG_HEARTBEAT_THROTTLE_SEC);
  } catch (err) {
    Logger.log('[heartbeat] could not stamp LAST_LIVE_HEARTBEAT: ' + err);
  }
  return TSG_HEARTBEAT_TS;
}

/** Best heartbeat value available to a write that's already happening. Never triggers a write itself. */
function tsgCurrentHeartbeat_() {
  if (TSG_HEARTBEAT_TS) return TSG_HEARTBEAT_TS;
  try { return PropertiesService.getScriptProperties().getProperty('LAST_LIVE_HEARTBEAT') || null; }
  catch (err) { return null; }
}

/**
 * ---------------------------------------------------------------------------
 * IDENTITY (2026-09-14) — only meaningful when TSG_ACCESS_MODE is 'DOMAIN'.
 * Under anonymous access these calls abort the request outright (verified live), so
 * tsgSignedInEmail_ never touches Session unless the mode says it is safe.
 * ---------------------------------------------------------------------------
 */
function tsgSignedInEmail_() {
  if (TSG_ACCESS_MODE !== 'DOMAIN') return '';
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (err) { return ''; }
}
function tsgEmailDomainOk_(email) {
  var at = String(email || '').lastIndexOf('@');
  return at > 0 && TSG_DOMAINS.indexOf(email.slice(at + 1)) !== -1;
}
function tsgIsOwnerEmail_(email) {
  email = String(email || '').toLowerCase();
  if (!email) return false;
  if (email === OWNER_EMAIL.toLowerCase()) return true;
  var local = email.slice(0, email.lastIndexOf('@'));
  return tsgEmailDomainOk_(email) && local === OWNER_EMAIL.slice(0, OWNER_EMAIL.indexOf('@')).toLowerCase();
}
/**
 * Roster name for a signed-in email: an explicit roster email wins; otherwise the TSG
 * convention firstname@<domain> (case-insensitive local part == roster name). '' if no match.
 */
function tsgRosterNameForEmail_(roster, email) {
  email = String(email || '').toLowerCase();
  if (!email) return '';
  var list = Array.isArray(roster) ? roster : [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i]; if (!m) continue;
    var name = typeof m === 'string' ? m : m.name;
    var rEmail = (typeof m === 'object' && m.email) ? String(m.email).toLowerCase() : '';
    if (rEmail && rEmail === email) return name || '';
  }
  if (!tsgEmailDomainOk_(email)) return '';
  var local = email.slice(0, email.lastIndexOf('@'));
  for (var j = 0; j < list.length; j++) {
    var n = typeof list[j] === 'string' ? list[j] : (list[j] && list[j].name);
    if (n && String(n).toLowerCase() === local) return n;
  }
  return '';
}
/** Placeholder served to a signed-in non-owner until their personal view exists. No token, no URL. */
function tsgPersonPlaceholderHtml_(name, email) {
  var who = name ? name : (email || 'there');
  return '<!doctype html><html><head><meta charset="utf-8"><title>TSG Task Tracker</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{margin:0;background:#0f1115;color:#e6e4dd;font-family:Lato,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.card{max-width:520px;padding:32px;border:1px solid #2a2d35;border-radius:12px;background:#171a21}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#b8b5ad}</style></head>' +
    '<body><div class="card"><h1>Hi ' + tsgHtmlEscape_(who) + '</h1>' +
    '<p>You are signed in to the TSG Task Tracker' + (name ? '' : ', but this account is not on the team roster yet') + '.</p>' +
    '<p>Your personal view of the tasks delegated to you is being built. Until it is live, Durand is the contact for anything on the board.</p>' +
    '</div></body></html>';
}
function tsgHtmlEscape_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

/**
 * ---------------------------------------------------------------------------
 * TIMED INBOX PROCESSING (2026-09-14). With domain-restricted access, automation (Claude
 * sessions) can no longer poke ?api=sync to apply its _Inbox patches; a one-minute
 * time-driven trigger does it instead. tsgInstallInboxTrigger is run ONCE by Durand from
 * the Apps Script editor (Run > tsgInstallInboxTrigger) — that run is also what grants the
 * script's new authorization scopes. Idempotent: re-running replaces the trigger.
 * ---------------------------------------------------------------------------
 */
/**
 * Editor-run maintenance entry points must stay public (the editor can only run public
 * functions), so each one refuses any caller who is not the owner. Under DOMAIN access every
 * google.script.run caller has an identity, and the editor runs as the owner.
 */
function tsgAssertOwner_(what) {
  if (!tsgIsOwnerEmail_(tsgSignedInEmail_())) throw new Error(what + ': owner only');
}

function tsgInboxTick() {
  // Reminders ride on this minute tick (2026-09-17): a script property holds the earliest
  // pending remindAt, so nothing is read from Drive until one is actually due.
  try { tsgReminderTick_(); } catch (remErr) { Logger.log('[reminders] tick failed: ' + remErr.message); }
  // processInbox_ sets a short-lived "inbox was empty" flag; while it holds, skip the Drive
  // listing entirely (the dashboard's own saves clear the flag and process immediately).
  if (tsgCacheGet_('inboxEmptyUntil')) return;
  processInbox_();
}

// ---- Reminders (2026-09-17, per Durand: "add a reminder function and optional time component
// for due dates"). Fields on tasks and subtasks: dueTime 'HH:mm' (optional, the due date stays
// timelineEnd), remindAt 'YYYY-MM-DDTHH:mm' (script time zone), reminderSentAt (ISO, server-set).
// Every data write re-indexes the earliest pending reminder into script property
// TSG_NEXT_REMINDER; tsgInboxTick fires due ones by email to the owner and queues an inbox
// patch stamping reminderSentAt (a 15-minute cache guard prevents a second send meanwhile).
var TSG_REMINDER_PROP = 'TSG_NEXT_REMINDER';
function tsgReminderDate_(remindAt) {
  if (!remindAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(remindAt))) return null;
  var d = new Date(String(remindAt).slice(0, 16) + ':00');
  return isNaN(d.getTime()) ? null : d;
}
function tsgReminderPending_(item) {
  if (!item || !item.remindAt || item.reminderSentAt) return false;
  if (item.done || item.status === 'Done') return false;
  return !!tsgReminderDate_(item.remindAt);
}
function tsgPendingReminders_(doc) {
  var out = [];
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t) return;
    if (tsgReminderPending_(t)) out.push({ key: 't' + t.id, task: t, item: t, subIdx: null, at: tsgReminderDate_(t.remindAt) });
    (t.subitems || []).forEach(function(s, i) {
      if (tsgReminderPending_(s)) out.push({ key: 't' + t.id + 's' + i, task: t, item: s, subIdx: i, at: tsgReminderDate_(s.remindAt) });
    });
  });
  out.sort(function(a, b) { return a.at - b.at; });
  return out;
}
function tsgIndexReminders_(doc) {
  var pending = tsgPendingReminders_(doc);
  var next = pending.length ? pending[0].at.toISOString() : '';
  try { PropertiesService.getScriptProperties().setProperty(TSG_REMINDER_PROP, next); } catch (err) {}
  return next;
}
function tsgReminderBody_(r) {
  var it = r.item, t = r.task;
  var lines = [];
  if (r.subIdx != null) lines.push('Step of #' + t.id + ' ' + t.title);
  lines.push('Due: ' + (it.timelineEnd || '(no date)') + (it.dueTime ? ' ' + it.dueTime : ''));
  if (it.priority) lines.push('Priority: ' + it.priority);
  if (it.delegate) lines.push('Delegate: ' + it.delegate);
  if (it.location) lines.push('Location: ' + it.location);
  var notes = String(it.notes || '').trim();
  if (notes) lines.push('', notes.length > 600 ? notes.slice(0, 600) + '…' : notes);
  var links = [it.doc].concat((it.docs || []).map(function(d) { return d && d.url; })).filter(Boolean);
  if (links.length) lines.push('', 'Links:', links.join('\n'));
  lines.push('', '— TSG Task Tracker reminder');
  return lines.join('\n');
}
function tsgReminderTick_() {
  var next = '';
  try { next = PropertiesService.getScriptProperties().getProperty(TSG_REMINDER_PROP) || ''; } catch (err) { return { ok: false, error: err.message }; }
  if (!next) return { ok: true, fired: 0 };
  var now = new Date();
  if (new Date(next) > now) return { ok: true, fired: 0, next: next };
  var doc;
  try { doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString()); }
  catch (err) { return { ok: false, error: 'data unreadable: ' + err.message }; }
  var pending = tsgPendingReminders_(doc);
  var due = pending.filter(function(r) { return r.at <= now && !tsgCacheGet_('reminderFired:' + r.key); });
  var ops = [];
  due.forEach(function(r) {
    var subject = 'Reminder: ' + r.item.title + (r.item.timelineEnd ? ' — due ' + r.item.timelineEnd + (r.item.dueTime ? ' ' + r.item.dueTime : '') : '');
    try { MailApp.sendEmail(OWNER_EMAIL, subject, tsgReminderBody_(r)); }
    catch (mailErr) { Logger.log('[reminders] send failed for ' + r.key + ': ' + mailErr.message); return; }
    tsgCachePut_('reminderFired:' + r.key, '1', 900);
    var sentAt = now.toISOString();
    if (r.subIdx == null) ops.push({ op: 'update_task', id: r.task.id, fields: { reminderSentAt: sentAt } });
    else ops.push({ op: 'update_subitem', id: r.task.id, index: r.subIdx, expectTitle: r.item.title, fields: { reminderSentAt: sentAt } });
  });
  if (ops.length) tsgQueueDataPatch_({ op: 'bulk', source: 'Reminder', ops: ops });
  // Point the property at the next reminder still in the future; the queued patch's write
  // re-indexes properly once it lands.
  var later = pending.filter(function(r) { return r.at > now; });
  try { PropertiesService.getScriptProperties().setProperty(TSG_REMINDER_PROP, later.length ? later[0].at.toISOString() : ''); } catch (err) {}
  return { ok: true, fired: ops.length, next: later.length ? later[0].at.toISOString() : '' };
}
function tsgInstallInboxTrigger() {
  tsgAssertOwner_('tsgInstallInboxTrigger');
  var existing = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'tsgInboxTick'; });
  existing.forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tsgInboxTick').timeBased().everyMinutes(1).create();
  Logger.log('[trigger] tsgInboxTick installed (every minute); replaced ' + existing.length + ' existing.');
  return { ok: true, replaced: existing.length };
}

/**
 * RPC entry for the dashboard (2026-09-14). Under domain-restricted access a cross-origin
 * fetch() of the exec URL cannot carry the Google session, so the page calls this through
 * google.script.run instead. It rebuilds the same event object doGet/doPost expect and
 * returns the text body. The shared token is supplied here from Script Properties — the
 * caller's proof is their signed-in identity, checked first. Until the per-person view
 * exists, only the owner may use this channel: google.script.run is reachable from ANY
 * page this script serves, including the placeholder, so the gate is not optional.
 */
function tsgRpc(query, method, body) {
  if (!tsgIsOwnerEmail_(tsgSignedInEmail_())) {
    // Unconditional: with no identity (any non-DOMAIN mode) nobody gets in.
    return JSON.stringify({ ok: false, error: 'unauthorized' });
  }
  var params = {};
  String(query || '').replace(/^[?&]+/, '').split('&').forEach(function(kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = i === -1 ? kv : kv.slice(0, i);
    var v = i === -1 ? '' : kv.slice(i + 1);
    try { params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (err) { params[k] = v; }
  });
  if (!params.api && !params.target && String(method || 'GET').toUpperCase() !== 'POST') {
    return JSON.stringify({ ok: false, error: 'rpc: nothing requested (no api= or target=)' });
  }
  params.token = PropertiesService.getScriptProperties().getProperty('SCRIPT_TOKEN') || '';
  var e = { parameter: params, postData: { contents: body == null ? '' : String(body) } };
  var out = String(method || 'GET').toUpperCase() === 'POST' ? doPost(e) : doGet(e);
  return (out && typeof out.getContent === 'function') ? out.getContent() : String(out);
}

/**
 * ---------------------------------------------------------------------------
 * PER-PERSON VIEW (milestone 1, 2026-09-15). A signed-in roster member gets a slice of the
 * document and a narrow write surface; everything is decided here, server-side:
 *   - own tasks (owner === name): every field editable;
 *   - tasks delegated to them whole (delegate === name): status, notes only;
 *   - subitems delegated to them: status, progress, notes only; the parent is context.
 * Writes go through the same _Inbox pipeline as everything else, as per-item ops, so a
 * person's edit can never overwrite the owner's board and vice versa.
 * The owner may preview any person with the `as` parameter.
 * ---------------------------------------------------------------------------
 */
// 2026-09-15: 'progress' left every list. It is derived, never typed: from the notes via
// tsgProgressFromNotes_ on each notes edit, or from the subitems when the task has any.
var TSG_PERSON_TASK_FIELDS_OWN = ['title', 'status', 'priority', 'timelineEnd', 'notes'];
var TSG_PERSON_TASK_FIELDS_DELEGATED = ['status', 'notes'];
var TSG_PERSON_SUB_FIELDS = ['status', 'notes'];

/**
 * Whole-task delegate (2026-09-15, per Durand: "drop assignee, it's been replaced by
 * delegate"). The field is `delegate` on the task, the same word subitems use. Documents
 * written before this carry `assignee`; tsgMigrateAssigneeToDelegate_ moves it on the next
 * write and this reader falls back to it until then.
 */
function tsgTaskDelegate_(t) {
  if (!t) return '';
  var d = String(t.delegate || '').trim();
  return d || String(t.assignee || '').trim();
}
function tsgMigrateAssigneeToDelegate_(doc) {
  (doc.tasks || []).forEach(function(t) {
    if (!t || !Object.prototype.hasOwnProperty.call(t, 'assignee')) return;
    if (!t.delegate && t.assignee) t.delegate = t.assignee;
    delete t.assignee;
  });
}
/** Subitems minted by the estimator go to the task's delegate when that is someone other than Durand. */
function tsgDefaultSubitemDelegate_(task) {
  var a = tsgTaskDelegate_(task);
  return (a && a.toLowerCase() !== 'durand') ? a : '';
}
function tsgTaskProgress_(t) {
  if (t.subitems && t.subitems.length) {
    var done = t.subitems.filter(function(s) { return s && s.done; }).length;
    return Math.round((done / t.subitems.length) * 100);
  }
  return t.status === 'Done' ? 100 : (typeof t.progress === 'number' ? t.progress : 0);
}

function tsgPersonNameForRequest_(doc, asOverride) {
  var who = tsgSignedInEmail_();
  if (!who) return '';
  var roster = (doc && doc.meta && doc.meta.teamRoster) || [];
  if (asOverride && tsgIsOwnerEmail_(who)) {
    var wanted = String(asOverride).toLowerCase();
    for (var i = 0; i < roster.length; i++) {
      var n = typeof roster[i] === 'string' ? roster[i] : (roster[i] && roster[i].name);
      if (n && String(n).toLowerCase() === wanted) return n;
    }
    return '';
  }
  return tsgRosterNameForEmail_(roster, who);
}

function tsgStatusOfSubs_(subs) {
  if (!subs.length) return 'Not Started';
  if (subs.every(function(s) { return s.done; })) return 'Done';
  if (subs.some(function(s) { return s.status === 'Blocked'; })) return 'Blocked';
  if (subs.some(function(s) { return s.done || s.status === 'In Progress'; })) return 'In Progress';
  if (subs.some(function(s) { return s.status === 'Waiting'; })) return 'Waiting';
  return 'Not Started';
}
/**
 * The rows a person's page shows. Tasks and subitems tagged Pending Review are invisible
 * to them. A task that is neither theirs nor assigned to them but carries subitems
 * delegated to them appears as a read-only CONTEXT row (title, rolled-up status of their
 * steps, priority, due, owner; no notes, no tags) so those steps group under it.
 */
function tsgPersonSlice_(doc, name) {
  var rows = [];
  (doc.tasks || []).forEach(function(t) {
    if (!t || tsgIsHeldForReview_(t)) return;
    var isOwn = t.owner === name;
    var isAssigned = !isOwn && tsgTaskDelegate_(t) === name;
    var subs = t.subitems || [];
    var mine = [];
    subs.forEach(function(s, i) { if (s && s.delegate === name && !tsgIsHeldForReview_(s)) mine.push({ s: s, i: i }); });
    if (!isOwn && !isAssigned && !mine.length) return;
    var context = !isOwn && !isAssigned;
    var mineSubs = mine.map(function(m) { return m.s; });
    var mineDone = mineSubs.filter(function(s) { return s.done; }).length;
    rows.push({
      kind: 'task', id: t.id, own: isOwn, context: context, title: t.title || '',
      status: context ? tsgStatusOfSubs_(mineSubs) : (t.status || 'Not Started'),
      priority: t.priority || '',
      progress: context ? Math.round((mineDone / mineSubs.length) * 100) : tsgTaskProgress_(t),
      due: t.timelineEnd || '', notes: context ? '' : (t.notes || ''), group: t.group || '', owner: t.owner || '',
      tags: context ? [] : (t.tags || []).slice(), taskType: context ? '' : (t.taskType || ''),
      estHours: (!context && typeof t.estHours === 'number') ? t.estHours : null,
      subTotal: context ? mineSubs.length : subs.length,
      subDone: context ? mineDone : subs.filter(function(s) { return s && s.done; }).length,
      editable: isOwn ? TSG_PERSON_TASK_FIELDS_OWN.slice() : (isAssigned ? TSG_PERSON_TASK_FIELDS_DELEGATED.slice() : [])
    });
    mine.forEach(function(m) {
      var s = m.s;
      rows.push({
        kind: 'sub', id: t.id, index: m.i, own: false, parentOwn: isOwn, parentTitle: t.title || '', title: s.title || '',
        status: s.done ? 'Done' : (s.status || 'Not Started'), priority: s.priority || t.priority || '',
        progress: s.done ? 100 : (typeof s.progress === 'number' ? s.progress : 0), done: !!s.done,
        due: s.timelineEnd || '', notes: s.notes || '', group: t.group || '', owner: t.owner || '', subTotal: 0,
        editable: TSG_PERSON_SUB_FIELDS.slice()
      });
    });
  });
  return rows;
}

/** Queue one data patch and apply it now. Returns {ok, busy?, docVersion?}. */
function tsgQueueDataPatch_(patchObj) {
  var nonce = Utilities.getUuid();
  patchObj = Object.assign({ target: 'data', ts: new Date().toISOString(), nonce: nonce }, patchObj);
  DriveApp.getFolderById(INBOX_FOLDER_ID).createFile('person-' + nonce + '.json', JSON.stringify(patchObj), 'application/json');
  tsgCacheRemove_('inboxEmptyUntil');
  var run = processInbox_();
  if (run && run.busy) return { ok: false, busy: true };
  var v = tsgCacheGet_('docVersion');
  return { ok: true, docVersion: (v != null && !isNaN(Number(v))) ? Number(v) : null };
}

function tsgPersonRpc(action, payloadJson) {
  var payload = {};
  try { payload = JSON.parse(payloadJson || '{}') || {}; } catch (err) { return JSON.stringify({ ok: false, error: 'bad payload' }); }
  if (action === 'version') {
    var cv = tsgCacheGet_('docVersion');
    return JSON.stringify({ ok: true, docVersion: (cv != null && !isNaN(Number(cv))) ? Number(cv) : null });
  }
  var doc;
  try { doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString()); }
  catch (err) { return JSON.stringify({ ok: false, error: 'data unavailable' }); }
  var name = tsgPersonNameForRequest_(doc, payload.as);
  if (!name) return JSON.stringify({ ok: false, error: 'unauthorized' });
  // The owner editing through a ?person= preview is recorded as themself, not as the person.
  var whoRpc = tsgSignedInEmail_();
  var actor = (payload.as && tsgIsOwnerEmail_(whoRpc))
    ? (tsgRosterNameForEmail_((doc.meta && doc.meta.teamRoster) || [], whoRpc) || 'Durand') : name;

  if (action === 'load') {
    return JSON.stringify({
      ok: true, person: name, docVersion: doc.meta && doc.meta.docVersion, codeVersion: TSG_CODE_VERSION,
      statuses: (doc.meta && doc.meta.status_values) || ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done'],
      priorities: (doc.meta && doc.meta.priority_values) || ['Critical', 'High', 'Medium', 'Low'],
      rows: tsgPersonSlice_(doc, name)
    });
  }
  if (action === 'update') {
    var rows = tsgPersonSlice_(doc, name);
    var row = rows.filter(function(r) {
      return r.kind === payload.kind && r.id === payload.id && (r.kind !== 'sub' || r.index === payload.index);
    })[0];
    if (!row) return JSON.stringify({ ok: false, error: 'not yours' });
    var fields = {};
    var offered = payload.fields || {};
    var rejected = [];
    Object.keys(offered).forEach(function(k) {
      var key = (k === 'due') ? 'timelineEnd' : k;
      if (row.editable.indexOf(key) === -1) { rejected.push(k); return; }
      var v = offered[k];
      if (key === 'progress') { v = Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
      if (key === 'status' && ((doc.meta && doc.meta.status_values) || []).length && (doc.meta.status_values).indexOf(v) === -1) { rejected.push(k); return; }
      if (key === 'priority' && ((doc.meta && doc.meta.priority_values) || []).length && (doc.meta.priority_values).indexOf(v) === -1) { rejected.push(k); return; }
      if (key === 'timelineEnd' && v && !tsgIsValidIsoDate_(v)) { rejected.push(k); return; }
      if (key === 'title' && !String(v || '').trim()) { rejected.push(k); return; }
      fields[key] = (typeof v === 'string') ? v : v;
    });
    if (rejected.length) return JSON.stringify({ ok: false, error: 'field not editable: ' + rejected.join(', ') });
    if (!Object.keys(fields).length) return JSON.stringify({ ok: false, error: 'nothing to change' });
    // Progress follows the notes: update_task / update_subitem re-read them server-side
    // (tsgApplyProgressFromNotes_), the same rule as Durand's own board.
    var op = (row.kind === 'sub')
      ? { op: 'update_subitem', id: row.id, index: row.index, expectTitle: row.title, fields: fields, source: actor }
      : { op: 'update_task', id: row.id, fields: fields, source: actor };
    if (row.kind === 'task' && fields.status === 'Done') op.fields.progress = 100;
    return JSON.stringify(tsgQueueDataPatch_(op));
  }
  if (action === 'add') {
    var title = String(payload.title || '').trim();
    if (!title) return JSON.stringify({ ok: false, error: 'title required' });
    var prios = (doc.meta && doc.meta.priority_values) || ['Critical', 'High', 'Medium', 'Low'];
    var prio = prios.indexOf(payload.priority) !== -1 ? payload.priority : 'Medium';
    var due = (payload.due && tsgIsValidIsoDate_(payload.due)) ? payload.due : '';
    var nowIso = new Date().toISOString();
    var task = {
      title: title, owner: name, delegate: name, group: name, status: 'Not Started', priority: prio,
      tags: ['Self-created'], timelineStart: '', timelineEnd: due, progress: 0, depends: '', doc: '', docs: [],
      notes: String(payload.notes || ''), subitems: [], duration: null, estHours: null, estDays: null, estSource: 'none',
      taskType: '', history: [{ ts: nowIso, field: 'created', from: null, to: null, source: actor }]
    };
    if (due) task.dueOverride = true;
    // Enriched like any other new task (estimate, type, subitems delegated back to the
    // person, tags, dependency, Drive doc) and scheduled on the same pass; only the
    // near-duplicate merge is skipped, since folding a person's task into one of Durand's
    // would make it vanish from their page. personCreated: the notes set the bar and the
    // estimate is split across the minted steps so they schedule.
    return JSON.stringify(tsgQueueDataPatch_({ op: 'add_task', task: task, source: actor, skipDedup: true, personCreated: true }));
  }
  return JSON.stringify({ ok: false, error: 'unknown action' });
}

function doGet(e) {
  e = e || {};
  if (!e.parameter) e.parameter = {};
  if (e.parameter.api === 'version') {
    // Polled every 45s by every open dashboard: answered from the script cache (set on every
    // write) with no Drive I/O and no inbox pass. Falls back to one file read when cold.
    var docVersion = null;
    var cachedV = tsgCacheGet_('docVersion');
    if (cachedV != null && cachedV !== '' && !isNaN(Number(cachedV))) {
      docVersion = Number(cachedV);
    } else {
      try {
        var vdoc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
        if (vdoc && vdoc.meta && typeof vdoc.meta.docVersion === 'number') {
          docVersion = vdoc.meta.docVersion;
          tsgCachePut_('docVersion', String(docVersion), 21600);
        }
      } catch (err) { docVersion = null; }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, codeVersion: TSG_CODE_VERSION, docVersion: docVersion }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // processInbox_() stays FIRST and stays UNGATED, deliberately: it is how _Inbox patch
  // files actually get applied, and gating it behind a token would silently strand every
  // queued write. It reads only files this script already owns and applies only patches
  // already sitting in a Drive folder only Durand can write to, so it is not an auth hole.
  tsgNoteLiveHeartbeat_();
  processInbox_();

  if (e.parameter.api === 'sync') {
    // Intentionally ungated: returns no data at all ({ok:true}), and its only effect is
    // the processInbox_() call above, which already ran unconditionally.
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }
  // No ?api=whoami here, deliberately (2026-09-14): under this deployment's anonymous
  // access, Session.getActiveUser() makes Apps Script abort the whole request with
  // Google's "Sorry, unable to open the file at this time" page — it does not return ''.
  // Per-person views therefore need a domain-restricted deployment; see CLAUDE.md.
  if (e.parameter.api === 'data') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(getTrackerFile_('data').getBlob().getDataAsString())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'rulesets') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(getTrackerFile_('rulesets').getBlob().getDataAsString())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'calendar') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    // start/end used to be handed straight to getCalendarHours_(), where a missing or
    // malformed value became new Date('undefinedT00:00:00') — an Invalid Date that came
    // back as an empty event list. An empty calendar and a broken request are very
    // different things, so say which one this actually is.
    if (!tsgIsValidIsoDate_(e.parameter.start) || !tsgIsValidIsoDate_(e.parameter.end)) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'invalid or missing start/end date parameter'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify(getCalendarHours_(e.parameter.start, e.parameter.end)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'meetings') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(
      tsgListUpcomingMeetings_(e.parameter.start, e.parameter.end, e.parameter.titleHint, e.parameter.dueDate)
    )).setMimeType(ContentService.MimeType.JSON);
  }
  // Link picker (2026-09-16, #250: "add link offers a search box"; "links take their label
  // from the link itself"). driveSearch lists files Durand owns matching the words typed;
  // linkLabel resolves a pasted Drive/Docs URL to the file's real name. Neither fetches
  // an arbitrary URL: a non-Google link gets its hostname as the label, client-side.
  if (e.parameter.api === 'driveSearch') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgDriveSearch_(e.parameter.q)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'mailSearch') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgMailSearch_(e.parameter.q)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'meetingSlots') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgMeetingSlots_(e.parameter.guest, e.parameter.start, e.parameter.end, e.parameter.minutes, e.parameter.blocks)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'geocode') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgGeocode_(e.parameter.q)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'linkLabel') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgLabelForUrl_(e.parameter.url)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'fubUsers') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgListFubUsers_()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'verifyEmail') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    var vres = tsgVerifyEmailMatch_(e.parameter.name, e.parameter.email);
    return ContentService.createTextOutput(JSON.stringify({
      ok: true, verified: vres.verified, reason: vres.reason
    })).setMimeType(ContentService.MimeType.JSON);
  }
  // Bare doGet — the dashboard HTML shell. Not token-gated: it is the initial page load,
  // and every data call the page then makes is gated above. Under DOMAIN access the
  // request carries a Google identity: the owner gets the full dashboard; anyone else in
  // the organization gets a per-person placeholder that carries neither the token nor the
  // exec URL (2026-09-14; the per-person view itself is the next build).
  if (TSG_ACCESS_MODE === 'DOMAIN') {
    var who = tsgSignedInEmail_();
    if (!tsgIsOwnerEmail_(who) || e.parameter.person) {
      var rosterName = '';
      try {
        var gateDoc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
        rosterName = tsgPersonNameForRequest_(gateDoc, e.parameter.person);
      } catch (err) { rosterName = ''; }
      if (!rosterName) {
        return HtmlService.createHtmlOutput(tsgPersonPlaceholderHtml_('', who))
          .setTitle('TSG Task Tracker')
          .addMetaTag('viewport', 'width=device-width, initial-scale=1');
      }
      // An uncaught exception here renders as Google's generic "unable to open the file"
      // page, which hides the cause. Catch it: the owner sees the message and stack, a
      // roster member sees the placeholder (2026-09-15, kept from diagnosing the ?person= preview, which turned out to be an out-of-domain account).
      try {
        var personHtml = HtmlService.createHtmlOutputFromFile('person').getContent();
        var personStamps = { '__TSG_PERSON__': rosterName, '__TSG_CODE_VERSION__': TSG_CODE_VERSION, '__TSG_AS__': (e.parameter.person && tsgIsOwnerEmail_(who)) ? rosterName : '' };
        Object.keys(personStamps).forEach(function(k) { personHtml = personHtml.split(k).join(tsgHtmlEscape_(personStamps[k])); });
        return HtmlService.createHtmlOutput(personHtml)
          .setTitle('TSG Task Tracker: ' + rosterName)
          .addMetaTag('viewport', 'width=device-width, initial-scale=1');
      } catch (personErr) {
        console.error('person page failed for ' + rosterName + ': ' + (personErr && personErr.stack || personErr));
        if (!tsgIsOwnerEmail_(who)) {
          return HtmlService.createHtmlOutput(tsgPersonPlaceholderHtml_(rosterName, who))
            .setTitle('TSG Task Tracker')
            .addMetaTag('viewport', 'width=device-width, initial-scale=1');
        }
        return HtmlService.createHtmlOutput('<!doctype html><html><head><meta charset="utf-8"><title>TSG Task Tracker: error</title></head><body style="font-family:monospace;padding:24px;white-space:pre-wrap">' +
          '<h2>Person page failed (API ' + tsgHtmlEscape_(TSG_CODE_VERSION) + ')</h2>' +
          tsgHtmlEscape_((personErr && personErr.stack) || String(personErr)) + '</body></html>').setTitle('TSG Task Tracker: error');
      }
    }
  }
  // The dashboard file carries literal placeholders in its JS that only the backend can
  // fill: __TSG_CODE_VERSION__ (footer stamp), __TSG_API_URL__ (the exec URL of the
  // deployment serving this request) and __TSG_TOKEN__ (the SCRIPT_TOKEN script property).
  // Injecting the last two here (2026-09-14) is what keeps the exec URL and the token out
  // of the git repo, which is public. Exact-string swaps only; nothing else is interpolated.
  // 2026-09-14: the dashboard is now a file IN this script project (dashboard_final.html,
  // pushed by clasp alongside Code.gs) rather than a Drive file written via ?target=html.
  // One deploy path for both, from any machine that can run clasp. createHtmlOutputFromFile
  // (not createTemplateFromFile) so nothing in the page is evaluated as a scriptlet.
  var html = HtmlService.createHtmlOutputFromFile('dashboard_final').getContent();
  var stamps = {
    '__TSG_CODE_VERSION__': TSG_CODE_VERSION,
    '__TSG_API_URL__': tsgServiceUrl_(),
    '__TSG_TOKEN__': PropertiesService.getScriptProperties().getProperty('SCRIPT_TOKEN') || ''
  };
  Object.keys(stamps).forEach(function(k) { html = html.split(k).join(stamps[k]); });
  return HtmlService.createHtmlOutput(html)
    .setTitle('TSG Task Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Travel time + meeting prep (2026-08-27): a meeting's calendar duration alone
// understates how much of the day it actually consumes — getting somewhere and back,
// and just having a lead-in to actually prep, are real time costs. TSG_MEETING_PREP_MIN
// applies to every timed meeting; TSG_MEETING_TRAVEL_MIN (before AND after) applies only
// when the event reads as off-site — a real physical location, not a video-call link or
// a virtual-meeting keyword. No location field at all is treated as NOT off-site (can't
// assume a commute that isn't evidenced), matching how a blank field is treated
// everywhere else in this file (see TSG_OOO_KEYWORDS' comment above for the same
// "don't guess" stance).
var TSG_MEETING_PREP_MIN = 10;
var TSG_MEETING_TRAVEL_MIN = 20;
var TSG_VIRTUAL_MEETING_RE = /\b(zoom|google.?meet|meet\.google|hangout|teams|webex|skype|virtual|phone|call.?in|conference call)\b/i;
function tsgIsOffSiteMeeting_(title, location) {
  var loc = (location || '').trim();
  if (!loc) return false;
  if (/^https?:\/\//i.test(loc)) return false;
  if (TSG_VIRTUAL_MEETING_RE.test(loc) || TSG_VIRTUAL_MEETING_RE.test(title || '')) return false;
  return true;
}

function getCalendarHours_(startStr, endStr) {
  const cal = CalendarApp.getDefaultCalendar();
  const tz = cal.getTimeZone();
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T23:59:59');
  const events = cal.getEvents(start, end);
  const out = [];
  events.forEach(function(ev) {
    if (ev.isAllDayEvent()) return;
    // Only events actually RSVP'd YES block real time — a declined, tentative, or
    // not-yet-answered invite shouldn't eat into capacity. OWNER counts too: an event
    // you created yourself (no RSVP to give) still blocks your calendar.
    if (ev.getMyStatus) {
      var myStatus = ev.getMyStatus();
      if (myStatus !== CalendarApp.GuestStatus.YES && myStatus !== CalendarApp.GuestStatus.OWNER) return;
    }
    const ms = ev.getEndTime().getTime() - ev.getStartTime().getTime();
    const hours = Math.max(0.25, ms / 3600000);
    // hours stays the RAW meeting duration — tsgAttributeCalendarHours logs it onto a
    // matched task's actualHours, and travel/prep were never spent working the task, so
    // inflating hours here would silently overstate real task time. bufferedHours is the
    // separate, larger figure the auto-scheduler's capacity seed uses instead (see
    // tsgAutoScheduleDoc_) so a packed meeting day doesn't get task work jammed right up
    // against a commute.
    var location = ev.getLocation ? (ev.getLocation() || '') : '';
    var title = ev.getTitle();
    var offSite = tsgIsOffSiteMeeting_(title, location);
    var prepMin = TSG_MEETING_PREP_MIN;
    var travelMin = offSite ? tsgEventTravelMinutes_(location) : 0;
    var bufferHours = (prepMin + travelMin * 2) / 60;
    var seriesId = null;
    try { if (ev.isRecurringEvent && ev.isRecurringEvent()) seriesId = ev.getEventSeries().getId(); } catch (e0) {}
    out.push({
      title: title,
      seriesId: seriesId,
      date: Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'),
      hours: Math.round(hours * 4) / 4,
      bufferedHours: Math.round((hours + bufferHours) * 4) / 4,
      start: Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
      end: Utilities.formatDate(ev.getEndTime(), tz, 'HH:mm'),
      location: location,
      offSite: offSite,
      prepMin: prepMin,
      travelMin: travelMin
    });
  });
  return out;
}

// Meeting picker (2026-09-01) — backs the dashboard's "Link a meeting" flow, wired up
// whenever a task or subtask's Type is set to "Meeting". Three pieces: list upcoming
// meetings in a window with a best-guess match against the (sub)task's title/due date,
// create a brand-new event with fields prepopulated from the (sub)task (never invoked
// without the dashboard's own explicit-confirm step), and write the linked task back onto
// the event's description plus any Google Doc agenda that description links to.

// The eid Calendar's own "Copy link" uses is base64(eventId + " " + calendarId), no
// padding, URL-safe alphabet — confirmed against a real link already in the tracker data
// (task 12's calendar doc link) rather than guessed. CalendarApp's ev.getId() sometimes
// carries a "@google.com" suffix the REST-style id doesn't use, so strip it first.
function tsgCalendarEventLink_(ev, cal) {
  var id = ev.getId().replace(/@google\.com$/, '');
  var eid = Utilities.base64EncodeWebSafe(id + ' ' + cal.getId()).replace(/=+$/, '');
  return 'https://www.google.com/calendar/event?eid=' + eid;
}

function tsgFindAgendaDocUrl_(text) {
  if (!text) return '';
  var m = String(text).match(/https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+[^\s"'<>]*/);
  return m ? m[0] : '';
}

var TSG_STOPWORDS_RE = /\b(the|a|an|and|or|for|to|of|with|on|in|at|re|about|re:|call|meeting|check|check-in)\b/gi;
function tsgTitleWords_(title) {
  return String(title || '').toLowerCase().replace(TSG_STOPWORDS_RE, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 2; });
}
// Best-guess matcher: shared significant words between the (sub)task title and an event
// title, plus a proximity bonus when the (sub)task has a due date near the event. Never
// forces a match — returns null below a low threshold so a bad guess doesn't silently
// preselect the wrong meeting; the dashboard always shows the full list either way.
function tsgBestGuessMeeting_(events, titleHint, dueDate) {
  var hintWords = tsgTitleWords_(titleHint);
  if (!hintWords.length && !dueDate) return null;
  var due = dueDate ? new Date(dueDate + 'T12:00:00').getTime() : null;
  var best = null, bestScore = 0;
  events.forEach(function(ev) {
    var evWords = tsgTitleWords_(ev.title);
    var shared = hintWords.filter(function(w) { return evWords.indexOf(w) !== -1; }).length;
    var score = shared * 10;
    if (due) {
      var days = Math.abs(new Date(ev.start).getTime() - due) / 86400000;
      if (days < 3) score += (3 - days);
    }
    if (score > bestScore) { bestScore = score; best = ev; }
  });
  return (best && bestScore >= 8) ? best.id : null;
}

function tsgListUpcomingMeetings_(startStr, endStr, titleHint, dueDate) {
  var cal = CalendarApp.getDefaultCalendar();
  var tz = cal.getTimeZone();
  var todayIso = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var start = new Date((startStr || todayIso) + 'T00:00:00');
  var end = new Date((endStr || tsgAddDays_(todayIso, 14)) + 'T23:59:59');
  var events = cal.getEvents(start, end);
  var out = [];
  events.forEach(function(ev) {
    if (ev.isAllDayEvent()) return;
    var desc = ev.getDescription() || '';
    var recurring = false, seriesId = null;
    try { recurring = !!ev.isRecurringEvent(); if (recurring) seriesId = ev.getEventSeries().getId(); } catch (e0) {}
    out.push({
      id: ev.getId(),
      recurring: recurring,
      seriesId: seriesId,
      title: ev.getTitle(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      dateLabel: Utilities.formatDate(ev.getStartTime(), tz, 'EEE, MMM d'),
      timeLabel: Utilities.formatDate(ev.getStartTime(), tz, 'h:mm a') + '–' + Utilities.formatDate(ev.getEndTime(), tz, 'h:mm a'),
      location: ev.getLocation ? (ev.getLocation() || '') : '',
      agendaDocUrl: tsgFindAgendaDocUrl_(desc),
      htmlLink: tsgCalendarEventLink_(ev, cal)
    });
  });
  out.sort(function(a, b) { return new Date(a.start) - new Date(b.start); });
  return { events: out, bestGuessId: tsgBestGuessMeeting_(out, titleHint, dueDate) };
}

// Judgment-based matching for the two auto-link features below (2026-09-10, revised same
// day per Durand: raw title-word overlap is "no good" as a matching method — it can't tell
// "Farina Di Vita Listing Agreement.pdf" is the right file for "Send Farina the listing
// agreement" any better than it can rule out an unrelated file that happens to share one
// common word. This mirrors the exact reasoning that already put tsgEstimateTask_ on Claude
// only — see the CALIBRATION comment below: "every heuristic tried performed no better than
// guessing a constant." Word overlap still narrows an otherwise-huge Drive search down to a
// short candidate list (that part is a retrieval step, not a judgment call, and Drive has no
// smaller-scope API to search by), but which candidate — if any — is genuinely the same
// real-world thing the task refers to is now Claude's call, not a shared-word count.
//
// Both matchers return null when Claude found no real candidate; otherwise
// {..., confident, rationale} where confident:false means "plausible but not certain enough
// to write unattended" — the caller Triage-flags that case instead of guessing.
// Since the 2026-09-16 efficiency pass the judgment itself rides in the SAME estimator call
// as the other fields (NEEDED_FIELDS 'driveMatch' / 'meetingMatch'): a new task costs one
// round-trip, not three. These helpers only gather the candidate lists and validate the
// model's pick. The matching rules live in TSG_ESTIMATE_SYSTEM.
/**
 * Applies one estimator answer to a task: every field in `need` that came back, the Drive
 * and calendar matches, the history line. Shared by the live add_task path and a queued
 * judgment applied later (o.deferred), which is why every write is guarded by "is the
 * field still open" — a task may have been edited between the request and the answer.
 * o: {now, source, personCreated, batchSiblings, driveCands:{files:[{url,label}]},
 *     calCands:{events:[{date,start,end,htmlLink,label}]}, deferred}
 */
function tsgApplyEstimateToTask_(doc, task, est, need, o) {
  o = o || {};
  var now = o.now || new Date().toISOString();
  task.tags = Array.isArray(task.tags) ? task.tags : [];
  if (!est || est.source === 'none' || est.source === 'queued') {
    // Claude unreachable, or the request is queued for the Routine: the estimate is
    // visibly missing until it lands, never silently defaulted.
    if (need.indexOf('estHours') !== -1) task.tags = Array.from(new Set(task.tags.concat(['needs-estimate'])));
    return [];
  }
  task.history = task.history || [];
  if (!Array.isArray(task.docs)) task.docs = [];
  const applied = [];
  // A value Durand set by hand (a history line for that field whose source is not automation)
  // is never overwritten by an answer, unless this is a forced Tidy re-run. Title / notes /
  // progress additionally give way to anything he touched after the request was queued.
  var keep = function(field) { return !o.force && tsgUserTouched_(task, field, null); };
  var touchedSince = function(field) { return !o.force && o.sinceTs && tsgUserTouched_(task, field, o.sinceTs); };
  // A hand-set value that Claude would have set materially differently is flagged, never
  // overwritten (2026-09-17 per Durand: "flag it for manual review and explain everything in
  // the note too").
  if (o.force) {
    // A forced re-run adopts Claude's values, so any open disagreement is settled by it.
    delete task.reviewFlags;
    task.tags = task.tags.filter(function(tg) { return tg !== TSG_DISAGREE_TAG; });
  }
  tsgFlagDisagreements_(task, est, need, keep, touchedSince, now, o);
  // The note is polished FIRST (per Durand); everything below was derived from that text.
  if (need.indexOf('notes') !== -1 && est.notes && est.notes !== String(task.notes || '').trim() && !touchedSince('notes') &&
      (o.reqNotes == null || tsgStripFallbackNotes_(o.reqNotes) === tsgStripFallbackNotes_(task.notes))) {
    task.history.push({ ts: now, field: 'notes', from: task.notes || null, to: est.notes, source: o.source || 'unknown' });
    task.notes = est.notes; applied.push('notes polished');
  }
  if (need.indexOf('title') !== -1 && est.title && est.title !== task.title && !touchedSince('title')) {
    task.history.push({ ts: now, field: 'title', from: task.title || null, to: est.title, source: o.source || 'unknown' });
    task.title = est.title; applied.push('title polished');
  }
  // A stated place / deadline is lifted on every pass (per Durand: "infer location and due date
  // as well"), unless Durand set that field by hand; an answer never clears one.
  if (need.indexOf('location') !== -1 && est.location && est.location !== String(task.location || '').trim() && !keep('location')) {
    task.history.push({ ts: now, field: 'location', from: task.location || null, to: est.location, source: o.source || 'unknown' });
    task.location = est.location; applied.push('location (' + est.location + ')');
  }
  if (need.indexOf('due') !== -1 && est.due && est.due !== (task.timelineEnd || '') && !keep('timelineEnd')) {
    task.history.push({ ts: now, field: 'timelineEnd', from: task.timelineEnd || null, to: est.due, source: o.source || 'unknown' });
    task.timelineEnd = est.due; task.dueOverride = true; applied.push('due (' + est.due + ')');
  }
  if (need.indexOf('estHours') !== -1 && est.estHours != null && !keep('estHours')) {
    task.estHours = est.estHours;
    task.estDays = tsgEstDays_(est.estHours, task.priority || est.priority || 'Medium');
    task.estSource = est.source;
    task.tags = task.tags.filter(function(tg) { return tg !== 'needs-estimate'; });
    applied.push('estHours (' + est.estHours + 'h)');
    // 'Triage' tag repurposed 2026-08-26: flags a task whose estimate the estimator
    // itself flagged as a genuine judgment call, so Durand knows to sanity-check it
    // rather than trust it blindly — see the Today Admin block's "Confirm delegated
    // work" line for the unrelated, differently-named delegate-confirmation rollup.
    if (est.needsConfirmation) {
      task.tags = Array.from(new Set(task.tags.concat(['Triage'])));
      applied.push('flagged for estimate confirmation (Triage)');
    }
  }
  if (need.indexOf('taskType') !== -1 && est.taskType && !keep('taskType') && est.taskType !== task.taskType) { task.taskType = est.taskType; applied.push('taskType'); }
  // Type "Claude" with nobody named: Claude is the delegate (2026-09-15). A supplied
  // delegate is never overridden.
  if (task.taskType === 'Claude' && !tsgTaskDelegate_(task)) { task.delegate = 'Claude'; applied.push('delegate (Claude)'); }
  // Progress from the notes is applied BEFORE any new steps are added: the guard below reads
  // the task as it was when the notes were judged.
  if (need.indexOf('progress') !== -1 && est.progress != null && task.status !== 'Done' && !touchedSince('progress') && !(task.subitems || []).length) {
    if (task.progress !== est.progress) task.history.push({ ts: now, field: 'progress', from: (typeof task.progress === 'number') ? task.progress : null, to: est.progress, source: o.source || 'unknown' });
    task.progress = est.progress;
    if (est.progress > 0 && task.status === 'Not Started') task.status = 'In Progress';
    applied.push('progress (' + est.progress + '%, from the notes)');
  }
  if (o.subitem) est.subitems = []; // a subtask never mints steps of its own
  if (need.indexOf('subitems') !== -1 && est.subitems && est.subitems.length) {
    // Steps already on the task are kept; only genuinely new ones are added.
    var have = (task.subitems || []).map(function(s) { return String(s && s.title || '').trim().toLowerCase(); });
    est.subitems = est.subitems.filter(function(s) { return have.indexOf(String(s.title || '').trim().toLowerCase()) === -1; });
  }
  if (need.indexOf('subitems') !== -1 && est.subitems && est.subitems.length) {
    // A person-created task's estimate is split evenly across the steps it was just
    // broken into, so the rollup and the scheduler have per-step hours to work with
    // (steps with no hours are never queued). Durand's pipeline keeps the hours on
    // the parent as before.
    var perStep = (o.personCreated && typeof task.estHours === 'number' && task.estHours > 0)
      ? Math.max(0.25, Math.round((task.estHours / est.subitems.length) * 4) / 4) : null;
    task.subitems = (task.subitems || []).concat(est.subitems.map(function(s) {
      // 2026-09-17: a minted step arrives with its own hours / type / priority from the same
      // answer, so it never needs a second call to be estimated.
      var hours = (typeof s.estHours === 'number') ? s.estHours : perStep;
      return { title: s.title, done: false, delegate: tsgDefaultSubitemDelegate_(task), status: 'Not Started',
        priority: s.priority || task.priority || 'Medium', tags: [], timelineEnd: '', progress: 0,
        depends: '', doc: '', notes: '', estHours: hours, estDays: null,
        estSource: hours != null ? 'claude' : 'none', taskType: s.taskType || 'Actionable Task',
        history: [{ ts: now, field: 'created', from: null, to: null, source: o.source || 'unknown' }] };
    }));
    applied.push('subitems (+' + est.subitems.length + ')');
  }
  // Existing open steps answered in the same call (2026-09-17, per Durand: "wait for that
  // before enriching them on their own so there's only 1 call, not 2"). Each step's answer
  // goes through the same parse and apply as a task, so hand-set protection and
  // disagreement flags work per step.
  if (!o.subitem && need.indexOf('steps') !== -1 && Array.isArray(est.steps) && est.steps.length) {
    var stepsApplied = 0;
    est.steps.forEach(function(st) {
      var guard = (o.currentSteps || []).filter(function(c) { return c && c.index === st.index; })[0] || null;
      var sub = (task.subitems || [])[st.index] || null;
      // Deferred answers: the list may have moved; fall back to the step's title at request time.
      if (guard && (!sub || String(sub.title || '') !== String(guard.title || ''))) {
        sub = (task.subitems || []).filter(function(x) { return x && String(x.title || '') === String(guard.title || ''); })[0] || null;
      }
      if (!sub || sub.done || sub.status === 'Done') return;
      var stepNeed = tsgEnrichNeedFor_(sub, { subitem: true });
      var stepEst = tsgEstimateParse_(JSON.stringify(st.answer || {}), stepNeed, sub.title, {});
      if (!stepEst || stepEst.source === 'none') return;
      tsgApplyEstimateToTask_(doc, sub, stepEst, stepNeed, { now: now, source: o.source, subitem: true, parent: task, deferred: o.deferred,
        sinceTs: o.sinceTs, force: o.force, reqNotes: guard ? String(guard.notes || '') : String(sub.notes || '').trim() });
      stepsApplied++;
    });
    if (stepsApplied) applied.push('steps (' + stepsApplied + ' re-judged)');
  }
  var fallbackFixed = false;
  if (need.indexOf('priority') !== -1 && est.priority && !keep('priority')) { if (task.priority !== est.priority) { fallbackFixed = true; task.history.push({ ts: now, field: 'priority', from: task.priority || null, to: est.priority, source: o.source || 'unknown' }); } task.priority = est.priority; applied.push('priority'); }
  if (need.indexOf('group') !== -1 && est.group && !keep('group')) { if (task.group !== est.group) { fallbackFixed = true; task.history.push({ ts: now, field: 'group', from: task.group || null, to: est.group, source: o.source || 'unknown' }); } task.group = est.group; applied.push('group'); }
  if (o.deferred && (need.indexOf('priority') !== -1 || need.indexOf('group') !== -1)) {
    // The add-time fallback (Medium / Unsorted, or a neighbour's values) wrote a
    // "could not be determined ... Please confirm." paragraph; the real answer retires it.
    var cleaned = String(task.notes || '').replace(/\n*(?:Priority|Group) (?:could not be determined by the estimator|inferred from the most similar existing task)[^]*?Please confirm\.\s*/g, '').trim();
    if (cleaned !== String(task.notes || '').trim()) { task.notes = cleaned; fallbackFixed = true; }
  }
  if (need.indexOf('dependsOnTitle') !== -1 && est.dependsOnTitle && !task.depends) {
    const depMatch = (doc.tasks || []).find(function(t) { return t && t.title === est.dependsOnTitle && t.id !== task.id; });
    if (depMatch) {
      task.depends = String(depMatch.id);
      applied.push('depends on #' + depMatch.id);
    } else if ((o.batchSiblings || []).indexOf(est.dependsOnTitle) !== -1 && !o.deferred) {
      // The dependency is a real sibling in this same batch, just not added YET
      // (it's listed later in the same bulk array, so it has no id yet). Stash a
      // placeholder the 'bulk' handler resolves to a real id once every op in the
      // batch has run — see the resolution pass right after the ops.forEach above.
      task.depends = '~title:' + est.dependsOnTitle;
      applied.push('depends on a later task in this same push ("' + est.dependsOnTitle + '") — resolving once the batch finishes');
    }
  }
  if (need.indexOf('tags') !== -1 && est.tags && est.tags.length) {
    task.tags = Array.from(new Set(task.tags.concat(est.tags)));
    applied.push('tags (' + est.tags.join(', ') + ')');
  }
  if (applied.length) {
    task.history.push({
      ts: now, field: 'auto-enriched', from: null,
      to: 'Determined ' + (o.deferred ? 'by the judgment queue' : 'automatically') + (o.force ? ' (Tidy re-run)' : '') + ': ' + applied.join(', ') + (est.rationale ? ' — ' + est.rationale : ''),
      source: o.source || 'unknown'
    });
  }

  // Drive doc auto-search (2026-09-10, matching revised same day per Durand — see
  // tsgMatchFromParsed_'s comment) per Durand: "search the drive for any relevant docs."
  // Read-only and owner-scoped — see tsgDriveCandidates_ for why (TSG's standing
  // rule: Apps Script only ever touches files Durand owns, never a shared drive or a
  // file someone else owns). Only runs when nothing was already supplied, and only
  // auto-attaches a match Claude judged HIGH-confidence; a weaker candidate gets
  // surfaced via Triage + a note instead of guessed at, same "infer, don't silently
  // default" posture as priority/group.
  if (o.driveCands) {
    var driveMatch = tsgDocFromCandidates_(o.driveCands, est.driveMatch);
    if (driveMatch && (task.doc === driveMatch.url || task.docs.some(function(d) { return d && d.url === driveMatch.url; }))) driveMatch = null; // already linked
    if (driveMatch) {
      if (driveMatch.confident) {
        task.docs.push({ url: driveMatch.url, label: driveMatch.label, type: 'doc' });
        task.history.push({ ts: now, field: 'doc-auto-linked', from: null,
          to: driveMatch.label + (driveMatch.rationale ? ' — ' + driveMatch.rationale : '') });
      } else {
        task.tags = Array.from(new Set(task.tags.concat(['Triage'])));
        task.notes = (task.notes ? task.notes + '\n\n' : '') +
          'Possible related Drive doc found ("' + driveMatch.label + '") but not confident enough to ' +
          'auto-link — review and attach manually if relevant: ' + driveMatch.url +
          (driveMatch.rationale ? ' (' + driveMatch.rationale + ')' : '');
        task.history.push({ ts: now, field: 'triage-flagged', from: null,
          to: 'Possible related Drive doc found but not auto-linked: ' + driveMatch.label });
      }
    }
  }

  // Gmail thread auto-link (2026-09-17, per Durand: "can you also search emails too?"). A
  // confident match is linked as an 'email' doc; a weaker one is noted, not Triage-flagged.
  if (o.mailCands) {
    var mailMatch = tsgMailFromCandidates_(o.mailCands, est.mailMatch);
    if (mailMatch && task.docs.some(function(d) { return d && d.url === mailMatch.url; })) mailMatch = null;
    if (mailMatch) {
      if (mailMatch.confident) {
        task.docs.push({ url: mailMatch.url, label: mailMatch.label, type: 'email' });
        task.history.push({ ts: now, field: 'email-auto-linked', from: null,
          to: mailMatch.label + (mailMatch.rationale ? ' — ' + mailMatch.rationale : '') });
      } else {
        task.history.push({ ts: now, field: 'email-candidate', from: null,
          to: 'Possible related email thread not auto-linked: "' + mailMatch.label + '" ' + mailMatch.url +
              (mailMatch.rationale ? ' (' + mailMatch.rationale + ')' : '') });
      }
    }
  }
  // Named sites (2026-09-17, per Durand: "web searches for named or recommended sites"):
  // every returned link the item does not already carry is added as a 'web' doc.
  if (Array.isArray(est.webLinks) && est.webLinks.length) {
    est.webLinks.forEach(function(w) {
      if (!w || !w.url || task.doc === w.url || task.docs.some(function(d) { return d && d.url === w.url; })) return;
      task.docs.push({ url: w.url, label: w.label || w.url, type: 'web' });
      task.history.push({ ts: now, field: 'web-auto-linked', from: null, to: (w.label || w.url) + ' — ' + w.url });
    });
  }

  // Calendar meeting auto-search-and-link (2026-09-10, matching revised same day per
  // Durand) per Durand: "search the calendar for related meetings, link them too."
  // FUTURE EVENTS ONLY (never links a task to a meeting that already happened) — same
  // window discipline as the manual picker (tsgListUpcomingMeetings_). Only for a task
  // whose resolved type is "Meeting", only when no meeting is linked yet, and only a
  // match Claude judged HIGH-confidence is auto-linked; a softer candidate is
  // Triage-flagged with a note rather than guessed at.
  if (o.calCands && task.taskType === 'Meeting' && !task.meetingDate) {
    var meetingMatch = tsgMeetingFromCandidates_(o.calCands, est.meetingMatch);
    if (meetingMatch) {
      if (meetingMatch.confident) {
        task.meetingDate = meetingMatch.date;
        task.meetingStart = meetingMatch.start;
        task.meetingEnd = meetingMatch.end;
        if (!task.docs.some(function(d) { return d.url === meetingMatch.htmlLink; })) {
          task.docs.push({ url: meetingMatch.htmlLink, label: meetingMatch.label, type: 'meeting' });
        }
        task.history.push({ ts: now, field: 'meeting-auto-linked', from: null,
          to: meetingMatch.label + (meetingMatch.rationale ? ' — ' + meetingMatch.rationale : '') });
      } else {
        task.tags = Array.from(new Set(task.tags.concat(['Triage'])));
        task.notes = (task.notes ? task.notes + '\n\n' : '') +
          'Possible related meeting found on the calendar ("' + meetingMatch.label + '") but not confident ' +
          'enough to auto-link — use "Link a meeting" on the task to confirm.' +
          (meetingMatch.rationale ? ' (' + meetingMatch.rationale + ')' : '');
        task.history.push({ ts: now, field: 'triage-flagged', from: null,
          to: 'Possible related meeting found but not auto-linked: ' + meetingMatch.label });
      }
    }
  }
  tsgSyncReviewNotes_(task);
  return applied;
}

// ---- Disagreement review (2026-09-17). One flag per field on task.reviewFlags
// [{ts, field, mine, claude, rationale, source}]; the note carries a matching "REVIEW (date):"
// paragraph regenerated after every pass; Triage puts it on the quick list. The dashboard
// resolves a flag with "Keep mine" or "Use Claude's" (approveReview clears them all).
var TSG_PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
var TSG_DISAGREE_TAG = 'Review';
function tsgMaterialDiff_(field, mine, theirs) {
  if (theirs == null || theirs === '' || mine == null || mine === '') return false;
  switch (field) {
    case 'estHours': { var a = Number(mine), b = Number(theirs); if (isNaN(a) || isNaN(b)) return false; return Math.abs(a - b) > Math.max(1, 0.5 * a); }
    case 'priority': { var ra = TSG_PRIORITY_RANK[mine], rb = TSG_PRIORITY_RANK[theirs]; if (ra == null || rb == null) return false; return Math.abs(ra - rb) >= 2; }
    case 'timelineEnd': { var da = new Date(mine + 'T12:00:00'), db = new Date(theirs + 'T12:00:00'); if (isNaN(da.getTime()) || isNaN(db.getTime())) return false; return Math.abs(da - db) / 86400000 > 3; }
    case 'progress': { var pa = Number(mine), pb = Number(theirs); if (isNaN(pa) || isNaN(pb)) return false; return Math.abs(pa - pb) >= 25; }
    default: return String(mine).trim().toLowerCase() !== String(theirs).trim().toLowerCase();
  }
}
function tsgFlagDisagreements_(task, est, need, keep, touchedSince, now, o) {
  // Hours on a task with steps are a roll-up of the steps, never a judgment to disagree with.
  var hasSteps = !!(task.subitems || []).length;
  var checks = [['estHours', 'estHours', !hasSteps && keep('estHours')], ['taskType', 'taskType', keep('taskType')], ['priority', 'priority', keep('priority')],
    ['group', 'group', keep('group')], ['location', 'location', keep('location')], ['due', 'timelineEnd', keep('timelineEnd')],
    ['progress', 'progress', !!touchedSince('progress')]];
  var flagged = [];
  checks.forEach(function(c) {
    var needKey = c[0], field = c[1];
    if (!c[2] || need.indexOf(needKey) === -1) return;
    // A pass that now agrees with the hand-set value settles any earlier flag on that field.
    task.reviewFlags = (task.reviewFlags || []).filter(function(f) { return f && f.field !== field; });
    if (!tsgMaterialDiff_(field, task[field], est[needKey])) return;
    task.reviewFlags.push({ ts: now, field: field, mine: task[field], claude: est[needKey], rationale: est.rationale || '', source: o.source || 'Claude' });
    task.history.push({ ts: now, field: 'disagreement', from: task[field], to: est[needKey], source: o.source || 'Claude' });
    flagged.push(field);
  });
  // 'Review', not 'Triage': Triage hides an item from the delegate's page, and a disagreement
  // must never take a task away from the person working it.
  if (!(task.reviewFlags || []).length) { delete task.reviewFlags; task.tags = (task.tags || []).filter(function(tg) { return tg !== TSG_DISAGREE_TAG; }); }
  else task.tags = Array.from(new Set((task.tags || []).concat([TSG_DISAGREE_TAG])));
  return flagged;
}
function tsgReviewParagraph_(f) {
  return 'REVIEW (' + String(f.ts || '').slice(0, 10) + '): Claude proposed ' + f.field + ' = ' + f.claude +
    (f.rationale ? ' because ' + String(f.rationale).replace(/\s+/g, ' ').trim() : '') + '; your value ' + f.mine +
    ' is kept. Resolve on the card: keep yours or take Claude\'s.';
}
function tsgStripReviewNotes_(notes) { return String(notes || '').replace(/\n*REVIEW \(\d{4}-\d{2}-\d{2}\): Claude proposed [^\n]*/g, '').trim(); }
function tsgSyncReviewNotes_(task) {
  var flags = (task.reviewFlags || []).filter(Boolean);
  var base = tsgStripReviewNotes_(task.notes);
  if (!flags.length) { if (base !== String(task.notes || '').trim()) task.notes = base; delete task.reviewFlags; return; }
  task.notes = (base ? base + '\n\n' : '') + flags.map(tsgReviewParagraph_).join('\n');
}

/** Notes without the add-time "could not be determined ... Please confirm." fallback paragraphs. */
function tsgStripFallbackNotes_(notes) {
  return tsgStripReviewNotes_(String(notes || '')).replace(/\n*(?:Priority|Group) (?:could not be determined by the estimator|inferred from the most similar existing task)[^]*?Please confirm\.\s*/g, '').trim();
}
/** True when a history line for `field` (after sinceTs, if given) came from a person rather than automation. */
function tsgUserTouched_(task, field, sinceTs) {
  return (task && task.history || []).some(function(h) {
    if (!h || h.field !== field) return false;
    if (sinceTs && !(String(h.ts || '') > String(sinceTs))) return false;
    var src = String(h.source || '');
    // No source = automation (the scheduler's auto-scheduled stamps, legacy rollups); every
    // hand edit since 2026-09 carries 'Durand' or a roster name.
    // Automation sources: Claude answers, Maps, the estimate roll-up, the scheduler, reminders.
    return !!src && !/^(Claude|Maps|system|rollup|Scheduler|Reminder)/i.test(src) && src !== 'unknown';
  });
}
/** The fields the estimator is told to keep unless the notes clearly justify a change. */
function tsgCurrentSnapshot_(t) {
  return { title: t.title || '', priority: t.priority || '', group: t.group || '', taskType: t.taskType || '',
    estHours: (typeof t.estHours === 'number') ? t.estHours : null, tags: (t.tags || []).filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) === -1; }),
    due: t.timelineEnd || '', location: t.location || '', status: t.status || '', delegate: tsgTaskDelegate_(t) || '',
    subitems: (t.subitems || []).map(function(s) { return s.title; }) };
}
/** Which fields a notes change (or a Tidy re-run) re-judges on an existing task. */
// 2026-09-17 per Durand ("Claude should be making judgement calls on all fields"): every
// judgment field is asked for on every pass. A value Durand set by hand still wins at apply
// time (tsgApplyEstimateToTask_), and a material disagreement is flagged for his review
// instead of being silently dropped — see tsgFlagDisagreements_.
function tsgEnrichNeedFor_(item, opts) {
  opts = opts || {};
  var sub = !!opts.subitem;
  var need = ['title', 'notes', 'tags', 'estHours', 'taskType', 'priority', 'location', 'due'];
  if (!sub) {
    need.push('subitems', 'group');
    // dependsNone: Durand cleared the dependency himself; never re-infer one.
    if (!item.depends && !item.dependsNone) need.push('dependsOnTitle');
  }
  if (!opts.progressExplicit && !(item.subitems || []).length && item.status !== 'Done' && !item.done) need.push('progress');
  return need;
}
/**
 * Re-judge one existing task from its title + notes: with a key, one estimator call applied
 * now; without one, an 'enrich' request queued for the Routine (target known, so it queues
 * itself). Used when a task's notes change (update_task, replace_all) and by request_tidy.
 */
function tsgEnrichTask_(doc, task, now, source, opts) {
  return tsgEnrichItem_(doc, task, task, null, now, source, opts);
}
/**
 * Re-judge one item (a task, or a subtask by parent + index) from its title + notes: with a
 * key, one estimator call applied now; without one, an 'enrich' request queued for the
 * Routine. Drive and calendar candidates are gathered on every pass (per Durand, "add links
 * at every update"); a link already on the item is never added twice.
 */
function tsgEnrichItem_(doc, parent, item, subIdx, now, source, opts) {
  opts = opts || {};
  var sub = subIdx != null;
  // A step's title alone is enough to estimate it (2026-09-17); a task still needs notes or a
  // forced run, since add_task already judged its blanks from the title.
  if (!String(item.notes || '').trim() && !opts.force && !opts.allowEmptyNotes && !sub) {
    // Nothing to derive from; an emptied note just resets a notes-driven bar.
    if (!opts.progressExplicit && !(item.subitems || []).length && item.status !== 'Done' && !item.done && item.progress !== 0) tsgSetProgressFromNotes_(item, 0);
    return null;
  }
  var need = (opts.need || tsgEnrichNeedFor_(item, Object.assign({ subitem: sub }, opts))).slice();
  var currentSteps = sub ? null : tsgOpenStepsSnapshot_(item, opts.stepIndices || null);
  if (currentSteps && currentSteps.length) { if (need.indexOf('steps') === -1) need.push('steps'); }
  else need = need.filter(function(f) { return f !== 'steps'; });
  if (!need.length) return null;
  var board = tsgBoardContext_(doc);
  var driveCands = null, calCands = null, mailCands = null;
  if (!opts.skipLinks) {
    driveCands = tsgDriveCandidates_(item.title);
    if (driveCands) need.push('driveMatch');
    mailCands = tsgMailCandidates_(item.title);
    if (mailCands) need.push('mailMatch');
    if (need.indexOf('webLinks') === -1) need.push('webLinks');
    if (!item.meetingDate && (item.taskType === 'Meeting' || !item.taskType || need.indexOf('taskType') !== -1)) { calCands = tsgCalendarCandidates_(item.timelineEnd); if (calCands) need.push('meetingMatch'); }
  }
  var current = tsgCurrentSnapshot_(item);
  if (sub) { current.subtask = true; current.parentTitle = parent.title; }
  if (sub && parent) current.parentNotes = String(parent.notes || '').trim().slice(0, 600);
  var context = { groups: board.groups, openTitles: board.openTitles, existingTags: board.existingTags, batchSiblings: [],
    current: current, target: { taskId: parent.id, subIdx: sub ? subIdx : undefined }, subTitle: sub ? item.title : undefined,
    driveCandidates: driveCands ? driveCands.listText : '', driveCandidateCount: driveCands ? driveCands.files.length : 0,
    calendarCandidates: calCands ? calCands.listText : '', calendarCandidateCount: calCands ? calCands.events.length : 0,
    driveList: driveCands ? driveCands.files : null, calendarList: calCands ? calCands.events : null,
    mailCandidates: mailCands ? mailCands.listText : '', mailCandidateCount: mailCands ? mailCands.threads.length : 0, mailList: mailCands ? mailCands.threads : null,
    currentSteps: currentSteps };
  var est = tsgEstimateTask_(item.title, item.notes, item.priority, need, context);
  if (est.source === 'queued' || est.source === 'none') {
    if (est.source === 'queued' && opts.force && doc.meta && doc.meta.judgments) {
      var last = doc.meta.judgments[doc.meta.judgments.length - 1];
      if (last && last.taskId === parent.id) last.force = true;
    }
    return est;
  }
  tsgApplyEstimateToTask_(doc, item, est, need, { now: now, source: source || 'Claude', force: !!opts.force, reqNotes: String(item.notes || '').trim(),
    subitem: sub, parent: parent, driveCands: driveCands, calCands: calCands, mailCands: mailCands, currentSteps: currentSteps });
  return est;
}
/** The open steps of a task as the estimator sees them (index + current values), optionally only some indices. */
function tsgOpenStepsSnapshot_(task, indices) {
  var out = [];
  (task.subitems || []).forEach(function(s, i) {
    if (!s || s.done || s.status === 'Done') return;
    if (indices && indices.indexOf(i) === -1) return;
    if (out.length >= 30) return;
    out.push({ index: i, title: s.title || '', notes: String(s.notes || '').trim().slice(0, 600),
      estHours: (typeof s.estHours === 'number') ? s.estHours : null, taskType: s.taskType || '', priority: s.priority || '',
      progress: (typeof s.progress === 'number') ? s.progress : 0, location: s.location || '', due: s.timelineEnd || '', delegate: s.delegate || '' });
  });
  return out;
}
/** One steps-only call for a task: re-judge the given open steps (all open when indices is null). */
function tsgEnrichSteps_(doc, task, now, source, indices) {
  return tsgEnrichItem_(doc, task, task, null, now, source, { need: ['steps'], stepIndices: indices, skipLinks: true, allowEmptyNotes: true });
}
/** Indices of steps that are new since prev (by title) or whose notes changed at the same index. */
function tsgChangedStepIndices_(prevSubs, nextSubs) {
  var prevTitles = (prevSubs || []).map(function(s) { return String(s && s.title || '').trim().toLowerCase(); });
  var out = [];
  (nextSubs || []).forEach(function(s, i) {
    if (!s || s.done || s.status === 'Done') return;
    var title = String(s.title || '').trim().toLowerCase();
    var isNew = prevTitles.indexOf(title) === -1;
    var q = (prevSubs || [])[i];
    var notesMoved = !!q && String(q.title || '').trim().toLowerCase() === title && tsgNotesChanged_(s, q.notes);
    if (isNew || notesMoved) out.push(i);
  });
  return out;
}

function tsgMatchFromParsed_(parsed, candidateCount) {
  if (!parsed || typeof parsed !== 'object' || parsed.index == null || parsed.index === '') return null;
  var idx = Math.floor(Number(parsed.index)) - 1; // candidates are listed 1-based for the model
  if (isNaN(idx) || idx < 0 || idx >= candidateCount) return null;
  return { idx: idx, confident: !!parsed.confident, rationale: String(parsed.rationale || '').trim() };
}

// Calendar meeting auto-search (2026-09-10) — backs the automatic half of "link a meeting":
// the add_task path (applyDataPatch_) gathers these candidates for any new task that is (or
// may turn out to be) typed "Meeting" so Durand doesn't have to open the manual picker for
// the obvious cases. FUTURE EVENTS ONLY, same as the manual picker (tsgListUpcomingMeetings_)
// — a meeting that already happened is never a useful auto-link. The window is bounded (see
// start/end below) precisely so the whole candidate list can go to Claude in one call.
function tsgCalendarCandidates_(dueDate) {
  try {
    var cal = CalendarApp.getDefaultCalendar();
    var tz = cal.getTimeZone();
    var start = new Date(); // future only, starting right now
    var end = dueDate
      ? new Date(new Date(dueDate + 'T23:59:59').getTime() + 14 * 86400000)
      : new Date(start.getTime() + 30 * 86400000);
    if (end < start) end = new Date(start.getTime() + 30 * 86400000);
    var events = cal.getEvents(start, end).filter(function(ev) { return !ev.isAllDayEvent(); });
    if (!events.length) return null;
    events = events.slice(0, 20); // keep the prompt bounded; a 20-event 2-6 week window is already generous
    // Plain objects, so a queued judgment request can carry the same list.
    var plain = events.map(function(ev) {
      return { date: Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'),
        start: Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'), end: Utilities.formatDate(ev.getEndTime(), tz, 'HH:mm'),
        htmlLink: tsgCalendarEventLink_(ev, cal), label: ev.getTitle() };
    });
    var listText = plain.map(function(ev, i) { return (i + 1) + '. "' + ev.label + '" — ' + ev.date + ' ' + ev.start + '-' + ev.end; }).join('\n');
    return { events: plain, listText: listText };
  } catch (err) {
    Logger.log('[calendarSearch] failed: ' + err.message);
    return null;
  }
}
/** The estimator's meetingMatch pick resolved against the gathered candidates. Null = no link. */
function tsgMeetingFromCandidates_(cands, match) {
  if (!cands || !match) return null;
  var ev = (cands.events || [])[match.idx];
  if (!ev) return null;
  return { date: ev.date, start: ev.start, end: ev.end, htmlLink: ev.htmlLink, label: ev.label, confident: match.confident, rationale: match.rationale };
}

// Drive doc auto-search (2026-09-10, extended same day per Durand to also read candidate
// content, not just file names — see tsgGetFileSnippet_) — backs "search the drive for any
// relevant docs" per Durand. STRICTLY read-only and owner-scoped: every query is anchored on
// `'me' in owners`, which is the actual enforcement of TSG's standing rule that Apps Script
// here must only operate on files Durand owns, never a shared drive or a file someone else
// owns — without that clause DriveApp.searchFiles() would also surface files merely shared
// WITH him. The matched file itself, and every candidate considered along the way, is only
// ever READ (name, URL, and — for the types tsgGetFileSnippet_ knows how to read — a short
// text excerpt); nothing is opened for editing, moved, renamed, or modified in any way. Word
// overlap here is ONLY a retrieval filter (Drive has no smaller way to search than
// fullText/title terms) — see tsgMatchFromParsed_'s comment for why the actual confidence
// judgment moved to Claude instead of a word count.
var TSG_DRIVE_SEARCH_STOPWORDS_RE = /\b(the|a|an|and|or|for|to|of|with|on|in|at|re|about|get|send|review|update|check|confirm|follow|up)\b/gi;
function tsgDriveSearchWords_(title) {
  return String(title || '').toLowerCase().replace(TSG_DRIVE_SEARCH_STOPWORDS_RE, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 2; });
}
// Best-effort, READ-ONLY text excerpt for a candidate file, capped short so a handful of
// candidates never blow up the prompt. Only reads types where reading is cheap and safe:
// Google Docs (native, no export step needed) and plain text/CSV files (blob decodes
// directly). Google Sheets get their first sheet's visible values, since a task is more
// likely to reference a doc/notes file than raw spreadsheet data, but it's still worth a
// look. PDFs, Word .docx, images, and anything else return '' — reading those would mean
// either an OCR conversion (which creates a NEW file, not a pure read) or a heavier parse
// this doesn't attempt; the caller falls back to judging those on file name alone. NEVER
// throws — a file that can't be read this way just contributes no excerpt.
var TSG_SNIPPET_MAX_CHARS = 600;
function tsgGetFileSnippet_(file) {
  try {
    var mime = file.getMimeType();
    var text = '';
    if (mime === MimeType.GOOGLE_DOCS) {
      text = DocumentApp.openById(file.getId()).getBody().getText();
    } else if (mime === MimeType.GOOGLE_SHEETS) {
      var sheet = SpreadsheetApp.openById(file.getId()).getSheets()[0];
      if (sheet) {
        text = sheet.getDataRange().getValues()
          .map(function(row) { return row.join(' '); }).join(' | ');
      }
    } else if (mime === 'text/plain' || mime === 'text/csv' || mime === MimeType.CSV) {
      text = file.getBlob().getDataAsString();
    }
    text = String(text || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, TSG_SNIPPET_MAX_CHARS) : '';
  } catch (err) {
    return ''; // unreadable this way — the caller judges on file name alone, never fails the search over it
  }
}
/** Files Durand owns whose title or text contains every significant word typed. Up to 15. */
function tsgDriveSearch_(q) {
  var words = String(q || '').trim().split(/\s+/).filter(function(w) { return w.length >= 2; }).slice(0, 6);
  if (!words.length) return { ok: true, files: [] };
  try {
    var clause = words.map(function(w) {
      var esc = w.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return "(title contains '" + esc + "' or fullText contains '" + esc + "')";
    }).join(' and ');
    var it = DriveApp.searchFiles("'me' in owners and trashed = false and " + clause);
    var files = [], n = 0;
    while (it.hasNext() && n < 15) {
      var f = it.next(); n++;
      var mime = ''; try { mime = f.getMimeType ? f.getMimeType() : ''; } catch (e1) {}
      var modified = ''; try { modified = f.getLastUpdated ? Utilities.formatDate(f.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd') : ''; } catch (e2) {}
      files.push({ name: f.getName(), url: f.getUrl(), mime: mime, modified: modified });
    }
    return { ok: true, files: files };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), files: [] };
  }
}
/** A label for a pasted URL: the Drive file's name for Google Drive/Docs links, else the hostname. */
function tsgLabelForUrl_(url) {
  var u = String(url || '').trim();
  if (!u) return { ok: false, error: 'empty url' };
  var m = /(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{20,})/.exec(u);
  if (/(docs|drive)\.google\.com/.test(u) && m) {
    try {
      var name = DriveApp.getFileById(m[1]).getName();
      if (name) return { ok: true, label: name, kind: 'drive' };
    } catch (err) { /* not ours, or not a file: fall through */ }
    return { ok: true, label: 'Google Drive file', kind: 'drive' };
  }
  if (/calendar\.google\.com/.test(u)) return { ok: true, label: 'Calendar event', kind: 'calendar' };
  if (/mail\.google\.com/.test(u)) return { ok: true, label: 'Gmail thread', kind: 'email' };
  if (/claude\.ai\/code\//.test(u)) return { ok: true, label: 'Claude Code session', kind: 'claude' };
  if (/claude\.ai\//.test(u)) return { ok: true, label: 'Claude chat', kind: 'claude' };
  var host = /^https?:\/\/([^\/?#]+)/i.exec(u);
  return { ok: true, label: host ? host[1].replace(/^www\./, '') : u, kind: 'web' };
}

function tsgDriveCandidates_(title) {
  var words = tsgDriveSearchWords_(title);
  // Fewer than 2 significant words is too little signal to even retrieve candidates —
  // searching Drive for one common word would return noise, not a shortlist worth judging.
  if (words.length < 2) return null;
  try {
    var q = "'me' in owners and trashed = false and (" +
      words.map(function(w) { return "fullText contains '" + w.replace(/'/g, "\\'") + "'"; }).join(' or ') + ")";
    var it = DriveApp.searchFiles(q);
    // Kept smaller than the old name-only cap (was 15) now that each candidate also costs a
    // content read — 8 real candidates is already a generous shortlist for one task.
    var candidates = [], n = 0;
    while (it.hasNext() && n < 8) { candidates.push(it.next()); n++; }
    if (!candidates.length) return null;
    // Plain objects, so a queued judgment request can carry the same list.
    var files = candidates.map(function(f) { return { url: f.getUrl(), label: f.getName(), excerpt: tsgGetFileSnippet_(f) || '' }; });
    var listText = files.map(function(f, i) {
      return (i + 1) + '. ' + f.label + (f.excerpt ? '\n   Content excerpt: "' + f.excerpt + '"' : '');
    }).join('\n');
    return { files: files, listText: listText };
  } catch (err) {
    Logger.log('[driveSearch] failed for "' + title + '": ' + err.message);
    return null;
  }
}
/** The estimator's driveMatch pick resolved against the gathered candidates. Null = no link. */
function tsgDocFromCandidates_(cands, match) {
  if (!cands || !match) return null;
  var f = (cands.files || [])[match.idx];
  if (!f) return null;
  return { url: f.url, label: f.label, confident: match.confident, rationale: match.rationale };
}

// Gmail candidates (2026-09-17, per Durand: "can you also search emails too?"). READ-ONLY on
// the signed-in owner's mailbox (the script runs as Durand): recent threads whose subject or
// body carry the task's significant words, judged by the estimator as mailMatch exactly like
// Drive candidates. Bounded: 6 threads, 300-char excerpt of the latest message, 180 days.
var TSG_MAIL_EXCERPT_CHARS = 300;
function tsgMailThreadUrl_(thread) { return 'https://mail.google.com/mail/u/0/#all/' + thread.getId(); }
function tsgMailThreadPlain_(thread) {
  var msgs = thread.getMessages() || [];
  var last = msgs[msgs.length - 1];
  var body = '';
  try { body = last ? String(last.getPlainBody() || '') : ''; } catch (e0) { body = ''; }
  body = body.replace(/\s+/g, ' ').trim().slice(0, TSG_MAIL_EXCERPT_CHARS);
  var from = ''; try { from = last ? String(last.getFrom() || '') : ''; } catch (e1) {}
  var date = ''; try { date = Utilities.formatDate(thread.getLastMessageDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); } catch (e2) {}
  return { url: tsgMailThreadUrl_(thread), label: String(thread.getFirstMessageSubject() || '(no subject)'), from: from, date: date, excerpt: body, count: msgs.length };
}
function tsgMailCandidates_(title) {
  var words = tsgDriveSearchWords_(title);
  if (words.length < 2) return null;
  try {
    var q = 'newer_than:180d ' + words.map(function(w) { return '"' + w.replace(/"/g, '') + '"'; }).join(' ');
    var threads = GmailApp.search(q, 0, 6) || [];
    if (!threads.length && words.length > 2) {
      // Every word is a strict AND in Gmail; fall back to the two longest words.
      var top = words.slice().sort(function(a, b) { return b.length - a.length; }).slice(0, 2);
      threads = GmailApp.search('newer_than:180d "' + top[0] + '" "' + top[1] + '"', 0, 6) || [];
    }
    if (!threads.length) return null;
    var plain = threads.map(tsgMailThreadPlain_);
    var listText = plain.map(function(m, i) {
      return (i + 1) + '. "' + m.label + '" — from ' + m.from + ', ' + m.date + (m.excerpt ? '\n   Excerpt: "' + m.excerpt + '"' : '');
    }).join('\n');
    return { threads: plain, listText: listText };
  } catch (err) {
    Logger.log('[mailSearch] failed for "' + title + '": ' + err.message);
    return null;
  }
}
/** The estimator's mailMatch pick resolved against the gathered candidates. Null = no link. */
function tsgMailFromCandidates_(cands, match) {
  if (!cands || !match) return null;
  var m = (cands.threads || [])[match.idx];
  if (!m) return null;
  return { url: m.url, label: m.label, confident: match.confident, rationale: match.rationale };
}
/** Link picker: recent threads matching the words typed (api=mailSearch&q=). Up to 10. */
function tsgMailSearch_(q) {
  var words = String(q || '').trim().split(/\s+/).filter(function(w) { return w.length >= 2; }).slice(0, 6);
  if (!words.length) return { ok: true, threads: [] };
  try {
    var threads = GmailApp.search(words.map(function(w) { return '"' + w.replace(/"/g, '') + '"'; }).join(' '), 0, 10) || [];
    return { ok: true, threads: threads.map(function(t) { var p = tsgMailThreadPlain_(t); delete p.excerpt; return p; }) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), threads: [] };
  }
}

// Meeting slot finder (2026-09-17, per Durand: "the option to create one between owner and
// delegate with recommended dates/times when both are available before the deadline, duration
// based on est., keeping to Google's duration buckets"). Work window 07:30-16:00 (the 07:00 /
// 16:30 admin half-hours excluded), lunch 12:00-13:00 skipped, weekdays only, never within the
// next hour. The guest's calendar is read through CalendarApp.getCalendarById (it must be shared
// with Durand, SOP 09); when it is not readable the slots are Durand-only and guestCalendar:false
// says so. At most 2 slots per day, 10 in total, in date order.
var TSG_MEETING_BUCKETS = [15, 30, 45, 60, 90, 120];
function tsgDurationBucket_(minutes) {
  var m = Number(minutes);
  if (!m || !isFinite(m) || m <= 0) return 30;
  for (var i = 0; i < TSG_MEETING_BUCKETS.length; i++) if (TSG_MEETING_BUCKETS[i] >= m) return TSG_MEETING_BUCKETS[i];
  return TSG_MEETING_BUCKETS[TSG_MEETING_BUCKETS.length - 1];
}
function tsgMeetingSlots_(guestEmail, startStr, endStr, minutes, excludeBlocks) {
  excludeBlocks = (excludeBlocks == null || excludeBlocks === '' ) ? true : !(excludeBlocks === false || excludeBlocks === '0' || excludeBlocks === 'false' || excludeBlocks === 0);
  var cal = CalendarApp.getDefaultCalendar();
  var tz = cal.getTimeZone();
  var todayIso = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var startIso = (startStr && /^\d{4}-\d{2}-\d{2}$/.test(startStr) && startStr > todayIso) ? startStr : todayIso;
  var endIso = (endStr && /^\d{4}-\d{2}-\d{2}$/.test(endStr) && endStr >= startIso) ? endStr : tsgAddDays_(startIso, 14);
  if (endIso > tsgAddDays_(startIso, 42)) endIso = tsgAddDays_(startIso, 42);
  var dur = tsgDurationBucket_(minutes);
  var start = new Date(startIso + 'T00:00:00'), end = new Date(endIso + 'T23:59:59');
  var busy = [];
  function collect(c, mine) {
    c.getEvents(start, end).forEach(function(ev) {
      if (ev.isAllDayEvent()) return;
      if (mine && ev.getMyStatus && ev.getMyStatus() === CalendarApp.GuestStatus.NO) return;
      busy.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]);
    });
  }
  collect(cal, true);
  var guestOk = false;
  guestEmail = String(guestEmail || '').trim().toLowerCase();
  if (guestEmail && guestEmail !== OWNER_EMAIL.toLowerCase()) {
    try { var gcal = CalendarApp.getCalendarById(guestEmail); if (gcal) { collect(gcal, false); guestOk = true; } }
    catch (err) { Logger.log('[meetingSlots] guest calendar unreadable for ' + guestEmail + ': ' + err.message); guestOk = false; }
  }
  var notBefore = Date.now() + 3600000;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // Preferred window first (2026-09-17, per Durand: "default the meeting time search to 9-2
  // mon-thur, show outside that only if there are no matches in that window"), then the wider
  // work window (07:30-16:00, Mon-Fri) only when the preferred one has nothing.
  // Errand / break blocks of the day template (the Today view's fixed blocks: errands 10:00,
  // lunch 12:00, relief 14:00) are treated as busy unless the caller opts in to them —
  // 2026-09-17 per Durand: "exclude errands and break blocks by default".
  var blocks = excludeBlocks ? TSG_DAY_BLOCKS : [];
  function scan(win) {
    var out = [];
    for (var d = startIso; d <= endIso && out.length < 10; d = tsgAddDays_(d, 1)) {
      var dow = new Date(d + 'T12:00:00').getDay();
      var hours = win[dow];
      if (!hours) continue;
      var perDay = 0;
      for (var hm = hours[0]; hm + dur <= hours[1] && perDay < 2; hm += 30) {
        if (blocks.some(function(b) { return hm < b[1] && hm + dur > b[0]; })) continue;
        var sDate = new Date(d + 'T' + pad(Math.floor(hm / 60)) + ':' + pad(hm % 60) + ':00');
        var sMs = sDate.getTime(), eMs = sMs + dur * 60000;
        if (sMs < notBefore) continue;
        if (busy.some(function(b) { return b[0] < eMs && b[1] > sMs; })) continue;
        out.push({ startISO: sDate.toISOString(), endISO: new Date(eMs).toISOString(),
          dateLabel: Utilities.formatDate(sDate, tz, 'EEE, MMM d'),
          timeLabel: Utilities.formatDate(sDate, tz, 'h:mm a') + '–' + Utilities.formatDate(new Date(eMs), tz, 'h:mm a') });
        perDay++;
      }
    }
    return out;
  }
  // Windows cascade (2026-09-17 per Durand): Mon-Thu 9-2 first; Mon-Thu 8-4 only when that has
  // nothing; Mon-Thu 8-4 plus Friday 10-2 only when the second has nothing either.
  var slots = [], window = '';
  for (var w = 0; w < TSG_MEETING_WINDOWS.length && !slots.length; w++) { slots = scan(TSG_MEETING_WINDOWS[w].hours); window = TSG_MEETING_WINDOWS[w].name; }
  return { ok: true, minutes: dur, guestEmail: guestEmail, guestCalendar: guestOk, start: startIso, end: endIso, window: window, excludeBlocks: excludeBlocks, slots: slots };
}
// Hours per weekday (0 = Sunday) in minutes from midnight.
var TSG_MEETING_WINDOWS = [
  { name: 'preferred', hours: { 1: [9 * 60, 14 * 60], 2: [9 * 60, 14 * 60], 3: [9 * 60, 14 * 60], 4: [9 * 60, 14 * 60] } },
  { name: 'second', hours: { 1: [8 * 60, 16 * 60], 2: [8 * 60, 16 * 60], 3: [8 * 60, 16 * 60], 4: [8 * 60, 16 * 60] } },
  { name: 'third', hours: { 1: [8 * 60, 16 * 60], 2: [8 * 60, 16 * 60], 3: [8 * 60, 16 * 60], 4: [8 * 60, 16 * 60], 5: [10 * 60, 14 * 60] } }
];
// The day template's fixed blocks at their default positions (see the dashboard's
// buildTodayFixed): errands 10:00-10:30, lunch 12:00-13:00, relief 14:00-14:20.
var TSG_DAY_BLOCKS = [[10 * 60, 10 * 60 + 30], [12 * 60, 13 * 60], [14 * 60, 14 * 60 + 20]];

// Send directions to the phone (2026-09-17, per Durand: "a send to phone button for
// directions"): a Google Maps directions link from the home base to the task's location,
// emailed to the owner's own address so it lands on the phone in Gmail. Nothing goes to any
// third party; the link itself is also returned so the dashboard can show / copy it.
function tsgDirectionsUrl_(homeBase, location, method) {
  var mode = { walk: 'walking', transit: 'transit', drive: 'driving' }[String(method || 'drive')] || 'driving';
  return 'https://www.google.com/maps/dir/?api=1' + (homeBase ? '&origin=' + encodeURIComponent(homeBase) : '') +
    '&destination=' + encodeURIComponent(location) + '&travelmode=' + mode;
}
function tsgSendDirections_(fields) {
  var location = String(fields && fields.location || '').trim();
  if (!location) return { ok: false, error: 'No location on this task' };
  var homeBase = '';
  try { homeBase = PropertiesService.getScriptProperties().getProperty('TSG_HOME_BASE') || ''; } catch (e0) {}
  var url = tsgDirectionsUrl_(homeBase, location, fields.method);
  var subject = 'Directions: ' + location;
  var body = (fields.taskTitle ? fields.taskTitle + '\n\n' : '') + 'Open in Google Maps:\n' + url + '\n\n' +
    (homeBase ? 'From: ' + homeBase + '\n' : '') + 'To: ' + location + '\n\n— TSG Task Tracker';
  MailApp.sendEmail(OWNER_EMAIL, subject, body);
  return { ok: true, url: url, sentTo: OWNER_EMAIL };
}

// FUB team roster sync (2026-09-01) — backs the dashboard's Team Roster sync, so Owner/
// Delegate dropdowns and the meeting picker's "invite delegate" default use real emails
// instead of a guessed firstname@thestawaszgroup.com pattern. Needs a Follow Up Boss API key
// (Admin > API in FUB) stored as a Script Property named FUB_API_KEY — Project Settings >
// Script Properties in the Apps Script editor, same pattern as ANTHROPIC_API_KEY above. FUB
// authenticates with HTTP Basic using the API key as the username and a blank password.
// NOTE: the exact /v1/users response shape below (users[], name vs firstName/lastName,
// status) is FUB's documented REST API but has not been exercised against a live response in
// this session — if it 401s or the shape doesn't match, tell Durand the raw error/response so
// the parsing can be corrected against what FUB actually returns. Cached for an hour since the
// team list rarely changes and this runs on every dashboard load. `id` is returned alongside
// name/email because the dashboard uses it as the stable key for detecting someone REMOVED
// from FUB (a termination signal) — matching on id survives a name or email change, which
// matching on name/email alone would not.
function tsgListFubUsers_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('fubUsers');
  if (cached) return JSON.parse(cached);
  var key = PropertiesService.getScriptProperties().getProperty('FUB_API_KEY');
  if (!key) return { ok: false, error: 'No FUB_API_KEY set in Script Properties. Add one from FUB Admin > API.' };
  var result;
  try {
    var resp = UrlFetchApp.fetch('https://api.followupboss.com/v1/users?limit=100', {
      method: 'get',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':') },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      return { ok: false, error: 'FUB API returned ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 300) };
    }
    var data = JSON.parse(resp.getContentText());
    var rawUsers = data.users || data.people || [];
    var users = rawUsers
      .filter(function(u) { return u && u.email && u.status !== 'Deactivated' && u.status !== 'Inactive'; })
      .map(function(u) {
        var name = u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
        return { id: u.id, name: name, email: u.email };
      })
      .filter(function(u) { return u.name; });
    result = { ok: true, users: users };
    cache.put('fubUsers', JSON.stringify(result), 3600);
  } catch (err) {
    result = { ok: false, error: 'FUB fetch failed: ' + err.message };
  }
  return result;
}

/**
 * EMAIL VERIFICATION FOR MEETING INVITES (2026-09-02).
 *
 * When the team roster has no email on file for someone, the meeting-invite flow falls
 * back to guessing firstname@thestawaszgroup.com — and the dashboard then pre-checks
 * "send invite" on that guess. A wrong guess means a real calendar invite goes to a
 * stranger, or into the void, on Durand's behalf. This gives the dashboard something real
 * to decide on: does this address have genuine prior correspondence with this person?
 *
 * Evidence, in order: (1) Gmail — any thread to or from that address whose sender or
 * recipient display name plausibly carries the person's first name; (2) Contacts — a
 * saved contact on that address whose name matches. Matching is deliberately loose
 * (case-insensitive first-name substring): the question is "is there any evidence this is
 * really them", not "is this an exact identity proof", and a false NEGATIVE here costs
 * only an unchecked checkbox.
 *
 * NEVER throws. Gmail/Contacts scopes may not be authorized yet, and this sits in the
 * middle of the meeting-creation flow — an unauthorized scope or a transient API error
 * must degrade to "verify manually", not break meeting creation.
 *
 * Returns { verified: boolean, reason: string }.
 */
function tsgVerifyEmailMatch_(name, email) {
  var cleanEmail = String(email || '').trim();
  var cleanName = String(name || '').trim();
  if (!cleanEmail || cleanEmail.indexOf('@') === -1) {
    return { verified: false, reason: 'no valid email address given' };
  }
  if (!cleanName) {
    return { verified: false, reason: 'no name given to match against' };
  }
  var firstName = cleanName.split(/\s+/)[0].toLowerCase();
  // Set when Gmail finds real correspondence with the address but nothing carrying the
  // person's name — a weaker finding than "verified", but more informative than "nothing
  // found", so it survives to be returned if Contacts turns up nothing either.
  var partial = null;

  function looksLikeThem(text) {
    var s = String(text || '').toLowerCase();
    if (!s) return false;
    return s.indexOf(firstName) !== -1;
  }

  try {
    var threads = GmailApp.search('(from:"' + cleanEmail + '" OR to:"' + cleanEmail + '")', 0, 5) || [];
    if (threads.length) {
      var matched = 0, msgCount = 0;
      threads.forEach(function(th) {
        var msgs = th.getMessages() || [];
        msgCount += msgs.length;
        msgs.forEach(function(m) {
          // getFrom()/getTo() come back as '"Display Name" <addr@x.com>' when a display
          // name is set, so the name check and the address check read the same strings.
          if (looksLikeThem(m.getFrom()) || looksLikeThem(m.getTo())) matched++;
        });
      });
      if (matched > 0) {
        return { verified: true, reason: 'found ' + matched + ' message' + (matched === 1 ? '' : 's') +
                 ' with a matching name across ' + threads.length + ' thread' + (threads.length === 1 ? '' : 's') };
      }
      // Correspondence exists but nothing carries the name — real, but not evidence this
      // address belongs to THIS person. Report it honestly rather than counting it.
      partial = { verified: false, reason: 'found ' + msgCount + ' message' + (msgCount === 1 ? '' : 's') +
                  ' to/from this address, but none showing the name "' + cleanName + '"' };
    }
  } catch (gmailErr) {
    return { verified: false, reason: 'could not check — verify manually' };
  }

  try {
    var contacts = ContactsApp.getContactsByEmailAddress(cleanEmail) || [];
    for (var i = 0; i < contacts.length; i++) {
      var full = '';
      try { full = contacts[i].getFullName(); } catch (nameErr) { full = ''; }
      if (looksLikeThem(full)) {
        return { verified: true, reason: 'matched saved contact "' + full + '"' };
      }
    }
  } catch (contactsErr) {
    // Contacts unavailable is not fatal — if Gmail already produced a partial finding,
    // that's still the more informative answer.
    if (partial) return partial;
    return { verified: false, reason: 'could not check — verify manually' };
  }

  if (partial) return partial;
  return { verified: false, reason: 'no contact or correspondence found' };
}

// Creates a brand-new event on Durand's default calendar. Only ever reached from the
// dashboard's create-meeting form, which requires an explicit Confirm click — never called
// with an auto-invite the user hasn't reviewed on screen first.
function tsgCreateMeeting_(fields) {
  var cal = CalendarApp.getDefaultCalendar();
  var opts = { description: fields.description || '' };
  if (fields.location) opts.location = fields.location;
  if (fields.guestEmail) opts.guests = fields.guestEmail;
  var ev = cal.createEvent(fields.title, new Date(fields.startISO), new Date(fields.endISO), opts);
  return {
    ok: true,
    id: ev.getId(),
    title: ev.getTitle(),
    start: ev.getStartTime().toISOString(),
    end: ev.getEndTime().toISOString(),
    dateLabel: Utilities.formatDate(ev.getStartTime(), cal.getTimeZone(), 'EEE, MMM d'),
    htmlLink: tsgCalendarEventLink_(ev, cal)
  };
}

// Writes the linked (sub)task back onto the meeting side: the event's own description
// always, and — since Durand asked for this specifically — any Google Doc agenda that
// description links to as well. The docs[] link on the task side (written client-side
// before this ever runs) is the durable half of "link a meeting"; this is best-effort
// enrichment on top, and failures here are reported but don't undo that task-side link.
function tsgLinkMeetingToTask_(eventId, taskTitle, taskLink) {
  var cal = CalendarApp.getDefaultCalendar();
  var ev = cal.getEventById(eventId);
  if (!ev) return { ok: false, error: 'Event not found: ' + eventId };
  var refLine = 'Linked task: ' + taskTitle + (taskLink ? ' — ' + taskLink : '');
  var desc = ev.getDescription() || '';
  if (desc.indexOf(refLine) === -1) {
    ev.setDescription((desc ? desc + '\n\n' : '') + refLine);
    desc = ev.getDescription();
  }
  var result = { ok: true, agendaUpdated: false };
  var agendaUrl = tsgFindAgendaDocUrl_(desc);
  if (agendaUrl) {
    try {
      var m = agendaUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
      if (m && m[1]) {
        var doc = DocumentApp.openById(m[1]);
        var body = doc.getBody();
        if (body.getText().indexOf(refLine) === -1) {
          body.appendParagraph(refLine);
          doc.saveAndClose();
          result.agendaUpdated = true;
          result.agendaDocUrl = agendaUrl;
        }
      }
    } catch (docErr) {
      result.agendaError = 'Could not update agenda doc: ' + docErr.message;
    }
  }
  return result;
}

// All-day calendar events that read as a full-day absence — title-matched, since
// Calendar has no dedicated "absence" event type this script can query directly.
// Returns every ISO date such an event covers, so the auto-scheduler can treat that day
// as fully booked instead of packing real task work into a day off. Deliberately kept
// separate from getCalendarHours_() above (which explicitly SKIPS all-day events for a
// different, still-valid reason: they're not a real timed meeting conflict) — the two
// functions serve different callers and conflating them would leak a fabricated
// multi-hour "meeting" into the dashboard's Today view and into
// tsgAttributeCalendarHours's title-matching.
var TSG_OOO_KEYWORDS = /\b(out.?of.?office|ooo|pto|vacation|holiday|day off|sick)\b/i;
// Google's auto-subscribed public holiday calendar. Every event on it is a holiday by
// definition, so unlike the default calendar it needs no keyword filter at all — the
// keyword list above exists only because a personal calendar has no "this is an absence"
// event type to query. Names are tried in order; the first one that resolves wins.
var TSG_HOLIDAY_CALENDAR_NAMES = ['Holidays in United States', 'Holidays in United States (Google)'];
function tsgGetOOODates_(startStr, endStr) {
  const cal = CalendarApp.getDefaultCalendar();
  const tz = cal.getTimeZone();
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T23:59:59');
  const events = cal.getEvents(start, end);
  const dates = [];

  // All-day events: getEndTime() is exclusive (midnight of the day AFTER the last
  // covered day), so the last real day is one day before it.
  function pushAllDaySpan(ev) {
    var d = Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd');
    var last = tsgAddDays_(Utilities.formatDate(ev.getEndTime(), tz, 'yyyy-MM-dd'), -1);
    var guard = 0;
    while (d <= last && guard++ < 400) { dates.push(d); d = tsgAddDays_(d, 1); }
  }

  events.forEach(function(ev) {
    if (!ev.isAllDayEvent()) return;
    if (!TSG_OOO_KEYWORDS.test(ev.getTitle() || '')) return;
    pushAllDaySpan(ev);
  });

  // Public holiday calendar (2026-09-02): a federal holiday is a day off whether or not
  // Durand also blocked it out by hand on his own calendar, and the scheduler was happily
  // packing work onto Thanksgiving. Entirely best-effort — if the calendar isn't
  // subscribed, isn't named what we expect, or can't be read, this falls straight back to
  // the default-calendar-only behavior above rather than breaking the scheduler.
  try {
    for (var n = 0; n < TSG_HOLIDAY_CALENDAR_NAMES.length; n++) {
      var found = CalendarApp.getCalendarsByName(TSG_HOLIDAY_CALENDAR_NAMES[n]) || [];
      if (!found.length) continue;
      found.forEach(function(hcal) {
        hcal.getEvents(start, end).forEach(function(ev) {
          // No keyword filter — every event on a holiday calendar IS a holiday.
          if (ev.isAllDayEvent()) pushAllDaySpan(ev);
          else dates.push(Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'));
        });
      });
      break; // first name that resolves wins — don't double-count the same holidays
    }
  } catch (err) {
    Logger.log('[ooo] holiday calendar lookup failed (falling back to default calendar only): ' + err);
  }

  return dates;
}

function doPost(e) {
  // Auth first — before e.postData is even touched, so an unauthorized caller can't
  // reach ANY side effect (no file write, no calendar event, no Claude call, nothing
  // queued into _Inbox). Applies to every target without exception, including the
  // dormant 'claude' one.
  if (!tsgCheckToken_(e)) return tsgUnauthorized_();

  const body = e.postData.contents;
  const requested = e.parameter.target || 'data';

  // Ask-Claude endpoint — must be handled before the file-write branch below.
  if (requested === 'claude') {
    return ContentService.createTextOutput(JSON.stringify(tsgClaudeEndpoint_(body)))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Tidy-with-Claude (2026-09-16, #250, per Durand: "button, and it also triggers rewrite of
  // title, and all other fields as applicable"). Returns a PROPOSAL only; the dashboard shows
  // before/after per field and applies what Durand accepts through its normal save.
  if (requested === 'tidy') {
    var tidyReq = {};
    try { tidyReq = JSON.parse(body || '{}'); } catch (err) { tidyReq = {}; }
    return ContentService.createTextOutput(JSON.stringify(tsgTidyProposal_(Number(tidyReq.taskId))))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Meeting-picker endpoints (2026-09-01) — neither touches the tracker data files, so
  // both are handled here, before the file-write whitelist below.
  if (requested === 'createMeeting') {
    var meetingFields;
    try { meetingFields = JSON.parse(body); } catch (err) { meetingFields = null; }
    if (!meetingFields || !meetingFields.title || !meetingFields.startISO || !meetingFields.endISO) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Missing title/startISO/endISO' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var createResult;
    try { createResult = tsgCreateMeeting_(meetingFields); }
    catch (createErr) { createResult = { ok: false, error: 'Could not create meeting: ' + createErr.message }; }
    return ContentService.createTextOutput(JSON.stringify(createResult)).setMimeType(ContentService.MimeType.JSON);
  }
  if (requested === 'sendDirections') {
    var dirFields;
    try { dirFields = JSON.parse(body || '{}'); } catch (err) { dirFields = {}; }
    var dirResult;
    try { dirResult = tsgSendDirections_(dirFields); }
    catch (dirErr) { dirResult = { ok: false, error: 'Could not send directions: ' + dirErr.message }; }
    return ContentService.createTextOutput(JSON.stringify(dirResult)).setMimeType(ContentService.MimeType.JSON);
  }
  if (requested === 'linkMeeting') {
    var linkFields;
    try { linkFields = JSON.parse(body); } catch (err) { linkFields = null; }
    if (!linkFields || !linkFields.eventId || !linkFields.taskTitle) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Missing eventId/taskTitle' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var linkResult;
    try { linkResult = tsgLinkMeetingToTask_(linkFields.eventId, linkFields.taskTitle, linkFields.taskLink); }
    catch (linkErr) { linkResult = { ok: false, error: 'Could not link meeting: ' + linkErr.message }; }
    return ContentService.createTextOutput(JSON.stringify(linkResult)).setMimeType(ContentService.MimeType.JSON);
  }

  // Strict whitelist. This used to fall through to 'data' for anything unrecognized,
  // which meant a typo'd or unknown target silently overwrote the entire task database
  // with whatever was posted. Unknown targets are now rejected.
  if (requested === 'html') {
    // Retired 2026-09-14: the dashboard ships inside the script project via clasp push
    // (see doGet). The old Drive copy is no longer what doGet serves, so writing it would
    // only mislead. Rejected loudly rather than silently ignored.
    return ContentService.createTextOutput(JSON.stringify({
      ok: false, error: 'target=html is retired: the dashboard is deployed with clasp push (npm run deploy), not written to Drive.'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  if (['data', 'rulesets'].indexOf(requested) === -1) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false, error: 'Unknown target: ' + requested + '. Expected data, rulesets, claude, tidy, createMeeting, linkMeeting or sendDirections.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Validate BEFORE writing — parsing after setContent meant malformed JSON was already
  // on disk by the time it threw.
  if (requested !== 'html') {
    try { JSON.parse(body); }
    catch (err) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'Refused to write ' + requested + ': body is not valid JSON (' + err.message + ')'
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Task data no longer gets written here directly, and there is exactly one way a task
  // gets added to the board. Two shapes come through this endpoint:
  //   - a whole document (has .tasks) — the dashboard's own full-state save. Wrapped as a
  //     "replace_all" patch, version-checked against what's already on disk.
  //   - a single op (has .op, e.g. {op:'add_task', task:{...}}) — the SAME shape a
  //     terminal-authored _Inbox file uses. Added 2026-08-26 so the dashboard's own
  //     "+ Add" button goes through this instead of pushing straight into its local array
  //     and letting the next full save carry the new task along — that second path had no
  //     dedup check and no server-assigned id. Now every task addition, from any source,
  //     runs through the same applyDataPatch_('add_task') classifier.
  // Either way it's queued into the same _Inbox folder and processed immediately by the
  // same locked pipeline in processInbox_() — the Inbox is the only path that ever touches
  // the data file's contents, so a stale save comes back as an explicit conflict instead
  // of silently winning, and a duplicate task comes back merged instead of silently added.
  if (requested === 'data') {
    var payloadDoc;
    try { payloadDoc = JSON.parse(body); } catch (err) { payloadDoc = null; }
    var nonce = Utilities.getUuid();
    var isSingleOp = !!(payloadDoc && typeof payloadDoc === 'object' &&
      typeof payloadDoc.op === 'string' && !Array.isArray(payloadDoc.tasks));
    var patchObj = isSingleOp
      ? Object.assign({ target: 'data', ts: new Date().toISOString(), nonce: nonce }, payloadDoc)
      : {
          target: 'data',
          op: 'replace_all',
          ts: new Date().toISOString(),
          nonce: nonce,
          baseVersion: (payloadDoc && payloadDoc.meta && typeof payloadDoc.meta.docVersion === 'number') ? payloadDoc.meta.docVersion : undefined,
          doc: payloadDoc
        };
    try {
      DriveApp.getFolderById(INBOX_FOLDER_ID).createFile('dashboard-save-' + nonce + '.json', JSON.stringify(patchObj), 'application/json');
    } catch (writeErr) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'Could not queue save: ' + writeErr.message
      })).setMimeType(ContentService.MimeType.JSON);
    }
    tsgCacheRemove_('inboxEmptyUntil');
    var inboxRun = processInbox_();
    if (inboxRun && inboxRun.busy) {
      // The save IS queued (its inbox file exists); the tick applies it within a minute.
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'busy', reason: 'Another write is being applied; your change is queued and will apply within a minute.'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var resultDoc = null;
    try { resultDoc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString()); } catch (err) { /* fall through */ }
    var rejected = !!(resultDoc && Array.isArray(resultDoc.meta.rejectedSaves) &&
      resultDoc.meta.rejectedSaves.some(function(r) { return r.nonce === nonce; }));
    if (rejected) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'conflict', reason: 'stale',
        serverVersion: resultDoc.meta.docVersion || 0
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var addResult = (resultDoc && Array.isArray(resultDoc.meta.addResults))
      ? resultDoc.meta.addResults.slice().reverse().find(function(r) { return r.nonce === nonce; })
      : null;
    return ContentService.createTextOutput(JSON.stringify({
      ok: true, updated: 'data', docVersion: resultDoc ? (resultDoc.meta.docVersion || 0) : undefined,
      addResult: addResult || undefined
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Rulesets now goes through the SAME _Inbox-staged, lock-serialized, version-checked
  // pipeline as task data (2026-09-02). It used to be a blind whole-document setContent()
  // with no version check at all — which was defensible only while the dashboard's
  // Settings UI was the single writer. It no longer is: Claude sessions push
  // threads/current patches into _Inbox too, so the document had exactly the two
  // uncoordinated writers racing for one file that the data file's own fix was written to
  // eliminate. Same two shapes as target=data:
  //   - a whole document (has .current or .threads) — the dashboard's Settings save.
  //     Wrapped as a "replace_all" ruleset patch, version-checked against meta.docVersion.
  //   - a single op (has .op, e.g. {op:'add_thread_memory', ...}) — the same shape a
  //     terminal-authored _Inbox ruleset file already uses, passed straight through.
  if (requested === 'rulesets') {
    var rsPayload;
    try { rsPayload = JSON.parse(body); } catch (err) { rsPayload = null; }
    var rsNonce = Utilities.getUuid();
    var rsIsSingleOp = !!(rsPayload && typeof rsPayload === 'object' && typeof rsPayload.op === 'string');
    var rsPatch = rsIsSingleOp
      ? Object.assign({ target: 'rulesets', ts: new Date().toISOString(), nonce: rsNonce }, rsPayload)
      : {
          target: 'rulesets',
          op: 'replace_all',
          ts: new Date().toISOString(),
          nonce: rsNonce,
          baseVersion: (rsPayload && rsPayload.meta && typeof rsPayload.meta.docVersion === 'number') ? rsPayload.meta.docVersion : undefined,
          doc: rsPayload
        };
    try {
      DriveApp.getFolderById(INBOX_FOLDER_ID).createFile('rulesets-save-' + rsNonce + '.json', JSON.stringify(rsPatch), 'application/json');
    } catch (writeErr) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'Could not queue save: ' + writeErr.message
      })).setMimeType(ContentService.MimeType.JSON);
    }
    tsgCacheRemove_('inboxEmptyUntil');
    var inboxRunRs = processInbox_();
    if (inboxRunRs && inboxRunRs.busy) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'busy', reason: 'Another write is being applied; your change is queued and will apply within a minute.'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var rsDoc = null;
    try { rsDoc = JSON.parse(getTrackerFile_('rulesets').getBlob().getDataAsString()); } catch (err) { /* fall through */ }
    var rsMeta = (rsDoc && rsDoc.meta) || {};
    var rsRejected = !!(Array.isArray(rsMeta.rejectedSaves) &&
      rsMeta.rejectedSaves.some(function(r) { return r.nonce === rsNonce; }));
    if (rsRejected) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: 'conflict', reason: 'stale',
        serverVersion: rsMeta.docVersion || 1
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({
      ok: true, updated: 'rulesets', docVersion: rsDoc ? (rsMeta.docVersion || 1) : undefined
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // html: unchanged direct-write path. It's a separate, already-controlled push
  // mechanism with only one writer, and it isn't exposed to the dashboard-vs-Inbox race
  // that data and (as of 2026-09-02) rulesets both now route around.
  try {
    getTrackerFile_(requested).setContent(body);
  } catch (writeErr) {
    try {
      MailApp.sendEmail(OWNER_EMAIL, '[TSG Task Tracker] Write failed: ' + requested,
        'The Task Tracker failed to write "' + requested + '" at ' + new Date().toISOString() + '.\n\n' +
        'Error: ' + writeErr.message + '\n\n' +
        'The data on disk was NOT changed by this request. Check Apps Script executions for the "TSG Task Tracker API" project for the full stack trace.');
    } catch (alertErr) {
      Logger.log('Also failed to send failure alert: ' + alertErr);
    }
    return ContentService.createTextOutput(JSON.stringify({
      ok: false, error: 'Write failed: ' + writeErr.message
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // (The rulesets backup that used to run here is gone with the direct write — the
  // _Inbox pipeline in processInbox_() already snapshots rulesets on every applied write.)

  return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: requested })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Writes a timestamped snapshot of a tracker file into TRACKER_FOLDER_ID/Backups,
 * creating that subfolder on first use. Keeps the most recent MAX_BACKUPS_PER_FILE
 * snapshots per file key and trashes older ones so this doesn't grow unbounded.
 *
 * Performance (2026-09-02): this used to enumerate EVERY file in the Backups folder on
 * every single call just to work out which ones were old — an O(n) Drive listing (up to
 * 50 files per key, times every tracked key, plus anything else in the folder) on a path
 * that runs on every write, i.e. every dashboard save and every applied patch. The
 * retention state is now tracked in a Script Property instead: a JSON map of
 * key -> [fileId, ...] in creation order. A new backup pushes its id; anything past the
 * cap is trashed BY ID, no listing required. The one real folder listing still happens,
 * lazily and exactly once per key, to backfill the initial state for a key that has no
 * tracked entry yet — after that this never lists the folder again.
 *
 * Cap enforcement and trashing semantics are unchanged: same MAX_BACKUPS_PER_FILE, same
 * newest-kept/oldest-trashed ordering, same setTrashed(true).
 */
const MAX_BACKUPS_PER_FILE = 50;
const TSG_BACKUP_INDEX_PROP = 'BACKUP_INDEX';

/** Reads the tracked {key: [fileId,...]} map. Never throws — a corrupt value reads as empty. */
function tsgBackupIndex_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(TSG_BACKUP_INDEX_PROP);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    Logger.log('[backup] backup index unreadable, starting fresh: ' + err);
    return {};
  }
}

function tsgSaveBackupIndex_(index) {
  try {
    PropertiesService.getScriptProperties().setProperty(TSG_BACKUP_INDEX_PROP, JSON.stringify(index));
  } catch (err) {
    Logger.log('[backup] could not persist backup index: ' + err);
  }
}

/**
 * ONE-TIME backfill for a key with no tracked list yet: the only place this file still
 * lists the Backups folder. Returns existing snapshot ids for `key`, oldest first.
 */
function tsgBackfillBackupIds_(backups, prefix) {
  var matching = [];
  var fit = backups.getFiles();
  while (fit.hasNext()) {
    var f = fit.next();
    if (f.getName().indexOf(prefix) === 0) matching.push(f);
  }
  matching.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); }); // oldest first
  return matching.map(function (f) { return f.getId(); });
}

function backupTrackerFile_(key, payload) {
  const parent = DriveApp.getFolderById(TRACKER_FOLDER_ID);
  const it = parent.getFoldersByName('Backups');
  const backups = it.hasNext() ? it.next() : parent.createFolder('Backups');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = key + '-backup-';
  const created = backups.createFile(prefix + stamp + '.json', payload, 'application/json');

  const index = tsgBackupIndex_();
  // Lazy, once-ever backfill: only when this key has never been tracked.
  if (!Array.isArray(index[key])) index[key] = tsgBackfillBackupIds_(backups, prefix);
  index[key] = index[key].filter(function (id) { return id !== created.getId(); });
  index[key].push(created.getId()); // newest last

  while (index[key].length > MAX_BACKUPS_PER_FILE) {
    var oldest = index[key].shift();
    try {
      DriveApp.getFileById(oldest).setTrashed(true);
    } catch (err) {
      // Already trashed, already deleted, or otherwise gone — dropping it from the index
      // (which the shift() above already did) is the whole point. Don't let a stale id
      // stop the snapshot itself from succeeding.
      Logger.log('[backup] could not trash old snapshot ' + oldest + ': ' + err);
    }
  }
  tsgSaveBackupIndex_(index);
}

// 2026-09-10 per Durand: "for sub/tasks every change and its source should be logged" —
// replaces the old status-only/touchedAt-only tracking with generic before/after field
// diffing on BOTH tasks and subitems, each entry carrying who/what made the change.
// `source` comes from patch.source (e.g. "Claude" for an Inbox patch, or a specific
// scheduled task/session name) and defaults to 'Durand' for the dashboard's own direct
// edits (replace_all) or 'unknown' if a caller genuinely didn't say. tags is diffed as
// one whole-array entry rather than per-tag; every other field here is a plain scalar.
var TSG_TASK_DIFF_FIELDS = ['title', 'owner', 'delegate', 'status', 'priority', 'group', 'timelineEnd',
  'progress', 'depends', 'doc', 'notes', 'estHours', 'estDays', 'taskType', 'dueOverride', 'location', 'travelMode', 'travelMethod', 'pinned', 'dueTime', 'remindAt', 'dependsNone'];
var TSG_SUBITEM_DIFF_FIELDS = ['title', 'delegate', 'status', 'priority', 'timelineEnd',
  'progress', 'depends', 'doc', 'notes', 'estHours', 'estDays', 'taskType', 'done', 'location', 'travelMode', 'travelMethod', 'dueTime', 'remindAt'];

function tsgValuesEqual_(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
  var an = (a == null || a === '') ? null : a;
  var bn = (b == null || b === '') ? null : b;
  return an === bn;
}

/**
 * Generic before/after field diff, appended straight onto historyArr with a source
 * attribution. One entry per changed field (tags diffed as a single whole-array entry).
 * Returns the number of fields logged, for callers that want a changed-count.
 */
function tsgLogFieldChanges_(historyArr, before, after, fields, now, source) {
  var count = 0;
  fields.forEach(function(f) {
    if (!tsgValuesEqual_(before[f], after[f])) {
      historyArr.push({
        ts: now, field: f,
        from: (before[f] == null || before[f] === '') ? null : before[f],
        to: (after[f] == null || after[f] === '') ? null : after[f],
        source: source || 'unknown'
      });
      count++;
    }
  });
  if (!tsgValuesEqual_(before.tags, after.tags)) {
    historyArr.push({
      ts: now, field: 'tags',
      from: (before.tags && before.tags.length) ? before.tags.join(', ') : null,
      to: (after.tags && after.tags.length) ? after.tags.join(', ') : null,
      source: source || 'unknown'
    });
    count++;
  }
  return count;
}

/**
 * startedAt/completedAt lifecycle bookkeeping, factored out of tsgStampStatusChanges_ so
 * update_task can stamp these too (2026-09-10) — before this, only the dashboard's own
 * replace_all save ever set them, so a status change pushed via update_task (every
 * Claude-authored patch) never triggered them at all. Both are observed facts, not
 * inferences — that's what makes them usable for calibration later.
 */
function tsgStampLifecycleTimestamps_(t, now) {
  if (t.status !== 'Not Started' && !t.startedAt) t.startedAt = now;
  if (t.status === 'Done' && !t.completedAt) t.completedAt = now;
  if (t.status !== 'Done' && t.completedAt) delete t.completedAt;  // reopened
}

/**
 * Stamp field-change history onto nextTasks by diffing against prevTasks (whatever is
 * already in the doc before this save is applied). Pure function, no disk access — used
 * by applyDataPatch_'s replace_all op, inside the same locked/versioned apply as every
 * other write. This used to run in doPost by re-reading the file from disk right before
 * an unlocked overwrite, which was exactly the kind of check-then-write race the
 * dashboard's own save was otherwise guilty of; now the diff and the write happen inside
 * the same critical section. Was status-only before 2026-09-10 — now logs every real
 * field change via tsgLogFieldChanges_, source defaulted to 'Durand' by the caller since
 * a replace_all save only ever comes from the dashboard's own UI.
 */
function tsgStampStatusChanges_(prevTasks, nextTasks, now, source) {
  if (!nextTasks) return 0;
  var prevById = {};
  (prevTasks || []).forEach(function (t) { prevById[t.id] = t; });
  var changed = 0;

  nextTasks.forEach(function (t) {
    var p = prevById[t.id];
    if (!p) return;
    t.history = t.history || [];
    changed += tsgLogFieldChanges_(t.history, p, t, TSG_TASK_DIFF_FIELDS, now, source);
    tsgStampLifecycleTimestamps_(t, now);
  });

  return changed;
}

/**
 * Finding #6 (2026-08-26): a subitem used to carry no history of its own — the existing
 * convention (see add_task's "flag"-tier merge above) was to log delegation-relevant
 * notes on the PARENT task's history instead. That's fine for a narrative trail, but it
 * meant the parent's last-history timestamp got refreshed by literally anything (a note
 * edit, an estimate backfill, a tag), masking the exact staleness the dashboard's
 * "delegated tasks gone stale" alert exists to catch. Fixed in two stages: first with a
 * lightweight touchedAt timestamp (done/status changes only); now (2026-09-10, per
 * Durand — "replace touchedAt with a real subitem history") with an actual history array
 * on every subitem, diffed the same generic way as a task, with a source attribution.
 * touchedAt itself is retired — the dashboard now reads the subitem's own history
 * instead (see the staleness check in buildDelegatedAlerts/staleDelegated).
 * Subitems have no stable id (see the existing index-based .depends convention on
 * subitems elsewhere in this file), so prev/next are matched by array position; a
 * brand-new subitem (no entry at that index in prev) gets a 'created' entry on its own
 * history instead of a diff — it has no prior state to have changed from.
 */
function tsgStampSubitemTouchesForTask_(prevSubitems, nextSubitems, now, source) {
  if (!Array.isArray(nextSubitems) || !nextSubitems.length) return 0;
  var prev = Array.isArray(prevSubitems) ? prevSubitems : [];
  var changed = 0;
  nextSubitems.forEach(function (s, i) {
    s.history = Array.isArray(s.history) ? s.history : [];
    var p = prev[i];
    if (!p) {
      s.history.push({ ts: now, field: 'created', from: null, to: null, source: source || 'unknown' });
      changed++;
      return;
    }
    changed += tsgLogFieldChanges_(s.history, p, s, TSG_SUBITEM_DIFF_FIELDS, now, source);
  });
  return changed;
}

// Whole-document variant used by applyDataPatch_'s replace_all op (the dashboard's own
// save) — diffs every task's subitems by id-matched pair, same shape/spirit as
// tsgStampStatusChanges_ above. update_task/bulk go through
// tsgStampSubitemTouchesForTask_ directly instead, since there's only ever one task
// (and its pre-mutation subitems snapshot) in play there.
function tsgStampSubitemTouches_(prevTasks, nextTasks, now, source) {
  if (!nextTasks) return 0;
  var prevById = {};
  (prevTasks || []).forEach(function (t) { prevById[t.id] = t; });
  var changed = 0;
  nextTasks.forEach(function (t) {
    var p = prevById[t.id];
    if (!p) return;
    changed += tsgStampSubitemTouchesForTask_(p.subitems, t.subitems, now, source);
  });
  return changed;
}

/**
 * ============================================================================
 * SYNC-LEVEL DE-DUPLICATION — added 2026-08-24
 *
 * Two tiers, deliberately:
 *   TIER 1 — AUTO-SKIP. Near-identical titles.
 *   TIER 2 — FLAG. Same topic, different wording. These are real duplicates but no
 *            title matcher can prove it — telling them apart needed the notes. So the
 *            import gets tagged 'possible-duplicate' with a pointer in its notes, and
 *            a human calls it.
 *
 * The bracket prefix on old Google Tasks imports ("[ KW Command Support] ...") is a
 * topic label, and it is the strongest signal available. Tier 2 leans on it.
 *
 * This engine is general-purpose — it powers tsgSweepDuplicates (cleaning up
 * duplicates already on the board) and tsgAttributeCalendarHours (matching calendar
 * events to tasks). It stays even though the Google Tasks sync itself is gone.
 * ============================================================================
 */

var TSG_DEDUP = {
  autoSkip: 0.72,        // tier 1: near-identical title -> never import
  flagTitle: 0.25,       // tier 2 floor: must share at least some title substance
  flagTopic: 0.60,       // tier 2: bracket-prefix topic must line up this well
  subitemAutoSkip: 0.80, // subitem matches are short and generic — demand more
  sweepReview: 0.50,     // sweeper only: floor for "worth a human look". Below this it's
                         // noise — five different "block party X" tasks all score ~45%.
  matchClosed: false,    // a Done task never blocks a genuine re-raise
  logLimit: 200
};

var TSG_STOPWORDS = {
  'a':1,'an':1,'the':1,'and':1,'or':1,'to':1,'for':1,'of':1,'in':1,'on':1,'at':1,
  'with':1,'from':1,'by':1,'is':1,'are':1,'be':1,'this':1,'that':1,'it':1,'as':1,
  'all':1,'any':1,'please':1,'need':1,'needs':1,'make':1,'sure':1,'via':1,
  'support':1,'request':1,'update':1,'general':1,'misc':1
};

function tsgStem_(w) {
  if (w.length <= 4) return w;
  return w.replace(/(ing|ies|ed|es|s)$/, '');
}

/** The "[ Something] " prefix Google Tasks imports carry. '' when absent. */
function tsgTopicPrefix_(title) {
  var m = /^\s*\[([^\]]*)\]/.exec(String(title || ''));
  return m ? m[1] : '';
}

/** Title with the bracket prefix stripped, lowercased, punctuation flattened. */
var TSG_TITLECASE_MINOR_WORDS = ['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at',
  'to', 'from', 'by', 'in', 'of', 'vs', 'via', 'per', 'with'];
/**
 * Mechanical title cleanup — 2026-09-09 per Durand, standardizing the convention across
 * all sub/tasks: Title Case, no trailing punctuation, collapsed whitespace. Deliberately
 * NOT applied to the established "@Name - action" direct-execution convention (e.g.
 * "@Claude - get the phone number...") — that form keeps its existing lowercase-after-
 * dash phrasing untouched, per Durand's own confirmed choice.
 * Only re-cases a word that is ALREADY all-lowercase — anything carrying its own caps
 * (an acronym, a proper noun already correctly cased like "Farina Di Vita", a URL) is
 * left alone rather than risk mangling it. Does NOT reorder a title into verb-first
 * phrasing — that needs real language understanding, not string manipulation, so a
 * badly-ordered title still needs a human (or a future model-assisted pass) to rewrite.
 */
function tsgCleanTitle_(title) {
  var raw = String(title || '').trim();
  if (!raw) return raw;
  if (/^@\S+\s*-\s*/.test(raw)) return raw.replace(/\s+/g, ' ').trim();
  var cleaned = raw.replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
  var words = cleaned.split(' ');
  return words.map(function(w, i) {
    if (!w) return w;
    var lower = w.toLowerCase();
    if (w !== lower) return w;
    if (i > 0 && TSG_TITLECASE_MINOR_WORDS.indexOf(lower) !== -1) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function tsgNormalizeTitle_(title) {
  if (!title) return '';
  return String(title)
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tsgTokenize_(text) {
  var s = String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
  if (!s) return [];
  var parts = s.split(/\s+/), out = [], seen = {};
  for (var i = 0; i < parts.length; i++) {
    var w = parts[i].replace(/'s$/, '');
    if (!w || TSG_STOPWORDS[w]) continue;
    w = tsgStem_(w);
    if (w.length < 2) continue;
    if (!seen[w]) { seen[w] = 1; out.push(w); }
  }
  return out;
}

function tsgTokens_(title) { return tsgTokenize_(tsgNormalizeTitle_(title)); }

/**
 * Every token in a task's title AND its subitem titles.
 * Tier 2 matches against this rather than the title alone: once a duplicate has been
 * folded into a merged parent, the evidence lives in the subitems, not the title.
 */
function tsgFullTokens_(task) {
  var all = tsgTokens_(task.title).slice();
  var subs = task.subitems || [];
  for (var k = 0; k < subs.length; k++) {
    if (subs[k] && subs[k].title) all = all.concat(tsgTokens_(subs[k].title));
  }
  var seen = {}, uniq = [];
  for (var i = 0; i < all.length; i++) if (!seen[all[i]]) { seen[all[i]] = 1; uniq.push(all[i]); }
  return uniq;
}

/**
 * Token-set similarity, 0..1. Jaccard punishes length gaps, so a short re-import
 * scores badly against a long merged parent even when it is plainly the same work.
 * Containment covers that; take whichever reads higher.
 */
function tsgSetSimilarity_(A, B) {
  if (!A.length || !B.length) return 0;
  var setB = {};
  for (var i = 0; i < B.length; i++) setB[B[i]] = 1;
  var inter = 0;
  for (var j = 0; j < A.length; j++) if (setB[A[j]]) inter++;
  // ABSOLUTE OVERLAP FLOOR (2026-09-02). Containment is a ratio, so one or two shared
  // tokens against a short candidate scores near-perfectly — a bare first name matching a
  // one-word subitem title read as 90% "the same work" and suppressed a genuinely new,
  // unrelated task. Demand at least 3 tokens of real shared substance before ANY score is
  // returned. The exception is short-vs-short: when BOTH sides are 3 tokens or fewer,
  // three shared tokens is unreachable by construction, and those comparisons behave
  // exactly as they did before this change.
  if (inter < 3 && !(A.length <= 3 && B.length <= 3)) return 0;
  var union = A.length + B.length - inter;
  var jaccard = union ? (inter / union) : 0;
  var containment = inter / Math.min(A.length, B.length);
  return Math.max(jaccard, containment * 0.9);
}

function tsgTitleSimilarity_(a, b) {
  return tsgSetSimilarity_(tsgTokens_(a), tsgTokens_(b));
}

/** How well the incoming task's topic label matches a candidate's whole text. */
function tsgTopicSimilarity_(incomingTitle, task) {
  var topic = tsgTokenize_(tsgTopicPrefix_(incomingTitle));
  if (!topic.length) return 0;
  var hay = tsgFullTokens_(task);
  var setH = {};
  for (var j = 0; j < hay.length; j++) setH[hay[j]] = 1;
  var hit = 0;
  for (var t = 0; t < topic.length; t++) if (setH[topic[t]]) hit++;
  return hit / topic.length;
}

/**
 * Classify an incoming title against the existing board.
 * Returns {verdict:'skip'|'flag'|'new', task, score, topic, reason, via}.
 */
function tsgClassifyIncoming_(title, tasks) {
  var out = { verdict: 'new', task: null, score: 0, topic: 0, reason: '', via: '' };
  if (!title || !tasks || !tasks.length) return out;
  var normNew = tsgNormalizeTitle_(title);
  if (!normNew) return out;

  var bestSkip = null, bestSkipScore = 0, bestSkipVia = '', bestSkipReason = '';
  var bestFlag = null, bestFlagScore = 0, bestFlagTopic = 0;

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || !t.title) continue;
    var st = String(t.status || '');
    if (!TSG_DEDUP.matchClosed && (st === 'Done' || st === 'Cancelled')) continue;

    if (tsgNormalizeTitle_(t.title) === normNew) {
      return { verdict: 'skip', task: t, score: 1, topic: 1, reason: 'exact title', via: t.title };
    }

    var s = tsgTitleSimilarity_(title, t.title);
    if (s >= TSG_DEDUP.autoSkip && s > bestSkipScore) {
      bestSkipScore = s; bestSkip = t; bestSkipVia = t.title; bestSkipReason = 'title';
    }

    var subs = t.subitems || [];
    for (var k = 0; k < subs.length; k++) {
      if (!subs[k] || !subs[k].title) continue;
      // A DONE subitem must never suppress a new task (2026-09-02) — same stance as
      // TSG_DEDUP.matchClosed:false already takes for a Done parent task: a completed
      // step is evidence that work happened, not that new work is redundant.
      if (subs[k].done === true) continue;
      // A subitem whose title is only one or two real tokens ("Francini", "Send docs")
      // is too thin to be a viable duplicate-match target on its own — it will match far
      // too much. The parent-task path, which has the full title plus every subitem's
      // tokens behind it, still covers these.
      if (tsgTokens_(subs[k].title).length < 3) continue;
      var ss = tsgTitleSimilarity_(title, subs[k].title);
      if (ss >= TSG_DEDUP.subitemAutoSkip && ss > bestSkipScore) {
        bestSkipScore = ss; bestSkip = t; bestSkipVia = subs[k].title; bestSkipReason = 'subitem';
      }
    }

    // Tier 2 scores against title + subitems — see tsgFullTokens_ for why.
    var topic = tsgTopicSimilarity_(title, t);
    var deep = tsgSetSimilarity_(tsgTokens_(title), tsgFullTokens_(t));
    if (topic >= TSG_DEDUP.flagTopic && deep >= TSG_DEDUP.flagTitle) {
      var combined = topic * 0.6 + deep * 0.4;
      if (combined > bestFlagScore) { bestFlagScore = combined; bestFlag = t; bestFlagTopic = topic; }
    }
  }

  if (bestSkip) {
    return { verdict: 'skip', task: bestSkip, score: bestSkipScore, topic: 0,
             reason: bestSkipReason, via: bestSkipVia };
  }
  if (bestFlag) {
    return { verdict: 'flag', task: bestFlag, score: bestFlagScore, topic: bestFlagTopic,
             reason: 'same topic, different wording', via: bestFlag.title };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * MAINTENANCE SWEEPER — duplicates already sitting on the board.
 * Reads the data file directly (no web app round-trip), so it works
 * even if the deployment is mid-update. Only files owned by this account.
 *
 *   tsgSweepDuplicates()     -> dry run, logs what it would delete
 *   tsgSweepDuplicates(true) -> writes a delete patch into _Inbox
 *
 * Only tier-1 confidence deletes. Tier-2 pairs are logged for you to read.
 * ------------------------------------------------------------------ */
function tsgSweepDuplicates(apply) {
  tsgAssertOwner_('tsgSweepDuplicates');
  const doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  const open = (doc.tasks || []).filter(function(t) {
    var st = String(t.status || '');
    return st !== 'Done' && st !== 'Cancelled';
  });

  var hard = [], soft = [];
  for (var i = 0; i < open.length; i++) {
    for (var j = i + 1; j < open.length; j++) {
      var a = open[i], b = open[j];
      var s = tsgTitleSimilarity_(a.title, b.title);
      if (s < TSG_DEDUP.sweepReview) continue;
      // Keep the richer record: more subitems wins, then longer notes.
      var aw = (a.subitems || []).length * 100 + String(a.notes || '').length;
      var bw = (b.subitems || []).length * 100 + String(b.notes || '').length;
      var keep = aw >= bw ? a : b;
      var drop = keep === a ? b : a;
      (s >= TSG_DEDUP.autoSkip ? hard : soft).push({ keep: keep, drop: drop, score: s });
    }
  }

  soft.forEach(function(p) {
    Logger.log('[sweep] REVIEW  #' + p.drop.id + ' "' + p.drop.title + '"  ~  #' +
               p.keep.id + ' "' + p.keep.title + '"  (' + Math.round(p.score * 100) + '%)');
  });
  hard.forEach(function(p) {
    Logger.log('[sweep] DELETE  #' + p.drop.id + ' "' + p.drop.title + '"  ->  keep #' +
               p.keep.id + ' "' + p.keep.title + '"  (' + Math.round(p.score * 100) + '%)');
  });

  if (!hard.length && !soft.length) {
    Logger.log('[sweep] nothing found across ' + open.length + ' open tasks');
    return { hard: hard, soft: soft };
  }
  if (!apply) {
    Logger.log('[sweep] DRY RUN — ' + hard.length + ' deletion(s), ' + soft.length + ' for review. ' +
               'Call tsgSweepDuplicates(true) to write the patch (deletes hard matches, tags soft matches on the board).');
    return { hard: hard, soft: soft };
  }

  var seen = {}, ops = [];
  hard.forEach(function(p) {
    if (seen['hard-' + p.drop.id]) return;
    seen['hard-' + p.drop.id] = 1;
    ops.push({ op: 'delete_task', id: p.drop.id });
  });
  // Tier-2 ("soft") matches used to only ever reach Logger.log — invisible unless
  // someone happened to open the Apps Script editor's execution log right after a
  // manual run. Now every soft pair also gets tagged directly on the board, with a note
  // pointing at its counterpart, so a human catches it just by seeing the tag (2026-08-26).
  soft.forEach(function(p) {
    [[p.keep, p.drop], [p.drop, p.keep]].forEach(function(pair) {
      var t = pair[0], other = pair[1];
      var key = 'soft-' + t.id;
      if (seen[key]) return;
      seen[key] = 1;
      ops.push({
        op: 'update_task', id: t.id,
        fields: {
          tags: Array.from(new Set((t.tags || []).concat(['Possible Duplicate']))),
          history: (t.history || []).concat([{
            ts: new Date().toISOString(), field: 'possible-duplicate-flagged', from: null,
            to: 'Looks similar to #' + other.id + ' ("' + other.title + '") — ' +
                Math.round(p.score * 100) + '% title match. Not auto-merged; confirm whether these are the same thing.'
          }])
        }
      });
    });
  });
  if (!ops.length) {
    Logger.log('[sweep] nothing to write');
    return { hard: hard, soft: soft };
  }
  var name = 'sweep-duplicates-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmmss') + '.json';
  DriveApp.getFolderById(INBOX_FOLDER_ID)
    .createFile(name, JSON.stringify({ target: 'data', op: 'bulk', ops: ops }, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('[sweep] wrote ' + name + ' with ' + ops.length + ' op(s) (' + hard.length + ' delete, ' +
             soft.length + ' flag). Hit ?api=sync to apply.');
  return { hard: hard, soft: soft };
}

/**
 * ============================================================================
 * LIVE ESTIMATION — added 2026-08-24
 *
 * Estimates come from the task's own content, never from its priority.
 * Priority says how urgent something is; it says nothing about how long it takes.
 *
 * Claude is the estimator. There is deliberately NO text-based fallback heuristic.
 *
 * Why: benchmarked by leave-one-out cross-validation against the 49 hand-estimated
 * tasks on this board, every text heuristic tried came out level with guessing a
 * constant. Mean absolute error, in hours:
 *
 *     constant "2h for everything"          2.53   (within 2h: 36/49)
 *     verb-weight heuristic                 2.38   (within 2h: 33/49)
 *     reference-class forecasting + PERT    2.64   (within 2h: 28/49)
 *     strong-analogue hybrid                2.25   (within 2h: 32/49)
 *
 * No feature carries real signal either: notes length r=0.04, title length r=-0.07,
 * subitem count r=0.27, verb weight r=0.14. The tasks are too heterogeneous for
 * reference-class forecasting to find genuine analogues, and reading the task is
 * what actually produces a good number.
 *
 * A fabricated estimate no better than a coin flip is worse than a visible gap: it
 * silently feeds the capacity scheduler, which is exactly how the old priority-block
 * values did their damage. So when Claude is unreachable the task imports with NO
 * estHours and a 'needs-estimate' tag, and shows up as unestimated.
 *
 * SETUP: Project Settings → Script Properties → add
 *        ANTHROPIC_API_KEY = <your key>
 * The key lives only there. It is never in this file and never in the dashboard
 * HTML, which is served to the browser.
 * ============================================================================
 */

var TSG_CLAUDE = {
  endpoint: 'https://api.anthropic.com/v1/messages',
  version: '2023-06-01',
  model: 'claude-opus-5',   // if this 404s, tsgClaude_ self-heals — see tsgResolveModel_
  maxTokens: 1024,
  dailyCallCap: 200,            // guard on the ?target=claude endpoint
  perRunCap: 12                 // estimator/matcher calls per execution; the rest stay pending for a later run
};

// Your capacity model: 6h of real working time per day, and no single task eats the
// whole day — it shares with the 3-5 others running concurrently. Fridays run short
// (Durand: "limit Fridays to 4 hrs of task time") — only 4h of that pool is available
// on a Friday, everything else about the model is unchanged.
var TSG_CHUNK_RATE = { Critical: 4, High: 3, Medium: 2.5, Low: 2 };
var TSG_DAY_CAPACITY = 6;
var TSG_FRIDAY_CAPACITY = 4;

// Date-specific capacity lookup — anything checking how much task-time capacity a
// PARTICULAR calendar day has left should go through this, not the flat
// TSG_DAY_CAPACITY constant directly. TSG_DAY_CAPACITY itself stays as-is for the
// handful of places that need a capacity ceiling with no date attached (e.g. capping
// a priority's chunk rate before any specific day is chosen).
function tsgDayCapacity_(dateStr) {
  var dow = tsgIsoDayOfWeek_(dateStr); // 0=Sun ... 5=Fri ... 6=Sat — DST-safe parse
  return dow === 5 ? TSG_FRIDAY_CAPACITY : TSG_DAY_CAPACITY;
}

function tsgEstDays_(estHours, priority) {
  var rate = TSG_CHUNK_RATE[priority] || TSG_CHUNK_RATE.Medium;
  if (rate > TSG_DAY_CAPACITY) rate = TSG_DAY_CAPACITY;
  return Math.max(1, Math.ceil((estHours || 0) / rate));
}

function tsgApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
}

/** Lists models your key can actually reach. Run from the editor if the model id is stale. */
function tsgListModels_() {
  var key = tsgApiKey_();
  if (!key) { Logger.log('No ANTHROPIC_API_KEY in Script Properties.'); return []; }
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/models?limit=50', {
    method: 'get',
    headers: { 'x-api-key': key, 'anthropic-version': TSG_CLAUDE.version },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) { Logger.log('models: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText()); return []; }
  var ids = (JSON.parse(resp.getContentText()).data || []).map(function (m) { return m.id; });
  ids.forEach(function (id) { Logger.log(id); });
  return ids;
}

/**
 * Model ids change over time and this script will outlive the one hardcoded above.
 * On a 404 we ask the API what exists, cache the newest Sonnet in Script Properties,
 * and carry on — so a model rename never silently breaks estimation.
 */
function tsgResolveModel_() {
  // A remembered fallback id is honored only if it was remembered for the model configured
  // NOW; otherwise a stale fallback would silently outlive a deliberate model upgrade.
  try {
    var cached = JSON.parse(PropertiesService.getScriptProperties().getProperty('ANTHROPIC_MODEL_RESOLVED_V2') || 'null');
    if (cached && cached.forModel === TSG_CLAUDE.model && cached.id) return cached.id;
  } catch (err) {}
  return TSG_CLAUDE.model;
}

function tsgRememberModel_(id) {
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_MODEL_RESOLVED_V2', JSON.stringify({ forModel: TSG_CLAUDE.model, id: id }));
}

/**
 * Claude call plumbing (2026-09-16 efficiency pass, per Durand: "is there a more efficient
 * way to implement all of the claude calls?" -> "implement then deploy everything").
 *  - opts.effort ('low' | 'medium' | 'high'): Opus 5 thinks by default on every call, so the
 *    classification-shaped calls (progress-from-notes, candidate matching) run at 'low'. The
 *    full estimator, Tidy and the free-form endpoint keep the model default.
 *  - opts.schema (JSON schema): structured outputs (output_config.format) replace "return
 *    ONLY JSON" + regex as the guarantee; tsgExtractJson_ still parses the text, so a schema
 *    the API rejects (HTTP 400) is retried once without it and schemas are paused for 6 h
 *    (script cache key 'claudeNoSchema') — the prompt text still asks for JSON.
 *  - Prompt caching: the system prompt is always sent as a cache_control block, and a caller
 *    may pass `user` as an array of content blocks carrying its own marker (the estimator
 *    puts the board context first, so every task after the first in a bulk push reads it
 *    from cache). Below the model's minimum cacheable prefix (512 tokens on Opus 5) the
 *    marker is a silent no-op, never an error.
 *  - tsgClaudeMany_ sends independent requests through UrlFetchApp.fetchAll (one round-trip
 *    of wall time instead of N).
 *  - The answer is the first 'text' content block (a thinking block may precede it) and a
 *    stop_reason of 'refusal' counts as no answer.
 */
var TSG_CLAUDE_RUN_CALLS = 0;
function tsgClaudeSchemaOff_() {
  try { return CacheService.getScriptCache().get('claudeNoSchema') === '1'; } catch (err) { return false; }
}
function tsgClaudeBody_(system, user, maxTokens, opts) {
  opts = opts || {};
  var body = {
    model: tsgResolveModel_(),
    max_tokens: maxTokens || TSG_CLAUDE.maxTokens,
    system: [{ type: 'text', text: String(system || ''), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: Array.isArray(user) ? user : [{ type: 'text', text: String(user || '') }] }]
  };
  var oc = {};
  if (opts.effort) oc.effort = opts.effort;
  if (opts.schema && !opts.noSchema && !tsgClaudeSchemaOff_()) oc.format = { type: 'json_schema', schema: opts.schema };
  if (Object.keys(oc).length) body.output_config = oc;
  return body;
}
function tsgClaudeFetchOptions_(key, body) {
  return {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': TSG_CLAUDE.version },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };
}
function tsgClaudeTextOf_(resp) {
  var body;
  try { body = JSON.parse(resp.getContentText()); } catch (err) { return null; }
  if (body.stop_reason === 'refusal') { Logger.log('[claude] request refused by the model'); return null; }
  var blocks = body.content || [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b && typeof b.text === 'string' && (!b.type || b.type === 'text')) return b.text;
  }
  return null;
}
/** Single Claude call. Returns the text, or null on any failure — never throws. */
function tsgClaude_(system, user, maxTokens, _retried, opts) {
  var key = tsgApiKey_();
  if (!key) { Logger.log('[claude] no ANTHROPIC_API_KEY set'); return null; }
  if (!_retried) {
    if (TSG_CLAUDE_RUN_CALLS >= TSG_CLAUDE.perRunCap) { Logger.log('[claude] per-run cap reached; call skipped'); return null; }
    TSG_CLAUDE_RUN_CALLS++;
  }
  opts = opts || {};
  var resp;
  try {
    resp = UrlFetchApp.fetch(TSG_CLAUDE.endpoint, tsgClaudeFetchOptions_(key, tsgClaudeBody_(system, user, maxTokens, opts)));
  } catch (err) {
    Logger.log('[claude] fetch failed: ' + err.message);
    return null;
  }
  return tsgClaudeSettle_(resp, system, user, maxTokens, _retried, opts);
}
/** Shared response handling for tsgClaude_ and tsgClaudeMany_: one retry per failure class. */
function tsgClaudeSettle_(resp, system, user, maxTokens, _retried, opts) {
  var code = resp.getResponseCode();
  if ((code === 429 || code === 529 || code >= 500) && !_retried) {
    Logger.log('[claude] HTTP ' + code + '; retrying once after 2s');
    Utilities.sleep(2000);
    return tsgClaude_(system, user, maxTokens, true, opts);
  }
  if (code === 404 && !_retried) {
    var ids = tsgListModels_();
    var pick = ids.filter(function (i) { return i.indexOf('opus-5') !== -1; })[0] ||
               ids.filter(function (i) { return i.indexOf('opus') !== -1; })[0] ||
               ids.filter(function (i) { return i.indexOf('sonnet') !== -1; })[0] || ids[0];
    if (pick) {
      Logger.log('[claude] model 404; switching to ' + pick);
      tsgRememberModel_(pick);
      return tsgClaude_(system, user, maxTokens, true, opts);
    }
  }
  if (code === 400 && opts.schema && !opts.noSchema && !_retried) {
    Logger.log('[claude] HTTP 400 with a structured-output schema; retrying without it and pausing schemas for 6h: ' + resp.getContentText().slice(0, 300));
    try { CacheService.getScriptCache().put('claudeNoSchema', '1', 21600); } catch (err) {}
    return tsgClaude_(system, user, maxTokens, true, Object.assign({}, opts, { noSchema: true }));
  }
  if (code !== 200) { Logger.log('[claude] HTTP ' + code + ': ' + resp.getContentText().slice(0, 400)); return null; }
  return tsgClaudeTextOf_(resp);
}
/**
 * Several independent calls at once via UrlFetchApp.fetchAll. reqs: [{system, user,
 * maxTokens, opts}]. Returns one text-or-null per request, in order. Every request counts
 * against perRunCap; the ones past the cap come back null without being sent.
 */
function tsgClaudeMany_(reqs) {
  var out = (reqs || []).map(function() { return null; });
  if (!out.length) return out;
  var key = tsgApiKey_();
  if (!key) { Logger.log('[claude] no ANTHROPIC_API_KEY set'); return out; }
  var room = Math.max(0, TSG_CLAUDE.perRunCap - TSG_CLAUDE_RUN_CALLS);
  var take = Math.min(room, reqs.length);
  if (take < reqs.length) Logger.log('[claude] per-run cap: ' + (reqs.length - take) + ' of ' + reqs.length + ' batched calls skipped');
  if (!take) return out;
  TSG_CLAUDE_RUN_CALLS += take;
  var slice = reqs.slice(0, take);
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(slice.map(function(r) {
      var o = tsgClaudeFetchOptions_(key, tsgClaudeBody_(r.system, r.user, r.maxTokens, r.opts));
      o.url = TSG_CLAUDE.endpoint;
      return o;
    }));
  } catch (err) {
    Logger.log('[claude] fetchAll failed: ' + err.message);
    return out;
  }
  slice.forEach(function(r, i) {
    out[i] = responses[i] ? tsgClaudeSettle_(responses[i], r.system, r.user, r.maxTokens, false, r.opts || {}) : null;
  });
  return out;
}

/** Pull the first JSON object out of a model response, tolerating prose or fences. */
function tsgExtractJson_(text) {
  if (!text) return null;
  var m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (err) { return null; }
}

// Shared by the estimator (single item) and tsgProgressFromNotesMany_ (one call for a whole
// save): the rule is written once so both read progress the same way.
var TSG_PROGRESS_RULE =
  'progress — an integer 0-100: how much of this task\'s hands-on work the NOTES say is already ' +
  'done, measured against what the title and notes say the whole job is. Count only evidence of ' +
  'completed steps (past tense, "done", "sent", "received", "confirmed", checked-off items, dated ' +
  'completed actions). 0 when the notes are empty or describe only what is still to be done. 100 ' +
  'only when the notes state the work is finished. Never infer progress from elapsed time, tone, ' +
  'or how long the notes are. Prefer round numbers (0, 10, 25, 50, 75, 90, 100).';

var TSG_ESTIMATE_SYSTEM =
  'You are the sole determiner of judgment fields for tasks on the Director of Operations\' ' +
  'tracker for a residential real estate team. You will be told exactly which fields to ' +
  'determine for this task via a NEEDED_FIELDS list. Only fill in fields on that list — never ' +
  'second-guess or override a field that was already supplied. Do not guess wildly: base every ' +
  'answer on the task title, notes, and the board context you are given, and prefer a ' +
  'conservative, defensible answer over an invented one.\n\n' +
  'FIELDS YOU MAY BE ASKED FOR:\n\n' +
  'estHours + taskType + subitems — always requested together.\n' +
  'Estimate the hands-on working time for the person doing it — not elapsed calendar time, and ' +
  'not time spent waiting on someone else to reply.\n' +
  'Calibration from this team\'s own completed work:\n' +
  '- A single call, text, or short email: 0.25-0.5h\n' +
  '- Following up with one person who has gone quiet: 0.5h\n' +
  '- Reviewing one document or listing draft: 1-1.5h\n' +
  '- Editing an existing checklist or SOP: 2-3h\n' +
  '- Designing a new asset from scratch: 3-4h\n' +
  '- A decision needing tradeoff analysis and stakeholder input: 2.5-4h\n' +
  '- Configuring a system, per distinct config area: 4-8h\n' +
  '- A data migration or rebuild across many records: 6-16h\n' +
  '- Training a group, including prep and materials: 6-12h\n' +
  'Multiply for genuine repetition: a task spanning 12 agents is not a 1-agent task.\n' +
  'Do not pad. Most tasks are small. If the task is one message to one person, say 0.25.\n' +
  'subitems: NEW steps only — concrete steps actually stated or clearly implied by the title/notes ' +
  'and not already present in CURRENT_STEPS. Each is {"title", "estHours", "taskType", "priority"} ' +
  'judged by the same rules as the task\'s own fields (hands-on hours from the calibration table). ' +
  'Empty array if the task is a single atomic action. Never invent work that is not there.\n' +
  'taskType is one of: "Email"|"Call"|"Text/Chat"|"Meeting"|"Claude"|"Actionable Task". Use "Email" or ' +
  '"Call" when the whole point of the task is sending one email or making one call. Use ' +
  '"Text/Chat" for a quick message to one person (SMS or a chat ping) rather than a call or ' +
  'formal email. Use "Meeting" only when the task IS a meeting or is meant to be checked on/' +
  'discussed in one. Use "Claude" when the work itself is something Claude (the AI assistant the ' +
  'Director runs in Cowork / Claude Code sessions) would carry out end to end: drafting a document ' +
  'or email, research, a data pull or transform, tracker or Drive housekeeping, a summary. A task a ' +
  'human must physically do or decide stays "Actionable Task". Everything else is "Actionable ' +
  'Task" — this should be the majority.\n\n' +
  'priority — one of "Critical"|"High"|"Medium"|"Low".\n' +
  'Infer from real urgency and consequence signals in the title/notes (a hard deadline, money at ' +
  'risk, a person blocked, legal/compliance exposure, a client-facing commitment) — not from tone ' +
  'or exclamation points. With no signal either way, use "Medium". Do not default to "High" just ' +
  'because a task sounds important-sounding.\n\n' +
  'group — the single best-fitting existing group name from EXISTING_GROUPS, chosen by topic. ' +
  'Only propose a new group name (a short, plain, TSG-style name) if the task genuinely does not ' +
  'fit any existing group — this should be rare.\n\n' +
  'dependsOnTitle — the EXACT title of one existing OPEN task from OPEN_TASK_TITLES (or from ' +
  'BATCH_SIBLING_TITLES, tasks arriving in the same push) that this new ' +
  'task cannot start until it is done — a genuine blocking prerequisite only (e.g. "wait for the ' +
  'signed form before filing it"). Do not infer a dependency from loose thematic relatedness or ' +
  'from tasks merely being in the same group. Return null if there is no real blocking dependency, ' +
  'which will be the common case.\n\n' +
  'tags — 0 to 3 short topical tags describing what this task is actually about (a vendor, a ' +
  'campaign, a recurring workstream — not a status or priority, those are separate fields). ' +
  'Reuse an existing tag from EXISTING_TAGS whenever one genuinely fits — a real vocabulary only ' +
  'exists if the same handful of tags get reused, so prefer reuse over inventing a near-duplicate. ' +
  'Only propose a new short, plain tag if nothing existing fits; this should be uncommon. NEVER ' +
  'return any of: Triage, Review, Aging, Scheduling Stuck, Dependency Issue, needs-estimate, Claude — those ' +
  'are set by the system itself and mean something specific; returning one yourself would be wrong. ' +
  'Empty array is a completely normal answer — most tasks do not need a topical tag at all.\n\n' +
  TSG_PROGRESS_RULE + '\n\n' +
  'driveMatch — ONLY when DRIVE_CANDIDATES is given: the ONE file in the Director of Operations\' ' +
  'own Google Drive that is unambiguously the same real-world document the task concerns (the ' +
  'specific listing agreement, invoice, SOP, or similar it references) — not merely a file that ' +
  'shares a word or two with the title. Judge using the task\'s title and notes against each ' +
  'candidate\'s file name AND, where shown, a short excerpt of that file\'s actual content — an ' +
  'excerpt that clearly matches is strong evidence even if the file name is vague or generic, and ' +
  'a name that superficially matches but whose excerpt is about something else should NOT be ' +
  'picked. No excerpt shown just means that file\'s content could not be read (e.g. a PDF or ' +
  'scanned image) — judge those on name alone. If more than one candidate could plausibly be it, ' +
  'or none clearly is, return null — attaching the wrong file is worse than attaching none. Shape: ' +
  '{"index": <1-based number from DRIVE_CANDIDATES, or null>, "confident": <boolean>, "rationale": ' +
  '"<one short sentence>"}, or null. "confident" is true only when you would stake real confidence ' +
  'this is the right file; a plausible best guess you are not sure of is that index with ' +
  'confident:false.\n\n' +
  'meetingMatch — ONLY when CALENDAR_CANDIDATES is given AND the task is typed "Meeting" (supplied, ' +
  'or the taskType you are determining in this same answer); otherwise null. The ONE future event ' +
  'on the Director of Operations\' Google Calendar that is unambiguously THE meeting this task is ' +
  'about. A shared word is not enough on its own ("Vendor Sync" and "Vendor Status Sync" are not ' +
  'the same meeting) — judge whether this is genuinely the same real-world meeting, using the ' +
  'task\'s title, notes, and due date against each candidate\'s title and date/time. If more than ' +
  'one candidate could plausibly be it, or none clearly is, return null — linking the wrong meeting ' +
  'is worse than linking none. Same shape and confidence rule as driveMatch.\n\n' +
  'mailMatch — ONLY when MAIL_CANDIDATES is given: the ONE Gmail thread that is unambiguously the ' +
  'correspondence this task is about (the vendor\'s quote, the client\'s request, the invoice ' +
  'thread) — judged on subject, sender and the excerpt against the task\'s title and notes. A ' +
  'shared word is not enough. Same shape and confidence rule as driveMatch; null when unsure.\n\n' +
  'webLinks — ONLY when requested: up to 3 {"url": "...", "label": "..."} for the named tool, ' +
  'service, vendor, form page, article or reference the task explicitly involves and the reader ' +
  'would need to open (e.g. a product\'s official site, a government form page, a research ' +
  'source). Official or canonical pages only, https, real URLs you are sure exist (search the ' +
  'web when you can). Never a Google Drive, Gmail or Calendar link (those are matched separately), ' +
  'never a search-results page, never a guess. null when the task names nothing external — ' +
  'that is the usual answer.\n\n' +
  'steps — ONLY when CURRENT_STEPS is given: one entry per listed index, {"index", "title", "notes", ' +
  '"estHours", "taskType", "priority", "tags", "progress", "location", "due"}, each judged exactly as ' +
  'the same-named task field above but for THAT step (its own title and notes, read against the ' +
  'parent\'s title and notes for context). A step you have nothing to change returns its current ' +
  'values. Never drop or reorder an index; never add one that is not listed (new steps go in ' +
  '"subitems").\n\n' +
  'title — ONLY when requested: the task title rewritten as one imperative line, at most 80 ' +
  'characters, specific (who/what), keeping names, addresses and numbers. When the notes are a ' +
  'free-flow thought and the title is a placeholder, derive the title from the notes. Return the ' +
  'current title unchanged when it is already good.\n\n' +
  'notes — ONLY when requested: the notes rewritten into (1) a short "Current state" paragraph ' +
  'saying exactly where things stand, then (2) a "Log" of dated bullets, oldest first, one per ' +
  'event, each starting with its date (use TODAY for undated statements). Keep every fact, name, ' +
  'date, phone number, dollar amount and URL verbatim; drop chatter, duplicates and instructions ' +
  'that later lines superseded; never invent a fact. The raw text may be a free-flow thought — ' +
  'turn it into that structure. Return the notes unchanged when they are already clean. Do the ' +
  'notes rewrite FIRST and derive every other field from the polished notes, not from the raw text. ' +
  'For a SUBTASK (CURRENT_FIELDS carries subtask: true) the same rules apply to its own title/notes.\n\n' +
  'location — ONLY when requested: the place or street address the title/notes say the work ' +
  'happens at (an office, a property, a store, a courthouse), as a short searchable string; null ' +
  'when none is stated. Never guess one.\n\n' +
  'due — ONLY when requested: an ISO date (YYYY-MM-DD) when the title/notes state a real deadline ' +
  'or a specific day ("by Friday", "before the 20th", "on 9/22"), resolved against TODAY; null ' +
  'otherwise.\n\n' +
  'needsConfirmation — ONLY relevant when estHours is one of the requested fields; ignore this ' +
  'field otherwise. true if a human should sanity-check the estHours you gave before it\'s trusted, ' +
  'false if you\'re genuinely confident in it. Say true when: the notes are too thin to really pin ' +
  'down scope (a one-line carried-forward note with no detail on what the work actually involves), ' +
  'the task could reasonably take very different amounts of time depending on details you can\'t see ' +
  '("schedule 1:1s with each agent" could mean 20 minutes of calendar logistics or scheduling+running ' +
  'many actual meetings), the work touches legal/compliance/safety-critical territory (a contract ' +
  'form, a live production script with a safety switch, a financial/DA reconciliation), or it depends ' +
  'on coordinating with an external party whose responsiveness you cannot know. Most tasks should be ' +
  'false — reserve true for genuine judgment calls, not routine small tasks. Do not use this as a ' +
  'hedge on every answer.\n\n' +
  'Return ONLY a JSON object containing keys for exactly the fields listed in NEEDED_FIELDS (plus ' +
  'always "rationale", and "needsConfirmation" whenever estHours is requested), no prose, no ' +
  'markdown fences:\n' +
  '{"estHours": <number>, "taskType": "...", "subitems": ["step 1", "step 2"], ' +
  '"priority": "...", "group": "...", "dependsOnTitle": "<exact title>"|null, ' +
  '"tags": ["..."], "progress": <integer 0-100>, ' +
  '"driveMatch": {"index": <1-based or null>, "confident": <boolean>, "rationale": "..."}|null, ' +
  '"meetingMatch": {"index": <1-based or null>, "confident": <boolean>, "rationale": "..."}|null, ' +
  '"title": "...", "notes": "...", "location": "..."|null, "due": "YYYY-MM-DD"|null, ' +
  '"needsConfirmation": <boolean>, ' +
  '"rationale": "<one short sentence covering whatever you determined>"}';

// Set by the system itself — never something the estimator should be allowed to hand back,
// even if it ignores the instruction not to. Filtered out of parsed.tags defensively below.
var TSG_REVIEW_TAG = 'Triage';
var TSG_RESERVED_TAGS = ['Triage', 'Review', 'Aging', 'Scheduling Stuck', 'Dependency Issue', 'needs-estimate', 'Claude'];

/**
 * Review gate (2026-09-15, per Durand: "when new tasks are pushed, tag them for review
 * before sending them to delegates' views — not all tasks marked for Marj are actually
 * hers"). Anything AUTOMATION pushes that points at a person other than Durand (a task
 * owned by or assigned to them, or a subitem delegated to them) is tagged Triage (per
 * Durand, "use the triage tag so I have a quick list": the toolbar's Triage filter and the
 * alert banner already list it) and stays off that person's page until Durand clears the
 * tag on his board. So a Triage tag from ANY cause, an estimate to confirm included, keeps
 * an item off the delegate views until cleared. A task the person created themself
 * (personCreated) and Durand's own dashboard edits (replace_all) are never held.
 */
function tsgIsDelegatePerson_(name) {
  var n = String(name || '').trim().toLowerCase();
  return !!n && n !== 'durand' && n !== 'claude' && n !== 'unassigned';
}
function tsgTaskNeedsDelegateReview_(task) {
  if (tsgIsDelegatePerson_(task.owner) || tsgIsDelegatePerson_(tsgTaskDelegate_(task))) return true;
  return (task.subitems || []).some(function(s) { return s && tsgIsDelegatePerson_(s.delegate); });
}
/** The board-wide context the estimator reads group/dependency/tag answers from. */
function tsgBoardContext_(doc) {
  var tasks = (doc && doc.tasks) || [];
  return {
    groups: Array.from(new Set(tasks.map(function(t) { return t.group; }).filter(Boolean))),
    openTitles: tasks.filter(function(t) { return t.status !== 'Done'; }).map(function(t) { return t.title; }),
    existingTags: Array.from(new Set(tasks.reduce(function(acc, t) { return acc.concat(t.tags || []); }, [])))
      .filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) === -1; })
  };
}
function tsgIsHeldForReview_(item) { return !!item && (item.tags || []).indexOf(TSG_REVIEW_TAG) !== -1; }
function tsgHoldForReview_(item, historyArr, now, why) {
  if (!item || tsgIsHeldForReview_(item)) return false;
  item.tags = Array.from(new Set((item.tags || []).concat([TSG_REVIEW_TAG])));
  if (historyArr) historyArr.push({ ts: now, field: 'pending-review', from: null, to: why });
  return true;
}

/**
 * Determine one or more judgment fields for a task. Claude only — no text-heuristic fallback
 * (benchmarked against 49 hand-estimated tasks; every heuristic tried performed no better than
 * guessing a constant). If Claude is unreachable, returns nulls/empties and source:'none'; the
 * caller is responsible for a hard, clearly-tagged fallback (e.g. Medium/Unsorted + needs-review).
 *
 * @param {string} title
 * @param {string} notes
 * @param {string} priority        already-known priority, if any (passed through as context)
 * @param {string[]} [need]        which fields to determine; defaults to the original 3 for
 *                                 backward compatibility with tsgReestimate()
 * @param {{groups:string[], openTitles:string[], existingTags:string[]}} [context]  board state for group/dependency/tag inference
 * Returns {estHours, taskType, subitems, priority, group, dependsOnTitle, tags, source, rationale}.
 */
var TSG_TASK_TYPE_VALUES = ['Email', 'Call', 'Text/Chat', 'Meeting', 'Claude', 'Actionable Task'];
var TSG_PRIORITY_VALUES = ['Critical', 'High', 'Medium', 'Low'];
// Fields that are pure classification: a call asking for nothing else runs at effort 'low'.
var TSG_ESTIMATE_LOW_EFFORT_FIELDS = ['progress', 'driveMatch', 'meetingMatch', 'mailMatch'];

/** JSON schema for one estimator answer, built from the fields actually requested. */
function tsgEstimateSchema_(need) {
  function nullable(s) { return { anyOf: [s, { type: 'null' }] }; }
  var match = nullable({ type: 'object', additionalProperties: false, required: ['index', 'confident', 'rationale'],
    properties: { index: nullable({ type: 'integer' }), confident: { type: 'boolean' }, rationale: { type: 'string' } } });
  var all = {
    estHours: { type: 'number' },
    taskType: { type: 'string', enum: TSG_TASK_TYPE_VALUES },
    subitems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'estHours', 'taskType', 'priority'],
      properties: { title: { type: 'string' }, estHours: nullable({ type: 'number' }), taskType: nullable({ type: 'string', enum: TSG_TASK_TYPE_VALUES }), priority: nullable({ type: 'string', enum: TSG_PRIORITY_VALUES }) } } },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['index', 'title', 'notes', 'estHours', 'taskType', 'priority', 'tags', 'progress', 'location', 'due'],
      properties: { index: { type: 'integer' }, title: { type: 'string' }, notes: { type: 'string' }, estHours: nullable({ type: 'number' }),
        taskType: nullable({ type: 'string', enum: TSG_TASK_TYPE_VALUES }), priority: nullable({ type: 'string', enum: TSG_PRIORITY_VALUES }),
        tags: { type: 'array', items: { type: 'string' } }, progress: nullable({ type: 'integer' }), location: nullable({ type: 'string' }), due: nullable({ type: 'string' }) } } },
    priority: nullable({ type: 'string', enum: TSG_PRIORITY_VALUES }),
    group: nullable({ type: 'string' }),
    dependsOnTitle: nullable({ type: 'string' }),
    tags: { type: 'array', items: { type: 'string' } },
    progress: { type: 'integer' },
    driveMatch: match,
    meetingMatch: match,
    mailMatch: match,
    webLinks: nullable({ type: 'array', items: { type: 'object', additionalProperties: false, required: ['url', 'label'],
      properties: { url: { type: 'string' }, label: { type: 'string' } } } }),
    title: { type: 'string' },
    notes: { type: 'string' },
    location: nullable({ type: 'string' }),
    due: nullable({ type: 'string' })
  };
  var props = {}, req = [];
  need.forEach(function(f) { if (all[f]) { props[f] = all[f]; req.push(f); } });
  if (need.indexOf('estHours') !== -1) { props.needsConfirmation = { type: 'boolean' }; req.push('needsConfirmation'); }
  props.rationale = { type: 'string' }; req.push('rationale');
  return { type: 'object', additionalProperties: false, required: req, properties: props };
}

/**
 * Builds one estimator request without sending it, so tsgEstimateTask_ (one call) and
 * tsgReestimate (many in parallel through tsgClaudeMany_) share the exact same prompt.
 * Returns {system, user, maxTokens, opts, need}.
 */
function tsgEstimatePrompt_(title, notes, priority, need, context) {
  need = (need && need.length) ? need : ['estHours', 'taskType', 'subitems'];
  context = context || {};
  var clean = String(notes || '')
    .replace(/\n*Source: [\s\S]*$/, '')   // strip a legacy Google Tasks footer, if present
    .trim();

  var blocks = [];
  // The board context goes FIRST, as its own cached block: it is identical for every task in
  // a bulk push (the bulk handler computes it once), so from the second task on it is a
  // prompt-cache read instead of a full-price re-send. Task-specific text follows it.
  var wantsBoard = ['group', 'dependsOnTitle', 'tags'].some(function(f) { return need.indexOf(f) !== -1; });
  if (wantsBoard) {
    blocks.push({ type: 'text', cache_control: { type: 'ephemeral' }, text:
      'BOARD CONTEXT (shared by every task in this push)\n\n' +
      'EXISTING_GROUPS: ' + JSON.stringify(context.groups || []) + '\n\n' +
      'OPEN_TASK_TITLES: ' + JSON.stringify((context.openTitles || []).slice(0, 200)) + '\n\n' +
      'EXISTING_TAGS: ' + JSON.stringify(context.existingTags || []) });
  }
  var userParts = [
    'Task title: ' + String(title || '(untitled)'),
    'Notes:\n' + (clean || '(none)'),
    'Known priority (if already set): ' + (priority || '(not set)'),
    'TODAY: ' + tsgTodayIso_(),
    'NEEDED_FIELDS: ' + JSON.stringify(need)
  ];
  if (context.current) userParts.push('CURRENT_FIELDS (return these unchanged unless the title/notes clearly justify a change): ' + JSON.stringify(context.current));
  if (need.indexOf('dependsOnTitle') !== -1 && context.batchSiblings && context.batchSiblings.length) {
    userParts.push('BATCH_SIBLING_TITLES: ' + JSON.stringify(context.batchSiblings));
  }
  if (need.indexOf('driveMatch') !== -1) {
    userParts.push('DRIVE_CANDIDATES (files owned by the Director of Operations):\n' + (context.driveCandidates || '(none)'));
  }
  if (need.indexOf('meetingMatch') !== -1) {
    userParts.push('CALENDAR_CANDIDATES (future events only):\n' + (context.calendarCandidates || '(none)'));
  }
  if (need.indexOf('mailMatch') !== -1) {
    userParts.push('MAIL_CANDIDATES (recent Gmail threads in the Director of Operations\' mailbox):\n' + (context.mailCandidates || '(none)'));
  }
  if (need.indexOf('steps') !== -1) {
    userParts.push('CURRENT_STEPS (the open steps already on this task; answer "steps" with exactly one entry per index):\n' + JSON.stringify(context.currentSteps || []));
  }
  blocks.push({ type: 'text', text: userParts.join('\n\n') });

  var opts = { schema: tsgEstimateSchema_(need) };
  if (need.every(function(f) { return TSG_ESTIMATE_LOW_EFFORT_FIELDS.indexOf(f) !== -1; })) opts.effort = 'low';
  return { system: TSG_ESTIMATE_SYSTEM, user: blocks, maxTokens: 900, opts: opts, need: need };
}

/** Parses one estimator answer into the normalized result shape. */
function tsgEstimateParse_(raw, need, title, context) {
  context = context || {};
  var parsed = tsgExtractJson_(raw);

  if (!parsed) {
    Logger.log('[estimate] "' + title + '" -> UNESTIMATED (Claude unavailable) — needs: ' + need.join(','));
    return {
      estHours: null, taskType: null, subitems: [],
      priority: null, group: null, dependsOnTitle: null, progress: null,
      driveMatch: null, meetingMatch: null, mailMatch: null, webLinks: null, steps: null, title: null, notes: null, location: null, due: null,
      tags: ['needs-estimate'], source: 'none', rationale: null, needsConfirmation: false
    };
  }

  var out = {
    estHours: null, taskType: null, subitems: [],
    priority: null, group: null, dependsOnTitle: null, progress: null,
    driveMatch: null, meetingMatch: null, mailMatch: null, webLinks: null, steps: null, title: null, notes: null, location: null, due: null,
    tags: [], source: 'claude', rationale: parsed.rationale || null,
    // Only meaningful when estHours was actually requested/returned this call — see the
    // "Triage" tag repurpose (2026-08-26): a self-assessed low-confidence estimate gets
    // that tag added by the caller instead of a human having to notice on their own.
    needsConfirmation: false
  };

  if (need.indexOf('estHours') !== -1 && typeof parsed.estHours === 'number' && parsed.estHours > 0) {
    out.estHours = Math.max(0.25, Math.min(80, Math.round(parsed.estHours * 4) / 4));
    out.needsConfirmation = !!parsed.needsConfirmation;
  }
  if (need.indexOf('taskType') !== -1 && parsed.taskType) {
    out.taskType = parsed.taskType;
  }
  if (need.indexOf('subitems') !== -1) {
    // A string (the Routine's older answers) or an object with the step's own hours/type/priority.
    out.subitems = (parsed.subitems || []).map(function (s) { return (s && typeof s === 'object') ? s : { title: s }; })
      .filter(function (s) { return s && String(s.title || '').trim(); })
      .slice(0, 8)
      .map(function (s) {
        var o = { title: String(s.title).trim(), done: false };
        if (typeof s.estHours === 'number' && isFinite(s.estHours) && s.estHours > 0) o.estHours = Math.max(0.25, Math.round(s.estHours * 4) / 4);
        if (TSG_TASK_TYPE_VALUES.indexOf(s.taskType) !== -1) o.taskType = s.taskType;
        if (TSG_PRIORITY_VALUES.indexOf(s.priority) !== -1) o.priority = s.priority;
        return o;
      });
  }
  if (need.indexOf('steps') !== -1 && Array.isArray(parsed.steps)) {
    out.steps = parsed.steps.filter(function (st) { return st && typeof st === 'object' && Number.isInteger(st.index) && st.index >= 0; })
      .map(function (st) { return { index: st.index, answer: st }; });
  }
  if (need.indexOf('priority') !== -1 && parsed.priority) {
    out.priority = parsed.priority;
  }
  if (need.indexOf('group') !== -1 && parsed.group) {
    out.group = parsed.group;
  }
  if (need.indexOf('dependsOnTitle') !== -1 && parsed.dependsOnTitle) {
    out.dependsOnTitle = parsed.dependsOnTitle;
  }
  if (need.indexOf('progress') !== -1 && typeof parsed.progress === 'number' && isFinite(parsed.progress)) {
    out.progress = Math.max(0, Math.min(100, Math.round(parsed.progress)));
  }
  if (need.indexOf('tags') !== -1 && Array.isArray(parsed.tags)) {
    // Defensive filter, not just prompt instruction — TSG_RESERVED_TAGS carry specific
    // system meaning (Triage/Aging/etc.) and must never be handed out by the model itself.
    out.tags = parsed.tags
      .filter(function(tg) { return tg && String(tg).trim(); })
      .map(function(tg) { return String(tg).trim(); })
      .filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) === -1; })
      .slice(0, 3);
  }
  if (need.indexOf('driveMatch') !== -1) {
    out.driveMatch = tsgMatchFromParsed_(parsed.driveMatch, context.driveCandidateCount || 0);
  }
  if (need.indexOf('meetingMatch') !== -1) {
    out.meetingMatch = tsgMatchFromParsed_(parsed.meetingMatch, context.calendarCandidateCount || 0);
  }
  if (need.indexOf('mailMatch') !== -1) {
    out.mailMatch = tsgMatchFromParsed_(parsed.mailMatch, context.mailCandidateCount || 0);
  }
  if (need.indexOf('webLinks') !== -1 && Array.isArray(parsed.webLinks)) {
    var seenWeb = {};
    out.webLinks = parsed.webLinks.filter(function(w) {
      return w && typeof w.url === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(w.url.trim()) && !seenWeb[w.url.trim()] && (seenWeb[w.url.trim()] = true);
    }).map(function(w) { return { url: w.url.trim(), label: String(w.label || '').trim().slice(0, 80) || w.url.trim() }; }).slice(0, 3);
    if (!out.webLinks.length) out.webLinks = null;
  }
  if (need.indexOf('title') !== -1 && typeof parsed.title === 'string' && parsed.title.trim()) out.title = parsed.title.trim().slice(0, 120);
  if (need.indexOf('notes') !== -1 && typeof parsed.notes === 'string' && parsed.notes.trim()) out.notes = parsed.notes.trim();
  if (need.indexOf('location') !== -1 && typeof parsed.location === 'string' && parsed.location.trim()) out.location = parsed.location.trim().slice(0, 200);
  if (need.indexOf('due') !== -1 && typeof parsed.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due.trim())) out.due = parsed.due.trim();

  Logger.log('[estimate] "' + title + '" -> ' + JSON.stringify(out) + ' (claude): ' + (parsed.rationale || ''));
  return out;
}

function tsgEstimateTask_(title, notes, priority, need, context) {
  var p = tsgEstimatePrompt_(title, notes, priority, need, context);
  context = context || {};
  if (tsgJudgmentMode_()) {
    // No key: hand the request to the queue (context.target known) or back to the caller
    // (add_task queues it once the task has an id). The result is the "none" shape with
    // source 'queued' so callers fall back exactly as for an unreachable Claude.
    var req = { kind: 'enrich', need: p.need, title: String(title || ''), notes: String(notes || '').trim(), priority: priority || '',
      current: context.current || null, subTitle: context.subTitle, batchSiblings: context.batchSiblings || [], driveCandidates: context.driveList || null, calendarCandidates: context.calendarList || null, mailCandidates: context.mailList || null,
      currentSteps: context.currentSteps || null };
    var out = tsgEstimateParse_(null, p.need, title, context);
    out.source = 'queued';
    if (context.target && context.target.taskId != null) {
      req.taskId = context.target.taskId;
      if (context.target.subIdx != null) req.subIdx = context.target.subIdx;
      out.requestId = tsgQueueJudgment_(TSG_CURRENT_DOC, req);
    } else {
      out.request = req;
    }
    return out;
  }
  var raw = tsgClaude_(p.system, p.user, p.maxTokens, false, p.opts);
  return tsgEstimateParse_(raw, p.need, title, context);
}

/**
 * Progress read from the notes (2026-09-15, per Durand: "progress should be autocalculated
 * based on notes"). One estimator call with NEEDED_FIELDS = ["progress"]. Returns an integer
 * 0-100, or null when there is nothing to read or Claude is unavailable, so a caller can
 * leave the stored value alone. Empty notes are 0 without a call.
 */
function tsgProgressFromNotes_(title, notes, priority, target) {
  var clean = String(notes || '').trim();
  if (!clean) return 0;
  if (tsgJudgmentMode_()) {
    if (target && target.taskId != null) tsgQueueJudgment_(TSG_CURRENT_DOC, { kind: 'progress', taskId: target.taskId, subIdx: (target.subIdx == null) ? undefined : target.subIdx, title: String(title || ''), notes: clean, priority: priority || '' });
    return null;
  }
  var est = tsgEstimateTask_(title, clean, priority || '', ['progress'], {});
  return (est && est.source !== 'none' && est.progress != null) ? est.progress : null;
}

/**
 * Progress follows the notes, board-wide (2026-09-15, per Durand: "the progress from notes
 * should be on my tracker too"). Called from every path that can change notes: update_task,
 * update_subitem, replace_all (the dashboard's own save) and, through NEEDED_FIELDS, add_task.
 * Re-reads only an OPEN item WITHOUT subitems whose notes actually changed and whose
 * progress was not set explicitly in the same write (an explicit number always wins). A
 * task with subitems takes its bar from them, so it is skipped. Claude unavailable leaves
 * the stored value alone. The first sign of progress moves a Not Started item to In
 * Progress. Returns true when progress was set.
 */
function tsgProgressWanted_(item, prevNotes, progressExplicit) {
  if (!item || progressExplicit) return false;
  if (item.subitems && item.subitems.length) return false;
  var status = item.done ? 'Done' : (item.status || 'Not Started');
  if (status === 'Done') return false;
  var nextNotes = String(item.notes || '').trim();
  return nextNotes !== String(prevNotes || '').trim();
}
function tsgSetProgressFromNotes_(item, pct) {
  var status = item.done ? 'Done' : (item.status || 'Not Started');
  item.progress = pct;
  if (pct > 0 && status === 'Not Started') item.status = 'In Progress';
}
function tsgApplyProgressFromNotes_(item, prevNotes, progressExplicit, target) {
  if (!tsgProgressWanted_(item, prevNotes, progressExplicit)) return false;
  var pct = tsgProgressFromNotes_(item.title, String(item.notes || '').trim(), item.priority, target);
  if (pct == null) return false;
  tsgSetProgressFromNotes_(item, pct);
  return true;
}

// Many items in one call (2026-09-16): a dashboard save that changed the notes on several
// items used to cost one estimator call each; now every item whose notes changed goes to
// Claude in a single request (20 per request; more than that fans out through fetchAll).
var TSG_PROGRESS_MANY_SYSTEM =
  'You read progress from task notes on the Director of Operations\' tracker for a residential ' +
  'real estate team. For EACH numbered item in ITEMS determine ' + TSG_PROGRESS_RULE + '\n\n' +
  'Judge every item on its own notes only. Return ONLY JSON, no prose, no fences: ' +
  '{"items": [{"index": <the item\'s 1-based number>, "progress": <integer 0-100>}, ...]} with one entry per item.';
var TSG_PROGRESS_MANY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'progress'],
    properties: { index: { type: 'integer' }, progress: { type: 'integer' } } } } }
};
/** items: [{title, notes, priority}]. Returns one integer-or-null per item (0 for empty notes, no call). */
function tsgProgressFromNotesMany_(items) {
  var out = (items || []).map(function() { return null; });
  var idxs = [];
  (items || []).forEach(function(it, i) { if (String(it && it.notes || '').trim()) idxs.push(i); else out[i] = 0; });
  if (!idxs.length) return out;
  if (tsgJudgmentMode_()) {
    idxs.forEach(function(i) { tsgProgressFromNotes_(items[i].title, items[i].notes, items[i].priority, items[i].target); });
    return out;
  }
  if (idxs.length === 1) {
    var one = items[idxs[0]];
    out[idxs[0]] = tsgProgressFromNotes_(one.title, one.notes, one.priority, one.target);
    return out;
  }
  var CHUNK = 20, chunks = [], reqs = [];
  for (var s = 0; s < idxs.length; s += CHUNK) {
    var chunk = idxs.slice(s, s + CHUNK);
    chunks.push(chunk);
    var text = chunk.map(function(i, k) {
      var it = items[i];
      return (k + 1) + '. Title: ' + String(it.title || '(untitled)') + '\n   Notes: ' + String(it.notes).trim().replace(/\n/g, '\n   ');
    }).join('\n\n');
    reqs.push({ system: TSG_PROGRESS_MANY_SYSTEM, user: 'ITEMS:\n\n' + text, maxTokens: 600, opts: { effort: 'low', schema: TSG_PROGRESS_MANY_SCHEMA } });
  }
  var raws = reqs.length === 1
    ? [tsgClaude_(reqs[0].system, reqs[0].user, reqs[0].maxTokens, false, reqs[0].opts)]
    : tsgClaudeMany_(reqs);
  chunks.forEach(function(chunk, c) {
    var parsed = tsgExtractJson_(raws[c]);
    var rows = (parsed && Array.isArray(parsed.items)) ? parsed.items : [];
    rows.forEach(function(r) {
      var k = Math.floor(Number(r && r.index)) - 1;
      if (k >= 0 && k < chunk.length && r && typeof r.progress === 'number' && isFinite(r.progress)) {
        out[chunk[k]] = Math.max(0, Math.min(100, Math.round(r.progress)));
      }
    });
  });
  return out;
}
/** replace_all variant: pairs tasks by id and subitems by index, like the history stamping does; one call for the lot. */
/** An OPEN item whose notes actually changed (subitems or not). */
function tsgNotesChanged_(item, prevNotes) {
  if (!item) return false;
  var status = item.done ? 'Done' : (item.status || 'Not Started');
  if (status === 'Done') return false;
  return String(item.notes || '').trim() !== String(prevNotes || '').trim();
}
function tsgApplyProgressFromNotesOnSave_(prevTasks, nextTasks, doc, now) {
  var prevById = {};
  (prevTasks || []).forEach(function(t) { if (t) prevById[t.id] = t; });
  var wanted = [], enrichTasks = [];
  (nextTasks || []).forEach(function(t) {
    if (!t) return;
    var p = prevById[t.id];
    var explicitProgress = !!p && !tsgValuesEqual_(p.progress, t.progress);
    var ps = (p && Array.isArray(p.subitems)) ? p.subitems : [];
    if (tsgNotesChanged_(t, p ? p.notes : '')) {
      // One call: the parent's enrich carries every open step (2026-09-17).
      enrichTasks.push({ task: t, progressExplicit: explicitProgress });
      return;
    }
    // Parent unchanged: the new or changed steps share one steps-only call.
    var idx = tsgChangedStepIndices_(ps, t.subitems);
    if (idx.length) enrichTasks.push({ task: t, stepIndices: idx });
  });
  if (doc) enrichTasks.forEach(function(x) {
    if (x.stepIndices) tsgEnrichSteps_(doc, x.task, now || new Date().toISOString(), 'Durand', x.stepIndices);
    else tsgEnrichTask_(doc, x.task, now || new Date().toISOString(), 'Durand', { progressExplicit: x.progressExplicit });
  });
  if (!wanted.length) return;
  var pcts = tsgProgressFromNotesMany_(wanted.map(function(w) { return { title: w.item.title, notes: String(w.item.notes || '').trim(), priority: w.item.priority, target: w.target }; }));
  wanted.forEach(function(w, i) { if (pcts[i] != null) tsgSetProgressFromNotes_(w.item, pcts[i]); });
}

/* ------------------------------------------------------------------ *
 * Re-estimate tasks already on the board.
 *   tsgReestimate()            -> dry run over open tasks with no estHours
 *   tsgReestimate(true)        -> write a patch into _Inbox
 *   tsgReestimate(true, true)  -> include tasks that already have an estimate
 * ------------------------------------------------------------------ */
function tsgReestimate(apply, includeEstimated) {
  tsgAssertOwner_('tsgReestimate');
  const doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  const open = (doc.tasks || []).filter(function (t) {
    var st = String(t.status || '');
    if (st === 'Done' || st === 'Cancelled') return false;
    return includeEstimated ? true : !t.estHours;
  });

  if (!open.length) { Logger.log('[reestimate] nothing to do'); return []; }

  var ops = [];
  // One fetchAll round instead of a serial loop; anything past perRunCap comes back null
  // and is skipped exactly as an unreachable Claude would be.
  var prompts = open.map(function (t) { return tsgEstimatePrompt_(t.title, t.notes, t.priority || 'Medium'); });
  var raws = tsgClaudeMany_(prompts);
  open.forEach(function (t, i) {
    var est = tsgEstimateParse_(raws[i], prompts[i].need, t.title, {});
    if (est.source === 'none') {
      Logger.log('  #' + t.id + '  SKIPPED — Claude unavailable, leaving as-is: ' + t.title);
      return;
    }
    var fields = {
      estHours: est.estHours,
      estDays: tsgEstDays_(est.estHours, t.priority || 'Medium'),
      estSource: est.source,
      taskType: t.taskType || est.taskType
    };
    // Same 'Triage' repurpose as the add_task path — a self-flagged low-confidence
    // estimate gets the tag merged in without disturbing whatever tags already exist.
    if (est.needsConfirmation) {
      fields.tags = Array.from(new Set((t.tags || []).concat(['Triage'])));
    }
    Logger.log('  #' + t.id + '  ' + (t.estHours || '-') + 'h -> ' + est.estHours + 'h (' + est.source + ')  ' + t.title +
      (est.needsConfirmation ? '  [flagged: Triage]' : ''));
    ops.push({ op: 'update_task', id: t.id, fields: fields });
  });

  if (!apply) { Logger.log('[reestimate] DRY RUN — ' + ops.length + ' task(s). Call tsgReestimate(true) to write the patch.'); return ops; }

  var name = 'reestimate-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmmss') + '.json';
  DriveApp.getFolderById(INBOX_FOLDER_ID)
    .createFile(name, JSON.stringify({ target: 'data', op: 'bulk', ops: ops }, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('[reestimate] wrote ' + name + ' with ' + ops.length + ' op(s). Hit ?api=sync to apply.');
  return ops;
}

var TSG_TIDY_SYSTEM =
  'You tidy one task on the Director of Operations\' tracker for a residential real estate team. ' +
  'Return a cleaned-up version of the task as JSON. Rules:\n' +
  '- title: one imperative line, at most 80 characters, specific (who/what). Keep names, addresses and numbers.\n' +
  '- notes: rewrite into (1) a short "Current state" paragraph saying exactly where things stand, then (2) a ' +
  '"Log" of dated bullets, oldest first, one per event, each starting with its date. Keep every fact, name, ' +
  'date, phone number, dollar amount and URL verbatim. Drop chatter, duplicates and stale instructions that ' +
  'later lines superseded. Never invent a fact. If the notes are already clean, return them unchanged.\n' +
  '- priority (Critical|High|Medium|Low), taskType (Email|Call|Text/Chat|Meeting|Claude|Actionable Task), ' +
  'group (one of EXISTING_GROUPS), estHours (number, 0.25-80), tags (0-3, prefer EXISTING_TAGS; never Triage, ' +
  'Aging, Scheduling Stuck, Dependency Issue, needs-estimate, Claude): change a field ONLY when the title/notes ' +
  'clearly justify it; otherwise return the current value.\n' +
  '- rationale: one sentence on what you changed and why.\n' +
  'Return ONLY the JSON object {"title","notes","priority","taskType","group","estHours","tags","rationale"}, no prose, no fences.';

var TSG_TIDY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'notes', 'priority', 'taskType', 'group', 'estHours', 'tags', 'rationale'],
  properties: {
    title: { type: 'string' }, notes: { type: 'string' },
    priority: { type: 'string' }, taskType: { type: 'string' }, group: { type: 'string' },
    estHours: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' }
  }
};
/** Proposal for the dashboard's Tidy button: current fields plus Claude's cleaned-up version, validated. */
function tsgTidyBefore_(t) {
  return { title: t.title || '', notes: t.notes || '', priority: t.priority || 'Medium', taskType: t.taskType || 'Actionable Task', group: t.group || '',
    estHours: (typeof t.estHours === 'number') ? t.estHours : null, tags: (t.tags || []).slice() };
}
/** Validates a raw tidy answer against the board: unknown values fall back to the current ones, system tags are kept. */
function tsgTidyValidate_(doc, t, p) {
  var groups = Array.from(new Set((doc.tasks || []).map(function(x) { return x.group; }).filter(Boolean)));
  var before = tsgTidyBefore_(t);
  p = p || {};
  var prios = (doc.meta && doc.meta.priority_values) || ['Critical', 'High', 'Medium', 'Low'];
  var types = ['Email', 'Call', 'Text/Chat', 'Meeting', 'Claude', 'Actionable Task'];
  var proposal = {
    title: String(p.title || before.title).trim().slice(0, 120) || before.title,
    notes: (typeof p.notes === 'string') ? p.notes.trim() : before.notes,
    priority: prios.indexOf(p.priority) !== -1 ? p.priority : before.priority,
    taskType: types.indexOf(p.taskType) !== -1 ? p.taskType : before.taskType,
    group: (p.group && groups.indexOf(p.group) !== -1) ? p.group : before.group,
    estHours: (typeof p.estHours === 'number' && p.estHours > 0) ? Math.max(0.25, Math.min(80, Math.round(p.estHours * 4) / 4)) : before.estHours,
    tags: Array.isArray(p.tags) ? p.tags.map(function(x) { return String(x).trim(); }).filter(function(x) { return x && TSG_RESERVED_TAGS.indexOf(x) === -1; }).slice(0, 3) : before.tags,
    rationale: String(p.rationale || '').slice(0, 400)
  };
  // System tags on the task (Triage etc.) are never dropped by a tidy.
  var keep = (t.tags || []).filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) !== -1 || tg === 'Self-created'; });
  proposal.tags = Array.from(new Set(keep.concat(proposal.tags)));
  return { before: before, proposal: proposal };
}
/**
 * Proposal for the dashboard's Tidy button. With a key: one Claude call, answered now. With
 * no key: a request_tidy inbox op queues the rewrite for the Routine and the dashboard shows
 * "Review tidy" on the card once meta.tidyProposals[taskId] exists.
 */
function tsgTidyProposal_(taskId) {
  if (!taskId) return { ok: false, error: 'taskId required' };
  if (tsgJudgmentMode_()) {
    var r = tsgQueueDataPatch_({ op: 'request_tidy', id: taskId, source: 'Durand' });
    return { ok: true, queued: true, taskId: taskId, busy: !!(r && r.busy) };
  }
  var doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  var t = (doc.tasks || []).filter(function(x) { return x && x.id === taskId; })[0];
  if (!t) return { ok: false, error: 'no task ' + taskId };
  var groups = Array.from(new Set((doc.tasks || []).map(function(x) { return x.group; }).filter(Boolean)));
  var tags = Array.from(new Set((doc.tasks || []).reduce(function(a, x) { return a.concat(x.tags || []); }, []))).filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) === -1; });
  var before = tsgTidyBefore_(t);
  var user = 'CURRENT TASK: ' + JSON.stringify(Object.assign({ id: t.id, status: t.status, due: t.timelineEnd || '', subitems: (t.subitems || []).map(function(s) { return s.title; }) }, before), null, 1) +
    '\n\nEXISTING_GROUPS: ' + JSON.stringify(groups) + '\nEXISTING_TAGS: ' + JSON.stringify(tags);
  var raw = tsgClaude_(TSG_TIDY_SYSTEM, user, 2000, false, { schema: TSG_TIDY_SCHEMA });
  var p = raw ? tsgExtractJson_(raw) : null;
  if (!p) return { ok: false, error: 'Claude did not return a proposal.' };
  var v = tsgTidyValidate_(doc, t, p);
  return { ok: true, taskId: t.id, before: v.before, proposal: v.proposal };
}

/* ------------------------------------------------------------------ *
 * Ask-Claude endpoint for the dashboard button.
 * POST ?target=claude  body: {"prompt":"...", "taskId":123}
 *
 * NOTE ON EXPOSURE: if this web app is deployed "Anyone with the link", so is this
 * endpoint, and every call spends your API credits. The daily cap below is the guard.
 * Lower TSG_CLAUDE.dailyCallCap, or set deployment access to "Only myself", to tighten it.
 * ------------------------------------------------------------------ */
function tsgClaudeEndpoint_(body) {
  var req = {};
  try { req = JSON.parse(body || '{}'); } catch (err) {
    return { ok: false, error: 'Body must be JSON: {"prompt":"..."}' };
  }
  var prompt = String(req.prompt || '').slice(0, 8000);
  if (!prompt.trim()) return { ok: false, error: 'Empty prompt.' };
  if (!tsgApiKey_()) return { ok: false, error: 'No ANTHROPIC_API_KEY set in Script Properties.' };

  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var counter = JSON.parse(props.getProperty('CLAUDE_CALLS') || '{}');
  if (counter.date !== today) counter = { date: today, n: 0 };
  if (counter.n >= TSG_CLAUDE.dailyCallCap) {
    return { ok: false, error: 'Daily Claude call cap reached (' + TSG_CLAUDE.dailyCallCap + ').' };
  }
  counter.n += 1;
  props.setProperty('CLAUDE_CALLS', JSON.stringify(counter));

  var context = '';
  if (req.taskId) {
    var doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
    var t = (doc.tasks || []).find(function (x) { return x.id === req.taskId; });
    if (t) {
      context = '\n\nThe question is about this task:\n' + JSON.stringify({
        id: t.id, title: t.title, group: t.group, status: t.status, priority: t.priority,
        estHours: t.estHours, estDays: t.estDays, timelineEnd: t.timelineEnd,
        depends: t.depends, notes: t.notes, subitems: t.subitems
      }, null, 2);
    }
  }

  var system =
    'You are assisting the Director of Operations of The Stawasz Group, a residential real ' +
    'estate team, inside their task tracker. Be direct, declarative and specific. Active voice, ' +
    'no hedging, no preamble. If you are asked for something you cannot determine from what you ' +
    'were given, say so plainly rather than guessing.';

  var text = tsgClaude_(system, prompt + context, 1500);
  if (!text) return { ok: false, error: 'Claude call failed — check the execution log.' };
  return { ok: true, text: text, callsToday: counter.n };
}

/**
 * ============================================================================
 * CALIBRATION — added 2026-08-24
 *
 * You don't track your time, and hour-level actuals cannot honestly be inferred.
 * The obvious trick — apportioning each day's 6h of capacity across whatever was
 * scheduled — is circular: the schedule comes from estDays, estDays comes from the
 * estimate, so "actual hours" derived that way just echoes the estimate back. It also
 * inflates small tasks badly (a 0.25h follow-up gets credited 1.5h for occupying a
 * day slot it never filled — measured 6-12x overstatement on this board).
 *
 * What IS uncontaminated is the completion date. Nobody derives it; it happens.
 * So calibration runs on DAYS, not hours:
 *
 *     actualDays = working days from startedAt to completedAt
 *     velocity   = estDays / actualDays
 *
 * Velocity below 1.0 means work consistently takes longer than planned. That is the
 * Evidence-Based Scheduling correction (Spolsky 2007), applied to the one quantity
 * here that is actually observed. And days are what drive your schedule anyway —
 * estDays is what feeds scheduledDays.
 *
 * actualHours stays null unless something real supplies it. tsgAttributeCalendarHours
 * below can fill it from calendar events whose title matches a task, when you actually
 * book the work. Anything else would be a number dressed up as a measurement.
 * ============================================================================
 */

function tsgIsWorkday_(d) {
  var day = d.getDay();
  return day !== 0 && day !== 6;
}

function tsgWorkdaysBetween_(startIso, endIso) {
  if (!startIso || !endIso) return null;
  var s = tsgParseIsoDate_(String(startIso).slice(0, 10));
  var e = tsgParseIsoDate_(String(endIso).slice(0, 10));
  if (!s || !e || isNaN(s) || isNaN(e) || e < s) return null;
  var n = 0, cur = new Date(s);
  while (cur <= e) {
    if (tsgIsWorkday_(cur)) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, n);
}

/**
 * Fill in actualDays for completed tasks, and report velocity.
 *   tsgDeriveActuals()     -> dry run
 *   tsgDeriveActuals(true) -> write a patch into _Inbox
 */
function tsgDeriveActuals(apply) {
  tsgAssertOwner_('tsgDeriveActuals');
  const doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  const done = (doc.tasks || []).filter(function (t) {
    return String(t.status) === 'Done' && t.completedAt && !t.actualDays;
  });

  if (!done.length) {
    Logger.log('[actuals] nothing to derive. Tasks need startedAt/completedAt, which are ' +
               'stamped automatically from now on — this fills in as work completes.');
    return [];
  }

  var ops = [];
  done.forEach(function (t) {
    var start = t.startedAt || t.scheduledStart || null;
    if (!start) {
      Logger.log('  #' + t.id + '  no start point — skipped: ' + t.title);
      return;
    }
    var days = tsgWorkdaysBetween_(start, t.completedAt);
    if (!days) { Logger.log('  #' + t.id + '  unusable dates — skipped'); return; }

    // A task left sitting in a non-Done status for weeks was abandoned, not worked.
    // Flag rather than pretend the elapsed span was effort.
    var confidence = days <= (t.estDays || 1) * 3 ? 'ok' : 'low';

    Logger.log('  #' + t.id + '  est ' + (t.estDays || '-') + 'd -> actual ' + days + 'd  (' +
               confidence + ')  ' + t.title.slice(0, 50));
    ops.push({ op: 'update_task', id: t.id, fields: {
      actualDays: days,
      actualSource: 'status-transitions',
      actualConfidence: confidence
    }});
  });

  if (!ops.length) return [];
  if (!apply) {
    Logger.log('[actuals] DRY RUN — ' + ops.length + ' task(s). Call tsgDeriveActuals(true) to write the patch.');
    return ops;
  }
  var name = 'actuals-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmmss') + '.json';
  DriveApp.getFolderById(INBOX_FOLDER_ID)
    .createFile(name, JSON.stringify({ target: 'data', op: 'bulk', ops: ops }, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('[actuals] wrote ' + name + ' with ' + ops.length + ' op(s). Hit ?api=sync to apply.');
  return ops;
}

/**
 * Velocity report — estDays / actualDays across completed work.
 * Run it once there are ~10 completed tasks with actualDays; below that the
 * distribution is too thin to read anything into.
 */
function tsgVelocityReport() {
  tsgAssertOwner_('tsgVelocityReport');
  const doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  const rows = (doc.tasks || []).filter(function (t) {
    return t.actualDays && t.estDays && t.actualConfidence !== 'low';
  });

  if (rows.length < 5) {
    Logger.log('[velocity] only ' + rows.length + ' usable data point(s) — not enough to calibrate. ' +
               'Needs ~10. Keep working; this fills in on its own.');
    return null;
  }

  var v = rows.map(function (t) { return t.estDays / t.actualDays; }).sort(function (a, b) { return a - b; });
  var median = v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
  var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;

  rows.forEach(function (t) {
    Logger.log('  ' + (t.estDays / t.actualDays).toFixed(2) + '   est ' + t.estDays + 'd / actual ' +
               t.actualDays + 'd   ' + t.title.slice(0, 50));
  });
  Logger.log('[velocity] n=' + v.length + '  median ' + median.toFixed(2) + '  mean ' + mean.toFixed(2) +
             '  p10 ' + v[Math.floor(v.length * 0.1)].toFixed(2) +
             '  p90 ' + v[Math.floor(v.length * 0.9)].toFixed(2));
  Logger.log(median < 0.85 ? '  -> Work runs LONGER than planned. Divide future estDays by ' + median.toFixed(2) + '.'
           : median > 1.15 ? '  -> Work finishes EARLY. Estimates are padded by about ' + Math.round((median - 1) * 100) + '%.'
           : '  -> Estimates are well calibrated. No correction needed.');
  return { n: v.length, median: median, mean: mean };
}

/**
 * Optional: fill actualHours from calendar events whose title matches a task.
 * Only does anything for work you actually put on the calendar — it never guesses.
 *   tsgAttributeCalendarHours('2026-08-01', '2026-08-31')
 */
function tsgAttributeCalendarHours(startStr, endStr, apply) {
  tsgAssertOwner_('tsgAttributeCalendarHours');
  const doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  const events = getCalendarHours_(startStr, endStr);
  const tasks = (doc.tasks || []).filter(function (t) { return t.title; });

  var byTask = {};
  events.forEach(function (ev) {
    var best = null, bestScore = 0;
    tasks.forEach(function (t) {
      var s = tsgTitleSimilarity_(ev.title, t.title);
      if (s > bestScore) { bestScore = s; best = t; }
    });
    if (best && bestScore >= 0.60) {
      byTask[best.id] = (byTask[best.id] || 0) + ev.hours;
      Logger.log('  ' + ev.date + '  ' + ev.hours + 'h  "' + ev.title + '" -> #' + best.id +
                 ' (' + Math.round(bestScore * 100) + '%)');
    }
  });

  var ops = Object.keys(byTask).map(function (id) {
    return { op: 'update_task', id: Number(id), fields: {
      actualHours: Math.round(byTask[id] * 4) / 4, actualSource: 'calendar'
    }};
  });

  if (!ops.length) { Logger.log('[calendar] no events matched a task title.'); return []; }
  if (!apply) { Logger.log('[calendar] DRY RUN — ' + ops.length + ' task(s). Pass apply=true to write.'); return ops; }

  var name = 'calendar-actuals-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmmss') + '.json';
  DriveApp.getFolderById(INBOX_FOLDER_ID)
    .createFile(name, JSON.stringify({ target: 'data', op: 'bulk', ops: ops }, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('[calendar] wrote ' + name + '. Hit ?api=sync to apply.');
  return ops;
}

/**
 * ============================================================================
 * AUTO-SCHEDULE — added 2026-08-25
 *
 * Runs on every write to the tracker — dashboard saves (doPost, target=data) and
 * every _Inbox patch batch (processInbox_) alike — so an unscheduled task never
 * just sits there. It lands on a real date automatically, the same moment it's
 * created or edited into existence, whether or not the dashboard happens to be
 * open at the time.
 *
 * Idempotent by construction: a task that already has a date (timelineEnd, or
 * scheduledStart+estDays) is left completely alone, so running this on every
 * single save is safe — it only ever touches tasks that are currently sitting
 * unscheduled.
 *
 * Scope, as of the 2026-08-26 rewrite: a task with NO subitems schedules as one
 * block, gated on its own top-level owner field — unchanged. A task WITH
 * subitems never schedules as one block itself. Instead EVERY one of its
 * subitems (whoever it's delegated to, not just Durand) is scheduled as its own
 * chained step: subitem 2 can't start before subitem 1 has a projected finish
 * date, mirroring the dashboard's own subitemBlockedBy() sequencing rule
 * exactly (default: blocked by the immediately preceding not-done subitem,
 * unless it names a different one via its own s.depends — an INDEX into the
 * same subitems array, NOT a task id — top-level task.depends and subitem
 * .depends are different address spaces and must never be parsed the same way).
 * Only the steps delegated to Durand himself compete for his real calendar
 * capacity (TSG_DAY_CAPACITY/TSG_CHUNK_RATE, seeded by his other work and real
 * meetings); a step delegated to someone else still gets a placeholder pacing
 * schedule (same chunk-rate formula, so the chain reads sensibly end-to-end)
 * but never eats into Durand's tracked capacity, since this system has no
 * visibility into anyone else's actual calendar and won't pretend to.
 *
 * Confirming a delegate's work is itself real time — 0.5h per delegated
 * subitem — but per Durand (2026-08-26) that cost must never show up as a
 * visible item in the tracker; it's purely a scheduling/capacity concern of
 * his own. So there is no synthetic subitem for it. Instead: (1)
 * tsgRollupSubitemHours_ folds a flat 0.5h straight into the parent task's
 * top-level estHours for every subitem delegated to someone other than
 * Durand, alongside the real per-subitem hours it already sums — invisible
 * in the subitem list, but counted in the number Durand actually plans
 * against; and (2) tsgAutoScheduleDoc_ reserves 0.5h of Durand's own daily
 * capacity (the same dateLoad pool his real work draws from) on the first
 * workday after each non-Durand subitem's projected finish — both for steps
 * already scheduled in an earlier run (seed pass) and the instant one is
 * freshly placed in this run — so his calendar always has room set aside to
 * check the handoff, without a checkbox anyone has to look at or clear.
 * tsgRollupSubitemHours_ also keeps every subitem-bearing task's own
 * top-level timelineEnd as the latest of all its subitems' own timelineEnd —
 * both recomputed on every run, for existing tasks and new ones alike, so
 * the top-level numbers are never stale relative to the real chain
 * underneath them.
 *
 * A subitem with no estHours yet is left alone rather than guessed a schedule —
 * same "no fabricated estimate" rule tsgEstimateTask_ uses above. It picks up a
 * real schedule automatically the moment it gets hours (from the estimator,
 * tsgReestimate, or a human), on the very next save.
 *
 * Capacity model matches TSG_DAY_CAPACITY / TSG_CHUNK_RATE defined above: 6h of
 * real working time per weekday, chunked per task by priority so no single task
 * eats the whole day. Already-scheduled tasks and real calendar meetings both
 * reduce what capacity is left before new work gets packed in on top.
 * ============================================================================
 */
/**
 * ---------------------------------------------------------------------------
 * DST-SAFE DATE MATH (2026-09-02)
 *
 * Every date this scheduler reasons about is a CALENDAR DAY ('YYYY-MM-DD'), not an
 * instant. The old helpers moved between the two by parsing 'YYYY-MM-DDT00:00:00' and
 * doing millisecond arithmetic, which quietly assumes a day is always exactly 86,400,000
 * ms of local time. It isn't: across a DST transition a local day is 23 or 25 hours. That
 * makes "+1 day" land at 23:00 the SAME day (so a date string repeats and a schedule
 * doubles a day) or 01:00 the NEXT-next day, and makes a floor()'d day count come out one
 * short — which is exactly how a 30-day aging threshold can be missed.
 *
 * These operate on y/m/d components instead. Dates are materialized at local NOON, never
 * midnight, so even a timezone whose DST transition happens AT midnight (a midnight that
 * simply doesn't exist that day) can't shift the calendar date out from under us; and
 * day-count differences go through Date.UTC, which has no DST at all.
 *
 * Signatures are unchanged — this is an internal-correctness fix only.
 * ---------------------------------------------------------------------------
 */

/** 'YYYY-MM-DD' -> a Date at LOCAL NOON on that calendar day. null if unparseable. */
function tsgParseIsoDate_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (isNaN(y) || isNaN(mo) || isNaN(d)) return null;
  return new Date(y, mo - 1, d, 12, 0, 0, 0);
}

/** Date -> 'YYYY-MM-DD' read off its own local y/m/d, with no timezone round-trip. */
function tsgFormatIsoDate_(d) {
  var mo = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (mo < 10 ? '0' : '') + mo + '-' + (day < 10 ? '0' : '') + day;
}

function tsgIsoDate_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

/** Calendar-day arithmetic: setDate() steps whole days regardless of DST. */
function tsgAddDays_(iso, n) {
  var d = tsgParseIsoDate_(iso);
  if (!d) return iso;                    // unparseable in, unchanged out — same as before
  d.setDate(d.getDate() + (n || 0));
  return tsgFormatIsoDate_(d);
}

/** Whole calendar days from startIso to endIso. Via Date.UTC, so DST can never shave an hour off. */
function tsgDaysBetweenIso_(startIso, endIso) {
  var a = tsgParseIsoDate_(startIso), b = tsgParseIsoDate_(endIso);
  if (!a || !b) return null;
  var ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  var ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

/** Day of week for a date STRING (0=Sun ... 6=Sat), without a midnight-parse. */
function tsgIsoDayOfWeek_(iso) {
  var d = tsgParseIsoDate_(iso);
  return d ? d.getDay() : null;
}

/** tsgIsWorkday_ for a date string. Same rule (Mon-Fri), DST-safe parse. */
function tsgIsWorkdayIso_(iso) {
  var dow = tsgIsoDayOfWeek_(iso);
  return dow !== null && dow !== 0 && dow !== 6;
}

function tsgTodayIso_() { return tsgIsoDate_(new Date()); }
function tsgDependsList_(t) {
  return String(t.depends || '').split(',').map(function(s) { return parseInt(s, 10); }).filter(function(n) { return !isNaN(n); });
}

/** Mirrors the dashboard's scheduledSpan(): explicit chunked schedule when present, else a naive full-day-from-due-date fallback. */
function tsgScheduledSpan_(t) {
  if (t.scheduledStart && t.estDays) {
    var chunkDays = t.scheduledDays || null;
    var end = t.timelineEnd || (chunkDays ? chunkDays[chunkDays.length - 1] : tsgAddDays_(t.scheduledStart, t.estDays - 1));
    // `days` divides estHours into a per-day load for the capacity seed, so it has to be
    // the number of days the schedule ACTUALLY occupies. scheduledDays IS that schedule;
    // estDays is a derived planning number, and the two diverge the moment estHours
    // changes without a re-plan. Trusting estDays over a real scheduledDays array spread
    // the hours across the wrong number of days and mis-seeded every downstream capacity
    // decision. estDays stays the fallback for a task with no chunked schedule yet
    // (2026-09-02 — see also update_task, which now clears the stale plan on an estHours
    // change so the two can't drift apart in the first place).
    var days = (t.scheduledDays && t.scheduledDays.length) ? t.scheduledDays.length : t.estDays;
    return { start: t.scheduledStart, end: end, days: days, chunkDays: chunkDays };
  }
  if (!t.timelineEnd) return null;
  var wd = Math.max(1, Math.ceil((t.estHours || 8) / 8));
  return { start: tsgAddDays_(t.timelineEnd, -(wd - 1)), end: t.timelineEnd, days: wd, chunkDays: null };
}

/** True when a subitem's own delegate is Durand himself, not a teammate. */
function tsgIsDurandDelegate_(s) {
  return String((s && s.delegate) || '').trim().toLowerCase() === 'durand';
}

/**
 * Mirrors the dashboard's subitemBlockedBy() EXACTLY (dash_fixed2.html) — same default
 * (blocked by the immediately preceding not-done subitem) and same override (s.depends,
 * an INDEX into this same subitems array, never a task id). Keeping these two
 * implementations in lockstep matters: this is what decides both what the checkbox UI
 * shows as blocked and what the server actually schedules next.
 * Returns the index of the blocking subitem, or null if clear to proceed.
 */
function tsgSubitemBlockedByIdx_(subitems, idx) {
  var s = subitems[idx];
  if (!s || s.done) return null;
  // Normalize FIRST (2026-09-02). '' and 'none' both mean "no explicit override" and must
  // both fall through to the default sequential blocking below. Before this, only '' did:
  // 'none' was truthy, so it entered the override branch, parseInt('none') gave NaN, and
  // the "explicit depends that doesn't resolve" escape ran instead — quietly UNBLOCKING a
  // step that should have been waiting on the one before it. Any other value is still
  // treated exactly as before: a numeric index string into this same subitems array.
  var raw = String(s.depends || '').trim().toLowerCase();
  if (raw !== '' && raw !== 'none') {
    var depIdx = parseInt(raw, 10);
    if (!isNaN(depIdx) && depIdx !== idx && subitems[depIdx]) {
      return subitems[depIdx].done ? null : depIdx;
    }
    return null; // explicit depends that doesn't resolve — don't guess, don't block
  }
  if (idx > 0 && !subitems[idx - 1].done) return idx - 1;
  return null;
}

/**
 * Keeps every subitem-bearing open task's own top-level estHours as a strict live sum of
 * all its real per-subitem hours PLUS an invisible 0.5h "confirm the handoff" cost for
 * every subitem delegated to someone other than Durand — see the AUTO-SCHEDULE note above.
 * That 0.5h is never a subitem of its own; it only ever shows up folded into this one
 * number. A done subitem's hours (and its 0.5h handoff cost) are excluded from the sum —
 * this number tracks work remaining on the task, so finishing a subitem deducts its time
 * from the parent immediately (2026-09-01). Also keeps timelineEnd as the latest of all its
 * subitems' own timelineEnd, done or not. Recomputed every run — cheap, and it means the
 * top-level numbers are never stale relative to the real chain underneath them, whether the
 * task is brand new or has been on the board for weeks.
 */
function tsgRollupSubitemHours_(doc, now) {
  (doc.tasks || []).forEach(function(t) {
    if (!t.subitems || !t.subitems.length) return;
    // tags is in the snapshot only because tsgLogFieldChanges_ always diffs it; the rollup
    // never changes tags, and leaving it out logged a bogus null->tags entry every run.
    var before = { estHours: t.estHours, timelineEnd: t.timelineEnd, tags: t.tags };
    var sub = tsgOpenSubitemHours_(t);
    // 2026-09-14 — the parent's OWN work. Until today this rollup REPLACED the parent's
    // estHours with the subitem sum, so a task whose subitems were all done rolled up to
    // 0h no matter what Durand typed, and a parent's due date was pinned to the latest
    // subitem due — even a finished one — on every run, with no history entry. Task #12
    // (the Farina call: one done subitem, the call itself still to do) had its 0.25h /
    // 9-14 edits silently reverted four times in one afternoon. estHoursOwn is the
    // parent's own hours; it is set only by an explicit estHours edit on a subitem-bearing
    // task (tsgCaptureOwnHours_) and never touched here. estHours = own + open subitems.
    var own = (typeof t.estHoursOwn === 'number' && !isNaN(t.estHoursOwn)) ? t.estHoursOwn : 0;
    if (sub.any || own) t.estHours = Math.round((own + sub.hours) * 100) / 100;
    t.timelineEnd = tsgRollupDue_(t, sub.latestOpenEnd);
    if (now) {
      // Make the rollup visible: a changed number now shows up in the task's history as
      // source 'rollup' instead of looking like an edit that mysteriously didn't stick.
      t.history = t.history || [];
      tsgLogFieldChanges_(t.history, before, t, ['estHours', 'timelineEnd'], now, 'rollup');
    }
  });
}

/**
 * One-time data repair (2026-09-14), safe to leave in: version 2026-09-14.4 of the rollup
 * logged a bogus history entry ("tags: null -> <current tags>", source 'rollup') on every
 * subitem-bearing task because its before-snapshot omitted tags. The rollup never changes
 * tags, so any such entry is noise — drop it. Idempotent and cheap; remove once the live
 * document has been observed clean.
 */
function tsgPurgeBogusRollupTagHistory_(doc) {
  (doc.tasks || []).forEach(function(t) {
    if (!Array.isArray(t.history)) return;
    t.history = t.history.filter(function(h) { return !(h && h.source === 'rollup' && h.field === 'tags'); });
  });
}

/**
 * Hours still open under a task: every not-done subitem's estHours plus the invisible
 * 0.5h "confirm the handoff" cost for each one delegated to someone other than Durand.
 * `any` is true when any subitem (done or not) ever carried estHours/delegate info, so a
 * task whose subitems are all done still rolls up (to its own hours, or 0) rather than
 * being left at a stale number (2026-09-01, per Durand). latestOpenEnd is the latest
 * timelineEnd among NOT-done subitems only — a finished subitem has no say in when its
 * parent is due.
 */
function tsgOpenSubitemHours_(t) {
  var hours = 0, any = false, latestOpenEnd = null;
  (t.subitems || []).forEach(function(s) {
    var hadInfo = (s.estHours != null && !isNaN(s.estHours)) || (s.delegate && !tsgIsDurandDelegate_(s));
    if (hadInfo) any = true;
    if (!s.done) {
      if (s.estHours != null && !isNaN(s.estHours)) hours += Number(s.estHours);
      if (s.delegate && !tsgIsDurandDelegate_(s)) hours += 0.5; // confirm-the-handoff cost, invisible
      if (s.timelineEnd && (!latestOpenEnd || s.timelineEnd > latestOpenEnd)) latestOpenEnd = s.timelineEnd;
    }
  });
  return { hours: Math.round(hours * 100) / 100, any: any, latestOpenEnd: latestOpenEnd };
}

/**
 * The parent's due date given its open subitems: never earlier than the latest open
 * subitem (a parent cannot be due before work still under it), and an explicitly set
 * parent date (dueOverride) that is LATER than that stands. With no open subitems the
 * parent keeps whatever date it has.
 */
function tsgRollupDue_(t, latestOpenEnd) {
  if (!latestOpenEnd) return t.timelineEnd || '';
  if (t.dueOverride && t.timelineEnd && t.timelineEnd > latestOpenEnd) return t.timelineEnd;
  return latestOpenEnd;
}

/**
 * An explicit estHours edit on a task WITH subitems is read as the total the editor wants
 * to see; the parent's own share is whatever is left after the open subitems' hours.
 */
function tsgCaptureOwnHours_(t, newTotal) {
  if (!t.subitems || !t.subitems.length) return;
  var n = Number(newTotal);
  if (newTotal == null || newTotal === '' || isNaN(n)) { t.estHoursOwn = 0; return; }
  t.estHoursOwn = Math.max(0, Math.round((n - tsgOpenSubitemHours_(t).hours) * 100) / 100);
}

/**
 * replace_all (the dashboard's full save): detect explicit edits by diffing against the
 * stored task, and record them the same way update_task does — a changed timelineEnd
 * sets dueOverride (the dashboard never sets that flag itself, which is why Durand's
 * 10-08 on task #1 kept losing to the rollup), and a changed estHours on a subitem-
 * bearing task captures the parent's own share.
 */
function tsgCaptureExplicitEditsFromSave_(prevTasks, nextTasks) {
  var prevById = {};
  (prevTasks || []).forEach(function(t) { prevById[t.id] = t; });
  (nextTasks || []).forEach(function(t) {
    var prev = prevById[t.id];
    if (prev && typeof prev.dueOverride === 'boolean' && t.dueOverride == null) t.dueOverride = prev.dueOverride;
    if (prev && !tsgValuesEqual_(prev.timelineEnd, t.timelineEnd) && t.timelineEnd) t.dueOverride = true;
    if (!t.subitems || !t.subitems.length) return;
    if (prev && typeof prev.estHoursOwn === 'number' && t.estHoursOwn == null) t.estHoursOwn = prev.estHoursOwn;
    if (!prev || !tsgValuesEqual_(prev.estHours, t.estHours)) tsgCaptureOwnHours_(t, t.estHours);
  });
}

/**
 * Reserves 0.5h of Durand's own daily capacity (the same dateLoad pool his real work
 * draws from) on the first workday after a non-Durand subitem's projected finish — the
 * invisible "confirm the handoff" cost described in the AUTO-SCHEDULE note above. Never
 * creates a work item or subitem; it only debits the shared capacity pool so later
 * placement decisions in this same run (and the seed pass on the next run) correctly see
 * that slice of Durand's day as already spoken for. No-ops if the finish date is in the
 * past relative to today (nothing to reserve for a handoff that already happened).
 */
function tsgReserveConfirmCapacity_(addLoad, today, finishIso) {
  if (!finishIso) return;
  var d = tsgAddDays_(finishIso, 1);
  var guard = 0;
  while (!tsgIsWorkdayIso_(d) && guard++ < 14) d = tsgAddDays_(d, 1);
  if (d >= today) addLoad(d, 0.5);
}

/**
 * The schedulable "work items" that live inside one task:
 *   - a task with no subitems is itself one work item, IF Durand is its owner.
 *   - a task WITH subitems is never a work item itself — EVERY one of its not-done
 *     subitems is its own separate work item instead, whoever it's delegated to (see
 *     the note on tsgAutoScheduleDoc_ above for why "has subitems" isn't "not Durand's
 *     work," and why every step still gets scheduled, not just his own).
 * Each item is { ref, parent, idx, isSubitem, label } — ref is the object actually
 * mutated (scheduledStart/scheduledDays/estDays/timelineEnd live on it directly,
 * whether that's the task or one of its subitems), parent is always the top-level task
 * (for history logging and tie-break ordering), idx is the subitem's index in its
 * parent's subitems array (null for a whole-task item).
 */
function tsgWorkItemsOf_(t) {
  if (t.subitems && t.subitems.length) {
    var items = [];
    t.subitems.forEach(function(s, idx) {
      if (s.done) return;
      items.push({ ref: s, parent: t, idx: idx, isSubitem: true,
        label: '"' + s.title + '" (subitem of #' + t.id + ' "' + t.title + '")' });
    });
    return items;
  }
  // 2026-09-15: a whole task owned by a named person other than Durand (a Marj-created task,
  // or one he assigned wholesale) is now a work item too, paced at its priority's chunk
  // rate like a delegated subitem and never drawing on his capacity. Unowned tasks stay out.
  var owner = String(t.owner || '').trim();
  if (!owner || owner === 'Unassigned') return [];
  // Whose hands: the whole-task delegate when set (a person or Claude), else the owner.
  // Durand owning a task delegated to Marj or Claude does not put it on his capacity.
  var hands = tsgTaskDelegate_(t) || owner;
  return [{ ref: t, parent: t, idx: null, isSubitem: false, delegated: hands.toLowerCase() !== 'durand',
    label: '#' + t.id + ' "' + t.title + '"' }];
}
/** Whether a work item competes for Durand's own daily capacity. */
function tsgItemIsDurandWork_(it) {
  return it.isSubitem ? tsgIsDurandDelegate_(it.ref) : !it.delegated;
}

/**
 * A task/subitem was caught in a dependency deadlock: at some point in the scheduling
 * pass, every remaining queued item was still "blocked" per isBlocked() — almost always a
 * circular depends chain, or a depends value pointing at a task id that no longer exists.
 * Tag it so this doesn't resolve silently as if nothing were wrong (2026-08-26).
 *
 * Idempotent as of 2026-09-02 — a task already carrying the tag is not re-tagged and, more
 * importantly, not re-logged, so a deadlock spanning several forced placements (or the
 * same deadlock on every subsequent run) can't spam the history.
 */
function tsgFlagUnresolvedDependency_(item) {
  var t = item.ref, parent = item.parent;
  if ((t.tags || []).indexOf('Dependency Issue') !== -1) return;
  t.tags = Array.from(new Set((t.tags || []).concat(['Dependency Issue'])));
  parent.history = parent.history || [];
  parent.history.push({
    ts: new Date().toISOString(), field: 'unresolved-dependency', from: null,
    to: item.label + ' was scheduled even though its dependency chain never resolved — ' +
        'check the depends field for a circular reference, or a dependency that will ' +
        'never get a finish date (e.g. a Done task with no due date on record).'
  });
}

/**
 * A Low/Medium-priority task that's been open a long time can lose every priority race
 * to newer Critical/High work forever, with nothing ever forcing a second look. Flags
 * (does NOT silently reprioritize — that's Durand's call) any open task past AGING_DAYS
 * since creation. Idempotent: a task already tagged is never re-flagged or re-logged.
 */
var TSG_AGING_DAYS = 30;
function tsgFlagAgingTasks_(doc, todayIso) {
  (doc.tasks || []).forEach(function(t) {
    if (t.status === 'Done' || t.status === 'Cancelled') return;
    if ((t.tags || []).indexOf('Aging') !== -1) return;
    var created = (t.history || []).filter(function(h) { return h && h.field === 'created' && h.ts; })[0];
    if (!created) return; // no reliable creation timestamp — don't guess
    var createdDate = String(created.ts).slice(0, 10);
    // Whole calendar days, via Date.UTC — raw ms subtraction across a DST boundary comes
    // out an hour short and floor()s to one day fewer, which could hold a task just under
    // the 30-day threshold for an extra day.
    var daysOpen = tsgDaysBetweenIso_(createdDate, todayIso);
    if (daysOpen == null || daysOpen < TSG_AGING_DAYS) return;
    t.tags = Array.from(new Set((t.tags || []).concat(['Aging'])));
    t.history = t.history || [];
    t.history.push({
      ts: new Date().toISOString(), field: 'aging-flagged', from: null,
      to: 'Open ' + daysOpen + ' days without being marked Done — worth a priority check.'
    });
  });
}

/**
 * Mutates doc.tasks in place, assigning scheduledStart/scheduledDays/estDays/timelineEnd
 * to every currently-unscheduled work item — whole tasks of Durand's own, and every
 * subitem inside a multi-person task (his own steps compete for his real capacity;
 * everyone else's steps get a placeholder pacing schedule so the chain reads sensibly,
 * without pretending to know their actual calendar). Returns the count placed (0 means
 * nothing to do — the common case on most saves — so callers can skip re-serializing).
 */
/**
 * Iteration bound on the placement loop. Not a change from before — this is the same
 * hardcoded 2000 the loop has always carried, named so its two uses (the bound itself and
 * the "we're getting close to it" warning) can't drift apart. Reaching it TRUNCATES the
 * pass: whatever is still queued is left unscheduled with no marker of its own, which is
 * indistinguishable from "nobody has gotten to it yet". The cap and the truncation are
 * both unchanged (2026-09-02) — the only change is that hitting it, or getting near it, is
 * now visible instead of silent.
 */
var TSG_SCHEDULE_LOOP_CAP = 2000;
var TSG_SCHEDULE_LOOP_WARN_AT = 1600; // 80% of the cap

// Round-trip travel (2026-09-16, per Durand: "need to be able to add a location to a task
// and you can calculate round trip time"). A task's `location` (free text: an address or a
// place name) is driven from meta.homeBase (Settings > Team > Home base) with the Maps
// service; the result lands on the task as `travelMin` (ROUND TRIP, driving, rounded up to
// 5) with `travelFor` recording the location+base it was computed for, so it is only
// recomputed when either changes. No home base, no location, or a Maps failure leaves
// travelMin untouched (a failure logs). The Today view's Errands block and the scheduler
// (tsgItemHours_) add travelMin to the task's own hours. Maps calls are capped per run and
// each answer is cached 6 h.
var TSG_TRAVEL_PER_RUN_CAP = 10;
function tsgTravelKey_(location, base) {
  return String(location || '').trim().toLowerCase() + ' | ' + String(base || '').trim().toLowerCase();
}
var TSG_TRAVEL_CALLS = 0; // Maps calls this execution (tasks and calendar events together)
/** ONE-WAY driving minutes from base to location, rounded up to 5; cached 6 h. Throws when Maps finds no route. */
var TSG_TRAVEL_METHODS = ['drive', 'walk', 'transit'];
function tsgOneWayMinutes_(base, location, method) {
  method = TSG_TRAVEL_METHODS.indexOf(method) !== -1 ? method : 'drive';
  var mode = method === 'walk' ? Maps.DirectionFinder.Mode.WALKING : method === 'transit' ? Maps.DirectionFinder.Mode.TRANSIT : Maps.DirectionFinder.Mode.DRIVING;
  var key = ('travel1:' + method + ':' + tsgTravelKey_(location, base)).slice(0, 240);
  var cache = null;
  try { cache = CacheService.getScriptCache(); var hit = cache.get(key); if (hit != null) return Number(hit); } catch (e0) {}
  if (TSG_TRAVEL_CALLS >= TSG_TRAVEL_PER_RUN_CAP) throw new Error('per-run Maps cap reached');
  TSG_TRAVEL_CALLS++;
  var dir = Maps.newDirectionFinder().setOrigin(base).setDestination(location).setMode(mode).getDirections();
  var route = dir && dir.routes && dir.routes[0];
  if (!route || !route.legs || !route.legs.length) throw new Error('no ' + method + ' route found');
  var secs = route.legs.reduce(function(a, l) { return a + ((l.duration && l.duration.value) || 0); }, 0);
  var mins = Math.max(5, Math.ceil(secs / 60 / 5) * 5);
  try { if (cache) cache.put(key, String(mins), 21600); } catch (e1) {}
  return mins;
}
function tsgRoundTripMinutes_(base, location) { return tsgOneWayMinutes_(base, location, 'drive') * 2; }
/** One-way minutes per method; a method Maps cannot route (transit, often) is null. */
function tsgTravelOptions_(base, location) {
  var out = {};
  TSG_TRAVEL_METHODS.forEach(function(m) { try { out[m] = tsgOneWayMinutes_(base, location, m); } catch (err) { out[m] = null; } });
  return out;
}
/**
 * Recommendation (2026-09-16, per Durand: "walk/drive/transit - and make a recommendation"):
 * walk when it is a short walk (<= 15 min); transit when it is within 30% of driving (no
 * parking, no wheel time); otherwise drive; else whatever Maps could route.
 */
function tsgRecommendTravel_(opts) {
  opts = opts || {};
  if (opts.walk != null && opts.walk <= 15) return 'walk';
  if (opts.transit != null && opts.drive != null && opts.transit <= opts.drive * 1.3) return 'transit';
  if (opts.drive != null) return 'drive';
  if (opts.transit != null) return 'transit';
  if (opts.walk != null) return 'walk';
  return null;
}
/** The method a task actually travels by: Durand's pick when Maps could route it, else the recommendation. */
function tsgTravelMethodUsed_(t) {
  var opts = (t && t.travelOptions) || {};
  if (t && t.travelMethod && opts[t.travelMethod] != null) return t.travelMethod;
  return (t && t.travelRecommended) || tsgRecommendTravel_(opts);
}
/** The home base for travel: meta.homeBase mirrored into a script property so the calendar feeds (no doc in hand) can read it. */
function tsgHomeBase_(doc) {
  var fromDoc = doc && doc.meta && String(doc.meta.homeBase || '').trim();
  if (fromDoc) return fromDoc;
  try { return String(PropertiesService.getScriptProperties().getProperty('TSG_HOME_BASE') || '').trim(); } catch (err) { return ''; }
}
/**
 * Travel minutes a task actually charges, per its travelMode (2026-09-16, per Durand: "one
 * way and round trip estimates, i can pick which, and show a total estimate too"):
 * 'round' (default) = both legs, 'oneway' = one leg, 'none' = 0.
 */
function tsgTravelChargeMinutes_(r) {
  if (!r || typeof r.travelMin !== 'number' || r.travelMin <= 0) return 0;
  var mode = r.travelMode || 'round';
  if (mode === 'none') return 0;
  if (mode === 'oneway') return (typeof r.travelOneWayMin === 'number') ? r.travelOneWayMin : Math.round(r.travelMin / 2);
  return r.travelMin;
}
/** Off-site calendar events: real driving time from the home base when one is set, else the flat default. */
function tsgEventTravelMinutes_(location) {
  var base = tsgHomeBase_(null);
  var loc = String(location || '').trim();
  if (!base || !loc) return TSG_MEETING_TRAVEL_MIN;
  try { return tsgOneWayMinutes_(base, loc, 'drive'); } catch (err) { return TSG_MEETING_TRAVEL_MIN; }
}
/** Address search for the location picker: Maps geocoder, top matches as plain labels. */
function tsgGeocode_(q) {
  var query = String(q || '').trim();
  if (query.length < 3) return { ok: true, places: [] };
  try {
    var res = Maps.newGeocoder().geocode(query);
    var rows = (res && res.results) || [];
    return { ok: true, places: rows.slice(0, 6).map(function(r) { return { label: r.formatted_address || '', name: (r.name || ''), types: r.types || [] }; }).filter(function(p) { return p.label; }) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), places: [] };
  }
}
function tsgApplyTravelTimes_(doc) {
  var base = tsgHomeBase_(doc);
  var calls = 0;
  var items = [];
  (doc.tasks || []).forEach(function(t) { if (!t) return; items.push(t); (t.subitems || []).forEach(function(s) { if (s) items.push(s); }); });
  items.forEach(function(t) {
    if (!t) return;
    var loc = String(t.location || '').trim();
    if (!loc) { if (t.travelMin != null || t.travelFor) { delete t.travelMin; delete t.travelOneWayMin; delete t.travelFor; delete t.travelOptions; delete t.travelRecommended; delete t.travelMethodUsed; } return; }
    if (!base) return;
    var key = tsgTravelKey_(loc, base);
    if (!(t.travelFor === key && t.travelOptions)) {
      if (t.status === 'Done' || t.status === 'Cancelled' || t.done) return;
      if (calls >= TSG_TRAVEL_PER_RUN_CAP) return;
      calls++;
      var opts = tsgTravelOptions_(base, loc);
      if (opts.drive == null && opts.walk == null && opts.transit == null) { Logger.log('[travel] #' + t.id + ' "' + loc + '": no route by any method'); return; }
      t.travelOptions = opts;
      t.travelRecommended = tsgRecommendTravel_(opts);
      t.travelFor = key;
      if (!t.travelMode) t.travelMode = 'round';
      t.history = t.history || [];
      t.history.push({ ts: new Date().toISOString(), field: 'travelOptions', from: null,
        to: TSG_TRAVEL_METHODS.filter(function(m) { return opts[m] != null; }).map(function(m) { return m + ' ' + opts[m] + ' min'; }).join(', ') + ' — recommended: ' + t.travelRecommended, source: 'Maps' });
    }
    // Effective minutes follow the chosen (or recommended) method; recomputed on every
    // write so a method change on the dashboard takes effect without a Maps call.
    var used = tsgTravelMethodUsed_(t);
    var oneWay = used ? t.travelOptions[used] : null;
    if (oneWay == null) { delete t.travelOneWayMin; delete t.travelMin; return; }
    t.travelMethodUsed = used;
    t.travelOneWayMin = oneWay;
    t.travelMin = oneWay * 2;
  });
}
/** Hours a work item costs on the schedule: its estimate plus round-trip travel when it has one. */
function tsgItemHours_(r) {
  return (Number(r.estHours) || 0) + tsgTravelChargeMinutes_(r) / 60;
}

function tsgAutoScheduleDoc_(doc) {
  try { tsgIndexReminders_(doc); } catch (remErr) { Logger.log('[reminders] index failed: ' + remErr.message); }
  var tasks = doc.tasks || [];

  // Transient, recomputed from scratch each run: a warning from a previous pass must not
  // linger after the condition clears.
  if (doc.meta) delete doc.meta._scheduleWarning;

  tsgPurgeBogusRollupTagHistory_(doc);
  tsgMigrateAssigneeToDelegate_(doc);
  tsgRollupSubitemHours_(doc, new Date().toISOString());
  tsgApplyTravelTimes_(doc);
  tsgFlagAgingTasks_(doc, tsgTodayIso_());

  var allItems = [];
  tasks.forEach(function(t) {
    if (t.status === 'Done' || t.status === 'Cancelled') return;
    tsgWorkItemsOf_(t).forEach(function(it) { allItems.push(it); });
  });

  var candidates = allItems.filter(function(it) {
    var r = it.ref;
    return !r.timelineEnd && !(r.scheduledStart && r.estDays);
  });
  var queue = candidates.filter(function(it) { return it.ref.estHours; });
  if (!queue.length) return 0;   // nothing unscheduled with an estimate

  // Approaching the loop cap: warn BEFORE anything gets truncated, while there's still
  // time to do something about it. One placement per iteration, so a queue at or above
  // the warning line is already within reach of the ceiling.
  if (queue.length >= TSG_SCHEDULE_LOOP_WARN_AT) {
    Logger.log('[schedule] WARNING: ' + queue.length + ' unscheduled work items queued, against a loop cap of ' +
               TSG_SCHEDULE_LOOP_CAP + '. Items past the cap will be silently left unscheduled this run.');
  }

  var today = tsgTodayIso_();
  var dateLoad = {};
  function loadOn(d) { return dateLoad[d] || 0; }
  function addLoad(d, h) { dateLoad[d] = loadOn(d) + h; }

  // Seed: Durand's own already-scheduled work — whole tasks AND his own subitems
  // inside a multi-person task alike — shares the same days. A step delegated to
  // someone else never touches this pool, even if it already has a placeholder
  // schedule, since that was never really competing for HIS time.
  allItems.forEach(function(it) {
    var r = it.ref;
    if (!tsgItemIsDurandWork_(it)) {
      // Not Durand's own work, so it never draws on his capacity pool directly — but if
      // it's already scheduled from an earlier run, the 0.5h "confirm this is done" slice
      // still needs to be reserved on his calendar the day after, same as a freshly
      // placed one below.
      var existingSpan = tsgScheduledSpan_(r);
      if (existingSpan) tsgReserveConfirmCapacity_(addLoad, today, existingSpan.end);
      return;
    }
    var hours = tsgItemHours_(r);
    if (!hours) return;
    var span = tsgScheduledSpan_(r);
    if (!span) return;
    var perDay = hours / span.days;
    if (span.chunkDays) {
      span.chunkDays.forEach(function(d) { if (d >= today) addLoad(d, perDay); });
    } else {
      var d = span.start, hit = 0, guard = 0;
      while (d <= span.end && hit < span.days && guard++ < TSG_SCHEDULE_LOOP_CAP) {
        if (tsgIsWorkdayIso_(d)) { hit++; if (d >= today) addLoad(d, perDay); }
        d = tsgAddDays_(d, 1);
      }
      if (guard >= TSG_SCHEDULE_LOOP_CAP) {
        // ~5.5 years of day-stepping for a single item's span — almost certainly a
        // corrupt start/end pair rather than a real schedule. Its capacity seed is
        // incomplete from here on, so say so instead of seeding a silent partial.
        Logger.log('[schedule] WARNING: capacity seed for ' + it.label + ' hit the ' + TSG_SCHEDULE_LOOP_CAP +
                   '-iteration cap walking ' + span.start + ' -> ' + span.end +
                   '. Its remaining days were not seeded — check that span for bad dates.');
      }
    }
  });

  // Seed: real calendar meetings actually eat into the day too. Never let a calendar
  // hiccup block a save — schedule on task load alone if it's unreachable.
  try {
    var events = getCalendarHours_(today, tsgAddDays_(today, 120));
    // bufferedHours (meeting duration + prep/travel — see getCalendarHours_) is what
    // actually reserves capacity here; ev.hours stays the raw duration used elsewhere
    // for real actual-time attribution (tsgAttributeCalendarHours) and must not be
    // conflated with it.
    events.forEach(function(ev) { if (ev && ev.date >= today) addLoad(ev.date, ev.bufferedHours != null ? ev.bufferedHours : (ev.hours || 0)); });
  } catch (err) { /* calendar unavailable this run — proceed without it */ }

  // Seed: full-day absences (OOO/PTO/vacation/holiday/sick). getCalendarHours_()
  // deliberately skips all-day events (see its own comment — they're not a real timed
  // meeting conflict, and folding them in there would also leak a fabricated multi-hour
  // "meeting" into the dashboard's Today view and into tsgAttributeCalendarHours's
  // title-matching). But a full-day absence SHOULD stop new work from landing on that
  // date, so it's handled here instead: saturate that day's capacity outright rather
  // than adding a plausible-but-fake hour count.
  try {
    var oooDates = tsgGetOOODates_(today, tsgAddDays_(today, 120));
    oooDates.forEach(function(d) { if (d >= today) addLoad(d, tsgDayCapacity_(d)); });
  } catch (err) { /* calendar unavailable this run — proceed without it */ }

  var rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  // Only whole tasks are valid dependency targets for OTHER tasks — nothing in this
  // codebase points a top-level "depends" at an individual subitem. A subitem's own
  // sequencing is handled separately below, via tsgSubitemBlockedByIdx_.
  var finishDate = {};
  tasks.forEach(function(t) { if (t.timelineEnd) finishDate[t.id] = t.timelineEnd; });

  function isBlocked(item) {
    if (item.isSubitem) {
      var blockIdx = tsgSubitemBlockedByIdx_(item.parent.subitems, item.idx);
      if (blockIdx != null) return !item.parent.subitems[blockIdx].timelineEnd;
      // Clear of sibling blocking — the very first step in the chain still honors
      // the PARENT task's own external dependency, if it has one.
      if (item.idx === 0) {
        return tsgDependsList_(item.parent).some(function(id) {
          return id !== item.parent.id && !finishDate[id] && tasks.some(function(x) { return x.id === id; });
        });
      }
      return false;
    }
    return tsgDependsList_(item.ref).some(function(id) {
      return id !== item.parent.id && !finishDate[id] && tasks.some(function(x) { return x.id === id; });
    });
  }

  function earliestStartFor(item) {
    var earliest = today;
    if (item.isSubitem) {
      var blockIdx = tsgSubitemBlockedByIdx_(item.parent.subitems, item.idx);
      if (blockIdx != null) {
        var sib = item.parent.subitems[blockIdx];
        if (sib.timelineEnd && sib.timelineEnd >= earliest) earliest = tsgAddDays_(sib.timelineEnd, 1);
      } else if (item.idx === 0) {
        tsgDependsList_(item.parent).forEach(function(id) {
          if (finishDate[id] && finishDate[id] >= earliest) earliest = tsgAddDays_(finishDate[id], 1);
        });
      }
    } else {
      tsgDependsList_(item.ref).forEach(function(id) {
        if (finishDate[id] && finishDate[id] >= earliest) earliest = tsgAddDays_(finishDate[id], 1);
      });
    }
    return earliest;
  }

  var placed = 0, guard2 = 0;
  while (queue.length && guard2++ < TSG_SCHEDULE_LOOP_CAP) {
    // Highest-priority item whose dependencies (if any) already have a finish date —
    // either pre-existing or assigned earlier in this same pass — goes next. Anything
    // still blocked on an unresolved dependency waits its turn.
    var readyIdx = -1;
    for (var i = 0; i < queue.length; i++) {
      if (isBlocked(queue[i])) continue;
      if (readyIdx === -1) { readyIdx = i; continue; }
      var a = queue[readyIdx], b = queue[i];
      var aPri = a.ref.priority || a.parent.priority;
      var bPri = b.ref.priority || b.parent.priority;
      var pr = (rank[aPri] != null ? rank[aPri] : 4) - (rank[bPri] != null ? rank[bPri] : 4);
      if (pr > 0 || (pr === 0 && b.parent.id < a.parent.id)) readyIdx = i;
    }
    // Nothing ready — every remaining item is still blocked on a dependency (almost
    // always a circular depends chain, or one pointing at a task id that no longer
    // exists). Placing one anyway rather than stalling the whole pass is still right —
    // but silently treating "will never resolve" the same as "resolved" hid this
    // entirely before. Flag it now so it's visible on the board instead.
    var forcedPlacement = (readyIdx === -1);
    if (forcedPlacement) {
      // FLAG EVERY MEMBER OF THE DEADLOCK, not just the one we happen to force-place
      // (2026-09-02). readyIdx === -1 means every item still in the queue is blocked and
      // none of them can become unblocked on their own — they are ALL part of the same
      // unresolvable set. The old code flagged only queue[0]: force-placing it gave it a
      // finish date, which unblocked the rest of the cycle, so every other member got
      // scheduled normally and silently. In a two-task cycle A->B->A only A was ever
      // tagged; in a longer cycle exactly one arbitrary member was. Flagging the whole
      // remaining queue here makes it symmetric — every task caught in the cycle carries
      // the same 'Dependency Issue' tag, so the board shows the actual shape of the
      // problem instead of one random corner of it. tsgFlagUnresolvedDependency_ is
      // idempotent, so an item flagged here isn't re-logged if a second deadlock round
      // catches it again.
      queue.forEach(function(blockedItem) { tsgFlagUnresolvedDependency_(blockedItem); });
      readyIdx = 0;
    }
    var item = queue.splice(readyIdx, 1)[0];
    var t = item.ref;
    var priority = t.priority || item.parent.priority || 'Medium';
    var isDurandWork = tsgItemIsDurandWork_(item);

    var earliest = earliestStartFor(item);
    var d2 = earliest;
    while (!tsgIsWorkdayIso_(d2)) d2 = tsgAddDays_(d2, 1);

    // Date-independent ceiling: the priority's chunk rate, never above a full day.
    var chunkCap = Math.min(TSG_CHUNK_RATE[priority] || TSG_CHUNK_RATE.Medium, TSG_DAY_CAPACITY);
    var remaining = tsgItemHours_(t);
    var chunkDays = [];
    var firstDay = null, iter = 0;
    while (remaining > 0.001 && iter++ < 1000) {
      if (tsgIsWorkdayIso_(d2)) {
        // A step delegated to someone else paces at the same chunk rate for a
        // sensible-looking chain, but never checks — or eats into — Durand's own
        // daily capacity, since this system has no visibility into their calendar.
        //
        // Friday (2026-09-02): delegated work used to pace at the flat, date-independent
        // chunkCap, so nothing about it was Friday-aware at all. It only LOOKED right by
        // numeric coincidence — the largest chunk rate is Critical at 4h, and
        // TSG_FRIDAY_CAPACITY also happens to be 4, so no delegated chunk could ever
        // exceed a Friday. That equality is incidental: drop TSG_FRIDAY_CAPACITY to 3
        // (or raise a chunk rate above 4) and delegated work would silently start pacing
        // a 4h Friday chunk into a 3h day, with nothing in the code to catch it. Deriving
        // the per-day ceiling from tsgDayCapacity_ makes it structural instead of lucky.
        // Behavior at today's constants is unchanged.
        var dayCap = tsgDayCapacity_(d2);
        var dayChunkCap = Math.min(chunkCap, dayCap);
        // Durand's own work additionally competes for what's LEFT of the day after
        // meetings and other tasks; delegated work only respects the day's ceiling.
        var avail = isDurandWork ? Math.max(0, dayCap - loadOn(d2)) : dayChunkCap;
        var take = Math.min(remaining, dayChunkCap, avail);
        if (take > 0.001) {
          chunkDays.push(d2);
          if (isDurandWork) addLoad(d2, take);
          remaining -= take;
          if (!firstDay) firstDay = d2;
        }
      }
      d2 = tsgAddDays_(d2, 1);
    }
    if (!chunkDays.length) {
      // No capacity found across ~3 years of lookahead — leave it unscheduled, same as
      // before, but flag it: without this it looked identical to an ordinary task
      // nobody's gotten to yet, instead of the workload/estimate problem it actually is.
      t.tags = Array.from(new Set((t.tags || []).concat(['Scheduling Stuck'])));
      var stuckParent = item.parent;
      stuckParent.history = stuckParent.history || [];
      stuckParent.history.push({
        ts: new Date().toISOString(), field: 'scheduling-stuck', from: null,
        to: item.label + ' could not be scheduled — no capacity found in the next ~3 years. ' +
            'Check the estimate and overall workload.'
      });
      continue;
    }

    var before = t.timelineEnd;
    t.scheduledStart = firstDay;
    t.scheduledDays = chunkDays;
    t.estDays = chunkDays.length;
    t.timelineEnd = chunkDays[chunkDays.length - 1];

    if (!item.isSubitem) {
      // A whole task: log on itself, and it becomes a valid dependency target.
      t.history = t.history || [];
      t.history.push({ ts: new Date().toISOString(), field: 'timelineEnd', from: before || null, to: t.timelineEnd, note: 'auto-scheduled' });
      finishDate[t.id] = t.timelineEnd;
      if (!isDurandWork) tsgReserveConfirmCapacity_(addLoad, today, t.timelineEnd);
    } else {
      // A subitem: it carries no history of its own, so the note goes on the parent
      // task instead, naming which subitem it was. Nothing outside its own task ever
      // depends on it, so it never needs a finishDate[] entry of its own — the next
      // step in its chain reads its timelineEnd directly off this same object.
      item.parent.history = item.parent.history || [];
      item.parent.history.push({ ts: new Date().toISOString(), field: 'subitem-scheduled', from: null,
        to: 'Auto-scheduled ' + item.label + ' for ' + t.timelineEnd, note: 'auto-scheduled' });
      if (!isDurandWork) {
        // Freshly placed non-Durand step — reserve the 0.5h "confirm this is done" slice
        // on Durand's capacity pool now, so any items still left in the queue this same
        // run see that slice of his day as already spoken for.
        tsgReserveConfirmCapacity_(addLoad, today, t.timelineEnd);
      }
    }
    placed++;
  }

  // The cap actually fired: `queue` is non-empty, and everything still in it was dropped
  // on the floor this run with no tag, no history entry and no error — exactly the silent
  // truncation this warning exists to surface. Behavior is deliberately unchanged (the
  // items are still simply left for the next pass); it is now just observable, in the
  // execution log and on the document itself.
  if (guard2 >= TSG_SCHEDULE_LOOP_CAP && queue.length) {
    var warn = 'Auto-schedule stopped at its ' + TSG_SCHEDULE_LOOP_CAP + '-iteration cap with ' +
               queue.length + ' work item(s) still unscheduled. They were left untouched this run. ' +
               'This usually means the board has outgrown the cap, or a dependency cycle is churning placements.';
    Logger.log('[schedule] WARNING: ' + warn);
    // Transient marker only — deleted at the top of every run, never part of the
    // document's core shape, and never version-bumped on its own account.
    if (doc.meta) doc.meta._scheduleWarning = warn;
  }

  // The chain may have moved since tsgRollupSubitemHours_ ran at the top (new subitems
  // just got their first-ever timelineEnd) — one more pass keeps top-level timelineEnd
  // honest without re-running the hours sum (hours didn't change from scheduling alone).
  tasks.forEach(function(t) {
    if (!t.subitems || !t.subitems.length) return;
    t.timelineEnd = tsgRollupDue_(t, tsgOpenSubitemHours_(t).latestOpenEnd);
  });

  return placed;
}
