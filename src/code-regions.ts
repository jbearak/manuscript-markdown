/**
 * Code region detection utility.
 * Identifies inline code spans and fenced code blocks in Markdown text.
 * Used by decoration, navigation, and LSP subsystems to skip code regions.
 */

import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export interface CodeRegion {
	start: number;
	end: number;
}

const blockParser = new MarkdownIt();

/**
 * Compute all code regions (fenced code blocks + inline code spans) in text.
 * Fenced blocks are detected first; inline spans only in remaining text.
 * Returns sorted, non-overlapping regions (inclusive of delimiters).
 */
export function computeCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];

	// 1. Block code regions. markdown-it supplies source-line maps for fenced
	// and indented blocks, including list/blockquote containers and every line
	// ending convention. Convert those maps back to original byte offsets.
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
	const blockTokens: Token[] = [];
	// The normal core rule performs this conversion before block parsing.
	// Invoke the block parser directly to avoid unnecessary inline parsing, but
	// retain its line-ending semantics (including bare CR documents).
	const normalizedBlockText = text.replace(/\r\n?/g, '\n');
	blockParser.block.parse(normalizedBlockText, blockParser, {}, blockTokens);
	for (const token of blockTokens) {
		if (!token.map || (token.type !== 'fence' && token.type !== 'code_block')) continue;
		const start = lineStarts[token.map[0]] ?? text.length;
		let end = lineStarts[token.map[1]] ?? text.length;
		while (end > start && (text.charCodeAt(end - 1) === 0x0A || text.charCodeAt(end - 1) === 0x0D)) end--;
		regions.push({ start, end });
	}

	// 2. Inline code spans (CommonMark §6.1) — only outside fenced blocks
	// Consult only fenced regions while scanning. Previously this searched the
	// growing array of already-completed inline spans as well, making a document
	// with many code spans quadratic even though the cursor never moves backward.
	const fencedRegions = [...regions];
	const findContainingRegion = (pos: number): CodeRegion | null => {
		let lo = 0;
		let hi = fencedRegions.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const region = fencedRegions[mid];
			if (pos < region.start) hi = mid - 1;
			else if (pos >= region.end) lo = mid + 1;
			else return region;
		}
		return null;
	};

	let i = 0;
	while (i < text.length) {
		const fence = findContainingRegion(i);
		if (fence) {
			i = fence.end;
			continue;
		}
		if (text[i] === '`') {
			let btCount = 0;
			const btStart = i;
			while (i < text.length && text[i] === '`') { btCount++; i++; }
			let found = false;
			let j = i;
			while (j < text.length) {
				const innerFence = findContainingRegion(j);
				if (innerFence) {
					j = innerFence.end;
					continue;
				}
				if (text[j] === '`') {
					let closeCount = 0;
					while (j < text.length && text[j] === '`') { closeCount++; j++; }
					if (closeCount === btCount) {
						regions.push({ start: btStart, end: j });
						found = true;
						i = j;
						break;
					}
				} else {
					j++;
				}
			}
			if (!found) {
				// No matching close — backticks are literal
			}
		} else {
			i++;
		}
	}

	regions.sort((a, b) => a.start - b.start);
	return regions;
}

/**
 * Check if an offset falls inside any code region. Uses binary search for O(log n).
 */
export function isInsideCodeRegion(offset: number, regions: CodeRegion[]): boolean {
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
export function overlapsCodeRegion(start: number, end: number, regions: CodeRegion[]): boolean {
	for (const r of regions) {
		if (r.start >= end) break; // regions are sorted, no more overlaps possible
		if (start < r.end && end > r.start) return true;
	}
	return false;
}
