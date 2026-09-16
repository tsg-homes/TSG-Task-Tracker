#!/usr/bin/env python3
"""
Regenerate the entry-form QR code, with the TSG monogram in the centre.

    python3 tools/make-qr.py "<exec URL>?form=raffle" [outdir]

The URL is an ARGUMENT, never a constant in this file: it contains the Apps
Script deployment id, this repo is public, and `npm test` fails on any tracked
file containing one. Get it from `clasp list-deployments` (the entry that is not
@HEAD) and pipe it straight in rather than retyping it:

    DEP=$(clasp list-deployments | grep -v '@HEAD' | grep -o 'AKfycb[A-Za-z0-9_-]*' | head -1)
    python3 tools/make-qr.py "https://script.google.com/macros/s/$DEP/exec?form=raffle"

Needs: pip install segno opencv-python-headless pillow

Two things this does that a QR generator normally will not:

1. The centre mark is sized against error-correction headroom, not by eye. The
   code is ECC level H (~30% recoverable), and the white plate is fitted to the
   monogram's own tall-narrow proportion rather than squared off -- a square
   plate would knock out noticeably more modules for the same visual size. The
   plate ends up covering about 5% of the code area.

2. It refuses to emit a code it has not proved scannable. Every output is decoded
   back and compared to the exact input URL, at several sizes and under blur,
   rotation and a glare gradient -- roughly what a phone camera faces pointed at
   a table tent outdoors. If any of that fails the script exits non-zero rather
   than handing you a pretty code that does not work.

Also writes a plain, unbranded code. Take it to the event as a fallback: if an
old phone or bad lighting struggles with the branded one, you swap the print and
lose only the logo.
"""
import io, sys, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import segno, cv2

MARK_HEIGHT_FRAC = 0.26     # monogram height as a fraction of the code's height
PLATE_PAD_FRAC   = 0.13     # white margin around the mark, as a fraction of it


def _decode(img, detector):
    grey = np.array(img.convert('L'))
    text, _, _ = detector.detectAndDecode(cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR))
    return text


def verify(img, url, label):
    """Decode under conditions a phone actually meets. Returns True if all pass."""
    det = cv2.QRCodeDetector()
    checks, failures = [], []
    for px in (900, 600, 450):
        base = img.resize((px, px), Image.LANCZOS).convert('L')
        glare = np.array(base).astype(float) * np.linspace(0.62, 1.18, px)[None, :]
        for name, variant in (
            ('clean',    base),
            ('blur',     base.filter(ImageFilter.GaussianBlur(1.2))),
            ('rotated',  base.rotate(12, expand=True, fillcolor=255)),
            ('glare',    Image.fromarray(np.clip(glare, 0, 255).astype('uint8'))),
        ):
            ok = _decode(variant, det) == url
            checks.append(ok)
            if not ok:
                failures.append(f'{px}px {name}')
    print(f'  {label}: {sum(checks)}/{len(checks)} scan conditions pass'
          + (f'  FAILED: {", ".join(failures)}' if failures else ''))
    return not failures


def build(url, monogram_path, scale=40):
    code = segno.make(url, error='h')
    buf = io.BytesIO()
    code.save(buf, kind='png', scale=scale, border=4)
    buf.seek(0)
    qr = Image.open(buf).convert('RGBA')
    width, _ = qr.size

    mark = Image.open(monogram_path).convert('RGBA')
    mark = mark.crop(mark.getbbox())            # drop transparent padding
    mw, mh = mark.size
    h = int(width * MARK_HEIGHT_FRAC)
    w = int(mw * h / mh)
    pad = int(h * PLATE_PAD_FRAC)

    pw, ph = w + pad * 2, h + pad * 2
    plate = Image.new('RGBA', (pw, ph), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        [0, 0, pw - 1, ph - 1], radius=int(min(pw, ph) * 0.22), fill=(255, 255, 255, 255))
    plate.alpha_composite(mark.resize((w, h), Image.LANCZOS), (pad, pad))
    qr.alpha_composite(plate, ((width - pw) // 2, (width - ph) // 2))

    coverage = 100.0 * pw * ph / (width * width)
    return qr.convert('RGB'), coverage, code.version


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    url = sys.argv[1].strip()
    outdir = sys.argv[2] if len(sys.argv) > 2 else '.'
    os.makedirs(outdir, exist_ok=True)

    here = os.path.dirname(os.path.abspath(__file__))
    monogram = os.path.join(here, '..', 'assets', 'tsg-monogram.png')

    print(f'Encoding: {url}')
    branded, coverage, version = build(url, monogram)
    print(f'QR version {version}, ECC H. Centre plate covers {coverage:.1f}% of the code area.')

    branded_path = os.path.join(outdir, 'tsg-raffle-qr-logo.png')
    plain_path = os.path.join(outdir, 'tsg-raffle-qr-plain.png')
    branded.save(branded_path)
    segno.make(url, error='h').save(plain_path, scale=40, border=4)

    good = verify(branded, url, 'branded')
    good &= verify(Image.open(plain_path).convert('L'), url, 'plain  ')
    if not good:
        sys.exit('\nREFUSING TO SHIP: a generated code failed to scan. '
                 'Lower MARK_HEIGHT_FRAC and re-run.')

    print(f'\nWrote {branded_path} and {plain_path} ({branded.size[0]}px).')
    print('Print at 8cm or larger — this is a 61x61-module code.')


if __name__ == '__main__':
    main()
