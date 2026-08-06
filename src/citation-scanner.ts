import MarkdownIt from 'markdown-it';
import { computeCodeRegions } from './code-regions';
import { findCitationFrontmatterBounds } from './frontmatter';
import {
	isBoundaryValidNociteToken,
	isCitekeyChar,
	isEmailSeparatorAt,
	isEscaped,
	isTopLevelFrontmatterMappingLine,
	parseBracketCitationItems,
	previousCodePoint,
	readMarkdownCitekey,
	scanNociteTokens,
	type BracketCitationItem,
	yamlValueBeforeComment,
} from './citekey';

export type CitationForm = 'bracket' | 'bare' | 'nocite';

export interface CitationUsage {
	key: string;
	atStart: number;
	keyStart: number;
	keyEnd: number;
	form: CitationForm;
	suppressAuthor: boolean;
}

export interface CitationDocumentScan {
	usages: CitationUsage[];
	hasNociteWildcard: boolean;
}

export interface CitationCompletionContext {
	prefix: string;
	replaceStart: number;
	atOffset: number;
	form: CitationForm;
}

export interface CitationOffsetRange {
	start: number;
	end: number;
}

type OffsetRange = CitationOffsetRange;

interface NociteRegion extends OffsetRange {
	blockScalar: boolean;
}

export interface CitationBracketAnalysis {
	/** Every @ offset inside an escape-aware bracket stack, closed or unfinished. */
	contexts: ReadonlyMap<number, CitationOffsetRange>;
	/** The subset whose opening bracket has a balanced closing bracket. */
	balancedContexts: ReadonlyMap<number, CitationOffsetRange>;
	/** Escape-aware opening bracket offset to its exclusive balanced close. */
	closingOffsets: ReadonlyMap<number, number>;
	/** Balanced ranges sorted by opening offset for arbitrary point queries. */
	balancedRanges: readonly CitationOffsetRange[];
}

export interface CitationDocumentAnalysis {
	text: string;
	usages: readonly CitationUsage[];
	hasNociteWildcard: boolean;
	excludedRanges: readonly CitationOffsetRange[];
	referenceLabels: ReadonlySet<string>;
	inlineLinkLabels: ReadonlySet<string>;
	brackets: CitationBracketAnalysis;
	bracketItems: ReadonlyMap<number, BracketCitationItem>;
	nociteRegions: readonly CitationOffsetRange[];
}

const BARE_LEFT_EXCLUSION_RE = /[\p{L}\p{M}\p{N}._:\-\/+\x3d`]/u;
const BODY_LEFT_EXCLUSION_RE = /[\p{L}\p{M}\p{N}._\/+\x3d`]/u;
const referenceMarkdownIt = new MarkdownIt({ html: true, linkify: true });

function mergeRanges(ranges: OffsetRange[]): OffsetRange[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: OffsetRange[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		const previous = merged[merged.length - 1];
		if (current.start <= previous.end) previous.end = Math.max(previous.end, current.end);
		else merged.push({ ...current });
	}
	return merged;
}

function selectOutermostRanges(ranges: OffsetRange[]): OffsetRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
	const selected: OffsetRange[] = [];
	for (const range of sorted) {
		const previous = selected[selected.length - 1];
		if (previous && range.start < previous.end) continue;
		selected.push({ ...range });
	}
	return selected;
}

function rangeContaining(offset: number, ranges: readonly OffsetRange[]): OffsetRange | undefined {
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const mid = (low + high) >>> 1;
		const range = ranges[mid];
		if (offset < range.start) high = mid - 1;
		else if (offset >= range.end) low = mid + 1;
		else return range;
	}
	return undefined;
}

function lineRanges(text: string): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf('\n', start);
		const end = newline === -1 ? text.length : newline + 1;
		ranges.push({ start, end });
		if (newline === -1) break;
		start = end;
	}
	return ranges;
}

function maskRanges(text: string, ranges: readonly OffsetRange[]): string {
	if (ranges.length === 0) return text;
	const chars = text.split('');
	for (const range of ranges) {
		for (let i = range.start; i < range.end; i++) {
			if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
		}
	}
	return chars.join('');
}

function computeHtmlCommentRegions(text: string): OffsetRange[] {
	const regions: OffsetRange[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf('<!--', cursor);
		if (start === -1) break;
		const close = text.indexOf('-->', start + 4);
		const end = close === -1 ? text.length : close + 3;
		regions.push({ start, end });
		cursor = end;
	}
	return regions;
}

function computeHtmlTagRegions(text: string): OffsetRange[] {
	const regions: OffsetRange[] = [];
	for (let start = 0; start < text.length - 1; start++) {
		if (text[start] !== '<' || !/[A-Za-z/!?]/.test(text[start + 1])) continue;
		// Once no raw closer remains, no later tag-like opener can succeed either.
		if (text.indexOf('>', start + 1) === -1) break;
		let quote: '"' | "'" | undefined;
		let cursor = start + 1;
		let closed = false;
		for (; cursor < text.length; cursor++) {
			const char = text[cursor];
			if (quote) {
				if (char === quote) quote = undefined;
				continue;
			}
			if (char === '"' || char === "'") quote = char;
			else if (char === '>') {
				cursor++;
				closed = true;
				break;
			}
		}
		if (!closed) continue;
		regions.push({ start, end: cursor });
		start = Math.max(start, cursor - 1);
	}
	return regions;
}

function isLinkSpace(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isRawDestinationBreak(char: string, escaped = false): boolean {
	const code = char.charCodeAt(0);
	return code === 0x20 || (!escaped && (code < 0x20 || code === 0x7F));
}

function isValidInlineLinkContent(text: string, start: number, end: number): boolean {
	let cursor = start;
	while (cursor < end && isLinkSpace(text[cursor])) cursor++;
	if (cursor === end) return true;

	if (text[cursor] === '<') {
		cursor++;
		let closed = false;
		for (; cursor < end;) {
			const char = text[cursor];
			if (char === '\n' || char === '\r' || char === '<') return false;
			if (char === '>') {
				cursor++;
				closed = true;
				break;
			}
			cursor += char === '\\' && cursor + 1 < end ? 2 : 1;
		}
		if (!closed) return false;
	} else {
		const destinationStart = cursor;
		let depth = 0;
		for (; cursor < end;) {
			const char = text[cursor];
			if (isRawDestinationBreak(char)) break;
			if (char === '\\' && cursor + 1 < end) {
				if (text[cursor + 1] === ' ') break;
				cursor += 2;
				continue;
			}
			if (char === '(' && ++depth > 32) return false;
			if (char === ')') {
				if (depth === 0) return false;
				depth--;
			}
			cursor++;
		}
		if (cursor === destinationStart || depth !== 0) return false;
	}

	while (cursor < end && isLinkSpace(text[cursor])) cursor++;
	if (cursor === end) return true;
	const opener = text[cursor];
	const closer = opener === '(' ? ')' : opener;
	if (opener !== '"' && opener !== "'" && opener !== '(') return false;
	cursor++;
	let escaped = false;
	for (; cursor < end; cursor++) {
		const char = text[cursor];
		if (escaped) escaped = false;
		else if (char === '\\') escaped = true;
		else if (char === closer) {
			cursor++;
			break;
		}
	}
	while (cursor < end && isLinkSpace(text[cursor])) cursor++;
	return cursor === end;
}

function isBlankLineBoundary(text: string, newline: number): boolean {
	let cursor = newline + 1;
	while (cursor < text.length && /[ \t\r]/.test(text[cursor])) cursor++;
	return cursor >= text.length || text[cursor] === '\n';
}

function indexRawParenthesisClosers(text: string): {
	closes: ReadonlyMap<number, number>;
	balancedToRawEnd: readonly boolean[];
	nextRawEnd: readonly number[];
	nextNonSpace: readonly number[];
	nextBlockBreak: readonly number[];
} {
	const closes = new Map<number, number>();
	const stack: number[] = [];
	let escaped = false;
	for (let cursor = 0; cursor < text.length; cursor++) {
		const char = text[cursor];
		if (char === '\n') {
			if (isBlankLineBoundary(text, cursor)) stack.length = 0;
			escaped = false;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '(') stack.push(cursor);
		else if (char === ')' && stack.length > 0) closes.set(stack.pop()!, cursor);
	}

	const rawEscapedAt = new Uint8Array(text.length);
	escaped = false;
	for (let cursor = 0; cursor < text.length; cursor++) {
		if (escaped) {
			rawEscapedAt[cursor] = 1;
			escaped = false;
		} else if (text[cursor] === '\\') {
			escaped = true;
		}
	}

	const balancedToRawEnd = new Array<boolean>(text.length + 1).fill(false);
	for (let tokenStart = 0; tokenStart < text.length;) {
		while (tokenStart < text.length
			&& isRawDestinationBreak(text[tokenStart], rawEscapedAt[tokenStart] !== 0)) tokenStart++;
		if (tokenStart >= text.length) break;
		let tokenEnd = tokenStart;
		while (tokenEnd < text.length
			&& !isRawDestinationBreak(text[tokenEnd], rawEscapedAt[tokenEnd] !== 0)) tokenEnd++;
		const prefixDepth = new Array<number>(tokenEnd - tokenStart + 1).fill(0);
		for (let cursor = tokenStart; cursor < tokenEnd; cursor++) {
			let depth = prefixDepth[cursor - tokenStart];
			if (!rawEscapedAt[cursor]) {
				if (text[cursor] === '(') depth++;
				else if (text[cursor] === ')') depth--;
			}
			prefixDepth[cursor - tokenStart + 1] = depth;
		}
		const finalDepth = prefixDepth[prefixDepth.length - 1];
		let minimumDepth = finalDepth;
		for (let cursor = tokenEnd - 1; cursor >= tokenStart; cursor--) {
			minimumDepth = Math.min(minimumDepth, prefixDepth[cursor - tokenStart + 1]);
			const startDepth = prefixDepth[cursor - tokenStart];
			balancedToRawEnd[cursor] = finalDepth === startDepth && minimumDepth >= startDepth;
		}
		tokenStart = tokenEnd;
	}

	const nextRawEnd = new Array<number>(text.length + 1).fill(text.length);
	const nextNonSpace = new Array<number>(text.length + 1).fill(text.length);
	const nextBlockBreak = new Array<number>(text.length + 1).fill(text.length);
	let rawEnd = text.length;
	let nonSpace = text.length;
	let blockBreak = text.length;
	for (let cursor = text.length - 1; cursor >= 0; cursor--) {
		const char = text[cursor];
		if (isRawDestinationBreak(char, rawEscapedAt[cursor] !== 0)) rawEnd = cursor;
		if (!isLinkSpace(char)) nonSpace = cursor;
		if (char === '\n' && isBlankLineBoundary(text, cursor)) blockBreak = cursor;
		nextRawEnd[cursor] = rawEnd;
		nextNonSpace[cursor] = nonSpace;
		nextBlockBreak[cursor] = blockBreak;
	}
	return { closes, balancedToRawEnd, nextRawEnd, nextNonSpace, nextBlockBreak };
}

/**
 * Parse one inline-link destination using the same structural rules as
 * isValidInlineLinkContent(), returning the outer closing parenthesis. Fail at
 * the first impossible delimiter so repeated malformed candidates stay linear.
 */
function parseInlineLinkDestinationEnd(text: string, start: number, max: number): number | undefined {
	let cursor = start;
	while (cursor < max && isLinkSpace(text[cursor])) cursor++;
	if (cursor >= max) return undefined;
	if (text[cursor] === ')') return cursor;

	if (text[cursor] === '<') {
		cursor++;
		let closed = false;
		for (; cursor < max;) {
			const char = text[cursor];
			if (char === '\n' || char === '\r' || char === '<') return undefined;
			if (char === '>') {
				cursor++;
				closed = true;
				break;
			}
			cursor += char === '\\' && cursor + 1 < max ? 2 : 1;
		}
		if (!closed) return undefined;
	} else {
		const destinationStart = cursor;
		let depth = 0;
		for (; cursor < max;) {
			const char = text[cursor];
			if (isRawDestinationBreak(char)) break;
			if (char === '\\' && cursor + 1 < max) {
				if (text[cursor + 1] === ' ') break;
				cursor += 2;
				continue;
			}
			if (char === '(' && ++depth > 32) return undefined;
			if (char === ')') {
				if (depth === 0) break;
				depth--;
			}
			cursor++;
		}
		if (cursor === destinationStart || depth !== 0) return undefined;
	}

	if (text[cursor] === ')') return cursor;
	const whitespaceStart = cursor;
	while (cursor < max && isLinkSpace(text[cursor])) cursor++;
	if (text[cursor] === ')') return cursor;
	if (cursor >= max || cursor === whitespaceStart) return undefined;

	const opener = text[cursor];
	const closer = opener === '(' ? ')' : opener;
	if (opener !== '"' && opener !== "'" && opener !== '(') return undefined;
	cursor++;
	let escaped = false;
	let titleClosed = false;
	for (; cursor < max; cursor++) {
		const char = text[cursor];
		if (escaped) escaped = false;
		else if (char === '\\') escaped = true;
		else if (char === closer) {
			cursor++;
			titleClosed = true;
			break;
		} else if (opener === '(' && char === '(') {
			return undefined;
		}
	}
	if (!titleClosed) return undefined;
	while (cursor < max && isLinkSpace(text[cursor])) cursor++;
	return text[cursor] === ')' ? cursor : undefined;
}

function computeLinkDestinationRegions(text: string): {
	destinations: OffsetRange[];
	labels: Set<string>;
} {
	const destinations: OffsetRange[] = [];
	const labels = new Set<string>();
	const labelStack: number[] = [];
	const rawParens = indexRawParenthesisClosers(text);
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char !== '[' && char !== ']') continue;
		if (isEscaped(text, i)) continue;
		if (char === '[') {
			labelStack.push(i);
			continue;
		}
		if (labelStack.length === 0) continue;
		const labelStart = labelStack.pop()!;

		if (text[i + 1] === '[') {
			let cursor = i + 2;
			while (cursor < text.length && text[cursor] !== '\n') {
				if (text[cursor] === ']' && !isEscaped(text, cursor)) break;
				cursor++;
			}
			if (text[cursor] === ']') {
				destinations.push({ start: i + 2, end: cursor });
				i = cursor;
			}
			continue;
		}
		if (text[i + 1] !== '(') continue;

		const openParen = i + 1;
		const start = i + 2;
		const max = rawParens.nextBlockBreak[openParen];
		let contentStart = start;
		while (contentStart < max && isLinkSpace(text[contentStart])) contentStart++;
		if (text[contentStart] !== '<') {
			const outerClose = rawParens.closes.get(openParen);
			const rawEnd = rawParens.nextRawEnd[contentStart];
			if (outerClose === undefined || rawEnd < outerClose) {
				const title = rawParens.nextNonSpace[rawEnd];
				const titleOpener = text[title];
				const possibleTitle = title === outerClose
					|| titleOpener === '"'
					|| titleOpener === "'"
					|| (titleOpener === '(' && outerClose !== undefined);
				if (contentStart >= rawEnd
					|| rawEnd >= max
					|| !rawParens.balancedToRawEnd[contentStart]
					|| !possibleTitle) {
					continue;
				}
			} else if (outerClose >= max) {
				continue;
			}
		}

		const cursor = parseInlineLinkDestinationEnd(text, start, max);
		if (cursor !== undefined) {
			destinations.push({ start, end: cursor });
			labels.add(labelStart + ':' + (i + 1));
			i = cursor;
		}
	}
	return { destinations, labels };
}

function normalizeReferenceLabel(label: string): string {
	return referenceMarkdownIt.utils.normalizeReference(label);
}

function computeReferenceDefinitionLabels(candidateText: string, markdown: string): Set<string> {
	const candidates = new Set<string>();
	for (const line of lineRanges(candidateText)) {
		const content = candidateText.slice(line.start, line.end).replace(/\r?\n$/, '');
		const definition = /^ {0,3}\[(?!\^)([^\]\n]+)\]:/.exec(content);
		if (definition) candidates.add(normalizeReferenceLabel(definition[1]));
	}
	if (candidates.size === 0) return candidates;

	// Parse the original Markdown once so angle destinations and all destination/
	// title semantics stay identical to Markdown-it. Intersecting with candidates
	// found in the structurally masked text preserves the scanner's existing root-
	// definition scope and keeps footnote definitions available for citation scans.
	const environment: { references?: Record<string, unknown> } = {};
	referenceMarkdownIt.parse(markdown, environment);
	const references = environment.references;
	if (!references) return new Set();
	return new Set([...candidates].filter(label => Object.hasOwn(references, label)));
}

function isReferenceDestinationLine(line: string): boolean {
	const contentStart = line.match(/^[ \t]*/)?.[0].length ?? 0;
	return line.slice(contentStart).trim().length > 0
		&& isValidInlineLinkContent(line, contentStart, line.length);
}

function computeReferenceDefinitionRegions(text: string): OffsetRange[] {
	const regions: OffsetRange[] = [];
	const lines = lineRanges(text);
	const titleLine = /^[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))[ \t]*$/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const content = text.slice(line.start, line.end).replace(/\r?\n$/, '');
		const definition = /^ {0,3}\[(?!\^)[^\]\n]+\]:/.exec(content);
		if (!definition) continue;
		let end = line.end;
		let nextIndex = i + 1;
		if (content.slice(definition[0].length).trim().length === 0) {
			const destination = lines[nextIndex];
			if (destination) {
				const destinationText = text.slice(destination.start, destination.end).replace(/\r?\n$/, '');
				if (isReferenceDestinationLine(destinationText) && !titleLine.test(destinationText)) {
					end = destination.end;
					i = nextIndex;
					nextIndex++;
				}
			}
		}
		const title = lines[nextIndex];
		if (title) {
			const titleText = text.slice(title.start, title.end).replace(/\r?\n$/, '');
			if (titleLine.test(titleText)) {
				end = title.end;
				i = nextIndex;
			}
		}
		regions.push({ start: line.start, end });
	}
	return regions;
}

function criticCommentOpenerEnd(text: string, start: number): number | undefined {
	if (text.startsWith('{>>', start)) return start + 3;
	if (!text.startsWith('{#', start)) return undefined;
	let cursor = start + 2;
	while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor])) cursor++;
	return cursor > start + 2 && text.startsWith('>>', cursor)
		? cursor + 2
		: undefined;
}

function computeCriticAttributionRegions(text: string): OffsetRange[] {
	const regions: OffsetRange[] = [];
	const stack: Array<{
		headerState: 'leading' | 'header' | 'invalid';
		headerStart?: number;
		pipe?: number;
	}> = [];
	for (let cursor = 0; cursor < text.length;) {
		const frame = stack[stack.length - 1];
		if (frame && (text[cursor] === '\n' || text[cursor] === '\r')) {
			frame.headerState = 'invalid';
		}
		if (frame?.headerState === 'leading') {
			if (text[cursor] === ' ' || text[cursor] === '\t') {
				cursor++;
				continue;
			}
			if (text[cursor] === '@') {
				frame.headerState = 'header';
				frame.headerStart = cursor;
			} else {
				frame.headerState = 'invalid';
			}
		}

		const openerEnd = text[cursor] === '{'
			? criticCommentOpenerEnd(text, cursor)
			: undefined;
		if (openerEnd !== undefined) {
			stack.push({ headerState: 'leading' });
			cursor = openerEnd;
			continue;
		}
		if (text.startsWith('<<}', cursor)) {
			const closed = stack.pop();
			if (closed?.headerStart !== undefined && closed.pipe !== undefined) {
				regions.push({ start: closed.headerStart, end: closed.pipe });
			}
			cursor += 3;
			continue;
		}
		if (text[cursor] === '|' && frame?.headerState === 'header' && frame.pipe === undefined) {
			frame.pipe = cursor;
		}
		cursor++;
	}
	for (const frame of stack) {
		if (frame.headerStart !== undefined && frame.pipe !== undefined) {
			regions.push({ start: frame.headerStart, end: frame.pipe });
		}
	}
	return regions;
}

function computeUriRegions(text: string): OffsetRange[] {
	const regions: OffsetRange[] = [];
	const uri = /[A-Za-z][A-Za-z0-9+.-]*:[^\s<>()]*/g;
	let match: RegExpExecArray | null;
	while ((match = uri.exec(text)) !== null) {
		regions.push({ start: match.index, end: match.index + match[0].length });
	}
	return regions;
}

export function analyzeCitationBrackets(text: string): CitationBracketAnalysis {
	const closes = new Map<number, number>();
	const stack: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char !== '[' && char !== ']') continue;
		if (isEscaped(text, i)) continue;
		if (char === '[') stack.push(i);
		else if (stack.length > 0) closes.set(stack.pop()!, i + 1);
	}

	const contexts = new Map<number, OffsetRange>();
	const balancedContexts = new Map<number, OffsetRange>();
	stack.length = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char !== '[' && char !== ']' && char !== '@') continue;
		if (isEscaped(text, i)) continue;
		if (char === '[') stack.push(i);
		else if (char === ']' && stack.length > 0) stack.pop();
		else if (char === '@' && stack.length > 0) {
			const start = stack[stack.length - 1];
			const end = closes.get(start);
			const context = { start, end: end ?? text.length };
			contexts.set(i, context);
			if (end !== undefined) balancedContexts.set(i, context);
		}
	}
	const balancedRanges = [...closes].map(([start, end]) => ({ start, end }))
		.sort((a, b) => a.start - b.start);
	return { contexts, balancedContexts, closingOffsets: closes, balancedRanges };
}

function findBracketContext(
	analysis: CitationBracketAnalysis,
	atOffset: number,
	requireClosing: boolean,
): OffsetRange | undefined {
	return (requireClosing ? analysis.balancedContexts : analysis.contexts).get(atOffset);
}

function findBalancedBracketContainingOffset(
	offset: number,
	analysis: CitationBracketAnalysis,
): OffsetRange | undefined {
	let containing: OffsetRange | undefined;
	for (const range of analysis.balancedRanges) {
		if (range.start > offset) break;
		if (offset < range.end && (!containing || range.start >= containing.start)) containing = range;
	}
	return containing;
}

/** Whether `@` is enclosed by an escape-aware bracket pair with a real closer. */
export function isInsideBalancedBracketContextAtOffset(
	text: string,
	atOffset: number,
	analysis?: CitationBracketAnalysis,
): boolean {
	return (analysis ?? analyzeCitationBrackets(text)).balancedContexts.has(atOffset);
}

function isSupportedCitationBracket(text: string, bracket: OffsetRange): boolean {
	return text.startsWith('[@', bracket.start) || text.startsWith('[-@', bracket.start);
}

function isCitationItemMarkerAt(
	text: string,
	bracket: OffsetRange,
	atOffset: number,
): boolean {
	const separator = text.lastIndexOf(';', atOffset);
	let start = Math.max(bracket.start + 1, separator + 1);
	while (start < atOffset && /\s/.test(text[start])) start++;
	return atOffset === start || (text[start] === '-' && atOffset === start + 1);
}

function isVisibleLinkLabel(
	text: string,
	bracket: OffsetRange,
	referenceLabels: ReadonlySet<string>,
	inlineLinkLabels: ReadonlySet<string>,
): boolean {
	if (bracket.end > text.length || text[bracket.end - 1] !== ']') return false;
	if (inlineLinkLabels.has(bracket.start + ':' + bracket.end)) return true;
	const ownLabel = text.slice(bracket.start + 1, bracket.end - 1);
	if (text[bracket.end] === '[') {
		let cursor = bracket.end + 1;
		while (cursor < text.length && text[cursor] !== '\n') {
			if (text[cursor] === ']' && !isEscaped(text, cursor)) {
				const explicitLabel = text.slice(bracket.end + 1, cursor);
				return referenceLabels.has(normalizeReferenceLabel(explicitLabel || ownLabel));
			}
			cursor++;
		}
		return false;
	}
	return referenceLabels.has(normalizeReferenceLabel(ownLabel));
}

function yamlCommentStart(text: string, start: number, end: number): number {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (let i = start; i < end; i++) {
		const char = text[i];
		if (quote === '"') {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (quote === "'") {
			if (char === quote) {
				if (text[i + 1] === quote) i++;
				else quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === '#' && (i === start || /\s/.test(text[i - 1]))) return i;
	}
	return end;
}

function collectNociteRegions(text: string): NociteRegion[] {
	const bounds = findCitationFrontmatterBounds(text);
	if (!bounds) return [];
	const regions: NociteRegion[] = [];
	let lineStart = bounds.contentStart;
	while (lineStart < bounds.contentEnd) {
		if (text[lineStart] === '\r' || text[lineStart] === '\n') {
			lineStart++;
			continue;
		}
		const newline = text.indexOf('\n', lineStart);
		const rawEnd = newline === -1 || newline > bounds.contentEnd ? bounds.contentEnd : newline;
		const lineEnd = rawEnd > lineStart && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
		const line = text.slice(lineStart, lineEnd);
		const match = /^nocite\s*:/.exec(line);
		if (!match) {
			lineStart = newline === -1 ? bounds.contentEnd : newline + 1;
			continue;
		}

		const colon = lineStart + match[0].lastIndexOf(':');
		let valueStart = colon + 1;
		while (valueStart < lineEnd && /[ \t]/.test(text[valueStart])) valueStart++;
		const firstValue = text.slice(valueStart, lineEnd);
		const semanticFirstValue = yamlValueBeforeComment(firstValue).trim();
		const blockScalar = /^[|>][0-9+-]*$/.test(semanticFirstValue);
		const multiline = semanticFirstValue.length === 0 || blockScalar;
		if (!multiline) {
			regions.push({ start: valueStart, end: yamlCommentStart(text, valueStart, lineEnd), blockScalar: false });
			lineStart = newline === -1 ? bounds.contentEnd : newline + 1;
			continue;
		}

		let continuationStart = newline === -1 ? bounds.contentEnd : newline + 1;
		while (continuationStart < bounds.contentEnd) {
			const nextNewline = text.indexOf('\n', continuationStart);
			const nextRawEnd = nextNewline === -1 || nextNewline > bounds.contentEnd ? bounds.contentEnd : nextNewline;
			const nextEnd = nextRawEnd > continuationStart && text[nextRawEnd - 1] === '\r' ? nextRawEnd - 1 : nextRawEnd;
			const nextLine = text.slice(continuationStart, nextEnd);
			const nextLineIsIndented = /^[ \t]/.test(nextLine);
			if (blockScalar && nextLine.trim().length > 0 && !nextLineIsIndented) break;
			if (!blockScalar && isTopLevelFrontmatterMappingLine(nextLine)) break;
			const contentStart = continuationStart + (nextLine.match(/^[ \t]*/)?.[0].length ?? 0);
			const contentEnd = blockScalar ? nextEnd : yamlCommentStart(text, contentStart, nextEnd);
			regions.push({ start: contentStart, end: contentEnd, blockScalar });
			continuationStart = nextNewline === -1 ? bounds.contentEnd : nextNewline + 1;
		}
		lineStart = Math.max(continuationStart, newline === -1 ? bounds.contentEnd : newline + 1);
	}
	return regions.filter(region => region.end > region.start);
}

function bodyExcludedRanges(text: string): {
	ranges: OffsetRange[];
	frontmatter?: OffsetRange;
	referenceLabels: Set<string>;
	inlineLinkLabels: Set<string>;
} {
	const bounds = findCitationFrontmatterBounds(text);
	const frontmatter = bounds ? { start: bounds.start, end: bounds.bodyStart } : undefined;

	// Frontmatter is always inert. For code, HTML comments, and HTML tags, the
	// earliest valid opener wins; nested-looking delimiters cannot seed a later
	// scanner and consume otherwise-visible prose.
	const primaryInput = frontmatter ? maskRanges(text, [frontmatter]) : text;
	let structural = selectOutermostRanges([
		...computeCodeRegions(primaryInput),
		...computeHtmlCommentRegions(primaryInput),
		...computeHtmlTagRegions(primaryInput),
		...(frontmatter ? [frontmatter] : []),
	]);
	let structuralInput = maskRanges(text, structural);
	const links = computeLinkDestinationRegions(structuralInput);
	structural = mergeRanges([...structural, ...links.destinations]);

	structuralInput = maskRanges(text, structural);
	const referenceLabels = computeReferenceDefinitionLabels(structuralInput, text);
	const definitions = computeReferenceDefinitionRegions(structuralInput);
	structural = mergeRanges([...structural, ...definitions]);

	structuralInput = maskRanges(text, structural);
	const criticAttribution = computeCriticAttributionRegions(structuralInput);
	structural = mergeRanges([...structural, ...criticAttribution]);

	structuralInput = maskRanges(text, structural);
	const ranges = mergeRanges([...structural, ...computeUriRegions(structuralInput)]);
	return { ranges, frontmatter, referenceLabels, inlineLinkLabels: links.labels };
}

function isValidBodyCandidate(text: string, atOffset: number, bracketed: boolean): boolean {
	if (isEscaped(text, atOffset) || isEmailSeparatorAt(text, atOffset)) return false;
	const previous = previousCodePoint(text, atOffset)?.value;
	if (bracketed) return previous === undefined || !BODY_LEFT_EXCLUSION_RE.test(previous);
	return previous === undefined || !BARE_LEFT_EXCLUSION_RE.test(previous);
}

/** Shared lexical boundary check for a bare narrative citation at `@`. */
export function isBoundaryValidBareCitation(text: string, atOffset: number): boolean {
	return isValidBodyCandidate(text, atOffset, false)
		&& (atOffset === 0 || text[atOffset - 1] !== '-');
}

function scanNociteRegion(
	text: string,
	region: OffsetRange,
): { usages: CitationUsage[]; wildcard: boolean } {
	const usages: CitationUsage[] = [];
	let wildcard = false;
	for (const token of scanNociteTokens(text, region.start, region.end)) {
		if (token.wildcard) {
			wildcard = true;
			continue;
		}
		if (token.key === undefined) continue;
		usages.push({
			key: token.key,
			atStart: token.atStart,
			keyStart: token.atStart + 1,
			keyEnd: token.end,
			form: 'nocite',
			suppressAuthor: false,
		});
	}
	return { usages, wildcard };
}

export function analyzeCitationDocument(text: string): CitationDocumentAnalysis {
	const { ranges: excludedRanges, referenceLabels, inlineLinkLabels } = bodyExcludedRanges(text);
	const brackets = analyzeCitationBrackets(maskRanges(text, excludedRanges));
	const bracketItems = new Map<number, BracketCitationItem>();
	const parsedBrackets = new Set<string>();
	for (const bracket of brackets.balancedContexts.values()) {
		const identity = bracket.start + ':' + bracket.end;
		if (parsedBrackets.has(identity) || isVisibleLinkLabel(text, bracket, referenceLabels, inlineLinkLabels)) continue;
		parsedBrackets.add(identity);
		for (const item of parseBracketCitationItems(text, bracket.start, bracket.end)) {
			bracketItems.set(item.atStart, item);
		}
	}

	const usages: CitationUsage[] = [];
	let excludedIndex = 0;
	for (let cursor = 0; cursor < text.length; cursor++) {
		while (excludedIndex < excludedRanges.length && cursor >= excludedRanges[excludedIndex].end) excludedIndex++;
		if (text[cursor] !== '@') continue;
		if (excludedIndex < excludedRanges.length && cursor >= excludedRanges[excludedIndex].start) continue;
		const parsed = readMarkdownCitekey(text, cursor + 1);
		if (!parsed) continue;

		const bracket = brackets.balancedContexts.get(cursor);
		const linkLabel = bracket !== undefined && isVisibleLinkLabel(text, bracket, referenceLabels, inlineLinkLabels);
		const bracketItem = bracketItems.get(cursor);
		const bracketed = bracketItem !== undefined;
		if (bracket && !bracketed && !linkLabel) continue;
		if (bracketed ? !isValidBodyCandidate(text, cursor, true) : !isBoundaryValidBareCitation(text, cursor)) continue;
		usages.push({
			key: parsed.key,
			atStart: cursor,
			keyStart: cursor + 1,
			keyEnd: parsed.end,
			form: bracketed ? 'bracket' : 'bare',
			suppressAuthor: bracketItem?.suppressAuthor ?? false,
		});
		cursor = parsed.end - 1;
	}

	let hasNociteWildcard = false;
	const nociteRegions = collectNociteRegions(text);
	for (const region of nociteRegions) {
		const scanned = scanNociteRegion(text, region);
		usages.push(...scanned.usages);
		hasNociteWildcard ||= scanned.wildcard;
	}
	usages.sort((a, b) => a.atStart - b.atStart);
	return {
		text,
		usages,
		hasNociteWildcard,
		excludedRanges,
		referenceLabels,
		inlineLinkLabels,
		brackets,
		bracketItems,
		nociteRegions,
	};
}

function analysisFor(text: string, analysis?: CitationDocumentAnalysis): CitationDocumentAnalysis {
	return analysis ?? analyzeCitationDocument(text);
}

export function scanCitationDocument(
	text: string,
	targetKey?: string,
	analysis?: CitationDocumentAnalysis,
): CitationDocumentScan {
	const resolved = analysisFor(text, analysis);
	return {
		usages: targetKey === undefined
			? [...resolved.usages]
			: resolved.usages.filter(usage => usage.key === targetKey),
		hasNociteWildcard: resolved.hasNociteWildcard,
	};
}

export function findCitationAtOffset(
	text: string,
	offset: number,
	analysis?: CitationDocumentAnalysis,
): CitationUsage | undefined {
	if (offset < 0 || offset > text.length) return undefined;
	const usages = analysisFor(text, analysis).usages;
	let low = 0;
	let high = usages.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (usages[mid].atStart <= offset) low = mid + 1;
		else high = mid;
	}
	const usage = usages[low - 1];
	return usage && offset <= usage.keyEnd ? usage : undefined;
}

export function isInsideCitationSegmentAtOffset(
	text: string,
	atOffset: number,
	analysis?: CitationDocumentAnalysis,
): boolean {
	const resolved = analysisFor(text, analysis);
	const bracket = findBalancedBracketContainingOffset(atOffset, resolved.brackets);
	return bracket !== undefined
		&& isSupportedCitationBracket(text, bracket)
		&& !isVisibleLinkLabel(text, bracket, resolved.referenceLabels, resolved.inlineLinkLabels);
}

export function getCitationCompletionContextAtOffset(
	text: string,
	offset: number,
	analysis?: CitationDocumentAnalysis,
): CitationCompletionContext | undefined {
	if (offset < 0 || offset > text.length) return undefined;
	let replaceStart = offset;
	while (replaceStart > 0 && isCitekeyChar(text[replaceStart - 1])) replaceStart--;
	const atOffset = replaceStart - 1;
	if (atOffset < 0 || text[atOffset] !== '@') return undefined;

	const resolved = analysisFor(text, analysis);
	const nociteRegion = resolved.nociteRegions.find(region => atOffset >= region.start && atOffset < region.end);
	if (nociteRegion) {
		if (!isBoundaryValidNociteToken(text, atOffset, nociteRegion.start)) return undefined;
		return { prefix: text.slice(replaceStart, offset), replaceStart, atOffset, form: 'nocite' };
	}

	if (rangeContaining(atOffset, resolved.excludedRanges)) return undefined;
	const bracket = findBracketContext(resolved.brackets, atOffset, false);
	const linkLabel = bracket !== undefined && isVisibleLinkLabel(text, bracket, resolved.referenceLabels, resolved.inlineLinkLabels);
	const bracketed = bracket !== undefined
		&& !linkLabel
		&& isSupportedCitationBracket(text, bracket)
		&& isCitationItemMarkerAt(text, bracket, atOffset);
	const balancedBracket = resolved.brackets.balancedContexts.has(atOffset);
	if (balancedBracket && !bracketed) return undefined;
	if (bracketed ? !isValidBodyCandidate(text, atOffset, true) : !isBoundaryValidBareCitation(text, atOffset)) return undefined;
	return {
		prefix: text.slice(replaceStart, offset),
		replaceStart,
		atOffset,
		form: bracketed ? 'bracket' : 'bare',
	};
}

export function getBoundedCitationCompletionContextAtOffset(
	text: string,
	offset: number,
	maxWindow = 16_384,
): CitationCompletionContext | undefined {
	if (offset < 0 || offset > text.length || maxWindow < 1) return undefined;
	const frontmatter = findCitationFrontmatterBounds(text);
	if (frontmatter && offset >= frontmatter.start && offset <= frontmatter.contentEnd) {
		return getCitationCompletionContextAtOffset(text, offset);
	}
	let start = Math.max(0, offset - maxWindow);
	if (start > 0) {
		const nextLine = text.indexOf('\n', start);
		start = nextLine === -1 || nextLine >= offset ? offset : nextLine + 1;
	}
	const end = Math.min(text.length, offset + maxWindow);
	const window = text.slice(start, end);
	const local = getCitationCompletionContextAtOffset(window, offset - start);
	if (!local) return undefined;
	return {
		...local,
		replaceStart: local.replaceStart + start,
		atOffset: local.atOffset + start,
	};
}

export function hasBibliographyDemand(text: string): boolean {
	const scan = scanCitationDocument(text);
	return scan.usages.length > 0 || scan.hasNociteWildcard;
}
