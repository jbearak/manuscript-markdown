/**
 * Code region detection utility.
 * Identifies inline code spans and Markdown block regions.
 * Used by decoration, navigation, LSP, and preprocessing subsystems.
 */

import MarkdownIt from 'markdown-it';
import { HTML_OPEN_CLOSE_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import blockquote from 'markdown-it/lib/rules_block/blockquote.mjs';
import { commentEnds } from './inline-html-comments';
import { normalizeNewlines } from './newlines';

export interface CodeRegion {
	start: number;
	end: number;
}

/** An HTML block's lines, and whether its opener, as markdown-it reads it
 *  past the prefixes of the list items and quotes it's in, is of one that
 *  only its end ends, as a <pre> or a comment (see HTML_BLOCK_ENDS), even
 *  where markdown-it ends it before, as at a blank line in a list item */
export interface HtmlBlockRegion extends CodeRegion {
	endsAtItsEnd: boolean;
}

export interface MarkdownRegions {
	codeRegions: CodeRegion[];
	/** The fenced and indented code blocks alone, of codeRegions */
	blockCodeRegions: CodeRegion[];
	htmlRegions: CodeRegion[];
	/** With `literalHtml`, the HTML blocks it holds true of, each its own,
	 *  sorted, as two may touch */
	literalHtmlRegions: HtmlBlockRegion[];
	listRegions: CodeRegion[];
	/** With `includeLists`, each list item that no other holds, sorted, and
	 *  the start of each block in a list item that the item's end closes, not
	 *  its own end, sorted (see endsListInPlace) */
	outerItemRegions: CodeRegion[];
	itemClosedStarts: number[];
	/** With `includeTables`, each pipe table's lines, sorted, not merged
	 *  with one it touches */
	tableRegions: CodeRegion[];
	/** With `inlineHtml`, the raw HTML in a paragraph's or a heading's text
	 *  that markdown-it reads there whatever comes before it, sorted (see
	 *  pushInlineHtml) */
	inlineHtmlRegions: CodeRegion[];
}

export interface MarkdownRegionOptions {
	includeCode?: boolean;
	/** With includeCode, inline code spans too: default true */
	inlineCode?: boolean;
	html?: 'all' | 'literal';
	/** With `html`, whether export writes an HTML block of this text as it
	 *  is (see exportsLiterally in html-blocks.ts), for literalHtmlRegions */
	literalHtml?: (content: string) => boolean;
	includeLists?: boolean;
	includeTables?: boolean;
	/** With `html`, inlineHtmlRegions */
	inlineHtml?: boolean;
	/** With `html`, read a quote as ending before a line with text that
	 *  doesn't start as a quote's line does, as export does, which puts a
	 *  blank line before each (see deLazifyBlockquotesWithLines in
	 *  block-preprocess.ts), where markdown-it reads the line as going on
	 *  the quote's paragraph. A list a quote is in ends there too, as at any
	 *  line of the top level, so a fence in the list's item after it, which
	 *  the item's end would close, goes on at the top level */
	exportQuotes?: boolean;
}

const blockParser = new MarkdownIt();
const htmlBlockParser = new MarkdownIt({ html: true });
/** The same, but for a quote, which ends at each of its env's `quoteEnds`,
 *  sorted, a line markdown-it would read as going on it (see exportQuotes) */
const exportBlockParser = new MarkdownIt({ html: true });
exportBlockParser.block.ruler.at('blockquote', (state, startLine, endLine, silent) => {
	const ends: number[] | undefined = state.env.quoteEnds;
	if (!silent && ends && ends.length > 0) {
		// The first after the quote's first line
		let lo = 0;
		let hi = ends.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (ends[mid] <= startLine) lo = mid + 1;
			else hi = mid;
		}
		if (lo < ends.length && ends[lo] < endLine) endLine = ends[lo];
	}
	return blockquote(state, startLine, endLine, silent);
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
/** A line that starts as a quote's does, at the top level or in a list item
 *  one level in, as deLazifyBlockquotesWithLines reads one */
const QUOTE_LINE_RE = /^ {0,3}>/;
const HTML_COMMENT_ONLY_RE = /^<!--[\s\S]*?-->\s*$/;
const OPEN_CLOSE_TAG_AT = new RegExp(HTML_OPEN_CLOSE_TAG_RE.source.replace(/^\^/, ''), 'y');

/** The offset of each line's start: after a line feed or carriage return, alone or both */
export function computeLineStarts(text: string): number[] {
	const lineStarts = [0];
	for (let pos = 0; pos < text.length; pos++) {
		const char = text.charCodeAt(pos);
		if (char === 0x0D) {
			if (text.charCodeAt(pos + 1) === 0x0A) pos++;
			lineStarts.push(pos + 1);
		} else if (char === 0x0A) {
			lineStarts.push(pos + 1);
		}
	}
	return lineStarts;
}

export function mergeRegions(regions: CodeRegion[]): CodeRegion[] {
	regions.sort((a, b) => a.start - b.start);
	const merged: CodeRegion[] = [];
	for (const region of regions) {
		const previous = merged[merged.length - 1];
		if (previous && region.start <= previous.end) previous.end = Math.max(previous.end, region.end);
		else merged.push({ ...region });
	}
	return merged;
}

/** The code spans of `text`, past `blockRegions`. None runs into or out of
 *  one of `walls`, sorted, as markdown-it reads no span past an HTML block's
 *  edge, though the number step reads one in an HTML table's cell, whose
 *  number it leaves as it is */
function computeInlineCodeRegions(text: string, blockRegions: CodeRegion[], walls: readonly CodeRegion[] = []): CodeRegion[] {
	const regions: CodeRegion[] = [];
	let blockIndex = 0;
	let wallIndex = 0;
	let i = 0;
	while (i < text.length) {
		while (blockIndex < blockRegions.length && blockRegions[blockIndex].end <= i) blockIndex++;
		const blockRegion = blockRegions[blockIndex];
		if (blockRegion && blockRegion.start <= i) {
			i = blockRegion.end;
			blockIndex++;
			continue;
		}
		// A backslash escapes the next character, so \` is a literal backtick
		// (and \\` a literal backslash before a real one). Inside a code span
		// backslashes are literal, so the closing scan below doesn't do this.
		if (text[i] === '\\') {
			i += 2;
			continue;
		}
		if (text[i] !== '`') {
			i++;
			continue;
		}

		let backtickCount = 0;
		const start = i;
		while (i < text.length && text[i] === '`') {
			backtickCount++;
			i++;
		}

		// The end of the wall the span starts in, or the start of the next
		while (wallIndex < walls.length && walls[wallIndex].end <= start) wallIndex++;
		const wall = walls[wallIndex];
		const limit = !wall ? text.length : wall.start <= start ? wall.end : wall.start;
		let innerBlockIndex = blockIndex;
		let j = i;
		while (j < limit) {
			while (innerBlockIndex < blockRegions.length && blockRegions[innerBlockIndex].end <= j) {
				innerBlockIndex++;
			}
			const innerBlockRegion = blockRegions[innerBlockIndex];
			if (innerBlockRegion && innerBlockRegion.start <= j) {
				j = innerBlockRegion.end;
				innerBlockIndex++;
				continue;
			}
			if (text[j] !== '`') {
				j++;
				continue;
			}

			let closeCount = 0;
			while (j < limit && text[j] === '`') {
				closeCount++;
				j++;
			}
			if (closeCount === backtickCount) {
				regions.push({ start, end: j });
				i = j;
				blockIndex = innerBlockIndex;
				break;
			}
		}
	}
	return regions;
}

/**
 * Parse Markdown block structure once and derive the requested source regions.
 * HTML and list regions are opt-in so code-only callers avoid unused work.
 */
export function computeMarkdownRegions(text: string, options?: MarkdownRegionOptions): MarkdownRegions {
	const includeCode = options?.includeCode !== false;
	const blockCodeRegions: CodeRegion[] = [];
	const htmlRegions: CodeRegion[] = [];
	// Every HTML block's, past whose edges no code span runs (see
	// computeInlineCodeRegions)
	const htmlBlockRegions: CodeRegion[] = [];
	const literalHtmlRegions: HtmlBlockRegion[] = [];
	const listRegions: CodeRegion[] = [];
	const tableRegions: CodeRegion[] = [];
	const inlineHtmlRegions: CodeRegion[] = [];
	const outerItemRegions: CodeRegion[] = [];
	const itemClosedStarts: number[] = [];
	// The list items and quotes each token is in, innermost last
	const containers: Array<'item' | 'quote'> = [];
	const lineStarts = computeLineStarts(text);
	const exportQuotes = !!options?.html && !!options.exportQuotes;
	const parser = exportQuotes ? exportBlockParser : options?.html ? htmlBlockParser : blockParser;
	const blockTokens: Token[] = [];
	// The normal core rule performs this conversion before block parsing.
	// Invoke the block parser directly to avoid unnecessary inline parsing, but
	// retain its line-ending semantics (including bare CR documents), which
	// lineStarts counts the same way.
	const normalizedBlockText = normalizeNewlines(text);
	const env: { quoteEnds?: number[] } = {};
	if (exportQuotes && normalizedBlockText.includes('>')) {
		// Each line with text after a quote's line that doesn't start as one
		const lines = normalizedBlockText.split('\n');
		env.quoteEnds = [];
		for (let line = 1; line < lines.length; line++) {
			if (QUOTE_LINE_RE.test(lines[line - 1]) && !QUOTE_LINE_RE.test(lines[line]) && lines[line].trim() !== '') env.quoteEnds.push(line);
		}
	}
	parser.block.parse(normalizedBlockText, parser, env, blockTokens);

	const blockLines = options?.includeLists ? normalizedBlockText.split('\n') : [];
	// The lines to the last with text
	let textEnd = blockLines.length;
	while (textEnd > 0 && blockLines[textEnd - 1].trim() === '') textEnd--;
	let previous: Token | undefined;
	for (const token of blockTokens) {
		const before = previous;
		previous = token;
		if (options?.html && options.inlineHtml && token.type === 'inline' && token.map && token.content.includes('<')
			&& (before?.type === 'paragraph_open' || before?.type === 'heading_open')) {
			pushInlineHtml(token, text, lineStarts, inlineHtmlRegions);
		}
		if (options?.includeLists) {
			if (token.type === 'list_item_close' || token.type === 'blockquote_close') containers.pop();
			else if (token.type === 'blockquote_open') containers.push('quote');
			else if (token.type === 'list_item_open') {
				if (!containers.includes('item') && token.map) outerItemRegions.push({ start: lineStarts[token.map[0]] ?? text.length, end: lineStarts[token.map[1]] ?? text.length });
				containers.push('item');
			} else if (containers[containers.length - 1] === 'item' && token.map && closedByItem(token, blockLines, textEnd)) itemClosedStarts.push(lineStarts[token.map[0]]);
		}
		if (!token.map) continue;
		const isCode = includeCode && (token.type === 'fence' || token.type === 'code_block');
		if (options?.html && token.type === 'html_block') {
			const region = { start: lineStarts[token.map[0]] ?? text.length, end: lineStarts[token.map[1]] ?? text.length };
			htmlBlockRegions.push(region);
			if (options.literalHtml?.(token.content)) literalHtmlRegions.push({ ...region, endsAtItsEnd: !!htmlBlockEnd(token.content) });
		}
		const isHtml = options?.html !== undefined && token.type === 'html_block' &&
			(options.html === 'all' || !HTML_COMMENT_ONLY_RE.test(token.content.trim()));
		const isList = options?.includeLists === true && token.type === 'list_item_open';
		if (options?.includeTables && token.type === 'table_open') {
			tableRegions.push({ start: lineStarts[token.map[0]] ?? text.length, end: lineStarts[token.map[1]] ?? text.length });
		}
		if (!isCode && !isHtml && !isList) continue;

		const start = lineStarts[token.map[0]] ?? text.length;
		const mappedEnd = lineStarts[token.map[1]] ?? text.length;
		if (isCode) {
			let end = mappedEnd;
			while (end > start && (text.charCodeAt(end - 1) === 0x0A || text.charCodeAt(end - 1) === 0x0D)) end--;
			blockCodeRegions.push({ start, end });
		} else if (isHtml) {
			htmlRegions.push({ start, end: mappedEnd });
		} else {
			listRegions.push({ start, end: mappedEnd });
		}
	}

	const mergedBlockCodeRegions = includeCode ? mergeRegions(blockCodeRegions) : [];
	const codeRegions = !includeCode ? []
		: options?.inlineCode === false ? mergedBlockCodeRegions
		: [...mergedBlockCodeRegions, ...computeInlineCodeRegions(text, mergedBlockCodeRegions, mergeRegions(htmlBlockRegions))]
			.sort((a, b) => a.start - b.start);
	return {
		codeRegions,
		blockCodeRegions: mergedBlockCodeRegions,
		htmlRegions: options?.html ? mergeRegions(htmlRegions) : [],
		// In the order of the tokens, which is the text's, as no HTML block
		// holds another
		literalHtmlRegions,
		listRegions: options?.includeLists ? mergeRegions(listRegions) : [],
		outerItemRegions,
		itemClosedStarts,
		// In the order of the tokens, which is the text's
		tableRegions,
		inlineHtmlRegions,
	};
}

/** Where each line of an inline token's text starts, in the text and in
 *  `text`, from its map's lines, or null where a line of it isn't the end
 *  of its line in `text`, as where markdown-it cut a tab in an indent */
function inlineLines(token: Token, text: string, lineStarts: number[]): Array<{ content: number; source: number }> | null {
	const contentLines = token.content.split('\n');
	const lines: Array<{ content: number; source: number }> = [];
	let content = 0;
	for (let k = 0; k < contentLines.length; k++) {
		const start = lineStarts[token.map![0] + k];
		if (start === undefined) return null;
		let end = lineStarts[token.map![0] + k + 1] ?? text.length;
		while (end > start && (text.charCodeAt(end - 1) === 0x0A || text.charCodeAt(end - 1) === 0x0D)) end--;
		// markdown-it trims the text, at the end of its last line too
		if (k === contentLines.length - 1) while (end > start && /\s/.test(text[end - 1])) end--;
		const line = contentLines[k];
		if (end - start < line.length || !text.startsWith(line, end - line.length)) return null;
		lines.push({ content, source: end - line.length });
		content += line.length + 1;
	}
	return lines;
}

/** Whether a construct markdown-it reads in a paragraph's text can end at
 *  `at` of `content`: a code span, an equation, a link's text or
 *  destination, a citation, a highlight or CriticMarkup, and a
 *  substitution's old text at its ~>, as each side is read on its own */
function constructEndsAt(content: string, at: number): boolean {
	const char = content[at];
	if (char === '`' || char === '$' || char === ']' || char === ')') return true;
	const next = content[at + 1];
	if ((char === '=' && next === '=') || (char === '~' && next === '>')) return true;
	return content[at + 2] === '}' && (char === '+' || char === '-' || char === '~' || char === '<') && next === char;
}

/**
 * Push to `regions` the raw HTML in an inline token's text, of a paragraph
 * or a heading, as markdown-it reads it there, a comment or an open or close
 * tag, in `text`'s offsets, that no construct read before it can cut short:
 * one that holds no end of one (see constructEndsAt). Such a construct, as
 * a code span or a span of CriticMarkup from before its <, would leave the
 * rest of it text, as in [a <!--](x) {++ -->. One that holds all of it
 * holds what's in it too, so a CriticMarkup opener in the HTML starts no
 * span either way. A < after a backslash is text. A comment that doesn't
 * end in the text, and a processing instruction, a declaration or CDATA,
 * are left out, as are the text's whose lines aren't the ends of their
 * lines in `text` (see inlineLines).
 */
function pushInlineHtml(token: Token, text: string, lineStarts: number[], regions: CodeRegion[]): void {
	const content = token.content;
	const lines = inlineLines(token, text, lineStarts);
	if (!lines) return;
	// The first offset at or after each where a construct can end
	const nextEnd = new Int32Array(content.length + 1);
	nextEnd[content.length] = content.length;
	for (let at = content.length - 1; at >= 0; at--) nextEnd[at] = constructEndsAt(content, at) ? at : nextEnd[at + 1];
	const ends = content.includes('<!--') ? commentEnds(content) : undefined;
	let line = 0;
	const source = (at: number) => {
		while (line + 1 < lines.length && lines[line + 1].content <= at) line++;
		return lines[line].source + at - lines[line].content;
	};
	for (let at = content.indexOf('<'); at !== -1;) {
		let backslashes = 0;
		while (content.charCodeAt(at - 1 - backslashes) === 0x5C) backslashes++;
		let end = -1;
		if (backslashes % 2 === 0) {
			if (content.startsWith('<!--', at)) {
				const empty = /^<!---?>/.exec(content.slice(at, at + 6));
				const close = empty ? -1 : ends![at + 4];
				end = empty ? at + empty[0].length : close === -1 ? -1 : close + 3;
			} else {
				OPEN_CLOSE_TAG_AT.lastIndex = at;
				const tag = OPEN_CLOSE_TAG_AT.exec(content);
				if (tag) end = at + tag[0].length;
			}
		}
		if (end !== -1 && nextEnd[at] >= end) {
			const start = source(at);
			regions.push({ start, end: source(end - 1) + 1 });
			at = content.indexOf('<', end);
		} else {
			at = content.indexOf('<', at + 1);
		}
	}
}

/** The end of each HTML block that only its end ends, by its start, as
 *  markdown-it reads them: a <pre> or the like, a comment, a processing
 *  instruction, a declaration and CDATA */
const HTML_BLOCK_ENDS: Array<[RegExp, RegExp]> = [
	[/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
	[/^<!--/, /-->/],
	[/^<\?/, /\?>/],
	[/^<![A-Z]/, />/],
	[/^<!\[CDATA\[/, /\]\]>/],
];

/** The end of an HTML block of `content`, as markdown-it gives it, past
 *  the prefixes of the list items and quotes it's in, where only its end
 *  ends it (see HTML_BLOCK_ENDS) */
function htmlBlockEnd(content: string): RegExp | undefined {
	const opener = content.trimStart();
	return HTML_BLOCK_ENDS.find(([start]) => start.test(opener))?.[1];
}

/** Whether the end of the list item a fence or an HTML block `token` is in
 *  closes it, not the block's own end, of `lines`: a fence without its
 *  closing line, an HTML block that only its end ends, as a <pre>, without
 *  it, or one that a blank line ends, as a <div>, without that line, before
 *  a line with text, of those before `textEnd` */
function closedByItem(token: Token, lines: string[], textEnd: number): boolean {
	const [first, after] = token.map!;
	if (after >= textEnd) return false;
	if (token.type === 'fence') {
		const closer = new RegExp('^[ \\t]*' + (token.markup[0] === '~' ? '~' : '`') + '{' + token.markup.length + ',}[ \\t]*$');
		return after - 1 === first || !closer.test(lines[after - 1]);
	}
	if (token.type !== 'html_block') return false;
	const end = htmlBlockEnd(token.content);
	return end ? !end.test(token.content) : !/^[ \t]*$/.test(lines[after]);
}

/** Whether a block at [start, end) of the text of `regions`, with
 *  `includeLists`, that export writes at a line's start, as a grid table's
 *  placeholder or an embedded table, which ends the list the block is in,
 *  leaves the code and HTML blocks after it as they are: so where no block
 *  after it in the list item it's in is one that only the item's end
 *  closes, which goes on past the item once the list ends, as a fence
 *  without its closing line. Each step reads the code and HTML blocks of
 *  the Markdown it's given, before it writes any, and reads no block in
 *  them, so one that doesn't hold for writes none there */
export function endsListInPlace(start: number, end: number, regions: MarkdownRegions): boolean {
	const item = regionAt(start, regions.outerItemRegions);
	if (!item) return true;
	const starts = regions.itemClosedStarts;
	let lo = 0;
	let hi = starts.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (starts[mid] < end) lo = mid + 1;
		else hi = mid;
	}
	return lo === starts.length || starts[lo] >= item.end;
}

/**
 * Compute all code regions (fenced and indented blocks + inline code spans).
 * Returns sorted, non-overlapping regions inclusive of delimiters.
 */
export function computeCodeRegions(text: string): CodeRegion[] {
	return computeMarkdownRegions(text).codeRegions;
}

/**
 * Check if an offset falls inside any code region. Uses binary search for O(log n).
 */
export function isInsideCodeRegion(offset: number, regions: readonly CodeRegion[]): boolean {
	let lo = 0;
	let hi = regions.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const r = regions[mid];
		if (offset < r.start) {
			hi = mid - 1;
		} else if (offset >= r.end) {
			lo = mid + 1;
		} else {
			return true;
		}
	}
	return false;
}

/**
 * The region of sorted, non-overlapping `regions` that holds `offset`, if
 * one does, by binary search.
 */
export function regionAt<R extends CodeRegion>(offset: number, regions: readonly R[]): R | undefined {
	let lo = 0;
	let hi = regions.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const r = regions[mid];
		if (offset < r.start) hi = mid - 1;
		else if (offset >= r.end) lo = mid + 1;
		else return r;
	}
	return undefined;
}

/**
 * Whether the line from `lineStart` to `nextLineStart`, the next line's start
 * or the text's end, is in one of sorted, non-overlapping `regions`: 'alone'
 * where that region is the line alone, as a directive's HTML block is, and
 * 'within' where it holds more.
 */
export function lineInRegions(lineStart: number, nextLineStart: number, regions: readonly CodeRegion[]): 'alone' | 'within' | undefined {
	const region = regionAt(lineStart, regions);
	if (!region) return undefined;
	return region.start === lineStart && region.end <= nextLineStart ? 'alone' : 'within';
}

/**
 * Check if a range [start, end) overlaps any code region.
 */
export function overlapsCodeRegion(start: number, end: number, regions: readonly CodeRegion[]): boolean {
	for (const r of regions) {
		if (r.start >= end) break; // regions are sorted, no more overlaps possible
		if (start < r.end && end > r.start) return true;
	}
	return false;
}
