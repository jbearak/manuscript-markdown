import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import {
  ZOTERO_KEY_RE,
  generateBibTeX,
  citationPandocKeys,
  escapeBibtex,
  itemIdentifier,
  buildCitationKeyMap,
} from './converter';
import type { ZoteroCitation, CitationMetadata } from './converter';

/**
 * Feature: zotero-citation-roundtrip
 * Property 1: URI key extraction across all formats
 *
 * For any valid 8-char [A-Z0-9] key and any of the three Zotero URI formats,
 * the regex ZOTERO_KEY_RE extracts exactly that key.
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5**
 */

const ALPHANUM_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Generator: single char from [A-Z0-9]
const keyCharArb = fc.constantFrom(...ALPHANUM_UPPER.split(''));

// Generator: 8-char alphanumeric key [A-Z0-9]
const zoteroKeyArb = fc.tuple(
  keyCharArb, keyCharArb, keyCharArb, keyCharArb,
  keyCharArb, keyCharArb, keyCharArb, keyCharArb,
).map(chars => chars.join(''));

// Generator: local ID (short alphanumeric string)
const localIdArb = fc.string({ minLength: 4, maxLength: 12 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s));

// Generator: numeric ID
const numericIdArb = fc.integer({ min: 1, max: 99999999 });

// Generator: one of the three URI formats paired with a key
const zoteroUriArb = fc.tuple(
  zoteroKeyArb,
  fc.oneof(
    localIdArb.map(id => `http://zotero.org/users/local/${id}`),
    numericIdArb.map(id => `http://zotero.org/users/${id}`),
    numericIdArb.map(id => `http://zotero.org/groups/${id}`),
  ),
).map(([key, prefix]) => ({ key, uri: `${prefix}/items/${key}` }));

describe('Feature: zotero-citation-roundtrip, Property 1: URI key extraction across all formats', () => {
  it('extracts the correct key from any valid Zotero URI format', () => {
    fc.assert(
      fc.property(zoteroUriArb, ({ key, uri }) => {
        const match = uri.match(ZOTERO_KEY_RE);
        expect(match).not.toBeNull();
        expect(match![1]).toBe(key);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: zotero-citation-roundtrip
 * Property 2: BibTeX zotero fields biconditional
 *
 * For any CitationMetadata, the BibTeX output contains `zotero-key = {VALUE}`
 * iff `meta.zoteroKey` is set, and `zotero-uri = {VALUE}` iff `meta.zoteroUri`
 * is set. When present, the values match the input exactly.
 *
 * **Validates: Requirements 1.6, 2.1, 2.2, 2.3**
 */

// Generator: Zotero URI with embedded key
const zoteroUriGen = fc.tuple(
  zoteroKeyArb,
  fc.oneof(
    fc.constant('http://zotero.org/users/local/abc123'),
    fc.integer({ min: 1, max: 9999999 }).map(id => `http://zotero.org/users/${id}`),
    fc.integer({ min: 1, max: 9999999 }).map(id => `http://zotero.org/groups/${id}`),
  ),
).map(([key, prefix]) => `${prefix}/items/${key}`);

// Generator: CitationMetadata with optional zoteroKey and zoteroUri
const citationMetaArb = fc.record({
  title: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
  year: fc.integer({ min: 1900, max: 2099 }).map(String),
  hasZoteroKey: fc.boolean(),
  hasZoteroUri: fc.boolean(),
  zoteroKey: zoteroKeyArb,
  zoteroUri: zoteroUriGen,
}).map(({ title, year, hasZoteroKey, hasZoteroUri, zoteroKey, zoteroUri }) => {
  const meta: CitationMetadata = {
    authors: [],
    title,
    year,
    journal: '',
    volume: '',
    pages: '',
    doi: '',
    type: 'article-journal',
    fullItemData: {},
    ...(hasZoteroKey ? { zoteroKey } : {}),
    ...(hasZoteroUri ? { zoteroUri } : {}),
  };
  return { meta, hasZoteroKey, hasZoteroUri, zoteroKey, zoteroUri };
});

describe('Feature: zotero-citation-roundtrip, Property 2: BibTeX zotero fields biconditional', () => {
  it('BibTeX output contains zotero-key iff meta.zoteroKey is set, and zotero-uri iff meta.zoteroUri is set, with matching values', () => {
    fc.assert(
      fc.property(citationMetaArb, ({ meta, hasZoteroKey, hasZoteroUri, zoteroKey, zoteroUri }) => {
        const id = itemIdentifier(meta);
        const citKey = 'testkey';
        const keyMap = new Map([[id, citKey]]);
        const citation: ZoteroCitation = { plainCitation: '', items: [meta] };

        const bibtex = generateBibTeX([citation], keyMap);

        // zotero-key biconditional
        const hasKeyField = bibtex.includes('zotero-key = {');
        expect(hasKeyField).toBe(hasZoteroKey);
        if (hasZoteroKey) {
          expect(bibtex).toContain(`zotero-key = {${zoteroKey}}`);
        }

        // zotero-uri biconditional — value is now escapeBibtex'd
        const hasUriField = bibtex.includes('zotero-uri = {');
        expect(hasUriField).toBe(hasZoteroUri);
        if (hasZoteroUri) {
          expect(bibtex).toContain(`zotero-uri = {${escapeBibtex(zoteroUri)}}`);
        }
      }),
      { numRuns: 200 },
    );
  });
});


/**
 * Feature: zotero-citation-roundtrip
 * Property 3: Locator formatting in Pandoc keys
 *
 * For any ZoteroCitation with items that have keys in the key map,
 * citationPandocKeys() returns a key ending with `, p. <locator>` iff
 * that item's locator field is a non-empty string (after sanitization).
 * Items without a locator produce a bare key with no suffix.
 *
 * **Validates: Requirements 3.1, 3.2**
 */

// Generator: unique title (prefix + index ensures uniqueness across items)
const titleArb = (idx: number) =>
  fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => s.trim().length > 0)
    .map(s => `title${idx}_${s}`);

// Generator: year string
const yearArb = fc.integer({ min: 1900, max: 2099 }).map(String);

// Generator: optional non-empty locator (page-like strings)
const locatorArb = fc.oneof(
  fc.constant(undefined),
  fc.array(
    fc.constantFrom(...'0123456789ivxlc-'.split('')),
    { minLength: 1, maxLength: 10 },
  ).map(chars => chars.join('')).filter(s => s.trim().length > 0),
);

// Generator: a single CitationMetadata item with a guaranteed-unique title
const citationItemArb = (idx: number) =>
  fc.tuple(titleArb(idx), yearArb, locatorArb).map(([title, year, locator]) => {
    const meta: CitationMetadata = {
      authors: [],
      title,
      year,
      journal: '',
      volume: '',
      pages: '',
      doi: '',
      type: 'article-journal',
      fullItemData: {},
      ...(locator !== undefined ? { locator } : {}),
    };
    return meta;
  });

// Generator: ZoteroCitation with 1–5 items, each with a unique title
const zoteroCitationArb = fc.integer({ min: 1, max: 5 }).chain(n =>
  fc.tuple(...Array.from({ length: n }, (_, i) => citationItemArb(i))).map(items => {
    const citation: ZoteroCitation = { plainCitation: '', items };
    const keyMap = buildCitationKeyMap([citation]);
    return { citation, keyMap, items };
  }),
);

describe('Feature: zotero-citation-roundtrip, Property 3: Locator formatting in Pandoc keys', () => {
  it('returns key with `, p. <locator>` suffix iff locator is a non-empty string', () => {
    fc.assert(
      fc.property(zoteroCitationArb, ({ citation, keyMap, items }) => {
        const results = citationPandocKeys(citation, keyMap);

        // Every item has a key in the map, so result length must match
        expect(results.length).toBe(items.length);

        for (let i = 0; i < items.length; i++) {
          const meta = items[i];
          const result = results[i];
          const baseKey = keyMap.get(itemIdentifier(meta))!;

          if (meta.locator && meta.locator.trim().length > 0) {
            // Locator is sanitized (Pandoc-sensitive chars stripped)
            const sanitized = meta.locator.replace(/[\[\];@]/g, '');
            if (sanitized) {
              expect(result).toBe(`${baseKey}, p. ${sanitized}`);
            } else {
              expect(result).toBe(baseKey);
            }
          } else {
            // Must be the bare key with no suffix
            expect(result).toBe(baseKey);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});


/**
 * Feature: zotero-citation-roundtrip
 * Property 4: Citation grouping preserves all items
 *
 * For any ZoteroCitation containing N items (all with entries in the key map),
 * citationPandocKeys() returns exactly N strings — one per item, in order.
 *
 * **Validates: Requirements 4.1, 4.2**
 */

describe('Feature: zotero-citation-roundtrip, Property 4: Citation grouping preserves all items', () => {
  it('returns exactly one entry per citation item, preserving count and order', () => {
    fc.assert(
      fc.property(zoteroCitationArb, ({ citation, keyMap, items }) => {
        const results = citationPandocKeys(citation, keyMap);

        // Result length must equal item count
        expect(results.length).toBe(items.length);

        // Each result must start with the expected base key (preserving order)
        for (let i = 0; i < items.length; i++) {
          const baseKey = keyMap.get(itemIdentifier(items[i]))!;
          expect(results[i].startsWith(baseKey)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});


/**
 * Feature: zotero-citation-roundtrip
 * Property 5: BibTeX special character escaping
 *
 * For any input string, the output of escapeBibtex() contains no unescaped
 * occurrences of the BibTeX special characters & % $ # _ { } ~ ^ \.
 * Every special character in the output is preceded by a backslash.
 *
 * **Validates: Requirements 2.4**
 */

const BIBTEX_SPECIALS = new Set('&%$#_{}~^\\'.split(''));

/**
 * Scan output character-by-character. A backslash followed by any character
 * is treated as an escape pair (skip both). Any special character found
 * outside an escape pair is unescaped.
 */
function hasUnescapedSpecial(output: string): boolean {
  let i = 0;
  while (i < output.length) {
    if (output[i] === '\\') {
      // This backslash is an escape prefix — skip it and the next char
      i += 2;
      continue;
    }
    if (BIBTEX_SPECIALS.has(output[i])) {
      return true; // Found an unescaped special
    }
    i++;
  }
  return false;
}

// Generator: strings that mix special and non-special characters
const bibtexInputArb = fc.oneof(
  // Mixed strings: normal chars interspersed with specials
  fc.string({ minLength: 0, maxLength: 50 }),
  // Strings composed purely of special characters
  fc.array(
    fc.constantFrom(...'&%$#_{}~^\\'.split('')),
    { minLength: 1, maxLength: 50 },
  ).map(chars => chars.join('')),
  // Mixed: random string with injected specials
  fc.tuple(
    fc.string({ minLength: 0, maxLength: 25 }),
    fc.array(
      fc.constantFrom(...'&%$#_{}~^\\'.split('')),
      { minLength: 1, maxLength: 25 },
    ),
  ).map(([base, specials]) => {
    // Interleave base chars and specials
    let result = '';
    const maxLen = Math.max(base.length, specials.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < base.length) result += base[i];
      if (i < specials.length) result += specials[i];
    }
    return result;
  }),
);

describe('Feature: zotero-citation-roundtrip, Property 5: BibTeX special character escaping', () => {
  it('escapeBibtex output contains no unescaped BibTeX special characters', () => {
    fc.assert(
      fc.property(bibtexInputArb, (input) => {
        const output = escapeBibtex(input);

        // No unescaped special character should remain in the output
        expect(hasUnescapedSpecial(output)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});


/**
 * Feature: zotero-citation-roundtrip
 * Property 6: Locator sanitization strips Pandoc-sensitive characters
 *
 * Verifies that citationPandocKeys() strips [ ] ; @ from locators
 * so they cannot break Pandoc citation syntax.
 *
 * **Validates: Locator safety**
 */

describe('Feature: zotero-citation-roundtrip, Property 6: Locator sanitization', () => {
  it('strips Pandoc-sensitive characters from locators', () => {
    const meta: CitationMetadata = {
      authors: [],
      title: 'Test',
      year: '2020',
      journal: '',
      volume: '',
      pages: '',
      doi: '',
      type: 'article-journal',
      fullItemData: {},
      locator: '20];@next[part',
    };
    const citation: ZoteroCitation = { plainCitation: '', items: [meta] };
    const keyMap = buildCitationKeyMap([citation]);
    const baseKey = keyMap.get(itemIdentifier(meta))!;

    const results = citationPandocKeys(citation, keyMap);
    expect(results).toEqual([`${baseKey}, p. 20nextpart`]);
  });

  it('returns bare key when locator consists entirely of Pandoc-sensitive chars', () => {
    const meta: CitationMetadata = {
      authors: [],
      title: 'Test2',
      year: '2021',
      journal: '',
      volume: '',
      pages: '',
      doi: '',
      type: 'article-journal',
      fullItemData: {},
      locator: '[];@',
    };
    const citation: ZoteroCitation = { plainCitation: '', items: [meta] };
    const keyMap = buildCitationKeyMap([citation]);
    const baseKey = keyMap.get(itemIdentifier(meta))!;

    const results = citationPandocKeys(citation, keyMap);
    expect(results).toEqual([baseKey]);
  });
});
