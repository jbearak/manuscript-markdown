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

describe('a stray fence of two dollar signs before display math', () => {
	const D = '$' + '$';
	const aligned = '\\begin{aligned}\na &= b\n\\end{aligned}';
	const equation = D + '\n' + aligned + '\n' + D + '\n';
	// Each fence in the text paired with the next, so one that opens no
	// equation paired with the opening fence of the display math after it,
	// whose environment, out of each zone, was wrapped again: Word got an
	// empty equation, the environment as text, and another empty one
	const strays: Array<[string, string]> = [
		['in a fenced code block', '```\nx = ' + D + '\n```\n'],
		['in a fenced code block of ~', '~~~sh\necho ' + D + '\n~~~\n'],
		['in an indented code block', '    echo ' + D + '\n'],
		['in a code span', 'Use `' + D + '` here.\n'],
		['in an HTML comment', '<!-- ' + D + ' -->\n'],
		['in an HTML comment in a paragraph', 'Text <!-- ' + D + ' --> more.\n'],
		['in a line of text', 'A ' + D + ' sign.\n'],
		['in a heading', '# Cost ' + D + '\n'],
		['in a list item', '- a ' + D + '\n'],
		['in a quote', '> a ' + D + '\n'],
		['in a table\'s cell', '| a ' + D + ' | b |\n| - | - |\n| c | d |\n'],
		['in an HTML block', '<div>\nx ' + D + '\n</div>\n'],
		['between two inline equations', '$x' + D + 'y$\n'],
		['in an insertion', '{++a ' + D + ' b++}\n'],
		['in a CriticMarkup comment', 'Text{>>a ' + D + '<<}.\n'],
	];

	test.each(strays)('leaves an environment in it as it is after one %s', (_name, stray) => {
		const md = stray + '\n' + equation + '\n' + D + '\nx\n' + D + '\n\n' + equation;
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});

	test.each(strays)('wraps a bare environment after one %s', (_name, stray) => {
		// Which an unclosed fence's zone, to the text's end, held
		const md = stray + '\n\\begin{equation}\nx\n\\end{equation}\n';
		expect(wrapBareLatexEnvironments(md)).toContain(D + '\\begin{equation}\nx\n\\end{equation}' + D);
	});

	test.each(strays.filter(([name]) => ['in a fenced code block', 'in an indented code block', 'in a code span', 'in an HTML comment', 'in a line of text', 'between two inline equations'].includes(name)))(
		'exports each equation with an environment after one %s as that equation, which the preview shows', async (_name, stray) => {
			const md = stray + '\n' + equation + '\nText.\n\n' + equation;
			const { docx } = await convertMdToDocx(md);
			const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
			const equations = [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(match => match[1]);
			// Each display equation's, and the two inline equations' one
			expect(equations).toHaveLength(stray.startsWith('$x') ? 3 : 2);
			for (const omml of equations) expect(omml).toMatch(/<m:t[^>]*>[^<]*\S/);
			expect(xml).not.toContain('begin{aligned}');
			const once = (await convertDocx(docx)).markdown;
			expect(once.split(equation).length - 1).toBe(2);
			expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
			expect(renderWithPlugin(md)).not.toContain(D + '\\begin{aligned}');
		});

	test('leaves an environment in display math as it is after a run of three dollar signs in a line of text', () => {
		const md = 'Run ' + D + '$ here.\n\n' + equation;
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});

	// As on main
	test.each([
		['in a list item', '- ' + D + '\n  ' + aligned.replace(/\n/g, '\n  ') + '\n  ' + D + '\n'],
		['in a quote', '> ' + D + '\n> ' + aligned.replace(/\n/g, '\n> ') + '\n> ' + D + '\n'],
		['in a note, read as a whole', 'Text[^1].\n\n[^1]: ' + D + '\n    ' + aligned.replace(/\n/g, '\n    ') + '\n    ' + D + '\n'],
		['in a table\'s cell', '| ' + D + 'x' + D + ' | b |\n| - | - |\n| c | d |\n\n' + equation],
		['in an HTML block', '<div>\n' + D + '\n' + aligned + '\n' + D + '\n</div>\n'],
		['with text on its fences\' lines', 'See ' + D + '\n' + aligned + '\n' + D + ' here.\n'],
		['after display math on one line', D + 'x' + D + '\n\n' + equation],
		['after escaped dollar signs', 'Costs \\$\\$ here.\n\n' + equation],
		['with a CriticMarkup span over a blank line in it', D + '\na {++b\n\nc++} d\n' + aligned + '\n' + D + '\n'],
		['with a blank line in the environment', D + '\n' + aligned.replace('\n\\end', '\n\n\\end') + '\n' + D + '\n'],
		['without its closing fence, at the text\'s end', 'Text.\n\n' + D + '\n' + aligned + '\n'],
		['after another', equation + '\n' + equation + '\n' + D + '\nx\n' + D + '\n\n' + equation],
	])('leaves an environment in display math %s as it is', (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});

	test('reads a fence in a code span after the opening fence of display math as its closer, as export does, as before', () => {
		// So the fence after the environment opens no equation
		const md = D + '\na `' + D + '` b\n' + aligned + '\n' + D + '\n';
		expect(wrapBareLatexEnvironments(md)).toBe(D + '\na `' + D + '` b\n' + D + aligned + D + '\n' + D + '\n');
	});

	test.each([
		['after display math', equation + '\n\\begin{equation}\nx\n\\end{equation}\n'],
		['after a note with display math, read as a whole', 'Text[^1].\n\n[^1]: ' + D + '\n    ' + aligned.replace(/\n/g, '\n    ') + '\n    ' + D + '\n\n\\begin{equation}\nx\n\\end{equation}\n'],
		['after inline equations', 'Both $a$ and $b$.\n\n\\begin{equation}\nx\n\\end{equation}\n'],
		['after a table\'s cell with display math', '| ' + D + 'x' + D + ' | b |\n| - | - |\n| c | d |\n\n\\begin{equation}\nx\n\\end{equation}\n'],
	])('wraps a bare environment %s, as before', (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toContain(D + '\\begin{equation}\nx\n\\end{equation}' + D);
	});

	test('leaves an environment in an inline equation over lines as the equation\'s', async () => {
		// Whose text, wrapped, held two fences, which Word showed
		const md = 'The matrix $\n\\begin{pmatrix}\na & b\n\\end{pmatrix}\n$ is invertible.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const once = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
		expect(once).toBe('The matrix $\\begin{pmatrix} a & b \\end{pmatrix}$ is invertible.\n');
	});

	test('wraps an environment after a blank line in display math, which export reads as text, as that environment\'s equation', async () => {
		// The paragraph before it holds the fence before the blank line, as
		// text, and its own the one after it. Before, the two paired
		const md = D + '\nx\n\n' + aligned + '\n' + D + '\n';
		expect(wrapBareLatexEnvironments(md)).toBe(D + '\nx\n\n' + D + aligned + D + '\n' + D + '\n');
		const { docx } = await convertMdToDocx(md);
		const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
		expect(xml).not.toContain('begin{aligned}');
		const once = (await convertDocx(docx)).markdown;
		expect(once).toContain(equation.trimEnd());
		expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
	});
});

describe('dollar signs and backticks as export reads them around a bare environment', () => {
	const D = '$' + '$';
	const aligned = '\\begin{aligned}\na &= b\n\\end{aligned}';
	const bare = '\\begin{equation}\nx\n\\end{equation}';

	// The zones of code spans and comments are found across the text, where
	// a backtick or a <!-- in one paragraph pairs with one in the next, which
	// markdown-it reads as no code span or comment. The read of the
	// equations took that zone's opening fence as code, and the environment
	// in the math, past the zone's end, was wrapped again
	test.each([
		['a backtick', 'A ` tick.\n\n' + D + '\na ` b\n' + aligned + '\n' + D + '\n'],
		['a comment\'s opener', 'a <!-- b\n\n' + D + '\nx --> y\n' + aligned + '\n' + D + '\n'],
	])('leaves an environment in display math after %s in a paragraph before it, which pairs with none there, as before', async (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const { docx } = await convertMdToDocx(md);
		const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
		expect(xml.match(/<m:oMath>/g)).toHaveLength(1);
		expect(xml).not.toContain('begin{aligned}');
	});

	// Which export's inline rules read before its math rule reads the dollar
	// sign, so it opens no equation. The read of the equations took it for
	// one's opener, whose equation, to the inline equation's after the
	// environment, held the environment, which Word got as text
	test.each([
		['in a tag\'s attribute', 'Text <span title="$">cost</span>'],
		['in a tag\'s attribute without quotes', 'Text <span title=$>cost</span>'],
		['in an autolink', 'Mail <http://x.org/$y>'],
		['in a URL', 'Go http://x.org/$y'],
		['in a citation', 'Text [@a, p. $5] b'],
		['in a code span', 'Use `$` here'],
	])('wraps an environment in a paragraph after a dollar sign %s, as before', async (_name, before) => {
		const md = before + '\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(before + '\n' + D + bare + D + '\n$\\alpha$ here.\n');
		const { docx } = await convertMdToDocx(md);
		const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
		expect(xml).not.toContain('begin{equation}');
	});

	test.each([
		['in a link\'s destination', 'See [a](x/$y)'],
		['in a link\'s title', 'See [a](x "t $")'],
		['in an image\'s destination', 'See ![a](x/$y.png)'],
	])('wraps an environment in a paragraph after a dollar sign %s, as before', (_name, before) => {
		const md = before + '\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(before + '\n' + D + bare + D + '\n$\\alpha$ here.\n');
	});

	// Where export reads one, as the math rule reads on past a link's text
	// and a tag's end
	test.each([
		['in a link\'s text', 'See [a $ b](u)'],
		['between tags', 'Text <b>cost $</b>'],
	])('leaves an environment in an inline equation from a dollar sign %s, as before', (_name, before) => {
		const md = before + '\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});
});

describe('equations in a highlight, an image\'s alt and a citation around a bare environment', () => {
	const D = '$' + '$';
	const aligned = '\\begin{aligned}\na &= b\n\\end{aligned}';
	const bare = '\\begin{equation}\nx\n\\end{equation}';
	const wordXml = async (md: string) => {
		const { docx } = await convertMdToDocx(md);
		return (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
	};
	// Word's text, out of its equations
	const wordText = (xml: string) => [...xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');

	// markdown-it parses an image's alt, and citationEnd a citation's first
	// item, as a text of its own, with the read's env. The read took the
	// equations there for the paragraph's, at their offsets in that text,
	// so at the paragraph's start, over the environment there, which Word
	// got as text
	test.each([
		['an equation in an image\'s alt', '![$x$](x.png)'],
		['a fence in an image\'s alt', '![' + D + '](x.png)'],
		['an equation in a citation\'s locator', '[see @ref, $x$]'],
		['an equation in a citation\'s prefix', '[see $x$ @ref]'],
	])('wraps an environment at a paragraph\'s start before %s, as before', async (_name, after) => {
		const md = bare + '\n' + after + '\n';
		expect(wrapBareLatexEnvironments(md)).toBe(D + bare + D + '\n' + after + '\n');
		expect(wordText(await wordXml(md))).not.toContain('begin{equation}');
	});

	// Export reads a highlight's text on its own (see coloredHighlightRule),
	// so its dollar sign is text there. The read took it for an inline
	// equation's opener, to the one before \alpha, over the environment
	test.each([
		['a highlight', 'Text ==cost $=='],
		['a highlight with a color', 'Text ==cost $=={red}'],
	])('wraps an environment after a dollar sign in %s, as before', async (_name, before) => {
		const md = before + '\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(before + '\n' + D + bare + D + '\n$\\alpha$ here.\n');
		expect(wordText(await wordXml(md))).not.toContain('begin{equation}');
	});

	test('wraps an environment in a highlight after a dollar sign in it, as before', async () => {
		const md = '==cost $\n' + bare + '\nb== $\\alpha$\n';
		expect(wrapBareLatexEnvironments(md)).toBe('==cost $\n' + D + bare + D + '\nb== $\\alpha$\n');
		expect(wordText(await wordXml(md))).not.toContain('begin{equation}');
	});

	// The scan for the image's label, in the paragraph's text, read the
	// fence as text. Wrapped, the environment's opening fence closed an
	// equation from it, past the alt's ], so no image was read, and Word got
	// an empty equation and the environment as text
	test('leaves an environment after a fence in an image\'s alt in its paragraph as it is, as before', async () => {
		const md = 'Text ![' + D + '](x.png)\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const xml = await wordXml(md);
		expect([...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].every(m => /<m:t[^>]*>[^<]*\S/.test(m[1]))).toBe(true);
	});

	// As main left them, whose fences it paired: export reads an image's alt
	// and a citation's text as theirs, with no equation in them
	test.each([
		['an image\'s alt', '![' + D + '\n' + aligned + '\n' + D + '](x.png)\n'],
		['a citation', '[see @ref, ' + D + '\n' + aligned + '\n' + D + ']\n'],
		['a highlight', '==' + D + '\n' + aligned + '\n' + D + '==\n'],
		['a link\'s text', '[' + D + '\n' + aligned + '\n' + D + '](u)\n'],
	])('leaves an environment in display math in %s as it is, as before', (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});

	// Each inline construct with a dollar sign in it, before an environment
	// with an inline equation after it, and after one at a paragraph's start
	test.each([
		['in a code span', '`$`'],
		['in a code span\'s equation', '`$x$`'],
		['in a code span\'s fence', '`' + D + '`'],
		['in a tag\'s attribute', '<span title="$">c</span>'],
		['in a tag\'s attribute in single quotes', '<span title=\'$\'>c</span>'],
		['in a tag\'s attribute without quotes', '<span title=$>c</span>'],
		['in a comment', '<!-- $ -->'],
		['in a comment\'s fence', '<!-- ' + D + ' -->'],
		['in an autolink', '<http://x.org/$y>'],
		['in an email\'s autolink', '<a$b@x.org>'],
		['in a URL', 'http://x.org/$y'],
		['in a link\'s destination', '[a](x/$y)'],
		['in a link\'s title', '[a](x "t $")'],
		['in a link\'s equation', '[$x$](u)'],
		['in a link\'s display math', '[' + D + 'x' + D + '](u)'],
		['in an image\'s destination', '![a](x/$y.png)'],
		['in an image\'s title', '![a](x.png "t $")'],
		['in an image\'s alt\'s equation', '![$x$](x.png)'],
		['in a citation\'s locator', '[@a, p. $5]'],
		['in a citation\'s equation', '[see @ref, $x$]'],
		['in a citation\'s prefix', '[see $x$ @ref]'],
		['in a citation\'s fence', '[@a, ' + D + ']'],
		['in a highlight', '==cost $=='],
		['in a highlight\'s equation', '==$x$=='],
		['in a highlight\'s fence', '==' + D + '=='],
		['in a highlight with a color', '==cost $=={red}'],
		['in an insertion', '{++cost $++}'],
		['in a deletion', '{--cost $--}'],
		['in a substitution', '{~~$~>b~~}'],
		['in a CriticMarkup highlight', '{==cost $==}'],
		['in a CriticMarkup comment', '{>>cost $<<}'],
		['in a comment with an id', '{#c1>>cost $<<}'],
		['escaped', 'cost \\$'],
		['as an entity', 'cost &#36;'],
		['in an inline equation', '$x$'],
	])('exports an environment as an equation by a dollar sign %s', async (_name, construct) => {
		for (const md of ['Text ' + construct + '\n' + bare + '\n$\\alpha$ here.\n', bare + '\nText ' + construct + ' $\\alpha$.\n']) {
			const xml = await wordXml(md);
			expect(wordText(xml)).not.toContain('begin{equation}');
			const equations = [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]);
			expect(equations.length).toBeGreaterThanOrEqual(2);
			expect(equations.every(m => /<m:t[^>]*>[^<]*\S/.test(m))).toBe(true);
		}
	});
});

describe('wrapBareLatexEnvironments with stray fences in time linear in the text', () => {
	const D = '$' + '$';
	const env = '\\begin{equation}\nx\n\\end{equation}\n\n';
	// Each fence's search for its closer read on to the text's end, and a
	// paragraph's dollar signs are read to its end at most once for each kind
	// of opener
	test.each([
		['fences in code before display math', '```\nx = ' + D + '\n```\n\n' + D + '\n\\begin{aligned}\na\n\\end{aligned}\n' + D + '\n\n', 0],
		['fences in text before environments', 'A ' + D + ' sign.\n\n' + env, 1],
		['fences in table cells before environments', '| a ' + D + ' | b |\n| - | - |\n\n' + env, 1],
		['equations and dollar signs in one paragraph', 'x ' + D + 'y' + D + ' $a$ \\$ $5 $x' + D + 'y$ ', 0],
		['dollar signs after an opener without its closer in one paragraph', '$ ' + D + 'a' + D + ' \\$ ', 0],
		['CriticMarkup spans over blank lines in display math', D + '\na {++b\n\nc++} d\n\\begin{aligned}\na\n\\end{aligned}\n' + D + '\n\n', 0],
		// Each equation of four read from a run's dollar sign counted the
		// rest of the run
		['a run of dollar signs', D.repeat(8), 0],
		['a run of backticks', '`'.repeat(16), 0],
		['tags without their ends in one paragraph', '<a b="$ ', 0],
		['brackets in one paragraph', '[$ ', 0],
		['citations without their ends in one paragraph', '[@a $ ', 0],
		['autolinks without their ends in one paragraph', '<http://x/$ ', 0],
		['URLs in one paragraph', 'http://x.org/$y ', 0],
		['highlights in one paragraph', '==a $== ', 0],
		['highlights without their ends in one paragraph', '==a ==} $ ', 0],
		['images with equations in their alts in one paragraph', '![$x$](x.png) ', 0],
		['citations with equations in one paragraph', '[see @a, $x$] ', 0],
		['citations with fences in one paragraph', '[@a, ' + D + '] ', 0],
	])('wraps a text of %s', (_name, unit, wrapped) => {
		const count = (text: string) => wrapBareLatexEnvironments(text).split(D + '\\begin').length - 1;
		expect(count(unit.repeat(2))).toBe(wrapped * 2);
		const time = (n: number) => {
			const text = unit.repeat(n);
			return fastestRun(() => wrapBareLatexEnvironmentsWithLines(text + '\n\n' + env));
		};
		time(4000);
		const small = time(4000);
		expect(time(16000) / small).toBeLessThan(8);
	}, 60000);

	test('wraps a text of a run of dollar signs after a backslash', () => {
		// Which escapes the first, so the math rule reads the run from the next
		const time = (n: number) => {
			const text = '\\' + '$'.repeat(n) + '\n\n' + env;
			return fastestRun(() => wrapBareLatexEnvironmentsWithLines(text));
		};
		expect(wrapBareLatexEnvironments('\\' + '$'.repeat(9) + '\n\n' + env)).toContain(D + '\\begin{equation}');
		time(32000);
		const small = time(32000);
		expect(time(128000) / small).toBeLessThan(8);
	}, 60000);
});
