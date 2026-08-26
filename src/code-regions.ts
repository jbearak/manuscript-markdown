/**
 * Code region detection utility.
 * Identifies inline code spans and Markdown block regions.
 * Used by decoration, navigation, LSP, and preprocessing subsystems.
 */

import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export interface CodeRegion {
	start: number;
	end: number;
}

export interface MarkdownRegions {
	codeRegions: CodeRegion[];
	htmlRegions: CodeRegion[];
	listRegions: CodeRegion[];
}

export interface MarkdownRegionOptions {
	includeCode?: boolean;
	html?: 'all' | 'literal';
	includeLists?: boolean;
}

const blockParser = new MarkdownIt();
const htmlBlockParser = new MarkdownIt({ html: true });
const HTML_COMMENT_ONLY_RE = /^<!--[\s\S]*?-->\s*$/;

function computeLineStarts(text: string): number[] {
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

function computeInlineCodeRegions(text: string, blockRegions: CodeRegion[]): CodeRegion[] {
	const regions: CodeRegion[] = [];
	let blockIndex = 0;
	let i = 0;
	while (i < text.length) {
		while (blockIndex < blockRegions.length && blockRegions[blockIndex].end <= i) blockIndex++;
		const blockRegion = blockRegions[blockIndex];
		if (blockRegion && blockRegion.start <= i) {
			i = blockRegion.end;
			blockIndex++;
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

		let innerBlockIndex = blockIndex;
		let j = i;
		while (j < text.length) {
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
			while (j < text.length && text[j] === '`') {
				closeCount++;
				j++;
			}
			if (closeCount === backtickCount) {
				regions.push({ start, end: j });
				i = j;
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
	const listRegions: CodeRegion[] = [];
	const lineStarts = computeLineStarts(text);
	const parser = options?.html ? htmlBlockParser : blockParser;
	const blockTokens: Token[] = [];
	// The normal core rule performs this conversion before block parsing.
	// Invoke the block parser directly to avoid unnecessary inline parsing, but
	// retain its line-ending semantics (including bare CR documents).
	const normalizedBlockText = text.replace(/\r\n?/g, '\n');
	parser.block.parse(normalizedBlockText, parser, {}, blockTokens);

	for (const token of blockTokens) {
		if (!token.map) continue;
		const isCode = includeCode && (token.type === 'fence' || token.type === 'code_block');
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
	const codeRegions = includeCode
		? [...mergedBlockCodeRegions, ...computeInlineCodeRegions(text, mergedBlockCodeRegions)]
			.sort((a, b) => a.start - b.start)
		: [];
	return {
		codeRegions,
		htmlRegions: options?.html ? mergeRegions(htmlRegions) : [],
		listRegions: options?.includeLists ? mergeRegions(listRegions) : [],
	};
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
 * Check if a range [start, end) overlaps any code region.
 */
export function overlapsCodeRegion(start: number, end: number, regions: readonly CodeRegion[]): boolean {
	for (const r of regions) {
		if (r.start >= end) break; // regions are sorted, no more overlaps possible
		if (start < r.end && end > r.start) return true;
	}
	return false;
}
