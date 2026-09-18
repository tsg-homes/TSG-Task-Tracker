/**
 * Template compilation guards.
 *
 *   node test/test_templates.js
 *
 * WHY THIS FILE EXISTS. On 2026-09-17 the consent page and the draw console were
 * both found to throw "SyntaxError: Unexpected token ';'" on EVERY render in the
 * real Apps Script runtime. Neither had ever rendered live. The cause in both was
 * a comment explaining the force-print convention that spelled the tags out as
 * examples: the template compiler does not know a scriptlet is inside a JS
 * comment, so it read those examples as print expressions that were EMPTY,
 * compiled `output += ;` and threw.
 *
 * Nothing caught it. The sandbox renderer models tags with a real expression in
 * them, the browser suite tests the BUILT form rather than a compiled template,
 * and the live suite had never rendered either page -- which is exactly the gap
 * that was closed an hour before this was found.
 *
 * These checks are deliberately crude string scans rather than a renderer. The
 * failure mode is lexical, so a lexical test is the honest shape for it, and it
 * runs against the real shipped files.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const TEMPLATES = ['RaffleConsent.html', 'RaffleConsole.html', 'RaffleForm.html',
                   'RaffleForm.template.html'];

let fails = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// Every scriptlet in the file, with its 1-based line number.
function scriptlets(src) {
  const out = [];
  const re = /<\?([\s\S]*?)\?>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ raw: m[0], inner: m[1], line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

TEMPLATES.forEach(function (file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { check(file + ' exists', false, 'not found at ' + p); return; }
  const src = fs.readFileSync(p, 'utf8');
  const tags = scriptlets(src);

  // Guards the guard: a file with no scriptlets at all would pass everything
  // below for the wrong reason. The built form is the one legitimate exception.
  check(file + ': has scriptlets to check', tags.length > 0 || file === 'RaffleForm.html',
    'found none');

  // THE ONE THAT MATTERS. `<?= ?>`, `<?!= ?>` or `<? ?>` with nothing inside
  // compiles to a statement with no expression and throws at render.
  const empty = tags.filter(t => t.inner.replace(/^!?=?/, '').trim() === '');
  check(file + ': no EMPTY scriptlet (compiles to `output += ;` and throws)',
    empty.length === 0,
    empty.map(t => 'line ' + t.line + ': ' + JSON.stringify(t.raw)).join(', '));

  // Unbalanced delimiters: a stray `<?` swallows the rest of the file into a
  // scriptlet, and a stray `?>` closes one that was never opened.
  const opens = (src.match(/<\?/g) || []).length;
  const closes = (src.match(/\?>/g) || []).length;
  check(file + ': scriptlet delimiters balance',
    opens === closes && opens === tags.length,
    opens + ' opens, ' + closes + ' closes, ' + tags.length + ' matched pairs');

  // A scriptlet body carrying no identifier is suspicious -- UNLESS it is block
  // punctuation, which is how a template closes an if: `<? } ?>` is correct and
  // common. So the rule is: an identifier, or nothing but braces.
  const junk = tags.filter(t => {
    const body = t.inner.replace(/^!?=?/, '').trim();
    if (body === '') return false;                       // covered by the empty check
    if (/^[{}\s]+$/.test(body)) return false;            // `}`, `{`, `} else {`
    return !/[A-Za-z_$]/.test(body);
  });
  check(file + ': no scriptlet body that is neither code nor a brace',
    junk.length === 0,
    junk.map(t => 'line ' + t.line + ': ' + JSON.stringify(t.raw)).join(', '));
});

// And the specific regression, named, so the reason survives the refactor that
// eventually rewrites these files.
['RaffleConsent.html', 'RaffleConsole.html'].forEach(function (file) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  check(file + ': the force-print comment does not spell the tags out',
    !/\/\/[^\n]*<\?/.test(src),
    'a JS line comment contains a scriptlet delimiter — the compiler will read it');
});

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
