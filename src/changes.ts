import * as vscode from 'vscode';

const patterns = [
	/\{\+\+([\s\S]+?)\+\+\}/g,
	/\{--([\s\S]+?)--\}/g,
	/\{\~\~([\s\S]+?)\~\~\}/g,
	/\{>>([\s\S]+?)<<\}/g,
	/\{==([\s\S]+?)==\}/g,
];

export function getAllMatches(document: vscode.TextDocument): vscode.Range[] {
	const text = document.getText();
	const ranges: vscode.Range[] = [];

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const startPos = document.positionAt(match.index);
			const endPos = document.positionAt(match.index + match[0].length);
			ranges.push(new vscode.Range(startPos, endPos));
		}
	}
	// Sort ranges by start position
	ranges.sort((a, b) => a.start.compareTo(b.start));
	return ranges;
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
