/** Decode a numeric HTML entity without allowing malformed input to throw. */
export function decodeNumericHtmlEntity(entity: string, digits: string, radix: 10 | 16): string {
	const codePoint = Number.parseInt(digits, radix);
	if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff
			|| (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
		return '\ufffd';
	}
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return entity;
	}
}

/**
 * A paragraph's text with the whitespace at its edges that Markdown would
 * lose written as character references. Markdown drops spaces and tabs at
 * the start of a paragraph, or reads four spaces or a tab there as indented
 * code, and markdown-it trims no-break spaces at either end too. At the end,
 * only the no-break spaces count, since Word shows no other whitespace
 * there. A paragraph of spaces alone stays as it is, an empty paragraph to
 * Markdown.
 */
export function keepParagraphEdgeWhitespace(text: string, atStart: boolean, atEnd: boolean): string {
	const reference = (whitespace: string) => whitespace.replace(/[ \t\u00a0]/g,
		c => c === ' ' ? '&#32;' : c === '\t' ? '&#9;' : '&nbsp;');
	if (!/[^ \t\u00a0]/.test(text)) return atStart && text.includes('\u00a0') ? reference(text) : text;
	let result = atStart ? text.replace(/^[ \t\u00a0]+/, reference) : text;
	if (atEnd) result = result.replace(/[ \t\u00a0]+$/, whitespace => whitespace.replace(/\u00a0/g, '&nbsp;'));
	return result;
}
