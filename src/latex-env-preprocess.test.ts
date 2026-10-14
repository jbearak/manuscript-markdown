import { describe, test, expect } from 'bun:test';
import { wrapBareLatexEnvironments, wrapBareLatexEnvironmentsWithLines, DISPLAY_MATH_ENVIRONMENTS } from './latex-env-preprocess';
import { fastestRun } from './test-timing';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { renderWithPlugin } from './test-helpers';

describe('wrapBareLatexEnvironments', () => {
	test('wraps a bare equation environment', () => {
		const input = '\\begin{equation}\nx = 1\n\\end{equation}';
		expect(wrapBareLatexEnvironments(input)).toBe(
			'$$\\begin{equation}\nx = 1\n\\end{equation}$$'
		);
	});

	// A backslash and two dollar signs: an escaped dollar sign, which opens
	// no math, and a dollar sign
	const escaped = '\\$' + '$';
	const display = '$' + '$';
	test.each([
		['in it', '\\begin{equation}\na ' + escaped + ' b\n\\end{equation}\n'],
		['before it and after it', 'Costs ' + escaped + '5.\n\n\\begin{equation}\na\n\\end{equation}\n\nAnd ' + escaped + '6.\n'],
		['before it, with display math after it', 'Costs ' + escaped + '5.\n\n\\begin{equation}\na\n\\end{equation}\n\n' + display + 'x' + display + '\n'],
	])('wraps an environment with an escaped dollar sign before a dollar sign %s', (_name, input) => {
		// The scan for display math paired the escaped one's two with the
		// next two, so the environment between them was left as it was
		const result = wrapBareLatexEnvironments(input);
		expect(result).toContain(display + '\\begin{equation}');
		expect(result).toContain('\\end{equation}' + display);
	});

	test('leaves an environment in display math with an escaped dollar sign before a dollar sign before it in the math', () => {
		// Which closes no math, so the environment is the math's
		const input = display + '\na ' + escaped + '\n\\begin{equation}\nx\n\\end{equation}\n' + display + '\n';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('wraps a bare align* environment', () => {
		const input = '\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}';
		expect(wrapBareLatexEnvironments(input)).toBe(
			'$$\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}$$'
		);
	});

	test('wraps all known display-math environments', () => {
		for (const env of DISPLAY_MATH_ENVIRONMENTS) {
			const input = '\\begin{' + env + '}\ncontent\n\\end{' + env + '}';
			const result = wrapBareLatexEnvironments(input);
			expect(result).toContain('$$\\begin{' + env + '}');
			expect(result).toContain('\\end{' + env + '}$$');
		}
	});

	test('wraps environment with up to 3 spaces indent', () => {
		const input = '   \\begin{equation}\n   x = 1\n   \\end{equation}';
		const result = wrapBareLatexEnvironments(input);
		expect(result).toContain('$$\\begin{equation}');
		expect(result).toContain('\\end{equation}$$');
	});

	test('wraps multi-line environment with blank lines (collapses them)', () => {
		const input = '\\begin{align}\na &= b \\\\\n\nc &= d\n\\end{align}';
		const result = wrapBareLatexEnvironments(input);
		expect(result).toBe('$$\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}$$');
	});

	test('collapses 3+ consecutive newlines to a single newline', () => {
		const input = '\\begin{align}\na &= b \\\\\n\n\nc &= d\n\\end{align}';
		const result = wrapBareLatexEnvironments(input);
		expect(result).toBe('$$\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}$$');
	});

	test('wraps nested environments (equation wrapping aligned)', () => {
		const input = '\\begin{equation}\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\end{equation}';
		const result = wrapBareLatexEnvironments(input);
		expect(result).toBe(
			'$$\\begin{equation}\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\end{equation}$$'
		);
	});

	test('handles multiple environments in one document', () => {
		const input = 'Text before\n\n\\begin{equation}\nx = 1\n\\end{equation}\n\nMiddle text\n\n\\begin{align}\na &= b\n\\end{align}\n\nText after';
		const result = wrapBareLatexEnvironments(input);
		expect(result).toContain('$$\\begin{equation}\nx = 1\n\\end{equation}$$');
		expect(result).toContain('$$\\begin{align}\na &= b\n\\end{align}$$');
		expect(result).toContain('Text before');
		expect(result).toContain('Middle text');
		expect(result).toContain('Text after');
	});

	test('does NOT wrap unknown environments (figure, document)', () => {
		const input = '\\begin{figure}\ncontent\n\\end{figure}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside fenced code blocks', () => {
		const input = '```\n\\begin{equation}\nx = 1\n\\end{equation}\n```';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside inline code', () => {
		const input = 'Use `\\begin{equation}...\\end{equation}` for display math';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside HTML comments', () => {
		const input = '<!-- \\begin{equation}\nx = 1\n\\end{equation} -->';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside existing $$ blocks', () => {
		const input = '$$\n\\begin{equation}\nx = 1\n\\end{equation}\n$$';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside CriticMarkup additions', () => {
		const input = '{++\n\\begin{equation}\nx = 1\n\\end{equation}\n++}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside CriticMarkup deletions', () => {
		const input = '{--\n\\begin{equation}\nx = 1\n\\end{equation}\n--}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside CriticMarkup comments', () => {
		const input = '{>>\n\\begin{equation}\nx = 1\n\\end{equation}\n<<}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside CriticMarkup highlights', () => {
		const input = '{==\n\\begin{equation}\nx = 1\n\\end{equation}\n==}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does NOT wrap inside CriticMarkup substitutions', () => {
		const input = '{~~\n\\begin{equation}\nx = 1\n\\end{equation}\n~>new~~}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('fast path: text without \\begin{ is unchanged', () => {
		const input = 'Just some text with $x = 1$ and $$y = 2$$';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('does not wrap \\begin with 4+ spaces indent (code block by CommonMark rules)', () => {
		const input = '    \\begin{equation}\n    x = 1\n    \\end{equation}';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});

	test('wraps environment preceded by text on previous line', () => {
		const input = 'Consider:\n\\begin{equation}\nx = 1\n\\end{equation}';
		const result = wrapBareLatexEnvironments(input);
		expect(result).toBe('Consider:\n$$\\begin{equation}\nx = 1\n\\end{equation}$$');
	});

	test('does not double-wrap already-wrapped environments', () => {
		const input = '$$\\begin{equation}\nx = 1\n\\end{equation}$$';
		expect(wrapBareLatexEnvironments(input)).toBe(input);
	});
});

describe('wrapBareLatexEnvironments in time linear in the text', () => {
	// Each environment was checked against the zones to leave alone from the
	// first, searched the text to its end for its \end where none was, and
	// built the text again with its block wrapped, and each opener of a
	// comment or a CriticMarkup span without its end searched the text to
	// its end, so a text of many took time in the square of their number
	test.each([
		['environments between code spans', 'a `c` b\n\n\\begin{equation}\nx\n\\end{equation}\n\n', 2],
		['environments without their ends', '\\begin{equation}\nx\n\n', 0],
		['CriticMarkup openers without their closers', 'p {++ a\n\n\\begin{equation}\nx\n\\end{equation}\n\n', 2],
		// Each searched for its matching <<} to the text's end
		['CriticMarkup comments without their closers', 'p {>> a {#a>> b {>> c {#b>> d {>> e {#c>> f\n\n\\begin{equation}\nx\n\\end{equation}\n\n', 2],
		['comments without their ends', 'p <!-- a\n\n\\begin{equation}\nx\n\\end{equation}\n\n', 2],
		// Each skipped as in code, with closers after the environment
		['openers in code blocks', '```\n<!--\n{++\n{>>\n{#a>>\n```\n\n\\begin{equation}\nx\n\\end{equation}\n\n<!-- c --> ++} <<}\n\n', 2],
	])('wraps a text of %s', (_name, unit, wrapped) => {
		expect(wrapBareLatexEnvironments(unit.repeat(2)).split('$' + '$').length - 1).toBe(wrapped * 2);
		const time = (n: number) => {
			const text = unit.repeat(n);
			return fastestRun(() => wrapBareLatexEnvironmentsWithLines(text));
		};
		time(4000);
		const small = time(4000);
		expect(time(16000) / small).toBeLessThan(8);
	}, 60000);
});

describe('a bare environment after an opener in a code block', () => {
	const env = '\\begin{equation}\nx\n\\end{equation}';
	const display = '$' + '$';
	// An opener in a code block, and a closer after the environment, a
	// directive's own --> too
	const cases: Array<[string, string]> = [
		['an HTML comment\'s opener in a fenced code block', '```\n<!--\n```\n\n' + env + '\n\n<!-- landscape -->\n\nText\n\n<!-- /landscape -->\n'],
		['an HTML comment\'s opener after a > in a fenced code block', '```\nx > y\n<!--\n```\n\n' + env + '\n\n<!-- c -->\n'],
		['an HTML comment\'s opener in an indented code block', '    <!--\n\n' + env + '\n\n<!-- c -->\n'],
		['an insertion\'s opener in a fenced code block', '```\n{++\n```\n\n' + env + '\n\nz ++}\n'],
		['a deletion\'s opener in an indented code block', '    {--\n\n' + env + '\n\nz --}\n'],
		['a CriticMarkup comment\'s opener in a fenced code block', '```\n{>>\n```\n\n' + env + '\n\nz <<}\n'],
		['a CriticMarkup comment\'s opener by ID in a fenced code block', '```\n{#a>>\n```\n\n' + env + '\n\nz <<}\n'],
	];

	test.each(cases)('wraps it after %s, which is the code\'s text', (_name, md) => {
		// The scan read the opener as one, so its zone, to the closer after
		// the environment, held the environment, which export wrote as text
		expect(wrapBareLatexEnvironments(md)).toContain(display + env + display);
	});

	test.each(cases)('exports it after %s as an equation, which the preview shows', async (_name, md) => {
		const { docx } = await convertMdToDocx(md);
		const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
		expect(xml).toContain('<m:oMath');
		expect(xml).not.toContain('begin{equation}');
		const once = (await convertDocx(docx)).markdown;
		expect(once).toContain(display + '\nx\n' + display);
		expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
		expect(renderWithPlugin(md)).toContain(display + env + display);
	});

	// The code regions read no HTML, math, links or blocks' ends, so they
	// pair a backtick in a construct export reads first, or in a block
	// before, with a later one, in a comment's or a span's text, whose
	// opener export reads. An opener in a code span is left as on main
	test.each([
		['in another comment', 'p <!-- ` --> <!-- `\n' + env + '\n-->\n'],
		['in a tag\'s attribute, before a comment', '<b title="`"> <!-- c `\n' + env + '\n-->\n'],
		['in a tag\'s attribute, before an insertion', '<b title="`"> {++c `\n' + env + '\n++}\n'],
		['in an equation', '$a`b$ <!-- c `\n' + env + '\n-->\n'],
		['in a link\'s destination', '[a](x`y) {++ c `\n' + env + '\n++}\n'],
		['in a highlight', '==a`b== <!-- c `\n' + env + '\n-->\n'],
		['in an insertion', '{++a`b++} <!-- c `\n' + env + '\n-->\n'],
		['in a citation', '[@a`b] <!-- c `\n' + env + '\n-->\n'],
		['in a heading before', '# h `\n\np <!-- c `\n' + env + '\n-->\n'],
		['in a link linkify reads', 'http://x.org/` <!-- c `\n' + env + '\n-->\n'],
	])('leaves it in a comment or a span after a backtick %s, as before', async (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const once = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
		expect(once).toContain('begin{equation}');
		expect(once).not.toContain(display);
		expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
		expect(renderWithPlugin(md)).not.toContain(display);
	});

	test.each([
		['an HTML comment', '```\n<!--\n```\n\n<!--\n' + env + '\n-->\n'],
		['an insertion', '```\n{++\n```\n\n{++\n' + env + '\n++}\n'],
		['a CriticMarkup comment by ID', '```\n{#a>>\n```\n\n{#a>>\n' + env + '\n<<}\n'],
	])('leaves it in %s after the same opener in a code block, as before', (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});
});
