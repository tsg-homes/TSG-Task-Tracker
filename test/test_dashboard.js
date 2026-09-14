const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard_final.html'), 'utf8');

const fakeData = {
  meta: { version: 1, docVersion: 1, next_id: 100, teamRoster: [
    { name: 'Durand', role: 'DOO', title: 'Director of Operations', email: 'durand@thestawaszgroup.com', source: '', fubId: null },
    { name: 'Ryan', role: 'Agent', title: 'Agent, Principal', email: 'ryan@thestawaszgroup.com', source: '', fubId: null }
  ] },
  tasks: [
    {
      id: 1, title: 'Call Farina Di Vita — Confirm Headcount For Catering Pricing', owner: 'Durand',
      status: 'In Progress', priority: 'High', group: 'Block Party', tags: ['Triage'],
      taskType: 'Call', contactPhone: '267-639-5185',
      timelineEnd: '2026-09-15', progress: 0, depends: '', doc: '', docs: [], notes: 'Test note',
      estHours: 1, estDays: 1, estSource: 'claude', dueOverride: true,
      history: [
        { ts: '2026-09-08T12:00:00Z', field: 'created', from: null, to: null },
        { ts: '2026-09-09T18:10:00Z', field: 'status', from: 'Not Started', to: 'In Progress', source: 'Durand' }
      ],
      subitems: [
        {
          title: '@Claude - get the phone number', done: true, delegate: 'Claude', status: 'Done',
          priority: 'Medium', tags: ['Claude'], timelineEnd: '2026-09-10', progress: 100,
          depends: '', doc: '', notes: 'Found it.', estHours: 0.25, estDays: null, estSource: 'none',
          taskType: 'Actionable Task', docs: [],
          history: [
            { ts: '2026-09-09T17:22:00Z', field: 'created', from: null, to: null, source: 'Claude' },
            { ts: '2026-09-09T18:00:00Z', field: 'status', from: 'In Progress', to: 'Done', source: 'Claude' },
            { ts: '2026-09-09T18:00:00Z', field: 'done', from: false, to: true, source: 'Claude' }
          ]
        }
      ]
    },
    {
      id: 3, title: 'Overdue Task With A Past Due Date', owner: 'Durand', status: 'In Progress',
      priority: 'Medium', group: 'Ops', tags: [], taskType: 'Meeting',
      timelineEnd: '2026-09-02', progress: 0, depends: '', doc: '', docs: [], notes: '',
      estHours: 1, estDays: 1, estSource: 'claude', history: [
        { ts: '2026-08-20T12:00:00Z', field: 'created', from: null, to: null }
      ], subitems: []
    },
    {
      id: 2, title: 'Text Marj About The Flyer Proof', owner: 'Durand', status: 'Not Started',
      priority: 'Medium', group: 'Marketing', tags: [], taskType: 'Text/Chat', contactName: 'Marj',
      timelineEnd: '2026-09-12', progress: 0, depends: '', doc: '', docs: [], notes: '',
      estHours: 0.25, estDays: 1, estSource: 'claude', history: [
        { ts: '2026-09-09T12:00:00Z', field: 'created', from: null, to: null }
      ], subitems: []
    }
  ]
};

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable',
  url: 'https://script.google.com/macros/s/FAKE/exec', pretendToBeVisual: true,
  beforeParse(window) {
    window.__meetingsFetchUrls = [];
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, serverVersion: 1 }) };
      if (u.includes('api=data')) return { ok: true, status: 200, json: async () => fakeData };
      if (u.includes('api=calendar')) return { ok: true, status: 200, json: async () => [] };
      if (u.includes('api=meetings')) { window.__meetingsFetchUrls.push(u); return { ok: true, status: 200, json: async () => ({ events: [], bestGuessId: null }) }; }
      return { ok: true, status: 200, json: async () => ({ ok: true, users: [], events: [], meetings: [] }) };
    };
    window.onerror = function(msg, src, line, col, err) { errors.push({ msg, stack: err && err.stack }); return true; };
    window.addEventListener('unhandledrejection', (e) => errors.push({ msg: 'UNHANDLED: ' + e.reason, stack: e.reason && e.reason.stack }));
    window.alert = () => {}; window.confirm = () => true; window.prompt = () => null;
  }
});

setTimeout(async () => {
  const w = dom.window, doc = w.document;
  function tryCall(label, fn) { try { fn(); console.log('OK   -', label); } catch (e) { console.log('FAIL -', label, '->', e.message); } }

  console.log('--- Data loaded ---');
  console.log('TASK_TYPES:', JSON.stringify(w.TASK_TYPES));
  console.log('Task 1 found:', !!w.findTask(1));

  tryCall('renderAll (full sweep)', () => w.renderAll());
  tryCall('openTaskCard(1) — Call type + subitem with real history', () => w.openTaskCard(1));
  const modalHistHtml = doc.getElementById('modalHistory') ? doc.getElementById('modalHistory').innerHTML : '';
  console.log('Modal history shows subitem-prefixed entry:', modalHistHtml.includes('@Claude - get the phone number'));
  console.log('Modal history shows a source suffix:', /\(Claude\)|\(Durand\)/.test(modalHistHtml));
  const modalMetaHtml = doc.getElementById('modalMeta') ? doc.getElementById('modalMeta').innerHTML : '';
  console.log('Call type shows tel: link:', modalMetaHtml.includes('tel:2676395185'));

  tryCall('openTaskCard(2) — Text/Chat type, non-roster contact (no email) -> sms fallback', () => w.openTaskCard(2));
  const modalMetaHtml2 = doc.getElementById('modalMeta') ? doc.getElementById('modalMeta').innerHTML : '';
  console.log('Text/Chat (non-team "Marj"? she IS on roster but no email in this fixture) shows Contact row:', modalMetaHtml2.includes('Who is this to?') || modalMetaHtml2.includes('Marj'));

  tryCall('openNewTaskModal', () => w.openNewTaskModal());
  tryCall('closeNewTaskModal', () => w.closeNewTaskModal());
  tryCall('openMeetingPicker(1, null) — future-only window (task 1 due 2026-09-15, today mocked as system date)', () => w.openMeetingPicker(1, null));
  await new Promise(r => setTimeout(r, 50));
  const lastUrl = w.__meetingsFetchUrls[w.__meetingsFetchUrls.length - 1] || '';
  const startParam = (lastUrl.match(/start=([\d-]+)/) || [])[1];
  console.log('Meetings fetch URL:', lastUrl);
  console.log('Window start param >= today:', startParam && startParam >= w.todayISO());

  tryCall('openMeetingPicker(3, null) — task due 2026-09-02 (past) should still clamp to today, not 2026-08-26', () => w.openMeetingPicker(3, null));
  await new Promise(r => setTimeout(r, 50));
  const lastUrl2 = w.__meetingsFetchUrls[w.__meetingsFetchUrls.length - 1] || '';
  const startParam2 = (lastUrl2.match(/start=([\d-]+)/) || [])[1];
  console.log('Past-due meetings fetch URL:', lastUrl2);
  console.log('Past-due window start clamped to today (not 2026-08-26):', startParam2 && startParam2 >= w.todayISO());

  tryCall('footer version stamp — UI version present, API shows "local" when opened outside doGet', () => {
    const stamp = doc.getElementById('versionStamp') ? doc.getElementById('versionStamp').textContent : '';
    if (!/^API local \u00b7 UI \d{4}-\d{2}-\d{2}\.\d+$/.test(stamp)) throw new Error('unexpected stamp: "' + stamp + '"');
    const uiVersion = w.eval('UI_VERSION'); // top-level const, not a window property
    if (!(typeof uiVersion === 'string' && stamp.endsWith(uiVersion))) throw new Error('stamp does not end with UI_VERSION');
  });
  console.log('Footer version stamp:', doc.getElementById('versionStamp').textContent);

  // Transport: when google.script.run exists (page served by Apps Script), apiFetch must use
  // it instead of cross-origin fetch, and the existing res.json() callers must keep working.
  const rpcCalls = [];
  w.google = { script: { run: (function() {
    const chain = { _ok: null, _fail: null };
    chain.withSuccessHandler = function(fn) { chain._ok = fn; return chain; };
    chain.withFailureHandler = function(fn) { chain._fail = fn; return chain; };
    chain.tsgRpc = function(query, method, body) { rpcCalls.push({ query, method }); setTimeout(() => chain._ok(JSON.stringify(fakeData)), 0); };
    return chain;
  })() } };
  await w.loadData(false, true);
  await new Promise(r => setTimeout(r, 30));
  tryCall('apiFetch routes through google.script.run when the page is served by Apps Script', () => {
    if (!rpcCalls.some(c => c.query === 'api=data' && c.method === 'GET')) throw new Error('rpc not used: ' + JSON.stringify(rpcCalls));
    if (!w.findTask(1)) throw new Error('data from rpc not loaded');
  });
  delete w.google;

  tryCall('setView(table)', () => w.setView('table'));
  tryCall('setView(cards)', () => w.setView('cards'));
  tryCall('setView(today)', () => w.setView('today'));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit(0);
}, 2500);
