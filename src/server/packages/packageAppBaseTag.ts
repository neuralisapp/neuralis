/**
 * packageAppBaseTag — the `<base href>` the host injects into a BUNDLE-mode entry
 * document so its relative subresources resolve onto the SESSION-FREE lane.
 *
 * Pure string logic: no filesystem, no `Response`, no logger, no record. That is
 * deliberate — this is a transformation applied to UNTRUSTED package HTML, and it
 * has to be exhaustively unit-testable without mounting a route.
 *
 * WHY THE INSERTION POINT IS SECURITY, NOT COSMETICS. The HTML parser honours the
 * FIRST `<base href>` element in tree order and ignores every later one. It was
 * measured, with a non-vacuum control, that a package's OWN `<base>` WINS when
 * ours is absent or comes second — so an insertion point that lands after the
 * package's head content silently hands base resolution back to the package.
 *
 * NEVER REINTRODUCE A `<head>` OR `<html>` ANCHOR. This is not a scanner bug that
 * a better scanner could fix — it is unsound BY SPEC. A `<base>` appearing BEFORE
 * `<html>`/`<head>` is hoisted by the tree builder into the IMPLICIT head ("before
 * html" → "before head" → anything-else → implicit `<head>` → "in head"), and the
 * package's LATER real `<head>` start tag is then DROPPED as a stray token. So a
 * tag anchored after `<head`/`<html>` can never be first, however carefully the
 * scan is written. Measured with a real parser: all five shapes below resolved to
 * the PACKAGE, with two non-vacuum controls resolving to OURS.
 *
 * THE SCANNER-SHAPED FAILURE CLASS IS OPEN BY CONSTRUCTION — do not read the rule
 * below as "the shapes are all found now". This class has bitten TWICE. First the
 * `<head>`/`<html>` anchor, whose visible failures were all scanner-shaped
 * (`indexOf('<head')` also matching a body `<header>`; a build banner
 * `<!-- built from <head> -->` offering a fake anchor inside a comment; a `<head>`
 * sitting in a quoted attribute value, where the landed code spliced our tag INTO
 * the attribute and the parser ground it into `<html>` attributes) but whose real
 * defect was the tree-order fact underneath, which no scanner can fix. Then the
 * COMMENT TERMINATOR SET: the HTML tokenizer closes a comment on FOUR
 * constructions and the landed scan knew ONE —
 *
 *   - `-->`     — comment end state, the only one the first version handled;
 *   - `--!>`    — comment end BANG state (an "incorrectly-closed-comment" parse
 *                 error, still a close);
 *   - `<!-->`   — abrupt-closing-of-empty-comment, `>` straight after `<!--`;
 *   - `<!--->`  — the same abruption one dash later.
 *
 * Missing three of the four let a document say `<!--x--!><base href="/EVIL/"> -->`
 * followed by a decoy `<!doctype html>`: the scan ran PAST the real comment end,
 * swallowed the package's own `<base>` element and anchored behind the decoy, so
 * our tag came SECOND. Measured with parse5 (the WHATWG reference implementation)
 * in six shapes, including two where our tag landed inside a quoted attribute
 * value and inside a `<script>` string literal — every one resolved to the
 * PACKAGE, with four non-vacuum controls resolving to OURS.
 *
 * A third latent shape is the base rate, not a surprise. That is why the rule
 * below carries an ANCHOR POST-CONDITION (see {@link injectBaseTag}): whatever the
 * scan returns, if a `<base` appears anywhere BEFORE it we fall back to position
 * 0. The one load-bearing security property of this file must not rest on the
 * scanner being complete.
 *
 * COSMETIC COSTS OF THE RULE BELOW, all measured, none security-relevant:
 *
 *  - the package's own `<head>` ATTRIBUTES are lost — its late `<head>` start tag
 *    is the dropped token, so attributes on it never reach the implicit element;
 *  - `<html>` attributes are MERGED onto the implicit `<html>` and SURVIVE
 *    (`class`, `lang`, … all present after injection);
 *  - the package's own `<base>` is ignored ENTIRELY, `target` included — the spec
 *    reads `target` from the first base element too;
 *  - QUIRKS MODE. Measured with parse5 8.0.1 (`document.mode`) against this exact
 *    transform, each row parsed BOTH uninjected and injected so only a
 *    no-quirks → quirks FLIP counts: EXACTLY TWO classes are caused by the
 *    injection.
 *      (i)  a legacy/exotic doctype — the scan falls back to position 0, which
 *           puts our tag ahead of the doctype. The preflight warns on it.
 *      (ii) THE ANCHOR POST-CONDITION FIRING on an otherwise perfectly strict
 *           document: any `<base` string in the leading skipped text — a build
 *           banner such as `<!-- built with <base href="/x/"> -->` — collapses
 *           the anchor to position 0 ahead of a valid `<!doctype html>`. This is
 *           the fallback trading rendering mode for precedence, exactly as
 *           intended, but it is a cost a package author cannot otherwise see, so
 *           the preflight warns on it too.
 *    Shapes that are NOT our cost, and the measured reason for each (do not
 *    restate these from memory — the numbers here come with their controls): an
 *    unterminated leading comment and a document with no doctype are ALREADY
 *    quirks uninjected; a quoted/exotic `<!DOCTYPE "html">` is already quirks;
 *    a leading `<?…>` processing instruction is no-quirks BOTH ways (parse5
 *    treats it as a bogus comment and the following doctype still counts). A
 *    leading UTF-8 BOM reads as quirks in parse5 either way — parse5 does not
 *    strip it, a browser does during the encoding sniff, so that row measures
 *    the parser, not the transform.
 *
 * BYTE PRESERVATION. Callers convert with `buffer.toString('latin1')` and back
 * with `Buffer.from(result, 'latin1')`. `latin1` is a lossless byte↔char map, so
 * this stays a pure string transform while a `<meta charset="iso-8859-1">` entry
 * survives untouched. A UTF-8 decode/encode round-trip would silently corrupt
 * such a file — today's path passes bytes through verbatim, and that must not
 * regress.
 *
 * BYTE preservation is NOT decoding preservation, and the difference is why the
 * UTF-16 refusal below exists. Inserting ASCII bytes into a document the browser
 * will decode as UTF-16 changes what the bytes MEAN, however faithfully they are
 * carried.
 */

import { posix } from 'node:path';

/** Characters that must never survive into the emitted attribute value. */
const UNSAFE_HREF = /["'<>\s]/;

/**
 * The href for a bundle-mode entry: the session-free lane, the record's own
 * token, the `surface` namespace, and the entry's OWN directory — so `./x.css`,
 * `assets/app.js` and `../shared/theme.css` resolve exactly where they resolve
 * today, only on the public lane.
 *
 * Returns `null` to mean DO NOT INJECT AT ALL (fail-closed). `entryRelPath` is
 * PACKAGE DATA: the kernel's `normalizeRelativeAssetUrl` rejects only absolute
 * urls, `\`, `%` and empty/`.`/`..` segments — a quote, an angle bracket or a
 * space passes it, and such a directory is creatable on Linux. Interpolating one
 * unescaped would let a malicious package close our `href="…"` and emit its OWN
 * `<base>` FIRST, destroying the precedence property above. Hence per-segment
 * `encodeURIComponent` PLUS a refusal to return anything that still contains a
 * quote, angle bracket or whitespace.
 *
 * (Tightening the kernel's charset is a separate follow-up; this function must
 * hold on its own regardless of what the validator accepts.)
 */
export function buildPackageAppBaseHref(
  pubToken: string,
  entryRelPath: string,
): string | null {
  // `posix.dirname('index.html')` is '.', NOT '' — unmapped it would build
  // `…/surface/./`, which resolves but hides the bug. Map it explicitly.
  const dir = posix.dirname(entryRelPath);
  const dirSegments = dir === '.' || dir === '' ? [] : dir.split('/');
  const segments = [pubToken, 'surface', ...dirSegments];

  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) return null;
    const part = encodeURIComponent(segment);
    if (part.length === 0) return null;
    encoded.push(part);
  }

  const href = `/api/package-app/_pub/${encoded.join('/')}/`;
  // Belt-and-braces: `encodeURIComponent` leaves `'` (and `!~*()`) intact, and a
  // future refactor could drop the encoding entirely. Refuse rather than emit.
  if (UNSAFE_HREF.test(href)) return null;
  return href;
}

/**
 * Insert `<base href="…">` so that it precedes anything the package can declare.
 * The rule is deliberately short, and every branch of it resolves to POSITION 0:
 *
 *  1. start at {@link leadingBomLength} — never ahead of a byte-order mark (a tag
 *     before the BOM strips its meaning and leaves a stray character);
 *  2. from there skip ONLY leading whitespace, COMPLETE comments (`<!--…-->`) and
 *     COMPLETE bogus-comment / PI forms (`<?…>`, terminated at the FIRST `>` —
 *     HTML tokenizes `<?` as a bogus comment, so hunting for `?>` is XML semantics
 *     and over-skips real markup);
 *  3. if — and only if — the construct reached is the STRICT HTML5 doctype
 *     `<!doctype html>`, anchor immediately after its `>`;
 *  4. in EVERY other case (no doctype, a legacy/exotic doctype, an unterminated
 *     comment or PI, an empty document) anchor at the BOM length, i.e. the very
 *     start.
 *
 * POSITION 0 IS THE SECURITY DEFAULT and is always safe — nothing can precede us
 * there. The doctype skip is a COSMETIC concession and nothing more: a leading
 * doctype must keep first position, because a tag inserted ahead of it makes the
 * parser ignore it, which means QUIRKS mode and a visibly broken layout on every
 * bundle surface. Every fallback therefore costs at most standards mode and can
 * never cost precedence — do NOT "improve" one into a cleverer scan.
 *
 * There is deliberately no doctype-END finder. A `>` inside a quoted doctype
 * identifier (`<!DOCTYPE html PUBLIC "a>b">`) terminates the DOCTYPE token, so a
 * quote-skipping end-finder would splice our tag INSIDE the doctype, where it is
 * inert and the package's base wins. The strict pattern matches the whole token
 * including its `>` or does not match at all.
 *
 * TWO GUARDS SIT ON TOP OF THAT SCAN, and neither is optional:
 *
 *  - ANCHOR POST-CONDITION. If the text the scan decided to skip over contains a
 *    `<base` at all, the scan is by definition wrong about this document — it
 *    walked past something that can beat us — so the anchor collapses back to
 *    position 0. This makes precedence independent of the scanner being complete,
 *    which the comment-terminator defect proved it cannot be assumed to be (see
 *    the file header). It costs at most quirks mode on a pathological document;
 *    it can never cost precedence.
 *  - UTF-16 REFUSAL. A `FF FE` / `FE FF` BOM (in the latin1 byte view) means the
 *    document decodes as UTF-16, and there is no safe place to put an ASCII tag:
 *    BEFORE the BOM stops the sniff firing and the whole document decodes as
 *    UTF-8 garbage; AFTER the BOM is WORSE — the ASCII bytes decode as UTF-16
 *    code units, our tag never becomes an element, and the package's own `<base>`
 *    wins SILENTLY, a precedence loss with no symptom. Not injecting is
 *    fail-closed onto the B-baseline: the subresources then fail exactly the way
 *    a self-contained entry's do today. The authoring preflight warns about such
 *    an entry so the author is not left guessing.
 *
 * `baseHref` must come from {@link buildPackageAppBaseHref}; this function does
 * not re-validate it.
 */
export function injectBaseTag(document: string, baseHref: string): string {
  // Fail-closed: no injection at all into a UTF-16 document (see above).
  if (hasUtf16Bom(document)) return document;

  const tag = `<base href="${baseHref}">`;
  const bomLength = leadingBomLength(document);
  const scanned = findDoctypeEnd(document, bomLength) ?? bomLength;
  const anchor = BASE_TAG_START.test(document.slice(bomLength, scanned))
    ? bomLength
    : scanned;
  return document.slice(0, anchor) + tag + document.slice(anchor);
}

/**
 * Any `<base` start-tag prefix, ASCII case-insensitive. Matched as a PREFIX on
 * purpose: the spec reads `target` from the first base element too, so a
 * `<base target>` with no href has to lose to us as well.
 */
const BASE_TAG_START = /<base/i;

/** The strict HTML5 doctype, matched whole. Sticky — anchored, never searched. */
const HTML5_DOCTYPE_AT = /<!doctype\s+html\s*>/iy;

/** HTML whitespace (the "space characters" set). */
const WHITESPACE_AT = /[\t\n\f\r ]*/y;

/**
 * Index just after a LEADING strict-HTML5 doctype's `>`, or `null` when there is
 * none in the leading position. Only whitespace, complete comments and complete
 * bogus-comment/PI forms may stand in front of it; an unterminated one ends the
 * scan with `null`, because everything after it is swallowed by the parser too.
 */
function findDoctypeEnd(document: string, start: number): number | null {
  let index = start;
  for (;;) {
    WHITESPACE_AT.lastIndex = index;
    index += WHITESPACE_AT.exec(document)?.[0].length ?? 0;

    if (document.startsWith('<!--', index)) {
      const end = findCommentEnd(document, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (document.startsWith('<?', index)) {
      const end = document.indexOf('>', index + 2);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    break;
  }

  HTML5_DOCTYPE_AT.lastIndex = index;
  const match = HTML5_DOCTYPE_AT.exec(document);
  return match ? index + match[0].length : null;
}

/**
 * Index just PAST a comment that starts at `index` (the caller has already
 * established `document.startsWith('<!--', index)`), or `null` when the
 * tokenizer would never close it.
 *
 * ALL FOUR CLOSING CONSTRUCTIONS, because knowing only `-->` is exactly the
 * defect this file's header describes — the scan then runs past the real comment
 * end, swallows whatever markup follows (a package's own `<base>` included) and
 * anchors behind a decoy:
 *
 *  - `<!-->`  — abrupt-closing-of-empty-comment (`>` immediately after `<!--`);
 *  - `<!--->` — the same abruption one dash later;
 *  - `-->`    — comment end state;
 *  - `--!>`   — comment end BANG state ("incorrectly-closed-comment": a parse
 *               error, but the comment IS closed).
 *
 * The two searched forms are taken at whichever occurs EARLIER; taking the wrong
 * one is precisely an over-run. An unterminated comment answers `null`, which
 * collapses the anchor to position 0 — always safe, because the parser swallows
 * everything after it too.
 */
function findCommentEnd(document: string, index: number): number | null {
  if (document.startsWith('<!-->', index)) return index + 5;
  if (document.startsWith('<!--->', index)) return index + 6;
  const plain = document.indexOf('-->', index + 4);
  const bang = document.indexOf('--!>', index + 4);
  if (plain < 0 && bang < 0) return null;
  if (bang < 0) return plain + 3;
  if (plain < 0) return bang + 4;
  return plain < bang ? plain + 3 : bang + 4;
}

/**
 * Length of a leading byte-order mark, in CHARACTERS of this string.
 *
 * Two spellings must both be recognised, because this function is a pure string
 * transform used on two different decodings: `U+FEFF` when the caller already
 * decoded text, and the three characters `EF BB BF` when the caller used the
 * byte-preserving `latin1` round-trip the entry lane requires. Missing the second
 * would leave the BOM protection dead on the ONLY path that actually ships.
 */
function leadingBomLength(document: string): number {
  if (document.charCodeAt(0) === 0xfeff) return 1;
  if (
    document.charCodeAt(0) === 0xef &&
    document.charCodeAt(1) === 0xbb &&
    document.charCodeAt(2) === 0xbf
  ) {
    return 3;
  }
  return 0;
}

/**
 * A UTF-16 byte-order mark in the LATIN1 byte view: `FF FE` (LE) or `FE FF` (BE).
 *
 * This is the "do not touch this document at all" signal, not a length. See
 * {@link injectBaseTag} for why both possible insertion points are unsafe — one
 * breaks the encoding sniff, the other loses precedence silently, and silent
 * precedence loss is the single outcome this file exists to prevent.
 *
 * Deliberately NOT folded into {@link leadingBomLength}: that function answers
 * "how many characters do I skip", and a caller that treats a refusal as a skip
 * length would produce exactly the second, worse failure.
 */
function hasUtf16Bom(document: string): boolean {
  const first = document.charCodeAt(0);
  const second = document.charCodeAt(1);
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
}
