import { promises as fsp } from 'fs';
import * as path from 'path';
import {
	CompletionItem,
	CompletionItemKind,
	CompletionParams,
	createConnection,
	DefinitionParams,
	DidChangeWatchedFilesParams,
	InitializeParams,
	Location,
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
			referencesProvider: true,
		},
	};
});

documents.onDidChangeContent((event) => {
	if (isBibUri(event.document.uri)) {
		const fsPath = uriToFsPath(event.document.uri);
		if (fsPath) {
			bibCache.delete(fsPath);
		}
	}
});

documents.onDidClose((event) => {
	if (isBibUri(event.document.uri)) {
		const fsPath = uriToFsPath(event.document.uri);
		if (fsPath) {
			bibCache.delete(fsPath);
		}
	}
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
	for (const change of params.changes) {
		if (isBibUri(change.uri)) {
			const fsPath = uriToFsPath(change.uri);
			if (fsPath) {
				bibCache.delete(fsPath);
			}
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
	if (!symbol) {
		return [];
	}

	const locations = symbol.bibPath
		? await findReferencesForKey(symbol.key, symbol.bibPath)
		: await findReferencesInSingleDocument(symbol.key, symbol.sourceUri);

	if (params.context.includeDeclaration && symbol.bibPath) {
		const declaration = await getDefinitionLocationForKey(symbol.key, symbol.bibPath);
		if (declaration) {
			locations.unshift(declaration);
		}
	}

	return dedupeLocations(locations);
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

async function getBibDataForPath(bibPath: string): Promise<ParsedBibData | undefined> {
	const openDoc = documents.get(fsPathToUri(bibPath));
	if (openDoc) {
		return parseBibDataFromText(bibPath, openDoc.getText());
	}

	try {
		const stat = await fsp.stat(bibPath);
		const cached = bibCache.get(bibPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return cached;
		}
		const text = await fsp.readFile(bibPath, 'utf8');
		const parsed = parseBibDataFromText(bibPath, text);
		bibCache.set(bibPath, { ...parsed, mtimeMs: stat.mtimeMs });
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

async function findReferencesForKey(key: string, targetBibPath: string): Promise<Location[]> {
	const markdownUris = await collectWorkspaceMarkdownUris();
	const locations: Location[] = [];

	for (const uri of markdownUris) {
		const doc = await getTextDocument(uri, 'markdown');
		if (!doc) {
			continue;
		}
		const text = doc.getText();
		const resolvedBibPath = resolveBibliographyPath(uri, text, workspaceRootPaths);
		if (!resolvedBibPath || !pathsEqual(resolvedBibPath, targetBibPath)) {
			continue;
		}

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

async function findReferencesInSingleDocument(key: string, uri: string): Promise<Location[]> {
	const doc = await getTextDocument(uri, 'markdown');
	if (!doc) {
		return [];
	}
	const locations: Location[] = [];
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
	return locations;
}

async function collectWorkspaceMarkdownUris(): Promise<string[]> {
	const uris = new Set<string>();

	for (const doc of documents.all()) {
		if (doc.languageId === 'markdown') {
			uris.add(doc.uri);
		}
	}

	for (const root of workspaceRootPaths) {
		await walkMarkdownFiles(root, uris);
	}

	return [...uris];
}

async function walkMarkdownFiles(rootDir: string, uris: Set<string>): Promise<void> {
	let entries: any[];
	try {
		entries = await fsp.readdir(rootDir, { withFileTypes: true, encoding: 'utf8' });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryName = typeof entry.name === 'string' ? entry.name : entry.name.toString();
		const fullPath = path.join(rootDir, entryName);
		if (entry.isDirectory()) {
			if (IGNORED_DIRS.has(entryName)) {
				continue;
			}
			await walkMarkdownFiles(fullPath, uris);
			continue;
		}
		if (entry.isFile() && entryName.toLowerCase().endsWith('.md')) {
			uris.add(fsPathToUri(fullPath));
		}
	}
}

function dedupeLocations(locations: Location[]): Location[] {
	const seen = new Set<string>();
	const deduped: Location[] = [];
	for (const location of locations) {
		const key = [
			location.uri,
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

const IGNORED_DIRS = new Set([
	'.git',
	'.svn',
	'.hg',
	'.idea',
	'.vscode',
	'node_modules',
	'out',
	'dist',
	'coverage',
]);
