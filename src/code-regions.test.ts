// Unit tests for code-region-inert-zones bugfix
// Tasks 3.2, 4.2, 5.2

import { describe, test, expect } from 'bun:test';
import {
	computeCodeRegions,
	computeMarkdownInlineBlocks,
	isInsideCodeRegion,
	overlapsCodeRegion,
} from './code-regions';
import { extractAllDecorationRanges } from './highlight-colors';

// ---------------------------------------------------------------------------
// Task 3.2: Unit tests for computeCodeRegions() and isInsideCodeRegion()
// ---------------------------------------------------------------------------

describe('computeMarkdownInlineBlocks', () => {
	test('returns exact parser-derived ranges for every inline-bearing block', () => {
		const text = [
			'Paragraph',
			'continued',
			'',
			'# Heading',
			'',
			'- first',
			'- second',
			'',
			'```',
			'code',
			'```',
			'',
			'> quote one',
			'>',
			'> quote two',
		].join('\n');
		const blocks = computeMarkdownInlineBlocks(text);
		expect(blocks.map(block => block.id)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(blocks.map(block => text.slice(block.start, block.end))).toEqual([
			'Paragraph\ncontinued',
			'# Heading',
			'- first',
			'- second',
			'> quote one',
			'> quote two',
		]);
	});

	test('returns exact ranges for GFM table cells including escaped pipes', () => {
		const text = [
			'| A \\| B | C |',
			'| --- | --- |',
			'| `x` | [y](@z) |',
		].join('\n');
		const blocks = computeMarkdownInlineBlocks(text);
		expect(blocks.map(block => block.id)).toEqual([0, 1, 2, 3]);
		expect(blocks.map(block => text.slice(block.start, block.end))).toEqual([
			'A \\| B',
			'C',
			'`x`',
			'[y](@z)',
		]);

		const blockquote = '> \\| A | B\n> --- | ---';
		expect(computeMarkdownInlineBlocks(blockquote).map(block => blockquote.slice(block.start, block.end))).toEqual([
			'\\| A',
			'B',
		]);
	});

	test('retains distinct zero-length ranges for duplicate empty table cells', () => {
		const text = '|   |   |\n| --- | --- |';
		const blocks = computeMarkdownInlineBlocks(text);
		expect(blocks.map(block => block.id)).toEqual([0, 1]);
		expect(blocks).toHaveLength(2);
		expect(blocks.every(block => block.start === block.end)).toBe(true);
		expect(blocks[0].start).toBeLessThan(blocks[1].start);
	});
});

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

	test('honors CommonMark backslash escapes for code-span delimiters', () => {
		for (const slashCount of [1, 3]) {
			const text = '\\'.repeat(slashCount) + '`literal @visible`';
			expect(computeCodeRegions(text)).toEqual([]);
		}
		for (const slashCount of [2, 4]) {
			const text = '\\'.repeat(slashCount) + '`@hidden`';
			expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end)))
				.toEqual(['`@hidden`']);
		}
	});

	test('starts a shorter delimiter run after an escaped first backtick', () => {
		const text = '\\``@hidden`';
		expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end)))
			.toEqual(['`@hidden`']);
	});

	test('allows a matching code-span closer after a literal backslash', () => {
		for (const delimiter of ['`', '``']) {
			const text = delimiter + '@hidden\\' + delimiter;
			expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end)))
				.toEqual([text]);
		}
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

	test('recognizes fences indented by up to three spaces', () => {
		for (const indent of ['', ' ', '  ', '   ']) {
			const text = 'before\n' + indent + '```md\n@hidden\n' + indent + '```\nafter';
			const regions = computeCodeRegions(text);
			expect(regions).toHaveLength(1);
			expect(text.slice(regions[0].start, regions[0].end)).toContain('@hidden');
		}
	});

	test('recognizes fenced blocks inside list containers', () => {
		for (const marker of ['- ', '1. ']) {
			const indent = ' '.repeat(marker.length);
			const text = marker + '```md\n' + indent + '@hidden\n' + indent + '```\n@live';
			const regions = computeCodeRegions(text);
			expect(regions).toHaveLength(1);
			expect(text.slice(regions[0].start, regions[0].end)).toContain('@hidden');
			expect(regions[0].end).toBeLessThan(text.indexOf('@live'));
		}
	});

	test('recognizes fenced blocks inside nested list and blockquote containers', () => {
		for (const text of [
			'- - ```md\n    @hidden\n    ```\n@live',
			'> ```md\n> @hidden\n> ```\n@live',
			'> - ```md\n>   @hidden\n>   ```\n@live',
		]) {
			const regions = computeCodeRegions(text);
			expect(regions).toHaveLength(1);
			expect(text.slice(regions[0].start, regions[0].end)).toContain('@hidden');
			expect(regions[0].end).toBeLessThan(text.indexOf('@live'));
		}
	});

	test('distinguishes indented code from paragraph and list continuations', () => {
		const code = 'Before\n\n    code';
		expect(computeCodeRegions(code).map(r => code.slice(r.start, r.end))).toEqual(['    code']);
		const blockquoteCode = '>     code';
		expect(computeCodeRegions(blockquoteCode).map(r => blockquoteCode.slice(r.start, r.end))).toEqual(['>     code']);
		const blockquoteAfterProse = 'prose\n>     code';
		expect(computeCodeRegions(blockquoteAfterProse).map(r => blockquoteAfterProse.slice(r.start, r.end))).toEqual(['>     code']);

		const paragraph = 'Before\n    continuation';
		expect(computeCodeRegions(paragraph)).toEqual([]);

		const list = '- item\n\n    continuation';
		expect(computeCodeRegions(list)).toEqual([]);

		const listCode = '- item\n\n      code';
		expect(computeCodeRegions(listCode).map(r => listCode.slice(r.start, r.end))).toEqual(['      code']);

		const sibling = '- first\n- second\n\n    continuation';
		expect(computeCodeRegions(sibling)).toEqual([]);
		const orderedSibling = '9. first\n10. second\n\n    continuation';
		expect(computeCodeRegions(orderedSibling)).toEqual([]);
	});

	test('coalesces consecutive indented-code lines but keeps separate blocks', () => {
		const text = 'Before\n\n    one\n    two\n\nAfter\n\n    three';
		expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end))).toEqual([
			'    one\n    two\n',
			'    three',
		]);
	});

	test('does not pair inline backticks across blank-line paragraph boundaries', () => {
		expect(computeCodeRegions('`a\n\nprose @key\n\nb`')).toEqual([]);
		for (const blank of ['>', '> ', '> >']) {
			expect(computeCodeRegions('> `a\n' + blank + '\n> prose @key\n> b`')).toEqual([]);
		}
		const text = '`a\n\nprose `@key`\n\nb`';
		expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end))).toEqual(['`@key`']);
	});

	test('does not pair inline backticks across CommonMark block interruptions', () => {
		for (const interruption of ['# Heading', '---', '- list item', '1. ordered item']) {
			const text = '`open\n' + interruption + '\nprose @visible\nclose`';
			expect(computeCodeRegions(text)).toEqual([]);
		}

		const fenced = '`open\n```\nfenced\n```\nprose @visible\nclose`';
		expect(computeCodeRegions(fenced).map(region => fenced.slice(region.start, region.end))).toEqual([
			'```\nfenced\n```',
		]);
	});

	test('derives list-contained paragraph boundaries from active containers', () => {
		for (const text of [
			'1. first `open\n2. second @visible close`',
			'1. first `open\n2.\n3. third @visible close`',
			'- # `open\n  prose @visible close`',
			'- prose `open\n    # Heading\n  after @visible close`',
			'- prose `open\n    ---\n  after @visible close`',
			'10. outer\n    - nested\n\n    resumed `open\n    # Heading\n    after @visible close`',
			'10. outer\n    - nested\n\n    resumed `open\n    ***\n    after @visible close`',
		]) {
			expect(computeCodeRegions(text)).toEqual([]);
		}

		for (const fenced of [
			'- prose `open\n    ```\n    fenced\n    ```\n  after @visible close`',
			'10. outer\n    - nested\n\n    resumed `open\n    ```\n    fenced\n    ```\n    after @visible close`',
		]) {
			expect(computeCodeRegions(fenced).map(region => fenced.slice(region.start, region.end))).toEqual([
				'    ```\n    fenced\n    ```',
			]);
		}
	});

	test('does not create list state from non-interrupting ordered markers', () => {
		for (const text of [
			'prose `open\n2. still the same paragraph\n3. @hidden close`',
			'prose `open\n1.\nafter @hidden close`',
		]) {
			expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end))).toEqual([
				text.slice(text.indexOf('`')),
			]);
		}
		for (const marker of ['01. item', '01) item']) {
			expect(computeCodeRegions('prose `open\n' + marker + '\nafter @visible close`')).toEqual([]);
		}
	});

	test('handles dedented and ambiguous blocks inside lists', () => {
		for (const block of ['# Heading', '***']) {
			const text = '10. outer\n    - nested `open\n    ' + block + '\n    after @visible close`';
			expect(computeCodeRegions(text)).toEqual([]);
		}
		const fenced = '10. outer\n    - nested `open\n    ```\n    fenced\n    ```\n    after @visible close`';
		expect(computeCodeRegions(fenced).map(region => fenced.slice(region.start, region.end))).toEqual([
			'    ```\n    fenced\n    ```',
		]);

		const thematic = '- prose\n  - - -\n  ~~~\n  @hidden\n  ~~~';
		expect(computeCodeRegions(thematic).map(region => thematic.slice(region.start, region.end))).toEqual([
			'  ~~~\n  @hidden\n  ~~~',
		]);
		expect(computeCodeRegions('-     @hidden').map(region => '-     @hidden'.slice(region.start, region.end))).toEqual([
			'-     @hidden',
		]);
	});

	test('returns sorted non-overlapping regions', () => {
		const regions = computeCodeRegions('`one`\n\n    two\n\n  ```\nthree\n  ```');
		expect(regions).toHaveLength(3);
		for (let i = 1; i < regions.length; i++) {
			expect(regions[i - 1].start).toBeLessThan(regions[i].start);
			expect(regions[i - 1].end).toBeLessThanOrEqual(regions[i].start);
		}
	});

	test('mixed: document with both inline code and fenced blocks', () => {
		const text = 'text `inline` more\n```\nfenced\n```\nend';
		const regions = computeCodeRegions(text);
		expect(regions.length).toBe(2);
		expect(text.slice(regions[0].start, regions[0].end)).toBe('`inline`');
		expect(text.slice(regions[1].start, regions[1].end)).toBe('```\nfenced\n```');
	});

	test('recognizes inline code inside raw HTML blocks and GFM table cells', () => {
		for (const text of [
			'<table>\n<tr><td>`99.99` 12.34</td></tr>\n</table>',
			'| Value |\n| --- |\n| `99.99` 12.34 |',
		]) {
			expect(computeCodeRegions(text).map(region => text.slice(region.start, region.end))).toEqual([
				'`99.99`',
			]);
		}
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

// ---------------------------------------------------------------------------
// Task 4.2: Unit tests for decoration skipping (call-site filtering pattern)
//
// extractAllDecorationRanges() is code-region-agnostic to preserve parity with
// standalone extraction functions. Code-region filtering is applied by callers
// using computeCodeRegions() + overlapsCodeRegion(). These tests verify the
// two-step pattern that call sites (e.g. the decorator in extension.ts) must use.
// ---------------------------------------------------------------------------

/** Helper that mirrors the filtering pattern used at call sites. */
function filterDecorations(text: string, defaultColor: string) {
	const all = extractAllDecorationRanges(text, defaultColor);
	const codeRegions = computeCodeRegions(text);
	if (codeRegions.length === 0) return all;

	const keep = (r: { start: number; end: number }) =>
		!overlapsCodeRegion(r.start, r.end, codeRegions);

	for (const [key, ranges] of all.highlights) {
		const filtered = ranges.filter(keep);
		if (filtered.length === 0) {
			all.highlights.delete(key);
		} else if (filtered.length !== ranges.length) {
			all.highlights.set(key, filtered);
		}
	}
	all.comments.splice(0, all.comments.length, ...all.comments.filter(keep));
	all.additions.splice(0, all.additions.length, ...all.additions.filter(keep));
	all.deletions.splice(0, all.deletions.length, ...all.deletions.filter(keep));
	all.additionDelimiters.splice(0, all.additionDelimiters.length, ...all.additionDelimiters.filter(keep));
	all.deletionDelimiters.splice(0, all.deletionDelimiters.length, ...all.deletionDelimiters.filter(keep));
	all.substitutionDelimiters.splice(0, all.substitutionDelimiters.length, ...all.substitutionDelimiters.filter(keep));
	all.substitutionOld.splice(0, all.substitutionOld.length, ...all.substitutionOld.filter(keep));
	all.substitutionNew.splice(0, all.substitutionNew.length, ...all.substitutionNew.filter(keep));
	all.highlightDelimiters.splice(0, all.highlightDelimiters.length, ...all.highlightDelimiters.filter(keep));
	all.commentDelimiters.splice(0, all.commentDelimiters.length, ...all.commentDelimiters.filter(keep));
	return all;
}

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
	/\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|\{>>([\s\S]*?)<<\}|\{#[a-zA-Z0-9_-]+\}|\{\/[a-zA-Z0-9_-]+\}|\{==([\s\S]*?)==\}|(?<![{=])==([^}=]+)==\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\}|(?<![{=])==([^}=]+)==(?![}=])|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

function scanNavigation(text: string): Array<{ start: number; end: number }> {
	const codeRegions = computeCodeRegions(text);
	const re = new RegExp(combinedPattern.source, combinedPattern.flags);
	const matches: Array<{ start: number; end: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		matches.push({ start: m.index, end: m.index + m[0].length });
	}
	// Filter out matches inside code regions
	const nonCodeMatches = matches.filter(
		match => !overlapsCodeRegion(match.start, match.end, codeRegions)
	);
	// Filter contained ranges (same as production)
	const filtered: Array<{ start: number; end: number }> = [];
	let lastKept: { start: number; end: number } | undefined;
	for (const o of nonCodeMatches) {
		if (!lastKept || !(lastKept.start <= o.start && o.end <= lastKept.end)) {
			filtered.push(o);
			lastKept = o;
		}
	}
	return filtered;
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
