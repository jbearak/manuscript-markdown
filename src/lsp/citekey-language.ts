import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { BibtexEntry, parseBibtex } from '../bibtex-parser';
import { computeCodeRegions, isInsideCodeRegion, overlapsCodeRegion } from '../code-regions';
import { Frontmatter, normalizeBibPath, parseFrontmatter } from '../frontmatter';

const realpathNativeAsync = promisify(fs.realpath.native);

const CITATION_SEGMENT_RE = /\[[^\]]*@[^\]]*]/g;
const CITEKEY_RE = /@([A-Za-z0-9_:-]+)/g;

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
	const usages: CitekeyUsage[] = [];
	const codeRegions = computeCodeRegions(text);
	let citationMatch: RegExpExecArray | null;

	CITATION_SEGMENT_RE.lastIndex = 0;
	while ((citationMatch = CITATION_SEGMENT_RE.exec(text)) !== null) {
		// Skip citation segments that overlap code regions
		if (overlapsCodeRegion(citationMatch.index, citationMatch.index + citationMatch[0].length, codeRegions)) {
			continue;
		}
		const segment = citationMatch[0];
		const segmentOffset = citationMatch.index + 1;
		const inner = segment.slice(1, -1);
		let keyMatch: RegExpExecArray | null;
		CITEKEY_RE.lastIndex = 0;
		while ((keyMatch = CITEKEY_RE.exec(inner)) !== null) {
			const key = keyMatch[1];
			const keyStart = segmentOffset + keyMatch.index + 1;
			usages.push({
				key,
				keyStart,
				keyEnd: keyStart + key.length,
			});
		}
	}

	return usages;
}

export function findUsagesForKey(text: string, key: string): CitekeyUsage[] {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const segRe = /\[[^\]]*@[^\]]*\]/g;
	const keyRe = new RegExp(`@${escaped}(?![A-Za-z0-9_:-])`, 'g');
	const codeRegions = computeCodeRegions(text);
	const usages: CitekeyUsage[] = [];
	let segMatch: RegExpExecArray | null;
	segRe.lastIndex = 0;
	while ((segMatch = segRe.exec(text)) !== null) {
		if (overlapsCodeRegion(segMatch.index, segMatch.index + segMatch[0].length, codeRegions)) {
			continue;
		}
		const inner = segMatch[0].slice(1, -1);
		const segmentOffset = segMatch.index + 1;
		keyRe.lastIndex = 0;
		let keyMatch: RegExpExecArray | null;
		while ((keyMatch = keyRe.exec(inner)) !== null) {
			const keyStart = segmentOffset + keyMatch.index + 1;
			usages.push({ key, keyStart, keyEnd: keyStart + key.length });
		}
	}
	return usages;
}

export function findCitekeyAtOffset(text: string, offset: number): string | undefined {
	if (offset < 0 || offset >= text.length) return undefined;
	const codeRegions = computeCodeRegions(text);
	if (isInsideCodeRegion(offset, codeRegions)) return undefined;
	const maxScanDistance = 500;
	let scanStart = offset;
	let scanEnd = offset;

	// Prefer a nearby bracket-bounded scan (can span newlines).
	const openBracket = text.lastIndexOf('[', offset);
	const closeBracketBefore = text.lastIndexOf(']', Math.max(0, offset - 1));
	if (openBracket !== -1 && openBracket > closeBracketBefore && (offset - openBracket) <= maxScanDistance) {
		const closeBracket = text.indexOf(']', offset);
		if (closeBracket !== -1 && (closeBracket - offset) <= maxScanDistance) {
			scanStart = openBracket;
			scanEnd = closeBracket + 1;
		}
	}

	// Fallback: same-line bounded scan when no nearby bracket segment is found.
	if (scanStart === offset && scanEnd === offset) {
		while (scanStart > 0 && text[scanStart - 1] !== '[' && text[scanStart - 1] !== '\n') {
			scanStart--;
		}
		if (scanStart > 0 && text[scanStart - 1] === '[') scanStart--;

		while (scanEnd < text.length && text[scanEnd] !== ']' && text[scanEnd] !== '\n') {
			scanEnd++;
		}
		if (scanEnd < text.length && text[scanEnd] === ']') scanEnd++;
	}

	const segment = text.slice(scanStart, scanEnd);
	for (const usage of scanCitationUsages(segment)) {
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
	while (replaceStart > 0 && isCitekeyChar(text.charAt(replaceStart - 1))) {
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

function isCitekeyChar(ch: string | undefined): boolean {
	return ch !== undefined && /^[A-Za-z0-9_:-]$/.test(ch);
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

