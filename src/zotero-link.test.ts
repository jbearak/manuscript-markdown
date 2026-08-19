import { describe, it, expect } from 'bun:test';
import {
  createZoteroLinkPlan,
  normalizeDoi,
  normalizeIsbns,
  normalizePmid,
  extractZoteroKey,
  type ZoteroCatalogItem,
  type ZoteroLinkDecision,
} from './zotero-link';
import { parseBibtex } from './bibtex-parser';

const GROUP = 'http://zotero.org/groups/2295646/items/';

function item(key: string, extra: Partial<ZoteroCatalogItem> = {}): ZoteroCatalogItem {
  return { key, uri: GROUP + key, ...extra };
}

/** The single decision for an entry, by citation key. */
function decisionFor(decisions: readonly ZoteroLinkDecision[], key: string): ZoteroLinkDecision {
  const found = decisions.filter(d => d.entry.key === key);
  expect(found.length).toBe(1);
  return found[0];
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

  it('reads several ISBNs from one field', () => {
    expect(normalizeIsbns('9780306406157, 0306406152')).toEqual(['9780306406157', '0306406152']);
    expect(normalizeIsbns('9780306406157; 0306406152')).toEqual(['9780306406157', '0306406152']);
    expect(normalizeIsbns('9780306406157\n0306406152')).toEqual(['9780306406157', '0306406152']);
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
    const d = decisionFor(plan.decisions, 'Smith2020');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
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
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
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
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
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
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
    expect([...d.evidence].sort()).toEqual(['isbn', 'pmid']);
  });

  it('applies tiers in order — citation key beats a contradicting DOI', () => {
    const bib = '@article{Smith2020,\n  doi = {10.1000/other}\n}\n';
    const plan = createZoteroLinkPlan(bib, [
      item('AAAAAAAA', { citationKey: 'Smith2020' }),
      item('BBBBBBBB', { doi: '10.1000/other' }),
    ]);
    const d = decisionFor(plan.decisions, 'Smith2020');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
    expect(d.target.key).toBe('AAAAAAAA');
  });

  it('never matches on title, author or year', () => {
    const bib = '@article{k1,\n  title = {The Very Same Title},\n  author = {Jane Doe},\n  year = {2020}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { title: 'The Very Same Title' })]);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('unmatched');
    if (d.outcome !== 'unmatched') throw new Error('unreachable');
    expect(d.reason).toBe('no-identifiers');
    expect(plan.changed).toBe(false);
  });

  it('separates "no identifier" from "no match" in the unmatched reason', () => {
    const bib = '@article{k1,\n  doi = {10.1000/nowhere}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('unmatched');
    if (d.outcome !== 'unmatched') throw new Error('unreachable');
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
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('ambiguous');
    if (d.outcome !== 'ambiguous') throw new Error('unreachable');
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
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('ambiguous');
    if (d.outcome !== 'ambiguous') throw new Error('unreachable');
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
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
    expect(d.additions).toEqual([{ name: 'zotero-key', value: 'ABCD1234' }]);
    expect(plan.updatedText).toContain('zotero-uri = {' + uri + '}');
    expect(plan.updatedText).toContain('zotero-key = {ABCD1234}');
  });

  it('accepts a local (never-synced) personal URI', () => {
    const uri = 'http://zotero.org/users/local/aBcD1234/items/ABCD1234';
    const bib = '@article{k1,\n  zotero-uri = {' + uri + '}\n}\n';
    expect(decisionFor(createZoteroLinkPlan(bib, []).decisions, 'k1').outcome).toBe('update');
  });

  it('fills in the URI for a key found in the selected library', () => {
    const bib = '@article{k1,\n  zotero-key = {ABCD1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234')]);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('update');
    if (d.outcome !== 'update') throw new Error('unreachable');
    expect(d.additions).toEqual([{ name: 'zotero-uri', value: GROUP + 'ABCD1234' }]);
  });

  it('reports a key absent from the selected library instead of matching lower', () => {
    const bib = '@article{k1,\n  zotero-key = {ZZZZZZZZ},\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('conflict');
    if (d.outcome !== 'conflict') throw new Error('unreachable');
    expect(d.reason).toBe('unknown-zotero-key');
    expect(plan.changed).toBe(false);
  });

  it('reports a key that disagrees with its URI', () => {
    const bib =
      '@article{k1,\n  zotero-key = {ZZZZZZZZ},\n  zotero-uri = {' + GROUP + 'ABCD1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, []);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('conflict');
    if (d.outcome !== 'conflict') throw new Error('unreachable');
    expect(d.reason).toBe('zotero-key-uri-mismatch');
  });

  it('reports a malformed URI rather than replacing it', () => {
    const bib = '@article{k1,\n  zotero-uri = {not a uri},\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('conflict');
    if (d.outcome !== 'conflict') throw new Error('unreachable');
    expect(d.reason).toBe('invalid-zotero-uri');
    expect(plan.updatedText).toBe(bib);
  });

  it('treats an empty Zotero field as broken, not absent', () => {
    const bib = '@article{k1,\n  zotero-key = {},\n  doi = {10.1000/abc}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234', { doi: '10.1000/abc' })]);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('conflict');
    if (d.outcome !== 'conflict') throw new Error('unreachable');
    expect(d.reason).toBe('invalid-zotero-key');
  });

  it('reports a lowercase item key as malformed', () => {
    const bib = '@article{k1,\n  zotero-key = {abcd1234}\n}\n';
    const plan = createZoteroLinkPlan(bib, [item('ABCD1234')]);
    const d = decisionFor(plan.decisions, 'k1');
    expect(d.outcome).toBe('conflict');
    if (d.outcome !== 'conflict') throw new Error('unreachable');
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
