/**
 * The display and inline equations VS Code's preview reads, by their lines:
 * markdown-it, as the preview parses the text, with the rules of VS Code's
 * math extension (markdown-math, through @vscode/markdown-it-katex 1.1.2,
 * with the options VS Code gives it, so without bare blocks), read in time
 * linear in the text.
 *
 * The extension's block rule reads display math from a line that starts
 * with a fence to the next line that holds one, over blank lines and
 * paragraphs, where export reads display math in a paragraph alone (see
 * decideParagraphs in latex-env-preprocess.ts). Its inline rules read a
 * fence's display math and a dollar sign's inline math in a paragraph's
 * text, as here. Each search, as the extension's, for an equation's closer
 * ends at the next dollar sign or fence that may close it, which no opener
 * of its kind is before. The extension took the text before each closing
 * line, and html_inline searched on to the end from each of many
 * processing instructions, declarations or CDATA sections with no end,
 * which this reads apart, each to its end, found once for all of them.
 *
 * Not the preview's own rules (manuscript-markdown-plugin.ts), which read
 * CriticMarkup, citations and highlights, nor linkify, which the paragraphs
 * this reads for the wrapper hold none of where it matters.
 */

import MarkdownIt from 'markdown-it';
import html_inline from 'markdown-it/lib/rules_inline/html_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import { commentEnds } from './inline-html-comments';

/** An equation the preview reads, from its first line to its last, by
 *  their numbers, as markdown-it numbers the text's lines */
export interface PreviewEquation {
	startLine: number;
	endLine: number;
	display: boolean;
	/** Whether the block rule read it, from a fence at its line's start */
	block: boolean;
}

/** What a parse records, in its env: the equations, and, for the inline
 *  parse at hand, the line its text starts on and where each of its lines
 *  starts in it, found once */
interface PreviewRead {
	equations: PreviewEquation[];
	line: number;
	src: string;
	lineStarts: number[] | undefined;
	/** The inline parses to read: by the line each inline token starts on */
	wanted: (line: number) => boolean;
	/** For html_inline: the end of the next of each kind, as found last */
	next: Map<string, { from: number; at: number }>;
	ends: Int32Array | undefined;
}

/** VS Code's math extension's rules, as it registers them, for a test that
 *  renders the preview with them */
export function vscodeMath(md: MarkdownIt): void {
	md.block.ruler.after('blockquote', 'math_block', blockMath, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
	md.inline.ruler.after('escape', 'math_inline', inlineMath);
	md.inline.ruler.after('escape', 'math_inline_block', inlineMathBlock);
}

const parser = new MarkdownIt({ html: true });
parser.use(vscodeMath);
parser.inline.ruler.at('html_inline', htmlInline);
// Each inline token on the line its text starts on, or its row's, for a
// table's cell, which has no line of its own, and only those `wanted` asks for
parser.core.ruler.at('inline', (state: StateCore) => {
	const read = state.env as PreviewRead;
	let line = -1;
	for (const token of state.tokens) {
		if (token.map) line = token.map[0];
		if (token.type !== 'inline' || line === -1 || !read.wanted(line)) continue;
		read.line = token.map ? token.map[0] : line;
		read.src = token.content;
		read.lineStarts = undefined;
		read.ends = undefined;
		read.next.clear();
		state.md.inline.parse(token.content, state.md, state.env, token.children ??= []);
	}
});
parser.core.ruler.disable(['linkify', 'replacements', 'smartquotes', 'text_join']);

/** The equations VS Code's preview reads in `text`: each display equation
 *  of the block rule, and those of the inline rules in each paragraph,
 *  heading or table cell that starts on a line `wanted` holds */
export function previewEquations(text: string, wanted: (line: number) => boolean): PreviewEquation[] {
	const read: PreviewRead = { equations: [], line: 0, src: '', lineStarts: undefined, wanted, next: new Map(), ends: undefined };
	parser.parse(text, read);
	return read.equations;
}

/** The extension's block rule, which records the lines it reads */
function blockMath(state: StateBlock, start: number, end: number, silent: boolean): boolean {
	const src = state.src;
	let pos = state.bMarks[start] + state.tShift[start];
	let max = state.eMarks[start];
	const firstStart = pos + 2;
	const firstEnd = max;
	if (pos + 2 > max) return false;
	if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false;
	// The fences after it on its line, as /\$\$/g matches them: one that ends
	// the line closes it there, and more than one makes it no block
	let count = 0;
	let last = -1;
	for (let at = pos + 2; at + 1 < max;) {
		if (src.charCodeAt(at) === 0x24 && src.charCodeAt(at + 1) === 0x24) {
			count++;
			last = at;
			at += 2;
		} else {
			at++;
		}
	}
	let found = count === 1 && last === max - 2;
	if (count > 1) return false;
	if (silent) return true;
	let firstLine = src.slice(firstStart, firstEnd);
	if (found) firstLine = firstLine.trim().slice(0, -2);
	let next = start;
	let lastLine = '';
	while (!found) {
		next++;
		if (next >= end) break;
		pos = state.bMarks[next] + state.tShift[next];
		max = state.eMarks[next];
		if (pos < max && state.tShift[next] < state.blkIndent) break;
		const line = src.slice(pos, max);
		if (line.trimEnd().endsWith('$' + '$')) {
			lastLine = line.slice(0, line.lastIndexOf('$' + '$'));
			found = true;
		} else if (line.includes('$' + '$')) {
			// The text to the fence, as the extension finds it, at the first
			// fence of the whole text, by its offset after the text's leading
			// white space, so mostly none
			lastLine = src.slice(pos, firstFence(src));
			found = true;
		}
	}
	state.line = next + 1;
	const token = state.push('math_block', 'math', 0);
	token.block = true;
	token.content = (firstLine.trim() ? firstLine + '\n' : '') + state.getLines(start + 1, next, state.tShift[start], true) + (lastLine.trim() ? lastLine : '');
	token.map = [start, state.line];
	token.markup = '$' + '$';
	(state.env as Partial<PreviewRead>).equations?.push({ startLine: start, endLine: Math.min(next, end - 1), display: true, block: true });
	return true;
}

let fenceSource: string | undefined;
let fenceOffset = -1;

/** The offset of the first fence in `src`, after its leading white space,
 *  less that white space's length, as the extension's block rule takes it
 *  for a closing line with a fence before its end: the indexOf of the text
 *  to that line's end, trimmed. Found once for each text */
function firstFence(src: string): number {
	if (fenceSource !== src) {
		const leading = src.length - src.trimStart().length;
		fenceSource = src;
		fenceOffset = src.indexOf('$' + '$', leading) - leading;
	}
	return fenceOffset;
}

function isWordCharacterOrNumber(code: number): boolean {
	return code >= 0x30 && code <= 0x39 || code >= 0x41 && code <= 0x5A || code >= 0x61 && code <= 0x7A || code === 0x5F;
}

function isWhitespace(char: string): boolean {
	return /^\s$/u.test(char);
}

/** Whether the dollar sign at `at` is no backslash's, after an even number
 *  of them */
function unescaped(src: string, at: number): boolean {
	let pos = at - 1;
	while (src.charCodeAt(pos) === 0x5C) pos--;
	return (at - pos) % 2 === 1;
}

/** Whether a fence at `at` may open or close display math in a paragraph:
 *  isValidBlockDelim */
function blockDelimiter(src: string, at: number): boolean {
	return src.charCodeAt(at) === 0x24 && src.charCodeAt(at - 1) !== 0x24 && src.charCodeAt(at - 1) !== 0x5C
		&& src.charCodeAt(at + 1) === 0x24 && src.charCodeAt(at + 2) !== 0x24;
}

/** Pushes an inline rule's equation from `start` to `end` in its text, its
 *  fences `delimiter` long, and records it */
function record(state: StateInline, start: number, end: number, display: boolean): void {
	const delimiter = display ? 2 : 1;
	const token = state.push(display ? 'math_block' : 'math_inline', 'math', 0);
	token.markup = '$'.repeat(delimiter);
	token.content = state.src.slice(start + delimiter, end - delimiter);
	if (display) token.block = true;
	const read = state.env as Partial<PreviewRead>;
	if (read.src !== state.src || !read.equations || read.line === undefined) return;
	const starts = read.lineStarts ??= lineStartsOf(state.src);
	read.equations.push({ startLine: read.line + lineOf(starts, start), endLine: read.line + lineOf(starts, end - 1), display, block: false });
}

function lineStartsOf(src: string): number[] {
	const starts = [0];
	for (let at = src.indexOf('\n'); at !== -1; at = src.indexOf('\n', at + 1)) starts.push(at + 1);
	return starts;
}

function lineOf(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** The extension's display math in a paragraph: inlineMathBlock */
function inlineMathBlock(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const pos = state.pos;
	if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false;
	if (!blockDelimiter(src, pos)) {
		if (!silent) state.pending += '$' + '$';
		state.pos += 2;
		return true;
	}
	const start = pos + 2;
	let match = start;
	while ((match = src.indexOf('$' + '$', match)) !== -1) {
		if (unescaped(src, match)) break;
		match += 2;
	}
	if (match === -1) {
		if (!silent) state.pending += '$' + '$';
		state.pos = start;
		return true;
	}
	if (match === start) {
		if (!silent) state.pending += '$'.repeat(4);
		state.pos = start + 2;
		return true;
	}
	if (!blockDelimiter(src, match)) {
		if (!silent) state.pending += '$' + '$';
		state.pos = start;
		return true;
	}
	if (!silent) record(state, pos, match + 2, true);
	state.pos = match + 2;
	return true;
}

/** The extension's inline math: inlineMath */
function inlineMath(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const pos = state.pos;
	if (src.charCodeAt(pos) !== 0x24) return false;
	const last = state.tokens[state.tokens.length - 1];
	if (last?.type === 'html_inline' && /^<\w+.+[^/]>$/.test(last.content)) return false;
	const before = src[pos - 1];
	if (before === '$' || before === '\\' || before !== undefined && !isWhitespace(before) && isWordCharacterOrNumber(before.charCodeAt(0))) {
		if (!silent) state.pending += '$';
		state.pos += 1;
		return true;
	}
	const start = pos + 1;
	let match = start;
	while ((match = src.indexOf('$', match)) !== -1) {
		if (unescaped(src, match)) break;
		match += 1;
	}
	if (match === -1) {
		if (!silent) state.pending += '$';
		state.pos = start;
		return true;
	}
	if (match === start) {
		if (!silent) state.pending += '$' + '$';
		state.pos = start + 1;
		return true;
	}
	const after = src[match + 1];
	if (after === '$' || after !== undefined && !isWhitespace(after) && isWordCharacterOrNumber(after.charCodeAt(0))) {
		if (!silent) state.pending += '$';
		state.pos = start;
		return true;
	}
	if (!silent) record(state, pos, match + 1, false);
	state.pos = match + 1;
	return true;
}

/** markdown-it's html_inline, but a processing instruction, a declaration,
 *  a CDATA section and a comment each read to its end, as html_inline's
 *  regex reads it, from the end of the next of its kind, found once for all
 *  of them, not from each, to the text's end */
function htmlInline(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const pos = state.pos;
	if (src.charCodeAt(pos) !== 0x3C || pos + 2 >= state.posMax) return false;
	const second = src.charCodeAt(pos + 1);
	let end: number;
	if (second === 0x3F) {
		end = nextEnd(state, '?>', pos + 2);
	} else if (second === 0x21) {
		if (src.startsWith('<!-->', pos)) end = pos + 5;
		else if (src.startsWith('<!--->', pos)) end = pos + 6;
		else if (src.startsWith('<!--', pos)) {
			const read = state.env as PreviewRead;
			const ends = read.src === src ? read.ends ??= commentEnds(src) : commentEnds(src);
			end = ends[pos + 4] === -1 ? -1 : ends[pos + 4] + 3;
		} else if (src.startsWith('<![CDATA[', pos)) end = nextEnd(state, ']]>', pos + 9);
		else if (/[A-Za-z]/.test(src[pos + 2])) end = nextEnd(state, '>', pos + 3);
		else return false;
	} else {
		return html_inline(state, silent);
	}
	if (end === -1) return false;
	if (!silent) state.push('html_inline', '', 0).content = src.slice(pos, end);
	state.pos = end;
	return true;
}

/** Past the first `needle` at or after `from` in the inline text, or -1,
 *  from the one found last where it is still the first */
function nextEnd(state: StateInline, needle: string, from: number): number {
	const read = state.env as PreviewRead;
	const found = read.src === state.src ? read.next.get(needle) : undefined;
	if (found && found.from <= from && (found.at === -1 || from <= found.at)) return found.at === -1 ? -1 : found.at + needle.length;
	const at = state.src.indexOf(needle, from);
	if (read.src === state.src) read.next.set(needle, { from, at });
	return at === -1 ? -1 : at + needle.length;
}
