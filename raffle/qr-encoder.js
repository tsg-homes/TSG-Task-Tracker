/**
 * TSG QR — a byte-mode QR encoder, small enough to inline in a page.
 *
 * WHY THIS EXISTS. The kiosk and the table sign both have to show a QR code for
 * the entry URL, and that URL carries the Apps Script deployment id: it can
 * never be committed (this repo is public and `npm test` fails on it), so a
 * pre-rendered PNG in assets/ is not an option. Generating the code in the page
 * from the URL the page is already serving solves both problems at once — there
 * is nothing to commit, and the code cannot go stale against a redeploy.
 *
 * It is NOT a replacement for tools/make-qr.py. That one is the print pipeline:
 * it adds the TSG monogram and, more importantly, decodes every code it emits
 * under blur, rotation and glare before handing it over. This one is plain and
 * is verified a different way — test/test_qr.js compares its output module for
 * module against `segno`, an independent implementation, across versions and
 * error-correction levels.
 *
 * Byte mode only. Every URL is ASCII, and mode switching to squeeze out a few
 * modules would buy nothing here and add a class of bug.
 *
 * Loads as a CommonJS module (the tests) and as a browser global `TSGQR` (the
 * built pages, which inline this file verbatim).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TSGQR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Error-correction levels, in the order the standard's tables use.
  var LEVELS = ['L', 'M', 'Q', 'H'];
  // The 2-bit field each level occupies in the format information.
  var LEVEL_FORMAT_BITS = [1, 0, 3, 2];

  // Error-correction codewords per block, by level then version (1..40).
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  // Number of error-correction blocks, by level then version (1..40).
  var NUM_ECC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // ---- GF(256) arithmetic for Reed-Solomon, modulus x^8+x^4+x^3+x^2+1 ----
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  // The generator polynomial's coefficients, highest power first, monic term dropped.
  function eccDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function eccRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (d, i) { result[i] ^= gfMul(d, factor); });
    });
    return result;
  }

  // ---- Capacity ----
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ECC_BLOCKS[ecl][ver];
  }

  function charCountBits(ver) { return ver <= 9 ? 8 : 16; }

  function alignmentPatternPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // ---- Bit buffer ----
  function appendBits(bits, val, len) {
    for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  }

  function toBytes(text) {
    // UTF-8, so a stray non-ASCII character in a URL still encodes correctly
    // rather than silently truncating to a wrong code.
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else {
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (text.charCodeAt(++i) & 0x3FF));
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return out;
  }

  // ---- The matrix ----
  function Matrix(size) {
    this.size = size;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < size; y++) {
      var row = [], fn = [];
      for (var x = 0; x < size; x++) { row.push(false); fn.push(false); }
      this.modules.push(row);
      this.isFunction.push(fn);
    }
  }
  Matrix.prototype.set = function (x, y, dark, isFn) {
    this.modules[y][x] = dark;
    if (isFn) this.isFunction[y][x] = true;
  };
  Matrix.prototype.get = function (x, y) {
    return (x >= 0 && x < this.size && y >= 0 && y < this.size) ? this.modules[y][x] : false;
  };

  function drawFinder(m, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var x = cx + dx, y = cy + dy;
        if (x >= 0 && x < m.size && y >= 0 && y < m.size) m.set(x, y, dist !== 2 && dist !== 4, true);
      }
    }
  }

  function drawAlignment(m, cx, cy) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
      }
    }
  }

  function drawFormatBits(m, ecl, mask) {
    var data = LEVEL_FORMAT_BITS[ecl] << 3 | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    var bit = function (i) { return ((bits >>> i) & 1) === 1; };
    for (var i = 0; i <= 5; i++) m.set(8, i, bit(i), true);
    m.set(8, 7, bit(6), true);
    m.set(8, 8, bit(7), true);
    m.set(7, 8, bit(8), true);
    for (var i = 9; i < 15; i++) m.set(14 - i, 8, bit(i), true);

    for (var i = 0; i < 8; i++) m.set(m.size - 1 - i, 8, bit(i), true);
    for (var i = 8; i < 15; i++) m.set(8, m.size - 15 + i, bit(i), true);
    m.set(8, m.size - 8, true, true);           // always-dark module
  }

  function drawVersionBits(m, ver) {
    if (ver < 7) return;
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (ver << 12) | rem;
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) === 1;
      var a = m.size - 11 + i % 3, b = Math.floor(i / 3);
      m.set(a, b, bit, true);
      m.set(b, a, bit, true);
    }
  }

  function drawFunctionPatterns(m, ver, ecl) {
    for (var i = 0; i < m.size; i++) {
      m.set(6, i, i % 2 === 0, true);           // timing
      m.set(i, 6, i % 2 === 0, true);
    }
    drawFinder(m, 3, 3);
    drawFinder(m, m.size - 4, 3);
    drawFinder(m, 3, m.size - 4);

    var pos = alignmentPatternPositions(ver), n = pos.length;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        drawAlignment(m, pos[i], pos[j]);
      }
    }
    drawFormatBits(m, ecl, 0);                  // placeholder; redrawn with the chosen mask
    drawVersionBits(m, ver);
  }

  function drawCodewords(m, data) {
    var i = 0;                                  // bit index into data
    for (var right = m.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                // the vertical timing column is skipped
      for (var vert = 0; vert < m.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? m.size - 1 - vert : vert;
          if (!m.isFunction[y][x] && i < data.length * 8) {
            m.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
          // Remainder bits past the data stay light, as the standard requires.
        }
      }
    }
  }

  function applyMask(m, mask) {
    for (var y = 0; y < m.size; y++) {
      for (var x = 0; x < m.size; x++) {
        if (m.isFunction[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
          default: throw new Error('bad mask');
        }
        if (invert) m.modules[y][x] = !m.modules[y][x];
      }
    }
  }

  function penalty(m) {
    var size = m.size, score = 0;

    // Rule 1: runs of five or more same-colour modules in a row or column.
    for (var y = 0; y < size; y++) {
      var runColor = false, runLen = 0, history = [0, 0, 0, 0, 0, 0, 0];
      for (var x = 0; x < size; x++) {
        if (m.modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) score += PENALTY_N1;
          else if (runLen > 5) score++;
        } else {
          finderPenaltyAddHistory(runLen, history, size);
          if (!runColor) score += finderPenaltyCountPatterns(history) * PENALTY_N3;
          runColor = m.modules[y][x];
          runLen = 1;
        }
      }
      score += finderPenaltyTerminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
    }
    for (var x = 0; x < size; x++) {
      var runColor = false, runLen = 0, history = [0, 0, 0, 0, 0, 0, 0];
      for (var y = 0; y < size; y++) {
        if (m.modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) score += PENALTY_N1;
          else if (runLen > 5) score++;
        } else {
          finderPenaltyAddHistory(runLen, history, size);
          if (!runColor) score += finderPenaltyCountPatterns(history) * PENALTY_N3;
          runColor = m.modules[y][x];
          runLen = 1;
        }
      }
      score += finderPenaltyTerminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
    }

    // Rule 2: every 2x2 block of one colour.
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var c = m.modules[y][x];
        if (c === m.modules[y][x + 1] && c === m.modules[y + 1][x] && c === m.modules[y + 1][x + 1]) {
          score += PENALTY_N2;
        }
      }
    }

    // Rule 4: deviation of the dark-module share from 50%.
    var dark = 0;
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (m.modules[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += k * PENALTY_N4;
    return score;
  }

  function finderPenaltyCountPatterns(history) {
    var n = history[1];
    var core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
           (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }
  function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, history, size) {
    if (currentRunColor) {
      finderPenaltyAddHistory(currentRunLength, history, size);
      currentRunLength = 0;
    }
    currentRunLength += size;
    finderPenaltyAddHistory(currentRunLength, history, size);
    return finderPenaltyCountPatterns(history);
  }
  function finderPenaltyAddHistory(currentRunLength, history, size) {
    if (history[0] === 0) currentRunLength += size;   // the light border counts
    history.pop();
    history.unshift(currentRunLength);
  }

  /**
   * The code for `text` as a 2D array of booleans (true = dark), including no
   * quiet zone — the caller adds that.
   *
   * ecl: 'L' | 'M' | 'Q' | 'H' (default 'M').
   * minVersion: force at least this version, e.g. to keep a code's module count
   * stable across URLs of slightly different length.
   * forceMask: tests only — skip mask selection and use this one.
   */
  function matrix(text, ecl, minVersion, forceMask) {
    var level = LEVELS.indexOf(String(ecl || 'M').toUpperCase());
    if (level === -1) throw new Error('unknown error-correction level: ' + ecl);
    var bytes = toBytes(String(text));

    var ver = Math.max(1, Math.min(40, Number(minVersion) || 1));
    for (; ver <= 40; ver++) {
      var cap = numDataCodewords(ver, level) * 8;
      if (4 + charCountBits(ver) + bytes.length * 8 <= cap) break;
    }
    if (ver > 40) throw new Error('data too long for a QR code: ' + bytes.length + ' bytes');

    // Segment: byte mode, character count, the bytes themselves.
    var bits = [];
    appendBits(bits, 4, 4);
    appendBits(bits, bytes.length, charCountBits(ver));
    bytes.forEach(function (b) { appendBits(bits, b, 8); });

    var dataCapacityBits = numDataCodewords(ver, level) * 8;
    appendBits(bits, 0, Math.min(4, dataCapacityBits - bits.length));     // terminator
    appendBits(bits, 0, (8 - bits.length % 8) % 8);                       // to a byte boundary
    for (var pad = 0xEC; bits.length < dataCapacityBits; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);

    var dataCodewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataCodewords.push(b);
    }

    // Blocks, ECC per block, then interleaved as the standard orders them.
    var numBlocks = NUM_ECC_BLOCKS[level][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[level][ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [], divisor = eccDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var block = dat.slice();
      eccRemainder(dat, divisor).forEach(function (b) { block.push(b); });
      if (i < numShortBlocks) block.splice(shortBlockLen - blockEccLen, 0, null);
      blocks.push(block);
    }
    var result = [];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j][i];
        if (b !== null && b !== undefined) result.push(b);
      }
    }

    var m = new Matrix(ver * 4 + 17);
    drawFunctionPatterns(m, ver, level);
    drawCodewords(m, result);

    // The mask is chosen, not picked: all eight are scored and the best wins.
    // forceMask exists for the tests, which pin the data bits against segno with
    // the mask held equal so a penalty-scoring difference cannot hide a data bug.
    var best = -1, bestScore = Infinity;
    if (forceMask !== undefined && forceMask !== null) best = Number(forceMask);
    else for (var mask = 0; mask < 8; mask++) {
      applyMask(m, mask);
      drawFormatBits(m, level, mask);
      var score = penalty(m);
      if (score < bestScore) { bestScore = score; best = mask; }
      applyMask(m, mask);                        // XOR again to undo
    }
    applyMask(m, best);
    drawFormatBits(m, level, best);

    return { size: m.size, version: ver, mask: best, level: LEVELS[level],
             penalty: penalty(m), modules: m.modules,
             functionModules: m.isFunction, codewords: result };
  }

  /**
   * The same code as an SVG string. SVG rather than a canvas so it stays crisp
   * on a phone screen, in a 300dpi print and anywhere in between, and so the
   * page needs no raster step.
   */
  function svg(text, opts) {
    opts = opts || {};
    var q = opts.quiet === undefined ? 4 : Number(opts.quiet);
    var code = matrix(text, opts.ecl, opts.minVersion);
    var dim = code.size + q * 2;
    var path = [];
    for (var y = 0; y < code.size; y++) {
      for (var x = 0; x < code.size; x++) {
        if (code.modules[y][x]) path.push('M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" ' +
      'shape-rendering="crispEdges" role="img" aria-label="' +
      String(opts.label || 'QR code').replace(/[<>&"]/g, '') + '">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.light || '#ffffff') + '"/>' +
      '<path d="' + path.join('') + '" fill="' + (opts.dark || '#000000') + '"/></svg>';
  }

  return { matrix: matrix, svg: svg };
});
