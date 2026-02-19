// Bugfix: code-region-inert-zones, Property 1: Fault Condition — Code Region Inertness
// This test MUST FAIL on unfixed code — failure confirms the bug exists.
// DO NOT attempt to fix the test or the code when it fails.

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

describe('Property 1: Fault Condition — Code Region Inertness', () => {
	test('extractAllDecorationRanges returns no ranges overlapping code regions', () => {
		fc.assert(
			fc.property(documentWithCodeRegions, (text) => {
				const regions = computeCodeRegionsForTest(text);
				if (regions.length === 0) return; // skip texts with no code regions

				const result = extractAllDecorationRanges(text, 'yellow');

				// Collect all decoration ranges
				const allRanges: Array<{ start: number; end: number; label: string }> = [];

				for (const [color, ranges] of result.highlights) {
					for (const r of ranges) {
						allRanges.push({ ...r, label: `highlight(${color})` });
					}
				}
				for (const r of result.comments) allRanges.push({ ...r, label: 'comment' });
				for (const r of result.additions) allRanges.push({ ...r, label: 'addition' });
				for (const r of result.deletions) allRanges.push({ ...r, label: 'deletion' });
				for (const r of result.substitutionNew) allRanges.push({ ...r, label: 'substitutionNew' });
				for (const r of result.delimiters) allRanges.push({ ...r, label: 'delimiter' });

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
