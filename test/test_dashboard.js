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
      if (opts && opts.method === 'POST') {
        window.__posts = window.__posts || []; window.__posts.push({ url: u, body: opts.body });
        if (u.includes('target=sendDirections')) return { ok: true, status: 200, json: async () => ({ ok: true, url: 'https://www.google.com/maps/dir/?api=1', sentTo: 'durand@thestawaszgroup.com' }) };
        if (u.includes('target=tidy')) return { ok: true, status: 200, json: async () => ({ ok: true, taskId: 2, before: { title: 'Text Marj About The Flyer Proof', notes: '', priority: 'Medium', taskType: 'Text/Chat', group: 'Marketing', estHours: 0.25, tags: [] }, proposal: { title: 'Text Marj: confirm the flyer proof is approved', notes: 'Current state: waiting on Marj.', priority: 'Medium', taskType: 'Text/Chat', group: 'Marketing', estHours: 0.25, tags: ['Flyers'], rationale: 'Sharpened the ask.' } }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, serverVersion: 1 }) };
      }
      if (u.includes('api=data')) return { ok: true, status: 200, json: async () => fakeData };
      if (u.includes('api=calendar')) return { ok: true, status: 200, json: async () => [] };
      if (u.includes('api=meetings')) { window.__meetingsFetchUrls.push(u); return { ok: true, status: 200, json: async () => ({ events: window.__pickerEvents || [], bestGuessId: null }) }; }
      if (u.includes('api=geocode')) return { ok: true, status: 200, json: async () => ({ ok: true, places: [{ label: '45 Baltimore Pike, Media, PA 19063, USA', name: '' }] }) };
      if (u.includes('api=mailSearch')) return { ok: true, status: 200, json: async () => ({ ok: true, threads: [{ url: 'https://mail.google.com/mail/u/0/#all/t9', label: 'Flyer proof thread', from: 'marj@thestawaszgroup.com', date: '2026-09-10', count: 2 }] }) };
      if (u.includes('api=meetingSlots')) { window.__slotsUrl = u; return { ok: true, status: 200, json: async () => ({ ok: true, minutes: 60, guestCalendar: false, window: 'fallback', slots: [{ startISO: '2026-09-22T14:00:00.000Z', endISO: '2026-09-22T15:00:00.000Z', dateLabel: 'Tue, Sep 22', timeLabel: '10:00 AM–11:00 AM' }] }) }; }
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
      w.toggleCommentMode();
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
    T.push({ id: 910, title: 'Drop off the lockbox', owner: 'Durand', status: 'Not Started', priority: 'Medium', group: 'Errands', tags: [], taskType: 'Actionable Task',
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
    w.eval("RULESETS = { meta: {}, current: {}, history: [], threads: {} }; rulesetsLoaded = true; settingsTab = 'team';");
    w.renderSettings();
    if (!doc.getElementById('homeBaseInput')) throw new Error('no Home base input on the Team tab');
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
      T.push({ id: 912, title: 'Drop off the keys', owner: 'Durand', status: 'Not Started', priority: 'Medium', group: 'Errands', tags: [], taskType: 'Actionable Task', timelineEnd: w.todayISO(), progress: 0, depends: '', doc: '', docs: [], notes: '', estHours: 0.5, estDays: 1, estSource: 'claude', location: 'x', travelMin: 30, travelOneWayMin: 15, travelMode: 'oneway', history: [], subitems: [] });
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
  tryCall('link picker searches email and a picked thread becomes an email link', () => {
    w.openNewTaskModal({});
    w.addManualDoc('__new__');
    if (!doc.getElementById('linkMailSearch')) throw new Error('no mail search box');
    doc.getElementById('linkMailSearch').value = 'flyer proof';
  });
  await w.runLinkMailSearch_();
  tryCall('mail results render and pick as type email', () => {
    if (!doc.getElementById('linkMailResults').textContent.includes('Flyer proof thread')) throw new Error('no thread row');
    w.addLinkMailResult_(0);
    const fields = w.newTaskFieldsFromModal_();
    if (!fields.docs || fields.docs[0].type !== 'email') throw new Error('not typed email: ' + JSON.stringify(fields.docs));
    if (!doc.getElementById('ntDocs').innerHTML.includes('&#9993;') && !doc.getElementById('ntDocs').innerHTML.includes('✉')) throw new Error('no email icon');
    w.closeNewTaskModal();
  });
  tryCall('the Claude prompt carries the task, its steps, links and the write-back instruction', () => {
    const t = w.findTask(1);
    const p = w.claudePromptFor_(t);
    if (!p.includes('task #1') || !p.includes(t.title)) throw new Error('missing head');
    if (!p.includes('Steps:') || !p.includes(t.subitems[0].title)) throw new Error('missing steps');
    if (!p.includes('tsg-task-tracker-protocol')) throw new Error('missing write-back instruction');
    if (!w.claudeUrlFor_(t).startsWith('https://claude.ai/new?q=TSG')) throw new Error('bad url: ' + w.claudeUrlFor_(t).slice(0, 40));
  });
  tryCall('a Claude-typed task shows the Open in Claude row; a task with a claude.ai link too', () => {
    const t = w.findTask(1);
    const prevType = t.taskType;
    t.taskType = 'Claude';
    w.openTaskCard(1);
    if (!doc.getElementById('modalMeta').innerHTML.includes('Open in Claude with this task')) throw new Error('no Claude row');
    t.taskType = prevType;
    t.docs = (t.docs || []).concat([{ url: 'https://claude.ai/code/session_01XYZ', label: 'Claude Code session', type: 'claude' }]);
    w.openTaskCard(1);
    if (!doc.getElementById('modalMeta').innerHTML.includes('Open linked thread')) throw new Error('no linked-thread button');
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
    if (!doc.getElementById('mfSlots').textContent.includes('Nothing free Mon–Thu 9–2')) throw new Error('fallback hint missing');
    w.useMeetingSlot_(0);
    if (doc.getElementById('mfDate').value !== '2026-09-22') throw new Error('date not filled: ' + doc.getElementById('mfDate').value);
    if (!/^\d\d:\d\d$/.test(doc.getElementById('mfStart').value)) throw new Error('start not filled');
    if (doc.getElementById('mfDuration').value !== '60') throw new Error('duration not filled');
    w.closeMeetingPicker();
  });

  tryCall('setView(table)', () => w.setView('table'));
  tryCall('setView(cards)', () => w.setView('cards'));
  tryCall('setView(today)', () => w.setView('today'));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 2500);
