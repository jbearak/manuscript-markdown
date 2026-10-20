/**
 * Code region detection utility.
 * Identifies inline code spans and Markdown block regions.
 * Used by decoration, navigation, LSP, and preprocessing subsystems.
 */

import MarkdownIt from 'markdown-it';
import { HTML_OPEN_CLOSE_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import blockquote from 'markdown-it/lib/rules_block/blockquote.mjs';
import { parseGfmAlertMarker } from './gfm';
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
	tableRegions: TableRegion[];
	/** With `includeTables` and `literalHtml`, each HTML block it doesn't
	 *  hold true of, as one export reads tables from, sorted */
	htmlTableBlocks: TableRegion[];
	/** With `inlineHtml`, the raw HTML in a paragraph's or a heading's text
	 *  that markdown-it reads there whatever comes before it, sorted (see
	 *  pushInlineHtml) */
	inlineHtmlRegions: CodeRegion[];
	/** With `inlineBlocks`, the lines of each paragraph's, heading's and
	 *  table row's text, which markdown-it's inline parse reads on its own,
	 *  from the start of the first to the start of the line after the last,
	 *  sorted */
	inlineBlocks: CodeRegion[];
	/** With `commentReaches`, how far a comment can reach from each <!--
	 *  whose reach markdown-it fixes, sorted (see CommentReach) */
	commentReaches: CommentReach[];
}

/** A table's lines, and whether it's in no list item or quote, at the top
 *  level, where export writes it as a table, as it drops one in them */
export interface TableRegion extends CodeRegion {
	topLevel: boolean;
}

/**
 * How far a comment from a <!-- at `at` can reach, as markdown-it reads it,
 * to `reach`, in a block that ends at `blockEnd`, the start of the line
 * after its last. In a paragraph's or a heading's text, to the end of the
 * comment html_inline reads from it, which a construct before it, as a
 * code span, can only leave text, or to `at` itself, where it reads none:
 * after a backslash, or with no --> after it in the text, which no comment
 * reads past. And from the start of an HTML block, to the block's end,
 * which markdown-it puts at the line of its -->, or before, at the end of
 * the list item or quote it's in. Not one in another HTML block, or in a
 * table's cell, nor one in the text of a paragraph whose lines aren't the
 * ends of their lines in the text (see inlineLines).
 */
export interface CommentReach {
	at: number;
	reach: number;
	blockEnd: number;
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
	/** With it, inlineBlocks */
	inlineBlocks?: boolean;
	/** With `html`, commentReaches */
	commentReaches?: boolean;
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
/** A top-level bullet item's marker and the one space after it, before a
 *  quote that starts on the item's marker line, as - > a. A bullet item
 *  with text interrupts a paragraph, so the line always starts the item.
 *  Not an ordered item's, which doesn't where it starts past 1, nor one in
 *  another, nor with more spaces after it, whose lines go on further in */
const ITEM_MARKER = '[-*+] ';
/** Where a line may start as a quote's does, at the top level or in a list
 *  item one level in, on a bullet item's marker line too (see isQuoteLine) */
export const QUOTE_START = '(?:' + ITEM_MARKER + '| {0,3})>';
/** A line that starts as a quote's does at the top level or in a list item
 *  one level in */
const PLAIN_QUOTE_LINE_RE = /^ {0,3}>/;
/** A quote's line that starts on a list item's marker line, as its first */
const ITEM_QUOTE_LINE_RE = new RegExp('^' + ITEM_MARKER + '>');
/** A line that starts with a quote's marker past its spaces */
const ANY_QUOTE_LINE_RE = /^[ \t]*>/;

/**
 * Whether line `at` of `lines` starts as a quote's does, as
 * deLazifyBlockquotesWithLines reads one: at the top level or in a list
 * item one level in, or on a bullet item's marker line where it's the
 * quote's only line, as - > a, whose next line starts with no >. A quote
 * there whose lines go on, as   > b or     > b, which the item's indent
 * takes in, or which ends the item, as > b, is read as before, as none.
 */
export function isQuoteLine(lines: readonly string[], at: number): boolean {
	return PLAIN_QUOTE_LINE_RE.test(lines[at]) || (ITEM_QUOTE_LINE_RE.test(lines[at]) && !ANY_QUOTE_LINE_RE.test(lines[at + 1] ?? ''));
}
/** A quote's markers at a line's start, as its quote levels', with the
 *  marker of the item it starts in */
const QUOTE_MARKERS_RE = new RegExp('^(?:' + ITEM_MARKER + ')?(?: {0,3}> ?)+');
/** A line of plain text, which starts no block, as a list item, a heading,
 *  a fence, a thematic break or HTML, nor a table's row, display math, a
 *  CriticMarkup span or a definition, as a lazy line export keeps in a
 *  quote must (see keepsLazyLine) */
const PLAIN_LINE_RE = /^ {0,3}(?![-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|[#>`~<|{[$\\:=_!*-])\S/;
/** A line that starts with emphasis, *a* or _a_, an equation, $a$, a
 *  citation, [@a], or a note's reference, [^1], which starts no block
 *  either, but for a thematic break, or a definition, which
 *  holdsNoLineBreak keeps out */
const MARKUP_START_RE = /^ {0,3}(?:[*_](?![ \t]|$)|\$(?!\$)|\[(?:-?@|\^[\w-]+\]))/;
const THEMATIC_BREAK_RE = /^ {0,3}([*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** Whether `text` is a line of plain text (see PLAIN_LINE_RE), or one
 *  that starts with such markup */
function isPlainLine(text: string): boolean {
	return PLAIN_LINE_RE.test(text) || MARKUP_START_RE.test(text) && !THEMATIC_BREAK_RE.test(text);
}
/** Whether `text` ends in a line break: a \ that isn't escaped, an odd
 *  number of them, or two spaces or more after text, but not after a \
 *  that escapes the first */
function endsInLineBreak(text: string): boolean {
	let end = text.length;
	while (end > 0 && text[end - 1] === ' ') end--;
	const spaces = text.length - end;
	let slashes = 0;
	while (slashes < end && text[end - 1 - slashes] === '\\') slashes++;
	if (spaces === 0) return slashes % 2 === 1;
	return spaces >= 2 && end > 0 && /\S/.test(text[end - 1]) && slashes % 2 === 0;
}

/** What may open HTML, a code span, an equation or a link that goes on
 *  past a line's end, where spaces at its end are its text, not a line
 *  break, or split a table's row into cells, where a \ at its end is a
 *  cell's text */
const NO_LINE_BREAK_RE = /[<`$[\]|]/;
/** An equation that ends on its line, $a$, as export reads one (see
 *  findDollarMathAt): its $ after no word, $ or \, its text starting with
 *  no digit, as a sum of money does, and holding no $ but an escaped one's
 *  \ before it, nor CriticMarkup's openers or closers, nor what
 *  NO_LINE_BREAK_RE matches but a < that opens no HTML, and its last $
 *  before no word or $ */
const LINE_MATH_RE = /(?<![\w$\\])\$(?!\d)(?![^$]*?(?:\{(?:\+\+|--|~~|==|>>|#)|(?:\+\+|--|~~|==|<<)\}))(?:[^$\\`<[\]|]|<(?![A-Za-z/!?])|\\[^$`<[\]|])+\$(?![\w$])/g;
/** Brackets that end on their line, with nothing NO_LINE_BREAK_RE matches
 *  between them, and no ( after them that a link's may be, nor a
 *  definition's : */
const LINE_BRACKETS_RE = /\[([^[\]<`$|]*)\](?![(:])/g;
/** What such brackets hold where they're a citation's, [@a] or [see @a,
 *  p. 1], or a note's reference's, [^1] */
const CITATION_OR_NOTE_RE = /^\^[\w-]+$|(?:^|\s)-?@/;

/** Whether `text` may open what NO_LINE_BREAK_RE says, past an equation,
 *  a citation or a note's reference that ends on its line */
function holdsNoLineBreak(text: string): boolean {
	if (!NO_LINE_BREAK_RE.test(text)) return false;
	return NO_LINE_BREAK_RE.test(text.replace(LINE_MATH_RE, ' ')
		.replace(LINE_BRACKETS_RE, (brackets, inner: string) => CITATION_OR_NOTE_RE.test(inner) ? ' ' : brackets));
}

/** Whether export keeps line `at` of `lines` on a quote's paragraph, where
 *  markdown-it reads it lazily, and export would end the quote before it
 *  (see deLazifyBlockquotesWithLines in block-preprocess.ts): a line of
 *  plain text (see isPlainLine) after a quote's line of plain text that
 *  ends in a line break, as markdown-it reads it, or after a line export
 *  keeps so, `kept`. Only where a blank line or the end follows the lines
 *  of plain text in a row from it: any other line may go on the paragraph,
 *  or underline it as a setext heading's text, which a lazy line can't be.
 *  Not where a line of the quote's paragraph, past an alert's marker, or of
 *  those may open HTML, a code span, an equation or a link, which may go on
 *  past a line's end, or holds a |, as a table's row does, so that the
 *  spaces or \ are no line break (see holdsNoLineBreak) */
export function keepsLazyLine(lines: readonly string[], at: number, kept: boolean): boolean {
	if (!isPlainLine(lines[at])) return false;
	if (kept) return true;
	if (at === 0 || !isQuoteLine(lines, at - 1)) return false;
	const text = quoteLineText(lines, at - 1);
	if (!isPlainLine(text) || !endsInLineBreak(text)) return false;
	// Nor where the quote's paragraph, from its first line, may hold one
	for (let start = at - 1; start >= 0 && isQuoteLine(lines, start); start--) {
		const own = quoteLineText(lines, start);
		if (own.trim() === '') break;
		if (holdsNoLineBreak(own)) return false;
		if (!continuesQuote(lines, start)) break;
	}
	let end = at;
	for (; end < lines.length && isPlainLine(lines[end]); end++) {
		if (holdsNoLineBreak(lines[end])) return false;
	}
	return end === lines.length || lines[end].trim() === '';
}

/** Whether the quote's line `at` of `lines` goes on the quote of the line
 *  before it. Not where it starts on an item's marker line, where it's the
 *  quote's first (see isQuoteLine) */
function continuesQuote(lines: readonly string[], at: number): boolean {
	return at > 0 && isQuoteLine(lines, at - 1) && !ITEM_QUOTE_LINE_RE.test(lines[at]);
}

/** A quote's line `at` of `lines` past its markers, and past an alert's
 *  marker where it's the quote's first line, which is no link, and which
 *  export takes as the alert's */
function quoteLineText(lines: readonly string[], at: number): string {
	const text = lines[at].replace(QUOTE_MARKERS_RE, '');
	if (continuesQuote(lines, at)) return text;
	return parseGfmAlertMarker(text)?.rest ?? text;
}

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
	const tableRegions: TableRegion[] = [];
	const htmlTableBlocks: TableRegion[] = [];
	const inlineHtmlRegions: CodeRegion[] = [];
	const inlineBlocks: CodeRegion[] = [];
	const commentReaches: CommentReach[] = [];
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
		// Each line with text after a quote's line, or a line export keeps on
		// its paragraph, that doesn't start as one, but one export keeps on it
		// (see keepsLazyLine)
		const lines = normalizedBlockText.split('\n');
		env.quoteEnds = [];
		let kept = false;
		for (let line = 1; line < lines.length; line++) {
			const after = kept;
			kept = false;
			if (!(isQuoteLine(lines, line - 1) || after) || isQuoteLine(lines, line) || lines[line].trim() === '') continue;
			if (keepsLazyLine(lines, line, after)) kept = true;
			else env.quoteEnds.push(line);
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
		if (options?.html && options.commentReaches && token.type === 'inline' && token.map && token.content.includes('<!--')
			&& (before?.type === 'paragraph_open' || before?.type === 'heading_open')) {
			pushCommentReaches(token, text, lineStarts, commentReaches);
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
		if (options?.inlineBlocks && token.type === 'inline' && lineStarts[token.map[0]] !== inlineBlocks[inlineBlocks.length - 1]?.start) {
			inlineBlocks.push({ start: lineStarts[token.map[0]] ?? text.length, end: lineStarts[token.map[1]] ?? text.length });
		}
		const isCode = includeCode && (token.type === 'fence' || token.type === 'code_block');
		if (options?.html && token.type === 'html_block') {
			const region = { start: lineStarts[token.map[0]] ?? text.length, end: lineStarts[token.map[1]] ?? text.length };
			htmlBlockRegions.push(region);
			if (options.literalHtml?.(token.content)) literalHtmlRegions.push({ ...region, endsAtItsEnd: !!htmlBlockEnd(token.content) });
			else if (options.literalHtml && options.includeTables) htmlTableBlocks.push({ ...region, topLevel: token.level === 0 });
			// Its <!-- is the first on its first line, after the markers of
			// the list items and quotes it's in
			const at = options.commentReaches && token.content.trimStart().startsWith('<!--') ? text.indexOf('<!--', region.start) : -1;
			if (at !== -1 && at < region.end) commentReaches.push({ at, reach: region.end, blockEnd: region.end });
		}
		const isHtml = options?.html !== undefined && token.type === 'html_block' &&
			(options.html === 'all' || !HTML_COMMENT_ONLY_RE.test(token.content.trim()));
		const isList = options?.includeLists === true && token.type === 'list_item_open';
		if (options?.includeTables && token.type === 'table_open') {
			tableRegions.push({ start: lineStarts[token.map[0]] ?? text.length, end: lineStarts[token.map[1]] ?? text.length, topLevel: token.level === 0 });
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
		htmlTableBlocks,
		inlineHtmlRegions,
		// In the order of the tokens, which is the text's
		inlineBlocks,
		// In the order of the tokens, which is the text's, and in a token's
		// text in its order
		commentReaches,
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

/**
 * Push to `reaches` how far a comment can reach from each <!-- in an inline
 * token's text, of a paragraph or a heading, as markdown-it's html_inline
 * reads it there, in `text`'s offsets (see CommentReach): to the end of the
 * comment it reads from it, or to the <!-- itself, after a backslash, which
 * makes the < text, or with no --> after it in the text. A comment ends at
 * an empty one's >, as in <!-->, which its regex reads first. Not those of
 * a text whose lines aren't the ends of their lines in `text` (see
 * inlineLines).
 */
function pushCommentReaches(token: Token, text: string, lineStarts: number[], reaches: CommentReach[]): void {
	const content = token.content;
	const lines = inlineLines(token, text, lineStarts);
	if (!lines) return;
	const ends = commentEnds(content);
	const blockEnd = lineStarts[token.map![1]] ?? text.length;
	// The offset in `text` of `at` in the text, by its line, found by binary
	// search, as a comment's end can be past the next <!--
	const source = (at: number) => {
		let lo = 0;
		let hi = lines.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (lines[mid].content <= at) lo = mid;
			else hi = mid - 1;
		}
		return lines[lo].source + at - lines[lo].content;
	};
	for (let at = content.indexOf('<!--'); at !== -1; at = content.indexOf('<!--', at + 1)) {
		let backslashes = 0;
		while (content.charCodeAt(at - 1 - backslashes) === 0x5C) backslashes++;
		const empty = /^<!---?>/.exec(content.slice(at, at + 6));
		// The offset of its --> in the text
		const close = backslashes % 2 === 1 ? -1 : empty ? at + empty[0].length - 3 : ends[at + 4];
		const start = source(at);
		reaches.push({ at: start, reach: close === -1 ? start : source(close + 2) + 1, blockEnd });
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
