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

export function findCitekeyAtOffset(text: string, offset: number): string | undefined {
	for (const usage of scanCitationUsages(text)) {
		if (offset >= usage.keyStart - 1 && offset <= usage.keyEnd) {
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
	if (!isInsideCitationSegment(text, atOffset)) {
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

function isInsideCitationSegment(text: string, atOffset: number): boolean {
	const openBracket = text.lastIndexOf('[', atOffset);
	if (openBracket === -1) {
		return false;
	}
	const closedBefore = text.lastIndexOf(']', atOffset);
	if (closedBefore > openBracket) {
		return false;
	}
	const lineEnd = text.indexOf('\n', openBracket + 1);
	const closeBracket = text.indexOf(']', openBracket + 1);
	if (lineEnd !== -1 && closeBracket !== -1 && lineEnd < closeBracket) {
		return false;
	}
	const segmentEnd = closeBracket !== -1 ? closeBracket : (lineEnd !== -1 ? lineEnd : text.length);
	if (atOffset > segmentEnd) {
		return false;
	}
	const inside = text.slice(openBracket + 1, segmentEnd);
	return inside.includes('@');
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
