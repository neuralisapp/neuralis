/**
 * packageAppBaseTag — the `<base href>` injected into a BUNDLE-mode entry.
 *
 * Two properties are under test, and only one of them is cosmetic:
 *
 *  - the HREF BUILDER is a security boundary. `entryRelPath` is package data and
 *    the kernel validator lets a quote, an angle bracket or a space through, so
 *    the builder must encode per segment and REFUSE outright rather than emit
 *    anything that could close the attribute.
 *  - the INSERTION POINT is a security boundary. The first `<base href>` in tree
 *    order wins; an insertion point that lands after the package's own head
 *    content hands base resolution back to the package, silently and in the one
 *    direction that is a security failure rather than a bug.
 *
 * THE PROPERTY UNDER TEST IS PRECEDENCE, NEVER A LITERAL ANCHOR STRING. This file
 * asserts `indexOf(TAG) < indexOf('<base')`, so it survives any future change to
 * WHERE the tag lands as long as the tag still wins. The previous suite asserted
 * `toContain('<head>' + TAG)` and stayed green through the whole class of defects
 * this matrix exists to catch — five shapes in which a real parser resolved the
 * PACKAGE's base, with two non-vacuum controls resolving to OURS.
 *
 * LAYER BOUNDARY, stated so nobody mistakes green here for proof: vitest runs
 * `environment: 'node'` and this repo installs no jsdom/parse5, so these are
 * STRING-POSITION assertions only. Tree order and `document.compatMode` are
 * settled by handing the SAME rows to a real browser after a rebuild — a unit
 * suite structurally cannot decide either.
 */
import { describe, expect, it } from 'vitest';
import { buildPackageAppBaseHref, injectBaseTag } from '../packageAppBaseTag';

const TOKEN = 'TOKEN123';
const HREF = `/api/package-app/_pub/${TOKEN}/surface/`;
const TAG = `<base href="${HREF}">`;

/** Index of our tag; -1 when absent. */
function at(out: string): number {
  return out.indexOf(TAG);
}

describe('buildPackageAppBaseHref — the entry directory rule', () => {
  it('maps an entry at the surface ROOT to the surface root itself', () => {
    // `posix.dirname('index.html')` is '.', NOT '' — unmapped this would emit
    // `…/surface/./`, which resolves but hides the bug.
    expect(buildPackageAppBaseHref(TOKEN, 'index.html')).toBe(HREF);
    expect(buildPackageAppBaseHref(TOKEN, 'index.html')).not.toContain('/./');
  });

  it('maps a nested entry to its OWN directory', () => {
    expect(buildPackageAppBaseHref(TOKEN, 'sub/index.html')).toBe(
      `/api/package-app/_pub/${TOKEN}/surface/sub/`,
    );
    expect(buildPackageAppBaseHref(TOKEN, 'a/b/c/entry.html')).toBe(
      `/api/package-app/_pub/${TOKEN}/surface/a/b/c/`,
    );
  });

  it('percent-encodes each segment rather than trusting package data', () => {
    expect(buildPackageAppBaseHref(TOKEN, 'my dir/index.html')).toBe(
      `/api/package-app/_pub/${TOKEN}/surface/my%20dir/`,
    );
    expect(buildPackageAppBaseHref(TOKEN, 'a&b/index.html')).toBe(
      `/api/package-app/_pub/${TOKEN}/surface/a%26b/`,
    );
    expect(buildPackageAppBaseHref(TOKEN, 'ünïcode/index.html')).toBe(
      `/api/package-app/_pub/${TOKEN}/surface/%C3%BCn%C3%AFcode/`,
    );
  });

  it('NEVER emits a breakout character — the property that actually matters', () => {
    // Each of these is creatable on Linux and passes the kernel's relative-url
    // check, which rejects only absolute urls, `\`, `%` and empty/`.`/`..`.
    // Unescaped, any of them would let the package close our `href="…"` and emit
    // its OWN <base> FIRST. Encoding is what makes them harmless; the outcome
    // under test is "safely encoded OR refused", never "emitted verbatim".
    for (const rel of [
      'a"b/index.html',
      "a'b/index.html",
      'a<b/index.html',
      'a>b/index.html',
      'a b/index.html',
      'a\tb/index.html',
      'a\nb/index.html',
      '"><base href="https://evil.example/"><x/index.html',
    ]) {
      const href = buildPackageAppBaseHref(TOKEN, rel);
      if (href !== null) {
        expect(href).not.toMatch(/["'<>\s]/);
        // And the encoded form cannot be read back as markup.
        expect(href).not.toContain('<base');
      }
    }
  });

  it("REFUSES outright on `'` — the one char encodeURIComponent leaves intact", () => {
    // The residual guard is not decoration: `encodeURIComponent` deliberately
    // preserves `!~*'()`, so a fail-closed check on the ASSEMBLED href is what
    // keeps the apostrophe (and anything a future refactor stops encoding) out.
    expect(buildPackageAppBaseHref(TOKEN, "a'b/index.html")).toBeNull();
  });

  it('REFUSES an empty segment (a `//` in the path) and an empty token', () => {
    expect(buildPackageAppBaseHref(TOKEN, 'a//b/index.html')).toBeNull();
    expect(buildPackageAppBaseHref('', 'index.html')).toBeNull();
  });

  it('never emits a character that could close the href attribute', () => {
    const href = buildPackageAppBaseHref(TOKEN, 'sub/index.html');
    expect(href).not.toBeNull();
    expect(href!).not.toMatch(/["'<>\s]/);
  });
});

const DOCTYPE = '<!DOCTYPE html>';
const EVIL = '<base href="/EVIL/">';

/**
 * Where OUR tag must sit relative to the document's doctype.
 *
 *  - `after`  — the strict-HTML5 doctype keeps first position (standards mode is
 *               preserved; this is the cosmetic concession the rule makes);
 *  - `before` — the position-0 fallback fired, so our tag precedes the doctype and
 *               the document goes QUIRKS. That cost is ACCEPTED and asserted here:
 *               a fallback may cost standards mode, never precedence;
 *  - `none`   — the document has no doctype to reason about.
 */
type DoctypeRelation = 'after' | 'before' | 'none';

/**
 * Every shape in which a package can place its own `<base>` ahead of ours. The
 * five that the landed `<head>`/`<html>` anchor lost (rows 1, 2, 3, 6, 7) are all
 * here, plus the doctype and comment/PI shapes that break a naive end-finder.
 */
const ATTACK_ROWS: ReadonlyArray<{
  n: number;
  name: string;
  doc: string;
  doctype: DoctypeRelation;
}> = [
  { n: 1, name: 'package base inside a real <head>', doc: `${DOCTYPE}<html><head>${EVIL}<title>t</title></head></html>`, doctype: 'after' },
  { n: 2, name: 'package base BEFORE <head> (hoisted into the implicit head)', doc: `${DOCTYPE}<html>${EVIL}<head><title>t</title></head></html>`, doctype: 'after' },
  { n: 3, name: 'package base first, no doctype', doc: `${EVIL}<html><head><title>t</title></head></html>`, doctype: 'none' },
  { n: 4, name: 'package base BEFORE the doctype', doc: `${EVIL}${DOCTYPE}<html><head></head></html>`, doctype: 'before' },
  { n: 5, name: 'a comment mentioning <head> between doctype and package base', doc: `${DOCTYPE}<!-- <head> -->${EVIL}<html></html>`, doctype: 'after' },
  { n: 6, name: '<head> hidden in an <html> ATTRIBUTE VALUE', doc: `<html data-x="<head>"><head>${EVIL}</head></html>`, doctype: 'none' },
  { n: 7, name: '<head> hidden in a FOREIGN tag attribute', doc: `${DOCTYPE}<div title="<head>"></div><head>${EVIL}</head>`, doctype: 'after' },
  { n: 8, name: 'package base inside a body <header>', doc: `${DOCTYPE}<html><body><header>${EVIL}</header></body></html>`, doctype: 'after' },
  { n: 10, name: 'leading whitespace before the doctype', doc: `\n\n  \t${DOCTYPE}<html><head>${EVIL}</head></html>`, doctype: 'after' },
  { n: 11, name: 'an XML declaration before the doctype', doc: `<?xml version="1.0"?>${DOCTYPE}<html><head>${EVIL}</head></html>`, doctype: 'after' },
  { n: 12, name: 'a legacy PUBLIC doctype', doc: `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><head>${EVIL}</head></html>`, doctype: 'before' },
  { n: 13, name: 'a doctype with a `>` INSIDE a quoted identifier', doc: `<!DOCTYPE html PUBLIC "a>b"><html><head>${EVIL}</head></html>`, doctype: 'before' },
  { n: 14, name: 'an UNTERMINATED comment opening with <head>', doc: `<!-- <head> ${EVIL}`, doctype: 'none' },
  // `<!-->` is a COMPLETE comment (abrupt-closing-of-empty-comment), so the
  // doctype behind it really is in leading position and standards mode is kept.
  // This row read `before` while the scanner treated `<!-->` as unterminated —
  // that was the scanner being wrong in the harmless direction (quirks), and the
  // browser measurement recorded it as a compat FLIP against the uninjected twin.
  { n: 15, name: 'an abrupt-closing empty comment before the doctype', doc: `<!-->${DOCTYPE}<html><head>${EVIL}</head></html>`, doctype: 'after' },
  { n: 16, name: 'a DOUBLE doctype', doc: `${DOCTYPE}${DOCTYPE}<html><head>${EVIL}</head></html>`, doctype: 'after' },
  { n: 17, name: 'package base only in the BODY, after content', doc: `${DOCTYPE}<html><head></head><body><p>x</p>${EVIL}</body></html>`, doctype: 'after' },
  { n: 21, name: 'a package <base target> with no href', doc: `${DOCTYPE}<html><head><base target="_blank"><title>t</title></head></html>`, doctype: 'after' },
];

describe('injectBaseTag — precedence over every package-declared <base>', () => {
  it.each(ATTACK_ROWS)('row $n — $name', ({ doc, doctype }) => {
    const out = injectBaseTag(doc, HREF);

    // Exactly one injected tag, and nothing but the tag was added.
    expect(out.split(TAG)).toHaveLength(2);
    expect(out.replace(TAG, '')).toBe(doc);

    // THE property: our tag precedes the FIRST `<base` in the output. `<base` is
    // matched as a prefix so a `target`-only base counts too — the spec reads
    // `target` from the first base element as well.
    expect(at(out)).toBeGreaterThan(-1);
    expect(at(out)).toBeLessThan(out.indexOf('<base', at(out) + TAG.length));

    if (doctype === 'after') {
      // Standards mode preserved: the doctype survives byte-for-byte and keeps
      // first position.
      expect(out).toContain(DOCTYPE);
      expect(out.indexOf(DOCTYPE)).toBeLessThan(at(out));
    } else if (doctype === 'before') {
      // The position-0 fallback. Quirks mode is the ACCEPTED cost; precedence is
      // not negotiable, and the assertion above already proved it.
      expect(at(out)).toBe(0);
      expect(at(out)).toBeLessThan(out.toUpperCase().indexOf('<!DOCTYPE'));
    }
  });

  it('row 6 — the <html> attribute value survives BYTE-INTACT', () => {
    // The landed scanner re-scanned from inside its own match and spliced the tag
    // INTO this attribute, where the parser ground it into `<html>` attributes.
    const doc = `<html data-x="<head>"><head>${EVIL}</head></html>`;
    const out = injectBaseTag(doc, HREF);
    expect(out).toContain('<html data-x="<head>">');
    expect(out).toBe(TAG + doc);
  });

  it('row 9 — both BOM spellings stay at offset 0, with a doctype and bare', () => {
    // Inserting at offset 0 would put the tag BEFORE the BOM: the BOM stops
    // being a BOM, becomes a stray character mid-document, and the encoding
    // sniff changes. The latin1 spelling is the ONLY one that ships (the route
    // decodes bytes with `latin1`, where a UTF-8 BOM is three characters).
    for (const bom of ['﻿', 'ï»¿']) {
      const withDoctype = injectBaseTag(`${bom}${DOCTYPE}<html><head>${EVIL}</head>`, HREF);
      expect(withDoctype.startsWith(bom)).toBe(true);
      expect(withDoctype).toContain(DOCTYPE + TAG);
      expect(at(withDoctype)).toBeLessThan(withDoctype.indexOf(EVIL));

      const fragment = injectBaseTag(`${bom}<div>hi</div>`, HREF);
      expect(fragment).toBe(`${bom}${TAG}<div>hi</div>`);
    }
  });

  it('CONTROL 18 — with no package base at all, OURS is still the only one', () => {
    // Positive discriminator: without this the matrix could be vacuous (a suite
    // that never injects would "pass" every precedence assertion).
    const out = injectBaseTag(`${DOCTYPE}<html><head><title>t</title></head></html>`, HREF);
    expect(at(out)).toBeGreaterThan(-1);
    expect(out.split('<base').length - 1).toBe(1);
    expect(out).toContain(DOCTYPE + TAG);
  });

  it('CONTROL 19 — a package base AFTER ours inside the head still loses', () => {
    const doc = `${DOCTYPE}<html><head><title>t</title></head></html>`;
    const out = injectBaseTag(doc.replace('</head>', `${EVIL}</head>`), HREF);
    expect(at(out)).toBeLessThan(out.indexOf(EVIL));
  });

  it('falls back to the very start for a bare fragment', () => {
    const out = injectBaseTag('<div>hi</div>', HREF);
    expect(out).toBe(TAG + '<div>hi</div>');
  });

  it('anchors after a lone doctype with no html element', () => {
    const out = injectBaseTag('<!DOCTYPE html>\n<body>hi</body>', HREF);
    expect(out).toContain('<!DOCTYPE html>' + TAG);
  });

  it('accepts the doctype in any casing and with loose inner whitespace', () => {
    expect(injectBaseTag('<!doctype   html   ><p>x', HREF)).toContain('<!doctype   html   >' + TAG);
    expect(injectBaseTag('<!DocType html><p>x', HREF)).toContain('<!DocType html>' + TAG);
  });

  it('does NOT anchor inside a leading comment that mentions <head>', () => {
    // A build banner does exactly this. Without a doctype the answer is position
    // 0 — AHEAD of the banner — which is the safe direction: our tag can never
    // land inside the comment, where it would be inert.
    const doc = '<!-- built from <head> and <html> --><html><head>' + EVIL + '</head></html>';
    const out = injectBaseTag(doc, HREF);
    expect(out).toBe(TAG + doc);
    expect(at(out)).toBeLessThan(out.indexOf(EVIL));
  });

  it('treats `<?…>` as a bogus comment ending at the FIRST `>`, not at `?>`', () => {
    // HTML has no processing instructions: `<?` opens a bogus comment that ends
    // at the first `>`. Hunting for `?>` is XML semantics and would swallow real
    // markup — here it would run past the doctype and lose standards mode.
    const doc = `<?php if ($a > $b) {} ?>${DOCTYPE}<p>x`;
    const out = injectBaseTag(doc, HREF);
    expect(out).toBe(TAG + doc);
    // The bogus comment ends at the `>` in `$a > $b`, so the doctype is NOT in
    // leading position and the position-0 fallback correctly fires. Under the
    // old `?>` search the scan would have run past it and anchored AFTER the
    // doctype instead — this assertion is what tells the two apart.
    expect(at(out)).toBe(0);
  });

  it('is byte-preserving for a latin1 high byte (a non-UTF-8 entry)', () => {
    // A `<meta charset="iso-8859-1">` entry reaches this function through a
    // latin1 round-trip; a UTF-8 decode/encode would silently corrupt it.
    const original = Buffer.from([
      0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, // <html>
      0xe9, 0xff, 0x80, // three high bytes, invalid as UTF-8
      0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e, // </html>
    ]);
    const out = injectBaseTag(original.toString('latin1'), HREF);
    const bytes = Buffer.from(out, 'latin1');
    expect(bytes.includes(Buffer.from([0xe9, 0xff, 0x80]))).toBe(true);
    // Exactly the original bytes plus our tag's bytes.
    expect(bytes.length).toBe(original.length + Buffer.byteLength(TAG, 'latin1'));
    // The anchor is position 0 (this fragment carries no doctype); the BYTES on
    // either side of it are the property under test, and they are untouched.
    expect(bytes.subarray(Buffer.byteLength(TAG, 'latin1'))).toEqual(original);
  });

  it('injects the tag and NOTHING else', () => {
    const doc = '<!DOCTYPE html><html><head></head><body>hi</body></html>';
    const out = injectBaseTag(doc, HREF);
    expect(out.replace(TAG, '')).toBe(doc);
  });
});

// ---------------------------------------------------------------------------
// The comment-terminator corpus (the second time this failure class landed)
// ---------------------------------------------------------------------------

/** The UTF-8 BOM as the ENTRY LANE sees it: three latin1 characters. */
const BOM8 = 'ï»¿';

/**
 * The six shapes in which the shipped transform was measured — with parse5, the
 * WHATWG reference implementation, reading the FIRST `<base href>` in TREE order
 * — to hand base resolution to the PACKAGE, plus the four non-vacuum controls
 * that resolved to OURS in the same run.
 *
 * ONE cause behind all six: the comment scan knew only `-->`. Every row therefore
 * pairs a real comment closed by a construction the scan did NOT know with a
 * DECOY `-->` and a strict doctype behind it, so an over-running scan skipped the
 * package's own `<base>` and anchored behind the decoy.
 *
 * `anchor` is the expected insertion INDEX, asserted alongside precedence.
 * Asserting only precedence would let a future "fix" that simply never injects
 * pass; asserting only the index would re-freeze the suite onto one anchor rule,
 * which is exactly the rigidity that kept the previous suite green through this
 * whole class.
 */
const TERMINATOR_ROWS: ReadonlyArray<{
  id: string;
  name: string;
  doc: string;
  anchor: number;
}> = [
  {
    id: 'R-A',
    name: '`--!>` closes the comment; a decoy `-->` guards a strict doctype',
    doc: `<!--x--!>${EVIL} --><!doctype html><html><head></head></html>`,
    anchor: 0,
  },
  {
    id: 'R-B',
    name: 'R-A behind a UTF-8 BOM (the only spelling the entry lane produces)',
    doc: `${BOM8}<!--x--!>${EVIL} --><!doctype html><html><head></head></html>`,
    anchor: BOM8.length,
  },
  {
    id: 'R-C',
    name: '`<!-->` abrupt close + decoy',
    doc: `<!-->${EVIL} --><!doctype html><html><head></head></html>`,
    anchor: 0,
  },
  {
    id: 'R-D',
    name: '`<!--->` abrupt close + decoy',
    doc: `<!--->${EVIL} --><!doctype html><html><head></head></html>`,
    anchor: 0,
  },
  {
    id: 'R-E',
    name: 'the decoy sits in a QUOTED ATTRIBUTE VALUE (our tag was spliced into it)',
    doc: `<!--x--!>${EVIL}<div title=" --> <!doctype html> "></div>`,
    anchor: 0,
  },
  {
    id: 'R-F',
    name: 'the decoy sits in a `<script>` STRING LITERAL (our tag was spliced into it)',
    doc: `<!--x--!>${EVIL}<script>var s = " --> <!doctype html> ";</script>`,
    anchor: 0,
  },
];

describe('injectBaseTag — the four comment-closing constructions', () => {
  it.each(TERMINATOR_ROWS)('$id — $name', ({ doc, anchor }) => {
    const out = injectBaseTag(doc, HREF);

    // Nothing but the tag was added, exactly once.
    expect(out.split(TAG)).toHaveLength(2);
    expect(out.replace(TAG, '')).toBe(doc);

    // THE property: ours precedes the package's, expressed as precedence rather
    // than as a literal anchor string.
    expect(at(out)).toBe(anchor);
    expect(at(out)).toBeLessThan(out.indexOf(EVIL));
  });

  /**
   * The controls are the reason the six rows above are not vacuous. Without
   * them a transform that always anchored at 0 would "pass" every row while
   * throwing away standards mode on every well-formed document.
   */
  it('CONTROL-1 — a plain doctype keeps first position and we follow it', () => {
    const out = injectBaseTag(`${DOCTYPE}<html><head>${EVIL}</head></html>`, HREF);
    expect(at(out)).toBe(DOCTYPE.length);
    expect(at(out)).toBeLessThan(out.indexOf(EVIL));
  });

  it('CONTROL-2 — a REAL leading comment is skipped, the doctype still wins', () => {
    const comment = '<!-- built by something -->';
    const out = injectBaseTag(`${comment}${DOCTYPE}<html><head>${EVIL}</head></html>`, HREF);
    expect(at(out)).toBe(comment.length + DOCTYPE.length);
    expect(at(out)).toBeLessThan(out.indexOf(EVIL));
  });

  it('CONTROL-3 — with no package base at all, ours is the only one', () => {
    const out = injectBaseTag(`${DOCTYPE}<html><head><title>t</title></head></html>`, HREF);
    expect(at(out)).toBe(DOCTYPE.length);
    expect(out.split('<base').length - 1).toBe(1);
  });

  it('CONTROL-4 — a legacy PUBLIC doctype takes the position-0 fallback', () => {
    const legacy = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">';
    const out = injectBaseTag(`${legacy}<html><head>${EVIL}</head></html>`, HREF);
    expect(at(out)).toBe(0);
    expect(at(out)).toBeLessThan(out.indexOf(EVIL));
  });

  it('closes a comment at whichever of `-->` / `--!>` comes FIRST', () => {
    // `-->` first: the `--!>` further along must not win, or the scan over-runs.
    const out = injectBaseTag(`<!--a-->${DOCTYPE}<p>x--!></p>`, HREF);
    expect(at(out)).toBe('<!--a-->'.length + DOCTYPE.length);
  });

  it('still refuses an unterminated comment (position 0, never a guess)', () => {
    const doc = `<!--x${EVIL}`;
    expect(injectBaseTag(doc, HREF)).toBe(TAG + doc);
  });
});

describe('injectBaseTag — the anchor POST-CONDITION', () => {
  /**
   * The scan is not trusted to be complete: whatever it skipped over, if a
   * `<base` is in there the anchor collapses to position 0. Both rows below are
   * deliberate FALSE POSITIVES — the `<base` text is inert in each (it sits
   * inside a comment / bogus comment) — and the price is exactly the documented
   * one: quirks mode, never precedence. That asymmetry is the whole point.
   */
  it('collapses to position 0 when a skipped `<?…>` bogus comment holds a `<base`', () => {
    // The bogus comment ends at the FIRST `>`, which is the one closing the
    // decoy base tag — so the scan legitimately reaches the doctype behind it.
    const doc = `<?x${EVIL}${DOCTYPE}<html></html>`;
    const out = injectBaseTag(doc, HREF);
    expect(at(out)).toBe(0);
  });

  it('collapses to position 0 when a skipped COMMENT holds a `<base`', () => {
    const doc = `<!-- ${EVIL} -->${DOCTYPE}<html></html>`;
    const out = injectBaseTag(doc, HREF);
    expect(at(out)).toBe(0);
  });

  it('matches `<base` case-insensitively and as a PREFIX', () => {
    const doc = `<!-- <BASE TARGET="_blank"> -->${DOCTYPE}<html></html>`;
    expect(at(injectBaseTag(doc, HREF))).toBe(0);
  });

  it('does NOT fire on a skipped comment with no base in it', () => {
    // The negative control: without this the post-condition could be a
    // "collapse to 0 always" rule wearing a disguise.
    const comment = '<!-- nothing to see -->';
    const out = injectBaseTag(`${comment}${DOCTYPE}<html></html>`, HREF);
    expect(at(out)).toBe(comment.length + DOCTYPE.length);
  });
});

describe('injectBaseTag — the UTF-16 refusal', () => {
  /**
   * `leadingBomLength` recognises only `U+FEFF` and the latin1 `EF BB BF`, so a
   * UTF-16 BOM would otherwise measure as length 0 and put an ASCII tag AHEAD of
   * the BOM. Both possible insertion points are unsafe (the docstring has the
   * reasoning), so the transform declines entirely — fail-closed onto the
   * B-baseline, where the subresources simply do not load.
   */
  it.each([
    ['UTF-16LE', 'ÿþ'],
    ['UTF-16BE', 'þÿ'],
  ])('returns a %s document COMPLETELY untouched', (_label, bom) => {
    const doc = `${bom}${DOCTYPE}<html><head>${EVIL}</head></html>`;
    expect(injectBaseTag(doc, HREF)).toBe(doc);
    expect(injectBaseTag(doc, HREF)).not.toContain(TAG);
  });

  it('does not mistake the UTF-8 BOM or a decoded U+FEFF for UTF-16', () => {
    // The discriminator: these two MUST still be injected into, or the refusal
    // would silently disable bundle mode for every BOM-carrying entry.
    for (const bom of ['﻿', BOM8]) {
      const out = injectBaseTag(`${bom}<div>hi</div>`, HREF);
      expect(out).toBe(`${bom}${TAG}<div>hi</div>`);
    }
  });
});
