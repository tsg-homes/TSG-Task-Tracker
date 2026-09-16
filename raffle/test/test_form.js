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
    openAtMs: String(opts.openAt),
    closeAtMs: String(opts.closeAt),
    serverNowMs: String(opts.now)
  }, opts.vals || {});
  const out = raw.replace(/<\?=\s*safeJsonForScript_\((\w+)\)\s*\?>/g, (m, name) => {
    if (!(name in vals)) throw new Error('template asks for unknown var: ' + name);
    return JSON.stringify(vals[name]);
  });
  if (/<\?=/.test(out)) throw new Error('unsubstituted template tag remains');
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
  await p.type('#phone', '2155550123');
  check('phone: live-formats to (215) 555-0123', (await p.inputValue('#phone')) === '(215) 555-0123');

  // ---- 7. Consent gates the POST ----
  let posted = false, body = null;
  await p.route('**/exec', r => { posted = true; body = JSON.parse(r.request().postData()); r.fulfill({ status: 200, body: '{"ok":true}' }); });
  await p.fill('#fullName', '  Dana   Reid  ');
  await p.fill('#email', '  Dana@Example.COM ');
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
  check('payload: email lowercased/trimmed',    body && body.email === 'dana@example.com');
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

  await b.close();
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' FAILED' : '\nAll form tests passed.');
  process.exit(fails ? 1 : 0);
})();
