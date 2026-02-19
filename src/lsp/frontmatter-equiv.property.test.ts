// Feature: lsp-performance-phase2, Property 7: Pre-parsed frontmatter equivalence

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { resolveBibliographyPathAsync } from './citekey-language';
import { parseFrontmatter } from '../frontmatter';

// **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

/**
 * Generator for markdown texts with YAML frontmatter blocks.
 * Produces texts with optional bibliography and csl fields.
 */
const frontmatterGen = fc.record({
	bibliography: fc.oneof(
		fc.constant(undefined),
		fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[\n\r]/g, '') + '.bib')
	),
	csl: fc.oneof(
		fc.constant(undefined),
		fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[\n\r]/g, ''))
	),
}).map(fm => {
	const lines = ['---'];
	if (fm.bibliography) lines.push(`bibliography: ${fm.bibliography}`);
	if (fm.csl) lines.push(`csl: ${fm.csl}`);
	lines.push('---', '', 'Some body text');
	return lines.join('\n');
});

/** Generator for markdown texts without frontmatter */
const noFrontmatterGen = fc.string({ minLength: 0, maxLength: 50 }).map(s =>
	s.replace(/^---/, 'xxx')
);

/** Combined generator: texts with or without frontmatter */
const markdownGen = fc.oneof(frontmatterGen, noFrontmatterGen);

const TEST_URI = 'file:///tmp/test.md';
const EMPTY_ROOTS: string[] = [];

describe('Property 7: Pre-parsed frontmatter equivalence', () => {
	test('resolveBibliographyPathAsync with pre-parsed metadata returns same result as without', async () => {
		await fc.assert(
			fc.asyncProperty(
				markdownGen,
				async (text) => {
					const { metadata } = parseFrontmatter(text);

					const [withoutMeta, withMeta] = await Promise.all([
						resolveBibliographyPathAsync(TEST_URI, text, EMPTY_ROOTS),
						resolveBibliographyPathAsync(TEST_URI, text, EMPTY_ROOTS, metadata),
					]);

					expect(withMeta).toBe(withoutMeta);
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('equivalence holds for frontmatter with bibliography field', async () => {
		await fc.assert(
			fc.asyncProperty(
				frontmatterGen,
				async (text) => {
					const { metadata } = parseFrontmatter(text);

					const [withoutMeta, withMeta] = await Promise.all([
						resolveBibliographyPathAsync(TEST_URI, text, EMPTY_ROOTS),
						resolveBibliographyPathAsync(TEST_URI, text, EMPTY_ROOTS, metadata),
					]);

					expect(withMeta).toBe(withoutMeta);
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('equivalence holds for texts without frontmatter', async () => {
		await fc.assert(
			fc.asyncProperty(
				noFrontmatterGen,
				async (text) => {
					const { metadata } = parseFrontmatter(text);

					const [withoutMeta, withMeta] = await Promise.all([
						resolveBibliographyPathAsync(TEST_URI, text, EMPTY_ROOTS),
						resolveBibliographyPathAsync(TEST_URI, text, EMPTY_ROOTS, metadata),
					]);

					expect(withMeta).toBe(withoutMeta);
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);
});
