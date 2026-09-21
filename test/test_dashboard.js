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
          taskType: 'Hands-on', docs: [],
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
      if (opts && opts.method === 'POST') {
        window.__posts = window.__posts || []; window.__posts.push({ url: u, body: opts.body });
        if (u.includes('target=upload')) { const body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ ok: true, url: 'https://drive.google.com/file/d/UPLOADED/view', id: 'UPLOADED', name: body.name || 'pasted-2026-09-17-120000.png', mime: body.mime, type: /^image\//.test(body.mime) ? 'image' : 'file' }) }; }
        if (u.includes('target=sendDirections')) return { ok: true, status: 200, json: async () => ({ ok: true, url: 'https://www.google.com/maps/dir/?api=1', sentTo: 'durand@thestawaszgroup.com' }) };
        if (u.includes('target=tidy')) return { ok: true, status: 200, json: async () => ({ ok: true, taskId: 2, before: { title: 'Text Marj About The Flyer Proof', notes: '', priority: 'Medium', taskType: 'Text/Chat', group: 'Marketing', estHours: 0.25, tags: [] }, proposal: { title: 'Text Marj: confirm the flyer proof is approved', notes: 'Current state: waiting on Marj.', priority: 'Medium', taskType: 'Text/Chat', group: 'Marketing', estHours: 0.25, tags: ['Flyers'], rationale: 'Sharpened the ask.' } }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, serverVersion: 1 }) };
      }
      if (u.includes('api=data')) return { ok: true, status: 200, json: async () => fakeData };
      if (u.includes('api=calendar')) return { ok: true, status: 200, json: async () => [] };
      if (u.includes('api=meetings')) { window.__meetingsFetchUrls.push(u); return { ok: true, status: 200, json: async () => ({ events: window.__pickerEvents || [], bestGuessId: null }) }; }
      if (u.includes('api=geocode')) return { ok: true, status: 200, json: async () => ({ ok: true, places: [{ label: '45 Baltimore Pike, Media, PA 19063, USA', name: '' }] }) };
      if (u.includes('api=mailSearch')) return { ok: true, status: 200, json: async () => ({ ok: true, threads: [{ url: 'https://mail.google.com/mail/u/0/#all/t9', label: 'Flyer proof thread', from: 'marj@thestawaszgroup.com', date: '2026-09-10', count: 2 }] }) };
      if (u.includes('api=meetingSlots')) { window.__slotsUrl = u; return { ok: true, status: 200, json: async () => ({ ok: true, minutes: 60, guestCalendar: false, window: 'third', slots: [{ startISO: '2026-09-22T14:00:00.000Z', endISO: '2026-09-22T15:00:00.000Z', dateLabel: 'Tue, Sep 22', timeLabel: '10:00 AM–11:00 AM' }] }) }; }
      if (u.includes('api=driveSearch')) return { ok: true, status: 200, json: async () => ({ ok: true, files: [{ name: 'Fall Flyer Draft', url: 'https://docs.google.com/document/d/FLYER/edit', mime: 'application/vnd.google-apps.document', modified: '2026-09-14' }] }) };
      if (u.includes('api=linkLabel')) return { ok: true, status: 200, json: async () => ({ ok: true, label: 'Resolved Title', kind: 'drive' }) };
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

  // Lost-save fix (2026-09-18): a save refused as stale is replayed onto the latest document
  // and saved again, instead of reloading and dropping the edit.
  await (async () => {
    const label = 'a conflicted save replays the local edit onto the fresh document and retries with the new version';
    try {
      const origFetch = w.fetch;
      w.eval('conflictReplays = 0; LAST_CONFLICT_REPLAY = null');
      w.eval('snapshotBaseline_()');
      // local edits: a task field with its history line, a step field, a new step
      const t2 = w.findTask(2);
      t2.status = 'In Progress'; t2.history.push({ ts: '2026-09-18T20:00:00Z', field: 'status', from: 'Not Started', to: 'In Progress', source: 'Durand' });
      const t1 = w.findTask(1);
      t1.subitems[0].notes = 'Found it, and confirmed.';
      t1.subitems.push({ title: 'New local step', done: false, status: 'Not Started', priority: 'Medium', tags: [], docs: [], history: [], subitems: [] });
      // the server moved on: version 7, task 2 got a new tag and task 3 a new note elsewhere
      const remote = JSON.parse(JSON.stringify(w.eval('BASELINE_DOC')));
      remote.meta.docVersion = 7; remote.meta.judgments = [{ id: 'J1' }];
      remote.tasks.find(t => t.id === 2).tags = ['Remote'];
      remote.tasks.find(t => t.id === 3).notes = 'Written by the Routine';
      let saves = 0; const bodies = [];
      w.fetch = async (url, opts) => {
        const u = String(url);
        if (opts && opts.method === 'POST') { saves++; bodies.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => (saves === 1 ? { ok: false, error: 'conflict', reason: 'stale', serverVersion: 7 } : { ok: true, docVersion: 8 }) }; }
        if (u.includes('api=data')) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(remote)) };
        return origFetch(url, opts);
      };
      await w.doSave();
      w.fetch = origFetch;
      if (saves !== 2) throw new Error('expected 2 saves, got ' + saves);
      if (bodies[1].meta.docVersion !== 7) throw new Error('retry not stamped with the fresh version: ' + bodies[1].meta.docVersion);
      const m2 = bodies[1].tasks.find(t => t.id === 2), m1 = bodies[1].tasks.find(t => t.id === 1), m3 = bodies[1].tasks.find(t => t.id === 3);
      if (m2.status !== 'In Progress' || JSON.stringify(m2.tags) !== '["Remote"]') throw new Error('task 2 merge wrong: ' + m2.status + ' ' + JSON.stringify(m2.tags));
      if (!m2.history.some(h => h.ts === '2026-09-18T20:00:00Z' && h.field === 'status')) throw new Error('history line not carried');
      if (m1.subitems[0].notes !== 'Found it, and confirmed.' || m1.subitems.length !== 2 || m1.subitems[1].title !== 'New local step') throw new Error('steps merge wrong: ' + JSON.stringify(m1.subitems.map(s => s.title)));
      if (m3.notes !== 'Written by the Routine') throw new Error('remote change lost');
      if (!Array.isArray(bodies[1].meta.judgments)) throw new Error('server-owned meta not taken from the fresh doc');
      if (w.eval('RAW_META.docVersion') !== 8 || w.eval('conflictReplays') !== 0) throw new Error('state after success: ' + w.eval('RAW_META.docVersion') + ' ' + w.eval('conflictReplays'));
      if (w.findTask(2).status !== 'In Progress' || w.findTask(3).notes !== 'Written by the Routine') throw new Error('page state not merged');
      if (!/Saved after a merge/.test((doc.getElementById('tsgToasts') || {}).textContent || '')) throw new Error('no merge toast');
      // steady state: with nothing changed locally a conflict falls back to reload-and-tell after one refetch
      w.eval('conflictReplays = 0');
      let saves2 = 0;
      w.fetch = async (url, opts) => {
        if (opts && opts.method === 'POST') { saves2++; return { ok: true, status: 200, json: async () => ({ ok: false, error: 'conflict', reason: 'stale', serverVersion: 9 }) }; }
        if (String(url).includes('api=data')) { const r = JSON.parse(JSON.stringify(remote)); r.meta.docVersion = 9; r.tasks.find(t => t.id === 2).status = 'In Progress'; return { ok: true, status: 200, json: async () => r }; }
        return origFetch(url, opts);
      };
      await w.doSave();
      w.fetch = origFetch;
      if (saves2 !== 1) throw new Error('no-change conflict should not retry: ' + saves2);
      if (!/changed elsewhere/.test(doc.getElementById('syncPill') ? doc.getElementById('syncPill').textContent : doc.body.textContent)) throw new Error('conflict warning missing');
      // back to the fixture for later tests
      w.fetch = origFetch;
      await w.loadData(false);
      console.log('OK   -', label);
    } catch (e) { console.log('FAIL -', label, '->', e.message); FAILS++; w.fetch = origFetch; }
  })();

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

  // #250 backlog batch 3 (2026-09-16): merge into, Tidy review, comment mode
  tryCall('merge: the source folds into the target (notes, subtasks, links, tags, dependents) and disappears', () => {
    w.findTask(3).notes = 'source notes'; w.findTask(3).docs = [{ url: 'https://x.test/a', label: 'A', type: 'link' }]; w.findTask(3).tags = ['Ops-tag'];
    w.findTask(3).subitems = [{ title: 'moved step', done: false, delegate: 'Durand', status: 'Not Started', tags: [], history: [] }];
    w.findTask(1).depends = '3';
    w.openTaskCard(3);
    const sel = doc.getElementById('mergeTarget'); sel.value = '2';
    if (sel.value !== '2') throw new Error('target 2 not offered');
    w.mergeTaskInto(3);
    if (w.findTask(3)) throw new Error('source still exists');
    const dst = w.findTask(2);
    if (!/Merged from #3/.test(dst.notes) || !/source notes/.test(dst.notes)) throw new Error('notes not folded: ' + dst.notes);
    if (!dst.subitems.some(s => s.title === 'moved step')) throw new Error('subtask not moved');
    if (!dst.docs.some(x => x.url === 'https://x.test/a') || dst.tags.indexOf('Ops-tag') === -1) throw new Error('links/tags not merged');
    if (w.findTask(1).depends !== '2') throw new Error('dependent not repointed: ' + w.findTask(1).depends);
    if (!dst.history.some(h => h.field === 'merged-from')) throw new Error('no merge history');
    w.closeTaskCard();
    w.findTask(1).depends = ''; dst.subitems = []; dst.docs = []; dst.tags = []; dst.notes = ''; dst.depends = '';
    w.eval('TASKS').push({ id: 3, title: 'Overdue Task With A Past Due Date', owner: 'Durand', status: 'In Progress', priority: 'Medium', group: 'Ops', tags: [], taskType: 'Meeting', timelineEnd: '2026-09-02', progress: 0, depends: '', doc: '', docs: [], notes: '', estHours: 1, estDays: 1, estSource: 'claude', history: [{ ts: '2026-08-20T12:00:00Z', field: 'created', from: null, to: null }], subitems: [] });
  });
  await (async () => {
    try {
      w.openTaskCard(2);
      await w.tidyTask(2);
      const rows = doc.querySelectorAll('.tidy-row');
      if (!doc.getElementById('dayViewModal').classList.contains('open') || rows.length !== 3) throw new Error('review rows: ' + rows.length);
      const notesPick = Array.from(doc.querySelectorAll('.tidy-pick')).find(el => el.value === 'notes'); notesPick.checked = false;
      w.applyTidy_();
      const t2 = w.findTask(2);
      if (t2.title !== 'Text Marj: confirm the flyer proof is approved' || t2.tags.indexOf('Flyers') === -1) throw new Error('accepted fields not applied');
      if (t2.notes !== '') throw new Error('unchecked notes were applied');
      if (!t2.history.some(h => h.field === 'title' && /Claude \(tidy\)/.test(h.source))) throw new Error('tidy not logged with its source');
      t2.title = 'Text Marj About The Flyer Proof'; t2.tags = [];
      w.closeTaskCard();
      console.log('OK   - tidy: the proposal is reviewed per field and only accepted fields apply, logged as Claude (tidy)');
    } catch (e) { console.log('FAIL - tidy ->', e.message); FAILS++; }
    try {
      w.setView('board');
      w.toggleCommentMode();
      if (!doc.body.classList.contains('comment-mode')) throw new Error('comment mode not on');
      doc.querySelector('tr.task-row[data-id="2"] td.title-cell').dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
      const pop = doc.getElementById('commentPopover');
      if (!pop || !/#2 Text Marj/.test(pop.textContent)) throw new Error('popover not anchored to task 2');
      doc.getElementById('commentText').value = 'Check with Marj first';
      await w.saveCommentFromPopover_();
      await new Promise(r => setTimeout(r, 10));
      const posts = w.__posts || [];
      const last = posts[posts.length - 1] && JSON.parse(posts[posts.length - 1].body);
      if (!last || last.op !== 'add_comment' || last.comment.anchor.id !== 2 || last.comment.text !== 'Check with Marj first') throw new Error('add_comment not posted: ' + JSON.stringify(last));
      if (!doc.querySelector('tr.task-row[data-id="2"] .comment-badge')) throw new Error('no comment badge on the row');
      if (doc.getElementById('commentCount').textContent !== '1') throw new Error('toolbar count wrong');
      // nothing clicks through in comment mode (2026-09-18): a toolbar button and a row select are comment targets, and mousedown is swallowed
      const tb = doc.querySelector('.toolbar button, .toolbar select') || doc.querySelector('#btnNewTask');
      const md = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); tb.dispatchEvent(md);
      if (!md.defaultPrevented) throw new Error('mousedown not swallowed in comment mode');
      tb.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      if (!doc.getElementById('commentPopover')) throw new Error('toolbar element not commentable');
      w.closeCommentPopover_();
      const sel = doc.querySelector('tr.task-row[data-id="2"] select');
      if (sel) { const md2 = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); sel.dispatchEvent(md2); if (!md2.defaultPrevented) throw new Error('row select still opens in comment mode'); }
      const cb = doc.getElementById('btnComments'); const md3 = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); cb.dispatchEvent(md3);
      if (md3.defaultPrevented) throw new Error('the Comments button must stay live');
      // hover highlight + Esc ends commenting (2026-09-18)
      const hdr = doc.querySelector('header.masthead .wordmark');
      hdr.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
      if (!hdr.classList.contains('comment-hover')) throw new Error('hovered element not highlighted');
      doc.querySelector('tr.task-row[data-id="2"] td.title-cell').dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
      if (hdr.classList.contains('comment-hover') || !doc.querySelector('tr.task-row[data-id="2"]').classList.contains('comment-hover')) throw new Error('highlight did not move to the row');
      doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (doc.body.classList.contains('comment-mode') || doc.getElementById('commentPopover') || doc.querySelector('.comment-hover')) throw new Error('Esc did not end commenting');
      if (!doc.querySelector('header.masthead .masthead-right #btnCommentMode') || !doc.querySelector('header.masthead .masthead-right #btnComments') || doc.querySelector('.toolbar #btnCommentMode')) throw new Error('comment buttons are not up by settings/dark mode');
      w.eval("RAW_META.judgments = [{ id: 'J9', kind: 'comment', commentId: 'cX', taskId: 285, text: 'x' }]");
      if (!/J9 \(comment cX on #285\)/.test(w.judgePromptFor_()) || !/\{reply, resolved\}/.test(w.judgePromptFor_())) throw new Error('judge prompt does not describe comment requests');
      w.eval("RAW_META.judgments = []");
      w.openCommentsPanel();
      if (!doc.querySelector('.comment-item')) throw new Error('panel empty');
      const cid = w.eval('COMMENTS')[0].id;
      await w.setCommentResolved_(cid, true);
      if (doc.getElementById('commentCount').textContent !== '') throw new Error('resolved comment still counted');
      await w.deleteComment_(cid);
      w.closeDayView();
      console.log('OK   - comment mode: click anchors a comment to the task, posts add_comment, shows badge and count, resolve/delete work');
    } catch (e) { console.log('FAIL - comment mode ->', e.message); FAILS++; w.closeDayView(); if (doc.body.classList.contains('comment-mode')) w.toggleCommentMode(); }
  })();

  // #250 backlog batch 2 (2026-09-16): link picker with Drive search and real labels; recurring series links
  await (async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    try {
      w.addManualDoc(2, null);
      if (!doc.getElementById('linkModal').classList.contains('open')) throw new Error('link picker did not open');
      doc.getElementById('linkSearch').value = 'fall flyer';
      w.onLinkSearchInput_();
      await wait(400);
      const row = doc.querySelector('#linkResults .meeting-row');
      if (!row || !/Fall Flyer Draft/.test(row.textContent)) throw new Error('no search result rendered');
      row.click();
      const docs2 = w.findTask(2).docs;
      if (!docs2.some(x => x.url === 'https://docs.google.com/document/d/FLYER/edit' && x.label === 'Fall Flyer Draft')) throw new Error('picked file not added with its name: ' + JSON.stringify(docs2));
      if (doc.getElementById('linkModal').classList.contains('open')) throw new Error('picker stayed open');
      w.addManualDoc(2, null);
      doc.getElementById('linkPaste').value = 'https://docs.google.com/document/d/PASTED/edit';
      await w.addPastedLink_();
      if (!w.findTask(2).docs.some(x => x.url.indexOf('PASTED') !== -1 && x.label === 'Resolved Title')) throw new Error('pasted link did not take the resolved label');
      w.findTask(2).docs = [];
      console.log('OK   - link picker: Drive search adds the file under its own name; a pasted link gets its resolved label');
    } catch (e) { console.log('FAIL - link picker ->', e.message); FAILS++; w.closeLinkPicker(); }
    try {
      w.eval('MEETING_PICKER_TARGET = { taskId: 3, subIdx: null }');
      const ev = { id: 'evt1', recurring: true, seriesId: 'SERIES-1', title: 'Weekly check-in', start: '2026-09-22T14:00:00.000Z', end: '2026-09-22T15:00:00.000Z', dateLabel: 'Tue, Sep 22', timeLabel: '10:00 AM–11:00 AM', htmlLink: 'https://calendar.google.com/event?eid=abc' };
      await w.linkMeetingToTarget(ev, true);
      const t3 = w.findTask(3);
      if (t3.meetingSeriesId !== 'SERIES-1' || !t3.docs.some(x => x.seriesId === 'SERIES-1' && /every occurrence/.test(x.label))) throw new Error('series link not recorded: ' + JSON.stringify([t3.meetingSeriesId, t3.docs]));
      const today = w.todayISO();
      const CAL = w.eval('CALENDAR_EVENTS');
      CAL.push({ title: 'Weekly check-in', seriesId: 'SERIES-1', date: today, start: '10:00', end: '11:00', hours: 1, bufferedHours: 1.17 });
      const match = w.todayMeetingBlockMatch_({ meetingSeriesId: 'SERIES-1', meetingDate: '2026-09-22', meetingStart: '10:00' }, today);
      if (!match || match.seriesId !== 'SERIES-1') throw new Error('series occurrence today not matched');
      CAL.pop(); delete t3.meetingSeriesId; t3.docs = []; delete t3.meetingDate; delete t3.meetingStart; delete t3.meetingEnd;
      console.log('OK   - recurring: linking the series stamps meetingSeriesId and any occurrence of the series matches on the schedule');
    } catch (e) { console.log('FAIL - recurring series ->', e.message); FAILS++; }
  })();

  // #250 backlog batch 1 (2026-09-16): Durand first, group dropdown, tag autocomplete, dependencies in the modal, dense cards
  tryCall('people lists put Durand first, then A to Z', () => {
    if (w.sortPeople_(['Ryan', 'Alex', 'Durand', 'Marj']).join() !== 'Durand,Alex,Marj,Ryan') throw new Error('sortPeople_ wrong');
    if (w.rosterNames()[0] !== 'Durand') throw new Error('rosterNames not Durand-first');
  });
  tryCall('task modal: Group is a dropdown with the current group selected and a + New group entry', () => {
    w.openTaskCard(2);
    const sel = doc.querySelector('.modal-group-select');
    if (!sel || sel.value !== 'Marketing') throw new Error('group select missing or wrong: ' + (sel && sel.value));
    if (!Array.from(sel.options).some(o => o.value === '__new__')) throw new Error('no + New group entry');
    sel.value = 'Ops'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    if (w.findTask(2).group !== 'Ops' || !w.findTask(2).history.some(h => h.field === 'group' && h.to === 'Ops')) throw new Error('group change not applied/logged');
    w.findTask(2).group = 'Marketing';
  });
  tryCall('task modal: dependencies can be added and removed with history', () => {
    w.findTask(2).depends = ''; w.findTask(2).history = w.findTask(2).history.filter(h => h.field !== 'depends');
    w.openTaskCard(2);
    const sel = doc.querySelector('.modal-depends-select');
    if (!sel) throw new Error('no depends select');
    sel.value = '3'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    if (w.findTask(2).depends !== '3') throw new Error('depends not set: ' + w.findTask(2).depends);
    if (!doc.querySelector('.depends-chip')) throw new Error('no depends chip rendered');
    w.modalRemoveDepends(2, 3);
    if (w.findTask(2).depends !== '') throw new Error('depends not removed: ' + JSON.stringify(w.findTask(2).depends));
    if (w.findTask(2).history.filter(h => h.field === 'depends').length !== 2) throw new Error('depends history not logged twice');
  });
  tryCall('task modal: tag input autocompletes from the board and adds on Enter', () => {
    w.openTaskCard(2);
    const dl = doc.getElementById('tagOptions');
    if (!dl || !Array.from(dl.options).some(o => o.value === 'Triage')) throw new Error('tag datalist not populated');
    const inp = doc.querySelector('.tag-input');
    if (!inp || inp.getAttribute('list') !== 'tagOptions') throw new Error('tag input missing datalist');
    inp.value = 'Flyers';
    inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (w.findTask(2).tags.indexOf('Flyers') === -1) throw new Error('tag not added');
    w.findTask(2).tags = w.findTask(2).tags.filter(x => x !== 'Flyers');
    if (!doc.querySelector('#taskModal .modal-notes[spellcheck="true"]')) throw new Error('notes not spellchecked');
    w.closeTaskCard();
  });
  tryCall('cards view: a group past the threshold renders dense cards with a toggle back to full', () => {
    const extra = [];
    for (let i = 0; i < 14; i++) extra.push({ id: 900 + i, title: 'Bulk ' + i, owner: 'Durand', status: 'Not Started', priority: 'Low', group: 'Bulk', tags: [], timelineEnd: '', progress: 0, depends: '', doc: '', docs: [], notes: '', history: [], subitems: [] });
    extra.forEach(t => w.eval('TASKS').push(t));
    w.setView('card');
    if (!doc.querySelector('.card-grid.dense')) throw new Error('no dense grid');
    doc.querySelector('.dense-toggle').click();
    if (doc.querySelector('.card-grid.dense')) throw new Error('toggle did not switch to full cards');
    doc.querySelector('.dense-toggle').click();
    const T = w.eval('TASKS'); for (let i = T.length - 1; i >= 0; i--) if (T[i].id >= 900) T.splice(i, 1);
    w.setView('board');
  });

  // Errand tasks sit inside the Errands block (2026-09-16)
  tryCall("an Errands-group task due today is placed inside the Errands block, not as its own work block, and grows the block", () => {
    const today = w.todayISO();
    const T = w.eval('TASKS');
    T.push({ id: 910, title: 'Drop off the lockbox', owner: 'Durand', status: 'Not Started', priority: 'Medium', group: 'Errands', tags: [], taskType: 'Hands-on',
      timelineEnd: today, progress: 0, depends: '', doc: '', docs: [], notes: '', estHours: 0.5, estDays: 1, estSource: 'claude', location: '45 Baltimore Pike', travelMin: 30, history: [], subitems: [] });
    const agenda = w.buildTodayAgenda(today);
    const errand = agenda.schedule.find(i => i.kind === 'errand');
    if (!errand) throw new Error('no Errands block');
    if (!errand.items || errand.items.length !== 1 || errand.items[0].task.id !== 910) throw new Error('errand task not inside the block: ' + JSON.stringify(errand.items));
    if (errand.items[0].minutes !== 60) throw new Error('minutes should be 30 est + 30 travel, got ' + errand.items[0].minutes);
    if (errand.end - errand.start !== 60) throw new Error('block did not grow to 60 min: ' + (errand.end - errand.start));
    if (agenda.schedule.some(i => i.kind === 'task' && i.items.some(c => c.task.id === 910))) throw new Error('errand task also placed as a work block');
    if (agenda.unplaced.some(b => b.items.some(c => c.task.id === 910))) throw new Error('errand task listed as unplaced');
    w.setView('today'); w.renderAll();
    const line = [...doc.querySelectorAll('.today-item.type-errand .today-task-line')].find(el => /lockbox/.test(el.textContent));
    if (!line) throw new Error('errand task line not rendered inside the Errands block');
    if (!/30m travel/.test(line.textContent)) throw new Error('travel not shown: ' + line.textContent);
    w.setView('board');
    for (let i = T.length - 1; i >= 0; i--) if (T[i].id === 910) T.splice(i, 1);
  });
  // Lockout while an add is saving (2026-09-16). The harness exits synchronously at the end of
  // this callback, so the post-answer half waits one timer tick for the add's continuation.
  let addSettled = null, origFetch = w.fetch;
  tryCall('the New Task modal is inert and cannot be closed while its add is in flight', () => {
    w.openNewTaskModal({ group: 'Ops' });
    doc.getElementById('ntTitle').value = 'Lockout check task';
    doc.getElementById('ntGroup').value = 'Ops';
    doc.getElementById('ntLocation').value = '12 Elm St';
    w.eval("window.__release = null; window.fetch = (url, opts) => new Promise(res => { window.__release = () => res({ ok: true, status: 200, json: async () => ({ ok: true, docVersion: 9, addResult: { verdict: 'added', taskId: 911 } }) }); });");
    const p = w.confirmNewTask(doc.getElementById('ntConfirmBtn'));
    const modal = doc.getElementById('newTaskModal');
    if (!modal.classList.contains('busy')) throw new Error('modal not marked busy during the add');
    w.closeNewTaskModal();
    if (!modal.classList.contains('open')) throw new Error('modal closed while busy');
    if (!w.eval('NT_BUSY')) throw new Error('NT_BUSY not set');
    p.then(() => { addSettled = 'ok'; }, e => { addSettled = e; });
    w.__release();
  });
  await new Promise(r => setTimeout(r, 30));
  w.fetch = origFetch;
  tryCall('after the add answers, the modal unlocks, closes, and the location was sent', () => {
    if (addSettled !== 'ok') throw new Error('add did not settle cleanly: ' + String(addSettled));
    const modal = doc.getElementById('newTaskModal');
    if (modal.classList.contains('busy')) throw new Error('busy not cleared after the add');
    if (modal.classList.contains('open')) throw new Error('modal should close after a successful add');
    if (w.eval('NT_BUSY')) throw new Error('NT_BUSY still set');
    const added = w.findTask(911);
    if (!added || added.location !== '12 Elm St') throw new Error('location not sent with the new task');
    const T = w.eval('TASKS'); for (let i = T.length - 1; i >= 0; i--) if (T[i].id === 911) T.splice(i, 1);
  });
  tryCall('the task modal shows a Location row with the round trip and Settings has a Home base field', () => {
    const t = w.findTask(3); t.location = 'Courthouse, Media PA'; t.travelMin = 40;
    w.openTaskCard(3);
    const row = [...doc.querySelectorAll('#modalMeta .modal-row')].find(r => /Location/.test(r.textContent));
    if (!row) throw new Error('no Location row');
    if (!/Courthouse/.test(row.textContent) || !/40 min round trip/.test(row.textContent)) throw new Error('location or travel missing: ' + row.textContent);
    w.closeTaskCard();
    delete t.location; delete t.travelMin;
    w.eval("RULESETS = { meta: {}, current: {}, history: [], threads: {} }; rulesetsLoaded = true;");
    w.setSettingsTab('general');
    if (!doc.getElementById('homeBaseInput') || !doc.getElementById('claudeRepoInput') || !doc.getElementById('inboxErrorsList')) throw new Error('General tab missing home base / repo / inbox errors');
    if (!doc.getElementById('claudeSessionInput')) throw new Error('General tab missing the working session field');
    w.setSettingsTab('team');
    if (doc.getElementById('homeBaseInput') || !doc.getElementById('newRosterName')) throw new Error('Team tab should hold only the roster');
  });

  // Location picker, travel mode + total, tidy through the judgment queue (2026-09-16)
  await (async () => {
    try {
      const t3 = w.findTask(3);
      t3.location = ''; delete t3.travelMin; delete t3.travelOneWayMin; delete t3.travelMode;
      w.openTaskCard(3);
      const locRow = [...doc.querySelectorAll('#modalMeta .modal-row')].find(r => /Location/.test(r.textContent));
      locRow.querySelector('button.icon-btn').click();
      if (!doc.getElementById('locationModal').classList.contains('open')) throw new Error('location picker did not open');
      doc.getElementById('locationSearch').value = '45 Balt';
      await w.runLocationSearch_();
      const rows = doc.querySelectorAll('#locationResults .meeting-row');
      if (rows.length !== 1 || !/Baltimore Pike/.test(rows[0].textContent)) throw new Error('geocode results not listed: ' + rows.length);
      rows[0].click();
      if (doc.getElementById('locationModal').classList.contains('open')) throw new Error('picker stayed open after a pick');
      if (w.findTask(3).location !== '45 Baltimore Pike, Media, PA 19063, USA') throw new Error('picked address not set: ' + w.findTask(3).location);
      if (!w.findTask(3).history.some(h => h.field === 'location')) throw new Error('location change not logged');
      console.log('OK   - location picker: geocode search results are listed and a pick sets the task location');
    } catch (e) { console.log('FAIL - location picker ->', e.message); FAILS++; }
    try {
      const t3 = w.findTask(3);
      t3.estHours = 1; t3.travelMin = 30; t3.travelOneWayMin = 15; t3.travelMode = 'round';
      w.openTaskCard(3);
      const sel = doc.querySelector('#modalMeta .modal-travel-mode');
      if (!sel || sel.value !== 'round') throw new Error('travel select missing or wrong default');
      if (!/1\.5h total/.test(doc.querySelector('#modalMeta .modal-total').textContent)) throw new Error('round-trip total wrong: ' + doc.querySelector('#modalMeta .modal-total').textContent);
      w.modalTravelModeChange(3, 'oneway');
      if (!/1\.25h total/.test(doc.querySelector('#modalMeta .modal-total').textContent)) throw new Error('one-way total wrong');
      if (!t3.history.some(h => h.field === 'travelMode' && h.to === 'oneway')) throw new Error('mode change not logged');
      const cardHtml = w.taskCardHtml(w.findTask(3));
      if (!/15m drive one-way/.test(cardHtml) || !/1\.25h total/.test(cardHtml)) throw new Error('card badge missing the chosen travel/total: ' + cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
      w.modalTravelModeChange(3, 'none');
      const items = w.getTodayErrandItems(w.todayISO());
      w.closeTaskCard();
      console.log('OK   - travel mode: one-way / round trip / none is a per-task choice, the total follows it, the card shows both');
    } catch (e) { console.log('FAIL - travel mode ->', e.message); FAILS++; }
    try {
      const T = w.eval('TASKS');
      T.push({ id: 912, title: 'Drop off the keys', owner: 'Durand', status: 'Not Started', priority: 'Medium', group: 'Errands', tags: [], taskType: 'Hands-on', timelineEnd: w.todayISO(), progress: 0, depends: '', doc: '', docs: [], notes: '', estHours: 0.5, estDays: 1, estSource: 'claude', location: 'x', travelMin: 30, travelOneWayMin: 15, travelMode: 'oneway', history: [], subitems: [] });
      const it = w.getTodayErrandItems(w.todayISO()).find(c => c.task.id === 912);
      if (!it || it.minutes !== 45 || it.travelMin !== 15) throw new Error('errand minutes should be 30 + 15 one-way, got ' + (it && it.minutes));
      for (let i = T.length - 1; i >= 0; i--) if (T[i].id === 912) T.splice(i, 1);
      console.log('OK   - errand block minutes follow the chosen travel mode');
    } catch (e) { console.log('FAIL - errand minutes per mode ->', e.message); FAILS++; }
    try {
      const alerts = [];
      w.alert = (m) => alerts.push(String(m));
      const origFetch = w.fetch;
      w.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('target=tidy')) return { ok: true, status: 200, json: async () => ({ ok: true, queued: true, taskId: 3 }) };
        return origFetch(url, opts);
      };
      w.openTaskCard(3);
      await w.tidyTask(3);
      if (!alerts.some(a => /Queued\. Claude re-judges/.test(a))) throw new Error('no queued notice: ' + JSON.stringify(alerts));
      if (!/Claude queued/.test(doc.getElementById('tidyBtn').textContent)) throw new Error('button not showing the pending state: ' + doc.getElementById('tidyBtn').textContent);
      const estRow = [...doc.querySelectorAll('#modalMeta .modal-row')].find(r => /Estimate/.test(r.textContent));
      if (!/queued for Claude/.test(estRow.textContent)) throw new Error('Estimate row not showing the pending state');
      w.fetch = origFetch;
      w.eval('RAW_META').judgments = [];
      w.refreshTidyButton_(3);
      if (!/Re-run Claude/.test(doc.getElementById('tidyBtn').textContent)) throw new Error('button not back to Re-run Claude');
      w.closeTaskCard();
      console.log('OK   - tidy is automatic: the button queues a forced re-run, shows "Claude queued" and the Estimate row says queued for Claude');
    } catch (e) { console.log('FAIL - tidy via the queue ->', e.message); FAILS++; }
    try {
      w.openNewTaskModal({});
      doc.getElementById('ntTitle').value = '';
      doc.getElementById('ntNotes').value = 'need to call the title co about the farina closing, friday works, get the deed copy first';
      w.eval("window.fetch = async (url, opts) => ({ ok: true, status: 200, json: async () => ({ ok: true, docVersion: 9, addResult: { verdict: 'added', taskId: 913 } }) });");
      await w.confirmNewTask(doc.getElementById('ntConfirmBtn'));
      const added = w.findTask(913);
      if (!added) throw new Error('note-only task not created');
      if (!/^need to call the title co about the farina closing/.test(added.title) || added.title.length > 80 || !/…$/.test(added.title)) throw new Error('working title should be the first line, trimmed to 80: ' + added.title);
      if (added.group !== 'Unsorted') throw new Error('group should default to Unsorted for a note-only task: ' + added.group);
      const T = w.eval('TASKS'); for (let i = T.length - 1; i >= 0; i--) if (T[i].id === 913) T.splice(i, 1);
      w.fetch = origFetch;
      console.log('OK   - a note alone creates a task: first line as the working title, Unsorted group, the rest left to Claude');
    } catch (e) { console.log('FAIL - note-only add ->', e.message); FAILS++; }
  })();

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

  // Pinned tasks (2026-09-16): always first in every list, own section on top of Board and Cards
  w.setView('board');
  w.findTask(1).tags = w.findTask(1).tags.filter(x => x !== 'Triage');
  tryCall('togglePin pins a task and logs it', () => {
    w.togglePin(3);
    const t = w.findTask(3);
    if (t.pinned !== true) throw new Error('not pinned');
    if (!t.history.some(h => h.field === 'pinned' && h.to === true)) throw new Error('no history');
  });
  tryCall('board view renders the Pinned section before every group and drops the task from its group', () => {
    const html = doc.getElementById('board').innerHTML;
    const pin = html.indexOf('data-group="__pinned__"');
    const firstGroup = html.search(/data-group="(?!__pinned__)/);
    if (pin === -1) throw new Error('no pinned section');
    if (firstGroup !== -1 && firstGroup < pin) throw new Error('pinned section is not first');
    const rows = Array.from(doc.querySelectorAll('tr.task-row[data-id="3"]'));
    if (rows.length !== 1) throw new Error('expected task 3 once, got ' + rows.length);
    if (!rows[0].closest('.pinned-group')) throw new Error('task 3 row is not inside the pinned section');
    if (!rows[0].querySelector('.pin-btn.on')) throw new Error('row pin button not lit');
  });
  tryCall('sortTasks puts pinned tasks first whatever the sort', () => {
    doc.getElementById('sortBy1').value = 'title';
    const arr = w.eval('TASKS').slice();
    w.sortTasks(arr);
    if (arr[0].id !== 3) throw new Error('first is #' + arr[0].id);
    doc.getElementById('sortBy1').value = '';
    const arr2 = w.eval('TASKS').slice();
    w.sortTasks(arr2);
    if (arr2[0].id !== 3) throw new Error('unsorted first is #' + arr2[0].id);
  });
  tryCall('cards view has the pinned section first', () => {
    w.setView('card');
    const html = doc.getElementById('board').innerHTML;
    const i = html.indexOf('card-group pinned-group');
    if (i === -1) throw new Error('no pinned card group');
    if (html.indexOf('class="card-group"') !== -1 && html.indexOf('class="card-group"') < i) throw new Error('not first');
  });
  tryCall('modal shows the pin state and unpinning drops the section', () => {
    w.openTaskCard(3);
    if (!doc.getElementById('pinBtn').classList.contains('toggle-active')) throw new Error('modal pin not lit');
    w.togglePin(3);
    if (w.findTask(3).pinned) throw new Error('still pinned');
    w.setView('board');
    if (doc.getElementById('board').innerHTML.includes('__pinned__')) throw new Error('pinned section still rendered');
    w.closeTaskCard();
  });

  // Notes clamp + pop-up (2026-09-17)
  w.setView('board');
  w.findTask(1).notes = 'line one\nline two\nline three\nline four\n' + 'x'.repeat(200);
  w.renderAll();
  tryCall('row notes are clamped and flagged long', () => {
    const el = doc.querySelector('tr.task-row[data-id="1"] td.notes-cell .note-clamp');
    if (!el) throw new Error('no clamped notes span');
    if (!el.classList.contains('note-long')) throw new Error('long note not flagged');
  });
  tryCall('a note that fits edits inline (clamp lifted while focused)', () => {
    w.noteOverflows_ = () => false;
    const el = doc.querySelector('tr.task-row[data-id="1"] td.notes-cell .note-clamp');
    w.noteFocus_(el, 'task', 1, null);
    if (!el.classList.contains('editing')) throw new Error('editing class missing');
    if (doc.getElementById('noteModal').classList.contains('open')) throw new Error('popup opened for a fitting note');
    el.classList.remove('editing');
  });
  tryCall('a note that overflows opens the pop-up instead of editing inline', () => {
    w.noteOverflows_ = () => true;
    const el = doc.querySelector('tr.task-row[data-id="1"] td.notes-cell .note-clamp');
    w.noteFocus_(el, 'task', 1, null);
    if (el.classList.contains('editing')) throw new Error('should not edit inline');
    if (!doc.getElementById('noteModal').classList.contains('open')) throw new Error('popup not open');
    if (!doc.getElementById('noteModalText').value.startsWith('line one')) throw new Error('popup lacks the note text');
  });
  tryCall('saving the pop-up writes the note, logs it and closes', () => {
    doc.getElementById('noteModalText').value = 'rewritten from the pop-up';
    w.saveNotePopup();
    if (w.findTask(1).notes !== 'rewritten from the pop-up') throw new Error('note not saved');
    if (!w.findTask(1).history.some(h => h.field === 'notes' && h.to === 'rewritten from the pop-up')) throw new Error('no history');
    if (doc.getElementById('noteModal').classList.contains('open')) throw new Error('popup still open');
  });
  tryCall('subtask notes use the same pop-up and Escape closes it', () => {
    w.findTask(1).subitems[0].notes = 'sub note text';
    w.renderAll();
    w.openNotePopup('sub', 1, 0);
    if (doc.getElementById('noteModalText').value !== 'sub note text') throw new Error('sub note not loaded');
    if (!w.closeTopmostModal_()) throw new Error('escape did not close');
    if (doc.getElementById('noteModal').classList.contains('open')) throw new Error('still open');
    w.noteOverflows_ = (el) => el.scrollHeight > el.clientHeight + 1;
  });

  // New Task modal: type and links (2026-09-17)
  tryCall('New Task modal has a Type select and a Links row', () => {
    w.openNewTaskModal({ group: 'Ops' });
    if (!doc.getElementById('ntType')) throw new Error('no type select');
    if (!doc.getElementById('ntDocs')) throw new Error('no links row');
    if (!doc.getElementById('ntDocs').textContent.includes('No links yet')) throw new Error('links row not empty on open');
  });
  tryCall('the link picker collects Drive/pasted links for the pending task', () => {
    w.addManualDoc('__new__');
    if (!doc.getElementById('linkModal').classList.contains('open')) throw new Error('picker not open');
    w.addDocToTarget_('https://docs.google.com/document/d/FLYER/edit', 'Fall Flyer Draft');
    if (doc.getElementById('linkModal').classList.contains('open')) throw new Error('picker still open');
    if (!doc.getElementById('ntDocs').textContent.includes('Fall Flyer Draft')) throw new Error('chip missing');
  });
  tryCall('a picked meeting stamps the meeting fields and defaults the type to Meeting', () => {
    w.addManualDoc('__new__');
    w.eval("LINK_MEETINGS = [{ id: 'ev1', title: 'Team Meeting', htmlLink: 'https://calendar.google.com/event?eid=ev1', start: '2026-09-22T14:00:00Z', end: '2026-09-22T14:30:00Z', dateLabel: 'Tue 9/22' }]");
    w.addLinkMeeting_(0);
    if (doc.getElementById('ntType').value !== 'Meeting') throw new Error('type not defaulted: ' + doc.getElementById('ntType').value);
    if (!doc.getElementById('ntDocs').textContent.includes('Team Meeting')) throw new Error('meeting chip missing');
  });
  tryCall('Create sends taskType, docs and the meeting stamp', () => {
    doc.getElementById('ntTitle').value = 'Prep for the team meeting';
    const fields = w.newTaskFieldsFromModal_();
    if (fields.taskType !== 'Meeting') throw new Error('taskType missing');
    if (!fields.docs || fields.docs.length !== 2) throw new Error('docs count ' + (fields.docs || []).length);
    if (!fields.meetingDate || !fields.meetingStart) throw new Error('meeting stamp missing');
    doc.getElementById('ntType').value = 'Call';
    if (w.newTaskFieldsFromModal_().taskType !== 'Call') throw new Error('explicit type not sent');
  });
  tryCall('removing a chip drops the link; a fresh open starts empty', () => {
    w.ntRemoveDoc_(1);
    if (w.newTaskFieldsFromModal_().meetingDate) throw new Error('meeting stamp not cleared');
    w.closeNewTaskModal();
    w.openNewTaskModal({});
    if (w.newTaskFieldsFromModal_().docs) throw new Error('links leaked into the next open');
    w.closeNewTaskModal();
  });

  // Links every update (2026-09-17): mail search in the picker, Claude prompt, directions, meeting slots
  tryCall('the separate mail search box is gone (email rides in the one picker search, tested below)', () => {
    w.openNewTaskModal({});
    w.addManualDoc('__new__');
    if (doc.getElementById('linkMailSearch') || doc.getElementById('linkMailResults')) throw new Error('separate mail search still rendered');
    w.closeNewTaskModal();
  });
  tryCall('the Claude prompt carries the task, its steps, links and the write-back instruction', () => {
    const t = w.findTask(1);
    const p = w.claudePromptFor_(t);
    if (!p.startsWith('/optimize-prompt\n')) throw new Error('prompt does not invoke optimize-prompt');
    if (!p.includes('task #1') || !p.includes(t.title)) throw new Error('missing head');
    if (!p.includes('Steps:') || !p.includes(t.subitems[0].title)) throw new Error('missing steps');
    if (!p.includes('tsg-task-tracker-protocol')) throw new Error('missing write-back instruction');
    const links = w.claudeLinksFor_(t);
    if (!links.cowork.startsWith('claude://cowork/new?q=%2Foptimize-prompt')) throw new Error('bad cowork url: ' + links.cowork.slice(0, 40));
    if (!links.code.startsWith('claude://code/new?q=%2Foptimize-prompt') || links.code.includes('&repo=')) throw new Error('bad code url: ' + links.code.slice(0, 40));
    if (!links.cloud.startsWith('https://claude.ai/code?prompt=%2Foptimize-prompt')) throw new Error('bad cloud url: ' + links.cloud.slice(0, 40));
    w.eval("CLAUDE_REPO = 'tsg-homes/task-tracker'");
    const withRepo = w.claudeLinksFor_(t);
    if (!withRepo.code.endsWith('&repo=tsg-homes%2Ftask-tracker') || !withRepo.cloud.endsWith('&repositories=tsg-homes%2Ftask-tracker')) throw new Error('repo not applied');
    if (withRepo.cowork.includes('repo')) throw new Error('cowork must not carry a repo');
    if (JSON.stringify(withRepo).includes('claude.ai/new')) throw new Error('plain chat link still present');
  });
  tryCall('a Claude-typed task shows the Open in Claude row; a task with a claude.ai link too', () => {
    const t = w.findTask(1);
    const prevType = t.taskType;
    t.taskType = 'Claude';
    w.openTaskCard(1);
    const rowHtml = doc.getElementById('modalMeta').innerHTML;
    if (!rowHtml.includes('>Cowork<') || !rowHtml.includes('>Code<') || !rowHtml.includes('Code (cloud)')) throw new Error('Claude row buttons missing');
    t.taskType = prevType;
    t.docs = (t.docs || []).concat([{ url: 'https://claude.ai/code/session_01XYZ', label: 'Claude Code session', type: 'claude' }]);
    w.openTaskCard(1);
    if (!doc.getElementById('modalMeta').innerHTML.includes('Open linked session')) throw new Error('no linked-session button');
    t.docs = t.docs.filter(x => x.type !== 'claude');
    w.closeTaskCard();
  });
  tryCall('a located task shows Directions and Send to phone; sending posts the location', () => {
    const t = w.findTask(1);
    t.location = '45 Baltimore Pike, Media, PA';
    w.openTaskCard(1);
    const html = doc.getElementById('modalMeta').innerHTML;
    if (!html.includes('Send to phone') || !html.includes('google.com/maps/dir/')) throw new Error('buttons missing');
    w.__posts = [];
    w.sendDirections(1, null);
  });
  await new Promise(r => setTimeout(r, 30));
  tryCall('sendDirections posted to target=sendDirections with the location', () => {
    const p = (w.__posts || []).find(x => x.url.includes('target=sendDirections'));
    if (!p) throw new Error('no post');
    if (!JSON.parse(p.body).location.includes('Baltimore')) throw new Error('location missing');
    w.findTask(1).location = '';
    w.closeTaskCard();
  });
  tryCall('meeting buckets follow Google durations', () => {
    if (w.meetingBucket_(0.2) !== 15 || w.meetingBucket_(0.5) !== 30 || w.meetingBucket_(0.6) !== 45 || w.meetingBucket_(1) !== 60 || w.meetingBucket_(1.25) !== 90 || w.meetingBucket_(3) !== 120 || w.meetingBucket_(null) !== 30) throw new Error('bucket mismatch');
  });
  tryCall('the new-meeting form asks for suggested slots sized from the estimate', () => {
    const t = w.findTask(3);
    t.estHours = 1; t.delegate = 'Marj'; t.timelineEnd = '2026-12-01';
    w.openMeetingPicker(3, null);
    w.startNewMeetingForm();
  });
  await new Promise(r => setTimeout(r, 80));
  tryCall('slots render and picking one fills date, start and duration', () => {
    if (!w.__slotsUrl || !w.__slotsUrl.includes('minutes=60')) throw new Error('slots url: ' + w.__slotsUrl);
    if (!w.__slotsUrl.includes('end=2026-12-01')) throw new Error('window not bounded by the due date');
    if (!doc.getElementById('mfSlots').textContent.includes('Tue, Sep 22')) throw new Error('slot row missing');
    if (!doc.getElementById('mfSlots').textContent.includes('not shared')) throw new Error('unshared-calendar hint missing');
    if (!doc.getElementById('mfSlots').textContent.includes('plus Friday 10–2')) throw new Error('third-window hint missing');
    if (!w.__slotsUrl.includes('blocks=1')) throw new Error('blocks default not sent: ' + w.__slotsUrl);
    if (!doc.getElementById('mfBlocks') || !doc.getElementById('mfBlocks').checked) throw new Error('blocks checkbox missing or unchecked');
    w.useMeetingSlot_(0);
    if (doc.getElementById('mfDate').value !== '2026-09-22') throw new Error('date not filled: ' + doc.getElementById('mfDate').value);
    if (!/^\d\d:\d\d$/.test(doc.getElementById('mfStart').value)) throw new Error('start not filled');
    if (doc.getElementById('mfDuration').value !== '60') throw new Error('duration not filled');
    w.closeMeetingPicker();
  });

  // Due time + reminders (2026-09-17)
  tryCall('modal Due row has a time select and a reminder select; a preset computes remindAt from the due date and time', () => {
    const t = w.findTask(1);
    t.timelineEnd = '2026-09-25'; delete t.dueTime; delete t.remindAt;
    w.openTaskCard(1);
    const html = doc.getElementById('modalMeta').innerHTML;
    if (!html.includes('time-pick') || !html.includes('remind-select')) throw new Error('controls missing');
    w.modalDueTimeChange(1, '14:00');
    if (w.findTask(1).dueTime !== '14:00') throw new Error('dueTime not set');
    w.onRemindPreset(1, null, '60');
    if (w.findTask(1).remindAt !== '2026-09-25T13:00') throw new Error('remindAt ' + w.findTask(1).remindAt);
    if (!w.findTask(1).history.some(h => h.field === 'remindAt')) throw new Error('no history');
  });
  tryCall('adding a due time to an item with no reminder applies the default preset (Settings > General, 1 hour before unless changed; was 15 min until 2026-09-21)', () => {
    const t = w.findTask(1);
    t.timelineEnd = '2026-09-25'; delete t.dueTime; delete t.remindAt; delete t.reminderSentAt;
    w.eval("delete RAW_META.remindDefault");
    w.modalDueTimeChange(1, '14:00');
    if (t.remindAt !== '2026-09-25T13:00') throw new Error('default not applied: ' + t.remindAt);
    if (!t.history.some(h => h.field === 'remindAt' && h.source === 'Durand')) throw new Error('no history line');
    w.onRemindPreset(1, null, '60'); // hand-picked preset follows later time changes, never the default
    w.modalDueTimeChange(1, '15:00');
    if (t.remindAt !== '2026-09-25T14:00') throw new Error('preset did not follow: ' + t.remindAt);
    delete t.remindAt; w.eval("RAW_META.remindDefault = ''");
    w.modalDueTimeChange(1, '16:00');
    if (t.remindAt) throw new Error('no default should mean no reminder');
    w.eval("RAW_META.remindDefault = '1440'");
    delete t.dueTime; w.modalDueTimeChange(1, '09:00');
    if (t.remindAt !== '2026-09-24T09:00') throw new Error('1 day default: ' + t.remindAt);
    w.eval("delete RAW_META.remindDefault; RULESETS = { meta: {}, current: {}, history: [], threads: {} }; rulesetsLoaded = true;");
    w.setSettingsTab('general');
    const sel = doc.getElementById('remindDefaultSelect');
    if (!sel || sel.value !== '60' || [...sel.options].some(o => o.value === 'custom')) throw new Error('Settings default reminder select');
    w.__posts = [];
    w.setRemindDefault('60');
    const post = (w.__posts || []).map(x => { try { return JSON.parse(x.body); } catch (e) { return null; } }).find(x => x && x.op === 'set_meta');
    if (!post || post.fields.remindDefault !== '60' || w.eval('RAW_META.remindDefault') !== '60') throw new Error('set_meta not posted ' + JSON.stringify(post));
    w.eval("delete RAW_META.remindDefault");
    t.timelineEnd = '2026-09-25'; t.dueTime = '14:00'; t.remindAt = '2026-09-25T13:00'; // state the next tests build on
  });
  await (async () => {
    try {
      w.eval("navigator.clipboard = { writeText: t => { window.__clipWrites.push(t); return Promise.resolve(); } }; window.__clipWrites = [];");
      const btn = doc.createElement('button'); btn.textContent = 'Copy address'; doc.body.appendChild(btn);
      const ok = await w.copyText_('hello', btn, 'The tracker address');
      if (!ok || w.eval('window.__clipWrites')[0] !== 'hello' || btn.textContent !== 'Copied' || !btn.classList.contains('copied')) throw new Error('no success indicator');
      const toasts = doc.getElementById('tsgToasts');
      if (!toasts || !/Copied/.test(toasts.textContent) || !/tracker address/.test(toasts.textContent)) throw new Error('no toast');
      w.eval("navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) }; window.__prompted = null; window.prompt = (m, v) => { window.__prompted = v; return null; };");
      const ok2 = await w.copyText_('again', btn, 'x');
      if (ok2 || w.eval('window.__prompted') !== 'again' || !/Copy failed/.test(doc.getElementById('tsgToasts').textContent)) throw new Error('no fallback');
      btn.remove(); doc.getElementById('tsgToasts').innerHTML = '';
      if (!/copyText_\(location\.origin/.test(w.eval('renderGeneralTab.toString()')) || !/copyText_\(/.test(w.eval('copyClaudePrompt.toString()'))) throw new Error('copy sites not routed through copyText_');
      console.log('OK   - copyText_: every copy flips the button to Copied and raises a toast; a refused clipboard falls back to a prompt');
    } catch (e) { console.log('FAIL - copyText_ ->', e.message); FAILS++; }
  })();
  await (async () => {
    try {
      w.eval("navigator.clipboard = { writeText: t => { window.__clipWrites.push(t); return Promise.resolve(); } }; window.__clipWrites = []; window.__opened = []; window.open = (u, n) => { window.__opened.push([u, n]); return {}; };");
      w.eval("delete RAW_META.claudeSession; CLAUDE_SESSION = ''; COMMENTS = [{ id: 'C1', text: 'move this to Friday', author: 'Durand', ts: '2026-09-18T12:00:00Z', anchor: { kind: 'task', id: 1 } }];");
      let r = await w.routePromptToClaude_('hello', { shiftKey: true }, null, 'x');
      if (r !== 'cloud' || !/claude\.ai\/code\?prompt=hello/.test(w.eval('window.__opened')[0][0])) throw new Error('shift should open a new cloud session');
      w.__posts = [];
      await w.setClaudeSession('https://claude.ai/code/session_TEST');
      const post = (w.__posts || []).map(x => { try { return JSON.parse(x.body); } catch (e) { return null; } }).find(x => x && x.op === 'set_meta');
      if (!post || post.fields.claudeSession !== 'https://claude.ai/code/session_TEST') throw new Error('set_meta not posted');
      w.eval("window.__alerts = []; window.alert = m => window.__alerts.push(m);");
      await w.setClaudeSession('http://evil.example/x');
      if (w.eval('CLAUDE_SESSION') !== 'https://claude.ai/code/session_TEST' || !w.eval('window.__alerts').length) throw new Error('non-claude.ai link accepted');
      r = await w.sendCommentsToClaude({ shiftKey: false, currentTarget: null });
      const opened = w.eval('window.__opened');
      if (r !== 'session' || opened[opened.length - 1][0] !== 'https://claude.ai/code/session_TEST' || !/move this to Friday/.test(w.eval('window.__clipWrites').pop())) throw new Error('did not copy + open the working session: ' + r);
      if (!/Copied/.test(doc.getElementById('tsgToasts').textContent)) throw new Error('no copied toast');
      w.openCommentsPanel();
      if (!/open to this session/.test(doc.body.innerHTML)) throw new Error('button label should name the session');
      if (!/delegated to Claude/.test(w.judgePromptFor_()) || !/DRAFTED ONLY/.test(w.judgePromptFor_())) throw new Error('judge prompt lacks the delegated-work step');
      w.eval("CLAUDE_SESSION = ''; delete RAW_META.claudeSession; COMMENTS = [];"); doc.getElementById('tsgToasts').innerHTML = '';
      console.log('OK   - Judge now / Send comments route to the working session (copy + open) when one is set; shift = new cloud session; only claude.ai links accepted');
    } catch (e) { console.log('FAIL - working session routing ->', e.message); FAILS++; }
  })();
  tryCall('a preset reminder follows a due-date or due-time change; clearing removes it', () => {
    w.modalDueChange(1, '2026-09-26');
    if (w.findTask(1).remindAt !== '2026-09-26T13:00') throw new Error('did not follow date: ' + w.findTask(1).remindAt);
    w.modalDueTimeChange(1, '09:00');
    if (w.findTask(1).remindAt !== '2026-09-26T08:00') throw new Error('did not follow time: ' + w.findTask(1).remindAt);
    w.findTask(1).reminderSentAt = '2026-09-17T12:00:00Z';
    w.onRemindPreset(1, null, '');
    if (w.findTask(1).remindAt || w.findTask(1).reminderSentAt) throw new Error('not cleared');
  });
  tryCall('custom reminder takes a datetime; without a due date only Custom works', () => {
    w.onRemindPreset(1, null, 'custom');
    if (!w.findTask(1).remindAt) throw new Error('custom did not seed a time');
    w.onRemindCustom(1, null, '2026-09-24T07:45');
    if (w.findTask(1).remindAt !== '2026-09-24T07:45') throw new Error('custom not stored');
    const t = w.findTask(1); t.timelineEnd = ''; delete t.remindAt;
    w.onRemindPreset(1, null, '15');
    if (t.remindAt) throw new Error('preset should refuse without a due date');
    t.timelineEnd = '2026-09-15'; delete t.dueTime;
    w.closeTaskCard();
  });
  tryCall('subtask rows carry a time input and a reminder select', () => {
    w.setView('board');
    w.eval("expandedSubtasks.add(1)");
    w.renderAll();
    const row = doc.querySelector('tr.task-row[data-id="1"]');
    const subHtml = doc.getElementById('board').innerHTML;
    if (!subHtml.includes('sub-time')) throw new Error('subtask time input missing');
    w.onDueTimeChange_(1, 0, '11:00');
    if (w.findTask(1).subitems[0].dueTime !== '11:00') throw new Error('sub dueTime not set');
    w.findTask(1).subitems[0].timelineEnd = '2026-09-25';
    w.onRemindPreset(1, 0, '0');
    if (w.findTask(1).subitems[0].remindAt !== '2026-09-25T11:00') throw new Error('sub remindAt ' + w.findTask(1).subitems[0].remindAt);
    delete w.findTask(1).subitems[0].remindAt; delete w.findTask(1).subitems[0].dueTime;
  });

  // Native notifications + scheduler-set due times (2026-09-17)
  tryCall('a due reminder raises a native notification once (remembered across reloads) and opens the task on click', () => {
    const shown = [];
    w.Notification = function(title, opts) { shown.push({ title, opts }); this.close = () => {}; };
    w.Notification.permission = 'granted';
    w.Notification.requestPermission = async () => 'granted';
    const t = w.findTask(1);
    const past = new Date(Date.now() - 60000);
    const pad = n => (n < 10 ? '0' : '') + n;
    t.remindAt = past.getFullYear() + '-' + pad(past.getMonth() + 1) + '-' + pad(past.getDate()) + 'T' + pad(past.getHours()) + ':' + pad(past.getMinutes());
    t.timelineEnd = '2026-09-25'; t.dueTime = '10:00';
    w.localStorage.removeItem('tsgNotifiedReminders');
    if (w.checkReminderNotifications_() !== 1) throw new Error('did not raise');
    if (!shown.length || !shown[0].title.includes(t.title) || !shown[0].opts.body.includes('10:00')) throw new Error('bad notification ' + JSON.stringify(shown));
    if (w.checkReminderNotifications_() !== 0) throw new Error('raised twice');
    if (!w.localStorage.getItem('tsgNotifiedReminders').includes(t.remindAt)) throw new Error('not remembered');
    delete t.remindAt;
  });
  tryCall('without permission a toast is shown instead', () => {
    w.Notification.permission = 'denied';
    const t = w.findTask(1);
    const past = new Date(Date.now() - 120000);
    const pad = n => (n < 10 ? '0' : '') + n;
    t.remindAt = past.getFullYear() + '-' + pad(past.getMonth() + 1) + '-' + pad(past.getDate()) + 'T' + pad(past.getHours()) + ':' + pad(past.getMinutes());
    w.checkReminderNotifications_();
    if (!doc.querySelector('#tsgToasts .tsg-toast')) throw new Error('no toast');
    delete t.remindAt; delete t.dueTime;
    doc.getElementById('tsgToasts').innerHTML = '';
  });
  tryCall('the Today scheduler fills dueTime from the slot start and never overwrites a hand-typed time', () => {
    const today = w.todayISO();
    const a = w.findTask(1), b = w.findTask(2);
    const prevTypes = [a.taskType, b.taskType], prevDel = [a.delegate, b.delegate];
    a.timelineEnd = today; a.status = 'In Progress'; a.estHours = 1; delete a.dueTime; delete a.dueTimeAuto; a.subitems = []; a.taskType = 'Hands-on'; a.owner = 'Durand'; delete a.delegate;
    b.timelineEnd = today; b.status = 'Not Started'; b.estHours = 0.5; b.dueTime = '15:45'; delete b.dueTimeAuto; b.subitems = b.subitems || []; b.taskType = 'Hands-on'; b.owner = 'Durand'; delete b.delegate;
    w.eval("todayViewDate = todayISO(); todayGranularity = 'day'");
    w.setView('today');
    if (!/^\d\d:\d\d$/.test(a.dueTime || '')) throw new Error('scheduler did not set dueTime: ' + a.dueTime);
    if (!a.dueTimeAuto) throw new Error('auto flag missing');
    if (!a.history.some(h => h.field === 'dueTime' && h.source === 'Scheduler')) throw new Error('no history');
    if (b.dueTime !== '15:45') throw new Error('hand-typed time overwritten: ' + b.dueTime);
    const set = a.dueTime;
    w.renderAll();
    if (a.dueTime !== set || a.history.filter(h => h.field === 'dueTime' && h.source === 'Scheduler').length !== 1) throw new Error('re-render re-logged the same time');
    w.modalDueTimeChange(1, '08:15');
    if (a.dueTimeAuto) throw new Error('manual edit kept the auto flag');
    w.setView('today');
    if (a.dueTime !== '08:15') throw new Error('scheduler overwrote the manual time');
    a.timelineEnd = '2026-09-15'; delete a.dueTime; b.timelineEnd = '2026-09-19'; delete b.dueTime;
    a.taskType = prevTypes[0]; b.taskType = prevTypes[1]; if (prevDel[0]) a.delegate = prevDel[0]; if (prevDel[1]) b.delegate = prevDel[1];
  });

  // Hand edits win (2026-09-17): every dashboard edit is stamped Durand; dependency clears stick; disagreements resolve
  tryCall('logHistory stamps every dashboard edit with source Durand', () => {
    const t = w.findTask(1);
    w.logHistory(t, 'priority', 'Low', 'High');
    const h = t.history[t.history.length - 1];
    if (h.source !== 'Durand' || h.field !== 'priority') throw new Error('no source: ' + JSON.stringify(h));
  });
  tryCall('removing the last dependency sets dependsNone; adding one lifts it', () => {
    const t = w.findTask(1);
    t.depends = '3'; delete t.dependsNone;
    w.modalRemoveDepends(1, 3);
    if (t.depends !== '' || t.dependsNone !== true) throw new Error('not marked: ' + t.depends + ' ' + t.dependsNone);
    if (!doc.getElementById('modalMeta').innerHTML.includes('cleared by you')) throw new Error('no cleared note in the modal');
    w.allowDependsInfer(1);
    if (t.dependsNone) throw new Error('allow again did not clear');
    t.dependsNone = true;
    doc.querySelector('#modalMeta .modal-depends-select').value = '2';
    w.modalAddDepends(1, doc.querySelector('#modalMeta .modal-depends-select'));
    if (t.depends !== '2' || t.dependsNone) throw new Error('add did not lift: ' + t.depends + ' ' + t.dependsNone);
    t.depends = ''; w.closeTaskCard();
  });
  tryCall('an At Risk tag renders a chip naming where the steps end, on the row and in the card\'s Due row (2026-09-18)', () => {
    const t = w.findTask(1);
    t.tags.push('At Risk'); t.realisticEnd = '2026-09-24'; t.timelineEnd = '2026-09-18'; t.dueOverride = true;
    w.setView('board'); w.renderAll();
    const chip = doc.querySelector('tr.task-row[data-id="1"] .tag-risk');
    if (!chip || !/At Risk/.test(chip.textContent) || !/9\/24/.test(chip.textContent)) throw new Error('no At Risk chip: ' + (chip && chip.textContent));
    chip.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const html = doc.getElementById('modalMeta').innerHTML;
    if (!html.includes('open steps run to 2026-09-24') || !html.includes('your date is kept')) throw new Error('Due row note missing');
    if (doc.querySelector('#modalMeta .modal-due').value !== '2026-09-18') throw new Error('due date changed');
    w.closeTaskCard();
    w.setView('cards'); w.renderAll();
    if (!doc.querySelector('.tag-risk')) throw new Error('no chip on the card view');
    t.tags = t.tags.filter(x => x !== 'At Risk'); delete t.realisticEnd; w.setView('board'); w.renderAll();
  });
  tryCall('At Risk tasks show in the Triage filter and raise their own alert row (2026-09-18)', () => {
    const t = w.findTask(1);
    t.tags.push('At Risk'); t.realisticEnd = '2026-09-24';
    const alerts = w.computeAlerts();
    const row = alerts.find(a => /at risk/.test(a.text));
    if (!row || !row.ids.includes(1) || row.level !== 'critical') throw new Error('no at-risk alert: ' + JSON.stringify(alerts.map(a => a.text)));
    w.setView('board'); w.toggleTriageFilter(); w.renderAll();
    if (!doc.querySelector('tr.task-row[data-id="1"]')) throw new Error('At Risk task hidden by the Triage filter');
    const others = Array.from(doc.querySelectorAll('tr.task-row')).filter(r => r.getAttribute('data-id') !== '1');
    if (others.some(r => { const tt = w.findTask(Number(r.getAttribute('data-id'))); return tt && !(tt.tags || []).some(x => x === 'Triage' || x === 'Review' || x === 'At Risk'); })) throw new Error('filter let an untagged task through');
    w.toggleTriageFilter(); t.tags = t.tags.filter(x => x !== 'At Risk'); delete t.realisticEnd; w.renderAll();
  });
  tryCall('a Review tag renders a "Claude disagrees" chip that opens the card with the flag row', () => {
    const t = w.findTask(1);
    t.tags.push('Review');
    t.reviewFlags = [{ ts: '2026-09-17T12:00:00Z', field: 'estHours', mine: 1, claude: 5, rationale: 'a full reconciliation' }];
    t.notes = 'Current state: waiting.\n\nREVIEW (2026-09-17): Claude proposed estHours = 5 because a full reconciliation; your value 1 is kept. Resolve on the card: keep yours or take Claude\'s.';
    t.estHours = 1;
    w.setView('board'); w.renderAll();
    const chip = doc.querySelector('tr.task-row[data-id="1"] .tag-review');
    if (!chip || !chip.textContent.includes('Claude disagrees')) throw new Error('no chip');
    chip.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const html = doc.getElementById('modalMeta').innerHTML;
    if (!html.includes('Claude disagrees') || !html.includes('Keep mine') || !html.includes("Use Claude's")) throw new Error('flag row missing');
  });
  tryCall("Use Claude's applies the value, logs it as Durand's decision, clears the flag, the tag and the note paragraph", () => {
    w.resolveReviewFlag(1, 'estHours', true);
    const t = w.findTask(1);
    if (t.estHours !== 5) throw new Error('value not applied: ' + t.estHours);
    if (t.reviewFlags || t.tags.includes('Review')) throw new Error('flag or tag left behind');
    if (/REVIEW \(/.test(t.notes)) throw new Error('paragraph left in notes');
    if (!t.history.some(h => h.field === 'estHours' && h.to === 5 && h.source === 'Durand')) throw new Error('no history');
    t.estHours = 1;
  });
  tryCall('Keep mine leaves the value and records the decision; the Triage filter shows Review-tagged tasks too', () => {
    const t = w.findTask(1);
    t.tags.push('Review'); t.reviewFlags = [{ ts: '2026-09-17T12:00:00Z', field: 'priority', mine: 'Low', claude: 'Critical', rationale: 'x' }];
    t.priority = 'Low';
    w.toggleTriageFilter();
    if (!doc.querySelector('tr.task-row[data-id="1"]')) throw new Error('Review task hidden by the Triage filter');
    w.toggleTriageFilter();
    w.resolveReviewFlag(1, 'priority', false);
    if (t.priority !== 'Low' || t.reviewFlags || t.tags.includes('Review')) throw new Error('keep mine misbehaved');
    if (!t.history.some(h => h.field === 'review' && /kept Low/.test(h.to))) throw new Error('no decision line');
    w.closeTaskCard();
  });

  // One links field: one search across Drive, email and calendar; upload; paste an image (2026-09-17)
  tryCall('the link picker has one search box and one file input; a search lists Drive, email and meeting hits together', () => {
    w.__pickerEvents = [{ id: 'ev9', title: 'Flyer proof review', htmlLink: 'https://calendar.google.com/event?eid=ev9', start: '2026-09-22T14:00:00Z', end: '2026-09-22T14:30:00Z', dateLabel: 'Tue 9/22', timeLabel: '10:00' }];
    w.openNewTaskModal({});
    w.addManualDoc('__new__');
    if (doc.getElementById('linkMailSearch')) throw new Error('separate mail search still present');
    if (!doc.getElementById('linkSearch') || !doc.getElementById('linkFile')) throw new Error('search or file input missing');
    doc.getElementById('linkSearch').value = 'flyer proof';
  });
  await new Promise(r => setTimeout(r, 30)); // let the picker's meeting load settle before searching
  await w.runLinkSearch_();
  tryCall('...one list, three sources, each picked into the one docs list with its type', () => {
    const html = doc.getElementById('linkResults').innerHTML;
    if (!html.includes('Fall Flyer Draft') || !html.includes('Flyer proof thread') || !html.includes('Flyer proof review')) throw new Error('missing a source: ' + html.slice(0, 300));
    const hits = w.eval('LINK_HITS');
    if (hits.length !== 3 || hits.map(h => h.type).sort().join() !== 'email,link,meeting') throw new Error('hit types ' + hits.map(h => h.type));
    w.addLinkHit_(hits.findIndex(h => h.type === 'email'));
    w.addManualDoc('__new__');
    w.eval("LINK_HITS = " + JSON.stringify(hits));
    w.addLinkHit_(hits.findIndex(h => h.type === 'link'));
    const fields = w.newTaskFieldsFromModal_();
    if (!fields.docs || fields.docs.length !== 2 || !fields.docs.some(x => x.type === 'email') || !fields.docs.some(x => x.type === 'link')) throw new Error('docs ' + JSON.stringify(fields.docs));
  });
  tryCall('a chosen file uploads through target=upload and lands as a typed attachment on the pending task', () => {
    const f = new w.File([new w.Blob(['hello'], { type: 'text/plain' })], 'quote.txt', { type: 'text/plain' });
    w.__posts = [];
    w.attachFiles_([f], { pending: true });
  });
  await new Promise(r => setTimeout(r, 60));
  tryCall('...posted base64 with the name and mime; chip shows the file icon', () => {
    const p = (w.__posts || []).find(x => x.url.includes('target=upload'));
    if (!p) throw new Error('no upload post');
    const body = JSON.parse(p.body);
    if (body.name !== 'quote.txt' || body.mime !== 'text/plain' || body.base64 !== Buffer.from('hello').toString('base64')) throw new Error('bad body ' + p.body.slice(0, 120));
    const fields = w.newTaskFieldsFromModal_();
    if (!fields.docs.some(x => x.type === 'file' && x.url.includes('UPLOADED') && x.label === 'quote.txt')) throw new Error('attachment missing: ' + JSON.stringify(fields.docs));
    if (!doc.getElementById('ntDocs').innerHTML.includes('&#128206;') && !doc.getElementById('ntDocs').innerHTML.includes('📎')) throw new Error('no file icon');
    w.closeNewTaskModal();
  });
  tryCall('pasting an image on an open task card attaches it to that task', () => {
    w.openTaskCard(2);
    w.__posts = [];
    const img = new w.File([new w.Blob(['\x89PNG fake'], { type: 'image/png' })], 'image.png', { type: 'image/png' });
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { items: [{ kind: 'file', getAsFile: () => img }], files: [img] };
    doc.dispatchEvent(ev);
  });
  await new Promise(r => setTimeout(r, 60));
  tryCall('...uploaded without a generic name (server dates it) and typed image on task 2', () => {
    const p = (w.__posts || []).find(x => x.url.includes('target=upload'));
    if (!p) throw new Error('no upload post');
    if (JSON.parse(p.body).name !== '') throw new Error('generic clipboard name should be dropped: ' + JSON.parse(p.body).name);
    const t2 = w.findTask(2);
    if (!(t2.docs || []).some(x => x.type === 'image' && x.url.includes('UPLOADED'))) throw new Error('image not attached: ' + JSON.stringify(t2.docs));
    if (!t2.history.some(h => h.field === 'doc' && h.source === 'Durand')) throw new Error('no history');
    t2.docs = t2.docs.filter(x => !x.url.includes('UPLOADED'));
    w.closeTaskCard();
  });

  // Actual time: card timer, Done prompt, EOD check (2026-09-17)
  tryCall('the task card has an Actual row with Start; starting shows the toolbar chip and persists', () => {
    w.openTaskCard(1);
    if (!doc.getElementById('timerStartBtn')) throw new Error('no Start button');
    w.startTimer(1, null);
    w.eval('TIMER.startedAt = Date.now() - 90 * 1000');
    w.renderTimerChip_();
    const chip = doc.getElementById('timerChip');
    if (chip.style.display === 'none' || !chip.textContent.includes('1:30')) throw new Error('chip: ' + chip.textContent);
    if (!doc.getElementById('timerStopBtn')) throw new Error('no Stop button while running');
    if (JSON.parse(w.localStorage.getItem('tsgTimer')).id !== 1) throw new Error('timer not persisted');
  });
  tryCall('stopping logs a timer entry to the minute, actualHours in quarter hours, history with source Durand', () => {
    w.eval('TIMER.startedAt = Date.now() - 20 * 60 * 1000');
    w.stopTimer(true);
    const t = w.findTask(1);
    if (!t.timeLog || t.timeLog.length !== 1 || t.timeLog[0].minutes !== 20 || t.timeLog[0].kind !== 'timer') throw new Error('log ' + JSON.stringify(t.timeLog));
    if (t.actualHours !== 0.25) throw new Error('actualHours ' + t.actualHours);
    if (!t.history.some(h => h.field === 'actualHours' && h.source === 'Durand')) throw new Error('no history line');
    if (w.localStorage.getItem('tsgTimer')) throw new Error('timer still persisted');
    if (!doc.getElementById('taskModal').innerHTML.includes('0.25 h')) throw new Error('card does not show the actual');
    w.closeTaskCard();
  });
  tryCall('marking a task Done with nothing logged opens the prompt prefilled with the estimate; Save logs a manual entry', () => {
    const t = w.findTask(2); t.estHours = 1.5; t.actualHours = 0; t.timeLog = []; t.status = 'In Progress';
    w.modalPillChange(2, 'status', 'Done');
    const m = doc.getElementById('actualModal');
    if (!m.classList.contains('open')) throw new Error('prompt not open');
    if (doc.getElementById('actualHoursInput').value !== '1.5') throw new Error('prefill ' + doc.getElementById('actualHoursInput').value);
    doc.getElementById('actualHoursInput').value = '2';
    w.saveActualModal_();
    if (m.classList.contains('open')) throw new Error('prompt still open');
    if (t.actualHours !== 2 || t.timeLog[0].kind !== 'manual' || t.timeLog[0].minutes !== 120) throw new Error('log ' + JSON.stringify(t.timeLog));
    w.closeTaskCard();
  });
  tryCall('a task with time already logged is not prompted again; ticking a step prompts for that step', () => {
    w.modalPillChange(2, 'status', 'In Progress'); w.modalPillChange(2, 'status', 'Done');
    if (doc.getElementById('actualModal').classList.contains('open')) throw new Error('prompted twice');
    w.closeTaskCard();
    const t1 = w.findTask(1);
    if (!t1.subitems || !t1.subitems.length) t1.subitems = [{ title: 'Step', status: 'Not Started', done: false }];
    t1.subitems[0].estHours = 0.5; t1.subitems[0].actualHours = 0; t1.subitems[0].timeLog = [];
    w.toggleSubitem(1, 0, { checked: true });
    if (!doc.getElementById('actualModal').classList.contains('open')) throw new Error('no prompt for the step');
    if (doc.getElementById('actualHoursInput').value !== '0.5') throw new Error('step prefill ' + doc.getElementById('actualHoursInput').value);
    w.closeActualModal();
  });
  tryCall('the Evening Wrap-Up lists tasks finished today with no time logged', () => {
    const all = w.eval('TASKS');
    const t3 = all.find(x => x.id !== 1 && x.id !== 2) || all[0];
    t3.status = 'Done'; t3.actualHours = 0; t3.timeLog = []; t3.subitems = []; t3.completedAt = new Date().toISOString();
    const items = w.buildActualsCheck(w.todayISO());
    if (items.length !== 1 || !items[0].ids.includes(t3.id)) throw new Error('items ' + JSON.stringify(items));
    if (items[0].ids.includes(2)) throw new Error('task with logged time listed');
  });
  tryCall('inbox errors: a recent entry raises a warn alert that opens Settings, and Settings lists it', () => {
    w.eval("RAW_META.inboxErrors = [{ ts: new Date().toISOString(), file: 'mixed.json', op: 'bulk[update_task,log_time]', error: 'bulk: 1 of 2 sub-op(s) failed' }]");
    const a = w.computeAlerts().find(x => x.openSettings);
    if (!a || !/1 inbox patch failed/.test(a.text)) throw new Error('no inbox alert: ' + JSON.stringify(w.computeAlerts().map(x => x.text)));
    if (!w.inboxErrorsHtml_().includes('mixed.json')) throw new Error('settings list missing the entry');
    w.eval('RAW_META.inboxErrors = []');
  });
  tryCall('inbox errors: a MALFORMED-/FAILED- entry (nothing applied) is a CRITICAL alert naming the file; a PARTIAL- alone stays a warning (2026-09-18)', () => {
    w.eval("RAW_META.inboxErrors = [{ ts: new Date().toISOString(), file: 'claude-tracker-routine-patch4-j49.json', op: null, error: 'malformed JSON: Expected \\',\\' or \\'}\\' after property value in JSON at position 3463 near: \"...\"' }]");
    let a = w.computeAlerts().find(x => x.openSettings);
    if (!a || a.level !== 'critical') throw new Error('malformed entry not critical: ' + JSON.stringify(a));
    if (!/patch4-j49\.json/.test(a.text) || !/dropped entirely/.test(a.text)) throw new Error('alert text does not name the file: ' + a.text);
    w.eval("RAW_META.inboxErrors = [{ ts: new Date().toISOString(), file: 'mixed.json', op: 'bulk[update_task,log_time]', error: 'bulk: 1 of 2 sub-op(s) failed', appliedSubOps: 1, failedSubOps: [{ index: 1, op: 'log_time', error: 'x' }] }]");
    a = w.computeAlerts().find(x => x.openSettings);
    if (!a || a.level !== 'warn' || !/applied in part/.test(a.text)) throw new Error('partial entry not a warning: ' + JSON.stringify(a));
    w.eval('RAW_META.inboxErrors = []');
  });
  tryCall('inbox errors: a new entry raises ONE in-tracker toast naming the file, never repeated for the same entry (no email)', () => {
    try { w.localStorage.removeItem('tsgSeenInboxErrorTs'); } catch (e) {}
    w.eval("RAW_META.inboxErrors = [{ ts: '2026-09-18T14:45:24.521Z', file: 'claude-tracker-routine-patch4-j49.json', op: null, error: 'malformed JSON at position 3463' }]");
    w.document.querySelectorAll('.tsg-toast').forEach(el => el.remove());
    const n1 = w.checkInboxErrorToasts_();
    const toasts = Array.from(w.document.querySelectorAll('.tsg-toast')).map(el => el.textContent);
    if (n1 !== 1 || toasts.length !== 1 || !/dropped/.test(toasts[0]) || !/patch4-j49\.json/.test(toasts[0])) throw new Error('toast missing: ' + JSON.stringify(toasts));
    const n2 = w.checkInboxErrorToasts_();
    if (n2 !== 0 || w.document.querySelectorAll('.tsg-toast').length !== 1) throw new Error('toast repeated');
    w.document.querySelectorAll('.tsg-toast').forEach(el => el.remove());
    w.eval('RAW_META.inboxErrors = []');
  });
  tryCall('add subtask on a task that has NO subitems array (created by a patch): the steps land and the box clears (2026-09-21 bug)', () => {
    w.eval("TASKS.push({ id: 901, title: 'Patch-created task with no steps key', group: 'Marketing', owner: 'Durand', status: 'Not Started', priority: 'Medium', history: [] })");
    w.renderAll();
    // A task with no steps has no board add box (the step row only renders once steps exist), so the card is the only way in.
    w.openTaskCard(901);
    const box = doc.getElementById('modalNewsub-901');
    if (!box) throw new Error('no card add box rendered for the task');
    box.value = 'First step\nSecond step';
    w.addSubitemAndRefocus_(901, true);
    const t = w.findTask(901);
    if (!Array.isArray(t.subitems) || t.subitems.length !== 2 || t.subitems[1].title !== 'Second step') throw new Error('steps not added: ' + JSON.stringify(t.subitems));
    if (doc.getElementById('modalNewsub-901').value !== '') throw new Error('box not cleared');
    w.closeTaskCard();
    if (!t.history.some(h => h.field === 'subitem' && h.to === 'First step')) throw new Error('no history line');
    w.eval('TASKS = TASKS.filter(x => x.id !== 901)'); w.renderAll();
  });
  tryCall('add subtask from the CARD of a task that already has steps (board box also on the page): the card box is read (2026-09-21 bug on the pinned task)', () => {
    const t = w.findTask(1);
    const before = t.subitems.length;
    w.eval('expandedSubtasks.delete(1)'); w.renderAll();
    if (!doc.getElementById('newsub-1')) throw new Error('board add box expected to be rendered (hidden) for a task with steps');
    w.openTaskCard(1);
    const cardBox = doc.getElementById('modalNewsub-1');
    if (!cardBox) throw new Error('card add box missing');
    cardBox.value = 'Step typed in the card';
    w.addSubitemAndRefocus_(1, true);
    const t2 = w.findTask(1);
    if (t2.subitems.length !== before + 1 || t2.subitems[t2.subitems.length - 1].title !== 'Step typed in the card') throw new Error('card add did not land: ' + t2.subitems.length + ' steps');
    // and the board box still works on its own
    w.closeTaskCard(); w.renderAll();
    doc.getElementById('newsub-1').value = 'Step typed on the board';
    w.addSubitemAndRefocus_(1, false);
    if (w.findTask(1).subitems.length !== before + 2) throw new Error('board add did not land');
    w.findTask(1).subitems.splice(before); w.renderAll();
  });
  tryCall('Friday day template: errands before 10, lunch inside 10-2, relief after 2, admin bookends 15 min; Thursday keeps the full template (2026-09-21)', () => {
    const fri = w.buildTodayAgenda('2026-09-25').schedule;
    if (!fri.length) throw new Error('empty Friday schedule');
    const byKind = k => fri.filter(b => b.kind === k);
    const errand = byKind('errand')[0], lunch = byKind('lunch')[0], relief = byKind('relief')[0], admin = byKind('admin');
    if (!errand || errand.end !== 600 || errand.start !== 570) throw new Error('errand not just before 10: ' + JSON.stringify(errand));
    if (!lunch || lunch.start < 600 || lunch.end > 840) throw new Error('lunch not inside 10-2: ' + JSON.stringify(lunch));
    if (!relief || relief.start !== 840) throw new Error('relief not right after 2: ' + JSON.stringify(relief));
    if (admin.length !== 2 || admin[0].start !== 600 || admin[0].end !== 615 || admin[1].end !== 840) throw new Error('Friday admin bookends wrong: ' + JSON.stringify(admin.map(b => [b.start, b.end])));
    if (fri.some(b => b.kind === 'task' && (b.start < 600 || b.end > 840))) throw new Error('a task block sits outside 10-2');
    const thu = w.buildTodayAgenda('2026-09-24').schedule;
    if (!thu.some(b => b.kind === 'lunch') || thu[0].start !== 420) throw new Error('Thursday template changed: ' + JSON.stringify(thu.map(b => [b.kind, b.start, b.end])));
  });
  tryCall('Today view carries a Pinned strip that opens the pinned task (2026-09-21)', () => {
    const t = w.findTask(1); const was = t.pinned; t.pinned = true;
    const html = w.renderTodayView();
    if (!/today-pinned/.test(html) || !html.includes(w.escapeHtml(t.title)) || !html.includes('openTaskCard(1)')) throw new Error('pinned strip missing');
    t.pinned = was;
    if (/today-pinned/.test(w.renderTodayView()) && !w.eval('TASKS.some(x => x.pinned && x.status !== "Done")')) throw new Error('strip shown with nothing pinned');
  });
  tryCall('default reminders: a due date with no time gets the day before at 8 AM; a time then makes it 1 hour before (2026-09-21)', () => {
    w.eval("TASKS.push({ id: 903, title: 'Reminder defaults', group: 'Marketing', owner: 'Durand', status: 'Not Started', priority: 'Medium', history: [], subitems: [], tags: [] })");
    if (w.remindDefault_() !== '60') throw new Error('unset default should be 1 hour: ' + w.remindDefault_());
    w.modalDueChange(903, '2026-10-08');
    let t = w.findTask(903);
    if (t.remindAt !== '2026-10-07T08:00') throw new Error('day-before reminder missing: ' + t.remindAt);
    if (w.remindPresetOf_(t) !== 'daybefore8') throw new Error('preset not recognised: ' + w.remindPresetOf_(t));
    w.modalDueChange(903, '2026-10-09');
    t = w.findTask(903);
    if (t.remindAt !== '2026-10-08T08:00') throw new Error('day-before reminder did not follow the date: ' + t.remindAt);
    w.onDueTimeChange_(903, null, '14:00');
    t = w.findTask(903);
    if (t.remindAt !== '2026-10-09T13:00') throw new Error('time-based default not applied: ' + t.remindAt);
    w.eval('TASKS = TASKS.filter(x => x.id !== 903)'); w.closeTaskCard(); w.renderAll();
  });
  tryCall('timeline header labels are short and columns at least 48 px wide (2026-09-21)', () => {
    w.eval("timelineZoom = 'day'");
    const html = w.renderTimelineView(w.eval('TASKS'));
    const labels = Array.from(html.matchAll(/class="tl-col[^"]*"[^>]*>([^<]*)</g)).map(m => m[1]);
    if (!labels.length) throw new Error('no header columns');
    if (!/^[A-Z][a-z]{2} \d{1,2}$/.test(labels[0])) throw new Error('first label should carry the month: ' + labels[0]);
    if (labels.length > 1 && !/^\d{1,2}$|^[A-Z][a-z]{2} 1$/.test(labels[1])) throw new Error('day labels should be day numbers: ' + labels[1]);
    w.eval("timelineZoom = 'fit'");
    const lay = w.timelineLayout(400);
    if (lay.step * lay.dayWidth < 48) throw new Error('fit columns too narrow: ' + JSON.stringify(lay));
  });
  tryCall('the legacy Source row is gone from the card; Links remains (2026-09-21)', () => {
    w.openTaskCard(1);
    const html = doc.getElementById('taskModal').innerHTML;
    if (/<b>Source<\/b>/.test(html)) throw new Error('Source row still rendered');
    if (!/<b>Links<\/b>/.test(html)) throw new Error('Links row missing');
    if (typeof w.modalEditDoc === 'function') throw new Error('modalEditDoc still defined');
    w.closeTaskCard();
  });
  tryCall('linking a meeting offers its date and time as the due date (confirm stubbed true) (2026-09-21)', () => {
    w.eval("TASKS.push({ id: 904, title: 'Meeting link due', group: 'Marketing', owner: 'Durand', status: 'Not Started', priority: 'Medium', history: [], subitems: [], tags: [], docs: [] })");
    w.openMeetingPicker(904, null);
    w.linkMeetingToTarget({ id: 'evX', title: 'Vendor sync', htmlLink: 'https://calendar.google.com/event?eid=X', start: '2026-10-06T18:00:00.000Z', end: '2026-10-06T19:00:00.000Z' }, false);
    const t = w.findTask(904);
    const dt = w.isoToLocalDateHm_('2026-10-06T18:00:00.000Z');
    if (t.timelineEnd !== dt.date || t.dueTime !== dt.hm) throw new Error('due not set from the meeting: ' + JSON.stringify([t.timelineEnd, t.dueTime, dt]));
    if (!t.history.some(h => h.field === 'due') || !t.history.some(h => h.field === 'dueTime')) throw new Error('no history lines');
    w.eval('TASKS = TASKS.filter(x => x.id !== 904)'); w.closeTaskCard(); w.renderAll();
  });
  tryCall('page lock: on while a save is in flight, released after success and after a failure (2026-09-21)', () => {
    w.setPageLock_(true);
    if (!doc.body.classList.contains('save-lock') || !doc.getElementById('saveLockBar')) throw new Error('lock not applied');
    w.setPageLock_(false);
    if (doc.body.classList.contains('save-lock')) throw new Error('lock not released');
  });
  await (async () => {
    const label = 'page lock holds through a retried save: a "busy" (queued) answer keeps it until the next document lands (2026-09-21, "there should be one")';
    try {
      const origFetch = w.fetch;
      w.fetch = async (url, opts) => (opts && opts.method === 'POST') ? { ok: true, status: 200, json: async () => ({ ok: false, error: 'busy' }) } : origFetch(url, opts);
      w.eval('pendingSaveId = null');
      await w.doSaveNow_();
      if (!doc.body.classList.contains('save-lock')) throw new Error('lock dropped while the save is still queued');
      w.applyLoadedDoc_(w.eval('cloneJson_({ tasks: TASKS, meta: RAW_META })'));
      if (doc.body.classList.contains('save-lock')) throw new Error('lock not released when the document landed');
      w.fetch = origFetch;
      console.log('OK   -', label);
    } catch (e) { console.log('FAIL -', label, '->', e.message); FAILS++; }
  })();
  tryCall('extra reminders: add, set repeat, appear in the card and in the due list, remove (2026-09-21)', () => {
    const t = w.findTask(1);
    delete t.extraReminders;
    w.addExtraReminder_(1, null);
    if (!t.extraReminders || t.extraReminders.length !== 1 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t.extraReminders[0].at)) throw new Error('not added: ' + JSON.stringify(t.extraReminders));
    w.onExtraReminderRepeat_(1, null, 0, 'weekdays');
    if (t.extraReminders[0].repeat !== 'weekdays') throw new Error('repeat not set');
    w.openTaskCard(1);
    if (!doc.getElementById('taskModal').innerHTML.includes('remind-extra')) throw new Error('row not rendered on the card');
    const past = w.localMinuteIso_(new Date(Date.now() - 600000));
    w.onExtraReminderAt_(1, null, 0, past);
    if (!w.dueReminders_(Date.now()).some(r => r.key === 't1x0')) throw new Error('extra not in the due list');
    if (!t.history.some(h => h.field === 'reminders')) throw new Error('no history line');
    w.removeExtraReminder_(1, null, 0);
    if (t.extraReminders) throw new Error('not removed');
    w.closeTaskCard();
  });
  tryCall('Today view label carries the day of week (2026-09-21)', () => {
    const today = w.todayISO();
    if (!/^Today · (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /.test(w.relativeDayLabel(today))) throw new Error('today label: ' + w.relativeDayLabel(today));
    if (!/^Friday, /.test(w.relativeDayLabel('2026-09-25'))) throw new Error('dated label: ' + w.relativeDayLabel('2026-09-25'));
    w.eval("todayGranularity = 'day'");
    if (!w.renderTodayNavBar().includes(w.escapeHtml(w.relativeDayLabel(w.eval('todayViewDate'))))) throw new Error('nav bar does not show the label');
  });
  tryCall('delegating a task or step to anyone but Durand sets needsApproval and locks the toggle (2026-09-21)', () => {
    const before = w.eval('cloneJson_({ tasks: TASKS, meta: RAW_META })');
    const d2 = w.cloneJson_(before);
    d2.tasks.push({ id: 903, title: 'Approval rule', group: 'Marketing', owner: 'Durand', status: 'Not Started', priority: 'Low', history: [], tags: [], subitems: [{ title: 'S1', done: false, status: 'Not Started', notes: '' }] });
    w.applyLoadedDoc_(d2);
    const sel = doc.createElement('select'); sel.dataset.id = '903';
    ['', 'Durand', 'Marj', 'Claude'].forEach(v => { const o = doc.createElement('option'); o.value = v; o.textContent = v || 'none'; sel.appendChild(o); });
    sel.value = 'Durand'; w.onTaskDelegateChange(sel);
    let t = w.findTask(903);
    if (t.needsApproval) throw new Error('Durand as delegate must not require approval');
    if (!/type="checkbox" (?!checked disabled)/.test(w.approvalToggleHtml_(903, null))) throw new Error('toggle should be editable when not delegated away');
    sel.value = 'Marj'; w.onTaskDelegateChange(sel);
    t = w.findTask(903);
    if (t.needsApproval !== true) throw new Error('person delegate did not set needsApproval');
    if (!t.history.some(h => h.field === 'needsApproval' && h.to === 'true' && h.source === 'Durand')) throw new Error('no history line');
    if (!/checked disabled/.test(w.approvalToggleHtml_(903, null))) throw new Error('toggle not locked for a delegated task');
    const ssel = doc.createElement('select'); ssel.dataset.id = '903'; ssel.dataset.idx = '0';
    ['', 'Claude'].forEach(v => { const o = doc.createElement('option'); o.value = v; o.textContent = v || 'none'; ssel.appendChild(o); });
    ssel.value = 'Claude'; w.onDelegateChange(ssel);
    t = w.findTask(903);
    if (t.subitems[0].needsApproval !== true) throw new Error('Claude step delegate did not set needsApproval');
    if (!/checked disabled/.test(w.approvalToggleHtml_(903, 0))) throw new Error('step toggle not locked');
    w.applyLoadedDoc_(before);
  });
  tryCall('New Task with a delegate other than Durand is created needing approval', () => {
    w.openNewTaskModal({ title: 'NT approval', group: 'Marketing' });
    doc.getElementById('ntTitle').value = 'NT approval';
    doc.getElementById('ntDelegate').value = 'Claude';
    const f = w.newTaskFieldsFromModal_();
    if (f.delegate !== 'Claude' || f.needsApproval !== true) throw new Error('fields: ' + JSON.stringify({ d: f.delegate, a: f.needsApproval }));
    doc.getElementById('ntDelegate').value = '';
    const f2 = w.newTaskFieldsFromModal_();
    if (f2.needsApproval) throw new Error('undelegated new task must not require approval');
    w.eval('NT_BUSY = false'); w.closeNewTaskModal();
  });
  tryCall('applyLoadedDoc_ maps the old type name Actionable Task to Hands-on on tasks and steps (2026-09-21)', () => {
    const before = w.eval('cloneJson_({ tasks: TASKS, meta: RAW_META })');
    const d2 = w.cloneJson_(before); d2.tasks.push({ id: 904, title: 'Old type', group: 'Marketing', owner: 'Durand', status: 'Not Started', priority: 'Low', history: [], tags: [], taskType: 'Actionable Task', subitems: [{ title: 'S', done: false, status: 'Not Started', taskType: 'Actionable Task', notes: '' }] });
    w.applyLoadedDoc_(d2);
    const t = w.findTask(904);
    if (t.taskType !== 'Hands-on' || t.subitems[0].taskType !== 'Hands-on') throw new Error('not mapped: ' + t.taskType + ' / ' + t.subitems[0].taskType);
    const tt = w.eval('TASK_TYPES'); if (tt.indexOf('Hands-on') === -1 || tt.indexOf('Actionable Task') !== -1) throw new Error('TASK_TYPES: ' + tt.join(','));
    if (w.typeBadgeClass('Hands-on') !== 'type-hands-on') throw new Error('badge class: ' + w.typeBadgeClass('Hands-on'));
    w.applyLoadedDoc_(before);
  });
  tryCall('applyLoadedDoc_ gives every task a subitems and tags array', () => {
    const before = w.eval('cloneJson_({ tasks: TASKS, meta: RAW_META })');
    const d2 = w.cloneJson_(before); d2.tasks.push({ id: 902, title: 'Stepless', group: 'Marketing', owner: 'Durand', status: 'Not Started', priority: 'Low', history: [] });
    w.applyLoadedDoc_(d2);
    const t = w.findTask(902);
    if (!t || !Array.isArray(t.subitems) || !Array.isArray(t.tags)) throw new Error('not normalized: ' + JSON.stringify(t));
    w.applyLoadedDoc_(before);
  });
  tryCall('judge-now chip: hidden with an empty queue, counts pending judgments, prompt names the ids and the data file', () => {
    w.eval('RAW_META.judgments = []'); w.renderJudgeChip_();
    if (doc.getElementById('judgeChip').style.display !== 'none') throw new Error('chip shown with nothing queued');
    w.eval("RAW_META.judgments = [{ id: 'J21', kind: 'enrich', taskId: 281 }, { id: 'J22', kind: 'enrich', taskId: 287, subIdx: 2 }, { id: 'pending', kind: 'enrich', taskId: 1 }]");
    w.renderJudgeChip_();
    const chip = doc.getElementById('judgeChip');
    if (chip.style.display === 'none' || !/2 judgments queued/.test(chip.textContent)) throw new Error('chip: ' + chip.textContent);
    const p = w.judgePromptFor_();
    if (!p.includes('J21 (task #281, enrich)') || !p.includes('J22 (task #287 step 2, enrich)') || !p.includes('1SRdNiNhHdAfaB-agj9OcXRIPA5xNLidt') || !p.includes('tsg-task-tracker-protocol') || !p.includes('meta.comments')) throw new Error('prompt: ' + p.slice(0, 200));
    w.eval('RAW_META.judgments = []'); w.renderJudgeChip_();
  });
  tryCall('Settings > Capacity: four inputs; a key posts set_meta {capacity} merged with the others', () => {
    if (w.capacityValue_('reviewPersonMin') !== 5 || w.capacityValue_('reviewClaudeMin') !== 5) throw new Error('defaults');
    w.eval("RAW_META.capacity = { other: 1, claudeReviewMin: 7 }");
    if (w.capacityValue_('reviewClaudeMin') !== 7) throw new Error('legacy claudeReviewMin not honoured');
    w.__posts = [];
    w.setCapacityKey('approvalWaitDays', '2');
    const p2 = JSON.parse((w.__posts || []).find(x => x.body && x.body.includes('set_meta')).body);
    if (p2.fields.capacity.approvalWaitDays !== 2 || p2.fields.capacity.other !== 1) throw new Error('merge lost a key ' + JSON.stringify(p2.fields));
    w.setSettingsTab('capacity');
    ['reviewPersonMinInput', 'reviewClaudeMinInput', 'approvalWaitDaysInput', 'postReviewUpdateMinInput'].forEach(id => { if (!doc.getElementById(id)) throw new Error('missing ' + id); });
    if (doc.getElementById('newRosterName')) throw new Error('roster rendered on the Capacity tab');
    w.eval('RAW_META.capacity = {}');
  });
  tryCall('delegated work to review rides in the admin blocks: today\'s finishes in the evening, older ones in the morning; the block stretches, then splits', () => {
    const today = w.todayISO(), yday = w.addDays(today, -1);
    const t = w.findTask(1); const saved = t.subitems; const savedStatus = t.status; t.status = 'In Progress';
    t.subitems = [
      { title: 'Marj step due today', delegate: 'Marj', timelineEnd: today, status: 'Not Started' },
      { title: 'Claude step from yesterday', delegate: 'Claude', timelineEnd: yday, status: 'Not Started' },
      { title: 'Own step today', delegate: 'Durand', timelineEnd: today, status: 'Not Started' }
    ];
    let fixed = w.buildTodayFixed(today);
    const pm = fixed.find(b => b.title === 'Evening Wrap-Up'), am = fixed.find(b => b.title === 'Morning Admin');
    if (!pm.items.some(a => a.label === 'Marj step due today' && a.sub === 'Marj · 5 min')) throw new Error('evening list ' + JSON.stringify(pm.items));
    if (pm.items.some(a => a.label === 'Own step today')) throw new Error('own step listed');
    if (!am.items.some(a => a.label === 'Claude step from yesterday')) throw new Error('morning list ' + JSON.stringify(am.items));
    if (pm.end - pm.start !== 30 || pm.reviewMin !== 5) throw new Error('block size ' + (pm.end - pm.start));
    t.subitems = [1, 2, 3, 4, 5].map(i => ({ title: 'C' + i, delegate: 'Claude', timelineEnd: today, status: 'Not Started' }));
    fixed = w.buildTodayFixed(today);
    const pm2 = fixed.find(b => b.title === 'Evening Wrap-Up');
    if (pm2.end - pm2.start !== 40 || fixed.some(b => b.kind === 'review')) throw new Error('stretch ' + (pm2.end - pm2.start));
    t.subitems = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => ({ title: 'C' + i, delegate: 'Claude', timelineEnd: today, status: 'Not Started' }));
    fixed = w.buildTodayFixed(today);
    const pm3 = fixed.find(b => b.title === 'Evening Wrap-Up'), rv = fixed.find(b => b.kind === 'review');
    if (!rv || rv.items.length !== 10 || rv.end !== pm3.start || rv.end - rv.start !== 50 || pm3.end - pm3.start !== 30) throw new Error('split ' + JSON.stringify(rv && { s: rv.start, e: rv.end, n: rv.items.length }));
    if (pm3.items.some(a => a.label === 'C1')) throw new Error('lines duplicated into the admin block');
    t.subitems = saved; t.status = savedStatus;
  });
  tryCall('needs-approval toggle on a step and on the task logs history and saves', () => {
    const t = w.findTask(1);
    if (!t.subitems || !t.subitems.length) t.subitems = [{ title: 'Step', status: 'Not Started' }];
    w.setNeedsApproval(1, 0, true);
    if (t.subitems[0].needsApproval !== true || !t.history.some(h => h.field === 'subitem-needsApproval' && h.source === 'Durand')) throw new Error('step flag not set/logged');
    w.setNeedsApproval(1, null, true);
    if (t.needsApproval !== true || !t.history.some(h => h.field === 'needsApproval')) throw new Error('task flag not set/logged');
    w.openTaskCard(1);
    if (!doc.getElementById('taskModal').innerHTML.includes('approval')) throw new Error('toggle not rendered on the card');
    w.closeTaskCard();
    w.setNeedsApproval(1, 0, false); w.setNeedsApproval(1, null, false);
  });
  tryCall('time picker: a button opens a pop-over with scroll-capped hour and minute columns; picking hour then minute applies HH:mm; no "no time" option', () => {
    const html = w.timeSelectHtml_('11:15', 'x(v)');
    if (!/time-btn/.test(html) || !/data-value="11:15"/.test(html) || !/>11:15 AM</.test(html)) throw new Error('button html ' + html.slice(0, 200));
    if (!/\.time-pop-col \{[^}]*max-height: 168px[^}]*overflow-y: auto/.test(doc.querySelector('style').textContent)) throw new Error('columns not scroll-capped');
    const host = doc.createElement('div'); host.innerHTML = w.timeSelectHtml_('11:15', 'x(v)'); doc.body.appendChild(host);
    const btn = host.querySelector('.time-btn'); const got = [];
    const pop = w.openTimePop_(btn, v => got.push(v));
    if (!pop || pop.querySelectorAll('.hours .time-opt').length !== 15 || pop.querySelectorAll('.mins .time-opt').length !== 4) throw new Error('pop contents');
    if (!pop.querySelector('.hours .time-opt.on') || pop.querySelector('.hours .time-opt.on').dataset.h !== '11') throw new Error('current hour not marked');
    pop.querySelector('.hours [data-h="14"]').click();
    if (got[got.length - 1] !== '14:15' || btn.dataset.value !== '14:15' || !doc.body.contains(pop)) throw new Error('hour pick ' + JSON.stringify(got));
    pop.querySelector('.mins [data-m="30"]').click();
    if (got[got.length - 1] !== '14:30' || btn.textContent !== '2:30 PM' || doc.body.contains(pop)) throw new Error('minute pick ' + JSON.stringify(got));
    const pop2 = w.openTimePop_(btn, v => got.push(v));
    if (pop2.querySelector('[data-none]') || /no time/.test(pop2.textContent)) throw new Error('"no time" option is back'); w.closeTimePop_();
    host.innerHTML = w.timeSelectHtml_('10:00', '', '', 'mfStartTest'); w.setTimePick_('mfStartTest', '13:45');
    if (doc.getElementById('mfStartTest').value !== '13:45' || host.querySelector('.time-btn').textContent !== '1:45 PM') throw new Error('setTimePick_');
    host.remove();
    w.openTaskCard(1);
    if (doc.querySelector('#taskModal input[type="time"]') || !doc.querySelector('#taskModal .time-btn')) throw new Error('card picker');
    w.closeTaskCard();
  });
  tryCall('comments panel: "Send N open to Claude" lists only unresolved non-Claude comments in the prompt', () => {
    w.eval("COMMENTS = [{ id: 'c1', ts: '2026-09-17T20:00:00Z', author: 'Durand', text: 'Move this to Friday', anchor: { kind: 'task', id: 1, label: 'Task one' }, resolved: false }, { id: 'c2', ts: '2026-09-17T20:01:00Z', author: 'Claude', text: 'noted', anchor: { kind: 'task', id: 1, label: 'Task one' }, resolved: false }, { id: 'c3', ts: '2026-09-17T20:02:00Z', author: 'Durand', text: 'old', anchor: { kind: 'task', id: 2, label: 'Two' }, resolved: true }]");
    w.openCommentsPanel();
    if (!doc.getElementById('dayViewBody').innerHTML.includes('Send 1 open to Claude')) throw new Error('no send button');
    const p = w.commentsPromptFor_();
    if (!p.includes('[c1]') || p.includes('[c2]') || p.includes('[c3]') || !p.includes('Move this to Friday') || !p.includes('replyTo')) throw new Error('prompt ' + p.slice(0, 300));
    w.closeDayView(); w.eval('COMMENTS = []');
  });
  tryCall('inbox error rows carry Retry and Dismiss; Retry posts retry_filed; errors wrap; the alert lands on General', async () => {
    w.eval("RAW_META.inboxErrors = [{ ts: new Date().toISOString(), file: 'mixed.json', op: 'bulk', error: 'a very long error message that must wrap ' + 'x'.repeat(300) }]");
    const html = w.inboxErrorsHtml_();
    if (!/retryInboxError_\('mixed.json'\)/.test(html) || !/dismissInboxError_\('mixed.json'\)/.test(html) || !/class="inbox-err"/.test(html)) throw new Error('buttons/wrap ' + html.slice(0, 200));
    if (!/#inboxErrorsList \.inbox-err \{[^}]*pre-wrap/.test(doc.querySelector('style').textContent)) throw new Error('no wrapping rule');
    w.__posts = []; w.retryInboxError_('mixed.json');
    const p = (w.__posts || []).find(x => x.body && x.body.includes('retry_filed'));
    if (!p || JSON.parse(p.body).file !== 'mixed.json') throw new Error('no retry post');
    const a = w.computeAlerts().find(x => x.openSettings); const i = w.computeAlerts().indexOf(a);
    w.eval('LAST_ALERTS = computeAlerts()');
    w.openAlertTasks(i);
    await new Promise(r => setTimeout(r, 30));
    const active = doc.querySelector('.settings-tab.active');
    if (!active || active.dataset.tab !== 'general' || !doc.getElementById('inboxErrorsList')) throw new Error('did not land on General: ' + (active && active.dataset.tab));
    if (!/toasts and email/.test(w.notifyStateText_('denied'))) throw new Error('state text');
    w.closeSettings(); w.eval('RAW_META.inboxErrors = []');
  });
  tryCall('setView(table)', () => w.setView('table'));
  tryCall('setView(cards)', () => w.setView('cards'));
  tryCall('setView(today)', () => w.setView('today'));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 2500);
