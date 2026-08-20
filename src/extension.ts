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
import { manuscriptMarkdownPlugin, type ManuscriptMarkdownIt } from './preview/manuscript-markdown-plugin';
import { WordCountController } from './wordcount';
import { convertDocx, CitationKeyFormat } from './converter';
import { convertMdToDocx } from './md-to-docx';
import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter, hasCitations, normalizeColorScheme, type ColorScheme } from './frontmatter';
import type { EmbedResolver } from './embed-preprocess';
import { BUNDLED_STYLE_LABELS } from './csl-loader';
import { shouldAutoTriggerLspSuggest } from './lsp/auto-suggest';
import {
	getOutputBasePath,
	getOutputConflictMessage,
	getOutputConflictScenario,
	isSymlink,
	getSymlinkConflictMessage,
	getDocxSymlinkConflictMessage,
} from './output-conflicts';
import {
	VALID_COLOR_IDS,
	HIGHLIGHT_DECORATION_COLORS,
	CRITIC_COMMENT_DECORATION,
	extractAllDecorationRanges,
	setDefaultHighlightColor,
	getDefaultHighlightColor,
} from './highlight-colors';
import { setDefaultColorScheme } from './alert-colors';
import { computeCodeRegions, overlapsCodeRegion } from './code-regions';
import {
	bibliographyCandidatePaths,
	resolveBibliographyWritePathForOutput,
	resolveDocumentBibliography,
	resolveDocumentBibliographyPath,
} from './bibliography-paths';
import {
	buildEmbedPathTargetUri,
	buildOpenWorksheetCommandUri,
	findAvailableEmbedSheetRanges,
	findEmbedPathRanges,
} from './embed-link-provider';
import {
	FRONTMATTER_MENU_SETTINGS,
	frontmatterSettingCommand,
	getFrontmatterSettingEdit,
} from './frontmatter-settings';
import { getPostExportAction } from './post-export-action';
import { createZoteroLinkPlan, type ZoteroLinkPlan } from './zotero-link';
import {
	listZoteroGroups,
	fetchZoteroCatalog,
	ZoteroLocalApiError,
	type ZoteroLibraryScope,
} from './zotero-local-api';
import {
	buildUnmatchedBibliography,
	buildZoteroLibraryPickItems,
	describeZoteroLocalApiError,
	formatStaleUnmatchedExportNote,
	formatUnmatchedExportBlockedNote,
	formatUnmatchedExportFailedNote,
	formatUnmatchedExportNote,
	formatZoteroLinkConfirmation,
	formatZoteroLinkNoChanges,
	formatZoteroLinkReport,
	UNMATCHED_EXPORT_MARKER,
	ZOTERO_REMOTE_WORKSPACE_MESSAGE,
} from './zotero-link-ui';

// --- Implementation notes ---
// - Editor decorations: use light/dark sub-properties for theme-aware backgrounds
// - DOCX→MD settings parity: keep alwaysUseCommentIds wired in both CLI and VS Code paths
// - CSL auto-suggest retriggering: trigger only on single-character typing/backspace,
//   not on completion acceptance
// - Citekey auto-suggest retriggering: same gate; retrigger when cursor stays in [@… context
// - Frontmatter auto-suggest: also allow Enter/auto-indent, but trigger only when
//   the cursor context has actual key or generated-value completion items
// - Citekey delimiter UX: dismiss suggest widget on ; (+ space) in grouped citation context
// - setCitationStyle EOL safety: use TextDocument.eol; don't replace trailing \r on CRLF docs
// - TextMate grammar: multi-line patterns are limited; favor correctness in code over
//   attempting perfect highlighting
// - TextMate comment grammar: {>>…<<} uses begin/end (not single-line match) for multi-line
// - TextMate comment-with-ID grammar: {#id>>…<<} uses begin/end with explicit endCaptures
// - CriticMarkup auto-closing pairs: custom autoClosingPairs in language-configuration.json
//   replace (not merge with) built-in pairs; include single-char { → }

let languageClient: LanguageClient | undefined;
let languageClientDisposables: vscode.Disposable[] = [];
let cslCacheDir: string = '';
let previewMd: ManuscriptMarkdownIt | undefined;

// Embed resolver for reading external files referenced by embed directives.
// Shared by both the preview plugin and md-to-docx conversion.
const EMBED_STAT_TTL_MS = 1500; // skip re-stat within this window
const embedCache = new Map<string, { content: Uint8Array; mtime: number; checkedAt: number }>();
const embedResolver: EmbedResolver = {
	readFile(absolutePath: string): Uint8Array | null {
		try {
			const now = Date.now();
			const cached = embedCache.get(absolutePath);
			// Within the TTL window, return cached content without hitting the filesystem.
			if (cached && (now - cached.checkedAt) < EMBED_STAT_TTL_MS) return cached.content;
			const stat = fs.statSync(absolutePath);
			if (cached && cached.mtime === stat.mtimeMs) {
				cached.checkedAt = now;
				return cached.content;
			}
			const content = new Uint8Array(fs.readFileSync(absolutePath));
			embedCache.set(absolutePath, { content, mtime: stat.mtimeMs, checkedAt: now });
			return content;
		} catch {
			return null;
		}
	},
	resolveRelative(basePath: string, relativePath: string): string {
		return path.resolve(path.dirname(basePath), relativePath);
	},
};
function syncPreviewColors(scheme: ColorScheme) {
	if (previewMd) previewMd.manuscriptColors = scheme;
}

/**
 * Three-tier read for .docx files that may be symlinks pointing outside
 * VS Code's sandbox (e.g. OneDrive/SharePoint targets on macOS).
 */
async function readDocxFile(uri: vscode.Uri): Promise<Uint8Array> {
	// Resolve symlinks so we know the real target path
	let realPath: string;
	try {
		realPath = await fs.promises.realpath(uri.fsPath);
	} catch {
		realPath = uri.fsPath;
	}
	const readUri = realPath !== uri.fsPath ? vscode.Uri.file(realPath) : uri;

	// Tier 1: VS Code virtual FS (works for normal files and workspace-accessible paths)
	try {
		return await vscode.workspace.fs.readFile(readUri);
	} catch {
		// Fall through to Tier 2
	}

	// Tier 2: Node fs.promises.readFile (bypasses VS Code's virtual FS layer)
	try {
		const buf = await fs.promises.readFile(realPath);
		// Buffer's backing ArrayBuffer may be larger than the data; create a
		// proper Uint8Array view so downstream consumers get the right slice.
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	} catch {
		// Fall through to Tier 3
	}

	// Tier 3: Ask the user to grant access via file picker (extends macOS sandbox)
	const message = 'Cannot read "' + path.basename(uri.fsPath) + '" \u2014 the symlink target may be outside VS Code\u2019s sandbox. Grant access by selecting the file.';
	const choice = await vscode.window.showWarningMessage(message, 'Select File', 'Cancel');
	if (choice !== 'Select File') {
		throw new Error('File access denied by user');
	}
	const picks = await vscode.window.showOpenDialog({
		// defaultUri only accepts a directory — showOpenDialog cannot pre-select a
		// file. We can't use a native NSOpenPanel (e.g. via osascript) because only
		// VS Code's own dialog grants the sandbox permission token needed to read.
		defaultUri: vscode.Uri.file(path.dirname(realPath)),
		filters: { 'Word Documents': ['docx'] },
		canSelectMany: false,
		openLabel: 'Grant Access',
	});
	if (!picks || picks.length === 0) {
		throw new Error('No file selected');
	}
	return await vscode.workspace.fs.readFile(picks[0]);
}

/**
 * Three-tier write for files whose symlink targets may be outside
 * VS Code's sandbox (mirrors the read tiers in readDocxFile).
 */
async function writeFileThroughSymlink(symlinkUri: vscode.Uri, data: Uint8Array): Promise<void> {
	let realPath: string;
	try {
		realPath = await fs.promises.realpath(symlinkUri.fsPath);
	} catch {
		realPath = symlinkUri.fsPath;
	}

	// Tier 1: VS Code virtual FS (works if target is inside the sandbox)
	const realUri = vscode.Uri.file(realPath);
	try {
		await vscode.workspace.fs.writeFile(realUri, data);
		return;
	} catch {
		// Fall through to Tier 2
	}

	// Tier 2: Node fs.promises.writeFile (bypasses VS Code's virtual FS layer)
	try {
		await fs.promises.writeFile(realPath, data);
		return;
	} catch {
		// Fall through to Tier 3
	}

	// Tier 3: Ask the user to grant access via save dialog (extends macOS sandbox)
	const message = 'Cannot write to "' + path.basename(symlinkUri.fsPath) + '" — the symlink target may be outside VS Code\u2019s sandbox. Grant access by choosing a save location.';
	const choice = await vscode.window.showWarningMessage(message, 'Select Location', 'Cancel');
	if (choice !== 'Select Location') {
		throw new Error('File write access denied by user');
	}
	const picked = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(realPath),
	});
	if (!picked) {
		throw new Error('No save location selected');
	}
	const normalizePath = process.platform === 'win32' || process.platform === 'darwin'
		? (p: string) => p.toLowerCase() : (p: string) => p;
	if (normalizePath(picked.fsPath) !== normalizePath(realPath)) {
		throw new Error('Save location must match the symlink target: ' + realPath);
	}
	await vscode.workspace.fs.writeFile(picked, data);
}

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

	// Register embed directive link provider (Cmd+Click on file paths)
	context.subscriptions.push(
		vscode.languages.registerDocumentLinkProvider(
			{ scheme: 'file', language: 'markdown' },
			{
				provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
					const text = document.getText();
					const ranges = findEmbedPathRanges(text);
					const docDir = path.dirname(document.uri.fsPath);
					const tableViewerAvailable = vscode.extensions.getExtension('jbearak.table-viewer') !== undefined;
					const pathLinks = ranges.map((r) => {
						const range = new vscode.Range(r.line, r.startCol, r.line, r.endCol);
						const absPath = path.resolve(docDir, r.path);
						const workbookUri = vscode.Uri.file(absPath);
						const target = buildEmbedPathTargetUri(
							workbookUri.toString(),
							r.path,
							r.sheet,
							tableViewerAvailable,
						);
						const link = new vscode.DocumentLink(range, vscode.Uri.parse(target));
						link.tooltip = r.sheet && target !== workbookUri.toString()
							? absPath + ' — worksheet ' + r.sheet
							: absPath;
						return link;
					});
					const sheetLinks = findAvailableEmbedSheetRanges(text, tableViewerAvailable).map((r) => {
						const range = new vscode.Range(r.line, r.startCol, r.line, r.endCol);
						const workbookUri = vscode.Uri.file(path.resolve(docDir, r.path));
						const target = buildOpenWorksheetCommandUri(workbookUri.toString(), r.sheetName);
						const link = new vscode.DocumentLink(range, vscode.Uri.parse(target));
						link.tooltip = 'Open worksheet ' + r.sheetName;
						return link;
					});
					return [...pathLinks, ...sheetLinks];
				},
			}
		)
	);

	// Register bib file open/reveal commands (used by hover links)
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.openBibFile', async (filePath: string) => {
			if (typeof filePath !== 'string' || !filePath.trim()) {
				vscode.window.showErrorMessage('No file path provided');
				return;
			}
			const uri = vscode.Uri.file(filePath);
			try {
				await vscode.workspace.fs.stat(uri);
				await vscode.commands.executeCommand('vscode.open', uri);
			} catch {
				vscode.window.showErrorMessage('File not found: ' + filePath);
			}
		}),
		vscode.commands.registerCommand('manuscript-markdown.revealBibFile', async (filePath: string) => {
			if (typeof filePath !== 'string' || !filePath.trim()) {
				vscode.window.showErrorMessage('No file path provided');
				return;
			}
			const uri = vscode.Uri.file(filePath);
			try {
				await vscode.workspace.fs.stat(uri);
				await vscode.commands.executeCommand('revealFileInOS', uri);
			} catch {
				vscode.window.showErrorMessage('File not found: ' + filePath);
			}
		})
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

	// Register Link Bibliography to Zotero command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.linkBibliographyToZotero', () =>
			linkBibliographyToZotero()
		)
	);

	for (const setting of FRONTMATTER_MENU_SETTINGS) {
		context.subscriptions.push(
			vscode.commands.registerCommand(frontmatterSettingCommand(setting.key), async () => {
				const editor = vscode.window.activeTextEditor;
				if (!editor || editor.document.languageId !== 'markdown') {
					vscode.window.showErrorMessage('No active Markdown file');
					return;
				}

				const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
				const edit = getFrontmatterSettingEdit(editor.document.getText(), eol, setting.key);
				if (edit.text) {
					const insertPosition = editor.document.positionAt(edit.offset);
					const applied = await editor.edit(editBuilder => {
						editBuilder.insert(insertPosition, edit.text);
					});
					if (!applied) return;
				}

				const start = editor.document.positionAt(edit.selectionStart);
				const end = editor.document.positionAt(edit.selectionEnd);
				editor.selection = new vscode.Selection(start, end);
				editor.revealRange(new vscode.Range(start, end));
				await vscode.commands.executeCommand('editor.action.triggerSuggest');
			})
		);
	}

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
		),
		vscode.commands.registerCommand('manuscript-markdown.compactTable', () =>
			applyTableFormatting((text) => formatting.compactTable(text))
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
				const data = await readDocxFile(uri);
				const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
				const format = config.get<CitationKeyFormat>('citationKeyFormat', 'authorYearTitle');
				const tableIndentSpaces = config.get<number>('tableIndent', 2);
				const alwaysUseCommentIds = config.get<boolean>('alwaysUseCommentIds', false);
				const pipeTableMaxLineWidth = config.get<number>('pipeTableMaxLineWidth', 120);
				const gridTableMaxLineWidth = config.get<number>('gridTableMaxLineWidth', 120);
				const basePath = uri.fsPath.replace(/\.docx$/i, '');
				const existingMdUri = vscode.Uri.file(basePath + '.md');
				let preferredBibliographyPath: string | undefined;
				let existingBibtex: string | undefined;
				if (await fileExists(existingMdUri)) {
					const existingMarkdown = new TextDecoder().decode(await vscode.workspace.fs.readFile(existingMdUri));
					const { metadata } = parseFrontmatter(existingMarkdown);
					if (metadata.bibliography) {
						const resolved = await readBibliographyFromFrontmatterPath(metadata.bibliography, path.dirname(existingMdUri.fsPath));
						if (resolved) {
							preferredBibliographyPath = metadata.bibliography;
							existingBibtex = resolved.bibtex;
						}
					}
				}
				if (!existingBibtex) {
					// Read existing .bib before conversion so Layer 3 can preserve
					// uncited entries and original ordering. This happens before the
					// conflict dialog, but the cost is a single file read and the
					// .bib content is needed to produce the best conversion result.
					const existingBibUri = vscode.Uri.file(basePath + '.bib');
					existingBibtex = await fileExists(existingBibUri)
						? new TextDecoder().decode(await vscode.workspace.fs.readFile(existingBibUri))
						: undefined;
				}
				const result = await convertDocx(data, format, {
					tableIndent: ' '.repeat(tableIndentSpaces),
					alwaysUseCommentIds,
					existingBibtex,
					preferredBibliographyPath,
					pipeTableMaxLineWidthDefault: pipeTableMaxLineWidth,
					gridTableMaxLineWidthDefault: gridTableMaxLineWidth,
				});
				let mdUri = vscode.Uri.file(basePath + '.md');
				const { metadata: resultMetadata } = parseFrontmatter(result.markdown);
				let bibUri = resultMetadata.bibliography
					? await resolveBibliographyWriteUriForOutput(resultMetadata.bibliography, path.dirname(mdUri.fsPath))
					: vscode.Uri.file(basePath + '.bib');
				const hasBibtex = Boolean(result.bibtex);
				const mdExists = await fileExists(mdUri);
				const bibExists = hasBibtex ? await fileExists(bibUri) : false;
				const mdIsSymlink = await isSymlink(mdUri.fsPath);
				const bibIsSymlink = hasBibtex ? await isSymlink(bibUri.fsPath) : false;
				const mdConflict = mdExists || mdIsSymlink;
				const bibConflict = bibExists || bibIsSymlink;
				const conflictScenario = getOutputConflictScenario(mdConflict, bibConflict);

				let unlinkBeforeWrite = false;
				let writeThrough = false;
				if (conflictScenario) {
					const hasSymlink = mdIsSymlink || bibIsSymlink;

					let choice: string | undefined;
					if (hasSymlink) {
						const symlinkFiles: ('md' | 'bib')[] = [];
						if (mdIsSymlink) symlinkFiles.push('md');
						if (bibIsSymlink) symlinkFiles.push('bib');
						choice = await vscode.window.showWarningMessage(
							getSymlinkConflictMessage(basePath, conflictScenario, symlinkFiles),
							{ modal: true },
							'Replace Target',
							'Replace Symlink',
							'New Name'
						);
					} else {
						choice = await vscode.window.showWarningMessage(
							getOutputConflictMessage(basePath, conflictScenario),
							{ modal: true },
							'Replace',
							'New Name'
						);
					}

					if (!choice) {
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
						bibUri = resultMetadata.bibliography
							? await resolveBibliographyWriteUriForOutput(resultMetadata.bibliography, path.dirname(mdUri.fsPath))
							: vscode.Uri.file(selectedBasePath + '.bib');
					} else if (choice === 'Replace Symlink') {
						unlinkBeforeWrite = true;
					} else if (choice === 'Replace Target') {
						writeThrough = true;
					}
				}

				if (unlinkBeforeWrite) {
					// Only unlink files that are actually symlinks; non-symlink files
					// (e.g. when scenario === 'both' but only one is a symlink) are
					// left in place and overwritten normally.
					if (mdIsSymlink) { await fs.promises.unlink(mdUri.fsPath); }
					if (bibIsSymlink) { await fs.promises.unlink(bibUri.fsPath); }
				}

				const mdData = new TextEncoder().encode(result.markdown);
				if (writeThrough) {
					await writeFileThroughSymlink(mdUri, mdData);
				} else {
					await vscode.workspace.fs.writeFile(mdUri, mdData);
				}
				if (result.bibtex) {
					const bibData = new TextEncoder().encode(result.bibtex);
					if (writeThrough) {
						await writeFileThroughSymlink(bibUri, bibData);
					} else {
						await vscode.workspace.fs.writeFile(bibUri, bibData);
					}
				}

				const mdDoc = await vscode.workspace.openTextDocument(mdUri);
				await vscode.window.showTextDocument(mdDoc);
				if (result.bibtex) {
					const bibDoc = await vscode.workspace.openTextDocument(bibUri);
					await vscode.window.showTextDocument(bibDoc, vscode.ViewColumn.Beside);
				}

				vscode.window.showInformationMessage('Exported to Markdown successfully');
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`DOCX conversion failed: ${message}`);
			}
		})
	);

	// Register Markdown to DOCX export command
	context.subscriptions.push(
		vscode.commands.registerCommand('manuscript-markdown.exportToWord', async (uri?: vscode.Uri) => {
			try {
				await exportMdToDocx(uri);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage('Export to Word failed: ' + message);
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
				await exportMdToDocx(uri, templateDocx);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage('Export to Word failed: ' + message);
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

	// Read and sync default color scheme setting
	function getConfiguredColorScheme(): ColorScheme {
		const cfg = vscode.workspace.getConfiguration('manuscriptMarkdown');
		return normalizeColorScheme(cfg.get<string>('colors') ?? '') ?? 'guttmacher';
	}
	setDefaultColorScheme(getConfiguredColorScheme());
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('manuscriptMarkdown.colors')) {
				const scheme = getConfiguredColorScheme();
				setDefaultColorScheme(scheme);
				syncPreviewColors(scheme);
				vscode.commands.executeCommand('markdown.preview.refresh');
			}
			if (e.affectsConfiguration('manuscriptMarkdown.embedDtaMaxFileSize')) {
				if (previewMd) {
					const maxDtaFileSize = vscode.workspace
						.getConfiguration('manuscriptMarkdown')
						.get<number>('embedDtaMaxFileSize', 10_485_760);
					previewMd.manuscriptEmbedOptions = { maxDtaFileSize };
					vscode.commands.executeCommand('markdown.preview.refresh');
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

	const highlightDelimiterDecType = vscode.window.createTextEditorDecorationType({
		light: { backgroundColor: CRITIC_COMMENT_DECORATION.light },
		dark: { backgroundColor: CRITIC_COMMENT_DECORATION.dark },
	});
	context.subscriptions.push(highlightDelimiterDecType);

	const commentDelimiterDecType = vscode.window.createTextEditorDecorationType({
		light: { backgroundColor: CRITIC_COMMENT_DECORATION.light },
		dark: { backgroundColor: CRITIC_COMMENT_DECORATION.dark },
	});
	context.subscriptions.push(commentDelimiterDecType);

	const additionDelimiterDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	});
	context.subscriptions.push(additionDelimiterDecType);

	const deletionDelimiterDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
	});
	context.subscriptions.push(deletionDelimiterDecType);

	const substitutionDelimiterDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
	});
	context.subscriptions.push(substitutionDelimiterDecType);

	const additionDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	});
	context.subscriptions.push(additionDecType);

	const deletionDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
		textDecoration: 'line-through',
	});
	context.subscriptions.push(deletionDecType);

	const substitutionOldDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
		textDecoration: 'line-through',
	});
	context.subscriptions.push(substitutionOldDecType);

	const substitutionNewDecType = vscode.window.createTextEditorDecorationType({
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	});
	context.subscriptions.push(substitutionNewDecType);

	function updateHighlightDecorations(editor: vscode.TextEditor) {
		if (editor.document.languageId !== 'markdown') { return; }
		const text = editor.document.getText();
		const defaultColor = getDefaultHighlightColor();
		const all = extractAllDecorationRanges(text, defaultColor);

		// Filter out any decoration ranges that fall inside code regions (inline code
		// spans or fenced code blocks). This is done at the call site so that
		// extractAllDecorationRanges remains code-region-agnostic and preserves parity
		// with the standalone extraction functions (extractHighlightRanges, etc.).
		const codeRegions = computeCodeRegions(text);
		if (codeRegions.length > 0) {
			const keep = (r: { start: number; end: number }) =>
				!overlapsCodeRegion(r.start, r.end, codeRegions);
			for (const [key, ranges] of all.highlights) {
				const filtered = ranges.filter(keep);
				if (filtered.length === 0) {
					all.highlights.delete(key);
				} else if (filtered.length !== ranges.length) {
					all.highlights.set(key, filtered);
				}
			}
			all.comments.splice(0, all.comments.length, ...all.comments.filter(keep));
			all.additions.splice(0, all.additions.length, ...all.additions.filter(keep));
			all.deletions.splice(0, all.deletions.length, ...all.deletions.filter(keep));
			all.additionDelimiters.splice(0, all.additionDelimiters.length, ...all.additionDelimiters.filter(keep));
			all.deletionDelimiters.splice(0, all.deletionDelimiters.length, ...all.deletionDelimiters.filter(keep));
			all.substitutionDelimiters.splice(0, all.substitutionDelimiters.length, ...all.substitutionDelimiters.filter(keep));
			all.substitutionOld.splice(0, all.substitutionOld.length, ...all.substitutionOld.filter(keep));
			all.substitutionNew.splice(0, all.substitutionNew.length, ...all.substitutionNew.filter(keep));
			all.highlightDelimiters.splice(0, all.highlightDelimiters.length, ...all.highlightDelimiters.filter(keep));
			all.commentDelimiters.splice(0, all.commentDelimiters.length, ...all.commentDelimiters.filter(keep));
		}

		// Clear all decoration types, then set those with ranges
		for (const [key, decType] of decorationTypes) {
			const ranges = all.highlights.get(key);
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
		if (all.comments.length > 0) {
			editor.setDecorations(commentDecType, all.comments.map(r => new vscode.Range(
				editor.document.positionAt(r.start),
				editor.document.positionAt(r.end)
			)));
		} else {
			editor.setDecorations(commentDecType, []);
		}

		// Apply addition/deletion content decorations
		const toRanges = (arr: Array<{ start: number; end: number }>) =>
			arr.map(r => new vscode.Range(editor.document.positionAt(r.start), editor.document.positionAt(r.end)));

		editor.setDecorations(additionDecType, toRanges(all.additions));
		editor.setDecorations(deletionDecType, toRanges(all.deletions));

		// Apply typed delimiter decorations
		editor.setDecorations(additionDelimiterDecType, toRanges(all.additionDelimiters));
		editor.setDecorations(deletionDelimiterDecType, toRanges(all.deletionDelimiters));
		editor.setDecorations(substitutionDelimiterDecType, toRanges(all.substitutionDelimiters));

		// Apply substitution old/new text decorations
		editor.setDecorations(substitutionOldDecType, toRanges(all.substitutionOld));
		editor.setDecorations(substitutionNewDecType, toRanges(all.substitutionNew));

		// Apply highlight/comment delimiter background decorations
		editor.setDecorations(highlightDelimiterDecType, toRanges(all.highlightDelimiters));
		editor.setDecorations(commentDelimiterDecType, toRanges(all.commentDelimiters));
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
		const text = editor.document.getText();
		const offset = editor.document.offsetAt(editor.selection.active);
		return shouldAutoTriggerLspSuggest({
			enabled: languageClient !== undefined,
			text,
			offset,
			platform: process.platform,
			changes: event.contentChanges,
		});
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
	// Refresh markdown preview when external programs modify .md files on disk
	const previewRefreshWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
	const refreshPreview = () => { vscode.commands.executeCommand('markdown.preview.refresh'); };
	previewRefreshWatcher.onDidChange(refreshPreview);
	previewRefreshWatcher.onDidCreate(refreshPreview);
	previewRefreshWatcher.onDidDelete(refreshPreview);
	context.subscriptions.push(previewRefreshWatcher);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) { updateHighlightDecorations(editor); }
			// Update embed resolver document path for preview preprocessing.
			if (editor?.document.languageId === 'markdown' && previewMd) {
				const hadPath = !!previewMd.manuscriptDocumentPath;
				previewMd.manuscriptDocumentPath = editor.document.uri.fsPath;
				if (!hadPath) {
					vscode.commands.executeCommand('markdown.preview.refresh');
				}
			}
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

	// File watcher to invalidate embed cache
	const embedWatcher = vscode.workspace.createFileSystemWatcher('**/*.{csv,tsv,xlsx,md,dta}');
	embedWatcher.onDidChange(uri => {
		embedCache.delete(uri.fsPath);
		void vscode.commands.executeCommand('markdown.preview.refresh');
	});
	embedWatcher.onDidCreate(uri => {
		embedCache.delete(uri.fsPath);
		void vscode.commands.executeCommand('markdown.preview.refresh');
	});
	embedWatcher.onDidDelete(uri => {
		embedCache.delete(uri.fsPath);
		void vscode.commands.executeCommand('markdown.preview.refresh');
	});
	context.subscriptions.push(embedWatcher);

	// Return markdown-it plugin for preview integration
	return {
		extendMarkdownIt(md: ManuscriptMarkdownIt) {
			previewMd = md;
			md.manuscriptColors = getConfiguredColorScheme();
			md.manuscriptEmbedResolver = embedResolver;
			const maxDtaFileSize = vscode.workspace
				.getConfiguration('manuscriptMarkdown')
				.get<number>('embedDtaMaxFileSize', 10_485_760);
			md.manuscriptEmbedOptions = { maxDtaFileSize };

			// Set initial document path from active editor
			const activeDoc = vscode.window.activeTextEditor?.document;
			if (activeDoc?.languageId === 'markdown') {
				md.manuscriptDocumentPath = activeDoc.uri.fsPath;
			}
			
			// Inject document path resolver for preview preprocessing.
			// VS Code's markdown preview API does not expose the rendered document URI 
			// directly to plugins during initialization, nor is it available on `env` 
			// during the parse phase. We match the source text against all open documents.
			md.manuscriptGetDocumentPath = (src: string): string | undefined => {
				const active = vscode.window.activeTextEditor?.document;
				if (active?.languageId === 'markdown' && active.getText() === src) {
					return active.uri.fsPath;
				}
				for (const doc of vscode.workspace.textDocuments) {
					if (doc.languageId === 'markdown' && doc.getText() === src) {
						return doc.uri.fsPath;
					}
				}
				return undefined;
			};

			// Window-restore race: when VS Code restores both the editor and
			// preview simultaneously, activeTextEditor may not be available
			// when extendMarkdownIt runs, and onDidChangeActiveTextEditor may
			// not fire if the editor is simply restored (not switched).
			// Schedule deferred retries to set the path and refresh.
			if (!md.manuscriptDocumentPath) {
				const tryResolve = () => {
					if (md.manuscriptDocumentPath || previewMd !== md) return;
					const ed = vscode.window.activeTextEditor;
					if (ed?.document.languageId === 'markdown') {
						md.manuscriptDocumentPath = ed.document.uri.fsPath;
						vscode.commands.executeCommand('markdown.preview.refresh');
					}
				};
				setTimeout(tryResolve, 250);
				setTimeout(tryResolve, 1000);
			}

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
	const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
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
	const cslCacheWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(cslCacheDir), '*.csl'));
	const cslWorkspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*.csl');
	languageClientDisposables = [markdownWatcher, bibWatcher, cslCacheWatcher, cslWorkspaceWatcher];

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
			fileEvents: [markdownWatcher, bibWatcher, cslCacheWatcher, cslWorkspaceWatcher],
		},
		markdown: {
			isTrusted: {
				enabledCommands: [
					'manuscript-markdown.openBibFile',
					'manuscript-markdown.revealBibFile',
				],
			},
		},
		middleware: {
			// Only forward documentSymbol requests for .bib files to the LSP server.
			// For Markdown, the server returns null which can interfere with VS Code's
			// built-in Markdown outline/breadcrumb provider.
			provideDocumentSymbols: (document, token, next) => {
				if (document.languageId === 'bibtex' || document.uri.fsPath.endsWith('.bib')) {
					return next(document, token);
				}
				return undefined;
			},
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
	sourceUri: vscode.Uri;
	bibtex?: string;
}

function workspaceRootPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function readBibliographyFromFrontmatterPath(bibliography: string, mdDir: string): Promise<{ uri: vscode.Uri; bibtex: string } | undefined> {
	for (const candidatePath of bibliographyCandidatePaths(bibliography, mdDir, workspaceRootPath())) {
		const candidate = vscode.Uri.file(candidatePath);
		if (await fileExists(candidate)) {
			const data = await vscode.workspace.fs.readFile(candidate);
			return {
				uri: candidate,
				bibtex: new TextDecoder().decode(data),
			};
		}
	}
	return undefined;
}

async function resolveBibliographyWriteUriForOutput(bibliography: string, mdDir: string): Promise<vscode.Uri> {
	return vscode.Uri.file(await resolveBibliographyWritePathForOutput(
		bibliography,
		mdDir,
		async (candidatePath) => fileExists(vscode.Uri.file(candidatePath)),
		workspaceRootPath(),
	));
}

async function getMdExportInput(uri?: vscode.Uri): Promise<MdExportInput | undefined> {
	let markdown: string;
	let sourceUri: vscode.Uri;
	if (uri && uri.scheme !== 'webview-panel') {
		sourceUri = uri;
		const openDoc = vscode.workspace.textDocuments.find(
			doc => doc.uri.toString() === uri.toString()
		);
		if (openDoc) {
			markdown = openDoc.getText();
		} else {
			const data = await vscode.workspace.fs.readFile(uri);
			markdown = new TextDecoder().decode(data);
		}
	} else {
		// Try active text editor, then visible editors, then the active preview tab
		const editor = vscode.window.activeTextEditor?.document.languageId === 'markdown'
			? vscode.window.activeTextEditor
			: vscode.window.visibleTextEditors.find(e => e.document.languageId === 'markdown');
		if (editor) {
			markdown = editor.document.getText();
			sourceUri = editor.document.uri;
		} else {
			// Full-screen preview: no visible editor, find the markdown document
			const mdDoc = vscode.workspace.textDocuments.find(
				d => d.languageId === 'markdown' && d.uri.scheme === 'file'
			);
			if (!mdDoc) {
				vscode.window.showErrorMessage('No active Markdown file');
				return undefined;
			}
			markdown = mdDoc.getText();
			sourceUri = mdDoc.uri;
		}
	}

	const basePath = getOutputBasePath(sourceUri.fsPath);
	const mdDir = path.dirname(basePath);
	const { metadata } = parseFrontmatter(markdown);

	let bibtex: string | undefined;
	const resolved = await resolveDocumentBibliography(
		metadata.bibliography,
		basePath,
		async candidatePath => fileExists(vscode.Uri.file(candidatePath)),
		workspaceRootPath()
	);
	if (resolved) {
		const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved.path));
		bibtex = new TextDecoder().decode(data);
	}
	// A missing *configured* bibliography is worth a warning, but only when
	// the document actually cites anything; the frontmatter-less fallback
	// missing is the ordinary no-bibliography case and stays silent.
	if (metadata.bibliography && resolved?.source !== 'configured' && hasCitations(markdown)) {
		vscode.window.showWarningMessage(
			resolved
				? `Bibliography "${metadata.bibliography}" not found; using ${path.basename(basePath)}.bib`
				: `Bibliography "${metadata.bibliography}" not found and no default .bib file exists`
		);
	}

	return { markdown, basePath, sourceUri, bibtex };
}

interface DocxOutputCandidate {
	basePath: string;
	uri: vscode.Uri;
}

interface DocxOutputResolution {
	uri: vscode.Uri;
	unlinkSymlink: boolean;
	writeThrough: boolean;
}

function docxUriForSource(sourceUri: vscode.Uri): vscode.Uri {
	if (sourceUri.scheme === 'file' || sourceUri.scheme === 'vscode-remote') {
		return sourceUri.with({
			path: getOutputBasePath(sourceUri.path) + '.docx',
			query: '',
			fragment: '',
		});
	}
	return vscode.Uri.file(getOutputBasePath(sourceUri.fsPath) + '.docx');
}

async function resolveDocxOutputUri(
	candidate: DocxOutputCandidate
): Promise<DocxOutputResolution | undefined> {
	const { basePath } = candidate;
	let docxUri = candidate.uri;
	const docxExists = await fileExists(docxUri);
	const docxIsSymlink = await isSymlink(docxUri.fsPath);
	if (!docxExists && !docxIsSymlink) {
		return { uri: docxUri, unlinkSymlink: false, writeThrough: false };
	}

	let choice: string | undefined;
	if (docxIsSymlink) {
		choice = await vscode.window.showWarningMessage(
			getDocxSymlinkConflictMessage(basePath),
			{ modal: true },
			'Replace Target',
			'Replace Symlink',
			'New Name'
		);
	} else {
		const name = basePath.split(/[/\\]/).pop()!;
		choice = await vscode.window.showWarningMessage(
			'"' + name + '.docx" already exists. Replace it or save with a new name?',
			{ modal: true },
			'Replace',
			'New Name'
		);
	}

	if (!choice) {
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
		return { uri: docxUri, unlinkSymlink: false, writeThrough: false };
	}

	if (choice === 'Replace Symlink') {
		return { uri: docxUri, unlinkSymlink: true, writeThrough: false };
	}

	if (choice === 'Replace Target') {
		return { uri: docxUri, unlinkSymlink: false, writeThrough: true };
	}

	// 'Replace' (non-symlink case)
	return { uri: docxUri, unlinkSymlink: false, writeThrough: false };
}

async function exportMdToDocx(uri?: vscode.Uri, templateDocx?: Uint8Array): Promise<void> {
	const input = await getMdExportInput(uri);
	if (!input) {
		return;
	}

	const initialDocxUri = docxUriForSource(input.sourceUri);
	const initialDocxExists = await fileExists(initialDocxUri);

	// Auto-use existing .docx as style template when no explicit template is provided
	if (!templateDocx && initialDocxExists) {
		try {
			templateDocx = new Uint8Array(await readDocxFile(initialDocxUri));
		} catch {
			// readDocxFile failed (user cancelled the sandbox dialog, or IO error) — abort export
			return;
		}
	}

	const authorName = author.getAuthorName();
	// basePath has .md stripped, but dirname still yields the parent directory
	const sourceDir = path.dirname(input.basePath);
	const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
	const blockquoteStyle = config.get<'Quote' | 'IntenseQuote' | 'GitHub'>('blockquoteStyle', 'GitHub');
	const colors = normalizeColorScheme(config.get<string>('colors') ?? '') ?? 'guttmacher';
	const maxDtaFileSize = config.get<number>('embedDtaMaxFileSize', 10_485_760);
	const result = await convertMdToDocx(input.markdown, {
		bibtex: input.bibtex,
		authorName: authorName ?? undefined,
		templateDocx,
		cslCacheDir,
		sourceDir,
		blockquoteStyle,
		colors,
		documentPath: input.basePath + '.md',
		embedResolver,
		maxDtaFileSize,
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

	const docxOutput = await resolveDocxOutputUri({
		basePath: input.basePath,
		uri: initialDocxUri,
	});
	if (!docxOutput) {
		return;
	}

	if (docxOutput.unlinkSymlink) {
		const stat = await fs.promises.lstat(docxOutput.uri.fsPath);
		if (!stat.isSymbolicLink()) {
			throw new Error('Expected symlink but found regular file: ' + docxOutput.uri.fsPath);
		}
		await fs.promises.unlink(docxOutput.uri.fsPath);
	}

	if (docxOutput.writeThrough) {
		await writeFileThroughSymlink(docxOutput.uri, result.docx);
	} else {
		await vscode.workspace.fs.writeFile(docxOutput.uri, result.docx);
	}
	const docxUri = docxOutput.uri;

	await showPostExportNotification(docxUri, result.warnings);
}

async function showPostExportNotification(docxUri: vscode.Uri, warnings: string[]): Promise<void> {
	const filename = path.basename(docxUri.fsPath);
	const postExportAction = getPostExportAction(
		vscode.env.remoteName,
		vscode.workspace.getWorkspaceFolder(docxUri) !== undefined
	);
	const action = warnings.length > 0
		? await vscode.window.showWarningMessage(
			`Exported to "${filename}" with warnings: ${warnings.join('; ')}`,
			postExportAction.label
		)
		: await vscode.window.showInformationMessage(
			`Exported to "${filename}".`,
			postExportAction.label
		);
	if (action !== postExportAction.label) {
		return;
	}

	switch (postExportAction.kind) {
		case 'revealInExplorer':
			try {
				await vscode.commands.executeCommand('revealInExplorer', docxUri);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				try {
					await vscode.env.clipboard.writeText(docxUri.fsPath);
					vscode.window.showErrorMessage(
						`Failed to show exported file in Explorer: ${message}. The file path was copied instead.`
					);
				} catch (clipboardErr: unknown) {
					const clipboardMessage = clipboardErr instanceof Error
						? clipboardErr.message
						: String(clipboardErr);
					vscode.window.showErrorMessage(
						`Failed to show exported file in Explorer: ${message}. Failed to copy its path: ${clipboardMessage}`
					);
				}
			}
			return;
		case 'copyPath':
			await vscode.env.clipboard.writeText(docxUri.fsPath);
			return;
		case 'openExternal':
			await vscode.commands.executeCommand('manuscript-markdown.openInWord', docxUri);
			return;
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

// --- Link Bibliography to Zotero ---

let zoteroLinkOutputChannel: vscode.OutputChannel | undefined;

function getZoteroLinkOutputChannel(): vscode.OutputChannel {
	zoteroLinkOutputChannel ??= vscode.window.createOutputChannel('Manuscript Markdown: Zotero');
	return zoteroLinkOutputChannel;
}

/** The bibliography this command operates on: the active .bib file, or the
 *  active Markdown file's frontmatter bibliography (falling back to
 *  `{basePath}.bib`, mirroring export). */
async function resolveZoteroLinkBibliography(): Promise<vscode.Uri | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (
		active !== undefined &&
		active.uri.scheme === 'file' &&
		active.uri.fsPath.toLowerCase().endsWith('.bib')
	) {
		return active.uri;
	}

	// Same tiers as export's getMdExportInput: active editor, any visible
	// Markdown editor, then any open Markdown document — the last covers a
	// full-screen preview, whose source document is open but not visible.
	const mdDoc =
		active !== undefined && active.languageId === 'markdown' && active.uri.scheme === 'file'
			? active
			: (vscode.window.visibleTextEditors.find(
				e => e.document.languageId === 'markdown' && e.document.uri.scheme === 'file'
			)?.document ??
			vscode.workspace.textDocuments.find(
				d => d.languageId === 'markdown' && d.uri.scheme === 'file'
			));
	if (!mdDoc) {
		vscode.window.showErrorMessage(
			'Open the Markdown manuscript or its .bib file, then run this command again.'
		);
		return undefined;
	}

	const basePath = getOutputBasePath(mdDoc.uri.fsPath);
	const { metadata } = parseFrontmatter(mdDoc.getText());
	const resolved = await resolveDocumentBibliographyPath(
		metadata.bibliography,
		basePath,
		async candidatePath => fileExists(vscode.Uri.file(candidatePath)),
		workspaceRootPath()
	);
	if (resolved !== undefined) {
		return vscode.Uri.file(resolved);
	}
	vscode.window.showErrorMessage(
		metadata.bibliography
			? `Bibliography "${metadata.bibliography}" not found`
			: `No bibliography found for "${path.basename(mdDoc.uri.fsPath)}" — add a "bibliography:" entry to its frontmatter or create ${path.basename(basePath)}.bib`
	);
	return undefined;
}

async function linkBibliographyToZotero(): Promise<void> {
	// The extension host runs next to the workspace; in a remote workspace
	// "localhost" is the remote machine, not the desktop running Zotero.
	if (vscode.env.remoteName !== undefined) {
		vscode.window.showErrorMessage(ZOTERO_REMOTE_WORKSPACE_MESSAGE);
		return;
	}

	const bibUri = await resolveZoteroLinkBibliography();
	if (!bibUri) {
		return;
	}

	// The plan is computed from the file's bytes and written back as bytes, so
	// unsaved editor changes would be silently reverted by the write.
	const openBibDoc = vscode.workspace.textDocuments.find(
		d => d.uri.toString() === bibUri.toString()
	);
	if (openBibDoc?.isDirty) {
		vscode.window.showErrorMessage(
			`"${path.basename(bibUri.fsPath)}" has unsaved changes. Save it, then run this command again.`
		);
		return;
	}

	try {
		const groups = await listZoteroGroups();
		const picked = await vscode.window.showQuickPick(buildZoteroLibraryPickItems(groups), {
			placeHolder: 'Select the Zotero library to link against',
			title: 'Link Bibliography to Zotero',
		});
		if (!picked) {
			return;
		}
		await linkBibliographyToLibrary(bibUri, picked.scope, picked.label);
	} catch (err: unknown) {
		showZoteroLinkError(err);
	}
}

async function linkBibliographyToLibrary(
	bibUri: vscode.Uri,
	scope: ZoteroLibraryScope,
	libraryLabel: string
): Promise<void> {
	const bibName = path.basename(bibUri.fsPath);
	const bibBytes = await vscode.workspace.fs.readFile(bibUri);
	const bibText = new TextDecoder().decode(bibBytes);
	// The whole file is decoded, planned over, and re-encoded, so the write is
	// byte-surgical only if decode∘encode is the identity on this file.  A BOM
	// or a non-UTF-8 byte breaks that — the decoder strips or replaces it, and
	// the write would silently rewrite bytes far from any added field.
	if (!bytesEqual(new TextEncoder().encode(bibText), bibBytes)) {
		vscode.window.showErrorMessage(
			`"${bibName}" is not plain UTF-8 (it has a byte-order mark or bytes in another encoding), ` +
			'so this command cannot edit it without changing unrelated bytes. Nothing was changed.'
		);
		return;
	}

	const catalog = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Fetching "${libraryLabel}" from Zotero…`,
			cancellable: true,
		},
		(_progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			return fetchZoteroCatalog(scope, { signal: controller.signal });
		}
	);

	const plan = createZoteroLinkPlan(bibText, catalog);
	if (plan.blocked === 'unparsable-bibliography') {
		vscode.window.showErrorMessage(
			`Could not safely parse "${bibName}", so nothing was changed. ` +
			'Check the file for unbalanced braces or a stray @.'
		);
		return;
	}

	// The plan's byte offsets are only valid against the exact text it saw,
	// and both the .bib write and the unmatched export are derived from that
	// snapshot — so every path that writes anything rechecks the file first.
	// A write beneath a dirty buffer would also be undone by its next save.
	const bibliographyChanged = async (): Promise<boolean> => {
		const openBibDoc = vscode.workspace.textDocuments.find(
			d => d.uri.toString() === bibUri.toString()
		);
		const currentBytes = await vscode.workspace.fs.readFile(bibUri);
		return openBibDoc?.isDirty === true || !bytesEqual(currentBytes, bibBytes);
	};

	// The completion postlude, shared by the no-changes and written branches.
	// The report is written to the channel only once the run's outcome is
	// known: its header says "linked N", which must not outlive a cancelled
	// confirmation or a failed write as a false record of success.  The
	// unmatched export is best-effort: by this point any links are already
	// committed, so its failures become notes, never a command failure.
	const summary = plan.summary;
	const finish = async (message: string): Promise<void> => {
		const channel = getZoteroLinkOutputChannel();
		channel.appendLine(formatZoteroLinkReport(plan.decisions, libraryLabel));
		channel.appendLine('');
		const exported = await writeUnmatchedBibliography(bibUri, bibText, plan.decisions, libraryLabel);
		let note: string;
		switch (exported.kind) {
			case 'none':
				note = '';
				break;
			case 'written':
				note = formatUnmatchedExportNote(summary.unmatched, path.basename(exported.uri.fsPath));
				break;
			case 'blocked':
				note = formatUnmatchedExportBlockedNote(summary.unmatched, exported.filename);
				break;
			case 'write-failed':
				note = formatUnmatchedExportFailedNote(summary.unmatched, exported.filename);
				break;
			case 'stale-left':
				note = formatStaleUnmatchedExportNote(exported.filename);
				break;
		}
		await showZoteroLinkResult(
			message + note,
			exported.kind === 'written' ? exported.uri : undefined
		);
	};

	if (!plan.changed) {
		if (await bibliographyChanged()) {
			vscode.window.showErrorMessage(
				`"${bibName}" changed while the command was running, so nothing was written. Run it again.`
			);
			return;
		}
		await finish(formatZoteroLinkNoChanges(summary, bibName));
		return;
	}

	const confirmation = formatZoteroLinkConfirmation(summary, scope);
	const choice = await vscode.window.showInformationMessage(
		confirmation.message,
		{ modal: true, detail: confirmation.detail },
		'Add Links'
	);
	if (choice !== 'Add Links') {
		return;
	}

	if (await bibliographyChanged()) {
		vscode.window.showErrorMessage(
			`"${bibName}" changed while the command was running, so nothing was written. Run it again.`
		);
		return;
	}
	// The .bib may be a symlink whose target sits outside VS Code's sandbox;
	// use the same tiered write as export so the link is written through, not
	// replaced by a regular file.
	await writeFileThroughSymlink(bibUri, new TextEncoder().encode(plan.updatedText));

	await finish(`Linked ${summary.updates} of ${summary.totalEntries} entries in "${bibName}" to Zotero.`);
}

/** What became of the unmatched export beside the bibliography. */
type UnmatchedExportOutcome =
	| { readonly kind: 'none' }
	| { readonly kind: 'written'; readonly uri: vscode.Uri }
	| { readonly kind: 'blocked'; readonly filename: string }
	| { readonly kind: 'write-failed'; readonly filename: string }
	| { readonly kind: 'stale-left'; readonly filename: string };

/** Write `<name>-unmatched.bib` beside the bibliography so the user can
 *  import the leftover entries into Zotero and run the command again.  The
 *  file is regenerated on every run and removed once nothing is unmatched,
 *  so a stale copy never misleads a second round trip.
 *
 *  The sidecar's path is predictable, so a file already sitting there is
 *  replaced or deleted only when it is provably this command's own output:
 *  it starts with the generated marker and has no unsaved edits.  Anything
 *  else is the user's file — left untouched and reported as `blocked` (or
 *  silently kept when there is nothing to export). */
async function writeUnmatchedBibliography(
	bibUri: vscode.Uri,
	bibText: string,
	decisions: ZoteroLinkPlan['decisions'],
	libraryLabel: string
): Promise<UnmatchedExportOutcome> {
	const unmatchedUri = vscode.Uri.file(
		bibUri.fsPath.replace(/\.bib$/i, '') + '-unmatched.bib'
	);
	const filename = path.basename(unmatchedUri.fsPath);
	const content = buildUnmatchedBibliography(bibText, decisions, libraryLabel);

	const openDoc = vscode.workspace.textDocuments.find(
		d => d.uri.toString() === unmatchedUri.toString()
	);
	let existing: 'absent' | 'ours' | 'foreign';
	try {
		const bytes = await vscode.workspace.fs.readFile(unmatchedUri);
		const isOurs = new TextDecoder().decode(bytes).startsWith(UNMATCHED_EXPORT_MARKER);
		existing = isOurs && openDoc?.isDirty !== true ? 'ours' : 'foreign';
	} catch {
		// Unreadable is not the same as absent: a file that exists but cannot
		// be read cannot be proven ours, so it must not be overwritten.
		existing = (await fileExists(unmatchedUri)) ? 'foreign' : 'absent';
	}

	if (content === undefined) {
		if (existing === 'ours') {
			try {
				await vscode.workspace.fs.delete(unmatchedUri);
			} catch {
				// The stale export could not be removed; without a note it
				// would read as this run's current output.
				return { kind: 'stale-left', filename };
			}
		}
		// 'foreign' here is the user's own file (or one they edited), not
		// stale output — leave it alone without comment.
		return { kind: 'none' };
	}

	if (existing === 'foreign') {
		return { kind: 'blocked', filename };
	}
	try {
		// Same tiered write as the bibliography itself: the sidecar may sit
		// beside a symlinked .bib whose directory is outside the sandbox.
		await writeFileThroughSymlink(unmatchedUri, new TextEncoder().encode(content));
	} catch {
		return { kind: 'write-failed', filename };
	}
	return { kind: 'written', uri: unmatchedUri };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** A completion notification with a "Show Details" action that opens the
 *  per-entry report in the output channel, plus an "Open Unmatched" action
 *  when an unmatched export was written. */
async function showZoteroLinkResult(message: string, unmatchedUri?: vscode.Uri): Promise<void> {
	const actions = unmatchedUri ? ['Open Unmatched', 'Show Details'] : ['Show Details'];
	const action = await vscode.window.showInformationMessage(message, ...actions);
	if (action === 'Show Details') {
		getZoteroLinkOutputChannel().show();
	} else if (action === 'Open Unmatched' && unmatchedUri) {
		await vscode.commands.executeCommand('vscode.open', unmatchedUri);
	}
}

function showZoteroLinkError(err: unknown): void {
	if (err instanceof ZoteroLocalApiError) {
		if (err.kind === 'aborted') {
			// The user pressed Cancel on the progress notification.
			return;
		}
		if (err.kind === 'request-failed') {
			getZoteroLinkOutputChannel().appendLine('Zotero request failed: ' + err.message);
		}
		vscode.window.showErrorMessage(describeZoteroLocalApiError(err.kind));
		return;
	}
	const message = err instanceof Error ? err.message : String(err);
	vscode.window.showErrorMessage('Link Bibliography to Zotero failed: ' + message);
}
