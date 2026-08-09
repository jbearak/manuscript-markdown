import MarkdownIt from 'markdown-it';
import { isGfmDisallowedRawHtmlTagName } from './gfm';
import {
	computeCodeRegions,
	computeMarkdownInlineBlocks,
	computeMarkdownParsedBlocks,
	isBlankMarkdownContainerLine,
	type MarkdownInlineBlock,
} from './code-regions';
import {
	findCitationFrontmatterBounds,
	findFrontmatterBounds,
	findFrontmatterOpeningBounds,
	findFrontmatterRootIndent,
	findYamlMappingColon,
	MAX_PROVISIONAL_FRONTMATTER_LOOKAHEAD,
	parseYamlStringScalar,
	type FrontmatterBounds,
} from './frontmatter';
import {
	createNociteContinuationState,
	decodeNociteYamlText,
	isBoundaryValidNociteToken,
	isCitekeyChar,
	isEmailSeparatorAt,
	isEscaped,
	isNociteContinuationLine,
	isTopLevelFrontmatterMappingLine,
	parseBracketCitationRemainder,
	previousCodePoint,
	readMarkdownCitekey,
	scanNociteTokens,
	yamlCommentStart,
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

export interface CitationUsageGroup {
	start: number;
	end: number;
	form: 'bracket' | 'bare';
	usages: readonly CitationUsage[];
	items: readonly BracketCitationItem[];
}

export interface CitationOffsetRange {
	start: number;
	end: number;
}

type OffsetRange = CitationOffsetRange;

export interface CitationNociteRegion extends OffsetRange {
	blockScalar: boolean;
}

type NociteRegion = CitationNociteRegion;

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
	referenceLinkLabels: ReadonlyMap<string, string>;
	visibleLinkLabels: ReadonlySet<string>;
	imageLabels: ReadonlySet<string>;
	imageLabelRanges: readonly CitationOffsetRange[];
	frontmatterBounds?: FrontmatterBounds;
	citationBlocks: readonly MarkdownInlineBlock[];
	brackets: CitationBracketAnalysis;
	bracketItems: ReadonlyMap<number, BracketCitationItem>;
	nociteRegions: readonly CitationNociteRegion[];
}

const BARE_LEFT_EXCLUSION_RE = /[\p{L}\p{M}\p{N}._:\-\/+\x3d`]/u;
const BODY_LEFT_EXCLUSION_RE = /[\p{L}\p{M}\p{N}._\/+\x3d`]/u;
const referenceMarkdownIt = new MarkdownIt({ html: true, linkify: true });

// Keep these element-tag productions aligned with markdown-it/lib/common/html_re.mjs.
// Scanner candidates must satisfy the same CommonMark HTML grammar before their
// contents become citation-inert.
const COMMONMARK_HTML_ATTRIBUTE_NAME = '[A-Za-z_:][A-Za-z0-9:._-]*';
const COMMONMARK_HTML_UNQUOTED_VALUE = '[^"\'=<>`\\x00-\\x20]+';
const COMMONMARK_HTML_ATTRIBUTE_VALUE = '(?:' + COMMONMARK_HTML_UNQUOTED_VALUE
	+ '|\'[^\']*\'|"[^"]*")';
const COMMONMARK_HTML_ATTRIBUTE = '(?:\\s+' + COMMONMARK_HTML_ATTRIBUTE_NAME
	+ '(?:\\s*=\\s*' + COMMONMARK_HTML_ATTRIBUTE_VALUE + ')?)';
const COMMONMARK_HTML_ELEMENT_TAG_RE = new RegExp(
	'^(?:<[A-Za-z][A-Za-z0-9\\-]*' + COMMONMARK_HTML_ATTRIBUTE
	+ '*\\s*\\/?>|<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>)$',
);
const HTML_ENTITY_CANDIDATE_RE = /&(?:#[xX][0-9A-Fa-f]{1,8}|#[0-9]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});/y;

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
	const parts: string[] = [];
	let cursor = 0;
	for (const range of mergeRanges([...ranges])) {
		if (range.start > cursor) parts.push(text.slice(cursor, range.start));
		parts.push(text.slice(range.start, range.end).replace(/[^\r\n]/g, ' '));
		cursor = Math.max(cursor, range.end);
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts.join('');
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
			if (isEscaped(text, start)) {
				cursor = start + 1;
				continue;
			}
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

function isHtmlTagCandidateAt(text: string, start: number, end: number): boolean {
	return start < end - 1
		&& text[start] === '<'
		&& /[A-Za-z/!?]/.test(text[start + 1])
		&& !isEscaped(text, start);
}

export function computeHtmlTagRegions(
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
			if (isHtmlTagCandidateAt(text, cursor, block.end)) candidateCount++;
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
			if (start >= block.start && isHtmlTagCandidateAt(text, start, block.end)) {
				candidateEnds[candidateIndex--] = unquotedEnd;
			}
		}

		candidateIndex = 0;
		let consumedThrough = block.start;
		for (let start = block.start; start < block.end - 1; start++) {
			if (!isHtmlTagCandidateAt(text, start, block.end)) continue;
			const end = candidateEnds[candidateIndex++];
			if (
				start < consumedThrough
				|| end === -1
				|| !COMMONMARK_HTML_ELEMENT_TAG_RE.test(text.slice(start, end))
			) continue;
			regions.push({ start, end });
			consumedThrough = end;
		}
	}
	return regions;
}

interface HtmlElementTag {
	name: string;
	closing: boolean;
	range: OffsetRange;
}

function parseHtmlElementTag(text: string, range: OffsetRange): HtmlElementTag | undefined {
	const source = text.slice(range.start, range.end);
	const match = /^<(\/)?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/.exec(source);
	if (!match) return undefined;
	return {
		name: match[2].toLowerCase(),
		closing: match[1] !== undefined,
		range,
	};
}

function findRawHtmlCloser(
	text: string,
	name: string,
	start: number,
	end: number,
): OffsetRange | undefined {
	const closer = new RegExp('<\\/' + name + '\\s*>', 'ig');
	closer.lastIndex = start;
	while (closer.lastIndex < end) {
		const match = closer.exec(text);
		if (!match || match.index >= end) return undefined;
		const range = { start: match.index, end: match.index + match[0].length };
		if (range.end <= end && COMMONMARK_HTML_ELEMENT_TAG_RE.test(match[0])) return range;
	}
	return undefined;
}

function computeHtmlCitationInertContentRegions(
	text: string,
	parserBlocks: readonly OffsetRange[],
	tagRanges: readonly OffsetRange[],
): OffsetRange[] {
	const isCitationInertElement = (name: string): boolean =>
		name === 'code' || isGfmDisallowedRawHtmlTagName(name);
	const tags = tagRanges
		.map(range => parseHtmlElementTag(text, range))
		.filter((tag): tag is HtmlElementTag => tag !== undefined);
	const regions: OffsetRange[] = [];
	let tagIndex = 0;
	for (const block of parserBlocks) {
		while (tagIndex < tags.length && tags[tagIndex].range.end <= block.start) tagIndex++;
		let cursor = tagIndex;
		while (cursor < tags.length && tags[cursor].range.start < block.end) {
			const opener = tags[cursor];
			if (opener.closing || !isCitationInertElement(opener.name)) {
				cursor++;
				continue;
			}

			// Raw-text contents are not parsed as nested tags. Scan the source directly
			// for the first matching valid closer so quote-like fake tags cannot hide it.
			const close = opener.name === 'plaintext'
				? undefined
				: findRawHtmlCloser(text, opener.name, opener.range.end, block.end);
			const contentEnd = close?.start ?? block.end;
			if (contentEnd > opener.range.end) {
				regions.push({ start: opener.range.end, end: contentEnd });
			}
			const consumedEnd = close?.end ?? block.end;
			while (cursor < tags.length && tags[cursor].range.start < consumedEnd) cursor++;
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

function hasAcceptedMarkdownDestination(
	text: string,
	start: number,
	max: number,
	allowEmptyBeforeClose: boolean,
): boolean {
	let cursor = start;
	while (cursor < max && isLinkSpace(text[cursor])) cursor++;
	if (allowEmptyBeforeClose && text[cursor] === ')') return true;
	const destination = referenceMarkdownIt.helpers.parseLinkDestination(text, cursor, max);
	if (!destination.ok) return false;
	return referenceMarkdownIt.validateLink(referenceMarkdownIt.normalizeLink(destination.str));
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
	referenceLabelsByRange: Map<string, string>;
} {
	const destinations: OffsetRange[] = [];
	const labels = new Set<string>();
	const referenceLabelsByRange = new Map<string, string>();
	if (!text.includes('](') && !text.includes('][')) {
		return { destinations, labels, referenceLabelsByRange };
	}
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
					referenceLabelsByRange.set(
						labelStart + ':' + (i + 1),
						text.slice(i + 2, cursor),
					);
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
			if (
				cursor !== undefined
				&& hasAcceptedMarkdownDestination(text, start, max, true)
			) {
				destinations.push({ start, end: cursor });
				labels.add(labelStart + ':' + (i + 1));
				i = cursor;
			}
		}
	}
	return { destinations, labels, referenceLabelsByRange };
}

function normalizeReferenceLabel(label: string): string {
	return referenceMarkdownIt.utils.normalizeReference(label);
}

function computeReferenceDefinitionLabels(candidateText: string): Set<string> {
	const candidates = new Set<string>();
	for (const line of lineRanges(candidateText)) {
		const content = candidateText.slice(line.start, line.end).replace(/\r?\n$/, '');
		const definition = /^ {0,3}\[(?!\^)([^\]\n]+)\]:/.exec(content);
		if (definition) candidates.add(normalizeReferenceLabel(definition[1]));
	}
	if (candidates.size === 0) return candidates;

	// Parse the structurally masked Markdown once so definitions inside frontmatter,
	// code, and other inert regions cannot validate a body reference. Intersecting
	// parser results with root-level candidates keeps destination/title semantics
	// identical to Markdown-it while preserving the scanner's definition scope.
	const environment: { references?: Record<string, unknown> } = {};
	referenceMarkdownIt.parse(candidateText, environment);
	const references = environment.references;
	if (!references) return new Set();
	return new Set([...candidates].filter(label => Object.hasOwn(references, label)));
}

function isReferenceDestinationLine(line: string): boolean {
	const contentStart = line.match(/^[ \t]*/)?.[0].length ?? 0;
	return line.slice(contentStart).trim().length > 0
		&& hasAcceptedMarkdownDestination(line, contentStart, line.length, false)
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
		const inlineDestinationStart = definition[0].length;
		let hasDestination = content.slice(inlineDestinationStart).trim().length > 0
			&& hasAcceptedMarkdownDestination(
				content,
				inlineDestinationStart,
				content.length,
				false,
			)
			&& isValidInlineLinkContent(content, inlineDestinationStart, content.length);
		if (!hasDestination && content.slice(inlineDestinationStart).trim().length === 0) {
			const destination = lines[nextIndex];
			if (destination) {
				const destinationText = text.slice(destination.start, destination.end).replace(/\r?\n$/, '');
				if (isReferenceDestinationLine(destinationText) && !titleLine.test(destinationText)) {
					hasDestination = true;
					end = destination.end;
					i = nextIndex;
					nextIndex++;
				}
			}
		}
		if (!hasDestination) continue;
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

function computeCriticDeletionCloserOffsets(
	text: string,
	inlineBlocks: readonly OffsetRange[],
): ReadonlySet<number> {
	const closers = new Set<number>();
	for (const block of inlineBlocks) {
		let depth = 0;
		for (let cursor = block.start; cursor < block.end;) {
			if (text.startsWith('{--', cursor) && !isEscaped(text, cursor)) {
				depth++;
				cursor += 3;
				continue;
			}
			if (depth > 0 && text.startsWith('--}', cursor) && !isEscaped(text, cursor)) {
				closers.add(cursor);
				depth--;
				cursor += 3;
				continue;
			}
			cursor++;
		}
	}
	return closers;
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

interface BracketProjection {
	text: string;
	sourceStarts: number[];
	sourceEnds: number[];
	/** True only for characters authored directly rather than decoded from an entity. */
	authored: boolean[];
}

function projectVisibleBracketSource(
	text: string,
	bracket: OffsetRange,
	markupRanges: readonly OffsetRange[],
): BracketProjection {
	let visible = '';
	const sourceStarts: number[] = [];
	const sourceEnds: number[] = [];
	const authored: boolean[] = [];
	const append = (value: string, start: number, end: number, isAuthored: boolean) => {
		visible += value;
		for (let index = 0; index < value.length; index++) {
			sourceStarts.push(start);
			sourceEnds.push(end);
			authored.push(isAuthored);
		}
	};

	let markupIndex = 0;
	while (
		markupIndex < markupRanges.length
		&& markupRanges[markupIndex].end <= bracket.start
	) markupIndex++;
	for (let cursor = bracket.start; cursor < bracket.end;) {
		while (
			markupIndex < markupRanges.length
			&& markupRanges[markupIndex].end <= cursor
		) markupIndex++;
		const markup = markupRanges[markupIndex];
		if (markup && markup.start < bracket.end && cursor >= markup.start) {
			cursor = Math.min(markup.end, bracket.end);
			continue;
		}

		if (text[cursor] === '&') {
			HTML_ENTITY_CANDIDATE_RE.lastIndex = cursor;
			const match = HTML_ENTITY_CANDIDATE_RE.exec(text);
			if (match && match.index === cursor && cursor + match[0].length <= bracket.end) {
				const decoded = referenceMarkdownIt.utils.unescapeAll(match[0]);
				if (decoded !== match[0]) {
					append(decoded, cursor, cursor + match[0].length, false);
					cursor += match[0].length;
					continue;
				}
			}
		}
		append(text[cursor], cursor, cursor + 1, true);
		cursor++;
	}
	return { text: visible, sourceStarts, sourceEnds, authored };
}

function projectedBracketSegmentRanges(projection: BracketProjection): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	let start = 1;
	for (let cursor = 1; cursor < projection.text.length; cursor++) {
		const atEnd = cursor === projection.text.length - 1;
		if (!atEnd && !(projection.text[cursor] === ';' && projection.authored[cursor])) continue;
		let left = start;
		let right = cursor;
		while (left < right && /\s/.test(projection.text[left])) left++;
		while (right > left && /\s/.test(projection.text[right - 1])) right--;
		if (left < right) ranges.push({ start: left, end: right });
		start = cursor + 1;
	}
	return ranges;
}

function parseProjectedBracketItems(projection: BracketProjection): BracketCitationItem[] {
	if (projection.text[0] !== '[' || projection.text.at(-1) !== ']') return [];
	const items: BracketCitationItem[] = [];
	for (const segment of projectedBracketSegmentRanges(projection)) {
		let marker = segment.start;
		let suppressAuthor = false;
		if (
			projection.text[marker] === '-'
			&& projection.authored[marker]
			&& projection.text[marker + 1] === '@'
			&& projection.authored[marker + 1]
		) {
			suppressAuthor = true;
			marker++;
		}
		if (projection.text[marker] !== '@' || !projection.authored[marker]) continue;

		let keyEnd = marker + 1;
		let contiguous = true;
		while (keyEnd < segment.end && isCitekeyChar(projection.text[keyEnd])) {
			if (
				!projection.authored[keyEnd]
				|| (keyEnd > marker + 1
					&& projection.sourceStarts[keyEnd] !== projection.sourceEnds[keyEnd - 1])
			) contiguous = false;
			keyEnd++;
		}
		if (keyEnd === marker + 1 || !contiguous) continue;

		let remainderStart = keyEnd;
		while (remainderStart < segment.end && /\s/.test(projection.text[remainderStart])) {
			remainderStart++;
		}
		if (remainderStart < segment.end && !projection.authored[remainderStart]) continue;
		const key = projection.text.slice(marker + 1, keyEnd);
		const metadata = parseBracketCitationRemainder(
			key,
			projection.text.slice(keyEnd, segment.end),
		);
		if (!metadata) continue;
		items.push({
			key,
			atStart: projection.sourceStarts[marker],
			keyEnd: projection.sourceEnds[keyEnd - 1],
			suppressAuthor,
			...metadata,
		});
	}
	return items;
}

function citationBracketSegmentCountIgnoringMarkup(
	text: string,
	bracket: OffsetRange,
	markupRanges: readonly OffsetRange[],
): number {
	return projectedBracketSegmentRanges(
		projectVisibleBracketSource(text, bracket, markupRanges),
	).length;
}

function parseBracketCitationItemsIgnoringMarkup(
	text: string,
	bracket: OffsetRange,
	markupRanges: readonly OffsetRange[],
): BracketCitationItem[] {
	return parseProjectedBracketItems(projectVisibleBracketSource(text, bracket, markupRanges));
}

function parseNestedBracketCitationItemIgnoringMarkup(
	text: string,
	bracket: OffsetRange,
	atOffset: number,
	markupRanges: readonly OffsetRange[],
): BracketCitationItem | undefined {
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

	let segmentEnd = bracket.end - 1;
	for (let cursor = atOffset + 1; cursor < bracket.end - 1;) {
		const markup = rangeContaining(cursor, markupRanges);
		if (markup) {
			cursor = markup.end;
			continue;
		}
		if (text[cursor] === ';') {
			segmentEnd = cursor;
			break;
		}
		cursor++;
	}

	let visible = '';
	const sourceStarts: number[] = [];
	const sourceEnds: number[] = [];
	for (let cursor = separator + 1; cursor < segmentEnd;) {
		const markup = rangeContaining(cursor, markupRanges);
		if (markup) {
			cursor = markup.end;
			continue;
		}
		visible += text[cursor];
		sourceStarts.push(cursor);
		sourceEnds.push(cursor + 1);
		cursor++;
	}

	let left = 0;
	let right = visible.length;
	if (separator !== bracket.start) {
		while (left < right && /\s/.test(visible[left])) left++;
	}
	while (right > left && /\s/.test(visible[right - 1])) right--;
	let suppressAuthor = false;
	let visibleAt = left;
	if (visible[visibleAt] === '-' && visible[visibleAt + 1] === '@') {
		suppressAuthor = true;
		visibleAt++;
	}
	if (visible[visibleAt] !== '@' || sourceStarts[visibleAt] !== atOffset) return undefined;
	const parsed = readMarkdownCitekey(visible, visibleAt + 1);
	if (!parsed || parsed.end > right) return undefined;
	for (let index = visibleAt + 2; index < parsed.end; index++) {
		if (sourceStarts[index] !== sourceEnds[index - 1]) return undefined;
	}
	const metadata = parseBracketCitationRemainder(
		parsed.key,
		visible.slice(parsed.end, right),
	);
	if (!metadata) return undefined;
	return {
		key: parsed.key,
		atStart: atOffset,
		keyEnd: sourceEnds[parsed.end - 1],
		suppressAuthor,
		...metadata,
	};
}

function parseNestedBracketCitationItemsIgnoringMarkup(
	text: string,
	bracket: OffsetRange,
	atOffsets: readonly number[],
	markupRanges: readonly OffsetRange[],
): BracketCitationItem[] {
	const sortedOffsets = [...atOffsets].sort((left, right) => left - right);
	const items: BracketCitationItem[] = [];
	let markerIndex = 0;
	let segmentStart = bracket.start + 1;
	const processSegment = (segmentEnd: number) => {
		while (markerIndex < sortedOffsets.length && sortedOffsets[markerIndex] < segmentStart) {
			markerIndex++;
		}
		if (markerIndex < sortedOffsets.length && sortedOffsets[markerIndex] < segmentEnd) {
			const item = parseNestedBracketCitationItemIgnoringMarkup(
				text,
				bracket,
				sortedOffsets[markerIndex],
				markupRanges,
			);
			if (item) items.push(item);
		}
		while (markerIndex < sortedOffsets.length && sortedOffsets[markerIndex] < segmentEnd) {
			markerIndex++;
		}
	};

	for (let cursor = bracket.start + 1; cursor < bracket.end - 1; cursor++) {
		const markup = rangeContaining(cursor, markupRanges);
		if (markup) {
			cursor = markup.end - 1;
			continue;
		}
		if (text[cursor] !== ';') continue;
		processSegment(cursor);
		segmentStart = cursor + 1;
	}
	processSegment(bracket.end - 1);
	return items;
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
	if (referenceLabels.size === 0) return false;
	if (text[bracket.end] === '[') {
		let cursor = bracket.end + 1;
		while (cursor < text.length && text[cursor] !== '\n') {
			if (text[cursor] === ']' && !isEscaped(text, cursor)) {
				const explicitLabel = text.slice(bracket.end + 1, cursor);
				const label = explicitLabel || text.slice(bracket.start + 1, bracket.end - 1);
				return referenceLabels.has(normalizeReferenceLabel(label));
			}
			cursor++;
		}
		return false;
	}
	const ownLabel = text.slice(bracket.start + 1, bracket.end - 1);
	return referenceLabels.has(normalizeReferenceLabel(ownLabel));
}

function isImageLabel(text: string, bracket: OffsetRange): boolean {
	const marker = bracket.start - 1;
	return marker >= 0 && text[marker] === '!' && !isEscaped(text, marker);
}

function isResolvedNestedImageLabel(
	bracket: OffsetRange,
	inlineLinkLabels: ReadonlySet<string>,
	referenceLinkLabels: ReadonlyMap<string, string>,
	referenceLabels: ReadonlySet<string>,
): boolean {
	const identity = rangeIdentity(bracket);
	if (inlineLinkLabels.has(identity)) return true;
	const explicitLabel = referenceLinkLabels.get(identity);
	return explicitLabel !== undefined
		&& explicitLabel.length > 0
		&& referenceLabels.has(normalizeReferenceLabel(explicitLabel));
}

function collectNociteRegions(
	text: string,
	bounds: FrontmatterBounds | undefined = findFrontmatterBounds(text),
): NociteRegion[] {
	if (!bounds) return [];
	const regions: NociteRegion[] = [];
	const rootIndent = findFrontmatterRootIndent(text, bounds.contentEnd);
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
		const physicalIndent = line.length - line.trimStart().length;
		const logicalLine = physicalIndent === rootIndent
			? line.slice(rootIndent)
			: '';
		const logicalColon = findYamlMappingColon(logicalLine);
		if (
			logicalColon < 0
			|| parseYamlStringScalar(logicalLine.slice(0, logicalColon)) !== 'nocite'
		) {
			lineStart = newline === -1 ? bounds.contentEnd : newline + 1;
			continue;
		}

		// YAML mappings use the last duplicate key as the effective value. Discard
		// every earlier nocite declaration before collecting this declaration's ranges.
		regions.length = 0;
		const colon = lineStart + rootIndent + logicalColon;
		let valueStart = colon + 1;
		while (valueStart < lineEnd && /[ \t]/.test(text[valueStart])) valueStart++;
		const firstValue = text.slice(valueStart, lineEnd);
		const continuation = createNociteContinuationState(firstValue);
		const blockScalar = continuation.mode === 'block-scalar';
		if (continuation.mode === 'single-line') {
			const rootFlowEnd = continuation.rootFlowCloseOffset === undefined
				? lineEnd
				: valueStart + continuation.rootFlowCloseOffset;
			regions.push({ start: valueStart, end: yamlCommentStart(text, valueStart, rootFlowEnd), blockScalar: false });
			lineStart = newline === -1 ? bounds.contentEnd : newline + 1;
			continue;
		}

		let continuationStart = newline === -1 ? bounds.contentEnd : newline + 1;
		// The opening line is semantically part of the value even when the very
		// first continuation is a logical-root mapping and must be rejected.
		let flowEnd = lineEnd;
		while (continuationStart < bounds.contentEnd) {
			const nextNewline = text.indexOf('\n', continuationStart);
			const nextRawEnd = nextNewline === -1 || nextNewline > bounds.contentEnd ? bounds.contentEnd : nextNewline;
			const nextEnd = nextRawEnd > continuationStart && text[nextRawEnd - 1] === '\r' ? nextRawEnd - 1 : nextRawEnd;
			const nextLine = text.slice(continuationStart, nextEnd);
			const nextIndent = nextLine.length - nextLine.trimStart().length;
			const logicalStart = Math.min(rootIndent, nextIndent);
			const logicalNextLine = nextLine.slice(logicalStart);
			if (!isNociteContinuationLine(continuation, logicalNextLine)) break;
			if (blockScalar) {
				regions.push({
					start: continuationStart + nextIndent,
					end: nextEnd,
					blockScalar: true,
				});
			} else {
				flowEnd = continuationStart + logicalStart
					+ (continuation.rootFlowCloseOffset ?? logicalNextLine.length);
			}
			continuationStart = nextNewline === -1 ? bounds.contentEnd : nextNewline + 1;
		}
		if (!blockScalar) {
			regions.push({ start: valueStart, end: flowEnd, blockScalar: false });
		}
		lineStart = Math.max(continuationStart, newline === -1 ? bounds.contentEnd : newline + 1);
	}
	return regions.filter(region => region.end > region.start);
}

function bodyExcludedRanges(text: string): {
	ranges: OffsetRange[];
	citationMarkupRanges: OffsetRange[];
	frontmatter?: OffsetRange;
	frontmatterBounds?: FrontmatterBounds;
	referenceLabels: Set<string>;
	inlineLinkLabels: Set<string>;
	referenceLinkLabels: ReadonlyMap<string, string>;
	citationBlocks: MarkdownInlineBlock[];
} {
	const bounds = findFrontmatterBounds(text);
	const frontmatter = bounds ? { start: bounds.start, end: bounds.bodyStart } : undefined;

	// Only closed frontmatter is globally authoritative. Parser-derived blocks
	// are computed once from the structurally equivalent masked source. Ordinary
	// raw-HTML text remains citation-aware, while tags, comments, and script/style/
	// code contents are masked before inline links and brackets are interpreted.
	// Every delimiter scan remains local to one parser block. Code parsing keeps raw
	// HTML disabled so backticks inside HTML table cells retain their established meaning.
	const primaryInput = frontmatter ? maskRanges(text, [frontmatter]) : text;
	const parsedBlocks = computeMarkdownParsedBlocks(primaryInput);
	const citationBlocks = [...parsedBlocks.inlineBlocks, ...parsedBlocks.htmlBlocks]
		.sort((a, b) => a.start - b.start || a.end - b.end)
		.map((range, id) => ({ id, start: range.start, end: range.end }));
	const htmlTagRegions = computeHtmlTagRegions(primaryInput, citationBlocks);
	const citationMarkupRanges = selectOutermostRanges([
		...computeHtmlCommentRegions(
			primaryInput,
			parsedBlocks.inlineBlocks,
			parsedBlocks.htmlBlocks,
		),
		...htmlTagRegions,
		...computeHtmlCitationInertContentRegions(
			primaryInput,
			citationBlocks,
			htmlTagRegions,
		),
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
	const referenceLabels = computeReferenceDefinitionLabels(structuralInput);
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
		frontmatterBounds: bounds,
		referenceLabels,
		inlineLinkLabels: links.labels,
		referenceLinkLabels: links.referenceLabelsByRange,
		citationBlocks,
	};
}

function citekeyContinuesAcrossMarkup(
	text: string,
	keyEnd: number,
	markupRanges: readonly OffsetRange[],
): boolean {
	let cursor = keyEnd;
	let skippedMarkup = false;
	while (true) {
		const markup = rangeContaining(cursor, markupRanges);
		if (!markup || markup.start !== cursor) break;
		skippedMarkup = true;
		cursor = markup.end;
	}
	return skippedMarkup && isCitekeyChar(text[cursor]);
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
	region: NociteRegion,
): { usages: CitationUsage[]; wildcard: boolean } {
	const usages: CitationUsage[] = [];
	let wildcard = false;
	const source = text.slice(region.start, region.end);
	const decoded = region.blockScalar ? undefined : decodeNociteYamlText(source);
	const scanText = decoded?.text ?? source;
	for (const token of scanNociteTokens(scanText)) {
		if (token.wildcard) {
			wildcard = true;
			continue;
		}
		if (token.key === undefined) continue;
		const atStart = region.start + (decoded?.sourceStarts[token.atStart] ?? token.atStart);
		const keyStart = region.start + (decoded?.sourceStarts[token.atStart + 1] ?? token.atStart + 1);
		const keyEnd = region.start + (decoded?.sourceEnds[token.end - 1] ?? token.end);
		usages.push({
			key: token.key,
			atStart,
			keyStart,
			keyEnd,
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
		frontmatterBounds,
		referenceLabels,
		inlineLinkLabels,
		referenceLinkLabels,
		citationBlocks,
	} = bodyExcludedRanges(text);
	const bracketInput = maskRanges(text, excludedRanges);
	const brackets = analyzeCitationBrackets(bracketInput, citationBlocks);
	const criticDeletionCloserOffsets = computeCriticDeletionCloserOffsets(
		bracketInput,
		citationBlocks,
	);
	const bracketItems = new Map<number, BracketCitationItem>();
	const visibleLinkLabels = new Set<string>();
	const imageLabels = new Set<string>();
	const rawImageLabelRanges: OffsetRange[] = [];
	const citationBrackets = new Map<string, {
		bracket: OffsetRange;
		atOffsets: number[];
	}>();
	for (const [atOffset, bracket] of brackets.balancedContexts) {
		const identity = rangeIdentity(bracket);
		const candidate = citationBrackets.get(identity);
		if (candidate) candidate.atOffsets.push(atOffset);
		else citationBrackets.set(identity, { bracket, atOffsets: [atOffset] });
	}
	for (const { bracket, atOffsets } of citationBrackets.values()) {
		const identity = rangeIdentity(bracket);
		if (isVisibleLinkLabel(text, bracket, referenceLabels, inlineLinkLabels)) {
			visibleLinkLabels.add(identity);
			if (isImageLabel(text, bracket)) {
				imageLabels.add(identity);
				rawImageLabelRanges.push(bracket);
			}
			continue;
		}
		if (hasNestedBalancedBracket(bracket, brackets.balancedRanges)) {
			// Parse each directly owned semicolon segment once. Rebuilding the same
			// nested bracket suffix for every @ marker is quadratic on malformed input.
			for (const item of parseNestedBracketCitationItemsIgnoringMarkup(
				text,
				bracket,
				atOffsets,
				citationMarkupRanges,
			)) bracketItems.set(item.atStart, item);
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
	// A nested citation belongs to its innermost bracket, so inspect only
	// syntactic image-label candidates when looking for an enclosing alt label.
	for (const bracket of brackets.balancedRanges) {
		if (!isImageLabel(text, bracket)) continue;
		const identity = rangeIdentity(bracket);
		if (
			imageLabels.has(identity) ||
			!isResolvedNestedImageLabel(
				bracket,
				inlineLinkLabels,
				referenceLinkLabels,
				referenceLabels,
			)
		) continue;
		imageLabels.add(identity);
		rawImageLabelRanges.push(bracket);
	}
	const imageLabelRanges = selectOutermostRanges(rawImageLabelRanges);

	const usages: CitationUsage[] = [];
	let excludedIndex = 0;
	for (let cursor = 0; cursor < text.length; cursor++) {
		while (excludedIndex < excludedRanges.length && cursor >= excludedRanges[excludedIndex].end) excludedIndex++;
		if (text[cursor] !== '@') continue;
		if (excludedIndex < excludedRanges.length && cursor >= excludedRanges[excludedIndex].start) continue;
		const parsed = readMarkdownCitekey(
			text,
			cursor + 1,
			criticDeletionCloserOffsets,
		);
		if (
			!parsed
			|| citekeyContinuesAcrossMarkup(text, parsed.end, citationMarkupRanges)
		) continue;

		const bracket = brackets.balancedContexts.get(cursor);
		const identity = bracket === undefined ? undefined : rangeIdentity(bracket);
		if (rangeContaining(cursor, imageLabelRanges)) continue;
		const linkLabel = identity !== undefined && visibleLinkLabels.has(identity);
		const bracketItem = bracketItems.get(cursor);
		if (
			bracketItem
			&& (bracketItem.key !== parsed.key || bracketItem.keyEnd !== parsed.end)
		) continue;
		const bracketed = bracketItem !== undefined;
		if (bracket && !bracketed && !linkLabel) continue;
		const compactCriticDeletion = criticDeletionCloserOffsets.has(parsed.end)
			&& cursor >= 3
			&& text.startsWith('{--', cursor - 3);
		if (
			bracketed
				? !isValidBodyCandidate(text, cursor, true)
				: !isBoundaryValidBareCitation(text, cursor) && !compactCriticDeletion
		) continue;
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
		referenceLinkLabels,
		visibleLinkLabels,
		imageLabels,
		imageLabelRanges,
		frontmatterBounds,
		citationBlocks,
		brackets,
		bracketItems,
		nociteRegions,
	};
}

function analysisFor(text: string, analysis?: CitationDocumentAnalysis): CitationDocumentAnalysis {
	return analysis ?? analyzeCitationDocument(text);
}

function hasNestedBalancedBracket(
	bracket: OffsetRange,
	ranges: readonly OffsetRange[],
): boolean {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (ranges[mid].start <= bracket.start) low = mid + 1;
		else high = mid;
	}
	return low < ranges.length
		&& ranges[low].start < bracket.end
		&& ranges[low].end < bracket.end;
}

/** Group visible citation usages into the source spans an exporter replaces. */
export function groupCitationUsages(
	text: string,
	analysis?: CitationDocumentAnalysis,
): CitationUsageGroup[] {
	const resolved = analysisFor(text, analysis);
	const groups: CitationUsageGroup[] = [];
	const bracketGroups = new Map<number, {
		end: number;
		usages: CitationUsage[];
	}>();
	for (const usage of resolved.usages) {
		if (usage.form === 'nocite') continue;
		if (usage.form === 'bare') {
			const unfinishedBracket = resolved.brackets.contexts.get(usage.atStart);
			if (
				unfinishedBracket
				&& !resolved.brackets.balancedContexts.has(usage.atStart)
				&& isSupportedCitationBracket(text, unfinishedBracket)
			) continue;
			groups.push({
				start: usage.atStart,
				end: usage.keyEnd,
				form: 'bare',
				usages: [usage],
				items: [],
			});
			continue;
		}

		const context = resolved.brackets.balancedContexts.get(usage.atStart);
		if (!context) continue;
		const group = bracketGroups.get(context.start);
		if (group) group.usages.push(usage);
		else bracketGroups.set(context.start, { end: context.end, usages: [usage] });
	}
	for (const [start, group] of bracketGroups) {
		const bracket = { start, end: group.end };
		const items = group.usages.flatMap(usage => {
			const item = resolved.bracketItems.get(usage.atStart);
			return item
				&& item.key === usage.key
				&& item.atStart === usage.atStart
				&& item.keyEnd === usage.keyEnd
				? [item]
				: [];
		});
		const hasNestedBracket = hasNestedBalancedBracket(
			bracket,
			resolved.brackets.balancedRanges,
		);
		// Export only clusters whose complete source span is understood. Falling
		// back to literal text is preferable to consuming unsupported prefixes,
		// empty segments, or nested citation markup that cannot be reconstructed.
		if (hasNestedBracket) continue;
		const segmentCount = citationBracketSegmentCountIgnoringMarkup(
			text,
			bracket,
			resolved.citationMarkupRanges,
		);
		if (items.length !== segmentCount) continue;
		groups.push({
			...bracket,
			form: 'bracket',
			usages: group.usages,
			items,
		});
	}
	return groups.sort((left, right) => left.start - right.start);
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
	if (rangeContaining(atOffset, resolved.imageLabelRanges)) return false;
	const bracket = findBalancedBracketContainingOffset(atOffset, resolved.brackets);
	return bracket !== undefined
		&& isSupportedCitationBracket(text, bracket)
		&& !resolved.visibleLinkLabels.has(rangeIdentity(bracket));
}

function isBoundaryValidNociteSourceMarker(
	text: string,
	atOffset: number,
	region: NociteRegion,
): boolean {
	if (region.blockScalar) {
		return isBoundaryValidNociteToken(text, atOffset, region.start);
	}
	const sourceOffset = atOffset - region.start;
	const decoded = decodeNociteYamlText(text.slice(region.start, region.end));
	const decodedAt = decoded.sourceStarts.findIndex((start, index) =>
		start === sourceOffset
		&& decoded.sourceEnds[index] === sourceOffset + 1
		&& decoded.text[index] === '@',
	);
	return decodedAt >= 0 && isBoundaryValidNociteToken(decoded.text, decodedAt);
}

type ProvisionalFrontmatterCompletion =
	| { kind: 'nocite'; region: NociteRegion }
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
	const opening = findFrontmatterOpeningBounds(text);
	if (!opening) return undefined;
	const provisionalEnd = Math.min(
		text.length,
		opening.bodyStart + MAX_PROVISIONAL_FRONTMATTER_LOOKAHEAD,
	);
	if (atOffset >= provisionalEnd && provisionalEnd < text.length) return undefined;
	const bounds = findCitationFrontmatterBounds(text, provisionalEnd);
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
	const rootIndent = findFrontmatterRootIndent(text, bounds.contentEnd);
	const logicalLine = (value: string): string =>
		value.slice(0, rootIndent).trim().length === 0
			? value.slice(rootIndent)
			: value;
	const topLevelMapping = isTopLevelFrontmatterMappingLine(
		logicalLine(lineBeforeCitation),
	);
	if (topLevelMapping) return { kind: 'suppress' };

	// Lines deeper than the logical root belong locally to the nearest
	// uninterrupted root-level YAML field. Valid nocite continuations were
	// handled above; all other fields suppress citekey completion at this cursor.
	const physicalIndent = line.length - line.trimStart().length;
	if (physicalIndent > rootIndent && line.trim().length > 0) {
		let previousEnd = lineStart > 0 ? lineStart - 1 : 0;
		while (previousEnd > bounds.contentStart) {
			const previousStart = text.lastIndexOf('\n', previousEnd - 1) + 1;
			const previous = text.slice(previousStart, previousEnd).replace(/\r$/, '');
			if (previous.trim().length === 0) break;
			if (isTopLevelFrontmatterMappingLine(logicalLine(previous))) {
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
		if (!isBoundaryValidNociteSourceMarker(text, atOffset, provisional.region)) return undefined;
		return { prefix: text.slice(replaceStart, offset), replaceStart, atOffset, form: 'nocite' };
	}

	const resolved = analysisFor(text, analysis);
	const nociteRegion = resolved.nociteRegions.find(region => atOffset >= region.start && atOffset < region.end);
	if (nociteRegion) {
		if (!isBoundaryValidNociteSourceMarker(text, atOffset, nociteRegion)) return undefined;
		return { prefix: text.slice(replaceStart, offset), replaceStart, atOffset, form: 'nocite' };
	}

	if (
		rangeContaining(atOffset, resolved.excludedRanges) ||
		rangeContaining(atOffset, resolved.imageLabelRanges)
	) return undefined;
	const bracket = findBracketContext(resolved.brackets, atOffset, false);
	const linkLabel = bracket !== undefined && resolved.visibleLinkLabels.has(rangeIdentity(bracket));
	const bracketed = bracket !== undefined
		&& !linkLabel
		&& isSupportedCitationBracket(text, bracket)
		&& isCitationItemMarkerAt(text, bracket, atOffset, resolved.citationMarkupRanges);
	const balancedBracket = resolved.brackets.balancedContexts.has(atOffset);
	if (balancedBracket && !bracketed) return undefined;
	if (citekeyContinuesAcrossMarkup(text, offset, resolved.citationMarkupRanges)) return undefined;
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
	/** Total source length parsed across the primary and restored-context passes. */
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

function boundedInlineLookbehindStart(
	text: string,
	windowStart: number,
	maxWindow: number,
): number {
	const lowerBound = Math.max(0, windowStart - maxWindow * 2);
	const boundedPrefix = text.slice(lowerBound, windowStart);
	let lineEnd = boundedPrefix.length;
	if (lineEnd > 0 && boundedPrefix[lineEnd - 1] === '\n') lineEnd--;
	while (lineEnd >= 0) {
		const newline = boundedPrefix.lastIndexOf('\n', lineEnd - 1);
		const line = boundedPrefix.slice(newline + 1, lineEnd).replace(/\r$/, '');
		if (isBlankMarkdownContainerLine(line)) return lowerBound + lineEnd + 1;
		if (newline === -1) break;
		lineEnd = newline;
	}
	return lowerBound;
}

function localCodeExclusionMayDependOnLeftContext(
	text: string,
	windowStart: number,
	window: string,
	localDelimiter: number,
	maxWindow: number,
	analysis: CitationDocumentAnalysis,
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
	const localBlock = rangeContaining(localDelimiter, analysis.citationBlocks);
	const lookbehindStart = localBlock?.start === 0
		? boundedInlineLookbehindStart(text, windowStart, maxWindow)
		: windowStart;
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

function linkLabelForDestination(
	analysis: CitationDocumentAnalysis,
	destinationStart: number,
): number | undefined {
	const labelIdentities: readonly Iterable<string>[] = [
		analysis.inlineLinkLabels,
		analysis.referenceLinkLabels.keys(),
	];
	for (const identities of labelIdentities) {
		for (const identity of identities) {
			const separator = identity.indexOf(':');
			if (separator === -1) continue;
			const labelStart = Number(identity.slice(0, separator));
			const labelEnd = Number(identity.slice(separator + 1));
			if (Number.isInteger(labelStart) && labelEnd + 1 === destinationStart) {
				return labelStart;
			}
		}
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

	const imageLabel = rangeContaining(atOffset, analysis.imageLabelRanges);
	if (imageLabel) {
		const marker = imageLabel.start - 1;
		return marker >= 0 && localEscapeParityDiffersFromSource(
			text, windowStart, window, marker, maxWindow,
		);
	}

	const excluded = rangeContaining(atOffset, analysis.excludedRanges);
	if (excluded) {
		const labelStart = linkLabelForDestination(analysis, excluded.start);
		if (labelStart !== undefined) {
			return localEscapeParityDiffersFromSource(
				text, windowStart, window, labelStart, maxWindow,
			);
		}
		if (window[excluded.start] === '`') {
			return localEscapeParityDiffersFromSource(
				text, windowStart, window, excluded.start, maxWindow,
			) || localCodeExclusionMayDependOnLeftContext(
				text, windowStart, window, excluded.start, maxWindow, analysis,
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
	const contextStart = Math.max(0, start - maxWindow * 2);
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
