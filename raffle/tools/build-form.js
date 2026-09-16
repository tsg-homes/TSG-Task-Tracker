#!/usr/bin/env node
/**
 * Builds RaffleForm.html (the file that gets pasted into / pushed to the Apps
 * Script project) from RaffleForm.template.html plus the pinned third-party
 * marks in assets/.
 *
 * Why the Ticketmaster and Eagles marks are inlined here rather than read from
 * Drive the way the TSG and KW marks are: they are not ours. Pinning them in the
 * built file means the exact bytes that were reviewed are the exact bytes that
 * ship, and nobody can swap a third-party trademark into the page by dropping a
 * file in Drive. It also makes the page fully self-contained, which matters a
 * lot more than usual when 125 people are loading it over one saturated cell
 * site in Fishtown.
 *
 *   node tools/build-form.js
 */
const fs = require('fs');
const path = require('path');

const dir  = path.join(__dirname, '..');
const tpl  = fs.readFileSync(path.join(dir, 'RaffleForm.template.html'), 'utf8');

const eaglesB64 = fs.readFileSync(path.join(dir, 'assets/eagles.b64'), 'utf8').trim();
let   tmSvg     = fs.readFileSync(path.join(dir, 'assets/ticketmaster.svg'), 'utf8').trim();

// The SVG is inlined as markup, not as a data: URI, so it stays crisp at any
// size. Its own width/height attributes would otherwise beat the CSS, and its
// `.st0` class is generic enough to collide with anything else on the page, so
// both are scoped before it goes in.
tmSvg = tmSvg
  .replace(/\s(?:width|height)="[^"]*"/g, '')
  .replace(/\bst0\b/g, 'tm-fill')
  .replace('<svg ', '<svg role="img" aria-label="Ticketmaster" ');

const out = tpl
  .replace('{{EAGLES_DATA_URI}}', 'data:image/png;base64,' + eaglesB64)
  .replace('{{TICKETMASTER_SVG}}', tmSvg);

for (const token of ['{{EAGLES_DATA_URI}}', '{{TICKETMASTER_SVG}}', '{{TSG_LOGO}}', '{{KW_LOGO}}']) {
  if (out.includes(token)) {
    console.error('ERROR: placeholder ' + token + ' was not substituted.');
    process.exit(1);
  }
}

fs.writeFileSync(path.join(dir, 'RaffleForm.html'), out);
console.log('RaffleForm.html written — ' + Math.round(out.length / 1024) + ' KB');
