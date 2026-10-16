import { describe, expect, test } from 'bun:test';
import { computeCodeRegions, computeMarkdownRegions, formatHighlightLimit } from './code-regions';
import { editorBlocks } from './editor-blocks';
import { fastestRun } from './test-timing';

describe('editorBlocks', () => {
	/** The text from each offset to the limit at it */
	const reach = (text: string) => {
		const blocks = editorBlocks(text);
		return (offset: number) => text.slice(offset, blocks.limitAt(offset));
	};
	/** The characters of `text` for which `read` holds, others as dots */
	const marked = (text: string, read: (offset: number) => boolean) => [...text].map((char, at) => read(at) ? char : '.').join('');

	test('reads code where computeCodeRegions finds it', () => {
		const text = 'a `x == y` b\r\n\r\n```\n{++\n```\n\n    keep if x == 1\n';
		expect(editorBlocks(text).codeRegions).toEqual(computeCodeRegions(text));
	});

	test('reads a paragraph\'s end where formatHighlightLimit does, where preprocessing joins no lines, and a table\'s cell\'s', () => {
		const text = '# a\nb ==\nc\n\n- d\n\n| e |\n|---|\n| f | g |\n';
		const blocks = editorBlocks(text);
		const limitAt = formatHighlightLimit(text, computeMarkdownRegions(text, { inlineBlocks: true }).inlineBlocks);
		// The next | on a table's row
		const cellEnd = (offset: number) => offset < text.indexOf('| e') || offset >= text.length || text[offset] === '\n' ? Infinity : text.indexOf('|', offset);
		for (let offset = 0; offset <= text.length; offset++) expect(blocks.limitAt(offset)).toBe(Math.min(limitAt(offset), cellEnd(offset)));
	});

	test('reads no end of a block where a span\'s lines are joined, as export reads none there', () => {
		// The text's parse reads a heading, then a paragraph
		expect(reach('{++a\n# b++} ==c\nd==\n')(12)).toBe('==c\nd==\n');
		expect(reach('{>>a\n# b<<} ==c\nd==\n\ne')(12)).toBe('==c\nd==\n');
		expect(reach('{++a\r\n# b++} ==c\r\nd==\r\n')(13)).toBe('==c\r\nd==\r\n');
		// A table's rows
		expect(reach('{++a\n| b |\n| - |\n++} ==c\nd==\n')(21)).toBe('==c\nd==\n');
	});

	test('reads the end of a table\'s cell that a span across rows, which preprocessing leaves as it is, holds', () => {
		const text = '| x == y |\n|---|\n| ==b {++c |\n| d++} ==e== |\n';
		expect(reach(text)(text.indexOf('==b'))).toBe('==b {++c ');
	});

	test('reads the end of a block both parses read, where a span\'s fence line flips the fences after it', () => {
		const text = '{--a\n```\n--}\n\n==x\n```\n\n==y==\n';
		// The text's parse reads a fenced block from the span's second line to
		// ==x's next; export's reads one from there to the end
		expect(reach(text)(text.indexOf('==x'))).toBe('==x\n');
		expect(reach(text)(text.indexOf('==y'))).toBe('==y==\n');
	});

	test('reads the end of a table\'s cell, on a row that preprocessing writes as it is, as export reads each cell alone', () => {
		const text = '| a | b |\n|---|---|\n| ==x | y== \\| z |\n\n{++a\n| b |\n| - |\n++} ==c | d==\n';
		expect(reach(text)(text.indexOf('==x'))).toBe('==x ');
		// A | after a backslash is the cell's text
		expect(reach(text)(text.indexOf(' y=='))).toBe(' y== \\| z ');
		// Export reads the row a span joins as a paragraph's line
		expect(reach(text)(text.indexOf('==c'))).toBe('==c | d==\n');
	});

	test('reads no end of a block before an opener moved past its line\'s end, as the text\'s parse reads none', () => {
		const text = '==a x {++\nb++} c==';
		expect(reach(text)(0)).toBe(text);
	});

	test('reads HTML blocks, the lines from a link\'s definition to a blank line and a quote\'s lazy line as unsure', () => {
		const text = '<div>\nx\n</div>\n\n[1]: u\n  "t"\n\n[^2]: n\n\nA `\n\nb `c\n\n`e` f\n\n```\ng\n```\n';
		const blocks = editorBlocks(text);
		expect(marked(text, offset => blocks.unsure(offset, offset + 1)))
			.toBe('<div>\nx\n</div>\n.[1]: u\n  "t"\n.[^2]: n\n' + '.'.repeat(text.length - text.indexOf('\nA `')));
		expect(blocks.unsure(0, text.length)).toBe(true);
		// A definition before an HTML block
		expect(editorBlocks('[1]: u\n\n<div>\n</div>\n').unsure(0, 1)).toBe(true);
		// A quote's lazy line, before which export ends the quote
		const lazy = '> a ==h\nb==\n\n# x\n';
		const lazyBlocks = editorBlocks(lazy);
		expect(marked(lazy, offset => lazyBlocks.unsure(offset, offset + 1))).toBe('........b==\n.....');
		expect(blocks.unsure(text.indexOf('`e`'), text.length)).toBe(false);
	});

	test('reads the paragraphs that hold an == export may read as text, and those a code span whose backticks pair across blocks starts and ends in', () => {
		const text = 'a `x == y` b\n\nc == d\n\ne <f> ==\n\n[g ==] h\n\n[i](j==) k\n\n$l$ m ==\n\nn \\<o ==\n\nA `\n\nb `c\n\n`p` q ==\n';
		const blocks = editorBlocks(text);
		expect(marked(text, blocks.inertMarks))
			.toBe('a `x == y` b\n.........e <f> ==\n.[g ==] h\n.[i](j==) k\n.$l$ m ==\n...........A `\n.b `c\n..........');
	});

	test('reads the openers export may read as text', () => {
		const text = 'a `{++` {++b++} <!-- {-- --> [{>>] ~~ `~~` $ {#c>> `<!--` {==\n\nd {/c}\n';
		const blocks = editorBlocks(text);
		expect(marked(text, blocks.inertOpener))
			.toBe('...{.................{........{....~...~.....{......<.....{...........');
	});

	// Each line is read on its own, so a label that runs past a line feed, a
	// carriage return or a Unicode line separator, which a pattern over the
	// text with the m flag tried again after, reads the rest of the text once
	test.each<[string, (n: number) => string]>([
		['an unclosed label of a link\'s definition on each line, with carriage returns', n => '[unclosed reference\r'.repeat(n) + '\r==real=='],
		['unclosed labels of links\' definitions between Unicode line separators', n => '[unclosed reference\u2028'.repeat(n)],
		['unclosed labels of links\' definitions between paragraph separators', n => '[unclosed reference\u2029'.repeat(n)],
	])('reads %s in linear time', (_name, input) => {
		const text = input(50_000);
		expect(fastestRun(() => editorBlocks(text))).toBeLessThan(1000);
	}, 120000);

	// Each offset is read from arrays made once, and each block's end, each
	// line's and each unsure region's by binary search
	test.each<[string, (n: number) => string]>([
		['spans over lines', n => '{++a\n# b++} ==c\nd==\n\n'.repeat(n)],
		['spans over lines in a quote', n => '> {++a\n>\n> b++} ==c\n\n'.repeat(n)],
		['HTML blocks and links\' definitions', n => '<div>\n==a== {++b++}\n</div>\n\n[l]: u\n[m]: v\n\n'.repeat(n)],
		['code spans whose backticks pair across blocks', n => 'a `\n\nb `c` d\n\n'.repeat(n)],
		['spans over lines with \\r\\n', n => '{++a\r\n# b++} ==c\r\nd==\r\n\r\n'.repeat(n)],
		// No line that may be a link's definition starts there
		['quotes with lazy lines', n => '> a ==h\nb==\n\n'.repeat(n)],
		['a list item\'s marker before a long run of spaces', n => '- ' + ' '.repeat(2 * n) + 'x\n'],
		['a list item\'s marker before a long run of quote markers', n => '- ' + ' >'.repeat(n) + 'x\n'],
		['table rows with many cells', n => '| a | b |\n|---|---|\n' + '| ==x | y== \\| z |\n'.repeat(n)],
		['code spans and HTML that hold == and openers', n => 'a `x == {++` <b ==c {--> [d ==] $e ~~\n\n'.repeat(n)],
	])('reads %s in linear time', (_name, input) => {
		const text = input(50_000);
		expect(fastestRun(() => {
			const blocks = editorBlocks(text);
			for (let offset = 0; offset < text.length; offset += 7) {
				blocks.limitAt(offset);
				blocks.unsure(offset, offset + 7);
				blocks.inertMarks(offset);
				blocks.inertOpener(offset);
			}
		})).toBeLessThan(2000);
	}, 120000);
});
