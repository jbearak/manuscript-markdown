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

import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { computeMarkdownRegions, isInsideCodeRegion } from './code-regions';
import { exportsLiterally } from './html-blocks';
import { criticCloserSearch } from './critic-markup';
import { citationEnd } from './citation-syntax';
import { highlightCloseAt } from './highlight-syntax';
import { imagePathsWithSpaces } from './image-paths';
import { linearInlineComments } from './inline-html-comments';
import { DOCX_DOLLAR_MATH_OPTIONS, findDollarMathAt, isEscapedAt } from './math-delimiters';

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

	const critic = mergeZones(zones.slice(criticFrom));

	// 4. Each equation, display math and inline, whose environments are its
	// own, as one in inline math over lines, as export reads it in the text
	// markdown-it's inline parse reads on its own: a paragraph's or a
	// heading's (see inlineBlocks in code-regions.ts), with those a
	// CriticMarkup span above joins, as preprocessCriticMarkup puts its line
	// ends in placeholders, an HTML block's, or else a line's, as a table
	// row's or a note's first line's. That text is read with the inline rules
	// of export's that read past a dollar sign before its math rule can (see
	// equationReader), so a code span's backticks pair in that text alone,
	// where the zones above pair one in a paragraph with one in the next, and
	// a dollar sign in a tag, an autolink, a link's destination or title, a
	// URL or a citation opens no equation, and a highlight's text is read on
	// its own, as export reads it. A fence of two dollar signs that
	// opens none, which export writes as text, as in a line of text, or with
	// a blank line before its closer, holds the rest of that text, as an
	// environment there, wrapped, would be its equation. Before, each fence
	// in the text paired with the next, so one in code, a comment,
	// CriticMarkup, an equation or a line of text paired with the opening
	// fence of display math after it, and the environment in that math, out
	// of each zone, was wrapped again, as was each in display math after it.
	// Each text with a dollar sign out of a code block is read once
	{
		// Apart where they touch, as two list items' paragraphs
		const units = joinedUnits(inlineBlocks.concat(htmlRegions).sort((a, b) => a.start - b.start), critic);
		const read: EquationRead = { zones, critic, nextCritic: 0, from: 0, inert: new Map(), top: undefined, apart: [], runState: undefined, runAt: -1, runEnd: -1 };
		let code = 0;
		let unit = 0;
		for (let at = text.indexOf('$'); at !== -1;) {
			while (code < blockCodeRegions.length && blockCodeRegions[code].end <= at) code++;
			if (code < blockCodeRegions.length && blockCodeRegions[code].start <= at) {
				at = text.indexOf('$', blockCodeRegions[code].end);
				continue;
			}
			while (unit < units.length && units[unit].end <= at) unit++;
			let start: number;
			let end: number;
			if (unit < units.length && units[unit].start <= at) ({ start, end } = units[unit]);
			else {
				start = text.lastIndexOf('\n', at - 1) + 1;
				const lineBreak = text.indexOf('\n', at);
				end = lineBreak === -1 ? text.length : lineBreak + 1;
			}
			readEquations(text, start, end, read);
			at = text.indexOf('$', end);
		}
	}

	return { zones: mergeZones(zones), literalHtml: literalHtmlRegions };
}

/** What readEquations reads with: the zones it adds to, the CriticMarkup
 *  spans, sorted and merged, and the first that may reach the text it reads
 *  next, where that text starts, the spans in it, each end by where it
 *  starts in it, the state that reads that text, the highlights' texts in it
 *  to read on their own after it, and the run of dollar signs read last, and
 *  the state that read it */
interface EquationRead {
	zones: Zone[];
	critic: Zone[];
	nextCritic: number;
	from: number;
	inert: Map<number, number>;
	top: StateInline | undefined;
	apart: Zone[];
	runState: StateInline | undefined;
	runAt: number;
	runEnd: number;
}

/** markdown-it with the inline rules of export's (see createMarkdownIt in
 *  md-to-docx.ts) that read past a dollar sign before its math rule can: an
 *  escape, a code span, raw HTML, an autolink, a link's or an image's
 *  destination and title, a URL linkify reads, a highlight, a citation, and
 *  CriticMarkup as the zones above have it, which comes first, as one may
 *  start a text that a span from before joins. And that math rule.
 *
 *  Only the state readEquations reads its text with records a zone, at
 *  offsets in that text: its tokens, a link's text's too, which markdown-it
 *  reads with that state, and the scans for a link's or an image's label in
 *  it. Not the parses of other texts, as an image's alt, which markdown-it
 *  parses as a text of its own with the same env, or a citation's first
 *  item, which citationEnd parses to see whether its prefix is plain text,
 *  nor citationEnd's scans ahead, in a state of their own: their offsets
 *  are in other texts, or their reading may not be the text's, and an alt's
 *  [0, 3) made a zone at the paragraph's start, over the environment there */
const equationReader = new MarkdownIt({ html: true, linkify: true });
equationReader.linkify.set({ fuzzyLink: false });
equationReader.linkify.add('//', null);
equationReader.use(imagePathsWithSpaces);
equationReader.use(linearInlineComments);
equationReader.inline.ruler.before('text', 'inert', (state, silent) => {
	const read = state.env as EquationRead;
	// Its offsets are in the text read
	if (state.src !== read.top?.src) return false;
	const end = read.inert.get(state.pos);
	if (end === undefined) return false;
	if (!silent) state.pending += state.src.slice(state.pos, end);
	state.pos = end;
	return true;
});
// A highlight, whose text export reads on its own, so a dollar sign in it
// opens or closes no equation out of it (see coloredHighlightRule in
// md-to-docx.ts). A {color} after it holds no dollar sign
equationReader.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
	const close = highlightCloseAt(state, state.pos);
	if (close === -1) return false;
	const read = state.env as EquationRead;
	if (!silent && state === read.top) read.apart.push({ start: read.from + state.pos + 2, end: read.from + close });
	state.pos = close + 2;
	return true;
});
equationReader.inline.ruler.before('emphasis', 'citation', (state, silent) => {
	if (state.pos + 2 >= state.posMax) return false;
	const end = citationEnd(state, state.pos);
	if (end === -1) return false;
	if (!silent) state.pending += state.src.slice(state.pos, end + 1);
	// Export reads no equation in it, and its text is the citation's, so
	// display math with an environment in it is left as main left it, which
	// paired its fences
	if (!silent && state === (state.env as EquationRead).top) pairFences(state.src, state.pos + 1, end, state.env as EquationRead);
	state.pos = end + 1;
	return true;
});
equationReader.inline.ruler.before('emphasis', 'math', readMath);

/** Adds to `read`'s zones from each fence of two dollar signs in `src` from
 *  `start` to `end`, which no backslash escapes, to the next, as main paired
 *  each fence in the text with the next, but in that text alone, and from
 *  the last, without one, to `end` */
function pairFences(src: string, start: number, end: number, read: EquationRead): void {
	let open = -1;
	for (let at = src.indexOf('$', start); at !== -1 && at < end - 1;) {
		if (src.charCodeAt(at + 1) !== 0x24 || isEscapedAt(src, at)) {
			at = src.indexOf('$', at + 1);
			continue;
		}
		if (open === -1) open = at;
		else {
			read.zones.push({ start: read.from + open, end: read.from + at + 2 });
			open = -1;
		}
		at = src.indexOf('$', at + 2);
	}
	if (open !== -1) read.zones.push({ start: read.from + open, end: read.from + end });
}

/** export's math rule (see mathRule in md-to-docx.ts). In the text read,
 *  it adds each equation it reads to the read's zones, and the rest of that
 *  text after a fence that opens none. In a scan for a label there, it adds
 *  display math, whose fences main paired too, and such a fence: with an
 *  environment after it wrapped, the scan would read an equation from it to
 *  the wrapped one's opening fence, and so no label, as of an image, whose
 *  alt markdown-it then reads in a text of its own. But not an inline
 *  equation, which main read as none */
function readMath(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const at = state.pos;
	if (src.charCodeAt(at) !== 0x24) return false;
	const read = state.env as EquationRead;
	const top = state === read.top;
	// The run of dollar signs from here, counted once for each run
	if (read.runState !== state || !(read.runAt <= at && at < read.runEnd)) {
		read.runState = state;
		read.runAt = at;
		read.runEnd = at;
		while (src.charCodeAt(read.runEnd) === 0x24) read.runEnd++;
	}
	const run = read.runEnd - at;
	if (run >= 4 && !isEscapedAt(src, at)) {
		// An empty equation for each four, as findDollarMathAt reads them in
		// turn, from the first and then from the end of each, each time
		// counting the rest of the run, so a long one took time in its square
		const end = at + run - run % 4;
		if (top) read.zones.push({ start: read.from + at, end: read.from + end });
		state.pos = end;
		return true;
	}
	const match = findDollarMathAt(src, at, DOCX_DOLLAR_MATH_OPTIONS);
	if (match?.kind === 'math') {
		if (top && (!silent || match.delimiterLength === 2)) read.zones.push({ start: read.from + match.start, end: read.from + match.end });
		state.pos = match.end;
		return true;
	}
	// A fence export writes as text
	if (top && run >= 2 && !isEscapedAt(src, at)) read.zones.push({ start: read.from + at, end: read.from + src.length });
	return false;
}

/** Adds to `read`'s zones each equation export reads in the text of `text`
 *  from `start` to `end`, which it reads on its own, and the rest of that
 *  text after a fence that opens none, and then so for each highlight's
 *  text in it */
function readEquations(text: string, start: number, end: number, read: EquationRead): void {
	read.from = start;
	read.inert.clear();
	const { critic } = read;
	while (read.nextCritic < critic.length && critic[read.nextCritic].end <= start) read.nextCritic++;
	for (let k = read.nextCritic; k < critic.length && critic[k].start < end; k++) {
		read.inert.set(Math.max(critic[k].start, start) - start, Math.min(critic[k].end, end) - start);
	}
	const apart: Zone[] = [];
	read.apart = apart;
	// As inline.parse reads it, but for the rules after its tokens', which
	// read none of its dollar signs
	const state = new equationReader.inline.State(text.slice(start, end), equationReader, read, []);
	read.top = state;
	equationReader.inline.tokenize(state);
	for (const span of apart) readEquations(text, span.start, span.end, read);
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
