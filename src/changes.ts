import * as vscode from 'vscode';

// Combined pattern for all mdmarkup syntax in a single regex
// Using [\s\S]*? to match zero or more characters (including newlines) to support empty patterns
// Colored format highlights ==text=={color} must come before plain ==text== to match greedily
const combinedPattern = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{>>([\s\S]*?)<<\}|\{==([\s\S]*?)==\}|(?<!\{)==([^}=]+)==\{[a-z0-9-]+\}|(?<!\{)==([^}=]+)==(?!\})|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

export function getAllMatches(document: vscode.TextDocument): vscode.Range[] {
	const text = document.getText();
	const ranges: vscode.Range[] = [];

	let match;
	while ((match = combinedPattern.exec(text)) !== null) {
		const startPos = document.positionAt(match.index);
		const endPos = document.positionAt(match.index + match[0].length);
		ranges.push(new vscode.Range(startPos, endPos));
	}

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
