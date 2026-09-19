/**
 * Verify qr-encoder.js two ways: module-for-module against an independent
 * encoder, and by decoding the rendered code the way a phone would.
 *
 *   node test/test_qr.js
 *   (needs: pip install qrcode opencv-python-headless)
 *
 * WHY THIS SHAPE. A hand-rolled encoder can be wrong in ways that still look
 * like a QR code: one stale entry in an error-correction table, an off-by-one in
 * the character-count field at the version-10 boundary, a mask chosen by a
 * slightly different penalty rule. Eyeballing catches none of it.
 *
 * Reference 1 is `qrcode` (python-qrcode), compared module for module with the
 * mask held equal, which pins the data bits, the Reed-Solomon codewords, the
 * block interleaving, the module placement and the format/version information.
 * Reference 2 is OpenCV's detector, run over the actual rendered pixels, which
 * proves the thing scans and carries the exact URL — the only property the party
 * cares about.
 *
 * A NOTE ON `segno`, which this file deliberately does NOT use as the reference.
 * For byte-mode input segno emits one extra 0x00 codeword (it pads the
 * terminator out to a whole byte), so its matrices differ from both this
 * encoder and python-qrcode. Both forms decode to the same text — a decoder
 * stops at the terminator — but they are not the same bit stream, so segno
 * cannot serve as an exact-match oracle here. The decode tests below cover what
 * that difference would otherwise have told us.
 */
const { execFileSync } = require('child_process');
const QR = require('../qr-encoder.js');

let passes = 0, fails = 0;
const check = (name, cond, detail) => {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); }
};

// Shaped and sized like the live entry URL, with a placeholder deployment id:
// this repo is public and `npm test` fails on a real one. Length is what the
// encoder reacts to, not the characters.
const EXEC = 'https://script.google.com/macros/s/' + 'A'.repeat(66) + '/exec?form=raffle';

const PY_ENCODE = `
import json, sys, qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE
LV = {'L': qrcode.ERROR_CORRECT_L, 'M': qrcode.ERROR_CORRECT_M,
      'Q': qrcode.ERROR_CORRECT_Q, 'H': qrcode.ERROR_CORRECT_H}
out = []
for c in json.load(sys.stdin):
    kw = dict(error_correction=LV[c['e']], border=0)
    if c.get('mask') is not None:
        kw['mask_pattern'] = c['mask']
    q = qrcode.QRCode(**kw)
    q.add_data(QRData(c['t'].encode('utf-8'), mode=MODE_8BIT_BYTE))
    q.make(fit=True)
    out.append({'v': q.version, 'mask': q.mask_pattern,
                'm': [[1 if b else 0 for b in r] for r in q.modules]})
json.dump(out, sys.stdout)
`;
const encodeRef = cases => JSON.parse(execFileSync('python3', ['-c', PY_ENCODE],
  { input: JSON.stringify(cases), maxBuffer: 1 << 28 }).toString());

// ---- 1. Every module, against python-qrcode, at a fixed mask ----------------
// The mask is held equal so a difference in mask SELECTION cannot mask (or fake)
// a difference in the data itself. Mask choice is checked separately below.
{
  const texts = [
    'x',                                   // one byte, smallest code
    'hello world',
    EXEC,                                  // the real case
    EXEC + '&kiosk=1',
    'y'.repeat(100),
    'z'.repeat(150),                       // over the version-10 char-count boundary
    'w'.repeat(300),
    'q'.repeat(700),                       // multi-block, long-block remainder
    'The Stawasz Group Block Party 2026 — enter to win $300'
  ];
  const cases = [];
  for (const e of ['L', 'M', 'Q', 'H']) for (const t of texts) cases.push({ t, e, mask: 0 });
  const ref = encodeRef(cases);
  let mismatches = 0, versionsChecked = new Set();
  cases.forEach((c, i) => {
    const mine = QR.matrix(c.t, c.e, 1, 0);
    versionsChecked.add(mine.version);
    if (mine.version !== ref[i].v) {
      mismatches++;
      console.log('      version ' + c.e + '/' + c.t.length + ': mine v' + mine.version + ', ref v' + ref[i].v);
      return;
    }
    for (let y = 0; y < ref[i].m.length; y++) {
      for (let x = 0; x < ref[i].m[y].length; x++) {
        if ((mine.modules[y][x] ? 1 : 0) !== ref[i].m[y][x]) {
          mismatches++;
          console.log('      modules ' + c.e + '/' + c.t.length + ': first diff at (' + x + ',' + y + ')');
          return;
        }
      }
    }
  });
  check('every module matches python-qrcode across ' + cases.length + ' cases', mismatches === 0,
    mismatches + ' case(s) differ');
  check('those cases span several versions', versionsChecked.size >= 6,
    'versions: ' + [...versionsChecked].sort((a, b) => a - b).join(','));
}

// ---- 2. Mask selection --------------------------------------------------------
// NOT compared against python-qrcode. The standard's penalty rules are a
// scannability heuristic, and its third rule (finder-like 1:1:3:1:1 runs) is
// implemented differently by conforming encoders: this one counts runs with the
// light border included, python-qrcode scans for the literal 11-module pattern.
// They disagree on which mask wins for some inputs, and both are right — every
// one of the eight masks decodes to the same text, which is what section 3
// proves. What is asserted here is that the choice is in range, deterministic,
// and actually the minimum under this encoder's own scoring.
{
  const texts = ['x', 'hello world', EXEC, 'y'.repeat(100), 'z'.repeat(150), 'w'.repeat(300)];
  const cases = [];
  for (const e of ['L', 'M', 'Q', 'H']) for (const t of texts) cases.push({ t, e });
  const bad = [];
  cases.forEach(c => {
    const a = QR.matrix(c.t, c.e), b = QR.matrix(c.t, c.e);
    if (!(a.mask >= 0 && a.mask <= 7)) bad.push(c.e + '/' + c.t.length + ' mask ' + a.mask);
    else if (a.mask !== b.mask) bad.push(c.e + '/' + c.t.length + ' not deterministic');
  });
  check('the mask is in range and the same on every call, all ' + cases.length + ' cases',
    bad.length === 0, bad.join(', '));

  // The chosen mask really is the lowest-scoring one: rebuild under each of the
  // eight and confirm none of them beats it on the encoder's own penalty.
  const code = QR.matrix(EXEC, 'M');
  const byMask = [];
  for (let m = 0; m < 8; m++) byMask.push(QR.matrix(EXEC, 'M', 1, m).penalty);
  const min = Math.min.apply(null, byMask);
  check('the chosen mask is the minimum-penalty one',
    byMask[code.mask] === min, 'chose ' + code.mask + ' at ' + byMask[code.mask] + ', min ' + min +
    ' (' + byMask.join(',') + ')');
}

// ---- 3. It decodes, as pixels, to exactly the URL -----------------------------
// What actually matters on Saturday. Rendered small, then blurred and rotated,
// which is roughly what a phone camera meets pointed at a screen across a table.
{
  const PY_DECODE = `
import json, sys, numpy as np, cv2
req = json.load(sys.stdin)
det = cv2.QRCodeDetector()
out = []
for case in req:
    mods = np.array(case['m'], dtype=np.uint8)
    q = 4
    size = mods.shape[0] + q * 2
    img = np.ones((size, size), dtype=np.uint8) * 255
    img[q:q+mods.shape[0], q:q+mods.shape[1]] = np.where(mods == 1, 0, 255)
    res = {}
    # Rendered at a real module size first, the way a screen or a print does it,
    # then resampled smoothly: rotating a nearest-neighbour blow-up produces
    # staircase edges no camera ever sees and fails codes that scan fine.
    for module_px in (8, 5):
        big = cv2.resize(img, None, fx=module_px, fy=module_px, interpolation=cv2.INTER_NEAREST)
        px = big.shape[0]
        variants = {
            'clean': big,
            'blur': cv2.GaussianBlur(big, (0, 0), module_px / 6.0),
        }
        # The canvas has to GROW with the rotation. Rotating in place clips the
        # code's own corners — finder patterns included — and fails codes that
        # scan perfectly well.
        m = cv2.getRotationMatrix2D((px / 2, px / 2), 8, 1.0)
        cos, sin = abs(m[0, 0]), abs(m[0, 1])
        nw, nh = int(px * sin + px * cos), int(px * cos + px * sin)
        m[0, 2] += nw / 2 - px / 2
        m[1, 2] += nh / 2 - px / 2
        variants['rotated'] = cv2.warpAffine(big, m, (nw, nh), flags=cv2.INTER_LINEAR,
                                             borderMode=cv2.BORDER_CONSTANT, borderValue=255)
        for name, v in variants.items():
            text, _, _ = det.detectAndDecode(cv2.cvtColor(v, cv2.COLOR_GRAY2BGR))
            res[name + '@' + str(module_px) + 'px/module'] = text
    out.append(res)
json.dump(out, sys.stdout)
`;
  const texts = [EXEC, EXEC + '&kiosk=1', 'https://tsg.homes', 'y'.repeat(120)];
  const payload = [], refPayload = [], expect = [];
  const refCases = [];
  for (const ecl of ['L', 'M', 'H']) for (const t of texts) refCases.push({ t, e: ecl, mask: null });
  const refCodes = encodeRef(refCases);
  refCases.forEach((c, i) => {
    payload.push({ m: QR.matrix(c.t, c.e).modules.map(r => r.map(v => (v ? 1 : 0))) });
    refPayload.push({ m: refCodes[i].m });
    expect.push({ t: c.t, ecl: c.e });
  });
  const decode = p => JSON.parse(execFileSync('python3', ['-c', PY_DECODE],
    { input: JSON.stringify(p), maxBuffer: 1 << 28 }).toString());
  const decoded = decode(payload);
  const refDecoded = decode(refPayload);

  // Every condition must decode, except rotation at the smallest render: at
  // 5px per module a rotated, resampled code is past what OpenCV's detector
  // manages, and it fails the reference encoder's codes there too (the parity
  // check below is what holds that case). The kiosk draws its code as vector at
  // roughly 8px per module on the iPad's own pixels, so 8 is the honest bar.
  const bad = [];
  decoded.forEach((res, i) => {
    Object.keys(res).filter(k => k !== 'rotated@5px/module').forEach(cond => {
      if (res[cond] !== expect[i].t) {
        bad.push(expect[i].ecl + '/' + expect[i].t.length + ' ' + cond +
          ' -> ' + JSON.stringify(res[cond].slice(0, 40)));
      }
    });
  });
  check('every rendered code decodes to exactly its URL: clean and blurred at both sizes, rotated at 8px/module',
    bad.length === 0, bad.slice(0, 6).join('; '));

  // And never worse than the reference encoder on identical input, which is what
  // would separate "our bug" from "the detector's limit" if the absolute check
  // above ever starts failing on a new size or condition.
  const worse = [];
  decoded.forEach((res, i) => {
    Object.keys(res).filter(k => k.startsWith('rotated')).forEach(cond => {
      const mineOk = res[cond] === expect[i].t;
      const refOk = refDecoded[i][cond] === expect[i].t;
      if (refOk && !mineOk) worse.push(expect[i].ecl + '/' + expect[i].t.length + ' ' + cond);
    });
  });
  check('rotated, it decodes wherever python-qrcode\'s own code does', worse.length === 0,
    worse.join(', '));
}

// ---- 4. The knobs the pages use ----------------------------------------------
{
  // minVersion holds the module count steady across URLs of slightly different
  // length, so a printed code's scan distance does not move when the URL does.
  const a = QR.matrix(EXEC, 'H', 11);
  const b = QR.matrix(EXEC + '&extra=1', 'H', 11);
  check('minVersion pins the version', a.version === 11 && b.version === 11,
    'a v' + a.version + ', b v' + b.version);
  check('minVersion never shrinks a code below what the data needs',
    QR.matrix('q'.repeat(600), 'H', 11).version > 11);

  const code = QR.matrix(EXEC, 'M');
  const svg = QR.svg(EXEC, { ecl: 'M' });
  const dim = code.size + 8;
  check('svg carries the 4-module quiet zone', svg.indexOf('viewBox="0 0 ' + dim + ' ' + dim + '"') !== -1,
    svg.slice(0, 120));
  let dark = 0;
  code.modules.forEach(row => row.forEach(v => { if (v) dark++; }));
  check('svg draws one square per dark module', (svg.match(/h1v1h-1z/g) || []).length === dark);
  check('svg references nothing off the page',
    !/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')));
  check('svg escapes its label', QR.svg('x', { label: '"><script>' }).indexOf('<script>') === -1);
}

// ---- 5. Refusals rather than a quietly wrong code -----------------------------
{
  let threw = '';
  try { QR.matrix('x', 'Z'); } catch (e) { threw = e.message; }
  check('an unknown error-correction level is refused', /unknown error-correction level/.test(threw), threw);
  threw = '';
  try { QR.matrix('x'.repeat(5000), 'H'); } catch (e) { threw = e.message; }
  check('data too long for any version is refused', /too long/.test(threw), threw);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
