// person.html in the owner's preview (2026-09-24): Durand can comment on a delegate's page; the
// delegate cannot (test_person.js checks the controls stay hidden on her own page).
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let html = fs.readFileSync(path.join(__dirname, '..', 'person.html'), 'utf8');
html = html.split('__TSG_PERSON__').join('Marj').split('__TSG_AS__').join('Marj').split('__TSG_CODE_VERSION__').join('2026-09-24.3');

const slice = {
  ok: true, person: 'Marj', docVersion: 100, codeVersion: '2026-09-24.3',
  statuses: ['Not Started', 'In Progress', 'Blocked', 'Waiting', 'Done - Pending'], pendingStatus: 'Done - Pending', priorities: ['Critical', 'High', 'Medium', 'Low'],
  feedbackTaskId: null, feedbackKinds: ['Bug', 'Feature request', 'Feedback'],
  fubKey: { present: false }, fubSync: { enabled: false },
  canComment: true,
  comments: [{ id: 'c1', ts: '2026-09-24T14:00:00Z', author: 'Durand', text: 'Earlier note', anchor: { kind: 'task', id: 2, label: "Marj's page: #2 Assigned to Marj", view: 'person:Marj' }, resolved: false,
    replies: [{ author: 'Claude', ts: '2026-09-24T15:00:00Z', text: 'Done, spacing widened' }] }],
  rows: [
    { kind: 'task', id: 2, own: false, title: 'Assigned to Marj', status: 'Not Started', priority: 'Medium', progress: 0, due: '2026-09-25', notes: 'from Durand', owner: 'Durand', tags: [], taskType: 'Hands-on', estHours: 1, subTotal: 1, subDone: 0, editable: ['status', 'notes'] },
    { kind: 'sub', id: 2, index: 0, own: false, parentOwn: false, parentTitle: 'Assigned to Marj', title: 'Step one', status: 'Not Started', priority: 'Medium', progress: 0, done: false, due: '', notes: '', owner: 'Durand', subTotal: 0, editable: ['status', 'notes'] }
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
        else if (action === 'comment') reply = { ok: true, comment: { id: 'c2', ts: '2026-09-24T16:00:00Z', author: 'Durand', text: payload.text, anchor: Object.assign({ view: 'person:Marj' }, payload.anchor), resolved: false } };
        else reply = { ok: true, docVersion: 101 };
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
  check('owner preview: every call carries as=Marj', calls.length && calls.every(c => c.payload.as === 'Marj'));
  check('owner preview: Comment and Comments buttons show, with the open count', doc.getElementById('btnCommentMode').hidden === false && doc.getElementById('btnComments').hidden === false && doc.getElementById('commentCount').textContent === '1');
  check('a row with an open comment carries a badge', !!doc.querySelector('tr.task-row[data-id="2"] .cmt-badge'));

  doc.getElementById('btnCommentMode').click();
  check('Comment turns comment mode on', doc.body.classList.contains('comment-mode') && doc.getElementById('btnCommentMode').classList.contains('on'));
  doc.querySelector('tr.task-row[data-id="2"] td.title-cell').dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }));
  await wait(10);
  check('in comment mode a row click opens the comment box, not the card', !!doc.getElementById('commentPop') && doc.getElementById('cardBack').hidden === true && /Assigned to Marj/.test(doc.getElementById('commentPop').textContent));
  doc.getElementById('commentText').value = 'Make the due date bigger';
  doc.getElementById('commentSave').click();
  await wait(30);
  const sent = calls.filter(c => c.action === 'comment').pop();
  check('Save sends the comment anchored to the task', !!sent && sent.payload.text === 'Make the due date bigger' && sent.payload.anchor.kind === 'task' && sent.payload.anchor.id === 2 && sent.payload.as === 'Marj');
  check('the box closes and the count goes up', !doc.getElementById('commentPop') && doc.getElementById('commentCount').textContent === '2');

  doc.querySelector('.sub-item[data-kind="sub"] .sub-title').dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 60, clientY: 60 }));
  await wait(10);
  check('a step click anchors to the step', !!doc.getElementById('commentPop') && /Step one/.test(doc.getElementById('commentPop').textContent));
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the box first, comment mode stays on', !doc.getElementById('commentPop') && doc.body.classList.contains('comment-mode'));
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('a second Escape ends comment mode', !doc.body.classList.contains('comment-mode'));

  doc.querySelector('tr.task-row[data-id="2"] td.title-cell').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(10);
  check('out of comment mode a row click opens the card again', doc.getElementById('cardBack').hidden === false);
  doc.getElementById('cardClose').click();

  doc.getElementById('btnComments').click();
  const list = doc.getElementById('commentsList').textContent;
  check('Comments lists the page comments with Claude\'s reply', doc.getElementById('commentsBack').hidden === false && /Earlier note/.test(list) && /Done, spacing widened/.test(list) && /Make the due date bigger/.test(list));

  console.log('\n=== ERRORS ===');
  if (!errors.length) console.log('(none)');
  errors.forEach((e, i) => console.log('#' + i, e.msg, '\n', e.stack));
  process.exit((errors.length || FAILS) ? 1 : 0);
}, 400);
