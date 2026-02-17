const ID_COMMENT_BODY_RE = /\{#([a-zA-Z0-9_-]+)>>([\s\S]*?)<<\}/g;

/**
 * If `offset` falls inside a `{#id>>...<<}` comment body, return the id.
 */
export function findCommentIdAtOffset(text: string, offset: number): string | undefined {
	const re = new RegExp(ID_COMMENT_BODY_RE.source, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (offset >= m.index && offset < m.index + m[0].length) {
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
 * Strip all CriticMarkup tags from text.
 * Comment bodies are removed entirely; other delimiters are unwrapped (content kept).
 */
export function stripCriticMarkup(text: string): string {
	let result = text;
	// Remove ID-based comment bodies (content removed)
	result = result.replace(/\{#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}/g, '');
	// Remove inline comment bodies (content removed)
	result = result.replace(/\{>>([\s\S]*?)<<\}/g, '');
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
