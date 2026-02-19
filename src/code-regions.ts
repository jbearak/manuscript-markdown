/**
 * Code region detection utility.
 * Identifies inline code spans and fenced code blocks in Markdown text.
 * Used by decoration, navigation, and LSP subsystems to skip code regions.
 */

export interface CodeRegion {
	start: number;
	end: number;
}

/**
 * Compute all code regions (fenced code blocks + inline code spans) in text.
 * Fenced blocks are detected first; inline spans only in remaining text.
 * Returns sorted, non-overlapping regions (inclusive of delimiters).
 */
export function computeCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];

	// 1. Fenced code blocks (``` or ~~~)
	const fenceRe = /^(`{3,}|~{3,})[^\n]*$/gm;
	let openFence: { char: string; count: number; start: number } | null = null;
	let fenceMatch: RegExpExecArray | null;

	while ((fenceMatch = fenceRe.exec(text)) !== null) {
		const fence = fenceMatch[1];
		const fenceChar = fence[0];
		const fenceCount = fence.length;

		if (!openFence) {
			openFence = { char: fenceChar, count: fenceCount, start: fenceMatch.index };
		} else if (fenceChar === openFence.char && fenceCount >= openFence.count
		&& fenceMatch[0].slice(fenceCount).trim() === '') {
			regions.push({ start: openFence.start, end: fenceMatch.index + fenceMatch[0].length });
			openFence = null;
		}
	}
	if (openFence) {
		regions.push({ start: openFence.start, end: text.length });
	}

	// 2. Inline code spans (CommonMark §6.1) — only outside fenced blocks
	// Fenced regions are added left-to-right so we can early-exit the scan.
	const findContainingRegion = (pos: number): CodeRegion | null => {
		for (const r of regions) {
			if (pos < r.start) break;
			if (pos < r.end) return r;
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
