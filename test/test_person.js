// jsdom smoke test for person.html, the per-person view. Stamps the placeholders the way
// doGet does, fakes google.script.run.tsgPersonRpc, and checks that the page renders the
// slice into the right sections, exposes only the editable controls, and sends the right
// RPC payloads for an edit and for an add.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let html = fs.readFileSync(path.join(__dirname, '..', 'person.html'), 'utf8');
html = html.split('__TSG_PERSON__').join('Marj').split('__TSG_AS__').join('').split('__TSG_CODE_VERSION__').join('2026-09-15.2');

const slice = {
  ok: true, person: 'Marj', docVersion: 100, codeVersion: '2026-09-15.2',
  statuses: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done'], priorities: ['Critical', 'High', 'Medium', 'Low'],
  rows: [
    { kind: 'sub', id: 1, index: 0, own: false, parentTitle: 'Durand task with Marj sub', title: 'Marj part', status: 'Not Started', priority: 'High', progress: 0, due: '2026-09-18', notes: '', editable: ['status', 'progress', 'notes'] },
    { kind: 'task', id: 2, own: false, title: 'Assigned to Marj', status: 'Not Started', priority: 'Medium', progress: 0, due: '2026-09-25', notes: 'from Durand', editable: ['status', 'progress', 'notes'] },
    { kind: 'task', id: 3, own: true, title: "Marj's own task", status: 'In Progress', priority: 'Low', progress: 30, due: '', notes: 'mine', editable: ['title', 'status', 'priority', 'progress', 'timelineEnd', 'notes'] }
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

  check('load was requested on boot', calls.some(c => c.action === 'load'));
  check('header shows the person', doc.querySelector('h1').textContent.includes('Marj'));
  check('preview badge hidden when not previewing', doc.getElementById('previewBadge').hidden === true);
  const delegatedRows = doc.querySelectorAll('#delegated tr[data-key]');
  const ownRows = doc.querySelectorAll('#own tr[data-key]');
  check('delegated section has the subitem and the assigned task', delegatedRows.length === 2);
  check('own section has her task', ownRows.length === 1);
  check('delegated subitem shows its parent task title', doc.querySelector('#delegated .parent').textContent.includes('Durand task with Marj sub'));
  const delegatedTask = doc.querySelector('#delegated tr[data-kind="task"][data-id="2"]');
  check('delegated row: status editable, priority and due read-only', !!delegatedTask.querySelector('select[data-field="status"]') && !delegatedTask.querySelector('select[data-field="priority"]') && !delegatedTask.querySelector('input[data-field="due"]'));
  check('delegated row: notes editable', !!delegatedTask.querySelector('textarea[data-field="notes"]'));
  const ownRow = ownRows[0];
  check('own row: priority select, due input and editable title', !!ownRow.querySelector('select[data-field="priority"]') && !!ownRow.querySelector('input[data-field="due"]') && ownRow.querySelector('.title').getAttribute('contenteditable') === 'true');
  check('no token or exec URL anywhere in the page', !/AKfycb|token=|script\.google\.com\/macros/.test(doc.documentElement.outerHTML));

  // status change on the delegated subitem -> update with kind/id/index/fields
  const subRow = doc.querySelector('#delegated tr[data-kind="sub"]');
  const statusSel = subRow.querySelector('select[data-field="status"]');
  statusSel.value = 'Done';
  statusSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(30);
  const upd = calls.filter(c => c.action === 'update').pop();
  check('status change sends update {kind:sub,id:1,index:0,fields:{status:Done}}', !!upd && upd.payload.kind === 'sub' && upd.payload.id === 1 && upd.payload.index === 0 && upd.payload.fields.status === 'Done');
  check('a save reloads the slice afterwards', calls.filter(c => c.action === 'load').length >= 2);
  check('sync label reports Saved', /Saved|Up to date/.test(doc.getElementById('sync').textContent));

  // add form -> add with title/priority/due/notes
  doc.getElementById('addTitle').value = 'Order flyer proofs';
  doc.getElementById('addPriority').value = 'High';
  doc.getElementById('addDue').value = '2026-09-30';
  doc.getElementById('addNotes').value = 'ask printer';
  doc.getElementById('addForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(30);
  const add = calls.filter(c => c.action === 'add').pop();
  check('add form sends the four fields', !!add && add.payload.title === 'Order flyer proofs' && add.payload.priority === 'High' && add.payload.due === '2026-09-30' && add.payload.notes === 'ask printer');
  check('add form clears its title after success', doc.getElementById('addTitle').value === '');

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 400);
