#!/usr/bin/env node
/**
 * Render the printable table display.
 *
 *   node tools/build-display.js <path-to-qr.png> [outdir]
 *
 * Produces a letter (8.5x11in) PNG at 300dpi and a print-ready PDF.
 *
 * The template is authored once in a 1500x2100 coordinate space and scaled here
 * by the HEIGHT ratio, so the vertical rhythm lands exactly and the extra width
 * is absorbed by the full-width bands rather than leaving a letterboxed margin.
 * Scaling at build time keeps one template as the source of truth instead of a
 * second hand-maintained copy that drifts.
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
const { execFileSync } = require('child_process');

const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SRC_W = 1500, SRC_H = 2100;           // the coordinate space the template is authored in
const W = 2550, H = 3300;                   // 8.5in x 11in at 300dpi
const SCALE = H / SRC_H;                    // height-matched; width fills naturally

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

  // Scale every px in the stylesheet, and the page box itself.
  html = html.replace(/<style>[\s\S]*?<\/style>/, block =>
    block.replace(/(\d+(?:\.\d+)?)px/g, (m, n) => (Math.round(Number(n) * SCALE * 100) / 100) + 'px'));
  html = html.replace(/width:\s*[\d.]+px;\s*height:\s*[\d.]+px;\s*\}/,
                      `width:${W}px;height:${H}px;}`);
  html = html.replace('@page { size: 5in 7in; margin: 0; }', '@page { size: 8.5in 11in; margin: 0; }');

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

  await browser.close();

  // ---- PDF -------------------------------------------------------------
  // NOT rendered by the browser. page.pdf() measures in CSS pixels at 96dpi, so
  // a `width: '8.5in'` page is 816 CSS px while this layout is authored at 2550
  // CSS px to land at a true 300dpi. Printing the DOM captured the top-left
  // 816x1056 of a 2550x3300 design and then PAGINATED the overflow: Durand got
  // half a sign across three pages. (2026-09-16.)
  //
  // Instead the finished 300dpi raster is wrapped in a PDF by Pillow, which
  // sizes the page straight from the image's DPI -- 2550px / 300dpi = 8.5in --
  // with no layout engine, no CSS units and nothing that can paginate.
  const pdfScript = path.join(outdir, '_topdf.py');
  fs.writeFileSync(pdfScript, [
    'from PIL import Image',
    'im = Image.open(' + JSON.stringify(pngOut) + ').convert("RGB")',
    'assert im.size == (' + W + ', ' + H + '), im.size',
    'im.save(' + JSON.stringify(pdfOut) + ', "PDF", resolution=300.0)'
  ].join('\n'));
  execFileSync('python3', [pdfScript], { stdio: 'inherit' });
  fs.unlinkSync(pdfScript);

  // Refuse to ship a PDF that is not exactly one letter-size page. This is the
  // check that would have caught the bug above before Durand ever opened it.
  const pdf = fs.readFileSync(pdfOut).toString('latin1');
  const pageCount = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const box = pdf.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const pt = n => Math.round(Number(n));
  if (pageCount !== 1 || !box || Math.abs(pt(box[1]) - 612) > 2 || Math.abs(pt(box[2]) - 792) > 2) {
    console.error('ERROR: PDF is ' + pageCount + ' page(s), ' +
      (box ? pt(box[1]) + 'x' + pt(box[2]) : 'unreadable') + 'pt; expected 1 page at 612x792pt.');
    process.exit(1);
  }
  console.log('PDF verified: 1 page, ' + pt(box[1]) + 'x' + pt(box[2]) + 'pt (8.5x11in @ 300dpi).');

  console.log('Wrote ' + pngOut + '  (' + W + 'x' + H + ', 8.5x11in @ 300dpi, scale ' +
              SCALE.toFixed(3) + ')');
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
