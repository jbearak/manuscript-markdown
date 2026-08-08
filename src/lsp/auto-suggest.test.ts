import { describe, expect, test } from 'bun:test';
import { shouldAutoTriggerLspSuggest } from './auto-suggest';

function shouldTrigger(
	text: string,
	offset = text.length,
	changeText = text.slice(-1),
	rangeLength = 0,
): boolean {
	return shouldAutoTriggerLspSuggest({
		enabled: true,
		text,
		offset,
		platform: 'darwin',
		changes: [{ rangeLength, text: changeText }],
	});
}

describe('shouldAutoTriggerLspSuggest frontmatter policy', () => {
	test('triggers on a new blank top-level frontmatter line', () => {
		const text = '---\nfont: Georgia\n\n---\n';
		const offset = text.indexOf('\n\n') + 1;
		expect(shouldTrigger(text, offset, '\n')).toBe(true);
	});

	test('triggers on a blank line before the closing delimiter exists', () => {
		expect(shouldTrigger('---\n', 4, '\n')).toBe(true);
	});

	test('lets an unfinished first-line list filter without retriggering', () => {
		expect(shouldTrigger('---\nt', 5, 't')).toBe(false);
		expect(shouldTrigger('---\ntitl', 8, 'l')).toBe(false);
		expect(shouldTrigger('---\ntable-borders:', 18, ':')).toBe(true);
	});

	test('triggers on CRLF Enter and auto-indented Enter edits', () => {
		const crlf = '---\r\nfont: Georgia\r\n\r\n---\r\n';
		const crlfOffset = crlf.indexOf('\r\n\r\n') + 2;
		expect(shouldTrigger(crlf, crlfOffset, '\r\n')).toBe(true);

		const nested = '---\nstyles:\n  MyQuote:\n    \n---\n';
		const nestedOffset = nested.indexOf('    \n') + 4;
		expect(shouldTrigger(nested, nestedOffset, '\n    ')).toBe(true);
	});

	test('triggers while typing a setting-name prefix', () => {
		const text = '---\ntab\n---\n';
		const offset = text.indexOf('tab') + 3;
		expect(shouldTrigger(text, offset, 'b')).toBe(true);
	});

	test('does not trigger when a key prefix has no available matches', () => {
		const text = '---\nnot-a-manuscript-setting\n---\n';
		const offset = text.indexOf('not-a-manuscript-setting') + 'not-a-manuscript-setting'.length;
		expect(shouldTrigger(text, offset, 'g')).toBe(false);
	});

	test('does not offer a duplicate-only key match', () => {
		const text = '---\ncolors: github\ncolors\n---\n';
		const offset = text.lastIndexOf('colors') + 'colors'.length;
		expect(shouldTrigger(text, offset, 's')).toBe(false);
	});

	test('triggers after a colon when the setting has generated values', () => {
		const text = '---\ntable-borders:\n---\n';
		const offset = text.indexOf(':') + 1;
		expect(shouldTrigger(text, offset, ':')).toBe(true);
	});

	test('keeps triggering while typing an enum value prefix', () => {
		const text = '---\ntable-borders: s\n---\n';
		const offset = text.indexOf(' s') + 2;
		expect(shouldTrigger(text, offset, 's')).toBe(true);
	});

	test('triggers only in the active array item', () => {
		const active = '---\nheader-font-style: [bold, it]\n---\n';
		const activeOffset = active.indexOf('it') + 2;
		expect(shouldTrigger(active, activeOffset, 't')).toBe(true);

		const afterBracket = '---\nheader-font-style: [bold] \n---\n';
		const afterBracketOffset = afterBracket.indexOf(']') + 2;
		expect(shouldTrigger(afterBracket, afterBracketOffset, ' ')).toBe(false);
	});

	test('triggers on backspace when completions remain available', () => {
		const text = '---\nta\n---\n';
		const offset = text.indexOf('ta') + 2;
		expect(shouldTrigger(text, offset, '', 1)).toBe(true);
	});

	test('does not trigger in ordinary Markdown prose', () => {
		expect(shouldTrigger('Ordinary prose')).toBe(false);
		expect(shouldTrigger('---\nOrdinary prose')).toBe(false);
	});

	test('stops unfinished-frontmatter auto-popup after body-like prose', () => {
		for (const text of [
			'---\nA thematic-break document.\n\n',
			'---\n\nBody paragraph.\n\n',
			'---\n# Heading\n\n',
			'---\n    const x = 1;\n\n',
			'---\n  indented prose\n\n',
			'---\n    sample: code\n\n',
		]) {
			expect(shouldTrigger(text, text.length, '\n')).toBe(false);
		}
	});

	test('keeps unfinished-frontmatter popup through EOF once a mapping establishes YAML', () => {
		for (const text of [
			'---\n# Document metadata\ntitle: Draft\n\n',
			'---\ntitle: Draft\nmalformed prose still in YAML\n\n',
		]) {
			expect(shouldTrigger(text, text.length, '\n')).toBe(true);
		}
	});

	test('does not trigger values for unknown or free-text settings', () => {
		for (const text of [
			'---\nunknown:\n---\n',
			'---\ntitle:\n---\n',
		]) {
			const offset = text.indexOf(':') + 1;
			expect(shouldTrigger(text, offset, ':')).toBe(false);
		}
	});

	test('does not trigger for style-name positions', () => {
		for (const { text, offset, changeText } of [
			{
				text: '---\nstyles:\n  MyQuote\n---\n',
				offset: '---\nstyles:\n  MyQuote'.length,
				changeText: 'e',
			},
			{
				text: '---\nstyles:\n  \n---\n',
				offset: '---\nstyles:\n  '.length,
				changeText: '\n  ',
			},
			{
				text: '---\nstyles:\n    \n---\n',
				offset: '---\nstyles:\n    '.length,
				changeText: '\n    ',
			},
			{
				text: '---\nstyles:\n  # Pick a style name\n    \n---\n',
				offset: '---\nstyles:\n  # Pick a style name\n    '.length,
				changeText: '\n    ',
			},
			{
				text: '---\nstyles:\n      \n  FutureStyle:\n---\n',
				offset: '---\nstyles:\n      '.length,
				changeText: '\n      ',
			},
			{
				text: '---\nstyles:\n  MyQuote:\n    font: Georgia\n  \n---\n',
				offset: '---\nstyles:\n  MyQuote:\n    font: Georgia\n  '.length,
				changeText: '\n  ',
			},
			{
				text: '---\r\nstyles:\r\n  \r\n---\r\n',
				offset: '---\r\nstyles:\r\n  '.length,
				changeText: '\r\n  ',
			},
		]) {
			expect(shouldTrigger(text, offset, changeText)).toBe(false);
		}
	});

	test('does not trigger for pasted text or completion-acceptance replacements', () => {
		const text = '---\ntable-borders\n---\n';
		const offset = text.indexOf('table-borders') + 'table-borders'.length;
		expect(shouldTrigger(text, offset, 'table-borders')).toBe(false);
		expect(shouldTrigger(text, offset, 'table-borders', 3)).toBe(false);
		expect(shouldTrigger(text, offset, 'x', 1)).toBe(false);
	});
});

describe('shouldAutoTriggerLspSuggest existing contexts', () => {
	test('does not trigger when the language server is disabled', () => {
		expect(shouldAutoTriggerLspSuggest({
			enabled: false,
			text: '---\nt',
			offset: 5,
			platform: 'darwin',
			changes: [{ rangeLength: 0, text: 't' }],
		})).toBe(false);
	});

	test('preserves citekey auto-suggest', () => {
		for (const text of ['See [@s', 'See [-@s']) {
			expect(shouldTrigger(text, text.length, 's')).toBe(true);
		}
	});

	test('ignores a later colon while suggesting a provisional body citation', () => {
		const text = '---\nNote: prose\nBody cites @s: details';
		const offset = text.indexOf('@s') + 2;
		expect(shouldTrigger(text, offset, 's')).toBe(true);
	});

	test('treats unmatched ordinary brackets as bare completion contexts', () => {
		expect(shouldTrigger('See [ordinary @s')).toBe(true);
		expect(shouldTrigger('See [ordinary @s]', 'See [ordinary @s'.length, 's')).toBe(false);
	});

	test('uses a bounded lexical citation window without weakening common exclusions', () => {
		for (const text of [
			'`[@s]`',
			'[label](@s)',
			'[discussion @s]',
			'person@example.com',
			'café@example.com',
			'café@example.com',
			'é@s',
			'é@s',
			'\\@s',
		]) {
			const offset = text.indexOf('@') + 2;
			expect(shouldTrigger(text, offset, text[offset - 1])).toBe(false);
		}

		const largePrefix = 'ordinary prose\n'.repeat(2_000);
		for (const suffix of ['\\@s', 'person@s', '`@s`', '[label](@s)']) {
			const largeExcluded = largePrefix + suffix;
			const excludedOffset = largeExcluded.indexOf('@s') + 2;
			expect(shouldTrigger(largeExcluded, excludedOffset, 's')).toBe(false);
		}

		const text = ('ordinary prose\n'.repeat(100_000)) + 'See [@s]';
		const offset = text.length - 1;
		const started = performance.now();
		expect(shouldTrigger(text, offset, 's')).toBe(true);
		expect(performance.now() - started).toBeLessThan(250);
	});

	test('uses actual context at exact large-document window boundaries', () => {
		const windowSize = 16_384;
		const backtick = String.fromCharCode(96);
		const prefix = 'ordinary prose\n'.repeat(2_000);
		const atBoundary = (
			opening: string,
			beforeAt: string,
			afterAt: string,
		): string => {
			const padding = windowSize - opening.length - beforeAt.length - 2;
			return opening + 'x'.repeat(padding) + beforeAt + '@s' + afterAt;
		};
		const code = atBoundary(backtick, ' ', backtick);
		const link = atBoundary('[', '](', ')');
		const cases = [
			{ predecessor: 'x', structure: code, expected: false },
			{ predecessor: '\\', structure: code, expected: true },
			{ predecessor: '\\'.repeat(2), structure: code, expected: false },
			{ predecessor: 'x', structure: link, expected: false },
			{ predecessor: '\\', structure: link, expected: true },
			{ predecessor: '\\'.repeat(2), structure: link, expected: false },
			{
				predecessor: '\\',
				structure: atBoundary(backtick, ' \\', backtick),
				expected: false,
			},
			{
				predecessor: '\\',
				structure: atBoundary(backtick, ' person', backtick),
				expected: false,
			},
			{
				predecessor: '\\',
				structure: atBoundary('[', backtick, backtick + ']'),
				expected: false,
			},
			{
				predecessor: '\\',
				structure: atBoundary('[', '[label](', ')]'),
				expected: false,
			},
		];
		for (const { predecessor, structure, expected } of cases) {
			const text = prefix + predecessor + structure;
			const offset = text.lastIndexOf('@s') + 2;
			expect(offset - windowSize).toBe(prefix.length + predecessor.length);
			expect(shouldTrigger(text, offset, 's')).toBe(expected);
		}
	});

	test('auto-suggests citekeys in closed and provisional nocite values', () => {
		for (const scalar of [
			"---\nnocite: '@s'\n---\n",
			"---\ntitle: Draft\nnocite: '@s'",
		]) {
			expect(shouldTrigger(scalar, scalar.lastIndexOf("'"), 's')).toBe(true);
		}
		const block = '---\nnocite: |\n  @s\n---\n';
		expect(shouldTrigger(block, block.indexOf('\n---'), 's')).toBe(true);
		for (const other of [
			"---\ntitle: '@s'\n---\n",
			"---\ntitle: '@s'",
		]) {
			expect(shouldTrigger(other, other.lastIndexOf("'"), 's')).toBe(false);
		}
	});

	test('keeps citation auto-suggest in thematic-break bodies without a mapping', () => {
		const text = '---\nBody prose @s';
		expect(shouldTrigger(text, text.length, 's')).toBe(true);
	});

	test('keeps citation auto-suggest in no-blank-line body prose after a mapping-like line', () => {
		const text = '---\nNote: prose\nBody cites @s';
		expect(shouldTrigger(text, text.length, 's')).toBe(true);
	});

	test('preserves CSL value auto-suggest', () => {
		const text = '---\ncsl: ap\n---\n';
		const offset = text.indexOf('ap') + 2;
		expect(shouldTrigger(text, offset, 'p')).toBe(true);
	});
});
