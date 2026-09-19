/**
 * Browser tests for the built RaffleForm.html, driven with Playwright against
 * real Chromium. These cover the things that are invisible to the server-side
 * unit tests and that all happen on one specific Saturday: the countdown, the
 * 3:00 open, the 6:15 close, and exactly what gets POSTed.
 *
 *   node test/test_form.js
 *
 * Needs `npm install playwright` in the repo root. Set CHROME= to override the
 * browser path.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'raffle-form-'));

// Stand in for Apps Script's templating. Values mirror what raffleServeForm_
// actually passes, so a drift in the names shows up here as a failure.
function page(opts) {
  const raw = fs.readFileSync(path.join(__dirname, '../RaffleForm.html'), 'utf8');
  const vals = Object.assign({
    submitToken: 'tok',
    baseUrl: 'https://example.invalid/exec',
    kiosk: '',
    qaTestToken: '',
    isTest: '',
    // Derived server-side from RAFFLE_OPEN_AT; mirrored here so a rename of the
    // template var shows up as a test failure rather than a blank page.
    eventDate: 'Saturday, September 19, 2026',
    eventDateShort: 'Saturday, September 19',
    openTime: '3:00 PM',
    openAtMs: String(opts.openAt),
    closeAtMs: String(opts.closeAt),
    serverNowMs: String(opts.now),
    // The Buyer/Seller timeframe dropdown, fed live from FUB via
    // getFubTimeframes() in Code.gs. These are this account's real labels.
    timeframeList: JSON.stringify(opts.timeframes || [
      { id: 1, name: '0-3 Months' }, { id: 2, name: '3-6 Months' },
      { id: 3, name: '7-12 Months' }, { id: 4, name: '12+ Months' }
    ]),
    defaultTimeframe: opts.defaultTimeframe === undefined ? '7-12 Months' : opts.defaultTimeframe,
    prizeShort: '$300 toward any Ticketmaster purchase',
    announceAt: '6:30 PM',
    // JSON-encoded server-side, like the console's values.
    chainVid: JSON.stringify(opts.chainVid || ''),
    chainFirst: JSON.stringify(opts.chainFirst || ''),
    // The kiosk's scan code, stamped from RaffleQr.html at serve time (2026-09-19).
    // A short data: URI stands in for the real 43 KB one.
    kioskQr: opts.kioskQr === undefined
      ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
      : opts.kioskQr,
    // The button-in-the-email landing (2026-09-18).
    confirmToken: JSON.stringify(opts.confirmToken || ''),
    confirmEmail: JSON.stringify(opts.confirmEmail || ''),
    confirmFirst: JSON.stringify(opts.confirmFirst || ''),
    confirmExpired: JSON.stringify(opts.confirmExpired ? '1' : '')
  }, opts.vals || {});
  // Model Apps Script's templating faithfully, including its escaping, because
  // getting that wrong is exactly how the countdown broke live: <?= ?> ESCAPES
  // its output and <?!= ?> does not. JSON bound for a <script> block must use
  // <?!= ?>, or the quotes arrive as &quot; and Number() yields NaN. The old
  // harness substituted both shapes raw and so could never have caught it.
  const htmlEscape = v => String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const need = name => {
    if (!(name in vals)) throw new Error('template asks for unknown var: ' + name);
    return vals[name];
  };
  let out = raw
    .replace(/<\?!=\s*safeJsonForScript_\((\w+)\)\s*\?>/g, (m, n) => JSON.stringify(need(n)))
    .replace(/<\?=\s*safeJsonForScript_\((\w+)\)\s*\?>/g, (m, n) => htmlEscape(JSON.stringify(need(n))))
    .replace(/<\?!=\s*(\w+)\s*\?>/g, (m, n) => String(need(n)))
    .replace(/<\?=\s*(\w+)\s*\?>/g, (m, n) => htmlEscape(need(n)));
  if (/<\?/.test(out)) throw new Error('unsubstituted template tag remains');
  const f = path.join(OUT, 'p' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(f, out);
  return 'file://' + f;
}

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };

const OPEN  = new Date('2026-09-19T15:00:00-04:00').getTime();
const CLOSE = new Date('2026-09-19T18:15:00-04:00').getTime();

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });

  // ---- 1. Before the party: countdown, no form ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN - (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000 }));
  await p.waitForTimeout(300);
  check('before: form is hidden', await p.locator('#formWrap').evaluate(e => e.classList.contains('hidden')));
  check('before: countdown panel shown', await p.locator('#beforePanel').isVisible());
  check('before: heading reads "Goes live in"',
    (await p.locator('#beforePanel h2').textContent()).trim() === 'Goes live in');
  check('before: days correct',  (await p.locator('#cD').textContent()) === '2');
  check('before: hours correct', (await p.locator('#cH').textContent()) === '3');
  check('before: mins correct',  (await p.locator('#cM').textContent()) === '4');
  const s0 = Number(await p.locator('#cS').textContent());
  check('before: secs in range', s0 >= 0 && s0 <= 5);

  // It has to actually tick, not just render once.
  await p.waitForTimeout(2200);
  const s1 = Number(await p.locator('#cS').textContent());
  check('before: countdown is ticking down', s1 < s0 || (s0 <= 1 && s1 > 50));

  // ---- 2. Under a minute out: days/hours/mins all zero ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN - 45000 }));
  await p.waitForTimeout(250);
  check('t-45s: days zero',  (await p.locator('#cD').textContent()) === '0');
  check('t-45s: hours zero', (await p.locator('#cH').textContent()) === '0');
  check('t-45s: mins zero',  (await p.locator('#cM').textContent()) === '0');
  check('t-45s: secs ~45', Math.abs(Number(await p.locator('#cS').textContent()) - 45) <= 2);

  // ---- 3. The 3:00 open: countdown -> live form, no reload ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN - 2000 }));
  await p.waitForTimeout(300);
  check('open-flip: countdown showing just before 3:00', await p.locator('#beforePanel').isVisible());
  check('open-flip: form not yet shown', !(await p.locator('#raffleForm').isVisible()));
  await p.waitForTimeout(2600);
  check('open-flip: form went live at 3:00 with no reload', await p.locator('#raffleForm').isVisible());
  check('open-flip: countdown gone', !(await p.locator('#beforePanel').isVisible()));

  // ---- 4. The 6:15 close ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: CLOSE - 2000 }));
  await p.waitForTimeout(300);
  check('close-flip: form live just before 6:15', await p.locator('#raffleForm').isVisible());
  await p.waitForTimeout(2600);
  check('close-flip: page went dead at 6:15 with no reload', await p.locator('#closedPanel').isVisible());
  check('close-flip: form hidden', await p.locator('#formWrap').evaluate(e => e.classList.contains('hidden')));

  // ---- 5. Already closed on load ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: CLOSE + 60000 }));
  await p.waitForTimeout(300);
  check('after: closed panel on load', await p.locator('#closedPanel').isVisible());
  check('after: announcement time shown',
    /6:30 PM/.test(await p.locator('#closedPanel').textContent()));

  // ---- 6. Validation ----
  const live = page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 });
  await p.goto(live);
  await p.waitForTimeout(250);
  await p.click('#submitBtn');
  check('validation: name required',    (await p.locator('#nameErr').textContent()).length > 0);
  check('validation: phone required',   (await p.locator('#phoneErr').textContent()).length > 0);
  check('validation: email required',   (await p.locator('#emailErr').textContent()).length > 0);
  check('validation: consent required', (await p.locator('#consentErr').textContent()).length > 0);

  await p.fill('#fullName', 'Cher');
  await p.click('#submitBtn');
  check('validation: single-word name rejected',
    /first and last/.test(await p.locator('#nameErr').textContent()));

  await p.fill('#phone', '');
  await p.type('#phone', '2155558123');
  check('phone: live-formats to (215) 555-8123', (await p.inputValue('#phone')) === '(215) 555-8123');

  // ---- 7. Consent gates the POST ----
  let posted = false, body = null;
  await p.route('**/exec', r => { posted = true; body = JSON.parse(r.request().postData()); r.fulfill({ status: 200, body: '{"ok":true}' }); });
  await p.fill('#fullName', '  Dana   Reid  ');
  await p.fill('#email', '  Dana@Mail-Test.CO ');
  await p.click('#submitBtn');
  await p.waitForTimeout(400);
  check('consent: unchecked blocks the POST entirely', posted === false);

  await p.check('#consent');
  await p.click('#submitBtn');
  await p.waitForTimeout(600);
  check('submit: POST fired once consent given', posted === true);
  check('submit: success panel shown', await p.locator('#successPanel').isVisible());

  // ---- 8. Payload shape ----
  check('payload: routes to the raffle branch', body && body.formType === 'raffle');
  check('payload: name whitespace collapsed',   body && body.fullName === 'Dana Reid');
  check('payload: email lowercased/trimmed',    body && body.email === 'dana@mail-test.co');
  check('payload: consent sent as literal "Yes"', body && body.consent === 'Yes');
  check('payload: carries the form token',      body && body.formToken === 'tok');
  check('payload: honeypot present and empty',  body && body.website === '');

  // ---- 9. A shown confirmation is not yanked away by the ticker ----
  await p.waitForTimeout(2500);
  check('success: confirmation still on screen 2s later',
    await p.locator('#successPanel').isVisible());

  // ---- 10. Branding actually made it into the built page ----
  const imgs = await p.locator('footer .logos img').count();
  check('branding: two footer logos present', imgs === 2);
  check('branding: footer logos actually loaded', await p.locator('footer .logos img').evaluateAll(
    els => els.every(e => e.complete && e.naturalWidth > 0)));
  check('branding: Eagles mark loaded', await p.locator('.prize img.eagles').evaluate(
    e => e.complete && e.naturalWidth > 0));
  check('branding: Ticketmaster mark inlined as vector',
    (await p.locator('.prize .tm svg').count()) === 1);
  const footer = await p.locator('footer').textContent();
  check('branding: TSG phone number correct', footer.includes('(215) 760-6291'));
  check('branding: old number is gone', !footer.includes('610-828-7000'));
  check('branding: TSG address present', footer.includes('728 S Broad St'));
  check('branding: info@ email present', footer.includes('info@tsg.homes'));
  check('branding: no licence number printed', !/RB-?0?68858/i.test(footer));
  check('branding: KW independence line present',
    /independently owned and operated/i.test(footer));

  // ---- 11. The page never says "raffle" in print (PA licensing) ----
  const visible = await p.evaluate(() => document.body.innerText);
  check('wording: the word "raffle" never appears on the page', !/raffle/i.test(visible));
  check('wording: leads with NO PURCHASE NECESSARY',
    /NO PURCHASE OR PAYMENT/i.test(await p.locator('details .rules').textContent()));
  check('wording: non-affiliation disclaimer visible without opening the rules',
    /not sponsored, endorsed by, or associated with/i.test(
      await p.locator('.disclaimer').textContent()));

  // ---- 12. Test mode vs live ----
  // Live page, well before the party: countdown, no banner.
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN - 86400000 }));
  await p.waitForTimeout(300);
  check('live: no test banner', !(await p.locator('#qaTestBanner').isVisible()));
  check('live: countdown shown before the party', await p.locator('#beforePanel').isVisible());

  // Same moment, but in test mode: banner up and the form is usable.
  await p.goto(page({
    openAt: OPEN, closeAt: CLOSE, now: OPEN - 86400000,
    vals: { qaTestToken: 'b1f0c2d3-4e5f-6a7b-8c9d-0e1f2a3b4c5d', isTest: '1' }
  }));
  await p.waitForTimeout(300);
  check('test: banner is visible', await p.locator('#qaTestBanner').isVisible());
  check('test: banner warns it cannot win the real prize',
    /never win the real prize/i.test(await p.locator('#qaTestBanner').textContent()));
  check('test: form is usable a day BEFORE the party', await p.locator('#raffleForm').isVisible());
  check('test: countdown is not shown', !(await p.locator('#beforePanel').isVisible()));

  // Test mode after the close is still usable — a rehearsal is not time-boxed.
  await p.goto(page({
    openAt: OPEN, closeAt: CLOSE, now: CLOSE + 86400000,
    vals: { qaTestToken: 'b1f0c2d3-4e5f-6a7b-8c9d-0e1f2a3b4c5d', isTest: '1' }
  }));
  await p.waitForTimeout(300);
  check('test: form usable AFTER the 6:15 close too', await p.locator('#raffleForm').isVisible());
  check('test: closed panel not shown', !(await p.locator('#closedPanel').isVisible()));

  // The token must reach the server, or doPost treats it as production.
  let tbody = null;
  await p.route('**/exec', r => { tbody = JSON.parse(r.request().postData()); r.fulfill({ status: 200, body: '{"ok":true}' }); });
  await p.fill('#fullName', 'Rehearsal Tester');
  await p.fill('#phone', '2155558123');
  await p.fill('#email', 'rehearsal@mail-test.co');
  await p.check('#consent');
  await p.click('#submitBtn');
  await p.waitForTimeout(600);
  check('test: payload carries the qaTestToken',
    tbody && tbody.qaTestToken === 'b1f0c2d3-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
  check('test: consent still required and sent', tbody && tbody.consent === 'Yes');

  // A live page must never send a token value.
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 }));
  await p.waitForTimeout(250);
  let lbody = null;
  await p.route('**/exec', r => { lbody = JSON.parse(r.request().postData()); r.fulfill({ status: 200, body: '{"ok":true}' }); });
  await p.fill('#fullName', 'Real Person');
  await p.fill('#phone', '2155558188');
  await p.fill('#email', 'real@mail-test.co');
  await p.check('#consent');
  await p.click('#submitBtn');
  await p.waitForTimeout(600);
  check('live: qaTestToken sent empty', lbody && lbody.qaTestToken === '');

  // ---- 13. Two-step verification ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 }));
  await p.waitForTimeout(250);

  let step1 = null, step2 = null;
  await p.route('**/exec', r => {
    const b = JSON.parse(r.request().postData());
    if (b.step === 'request') { step1 = b; return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) }); }
    step2 = b;
    // Faithful to what raffleVerifyCode_ actually returns: a session id and the
    // entrant's first name, NOT an entry. A fake that returned a bare {ok:true}
    // would let the page's referral step regress unnoticed.
    if (b.code === '654321') return r.fulfill({ status: 200, body: JSON.stringify({
      ok: true, verified: true, vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      firstName: 'Dana', message: 'Thanks Dana — now tell us who you are referring.' }) });
    return r.fulfill({ status: 200, body: JSON.stringify({ ok: false, error: 'That code is not right. Check your email and try again.' }) });
  });

  await p.fill('#fullName', 'Dana Reid');
  await p.fill('#phone', '2155558123');
  await p.fill('#email', 'dana@mail-test.co');
  await p.check('#consent');
  await p.click('#submitBtn');
  await p.waitForTimeout(600);

  check('verify: step 1 is a "request"', step1 && step1.step === 'request');
  check('verify: code panel shown after step 1', await p.locator('#codePanel').isVisible());
  check('verify: entry form hidden during code step',
    await p.locator('#formWrap').evaluate(e => e.classList.contains('hidden')));
  check('verify: success NOT shown before the code is confirmed',
    !(await p.locator('#successPanel').isVisible()));
  check('verify: the email address is echoed back',
    (await p.locator('#codeAddr').textContent()).trim() === 'dana@mail-test.co');

  // Wrong code must not enter them.
  await p.fill('#codeInput', '111111');
  await p.click('#codeBtn');
  await p.waitForTimeout(500);
  check('verify: wrong code shows an error', (await p.locator('#codeErr').textContent()).length > 0);
  check('verify: wrong code does NOT enter them', !(await p.locator('#successPanel').isVisible()));
  check('verify: still on the code panel', await p.locator('#codePanel').isVisible());

  // Non-digits are stripped and it caps at 6.
  await p.fill('#codeInput', '');
  await p.type('#codeInput', '6a5b4c3d2e1f0');
  check('verify: code input strips non-digits and caps at 6',
    (await p.inputValue('#codeInput')) === '654321');

  await p.click('#codeBtn');
  await p.waitForTimeout(600);
  check('verify: step 2 carries the server-issued vid',
    step2 && step2.vid === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  check('verify: step 2 is a "verify"', step2 && step2.step === 'verify');
  // Verifying no longer enters anyone: it opens the referral step, because under
  // the referral rules an entry does not exist until a referred person consents.
  check('verify: correct code opens the referral step',
    await p.locator('#referPanel').isVisible());
  check('verify: it does NOT claim they are entered',
    !(await p.locator('#successPanel').isVisible()));
  check('verify: the referral step greets them by first name',
    (await p.locator('#entrantFirst').textContent()).trim().length > 0);

  // The Buyer/Seller radios and the live FUB timeframe dropdown.
  check('referral step offers a Buy option',
    await p.locator('input[name="refRole"][value="Buyer"]').count() === 1);
  check('referral step offers a Sell option',
    await p.locator('input[name="refRole"][value="Seller"]').count() === 1);
  check('neither role is preselected',
    await p.locator('input[name="refRole"]:checked').count() === 0);
  const tfOptions = await p.locator('#refTimeframe option').allTextContents();
  check('timeframe dropdown is populated from the live FUB list',
    tfOptions.indexOf('0-3 Months') !== -1 && tfOptions.indexOf('12+ Months') !== -1,
    tfOptions.join(','));
  check('timeframe defaults to the 1-year bucket',
    (await p.locator('#refTimeframe').inputValue()) === '7-12 Months',
    await p.locator('#refTimeframe').inputValue());

  // "Wrong email? Start over" returns to a clean form.
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 }));
  await p.waitForTimeout(250);
  await p.route('**/exec', r => r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) }));
  await p.fill('#fullName', 'Dana Reid');
  await p.fill('#phone', '2155558123');
  await p.fill('#email', 'dana@mail-test.co');
  await p.check('#consent');
  await p.click('#submitBtn');
  await p.waitForTimeout(600);
  await p.click('#startOverBtn');
  await p.waitForTimeout(400);
  check('verify: start over returns to the form', await p.locator('#raffleForm').isVisible());
  check('verify: start over leaves the code panel', !(await p.locator('#codePanel').isVisible()));

  // ---- 14. The event date is on the page, in every state ----
  const dateOn = async (label, when) => {
    await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: when }));
    await p.waitForTimeout(350);
    const hdr = await p.locator('header').textContent();
    check('date in header — ' + label, /Saturday, September 19, 2026/.test(hdr));
  };
  await dateOn('before the party', OPEN - 86400000);
  await dateOn('during the party', OPEN + 3600000);
  await dateOn('after entries close', CLOSE + 3600000);

  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 }));
  await p.waitForTimeout(300);
  check('header shows the venue and hours',
    /1342 N Hancock St/.test(await p.locator('header').textContent()));
  check('prize card carries the date',
    /Saturday, September 19/.test(await p.locator('.prize .when').textContent()));
  check('prize card still shows both draw times',
    /6:15 PM/.test(await p.locator('.prize .when').textContent()) &&
    /6:30 PM/.test(await p.locator('.prize .when').textContent()));

  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN - 86400000 }));
  await p.waitForTimeout(300);
  check('countdown panel names the opening time and date',
    /3:00 PM, Saturday, September 19/.test(await p.locator('#beforePanel').textContent()));

  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: CLOSE + 3600000 }));
  await p.waitForTimeout(300);
  check('closed panel names the date',
    /Saturday, September 19/.test(await p.locator('#closedPanel').textContent()));

  // ---- 15. No escaping template tag may sit inside a <script> block ----
  // This is the bug that shipped: <?= ?> escapes, so JSON arrived as &quot;...&quot;
  // and every Number() was NaN, which made phase() fall through to 'open' and
  // showed the entry form regardless of the date.
  {
    const src = fs.readFileSync(path.join(__dirname, '../RaffleForm.html'), 'utf8');
    const scripts = src.match(/<script[\s\S]*?<\/script>/g) || [];
    const offenders = [];
    scripts.forEach(block => {
      (block.match(/<\?=[^>]*\?>/g) || []).forEach(t => offenders.push(t.trim()));
    });
    check('no escaping <?= ?> tag inside a <script> block (must be <?!= ?>)',
      offenders.length === 0);
    if (offenders.length) console.log('      offenders:', offenders.join(', '));
    check('the script block does use force-print tags', /<\?!=/.test(scripts.join('')));
  }

  // ---- 16. The 9/18 fixes (Durand's 9/17 rehearsal) ----
  const LIVE = () => page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 });
  const VID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const fillEntry = async () => {
    await p.fill('#fullName', 'Dana Reid');
    await p.fill('#phone', '2155558123');
    await p.fill('#email', 'dana@mail-test.co');
    await p.check('#consent');
  };
  // Drives the page to the referral step with a stub server.
  const toReferStep = async () => {
    await p.route('**/exec', r => {
      const b = JSON.parse(r.request().postData());
      if (b.step === 'request') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
      if (b.step === 'verify')  return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, verified: true, vid: VID, firstName: 'Dana' }) });
      return r.fulfill({ status: 200, body: '{"ok":true}' });
    });
    await fillEntry();
    await p.click('#submitBtn');
    await p.waitForTimeout(400);
    await p.fill('#codeInput', '654321');
    await p.click('#codeBtn');
    await p.waitForTimeout(400);
  };

  // (3) The referral phone formats itself as they type, like the entrant's.
  await p.goto(LIVE()); await p.waitForTimeout(250);
  await p.type('#phone', '+1 (610) 380 8225');
  check('fix 3: the entrant phone handles a pasted +1 number', (await p.inputValue('#phone')) === '(610) 380-8225');
  await toReferStep();
  check('fix 3: referral step reached (setup)', await p.locator('#referPanel').isVisible());
  await p.type('#refPhone', '6103808225');
  check('fix 3: referral phone masks to (610) 380-8225 as typed', (await p.inputValue('#refPhone')) === '(610) 380-8225');
  await p.fill('#refPhone', '');
  await p.type('#refPhone', '16103808225');
  check('fix 3: a leading 1 is dropped so the mask still lands', (await p.inputValue('#refPhone')) === '(610) 380-8225');

  // (4) The timeframe select matches the other fields.
  const sel = await p.locator('#refTimeframe').evaluate(e => {
    const c = getComputedStyle(e); return { fs: c.fontSize, h: e.getBoundingClientRect().height,
      w: e.getBoundingClientRect().width, app: c.appearance || c.webkitAppearance }; });
  const nameBox = await p.locator('#refName').evaluate(e => e.getBoundingClientRect().width);
  check('fix 4: select is 16px (no iOS zoom)', sel.fs === '16px', JSON.stringify(sel));
  check('fix 4: select is at least 48px tall for a thumb', sel.h >= 48, JSON.stringify(sel));
  check('fix 4: select is as wide as the name field', Math.abs(sel.w - nameBox) < 2, sel.w + ' vs ' + nameBox);
  check('fix 4: native chrome is replaced', sel.app === 'none', JSON.stringify(sel));
  const labelSizes = await p.locator('#referPanel .field > label').evaluateAll(els => els.map(e => getComputedStyle(e).fontSize));
  check('fix 4: every referral label is the same size', labelSizes.every(s => s === labelSizes[0]), labelSizes.join(','));

  // (5) One obvious action at the bottom: Continue; "No thanks" a link; no Start over on the shared link.
  const done = await p.locator('#doneBtn').evaluate(e => { const c = getComputedStyle(e);
    return { bg: c.backgroundColor, deco: c.textDecorationLine, w: e.getBoundingClientRect().width,
             panel: e.closest('.panel').getBoundingClientRect().width }; });
  check('fix 5: "No thanks" has no button background', /rgba\(0, 0, 0, 0\)|transparent/.test(done.bg), done.bg);
  check('fix 5: "No thanks" is underlined like a link', /underline/.test(done.deco), done.deco);
  check('fix 5: "No thanks" is not full-width', done.w < done.panel * 0.7, done.w + ' of ' + done.panel);
  check('fix 5: Start over is NOT on the shared link', !(await p.locator('#startOverBtn2').isVisible()));
  check('fix 5: Continue is the one full-width button on the step',
    (await p.locator('#referPanel button:visible').evaluateAll(els =>
      els.filter(e => e.getBoundingClientRect().width > 300).length)) === 1);

  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, vals: { kiosk: '1' } }));
  await p.waitForTimeout(250);
  await toReferStep();
  check('fix 5: kiosk=1 shows Start over on the referral step', await p.locator('#startOverBtn2').isVisible());
  await p.click('#startOverBtn2');
  await p.waitForTimeout(300);
  check('fix 5: kiosk Start over returns to a clean form', await p.locator('#raffleForm').isVisible() &&
    (await p.inputValue('#fullName')) === '');

  // (6) Space under $300.
  await p.goto(LIVE()); await p.waitForTimeout(250);
  const gap = await p.evaluate(() => {
    const a = document.querySelector('.prize .amount').getBoundingClientRect();
    const d = document.querySelector('.prize .desc').getBoundingClientRect();
    return d.top - a.bottom; });
  check('fix 6: a visible gap between $300 and the prize line', gap >= 8, 'gap ' + gap);

  // (1) A server-side error page is reported as what it is, with a Retry that re-sends the same payload.
  await p.goto(LIVE()); await p.waitForTimeout(250);
  let posts = [];
  let mode = 'html';
  await p.route('**/exec', r => {
    const b = JSON.parse(r.request().postData());
    posts.push(b);
    if (b.step === 'report') return r.fulfill({ status: 200, body: '{"ok":true,"logged":true}' });
    if (mode === 'html') return r.fulfill({ status: 200, contentType: 'text/html',
      body: '<html><head><title>Google Apps Script</title></head><body><div>Script function not found: doPost</div></body></html>' });
    if (mode === 'abort') return r.abort('failed');
    if (mode === 'serverError') return r.fulfill({ status: 200, body: JSON.stringify({ ok: false, serverError: true, ref: 'E-ABC123',
      error: 'Something went wrong on our side: Service invoked too many times for one day: email.' }) });
    return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
  });
  await fillEntry();
  await p.click('#submitBtn');
  await p.waitForTimeout(500);
  const failText = await p.locator('#submitFail').textContent();
  check('fix 1: an HTML error page shows as a server error, not a signal problem',
    await p.locator('#submitFail').isVisible() && /Our server returned an error/.test(failText), failText);
  check('fix 1: the server\'s own words are on screen', /Script function not found/.test(failText), failText);
  check('fix 1: it never blames the guest\'s phone', !/check your signal/i.test(failText), failText);
  check('fix 1: a Retry button is offered', (await p.locator('#submitFail button').count()) === 1);
  check('loud: a fixed red banner is up at the top of the page', await p.locator('#failBanner').isVisible() &&
    /server returned an error/.test(await p.locator('#failBanner').textContent()));
  check('loud: the banner is fixed-position', (await p.locator('#failBanner').evaluate(e => getComputedStyle(e).position)) === 'fixed');
  check('lockout: the overlay is down again once the server answered', !(await p.locator('#busyOverlay').isVisible()));
  check('fix 1: the fields are untouched', (await p.inputValue('#fullName')) === 'Dana Reid' &&
    (await p.inputValue('#email')) === 'dana@mail-test.co' && (await p.isChecked('#consent')));
  check('fix 1: the button is live again, not stuck disabled',
    !(await p.locator('#submitBtn').isDisabled()) && (await p.locator('#submitBtn').textContent()) === 'Enter the Drawing');
  const rep = posts.find(b => b.step === 'report');
  check('fix 1: the failure is reported to the server', !!rep && rep.failedStep === 'request' && rep.kind === 'server' &&
    /Script function not found/.test(rep.detail), JSON.stringify(rep));
  check('fix 1: the report carries the form token', !!rep && rep.formToken === 'tok');

  mode = 'ok';
  const before = posts.filter(b => b.step === 'request').length;
  await p.click('#submitFail button');
  await p.waitForTimeout(500);
  const reqs = posts.filter(b => b.step === 'request');
  check('fix 1: Retry re-sends the request', reqs.length === before + 1);
  check('fix 1: with the identical payload', JSON.stringify(reqs[reqs.length - 1]) === JSON.stringify(reqs[0]));
  check('fix 1: and the flow continues to the code step', await p.locator('#codePanel').isVisible());
  check('fix 1: the failure block is gone', !(await p.locator('#submitFail').isVisible()));
  check('loud: the banner is gone once the retry succeeded', !(await p.locator('#failBanner').isVisible()));

  // A real network failure: one silent automatic retry first, then the failed
  // state with a manual Retry.
  mode = 'abort';
  const verifiesBefore = posts.filter(b => b.step === 'verify').length;
  await p.fill('#codeInput', '654321');
  await p.click('#codeBtn');
  await p.waitForTimeout(600);
  check('fix 1: after a network failure the page is still locked and says it is trying once more',
    await p.locator('#busyOverlay').isVisible() && /Trying once more/.test(await p.locator('#busyWhat').textContent()));
  await p.waitForTimeout(2200);
  check('fix 1: exactly one automatic retry was sent', posts.filter(b => b.step === 'verify').length === verifiesBefore + 2);
  check('fix 1: the failure report says the browser was online', posts.some(b => b.step === 'report' && b.kind === 'network' && b.online === '1' && b.origin));
  const netText = await p.locator('#codeFail').textContent();
  check('fix 1: a dropped connection is named as one', /could not reach our server/i.test(netText) && /connection/.test(netText) && !/phone/.test(netText), netText);
  check('fix 1: with a Retry', (await p.locator('#codeFail button').count()) === 1);
  check('fix 1: the code typed is still there', (await p.inputValue('#codeInput')) === '654321');
  check('fix 1: a network failure is reported too', posts.some(b => b.step === 'report' && b.failedStep === 'verify' && b.kind === 'network'));

  // A caught server exception (JSON with serverError) shows its message and reference, with a Retry.
  mode = 'serverError';
  await p.click('#codeFail button');
  await p.waitForTimeout(500);
  const seText = await p.locator('#codeFail').textContent();
  check('fix 1: a caught server exception shows the real message', /Service invoked too many times/.test(seText), seText);
  check('fix 1: and its reference', /E-ABC123/.test(seText), seText);
  check('fix 1: with a Retry counting the attempt (the automatic one included)', /Retry \(attempt 4\)/.test(seText), seText);

  // (7) A clear in-progress state while the slow step runs; test mode prints the server timing.
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000,
    vals: { qaTestToken: 'b1f0c2d3-4e5f-6a7b-8c9d-0e1f2a3b4c5d', isTest: '1' } }));
  await p.waitForTimeout(250);
  await p.route('**/exec', async r => {
    const b = JSON.parse(r.request().postData());
    if (b.step === 'request') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
    if (b.step === 'verify') {
      await new Promise(res => setTimeout(res, 1600));
      return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, verified: true, vid: VID, firstName: 'Dana',
        timing: { fub: 2100, sheet: 1400, total: 3700 } }) });
    }
    return r.fulfill({ status: 200, body: '{"ok":true}' });
  });
  await fillEntry();
  await p.click('#submitBtn');
  await p.waitForTimeout(400);
  await p.fill('#codeInput', '654321');
  await p.click('#codeBtn');
  await p.waitForTimeout(1200);
  const busyText = await p.locator('#codeBusy').textContent();
  check('fix 7: the button says Checking…', (await p.locator('#codeBtn').textContent()) === 'Checking…');
  check('fix 7: and the line under it says what is happening and for how long',
    /Checking your code/.test(busyText) && /\d+ s/.test(busyText), busyText);
  check('fix 7: the page is locked behind an overlay', await p.locator('#busyOverlay').isVisible());
  check('fix 7: the overlay names the step and counts seconds',
    /Checking your code/.test(await p.locator('#busyWhat').textContent()) && /^[1-9]\d* s$/.test((await p.locator('#busySecs').textContent()).trim()),
    await p.locator('#busySecs').textContent());
  check('fix 7: the overlay covers the button (a second tap cannot land)',
    await p.evaluate(() => { const b = document.getElementById('codeBtn').getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!top && !!top.closest('#busyOverlay'); }));
  await p.waitForTimeout(1200);
  check('fix 7: the referral step opens when the server answers', await p.locator('#referPanel').isVisible());
  check('fix 7: and the overlay lifts', !(await p.locator('#busyOverlay').isVisible()));
  const timingText = await p.locator('#codeBusy').textContent();
  check('fix 7: test mode shows the server\'s timing breakdown',
    /TEST MODE timing/.test(timingText) && /fub 2\.1 s/.test(timingText) && /sheet 1\.4 s/.test(timingText), timingText);

  // ---- 17. The button in the code email (2026-09-18) ----
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000,
    confirmToken: 'ffffffff-1111-4222-8333-444444444444', confirmEmail: 'dana@mail-test.co', confirmFirst: 'Dana' }));
  await p.waitForTimeout(300);
  check('button: the landing page opens at the confirm step', await p.locator('#confirmPanel').isVisible());
  check('button: the entry form is hidden', await p.locator('#formWrap').evaluate(e => e.classList.contains('hidden')));
  check('button: it names the address', /dana@mail-test\.co/.test(await p.locator('#confirmPanel').textContent()));
  check('button: and the first name', /, Dana/.test(await p.locator('#confirmPanel').textContent()));
  await p.waitForTimeout(1500);
  check('button: the ticker does not yank the confirm step away', await p.locator('#confirmPanel').isVisible());
  let cbody = null;
  await p.route(u => /\/exec/.test(u.href), r => {
    const b = JSON.parse(r.request().postData());
    cbody = b;
    return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, verified: true, vid: VID, firstName: 'Dana' }) });
  });
  await p.click('#confirmBtn');
  await p.waitForTimeout(500);
  check('button: the tap posts confirmlink with the token',
    cbody && cbody.step === 'confirmlink' && cbody.t === 'ffffffff-1111-4222-8333-444444444444' && cbody.formToken === 'tok', JSON.stringify(cbody));
  check('button: and lands on the referral step', await p.locator('#referPanel').isVisible());
  check('button: greeting by first name', (await p.locator('#entrantFirst').textContent()) === 'Dana');
  await p.unroute(u => /\/exec/.test(u.href));

  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, confirmExpired: true }));
  await p.waitForTimeout(300);
  check('button: an expired link shows the form with a notice', await p.locator('#raffleForm').isVisible() &&
    /expired or was already used/.test(await p.locator('#linkExpired').textContent()));

  // The chain link (a confirmed referral entering by referring) must open at the
  // referral step. It did not until 2026-09-18: its variables were declared after use.
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, chainVid: VID, chainFirst: 'Robin' }));
  await p.waitForTimeout(300);
  check('chain: a chain entrant opens at the referral step', await p.locator('#referPanel').isVisible());
  check('chain: greeted by first name', (await p.locator('#entrantFirst').textContent()) === 'Robin');

  // The kiosk notices a tap made on the guest's phone and moves on by itself.
  await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, vals: { kiosk: '1' } }));
  await p.waitForTimeout(300);
  let polls = 0;
  await p.route(u => /\/exec/.test(u.href), r => {
    if (r.request().method() === 'GET') {
      polls++;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, verified: polls >= 2 }) });
    }
    return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
  });
  await fillEntry();
  await p.click('#submitBtn');
  await p.waitForTimeout(500);
  check('kiosk poll: the code step is up (setup)', await p.locator('#codePanel').isVisible());
  await p.waitForTimeout(11000);
  check('kiosk poll: the kiosk asked the server more than once', polls >= 2, 'polls ' + polls);
  check('kiosk poll: and moved to the entered screen once the guest confirmed from the email',
    await p.locator('#successPanel').isVisible() && /confirmed from the email/.test(await p.locator('#successMsg').textContent()));
  await p.unroute(u => /\/exec/.test(u.href));

  // A shared-link phone never polls.
  await p.goto(LIVE()); await p.waitForTimeout(300);
  let gets = 0;
  await p.route(u => /\/exec/.test(u.href), r => {
    if (r.request().method() === 'GET') { gets++; return r.fulfill({ status: 200, body: '{"ok":true,"verified":false}' }); }
    return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
  });
  await fillEntry();
  await p.click('#submitBtn');
  await p.waitForTimeout(6500);
  check('kiosk poll: a phone on the shared link does not poll', gets === 0, 'gets ' + gets);
  await p.unroute(u => /\/exec/.test(u.href));

  // (2) The draw console: a failed send is a failed state with a retry, not a disabled button.
  {
    const raw = fs.readFileSync(path.join(__dirname, '../RaffleConsole.html'), 'utf8');
    const vals = {
      adminKeyJson: JSON.stringify('secret'), submitTokenJson: JSON.stringify('tok'),
      isTestJson: JSON.stringify(''), sentAtJson: JSON.stringify(''), hasDrawJson: JSON.stringify('1'),
      isTest: '', hasDraw: true, noDraw: false, sentAt: '', drawnAt: '2026-09-19 18:15:00',
      totalEligible: '9', totalPeople: '4', totalTickets: '21', drawArmedAt: '', announceAt: '6:30 PM',
      budget: '<div class="bq"></div>',
      cards: '<label class="pick" for="p0"><input type="radio" name="pick" id="p0" value="0" checked><div class="nm">Dana Reid</div></label>' +
             '<label class="pick" for="p1"><input type="radio" name="pick" id="p1" value="1"><div class="nm">Robin Vale</div></label>'
    };
    let out = raw
      .replace(/<\?\s*if\s*\(\s*(\w+)\s*\)\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*\?>/g, (m, k, body) => (vals[k] ? body : ''))
      .replace(/<\?!=\s*(\w+)\s*\?>/g, (m, n) => String(vals[n]))
      .replace(/<\?=\s*(\w+)\s*\?>/g, (m, n) => String(vals[n]));
    if (/<\?/.test(out)) throw new Error('console: unsubstituted tag');
    const f = path.join(OUT, 'console.html');
    fs.writeFileSync(f, out);
    await p.goto('file://' + f + '?form=raffle');
    await p.waitForTimeout(250);
    p.on('dialog', d => d.accept());
    let cposts = [];
    let cmode = 'ok';
    await p.route('**/console.html?form=raffle', r => {
      const b = JSON.parse(r.request().postData());
      cposts.push(b);
      if (b.step === 'report') return r.fulfill({ status: 200, body: '{"ok":true}' });
      if (b.consoleAction === 'preview') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, pick: 0, name: 'Dana Reid', email: 'dana@mail-test.co', html: '<p>hi</p>' }) });
      if (cmode === 'html') return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><title>Sorry</title><body>Sorry, unable to open the file at this time.</body></html>' });
      if (cmode === 'refused') return r.fulfill({ status: 200, body: JSON.stringify({ ok: false, error: 'The email to Dana Reid did not send: Mail service unavailable. Nothing went out. Retry, or call them at (215) 555-8123.' }) });
      return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, message: 'Sent to Dana Reid <dana@mail-test.co> at 18:31 ET.' }) });
    });
    await p.click('#previewBtn');
    await p.waitForTimeout(400);
    check('fix 2: preview arms the send (setup)', !(await p.locator('#sendBtn').isDisabled()));
    cmode = 'html';
    await p.click('#sendBtn');
    await p.waitForTimeout(500);
    check('fix 2: a failed send reads as FAILED on the button', (await p.locator('#sendBtn').textContent()) === 'Send failed — retry');
    check('fix 2: and the button is live, not disabled', !(await p.locator('#sendBtn').isDisabled()));
    const box = await p.locator('#msg .failbox').textContent();
    check('fix 2: the failure block says what the server sent', /error page/.test(box) && /unable to open the file/.test(box), box);
    check('fix 2: with a retry button', (await p.locator('#msg .failbox button').count()) === 1);
    check('fix 2: the console shows the fixed red banner too', await p.locator('#failBanner').isVisible());
    check('fix 2: the console overlay is down after the answer', !(await p.locator('#busyOverlay').isVisible()));
    check('fix 2: the console never promises Ryan an error email', !/Ryan/.test(box));
    check('fix 2: the console reports the failure to the server',
      cposts.some(b => b.step === 'report' && b.failedStep === 'console' && /console send/.test(b.detail)));
    cmode = 'refused';
    await p.click('#msg .failbox button');
    await p.waitForTimeout(500);
    const box2 = await p.locator('#msg .failbox').textContent();
    check('fix 2: a server-refused send shows the server\'s reason', /Mail service unavailable/.test(box2) && /call them at/.test(box2), box2);
    cmode = 'ok';
    await p.click('#msg .failbox button');
    await p.waitForTimeout(500);
    check('fix 2: the retry sends', (await p.locator('#sendBtn').textContent()) === 'Sent' && /Sent to Dana Reid/.test(await p.locator('#msg').textContent()));
    check('fix 2: three send attempts went to the server', cposts.filter(b => b.consoleAction === 'send').length === 3);
  }

  // ---- 18. google.script.run transport and the button-mash lockout (2026-09-18) ----
  // The kiosk reported a Drive 404 for a request the server had completed. When
  // Apps Script serves the page, google.script.run is present and every call
  // goes through raffleRpc() instead of a cross-origin fetch. A shim stands in
  // for it here; fetch must never be touched while it is present.
  {
    let fetches = 0;
    await p.route('**/exec', r => { fetches++; r.fulfill({ status: 200, body: '{"ok":true}' }); });
    await p.addInitScript(() => {
      window.__rpcCalls = [];
      window.__rpcMode = 'ok';
      const run = {
        _ok: null, _fail: null,
        withSuccessHandler(f) { const c = Object.create(run); c._ok = f; c._fail = this._fail; return c; },
        withFailureHandler(f) { const c = Object.create(run); c._fail = f; c._ok = this._ok; return c; },
        raffleRpc(json) {
          const b = JSON.parse(json); window.__rpcCalls.push(b);
          const self = this;
          setTimeout(() => {
            if (window.__rpcMode === 'fail') return self._fail && self._fail(new Error('ScriptError: Not found.'));
            if (window.__rpcMode === 'net')  return self._fail && self._fail(new Error('NetworkError: unable to connect'));
            if (window.__rpcMode === 'html') return self._ok && self._ok('<html><title>Sorry</title><body>unable to open the file</body></html>');
            if (b.step === 'request') return self._ok && self._ok(JSON.stringify({ ok: true, needsCode: true, vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
            if (b.step === 'verify')  return self._ok && self._ok(JSON.stringify({ ok: true, verified: true, vid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', firstName: 'Dana' }));
            if (b.step === 'poll')    return self._ok && self._ok(JSON.stringify({ ok: true, verified: window.__pollVerified === true }));
            return self._ok && self._ok('{"ok":true}');
          }, 80);
        }
      };
      window.google = { script: { run: run } };
    });
    await p.goto(LIVE()); await p.waitForTimeout(250);
    const rpcCalls = () => p.evaluate(() => window.__rpcCalls);
    await fillEntry();
    await p.click('#submitBtn');
    await p.waitForTimeout(500);
    let calls = await rpcCalls();
    check('rpc: the request goes through google.script.run.raffleRpc', calls.length === 1 && calls[0].step === 'request' && calls[0].formType === 'raffle', JSON.stringify(calls));
    check('rpc: and never through fetch', fetches === 0);
    check('rpc: the code step opens on the reply', await p.locator('#codePanel').isVisible());
    // A thrown script error lands in the failed state, named as a server-side failure.
    await p.evaluate(() => { window.__rpcMode = 'fail'; });
    await p.fill('#codeInput', '654321');
    await p.click('#codeBtn');
    await p.waitForTimeout(600);
    const rpcFail = await p.locator('#codeFail').textContent();
    check('rpc: a failed script call shows as our error with its message', /server returned an error/i.test(rpcFail) && /ScriptError/.test(rpcFail), rpcFail);
    calls = await rpcCalls();
    check('rpc: the failure report rides the same transport and says so', calls.some(b => b.step === 'report' && b.failedStep === 'verify' && b.transport === 'rpc'), JSON.stringify(calls.slice(-2)));
    check('rpc: still nothing through fetch', fetches === 0);
    // An HTML answer is impossible over rpc, but a non-JSON string still reads as a server error page.
    await p.evaluate(() => { window.__rpcMode = 'html'; });
    await p.click('#codeFail button');
    await p.waitForTimeout(600);
    check('rpc: a non-JSON reply is described like an error page', /unable to open the file/.test(await p.locator('#codeFail').textContent()));
    await p.evaluate(() => { window.__rpcMode = 'ok'; });
    await p.click('#codeFail button');
    await p.waitForTimeout(600);
    check('rpc: the retry succeeds and moves on', await p.locator('#referPanel').isVisible());

    // Kiosk poll over rpc: a poll call every 5 s, no fetch.
    await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, vals: { kiosk: '1' } }));
    await p.waitForTimeout(250);
    await fillEntry();
    await p.click('#submitBtn');
    await p.waitForTimeout(5600);
    calls = await rpcCalls();
    check('rpc: the kiosk polls through raffleRpc', calls.some(b => b.step === 'poll' && b.vid === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), JSON.stringify(calls));
    check('rpc: the kiosk poll never uses fetch', fetches === 0);
    await p.evaluate(() => { window.__pollVerified = true; });
    await p.waitForTimeout(5300);
    check('rpc: a confirmed poll moves the kiosk on', await p.locator('#successPanel').isVisible());
    await p.unroute('**/exec');
  }

  // Button mashing: one request in flight at a time, a Retry cooldown, and a
  // 30 s lock after three failures in a row on the same step.
  {
    // A fresh context without the rpc shim.
    const p2 = await b.newPage({ viewport: { width: 420, height: 900 } });
    const posts = [];
    let mode = 'slow';
    await p2.route('**/exec', async r => {
      const body = JSON.parse(r.request().postData());
      posts.push(body);
      if (body.step === 'report') return r.fulfill({ status: 200, body: '{"ok":true}' });
      if (mode === 'html') return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><title>Sorry</title><body>unable to open the file</body></html>' });
      await new Promise(res => setTimeout(res, 1200));
      if (body.step === 'request') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
      if (body.step === 'verify')  return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, verified: true, vid: VID, firstName: 'Dana' }) });
      return r.fulfill({ status: 200, body: '{"ok":true}' });
    });
    await p2.goto(LIVE()); await p2.waitForTimeout(250);
    await p2.fill('#fullName', 'Dana Reid'); await p2.fill('#phone', '2155558123');
    await p2.fill('#email', 'dana@mail-test.co'); await p2.check('#consent');
    await p2.click('#submitBtn');
    // Five more taps straight at the button and the form, past the overlay.
    await p2.evaluate(() => { for (let i = 0; i < 5; i++) { document.getElementById('submitBtn').click();
      document.getElementById('raffleForm').requestSubmit(); } });
    await p2.waitForTimeout(1700);
    check('mash: six taps on Enter the Drawing send one request', posts.filter(b => b.step === 'request').length === 1, String(posts.length));
    check('mash: the code step opened once', await p2.locator('#codePanel').isVisible());
    await p2.fill('#codeInput', '654321');
    await p2.press('#codeInput', 'Enter');
    await p2.evaluate(() => { const b = document.getElementById('codeBtn'); for (let i = 0; i < 4; i++) b.click();
      const inp = document.getElementById('codeInput');
      for (let i = 0; i < 3; i++) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await p2.waitForTimeout(1700);
    check('mash: Enter plus seven more taps verify once', posts.filter(b => b.step === 'verify').length === 1, String(posts.filter(b => b.step === 'verify').length));
    check('mash: the referral step opened', await p2.locator('#referPanel').isVisible());

    // The cooldown: after a failure Retry counts down and the main button is dead meanwhile.
    await p2.goto(LIVE()); await p2.waitForTimeout(250);
    posts.length = 0; mode = 'html';
    await p2.fill('#fullName', 'Dana Reid'); await p2.fill('#phone', '2155558123');
    await p2.fill('#email', 'dana@mail-test.co'); await p2.check('#consent');
    await p2.click('#submitBtn');
    await p2.waitForTimeout(500);
    const retry = p2.locator('#submitFail button');
    check('cooldown: Retry is disabled right after a failure', await retry.isDisabled());
    check('cooldown: and counts down', /Retry in [1-3] s/.test(await retry.textContent()), await retry.textContent());
    await p2.evaluate(() => { document.getElementById('submitBtn').click(); document.getElementById('raffleForm').requestSubmit(); });
    await p2.waitForTimeout(300);
    check('cooldown: the main button sends nothing during the cooldown', posts.filter(b => b.step === 'request').length === 1);
    await p2.waitForTimeout(3000);
    check('cooldown: Retry is live after 3 s', !(await retry.isDisabled()) && (await retry.textContent()) === 'Retry', await retry.textContent());
    await retry.click();               // failure 2
    await p2.waitForTimeout(500);
    check('cooldown: the second failure counts the attempt', /Retry \(attempt 3\) in [1-3] s/.test(await p2.locator('#submitFail button').textContent()), await p2.locator('#submitFail button').textContent());
    await p2.locator('#submitFail button').click();   // waits for the cooldown; failure 3
    await p2.waitForTimeout(500);
    const lockText = await p2.locator('#submitFail').textContent();
    check('lock: the third failure in a row stops and says so', /Stopped after 3 tries/.test(lockText), lockText);
    check('lock: sends them to the table and names the 30 s unlock', /Find someone from TSG at the table now/.test(lockText) && /unlocks in 30 seconds/.test(lockText));
    check('lock: Retry is on a 30 s countdown', /Retry \(attempt 4\) in (30|29|28) s/.test(await p2.locator('#submitFail button').textContent()), await p2.locator('#submitFail button').textContent());
    check('lock: exactly three requests went out', posts.filter(b => b.step === 'request').length === 3);
    check('lock: the typed details are still there', (await p2.inputValue('#email')) === 'dana@mail-test.co');
    await p2.close();
  }

  // ---- 19. The monitoring page's Remove from draw / Restore buttons (2026-09-18) ----
  // The page is built server-side (raffleStatusPage_); its one script is a
  // hand-written string, so it is exercised here in a real browser against a
  // google.script.run shim: the click confirms, sends the key-gated console
  // action through raffleRpc, and reloads on ok.
  {
    const H = require('./harness');
    const s = H.makeSandbox({ props: { RAFFLE_ADMIN_KEY: 'secret', RAFFLE_SHEET_ID: 'sheet1', FUB_API_KEY: 'key' } });
    H.enterFull(s, H.entry(), H.DURING);
    const statusHtml = String(H.at(H.DURING, () => s.raffleStatusPage_(false)));
    const f = path.join(OUT, 'status.html');
    fs.writeFileSync(f, statusHtml);
    const p3 = await b.newPage({ viewport: { width: 1200, height: 900 } });
    await p3.addInitScript(() => {
      window.__rpc = [];
      const run = {
        _ok: null, _fail: null,
        withSuccessHandler(fn) { const c = Object.create(run); c._ok = fn; c._fail = this._fail; return c; },
        withFailureHandler(fn) { const c = Object.create(run); c._fail = fn; c._ok = this._ok; return c; },
        raffleRpc(json) { const body = JSON.parse(json); window.__rpc.push(body);
          try { localStorage.setItem('rpc', JSON.stringify(window.__rpc)); } catch (e) {}
          const self = this; setTimeout(() => self._ok && self._ok(JSON.stringify(window.__rpcAnswer || { ok: true })), 50); }
      };
      window.google = { script: { run: run } };
    });
    const dialogs = [];
    p3.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    let loads = 0; p3.on('load', () => loads++);
    await p3.goto('file://' + f); await p3.waitForTimeout(200);
    const buttons = await p3.locator('button[data-act="disqualify"]').count();
    check('monitor: a Remove button per row', buttons === 3);
    const loadsBefore = loads;
    await p3.locator('button[data-act="disqualify"]').first().click();
    await p3.waitForTimeout(600);
    check('monitor: the click asks first, naming the entrant', dialogs.length === 1 && /Remove .+ from the draw\?/.test(dialogs[0]) && !/this row/.test(dialogs[0]), dialogs[0]);
    const sent = JSON.parse(await p3.evaluate(() => localStorage.getItem('rpc') || '[]'));
    check('monitor: the action goes through raffleRpc as the key-gated console action',
      sent.length === 1 && sent[0].step === 'console' && sent[0].consoleAction === 'disqualify' && sent[0].key === 'secret' && sent[0].formToken === 'tok' && sent[0].formType === 'raffle' && /^\d+$/.test(String(sent[0].row)), JSON.stringify(sent));
    check('monitor: an ok answer reloads the page', loads > loadsBefore);
    // A refused answer stays on the page and shows the server's words.
    await p3.evaluate(() => { localStorage.removeItem('rpc'); window.__rpcAnswer = { ok: false, error: 'A winner is already recorded.' }; });
    await p3.reload(); await p3.waitForTimeout(200);
    await p3.evaluate(() => { window.__rpcAnswer = { ok: false, error: 'A winner is already recorded.' }; });
    dialogs.length = 0;
    await p3.locator('button[data-act="disqualify"]').first().click();
    await p3.waitForTimeout(600);
    check('monitor: a refusal is shown in the server\'s words', dialogs.length === 2 && /already recorded/.test(dialogs[1]), JSON.stringify(dialogs));
    check('monitor: and the button is live again', !(await p3.locator('button[data-act="disqualify"]').first().isDisabled()));
    await p3.close();
  }

  // ---- 20. The kiosk's "use your own phone" QR (2026-09-19) ----
  // The same code as the printed table sign, stamped into the page at serve time
  // from RaffleQr.html. The panel is kiosk-only, and it stays hidden unless a
  // real image actually arrived — a bordered box with a broken image in it is
  // worse on the iPad than no panel.
  {
    await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, vals: { kiosk: '1' } }));
    await p.waitForTimeout(300);
    check('kiosk QR: the panel shows on the kiosk', await p.locator('#scanPanel').isVisible());
    check('kiosk QR: it is the stamped image, not something the page drew',
      (await p.locator('#scanQr').getAttribute('src')).startsWith('data:image/png;base64,'));
    // Below about 240 CSS px the printed code stops surviving a blurred camera
    // frame, so the rendered size is part of the contract, not styling.
    const box = await p.locator('#scanQr').boundingBox();
    check('kiosk QR: it renders at least 240px square', box.width >= 240 && box.height >= 240,
      JSON.stringify(box));
    check('kiosk QR: the panel says what scanning does',
      /Rather use your own phone/.test(await p.locator('#scanPanel').textContent()));

    // No code stamped (a deployment without RaffleQr.html): no panel at all.
    await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000,
      kioskQr: '', vals: { kiosk: '1' } }));
    await p.waitForTimeout(300);
    check('kiosk QR: with no code stamped the panel stays hidden',
      !(await p.locator('#scanPanel').isVisible()));

    await p.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000 }));
    await p.waitForTimeout(300);
    check('kiosk QR: nothing shows on the shared link', !(await p.locator('#scanPanel').isVisible()));
  }

  // ---- 21. The kiosk fits an iPad in landscape without scrolling (2026-09-19) ----
  // Per Durand: the iPad sits in landscape on the table and a guest should never
  // have to scroll to reach the fields or the button. Asserted as a measurement,
  // not a screenshot: document height against viewport height at each step, at
  // the sizes the real device reports. Anything added to the page later that
  // pushes a step past the fold fails here rather than at the table.
  {
    const SIZES = [
      ['iPad 10.2 landscape', 1080, 810],
      ['iPad Air 11 landscape', 1194, 834],
      ['iPad mini landscape', 1133, 744],
      ['iPad 10.2 with Safari chrome', 1080, 730]
    ];
    for (const [label, width, height] of SIZES) {
      const kp = await b.newPage({ viewport: { width, height } });
      await kp.route('**/exec', r => {
        const body = JSON.parse(r.request().postData() || '{}');
        if (body.step === 'request') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, needsCode: true, vid: VID }) });
        if (body.step === 'verify') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, verified: true, vid: VID, firstName: 'Dana' }) });
        return r.fulfill({ status: 200, body: '{"ok":true}' });
      });
      await kp.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, vals: { kiosk: '1' } }));
      await kp.waitForTimeout(350);
      const fits = async step => {
        const m = await kp.evaluate(() => ({ doc: document.documentElement.scrollHeight, win: window.innerHeight }));
        check('kiosk landscape: ' + label + ' does not scroll on the ' + step,
          m.doc - m.win <= 1, m.doc + 'px of content in a ' + m.win + 'px viewport');
      };
      await fits('entry form');
      // The two columns are the whole point: the code beside the form, not above it.
      const [qr, form] = await Promise.all([
        kp.locator('#scanPanel').boundingBox(),
        kp.locator('#formWrap').boundingBox()
      ]);
      check('kiosk landscape: ' + label + ' puts the code beside the form, not above it',
        qr.x + qr.width <= form.x + 1, JSON.stringify({ qr, form }));

      await kp.fill('#fullName', 'Dana Reid');
      await kp.fill('#phone', '2155558123');
      await kp.fill('#email', 'dana@mail-test.co');
      await kp.check('#consent');
      await kp.click('#submitBtn');
      await kp.waitForTimeout(450);
      await fits('code step');
      await kp.fill('#codeInput', '654321');
      await kp.click('#codeBtn');
      await kp.waitForTimeout(450);
      await fits('referral step');
      await kp.close();
    }

    // A phone held sideways is NOT an iPad: it keeps the single column, where
    // two columns in 390px of height would be far worse.
    const ph = await b.newPage({ viewport: { width: 844, height: 390 } });
    await ph.goto(page({ openAt: OPEN, closeAt: CLOSE, now: OPEN + 3600000, vals: { kiosk: '1' } }));
    await ph.waitForTimeout(300);
    check('kiosk landscape: a short landscape screen keeps one column',
      await ph.evaluate(() => getComputedStyle(document.querySelector('main')).display !== 'grid'));
    await ph.close();
  }

  await b.close();
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' FAILED' : '\nAll form tests passed.');
  process.exit(fails ? 1 : 0);
})();
