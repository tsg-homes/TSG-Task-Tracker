#!/usr/bin/env node
/**
 * Render the printable table display.
 *
 *   node tools/build-display.js <path-to-qr.png> [outdir]
 *
 * Produces a 5x7in PNG at 300dpi and a print-ready PDF. 5x7 fits a standard
 * acrylic table stand.
 *
 * The QR is a PATH ARGUMENT and the rendered output is NOT written into this
 * repo: the code encodes the exec URL, the repo is public, and `npm test` fails
 * on any tracked file carrying a deployment id. Generate the QR first with
 * tools/make-qr.py, then pass it in.
 *
 * Brand assets are inlined from assets/ so the render needs no network for
 * images. Only the webfonts are fetched.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const W = 1500, H = 2100;                 // 5in x 7in at 300dpi

async function main() {
  const [qrPath, outdirArg] = process.argv.slice(2);
  if (!qrPath) {
    console.error('usage: node tools/build-display.js <path-to-qr.png> [outdir]');
    process.exit(1);
  }
  if (!fs.existsSync(qrPath)) {
    console.error('QR not found: ' + qrPath);
    process.exit(1);
  }

  const dir = path.join(__dirname, '..');
  const b64 = f => fs.readFileSync(path.join(dir, 'assets', f), 'utf8').trim();
  const png = b => 'data:image/png;base64,' + b;

  // Scoped so the mark's generic .st0 class cannot collide with page styles,
  // and its own width/height cannot beat the CSS.
  const tm = fs.readFileSync(path.join(dir, 'assets/ticketmaster.svg'), 'utf8').trim()
    .replace(/\s(?:width|height)="[^"]*"/g, '')
    .replace(/\bst0\b/g, 'tm-fill')
    .replace('<svg ', '<svg role="img" aria-label="Ticketmaster" ');

  // The header sits on dark green, so the mark there is inverted to white;
  // the footer sits on white and uses the dark version.
  const tsgDark = png(b64('tsg.b64'));
  const white = Buffer.from(
    (await invertToWhite(path.join(dir, 'assets/tsg.png')))).toString('base64');

  let html = fs.readFileSync(path.join(dir, 'display/table-display.template.html'), 'utf8')
    .replace('{{TSG_LOGO_WHITE}}', png(white))
    .replace('{{TSG_LOGO_DARK}}', tsgDark)
    .replace('{{KW_LOGO}}', png(b64('kw.b64')))
    .replace('{{EAGLES}}', png(b64('eagles.b64')))
    .replace('{{TICKETMASTER}}', tm)
    .replace('{{QR}}', png(fs.readFileSync(qrPath).toString('base64')));

  for (const token of html.match(/\{\{[A-Z_]+\}\}/g) || []) {
    console.error('ERROR: placeholder not substituted: ' + token);
    process.exit(1);
  }

  const outdir = outdirArg || '.';
  fs.mkdirSync(outdir, { recursive: true });
  const tmp = path.join(outdir, '_display.html');
  fs.writeFileSync(tmp, html);

  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto('file://' + path.resolve(tmp));
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);

  const pngOut = path.join(outdir, 'tsg-block-party-table-display.png');
  const pdfOut = path.join(outdir, 'tsg-block-party-table-display.pdf');
  await page.screenshot({ path: pngOut });
  await page.pdf({ path: pdfOut, width: '5in', height: '7in', printBackground: true,
                   margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
  fs.unlinkSync(tmp);

  console.log('Wrote ' + pngOut + '  (' + W + 'x' + H + ', 5x7in @ 300dpi)');
  console.log('Wrote ' + pdfOut);
}

// The TSG wordmark ships as dark green on transparent; the header band is dark,
// so recolour it to white while keeping its alpha.
async function invertToWhite(srcPath) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  const src = 'data:image/png;base64,' + fs.readFileSync(srcPath).toString('base64');
  const dataUrl = await page.evaluate(async (s) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = s; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255;   // keep alpha
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL('image/png');
  }, src);
  await browser.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

main();
