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
const TSG_CODE_VERSION = '2026-09-24.2';

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
 * pushing workstream/current patches into _Inbox alongside the dashboard's own Settings
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
    const patches = [], malformed = [];
    while (it.hasNext()) {
      const f = it.next();
      if (f.isTrashed()) continue;
      // A file already filed as FAILED-/PARTIAL-/MALFORMED- stays in _Inbox as the record of
      // what went wrong (2026-09-18); it is never re-read. After TSG_INBOX_KEEP_DAYS the
      // tracker trashes it itself (the meta.inboxErrors record stays), per Durand 2026-09-17
      // ("why can't you delete or archive it").
      if (/^(FAILED|PARTIAL|MALFORMED)-/.test(f.getName())) {
        try {
          var ageMs = Date.now() - f.getDateCreated().getTime();
          if (ageMs > TSG_INBOX_KEEP_DAYS * 86400000) { f.setTrashed(true); Logger.log('[inbox] filed patch "' + f.getName() + '" trashed after ' + TSG_INBOX_KEEP_DAYS + ' days'); }
        } catch (ageErr) {}
        continue;
      }
      try {
        patches.push({ file: f, patch: JSON.parse(f.getBlob().getDataAsString()), created: f.getDateCreated() });
      } catch (err) {
        Logger.log('[inbox] malformed patch file "' + f.getName() + '" kept as MALFORMED-: ' + err);
        var rawText = ''; try { rawText = f.getBlob().getDataAsString(); } catch (e3) {}
        malformed.push({ ts: new Date().toISOString(), file: f.getName(), target: null, op: null,
          error: 'malformed JSON: ' + String((err && err.message) || err) + tsgJsonErrorExcerpt_(rawText, err), bytes: rawText.length });
        try { f.setName('MALFORMED-' + f.getName()); } catch (e2) {}
      }
    }
    if (patches.length === 0 && malformed.length === 0) {
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

    // applied: patches whose result is written; kept: files that stay in _Inbox under a
    // prefix (FAILED- = rolled back and dropped, PARTIAL- = a bulk whose failing sub-ops
    // were rolled back while the rest applied); errors: what meta.inboxErrors records.
    const applied = [], kept = [], errors = malformed.slice();
    patches.forEach(function(p) {
      const patch = p.patch;
      var target = patch.target === 'rulesets' ? rulesetsDoc : (patch.target === 'data' ? dataDoc : null);
      var snap = target ? JSON.stringify(target) : null;
      var opName = String(patch.op) + (patch.op === 'bulk' ? '[' + (patch.ops || []).map(function(x) { return x && x.op; }).join(',') + ']' : '');
      try {
        if (patch.target === 'rulesets') applyRulesetPatch_(rulesetsDoc, patch);
        else if (patch.target === 'data') applyDataPatch_(dataDoc, patch);
        else throw new Error('unknown target: ' + patch.target);
        applied.push(p);
      } catch (err) {
        var entry = { ts: new Date().toISOString(), file: p.file.getName(), target: patch.target || null, op: opName, error: String((err && err.message) || err) };
        if (err && err.partial) { entry.appliedSubOps = err.partial.applied; entry.failedSubOps = err.partial.errors; }
        if (err && err.partial && err.partial.applied > 0) {
          applied.push(p); kept.push({ p: p, prefix: 'PARTIAL-' });
          Logger.log('[inbox] patch "' + p.file.getName() + '" applied in part, kept as PARTIAL-: ' + err);
        } else {
          if (target && snap) tsgRestoreDoc_(target, snap);
          kept.push({ p: p, prefix: 'FAILED-' });
          Logger.log('[inbox] patch "' + p.file.getName() + '" failed, rolled back, kept as FAILED-: ' + err);
        }
        errors.push(entry);
      }
    });
    // The trace lives in the data file. A rulesets-only pass that failed loads it just for that.
    var dataDirty = false;
    if (errors.length) {
      if (!dataDoc) {
        try { dataFile = getTrackerFile_('data'); dataDoc = JSON.parse(dataFile.getBlob().getDataAsString()); }
        catch (loadErr2) { Logger.log('[inbox] cannot load the data file to record ' + errors.length + ' error(s): ' + loadErr2); }
      }
      if (dataDoc) { errors.forEach(function(e) { tsgRecordInboxError_(dataDoc, e); }); dataDirty = true; }
      // No email (Durand 2026-09-18: "dont email me, just log and notify in tracker"): the record
      // above is the log; the dashboard raises a critical alert row and a toast for a new entry.
    }

    if (rulesetsDoc && applied.some(function(p) { return p.patch.target === 'rulesets'; })) {
      // INSTRUCTION LAYERS (2026-09-22): every instruction set is mirrored to its Google Doc
      // before the rulesets write so meta.mirrorDocs lands in the same save. Never fails the write.
      try { tsgEnsureWorkstreamIds_(rulesetsDoc); }   // thread -> workstream migration and the id backfill ride the first write after deploy
      catch (idErr) { Logger.log('[workstreams] migration / id backfill skipped: ' + idErr); }
      try { tsgMirrorInstructions_(rulesetsDoc); }
      catch (mirrorErr) { Logger.log('[mirror] instruction mirror skipped: ' + mirrorErr); }
      // Only the latest instructions stay in the hot file; older changelog lines move to History/.
      try { tsgArchiveRulesetsHistory_(rulesetsDoc, new Date().toISOString()); }
      catch (rsArchErr) { Logger.log('[history] rulesets archive skipped, nothing pruned: ' + rsArchErr.message); }
      const rsJson = JSON.stringify(rulesetsDoc);
      rulesetsFile.setContent(rsJson);
      try { backupTrackerFile_('rulesets', rsJson); }
      catch (backupErr) { Logger.log('Backup snapshot failed for rulesets: ' + backupErr); }
    }
    if (dataDoc && (dataDirty || applied.some(function(p) { return p.patch.target === 'data'; }))) {
      tsgAutoScheduleDoc_(dataDoc);
      // History retention (2026-09-18): lines over the per-item cap move to a sibling file in
      // the History folder BEFORE the data write; a failed archive write prunes nothing.
      try { tsgArchiveHistory_(dataDoc, new Date().toISOString()); }
      catch (archErr) { Logger.log('[history] archive skipped, nothing pruned: ' + archErr.message); }
      var hb = tsgCurrentHeartbeat_();
      if (hb) { dataDoc.meta = dataDoc.meta || {}; dataDoc.meta.lastLiveHeartbeat = hb; }
      const dataJson = JSON.stringify(dataDoc);
      dataFile.setContent(dataJson);
      tsgCachePut_('docVersion', String(dataDoc.meta && dataDoc.meta.docVersion), 21600);
      // Small index beside the data file for sessions that cannot hold the whole document
      // (2026-09-22); a failure here never fails the write.
      try { tsgWriteIndex_(dataDoc); } catch (idxErr) { Logger.log('[index] write failed: ' + idxErr.message); }
      try { backupTrackerFile_('data', dataJson); }
      catch (backupErr) { Logger.log('Backup snapshot failed for data: ' + backupErr); }
    }
    // Trash only now, after the writes succeeded. A write that throws leaves every file in
    // place for the next pass: at-least-once, never silently lost.
    var keptFiles = kept.map(function(k) { return k.p; });
    applied.forEach(function(p) { if (keptFiles.indexOf(p) === -1) p.file.setTrashed(true); });
    kept.forEach(function(k) { try { k.p.file.setName(k.prefix + k.p.file.getName()); } catch (e2) {} });
    var failedCount = kept.filter(function(k) { return k.prefix === 'FAILED-'; }).length;
    var partialCount = kept.length - failedCount;
    return { ok: true, applied: applied.length - partialCount, partial: partialCount, failed: failedCount, malformed: malformed.length };
  } finally {
    lock.releaseLock();
  }
}

// Script-cache helpers: every call is best-effort, the cache is an optimization only.
var TSG_INBOX_EMPTY_TTL_SEC = 50;
var TSG_INBOX_KEEP_DAYS = 7;   // how long a FAILED-/PARTIAL-/MALFORMED- file stays in _Inbox
function tsgJsonErrorExcerpt_(text, err) {
  var m = /position (\d+)/.exec(String((err && err.message) || err || ''));
  if (!m || !text) return '';
  var at = Number(m[1]), from = Math.max(0, at - 30);
  return ' near: ' + JSON.stringify(String(text).slice(from, at + 30));
}
function tsgCachePut_(k, v, ttlSec) { try { CacheService.getScriptCache().put(k, v, ttlSec); } catch (err) {} }
function tsgCacheGet_(k) { try { return CacheService.getScriptCache().get(k); } catch (err) { return null; } }
// A JSON value computed by fn, cached ttlSec in the script cache (audit 2026-09-22: the two
// 120-day calendar scans ran on every write). Never cached when over the 90 KB entry limit.
function tsgCachedJson_(key, ttlSec, fn) {
  var hit = tsgCacheGet_(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var val = fn();
  try { var js = JSON.stringify(val); if (js && js.length < 90000) tsgCachePut_(key, js, ttlSec); } catch (e2) {}
  return val;
}
function tsgCacheRemove_(k) { try { CacheService.getScriptCache().remove(k); } catch (err) {} }

/**
 * Workstream names are used as object keys, so a few JS-reserved ones can never be honest
 * own-properties: workstreams['__proto__'] = {...} assigns to the prototype and silently
 * creates nothing, and workstreams['constructor'] reads back truthy from Object.prototype
 * even when no such workstream exists. Rather than special-case the storage, reject these
 * names outright with a clear error (2026-09-02, when they were still called threads).
 */
var TSG_RESERVED_WORKSTREAM_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
function tsgAssertSafeWorkstreamName_(op, name) {
  var n = String(name == null ? '' : name);
  if (!n) throw new Error(op + ': workstream name is required');
  if (TSG_RESERVED_WORKSTREAM_KEYS[n]) {
    throw new Error(op + ': "' + n + '" is a reserved JavaScript object key and cannot be used as a workstream name. Rename the workstream.');
  }
  return n;
}
/** Own-property existence check — never walks the prototype chain (see above). */
function tsgHasWorkstream_(doc, name) {
  return Object.prototype.hasOwnProperty.call(doc.workstreams, String(name));
}

/**
 * THREAD -> WORKSTREAM (Durand, 2026-09-23: rename "thread" to "workstream" everywhere and
 * track which sessions belong to which workstream). Storage moved: `threads` -> `workstreams`,
 * meta.next_thread_id -> meta.next_workstream_id, mirror records 'thread:<id>' ->
 * 'workstream:<id>'. tsgMigrateWorkstreams_ does it in place, idempotently, on every read and
 * write path (it runs first inside tsgEnsureWorkstreamIds_), so an un-migrated file still
 * works and the first rulesets write after deploy persists the new keys. Ids keep their
 * values (T002, T018 ...): never renumbered, never reused. If a file somehow holds BOTH keys,
 * `workstreams` wins and any name only under `threads` is carried over. The old *_thread op
 * names stay accepted as aliases (TSG_WORKSTREAM_OP_ALIASES).
 */
function tsgMigrateWorkstreams_(doc) {
  if (!doc || typeof doc !== 'object') return false;
  var changed = false;
  if (Object.prototype.hasOwnProperty.call(doc, 'threads')) {
    var old = doc.threads && typeof doc.threads === 'object' ? doc.threads : {};
    if (!doc.workstreams || typeof doc.workstreams !== 'object') doc.workstreams = {};
    Object.keys(old).forEach(function(n) {
      if (!Object.prototype.hasOwnProperty.call(doc.workstreams, n)) doc.workstreams[n] = old[n];
      else Logger.log('[workstreams] migration: "' + n + '" is under both keys; kept the workstreams copy');
    });
    delete doc.threads;
    changed = true;
  }
  if (!doc.workstreams || typeof doc.workstreams !== 'object') doc.workstreams = {};
  var meta = doc.meta;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'next_thread_id')) {
    var a = typeof meta.next_thread_id === 'number' ? meta.next_thread_id : 0;
    var b = typeof meta.next_workstream_id === 'number' ? meta.next_workstream_id : 0;
    if (a || b) meta.next_workstream_id = Math.max(a, b);   // the counter only ever rises
    delete meta.next_thread_id;
    changed = true;
  }
  var md = meta && meta.mirrorDocs;
  if (md && typeof md === 'object') {
    Object.keys(md).forEach(function(k) {
      if (k.indexOf('thread:') !== 0) return;
      var nk = 'workstream:' + k.slice('thread:'.length);
      if (!md[nk]) md[nk] = md[k];
      delete md[k];
      changed = true;
    });
  }
  return changed;
}

/**
 * WORKSTREAM IDS (2026-09-23, per Durand: "threads identify themselves by an ID generated on
 * creation that never changes, so there are no title-change errors").
 * `workstreams` stays keyed by name (the dashboard and the history code depend on it); every
 * workstream object carries an immutable `id` = 'T' + zero-padded number, allocated from the
 * server-owned counter meta.next_workstream_id. Never derived from the count, never reused
 * (a removed workstream's number is gone for good). No patch or client save can set or change
 * an id: add_workstream ignores one, replace_all restores the server's id for a workstream of
 * the same name and drops any other, and every workstream op resolves `id` or `name` through
 * tsgResolveWorkstream_ (id wins; a disagreeing pair is an error). Mirror Docs are keyed
 * 'workstream:<id>' so a rename (rename_workstream) retitles the same Doc.
 */
var TSG_WORKSTREAM_ID_RE = /^T(\d{3,})$/;
function tsgWorkstreamIdFor_(n) { var d = String(n); while (d.length < 3) d = '0' + d; return 'T' + d; }
function tsgWorkstreamIdNumber_(id) { var m = TSG_WORKSTREAM_ID_RE.exec(String(id || '')); return m ? Number(m[1]) : null; }
function tsgWorkstreamFirstTs_(ws) {
  var h = ws && Array.isArray(ws.history) ? ws.history : [];
  for (var i = 0; i < h.length; i++) { if (h[i] && h[i].ts) { var ms = Date.parse(h[i].ts); if (!isNaN(ms)) return ms; } }
  return Number.MAX_SAFE_INTEGER;   // no dated history: after every dated workstream, then by name
}
/** Migrates old keys, then gives every workstream without a valid, unique id the next one, oldest first (first history ts, then name). Idempotent. */
function tsgEnsureWorkstreamIds_(doc) {
  if (!doc) return 0;
  if (!doc.meta) doc.meta = {};
  tsgMigrateWorkstreams_(doc);
  var wss = doc.workstreams;
  var names = Object.keys(wss).filter(function(n) { return wss[n] && typeof wss[n] === 'object'; });
  var maxNum = 0, seen = {}, missing = [];
  var ordered = names.slice().sort(function(a, b) { return (tsgWorkstreamFirstTs_(wss[a]) - tsgWorkstreamFirstTs_(wss[b])) || a.localeCompare(b); });
  ordered.forEach(function(n) {
    var id = wss[n].id, num = tsgWorkstreamIdNumber_(id);
    if (num == null || seen[id]) { missing.push(n); return; }   // no id, malformed, or a duplicate of an earlier workstream's
    seen[id] = true;
    if (num > maxNum) maxNum = num;
  });
  // The counter only ever rises: never below the highest id in use, never reset by a client copy.
  if (typeof doc.meta.next_workstream_id !== 'number' || doc.meta.next_workstream_id <= maxNum) doc.meta.next_workstream_id = maxNum + 1;
  missing.forEach(function(n) {
    var was = wss[n].id;
    wss[n].id = tsgWorkstreamIdFor_(doc.meta.next_workstream_id);
    doc.meta.next_workstream_id += 1;
    if (was) Logger.log('[workstreams] "' + n + '": ignored id ' + JSON.stringify(was) + ' (not the server\'s); assigned ' + wss[n].id);
  });
  return missing.length;
}
function tsgWorkstreamNameById_(doc, id) {
  var want = String(id || '');
  if (!want) return null;
  var names = Object.keys((doc && doc.workstreams) || {});
  for (var i = 0; i < names.length; i++) { var ws = doc.workstreams[names[i]]; if (ws && ws.id === want) return names[i]; }
  return null;
}
/** The name key a workstream op addresses: `id` wins, `name` still works, both must agree. */
function tsgResolveWorkstream_(doc, patch, op) {
  var byId = patch.id != null && patch.id !== '' ? tsgWorkstreamNameById_(doc, patch.id) : null;
  if (patch.id != null && patch.id !== '' && !byId) throw new Error(op + ': workstream id not found: ' + patch.id);
  var name = patch.name != null && patch.name !== '' ? String(patch.name) : null;
  if (byId && name && byId !== name) throw new Error(op + ': id ' + patch.id + ' is "' + byId + '", not "' + name + '" (id and name disagree)');
  if (byId) return byId;
  if (!name) throw new Error(op + ': workstream id or name is required');
  if (!tsgHasWorkstream_(doc, name)) throw new Error(op + ': workstream not found: ' + name);
  return name;
}
/** Old op names (sessions and skills still send them) -> the workstream op they mean. */
var TSG_WORKSTREAM_OP_ALIASES = {
  add_thread: 'add_workstream',
  update_thread_instructions: 'update_workstream_instructions',
  add_thread_memory: 'add_workstream_memory',
  remove_thread_memory: 'remove_workstream_memory',
  remove_thread: 'remove_workstream',
  rename_thread: 'rename_workstream',
  set_thread_code: 'set_workstream_code'
};
function tsgCanonicalRulesetOp_(op) {
  return Object.prototype.hasOwnProperty.call(TSG_WORKSTREAM_OP_ALIASES, op) ? TSG_WORKSTREAM_OP_ALIASES[op] : op;
}
/**
 * SESSIONS (2026-09-23): each workstream keeps `sessions[]`, newest first, one entry per Claude
 * session that worked on it: {sessionId, surface, title, startedAt, firstSeen, lastSeen}.
 * record_session appends or updates by sessionId (lastSeen = the patch ts). Only ids are stored
 * (session_01..., cse_...), never links: a link dies with its session. A pasted link is reduced
 * to the id it carries, else refused. Past TSG_WORKSTREAM_SESSIONS_KEEP the oldest entries move
 * to rs.meta.sessionArchiveStash, which tsgArchiveRulesetsHistory_ writes into the dated
 * History/rulesets-history file on the same write.
 */
var TSG_WORKSTREAM_SESSIONS_KEEP = 50;
var TSG_SESSION_SURFACES = ['chat', 'cowork', 'code-local', 'code-cloud', 'scheduled', 'routine'];
function tsgCleanSessionId_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('record_session: sessionId is required');
  if (/[\/:?#\s]/.test(s)) {
    var m = /(session_[A-Za-z0-9]+|cse_[A-Za-z0-9]+)/.exec(s);
    if (!m) throw new Error('record_session: sessionId must be a session id (session_... or cse_...), not a link: ' + s.slice(0, 80));
    s = m[1];
  }
  return s;
}

/**
 * RULESETS VERSIONING (2026-09-02) — meta.docVersion.
 *
 * The Rulesets document had no version check whatsoever: target=rulesets was a blind
 * whole-document overwrite. It now has two genuinely uncoordinated writers (the
 * dashboard's Settings UI, and Claude sessions pushing workstream/current patches through
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
  tsgEnsureWorkstreamIds_(doc);   // the migration + id backfill: every workstream has its id before any op resolves one

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
    // A page loaded before the rename still sends `threads`; either key lands as workstreams.
    var incomingWs = (incoming.workstreams && typeof incoming.workstreams === 'object') ? incoming.workstreams
      : ((incoming.threads && typeof incoming.threads === 'object') ? incoming.threads : null);
    if (incomingWs) {
      // Ids are server-owned: a workstream of the same name keeps the id the server holds (a
      // copy that stripped it gets it back, a copy that changed it is ignored and logged); a
      // workstream new to the server gets a fresh id from the counter, never one the client made up.
      var prevWs = doc.workstreams || {};
      doc.workstreams = incomingWs;
      Object.keys(doc.workstreams).forEach(function(n) {
        var ws = doc.workstreams[n]; if (!ws || typeof ws !== 'object') return;
        var prev = Object.prototype.hasOwnProperty.call(prevWs, n) ? prevWs[n] : null;
        if (prev && prev.id) {
          if (ws.id && ws.id !== prev.id) Logger.log('[workstreams] replace_all: "' + n + '" sent id ' + JSON.stringify(ws.id) + ', kept ' + prev.id);
          ws.id = prev.id;
        } else if (ws.id) {
          Logger.log('[workstreams] replace_all: new workstream "' + n + '" sent id ' + JSON.stringify(ws.id) + ', ignored');
          delete ws.id;
        }
      });
      tsgEnsureWorkstreamIds_(doc);
    }
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
  if (!doc.workstreams) doc.workstreams = {};
  var op = tsgCanonicalRulesetOp_(patch.op);

  if (op === 'append_category') {
    doc.current[patch.category].content += '\n\n' + patch.text;
    doc.current[patch.category].pushed = now;
  } else if (op === 'replace_category_text') {
    const cur = doc.current[patch.category].content;
    if (cur.indexOf(patch.find) === -1) throw new Error('replace_category_text: find text not present');
    doc.current[patch.category].content = cur.split(patch.find).join(patch.replace);
    doc.current[patch.category].pushed = now;
  } else if (op === 'set_category') {
    // Creates the category when it does not exist yet (2026-09-22: the Code set is born this way).
    if (!doc.current) doc.current = {};
    if (!doc.current[patch.category]) doc.current[patch.category] = { content: '', pushed: now };
    doc.current[patch.category].content = patch.text;
    doc.current[patch.category].pushed = now;
  } else if (op === 'remove_category') {
    if (!doc.current || !Object.prototype.hasOwnProperty.call(doc.current, patch.category)) throw new Error('remove_category: category not found: ' + patch.category);
    delete doc.current[patch.category];
  } else if (op === 'set_workstream_code') {
    // A code workstream's mirror Doc carries the Code layer under General (INSTRUCTION LAYERS, 2026-09-22).
    var codeName = tsgResolveWorkstream_(doc, patch, op);
    doc.workstreams[codeName].code = !!patch.code;
    doc.workstreams[codeName].history.push({ ts: now, action: 'update', summary: (patch.code ? 'Marked as a code workstream (Code layer applies).' : 'No longer a code workstream.') });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'rename_workstream') {
    // The id stays; the name key moves with instructions, memories, code, sessions and history (2026-09-23).
    var oldName = tsgResolveWorkstream_(doc, patch, op);
    var newName = tsgAssertSafeWorkstreamName_(op, patch.newName);
    if (newName === oldName) return;
    if (tsgHasWorkstream_(doc, newName)) throw new Error(op + ': a workstream named "' + newName + '" already exists');
    var moved = doc.workstreams[oldName];
    delete doc.workstreams[oldName];
    doc.workstreams[newName] = moved;
    if (!Array.isArray(moved.history)) moved.history = [];
    moved.history.push({ ts: now, action: 'rename', summary: 'Renamed from ' + oldName + ' to ' + newName + '.' });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'mirror_instructions') {
    // No change to the document; the write it triggers re-mirrors every instruction set.
    return;

  } else if (op === 'add_workstream') {
    // Reserved-key guard + own-property existence check — see tsgAssertSafeWorkstreamName_.
    const addName = tsgAssertSafeWorkstreamName_(op, patch.name);
    if (tsgHasWorkstream_(doc, addName)) throw new Error(op + ': workstream already exists: ' + addName);
    doc.workstreams[addName] = {
      instructions: patch.instructions || '',
      memories: patch.memories || [],
      history: [{ ts: now, action: 'baseline', summary: (patch.historyEntry && patch.historyEntry.summary) || 'Workstream added.' }]
    };
    if (patch.id) Logger.log('[workstreams] add_workstream "' + addName + '": ignored supplied id ' + JSON.stringify(patch.id));
    tsgEnsureWorkstreamIds_(doc);   // the new workstream takes the next id; a patch never picks one
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'update_workstream_instructions') {
    var uName = tsgResolveWorkstream_(doc, patch, op);
    doc.workstreams[uName].instructions = patch.instructions || '';
    doc.workstreams[uName].history.push({
      ts: now,
      action: (patch.historyEntry && patch.historyEntry.action) || 'update',
      summary: (patch.historyEntry && patch.historyEntry.summary) || 'Instructions updated.'
    });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'add_workstream_memory') {
    var amName = tsgResolveWorkstream_(doc, patch, op);
    if (!Array.isArray(doc.workstreams[amName].memories)) doc.workstreams[amName].memories = [];
    doc.workstreams[amName].memories.push(patch.memory);
    doc.workstreams[amName].history.push({
      ts: now,
      action: (patch.historyEntry && patch.historyEntry.action) || 'update',
      summary: (patch.historyEntry && patch.historyEntry.summary) || ('Memory added: "' + patch.memory + '"')
    });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'remove_workstream_memory') {
    var rmName = tsgResolveWorkstream_(doc, patch, op);
    if (typeof patch.index !== 'number' || patch.index < 0) throw new Error(op + ': index must be a non-negative number');
    doc.workstreams[rmName].memories.splice(patch.index, 1);
    doc.workstreams[rmName].history.push({
      ts: now,
      action: (patch.historyEntry && patch.historyEntry.action) || 'update',
      summary: (patch.historyEntry && patch.historyEntry.summary) || 'Memory removed.'
    });
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'remove_workstream') {
    var delName = tsgResolveWorkstream_(doc, patch, op);
    delete doc.workstreams[delName];   // its number is never reused: the counter only rises
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'record_session') {
    // No history line: a session check-in is not an instruction change and would push the
    // real changelog out of the hot file (TSG_RULESETS_HISTORY_KEEP).
    var sName = tsgResolveWorkstream_(doc, patch, op);
    var sid = tsgCleanSessionId_(patch.sessionId);
    if (patch.surface != null && patch.surface !== '' && TSG_SESSION_SURFACES.indexOf(patch.surface) === -1) {
      throw new Error(op + ': surface must be one of ' + TSG_SESSION_SURFACES.join(', ') + ' (got ' + JSON.stringify(patch.surface) + ')');
    }
    var wsS = doc.workstreams[sName];
    if (!Array.isArray(wsS.sessions)) wsS.sessions = [];
    var at = -1;
    for (var si = 0; si < wsS.sessions.length; si++) { if (wsS.sessions[si] && wsS.sessions[si].sessionId === sid) { at = si; break; } }
    var entry = at >= 0 ? wsS.sessions.splice(at, 1)[0] : { sessionId: sid, firstSeen: now };
    if (patch.surface) entry.surface = patch.surface;
    if (patch.title != null && patch.title !== '') entry.title = String(patch.title).slice(0, 200);
    if (patch.startedAt) entry.startedAt = String(patch.startedAt);
    entry.lastSeen = now;
    wsS.sessions.unshift(entry);   // newest first
    if (wsS.sessions.length > TSG_WORKSTREAM_SESSIONS_KEEP) {
      var over = wsS.sessions.splice(TSG_WORKSTREAM_SESSIONS_KEEP);
      doc.meta.sessionArchiveStash = doc.meta.sessionArchiveStash || {};
      var stashKey = wsS.id || sName;
      doc.meta.sessionArchiveStash[stashKey] = (doc.meta.sessionArchiveStash[stashKey] || []).concat(over.map(function(s) { return Object.assign({ workstream: sName }, s); }));
    }
    doc.meta.last_updated = now.slice(0, 10);
    return;
  } else if (op === 'set_workstream_links') {
    var lName = tsgResolveWorkstream_(doc, patch, op);
    var wsL = doc.workstreams[lName];
    var links = Object.assign({}, wsL.links || {});
    var changedKeys = [];
    ['projectUrl', 'repo', 'notes'].forEach(function(k) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) return;
      var v = patch[k] == null ? '' : String(patch[k]).trim();
      if (k === 'projectUrl' && v && !/^https:\/\/claude\.ai\/project\//.test(v)) throw new Error(op + ': projectUrl must be a https://claude.ai/project/... link');
      if (k === 'repo' && v && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''))) throw new Error(op + ': repo must be owner/repo or a github.com link');
      if (k === 'repo') v = v.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '');
      if (v) links[k] = v; else delete links[k];
      changedKeys.push(k);
    });
    if (!changedKeys.length) throw new Error(op + ': give at least one of projectUrl, repo, notes');
    wsL.links = links;
    if (!Array.isArray(wsL.history)) wsL.history = [];
    wsL.history.push({ ts: now, action: 'update', summary: 'Links updated (' + changedKeys.join(', ') + ').' });
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
// (once per weekday, 7:30 AM Eastern) reads the data file, answers each request under its own judgment,
// and sends {target:'data', op:'judgment', id, answer} inbox ops; applyDataPatch_ applies an
// answer through the SAME field logic the live path uses (tsgApplyEstimateToTask_,
// tsgSetProgressFromNotes_, tsgTidyValidate_) and removes the request. The queue is
// server-owned: replace_all and set_meta never write it. Request shapes are documented in
// README "Judgment queue". Nothing here runs when a key IS set: then the live call happens.
// ---------------------------------------------------------------------------------------
var TSG_JUDGMENT_QUEUE_CAP = 80;
// Write amplification (2026-09-18, measured offline on the live file: a 2,074-byte bulk that
// touched five steps grew the document by 36,208 bytes, 17.5x, 89% of it queued requests at
// ~8.4 KB each, of which ~6.8 KB were candidate lists). Every request is slimmed to these caps
// when queued AND on every write, so requests already queued shrink too. The notes as typed are
// never cut: a polished answer replaces them wholesale.
var TSG_JUDGMENT_CAPS = { drive: 6, driveExcerpt: 240, calendar: 10, mail: 4, mailExcerpt: 160 };
function tsgSlimJudgmentRequest_(req) {
  if (!req || typeof req !== 'object') return req;
  var c = TSG_JUDGMENT_CAPS;
  if (Array.isArray(req.driveCandidates)) {
    req.driveCandidates = req.driveCandidates.slice(0, c.drive).map(function(f) {
      if (f && typeof f.excerpt === 'string' && f.excerpt.length > c.driveExcerpt) f.excerpt = f.excerpt.slice(0, c.driveExcerpt);
      return f;
    });
    if (!req.driveCandidates.length) req.driveCandidates = null;
  }
  if (Array.isArray(req.mailCandidates)) {
    req.mailCandidates = req.mailCandidates.slice(0, c.mail).map(function(m) {
      if (m && typeof m.excerpt === 'string' && m.excerpt.length > c.mailExcerpt) m.excerpt = m.excerpt.slice(0, c.mailExcerpt);
      return m;
    });
    if (!req.mailCandidates.length) req.mailCandidates = null;
  }
  if (Array.isArray(req.calendarCandidates)) {
    // Calendar candidates only matter for a Meeting or a task whose type is still open; a step
    // of an unknown type never gets them (the parent was judged already).
    var type = req.current && req.current.taskType;
    var isSub = !!(req.current && req.current.subtask) || req.subIdx != null;
    var wantCal = type === 'Meeting' || (!type && !isSub);
    req.calendarCandidates = wantCal ? req.calendarCandidates.slice(0, c.calendar) : null;
    if (!req.calendarCandidates || !req.calendarCandidates.length) {
      req.calendarCandidates = null;
      if (Array.isArray(req.need)) req.need = req.need.filter(function(f) { return f !== 'meetingMatch'; });
    }
  }
  return req;
}
/** Every pending request slimmed and the queue held to its cap; runs on every write. */
function tsgCompactJudgments_(doc) {
  if (!doc || !doc.meta || !Array.isArray(doc.meta.judgments)) return;
  doc.meta.judgments.forEach(tsgSlimJudgmentRequest_);
  if (doc.meta.judgments.length > TSG_JUDGMENT_QUEUE_CAP) doc.meta.judgments = doc.meta.judgments.slice(-TSG_JUDGMENT_QUEUE_CAP);
}
/**
 * A bulk that touched several steps of one task queued one full enrich request PER STEP (each
 * with its own candidate lists). After the bulk they collapse into ONE steps-only request for
 * that parent (the shape tsgEnrichSteps_ / request_steps already use), or into the parent's own
 * pending request when it has one. Link matching for those steps rides the parent's next pass.
 */
function tsgCoalesceStepRequests_(doc, seqBefore, now, source) {
  if (!doc || !doc.meta || !Array.isArray(doc.meta.judgments)) return 0;
  var byTask = {};
  doc.meta.judgments.forEach(function(r) {
    if (!r || r.kind !== 'enrich' || r.subIdx == null || r.force) return;
    var n = parseInt(String(r.id || '').slice(1), 10);
    if (!(n > seqBefore)) return;
    (byTask[String(r.taskId)] = byTask[String(r.taskId)] || []).push(r);
  });
  var merged = 0;
  Object.keys(byTask).forEach(function(tid) {
    var group = byTask[tid];
    if (group.length < 2) return;
    var task = (doc.tasks || []).filter(function(t) { return String(t.id) === tid; })[0];
    if (!task) return;
    var indices = group.map(function(r) { return r.subIdx; });
    doc.meta.judgments = doc.meta.judgments.filter(function(r) { return group.indexOf(r) === -1; });
    var parentReq = doc.meta.judgments.filter(function(r) { return r && r.kind === 'enrich' && r.subIdx == null && String(r.taskId) === tid; })[0];
    if (parentReq) {
      if (!Array.isArray(parentReq.need)) parentReq.need = [];
      if (parentReq.need.indexOf('steps') === -1) parentReq.need.push('steps');
      var fresh = tsgOpenStepsSnapshot_(task, indices);
      parentReq.currentSteps = (parentReq.currentSteps || []).filter(function(st) { return st && indices.indexOf(st.index) === -1; }).concat(fresh)
        .sort(function(a, b) { return a.index - b.index; });
    } else {
      tsgEnrichSteps_(doc, task, now, source || 'unknown', indices);
    }
    merged += group.length;
    Logger.log('[judgment] ' + group.length + ' per-step requests on task ' + tid + ' collapsed into one steps request');
  });
  return merged;
}
var TSG_CURRENT_DOC = null; // the document applyDataPatch_ is working on, for queueing from deep helpers
function tsgJudgmentMode_() { return !tsgApiKey_(); }
/**
 * Where a comment goes besides meta.comments (2026-09-18, per Durand's header comment "also
 * needs to add the the pinned claude task / and add these to the judgement que"):
 * - every comment by a person (not Claude, not a reply) is queued as a `comment` judgment so
 *   the Routine / Judge-now session sees it next to the enrich requests;
 * - a comment on the PAGE itself (anchor kind element / tile / group, i.e. not on a task or
 *   step) is a feature request or bug report for the tracker, so it also lands as a step on
 *   the pinned Claude task that tracks those (`meta.featureTaskId`, else the pinned task
 *   delegated to Claude whose title mentions the Task Tracker), delegated to Claude and
 *   stamped with the comment id so nothing is added twice.
 */
function tsgFeatureTask_(doc) {
  var tasks = doc.tasks || [];
  var byId = doc.meta && doc.meta.featureTaskId != null ? tasks.filter(function(t) { return t && t.id === doc.meta.featureTaskId; })[0] : null;
  if (byId) return byId;
  return tasks.filter(function(t) {
    return t && t.pinned && t.status !== 'Done' && tsgIsClaudeDelegate_(t) && /task tracker/i.test(String(t.title || '')) && /feature|bug|request/i.test(String(t.title || ''));
  })[0] || null;
}
function tsgRouteNewComment_(doc, entry, now) {
  if (!entry || entry.replyTo) return;
  if (String(entry.author || '').trim().toLowerCase() === 'claude') return;
  var anchor = entry.anchor || {};
  var onItem = (anchor.kind === 'task' || anchor.kind === 'sub') && anchor.id != null;
  var feature = onItem ? null : tsgFeatureTask_(doc);
  if (feature) {
    feature.subitems = Array.isArray(feature.subitems) ? feature.subitems : [];
    var dup = feature.subitems.some(function(s) { return s && s.commentId === entry.id; });
    if (!dup) {
      var firstLine = String(entry.text).split(/\n/)[0].trim();
      var title = firstLine.length > 80 ? firstLine.slice(0, 77).replace(/\s+\S*$/, '') + '…' : firstLine;
      var where = anchor.label ? ('On: ' + anchor.label + (anchor.path ? ' (' + anchor.path + ')' : '')) : '';
      feature.subitems.push({
        title: title, status: 'Not Started', done: false, delegate: 'Claude', taskType: 'Claude', priority: feature.priority || 'Medium',
        notes: String(entry.text) + (where ? '\n\n' + where : '') + '\nComment ' + entry.id + ' by ' + (entry.author || 'Durand') + ' ' + String(entry.ts || now).slice(0, 16),
        commentId: entry.id, tags: [], docs: [],
        history: [{ ts: now, field: 'created', from: null, to: 'from comment ' + entry.id, source: entry.author || 'Durand' }]
      });
      feature.history = feature.history || [];
      feature.history.push({ ts: now, field: 'subitem-added', from: null, to: title, source: entry.author || 'Durand' });
    }
  }
  tsgQueueJudgment_(doc, {
    kind: 'comment', taskId: onItem ? anchor.id : (feature ? feature.id : 0), subIdx: (anchor.kind === 'sub' && anchor.idx != null) ? anchor.idx : null,
    commentId: entry.id, author: entry.author, text: String(entry.text), anchor: anchor,
    featureStep: !!feature
  });
}
function tsgQueueJudgment_(doc, req) {
  if (!doc || !req || req.taskId == null) return null;
  doc.meta = doc.meta || {};
  var q = Array.isArray(doc.meta.judgments) ? doc.meta.judgments : [];
  var sub = (req.subIdx == null) ? null : req.subIdx;
  // One pending request per kind + target: a newer one replaces the older.
  q = q.filter(function(r) {
    if (!r || r.kind !== req.kind) return true;
    if (req.kind === 'comment') return r.commentId !== req.commentId;   // one request per comment
    return !(r.taskId === req.taskId && ((r.subIdx == null) ? null : r.subIdx) === sub);
  });
  doc.meta.judgmentSeq = (doc.meta.judgmentSeq || 0) + 1;
  req.id = 'J' + doc.meta.judgmentSeq;
  req.ts = new Date().toISOString();
  tsgSlimJudgmentRequest_(req);
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
  if (req.kind === 'comment') {
    // Answer {reply?, resolved?}: the reply lands as a Claude comment on the same anchor and
    // the original is resolved when asked. Either field alone is fine.
    var cms = Array.isArray(doc.meta.comments) ? doc.meta.comments : [];
    var orig = cms.filter(function(c) { return c && c.id === req.commentId; })[0];
    if (!orig) { Logger.log('[judgment] ' + req.id + ': comment ' + req.commentId + ' no longer exists'); return; }
    if (String(answer.reply || '').trim()) {
      cms.push({ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ts: now, author: source.replace(/\s*\(.*$/, '') || 'Claude',
        text: String(answer.reply), anchor: orig.anchor, resolved: false, replyTo: orig.id });
    }
    if (answer.resolved === true && !orig.resolved) { orig.resolved = true; orig.resolvedTs = now; orig.resolvedBy = source; }
    doc.meta.comments = cms;
    return;
  }
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

// Every data op this backend accepts (2026-09-18): named in the unknown-op error so a
// session that sends an op the DEPLOYED script does not know yet reads exactly why.
var TSG_DATA_OPS = ['add_task', 'update_task', 'update_subitem', 'add_subitem', 'delete_task', 'bulk', 'set_meta',
  'replace_all', 'add_comment', 'update_comment', 'judgment', 'request_tidy', 'request_steps',
  'log_time', 'retry_filed', 'dismiss_inbox_error', 'remove_dismissed_google_task_ids', 'reorder_subitems'];
/**
 * TASK INDEX (2026-09-22). The data file is too large for an external session's context
 * (685 KB, base64 through the Drive connector), so every applied write also rewrites a
 * small sibling file in the tracker folder: every open task with its id, fields a patch
 * needs and ALL its steps by index (update_subitem needs the index and the exact title),
 * Done tasks as id + title only, plus the value lists and the backend version. Found by
 * name in TRACKER_FOLDER_ID, created once; the id is cached in a script property.
 */
var TSG_INDEX_FILE_NAME = 'Systems — Task Tracker Index — TSG.json';
var TSG_INDEX_PROP = 'TSG_INDEX_FILE_ID';
function tsgIndexDoc_(doc) {
  var meta = (doc && doc.meta) || {};
  var open = [], done = [];
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t) return;
    if (t.status === 'Done' || t.status === 'Cancelled') { done.push({ id: t.id, title: t.title || '', status: t.status }); return; }
    open.push({
      id: t.id, title: t.title || '', status: t.status || '', priority: t.priority || '', group: t.group || '',
      owner: t.owner || '', delegate: tsgTaskDelegate_(t) || '', due: t.timelineEnd || '', dueTime: t.dueTime || '',
      progress: typeof t.progress === 'number' ? t.progress : 0, estHours: typeof t.estHours === 'number' ? t.estHours : null,
      taskType: t.taskType || '', tags: (t.tags || []).slice(), pinned: !!t.pinned, needsApproval: !!t.needsApproval,
      delegateVisible: t.delegateVisible === true, feedbackFor: t.feedbackFor || '',
      fub: tsgIsFubTask_(t) ? { taskId: t.fub.taskId, type: t.fub.type || '', personName: t.fub.personName || '', agent: t.fub.agent || '', readOnly: true } : undefined,
      docs: (t.docs || []).length,
      steps: (t.subitems || []).map(function(s, i) {
        var row = { i: i, title: (s && s.title) || '', status: s && (s.done ? 'Done' : (s.status || '')), delegate: (s && s.delegate) || '', due: (s && s.timelineEnd) || '', estHours: (s && typeof s.estHours === 'number') ? s.estHours : null };
        if (tsgIsFeedbackStep_(s)) row.feedback = { kind: s.feedback.kind || '', by: s.feedback.by || '', decision: s.feedback.decision || '' };
        return row;
      })
    });
  });
  return {
    kind: 'tsg-task-tracker-index', generatedAt: new Date().toISOString(), backendVersion: TSG_CODE_VERSION,
    docVersion: meta.docVersion || null, dataFileId: FILE_IDS.data,
    status_values: meta.status_values || [], priority_values: meta.priority_values || [], taskTypes: TSG_TASK_TYPE_VALUES.slice(),
    groups: Array.from(new Set(open.map(function(t) { return t.group; }).filter(Boolean))).sort(),
    roster: (meta.teamRoster || []).map(function(p) { return typeof p === 'string' ? p : (p && p.name); }).filter(Boolean),
    judgmentsPending: (meta.judgments || []).length, inboxErrors: (meta.inboxErrors || []).length,
    counts: { open: open.length, done: done.length }, tasks: open, doneTasks: done
  };
}
/**
 * INSTRUCTION LAYERS (Durand, 2026-09-22): "the general set of instructions should be a
 * generalized merge of all rules to be applied everywhere; the code instructions should be
 * Claude Code specific rules that sit on top of the general instructions; each thread should
 * push to its own instruction set, a set of thread/project specific instructions that sit on
 * top of the general ones (and code ones for code threads)". Threads are WORKSTREAMS since
 * 2026-09-23. The rulesets file holds the layers: current.General, current.Code,
 * workstreams[name] (with `code: true` on a code workstream).
 * On every rulesets write the tracker mirrors each set to a Google Doc a session can read in
 * one call (the Drive connector returns JSON base64-encoded, Docs as text): one Doc per set,
 * COMPOSED so a session reads one Doc: General; Code = General + Code; a workstream = General
 * (+ Code for a code workstream) + its instructions, memories, links and latest sessions. Docs live in the
 * "Instructions" folder under the tracker folder; ids and content hashes in meta.mirrorDocs
 * (server-owned), so an unchanged set costs nothing and a Doc keeps its id (the pointer a
 * session was given stays valid). The legacy 'Systems — Cowork Instructions' Doc (task 309)
 * is reused as the General mirror.
 */
var TSG_INSTRUCTIONS_FOLDER = 'Instructions';
var TSG_MIRROR_DOC_PREFIX = 'Systems — Instructions — ';
// The General mirror. The Instructions for Claude box links to this exact Doc (2026-09-23), so
// its file id must never change: the Doc is rewritten and renamed in place, never recreated.
var TSG_LEGACY_COWORK_MIRROR_DOC_ID = '1G-QI_F04Ye5SdEIJeOFq_Ex6da1v9oFDED49Ee-1HZM';
function tsgHashText_(text) {
  var h = 5381, str = String(text || '');
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + ':' + str.length;
}
var TSG_MIRROR_HOW_TO = 'MIRROR. Do not edit this Doc. It is rewritten from the TSG Task Tracker Rulesets after every change. To change it: propose the exact text in chat, get Durand\'s approval, push an _Inbox ruleset patch (tsg-task-tracker-protocol skill), then re-read this Doc. Layers: General applies everywhere; Code sits on top for Claude Code sessions; a workstream set sits on top of those for that workstream.';
var TSG_MIRROR_SESSIONS_SHOWN = 10;
function tsgMirrorWhen_(ts) {
  var d = new Date(ts);
  if (!ts || isNaN(d.getTime())) return String(ts || '');
  try {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd') + ' ' + Utilities.formatDate(d, tz, 'HH:mm') + ' ' + tz;
  } catch (e) { return d.toISOString(); }
}
/** The workstream's links and latest sessions as mirror-Doc text (2026-09-23). */
function tsgWorkstreamMirrorExtras_(ws) {
  var links = (ws && ws.links) || {};
  var out = '\n\nLinks:' + ((links.projectUrl || links.repo || links.notes)
    ? (links.projectUrl ? '\n- Claude Project: ' + links.projectUrl : '') + (links.repo ? '\n- Repo: https://github.com/' + links.repo : '') + (links.notes ? '\n- Notes: ' + links.notes : '')
    : ' none recorded');
  var ss = Array.isArray(ws && ws.sessions) ? ws.sessions : [];
  var shown = ss.slice(0, TSG_MIRROR_SESSIONS_SHOWN);
  out += '\n\nSessions (latest ' + shown.length + ' of ' + ss.length + '; ids only, newest first):' + (shown.length
    ? '\n- ' + shown.map(function(x) { return [x.sessionId, x.surface || '?', x.title ? '"' + x.title + '"' : '(untitled)', 'last seen ' + tsgMirrorWhen_(x.lastSeen)].join(' | '); }).join('\n- ')
    : ' none recorded');
  return out;
}
function tsgInstructionSets_(rs) {
  var cur = (rs && rs.current) || {}, wss = (rs && (rs.workstreams || rs.threads)) || {};
  var general = cur.General || { content: '', pushed: '' };
  var code = cur.Code || null;
  var stamp = 'Generated ' + new Date().toISOString() + ' by the TSG Task Tracker from its rulesets (docVersion ' + ((rs.meta && rs.meta.docVersion) || '?') + ').';
  var howTo = TSG_MIRROR_HOW_TO;
  var section = function(title, block) { return '\n\n=== ' + title + (block && block.pushed ? ' (pushed ' + block.pushed + ')' : '') + ' ===\n' + ((block && block.content) || '(empty)'); };
  var sets = [];
  sets.push({ key: 'General', title: TSG_MIRROR_DOC_PREFIX + 'General', text: 'SYSTEMS — INSTRUCTIONS — GENERAL\n' + stamp + '\n' + howTo + section('GENERAL', general) });
  sets.push({ key: 'Code', title: TSG_MIRROR_DOC_PREFIX + 'Code', text: 'SYSTEMS — INSTRUCTIONS — CODE (General + Code)\n' + stamp + '\n' + howTo + section('GENERAL', general) + section('CODE', code) });
  Object.keys(wss).sort().forEach(function(name) {
    var ws = wss[name] || {};
    var id = ws.id || name;   // every workstream has an id after tsgEnsureWorkstreamIds_; the name is the last-resort key
    var text = 'SYSTEMS — INSTRUCTIONS — WORKSTREAM ' + id + ': ' + name + (ws.code ? ' (General + Code + workstream)' : ' (General + workstream)') + '\n' + stamp + '\n' + howTo + section('GENERAL', general);
    if (ws.code) text += section('CODE', code);
    text += section('WORKSTREAM ' + id + ': ' + name, { content: ws.instructions || '' });
    var mems = Array.isArray(ws.memories) ? ws.memories : [];
    text += '\n\nCritical memories (' + mems.length + '):' + (mems.length ? '\n- ' + mems.join('\n- ') : ' none');
    text += tsgWorkstreamMirrorExtras_(ws);
    sets.push({ key: 'workstream:' + id, title: TSG_MIRROR_DOC_PREFIX + 'Workstream — ' + id + ' — ' + name, text: text });
  });
  return sets;
}
function tsgInstructionsFolder_() {
  var parent = DriveApp.getFolderById(TRACKER_FOLDER_ID);
  var it = parent.getFoldersByName(TSG_INSTRUCTIONS_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(TSG_INSTRUCTIONS_FOLDER);
}
function tsgMirrorDocFor_(rs, set) {
  var rec = rs.meta.mirrorDocs[set.key];
  var doc = null;
  if (rec && rec.id) { try { doc = DocumentApp.openById(rec.id); } catch (e0) { doc = null; } }
  if (!doc && set.key === 'General') { try { doc = DocumentApp.openById(TSG_LEGACY_COWORK_MIRROR_DOC_ID); } catch (e1) { doc = null; } }
  if (!doc) {
    var folder = tsgInstructionsFolder_();
    var it = folder.getFilesByName(set.title);
    if (it.hasNext()) { doc = DocumentApp.openById(it.next().getId()); }
    else {
      doc = DocumentApp.create(set.title);
      try { DriveApp.getFileById(doc.getId()).moveTo(folder); } catch (e2) { Logger.log('[mirror] could not move ' + set.title + ' into ' + TSG_INSTRUCTIONS_FOLDER + ': ' + e2); }
    }
  }
  try { if (doc.getName && doc.getName() !== set.title && doc.setName) doc.setName(set.title); } catch (e3) {}
  return doc;
}
function tsgMirrorInstructions_(rs) {
  if (!rs) return 0;
  rs.meta = rs.meta || {};
  if (!rs.meta.mirrorDocs || typeof rs.meta.mirrorDocs !== 'object') rs.meta.mirrorDocs = {};
  tsgEnsureWorkstreamIds_(rs);   // also moves 'thread:<x>' records to 'workstream:<x>'
  // Records keyed by name (before 2026-09-23) move to the id key so the SAME Doc is reused and
  // retitled; nothing is created for a workstream that already has a Doc.
  Object.keys(rs.workstreams || {}).forEach(function(name) {
    var ws = rs.workstreams[name]; if (!ws || !ws.id) return;
    var oldKey = 'workstream:' + name, newKey = 'workstream:' + ws.id;
    if (oldKey !== newKey && rs.meta.mirrorDocs[oldKey] && !rs.meta.mirrorDocs[newKey]) {
      rs.meta.mirrorDocs[newKey] = rs.meta.mirrorDocs[oldKey];
      delete rs.meta.mirrorDocs[oldKey];
    }
  });
  var sets = tsgInstructionSets_(rs), written = 0, live = {};
  sets.forEach(function(set) {
    live[set.key] = true;
    var hash = tsgHashText_(set.text.replace(/^Generated .*$/m, ''));   // the stamp line never forces a rewrite
    var rec = rs.meta.mirrorDocs[set.key];
    if (rec && rec.id && rec.hash === hash) return;
    try {
      var doc = tsgMirrorDocFor_(rs, set);
      var body = doc.getBody();
      body.clear();
      body.setText(set.text);
      doc.saveAndClose && doc.saveAndClose();
      rs.meta.mirrorDocs[set.key] = { id: doc.getId(), url: 'https://docs.google.com/document/d/' + doc.getId() + '/edit', title: set.title, hash: hash, ts: new Date().toISOString() };
      written++;
    } catch (err) {
      Logger.log('[mirror] ' + set.key + ' not written: ' + err);
    }
  });
  // A removed workstream's record goes; its Doc stays in the folder for Durand to trash.
  Object.keys(rs.meta.mirrorDocs).forEach(function(k) { if (!live[k]) delete rs.meta.mirrorDocs[k]; });
  return written;
}
/** Editor-run: mirror every instruction set now (owner only), for the first fire or a repair. */
function tsgMirrorInstructionsNow() {
  tsgAssertOwner_('tsgMirrorInstructionsNow');
  var file = getTrackerFile_('rulesets');
  var rs = JSON.parse(file.getBlob().getDataAsString());
  var n = tsgMirrorInstructions_(rs);
  file.setContent(JSON.stringify(rs));
  Logger.log('[mirror] wrote ' + n + ' doc(s): ' + JSON.stringify(rs.meta.mirrorDocs));
  return rs.meta.mirrorDocs;
}
function tsgIndexFile_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(TSG_INDEX_PROP);
  if (id) { try { var f = DriveApp.getFileById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var folder = DriveApp.getFolderById(TRACKER_FOLDER_ID);
  var it = folder.getFilesByName(TSG_INDEX_FILE_NAME);
  var file = it.hasNext() ? it.next() : folder.createFile(TSG_INDEX_FILE_NAME, '{}', 'application/json');
  props.setProperty(TSG_INDEX_PROP, file.getId());
  return file;
}
function tsgWriteIndex_(doc) {
  var file = tsgIndexFile_();
  file.setContent(JSON.stringify(tsgIndexDoc_(doc)));
  return file.getId();
}
/**
 * NEEDS DURAND (2026-09-22, tracker task: "How are Claude's tasks that need Durand's
 * intervention handed back to him?"). Derived on every write: an open item delegated to
 * Claude whose status is Blocked or Waiting, or whose notes carry "DRAFT — AWAITING
 * APPROVAL" or "NEEDS DURAND", gets the reserved tag `Needs Durand`; a step's flag is
 * mirrored onto its parent so the board row shows it. Cleared on the write where the
 * condition is gone. The dashboard shows a chip, an alert row and the Triage filter.
 */
var TSG_NEEDS_DURAND_TAG = 'Needs Durand';
var TSG_NEEDS_DURAND_RE = /DRAFT\s*[\u2014\u2013-]+\s*AWAITING\s+APPROVAL|NEEDS\s+DURAND/i;
function tsgItemNeedsDurand_(item, delegate) {
  if (!item || item.done || item.status === 'Done' || item.status === 'Cancelled') return false;
  if (String(delegate || '').trim().toLowerCase() !== 'claude') return false;
  return item.status === 'Blocked' || item.status === 'Waiting' || TSG_NEEDS_DURAND_RE.test(String(item.notes || ''));
}
function tsgSetReservedTag_(item, tag, on, historyArr, now, field, note) {
  var tags = Array.isArray(item.tags) ? item.tags : [];
  var had = tags.indexOf(tag) !== -1;
  if (on && !had) { item.tags = tags.concat([tag]); if (historyArr) historyArr.push({ ts: now, field: field, from: null, to: tag, source: 'rollup', note: note }); return true; }
  if (!on && had) { item.tags = tags.filter(function(x) { return x !== tag; }); if (historyArr) historyArr.push({ ts: now, field: field, from: tag, to: null, source: 'rollup' }); return true; }
  return false;
}
function tsgFlagNeedsDurand_(doc, now) {
  var changed = 0;
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t) return;
    var open = t.status !== 'Done' && t.status !== 'Cancelled';
    var any = open && tsgItemNeedsDurand_(t, tsgTaskDelegate_(t));
    (t.subitems || []).forEach(function(s) {
      if (!s) return;
      var need = open && tsgItemNeedsDurand_(s, s.delegate);
      if (tsgSetReservedTag_(s, TSG_NEEDS_DURAND_TAG, need, t.history = t.history || [], now, 'subitem-needs-durand', s.title)) changed++;
      if (need) any = true;
    });
    if (tsgSetReservedTag_(t, TSG_NEEDS_DURAND_TAG, any, t.history = t.history || [], now, 'needs-durand', 'a Claude item is blocked, waiting, or holds a draft awaiting approval')) changed++;
  });
  return changed;
}
// In-place restore of a document from a JSON snapshot: the caller's reference stays valid.
function tsgRestoreDoc_(doc, snapJson) {
  var snap = JSON.parse(snapJson);
  Object.keys(doc).forEach(function(k) { delete doc[k]; });
  Object.keys(snap).forEach(function(k) { doc[k] = snap[k]; });
}
// A dropped or partially applied patch leaves a trace in the data file (2026-09-18, after a
// raffle-session bulk was consumed with nothing recorded): newest last, capped at 30.
// Retry / dismiss a filed patch (2026-09-17, per Durand "why just look at the error message
// instead of running a fix?"). The filed copy stays in _Inbox for TSG_INBOX_KEEP_DAYS, so a
// retry can re-apply exactly the sub-ops that failed (a bulk) or the whole patch (anything
// else) once the cause is gone, e.g. a backend deploy that added the op. Success trashes the
// file and drops the record; a second failure files the retry itself like any patch.
function tsgFindFiledInboxFile_(name) {
  var inbox = DriveApp.getFolderById(INBOX_FOLDER_ID);
  var prefixes = ['PARTIAL-', 'FAILED-', 'MALFORMED-'];
  for (var i = 0; i < prefixes.length; i++) { var it = inbox.getFilesByName(prefixes[i] + name); if (it && it.hasNext()) return it.next(); }
  return null;
}
function tsgBareFiledName_(v) { return String(v || '').replace(/^(PARTIAL|FAILED|MALFORMED)-/, ''); }
function tsgRetryFiled_(doc, patch, now) {
  var name = tsgBareFiledName_(patch.file);
  var f = tsgFindFiledInboxFile_(name);
  if (!f) throw new Error('retry_filed: no filed copy of "' + name + '" in _Inbox (filed copies are trashed after ' + TSG_INBOX_KEEP_DAYS + ' days)');
  var body = JSON.parse(f.getBlob().getDataAsString());
  if (body.target && body.target !== 'data') throw new Error('retry_filed: only data patches can be retried from the dashboard');
  var errs = (doc.meta && doc.meta.inboxErrors) || [];
  var entry = null;
  for (var i = errs.length - 1; i >= 0; i--) { if (errs[i] && errs[i].file === name) { entry = errs[i]; break; } }
  var toApply = body;
  if (body.op === 'bulk' && entry && entry.failedSubOps && entry.failedSubOps.length) {
    toApply = Object.assign({}, body, { ops: entry.failedSubOps.map(function(x) { return (body.ops || [])[x.index]; }).filter(Boolean) });
  }
  applyDataPatch_(doc, Object.assign({}, toApply, { ts: now, source: patch.source || body.source || 'retry' }));
  f.setTrashed(true);
  if (entry) doc.meta.inboxErrors = errs.filter(function(e) { return e !== entry; });
}
function tsgDismissInboxError_(doc, patch) {
  var name = tsgBareFiledName_(patch.file);
  var f = tsgFindFiledInboxFile_(name);
  if (f) f.setTrashed(true);
  if (doc.meta && Array.isArray(doc.meta.inboxErrors)) doc.meta.inboxErrors = doc.meta.inboxErrors.filter(function(e) { return !e || e.file !== name; });
}
function tsgRecordInboxError_(doc, entry) {
  if (!doc) return;
  doc.meta = doc.meta || {};
  doc.meta.inboxErrors = Array.isArray(doc.meta.inboxErrors) ? doc.meta.inboxErrors : [];
  doc.meta.inboxErrors.push(entry);
  if (doc.meta.inboxErrors.length > 30) doc.meta.inboxErrors = doc.meta.inboxErrors.slice(-30);
}
function applyDataPatch_(doc, patch) {
  const now = patch.ts || new Date().toISOString();
  TSG_CURRENT_DOC = doc;
  tsgReadCapacity_(doc);
  // An envelope with `ops` but no `op` can only mean a bulk (2026-09-18); accepting it costs
  // nothing and one less way for a routine-written file to be filed FAILED-.
  if (!patch.op && Array.isArray(patch.ops)) patch.op = 'bulk';
  // FUB pilot (2026-09-24): a FUB-linked task is read-only; only the sync itself ('FUB') writes it.
  if (patch.op !== 'bulk' && patch.source !== 'FUB' && TSG_FUB_LOCKED_OPS.indexOf(patch.op) !== -1 && patch.id != null && tsgFubReadOnly_(doc)) {
    var fubLocked = (doc.tasks || []).filter(function(x) { return x && x.id === patch.id; })[0];
    if (tsgIsFubTask_(fubLocked)) throw new Error(patch.op + ': #' + patch.id + ' is a Follow Up Boss task and read-only while the FUB sync is in its read-only pilot; change it in FUB');
  }
  // Delegate visibility (2026-09-23): an automation write (not the owner, not a person on
  // their page) that changes the meaningful content of a visible task hides it again. Bulk
  // sub-ops are checked one by one through the recursive call; replace_all is the owner's.
  var visBefore = (patch.op !== 'bulk' && patch.op !== 'replace_all' && !tsgIsPersonSource_(patch.source)) ? tsgSnapshotVisibility_(doc) : null;

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
    // Per sub-op (2026-09-18): a sub-op that throws is rolled back on its own (snapshot +
    // in-place restore) and recorded; the others still apply. Before this one unknown
    // sub-op (log_time on a backend without it) took the whole bulk down, and the sub-ops
    // already applied in memory could leak into a write if another patch in the pass
    // succeeded. The error thrown at the end carries `partial` so processInbox_ keeps the
    // applied part and files the rest under PARTIAL-.
    var bulkErrors = [], bulkApplied = 0;
    var judgmentSeqBefore = (doc.meta && doc.meta.judgmentSeq) || 0;
    (patch.ops || []).forEach(function(sub, i) {
      // A bulk envelope's own top-level source (if any) applies to every sub-op unless
      // that sub-op sets its own — Object.assign's key ordering means `sub`'s own
      // `source`, if present, wins over the spread-in default.
      var subPatch = Object.assign({ ts: now, source: patch.source }, sub);
      if (subPatch.op === 'add_task') { subPatch.__batchSiblingTitles = batchTitles; subPatch.__batchContext = batchContext; }
      var snap = JSON.stringify(doc);
      try { applyDataPatch_(doc, subPatch); bulkApplied++; }
      catch (subErr) {
        tsgRestoreDoc_(doc, snap);
        TSG_CURRENT_DOC = doc;
        bulkErrors.push({ index: i, op: subPatch.op, id: (subPatch.id != null ? subPatch.id : undefined), error: String((subErr && subErr.message) || subErr) });
      }
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
    tsgCoalesceStepRequests_(doc, judgmentSeqBefore, now, patch.source);
    doc.meta.last_updated = now;
    if (bulkErrors.length) {
      var bulkErr = new Error('bulk: ' + bulkErrors.length + ' of ' + (patch.ops || []).length + ' sub-op(s) failed: ' +
        bulkErrors.map(function(e) { return '#' + e.index + ' ' + e.op + ': ' + e.error; }).join('; '));
      bulkErr.partial = { applied: bulkApplied, errors: bulkErrors };
      throw bulkErr;
    }
    return;
  }

  if (patch.op === 'add_task') {
    const task = patch.task;
    // Every task lands with the arrays the dashboard reads unguarded (2026-09-21: a task added
    // without `subitems` could never take a subtask from the add box).
    if (!Array.isArray(task.subitems)) task.subitems = [];
    if (!Array.isArray(task.tags)) task.tags = [];
    tsgStripVisibilityFromFields_(task, patch.source);   // only the owner turns a task on for its delegate
    if (task.fub && patch.source !== 'FUB') delete task.fub;   // only the sync links a task to FUB
    if (tsgIsFubTask_(task)) {
      var fubDup = (doc.tasks || []).filter(function(x) { return tsgIsFubTask_(x) && String(x.fub.taskId) === String(task.fub.taskId); })[0];
      if (fubDup) {   // two runs raced: the task is already on the board
        doc.meta.addResults = doc.meta.addResults || [];
        doc.meta.addResults.push({ ts: now, nonce: patch.nonce || null, verdict: 'duplicate-fub', taskId: fubDup.id, title: fubDup.title });
        if (doc.meta.addResults.length > 30) doc.meta.addResults = doc.meta.addResults.slice(-30);
        doc.meta.last_updated = now; doc.meta.docVersion = (doc.meta.docVersion || 0) + 1;
        return;
      }
    }
    // 2026-09-09 per Durand: standardize title formatting on the way in, before dedup
    // matching even runs (tsgClassifyIncoming_ already normalizes case for matching, so
    // this doesn't change match behavior either way). originalTitleForCleanup is only
    // used below, if this turns out to be a genuinely new task, to log what changed.
    var originalTitleForCleanup = task.title;
    if (task.title && !(patch.fubImport && patch.source === 'FUB')) task.title = tsgCleanTitle_(task.title);   // FUB's wording is kept verbatim, or every sync would see a change
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
        taskType: task.taskType || 'Hands-on',
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
      // 'Unsorted' is the free-flow form's placeholder, not a choice (2026-09-22: it was
      // being stamped as hand-set, so the enrich pass could never file the task).
      if (patch.ownerCreated) {
        ['priority', 'group', 'estHours', 'taskType', 'timelineEnd', 'location', 'delegate'].forEach(function(f) {
          if (task[f] == null || task[f] === '') return;
          if (f === 'group' && task[f] === 'Unsorted') return;
          task.history.push({ ts: now, field: f, from: null, to: task[f], source: 'Durand' });
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
          existingTags: board.existingTags, actuals: board.actuals,
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
      if (!patch.personCreated && !patch.ownerCreated && !(patch.fubImport && tsgIsFubTask_(task)) && tsgTaskNeedsDelegateReview_(task)) {
        tsgHoldForReview_(task, task.history, now, 'Held off the delegate views until Durand clears the Triage tag');
      }
      doc.tasks.push(task);
      addResult = { verdict: 'added', taskId: task.id, title: task.title };
      if (patch.personCreated && tsgIsDelegateSource_(patch.source)) {
        tsgRecordDelegateActivity_(doc, { ts: now, person: patch.source, taskId: task.id, subIdx: null, title: task.title || '', kind: 'add', field: null, from: null, to: null });
      }
      if (patch.source === 'FUB' && patch.fubActor) {
        tsgRecordDelegateActivity_(doc, { ts: now, person: patch.fubActor, taskId: task.id, subIdx: null, title: task.title || '', kind: 'add', field: 'in FUB', from: null, to: null });
      }
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
    tsgStripVisibilityFromFields_(patch.fields, patch.source);
    if (patch.fields && patch.source !== 'FUB') delete patch.fields.fub;   // only the sync links a task to FUB
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
    if (tsgIsDelegateSource_(patch.source)) tsgLogDelegateFieldActivity_(doc, patch.source, t, null, t.title, prevTaskSnapshot, t, Object.keys(patch.fields || {}), now);
    if (patch.source === 'FUB' && patch.fubActor) tsgLogDelegateFieldActivity_(doc, patch.fubActor + ' (in FUB)', t, null, t.title, prevTaskSnapshot, t, Object.keys(patch.fields || {}).filter(function(k) { return k !== 'fub' && k !== 'dueOverride' && k !== 'group' && k !== 'progress'; }), now);
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
  } else if (patch.op === 'reorder_subitems') {
    // Reorder a task's steps without resending them (2026-09-18, per Durand "reorder by date"
    // on the SOP task: a full-array update_task carried 31 KB of steps and histories, too big
    // and too easy to corrupt). {id, order: [old indices]} is an explicit permutation;
    // {id, by: 'due'} is a stable sort by timelineEnd (undated steps last). Nothing on the steps
    // changes; the parent logs `subitems-reordered`.
    const rt = doc.tasks.find(function(x) { return x.id === patch.id; });
    if (!rt) throw new Error('reorder_subitems: task id not found: ' + patch.id);
    const rsubs = Array.isArray(rt.subitems) ? rt.subitems : [];
    let order;
    if (patch.by === 'due') {
      order = rsubs.map(function(s, i) { return i; }).sort(function(a, b) {
        const da = rsubs[a].timelineEnd || '9999-12-31', db = rsubs[b].timelineEnd || '9999-12-31';
        return da < db ? -1 : da > db ? 1 : a - b;
      });
    } else {
      order = Array.isArray(patch.order) ? patch.order.map(Number) : null;
      const okPerm = order && order.length === rsubs.length && order.slice().sort(function(a, b) { return a - b; }).every(function(v, i) { return v === i; });
      if (!okPerm) throw new Error('reorder_subitems: order must be a permutation of 0..' + (rsubs.length - 1) + ' (or pass by: "due")');
    }
    const before = rsubs.map(function(s) { return s.title; });
    rt.subitems = order.map(function(i) { return rsubs[i]; });
    if (order.some(function(v, i) { return v !== i; })) {
      rt.history = rt.history || [];
      rt.history.push({ ts: now, field: 'subitems-reordered', from: before.join(' | ').slice(0, 300), to: (patch.by === 'due' ? 'by due date' : 'order ' + order.join(',')), source: patch.source || 'unknown' });
    }
  } else if (patch.op === 'update_subitem') {
    // One subitem by parent id + index (subitems have no ids). expectTitle guards against
    // the index having shifted under a concurrent reorder: mismatch -> rejected, not misapplied.
    const pt = doc.tasks.find(function(x) { return x.id === patch.id; });
    if (!pt) throw new Error('update_subitem: task id not found: ' + patch.id);
    const subs = Array.isArray(pt.subitems) ? pt.subitems : [];
    // The key is `index`; `subIdx` (the key log_time and the judgment queue use) is accepted
    // too, because the protocol skill documented it that way and a session writing to the docs
    // threw "no subitem at index undefined" and was filed FAILED- (found 2026-09-18).
    if (patch.index == null && typeof patch.subIdx === 'number') patch.index = patch.subIdx;
    if (typeof patch.index !== 'number') throw new Error('update_subitem: missing index (a number; `subIdx` is accepted as an alias) on task ' + patch.id);
    const sub = subs[patch.index];
    if (!sub) throw new Error('update_subitem: no subitem at index ' + patch.index + ' on task ' + patch.id);
    if (patch.expectTitle != null && String(sub.title || '') !== String(patch.expectTitle)) {
      throw new Error('update_subitem: subitem at index ' + patch.index + ' is not "' + patch.expectTitle + '" any more (stale)');
    }
    const prevSubs = subs.map(function(x) { return Object.assign({}, x); });
    const f = Object.assign({}, patch.fields || {});
    delete f.history;
    if (Object.prototype.hasOwnProperty.call(f, 'status')) { f.done = (f.status === 'Done'); if (f.done || f.status === TSG_PENDING_STATUS) f.progress = 100; }
    else if (Object.prototype.hasOwnProperty.call(f, 'done')) { f.status = f.done ? 'Done' : (sub.status === 'Done' ? 'In Progress' : (sub.status || 'Not Started')); if (f.done) f.progress = 100; }
    Object.assign(sub, f);
    var subNotesChanged = tsgNotesChanged_(sub, prevSubs[patch.index].notes);
    tsgStampSubitemTouchesForTask_(prevSubs, subs, now, patch.source);
    if (tsgIsDelegateSource_(patch.source)) tsgLogDelegateFieldActivity_(doc, patch.source, pt, patch.index, sub.title, prevSubs[patch.index], sub, Object.keys(f), now);
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
    var isFeedbackStep = tsgIsFeedbackStep_(patch.subitem);
    if (!patch.skipEnrich && !isFeedbackStep) tsgEnrichItem_(doc, t, patch.subitem, t.subitems.length - 1, now, patch.source || 'unknown', { allowEmptyNotes: true });
    if (tsgIsDelegatePerson_(patch.subitem.delegate) && !isFeedbackStep && !tsgIsDelegateSource_(patch.source)) {
      t.history = t.history || [];
      tsgHoldForReview_(patch.subitem, t.history, now, 'Subitem "' + patch.subitem.title + '" held off ' + patch.subitem.delegate + "'s view until reviewed");
    }
    if (tsgIsDelegateSource_(patch.source)) {
      t.history = t.history || [];
      t.history.push({ ts: now, field: isFeedbackStep ? 'feedback-filed' : 'subitem-added', from: null, to: patch.subitem.title, source: patch.source });
      tsgRecordDelegateActivity_(doc, { ts: now, person: patch.source, taskId: t.id, subIdx: t.subitems.length - 1, title: patch.subitem.title || '',
        kind: isFeedbackStep ? 'feedback' : 'update', field: isFeedbackStep ? (patch.subitem.feedback.kind || 'Feedback') : 'step added', from: null, to: isFeedbackStep ? String(patch.subitem.notes || '').slice(0, 240) : null });
    }
  } else if (patch.op === 'set_meta') {
    // Generic, reusable merge into doc.meta — unlike remove_dismissed_google_task_ids
    // above (one-time, parameter-free), this is meant for any future top-level meta
    // field a caller needs to set wholesale. First user: doc.meta.standingItems, the
    // recurring Ops Manual duties (SOP-sourced, dated by cadence) that feed the Today
    // view's Admin checklist client-side — see dashboard_final.html's buildStandingItemChecks.
    var metaFields = Object.assign({}, patch.fields || {});
    // comments is server-owned too (2026-09-16): use add_comment / update_comment so two
    // writers (the dashboard, a Claude session) never overwrite each other's threads.
    ['next_id', 'docVersion', 'rejectedSaves', 'addResults', 'lastLiveHeartbeat', 'comments', 'judgments', 'judgmentSeq', 'tidyProposals', 'inboxErrors', 'backendVersion', 'historyArchive', 'noteVersions', 'featureTaskId', 'last_updated', 'version', 'created', 'delegateActivity'].forEach(function(k) { delete metaFields[k]; });  // server-owned
    Object.assign(doc.meta, metaFields);
    if (Object.prototype.hasOwnProperty.call(metaFields, 'homeBase')) {
      try { PropertiesService.getScriptProperties().setProperty('TSG_HOME_BASE', String(metaFields.homeBase || '')); } catch (err) {}
    }
    if (Object.prototype.hasOwnProperty.call(metaFields, 'fubSync')) {
      // Sanitised, then mirrored to a script property so the minute tick reads it without Drive.
      doc.meta.fubSync = tsgFubConfig_(doc.meta);
      try { PropertiesService.getScriptProperties().setProperty(TSG_FUB_CONFIG_PROP, JSON.stringify(doc.meta.fubSync)); } catch (err) {}
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
  } else if (patch.op === 'log_time') {
    tsgLogTime_(doc, patch, now);
  } else if (patch.op === 'retry_filed') {
    tsgRetryFiled_(doc, patch, now);
  } else if (patch.op === 'dismiss_inbox_error') {
    tsgDismissInboxError_(doc, patch);
  } else if (patch.op === 'request_tidy') {
    // The Tidy button (2026-09-16, per Durand: "the tidy should now just be automatic"): a
    // full re-run of the enrichment on one task, applied when the answer lands, no review
    // step. force: even fields Durand set by hand are re-judged this once.
    var tidyTask = (doc.tasks || []).filter(function(x) { return x && x.id === patch.id; })[0];
    if (!tidyTask) throw new Error('request_tidy: no task ' + patch.id);
    tsgEnrichTask_(doc, tidyTask, now, patch.source || 'Durand', { force: true });
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
    tsgRouteNewComment_(doc, entry, now);
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
    if (patch.remove || (patch.fields && patch.fields.resolved === true)) {
      // A resolved or removed comment has nothing left to judge.
      doc.meta.judgments = (doc.meta.judgments || []).filter(function(r) { return !(r && r.kind === 'comment' && r.commentId === patch.id); });
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
    // retry that has never existed; since 2026-09-18 the dashboard DOES replay the edit
    // onto the fresh document, see replayAfterConflict_): the dashboard's save surfaces a
    // conflict and re-applies the local diff; the user only has to redo it if two replays fail
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
    let nextTasks = incoming.tasks || doc.tasks;
    // FUB pilot (2026-09-24): a whole-document save can neither edit, delete nor forge a FUB task;
    // the server copy stands (the dashboard also reverts locally before saving).
    if (tsgFubReadOnly_(doc)) {
      var fubPrev = {};
      (doc.tasks || []).forEach(function(x) { if (tsgIsFubTask_(x)) fubPrev[x.id] = x; });
      var fubKept = {};
      nextTasks = (nextTasks || []).map(function(x) {
        if (x && fubPrev[x.id]) { fubKept[x.id] = true; return JSON.parse(JSON.stringify(fubPrev[x.id])); }
        if (x && x.fub) { var c = Object.assign({}, x); delete c.fub; return c; }
        return x;
      });
      Object.keys(fubPrev).forEach(function(k) { if (!fubKept[k]) nextTasks.push(JSON.parse(JSON.stringify(fubPrev[k]))); });
    }
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
    throw new Error('Unknown data patch op: ' + patch.op + ' (backend ' + TSG_CODE_VERSION + ' accepts: ' + TSG_DATA_OPS.join(', ') + ')');
  }
  if (visBefore) tsgResetVisibilityOnChange_(doc, visBefore, now, patch.source);
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
  // FUB task sync (2026-09-24): a property read each minute; a run only when the cadence is due.
  try { tsgFubSyncTickIfDue_(); } catch (fubErr) { Logger.log('[fub] sync tick failed: ' + fubErr.message); }
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
  if (item.done || item.status === 'Done' || tsgIsPendingStatus_(item)) return false;
  return !!tsgReminderDate_(item.remindAt);
}
// Extra reminders (2026-09-21, tracker task "allow setting multiple and recurring reminders"):
// `extraReminders: [{at: 'YYYY-MM-DDTHH:mm', repeat: ''|'daily'|'weekdays'|'weekly'|'monthly',
// sentAt?}]` on tasks and steps, beside the single preset-driven `remindAt`. A one-shot entry is
// spent once `sentAt` is stamped; a repeating one is re-armed by advancing `at` past now.
function tsgNextRepeat_(atStr, repeat) {
  var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(atStr || ''));
  if (!m) return '';
  var date = m[1], hm = m[2];
  if (repeat === 'daily') date = tsgAddDays_(date, 1);
  else if (repeat === 'weekly') date = tsgAddDays_(date, 7);
  else if (repeat === 'weekdays') { date = tsgAddDays_(date, 1); var g = 0; while (!tsgIsWorkdayIso_(date) && g++ < 7) date = tsgAddDays_(date, 1); }
  else if (repeat === 'monthly') {
    var d = tsgParseIsoDate_(date); if (!d) return '';
    var day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last)); date = tsgIsoDate_(d);
  } else return '';
  return date + 'T' + hm;
}
/** The first occurrence of a repeating reminder after `now` (a reminder years overdue jumps, never loops). */
function tsgReArmRepeat_(atStr, repeat, now) {
  var at = tsgReminderDate_(atStr); if (!at) return '';
  if (at > now) return atStr;
  var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(atStr)), hm = m[2];
  var DAY = 86400000;
  if (repeat === 'daily' || repeat === 'weekdays' || repeat === 'weekly') {
    var period = repeat === 'weekly' ? 7 * DAY : DAY;
    var n = Math.floor((now - at) / period) + 1;
    var d = new Date(at.getTime() + n * period);
    var iso = tsgIsoDate_(d) + 'T' + hm;
    if (repeat === 'weekdays') { var date = iso.slice(0, 10), g = 0; while (!tsgIsWorkdayIso_(date) && g++ < 7) date = tsgAddDays_(date, 1); iso = date + 'T' + hm; }
    return iso;
  }
  if (repeat === 'monthly') { var cur = atStr, g2 = 0; while (cur && tsgReminderDate_(cur) <= now && g2++ < 1200) cur = tsgNextRepeat_(cur, 'monthly'); return cur; }
  return '';
}
function tsgExtraReminderPending_(item, r) {
  if (!item || !r || item.done || item.status === 'Done') return false;
  var at = tsgReminderDate_(r.at); if (!at) return false;
  if (!r.sentAt) return true;
  return !!r.repeat && new Date(r.sentAt) < at;
}
function tsgPendingReminders_(doc) {
  var out = [];
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t) return;
    var consider = function(item, subIdx) {
      var base = 't' + t.id + (subIdx == null ? '' : 's' + subIdx);
      if (tsgReminderPending_(item)) out.push({ key: base, task: t, item: item, subIdx: subIdx, at: tsgReminderDate_(item.remindAt) });
      (Array.isArray(item.extraReminders) ? item.extraReminders : []).forEach(function(r, x) {
        if (tsgExtraReminderPending_(item, r)) out.push({ key: base + 'x' + x, task: t, item: item, subIdx: subIdx, at: tsgReminderDate_(r.at), extraIdx: x, repeat: r.repeat || '' });
      });
    };
    consider(t, null);
    (t.subitems || []).forEach(function(s, i) { consider(s, i); });
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
  var ops = [], extraTouched = {};
  // Email only for Critical work by default (Durand 2026-09-22: "I only want emails on
  // critical tasks"); meta.reminderEmails = 'all' restores every reminder. Every reminder
  // is still stamped sent, so the dashboard's notification/toast fires for all of them.
  var mailMode = (doc.meta && doc.meta.reminderEmails) || 'critical';
  due.forEach(function(r) {
    var subject = 'Reminder' + (r.repeat ? ' (' + r.repeat + ')' : '') + ': ' + r.item.title + (r.item.timelineEnd ? ' — due ' + r.item.timelineEnd + (r.item.dueTime ? ' ' + r.item.dueTime : '') : '');
    if (mailMode === 'all' || tsgReminderIsCritical_(r)) {
      try { MailApp.sendEmail(OWNER_EMAIL, subject, tsgReminderBody_(r)); }
      catch (mailErr) { Logger.log('[reminders] send failed for ' + r.key + ': ' + mailErr.message); return; }
    }
    tsgCachePut_('reminderFired:' + r.key, '1', 900);
    var sentAt = now.toISOString();
    if (r.extraIdx != null) {
      // Stamp in memory; one op per item carries the whole list after the loop, so several
      // extras firing together never overwrite each other.
      var entry = r.item.extraReminders[r.extraIdx];
      entry.sentAt = sentAt;
      if (entry.repeat) { var nxt = tsgReArmRepeat_(entry.at, entry.repeat, now); if (nxt) entry.at = nxt; }
      var ik = 't' + r.task.id + (r.subIdx == null ? '' : 's' + r.subIdx);
      extraTouched[ik] = r;
      return;
    }
    if (r.subIdx == null) ops.push({ op: 'update_task', id: r.task.id, fields: { reminderSentAt: sentAt } });
    else ops.push({ op: 'update_subitem', id: r.task.id, index: r.subIdx, expectTitle: r.item.title, fields: { reminderSentAt: sentAt } });
  });
  Object.keys(extraTouched).forEach(function(ik) {
    var r = extraTouched[ik];
    if (r.subIdx == null) ops.push({ op: 'update_task', id: r.task.id, fields: { extraReminders: r.item.extraReminders } });
    else ops.push({ op: 'update_subitem', id: r.task.id, index: r.subIdx, expectTitle: r.item.title, fields: { extraReminders: r.item.extraReminders } });
  });
  if (ops.length) tsgQueueDataPatch_({ op: 'bulk', source: 'Reminder', ops: ops });
  // Point the property at the next reminder still in the future; the queued patch's write
  // re-indexes properly once it lands.
  var later = tsgPendingReminders_(doc).filter(function(r) { return r.at > now; });   // re-read: repeating extras were re-armed above
  try { PropertiesService.getScriptProperties().setProperty(TSG_REMINDER_PROP, later.length ? later[0].at.toISOString() : ''); } catch (err) {}
  return { ok: true, fired: ops.length, next: later.length ? later[0].at.toISOString() : '' };
}
function tsgReminderIsCritical_(r) {
  return (r.item && r.item.priority === 'Critical') || (r.task && r.task.priority === 'Critical');
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
  if (subs.every(function(s) { return s.done || tsgIsPendingStatus_(s); })) return TSG_PENDING_STATUS;
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
    // Visibility gate (2026-09-23): a task the person does not own reaches their page only
    // while the owner has turned delegateVisible on (default off; automation turns it off).
    if (!isOwn && !tsgVisibleToDelegates_(t)) return;
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
      fub: tsgIsFubTask_(t) ? { type: t.fub.type || '', personName: t.fub.personName || '', personUrl: t.fub.personUrl || '', updated: t.fub.updated || '', readOnly: tsgFubReadOnly_(doc), fields: TSG_FUB_SOURCED_FIELDS.slice() } : null,
      pinned: !!t.pinned, feedbackFor: t.feedbackFor || '', docs: context ? [] : (t.docs || []).map(function(d) { return d ? { url: d.url || '', label: d.label || d.name || d.url || '', type: d.type || 'link' } : null; }).filter(Boolean),
      tags: context ? [] : (t.tags || []).slice(), taskType: context ? '' : (t.taskType || ''),
      estHours: (!context && typeof t.estHours === 'number') ? t.estHours : null,
      subTotal: context ? mineSubs.length : subs.length,
      subDone: context ? mineDone : subs.filter(function(s) { return s && s.done; }).length,
      editable: (tsgIsFubTask_(t) && tsgFubReadOnly_(doc)) ? [] : (isOwn ? TSG_PERSON_TASK_FIELDS_OWN.slice() : (isAssigned ? TSG_PERSON_TASK_FIELDS_DELEGATED.slice() : []))
    });
    mine.forEach(function(m) {
      var s = m.s;
      rows.push({
        kind: 'sub', id: t.id, index: m.i, own: false, parentOwn: isOwn, parentTitle: t.title || '', title: s.title || '',
        status: s.done ? 'Done' : (s.status || 'Not Started'), priority: s.priority || t.priority || '',
        progress: s.done ? 100 : (typeof s.progress === 'number' ? s.progress : 0), done: !!s.done,
        due: s.timelineEnd || '', notes: s.notes || '', group: t.group || '', owner: t.owner || '', subTotal: 0,
        feedback: tsgIsFeedbackStep_(s) ? { kind: s.feedback.kind || 'Feedback', decision: s.feedback.decision || '', decidedAt: s.feedback.decidedAt || '', implementedAt: s.feedback.implementedAt || '' } : null,
        editable: tsgIsFeedbackStep_(s) ? ['notes'] : TSG_PERSON_SUB_FIELDS.slice()
      });
    });
  });
  return rows;
}

/**
 * ============================================================================
 * DELEGATE VISIBILITY, PENDING APPROVAL, ACTIVITY LOG, FEEDBACK (2026-09-23, per Durand)
 *
 * - `delegateVisible` (task field, default off): a task with a delegate reaches that
 *   person's page ONLY while this is true. Only the owner can turn it on (a patch that says
 *   true from any other source is stripped); any MEANINGFUL change by automation (a Claude
 *   answer, a session patch: title, notes, due, priority, delegate, steps, links, hours,
 *   location, type) turns it off again so nothing half-edited is seen before Durand looks.
 *   A person's own edits never turn it off; the owner's dashboard edits never do either.
 *   A task the person owns (self-created) is always theirs to see.
 * - Delegates can close nothing themselves: a Done or Cancelled from the person page lands
 *   as `Done - Pending` (TSG_PENDING_STATUS). Only the owner moves it to Done, after
 *   verifying the work product (dashboard Approve), or sends it back. Pending items are
 *   out of the scheduler, out of the reminder tick and out of the open-hours roll-up.
 * - `meta.delegateActivity[]` (server-owned) records every change a delegate makes: field
 *   edits, status moves to pending, tasks they add, feedback they file. The dashboard
 *   raises an alert row and toasts from it; `meta.delegateActivitySeen` is the owner's
 *   read marker; `meta.delegateEmails === 'on'` also mails each entry (default off).
 * - Feedback: one pinned collection task per delegate (`feedbackFor: <Name>`); the person
 *   page files an item as a step on it ({feedback: {kind, by, ts}}, delegate = the person
 *   so it shows on their page, never enriched, never held for review). Durand implements
 *   (a Claude step on the tracker feature task, linked by `feedbackRef`) or declines; a
 *   linked step going Done marks the feedback item Done (tsgSyncFeedbackImplementations_).
 * ---------------------------------------------------------------------------
 */
var TSG_OWNER_NAME = 'Durand';
var TSG_PENDING_STATUS = 'Done - Pending';
var TSG_PERSON_STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Waiting', TSG_PENDING_STATUS];
var TSG_DELEGATE_ACTIVITY_CAP = 200;
var TSG_FEEDBACK_KINDS = ['Bug', 'Feature request', 'Feedback'];
var TSG_FEEDBACK_TITLE_CHARS = 90;

function tsgIsOwnerSource_(source) { return String(source || '').trim().toLowerCase() === TSG_OWNER_NAME.toLowerCase(); }
/** A named person who is not the owner: a delegate writing from their own page. */
function tsgIsDelegateSource_(source) { return tsgIsPersonSource_(source) && !tsgIsOwnerSource_(source); }
function tsgIsPendingStatus_(item) { return !!item && item.status === TSG_PENDING_STATUS; }
function tsgVisibleToDelegates_(t) { return !!t && t.delegateVisible === true; }

/** The fields whose change is "meaningful" to the person reading the task. Status, progress, tags, schedule and travel bookkeeping are not. */
function tsgVisibilityHash_(t) {
  if (!t) return '';
  var steps = (t.subitems || []).map(function(s) {
    return s ? [s.title || '', s.notes || '', s.delegate || '', s.estHours == null ? '' : s.estHours, s.timelineEnd || '', s.location || '', (s.docs || []).map(function(d) { return d && d.url; }).join('|')].join('\u0001') : '';
  }).join('\u0002');
  return [t.title || '', t.notes || '', t.priority || '', t.taskType || '', t.estHours == null ? '' : t.estHours, tsgTaskDelegate_(t), t.location || '',
    t.timelineEnd || '', t.dueTime || '', (t.docs || []).map(function(d) { return d && d.url; }).join('|'), steps].join('\u0003');
}
function tsgSnapshotVisibility_(doc) {
  var out = {};
  (doc && doc.tasks || []).forEach(function(t) { if (t && tsgVisibleToDelegates_(t)) out[t.id] = tsgVisibilityHash_(t); });
  return out;
}
/** After an automation write: every visible task whose meaningful content moved is hidden again, with a history line saying why. */
function tsgResetVisibilityOnChange_(doc, before, now, source) {
  var reset = 0;
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t || !tsgVisibleToDelegates_(t) || !Object.prototype.hasOwnProperty.call(before, t.id)) return;
    if (before[t.id] === tsgVisibilityHash_(t)) return;
    t.delegateVisible = false; reset++;
    t.history = t.history || [];
    t.history.push({ ts: now, field: 'delegateVisible', from: 'true', to: 'false', source: source || 'unknown', note: 'hidden from the delegate again: the task changed by automation; review and turn it back on' });
  });
  return reset;
}
/** Only the owner turns visibility on. Anyone else asking for true is ignored (false is always accepted). */
function tsgStripVisibilityFromFields_(fields, source) {
  if (!fields || !Object.prototype.hasOwnProperty.call(fields, 'delegateVisible')) return false;
  if (fields.delegateVisible === true && !tsgIsOwnerSource_(source)) { delete fields.delegateVisible; return true; }
  fields.delegateVisible = fields.delegateVisible === true;
  return false;
}

function tsgFeedbackTaskFor_(doc, name) {
  var want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return (doc && doc.tasks || []).filter(function(t) {
    return t && t.status !== 'Done' && t.status !== 'Cancelled' && String(t.feedbackFor || '').trim().toLowerCase() === want;
  })[0] || null;
}
function tsgIsFeedbackStep_(s) { return !!(s && s.feedback && typeof s.feedback === 'object'); }

function tsgRecordDelegateActivity_(doc, entry) {
  if (!doc || !entry) return;
  if (!doc.meta) doc.meta = {};
  var list = Array.isArray(doc.meta.delegateActivity) ? doc.meta.delegateActivity : [];
  list.push(entry);
  if (list.length > TSG_DELEGATE_ACTIVITY_CAP) list = list.slice(-TSG_DELEGATE_ACTIVITY_CAP);
  doc.meta.delegateActivity = list;
  if (doc.meta.delegateEmails === 'on') {
    try {
      MailApp.sendEmail(OWNER_EMAIL, 'Tracker: ' + entry.person + ' ' + tsgActivityVerb_(entry) + ' "' + (entry.title || '') + '"',
        entry.person + ' ' + tsgActivityVerb_(entry) + ' #' + entry.taskId + (entry.subIdx != null ? ' step ' + entry.subIdx : '') + ' "' + (entry.title || '') + '"' +
        (entry.field ? '\n' + entry.field + ': ' + String(entry.from == null ? '—' : entry.from).slice(0, 300) + ' -> ' + String(entry.to == null ? '—' : entry.to).slice(0, 300) : '') + '\n\nOpen the tracker to review.');
    } catch (mailErr) { Logger.log('[delegate-activity] mail failed: ' + mailErr.message); }
  }
}
function tsgActivityVerb_(e) {
  if (!e) return '';
  if (e.kind === 'add') return 'added a task';
  if (e.kind === 'feedback') return 'filed ' + String(e.field || 'feedback').toLowerCase();
  if (e.kind === 'pending') return 'marked done (awaiting your approval)';
  return 'changed ' + (e.field || 'a field') + ' on';
}
/** One activity entry per changed field of a delegate's write (the cut values keep the log small). */
function tsgLogDelegateFieldActivity_(doc, person, task, subIdx, title, before, after, keys, now) {
  (keys || []).forEach(function(k) {
    if (k === 'history' || k === 'id') return;
    if (tsgValuesEqual_(before[k], after[k])) return;
    var cut = function(v) { if (v == null || v === '') return null; v = typeof v === 'string' ? v : JSON.stringify(v); return v.length > 240 ? v.slice(0, 240) + '…' : v; };
    tsgRecordDelegateActivity_(doc, { ts: now, person: person, taskId: task.id, subIdx: subIdx == null ? null : subIdx, title: title || '',
      kind: (k === 'status' && after[k] === TSG_PENDING_STATUS) ? 'pending' : 'update', field: k === 'timelineEnd' ? 'due' : k, from: cut(before[k]), to: cut(after[k]) });
  });
}
/**
 * A feedback item Durand accepted is linked (feedbackRef on the Claude step) to the tracker
 * feature task; when that step is Done the feedback item closes itself with a note. Runs on
 * every write.
 */
function tsgSyncFeedbackImplementations_(doc, now) {
  var closed = 0;
  var tasks = doc && doc.tasks || [];
  var implSteps = [];
  tasks.forEach(function(t) { (t && t.subitems || []).forEach(function(s) { if (s && s.feedbackRef && (s.done || s.status === 'Done')) implSteps.push({ ref: s.feedbackRef, step: s, task: t }); }); });
  if (!implSteps.length) return 0;
  tasks.forEach(function(t) {
    if (!t || !t.feedbackFor) return;
    (t.subitems || []).forEach(function(s, i) {
      if (!tsgIsFeedbackStep_(s) || s.done || s.status === 'Done' || s.feedback.decision !== 'accepted') return;
      var hit = implSteps.filter(function(x) { return x.ref && x.ref.taskId === t.id && (x.ref.index === i || (x.ref.title && x.ref.title === s.title)); })[0];
      if (!hit) return;
      s.done = true; s.status = 'Done'; s.progress = 100; s.feedback.implementedAt = now;
      s.notes = 'IMPLEMENTED ' + String(now).slice(0, 10) + ': shipped as "' + (hit.step.title || '') + '" on #' + hit.task.id + '.\n\n' + String(s.notes || '');
      s.history = Array.isArray(s.history) ? s.history : [];
      s.history.push({ ts: now, field: 'status', from: TSG_PENDING_STATUS === s.status ? TSG_PENDING_STATUS : 'In Progress', to: 'Done', source: 'rollup', note: 'implementation step done on #' + hit.task.id });
      t.history = t.history || [];
      t.history.push({ ts: now, field: 'subitem-status', from: s.title, to: 'Done (implemented on #' + hit.task.id + ')', source: 'rollup' });
      closed++;
    });
  });
  return closed;
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
      // A delegate can never pick Done: the list ends at Done - Pending; Durand approves.
      statuses: TSG_PERSON_STATUSES.slice(), pendingStatus: TSG_PENDING_STATUS,
      priorities: (doc.meta && doc.meta.priority_values) || TSG_PRIORITY_VALUES,
      feedbackTaskId: (function() { var ft = tsgFeedbackTaskFor_(doc, name); return ft ? ft.id : null; })(),
      feedbackKinds: TSG_FEEDBACK_KINDS.slice(),
      fubKey: tsgFubKeyInfo_(doc, name),
      fubSync: (function() {
        var cfg = tsgFubConfig_(doc.meta || {});
        if (cfg.agents.indexOf(name) === -1 || !tsgFubKeyFor_(name)) return { enabled: false };
        var st = (tsgFubState_().agents || {})[name] || {};
        return { enabled: true, readOnly: tsgFubReadOnly_(doc), lastRunAt: st.lastRunAt || '', ok: st.ok !== false, error: st.ok === false ? String(st.error || '').slice(0, 160) : '', cadenceMin: cfg.cadenceMin };
      })(),
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
      if (key === 'status') {
        // Done / Cancelled from a delegate lands as pending; the owner (previewing) may still close.
        if ((v === 'Done' || v === 'Cancelled') && actor === name) v = TSG_PENDING_STATUS;
        var allowed = TSG_PERSON_STATUSES.concat(actor === name ? [] : ['Done', 'Cancelled']);
        if (allowed.indexOf(v) === -1) { rejected.push(k); return; }
      }
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
    if (row.kind === 'task' && (fields.status === 'Done' || fields.status === TSG_PENDING_STATUS)) op.fields.progress = 100;
    return JSON.stringify(tsgQueueDataPatch_(op));
  }
  if (action === 'feedback') {
    // Bug report / feature request / feedback, filed as a step on the person's own pinned
    // feedback task (feedbackFor = name). Never enriched, never held for review; the step is
    // delegated to the person so it stays on their page with its decision.
    var ft = tsgFeedbackTaskFor_(doc, name);
    if (!ft) return JSON.stringify({ ok: false, error: 'no feedback task for ' + name + ' yet; ask Durand' });
    var text = String(payload.text || '').replace(/\r/g, '').trim();
    if (!text) return JSON.stringify({ ok: false, error: 'text required' });
    var kind = TSG_FEEDBACK_KINDS.indexOf(payload.kind) !== -1 ? payload.kind : 'Feedback';
    var firstLine = text.split('\n')[0].trim();
    var fbTitle = '[' + kind + '] ' + (firstLine.length > TSG_FEEDBACK_TITLE_CHARS ? firstLine.slice(0, TSG_FEEDBACK_TITLE_CHARS - 1) + '…' : firstLine);
    var fbNow = new Date().toISOString();
    var sub = { title: fbTitle, notes: text, delegate: name, status: 'Not Started', done: false, progress: 0, priority: ft.priority || 'Medium',
      taskType: 'Hands-on', tags: [], docs: [], estHours: null, feedback: { kind: kind, by: name, ts: fbNow },
      history: [{ ts: fbNow, field: 'created', from: null, to: null, source: actor }] };
    return JSON.stringify(tsgQueueDataPatch_({ op: 'add_subitem', id: ft.id, subitem: sub, source: actor, skipEnrich: true, feedback: true }));
  }
  if (action === 'add') {
    var title = String(payload.title || '').trim();
    if (!title) return JSON.stringify({ ok: false, error: 'title required' });
    var prios = (doc.meta && doc.meta.priority_values) || TSG_PRIORITY_VALUES;
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
  if (action === 'fubKeySet') {
    if (tsgCacheGet_('fubKeyCool:' + name)) return JSON.stringify({ ok: false, error: 'Wait a few seconds before trying again.' });
    tsgCachePut_('fubKeyCool:' + name, '1', TSG_FUB_KEY_SET_COOLDOWN_SEC);
    return JSON.stringify(tsgFubSetKey_(name, payload.key, actor));
  }
  if (action === 'fubKeyRemove') {
    return JSON.stringify(tsgFubRemoveKey_(name, actor));
  }
  if (action === 'fubSync') {
    // The agent's own "Sync now" (2026-09-24): their FUB tasks only, one run every 2 minutes.
    var fcfg = tsgFubConfig_(doc.meta || {});
    if (fcfg.agents.indexOf(name) === -1 || !tsgFubKeyFor_(name)) return JSON.stringify({ ok: false, error: 'FUB sync is not set up for ' + name });
    var coolKey = 'fubSyncCool:' + name;
    if (tsgCacheGet_(coolKey)) return JSON.stringify({ ok: false, error: 'synced in the last 2 minutes; try again shortly' });
    tsgCachePut_(coolKey, '1', TSG_FUB_SYNC_NOW_COOLDOWN_SEC);
    var run = tsgFubRunSync_({ agents: [name], reason: 'sync-now:' + actor });
    return JSON.stringify({ ok: true, result: run.agents[name] || null, wrote: run.wrote, busy: !!run.busy });
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

  // No ?api=whoami here, deliberately (2026-09-14): under ANONYMOUS access (the mode before
  // the 9/14 DOMAIN switch), Session.getActiveUser() makes Apps Script abort the whole request with
  // Google's "Sorry, unable to open the file at this time" page — it does not return ''.
  // Per-person views therefore need a domain-restricted deployment; see CLAUDE.md.
  if (e.parameter.api === 'data') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(getTrackerFile_('data').getBlob().getDataAsString())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'rulesets') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    var rsText = getTrackerFile_('rulesets').getBlob().getDataAsString();
    // Served in the workstream shape even before the first write persists the migration (2026-09-23).
    try { var rsServed = JSON.parse(rsText); if (tsgMigrateWorkstreams_(rsServed)) rsText = JSON.stringify(rsServed); } catch (mErr) {}
    return ContentService.createTextOutput(rsText).setMimeType(ContentService.MimeType.JSON);
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
  if (e.parameter.api === 'personPage') {
    // The owner's Views pop-up (2026-09-24, per Durand: "change the delegate pop up i see to show
    // their actual page"): the person page exactly as served to them, stamped as an owner preview
    // (__TSG_AS__ set, so every RPC carries `as` and the server applies the owner-only preview
    // rules; edits are recorded as Durand). The dashboard puts it in a sandboxed frame and relays
    // its google.script.run calls.
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    var ppOut;
    try {
      var ppDoc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
      var ppWanted = String(e.parameter.person || '').toLowerCase();
      var ppName = tsgRosterNames_(ppDoc.meta || {}).filter(function(n) { return n.toLowerCase() === ppWanted; })[0];
      if (!ppName) ppOut = { ok: false, error: 'not on the roster: ' + (e.parameter.person || '') };
      else {
        var ppHtml = HtmlService.createHtmlOutputFromFile('person').getContent();
        var ppStamps = { '__TSG_PERSON__': ppName, '__TSG_CODE_VERSION__': TSG_CODE_VERSION, '__TSG_AS__': ppName };
        Object.keys(ppStamps).forEach(function(k) { ppHtml = ppHtml.split(k).join(tsgHtmlEscape_(ppStamps[k])); });
        ppOut = { ok: true, person: ppName, html: ppHtml };
      }
    } catch (ppErr) { ppOut = { ok: false, error: 'person page failed: ' + String(ppErr.message || ppErr) }; }
    return ContentService.createTextOutput(JSON.stringify(ppOut)).setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'fubStatus') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    var fubStatus;
    try { fubStatus = tsgFubStatus_(); } catch (fsErr) { fubStatus = { ok: false, error: String(fsErr.message || fsErr) }; }
    return ContentService.createTextOutput(JSON.stringify(fubStatus)).setMimeType(ContentService.MimeType.JSON);
  }
  if (e.parameter.api === 'fubProbe') {
    if (!tsgCheckToken_(e)) return tsgUnauthorized_();
    return ContentService.createTextOutput(JSON.stringify(tsgFubProbe_(String(e.parameter.agent || '')))).setMimeType(ContentService.MimeType.JSON);
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
    // Links the day view shows on the meeting block (2026-09-22, pinned-task step "google
    // meeting blocks should include their links and related tasks"): the Calendar event
    // itself, a video-call link found in the description or location, and the agenda doc.
    var desc = '';
    try { desc = ev.getDescription() || ''; } catch (e1) {}
    out.push({
      title: title,
      seriesId: seriesId,
      htmlLink: tsgCalendarEventLink_(ev, cal),
      meetLink: tsgFindMeetLink_(desc + ' ' + location),
      agendaDocUrl: tsgFindAgendaDocUrl_(desc),
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

// First video-call link in a description/location: Google Meet, Zoom, Teams, Webex.
var TSG_MEET_LINK_RE = /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[a-z0-9.-]*zoom\.us\/[jw]\/[^\s"'<>]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+|[a-z0-9.-]*webex\.com\/[^\s"'<>]+)/i;
function tsgFindMeetLink_(text) {
  if (!text) return '';
  var m = String(text).match(TSG_MEET_LINK_RE);
  return m ? m[0] : '';
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
  // The total on the task before this pass and whether the pass touched its steps: used at the
  // end to keep a hand-set (or simply pre-existing) total stable when steps are minted or
  // re-estimated without a new total being answered (2026-09-18, per Durand).
  var totalBefore = (typeof task.estHours === 'number' && isFinite(task.estHours)) ? task.estHours : null;
  var stepsTouched = false;
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
  if (need.indexOf('due') !== -1 && est.due && !keep('timelineEnd')) {
    // A proposed due date can never be a day that is already over (Durand, 2026-09-17 23:15
    // EDT, on a Routine that set "today" after work hours from a UTC clock): anything earlier
    // than the earliest workable day is pushed to it, and the history line says so.
    var dueIso = est.due, floorIso = tsgEarliestDueIso_();
    if (dueIso < floorIso) { dueIso = floorIso; applied.push('due moved from ' + est.due + ' to ' + floorIso + ' (that day was already over)'); }
    if (dueIso !== (task.timelineEnd || '')) {
      task.history.push({ ts: now, field: 'timelineEnd', from: task.timelineEnd || null, to: dueIso, source: o.source || 'unknown', note: dueIso !== est.due ? 'proposed ' + est.due + ', already past' : undefined });
      task.timelineEnd = dueIso; task.dueOverride = true; applied.push('due (' + dueIso + ')');
    }
  }
  var totalApplied = null;
  if (need.indexOf('estHours') !== -1 && est.estHours != null && !keep('estHours')) {
    task.estHours = est.estHours;
    totalApplied = est.estHours;
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
        depends: '', notes: '', estHours: hours, estDays: null,
        estSource: hours != null ? 'claude' : 'none', taskType: s.taskType || 'Hands-on',
        history: [{ ts: now, field: 'created', from: null, to: null, source: o.source || 'unknown' }] };
    }));
    applied.push('subitems (+' + est.subitems.length + ')');
    stepsTouched = true;
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
    if (stepsApplied) { applied.push('steps (' + stepsApplied + ' re-judged)'); stepsTouched = true; }
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
  // 2026-09-18 per Durand ("the end result should be the sum of all subitems plus any hours
  // allocated to the main task"): on a task with steps the answered estHours is the TOTAL, so the
  // parent's own share is what is left after the open steps, the same split an explicit dashboard
  // edit gets through tsgCaptureOwnHours_. Runs after new steps are minted and existing ones
  // answered so the split sees their hours. Without it the roll-up added the steps on top of a
  // stale own figure (task 239: answered 2 h with a 1 h step rolled up to 3 h).
  if (!o.subitem && task.subitems && task.subitems.length) {
    if (totalApplied != null) tsgCaptureOwnHours_(task, totalApplied);
    // No new total (hand-set and kept, or not asked for) but steps were minted or re-estimated:
    // the total the task already showed stays the total, and the steps subdivide it. Without
    // this a hand-set 1.5 h task that gained 0.5 h of steps rolled up to 2 h.
    else if (stepsTouched && totalBefore != null) tsgCaptureOwnHours_(task, totalBefore);
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
    return tsgIsPersonSource_(h.source);
  });
}
/**
 * No source = automation (the scheduler's auto-scheduled stamps, legacy rollups); every hand
 * edit since 2026-09 carries 'Durand' or a roster name. Automation sources: Claude answers,
 * Maps, the estimate roll-up, the scheduler, reminders.
 */
function tsgIsPersonSource_(source) {
  var src = String(source || '');
  return !!src && !/^(Claude|Maps|system|rollup|Scheduler|Reminder)/i.test(src) && src !== 'unknown';
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
  if (tsgIsFubTask_(parent)) return;   // FUB tasks are never enriched (2026-09-24)
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
    // Meeting, or a TASK whose type is still open (2026-09-18: the old "or taskType is being
    // asked for" clause made this true on every pass, so every step carried 20 events).
    if (!item.meetingDate && (item.taskType === 'Meeting' || (!item.taskType && !sub))) { calCands = tsgCalendarCandidates_(item.timelineEnd); if (calCands) need.push('meetingMatch'); }
  }
  var current = tsgCurrentSnapshot_(item);
  if (sub) { current.subtask = true; current.parentTitle = parent.title; }
  if (sub && parent) current.parentNotes = String(parent.notes || '').trim().slice(0, 600);
  var context = { groups: board.groups, openTitles: board.openTitles, existingTags: board.existingTags, actuals: board.actuals, batchSiblings: [],
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
  function scan(win) {
    var out = [];
    for (var d = startIso; d <= endIso && out.length < 10; d = tsgAddDays_(d, 1)) {
      var dow = new Date(d + 'T12:00:00').getDay();
      var hours = win[dow];
      if (!hours) continue;
      var blocks = excludeBlocks ? tsgDayBlocks_(d) : [];   // Friday has its own block positions
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
var TSG_ATTACHMENTS_FOLDER = 'Attachments';
var TSG_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
function tsgAttachmentsFolder_() {
  var parent = DriveApp.getFolderById(TRACKER_FOLDER_ID);
  var it = parent.getFoldersByName(TSG_ATTACHMENTS_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(TSG_ATTACHMENTS_FOLDER);
}
function tsgSafeFileName_(name) {
  var n = String(name || '').replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (n || 'attachment').slice(0, 120);
}
function tsgUploadAttachment_(fields) {
  var b64 = String(fields && fields.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!b64) return { ok: false, error: 'No file content' };
  var mime = String(fields.mime || 'application/octet-stream');
  var name = tsgSafeFileName_(fields.name || ('pasted-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmmss') + (mime.indexOf('image/') === 0 ? '.' + (mime.split('/')[1] || 'png').replace('jpeg', 'jpg') : '')));
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > TSG_UPLOAD_MAX_BYTES) return { ok: false, error: 'File is larger than 10 MB' };
  var blob = Utilities.newBlob(bytes, mime, name);
  var file = tsgAttachmentsFolder_().createFile(blob);
  var isImage = mime.indexOf('image/') === 0;
  return { ok: true, url: file.getUrl(), id: file.getId(), name: file.getName(), mime: mime, type: isImage ? 'image' : 'file', bytes: bytes.length };
}
// Legacy single `doc` folded into the one docs[] list on every write (2026-09-17: "one field
// for all types of links"). The scheduler/enricher still read both while old data exists.
/** Every task carries `subitems`, `tags`, `docs` and `history` as arrays (2026-09-21). Runs on every write. */
function tsgNormalizeTaskShapes_(doc) {
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t) return;
    ['subitems', 'tags', 'docs', 'history'].forEach(function(k) { if (!Array.isArray(t[k])) t[k] = []; });
    if (t.taskType) t.taskType = tsgCanonicalTaskType_(t.taskType);
    t.subitems.forEach(function(s) { if (s && s.taskType) s.taskType = tsgCanonicalTaskType_(s.taskType); });
  });
}
/** Task type "Actionable Task" was renamed "Hands-on" (Durand, 2026-09-21); "Schedule Task" was folded
 *  into it earlier. Old values in data, patches and answers land as the current name. */
var TSG_TASK_TYPE_ALIASES = { 'actionable task': 'Hands-on', 'schedule task': 'Hands-on', 'hands on': 'Hands-on', 'hands-on': 'Hands-on' };
function tsgCanonicalTaskType_(v) {
  var k = String(v || '').trim().toLowerCase();
  return TSG_TASK_TYPE_ALIASES[k] || v;
}
/**
 * Every delegated item requires approval (Durand, 2026-09-21: "all delegated tasks should
 * require approval"). A task or step whose delegate is set and is not Durand (a person or
 * Claude) carries needsApproval = true; the flag is derived from the delegation, so a hand
 * unset is re-applied on the next write. Undelegated items keep whatever was set by hand.
 * Runs on every write; each change gets a history line with source `Delegation`.
 */
function tsgIsDelegatedAway_(name) {
  var n = String(name || '').trim().toLowerCase();
  return !!n && n !== 'durand' && n !== 'unassigned';
}
function tsgApplyDelegateApproval_(doc) {
  var now = new Date().toISOString(), changed = 0;
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t || t.status === 'Done' || t.status === 'Cancelled' || tsgIsFubTask_(t)) return;   // FUB tasks: the agent's own work
    if (tsgIsDelegatedAway_(tsgTaskDelegate_(t)) && t.needsApproval !== true) {
      var was = String(!!t.needsApproval);
      t.needsApproval = true; changed++;
      if (!Array.isArray(t.history)) t.history = [];
      t.history.push({ ts: now, field: 'needsApproval', from: was, to: 'true', source: 'Delegation' });
    }
    (t.subitems || []).forEach(function(s) {
      if (!s || s.done || s.status === 'Done' || s.status === 'Cancelled' || tsgIsFeedbackStep_(s)) return;
      if (tsgIsDelegatedAway_(s.delegate) && s.needsApproval !== true) {
        s.needsApproval = true; changed++;
        if (!Array.isArray(t.history)) t.history = [];
        t.history.push({ ts: now, field: 'subitem-needsApproval', from: s.title, to: 'true', source: 'Delegation' });
      }
    });
  });
  return changed;
}
function tsgMigrateDocToDocs_(doc) {
  (doc.tasks || []).forEach(function(t) {
    if (!t) return;
    [t].concat(t.subitems || []).forEach(function(it) {
      if (!it || !it.doc) return;
      if (!Array.isArray(it.docs)) it.docs = [];
      var url = String(it.doc).trim();
      if (url && !it.docs.some(function(d) { return d && d.url === url; })) {
        var host = /^https?:\/\/([^\/?#]+)/i.exec(url);
        it.docs.unshift({ url: url, label: host ? host[1].replace(/^www\./, '') : url, type: 'link', migrated: true });
      }
      delete it.doc;
    });
  });
}
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
/**
 * ============================================================================
 * FUB TASK SYNC — per-agent keys, READ-ONLY PILOT (2026-09-24, per Durand: "i want per agent,
 * and lets start with just jason as a pilot"; "reduce the sync cadence, agent can use sync now
 * if necessary, implement batch updates, not one offs, while read only all tracker fields are
 * locked, for now put a red border on fub fields (also locked)").
 *
 * - One Follow Up Boss API key PER AGENT, stored by Durand in Script Properties as
 *   FUB_KEY_<NAME> (tsgFubKeyProp_). Never in the tracker, a Doc, chat or the repo. The key's
 *   own /v1/me call says which FUB user it is, so no manual id mapping.
 * - Direction: FUB -> tracker only. TSG_FUB_PUSH_BUILT is false, so every FUB-linked task is
 *   read-only everywhere: patches from any source but 'FUB' are refused by name, a dashboard
 *   save that touched one is reverted to the server copy, the person page gets no controls.
 * - Ownership: the assigned agent owns the tracker copy (owner = delegate = group = agent,
 *   tag FUB). Never held for Triage, never enriched, never flagged for approval or aging.
 * - Cadence: meta.fubSync.cadenceMin (60 / 120 / 240, default 60), checked on the existing
 *   1-minute inbox tick against a script property (no Drive read until due, no new trigger).
 *   "Sync now" on the dashboard (all enabled agents) and on the agent's page (self, 2-minute
 *   cooldown).
 * - Batching: one run = ONE bulk inbox patch holding every add / update / cancel for every
 *   agent in the run (source 'FUB'); nothing is written when nothing changed.
 * - Link key: task.fub.taskId. FUB-side fields live in task.fub (personId, personName,
 *   personUrl, type, assignedUserId, createdById, created, updated, completed, agent).
 * ---------------------------------------------------------------------------
 */
var TSG_FUB_API = 'https://api.followupboss.com/v1';
var TSG_FUB_CONFIG_PROP = 'TSG_FUB_SYNC_CONFIG';
var TSG_FUB_STATE_PROP = 'TSG_FUB_SYNC_STATE';
var TSG_FUB_CADENCES = [60, 120, 240];
var TSG_FUB_DEFAULT_CADENCE = 240;   // Durand 2026-09-24: "4 hours is enough"; agents have Sync now
var TSG_FUB_KEY_SET_COOLDOWN_SEC = 30;
var TSG_FUB_PAGE = 100;
var TSG_FUB_MAX_PAGES = 10;
var TSG_FUB_SYNC_NOW_COOLDOWN_SEC = 120;
var TSG_FUB_PUSH_BUILT = false;   // tracker -> FUB is not built: the pilot is read-only
// Tracker fields whose value comes from FUB (the dashboard and the person page outline them in red).
var TSG_FUB_SOURCED_FIELDS = ['title', 'taskType', 'timelineEnd', 'dueTime', 'status', 'owner', 'delegate'];
// Ops that change a task; refused on a FUB task from any source but 'FUB' while read-only.
var TSG_FUB_LOCKED_OPS = ['update_task', 'update_subitem', 'add_subitem', 'delete_task', 'reorder_subitems', 'log_time', 'request_tidy', 'request_steps'];

function tsgIsFubTask_(t) { return !!(t && t.fub && typeof t.fub === 'object' && t.fub.taskId != null && t.fub.taskId !== ''); }
function tsgFubReadOnly_(doc) {
  if (!TSG_FUB_PUSH_BUILT) return true;
  var cfg = (doc && doc.meta && doc.meta.fubSync) || {};
  return cfg.readOnly !== false;
}
function tsgFubKeyProp_(name) { return 'FUB_KEY_' + String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_'); }
function tsgFubKeyFor_(name) {
  try { return PropertiesService.getScriptProperties().getProperty(tsgFubKeyProp_(name)) || ''; } catch (e) { return ''; }
}
/**
 * Self-service key (2026-09-24, per Durand: "agents need a settings pane to add their own key").
 * The agent pastes their FUB API key on their own page; it is checked against FUB's /me BEFORE it
 * is stored, lands only in Script Properties (FUB_KEY_<NAME>), and is never sent back, logged or
 * written to the data file. The state keeps who set it and when, and the FUB user it belongs to.
 */
function tsgFubSetKey_(name, key, actor) {
  key = String(key || '').trim();
  if (!/^[A-Za-z0-9_\-]{16,200}$/.test(key)) return { ok: false, error: 'That does not look like a FUB API key (letters and numbers, no spaces).' };
  var me;
  try { me = tsgFubGet_(key, '/me'); }
  catch (err) { return { ok: false, error: err && err.code === 401 ? 'FUB rejected that key. Copy it again from FUB and paste the whole key.' : 'Could not reach FUB to check the key: ' + String((err && err.message) || err).slice(0, 120) }; }
  PropertiesService.getScriptProperties().setProperty(tsgFubKeyProp_(name), key);
  var state = tsgFubState_(); state.agents = state.agents || {};
  var meName = me && (me.name || ((me.firstName || '') + ' ' + (me.lastName || '')).trim()) || '';
  state.agents[name] = Object.assign({}, state.agents[name] || {}, { keySetAt: new Date().toISOString(), keySetBy: actor || name, meId: me && me.id != null ? me.id : null, meName: meName, keyRemovedAt: '' });
  tsgFubSaveState_(state);
  return { ok: true, fubUser: { name: meName, email: (me && me.email) || '' } };
}
function tsgFubRemoveKey_(name, actor) {
  try { PropertiesService.getScriptProperties().deleteProperty(tsgFubKeyProp_(name)); } catch (e) { return { ok: false, error: 'could not remove the key' }; }
  var state = tsgFubState_(); state.agents = state.agents || {};
  state.agents[name] = Object.assign({}, state.agents[name] || {}, { keyRemovedAt: new Date().toISOString(), keySetBy: actor || name });
  tsgFubSaveState_(state);
  return { ok: true };
}
function tsgFubKeyInfo_(doc, name) {
  var cfg = tsgFubConfig_(doc.meta || {});
  var st = (tsgFubState_().agents || {})[name] || {};
  var present = !!tsgFubKeyFor_(name);
  return { present: present, enabled: cfg.agents.indexOf(name) !== -1, setAt: present ? (st.keySetAt || '') : '', fubUserName: present ? (st.meName || '') : '', cadenceMin: cfg.cadenceMin };
}
function tsgRosterNames_(meta) {
  return ((meta && meta.teamRoster) || []).map(function(p) { return typeof p === 'string' ? p : (p && p.name); }).filter(Boolean);
}
/** Sanitised sync settings: agents on the roster (the owner included), a known cadence, an https FUB address. */
function tsgFubConfig_(meta) {
  var raw = (meta && meta.fubSync) || {};
  var roster = tsgRosterNames_(meta);
  var agents = (Array.isArray(raw.agents) ? raw.agents : []).filter(function(n, i, a) {
    return n && a.indexOf(n) === i && (!roster.length || roster.indexOf(n) !== -1);
  });
  var cadence = TSG_FUB_CADENCES.indexOf(Number(raw.cadenceMin)) !== -1 ? Number(raw.cadenceMin) : TSG_FUB_DEFAULT_CADENCE;
  var appBase = /^https:\/\/[a-z0-9-]+\.followupboss\.com$/i.test(String(raw.appBase || '').replace(/\/+$/, '')) ? String(raw.appBase).replace(/\/+$/, '') : '';
  return { agents: agents, cadenceMin: cadence, appBase: appBase, readOnly: TSG_FUB_PUSH_BUILT ? raw.readOnly !== false : true };
}
function tsgFubConfigFromProp_() {
  try { var raw = PropertiesService.getScriptProperties().getProperty(TSG_FUB_CONFIG_PROP); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function tsgFubState_() {
  try { var raw = PropertiesService.getScriptProperties().getProperty(TSG_FUB_STATE_PROP); return raw ? JSON.parse(raw) : { agents: {} }; } catch (e) { return { agents: {} }; }
}
function tsgFubSaveState_(state) {
  try { PropertiesService.getScriptProperties().setProperty(TSG_FUB_STATE_PROP, JSON.stringify(state)); } catch (e) { Logger.log('[fub] state not saved: ' + e); }
}
/** GET one FUB endpoint with an agent's key. One retry on 429. Throws with the status on failure. */
function tsgFubGet_(key, path) {
  var opts = { method: 'get', muteHttpExceptions: true, headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':'), 'Accept': 'application/json' } };
  var resp = UrlFetchApp.fetch(TSG_FUB_API + path, opts);
  if (resp.getResponseCode() === 429) { Utilities.sleep(2000); resp = UrlFetchApp.fetch(TSG_FUB_API + path, opts); }
  var code = resp.getResponseCode();
  if (code !== 200) {
    var err = new Error('FUB ' + path.split('?')[0] + ' returned ' + code + (code === 401 ? ' (key rejected: revoked, regenerated or mistyped)' : '') + ': ' + String(resp.getContentText() || '').slice(0, 200));
    err.code = code;
    throw err;
  }
  return JSON.parse(resp.getContentText() || '{}');
}
/** FUB task type -> tracker taskType. The raw FUB value is kept in task.fub.type. */
function tsgFubMapType_(type) {
  var t = String(type || '').toLowerCase();
  if (t === 'call' || t === 'phone call') return 'Call';
  if (t === 'email') return 'Email';
  if (t === 'text' || t === 'text message' || t === 'sms') return 'Text/Chat';
  if (t === 'appointment' || t === 'showing' || t === 'open house' || t === 'closing' || t === 'meeting') return 'Meeting';
  return 'Hands-on';
}
/** Due date and time in the script's time zone. dueDateTime wins; a bare dueDate has no time. */
function tsgFubDue_(ft) {
  var tz = Session.getScriptTimeZone();
  var dt = ft && (ft.dueDateTime || ft.dueDatetime);
  if (dt && /T\d{2}:\d{2}/.test(String(dt))) {
    var d = new Date(dt);
    if (!isNaN(d.getTime())) return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz, 'HH:mm') };
  }
  var dd = ft && (ft.dueDate || dt);
  if (dd && /^\d{4}-\d{2}-\d{2}/.test(String(dd))) return { date: String(dd).slice(0, 10), time: '' };
  return { date: '', time: '' };
}
function tsgFubCompleted_(ft) { return !!(ft && (ft.isCompleted === true || ft.isCompleted === 1 || ft.completed === true || String(ft.status || '').toLowerCase() === 'completed')); }
function tsgFubPersonName_(ft) {
  if (!ft) return '';
  if (ft.personName) return String(ft.personName);
  if (ft.person && typeof ft.person === 'object') return String(ft.person.name || ((ft.person.firstName || '') + ' ' + (ft.person.lastName || '')).trim());
  return '';
}
/** The task.fub block for a FUB task as synced for `agent`. */
function tsgFubBlock_(ft, agent, cfg) {
  var personId = ft.personId != null ? ft.personId : (ft.person && ft.person.id != null ? ft.person.id : null);
  return {
    taskId: ft.id, personId: personId, personName: tsgFubPersonName_(ft),
    personUrl: (cfg.appBase && personId != null) ? cfg.appBase + '/2/people/view/' + personId : '',
    type: ft.type || '', assignedUserId: ft.assignedUserId != null ? ft.assignedUserId : null,
    createdById: ft.createdById != null ? ft.createdById : null, created: ft.created || '', updated: ft.updated || '',
    completed: tsgFubCompleted_(ft), agent: agent
  };
}
/** The FUB-sourced tracker fields for a FUB task. */
function tsgFubTrackerFields_(ft, agent, cfg) {
  var due = tsgFubDue_(ft), fub = tsgFubBlock_(ft, agent, cfg);
  var title = String(ft.name || '').trim() || ((ft.type || 'Task') + (fub.personName ? ' — ' + fub.personName : ''));
  return { title: title, taskType: tsgFubMapType_(ft.type), timelineEnd: due.date, dueTime: due.time, owner: agent, delegate: agent, fub: fub };
}
function tsgFubSameBlock_(a, b) {
  var strip = function(x) { var c = Object.assign({}, x || {}); delete c.syncedAt; delete c.missingAt; return JSON.stringify(c); };
  return strip(a) === strip(b);
}
/**
 * The ops one agent's fetch implies, against the current document. Pure (no I/O) so it is
 * tested directly. `complete` = the listing was not truncated; only then is a linked open task
 * that FUB no longer returns (deleted, or reassigned to someone else) cancelled.
 */
function tsgFubPlanForAgent_(doc, agent, fubTasks, meId, complete, now, cfg, opts) {
  opts = opts || {};
  var ops = [], stats = { fetched: (fubTasks || []).length, added: 0, updated: 0, completed: 0, cancelled: 0, skipped: 0 };
  var linked = {};
  (doc.tasks || []).forEach(function(t) { if (tsgIsFubTask_(t)) linked[String(t.fub.taskId)] = t; });
  var seen = {};
  (fubTasks || []).forEach(function(ft) {
    if (!ft || ft.id == null) return;
    if (meId != null && ft.assignedUserId != null && String(ft.assignedUserId) !== String(meId)) { stats.skipped++; return; }
    seen[String(ft.id)] = true;
    var want = tsgFubTrackerFields_(ft, agent, cfg);
    var done = want.fub.completed;
    var t = linked[String(ft.id)];
    if (!t) {
      if (done) { stats.skipped++; return; }   // only open tasks are imported; completion closes linked ones
      want.fub.syncedAt = now;
      var task = {
        title: want.title, owner: agent, delegate: agent, group: agent, status: 'Not Started', priority: 'Medium',
        taskType: want.taskType, tags: ['FUB'], timelineStart: '', timelineEnd: want.timelineEnd, dueTime: want.dueTime,
        dueOverride: !!want.timelineEnd, progress: 0, depends: '', dependsNone: true,
        docs: want.fub.personUrl ? [{ url: want.fub.personUrl, label: 'FUB: ' + (want.fub.personName || 'contact'), type: 'link' }] : [],
        notes: '', subitems: [], estHours: null, estDays: null, estSource: 'none', fub: want.fub,
        history: [{ ts: now, field: 'created', from: null, to: 'FUB task ' + ft.id, source: 'FUB' }]
      };
      var add = { op: 'add_task', task: task, skipEnrich: true, skipDedup: true, fubImport: true };
      if (opts.actor) add.fubActor = opts.actor;
      ops.push(add); stats.added++;
      return;
    }
    var fields = {};
    ['title', 'taskType', 'timelineEnd', 'dueTime', 'owner', 'delegate'].forEach(function(k) {
      if (String(t[k] == null ? '' : t[k]) !== String(want[k] == null ? '' : want[k])) fields[k] = want[k];
    });
    if (fields.timelineEnd !== undefined) fields.dueOverride = !!want.timelineEnd;
    if (fields.owner !== undefined) fields.group = agent;
    var st = t.status || 'Not Started';
    if (done && st !== 'Done') { fields.status = 'Done'; fields.progress = 100; stats.completed++; }
    else if (!done && (st === 'Done' || st === 'Cancelled')) { fields.status = 'Not Started'; }
    if (!tsgFubSameBlock_(t.fub, want.fub)) fields.fub = want.fub;
    if (Object.keys(fields).length) {
      if (fields.fub === undefined) fields.fub = want.fub;
      fields.fub = Object.assign({}, fields.fub, { syncedAt: now });
      var up = { op: 'update_task', id: t.id, fields: fields };
      if (opts.actor) up.fubActor = opts.actor;
      ops.push(up);
      if (!fields.status || fields.status !== 'Done') stats.updated++;
    }
  });
  if (complete) {
    Object.keys(linked).forEach(function(fid) {
      var t = linked[fid];
      if (seen[fid] || !t.fub || t.fub.agent !== agent) return;
      if (t.status === 'Done' || t.status === 'Cancelled') return;
      ops.push({ op: 'update_task', id: t.id, fields: { status: 'Cancelled', fub: Object.assign({}, t.fub, { missingAt: now, syncedAt: now }) } });
      stats.cancelled++;
    });
  }
  return { ops: ops, stats: stats };
}
/** Fetch one agent's tasks with their own key: /me first (who the key is), then the paged task list. */
function tsgFubFetchAgent_(agent) {
  var key = tsgFubKeyFor_(agent);
  if (!key) { var e = new Error('No ' + tsgFubKeyProp_(agent) + ' in Script Properties'); e.code = 'nokey'; throw e; }
  var me = tsgFubGet_(key, '/me');
  var meId = me && me.id != null ? me.id : null;
  var tasks = [], total = null, complete = false;
  for (var page = 0; page < TSG_FUB_MAX_PAGES; page++) {
    var q = '/tasks?limit=' + TSG_FUB_PAGE + '&offset=' + (page * TSG_FUB_PAGE) + (meId != null ? '&assignedUserId=' + encodeURIComponent(meId) : '');
    var data = tsgFubGet_(key, q);
    var batch = data.tasks || [];
    tasks = tasks.concat(batch);
    if (data._metadata && typeof data._metadata.total === 'number') total = data._metadata.total;
    if (batch.length < TSG_FUB_PAGE || (total != null && tasks.length >= total)) { complete = true; break; }
  }
  return { me: { id: meId, name: me && (me.name || ((me.firstName || '') + ' ' + (me.lastName || '')).trim()), email: me && me.email }, tasks: tasks, total: total, complete: complete };
}
/**
 * One sync run over `agents` (default: every enabled agent). Reads the data file once, fetches
 * each agent, and writes ONE bulk inbox patch with every change (none when nothing changed).
 */
function tsgFubRunSync_(opts) {
  opts = opts || {};
  var now = new Date().toISOString();
  var doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  var cfg = tsgFubConfig_(doc.meta || {});
  var agents = (opts.agents || cfg.agents).filter(function(a) { return cfg.agents.indexOf(a) !== -1; });
  var state = tsgFubState_(); state.agents = state.agents || {};
  var allOps = [], report = {};
  agents.forEach(function(agent) {
    var prev = state.agents[agent] || {};
    var rec = { lastRunAt: now, reason: opts.reason || 'schedule' };
    try {
      var got = tsgFubFetchAgent_(agent);
      // After the first successful import, FUB-side changes count as the agent's own activity.
      var plan = tsgFubPlanForAgent_(doc, agent, got.tasks, got.me.id, got.complete, now, cfg, { actor: prev.lastOkAt ? agent : null });
      allOps = allOps.concat(plan.ops);
      rec = Object.assign(rec, plan.stats, { ok: true, lastOkAt: now, error: '', meId: got.me.id, meName: got.me.name || '', total: got.total, complete: got.complete });
    } catch (err) {
      rec = Object.assign({}, prev, rec, { ok: false, error: String((err && err.message) || err), errorCode: err && err.code != null ? err.code : null });
    }
    state.agents[agent] = rec;
    report[agent] = rec;
  });
  var result = { ok: true, agents: report, ops: allOps.length, wrote: false };
  if (allOps.length) {
    var q = tsgQueueDataPatch_({ op: 'bulk', ops: allOps, source: 'FUB' });
    result.wrote = true; result.busy = !!(q && q.busy);
  }
  state.lastRunAt = now;
  tsgFubSaveState_(state);
  return result;
}
/** On the 1-minute tick: a property read, and a run only when the cadence says one is due. */
function tsgFubSyncTickIfDue_() {
  var cfg = tsgFubConfigFromProp_();
  if (!cfg || !Array.isArray(cfg.agents) || !cfg.agents.length) return false;
  var state = tsgFubState_();
  var last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  var cadenceMs = (TSG_FUB_CADENCES.indexOf(Number(cfg.cadenceMin)) !== -1 ? Number(cfg.cadenceMin) : TSG_FUB_DEFAULT_CADENCE) * 60000;
  if (last && Date.now() - last < cadenceMs) return false;
  tsgFubRunSync_({ reason: 'schedule' });
  return true;
}
/** Owner status for Settings > General: config, per agent key presence and last run. */
function tsgFubStatus_() {
  var doc = JSON.parse(getTrackerFile_('data').getBlob().getDataAsString());
  var cfg = tsgFubConfig_(doc.meta || {});
  var state = tsgFubState_();
  var roster = tsgRosterNames_(doc.meta || {});
  return {
    ok: true, config: cfg, readOnly: tsgFubReadOnly_(doc), pushBuilt: TSG_FUB_PUSH_BUILT, lastRunAt: state.lastRunAt || '',
    agents: roster.map(function(n) {
      var ast = (state.agents || {})[n] || null;
      return { name: n, enabled: cfg.agents.indexOf(n) !== -1, keyProperty: tsgFubKeyProp_(n), keyPresent: !!tsgFubKeyFor_(n), keySetAt: ast && ast.keySetAt || '', keySetBy: ast && ast.keySetBy || '', state: ast };
    })
  };
}
/** Owner-only key check: who the key is, how many tasks, and the field names FUB actually sends. */
function tsgFubProbe_(agent) {
  if (!agent) return { ok: false, error: 'agent required' };
  try {
    var got = tsgFubFetchAgent_(agent);
    var fields = {}, types = {};
    got.tasks.forEach(function(ft) { Object.keys(ft || {}).forEach(function(k) { fields[k] = true; }); if (ft && ft.type) types[ft.type] = (types[ft.type] || 0) + 1; });
    var open = got.tasks.filter(function(ft) { return !tsgFubCompleted_(ft); }).length;
    return { ok: true, agent: agent, keyProperty: tsgFubKeyProp_(agent), me: got.me, fetched: got.tasks.length, open: open, total: got.total, complete: got.complete,
      fieldNames: Object.keys(fields).sort(), types: types, sample: got.tasks[0] || null };
  } catch (err) {
    return { ok: false, agent: agent, keyProperty: tsgFubKeyProp_(agent), error: String((err && err.message) || err) };
  }
}

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
  // Attachments (2026-09-17, per Durand: "add the ability to add local files and paste images
  // too"): a file or pasted image lands in TRACKER_FOLDER_ID/Attachments and comes back as a
  // link for the task's one docs[] list. Owner-only through tsgRpc; 10 MB decoded cap.
  if (requested === 'upload') {
    var upFields;
    try { upFields = JSON.parse(body || '{}'); } catch (err) { upFields = {}; }
    var upResult;
    try { upResult = tsgUploadAttachment_(upFields); }
    catch (upErr) { upResult = { ok: false, error: 'Upload failed: ' + upErr.message }; }
    return ContentService.createTextOutput(JSON.stringify(upResult)).setMimeType(ContentService.MimeType.JSON);
  }
  if (requested === 'fubSync') {
    // Dashboard "Sync now" (2026-09-24): every enabled agent, or one ({agent}); one bulk patch.
    var fubReq = {};
    try { fubReq = JSON.parse(body || '{}') || {}; } catch (err) { fubReq = {}; }
    var fubRun;
    try { fubRun = tsgFubRunSync_({ agents: fubReq.agent ? [String(fubReq.agent)] : null, reason: 'sync-now:Durand' }); }
    catch (fubErr) { fubRun = { ok: false, error: 'FUB sync failed: ' + fubErr.message }; }
    return ContentService.createTextOutput(JSON.stringify(fubRun)).setMimeType(ContentService.MimeType.JSON);
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
      ok: false, error: 'Unknown target: ' + requested + '. Expected data, rulesets, claude, tidy, createMeeting, linkMeeting, sendDirections or upload.'
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
  // workstream/current patches into _Inbox too, so the document had exactly the two
  // uncoordinated writers racing for one file that the data file's own fix was written to
  // eliminate. Same two shapes as target=data:
  //   - a whole document (has .current or .workstreams; an older page sends .threads) — the dashboard's Settings save.
  //     Wrapped as a "replace_all" ruleset patch, version-checked against meta.docVersion.
  //   - a single op (has .op, e.g. {op:'add_workstream_memory', ...}) — the same shape a
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
  'progress', 'depends', 'doc', 'notes', 'estHours', 'estDays', 'taskType', 'dueOverride', 'location', 'travelMode', 'travelMethod', 'pinned', 'dueTime', 'remindAt', 'dependsNone', 'actualHours', 'needsApproval', 'delegateVisible'];
var TSG_SUBITEM_DIFF_FIELDS = ['title', 'delegate', 'status', 'priority', 'timelineEnd',
  'progress', 'depends', 'doc', 'notes', 'estHours', 'estDays', 'taskType', 'done', 'location', 'travelMode', 'travelMethod', 'dueTime', 'remindAt', 'actualHours', 'needsApproval'];

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
  'ACTUALS_BY_TYPE, when present, is measured time from this team\'s own completed items (a reference ' +
  'class). For the task\'s type with n >= 3, anchor on its median actual hours for comparable work and ' +
  'scale the calibration row by its actual/estimate ratio; measured work beats the table. With fewer ' +
  'samples, or no row for the type, use the table as is.\n' +
  'subitems: NEW steps only — concrete steps actually stated or clearly implied by the title/notes ' +
  'and not already present in CURRENT_STEPS. Each is {"title", "estHours", "taskType", "priority"} ' +
  'judged by the same rules as the task\'s own fields (hands-on hours from the calibration table). ' +
  'A step\'s taskType is judged on that step ALONE, never copied from the parent: a task typed Claude ' +
  'can have a Hands-on or Call step and a Hands-on task can have Claude or Email steps; look at what ' +
  'the step itself makes someone do. ' +
  'Empty array if the task is a single atomic action. Never invent work that is not there.\n' +
  'taskType is one of: "Email"|"Call"|"Text/Chat"|"Meeting"|"Claude"|"Hands-on". Use "Email" or ' +
  '"Call" when the whole point of the task is sending one email or making one call. Use ' +
  '"Text/Chat" for a quick message to one person (SMS or a chat ping) rather than a call or ' +
  'formal email. Use "Meeting" only when the task IS a meeting or is meant to be checked on/' +
  'discussed in one. Use "Claude" when the work itself is something Claude (the AI assistant the ' +
  'Director runs in Cowork / Claude Code sessions) would carry out end to end: drafting a document ' +
  'or email, research, a data pull or transform, tracker or Drive housekeeping, a summary. A task a ' +
  'human must physically do or decide stays "Hands-on". Everything else is "Hands-on" — this should be the majority.\n\n' +
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
  'notes — ONLY when requested: the notes rewritten as ONE compact "Current state" note: where ' +
  'things stand right now, the next action, what it is blocked on, and every fact still needed to ' +
  'act (names, dates, phone numbers, dollar amounts, URLs, decisions) kept verbatim. NO running log ' +
  'of dated entries: superseded lines, chatter, duplicates and old instructions are dropped, because ' +
  'the tracker archives every previous version of the note in full. A "DRAFT — AWAITING APPROVAL" ' +
  'block is kept as written. Never invent a fact. The raw text may be a free-flow thought — ' +
  'turn it into that note. Return the notes unchanged when they are already clean. Do the ' +
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
var TSG_RESERVED_TAGS = ['Triage', 'Review', 'Aging', 'Scheduling Stuck', 'Dependency Issue', 'needs-estimate', 'Claude', 'At Risk', 'Needs Durand', 'Feedback', 'FUB'];

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
      .filter(function(tg) { return TSG_RESERVED_TAGS.indexOf(tg) === -1; }),
    actuals: tsgActualsByType_(doc)
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
var TSG_TASK_TYPE_VALUES = ['Email', 'Call', 'Text/Chat', 'Meeting', 'Claude', 'Hands-on'];
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
  if (need.indexOf('estHours') !== -1 && context.actuals && Object.keys(context.actuals).length) {
    userParts.push('ACTUALS_BY_TYPE (this team\'s measured completed work: n items with logged time, median actual hours, median actual/estimate ratio):\n' + JSON.stringify(context.actuals));
  }
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
    out.taskType = tsgCanonicalTaskType_(parsed.taskType);
  }
  if (need.indexOf('subitems') !== -1) {
    // A string (the Routine's older answers) or an object with the step's own hours/type/priority.
    out.subitems = (parsed.subitems || []).map(function (s) { return (s && typeof s === 'object') ? s : { title: s }; })
      .filter(function (s) { return s && String(s.title || '').trim(); })
      .slice(0, 8)
      .map(function (s) {
        var o = { title: String(s.title).trim(), done: false };
        if (typeof s.estHours === 'number' && isFinite(s.estHours) && s.estHours > 0) o.estHours = Math.max(0.25, Math.round(s.estHours * 4) / 4);
        if (TSG_TASK_TYPE_VALUES.indexOf(tsgCanonicalTaskType_(s.taskType)) !== -1) o.taskType = tsgCanonicalTaskType_(s.taskType);
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
      currentSteps: context.currentSteps || null, actuals: (context.actuals && Object.keys(context.actuals).length) ? context.actuals : null };
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

/** The dashboard's Re-run Claude button: always queues a forced enrich request (2026-09-22: the
 *  old API-key tick-box proposal path is gone, Tidy is automatic in every mode). */
function tsgTidyProposal_(taskId) {
  if (!taskId) return { ok: false, error: 'taskId required' };
  var r = tsgQueueDataPatch_({ op: 'request_tidy', id: taskId, source: 'Durand' });
  return { ok: true, queued: true, taskId: taskId, busy: !!(r && r.busy) };
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

/**
 * ACTUAL TIME CAPTURE — added 2026-09-17 (per Durand: "how are we currently measuring actual
 * time spent on a project?" — nothing was — and "build the timer, but that might not be
 * accurate either cause it relies on me starting and stopping it").
 *
 * One log, several ways in, each entry tagged with how it was measured so a number is
 * always traceable: kind 'timer' (the card timer on the dashboard), 'manual' (a value typed
 * when an item is marked Done, prefilled with the estimate, or "+ Log time"), 'session' (a
 * Claude session's self-report through this op: Durand's ATTENTION minutes as `minutes`,
 * with the session's `turns` and wall-clock `spanMin` kept alongside and never counted as
 * hours), 'calendar' (tsgAttributeCalendarHours). actualHours on an item is always the sum
 * of its own timeLog; a parent's total for calibration adds its steps' (tsgItemActualHours_).
 *
 *   {op:'log_time', id, subIdx?, minutes, kind?, source?, note?, at?, turns?, spanMin?}
 */
var TSG_TIME_KINDS = ['timer', 'manual', 'session', 'calendar'];
function tsgActualHoursFromLog_(log) {
  var min = (log || []).reduce(function(n, e) { return n + (Number(e && e.minutes) || 0); }, 0);
  return Math.round(min / 60 * 4) / 4;
}
function tsgItemActualHours_(t) {
  var h = Number(t && t.actualHours) || 0;
  ((t && t.subitems) || []).forEach(function(s) { h += Number(s && s.actualHours) || 0; });
  return Math.round(h * 4) / 4;
}
function tsgLogTime_(doc, patch, now) {
  var t = (doc.tasks || []).filter(function(x) { return x && x.id === patch.id; })[0];
  if (!t) throw new Error('log_time: task id not found: ' + patch.id);
  var subIdx = (typeof patch.subIdx === 'number') ? patch.subIdx : null;
  var item = t;
  if (subIdx !== null) { item = (t.subitems || [])[subIdx]; if (!item) throw new Error('log_time: no subitem ' + subIdx + ' on task ' + patch.id); }
  var minutes = Math.round(Number(patch.minutes));
  if (!isFinite(minutes) || minutes <= 0) throw new Error('log_time: minutes must be a positive number');
  var kind = TSG_TIME_KINDS.indexOf(patch.kind) !== -1 ? patch.kind : 'manual';
  var source = patch.source || 'unknown';
  item.timeLog = Array.isArray(item.timeLog) ? item.timeLog : [];
  var entry = { ts: patch.at || now, minutes: minutes, kind: kind, source: source };
  if (patch.note) entry.note = String(patch.note).slice(0, 300);
  if (typeof patch.turns === 'number' && patch.turns > 0) entry.turns = Math.round(patch.turns);
  if (typeof patch.spanMin === 'number' && patch.spanMin > 0) entry.spanMin = Math.round(patch.spanMin);
  item.timeLog.push(entry);
  var before = (item.actualHours == null) ? null : item.actualHours;
  item.actualHours = tsgActualHoursFromLog_(item.timeLog);
  item.actualSource = kind;
  var turns = item.timeLog.reduce(function(n, e) { return n + (Number(e && e.turns) || 0); }, 0);
  if (turns) item.claudeTurns = turns;
  t.history = Array.isArray(t.history) ? t.history : [];
  t.history.push({ ts: now, field: subIdx !== null ? 'subitem-actualHours' : 'actualHours', from: before,
    to: item.actualHours + ' h (' + kind + (entry.turns ? ', ' + entry.turns + ' turns' : '') + ')', source: source });
  return entry;
}
/**
 * Reference class from the team's OWN measured work, by task type: n done items with logged
 * time, median actual hours, and the median actual/estimate ratio. Goes to the estimator as
 * ACTUALS_BY_TYPE (and into every queued enrich request) so a type with enough samples is
 * anchored on measurement instead of the calibration table. Fewer than 3 samples: the type
 * is left out (one number is an anecdote).
 */
function tsgActualsByType_(doc) {
  var by = {};
  ((doc && doc.tasks) || []).forEach(function(t) {
    if (!t || t.status !== 'Done') return;
    var actual = tsgItemActualHours_(t);
    if (!(actual > 0)) return;
    var type = t.taskType || 'Hands-on';
    by[type] = by[type] || { actual: [], ratio: [] };
    by[type].actual.push(actual);
    if (Number(t.estHours) > 0) by[type].ratio.push(actual / Number(t.estHours));
  });
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function(x, y) { return x - y; }); var m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  var out = {};
  Object.keys(by).forEach(function(type) {
    if (by[type].actual.length < 3) return;
    var r = median(by[type].ratio);
    out[type] = { n: by[type].actual.length, medianActualHours: Math.round(median(by[type].actual) * 4) / 4,
      medianActualOverEstimate: r == null ? null : Math.round(r * 100) / 100 };
  });
  return out;
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
 * Confirming a delegate's work is real time, but it is NOT a capacity slice any more
 * (retired 2026-09-17, per Durand: it lives in the Morning Admin / Evening Wrap-Up blocks
 * on the dashboard, costed at reviewPersonMin / reviewClaudeMin from Settings > Capacity).
 * The only review cost the scheduler still reserves is the post-review update session of
 * a Claude item flagged needsApproval (tsgReserveReviewSlices_).
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
// The earliest day a due date can honestly land on, in the script's time zone: today while the
// workday (ends TSG_DAY_END_HM) is still running, otherwise the next workday.
var TSG_DAY_END_HM = '16:30';
// Friday is a 10:00-14:00 day (Durand, 2026-09-21: "friday work hours are 10-2"; capacity stays
// TSG_FRIDAY_CAPACITY). The window, not the capacity, is what these helpers answer.
var TSG_FRIDAY_END_HM = '14:00';
function tsgDayEndHm_(iso) { return tsgIsoDayOfWeek_(iso) === 5 ? TSG_FRIDAY_END_HM : TSG_DAY_END_HM; }
/** The day template's fixed blocks for a date. Friday (Durand: "erands before work on friday, break
 * after, still need lunch"): errands 09:30-10:00, lunch 12-13, relief 14:00-14:20. */
var TSG_FRIDAY_BLOCKS = [[9 * 60 + 30, 10 * 60], [12 * 60, 13 * 60], [14 * 60, 14 * 60 + 20]];
function tsgDayBlocks_(iso) { return tsgIsoDayOfWeek_(iso) === 5 ? TSG_FRIDAY_BLOCKS : TSG_DAY_BLOCKS; }
function tsgEarliestDueIso_(now) {
  var d = now || new Date();
  var iso = tsgIsoDate_(d);
  var hm = Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm');
  if (hm >= tsgDayEndHm_(iso) || !tsgIsWorkdayIso_(iso)) { iso = tsgAddDays_(iso, 1); var guard = 0; while (!tsgIsWorkdayIso_(iso) && guard++ < 7) iso = tsgAddDays_(iso, 1); }
  return iso;
}

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
function tsgIsClaudeDelegate_(s) {
  return String((s && s.delegate) || '').trim().toLowerCase() === 'claude';
}
// REVIEWING DELEGATED WORK IS NOT A CAPACITY SLICE (Durand, 2026-09-17 22:50 EDT: "the review
// delegated work wasn't meant to be a 30 min block each, I was asking to fit into either the
// SOD or EOD administrative block"). The dashboard's Morning Admin / Evening Wrap-Up blocks
// list the delegated items finishing that day, costed per item from meta.capacity
// (reviewPersonMin / reviewClaudeMin, dashboard-side), and stretch or split to hold them.
// Nothing here adds review hours to a roll-up or reserves them on his day any more. The one
// thing that still costs capacity is real work: a Claude step flagged needsApproval gets a
// post-review update session (postReviewUpdateMin) approvalWaitDays workdays after it
// finishes, for the round of changes that follows the approver's notes.
var TSG_CAPACITY_DEFAULTS = { reviewPersonMin: 5, reviewClaudeMin: 5, approvalWaitDays: 1, postReviewUpdateMin: 10 };
var TSG_APPROVAL_WAIT_DAYS = TSG_CAPACITY_DEFAULTS.approvalWaitDays;
var TSG_POST_REVIEW_MIN = TSG_CAPACITY_DEFAULTS.postReviewUpdateMin;
function tsgCapacityNumber_(cap, key) {
  var v = Number(cap && cap[key]);
  return (isFinite(v) && v >= 0) ? v : TSG_CAPACITY_DEFAULTS[key];
}
function tsgReadCapacity_(doc) {
  var cap = (doc && doc.meta && doc.meta.capacity) || {};
  TSG_APPROVAL_WAIT_DAYS = Math.round(tsgCapacityNumber_(cap, 'approvalWaitDays'));
  TSG_POST_REVIEW_MIN = tsgCapacityNumber_(cap, 'postReviewUpdateMin');
}
function tsgPostReviewHours_() { return Math.round(TSG_POST_REVIEW_MIN / 60 * 100) / 100; }
/** The first workday on or after iso (a weekend date moves to Monday). */
function tsgToWorkday_(iso) {
  var d = iso, guard = 0;
  while (!tsgIsWorkdayIso_(d) && guard++ < 7) d = tsgAddDays_(d, 1);
  return d;
}
function tsgAddWorkdays_(iso, n) {
  var d = iso, guard = 0;
  while (n > 0 && guard++ < 60) { d = tsgAddDays_(d, 1); if (tsgIsWorkdayIso_(d)) n--; }
  return d;
}

/**
 * Mirrors the dashboard's subitemBlockedBy() EXACTLY (dashboard_final.html) — same default
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
 * its own share (estHoursOwn) plus all its real open per-subitem hours (2026-09-18 roll-up
 * rule). The old invisible 0.5 h "confirm the handoff" cost is retired (2026-09-17); see
 * tsgOpenSubitemHours_. A done subitem's hours are excluded from the sum —
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
    tsgFlagDueRisk_(t, sub.latestOpenEnd, now);
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
// History retention (2026-09-18). Measured on the live file: 1,328 history lines held 405 KB of
// a 930 KB document, and notes lines alone (whole old + new notes text per line) 231 KB; task
// 289 carried 36 KB of history in 29 lines. Two rules: (1) a from/to value is cut at
// TSG_HISTORY_VALUE_CHARS on every write (the dashboard's history row shows the change, the
// notes themselves live on the item); (2) an item over its cap keeps `created`, the latest line
// per field, the latest PERSON line per field (what tsgUserTouched_ / hand-set protection
// reads) and the newest `low` lines; the rest go to a dated file in the tracker folder's
// History subfolder (tsgArchiveHistory_, called only by processInbox_ before the data write).
var TSG_HISTORY_VALUE_CHARS = 240;
// Hot-file caps (Durand 2026-09-22, "the rest can go to the history": history was 51% of the
// file): 12 lines per open task, 4 per Done task, 4 per step; the archive keeps everything.
var TSG_HISTORY_KEEP = { task: 12, taskLow: 8, done: 4, doneLow: 3, sub: 4, subLow: 3 };
var TSG_HISTORY_FOLDER = 'History';
var TSG_NOTE_VERSIONS_CAP = 300;
/**
 * Truncates history values to TSG_HISTORY_VALUE_CHARS. A NOTES line (field `notes` or
 * `subitem-notes`) whose full text would be cut is first stashed in meta.noteVersions
 * (server-owned) so tsgArchiveHistory_ can write the complete previous note to the History
 * folder on this same pass (Durand 2026-09-22: the tracker holds only the latest polished
 * note, every earlier version goes to the history). The hot file keeps the short line
 * flagged fullInArchive.
 */
function tsgTruncateHistoryValues_(doc) {
  var n = 0;
  doc.meta = doc.meta || {};
  if (!Array.isArray(doc.meta.noteVersions)) doc.meta.noteVersions = [];
  function cut(h, taskId, subIdx) {
    if (!h) return;
    var isNotes = h.field === 'notes' || h.field === 'subitem-notes';
    // A line cut on an earlier pass is CHARS + 1 long (the ellipsis) and must not count as over
    // again: on the first @94 write every old cut line was stashed as a bogus note version.
    var over = ['from', 'to'].filter(function(k) { return typeof h[k] === 'string' && h[k].length > TSG_HISTORY_VALUE_CHARS + 1; });
    if (!over.length) return;
    if (isNotes && !h.fullInArchive) {
      doc.meta.noteVersions.push({ ts: h.ts, taskId: taskId, subIdx: subIdx, field: h.field, source: h.source || null, from: h.from, to: h.to });
      h.fullInArchive = true;
    }
    over.forEach(function(k) { h[k] = h[k].slice(0, TSG_HISTORY_VALUE_CHARS) + '…'; n++; });
  }
  (doc && doc.tasks || []).forEach(function(t) {
    (t.history || []).forEach(function(h) { cut(h, t.id, null); });
    (t.subitems || []).forEach(function(s, i) { (s && s.history || []).forEach(function(h) { cut(h, t.id, i); }); });
  });
  if (doc.meta.noteVersions.length > TSG_NOTE_VERSIONS_CAP) {
    Logger.log('[history] noteVersions over cap (' + doc.meta.noteVersions.length + '); dropping the oldest, the archive write must be failing');
    doc.meta.noteVersions = doc.meta.noteVersions.slice(-TSG_NOTE_VERSIONS_CAP);
  }
  return n;
}
/** Which lines of one history to keep / prune; null when the item is within its cap or nothing would go. */
function tsgHistoryKeepPlan_(hist, cap, low) {
  if (!Array.isArray(hist) || hist.length <= cap) return null;
  var keepIdx = {}, latestByField = {}, latestPersonByField = {};
  hist.forEach(function(h, i) {
    if (!h) return;
    if (h.field === 'created') keepIdx[i] = 1;
    latestByField[h.field] = i;
    if (tsgIsPersonSource_(h.source)) latestPersonByField[h.field] = i;
  });
  Object.keys(latestByField).forEach(function(f) { keepIdx[latestByField[f]] = 1; });
  Object.keys(latestPersonByField).forEach(function(f) { keepIdx[latestPersonByField[f]] = 1; });
  for (var i = Math.max(0, hist.length - low); i < hist.length; i++) keepIdx[i] = 1;
  var keep = [], pruned = [];
  hist.forEach(function(h, i) { (keepIdx[i] ? keep : pruned).push(h); });
  return pruned.length ? { keep: keep, pruned: pruned } : null;
}
function tsgHistoryFolder_() {
  var parent = DriveApp.getFolderById(TRACKER_FOLDER_ID);
  var it = parent.getFoldersByName(TSG_HISTORY_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(TSG_HISTORY_FOLDER);
}
/**
 * RULESETS HISTORY (Durand, 2026-09-22: "only the latest instructions should be in the tracker,
 * history logged separately, same as notes"). The hot Rulesets file keeps each set's current
 * text plus the newest TSG_RULESETS_HISTORY_KEEP changelog lines per target (so "Last pushed"
 * and the latest summaries still show); everything older moves to
 * History/rulesets-history-<ISO>.json on the same write. Writes the archive FIRST; a throw
 * prunes nothing. Counts in rulesets meta.historyArchive.
 */
var TSG_RULESETS_HISTORY_KEEP = 3;
function tsgArchiveRulesetsHistory_(rs, now) {
  if (!rs) return 0;
  tsgMigrateWorkstreams_(rs);
  var K = TSG_RULESETS_HISTORY_KEEP, pruned = { history: [], workstreams: {} }, lines = 0;
  var top = Array.isArray(rs.history) ? rs.history : [];
  var keepTop = [], byTarget = {};
  // Top-level changelog: newest K per target (category), oldest lines archived.
  for (var i = top.length - 1; i >= 0; i--) {
    var h = top[i], tg = (h && h.target) || '';
    byTarget[tg] = (byTarget[tg] || 0) + 1;
    if (byTarget[tg] <= K) keepTop.unshift(h); else pruned.history.unshift(h);
  }
  var wsKeep = {}, wss = rs.workstreams || {};
  Object.keys(wss).forEach(function(name) {
    var ws = wss[name]; if (!ws || !Array.isArray(ws.history)) return;
    if (ws.history.length > K) { pruned.workstreams[name] = ws.history.slice(0, ws.history.length - K); wsKeep[name] = ws.history.slice(-K); }
  });
  // Session entries past a workstream's cap (record_session stashed them, keyed by id).
  var stash = (rs.meta && rs.meta.sessionArchiveStash) || null;
  var sessionLines = stash ? Object.keys(stash).reduce(function(a, k) { return a + ((stash[k] || []).length); }, 0) : 0;
  lines = pruned.history.length + Object.keys(pruned.workstreams).reduce(function(a, n) { return a + pruned.workstreams[n].length; }, 0);
  if (!lines && !sessionLines) return 0;
  var payload = { archivedAt: now, kind: 'rulesets-history', docVersion: rs.meta && rs.meta.docVersion, history: pruned.history, workstreams: pruned.workstreams };
  if (sessionLines) payload.sessions = stash;
  var file = tsgHistoryFolder_().createFile('rulesets-history-' + String(now).replace(/[:.]/g, '-') + '.json', JSON.stringify(payload), 'application/json');
  rs.history = keepTop;
  Object.keys(wsKeep).forEach(function(name) { wss[name].history = wsKeep[name]; });
  rs.meta = rs.meta || {};
  if (sessionLines) delete rs.meta.sessionArchiveStash;
  var prev = rs.meta.historyArchive || {};
  rs.meta.historyArchive = { lastAt: now, files: (prev.files || 0) + 1, lines: (prev.lines || 0) + lines, lastFile: file && file.getName ? file.getName() : undefined };
  if (sessionLines || prev.sessions) rs.meta.historyArchive.sessions = (prev.sessions || 0) + sessionLines;
  return lines + sessionLines;
}
/** Prunes over-cap histories into one dated archive file. Writes the archive FIRST; a throw prunes nothing. */
function tsgArchiveHistory_(doc, now) {
  var K = TSG_HISTORY_KEEP, items = [];
  (doc && doc.tasks || []).forEach(function(t) {
    if (!t) return;
    var done = t.status === 'Done' || t.status === 'Cancelled';
    var plan = tsgHistoryKeepPlan_(t.history, done ? K.done : K.task, done ? K.doneLow : K.taskLow);
    if (plan) items.push({ ref: t, taskId: t.id, subIdx: null, title: t.title, plan: plan });
    (t.subitems || []).forEach(function(s, i) {
      if (!s) return;
      var p = tsgHistoryKeepPlan_(s.history, K.sub, K.subLow);
      if (p) items.push({ ref: s, taskId: t.id, subIdx: i, title: s.title, plan: p });
    });
  });
  var noteVersions = (doc && doc.meta && Array.isArray(doc.meta.noteVersions)) ? doc.meta.noteVersions : [];
  if (!items.length && !noteVersions.length) return 0;
  var lines = items.reduce(function(a, it) { return a + it.plan.pruned.length; }, 0);
  var payload = { archivedAt: now, backendVersion: TSG_CODE_VERSION, lines: lines,
    items: items.map(function(it) { return { taskId: it.taskId, subIdx: it.subIdx, title: it.title, lines: it.plan.pruned }; }),
    noteVersions: noteVersions };
  var file = tsgHistoryFolder_().createFile('history-' + String(now).replace(/[:.]/g, '-') + '.json', JSON.stringify(payload), 'application/json');
  items.forEach(function(it) { it.ref.history = it.plan.keep; });
  doc.meta = doc.meta || {};
  doc.meta.noteVersions = [];
  var prev = doc.meta.historyArchive || {};
  doc.meta.historyArchive = { lastAt: now, files: (prev.files || 0) + 1, lines: (prev.lines || 0) + lines, noteVersions: (prev.noteVersions || 0) + noteVersions.length, lastFile: file && file.getName ? file.getName() : undefined };
  Logger.log('[history] ' + lines + ' line(s) from ' + items.length + ' item(s) archived');
  return lines;
}
function tsgPurgeBogusRollupTagHistory_(doc) {
  (doc.tasks || []).forEach(function(t) {
    if (!Array.isArray(t.history)) return;
    t.history = t.history.filter(function(h) { return !(h && h.source === 'rollup' && h.field === 'tags'); });
  });
}

/**
 * Hours still open under a task: every not-done subitem's estHours (plus, for a Claude step
 * flagged needsApproval, its post-review update session). The old invisible 0.5 h "confirm the
 * handoff" cost per delegated step is gone (2026-09-17): reviewing delegated work is an item
 * in the dashboard's admin blocks, not hours on the task.
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
    if (!s.done && !tsgIsPendingStatus_(s)) {
      if (s.estHours != null && !isNaN(s.estHours)) hours += Number(s.estHours);
      if (tsgIsClaudeDelegate_(s) && s.needsApproval) hours += tsgPostReviewHours_(); // post-approval update session (real work; Settings > Capacity)
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
  // A date set by hand (dueOverride) is the real due date and stays put even when the steps
  // run past it; tsgFlagDueRisk_ marks that case instead of moving the date (2026-09-18, per
  // Durand's rule: flag a due date that cannot be met, never quietly force it).
  if (t.dueOverride && t.timelineEnd) return t.timelineEnd;
  return latestOpenEnd;
}

/**
 * The gap between a hand-set due date and where the open steps actually end. Sets/clears the
 * reserved tag 'At Risk' and `realisticEnd` (the latest open step's end) with a history line
 * each way, so the card shows the risk without the real date being changed.
 */
function tsgFlagDueRisk_(t, latestOpenEnd, now) {
  var atRisk = !!(t.dueOverride && t.timelineEnd && latestOpenEnd && latestOpenEnd > t.timelineEnd);
  var tags = Array.isArray(t.tags) ? t.tags : [];
  var had = tags.indexOf('At Risk') !== -1;
  t.history = t.history || [];
  // A dependency flag (tsgAlignDependencies_) owns the tag while it holds; the later of the two
  // realistic ends is shown.
  var depRisk = t.dependencyRisk && t.dependencyRisk.realisticEnd;
  if (atRisk) {
    var target = (depRisk && depRisk > latestOpenEnd) ? depRisk : latestOpenEnd;
    var changed = !had || t.realisticEnd !== target;
    t.realisticEnd = target;
    if (!had) t.tags = tags.concat(['At Risk']);
    if (changed && now) t.history.push({ ts: now, field: 'at-risk', from: t.timelineEnd, to: latestOpenEnd, source: 'rollup',
      note: 'open steps run to ' + latestOpenEnd + ', past the due date ' + t.timelineEnd });
  } else if (depRisk) {
    if (!had) t.tags = tags.concat(['At Risk']);
    t.realisticEnd = depRisk;
  } else if (had || t.realisticEnd) {
    t.tags = tags.filter(function(tg) { return tg !== 'At Risk'; });
    delete t.realisticEnd;
    if (now) t.history.push({ ts: now, field: 'at-risk', from: 'At Risk', to: null, source: 'rollup', note: 'steps fit before the due date again' });
  }
}

/**
 * Dependencies and due dates always align (2026-09-18, per Durand: "shouldn't you fix it by
 * ensuring they do align always"). Runs on EVERY write: a dependent task whose span would
 * start on or before the end of a task it depends on is pushed forward so it starts on the
 * next workday after that end, whoever moved the date (a dashboard edit, the Routine, an
 * enrich answer, an inbox patch, the scheduler). The end lands on a workday; scheduledStart
 * and every OPEN step move by the same number of days so the step roll-up agrees on the next
 * write; the move is logged as `due` with source 'Dependency' and the predecessor's title.
 * A predecessor that is Done/Cancelled or has no date does not constrain; its At Risk
 * `realisticEnd` counts when later than its date. Chains settle by iterating to a fixed
 * point (cycles are cut by the loop cap). Returns the number of tasks moved.
 */
function tsgAlignDependencies_(doc, now) {
  var tasks = (doc && doc.tasks) || [];
  var byId = {};
  tasks.forEach(function(t) { if (t && t.id != null) byId[t.id] = t; });
  function isOpen(t) { return t && t.status !== 'Done' && t.status !== 'Cancelled'; }
  function predEnd(p) {
    var e = p.timelineEnd || '';
    if (p.realisticEnd && p.realisticEnd > e) e = p.realisticEnd;
    return e;
  }
  // Shared helpers (audit 2026-09-22): tsgAddWorkdays_(iso, 1) is the next workday after iso,
  // tsgToWorkday_ the first workday on or after it, tsgDaysBetweenIso_ the calendar-day gap.
  var nextWorkdayAfter = function(iso) { return tsgAddWorkdays_(iso, 1); };
  var toWorkday = tsgToWorkday_;
  var daysBetween = tsgDaysBetweenIso_;
  var moved = 0, changed = true, guard = 0, stillFlagged = {};
  while (changed && guard++ < 50) {
    changed = false;
    tasks.forEach(function(dep) {
      if (!isOpen(dep) || !dep.timelineEnd) return;
      tsgDependsList_(dep).forEach(function(id) {
        var pred = byId[id];
        if (!pred || pred === dep || !isOpen(pred)) return;
        var end = predEnd(pred);
        if (!end) return;
        var span = tsgScheduledSpan_(dep);
        var start = span ? span.start : dep.timelineEnd;
        if (start > end) return;
        var newStart = nextWorkdayAfter(end);
        var shift = daysBetween(start, newStart);
        if (shift <= 0) return;
        // Shift by the start; every moved date is then nudged off a weekend.
        var before = dep.timelineEnd;
        var newEnd = toWorkday(tsgAddDays_(before, shift));
        if (dep.dueOverride) {
          // A hand-set date is never moved (per Durand: "flag on hand set instead"): the task is
          // tagged At Risk with the date it would need, and the flag clears once it fits again.
          var prev = dep.dependencyRisk;
          if (!prev || prev.realisticEnd < newEnd) dep.dependencyRisk = { predId: pred.id, predEnd: end, realisticEnd: newEnd };
          if (!dep.realisticEnd || dep.realisticEnd < newEnd) dep.realisticEnd = newEnd;
          var tags = Array.isArray(dep.tags) ? dep.tags : [];
          if (tags.indexOf('At Risk') === -1) dep.tags = tags.concat(['At Risk']);
          if (!prev || prev.realisticEnd !== newEnd || prev.predId !== pred.id) {
            dep.history = dep.history || [];
            dep.history.push({ ts: now || new Date().toISOString(), field: 'at-risk', from: before, to: newEnd, source: 'Dependency',
              note: 'due date kept; it falls before "' + (pred.title || ('#' + pred.id)) + '" ends on ' + end + ', so the realistic end is ' + newEnd });
          }
          stillFlagged[dep.id] = true;
          return;
        }
        dep.timelineEnd = newEnd;
        if (dep.scheduledStart) dep.scheduledStart = newStart;
        if (Array.isArray(dep.scheduledDays)) dep.scheduledDays = dep.scheduledDays.map(function(d) { return toWorkday(tsgAddDays_(d, shift)); });
        (dep.subitems || []).forEach(function(st) {
          if (!st || st.done || st.status === 'Done' || !st.timelineEnd) return;
          st.timelineEnd = toWorkday(tsgAddDays_(st.timelineEnd, shift));
        });
        if (dep.realisticEnd) dep.realisticEnd = toWorkday(tsgAddDays_(dep.realisticEnd, shift));
        dep.history = dep.history || [];
        dep.history.push({ ts: now || new Date().toISOString(), field: 'due', from: before, to: newEnd, source: 'Dependency',
          note: 'moved to start after "' + (pred.title || ('#' + pred.id)) + '" ends on ' + end });
        moved++; changed = true;
      });
    });
  }
  // A dependency flag that no longer holds clears; the At Risk tag and realisticEnd stay only
  // while the task's own steps still run past its date (tsgFlagDueRisk_'s case).
  tasks.forEach(function(t) {
    if (!t || !t.dependencyRisk || stillFlagged[t.id]) return;
    var was = t.dependencyRisk.realisticEnd;
    delete t.dependencyRisk;
    var latest = tsgOpenSubitemHours_(t).latestOpenEnd;
    var stepsRisk = !!(t.dueOverride && t.timelineEnd && latest && latest > t.timelineEnd);
    if (stepsRisk) { t.realisticEnd = latest; return; }
    t.tags = (Array.isArray(t.tags) ? t.tags : []).filter(function(tg) { return tg !== 'At Risk'; });
    delete t.realisticEnd;
    t.history = t.history || [];
    t.history.push({ ts: now || new Date().toISOString(), field: 'at-risk', from: was, to: null, source: 'Dependency', note: 'the date fits after its dependencies again' });
  });
  return moved;
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
 * Reserves the post-review update session (postReviewUpdateMin, approvalWaitDays workdays
 * after the finish) of a Claude item flagged needsApproval in Durand's daily capacity pool
 * (the same dateLoad pool his real work draws from). The old 0.5 h "confirm the handoff"
 * slice is retired (2026-09-17). Never creates a work item or subitem; it only debits the
 * shared capacity pool so later placement decisions in this same run correctly see
 * that slice of Durand's day as already spoken for. No-ops if the finish date is in the
 * past relative to today (nothing to reserve for a handoff that already happened).
 */
function tsgReserveConfirmCapacity_(addLoad, today, finishIso, hours, sameDay) {
  if (!finishIso) return;
  var h = (typeof hours === 'number') ? hours : 0.5;
  if (!(h > 0)) return;
  var d = sameDay ? finishIso : tsgAddDays_(finishIso, 1);
  var guard = 0;
  while (!tsgIsWorkdayIso_(d) && guard++ < 14) d = tsgAddDays_(d, 1);
  if (d >= today) addLoad(d, h);
}
// What a finished non-Durand item still puts on Durand's day: only the post-review update
// session of a Claude item flagged needsApproval, approvalWaitDays workdays after it finishes.
// Reviewing the work itself is an admin-block item on the dashboard, never a capacity slice.
function tsgReserveReviewSlices_(addLoad, today, finishIso, item, whole) {
  if (!finishIso || !item || !item.needsApproval) return;
  var claude = whole ? String(tsgTaskDelegate_(item) || '').trim().toLowerCase() === 'claude' : tsgIsClaudeDelegate_(item);
  if (!claude) return;
  tsgReserveConfirmCapacity_(addLoad, today, tsgAddWorkdays_(finishIso, TSG_APPROVAL_WAIT_DAYS), tsgPostReviewHours_(), true);
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
      if (s.done || tsgIsPendingStatus_(s) || tsgIsFeedbackStep_(s)) return;
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
    if (t.feedbackFor) return;   // a standing collection task is never "aging" (2026-09-23)
    if (tsgIsFubTask_(t)) return;   // FUB owns its own follow-up cadence (2026-09-24)
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
  // Which backend wrote this document: a session reads it to know which ops the DEPLOYED
  // script accepts before sending them (2026-09-18).
  if (doc && doc.meta) doc.meta.backendVersion = TSG_CODE_VERSION;
  tsgReadCapacity_(doc);
  try { tsgIndexReminders_(doc); } catch (remErr) { Logger.log('[reminders] index failed: ' + remErr.message); }
  var tasks = doc.tasks || [];

  // Transient, recomputed from scratch each run: a warning from a previous pass must not
  // linger after the condition clears.
  if (doc.meta) delete doc.meta._scheduleWarning;

  tsgPurgeBogusRollupTagHistory_(doc);
  tsgTruncateHistoryValues_(doc);
  tsgCompactJudgments_(doc);
  tsgMigrateAssigneeToDelegate_(doc);
  tsgMigrateDocToDocs_(doc);
  tsgNormalizeTaskShapes_(doc);
  tsgApplyDelegateApproval_(doc);
  try { tsgSyncFeedbackImplementations_(doc, new Date().toISOString()); } catch (fbErr) { Logger.log('[feedback] sync failed: ' + fbErr.message); }
  tsgFlagNeedsDurand_(doc, new Date().toISOString());
  tsgRollupSubitemHours_(doc, new Date().toISOString());
  tsgApplyTravelTimes_(doc);
  tsgFlagAgingTasks_(doc, tsgTodayIso_());
  tsgAlignDependencies_(doc, new Date().toISOString());

  var allItems = [];
  tasks.forEach(function(t) {
    if (t.status === 'Done' || t.status === 'Cancelled' || tsgIsPendingStatus_(t)) return;
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
      // it's already scheduled from an earlier run and needs approval, its post-review
      // update session still needs to be reserved on his calendar, same as a freshly
      // placed one below.
      var existingSpan = tsgScheduledSpan_(r);
      if (existingSpan) tsgReserveReviewSlices_(addLoad, today, existingSpan.end, r, false);
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
    var events = tsgCachedJson_('calHours:' + today, 300, function() { return getCalendarHours_(today, tsgAddDays_(today, 120)); });
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
    var oooDates = tsgCachedJson_('oooDates:' + today, 300, function() { return tsgGetOOODates_(today, tsgAddDays_(today, 120)); });
    oooDates.forEach(function(d) { if (d >= today) addLoad(d, tsgDayCapacity_(d)); });
  } catch (err) { /* calendar unavailable this run — proceed without it */ }

  var rank = TSG_PRIORITY_RANK;
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
        // A step waits for the one before it, but may start the SAME day that one ends: the
        // capacity check below decides whether anything is left of that day. Until 2026-09-18
        // this added a day, so seven ten-minute steps spread across seven workdays and dragged
        // the parent past its real deadline (task 289, per Durand: "fix the step chaining so
        // steps land before the parent due date").
        if (sib.timelineEnd && sib.timelineEnd > earliest) earliest = sib.timelineEnd;
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
      if (!isDurandWork) tsgReserveReviewSlices_(addLoad, today, t.timelineEnd, t, true);
    } else {
      // A subitem: the auto-scheduled note goes on the parent task by design (the parent's
      // history is where scheduling is read), naming which subitem it was. Nothing outside its own task ever
      // depends on it, so it never needs a finishDate[] entry of its own — the next
      // step in its chain reads its timelineEnd directly off this same object.
      item.parent.history = item.parent.history || [];
      item.parent.history.push({ ts: new Date().toISOString(), field: 'subitem-scheduled', from: null,
        to: 'Auto-scheduled ' + item.label + ' for ' + t.timelineEnd, note: 'auto-scheduled' });
      if (!isDurandWork) {
        // Freshly placed non-Durand step — reserve its confirm slice (0.5 h for a person, the
        // Settings review minutes for Claude) on Durand's capacity pool now, so any items still
        // left in the queue this same run see that slice of his day as already spoken for.
        tsgReserveReviewSlices_(addLoad, today, t.timelineEnd, t, false);
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
  // Placement and the roll-up above may have dated a predecessor later than a dependent.
  tsgAlignDependencies_(doc, new Date().toISOString());

  return placed;
}
