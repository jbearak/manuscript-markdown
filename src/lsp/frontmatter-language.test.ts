import { describe, test, expect } from 'bun:test';
import {
	damerauLevenshtein,
	findTypoSuggestions,
	getFrontmatterLocation,
	getFrontmatterCompletionItems,
	getFrontmatterHover,
	validateFrontmatter,
	FRONTMATTER_SCHEMA,
	STYLES_SUB_PROPS,
	type FrontmatterValidationCallbacks,
} from './frontmatter-language';

// ---------------------------------------------------------------------------
// Schema completeness
// ---------------------------------------------------------------------------

describe('schema completeness', () => {
	// All canonical keys from parseFrontmatter's switch in frontmatter.ts
	const EXPECTED_KEYS = [
		'title', 'author', 'csl', 'locale', 'zotero-notes', 'notes', 'timezone',
		'bibliography', 'font', 'code-font', 'font-size', 'code-font-size',
		'header-font', 'header-font-size', 'header-font-style',
		'title-font', 'title-font-size', 'title-font-style',
		'table-font', 'table-font-size', 'table-col-widths', 'table-borders',
		'table-digits', 'table-decimal-mark', 'table-digit-grouping',
		'code-background-color', 'code-font-color', 'code-block-inset',
		'pipe-table-max-line-width', 'grid-table-max-line-width',
		'blockquote-style', 'callout-labels', 'colors', 'styles', 'breaks',
		'line-spacing', 'paragraph-indent', 'bibliography-hanging-indent',
	];

	test('schema covers all expected frontmatter keys', () => {
		const schemaKeys = FRONTMATTER_SCHEMA.map(d => d.key);
		for (const key of EXPECTED_KEYS) {
			expect(schemaKeys).toContain(key);
		}
	});

	test('no extra keys in schema beyond expected', () => {
		const expectedSet = new Set(EXPECTED_KEYS);
		for (const def of FRONTMATTER_SCHEMA) {
			expect(expectedSet.has(def.key)).toBe(true);
		}
	});

	test('styles sub-properties cover all 6 expected keys', () => {
		const keys = STYLES_SUB_PROPS.map(d => d.key);
		expect(keys).toEqual(['font', 'font-size', 'font-style', 'spacing-before', 'spacing-after', 'paragraph-indent']);
	});
});

// ---------------------------------------------------------------------------
// Damerau-Levenshtein
// ---------------------------------------------------------------------------

describe('damerauLevenshtein', () => {
	test('identical strings → 0', () => {
		expect(damerauLevenshtein('font', 'font')).toBe(0);
	});

	test('empty vs non-empty', () => {
		expect(damerauLevenshtein('', 'abc')).toBe(3);
		expect(damerauLevenshtein('abc', '')).toBe(3);
	});

	test('both empty → 0', () => {
		expect(damerauLevenshtein('', '')).toBe(0);
	});

	test('single substitution → 1', () => {
		expect(damerauLevenshtein('font', 'fant')).toBe(1);
	});

	test('single insertion → 1', () => {
		expect(damerauLevenshtein('fnt', 'font')).toBe(1);
	});

	test('single deletion → 1', () => {
		expect(damerauLevenshtein('fontt', 'font')).toBe(1);
	});

	test('adjacent transposition → 1', () => {
		expect(damerauLevenshtein('tabel', 'table')).toBe(1);
		expect(damerauLevenshtein('fnot', 'font')).toBe(1);
	});

	test('single edit on long string → 1', () => {
		expect(damerauLevenshtein('table-bordes', 'table-borders')).toBe(1);
		expect(damerauLevenshtein('tble-borders', 'table-borders')).toBe(1);
		expect(damerauLevenshtein('tableborders', 'table-borders')).toBe(1);
	});

	test('completely different strings', () => {
		expect(damerauLevenshtein('abc', 'xyz')).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// findTypoSuggestions
// ---------------------------------------------------------------------------

describe('findTypoSuggestions', () => {
	test('exact match returns empty (not a typo)', () => {
		expect(findTypoSuggestions('font')).toEqual([]);
	});

	test('single-char typo for short key (<=5 chars)', () => {
		expect(findTypoSuggestions('fontt')).toEqual(['font']);
		expect(findTypoSuggestions('fon')).toEqual(['font']);
	});

	test('single-char transposition for short key', () => {
		expect(findTypoSuggestions('fnot')).toEqual(['font']);
	});

	test('two-char typo rejected for short key', () => {
		// 'fo' is distance 2 from 'font' — should not suggest (key length <=5)
		const result = findTypoSuggestions('fo');
		expect(result).not.toContain('font');
	});

	test('two-char typo accepted for long key', () => {
		// 'tabel-borders' is distance 2 from 'table-borders'
		expect(findTypoSuggestions('tabel-bordes')).toEqual(['table-borders']);
	});

	test('suggests based on alias proximity', () => {
		// 'bib' is an alias of 'bibliography'; 'bip' is distance 1 from 'bib'
		const result = findTypoSuggestions('bip');
		expect(result).toContain('bibliography');
	});

	test('unknown key far from all known keys returns empty', () => {
		expect(findTypoSuggestions('foobar')).toEqual([]);
	});

	test('multiple equidistant suggestions', () => {
		// 'notes' is distance 1 from both... let's check
		// 'nots' is distance 1 from 'notes'
		const result = findTypoSuggestions('nots');
		expect(result).toContain('notes');
	});

	test('case-insensitive matching', () => {
		expect(findTypoSuggestions('FONTT')).toEqual(['font']);
	});
});

// ---------------------------------------------------------------------------
// getFrontmatterLocation
// ---------------------------------------------------------------------------

describe('getFrontmatterLocation', () => {
	test('returns outside when no frontmatter', () => {
		const text = 'Just a document.';
		const loc = getFrontmatterLocation(text, 5);
		expect(loc.kind).toBe('outside');
		expect(loc.inFrontmatter).toBe(false);
	});

	test('returns outside when offset is past frontmatter', () => {
		const text = '---\nfont: Georgia\n---\n\nBody text.';
		const loc = getFrontmatterLocation(text, text.indexOf('Body'));
		expect(loc.kind).toBe('outside');
	});

	test('returns outside at the offset immediately after the closing delimiter', () => {
		const text = '---\nfont: Georgia\n---\nBody text.';
		const loc = getFrontmatterLocation(text, text.indexOf('\nBody'));
		expect(loc.kind).toBe('outside');
		expect(loc.inFrontmatter).toBe(false);
	});

	test('returns outside at the offset immediately after a CRLF closing delimiter', () => {
		const text = '---\r\nfont: Georgia\r\n---\r\nBody text.';
		const loc = getFrontmatterLocation(text, text.indexOf('\r\nBody'));
		expect(loc.kind).toBe('outside');
		expect(loc.inFrontmatter).toBe(false);
	});

	test('returns outside after an empty closed frontmatter block', () => {
		const text = '---\n---\nText [@smith]';
		const loc = getFrontmatterLocation(text, text.indexOf('@smith'));
		expect(loc.kind).toBe('outside');
		expect(loc.inFrontmatter).toBe(false);
	});

	test('returns outside after an empty closed CRLF frontmatter block', () => {
		const text = '---\r\n---\r\nText [@smith]';
		const loc = getFrontmatterLocation(text, text.indexOf('@smith'));
		expect(loc.kind).toBe('outside');
		expect(loc.inFrontmatter).toBe(false);
	});

	test('key position when cursor is on key name', () => {
		const text = '---\nfont: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('font') + 2);
		expect(loc.kind).toBe('key');
		expect(loc.key).toBe('font');
	});

	test('value position when cursor is after colon', () => {
		const text = '---\nfont: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Georgia') + 3);
		expect(loc.kind).toBe('value');
		expect(loc.key).toBe('font');
	});

	test('collects all declared keys', () => {
		const text = '---\nfont: Georgia\nfont-size: 12\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('font') + 2);
		expect(loc.declaredKeys.has('font')).toBe(true);
		expect(loc.declaredKeys.has('font-size')).toBe(true);
	});

	test('resolves aliases in declaredKeys', () => {
		const text = '---\nbib: refs.bib\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('bib'));
		expect(loc.declaredKeys.has('bibliography')).toBe(true);
	});

	test('handles empty line in frontmatter as key position', () => {
		const text = '---\nfont: Georgia\n\n---\n';
		const emptyLineOffset = text.indexOf('\n\n') + 1;
		const loc = getFrontmatterLocation(text, emptyLineOffset);
		expect(loc.kind).toBe('key');
		expect(loc.inFrontmatter).toBe(true);
	});

	test('styles block: style name level', () => {
		const text = '---\nstyles:\n  MyQuote:\n    font: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('MyQuote'));
		expect(loc.kind).toBe('styles-name');
	});

	test('styles block: blank style name lines stay at the name level', () => {
		for (const text of [
			'---\nstyles:\n  \n---\n',
			'---\nstyles:\n    \n---\n',
			'---\nstyles:\n  # Pick a style name\n    \n---\n',
			'---\nstyles:\n  # Note: choose a style\n    \n---\n',
			'---\nstyles:\n  MyQuote:\n    font: Georgia\n  \n---\n',
			'---\r\nstyles:\r\n  \r\n---\r\n',
			'---\r\nstyles:\r\n  MyQuote:\r\n    font: Georgia\r\n  \r\n---\r\n',
		]) {
			const marker = text.includes('\r\n') ? '\r\n---' : '\n---';
			const offset = text.lastIndexOf(marker);
			const loc = getFrontmatterLocation(text, offset);
			expect(loc.kind).toBe('styles-name');
		}
	});

	test('styles block: future style names do not establish indentation', () => {
		const text = '---\nstyles:\n      \n  FutureStyle:\n---\n';
		const offset = text.indexOf('      \n') + 6;
		const loc = getFrontmatterLocation(text, offset);
		expect(loc.kind).toBe('styles-name');
	});

	test('styles block: custom style-name indentation establishes deeper properties', () => {
		const text = '---\nstyles:\n    MyQuote:\n      \n---\n';
		const offset = text.indexOf('      \n') + 6;
		const loc = getFrontmatterLocation(text, offset);
		expect(loc.kind).toBe('styles-key');
	});

	test('styles block: nearest style-name indentation determines blank line depth', () => {
		const text = '---\nstyles:\n  FirstStyle:\n SecondStyle:\n  \n---\n';
		const offset = text.indexOf('  \n---') + 2;
		const loc = getFrontmatterLocation(text, offset);
		expect(loc.kind).toBe('styles-key');
	});

	test('styles block: sub-property key position', () => {
		const text = '---\nstyles:\n  MyQuote:\n    font: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('    font') + 4 + 2);
		expect(loc.kind).toBe('styles-key');
		expect(loc.key).toBe('font');
	});

	test('styles block: sub-property value position', () => {
		const text = '---\nstyles:\n  MyQuote:\n    font: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Georgia') + 3);
		expect(loc.kind).toBe('styles-value');
		expect(loc.key).toBe('font');
		expect(loc.styleName).toBe('MyQuote');
	});

	test('handles \\r\\n line endings', () => {
		const text = '---\r\nfont: Georgia\r\n---\r\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Georgia') + 3);
		expect(loc.kind).toBe('value');
		expect(loc.key).toBe('font');
	});
});

// ---------------------------------------------------------------------------
// getFrontmatterCompletionItems
// ---------------------------------------------------------------------------

describe('getFrontmatterCompletionItems', () => {
	function applyCompletion(text: string, loc: ReturnType<typeof getFrontmatterLocation>, label: string): string {
		const item = getFrontmatterCompletionItems(loc, 'darwin').find(candidate => candidate.label === label);
		expect(item).toBeDefined();
		const start = item!.kind === 'property' ? loc.keyStart : loc.valueStart;
		const end = item!.kind === 'property'
			? (item!.replacementEnd ?? loc.keyEnd)
			: loc.valueEnd;
		return text.slice(0, start) + item!.insertText + text.slice(end);
	}

	test('key completions include all schema keys minus already declared', () => {
		const text = '---\nfont: Georgia\n\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('\n\n') + 1);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		// Should not include 'font' since it's already declared
		expect(items.find(i => i.label === 'font')).toBeUndefined();
		// Should include other keys
		expect(items.find(i => i.label === 'font-size')).toBeDefined();
		expect(items.find(i => i.label === 'title')).toBeDefined();
	});

	test('key completions filter by prefix', () => {
		const text = '---\ntab\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('tab') + 3);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		for (const item of items) {
			expect(item.label.startsWith('tab')).toBe(true);
		}
		expect(items.length).toBeGreaterThan(0);
	});

	test('key completion works before the closing frontmatter delimiter is typed', () => {
		const text = '---\ntab';
		const loc = getFrontmatterLocation(text, text.length);
		expect(loc.inFrontmatter).toBe(true);
		expect(applyCompletion(text, loc, 'table-borders')).toBe('---\ntable-borders: ');
	});

	test('enum key completion requests its value suggestions after inserting the separator', () => {
		const text = '---\ntab';
		const loc = getFrontmatterLocation(text, text.length);
		const item = getFrontmatterCompletionItems(loc, 'darwin')
			.find(candidate => candidate.label === 'table-borders');
		expect(item?.insertText).toBe('table-borders: ');
		expect(item?.triggerValueCompletions).toBe(true);
	});

	test('key completion with an existing colon does not reopen suggestions at the key', () => {
		const text = '---\ntab: old\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('tab') + 'tab'.length);
		const item = getFrontmatterCompletionItems(loc, 'darwin')
			.find(candidate => candidate.label === 'table-borders');
		expect(item?.insertText).toBe('table-borders');
		expect(item?.triggerValueCompletions).toBe(false);
	});

	test('key completion replaces an empty existing separator and requests values', () => {
		for (const text of [
			'---\ntab:\n---\n',
			'---\ntab:   \n---\n',
			'---\r\ntab:\r\n---\r\n',
			'---\r\ntab:   \r\n---\r\n',
		]) {
			const loc = getFrontmatterLocation(text, text.indexOf('tab') + 'tab'.length);
			const item = getFrontmatterCompletionItems(loc, 'darwin')
				.find(candidate => candidate.label === 'table-borders');
			expect(item?.insertText).toBe('table-borders: ');
			expect(item?.triggerValueCompletions).toBe(true);
			expect(item?.replacementEnd).toBe(loc.valueEnd);
			const eol = text.includes('\r\n') ? '\r\n' : '\n';
			expect(applyCompletion(text, loc, 'table-borders')).toBe(
				'---' + eol + 'table-borders: ' + eol + '---' + eol,
			);
		}
	});

	test('key completion from indentation chains values for an empty existing separator', () => {
		const text = '---\n  tab:   \n---\n';
		const offset = text.indexOf('  tab') + 1;
		const loc = getFrontmatterLocation(text, offset);
		const item = getFrontmatterCompletionItems(loc, 'darwin')
			.find(candidate => candidate.label === 'table-borders');
		expect(loc.keyStart).toBe(offset);
		expect(loc.keyEnd).toBeGreaterThanOrEqual(offset);
		expect(item?.triggerValueCompletions).toBe(true);
		expect(applyCompletion(text, loc, 'table-borders')).toBe('---\n  table-borders: \n---\n');
	});

	test('key completion preserves empty quote pairs and requests values inside them', () => {
		for (const quote of ['"', "'"] as const) {
			for (const eol of ['\n', '\r\n']) {
				const text = '---' + eol + 'tab: ' + quote + quote + eol + '---' + eol;
				const loc = getFrontmatterLocation(text, text.indexOf('tab') + 'tab'.length);
				const item = getFrontmatterCompletionItems(loc, 'darwin')
					.find(candidate => candidate.label === 'table-borders');
				expect(loc.valueQuote).toBe(quote);
				expect(item?.insertText).toBe('table-borders: ' + quote);
				expect(item?.triggerValueCompletions).toBe(true);
				expect(item?.replacementEnd).toBe(loc.valueEnd);
				expect(applyCompletion(text, loc, 'table-borders')).toBe(
					'---' + eol + 'table-borders: ' + quote + quote + eol + '---' + eol,
				);
			}
		}
	});

	test('keys without generated values do not request another suggestion list', () => {
		for (const key of ['author', 'font-size', 'timezone', 'bibliography', 'code-font-color', 'styles']) {
			const text = '---\n' + key;
			const loc = getFrontmatterLocation(text, text.length);
			const item = getFrontmatterCompletionItems(loc, 'darwin')
				.find(candidate => candidate.label === key);
			expect(item?.triggerValueCompletions).toBe(false);
		}
	});

	test('key completion works in an unclosed CRLF frontmatter block', () => {
		const text = '---\r\ntab';
		const loc = getFrontmatterLocation(text, text.length);
		expect(applyCompletion(text, loc, 'table-borders')).toBe('---\r\ntable-borders: ');
	});

	test('exact partial key can complete itself with a colon', () => {
		const text = '---\nfont\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('font') + 'font'.length);
		expect(applyCompletion(text, loc, 'font')).toBe('---\nfont: \n---\n');
	});

	test('exact key remains suppressed when it is already declared elsewhere', () => {
		const text = '---\nfont: Georgia\nfont\n---\n';
		const loc = getFrontmatterLocation(text, text.lastIndexOf('font') + 'font'.length);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.find(item => item.label === 'font')).toBeUndefined();
	});

	test('key completion preserves an existing colon', () => {
		const text = '---\ntab: old\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('tab') + 'tab'.length);
		expect(applyCompletion(text, loc, 'table-borders')).toBe('---\ntable-borders: old\n---\n');
	});

	test('key completion from leading indentation preserves an existing colon', () => {
		const text = '---\n  tab: old\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('  tab') + 1);
		expect(applyCompletion(text, loc, 'table-borders')).toBe('---\n  table-borders: old\n---\n');
	});

	test('styles key completion from leading indentation preserves an existing colon', () => {
		const text = '---\nstyles:\n  Quote:\n    fon: old\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('    fon') + 2);
		expect(applyCompletion(text, loc, 'font')).toBe('---\nstyles:\n  Quote:\n    font: old\n---\n');
	});

	test('styles key completion chains values for an empty existing separator', () => {
		const text = '---\nstyles:\n  Quote:\n    fon:   \n---\n';
		const offset = text.indexOf('    fon') + 2;
		const loc = getFrontmatterLocation(text, offset);
		const item = getFrontmatterCompletionItems(loc, 'darwin')
			.find(candidate => candidate.label === 'font');
		expect(loc.keyStart).toBe(offset);
		expect(loc.keyEnd).toBeGreaterThanOrEqual(offset);
		expect(item?.triggerValueCompletions).toBe(true);
		expect(applyCompletion(text, loc, 'font')).toBe('---\nstyles:\n  Quote:\n    font: \n---\n');
	});

	test('styles key completion preserves empty quote pairs and requests values inside them', () => {
		for (const quote of ['"', "'"] as const) {
			const text = '---\nstyles:\n  Quote:\n    fon: ' + quote + quote + '\n---\n';
			const offset = text.indexOf('    fon') + 2;
			const loc = getFrontmatterLocation(text, offset);
			const item = getFrontmatterCompletionItems(loc, 'darwin')
				.find(candidate => candidate.label === 'font');
			expect(loc.valueQuote).toBe(quote);
			expect(item?.triggerValueCompletions).toBe(true);
			expect(applyCompletion(text, loc, 'font')).toBe(
				'---\nstyles:\n  Quote:\n    font: ' + quote + quote + '\n---\n',
			);
		}
	});

	test('array value completion replaces only the active item', () => {
		const text = '---\nheader-font: [Georgia, Pal]\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Pal') + 'Pal'.length);
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\nheader-font: [Georgia, Palatino]\n---\n');
	});

	test('array value completion preserves a closing bracket before trailing whitespace', () => {
		const text = '---\nheader-font: [Georgia, Pal]   \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Pal') + 'Pal'.length);
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\nheader-font: [Georgia, Palatino]   \n---\n');
	});

	test('array completions are suppressed in trailing whitespace after the closing bracket', () => {
		const text = '---\nheader-font: [Georgia, Pal]   \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(']') + 2);
		expect(getFrontmatterCompletionItems(loc, 'darwin')).toEqual([]);
	});

	test('bare comma-separated value completion replaces only the active item', () => {
		const text = '---\ntitle-font: Georgia, Pal\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Pal') + 'Pal'.length);
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\ntitle-font: Georgia, Palatino\n---\n');
	});

	test('array value completion fills an empty item without removing brackets', () => {
		const text = '---\nheader-font: [Georgia, ]\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(']'));
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\nheader-font: [Georgia, Palatino]\n---\n');
	});

	test('array value completion preserves surrounding quotes', () => {
		const text = '---\nheader-font: \"[Georgia, Pal]\"\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Pal') + 'Pal'.length);
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\nheader-font: \"[Georgia, Palatino]\"\n---\n');
	});

	test('array value completion ignores commas inside quoted items', () => {
		const text = '---\nheader-font: [\"Times, New Roman\", Palatino]\n---\n';
		const offset = text.indexOf('New Roman') + 'New'.length;
		const loc = getFrontmatterLocation(text, offset);
		expect(applyCompletion(text, loc, 'Georgia')).toBe('---\nheader-font: [\"Georgia\", Palatino]\n---\n');
	});

	test('array value completion preserves quotes around an individual item', () => {
		const text = '---\nheader-font: [Georgia, \"Pal\"]\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Pal') + 'Pal'.length);
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\nheader-font: [Georgia, \"Palatino\"]\n---\n');
	});

	test('array value completion preserves spacing when invoked directly after a comma', () => {
		const text = '---\nheader-font: [Georgia, Pal]\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(',') + 1);
		expect(applyCompletion(text, loc, 'Palatino')).toBe('---\nheader-font: [Georgia, Palatino]\n---\n');
	});

	test('array value completion preserves item quotes at cursor boundaries', () => {
		for (const quote of ['"', "'"]) {
			const text = '---\nheader-font: [Georgia, ' + quote + 'Pal' + quote + ']\n---\n';
			for (const offset of [text.indexOf(quote), text.lastIndexOf(quote) + 1]) {
				const loc = getFrontmatterLocation(text, offset);
				expect(applyCompletion(text, loc, 'Palatino')).toBe(
					'---\nheader-font: [Georgia, ' + quote + 'Palatino' + quote + ']\n---\n',
				);
			}
		}
	});

	test('array value completion handles an empty first bare item', () => {
		const text = '---\nheader-font: , Georgia\n---\n';
		const offset = text.indexOf(',');
		const loc = getFrontmatterLocation(text, offset);
		expect(loc.valueStart).toBeLessThanOrEqual(offset);
		expect(loc.valueEnd).toBeGreaterThanOrEqual(offset);
		expect(applyCompletion(text, loc, 'Baskerville')).toBe('---\nheader-font: Baskerville, Georgia\n---\n');
	});

	test('array completion ranges always contain the cursor in surrounding whitespace', () => {
		const cases = [
			{ text: '---\nheader-font: [Georgia,   Pal]\n---\n', marker: ', ' },
			{ text: '---\nheader-font: [Georgia, Pal ]\n---\n', marker: 'Pal ' },
			{ text: '---\nheader-font: [Georgia,  ]\n---\n', marker: ', ' },
		];
		for (const testCase of cases) {
			const offset = testCase.text.indexOf(testCase.marker) + testCase.marker.length;
			const loc = getFrontmatterLocation(testCase.text, offset);
			expect(loc.valueStart).toBeLessThanOrEqual(offset);
			expect(loc.valueEnd).toBeGreaterThanOrEqual(offset);
		}
	});

	test('array completions are suppressed after the closing bracket', () => {
		const text = '---\nheader-font: [Georgia, Palatino]\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(']') + 1);
		expect(getFrontmatterCompletionItems(loc, 'darwin')).toEqual([]);
	});

	test('unfinished frontmatter with no YAML suggestions can fall through to body completions', () => {
		const text = '---\n\nBody [@smi';
		const loc = getFrontmatterLocation(text, text.length);
		expect(loc.frontmatterClosed).toBe(false);
		expect(getFrontmatterCompletionItems(loc, 'darwin')).toEqual([]);
	});

	test('value completions for boolean field', () => {
		const text = '---\nbreaks: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.map(i => i.label)).toEqual(['true', 'false']);
	});

	test('value completions for callout-labels', () => {
		const text = '---\ncallout-labels: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.map(i => i.label)).toEqual(['true', 'false']);
	});

	test('value completions for enum field', () => {
		const text = '---\ntable-borders: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.map(i => i.label)).toEqual(['horizontal', 'solid', 'none']);
	});

	test('value completions for font field on macOS', () => {
		const text = '---\nfont: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.some(i => i.label === 'Georgia')).toBe(true);
		expect(items.some(i => i.label === 'Baskerville')).toBe(true);
	});

	test('value completions for font field on Windows', () => {
		const text = '---\nfont: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'win32');
		expect(items.some(i => i.label === 'Cambria')).toBe(true);
		expect(items.some(i => i.label === 'Calibri')).toBe(true);
	});

	test('value completions for code-font offers mono fonts', () => {
		const text = '---\ncode-font: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.some(i => i.label === 'Menlo')).toBe(true);
		expect(items.some(i => i.label === 'Georgia')).toBe(false);
	});

	test('value completions for font-style field', () => {
		const text = '---\nheader-font-style: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.some(i => i.label === 'bold')).toBe(true);
		expect(items.some(i => i.label === 'bold-italic')).toBe(true);
		expect(items.some(i => i.label === 'normal')).toBe(true);
	});

	test('value completions for line-spacing', () => {
		const text = '---\nline-spacing: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.map(i => i.label)).toEqual(['single', '1.5', 'double']);
	});

	test('no value completions for free-text field', () => {
		const text = '---\nauthor: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items).toEqual([]);
	});

	test('no value completions for number-only field', () => {
		const text = '---\nfont-size: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items).toEqual([]);
	});

	test('styles sub-property key completions', () => {
		const text = '---\nstyles:\n  MyQuote:\n    \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('    \n') + 4);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.some(i => i.label === 'font')).toBe(true);
		expect(items.some(i => i.label === 'font-size')).toBe(true);
		expect(items.some(i => i.label === 'spacing-before')).toBe(true);
	});

	test('styles keys request value suggestions only when the sub-property has them', () => {
		const text = '---\nstyles:\n  MyQuote:\n    \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('    \n') + 4);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.find(item => item.label === 'font')?.triggerValueCompletions).toBe(true);
		expect(items.find(item => item.label === 'font-style')?.triggerValueCompletions).toBe(true);
		expect(items.find(item => item.label === 'paragraph-indent')?.triggerValueCompletions).toBe(true);
		expect(items.find(item => item.label === 'font-size')?.triggerValueCompletions).toBe(false);
		expect(items.find(item => item.label === 'spacing-before')?.triggerValueCompletions).toBe(false);
	});

	test('no completions outside frontmatter', () => {
		const text = '---\nfont: Georgia\n---\n\nBody text.';
		const loc = getFrontmatterLocation(text, text.indexOf('Body'));
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items).toEqual([]);
	});

	test('CSL value completions return canonical bundled styles', () => {
		const text = '---\ncsl: \n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf(': ') + 2);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		const labels = new Set(items.map(item => item.label));
		expect(labels.size).toBeGreaterThan(0);
		expect(labels.has('apa')).toBe(true);
		expect(labels.has('chicago-notes-bibliography')).toBe(true);
		expect(labels.has('chicago-shortened-notes-bibliography')).toBe(true);
		expect(labels.has('chicago-fullnote-bibliography')).toBe(false);
		expect(labels.has('chicago-note-bibliography')).toBe(false);
	});

	test('title key completion available even when already declared (allowsMultiple)', () => {
		const text = '---\ntitle: First\n\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('\n\n') + 1);
		const items = getFrontmatterCompletionItems(loc, 'darwin');
		expect(items.find(i => i.label === 'title')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// getFrontmatterHover
// ---------------------------------------------------------------------------

describe('getFrontmatterHover', () => {
	test('hover on known key shows description', () => {
		const text = '---\nfont: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('font') + 2);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeDefined();
		expect(hover!.markdown).toContain('**font**');
		expect(hover!.markdown).toContain('Body text font family');
	});

	test('hover on callout-labels documents default and preserved styling', () => {
		const text = '---\ncallout-labels: false\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('callout-labels') + 3);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeDefined();
		expect(hover!.markdown).toContain('**callout-labels**');
		expect(hover!.markdown).toContain('Default: `true`');
		expect(hover!.markdown).toContain('styling is preserved');
	});

	test('hover shows aliases', () => {
		const text = '---\nbibliography: refs.bib\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('bibliography') + 3);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeDefined();
		expect(hover!.markdown).toContain('`bib`');
		expect(hover!.markdown).toContain('`bibtex`');
	});

	test('hover on alias resolves to canonical', () => {
		const text = '---\nbib: refs.bib\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('bib') + 1);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeDefined();
		expect(hover!.markdown).toContain('**bibliography**');
	});

	test('hover on value shows key hover info', () => {
		const text = '---\nfont: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('Georgia') + 3);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeDefined();
		expect(hover!.markdown).toContain('**font**');
	});

	test('hover on unknown key returns undefined', () => {
		const text = '---\nunknown: value\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('unknown') + 3);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeUndefined();
	});

	test('hover on styles sub-property', () => {
		const text = '---\nstyles:\n  MyQuote:\n    font-size: 14\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('font-size') + 3);
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeDefined();
		expect(hover!.markdown).toContain('**font-size**');
	});

	test('hover outside frontmatter returns undefined', () => {
		const text = '---\nfont: Georgia\n---\n\nBody.';
		const loc = getFrontmatterLocation(text, text.indexOf('Body'));
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeUndefined();
	});

	test('hover on style name returns undefined', () => {
		const text = '---\nstyles:\n  MyQuote:\n    font: Georgia\n---\n';
		const loc = getFrontmatterLocation(text, text.indexOf('MyQuote'));
		const hover = getFrontmatterHover(loc);
		expect(hover).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// validateFrontmatter
// ---------------------------------------------------------------------------

const stubCallbacks: FrontmatterValidationCallbacks = {
	fileExists: async () => true,
	isCslAvailable: async () => true,
	cslSuggestions: () => [],
};

describe('validateFrontmatter', () => {
	test('valid frontmatter produces no diagnostics', async () => {
		const text = '---\nfont: Georgia\nfont-size: 12\nbreaks: true\ncallout-labels: false\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('invalid boolean value produces error', async () => {
		const text = '---\nbreaks: maybe\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
		expect(diags[0].message).toContain('true');
		expect(diags[0].message).toContain('false');
	});

	test('invalid callout-labels value produces error', async () => {
		const text = '---\ncallout-labels: maybe\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
		expect(diags[0].message).toContain('true');
		expect(diags[0].message).toContain('false');
	});

	test('invalid enum value produces error', async () => {
		const text = '---\ntable-borders: dotted\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
		expect(diags[0].message).toContain('horizontal');
	});

	test('validates numeric table settings and separator collisions', async () => {
		const valid = await validateFrontmatter('---\ntable-digits: 0\ntable-decimal-mark: midpoint\ntable-digit-grouping: thin-space\n---\n', stubCallbacks);
		expect(valid).toEqual([]);
		const invalid = await validateFrontmatter('---\ntable-digits: 1001\ntable-decimal-mark: comma\ntable-digit-grouping: comma\n---\n', stubCallbacks);
		expect(invalid.some(d => d.message.includes('0 to 1000'))).toBe(true);
		expect(invalid.some(d => d.message.includes('same character'))).toBe(true);
	});

	test('invalid timezone format produces error', async () => {
		const text = '---\ntimezone: EST\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
		expect(diags[0].message).toContain('+HH:MM');
	});

	test('valid timezone passes', async () => {
		const text = '---\ntimezone: +05:30\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('invalid hex color produces error', async () => {
		const text = '---\ncode-background-color: red\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('valid hex color passes', async () => {
		const text = '---\ncode-background-color: F0F0F0\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('code-background-color accepts none and transparent', async () => {
		for (const val of ['none', 'transparent']) {
			const text = '---\ncode-background-color: ' + val + '\n---\n';
			const diags = await validateFrontmatter(text, stubCallbacks);
			expect(diags).toEqual([]);
		}
	});

	test('code-font-color does NOT accept none', async () => {
		const text = '---\ncode-font-color: none\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('invalid font-style produces error', async () => {
		const text = '---\nheader-font-style: bald\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
		expect(diags[0].message).toContain('bold');
	});

	test('valid font-style passes', async () => {
		const text = '---\nheader-font-style: bold-italic\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('bare comma-separated font-style array passes', async () => {
		const text = '---\nheader-font-style: bold-italic, bold, normal\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('invalid line-spacing produces error', async () => {
		const text = '---\nline-spacing: triple\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('valid line-spacing values pass', async () => {
		for (const val of ['single', '1.5', 'double', '1.15']) {
			const text = '---\nline-spacing: ' + val + '\n---\n';
			const diags = await validateFrontmatter(text, stubCallbacks);
			expect(diags).toEqual([]);
		}
	});

	test('invalid paragraph-indent produces error', async () => {
		const text = '---\nparagraph-indent: big\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('valid paragraph-indent values pass', async () => {
		for (const val of ['none', '0', '0.5', '1']) {
			const text = '---\nparagraph-indent: ' + val + '\n---\n';
			const diags = await validateFrontmatter(text, stubCallbacks);
			expect(diags).toEqual([]);
		}
	});

	test('invalid col-widths produces error', async () => {
		const text = '---\ntable-col-widths: abc\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('valid col-widths values pass', async () => {
		for (const val of ['equal', 'auto', '2 1 1', '[2, 1, 1]']) {
			const text = '---\ntable-col-widths: ' + val + '\n---\n';
			const diags = await validateFrontmatter(text, stubCallbacks);
			expect(diags).toEqual([]);
		}
	});

	test('array number field (header-font-size) with inline array passes', async () => {
		const text = '---\nheader-font-size: [24, 20, 16]\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('array number field with invalid element produces error', async () => {
		const text = '---\nheader-font-size: [24, abc, 16]\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('duplicate key produces warning', async () => {
		const text = '---\nfont: Georgia\nfont: Arial\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('warning');
		expect(diags[0].message).toContain('Duplicate');
	});

	test('duplicate title does NOT produce warning', async () => {
		const text = '---\ntitle: First\ntitle: Second\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('duplicate alias produces warning mentioning canonical', async () => {
		const text = '---\nbibliography: refs.bib\nbib: refs.bib\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('warning');
		expect(diags[0].message).toContain('bibliography');
	});

	test('unknown key emits no diagnostic', async () => {
		const text = '---\nfoo: bar\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('typo key emits information diagnostic', async () => {
		const text = '---\nfontt: Georgia\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('information');
		expect(diags[0].message).toContain('font');
		expect(diags[0].message).toContain('Did you mean');
	});

	test('typo in styles sub-property emits information diagnostic', async () => {
		const text = '---\nstyles:\n  MyQuote:\n    fnt-size: 14\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		const info = diags.filter(d => d.severity === 'information');
		expect(info.length).toBe(1);
		expect(info[0].message).toContain('Did you mean');
	});

	test('wrong case key emits case-sensitive information diagnostic', async () => {
		const text = '---\nTitle: My Doc\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('information');
		expect(diags[0].message).toContain('case-sensitive');
		expect(diags[0].message).toContain('`title`');
	});

	test('wrong case Author emits case-sensitive diagnostic', async () => {
		const text = '---\nAuthor: Jane\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('information');
		expect(diags[0].message).toContain('`author`');
	});

	test('wrong case in styles sub-property emits case-sensitive diagnostic', async () => {
		const text = '---\nstyles:\n  MyQuote:\n    Font-Size: 14\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		const info = diags.filter(d => d.severity === 'information');
		expect(info.length).toBe(1);
		expect(info[0].message).toContain('case-sensitive');
		expect(info[0].message).toContain('`font-size`');
	});

	test('CSL not found produces warning', async () => {
		const text = '---\ncsl: nonexistent-style\n---\n';
		const diags = await validateFrontmatter(text, {
			...stubCallbacks,
			isCslAvailable: async () => false,
			cslSuggestions: () => ['nature'],
		});
		const cslDiag = diags.find(d => d.message.includes('CSL'));
		expect(cslDiag).toBeDefined();
		expect(cslDiag!.severity).toBe('warning');
		expect(cslDiag!.message).toContain('nature');
	});

	test('bibliography file not found produces warning', async () => {
		const text = '---\nbibliography: missing.bib\n---\n';
		const diags = await validateFrontmatter(text, {
			...stubCallbacks,
			fileExists: async () => false,
			sourceDir: '/some/dir',
		});
		const bibDiag = diags.find(d => d.message.includes('Bibliography'));
		expect(bibDiag).toBeDefined();
		expect(bibDiag!.severity).toBe('warning');
	});

	test('bibliography file found produces no diagnostic', async () => {
		const text = '---\nbibliography: refs.bib\n---\n';
		const diags = await validateFrontmatter(text, {
			...stubCallbacks,
			sourceDir: '/some/dir',
		});
		expect(diags).toEqual([]);
	});

	test('invalid styles sub-property value produces error', async () => {
		const text = '---\nstyles:\n  MyQuote:\n    font-style: bald\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		const errors = diags.filter(d => d.severity === 'error');
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain('font style');
	});

	test('no frontmatter produces no diagnostics', async () => {
		const text = 'Just a document.';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags).toEqual([]);
	});

	test('negative number in font-size produces error', async () => {
		const text = '---\nfont-size: -5\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});

	test('non-number in font-size produces error', async () => {
		const text = '---\nfont-size: large\n---\n';
		const diags = await validateFrontmatter(text, stubCallbacks);
		expect(diags.length).toBe(1);
		expect(diags[0].severity).toBe('error');
	});
});
