import { describe, it, expect } from 'bun:test';
import {
  createZoteroLinkPlan,
  normalizeDoi,
  normalizeIsbns,
  normalizePmid,
  extractZoteroKey,
  stripWrappingBraces,
  type ZoteroLinkDecision,
} from './zotero-link';
import { parseBibtex, stripOuterBraces } from './bibtex-parser';
import { GROUP_URI_BASE as GROUP, zoteroItem as item } from './zotero-link.fixtures';


/** The single decision for an entry, by citation key. */
function decisionFor(decisions: readonly ZoteroLinkDecision[], key: string): ZoteroLinkDecision {
  const found = decisions.filter(d => d.entry.key === key);
  expect(found.length).toBe(1);
  return found[0];
}

/** The single decision for an entry, asserted to have `outcome` and narrowed to
 *  it, so a test can read the fields that outcome carries. */
function decisionWithOutcome<O extends ZoteroLinkDecision['outcome']>(
  decisions: readonly ZoteroLinkDecision[],
  key: string,
  outcome: O,
): Extract<ZoteroLinkDecision, { outcome: O }> {
  const decision = decisionFor(decisions, key);
  expect(decision.outcome).toBe(outcome);
  return decision as Extract<ZoteroLinkDecision, { outcome: O }>;
}

describe('normalizeDoi', () => {
  it('lowercases and strips prefixes', () => {
    expect(normalizeDoi('10.1000/ABC')).toBe('10.1000/abc');
    expect(normalizeDoi('doi:10.1000/abc')).toBe('10.1000/abc');
    expect(normalizeDoi('DOI: 10.1000/abc')).toBe('10.1000/abc');
    expect(normalizeDoi('https://doi.org/10.1000/abc')).toBe('10.1000/abc');
    expect(normalizeDoi('http://dx.doi.org/10.1000/abc')).toBe('10.1000/abc');
    expect(normalizeDoi('  10.1000/abc  ')).toBe('10.1000/abc');
  });

  it('rejects values that are not DOI-shaped', () => {
    expect(normalizeDoi(undefined)).toBeUndefined();
    expect(normalizeDoi('')).toBeUndefined();
    expect(normalizeDoi('not a doi')).toBeUndefined();
    expect(normalizeDoi('11.1000/abc')).toBeUndefined();
    expect(normalizeDoi('10.1000')).toBeUndefined();
    expect(normalizeDoi('10.1000/a b')).toBeUndefined();
  });

  it('keeps trailing punctuation, which is legal in a DOI', () => {
    expect(normalizeDoi('10.1000/abc.')).toBe('10.1000/abc.');
  });

  it('undoes BibTeX escaping and outer braces', () => {
    expect(normalizeDoi('{10.1000/a\\_b}')).toBe('10.1000/a_b');
  });
});

describe('normalizeIsbns', () => {
  it('accepts ISBN-10 and ISBN-13 with separators', () => {
    expect(normalizeIsbns('978-0-306-40615-7')).toEqual(['9780306406157']);
    expect(normalizeIsbns('0-306-40615-2')).toEqual(['0306406152']);
    expect(normalizeIsbns('080442957x')).toEqual(['080442957X']);
  });

  it('accepts space-grouped ISBNs', () => {
    // The registration-group separator is written as a space as often as a
    // hyphen, so a space is not an ISBN boundary.
    expect(normalizeIsbns('978 0 306 40615 7')).toEqual(['9780306406157']);
    expect(normalizeIsbns('0 306 40615 2')).toEqual(['0306406152']);
  });

  it('reads several ISBNs from one field', () => {
    expect(normalizeIsbns('9780306406157, 0306406152')).toEqual(['9780306406157', '0306406152']);
    expect(normalizeIsbns('9780306406157; 0306406152')).toEqual(['9780306406157', '0306406152']);
    expect(normalizeIsbns('9780306406157\n0306406152')).toEqual(['9780306406157', '0306406152']);
  });

  it('uses the check digit to choose between possible splits', () => {
    // These tokens divide into correctly-shaped runs several ways; only one
    // division gives ISBNs whose check digits agree, and it is the intended
    // 13/10/10 reading.
    expect(normalizeIsbns('9780 306406 157 0306406 152 0306 406152')).toEqual([
      '9780306406157',
      '0306406152',
      '0306406152',
    ]);
  });

  it('keeps a check-invalid ISBN that shares a field with a valid one', () => {
    // A mistyped ISBN must not lose its match because something valid sits
    // beside it, and the separator between them must not change the answer.
    const typo = '9780306406158';
    expect(normalizeIsbns(typo + ' 0306406152')).toEqual([typo, '0306406152']);
    expect(normalizeIsbns(typo + ', 0306406152')).toEqual([typo, '0306406152']);
    expect(normalizeIsbns('0306406152 ' + typo)).toEqual(['0306406152', typo]);
  });

  it('accepts an unambiguous value whose check digit disagrees', () => {
    // A mistyped ISBN recorded the same way in Zotero and in the .bib still
    // identifies the same work.  There is no split to resolve here, so the
    // checksum is not needed and enforcing it would only lose the match.
    expect(normalizeIsbns('9780306406158')).toEqual(['9780306406158']);
  });

  it('does not hang on a long run of digit tokens', () => {
    // Segmentation without memoization is exponential; this took minutes.
    const input = Array.from({ length: 300 }, () => '1').join(' ') + ' bad';
    const started = performance.now();
    normalizeIsbns(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('does not go quadratic on a long run of non-numeric tokens', () => {
    // The length cutoff must count every character: measured on digits alone,
    // junk tokens never trip it and the fallback scan took seconds.
    const input = Array.from({ length: 2000 }, (_, i) => 'junk' + i).join(' ');
    const started = performance.now();
    expect(normalizeIsbns(input)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('survives a very long token run without overflowing the stack', () => {
    // The fallback selection once recursed per token; fifty thousand tokens
    // is a stack frame per token and overflowed.
    const input = Array.from({ length: 50000 }, (_, i) => 'junk' + i).join(' ');
    expect(normalizeIsbns(input)).toEqual([]);
  });

  it('assembles a grouped ISBN past a separator token in the fallback', () => {
    // `print` blocks a whole-run split, so the fallback selects among the
    // tokens.  The joined check-valid ISBN-13 must win over its ten-character
    // prefix, which is shaped but check-invalid.
    expect(normalizeIsbns('print - 9780306406 157')).toEqual(['9780306406157']);
  });

  it('does not join across the boundary between two fallback values', () => {
    // `1000000000` is a shaped, check-invalid token — a mistyped standalone
    // ISBN to keep.  Joining it with the next token happens to make the
    // check-valid `1000000000030`, and a greedy left-to-right scan took that,
    // fabricating an ISBN and beheading the real `0306406152` behind it.  Two
    // recovered identifiers beat one, so whole-run scoring gets this right.
    expect(normalizeIsbns('print - 1000000000 030 640 615 2')).toEqual([
      '1000000000',
      '0306406152',
    ]);
  });

  it('reads a pair separated by a lone hyphen as unambiguous', () => {
    // A separator hyphen compacts to nothing, so the token boundary can sit
    // on either side of it — two "splits" that normalize identically.  That
    // is one reading, not an ambiguity to refuse.
    expect(normalizeIsbns('9780306406157 - 0306406152')).toEqual([
      '9780306406157',
      '0306406152',
    ]);
    expect(normalizeIsbns('978-0-306-40615-7 - 0-306-40615-2')).toEqual([
      '9780306406157',
      '0306406152',
    ]);
  });

  it('refuses a fallback run whose best readings disagree', () => {
    // `06152` joins leftward into the check-valid `0306406152` or rightward
    // into the check-valid `0615200001`.  Both readings recover one valid
    // identifier; nothing in the text says which was meant, so the run is
    // refused rather than linked to either.
    expect(normalizeIsbns('03064 06152 00001')).toEqual([]);
  });

  it('refuses a run that splits validly in more than one way', () => {
    // Both of these divisions validate every check digit:
    //   9791803811 | 9798694135221    and    9791803811979 | 8694135221
    // Nothing in the text says which was meant, and a wrong pick becomes a
    // wrong zotero-key — Word would cite the wrong source with no visible
    // error.  Refuse the run, as every other ambiguity here is refused.
    expect(normalizeIsbns('979 180 3811 97 9 869 413 522 1')).toEqual([]);
  });

  it('splits two grouped ISBNs written side by side', () => {
    // Taking the longest ISBN-shaped prefix runs the first ISBN's tail into
    // the second's `978`, producing a pair that is in neither.  Only a split
    // that consumes the whole run is right.
    expect(normalizeIsbns('0 306 40615 2 978 0 306 40615 7')).toEqual([
      '0306406152',
      '9780306406157',
    ]);
    expect(normalizeIsbns('978 0 306 40615 7 0 306 40615 2')).toEqual([
      '9780306406157',
      '0306406152',
    ]);
  });

  it('reads an ISBN out of a run that does not divide evenly', () => {
    expect(normalizeIsbns('print 9780306406157')).toEqual(['9780306406157']);
    expect(normalizeIsbns('9780306406157 (hardcover)')).toEqual(['9780306406157']);
  });

  it('reads a space-grouped ISBN alongside a plain one', () => {
    // One field, both conventions at once: the grouped ISBN's leading tokens
    // are not ISBNs on their own, so the longest run has to win.
    expect(normalizeIsbns('978 0 306 40615 7 0306406152')).toEqual([
      '9780306406157',
      '0306406152',
    ]);
    expect(normalizeIsbns('0306406152 978 0 306 40615 7')).toEqual([
      '0306406152',
      '9780306406157',
    ]);
  });

  it('reads a whitespace-separated pair as two ISBNs', () => {
    // Only the digits distinguish this from a single space-grouped ISBN: read
    // whole first, then fall back to the individual tokens.
    expect(normalizeIsbns('9780306406157 0306406152')).toEqual(['9780306406157', '0306406152']);
    expect(normalizeIsbns('978-0-306-40615-7 0-306-40615-2')).toEqual([
      '9780306406157',
      '0306406152',
    ]);
  });

  it('drops values of the wrong length', () => {
    expect(normalizeIsbns('12345')).toEqual([]);
    expect(normalizeIsbns(undefined)).toEqual([]);
  });
});

describe('normalizePmid', () => {
  it('accepts bare digits and a PMID: prefix', () => {
    expect(normalizePmid('12345678')).toBe('12345678');
    expect(normalizePmid('PMID: 12345678')).toBe('12345678');
  });

  it('rejects non-numeric values', () => {
    expect(normalizePmid('PMC12345')).toBeUndefined();
    expect(normalizePmid(undefined)).toBeUndefined();
  });

  it('sees through repeated and escaped brace wrapping', () => {
    // The lexical walk strips a value's delimiters and nothing else, so any
    // number of pairs can remain, and unescaping can expose another.
    expect(normalizePmid('{12345678}')).toBe('12345678');
    expect(normalizePmid('{{12345678}}')).toBe('12345678');
    expect(normalizePmid('{\\{12345678\\}}')).toBe('12345678');
  });
});

describe('field value normalization', () => {
  it('strips only wrapping braces, never inner ones', () => {
    // Inner braces protect capitalization and are part of the value.
    expect(normalizeDoi('{10.1000/{ABC}}')).toBe('10.1000/{abc}');
  });

  it('undoes BibTeX punctuation escapes', () => {
    expect(normalizeDoi('10.1000/a\\_b')).toBe('10.1000/a_b');
  });

  it('unescapes once, not to a fixed point', () => {
    // `\\\_` is a literal backslash followed by an escaped underscore.  One
    // pass gives `\_`; a second would eat the backslash the value owns.
    expect(normalizeDoi('10.1000/a\\\\\\_b')).toBe('10.1000/a\\_b');
  });

  it('strips only pairs that actually wrap the value', () => {
    // `{12345678}}` looks wrapped from both ends, but the leading brace is
    // closed by the first `}` — nothing encloses the whole value, so nothing
    // may be stripped.  A count of leading openers against trailing closers
    // gets this wrong; only pairing them does.
    expect(normalizePmid('{12345678}}')).toBeUndefined();
    expect(normalizePmid('{{12345678}')).toBeUndefined();
    expect(normalizePmid('{{12345678}}')).toBe('12345678');
    expect(normalizePmid('{{{12345678}}}')).toBe('12345678');
  });

  it('credits each leading brace with its own closer, not another\'s', () => {
    // In `{10.1/a}{b}` the value's last `}` belongs to the second group; a
    // last-closer-per-depth shortcut once credited it to the first brace and
    // manufactured `10.1/a}{b` — an identifier present nowhere in the file.
    expect(normalizeDoi('{10.1/a}{b}')).toBeUndefined();
    expect(normalizeDoi('{10.1000/x}{10.2000/y}')).toBeUndefined();
  });

  it('strips wrapping layers separated by whitespace', () => {
    expect(normalizePmid('{ { {12345678} } }')).toBe('12345678');
    expect(normalizeDoi('{ {10.1000/abc} }')).toBe('10.1000/abc');
  });

  it('agrees with stripOuterBraces looped to a fixed point', () => {
    // stripOuterBraces is the independent reference: single-pair semantics,
    // written separately.  Looping it with trims is the whole specification of
    // stripWrappingBraces on balanced input; on unbalanced input the contract
    // is identity, since brace pairing is meaningless there.  This exhaustive
    // differential is what caught this function's last two defects — the
    // suite's own examples, written from the same mental model as the code,
    // did not.
    const reference = (s: string): string => {
      for (;;) {
        s = s.trim();
        const t = stripOuterBraces(s);
        if (t === s) return s;
        s = t;
      }
    };
    const balanced = (s: string): boolean => {
      let depth = 0;
      for (const ch of s) {
        if (ch === '{') depth++;
        else if (ch === '}' && --depth < 0) return false;
      }
      return depth === 0;
    };
    const alphabet = ['{', '}', 'a', ' '];
    const walk = (s: string, left: number): void => {
      const trimmed = s.trim();
      expect(stripWrappingBraces(trimmed)).toBe(balanced(s) ? reference(s) : trimmed);
      if (left === 0) return;
      for (const ch of alphabet) walk(s + ch, left - 1);
    };
    walk('', 8);
  });

  it('strips deep brace nesting without quadratic cost', () => {
    // Calling stripOuterBraces in a loop rescans the whole value per pair;
    // this case took seconds.
    const wrapped = '{'.repeat(50000) + '10.1000/abc' + '}'.repeat(50000);
    const started = performance.now();
    expect(normalizeDoi(wrapped)).toBe('10.1000/abc');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('extractZoteroKey', () => {
  it('reads the key from the URI forms Zotero writes', () => {
    expect(extractZoteroKey('http://zotero.org/users/2417153/items/ABCD1234')).toBe('ABCD1234');
    expect(extractZoteroKey('http://zotero.org/groups/2295646/items/ABCD1234')).toBe('ABCD1234');
    expect(extractZoteroKey('zotero://select/items/ABCD1234')).toBe('ABCD1234');
    expect(extractZoteroKey('http://zotero.org/groups/1/items/lowercase')).toBeUndefined();
  });
});

describe('matching tiers', () => {
  it('links on an exact citation key', () => {
    const bib = '@article{Smith2020,\n  title = {A Study}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { citationKey: 'Smith2020' })]);
    const d = decisionWithOutcome(plan.decisions, 'Smith2020', 'update');
    expect(d.tier).toBe('citation-key');
    expect(d.target.key).toBe('ABCD1234');
    expect(plan.updatedText).toContain('zotero-key = {ABCD1234}');
    expect(plan.updatedText).toContain('zotero-uri = {' + GROUP + 'ABCD1234}');
  });

  it('compares citation keys case-sensitively', () => {
    const bib = '@article{smith2020,\n  title = {A Study}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { citationKey: 'Smith2020' })]);
    expect(decisionFor(plan.decisions, 'smith2020').outcome).toBe('unmatched');
  });

  it('reads a citation key from Zotero Extra when the field is absent', () => {
    const bib = '@article{Smith2020,\n  title = {A Study}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('ABCD1234', { extra: 'Citation Key: Smith2020' }),
    ]);
    expect(decisionFor(plan.decisions, 'Smith2020').outcome).toBe('update');
  });

  it('links on DOI regardless of case', () => {
    const bib = '@article{k1,\n  doi = {10.1000/ABC}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: 'https://doi.org/10.1000/abc' })]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'update');
    expect(d.tier).toBe('doi');
  });

  it('reads a DOI from Zotero Extra for item types with no DOI field', () => {
    const bib = '@book{k1,\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { extra: 'DOI: 10.1000/abc' })]);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('update');
  });

  it('links on ISBN', () => {
    const bib = '@book{k1,\n  isbn = {978-0-306-40615-7}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { isbn: '9780306406157' })]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'update');
    expect(d.tier).toBe('isbn-pmid');
    expect(d.evidence).toEqual(['isbn']);
  });

  it('links on a PMID read from a whole Extra line', () => {
    const bib = '@article{k1,\n  pmid = {12345678}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { extra: 'PMID: 12345678' })]);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('update');
  });

  it('does not read a bare number in Extra as a PMID', () => {
    const bib = '@article{k1,\n  pmid = {12345678}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('ABCD1234', { extra: 'Reviewed 12345678 times' }),
    ]);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('unmatched');
  });

  it('records both identifiers when ISBN and PMID agree on one item', () => {
    const bib = '@book{k1,\n  isbn = {9780306406157},\n  pmid = {12345678}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('ABCD1234', { isbn: '9780306406157', extra: 'PMID: 12345678' }),
    ]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'update');
    expect([...d.evidence].sort()).toEqual(['isbn', 'pmid']);
  });

  it('applies tiers in order — citation key beats a contradicting DOI', () => {
    const bib = '@article{Smith2020,\n  doi = {10.1000/other}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { citationKey: 'Smith2020' }),
      item('BBBBBBBB', { doi: '10.1000/other' }),
    ]);
    const d = decisionWithOutcome(plan.decisions, 'Smith2020', 'update');
    expect(d.target.key).toBe('AAAAAAAA');
  });

  it('never matches on title, author or year', () => {
    const bib = '@article{k1,\n  title = {The Very Same Title},\n  author = {Jane Doe},\n  year = {2020}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { title: 'The Very Same Title' })]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'unmatched');
    expect(d.reason).toBe('no-identifiers');
    expect(plan.changed).toBe(false);
  });

  it('separates "no identifier" from "no match" in the unmatched reason', () => {
    const bib = '@article{k1,\n  doi = {10.1000/nowhere}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'unmatched');
    expect(d.reason).toBe('no-exact-match');
  });
});

describe('ambiguity', () => {
  it('reports two items sharing a DOI and writes nothing', () => {
    const bib = '@article{k1,\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/abc' }),
      item('BBBBBBBB', { doi: '10.1000/ABC' }),
    ]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'ambiguous');
    expect(d.candidates.map(c => c.key)).toEqual(['AAAAAAAA', 'BBBBBBBB']);
    expect(plan.updatedText).toBe(bib);
  });

  it('does not fall through to a lower tier after an ambiguous one', () => {
    const bib = '@article{k1,\n  doi = {10.1000/abc},\n  isbn = {9780306406157}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/abc' }),
      item('BBBBBBBB', { doi: '10.1000/abc' }),
      item('CCCCCCCC', { isbn: '9780306406157' }),
    ]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'ambiguous');
    expect(d.tier).toBe('doi');
  });

  it('reports ISBN and PMID pointing at different items', () => {
    const bib = '@book{k1,\n  isbn = {9780306406157},\n  pmid = {12345678}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { isbn: '9780306406157' }),
      item('BBBBBBBB', { extra: 'PMID: 12345678' }),
    ]);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('ambiguous');
  });
});

describe('existing Zotero identity', () => {
  it('preserves a consistent key/URI pair without consulting the library', () => {
    const bib =
      '@article{k1,\n  zotero-key = {ABCD1234},\n  zotero-uri = {' + GROUP + 'ABCD1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('preserve');
    expect(plan.changed).toBe(false);
  });

  it('preserves a link into a library other than the selected one', () => {
    const other = 'http://zotero.org/groups/999/items/ZZZZZZZZ';
    const bib = '@article{k1,\n  zotero-key = {ZZZZZZZZ},\n  zotero-uri = {' + other + '}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { citationKey: 'k1' })]);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('preserve');
  });

  it('adds the key a URI already contains, leaving the URI untouched', () => {
    const uri = 'http://zotero.org/users/2417153/items/ABCD1234';
    const bib = '@article{k1,\n  zotero-uri = {' + uri + '}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'update');
    expect(d.additions).toEqual([{ name: 'zotero-key', value: 'ABCD1234' }]);
    expect(plan.updatedText).toContain('zotero-uri = {' + uri + '}');
    expect(plan.updatedText).toContain('zotero-key = {ABCD1234}');
  });

  it('accepts a local (never-synced) personal URI', () => {
    const uri = 'http://zotero.org/users/local/aBcD1234/items/ABCD1234';
    const bib = '@article{k1,\n  zotero-uri = {' + uri + '}\n}\n';
    expect(decisionFor(createZoteroLinkPlan(bib, []).decisions, 'k1').outcome).toBe('update');
  });

  it('rejects the embedded-metadata placeholder this extension writes', () => {
    // md-to-docx-citations emits `users/local/embedded/items/<key>` for entries
    // with no Zotero identity, so Word's uris array is well-formed.  Reading it
    // back as identity would launder our own filler into a Zotero link.
    const uri = 'http://zotero.org/users/local/embedded/items/ABCD1234';
    const bib = '@article{k1,\n  zotero-uri = {' + uri + '}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('invalid-zotero-uri');
    expect(plan.updatedText).toBe(bib);
  });

  it('rejects the /users/0/ placeholder, which names no library', () => {
    // `users/0` is the Local API's "whoever is logged in" stand-in, not an id.
    const uri = 'http://zotero.org/users/0/items/ABCD1234';
    const bib = '@article{k1,\n  zotero-uri = {' + uri + '}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('invalid-zotero-uri');
  });

  it('fills in the URI for a key found in the selected library', () => {
    const bib = '@article{k1,\n  zotero-key = {ABCD1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234')]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'update');
    expect(d.additions).toEqual([{ name: 'zotero-uri', value: GROUP + 'ABCD1234' }]);
  });

  it('reports a key absent from the selected library instead of matching lower', () => {
    const bib = '@article{k1,\n  zotero-key = {ZZZZZZZZ},\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'conflict');
    expect(d.reason).toBe('unknown-zotero-key');
    expect(plan.changed).toBe(false);
  });

  it('reports a key that disagrees with its URI', () => {
    const bib =
      '@article{k1,\n  zotero-key = {ZZZZZZZZ},\n  zotero-uri = {' + GROUP + 'ABCD1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'conflict');
    expect(d.reason).toBe('zotero-key-uri-mismatch');
  });

  it('reports a malformed URI rather than replacing it', () => {
    const bib = '@article{k1,\n  zotero-uri = {not a uri},\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'conflict');
    expect(d.reason).toBe('invalid-zotero-uri');
    expect(plan.updatedText).toBe(bib);
  });

  it('treats an empty Zotero field as broken, not absent', () => {
    const bib = '@article{k1,\n  zotero-key = {},\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'conflict');
    expect(d.reason).toBe('invalid-zotero-key');
  });

  it('reports a lowercase item key as malformed', () => {
    const bib = '@article{k1,\n  zotero-key = {abcd1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234')]);
    const d = decisionWithOutcome(plan.decisions, 'k1', 'conflict');
    expect(d.reason).toBe('invalid-zotero-key');
  });

  it('reports an item key that is ambiguous within the library', () => {
    const bib = '@article{k1,\n  zotero-key = {ABCD1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      { key: 'ABCD1234', uri: GROUP + 'ABCD1234' },
      { key: 'ABCD1234', uri: 'http://zotero.org/groups/999/items/ABCD1234' },
    ]);
    expect(decisionFor(plan.decisions, 'k1').outcome).toBe('ambiguous');
  });
});

describe('entries whose own text is ambiguous', () => {
  const matching = [item('ABCD1234', { doi: '10.1000/abc' })];

  it('refuses an entry with a % outside every field value', () => {
    // Classic bibtex ignores `%` inside an entry; biber and JabRef end the
    // line at it.  The bytes after it are live text to one tool and a comment
    // to another, and this command writes into them.
    const bib = '@article{k1,\n  doi = {10.1000/abc} % trailing note\n}\n';
    const d = decisionWithOutcome(createZoteroLinkPlan(bib, matching).decisions, 'k1', 'conflict');
    expect(d.reason).toBe('ambiguous-comment');
    expect(createZoteroLinkPlan(bib, matching).updatedText).toBe(bib);
  });

  it('does not link on an identifier that is commented out', () => {
    const bib = '@article{k1,\n  title = {T},\n%  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, matching);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('ambiguous-comment');
    expect(plan.updatedText).toBe(bib);
  });

  it('treats a percent inside a field value as data, not a comment', () => {
    for (const note of ['{50% off}', '"50% off"', '{50\\% off}']) {
      const bib = '@article{k1,\n  note = ' + note + ',\n  doi = {10.1000/abc}\n}\n';
      expect(createZoteroLinkPlan(bib, matching).summary.updates).toBe(1);
    }
  });

  it('refuses a concatenated field value', () => {
    // `parseBibtex` reads only the first atom, so `"10.1000/abc" # "def"` looks
    // like a match for 10.1000/abc when the real DOI is 10.1000/abcdef.
    const bib = '@article{k1,\n  doi = "10.1000/abc" # "def"\n}\n';
    const plan = createZoteroLinkPlan(bib, matching);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('concatenated-field');
    expect(plan.updatedText).toBe(bib);
  });

  it('treats a hash inside a field value as data', () => {
    const bib = '@article{k1,\n  note = {issue #3},\n  doi = {10.1000/abc}\n}\n';
    expect(createZoteroLinkPlan(bib, matching).summary.updates).toBe(1);
  });

  it('refuses an identifier field written twice with different values', () => {
    // The parser keeps the last occurrence, so without this the entry would
    // link on whichever value came last.
    const bib = '@article{k1,\n  doi = {10.1000/first},\n  doi = {10.1000/second}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/first' }),
      item('BBBBBBBB', { doi: '10.1000/second' }),
    ]);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('duplicate-field');
    expect(plan.updatedText).toBe(bib);
  });

  it('allows a repeated identifier field whose values agree', () => {
    const bib = '@article{k1,\n  doi = {10.1000/abc},\n  doi = {10.1000/abc}\n}\n';
    expect(createZoteroLinkPlan(bib, matching).summary.updates).toBe(1);
  });

  it('allows a repeated field that decides nothing', () => {
    const bib = '@article{k1,\n  note = {a},\n  note = {b},\n  doi = {10.1000/abc}\n}\n';
    expect(createZoteroLinkPlan(bib, matching).summary.updates).toBe(1);
  });

  it('refuses identifier fields repeated on one line with different values', () => {
    // Nothing about the disagreement depends on the fields being on separate
    // lines; a line-anchored check would miss this one.
    const bib = '@article{k1, doi = {10.1000/first}, doi = {10.1000/second}}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/first' }),
      item('BBBBBBBB', { doi: '10.1000/second' }),
    ]);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('duplicate-field');
    expect(plan.updatedText).toBe(bib);
  });

  it('does not count field-shaped text inside a value as a repeat', () => {
    // The `doi = {...}` here is prose inside a note, not a second field.
    const bib =
      '@article{k1,\n  note = {see doi = {10.1000/other} elsewhere},\n  doi = {10.1000/abc}\n}\n';
    expect(createZoteroLinkPlan(bib, matching).summary.updates).toBe(1);
  });

  it('refuses an identifier written as a string macro reference', () => {
    // `zotero-key = ABCD1234` names a macro defined elsewhere in the file.  Its
    // spelling is not its value, so matching the token as written would link
    // the entry to whatever item happens to share that name.
    const bib = '@string{ABCD1234 = "ZZZZZZZZ"}\n@article{k1,\n  zotero-key = ABCD1234\n}\n';
    const plan = createZoteroLinkPlan(bib, matching);
    const decision = decisionWithOutcome(plan.decisions, 'k1', 'conflict');
    expect(decision.reason).toBe('symbolic-field');
    expect(decision.detail).toBe('zotero-key');
    expect(plan.updatedText).toBe(bib);
  });

  it('does not read a field name out of the middle of a longer one', () => {
    // All of these are field names BibTeX reads whole — its names allow far
    // more than identifier characters.  Starting a name at the embedded `d`
    // would report a `doi` the entry does not have.
    for (const name of ['_doi', '1doi', 'xdoi', ':doi', '+doi', '.doi', '/doi', '@doi', '-doi']) {
      const bib = '@article{k1, ' + name + ' = {10.1000/abc}}\n';
      const plan = createZoteroLinkPlan(bib, matching);
      expect(decisionWithOutcome(plan.decisions, 'k1', 'unmatched').reason).toBe('no-identifiers');
      expect(plan.updatedText).toBe(bib);
    }
  });

  it('does not match on an identifier that is inside another value', () => {
    // `{"}` protects a literal quote, so the whole run is one note.  The field
    // regex, which does not track that, recovers a `doi` the entry does not
    // have at its own level; matching must follow the walk, not the regex.
    const bib = '@article{k1,\n  note = "a {"} doi = {10.1000/abc} b"\n}\n';
    const plan = createZoteroLinkPlan(bib, matching);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'unmatched').reason).toBe('no-identifiers');
    expect(plan.updatedText).toBe(bib);
  });

  it('refuses an entry whose escaped braces cross', () => {
    // `\}` … `\{` closes in one place for biber and another for classic
    // bibtex: one note to the first, a note plus a DOI field to the second.
    const bib = '@article{k1,\n  note = {x \\} doi = {10.1000/abc}, \\{ y}\n}\n';
    const plan = createZoteroLinkPlan(bib, [...matching, item('EEEEEEEE', { citationKey: 'k1' })]);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('entry-not-editable');
    expect(plan.updatedText).toBe(bib);
  });

  it('refuses a quoted value holding an unmatched closing brace', () => {
    // BibTeX itself reports unbalanced braces here, so the value has no end
    // every reader agrees on.
    const bib = '@article{k1, note = "a } b"}\n';
    const plan = createZoteroLinkPlan(bib, [item('EEEEEEEE', { citationKey: 'k1' })]);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('entry-not-editable');
    expect(plan.updatedText).toBe(bib);
  });

  it('reports ambiguity when one ISBN field names two different items', () => {
    const bib = '@article{k1,\n  isbn = {978 0 306 40615 7 0306406152}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { isbn: '9780306406157' }),
      item('BBBBBBBB', { isbn: '0306406152' }),
    ]);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'ambiguous').candidates.length).toBe(2);
    expect(plan.updatedText).toBe(bib);
  });

  it('treats a bare number as a literal, not a macro', () => {
    const bib = '@article{k1,\n  year = 2020,\n  pmid = 12345678,\n  doi = {10.1000/abc}\n}\n';
    expect(createZoteroLinkPlan(bib, matching).summary.updates).toBe(1);
  });
});

describe('entries that cannot be edited by offset', () => {
  it('refuses a duplicated citation key', () => {
    const bib =
      '@article{dup,\n  doi = {10.1000/a}\n}\n\n@article{dup,\n  doi = {10.1000/b}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/a' }),
      item('BBBBBBBB', { doi: '10.1000/b' }),
    ]);
    expect(plan.decisions.length).toBe(2);
    for (const d of plan.decisions) {
      expect(d.outcome).toBe('conflict');
      if (d.outcome !== 'conflict') throw new Error('unreachable');
      expect(d.reason).toBe('duplicate-bibtex-key');
    }
    expect(plan.updatedText).toBe(bib);
  });

  it('refuses an entry whose value holds an escaped closing brace', () => {
    // BibTeX implementations disagree about whether `\}` is structural, so the
    // entry's range ends in a different place depending on who is reading.
    // Splicing into it put the new fields inside the note value.  The
    // following entry is unaffected: only the ambiguous one is declined.
    const bib =
      '@article{k1,\n  doi = {10.1000/a},\n  note = {literal \\} brace},\n  title = {T}\n}\n' +
      '@article{k2,\n  doi = {10.1000/b}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/a' }),
      item('BBBBBBBB', { doi: '10.1000/b' }),
    ]);
    expect(decisionWithOutcome(plan.decisions, 'k1', 'conflict').reason).toBe('entry-not-editable');
    expect(plan.updatedText).toContain('note = {literal \\} brace},\n  title = {T}\n}');
    expect(decisionWithOutcome(plan.decisions, 'k2', 'update').target.key).toBe('BBBBBBBB');
  });

  it('links an entry whose escaped braces balance', () => {
    const bib = '@article{k1,\n  doi = {10.1000/a},\n  title = {A \\{b\\} c}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('AAAAAAAA', { doi: '10.1000/a' })]);
    expect(plan.summary.updates).toBe(1);
    expect(plan.updatedText).toContain('title = {A \\{b\\} c},');
  });

  it('refuses the whole file when the scanner lost its place', () => {
    const bib = '@article{broken,\n  title = {Unclosed\n\n@article{k1,\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    expect(plan.blocked).toBe('unparsable-bibliography');
    expect(plan.decisions).toEqual([]);
    expect(plan.updatedText).toBe(bib);
    expect(plan.changed).toBe(false);
  });
});

describe('rewriting', () => {
  it('leaves every other byte of the file alone', () => {
    const bib =
      '% a comment\n' +
      '@string{jrn = "Journal"}\n\n' +
      '@article{first,\n  title = {Untouched},\n  note = {no identifiers}\n}\n\n' +
      '@article{second,\n  doi = {10.1000/abc}\n}\n\n' +
      '@book{third,\n  title = {Also untouched}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    expect(plan.summary.updates).toBe(1);
    // Everything before and after the edited entry survives verbatim.
    const [before, after] = bib.split('@article{second,');
    expect(plan.updatedText.startsWith(before)).toBe(true);
    expect(plan.updatedText.endsWith(after.slice(after.indexOf('\n\n@book')))).toBe(true);
  });

  it('is idempotent — a second run over its own output changes nothing', () => {
    const bib = '@article{k1,\n  doi = {10.1000/abc}\n}\n';
    const items = [item('ABCD1234', { doi: '10.1000/abc' })];
    const first = createZoteroLinkPlan(bib, items);
    expect(first.changed).toBe(true);
    const second = createZoteroLinkPlan(first.updatedText, items);
    expect(second.changed).toBe(false);
    expect(second.updatedText).toBe(first.updatedText);
    expect(second.summary.preserved).toBe(1);
  });

  it('matches the indentation the entry already uses', () => {
    const bib = '@article{k1,\n    doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    expect(plan.updatedText).toContain('\n    zotero-key = {ABCD1234},');
  });

  it('keeps CRLF entries on CRLF', () => {
    const bib = '@article{k1,\r\n  doi = {10.1000/abc}\r\n}\r\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    expect(plan.updatedText).toContain('\r\n  zotero-key = {ABCD1234},\r\n');
    expect(plan.updatedText.includes('\n  zotero-key')).toBe(true);
    // No bare LF was introduced anywhere.
    expect(/[^\r]\n/.test(plan.updatedText)).toBe(false);
  });

  it('takes the document EOL for a single-line entry', () => {
    const bib = '@article{a,\r\n  title = {Multi}\r\n}\r\n\r\n@book{k1, doi = {10.1000/abc}}\r\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    expect(/[^\r]\n/.test(plan.updatedText)).toBe(false);
  });

  it('edits several entries without disturbing each other\'s offsets', () => {
    const bib =
      '@article{a,\n  doi = {10.1000/a}\n}\n\n' +
      '@article{b,\n  title = {No identifiers}\n}\n\n' +
      '@article{c,\n  doi = {10.1000/c}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { doi: '10.1000/a' }),
      item('CCCCCCCC', { doi: '10.1000/c' }),
    ]);
    expect(plan.summary.updates).toBe(2);
    const reparsed = parseBibtex(plan.updatedText);
    expect(reparsed.get('a')?.zoteroKey).toBe('AAAAAAAA');
    expect(reparsed.get('b')?.zoteroKey).toBeUndefined();
    expect(reparsed.get('c')?.zoteroKey).toBe('CCCCCCCC');
  });

  it('produces entries the parser reads back with both Zotero fields agreeing', () => {
    const bib = '@article{k1,\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const entry = parseBibtex(plan.updatedText).get('k1')!;
    expect(entry.zoteroKey).toBe('ABCD1234');
    expect(entry.zoteroUri).toBe(GROUP + 'ABCD1234');
    expect(entry.fields.get('zotero-key')).toBe('ABCD1234');
    expect(entry.fields.get('zotero-uri')).toBe(GROUP + 'ABCD1234');
  });

  it('handles a paren-delimited entry', () => {
    const bib = '@article(k1,\n  doi = {10.1000/abc}\n)\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    expect(plan.updatedText).toContain('zotero-key = {ABCD1234}');
    expect(plan.updatedText.trimEnd().endsWith(')')).toBe(true);
    expect(parseBibtex(plan.updatedText).get('k1')?.zoteroKey).toBe('ABCD1234');
  });

  it('does not mutate the parsed entries it was given', () => {
    const bib = '@article{k1,\n  doi = {10.1000/abc}\n}\n';
    createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const fresh = parseBibtex(bib).get('k1')!;
    expect(fresh.fields.has('zotero-key')).toBe(false);
  });
});

describe('summary', () => {
  it('counts one decision per entry, by outcome and tier', () => {
    const bib =
      '@article{ck,\n  title = {By citation key}\n}\n\n' +
      '@article{doi1,\n  doi = {10.1000/abc}\n}\n\n' +
      '@article{linked,\n  zotero-key = {LLLLLLLL},\n  zotero-uri = {' + GROUP + 'LLLLLLLL}\n}\n\n' +
      '@article{amb,\n  doi = {10.1000/dup}\n}\n\n' +
      '@article{bad,\n  zotero-uri = {nope}\n}\n\n' +
      '@article{none,\n  title = {Nothing}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { citationKey: 'ck' }),
      item('BBBBBBBB', { doi: '10.1000/abc' }),
      item('CCCCCCCC', { doi: '10.1000/dup' }),
      item('DDDDDDDD', { doi: '10.1000/dup' }),
    ]);
    expect(plan.summary).toEqual({
      totalEntries: 6,
      updates: 2,
      preserved: 1,
      ambiguous: 1,
      conflicts: 1,
      unmatched: 1,
      updatesByTier: { 'existing': 0, 'citation-key': 1, 'doi': 1, 'isbn-pmid': 0 },
    });
  });

  it('reports an empty bibliography without blocking it', () => {
    const plan = createZoteroLinkPlan('', [item('ABCD1234')]);
    expect(plan.blocked).toBeUndefined();
    expect(plan.summary.totalEntries).toBe(0);
    expect(plan.changed).toBe(false);
  });
});
