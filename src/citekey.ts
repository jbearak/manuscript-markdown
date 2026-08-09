/** Shared citation-key lexical primitives. Keep this alphabet in sync with TextMate rules. */
export const CITEKEY_CHARACTER_CLASS = 'A-Za-z0-9_:-';
export const CITEKEY_PATTERN_SOURCE = '[' + CITEKEY_CHARACTER_CLASS + ']+';

const CITEKEY_CHAR_RE = /^[A-Za-z0-9_:-]$/;
const CITEKEY_RE = new RegExp('^' + CITEKEY_PATTERN_SOURCE + '$');
const EMAIL_LOCAL_ATOM_RE = /^[\p{L}\p{M}\p{N}.!#$%&'*+\/=?^_`{|}~-]$/u;
const EMAIL_DOMAIN_START_RE = /^[\p{L}\p{N}]$/u;
const EMAIL_DOMAIN_CHAR_RE = /^[\p{L}\p{M}\p{N}.-]$/u;
const NOCITE_LEFT_EXCLUSION_RE = /[\p{L}\p{M}\p{N}._:\-\/+\x3d`]/u;

export function isCitekeyChar(ch: string | undefined): boolean {
	return ch !== undefined && CITEKEY_CHAR_RE.test(ch);
}

export function isCitekey(value: string): boolean {
	return CITEKEY_RE.test(value);
}

export function readCitekey(text: string, start: number): { key: string; end: number } | undefined {
	let end = start;
	while (end < text.length && isCitekeyChar(text[end])) end++;
	if (end === start) return undefined;
	return { key: text.slice(start, end), end };
}

/** Read a citekey from Markdown, excluding a structurally verified Critic deletion closer. */
export function readMarkdownCitekey(
	text: string,
	start: number,
	criticDeletionCloserOffsets?: ReadonlySet<number>,
): { key: string; end: number } | undefined {
	const parsed = readCitekey(text, start);
	if (!parsed) return undefined;
	const closerStart = parsed.end - 2;
	const end = parsed.key.endsWith('--')
		&& text[parsed.end] === '}'
		&& criticDeletionCloserOffsets?.has(closerStart)
		? closerStart
		: parsed.end;
	if (end === start) return undefined;
	return { key: text.slice(start, end), end };
}

export function isEscaped(text: string, offset: number): boolean {
	let slashes = 0;
	for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
	return slashes % 2 === 1;
}

export function previousCodePoint(text: string, end: number): { start: number; value: string } | undefined {
	if (end <= 0) return undefined;
	let start = end - 1;
	const low = text.charCodeAt(start);
	if (low >= 0xDC00 && low <= 0xDFFF && start > 0) {
		const high = text.charCodeAt(start - 1);
		if (high >= 0xD800 && high <= 0xDBFF) start--;
	}
	return { start, value: text.slice(start, end) };
}

function nextCodePoint(text: string, start: number): { end: number; value: string } | undefined {
	if (start >= text.length) return undefined;
	const first = text.charCodeAt(start);
	const width = first >= 0xD800 && first <= 0xDBFF
		&& start + 1 < text.length
		&& text.charCodeAt(start + 1) >= 0xDC00
		&& text.charCodeAt(start + 1) <= 0xDFFF
		? 2
		: 1;
	return { end: start + width, value: text.slice(start, start + width) };
}

/**
 * Return whether `@` is the separator of an email address rather than a citation.
 * This deliberately supports quoted local parts and Unicode/EAI atoms without
 * treating an isolated opening quote or ordinary prose punctuation as email.
 */
export function isEmailSeparatorAt(text: string, atOffset: number): boolean {
	if (text[atOffset] !== '@' || atOffset === 0 || atOffset + 1 >= text.length) return false;

	const domainStart = nextCodePoint(text, atOffset + 1);
	if (!domainStart || !EMAIL_DOMAIN_START_RE.test(domainStart.value)) return false;
	let domainEnd = atOffset + 1;
	while (domainEnd < text.length) {
		const point = nextCodePoint(text, domainEnd);
		if (!point || !EMAIL_DOMAIN_CHAR_RE.test(point.value)) break;
		domainEnd = point.end;
	}
	while (domainEnd > atOffset + 1 && text[domainEnd - 1] === '.') domainEnd--;
	const domain = text.slice(atOffset + 1, domainEnd);
	if (!domain || domain.startsWith('.') || domain.includes('..')) return false;
	if (domain.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) return false;

	if (text[atOffset - 1] === '"' && !isEscaped(text, atOffset - 1)) {
		for (let i = atOffset - 2; i >= 0 && text[i] !== '\n' && text[i] !== '\r'; i--) {
			if (text[i] === '"' && !isEscaped(text, i)) return i < atOffset - 2;
		}
		return false;
	}

	let localStart = atOffset;
	while (localStart > 0) {
		const point = previousCodePoint(text, localStart);
		if (!point || !EMAIL_LOCAL_ATOM_RE.test(point.value)) break;
		localStart = point.start;
	}
	if (localStart === atOffset) return false;
	const local = text.slice(localStart, atOffset);
	return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
		&& /[\p{L}\p{N}]/u.test(local);
}

export interface CitationOccurrenceMetadata {
	key: string;
	suppressAuthor: boolean;
	locator?: string;
}

export interface BracketCitationItem extends CitationOccurrenceMetadata {
	atStart: number;
	keyEnd: number;
}

/** Parse the text after a bracket-citation key, preserving a literal `--}` key boundary. */
export function parseBracketCitationRemainder(
	key: string,
	remainder: string,
): { locator?: string } | undefined {
	const trimmed = remainder.trim();
	if (!trimmed || (key.endsWith('--') && trimmed === '}')) return {};
	if (!trimmed.startsWith(',')) return undefined;
	const locator = trimmed.slice(1).trim();
	return locator ? { locator } : {};
}

/** Parse the exporter-supported `[@...]` / `[-@...]` citation-list subset. */
export function parseBracketCitationItems(
	text: string,
	start: number,
	end: number,
): BracketCitationItem[] {
	if (end <= start + 2 || text[end - 1] !== ']') return [];
	if (!text.startsWith('[@', start) && !text.startsWith('[-@', start)) return [];

	const items: BracketCitationItem[] = [];
	let segmentStart = start + 1;
	let itemIndex = 0;
	for (let cursor = segmentStart; cursor <= end - 1; cursor++) {
		if (cursor < end - 1 && text[cursor] !== ';') continue;
		let left = segmentStart;
		let right = cursor;
		while (left < right && /\s/.test(text[left])) left++;
		while (right > left && /\s/.test(text[right - 1])) right--;

		let suppressAuthor = false;
		let atStart = left;
		if (text[atStart] === '-' && text[atStart + 1] === '@') {
			suppressAuthor = true;
			atStart++;
		}
		if (text[atStart] === '@' && (itemIndex === 0 || atStart === left || suppressAuthor)) {
			const parsed = readMarkdownCitekey(text, atStart + 1);
			if (parsed && parsed.end <= right) {
				const metadata = parseBracketCitationRemainder(
					parsed.key,
					text.slice(parsed.end, right),
				);
				if (metadata) {
					items.push({
						key: parsed.key,
						atStart,
						keyEnd: parsed.end,
						suppressAuthor,
						...metadata,
					});
				}
			}
		}
		itemIndex++;
		segmentStart = cursor + 1;
	}
	return items;
}

export interface NociteValue {
	/** Parsed citekeys in authored order. */
	keys: string[];
	/** Whether the authored value contains Pandoc's all-entries wildcard. */
	wildcard: boolean;
	/** Authored YAML value payload, excluding the `nocite:` key and colon. */
	raw?: string;
}

function isYamlHorizontalSpace(char: string | undefined): boolean {
	return char === ' ' || char === '\t';
}

function yamlLineFirstNonWhitespaceBefore(
	text: string,
	start: number,
	end: number,
): Int32Array {
	const firstBefore = new Int32Array(end - start).fill(-1);
	let first = -1;
	for (let offset = start; offset < end; offset++) {
		firstBefore[offset - start] = first;
		const char = text[offset];
		if (char === '\n' || char === '\r') first = -1;
		else if (first === -1 && !isYamlHorizontalSpace(char)) first = offset;
	}
	return firstBefore;
}

function canStartYamlQuotedScalar(
	text: string,
	offset: number,
	start: number,
	flowDepth: number,
	lineFirstNonWhitespace: number,
): boolean {
	let previous = offset - 1;
	while (previous >= start && isYamlHorizontalSpace(text[previous])) previous--;
	if (previous < start || text[previous] === '\n' || text[previous] === '\r') return true;
	const separator = text[previous];
	if (separator === '[' || separator === '{') return true;
	if (separator === ',') return flowDepth > 0;
	if (separator === ':') return flowDepth > 0 || previous + 1 < offset;
	if (separator === '?') return previous + 1 < offset;
	if (separator !== '-' || previous + 1 === offset) return false;
	return lineFirstNonWhitespace === previous;
}

/** Locate a YAML inline comment without treating quotes inside plain scalars as delimiters. */
export function yamlCommentStart(text: string, start = 0, end = text.length): number {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	let flowDepth = 0;
	const lineFirstNonWhitespace = yamlLineFirstNonWhitespaceBefore(text, start, end);
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
		if (
			(char === '"' || char === "'")
			&& canStartYamlQuotedScalar(
				text,
				i,
				start,
				flowDepth,
				lineFirstNonWhitespace[i - start],
			)
		) {
			quote = char;
		} else if (char === '[' || char === '{') {
			flowDepth++;
		} else if ((char === ']' || char === '}') && flowDepth > 0) {
			flowDepth--;
		} else if (char === '#' && (i === start || isYamlHorizontalSpace(text[i - 1]))) {
			return i;
		}
	}
	return end;
}

export function yamlValueBeforeComment(value: string): string {
	return value.slice(0, yamlCommentStart(value));
}

const COMPACT_URI_SCHEME_RE = /^(?:data|doi|file|ftp|ftps|http|https|mailto|tel|urn)$/i;

export function isTopLevelFrontmatterMappingLine(line: string): boolean {
	if (/^(?:[\s#]|-(?:$|[ \t]))/.test(line)) return false;
	let quote: '"' | "'" | undefined;
	let flowDepth = 0;
	const lineFirstNonWhitespace = yamlLineFirstNonWhitespaceBefore(line, 0, line.length);
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quote === '"') {
			if (char === '\\') i++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (quote === "'") {
			if (char === quote && line[i + 1] === quote) i++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (
			(char === '"' || char === "'")
			&& canStartYamlQuotedScalar(line, i, 0, flowDepth, lineFirstNonWhitespace[i])
		) {
			quote = char;
		} else if (char === '[' || char === '{') {
			flowDepth++;
		} else if ((char === ']' || char === '}') && flowDepth > 0) {
			flowDepth--;
		} else if (char === '#' && (i === 0 || isYamlHorizontalSpace(line[i - 1]))) {
			return false;
		} else if (char === ':' && flowDepth === 0) {
			const next = line[i + 1];
			if (next === undefined || isYamlHorizontalSpace(next)) return true;
			const compactKey = line.slice(0, i);
			if (
				/^[A-Za-z_][A-Za-z0-9_-]*$/.test(compactKey) &&
				!COMPACT_URI_SCHEME_RE.test(compactKey)
			) {
				return true;
			}
		}
	}
	return false;
}

export type NociteValueMode = 'single-line' | 'flow-multiline' | 'block-scalar';

export interface NociteContinuationState {
	mode: NociteValueMode;
	rootFlow: boolean;
	flowClosers: Array<']' | '}'>;
	quote?: '"' | "'";
	escaped: boolean;
	rootFlowClosed: boolean;
	/** Exclusive offset of a matching or recovery root closer on the last line read. */
	rootFlowCloseOffset?: number;
}

function advanceNociteFlowState(state: NociteContinuationState, line: string): void {
	state.rootFlowCloseOffset = undefined;
	const lineFirstNonWhitespace = yamlLineFirstNonWhitespaceBefore(line, 0, line.length);
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (state.quote === '"') {
			if (state.escaped) state.escaped = false;
			else if (char === '\\') state.escaped = true;
			else if (char === state.quote) state.quote = undefined;
			continue;
		}
		if (state.quote === "'") {
			if (char === state.quote && line[i + 1] === state.quote) i++;
			else if (char === state.quote) state.quote = undefined;
			continue;
		}
		if (char === '#' && (i === 0 || isYamlHorizontalSpace(line[i - 1]))) break;
		if (
			(char === '"' || char === "'")
			&& canStartYamlQuotedScalar(
				line,
				i,
				0,
				state.flowClosers.length,
				lineFirstNonWhitespace[i],
			)
		) {
			state.quote = char;
		} else if (char === '[') {
			state.flowClosers.push(']');
		} else if (char === '{') {
			state.flowClosers.push('}');
		} else if (char === state.flowClosers[state.flowClosers.length - 1]) {
			state.flowClosers.pop();
			if (state.rootFlow && state.flowClosers.length === 0) {
				state.rootFlowClosed = true;
				state.rootFlowCloseOffset = i + 1;
				break;
			}
		} else if (
			state.rootFlow
			&& (char === ']' || char === '}')
			&& (
				state.flowClosers.length === 1
				|| char === state.flowClosers[0]
			)
		) {
			// A root closer is a safe recovery boundary even when malformed nested
			// collections left stale frames above it. Likewise, a mismatched closer
			// at root depth must not let nocite consume later root fields.
			state.flowClosers.length = 0;
			state.rootFlowClosed = true;
			state.rootFlowCloseOffset = i + 1;
			break;
		}
	}
}

/** Create the state shared by all physical-line consumers of one nocite value. */
export function createNociteContinuationState(firstValue: string): NociteContinuationState {
	const semanticFirstValue = yamlValueBeforeComment(firstValue).trim();
	const blockScalar = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(semanticFirstValue);
	const rootFlow = semanticFirstValue.startsWith('[') || semanticFirstValue.startsWith('{');
	const state: NociteContinuationState = {
		mode: blockScalar
			? 'block-scalar'
			: semanticFirstValue.length === 0 || rootFlow
				? 'flow-multiline'
				: 'single-line',
		rootFlow,
		flowClosers: [],
		escaped: false,
		rootFlowClosed: false,
	};
	if (rootFlow) {
		advanceNociteFlowState(state, firstValue);
		if (state.rootFlowClosed) state.mode = 'single-line';
	}
	return state;
}

/** Classify whether a nocite value may continue onto following YAML lines. */
export function nociteValueMode(firstValue: string): NociteValueMode {
	return createNociteContinuationState(firstValue).mode;
}

/** Apply the shared termination rule for multiline nocite YAML values. */
export function isNociteContinuationLine(
	modeOrState: NociteValueMode | NociteContinuationState,
	line: string,
): boolean {
	const mode = typeof modeOrState === 'string' ? modeOrState : modeOrState.mode;
	if (mode === 'single-line') return false;
	if (mode === 'block-scalar') return line.trim().length === 0 || /^[ \t]/.test(line);
	if (typeof modeOrState !== 'string' && modeOrState.rootFlow) {
		if (modeOrState.rootFlowClosed) return false;
		if (isTopLevelFrontmatterMappingLine(line)) return false;
		advanceNociteFlowState(modeOrState, line);
		return true;
	}
	return !isTopLevelFrontmatterMappingLine(line);
}

export interface NociteToken {
	atStart: number;
	end: number;
	key?: string;
	wildcard: boolean;
}

export interface DecodedNociteYamlText {
	text: string;
	/** Source start/end offsets for each UTF-16 code unit in `text`. */
	sourceStarts: readonly number[];
	sourceEnds: readonly number[];
}

/**
 * Decode only YAML quoting syntax that changes literal citation lexing.
 *
 * TextMate operates on source text, so character-producing escapes such as
 * `\\u0040` deliberately remain raw instead of synthesizing an invisible `@` or
 * citekey character. Backslash pairs and escaped quote delimiters are decoded so
 * scanner escaping, quoted-local emails, and source highlighting stay aligned.
 */
export function decodeNociteYamlText(text: string): DecodedNociteYamlText {
	let decoded = '';
	const sourceStarts: number[] = [];
	const sourceEnds: number[] = [];
	const append = (value: string, start: number, end: number) => {
		decoded += value;
		for (let i = 0; i < value.length; i++) {
			sourceStarts.push(start);
			sourceEnds.push(end);
		}
	};

	let flowDepth = 0;
	const lineFirstNonWhitespace = yamlLineFirstNonWhitespaceBefore(text, 0, text.length);
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (
			char === '#'
			&& (i === 0 || isYamlHorizontalSpace(text[i - 1]))
		) {
			const newline = text.indexOf('\n', i + 1);
			if (newline === -1) break;
			append('\n', newline, newline + 1);
			i = newline;
			continue;
		}
		if (
			(char !== '"' && char !== "'")
			|| !canStartYamlQuotedScalar(text, i, 0, flowDepth, lineFirstNonWhitespace[i])
		) {
			append(char, i, i + 1);
			if (char === '[' || char === '{') flowDepth++;
			else if ((char === ']' || char === '}') && flowDepth > 0) flowDepth--;
			continue;
		}
		if (char === "'") {
			append(char, i, i + 1);
			let contentEnd = text.length - 1;
			for (let cursor = i + 1; cursor < text.length; cursor++) {
				append(text[cursor], cursor, cursor + 1);
				if (text[cursor] !== "'") continue;
				if (text[cursor + 1] === "'") {
					cursor++;
					append("'", cursor, cursor + 1);
					continue;
				}
				contentEnd = cursor;
				break;
			}
			i = contentEnd;
			continue;
		}

		const contentStart = i + 1;
		let contentEnd = text.length;
		for (let cursor = contentStart; cursor < text.length; cursor++) {
			if (text[cursor] === '\\') cursor++;
			else if (text[cursor] === '"') {
				contentEnd = cursor;
				break;
			}
		}
		// Keep malformed quoted-local emails intact, but otherwise retain scalar
		// boundaries as spaces so adjacent text cannot extend a decoded citekey.
		const preserveDelimiters = text[contentEnd + 1] === '@';
		append(preserveDelimiters ? '"' : ' ', i, i + 1);

		for (let cursor = contentStart; cursor < contentEnd; cursor++) {
			if (text[cursor] !== '\\') {
				append(text[cursor], cursor, cursor + 1);
				continue;
			}

			const runStart = cursor;
			while (cursor < contentEnd && text[cursor] === '\\') cursor++;
			const runLength = cursor - runStart;
			const pairEnd = runStart + runLength - (runLength % 2);
			if (runLength % 2 === 0) {
				for (let pairStart = runStart; pairStart < pairEnd; pairStart += 2) {
					append('\\', pairStart, pairStart + 2);
				}
				cursor--;
				continue;
			}
			if (cursor < contentEnd && text[cursor] === '"') {
				for (let pairStart = runStart; pairStart < pairEnd; pairStart += 2) {
					append('\\', pairStart, pairStart + 2);
				}
				append('"', pairEnd, cursor + 1);
				continue;
			}

			// Preserve unsupported and malformed escape runs atomically. This keeps
			// the source backslash parity used by the grammar instead of partially
			// decoding a run and accidentally activating the following marker.
			for (let raw = runStart; raw < cursor; raw++) {
				append('\\', raw, raw + 1);
			}
			cursor--;
		}
		if (contentEnd < text.length) {
			append(preserveDelimiters ? '"' : ' ', contentEnd, contentEnd + 1);
		}
		i = contentEnd;
	}
	return { text: decoded, sourceStarts, sourceEnds };
}

/** Shared lexical boundary check for a nocite `@` marker. */
export function isBoundaryValidNociteToken(text: string, atOffset: number, regionStart = 0): boolean {
	if (text[atOffset] !== '@' || isEscaped(text, atOffset) || isEmailSeparatorAt(text, atOffset)) return false;
	const previous = atOffset > regionStart ? previousCodePoint(text, atOffset) : undefined;
	if (previous === undefined || previous.start < regionStart) return true;
	if (previous.value !== '-') return !NOCITE_LEFT_EXCLUSION_RE.test(previous.value);

	// Pandoc accepts suppress-author `-@key` in nocite clusters, but the hyphen
	// must itself begin a token rather than being attached to prose or a path.
	let boundaryStart = previous.start;
	while (boundaryStart > regionStart && text[boundaryStart - 1] === '\\') {
		boundaryStart--;
	}
	const beforeHyphen = previousCodePoint(text, boundaryStart);
	return beforeHyphen === undefined
		|| beforeHyphen.start < regionStart
		|| !NOCITE_LEFT_EXCLUSION_RE.test(beforeHyphen.value);
}

/**
 * Scan Pandoc nocite tokens with the same escaping and attachment boundaries as
 * body citations. The caller decides which YAML ranges are semantically nocite.
 */
export function scanNociteTokens(
	text: string,
	start = 0,
	end = text.length,
): NociteToken[] {
	const tokens: NociteToken[] = [];
	for (let cursor = start; cursor < end; cursor++) {
		if (!isBoundaryValidNociteToken(text, cursor, start)) continue;

		if (text[cursor + 1] === '*') {
			if (text[cursor + 2] === '*' || isCitekeyChar(text[cursor + 2])) continue;
			tokens.push({ atStart: cursor, end: cursor + 2, wildcard: true });
			cursor++;
			continue;
		}

		const parsed = readCitekey(text, cursor + 1);
		if (!parsed || parsed.end > end) continue;
		tokens.push({
			atStart: cursor,
			end: parsed.end,
			key: parsed.key,
			wildcard: false,
		});
		cursor = parsed.end - 1;
	}
	return tokens;
}

/** Extract semantic citation tokens from a preserved nocite YAML payload. */
export function parseNociteRaw(raw: string): Pick<NociteValue, 'keys' | 'wildcard'> {
	const keys: string[] = [];
	let wildcard = false;
	const lines = raw.split('\n');
	const firstValue = yamlValueBeforeComment(lines[0] ?? '').trim();
	const blockScalar = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(firstValue);
	const scanText = blockScalar
		? lines.slice(1).join('\n')
		: decodeNociteYamlText(lines.join('\n')).text;

	for (const token of scanNociteTokens(scanText)) {
		if (token.wildcard) wildcard = true;
		else if (token.key !== undefined) keys.push(token.key);
	}
	return { keys, wildcard };
}
