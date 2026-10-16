/**
 * Bare LaTeX environment preprocessing.
 *
 * Wraps bare `\begin{env}...\end{env}` blocks in `$$...$$` so the existing
 * mathRule inline rule handles them. Runs before CriticMarkup preprocessing
 * so it sees markers in their original form.
 *
 * Only recognized display-math environments are wrapped. Code regions, HTML
 * comments, CriticMarkup spans, and existing `$$` blocks are treated as
 * "inert zones" and skipped. In a simple paragraph, its own parse decides
 * instead, where it confirms the decision (see decideParagraphs).
 */

import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { computeLineStarts, computeMarkdownRegions, isInsideCodeRegion } from './code-regions';
import { exportsLiterally } from './html-blocks';
import { criticCloserSearch, preprocessCriticMarkupWithLines } from './critic-markup';
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
 * be recognized: code regions, HTML comments, CriticMarkup, existing $$ blocks.
 * Not the HTML blocks export writes as text, which latexReplacements reads
 * past the environments it finds.
 */
export function computeInertZones(text: string): Zone[] {
	return inertZonesAndLiteralHtml(text).zones;
}

/** The inert zones of `text`, and the HTML blocks export writes as text,
 *  and for decideParagraphs, the zones of steps 1 to 3 alone, sorted and
 *  merged, and the lines of each paragraph and heading (see inlineBlocks in
 *  code-regions.ts) */
function inertZonesAndLiteralHtml(text: string): { zones: Zone[]; literalHtml: Zone[]; steps: Zone[]; inlineBlocks: Zone[] } {
	const zones: Zone[] = [];

	// 1. Code regions (fenced blocks + inline code spans), as export reads
	// them, with HTML blocks, a fence's line in which opens no code block,
	// and past whose edges no code span runs. And apart, the HTML blocks
	// export writes as text, as a <pre> or a <div>, but not one it reads
	// tables from, in which it reads an environment as display math (see
	// markWrappedLatexBlocks in md-to-docx.ts)
	const { codeRegions, blockCodeRegions, literalHtmlRegions, inlineBlocks } = computeMarkdownRegions(text, { html: 'all', literalHtml: exportsLiterally, inlineBlocks: true });
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
	const steps = mergeZones(zones);

	// 4. Existing $$ ... $$ blocks
	// Not at a dollar sign a backslash escapes, which opens or closes no
	// math, as the math rule reads it (see findDollarMathClose in
	// math-delimiters.ts). Each fence pairs with the next across the text,
	// so one that opens no equation pairs with the opening fence of display
	// math after it, which decideParagraphs reads again in a simple paragraph
	{
		const delimiterAt = (at: number) => text[at] === '$' && text[at + 1] === '$' && !isEscapedAt(text, at);
		let pos = 0;
		while (pos < text.length - 1) {
			if (delimiterAt(pos)) {
				const start = pos;
				pos += 2;
				// Find closing $$
				while (pos < text.length - 1) {
					if (delimiterAt(pos)) {
						pos += 2;
						break;
					}
					pos++;
				}
				zones.push({ start, end: pos });
			} else {
				pos++;
			}
		}
	}

	return { zones: mergeZones(zones), literalHtml: literalHtmlRegions, steps, inlineBlocks };
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

/** Whether a zone of `zones`, sorted and merged, holds part of `begin` or
 *  of `end` */
function holdsEither(begin: Zone, end: Zone, zones: Zone[]): boolean {
	return overlapsAnyZone(begin.start, begin.end, zones) || overlapsAnyZone(end.start, end.end, zones);
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
	const { zones, literalHtml, steps, inlineBlocks } = inertZonesAndLiteralHtml(text);
	const byMain = bareEnvironments(text, (begin, end) => holdsEither(begin, end, zones), literalHtml);
	return decideParagraphs(text, byMain, steps, inlineBlocks, literalHtml).map(({ start, indent, end }) => ({
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

/**
 * The environments to wrap: `byMain`, those the inert zones leave, but in a
 * paragraph whose own parse decides otherwise and confirms it.
 *
 * Step 4 of inertZonesAndLiteralHtml pairs each fence of two dollar signs
 * with the next, across the text. So a fence that opens no equation, as one
 * in code, a comment, a URL or inline math, or one export reads as text,
 * paired with the opening fence of display math after it, and the
 * environment in that math, out of each zone, was wrapped again. Word got an
 * empty equation, the environment as text, and another empty one. Export
 * reads each paragraph or heading on its own, so a fence before it pairs
 * with none in it, whatever the fence is.
 *
 * So each paragraph or heading, as export's block parse reads it (see
 * exportUnits), with each environment out of the zones of steps 1 to 3 that
 * it holds, and none over its edges, is read on its own, with each such
 * environment's text read as nothing, as it is display math's once wrapped.
 * The read leaves an environment in display math as it is and wraps one in
 * none. Where that differs from main's decisions, it holds only where the
 * paragraph, with those wraps, is simple to the end of its last
 * environment, holds no CriticMarkup, and reads each wrapped environment as
 * display math from its opening fence to its closing one and each other
 * equation as before (see readParagraphOnItsOwn). Simple means its text,
 * out of code spans, comments and equations, holds no [ or ], no < that
 * opens no comment, no URL's ://, no highlight's == and no { that opens a
 * comment's range: no link, image, citation, note's reference, tag,
 * autolink, URL or highlight. Export's rules read those before its math
 * rule can, and the read has none of them (see reader). Elsewhere main's
 * decisions hold.
 */
function decideParagraphs(text: string, byMain: BareEnvironment[], steps: Zone[], inlineBlocks: Zone[], literalHtml: Zone[]): BareEnvironment[] {
	const environments = bareEnvironments(text, (begin, end) => holdsEither(begin, end, steps), literalHtml);
	if (environments.length === 0) return byMain;
	const decided: BareEnvironment[] = [];
	let next = 0;
	let main = 0;
	// The end of the last environment before the paragraph, which may go on
	// into it
	let reach = 0;
	for (const unit of exportUnits(text, inlineBlocks)) {
		const first = next;
		while (next < environments.length && environments[next].start < unit.end) next++;
		if (first === next) continue;
		const before = reach;
		for (let i = first; i < next; i++) reach = Math.max(reach, environments[i].end);
		// Main's environments in it, which wrap none over its edges either
		while (main < byMain.length && byMain[main].end <= unit.start) decided.push(byMain[main++]);
		const firstOfMain = main;
		while (main < byMain.length && byMain[main].start < unit.end) main++;
		const ofMain = byMain.slice(firstOfMain, main);
		const contained = before <= unit.start && environments[first].start >= unit.start && reach <= unit.end
			&& (firstOfMain === 0 || byMain[firstOfMain - 1].end <= unit.start)
			&& (ofMain.length === 0 || ofMain[0].start >= unit.start && ofMain[ofMain.length - 1].end <= unit.end);
		for (const environment of contained ? readParagraphOnItsOwn(text, unit, environments.slice(first, next), ofMain) : ofMain) decided.push(environment);
	}
	while (main < byMain.length) decided.push(byMain[main++]);
	return decided;
}

/** The environments of `unit` to wrap, where `environments` are all of
 *  those in it out of the zones of steps 1 to 3: those the paragraph's own
 *  parse reads in no display math, where the parse with them wrapped
 *  confirms it, or else `byMain`, main's (see decideParagraphs) */
function readParagraphOnItsOwn(text: string, unit: Zone, environments: BareEnvironment[], byMain: BareEnvironment[]): BareEnvironment[] {
	const at = (offset: number) => offset - unit.start;
	const source = text.slice(unit.start, unit.end);
	// Each environment's text as x, but its line ends, so a dollar sign or a
	// backtick in it opens and closes nothing out of it, as once wrapped
	const masked: string[] = [];
	let from = 0;
	for (const { contentStart, contentEnd } of environments) {
		masked.push(source.slice(from, at(contentStart)), source.slice(at(contentStart), at(contentEnd)).replace(/[^\n]/g, 'x'));
		from = at(contentEnd);
	}
	masked.push(source.slice(from));
	const before = readParagraph(masked.join(''));
	const displays = before.equations.filter(e => e.display);
	const wrapped = environments.filter(e => !holdsEither({ start: at(e.start), end: at(e.contentStart) }, { start: at(e.contentEnd), end: at(e.end) }, displays));
	if (wrapped.length === byMain.length && wrapped.every((e, i) => e.start === byMain[i].start)) return byMain;
	// preprocessCriticMarkup may put its line ends in placeholders, which the
	// read doesn't, or join it to the paragraph before or after it
	if (CRITIC_MARKUP.test(source)) return byMain;

	// The paragraph with those wrapped, as each is wrapped in the output, the
	// offsets before which a fence goes, and each wrap's display math
	const parts: string[] = [];
	const fences: number[] = [];
	const wraps: Equation[] = [];
	let length = 0;
	from = 0;
	for (const { start, indent, end } of wrapped) {
		const slice = source.slice(from, at(start));
		const wrap = wrappedText(text, start, indent, end);
		parts.push(slice, wrap);
		wraps.push({ start: length + slice.length + indent, end: length + slice.length + wrap.length, display: true });
		length += slice.length + wrap.length;
		fences.push(at(start + indent), at(end));
		from = at(end);
	}
	parts.push(source.slice(from));
	// How far an offset of `source` moves: two for each fence before it, or
	// at it where `atToo`
	const moved = (offset: number, atToo: boolean) => {
		let lo = 0;
		let hi = fences.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (fences[mid] < offset || atToo && fences[mid] === offset) lo = mid + 1;
			else hi = mid;
		}
		return offset + 2 * lo;
	};
	const after = readParagraph(parts.join(''));
	const last = at(environments[environments.length - 1].end);
	if (after.unsimple.length > 0 && after.unsimple[0] < moved(last, true)) return byMain;
	const expected = before.equations.map(e => ({ start: moved(e.start, true), end: moved(e.end, false), display: e.display }))
		.concat(wraps).sort((a, b) => a.start - b.start);
	const same = expected.length === after.equations.length && expected.every((e, i) => {
		const read = after.equations[i];
		return e.start === read.start && e.end === read.end && e.display === read.display;
	});
	return same ? wrapped : byMain;
}

/** A CriticMarkup span's opener or closer, or a comment's text's opener */
const CRITIC_MARKUP = /\{(?:\+\+|--|~~|>>|==)|(?:\+\+|--|~~|<<|==)\}|\{#[a-zA-Z0-9_-]+>>/;

/** The lines of each paragraph and heading of `text`, sorted, as export's
 *  block parse reads them, after preprocessCriticMarkup puts the line ends
 *  of each CriticMarkup span in placeholders. A span over a blank line
 *  joins a paragraph to the next, and one in a heading takes the lines it
 *  goes over into the heading, from the paragraph after it. Those are
 *  `inlineBlocks`, which the block parse of `text` read, where no span has a
 *  line end in it */
function exportUnits(text: string, inlineBlocks: Zone[]): Zone[] {
	// Its line ends are \n alone, as preprocessCriticMarkup reads them
	if (text.includes('\r')) return inlineBlocks;
	const { output, lines } = preprocessCriticMarkupWithLines(text);
	if (output === text) return inlineBlocks;
	const regions = computeMarkdownRegions(output, { html: 'all', inlineBlocks: true });
	// Where each line of the output starts, by its line, and where the line
	// of `text` it comes from starts
	const outputLines = new Map(computeLineStarts(output).map((start, line) => [start, line]));
	const textStarts = computeLineStarts(text);
	const inText = (offset: number) => {
		const line = outputLines.get(offset);
		return offset >= output.length || line === undefined ? text.length : textStarts[lines[line]] ?? text.length;
	};
	const units: Zone[] = [];
	for (const { start, end } of regions.inlineBlocks) {
		const unit = { start: inText(start), end: inText(end) };
		// An opener preprocessCriticMarkup moved from the end of the line
		// before, or the line before a blank line, which its line maps past
		// (see moveLeadingBreakOutsideCritic in critic-markup.ts). The unit
		// starts at the opener, and the unit before it ends there
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
	return units;
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

/** An equation the read of a paragraph reads, from its opening fence to
 *  past its closing one, and whether it is display math */
interface Equation extends Zone { display: boolean }

/** What a read of a paragraph records, in its state's env: its equations,
 *  in order, where a rule of export's the read doesn't have may start, in
 *  order (see unsimpleRule), and the run of dollar signs read last */
interface ParagraphRead {
	equations: Equation[];
	unsimple: number[];
	runAt: number;
	runEnd: number;
}

/** markdown-it with the inline rules of export's (see createMarkdownIt in
 *  md-to-docx.ts) that read past a dollar sign in a simple paragraph: an
 *  escape, a code span and a comment. And export's math rule. Export's other
 *  rules read emphasis, entities and line ends, past no dollar sign, or
 *  start where unsimpleRule records it */
const reader = new MarkdownIt('zero', { html: true });
reader.inline.ruler.enable(['escape', 'backticks', 'html_inline']);
reader.use(linearInlineComments);
reader.inline.ruler.before('text', 'unsimple', unsimpleRule);
reader.inline.ruler.push('math', readMath);

/** The read of `src`, a paragraph's text, as export's inline parse reads it
 *  where it is simple */
function readParagraph(src: string): ParagraphRead {
	const read: ParagraphRead = { equations: [], unsimple: [], runAt: -1, runEnd: -1 };
	reader.inline.tokenize(new reader.inline.State(src, reader, read, []));
	return read;
}

/** Records where a rule of export's that the read doesn't have may start,
 *  before any rule reads the text there: a [ or a ], which may open or
 *  close a link, an image, a citation or a note's reference, a < that opens
 *  no comment, which may open a tag or an autolink, the :// of a URL
 *  linkify reads, a highlight's ==, a { that opens CriticMarkup or a
 *  comment's range, or a CriticMarkup span's closer. Reads nothing */
function unsimpleRule(state: StateInline): boolean {
	const { src, pos } = state;
	const code = src.charCodeAt(pos);
	const next = src.charCodeAt(pos + 1);
	if (code === 0x5B || code === 0x5D
		|| code === 0x3C && !src.startsWith('<!--', pos)
		|| code === 0x3A && src.startsWith('//', pos + 1)
		|| code === 0x3D && next === 0x3D
		|| code === 0x7B && (next === 0x23 || next === 0x2F || (next === 0x2B || next === 0x2D || next === 0x7E || next === 0x3E) && src.charCodeAt(pos + 2) === next)
		|| (code === 0x2B || code === 0x2D || code === 0x7E) && next === code && src.charCodeAt(pos + 2) === 0x7D) {
		(state.env as ParagraphRead).unsimple.push(pos);
	}
	return false;
}

/** export's math rule (see mathRule in md-to-docx.ts), which records each
 *  equation it reads */
function readMath(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const at = state.pos;
	if (src.charCodeAt(at) !== 0x24) return false;
	const read = state.env as ParagraphRead;
	// The run of dollar signs from here, counted once for each run
	if (!(read.runAt <= at && at < read.runEnd)) {
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
		if (!silent) for (let start = at; start < end; start += 4) read.equations.push({ start, end: start + 4, display: true });
		state.pos = end;
		return true;
	}
	const match = findDollarMathAt(src, at, DOCX_DOLLAR_MATH_OPTIONS);
	if (match?.kind !== 'math') return false;
	if (!silent) read.equations.push({ start: match.start, end: match.end, display: match.delimiterLength === 2 });
	state.pos = match.end;
	return true;
}

/** For the test that checks the read against export's parse: each paragraph
 *  and heading of `text`, as export's block parse reads it (see
 *  exportUnits), whether it is simple, with no CriticMarkup in it and no
 *  place unsimpleRule records, and the equations the read reads in it, at
 *  their offsets in `text` */
export function paragraphEquations(text: string): Array<Zone & { simple: boolean; equations: Equation[] }> {
	const { inlineBlocks } = computeMarkdownRegions(text, { html: 'all', inlineBlocks: true });
	return exportUnits(text, inlineBlocks).map(unit => {
		const source = text.slice(unit.start, unit.end);
		const read = readParagraph(source);
		return {
			...unit,
			simple: read.unsimple.length === 0 && !CRITIC_MARKUP.test(source),
			equations: read.equations.map(e => ({ start: unit.start + e.start, end: unit.start + e.end, display: e.display })),
		};
	});
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
