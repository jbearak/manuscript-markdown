import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { scanCitationUsages, findUsagesForKey } from './citekey-language';

describe('Property 2: Targeted Key Scanner Equivalence', () => {
	// Generator for valid citekeys (CITEKEY_RE alphabet: [A-Za-z0-9_:-]+).
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

	test('defensively escapes regex-special lookup keys outside CITEKEY_RE alphabet', () => {
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
