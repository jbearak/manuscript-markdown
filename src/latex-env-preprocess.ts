/**
 * Bare LaTeX environment preprocessing.
 *
 * Wraps bare `\begin{env}...\end{env}` blocks in `$$...$$` so the existing
 * mathRule inline rule handles them. Runs before CriticMarkup preprocessing
 * so it sees markers in their original form.
 *
 * Only recognized display-math environments are wrapped. Code regions, HTML
 * comments, CriticMarkup spans, and existing `$$` blocks are treated as
 * "inert zones" and skipped.
 */

import { computeCodeRegions } from './code-regions';
import { findMatchingClose } from './critic-markup';

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
 */
export function computeInertZones(text: string): Zone[] {
	const zones: Zone[] = [];

	// 1. Code regions (fenced blocks + inline code spans)
	for (const r of computeCodeRegions(text)) {
		zones.push({ start: r.start, end: r.end });
	}

	// 2. HTML comments <!-- ... -->
	{
		const re = /<!--[\s\S]*?-->/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			zones.push({ start: m.index, end: m.index + m[0].length });
		}
	}

	// 3. CriticMarkup spans
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
			let closeIdx: number;
			if (nested) {
				closeIdx = findMatchingClose(text, contentStart);
			} else {
				closeIdx = text.indexOf(close, contentStart);
			}
			if (closeIdx === -1) {
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
			const closeIdx = findMatchingClose(text, contentStart);
			if (closeIdx === -1) continue;
			zones.push({ start: m.index, end: closeIdx + 3 });
		}
	}

	// 4. Existing $$ ... $$ blocks
	{
		let pos = 0;
		while (pos < text.length - 1) {
			if (text[pos] === '$' && text[pos + 1] === '$') {
				const start = pos;
				pos += 2;
				// Find closing $$
				while (pos < text.length - 1) {
					if (text[pos] === '$' && text[pos + 1] === '$') {
						pos += 2;
						break;
					}
					pos++;
				}
				zones.push({ start, end: pos });
			} else {
				pos++;
			}
		}
	}

	// Sort by start, then merge overlapping/adjacent zones
	zones.sort((a, b) => a.start - b.start);
	const merged: Zone[] = [];
	for (const z of zones) {
		if (merged.length > 0 && z.start <= merged[merged.length - 1].end) {
			merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, z.end);
		} else {
			merged.push({ start: z.start, end: z.end });
		}
	}
	return merged;
}

function overlapsAnyZone(start: number, end: number, zones: Zone[]): boolean {
	for (const z of zones) {
		if (z.start >= end) break;
		if (start < z.end && end > z.start) return true;
	}
	return false;
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
export function wrapBareLatexEnvironments(text: string): string {
	// Fast path: no \begin{ means nothing to do
	if (!text.includes('\\begin{')) return text;

	const inertZones = computeInertZones(text);

	// Find bare \begin{env} at start of line (up to 3 spaces indent)
	const beginRe = /^([ ]{0,3})\\begin\{([a-zA-Z*]+)\}/gm;
	let match: RegExpExecArray | null;

	interface Replacement {
		start: number;
		end: number;
		replacement: string;
	}
	const replacements: Replacement[] = [];

	while ((match = beginRe.exec(text)) !== null) {
		const envName = match[2];
		if (!DISPLAY_MATH_ENVIRONMENTS.has(envName)) continue;

		const blockStart = match.index;
		if (overlapsAnyZone(blockStart, blockStart + match[0].length, inertZones)) continue;

		// Skip if this match falls inside an already-collected replacement
		// (handles nested environments — only the outermost is wrapped)
		if (replacements.length > 0 && blockStart < replacements[replacements.length - 1].end) continue;

		// Find matching \end{envName}
		const endMarker = '\\end{' + envName + '}';
		const endIdx = text.indexOf(endMarker, blockStart + match[0].length);
		if (endIdx === -1) continue;
		const blockEnd = endIdx + endMarker.length;

		if (overlapsAnyZone(endIdx, blockEnd, inertZones)) continue;

		// Extract block content (without leading indent)
		const innerContent = text.slice(blockStart + match[1].length, blockEnd);

		// Collapse \n\n → \n inside the block so markdown-it sees it as one paragraph
		const collapsed = innerContent.replace(/\n{2,}/g, '\n');

		replacements.push({
			start: blockStart,
			end: blockEnd,
			replacement: match[1] + '$$' + collapsed + '$$',
		});
	}

	if (replacements.length === 0) return text;

	// Apply right-to-left to preserve offsets
	let result = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
	}

	return result;
}
