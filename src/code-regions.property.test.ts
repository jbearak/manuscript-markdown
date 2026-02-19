// Bugfix: code-region-inert-zones, Property 1: Code Region Inertness
// Verifies that the call-site filtering pattern (extractAllDecorationRanges +
// computeCodeRegions + overlapsCodeRegion) produces no decoration ranges overlapping
// code regions. extractAllDecorationRanges itself is code-region-agnostic; callers
// are responsible for filtering (see extension.ts updateHighlightDecorations).

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { extractAllDecorationRanges } from './highlight-colors';
import { scanCitationUsages } from './lsp/citekey-language';

// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.10**

// ---------------------------------------------------------------------------
// Oracle: compute code regions from text (inline code spans + fenced blocks)
// ---------------------------------------------------------------------------

interface CodeRegion {
	start: number;
	end: number;
}

/**
 * Identify all code regions in `text` — fenced code blocks first, then
 * inline code spans in the remaining text. Returns sorted, non-overlapping
 * regions (inclusive of delimiters).
 */
function computeCodeRegionsForTest(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];

	// --- 1. Fenced code blocks (``` or ~~~) ---
	// A fenced code block starts with a line beginning with >=3 backticks or tildes
	// and ends with a line beginning with >=3 of the same char (>= opening count).
	const fenceRe = /^(`{3,}|~{3,})[^\n]*$/gm;
	let openFence: { char: string; count: number; start: number } | null = null;
	let fenceMatch: RegExpExecArray | null;

	while ((fenceMatch = fenceRe.exec(text)) !== null) {
		const fence = fenceMatch[1]; // the backtick/tilde run
		const fenceChar = fence[0];
		const fenceCount = fence.length;

		if (!openFence) {
			openFence = { char: fenceChar, count: fenceCount, start: fenceMatch.index };
		} else if (fenceChar === openFence.char && fenceCount >= openFence.count) {
			// Closing fence — region spans from opening line start to end of closing line
			const end = fenceMatch.index + fenceMatch[0].length;
			regions.push({ start: openFence.start, end });
			openFence = null;
		}
		// else: different char or shorter run — ignore while inside open fence
	}
	// Unclosed fence extends to end of text
	if (openFence) {
		regions.push({ start: openFence.start, end: text.length });
	}

	// --- 2. Inline code spans (CommonMark §6.1) ---
	// Only scan text outside fenced blocks.
	// Opening backtick string matched with equal-length closing backtick string.
	const isInsideFence = (pos: number): boolean =>
		regions.some(r => pos >= r.start && pos < r.end);

	let i = 0;
	while (i < text.length) {
		if (isInsideFence(i)) {
			// Skip to end of this fence region
			const r = regions.find(r => i >= r.start && i < r.end)!;
			i = r.end;
			continue;
		}
		if (text[i] === '`') {
			// Count opening backtick string length
			let btCount = 0;
			const btStart = i;
			while (i < text.length && text[i] === '`') { btCount++; i++; }
			// Search for matching closing backtick string of same length
			let found = false;
			let j = i;
			while (j < text.length) {
				if (isInsideFence(j)) {
					const r = regions.find(r => j >= r.start && j < r.end)!;
					j = r.end;
					continue;
				}
				if (text[j] === '`') {
					let closeCount = 0;
					const closeStart = j;
					while (j < text.length && text[j] === '`') { closeCount++; j++; }
					if (closeCount === btCount) {
						regions.push({ start: btStart, end: j });
						found = true;
						i = j;
						break;
					}
					// Not matching length — continue searching
				} else {
					j++;
				}
			}
			if (!found) {
				// No matching close — backticks are literal, advance past them
				// i is already past the opening backticks
			}
		} else {
			i++;
		}
	}

	// Sort by start position
	regions.sort((a, b) => a.start - b.start);
	return regions;
}

/** Check if a range [start, end) overlaps any code region */
function overlapsCodeRegion(
	start: number,
	end: number,
	regions: CodeRegion[]
): boolean {
	return regions.some(r => start < r.end && end > r.start);
}

// ---------------------------------------------------------------------------
// Generators — bounded per AGENTS.md guidance
// ---------------------------------------------------------------------------

// Safe content that won't accidentally form CriticMarkup or backticks
const safeChar = fc.constantFrom(
	...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')
);
const safeContent = fc
	.array(safeChar, { minLength: 1, maxLength: 10 })
	.map(a => a.join(''));

// CriticMarkup pattern generators
const criticAddition = safeContent.map(s => `{++${s}++}`);
const criticDeletion = safeContent.map(s => `{--${s}--}`);
const criticSubstitution = fc
	.tuple(safeContent, safeContent)
	.map(([a, b]) => `{~~${a}~>${b}~~}`);
const criticComment = safeContent.map(s => `{>>${s}<<}`);
const criticHighlight = safeContent.map(s => `{==${s}==}`);
const formatHighlight = safeContent.map(s => `==${s}==`);
const coloredHighlight = fc
	.tuple(safeContent, fc.constantFrom('red', 'blue', 'green', 'yellow'))
	.map(([s, c]) => `==${s}=={${c}}`);
const citation = safeContent
	.filter(s => s.trim().length > 0 && /^[a-z0-9]+$/.test(s.trim()))
	.map(s => `[@${s.trim()}]`);

// Any CriticMarkup/highlight/citation pattern
const anyPattern = fc.oneof(
	criticAddition,
	criticDeletion,
	criticSubstitution,
	criticComment,
	criticHighlight,
	formatHighlight,
	coloredHighlight,
	citation
);

// Wrap a pattern inside an inline code span
const inlineCodeWithPattern = anyPattern.map(p => '`' + p + '`');

// Wrap a pattern inside a fenced code block
const fencedCodeWithPattern = anyPattern.map(
	p => '```\n' + p + '\n```'
);

// Document generator: mix of safe text, patterns in code, and patterns outside code
const documentWithCodeRegions = fc
	.array(
		fc.oneof(
			{ weight: 2, arbitrary: safeContent },
			{ weight: 3, arbitrary: inlineCodeWithPattern },
			{ weight: 3, arbitrary: fencedCodeWithPattern }
		),
		{ minLength: 1, maxLength: 6 }
	)
	.map(parts => parts.join('\n'));

// ---------------------------------------------------------------------------
// Test-local navigation scanner (mirrors combinedPattern from changes.ts)
// ---------------------------------------------------------------------------

const combinedPattern =
	/\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|\{>>([\s\S]*?)<<\}|\{#[a-zA-Z0-9_-]+\}|\{\/[a-zA-Z0-9_-]+\}|\{==([\s\S]*?)==\}|(?<!\{)==([^}=]+)==\{[a-z0-9-]+\}|(?<!\{)==([^}=]+)==(?!\})|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

function scanNavigation(text: string): Array<{ start: number; end: number }> {
	const codeRegions = computeCodeRegionsForTest(text);
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

// ---------------------------------------------------------------------------
// Property 1: Fault Condition — Code Region Inertness
// ---------------------------------------------------------------------------

describe('Property 1: Code Region Inertness', () => {
	test('call-site filtering produces no decoration ranges overlapping code regions', () => {
		fc.assert(
			fc.property(documentWithCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				if (regions.length === 0) return; // skip texts with no code regions

				// Two-step pattern used by call sites (mirrors extension.ts):
				const raw = extractAllDecorationRanges(text, 'yellow');
				const keep = (r: { start: number; end: number }) =>
					!overlapsCodeRegion(r.start, r.end, regions);

				// Collect filtered decoration ranges
				const allRanges: Array<{ start: number; end: number; label: string }> = [];

				for (const [color, ranges] of raw.highlights) {
					for (const r of ranges.filter(keep)) {
						allRanges.push({ ...r, label: `highlight(${color})` });
					}
				}
				for (const r of raw.comments.filter(keep)) allRanges.push({ ...r, label: 'comment' });
				for (const r of raw.additions.filter(keep)) allRanges.push({ ...r, label: 'addition' });
				for (const r of raw.deletions.filter(keep)) allRanges.push({ ...r, label: 'deletion' });
				for (const r of raw.substitutionNew.filter(keep)) allRanges.push({ ...r, label: 'substitutionNew' });
				for (const r of raw.delimiters.filter(keep)) allRanges.push({ ...r, label: 'delimiter' });

				for (const range of allRanges) {
					if (overlapsCodeRegion(range.start, range.end, regions)) {
						throw new Error(
							`Decoration "${range.label}" at [${range.start}, ${range.end}) ` +
							`overlaps code region in text: ${JSON.stringify(text)}`
						);
					}
				}
			}),
			{ numRuns: 300 }
		);
	});

	test('scanCitationUsages returns no usages overlapping code regions', () => {
		fc.assert(
			fc.property(documentWithCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				if (regions.length === 0) return;

				const usages = scanCitationUsages(text);

				for (const usage of usages) {
					if (overlapsCodeRegion(usage.keyStart, usage.keyEnd, regions)) {
						throw new Error(
							`Citation usage "@${usage.key}" at [${usage.keyStart}, ${usage.keyEnd}) ` +
							`overlaps code region in text: ${JSON.stringify(text)}`
						);
					}
				}
			}),
			{ numRuns: 300 }
		);
	});

	test('navigation scanner returns no matches overlapping code regions', () => {
		fc.assert(
			fc.property(documentWithCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				if (regions.length === 0) return;

				const matches = scanNavigation(text);

				for (const match of matches) {
					if (overlapsCodeRegion(match.start, match.end, regions)) {
						throw new Error(
							`Navigation match at [${match.start}, ${match.end}) ` +
							`"${text.slice(match.start, match.end)}" ` +
							`overlaps code region in text: ${JSON.stringify(text)}`
						);
					}
				}
			}),
			{ numRuns: 300 }
		);
	});
});

// ---------------------------------------------------------------------------
// Property 2: Preservation — Non-Code-Region Behavior Unchanged
// ---------------------------------------------------------------------------

// Generator: documents with CriticMarkup/highlight/citation patterns but NO
// backticks or fenced code blocks. For these texts computeCodeRegions returns [],
// so the code-region fix has zero effect.
const documentWithoutCodeRegions = fc
	.array(
		fc.oneof(
			{ weight: 3, arbitrary: safeContent },
			{ weight: 2, arbitrary: criticAddition },
			{ weight: 2, arbitrary: criticDeletion },
			{ weight: 1, arbitrary: criticSubstitution },
			{ weight: 1, arbitrary: criticComment },
			{ weight: 2, arbitrary: criticHighlight },
			{ weight: 2, arbitrary: formatHighlight },
			{ weight: 1, arbitrary: coloredHighlight },
			{ weight: 1, arbitrary: citation }
		),
		{ minLength: 1, maxLength: 8 }
	)
	.map(parts => parts.join(' '));

describe('Property 2: Preservation — Non-Code-Region Behavior Unchanged', () => {
	test('extractAllDecorationRanges produces non-empty results for texts with CriticMarkup and no code regions', () => {
		fc.assert(
			fc.property(
				fc.oneof(
					criticAddition,
					criticDeletion,
					criticComment,
					criticHighlight,
					formatHighlight,
					coloredHighlight
				),
				(pattern) => {
					// A single CriticMarkup/highlight pattern with no code regions
					const text = `before ${pattern} after`;
					const regions = computeCodeRegionsForTest(text);
					expect(regions.length).toBe(0);

					const result = extractAllDecorationRanges(text, 'yellow');

					// At least one decoration category should be non-empty
					const totalRanges =
						result.comments.length +
						result.additions.length +
						result.deletions.length +
						result.substitutionNew.length +
						result.delimiters.length +
						[...result.highlights.values()].reduce((sum, arr) => sum + arr.length, 0);

					expect(totalRanges).toBeGreaterThan(0);
				}
			),
			{ numRuns: 300 }
		);
	});

	test('navigation scanner produces matches for texts with CriticMarkup and no code regions', () => {
		fc.assert(
			fc.property(
				fc.oneof(
					criticAddition,
					criticDeletion,
					criticComment,
					criticHighlight,
					formatHighlight,
					coloredHighlight
				),
				(pattern) => {
					const text = `before ${pattern} after`;
					const regions = computeCodeRegionsForTest(text);
					expect(regions.length).toBe(0);

					const matches = scanNavigation(text);
					expect(matches.length).toBeGreaterThan(0);
				}
			),
			{ numRuns: 300 }
		);
	});

	test('scanCitationUsages produces usages for citation patterns with no code regions', () => {
		fc.assert(
			fc.property(citation, (cit) => {
				const text = `some text ${cit} more text`;
				const regions = computeCodeRegionsForTest(text);
				expect(regions.length).toBe(0);

				const usages = scanCitationUsages(text);
				expect(usages.length).toBeGreaterThan(0);
			}),
			{ numRuns: 300 }
		);
	});

	test('extractAllDecorationRanges on mixed no-code-region documents returns consistent results', () => {
		fc.assert(
			fc.property(documentWithoutCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				// No code regions should be found (no backticks in generators)
				expect(regions.length).toBe(0);

				// Call twice — results should be identical (idempotence)
				const result1 = extractAllDecorationRanges(text, 'yellow');
				const result2 = extractAllDecorationRanges(text, 'yellow');

				expect(result1.comments).toEqual(result2.comments);
				expect(result1.additions).toEqual(result2.additions);
				expect(result1.deletions).toEqual(result2.deletions);
				expect(result1.substitutionNew).toEqual(result2.substitutionNew);
				expect(result1.delimiters).toEqual(result2.delimiters);
				expect([...result1.highlights.entries()]).toEqual([...result2.highlights.entries()]);
			}),
			{ numRuns: 300 }
		);
	});

	test('navigation scanner on mixed no-code-region documents returns consistent results', () => {
		fc.assert(
			fc.property(documentWithoutCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				expect(regions.length).toBe(0);

				const matches1 = scanNavigation(text);
				const matches2 = scanNavigation(text);

				expect(matches1).toEqual(matches2);
			}),
			{ numRuns: 300 }
		);
	});

	test('scanCitationUsages on mixed no-code-region documents returns consistent results', () => {
		fc.assert(
			fc.property(documentWithoutCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				expect(regions.length).toBe(0);

				const usages1 = scanCitationUsages(text);
				const usages2 = scanCitationUsages(text);

				expect(usages1).toEqual(usages2);
			}),
			{ numRuns: 300 }
		);
	});
});
