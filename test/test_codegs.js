const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

// Minimal Apps Script global stubs — just enough for applyDataPatch/tsgEstimateTask_/
// tsgCleanTitle_ to run without touching real Drive/Calendar/Gmail.
let claudeResponder = () => { throw new Error('claudeResponder not set for this test'); };
let driveFilesFixture = [];      // [{ name, getUrl }] consumed by DriveApp.searchFiles stub
let calendarEventsFixture = [];  // [{ id, title, start: Date, end: Date, allDay, location }] consumed by CalendarApp stub
let driveDocTextById = {};       // { fileId: text } consumed by the DocumentApp.openById stub (tsgGetFileSnippet_)
let driveSheetValuesById = {};   // { fileId: [[...]] } consumed by the SpreadsheetApp.openById stub
let projectDashboardHtml = '';   // what HtmlService.createHtmlOutputFromFile('dashboard_final') returns
let cacheStore = {};             // CacheService stub backing store
let uuidCounter = 0;
let personPageHtml = '<html>PERSON PAGE for __TSG_PERSON__ (as=__TSG_AS__)</html>';

const sandbox = {
  console,
  Logger: { log: () => {} },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k === 'ANTHROPIC_API_KEY' ? 'fake-key' : null),
      setProperty: () => {}
    })
  },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE_DEPLOYMENT/exec' }) },
  Session: {
    getActiveUser: () => ({ getEmail: () => 'durand@thestawaszgroup.com' }),
    getEffectiveUser: () => ({ getEmail: () => 'durand@thestawaszgroup.com' }),
    getScriptTimeZone: () => 'America/New_York'
  },
  UrlFetchApp: {
    fetch: (url, opts) => {
      const payload = JSON.parse(opts.payload);
      const userMsg = payload.messages[0].content;
      const answer = claudeResponder(payload.system, userMsg);
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ content: [{ text: JSON.stringify(answer) }] })
      };
    }
  },
  DriveApp: {
    getFolderById: () => ({ createFile: () => {}, getFilesByName: () => ({ hasNext: () => false }) }),
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
    GuestStatus: { YES: 'yes', OWNER: 'owner', NO: 'no' }
  },
  Utilities: {
    formatDate: (date, tz, fmt) => {
      const pad = (n) => String(n).padStart(2, '0');
      if (fmt === 'yyyy-MM-dd') return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      if (fmt === 'HH:mm') return pad(date.getHours()) + ':' + pad(date.getMinutes());
      return date.toISOString();
    },
    base64EncodeWebSafe: (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    base64Encode: (s) => Buffer.from(s).toString('base64'),
    sleep: () => {},
    getUuid: () => 'uuid-' + (++uuidCounter)
  },
  GmailApp: { search: () => [] },
  MailApp: { sendEmail: () => {} },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  // Both stubs echo what they were given back on the returned object (.text / .html) so
  // doGet's responses can be inspected; the chained setters return the same object.
  ContentService: { createTextOutput: (t) => { const o = { text: t }; o.setMimeType = () => o; o.getContent = () => t; return o; }, MimeType: { JSON: 'json' } },
  HtmlService: {
    createHtmlOutput: (h) => { const o = { html: h }; o.setTitle = () => o; o.addMetaTag = () => o; return o; },
    // The dashboard is a file in the script project; tests point it at a small fake page.
    createHtmlOutputFromFile: (name) => ({ getContent: () => (name === 'dashboard_final' ? projectDashboardHtml : (name === 'person' ? personPageHtml : '')) })
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
    if (system.indexOf('Google Drive') !== -1) { lastDriveMatchUser = user; return driveMatchResponse; } // the tsgSearchDriveForTask_ judgment call
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test' };
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
  sandbox.applyDataPatch_(doc3, { op: 'add_task', ts: '2026-09-10T15:10:00Z', source: 'Claude',
    task: { title: 'Reconcile September Vendor Invoices' } });
  const t3 = doc3.tasks[0];
  check('no candidates -> no doc attached, no Triage just for that', !(t3.docs || []).length && !(t3.tags || []).includes('Triage'));

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
    if (system.indexOf('Google Calendar') !== -1) return meetingMatchResponse; // tsgSearchCalendarForTask_'s judgment call
    const need = JSON.parse((user.match(/NEEDED_FIELDS: (\[.*\])/) || [])[1] || '[]');
    const out = { rationale: 'test' };
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
    subitems: [{ title: 'Rayma', done: true, timelineEnd: '2026-09-22' }, { title: 'Chelsea', done: false, timelineEnd: '2026-09-16' }] }] };
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
  check('non-Durand delegate on an open subitem still adds the 0.5h handoff cost', (function() {
    const dd = { meta: {}, tasks: [parent({ estHoursOwn: 0, subitems: [{ title: 'x', done: false, delegate: 'Perly', estHours: 1 }] })] };
    sandbox.tsgRollupSubitemHours_(dd); return dd.tasks[0].estHours === 1.5; })());
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
  check('a failing patch is dropped and named FAILED-, the good one still applies', r.applied === 1 && r.failed === 1 && bad.name === 'FAILED-bad.json' && bad.trashed && good.trashed && JSON.parse(dataOnDisk).tasks[0].notes === 'w');

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

section('Per-person view, milestone 1: slice, write rules, RPC (2026-09-15)');
{
  const NOW = '2026-09-15T13:00:00Z';
  const roster = [{ name: 'Durand', email: '' }, { name: 'Marj', email: '' }, { name: 'Perly', email: '' }];
  function personDoc() {
    return { meta: { docVersion: 100, next_id: 50, teamRoster: roster, status_values: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done'], priority_values: ['Critical', 'High', 'Medium', 'Low'] }, tasks: [
      { id: 1, title: 'Durand task with Marj sub', owner: 'Durand', status: 'In Progress', priority: 'High', progress: 0, timelineEnd: '2026-09-20', notes: 'parent notes', history: [], subitems: [
        { title: 'Marj part', delegate: 'Marj', done: false, status: 'Not Started', progress: 0, timelineEnd: '2026-09-18', notes: '' },
        { title: 'Perly part', delegate: 'Perly', done: false, status: 'Not Started', progress: 0, timelineEnd: '', notes: '' } ] },
      { id: 2, title: 'Assigned to Marj', owner: 'Durand', assignee: 'Marj', status: 'Not Started', priority: 'Medium', progress: 0, timelineEnd: '2026-09-25', notes: '', history: [], subitems: [] },
      { id: 3, title: "Marj's own task", owner: 'Marj', status: 'Not Started', priority: 'Low', progress: 0, timelineEnd: '', notes: 'mine', history: [], subitems: [] },
      { id: 4, title: 'Nothing to do with Marj', owner: 'Durand', status: 'Not Started', priority: 'Low', progress: 0, timelineEnd: '', notes: 'secret', history: [], subitems: [] }
    ] };
  }
  // slice
  const rows = sandbox.tsgPersonSlice_(personDoc(), 'Marj');
  check('slice: own task, assigned task, delegated subitem; nothing else', rows.length === 3 && !rows.some(r => r.id === 4) && !rows.some(r => r.kind === 'sub' && r.title === 'Perly part'));
  const own = rows.find(r => r.id === 3), assigned = rows.find(r => r.id === 2), sub = rows.find(r => r.kind === 'sub');
  check('own task: every field editable', own.own === true && own.editable.includes('priority') && own.editable.includes('timelineEnd') && own.editable.includes('title'));
  check('assigned task: status/progress/notes only', assigned.editable.join() === 'status,progress,notes');
  check('delegated subitem carries parent title and is limited to status/progress/notes', sub.parentTitle === 'Durand task with Marj sub' && sub.editable.join() === 'status,progress,notes' && sub.index === 0);

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

  let r = JSON.parse(sandbox.tsgPersonRpc('load', '{}'));
  check('load: Marj gets her 3 rows and the status/priority vocab', r.ok && r.person === 'Marj' && r.rows.length === 3 && r.statuses.includes('Done') && r.priorities.includes('High'));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { priority: 'Critical' } })));
  check('update: priority on an assigned task is refused server-side', r.ok === false && /not editable: priority/.test(r.error));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { due: '2026-10-01' } })));
  check('update: due on an assigned task is refused server-side', r.ok === false && /not editable/.test(r.error));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 4, fields: { notes: 'x' } })));
  check('update: a task outside her slice is refused', r.ok === false && r.error === 'not yours');
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 2, fields: { status: 'In Progress', progress: 40, notes: 'started' } })));
  let d = JSON.parse(disk);
  check('update: status/progress/notes on an assigned task apply through the inbox as update_task', r.ok === true && d.tasks[1].status === 'In Progress' && d.tasks[1].progress === 40 && d.tasks[1].notes === 'started');
  check('update: history records Marj as the source', d.tasks[1].history.some(h => h.source === 'Marj' && h.field === 'status'));
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'sub', id: 1, index: 0, fields: { status: 'Done' } })));
  d = JSON.parse(disk);
  check('update: a delegated subitem marked Done sets done and progress 100 via update_subitem', r.ok === true && d.tasks[0].subitems[0].done === true && d.tasks[0].subitems[0].progress === 100 && d.tasks[0].subitems[1].done === false);
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'sub', id: 1, index: 1, fields: { notes: 'hi' } })));
  check("update: Perly's subitem is not in Marj's slice", r.ok === false && r.error === 'not yours');
  r = JSON.parse(sandbox.tsgPersonRpc('update', JSON.stringify({ kind: 'task', id: 3, fields: { priority: 'High', due: '2026-10-02', title: 'Renamed' } })));
  d = JSON.parse(disk);
  check('update: own task accepts priority, due and title', r.ok === true && d.tasks[2].priority === 'High' && d.tasks[2].timelineEnd === '2026-10-02' && d.tasks[2].title === 'Renamed');
  r = JSON.parse(sandbox.tsgPersonRpc('add', JSON.stringify({ title: 'new thing', priority: 'Low', due: '2026-10-05', notes: 'n' })));
  d = JSON.parse(disk);
  const added = d.tasks.find(t => t.title === 'New Thing' || t.title === 'new thing');
  check('add: creates a task owned by Marj, in her group, with no Claude enrichment', r.ok === true && !!added && added.owner === 'Marj' && added.group === 'Marj' && added.priority === 'Low' && added.timelineEnd === '2026-10-05' && added.estSource === 'none');
  r = JSON.parse(sandbox.tsgPersonRpc('add', JSON.stringify({ title: '   ' })));
  check('add: blank title refused', r.ok === false);

  // stale subitem index guard
  d = personDoc();
  let stale = false; try { sandbox.applyDataPatch_(d, { op: 'update_subitem', id: 1, index: 0, expectTitle: 'Something else', fields: { notes: 'x' } }); } catch (e) { stale = true; }
  check('update_subitem refuses when the subitem at that index has changed title', stale);

  // identity gates
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'nobody@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  r = JSON.parse(sandbox.tsgPersonRpc('load', '{}'));
  check('load: a non-roster account is unauthorized', r.ok === false && r.error === 'unauthorized');
  sandbox.Session = origSession; // owner
  r = JSON.parse(sandbox.tsgPersonRpc('load', JSON.stringify({ as: 'Marj' })));
  check("load: the owner can preview Marj's slice with as=Marj", r.ok === true && r.person === 'Marj');
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'perly@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  r = JSON.parse(sandbox.tsgPersonRpc('load', JSON.stringify({ as: 'Marj' })));
  check('load: a non-owner cannot use as= to see someone else', r.ok === true && r.person === 'Perly');

  // doGet serves the person page to a roster member, and the owner's ?as= preview
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'marj@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  let page = sandbox.doGet({ parameter: {} });
  check('doGet: a roster member gets the person page stamped with their name', page.html.includes('PERSON PAGE for Marj'));
  sandbox.Session = origSession;
  page = sandbox.doGet({ parameter: { as: 'Marj' } });
  check("doGet: owner with ?as=Marj gets Marj's page, flagged as a preview", page.html.includes('PERSON PAGE for Marj (as=Marj)'));
  sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'perly@tsg.homes' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/New_York' };
  page = sandbox.doGet({ parameter: { as: 'Marj' } });
  check('doGet: a non-owner with ?as= still gets their own page', page.html.includes('PERSON PAGE for Perly'));

  sandbox.Session = origSession; sandbox.DriveApp.getFileById = origGetFileById; sandbox.DriveApp.getFolderById = origGetFolderById; sandbox.LockService.getScriptLock = origLock;
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

console.log('\nDone.' + (FAILS ? ' ' + FAILS + ' FAILED' : ''));
if (FAILS) process.exitCode = 1;
