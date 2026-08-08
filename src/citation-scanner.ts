import MarkdownIt from 'markdown-it';
import {
	computeCodeRegions,
	computeMarkdownInlineBlocks,
	computeMarkdownParsedBlocks,
	type MarkdownInlineBlock,
} from './code-regions';
import {
	findCitationFrontmatterBounds,
	findFrontmatterBounds,
	type FrontmatterBounds,
} from './frontmatter';
import {
	isBoundaryValidNociteToken,
	isCitekeyChar,
	isEmailSeparatorAt,
	isEscaped,
	isNociteContinuationLine,
	nociteValueMode,
	parseBracketCitationItems,
	previousCodePoint,
	readMarkdownCitekey,
	scanNociteTokens,
	type BracketCitationItem,
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
	citationMarkupRanges: readonly CitationOffsetRange[];
	referenceLabels: ReadonlySet<string>;
	inlineLinkLabels: ReadonlySet<string>;
	visibleLinkLabels: ReadonlySet<string>;
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

function indexOfWithin(
	text: string,
	needle: string,
	start: number,
	end: number,
): number {
	const lastStart = Math.min(end, text.length) - needle.length;
	for (let cursor = Math.max(0, start); cursor <= lastStart; cursor++) {
		if (text.startsWith(needle, cursor)) return cursor;
	}
	return -1;
}

function computeHtmlCommentRegions(
	text: string,
	inlineBlocks: readonly OffsetRange[],
	htmlBlocks: readonly OffsetRange[],
): OffsetRange[] {
	const regions: OffsetRange[] = [];
	const parserBlocks = [
		...inlineBlocks.map(range => ({ ...range, rawHtml: false })),
		...htmlBlocks.map(range => ({ ...range, rawHtml: true })),
	].sort((a, b) => a.start - b.start || a.end - b.end);
	for (const block of parserBlocks) {
		let cursor = block.start;
		while (cursor < block.end) {
			const start = indexOfWithin(text, '<!--', cursor, block.end);
			if (start === -1) break;
			const close = indexOfWithin(text, '-->', start + 4, block.end);
			if (close !== -1) {
				const end = close + 3;
				regions.push({ start, end });
				cursor = end;
				continue;
			}
			// An unclosed inline candidate is literal text and cannot consume a later
			// Markdown block. An unclosed parser-recognized raw HTML comment remains
			// inert through that HTML block (which may itself extend to EOF).
			if (block.rawHtml) regions.push({ start, end: block.end });
			break;
		}
	}
	return regions;
}

function computeHtmlTagRegions(
	text: string,
	parserBlocks: readonly OffsetRange[],
): OffsetRange[] {
	if (!text.includes('<')) return [];
	const regions: OffsetRange[] = [];

	// Compute quote-state endings backwards, but retain them only for plausible
	// `<...` candidates. This preserves linear recovery from malformed openers
	// without allocating three dense indexes for an otherwise ordinary block.
	for (const block of parserBlocks) {
		let candidateCount = 0;
		for (let cursor = block.start; cursor < block.end - 1; cursor++) {
			if (text[cursor] === '<' && /[A-Za-z/!?]/.test(text[cursor + 1])) candidateCount++;
		}
		if (candidateCount === 0) continue;

		const candidateEnds = new Int32Array(candidateCount).fill(-1);
		let candidateIndex = candidateCount - 1;
		let unquotedEnd = -1;
		let singleQuotedEnd = -1;
		let doubleQuotedEnd = -1;
		for (let cursor = block.end - 1; cursor >= block.start; cursor--) {
			const nextUnquotedEnd = unquotedEnd;
			const nextSingleQuotedEnd = singleQuotedEnd;
			const nextDoubleQuotedEnd = doubleQuotedEnd;
			const char = text[cursor];
			unquotedEnd = char === '>'
				? cursor + 1
				: char === "'"
					? nextSingleQuotedEnd
					: char === '"'
						? nextDoubleQuotedEnd
						: nextUnquotedEnd;
			singleQuotedEnd = char === "'" ? nextUnquotedEnd : nextSingleQuotedEnd;
			doubleQuotedEnd = char === '"' ? nextUnquotedEnd : nextDoubleQuotedEnd;
			const start = cursor - 1;
			if (start >= block.start && text[start] === '<' && /[A-Za-z/!?]/.test(char)) {
				candidateEnds[candidateIndex--] = unquotedEnd;
			}
		}

		candidateIndex = 0;
		let consumedThrough = block.start;
		for (let start = block.start; start < block.end - 1; start++) {
			if (text[start] !== '<' || !/[A-Za-z/!?]/.test(text[start + 1])) continue;
			const end = candidateEnds[candidateIndex++];
			if (start < consumedThrough || end === -1) continue;
			regions.push({ start, end });
			consumedThrough = end;
		}
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
	return parseInlineLinkContentEnd(text, start, end, false) === end;
}

function lastRawParenthesisCloser(
	text: string,
	block: MarkdownInlineBlock,
): number {
	let lastClose = -1;
	let escaped = false;
	for (let cursor = block.start; cursor < block.end; cursor++) {
		const char = text[cursor];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === '\\') escaped = true;
		else if (char === ')') lastClose = cursor;
	}
	return lastClose;
}

/**
 * Parse the strict inline-link destination/title grammar once for both complete
 * content validation and outer-parenthesis end discovery. Fail at the first
 * impossible delimiter so repeated malformed candidates stay linear.
 */
function parseInlineLinkContentEnd(
	text: string,
	start: number,
	max: number,
	hasOuterClosingParenthesis: boolean,
): number | undefined {
	let cursor = start;
	while (cursor < max && isLinkSpace(text[cursor])) cursor++;
	if (cursor >= max) return hasOuterClosingParenthesis ? undefined : cursor;
	if (hasOuterClosingParenthesis && text[cursor] === ')') return cursor;

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
				if (depth === 0) {
					if (!hasOuterClosingParenthesis) return undefined;
					break;
				}
				depth--;
			}
			cursor++;
		}
		if (cursor === destinationStart || depth !== 0) return undefined;
	}

	if (hasOuterClosingParenthesis && text[cursor] === ')') return cursor;
	if (!hasOuterClosingParenthesis && cursor === max) return cursor;
	const whitespaceStart = cursor;
	while (cursor < max && isLinkSpace(text[cursor])) cursor++;
	if (hasOuterClosingParenthesis && text[cursor] === ')') return cursor;
	if (!hasOuterClosingParenthesis && cursor === max) return cursor;
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
	if (hasOuterClosingParenthesis) return text[cursor] === ')' ? cursor : undefined;
	return cursor === max ? cursor : undefined;
}

function parseInlineLinkDestinationEnd(text: string, start: number, max: number): number | undefined {
	return parseInlineLinkContentEnd(text, start, max, true);
}

function computeLinkDestinationRegions(
	text: string,
	inlineBlocks: readonly MarkdownInlineBlock[],
): {
	destinations: OffsetRange[];
	labels: Set<string>;
} {
	const destinations: OffsetRange[] = [];
	const labels = new Set<string>();
	if (!text.includes('](') && !text.includes('][')) return { destinations, labels };
	for (const block of inlineBlocks) {
		const labelStack: number[] = [];
		let lastRawClose: number | undefined;
		for (let i = block.start; i < block.end; i++) {
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
				while (cursor < block.end && text[cursor] !== '\n') {
					if (text[cursor] === ']' && !isEscaped(text, cursor)) break;
					cursor++;
				}
				if (cursor < block.end && text[cursor] === ']') {
					destinations.push({ start: i + 2, end: cursor });
					i = cursor;
				}
				continue;
			}
			if (text[i + 1] !== '(' || i + 1 >= block.end) continue;

			const openParen = i + 1;
			const start = i + 2;
			const max = block.end;
			lastRawClose ??= lastRawParenthesisCloser(text, block);
			if (openParen >= lastRawClose) continue;

			// The parser's raw-destination nesting limit bounds overlapping malformed
			// candidates, while one scalar last-closer summary rejects candidates that
			// cannot possibly close. This keeps repeated malformed input linear without
			// dense per-character indexes for a block containing one ordinary link.
			const cursor = parseInlineLinkDestinationEnd(text, start, max);
			if (cursor !== undefined) {
				destinations.push({ start, end: cursor });
				labels.add(labelStart + ':' + (i + 1));
				i = cursor;
			}
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

export function analyzeCitationBrackets(
	text: string,
	inlineBlocks: readonly MarkdownInlineBlock[] = computeMarkdownInlineBlocks(text),
): CitationBracketAnalysis {
	const closes = new Map<number, number>();
	for (const block of inlineBlocks) {
		const stack: number[] = [];
		for (let i = block.start; i < block.end; i++) {
			const char = text[i];
			if (char !== '[' && char !== ']') continue;
			if (isEscaped(text, i)) continue;
			if (char === '[') stack.push(i);
			else if (stack.length > 0) closes.set(stack.pop()!, i + 1);
		}
	}

	const contexts = new Map<number, OffsetRange>();
	const balancedContexts = new Map<number, OffsetRange>();
	for (const block of inlineBlocks) {
		const stack: number[] = [];
		for (let i = block.start; i < block.end; i++) {
			const char = text[i];
			if (char !== '[' && char !== ']' && char !== '@') continue;
			if (isEscaped(text, i)) continue;
			if (char === '[') stack.push(i);
			else if (char === ']' && stack.length > 0) stack.pop();
			else if (char === '@' && stack.length > 0) {
				const start = stack[stack.length - 1];
				const end = closes.get(start);
				const context = { start, end: end ?? block.end };
				contexts.set(i, context);
				if (end !== undefined) balancedContexts.set(i, context);
			}
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
	markupRanges: readonly OffsetRange[] = [],
): boolean {
	let separator = bracket.start;
	for (let cursor = atOffset - 1; cursor > bracket.start;) {
		const markup = rangeContaining(cursor, markupRanges);
		if (markup) {
			cursor = markup.start - 1;
			continue;
		}
		if (text[cursor] === ';') {
			separator = cursor;
			break;
		}
		cursor--;
	}

	let start = separator + 1;
	while (start < atOffset) {
		const markup = rangeContaining(start, markupRanges);
		if (markup) {
			start = markup.end;
			continue;
		}
		if (!/\s/.test(text[start])) break;
		start++;
	}
	return atOffset === start || (text[start] === '-' && atOffset === start + 1);
}

function parseBracketCitationItemsIgnoringMarkup(
	text: string,
	bracket: OffsetRange,
	markupRanges: readonly OffsetRange[],
): BracketCitationItem[] {
	let low = 0;
	let high = markupRanges.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (markupRanges[mid].end <= bracket.start) low = mid + 1;
		else high = mid;
	}
	const localMarkup: OffsetRange[] = [];
	for (let index = low; index < markupRanges.length; index++) {
		const range = markupRanges[index];
		if (range.start >= bracket.end) break;
		localMarkup.push({
			start: Math.max(range.start, bracket.start) - bracket.start,
			end: Math.min(range.end, bracket.end) - bracket.start,
		});
	}
	if (localMarkup.length === 0) {
		return parseBracketCitationItems(text, bracket.start, bracket.end);
	}

	const localText = maskRanges(text.slice(bracket.start, bracket.end), localMarkup);
	return parseBracketCitationItems(localText, 0, localText.length).map(item => ({
		...item,
		atStart: item.atStart + bracket.start,
		keyEnd: item.keyEnd + bracket.start,
	}));
}

function rangeIdentity(range: OffsetRange): string {
	return range.start + ':' + range.end;
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

function collectNociteRegions(
	text: string,
	bounds: FrontmatterBounds | undefined = findFrontmatterBounds(text),
): NociteRegion[] {
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
		const mode = nociteValueMode(firstValue);
		const blockScalar = mode === 'block-scalar';
		if (mode === 'single-line') {
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
			if (!isNociteContinuationLine(mode, nextLine)) break;
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
	citationMarkupRanges: OffsetRange[];
	frontmatter?: OffsetRange;
	referenceLabels: Set<string>;
	inlineLinkLabels: Set<string>;
	citationBlocks: MarkdownInlineBlock[];
} {
	const bounds = findFrontmatterBounds(text);
	const frontmatter = bounds ? { start: bounds.start, end: bounds.bodyStart } : undefined;

	// Only closed frontmatter is globally authoritative. Parser-derived blocks
	// are computed once from the structurally equivalent masked source. Raw HTML
	// blocks are citation-aware because their visible text remains document content,
	// while tag/comment ranges are masked before inline links and brackets are
	// interpreted. Every delimiter scan remains local to one parser block. Code
	// parsing keeps raw HTML disabled so backticks inside HTML table cells retain
	// their established meaning.
	const primaryInput = frontmatter ? maskRanges(text, [frontmatter]) : text;
	const parsedBlocks = computeMarkdownParsedBlocks(primaryInput);
	const citationBlocks = [...parsedBlocks.inlineBlocks, ...parsedBlocks.htmlBlocks]
		.sort((a, b) => a.start - b.start || a.end - b.end)
		.map((range, id) => ({ id, start: range.start, end: range.end }));
	const citationMarkupRanges = selectOutermostRanges([
		...computeHtmlCommentRegions(
			primaryInput,
			parsedBlocks.inlineBlocks,
			parsedBlocks.htmlBlocks,
		),
		...computeHtmlTagRegions(primaryInput, citationBlocks),
	]);
	let structural = selectOutermostRanges([
		...computeCodeRegions(primaryInput),
		...citationMarkupRanges,
		...(frontmatter ? [frontmatter] : []),
	]);
	let structuralInput = maskRanges(text, structural);
	const links = computeLinkDestinationRegions(structuralInput, citationBlocks);
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
	return {
		ranges,
		citationMarkupRanges,
		frontmatter,
		referenceLabels,
		inlineLinkLabels: links.labels,
		citationBlocks,
	};
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
	const {
		ranges: excludedRanges,
		citationMarkupRanges,
		referenceLabels,
		inlineLinkLabels,
		citationBlocks,
	} = bodyExcludedRanges(text);
	const bracketInput = maskRanges(text, excludedRanges);
	const brackets = analyzeCitationBrackets(bracketInput, citationBlocks);
	const bracketItems = new Map<number, BracketCitationItem>();
	const parsedBrackets = new Set<string>();
	const visibleLinkLabels = new Set<string>();
	for (const bracket of brackets.balancedContexts.values()) {
		const identity = rangeIdentity(bracket);
		if (parsedBrackets.has(identity)) continue;
		parsedBrackets.add(identity);
		if (isVisibleLinkLabel(text, bracket, referenceLabels, inlineLinkLabels)) {
			visibleLinkLabels.add(identity);
			continue;
		}
		for (const item of parseBracketCitationItemsIgnoringMarkup(
			text,
			bracket,
			citationMarkupRanges,
		)) {
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
		const linkLabel = bracket !== undefined && visibleLinkLabels.has(rangeIdentity(bracket));
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
		citationMarkupRanges,
		referenceLabels,
		inlineLinkLabels,
		visibleLinkLabels,
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
		&& !resolved.visibleLinkLabels.has(rangeIdentity(bracket));
}

type ProvisionalFrontmatterCompletion =
	| { kind: 'nocite'; region: OffsetRange }
	| { kind: 'suppress' };

/**
 * Classify only the active cursor line in an unclosed frontmatter-looking
 * prefix. The prefix is too ambiguous to hide the rest of the document, but a
 * user editing a top-level field still expects YAML-aware completion behavior.
 */
function provisionalFrontmatterCompletionAt(
	text: string,
	atOffset: number,
): ProvisionalFrontmatterCompletion | undefined {
	if (findFrontmatterBounds(text)) return undefined;
	const bounds = findCitationFrontmatterBounds(text);
	if (!bounds || atOffset < bounds.contentStart || atOffset >= bounds.contentEnd) return undefined;

	const nociteRegion = collectNociteRegions(text, bounds)
		.find(region => atOffset >= region.start && atOffset < region.end);
	if (nociteRegion) return { kind: 'nocite', region: nociteRegion };

	const lineStart = text.lastIndexOf('\n', Math.max(bounds.contentStart, atOffset - 1)) + 1;
	const nextNewline = text.indexOf('\n', atOffset);
	const rawLineEnd = nextNewline === -1 ? text.length : nextNewline;
	const lineEnd = rawLineEnd > lineStart && text[rawLineEnd - 1] === '\r'
		? rawLineEnd - 1
		: rawLineEnd;
	const line = text.slice(lineStart, lineEnd);
	const lineBeforeCitation = text.slice(lineStart, atOffset);
	const topLevelMapping = !/^[ \t]/.test(lineBeforeCitation)
		&& /^[^\s:#][^:]*\s*:/.test(lineBeforeCitation);
	if (topLevelMapping) return { kind: 'suppress' };

	// Indented lines belong locally to the nearest uninterrupted top-level YAML
	// field. Valid nocite continuations were handled above; all other fields are
	// general YAML and suppress citekey completion at this cursor only.
	if (/^[ \t]+\S/.test(line)) {
		let previousEnd = lineStart > 0 ? lineStart - 1 : 0;
		while (previousEnd > bounds.contentStart) {
			const previousStart = text.lastIndexOf('\n', previousEnd - 1) + 1;
			const previous = text.slice(previousStart, previousEnd).replace(/\r$/, '');
			if (previous.trim().length === 0) break;
			if (!/^[ \t]/.test(previous) && /^[^\s:#][^:]*\s*:/.test(previous)) {
				return { kind: 'suppress' };
			}
			previousEnd = previousStart > 0 ? previousStart - 1 : 0;
		}
	}
	return undefined;
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

	const provisional = provisionalFrontmatterCompletionAt(text, atOffset);
	if (provisional?.kind === 'suppress') return undefined;
	if (provisional?.kind === 'nocite') {
		if (!isBoundaryValidNociteToken(text, atOffset, provisional.region.start)) return undefined;
		return { prefix: text.slice(replaceStart, offset), replaceStart, atOffset, form: 'nocite' };
	}

	const resolved = analysisFor(text, analysis);
	const nociteRegion = resolved.nociteRegions.find(region => atOffset >= region.start && atOffset < region.end);
	if (nociteRegion) {
		if (!isBoundaryValidNociteToken(text, atOffset, nociteRegion.start)) return undefined;
		return { prefix: text.slice(replaceStart, offset), replaceStart, atOffset, form: 'nocite' };
	}

	if (rangeContaining(atOffset, resolved.excludedRanges)) return undefined;
	const bracket = findBracketContext(resolved.brackets, atOffset, false);
	const linkLabel = bracket !== undefined && resolved.visibleLinkLabels.has(rangeIdentity(bracket));
	const bracketed = bracket !== undefined
		&& !linkLabel
		&& isSupportedCitationBracket(text, bracket)
		&& isCitationItemMarkerAt(text, bracket, atOffset, resolved.citationMarkupRanges);
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

export interface BoundedCitationCompletionMetrics {
	windowStart: number;
	windowEnd: number;
	analyzedLength: number;
}

function localEscapeParityDiffersFromSource(
	text: string,
	windowStart: number,
	window: string,
	localDelimiter: number,
	maxWindow: number,
): boolean {
	let localRunStart = localDelimiter;
	while (localRunStart > 0 && window[localRunStart - 1] === '\\') localRunStart--;
	if (localRunStart > 0 || windowStart === 0 || text[windowStart - 1] !== '\\') return false;

	let outsideSlashes = 0;
	let cursor = windowStart;
	while (cursor > 0 && text[cursor - 1] === '\\' && outsideSlashes < maxWindow) {
		cursor--;
		outsideSlashes++;
	}
	// If the fixed lookbehind ended inside the run, parity is still ambiguous and
	// the bounded retry is the only safe conservative classification.
	return (cursor > 0 && text[cursor - 1] === '\\') || outsideSlashes % 2 === 1;
}

function localCodeExclusionMayDependOnLeftContext(
	text: string,
	windowStart: number,
	window: string,
	localDelimiter: number,
	maxWindow: number,
): boolean {
	let runStart = localDelimiter;
	while (runStart > 0 && window[runStart - 1] === '`') runStart--;
	if (localEscapeParityDiffersFromSource(text, windowStart, window, runStart, maxWindow)) {
		return true;
	}
	if (runStart === 0 && windowStart > 0 && text[windowStart - 1] === '`') return true;

	let runEnd = localDelimiter;
	while (runEnd < window.length && window[runEnd] === '`') runEnd++;
	if (
		localDelimiter === 0 &&
		runEnd >= 3 &&
		windowStart > 0 &&
		text[windowStart - 1] !== '\n' &&
		text[windowStart - 1] !== '\r'
	) {
		return true;
	}

	const openerLength = runEnd - localDelimiter;
	const lookbehindStart = Math.max(0, windowStart - maxWindow);
	if (lookbehindStart > 0 && text[lookbehindStart] === '`' && text[lookbehindStart - 1] === '`') {
		return true;
	}
	for (let cursor = lookbehindStart; cursor < windowStart;) {
		if (text[cursor] !== '`') {
			cursor++;
			continue;
		}
		const candidateStart = cursor;
		while (cursor < windowStart && text[cursor] === '`') cursor++;
		if (cursor - candidateStart === openerLength) return true;
	}
	return false;
}

function inlineLinkLabelForDestination(
	analysis: CitationDocumentAnalysis,
	destinationStart: number,
): number | undefined {
	for (const identity of analysis.inlineLinkLabels) {
		const separator = identity.indexOf(':');
		if (separator === -1) continue;
		const labelStart = Number(identity.slice(0, separator));
		const labelEnd = Number(identity.slice(separator + 1));
		if (Number.isInteger(labelStart) && labelEnd + 1 === destinationStart) return labelStart;
	}
	return undefined;
}

function quotedEmailMayDependOnLeftContext(
	text: string,
	windowStart: number,
	window: string,
	atOffset: number,
	maxWindow: number,
): boolean {
	if (window[atOffset - 1] !== '"') return false;
	if (localEscapeParityDiffersFromSource(text, windowStart, window, atOffset - 1, maxWindow)) {
		return true;
	}
	for (let cursor = atOffset - 2; cursor >= 0 && window[cursor] !== '\n' && window[cursor] !== '\r'; cursor--) {
		if (window[cursor] !== '"' || isEscaped(window, cursor)) continue;
		return localEscapeParityDiffersFromSource(text, windowStart, window, cursor, maxWindow);
	}
	return false;
}

function boundedRejectionNeedsLeftContext(
	text: string,
	windowStart: number,
	window: string,
	localOffset: number,
	analysis: CitationDocumentAnalysis,
	maxWindow: number,
): boolean {
	let replaceStart = localOffset;
	while (replaceStart > 0 && isCitekeyChar(window[replaceStart - 1])) replaceStart--;
	if (replaceStart === 0) return windowStart > 0 && text[windowStart - 1] === '@';
	const atOffset = replaceStart - 1;
	if (window[atOffset] !== '@') return false;

	const provisional = provisionalFrontmatterCompletionAt(window, atOffset);
	if (provisional?.kind === 'suppress') return true;
	const nociteRegion = provisional?.kind === 'nocite'
		? provisional.region
		: analysis.nociteRegions.find(region => atOffset >= region.start && atOffset < region.end);
	if (nociteRegion) {
		if (isEscaped(window, atOffset)) {
			return localEscapeParityDiffersFromSource(
				text, windowStart, window, atOffset, maxWindow,
			);
		}
		if (isEmailSeparatorAt(window, atOffset)) {
			return quotedEmailMayDependOnLeftContext(
				text, windowStart, window, atOffset, maxWindow,
			);
		}
		return false;
	}

	const excluded = rangeContaining(atOffset, analysis.excludedRanges);
	if (excluded) {
		const labelStart = inlineLinkLabelForDestination(analysis, excluded.start);
		if (labelStart !== undefined) {
			return localEscapeParityDiffersFromSource(
				text, windowStart, window, labelStart, maxWindow,
			);
		}
		if (window[excluded.start] === '`') {
			return localEscapeParityDiffersFromSource(
				text, windowStart, window, excluded.start, maxWindow,
			) || localCodeExclusionMayDependOnLeftContext(
				text, windowStart, window, excluded.start, maxWindow,
			);
		}
		return excluded.start === 0;
	}

	const bracket = findBracketContext(analysis.brackets, atOffset, false);
	const linkLabel = bracket !== undefined && analysis.visibleLinkLabels.has(rangeIdentity(bracket));
	const bracketed = bracket !== undefined
		&& !linkLabel
		&& isSupportedCitationBracket(window, bracket)
		&& isCitationItemMarkerAt(window, bracket, atOffset, analysis.citationMarkupRanges);
	if (analysis.brackets.balancedContexts.has(atOffset) && !bracketed) {
		return bracket !== undefined && localEscapeParityDiffersFromSource(
			text, windowStart, window, bracket.start, maxWindow,
		);
	}
	if (isEscaped(window, atOffset)) {
		return localEscapeParityDiffersFromSource(
			text, windowStart, window, atOffset, maxWindow,
		);
	}
	if (isEmailSeparatorAt(window, atOffset)) {
		return quotedEmailMayDependOnLeftContext(
			text, windowStart, window, atOffset, maxWindow,
		);
	}
	const possibleBracketStart = atOffset - 2;
	if (
		possibleBracketStart >= 0 &&
		window.startsWith('[-@', possibleBracketStart) &&
		isEscaped(window, possibleBracketStart)
	) {
		return localEscapeParityDiffersFromSource(
			text, windowStart, window, possibleBracketStart, maxWindow,
		);
	}
	return atOffset === 1
		&& window[0] === '-'
		&& windowStart > 0
		&& text[windowStart - 1] === '[';
}

/**
 * Conservatively classify citation-like text for the extension's automatic
 * suggestion trigger without analyzing the full document. The language server
 * performs the authoritative whole-document analysis before returning items, so
 * truncating an open code span, link, or frontmatter block may only cause an
 * extra popup request, never an incorrect completion result.
 */
export function getBoundedCitationCompletionContextAtOffset(
	text: string,
	offset: number,
	maxWindow = 16_384,
	metrics?: BoundedCitationCompletionMetrics,
): CitationCompletionContext | undefined {
	if (offset < 0 || offset > text.length || maxWindow < 1) return undefined;
	const start = Math.max(0, offset - maxWindow);
	const end = Math.min(text.length, offset + maxWindow);
	if (metrics) {
		metrics.windowStart = start;
		metrics.windowEnd = end;
		metrics.analyzedLength = end - start;
	}
	const window = text.slice(start, end);
	const localOffset = offset - start;
	const analysis = analyzeCitationDocument(window);
	const local = getCitationCompletionContextAtOffset(window, localOffset, analysis);
	if (local) {
		return {
			...local,
			replaceStart: local.replaceStart + start,
			atOffset: local.atOffset + start,
		};
	}
	if (
		start === 0 ||
		!boundedRejectionNeedsLeftContext(text, start, window, localOffset, analysis, maxWindow)
	) {
		return undefined;
	}

	// Restore one more fixed-width window of real source context only when syntax
	// touching the left edge can account for the local rejection. This reaches
	// earlier inline delimiters as well as escape runs without ever parsing the
	// full document.
	const contextStart = Math.max(0, start - maxWindow);
	const boundaryRun = contextStart > 0
		&& text[contextStart] === text[contextStart - 1]
		&& (text[contextStart] === '\\' || text[contextStart] === '`')
		? text[contextStart]
		: undefined;
	const unresolvedBoundaryRun = boundaryRun !== undefined;

	const contextWindow = text.slice(contextStart, end);
	if (metrics) metrics.analyzedLength += contextWindow.length;
	const contextOffset = offset - contextStart;
	const contextAnalysis = analyzeCitationDocument(contextWindow);
	const restored = getCitationCompletionContextAtOffset(
		contextWindow,
		contextOffset,
		contextAnalysis,
	);
	if (restored) {
		return {
			...restored,
			replaceStart: restored.replaceStart + contextStart,
			atOffset: restored.atOffset + contextStart,
		};
	}
	if (!unresolvedBoundaryRun) return undefined;

	// The lookbehind limit ended inside a delimiter run. Analyze one bounded
	// alternative that represents the other possible interpretation instead of
	// trusting arbitrary truncated parity/count. The language server still makes
	// the authoritative full-document decision before returning completion items.
	if (boundaryRun === '\\') {
		const alternateWindow = '\\' + contextWindow;
		if (metrics) metrics.analyzedLength += alternateWindow.length;
		const alternate = getCitationCompletionContextAtOffset(
			alternateWindow,
			contextOffset + 1,
			analyzeCitationDocument(alternateWindow),
		);
		if (!alternate) return undefined;
		return {
			...alternate,
			replaceStart: alternate.replaceStart - 1 + contextStart,
			atOffset: alternate.atOffset - 1 + contextStart,
		};
	}

	let runEnd = 0;
	while (runEnd < contextWindow.length && contextWindow[runEnd] === '`') runEnd++;
	const alternateWindow = ' '.repeat(runEnd) + contextWindow.slice(runEnd);
	if (metrics) metrics.analyzedLength += alternateWindow.length;
	const alternate = getCitationCompletionContextAtOffset(
		alternateWindow,
		contextOffset,
		analyzeCitationDocument(alternateWindow),
	);
	if (!alternate) return undefined;
	return {
		...alternate,
		replaceStart: alternate.replaceStart + contextStart,
		atOffset: alternate.atOffset + contextStart,
	};
}

export function hasBibliographyDemand(text: string): boolean {
	const scan = scanCitationDocument(text);
	return scan.usages.length > 0 || scan.hasNociteWildcard;
}
