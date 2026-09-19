#!/usr/bin/env node
/**
 * Render the table sign as a standalone HTML page.
 *
 *   node tools/build-sign-html.js <path-to-qr.png> [out.html]
 *
 * Same template and same QR as the printed sign (tools/build-display.js), but
 * output you can open, share as a link and print from a browser rather than a
 * 300dpi raster. Use it for the screen at the table, for a reprint from any
 * machine, and for sending someone the sign without sending a 700 KB PNG.
 *
 * NOT a second design. `display/table-display.template.html` stays the one
 * source of truth; this only re-homes its fixed 1500x2100 layout into a page
 * that scales to the viewport on screen and to one letter page in print.
 *
 * The QR is a PATH ARGUMENT and the output is NOT written into this repo: the
 * code encodes the exec URL, the repo is public, and `npm test` fails on any
 * tracked file carrying a deployment id. Either pass the code made by
 * tools/make-qr.py, or lift the one already on the built sign:
 *
 *   python3 -c "import cv2;d=cv2.QRCodeDetector();print(d.detectAndDecode(cv2.imread('sign.png'))[0])"
 *
 * Unlike build-display.js this needs no browser: the header wordmark is
 * recoloured with a CSS filter instead of being pre-inverted in a canvas.
 */
const fs = require('fs');
const path = require('path');

const [qrPath, outArg] = process.argv.slice(2);
if (!qrPath) {
  console.error('usage: node tools/build-sign-html.js <path-to-qr.png> [out.html]');
  process.exit(1);
}
if (!fs.existsSync(qrPath)) {
  console.error('QR not found: ' + qrPath);
  process.exit(1);
}

const dir = path.join(__dirname, '..');
const b64 = f => fs.readFileSync(path.join(dir, 'assets', f), 'utf8').trim();
const png = b => 'data:image/png;base64,' + b;

const tm = fs.readFileSync(path.join(dir, 'assets/ticketmaster.svg'), 'utf8').trim()
  .replace(/\s(?:width|height)="[^"]*"/g, '')
  .replace(/\bst0\b/g, 'tm-fill')
  .replace('<svg ', '<svg role="img" aria-label="Ticketmaster" ');

const tsgDark = png(b64('tsg.b64'));

let html = fs.readFileSync(path.join(dir, 'display/table-display.template.html'), 'utf8')
  .replace('{{TSG_LOGO_WHITE}}', tsgDark)          // recoloured by CSS below
  .replace('{{TSG_LOGO_DARK}}', tsgDark)
  .replace('{{KW_LOGO}}', png(b64('kw.b64')))
  .replace('{{EAGLES}}', png(b64('eagles.b64')))
  .replace('{{TICKETMASTER}}', tm)
  .replace('{{QR}}', png(fs.readFileSync(qrPath).toString('base64')));

for (const token of html.match(/\{\{[A-Z_]+\}\}/g) || []) {
  console.error('ERROR: placeholder not substituted: ' + token);
  process.exit(1);
}

// The page box moves off <body> and onto #sheet, so the design keeps its exact
// 1500x2100 coordinate space while the page around it is free to scale.
const bodyRule = `html,body{width:1500px;height:2100px;}
body{font-family:'Lato',Arial,sans-serif;color:var(--ink);background:#fff;
     display:flex;flex-direction:column;-webkit-font-smoothing:antialiased;}`;
if (!html.includes(bodyRule)) {
  console.error('ERROR: the template\'s body rule has changed; update build-sign-html.js to match.');
  process.exit(1);
}
html = html.replace(bodyRule, `html,body{width:auto;height:auto;}
body{background:#e9edee;-webkit-font-smoothing:antialiased;}
/* overflow:hidden is load-bearing, not cosmetic: a CSS transform does not
   change layout size, so the 1500x2100 sheet still occupies 2100px of flow and
   Chrome printed it across three pages. Clipping the stage to the scaled size
   drops the document to one page, and nothing is actually cut because the
   scaled sheet is exactly the stage's size. */
#stage{width:calc(1500px * var(--s));height:calc(2100px * var(--s));margin:0 auto;overflow:hidden;}
#sheet{width:1500px;height:2100px;font-family:'Lato',Arial,sans-serif;color:var(--ink);
  background:#fff;display:flex;flex-direction:column;
  transform:scale(var(--s));transform-origin:top left;box-shadow:0 12px 44px rgba(0,0,0,.28);}
/* The wordmark ships dark green on transparent and the header band is dark. */
.header img.tsg{filter:brightness(0) invert(1);}
/* Screen only: what this page is and how to print it. */
#bar{max-width:760px;margin:0 auto;padding:18px 20px 14px;font-family:'Lato',Arial,sans-serif;
  color:#24393a;text-align:center;}
#bar h1{font-family:'Playfair Display',serif;font-size:22px;margin:0 0 4px;color:#15464A;}
#bar p{margin:0 0 12px;font-size:14px;line-height:1.5;color:#4a5858;}
#bar button{font:700 15px 'Lato',Arial,sans-serif;background:#15464A;color:#fff;border:0;
  border-radius:8px;padding:11px 20px;cursor:pointer;}
@page{size:8.5in 11in;margin:0;}
@media print{
  body{background:#fff;}
  #bar{display:none;}
  /* 11in at 96dpi is 1056 CSS px, so 0.5 puts the 2100px design at 1050px —
     just inside the page, which is what stops Chrome spilling a second sheet.
     !important because the fit script sets --s inline, and an inline custom
     property would otherwise win over this rule and print the sign small.
     (Caught by the render check: it printed at 0.405 instead.) */
  #sheet{transform:scale(0.5) !important;box-shadow:none;margin:0 auto;}
  #stage{width:750px;height:1050px;margin:0 auto;overflow:hidden;}
}`);

html = html.replace('@page { size: 5in 7in; margin: 0; }', '');

html = html.replace('<body>', `<body>
<div id="bar">
  <h1>Block Party raffle — table sign</h1>
  <p>The same sign as the printed one, at letter size. Print it from here
     (Chrome: background graphics on, margins none, scale 100%), or leave this
     page open on a screen at the table.</p>
  <button type="button" onclick="window.print()">Print this sign</button>
</div>
<div id="stage"><div id="sheet">`);
html = html.replace('</body>', `</div></div>
<script>
// Fit the sheet to whatever is looking at it. Printing overrides --s in CSS, so
// this only ever drives the screen.
(function () {
  function fit() {
    var pad = window.innerWidth < 700 ? 16 : 40;
    var s = Math.min((window.innerWidth - pad * 2) / 1500, (window.innerHeight - 150) / 2100, 1);
    document.documentElement.style.setProperty('--s', Math.max(0.12, s));
  }
  fit();
  window.addEventListener('resize', fit);
})();
</script>
</body>`);

// The sheet has to carry a starting scale even before the script runs.
html = html.replace(':root{', ':root{\n  --s:0.5;');

const out = outArg || path.join(process.cwd(), 'tsg-block-party-table-sign.html');
fs.writeFileSync(out, html);
console.log('Wrote ' + out + '  (' + Math.round(html.length / 1024) + ' KB, self-contained except webfonts)');
