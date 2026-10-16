import * as vscode from 'vscode';
import { navigationRanges } from './navigation-matches';

// Combined pattern for all Manuscript Markdown syntax in a single regex
// Using [\s\S]*? to match zero or more characters (including newlines) to support empty patterns
// Colored format highlights ==text=={color} must come before plain ==text== to match greedily
// Keep plain-highlight lookarounds in sync with syntaxes/manuscript-markdown.json
// and highlight-colors.ts (hlRe, isBlockedPredecessor). The test copies of this
// pattern must equal it (see changes.test.ts).
// AGENTS.md invariant: multi-line patterns may start mid-line for navigation;
// preview requires line-start, so navigation intentionally remains more permissive.
// A plain highlight's == opens none after an odd run of backslashes, whose
// last escapes its first =, as export and the preview read it (markdown-it's
// escape rule): \==a== is text, \\==a== a highlight. Its closing == has no
// such check, as export's has none. The lookbehind comes after the ==, so it
// runs only where an == is. The grammar's patterns match the run of
// backslashes instead: Oniguruma's lookbehind of no fixed length steps back to
// the line's start at each == after an even run.
// An == right after a { opens none either, as the preview reads it, but for
// a { that an odd run of backslashes escapes, which is text to export and
// the preview: \{==a==\} is a {, the highlighted a and a }, as import writes
// Word's literal braces around a highlight. The lookbehind for that { comes
// after the == too.
// Nor does an == right after such a { close one, as export, the preview and
// the decorations read it, whether or not a ==} closes its {==: a == b
// {==c==}{>>n<<}, which import writes for Word's a == b before a commented
// c, is a critic highlight on c and its comment, not a highlight of " b {".
// The same lookbehind follows the closing ==, so it runs only where an ==
// ends the highlight's text, and steps back only over the run of
// backslashes before the {. The grammar's patterns read a backslash in the
// text and the character after it as one instead, so a { right before the
// closing == is a {=='s only after an even run.
// A { after an odd run of backslashes, whose last escapes it, opens no
// CriticMarkup, as export and the preview read it (markdown-it's escape
// rule): \{++a++} is text, \\{++a++} an insertion. The openers share one {,
// with the lookbehind after it, so it runs only where a { is. The grammar's
// escaped_brace and extractAllDecorationRanges in highlight-colors.ts read
// the same.
// getAllMatches finds its matches with navigationMatches, which steps past
// an opener with no closer after it, as each searched the rest of the text.
// An alternative added here that starts with a { or a < and runs to the
// first of a closer after it needs a check there.
// It starts no match in code, and holds a plain or colored highlight's
// match, the only one that starts with an =, to its paragraph's text, as
// export and the preview read one (see navigationRanges), so a lone == in
// code or in another paragraph pairs with no highlight's ==. The grammar
// reads one line at a time, and nothing in a code span or a fenced block,
// as VS Code's Markdown grammar scopes them, so its patterns need neither.
const combinedPattern = /\{(?<!(?<!\\)(?:\\\\)*\\\{)(?:\+\+([\s\S]*?)\+\+\}|--([\s\S]*?)--\}|\~\~([\s\S]*?)\~\~\}|#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|>>([\s\S]*?)<<\}|#[a-zA-Z0-9_-]+\}|\/[a-zA-Z0-9_-]+\}|==([\s\S]*?)==\})|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\}|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)(?![}=])|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

// Version-keyed cache for navigation match results (single-document cache)
let cachedUri: string | undefined;
let cachedVersion: number | undefined;
let cachedRanges: vscode.Range[] | undefined;

export function getAllMatches(document: vscode.TextDocument): vscode.Range[] {
	const uri = document.uri.toString();
	const version = document.version;

	// Return cached ranges when (uri, version) matches
	if (cachedUri === uri && cachedVersion === version && cachedRanges) {
		return cachedRanges;
	}

	// In document order, none in code, nor in another (see navigationRanges)
	const filteredRanges = navigationRanges(combinedPattern, document.getText())
		.map(({ start, end }) => new vscode.Range(document.positionAt(start), document.positionAt(end)));

	// Cache results for this document version
	cachedUri = uri;
	cachedVersion = version;
	cachedRanges = filteredRanges;
	return filteredRanges;
}

export function next() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const ranges = getAllMatches(editor.document);
	if (ranges.length === 0) {
		return;
	}

	const currentPos = editor.selection.active;

	// Find first range that starts after current position
	let nextRange = ranges.find((r) => r.start.isAfter(currentPos));

	// Wrap around
	if (!nextRange) {
		nextRange = ranges[0];
	}

	if (nextRange) {
		editor.selection = new vscode.Selection(nextRange.start, nextRange.end);
		editor.revealRange(nextRange);
	}
}

export function prev() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const ranges = getAllMatches(editor.document);
	if (ranges.length === 0) {
		return;
	}

	const currentPos = editor.selection.start;

	// Find last range that starts before current position
	let prevRange = [...ranges].reverse().find((r) => r.start.isBefore(currentPos));

	// Wrap around
	if (!prevRange) {
		prevRange = ranges[ranges.length - 1];
	}

	if (prevRange) {
		editor.selection = new vscode.Selection(prevRange.start, prevRange.end);
		editor.revealRange(prevRange);
	}
}
