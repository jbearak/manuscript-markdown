import { criticCloserSearch } from '../critic-markup';

/**
 * If `offset` falls inside a `{#id>>...<<}` comment body, return the id.
 * Uses depth-aware matching to handle nested reply `{>>...<<}` blocks.
 */
export function findCommentIdAtOffset(text: string, offset: number): string | undefined {
	// Each comment's matching <<}, found for all at once, as each unclosed
	// one searched the rest of the text
	const closers = criticCloserSearch(text);
	const openRe = /\{#([a-zA-Z0-9_-]+)>>/g;
	let m: RegExpExecArray | null;
	while ((m = openRe.exec(text)) !== null) {
		const contentStart = m.index + m[0].length;
		const closeIdx = closers.matching(contentStart);
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
 * Remove complete plain and ID-based comment blocks, including nested replies.
 * Unmatched openers are preserved without preventing later complete blocks from being removed.
 */
function stripCommentBlocks(text: string): string {
	let result = text;
	// The matching <<} of each comment, found for all at once in the text, as
	// each unclosed one searched the rest of it. The search goes on where a
	// comment was taken out, past which the result is the text after its <<},
	// so each search is the text's, past the characters taken out before it
	const closers = criticCloserSearch(text);
	let removed = 0;
	const openRe = /\{(?:>>|#[a-zA-Z0-9_-]+>>)/g;
	let match: RegExpExecArray | null;
	while ((match = openRe.exec(result)) !== null) {
		const textClose = closers.matching(removed + match.index + match[0].length);
		if (textClose === -1) continue;
		const closeIdx = textClose - removed;
		result = result.slice(0, match.index) + result.slice(closeIdx + 3);
		removed += closeIdx + 3 - match.index;
		openRe.lastIndex = match.index;
	}
	return result;
}

/**
 * Strip all CriticMarkup tags from text.
 * Complete comment bodies are removed entirely; other delimiters are unwrapped (content kept).
 */
export function stripCriticMarkup(text: string): string {
	let result = stripCommentBlocks(text);
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
