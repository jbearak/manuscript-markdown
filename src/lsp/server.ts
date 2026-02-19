import { promises as fsp } from 'fs';
import * as path from 'path';
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
	Hover,
	HoverParams,
	InitializeParams,
	Location,
	MarkupKind,
	Position,
	ProposedFeatures,
	Range,
	ReferenceParams,
	TextDocumentSyncKind,
	TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BibtexEntry } from '../bibtex-parser';
import {
	canonicalizeFsPath,
	canonicalizeFsPathAsync,
	ParsedBibData,
	findBibKeyAtOffset,
	findCitekeyAtOffset,
	findUsagesForKey,
	fsPathToUri,
	getCompletionContextAtOffset,
	invalidateCanonicalCache,
	parseBibDataFromText,
	pathsEqual,
	resolveBibliographyPath,
	resolveBibliographyPathAsync,
	scanCitationUsages,
	uriToFsPath,
} from './citekey-language';
import {
	findCommentIdAtOffset,
	findRangeTextForId,
	stripCriticMarkup,
} from './comment-language';
import { getCslCompletionContext, getCslFieldInfo } from './csl-language';
import { type Frontmatter, parseFrontmatter } from '../frontmatter';
import { BUNDLED_STYLE_LABELS, isCslAvailableAsync } from '../csl-loader';

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
const cslDiagnostics = new Map<string, Diagnostic[]>();

function publishDiagnostics(uri: string): void {
	const citekey = citekeyDiagnostics.get(uri) ?? [];
	const csl = cslDiagnostics.get(uri) ?? [];
	connection.sendDiagnostics({ uri, diagnostics: [...citekey, ...csl] });
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
		if (doc) runValidationPipeline(doc);
	}, VALIDATION_DEBOUNCE_MS));
}

/** Run all validation steps with a single shared frontmatter parse. */
async function runValidationPipeline(doc: TextDocument): Promise<void> {
	const text = doc.getText();
	const { metadata } = parseFrontmatter(text);
	updateBibReverseMap(doc.uri, text, metadata);
	await validateCitekeys(doc, metadata);
	await validateCslField(doc, metadata);
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
		runValidationPipeline(event.document);
	}
});

documents.onDidChangeContent((event) => {
	if (isBibUri(event.document.uri)) {
		invalidateBibCache(event.document.uri);
		const fsPath = uriToFsPath(event.document.uri);
		if (fsPath) {
			invalidateCanonicalCache(fsPath);
			revalidateMarkdownDocsForBib(fsPath);
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
			revalidateMarkdownDocsForBib(fsPath);
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
		cslDiagnostics.delete(event.document.uri);
		connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
	}
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
	for (const change of params.changes) {
		if (isBibUri(change.uri)) {
			invalidateBibCache(change.uri);
			const fsPath = uriToFsPath(change.uri);
			if (fsPath) {
				invalidateCanonicalCache(fsPath);
				revalidateMarkdownDocsForBib(fsPath);
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

	// Check for CSL completion context first
	const cslContext = getCslCompletionContext(text, offset);
	if (cslContext) {
		const prefix = cslContext.prefix.toLowerCase();
		const replaceRange = Range.create(
			doc.positionAt(cslContext.valueStart),
			doc.positionAt(cslContext.valueEnd)
		);
		const items: CompletionItem[] = [];
		for (const [id, displayName] of BUNDLED_STYLE_LABELS) {
			if (prefix && !id.toLowerCase().startsWith(prefix) &&
				!displayName.toLowerCase().includes(prefix)) {
				continue;
			}
			items.push({
				label: id,
				kind: CompletionItemKind.Value,
				detail: displayName,
				textEdit: {
					range: replaceRange,
					newText: id,
				},
				filterText: id,
				sortText: id,
			});
		}
		return { isIncomplete: items.length > 0, items };
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
	if (params.context.includeDeclaration) {
		const declaration = await getDefinitionLocationForKey(symbol.key, symbol.bibPath);
		if (declaration) {
			locations.unshift(declaration);
		}
	}
	return dedupeLocations(locations);
});

connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
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
						value: formatBibEntryHover(entry),
					},
				};
			}
		}
	}

	// 2. Try comment hover — show associated text for non-inline comments
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

documents.listen(connection);
connection.listen();

async function validateCslField(doc: TextDocument, metadata?: Frontmatter): Promise<void> {
	try {
		const text = doc.getText();
		const fieldInfo = getCslFieldInfo(text);
		if (!fieldInfo || !fieldInfo.value) {
			cslDiagnostics.set(doc.uri, []);
			publishDiagnostics(doc.uri);
			return;
		}

		const sourceDir = (() => {
			const fsPath = uriToFsPath(doc.uri);
			return fsPath ? path.dirname(fsPath) : undefined;
		})();

		const available = await isCslAvailableAsync(fieldInfo.value, {
			cacheDirs: settings.cslCacheDirs,
			sourceDir,
		});

		if (available) {
			cslDiagnostics.set(doc.uri, []);
			publishDiagnostics(doc.uri);
			return;
		}

		// Build suggestion list from bundled styles matching the user's input
		const maxSuggestions = 3;
		const userValue = fieldInfo.value.toLowerCase();
		const suggestions: string[] = [];
		let totalMatches = 0;
		if (userValue) {
			for (const [id, displayName] of BUNDLED_STYLE_LABELS) {
				if (id.toLowerCase().startsWith(userValue) || displayName.toLowerCase().includes(userValue)) {
					totalMatches++;
					if (suggestions.length < maxSuggestions) {
						suggestions.push(id);
					}
				}
			}
		}
		let message = `CSL style "${fieldInfo.value}" not found.`;
		const remaining = totalMatches - suggestions.length;
		if (suggestions.length === 1 && remaining === 0) {
			message += ` Did you mean \`${suggestions[0]}\`?`;
		} else if (suggestions.length > 0) {
			const quoted = suggestions.map(s => `\`${s}\``);
			const hint = remaining > 0 ? `, and ${remaining} more` : '';
			message += ` Did you mean ${quoted.join(', ')}${hint}?`;
		}

		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: Range.create(
				doc.positionAt(fieldInfo.valueStart),
				doc.positionAt(fieldInfo.valueEnd)
			),
			message,
			source: 'manuscript-markdown',
		};
		cslDiagnostics.set(doc.uri, [diagnostic]);
		publishDiagnostics(doc.uri);
	} catch (e) {
		// Don't let validation errors crash the LSP connection
		connection.console.error(`Error building CSL suggestions: ${e instanceof Error ? e.stack ?? e.message : e}`);
	}
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
			validateCitekeys(doc);
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
			const bibPath = await resolveBibliographyPathAsync(doc.uri, docText, workspaceRootPaths);
			if (!bibPath || await canonicalizeFsPathAsync(bibPath) !== changedCanonical) {
				continue;
			}
			await updateBibReverseMap(doc.uri, docText);
			validateCitekeys(doc);
		} catch (error) {
			connection.console.error(
				`Error revalidating markdown doc ${doc.uri} for bibliography ${changedBibPath}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
			);
		}
	}
}

async function getBibDataForPath(bibPath: string): Promise<ParsedBibData | undefined> {
	const openDoc = documents.get(fsPathToUri(bibPath));
	if (openDoc) {
		const cacheKey = canonicalizeFsPath(bibPath);
		const cached = openDocBibCache.get(cacheKey);
		if (cached && cached.version === openDoc.version) {
			return cached.data;
		}
		const data = parseBibDataFromText(bibPath, openDoc.getText());
		openDocBibCache.set(cacheKey, { version: openDoc.version, data });
		return data;
	}

	const cacheKey = canonicalizeFsPath(bibPath);
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
    const canonical = canonicalizeFsPath(sameBaseMd);
    urisByCanonicalPath.set(canonical, fsPathToUri(sameBaseMd));
  } catch { /* file doesn't exist */ }

  // 2. Open docs from reverse map
  const bibCanonical = canonicalizeFsPath(bibPath);
  for (const docUri of getMarkdownUrisForBib(bibCanonical)) {
    const fsPath = uriToFsPath(docUri);
    if (fsPath) {
      const canonical = canonicalizeFsPath(fsPath);
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
	const year = entry.fields.get('year');
	const formatted = author ? formatBibAuthorsPlain(author) : undefined;
	if (formatted && year) {
		return `${formatted} (${year})`;
	}
	if (formatted) {
		return formatted;
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

function formatBibEntryHover(entry: BibtexEntry): string {
	const lines: string[] = [];

	const author = entry.fields.get('author');
	const year = entry.fields.get('year');
	const formattedAuthors = author ? formatBibAuthors(author) : undefined;
	if (formattedAuthors && year) {
		lines.push(`${formattedAuthors} (${year})`);
	} else if (formattedAuthors) {
		lines.push(formattedAuthors);
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
		lines.push(venue);
	}

	if (lines.length === 0) {
		lines.push(`\`${entry.key}\``);
	}

	return lines.join('\n\n');
}

export { updateBibReverseMap as _updateBibReverseMap, removeBibReverseMapEntry as _removeBibReverseMapEntry, getMarkdownUrisForBib as _getMarkdownUrisForBib, bibReverseMap as _bibReverseMap, scheduleValidation as _scheduleValidation, VALIDATION_DEBOUNCE_MS as _VALIDATION_DEBOUNCE_MS, validationTimers as _validationTimers, runValidationPipeline as _runValidationPipeline };
