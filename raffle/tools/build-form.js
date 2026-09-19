#!/usr/bin/env node
/**
 * Builds RaffleForm.html (the file that gets pasted into / pushed to the Apps
 * Script project) from RaffleForm.template.html plus the pinned third-party
 * marks in assets/.
 *
 * All four marks -- Eagles, Ticketmaster, TSG and KW Empower -- are pinned here
 * rather than fetched at runtime. The bytes that were reviewed are the bytes
 * that ship, nobody can swap a trademark into the page by dropping a file in
 * Drive, the script needs no Drive OAuth scope at all, and the page is fully
 * self-contained -- which matters a lot more than usual when 125 people are
 * loading it over one saturated cell site in Fishtown.
 *
 * Sources, all from TSG's own Drive, trimmed and quantized (see git history):
 *   eagles.png  philadelphia-eagles-logo-transparent.png   263 KB -> 12.6 KB
 *   tsg.png     TSG_2024_LOGO-01.png, wordmark panel        3.2 MB -> 4.1 KB
 *   kw.png      KW Empower Logo_color.jpg                   676 KB -> 4.6 KB
 *
 *   node tools/build-form.js
 */
const fs = require('fs');
const path = require('path');

const dir  = path.join(__dirname, '..');
const tpl  = fs.readFileSync(path.join(dir, 'RaffleForm.template.html'), 'utf8');

const b64 = f => fs.readFileSync(path.join(dir, 'assets/' + f), 'utf8').trim();
const eaglesB64 = b64('eagles.b64');
const tsgB64    = b64('tsg.b64');
const kwB64     = b64('kw.b64');
let   tmSvg     = fs.readFileSync(path.join(dir, 'assets/ticketmaster.svg'), 'utf8').trim();

// The SVG is inlined as markup, not as a data: URI, so it stays crisp at any
// size. Its own width/height attributes would otherwise beat the CSS, and its
// `.st0` class is generic enough to collide with anything else on the page, so
// both are scoped before it goes in.
tmSvg = tmSvg
  .replace(/\s(?:width|height)="[^"]*"/g, '')
  .replace(/\bst0\b/g, 'tm-fill')
  .replace('<svg ', '<svg role="img" aria-label="Ticketmaster" ');

const png = b => 'data:image/png;base64,' + b;
const out = tpl
  .replace('{{EAGLES_DATA_URI}}', png(eaglesB64))
  .replace('{{TICKETMASTER_SVG}}', tmSvg)
  .replace('{{TSG_LOGO}}', png(tsgB64))
  .replace('{{KW_LOGO}}', png(kwB64));

for (const token of ['{{EAGLES_DATA_URI}}', '{{TICKETMASTER_SVG}}', '{{TSG_LOGO}}', '{{KW_LOGO}}']) {
  if (out.includes(token)) {
    console.error('ERROR: placeholder ' + token + ' was not substituted.');
    process.exit(1);
  }
}

fs.writeFileSync(path.join(dir, 'RaffleForm.html'), out);
console.log('RaffleForm.html written — ' + Math.round(out.length / 1024) + ' KB');
