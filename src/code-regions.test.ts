// Unit tests for code-region-inert-zones bugfix
// Tasks 3.2, 4.2, 5.2

import { describe, test, expect } from 'bun:test';
import {
	codeOverlapTest,
	computeCodeRegions,
	computeMarkdownRegions,
	editorBlocks,
	formatHighlightLimit,
	isInsideCodeRegion,
	overlapsCodeRegion,
} from './code-regions';
import { editorDecorationRanges } from './highlight-colors';
import { navigationRanges } from './navigation-matches';

// ---------------------------------------------------------------------------
// Task 3.2: Unit tests for computeCodeRegions() and isInsideCodeRegion()
// ---------------------------------------------------------------------------

describe('computeCodeRegions', () => {
	test('inline code: `code` returns region covering backticks and content', () => {
		const text = 'before `code` after';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(regions[0].start).toBe(7);  // position of first `
		expect(regions[0].end).toBe(13);   // position after closing `
		expect(text.slice(regions[0].start, regions[0].end)).toBe('`code`');
	});

	test('double-backtick inline code: ``code``', () => {
		const text = 'before ``code`` after';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('``code``');
	});

	test('backslash-escaped backticks do not open inline code', () => {
		expect(computeCodeRegions('see \\`x\\` here')).toEqual([]);
		// An escaped backslash leaves the backtick after it live
		const text = 'a \\\\`code` b';
		expect(computeCodeRegions(text).map(r => text.slice(r.start, r.end))).toEqual(['`code`']);
		// Backslashes inside a code span are literal, so \` still closes it
		const inner = '`a\\` b';
		expect(computeCodeRegions(inner).map(r => inner.slice(r.start, r.end))).toEqual(['`a\\`']);
	});

	test('inline code containing CriticMarkup: `{++added++}`', () => {
		const text = 'before `{++added++}` after';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('`{++added++}`');
	});

	test('fenced code block with ``` delimiter', () => {
		const text = 'before\n```\ncode here\n```\nafter';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('```\ncode here\n```');
	});

	test('fenced code block with ~~~ delimiter', () => {
		const text = 'before\n~~~\ncode here\n~~~\nafter';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('~~~\ncode here\n~~~');
	});

	test('fenced code block with language tag', () => {
		const text = 'before\n```javascript\nconst x = 1;\n```\nafter';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('```javascript\nconst x = 1;\n```');
	});

	test('fenced code block with ~~~ and language tag', () => {
		const text = 'before\n~~~python\nprint("hi")\n~~~\nafter';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('~~~python\nprint("hi")\n~~~');
	});

	test('recognizes indented and container-nested fenced blocks', () => {
		for (const text of [
			'  ~~~\n  {++first\n  second++}\n  ~~~',
			'- item\n\n  ~~~\n  {++first\n  second++}\n  ~~~',
			'> ~~~\n> {++first\n> second++}\n> ~~~',
		]) {
			const regions = computeCodeRegions(text);
			const criticOffset = text.indexOf('{++');
			expect(regions.some(region => isInsideCodeRegion(criticOffset, [region]))).toBe(true);
		}
	});

	test('closes CR-only fences without swallowing later prose', () => {
		const text = '~~~\r{++code\rline++}\r~~~\rAfter {++revision++}';
		const regions = computeCodeRegions(text);
		expect(isInsideCodeRegion(text.indexOf('{++code'), regions)).toBe(true);
		expect(isInsideCodeRegion(text.indexOf('{++revision'), regions)).toBe(false);
	});

	test('mixed: document with both inline code and fenced blocks', () => {
		const text = 'text `inline` more\n```\nfenced\n```\nend';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(2);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('`inline`');
		expect(text.slice(regions[1].start, regions[1].end)).toBe('```\nfenced\n```');
	});

	test('empty code span: `` `` (backticks with space)', () => {
		const text = 'before `` `` after';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('`` ``');
	});

	test('unclosed fence extends to end of text', () => {
		const text = 'before\n```\nunclosed code\nno closing fence';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(1);
		expect(regions[0].start).toBe(7); // position of ```
		expect(regions[0].end).toBe(text.length);
	});

	test('no code regions in plain text', () => {
		const text = 'just plain text with {++addition++}';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(0);
	});

	test('fenced block takes priority over inline backticks inside', () => {
		const text = '```\n`inline` inside fence\n```';
		const regions = computeCodeRegions(text);
		// Should be one fenced block, not separate inline spans
		expect(regions.length).toBe(1);
		expect(text.slice(regions[0].start, regions[0].end)).toBe(text);
	});

	test('handles many inline spans without rescanning completed regions', () => {
		const text = '`x` '.repeat(10_000);
		const regions = computeCodeRegions(text);
		expect(regions).toHaveLength(10_000);
		expect(text.slice(regions.at(-1)!.start, regions.at(-1)!.end)).toBe('`x`');
	});

	test('handles many fenced regions without restarting the region scan', () => {
		const text = ('```\nx\n```\nprose\n').repeat(8_000);
		const regions = computeCodeRegions(text);
		expect(regions).toHaveLength(8_000);
		expect(text.slice(regions.at(-1)!.start, regions.at(-1)!.end)).toBe('```\nx\n```');
	});
});

describe('isInsideCodeRegion', () => {
	const text = 'ab `cd` ef';
	// regions: [{start:3, end:7}] covering `cd`
	const regions = computeCodeRegions(text);

	test('at start of region = true', () => {
		expect(isInsideCodeRegion(3, regions)).toBe(true);
	});

	test('at end of region = false (end is exclusive)', () => {
		expect(isInsideCodeRegion(7, regions)).toBe(false);
	});

	test('just before start = false', () => {
		expect(isInsideCodeRegion(2, regions)).toBe(false);
	});

	test('just inside = true', () => {
		expect(isInsideCodeRegion(4, regions)).toBe(true);
	});

	test('well outside = false', () => {
		expect(isInsideCodeRegion(0, regions)).toBe(false);
		expect(isInsideCodeRegion(9, regions)).toBe(false);
	});
});

describe('overlapsCodeRegion', () => {
	const text = 'ab `cd` ef';
	const regions = computeCodeRegions(text);
	// regions: [{start:3, end:7}]

	test('range fully inside code region overlaps', () => {
		expect(overlapsCodeRegion(4, 6, regions)).toBe(true);
	});

	test('range fully containing code region overlaps', () => {
		expect(overlapsCodeRegion(2, 8, regions)).toBe(true);
	});

	test('range partially overlapping start overlaps', () => {
		expect(overlapsCodeRegion(2, 5, regions)).toBe(true);
	});

	test('range partially overlapping end overlaps', () => {
		expect(overlapsCodeRegion(5, 9, regions)).toBe(true);
	});

	test('range before code region does not overlap', () => {
		expect(overlapsCodeRegion(0, 3, regions)).toBe(false);
	});

	test('range after code region does not overlap', () => {
		expect(overlapsCodeRegion(7, 10, regions)).toBe(false);
	});

	test('adjacent range (end == region.start) does not overlap', () => {
		expect(overlapsCodeRegion(0, 3, regions)).toBe(false);
	});

	test('adjacent range (start == region.end) does not overlap', () => {
		expect(overlapsCodeRegion(7, 9, regions)).toBe(false);
	});
});

describe('codeOverlapTest', () => {
	test('reads each range as overlapsCodeRegion does', () => {
		const text = 'ab `cd` ef\n\n```\nx\n```\n\ng `h` i';
		const regions = computeCodeRegions(text);
		const overlaps = codeOverlapTest(regions);
		for (let start = 0; start <= text.length; start++) {
			for (let end = start; end <= text.length; end++) {
				expect(overlaps(start, end)).toBe(overlapsCodeRegion(start, end, regions));
			}
		}
	});

	test('reads a region that a code span before it holds', () => {
		// A code span the scan for its closer reads past a block to, as
		// computeInlineCodeRegions does
		const overlaps = codeOverlapTest([{ start: 0, end: 20 }, { start: 5, end: 8 }, { start: 22, end: 25 }]);
		expect(overlaps(10, 12)).toBe(true);
		expect(overlaps(20, 22)).toBe(false);
		expect(overlaps(21, 23)).toBe(true);
	});
});

describe('editorBlocks', () => {
	test('reads code where computeCodeRegions finds it', () => {
		const text = 'a `x == y` b\r\n\r\n```\n{++\n```\n\n    keep if x == 1\n';
		const blocks = editorBlocks(text);
		expect(blocks.codeRegions).toEqual(computeCodeRegions(text));
		const code = [...text].map((_, offset) => blocks.inCode(offset) ? text[offset] : '.').join('');
		expect(code).toBe('..`x == y`......```\n{++\n```..    keep if x == 1.');
	});

	test('reads a paragraph\'s end where formatHighlightLimit does', () => {
		const text = '# a\nb ==\nc\n\n- d\n';
		const blocks = editorBlocks(text);
		const limitAt = formatHighlightLimit(text, computeMarkdownRegions(text, { inlineBlocks: true }).inlineBlocks);
		for (let offset = 0; offset <= text.length; offset++) expect(blocks.limitAt(offset)).toBe(limitAt(offset));
	});
});

describe('formatHighlightLimit', () => {
	/** The text from each offset to the limit at it */
	const reach = (text: string) => {
		const limitAt = formatHighlightLimit(text, computeMarkdownRegions(text, { inlineBlocks: true }).inlineBlocks);
		return (offset: number) => text.slice(offset, limitAt(offset));
	};

	test('ends at a paragraph\'s end, not at a line end in it', () => {
		const at = reach('a ==b\nc\n\nd\n');
		expect(at(2)).toBe('==b\nc\n');
		expect(at(9)).toBe('d\n');
	});

	test('ends at a list item\'s, a heading\'s and a quote\'s paragraph\'s end', () => {
		expect(reach('- a ==\n  b\n- c\n')(4)).toBe('==\n  b\n');
		expect(reach('# a ==\nb\n')(4)).toBe('==\n');
		expect(reach('> a ==\n>\n> b\n')(4)).toBe('==\n');
	});

	test('ends at a line\'s end outside a paragraph, as in a table\'s row', () => {
		const text = '| a == |\n|---|\n| b |\n';
		expect(reach(text)(4)).toBe('== |\n');
		expect(reach('| a == |')(4)).toBe('== |');
	});

	test('reads a line end of either kind', () => {
		expect(reach('a ==\r\nb\r\n\r\nc')(2)).toBe('==\r\nb\r\n');
		expect(reach('| a == |\r\n|---|\r\n')(4)).toBe('== |\r\n');
	});
});

// ---------------------------------------------------------------------------
// Task 4.2: Unit tests for decoration skipping
//
// extractAllDecorationRanges() is code-region-agnostic to preserve parity with
// standalone extraction functions. editorDecorationRanges(), which the
// decorator in extension.ts calls, opens nothing in code (editorBlocks) and
// drops what holds code (dropRangesInCode).
// ---------------------------------------------------------------------------

/** The ranges the decorator in extension.ts paints */
function filterDecorations(text: string, defaultColor: string) {
	return editorDecorationRanges(text, defaultColor);
}

describe('computeMarkdownRegions with tables', () => {
	test('holds a pipe table\'s lines, in a quote too, and not a table\'s look-alike', () => {
		const text = 'a\n\n| b | c |\n|---|---|\n| d | e |\n\n> | f |\n> |---|\n\n| g |\n| h |\n';
		const { tableRegions } = computeMarkdownRegions(text, { includeTables: true });
		expect(tableRegions.map(region => text.slice(region.start, region.end)))
			.toEqual(['| b | c |\n|---|---|\n| d | e |\n', '> | f |\n> |---|\n']);
		expect(computeMarkdownRegions(text).tableRegions).toEqual([]);
	});

	test('keeps a table and one in a quote it touches apart', () => {
		// Merged, they were one region, from the first's start
		const text = 'a | b\n--- | ---\nc | d\n> x | y\n> --- | ---\n> z | w';
		const { tableRegions } = computeMarkdownRegions(text, { includeTables: true });
		expect(tableRegions.map(region => text.slice(region.start, region.end)))
			.toEqual(['a | b\n--- | ---\nc | d\n', '> x | y\n> --- | ---\n> z | w']);
	});
});

describe('computeMarkdownRegions with inline HTML', () => {
	const inlineHtml = (text: string) => computeMarkdownRegions(text, { html: 'all', inlineHtml: true }).inlineHtmlRegions
		.map(region => text.slice(region.start, region.end));

	test('holds the comments and tags in a paragraph\'s, a heading\'s, a quote\'s, a list item\'s and a note\'s text', () => {
		const text = 'a <!-- x --> b <span title="y">c</span>\n\n# h <!-- z -->\n\nS <i>\n===\n\n> q <b\n> c="d">\n\n- i <!-- j -->\n\nA[^1]\n\n[^1]: n <!-- k\nl -->\n';
		expect(inlineHtml(text)).toEqual(['<!-- x -->', '<span title="y">', '</span>', '<!-- z -->', '<i>', '<b\n> c="d">', '<!-- j -->', '<!-- k\nl -->']);
		expect(computeMarkdownRegions(text, { html: 'all' }).inlineHtmlRegions).toEqual([]);
		expect(computeMarkdownRegions(text, { inlineHtml: true }).inlineHtmlRegions).toEqual([]);
	});

	test('holds an empty comment alone, as markdown-it reads it', () => {
		expect(inlineHtml('a <!--> x --> <!---> y -->')).toEqual(['<!-->', '<!--->']);
	});

	test('leaves out escaped HTML, a comment that doesn\'t end, and what isn\'t a comment or a tag', () => {
		expect(inlineHtml('a \\<!-- x --> \\\\<!-- y --> <!-- open <?pi ?> <!DOCTYPE x> <![CDATA[ x ]]>')).toEqual(['<!-- y -->']);
	});

	test('leaves out HTML that a construct from before it can end in', () => {
		// As a code span from a backtick before it, whose end leaves the
		// rest of the HTML text
		const ends = ['`', '$', ']', ')', '==', '++}', '--}', '~~}', '<<}', '~>'];
		expect(inlineHtml('a ' + ends.map(end => '<!-- ' + end + ' -->').join(' ') + ' <!-- ok --> <b c="`">')).toEqual(['<!-- ok -->']);
	});

	test('leaves out HTML in code, an HTML block, a table\'s row, and text whose lines it can\'t map', () => {
		expect(inlineHtml('    <!-- code -->\n\n<div>\n<!-- block -->\n</div>\n\n| <!-- a --> | b |\n|---|---|\n')).toEqual([]);
		// The heading's closing #s end its line, after its text
		expect(inlineHtml('# h <!-- a --> ##\n')).toEqual([]);
	});
});

describe('call-site code-region filtering skips code regions', () => {
	test('inline code with addition: `{++added++}` — no addition ranges', () => {
		const text = '`{++added++}`';
		const result = filterDecorations(text, 'yellow');
		expect(result.additions.length).toBe(0);
		expect(result.additionDelimiters.length).toBe(0);
	});

	test('inline code with highlight: `==highlighted==` — no highlight ranges', () => {
		const text = '`==highlighted==`';
		const result = filterDecorations(text, 'yellow');
		expect(result.highlights.size).toBe(0);
	});

	test('inline code with comment: `{>>comment<<}` — no comment ranges', () => {
		const text = '`{>>comment<<}`';
		const result = filterDecorations(text, 'yellow');
		expect(result.comments.length).toBe(0);
	});

	test('fenced code block with deletion: no deletion ranges', () => {
		const text = '```\n{--deleted--}\n```';
		const result = filterDecorations(text, 'yellow');
		expect(result.deletions.length).toBe(0);
		expect(result.deletionDelimiters.length).toBe(0);
	});

	test('CriticMarkup both inside and outside code — only outside ranges returned', () => {
		const text = '{++outside++} `{++inside++}` {--also outside--}';
		const result = filterDecorations(text, 'yellow');

		// Should have the outside addition
		expect(result.additions.length).toBe(1);
		expect(text.slice(result.additions[0].start, result.additions[0].end)).toBe('outside');

		// Should have the outside deletion
		expect(result.deletions.length).toBe(1);
		expect(text.slice(result.deletions[0].start, result.deletions[0].end)).toBe('also outside');
	});

	test('CriticMarkup surrounding a code span: {==`code`==} — content range filtered', () => {
		const text = '{==`code`==}';
		const result = filterDecorations(text, 'yellow');

		// The critic highlight content range [3, 9) exactly covers the inline code span `code`.
		// Call-site filtering removes it because the content overlaps the code region.
		// This is consistent behavior: any decoration range overlapping a code region is suppressed.
		const criticRanges = result.highlights.get('critic') ?? [];
		expect(criticRanges.length).toBe(0);
	});

	test('fenced code block with highlight and comment — no ranges', () => {
		const text = '```\n==highlighted==\n{>>comment<<}\n```';
		const result = filterDecorations(text, 'yellow');
		expect(result.highlights.size).toBe(0);
		expect(result.comments.length).toBe(0);
	});

	test('fenced code block with substitution — no ranges', () => {
		const text = '```\n{~~old~>new~~}\n```';
		const result = filterDecorations(text, 'yellow');
		expect(result.substitutionNew.length).toBe(0);
		expect(result.substitutionDelimiters.length).toBe(0);
	});

	test('inline code with colored highlight: `==text=={red}` — no highlight ranges', () => {
		const text = '`==text=={red}`';
		const result = filterDecorations(text, 'yellow');
		expect(result.highlights.size).toBe(0);
	});

	test('mixed: fenced block and inline code with patterns, plus outside patterns', () => {
		const text = '{>>visible comment<<}\n```\n{>>hidden comment<<}\n```\n`{++hidden add++}` {++visible add++}';
		const result = filterDecorations(text, 'yellow');

		expect(result.comments.length).toBe(1);
		expect(text.slice(result.comments[0].start, result.comments[0].end)).toBe('visible comment');

		expect(result.additions.length).toBe(1);
		expect(text.slice(result.additions[0].start, result.additions[0].end)).toBe('visible add');
	});
});

// ---------------------------------------------------------------------------
// Task 5.2: Unit tests for navigation filtering
// ---------------------------------------------------------------------------

// Test-local navigation scanner (mirrors combinedPattern from changes.ts)
const combinedPattern =
	/\{(?<!(?<!\\)(?:\\\\)*\\\{)(?:\+\+([\s\S]*?)\+\+\}|--([\s\S]*?)--\}|\~\~([\s\S]*?)\~\~\}|#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|>>([\s\S]*?)<<\}|#[a-zA-Z0-9_-]+\}|\/[a-zA-Z0-9_-]+\}|==([\s\S]*?)==\})|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\}|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)(?![}=])|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

/** The ranges getAllMatches in changes.ts finds */
function scanNavigation(text: string): Array<{ start: number; end: number }> {
	return navigationRanges(combinedPattern, text);
}

describe('navigation scanner skips code regions', () => {
	test('CriticMarkup inside inline code — no matches', () => {
		const text = '`{++added++}`';
		const matches = scanNavigation(text);
		expect(matches.length).toBe(0);
	});

	test('CriticMarkup inside fenced code block — no matches', () => {
		const text = '```\n{++added++}\n{--deleted--}\n{>>comment<<}\n```';
		const matches = scanNavigation(text);
		expect(matches.length).toBe(0);
	});

	test('CriticMarkup both inside and outside code — only outside matches', () => {
		const text = '{++outside add++} `{--inside del--}` {>>outside comment<<}';
		const matches = scanNavigation(text);

		// Should have exactly 2 matches: the addition and the comment outside code
		expect(matches.length).toBe(2);
		expect(text.slice(matches[0].start, matches[0].end)).toBe('{++outside add++}');
		expect(text.slice(matches[1].start, matches[1].end)).toBe('{>>outside comment<<}');
	});

	test('highlight inside inline code — no matches', () => {
		const text = '`==highlighted==`';
		const matches = scanNavigation(text);
		expect(matches.length).toBe(0);
	});

	test('substitution inside fenced code block — no matches', () => {
		const text = '```\n{~~old~>new~~}\n```';
		const matches = scanNavigation(text);
		expect(matches.length).toBe(0);
	});

	test('mixed fenced and inline with outside patterns', () => {
		const text = '{==outside highlight==}\n```\n{==inside highlight==}\n```\n`{++inside add++}` {++outside add++}';
		const matches = scanNavigation(text);

		const matchTexts = matches.map(m => text.slice(m.start, m.end));
		expect(matchTexts).toContain('{==outside highlight==}');
		expect(matchTexts).toContain('{++outside add++}');
		expect(matchTexts).not.toContain('{==inside highlight==}');
		expect(matchTexts).not.toContain('{++inside add++}');
	});
});
