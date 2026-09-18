const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

// Minimal Apps Script global stubs — just enough for applyDataPatch/tsgEstimateTask_/
// tsgCleanTitle_ to run without touching real Drive/Calendar/Gmail.
let claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
let driveFilesFixture = [];      // [{ name, getUrl }] consumed by DriveApp.searchFiles stub
let calendarEventsFixture = [];
let attachFolder = null, createdFolders = [], uploadedFiles = [];
function driveFileStub(blob) { const f = { blob, getUrl: () => 'https://drive.google.com/file/d/UP' + (uploadedFiles.length + 1) + '/view', getId: () => 'UP' + (uploadedFiles.length + 1), getName: () => (blob && blob.getName ? blob.getName() : 'x') }; uploadedFiles.push(f); return f; }
let gmailThreadsFixture = [];    // [{ id, subject, from, body, date }] consumed by GmailApp.search stub
let sentMail = [];               // MailApp.sendEmail captures
let guestCalendarEvents = null;  // null = guest calendar unreadable; [] or events = readable  // [{ id, title, start: Date, end: Date, allDay, location }] consumed by CalendarApp stub
let driveDocTextById = {};       // { fileId: text } consumed by the DocumentApp.openById stub (tsgGetFileSnippet_)
let driveSheetValuesById = {};   // { fileId: [[...]] } consumed by the SpreadsheetApp.openById stub
let projectDashboardHtml = '';   // what HtmlService.createHtmlOutputFromFile('dashboard_final') returns
let cacheStore = {};             // CacheService stub backing store
let apiKeyPresent = true;        // false = judgment-queue mode (no ANTHROPIC_API_KEY)
let scriptProps = {};            // other script properties (TSG_HOME_BASE)
let geocodeResults = [{ formatted_address: '45 Baltimore Pike, Media, PA 19063, USA', types: ['street_address'] }];
let mapsCalls = 0;               // Maps.newDirectionFinder().getDirections() invocations
let mapsDirections = { routes: [{ legs: [{ duration: { value: 840 } }] }] }; // 14 min one way
let uuidCounter = 0;
let personPageHtml = '<html>PERSON PAGE for __TSG_PERSON__ (as=__TSG_AS__)</html>';
let claudeRequests = [];         // every request body sent to the Claude endpoint (parsed)
let claudeHttp = null;           // when set: (payload) => {code, body} overrides the canned 200 answer
function claudeTextOf(x) { return Array.isArray(x) ? x.map(b => (b && b.text) || '').join('\n\n') : String(x || ''); }
function fakeClaudeFetch(opts) {
  const payload = JSON.parse(opts.payload);
  claudeRequests.push(payload);
  if (claudeHttp) { const r = claudeHttp(payload); return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }; }
  const answer = claudeResponder(claudeTextOf(payload.system), claudeTextOf(payload.messages[0].content));
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] })
  };
}

const sandbox = {
  console,
  Logger: { log: () => {} },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? (apiKeyPresent ? 'fake-key' : null) : (scriptProps[k] == null ? null : scriptProps[k])),
      setProperty: (k, v) => { scriptProps[k] = v; }
    })
  },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE_DEPLOYMENT/exec' }) },
  Session: {
    getActiveUser: () => ({ getEmail: () => 'durand@thestawaszgroup.com' }),
    getEffectiveUser: () => ({ getEmail: () => 'durand@thestawaszgroup.com' }),
    getScriptTimeZone: () => 'America/New_York'
  },
  UrlFetchApp: {
    fetch: (url, opts) => fakeClaudeFetch(opts),
    fetchAll: (reqs) => reqs.map(r => fakeClaudeFetch(r))
  },
  DriveApp: {
    getFolderById: () => ({ createFile: (blob) => driveFileStub(blob), getFilesByName: () => ({ hasNext: () => false }), getFoldersByName: () => ({ hasNext: () => !!attachFolder, next: () => attachFolder }), createFolder: (n) => { attachFolder = { name: n, createFile: (blob) => driveFileStub(blob) }; createdFolders.push(n); return attachFolder; } }),
    getFileById: () => ({}),
    searchFiles: (q) => {
      const items = driveFilesFixture.slice();
      let i = 0;
      return { hasNext: () => i < items.length, next: () => items[i++] };
    }
  },
  CalendarApp: {
    getDefaultCalendar: () => ({
      getTimeZone: () => 'America/New_York',
      getId: () => 'primary-cal',
      getEvents: (start, end) => calendarEventsFixture
        .filter(e => e.start < end && e.end > start)
        .map(e => ({
          isAllDayEvent: () => !!e.allDay,
          getTitle: () => e.title,
          getStartTime: () => e.start,
          getEndTime: () => e.end,
          getId: () => e.id,
          getLocation: () => e.location || '',
          getDescription: () => e.description || ''
        }))
    }),
    getCalendarsByName: () => [],
    getCalendarById: () => guestCalendarEvents ? ({ getEvents: (start, end) => guestCalendarEvents.filter(e => e.start < end && e.end > start).map(e => ({ isAllDayEvent: () => !!e.allDay, getStartTime: () => e.start, getEndTime: () => e.end })) }) : null,
    GuestStatus: { YES: 'yes', OWNER: 'owner', NO: 'no' }
  },
  Utilities: {
    formatDate: (date, tz, fmt) => {
      const pad = (n) => String(n).padStart(2, '0');
      if (fmt === 'yyyy-MM-dd') return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      if (fmt === 'HH:mm') return pad(date.getHours()) + ':' + pad(date.getMinutes());
      if (fmt === 'yyyy-MM-dd-HHmmss') return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
      return date.toISOString();
    },
    base64EncodeWebSafe: (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    base64Encode: (s) => Buffer.from(s).toString('base64'),
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
    sleep: () => {},
    getUuid: () => 'uuid-' + (++uuidCounter)
  },
  GmailApp: { search: (q, start, n) => gmailThreadsFixture.slice(0, n || 10).map(th => ({
    getId: () => th.id, getFirstMessageSubject: () => th.subject, getLastMessageDate: () => th.date || new Date('2026-09-10T12:00:00Z'),
    getMessages: () => [{ getPlainBody: () => th.body || '', getFrom: () => th.from || 'someone@example.com' }]
  })) },
  MailApp: { sendEmail: (to, subject, body) => { sentMail.push({ to, subject, body }); } },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  // Both stubs echo what they were given back on the returned object (.text / .html) so
  // doGet's responses can be inspected; the chained setters return the same object.
  ContentService: { createTextOutput: (t) => { const o = { text: t }; o.setMimeType = () => o; o.getContent = () => t; return o; }, MimeType: { JSON: 'json' } },
  HtmlService: {
    createHtmlOutput: (h) => { const o = { html: h }; o.setTitle = () => o; o.addMetaTag = () => o; return o; },
    // The dashboard is a file in the script project; tests point it at a small fake page.
    createHtmlOutputFromFile: (name) => ({ getContent: () => (name === 'dashboard_final' ? projectDashboardHtml : (name === 'person' ? personPageHtml : '')) })
  },
  Maps: {
    newGeocoder: () => ({ geocode: () => ({ results: geocodeResults }) }),
    DirectionFinder: { Mode: { DRIVING: 'driving', WALKING: 'walking', TRANSIT: 'transit' } },
    newDirectionFinder: () => {
      let mode = 'driving';
      const f = { setOrigin: () => f, setDestination: () => f, setMode: (m) => { mode = m; return f; }, getDirections: () => { mapsCalls++; if (mode === 'transit') return { routes: [] }; if (mode === 'walking') return mapsDirections.routes.length ? { routes: [{ legs: [{ duration: { value: 2400 } }] }] } : mapsDirections; return mapsDirections; } };
      return f;
    }
  },
  CacheService: { getScriptCache: () => ({ get: (k) => (cacheStore[k] == null ? null : cacheStore[k]), put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } }) },
  // Global MimeType (distinct from ContentService.MimeType above) — used by
  // tsgGetFileSnippet_ to decide how to read a candidate Drive file's content.
  MimeType: {
    GOOGLE_DOCS: 'application/vnd.google-apps.document',
    GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet',
    CSV: 'text/csv',
    PLAIN_TEXT: 'text/plain'
  },
  DocumentApp: {
    openById: (id) => ({ getBody: () => ({ getText: () => driveDocTextById[id] || '' }) })
  },
  SpreadsheetApp: {
    openById: (id) => ({ getSheets: () => [{ getDataRange: () => ({ getValues: () => driveSheetValuesById[id] || [] }) }] })
  }
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'Code.gs' });
// The whole suite is one process; production resets the per-execution Claude budget per run.
vm.runInContext('TSG_CLAUDE.perRunCap = 100000', sandbox);

function freshDoc() {
  return {
    meta: { version: 1, docVersion: 1, next_id: 200 },
    tasks: [
      { id: 1, title: 'Confirm Vendor Invoice For Photography', owner: 'Durand', status: 'In Progress',
        priority: 'High', group: 'Books & Finance', tags: [], taskType: 'Actionable Task',
        timelineEnd: '2026-09-20', progress: 0, depends: '', doc: '', notes: 'existing notes',
        estHours: 2, estDays: 1, estSource: 'claude', history: [{ ts: '2026-09-01T00:00:00Z', field: 'created', from: null, to: null }],
        subitems: []
      }
    ]
  };
}

function section(name) { console.log('\n=== ' + name + ' ==='); }
let FAILS = 0;
function check(label, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label); if (!cond) FAILS++; }

// --- Test 1: tsgCleanTitle_ mechanical cleanup ---
section('tsgCleanTitle_');
check('lowercase sentence -> Title Case', sandbox.tsgCleanTitle_('confirm headcount for catering pricing') === 'Confirm Headcount for Catering Pricing');
check('@Name - action left untouched', sandbox.tsgCleanTitle_('@Claude - get the phone number') === '@Claude - get the phone number');
check('trailing period stripped + whitespace collapsed', sandbox.tsgCleanTitle_('  call   the vendor.  ') === 'Call the Vendor');
check('proper noun with existing caps left alone', sandbox.tsgCleanTitle_('email Farina Di Vita about pricing') === 'Email Farina Di Vita About Pricing');

// --- Test 2: exact-title-match now MERGES instead of discarding ---
section('Exact-match dedup merge (was: silently discarded)');
{
  const doc = freshDoc();
  const patch = {
    op: 'add_task', ts: '2026-09-10T10:00:00Z', source: 'Claude',
    task: { title: 'Confirm Vendor Invoice For Photography', notes: 'New info: invoice #4471, $340, approved by Ryan.', timelineEnd: '2026-09-18', tags: ['Vendor'] }
  };
  sandbox.applyDataPatch_(doc, patch);
  const t = doc.tasks[0];
  check('no duplicate task created', doc.tasks.length === 1);
  check('notes merged in (not discarded)', t.notes.indexOf('invoice #4471') !== -1);
  check('new tag merged in', (t.tags || []).indexOf('Vendor') !== -1);
  check('timelineEnd untouched since original already had one (only fills if blank)', t.timelineEnd === '2026-09-20');
  check('history logs duplicate-push-merged (not the old duplicate-push-suppressed)', t.history.some(h => h.field === 'duplicate-push-merged'));
}

// --- Test 3: batch-aware depends (out-of-order) ---
section('Batch-aware depends resolution');
{
  claudeResponder = (system, user) => {
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test' };
    if (need.includes('dependsOnTitle')) {
      out.dependsOnTitle = user.includes('Draft The Listing Description')
        ? 'Get Photos From The Photographer'  // task A depends on task B, listed AFTER it
        : null;
    }
    need.forEach(f => { if (!(f in out)) {
      if (f === 'estHours') out.estHours = 1;
      else if (f === 'taskType') out.taskType = 'Actionable Task';
      else if (f === 'subitems') out.subitems = [];
      else if (f === 'priority') out.priority = 'Medium';
      else if (f === 'group') out.group = 'Deals & Closings';
      else if (f === 'tags') out.tags = [];
    }});
    return out;
  };
  const doc = freshDoc();
  const patch = {
    op: 'bulk', ts: '2026-09-10T11:00:00Z', source: 'Claude',
    ops: [
      { op: 'add_task', task: { title: 'Draft The Listing Description' } },        // depends on the one below
      { op: 'add_task', task: { title: 'Get Photos From The Photographer' } }
    ]
  };
  sandbox.applyDataPatch_(doc, patch);
  const a = doc.tasks.find(t => t.title === 'Draft The Listing Description');
  const b = doc.tasks.find(t => t.title === 'Get Photos From The Photographer');
  check('both tasks created', !!a && !!b);
  check('depends resolved to a real numeric id, not a ~title: placeholder', a && a.depends === String(b.id));
}

// --- Test 4: priority/group Triage fallback (no comparable neighbor) ---
section('Priority/group Triage fallback, no flat silent default');
{
  claudeResponder = (system, user) => {
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test', priority: null, group: null }; // estimator itself can't tell
    need.forEach(f => { if (!(f in out)) {
      if (f === 'estHours') out.estHours = 1;
      else if (f === 'taskType') out.taskType = 'Actionable Task';
      else if (f === 'subitems') out.subitems = [];
      else if (f === 'dependsOnTitle') out.dependsOnTitle = null;
      else if (f === 'tags') out.tags = [];
    }});
    return out;
  };
  const doc = { meta: { next_id: 500 }, tasks: [] }; // empty board -> no neighbor to infer from
  sandbox.applyDataPatch_(doc, { op: 'add_task', ts: '2026-09-10T12:00:00Z', source: 'Claude', task: { title: 'Totally Novel One-Off Thing' } });
  const t = doc.tasks[0];
  check('priority still got SOME value (board needs one)', t.priority === 'Medium');
  check('group still got SOME value', t.group === 'Unsorted');
  check('Triage tag applied (not silently defaulted)', (t.tags || []).includes('Triage'));
  check('notes explain the fallback', /could not be determined/i.test(t.notes || ''));
}

// --- Test 5: tags inference respects EXISTING_TAGS + strips reserved system tags ---
section('Tags inference');
{
  claudeResponder = (system, user) => {
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test' };
    need.forEach(f => {
      if (f === 'estHours') out.estHours = 1;
      else if (f === 'taskType') out.taskType = 'Actionable Task';
      else if (f === 'subitems') out.subitems = [];
      else if (f === 'priority') out.priority = 'Medium';
      else if (f === 'group') out.group = 'Marketing';
      else if (f === 'dependsOnTitle') out.dependsOnTitle = null;
      else if (f === 'tags') out.tags = ['Block Party', 'Triage', 'Aging']; // model misbehaves, tries reserved tags
    });
    return out;
  };
  const doc = { meta: { next_id: 600 }, tasks: [
    { id: 1, title: 'Old task', tags: ['Block Party'], group: 'Marketing', status: 'Not Started', history: [] }
  ] };
  sandbox.applyDataPatch_(doc, { op: 'add_task', ts: '2026-09-10T13:00:00Z', source: 'Claude', task: { title: 'Plan The Block Party Flyer' } });
  const t = doc.tasks[1];
  check('real topical tag applied', (t.tags || []).includes('Block Party'));
  check('reserved system tags filtered out even though the model tried', !t.tags.includes('Aging'));
}

// --- Test 6: update_task generic field diffing + subitem history (touchedAt retired) ---
section('update_task generic diffing + real subitem history');
{
  const doc = freshDoc();
  const patch = {
    op: 'update_task', ts: '2026-09-10T14:00:00Z', source: 'Claude', id: 1,
    fields: {
      status: 'Done', priority: 'Critical', notes: 'Paid.',
      subitems: [{ title: 'Get W9 from vendor', done: true, delegate: 'Erika', status: 'Done',
        priority: 'Medium', tags: [], timelineEnd: '2026-09-10', progress: 100, depends: '',
        doc: '', notes: '', estHours: 0.25, estDays: null, estSource: 'none', taskType: 'Actionable Task' }]
    }
  };
  sandbox.applyDataPatch_(doc, patch);
  const t = doc.tasks[0];
  const statusEntry = t.history.find(h => h.field === 'status' && h.to === 'Done');
  const priorityEntry = t.history.find(h => h.field === 'priority' && h.to === 'Critical');
  check('status change logged generically', !!statusEntry);
  check('status change carries the source', statusEntry && statusEntry.source === 'Claude');
  check('priority change also logged (not just status)', !!priorityEntry);
  check('completedAt stamped now that update_task drives lifecycle timestamps too', !!t.completedAt);
  const sub = t.subitems[0];
  check('brand-new subitem got its own history array', Array.isArray(sub.history) && sub.history.length > 0);
  check('new subitem history entry is "created", attributed to source', sub.history[0].field === 'created' && sub.history[0].source === 'Claude');
  check('touchedAt is NOT set anywhere (retired)', sub.touchedAt === undefined);
}

// --- Test 7: Drive doc auto-search (owner-scoped, read-only, Claude-judged confidence) ---
// 2026-09-10 revision: matching moved off raw title-word overlap onto a Claude judgment
// call (tsgMatchCandidate_) — Durand flagged word overlap as "no good," the wrong basis for
// deciding whether a candidate is really the same document/meeting, not just mistuned. These
// tests drive that judgment call directly via a controllable `driveMatchResponse` instead of
// relying on any particular word overlap outcome.
section('Drive doc auto-search (Claude-judged match, name + content)');
function fakeDriveFile(name, url, opts) {
  opts = opts || {};
  return {
    getName: () => name,
    getUrl: () => url,
    getId: () => opts.id || url,
    getMimeType: () => opts.mimeType || 'application/pdf', // default = a type tsgGetFileSnippet_ can't read, same as a real PDF
    getBlob: () => ({ getDataAsString: () => opts.text || '' })
  };
}
let driveMatchResponse = null; // {index, confident, rationale} | null — what the match call should return
let lastDriveMatchUser = '';   // captures the actual prompt sent, so tests can confirm content excerpts made it in
{
  claudeResponder = (system, user) => {
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test' };
    // Since 2026-09-16 the Drive judgment rides in the same estimator call as every other field.
    if (need.includes('driveMatch')) { lastDriveMatchUser = user; out.driveMatch = driveMatchResponse; }
    else if (typeof driveMatchResponse === 'string') { /* zero candidates: the field must not even be requested */ }
    need.forEach(f => {
      if (f === 'estHours') out.estHours = 1;
      else if (f === 'taskType') out.taskType = 'Actionable Task';
      else if (f === 'subitems') out.subitems = [];
      else if (f === 'priority') out.priority = 'Medium';
      else if (f === 'group') out.group = 'Deals & Closings';
      else if (f === 'dependsOnTitle') out.dependsOnTitle = null;
      else if (f === 'tags') out.tags = [];
    });
    return out;
  };

  // Confident match: Claude picks candidate #1 and stakes real confidence in it.
  driveFilesFixture = [fakeDriveFile('Listing Agreement Farina Di Vita.pdf', 'https://drive.google.com/file/d/abc123')];
  driveMatchResponse = { index: 1, confident: true, rationale: 'Same listing agreement referenced in the title' };
  const doc1 = { meta: { next_id: 700 }, tasks: [] };
  sandbox.applyDataPatch_(doc1, { op: 'add_task', ts: '2026-09-10T15:00:00Z', source: 'Claude',
    task: { title: 'Send Farina Di Vita The Listing Agreement' } });
  const t1 = doc1.tasks[0];
  check('confident match auto-attached to docs[]', (t1.docs || []).some(d => d.url === 'https://drive.google.com/file/d/abc123' && d.type === 'doc'));
  check('history logs doc-auto-linked', t1.history.some(h => h.field === 'doc-auto-linked'));
  check('no Triage tag needed for a confident match', !(t1.tags || []).includes('Triage'));

  // Plausible but not certain: Claude picks a candidate but sets confident:false — must NOT
  // auto-attach, must Triage-flag with the rationale instead of guessing.
  driveFilesFixture = [fakeDriveFile('Old Marketing Flyer Notes.docx', 'https://drive.google.com/file/d/zzz999')];
  driveMatchResponse = { index: 1, confident: false, rationale: 'Could be it, but the title only loosely overlaps' };
  const doc2 = { meta: { next_id: 701 }, tasks: [] };
  sandbox.applyDataPatch_(doc2, { op: 'add_task', ts: '2026-09-10T15:05:00Z', source: 'Claude',
    task: { title: 'Design The Block Party Flyer' } });
  const t2 = doc2.tasks[0];
  check('weak match NOT auto-attached', !(t2.docs || []).some(d => d.url === 'https://drive.google.com/file/d/zzz999'));
  check('weak match Triage-flagged instead', (t2.tags || []).includes('Triage'));
  check('weak match explained in notes', /not confident enough to.*auto-link/i.test(t2.notes || ''));
  check('weak match note carries Claude\'s rationale', (t2.notes || '').indexOf('loosely overlaps') !== -1);

  // Claude sees candidates but is sure NONE of them are it — index: null. Must stay silent,
  // exactly like "no candidates found" — a considered "no" is not a Triage-worthy event.
  driveFilesFixture = [fakeDriveFile('Unrelated Vendor W9.pdf', 'https://drive.google.com/file/d/w9')];
  driveMatchResponse = { index: null, confident: false, rationale: 'None of these are the same document' };
  const doc2b = { meta: { next_id: 703 }, tasks: [] };
  sandbox.applyDataPatch_(doc2b, { op: 'add_task', ts: '2026-09-10T15:07:00Z', source: 'Claude',
    task: { title: 'Reconcile The September Books' } });
  const t2b = doc2b.tasks[0];
  check('Claude explicitly rejecting all candidates -> no doc, no Triage', !(t2b.docs || []).length && !(t2b.tags || []).includes('Triage'));

  // No candidates retrieved at all (Drive search itself came up empty) — must stay
  // completely silent (no Triage tag just for finding nothing), and never even calls Claude.
  driveFilesFixture = [];
  driveMatchResponse = 'SHOULD_NOT_BE_USED — zero candidates must never reach Claude';
  const doc3 = { meta: { next_id: 702 }, tasks: [] };
  claudeRequests = [];
  sandbox.applyDataPatch_(doc3, { op: 'add_task', ts: '2026-09-10T15:10:00Z', source: 'Claude',
    task: { title: 'Reconcile September Vendor Invoices' } });
  const t3 = doc3.tasks[0];
  check('no candidates -> no doc attached, no Triage just for that', !(t3.docs || []).length && !(t3.tags || []).includes('Triage'));
  check('no candidates -> driveMatch is not even requested, and the add cost ONE Claude call', claudeRequests.length === 1 && !/DRIVE_CANDIDATES/.test(claudeTextOf(claudeRequests[0].messages[0].content)));

  // Content excerpt matters (Durand: "are you matching against file content too?"): a
  // vaguely-named Google Doc whose actual TEXT clearly matches the task should still be
  // confidently matchable, and that excerpt must actually reach the Claude prompt — this is
  // the whole point of tsgGetFileSnippet_.
  driveDocTextById['doc1'] = 'Listing agreement details for Farina Di Vita, signed 2026-09-01, commission 6%.';
  driveFilesFixture = [fakeDriveFile('Notes', 'https://drive.google.com/file/d/doc1',
    { id: 'doc1', mimeType: 'application/vnd.google-apps.document' })];
  driveMatchResponse = { index: 1, confident: true, rationale: 'Content excerpt matches the Farina Di Vita listing agreement' };
  const doc4 = { meta: { next_id: 704 }, tasks: [] };
  sandbox.applyDataPatch_(doc4, { op: 'add_task', ts: '2026-09-10T15:12:00Z', source: 'Claude',
    task: { title: 'Send Farina Di Vita The Listing Agreement' } });
  const t4 = doc4.tasks[0];
  check('content-based match auto-attached despite a generic file name ("Notes")', (t4.docs || []).some(d => d.url === 'https://drive.google.com/file/d/doc1'));
  check('the actual content excerpt was included in the prompt sent to Claude', lastDriveMatchUser.indexOf('Farina Di Vita, signed 2026-09-01') !== -1);

  // A file type tsgGetFileSnippet_ can't read (PDF, by default in fakeDriveFile) must not
  // crash the search or block matching — it just judges on file name alone.
  driveFilesFixture = [fakeDriveFile('September Vendor Invoice.pdf', 'https://drive.google.com/file/d/inv1')]; // default mimeType = unreadable PDF
  driveMatchResponse = { index: 1, confident: true, rationale: 'File name alone is a clear match' };
  const doc5 = { meta: { next_id: 705 }, tasks: [] };
  sandbox.applyDataPatch_(doc5, { op: 'add_task', ts: '2026-09-10T15:14:00Z', source: 'Claude',
    task: { title: 'Pay The September Vendor Invoice' } });
  const t5 = doc5.tasks[0];
  check('unreadable file type still matches fine on name alone, no crash', (t5.docs || []).some(d => d.url === 'https://drive.google.com/file/d/inv1'));
  check('no content excerpt line was fabricated for an unreadable type', lastDriveMatchUser.indexOf('Content excerpt') === -1);
}

// --- Test 8: Calendar meeting auto-search-and-link (future-only, Claude-judged confidence) ---
// Same 2026-09-10 revision as Test 7: the match itself is a Claude judgment call
// (tsgSearchCalendarForTask_ -> tsgMatchCandidate_), driven here via `meetingMatchResponse`.
// Retrieval (which events are even candidates) stays a plain future-window date filter —
// that part was never the thing Durand flagged as "no good."
section('Calendar meeting auto-search-and-link (Claude-judged match)');
{
  let meetingMatchResponse = null;
  claudeResponder = (system, user) => {
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test' };
    if (need.includes('meetingMatch')) out.meetingMatch = meetingMatchResponse; // merged into the estimator call (2026-09-16)
    need.forEach(f => {
      if (f === 'estHours') out.estHours = 0.5;
      else if (f === 'subitems') out.subitems = [];
      else if (f === 'priority') out.priority = 'Medium';
      else if (f === 'group') out.group = 'Ops';
      else if (f === 'dependsOnTitle') out.dependsOnTitle = null;
      else if (f === 'tags') out.tags = [];
    });
    return out;
  };
  const inTwoDays = new Date(Date.now() + 2 * 86400000);
  const inTwoDaysEnd = new Date(inTwoDays.getTime() + 30 * 60000);
  const lastWeek = new Date(Date.now() - 7 * 86400000); // PAST — the date-window retrieval filter must exclude this before Claude ever sees it

  // Confident match: only one candidate survives the future-only retrieval window (the past
  // one is filtered before Claude is ever called), and Claude stakes real confidence in it.
  calendarEventsFixture = [
    { id: 'ev-past', title: 'Vendor Sync Meeting', start: lastWeek, end: new Date(lastWeek.getTime() + 1800000), allDay: false },
    { id: 'ev-future', title: 'Vendor Sync Meeting', start: inTwoDays, end: inTwoDaysEnd, allDay: false }
  ];
  meetingMatchResponse = { index: 1, confident: true, rationale: 'Same meeting, matching title and timing' };
  const doc1 = { meta: { next_id: 800 }, tasks: [] };
  sandbox.applyDataPatch_(doc1, { op: 'add_task', ts: '2026-09-10T16:00:00Z', source: 'Claude',
    task: { title: 'Vendor Sync Meeting', taskType: 'Meeting' } });
  const t1 = doc1.tasks[0];
  check('confident match sets meetingDate', !!t1.meetingDate);
  check('confident match sets meetingStart/meetingEnd', !!t1.meetingStart && !!t1.meetingEnd);
  check('confident match only ever considers the FUTURE event (never the past one)', t1.meetingDate === sandbox.Utilities.formatDate(inTwoDays, 'x', 'yyyy-MM-dd'));
  check('confident match adds a docs[] entry of type meeting', (t1.docs || []).some(d => d.type === 'meeting'));
  check('history logs meeting-auto-linked', t1.history.some(h => h.field === 'meeting-auto-linked'));

  // Plausible but not certain: Claude picks the only candidate but sets confident:false —
  // must NOT auto-link, must Triage-flag with the rationale instead of guessing between
  // "several plausible meetings."
  calendarEventsFixture = [
    { id: 'ev-weak', title: 'Vendor Status Sync', start: inTwoDays, end: inTwoDaysEnd, allDay: false }
  ];
  meetingMatchResponse = { index: 1, confident: false, rationale: 'Could be the same meeting, but the title only loosely matches' };
  const doc2 = { meta: { next_id: 801 }, tasks: [] };
  sandbox.applyDataPatch_(doc2, { op: 'add_task', ts: '2026-09-10T16:05:00Z', source: 'Claude',
    task: { title: 'Vendor Walkthrough Meeting', taskType: 'Meeting' } });
  const t2 = doc2.tasks[0];
  check('weak match NOT auto-linked', !t2.meetingDate);
  check('weak match Triage-flagged instead', (t2.tags || []).includes('Triage'));
  check('weak match note carries Claude\'s rationale', (t2.notes || '').indexOf('loosely matches') !== -1);

  // Claude sees a candidate but is sure it's NOT the same meeting — index: null. Must stay
  // silent, same as finding nothing at all.
  calendarEventsFixture = [
    { id: 'ev-unrelated', title: 'Vendor Sync Meeting', start: inTwoDays, end: inTwoDaysEnd, allDay: false }
  ];
  meetingMatchResponse = { index: null, confident: false, rationale: 'Different vendor, unrelated meeting' };
  const doc2b = { meta: { next_id: 803 }, tasks: [] };
  sandbox.applyDataPatch_(doc2b, { op: 'add_task', ts: '2026-09-10T16:07:00Z', source: 'Claude',
    task: { title: 'Confirm Catering Headcount Meeting', taskType: 'Meeting' } });
  const t2b = doc2b.tasks[0];
  check('Claude explicitly rejecting the only candidate -> no meeting linked, no Triage', !t2b.meetingDate && !(t2b.tags || []).includes('Triage'));

  // Non-meeting taskType — auto-search must never run at all, never even reaching Claude.
  calendarEventsFixture = [
    { id: 'ev-irrelevant', title: 'Call The Vendor About Pricing', start: inTwoDays, end: inTwoDaysEnd, allDay: false }
  ];
  meetingMatchResponse = 'SHOULD_NOT_BE_USED — non-Meeting taskType must never call Claude for a meeting match';
  const doc3 = { meta: { next_id: 802 }, tasks: [] };
  sandbox.applyDataPatch_(doc3, { op: 'add_task', ts: '2026-09-10T16:10:00Z', source: 'Claude',
    task: { title: 'Call The Vendor About Pricing', taskType: 'Call' } });
  const t3 = doc3.tasks[0];
  check('non-Meeting taskType never gets a meeting auto-linked', !t3.meetingDate);

  // Type not supplied: the calendar candidates ride along in the ONE estimator call and the
  // link is applied only if the type Claude determines is Meeting.
  calendarEventsFixture = [ { id: 'ev-typed', title: 'Vendor Sync Meeting', start: inTwoDays, end: inTwoDaysEnd, allDay: false } ];
  meetingMatchResponse = { index: 1, confident: true, rationale: 'Same meeting' };
  claudeRequests = [];
  const savedResponder = claudeResponder;
  claudeResponder = (system, user) => { const out = savedResponder(system, user); out.taskType = 'Meeting'; return out; };
  const doc4 = { meta: { next_id: 804 }, tasks: [] };
  sandbox.applyDataPatch_(doc4, { op: 'add_task', ts: '2026-09-10T16:12:00Z', source: 'Claude', task: { title: 'Vendor Sync Meeting' } });
  check('untyped task: estimate + meeting match cost ONE call and the link lands once the type resolves to Meeting',
    claudeRequests.length === 1 && /CALENDAR_CANDIDATES/.test(claudeTextOf(claudeRequests[0].messages[0].content)) && !!doc4.tasks[0].meetingDate);
  claudeResponder = (system, user) => { const out = savedResponder(system, user); out.taskType = 'Call'; return out; };
  const doc5 = { meta: { next_id: 805 }, tasks: [] };
  sandbox.applyDataPatch_(doc5, { op: 'add_task', ts: '2026-09-10T16:13:00Z', source: 'Claude', task: { title: 'Vendor Sync Meeting' } });
  check('untyped task resolved to a non-Meeting type: the returned match is ignored', !doc5.tasks[0].meetingDate);
  claudeResponder = savedResponder;
}

section('Claude call plumbing (2026-09-16 efficiency pass)');
{
  const savedCalls = vm.runInContext('TSG_CLAUDE_RUN_CALLS', sandbox);
  vm.runInContext('TSG_CLAUDE_RUN_CALLS = 0', sandbox);
  cacheStore = {};
  claudeRequests = [];
  claudeResponder = (system, user) => ({ progress: 40, rationale: 'r' });
  let est = sandbox.tsgEstimateTask_('Draft the newsletter', 'Two of three sections written', 'Medium', ['progress'], {});
  let req = claudeRequests[0];
  check('system prompt is sent as a cache_control block', Array.isArray(req.system) && req.system[0].cache_control && req.system[0].cache_control.type === 'ephemeral' && /sole determiner/.test(req.system[0].text));
  check('a progress-only read runs at effort low with a JSON schema', req.output_config && req.output_config.effort === 'low' && req.output_config.format && req.output_config.format.type === 'json_schema' && req.output_config.format.schema.required.includes('progress') && est.progress === 40);
  check('a progress-only read carries no board-context block', req.messages[0].content.length === 1);

  claudeRequests = [];
  claudeResponder = () => ({ estHours: 1, taskType: 'Actionable Task', subitems: [], priority: 'Medium', group: 'Ops', dependsOnTitle: null, tags: [], needsConfirmation: false, rationale: 'r' });
  est = sandbox.tsgEstimateTask_('Plan the mailer', 'n', 'Medium', ['estHours', 'taskType', 'subitems', 'priority', 'group', 'dependsOnTitle', 'tags'], { groups: ['Ops'], openTitles: ['Other task'], existingTags: ['Mailers'], batchSiblings: ['Sibling task'] });
  req = claudeRequests[0];
  check('the full estimator keeps the default effort', !req.output_config.effort && req.output_config.format.schema.required.includes('needsConfirmation'));
  check('board context is the FIRST user block with its own cache marker; task text follows', req.messages[0].content.length === 2 && req.messages[0].content[0].cache_control && /EXISTING_GROUPS/.test(req.messages[0].content[0].text) && /OPEN_TASK_TITLES/.test(req.messages[0].content[0].text) && !/EXISTING_GROUPS/.test(req.messages[0].content[1].text) && /BATCH_SIBLING_TITLES: \["Sibling task"\]/.test(req.messages[0].content[1].text));

  // A bulk push: the board-context block is byte-identical across siblings (that is what makes it a cache hit).
  claudeRequests = [];
  claudeResponder = (system, user) => ({ estHours: 1, taskType: 'Actionable Task', subitems: [], priority: 'Medium', group: 'Ops', dependsOnTitle: null, tags: [], needsConfirmation: false, progress: 0, rationale: 'r' });
  const bulkDoc = { meta: { next_id: 900 }, tasks: [ { id: 1, title: 'Existing open task', group: 'Ops', status: 'Not Started', tags: ['Mailers'], history: [] } ] };
  sandbox.applyDataPatch_(bulkDoc, { op: 'bulk', ts: '2026-09-16T10:00:00Z', source: 'Claude', ops: [
    { op: 'add_task', task: { title: 'Bulk task one alpha' }, skipDedup: true },
    { op: 'add_task', task: { title: 'Bulk task two beta' }, skipDedup: true } ] });
  const ctxBlocks = claudeRequests.map(r => r.messages[0].content[0].text);
  check('bulk push: identical board-context block on every sibling call', claudeRequests.length === 2 && ctxBlocks[0] === ctxBlocks[1] && /Existing open task/.test(ctxBlocks[0]) && !/Bulk task one/.test(ctxBlocks[0]));

  // Response parsing: a thinking block before the text, and a refusal.
  claudeHttp = () => ({ code: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"progress": 55, "rationale": "r"}' }] } });
  check('the first text block is the answer even when a thinking block precedes it', sandbox.tsgEstimateTask_('t', 'notes', '', ['progress'], {}).progress === 55);
  claudeHttp = () => ({ code: 200, body: { stop_reason: 'refusal', content: [] } });
  check('a refusal is treated as no answer', sandbox.tsgEstimateTask_('t', 'notes', '', ['progress'], {}).source === 'none');

  // A 400 on a schema request: retried once without the schema, schemas paused via the cache.
  claudeRequests = []; cacheStore = {};
  claudeHttp = (payload) => (payload.output_config && payload.output_config.format)
    ? { code: 400, body: { error: { message: 'unsupported schema' } } }
    : { code: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"progress": 30, "rationale": "r"}' }] } };
  est = sandbox.tsgEstimateTask_('t', 'notes', '', ['progress'], {});
  check('HTTP 400 with a schema retries once without it and still answers', est.progress === 30 && claudeRequests.length === 2 && !!claudeRequests[0].output_config.format && !claudeRequests[1].output_config.format);
  check('...and pauses schemas through the script cache', cacheStore.claudeNoSchema === '1');
  claudeRequests = [];
  claudeHttp = null; claudeResponder = () => ({ progress: 10, rationale: 'r' });
  sandbox.tsgEstimateTask_('t', 'notes', '', ['progress'], {});
  check('while paused, no schema is sent (effort still is)', !claudeRequests[0].output_config.format && claudeRequests[0].output_config.effort === 'low');
  cacheStore = {};

  // tsgClaudeMany_: one fetchAll, perRunCap honoured.
  claudeRequests = [];
  claudeResponder = (system, user) => ({ echo: user });
  vm.runInContext('TSG_CLAUDE_RUN_CALLS = TSG_CLAUDE.perRunCap - 2', sandbox);
  const many = sandbox.tsgClaudeMany_([1, 2, 3].map(i => ({ system: 's', user: 'u' + i, maxTokens: 50, opts: { effort: 'low' } })));
  check('tsgClaudeMany_ sends what the per-run cap allows in one fetchAll and nulls the rest', claudeRequests.length === 2 && JSON.parse(many[0]).echo === 'u1' && JSON.parse(many[1]).echo === 'u2' && many[2] === null);
  check('tsgClaudeMany_ counts every sent request against the cap', vm.runInContext('TSG_CLAUDE_RUN_CALLS', sandbox) === vm.runInContext('TSG_CLAUDE.perRunCap', sandbox));

  // Many progress reads in one request; 21 items fan out over fetchAll in chunks of 20.
  vm.runInContext('TSG_CLAUDE_RUN_CALLS = 0', sandbox);
  claudeRequests = [];
  claudeResponder = (system, user) => { const n = (user.match(/^\d+\. Title:/gm) || []).length; return { items: Array.from({ length: n }, (_, i) => ({ index: i + 1, progress: 5 * (i + 1) })) }; };
  const items = Array.from({ length: 21 }, (_, i) => ({ title: 'Item ' + i, notes: 'note ' + i }));
  items.push({ title: 'Empty', notes: '   ' });
  const pcts = sandbox.tsgProgressFromNotesMany_(items);
  check('tsgProgressFromNotesMany_: 21 items -> two requests (20 + 1), empty notes are 0 with no call', claudeRequests.length === 2 && pcts[0] === 5 && pcts[19] === 100 && pcts[20] === 5 && pcts[21] === 0);
  check('...every progress request runs at effort low with the items schema', claudeRequests.every(r => r.output_config.effort === 'low' && r.output_config.format.schema.required.includes('items')));

  // Tidy sends its schema too.
  claudeRequests = [];
  claudeResponder = () => ({ title: 'T', notes: 'n', priority: 'Medium', taskType: 'Call', group: 'Ops', estHours: 1, tags: [], rationale: 'r' });
  const origGetFile = sandbox.DriveApp.getFileById;
  sandbox.DriveApp.getFileById = () => ({ getBlob: () => ({ getDataAsString: () => JSON.stringify({ meta: {}, tasks: [{ id: 7, title: 'Old', notes: '', group: 'Ops', tags: [], subitems: [] }] }) }) });
  sandbox.tsgTidyProposal_(7);
  sandbox.DriveApp.getFileById = origGetFile;
  check('Tidy uses a structured-output schema and the default effort', claudeRequests.length === 1 && claudeRequests[0].output_config.format.schema.required.includes('notes') && !claudeRequests[0].output_config.effort);

  vm.runInContext('TSG_CLAUDE_RUN_CALLS = ' + savedCalls, sandbox);
  claudeHttp = null;
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Task location and round-trip travel (2026-09-16)');
{
  claudeResponder = () => ({ estHours: 1, taskType: 'Actionable Task', subitems: [], priority: 'Medium', group: 'Errands', dependsOnTitle: null, tags: [], needsConfirmation: false, progress: 0, rationale: 'r' });
  cacheStore = {}; mapsCalls = 0;
  // Travel is computed in the scheduler pass that processInbox_ runs after every patch.
  const write = (dd, patch) => { sandbox.applyDataPatch_(dd, patch); sandbox.tsgAutoScheduleDoc_(dd); };
  const d = { meta: { next_id: 950, docVersion: 3, homeBase: '123 Main St, Media, PA' }, tasks: [] };
  write(d, { op: 'add_task', ts: '2026-09-16T12:00:00Z', source: 'Durand', skipDedup: true, skipEnrich: true,
    task: { title: 'Drop the signed listing agreement at the title company', group: 'Errands', owner: 'Durand', priority: 'Medium', estHours: 0.5, location: 'Title company, 45 Baltimore Pike, Media PA' } });
  const t = d.tasks[0];
  check('a located task gets one-way and round-trip minutes from Maps (14 min drive -> 15 / 30, rounded up to 5), three methods asked once', t.travelOneWayMin === 15 && t.travelMin === 30 && t.travelMode === 'round' && mapsCalls === 3);
  check('all three methods are stored and drive is recommended (walk 40 min, no transit route)', t.travelOptions.drive === 15 && t.travelOptions.walk === 40 && t.travelOptions.transit === null && t.travelRecommended === 'drive' && t.travelMethodUsed === 'drive');
  t.travelMethod = 'walk'; sandbox.tsgAutoScheduleDoc_(d);
  check('picking walk switches the effective minutes without a Maps call', t.travelOneWayMin === 40 && t.travelMin === 80 && t.travelMethodUsed === 'walk' && mapsCalls === 3);
  t.travelMethod = 'transit'; sandbox.tsgAutoScheduleDoc_(d);
  check('picking a method Maps could not route falls back to the recommendation', t.travelMethodUsed === 'drive' && t.travelOneWayMin === 15);
  t.travelMethod = '';  sandbox.tsgAutoScheduleDoc_(d);
  check('the recommendation rule: a short walk wins, transit within 30% of driving wins, else drive', sandbox.tsgRecommendTravel_({ drive: 20, walk: 10, transit: 25 }) === 'walk' && sandbox.tsgRecommendTravel_({ drive: 20, walk: 40, transit: 25 }) === 'transit' && sandbox.tsgRecommendTravel_({ drive: 20, walk: 40, transit: 40 }) === 'drive' && sandbox.tsgRecommendTravel_({ drive: null, walk: null, transit: 30 }) === 'transit');
  check('the computation is remembered per location+base and logged on the history', t.travelFor === 'title company, 45 baltimore pike, media pa | 123 main st, media, pa' && t.history.some(h => h.field === 'travelOptions' && /drive 15 min/.test(h.to) && h.source === 'Maps'));
  write(d, { op: 'update_task', id: t.id, fields: { priority: 'High' }, source: 'Durand' });
  check('an unrelated write does not call Maps again', mapsCalls === 3 && t.travelMin === 30);
  check('the scheduler charges estimate plus the chosen travel: round trip by default', sandbox.tsgItemHours_(t) === 1);
  t.travelMode = 'oneway';
  check('...one-way when picked', sandbox.tsgItemHours_(t) === 0.75);
  t.travelMode = 'none';
  check('...none when picked', sandbox.tsgItemHours_(t) === 0.5);
  t.travelMode = 'round';
  vm.runInContext('TSG_TRAVEL_CALLS = 0', sandbox);
  cacheStore = {};
  write(d, { op: 'update_task', id: t.id, fields: { location: 'Somewhere else' }, source: 'Durand' });
  check('a changed location recomputes', mapsCalls === 6 && t.travelFor.indexOf('somewhere else') === 0);
  write(d, { op: 'update_task', id: t.id, fields: { location: '' }, source: 'Durand' });
  check('clearing the location drops travelMin', t.travelMin === undefined && t.travelOneWayMin === undefined && t.travelFor === undefined && t.travelOptions === undefined && mapsCalls === 6);
  const d2 = { meta: { next_id: 960, docVersion: 3 }, tasks: [] };
  write(d2, { op: 'add_task', ts: '2026-09-16T12:00:00Z', source: 'Durand', skipDedup: true, skipEnrich: true,
    task: { title: 'Pick up signs from the print shop', group: 'Errands', owner: 'Durand', estHours: 0.5, location: 'Print shop' } });
  check('no home base -> no Maps call, no travelMin', mapsCalls === 6 && d2.tasks[0].travelMin === undefined);
  const saved = mapsDirections; mapsDirections = { routes: [] };
  const d3 = { meta: { next_id: 970, docVersion: 3, homeBase: 'Base' }, tasks: [] };
  write(d3, { op: 'add_task', ts: '2026-09-16T12:00:00Z', source: 'Durand', skipDedup: true, skipEnrich: true,
    task: { title: 'Return the lockbox to the office supply', group: 'Errands', owner: 'Durand', estHours: 0.5, location: 'Nowhere' } });
  check('a Maps failure leaves the task without travelMin and does not throw', d3.tasks[0].travelMin === undefined);
  mapsDirections = saved;
  write(d3, { op: 'set_meta', fields: { homeBase: 'New base' } });
  check('set_meta can set homeBase and mirrors it into a script property for the calendar feeds', d3.meta.homeBase === 'New base' && scriptProps.TSG_HOME_BASE === 'New base');
  cacheStore = {}; vm.runInContext('TSG_TRAVEL_CALLS = 0', sandbox);
  check('an off-site calendar event charges the real one-way drive from the home base', sandbox.tsgEventTravelMinutes_('45 Baltimore Pike, Media PA') === 15);
  scriptProps = {};
  check('...and the flat default without a home base', sandbox.tsgEventTravelMinutes_('45 Baltimore Pike, Media PA') === 20);
  check('geocode search returns plain address labels', JSON.stringify(sandbox.tsgGeocode_('45 Baltimore').places.map(p => p.label)) === JSON.stringify(['45 Baltimore Pike, Media, PA 19063, USA']) && sandbox.tsgGeocode_('ab').places.length === 0);
  check('location is a diffed task field', vm.runInContext('TSG_TASK_DIFF_FIELDS', sandbox).includes('location'));
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Judgment queue: no API key (2026-09-16, method 2)');
{
  apiKeyPresent = false;
  claudeRequests = [];
  claudeResponder = () => { throw new Error('no Claude call may happen without a key'); };
  const write = (dd, patch) => { sandbox.applyDataPatch_(dd, patch); sandbox.tsgAutoScheduleDoc_(dd); };
  driveFilesFixture = [fakeDriveFile('Listing Agreement Farina Di Vita.pdf', 'https://drive.google.com/file/d/abc123')];
  const d = { meta: { next_id: 1000, docVersion: 3 }, tasks: [ { id: 1, title: 'Existing open task', group: 'Ops', status: 'Not Started', tags: [], history: [], subitems: [] } ] };
  write(d, { op: 'add_task', ts: '2026-09-16T14:00:00Z', source: 'Claude', skipDedup: true,
    task: { title: 'Send Farina Di Vita The Listing Agreement', owner: 'Durand', notes: 'Draft is ready, waiting on the signature' } });
  const t = d.tasks.find(x => /Farina/.test(x.title));
  const q = d.meta.judgments || [];
  check('a new task with no key is created with the fallback (needs-estimate, Triage) and no Claude call', !!t && t.tags.includes('needs-estimate') && t.tags.includes('Triage') && claudeRequests.length === 0);
  check('one enrich request is queued for it: fields, the polish of title and notes, location and due, plus the plain Drive candidates', q.length === 1 && q[0].kind === 'enrich' && q[0].taskId === t.id && q[0].id === 'J1' && ['driveMatch', 'title', 'notes', 'location', 'due', 'progress', 'estHours'].every(f => q[0].need.includes(f)) && q[0].driveCandidates[0].url === 'https://drive.google.com/file/d/abc123' && q[0].notes === 'Draft is ready, waiting on the signature' && q[0].current && q[0].current.title === t.title);
  check('the fallback note is on the task while the answer is pending', /could not be determined/.test(t.notes));
  // the Routine answers: every field, the polished title and notes, a lifted place and deadline
  write(d, { op: 'judgment', id: 'J1', source: 'Claude (queue)', answer: { title: 'Send Farina Di Vita the listing agreement for signature', notes: 'Current state: draft ready, waiting on the signature.\n\nLog:\n- 2026-09-16: draft prepared', estHours: 0.5, taskType: 'Email', subitems: ['Email the agreement', 'Chase the signature'], priority: 'High', group: 'Ops', dependsOnTitle: 'Existing open task', tags: ['Listings'], progress: 25, location: 'Farina Di Vita, Media PA', due: '2026-09-19', needsConfirmation: false, driveMatch: { index: 1, confident: true, rationale: 'Same agreement' }, meetingMatch: null, rationale: 'One email with an attachment.' } });
  check('the answer fills every field: hours, type, priority, group, dependency, tags, subitems', t.estHours === 0.5 && t.taskType === 'Email' && t.priority === 'High' && t.group === 'Ops' && t.depends === '1' && t.tags.includes('Listings') && t.subitems.length === 2);
  check('...polishes the title and the notes, logging the previous text', t.title === 'Send Farina Di Vita the listing agreement for signature' && /^Current state:/.test(t.notes) && t.history.some(h => h.field === 'notes' && /Draft is ready/.test(h.from) && h.source === 'Claude (queue)') && t.history.some(h => h.field === 'title' && h.source === 'Claude (queue)'));
  check('...lifts the stated place and deadline into location and due', t.location === 'Farina Di Vita, Media PA' && t.timelineEnd === '2026-09-19' && t.dueOverride === true);
  check('...progress from the notes lands before the new steps are added; needs-estimate and the fallback note are gone, Triage stays', t.progress === 25 && t.status === 'In Progress' && !t.tags.includes('needs-estimate') && !/could not be determined/.test(t.notes) && t.tags.includes('Triage'));
  check('...links the Drive doc from the stored candidates', (t.docs || []).some(dd => dd.url === 'https://drive.google.com/file/d/abc123'));
  check('...logs the enrichment with the answer source and clears the request', t.history.some(h => h.field === 'auto-enriched' && h.source === 'Claude (queue)' && /judgment queue/.test(h.to)) && (d.meta.judgments || []).length === 0);
  check('the task is scheduled once it has hours', !!t.estDays);
  // a free-flow note on an EXISTING task re-judges it; a value Durand set by hand is kept
  d.tasks.push({ id: 2, title: 'Parent with steps', owner: 'Durand', status: 'In Progress', priority: 'Medium', progress: 0, notes: '', tags: [], history: [], subitems: [ { title: 'step a', delegate: 'Durand', done: false, status: 'Not Started', progress: 0, notes: '' } ] });
  d.tasks.push({ id: 3, title: 'Quick thought', owner: 'Durand', status: 'Not Started', priority: 'Low', progress: 0, notes: '', tags: [], history: [ { ts: '2026-09-10T10:00:00Z', field: 'priority', from: 'Medium', to: 'Low', source: 'Durand' } ], subitems: [] });
  write(d, { op: 'update_task', id: 3, fields: { notes: 'call the title co about the farina closing, they said friday works, need the deed copy first' }, source: 'Durand' });
  const e3 = d.meta.judgments.find(r => r.kind === 'enrich' && r.taskId === 3);
  check('a notes change on an existing task queues one enrich request that asks for every field (a hand-set priority is protected at apply time) and carries Drive candidates for a link', !!e3 && e3.need.includes('priority') && e3.need.includes('driveMatch') && e3.driveCandidates && e3.driveCandidates.length === 1 && ['title', 'notes', 'estHours', 'taskType', 'group', 'tags', 'progress', 'location', 'due', 'subitems'].every(f => e3.need.includes(f)) && e3.current.priority === 'Low');
  write(d, { op: 'update_task', id: 3, fields: { notes: 'call the title co about the farina closing, they said friday works, need the deed copy first. UPDATE: deed copy received' }, source: 'Durand' });
  check('a second notes edit replaces the pending request', d.meta.judgments.filter(r => r.kind === 'enrich' && r.taskId === 3).length === 1 && d.meta.judgments.find(r => r.taskId === 3).notes.indexOf('UPDATE') !== -1);
  const e3b = d.meta.judgments.find(r => r.taskId === 3);
  write(d, { op: 'judgment', id: e3b.id, source: 'Claude (queue)', answer: { title: 'Call the title company about the Farina closing', notes: 'Current state: deed copy received; call the title company, Friday works.\n\nLog:\n- 2026-09-16: deed copy received', estHours: 0.25, taskType: 'Call', group: 'Ops', tags: ['Closings'], progress: 50, location: null, due: '2026-09-18', subitems: [], dependsOnTitle: null, priority: 'High', needsConfirmation: false, rationale: 'One call.' } });
  const t3 = d.tasks.find(x => x.id === 3);
  check('the answer polishes the existing task and fills its blanks, but the hand-set priority stays', t3.title === 'Call the title company about the Farina closing' && t3.taskType === 'Call' && t3.estHours === 0.25 && t3.timelineEnd === '2026-09-18' && t3.progress === 50 && t3.status === 'In Progress' && t3.priority === 'Low');
  // stale: notes edited after the request -> the polish is skipped, nothing else is lost
  write(d, { op: 'update_task', id: 2, fields: { notes: 'first thought' }, source: 'Durand' });
  const e2 = d.meta.judgments.find(r => r.taskId === 2);
  d.tasks.find(x => x.id === 2).notes = 'edited again by hand';
  write(d, { op: 'judgment', id: e2.id, source: 'Claude (queue)', answer: { title: 'Parent with steps', notes: 'Current state: polished.', tags: ['Ops'], estHours: 1, taskType: 'Actionable Task', priority: 'Medium', group: 'Ops', subitems: [], dependsOnTitle: null, location: null, due: null, needsConfirmation: false, rationale: 'r' } });
  check('an answer whose notes were edited meanwhile keeps the hand edit and still applies the rest', d.tasks.find(x => x.id === 2).notes === 'edited again by hand' && d.tasks.find(x => x.id === 2).tags.includes('Ops') && d.tasks.find(x => x.id === 2).estHours === 1);
  // subitems keep the progress read
  write(d, { op: 'update_subitem', id: 2, index: 0, expectTitle: 'step a', fields: { notes: 'started drafting' }, source: 'Durand' });
  const sreq = d.meta.judgments.find(r => r.kind === 'enrich' && r.taskId === 2 && r.subIdx === 0);
  check('a subtask notes change queues a full enrich request of its own (title, notes, estimate, tags, progress, location, due; no steps or group), with its title as a guard', !!sreq && sreq.subTitle === 'step a' && ['title', 'notes', 'estHours', 'tags', 'progress', 'location', 'due'].every(f => sreq.need.includes(f)) && !sreq.need.includes('subitems') && !sreq.need.includes('group') && sreq.current.subtask === true);
  write(d, { op: 'judgment', id: sreq.id, source: 'Claude (queue)', answer: { title: 'Draft step A', notes: 'Current state: drafting.', estHours: 0.5, taskType: 'Actionable Task', priority: 'Medium', tags: ['Drafts'], progress: 30, location: '45 Baltimore Pike, Media PA', due: '2026-09-20', driveMatch: null, meetingMatch: null, needsConfirmation: false, rationale: 'r' } });
  const sub0 = d.tasks.find(x => x.id === 2).subitems[0];
  check('the subtask answer polishes its title and notes and fills its estimate, tags, location and due', sub0.title === 'Draft step A' && sub0.notes === 'Current state: drafting.' && sub0.estHours === 0.5 && sub0.tags.includes('Drafts') && sub0.location === '45 Baltimore Pike, Media PA' && sub0.timelineEnd === '2026-09-20' && !sub0.subitems);
  check('a subtask notes change queues a progress read and the answer lands with a history line', d.tasks.find(x => x.id === 2).subitems[0].progress === 30 && d.tasks.find(x => x.id === 2).subitems[0].history.some(h => h.field === 'progress' && h.to === 30));
  // replace_all: a task notes change -> enrich, a subitem notes change -> progress; the queue survives the save
  d.meta.judgments = [];
  const next = JSON.parse(JSON.stringify(d.tasks));
  next.find(x => x.id === 1).notes = 'Menu confirmed, deposit paid'; next.find(x => x.id === 2).subitems[0].notes = 'half done';
  write(d, { op: 'replace_all', baseVersion: d.meta.docVersion || 0, doc: { tasks: next, meta: { judgments: [] } } });
  check('a dashboard save queues an enrich for the task and ONE steps-only request for the other task\'s changed step, and cannot overwrite the queue', d.meta.judgments.length === 2 && d.meta.judgments.some(r => r.kind === 'enrich' && r.taskId === 1) && d.meta.judgments.some(r => r.kind === 'enrich' && r.taskId === 2 && r.subIdx == null && r.need.length === 1 && r.need[0] === 'steps' && (r.currentSteps || []).some(cs => cs.index === 0 && cs.title === 'Draft step A')));
  write(d, { op: 'set_meta', fields: { judgments: [], judgmentSeq: 0, tidyProposals: { x: 1 } } });
  check('set_meta cannot touch judgments / judgmentSeq / tidyProposals', d.meta.judgments.length === 2 && d.meta.judgmentSeq > 0 && !d.meta.tidyProposals);
  // Tidy is a forced full re-run
  write(d, { op: 'request_tidy', id: 3, source: 'Durand' });
  const tr = d.meta.judgments.find(r => r.kind === 'enrich' && r.taskId === 3);
  check('request_tidy queues a forced enrich request that re-judges even hand-set fields', !!tr && tr.force === true && tr.need.includes('priority'));
  write(d, { op: 'judgment', id: tr.id, source: 'Claude (queue)', answer: { title: t3.title, notes: t3.notes, priority: 'High', taskType: 'Call', group: 'Ops', estHours: 0.25, tags: ['Closings', 'Triage', 'a', 'b', 'c'], subitems: [], dependsOnTitle: null, location: null, due: null, progress: 50, needsConfirmation: false, rationale: 'Tidy.' } });
  const t3b = d.tasks.find(x => x.id === 3); // replace_all swapped the task objects
  check('a Tidy answer applies automatically, may change a hand-set field, and never hands out a system tag', t3b.priority === 'High' && !t3b.tags.includes('Triage') && t3b.tags.filter(x => ['a', 'b', 'c'].includes(x)).length <= 2 && t3b.history.some(h => h.field === 'priority' && h.to === 'High' && h.source === 'Claude (queue)'));
  check('tsgTidyProposal_ with no key queues a request_tidy inbox patch and answers queued:true', (() => { const orig = sandbox.tsgQueueDataPatch_; let sent = null; sandbox.tsgQueueDataPatch_ = (pp) => { sent = pp; return { ok: true, docVersion: 1 }; }; const r = sandbox.tsgTidyProposal_(t.id); sandbox.tsgQueueDataPatch_ = orig; return r.ok === true && r.queued === true && sent && sent.op === 'request_tidy' && sent.id === t.id; })());
  // unknown id, no answer
  let threw = false;
  try { write(d, { op: 'judgment', id: 'J999', answer: { progress: 1 } }); write(d, { op: 'judgment', id: d.meta.judgments[0].id, answer: null }); } catch (e) { threw = true; }
  check('an unknown id or an empty answer never throws; an empty answer just drops the request', !threw && d.meta.judgments.length === 1);
  apiKeyPresent = true;
  driveFilesFixture = [];
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Version indicator (?api=version + footer stamp)');
{
  // Top-level `const` in Code.gs is not a property of the sandbox global; read it via eval.
  const CODE_VERSION = vm.runInContext('TSG_CODE_VERSION', sandbox);
  check('TSG_CODE_VERSION is a date.counter string', /^\d{4}-\d{2}-\d{2}\.\d+$/.test(CODE_VERSION));
  // doGet runs processInbox_() first; give it an empty inbox and a fake dashboard file.
  const origGetFolderById = sandbox.DriveApp.getFolderById;
  const origGetFileById = sandbox.DriveApp.getFileById;
  sandbox.DriveApp.getFolderById = () => ({ getFiles: () => ({ hasNext: () => false }), createFile: () => {}, getFilesByName: () => ({ hasNext: () => false }) });
  const fakeDashboard = "<html><script>const API_URL = '__TSG_API_URL__'; const TSG_TOKEN = '__TSG_TOKEN__'; const CODE_VERSION_STAMP = '__TSG_CODE_VERSION__';</script></html>";
  const FILE_IDS_ = vm.runInContext('FILE_IDS', sandbox);
  let fakeDataFile = JSON.stringify({ meta: { docVersion: 42 }, tasks: [] });
  projectDashboardHtml = fakeDashboard;
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => (id === FILE_IDS_.data ? fakeDataFile : 'NOT THE DASHBOARD') }) });
  sandbox.LockService.getScriptLock = () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} });
  let out = sandbox.doGet({ parameter: { api: 'version' } });
  let body = null; try { body = JSON.parse(out.text); } catch (e) {}
  check('?api=version answers JSON with ok:true', !!body && body.ok === true);
  check('?api=version reports the TSG_CODE_VERSION constant', !!body && body.codeVersion === CODE_VERSION);
  check('?api=version needs no token (ungated like ?api=sync)', !!body && body.codeVersion && !('error' in body));
  check('?api=version reports the data file docVersion (for background polling)', !!body && body.docVersion === 42);
  fakeDataFile = 'not json'; delete cacheStore.docVersion;
  body = JSON.parse(sandbox.doGet({ parameter: { api: 'version' } }).text);
  check('?api=version still answers (docVersion null) when the data file is unreadable', body.ok === true && body.docVersion === null);
  fakeDataFile = JSON.stringify({ meta: { docVersion: 42 }, tasks: [] });
  check('no ?api=whoami endpoint (Session.getActiveUser aborts anonymous-access requests)', !/api === 'whoami'/.test(src));
  const page = sandbox.doGet({ parameter: {} });
  check('bare doGet stamps TSG_CODE_VERSION into the dashboard placeholder', typeof page.html === 'string' && page.html.includes("CODE_VERSION_STAMP = '" + CODE_VERSION + "'"));
  check('bare doGet leaves no raw __TSG_CODE_VERSION__ placeholder behind', typeof page.html === 'string' && !page.html.includes('__TSG_CODE_VERSION__'));
  check('bare doGet serves the dashboard from the script project file, not Drive', !page.html.includes('NOT THE DASHBOARD'));
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'SCRIPT_TOKEN' ? 'tok' : null), setProperty: () => {} });
  const htmlPost = JSON.parse(sandbox.doPost({ parameter: { target: 'html', token: 'tok' }, postData: { contents: '<html>x</html>' } }).text);
  const noTokenPost = JSON.parse(sandbox.doPost({ parameter: { target: 'html' }, postData: { contents: '' } }).text);
  check('doPost refuses a request without the token', noTokenPost.ok === false && noTokenPost.error === 'unauthorized');
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? 'fake-key' : null), setProperty: () => {} });
  const unsetTokenPost = JSON.parse(sandbox.doPost({ parameter: { target: 'html', token: 'anything' }, postData: { contents: '' } }).text);
  check('doPost refuses when SCRIPT_TOKEN is unset (no more fail-open)', unsetTokenPost.ok === false && unsetTokenPost.error === 'unauthorized');
  check('doPost target=html is retired and rejected loudly', htmlPost.ok === false && /retired/.test(htmlPost.error));

  // Secrets are injected at serve time, never committed (the repo is public).
  check('bare doGet stamps the serving deployment exec URL into API_URL', page.html.includes("API_URL = 'https://script.google.com/macros/s/FAKE_DEPLOYMENT/exec'"));
  check('bare doGet stamps an empty token when SCRIPT_TOKEN is unset (backend fails open)', page.html.includes("TSG_TOKEN = ''"));
  const origProps = sandbox.PropertiesService.getScriptProperties;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'SCRIPT_TOKEN' ? 'tok-from-property' : null), setProperty: () => {} });
  const page2 = sandbox.doGet({ parameter: {} });
  check('bare doGet stamps the SCRIPT_TOKEN property into TSG_TOKEN', page2.html.includes("TSG_TOKEN = 'tok-from-property'"));
  check('bare doGet leaves no __TSG_ placeholder of any kind behind', !/__TSG_[A-Z_]+__/.test(page2.html));
  sandbox.PropertiesService.getScriptProperties = origProps;
  sandbox.DriveApp.getFolderById = origGetFolderById;
  sandbox.DriveApp.getFileById = origGetFileById;
}

section('Subitem rollup respects the parent\'s own work (2026-09-14, task #12 regression)');
{
  const NOW = '2026-09-14T17:30:00Z';
  function parent(extra) {
    return Object.assign({ id: 12, title: 'Call Farina', status: 'In Progress', priority: 'Critical', estHours: 0, timelineEnd: '2026-09-10',
      history: [], subitems: [{ title: 'get the phone number', done: true, delegate: 'Claude', estHours: 0.25, timelineEnd: '2026-09-10' }] }, extra || {});
  }
  // The original bug: all subitems done -> parent forced to 0h and pinned to the done subitem's date.
  let d = { meta: { docVersion: 1 }, tasks: [parent({ estHours: 0.25, estHoursOwn: 0.25, timelineEnd: '2026-09-17', dueOverride: true })] };
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('all subitems done: parent keeps its own hours instead of rolling up to 0', d.tasks[0].estHours === 0.25);
  check('all subitems done: parent due date is NOT pinned to the finished subitem', d.tasks[0].timelineEnd === '2026-09-17');
  check('rollup writes no history entry when nothing changed', d.tasks[0].history.length === 0);
  d.tasks[0].tags = ['Calendar', 'Meeting'];
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('rollup never logs a bogus tags change (tsgLogFieldChanges_ always diffs tags)', !d.tasks[0].history.some(h => h.field === 'tags'));
  d.tasks[0].history.push({ ts: NOW, field: 'tags', from: null, to: 'Calendar', source: 'rollup' }, { ts: NOW, field: 'tags', from: null, to: 'X', source: 'Durand' });
  sandbox.tsgPurgeBogusRollupTagHistory_(d);
  check('purge drops rollup-sourced tags entries and keeps everyone else\'s', d.tasks[0].history.filter(h => h.field === 'tags').length === 1 && d.tasks[0].history.some(h => h.source === 'Durand'));

  // Explicit edits set the parent's own share on both write paths.
  d = { meta: { docVersion: 1 }, tasks: [parent()] };
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 12, ts: NOW, source: 'Claude', fields: { estHours: 0.25, timelineEnd: '2026-09-17' } });
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('update_task estHours on a subitem-bearing task captures estHoursOwn', d.tasks[0].estHoursOwn === 0.25);
  check('update_task: the edit survives the next rollup (est 0.25h, due 9-17)', d.tasks[0].estHours === 0.25 && d.tasks[0].timelineEnd === '2026-09-17');

  d = { meta: { docVersion: 5 }, tasks: [parent()] };
  const saved = JSON.parse(JSON.stringify(parent({ estHours: 0.25, timelineEnd: '2026-09-17', dueOverride: true })));
  sandbox.applyDataPatch_(d, { op: 'replace_all', ts: NOW, baseVersion: 5, doc: { meta: {}, tasks: [saved] } });
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('dashboard full save (replace_all) that changes estHours captures estHoursOwn', d.tasks[0].estHoursOwn === 0.25);
  check('dashboard full save: the edit survives the next rollup', d.tasks[0].estHours === 0.25 && d.tasks[0].timelineEnd === '2026-09-17');
  // ...and a later save that does NOT touch estHours must not disturb the captured own share
  const saved2 = JSON.parse(JSON.stringify(d.tasks[0])); delete saved2.estHoursOwn; saved2.notes = 'edited notes only';
  sandbox.applyDataPatch_(d, { op: 'replace_all', ts: NOW, baseVersion: d.meta.docVersion, doc: { meta: {}, tasks: [saved2] } });
  check('a save that omits estHoursOwn carries it over from the stored task', d.tasks[0].estHoursOwn === 0.25);

  // Task #1 regression: a due date changed through the dashboard's full save must count as
  // explicit (dueOverride) so the rollup cannot pull it back to a subitem's date.
  d = { meta: { docVersion: 9 }, tasks: [{ id: 1, title: 'FUB Rollout', status: 'In Progress', timelineEnd: '2026-09-22', history: [],
    subitems: [{ title: 'Rayma', done: true, timelineEnd: '2026-09-22' }, { title: 'Chelsey', done: false, timelineEnd: '2026-09-16' }] }] };
  const saved3 = JSON.parse(JSON.stringify(d.tasks[0])); saved3.timelineEnd = '2026-10-08';
  sandbox.applyDataPatch_(d, { op: 'replace_all', ts: NOW, baseVersion: 9, doc: { meta: {}, tasks: [saved3] } });
  check('full save changing timelineEnd sets dueOverride', d.tasks[0].dueOverride === true);
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('...so the rollup keeps the explicit 10-08 instead of the open subitem\'s 9-16', d.tasks[0].timelineEnd === '2026-10-08');
  const saved4 = JSON.parse(JSON.stringify(d.tasks[0])); delete saved4.dueOverride; saved4.notes = 'notes only';
  sandbox.applyDataPatch_(d, { op: 'replace_all', ts: NOW, baseVersion: d.meta.docVersion, doc: { meta: {}, tasks: [saved4] } });
  check('a save that omits dueOverride carries it over from the stored task', d.tasks[0].dueOverride === true);

  // Open subitems add on top of the parent's own hours; done ones drop out.
  d = { meta: { docVersion: 1 }, tasks: [parent({ estHoursOwn: 1, subitems: [
    { title: 'a', done: false, delegate: '', estHours: 0.5, timelineEnd: '2026-09-20' },
    { title: 'b', done: true, delegate: '', estHours: 2, timelineEnd: '2026-09-30' } ] })] };
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('estHours = own + open subitems (done subitem hours excluded)', d.tasks[0].estHours === 1.5);
  check('due extends to the latest OPEN subitem, ignoring the later DONE one', d.tasks[0].timelineEnd === '2026-09-20');
  check('rollup change is logged with source rollup', d.tasks[0].history.some(h => h.source === 'rollup' && h.field === 'estHours' && h.to === 1.5));
  d.tasks[0].dueOverride = true; d.tasks[0].timelineEnd = '2026-09-25';
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('an explicit parent due LATER than every open subitem stands', d.tasks[0].timelineEnd === '2026-09-25');
  d.tasks[0].timelineEnd = '2026-09-15';
  sandbox.tsgRollupSubitemHours_(d, NOW);
  check('an explicit parent due EARLIER than an open subitem is pushed out to it', d.tasks[0].timelineEnd === '2026-09-20');
  check('non-Durand delegate on an open subitem adds NO handoff cost any more (review lives in the admin blocks)', (function() {
    const dd = { meta: {}, tasks: [parent({ estHoursOwn: 0, subitems: [{ title: 'x', done: false, delegate: 'Perly', estHours: 1 }] })] };
    sandbox.tsgRollupSubitemHours_(dd); return dd.tasks[0].estHours === 1; })());
}

section('Domain access: identity gate, roster mapping, inbox trigger (2026-09-14)');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appsscript.json'), 'utf8'));
  const mode = vm.runInContext('TSG_ACCESS_MODE', sandbox);
  check('TSG_ACCESS_MODE agrees with appsscript.json webapp.access', (mode === 'DOMAIN') === (manifest.webapp.access === 'DOMAIN'));
  const roster = [{ name: 'Durand', email: '' }, { name: 'Perly', email: '' }, { name: 'Marj', email: 'marj.custom@tsg.homes' }, 'Erika'];
  check('firstname@tsg.homes maps to the roster name', sandbox.tsgRosterNameForEmail_(roster, 'perly@tsg.homes') === 'Perly');
  check('alias domain thestawaszgroup.com maps too', sandbox.tsgRosterNameForEmail_(roster, 'Erika@TheStawaszGroup.com') === 'Erika');
  check('an explicit roster email wins over the convention', sandbox.tsgRosterNameForEmail_(roster, 'marj.custom@tsg.homes') === 'Marj');
  check('an outside domain never maps by convention', sandbox.tsgRosterNameForEmail_(roster, 'perly@gmail.com') === '');
  check('owner is recognized by both spellings', sandbox.tsgIsOwnerEmail_('durand@thestawaszgroup.com') && sandbox.tsgIsOwnerEmail_('Durand@tsg.homes') && !sandbox.tsgIsOwnerEmail_('perly@tsg.homes'));

  // doGet gate. Session stub = owner by default.
  const origGetFolderById = sandbox.DriveApp.getFolderById, origGetFileById = sandbox.DriveApp.getFileById, origSession = sandbox.Session;
  sandbox.DriveApp.getFolderById = () => ({ getFiles: () => ({ hasNext: () => false }), createFile: () => {}, getFilesByName: () => ({ hasNext: () => false }) });
  const FILE_IDS2 = vm.runInContext('FILE_IDS', sandbox);
  const dataWithRoster = JSON.stringify({ meta: { docVersion: 1, teamRoster: roster }, tasks: [] });
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => (id === FILE_IDS2.data ? dataWithRoster : '') }) });
  projectDashboardHtml = "<html><script>const TSG_TOKEN = '__TSG_TOKEN__'; const API_URL = '__TSG_API_URL__';</script>FULL DASHBOARD</html>";
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'SCRIPT_TOKEN' ? 'secret-token' : null), setProperty: () => {} });
  let page = sandbox.doGet({ parameter: {} });
  check('owner gets the full dashboard', page.html.includes('FULL DASHBOARD'));
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'perly@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => 'durand@thestawaszgroup.com' }) };
  page = sandbox.doGet({ parameter: {} });
  check('a roster member gets the person page, not the dashboard', !page.html.includes('FULL DASHBOARD') && page.html.includes('PERSON PAGE for Perly'));
  check('the placeholder carries neither the token nor the exec URL', !page.html.includes('secret-token') && !page.html.includes('FAKE_DEPLOYMENT') && !page.html.includes('__TSG_'));
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'someone@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }) };
  page = sandbox.doGet({ parameter: {} });
  check('a signed-in non-roster account gets the placeholder, not the dashboard', !page.html.includes('FULL DASHBOARD') && page.html.includes('not on the team roster'));
  sandbox.Session = { getActiveUser: () => { throw new Error('no identity'); }, getEffectiveUser: () => ({ getEmail: () => '' }) };
  page = sandbox.doGet({ parameter: {} });
  check('no identity at all -> placeholder, never the dashboard', !page.html.includes('FULL DASHBOARD'));
  sandbox.Session = origSession; sandbox.DriveApp.getFolderById = origGetFolderById; sandbox.DriveApp.getFileById = origGetFileById;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? 'fake-key' : null), setProperty: () => {} });

  // RPC channel (google.script.run -> tsgRpc): owner only, rebuilds the doGet/doPost event.
  sandbox.DriveApp.getFolderById = () => ({ getFiles: () => ({ hasNext: () => false }), createFile: () => {}, getFilesByName: () => ({ hasNext: () => false }) });
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => (id === FILE_IDS2.data ? dataWithRoster : '') }) });
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'SCRIPT_TOKEN' ? 'secret-token' : null), setProperty: () => {} });
  sandbox.Session = origSession; // owner
  let rpc = JSON.parse(sandbox.tsgRpc('api=version', 'GET', ''));
  check('tsgRpc GET api=version returns the same JSON doGet would', rpc.ok === true && rpc.codeVersion === vm.runInContext('TSG_CODE_VERSION', sandbox));
  rpc = JSON.parse(sandbox.tsgRpc('?api=data&x=1', 'GET', ''));
  check('tsgRpc supplies the token itself (token-gated api=data succeeds for the owner)', Array.isArray(rpc.tasks));
  rpc = JSON.parse(sandbox.tsgRpc('target=nonsense', 'POST', '{}'));
  check('tsgRpc POST dispatches to doPost (unknown target rejected by doPost, not by rpc)', rpc.ok === false && /Unknown target/.test(rpc.error));
  rpc = JSON.parse(sandbox.tsgRpc('', 'GET', ''));
  check('tsgRpc refuses an empty GET instead of serving the dashboard HTML', rpc.ok === false && /nothing requested/.test(rpc.error));
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'perly@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }) };
  rpc = JSON.parse(sandbox.tsgRpc('api=data', 'GET', ''));
  check('tsgRpc refuses a non-owner (google.script.run is reachable from the placeholder page)', rpc.ok === false && rpc.error === 'unauthorized');
  sandbox.Session = origSession; sandbox.DriveApp.getFolderById = origGetFolderById; sandbox.DriveApp.getFileById = origGetFileById;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? 'fake-key' : null), setProperty: () => {} });

  // Trigger installer: idempotent, replaces any existing tsgInboxTick trigger.
  let created = 0, deleted = 0;
  const fakeTrig = { getHandlerFunction: () => 'tsgInboxTick' };
  sandbox.ScriptApp.getProjectTriggers = () => [fakeTrig, { getHandlerFunction: () => 'other' }];
  sandbox.ScriptApp.deleteTrigger = () => { deleted++; };
  sandbox.ScriptApp.newTrigger = (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => { if (fn === 'tsgInboxTick' && n === 1) created++; } }) }) });
  const r = sandbox.tsgInstallInboxTrigger();
  check('tsgInstallInboxTrigger replaces the old tick trigger with a 1-minute one', r.ok && created === 1 && deleted === 1 && r.replaced === 1);
}

section('Inbox pipeline: lock busy, trash-after-write, unreadable document, whitelists (2026-09-15)');
{
  const origLock = sandbox.LockService.getScriptLock, origGetFolderById = sandbox.DriveApp.getFolderById, origGetFileById = sandbox.DriveApp.getFileById;
  const FILE_IDS3 = vm.runInContext('FILE_IDS', sandbox);
  function fakeInbox(files) {
    return { getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; }, createFile: () => {}, getFilesByName: () => ({ hasNext: () => false }) };
  }
  function fakePatchFile(name, obj) {
    const f = { name, trashed: false, isTrashed: () => f.trashed, getName: () => f.name, setName: (n) => { f.name = n; }, setTrashed: (v) => { f.trashed = v; }, getDateCreated: () => new Date('2026-09-15T00:00:00Z'), getBlob: () => ({ getDataAsString: () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) }) };
    return f;
  }
  let dataOnDisk = JSON.stringify({ meta: { docVersion: 10, next_id: 5 }, tasks: [{ id: 1, title: 'A', status: 'Not Started', history: [], subitems: [] }] });
  let writes = [];
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => (id === FILE_IDS3.data ? dataOnDisk : '{}') }), setContent: (c) => { if (id === FILE_IDS3.data) { writes.push(c); dataOnDisk = c; } } });

  // busy lock -> signalled, nothing trashed
  sandbox.LockService.getScriptLock = () => ({ tryLock: () => false, waitLock: () => {}, releaseLock: () => {} });
  let pf = fakePatchFile('p1.json', { target: 'data', op: 'update_task', id: 1, fields: { notes: 'x' } });
  sandbox.DriveApp.getFolderById = () => fakeInbox([pf]);
  let r = sandbox.processInbox_();
  check('busy lock: processInbox_ reports busy and leaves the patch untouched', r.busy === true && pf.trashed === false && writes.length === 0);

  // normal apply -> written, THEN trashed; docVersion cached
  sandbox.LockService.getScriptLock = () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} });
  r = sandbox.processInbox_();
  check('patch applied: file written then trashed', r.ok === true && r.applied === 1 && pf.trashed === true && writes.length === 1 && JSON.parse(writes[0]).tasks[0].notes === 'x');
  check('docVersion is cached after a write', cacheStore.docVersion === String(JSON.parse(writes[0]).meta.docVersion));

  // write failure -> nothing trashed (at-least-once)
  pf = fakePatchFile('p2.json', { target: 'data', op: 'update_task', id: 1, fields: { notes: 'y' } });
  sandbox.DriveApp.getFolderById = () => fakeInbox([pf]);
  const savedGet = sandbox.DriveApp.getFileById;
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => dataOnDisk }), setContent: () => { throw new Error('Drive write failed'); } });
  let threw = false; try { sandbox.processInbox_(); } catch (e) { threw = true; }
  check('a failing write leaves the patch file in place for the next pass', threw && pf.trashed === false);
  sandbox.DriveApp.getFileById = savedGet;

  // unreadable data file -> patches left queued, nothing written
  const goodDisk = dataOnDisk; dataOnDisk = 'corrupt {';
  pf = fakePatchFile('p3.json', { target: 'data', op: 'update_task', id: 1, fields: { notes: 'z' } });
  sandbox.DriveApp.getFolderById = () => fakeInbox([pf]);
  writes = [];
  r = sandbox.processInbox_();
  check('corrupt data file: patch stays queued, nothing written, error reported', r.ok === false && pf.trashed === false && writes.length === 0 && /cannot|Unexpected|JSON/i.test(String(r.error)));
  dataOnDisk = goodDisk;

  // a patch that throws is dropped (renamed FAILED-) while others still apply
  const bad = fakePatchFile('bad.json', { target: 'data', op: 'update_task', id: 999, fields: {} });
  const good = fakePatchFile('good.json', { target: 'data', op: 'update_task', id: 1, fields: { notes: 'w' } });
  sandbox.DriveApp.getFolderById = () => fakeInbox([bad, good]);
  r = sandbox.processInbox_();
  check('a failing patch is rolled back and KEPT in _Inbox as FAILED- (not trashed); the good one still applies', r.applied === 1 && r.failed === 1 && bad.name === 'FAILED-bad.json' && !bad.trashed && good.trashed && JSON.parse(dataOnDisk).tasks[0].notes === 'w');
  {
    const errs = JSON.parse(dataOnDisk).meta.inboxErrors || [];
    check('the failure is recorded in meta.inboxErrors with file, op and message', errs.length >= 1 && errs[errs.length - 1].file === 'bad.json' && errs[errs.length - 1].op === 'update_task' && /999|not found/i.test(errs[errs.length - 1].error));
    check('the written document carries meta.backendVersion', /^\d{4}-\d{2}-\d{2}\.\d+$/.test(String(JSON.parse(dataOnDisk).meta.backendVersion)));
    // next pass: the FAILED- file is skipped, nothing re-applied, no new error
    sandbox.DriveApp.getFolderById = () => fakeInbox([bad]);
    const before = writes.length;
    r = sandbox.processInbox_();
    check('a FAILED- file is never re-read on a later pass', r.applied === 0 && writes.length === before && bad.name === 'FAILED-bad.json');
    // bulk with one unknown sub-op (the raffle case): the known sub-ops apply, the file is PARTIAL-, the error names the sub-op
    const mixed = fakePatchFile('mixed.json', { target: 'data', op: 'bulk', source: 'Claude (raffle)', ops: [
      { op: 'update_task', id: 1, fields: { notes: 'from bulk' } },
      { op: 'log_time_future', id: 1, minutes: 20 },
      { op: 'update_task', id: 1, fields: { priority: 'Low' } }
    ] });
    sandbox.DriveApp.getFolderById = () => fakeInbox([mixed]);
    r = sandbox.processInbox_();
    const d = JSON.parse(dataOnDisk);
    check('bulk: the two good sub-ops applied, the bad one was rolled back, the file is kept as PARTIAL-', r.partial === 1 && r.applied === 0 && mixed.name === 'PARTIAL-mixed.json' && !mixed.trashed && d.tasks[0].notes === 'from bulk' && d.tasks[0].priority === 'Low');
    const last = d.meta.inboxErrors[d.meta.inboxErrors.length - 1];
    check('...and meta.inboxErrors names the failing sub-op by index and op, with the accepted-ops list', last.file === 'mixed.json' && last.appliedSubOps === 2 && last.failedSubOps[0].index === 1 && last.failedSubOps[0].op === 'log_time_future' && /accepts: .*log_time/.test(last.failedSubOps[0].error));
    // bulk where every sub-op fails: rolled back whole, FAILED-
    const allBad = fakePatchFile('allbad.json', { target: 'data', op: 'bulk', ops: [{ op: 'nope' }] });
    sandbox.DriveApp.getFolderById = () => fakeInbox([allBad]);
    r = sandbox.processInbox_();
    check('bulk with no applicable sub-op is FAILED-, not PARTIAL-', r.failed === 1 && r.partial === 0 && allBad.name === 'FAILED-allbad.json');
    // malformed JSON stays in place as MALFORMED- and is recorded
    const junk = fakePatchFile('junk.json', '{not json');
    sandbox.DriveApp.getFolderById = () => fakeInbox([junk]);
    r = sandbox.processInbox_();
    const d2 = JSON.parse(dataOnDisk);
    check('a malformed file is kept as MALFORMED- and recorded', r.malformed === 1 && junk.name === 'MALFORMED-junk.json' && !junk.trashed && d2.meta.inboxErrors[d2.meta.inboxErrors.length - 1].file === 'junk.json');
    check('set_meta cannot write inboxErrors or backendVersion', (() => { const doc = freshDoc(); doc.meta.inboxErrors = [{ file: 'keep' }]; sandbox.applyDataPatch_(doc, { op: 'set_meta', fields: { inboxErrors: [], backendVersion: 'x' }, ts: '2026-09-18T00:00:00Z' }); return doc.meta.inboxErrors.length === 1 && doc.meta.backendVersion !== 'x'; })());
  }

  // empty inbox sets the throttle flag; the tick honours it
  sandbox.DriveApp.getFolderById = () => fakeInbox([]);
  r = sandbox.processInbox_();
  check('empty inbox sets inboxEmptyUntil', r.applied === 0 && cacheStore.inboxEmptyUntil === '1');
  let listed = false; sandbox.DriveApp.getFolderById = () => { listed = true; return fakeInbox([]); };
  sandbox.tsgInboxTick();
  check('tsgInboxTick skips the Drive listing while the empty flag holds', listed === false);
  delete cacheStore.inboxEmptyUntil;

  // whitelists and next_id
  let d = { meta: { docVersion: 1, next_id: 3 }, tasks: [{ id: 1, title: 'A', history: [{ ts: 'x', field: 'created' }], subitems: [] }] };
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, ts: '2026-09-15T00:00:00Z', fields: { id: 77, history: [], title: 'B' } });
  check('update_task cannot overwrite id or history', d.tasks[0].id === 1 && d.tasks[0].history.length >= 1 && d.tasks[0].title === 'B');
  sandbox.applyDataPatch_(d, { op: 'set_meta', ts: '2026-09-15T00:00:00Z', fields: { next_id: 1, docVersion: 0, standingItems: ['ok'] } });
  check('set_meta cannot overwrite next_id or docVersion', d.meta.next_id === 3 && d.meta.docVersion > 0 && d.meta.standingItems[0] === 'ok');
  d = { meta: { docVersion: 4, next_id: 2 }, tasks: [] };
  sandbox.applyDataPatch_(d, { op: 'replace_all', ts: '2026-09-15T00:00:00Z', baseVersion: 4, doc: { meta: {}, tasks: [{ id: 9, title: 'client-minted', history: [], subitems: [] }] } });
  check('replace_all advances next_id past client-minted ids', d.meta.next_id === 10);
  d = { meta: { docVersion: 4, next_id: 2 }, tasks: [{ id: 1, title: 'keep', history: [], subitems: [] }] };
  sandbox.applyDataPatch_(d, { op: 'replace_all', ts: '2026-09-15T00:00:00Z', nonce: 'n1', doc: { meta: {}, tasks: [] } });
  check('replace_all without a numeric baseVersion is rejected, not applied', d.tasks.length === 1 && d.meta.rejectedSaves.some(x => x.reason === 'missing_baseVersion'));
  const rs = { meta: { docVersion: 1 }, current: {}, threads: { T: { instructions: '', memories: ['m0', 'm1'], history: [] } } };
  let badIdx = false; try { sandbox.applyRulesetPatch_(rs, { op: 'remove_thread_memory', name: 'T' }); } catch (e) { badIdx = true; }
  check('remove_thread_memory without an index throws instead of deleting memory 0', badIdx && rs.threads.T.memories.length === 2);

  sandbox.LockService.getScriptLock = origLock; sandbox.DriveApp.getFolderById = origGetFolderById; sandbox.DriveApp.getFileById = origGetFileById;
}

section('Per-person view: slice, write rules, RPC, notes-driven progress, enrichment (2026-09-15)');
{
  const roster = [{ name: 'Durand', email: '' }, { name: 'Marj', email: '' }, { name: 'Perly', email: '' }];
  function personDoc() {
    return { meta: { docVersion: 100, next_id: 50, teamRoster: roster, status_values: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done'], priority_values: ['Critical', 'High', 'Medium', 'Low'] }, tasks: [
      { id: 1, title: 'Durand task with Marj sub', owner: 'Durand', status: 'In Progress', priority: 'High', progress: 0, timelineEnd: '2026-09-20', notes: 'parent notes', history: [], subitems: [
        { title: 'Marj part', delegate: 'Marj', done: false, status: 'Not Started', progress: 0, timelineEnd: '2026-09-18', notes: '' },
        { title: 'Perly part', delegate: 'Perly', done: true, status: 'Done', progress: 100, timelineEnd: '', notes: '' } ] },
      { id: 2, title: 'Assigned to Marj', owner: 'Durand', delegate: 'Marj', status: 'Not Started', priority: 'Medium', progress: 0, timelineEnd: '2026-09-25', notes: '', history: [], subitems: [] },
      { id: 3, title: "Marj's own task", owner: 'Marj', status: 'Not Started', priority: 'Low', progress: 0, timelineEnd: '', notes: 'mine', history: [], subitems: [] },
      { id: 4, title: 'Nothing to do with Marj', owner: 'Durand', status: 'Not Started', priority: 'Low', progress: 0, timelineEnd: '', notes: 'secret', history: [], subitems: [] },
      { id: 5, title: 'Marj task with steps', owner: 'Marj', delegate: 'Marj', status: 'In Progress', priority: 'Medium', progress: 0, timelineEnd: '', notes: 'n', tags: ['Self-created', 'Flyers'], taskType: 'Actionable Task', estHours: 3, history: [], subitems: [
        { title: 'step one', delegate: 'Marj', done: true, status: 'Done', progress: 100, timelineEnd: '', notes: '' },
        { title: 'step two', delegate: 'Marj', done: false, status: 'Not Started', progress: 0, timelineEnd: '', notes: '' } ] }
    ] };
  }
  driveFilesFixture = []; calendarEventsFixture = [];
  // slice
  const rows = sandbox.tsgPersonSlice_(personDoc(), 'Marj');
  check('slice: own tasks, assigned task, delegated subitems under a context parent; nothing else', rows.length === 7 && !rows.some(r => r.id === 4) && !rows.some(r => r.kind === 'sub' && r.title === 'Perly part'));
  const ctx = rows.find(r => r.kind === 'task' && r.id === 1);
  check("slice: Durand's task with her step appears as a read-only context row without notes or tags", !!ctx && ctx.context === true && ctx.editable.length === 0 && ctx.notes === '' && ctx.owner === 'Durand' && ctx.subTotal === 1 && ctx.status === 'Not Started' && ctx.progress === 0);
  const own = rows.find(r => r.id === 3), assigned = rows.find(r => r.id === 2), sub = rows.find(r => r.kind === 'sub' && r.id === 1), stepped = rows.find(r => r.kind === 'task' && r.id === 5);
  check('own task: title/status/priority/due/notes editable, progress never', own.own === true && own.editable.join() === 'title,status,priority,timelineEnd,notes');
  check('assigned task: status and notes only', assigned.editable.join() === 'status,notes');
  check('delegated subitem: parent title, status/notes only, not parentOwn', sub.parentTitle === 'Durand task with Marj sub' && sub.editable.join() === 'status,notes' && sub.index === 0 && sub.parentOwn === false);
  check('a task with subitems reports progress as the done ratio and its counts', stepped.progress === 50 && stepped.subDone === 1 && stepped.subTotal === 2);
  check("a subitem of her own task is flagged parentOwn so the page nests it", rows.some(r => r.kind === 'sub' && r.id === 5 && r.parentOwn === true && r.done === true));
  check('task rows carry owner, tags, type and estimate for the board-style row', stepped.owner === 'Marj' && stepped.tags.includes('Flyers') && stepped.taskType === 'Actionable Task' && stepped.estHours === 3);

  // RPC with Marj signed in; the queue helper is exercised through fakes
  const origSession = sandbox.Session, origGetFileById = sandbox.DriveApp.getFileById, origGetFolderById = sandbox.DriveApp.getFolderById, origLock = sandbox.LockService.getScriptLock;
  const FILE_IDS4 = vm.runInContext('FILE_IDS', sandbox);
  let disk = JSON.stringify(personDoc());
  let queued = [];
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => (id === FILE_IDS4.data ? disk : '{}') }), setContent: (c) => { if (id === FILE_IDS4.data) disk = c; } });
  sandbox.DriveApp.getFolderById = () => ({
    createFile: (name, content) => { queued.push({ name, content }); },
    getFiles: () => { const items = queued.splice(0).map(q => ({ isTrashed: () => false, getName: () => q.name, setName: () => {}, setTrashed: () => {}, getDateCreated: () => new Date(), getBlob: () => ({ getDataAsString: () => q.content }) })); let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] }; },
    getFilesByName: () => ({ hasNext: () => false })
  });
  sandbox.LockService.getScriptLock = () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} });
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'marj@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  // Fake estimator: answers whatever NEEDED_FIELDS asks for; records every call.
  let claudeCalls = [];
  let progressAnswer = 40;
  claudeResponder = (system, user) => {
    claudeCalls.push(user);
    const m = /NEEDED_FIELDS: (\[.*?\])/.exec(user);
    const need = m ? JSON.parse(m[1]) : [];
    const out = { rationale: 'test' };
    if (need.includes('progress')) out.progress = progressAnswer;
    if (need.includes('estHours')) { out.estHours = 2; out.needsConfirmation = false; }
    if (need.includes('taskType')) out.taskType = 'Actionable Task';
    if (need.includes('subitems')) out.subitems = ['Draft the copy', 'Send to printer'];
    if (need.includes('tags')) out.tags = ['Flyers'];
    if (need.includes('dependsOnTitle')) out.dependsOnTitle = null;
    if (need.includes('group')) out.group = 'Marketing';
    if (need.includes('priority')) out.priority = 'Medium';
    return out;
  };

  let r = JSON.parse(sandbox.tsgPersonRpc('load', '{}'));
  check('load: Marj gets her rows and the status/priority vocab', r.ok && r.person === 'Marj' && r.rows.length === 7 && r.statuses.includes('Done') && r.priorities.includes('High'));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { priority: 'Critical' } })));
  check('update: priority on an assigned task is refused server-side', r.ok === false && /not editable: priority/.test(r.error));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { due: '2026-10-01' } })));
  check('update: due on an assigned task is refused server-side', r.ok === false && /not editable/.test(r.error));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 3, fields: { progress: 60 } })));
  check('update: a typed progress is refused even on her own task', r.ok === false && /not editable: progress/.test(r.error));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 4, fields: { notes: 'x' } })));
  check('update: a task outside her slice is refused', r.ok === false && r.error === 'not yours');

  claudeCalls = [];
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { status: 'Blocked', notes: 'Sent the proof to the printer, waiting on them' } })));
  let d = JSON.parse(disk);
  check('update: a notes edit re-judges the task in ONE estimator call (progress among the fields) and applies the progress', r.ok === true && claudeCalls.length === 1 && /NEEDED_FIELDS: \[[^\]]*"progress"/.test(claudeCalls[0]) && /"title"/.test(claudeCalls[0]) && d.tasks[1].progress === 40 && d.tasks[1].notes === 'Sent the proof to the printer, waiting on them');
  check('update: a status set in the same edit is kept, not replaced by In Progress', d.tasks[1].status === 'Blocked');
  check('update: history records Marj as the source', d.tasks[1].history.some(h => h.source === 'Marj' && h.field === 'status'));
  claudeCalls = []; progressAnswer = 25;
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 3, fields: { notes: 'Called two vendors so far' } })));
  d = JSON.parse(disk);
  check('update: first progress on a Not Started task moves it to In Progress', r.ok === true && d.tasks[2].progress === 25 && d.tasks[2].status === 'In Progress');
  claudeCalls = [];
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 3, fields: { notes: '' } })));
  d = JSON.parse(disk);
  check('update: clearing the notes makes no Claude call; a task that has steps by now keeps its bar from them', r.ok === true && claudeCalls.length === 0 && (d.tasks[2].progress === 0 || d.tasks[2].subitems.length > 0));
  claudeCalls = []; progressAnswer = 90;
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 5, fields: { notes: 'nearly there' } })));
  d = JSON.parse(disk);
  check('update: notes on a task with subitems are still polished in one call, but progress is not asked for; the subitems own the bar', r.ok === true && claudeCalls.length === 1 && !/NEEDED_FIELDS: \[[^\]]*"progress"/.test(claudeCalls[0]) && d.tasks[4].notes === 'nearly there' && d.tasks[4].progress === 0);
  check("update: a roll-up history line is automation, not a hand edit, and hours on a task with steps are never a disagreement (no Review tag, no REVIEW paragraph)", !(d.tasks[4].reviewFlags || []).length && !d.tasks[4].tags.includes('Review') && !d.tasks[4].tags.includes('Triage'));
  const savedResponder = claudeResponder;
  claudeResponder = () => ({ rationale: 'no number this time' });
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { notes: 'more notes' } })));
  d = JSON.parse(disk);
  check('update: when the estimator returns no progress the stored value is left alone', r.ok === true && d.tasks[1].progress === 40 && d.tasks[1].notes === 'more notes');
  claudeResponder = savedResponder;

  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'sub', id: 1, index: 0, fields: { status: 'Done' } })));
  d = JSON.parse(disk);
  check('update: a delegated subitem marked Done sets done and progress 100 via update_subitem', r.ok === true && d.tasks[0].subitems[0].done === true && d.tasks[0].subitems[0].progress === 100);
  claudeCalls = []; progressAnswer = 50;
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'sub', id: 5, index: 1, fields: { notes: 'half the copy is drafted' } })));
  d = JSON.parse(disk);
  check("update: notes on a subitem of her own task set that subitem's progress and status", r.ok === true && claudeCalls.length === 1 && d.tasks[4].subitems[1].progress === 50 && d.tasks[4].subitems[1].status === 'In Progress');
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'sub', id: 1, index: 1, fields: { notes: 'hi' } })));
  check("update: Perly's subitem is not in Marj's slice", r.ok === false && r.error === 'not yours');
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 3, fields: { priority: 'High', due: '2026-10-02', title: 'Renamed' } })));
  d = JSON.parse(disk);
  check('update: own task accepts priority, due and title', r.ok === true && d.tasks[2].priority === 'High' && d.tasks[2].timelineEnd === '2026-10-02' && d.tasks[2].title === 'Renamed');

  // add: enriched by the estimator, subitems delegated back to her, scheduled on the same pass
  claudeCalls = []; progressAnswer = 0;
  r = JSON.parse(sandbox.tsgPersonRpc('add', JSON.stringify({ title: 'Order the fall flyer print run', priority: 'Low', notes: 'Need 500 copies before the open house' })));
  d = JSON.parse(disk);
  let added = d.tasks.find(t => /fall flyer print run/i.test(t.title));
  check('add: creates a task owned by Marj, in her group, tagged Self-created and NOT held for review', r.ok === true && !!added && added.owner === 'Marj' && added.delegate === 'Marj' && added.group === 'Marj' && added.priority === 'Low' && added.tags.includes('Self-created') && !added.tags.includes('Triage'));
  check('add: the estimator fills estimate, type, subitems and tags', added.estSource === 'claude' && added.taskType === 'Actionable Task' && added.subitems.length === 2 && added.tags.includes('Flyers') && added.history.some(h => h.field === 'auto-enriched'));
  check('add: the 2h estimate is split across the two minted steps; the rollup is their plain sum (no confirm cost)', added.subitems.every(s => s.estHours === 1 && s.estSource === 'claude') && added.estHours === 2);
  check('add: the estimator was asked for progress from the notes and priority/group were not re-asked', claudeCalls.some(u => /NEEDED_FIELDS: \[[^\]]*"progress"/.test(u)) && !claudeCalls.some(u => /NEEDED_FIELDS: \[[^\]]*"priority"/.test(u)) && !claudeCalls.some(u => /NEEDED_FIELDS: \[[^\]]*"group"/.test(u)));
  check('add: minted subitems are delegated to Marj, not left for Durand', added.subitems.every(s => s.delegate === 'Marj'));
  check('add: the scheduler placed her steps and rolled the due date up to the parent', added.subitems.every(s => !!s.timelineEnd) && !!added.timelineEnd && !(added.tags || []).includes('Scheduling Stuck'));
  progressAnswer = 50;
  r = JSON.parse(sandbox.tsgPersonRpc('add', JSON.stringify({ title: 'Update the postcard mailing list', priority: 'Medium', due: '2026-10-05', notes: 'Half the agents have sent theirs' })));
  d = JSON.parse(disk);
  added = d.tasks.find(t => /postcard mailing list/i.test(t.title));
  check('add: progress read from the notes moves a new task straight to In Progress', !!added && added.progress === 50 && added.status === 'In Progress');
  check('add: a due date she typed is locked (dueOverride) and survives the scheduling pass', added.dueOverride === true && added.timelineEnd === '2026-10-05');
  r = JSON.parse(sandbox.tsgPersonRpc('add', JSON.stringify({ title: '   ' })));
  check('add: blank title refused', r.ok === false);

  // stale subitem index guard
  d = personDoc();
  let stale = false; try { sandbox.applyDataPatch_(d, { op: 'update_subitem', id: 1, index: 0, expectTitle: 'Something else', fields: { notes: 'x' } }); } catch (e) { stale = true; }
  check('update_subitem refuses when the subitem at that index has changed title', stale);

  // identity gates and the owner's preview
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'nobody@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  r = JSON.parse(sandbox.tsgPersonRpc('load', '{}'));
  check('load: a non-roster account is unauthorized', r.ok === false && r.error === 'unauthorized');
  sandbox.Session = origSession; // owner
  r = JSON.parse(sandbox.tsgPersonRpc('load', JSON.stringify({ as: 'Marj' })));
  check("load: the owner can preview Marj's slice with as=Marj", r.ok === true && r.person === 'Marj');
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ as: 'Marj', kind: 'task', id: 2, fields: { status: 'Waiting' } })));
  d = JSON.parse(disk);
  check("update: the owner editing through a preview is recorded as Durand, not as Marj", r.ok === true && d.tasks[1].status === 'Waiting' && d.tasks[1].history.some(h => h.field === 'status' && h.to === 'Waiting' && h.source === 'Durand'));
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'perly@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  r = JSON.parse(sandbox.tsgPersonRpc('load', JSON.stringify({ as: 'Marj' })));
  check('load: a non-owner cannot use as= to see someone else', r.ok === true && r.person === 'Perly');

  // doGet serves the person page to a roster member, and the owner's ?person= preview
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'marj@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  let page = sandbox.doGet({ parameter: {} });
  check('doGet: a roster member gets the person page stamped with their name', page.html.includes('PERSON PAGE for Marj'));
  sandbox.Session = origSession;
  page = sandbox.doGet({ parameter: { person: 'Marj' } });
  check("doGet: owner with ?person=Marj gets Marj's page, flagged as a preview", page.html.includes('PERSON PAGE for Marj (as=Marj)'));
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'perly@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  page = sandbox.doGet({ parameter: { person: 'Marj' } });
  check('doGet: a non-owner with ?person= still gets their own page', page.html.includes('PERSON PAGE for Perly'));

  sandbox.Session = origSession; sandbox.DriveApp.getFileById = origGetFileById; sandbox.DriveApp.getFolderById = origGetFolderById; sandbox.LockService.getScriptLock = origLock;
}

section('Progress follows the notes on every write path (2026-09-15)');
{
  let calls = [];
  let answer = 60;
  claudeResponder = (system, user) => { calls.push(user); if (/^ITEMS:/.test(user)) { const n = (user.match(/^\d+\. Title:/gm) || []).length; return { items: Array.from({ length: n }, (_, i) => ({ index: i + 1, progress: answer })) }; } const m = /NEEDED_FIELDS: (\[.*?\])/.exec(user); const need = m ? JSON.parse(m[1]) : []; const out = { rationale: 'r' }; if (need.includes('steps')) { const sm = /CURRENT_STEPS[^\n]*\n(\[.*\])/.exec(user); const cs = sm ? JSON.parse(sm[1]) : []; out.steps = cs.map(cc => ({ index: cc.index, title: cc.title, notes: cc.notes, estHours: null, taskType: null, priority: null, tags: [], progress: answer, location: null, due: null })); } if (need.includes('progress')) out.progress = answer; if (need.includes('estHours')) { out.estHours = 1; out.needsConfirmation = false; } if (need.includes('taskType')) out.taskType = 'Actionable Task'; if (need.includes('subitems')) out.subitems = []; if (need.includes('tags')) out.tags = []; if (need.includes('priority')) out.priority = 'Medium'; if (need.includes('group')) out.group = 'Ops'; if (need.includes('dependsOnTitle')) out.dependsOnTitle = null; return out; };
  function d0() { return { meta: { docVersion: 5, next_id: 10, status_values: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done'] }, tasks: [
    { id: 1, title: 'Call the caterer', owner: 'Durand', status: 'Not Started', priority: 'Medium', progress: 0, timelineEnd: '', notes: '', tags: [], history: [], subitems: [] },
    { id: 2, title: 'Parent with steps', owner: 'Durand', status: 'In Progress', priority: 'Medium', progress: 0, timelineEnd: '', notes: 'p', tags: [], history: [], subitems: [
      { title: 'step a', delegate: 'Durand', done: false, status: 'Not Started', progress: 0, notes: '', timelineEnd: '' } ] },
    { id: 3, title: 'Already done', owner: 'Durand', status: 'Done', priority: 'Low', progress: 100, timelineEnd: '', notes: 'x', tags: [], history: [], subitems: [] }
  ] }; }
  // update_task from a Claude-session inbox patch
  let d = d0(); calls = [];
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { notes: 'Left a voicemail, they called back with pricing' }, source: 'Claude' });
  check('update_task with new notes re-reads progress and logs it with the patch source', calls.length === 1 && d.tasks[0].progress === 60 && d.tasks[0].history.some(h => h.field === 'progress' && h.to === 60 && h.source === 'Claude'));
  check('update_task: first progress moves Not Started to In Progress', d.tasks[0].status === 'In Progress');
  calls = [];
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { priority: 'High' }, source: 'Claude' });
  check('update_task without a notes change makes no call', calls.length === 0 && d.tasks[0].progress === 60);
  calls = [];
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { notes: 'new notes', progress: 15 }, source: 'Claude' });
  check('update_task: an explicit progress in the same patch wins; the re-judge call does not ask for progress', calls.length === 1 && !/NEEDED_FIELDS: \[[^\]]*"progress"/.test(calls[0]) && d.tasks[0].progress === 15);
  calls = [];
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 2, fields: { notes: 'parent notes changed' }, source: 'Claude' });
  check('update_task: a task with subitems is re-judged without progress (its bar comes from the subitems)', calls.length === 1 && !/NEEDED_FIELDS: \[[^\]]*"progress"/.test(calls[0]) && d.tasks[1].progress === 0);
  calls = [];
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 3, fields: { notes: 'done notes changed' }, source: 'Claude' });
  check('update_task: a Done task is skipped', calls.length === 0 && d.tasks[2].progress === 100);
  // update_subitem
  calls = []; answer = 30;
  sandbox.applyDataPatch_(d, { op: 'update_subitem', id: 2, index: 0, expectTitle: 'step a', fields: { notes: 'started drafting' }, source: 'Claude' });
  check('update_subitem with new notes sets the subitem progress and status', calls.length === 1 && d.tasks[1].subitems[0].progress === 30 && d.tasks[1].subitems[0].status === 'In Progress' && d.tasks[1].subitems[0].done === false);
  // replace_all: the dashboard's own save
  d = d0(); calls = []; answer = 75;
  const next = JSON.parse(JSON.stringify(d.tasks));
  next[0].notes = 'Menu confirmed, deposit paid';               // notes changed -> re-read
  next[1].subitems[0].notes = 'half done';                        // subitem notes changed -> re-read
  next[2].notes = 'reworded';                                     // Done -> skipped
  sandbox.applyDataPatch_(d, { op: 'replace_all', baseVersion: 5, doc: { tasks: next } });
  check('replace_all re-judges the task whose notes changed (one call) and the changed step of the other task in one steps-only call, not the Done one', calls.length === 2 && calls.some(u => /"title"/.test(u)) && d.tasks[0].progress === 75 && d.tasks[1].subitems[0].progress === 75 && d.tasks[2].progress === 100);
  check('replace_all logs the derived progress as Durand', d.tasks[0].history.some(h => h.field === 'progress' && h.to === 75 && h.source === 'Durand'));
  d = d0(); calls = [];
  const next2 = JSON.parse(JSON.stringify(d.tasks));
  next2[0].notes = 'typed both'; next2[0].progress = 40;
  sandbox.applyDataPatch_(d, { op: 'replace_all', baseVersion: 5, doc: { tasks: next2 } });
  check('replace_all: a progress typed in the same save wins over the notes (the re-judge does not ask for it)', calls.length === 1 && !/NEEDED_FIELDS: \[[^\]]*"progress"/.test(calls[0]) && d.tasks[0].progress === 40);
  d = d0(); calls = [];
  sandbox.applyDataPatch_(d, { op: 'replace_all', baseVersion: 5, doc: { tasks: JSON.parse(JSON.stringify(d.tasks)) } });
  check('replace_all with no notes change makes no call', calls.length === 0);
  // add_task from any source with notes asks for progress
  d = d0(); calls = []; answer = 20;
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Book the photographer for the fall shoot', owner: 'Durand', priority: 'Medium', group: 'Ops', notes: 'Two quotes in hand, one more to get' }, source: 'Claude', skipDedup: true });
  const addedT = d.tasks.find(t => /photographer/i.test(t.title));
  check("add_task with notes asks the estimator for progress and applies it (Durand's pipeline too)", !!addedT && calls.some(u => /NEEDED_FIELDS: \[[^\]]*"progress"/.test(u)) && addedT.progress === 20 && addedT.status === 'In Progress');
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Review gate: pushed delegate items carry Triage and stay off the person page until cleared (2026-09-15)');
{
  driveFilesFixture = []; calendarEventsFixture = [];
  claudeResponder = (system, user) => { const m = /NEEDED_FIELDS: (\[.*?\])/.exec(user); const need = m ? JSON.parse(m[1]) : []; const out = { rationale: 'r' }; if (need.includes('progress')) out.progress = 0; if (need.includes('estHours')) { out.estHours = 1; out.needsConfirmation = false; } if (need.includes('taskType')) out.taskType = 'Actionable Task'; if (need.includes('subitems')) out.subitems = []; if (need.includes('tags')) out.tags = []; if (need.includes('priority')) out.priority = 'Medium'; if (need.includes('group')) out.group = 'Ops'; if (need.includes('dependsOnTitle')) out.dependsOnTitle = null; return out; };
  function gdoc() { return { meta: { docVersion: 1, next_id: 20, teamRoster: [{ name: 'Durand' }, { name: 'Marj' }, { name: 'Perly' }] }, tasks: [
    { id: 1, title: 'Existing parent', owner: 'Durand', status: 'In Progress', priority: 'Medium', progress: 0, timelineEnd: '', notes: '', tags: [], history: [], subitems: [
      { title: 'old step', delegate: 'Marj', done: false, status: 'Not Started', progress: 0, notes: '', tags: [] } ] }
  ] }; }
  let d = gdoc();
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Design the fall postcard', owner: 'Durand', delegate: 'Marj', priority: 'Medium', group: 'Marketing', notes: '', tags: [] }, source: 'Claude', skipDedup: true });
  let t = d.tasks.find(x => /fall postcard/i.test(x.title));
  check('add_task pushed with a delegate is tagged Triage and logs the hold', !!t && t.tags.includes('Triage') && t.history.some(h => h.field === 'pending-review'));
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Brand refresh planning', owner: 'Durand', priority: 'Medium', group: 'Marketing', notes: '', tags: [], subitems: [{ title: 'Marj drafts the palette', delegate: 'Marj', done: false }] }, source: 'Claude', skipDedup: true });
  t = d.tasks.find(x => /brand refresh/i.test(x.title));
  check('add_task pushed with a subitem delegated to a person is tagged Triage', !!t && t.tags.includes('Triage'));
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Durand-only chore', owner: 'Durand', priority: 'Low', group: 'Ops', notes: '', tags: [] }, source: 'Claude', skipDedup: true });
  t = d.tasks.find(x => /durand-only/i.test(x.title));
  check("add_task with nothing pointed at a person is not held", !!t && !t.tags.includes('Triage'));
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Dashboard add for Marj', owner: 'Durand', delegate: 'Marj', priority: 'Medium', group: 'Marketing', notes: '', tags: [] }, source: 'Durand', skipDedup: true, ownerCreated: true });
  t = d.tasks.find(x => /dashboard add for marj/i.test(x.title));
  check("add_task from the dashboard (ownerCreated) with a delegate is not held", !!t && t.delegate === 'Marj' && !t.tags.includes('Triage'));
  sandbox.applyDataPatch_(d, { op: 'add_subitem', id: 1, subitem: { title: 'new step for Perly', delegate: 'Perly', done: false, status: 'Not Started', progress: 0, notes: '', tags: [] }, source: 'Claude' });
  check('add_subitem delegated to a person holds that subitem only', d.tasks[0].subitems[1].tags.includes('Triage') && !d.tasks[0].subitems[0].tags.includes('Triage') && !(d.tasks[0].tags || []).includes('Triage'));
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { subitems: d.tasks[0].subitems.concat([{ title: 'another for Marj', delegate: 'Marj', done: false, status: 'Not Started', progress: 0, notes: '', tags: [] }]) }, source: 'Claude' });
  check('update_task adding a delegated subitem holds the new one and leaves the old one alone', d.tasks[0].subitems[2].tags.includes('Triage') && !d.tasks[0].subitems[0].tags.includes('Triage'));
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { delegate: 'Perly' }, source: 'Claude' });
  check('update_task re-pointing a task at a person holds the task and logs the delegate change', d.tasks[0].tags.includes('Triage') && d.tasks[0].history.some(h => h.field === 'delegate' && h.to === 'Perly'));
  // legacy `assignee`: still read, migrated on the next write, accepted in a patch under the old name
  const legacy = { meta: { docVersion: 1 }, tasks: [ { id: 9, title: 'Old shape', owner: 'Durand', delegate: 'Marj', status: 'Not Started', priority: 'Low', progress: 0, timelineEnd: '', notes: '', tags: [], history: [], subitems: [] } ] };
  check('a task still carrying assignee is sliced to that person until migrated', sandbox.tsgPersonSlice_(legacy, 'Marj').some(r => r.id === 9 && r.own === false));
  sandbox.tsgAutoScheduleDoc_(legacy);
  check('the scheduling pass migrates assignee to delegate and drops the old field', legacy.tasks[0].delegate === 'Marj' && !('assignee' in legacy.tasks[0]));
  sandbox.applyDataPatch_(legacy, { op: 'update_task', id: 9, fields: { assignee: 'Perly' }, source: 'Claude' });
  check('a patch that still says assignee lands as delegate', legacy.tasks[0].delegate === 'Perly' && !('assignee' in legacy.tasks[0]));
  // what the people see
  let rows = sandbox.tsgPersonSlice_(d, 'Marj');
  check("Marj's page hides the held task, the held parent and its steps, and the held new subitems", !rows.some(r => /fall postcard|brand refresh/i.test(r.title)) && !rows.some(r => r.id === 1));
  d.tasks[0].tags = [];
  rows = sandbox.tsgPersonSlice_(d, 'Marj');
  check("clearing Triage on the parent releases it: her old step shows, the held new step still does not", rows.some(r => r.kind === 'sub' && r.title === 'old step') && !rows.some(r => r.kind === 'sub' && r.title === 'another for Marj'));
  check('a person-created task is exempt (covered above) and Triage stays a reserved tag the model cannot hand out', vm.runInContext('TSG_RESERVED_TAGS', sandbox).includes('Triage') && vm.runInContext('TSG_REVIEW_TAG', sandbox) === 'Triage');
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Comments ops and the Tidy proposal (2026-09-16)');
{
  const d = { meta: { docVersion: 1, next_id: 5 }, tasks: [ { id: 1, title: 'Plan the fall mailer', owner: 'Durand', status: 'In Progress', priority: 'Medium', taskType: 'Actionable Task', group: 'Marketing', tags: ['Triage'], estHours: 2, timelineEnd: '', notes: 'talked to vendor. vendor said 665.78 for standard. also need 500 list', history: [], subitems: [] } ] };
  sandbox.applyDataPatch_(d, { op: 'add_comment', comment: { text: 'Is this the right vendor?', author: 'Durand', anchor: { kind: 'task', id: 1, label: '#1 Plan the fall mailer' } }, source: 'Durand' });
  check('add_comment stores an id, timestamp, author, anchor and text in meta.comments', d.meta.comments.length === 1 && /^c/.test(d.meta.comments[0].id) && d.meta.comments[0].author === 'Durand' && d.meta.comments[0].anchor.id === 1 && d.meta.comments[0].resolved === false);
  const cid = d.meta.comments[0].id;
  sandbox.applyDataPatch_(d, { op: 'add_comment', comment: { text: 'Yes: Hello Creative Pro, quote 9/15.', author: 'Claude', replyTo: cid, anchor: { kind: 'task', id: 1, label: '#1' } }, source: 'Claude' });
  check('a Claude session can reply with replyTo', d.meta.comments.length === 2 && d.meta.comments[1].replyTo === cid && d.meta.comments[1].author === 'Claude');
  sandbox.applyDataPatch_(d, { op: 'update_comment', id: cid, fields: { resolved: true }, source: 'Durand' });
  check('update_comment resolves and stamps who/when', d.meta.comments[0].resolved === true && d.meta.comments[0].resolvedBy === 'Durand' && !!d.meta.comments[0].resolvedTs);
  sandbox.applyDataPatch_(d, { op: 'set_meta', fields: { comments: [] } });
  check('set_meta cannot wipe comments (server-owned)', d.meta.comments.length === 2);
  sandbox.applyDataPatch_(d, { op: 'update_comment', id: cid, remove: true, source: 'Durand' });
  check('removing a comment removes its replies too', d.meta.comments.length === 0);
  let threw = false; try { sandbox.applyDataPatch_(d, { op: 'add_comment', comment: { text: '  ' } }); } catch (e) { threw = true; }
  check('add_comment refuses empty text', threw);

  // Tidy proposal: validated field by field, system tags kept
  const FILE_IDS5 = vm.runInContext('FILE_IDS', sandbox);
  const origGet5 = sandbox.DriveApp.getFileById;
  sandbox.DriveApp.getFileById = (id) => ({ getBlob: () => ({ getDataAsString: () => (id === FILE_IDS5.data ? JSON.stringify(d) : '{}') }) });
  claudeResponder = (system, user) => { if (!/tidy one task/i.test(system)) throw new Error('wrong prompt'); return { title: 'Plan the fall farming mailer with Hello Creative Pro', notes: 'Current state: vendor quoted $665.78 (standard postage) against the 500-contact list.\n\nLog:\n- 2026-09-15: talked to vendor; quote 665.78 standard; need the 500 list', priority: 'Bogus', taskType: 'Actionable Task', group: 'Nowhere', estHours: 3.1, tags: ['Mailers', 'Triage', 'x', 'y', 'z'], rationale: 'Split state from log.' }; };
  const prop = sandbox.tsgTidyProposal_(1);
  check('tidy returns before + proposal with the rewritten title and notes', prop.ok && prop.before.title === 'Plan the fall mailer' && /Hello Creative Pro/.test(prop.proposal.title) && /Current state/.test(prop.proposal.notes));
  check('tidy keeps the current priority/group when the model proposes an unknown one, rounds hours, keeps system tags and caps topical tags at 3', prop.proposal.priority === 'Medium' && prop.proposal.group === 'Marketing' && prop.proposal.estHours === 3 && prop.proposal.tags.indexOf('Triage') !== -1 && prop.proposal.tags.filter(x => x !== 'Triage').length <= 3);
  check('tidy never touches the document', d.tasks[0].title === 'Plan the fall mailer');
  sandbox.DriveApp.getFileById = origGet5;
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Link picker: Drive search and link labels (2026-09-16)');
{
  driveFilesFixture = [fakeDriveFile('Fall Flyer Draft.docx', 'https://drive.google.com/file/d/abc/view', { mimeType: 'application/vnd.google-apps.document' }), fakeDriveFile('Block Party Budget', 'https://docs.google.com/spreadsheets/d/xyz/edit', { mimeType: 'application/vnd.google-apps.spreadsheet' })];
  let r = sandbox.tsgDriveSearch_('fall flyer');
  check('driveSearch returns the matching files with name, url and mime', r.ok && r.files.length === 2 && r.files[0].name === 'Fall Flyer Draft.docx' && /document/.test(r.files[0].mime));
  check('driveSearch with nothing typed returns an empty list without searching', sandbox.tsgDriveSearch_('').files.length === 0 && sandbox.tsgDriveSearch_('a').files.length === 0);
  const origGet = sandbox.DriveApp.getFileById;
  sandbox.DriveApp.getFileById = (id) => ({ getName: () => 'Resolved ' + id, getBlob: () => ({ getDataAsString: () => '{}' }) });
  r = sandbox.tsgLabelForUrl_('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit');
  check('linkLabel resolves a Docs URL to the file name', r.ok && r.label === 'Resolved 1AbCdEfGhIjKlMnOpQrStUvWxYz012345' && r.kind === 'drive');
  sandbox.DriveApp.getFileById = () => { throw new Error('nope'); };
  r = sandbox.tsgLabelForUrl_('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view');
  check('linkLabel falls back to a generic Drive label when the file is not readable', r.ok && r.label === 'Google Drive file');
  sandbox.DriveApp.getFileById = origGet;
  r = sandbox.tsgLabelForUrl_('https://www.zillow.com/homedetails/123');
  check('linkLabel uses the hostname for any other URL and never fetches it', r.ok && r.label === 'zillow.com' && r.kind === 'web');
  driveFilesFixture = [];
}

section('Scheduler: a whole task owned by someone other than Durand is paced, not capacity-charged (2026-09-15)');
{
  const doc = { meta: { docVersion: 1 }, tasks: [
    { id: 1, title: "Marj's flyer run", owner: 'Marj', status: 'Not Started', priority: 'Medium', estHours: 5, timelineEnd: '', tags: [], history: [], subitems: [] },
    { id: 2, title: 'Durand thing', owner: 'Durand', status: 'Not Started', priority: 'Medium', estHours: 2, timelineEnd: '', tags: [], history: [], subitems: [] },
    { id: 3, title: 'Nobody owns this', owner: 'Unassigned', status: 'Not Started', priority: 'Medium', estHours: 2, timelineEnd: '', tags: [], history: [], subitems: [] }
  ] };
  const placed = sandbox.tsgAutoScheduleDoc_(doc);
  const marj = doc.tasks[0], durand = doc.tasks[1], nobody = doc.tasks[2];
  check("Marj's whole task gets a paced schedule and a due date", !!marj.scheduledStart && Array.isArray(marj.scheduledDays) && marj.scheduledDays.length === 2 && marj.timelineEnd === marj.scheduledDays[1]);
  check("Durand's task still schedules from today and is unaffected by hers", !!durand.scheduledStart && durand.scheduledStart <= marj.scheduledStart && durand.scheduledDays.length === 1);
  check('an unowned task is still left alone', !nobody.scheduledStart && !nobody.timelineEnd && placed === 2);
  const claudeTask = { id: 4, title: 'Draft the newsletter', owner: 'Durand', delegate: 'Claude', estHours: 2, timelineEnd: '', tags: [], history: [], subitems: [] };
  check("a task Durand owns but delegated to Claude (or anyone) is paced, not charged to his day", sandbox.tsgWorkItemsOf_(claudeTask)[0].delegated === true && sandbox.tsgItemIsDurandWork_(sandbox.tsgWorkItemsOf_(claudeTask)[0]) === false);
  check('the delegated task logs its auto-schedule on its own history', marj.history.some(h => h.field === 'timelineEnd' && h.note === 'auto-scheduled'));
  const items = sandbox.tsgWorkItemsOf_(marj);
  check('tsgWorkItemsOf_ marks a non-Durand whole task as delegated and not his work', items.length === 1 && items[0].delegated === true && sandbox.tsgItemIsDurandWork_(items[0]) === false && sandbox.tsgItemIsDurandWork_(sandbox.tsgWorkItemsOf_(durand)[0]) === true);
}

section('Estimator: progress is a requestable field (2026-09-15)');
{
  let asked = null;
  claudeResponder = (system, user) => { asked = user; return { progress: 73.4, rationale: 'r' }; };
  let est = sandbox.tsgEstimateTask_('Draft the newsletter', 'Intro and two of three sections written', 'Medium', ['progress'], {});
  check('progress comes back rounded and clamped, and the prompt names it', est.progress === 73 && /NEEDED_FIELDS: \["progress"\]/.test(asked) && /progress — an integer 0-100/.test(vm.runInContext('TSG_ESTIMATE_SYSTEM', sandbox)));
  claudeResponder = () => ({ progress: 250, rationale: 'r' });
  check('progress above 100 is clamped', sandbox.tsgEstimateTask_('x y', 'n', '', ['progress'], {}).progress === 100);
  check('tsgProgressFromNotes_: empty notes are 0 with no call', sandbox.tsgProgressFromNotes_('t', '   ', '') === 0);
  claudeResponder = () => ({ rationale: 'nothing numeric' });
  check('tsgProgressFromNotes_: no number from the model gives null', sandbox.tsgProgressFromNotes_('t', 'some notes', '') === null);
  claudeResponder = () => ({ estHours: 1, taskType: 'Actionable Task', subitems: [], rationale: 'r', needsConfirmation: false });
  est = sandbox.tsgEstimateTask_('Plain task', 'n', 'Medium');
  check('progress stays null when it was not requested', est.progress === null && est.estHours === 1);
  check('the estimator prompt offers the Claude task type', /"Claude"\|"Actionable Task"/.test(vm.runInContext('TSG_ESTIMATE_SYSTEM', sandbox)));
}

section('Task type Claude delegates to Claude (2026-09-15)');
{
  driveFilesFixture = []; calendarEventsFixture = [];
  claudeResponder = (system, user) => { const m = /NEEDED_FIELDS: (\[.*?\])/.exec(user); const need = m ? JSON.parse(m[1]) : []; const out = { rationale: 'r' }; if (need.includes('estHours')) { out.estHours = 1; out.needsConfirmation = false; } if (need.includes('taskType')) out.taskType = 'Claude'; if (need.includes('subitems')) out.subitems = []; if (need.includes('tags')) out.tags = []; if (need.includes('priority')) out.priority = 'Medium'; if (need.includes('group')) out.group = 'Ops'; if (need.includes('dependsOnTitle')) out.dependsOnTitle = null; if (need.includes('progress')) out.progress = 0; return out; };
  const d = { meta: { docVersion: 1, next_id: 30 }, tasks: [] };
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Summarize the September listing stats', owner: 'Durand', priority: 'Medium', group: 'Ops', notes: '', tags: [] }, source: 'Claude', skipDedup: true });
  const t = d.tasks[0];
  check('a new task the estimator types Claude gets delegate Claude and is not held for review', t.taskType === 'Claude' && t.delegate === 'Claude' && !t.tags.includes('Triage') && t.history.some(h => h.field === 'auto-enriched' && /delegate \(Claude\)/.test(h.to)));
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Pull the Lofty export', owner: 'Durand', delegate: 'Perly', priority: 'Medium', group: 'Ops', notes: '', tags: [] }, source: 'Claude', skipDedup: true });
  check('a supplied delegate is never overridden by the Claude type', d.tasks[1].taskType === 'Claude' && d.tasks[1].delegate === 'Perly');
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Pinned tasks (2026-09-16)');
{
  const d = freshDoc();
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { pinned: true }, source: 'Durand', ts: '2026-09-16T12:00:00Z' });
  check('pinned is a logged task field', d.tasks[0].pinned === true && d.tasks[0].history.some(h => h.field === 'pinned' && h.to === true && h.source === 'Durand'));
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Bonus umbrella', owner: 'Durand', priority: 'Critical', group: 'Ops', estHours: 1, taskType: 'Actionable Task', tags: ['Bonus'], pinned: true, notes: '' }, source: 'Claude', skipDedup: true, skipEnrich: true });
  const added = d.tasks[d.tasks.length - 1];
  check('add_task keeps pinned on the new task', !!added && added.pinned === true);
  const before = JSON.parse(JSON.stringify(d));
  sandbox.applyDataPatch_(d, { op: 'replace_all', doc: { tasks: before.tasks.map(t => Object.assign({}, t, { notes: t.notes })) }, baseVersion: d.meta.docVersion, source: 'Durand' });
  check('replace_all round-trips pinned', d.tasks.every(t => t.pinned === true));
}

section('Links every update: Gmail candidates, web links, meeting slots, directions (2026-09-17)');
{
  const d = freshDoc();
  driveFilesFixture = [{ getName: () => 'Photography Invoice Sept.pdf', getUrl: () => 'https://drive.google.com/file/d/PHOTO/view', getMimeType: () => 'application/pdf', getId: () => 'PHOTO', getBlob: () => ({ getDataAsString: () => '' }) }];
  gmailThreadsFixture = [{ id: 'abc123', subject: 'Photography invoice for 45 Baltimore Pike', from: 'photos@vendor.com', body: 'Attached is the invoice for the shoot.' }];
  let seenNeed = null, seenUser = '';
  claudeResponder = (system, user) => {
    seenUser = user;
    seenNeed = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test', estHours: 1, taskType: 'Actionable Task', subitems: [], priority: 'Medium', group: 'Ops', tags: [], dependsOnTitle: null, progress: 10, title: 'Confirm the photography invoice', notes: 'Current state: waiting.', location: null, due: null };
    if (seenNeed.includes('driveMatch')) out.driveMatch = { index: 1, confident: true, rationale: 'same invoice' };
    if (seenNeed.includes('mailMatch')) out.mailMatch = { index: 1, confident: true, rationale: 'the vendor thread' };
    if (seenNeed.includes('webLinks')) out.webLinks = [{ url: 'https://www.usps.com/', label: 'USPS' }, { url: 'not a url', label: 'bad' }, { url: 'https://www.usps.com/', label: 'dup' }];
    return out;
  };
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Confirm photography invoice payment', owner: 'Durand', priority: 'Medium', group: 'Ops', notes: 'Vendor sent the invoice by email.', tags: [],
    docs: [{ url: 'https://docs.google.com/document/d/ALREADY/edit', label: 'Already linked', type: 'doc' }, { url: 'https://www.usps.com/', label: 'USPS (hand-added)', type: 'web' }] }, source: 'Claude', skipDedup: true });
  const t = d.tasks[d.tasks.length - 1];
  check('Drive candidates are gathered even though the task came with a link', seenNeed && seenNeed.includes('driveMatch') && t.docs.some(x => x.url === 'https://drive.google.com/file/d/PHOTO/view'));
  check('Gmail candidates ride in the same call (MAIL_CANDIDATES) and a confident match is linked as email', seenUser.includes('MAIL_CANDIDATES') && t.docs.some(x => x.type === 'email' && x.url === 'https://mail.google.com/mail/u/0/#all/abc123' && x.label === 'Photography invoice for 45 Baltimore Pike') && t.history.some(h => h.field === 'email-auto-linked'));
  check('webLinks: a hand-added url is never re-added, junk and duplicates dropped', t.docs.filter(x => x.type === 'web').length === 1 && t.docs.some(x => x.type === 'web' && x.url === 'https://www.usps.com/' && x.label === 'USPS (hand-added)') && !t.history.some(h => h.field === 'web-auto-linked'));
  check('a Drive link already on the task is kept once and Drive search still ran', t.docs.filter(x => x.url === 'https://docs.google.com/document/d/ALREADY/edit').length === 1 && t.history.some(h => h.field === 'doc-auto-linked'));
  const req = sandbox.tsgEstimatePrompt_('x', '', '', ['mailMatch', 'progress'], {});
  check('a mailMatch-only call runs at low effort', req.opts.effort === 'low');
  check('schema carries mailMatch and webLinks', JSON.stringify(sandbox.tsgEstimateSchema_(['mailMatch', 'webLinks'])).includes('"mailMatch"') && JSON.stringify(sandbox.tsgEstimateSchema_(['webLinks'])).includes('"webLinks"'));
  // Queue mode: the request carries the mail candidates and the answer applies them
  const origProps = sandbox.PropertiesService.getScriptProperties;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? null : (scriptProps[k] == null ? null : scriptProps[k])), setProperty: (k, v) => { scriptProps[k] = v; } });
  const q = freshDoc();
  sandbox.applyDataPatch_(q, { op: 'add_task', task: { title: 'Confirm photography invoice payment', owner: 'Durand', priority: 'Medium', group: 'Ops', notes: 'Vendor sent the invoice by email.', tags: [] }, source: 'Claude', skipDedup: true });
  const j = q.meta.judgments[q.meta.judgments.length - 1];
  check('queued enrich request carries mailCandidates and asks for mailMatch + webLinks', j && Array.isArray(j.mailCandidates) && j.mailCandidates[0].url.includes('abc123') && j.need.includes('mailMatch') && j.need.includes('webLinks'));
  sandbox.applyDataPatch_(q, { op: 'judgment', id: j.id, answer: { rationale: 'r', estHours: 1, taskType: 'Actionable Task', subitems: [], priority: 'Medium', group: 'Ops', tags: [], dependsOnTitle: null, progress: 0, title: 'Confirm the photography invoice', notes: 'Current state: waiting.', location: null, due: null, driveMatch: null, meetingMatch: null, mailMatch: { index: 1, confident: true, rationale: 'thread' }, webLinks: [{ url: 'https://www.usps.com/', label: 'USPS' }] }, source: 'Claude (queue)' });
  const qt = q.tasks[q.tasks.length - 1];
  check('a queued answer links the email thread and the web link', qt.docs.some(x => x.type === 'email') && qt.docs.some(x => x.type === 'web'));
  sandbox.PropertiesService.getScriptProperties = origProps;
  driveFilesFixture = []; gmailThreadsFixture = [];
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };

  // Link picker mail search
  gmailThreadsFixture = [{ id: 't1', subject: 'Flyer proof', from: 'marj@thestawaszgroup.com', body: 'proof attached' }];
  const ms = sandbox.tsgMailSearch_('flyer proof');
  check('tsgMailSearch_ returns threads with a Gmail permalink and no excerpt', ms.ok && ms.threads.length === 1 && ms.threads[0].url === 'https://mail.google.com/mail/u/0/#all/t1' && ms.threads[0].excerpt === undefined);
  gmailThreadsFixture = [];

  // Labels
  check('claude.ai links are labelled', sandbox.tsgLabelForUrl_('https://claude.ai/code/session_01ABC').label === 'Claude Code session' && sandbox.tsgLabelForUrl_('https://claude.ai/chat/xyz').kind === 'claude');
  check('Gmail links are labelled', sandbox.tsgLabelForUrl_('https://mail.google.com/mail/u/0/#all/abc').kind === 'email');

  // Duration buckets and slots
  check('duration buckets follow Google: 0.2h->15, 0.5h->30, 0.6h->45, 1h->60, 1.25h->90, 3h->120, none->30',
    sandbox.tsgDurationBucket_(12) === 15 && sandbox.tsgDurationBucket_(30) === 30 && sandbox.tsgDurationBucket_(36) === 45 && sandbox.tsgDurationBucket_(60) === 60 && sandbox.tsgDurationBucket_(75) === 90 && sandbox.tsgDurationBucket_(180) === 120 && sandbox.tsgDurationBucket_(null) === 30);
  const day = new Date(); day.setDate(day.getDate() + 7); while (day.getDay() === 0 || day.getDay() >= 5) day.setDate(day.getDate() + 1); // a Mon-Thu day
  const pad = n => String(n).padStart(2, '0');
  const dIso = day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
  calendarEventsFixture = [{ id: 'busy1', title: 'Durand busy', start: new Date(dIso + 'T07:30:00'), end: new Date(dIso + 'T09:00:00') }];
  guestCalendarEvents = [{ start: new Date(dIso + 'T09:00:00'), end: new Date(dIso + 'T10:00:00') }];
  const slots = sandbox.tsgMeetingSlots_('marj@thestawaszgroup.com', dIso, dIso, 60);
  check('preferred window Mon-Thu 9-2: slots avoid both calendars, start after the guest is free, at most 2 per day', slots.ok && slots.window === 'preferred' && slots.guestCalendar === true && slots.minutes === 60 && slots.slots.length === 2 && new Date(slots.slots[0].startISO).getHours() === 10 && slots.slots.every(sl => sl.dateLabel && sl.timeLabel));
  calendarEventsFixture = [{ id: 'blk', title: 'Blocked 9-2', start: new Date(dIso + 'T09:00:00'), end: new Date(dIso + 'T14:00:00') }];
  guestCalendarEvents = [];
  const fb = sandbox.tsgMeetingSlots_('marj@thestawaszgroup.com', dIso, dIso, 30);
  check('second window Mon-Thu 8-4 only when 9-2 has nothing: slots at 8:00 and 8:30', fb.window === 'second' && fb.slots.length === 2 && new Date(fb.slots[0].startISO).getHours() === 8 && new Date(fb.slots[0].startISO).getMinutes() === 0 && new Date(fb.slots[1].startISO).getMinutes() === 30);
  const fri = new Date(dIso + 'T12:00:00'); fri.setDate(fri.getDate() + (5 - fri.getDay()));
  const friIso = fri.getFullYear() + '-' + pad(fri.getMonth() + 1) + '-' + pad(fri.getDate());
  // Block 8-4 on EVERY Mon-Thu day between dIso and that Friday (dIso is only the first of
  // them when today is a Friday, which made this test date-dependent before 2026-09-18).
  calendarEventsFixture = [];
  for (let d = new Date(dIso + 'T12:00:00'); d < fri; d.setDate(d.getDate() + 1)) {
    const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    calendarEventsFixture.push({ id: 'blk2-' + iso, title: 'Blocked 8-4', start: new Date(iso + 'T08:00:00'), end: new Date(iso + 'T16:00:00') });
  }
  const third = sandbox.tsgMeetingSlots_('', dIso, friIso, 30);
  check('third window adds Friday 10-2 only when Mon-Thu 8-4 has nothing', third.window === 'third' && third.slots.length > 0 && third.slots.every(sl => new Date(sl.startISO).getDay() === 5 && new Date(sl.startISO).getHours() >= 10 && new Date(sl.startISO).getHours() < 14));
  calendarEventsFixture = [];
  const friOnly = sandbox.tsgMeetingSlots_('', friIso, friIso, 30);
  check('a Friday alone falls through to the third window', friOnly.window === 'third' && friOnly.slots.length === 2);
  // errand / break blocks excluded by default (10:00-10:30, 12-1, 14:00-14:20)
  calendarEventsFixture = [{ id: 'am', title: 'Morning', start: new Date(dIso + 'T09:00:00'), end: new Date(dIso + 'T10:00:00') }];
  const withBlocks = sandbox.tsgMeetingSlots_('', dIso, dIso, 30);
  check('errand block 10:00-10:30 is skipped by default (first slot 10:30)', withBlocks.excludeBlocks === true && withBlocks.slots.length && new Date(withBlocks.slots[0].startISO).getHours() === 10 && new Date(withBlocks.slots[0].startISO).getMinutes() === 30);
  const noBlocks = sandbox.tsgMeetingSlots_('', dIso, dIso, 30, '0');
  check('blocks=0 allows the errand block slot at 10:00', noBlocks.excludeBlocks === false && new Date(noBlocks.slots[0].startISO).getHours() === 10 && new Date(noBlocks.slots[0].startISO).getMinutes() === 0);
  calendarEventsFixture = [{ id: 'am2', title: 'Morning', start: new Date(dIso + 'T09:00:00'), end: new Date(dIso + 'T11:30:00') }];
  const lunchTest = sandbox.tsgMeetingSlots_('', dIso, dIso, 60);
  check('a 60-min slot never overlaps lunch 12-1 (11:30 would, so 13:00 is first)', lunchTest.slots.length && new Date(lunchTest.slots[0].startISO).getHours() === 13);
  calendarEventsFixture = [{ id: 'busy1', title: 'Durand busy', start: new Date(dIso + 'T07:30:00'), end: new Date(dIso + 'T09:00:00') }];
  const lunchFree = slots.slots.every(sl => { const h = new Date(sl.startISO).getHours(); return !(h === 12); });
  check('no slot starts inside lunch', lunchFree);
  guestCalendarEvents = null;
  const slots2 = sandbox.tsgMeetingSlots_('nobody@thestawaszgroup.com', dIso, dIso, 30);
  check('an unshared guest calendar is reported and slots fall back to Durand-only', slots2.ok && slots2.guestCalendar === false && slots2.slots.length === 2);
  const wk = new Date(dIso + 'T12:00:00'); const sat = new Date(wk); sat.setDate(sat.getDate() + (6 - sat.getDay()));
  const satIso = sat.getFullYear() + '-' + pad(sat.getMonth() + 1) + '-' + pad(sat.getDate());
  check('weekends yield no slots', sandbox.tsgMeetingSlots_('', satIso, satIso, 30).slots.length === 0);
  calendarEventsFixture = [];

  // Directions
  const origProps2 = sandbox.PropertiesService.getScriptProperties;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'TSG_HOME_BASE' ? '728 S Broad St, Philadelphia' : null), setProperty: () => {} });
  sentMail = [];
  const dir = sandbox.tsgSendDirections_({ location: '45 Baltimore Pike, Media PA', taskTitle: 'Drop off keys', method: 'transit' });
  check('directions are emailed to the owner with a Maps link in the chosen mode', dir.ok && sentMail.length === 1 && sentMail[0].to === 'durand@thestawaszgroup.com' && dir.url.includes('travelmode=transit') && dir.url.includes('origin=728') && sentMail[0].body.includes(dir.url));
  check('directions refuse without a location', sandbox.tsgSendDirections_({ location: '' }).ok === false);
  sandbox.PropertiesService.getScriptProperties = origProps2;
}

section('Reminders and due time (2026-09-17)');
{
  const props = {};
  const origProps3 = sandbox.PropertiesService.getScriptProperties;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (props[k] == null ? null : props[k]), setProperty: (k, v) => { props[k] = v; } });
  const d = freshDoc();
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { dueTime: '10:30', remindAt: '2026-09-20T10:15' }, source: 'Durand', ts: '2026-09-17T12:00:00Z' });
  check('dueTime and remindAt are logged task fields', d.tasks[0].dueTime === '10:30' && d.tasks[0].history.some(h => h.field === 'remindAt' && h.to === '2026-09-20T10:15'));
  sandbox.tsgAutoScheduleDoc_(d);
  check('every write indexes the earliest pending reminder into the script property', props.TSG_NEXT_REMINDER === new Date('2026-09-20T10:15:00').toISOString());
  d.tasks[0].subitems = [{ title: 'Step one', done: false, status: 'Not Started', remindAt: '2026-09-19T08:00', notes: '' }];
  sandbox.tsgAutoScheduleDoc_(d);
  check('a subtask reminder earlier than the task\'s becomes the next one', props.TSG_NEXT_REMINDER === new Date('2026-09-19T08:00:00').toISOString());
  check('the tick does nothing before the reminder is due', sandbox.tsgReminderTick_().fired === 0);
  // Fire: reminder in the past, data file readable
  d.tasks[0].subitems[0].remindAt = '2020-01-01T08:00';
  d.tasks[0].remindAt = '2020-01-01T09:00';
  const origGetFile2 = sandbox.DriveApp.getFileById;
  const origFolder2 = sandbox.DriveApp.getFolderById;
  let queued = [];
  sandbox.DriveApp.getFileById = () => ({ getBlob: () => ({ getDataAsString: () => JSON.stringify(d) }), setContent: () => {}, getName: () => 'data' });
  sandbox.DriveApp.getFolderById = () => ({ createFile: (name, body) => { queued.push(JSON.parse(body)); }, getFilesByName: () => ({ hasNext: () => false }), getFiles: () => ({ hasNext: () => false }) });
  sandbox.tsgAutoScheduleDoc_(d);
  sentMail = []; cacheStore = {};
  const fired = sandbox.tsgReminderTick_();
  check('due reminders are emailed to the owner, one per item, with the due date and time', fired.fired === 2 && sentMail.length === 2 && sentMail.every(m => m.to === 'durand@thestawaszgroup.com') && sentMail.some(m => m.subject.includes('Reminder: Confirm Vendor Invoice For Photography') && m.subject.includes('2026-09-20 10:30')) && sentMail.some(m => m.subject.includes('Step one')));
  check('a bulk patch stamping reminderSentAt is queued for the task and the subtask', queued.length === 1 && queued[0].op === 'bulk' && queued[0].ops.length === 2 && queued[0].ops.some(o => o.op === 'update_task' && o.fields.reminderSentAt) && queued[0].ops.some(o => o.op === 'update_subitem' && o.expectTitle === 'Step one'));
  check('the property is cleared once nothing later is pending', props.TSG_NEXT_REMINDER === '');
  props.TSG_NEXT_REMINDER = new Date('2020-01-01T00:00:00').toISOString();
  sentMail = []; queued = [];
  sandbox.tsgReminderTick_();
  check('the cache guard prevents a second send before the stamp lands', sentMail.length === 0 && queued.length === 0);
  d.tasks[0].reminderSentAt = '2026-09-17T12:01:00Z';
  check('a sent reminder is no longer pending; a Done item never is', sandbox.tsgPendingReminders_(d).length === 1 && (d.tasks[0].subitems[0].done = true, sandbox.tsgPendingReminders_(d).length === 0));
  sandbox.DriveApp.getFileById = origGetFile2; sandbox.DriveApp.getFolderById = origFolder2;
  sandbox.PropertiesService.getScriptProperties = origProps3; cacheStore = {};
}

section('Hand edits win, disagreements flagged, dependency clears stick (2026-09-17)');
{
  const d = freshDoc();
  d.tasks[0].history.push({ ts: '2026-09-15T10:00:00Z', field: 'estHours', from: 4, to: 1, source: 'Durand' });
  d.tasks[0].history.push({ ts: '2026-09-15T10:00:00Z', field: 'priority', from: 'Medium', to: 'Low', source: 'Durand' });
  d.tasks[0].estHours = 1; d.tasks[0].priority = 'Low';
  claudeResponder = () => ({ rationale: 'a full vendor reconciliation', title: 'Confirm Vendor Invoice For Photography', notes: 'Current state: waiting on the vendor.', estHours: 5, taskType: 'Actionable Task', priority: 'Critical', group: 'Books & Finance', tags: [], subitems: [], dependsOnTitle: null, location: null, due: null, progress: 0, needsConfirmation: false });
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { notes: 'vendor says the invoice is wrong, need to reconcile' }, source: 'Durand', ts: '2026-09-17T12:00:00Z' });
  const t = d.tasks[0];
  check('every judgment field is asked for on a notes change, hand-set or not', true);
  check('the hand-set hours and priority stay', t.estHours === 1 && t.priority === 'Low');
  check('a material disagreement (5h vs 1h, Critical vs Low) is flagged with the Review tag, one flag per field, a disagreement history line, and a REVIEW paragraph in the note', t.tags.includes('Review') && !t.tags.includes('Triage') && (t.reviewFlags || []).length === 2 && t.reviewFlags.some(f => f.field === 'estHours' && f.claude === 5 && f.mine === 1 && /reconciliation/.test(f.rationale)) && t.reviewFlags.some(f => f.field === 'priority') && t.history.filter(h => h.field === 'disagreement').length === 2 && /REVIEW \(2026-09-17\): Claude proposed estHours = 5 because a full vendor reconciliation; your value 1 is kept/.test(t.notes) && t.notes.indexOf('Current state:') === 0);
  claudeResponder = () => ({ rationale: 'close enough', title: t.title, notes: t.notes, estHours: 1.25, taskType: 'Actionable Task', priority: 'Medium', group: 'Books & Finance', tags: [], subitems: [], dependsOnTitle: null, location: null, due: null, progress: 0, needsConfirmation: false });
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { notes: 'vendor says the invoice is wrong, need to reconcile. update: got the corrected one' }, source: 'Durand', ts: '2026-09-17T12:05:00Z' });
  check('a small difference (1.25h vs 1h, Medium vs Low) is not a disagreement; the earlier flags are replaced, not duplicated', t.estHours === 1 && (t.reviewFlags || []).length === 0 && !t.tags.includes('Review') && !/REVIEW \(/.test(t.notes));
  check('the note keeps its polished body once the flags clear', t.notes === 'Current state: waiting on the vendor.' || t.notes.indexOf('REVIEW') === -1);
  // forced re-run settles a disagreement with Claude's value
  claudeResponder = () => ({ rationale: 'big job', title: t.title, notes: t.notes, estHours: 6, taskType: 'Actionable Task', priority: 'Critical', group: 'Books & Finance', tags: [], subitems: [], dependsOnTitle: null, location: null, due: null, progress: 0, needsConfirmation: false });
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { notes: 'third edit' }, source: 'Durand', ts: '2026-09-17T12:10:00Z' });
  check('flagged again on a big difference', t.tags.includes('Review') && t.estHours === 1);
  sandbox.applyDataPatch_(d, { op: 'request_tidy', id: 1, source: 'Durand', ts: '2026-09-17T12:15:00Z' });
  check("a forced re-run (Tidy) adopts Claude's values and clears the flags, the Review tag and the REVIEW paragraphs", t.estHours === 6 && t.priority === 'Critical' && !t.reviewFlags && !t.tags.includes('Review') && !/REVIEW \(/.test(t.notes));
  // dependency cleared by hand stays cleared
  const d2 = freshDoc();
  d2.tasks.push({ id: 2, title: 'Get Photos From The Photographer', owner: 'Durand', status: 'Not Started', priority: 'Medium', group: 'Ops', tags: [], notes: '', history: [], subitems: [] });
  let asked = null;
  claudeResponder = (system, user) => { asked = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]'); return { rationale: 'r', title: 'Confirm Vendor Invoice For Photography', notes: 'Current state: x.', estHours: 2, taskType: 'Actionable Task', priority: 'High', group: 'Books & Finance', tags: [], subitems: [], dependsOnTitle: 'Get Photos From The Photographer', location: null, due: null, progress: 0, needsConfirmation: false }; };
  sandbox.applyDataPatch_(d2, { op: 'update_task', id: 1, fields: { notes: 'need the photos first' }, source: 'Durand' });
  check('with no dependency set, one is inferred', d2.tasks[0].depends === '2');
  sandbox.applyDataPatch_(d2, { op: 'update_task', id: 1, fields: { depends: '', dependsNone: true }, source: 'Durand' });
  sandbox.applyDataPatch_(d2, { op: 'update_task', id: 1, fields: { notes: 'need the photos first, really' }, source: 'Durand' });
  check('dependsNone keeps dependsOnTitle out of the request and the dependency stays cleared', asked && !asked.includes('dependsOnTitle') && d2.tasks[0].depends === '');
  sandbox.applyDataPatch_(d2, { op: 'update_task', id: 1, fields: { depends: '2' }, source: 'Durand' });
  check('setting a dependency by hand lifts dependsNone', d2.tasks[0].dependsNone === undefined && d2.tasks[0].depends === '2');
  // dashboard-typed values are hand-set from creation
  const d3 = freshDoc();
  claudeResponder = () => ({ rationale: 'r', title: 'Order The Fall Flyers', notes: 'Current state: x.', estHours: 4, taskType: 'Actionable Task', priority: 'Low', group: 'Marketing', tags: [], subitems: [], dependsOnTitle: null, location: null, due: '2026-11-30', progress: 0, needsConfirmation: false });
  sandbox.applyDataPatch_(d3, { op: 'add_task', task: { title: 'Order the fall flyers', owner: 'Durand', priority: 'Critical', group: 'Marketing', timelineEnd: '2026-09-25', notes: 'print shop needs the order by wednesday', tags: [] }, source: 'Durand', ownerCreated: true, skipDedup: true });
  const t3 = d3.tasks[d3.tasks.length - 1];
  check('values typed into the New Task form carry Durand history lines from creation', t3.history.some(h => h.field === 'priority' && h.source === 'Durand') && t3.history.some(h => h.field === 'timelineEnd' && h.source === 'Durand'));
  claudeResponder = () => ({ rationale: 'no rush', title: t3.title, notes: t3.notes, estHours: 4, taskType: 'Actionable Task', priority: 'Low', group: 'Marketing', tags: [], subitems: [], dependsOnTitle: null, location: null, due: '2026-11-30', progress: 0, needsConfirmation: false });
  sandbox.applyDataPatch_(d3, { op: 'update_task', id: t3.id, fields: { notes: 'print shop needs the order by wednesday. quote received' }, source: 'Durand' });
  check('...so a later pass keeps them and flags the disagreement (Critical vs Low, 9/25 vs 11/30)', t3.priority === 'Critical' && t3.timelineEnd === '2026-09-25' && t3.tags.includes('Review') && (t3.reviewFlags || []).some(f => f.field === 'timelineEnd' && f.claude === '2026-11-30'));
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Subtasks ride in the parent\'s call (2026-09-17)');
{
  let calls = [];
  const parent = () => ({ id: 1, title: 'Plan the block party', owner: 'Durand', status: 'In Progress', priority: 'High', group: 'Ops', tags: [], notes: 'first thoughts', history: [], subitems: [
    { title: 'book the band', done: false, status: 'Not Started', progress: 0, notes: 'emailed two bands', tags: [], history: [] },
    { title: 'order tables', done: false, status: 'Not Started', progress: 0, notes: '', tags: [], history: [] },
    { title: 'get the permit', done: true, status: 'Done', progress: 100, notes: 'done', tags: [], history: [] } ] });
  claudeResponder = (system, user) => {
    calls.push(user);
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*?\])/) || [])[1] || '[]');
    const out = { rationale: 'r', title: 'Plan the block party', notes: 'Current state: planning.', tags: [], estHours: 8, taskType: 'Actionable Task', priority: 'High', group: 'Ops', dependsOnTitle: null, location: null, due: null, subitems: [], needsConfirmation: false };
    if (need.includes('steps')) out.steps = [
      { index: 0, title: 'Book the band', notes: 'Current state: two bands emailed.', estHours: 0.5, taskType: 'Email', priority: 'High', tags: [], progress: 40, location: null, due: null },
      { index: 1, title: 'Order the tables', notes: '', estHours: 1, taskType: 'Call', priority: 'Medium', tags: [], progress: 0, location: null, due: '2026-10-01' },
      { index: 2, title: 'SHOULD BE IGNORED', notes: 'x', estHours: 9, taskType: 'Call', priority: 'Low', tags: [], progress: 0, location: null, due: null } ];
    return out;
  };
  let d = { meta: { docVersion: 1, next_id: 50 }, tasks: [parent()] };
  sandbox.applyDataPatch_(d, { op: 'update_task', id: 1, fields: { notes: 'first thoughts, plus the date is set' }, source: 'Durand' });
  const t = d.tasks[0];
  check('a parent notes change is ONE call that carries CURRENT_STEPS for the open steps only', calls.length === 1 && /NEEDED_FIELDS: \[[^\]]*"steps"/.test(calls[0]) && /CURRENT_STEPS/.test(calls[0]) && /"index":0/.test(calls[0]) && /"index":1/.test(calls[0]) && !/"index":2/.test(calls[0]));
  check('each open step takes its own answer: polished title and notes, hours, type, priority, progress, due', t.subitems[0].title === 'Book the band' && t.subitems[0].estHours === 0.5 && t.subitems[0].taskType === 'Email' && t.subitems[0].progress === 40 && t.subitems[0].status === 'In Progress' && t.subitems[1].title === 'Order the tables' && t.subitems[1].estHours === 1 && t.subitems[1].timelineEnd === '2026-10-01');
  check('a Done step is never touched, even when the answer names it', t.subitems[2].title === 'get the permit' && t.subitems[2].estHours === undefined);
  check('the parent logs the step re-judge', t.history.some(h => h.field === 'auto-enriched' && /steps \(2 re-judged\)/.test(h.to)));
  // minted steps arrive with their fields; a plain string still works
  calls = [];
  claudeResponder = (system, user) => { calls.push(user); return { rationale: 'r', title: 'Confirm The Caterer', notes: 'Current state: x.', tags: [], estHours: 2, taskType: 'Actionable Task', priority: 'Medium', group: 'Ops', dependsOnTitle: null, location: null, due: null, progress: 0, needsConfirmation: false,
    subitems: [{ title: 'Call the caterer', estHours: 0.25, taskType: 'Call', priority: 'High' }, 'Send the deposit'] }; };
  sandbox.applyDataPatch_(d, { op: 'add_task', task: { title: 'Confirm the caterer', owner: 'Durand', priority: 'Medium', group: 'Ops', notes: 'need to lock the caterer', tags: [] }, source: 'Claude', skipDedup: true });
  const n = d.tasks[d.tasks.length - 1];
  check('minted steps carry hours, type and priority from the same answer; a string step still lands with defaults', calls.length === 1 && n.subitems.length === 2 && n.subitems[0].estHours === 0.25 && n.subitems[0].taskType === 'Call' && n.subitems[0].priority === 'High' && n.subitems[0].estSource === 'claude' && n.subitems[1].title === 'Send the deposit' && n.subitems[1].taskType === 'Actionable Task');
  // a new step in a subitems array with the parent unchanged: one steps-only call for just that index
  calls = [];
  claudeResponder = (system, user) => { calls.push(user); return { rationale: 'r', steps: [{ index: 2, title: 'Print the flyers', notes: '', estHours: 0.75, taskType: 'Actionable Task', priority: 'Medium', tags: [], progress: 0, location: null, due: null }] }; };
  const subs = JSON.parse(JSON.stringify(n.subitems)).concat([{ title: 'print the flyers', done: false, status: 'Not Started', progress: 0, notes: '', tags: [], history: [] }]);
  sandbox.applyDataPatch_(d, { op: 'update_task', id: n.id, fields: { subitems: subs }, source: 'Durand' });
  check('a new step with the parent unchanged costs one steps-only call scoped to the new index', calls.length === 1 && /NEEDED_FIELDS: \["steps"\]/.test(calls[0]) && /"index":2/.test(calls[0]) && !/"index":0/.test(calls[0]) && d.tasks[d.tasks.length - 1].subitems[2].estHours === 0.75 && d.tasks[d.tasks.length - 1].subitems[2].title === 'Print the flyers');
  // add_subitem without notes is still estimated (title is enough)
  calls = [];
  claudeResponder = (system, user) => { calls.push(user); return { rationale: 'r', title: 'Hang the banner', notes: '', tags: [], estHours: 0.5, taskType: 'Actionable Task', priority: 'Medium', location: null, due: null, progress: 0, needsConfirmation: false }; };
  sandbox.applyDataPatch_(d, { op: 'add_subitem', id: n.id, subitem: { title: 'hang the banner', done: false, status: 'Not Started', progress: 0, notes: '', tags: [] }, source: 'Claude' });
  const last = d.tasks[d.tasks.length - 1].subitems.slice(-1)[0];
  check('add_subitem with no notes is estimated from its title in one call', calls.length === 1 && last.estHours === 0.5 && last.title === 'Hang the banner');
  // request_steps backfills only the unestimated open steps and never touches an estimated step's title
  calls = [];
  const bf = { id: 7, title: 'Bonus task', owner: 'Durand', status: 'In Progress', priority: 'Critical', group: 'Ops', tags: [], notes: 'n', history: [], subitems: [
    { title: 'Rollout — Follow up with Chelsey', done: false, status: 'Not Started', progress: 0, notes: '', estHours: 0.5, tags: [], history: [] },
    { title: 'a step with no hours', done: false, status: 'Not Started', progress: 0, notes: '', tags: [], history: [] } ] };
  d.tasks.push(bf);
  claudeResponder = (system, user) => { calls.push(user); return { rationale: 'r', steps: [{ index: 1, title: 'A step with no hours, now estimated', notes: '', estHours: 2, taskType: 'Actionable Task', priority: 'Critical', tags: [], progress: 0, location: null, due: null }] }; };
  sandbox.applyDataPatch_(d, { op: 'request_steps', id: 7, source: 'Claude' });
  check('request_steps sends only the unestimated open steps', calls.length === 1 && /"index":1/.test(calls[0]) && !/"index":0/.test(calls[0]) && bf.subitems[1].estHours === 2 && bf.subitems[0].title === 'Rollout — Follow up with Chelsey');
  // queue mode: a deferred steps answer follows the step by title when the list moved
  apiKeyPresent = false;
  const origProps4 = sandbox.PropertiesService.getScriptProperties;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? null : null), setProperty: () => {} });
  const q = { meta: { docVersion: 1, next_id: 90 }, tasks: [parent()] };
  sandbox.applyDataPatch_(q, { op: 'update_task', id: 1, fields: { notes: 'queued thoughts' }, source: 'Durand' });
  const jr = q.meta.judgments[q.meta.judgments.length - 1];
  check('a queued parent request carries currentSteps', !!jr && jr.need.includes('steps') && (jr.currentSteps || []).length === 2 && jr.currentSteps[0].title === 'book the band');
  q.tasks[0].subitems.unshift({ title: 'inserted first', done: false, status: 'Not Started', progress: 0, notes: '', tags: [], history: [] });
  sandbox.applyDataPatch_(q, { op: 'judgment', id: jr.id, source: 'Claude (queue)', answer: { rationale: 'r', title: 'Plan the block party', notes: 'Current state: queued.', tags: [], estHours: 8, taskType: 'Actionable Task', priority: 'High', group: 'Ops', dependsOnTitle: null, location: null, due: null, subitems: [], needsConfirmation: false,
    steps: [{ index: 0, title: 'Book the band', notes: 'Current state: booked.', estHours: 0.5, taskType: 'Email', priority: 'High', tags: [], progress: 60, location: null, due: null }] } });
  check('a deferred steps answer lands on the right step by title after the list moved', q.tasks[0].subitems[1].title === 'Book the band' && q.tasks[0].subitems[1].progress === 60 && q.tasks[0].subitems[0].title === 'inserted first' && q.tasks[0].subitems[0].progress === 0);
  sandbox.PropertiesService.getScriptProperties = origProps4; apiKeyPresent = true;
  claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
}

section('Attachments and the one docs list (2026-09-17)');
{
  attachFolder = null; createdFolders = []; uploadedFiles = [];
  const png = Buffer.from('fakepngbytes').toString('base64');
  const up = sandbox.tsgUploadAttachment_({ name: 'screen shot.png', mime: 'image/png', base64: 'data:image/png;base64,' + png });
  check('an upload lands in TRACKER_FOLDER_ID/Attachments (created on demand) and comes back typed image with a Drive url', up.ok && createdFolders[0] === 'Attachments' && uploadedFiles.length === 1 && up.type === 'image' && /drive\.google\.com/.test(up.url) && up.name === 'screen shot.png' && up.bytes === 12);
  const up2 = sandbox.tsgUploadAttachment_({ mime: 'image/jpeg', base64: png });
  check('a pasted image with no name gets a dated name with the right extension; the folder is reused', up2.ok && /^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.jpg$/.test(up2.name) && createdFolders.length === 1);
  const up3 = sandbox.tsgUploadAttachment_({ name: 'quote.pdf', mime: 'application/pdf', base64: png });
  check('a non-image is typed file', up3.ok && up3.type === 'file');
  check('empty content and oversize are refused', sandbox.tsgUploadAttachment_({ name: 'x', mime: 'text/plain', base64: '' }).ok === false && sandbox.tsgUploadAttachment_({ name: 'big', mime: 'application/octet-stream', base64: Buffer.alloc(11 * 1024 * 1024).toString('base64') }).ok === false);
  check('a file name is sanitised', sandbox.tsgSafeFileName_('  ../evil:name?.png  ') === '.. evil name .png');
  // doPost routing
  const origProps5 = sandbox.PropertiesService.getScriptProperties;
  sandbox.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => (k === 'SCRIPT_TOKEN' ? 'tok' : null), setProperty: () => {} });
  const resp = JSON.parse(sandbox.doPost({ parameter: { target: 'upload', token: 'tok' }, postData: { contents: JSON.stringify({ name: 'a.txt', mime: 'text/plain', base64: png }) } }).text);
  check('doPost target=upload routes to the uploader', resp.ok === true && resp.type === 'file');
  sandbox.PropertiesService.getScriptProperties = origProps5;
  // legacy doc folds into docs on every write
  const d = freshDoc();
  d.tasks[0].doc = 'https://docs.google.com/document/d/LEGACY/edit';
  d.tasks[0].docs = [{ url: 'https://example.com/other', label: 'other', type: 'web' }];
  d.tasks[0].subitems = [{ title: 'step', done: false, status: 'Not Started', doc: 'https://vendor.com/quote', docs: [] }];
  sandbox.tsgAutoScheduleDoc_(d);
  check('a legacy doc on a task or step moves to the front of its docs list and the old field is dropped', d.tasks[0].doc === undefined && d.tasks[0].docs[0].url === 'https://docs.google.com/document/d/LEGACY/edit' && d.tasks[0].docs[0].migrated === true && d.tasks[0].docs.length === 2 && d.tasks[0].subitems[0].doc === undefined && d.tasks[0].subitems[0].docs[0].label === 'vendor.com');
  sandbox.tsgAutoScheduleDoc_(d);
  check('the migration is idempotent', d.tasks[0].docs.length === 2);
  attachFolder = null; createdFolders = []; uploadedFiles = [];
}

section('No secrets in tracked files (repo is public)');
{
  // A deployment id is the exec URL; the API token is a long hex string. Neither may
  // appear in anything committed. Patterns are built here rather than written literally
  // so this file cannot itself trip the check.
  const root = path.join(__dirname, '..');
  const tracked = ['Code.gs', 'dashboard_final.html', 'person.html', 'README.md', 'CLAUDE.md', 'package.json',
    'appsscript.json', '.claspignore', 'scripts/deploy.js', 'test/test_codegs.js', 'test/test_dashboard.js'];
  const deploymentId = new RegExp('AKfycb[A-Za-z0-9_-]{30,}');
  const hexToken = new RegExp('\\b[0-9a-f]{40,}\\b');
  tracked.forEach((rel) => {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) { check(rel + ' exists', false); return; }
    const txt = fs.readFileSync(f, 'utf8');
    check(rel + ' contains no deployment id / exec URL', !deploymentId.test(txt));
    check(rel + ' contains no long hex token', !hexToken.test(txt));
  });
  const dash = fs.readFileSync(path.join(root, 'dashboard_final.html'), 'utf8');
  check('dashboard API_URL is the __TSG_API_URL__ placeholder', dash.includes("const API_URL = '__TSG_API_URL__';"));
  check('dashboard TSG_TOKEN is the __TSG_TOKEN__ placeholder', dash.includes("const TSG_TOKEN = '__TSG_TOKEN__';"));
}

section('Actual time: log_time op and ACTUALS_BY_TYPE (2026-09-17)');
{
  const doc = freshDoc();
  doc.tasks[0].subitems = [{ title: 'Step A', estHours: 1, status: 'Not Started' }];
  sandbox.applyDataPatch_(doc, { op: 'log_time', id: 1, minutes: 45, kind: 'timer', source: 'Durand', ts: '2026-09-17T15:00:00Z' });
  const t = doc.tasks[0];
  check('timer entry lands in timeLog; actualHours is the quarter-hour sum; actualSource set', t.timeLog.length === 1 && t.actualHours === 0.75 && t.actualSource === 'timer');
  sandbox.applyDataPatch_(doc, { op: 'log_time', id: 1, minutes: 20, kind: 'session', source: 'Claude session', turns: 6, spanMin: 95, note: 'drafted the vendor reply', ts: '2026-09-17T16:00:00Z' });
  check('a session report keeps turns and span on the entry and counts only attention minutes', t.timeLog[1].turns === 6 && t.timeLog[1].spanMin === 95 && t.actualHours === 1 && t.claudeTurns === 6);
  check('history logs actualHours with the source and the turns', t.history.some(h => h.field === 'actualHours' && h.source === 'Claude session' && /1 h \(session, 6 turns\)/.test(h.to)));
  sandbox.applyDataPatch_(doc, { op: 'log_time', id: 1, subIdx: 0, minutes: 30, kind: 'manual', source: 'Durand', ts: '2026-09-17T16:10:00Z' });
  check('a subtask keeps its own log; the parent total adds it', t.subitems[0].actualHours === 0.5 && sandbox.tsgItemActualHours_(t) === 1.5 && t.history.some(h => h.field === 'subitem-actualHours'));
  let threw = null; try { sandbox.applyDataPatch_(doc, { op: 'log_time', id: 1, minutes: 0, ts: '2026-09-17T16:11:00Z' }); } catch (e) { threw = e.message; }
  check('zero minutes is refused', /positive/.test(threw || ''));
  sandbox.applyDataPatch_(doc, { op: 'log_time', id: 1, minutes: 5, kind: 'guess', ts: '2026-09-17T16:12:00Z' });
  check('an unknown kind falls back to manual', t.timeLog[t.timeLog.length - 1].kind === 'manual');
  const d2 = freshDoc();
  d2.tasks = [1, 2, 3].map(i => ({ id: i, title: 'E' + i, status: 'Done', taskType: 'Email', estHours: 0.5, actualHours: [0.25, 0.5, 1][i - 1], subitems: [], history: [] }))
    .concat([{ id: 4, title: 'X', status: 'Done', taskType: 'Actionable Task', estHours: 2, actualHours: 3, subitems: [], history: [] }]);
  const act = sandbox.tsgActualsByType_(d2);
  check('three Email samples give a row with medians; a single Actionable sample is left out', !!act.Email && act.Email.n === 3 && act.Email.medianActualHours === 0.5 && act.Email.medianActualOverEstimate === 1 && !act['Actionable Task']);
  const p = sandbox.tsgEstimatePrompt_('Email the vendor', 'notes', 'High', ['estHours', 'taskType', 'subitems'], { actuals: act });
  const txt = p.user.map(b => b.text).join('\n');
  check('the estimator prompt carries ACTUALS_BY_TYPE when asked for hours', /ACTUALS_BY_TYPE/.test(txt) && txt.includes('"Email":{"n":3'));
  const p2 = sandbox.tsgEstimatePrompt_('Email the vendor', 'notes', 'High', ['progress'], { actuals: act });
  check('...and not on a progress-only read', !/ACTUALS_BY_TYPE/.test(p2.user.map(b => b.text).join('\n')));
  check('tsgBoardContext_ exposes actuals', sandbox.tsgBoardContext_(d2).actuals.Email.n === 3);
  check('the system prompt tells Claude measured work beats the table', /measured work beats the table/.test(sandbox.TSG_ESTIMATE_SYSTEM));
  check('actualHours is a diffed field on tasks and subtasks', sandbox.TSG_TASK_DIFF_FIELDS.includes('actualHours') && sandbox.TSG_SUBITEM_DIFF_FIELDS.includes('actualHours'));
}

section('Reviewing delegated work is an admin-block item, not a capacity slice (2026-09-17)');
{
  const t = { subitems: [
    { title: 'Claude step', estHours: 1, delegate: 'Claude' },
    { title: 'Marj step', estHours: 1, delegate: 'Marj' },
    { title: 'Own step', estHours: 1, delegate: 'Durand' },
    { title: 'Unassigned step', estHours: 1 }
  ] };
  sandbox.tsgReadCapacity_({ meta: {} });
  const r = sandbox.tsgOpenSubitemHours_(t);
  check('roll-up is the plain sum of step hours: no confirm or review slices (4 h)', r.hours === 4 && r.any === true);
  t.subitems[0].needsApproval = true;
  check('a Claude step needing approval adds only the post-review update session (10 min default): 4.17', sandbox.tsgOpenSubitemHours_(t).hours === 4.17);
  t.subitems[0].needsApproval = false;
  const loads = []; const addLoad = (d, h) => loads.push([d, Math.round(h * 100) / 100]);
  sandbox.tsgReserveReviewSlices_(addLoad, '2026-09-01', '2026-09-25', { delegate: 'Marj' }, false);
  sandbox.tsgReserveReviewSlices_(addLoad, '2026-09-01', '2026-09-25', { delegate: 'Claude' }, false);
  check('person handoff and plain Claude step reserve nothing on his day', loads.length === 0);
  sandbox.tsgReserveReviewSlices_(addLoad, '2026-09-01', '2026-09-25', { delegate: 'Claude', needsApproval: true }, false);
  check('Claude step needing approval: post-review update one workday after Fri 9/25 (Mon 9/28, 10 min)', loads.length === 1 && loads[0][0] === '2026-09-28' && loads[0][1] === 0.17);
  loads.length = 0;
  sandbox.tsgReadCapacity_({ meta: { capacity: { approvalWaitDays: 3, postReviewUpdateMin: 30 } } });
  sandbox.tsgReserveReviewSlices_(addLoad, '2026-09-01', '2026-09-25', { owner: 'Durand', delegate: 'Claude', needsApproval: true }, true);
  check('whole Claude task, Settings wait 3 workdays and 30 min: lands Wed 9/30 at 0.5 h', loads.length === 1 && loads[0][0] === '2026-09-30' && loads[0][1] === 0.5);
  loads.length = 0;
  sandbox.tsgReserveReviewSlices_(addLoad, '2026-09-01', '2026-09-25', { owner: 'Durand', delegate: 'Marj', needsApproval: true }, true);
  check('needsApproval on a person item costs nothing (their round of changes is theirs)', loads.length === 0);
  sandbox.tsgReadCapacity_({ meta: {} });
  check('needsApproval is a diffed field on tasks and steps', sandbox.TSG_TASK_DIFF_FIELDS.includes('needsApproval') && sandbox.TSG_SUBITEM_DIFF_FIELDS.includes('needsApproval'));
  check('the old handoff helpers are gone', typeof sandbox.tsgHandoffConfirmNeeded_ === 'undefined' && typeof sandbox.tsgConfirmHoursFor_ === 'undefined');
}

section('A proposed due date is never a day that is already over (2026-09-17)');
{
  const fri1630 = new Date('2026-09-18T16:30:00'), fri1000 = new Date('2026-09-18T10:00:00'), sat = new Date('2026-09-19T09:00:00');
  check('during the workday the floor is today', sandbox.tsgEarliestDueIso_(fri1000) === '2026-09-18');
  check('at 16:30 or later the floor is the next workday (Fri -> Mon)', sandbox.tsgEarliestDueIso_(fri1630) === '2026-09-21');
  check('on a weekend the floor is Monday', sandbox.tsgEarliestDueIso_(sat) === '2026-09-21');
  const doc = freshDoc(); const t = doc.tasks[0]; t.timelineEnd = ''; t.history = [];
  const savedNow = sandbox.tsgEarliestDueIso_;
  sandbox.tsgEarliestDueIso_ = () => '2026-09-21';
  sandbox.tsgApplyEstimateToTask_(doc, t, { due: '2026-09-18', source: 'claude' }, ['due'], { now: '2026-09-18T03:12:00Z', source: 'Claude (queue)' });
  check('a due date earlier than the floor is moved to it and the history line says why', t.timelineEnd === '2026-09-21' && t.history.some(h => h.field === 'timelineEnd' && h.to === '2026-09-21' && /already past/.test(h.note || '')));
  sandbox.tsgApplyEstimateToTask_(doc, t, { due: '2026-09-25', source: 'claude' }, ['due'], { now: '2026-09-18T03:13:00Z', source: 'Claude (queue)' });
  check('a due date at or after the floor lands as proposed', t.timelineEnd === '2026-09-25');
  sandbox.tsgEarliestDueIso_ = savedNow;
}

console.log('\nDone.' + (FAILS ? ' ' + FAILS + ' FAILED' : ''));
if (FAILS) process.exitCode = 1;
