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
 */
export function getCslCompletionContext(text: string, offset: number): CslCompletionContext | undefined {
	const fmMatch = FRONTMATTER_RE.exec(text);
	if (!fmMatch) return undefined;

	const fmStart = fmMatch.index;
	const fmEnd = fmStart + fmMatch[0].length;
	if (offset < fmStart || offset > fmEnd) return undefined;

	// Compute body start: right after the first newline following ---
	const firstNewline = text.indexOf('\n', fmStart);
	if (firstNewline === -1) return undefined;
	const bodyStart = firstNewline + 1;

	// Find the csl: line containing the cursor
	const lines = text.slice(0, fmEnd).split(/\n/);
	let pos = 0;
	for (const line of lines) {
		const lineEnd = pos + line.length;
		if (offset >= pos && offset <= lineEnd) {
			// Strip trailing \r for matching
			const trimmedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
			// Check if this line is a csl: field
			const cslMatch = trimmedLine.match(/^csl:[ \t]*/);
			if (!cslMatch) return undefined;
			// Must be within the frontmatter body (not the --- delimiters)
			if (pos < bodyStart) return undefined;

			const valueStart = pos + cslMatch[0].length;
			const rawValue = trimmedLine.slice(cslMatch[0].length);
			// Determine visible end of value (exclude trailing \r)
			const valueEnd = pos + trimmedLine.length;
			const prefix = text.slice(valueStart, Math.min(offset, valueEnd)).replace(/^['"]/, '');

			return { prefix, valueStart, valueEnd };
		}
		pos = lineEnd + 1; // +1 for the newline
	}

	return undefined;
}

/**
 * Extract the `csl:` field value and its character range from YAML frontmatter.
 */
export function getCslFieldInfo(text: string): CslFieldInfo | undefined {
	const fmMatch = FRONTMATTER_RE.exec(text);
	if (!fmMatch) return undefined;

	// Compute body start: right after the first newline following ---
	const firstNewline = text.indexOf('\n', fmMatch.index);
	if (firstNewline === -1) return undefined;
	const fmBodyStart = firstNewline + 1;

	const fmBody = fmMatch[1];
	const lines = fmBody.split(/\n/);
	let pos = fmBodyStart;
	for (const line of lines) {
		// Strip trailing \r for matching
		const trimmedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
		const cslMatch = trimmedLine.match(/^csl:[ \t]*/);
		if (cslMatch) {
			const valueStart = pos + cslMatch[0].length;
			let rawValue = trimmedLine.slice(cslMatch[0].length);
			const valueEnd = pos + trimmedLine.length;

			// Strip surrounding quotes
			let unquotedStart = valueStart;
			let unquotedEnd = valueEnd;
			if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
				(rawValue.startsWith("'") && rawValue.endsWith("'"))) {
				rawValue = rawValue.slice(1, -1);
				unquotedStart = valueStart + 1;
				unquotedEnd = valueEnd - 1;
			}

			return {
				value: rawValue.trim(),
				valueStart: unquotedStart,
				valueEnd: unquotedEnd,
			};
		}
		pos += line.length + 1;
	}

	return undefined;
}
