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

	test('reads code where computeCodeRegions finds it, and the end of each run of it', () => {
		const text = 'a `x == y` b\r\n\r\n```\n{++\n```\n\n    keep if x == 1\n';
		const blocks = editorBlocks(text);
		expect(blocks.codeRegions).toEqual(computeCodeRegions(text));
		expect(marked(text, blocks.inCode)).toBe('..`x == y`......```\n{++\n```..    keep if x == 1.');
		expect([0, 2, 9, 10, text.indexOf('```')].map(blocks.codeEnd)).toEqual([0, 10, 10, 10, text.indexOf('```\n\n') + 3]);
	});

	test('reads a paragraph\'s end where formatHighlightLimit does, where preprocessing joins no lines', () => {
		const text = '# a\nb ==\nc\n\n- d\n\n| e |\n|---|\n| f |\n';
		const blocks = editorBlocks(text);
		const limitAt = formatHighlightLimit(text, computeMarkdownRegions(text, { inlineBlocks: true }).inlineBlocks);
		for (let offset = 0; offset <= text.length; offset++) expect(blocks.limitAt(offset)).toBe(limitAt(offset));
	});

	test('reads no end of a block where a span\'s lines are joined, as export reads none there', () => {
		// The text's parse reads a heading, then a paragraph
		expect(reach('{++a\n# b++} ==c\nd==\n')(12)).toBe('==c\nd==\n');
		expect(reach('{>>a\n# b<<} ==c\nd==\n\ne')(12)).toBe('==c\nd==\n');
		expect(reach('{++a\r\n# b++} ==c\r\nd==\r\n')(13)).toBe('==c\r\nd==\r\n');
		// A table's rows
		expect(reach('{++a\n| b |\n| - |\n++} ==c\nd==\n')(21)).toBe('==c\nd==\n');
	});

	test('reads the end of a table\'s row that a span across rows, which preprocessing leaves as it is, holds', () => {
		const text = '| x == y |\n|---|\n| ==b {++c |\n| d++} ==e== |\n';
		expect(reach(text)(text.indexOf('==b'))).toBe('==b {++c |\n');
	});

	test('reads the end of a block both parses read, where a span\'s fence line flips the fences after it', () => {
		const text = '{--a\n```\n--}\n\n==x\n```\n\n==y==\n';
		// The text's parse reads a fenced block from the span's second line to
		// ==x's next; export's reads one from there to the end
		expect(reach(text)(text.indexOf('==x'))).toBe('==x\n');
		expect(reach(text)(text.indexOf('==y'))).toBe('==y==\n');
	});

	test('reads no end of a block before an opener moved past its line\'s end, as the text\'s parse reads none', () => {
		const text = '==a x {++\nb++} c==';
		expect(reach(text)(0)).toBe(text);
	});

	test('reads HTML blocks, the lines from a link\'s definition to a blank line, and code spans whose backticks pair across blocks as unsure', () => {
		const text = '<div>\nx\n</div>\n\n[1]: u\n  "t"\n\n[^2]: n\n\nA `\n\nb `c\n\n`e` f\n\n```\ng\n```\n';
		const blocks = editorBlocks(text);
		expect(marked(text, offset => blocks.unsure(offset, offset + 1)))
			.toBe('<div>\nx\n</div>\n.[1]: u\n  "t"\n.[^2]: n\n...`\n\nb `' + '.'.repeat(text.length - text.indexOf('c\n\n`e`')));
		expect(blocks.unsure(0, text.length)).toBe(true);
		// A definition before an HTML block
		expect(editorBlocks('[1]: u\n\n<div>\n</div>\n').unsure(0, 1)).toBe(true);
		expect(blocks.unsure(text.indexOf('`e`'), text.length)).toBe(false);
	});

	// Each offset is read from arrays made once, and each block's end, each
	// line's and each unsure region's by binary search
	test.each<[string, (n: number) => string]>([
		['spans over lines', n => '{++a\n# b++} ==c\nd==\n\n'.repeat(n)],
		['spans over lines in a quote', n => '> {++a\n>\n> b++} ==c\n\n'.repeat(n)],
		['HTML blocks and links\' definitions', n => '<div>\n==a== {++b++}\n</div>\n\n[l]: u\n[m]: v\n\n'.repeat(n)],
		['code spans whose backticks pair across blocks', n => 'a `\n\nb `c` d\n\n'.repeat(n)],
		['spans over lines with \\r\\n', n => '{++a\r\n# b++} ==c\r\nd==\r\n\r\n'.repeat(n)],
	])('reads %s in linear time', (_name, input) => {
		const text = input(50_000);
		expect(fastestRun(() => {
			const blocks = editorBlocks(text);
			for (let offset = 0; offset < text.length; offset += 7) {
				blocks.limitAt(offset);
				blocks.unsure(offset, offset + 7);
			}
			blocks.codeEnd(0);
		})).toBeLessThan(2000);
	}, 120000);
});
