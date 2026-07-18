import { promises as fsp } from 'fs';
import * as path from 'path';
import { computeCodeRegions, overlapsCodeRegion } from '../code-regions';
import { scanOrientationDirectives } from '../orientation-scan';
import { parseEmbedDirective } from '../embed-preprocess';
import {
	CompletionItem,
	CompletionItemKind,
	CompletionList,
	CompletionParams,
	createConnection,
	DefinitionParams,
	Diagnostic,
	DiagnosticSeverity,
	DidChangeWatchedFilesParams,
	DocumentSymbol,
	DocumentSymbolParams,
	Hover,
	HoverParams,
	InitializeParams,
	Location,
	MarkupKind,
	Position,
	ProposedFeatures,
	Range,
	ReferenceParams,
	SymbolKind,
	TextDocumentSyncKind,
	TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BibtexEntry } from '../bibtex-parser';

// --- Implementation notes ---
// - References from markdown — intentional asymmetry: return only .bib declaration
//   from .md (VS Code built-in finds @citekey occurrences); return full set from .bib.
//   Do not "fix" this; users can enable manuscriptMarkdown.citekeyReferencesFromMarkdown
// - References dedupe: by canonical filesystem path (realpath + normalized case) plus
//   range, not raw URI
// - References request coalescing: coalesce near-identical back-to-back requests
//   differing only by includeDeclaration
// - Completion triggers: keep triggerCharacters narrow (@, :); broad triggers cause
//   noisy popups

import {
	canonicalizeFsPath,
	canonicalizeFsPathAsync,
	ParsedBibData,
	fileEntryDisplayName,
	findBibFieldLinkAtLine,
	findBibFileFieldAtLine,
	findBibKeyAtOffset,
	findCitekeyAtOffset,
	findUsagesForKey,
	formatFileEntryMarkdown,
	fsPathToUri,
	getAccessLinksForEntry,
	getFileEntriesForEntry,
	resolveFileEntryPath,
	getCompletionContextAtOffset,
	invalidateCanonicalCache,
	parseBibDataFromText,
	resolveBibliographyPathAsync,
	scanCitationUsages,
	uriToFsPath,
} from './citekey-language';
import {
	findCommentIdAtOffset,
	findRangeTextForId,
	stripCriticMarkup,
} from './comment-language';
import { computeBibEntryRanges } from './bib-entry-ranges';
import { type Frontmatter, parseFrontmatter, maskFrontmatter } from '../frontmatter';
import { formatTableNumbers, validateTableNumberFormat } from '../table-number-format';
import { preprocessGridTablesWithSourceMap } from '../grid-table-preprocess';
import { BUNDLED_STYLE_LABELS, isCslAvailableAsync } from '../csl-loader';
import {
	getFrontmatterLocation,
	getFrontmatterCompletionItems,
	getFrontmatterHover,
	validateFrontmatter as validateFrontmatterFields,
} from './frontmatter-language';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let workspaceRootPaths: string[] = [];

interface CachedBibData extends ParsedBibData {
	mtimeMs: number;
	size: number;
}

interface ResolvedSymbol {
	key: string;
	source: 'markdown' | 'bib';
	sourceUri: string;
	bibPath?: string;
}

const bibCache = new Map<string, CachedBibData>();

/** Per-source diagnostic maps so validators don't overwrite each other. */
const citekeyDiagnostics = new Map<string, Diagnostic[]>();
const frontmatterDiagnostics = new Map<string, Diagnostic[]>();
const orientationDiagnostics = new Map<string, Diagnostic[]>();
const embedDiagnostics = new Map<string, Diagnostic[]>();
const tableNumberDiagnostics = new Map<string, Diagnostic[]>();

const severityMap: Record<string, DiagnosticSeverity> = {
	'error': DiagnosticSeverity.Error,
	'warning': DiagnosticSeverity.Warning,
	'information': DiagnosticSeverity.Information,
};

function publishDiagnostics(uri: string): void {
	const citekey = citekeyDiagnostics.get(uri) ?? [];
	const frontmatter = frontmatterDiagnostics.get(uri) ?? [];
	const orientation = orientationDiagnostics.get(uri) ?? [];
	const embed = embedDiagnostics.get(uri) ?? [];
	const tableNumbers = tableNumberDiagnostics.get(uri) ?? [];
	connection.sendDiagnostics({ uri, diagnostics: [...citekey, ...frontmatter, ...orientation, ...embed, ...tableNumbers] });
}

interface OpenDocBibCache {
	version: number;
	data: ParsedBibData;
}
const openDocBibCache = new Map<string, OpenDocBibCache>();

// canonical bib path → set of markdown doc URIs
const bibReverseMap = new Map<string, Set<string>>();
// markdown doc URI → canonical bib path
const docToBibMap = new Map<string, string>();

// --- Debounced validation infrastructure ---
const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VALIDATION_DEBOUNCE_MS = 300;

function scheduleValidation(uri: string): void {
	const existing = validationTimers.get(uri);
	if (existing) clearTimeout(existing);
	validationTimers.set(uri, setTimeout(() => {
		validationTimers.delete(uri);
		const doc = documents.get(uri);
		if (doc) {
			runValidationPipeline(doc).catch(e =>
				connection.console.error(`Scheduled validation error for ${uri}: ${e instanceof Error ? e.message : String(e)}`)
			);
		}
	}, VALIDATION_DEBOUNCE_MS));
}

/** Run all validation steps with a single shared frontmatter parse. */
async function runValidationPipeline(doc: TextDocument): Promise<void> {
	try {
		const text = doc.getText();
		const { metadata } = parseFrontmatter(text);
		await updateBibReverseMap(doc.uri, text, metadata);
		await validateCitekeys(doc, metadata);
		await validateFrontmatterDiags(doc);
		validateOrientationDirectives(doc);
		validateTableNumbers(doc);
		await validateEmbedDirectives(doc);
	} catch (error) {
		connection.console.error(
			`Validation pipeline error for ${doc.uri}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
		);
	}
}

async function updateBibReverseMap(docUri: string, docText: string, metadata?: Frontmatter): Promise<void> {
	try {
		const bibPath = await resolveBibliographyPathAsync(docUri, docText, workspaceRootPaths, metadata);
		removeBibReverseMapEntry(docUri);
		if (bibPath) {
			const canonical = await canonicalizeFsPathAsync(bibPath);
			if (!bibReverseMap.has(canonical)) {
				bibReverseMap.set(canonical, new Set());
			}
			bibReverseMap.get(canonical)!.add(docUri);
			docToBibMap.set(docUri, canonical);
		}
	} catch (error) {
		connection.console.error(
			`Error updating bibliography reverse map for ${docUri}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
		);
	}
}

function removeBibReverseMapEntry(docUri: string): void {
  const canonical = docToBibMap.get(docUri);
  if (!canonical) {
    return;
  }
  docToBibMap.delete(docUri);
  const uris = bibReverseMap.get(canonical);
  if (!uris) {
    return;
  }
  uris.delete(docUri);
  if (uris.size === 0) {
    bibReverseMap.delete(canonical);
  }
}

function getMarkdownUrisForBib(canonicalBibPath: string): Set<string> {
  return bibReverseMap.get(canonicalBibPath) ?? new Set();
}

/** Client-provided settings (see `getLspSettings()` in extension.ts). */
interface LspSettings {
	citekeyReferencesFromMarkdown?: boolean;
	cslCacheDirs?: string[];
}
let settings: LspSettings = {};

connection.onInitialize((params: InitializeParams) => {
	workspaceRootPaths = extractWorkspaceRoots(params);
	if (params.initializationOptions) {
		settings = params.initializationOptions as LspSettings;
	}

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				triggerCharacters: ['@', ':'],
			},
			definitionProvider: true,
			documentSymbolProvider: true,
			hoverProvider: true,
			referencesProvider: true,
		},
	};
});

connection.onDidChangeConfiguration((params) => {
	if (params.settings) {
		settings = params.settings as LspSettings;
	}
});

documents.onDidOpen((event) => {
	if (isMarkdownUri(event.document.uri, event.document.languageId)) {
		runValidationPipeline(event.document).catch(e =>
			connection.console.error(`Validation error on open for ${event.document.uri}: ${e instanceof Error ? e.message : String(e)}`)
		);
	}
});

documents.onDidChangeContent((event) => {
	if (isBibUri(event.document.uri)) {
		invalidateBibCache(event.document.uri);
		const fsPath = uriToFsPath(event.document.uri);
		if (fsPath) {
			invalidateCanonicalCache(fsPath);
			revalidateMarkdownDocsForBib(fsPath).catch(e =>
				connection.console.error(`revalidateMarkdownDocsForBib error: ${e instanceof Error ? e.message : String(e)}`)
			);
		}
	}
	if (isMarkdownUri(event.document.uri, event.document.languageId)) {
		scheduleValidation(event.document.uri);
	}
});

documents.onDidClose((event) => {
	if (isBibUri(event.document.uri)) {
		invalidateBibCache(event.document.uri);
		const fsPath = uriToFsPath(event.document.uri);
		if (fsPath) {
			revalidateMarkdownDocsForBib(fsPath).catch(e =>
				connection.console.error(`revalidateMarkdownDocsForBib error: ${e instanceof Error ? e.message : String(e)}`)
			);
		}
	}
	if (isMarkdownUri(event.document.uri, event.document.languageId)) {
		const pending = validationTimers.get(event.document.uri);
		if (pending) {
			clearTimeout(pending);
			validationTimers.delete(event.document.uri);
		}
		removeBibReverseMapEntry(event.document.uri);
		citekeyDiagnostics.delete(event.document.uri);
		frontmatterDiagnostics.delete(event.document.uri);
		orientationDiagnostics.delete(event.document.uri);
		embedDiagnostics.delete(event.document.uri);
		connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
	}
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
	let cslChanged = false;
	let bibChanged = false;
	for (const change of params.changes) {
		if (isBibUri(change.uri)) {
			bibChanged = true;
			invalidateBibCache(change.uri);
			const fsPath = uriToFsPath(change.uri);
			if (fsPath) {
				invalidateCanonicalCache(fsPath);
				revalidateMarkdownDocsForBib(fsPath).catch(e =>
					connection.console.error(`revalidateMarkdownDocsForBib error: ${e instanceof Error ? e.message : String(e)}`)
				);
			}
		}
		if (change.uri.toLowerCase().endsWith('.csl')) {
			cslChanged = true;
		}
	}
	// When a CSL or bib file is added/changed, revalidate all open markdown
	// documents to clear stale frontmatter diagnostics (e.g. "Bibliography
	// file not found" or CSL warnings).
	if (cslChanged || bibChanged) {
		for (const doc of documents.all()) {
			if (isMarkdownUri(doc.uri, doc.languageId)) {
				scheduleValidation(doc.uri);
			}
		}
	}
});

connection.onShutdown(() => {
	for (const timer of validationTimers.values()) clearTimeout(timer);
	validationTimers.clear();
});

connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[] | CompletionList> => {
	const doc = await getTextDocument(params.textDocument.uri, 'markdown');
	if (!doc || !isMarkdownUri(doc.uri, doc.languageId)) {
		return [];
	}

	const text = doc.getText();
	const offset = doc.offsetAt(params.position);

	// Frontmatter completions (keys, values, CSL, styles sub-props)
	const fmLocation = getFrontmatterLocation(text, offset);
	if (fmLocation.inFrontmatter && fmLocation.kind !== 'outside') {
		const cachedCslStyles = await getCachedCslStyleNames();
		const fmItems = getFrontmatterCompletionItems(fmLocation, process.platform, cachedCslStyles);
		if (fmItems.length > 0) {
			const isKey = fmLocation.kind === 'key' || fmLocation.kind === 'styles-key';
			const replaceRange = isKey
				? Range.create(doc.positionAt(fmLocation.keyStart), doc.positionAt(fmLocation.keyEnd))
				: Range.create(doc.positionAt(fmLocation.valueStart), doc.positionAt(fmLocation.valueEnd));
			const isCsl = fmItems.some(i => i.isIncomplete);
			const items: CompletionItem[] = fmItems.map(item => ({
				label: item.label,
				kind: item.kind === 'property' ? CompletionItemKind.Property : CompletionItemKind.Value,
				detail: item.detail,
				textEdit: { range: replaceRange, newText: item.insertText },
				filterText: item.filterText,
				sortText: item.sortText,
			}));
			if (isCsl) return { isIncomplete: true, items };
			return items;
		}
		if (fmLocation.frontmatterClosed) return [];
	}

	const completionContext = getCompletionContextAtOffset(text, offset);
	if (!completionContext) {
		return [];
	}

	const bibPath = await resolveBibliographyPathAsync(doc.uri, text, workspaceRootPaths);
	if (!bibPath) {
		return [];
	}

	const bibData = await getBibDataForPath(bibPath);
	if (!bibData) {
		return [];
	}

	const prefix = completionContext.prefix.toLowerCase();
	const replaceRange = Range.create(doc.positionAt(completionContext.replaceStart), params.position);
	const sortedEntries = [...bibData.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
	const items: CompletionItem[] = [];

	for (const entry of sortedEntries) {
		if (prefix && !entry.key.toLowerCase().startsWith(prefix)) {
			continue;
		}
		items.push({
			label: entry.key,
			kind: CompletionItemKind.Reference,
			detail: getEntryDetail(entry),
			documentation: getEntryDocumentation(entry),
			textEdit: {
				range: replaceRange,
				newText: entry.key,
			},
			filterText: entry.key,
			sortText: entry.key,
			commitCharacters: [';', ',', ']'],
		});
	}

	return items;
});

connection.onDefinition(async (params: DefinitionParams): Promise<Location | null> => {
	const symbol = await resolveSymbolAtPosition(params.textDocument.uri, params.position);
	if (!symbol || !symbol.bibPath) {
		return null;
	}
	return (await getDefinitionLocationForKey(symbol.key, symbol.bibPath)) ?? null;
});

connection.onReferences(async (params: ReferenceParams): Promise<Location[]> => {
	const symbol = await resolveSymbolAtPosition(params.textDocument.uri, params.position);
	if (!symbol || !symbol.bibPath) {
		return [];
	}

	if (symbol.source === 'markdown' && !settings.citekeyReferencesFromMarkdown) {
		// From markdown: only return the .bib declaration location.
		//
		// VS Code's built-in "Markdown Language Features" extension already
		// discovers every other `@citekey` occurrence across open workspace
		// markdown files (it treats `@`-prefixed words as word-level symbols
		// and includes them in its own reference results).  Because VS Code
		// merges results from all providers, returning those same markdown
		// locations here would produce duplicates in the "Find All References"
		// panel.  The one thing the built-in extension *cannot* find is the
		// key's declaration inside the .bib file — so that is the only
		// location we contribute from this branch.
		//
		// Users can override this via the
		// manuscriptMarkdown.citekeyReferencesFromMarkdown setting if they
		// prefer our results (e.g. the built-in extension is disabled).
		const declaration = await getDefinitionLocationForKey(symbol.key, symbol.bibPath);
		return declaration ? [declaration] : [];
	}

	// From .bib (or markdown with the override enabled): find paired
	// markdown files and return citation usages.
	const locations = await findReferencesForKey(symbol.key, symbol.bibPath);
	if (params.context.includeDeclaration && symbol.source !== 'bib') {
		const declaration = await getDefinitionLocationForKey(symbol.key, symbol.bibPath);
		if (declaration) {
			locations.unshift(declaration);
		}
	}
	return dedupeLocations(locations);
});

connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
	// 0. Try frontmatter hover
	if (isMarkdownUri(params.textDocument.uri, documents.get(params.textDocument.uri)?.languageId)) {
		const fmDoc = await getTextDocument(params.textDocument.uri, 'markdown');
		if (fmDoc) {
			const fmText = fmDoc.getText();
			const fmOffset = fmDoc.offsetAt(params.position);
			const fmLocation = getFrontmatterLocation(fmText, fmOffset);
			const fmHover = getFrontmatterHover(fmLocation);
			if (fmHover) {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: fmHover.markdown,
					},
				};
			}
		}
	}

	// 1. Try citekey hover
	const symbol = await resolveSymbolAtPosition(params.textDocument.uri, params.position);
	if (symbol?.bibPath) {
		const bibData = await getBibDataForPath(symbol.bibPath);
		if (bibData) {
			const entry = bibData.entries.get(symbol.key);
			if (entry) {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: formatBibEntryHover(entry, symbol.bibPath),
					},
				};
			}
		}
	}

	// 2. Try DOI/ISBN/ISSN/file field link hover in .bib files
	if (isBibUri(params.textDocument.uri)) {
		const doc = documents.get(params.textDocument.uri);
		if (doc) {
			const line = params.position.line;
			const lineText = doc.getText(Range.create(line, 0, line + 1, 0));
			const link = findBibFieldLinkAtLine(lineText);
			if (link) {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: link.invalid ? link.label : `[${link.label}](${link.url})`,
					},
				};
			}

			// Try file field hover
			const fileEntries = findBibFileFieldAtLine(lineText);
			if (fileEntries) {
				const bibFsPath = uriToFsPath(params.textDocument.uri);
				const bibDir = bibFsPath ? path.dirname(bibFsPath) : '';
				const lines = fileEntries.map(f => {
					const absPath = resolveFileEntryPath(f.filePath, bibDir);
					return formatFileEntryMarkdown(fileEntryDisplayName(f), absPath);
				});
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: lines.length === 1 ? lines[0] : lines.map(l => '- ' + l).join('\n'),
					},
				};
			}
		}
	}

	// 3. Try comment hover — show associated text for non-inline comments
	if (isMarkdownUri(params.textDocument.uri, documents.get(params.textDocument.uri)?.languageId)) {
		const doc = await getTextDocument(params.textDocument.uri, 'markdown');
		if (doc) {
			const text = doc.getText();
			const offset = doc.offsetAt(params.position);
			const commentId = findCommentIdAtOffset(text, offset);
			if (commentId) {
				const rangeText = findRangeTextForId(text, commentId);
				if (rangeText) {
					const stripped = stripCriticMarkup(rangeText);
					if (stripped) {
						return {
							contents: {
								kind: MarkupKind.Markdown,
								value: stripped,
							},
						};
					}
				}
			}
		}
	}

	return null;
});

connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[] | null> => {
	if (!isBibUri(params.textDocument.uri)) {
		return null;
	}

	const fsPath = uriToFsPath(params.textDocument.uri);
	if (!fsPath) {
		return null;
	}

	const bibData = await getBibDataForPath(fsPath);
	if (!bibData) {
		return [];
	}

	// Always create TextDocument from bibData.text so positionAt() offsets
	// match the same snapshot that bibData.entries and computeBibEntryRanges
	// operate on. Using documents.get(params.textDocument.uri) would risk a
	// mismatch when the URI round-trip (uriToFsPath → fsPathToUri) differs
	// from the original URI (e.g. drive-letter casing on Windows), since
	// getBibDataForPath may have read from disk while the editor has unsaved edits.
	const text = bibData.text;
	const ranges = computeBibEntryRanges(text);
	const doc = TextDocument.create(params.textDocument.uri, 'bibtex', 0, text);
	const symbols: DocumentSymbol[] = [];

	for (const r of ranges) {
		const entry = bibData.entries.get(r.key);
		if (!entry) {
			continue;
		}

		symbols.push(DocumentSymbol.create(
			r.key,
			getEntryDetail(entry),
			SymbolKind.Key,
			Range.create(doc.positionAt(r.entryStart), doc.positionAt(r.entryEnd)),
			Range.create(doc.positionAt(r.keyStart), doc.positionAt(r.keyEnd)),
		));
	}

	return symbols;
});

documents.listen(connection);
connection.listen();

async function validateFrontmatterDiags(doc: TextDocument): Promise<void> {
	try {
		const text = doc.getText();
		const fsPath = uriToFsPath(doc.uri);
		const sourceDir = fsPath ? path.dirname(fsPath) : undefined;

		const maxCslSuggestions = 3;
		const rawDiags = await validateFrontmatterFields(text, {
			fileExists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
			isCslAvailable: (name, opts) => isCslAvailableAsync(name, opts),
			cslSuggestions: (prefix) => {
				const lower = prefix.toLowerCase();
				const suggestions: string[] = [];
				if (lower) {
					for (const [id, displayName] of BUNDLED_STYLE_LABELS) {
						if (id.toLowerCase().startsWith(lower) || displayName.toLowerCase().includes(lower)) {
							if (suggestions.length < maxCslSuggestions) suggestions.push(id);
						}
					}
				}
				return suggestions;
			},
			sourceDir,
			cslCacheDirs: settings.cslCacheDirs,
			resolveBibliographyPath: () => resolveBibliographyPathAsync(doc.uri, text, workspaceRootPaths),
		});

		frontmatterDiagnostics.set(doc.uri, rawDiags.map(d => ({
			severity: severityMap[d.severity] ?? DiagnosticSeverity.Warning,
			range: Range.create(doc.positionAt(d.start), doc.positionAt(d.end)),
			message: d.message,
			source: 'manuscript-markdown',
		})));
		publishDiagnostics(doc.uri);
	} catch (e) {
		connection.console.error('Frontmatter validation error for ' + doc.uri + ': ' + (e instanceof Error ? e.stack ?? e.message : e));
	}
}

async function getCachedCslStyleNames(): Promise<string[]> {
	const dirs = settings.cslCacheDirs;
	if (!dirs || dirs.length === 0) return [];
	const names: string[] = [];
	for (const dir of dirs) {
		try {
			const entries = await fsp.readdir(dir);
			for (const entry of entries) {
				if (entry.endsWith('.csl')) {
					names.push(entry.slice(0, -4));
				}
			}
		} catch {
			// Directory may not exist yet
		}
	}
	return names;
}

function validateOrientationDirectives(doc: TextDocument): void {
	const text = maskFrontmatter(doc.getText());
	const codeRegions = computeCodeRegions(text);
	const findings = scanOrientationDirectives(text, codeRegions);
	const diagnostics: Diagnostic[] = [];

	for (const f of findings) {
		let message: string;
		switch (f.kind) {
			case 'nested':
				message = 'Nested <!-- ' + f.directiveName + ' --> \u2014 <!-- ' + (f.relatedName ?? f.directiveName) + ' --> is still active.';
				break;
			case 'crossed':
				message = '<!-- /' + f.directiveName + ' --> does not match the active <!-- ' + f.relatedName + ' --> section.';
				break;
			case 'orphaned':
				message = 'Orphaned <!-- /' + f.directiveName + ' --> \u2014 no matching <!-- ' + f.directiveName + ' --> precedes it.';
				break;
			case 'unclosed':
				message = 'Unclosed <!-- ' + f.directiveName + ' --> \u2014 no matching <!-- /' + f.directiveName + ' --> before end of file.';
				break;
		}
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: Range.create(doc.positionAt(f.start), doc.positionAt(f.end)),
			message,
			source: 'manuscript-markdown',
		});
	}

	orientationDiagnostics.set(doc.uri, diagnostics);
	publishDiagnostics(doc.uri);
}

function validateTableNumbers(doc: TextDocument): void {
	const text = doc.getText();
	const { metadata } = parseFrontmatter(text);
	const masked = maskFrontmatter(text);
	const documentFormat = {
		digits: metadata.tableDigits,
		decimalMark: metadata.tableDecimalMark,
		digitGrouping: metadata.tableDigitGrouping,
	};
	const documentFormatError = validateTableNumberFormat(documentFormat);
	const directResult = formatTableNumbers(masked, documentFormat);
	const gridInput = preprocessGridTablesWithSourceMap(masked);
	const gridResult = formatTableNumbers(gridInput.output, documentFormat);
	const gridWarnings = gridResult.warningDetails.flatMap(warning => {
		const mapping = gridInput.sourceMap.find(entry => warning.start >= entry.outputStart && warning.end <= entry.outputEnd);
		return mapping ? [{ message: warning.message, start: mapping.sourceStart, end: mapping.sourceEnd }] : [];
	});
	const seen = new Set<string>();
	const diagnostics = [...directResult.warningDetails, ...gridWarnings].flatMap(warning => {
		if (warning.message === documentFormatError) return [];
		const key = warning.message + '\0' + warning.start + '\0' + warning.end;
		if (seen.has(key)) return [];
		seen.add(key);
		return [{
			severity: DiagnosticSeverity.Warning,
			range: Range.create(doc.positionAt(warning.start), doc.positionAt(warning.end)),
			message: warning.message,
			source: 'manuscript-markdown',
		}];
	});
	tableNumberDiagnostics.set(doc.uri, diagnostics);
	publishDiagnostics(doc.uri);
}

async function validateEmbedDirectives(doc: TextDocument): Promise<void> {
	const text = doc.getText();
	const lines = text.split('\n');
	const codeRegions = computeCodeRegions(text);
	const diagnostics: Diagnostic[] = [];
	const docPath = uriToFsPath(doc.uri);
	if (!docPath) return;
	const docDir = path.dirname(docPath);

	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!overlapsCodeRegion(offset, offset + lines[i].length, codeRegions)) {
			const directive = parseEmbedDirective(trimmed);
			if (directive) {
				const lineStart = offset;
				const lineEnd = offset + lines[i].length;

				// Validate file exists
				const absPath = path.resolve(docDir, directive.path);
				const ext = directive.path.toLowerCase().replace(/^.*\./, '.');
				const supportedExts = new Set(['.csv', '.tsv', '.xlsx', '.md', '.dta']);

				if (!supportedExts.has(ext)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
						message: 'Unsupported embed format: ' + ext,
						source: 'manuscript-markdown',
					});
				} else {
					try {
						const stat = await fsp.stat(absPath);
						if (!stat.isFile()) throw new Error('not a file');

						// For XLSX, validate sheet and range params
						if (ext === '.xlsx' && (directive.sheet || directive.range)) {
							try {
								const XLSX = require('@e965/xlsx');
								const data = new Uint8Array(await fsp.readFile(absPath));
								const wb = XLSX.read(data, { type: 'array' });

								if (directive.sheet) {
									const idx = Number(directive.sheet);
									if (Number.isInteger(idx) && idx >= 1) {
										if (idx > wb.SheetNames.length) {
											diagnostics.push({
												severity: DiagnosticSeverity.Error,
												range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
												message: 'Sheet index ' + idx + ' out of range (workbook has ' + wb.SheetNames.length + ' sheets)',
												source: 'manuscript-markdown',
											});
										}
									} else if (!wb.SheetNames.includes(directive.sheet)) {
										diagnostics.push({
											severity: DiagnosticSeverity.Error,
											range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
											message: 'Sheet "' + directive.sheet + '" not found in workbook',
											source: 'manuscript-markdown',
										});
									}
								}

								if (directive.range && !/^[A-Z]+\d+:[A-Z]+\d+$/i.test(directive.range.replace(/\$/g, ''))) {
									// Check if it's a named range
									const names = wb.Workbook?.Names;
									const hasNamedRange = Array.isArray(names) && names.some((name: unknown) =>
										typeof name === 'object' && name !== null && 'Name' in name && name.Name === directive.range
									);
									if (!hasNamedRange) {
										diagnostics.push({
											severity: DiagnosticSeverity.Error,
											range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
											message: 'Named range "' + directive.range + '" not found in workbook',
											source: 'manuscript-markdown',
										});
									}
								}
							} catch (e) {
								if (e instanceof Error && (e.message.includes('Sheet') || e.message.includes('range'))) {
									diagnostics.push({
										severity: DiagnosticSeverity.Error,
										range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
										message: e.message,
										source: 'manuscript-markdown',
									});
								}
							}
						}

						// For .md files, check for non-table content
						if (ext === '.md') {
							const content = await fsp.readFile(absPath, 'utf-8');
							const mdLines = content.split('\n');
							let hasNonTableContent = false;
							let inTable = false;
							for (const mdLine of mdLines) {
								const t = mdLine.trim();
								if (t === '') continue;
								if (/^<!--\s*table-(font-size|font|orientation|col-widths):/.test(t)) continue;
								if (t.startsWith('<table') || t === '<table>') { inTable = true; continue; }
								if (inTable) { if (t.includes('</table>')) inTable = false; continue; }
								if (t.startsWith('|') && t.endsWith('|')) continue;
								if (/^\+[-=]+(\+[-=]+)*\+$/.test(t)) continue;
								hasNonTableContent = true;
								break;
							}
							if (hasNonTableContent) {
								diagnostics.push({
									severity: DiagnosticSeverity.Information,
									range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
									message: 'Embedded .md file contains non-table content (will be ignored)',
									source: 'manuscript-markdown',
								});
							}
						}
					} catch {
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							range: Range.create(doc.positionAt(lineStart), doc.positionAt(lineEnd)),
							message: 'File not found: ' + directive.path,
							source: 'manuscript-markdown',
						});
					}
				}
			}
		}
		offset += lines[i].length + 1; // +1 for newline
	}

	embedDiagnostics.set(doc.uri, diagnostics);
	publishDiagnostics(doc.uri);
}

function extractWorkspaceRoots(params: InitializeParams): string[] {
	const paths = new Set<string>();
	if (params.workspaceFolders) {
		for (const folder of params.workspaceFolders) {
			const fsPath = uriToFsPath(folder.uri);
			if (fsPath) {
				paths.add(fsPath);
			}
		}
	}
	if (params.rootUri) {
		const rootPath = uriToFsPath(params.rootUri);
		if (rootPath) {
			paths.add(rootPath);
		}
	}
	if (params.rootPath) {
		paths.add(params.rootPath);
	}
	return [...paths];
}

function isMarkdownUri(uri: string, languageId?: string): boolean {
	if (languageId === 'markdown') {
		return true;
	}
	return uri.toLowerCase().endsWith('.md');
}

function isBibUri(uri: string): boolean {
	return uri.toLowerCase().endsWith('.bib');
}

async function getTextDocument(uri: string, languageId: string): Promise<TextDocument | undefined> {
	const open = documents.get(uri);
	if (open) {
		return open;
	}

	const fsPath = uriToFsPath(uri);
	if (!fsPath) {
		return undefined;
	}

	try {
		const text = await fsp.readFile(fsPath, 'utf8');
		return TextDocument.create(uri, languageId, 0, text);
	} catch {
		return undefined;
	}
}

function invalidateBibCache(uri: string): void {
	const fsPath = uriToFsPath(uri);
	if (fsPath) {
		const key = canonicalizeFsPath(fsPath);
		bibCache.delete(key);
		openDocBibCache.delete(key);
	}
}

async function validateCitekeys(doc: TextDocument, metadata?: Frontmatter): Promise<void> {
	const text = doc.getText();
	const bibPath = await resolveBibliographyPathAsync(doc.uri, text, workspaceRootPaths, metadata);
	if (!bibPath) {
		citekeyDiagnostics.set(doc.uri, []);
		publishDiagnostics(doc.uri);
		return;
	}

	const bibData = await getBibDataForPath(bibPath);
	if (!bibData) {
		citekeyDiagnostics.set(doc.uri, []);
		publishDiagnostics(doc.uri);
		return;
	}

	const diagnostics: Diagnostic[] = [];
	for (const usage of scanCitationUsages(text)) {
		if (!bibData.entries.has(usage.key)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: Range.create(doc.positionAt(usage.keyStart - 1), doc.positionAt(usage.keyEnd)),
				message: `Citation key "@${usage.key}" not found in bibliography.`,
				source: 'manuscript-markdown',
			});
		}
	}

	citekeyDiagnostics.set(doc.uri, diagnostics);
	publishDiagnostics(doc.uri);
}

async function revalidateMarkdownDocsForBib(changedBibPath: string): Promise<void> {
	const changedCanonical = await canonicalizeFsPathAsync(changedBibPath);
	const trackedUris = new Set(getMarkdownUrisForBib(changedCanonical));

	for (const docUri of trackedUris) {
		const doc = documents.get(docUri);
		if (doc) {
			const { metadata } = parseFrontmatter(doc.getText());
			await validateCitekeys(doc, metadata);
		}
	}

	// Recover markdown docs that were open before their referenced .bib file existed.
	for (const doc of documents.all()) {
		if (!isMarkdownUri(doc.uri, doc.languageId)) {
			continue;
		}
		if (trackedUris.has(doc.uri) || docToBibMap.has(doc.uri)) {
			continue;
		}
		try {
			const docText = doc.getText();
			const { metadata } = parseFrontmatter(docText);
			const bibPath = await resolveBibliographyPathAsync(doc.uri, docText, workspaceRootPaths, metadata);
			if (!bibPath || await canonicalizeFsPathAsync(bibPath) !== changedCanonical) {
				continue;
			}
			await updateBibReverseMap(doc.uri, docText, metadata);
			await validateCitekeys(doc, metadata);
		} catch (error) {
			connection.console.error(
				`Error revalidating markdown doc ${doc.uri} for bibliography ${changedBibPath}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
			);
		}
	}
}

async function getBibDataForPath(bibPath: string): Promise<ParsedBibData | undefined> {
	const cacheKey = await canonicalizeFsPathAsync(bibPath);
	const openDoc = documents.get(fsPathToUri(bibPath));
	if (openDoc) {
		const cached = openDocBibCache.get(cacheKey);
		if (cached && cached.version === openDoc.version) {
			return cached.data;
		}
		const data = parseBibDataFromText(bibPath, openDoc.getText());
		openDocBibCache.set(cacheKey, { version: openDoc.version, data });
		return data;
	}

	try {
		const stat = await fsp.stat(bibPath);
		const cached = bibCache.get(cacheKey);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			return cached;
		}
		const text = await fsp.readFile(bibPath, 'utf8');
		const parsed = parseBibDataFromText(bibPath, text);
		bibCache.set(cacheKey, { ...parsed, mtimeMs: stat.mtimeMs, size: stat.size });
		return parsed;
	} catch {
		return undefined;
	}
}

async function resolveSymbolAtPosition(uri: string, position: Position): Promise<ResolvedSymbol | undefined> {
	if (isMarkdownUri(uri, documents.get(uri)?.languageId)) {
		const doc = await getTextDocument(uri, 'markdown');
		if (!doc) {
			return undefined;
		}
		const text = doc.getText();
		const key = findCitekeyAtOffset(text, doc.offsetAt(position));
		if (!key) {
			return undefined;
		}
		const bibPath = await resolveBibliographyPathAsync(doc.uri, text, workspaceRootPaths);
		return {
			key,
			source: 'markdown',
			sourceUri: uri,
			bibPath,
		};
	}

	if (isBibUri(uri)) {
		const bibPath = uriToFsPath(uri);
		if (!bibPath) {
			return undefined;
		}
		const bibData = await getBibDataForPath(bibPath);
		if (!bibData) {
			return undefined;
		}
		const bibDoc = documents.get(uri) ?? TextDocument.create(uri, 'bibtex', 0, bibData.text);
		const key = findBibKeyAtOffset(bibData, bibDoc.offsetAt(position));
		if (!key) {
			return undefined;
		}
		return {
			key,
			source: 'bib',
			sourceUri: uri,
			bibPath,
		};
	}

	return undefined;
}

async function getDefinitionLocationForKey(key: string, bibPath: string): Promise<Location | undefined> {
	const bibData = await getBibDataForPath(bibPath);
	if (!bibData) {
		return undefined;
	}
	const startOffset = bibData.keyOffsets.get(key);
	if (startOffset === undefined) {
		return undefined;
	}
	const bibUri = fsPathToUri(bibPath);
	const bibDoc = (await getTextDocument(bibUri, 'bibtex')) ?? TextDocument.create(bibUri, 'bibtex', 0, bibData.text);
	const start = bibDoc.positionAt(startOffset);
	const end = bibDoc.positionAt(startOffset + key.length);
	return Location.create(bibUri, Range.create(start, end));
}

async function findPairedMarkdownUris(bibPath: string): Promise<string[]> {
  const urisByCanonicalPath = new Map<string, string>();

  // 1. Same-basename: paper.bib → paper.md
  const dir = path.dirname(bibPath);
  const base = path.basename(bibPath, path.extname(bibPath));
  const sameBaseMd = path.join(dir, base + '.md');
  try {
    await fsp.stat(sameBaseMd);
    const canonical = await canonicalizeFsPathAsync(sameBaseMd);
    urisByCanonicalPath.set(canonical, fsPathToUri(sameBaseMd));
  } catch { /* file doesn't exist */ }

  // 2. Open docs from reverse map
  const bibCanonical = await canonicalizeFsPathAsync(bibPath);
  for (const docUri of getMarkdownUrisForBib(bibCanonical)) {
    const fsPath = uriToFsPath(docUri);
    if (fsPath) {
      const canonical = await canonicalizeFsPathAsync(fsPath);
      if (!urisByCanonicalPath.has(canonical)) {
        urisByCanonicalPath.set(canonical, docUri);
      }
    }
  }

  return [...urisByCanonicalPath.values()];
}


async function findReferencesForKey(key: string, targetBibPath: string): Promise<Location[]> {
	const markdownUris = await findPairedMarkdownUris(targetBibPath);
	const locations: Location[] = [];

	for (const uri of markdownUris) {
		const doc = await getTextDocument(uri, 'markdown');
		if (!doc) {
			continue;
		}
		const text = doc.getText();

		for (const usage of findUsagesForKey(text, key)) {
			locations.push(
				Location.create(
					uri,
					Range.create(doc.positionAt(usage.keyStart), doc.positionAt(usage.keyEnd))
				)
			);
		}
	}

	return locations;
}

function dedupeLocations(locations: Location[]): Location[] {
	const seen = new Set<string>();
	const deduped: Location[] = [];
	for (const location of locations) {
		const locationPathKey = getLocationPathKey(location.uri);
		const key = [
			locationPathKey,
			location.range.start.line,
			location.range.start.character,
			location.range.end.line,
			location.range.end.character,
		].join(':');
		if (!seen.has(key)) {
			seen.add(key);
			deduped.push(location);
		}
	}
	return deduped;
}
function getLocationPathKey(uri: string): string {
	const fsPath = uriToFsPath(uri);
	if (!fsPath) {
		return uri;
	}
	return canonicalizeFsPath(fsPath);
}

function getEntryDetail(entry: BibtexEntry): string | undefined {
	const author = entry.fields.get('author');
	const institution = entry.fields.get('institution');
	const year = entry.fields.get('year');
	const formatted = author ? formatBibAuthorsPlain(author) : undefined;
	const displayName = formatted || institution;
	if (displayName && year) {
		return `${displayName} (${year})`;
	}
	if (displayName) {
		return displayName;
	}
	if (year) {
		return year;
	}
	return undefined;
}

function getEntryDocumentation(entry: BibtexEntry): string | undefined {
	const title = entry.fields.get('title');
	if (!title) {
		return undefined;
	}
	const stripped = title.replace(/[{}]/g, '');
	const parts = [`\u201C${stripped}\u201D`];
	const venue = entry.fields.get('journal') ?? entry.fields.get('booktitle');
	if (venue) {
		parts.push(venue);
	}
	return parts.join('\n\n');
}

/** Split BibTeX author string and flip each "Last, First" to "First Last". */
function parseBibAuthorNames(raw: string): string[] {
	return raw.split(/\s+and\s+/).map(a => {
		const parts = a.split(',').map(p => p.trim());
		return parts.length >= 2 ? `${parts[1]} ${parts[0]}` : a.trim();
	});
}

function joinAuthorNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Plain-text author string for completion detail. */
function formatBibAuthorsPlain(raw: string): string {
	return joinAuthorNames(parseBibAuthorNames(raw));
}

/** Markdown author string with first author bold, for hover. */
function formatBibAuthors(raw: string): string {
	const names = parseBibAuthorNames(raw);
	if (names.length === 0) return raw;
	names[0] = `**${names[0]}**`;
	return joinAuthorNames(names);
}

function formatBibEntryHover(entry: BibtexEntry, bibPath?: string): string {
	const lines: string[] = [];

	const author = entry.fields.get('author');
	const institution = entry.fields.get('institution');
	const year = entry.fields.get('year');
	const formattedAuthors = author ? formatBibAuthors(author) : undefined;
	const displayName = formattedAuthors || institution;
	if (displayName && year) {
		lines.push(`${displayName} (${year})`);
	} else if (displayName) {
		lines.push(displayName);
	} else if (year) {
		lines.push(`(${year})`);
	}

	const title = entry.fields.get('title');
	if (title) {
		const strippedTitle = title.replace(/[{}]/g, '');
		lines.push(`**\u201C${strippedTitle}\u201D**`);
	}

	const venue = entry.fields.get('journal') ?? entry.fields.get('booktitle');
	if (venue) {
		lines.push(`*${venue}*`);
	}

	if (lines.length === 0) {
		lines.push(`\`${entry.key}\``);
	}

	// Access links (DOI, ISBN, ISSN, URL)
	const allLinks: string[] = [];
	const accessLinks = getAccessLinksForEntry(entry);
	for (const link of accessLinks) {
		allLinks.push(`[${link.label}](${link.url})`);
	}

	// File links
	if (bibPath) {
		const bibDir = path.dirname(bibPath);
		const fileEntries = getFileEntriesForEntry(entry);
		for (const f of fileEntries) {
			const absPath = resolveFileEntryPath(f.filePath, bibDir);
			allLinks.push(formatFileEntryMarkdown(fileEntryDisplayName(f), absPath));
		}
	}

	if (allLinks.length === 1) {
		lines.push(allLinks[0]);
	} else if (allLinks.length > 1) {
		lines.push(allLinks.map(l => '- ' + l).join('\n'));
	}

	return lines.join('\n\n');
}

export {
	updateBibReverseMap as _updateBibReverseMap,
	removeBibReverseMapEntry as _removeBibReverseMapEntry,
	getMarkdownUrisForBib as _getMarkdownUrisForBib,
	bibReverseMap as _bibReverseMap,
	scheduleValidation as _scheduleValidation,
	VALIDATION_DEBOUNCE_MS as _VALIDATION_DEBOUNCE_MS,
	validationTimers as _validationTimers,
	runValidationPipeline as _runValidationPipeline,
};
