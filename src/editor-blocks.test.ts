import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { computeCodeRegions, computeMarkdownRegions, formatHighlightLimit } from './code-regions';
import { LINE_PLACEHOLDER, PARA_PLACEHOLDER, preprocessCriticMarkup, preprocessCriticMarkupWithOffsets } from './critic-markup';
import { editorBlocks } from './editor-blocks';
import { fastestRun } from './test-timing';

describe('preprocessCriticMarkupWithOffsets', () => {
	/** For each character of the output, the character of `markdown` it comes from */
	const sources = (markdown: string) => {
		const { output, offsets } = preprocessCriticMarkupWithOffsets(markdown);
		return [...output].map((char, at) => [char, markdown[offsets![at]] ?? ''].join(''));
	};

	test('reads no offsets where preprocessing writes the text as it is', () => {
		for (const markdown of ['plain', 'a {++b++} c', '`{++a\nb++}`', '']) {
			expect(preprocessCriticMarkupWithOffsets(markdown)).toEqual({ output: markdown });
		}
	});

	test('maps a line end in a span to its placeholder', () => {
		const { output, offsets } = preprocessCriticMarkupWithOffsets('a {++b\nc++} d');
		expect(output).toBe('a {++b' + LINE_PLACEHOLDER + 'c++} d');
		expect([...offsets!]).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 7, 8, 9, 10, 11, 12, 13]);
	});

	test('maps a blank line in a span to its first line end, past a quote\'s markers', () => {
		const { output, offsets } = preprocessCriticMarkupWithOffsets('> {++a\n>\n> b++}');
		expect(output).toBe('> {++a' + PARA_PLACEHOLDER + 'b++}');
		expect([...offsets!]).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 11, 12, 13, 14, 15]);
	});

	test('maps the characters of a line after a quote\'s markers', () => {
		expect(sources('> a {++b\n> c++}').slice(8)).toEqual([...LINE_PLACEHOLDER].map(char => char + '\n').concat(['cc', '++', '++', '}}']));
	});

	test('maps the blank line put before an opener moved past its line\'s end to the opener', () => {
		const { output, offsets } = preprocessCriticMarkupWithOffsets('x {++\nb++}');
		expect(output).toBe('x \n\n{++b++}');
		expect([...offsets!]).toEqual([0, 1, 2, 2, 2, 3, 4, 6, 7, 8, 9, 10]);
		// In a quote, with its markers
		const quoted = preprocessCriticMarkupWithOffsets('> x {++\n> b++}');
		expect(quoted.output).toBe('> x \n>\n> {++b++}');
		expect([...quoted.offsets!]).toEqual([0, 1, 2, 3, 4, 4, 4, 4, 4, 4, 5, 6, 10, 11, 12, 13, 14]);
	});

	test('writes what preprocessCriticMarkup writes, from offsets in order, each copied character from its own', () => {
		const piece = fc.constantFrom('a', 'b c', '{++i\nj++}', '{++i\n\nj++}', '{--e\n> f--}', '{>>m\n\n    n<<}', '{~~o\n- p~>q~~}',
			'{==c\n# d==}', 'x {++', '\n', '\n\n', '\n> ', '> ', '- ', '    ', '```\n', '`{++`', '++}', '{#c1>>m\n> n<<}', ' \n \n');
		fc.assert(fc.property(fc.array(piece, { maxLength: 12 }), pieces => {
			const markdown = pieces.join('');
			const { output, offsets } = preprocessCriticMarkupWithOffsets(markdown);
			expect(output).toBe(preprocessCriticMarkup(markdown));
			if (!offsets) return;
			expect(offsets.length).toBe(output.length + 1);
			expect(offsets[output.length]).toBe(markdown.length);
			for (let at = 1; at < offsets.length; at++) expect(offsets[at]).toBeGreaterThanOrEqual(offsets[at - 1]);
			// A character written for another is a placeholder's or a moved
			// opener's line end or marker
			const placeholders = output.replace(/(?:LINE|PARA)/g, placeholder => '\0'.repeat(placeholder.length));
			for (let at = 0; at < output.length; at++) {
				if (placeholders[at] !== '\0' && output[at] !== markdown[offsets[at]]) expect('\n> \t').toContain(output[at]);
			}
		}), { numRuns: 500 });
	});

	test('maps the spans over lines of a long text in linear time', () => {
		for (const markdown of ['{++a\nb++} ==c\nd==\n\n'.repeat(50_000), '> {++a\n> b\n>\n> c++} d\n\n'.repeat(50_000), 'x {++\nb++}\n\n'.repeat(50_000)]) {
			expect(fastestRun(() => preprocessCriticMarkupWithOffsets(markdown))).toBeLessThan(2000);
		}
	}, 120000);
});

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
		const blocks = editorBlocks(text);
		expect(blocks.codeRegions).toEqual(computeCodeRegions(text));
		expect(marked(text, blocks.inCode)).toBe('..`x == y`......```\n{++\n```..    keep if x == 1.');
	});

	test('reads a paragraph\'s end where formatHighlightLimit does', () => {
		const text = '# a\nb ==\nc\n\n- d\n';
		const blocks = editorBlocks(text);
		const limitAt = formatHighlightLimit(text, computeMarkdownRegions(text, { inlineBlocks: true }).inlineBlocks);
		for (let offset = 0; offset <= text.length; offset++) expect(blocks.limitAt(offset)).toBe(limitAt(offset));
	});

	test('reads the lines a span over a line end joins as one paragraph, as export does', () => {
		// The parse of the text reads a heading, then a paragraph
		expect(reach('{++a\n# b++} ==c\nd==\n')(12)).toBe('==c\nd==\n');
		expect(reach('{>>a\n# b<<} ==c\nd==\n\ne')(12)).toBe('==c\nd==\n');
		expect(reach('{++a\r\n# b++} ==c\r\nd==\r\n')(13)).toBe('==c\r\nd==\r\n');
		// A table's rows
		expect(reach('{++a\n| b |\n| - |\n++} ==c\nd==\n')(21)).toBe('==c\nd==\n');
	});

	test('reads a fence line in a span as text, and the next as opening a block', () => {
		const text = '{--a\n```\n--}\n\n==x\n```\n\n==y==\n';
		const blocks = editorBlocks(text);
		// The parse of the text reads a fenced block from the span's second
		// line to ==x's next; export reads one from there to the end
		expect(marked(text, blocks.inCode)).toBe('.'.repeat(text.indexOf('```\n\n')) + '```\n\n==y==.');
		expect(reach(text)(text.indexOf('==x'))).toBe('==x\n');
	});

	test('ends the paragraph before an opener moved past its line\'s end, as export does', () => {
		const text = '==a x {++\nb++} c==';
		expect(reach(text)(0)).toBe('==a x ');
	});

	test('reads an HTML block and a link\'s definition as holding no Markdown, but not a note\'s', () => {
		const text = '<div>\n{++a++}\n</div>\n\n[1]: {==b==}\n\n[^1]: {--c--}\n\n`d`\n';
		const blocks = editorBlocks(text);
		expect(marked(text, blocks.inert)).toBe('<div>\n{++a++}\n</div>\n.[1]: {==b==}\n' + '.'.repeat(16) + '`d`.');
		expect(marked(text, blocks.inCode)).toBe('.'.repeat(text.length - 4) + '`d`.');
	});

	test('reads a link\'s definition with a placeholder in it as text, as export does', () => {
		// Joined, its URL holds a placeholder, which no link's does
		const blocks = editorBlocks('[1]:{++i\nj++}\n');
		expect(blocks.inert(5)).toBe(false);
	});

	test('reads the end of each run of code, an HTML block or a link\'s definition', () => {
		const text = 'a `b` c\n\n<div>\n</div>\n';
		const blocks = editorBlocks(text);
		expect([2, 3, 4, 5, 9, 15].map(blocks.inertEnd)).toEqual([5, 5, 5, 5, text.length, text.length]);
	});

	// Each offset is mapped from arrays made once, and each paragraph's end
	// found by binary search
	test.each<[string, (n: number) => string]>([
		['spans over lines', n => '{++a\n# b++} ==c\nd==\n\n'.repeat(n)],
		['spans over lines in a quote', n => '> {++a\n>\n> b++} ==c\n\n'.repeat(n)],
		['HTML blocks and links\' definitions', n => '<div>\n==a== {++b++}\n</div>\n\n[l]: u\n\n'.repeat(n)],
		['spans over lines with \\r\\n', n => '{++a\r\n# b++} ==c\r\nd==\r\n\r\n'.repeat(n)],
	])('reads %s in linear time', (_name, input) => {
		const text = input(50_000);
		expect(fastestRun(() => {
			const blocks = editorBlocks(text);
			for (let offset = 0; offset < text.length; offset += 7) blocks.limitAt(offset);
			blocks.inertEnd(0);
		})).toBeLessThan(2000);
	}, 120000);
});
