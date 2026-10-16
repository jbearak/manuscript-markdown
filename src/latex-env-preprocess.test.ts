import { describe, test, expect } from 'bun:test';
import { wrapBareLatexEnvironments, wrapBareLatexEnvironmentsWithLines, DISPLAY_MATH_ENVIRONMENTS } from './latex-env-preprocess';
import { fastestRun } from './test-timing';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { renderWithPlugin } from './test-helpers';
import { scanOrientationDirectives } from './orientation-scan';
import MarkdownIt from 'markdown-it';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';
import { vscodeMath } from './preview-math-read';

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
		['in a URL', 'See http://x.org/' + D + ' here.\n'],
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

	// Export reads display math with a blank line before its environment as
	// two paragraphs and no equation, and VS Code's preview, whose math
	// extension reads display math from a fence at a line's start over blank
	// lines, as one equation. Wrapped, the wrap's opening fence closed the
	// preview's equation, which gave it the environment as text and an empty
	// equation. Main's pairing of the two fences holds (see mainZoneIsWrong)
	const blankBefore = D + '\nx\n\n' + aligned + '\n' + D + '\n';

	test('leaves an environment after a blank line in display math as it is, which the preview reads as one equation', () => {
		expect(wrapBareLatexEnvironments(blankBefore)).toBe(blankBefore);
		const md = new MarkdownIt({ html: true });
		vscodeMath(md);
		md.use(manuscriptMarkdownPlugin);
		const maths: string[] = [];
		const texts: string[] = [];
		const visit = (tokens: ReturnType<MarkdownIt['parse']>) => {
			for (const token of tokens) {
				if (token.type.startsWith('math')) maths.push(token.content);
				else if (token.type === 'text') texts.push(token.content);
				if (token.children) visit(token.children);
			}
		};
		visit(md.parse(blankBefore, {}));
		expect(maths).toHaveLength(1);
		expect(maths[0]).toContain('x');
		expect(maths[0]).toContain('\\begin{aligned}');
		expect(texts.join('')).not.toContain('begin{aligned}');
	});

	test('leaves an environment after a blank line in display math as it is through Word, as on main', async () => {
		const { docx } = await convertMdToDocx(blankBefore);
		const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
		// No empty equation, and the next trip gives the same Markdown
		expect([...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].every(m => /<m:t[^>]*>[^<]*\S/.test(m[1]))).toBe(true);
		const once = (await convertDocx(docx)).markdown;
		expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
	});
});

describe('dollar signs and backticks as export reads them around a bare environment', () => {
	const D = '$' + '$';
	const aligned = '\\begin{aligned}\na &= b\n\\end{aligned}';
	const bare = '\\begin{equation}\nx\n\\end{equation}';
	const wordXml = async (md: string) => {
		const { docx } = await convertMdToDocx(md);
		return (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
	};
	// Word's text, out of its equations
	const wordText = (xml: string) => [...xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');

	// The zones of code spans and comments are found across the text, where
	// a backtick or a <!-- in one paragraph pairs with one in the next, which
	// markdown-it reads as no code span or comment. The display math's fences
	// pair in its paragraph's own parse, as main paired them
	test.each([
		['a backtick', 'A ` tick.\n\n' + D + '\na ` b\n' + aligned + '\n' + D + '\n'],
		['a comment\'s opener', 'a <!-- b\n\n' + D + '\nx --> y\n' + aligned + '\n' + D + '\n'],
	])('leaves an environment in display math after %s in a paragraph before it, which pairs with none there, as before', async (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const xml = await wordXml(md);
		expect(xml.match(/<m:oMath>/g)).toHaveLength(1);
		expect(xml).not.toContain('begin{aligned}');
	});

	// Which export's inline rules read before its math rule reads the dollar
	// sign, so it opens no equation, as main wraps the environment
	test.each([
		['in a tag\'s attribute', 'Text <span title="$">cost</span>'],
		['in a tag\'s attribute without quotes', 'Text <span title=$>cost</span>'],
		['in an autolink', 'Mail <http://x.org/$y>'],
		['in a URL', 'Go http://x.org/$y'],
		['in a citation', 'Text [@a, p. $5] b'],
		['in a code span', 'Use `$` here'],
		['in a link\'s destination', 'See [a](x/$y)'],
		['in a link\'s title', 'See [a](x "t $")'],
		['in an image\'s destination', 'See ![a](x/$y.png)'],
	])('wraps an environment in a paragraph after a dollar sign %s, as before', async (_name, before) => {
		const md = before + '\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(before + '\n' + D + bare + D + '\n$\\alpha$ here.\n');
		expect(wordText(await wordXml(md))).not.toContain('begin{equation}');
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
		['in a highlight', '==cost $=='],
		['in a highlight\'s equation', '==$x$=='],
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

describe('a bare environment its paragraph\'s own parse decides otherwise than main', () => {
	const D = '$' + '$';
	const bare = '\\begin{equation}\nx\n\\end{equation}';
	const word = async (md: string, part = 'document') => {
		const { docx } = await convertMdToDocx(md);
		const xml = await (await JSZip.loadAsync(docx)).file('word/' + part + '.xml')!.async('string');
		return {
			text: [...xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''),
			equations: [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]),
		};
	};

	// Main paired the fence in the code span with the opening fence of the
	// display math, in the paragraph after it or the same one. The
	// paragraph's own parse reads the display math
	test.each([
		['in the paragraph before', 'Use `' + D + '` here.\n\n'],
		['in the same paragraph', 'Use `' + D + '` here.\n'],
	])('leaves an environment in display math after a fence in a code span %s as it is', async (_name, before) => {
		const md = before + D + '\n' + bare + '\n' + D + '\n';
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const { text, equations } = await word(md);
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(1);
		expect(equations[0]).toMatch(/<m:t[^>]*>[^<]*x/);
	});

	// Main's zone from the fence in the code span, which pairs with none,
	// to the text's end, held it. The paragraph's own parse reads no display
	// math over it, and with the wrap, display math from its opening fence to
	// its closing one, and the inline equation after it as before
	test('wraps an environment after a fence in a code span in its paragraph, through Word', async () => {
		const md = 'Use `' + D + '` here.\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe('Use `' + D + '` here.\n' + D + bare + D + '\n$\\alpha$ here.\n');
		const { text, equations } = await word(md);
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(2);
	});

	// Main paired the code span's fence with the one after the environment.
	// Wrapped, the parse reads it as display math to its closing fence,
	// before that one
	test('wraps an environment with a fence right after it, after a fence in a code span', async () => {
		const md = 'Use `' + D + '` here.\n\n' + bare + D + ' b\n';
		expect(wrapBareLatexEnvironments(md)).toContain(D + bare + D + D + ' b');
		const { text, equations } = await word(md);
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(1);
	});

	// The dollar sign in the environment's comment, read as nothing, as it
	// is display math's once wrapped, opens no equation over the inline
	// equation after it
	test('wraps an environment with a dollar sign in a comment in it, before inline math, as before', async () => {
		const md = '\\begin{equation}\nx=1 % $\n\\end{equation}\nThen $\\alpha$\n';
		expect(wrapBareLatexEnvironments(md)).toContain(D + '\\begin{equation}\nx=1 % $\n\\end{equation}' + D);
		const { text, equations } = await word(md);
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(2);
		expect(equations.every(m => /<m:t[^>]*>[^<]*\S/.test(m))).toBe(true);
	});

	// Main's zone from the stray fence held each, by chance. The parse with
	// the wrap reads no display math from its opening fence to its closing
	// one, but an inline equation over it, or one from the dollar sign
	// before it to the one in it, so main's decision holds
	test.each([
		['in an inline equation over lines, after a fence in a code span', 'Use `' + D + '` here.\n\nThe matrix $\n\\begin{pmatrix}\na & b\n\\end{pmatrix}\n$ is.\n'],
		['with a dollar sign in it, after a dollar sign and a fence in a line of text', 'A ' + D + ' sign.\n\n$\n\\begin{equation}$\\end{equation}\n'],
	])('leaves an environment %s as it is, as before', (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});

	// Main paired the code span's fence with the one in the line before the
	// environment, which opens display math to the fence after it, a dollar
	// sign in it, for the paragraph's parse. Main's wrap, whose opening fence
	// is at its line's start, ends the paragraph there for VS Code's preview,
	// which reads it as its own equation, and the display math around it,
	// left as it is, as one with the dollar sign. So main's decision holds
	// (see mainsWrapsInPreview)
	test('wraps an environment in display math from a fence in a line before it, as main does, which the preview reads as its own equation', () => {
		const md = 'A `' + D + '` b.\n\nSee ' + D + ' a $\n' + bare + '\nb ' + D + ' c.\n';
		const wrapped = wrapBareLatexEnvironments(md);
		expect(wrapped).toBe('A `' + D + '` b.\n\nSee ' + D + ' a $\n' + D + bare + D + '\nb ' + D + ' c.\n');
		const preview = new MarkdownIt({ html: true });
		vscodeMath(preview);
		preview.use(manuscriptMarkdownPlugin);
		const maths: string[] = [];
		const visit = (tokens: ReturnType<MarkdownIt['parse']>) => {
			for (const token of tokens) {
				if (token.type.startsWith('math')) maths.push(token.content);
				if (token.children) visit(token.children);
			}
		};
		visit(preview.parse(md, {}));
		expect(maths).toEqual([bare]);
	});
});

describe('a bare environment in a paragraph that is not simple, as main left it', () => {
	const D = '$' + '$';
	const bare = '\\begin{equation}\nx\n\\end{equation}';
	const word = async (md: string, part = 'document') => {
		const { docx } = await convertMdToDocx(md);
		const xml = await (await JSZip.loadAsync(docx)).file('word/' + part + '.xml')!.async('string');
		return {
			text: [...xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''),
			equations: [...xml.matchAll(/<m:oMath>([\s\S]*?)<\/m:oMath>/g)].map(m => m[1]),
		};
	};
	// A URL with a fence in a link's label, the environment, and the
	// closing fence. Whether export reads a link there, whose text holds
	// display math and no URL, or the URL and its fence as text, turns on
	// the link definitions export reads: a note's body, which export parses
	// on its own, reads the document's, and a definition in an insertion is
	// the insertion's text. A read of the paragraph that took a link for
	// none, or none for a link, broke the equation. The paragraph is not
	// simple, so main's decision holds
	const label = '[http://x.org/' + D + '\n' + bare + '\n' + D + '][r]';

	test('leaves an environment in display math in a reference link\'s text in a note as it is, through Word', async () => {
		const md = 'Text[^n].\n\n[r]: u\n\n[^n]: ' + label.replace(/\n/g, '\n    ') + '\n';
		expect(wrapBareLatexEnvironments(label + '\n')).toBe(label + '\n');
		const { text, equations } = await word(md, 'footnotes');
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(1);
		expect(equations[0]).toMatch(/<m:t[^>]*>[^<]*x/);
	});

	test('wraps an environment in a reference link\'s label whose definition is in an insertion, after a fence in a code span, through Word', async () => {
		const md = 'Use `' + D + '` here.\n\n{++a\n\n[r]: u\n\n++}\n\n' + label + '\n';
		expect(wrapBareLatexEnvironments(md)).toContain(D + bare + D);
		const { text, equations } = await word(md);
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(1);
		expect(equations[0]).toMatch(/<m:t[^>]*>[^<]*x/);
	});

	// preprocessCriticMarkup moves the comment's opener from its line's end
	// to the next line's start, after a blank line, and the URL's fence is in
	// what a scan reads as a link's label, which the parse after it, as it
	// finds no link, reads in the URL. A read of the paragraph that read the
	// comment's fence, or the URL's, as text made a zone that held the
	// environment
	test.each([
		['after a comment whose opener preprocessCriticMarkup moves', 'Use `' + D + '` {>>\nThe delimiter is ' + D + '.<<}\n' + bare + '\n'],
		['after a URL in what a scan reads as a link\'s label', 'Use `' + D + '`. See [https://example.org/' + D + '].\n' + bare + '\n'],
	])('wraps an environment %s, as before', async (_name, md) => {
		expect(wrapBareLatexEnvironments(md)).toContain(D + bare + D);
		const { text, equations } = await word(md);
		expect(text).not.toContain('begin{equation}');
		expect(equations).toHaveLength(1);
		expect(equations.every(m => /<m:t[^>]*>[^<]*\S/.test(m))).toBe(true);
	});

	// The scan for the image's label, in the paragraph's text, reads the
	// fence. Wrapped, the environment's opening fence closed an equation
	// from it, past the alt's ], so no image was read, and Word got an empty
	// equation and the environment as text
	test('leaves an environment after a fence in an image\'s alt in its paragraph as it is, as before', async () => {
		const md = 'Text ![' + D + '](x.png)\n' + bare + '\n$\\alpha$ here.\n';
		expect(wrapBareLatexEnvironments(md)).toBe(md);
		const { equations } = await word(md);
		expect(equations.every(m => /<m:t[^>]*>[^<]*\S/.test(m))).toBe(true);
	});

	// Wrapped, it reads in the citation, as no display math
	test('leaves an environment in a citation over lines, after a fence in a code span, as it is, as before', () => {
		const md = 'Use `' + D + '` here.\n\nSee [@ref\n' + bare + '\n]\n';
		expect(wrapBareLatexEnvironments(md)).toBe(md);
	});
});

describe('wrapBareLatexEnvironments with stray fences in time linear in the text', () => {
	const D = '$' + '$';
	const env = '\\begin{equation}\nx\n\\end{equation}\n\n';
	// Each fence's search for its closer read on to the text's end. Each
	// text is read with an environment after it, in its last paragraph,
	// which so is read on its own, and once more with its wraps where those
	// differ from main's, and then as the preview reads it. Each row says how
	// many environments it wraps in two of its texts
	test.each([
		['fences in code before display math', '```\nx = ' + D + '\n```\n\n' + D + '\n\\begin{aligned}\na\n\\end{aligned}\n' + D + '\n\n', 0],
		// Main paired the fences of two, with a blank line between them, which
		// it left the environment between as, and wraps the other
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
		['environments with dollar signs in them', '\\begin{equation}\na $ b % $\n\\end{equation}\n\n', 2],
		['fences in images\' alts before environments in their paragraphs', 'Text ![' + D + '](x.png)\n' + env + 'Text ![' + D + '](x.png)\n' + env, 2],
		// Which main's fences leave every other one of, and which the read
		// of the paragraph with the wraps confirms, in one read of it
		['fences in code spans before environments in one paragraph', '`' + D + '` x\n\\begin{equation}\nx\n\\end{equation}\n', 2],
		// Whose decisions, which differ from main's, the preview reads
		// otherwise: the run of four after each, which export reads as an
		// empty equation, opens display math to the next line with a fence for
		// the preview. So each takes main's decision, after one read of all,
		// and main wraps every other one
		['paragraphs the preview reads otherwise, after fences in code spans', '`' + D + '` x\n\\begin{equation}\nx\n\\end{equation}\n' + D + D + ' y\n\n', 1],
		// Whose decisions leave main's wraps, which the preview reads as their
		// own equations, so each takes main's decision, after one read of all
		['display math around main\'s wraps the preview reads as their own equations', 'A `' + D + '` b.\n\nSee ' + D + ' a $\n\\begin{equation}\nx\n\\end{equation}\nb ' + D + ' c.\n\n', 1],
	])('wraps a text of %s', (_name, unit, wrapped) => {
		const count = (text: string) => wrapBareLatexEnvironments(text).split(D + '\\begin').length - 1;
		expect(count(unit.repeat(2))).toBe(wrapped);
		const time = (n: number) => {
			const text = unit.repeat(n);
			return fastestRun(() => wrapBareLatexEnvironmentsWithLines(text + '\n' + env));
		};
		time(4000);
		const small = time(4000);
		expect(time(16000) / small).toBeLessThan(8);
	}, 60000);

	test('wraps a text of a run of dollar signs after a backslash', () => {
		// Which escapes the first, so the math rule reads the run from the
		// next, in the environment's paragraph
		const time = (n: number) => {
			const text = '\\' + '$'.repeat(n) + '\n' + env;
			return fastestRun(() => wrapBareLatexEnvironmentsWithLines(text));
		};
		expect(wrapBareLatexEnvironments('\\' + '$'.repeat(9) + '\n' + env)).toContain(D + '\\begin{equation}');
		time(32000);
		const small = time(32000);
		expect(time(128000) / small).toBeLessThan(8);
	}, 60000);
});

describe('a paragraph of many openers around a bare environment, which no rule of its read closes', () => {
	const D = '$' + '$';
	const env = '\\begin{equation}\nx\n\\end{equation}';
	// From each of many < with no end, html_inline searched on to the
	// paragraph's end for the end of a processing instruction or a
	// declaration, in the read of the environment's paragraph (see
	// readParagraph in latex-env-preprocess.ts), which the language server
	// runs through the orientation scan after each edit. A run of each length
	// from one to seven, with text after it
	const runs = (mark: string) => (n: number) => {
		const parts: string[] = [];
		for (let i = 0; i < n; i++) parts.push(mark.repeat(1 + i % 7) + ' a ');
		return parts.join('');
	};
	const openers: Array<[string, (n: number) => string]> = [
		['<?x', n => '<?x '.repeat(n)],
		['<!x', n => '<!x '.repeat(n)],
		['<![CDATA[', n => '<![CDATA[ '.repeat(n)],
		['<a', n => '<a '.repeat(n)],
		['</', n => '</ '.repeat(n)],
		['<!--', n => '<!-- '.repeat(n)],
		['<!-->', n => '<!--> '.repeat(n)],
		['runs of backticks', runs('`')],
		['runs of dollar signs', runs('$')],
	];
	// Before the environment, where the paragraph is not simple and its read
	// stops, after it, where the read goes on, and after it where a fence in
	// a code span before it, which main paired with none, leaves it to the
	// paragraph's own parse, which reads the paragraph again with the wrap
	const places: Array<[string, (openers: string) => string]> = [
		['before an environment in its paragraph', openers => 'Text ' + openers + '\n' + env + '\n'],
		['after an environment in its paragraph', openers => env + '\nText ' + openers + '\n'],
		['after an environment after a fence in a code span', openers => 'Use `' + D + '` x\n' + env + '\nText ' + openers + '\n'],
	];
	const rows = openers.flatMap(([name, make]) => places.map(([where, place]) => [name, where, (n: number) => place(make(n))] as const));

	test.each(rows)('reads a paragraph of many %s %s, through the wrapper and the orientation scan, in linear time', (name, where, text) => {
		// The dollar signs before it pair with its fences, as on main, and
		// those after it, which the preview reads otherwise than export, keep
		// main's decision after a fence in a code span
		const wraps = !(name === 'runs of dollar signs' && !where.startsWith('after an environment in'));
		expect(wrapBareLatexEnvironments(text(8000)).includes(D + env + D)).toBe(wraps);
		for (const work of [wrapBareLatexEnvironmentsWithLines, scanOrientationDirectives]) {
			const time = (n: number) => {
				const input = text(n);
				return fastestRun(() => work(input));
			};
			time(8000);
			const small = time(8000);
			expect(time(32000) / small).toBeLessThan(8);
		}
	}, 60000);
});
