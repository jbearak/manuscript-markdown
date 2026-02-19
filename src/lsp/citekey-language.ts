import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { BibtexEntry, parseBibtex } from '../bibtex-parser';
import { normalizeBibPath, parseFrontmatter } from '../frontmatter';

const CITATION_SEGMENT_RE = /\[[^\]]*@[^\]]*]/g;
const CITEKEY_RE = /@([A-Za-z0-9_:-]+)/g;

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

export function pathsEqual(a: string, b: string): boolean {
	return canonicalizeFsPath(a) === canonicalizeFsPath(b);
}

export function scanCitationUsages(text: string): CitekeyUsage[] {
	const usages: CitekeyUsage[] = [];
	let citationMatch: RegExpExecArray | null;

	CITATION_SEGMENT_RE.lastIndex = 0;
	while ((citationMatch = CITATION_SEGMENT_RE.exec(text)) !== null) {
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
	const usages: CitekeyUsage[] = [];
	let segMatch: RegExpExecArray | null;
	segRe.lastIndex = 0;
	while ((segMatch = segRe.exec(text)) !== null) {
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
		if (path.isAbsolute(bibFile)) {
			for (const workspaceRoot of workspaceRootPaths) {
				candidates.push(path.join(workspaceRoot, bibFile));
			}
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
