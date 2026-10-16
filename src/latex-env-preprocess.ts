/**
 * Bare LaTeX environment preprocessing.
 *
 * Wraps bare `\begin{env}...\end{env}` blocks in `$$...$$` so the existing
 * mathRule inline rule handles them. Runs before CriticMarkup preprocessing
 * so it sees markers in their original form.
 *
 * Only recognized display-math environments are wrapped. Code regions, HTML
 * comments, CriticMarkup spans, and the display math export reads, are
 * treated as "inert zones" and skipped. Where these leave an environment
 * otherwise than main's pairing of each fence with the next, main's
 * decision holds but where the read is certain (see environmentDecider).
 */

import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { computeLineStarts, computeMarkdownRegions, isInsideCodeRegion } from './code-regions';
import { exportsLiterally } from './html-blocks';
import { criticCloserSearch, criticCloserSearchOf, preprocessCriticMarkupWithLines } from './critic-markup';
import { citationEnd } from './citation-syntax';
import { highlightCloseAt } from './highlight-syntax';
import { imageRuleWithSpaces } from './image-paths';
import { pushAll } from './arrays';
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
 * be recognized: code regions, HTML comments, CriticMarkup, and the display
 * math export reads.
 * Not the HTML blocks export writes as text, which latexReplacements reads
 * past the environments it finds. Where these leave an environment
 * otherwise than main's zones do, latexReplacements takes main's decision
 * for it but where the read is certain (see environmentDecider).
 */
export function computeInertZones(text: string): Zone[] {
	return inertZonesAndLiteralHtml(text).zones;
}

/** The display math step 4 of computeInertZones reads in `text`, as export
 *  reads it, each from its opening fence to past its closing one, and the
 *  texts it can't read for certain, in which it finds none, for the test
 *  that checks them against the display math of export's own parse */
export function displayZones(text: string): DisplaysFound {
	const found: DisplaysFound = { displays: [], fallbacks: [] };
	inertZonesAndLiteralHtml(text, found);
	return found;
}

interface DisplaysFound {
	displays: Zone[];
	fallbacks: Zone[];
}

/** The inert zones of `text`, and what step 4 read them from */
interface InertReading {
	/** Sorted and merged */
	zones: Zone[];
	/** The HTML blocks export writes as text */
	literalHtml: Zone[];
	/** The zones of steps 1 to 3, as main found them too */
	steps: Zone[];
	/** The texts export's inline parse reads on its own, sorted (see
	 *  exportUnits) */
	units: Zone[];
	/** The text of each environment read as nothing, with a dollar sign or
	 *  a backtick in it (see withEnvironmentsMasked) */
	masked: Zone[];
	read: EquationRead;
}

/** The inert zones of `text`, and the HTML blocks export writes as text,
 *  with step 4's display math, and the texts it can't read for certain,
 *  added to `found`'s */
function inertZonesAndLiteralHtml(text: string, found?: DisplaysFound): InertReading {
	const zones: Zone[] = [];

	// 1. Code regions (fenced blocks + inline code spans), as export reads
	// them, with HTML blocks, a fence's line in which opens no code block,
	// and past whose edges no code span runs. And apart, the HTML blocks
	// export writes as text, as a <pre> or a <div>, but not one it reads
	// tables from, in which it reads an environment as display math (see
	// markWrappedLatexBlocks in md-to-docx.ts)
	const { codeRegions, blockCodeRegions, htmlRegions, literalHtmlRegions, inlineBlocks, references } = computeMarkdownRegions(text, { html: 'all', literalHtml: exportsLiterally, inlineBlocks: true });
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

	// 4. Display math, from each fence of two dollar signs export reads as
	// its opening fence to the one it reads as its closing fence: those
	// fences paired, as main paired each fence with the next, but no other.
	// Not a fence export reads as no display math's, in code, a comment, a
	// tag's attribute, a link's destination, a URL, a citation, inline math,
	// as in $x, a fence and y$, or as text. Before, each fence in the text
	// paired with the next, so one of those paired with the opening fence of
	// display math after it, and the environment in that math, out of each
	// zone, was wrapped again, as was each in display math after it.
	// What export reads is read in each text markdown-it's inline parse
	// reads on its own: a paragraph's or a heading's (see inlineBlocks in
	// code-regions.ts), with those a CriticMarkup span joins, as
	// preprocessCriticMarkup puts its line ends in placeholders, an HTML
	// block's, or else a line's, as a table row's or a note's first line's.
	// It is read with the inline rules of export's that read past a dollar
	// sign before its math rule can (see equationReader), and with the text
	// of each bare environment the wrap may wrap read as nothing, as it is
	// display math's once wrapped (see withEnvironmentsMasked). Nothing else
	// makes a zone: not inline math, as on main, as the text is read before
	// the wrap, and the inline math export reads after it may not be what
	// the read finds, nor a fence export writes as text, which an
	// environment after it in its paragraph, once wrapped, would pair with,
	// nor a citation, whose text export writes as it is. Each text with a
	// dollar sign out of a code block is read once. Where export reads a
	// CriticMarkup span's line end in it as a placeholder, and the read reads
	// that line end out of CriticMarkup, the read can't tell export's display
	// math, so it reads none there (see readEquations). Where the zones leave
	// an environment otherwise than main's, main's decision holds, but where
	// the read is certain, and the parse after the wrap confirms a wrap main
	// didn't make, so an environment after a fence export writes as text, or
	// in a citation, is left as main left it (see environmentDecider)
	const steps = zones.slice();
	const { units, breaks } = exportUnits(text, inlineBlocks, htmlRegions);
	const { source, masked } = text.includes('\\begin{') ? withEnvironmentsMasked(text, mergeZones(zones), literalHtmlRegions) : { source: text, masked: [] };
	const read: EquationRead = {
		zones, found, references, from: 0, top: undefined, uncertain: false, apart: [], critics: [], runState: undefined, runAt: -1, runEnd: -1,
		certainDisplays: [], certainInline: [], alts: [], unread: [],
	};
	{
		let code = 0;
		let unit = 0;
		let lineBreak = 0;
		for (let at = source.indexOf('$'); at !== -1;) {
			while (code < blockCodeRegions.length && blockCodeRegions[code].end <= at) code++;
			if (code < blockCodeRegions.length && blockCodeRegions[code].start <= at) {
				at = source.indexOf('$', blockCodeRegions[code].end);
				continue;
			}
			while (unit < units.length && units[unit].end <= at) unit++;
			let start: number;
			let end: number;
			if (unit < units.length && units[unit].start <= at) ({ start, end } = units[unit]);
			else {
				start = source.lastIndexOf('\n', at - 1) + 1;
				const lineEnd = source.indexOf('\n', at);
				end = lineEnd === -1 ? source.length : lineEnd + 1;
			}
			while (lineBreak < breaks.length && breaks[lineBreak] < start) lineBreak++;
			const first = lineBreak;
			while (lineBreak < breaks.length && breaks[lineBreak] < end) lineBreak++;
			readEquations(source, start, end, read, breaks.slice(first, lineBreak));
			at = source.indexOf('$', end);
		}
	}

	return { zones: mergeZones(zones), literalHtml: literalHtmlRegions, steps, units, masked, read };
}

/** What readEquations reads with: the zones it adds to, with the display
 *  math among them, and the texts it can't read for certain, where a test
 *  asks for those (see displayZones), the link definitions, which
 *  markdown-it's link rule reads from its env, as export's reads the
 *  document's, where the text read starts, the state that reads it,
 *  whether that text is in an image's alt, the texts in it to read on
 *  their own after it, the CriticMarkup read in the text, and the run of
 *  dollar signs read last, and the state that read it. And for
 *  environmentDecider, the display math and the inline math read outside
 *  images' alts, the alts, and the texts it can't read for certain, where
 *  main's decisions hold */
interface EquationRead {
	zones: Zone[];
	found: DisplaysFound | undefined;
	references: Record<string, unknown> | undefined;
	from: number;
	top: StateInline | undefined;
	uncertain: boolean;
	apart: Apart[];
	critics: Zone[];
	runState: StateInline | undefined;
	runAt: number;
	runEnd: number;
	certainDisplays: Zone[];
	certainInline: Zone[];
	alts: Zone[];
	unread: Zone[];
}

/** A text that export's parse reads on its own, as a highlight's or an
 *  image's alt, the link level it reads it at, and whether it is in an
 *  image's alt, whose fences the scan for the image's label in the
 *  paragraph reads too */
interface Apart extends Zone {
	linkLevel: number;
	uncertain: boolean;
}

/** markdown-it's typing leaves out linkLevel, which its linkify rule reads */
type LinkState = StateInline & { linkLevel: number };

/** markdown-it with the inline rules of export's (see createMarkdownIt in
 *  md-to-docx.ts) that read past a dollar sign before its math rule can, in
 *  its order: an escape, a code span, raw HTML, an autolink, a link's or an
 *  image's destination and title, a URL linkify reads, a comment's range,
 *  a highlight, CriticMarkup, a note's reference and a citation. And that
 *  math rule. Each pushes a token where export's does, as citationEnd reads
 *  a citation's prefix as plain text only where its parse holds no token
 *  but text, so a prefix with an equation in it is no citation's, as for
 *  export, where the read took it for one, and the display math in it, read
 *  on past the ], for the citation's text.
 *
 *  Only the state readEquations reads its text with records a zone, at
 *  offsets in that text: its display math, a link's text's too, which
 *  markdown-it reads with that state, but not in its scans for a link's or
 *  an image's label, which record nothing. Not the parses of other texts, as a citation's first item, which
 *  citationEnd parses to see whether its prefix is plain text, nor
 *  citationEnd's scans ahead, in a state of their own. A highlight's text
 *  and an image's alt, which export parses as texts of their own, are read
 *  after the text, each on its own, a highlight's at the link level it is
 *  at, an alt's at none, at their offsets in the text. A reference link
 *  reads the document's link definitions, as export's does */
const equationReader = new MarkdownIt({ html: true, linkify: true });
equationReader.linkify.set({ fuzzyLink: false });
equationReader.linkify.add('//', null);
equationReader.use(linearInlineComments);
{
	const image = imageRuleWithSpaces(equationReader);
	// As a scan for a label reads it, which parses no alt, as the read reads
	// the alt on its own, and with a token. With its parse in the image rule,
	// an image in an alt was parsed again for each image around it, and read
	// again for each, which took time in the cube of their depth
	equationReader.inline.ruler.at('image', (state, silent) => {
		const start = state.pos;
		if (!image(state, true)) return false;
		if (!silent) {
			const labelEnd = equationReader.helpers.parseLinkLabel(state, start + 1, false);
			state.push('image', 'img', 0);
			const read = state.env as EquationRead;
			if (state === read.top && labelEnd > start + 2) {
				const alt = { start: read.from + start + 2, end: read.from + labelEnd };
				read.alts.push(alt);
				read.apart.push({ ...alt, linkLevel: 0, uncertain: true });
			}
		}
		return true;
	});
}
// A comment's range, as {#c1} and {/c1}, or its text, as {#c1>>text<<},
// as commentRangeRule in md-to-docx.ts reads it, and a CriticMarkup span,
// as criticMarkupRule does. They start alike, so one rule reads both
equationReader.inline.ruler.before('emphasis', 'critic', (state, silent) => {
	const end = criticEnd(state, state.pos);
	if (end === -1) return false;
	if (!silent) {
		state.push('critic_markup', '', 0);
		const read = state.env as EquationRead;
		if (state === read.top) read.critics.push({ start: read.from + state.pos, end: read.from + end });
	}
	state.pos = end;
	return true;
});
// A highlight, whose text export reads on its own (see coloredHighlightRule
// in md-to-docx.ts), so a dollar sign in it opens or closes no equation out
// of it. A {color} after it holds no dollar sign
equationReader.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
	const close = highlightCloseAt(state, state.pos);
	if (close === -1) return false;
	const read = state.env as EquationRead;
	if (!silent) {
		state.push('mark_open', 'mark', 0);
		if (state === read.top) read.apart.push({ start: read.from + state.pos + 2, end: read.from + close, linkLevel: (state as LinkState).linkLevel, uncertain: read.uncertain });
	}
	state.pos = close + 2;
	return true;
});
// A note's reference, as footnoteRefRule in md-to-docx.ts reads it, which
// in a scan for a link's label takes its [ alone. Its label is read to its
// first character no label holds, where that rule reads to the first ] and
// checks the label then, which reads the same ones
equationReader.inline.ruler.before('emphasis', 'footnote_ref', (state, silent) => {
	const { src, posMax: max } = state;
	const start = state.pos;
	if (start + 2 >= max || src.charCodeAt(start) !== 0x5B || src.charCodeAt(start + 1) !== 0x5E) return false;
	let end = start + 2;
	while (end < max && /[a-zA-Z0-9_-]/.test(src[end])) end++;
	if (end === start + 2 || end >= max || src.charCodeAt(end) !== 0x5D) return false;
	if (silent) {
		state.pos = start + 1;
		return true;
	}
	state.push('footnote_ref', '', 0);
	state.pos = end + 1;
	return true;
});
equationReader.inline.ruler.before('emphasis', 'citation', (state, silent) => {
	if (state.pos + 2 >= state.posMax) return false;
	const end = citationEnd(state, state.pos);
	if (end === -1) return false;
	// Export reads no equation in it, and writes its text as it is. Where the
	// read wraps an environment in it, as no zone holds it, and main left it,
	// the parse after the wrap reads no display math there, so main's
	// decision holds (see rejectedWraps)
	if (!silent) state.push('citation', '', 0);
	state.pos = end + 1;
	return true;
});
equationReader.inline.ruler.before('emphasis', 'math', readMath);

/** Where the comment's range or text, or the CriticMarkup span, that the {
 *  at `start` in `state`'s text opens ends, past its closer, as export's
 *  commentRangeRule and criticMarkupRule read them, or -1. A closer, of a
 *  span or a comment's text, may be past posMax, as their search for it
 *  reads the whole text. */
function criticEnd(state: StateInline, start: number): number {
	const { src, posMax: max } = state;
	if (start >= max || src.charCodeAt(start) !== 0x7B) return -1;
	const second = src[start + 1];
	if (second === '#' || second === '/') {
		let idEnd = start + 2;
		while (idEnd < max && /[a-zA-Z0-9_-]/.test(src[idEnd])) idEnd++;
		if (idEnd === start + 2) return -1;
		if (second === '#' && idEnd + 1 < max && src[idEnd] === '>' && src[idEnd + 1] === '>') {
			const close = criticCloserSearchOf(state).matching(idEnd + 2);
			return close === -1 ? -1 : close + 3;
		}
		return idEnd < max && src[idEnd] === '}' ? idEnd + 1 : -1;
	}
	if (start + 3 >= max) return -1;
	const marker = src.slice(start, start + 3);
	const closer = CRITIC_CLOSERS.get(marker);
	if (!closer) return -1;
	const closers = criticCloserSearchOf(state);
	const close = marker === '{>>' ? closers.matching(start + 3) : closers.next(closer, start + 3);
	if (close === -1) return -1;
	// A substitution's sides, with the ~> between them, before its closer
	if (marker === '{~~') {
		const separator = closers.next('~>', start + 3);
		if (separator === -1 || separator >= close) return -1;
	}
	return close + closer.length;
}

const CRITIC_CLOSERS = new Map([['{++', '++}'], ['{--', '--}'], ['{~~', '~~}'], ['{==', '==}'], ['{>>', '<<}']]);

/** export's math rule (see mathRule in md-to-docx.ts), which pushes a
 *  token for each equation it reads, as export's does. In the text read,
 *  but not in a scan for a link's or an image's label, it adds each display
 *  math to the read's zones, but no inline math, and out of an image's alt,
 *  each equation to the read's certain ones too (see environmentDecider).
 *  The scan reads a fence as the parse after it may not, as in a URL in a
 *  label without its link, which the parse reads after the scan finds no
 *  link. A link's text is read again, and an image's alt on its own */
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
		if (!silent) {
			state.push('math', '', 0);
			if (top) addDisplay(read, at, end);
		}
		state.pos = end;
		return true;
	}
	const match = findDollarMathAt(src, at, DOCX_DOLLAR_MATH_OPTIONS);
	if (match?.kind === 'math') {
		if (!silent) {
			state.push('math', '', 0);
			if (top && match.delimiterLength === 2) addDisplay(read, match.start, match.end);
			else if (top && !read.uncertain) read.certainInline.push({ start: read.from + match.start, end: read.from + match.end });
		}
		state.pos = match.end;
		return true;
	}
	return false;
}

/** Adds the display math from `start` to `end` in the text read to
 *  `read`'s zones, and to its display math, and out of an image's alt, to
 *  its certain display math */
function addDisplay(read: EquationRead, start: number, end: number): void {
	const zone = { start: read.from + start, end: read.from + end };
	read.zones.push(zone);
	read.found?.displays.push(zone);
	if (!read.uncertain) read.certainDisplays.push(zone);
}

/** Adds to `read`'s zones the display math export reads in the text of
 *  `text` from `start` to `end`, which it reads on its own, and then so for
 *  each text in it that export reads on its own, in turn. But where a line
 *  end of `breaks`, sorted, which export reads as a placeholder, is out of
 *  the CriticMarkup read, as in a citation's key or an equation, the
 *  placeholder is no space to the math rule, as in $5, a line end, and 6$,
 *  which export reads as an equation, which may hold a fence, and the read
 *  of the text could find other display math than export's. There it adds
 *  none, and the text is one the read is not certain of, where main's
 *  decisions hold (see environmentDecider) */
function readEquations(text: string, start: number, end: number, read: EquationRead, breaks: number[]): void {
	const zoneCount = read.zones.length;
	const displayCount = read.found?.displays.length ?? 0;
	const certainCounts = [read.certainDisplays.length, read.certainInline.length, read.alts.length];
	read.critics = [];
	const texts: Apart[] = [{ start, end, linkLevel: 0, uncertain: false }];
	for (let next = texts.pop(); next; next = texts.pop()) {
		read.from = next.start;
		read.uncertain = next.uncertain;
		read.apart = [];
		// As inline.parse reads it, but for the rules after its tokens', which
		// read none of its dollar signs
		const state = new equationReader.inline.State(text.slice(next.start, next.end), equationReader, read, []);
		(state as LinkState).linkLevel = next.linkLevel;
		read.top = state;
		equationReader.inline.tokenize(state);
		pushAll(texts, read.apart);
	}
	if (breaks.length === 0) return;
	const critics = read.critics.sort((a, b) => a.start - b.start);
	let critic = 0;
	for (const lineBreak of breaks) {
		while (critic < critics.length && critics[critic].end <= lineBreak) critic++;
		if (critic < critics.length && critics[critic].start <= lineBreak) continue;
		read.zones.length = zoneCount;
		if (read.found) {
			read.found.displays.length = displayCount;
			read.found.fallbacks.push({ start, end });
		}
		[read.certainDisplays.length, read.certainInline.length, read.alts.length] = certainCounts;
		read.unread.push({ start, end });
		return;
	}
}

/** The lines of each paragraph, heading and HTML block of `text`, sorted,
 *  as export's block parse reads them, after preprocessCriticMarkup puts the
 *  line ends of each CriticMarkup span in placeholders, and those line
 *  ends, sorted. A span over a blank line joins a paragraph to the next,
 *  and one in a heading takes the lines it goes over into the heading, from
 *  the paragraph after it. Those are `inlineBlocks` and `htmlRegions`,
 *  which the block parse of `text` read, where no span has a line end in
 *  it. Before, a span from one block into another joined the two, so the
 *  read of a heading took in all of the paragraph after it */
function exportUnits(text: string, inlineBlocks: Zone[], htmlRegions: Zone[]): { units: Zone[]; breaks: number[] } {
	const sorted = (units: Zone[]) => units.sort((a, b) => a.start - b.start);
	// Its line ends are \n alone, as preprocessCriticMarkup reads them
	if (text.includes('\r')) return { units: sorted(inlineBlocks.concat(htmlRegions)), breaks: [] };
	const { output, lines } = preprocessCriticMarkupWithLines(text);
	if (output === text) return { units: sorted(inlineBlocks.concat(htmlRegions)), breaks: [] };
	const regions = computeMarkdownRegions(output, { html: 'all', inlineBlocks: true });
	// Where each line of the output starts, by its line, and where the line
	// of `text` it comes from starts
	const outputLines = new Map(computeLineStarts(output).map((start, line) => [start, line]));
	const textStarts = computeLineStarts(text);
	const inText = (offset: number) => {
		const line = outputLines.get(offset);
		return offset >= output.length || line === undefined ? text.length : textStarts[lines[line]] ?? text.length;
	};
	// The line end before each line of `text` that a line of the output
	// goes on into, past its first
	const breaks: number[] = [];
	for (let line = 0; line + 1 < lines.length; line++) {
		for (let joined = lines[line] + 1; joined < lines[line + 1]; joined++) {
			if (joined < textStarts.length) breaks.push(textStarts[joined] - 1);
		}
	}
	const units: Zone[] = [];
	for (const { start, end } of sorted(regions.inlineBlocks.concat(regions.htmlRegions))) {
		const unit = { start: inText(start), end: inText(end) };
		// An opener preprocessCriticMarkup moved from the end of the line
		// before, or the line before a blank line, which its line maps past,
		// so the read took the span's text and its fences out of it (see
		// moveLeadingBreakOutsideCritic in critic-markup.ts). The unit starts
		// at the opener, and the unit before it ends there
		movedOpener.lastIndex = start;
		const moved = movedOpener.exec(output);
		if (moved) {
			const opener = openerBefore(text, unit.start, moved[1]);
			if (opener !== -1) {
				unit.start = opener;
				const before = units[units.length - 1];
				if (before && before.end > opener) before.end = opener;
			}
		}
		units.push(unit);
	}
	return { units, breaks };
}

const movedOpener = /[ \t>]*(\{\+\+|\{--|\{~~|\{==|\{>>)/y;

/** Where `opener` is in `text` before the line at `lineStart`, at the end
 *  of the line before it, or of the line before that, where the line
 *  between is blank or a quote's marker alone, as
 *  moveLeadingBreakOutsideCritic moves it from, or -1 where the line at
 *  `lineStart` holds it */
function openerBefore(text: string, lineStart: number, opener: string): number {
	movedOpener.lastIndex = lineStart;
	if (movedOpener.exec(text)?.[1] === opener) return -1;
	const lineEnd = lineStart - 1;
	if (text.startsWith(opener, lineEnd - opener.length)) return lineEnd - opener.length;
	const before = text.lastIndexOf('\n', lineEnd - 1);
	if (before !== -1 && /^[ \t]*(?:>[ \t]*)?$/.test(text.slice(before + 1, lineEnd)) && text.startsWith(opener, before - opener.length)) return before - opener.length;
	return -1;
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
	const reading = inertZonesAndLiteralHtml(text);
	const decider = environmentDecider(text, reading);
	// Each environment's decision, by where its line starts, and those the
	// read wraps where main left them
	const decided = new Map<number, Decision>();
	const environments = bareEnvironments(text, (begin, end) => {
		const decision = decider.decide(begin, end);
		decided.set(begin.start, decision);
		return decision === 'leave';
	}, reading.literalHtml);
	const unconfirmed = environments.filter(e => decided.get(e.start) === 'unconfirmed');
	const rejected = unconfirmed.length === 0 ? new Set<number>() : rejectedWraps(text, reading, environments, unconfirmed);
	// Main's decision for those the parse after the wrap doesn't confirm, and
	// for an environment in one of them, which the read didn't decide
	const wrapped = rejected.size === 0 ? environments : bareEnvironments(text, (begin, end) => {
		const decision = rejected.has(begin.start) ? undefined : decided.get(begin.start);
		return decision === undefined ? decider.leftByMain(begin, end) : decision === 'leave';
	}, reading.literalHtml);
	return wrapped.map(({ start, indent, end }) => ({
		start,
		end,
		replacement: wrappedText(text, start, indent, end),
	}));
}

/** The environment of `text` from `start` to `end` in its fences, after its
 *  indent, `indent` long, and with \n\n in it collapsed to \n, so
 *  markdown-it sees it as one paragraph */
function wrappedText(text: string, start: number, indent: number, end: number): string {
	return text.slice(start, start + indent) + '$' + '$' + text.slice(start + indent, end).replace(/\n{2,}/g, '\n') + '$' + '$';
}

/** Whether the wrap leaves an environment as it is, wraps it, or wraps it
 *  where main's step 4 left it, if the parse after the wrap confirms it
 *  (see rejectedWraps) */
type Decision = 'leave' | 'wrap' | 'unconfirmed';

/** Where the lines start of those of `unconfirmed`, which the read wraps
 *  where main's step 4 left them, whose wrap export's parse after it
 *  doesn't confirm. Their paragraph is read with each environment there of
 *  `environments`, sorted, wrapped, and the parse is to read display math
 *  from each one's opening fence to its closing fence, where a scan for a
 *  link's label over it may read its fences otherwise, or a dollar sign
 *  before it pair with its opening fence. Where one in a paragraph is not
 *  confirmed, none is. Each paragraph is read once, with those after it the
 *  last environment in it goes on into, whose blank lines the wrap joins */
function rejectedWraps(text: string, reading: InertReading, environments: BareEnvironment[], unconfirmed: BareEnvironment[]): Set<number> {
	const rejected = new Set<number>();
	const { units } = reading;
	const toConfirm = new Set(unconfirmed);
	let next = 0;
	for (let first = 0; first < unconfirmed.length;) {
		const from = paragraphStart(text, units, unconfirmed[first].start);
		let to = paragraphEnd(text, units, unconfirmed[first].end - 1);
		let last = first + 1;
		while (last < unconfirmed.length && unconfirmed[last].start < to) to = Math.max(to, paragraphEnd(text, units, unconfirmed[last++].end - 1));
		// The paragraph with each environment in it wrapped, and where the
		// fences of those of `unconfirmed` are in it
		const parts: string[] = [];
		const fences: Zone[] = [];
		let length = 0;
		let at = from;
		const add = (part: string) => {
			parts.push(part);
			length += part.length;
		};
		while (next < environments.length && environments[next].start < from) next++;
		// An environment wrapped before the paragraph, into it, over a blank
		// line, which the wrap joins it to, is not in this read of it
		let confirmable = next === 0 || environments[next - 1].end <= from;
		for (; next < environments.length && environments[next].start < to; next++) {
			const { start, indent, end } = environments[next];
			add(text.slice(at, start));
			const opening = length + indent;
			add(wrappedText(text, start, indent, end));
			if (toConfirm.has(environments[next])) fences.push({ start: opening, end: length });
			at = end;
		}
		if (at > to) confirmable = false;
		add(text.slice(at, to));
		const paragraph = parts.join('');
		const read: EquationRead = {
			zones: [], found: undefined, references: reading.read.references, from: 0, top: undefined, uncertain: false, apart: [], critics: [], runState: undefined, runAt: -1, runEnd: -1,
			certainDisplays: [], certainInline: [], alts: [], unread: [],
		};
		// Each text between blank lines on its own, as export's block parse
		// reads them
		const blank = /\n[ \t]*\n/g;
		for (let piece = 0; piece < paragraph.length;) {
			const gap = blank.exec(paragraph);
			const pieceEnd = gap ? gap.index + 1 : paragraph.length;
			const dollar = paragraph.indexOf('$', piece);
			if (dollar !== -1 && dollar < pieceEnd) readEquations(paragraph, piece, pieceEnd, read, []);
			piece = gap ? gap.index + gap[0].length : paragraph.length;
		}
		const displays = new Set(read.certainDisplays.map(d => d.start + ':' + d.end));
		if (!confirmable || fences.some(f => !displays.has(f.start + ':' + f.end))) {
			for (let i = first; i < last; i++) rejected.add(unconfirmed[i].start);
		}
		first = last;
	}
	return rejected;
}

/** Where the text export's inline parse reads `offset` in ends, of
 *  `units`, sorted, or else past `offset`'s line */
function paragraphEnd(text: string, units: Zone[], offset: number): number {
	let lo = 0;
	let hi = units.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (units[mid].start <= offset) lo = mid + 1;
		else hi = mid;
	}
	const unit = units[lo - 1];
	if (unit && offset < unit.end) return unit.end;
	const lineEnd = text.indexOf('\n', offset);
	return lineEnd === -1 ? text.length : lineEnd + 1;
}

/** Whether a zone of `zones`, sorted and merged, holds part of `begin` or
 *  of `end` */
function holdsEither(begin: Zone, end: Zone, zones: Zone[]): boolean {
	return overlapsAnyZone(begin.start, begin.end, zones) || overlapsAnyZone(end.start, end.end, zones);
}

/** Whether the wrap leaves the environment whose \begin{...} is `begin`
 *  and whose \end{...} is `end` as it is, and whether main's step 4, which
 *  paired each fence in the text with the next, leaves it so. As
 *  `reading`'s zones leave it, where main's leave it so too. Where the two
 *  differ, as the zones leave it only where the read is certain, and as
 *  main's do else, so that the wrap leaves an environment otherwise than
 *  main only for a reason export's parse confirms:
 *  - Its paragraph, to its \end{...}, is read for certain: none of it is a
 *    text the read can't read (see readEquations), with no fence in an
 *    image's alt, which the scan for the image's label reads on into the
 *    paragraph, as into an environment wrapped after it, and no
 *    environment's text with a dollar sign or a backtick in it, which the
 *    read takes for display math's (see withEnvironmentsMasked), as it may
 *    not be.
 *  - If the zones leave it, the display math that holds it is the
 *    paragraph's parse's, or a highlight's, not an image's alt's.
 *  - If the zones wrap it, no inline equation the paragraph's parse reads
 *    holds its \begin{...}, as export may read one over it once it is
 *    wrapped too, and the parse of the paragraph after the wrap reads it as
 *    display math (see rejectedWraps).
 *  A fence before its paragraph pairs with none in it, as export reads each
 *  paragraph on its own, so it changes nothing, whatever it is. Main's
 *  pairing of such a fence with one in the paragraph was the bug, and so
 *  each decision of main's is checked against its paragraph's own */
function environmentDecider(text: string, reading: InertReading): { decide: (begin: Zone, end: Zone) => Decision; leftByMain: (begin: Zone, end: Zone) => boolean } {
	const { zones, steps, units, masked, read } = reading;
	const main = mainFenceZones(text);
	const mainZones = mergeZones(steps.concat(main.zones));
	const displays = mergeZones(read.certainDisplays);
	const inline = mergeZones(read.certainInline);
	const uncertain = mergeZones(read.unread.concat(masked));
	// Main's fences in an image's alt, in order
	const alts = mergeZones(read.alts);
	const altFences: number[] = [];
	let alt = 0;
	for (const fence of main.fences) {
		while (alt < alts.length && alts[alt].end <= fence) alt++;
		if (alt < alts.length && alts[alt].start < fence + 2) altFences.push(fence);
	}
	const leftByMain = (begin: Zone, end: Zone) => holdsEither(begin, end, mainZones);
	const decide = (begin: Zone, end: Zone): Decision => {
		const left = holdsEither(begin, end, zones);
		if (left === leftByMain(begin, end)) return left ? 'leave' : 'wrap';
		const from = paragraphStart(text, units, begin.start);
		if (overlapsAnyZone(from, end.end, uncertain) || firstFrom(altFences, from) < end.end) return left ? 'wrap' : 'leave';
		if (left) return holdsEither(begin, end, displays) ? 'leave' : 'wrap';
		return overlapsAnyZone(begin.start, begin.end, inline) ? 'leave' : 'unconfirmed';
	};
	return { decide, leftByMain };
}

/** Step 4 as main had it: each fence of two dollar signs in `text` that no
 *  backslash escapes paired with the next, and the last, without one, to the
 *  text's end, as zones, and those fences, in order */
function mainFenceZones(text: string): { zones: Zone[]; fences: number[] } {
	const zones: Zone[] = [];
	const fences: number[] = [];
	let open = -1;
	for (let at = text.indexOf('$'); at !== -1 && at < text.length - 1;) {
		if (text.charCodeAt(at + 1) !== 0x24 || isEscapedAt(text, at)) {
			at = text.indexOf('$', at + 1);
			continue;
		}
		fences.push(at);
		if (open === -1) open = at;
		else {
			zones.push({ start: open, end: at + 2 });
			open = -1;
		}
		at = text.indexOf('$', at + 2);
	}
	if (open !== -1) zones.push({ start: open, end: text.length });
	return { zones, fences };
}

/** Where the text export's inline parse reads `offset` in starts, of
 *  `units`, sorted, or else `offset`'s line */
function paragraphStart(text: string, units: Zone[], offset: number): number {
	let lo = 0;
	let hi = units.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (units[mid].start <= offset) lo = mid + 1;
		else hi = mid;
	}
	const unit = units[lo - 1];
	return unit && offset < unit.end ? unit.start : text.lastIndexOf('\n', offset - 1) + 1;
}

/** The first of `sorted` at or after `from`, or Infinity */
function firstFrom(sorted: number[], from: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid] < from) lo = mid + 1;
		else hi = mid;
	}
	return lo < sorted.length ? sorted[lo] : Infinity;
}

/** The text of `text` with that of each bare environment out of `zones`,
 *  sorted and merged, which the wrap may wrap, from past its \begin{...} to
 *  its \end{...}, as x, but its line ends, and those texts with a dollar
 *  sign or a backtick in them. Wrapped, it is display math's, so a dollar
 *  sign, a backtick or a bracket in it opens and closes nothing out of it,
 *  where the read of the text before the wrap paired a dollar sign in a
 *  comment in it, as in x = 1 % $, with one after it */
function withEnvironmentsMasked(text: string, zones: Zone[], literalHtml: Zone[]): { source: string; masked: Zone[] } {
	const environments = bareEnvironments(text, (begin, end) => holdsEither(begin, end, zones), literalHtml);
	const masked: Zone[] = [];
	if (environments.length === 0) return { source: text, masked };
	const parts: string[] = [];
	let from = 0;
	for (const { contentStart, contentEnd } of environments) {
		const content = text.slice(contentStart, contentEnd);
		if (/[$`]/.test(content)) masked.push({ start: contentStart, end: contentEnd });
		parts.push(text.slice(from, contentStart), content.replace(/[^\n]/g, 'x'));
		from = contentEnd;
	}
	parts.push(text.slice(from));
	return { source: parts.join(''), masked };
}

interface BareEnvironment {
	/** Where its line starts, its indent, of up to three spaces, before its
	 *  \begin{...}, its text, from past that to its \end{...}, and its end,
	 *  past that */
	start: number;
	indent: number;
	contentStart: number;
	contentEnd: number;
	end: number;
}

/** The bare environments of `text` that `inert` doesn't leave, by their
 *  \begin{...} and their \end{...}, in order, as latexReplacements wraps
 *  them: each \begin{...} at a line's start of a display math environment,
 *  but in an environment before it, to its \end{...}, but one in an HTML
 *  block export writes as text, of `literalHtml` */
function bareEnvironments(text: string, inert: (begin: Zone, end: Zone) => boolean, literalHtml: Zone[]): BareEnvironment[] {
	if (!text.includes('\\begin{')) return [];
	const environments: BareEnvironment[] = [];
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
		let hi = environments.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (environments[mid].start <= region.start) lo = mid + 1;
			else hi = mid - 1;
		}
		const before = environments[hi];
		return !(before && region.start < before.end);
	};

	// Find bare \begin{env} at start of line (up to 3 spaces indent)
	const beginRe = /^([ ]{0,3})\\begin\{([a-zA-Z*]+)\}/gm;
	let match: RegExpExecArray | null;
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
		// Skip if this match falls inside an already-collected environment
		// (handles nested environments — only the outermost is wrapped)
		if (environments.length > 0 && blockStart < environments[environments.length - 1].end) continue;
		if (inLiteralHtml(blockStart)) continue;

		// Find matching \end{envName}
		const endMarker = '\\end{' + envName + '}';
		const endIdx = endOf(endMarker, blockStart + match[0].length);
		if (endIdx === -1) continue;
		const blockEnd = endIdx + endMarker.length;

		if (inert({ start: blockStart, end: blockStart + match[0].length }, { start: endIdx, end: blockEnd })) continue;

		environments.push({ start: blockStart, indent: match[1].length, contentStart: blockStart + match[0].length, contentEnd: endIdx, end: blockEnd });
	}

	return environments;
}
