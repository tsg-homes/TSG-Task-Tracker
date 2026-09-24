// jsdom smoke test for person.html, the per-person view (Board-style since 2026-09-15).
// Stamps the placeholders the way doGet does, fakes google.script.run.tsgPersonRpc, and
// checks that the slice renders into the right groups, only the editable controls exist
// (progress is never an input), subtasks nest under her own tasks, and edits/adds send
// the right RPC payloads.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let html = fs.readFileSync(path.join(__dirname, '..', 'person.html'), 'utf8');
html = html.split('__TSG_PERSON__').join('Marj').split('__TSG_AS__').join('').split('__TSG_CODE_VERSION__').join('2026-09-15.5');

const slice = {
  ok: true, person: 'Marj', docVersion: 100, codeVersion: '2026-09-15.5',
  statuses: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done - Pending'], pendingStatus: 'Done - Pending', priorities: ['Critical', 'High', 'Medium', 'Low'],
  feedbackTaskId: 7, feedbackKinds: ['Bug', 'Feature request', 'Feedback'],
  fubKey: { present: false, enabled: true, setAt: '', fubUserName: '', cadenceMin: 240 },
  fubSync: { enabled: true, readOnly: true, lastRunAt: '2026-09-24T12:00:00Z', ok: true, error: '', cadenceMin: 60 },
  rows: [
    { kind: 'task', id: 1, own: false, context: true, title: 'Durand task with Marj sub', status: 'Not Started', priority: 'High', progress: 0, due: '2026-09-20', notes: '', owner: 'Durand', tags: [], taskType: '', estHours: null, subTotal: 1, subDone: 0, editable: [] },
    { kind: 'sub', id: 1, index: 0, own: false, parentOwn: false, parentTitle: 'Durand task with Marj sub', title: 'Marj part', status: 'Not Started', priority: 'High', progress: 0, done: false, due: '2026-09-18', notes: '', owner: 'Durand', subTotal: 0, editable: ['status', 'notes'] },
    { kind: 'task', id: 2, own: false, title: 'Assigned to Marj', status: 'Not Started', priority: 'Medium', progress: 0, due: '2026-09-25', notes: 'from Durand', owner: 'Durand', tags: ['Marketing'], taskType: 'Hands-on', estHours: 1, subTotal: 0, subDone: 0, editable: ['status', 'notes'] },
    { kind: 'task', id: 3, own: true, title: "Marj's own task", status: 'In Progress', priority: 'Low', progress: 30, due: '', notes: 'mine', owner: 'Marj', tags: ['Self-created'], taskType: '', estHours: null, subTotal: 0, subDone: 0, editable: ['title', 'status', 'priority', 'timelineEnd', 'notes'] },
    { kind: 'task', id: 5, own: true, title: 'Flyer print run', status: 'In Progress', priority: 'Medium', progress: 50, due: '2026-09-30', notes: 'n', owner: 'Marj', tags: ['Self-created', 'Flyers'], taskType: 'Hands-on', estHours: 3, subTotal: 2, subDone: 1, editable: ['title', 'status', 'priority', 'timelineEnd', 'notes'] },
    { kind: 'sub', id: 5, index: 0, own: false, parentOwn: true, parentTitle: 'Flyer print run', title: 'Draft the copy', status: 'Done', priority: 'Medium', progress: 100, done: true, due: '2026-09-22', notes: '', owner: 'Marj', subTotal: 0, editable: ['status', 'notes'] },
    { kind: 'sub', id: 5, index: 1, own: false, parentOwn: true, parentTitle: 'Flyer print run', title: 'Send to printer', status: 'Not Started', priority: 'Medium', progress: 0, done: false, due: '2026-09-29', notes: '', owner: 'Marj', subTotal: 0, editable: ['status', 'notes'] },
    { kind: 'task', id: 6, own: true, title: 'Finished thing', status: 'Done', priority: 'Low', progress: 100, due: '2026-09-10', notes: '', owner: 'Marj', tags: [], taskType: '', estHours: 0.5, subTotal: 0, subDone: 0, editable: ['title', 'status', 'priority', 'timelineEnd', 'notes'] },
    { kind: 'task', id: 7, own: false, pinned: true, feedbackFor: 'Marj', title: '@Marj — Bug reports, feature requests and feedback', status: 'In Progress', priority: 'Medium', progress: 0, due: '', notes: 'File anything here.', owner: 'Durand', tags: ['Feedback'], taskType: '', estHours: null, subTotal: 1, subDone: 0, editable: ['status', 'notes'], docs: [{ url: 'https://docs.google.com/document/d/GUIDE/edit', label: 'How-to: Task Tracker for Delegates', type: 'link' }] },
    { kind: 'sub', id: 7, index: 0, own: false, parentOwn: false, parentTitle: '@Marj — Bug reports, feature requests and feedback', title: '[Bug] Date picker jumps', status: 'Not Started', priority: 'Medium', progress: 0, done: false, due: '', notes: 'Opens on the wrong month', owner: 'Durand', subTotal: 0, editable: ['notes'], feedback: { kind: 'Bug', decision: '', decidedAt: '', implementedAt: '' } },
    { kind: 'task', id: 9, own: false, title: 'Call Ann Lee back', status: 'Not Started', priority: 'Medium', progress: 0, due: '2026-10-01', notes: '', owner: 'Durand', tags: ['FUB'], taskType: 'Call', estHours: null, subTotal: 0, subDone: 0, editable: [], docs: [],
      fub: { type: 'Call', personName: 'Ann Lee', personUrl: 'https://tsg.followupboss.com/2/people/view/77', updated: '2026-09-23T15:00:00Z', readOnly: true, fields: ['title', 'taskType', 'timelineEnd', 'dueTime', 'status', 'owner', 'delegate'] } },
    { kind: 'task', id: 8, own: false, title: 'Pending one', status: 'Done - Pending', priority: 'Medium', progress: 100, due: '2026-09-26', notes: 'all done', owner: 'Durand', tags: [], taskType: 'Hands-on', estHours: null, subTotal: 0, subDone: 0, editable: ['status', 'notes'] }
  ]
};
const calls = [];
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://script.google.com/macros/s/FAKE/exec',
  beforeParse(window) {
    window.google = { script: { run: (function() {
      const chain = {};
      chain.withSuccessHandler = function(fn) { chain._ok = fn; return chain; };
      chain.withFailureHandler = function(fn) { chain._fail = fn; return chain; };
      chain.tsgPersonRpc = function(action, payloadJson) {
        const payload = JSON.parse(payloadJson);
        calls.push({ action, payload });
        let reply;
        if (action === 'load') reply = slice;
        else if (action === 'version') reply = { ok: true, docVersion: 100 };
        else if (action === 'update') reply = payload.fields.priority !== undefined && payload.kind === 'task' && payload.id === 2 ? { ok: false, error: 'field not editable: priority' } : { ok: true, docVersion: 101 };
        else if (action === 'add') reply = { ok: true, docVersion: 102 };
        else if (action === 'feedback') reply = { ok: true, docVersion: 103 };
        else if (action === 'fubKeySet') reply = payload.key === 'ka_goodKEY1234567890abc' ? { ok: true, fubUser: { name: 'Marj M', email: 'marjorie@tsg.homes' } } : { ok: false, error: 'FUB rejected that key. Copy it again from FUB and paste the whole key.' };
        else if (action === 'fubSync') reply = { ok: true, wrote: true, result: { ok: true, added: 2, updated: 1, completed: 0, cancelled: 0 } };
        else reply = { ok: false, error: 'unknown' };
        setTimeout(() => chain._ok(JSON.stringify(reply)), 0);
      };
      return chain;
    })() } };
    window.onerror = function(msg, src, line, col, err) { errors.push({ msg, stack: err && err.stack }); return true; };
    window.addEventListener('unhandledrejection', (e) => errors.push({ msg: 'UNHANDLED: ' + e.reason }));
  }
});

let FAILS = 0;
function check(label, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label); if (!cond) FAILS++; }

setTimeout(async () => {
  const w = dom.window, doc = w.document;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const lastUpdate = () => calls.filter(c => c.action === 'update').pop();

  check('load was requested on boot', calls.some(c => c.action === 'load'));
  check('masthead shows the person and the theme is set like the dashboard', doc.querySelector('h1').textContent.includes('Marj') && /^(light|dark)$/.test(doc.documentElement.getAttribute('data-theme')) && !!doc.getElementById('themeToggle'));
  check('preview badge hidden when not previewing', doc.getElementById('previewBadge').hidden === true);
  check('no comment controls on the person\'s own page (owner-only)', doc.getElementById('btnCommentMode').hidden === true && doc.getElementById('btnComments').hidden === true);
  check('board-style groups: Delegated to you, Your tasks, Completed', doc.querySelectorAll('.group-section .group-head .gname').length === 3 && doc.getElementById('completed').hidden === false);
  const delegatedRows = doc.querySelectorAll('#delegated tr[data-key]');
  const ownRows = doc.querySelectorAll('#own tr[data-key]');
  check("delegated group has Durand's parent as a context row, the assigned task, the pinned feedback task, the pending one and the FUB task", delegatedRows.length === 5 && doc.getElementById('delegatedCount').textContent === '5');
  const fubRow = doc.querySelector('#delegated tr[data-id="9"]');
  check('a FUB task is read-only (no selects, inputs or editable text), carries the FUB chip with the contact link, and the row is marked for the red outline', !!fubRow && fubRow.classList.contains('fub') && !fubRow.querySelector('select, input') && !fubRow.querySelector('[contenteditable="true"]') && /FUB · Call · Ann Lee/.test(fubRow.querySelector('.fub-chip').textContent) && fubRow.querySelector('.fub-chip a').getAttribute('href') === 'https://tsg.followupboss.com/2/people/view/77' && !!fubRow.querySelector('.pill.status-pill-ro') && !fubRow.querySelector('.tag-chip'));
  check('the red outline rule covers the FUB fields on a FUB row', /tr\.task-row\.fub \.ttl-edit[^{]*\{ outline: 2px solid var\(--status-critical\)/.test(doc.querySelector('style').textContent));
  check('the Sync FUB button and the last-sync line show when the sync is set up for her', doc.getElementById('btnFubSync').hidden === false && /FUB synced/.test(doc.getElementById('fubSyncInfo').textContent));
  doc.getElementById('btnFubSync').click();
  await wait(30);
  // Settings pane: the agent adds their own FUB key; it is sent once, cleared from the page, never shown
  doc.getElementById('btnSettings').click();
  check('Settings opens the pane with the FUB key field (a password input) and the not-connected status', doc.getElementById('settingsBack').hidden === false && doc.getElementById('fubKeyInput').type === 'password' && /Not connected yet/.test(doc.getElementById('fubKeyStatus').textContent) && doc.getElementById('fubKeyRemove').hidden === true);
  doc.getElementById('fubKeyInput').value = 'ka_badKEY12345678901234';
  doc.getElementById('fubKeyForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  check('the key is cleared from the field the moment it is sent', doc.getElementById('fubKeyInput').value === '');
  await wait(30);
  check('a rejected key shows FUB\'s refusal', /FUB key not saved: FUB rejected that key/.test(doc.getElementById('sync').textContent) && calls.filter(c => c.action === 'fubKeySet').pop().payload.key === 'ka_badKEY12345678901234');
  doc.getElementById('fubKeyInput').value = 'ka_goodKEY1234567890abc';
  doc.getElementById('fubKeyForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(30);
  check('an accepted key reports the FUB user it belongs to, and the key is nowhere in the page', /FUB connected as Marj M|Up to date/.test(doc.getElementById('sync').textContent) && !doc.documentElement.outerHTML.includes('ka_goodKEY1234567890abc'));
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the pane', doc.getElementById('settingsBack').hidden === true);
  check('Sync FUB calls rpc fubSync and reports the batch', calls.some(c => c.action === 'fubSync') && /FUB synced|Up to date/.test(doc.getElementById('sync').textContent));
  const ctxRow = doc.querySelector('#delegated tr.task-row.context[data-id="1"]');
  check('context row: read-only (no selects, no inputs, no editable title/notes), names the owner', !!ctxRow && !ctxRow.querySelector('select, input') && !ctxRow.querySelector('[contenteditable="true"]') && /Durand/.test(ctxRow.querySelector('.ctx-note').textContent) && ctxRow.querySelector('.sub-count-badge').textContent === '0/1');
  check('her step is nested under the context row and open by default', doc.querySelectorAll('tr.sub-row[data-subrow="1"] .sub-item').length === 1 && doc.querySelector('tr.sub-row[data-subrow="1"]').style.display !== 'none');
  check('own group has her two open tasks; the Done one moved to Completed', ownRows.length === 2 && doc.querySelectorAll('#completed tr[data-key]').length === 1 && doc.getElementById('completedCount').textContent === '1');
  check('group heads carry a status battery and percent', doc.querySelector('#own .status-battery') && /%$/.test(doc.querySelector('#own .group-battery-pct').textContent));
  const delegatedTask = doc.querySelector('#delegated tr[data-kind="task"][data-id="2"]');
  check('delegated row: status is a pill select, priority a static pill, due plain text', !!delegatedTask.querySelector('select.pill[data-field="status"]') && !delegatedTask.querySelector('select[data-field="priority"]') && !!delegatedTask.querySelector('.pill.priority-medium') && !delegatedTask.querySelector('input[data-field="due"]') && /Sep 25/.test(delegatedTask.querySelector('.due-cell').textContent));
  check('delegated row: owner avatar, type badge and tag chip like the board', !!delegatedTask.querySelector('.avatar') && delegatedTask.querySelector('.type-badge').textContent === 'Hands-on' && delegatedTask.querySelector('.tag-chip').textContent === 'Marketing');
  check('delegated row: notes editable inline', delegatedTask.querySelector('[data-field="notes"]').getAttribute('contenteditable') === 'true');
  const ownRow = doc.querySelector('#own tr[data-kind="task"][data-id="3"]');
  check('own row: priority pill select, due input and editable title', !!ownRow.querySelector('select.pill[data-field="priority"]') && !!ownRow.querySelector('input[data-field="due"]') && ownRow.querySelector('.ttl-edit').getAttribute('contenteditable') === 'true');
  check('progress is a read-only track everywhere; no progress input exists', !doc.querySelector('input[data-field="progress"]') && ownRow.querySelector('.progress-fill').style.width === '30%' && ownRow.querySelector('.pct').textContent === '30%');
  const stepped = doc.querySelector('#own tr[data-kind="task"][data-id="5"]');
  check('a task with subtasks shows the done count badge and its ratio as progress', stepped.querySelector('.sub-count-badge').textContent === '1/2' && stepped.querySelector('.pct').textContent === '50%');
  check('no token or exec URL anywhere in the page', !/AKfycb|token=|script\.google\.com\/macros/.test(doc.documentElement.outerHTML));

  // status change on the delegated subitem -> update with kind/id/index/fields
  const subRow = doc.querySelector('tr.sub-row[data-subrow="1"] .sub-item[data-kind="sub"]');
  const statusSel = subRow.querySelector('select[data-field="status"]');
  statusSel.value = 'Done - Pending';
  statusSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(30);
  let upd = lastUpdate();
  check('status change sends update {kind:sub,id:1,index:0,fields:{status:Done - Pending}}', !!upd && upd.payload.kind === 'sub' && upd.payload.id === 1 && upd.payload.index === 0 && upd.payload.fields.status === 'Done - Pending');
  check('a save reloads the slice afterwards', calls.filter(c => c.action === 'load').length >= 2);
  check('sync label reports Saved', /Saved|Up to date/.test(doc.getElementById('sync').textContent));

  // notes edit on the assigned task -> update with notes only (progress is the server's job)
  const notesEl = doc.querySelector('#delegated tr[data-id="2"] [data-field="notes"]');
  notesEl.textContent = 'Proof sent to the printer';
  notesEl.dispatchEvent(new w.Event('focusout', { bubbles: true }));
  await wait(30);
  upd = lastUpdate();
  check('notes edit sends only the notes; no progress field travels with it', !!upd && upd.payload.kind === 'task' && upd.payload.id === 2 && upd.payload.fields.notes === 'Proof sent to the printer' && upd.payload.fields.progress === undefined);

  // subtasks nest under her own task, open by default; the caret collapses
  const subItems = doc.querySelectorAll('tr.sub-row[data-subrow="5"] .sub-item');
  check('her own task shows both steps as cards, open by default, the done one struck through', doc.querySelector('tr.sub-row[data-subrow="5"]').style.display !== 'none' && subItems.length === 2 && subItems[0].classList.contains('done'));
  doc.querySelector('[data-expand="5"]').click();
  await wait(10);
  check('the caret collapses the steps', doc.querySelector('tr.sub-row[data-subrow="5"]').style.display === 'none');
  doc.querySelector('[data-expand="5"]').click();
  await wait(10);
  const box = doc.querySelectorAll('tr.sub-row[data-subrow="5"] .sub-item')[1].querySelector('input[data-field="done"]');
  box.checked = true;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(30);
  upd = lastUpdate();
  check('checking a subtask sends update {kind:sub,id:5,index:1,fields:{status:Done - Pending}}: a delegate never sends Done (2026-09-23)', !!upd && upd.payload.kind === 'sub' && upd.payload.id === 5 && upd.payload.index === 1 && upd.payload.fields.status === 'Done - Pending');
  check('the status list offered has no Done; Done - Pending is on it and styled as a pending pill', !Array.from(doc.querySelectorAll('select[data-field="status"] option')).some(o => o.value === 'Done') && Array.from(doc.querySelectorAll('select[data-field="status"] option')).some(o => o.value === 'Done - Pending') && !!doc.querySelector('#delegated tr[data-id="8"] select.pill.status-done-pending') && /Waiting for Durand/.test(doc.querySelector('#delegated tr[data-id="8"]').textContent));
  // feedback task: pinned, links the how-to, its item is read-only except the notes, and the Feedback button files a new one
  const fbTask = doc.querySelector('#delegated tr[data-id="7"]');
  check('the feedback task row is marked pinned and links the how-to guide', !!fbTask && !!fbTask.querySelector('.pin-mark') && fbTask.querySelector('a.doc-chip').getAttribute('href') === 'https://docs.google.com/document/d/GUIDE/edit' && /How-to/.test(fbTask.querySelector('a.doc-chip').textContent));
  const fbItem = doc.querySelector('tr.sub-row[data-subrow="7"] .sub-item');
  check('a feedback item shows its kind and state, no checkbox, no status select, notes editable', !!fbItem && /Bug · sent to Durand/.test(fbItem.querySelector('.fb-badge').textContent) && !fbItem.querySelector('input[type="checkbox"]') && !fbItem.querySelector('select') && fbItem.querySelector('[data-field="notes"]').getAttribute('contenteditable') === 'true');
  check('the Feedback button is shown because she has a feedback task', doc.getElementById('btnFeedback').hidden === false);
  doc.getElementById('btnFeedback').click();
  check('the Feedback button opens the form with the three kinds', doc.getElementById('feedbackBack').hidden === false && Array.from(doc.querySelectorAll('#fbKind option')).map(o => o.value).join() === 'Bug,Feature request,Feedback');
  doc.getElementById('fbKind').value = 'Feature request';
  doc.getElementById('fbText').value = 'A dark mode toggle on the card too\nWould help at night';
  doc.getElementById('feedbackForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(30);
  const fb = calls.filter(c => c.action === 'feedback').pop();
  check('submitting sends rpc feedback {kind, text} and closes the form', !!fb && fb.payload.kind === 'Feature request' && /dark mode toggle/.test(fb.payload.text) && doc.getElementById('feedbackBack').hidden === true && /Sent to Durand|Up to date/.test(doc.getElementById('sync').textContent));

  // add form -> add with title/priority/due/notes
  doc.getElementById('btnOpenAdd').click();
  check('+ Task opens the add form', doc.getElementById('addForm').classList.contains('open'));
  doc.getElementById('addTitle').value = 'Order flyer proofs';
  doc.getElementById('addPriority').value = 'High';
  doc.getElementById('addDue').value = '2026-09-30';
  doc.getElementById('addNotes').value = 'ask printer';
  doc.getElementById('addForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  check('while the add is in flight the board is locked and the form disabled, with a spinner', doc.getElementById('board').classList.contains('busy') && doc.getElementById('addTitle').disabled && !!doc.querySelector('#sync .spin'));
  await wait(30);
  check('the lock lifts when the add completes', !doc.getElementById('board').classList.contains('busy') && !doc.getElementById('addTitle').disabled);
  const add = calls.filter(c => c.action === 'add').pop();
  check('add form sends the four fields', !!add && add.payload.title === 'Order flyer proofs' && add.payload.priority === 'High' && add.payload.due === '2026-09-30' && add.payload.notes === 'ask printer');
  check('add form clears and closes after success', doc.getElementById('addTitle').value === '' && !doc.getElementById('addForm').classList.contains('open'));

  // card / edit view: click a row (not a control) -> card with the same rules
  doc.querySelector('#own tr[data-id="3"] td.cell-group').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(10);
  const card = doc.getElementById('card');
  check('clicking her own task opens the card with editable title, status, priority, due and notes', doc.getElementById('cardBack').hidden === false && card.querySelector('.card-title').textContent === "Marj's own task" && card.querySelector('.card-title').getAttribute('contenteditable') === 'true' && !!card.querySelector('select[data-field="status"]') && !!card.querySelector('select[data-field="priority"]') && !!card.querySelector('input[data-field="due"]') && card.querySelector('.card-notes-edit').getAttribute('contenteditable') === 'true');
  const cardStatus = card.querySelector('select[data-field="status"]');
  cardStatus.value = 'Blocked';
  cardStatus.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(30);
  upd = lastUpdate();
  check('a change made in the card saves against that task', !!upd && upd.payload.kind === 'task' && upd.payload.id === 3 && upd.payload.fields.status === 'Blocked');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the card', doc.getElementById('cardBack').hidden === true);
  doc.querySelector('#delegated tr.task-row.context[data-id="1"] td.cell-group').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(10);
  check("Durand's task opens as a read-only card with her step listed and no notes", doc.getElementById('cardBack').hidden === false && card.querySelector('.card-title').getAttribute('contenteditable') === 'false' && !card.querySelector('.card-grid select, .card-grid input') && !card.querySelector('.card-notes') && card.querySelectorAll('.sub-item').length === 1 && !!card.querySelector('.sub-item select[data-field="status"]'));
  doc.querySelector('#cardClose').click();
  check('the close button closes the card', doc.getElementById('cardBack').hidden === true);

  // group collapse
  doc.querySelector('#delegated .group-head').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(10);
  check('clicking a group head collapses it', doc.getElementById('delegated').classList.contains('collapsed'));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 400);
