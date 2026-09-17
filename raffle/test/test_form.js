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
    announceAt: '6:30 PM'
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

  await b.close();
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' FAILED' : '\nAll form tests passed.');
  process.exit(fails ? 1 : 0);
})();
