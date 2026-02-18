import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';
import * as changes from './changes';
import * as formatting from './formatting';
import * as author from './author';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';
import { WordCountController } from './wordcount';
import { convertDocx, CitationKeyFormat } from './converter';
import { convertMdToDocx } from './md-to-docx';
import * as path from 'path';
import { parseFrontmatter, hasCitations, normalizeBibPath } from './frontmatter';
import { BUNDLED_STYLE_LABELS } from './csl-loader';
import { getCompletionContextAtOffset } from './lsp/citekey-language';
import { getCslCompletionContext, shouldAutoTriggerSuggestFromChanges } from './lsp/csl-language';
import {
	getOutputBasePath,
	getOutputConflictMessage,
	getOutputConflictScenario,
} from './output-conflicts';
import {
	VALID_COLOR_IDS,
	HIGHLIGHT_DECORATION_COLORS,
	CRITIC_COMMENT_DECORATION,
	extractHighlightRanges,
	extractCommentRanges,
	extractAdditionRanges,
	extractDeletionRanges,
	extractCriticDelimiterRanges,
	extractSubstitutionNewRanges,
	setDefaultHighlightColor,
	getDefaultHighlightColor,
} from './highlight-colors';
let languageClient: LanguageClient | undefined;
let languageClientDisposables: vscode.Disposable[] = [];
let cslCacheDir: string = '';

export function activate(context: vscode.ExtensionContext) {
	cslCacheDir = path.join(context.globalStorageUri.fsPath, 'csl-styles');
	syncLanguageClient(context);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('manuscriptMarkdown.enableCitekeyLanguageServer')) {
				syncLanguageClient(context);
			}
			if (
				e.affectsConfiguration('manuscriptMarkdown.citekeyReferencesFromMarkdown') &&
				languageClient
			) {
				void languageClient.sendNotification('workspace/didChangeConfiguration', {
					settings: getLspSettings(),
				});
			}
		})
	);
	context.subscriptions.push({
		dispose: () => {
			void stopLanguageClient();
		},
	});
	// Register existing navigation commands
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.nextChange', () => changes.next()),
		vscode.commands.registerCommand('manuscript-markdown.prevChange', () => changes.prev())
	);

	// Register Set Citation Style command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.setCitationStyle', async () => {
			const items = [...BUNDLED_STYLE_LABELS].map(([id, displayName]) => ({
				label: displayName,
				description: id,
			}));
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select a citation style',
				matchOnDescription: true,
			});
			if (!picked) return;

			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'markdown') {
				vscode.window.showErrorMessage('No active Markdown file');
				return;
			}

			const text = editor.document.getText();
			const styleId = picked.description!;
			const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

			await editor.edit(editBuilder => {
				const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
				if (fmMatch) {
					const fmStart = fmMatch.index!;
					const bodyStart = text.indexOf('\n', fmStart) + 1;
					const fmBody = fmMatch[1];
					const cslLineMatch = fmBody.match(/^csl:.*$/m);
					if (cslLineMatch) {
						// Replace existing csl: line
						const lineStart = bodyStart + cslLineMatch.index!;
						const cslLine = cslLineMatch[0].endsWith('\r')
							? cslLineMatch[0].slice(0, -1)
							: cslLineMatch[0];
						const lineEnd = lineStart + cslLine.length;
						const range = new vscode.Range(
							editor.document.positionAt(lineStart),
							editor.document.positionAt(lineEnd)
						);
						editBuilder.replace(range, `csl: ${styleId}`);
					} else {
						// Insert csl: line at end of frontmatter body
						const insertOffset = bodyStart + fmBody.length;
						const insertPos = editor.document.positionAt(insertOffset);
						const insertionPrefix = fmBody.length > 0 ? eol : '';
						editBuilder.insert(insertPos, `${insertionPrefix}csl: ${styleId}`);
					}
				} else {
					// No frontmatter — prepend it
					editBuilder.insert(new vscode.Position(0, 0), `---${eol}csl: ${styleId}${eol}---${eol}`);
				}
			});
		})
	);

	// Register CriticMarkup annotation commands
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.markAddition', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '{++', '++}'))
		),
		vscode.commands.registerCommand('manuscript-markdown.markDeletion', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '{--', '--}'))
		),
		vscode.commands.registerCommand('manuscript-markdown.markSubstitution', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '{~~', '~>~~}', text.length + 5))
		),
		vscode.commands.registerCommand('manuscript-markdown.comment', () => {
			const authorName = author.getFormattedAuthorName();
			const useIds = vscode.workspace.getConfiguration('manuscriptMarkdown').get<boolean>('alwaysUseCommentIds', false);
			if (useIds) {
				applyFormatting((text) => formatting.highlightAndCommentWithId(text, authorName));
			} else {
				applyFormatting((text) => formatting.highlightAndComment(text, authorName));
			}
		}),
		vscode.commands.registerCommand('manuscript-markdown.substituteAndComment', () => {
			const authorName = author.getFormattedAuthorName();
			applyFormatting((text) => formatting.substituteAndComment(text, authorName));
		}),
		vscode.commands.registerCommand('manuscript-markdown.additionAndComment', () => {
			const authorName = author.getFormattedAuthorName();
			applyFormatting((text) => formatting.additionAndComment(text, authorName));
		}),
		vscode.commands.registerCommand('manuscript-markdown.deletionAndComment', () => {
			const authorName = author.getFormattedAuthorName();
			applyFormatting((text) => formatting.deletionAndComment(text, authorName));
		})
	);

	// Register Markdown formatting commands
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.formatBold', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '**', '**'))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatItalic', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '_', '_'))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatBoldItalic', () => 
			applyFormatting((text) => formatting.formatBoldItalic(text))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatStrikethrough', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '~~', '~~'))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatUnderline', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '<u>', '</u>'))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatHighlight', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '==', '=='))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatInlineCode', () => 
			applyFormatting((text) => formatting.wrapSelection(text, '`', '`'))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatCodeBlock', () => 
			applyFormatting((text) => formatting.wrapCodeBlock(text))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatLink', () => 
			applyFormatting((text) => formatting.formatLink(text))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatBulletedList', () => 
			applyLineBasedFormatting((text) => formatting.wrapLines(text, '- '))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatNumberedList', () => 
			applyLineBasedFormatting((text) => formatting.wrapLinesNumbered(text))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatTaskList', () => 
			applyLineBasedFormatting((text) => formatting.formatTaskList(text))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatQuoteBlock', () => 
			applyLineBasedFormatting((text) => formatting.wrapLines(text, '> ', true))
		)
	);

	// Register table formatting commands
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.reflowTable', () => 
			applyTableFormatting((text) => formatting.reflowTable(text))
		)
	);

	// Register heading commands (use line-based formatting)
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.formatHeading1', () => 
			applyLineBasedFormatting((text) => formatting.formatHeading(text, 1))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatHeading2', () => 
			applyLineBasedFormatting((text) => formatting.formatHeading(text, 2))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatHeading3', () => 
			applyLineBasedFormatting((text) => formatting.formatHeading(text, 3))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatHeading4', () => 
			applyLineBasedFormatting((text) => formatting.formatHeading(text, 4))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatHeading5', () => 
			applyLineBasedFormatting((text) => formatting.formatHeading(text, 5))
		),
		vscode.commands.registerCommand('manuscript-markdown.formatHeading6', () => 
			applyLineBasedFormatting((text) => formatting.formatHeading(text, 6))
		)
	);

	// Register Open in Word command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.openInWord', async (uri?: vscode.Uri) => {
			try {
				if (!uri) {
					const files = await vscode.window.showOpenDialog({
						filters: { 'Word Documents': ['docx'] },
						canSelectMany: false,
					});
					if (!files || files.length === 0) { return; }
					uri = files[0];
				}
				const opened = await vscode.env.openExternal(uri);
				if (!opened) {
					vscode.window.showErrorMessage('Failed to open file in external application.');
				}
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to open file: ${message}`);
			}
		})
	);

	// Register DOCX converter command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.convertDocx', async (uri?: vscode.Uri) => {
			try {
				if (!uri) {
					const files = await vscode.window.showOpenDialog({
						filters: { 'Word Documents': ['docx'] },
						canSelectMany: false,
					});
					if (!files || files.length === 0) { return; }
					uri = files[0];
				}
				const data = await vscode.workspace.fs.readFile(uri);
				const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
				const format = config.get<CitationKeyFormat>('citationKeyFormat', 'authorYearTitle');
				const tableIndentSpaces = config.get<number>('tableIndent', 2);
				const alwaysUseCommentIds = config.get<boolean>('alwaysUseCommentIds', false);
				const result = await convertDocx(new Uint8Array(data), format, {
					tableIndent: ' '.repeat(tableIndentSpaces),
					alwaysUseCommentIds,
				});

				const basePath = uri.fsPath.replace(/\.docx$/i, '');
				let mdUri = vscode.Uri.file(basePath + '.md');
				let bibUri = vscode.Uri.file(basePath + '.bib');
				const hasBibtex = Boolean(result.bibtex);
				const mdExists = await fileExists(mdUri);
				const bibExists = hasBibtex ? await fileExists(bibUri) : false;
				const conflictScenario = getOutputConflictScenario(mdExists, bibExists);

				if (conflictScenario) {
					const choice = await vscode.window.showWarningMessage(
						getOutputConflictMessage(basePath, conflictScenario),
						{ modal: true },
						'Replace',
						'New Name',
						'Cancel'
					);

					if (!choice || choice === 'Cancel') {
						return;
					}

					if (choice === 'New Name') {
						const selectedUri = await vscode.window.showSaveDialog({
							defaultUri: mdUri,
							filters: { 'Markdown': ['md'] },
							saveLabel: 'Choose output file name'
						});
						if (!selectedUri) {
							return;
						}

						const selectedBasePath = getOutputBasePath(selectedUri.fsPath);
						mdUri = vscode.Uri.file(selectedBasePath + '.md');
						bibUri = vscode.Uri.file(selectedBasePath + '.bib');
					}
				}

				await vscode.workspace.fs.writeFile(mdUri, new TextEncoder().encode(result.markdown));
				if (result.bibtex) {
					await vscode.workspace.fs.writeFile(bibUri, new TextEncoder().encode(result.bibtex));
				}

				const mdDoc = await vscode.workspace.openTextDocument(mdUri);
				await vscode.window.showTextDocument(mdDoc);
				if (result.bibtex) {
					const bibDoc = await vscode.workspace.openTextDocument(bibUri);
					await vscode.window.showTextDocument(bibDoc, vscode.ViewColumn.Beside);
				}

				vscode.window.showInformationMessage('Exported to Markdown successfully');
			} catch (err: any) {
				vscode.window.showErrorMessage(`DOCX conversion failed: ${err.message}`);
			}
		})
	);

	// Register Markdown to DOCX export command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.exportToWord', async (uri?: vscode.Uri) => {
			try {
				await exportMdToDocx(context, uri);
			} catch (err: any) {
				vscode.window.showErrorMessage('Export to Word failed: ' + err.message);
			}
		})
	);

	// Register Markdown to DOCX export with template command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.exportToWordWithTemplate', async (uri?: vscode.Uri) => {
			try {
				// Prompt for template file
				const templateFiles = await vscode.window.showOpenDialog({
					filters: { 'Word Documents': ['docx'] },
					canSelectMany: false,
					openLabel: 'Select template'
				});
				if (!templateFiles || templateFiles.length === 0) return;

				const templateData = await vscode.workspace.fs.readFile(templateFiles[0]);
				const templateDocx = new Uint8Array(templateData);
				await exportMdToDocx(context, uri, templateDocx);
			} catch (err: any) {
				vscode.window.showErrorMessage('Export to Word failed: ' + err.message);
			}
		})
	);

	// Create and register word count controller
	const wordCountController = new WordCountController();
	context.subscriptions.push(wordCountController);

	// --- Highlight decorations ---
	// Read and sync default highlight color setting
	function syncDefaultHighlightColor() {
		const cfg = vscode.workspace.getConfiguration('manuscriptMarkdown');
		setDefaultHighlightColor(cfg.get<string>('defaultHighlightColor', 'yellow'));
	}
	syncDefaultHighlightColor();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('manuscriptMarkdown.defaultHighlightColor')) {
				syncDefaultHighlightColor();
				if (vscode.window.activeTextEditor) {
					updateHighlightDecorations(vscode.window.activeTextEditor);
				}
			}
		})
	);

	// Create decoration types for each color + critic
	const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();
	for (const [colorId, colors] of Object.entries(HIGHLIGHT_DECORATION_COLORS)) {
		const decType = vscode.window.createTextEditorDecorationType({
			light: { backgroundColor: colors.light },
			dark: { backgroundColor: colors.dark },
		});
		decorationTypes.set(colorId, decType);
		context.subscriptions.push(decType);
	}
	const criticDecType = vscode.window.createTextEditorDecorationType({
		light: { backgroundColor: CRITIC_COMMENT_DECORATION.light },
		dark: { backgroundColor: CRITIC_COMMENT_DECORATION.dark },
	});
	decorationTypes.set('critic', criticDecType);
	context.subscriptions.push(criticDecType);

	const commentDecType = vscode.window.createTextEditorDecorationType({
		light: { backgroundColor: CRITIC_COMMENT_DECORATION.light, color: new vscode.ThemeColor('descriptionForeground') },
		dark: { backgroundColor: CRITIC_COMMENT_DECORATION.dark, color: new vscode.ThemeColor('descriptionForeground') },
		fontStyle: 'italic',
	});
	context.subscriptions.push(commentDecType);

	const delimiterDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('descriptionForeground'),
	});
	context.subscriptions.push(delimiterDecType);

	const additionDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	});
	context.subscriptions.push(additionDecType);

	const deletionDecType = vscode.window.createTextEditorDecorationType({
		textDecoration: 'line-through',
	});
	context.subscriptions.push(deletionDecType);

	const substitutionNewDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	});
	context.subscriptions.push(substitutionNewDecType);

	function updateHighlightDecorations(editor: vscode.TextEditor) {
		if (editor.document.languageId !== 'markdown') { return; }
		const text = editor.document.getText();
		const defaultColor = getDefaultHighlightColor();
		const rangeMap = extractHighlightRanges(text, defaultColor);

		// Clear all decoration types, then set those with ranges
		for (const [key, decType] of decorationTypes) {
			const ranges = rangeMap.get(key);
			if (ranges && ranges.length > 0) {
				editor.setDecorations(decType, ranges.map(r => new vscode.Range(
					editor.document.positionAt(r.start),
					editor.document.positionAt(r.end)
				)));
			} else {
				editor.setDecorations(decType, []);
			}
		}

		// Apply comment decorations
		const commentRanges = extractCommentRanges(text);
		if (commentRanges.length > 0) {
			editor.setDecorations(commentDecType, commentRanges.map(r => new vscode.Range(
				editor.document.positionAt(r.start),
				editor.document.positionAt(r.end)
			)));
		} else {
			editor.setDecorations(commentDecType, []);
		}

		// Apply addition/deletion content decorations
		const additionRanges = extractAdditionRanges(text);
		editor.setDecorations(additionDecType, additionRanges.map(r => new vscode.Range(
			editor.document.positionAt(r.start),
			editor.document.positionAt(r.end)
		)));

		const deletionRanges = extractDeletionRanges(text);
		editor.setDecorations(deletionDecType, deletionRanges.map(r => new vscode.Range(
			editor.document.positionAt(r.start),
			editor.document.positionAt(r.end)
		)));

		// Apply muted delimiter decorations
		const delimiterRanges = extractCriticDelimiterRanges(text);
		editor.setDecorations(delimiterDecType, delimiterRanges.map(r => new vscode.Range(
			editor.document.positionAt(r.start),
			editor.document.positionAt(r.end)
		)));

		// Apply substitution "new" text decorations
		const subNewRanges = extractSubstitutionNewRanges(text);
		editor.setDecorations(substitutionNewDecType, subNewRanges.map(r => new vscode.Range(
			editor.document.positionAt(r.start),
			editor.document.positionAt(r.end)
		)));
	}
	let highlightDecorationUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleHighlightDecorationsUpdate(editor: vscode.TextEditor) {
		if (highlightDecorationUpdateTimer) {
			clearTimeout(highlightDecorationUpdateTimer);
		}
		highlightDecorationUpdateTimer = setTimeout(() => {
			highlightDecorationUpdateTimer = undefined;
			updateHighlightDecorations(editor);
		}, 150);
	}
	function shouldTriggerLspSuggest(editor: vscode.TextEditor, event: vscode.TextDocumentChangeEvent): boolean {
		if (editor.document.languageId !== 'markdown') {
			return false;
		}
		if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
			return false;
		}
		if (event.contentChanges.length === 0) {
			return false;
		}
		if (!shouldAutoTriggerSuggestFromChanges(event.contentChanges)) {
			return false;
		}
		const text = editor.document.getText();
		const offset = editor.document.offsetAt(editor.selection.active);
		return (
			getCslCompletionContext(text, offset) !== undefined ||
			getCompletionContextAtOffset(text, offset) !== undefined
		);
	}
	function shouldHideSuggestOnCitekeySemicolon(
		editor: vscode.TextEditor,
		event: vscode.TextDocumentChangeEvent
	): boolean {
		if (editor.document.languageId !== 'markdown') {
			return false;
		}
		if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
			return false;
		}
		if (event.contentChanges.length === 0) {
			return false;
		}
		const hasDelimiterChange = event.contentChanges.some(
			change => change.text.includes(';') || change.text === ' '
		);
		if (!hasDelimiterChange) {
			return false;
		}
		const cursor = editor.selection.active;
		const linePrefix = editor.document.lineAt(cursor.line).text.slice(0, cursor.character);
		return /\[[^\]\n]*;\s*$/.test(linePrefix) && linePrefix.includes('@');
	}
	context.subscriptions.push({
		dispose: () => {
			if (highlightDecorationUpdateTimer) {
				clearTimeout(highlightDecorationUpdateTimer);
				highlightDecorationUpdateTimer = undefined;
			}
		}
	});

	// Trigger on editor change
	if (vscode.window.activeTextEditor) {
		updateHighlightDecorations(vscode.window.activeTextEditor);
	}
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) { updateHighlightDecorations(editor); }
		}),
		vscode.workspace.onDidChangeTextDocument(e => {
			const editor = vscode.window.activeTextEditor;
			if (editor && e.document === editor.document) {
				scheduleHighlightDecorationsUpdate(editor);
				if (shouldHideSuggestOnCitekeySemicolon(editor, e)) {
					setTimeout(() => {
						void vscode.commands.executeCommand('hideSuggestWidget');
					}, 10);
					return;
				}
				if (shouldTriggerLspSuggest(editor, e)) {
					void vscode.commands.executeCommand('editor.action.triggerSuggest');
				}
			}
		})
	);

	// Register colored highlight commands
	for (const colorId of VALID_COLOR_IDS) {
		context.subscriptions.push(
			vscode.commands.registerCommand('manuscript-markdown.formatHighlight_' + colorId, () =>
				applyFormatting((text) => formatting.wrapColoredHighlight(text, colorId))
			)
		);
	}

	// Return markdown-it plugin for preview integration
	return {
		extendMarkdownIt(md: any) {
			return md.use(manuscriptMarkdownPlugin);
		}
	};
}
function syncLanguageClient(context: vscode.ExtensionContext): void {
	if (isLanguageServerEnabled()) {
		startLanguageClient(context);
		return;
	}
	void stopLanguageClient();
}

function isLanguageServerEnabled(): boolean {
	return vscode.workspace
		.getConfiguration('manuscriptMarkdown')
		.get<boolean>('enableCitekeyLanguageServer', true);
}

function startLanguageClient(context: vscode.ExtensionContext): void {
	if (languageClient) {
		return;
	}
	const serverModule = context.asAbsolutePath(path.join('out', 'lsp', 'server.js'));
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6010'] },
		},
	};

	const markdownWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
	const bibWatcher = vscode.workspace.createFileSystemWatcher('**/*.bib');
	languageClientDisposables = [markdownWatcher, bibWatcher];

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'markdown' },
			{ scheme: 'untitled', language: 'markdown' },
			{ scheme: 'file', language: 'bibtex' },
			{ scheme: 'untitled', language: 'bibtex' },
			{ scheme: 'file', pattern: '**/*.bib' },
		],
		initializationOptions: getLspSettings(),
		synchronize: {
			fileEvents: [markdownWatcher, bibWatcher],
		},
	};

	languageClient = new LanguageClient(
		'manuscriptMarkdownCitekeys',
		'Manuscript Markdown Language Server',
		serverOptions,
		clientOptions
	);
	void languageClient.start();
}

function getLspSettings(): Record<string, unknown> {
	const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
	return {
		citekeyReferencesFromMarkdown: config.get<boolean>('citekeyReferencesFromMarkdown', false),
		cslCacheDirs: [cslCacheDir],
	};
}

async function stopLanguageClient(): Promise<void> {
	for (const disposable of languageClientDisposables) {
		disposable.dispose();
	}
	languageClientDisposables = [];
	const client = languageClient;
	languageClient = undefined;
	if (client) {
		try {
			await client.stop();
		} catch {
			// no-op
		}
	}
}

/**
 * Helper function to apply formatting to the current selection(s)
 * @param formatter - Function that takes text and returns a TextTransformation
 */
function applyFormatting(formatter: (text: string) => formatting.TextTransformation): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	// Store original selections and their transformations before the edit
	const selectionsData = editor.selections.map(selection => {
		let effectiveSelection = selection;
		
		// If no text is selected (cursor position only), try to expand to word
		if (selection.isEmpty) {
			const wordRange = editor.document.getWordRangeAtPosition(selection.active);
			if (wordRange) {
				effectiveSelection = new vscode.Selection(wordRange.start, wordRange.end);
			}
		}
		
		const text = editor.document.getText(effectiveSelection);
		const transformation = formatter(text);
		return {
			selection: effectiveSelection,
			transformation,
			text
		};
	});

	editor.edit(editBuilder => {
		// Process each selection (supports multi-cursor)
		for (const data of selectionsData) {
			editBuilder.replace(data.selection, data.transformation.newText);
		}
	}).then(success => {
		if (success) {
			// Handle cursor positioning for commands that need it
			const newSelections: vscode.Selection[] = [];
			
			for (const data of selectionsData) {
				if (data.transformation.cursorOffset !== undefined) {
					// Position cursor at the specified offset from the start of the replaced text
					const newPosition = data.selection.start.translate(0, data.transformation.cursorOffset);
					newSelections.push(new vscode.Selection(newPosition, newPosition));
				} else {
					// Keep the default selection behavior (select the newly inserted text)
					const endPosition = data.selection.start.translate(0, data.transformation.newText.length);
					newSelections.push(new vscode.Selection(data.selection.start, endPosition));
				}
			}
			
			// Update selections if we have any cursor positioning
			if (newSelections.length > 0) {
				editor.selections = newSelections;
			}
		}
	});
}

/**
 * Helper function to apply line-based formatting to the current selection(s)
 * Expands selections to include full lines before applying formatting
 * @param formatter - Function that takes text and returns a TextTransformation
 */
function applyLineBasedFormatting(formatter: (text: string) => formatting.TextTransformation): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	editor.edit(editBuilder => {
		// Process each selection (supports multi-cursor)
		for (const selection of editor.selections) {
			// Expand selection to include full lines
			const startLine = selection.start.line;
			const endLine = selection.end.line;
			const fullLineRange = new vscode.Range(
				editor.document.lineAt(startLine).range.start,
				editor.document.lineAt(endLine).range.end
			);
			
			const text = editor.document.getText(fullLineRange);
			const transformation = formatter(text);
			editBuilder.replace(fullLineRange, transformation.newText);
		}
	});
}

/**
 * Helper function to apply table formatting
 * If text is selected: applies to all selected lines
 * If no selection: detects table boundaries by looking for empty lines above and below
 * @param formatter - Function that takes text and returns a TextTransformation
 */
function applyTableFormatting(formatter: (text: string) => formatting.TextTransformation): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	editor.edit(editBuilder => {
		for (const selection of editor.selections) {
			let startLine: number;
			let endLine: number;

			if (selection.isEmpty) {
				// No selection - detect table boundaries
				const cursorLine = selection.active.line;
				
				// Find start of table (look upward for empty line or document start)
				startLine = cursorLine;
				while (startLine > 0) {
					const lineText = editor.document.lineAt(startLine - 1).text.trim();
					if (lineText === '') {
						break;
					}
					startLine--;
				}
				
				// Find end of table (look downward for empty line or document end)
				endLine = cursorLine;
				const lastLine = editor.document.lineCount - 1;
				while (endLine < lastLine) {
					const lineText = editor.document.lineAt(endLine + 1).text.trim();
					if (lineText === '') {
						break;
					}
					endLine++;
				}
			} else {
				// Text is selected - expand to full lines
				startLine = selection.start.line;
				endLine = selection.end.line;
			}

			const fullLineRange = new vscode.Range(
				editor.document.lineAt(startLine).range.start,
				editor.document.lineAt(endLine).range.end
			);
			
			const text = editor.document.getText(fullLineRange);
			const transformation = formatter(text);
			editBuilder.replace(fullLineRange, transformation.newText);
		}
	});
}

interface MdExportInput {
	markdown: string;
	basePath: string;
	bibtex?: string;
}

async function getMdExportInput(uri?: vscode.Uri): Promise<MdExportInput | undefined> {
	let markdown: string;
	let basePath: string;
	if (uri) {
		const data = await vscode.workspace.fs.readFile(uri);
		markdown = new TextDecoder().decode(data);
		basePath = uri.fsPath.replace(/\.md$/i, '');
	} else {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'markdown') {
			vscode.window.showErrorMessage('No active Markdown file');
			return undefined;
		}
		markdown = editor.document.getText();
		basePath = editor.document.uri.fsPath.replace(/\.md$/i, '');
	}

	const mdDir = path.dirname(basePath);
	const { metadata } = parseFrontmatter(markdown);

	let bibtex: string | undefined;
	if (metadata.bibliography) {
		const bibFile = normalizeBibPath(metadata.bibliography);
		const candidates: vscode.Uri[] = [];
		if (path.isAbsolute(bibFile)) {
			const wsFolder = vscode.workspace.workspaceFolders?.[0];
			if (wsFolder) {
				candidates.push(vscode.Uri.file(path.join(wsFolder.uri.fsPath, bibFile)));
			}
			candidates.push(vscode.Uri.file(bibFile));
		} else {
			candidates.push(vscode.Uri.file(path.join(mdDir, bibFile)));
			const wsFolder = vscode.workspace.workspaceFolders?.[0];
			if (wsFolder) {
				candidates.push(vscode.Uri.file(path.join(wsFolder.uri.fsPath, bibFile)));
			}
		}
		for (const c of candidates) {
			if (await fileExists(c)) {
				const data = await vscode.workspace.fs.readFile(c);
				bibtex = new TextDecoder().decode(data);
				break;
			}
		}
		if (!bibtex) {
			// Fallback to default {basePath}.bib
			const defaultBib = vscode.Uri.file(basePath + '.bib');
			if (await fileExists(defaultBib)) {
				const data = await vscode.workspace.fs.readFile(defaultBib);
				bibtex = new TextDecoder().decode(data);
				if (hasCitations(markdown)) {
					vscode.window.showWarningMessage(`Bibliography "${metadata.bibliography}" not found; using ${path.basename(basePath)}.bib`);
				}
			} else if (hasCitations(markdown)) {
				vscode.window.showWarningMessage(`Bibliography "${metadata.bibliography}" not found and no default .bib file exists`);
			}
		}
	} else {
		const bibUri = vscode.Uri.file(basePath + '.bib');
		if (await fileExists(bibUri)) {
			const bibData = await vscode.workspace.fs.readFile(bibUri);
			bibtex = new TextDecoder().decode(bibData);
		}
	}

	return { markdown, basePath, bibtex };
}

async function resolveDocxOutputUri(basePath: string): Promise<vscode.Uri | undefined> {
	let docxUri = vscode.Uri.file(basePath + '.docx');
	const docxExists = await fileExists(docxUri);
	if (!docxExists) {
		return docxUri;
	}

	const name = basePath.split(/[/\\]/).pop()!;
	const choice = await vscode.window.showWarningMessage(
		'\"' + name + '.docx\" already exists. Replace it or save with a new name?',
		{ modal: true },
		'Replace',
		'New Name',
		'Cancel'
	);

	if (!choice || choice === 'Cancel') {
		return undefined;
	}

	if (choice === 'New Name') {
		const selectedUri = await vscode.window.showSaveDialog({
			defaultUri: docxUri,
			filters: { 'Word Documents': ['docx'] },
			saveLabel: 'Choose output file name'
		});
		if (!selectedUri) {
			return undefined;
		}
		docxUri = selectedUri;
	}

	return docxUri;
}

async function exportMdToDocx(context: vscode.ExtensionContext, uri?: vscode.Uri, templateDocx?: Uint8Array): Promise<void> {
	const input = await getMdExportInput(uri);
	if (!input) {
		return;
	}

	// Auto-use existing .docx as style template when no explicit template is provided
	if (!templateDocx) {
		const existingDocxUri = vscode.Uri.file(input.basePath + '.docx');
		if (await fileExists(existingDocxUri)) {
			const data = await vscode.workspace.fs.readFile(existingDocxUri);
			templateDocx = new Uint8Array(data);
		}
	}

	const authorName = author.getAuthorName();
	// basePath has .md stripped, but dirname still yields the parent directory
	const sourceDir = path.dirname(input.basePath);
	const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
	const mixedCitationStyle = config.get<'separate' | 'unified'>('mixedCitationStyle', 'separate');
	const blockquoteStyle = config.get<'Quote' | 'IntenseQuote'>('blockquoteStyle', 'Quote');
	const result = await convertMdToDocx(input.markdown, {
		bibtex: input.bibtex,
		authorName: authorName ?? undefined,
		templateDocx,
		cslCacheDir,
		sourceDir,
		mixedCitationStyle,
		blockquoteStyle,
		onStyleNotFound: async (styleName: string) => {
			const choice = await vscode.window.showWarningMessage(
				`CSL style "${styleName}" is not bundled. Download it from the CSL repository? Without it, citations will use plain-text fallback formatting.`,
				{ modal: true },
				'Download',
				'Skip'
			);
			return choice === 'Download';
		}
	});

	const docxUri = await resolveDocxOutputUri(input.basePath);
	if (!docxUri) {
		return;
	}

	await vscode.workspace.fs.writeFile(docxUri, result.docx);

	const filename = docxUri.fsPath.split(/[/\\]/).pop()!;
	const action = result.warnings.length > 0
		? await vscode.window.showWarningMessage(
			`Exported to "${filename}" with warnings: ${result.warnings.join('; ')}`,
			'Open in Word'
		)
		: await vscode.window.showInformationMessage(
			`Exported to "${filename}"`,
			'Open in Word'
		);
	if (action === 'Open in Word') {
		try {
			const opened = await vscode.env.openExternal(docxUri);
			if (!opened) {
				vscode.window.showErrorMessage('Failed to open file in external application.');
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to open file: ${message}`);
		}
	}
}

export function deactivate(): Thenable<void> | undefined {
	return stopLanguageClient();
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
