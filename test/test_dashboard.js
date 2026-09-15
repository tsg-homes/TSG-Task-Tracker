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
  let FAILS = 0;
  function tryCall(label, fn) { try { fn(); console.log('OK   -', label); } catch (e) { console.log('FAIL -', label, '->', e.message); FAILS++; } }

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

  // The debounce timer must clear once it fires, or background polling stays dead after the first edit.
  w.scheduleSave();
  await new Promise(r => setTimeout(r, 900));
  tryCall('saveTimer is cleared after the debounced save fires (polling stays alive)', () => {
    if (w.eval('saveTimer') !== null) throw new Error('saveTimer still set: ' + String(w.eval('saveTimer')));
    if (w.eval('saveInFlight') !== false) throw new Error('saveInFlight still true');
  });

  // Pop-out per-person views (2026-09-15): one button per roster member except the owner,
  // opening <exec URL>?person=<Name> in a named window from this tab's session.
  const opened = [];
  w.open = function(url, name, features) { opened.push({ url, name, features }); return {}; };
  tryCall('team view buttons: one per roster member, none for Durand', () => {
    const btns = Array.from(doc.querySelectorAll('#teamViews button[data-person-view]')).map(b => b.getAttribute('data-person-view'));
    if (btns.join() !== 'Ryan') throw new Error('buttons: ' + JSON.stringify(btns));
  });
  w.alert = function() {};
  w.findTask(2).delegate = 'Ryan'; w.findTask(3).delegate = 'Ryan';   // two, so the list pop-up opens rather than a single card
  doc.querySelector('#teamViews button[data-person-view="Ryan"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  tryCall("clicking a team view button opens that person's filtered pop-up on this board", () => {
    const modal = doc.getElementById('dayViewModal');
    if (!modal.classList.contains('open')) throw new Error('pop-up not open');
    if (doc.getElementById('dayViewTitle').textContent !== "Ryan's view") throw new Error('title: ' + doc.getElementById('dayViewTitle').textContent);
    if (opened.length) throw new Error('a window was opened on a plain click');
  });
  doc.getElementById('dayViewModal').classList.remove('open');
  doc.querySelector('#teamViews button[data-person-view="Ryan"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true, shiftKey: true }));
  tryCall("shift-clicking opens ?person=<Name> in its own window", () => {
    if (opened.length !== 1 || !/\?person=Ryan$/.test(opened[0].url) || opened[0].name !== 'tsg-view-Ryan') throw new Error('opened: ' + JSON.stringify(opened));
    if (/__TSG_API_URL__/.test(opened[0].url)) throw new Error('placeholder leaked into the URL');
  });
  w.findTask(2).delegate = undefined; w.findTask(3).delegate = undefined;

  // "+ Task" on pop-up lists (task #269): the button carries the list's context into the New Task modal
  tryCall('a pop-up list carries a + Task button that pre-fills the New Task modal', () => {
    w.openMultiTaskModal('Overdue', [1, 3], { due: '2026-09-15', status: 'In Progress' });
    const btn = doc.querySelector('#dayViewActions .dv-add');
    if (!btn) throw new Error('no + Task button in the pop-up header');
    btn.click();
    if (!doc.getElementById('newTaskModal').classList.contains('open')) throw new Error('New Task modal not open');
    if (doc.getElementById('ntDue').value !== '2026-09-15') throw new Error('due not prefilled');
    if (doc.getElementById('ntStatus').value !== 'In Progress') throw new Error('status not prefilled: ' + doc.getElementById('ntStatus').value);
    if (!/Overdue/.test(doc.querySelector('.nt-context').textContent)) throw new Error('context line missing');
    w.closeNewTaskModal(); w.closeDayView();
  });
  tryCall("a person's view pop-up pre-fills the delegate; the modal's fields include delegate and tags", () => {
    w.findTask(2).delegate = 'Ryan'; w.findTask(3).delegate = 'Ryan';
    w.openPersonView('Ryan');
    doc.querySelector('#dayViewActions .dv-add').click();
    if (doc.getElementById('ntDelegate').value !== 'Ryan') throw new Error('delegate not prefilled: ' + doc.getElementById('ntDelegate').value);
    doc.getElementById('ntTitle').value = 'Chase the listing photos';
    doc.getElementById('ntGroup').value = 'Ops';
    doc.getElementById('ntTags').value = 'Listings, photos';
    const f = w.newTaskFieldsFromModal_();
    if (f.delegate !== 'Ryan' || f.tags.join() !== 'Listings,photos' || f.title !== 'Chase the listing photos' || f.group !== 'Ops') throw new Error('fields: ' + JSON.stringify(f));
    w.closeNewTaskModal(); w.closeDayView();
    w.findTask(2).delegate = undefined; w.findTask(3).delegate = undefined;
  });
  tryCall('the Errands schedule block pre-fills group Errands and tag Errand; the full-schedule view has a button per block', () => {
    const today = w.todayISO();
    const agenda = w.buildTodayAgenda(today);
    const idx = agenda.schedule.findIndex(i => i.kind === 'errand');
    if (idx === -1) throw new Error('no errand block in today\'s agenda');
    w.openScheduleDetail(today, idx);
    doc.querySelector('#dayViewActions .dv-add').click();
    if (doc.getElementById('ntGroup').value !== 'Errands' || doc.getElementById('ntTags').value !== 'Errand' || doc.getElementById('ntDue').value !== today) throw new Error('errand prefill wrong: ' + JSON.stringify([doc.getElementById('ntGroup').value, doc.getElementById('ntTags').value, doc.getElementById('ntDue').value]));
    w.closeNewTaskModal();
    w.openFullScheduleDetail(today);
    const perBlock = doc.querySelectorAll('#dayViewBody .sched-full-block-head .dv-add').length;
    if (perBlock < 3) throw new Error('expected a + Task per block, got ' + perBlock);
    w.closeDayView();
  });

  // Whole-task delegate (assignee) editable on the board row and in the modal
  tryCall('board row carries a Delegate select writing t.assignee, and it logs as Delegate', () => {
    w.setView('board');
    const sel = doc.querySelector('tr.task-row[data-id="2"] .delegate-cell select.person-select');
    if (!sel) throw new Error('no delegate select on row 2');
    sel.value = 'Ryan';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    const t = w.findTask(2);
    if (t.delegate !== 'Ryan' || 'assignee' in t) throw new Error('delegate not set / assignee not dropped: ' + JSON.stringify([t.delegate, t.assignee]));
    if (!t.history.some(h => h.field === 'delegate' && h.to === 'Ryan')) throw new Error('no delegate history');
    w.openTaskCard(2);
    const modalSel = Array.from(doc.querySelectorAll('.modal-row')).find(r => r.textContent.startsWith('Delegate'));
    if (!modalSel || !modalSel.querySelector('select.person-select') || modalSel.querySelector('select.person-select').value !== 'Ryan') throw new Error('modal Delegate row missing or wrong value');
    w.closeTopmostModal_ ? w.closeTopmostModal_() : null;
    t.delegate = ''; t.history = t.history.filter(h => h.field !== 'delegate');
  });

  tryCall('Claude is a task type and a delegate option (task and subtask), but not an owner option', () => {
    if (w.eval('TASK_TYPES').indexOf('Claude') === -1) throw new Error('TASK_TYPES lacks Claude');
    w.setView('board');
    const del = doc.querySelector('tr.task-row[data-id="2"] .delegate-cell select.person-select');
    if (!Array.from(del.options).some(o => o.value === 'Claude')) throw new Error('task delegate select lacks Claude');
    const own = doc.querySelector('tr.task-row[data-id="2"] .owner-cell:not(.delegate-cell) select.person-select');
    if (Array.from(own.options).some(o => o.value === 'Claude')) throw new Error('owner select offers Claude');
    w.toggleSub(1);
    const sub = doc.querySelector('#subrow-1 select.sub-person-select');
    if (!sub || !Array.from(sub.options).some(o => o.value === 'Claude')) throw new Error('subtask delegate select lacks Claude');
    w.toggleSub(1);
  });

  // Review gate: the Triage chip on a board row clears the tag from the task and its subitems
  w.setView('board');
  w.findTask(1).subitems[0].tags.push('Triage');
  w.renderAll();
  tryCall('a Triage tag renders as a clickable chip on the board row', () => {
    if (!doc.querySelector('tr.task-row[data-id="1"] .review-chip')) throw new Error('no review chip on task 1');
  });
  doc.querySelector('tr.task-row[data-id="1"] .review-chip').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  tryCall('clicking the chip clears Triage from the task and its subitems and logs the release', () => {
    const t = w.findTask(1);
    if (t.tags.indexOf('Triage') !== -1) throw new Error('task still tagged');
    if (t.subitems[0].tags.indexOf('Triage') !== -1) throw new Error('subitem still tagged');
    if (!t.history.some(h => h.field === 'review')) throw new Error('no release history');
  });

  tryCall('setView(table)', () => w.setView('table'));
  tryCall('setView(cards)', () => w.setView('cards'));
  tryCall('setView(today)', () => w.setView('today'));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 2500);
