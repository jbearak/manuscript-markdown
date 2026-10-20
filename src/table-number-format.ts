import { GRID_TABLE_PLACEHOLDER_PREFIX, type GridTableData } from './grid-table-preprocess';
import type { HtmlTableCellSource } from './html-table-parser';
import { type CommentReach, computeMarkdownRegions, isInsideCodeRegion, lineInRegions, regionAt, type TableRegion } from './code-regions';
import { criticPayloadRanges } from './critic-markup';
import { exportsLiterally } from './html-blocks';
import { maxOf, pushAll } from './arrays';
import type { LineEdit } from './line-map';
import { decodeHtmlAttribute, decodeHtmlCharacterReferences, HTML_CHARACTER_REFERENCE } from './html-entities';
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
  /** Where it wrote a table's cells, in order, which can take its lines
   *  out or put them in, as for a cell of lines of a dash a number takes
   *  the place of, so the lines after it are known (see line-map.ts) */
  edits: LineEdit[];
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
	htmlTagCharactersVisited: number;
	malformedTagRecoveries: number;
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
	/** The comments the scan read shorter than its first --> after it, or
	 *  as none, each to that --> (see scanHtmlSource) */
	shortened: SourceRange[];
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

/** How far a comment from the <!-- at `at` can reach, where that's short
 *  of `firstEnd`, the end of the first --> after it (see commentBounds) */
type CommentBound = (at: number, firstEnd: number) => number | undefined;

/** A CriticMarkup span's opener or closer, a run of dollar signs, or a
 *  LaTeX environment's \begin or \end, in `end` */
const SPAN_MARK_RE = /\{(?:\+\+|--|~~|>>|==|#)|(?:\+\+|--|~~|<<|==)\}|\$+|\\(?:begin|(end))\{/g;

/** The first of sorted `offsets` at or after `at` */
function firstAtOrAfter(offsets: number[], at: number): number {
	let lo = 0;
	let hi = offsets.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (offsets[mid] < at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * How far a comment can reach from each <!-- of `reaches` whose reach
 * markdown-it fixes (see CommentReach in code-regions.ts), as export reads
 * it. Not one in a block a CriticMarkup span joins to the lines after it,
 * which export reads as one paragraph, as preprocessCriticMarkup writes it,
 * whose comment can take them, as a directive in them. Nor one whose text
 * to its first --> holds a CriticMarkup span's opener or closer, a dollar
 * sign or a LaTeX environment's \begin or \end, where a span, an equation
 * or the environment, which preprocessing wraps as display math over its
 * lines, can take what's after it in ways the block parse doesn't show,
 * nor one after more \begins than \ends, in such an environment. The spans
 * and those marks are found once, where a bound first ends a comment
 * sooner.
 */
function commentBounds(markdown: string, reaches: CommentReach[]): CommentBound {
	const byOffset = new Map<number, CommentReach>();
	for (const reach of reaches) byOffset.set(reach.at, reach);
	let joined: Set<number> | undefined;
	// The marks' offsets, and the environments open after each, as many
	// \begins as \ends after the last time none were
	let marks: { at: number[]; open: number[] } | undefined;
	return (at, firstEnd) => {
		const found = byOffset.get(at);
		if (!found || found.reach >= firstEnd) return undefined;
		if (!marks) {
			marks = { at: [], open: [] };
			let open = 0;
			for (const match of markdown.matchAll(SPAN_MARK_RE)) {
				if (match[0].startsWith('\\')) open = Math.max(0, open + (match[1] ? -1 : 1));
				marks.at.push(match.index);
				marks.open.push(open);
			}
		}
		const next = firstAtOrAfter(marks.at, at);
		if (next < marks.at.length && marks.at[next] < firstEnd) return undefined;
		if (next > 0 && marks.open[next - 1] > 0) return undefined;
		joined ??= joinedToNext(markdown, reaches);
		return joined.has(at) ? undefined : found.reach;
	};
}

/** The offsets of `reaches` in a block a CriticMarkup span of `markdown`
 *  joins to the line after it, as the span's payload holds its last line's
 *  end */
function joinedToNext(markdown: string, reaches: CommentReach[]): Set<number> {
	const joined = new Set<number>();
	// The spans' payloads, by their starts, and the furthest end of those
	// that start before a block's end, which comes no sooner than the last's
	const payloads = criticPayloadRanges(markdown).sort((a, b) => a[0] - b[0]);
	let next = 0;
	let furthest = -1;
	for (const { at, blockEnd } of reaches) {
		while (next < payloads.length && payloads[next][0] < blockEnd) furthest = Math.max(furthest, payloads[next++][1]);
		if (furthest >= blockEnd) joined.add(at);
	}
	return joined;
}

/**
 * The tags and text of `html`, and the comments, raw text and the like in
 * it, which hold no tag. A comment goes from its <!-- to the first --> after
 * it, but no further than its `bound` (see commentBounds), and a
 * <!-- whose bound is itself is text, as export reads one, which pairs with
 * no --> past its paragraph or its HTML block. But not in a table, whose
 * comments export's table parse reads. And where the scan then reads, in
 * the text to that -->, which it read as the comment before, a tag that
 * reaches past it, as one whose quote no other ends, a table's or a cell's
 * tag, or what holds the text after it, as a <script>, a processing
 * instruction, a declaration or CDATA, it reads the comment to that -->
 * again, or to the text's end where no --> is after it, so that it reads
 * the rest as before. Each comment it reads shorter, or as none, it gives
 * as `shortened`, to that --> or the end.
 */
function scanHtmlSource(html: string, stats?: TableNumberFormatScanStats, bound?: CommentBound): {
	tokens: HtmlSourceToken[]; inertRegions: SourceRange[]; shortened: SourceRange[];
} {
	if (stats) {
		stats.structuralScans++;
		stats.structuralCharacters += html.length;
	}
	const tokens: HtmlSourceToken[] = [];
	const inertRegions: SourceRange[] = [];
	const shortened: SourceRange[] = [];
	const lowerHtml = html.toLowerCase();
	let cursor = 0;
	let rawTextName: string | undefined;
	let rawTextStart: number | undefined;
	let closingRawTextName: string | undefined;
	// The tables open, as the structural index pairs their tags
	let openTables = 0;
	// The first --> at or after the offset of the last search for one, which
	// a later <!-- reads again where it's after that <!--, as a comment that
	// ends at its bound leaves the scan before it, and each searched on from
	// its <!-- to the text's end where none was
	let searchedFrom = Infinity;
	let found = -1;
	const closeAfter = (from: number): number => {
		if (from < searchedFrom || (found !== -1 && found < from)) {
			found = html.indexOf('-->', from);
			searchedFrom = from;
		}
		return found;
	};
	// The first comment the scan reads to its bound, short of its first -->
	// after it, from `start` to that --> at `end`, or to the text's end, and
	// the scan's state at it, while the scan reads the text to there. No raw
	// text is open there, as a <script> or the like in it reads the comment
	// again
	let hidden: { start: number; end: number; tokens: number; regions: number; openTables: number;
		rawTextStart?: number; closingRawTextName?: string } | undefined;
	// Read that comment to its --> again, as the scan did before, with the
	// state it had at its <!--
	const readHidden = (): void => {
		const { start, end } = hidden!;
		tokens.length = hidden!.tokens;
		inertRegions.length = hidden!.regions;
		openTables = hidden!.openTables;
		rawTextStart = hidden!.rawTextStart;
		closingRawTextName = hidden!.closingRawTextName;
		tokens.push({ raw: html.slice(start, end), tag: true, start, end });
		inertRegions.push({ start, end });
		cursor = end;
		hidden = undefined;
	};
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
		if (hidden && tagStart >= hidden.end) {
			shortened.push({ start: hidden.start, end: hidden.end });
			hidden = undefined;
		}
		// In that text, one that holds the text after it, to its end, which
		// can be past the -->, and which a search from each of many there
		// would look for to the text's end
		if (hidden && (html.startsWith('<![CDATA[', tagStart) || html.startsWith('<?', tagStart)
			|| (html[tagStart + 1] === '!' && /[A-Za-z]/.test(html[tagStart + 2] ?? '')))) {
			readHidden();
			continue;
		}
		if (html.startsWith('<![CDATA[', tagStart)) {
			const closeStart = html.indexOf(']]>', tagStart + 9);
			const end = closeStart < 0 ? html.length : closeStart + 3;
			tokens.push({ raw: html.slice(tagStart, end), tag: true, start: tagStart, end });
			inertRegions.push({ start: tagStart, end });
			if (stats) stats.htmlTagCharactersVisited += end - tagStart;
			cursor = end;
			continue;
		}
		if (html.startsWith('<?', tagStart)) {
			const closeStart = html.indexOf('?>', tagStart + 2);
			const end = closeStart < 0 ? html.length : closeStart + 2;
			tokens.push({ raw: html.slice(tagStart, end), tag: true, start: tagStart, end });
			inertRegions.push({ start: tagStart, end });
			if (stats) stats.htmlTagCharactersVisited += end - tagStart;
			cursor = end;
			continue;
		}
		if (html[tagStart + 1] === '!' && /[A-Za-z]/.test(html[tagStart + 2] ?? '')) {
			let quote = '';
			let end = tagStart + 3;
			for (; end < html.length; end++) {
				if (stats) stats.htmlTagCharactersVisited++;
				const char = html[end];
				if (quote) {
					if (char === quote) quote = '';
				} else if (char === '"' || char === "'") quote = char;
				else if (char === '>') { end++; break; }
			}
			tokens.push({ raw: html.slice(tagStart, end), tag: true, start: tagStart, end });
			inertRegions.push({ start: tagStart, end });
			cursor = end;
			continue;
		}
		if (html.startsWith('<!--', tagStart)) {
			const close = closeAfter(tagStart + 4);
			const firstEnd = close < 0 ? html.length : close + 3;
			const end = (openTables > 0 ? undefined : bound?.(tagStart, firstEnd)) ?? firstEnd;
			if (hidden && end > hidden.end) { readHidden(); continue; }
			if (end < firstEnd && !hidden) {
				hidden = { start: tagStart, end: firstEnd, tokens: tokens.length, regions: inertRegions.length, openTables,
					rawTextStart, closingRawTextName };
			}
			if (end === tagStart) {
				tokens.push({ raw: '<', tag: false, start: tagStart, end: tagStart + 1 });
				cursor = tagStart + 1;
				continue;
			}
			tokens.push({ raw: html.slice(tagStart, end), tag: true, start: tagStart, end });
			inertRegions.push({ start: tagStart, end });
			cursor = end;
			continue;
		}
		let quote = '';
		let end = tagStart + 1;
		let malformedRestart: number | undefined;
		// A tag that the text to the --> doesn't end reaches past it
		const stop = hidden ? hidden.end : html.length;
		let ended = false;
		for (; end < stop; end++) {
			if (stats) stats.htmlTagCharactersVisited++;
			const char = html[end];
			if (quote) {
				if (char === quote) quote = '';
			} else if (char === '"' || char === "'") quote = char;
			else if (char === '<') { malformedRestart = end; break; }
			else if (char === '>') { end++; ended = true; break; }
		}
		if (hidden && malformedRestart === undefined && !ended) { readHidden(); continue; }
		if (malformedRestart !== undefined) {
			tokens.push({ raw: html.slice(tagStart, malformedRestart), tag: false, start: tagStart, end: malformedRestart });
			if (stats) stats.malformedTagRecoveries++;
			cursor = malformedRestart;
			continue;
		}
		if (end > html.length || html[end - 1] !== '>') {
			tokens.push({ raw: html.slice(tagStart), tag: false, start: tagStart, end: html.length });
			if (stats) stats.malformedTagRecoveries++;
			break;
		}
		const raw = html.slice(tagStart, end);
		let inner = raw.slice(1, -1).trim();
		const closing = inner.startsWith('/');
		if (closing) inner = inner.slice(1).trimStart();
		let nameEnd = 0;
		while (nameEnd < inner.length && /[A-Za-z0-9:-]/.test(inner[nameEnd])) nameEnd++;
		const name = inner.slice(0, nameEnd).toLowerCase() || undefined;
		const selfClosing = /\/\s*>$/.test(raw);
		const rawText = !closing && !selfClosing && !!name && isHtmlRawTextName(name);
		if (hidden && (rawText || name === 'table' || name === 'td' || name === 'th')) { readHidden(); continue; }
		tokens.push({ raw, tag: true, name, closing, selfClosing, start: tagStart, end });
		if (name === 'table' && !selfClosing) openTables = closing ? Math.max(0, openTables - 1) : openTables + 1;
		if (closing && name && name === closingRawTextName && rawTextStart !== undefined) {
			inertRegions.push({ start: rawTextStart, end });
			rawTextStart = undefined;
			closingRawTextName = undefined;
		}
		if (rawText) {
			rawTextName = name;
			rawTextStart = tagStart;
		}
		cursor = end;
	}
	if (hidden) shortened.push({ start: hidden.start, end: hidden.end });
	if (stats) stats.structuralTokens += tokens.length;
	return { tokens, inertRegions, shortened };
}

interface OwnedHtmlCellRange extends HtmlElementRange {
	ownerTableOpenTokenIndex?: number;
}

function buildHtmlStructuralIndex(markdown: string, codeRegions: SourceRange[], lineOffsets: number[], stats?: TableNumberFormatScanStats,
	bound?: CommentBound): HtmlStructuralIndex {
	const masked = maskSourceRanges(markdown, codeRegions);
	const scanned = scanHtmlSource(masked, stats, bound);
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
	const cellsByOwner = new Map<IndexedHtmlTable, HtmlElementRange[]>();
	for (const cell of cellRanges) {
		const owner = tableByOpenToken.get(cell.ownerTableOpenTokenIndex ?? -1);
		if (!owner || cell.start < owner.contentStart || cell.end > owner.contentEnd) continue;
		const owned = cellsByOwner.get(owner) ?? [];
		owned.push(cell);
		cellsByOwner.set(owner, owned);
	}
	for (const [owner, owned] of cellsByOwner) {
		owned.sort((a, b) => a.start - b.start || a.end - b.end);
		let group: HtmlElementRange[] = [];
		let groupEnd = -1;
		const flush = () => {
			if (group.length === 1) owner.cells.push(group[0]);
			group = [];
			groupEnd = -1;
		};
		for (const cell of owned) {
			if (group.length > 0 && cell.start >= groupEnd) flush();
			group.push(cell);
			groupEnd = Math.max(groupEnd, cell.end);
		}
		flush();
	}
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
		shortened: scanned.shortened, openTableLines, recoveryEndByStartLine, collectionEndByLine };
}

function parseHtmlTableFormat(openingTag: string): Partial<TableNumberFormat> {
	const attr = (name: string): string | undefined => {
		const match = openingTag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\\\'([^\\\']*)\\\'|([^\\s>]+))', 'i'));
		return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? match[3]) : undefined;
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

/** How many of the characters a named reference reads as, `value`, are the
 *  rest of it after a name read in part, as text: 4 of £123; for &pound123;,
 *  or 4 of £1234 for &pound1234, which the browser reads by &pound, a
 *  legacy name, or all but the & where it reads no name, as &foo; is text,
 *  and none for one read whole */
function unreadLength(reference: string, value: string): number {
	if (reference[1] === '#') return 0;
	let read = 1;
	while (!reference.endsWith(value.slice(read))) read++;
	return value.length - read;
}

function decodeHtmlTextWithOffsets(raw: string, stats?: TableNumberFormatScanStats): { decoded: string; decodedToRaw: Uint32Array } {
	const offsets = [0];
	let decoded = '';
	const tokenRe = new RegExp(HTML_CHARACTER_REFERENCE + '|[\\s\\S]', 'g');
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(raw)) !== null) {
		const token = match[0];
		const value = decodeHtmlCharacterReferences(token);
		decoded += value;
		// The rest of a name read in part keeps its characters' places, so an
		// edit to them lands before the ;
		const rest = unreadLength(token, value);
		const read = value.length - rest;
		const readEnd = tokenRe.lastIndex - rest;
		for (let index = 0; index < read; index++) offsets.push(readEnd);
		for (let index = 1; index <= rest; index++) offsets.push(readEnd + index);
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
	const inertCounts = new Map<string, number>();
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
			if (!token.selfClosing && token.name && HTML_NUMERIC_INERT.has(token.name)) {
				const active = inertCounts.get(token.name) ?? 0;
				if (token.closing) {
					if (active > 0) {
						inertCounts.set(token.name, active - 1);
						inertDepth--;
					}
				} else {
					inertCounts.set(token.name, active + 1);
					inertDepth++;
				}
			}
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
				pushAll(edits, visibleRangeEdits(segment, start, start + edit.deleteCount, edit.insert, stats, affinity));
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

/** `edits`, after a ; at the end of each numeric reference without one that
 *  the edits would run on into a digit, or a ; that would end it, as
 *  dropping the space of &#x31 234 would make &#x31234, which the browser
 *  reads as U+31234, not 1234, and at the end of each name read in part
 *  that the edits would change the rest of, as &pound123; is £123;, by
 *  &pound, to the browser, which reads &pound123.00; as £123.00;, but
 *  which export reads as no reference, since its ; isn't right after the
 *  name, and &pound;123.00; as both read it */
function terminateReferencesBefore(source: string, segment: HtmlVisibleSegment, edits: SourceEdit[]): SourceEdit[] {
	const editsAt = new Map<number, SourceEdit[]>();
	for (const edit of edits) editsAt.set(edit.start, [...editsAt.get(edit.start) ?? [], edit]);
	const ordered = [...edits].sort((a, b) => a.start - b.start);
	// The first of the edits in order that starts at or after `position`
	const firstFrom = (position: number): number => {
		let low = 0;
		let high = ordered.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (ordered[middle].start < position) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	// The character at `position` once the edits are made, as
	// applySourceEdits makes them: the inserts there in order, or else what
	// follows the most they delete
	const characterAt = (position: number): string | undefined => {
		const at = editsAt.get(position);
		if (!at) return source[position];
		const insert = at.map(edit => edit.insert).join('');
		const end = maxOf(at.map(edit => edit.end));
		return insert ? insert[0] : end > position ? characterAt(end) : source[position];
	};
	const terminations: SourceEdit[] = [];
	for (const piece of segment.pieces) {
		// Read as decodeHtmlTextWithOffsets reads them
		for (const reference of source.slice(piece.sourceStart, piece.sourceEnd).matchAll(new RegExp(HTML_CHARACTER_REFERENCE, 'g'))) {
			const end = piece.sourceStart + reference.index + reference[0].length;
			if (reference[0][1] !== '#') {
				const value = decodeHtmlCharacterReferences(reference[0]);
				const nameEnd = end - (value === reference[0] ? 0 : unreadLength(reference[0], value));
				const next = firstFrom(nameEnd);
				// Where an edit takes in the name's end too, it writes the name's
				// character as text, which leaves no reference
				if (nameEnd < end && next < ordered.length && ordered[next].start < end
					&& !(next > 0 && ordered[next - 1].end > nameEnd)) {
					terminations.push({ start: nameEnd, end: nameEnd, insert: ';' });
				}
				continue;
			}
			if (reference[0].endsWith(';') || !editsAt.has(end)) continue;
			const next = characterAt(end);
			if (next !== undefined && (/[xX]/.test(reference[0][2]) ? /[0-9a-fA-F;]/ : /[0-9;]/).test(next)) {
				terminations.push({ start: end, end, insert: ';' });
			}
		}
	}
	// First, as applySourceEdits joins the inserts at one place in order
	return [...terminations, ...edits];
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
			if (formatted !== segment.text) {
				pushAll(edits, terminateReferencesBefore(source, segment, planHtmlVisibleChange(segment, formatted, index.stats)));
			}
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
		return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? match[3]) : undefined;
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
    // The whitespace after what is left, which a cell of whitespace alone
    // has none of, or it went in twice
    const leading = cell.match(/^\s*/)?.[0] ?? '';
    const trailing = cell.slice(leading.length).match(/\s*$/)?.[0] ?? '';
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

/** Of each of `kinds`, markdown-it's pipe tables or HTML blocks that hold
 *  tables, each sorted, those export writes as tables: those at the top
 *  level, but not one whose lines a CriticMarkup span joins, which export
 *  reads as the span's text, as one whose first line starts with the
 *  closer the span's payload ends at. An equation, which export reads in a
 *  paragraph's text, takes no table but over the lines such a span joins */
function tablesExportReads(markdown: string, ...kinds: TableRegion[][]): SourceRange[][] {
	const overLines: SourceRange[] = [];
	for (const [start, end] of criticPayloadRanges(markdown)) {
		if (/[\r\n]/.test(markdown.slice(start, end))) overLines.push({ start, end });
	}
	overLines.sort((a, b) => a.start - b.start);
	return kinds.map(tables => {
		// The furthest end of the spans that start before a table's end
		let next = 0;
		let reach = -1;
		return tables.filter(table => {
			while (next < overLines.length && overLines[next].start < table.end) reach = Math.max(reach, overLines[next++].end);
			return table.topLevel && reach < table.start;
		});
	});
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
	// Code as export reads it, with HTML blocks, a fence's line in which
	// opens no code block, and past whose edges no code span runs, and the
	// code blocks alone, whose lines hold no table or directive, nor do the
	// HTML blocks export writes as text, but a directive's own. And how far
	// a comment reaches from a <!-- in a paragraph's text or at an HTML
	// block's start, where a scan of the text alone would pair it with a -->
	// past its paragraph or block, as a directive's, in which it then read
	// the directive, and the pipe tables markdown-it reads and the HTML
	// blocks export reads tables from. But only where a number format can
	// apply, from the document or a directive, as otherwise the step reads
	// the comment as before, to its first -->, and does what it did
	const formats = documentFormat.digits !== undefined || documentFormat.decimalMark !== undefined
		|| documentFormat.digitGrouping !== undefined || /table-(?:digits|decimal-mark|digit-grouping)/i.test(markdown);
	const { codeRegions, blockCodeRegions, literalHtmlRegions, commentReaches, tableRegions, htmlTableBlocks } = computeMarkdownRegions(markdown,
		{ html: 'all', literalHtml: exportsLiterally, exportQuotes: true, commentReaches: formats, includeTables: formats });
	const structuralIndex = buildHtmlStructuralIndex(markdown, codeRegions, lineOffsets, scanStats,
		formats ? commentBounds(markdown, commentReaches) : undefined);
	const inertRegions = mergeSourceRanges([...codeRegions, ...structuralIndex.inertRegions]);
	// The text of a comment the scan read shorter, or as none, it reads as
	// before, as a comment's, but for a directive that is an HTML block of
	// its own and a pipe table export writes, as markdown-it reads more there
	// than the lines alone show: a line of a list item's or a quote's text,
	// lazy, that looks like a table's is none, nor is one with no delimiter
	// row after it. The rest of each line, and each line elsewhere, it reads
	// with the regions it read
	const { shortened } = structuralIndex;
	const pairedInertRegions = shortened.length === 0 ? inertRegions : mergeSourceRanges([...inertRegions, ...shortened]);
	// The pipe tables, 0, and the HTML blocks of tables, 1, export writes
	let exportTables: SourceRange[][] | undefined;
	const exportsTable = (start: number, kind: 0 | 1) =>
		!!regionAt(start, (exportTables ??= tablesExportReads(markdown, tableRegions, htmlTableBlocks))[kind]);
	// Whether a line holds text of a comment the scan read shorter
	const holdsShortened = (line: number): boolean => {
		if (shortened.length === 0 || line >= lines.length) return false;
		const start = lineOffsets[line];
		const first = firstOverlappingRange(shortened, start);
		return first < shortened.length && shortened[first].start <= start + lines[line].length;
	};
	const inertFor = (line: number): SourceRange[] => {
		if (!holdsShortened(line)) return inertRegions;
		const start = lineOffsets[line];
		if (parseDirective(lines[line]) && lineInRegions(start, lineOffsets[line + 1] ?? markdown.length, literalHtmlRegions) === 'alone') return inertRegions;
		return regionAt(start, tableRegions) && exportsTable(start, 0) ? inertRegions : pairedInertRegions;
	};
	const recordWarnings = (from: number, start: number, end: number) => {
		for (const message of warnings.slice(from)) warningDetails.push({ message, start, end });
	};
	const recordHtmlError = (message: string, start: number, end: number) => {
		for (const table of rootTablesInRange(structuralIndex, start, end)) {
			warningDetails.push({ message, start: table.start, end: table.end });
		}
	};
	const output: string[] = [];
	const edits: LineEdit[] = [];
	// The text of [start, end) of the Markdown, formatted as `text`
	const write = (start: number, end: number, text: string) => {
		output.push(text);
		if (text !== markdown.slice(start, end)) edits.push({ start, end, text });
	};
	let pending: Partial<TableNumberFormat> = {};
	let pendingInvalid = false;
	// What's pending but for the directives in the text of a comment the
	// scan read shorter, which the comment paired with its first --> hid,
	// and whether one of them is: what they set applies only to a table
	// export writes, and the rest, as a table in a list item, which export
	// drops, or lines that only look like a table's, keep the format they
	// had before, this (see formatFor)
	let pairedPending = pending;
	let pairedPendingInvalid = false;
	let shortenedPending = false;
	const resetPending = () => {
		pending = pairedPending = {};
		pendingInvalid = pairedPendingInvalid = shortenedPending = false;
	};
	// The format for a table, or a pipe table's row, at `start`, of `kind`:
	// `format`, from what's pending, with its `error`, but the one from
	// pairedPending where a directive only the shorter comment shows is
	// pending and export writes no table there, and whether to leave the
	// table as it is, as the one it takes is invalid
	const formatFor = (start: number, kind: 0 | 1, format: TableNumberFormat, error: string | undefined) => {
		if (!shortenedPending || exportsTable(start, kind)) return { format, error, skip: pendingInvalid || !!error };
		const pairedFormat = mergeFormat(documentFormat, pairedPending);
		const pairedError = validateTableNumberFormat(pairedFormat);
		if (pairedError) warnings.push(pairedError);
		return { format: pairedFormat, error: pairedError, skip: pairedPendingInvalid || !!pairedError };
	};
	let i = 0;
	while (i < lines.length) {
		// Four spaces in, a line is code, or the text of a paragraph it goes
		// on, which holds no table either, as markdown-it reads none there
		if (isInsideCodeRegion(lineOffsets[i], blockCodeRegions) || /^ {4}/.test(lines[i])) {
			output.push(lines[i++]);
			resetPending();
			continue;
		}
		const literalHtml = lineInRegions(lineOffsets[i], lineOffsets[i + 1] ?? markdown.length, literalHtmlRegions);
		if (literalHtml && !(literalHtml === 'alone' && parseDirective(lines[i]))) {
			output.push(lines[i]);
			if (lines[i].trim() && !/^\s*<!--/.test(lines[i])) resetPending();
			i++;
			continue;
		}
		const currentLineStart = lineOffsets[i];
		const currentLineEnd = currentLineStart + lines[i].length;
		// A standalone directive/placeholder is itself an HTML comment. Only an
		// enclosing inert region (a fence, outer comment, or raw-text element)
		// should suppress it.
		const lineInert = inertFor(i);
		const lineIsEnclosedInert = isRangeEnclosed(currentLineStart, currentLineEnd, lineInert);
		const directive = lineIsEnclosedInert ? undefined : parseDirective(lines[i]);
		if (directive) {
			const shortenedText = holdsShortened(i);
			if (directive.error) {
				warnings.push(directive.error);
				warningDetails.push({ message: directive.error, start: lineOffsets[i], end: lineOffsets[i] + lines[i].length });
				pendingInvalid = true;
				if (!shortenedText) pairedPendingInvalid = true;
			} else {
				pending = { ...pending, ...directive.format };
				if (!shortenedText) pairedPending = { ...pairedPending, ...directive.format };
			}
			if (shortenedText) shortenedPending = true;
			output.push(lines[i]);
			i++;
			continue;
		}
		const format = mergeFormat(documentFormat, pending);
		const error = validateTableNumberFormat(format);
		if (error) warnings.push(error);
		const detectionLine = maskedSourceRange(markdown, currentLineStart, currentLineEnd, lineInert);
		const opensHtmlTable = structuralIndex.openTableLines.has(i) || /^\s*<table\b/i.test(detectionLine);
		if (opensHtmlTable) {
			const candidateEnd = structuralIndex.openTableLines.has(i) ? structuralIndex.collectionEndByLine[i] : undefined;
			if (candidateEnd !== undefined) {
				const tableStart = lineOffsets[i];
				const lastLine = candidateEnd - 1;
				const tableEnd = lineOffsets[lastLine] + lines[lastLine].length;
				const table = formatFor(tableStart, 1, format, error);
				write(tableStart, tableEnd, table.skip ? markdown.slice(tableStart, tableEnd)
					: formatIndexedHtmlRange(markdown, tableStart, tableEnd, table.format, structuralIndex, codeRegions,
						warnings, warningDetails));
				if (table.error) recordHtmlError(table.error, tableStart, tableEnd);
				i = candidateEnd;
				resetPending();
				continue;
			}
			// If collection reaches EOF without balancing, commit only complete
			// tables that begin on this line and leave unmatched siblings untouched.
			const recoveryEnd = structuralIndex.recoveryEndByStartLine[i];
			if (recoveryEnd !== undefined) {
				const tableStart = lineOffsets[i];
				const lastLine = recoveryEnd - 1;
				const tableEnd = lineOffsets[lastLine] + lines[lastLine].length;
				const table = formatFor(tableStart, 1, format, error);
				write(tableStart, tableEnd, table.skip ? markdown.slice(tableStart, tableEnd)
					: formatIndexedHtmlRange(markdown, tableStart, tableEnd, table.format, structuralIndex, codeRegions,
						warnings, warningDetails));
				if (table.error) recordHtmlError(table.error, tableStart, tableEnd);
				i = recoveryEnd;
				resetPending();
				continue;
			}
		}
		if (lines[i].includes(GRID_TABLE_PLACEHOLDER_PREFIX) && !lineIsEnclosedInert) {
			const warningsBefore = warnings.length;
			const tableStart = lineOffsets[i];
			const table = formatFor(tableStart, 1, format, error);
			write(tableStart, tableStart + lines[i].length, formatGridPlaceholder(lines[i], table.skip ? {} : table.format, warnings));
			if (table.error) warningDetails.push({ message: table.error, start: tableStart, end: tableStart + lines[i].length });
			recordWarnings(warningsBefore, tableStart, tableStart + lines[i].length);
			resetPending();
			i++;
			continue;
		}
		let nextDetectionLine = lines[i + 1] ?? '';
		if (i + 1 < lines.length) {
			const nextStart = lineOffsets[i + 1];
			nextDetectionLine = maskedSourceRange(markdown, nextStart, nextStart + nextDetectionLine.length, inertFor(i + 1));
		}
		if (i + 1 < lines.length && detectionLine.includes('|') && isPipeSeparator(nextDetectionLine)) {
			const tableStart = lineOffsets[i];
			const warningsBefore = warnings.length;
			// And each row's its own, as a line after the table export writes,
			// before a blank line, can be a list item's text
			const table = formatFor(tableStart, 0, format, error);
			write(tableStart, tableStart + lines[i].length, formatPipeRow(lines[i], table.skip ? {} : table.format, warnings));
			output.push(lines[i + 1]);
			i += 2;
			while (i < lines.length && lines[i].trim() !== '') {
				if (/^ {4}/.test(lines[i])) break;
				const rowStart = lineOffsets[i];
				const rowDetection = maskedSourceRange(markdown, rowStart, rowStart + lines[i].length, inertFor(i));
				if (!rowDetection.includes('|')) break;
				const row = formatFor(rowStart, 0, format, error);
				write(rowStart, rowStart + lines[i].length, formatPipeRow(lines[i++], row.skip ? {} : row.format, warnings));
			}
			const tableEnd = lineOffsets[i - 1] + lines[i - 1].length;
			if (table.error) warningDetails.push({ message: table.error, start: tableStart, end: tableEnd });
			recordWarnings(warningsBefore, tableStart, tableEnd);
			resetPending();
			continue;
		}
		output.push(lines[i]);
		if (lines[i].trim() && !/^\s*<!--/.test(lines[i])) resetPending();
		i++;
	}
	return { output: output.join('\n'), warnings: [...new Set(warnings)], warningDetails, edits };
}
