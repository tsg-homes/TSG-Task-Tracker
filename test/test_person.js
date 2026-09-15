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
  statuses: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done'], priorities: ['Critical', 'High', 'Medium', 'Low'],
  rows: [
    { kind: 'sub', id: 1, index: 0, own: false, parentOwn: false, parentTitle: 'Durand task with Marj sub', title: 'Marj part', status: 'Not Started', priority: 'High', progress: 0, done: false, due: '2026-09-18', notes: '', owner: 'Durand', subTotal: 0, editable: ['status', 'notes'] },
    { kind: 'task', id: 2, own: false, title: 'Assigned to Marj', status: 'Not Started', priority: 'Medium', progress: 0, due: '2026-09-25', notes: 'from Durand', owner: 'Durand', tags: ['Marketing'], taskType: 'Actionable Task', estHours: 1, subTotal: 0, subDone: 0, editable: ['status', 'notes'] },
    { kind: 'task', id: 3, own: true, title: "Marj's own task", status: 'In Progress', priority: 'Low', progress: 30, due: '', notes: 'mine', owner: 'Marj', tags: ['Self-created'], taskType: '', estHours: null, subTotal: 0, subDone: 0, editable: ['title', 'status', 'priority', 'timelineEnd', 'notes'] },
    { kind: 'task', id: 5, own: true, title: 'Flyer print run', status: 'In Progress', priority: 'Medium', progress: 50, due: '2026-09-30', notes: 'n', owner: 'Marj', tags: ['Self-created', 'Flyers'], taskType: 'Actionable Task', estHours: 3, subTotal: 2, subDone: 1, editable: ['title', 'status', 'priority', 'timelineEnd', 'notes'] },
    { kind: 'sub', id: 5, index: 0, own: false, parentOwn: true, parentTitle: 'Flyer print run', title: 'Draft the copy', status: 'Done', priority: 'Medium', progress: 100, done: true, due: '2026-09-22', notes: '', owner: 'Marj', subTotal: 0, editable: ['status', 'notes'] },
    { kind: 'sub', id: 5, index: 1, own: false, parentOwn: true, parentTitle: 'Flyer print run', title: 'Send to printer', status: 'Not Started', priority: 'Medium', progress: 0, done: false, due: '2026-09-29', notes: '', owner: 'Marj', subTotal: 0, editable: ['status', 'notes'] },
    { kind: 'task', id: 6, own: true, title: 'Finished thing', status: 'Done', priority: 'Low', progress: 100, due: '2026-09-10', notes: '', owner: 'Marj', tags: [], taskType: '', estHours: 0.5, subTotal: 0, subDone: 0, editable: ['title', 'status', 'priority', 'timelineEnd', 'notes'] }
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
  check('board-style groups: Delegated to you, Your tasks, Completed', doc.querySelectorAll('.group-section .group-head .gname').length === 3 && doc.getElementById('completed').hidden === false);
  const delegatedRows = doc.querySelectorAll('#delegated tr[data-key]');
  const ownRows = doc.querySelectorAll('#own tr[data-key]');
  check('delegated group has the subitem and the assigned task', delegatedRows.length === 2 && doc.getElementById('delegatedCount').textContent === '2');
  check('own group has her two open tasks; the Done one moved to Completed', ownRows.length === 2 && doc.querySelectorAll('#completed tr[data-key]').length === 1 && doc.getElementById('completedCount').textContent === '1');
  check('group heads carry a status battery and percent', doc.querySelector('#own .status-battery') && /%$/.test(doc.querySelector('#own .group-battery-pct').textContent));
  check('delegated subitem shows its parent task title', doc.querySelector('#delegated .parent').textContent.includes('Durand task with Marj sub'));
  const delegatedTask = doc.querySelector('#delegated tr[data-kind="task"][data-id="2"]');
  check('delegated row: status is a pill select, priority a static pill, due plain text', !!delegatedTask.querySelector('select.pill[data-field="status"]') && !delegatedTask.querySelector('select[data-field="priority"]') && !!delegatedTask.querySelector('.pill.priority-medium') && !delegatedTask.querySelector('input[data-field="due"]') && /Sep 25/.test(delegatedTask.querySelector('.due-cell').textContent));
  check('delegated row: owner avatar, type badge and tag chip like the board', !!delegatedTask.querySelector('.avatar') && delegatedTask.querySelector('.type-badge').textContent === 'Actionable Task' && delegatedTask.querySelector('.tag-chip').textContent === 'Marketing');
  check('delegated row: notes editable inline', delegatedTask.querySelector('[data-field="notes"]').getAttribute('contenteditable') === 'true');
  const ownRow = doc.querySelector('#own tr[data-kind="task"][data-id="3"]');
  check('own row: priority pill select, due input and editable title', !!ownRow.querySelector('select.pill[data-field="priority"]') && !!ownRow.querySelector('input[data-field="due"]') && ownRow.querySelector('.ttl-edit').getAttribute('contenteditable') === 'true');
  check('progress is a read-only track everywhere; no progress input exists', !doc.querySelector('input[data-field="progress"]') && ownRow.querySelector('.progress-fill').style.width === '30%' && ownRow.querySelector('.pct').textContent === '30%');
  const stepped = doc.querySelector('#own tr[data-kind="task"][data-id="5"]');
  check('a task with subtasks shows the done count badge and its ratio as progress', stepped.querySelector('.sub-count-badge').textContent === '1/2' && stepped.querySelector('.pct').textContent === '50%');
  check('no token or exec URL anywhere in the page', !/AKfycb|token=|script\.google\.com\/macros/.test(doc.documentElement.outerHTML));

  // status change on the delegated subitem -> update with kind/id/index/fields
  const subRow = doc.querySelector('#delegated tr[data-kind="sub"]');
  const statusSel = subRow.querySelector('select[data-field="status"]');
  statusSel.value = 'Done';
  statusSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(30);
  let upd = lastUpdate();
  check('status change sends update {kind:sub,id:1,index:0,fields:{status:Done}}', !!upd && upd.payload.kind === 'sub' && upd.payload.id === 1 && upd.payload.index === 0 && upd.payload.fields.status === 'Done');
  check('a save reloads the slice afterwards', calls.filter(c => c.action === 'load').length >= 2);
  check('sync label reports Saved', /Saved|Up to date/.test(doc.getElementById('sync').textContent));

  // notes edit on the assigned task -> update with notes only (progress is the server's job)
  const notesEl = doc.querySelector('#delegated tr[data-id="2"] [data-field="notes"]');
  notesEl.textContent = 'Proof sent to the printer';
  notesEl.dispatchEvent(new w.Event('focusout', { bubbles: true }));
  await wait(30);
  upd = lastUpdate();
  check('notes edit sends only the notes; no progress field travels with it', !!upd && upd.payload.kind === 'task' && upd.payload.id === 2 && upd.payload.fields.notes === 'Proof sent to the printer' && upd.payload.fields.progress === undefined);

  // subtasks nest under her own task: expand, then check one off
  check('subtasks are collapsed until expanded', doc.querySelector('tr.sub-row[data-subrow="5"]').style.display === 'none');
  doc.querySelector('[data-expand="5"]').click();
  await wait(10);
  const subItems = doc.querySelectorAll('tr.sub-row[data-subrow="5"] .sub-item');
  check('expanding shows both subtasks as cards, the done one struck through', doc.querySelector('tr.sub-row[data-subrow="5"]').style.display !== 'none' && subItems.length === 2 && subItems[0].classList.contains('done'));
  const box = subItems[1].querySelector('input[data-field="done"]');
  box.checked = true;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(30);
  upd = lastUpdate();
  check('checking a subtask sends update {kind:sub,id:5,index:1,fields:{status:Done}}', !!upd && upd.payload.kind === 'sub' && upd.payload.id === 5 && upd.payload.index === 1 && upd.payload.fields.status === 'Done');

  // add form -> add with title/priority/due/notes
  doc.getElementById('btnOpenAdd').click();
  check('+ Task opens the add form', doc.getElementById('addForm').classList.contains('open'));
  doc.getElementById('addTitle').value = 'Order flyer proofs';
  doc.getElementById('addPriority').value = 'High';
  doc.getElementById('addDue').value = '2026-09-30';
  doc.getElementById('addNotes').value = 'ask printer';
  doc.getElementById('addForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(30);
  const add = calls.filter(c => c.action === 'add').pop();
  check('add form sends the four fields', !!add && add.payload.title === 'Order flyer proofs' && add.payload.priority === 'High' && add.payload.due === '2026-09-30' && add.payload.notes === 'ask printer');
  check('add form clears and closes after success', doc.getElementById('addTitle').value === '' && !doc.getElementById('addForm').classList.contains('open'));

  // group collapse
  doc.querySelector('#delegated .group-head').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(10);
  check('clicking a group head collapses it', doc.getElementById('delegated').classList.contains('collapsed'));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 400);
