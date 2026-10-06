/** A numeric character reference in HTML: its digits, decimal, or
 *  hexadecimal after an x or X, and the ; after them, which the browser
 *  reads one without too, as &#128 */
export const HTML_NUMERIC_REFERENCE = '&#(?:[0-9]+|[xX][0-9a-fA-F]+);?';

// The characters of Windows-1252 at 0x80 to 0x9F, which the browser reads
// a numeric reference to one of as, as pages in that encoding meant, as
// &#128; as €, but for the five it has none for, which stay as they are
const WINDOWS_1252 = new Map([
	[0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
	[0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018],
	[0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc],
	[0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

/**
 * The character a numeric character reference in HTML is, as the browser
 * reads it, and so the preview of an HTML block or table, without allowing
 * malformed input to throw: U+FFFD for one to no character, as &#0;, a
 * surrogate or one past U+10FFFF, and Windows-1252's for one from 0x80 to
 * 0x9F, as &#128; for €. Markdown reads one in its own text otherwise, as
 * markdown-it does, which makes U+FFFD of any control character's.
 */
export function decodeHtmlNumericReference(reference: string): string {
	const hex = reference[2] === 'x' || reference[2] === 'X';
	const codePoint = Number.parseInt(reference.slice(hex ? 3 : 2), hex ? 16 : 10);
	if (!(codePoint > 0 && codePoint <= 0x10ffff) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
	return String.fromCodePoint(WINDOWS_1252.get(codePoint) ?? codePoint);
}

// The whitespace besides spaces and tabs that markdown-it trims from a
// paragraph's ends, as JavaScript's trim does: a no-break space, U+3000 as
// a Japanese paragraph starts with, and others, but not line ends, which a
// paragraph's text in Word doesn't hold
const TRIMMED_SPACE = '\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const TRIMMED_RE = new RegExp('[' + TRIMMED_SPACE + ']', 'g');
const EDGE_START_RE = new RegExp('^[ \\t' + TRIMMED_SPACE + ']+');
const EDGE_RE = new RegExp('[ \\t' + TRIMMED_SPACE + ']');
const NOT_EDGE_RE = new RegExp('[^ \\t' + TRIMMED_SPACE + ']');

/**
 * A paragraph's text with the whitespace at its edges that Markdown would
 * lose written as character references. Markdown drops spaces and tabs at
 * the start of a paragraph, or reads four spaces or a tab there as indented
 * code, and markdown-it trims other whitespace at either end too, as a
 * no-break space or U+3000. At the end, only that other whitespace counts,
 * since Word shows no spaces or tabs there. A paragraph of spaces and tabs
 * alone is an empty one to Markdown, and import makes it one (see
 * dropBlankParagraphText in converter.ts), so whitespace alone that starts
 * the text here is in a table's cell, where an empty paragraph keeps its
 * place, or in a paragraph with more in it, as an equation, and is all
 * references.
 */
export function keepParagraphEdgeWhitespace(text: string, atStart: boolean, atEnd: boolean): string {
	const trimmed = (whitespace: string) => whitespace.replace(TRIMMED_RE,
		c => c === '\u00a0' ? '&nbsp;' : '&#' + c.charCodeAt(0) + ';');
	const reference = (whitespace: string) => trimmed(whitespace).replace(/[ \t]/g, c => c === ' ' ? '&#32;' : '&#9;');
	if (!NOT_EDGE_RE.test(text)) return atStart ? reference(text) : text;
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
