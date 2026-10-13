/**
 * Code region detection utility.
 * Identifies inline code spans and Markdown block regions.
 * Used by decoration, navigation, LSP, and preprocessing subsystems.
 */

import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import blockquote from 'markdown-it/lib/rules_block/blockquote.mjs';

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
	// retain its line-ending semantics (including bare CR documents).
	const normalizedBlockText = text.replace(/\r\n?/g, '\n');
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
	for (const token of blockTokens) {
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
	};
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
