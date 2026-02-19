// Unit tests for code-region-inert-zones bugfix
// Tasks 3.2, 4.2, 5.2

import { describe, test, expect } from 'bun:test';
import {
	computeCodeRegions,
	isInsideCodeRegion,
	overlapsCodeRegion,
} from './code-regions';
import { extractAllDecorationRanges } from './highlight-colors';

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
	all.delimiters.splice(0, all.delimiters.length, ...all.delimiters.filter(keep));
	all.substitutionNew.splice(0, all.substitutionNew.length, ...all.substitutionNew.filter(keep));
	return all;
}

describe('call-site code-region filtering skips code regions', () => {
	test('inline code with addition: `{++added++}` — no addition ranges', () => {
		const text = '`{++added++}`';
		const result = filterDecorations(text, 'yellow');
		expect(result.additions.length).toBe(0);
		expect(result.delimiters.length).toBe(0);
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
		expect(result.delimiters.length).toBe(0);
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
		expect(result.delimiters.length).toBe(0);
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
	/\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|\{>>([\s\S]*?)<<\}|\{#[a-zA-Z0-9_-]+\}|\{\/[a-zA-Z0-9_-]+\}|\{==([\s\S]*?)==\}|(?<!\{)==([^}=]+)==\{[a-z0-9-]+\}|(?<!\{)==([^}=]+)==(?!\})|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

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
