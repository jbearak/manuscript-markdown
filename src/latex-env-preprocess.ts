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
 * instead, where it confirms the decision (see decideParagraphs). One in a
 * quote's or a list item's paragraph, past its prefix, is wrapped inside it
 * where that paragraph's own parse is sure of it (see decideContainers).
 */

import MarkdownIt from 'markdown-it';
import { HTML_OPEN_CLOSE_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { computeLineStarts, computeMarkdownRegions, isInsideCodeRegion, type ContainedParagraph } from './code-regions';
import { exportsLiterally } from './html-blocks';
import { criticCloserSearch, preprocessCriticMarkupWithLines } from './critic-markup';
import { linearInlineComments } from './inline-html-comments';
import { DOCX_DOLLAR_MATH_OPTIONS, findDollarMathAt, isEscapedAt } from './math-delimiters';
import { previewEquations, type PreviewEquation } from './preview-math-read';
import { equationShowsText } from './latex-to-omml';

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
 *  merged, those of step 4, in order, and the lines of each paragraph and
 *  heading (see inlineBlocks in code-regions.ts) */
function inertZonesAndLiteralHtml(text: string): { zones: Zone[]; literalHtml: Zone[]; steps: Zone[]; fences: FenceZone[]; inlineBlocks: Zone[]; contained: ContainedParagraph[] } {
	const zones: Zone[] = [];

	// 1. Code regions (fenced blocks + inline code spans), as export reads
	// them, with HTML blocks, a fence's line in which opens no code block,
	// and past whose edges no code span runs. And apart, the HTML blocks
	// export writes as text, as a <pre> or a <div>, but not one it reads
	// tables from, in which it reads an environment as display math (see
	// markWrappedLatexBlocks in md-to-docx.ts)
	const { codeRegions, blockCodeRegions, literalHtmlRegions, inlineBlocks, containedParagraphs } = computeMarkdownRegions(text, { html: 'all', literalHtml: exportsLiterally, inlineBlocks: true, containedParagraphs: true });
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
	const fences: FenceZone[] = [];
	{
		const delimiterAt = (at: number) => text[at] === '$' && text[at + 1] === '$' && !isEscapedAt(text, at);
		let pos = 0;
		while (pos < text.length - 1) {
			if (delimiterAt(pos)) {
				const start = pos;
				pos += 2;
				let closed = false;
				// Find closing $$
				while (pos < text.length - 1) {
					if (delimiterAt(pos)) {
						pos += 2;
						closed = true;
						break;
					}
					pos++;
				}
				zones.push({ start, end: pos });
				fences.push({ start, end: pos, closed });
			} else {
				pos++;
			}
		}
	}

	return { zones: mergeZones(zones), literalHtml: literalHtmlRegions, steps, fences, inlineBlocks, contained: containedParagraphs };
}

/** A zone of step 4, from a fence to past the next, which closes it, or,
 *  where none is, to the text's end */
interface FenceZone extends Zone { closed: boolean }

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
export function wrapBareLatexEnvironments(text: string, mark = '', options: ContainerOptions = {}): string {
	return withReplacements(text, latexReplacements(text, options), mark);
}

/** The lines, from `first` to `last`, of a paragraph in a quote or a list
 *  item that export's ending of quotes before a line without a > splits,
 *  or that has a lazy line (see endedParagraphs in block-preprocess.ts) */
export interface LineSpan {
	first: number;
	last: number;
}

/** How export reads the text's quotes and list items: `lazy`, the lines of
 *  its paragraphs export's ending of quotes splits, whose environments
 *  export and VS Code's preview leave as written, and `inNote`, where the
 *  text is a note's body, which export reads on its own, and the preview in
 *  the document, on the note's indented lines, where it leaves an
 *  environment in a quote or an item as written. Export does too */
export interface ContainerOptions {
	lazy?: LineSpan[];
	inNote?: boolean;
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
export function wrapBareLatexEnvironmentsWithLines(text: string, options: ContainerOptions = {}): { output: string; lines: number[] } {
	const lineStarts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
	const replacements = latexReplacements(text, options);
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

/** The bare environments of `text`, each with its block wrapped, in order,
 *  as export reads its quotes and items (see ContainerOptions) */
function latexReplacements(text: string, options: ContainerOptions): Replacement[] {
	// Fast path: no \begin{ means nothing to do
	if (!text.includes('\\begin{')) return [];
	const { zones, literalHtml, steps, fences, inlineBlocks, contained: read } = inertZonesAndLiteralHtml(text);
	const byMain = bareEnvironments(text, (begin, end) => holdsEither(begin, end, zones), literalHtml);
	const environments = bareEnvironments(text, (begin, end) => holdsEither(begin, end, steps), literalHtml);
	// A note's body's quotes and items as main reads them (see ContainerOptions)
	const contained = options.inNote ? [] : read;
	const units = environments.length > 0 || contained.length > 0 ? exportUnits(text, inlineBlocks) : [];
	const sure = fenceIsSure(text, steps, units, environments);
	const decided = confirmInPreview(text, decideParagraphs(text, byMain, environments, units, { fences, steps, sure }));
	const inContainers = decideContainers(text, contained, units, [environments, byMain], { fences, steps }, options.lazy ?? []);
	if (inContainers.length === 0) return toReplacements(text, decided);
	// The top level's, as decided, which hold, and each container
	// paragraph's, which takes main's decision, to wrap none, where the
	// preview reads it otherwise with them all
	const pieces: Decision[] = decided.map(e => ({ environments: [e] }));
	const inOrder = pieces.concat(inContainers).sort((a, b) => (a.override?.unit.start ?? a.environments[0].start) - (b.override?.unit.start ?? b.environments[0].start));
	return toReplacements(text, confirmInPreview(text, inOrder));
}

function toReplacements(text: string, environments: BareEnvironment[]): Replacement[] {
	return environments.map(({ start, indent, end }) => ({ start, end, replacement: wrappedText(text, start, indent, end) }));
}

/** The environment of `text` from `start` to `end` in its fences, after its
 *  indent, `indent` long, and with \n\n in it collapsed to \n, so
 *  markdown-it sees it as one paragraph */
function wrappedText(text: string, start: number, indent: number, end: number): string {
	return text.slice(start, start + indent) + '$' + '$' + text.slice(start + indent, end).replace(/\n{2,}/g, '\n') + '$' + '$';
}

/** The environments to wrap in a stretch of the text, and where they are
 *  a paragraph's own decision otherwise than main's, the paragraph, main's
 *  decision there, and the display math the paragraph's read with the
 *  wraps reads, at its offsets in the paragraph as wrapped */
interface Decision {
	environments: BareEnvironment[];
	override?: { unit: Zone; byMain: BareEnvironment[]; displays: Equation[] };
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
 * rule can, and the read has none of them (see reader).
 *
 * VS Code's preview reads display math from a fence at a line's start over
 * blank lines, to the next line with a fence, where export's ends at the
 * paragraph's end. So an environment main left in a zone of two fences is
 * wrapped only where one of them is sure to be no display math's: one in
 * the zones of steps 1 to 3 or in inline math (see mainZoneIsWrong). And
 * each paragraph's decision is to be the preview's reading too (see
 * confirmInPreview). Elsewhere main's decisions hold.
 */
function decideParagraphs(text: string, byMain: BareEnvironment[], environments: BareEnvironment[], units: Zone[], zonesOf: { fences: FenceZone[]; steps: Zone[]; sure: FenceIsSure }): Decision[] {
	if (environments.length === 0) return [{ environments: byMain }];
	const decisions: Decision[] = [];
	let next = 0;
	let main = 0;
	// The end of the last environment before the paragraph, which may go on
	// into it
	let reach = 0;
	for (const unit of units) {
		const first = next;
		while (next < environments.length && environments[next].start < unit.end) next++;
		if (first === next) continue;
		const before = reach;
		for (let i = first; i < next; i++) reach = Math.max(reach, environments[i].end);
		// Main's environments in it, which wrap none over its edges either
		const firstBefore = main;
		while (main < byMain.length && byMain[main].end <= unit.start) main++;
		if (main > firstBefore) decisions.push({ environments: byMain.slice(firstBefore, main) });
		const firstOfMain = main;
		while (main < byMain.length && byMain[main].start < unit.end) main++;
		const ofMain = byMain.slice(firstOfMain, main);
		const contained = before <= unit.start && environments[first].start >= unit.start && reach <= unit.end
			&& (firstOfMain === 0 || byMain[firstOfMain - 1].end <= unit.start)
			&& (ofMain.length === 0 || ofMain[0].start >= unit.start && ofMain[ofMain.length - 1].end <= unit.end);
		decisions.push(contained ? readParagraphOnItsOwn(text, unit, environments.slice(first, next), ofMain, zonesOf) : { environments: ofMain });
	}
	if (main < byMain.length) decisions.push({ environments: byMain.slice(main) });
	return decisions;
}

/** The environments of `unit` to wrap, where `environments` are all of
 *  those in it out of the zones of steps 1 to 3: those the paragraph's own
 *  parse reads in no display math, where the parse with them wrapped
 *  confirms it, and main's zone over each it wraps, of `fences`, is wrong,
 *  or else `byMain`, main's (see decideParagraphs) */
function readParagraphOnItsOwn(text: string, unit: Zone, environments: BareEnvironment[], byMain: BareEnvironment[], zonesOf: { fences: FenceZone[]; steps: Zone[]; sure: FenceIsSure }): Decision {
	const asMain = { environments: byMain };
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
	// Main's decision holds where the paragraph is not simple to its last
	// environment's end, so the read stops there
	const last = at(environments[environments.length - 1].end);
	const before = readParagraph(masked.join(''), last);
	if (before.unsimple !== -1) return asMain;
	const displays = before.equations.filter(e => e.display);
	const wrapped = environments.filter(e => !holdsEither({ start: at(e.start), end: at(e.contentStart) }, { start: at(e.contentEnd), end: at(e.end) }, displays));
	if (wrapped.length === byMain.length && wrapped.every((e, i) => e.start === byMain[i].start)) return asMain;
	// preprocessCriticMarkup may put its line ends in placeholders, which the
	// read doesn't, or join it to the paragraph before or after it
	if (CRITIC_MARKUP.test(source)) return asMain;
	// Main's zone over each it wraps, which main left, is to be wrong
	const ofMain = new Set(byMain.map(e => e.start));
	// A fence of the paragraph is sure where this read reads it in inline
	// math, and one of another paragraph where that paragraph's read does
	const inlineMath = before.equations.filter(e => !e.display);
	const sure = (offset: number) => unit.start <= offset && offset < unit.end
		? overlapsAnyZone(offset, offset + 2, zonesOf.steps) || inEquation(inlineMath, at(offset))
		: zonesOf.sure(offset);
	for (const environment of wrapped) {
		if (!ofMain.has(environment.start) && !mainZoneIsWrong(environment, zonesOf.fences, sure)) return asMain;
	}

	// The paragraph with those wrapped, as each is wrapped in the output, the
	// offsets before which a fence goes, and each wrap's display math
	const parts: string[] = [];
	const fencesAt: number[] = [];
	const wraps: Equation[] = [];
	let length = 0;
	from = 0;
	for (const { start, indent, end } of wrapped) {
		const slice = source.slice(from, at(start));
		const wrap = wrappedText(text, start, indent, end);
		parts.push(slice, wrap);
		wraps.push({ start: length + slice.length + indent, end: length + slice.length + wrap.length, display: true });
		length += slice.length + wrap.length;
		fencesAt.push(at(start + indent), at(end));
		from = at(end);
	}
	parts.push(source.slice(from));
	// How far an offset of `source` moves: two for each fence before it, or
	// at it where `atToo`
	const moved = (offset: number, atToo: boolean) => {
		let lo = 0;
		let hi = fencesAt.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (fencesAt[mid] < offset || atToo && fencesAt[mid] === offset) lo = mid + 1;
			else hi = mid;
		}
		return offset + 2 * lo;
	};
	const after = readParagraph(parts.join(''), moved(last, true));
	if (after.unsimple !== -1) return asMain;
	const expected = before.equations.map(e => ({ start: moved(e.start, true), end: moved(e.end, false), display: e.display }))
		.concat(wraps).sort((a, b) => a.start - b.start);
	const same = expected.length === after.equations.length && expected.every((e, i) => {
		const read = after.equations[i];
		return e.start === read.start && e.end === read.end && e.display === read.display;
	});
	return same ? { environments: wrapped, override: { unit, byMain, displays: after.equations.filter(e => e.display) } } : asMain;
}

/** Whether a fence, at an offset, is sure to open or close no display math */
type FenceIsSure = (offset: number) => boolean;

/**
 * Whether main's zones over `environment`'s \begin{...} or its \end{...},
 * of `fences`, those of step 4, which left it, are wrong: each to the text's
 * end, from a fence that pairs with none, or with a fence `sure` is sure of.
 * Export reads two fences of other paragraphs, or of this one and another,
 * as no display math, but VS Code's preview reads display math from one at
 * a line's start over blank lines, to the next line with a fence, as main
 * paired them. So two fences of text, with a blank line between them, keep
 * main's decision
 */
function mainZoneIsWrong(environment: BareEnvironment, fences: FenceZone[], sure: FenceIsSure): boolean {
	let lo = 0;
	let hi = fences.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (fences[mid].end <= environment.start) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < fences.length && fences[i].start < environment.end; i++) {
		const zone = fences[i];
		const overBegin = zone.start < environment.contentStart && zone.end > environment.start;
		const overEnd = zone.start < environment.end && zone.end > environment.contentEnd;
		if (!overBegin && !overEnd) continue;
		if (zone.closed && !sure(zone.start) && !sure(zone.end - 2)) return false;
	}
	return true;
}

/** Whether a fence is sure to open or close no display math: in a zone of
 *  steps 1 to 3, code, a comment or CriticMarkup, or in inline math, as the
 *  read of its paragraph reads it, where that paragraph is simple, holds no
 *  CriticMarkup and none of `environments`, whose text the read would read
 *  as nothing. Each paragraph is read once, for all of its fences */
function fenceIsSure(text: string, steps: Zone[], units: Zone[], environments: BareEnvironment[]): FenceIsSure {
	// Each paragraph's inline equations, or null where it is not read
	const reads = new Map<number, Equation[] | null>();
	return offset => {
		if (overlapsAnyZone(offset, offset + 2, steps)) return true;
		let lo = 0;
		let hi = units.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (units[mid].end <= offset) lo = mid + 1;
			else hi = mid;
		}
		const unit = units[lo];
		if (!unit || unit.start > offset) return false;
		let equations = reads.get(lo);
		if (equations === undefined) {
			const source = text.slice(unit.start, unit.end);
			const read = overlapsAnyZone(unit.start, unit.end, environments) || CRITIC_MARKUP.test(source) ? null : readParagraph(source, source.length);
			equations = read && read.unsimple === -1 ? read.equations.filter(e => !e.display) : null;
			reads.set(lo, equations);
		}
		return equations !== null && inEquation(equations, offset - unit.start);
	};
}

/** Whether the fence at `at` is in one of `equations`, which are in order
 *  and apart: the first that ends at or after its end, found by binary
 *  search, as each fence asks, starts at or before it */
function inEquation(equations: Equation[], at: number): boolean {
	let lo = 0;
	let hi = equations.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (equations[mid].end < at + 2) lo = mid + 1;
		else hi = mid;
	}
	return lo < equations.length && equations[lo].start <= at;
}

/**
 * The environments of `decisions` to wrap, where VS Code's preview reads
 * each paragraph whose own decision differs from main's as that decision
 * says, in the text with every wrap: each display equation the paragraph's
 * read with the wraps reads, as one display equation over the same lines,
 * and no other display equation in it, nor an equation over its first line
 * or its last from out of it (see previewEquations). One the preview reads
 * otherwise, as a fence at a line's start before a blank line, whose
 * display math the preview reads to a wrap's opening fence, takes main's
 * decision, and the rest are read once more without it, as its wraps or
 * main's may change how the preview reads the others. Where one is read
 * otherwise then too, each takes main's decision. So does one that leaves
 * wraps of main's the preview reads as main decided (see
 * mainsWrapsInPreview).
 */
function confirmInPreview(text: string, decisions: Decision[]): BareEnvironment[] {
	const overrides = decisions.filter(d => d.override);
	if (overrides.length === 0) return decisions.flatMap(d => d.environments);
	const rejected = new Set<Decision>(mainsWrapsInPreview(text, decisions));
	const chosen = (d: Decision) => (d.override && rejected.has(d) ? d.override.byMain : d.environments);
	for (let round = 0; round < 2 && overrides.some(d => !rejected.has(d)); round++) {
		// The text with the wraps, and where each paragraph to check starts
		// in it
		const environments: BareEnvironment[] = [];
		const starts = new Map<Decision, number>();
		let shift = 0;
		for (const d of decisions) {
			if (d.override && !rejected.has(d)) starts.set(d, d.override.unit.start + shift);
			for (const e of chosen(d)) {
				environments.push(e);
				shift += wrappedText(text, e.start, e.indent, e.end).length - (e.end - e.start);
			}
		}
		const output = withReplacements(text, toReplacements(text, environments));
		const lineAt = lineFinder(output);
		const checks = [...starts].map(([d, start]) => {
			const { unit } = d.override!;
			const end = start + (unit.end - unit.start) + shiftIn(text, d);
			return { d, start, first: lineAt(start), last: lineAt(Math.max(start, end - 1)) };
		});
		const preview = previewRead(output, checks);
		const failing = checks.filter(check => !readsAsDecided(check, preview, lineAt));
		if (failing.length === 0) break;
		if (round === 1) return decisions.flatMap(d => (d.override ? d.override.byMain : d.environments));
		for (const { d } of failing) rejected.add(d);
	}
	return decisions.flatMap(chosen);
}

/**
 * The decisions that leave wraps of main's in their paragraph, each of
 * which VS Code's preview reads, in the text with main's wraps, as one
 * display equation from its opening fence's line to its closing fence's,
 * where no equation goes over the paragraph's edges. A fence at a line's
 * start ends a paragraph for the preview, and so a wrap's opening fence
 * ends display math from a fence in a line before it, which export reads
 * on past the environment, as the paragraph's read does. The preview reads
 * main's decision there as main decided it.
 */
function mainsWrapsInPreview(text: string, decisions: Decision[]): Decision[] {
	// The text with main's wraps, where each of those paragraphs starts and
	// ends in it, and each wrap it leaves
	const environments: BareEnvironment[] = [];
	const units: Array<{ d: Decision; start: number; end: number; wraps: Zone[] }> = [];
	let shift = 0;
	for (const d of decisions) {
		const start = d.override ? d.override.unit.start + shift : 0;
		const wrapped = new Set(d.environments.map(e => e.start));
		const wraps: Zone[] = [];
		for (const e of d.override ? d.override.byMain : d.environments) {
			environments.push(e);
			const length = wrappedText(text, e.start, e.indent, e.end).length;
			if (d.override && !wrapped.has(e.start)) wraps.push({ start: e.start + shift + e.indent, end: e.start + shift + length });
			shift += length - (e.end - e.start);
		}
		if (wraps.length > 0) units.push({ d, start, end: d.override!.unit.end + shift, wraps });
	}
	if (units.length === 0) return [];
	const output = withReplacements(text, toReplacements(text, environments));
	const lineAt = lineFinder(output);
	const spans = units.map(({ start, end }) => ({ first: lineAt(start), last: lineAt(Math.max(start, end - 1)) }));
	const { read, reach } = previewRead(output, spans);
	return units.filter(({ wraps }, u) => {
		const { first, last } = spans[u];
		const lo = firstFrom(read, first);
		if (lo > 0 && reach[lo - 1] >= first) return false;
		const starts = new Map<number, number>();
		for (let i = lo; i < read.length && read[i].startLine <= last; i++) {
			if (read[i].endLine > last) return false;
			if (read[i].display) starts.set(read[i].startLine, read[i].endLine);
		}
		return wraps.every(wrap => starts.get(lineAt(wrap.start)) === lineAt(wrap.end - 1));
	}).map(({ d }) => d);
}

/** The line of an offset of `text`, by the lines' starts */
function lineFinder(text: string): (offset: number) => number {
	const lineStarts = computeLineStarts(text);
	return offset => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
}

/** The equations VS Code's preview reads in `output`, those of its inline
 *  rules in the paragraphs that start on a line of `spans`, from its first
 *  line to its last, sorted by their first lines, and the last line of any
 *  that starts at or before each */
function previewRead(output: string, spans: Array<{ first: number; last: number }>): { read: PreviewEquation[]; reach: number[] } {
	const sorted = spans.slice().sort((a, b) => a.first - b.first);
	const wanted = (line: number) => {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (sorted[mid].last < line) lo = mid + 1;
			else hi = mid;
		}
		return lo < sorted.length && sorted[lo].first <= line;
	};
	const read = previewEquations(output, wanted).sort((a, b) => a.startLine - b.startLine);
	const reach: number[] = [];
	for (let i = 0, most = -1; i < read.length; i++) reach.push(most = Math.max(most, read[i].endLine));
	return { read, reach };
}

/** The first of `read`, sorted by their first lines, from the line `line` */
function firstFrom(read: PreviewEquation[], line: number): number {
	let lo = 0;
	let hi = read.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (read[mid].startLine < line) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** How much longer a paragraph's text is with its own wraps */
function shiftIn(text: string, d: Decision): number {
	let shift = 0;
	for (const e of d.environments) shift += wrappedText(text, e.start, e.indent, e.end).length - (e.end - e.start);
	return shift;
}

/** Whether the preview's equations, as previewRead finds them, read a
 *  paragraph whose decision differs from main's, from the line `first` to
 *  the line `last` of the text with its wraps, as its own read does */
function readsAsDecided(check: { d: Decision; start: number; first: number; last: number }, preview: { read: PreviewEquation[]; reach: number[] }, lineAt: (offset: number) => number): boolean {
	const { d, start, first, last } = check;
	const { read, reach } = preview;
	const lo = firstFrom(read, first);
	// None from before it goes on into it
	if (lo > 0 && reach[lo - 1] >= first) return false;
	const expected = d.override!.displays.map(e => ({ startLine: lineAt(start + e.start), endLine: lineAt(start + e.end - 1) }));
	let k = 0;
	for (let i = lo; i < read.length && read[i].startLine <= last; i++) {
		const equation = read[i];
		// None from it goes on past it
		if (equation.endLine > last) return false;
		if (!equation.display) continue;
		const want = expected[k++];
		if (!want || want.startLine !== equation.startLine || want.endLine !== equation.endLine) return false;
	}
	return k === expected.length;
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
 *  in order, and the first place before `limit` where a rule of export's
 *  the read doesn't have may start (see unsimpleRule), at which the read
 *  stops, or -1, and the run of dollar signs read last */
interface ParagraphRead {
	equations: Equation[];
	unsimple: number;
	limit: number;
	runAt: number;
	runEnd: number;
	/** Whether it read a dollar sign as text before `limit`: escaped, of an
	 *  entity, or one that opens no equation, but in a code span or a
	 *  comment. Past it, the read takes a tag's, a URL's or a link's for
	 *  text, as it takes all past it for text but equations */
	textDollar: boolean;
}

/** markdown-it with the inline rules of export's (see createMarkdownIt in
 *  md-to-docx.ts) that read past a dollar sign in a simple paragraph: an
 *  escape, a code span and a comment, through linearInlineComments, which
 *  reads no other HTML, as unsimpleRule reads each other < as text. And
 *  export's math rule. Export's other rules read emphasis, entities and
 *  line ends, past no dollar sign, or start where unsimpleRule records it.
 *  Each rule reads in time linear in the paragraph, all of its openers
 *  together: a code span through markdown-it's cache of the backtick runs
 *  it found, a comment through commentEnds, and an equation, whose search
 *  for its closer ends at the next run of dollar signs that may close it,
 *  of one for inline math and of two or more for display math, which no
 *  opener of its kind is before, so no part of the text is searched more
 *  than twice for each kind, but a run of four or more, read in one step */
const reader = new MarkdownIt('zero', { html: true });
reader.inline.ruler.enable(['escape', 'backticks', 'html_inline']);
reader.use(linearInlineComments);
reader.inline.ruler.before('text', 'unsimple', unsimpleRule);
reader.inline.ruler.before('escape', 'textDollar', textDollarRule);
reader.inline.ruler.push('math', readMath);

/** The read of `src`, a paragraph's text, as export's inline parse reads it
 *  where it is simple, which stops where it is not before `limit` */
function readParagraph(src: string, limit: number): ParagraphRead {
	const read: ParagraphRead = { equations: [], unsimple: -1, limit, runAt: -1, runEnd: -1, textDollar: false };
	reader.inline.tokenize(new reader.inline.State(src, reader, read, []));
	return read;
}

/** Records where a rule of export's that the read doesn't have may start,
 *  before any rule reads the text there: a [ or a ], which may open or
 *  close a link, an image, a citation or a note's reference, a < that opens
 *  no comment, which may open a tag or an autolink, the :// of a URL
 *  linkify reads, a highlight's ==, a { that opens CriticMarkup or a
 *  comment's range, or a CriticMarkup span's closer. Before the read's
 *  limit, it stops the read there, where main's decision holds. Past it, it
 *  reads such a < as text, where html_inline searched, from each of many,
 *  on to the paragraph's end for the end of a declaration or a processing
 *  instruction, and reads nothing else */
function unsimpleRule(state: StateInline, silent: boolean): boolean {
	const { src, pos } = state;
	const code = src.charCodeAt(pos);
	const next = src.charCodeAt(pos + 1);
	if (code === 0x5B || code === 0x5D
		|| code === 0x3C && !src.startsWith('<!--', pos)
		|| code === 0x3A && src.startsWith('//', pos + 1)
		|| code === 0x3D && next === 0x3D
		|| code === 0x7B && (next === 0x23 || next === 0x2F || (next === 0x2B || next === 0x2D || next === 0x7E || next === 0x3E) && src.charCodeAt(pos + 2) === next)
		|| (code === 0x2B || code === 0x2D || code === 0x7E) && next === code && src.charCodeAt(pos + 2) === 0x7D) {
		const read = state.env as ParagraphRead;
		if (pos < read.limit) {
			read.unsimple = pos;
			state.pos = state.posMax;
			return true;
		}
		if (code === 0x3C) {
			if (!silent) state.pending += '<';
			state.pos++;
			return true;
		}
	}
	return false;
}

/** An entity, which export's entity rule reads as its character */
const ENTITY_RE = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

/** Records an escaped dollar sign, or one of an entity, which export reads
 *  as text, before the read's limit, and reads nothing */
function textDollarRule(state: StateInline): boolean {
	const { src, pos } = state;
	if (pos >= (state.env as ParagraphRead).limit) return false;
	const code = src.charCodeAt(pos);
	if (code === 0x5C && src.charCodeAt(pos + 1) === 0x24) (state.env as ParagraphRead).textDollar = true;
	else if (code === 0x26) {
		ENTITY_RE.lastIndex = pos;
		const entity = ENTITY_RE.exec(src);
		if (entity && reader.utils.unescapeAll(entity[0]) === '$') (state.env as ParagraphRead).textDollar = true;
	}
	return false;
}

/** export's math rule (see mathRule in md-to-docx.ts), which records each
 *  equation it reads, and a dollar sign that opens none as text */
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
	if (match?.kind !== 'math') {
		if (at < read.limit) read.textDollar = true;
		return false;
	}
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
		const read = readParagraph(source, source.length);
		return {
			...unit,
			simple: read.unsimple === -1 && !CRITIC_MARKUP.test(source),
			equations: read.equations.map(e => ({ start: unit.start + e.start, end: unit.start + e.end, display: e.display })),
		};
	});
}

interface BareEnvironment {
	/** Where its line starts, its indent, of up to three spaces, or in a
	 *  container, its line's prefix too, before its \begin{...}, its text,
	 *  from past that to its \end{...}, and its end, past that */
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
	const endOf = endFinder(text);

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

/** The first `marker` of `text` at or after `from`, or -1, as each
 *  environment searches for its \end{...}, in order: for each marker, where
 *  the last search went from and what it found, -1 for none, which a search
 *  from a later start before it finds again, so that no part of the text is
 *  searched twice for one */
function endFinder(text: string): (marker: string, from: number) => number {
	const ends = new Map<string, { from: number; at: number }>();
	return (marker, from) => {
		const last = ends.get(marker);
		if (last && from >= last.from && (last.at === -1 || from <= last.at)) return last.at;
		const at = text.indexOf(marker, from);
		ends.set(marker, { from, at });
		return at;
	};
}

/**
 * The environments to wrap in the paragraphs of list items and quotes, an
 * alert's too, each a paragraph's own decision (see readContainedParagraph).
 *
 * Main finds a bare environment only at a line's start, after up to three
 * spaces, so one in a quote, after its marker, or in a list item four
 * spaces in or more, as in a nested item or after a wide marker, went to
 * Word as text, as import keeps it. Export reads each such paragraph's text
 * past the quotes' markers and the items' indents, so an environment at a
 * line's start in it, after up to three spaces, is display math once
 * wrapped, with its fences on the lines of its \begin{...} and its
 * \end{...}, inside the container. One that main finds there, as in an item
 * two spaces in, is main's to decide, and so is each in a paragraph that
 * holds one of main's, or part of one.
 *
 * Main wraps none of these, so its decision, to leave each as it is, holds
 * where any of this is uncertain: in a paragraph with a line that goes on
 * it lazily, which export ends the quote before and VS Code's preview
 * doesn't, or which export's ending of quotes splits, of `lazy`, in a
 * note's body, with a tab in a line's prefix, in a quote in an item in a quote
 * or deeper, or which CriticMarkup joins to another (see exportUnits), and
 * for an environment whose \end{...} is past the paragraph's end, or has
 * text after it on its line, or a line after it that VS Code's preview
 * reads as a block of its own (see containedEnvironments), or whose
 * equation shows nothing (see readContainedParagraph). And each
 * is to be read as display math after its wrap, by export and the preview,
 * as the paragraphs of the top level are (see readParagraphOnItsOwn and
 * confirmInPreview).
 */
function decideContainers(text: string, contained: ContainedParagraph[], units: Zone[], ofTopLevel: BareEnvironment[][], zonesOf: { fences: FenceZone[]; steps: Zone[] }, lazy: LineSpan[]): Decision[] {
	if (contained.length === 0 || text.includes('\r')) return [];
	const decisions: Decision[] = [];
	const endOf = endFinder(text);
	const readsAlerts = !ALERT_REFERENCE.test(text);
	const lineAt = lazy.length > 0 ? lineFinder(text) : undefined;
	for (const paragraph of contained) {
		if (paragraph.lazy || !paragraph.lines || !readsContainers(paragraph.containers)) continue;
		if (lineAt && overlapsSpan(lazy, lineAt(paragraph.start), lineAt(paragraph.end - 1))) continue;
		if (ofTopLevel.some(environments => overlapsAnyZone(paragraph.start, paragraph.end, environments))) continue;
		const unit = units[firstEndingAfter(units, paragraph.start)];
		if (!unit || unit.start !== paragraph.start || unit.end !== paragraph.end) continue;
		const environments = containedEnvironments(text, paragraph, endOf, zonesOf.steps);
		if (environments.length === 0) continue;
		const decision = readContainedParagraph(text, paragraph, environments, zonesOf, readsAlerts);
		if (decision) decisions.push(decision);
	}
	return decisions;
}

/** Whether any of `spans`, sorted and apart, has a line from `first` to
 *  `last` */
function overlapsSpan(spans: LineSpan[], first: number, last: number): boolean {
	let lo = 0;
	let hi = spans.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (spans[mid].last < first) lo = mid + 1;
		else hi = mid;
	}
	return lo < spans.length && spans[lo].first <= last;
}

/** Whether decideContainers reads a paragraph in `containers`, outermost
 *  first: quotes, items, quotes in items or items in quotes, but not a
 *  quote in an item in a quote, nor an item in a quote in an item */
function readsContainers(containers: Array<'item' | 'quote'>): boolean {
	let changes = 0;
	for (let i = 1; i < containers.length; i++) if (containers[i] !== containers[i - 1]) changes++;
	return changes <= 1;
}

/** The first of `zones`, sorted and apart, that ends after `offset` */
function firstEndingAfter(zones: Zone[], offset: number): number {
	let lo = 0;
	let hi = zones.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (zones[mid].end <= offset) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** A \begin{...} at a line's start in a paragraph's text, after up to three
 *  spaces past the container's prefix */
const CONTAINED_BEGIN = /( {0,3})\\begin\{([a-zA-Z*]+)\}/y;

/** The bare environments of a paragraph in a container, in order: each
 *  \begin{...} of a display math environment at a line's start in its text,
 *  after up to three spaces, but in one before it, to its \end{...} in the
 *  paragraph, out of the zones of steps 1 to 3, `steps`. None where one
 *  isn't, nor where main finds one, nor where a line's prefix holds a tab:
 *  a paragraph's environments are wrapped together or not at all, as a
 *  dollar sign in one that stays text may pair with one in another. Nor
 *  where one holds nothing but white space, whose empty equation import
 *  writes as a line of the container's indent alone, which the next trip
 *  drops (and see readContainedParagraph for one whose equation shows
 *  nothing), nor where text follows one's \end{...} on its line, which VS
 *  Code's preview drops, or the line after it starts a block there (see
 *  startsABlock) */
function containedEnvironments(text: string, paragraph: ContainedParagraph, endOf: (marker: string, from: number) => number, steps: Zone[]): BareEnvironment[] {
	const { content } = paragraph;
	const lines = paragraph.lines!;
	const lastLine = lines[lines.length - 1];
	const textEnd = lastLine.source + content.length - lastLine.content;
	const environments: BareEnvironment[] = [];
	for (const line of lines) {
		const lineStart = text.lastIndexOf('\n', line.source - 1) + 1;
		const prefix = text.slice(lineStart, line.source);
		if (prefix.includes('\t')) return [];
		CONTAINED_BEGIN.lastIndex = line.content;
		const match = CONTAINED_BEGIN.exec(content);
		if (!match || !DISPLAY_MATH_ENVIRONMENTS.has(match[2])) continue;
		const begin = line.source + match[1].length;
		if (environments.length > 0 && begin < environments[environments.length - 1].end) continue;
		// One main's search finds, after up to three spaces alone
		if (/^ {0,3}$/.test(prefix + match[1])) return [];
		const marker = '\\end{' + match[2] + '}';
		const contentStart = begin + match[0].length - match[1].length;
		const at = endOf(marker, contentStart);
		if (at === -1 || at + marker.length > textEnd) return [];
		const end = at + marker.length;
		// The rest of its \end{...}'s line. VS Code's preview reads display
		// math from a fence at a line's start to the next line with a fence,
		// and drops the rest of that line, so prose after the closing fence,
		// which Word keeps, went from the preview, and its equation lost its
		// \end{...}. And it reads a fence after the opening one on its line as
		// closing it only at the line's end, so after an environment on one
		// line, not even white space
		const lineEnd = text.indexOf('\n', end);
		const rest = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
		if (rest !== '' && (!/^[ \t]*$/.test(rest) || text.lastIndexOf('\n', end - 1) < begin)) return [];
		// And the preview's display math ends the paragraph there, so the line
		// after it starts a block of its own, as a paragraph's line can't
		if (startsABlock(content, lineAfter(lines, at))) return [];
		if (holdsEither({ start: begin, end: contentStart }, { start: at, end }, steps)) return [];
		if (/^[\s>]*$/.test(text.slice(contentStart, at))) return [];
		environments.push({ start: lineStart, indent: begin - lineStart, contentStart, contentEnd: at, end });
	}
	return environments;
}

/** Where the line after the one of `lines` an offset of the text is on
 *  starts in the paragraph's text, or -1 where that is its last */
function lineAfter(lines: Array<{ content: number; source: number }>, offset: number): number {
	let lo = 0;
	let hi = lines.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (lines[mid].source <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1 < lines.length ? lines[lo + 1].content : -1;
}

/** A line's start that a paragraph's line can't have but a block's can: a
 *  code block's four spaces or tab, a list's marker, which in a paragraph
 *  is an empty item's or one from a number but 1, and a definition's label,
 *  of up to 999 characters, as markdown-it's */
const BLOCK_START = / {4}| {0,3}\t| {0,3}(?:\d{1,9}[.)]|[-+*])(?=[ \t\n]|$)| {0,3}\[(?:[^\\\]]|\\[\s\S]){0,999}\]:/y;
/** A line of a lone tag, which starts an HTML block that can't break a
 *  paragraph */
const LONE_TAG = new RegExp('^ {0,3}(?:' + HTML_OPEN_CLOSE_TAG_RE.source.replace(/^\^/, '') + ')\\s*$');

/**
 * Whether the line of a paragraph's text from `from`, but -1, starts a
 * block in VS Code's preview after display math ends the paragraph before
 * it: one that can't break a paragraph, so that in it, as Word and main's
 * preview read it, the line went on in the paragraph. A lone tag's HTML
 * block, as raw HTML, a definition, which shows nothing, a list, or a code
 * block.
 */
function startsABlock(content: string, from: number): boolean {
	if (from === -1) return false;
	BLOCK_START.lastIndex = from;
	if (BLOCK_START.test(content)) return true;
	const lineEnd = content.indexOf('\n', from);
	return LONE_TAG.test(content.slice(from, lineEnd === -1 ? content.length : lineEnd));
}

/** An alert's marker, as the first line of its paragraph's text, which
 *  export reads as text, but where the text defines a reference of its
 *  name (see ALERT_REFERENCE) */
const ALERT_MARKER_LINE = /^\[!(?:note|tip|important|warning|caution)\][ \t]*(?=\n|$)/i;
const ALERT_REFERENCE = /\[![A-Za-z]+\]:/;

/**
 * The environments of a paragraph in a container to wrap, where its own
 * read, of its text as export reads it, past the prefixes of its lines,
 * reads them in no display math, and as display math, and each other
 * equation as before, with them wrapped, and where main's zones over each,
 * of step 4, are wrong (see mainZoneIsWrong). As readParagraphOnItsOwn, but
 * where main wraps none, and a fence out of the paragraph is sure only in a
 * zone of steps 1 to 3. An alert's marker line is read as the text it is,
 * where `readsAlerts`: the text defines no reference of its name.
 */
function readContainedParagraph(text: string, paragraph: ContainedParagraph, environments: BareEnvironment[], zonesOf: { fences: FenceZone[]; steps: Zone[] }, readsAlerts: boolean): Decision | undefined {
	const lines = paragraph.lines!;
	if (CRITIC_MARKUP.test(paragraph.content)) return undefined;
	const alert = readsAlerts ? ALERT_MARKER_LINE.exec(paragraph.content) : null;
	const content = alert ? 'x'.repeat(alert[0].length) + paragraph.content.slice(alert[0].length) : paragraph.content;
	// The offset in `content` of one of the text on a line's text
	const toContent = (offset: number) => {
		let lo = 0;
		let hi = lines.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (lines[mid].source <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lines[lo].content + offset - lines[lo].source;
	};
	const begins = environments.map(e => toContent(e.start + e.indent));
	const ends = environments.map(e => toContent(e.end));
	if (splitsInPreview(content, begins, ends)) return undefined;
	// Each environment's text as x, but its line ends, so a dollar sign or a
	// backtick in it opens and closes nothing out of it, as once wrapped
	const masked: string[] = [];
	let from = 0;
	for (const e of environments) {
		const contentStart = toContent(e.contentStart);
		const contentEnd = toContent(e.contentEnd);
		masked.push(content.slice(from, contentStart), content.slice(contentStart, contentEnd).replace(/[^\n]/g, 'x'));
		from = contentEnd;
	}
	masked.push(content.slice(from));
	const last = ends[ends.length - 1];
	const before = readParagraph(masked.join(''), last);
	if (before.unsimple !== -1) return undefined;
	// A dollar sign Word shows as text before an environment's end, escaped,
	// of an entity, or one that opens no equation. Import writes one of
	// Word's text before display math back unescaped where it pairs with
	// none in that text, and the next trip read it with the display math's
	// fences after it, so the round trip changed the Markdown, as for
	// display math written so in a quote on main
	if (before.textDollar) return undefined;
	const displays = before.equations.filter(e => e.display);
	const wrapped = environments.map((_e, i) => i).filter(i => !holdsEither({ start: begins[i], end: toContent(environments[i].contentStart) }, { start: toContent(environments[i].contentEnd), end: ends[i] }, displays));
	if (wrapped.length === 0) return undefined;
	// Main's zone over each, which main left, is to be wrong. A fence of the
	// paragraph is sure where this read reads it in inline math
	const inlineMath = before.equations.filter(e => !e.display);
	const sure = (offset: number) => overlapsAnyZone(offset, offset + 2, zonesOf.steps)
		|| paragraph.start <= offset && offset < paragraph.end && inEquation(inlineMath, toContent(offset));
	if (wrapped.some(i => !mainZoneIsWrong(environments[i], zonesOf.fences, sure))) return undefined;
	// And none whose equation shows nothing, as one of a \label, a \notag
	// or a comment alone. Export writes an empty equation of it, which
	// import writes back as a line of the container's indent alone, which
	// the next trip drops, as for one of white space alone (see
	// containedEnvironments). Export's own conversion says which
	if (environments.some((_e, i) => !equationShowsText(content.slice(begins[i], ends[i])))) return undefined;

	// The paragraph's text with those wrapped, the offsets before which a
	// fence goes, and each wrap's display math
	const parts: string[] = [];
	const fencesAt: number[] = [];
	const wraps: Equation[] = [];
	let length = 0;
	from = 0;
	for (const i of wrapped) {
		const slice = content.slice(from, begins[i]);
		const wrap = '$' + '$' + content.slice(begins[i], ends[i]) + '$' + '$';
		parts.push(slice, wrap);
		wraps.push({ start: length + slice.length, end: length + slice.length + wrap.length, display: true });
		length += slice.length + wrap.length;
		fencesAt.push(begins[i], ends[i]);
		from = ends[i];
	}
	parts.push(content.slice(from));
	const moved = (offset: number, atToo: boolean) => offset + 2 * countBefore(fencesAt, offset, atToo);
	const withWraps = parts.join('');
	const after = readParagraph(withWraps, moved(last, true));
	if (after.unsimple !== -1) return undefined;
	const expected = before.equations.map(e => ({ start: moved(e.start, true), end: moved(e.end, false), display: e.display }))
		.concat(wraps).sort((a, b) => a.start - b.start);
	const same = expected.length === after.equations.length && expected.every((e, i) => {
		const read = after.equations[i];
		return e.start === read.start && e.end === read.end && e.display === read.display;
	});
	if (!same) return undefined;

	// Each display equation, by its lines, as confirmInPreview reads them:
	// at the start of each of its first and last lines in the paragraph's
	// lines with the wraps, which put no line in or out
	const contentLines = computeLineStarts(withWraps);
	const lineOf = (offset: number) => {
		let lo = 0;
		let hi = contentLines.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (contentLines[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const sourceFences = wrapped.flatMap(i => [environments[i].start + environments[i].indent, environments[i].end]);
	const lineStartIn = (line: number) => {
		const lineStart = text.lastIndexOf('\n', lines[line].source - 1) + 1;
		return lineStart - paragraph.start + 2 * countBefore(sourceFences, lineStart, false);
	};
	const shown = after.equations.filter(e => e.display).map(e => ({ start: lineStartIn(lineOf(e.start)), end: lineStartIn(lineOf(e.end - 1)) + 1, display: true }));
	return { environments: wrapped.map(i => environments[i]), override: { unit: { start: paragraph.start, end: paragraph.end }, byMain: [], displays: shown } };
}

/**
 * Whether VS Code's preview, whose display math from a wrap's opening fence
 * ends the paragraph before it and starts one after its closing fence's
 * line, would read the paragraph's text out of its environments, from
 * `begins` to `ends` in `content`, otherwise than export and main's preview
 * read it whole. Emphasis, strong emphasis or strikethrough from before an
 * environment to after it, which Word keeps, showed as its delimiters, and
 * a line break before one, a backslash at a line's end, as the backslash.
 * So the paragraph stays as written where its text out of its environments
 * holds any *, _ or ~, which may pair across one, or a line before one ends
 * in a backslash. Without them, of the rules a simple paragraph reads,
 * none reads a span over an environment but a code span or a comment,
 * which zone it (see containedEnvironments), and inline math, which the
 * reads with and without the wraps compare. So each piece of the paragraph
 * reads alone as in the whole, but a line break of two spaces before an
 * environment, which goes with the piece's end, where display math starts
 * a line anyway.
 */
function splitsInPreview(content: string, begins: number[], ends: number[]): boolean {
	for (let i = 0; i <= begins.length; i++) {
		const from = i === 0 ? 0 : ends[i - 1];
		const to = i === begins.length ? content.length : begins[i];
		if (/[*_~]/.test(content.slice(from, to))) return true;
		if (i < begins.length) {
			const lineStart = content.lastIndexOf('\n', begins[i] - 1);
			if (lineStart > 0 && content.charCodeAt(lineStart - 1) === 0x5C) return true;
		}
	}
	return false;
}

/** How many of `offsets`, sorted, are before `offset`, or at it too where
 *  `atToo` */
function countBefore(offsets: number[], offset: number, atToo: boolean): number {
	let lo = 0;
	let hi = offsets.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (offsets[mid] < offset || atToo && offsets[mid] === offset) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
