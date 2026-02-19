import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { findCitekeyAtOffset, scanCitationUsages } from './citekey-language';

// Reference: original full-document-scan implementation
function findCitekeyAtOffsetReference(text: string, offset: number): string | undefined {
	for (const usage of scanCitationUsages(text)) {
		if (offset >= usage.keyStart - 1 && offset <= usage.keyEnd) {
			return usage.key;
		}
	}
	return undefined;
}

describe('Property 5: Local Citekey Resolution Equivalence', () => {
	const citekeyGen = fc.string({
		unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:-'.split('')),
		minLength: 1,
		maxLength: 15
	});

	const citationSegmentGen = fc.array(citekeyGen, { minLength: 1, maxLength: 4 }).map(
		keys => `[@${keys.join('; @')}]`
	);
	const multilineCitationSegmentGen = fc.array(citekeyGen, { minLength: 2, maxLength: 4 }).map(
		keys => `[@${keys.join(';\n@')}]`
	);

	const textGen = fc.array(
		fc.oneof(citationSegmentGen, multilineCitationSegmentGen, fc.string({ maxLength: 40 })),
		{ minLength: 1, maxLength: 8 }
	).map(parts => parts.join(' '));

	test('resolves citekeys inside multi-line citation groups', () => {
		const text = '[@author2022; @smith2023;\n@jones2024]';
		const offset = text.indexOf('@jones2024') + 2;
		expect(findCitekeyAtOffset(text, offset)).toBe('jones2024');
	});

	test('bounded scan matches full-document scan for all offsets', () => {
		fc.assert(
			fc.property(textGen, (text) => {
				// Test every offset in the text
				for (let offset = 0; offset < text.length; offset++) {
					const actual = findCitekeyAtOffset(text, offset);
					const expected = findCitekeyAtOffsetReference(text, offset);
					if (actual !== expected) {
						throw new Error(`Mismatch at offset ${offset} in "${text}": got ${actual}, expected ${expected}`);
					}
				}
			}),
			{ numRuns: 100 }
		);
	});
});
