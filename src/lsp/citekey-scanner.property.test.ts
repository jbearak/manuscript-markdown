import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { scanCitationUsages, findUsagesForKey, findUncitableBibKeys, getCompletionContextAtOffset } from './citekey-language';
import { parseBibtexWithRaw } from '../bibtex-parser';
import { parseMd } from '../md-to-docx';

describe('Property 2: Targeted Key Scanner Equivalence', () => {
	// Generator for citekeys of letters, digits, _, : and -
	const citekeyGen = fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[A-Za-z0-9_:-]+$/.test(s));

	// Generator for citation segments
	const citationSegmentGen = fc.array(citekeyGen, { minLength: 1, maxLength: 5 }).map(
		keys => `[@${keys.join('; @')}]`
	);

	const textGen = fc.array(
		fc.oneof(
			citationSegmentGen,
			fc.string({ maxLength: 50 })
		),
		{ minLength: 1, maxLength: 10 }
	).map(parts => parts.join(' '));

	test('findUsagesForKey matches scanCitationUsages filter for any key', () => {
		fc.assert(
			fc.property(textGen, citekeyGen, (text, key) => {
				const expected = scanCitationUsages(text)
					.filter(u => u.key === key)
					.map(u => ({ keyStart: u.keyStart, keyEnd: u.keyEnd }));
				const actual = findUsagesForKey(text, key)
					.map(u => ({ keyStart: u.keyStart, keyEnd: u.keyEnd }));
				expect(actual).toEqual(expected);
			}),
			{ numRuns: 200 }
		);
	});

	test('finds a lookup key with characters special in a regex only where it is cited', () => {
		const text = '[@aab; @axb; @a-b]';
		expect(findUsagesForKey(text, 'a+b')).toEqual([]);
		expect(findUsagesForKey(text, 'a.b')).toEqual([]);
		const expected = scanCitationUsages(text)
			.filter(u => u.key === 'a-b')
			.map(u => ({ keyStart: u.keyStart, keyEnd: u.keyEnd }));
		const actual = findUsagesForKey(text, 'a-b')
			.map(u => ({ keyStart: u.keyStart, keyEnd: u.keyEnd }));
		expect(actual).toEqual(expected);
	});
});

describe('Property: every .bib key is cited as written, or reported', () => {
	/**
	 * Each key the parser reads in a .bib file, of characters at the edges of
	 * what BibTeX and biber read in one (see readEntryKey), either no
	 * citation can cite, as one with a ; or a ], and the LSP reports it
	 * (findUncitableBibKeys), or `[@key]` cites it: export reads that key,
	 * and the LSP's diagnostics and lookups read it, and a completion
	 * replaces all of it. In brackets, after text, or after brackets, as
	 * well as alone, as the LSP finds a citation's [ where export does.
	 */
	test('cites each key a .bib file has as export, the LSP and completion read it, or reports it', () => {
		const keyChar = fc.constantFrom('a', 'Z', '0', '_', ':', '.', '/', '-', '+', "'", '\u00E9', '&', '*', '\\', '~', '$', '<',
			';', ']', '[', '}', ')', '(', '{', '"', '#', '%', '=', '@', '`', ' ', ',');
		const key = fc.array(keyChar, { minLength: 1, maxLength: 8 }).map(chars => chars.join(''));
		fc.assert(
			fc.property(key, fc.boolean(), fc.constantFrom('X', 'see X.', '[text X]', '[t [u X]]', '[a] X', 'X [b]', '[see [x] X]', '[a@b X]'), (written, paren, context) => {
				const bib = paren ? '@article(' + written + ', title = {T})' : '@article{' + written + ', title = {T}}';
				const { ranges } = parseBibtexWithRaw(bib);
				const reported = new Set(findUncitableBibKeys(ranges).map(range => range.key));
				for (const { key: read } of ranges) {
					if (reported.has(read)) {
						expect(read).toMatch(/[;\]`]/);
						continue;
					}
					const citation = context.replace('X', () => '[@' + read + ']');
					const runs = parseMd(citation).flatMap(token => token.runs ?? []).filter(item => item.type === 'citation');
					expect(runs.flatMap(item => item.keys ?? [])).toEqual([read]);
					expect(scanCitationUsages(citation).map(usage => citation.slice(usage.keyStart, usage.keyEnd))).toEqual([read]);
					expect(findUsagesForKey(citation, read)).toHaveLength(1);
					expect(getCompletionContextAtOffset('[@' + read, read.length + 2)?.prefix).toBe(read);
				}
			}),
			{ numRuns: 3000 }
		);
	});
});
