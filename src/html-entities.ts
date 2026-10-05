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

// The whitespace besides spaces and tabs that markdown-it trims from a
// paragraph's ends, as JavaScript's trim does: a no-break space, U+3000 as
// a Japanese paragraph starts with, and others, but not line ends, which a
// paragraph's text in Word doesn't hold
const TRIMMED_SPACE = '\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const TRIMMED_RE = new RegExp('[' + TRIMMED_SPACE + ']', 'g');
const HAS_TRIMMED_RE = new RegExp('[' + TRIMMED_SPACE + ']');
const EDGE_START_RE = new RegExp('^[ \\t' + TRIMMED_SPACE + ']+');
const EDGE_RE = new RegExp('[ \\t' + TRIMMED_SPACE + ']');
const NOT_EDGE_RE = new RegExp('[^ \\t' + TRIMMED_SPACE + ']');

/**
 * A paragraph's text with the whitespace at its edges that Markdown would
 * lose written as character references. Markdown drops spaces and tabs at
 * the start of a paragraph, or reads four spaces or a tab there as indented
 * code, and markdown-it trims other whitespace at either end too, as a
 * no-break space or U+3000. At the end, only that other whitespace counts,
 * since Word shows no spaces or tabs there. A paragraph of spaces alone
 * stays as it is, an empty paragraph to Markdown.
 */
export function keepParagraphEdgeWhitespace(text: string, atStart: boolean, atEnd: boolean): string {
	const trimmed = (whitespace: string) => whitespace.replace(TRIMMED_RE,
		c => c === '\u00a0' ? '&nbsp;' : '&#' + c.charCodeAt(0) + ';');
	const reference = (whitespace: string) => trimmed(whitespace).replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;');
	if (!NOT_EDGE_RE.test(text)) return atStart && HAS_TRIMMED_RE.test(text) ? reference(text) : text;
	let result = atStart ? text.replace(EDGE_START_RE, reference) : text;
	// A backslash right before a reference would escape its &, so one before
	// whitespace, which was text, is escaped itself. From the end, as a
	// regex for the whitespace there would scan each run of it before.
	if (atEnd) {
		let end = result.length;
		while (end > 0 && EDGE_RE.test(result[end - 1])) end--;
		const kept = trimmed(result.slice(end));
		let backslashes = 0;
		if (kept.startsWith('&')) while (backslashes < end && result[end - 1 - backslashes] === '\\') backslashes++;
		result = result.slice(0, end) + (backslashes % 2 === 1 ? '\\' : '') + kept;
	}
	return result;
}
