import { describe, test, expect } from 'bun:test';
import { findBibKeyMatches, matchesWorkspaceSymbolQuery } from './bib-workspace-symbols';
import { parseBibDataFromText } from './citekey-language';

describe('matchesWorkspaceSymbolQuery', () => {
	test('an empty query matches every key', () => {
		expect(matchesWorkspaceSymbolQuery('smith2020', '')).toBe(true);
	});

	test('matches the query as a subsequence, ignoring case', () => {
		expect(matchesWorkspaceSymbolQuery('Smith2020', 'smith')).toBe(true);
		expect(matchesWorkspaceSymbolQuery('smith2020', 'S20')).toBe(true);
		expect(matchesWorkspaceSymbolQuery('smith2020', 'sm 2020')).toBe(true);
	});

	test('rejects a query whose characters are not all in the key in order', () => {
		expect(matchesWorkspaceSymbolQuery('smith2020', 'jones')).toBe(false);
		expect(matchesWorkspaceSymbolQuery('smith2020', '02s')).toBe(false);
	});
});

describe('findBibKeyMatches', () => {
	const text = [
		'@article{smith2020,',
		'  author = {Smith, Jane},',
		'  year = {2020},',
		'}',
		'',
		'@book{jones2019,',
		'  author = {Jones, Bob},',
		'}',
		'',
		'@misc{smith2020,',
		'  title = {Again},',
		'}',
	].join('\n');
	const bib = parseBibDataFromText('/refs.bib', text);

	test('gives each matching declaration, at its key, in source order', () => {
		const matches = findBibKeyMatches(bib, 'smith');
		expect(matches.map(m => m.key)).toEqual(['smith2020', 'smith2020']);
		for (const m of matches) {
			expect(text.slice(m.keyStart, m.keyEnd)).toBe('smith2020');
		}
		expect(matches[0].keyStart).toBeLessThan(matches[1].keyStart);
	});

	test('an empty query gives every key', () => {
		expect(findBibKeyMatches(bib, '').map(m => m.key)).toEqual(['smith2020', 'jones2019', 'smith2020']);
	});

	test('a query no key matches gives none', () => {
		expect(findBibKeyMatches(bib, 'zzz')).toEqual([]);
	});
});
