import { findMatchingClose } from '../critic-markup';

/**
 * If `offset` falls inside a `{#id>>...<<}` comment body, return the id.
 * Uses depth-aware matching to handle nested reply `{>>...<<}` blocks.
 */
export function findCommentIdAtOffset(text: string, offset: number): string | undefined {
	const openRe = /\{#([a-zA-Z0-9_-]+)>>/g;
	let m: RegExpExecArray | null;
	while ((m = openRe.exec(text)) !== null) {
		const contentStart = m.index + m[0].length;
		const closeIdx = findMatchingClose(text, contentStart);
		if (closeIdx === -1) continue;
		const endIdx = closeIdx + 3; // past <<}
		if (offset >= m.index && offset < endIdx) {
			return m[1];
		}
	}
	return undefined;
}

/**
 * Find the text between `{#id}` and `{/id}` range markers for the given id.
 */
export function findRangeTextForId(text: string, id: string): string | undefined {
	// IDs are [a-zA-Z0-9_-]+ so no special regex escaping needed
	const startRe = new RegExp(`\\{#${id}\\}`, 'g');
	const endRe = new RegExp(`\\{/${id}\\}`, 'g');

	const startMatch = startRe.exec(text);
	if (!startMatch) return undefined;

	const contentStart = startMatch.index + startMatch[0].length;
	endRe.lastIndex = contentStart;
	const endMatch = endRe.exec(text);
	if (!endMatch) return undefined;

	return text.slice(contentStart, endMatch.index);
}

/**
 * Remove all depth-aware `{>>...<<}` comment blocks (including nested replies) from text.
 */
function stripCommentBlocks(text: string): string {
	let result = text;
	// Repeatedly strip from innermost outward
	let changed = true;
	while (changed) {
		changed = false;
		// Find {>> that has no nested {>> before its <<}
		const idx = result.indexOf('{>>');
		if (idx === -1) break;
		const contentStart = idx + 3;
		const closeIdx = findMatchingClose(result, contentStart);
		if (closeIdx === -1) break;
		result = result.slice(0, idx) + result.slice(closeIdx + 3);
		changed = true;
	}
	return result;
}

/**
 * Strip all CriticMarkup tags from text.
 * Comment bodies are removed entirely; other delimiters are unwrapped (content kept).
 */
export function stripCriticMarkup(text: string): string {
	let result = text;
	// Remove ID-based comment bodies (depth-aware for nested replies)
	const idOpenRe = /\{#[a-zA-Z0-9_-]+>>/g;
	let m: RegExpExecArray | null;
	// Process from end to start to preserve indices
	const spans: Array<{start: number; end: number}> = [];
	while ((m = idOpenRe.exec(result)) !== null) {
		const contentStart = m.index + m[0].length;
		const closeIdx = findMatchingClose(result, contentStart);
		if (closeIdx !== -1) {
			spans.push({ start: m.index, end: closeIdx + 3 });
		}
	}
	for (let i = spans.length - 1; i >= 0; i--) {
		result = result.slice(0, spans[i].start) + result.slice(spans[i].end);
	}
	// Remove inline comment bodies (depth-aware)
	result = stripCommentBlocks(result);
	// Remove ID range markers
	result = result.replace(/\{#[a-zA-Z0-9_-]+\}/g, '');
	result = result.replace(/\{\/[a-zA-Z0-9_-]+\}/g, '');
	// Unwrap highlight delimiters (keep content)
	result = result.replace(/\{==([\s\S]*?)==\}/g, '$1');
	// Unwrap addition delimiters (keep content)
	result = result.replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1');
	// Unwrap deletion delimiters (keep content)
	result = result.replace(/\{--([\s\S]*?)--\}/g, '$1');
	// Unwrap substitution (keep content)
	result = result.replace(/\{~~([\s\S]*?)~~\}/g, '$1');
	return result.trim();
}
