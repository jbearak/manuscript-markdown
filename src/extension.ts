import * as vscode from 'vscode';

let decorationTypes: {
	addition: vscode.TextEditorDecorationType;
	deletion: vscode.TextEditorDecorationType;
	substitution: vscode.TextEditorDecorationType;
	comment: vscode.TextEditorDecorationType;
	highlight: vscode.TextEditorDecorationType;
} | null = null;

const patterns = {
	addition: /\{\+\+(.+?)\+\+\}/g,
	deletion: /\{--(.+?)--\}/g,
	substitution: /\{~~(.+?)~~\}/g,
	comment: /\{>>(.+?)<<\}/g,
	highlight: /\{==(.+?)==\}/g,
};

function getThemeColors() {
	const themeKind = vscode.window.activeColorTheme.kind;

	if (themeKind === vscode.ColorThemeKind.Light) {
		return {
			addition: '#098658',
			deletion: '#a31515',
			substitution: '#795e26',
			comment: '#6a737d',
			highlight: '#af00db',
		};
	}

	if (themeKind === vscode.ColorThemeKind.HighContrastLight) {
		return {
			addition: '#116329',
			deletion: '#a31515',
			substitution: '#7f4f00',
			comment: '#5a5a5a',
			highlight: '#800080',
		};
	}

	if (themeKind === vscode.ColorThemeKind.HighContrast) {
		return {
			addition: '#00ff00',
			deletion: '#ff0000',
			substitution: '#ffff00',
			comment: '#9d9d9d',
			highlight: '#ff00ff',
		};
	}

	// Dark themes (default)
	return {
		addition: '#4ec9b0',
		deletion: '#f48771',
		substitution: '#dcdcaa',
		comment: '#858585',
		highlight: '#c586c0',
	};
}

function createDecorations() {
	if (decorationTypes) {
		decorationTypes.addition.dispose();
		decorationTypes.deletion.dispose();
		decorationTypes.substitution.dispose();
		decorationTypes.comment.dispose();
		decorationTypes.highlight.dispose();
	}

	const colors = getThemeColors();

	decorationTypes = {
		addition: vscode.window.createTextEditorDecorationType({
			color: colors.addition,
		}),
		deletion: vscode.window.createTextEditorDecorationType({
			color: colors.deletion,
		}),
		substitution: vscode.window.createTextEditorDecorationType({
			color: colors.substitution,
		}),
		comment: vscode.window.createTextEditorDecorationType({
			color: colors.comment,
		}),
		highlight: vscode.window.createTextEditorDecorationType({
			color: colors.highlight,
		}),
	};
}

function updateDecorations(editor: vscode.TextEditor) {
	if (!decorationTypes || editor.document.languageId !== 'markdown') {
		return;
	}

	const text = editor.document.getText();
	const decorations: {
		[key: string]: vscode.DecorationOptions[];
	} = {
		addition: [],
		deletion: [],
		substitution: [],
		comment: [],
		highlight: [],
	};

	for (const [type, pattern] of Object.entries(patterns)) {
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const startPos = editor.document.positionAt(match.index);
			const endPos = editor.document.positionAt(match.index + match[0].length);
			decorations[type].push({ range: new vscode.Range(startPos, endPos) });
		}
	}

	editor.setDecorations(decorationTypes.addition, decorations.addition);
	editor.setDecorations(decorationTypes.deletion, decorations.deletion);
	editor.setDecorations(decorationTypes.substitution, decorations.substitution);
	editor.setDecorations(decorationTypes.comment, decorations.comment);
	editor.setDecorations(decorationTypes.highlight, decorations.highlight);
}

function updateAllEditors() {
	vscode.window.visibleTextEditors.forEach(updateDecorations);
}

export function activate(context: vscode.ExtensionContext) {
	createDecorations();

	// Update decorations when active editor changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) {
				updateDecorations(editor);
			}
		})
	);

	// Update decorations when document changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && event.document === editor.document) {
				updateDecorations(editor);
			}
		})
	);

	// Update decorations when theme changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveColorTheme(() => {
			createDecorations();
			updateAllEditors();
		})
	);

	// Initial decoration
	if (vscode.window.activeTextEditor) {
		updateDecorations(vscode.window.activeTextEditor);
	}
}

export function deactivate() {
	if (decorationTypes) {
		decorationTypes.addition.dispose();
		decorationTypes.deletion.dispose();
		decorationTypes.substitution.dispose();
		decorationTypes.comment.dispose();
		decorationTypes.highlight.dispose();
		decorationTypes = null;
	}
}