import * as vscode from 'vscode';
import { computeCodeRegions, overlapsCodeRegion } from './code-regions';

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
// A { after an odd run of backslashes, whose last escapes it, opens no
// CriticMarkup, as export and the preview read it (markdown-it's escape
// rule): \{++a++} is text, \\{++a++} an insertion. The openers share one {,
// with the lookbehind after it, so it runs only where a { is. The grammar's
// escaped_brace and extractAllDecorationRanges in highlight-colors.ts read
// the same.
const combinedPattern = /\{(?<!(?<!\\)(?:\\\\)*\\\{)(?:\+\+([\s\S]*?)\+\+\}|--([\s\S]*?)--\}|\~\~([\s\S]*?)\~\~\}|#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|>>([\s\S]*?)<<\}|#[a-zA-Z0-9_-]+\}|\/[a-zA-Z0-9_-]+\}|==([\s\S]*?)==\})|(?<![{=])==(?<!(?<!\\)(?:\\\\)*\\==)([^}=]+)==\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\}|(?<![{=])==(?<!(?<!\\)(?:\\\\)*\\==)([^}=]+)==(?![}=])|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

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

	const text = document.getText();
	const codeRegions = computeCodeRegions(text);
	const rawRanges: Array<{ range: vscode.Range; offset: number; length: number }> = [];

	let match;
	while ((match = combinedPattern.exec(text)) !== null) {
		const startPos = document.positionAt(match.index);
		const endPos = document.positionAt(match.index + match[0].length);
		rawRanges.push({ range: new vscode.Range(startPos, endPos), offset: match.index, length: match[0].length });
	}

	// Filter out matches inside code regions
	const ranges = rawRanges
		.filter(r => !overlapsCodeRegion(r.offset, r.offset + r.length, codeRegions))
		.map(r => r.range);

	// Ranges are already in document order from single-pass regex
	// Filter out contained ranges (O(N) pass)
	const filteredRanges: vscode.Range[] = [];
	let lastKept: vscode.Range | undefined;

	for (const range of ranges) {
		if (!lastKept || !lastKept.contains(range)) {
			filteredRanges.push(range);
			lastKept = range;
		}
	}

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
