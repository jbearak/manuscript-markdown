/**
 * Code region detection utility.
 * Identifies inline code spans, fenced code blocks, and indented code blocks.
 * Used by decoration, navigation, and LSP subsystems to skip code regions.
 */

export interface CodeRegion {
	start: number;
	end: number;
}

interface LineRange extends CodeRegion {
	contentEnd: number;
}

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

function leadingColumns(line: string): number {
	let columns = 0;
	for (const char of line) {
		if (char === ' ') columns++;
		else if (char === '\t') columns += 4 - (columns % 4);
		else break;
	}
	return columns;
}

function listContentIndent(line: string, activeIndent?: number): number | undefined {
	const match = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)\S/.exec(line);
	if (!match) return undefined;
	const markerStart = leadingColumns(match[1]);
	if (activeIndent === undefined ? markerStart > 3 : markerStart > activeIndent + 3) return undefined;
	let contentIndent = markerStart + match[2].length;
	for (const char of match[3]) {
		if (char === ' ') contentIndent++;
		else contentIndent += 4 - (contentIndent % 4);
	}
	return contentIndent;
}

function consumeIndentColumns(line: string, required: number): number | undefined {
	let columns = 0;
	let offset = 0;
	while (offset < line.length && columns < required) {
		if (line[offset] === ' ') columns++;
		else if (line[offset] === '\t') columns += 4 - (columns % 4);
		else break;
		offset++;
	}
	return columns >= required ? offset : undefined;
}

interface FenceMatch {
	char: string;
	count: number;
	remainder: string;
	containerIndent: number;
	blockquoteDepth: number;
}

function visualColumns(text: string, initial = 0): number {
	let columns = initial;
	for (const char of text) {
		if (char === '\t') columns += 4 - (columns % 4);
		else columns++;
	}
	return columns;
}

function stripBlockquoteMarkers(
	line: string,
	requiredDepth?: number,
): { candidate: string; depth: number } | undefined {
	let cursor = 0;
	let depth = 0;
	while (requiredDepth === undefined || depth < requiredDepth) {
		const marker = /^ {0,3}>[ \t]?/.exec(line.slice(cursor));
		if (!marker) break;
		cursor += marker[0].length;
		depth++;
	}
	if (requiredDepth !== undefined && depth !== requiredDepth) return undefined;
	return { candidate: line.slice(cursor), depth };
}

function fenceMatch(
	line: string,
	container?: { indent: number; blockquoteDepth: number },
): FenceMatch | undefined {
	const quoted = stripBlockquoteMarkers(line, container?.blockquoteDepth);
	if (!quoted) return undefined;
	let candidate = quoted.candidate;
	let containerIndent = container?.indent ?? 0;
	if (container) {
		const offset = consumeIndentColumns(candidate, container.indent);
		if (offset === undefined) return undefined;
		candidate = candidate.slice(offset);
	} else {
		containerIndent = 0;
		while (true) {
			const list = /^( {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)(.*)$/.exec(candidate);
			if (!list) break;
			containerIndent = visualColumns(list[1], containerIndent);
			candidate = list[2];
		}
	}
	const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(candidate);
	if (!match) return undefined;
	return {
		char: match[1][0],
		count: match[1].length,
		remainder: match[2],
		containerIndent,
		blockquoteDepth: quoted.depth,
	};
}

function containingRegionIndex(pos: number, regions: readonly CodeRegion[], from: number): number {
	let index = from;
	while (index < regions.length && pos >= regions[index].end) index++;
	return index;
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

/**
 * Compute all code regions in text.
 *
 * CommonMark details implemented here:
 * - fenced blocks may be indented by 0-3 spaces;
 * - indented blocks require a blank/code predecessor, so ordinary paragraph
 *   continuations are not reclassified as code;
 * - list continuation indentation is measured relative to the active marker,
 *   so a valid list paragraph is not mistaken for a top-level code block;
 * - inline backtick lookup is linear in the number of delimiter runs.
 *
 * Returns sorted, non-overlapping, half-open regions including delimiters.
 */
export function computeCodeRegions(text: string): CodeRegion[] {
	const lines = lineRanges(text);
	const fenced: CodeRegion[] = [];
	let openFence: {
		char: string;
		count: number;
		start: number;
		containerIndent: number;
		blockquoteDepth: number;
	} | undefined;

	for (const line of lines) {
		const content = text.slice(line.start, line.contentEnd);
		const match = fenceMatch(content, openFence
			? { indent: openFence.containerIndent, blockquoteDepth: openFence.blockquoteDepth }
			: undefined);
		if (!match) continue;
		if (!openFence) {
			// Backtick fence info strings cannot contain backticks.
			if (match.char === '`' && match.remainder.includes('`')) continue;
			openFence = {
				char: match.char,
				count: match.count,
				start: line.start,
				containerIndent: match.containerIndent,
				blockquoteDepth: match.blockquoteDepth,
			};
			continue;
		}
		if (
			match.char === openFence.char
			&& match.count >= openFence.count
			&& match.remainder.trim().length === 0
		) {
			fenced.push({ start: openFence.start, end: line.contentEnd });
			openFence = undefined;
		}
	}
	if (openFence) fenced.push({ start: openFence.start, end: text.length });

	const indented: CodeRegion[] = [];
	let fenceIndex = 0;
	let previousBlank = true;
	let previousWasCode = false;
	let activeListIndent: number | undefined;
	let activeBlockquoteDepth = 0;

	for (const line of lines) {
		fenceIndex = containingRegionIndex(line.start, fenced, fenceIndex);
		if (fenceIndex < fenced.length && line.start >= fenced[fenceIndex].start && line.start < fenced[fenceIndex].end) {
			previousBlank = true;
			previousWasCode = false;
			continue;
		}

		const content = text.slice(line.start, line.contentEnd);
		const quoted = stripBlockquoteMarkers(content)!;
		if (quoted.depth !== activeBlockquoteDepth) {
			activeListIndent = undefined;
			if (quoted.depth > activeBlockquoteDepth) {
				previousBlank = true;
				previousWasCode = false;
			}
			activeBlockquoteDepth = quoted.depth;
		}
		const containerContent = quoted.candidate;
		const blank = containerContent.trim().length === 0;
		const markerIndent = listContentIndent(containerContent, activeListIndent);
		if (markerIndent !== undefined) {
			activeListIndent = markerIndent;
			previousBlank = false;
			previousWasCode = false;
			continue;
		}

		const indent = leadingColumns(containerContent);
		if (activeListIndent !== undefined && !blank && indent < activeListIndent) {
			activeListIndent = undefined;
		}

		const requiredIndent = activeListIndent === undefined ? 4 : activeListIndent + 4;
		const isCode: boolean = !blank && indent >= requiredIndent && (previousBlank || previousWasCode);
		if (isCode) indented.push({ start: line.start, end: line.end });

		previousBlank = blank;
		previousWasCode = isCode;
	}

	const blockRegions = mergeOverlappingRanges([...fenced, ...indented]);

	// Collect every backtick delimiter run outside block code once. The next run
	// of equal length is precomputed in reverse, avoiding repeated forward scans.
	const delimiters: Array<{ start: number; end: number; count: number }> = [];
	let blockIndex = 0;
	let cursor = 0;
	while (cursor < text.length) {
		blockIndex = containingRegionIndex(cursor, blockRegions, blockIndex);
		if (blockIndex < blockRegions.length && cursor >= blockRegions[blockIndex].start && cursor < blockRegions[blockIndex].end) {
			cursor = blockRegions[blockIndex].end;
			continue;
		}
		if (text[cursor] !== '`') {
			cursor++;
			continue;
		}
		const start = cursor;
		while (cursor < text.length && text[cursor] === '`') cursor++;
		delimiters.push({ start, end: cursor, count: cursor - start });
	}

	const nextSame = new Array<number>(delimiters.length).fill(-1);
	const nextByCount = new Map<number, number>();
	for (let i = delimiters.length - 1; i >= 0; i--) {
		nextSame[i] = nextByCount.get(delimiters[i].count) ?? -1;
		nextByCount.set(delimiters[i].count, i);
	}

	const inline: CodeRegion[] = [];
	for (let i = 0; i < delimiters.length;) {
		const close = nextSame[i];
		if (close === -1) {
			i++;
			continue;
		}
		inline.push({ start: delimiters[i].start, end: delimiters[close].end });
		i = close + 1;
	}

	return mergeOverlappingRanges([...blockRegions, ...inline]);
}

/** Check if an offset falls inside any code region. Uses binary search. */
export function isInsideCodeRegion(offset: number, regions: CodeRegion[]): boolean {
	let lo = 0;
	let hi = regions.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const r = regions[mid];
		if (offset < r.start) hi = mid - 1;
		else if (offset >= r.end) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Check if a range [start, end) overlaps any code region. */
export function overlapsCodeRegion(start: number, end: number, regions: CodeRegion[]): boolean {
	for (const r of regions) {
		if (r.start >= end) break;
		if (start < r.end && end > r.start) return true;
	}
	return false;
}
