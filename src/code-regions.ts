import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { isEscaped } from './citekey';

/**
 * Code region detection utility.
 * Identifies inline code spans, fenced code blocks, and indented code blocks.
 * Used by decoration, navigation, and LSP subsystems to skip code regions.
 */

export interface CodeRegion {
	start: number;
	end: number;
}

/** A source range whose delimiters participate in one Markdown inline parse. */
export interface MarkdownInlineBlock extends CodeRegion {
	id: number;
}

/** Parser-derived source blocks needed by structure-aware inline scanners. */
export interface MarkdownParsedBlocks {
	inlineBlocks: MarkdownInlineBlock[];
	htmlBlocks: CodeRegion[];
	codeBlocks: CodeRegion[];
}

interface LineRange extends CodeRegion {
	contentEnd: number;
}

const blockParser = new MarkdownIt({ html: true, linkify: false });
// Code fences remain inert to extension features even when they appear inside a
// raw HTML block, so discover code with HTML block parsing disabled.
const codeBlockParser = new MarkdownIt({ html: false, linkify: false });

function lineRanges(text: string): LineRange[] {
	const lines: LineRange[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf('\n', start);
		const end = newline === -1 ? text.length : newline + 1;
		let contentEnd = newline === -1 ? text.length : newline;
		if (contentEnd > start && text[contentEnd - 1] === '\r') contentEnd--;
		lines.push({ start, end, contentEnd });
		if (newline === -1) break;
		start = end;
	}
	return lines;
}

function stripBlockquoteMarkers(line: string): string {
	let cursor = 0;
	while (true) {
		const marker = /^ {0,3}>[ \t]?/.exec(line.slice(cursor));
		if (!marker) return line.slice(cursor);
		cursor += marker[0].length;
	}
}

/** Whether a physical line is blank after removing any blockquote containers. */
export function isBlankMarkdownContainerLine(line: string): boolean {
	return /^[ \t\r]*$/.test(stripBlockquoteMarkers(line));
}

function mergeOverlappingRanges(ranges: CodeRegion[]): CodeRegion[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: CodeRegion[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		const previous = merged[merged.length - 1];
		if (current.start < previous.end) previous.end = Math.max(previous.end, current.end);
		else merged.push({ ...current });
	}
	return merged;
}

function mappedTokenRange(token: Token, lines: readonly LineRange[]): CodeRegion | undefined {
	if (!token.map) return undefined;
	const startLine = Math.max(0, token.map[0]);
	const endLine = Math.min(lines.length, token.map[1]);
	if (endLine <= startLine) return undefined;
	return {
		start: lines[startLine].start,
		end: lines[endLine - 1].contentEnd,
	};
}

function splitUnescapedPipeRanges(text: string, line: LineRange): CodeRegion[] {
	const ranges: CodeRegion[] = [];
	let start = line.start;
	let escaped = false;
	for (let cursor = line.start; cursor < line.contentEnd; cursor++) {
		const char = text[cursor];
		if (char === '|' && !escaped) {
			ranges.push({ start, end: cursor });
			start = cursor + 1;
		}
		escaped = char === '\\';
	}
	ranges.push({ start, end: line.contentEnd });
	return ranges;
}

function trimmedRange(text: string, range: CodeRegion): CodeRegion {
	let { start, end } = range;
	while (start < end && text[start].trim().length === 0) start++;
	while (end > start && text[end - 1].trim().length === 0) end--;
	return { start, end };
}

function unescapedPipeText(text: string, range: CodeRegion): string {
	let result = '';
	for (let cursor = range.start; cursor < range.end; cursor++) {
		if (text[cursor] === '\\' && text[cursor + 1] === '|') continue;
		result += text[cursor];
	}
	return result;
}

function matchingCellRange(
	text: string,
	candidate: CodeRegion,
	expected: string,
	allowContainerPrefix: boolean,
): CodeRegion | undefined {
	const range = trimmedRange(text, candidate);
	const normalized = unescapedPipeText(text, range);
	if (normalized === expected) return range;
	if (!allowContainerPrefix || !normalized.endsWith(expected)) return undefined;
	if (expected.length === 0) return { start: range.end, end: range.end };

	// Only escaped pipes change length. Walk the source once to map the suffix's
	// normalized offset back to its exact UTF-16 source offset.
	const normalizedStart = normalized.length - expected.length;
	let normalizedOffset = 0;
	for (let cursor = range.start; cursor < range.end; cursor++) {
		if (text[cursor] === '\\' && text[cursor + 1] === '|') {
			if (normalizedOffset === normalizedStart) return { start: cursor, end: range.end };
			continue;
		}
		if (normalizedOffset === normalizedStart) return { start: cursor, end: range.end };
		normalizedOffset++;
	}
	return undefined;
}

function isTableContainerPrefix(text: string, range: CodeRegion): boolean {
	const candidate = text.slice(range.start, range.end);
	return /^(?:(?: {0,3}>[ \t]?)|(?:[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)|[ \t])*$/.test(candidate);
}

/**
 * Markdown-it emits one inline token per GFM table cell, but those tokens have
 * no source map. Recover their exact ranges from the mapped row and the same
 * escape-aware pipe splitting semantics used by Markdown-it's table rule.
 */
function tableCellRanges(
	text: string,
	lines: readonly LineRange[],
	tokens: readonly Token[],
): CodeRegion[] {
	const ranges: CodeRegion[] = [];
	for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
		const row = tokens[tokenIndex];
		if (row.type !== 'tr_open' || !row.map || row.map[1] !== row.map[0] + 1) continue;
		const line = lines[row.map[0]];
		if (!line) continue;

		const contents: string[] = [];
		for (let cursor = tokenIndex + 1; cursor < tokens.length && tokens[cursor].type !== 'tr_close'; cursor++) {
			if (tokens[cursor].type === 'inline' && !tokens[cursor].map) contents.push(tokens[cursor].content);
		}
		if (contents.length === 0) continue;

		let candidates = splitUnescapedPipeRanges(text, line);
		if (candidates.length > 0 && isTableContainerPrefix(text, candidates[0])) {
			candidates = candidates.slice(1);
		}
		if (candidates.length > 0 && text.slice(candidates[candidates.length - 1].start, candidates[candidates.length - 1].end).trim().length === 0) {
			candidates = candidates.slice(0, -1);
		}

		for (let cellIndex = 0; cellIndex < contents.length; cellIndex++) {
			const candidate = candidates[cellIndex];
			if (!candidate) {
				if (contents[cellIndex] === '') ranges.push({ start: line.contentEnd, end: line.contentEnd });
				continue;
			}
			const range = matchingCellRange(
				text,
				candidate,
				contents[cellIndex],
				cellIndex === 0,
			);
			if (range) ranges.push(range);
		}
	}
	return ranges;
}

function inlineTokenRanges(
	text: string,
	lines: readonly LineRange[],
	tokens: readonly Token[],
): CodeRegion[] {
	const ranges = tableCellRanges(text, lines, tokens);
	for (const token of tokens) {
		if (token.type !== 'inline') continue;
		const range = mappedTokenRange(token, lines);
		if (range) ranges.push(range);
	}
	return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Compute parser-derived source blocks once for structure-aware scanners.
 * Inline ranges include mapped paragraph-like tokens and exact GFM table-cell
 * ranges. Raw HTML blocks are separate because only HTML-tag analysis should
 * interpret their markup as structure.
 */
export function computeMarkdownParsedBlocks(text: string): MarkdownParsedBlocks {
	const lines = lineRanges(text);
	const tokens = blockParser.parse(text, {});
	const inlineBlocks = inlineTokenRanges(text, lines, tokens).map((range, id) => ({
		id,
		...range,
	}));
	const htmlBlocks: CodeRegion[] = [];
	const codeBlocks: CodeRegion[] = [];
	for (const token of tokens) {
		const range = mappedTokenRange(token, lines);
		if (!range) continue;
		if (token.type === 'html_block') htmlBlocks.push(range);
		else if (token.type === 'fence' || token.type === 'code_block') codeBlocks.push(range);
	}
	return { inlineBlocks, htmlBlocks, codeBlocks };
}

/** Return the exact source ranges represented by Markdown-it inline tokens. */
export function computeMarkdownInlineBlocks(text: string): MarkdownInlineBlock[] {
	return computeMarkdownParsedBlocks(text).inlineBlocks;
}

/**
 * Compute all code regions in text.
 *
 * Markdown-it's CommonMark block parser supplies source ranges for block code
 * and inline-bearing blocks. Raw HTML parsing is disabled for this pass so
 * backticks embedded in HTML table cells remain visible to code-aware features.
 * Backtick delimiters still pair only inside one parser-derived inline block,
 * so unmatched runs cannot cross Markdown block boundaries.
 *
 * Returns sorted, non-overlapping, half-open regions including delimiters.
 */
export function computeCodeRegions(text: string): CodeRegion[] {
	const lines = lineRanges(text);
	const tokens = codeBlockParser.parse(text, {});
	const blockRegions: CodeRegion[] = [];
	for (const token of tokens) {
		if (token.type !== 'fence' && token.type !== 'code_block') continue;
		const range = mappedTokenRange(token, lines);
		if (!range) continue;
		blockRegions.push({
			start: range.start,
			end: token.type === 'fence'
				? range.end
				: lines[Math.max(0, token.map![1] - 1)].end,
		});
	}

	const inline: CodeRegion[] = [];
	for (const block of inlineTokenRanges(text, lines, tokens)) {
		const delimiters: Array<{ start: number; end: number; count: number; escaped: boolean }> = [];
		for (let cursor = block.start; cursor < block.end;) {
			if (text[cursor] !== '`') {
				cursor++;
				continue;
			}
			const start = cursor;
			while (cursor < block.end && text[cursor] === '`') cursor++;
			delimiters.push({
				start,
				end: cursor,
				count: cursor - start,
				escaped: isEscaped(text, start),
			});
		}

		const nextByCount = new Map<number, number>();
		const nextFull = new Array<number>(delimiters.length).fill(-1);
		const nextAfterEscapedFirst = new Array<number>(delimiters.length).fill(-1);
		for (let i = delimiters.length - 1; i >= 0; i--) {
			const delimiter = delimiters[i];
			nextFull[i] = nextByCount.get(delimiter.count) ?? -1;
			if (delimiter.escaped && delimiter.count > 1) {
				nextAfterEscapedFirst[i] = nextByCount.get(delimiter.count - 1) ?? -1;
			}
			nextByCount.set(delimiter.count, i);
		}
		for (let i = 0; i < delimiters.length;) {
			const opener = delimiters[i];
			const start = opener.escaped ? opener.start + 1 : opener.start;
			const close = opener.escaped ? nextAfterEscapedFirst[i] : nextFull[i];
			if (close === -1) {
				i++;
				continue;
			}
			inline.push({ start, end: delimiters[close].end });
			i = close + 1;
		}
	}

	return mergeOverlappingRanges([...blockRegions, ...inline]);
}

/** Check if an offset falls inside any code region. Uses binary search. */
export function isInsideCodeRegion(offset: number, regions: CodeRegion[]): boolean {
	let lo = 0;
	let hi = regions.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const region = regions[mid];
		if (offset < region.start) hi = mid - 1;
		else if (offset >= region.end) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Check if a range [start, end) overlaps any code region. */
export function overlapsCodeRegion(start: number, end: number, regions: CodeRegion[]): boolean {
	for (const region of regions) {
		if (region.start >= end) break;
		if (start < region.end && end > region.start) return true;
	}
	return false;
}
