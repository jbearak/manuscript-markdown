import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { BibtexEntry, BibtexSourceRange, parseBibtexWithRaw, stripOuterBraces } from '../bibtex-parser';
import { isCitableKey, isCitationKeyChar, isCrossRefKey, readCitationItems } from '../citation-syntax';
import { computeCodeRegions, isInsideCodeRegion, type CodeRegion } from '../code-regions';
import { Frontmatter, normalizeBibPath, parseFrontmatter } from '../frontmatter';

// --- Implementation notes ---
// - BibTeX key offsets: locate keys starting after opening `{`, not first substring match
//   in whole header
// - Local scan bounds: findCitekeyAtOffset() must not stop at newlines inside bracketed
//   citations; use nearest unclosed `[` and matching `]` for multi-line grouped citations
// - Bib reverse-map recovery: on .bib create/change, recheck open markdown docs not yet
//   in docToBibMap and backfill

const realpathNativeAsync = promisify(fs.realpath.native);

const CITATION_SEGMENT_RE = /\[[^\]]*@[^\]]*]/g;
// A segment over more than one line, which export can read as more than one
// block, as across a blank line, a heading or a blockquote's markers, has
// its keys read as the server read every key before it read them as export
// does: each @'s run of letters, digits, _, : and -
const LINE_END_RE = /[\r\n]/;
const CITEKEY_RE = /@([A-Za-z0-9_:-]+)/g;

/** The [ of the citation that ends at the ] at `close` in `scanText`, of
 *  the [s from `start`, as export's citationEnd tries them: the first where
 *  the text after it starts with an @ or a -@, or has no other [ before the
 *  ], so in `[text [@smith2020]` the inner one. No [ the segment's regex
 *  reads has a ] after it before `close`, so each citation export reads
 *  from one ends there too. */
function citationOpen(scanText: string, start: number, close: number): number {
	let at = start;
	for (;;) {
		if (/^-?@/.test(scanText.slice(at + 1, at + 3))) return at;
		const next = scanText.indexOf('[', at + 1);
		if (next === -1 || next > close) return at;
		at = next;
	}
}

/** Replace all characters inside code regions with spaces, preserving offsets. */
function blankCodeRegions(text: string, regions: CodeRegion[]): string {
	if (regions.length === 0) return text;
	const chars = text.split('');
	for (const r of regions) {
		for (let i = r.start; i < r.end && i < chars.length; i++) {
			chars[i] = ' ';
		}
	}
	return chars.join('');
}

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


export interface CitekeyUsage {
	key: string;
	keyStart: number;
	keyEnd: number;
}

export interface CompletionContextAtOffset {
	prefix: string;
	replaceStart: number;
	atOffset: number;
}

export interface ParsedBibData {
	filePath: string;
	text: string;
	entries: Map<string, BibtexEntry>;
	/** Every delimited entry occurrence, in source order — see
	 *  `BibtexSourceRange`. Repeated keys appear once per occurrence.
	 *  Navigation deliberately uses all of these, including ones marked
	 *  `trusted: false`: while a user is mid-edit with a brace temporarily
	 *  missing, a best-effort location still beats no location at all. Only
	 *  byte-level mutation needs to filter on `trusted`. */
	ranges: BibtexSourceRange[];
	/** First declaration offset of each citation key, derived from `ranges`. */
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

export function scanCitationUsages(text: string): CitekeyUsage[] {
	// Neutralize code regions so the bracket regex can't start matching from
	// inside a code span (e.g. `[ ` [@a] — the `[` inside backticks must not
	// anchor a bracket group that extends past the code span).
	return scanBlankedCitationUsages(blankCodeRegions(text, computeCodeRegions(text)));
}

/** The keys main read in a segment's text, `inner`, from `offset`, over
 *  more than one line (see LINE_END_RE) */
function multilineUsages(inner: string, offset: number): CitekeyUsage[] {
	const usages: CitekeyUsage[] = [];
	let keyMatch: RegExpExecArray | null;
	CITEKEY_RE.lastIndex = 0;
	while ((keyMatch = CITEKEY_RE.exec(inner)) !== null) {
		const key = keyMatch[1];
		// A cross-reference's, which cites nothing
		if (isCrossRefKey(key)) continue;
		const keyStart = offset + keyMatch.index + 1;
		usages.push({ key, keyStart, keyEnd: keyStart + key.length });
	}
	return usages;
}

/** The citekeys in `scanText`, whose code regions are already blanked: in
 *  a segment on one line, as export reads them, and in one over more than
 *  one line, as `readMultiline` reads them, main's reading by default */
function scanBlankedCitationUsages(
	scanText: string,
	readMultiline: (inner: string, offset: number) => CitekeyUsage[] = multilineUsages,
): CitekeyUsage[] {
	const usages: CitekeyUsage[] = [];
	let citationMatch: RegExpExecArray | null;

	CITATION_SEGMENT_RE.lastIndex = 0;
	while ((citationMatch = CITATION_SEGMENT_RE.exec(scanText)) !== null) {
		const segment = citationMatch[0];
		if (LINE_END_RE.test(segment)) {
			for (const usage of readMultiline(segment.slice(1, -1), citationMatch.index + 1)) usages.push(usage);
			continue;
		}
		// The citation's own [, which in `[text [@smith2020]` isn't the
		// segment's first
		const close = citationMatch.index + segment.length - 1;
		const open = citationOpen(scanText, citationMatch.index, close);
		const segmentOffset = open + 1;
		// Each item's key as export reads it (see readCitationItem), where an
		// @ marks it
		const items = readCitationItems(scanText.slice(open + 1, close));
		// A cross-reference's key cites nothing, nor does any other key in
		// brackets with one, which are text (see crossRefAt)
		if (items.some(item => item.markStart !== -1 && isCrossRefKey(item.key))) continue;
		for (const item of items) {
			if (item.markStart === -1 || !item.key) continue;
			const keyStart = segmentOffset + item.itemStart + item.keyStart;
			usages.push({
				key: item.key,
				keyStart,
				keyEnd: keyStart + item.key.length,
			});
		}
	}

	return usages;
}

export function findUsagesForKey(text: string, key: string): CitekeyUsage[] {
	// In a segment over more than one line, as main found a key: each @
	// with the key after it, and no letter, digit, _, : or - after that
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const keyRe = new RegExp('@' + escaped + '(?![A-Za-z0-9_:-])', 'g');
	const multiline = (inner: string, offset: number): CitekeyUsage[] => {
		const usages: CitekeyUsage[] = [];
		let keyMatch: RegExpExecArray | null;
		keyRe.lastIndex = 0;
		while ((keyMatch = keyRe.exec(inner)) !== null) {
			const keyStart = offset + keyMatch.index + 1;
			usages.push({ key, keyStart, keyEnd: keyStart + key.length });
		}
		return usages;
	};
	return scanBlankedCitationUsages(blankCodeRegions(text, computeCodeRegions(text)), multiline).filter(usage => usage.key === key);
}

export function findCitekeyAtOffset(text: string, offset: number): string | undefined {
	if (offset < 0 || offset >= text.length) return undefined;
	// The brackets and keys of the text with its code blanked, as
	// scanCitationUsages reads them: a ] in code ends no citation, and code
	// the scanned segment cuts in two is still code. And not undefined at
	// once where the offset is in code, since a cursor there can be just
	// past a key that code follows.
	const scanText = blankCodeRegions(text, computeCodeRegions(text));
	const maxScanDistance = 500;
	let scanStart = offset;
	let scanEnd = offset;

	// Prefer a nearby bracket-bounded scan (can span newlines).
	// Walk backward past unclosed '[' to find the outermost one, since
	// the citation regex [^\]]*@[^\]]*] can match inner '[' characters.
	let openBracket = scanText.lastIndexOf('[', offset);
	while (openBracket > 0) {
		const prevOpen = scanText.lastIndexOf('[', openBracket - 1);
		const prevClose = scanText.lastIndexOf(']', openBracket - 1);
		if (prevOpen !== -1 && prevOpen > prevClose && (offset - prevOpen) <= maxScanDistance) {
			openBracket = prevOpen;
		} else {
			break;
		}
	}
	const closeBracketBefore = scanText.lastIndexOf(']', Math.max(0, offset - 1));
	if (openBracket !== -1 && openBracket > closeBracketBefore && (offset - openBracket) <= maxScanDistance) {
		const closeBracket = scanText.indexOf(']', offset);
		if (closeBracket !== -1 && (closeBracket - offset) <= maxScanDistance) {
			scanStart = openBracket;
			scanEnd = closeBracket + 1;
		}
	}

	// Fallback: same-line bounded scan when no nearby bracket segment is found.
	if (scanStart === offset && scanEnd === offset) {
		while (scanStart > 0 && scanText[scanStart - 1] !== '[' && scanText[scanStart - 1] !== '\n') {
			scanStart--;
		}
		if (scanStart > 0 && scanText[scanStart - 1] === '[') scanStart--;

		while (scanEnd < text.length && scanText[scanEnd] !== ']' && scanText[scanEnd] !== '\n') {
			scanEnd++;
		}
		if (scanEnd < text.length && scanText[scanEnd] === ']') scanEnd++;
	}

	const segment = scanText.slice(scanStart, scanEnd);
	for (const usage of scanBlankedCitationUsages(segment)) {
		const absStart = usage.keyStart + scanStart;
		const absEnd = usage.keyEnd + scanStart;
		if (offset >= absStart - 1 && offset <= absEnd) {
			return usage.key;
		}
	}
	return undefined;
}

export function getCompletionContextAtOffset(text: string, offset: number): CompletionContextAtOffset | undefined {
	if (offset < 0 || offset > text.length) {
		return undefined;
	}

	const codeRegions = computeCodeRegions(text);
	if (isInsideCodeRegion(offset, codeRegions)) {
		return undefined;
	}

	let replaceStart = offset;
	while (replaceStart > 0 && isCitationKeyChar(text.charAt(replaceStart - 1))) {
		replaceStart--;
	}

	const atOffset = replaceStart - 1;
	if (atOffset < 0 || text.charAt(atOffset) !== '@') {
		return undefined;
	}
	if (!isInsideCitationSegmentAtOffset(text, atOffset) && !isBareCitationContext(text, atOffset)) {
		return undefined;
	}

	return {
		prefix: text.slice(replaceStart, offset),
		replaceStart,
		atOffset,
	};
}

/**
 * The files the server tries, in order, for the bibliography written in
 * frontmatter, as `bibliography: refs/library`, with `.bib` added where it
 * has none (see normalizeBibPath): a relative path in `markdownDir`, then in
 * each workspace root; a path that starts with `/` in each workspace root,
 * then as written; any other absolute path as written.
 */
export function writtenBibliographyCandidates(
	bibliography: string,
	markdownDir: string,
	workspaceRootPaths: readonly string[],
): string[] {
	const bibFile = normalizeBibPath(bibliography);
	const candidates: string[] = [];
	if (bibFile.startsWith('/')) {
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
	return candidates;
}

/**
 * The files the server tries, in order and each once, for the bibliography
 * of the Markdown file at `markdownPath`: those of the bibliography written
 * in its frontmatter, if any (see writtenBibliographyCandidates), then, with
 * `fallback`, the file of its name with `.bib` for `.md`.
 */
function bibliographyCandidates(
	markdownPath: string,
	bibliography: string | undefined,
	workspaceRootPaths: readonly string[],
	fallback: boolean,
): string[] {
	const basePath = markdownPath.replace(/\.md$/i, '');
	const candidates = bibliography ? writtenBibliographyCandidates(bibliography, path.dirname(basePath), workspaceRootPaths) : [];
	if (fallback) candidates.push(basePath + '.bib');
	return [...new Set(candidates)];
}

async function firstExistingFileAsync(candidates: readonly string[]): Promise<string | undefined> {
	for (const c of candidates) {
		if (await isExistingFileAsync(c)) return c;
	}
	return undefined;
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
	const { metadata } = parseFrontmatter(markdownText);
	return bibliographyCandidates(markdownPath, metadata.bibliography, workspaceRootPaths, true).find(isExistingFile);
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
	const fm = metadata ?? parseFrontmatter(markdownText).metadata;
	return firstExistingFileAsync(bibliographyCandidates(markdownPath, fm.bibliography, workspaceRootPaths, true));
}

/**
 * The file the server resolves for `bibliography` as written in the
 * frontmatter of the Markdown file at `markdownUri`, as
 * resolveBibliographyPathAsync does but without its fallback to the file of
 * the document's name: the first of its candidates that exists, or
 * undefined where none does.
 */
export async function resolveWrittenBibliographyPathAsync(
	markdownUri: string,
	bibliography: string,
	workspaceRootPaths: readonly string[],
): Promise<string | undefined> {
	const markdownPath = uriToFsPath(markdownUri);
	if (!markdownPath) {
		return undefined;
	}
	return firstExistingFileAsync(bibliographyCandidates(markdownPath, bibliography, workspaceRootPaths, false));
}


export function parseBibDataFromText(filePath: string, text: string): ParsedBibData {
	// One scan supplies entries, ranges, and key offsets. Deriving offsets from
	// the parser's ranges (rather than re-scanning for `@type{key,`) keeps them
	// honest: a `@book{ref1,` inside a note field is not a declaration, and an
	// entry whose closing brace is missing has no location worth jumping to.
	const { parsed, ranges } = parseBibtexWithRaw(text);
	const keyOffsets = new Map<string, number>();
	for (const range of ranges) {
		// First occurrence wins — that is the declaration a lookup should reach.
		if (!keyOffsets.has(range.key)) keyOffsets.set(range.key, range.keyStart);
	}

	return { filePath, text, entries: parsed, ranges, keyOffsets };
}

/** The keys of a .bib file's entries, as the parser read them (`ranges`),
 *  that no Markdown citation can cite, as one with a ; or a ], which ends
 *  its item or its citation there, or a backtick (see isCitableKey) */
export function findUncitableBibKeys(ranges: readonly BibtexSourceRange[]): BibtexSourceRange[] {
	return ranges.filter(range => !isCitableKey(range.key));
}

/** The entries of a .bib file, as the parser read them (`ranges`), that give
 *  a field more than once, which BibTeX reads the first of, but biber and
 *  this extension the last (see BibtexSourceRange.repeatedFields) */
export function findRepeatedBibFields(
	ranges: readonly BibtexSourceRange[],
): Array<BibtexSourceRange & { repeatedFields: string[] }> {
	return ranges.filter((range): range is BibtexSourceRange & { repeatedFields: string[] } => range.repeatedFields !== undefined);
}

export function findBibKeyAtOffset(parsedBib: ParsedBibData, offset: number): string | undefined {
	for (const [key, start] of parsedBib.keyOffsets) {
		if (offset >= start && offset <= start + key.length) {
			return key;
		}
	}
	return undefined;
}
export function isInsideCitationSegmentAtOffset(text: string, atOffset: number): boolean {
	const openBracket = text.lastIndexOf('[', atOffset);
	if (openBracket === -1) {
		return false;
	}
	const closedBefore = text.lastIndexOf(']', atOffset);
	if (closedBefore > openBracket) {
		return false;
	}
	const lineEnd = text.indexOf('\n', openBracket + 1);
	const sameLineEnd = lineEnd !== -1 ? lineEnd : text.length;
	const closeBracket = text.indexOf(']', openBracket + 1);
	// Only use ] as segment end if it's on the same line as [
	const closeBracketOnSameLine = closeBracket !== -1 && closeBracket < sameLineEnd ? closeBracket : -1;
	const segmentEnd = closeBracketOnSameLine !== -1 ? closeBracketOnSameLine : sameLineEnd;
	if (atOffset > segmentEnd) {
		return false;
	}
	const inside = text.slice(openBracket + 1, segmentEnd);
	return inside.includes('@');
}

/** Bare/inline citation: @key outside brackets (valid Pandoc syntax). */
function isBareCitationContext(text: string, atOffset: number): boolean {
	if (atOffset > 0 && /[A-Za-z0-9._\-\/+=`]/.test(text.charAt(atOffset - 1))) {
		return false;
	}
	return true;
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

