import { promises as fsp } from 'fs';
import * as path from 'path';
import {
	CompletionItem,
	CompletionItemKind,
	CompletionParams,
	createConnection,
	DefinitionParams,
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
	ParsedBibData,
	findBibKeyAtOffset,
	findCitekeyAtOffset,
	fsPathToUri,
	getCompletionContextAtOffset,
	parseBibDataFromText,
	pathsEqual,
	resolveBibliographyPath,
	scanCitationUsages,
	uriToFsPath,
} from './citekey-language';

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

connection.onInitialize((params: InitializeParams) => {
	workspaceRootPaths = extractWorkspaceRoots(params);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				triggerCharacters: ['@'],
			},
			definitionProvider: true,
			hoverProvider: true,
			referencesProvider: true,
		},
	};
});

documents.onDidChangeContent((event) => {
	if (isBibUri(event.document.uri)) {
		invalidateBibCache(event.document.uri);
	}
});

documents.onDidClose((event) => {
	if (isBibUri(event.document.uri)) {
		invalidateBibCache(event.document.uri);
	}
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
	for (const change of params.changes) {
		if (isBibUri(change.uri)) {
			invalidateBibCache(change.uri);
		}
	}
});

connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[]> => {
	const doc = await getTextDocument(params.textDocument.uri, 'markdown');
	if (!doc || !isMarkdownUri(doc.uri, doc.languageId)) {
		return [];
	}

	const text = doc.getText();
	const offset = doc.offsetAt(params.position);
	const completionContext = getCompletionContextAtOffset(text, offset);
	if (!completionContext) {
		return [];
	}

	const bibPath = resolveBibliographyPath(doc.uri, text, workspaceRootPaths);
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

	if (symbol.source === 'markdown') {
		// From markdown: only provide the .bib declaration location.
		// The built-in Markdown Language Features extension handles
		// markdown→markdown references, so we avoid duplicating those.
		const declaration = await getDefinitionLocationForKey(symbol.key, symbol.bibPath);
		return declaration ? [declaration] : [];
	}

	// From .bib: find paired markdown files and return citation usages
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
	const symbol = await resolveSymbolAtPosition(params.textDocument.uri, params.position);
	if (!symbol || !symbol.bibPath) {
		return null;
	}

	const bibData = await getBibDataForPath(symbol.bibPath);
	if (!bibData) {
		return null;
	}

	const entry = bibData.entries.get(symbol.key);
	if (!entry) {
		return null;
	}

	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: formatBibEntryHover(entry),
		},
	};
});

documents.listen(connection);
connection.listen();

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
		bibCache.delete(canonicalizeFsPath(fsPath));
	}
}

async function getBibDataForPath(bibPath: string): Promise<ParsedBibData | undefined> {
	const openDoc = documents.get(fsPathToUri(bibPath));
	if (openDoc) {
		return parseBibDataFromText(bibPath, openDoc.getText());
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
		const bibPath = resolveBibliographyPath(doc.uri, text, workspaceRootPaths);
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
		const bibDoc = await getTextDocument(uri, 'bibtex');
		if (!bibData || !bibDoc) {
			return undefined;
		}
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
	} catch {
		// file doesn't exist
	}

	// 2. Open docs whose frontmatter bibliography resolves to this bib
	for (const doc of documents.all()) {
		if (doc.languageId !== 'markdown') {
			continue;
		}
		const resolved = resolveBibliographyPath(doc.uri, doc.getText(), workspaceRootPaths);
		if (resolved && pathsEqual(resolved, bibPath)) {
			const fsPath = uriToFsPath(doc.uri);
			if (fsPath) {
				const canonical = canonicalizeFsPath(fsPath);
				if (!urisByCanonicalPath.has(canonical)) {
					urisByCanonicalPath.set(canonical, doc.uri);
				}
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

		for (const usage of scanCitationUsages(text)) {
			if (usage.key === key) {
				locations.push(
					Location.create(
						uri,
						Range.create(doc.positionAt(usage.keyStart), doc.positionAt(usage.keyEnd))
					)
				);
			}
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
	if (author && year) {
		return `${author} (${year})`;
	}
	if (author) {
		return author;
	}
	if (year) {
		return year;
	}
	return undefined;
}

function getEntryDocumentation(entry: BibtexEntry): string | undefined {
	return entry.fields.get('title');
}

function formatBibEntryHover(entry: BibtexEntry): string {
	const lines: string[] = [];

	const author = entry.fields.get('author');
	const year = entry.fields.get('year');
	if (author && year) {
		lines.push(`**${author}** (${year})`);
	} else if (author) {
		lines.push(`**${author}**`);
	} else if (year) {
		lines.push(`(${year})`);
	}

	const title = entry.fields.get('title');
	if (title) {
		lines.push(`*${title}*`);
	}

	const venue = entry.fields.get('journal') ?? entry.fields.get('booktitle');
	if (venue) {
		lines.push(venue);
	}

	if (lines.length === 0) {
		lines.push(`\`@${entry.type}{${entry.key}}\``);
	} else {
		lines.push(`\`@${entry.type}\``);
	}

	return lines.join('\n\n');
}
