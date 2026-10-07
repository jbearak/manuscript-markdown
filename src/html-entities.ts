import { decodeHTML, decodeHTMLAttribute } from 'entities';

// HTML's character references, as the browser reads them, and so the preview
// of an HTML block or table, by HTML's tokenizer's rules (the character
// reference states,
// https://html.spec.whatwg.org/multipage/parsing.html#character-reference-state),
// which the entities package, markdown-it's, follows:
// - A numeric one, decimal, or hexadecimal after an x or X, with its ; or
//   without, as &#128. One from 0x80 to 0x9F is Windows-1252's character, as
//   &#128; is €, but for the five it has none for, as &#129;, which stay as
//   they are, and one to no character is U+FFFD, as &#0;, a surrogate or
//   one past U+10FFFF (the numeric character reference end state).
// - A named one, by the longest of HTML's names its letters and digits
//   start, with its ; or, for about a hundred older names, without it, so
//   &copy b is © b and &notit; is ¬it;, by &not (the named character
//   reference state). In an attribute's value, a name without its ; before
//   a letter, a digit or an = stays as it is, as a URL's query &copy=2 does.
// Markdown reads one in its own text otherwise, as markdown-it does, by
// CommonMark's rules, which take a name only with its ; and make U+FFFD of
// a control character's number, as of &#128;.

/** A character reference in HTML, as the browser finds one: a numeric one,
 *  with its ; or without, or an & and the letters and digits after it, and
 *  a ; after them, which the browser reads by the longest name they start */
export const HTML_CHARACTER_REFERENCE = '&#(?:[0-9]+|[xX][0-9a-fA-F]+);?|&[A-Za-z][A-Za-z0-9]*;?';

// A numeric reference's digits, decimal, or hexadecimal after an x or X
const NUMERIC_DIGITS_RE = /&#(?:([0-9]+)|([xX])([0-9a-fA-F]+))/g;

/** `text` with each numeric reference's digits as few as read the same, which
 *  the entities package can take as a number, as it reads hundreds of digits
 *  as past JavaScript's, so as no number, and throws: without its leading
 *  zeros, which don't count, and as one just past U+10FFFF where the rest
 *  would be past it, as the browser reads any such number as U+FFFD (the
 *  numeric character reference end state) */
function withBoundedNumbers(text: string): string {
	if (!text.includes('&#')) return text;
	return text.replace(NUMERIC_DIGITS_RE, (reference: string, decimal: string | undefined, x: string | undefined, hex: string | undefined) => {
		const digits = (decimal ?? hex ?? '').replace(/^0+(?=.)/, '');
		// Seven digits are fewer than the package's numbers hold, in either base
		if (digits.length <= 7) return '&#' + (x ?? '') + digits;
		return '&#' + (x ?? '') + (decimal === undefined ? '110000' : '1114112');
	});
}

/** HTML's text with its character references read as the browser reads
 *  them, in one pass, so that &#38;#128; is &#128;, as text */
export function decodeHtmlCharacterReferences(text: string): string {
	return decodeHTML(withBoundedNumbers(text));
}

/** An attribute's value with its character references read as the browser
 *  reads them there, where a name without its ; before a letter, a digit or
 *  an = stays as it is, as in src="cover&notit;.png" or href="?a&copy=2" */
export function decodeHtmlAttribute(value: string): string {
	return decodeHTMLAttribute(withBoundedNumbers(value));
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
