import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { BibtexEntry, parseBibtex, stripOuterBraces } from '../bibtex-parser';
import {
	analyzeCitationDocument,
	findCitationAtOffset,
	getCitationCompletionContextAtOffset,
	isInsideCitationSegmentAtOffset as scannerIsInsideCitationSegmentAtOffset,
	scanCitationDocument,
	type CitationCompletionContext,
	type CitationDocumentAnalysis,
	type CitationUsage,
} from '../citation-scanner';
import { Frontmatter, normalizeBibPath, parseFrontmatter } from '../frontmatter';

// --- Implementation notes ---
// - BibTeX key offsets: locate keys starting after opening `{`, not first substring match
//   in whole header
// - Local scan bounds: findCitekeyAtOffset() must not stop at newlines inside bracketed
//   citations; use nearest unclosed `[` and matching `]` for multi-line grouped citations
// - Bib reverse-map recovery: on .bib create/change, recheck open markdown docs not yet
//   in docToBibMap and backfill

const realpathNativeAsync = promisify(fs.realpath.native);

export class LruCache<K, V> {
	private map = new Map<K, V>();
	constructor(private maxSize: number) {}

	get size(): number {
		return this.map.size;
	}

	get(key: K): V | undefined {
		const v = this.map.get(key);
		if (v !== undefined) {
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}

	set(key: K, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.maxSize) {
			const first = this.map.keys().next().value;
			if (first !== undefined) this.map.delete(first);
		}
	}

	delete(key: K): void {
		this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}
}

export const canonicalCache = new LruCache<string, string>(256);

interface CachedCitationAnalysis {
	version: number;
	analysis: CitationDocumentAnalysis;
}

/** Per-open-document citation analysis keyed by the LSP document version. */
export class CitationAnalysisCache {
	private readonly entries = new Map<string, CachedCitationAnalysis>();

	get(uri: string, version: number, text: string): CitationDocumentAnalysis {
		const cached = this.entries.get(uri);
		if (cached?.version === version) return cached.analysis;
		const analysis = analyzeCitationDocument(text);
		this.entries.set(uri, { version, analysis });
		return analysis;
	}

	delete(uri: string): void {
		this.entries.delete(uri);
	}

	clear(): void {
		this.entries.clear();
	}
}

export type CitekeyUsage = CitationUsage;
export type CompletionContextAtOffset = CitationCompletionContext;

export interface ParsedBibData {
	filePath: string;
	text: string;
	entries: Map<string, BibtexEntry>;
	keyOffsets: Map<string, number>;
}

export function uriToFsPath(uri: string): string | undefined {
	if (!uri.startsWith('file://')) {
		return undefined;
	}
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

export function fsPathToUri(fsPath: string): string {
	return pathToFileURL(fsPath).toString();
}
export function canonicalizeFsPath(fsPath: string): string {
	let value = path.resolve(fsPath);
	try {
		value = fs.realpathSync.native(value);
	} catch {
		// keep resolved path when realpath cannot be resolved
	}
	value = path.normalize(value);
	if (process.platform === 'win32' || process.platform === 'darwin') {
		value = value.toLowerCase();
	}
	return value;
}

export async function canonicalizeFsPathAsync(fsPath: string): Promise<string> {
	const resolvedPath = path.resolve(fsPath);
	const cached = canonicalCache.get(resolvedPath);
	if (cached !== undefined) return cached;
	let value = resolvedPath;
	try {
		value = await realpathNativeAsync(value);
	} catch {
		// keep resolved path when realpath cannot be resolved
	}
	value = path.normalize(value);
	if (process.platform === 'win32' || process.platform === 'darwin') {
		value = value.toLowerCase();
	}
	canonicalCache.set(resolvedPath, value);
	return value;
}

export function invalidateCanonicalCache(fsPath: string): void {
	canonicalCache.delete(path.resolve(fsPath));
}



export function pathsEqual(a: string, b: string): boolean {
	return canonicalizeFsPath(a) === canonicalizeFsPath(b);
}

export function scanCitationUsages(
	text: string,
	analysis?: CitationDocumentAnalysis,
): CitekeyUsage[] {
	return scanCitationDocument(text, undefined, analysis).usages;
}

export function findUsagesForKey(
	text: string,
	key: string,
	analysis?: CitationDocumentAnalysis,
): CitekeyUsage[] {
	return scanCitationDocument(text, key, analysis).usages;
}

export function findCitekeyAtOffset(
	text: string,
	offset: number,
	analysis?: CitationDocumentAnalysis,
): string | undefined {
	return findCitationAtOffset(text, offset, analysis)?.key;
}

export function getCompletionContextAtOffset(
	text: string,
	offset: number,
	analysis?: CitationDocumentAnalysis,
): CompletionContextAtOffset | undefined {
	return getCitationCompletionContextAtOffset(text, offset, analysis);
}

export function resolveBibliographyPath(
	markdownUri: string,
	markdownText: string,
	workspaceRootPaths: string[]
): string | undefined {
	const markdownPath = uriToFsPath(markdownUri);
	if (!markdownPath) {
		return undefined;
	}

	const basePath = markdownPath.replace(/\.md$/i, '');
	const markdownDir = path.dirname(basePath);
	const { metadata } = parseFrontmatter(markdownText);

	const candidates: string[] = [];
	if (metadata.bibliography) {
		const bibFile = normalizeBibPath(metadata.bibliography);
		const isRootRelative = bibFile.startsWith('/');
		if (isRootRelative) {
			const rel = bibFile.slice(1);
			for (const workspaceRoot of workspaceRootPaths) {
				candidates.push(path.join(workspaceRoot, rel));
			}
			candidates.push(bibFile);
		} else if (path.isAbsolute(bibFile)) {
			candidates.push(bibFile);
		} else {
			candidates.push(path.join(markdownDir, bibFile));
			for (const workspaceRoot of workspaceRootPaths) {
				candidates.push(path.join(workspaceRoot, bibFile));
			}
		}
	}

	candidates.push(basePath + '.bib');

	const uniqueCandidates = [...new Set(candidates)];
	return uniqueCandidates.find(isExistingFile);
}

export async function resolveBibliographyPathAsync(
	markdownUri: string,
	markdownText: string,
	workspaceRootPaths: string[],
	metadata?: Frontmatter
): Promise<string | undefined> {
	const markdownPath = uriToFsPath(markdownUri);
	if (!markdownPath) {
		return undefined;
	}

	const basePath = markdownPath.replace(/\.md$/i, '');
	const markdownDir = path.dirname(basePath);
	const fm = metadata ?? parseFrontmatter(markdownText).metadata;

	const candidates: string[] = [];
	if (fm.bibliography) {
		const bibFile = normalizeBibPath(fm.bibliography);
		const isRootRelative = bibFile.startsWith('/');
		if (isRootRelative) {
			const rel = bibFile.slice(1);
			for (const workspaceRoot of workspaceRootPaths) {
				candidates.push(path.join(workspaceRoot, rel));
			}
			candidates.push(bibFile);
		} else if (path.isAbsolute(bibFile)) {
			candidates.push(bibFile);
		} else {
			candidates.push(path.join(markdownDir, bibFile));
			for (const workspaceRoot of workspaceRootPaths) {
				candidates.push(path.join(workspaceRoot, bibFile));
			}
		}
	}

	candidates.push(basePath + '.bib');

	const uniqueCandidates = [...new Set(candidates)];
	for (const c of uniqueCandidates) {
		if (await isExistingFileAsync(c)) return c;
	}
	return undefined;
}


export function parseBibDataFromText(filePath: string, text: string): ParsedBibData {
	const entries = parseBibtex(text);
	const keyOffsets = new Map<string, number>();
	const entryStartRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
	let match: RegExpExecArray | null;
	while ((match = entryStartRe.exec(text)) !== null) {
		const key = match[2];
		if (!keyOffsets.has(key)) {
			const bracePos = match[0].indexOf('{');
			const offsetInMatch = bracePos >= 0 ? match[0].indexOf(key, bracePos + 1) : -1;
			if (offsetInMatch >= 0) {
				keyOffsets.set(key, match.index + offsetInMatch);
			}
		}
	}

	return { filePath, text, entries, keyOffsets };
}

export function findBibKeyAtOffset(parsedBib: ParsedBibData, offset: number): string | undefined {
	for (const [key, start] of parsedBib.keyOffsets) {
		if (offset >= start && offset <= start + key.length) {
			return key;
		}
	}
	return undefined;
}
export function isInsideCitationSegmentAtOffset(
	text: string,
	atOffset: number,
	analysis?: CitationDocumentAnalysis,
): boolean {
	return scannerIsInsideCitationSegmentAtOffset(text, atOffset, analysis);
}

function isExistingFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

async function isExistingFileAsync(filePath: string): Promise<boolean> {
	try {
		return (await fsp.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

export interface BibFieldLinkValid {
	fieldName: string;
	value: string;
	url: string;
	label: string;
	invalid?: false;
}

export interface BibFieldLinkInvalid {
	fieldName: string;
	value: string;
	url?: undefined;
	label: string;
	invalid: true;
}

export type BibFieldLink = BibFieldLinkValid | BibFieldLinkInvalid;

const BIB_FIELD_LINK_RE = /^\s*(doi|isbn|issn|url)\s*=\s*[{"]\s*([^}"]+?)\s*[}"]/i;

// DOIs: digits, letters, dots, slashes, hyphens, underscores, colons, semicolons, parens
const VALID_DOI_RE = /^10\.\d{4,}[/.][A-Za-z0-9./_\-:;()]+$/;
// ISBNs: digits and hyphens (ISBN-10 or ISBN-13), check digit may be X
const VALID_ISBN_RE = /^[\d-]{9,17}[\dXx]$/;
// ISSNs: 4 digits, hyphen, 3 digits, check digit (digit or X)
const VALID_ISSN_RE = /^\d{4}-?\d{3}[\dXx]$/;

const VALID_URL_RE = /^https?:\/\/\S+$/i;

export function buildBibFieldLink(fieldName: string, rawValue: string): BibFieldLink | undefined {
	const name = fieldName.toLowerCase();
	const value = rawValue.trim().replace(/^\{+|\}+$/g, '').trim();
	if (!value) return undefined;

	switch (name) {
		case 'doi':
			if (!VALID_DOI_RE.test(value)) {
				return { fieldName: name, value, label: `Invalid DOI: ${value}`, invalid: true };
			}
			return { fieldName: name, value, url: 'https://doi.org/' + value.replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()), label: 'Access via DOI' };
		case 'isbn':
			if (!VALID_ISBN_RE.test(value)) {
				return { fieldName: name, value, label: `Invalid ISBN: ${value}`, invalid: true };
			}
			return { fieldName: name, value, url: 'https://search.worldcat.org/isbn/' + value, label: 'Look up ISBN' };
		case 'issn':
			if (!VALID_ISSN_RE.test(value)) {
				return { fieldName: name, value, label: `Invalid ISSN: ${value}`, invalid: true };
			}
			return { fieldName: name, value, url: 'https://portal.issn.org/resource/ISSN/' + value, label: 'Look up ISSN' };
		case 'url':
			if (!VALID_URL_RE.test(value)) {
				return { fieldName: name, value, label: `Invalid URL: ${value}`, invalid: true };
			}
			return { fieldName: name, value, url: value, label: 'Access via URL' };
		default:
			return undefined;
	}
}

export function getAccessLinksForEntry(entry: BibtexEntry): BibFieldLinkValid[] {
	const links: BibFieldLinkValid[] = [];
	for (const field of ['doi', 'isbn', 'issn', 'url'] as const) {
		const value = entry.fields.get(field);
		if (value) {
			const link = buildBibFieldLink(field, value);
			if (link && !link.invalid) {
				links.push(link);
			}
		}
	}
	return links;
}

export function findBibFieldLinkAtLine(lineText: string): BibFieldLink | undefined {
	const match = BIB_FIELD_LINK_RE.exec(lineText);
	if (!match) return undefined;

	const fieldName = match[1].toLowerCase();
	const value = match[2].trim();
	if (!value) return undefined;

	return buildBibFieldLink(fieldName, value);
}

// --- File field support ---

export interface BibFileEntry {
	description: string;
	filePath: string;
	fileType: string;
	fileName: string; // basename for display
}

const BIB_FILE_FIELD_RE = /^\s*file\s*=\s*[{"]\s*([^}"]+?)\s*[}"]/i;

/**
 * Split a string on unescaped occurrences of `sep`.
 * Backslash-escaped separators (`\:`, `\;`) are treated as literal characters.
 */
function splitOnUnescaped(str: string, sep: string): string[] {
	const parts: string[] = [];
	let current = '';
	for (let i = 0; i < str.length; i++) {
		if (str[i] === '\\' && i + 1 < str.length && str[i + 1] === sep) {
			current += sep;
			i++;
		} else if (str[i] === sep) {
			parts.push(current);
			current = '';
		} else {
			current += str[i];
		}
	}
	parts.push(current);
	return parts;
}

/**
 * Parse a BibTeX file field value into individual file entries.
 * Format: `Description:Path:Type` with entries separated by `;`.
 * Colons and semicolons in paths can be escaped with backslash.
 */
export function parseFileFieldValue(rawValue: string): BibFileEntry[] {
	const value = stripOuterBraces(rawValue.trim()).trim();
	if (!value) return [];

	const entries: BibFileEntry[] = [];
	for (const segment of splitOnUnescaped(value, ';')) {
		const trimmed = segment.trim();
		if (!trimmed) continue;

		const parts = splitOnUnescaped(trimmed, ':');
		let description = '';
		let filePath: string;
		let fileType = '';

		if (parts.length >= 3) {
			// Standard format: Description:Path:Type
			// Path may contain colons (e.g. Windows drive letter), so join middle parts
			const first = parts[0].trim();
			fileType = parts[parts.length - 1].trim();
			// Detect bare Windows drive letter: single letter followed by /path
			if (first.length === 1 && /^[A-Za-z]$/.test(first) && parts.length >= 3
				&& /^[/\\]/.test(parts[1])) {
				// No description — first part is the drive letter
				filePath = parts.slice(0, -1).join(':').trim();
			} else {
				description = first;
				filePath = parts.slice(1, -1).join(':').trim();
			}
		} else if (parts.length === 2) {
			// Two parts: treat as Path:Type
			filePath = parts[0].trim();
			fileType = parts[1].trim();
		} else {
			// Single value: treat as just a path
			filePath = trimmed;
		}

		if (!filePath) continue;

		const fileName = path.basename(filePath);
		entries.push({ description, filePath, fileType, fileName });
	}

	return entries;
}

/** Check whether a .bib line is a file field and return parsed file entries. */
export function findBibFileFieldAtLine(lineText: string): BibFileEntry[] | undefined {
	const match = BIB_FILE_FIELD_RE.exec(lineText);
	if (!match) return undefined;
	const entries = parseFileFieldValue(match[1]);
	return entries.length > 0 ? entries : undefined;
}

/** Extract file entries from a BibtexEntry's file field. */
export function getFileEntriesForEntry(entry: BibtexEntry): BibFileEntry[] {
	const fileValue = entry.fields.get('file');
	if (!fileValue) return [];
	return parseFileFieldValue(fileValue);
}

/**
 * Build a display name for a file entry.
 * Uses the description if provided, otherwise the filename.
 */
export function fileEntryDisplayName(file: BibFileEntry): string {
	return file.description || file.fileName;
}

/** Platform-specific label for the "reveal in file manager" action. */
export function getRevealLabel(): string {
	return process.platform === 'darwin' ? 'Show in Finder'
		: process.platform === 'win32' ? 'Show in Explorer'
		: 'Show in File Manager';
}

/**
 * Format a single file entry as markdown with command URIs.
 * `absolutePath` must already be resolved.
 */
export function formatFileEntryMarkdown(displayName: string, absolutePath: string): string {
	const args = encodeURIComponent(JSON.stringify([absolutePath]));
	const escapedName = displayName.replace(/[[\]\\*_`]/g, '\\$&');
	const openLink = `[Open file](command:manuscript-markdown.openBibFile?${args})`;
	const revealLink = `[${getRevealLabel()}](command:manuscript-markdown.revealBibFile?${args})`;
	return `**${escapedName}** \u2014 ${openLink} \u00B7 ${revealLink}`;
}

/**
 * Resolve a file entry's path relative to a bib file directory.
 */
export function resolveFileEntryPath(filePath: string, bibDir: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(bibDir, filePath);
}

