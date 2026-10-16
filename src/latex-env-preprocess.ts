/**
 * Bare LaTeX environment preprocessing.
 *
 * Wraps bare `\begin{env}...\end{env}` blocks in `$$...$$` so the existing
 * mathRule inline rule handles them. Runs before CriticMarkup preprocessing
 * so it sees markers in their original form.
 *
 * Only recognized display-math environments are wrapped. Code regions, HTML
 * comments, CriticMarkup spans, and the equations export reads, display
 * math and inline, are treated as "inert zones" and skipped, with the rest
 * of a paragraph after a fence of two dollar signs export reads as text.
 */

import { computeMarkdownRegions, isInsideCodeRegion } from './code-regions';
import { exportsLiterally } from './html-blocks';
import { criticCloserSearch } from './critic-markup';
import { DOCX_DOLLAR_MATH_OPTIONS, findDollarMathAt, isEscapedAt, type DollarMathOptions } from './math-delimiters';

// All environments recognized by the latexToOmml parser as display math.
export const DISPLAY_MATH_ENVIRONMENTS = new Set([
	'equation', 'equation*',
	'align', 'align*', 'aligned',
	'gather', 'gather*', 'gathered',
	'split',
	'multline', 'multline*',
	'flalign', 'flalign*',
	'alignat', 'alignat*',
	'cases',
	'matrix', 'smallmatrix',
	'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix',
	'subequations',
]);

interface Zone { start: number; end: number }

/**
 * Compute sorted, merged "inert zones" where bare environments should NOT
 * be recognized: code regions, HTML comments, CriticMarkup, the equations
 * export reads, and a paragraph's text after a fence export reads as text.
 * Not the HTML blocks export writes as text, which latexReplacements reads
 * past the environments it finds.
 */
export function computeInertZones(text: string): Zone[] {
	return inertZonesAndLiteralHtml(text).zones;
}

/** The inert zones of `text`, and the HTML blocks export writes as text */
function inertZonesAndLiteralHtml(text: string): { zones: Zone[]; literalHtml: Zone[] } {
	const zones: Zone[] = [];

	// 1. Code regions (fenced blocks + inline code spans), as export reads
	// them, with HTML blocks, a fence's line in which opens no code block,
	// and past whose edges no code span runs. And apart, the HTML blocks
	// export writes as text, as a <pre> or a <div>, but not one it reads
	// tables from, in which it reads an environment as display math (see
	// markWrappedLatexBlocks in md-to-docx.ts)
	const { codeRegions, blockCodeRegions, htmlRegions, literalHtmlRegions, inlineBlocks } = computeMarkdownRegions(text, { html: 'all', literalHtml: exportsLiterally, inlineBlocks: true });
	for (const r of codeRegions) {
		zones.push({ start: r.start, end: r.end });
	}
	// An opener in a code block, which markdown-it reads before any HTML or
	// CriticMarkup, is the block's text. One in a code span is left as on
	// main: the code regions read no HTML, math, links or blocks' ends, so
	// they can pair a backtick in a construct export reads first, as in
	// <b title="`">, with a later one, as in a comment's text, where the
	// <!-- is real
	const inCode = (offset: number) => isInsideCodeRegion(offset, blockCodeRegions);

	// 2. HTML comments <!-- ... -->, each to the first --> after it, but
	// not from a <!-- in a code block, which is the code's text: its zone
	// hid an environment up to any later -->, a directive's too (see
	// inCode). Where none is, none is after a later <!-- either
	for (let open = text.indexOf('<!--'); open !== -1;) {
		if (inCode(open)) {
			open = text.indexOf('<!--', open + 4);
			continue;
		}
		const close = text.indexOf('-->', open + 4);
		if (close === -1) break;
		zones.push({ start: open, end: close + 3 });
		open = text.indexOf('<!--', close + 3);
	}

	// 3. CriticMarkup spans, each comment's to its matching <<}, found for
	// all of them at once, as each unclosed one searched the rest of the text.
	// Not from an opener in a code block, which is the code's text: its zone
	// hid an environment up to a later closer (see inCode)
	const criticFrom = zones.length;
	const closers = criticCloserSearch(text);
	const cmMarkers: Array<{ open: string; close: string; nested?: boolean }> = [
		{ open: '{++', close: '++}' },
		{ open: '{--', close: '--}' },
		{ open: '{~~', close: '~~}' },
		{ open: '{>>', close: '<<}', nested: true },
		{ open: '{==', close: '==}' },
	];
	for (const { open, close, nested } of cmMarkers) {
		let searchFrom = 0;
		while (true) {
			const openIdx = text.indexOf(open, searchFrom);
			if (openIdx === -1) break;
			const contentStart = openIdx + open.length;
			if (inCode(openIdx)) {
				searchFrom = contentStart;
				continue;
			}
			let closeIdx: number;
			if (nested) {
				closeIdx = closers.matching(contentStart);
			} else {
				closeIdx = text.indexOf(close, contentStart);
			}
			if (closeIdx === -1) {
				// No closer after this opener, nor after a later one, but
				// for a comment's, as one nested in it needs its own
				if (!nested) break;
				searchFrom = contentStart;
				continue;
			}
			zones.push({ start: openIdx, end: closeIdx + close.length });
			searchFrom = closeIdx + close.length;
		}
	}
	// {#id>>...<<} comment bodies
	{
		const idCommentRe = /\{#[a-zA-Z0-9_-]+>>/g;
		let m: RegExpExecArray | null;
		while ((m = idCommentRe.exec(text)) !== null) {
			const contentStart = m.index + m[0].length;
			if (inCode(m.index)) continue;
			const closeIdx = closers.matching(contentStart);
			if (closeIdx === -1) continue;
			zones.push({ start: m.index, end: closeIdx + 3 });
		}
	}

	// 4. Each equation, display math and inline, whose environments are its
	// own, as one in inline math over lines, as export's math rule reads it
	// in the text it reads on its own: a paragraph's or a heading's (see
	// inlineBlocks in code-regions.ts), with those a CriticMarkup span above
	// joins, as preprocessCriticMarkup puts its line ends in placeholders, an
	// HTML block's, or else a line's, as a table row's or a note's first
	// line's. An equation opens at a dollar sign in none of the zones above,
	// whose constructs export reads first, and closes at the next that can
	// close it, in a zone or not, as the rule reads on into a code span or a
	// comment after its opener, but for one a backslash escapes (see
	// findDollarMathAt in math-delimiters.ts). A fence of two dollar signs
	// there that opens no equation, which export writes as text, as in a
	// line of text, or with a blank line before its closer, holds the rest of
	// that text, as an environment there, wrapped, would be its equation.
	// Before, each fence in the text paired with the next, so one in code, a
	// comment, CriticMarkup, an equation or a line of text paired with the
	// opening fence of display math after it, and the environment in that
	// math, out of each zone, was wrapped again, as was each in display math
	// after it. A search for an opener's closer stops at the first run of
	// dollar signs that may close it, so one of each kind at most reads to
	// its text's end, after which none of that kind opens there
	{
		const inert = mergeZones(zones);
		// Apart where they touch, as two list items' paragraphs
		const units = joinedUnits(inlineBlocks.concat(htmlRegions).sort((a, b) => a.start - b.start), mergeZones(zones.slice(criticFrom)));
		let zone = 0;
		let unit = 0;
		let lineEnd = -1;
		let options: DollarMathOptions | undefined;
		for (let at = text.indexOf('$'); at !== -1;) {
			while (zone < inert.length && inert[zone].end <= at) zone++;
			if (zone < inert.length && inert[zone].start <= at) {
				at = text.indexOf('$', inert[zone].end);
				continue;
			}
			while (unit < units.length && units[unit].end <= at) unit++;
			let end: number;
			if (unit < units.length && units[unit].start <= at) end = units[unit].end;
			else {
				if (at >= lineEnd) {
					const lineBreak = text.indexOf('\n', at);
					lineEnd = lineBreak === -1 ? text.length : lineBreak + 1;
				}
				end = lineEnd;
			}
			if (options?.end !== end) options = { ...DOCX_DOLLAR_MATH_OPTIONS, end };
			const math = findDollarMathAt(text, at, options);
			if (math?.kind === 'math') {
				zones.push({ start: math.start, end: math.end });
				at = text.indexOf('$', math.end);
			} else if (text.charCodeAt(at + 1) === 0x24 && !isEscapedAt(text, at)) {
				zones.push({ start: at, end });
				at = text.indexOf('$', end);
			} else {
				at = text.indexOf('$', at + 1);
			}
		}
	}

	return { zones: mergeZones(zones), literalHtml: literalHtmlRegions };
}

/** `units`, sorted, none in another, with each that a span of `spans`,
 *  sorted and merged, reaches from before it joined to the one before it */
function joinedUnits(units: Zone[], spans: Zone[]): Zone[] {
	const joined: Zone[] = [];
	let span = 0;
	// The furthest end of the spans that start before the unit
	let reach = -1;
	for (const u of units) {
		while (span < spans.length && spans[span].start < u.start) reach = Math.max(reach, spans[span++].end);
		const last = joined[joined.length - 1];
		if (last && reach > u.start) last.end = Math.max(last.end, u.end);
		else joined.push({ start: u.start, end: u.end });
	}
	return joined;
}

/** `zones` sorted by start, with those that overlap or touch merged */
function mergeZones(zones: Zone[]): Zone[] {
	const sorted = zones.slice().sort((a, b) => a.start - b.start);
	const merged: Zone[] = [];
	for (const z of sorted) {
		if (merged.length > 0 && z.start <= merged[merged.length - 1].end) {
			merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, z.end);
		} else {
			merged.push({ start: z.start, end: z.end });
		}
	}
	return merged;
}

/** Whether [start, end) overlaps a zone of `zones`, sorted and merged: the
 *  first that ends after `start`, found by binary search, as each
 *  environment asks, starts before `end` */
function overlapsAnyZone(start: number, end: number, zones: Zone[]): boolean {
	let lo = 0;
	let hi = zones.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (zones[mid].end <= start) lo = mid + 1;
		else hi = mid;
	}
	return lo < zones.length && zones[lo].start < end;
}

/**
 * Wrap bare `\begin{env}...\end{env}` blocks in `$$...$$`.
 *
 * "Bare" means the environment is not already inside a `$$` block, code,
 * HTML comment, or CriticMarkup span. Only environments in
 * DISPLAY_MATH_ENVIRONMENTS are wrapped.
 *
 * Blank lines inside the wrapped block are collapsed to single newlines so
 * markdown-it doesn't split them into separate paragraphs.
 */
export function wrapBareLatexEnvironments(text: string, mark = ''): string {
	return withReplacements(text, latexReplacements(text), mark);
}

/** `text` with each of `replacements`, in order, and `mark` before each,
 *  joined from its slices once, as a text built again for each would take
 *  time in their number times its length */
function withReplacements(text: string, replacements: Replacement[], mark = ''): string {
	if (replacements.length === 0) return text;
	const parts: string[] = [];
	let from = 0;
	for (const r of replacements) {
		parts.push(text.slice(from, r.start), mark, r.replacement);
		from = r.end;
	}
	parts.push(text.slice(from));
	return parts.join('');
}

/**
 * `wrapBareLatexEnvironments(text)`, with the line of `text` each of its
 * lines comes from: all but the blank lines it collapses in a block.
 */
export function wrapBareLatexEnvironmentsWithLines(text: string): { output: string; lines: number[] } {
	const lineStarts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
	const replacements = latexReplacements(text);
	const lines: number[] = [];
	let k = 0;
	for (let line = 0; line < lineStarts.length; line++) {
		const start = lineStarts[line], end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
		while (k < replacements.length && replacements[k].end <= start) k++;
		// A blank line strictly inside a block, which \n{2,} collapses
		if (start === end && k < replacements.length && start > replacements[k].start && end < replacements[k].end) continue;
		lines.push(line);
	}
	return { output: withReplacements(text, replacements), lines };
}

interface Replacement {
	start: number;
	end: number;
	replacement: string;
}

/** The bare environments of `text`, each with its block wrapped, in order */
function latexReplacements(text: string): Replacement[] {
	// Fast path: no \begin{ means nothing to do
	if (!text.includes('\\begin{')) return [];

	const { zones: inertZones, literalHtml } = inertZonesAndLiteralHtml(text);
	// The HTML blocks export writes as text, but one that starts in an
	// environment found before, whose lines the wrap joins into one
	// paragraph, as a line of <x> after a blank line, which the parse here
	// read as a block over the environment's end. An environment that
	// starts in one export writes as text stays unwrapped.
	let literalAt = 0;
	const inLiteralHtml = (offset: number): boolean => {
		while (literalAt < literalHtml.length && literalHtml[literalAt].end <= offset) literalAt++;
		const region = literalHtml[literalAt];
		if (!region || region.start > offset) return false;
		// The last environment found that starts at or before the block,
		// which the block starts in where it starts before its end
		let lo = 0;
		let hi = replacements.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (replacements[mid].start <= region.start) lo = mid + 1;
			else hi = mid - 1;
		}
		const before = replacements[hi];
		return !(before && region.start < before.end);
	};

	// Find bare \begin{env} at start of line (up to 3 spaces indent)
	const beginRe = /^([ ]{0,3})\\begin\{([a-zA-Z*]+)\}/gm;
	let match: RegExpExecArray | null;
	const replacements: Replacement[] = [];
	// For each environment, where the last search for its end went from and
	// what it found, -1 for none, which a search from a later start before
	// it finds again, so that no part of the text is searched twice for one
	const ends = new Map<string, { from: number; at: number }>();
	const endOf = (endMarker: string, from: number): number => {
		const last = ends.get(endMarker);
		if (last && from >= last.from && (last.at === -1 || from <= last.at)) return last.at;
		const at = text.indexOf(endMarker, from);
		ends.set(endMarker, { from, at });
		return at;
	};

	while ((match = beginRe.exec(text)) !== null) {
		const envName = match[2];
		if (!DISPLAY_MATH_ENVIRONMENTS.has(envName)) continue;

		const blockStart = match.index;
		if (overlapsAnyZone(blockStart, blockStart + match[0].length, inertZones)) continue;

		// Skip if this match falls inside an already-collected replacement
		// (handles nested environments — only the outermost is wrapped)
		if (replacements.length > 0 && blockStart < replacements[replacements.length - 1].end) continue;
		if (inLiteralHtml(blockStart)) continue;

		// Find matching \end{envName}
		const endMarker = '\\end{' + envName + '}';
		const endIdx = endOf(endMarker, blockStart + match[0].length);
		if (endIdx === -1) continue;
		const blockEnd = endIdx + endMarker.length;

		if (overlapsAnyZone(endIdx, blockEnd, inertZones)) continue;

		// Extract block content (without leading indent)
		const innerContent = text.slice(blockStart + match[1].length, blockEnd);

		// Collapse \n\n → \n inside the block so markdown-it sees it as one paragraph
		const collapsed = innerContent.replace(/\n{2,}/g, '\n');

		replacements.push({
			start: blockStart,
			end: blockEnd,
			replacement: match[1] + '$$' + collapsed + '$$',
		});
	}

	return replacements;
}
