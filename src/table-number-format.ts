import { GRID_TABLE_PLACEHOLDER_PREFIX, type GridTableData } from './grid-table-preprocess';
import type { HtmlTableCellSource } from './html-table-parser';
import { computeCodeRegions } from './code-regions';
import { decodeNumericHtmlEntity } from './html-entities';
import { isGfmDisallowedRawHtml } from './gfm';
import {
  MAX_TABLE_DIGITS,
  parseHtmlTableCellSourceKind,
  parseTableDigits,
  parseTableDecimalMark,
  parseTableDigitGrouping,
  type TableDigits,
  type TableDecimalMark,
  type TableDigitGrouping,
  type TableNumberFormat,
} from './table-metadata';

export {
  MAX_TABLE_DIGITS,
  parseTableDigits,
  parseTableDecimalMark,
  parseTableDigitGrouping,
  type TableDigits,
  type TableDecimalMark,
  type TableDigitGrouping,
  type TableNumberFormat,
} from './table-metadata';

export interface TableNumberFormatResult {
  output: string;
  warnings: string[];
  warningDetails: TableNumberFormatWarning[];
}

export interface TableNumberFormatWarning {
  message: string;
  start: number;
  end: number;
}

const DIRECTIVE_RE = /^\s*<!--\s*table-(digits|decimal-mark|digit-grouping):\s*(.+?)\s*-->\s*$/i;
const NUMERIC_TOKEN_RE = /[+-]?(?:\d{1,3}(?:[ ,.\u00a0\u202f]\d{3})+(?!\d)|\d+)(?:[.,\u00b7]\d+)?(?:[eE][+-]?\d+)?(?:[ \u00a0\u202f]?%)?/g;
const ALLOWED_REMAINDER_RE = /^[\s()[\]{}$\u00a3\u20ac\u00a5+\-\u2013\u2014\u00b1,;:/]*$/;
const CURRENCY_CODE_RE = /\b(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|CNY|RMB|INR|KRW|RUB|BRL|MXN|ZAR|SEK|NOK|DKK|PLN|CZK|HUF|TRY|ILS|AED|SAR|SGD|HKD|TWD|THB)\b/;

export function validateTableNumberFormat(format: TableNumberFormat): string | undefined {
  if (typeof format.digits === 'number' && (!Number.isInteger(format.digits) || format.digits < 0 || format.digits > MAX_TABLE_DIGITS)) {
    return 'table-digits must be an integer from 0 to ' + MAX_TABLE_DIGITS;
  }
  if (format.decimalMark === 'point' && format.digitGrouping === 'period') {
    return 'table-decimal-mark point cannot be combined with table-digit-grouping period';
  }
  if (format.decimalMark === 'comma' && format.digitGrouping === 'comma') {
    return 'table-decimal-mark comma cannot be combined with table-digit-grouping comma';
  }
  return undefined;
}

interface ParsedTableNumberDirective {
  format?: Partial<TableNumberFormat>;
  error?: string;
}

function parseDirective(line: string): ParsedTableNumberDirective | undefined {
  const match = line.match(DIRECTIVE_RE);
  if (!match) return undefined;
  const key = match[1].toLowerCase();
  const raw = match[2];
  const value = key === 'digits' ? parseTableDigits(raw)
    : key === 'decimal-mark' ? parseTableDecimalMark(raw)
    : parseTableDigitGrouping(raw);
  if (value === undefined) return { error: 'Invalid ' + line.trim() + ' directive ignored.' };
  if (key === 'digits') return { format: { digits: value as TableDigits } };
  if (key === 'decimal-mark') return { format: { decimalMark: value as TableDecimalMark } };
  return { format: { digitGrouping: value as TableDigitGrouping } };
}

function mergeFormat(documentFormat: TableNumberFormat, tableFormat: Partial<TableNumberFormat>): TableNumberFormat {
  return {
    digits: tableFormat.digits ?? documentFormat.digits,
    decimalMark: tableFormat.decimalMark ?? documentFormat.decimalMark,
    digitGrouping: tableFormat.digitGrouping ?? documentFormat.digitGrouping,
  };
}

function decimalCharacter(mark: TableDecimalMark | undefined): string | undefined {
  if (mark === 'point') return '.';
  if (mark === 'comma') return ',';
  if (mark === 'midpoint') return '\u00b7';
  return undefined;
}

function groupingCharacter(grouping: TableDigitGrouping | undefined): string | undefined {
  if (grouping === 'comma') return ',';
  if (grouping === 'period') return '.';
  if (grouping === 'space') return '\u00a0';
  if (grouping === 'thin-space') return '\u202f';
  if (grouping === 'none') return '';
  return undefined;
}

interface NumericParts {
  sign: string;
  integer: string;
  fraction: string;
  exponent: string;
  percent: string;
  decimal: string;
  grouping: string;
}

function parseNumericToken(token: string): NumericParts | undefined {
  const match = token.match(/^([+-]?)(.*?)([eE][+-]?\d+)?([ \u00a0\u202f]?%)?$/);
  if (!match) return undefined;
  const sign = match[1];
  const mantissa = match[2];
  const exponent = match[3] ?? '';
  const percent = match[4] ?? '';
  const separators = [...mantissa.matchAll(/[.,\u00b7 \u00a0\u202f]/g)];
  let decimal = '';
  let grouping = '';
  if (separators.length > 0) {
    const last = separators[separators.length - 1];
    const after = mantissa.length - (last.index ?? 0) - 1;
    const distinct = new Set(separators.map(s => s[0]));
    if (last[0] === '\u00b7' || after !== 3 || distinct.size > 1) decimal = last[0];
    else if (separators.length > 1) grouping = last[0];
    else return undefined; // A single separator followed by three digits is ambiguous.
    for (const separator of separators) {
      if (separator[0] !== decimal) grouping = separator[0];
    }
  }
  const decimalIndex = decimal ? mantissa.lastIndexOf(decimal) : -1;
  const integerRaw = decimalIndex >= 0 ? mantissa.slice(0, decimalIndex) : mantissa;
  const fraction = decimalIndex >= 0 ? mantissa.slice(decimalIndex + 1) : '';
  const integer = integerRaw.replace(/[.,\u00b7 \u00a0\u202f]/g, '');
  if (!/^\d+$/.test(integer) || (fraction && !/^\d+$/.test(fraction))) return undefined;
  return { sign, integer, fraction, exponent, percent, decimal, grouping };
}

function roundDecimal(integer: string, fraction: string, digits: number): { integer: string; fraction: string } {
  if (fraction.length <= digits) return { integer, fraction: fraction.padEnd(digits, '0') };
  const kept = fraction.slice(0, digits);
  if (fraction.charCodeAt(digits) < 53) return { integer, fraction: kept };
  const combined = BigInt(integer + kept) + 1n;
  const padded = combined.toString().padStart(integer.length + digits, '0');
  if (digits === 0) return { integer: padded, fraction: '' };
  return { integer: padded.slice(0, -digits), fraction: padded.slice(-digits) };
}

function numberToDecimalParts(value: number): { integer: string; fraction: string } {
  const source = Math.abs(value).toString().toLowerCase();
  if (!source.includes('e')) {
    const [integer, fraction = ''] = source.split('.');
    return { integer, fraction };
  }
  const [mantissa, exponentRaw] = source.split('e');
  const exponent = Number(exponentRaw);
  const digits = mantissa.replace('.', '');
  const decimalAt = mantissa.indexOf('.') < 0 ? mantissa.length : mantissa.indexOf('.');
  const target = decimalAt + exponent;
  if (target <= 0) return { integer: '0', fraction: '0'.repeat(-target) + digits };
  if (target >= digits.length) return { integer: digits + '0'.repeat(target - digits.length), fraction: '' };
  return { integer: digits.slice(0, target), fraction: digits.slice(target) };
}

export function stripExcelFormatLiterals(sourceFormat: string): string {
	return sourceFormat.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, '').replace(/\[(?!\$)[^\]]+\]/gi, '');
}

function splitExcelFormatSections(sourceFormat: string): string[] {
	const sections: string[] = [];
	let current = '';
	let quote = false;
	let bracket = false;
	let escaped = false;
	for (const char of sourceFormat) {
		if (escaped) { current += char; escaped = false; continue; }
		if (char === '\\') { current += char; escaped = true; continue; }
		if (char === '"' && !bracket) { quote = !quote; current += char; continue; }
		if (char === '[' && !quote) bracket = true;
		if (char === ']' && !quote) bracket = false;
		if (char === ';' && !quote && !bracket) { sections.push(current); current = ''; continue; }
		current += char;
	}
	sections.push(current);
	return sections;
}

export function selectExcelFormatSection(sourceFormat: string, value: number): string {
	const sections = splitExcelFormatSections(sourceFormat);
	const conditional = sections.map(section => ({
		section,
		match: section.match(/\[(<=|>=|<>|=|<|>)(-?(?:\d+(?:\.\d*)?|\.\d+))\]/),
	}));
	if (conditional.some(item => item.match)) {
		for (const item of conditional) {
			if (!item.match) continue;
			const threshold = Number(item.match[2]);
			const matches = item.match[1] === '<' ? value < threshold
				: item.match[1] === '<=' ? value <= threshold
					: item.match[1] === '>' ? value > threshold
						: item.match[1] === '>=' ? value >= threshold
							: item.match[1] === '<>' ? value !== threshold : value === threshold;
			if (matches) return item.section;
		}
		return conditional.find(item => !item.match)?.section ?? sections[0] ?? '';
	}
	if (value < 0 && sections.length >= 2) return sections[1];
	if (value === 0 && sections.length >= 3) return sections[2];
	return sections[0] ?? '';
}

function hasExcelNegativeSection(sourceFormat: string): boolean {
	return splitExcelFormatSections(sourceFormat).length >= 2;
}

export function isCurrencySourceFormat(sourceFormat: string, value = 1): boolean {
	const active = selectExcelFormatSection(sourceFormat, value);
	const semantic = stripExcelFormatLiterals(active);
	return /\[\$[^\]]+\]/.test(active) || /\p{Sc}/u.test(semantic) || CURRENCY_CODE_RE.test(active);
}

function currencyAffixFromFormat(sourceFormat: string, value = 1): string {
	const primary = selectExcelFormatSection(sourceFormat, value);
	const locale = primary.match(/\[\$([^-\]]+)(?:-[^\]]+)?\]/)?.[1];
	if (locale) return locale;
	const withoutControls = primary.replace(/\[(?!\$)[^\]]+\]/gi, '');
	const quoted = withoutControls.match(/"([A-Z]{3})"/)?.[1];
	if (quoted && CURRENCY_CODE_RE.test(quoted)) return quoted;
	const code = withoutControls.match(CURRENCY_CODE_RE)?.[0];
	if (code) return code;
	return withoutControls.match(/\p{Sc}/u)?.[0] ?? '';
}

function excelSourceScale(sourceFormat: string, value: number): number {
	const primary = stripExcelFormatLiterals(selectExcelFormatSection(sourceFormat, value));
	const commas = primary.match(/,+(?=[^0#?]*$)/)?.[0].length ?? 0;
	return 1000 ** commas;
}

function groupInteger(integer: string, separator: string): string {
  if (!separator) return integer;
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function hasSeparatorCollision(parts: NumericParts, format: TableNumberFormat): boolean {
  let integer = parts.integer;
  let fraction = parts.fraction;
  if (typeof format.digits === 'number') {
    const rounded = roundDecimal(integer, fraction, format.digits);
    integer = rounded.integer;
    fraction = rounded.fraction;
  }
  const resolvedGrouping = groupingCharacter(format.digitGrouping) ?? parts.grouping;
  const resolvedDecimal = (decimalCharacter(format.decimalMark) ?? parts.decimal)
    || (fraction && typeof format.digits === 'number' ? '.' : '');
  return integer.length > 3 && fraction.length > 0
    && !!resolvedGrouping && !!resolvedDecimal && resolvedGrouping === resolvedDecimal;
}

function formatParsed(parts: NumericParts, format: TableNumberFormat, warnings?: string[], original?: string): string {
  if (original !== undefined && hasSeparatorCollision(parts, format)) {
    warnings?.push('Conflicting decimal and grouping separators left unchanged: ' + original);
    return original;
  }
  let integer = parts.integer;
  let fraction = parts.fraction;
  if (typeof format.digits === 'number') {
    const rounded = roundDecimal(integer, fraction, format.digits);
    integer = rounded.integer;
    fraction = rounded.fraction;
  }
  const group = groupingCharacter(format.digitGrouping);
  if (group !== undefined) integer = groupInteger(integer, group);
  else if (parts.grouping) integer = groupInteger(integer, parts.grouping);
  const decimal = (decimalCharacter(format.decimalMark) ?? parts.decimal)
    || (fraction && typeof format.digits === 'number' ? '.' : '');
  return parts.sign + integer + (fraction ? decimal + fraction : '') + parts.exponent + parts.percent;
}

function formatTextCell(text: string, format: TableNumberFormat, warnings: string[]): string {
  if (format.digits === undefined && format.decimalMark === undefined && format.digitGrouping === undefined) return text;
  const wrapper = text.match(/^(\*\*|__|\*|_|~~)([\s\S]+)\1$/);
  if (wrapper) return wrapper[1] + formatTextCell(wrapper[2], format, warnings) + wrapper[1];
  const tokens = [...text.matchAll(NUMERIC_TOKEN_RE)];
  if (tokens.length === 0) return text;
	if (/^\s*\d+(?:\s*,\s*\d+){2,}\s*$/.test(text)) {
		warnings.push('Ambiguous numeric table cell left unchanged: ' + text.trim());
		return text;
	}
  if (/^\s*\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\s*$/.test(text)) return text;
  if (/^\s*\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AP]M)?\s*$/i.test(text)) return text;
  const remainder = text.replace(NUMERIC_TOKEN_RE, '');
  if (!ALLOWED_REMAINDER_RE.test(remainder)) return text;
  let output = '';
  let cursor = 0;
  for (const match of tokens) {
    const index = match.index ?? 0;
    output += text.slice(cursor, index);
    const parsed = parseNumericToken(match[0]);
    if (!parsed) {
      warnings.push('Ambiguous numeric table cell left unchanged: ' + text.trim());
      return text;
    }
    if (parsed.integer.length > 1 && parsed.integer.startsWith('0')) return text;
    output += formatParsed(parsed, format, warnings, match[0]);
    cursor = index + match[0].length;
  }
  return output + text.slice(cursor);
}

function formatTypedCell(sourceMeta: HtmlTableCellSource | undefined, display: string, format: TableNumberFormat, warnings: string[]): string {
  const raw = sourceMeta?.rawValue;
  const kind = sourceMeta?.kind;
  if (kind && !['number', 'percent', 'scientific', 'currency'].includes(kind)) return display;
  if (raw === undefined || !kind) return formatTextCell(display, format, warnings);
  const rawNumber = raw;
  if (!Number.isFinite(rawNumber)) return display;
  const plainDisplay = display;
	const tokenMatch = plainDisplay.match(NUMERIC_TOKEN_RE);
	const allTokens = plainDisplay.match(NUMERIC_TOKEN_RE) ?? [];
	if (allTokens.length === 0 && rawNumber === 0 && typeof format.digits === 'number') {
		const placeholder = plainDisplay.match(/^\s*(?:(?:\p{Sc}|[A-Z]{3})\s*)?[-\u2013\u2014](?:\s*(?:\p{Sc}|[A-Z]{3}))?(?:\s*%)?\s*$/u);
		if (placeholder) {
			const rounded = roundDecimal('0', '', format.digits);
			const zeroParts: NumericParts = { sign: '', integer: rounded.integer, fraction: rounded.fraction,
				exponent: '', percent: '', decimal: '.', grouping: '' };
			if (hasSeparatorCollision(zeroParts, format)) {
				warnings.push('Conflicting decimal and grouping separators left unchanged: ' + plainDisplay);
				return display;
			}
			const sourceFormat = sourceMeta?.sourceFormat ?? '';
			const displayCurrency = plainDisplay.match(/\p{Sc}|[A-Z]{3}/u)?.[0];
			const formatCurrency = currencyAffixFromFormat(sourceFormat, rawNumber) || currencyAffixFromFormat(sourceFormat, 1);
			const currency = kind === 'currency' ? displayCurrency ?? formatCurrency ?? '' : '';
			const displayCurrencyIndex = displayCurrency ? plainDisplay.indexOf(displayCurrency) : -1;
			const formatCurrencyIndex = formatCurrency ? sourceFormat.indexOf(formatCurrency) : -1;
			const formatNumberIndex = sourceFormat.search(/[0#?]/);
			const currencyIsSuffix = displayCurrencyIndex > plainDisplay.search(/[-\u2013\u2014]/)
				|| (displayCurrencyIndex < 0 && formatCurrencyIndex > formatNumberIndex && formatNumberIndex >= 0);
			const dashIndex = plainDisplay.search(/[-\u2013\u2014]/);
			const displaySpacing = displayCurrency && displayCurrencyIndex >= 0
				? plainDisplay.slice(Math.min(displayCurrencyIndex + displayCurrency.length, dashIndex + 1), Math.max(displayCurrencyIndex, dashIndex)) : undefined;
			const displayPrefixSpacing = displayCurrencyIndex >= 0 && displayCurrencyIndex < dashIndex ? displaySpacing : undefined;
			const displaySuffixSpacing = displayCurrencyIndex > dashIndex ? displaySpacing : undefined;
			const primaryFormat = sourceFormat.split(';')[0] ?? '';
			const formatAffixIndex = formatCurrency ? primaryFormat.indexOf(formatCurrency) : -1;
			const formatPrefixSpacing = formatAffixIndex >= 0 && formatAffixIndex < formatNumberIndex
				? primaryFormat.slice(formatAffixIndex + formatCurrency.length, formatNumberIndex).replace(/[^ \u00a0\u202f]/g, '') : undefined;
			const formatSuffixSpacing = formatAffixIndex > formatNumberIndex
				? primaryFormat.slice(formatNumberIndex + 1, formatAffixIndex).replace(/[^ \u00a0\u202f]/g, '') : undefined;
			const percent = kind === 'percent' ? (plainDisplay.match(/[ \u00a0\u202f]?%/)?.[0] ?? '%') : '';
			const exponent = kind === 'scientific' ? 'E+0' : '';
			const number = formatParsed({ sign: '', integer: rounded.integer, fraction: rounded.fraction,
				exponent, percent, decimal: '.', grouping: '' }, { ...format, digits: 'source' }, warnings);
			const currencySpacing = currencyIsSuffix
				? displaySuffixSpacing ?? formatSuffixSpacing ?? ''
				: displayPrefixSpacing ?? formatPrefixSpacing ?? '';
			return currencyIsSuffix && currency ? number + currencySpacing + currency : currency + currencySpacing + number;
		}
	}
	if (allTokens.length !== 1) {
		const fraction = plainDisplay.match(/[+-]?(?:\d+\s+)?\d+\/\d+/);
		const fractionRemainder = fraction ? plainDisplay.slice(0, fraction.index) + plainDisplay.slice((fraction.index ?? 0) + fraction[0].length) : '';
		const displayedCurrency = kind === 'currency' ? plainDisplay.match(/\p{Sc}/u)?.[0] ?? plainDisplay.match(CURRENCY_CODE_RE)?.[0]
			?? currencyAffixFromFormat(sourceMeta?.sourceFormat ?? '', rawNumber) : undefined;
		const activeSourceFormat = selectExcelFormatSection(sourceMeta?.sourceFormat ?? '', rawNumber);
		const sourceLiterals = [...activeSourceFormat.matchAll(/"([^"]*)"/g)].map(match => match[1]).filter(Boolean);
		for (const escaped of activeSourceFormat.matchAll(/\\(.)/g)) sourceLiterals.push(escaped[1]);
		let normalizedFractionRemainder = displayedCurrency ? fractionRemainder.replace(displayedCurrency, '') : fractionRemainder;
		for (const literal of sourceLiterals) normalizedFractionRemainder = normalizedFractionRemainder.replace(literal, '');
		const allowedFractionRemainder = ALLOWED_REMAINDER_RE.test(normalizedFractionRemainder.replace(/[ \u00a0\u202f]?%/, ''));
		if (typeof format.digits === 'number' && fraction && allowedFractionRemainder) {
			let scaledRaw = kind === 'percent' ? rawNumber * 100 : rawNumber;
			scaledRaw /= excelSourceScale(sourceMeta?.sourceFormat ?? '', rawNumber);
			const parts = numberToDecimalParts(scaledRaw);
			const rounded = roundDecimal(parts.integer, parts.fraction, format.digits);
			const sourceEncodesNegative = /^\s*\(/.test(plainDisplay) || /-\s*$/.test(plainDisplay)
				|| (scaledRaw < 0 && hasExcelNegativeSection(sourceMeta?.sourceFormat ?? ''));
			const displayedSign = fraction[0].startsWith('-') ? '-' : fraction[0].startsWith('+') ? '+' : '';
			const replacement = formatParsed({ sign: displayedSign || (scaledRaw < 0 && !sourceEncodesNegative ? '-' : ''), integer: rounded.integer,
				fraction: rounded.fraction, exponent: '', percent: '', decimal: '.', grouping: '' }, { ...format, digits: 'source' }, warnings, fraction[0]);
			const start = fraction.index ?? 0;
			return plainDisplay.slice(0, start) + replacement + plainDisplay.slice(start + fraction[0].length);
		}
		return display;
	}
  let source = tokenMatch ? parseNumericToken(tokenMatch[0]) : undefined;
  if (!source && tokenMatch) {
    const sourceFormat = sourceMeta?.sourceFormat ?? '';
    const token = tokenMatch[0];
    const ambiguous = token.match(/^([+-]?)(\d+)([.,])(\d{3})(%)?$/);
    if (ambiguous) {
      const decimalCandidate = Number(ambiguous[2] + '.' + ambiguous[4]);
      const groupingCandidate = Number(ambiguous[2] + ambiguous[4]);
      const scaledRaw = Math.abs(kind === 'percent' ? rawNumber * 100 : rawNumber);
      const groupingDistance = Math.abs(groupingCandidate - scaledRaw);
      const decimalDistance = Math.abs(decimalCandidate - scaledRaw);
      const separatorIsGrouping = groupingDistance < decimalDistance
        || (groupingDistance === decimalDistance && ambiguous[3] === ',' && (sourceFormat.includes(',') || /fc/i.test(sourceFormat)));
      source = separatorIsGrouping
        ? { sign: ambiguous[1], integer: ambiguous[2] + ambiguous[4], fraction: '', exponent: '', percent: ambiguous[5] ?? '', decimal: '', grouping: ambiguous[3] }
        : { sign: ambiguous[1], integer: ambiguous[2], fraction: ambiguous[4], exponent: '', percent: ambiguous[5] ?? '', decimal: ambiguous[3], grouping: '' };
    }
  }
  if (!source) return display;
  if (typeof format.digits !== 'number') return plainDisplay.replace(tokenMatch![0], formatParsed(source, format, warnings, tokenMatch![0]));
  let scaled = rawNumber;
  if (kind === 'percent') scaled *= 100;
	scaled /= excelSourceScale(sourceMeta?.sourceFormat ?? '', rawNumber);
  const sourceEncodesNegative = /^\s*\(/.test(plainDisplay) || /-\s*$/.test(plainDisplay);
	const explicitNegativeSection = rawNumber < 0 && hasExcelNegativeSection(sourceMeta?.sourceFormat ?? '');
	const replacementSign = source.sign || (scaled < 0 && !sourceEncodesNegative && !explicitNegativeSection ? '-' : '');
  let replacement: string;
	if (kind === 'scientific' || source.exponent) {
    const exp = Math.abs(scaled).toExponential();
    const expMatch = exp.match(/^(\d+)(?:\.(\d+))?e([+-]?\d+)$/);
    if (!expMatch) return display;
    let rounded = roundDecimal(expMatch[1], expMatch[2] ?? '', format.digits);
    let exponent = Number(expMatch[3]);
    if (rounded.integer.length > 1) {
      const normalized = rounded.integer + rounded.fraction;
      exponent += rounded.integer.length - 1;
      rounded = { integer: normalized[0], fraction: normalized.slice(1).padEnd(format.digits, '0').slice(0, format.digits) };
    }
		replacement = formatParsed({ sign: replacementSign, integer: rounded.integer, fraction: rounded.fraction,
			exponent: 'E' + (exponent >= 0 ? '+' : '') + exponent, percent: source.percent, decimal: source.decimal || '.', grouping: source.grouping }, { ...format, digits: 'source' }, warnings, tokenMatch![0]);
  } else {
    const sourceParts = numberToDecimalParts(scaled);
    const rounded = roundDecimal(sourceParts.integer, sourceParts.fraction, format.digits);
		replacement = formatParsed({ sign: replacementSign, integer: rounded.integer, fraction: rounded.fraction, exponent: '', percent: source.percent, decimal: source.decimal || '.', grouping: source.grouping }, { ...format, digits: 'source' }, warnings, tokenMatch![0]);
  }
  return plainDisplay.replace(tokenMatch![0], replacement);
}

export interface TableNumberFormatScanStats {
	structuralScans: number;
	structuralCharacters: number;
	structuralTokens: number;
	completedTables: number;
	tableRangeVisits: number;
	decodedPiecesMapped: number;
	decodedRawCharactersMapped: number;
	tableFormatVisits: number;
	visibleTokenVisits: number;
	visiblePieceSearches: number;
	visiblePieceVisits: number;
	sourceEditPasses: number;
	sourceEditsApplied: number;
	sourceCharactersCopied: number;
}

interface SourceRange {
	start: number;
	end: number;
}

interface HtmlSourceToken {
	raw: string;
	tag: boolean;
	name?: string;
	closing?: boolean;
	selfClosing?: boolean;
	start: number;
	end: number;
}

interface HtmlElementRange extends SourceRange {
	contentStart: number;
	contentEnd: number;
	openTokenIndex: number;
	closeTokenIndex: number;
}

interface IndexedHtmlTable extends HtmlElementRange {
	parent?: IndexedHtmlTable;
	children: IndexedHtmlTable[];
	cells: HtmlElementRange[];
}

interface HtmlStructuralIndex {
	tokens: HtmlSourceToken[];
	tables: IndexedHtmlTable[];
	tableByOpenToken: Map<number, IndexedHtmlTable>;
	stats?: TableNumberFormatScanStats;
	inertRegions: SourceRange[];
	openTableLines: Set<number>;
	recoveryEndByStartLine: Array<number | undefined>;
	collectionEndByLine: Array<number | undefined>;
}

interface HtmlVisiblePiece {
	sourceStart: number;
	sourceEnd: number;
	decodedStart: number;
	decodedEnd: number;
	decodedToRaw: Uint32Array;
}

interface HtmlVisibleSegment {
	text: string;
	pieces: HtmlVisiblePiece[];
}

interface SourceEdit {
	start: number;
	end: number;
	insert: string;
}

function mergeSourceRanges(ranges: SourceRange[]): SourceRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: SourceRange[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function maskSourceRanges(source: string, ranges: SourceRange[]): string {
	if (ranges.length === 0) return source;
	const parts: string[] = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.end <= cursor) continue;
		const start = Math.max(cursor, range.start);
		parts.push(source.slice(cursor, start));
		parts.push(source.slice(start, range.end).replace(/[^\r\n]/g, ' '));
		cursor = range.end;
	}
	parts.push(source.slice(cursor));
	return parts.join('');
}

function isHtmlRawTextName(name: string): boolean {
	return name === 'template' || isGfmDisallowedRawHtml('<' + name + '>');
}

function scanHtmlSource(html: string, stats?: TableNumberFormatScanStats): { tokens: HtmlSourceToken[]; inertRegions: SourceRange[] } {
	if (stats) {
		stats.structuralScans++;
		stats.structuralCharacters += html.length;
	}
	const tokens: HtmlSourceToken[] = [];
	const inertRegions: SourceRange[] = [];
	const lowerHtml = html.toLowerCase();
	let cursor = 0;
	let rawTextName: string | undefined;
	let rawTextStart: number | undefined;
	let closingRawTextName: string | undefined;
	while (cursor < html.length) {
		if (rawTextName) {
			if (rawTextName === 'plaintext') {
				tokens.push({ raw: html.slice(cursor), tag: false, start: cursor, end: html.length });
				inertRegions.push({ start: rawTextStart ?? cursor, end: html.length });
				break;
			}
			let closeStart = lowerHtml.indexOf('</' + rawTextName, cursor);
			while (closeStart >= 0) {
				const boundary = lowerHtml[closeStart + rawTextName.length + 2] ?? '';
				if (!boundary || /[\s/>]/.test(boundary)) break;
				closeStart = lowerHtml.indexOf('</' + rawTextName, closeStart + rawTextName.length + 2);
			}
			if (closeStart < 0) {
				tokens.push({ raw: html.slice(cursor), tag: false, start: cursor, end: html.length });
				inertRegions.push({ start: rawTextStart ?? cursor, end: html.length });
				break;
			}
			if (closeStart > cursor) tokens.push({ raw: html.slice(cursor, closeStart), tag: false, start: cursor, end: closeStart });
			cursor = closeStart;
			closingRawTextName = rawTextName;
			rawTextName = undefined;
		}
		const tagStart = html.indexOf('<', cursor);
		if (tagStart < 0) {
			tokens.push({ raw: html.slice(cursor), tag: false, start: cursor, end: html.length });
			break;
		}
		if (tagStart > cursor) tokens.push({ raw: html.slice(cursor, tagStart), tag: false, start: cursor, end: tagStart });
		if (html.startsWith('<!--', tagStart)) {
			const commentEnd = html.indexOf('-->', tagStart + 4);
			const end = commentEnd < 0 ? html.length : commentEnd + 3;
			tokens.push({ raw: html.slice(tagStart, end), tag: true, start: tagStart, end });
			inertRegions.push({ start: tagStart, end });
			cursor = end;
			continue;
		}
		let quote = '';
		let end = tagStart + 1;
		for (; end < html.length; end++) {
			const char = html[end];
			if (quote) {
				if (char === quote) quote = '';
			} else if (char === '"' || char === "'") quote = char;
			else if (char === '>') { end++; break; }
		}
		if (end > html.length || html[end - 1] !== '>') {
			const lineEnd = html.indexOf('\n', tagStart);
			const textEnd = lineEnd < 0 ? html.length : lineEnd;
			tokens.push({ raw: html.slice(tagStart, textEnd), tag: false, start: tagStart, end: textEnd });
			cursor = textEnd;
			continue;
		}
		const raw = html.slice(tagStart, end);
		let inner = raw.slice(1, -1).trim();
		const closing = inner.startsWith('/');
		if (closing) inner = inner.slice(1).trimStart();
		let nameEnd = 0;
		while (nameEnd < inner.length && /[A-Za-z0-9:-]/.test(inner[nameEnd])) nameEnd++;
		const name = inner.slice(0, nameEnd).toLowerCase() || undefined;
		tokens.push({ raw, tag: true, name, closing, selfClosing: /\/\s*>$/.test(raw), start: tagStart, end });
		if (closing && name && name === closingRawTextName && rawTextStart !== undefined) {
			inertRegions.push({ start: rawTextStart, end });
			rawTextStart = undefined;
			closingRawTextName = undefined;
		}
		if (!closing && !/\/\s*>$/.test(raw) && name && isHtmlRawTextName(name)) {
			rawTextName = name;
			rawTextStart = tagStart;
		}
		cursor = end;
	}
	if (stats) stats.structuralTokens += tokens.length;
	return { tokens, inertRegions };
}

interface OwnedHtmlCellRange extends HtmlElementRange {
	ownerTableOpenTokenIndex?: number;
}

function buildHtmlStructuralIndex(markdown: string, codeRegions: SourceRange[], lineOffsets: number[], stats?: TableNumberFormatScanStats): HtmlStructuralIndex {
	const masked = maskSourceRanges(markdown, codeRegions);
	const scanned = scanHtmlSource(masked, stats);
	const tableStack: Array<{ token: HtmlSourceToken; index: number }> = [];
	const cellStacks = new Map<string, Array<{ token: HtmlSourceToken; index: number; ownerTableOpenTokenIndex?: number }>>();
	const tableRanges: HtmlElementRange[] = [];
	const cellRanges: OwnedHtmlCellRange[] = [];
	for (let index = 0; index < scanned.tokens.length; index++) {
		const token = scanned.tokens[index];
		if (token.selfClosing || !token.name) continue;
		if (token.name === 'table') {
			if (!token.closing) tableStack.push({ token, index });
			else {
				const open = tableStack.pop();
				if (open) tableRanges.push({ start: open.token.start, end: token.end, contentStart: open.token.end,
					contentEnd: token.start, openTokenIndex: open.index, closeTokenIndex: index });
			}
			continue;
		}
		if (token.name !== 'td' && token.name !== 'th') continue;
		const stack = cellStacks.get(token.name) ?? [];
		if (!token.closing) {
			stack.push({ token, index, ownerTableOpenTokenIndex: tableStack[tableStack.length - 1]?.index });
			cellStacks.set(token.name, stack);
		} else {
			const open = stack.pop();
			if (open) cellRanges.push({ start: open.token.start, end: token.end, contentStart: open.token.end,
				contentEnd: token.start, openTokenIndex: open.index, closeTokenIndex: index,
				ownerTableOpenTokenIndex: open.ownerTableOpenTokenIndex });
		}
	}
	tableRanges.sort((a, b) => a.start - b.start || b.end - a.end);
	const tables: IndexedHtmlTable[] = tableRanges.map(range => ({ ...range, children: [], cells: [] }));
	const tableByOpenToken = new Map<number, IndexedHtmlTable>();
	const parentStack: IndexedHtmlTable[] = [];
	for (const table of tables) {
		while (parentStack.length > 0 && table.start >= parentStack[parentStack.length - 1].end) parentStack.pop();
		const parent = parentStack[parentStack.length - 1];
		if (parent && table.end <= parent.end) {
			table.parent = parent;
			parent.children.push(table);
		}
		tableByOpenToken.set(table.openTokenIndex, table);
		parentStack.push(table);
	}
	for (const cell of cellRanges) tableByOpenToken.get(cell.ownerTableOpenTokenIndex ?? -1)?.cells.push(cell);
	const tokenLines = new Array(scanned.tokens.length).fill(0) as number[];
	let tokenLine = 0;
	for (let index = 0; index < scanned.tokens.length; index++) {
		while (tokenLine + 1 < lineOffsets.length && lineOffsets[tokenLine + 1] <= scanned.tokens[index].start) tokenLine++;
		tokenLines[index] = tokenLine;
	}
	const openTableLines = new Set<number>();
	const recoveryEndByStartLine = new Array(lineOffsets.length).fill(undefined) as Array<number | undefined>;
	const lineDelta = new Array(lineOffsets.length).fill(0) as number[];
	for (let index = 0; index < scanned.tokens.length; index++) {
		const token = scanned.tokens[index];
		if (token.name !== 'table') continue;
		const line = tokenLines[index];
		if (!token.closing) openTableLines.add(line);
		if (!token.selfClosing) lineDelta[line] += token.closing ? -1 : 1;
	}
	for (const table of tables) {
		const startLine = tokenLines[table.openTokenIndex];
		const endBoundary = tokenLines[table.closeTokenIndex] + 1;
		recoveryEndByStartLine[startLine] = Math.max(recoveryEndByStartLine[startLine] ?? 0, endBoundary);
	}
	const prefix = new Array(lineOffsets.length + 1).fill(0) as number[];
	for (let line = 0; line < lineDelta.length; line++) prefix[line + 1] = prefix[line] + lineDelta[line];
	const boundaryEnd = new Array(prefix.length).fill(undefined) as Array<number | undefined>;
	const stack: number[] = [];
	for (let boundary = 0; boundary < prefix.length; boundary++) {
		while (stack.length > 0 && prefix[boundary] <= prefix[stack[stack.length - 1]]) {
			boundaryEnd[stack.pop()!] = boundary;
		}
		stack.push(boundary);
	}
	const collectionEndByLine = lineOffsets.map((_, line) => {
		const boundary = boundaryEnd[line];
		return boundary !== undefined && boundary > line ? boundary : undefined;
	});
	if (stats) stats.completedTables += tables.length;
	return { tokens: scanned.tokens, tables, tableByOpenToken, stats, inertRegions: scanned.inertRegions,
		openTableLines, recoveryEndByStartLine, collectionEndByLine };
}

function parseHtmlTableFormat(openingTag: string): Partial<TableNumberFormat> {
	const attr = (name: string): string | undefined => {
		const match = openingTag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\\\'([^\\\']*)\\\'|([^\\s>]+))', 'i'));
		return match ? decodeHtmlText(match[1] ?? match[2] ?? match[3]) : undefined;
	};
	return {
		digits: parseTableDigits(attr('data-digits') ?? ''),
		decimalMark: parseTableDecimalMark(attr('data-decimal-mark') ?? ''),
		digitGrouping: parseTableDigitGrouping(attr('data-digit-grouping') ?? ''),
	};
}

const HTML_NUMERIC_BOUNDARIES = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'code', 'div', 'dl', 'fieldset',
	'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'iframe', 'li', 'main', 'nav',
	'noembed', 'noframes', 'ol', 'p', 'plaintext', 'pre', 'script', 'section', 'style', 'sub', 'sup', 'table',
	'template', 'textarea', 'title', 'ul', 'xmp']);
const HTML_NUMERIC_INERT = new Set(['code', 'iframe', 'noembed', 'noframes', 'plaintext', 'pre', 'script', 'style',
	'sub', 'sup', 'table', 'template', 'textarea', 'title', 'xmp']);

function firstOverlappingRange(ranges: SourceRange[], start: number): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ranges[middle].end <= start) low = middle + 1;
		else high = middle;
	}
	return low;
}

function decodeHtmlTextWithOffsets(raw: string, stats?: TableNumberFormatScanStats): { decoded: string; decodedToRaw: Uint32Array } {
	const offsets = [0];
	let decoded = '';
	const tokenRe = /&(?:#\d+|#x[0-9a-f]+|nbsp|lt|gt|quot|apos|amp);|[\s\S]/gi;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(raw)) !== null) {
		const value = decodeHtmlText(match[0]);
		decoded += value;
		for (let index = 0; index < value.length; index++) offsets.push(tokenRe.lastIndex);
	}
	if (stats) {
		stats.decodedPiecesMapped++;
		stats.decodedRawCharactersMapped += raw.length;
	}
	return { decoded, decodedToRaw: Uint32Array.from(offsets) };
}

function htmlVisibleSegments(source: string, index: HtmlStructuralIndex, ownerTable: IndexedHtmlTable,
	cell: HtmlElementRange, codeRegions: SourceRange[]): HtmlVisibleSegment[] {
	const segments: HtmlVisibleSegment[] = [];
	let text = '';
	let pieces: HtmlVisiblePiece[] = [];
	let inertDepth = 0;
	const flush = () => {
		if (text) segments.push({ text, pieces });
		text = '';
		pieces = [];
	};
	const append = (start: number, end: number) => {
		if (end <= start) return;
		const mapped = decodeHtmlTextWithOffsets(source.slice(start, end), index.stats);
		pieces.push({ sourceStart: start, sourceEnd: end, decodedStart: text.length,
			decodedEnd: text.length + mapped.decoded.length, decodedToRaw: mapped.decodedToRaw });
		text += mapped.decoded;
	};
	for (let tokenIndex = cell.openTokenIndex + 1; tokenIndex < cell.closeTokenIndex; tokenIndex++) {
		if (index.stats) index.stats.visibleTokenVisits++;
		const nestedTable = index.tableByOpenToken.get(tokenIndex);
		if (nestedTable?.parent === ownerTable && nestedTable.end <= cell.contentEnd) {
			flush();
			tokenIndex = nestedTable.closeTokenIndex;
			continue;
		}
		const token = index.tokens[tokenIndex];
		if (token.end <= cell.contentStart || token.start >= cell.contentEnd) continue;
		if (token.tag) {
			if (token.name && HTML_NUMERIC_BOUNDARIES.has(token.name)) flush();
			if (!token.selfClosing && token.name && HTML_NUMERIC_INERT.has(token.name)) inertDepth += token.closing ? -1 : 1;
			continue;
		}
		const start = Math.max(token.start, cell.contentStart);
		const end = Math.min(token.end, cell.contentEnd);
		let cursor = start;
		let rangeIndex = firstOverlappingRange(codeRegions, start);
		while (rangeIndex < codeRegions.length && codeRegions[rangeIndex].start < end) {
			const range = codeRegions[rangeIndex];
			if (inertDepth === 0) append(cursor, Math.min(end, range.start));
			flush();
			cursor = Math.max(cursor, Math.min(end, range.end));
			rangeIndex++;
		}
		if (inertDepth === 0) append(cursor, end);
	}
	flush();
	return segments;
}

function visibleRangeEdits(segment: HtmlVisibleSegment, start: number, end: number, replacement: string,
	stats?: TableNumberFormatScanStats, insertionAffinity: 'left' | 'right' = 'left'): SourceEdit[] {
	if (stats) stats.visiblePieceSearches++;
	let low = 0;
	let high = segment.pieces.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const endsBefore = insertionAffinity === 'right' && start === end
			? segment.pieces[middle].decodedEnd <= start : segment.pieces[middle].decodedEnd < start;
		if (endsBefore) low = middle + 1;
		else high = middle;
	}
	const affected: Array<{ piece: HtmlVisiblePiece; start: number; end: number }> = [];
	for (let pieceIndex = low; pieceIndex < segment.pieces.length; pieceIndex++) {
		const piece = segment.pieces[pieceIndex];
		if (piece.decodedStart > end || (piece.decodedStart === end && start !== end)) break;
		if (stats) stats.visiblePieceVisits++;
		const localStart = Math.max(0, start - piece.decodedStart);
		const localEnd = Math.min(piece.decodedEnd - piece.decodedStart, end - piece.decodedStart);
		if (localEnd > localStart || (start === end && start >= piece.decodedStart && start <= piece.decodedEnd)) {
			affected.push({ piece, start: localStart, end: localEnd });
			if (start === end) break;
		}
	}
	const edits: SourceEdit[] = [];
	let replacementOffset = 0;
	for (let index = 0; index < affected.length; index++) {
		const item = affected[index];
		const oldLength = item.end - item.start;
		const take = index === affected.length - 1 ? replacement.length - replacementOffset
			: Math.min(oldLength, replacement.length - replacementOffset);
		const rawStart = item.piece.decodedToRaw[item.start];
		const rawEnd = item.piece.decodedToRaw[item.end];
		edits.push({ start: item.piece.sourceStart + rawStart, end: item.piece.sourceStart + rawEnd,
			insert: encodeHtmlText(replacement.slice(replacementOffset, replacementOffset + take)) });
		replacementOffset += take;
	}
	return edits;
}

function planHtmlVisibleChange(segment: HtmlVisibleSegment, formatted: string,
	stats?: TableNumberFormatScanStats): SourceEdit[] {
	const visible = segment.text;
	const beforeTokens = [...visible.matchAll(NUMERIC_TOKEN_RE)];
	const afterTokens = [...formatted.matchAll(NUMERIC_TOKEN_RE)];
	const edits: SourceEdit[] = [];
	if (beforeTokens.length === afterTokens.length
		&& visible.replace(NUMERIC_TOKEN_RE, '') === formatted.replace(NUMERIC_TOKEN_RE, '')) {
		for (let index = beforeTokens.length - 1; index >= 0; index--) {
			const beforeToken = beforeTokens[index];
			const afterToken = afterTokens[index][0];
			if (beforeToken[0] === afterToken) continue;
			for (const edit of diffCharacterEdits(beforeToken[0], afterToken)) {
				const start = (beforeToken.index ?? 0) + edit.start;
				const affinity = edit.deleteCount === 0 && edit.start === 0 ? 'right' : 'left';
				edits.push(...visibleRangeEdits(segment, start, start + edit.deleteCount, edit.insert, stats, affinity));
			}
		}
		return edits;
	}
	let prefix = 0;
	while (prefix < visible.length && prefix < formatted.length && visible[prefix] === formatted[prefix]) prefix++;
	let suffix = 0;
	while (suffix < visible.length - prefix && suffix < formatted.length - prefix
		&& visible[visible.length - 1 - suffix] === formatted[formatted.length - 1 - suffix]) suffix++;
	return visibleRangeEdits(segment, prefix, visible.length - suffix,
		formatted.slice(prefix, formatted.length - suffix), stats);
}

function applySourceEdits(source: string, rangeStart: number, rangeEnd: number, edits: SourceEdit[],
	stats?: TableNumberFormatScanStats): string {
	if (edits.length === 0) return source.slice(rangeStart, rangeEnd);
	if (stats) {
		stats.sourceEditPasses++;
		stats.sourceEditsApplied += edits.length;
	}
	const ordered = edits.map((edit, order) => ({ edit, order }))
		.sort((a, b) => a.edit.start - b.edit.start || a.order - b.order);
	const chunks: string[] = [];
	let cursor = rangeStart;
	for (let index = 0; index < ordered.length;) {
		const groupStart = ordered[index].edit.start;
		const unchanged = source.slice(cursor, groupStart);
		chunks.push(unchanged);
		if (stats) stats.sourceCharactersCopied += unchanged.length;
		let groupEnd = groupStart;
		do {
			const edit = ordered[index++].edit;
			chunks.push(edit.insert);
			groupEnd = Math.max(groupEnd, edit.end);
		} while (index < ordered.length && ordered[index].edit.start === groupStart);
		cursor = groupEnd;
	}
	const suffix = source.slice(cursor, rangeEnd);
	chunks.push(suffix);
	if (stats) stats.sourceCharactersCopied += suffix.length;
	return chunks.join('');
}

/** Apply source-coordinate edits in their declared order; exported for deterministic regression coverage. */
export function applyTableNumberSourceEdits(source: string, edits: SourceEdit[]): string {
	return applySourceEdits(source, 0, source.length, edits);
}

function indexedTablesInRange(index: HtmlStructuralIndex, start: number, end: number): IndexedHtmlTable[] {
	let low = 0;
	let high = index.tables.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (index.tables[middle].start < start) low = middle + 1;
		else high = middle;
	}
	const selected: IndexedHtmlTable[] = [];
	for (let tableIndex = low; tableIndex < index.tables.length; tableIndex++) {
		const table = index.tables[tableIndex];
		if (table.start >= end) break;
		if (index.stats) index.stats.tableRangeVisits++;
		if (table.end <= end) selected.push(table);
	}
	return selected;
}

function rootTablesInRange(index: HtmlStructuralIndex, start: number, end: number): IndexedHtmlTable[] {
	return indexedTablesInRange(index, start, end)
		.filter(table => !table.parent || table.parent.start < start || table.parent.end > end);
}

function formatSingleIndexedTable(table: IndexedHtmlTable, source: string, baseFormat: TableNumberFormat,
	index: HtmlStructuralIndex, codeRegions: SourceRange[], warnings: string[], warningDetails: TableNumberFormatWarning[],
	edits: SourceEdit[]): void {
	if (index.stats) index.stats.tableFormatVisits++;
	const warningsBefore = warnings.length;
	const recordTableWarnings = () => {
		for (const message of warnings.slice(warningsBefore)) {
			warningDetails.push({ message, start: table.start, end: table.end });
		}
	};
	const opening = index.tokens[table.openTokenIndex];
	const effective = mergeFormat(baseFormat, parseHtmlTableFormat(source.slice(opening.start, opening.end)));
	if (effective.digits === undefined && effective.decimalMark === undefined && effective.digitGrouping === undefined) return;
	const error = validateTableNumberFormat(effective);
	if (error) {
		warnings.push(error);
		recordTableWarnings();
		return;
	}
	for (let cellIndex = table.cells.length - 1; cellIndex >= 0; cellIndex--) {
		const cell = table.cells[cellIndex];
		const cellOpening = index.tokens[cell.openTokenIndex];
		const cellSource = parseHtmlCellSource(source.slice(cellOpening.start, cellOpening.end));
		const segments = htmlVisibleSegments(source, index, table, cell, codeRegions);
		for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex--) {
			const segment = segments[segmentIndex];
			const formatted = segments.length === 1 ? formatTypedCell(cellSource, segment.text, effective, warnings)
				: formatTextCell(segment.text, effective, warnings);
			if (formatted !== segment.text) edits.push(...planHtmlVisibleChange(segment, formatted, index.stats));
		}
	}
	recordTableWarnings();
}

function formatIndexedHtmlRange(source: string, start: number, end: number, format: TableNumberFormat,
	index: HtmlStructuralIndex, codeRegions: SourceRange[], warnings: string[],
	warningDetails: TableNumberFormatWarning[]): string {
	const roots = rootTablesInRange(index, start, end);
	const edits: SourceEdit[] = [];
	for (let rootIndex = roots.length - 1; rootIndex >= 0; rootIndex--) {
		const stack: Array<{ table: IndexedHtmlTable; visited: boolean }> = [{ table: roots[rootIndex], visited: false }];
		while (stack.length > 0) {
			const item = stack.pop()!;
			if (item.visited) {
				formatSingleIndexedTable(item.table, source, format, index, codeRegions, warnings, warningDetails, edits);
				continue;
			}
			stack.push({ table: item.table, visited: true });
			for (let childIndex = 0; childIndex < item.table.children.length; childIndex++) {
				stack.push({ table: item.table.children[childIndex], visited: false });
			}
		}
	}
	return applySourceEdits(source, start, end, edits, index.stats);
}

function parseHtmlCellSource(openingTag: string): HtmlTableCellSource | undefined {
	const attr = (name: string): string | undefined => {
		const match = openingTag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\\\'([^\\\']*)\\\'|([^\\s>]+))', 'i'));
		return match ? decodeHtmlText(match[1] ?? match[2] ?? match[3]) : undefined;
	};
	const kind = parseHtmlTableCellSourceKind(attr('data-mm-kind'));
	if (!kind) return undefined;
	const rawText = attr('data-mm-raw');
	const rawValue = rawText === undefined ? undefined : Number(rawText);
	return { kind, display: '', ...(rawValue !== undefined && Number.isFinite(rawValue) ? { rawValue } : {}),
		...(attr('data-mm-format') ? { sourceFormat: attr('data-mm-format') } : {}) };
}

function diffCharacterEdits(before: string, after: string): Array<{ start: number; deleteCount: number; insert: string }> {
	const matrixCells = (before.length + 1) * (after.length + 1);
	if (before.length > 0xffff || after.length > 0xffff || matrixCells > 1_000_000) {
		let prefix = 0;
		while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
		let suffix = 0;
		while (suffix < before.length - prefix && suffix < after.length - prefix
				&& before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
		return [{ start: prefix, deleteCount: before.length - prefix - suffix,
			insert: after.slice(prefix, after.length - suffix) }];
	}
	const lengths = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1
				: Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}
	const edits: Array<{ start: number; deleteCount: number; insert: string }> = [];
	let i = 0;
	let j = 0;
	let current: { start: number; deleteCount: number; insert: string } | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
	};
	while (i < before.length || j < after.length) {
		if (i < before.length && j < after.length && before[i] === after[j]) {
			flush(); i++; j++; continue;
		}
		current ??= { start: i, deleteCount: 0, insert: '' };
		if (j < after.length && (i === before.length || lengths[i][j + 1] >= lengths[i + 1][j])) {
			current.insert += after[j++];
		} else {
			current.deleteCount++; i++;
		}
	}
	flush();
	return edits;
}

function decodeHtmlText(raw: string): string {
	return raw.replace(/&#(\d+);/g, (entity, code) => decodeNumericHtmlEntity(entity, code, 10))
		.replace(/&#x([0-9a-f]+);/gi, (entity, code) => decodeNumericHtmlEntity(entity, code, 16))
		.replace(/&nbsp;/gi, '\u00a0').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function encodeHtmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitPipeRow(line: string): { prefix: string; cells: string[]; suffix: string } | undefined {
  const leading = line.match(/^\s*/)?.[0] ?? '';
  const trimmed = line.trim();
  const hasLeading = trimmed.startsWith('|');
  const hasTrailing = trimmed.endsWith('|');
  const inner = trimmed.slice(hasLeading ? 1 : 0, hasTrailing ? -1 : undefined);
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of inner) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { current += char; escaped = true; continue; }
    if (char === '|') { cells.push(current); current = ''; } else current += char;
  }
  cells.push(current);
  return { prefix: leading + (hasLeading ? '|' : ''), cells, suffix: hasTrailing ? '|' : '' };
}

function isPipeSeparator(line: string): boolean {
  const parsed = splitPipeRow(line);
  return Boolean(parsed && parsed.cells.length > 0 && parsed.cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell)));
}

function formatPipeRow(line: string, format: TableNumberFormat, warnings: string[]): string {
  const parsed = splitPipeRow(line);
  if (!parsed) return line;
  const cells = parsed.cells.map(cell => {
    const leading = cell.match(/^\s*/)?.[0] ?? '';
    const trailing = cell.match(/\s*$/)?.[0] ?? '';
    return leading + formatTextCell(cell.trim(), format, warnings) + trailing;
  });
  return parsed.prefix + cells.join('|') + parsed.suffix;
}

function formatGridPlaceholder(line: string, format: TableNumberFormat, warnings: string[]): string {
  const start = line.indexOf(GRID_TABLE_PLACEHOLDER_PREFIX);
  if (start < 0) return line;
  const encoded = line.slice(start + GRID_TABLE_PLACEHOLDER_PREFIX.length).replace(/\s*-->\s*$/, '').trim();
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as GridTableData;
    for (const row of data.rows) row.cells = row.cells.map(cell => formatTextCell(cell, format, warnings));
    return line.slice(0, start) + GRID_TABLE_PLACEHOLDER_PREFIX + Buffer.from(JSON.stringify(data)).toString('base64') + ' -->';
  } catch {
    return line;
  }
}

function maskedSourceRange(source: string, start: number, end: number, ranges: SourceRange[]): string {
	let output = '';
	let cursor = start;
	let index = firstOverlappingRange(ranges, start);
	while (index < ranges.length && ranges[index].start < end) {
		const range = ranges[index];
		const overlapStart = Math.max(cursor, range.start);
		const overlapEnd = Math.min(end, range.end);
		output += source.slice(cursor, overlapStart);
		output += source.slice(overlapStart, overlapEnd).replace(/[^\r\n]/g, ' ');
		cursor = Math.max(cursor, overlapEnd);
		index++;
	}
	return output + source.slice(cursor, end);
}

function isRangeEnclosed(start: number, end: number, ranges: SourceRange[]): boolean {
	let index = firstOverlappingRange(ranges, start);
	while (index < ranges.length && ranges[index].start < end) {
		const range = ranges[index];
		if (start < range.end && end > range.start && (range.start < start || range.end > end)) return true;
		index++;
	}
	return false;
}

/** Apply document and per-table numeric formatting without modifying any embedded source file. */
export function formatTableNumbers(markdown: string, documentFormat: TableNumberFormat = {},
	scanStats?: TableNumberFormatScanStats): TableNumberFormatResult {
	const warnings: string[] = [];
	const warningDetails: TableNumberFormatWarning[] = [];
	const documentError = validateTableNumberFormat(documentFormat);
	if (documentError) warnings.push(documentError);
	const lines = markdown.split('\n');
	const lineOffsets: number[] = [];
	let nextLineOffset = 0;
	for (const line of lines) { lineOffsets.push(nextLineOffset); nextLineOffset += line.length + 1; }
	const codeRegions = computeCodeRegions(markdown);
	const structuralIndex = buildHtmlStructuralIndex(markdown, codeRegions, lineOffsets, scanStats);
	const inertRegions = mergeSourceRanges([...codeRegions, ...structuralIndex.inertRegions]);
	const recordWarnings = (from: number, start: number, end: number) => {
		for (const message of warnings.slice(from)) warningDetails.push({ message, start, end });
	};
	const recordHtmlError = (message: string, start: number, end: number) => {
		for (const table of rootTablesInRange(structuralIndex, start, end)) {
			warningDetails.push({ message, start: table.start, end: table.end });
		}
	};
	const output: string[] = [];
	let pending: Partial<TableNumberFormat> = {};
	let pendingInvalid = false;
	let i = 0;
	let fenceChar: '`' | '~' | undefined;
	let fenceLength = 0;
	while (i < lines.length) {
		const fence = lines[i].match(/^ {0,3}([`~]{3,})/);
		if (fence) {
			const char = fence[1][0] as '`' | '~';
			if (!fenceChar) { fenceChar = char; fenceLength = fence[1].length; }
			else if (char === fenceChar && fence[1].length >= fenceLength) { fenceChar = undefined; fenceLength = 0; }
			output.push(lines[i++]);
			pending = {};
			pendingInvalid = false;
			continue;
		}
		if (fenceChar || /^ {4}/.test(lines[i])) {
			output.push(lines[i++]);
			pending = {};
			pendingInvalid = false;
			continue;
		}
		const currentLineStart = lineOffsets[i];
		const currentLineEnd = currentLineStart + lines[i].length;
		// A standalone directive/placeholder is itself an HTML comment. Only an
		// enclosing inert region (a fence, outer comment, or raw-text element)
		// should suppress it.
		const lineIsEnclosedInert = isRangeEnclosed(currentLineStart, currentLineEnd, inertRegions);
		const directive = lineIsEnclosedInert ? undefined : parseDirective(lines[i]);
		if (directive) {
			if (directive.error) {
				warnings.push(directive.error);
				warningDetails.push({ message: directive.error, start: lineOffsets[i], end: lineOffsets[i] + lines[i].length });
				pendingInvalid = true;
			} else {
				pending = { ...pending, ...directive.format };
			}
			output.push(lines[i]);
			i++;
			continue;
		}
		const format = mergeFormat(documentFormat, pending);
		const error = validateTableNumberFormat(format);
		if (error) warnings.push(error);
		const detectionLine = maskedSourceRange(markdown, currentLineStart, currentLineEnd, inertRegions);
		const opensHtmlTable = structuralIndex.openTableLines.has(i) || /^\s*<table\b/i.test(detectionLine);
		if (opensHtmlTable) {
			const candidateEnd = structuralIndex.openTableLines.has(i) ? structuralIndex.collectionEndByLine[i] : undefined;
			if (candidateEnd !== undefined) {
				const tableStart = lineOffsets[i];
				const lastLine = candidateEnd - 1;
				const tableEnd = lineOffsets[lastLine] + lines[lastLine].length;
				output.push(pendingInvalid || error ? markdown.slice(tableStart, tableEnd)
					: formatIndexedHtmlRange(markdown, tableStart, tableEnd, format, structuralIndex, codeRegions,
						warnings, warningDetails));
				if (error) recordHtmlError(error, tableStart, tableEnd);
				i = candidateEnd;
				pending = {};
				pendingInvalid = false;
				continue;
			}
			// If collection reaches EOF without balancing, commit only complete
			// tables that begin on this line and leave unmatched siblings untouched.
			const recoveryEnd = structuralIndex.recoveryEndByStartLine[i];
			if (recoveryEnd !== undefined) {
				const tableStart = lineOffsets[i];
				const lastLine = recoveryEnd - 1;
				const tableEnd = lineOffsets[lastLine] + lines[lastLine].length;
				output.push(pendingInvalid || error ? markdown.slice(tableStart, tableEnd)
					: formatIndexedHtmlRange(markdown, tableStart, tableEnd, format, structuralIndex, codeRegions,
						warnings, warningDetails));
				if (error) recordHtmlError(error, tableStart, tableEnd);
				i = recoveryEnd;
				pending = {};
				pendingInvalid = false;
				continue;
			}
		}
		if (lines[i].includes(GRID_TABLE_PLACEHOLDER_PREFIX) && !lineIsEnclosedInert) {
			const warningsBefore = warnings.length;
			const tableStart = lineOffsets[i];
			output.push(formatGridPlaceholder(lines[i], pendingInvalid || error ? {} : format, warnings));
			if (error) warningDetails.push({ message: error, start: tableStart, end: tableStart + lines[i].length });
			recordWarnings(warningsBefore, tableStart, tableStart + lines[i].length);
			pending = {};
			pendingInvalid = false;
			i++;
			continue;
		}
		let nextDetectionLine = lines[i + 1] ?? '';
		if (i + 1 < lines.length) {
			const nextStart = lineOffsets[i + 1];
			nextDetectionLine = maskedSourceRange(markdown, nextStart, nextStart + nextDetectionLine.length, inertRegions);
		}
		if (i + 1 < lines.length && detectionLine.includes('|') && isPipeSeparator(nextDetectionLine)) {
			const tableStart = lineOffsets[i];
			const warningsBefore = warnings.length;
			output.push(formatPipeRow(lines[i], pendingInvalid || error ? {} : format, warnings));
			output.push(lines[i + 1]);
			i += 2;
			while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
				output.push(formatPipeRow(lines[i++], pendingInvalid || error ? {} : format, warnings));
			}
			const tableEnd = lineOffsets[i - 1] + lines[i - 1].length;
			if (error) warningDetails.push({ message: error, start: tableStart, end: tableEnd });
			recordWarnings(warningsBefore, tableStart, tableEnd);
			pending = {};
			pendingInvalid = false;
			continue;
		}
		output.push(lines[i]);
		if (lines[i].trim() && !/^\s*<!--/.test(lines[i])) { pending = {}; pendingInvalid = false; }
		i++;
	}
	return { output: output.join('\n'), warnings: [...new Set(warnings)], warningDetails };
}
