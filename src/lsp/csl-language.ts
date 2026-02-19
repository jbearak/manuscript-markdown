/**
 * Pure helper functions for CSL YAML frontmatter language features.
 * Follows the pattern of citekey-language.ts and comment-language.ts.
 */

export interface CslCompletionContext {
	prefix: string;
	valueStart: number;
	valueEnd: number;
}

export interface SuggestTriggerTextChangeLike {
	rangeLength: number;
	text: string;
}
export interface CslFieldInfo {
	value: string;
	valueStart: number;
	valueEnd: number;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

interface CslLineMatch {
	lineStart: number;
	trimmedLine: string;
	cslPrefixLength: number;
	fmStart: number;
	fmEnd: number;
}

/**
 * Find the `csl:` line in YAML frontmatter and return its position info.
 */
function findCslLine(text: string): CslLineMatch | undefined {
	const fmMatch = FRONTMATTER_RE.exec(text);
	if (!fmMatch) return undefined;

	const fmStart = fmMatch.index;
	const fmEnd = fmStart + fmMatch[0].length;
	const firstNewline = text.indexOf('\n', fmStart);
	if (firstNewline === -1) return undefined;
	const bodyStart = firstNewline + 1;

	const fmBody = fmMatch[1];
	const lines = fmBody.split(/\n/);
	let pos = bodyStart;
	for (const line of lines) {
		const trimmedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
		const cslMatch = trimmedLine.match(/^csl:[ \t]*/);
		if (cslMatch) {
			return { lineStart: pos, trimmedLine, cslPrefixLength: cslMatch[0].length, fmStart, fmEnd };
		}
		pos += line.length + 1;
	}
	return undefined;
}

/**
 * Returns true only for direct single-character typing/backspace edits.
 * Used to avoid re-triggering suggestions when completion acceptance replaces text.
 */
export function shouldAutoTriggerSuggestFromChanges(changes: readonly SuggestTriggerTextChangeLike[]): boolean {
	if (changes.length === 0) return false;
	return changes.every(change => {
		const singleCharInsert = change.rangeLength === 0 && change.text.length === 1;
		const singleCharDelete = change.rangeLength === 1 && change.text.length === 0;
		return singleCharInsert || singleCharDelete;
	});
}

/**
 * Detect if the cursor is positioned after `csl:` in YAML frontmatter.
 * Returns context for completions, or undefined if not in a CSL value position.
 *
 * Implementation note: returns valueStart/valueEnd for the full editable value
 * (excluding surrounding quotes) and returns undefined when cursor is in the
 * `csl:` key prefix, so LSP textEdit.range is never inverted.
 */
export function getCslCompletionContext(text: string, offset: number): CslCompletionContext | undefined {
	const cslLine = findCslLine(text);
	if (!cslLine) return undefined;

	if (offset < cslLine.fmStart || offset > cslLine.fmEnd) return undefined;

	const lineEnd = cslLine.lineStart + cslLine.trimmedLine.length;
	if (offset < cslLine.lineStart || offset > lineEnd) return undefined;
	const rawValue = cslLine.trimmedLine.slice(cslLine.cslPrefixLength);
	let valueStart = cslLine.lineStart + cslLine.cslPrefixLength;
	let valueEnd = lineEnd;

	// Keep surrounding quotes outside the completion replace range.
	const hasLeadingQuote = rawValue.startsWith('"') || rawValue.startsWith("'");
	if (hasLeadingQuote) {
		valueStart += 1;
		if (rawValue.length > 1 && rawValue.endsWith(rawValue[0])) {
			valueEnd -= 1;
		}
	}
	if (offset < valueStart || offset > valueEnd) return undefined;

	const prefix = text.slice(valueStart, Math.min(offset, valueEnd));

	return { prefix, valueStart, valueEnd };
}

/**
 * Extract the `csl:` field value and its character range from YAML frontmatter.
 */
export function getCslFieldInfo(text: string): CslFieldInfo | undefined {
	const cslLine = findCslLine(text);
	if (!cslLine) return undefined;

	const valueStart = cslLine.lineStart + cslLine.cslPrefixLength;
	let rawValue = cslLine.trimmedLine.slice(cslLine.cslPrefixLength);
	const valueEnd = cslLine.lineStart + cslLine.trimmedLine.length;

	// Strip surrounding quotes
	let unquotedStart = valueStart;
	let unquotedEnd = valueEnd;
	if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
		(rawValue.startsWith("'") && rawValue.endsWith("'"))) {
		rawValue = rawValue.slice(1, -1);
		unquotedStart = valueStart + 1;
		unquotedEnd = valueEnd - 1;
	}
	const leadingWhitespace = rawValue.match(/^\s*/)?.[0].length ?? 0;
	const trailingWhitespace = rawValue.match(/\s*$/)?.[0].length ?? 0;
	const trimmedStart = Math.min(unquotedStart + leadingWhitespace, unquotedEnd);
	const trimmedEnd = Math.max(trimmedStart, unquotedEnd - trailingWhitespace);
	const trimmedValue = rawValue.trim();

	return {
		value: trimmedValue,
		valueStart: trimmedStart,
		valueEnd: trimmedEnd,
	};
}
