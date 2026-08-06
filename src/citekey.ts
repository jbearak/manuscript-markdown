/** Shared citation-key lexical primitives. Keep this alphabet in sync with TextMate rules. */
export const CITEKEY_CHARACTER_CLASS = 'A-Za-z0-9_:-';
export const CITEKEY_PATTERN_SOURCE = '[' + CITEKEY_CHARACTER_CLASS + ']+';

const CITEKEY_CHAR_RE = /^[A-Za-z0-9_:-]$/;
const CITEKEY_RE = new RegExp('^' + CITEKEY_PATTERN_SOURCE + '$');
const EMAIL_LOCAL_ATOM_RE = /^[\p{L}\p{M}\p{N}.!#$%&'*+\/=?^_`{|}~-]$/u;
const EMAIL_DOMAIN_START_RE = /^[\p{L}\p{N}]$/u;
const EMAIL_DOMAIN_CHAR_RE = /^[\p{L}\p{M}\p{N}.-]$/u;

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

/** Read a citekey from Markdown, excluding an adjacent Critic deletion closer. */
export function readMarkdownCitekey(
	text: string,
	start: number,
): { key: string; end: number } | undefined {
	const parsed = readCitekey(text, start);
	if (!parsed) return undefined;
	const end = parsed.key.endsWith('--') && text[parsed.end] === '}'
		? parsed.end - 2
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

export interface BracketCitationItem {
	key: string;
	atStart: number;
	keyEnd: number;
	suppressAuthor: boolean;
	locator?: string;
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
				const remainder = text.slice(parsed.end, right).trim();
				if (!remainder || remainder.startsWith(',')) {
					items.push({
						key: parsed.key,
						atStart,
						keyEnd: parsed.end,
						suppressAuthor,
						...(remainder.startsWith(',')
							? { locator: remainder.slice(1).trim() }
							: {}),
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

export function yamlValueBeforeComment(value: string): string {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote === '"') {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (quote === "'") {
			if (char === quote) {
				if (value[i + 1] === quote) i++;
				else quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
	}
	return value;
}

export function isTopLevelFrontmatterMappingLine(line: string): boolean {
	return /^[^\s#-][^:]*:/.test(line);
}

export interface NociteToken {
	atStart: number;
	end: number;
	key?: string;
	wildcard: boolean;
}

/** Shared lexical boundary check for a nocite `@` marker. */
export function isBoundaryValidNociteToken(text: string, atOffset: number, regionStart = 0): boolean {
	if (text[atOffset] !== '@' || isEscaped(text, atOffset) || isEmailSeparatorAt(text, atOffset)) return false;
	const previous = atOffset > regionStart ? previousCodePoint(text, atOffset) : undefined;
	return previous === undefined
		|| previous.start < regionStart
		|| !/[\p{L}\p{M}\p{N}._\/+\x3d`]/u.test(previous.value);
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
			if (isCitekeyChar(text[cursor + 2])) continue;
			tokens.push({ atStart: cursor, end: cursor + 2, wildcard: true });
			cursor++;
			continue;
		}

		const parsed = readMarkdownCitekey(text, cursor + 1);
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
	const blockScalar = /^[|>][0-9+-]*$/.test(firstValue);
	const scanText = blockScalar
		? lines.slice(1).join('\n')
		: lines.map(yamlValueBeforeComment).join('\n');

	for (const token of scanNociteTokens(scanText)) {
		if (token.wildcard) wildcard = true;
		else if (token.key !== undefined) keys.push(token.key);
	}
	return { keys, wildcard };
}
