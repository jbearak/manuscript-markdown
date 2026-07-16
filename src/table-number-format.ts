import { GRID_TABLE_PLACEHOLDER_PREFIX, type GridTableData } from './grid-table-preprocess';
import { extractHtmlTables, type HtmlTableCellSource } from './html-table-parser';
import { computeCodeRegions } from './code-regions';
import { decodeNumericHtmlEntity } from './html-entities';

export type TableDigits = number | 'source';
export type TableDecimalMark = 'source' | 'point' | 'comma' | 'midpoint';
export type TableDigitGrouping = 'source' | 'none' | 'comma' | 'period' | 'space' | 'thin-space';

export interface TableNumberFormat {
  digits?: TableDigits;
  decimalMark?: TableDecimalMark;
  digitGrouping?: TableDigitGrouping;
}

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
// Formatting expands each cell by this value, so an explicit bound prevents a
// malformed document setting from allocating an unbounded output string.
export const MAX_TABLE_DIGITS = 1000;

export function parseTableDigits(raw: string): TableDigits | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'source') return 'source';
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed <= MAX_TABLE_DIGITS) return parsed;
  }
  return undefined;
}

export function parseTableDecimalMark(raw: string): TableDecimalMark | undefined {
  const value = raw.trim().toLowerCase();
  return value === 'source' || value === 'point' || value === 'comma' || value === 'midpoint'
    ? value : undefined;
}

export function parseTableDigitGrouping(raw: string): TableDigitGrouping | undefined {
  const value = raw.trim().toLowerCase();
  return value === 'source' || value === 'none' || value === 'comma' || value === 'period'
    || value === 'space' || value === 'thin-space' ? value : undefined;
}

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

function formatHtmlTable(html: string, format: TableNumberFormat, warnings: string[]): string {
	const allTables = findHtmlElementRanges(scanHtmlSource(html), new Set(['table']));
	const tables = allTables.filter(table => !allTables.some(other => other !== table && other.start < table.start && other.end > table.end));
	let output = html;
	for (let index = tables.length - 1; index >= 0; index--) {
		const table = tables[index];
		output = output.slice(0, table.start) + formatHtmlTableTree(output.slice(table.start, table.end), format, warnings) + output.slice(table.end);
	}
	return output;
}

function formatHtmlTableTree(tableHtml: string, format: TableNumberFormat, warnings: string[]): string {
	const tables = findHtmlElementRanges(scanHtmlSource(tableHtml), new Set(['table']));
	const nested = tables.filter(table => table.start > 0);
	let output = tableHtml;
	for (let index = nested.length - 1; index >= 0; index--) {
		const table = nested[index];
		if (nested.some(other => other !== table && other.start < table.start && other.end > table.end)) continue;
		output = output.slice(0, table.start) + formatHtmlTableTree(output.slice(table.start, table.end), format, warnings) + output.slice(table.end);
	}
	return formatSingleHtmlTable(output, format, warnings);
}

function formatSingleHtmlTable(html: string, format: TableNumberFormat, warnings: string[]): string {
  const meta = extractHtmlTables(html)[0];
  if (!meta) return html;
  const tableFormat: Partial<TableNumberFormat> = { digits: meta.digits, decimalMark: meta.decimalMark, digitGrouping: meta.digitGrouping };
  const effective = mergeFormat(format, tableFormat);
  if (effective.digits === undefined && effective.decimalMark === undefined && effective.digitGrouping === undefined) return html;
  const error = validateTableNumberFormat(effective);
  if (error) {
    warnings.push(error);
    return html;
  }
	const sourceTokens = scanHtmlSource(html);
	const nestedTables = findHtmlElementRanges(sourceTokens, new Set(['table'])).filter(table => table.start > 0);
	const ranges = findHtmlElementRanges(sourceTokens, new Set(['td', 'th']))
		.filter(cell => !nestedTables.some(table => cell.start >= table.start && cell.end <= table.end));
	let output = html;
	for (let cellIndex = ranges.length - 1; cellIndex >= 0; cellIndex--) {
		const range = ranges[cellIndex];
		const opening = sourceTokens.find(token => token.start === range.start);
		const source = opening ? parseHtmlCellSource(opening.raw) : undefined;
		const content = output.slice(range.contentStart, range.contentEnd);
		const segments = htmlVisibleSegments(content);
		let changed = content;
		for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex--) {
			const segment = segments[segmentIndex];
			const formatted = segments.length === 1
				? formatTypedCell(source, segment.text, effective, warnings)
				: formatTextCell(segment.text, effective, warnings);
			if (formatted !== segment.text) changed = applyHtmlVisibleChange(changed, segment.text, formatted, segment.start);
		}
		output = output.slice(0, range.contentStart) + changed + output.slice(range.contentEnd);
	}
	return output;
}

function parseHtmlCellSource(openingTag: string): HtmlTableCellSource | undefined {
	const attr = (name: string): string | undefined => {
		const match = openingTag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\\\'([^\\\']*)\\\'|([^\\s>]+))', 'i'));
		return match ? decodeHtmlText(match[1] ?? match[2] ?? match[3]) : undefined;
	};
	const kind = attr('data-mm-kind') as HtmlTableCellSource['kind'] | undefined;
	const valid = ['text', 'number', 'percent', 'scientific', 'currency', 'date', 'time', 'boolean', 'identifier', 'label', 'missing'];
	if (!kind || !valid.includes(kind)) return undefined;
	const rawText = attr('data-mm-raw');
	const rawValue = rawText === undefined ? undefined : Number(rawText);
	return { kind, display: '', ...(rawValue !== undefined && Number.isFinite(rawValue) ? { rawValue } : {}),
		...(attr('data-mm-format') ? { sourceFormat: attr('data-mm-format') } : {}) };
}

const HTML_NUMERIC_BOUNDARIES = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'code', 'div', 'dl', 'fieldset',
	'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
	'script', 'section', 'style', 'sub', 'sup', 'table', 'template', 'textarea', 'ul']);
const HTML_NUMERIC_INERT = new Set(['code', 'pre', 'script', 'style', 'sub', 'sup', 'table', 'template', 'textarea']);

function htmlVisibleSegments(html: string): Array<{ start: number; text: string }> {
	const segments: Array<{ start: number; text: string }> = [];
	let visibleOffset = 0;
	let segmentStart = 0;
	let text = '';
	let inertDepth = 0;
	const flush = () => {
		if (text) segments.push({ start: segmentStart, text });
		text = '';
		segmentStart = visibleOffset;
	};
	for (const token of scanHtmlSource(html)) {
		if (token.tag) {
			if (token.name && HTML_NUMERIC_BOUNDARIES.has(token.name)) flush();
			if (token.name && HTML_NUMERIC_INERT.has(token.name)) inertDepth += token.closing ? -1 : 1;
			continue;
		}
		const decoded = decodeHtmlText(token.raw);
		if (inertDepth === 0) {
			if (!text) segmentStart = visibleOffset;
			text += decoded;
		}
		visibleOffset += decoded.length;
	}
	flush();
	return segments;
}

function applyHtmlVisibleChange(content: string, visible: string, formatted: string, baseOffset: number): string {
	const beforeTokens = [...visible.matchAll(NUMERIC_TOKEN_RE)];
	const afterTokens = [...formatted.matchAll(NUMERIC_TOKEN_RE)];
	let changed = content;
	if (beforeTokens.length === afterTokens.length
		&& visible.replace(NUMERIC_TOKEN_RE, '') === formatted.replace(NUMERIC_TOKEN_RE, '')) {
		for (let index = beforeTokens.length - 1; index >= 0; index--) {
			const beforeToken = beforeTokens[index];
			const afterToken = afterTokens[index][0];
			if (beforeToken[0] === afterToken) continue;
			const edits = diffCharacterEdits(beforeToken[0], afterToken);
			for (let editIndex = edits.length - 1; editIndex >= 0; editIndex--) {
				const edit = edits[editIndex];
				const start = baseOffset + (beforeToken.index ?? 0) + edit.start;
				changed = replaceHtmlVisibleRange(changed, start, start + edit.deleteCount, edit.insert);
			}
		}
		return changed;
	}
	let prefix = 0;
	while (prefix < visible.length && prefix < formatted.length && visible[prefix] === formatted[prefix]) prefix++;
	let suffix = 0;
	while (suffix < visible.length - prefix && suffix < formatted.length - prefix
		&& visible[visible.length - 1 - suffix] === formatted[formatted.length - 1 - suffix]) suffix++;
	return replaceHtmlVisibleRange(changed, baseOffset + prefix, baseOffset + visible.length - suffix,
		formatted.slice(prefix, formatted.length - suffix));
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

function scanHtmlSource(html: string): HtmlSourceToken[] {
	const tokens: HtmlSourceToken[] = [];
	let cursor = 0;
	let rawTextName: string | undefined;
	while (cursor < html.length) {
		if (rawTextName) {
			const lowerHtml = html.toLowerCase();
			let closeStart = lowerHtml.indexOf('</' + rawTextName, cursor);
			while (closeStart >= 0) {
				const boundary = lowerHtml[closeStart + rawTextName.length + 2] ?? '';
				if (!boundary || /[\s/>]/.test(boundary)) break;
				closeStart = lowerHtml.indexOf('</' + rawTextName, closeStart + rawTextName.length + 2);
			}
			if (closeStart < 0) {
				tokens.push({ raw: html.slice(cursor), tag: false, start: cursor, end: html.length });
				break;
			}
			if (closeStart > cursor) tokens.push({ raw: html.slice(cursor, closeStart), tag: false, start: cursor, end: closeStart });
			cursor = closeStart;
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
			tokens.push({ raw: html.slice(tagStart), tag: false, start: tagStart, end: html.length });
			break;
		}
		const raw = html.slice(tagStart, end);
		let inner = raw.slice(1, -1).trim();
		const closing = inner.startsWith('/');
		if (closing) inner = inner.slice(1).trimStart();
		let nameEnd = 0;
		while (nameEnd < inner.length && /[A-Za-z0-9:-]/.test(inner[nameEnd])) nameEnd++;
		const name = inner.slice(0, nameEnd).toLowerCase() || undefined;
		tokens.push({ raw, tag: true, name, closing, selfClosing: /\/\s*>$/.test(raw), start: tagStart, end });
		if (!closing && name && ['script', 'style', 'template', 'textarea'].includes(name)) rawTextName = name;
		cursor = end;
	}
	return tokens;
}

function computeHtmlInertRegions(html: string, codeRegions: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	let masked = '';
	let cursor = 0;
	for (const region of codeRegions) {
		masked += html.slice(cursor, region.start) + ' '.repeat(region.end - region.start);
		cursor = region.end;
	}
	masked += html.slice(cursor);
	const regions: Array<{ start: number; end: number }> = [];
	const rawStarts = new Map<string, number>();
	for (const token of scanHtmlSource(masked)) {
		if (token.tag && token.raw.startsWith('<!--')) regions.push({ start: token.start, end: token.end });
		if (!token.name || !['script', 'style', 'template', 'textarea'].includes(token.name)) continue;
		if (!token.closing) rawStarts.set(token.name, token.start);
		else {
			const start = rawStarts.get(token.name);
			if (start !== undefined) regions.push({ start, end: token.end });
			rawStarts.delete(token.name);
		}
	}
	for (const start of rawStarts.values()) regions.push({ start, end: html.length });
	return regions;
}

function findHtmlElementRanges(tokens: HtmlSourceToken[], names: Set<string>): Array<{ start: number; end: number; contentStart: number; contentEnd: number }> {
	const stacks = new Map<string, HtmlSourceToken[]>();
	const ranges: Array<{ start: number; end: number; contentStart: number; contentEnd: number }> = [];
	for (const token of tokens) {
		if (!token.name || !names.has(token.name) || token.selfClosing) continue;
		const stack = stacks.get(token.name) ?? [];
		if (!token.closing) {
			stack.push(token);
			stacks.set(token.name, stack);
		} else {
			const open = stack.pop();
			if (open) ranges.push({ start: open.start, end: token.end, contentStart: open.end, contentEnd: token.start });
		}
	}
	return ranges.sort((a, b) => a.start - b.start);
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

function rawOffsetAtDecodedOffset(raw: string, target: number): number {
	if (target <= 0) return 0;
	let decodedLength = 0;
	const tokenRe = /&(?:#\d+|#x[0-9a-f]+|nbsp|lt|gt|quot|apos|amp);|[\s\S]/gi;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(raw)) !== null) {
		decodedLength += decodeHtmlText(match[0]).length;
		if (decodedLength >= target) return tokenRe.lastIndex;
	}
	return raw.length;
}

function encodeHtmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function replaceDecodedRange(raw: string, start: number, end: number, replacement: string): string {
	const rawStart = rawOffsetAtDecodedOffset(raw, start);
	const rawEnd = rawOffsetAtDecodedOffset(raw, end);
	return raw.slice(0, rawStart) + encodeHtmlText(replacement) + raw.slice(rawEnd);
}

function replaceHtmlVisibleRange(html: string, startOffset: number, endOffset: number, replacement: string): string {
	const tokens = scanHtmlSource(html);
	let visibleOffset = 0;
	const affected: Array<{ index: number; start: number; end: number }> = [];
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].tag) continue;
		const length = decodeHtmlText(tokens[index].raw).length;
		const start = Math.max(0, startOffset - visibleOffset);
		const end = Math.min(length, endOffset - visibleOffset);
		if (end > start || (startOffset === endOffset && startOffset >= visibleOffset && startOffset <= visibleOffset + length)) {
			affected.push({ index, start, end });
			if (startOffset === endOffset) break;
		}
		visibleOffset += length;
	}
	let replacementOffset = 0;
	for (let i = 0; i < affected.length; i++) {
		const item = affected[i];
		const oldLength = item.end - item.start;
		const take = i === affected.length - 1 ? replacement.length - replacementOffset : Math.min(oldLength, replacement.length - replacementOffset);
		const part = replacement.slice(replacementOffset, replacementOffset + take);
		tokens[item.index].raw = replaceDecodedRange(tokens[item.index].raw, item.start, item.end, part);
		replacementOffset += take;
	}
	return tokens.map(token => token.raw).join('');
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

/** Apply document and per-table numeric formatting without modifying any embedded source file. */
export function formatTableNumbers(markdown: string, documentFormat: TableNumberFormat = {}): TableNumberFormatResult {
  const warnings: string[] = [];
  const warningDetails: TableNumberFormatWarning[] = [];
  const documentError = validateTableNumberFormat(documentFormat);
  if (documentError) warnings.push(documentError);
  const lines = markdown.split('\n');
	const codeRegions = computeCodeRegions(markdown);
	const inertRegions = [...codeRegions, ...computeHtmlInertRegions(markdown, codeRegions)];
	const lineOffsets: number[] = [];
	let nextLineOffset = 0;
  for (const line of lines) { lineOffsets.push(nextLineOffset); nextLineOffset += line.length + 1; }
  const recordWarnings = (from: number, start: number, end: number) => {
    for (const message of warnings.slice(from)) warningDetails.push({ message, start, end });
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
    const lineIsEnclosedInert = inertRegions.some(region => currentLineStart < region.end && currentLineEnd > region.start
      && (region.start < currentLineStart || region.end > currentLineEnd));
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
		let detectionLine = lines[i];
		const lineStart = lineOffsets[i];
		for (const region of inertRegions) {
			const start = Math.max(0, region.start - lineStart);
			const end = Math.min(detectionLine.length, region.end - lineStart);
			if (end > start) detectionLine = detectionLine.slice(0, start) + ' '.repeat(end - start) + detectionLine.slice(end);
		}
		const lineTokens = scanHtmlSource(detectionLine);
		const opensHtmlTable = lineTokens.some(token => token.tag && token.name === 'table' && !token.closing)
				|| /^\s*<table\b/i.test(detectionLine);
		if (opensHtmlTable) {
      const tableStart = lineOffsets[i];
      const warningsBefore = warnings.length;
      const block: string[] = [];
			let tableDepth = 0;
			let foundOpening = false;
			do {
				block.push(lines[i++]);
				tableDepth = 0;
				foundOpening = false;
				for (const token of scanHtmlSource(block.join('\n'))) {
					if (token.tag && token.name === 'table' && !token.selfClosing) {
						if (!token.closing) foundOpening = true;
						tableDepth += token.closing ? -1 : 1;
					}
				}
			} while (i < lines.length && (!foundOpening || tableDepth > 0));
      const tableBlock = block.join('\n');
      output.push(pendingInvalid || error ? tableBlock : formatHtmlTable(tableBlock, format, warnings));
      if (error) warningDetails.push({ message: error, start: tableStart, end: tableStart + tableBlock.length });
      recordWarnings(warningsBefore, tableStart, tableStart + tableBlock.length);
      pending = {};
      pendingInvalid = false;
      continue;
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
			for (const region of inertRegions) {
				const start = Math.max(0, region.start - nextStart);
				const end = Math.min(nextDetectionLine.length, region.end - nextStart);
				if (end > start) nextDetectionLine = nextDetectionLine.slice(0, start) + ' '.repeat(end - start) + nextDetectionLine.slice(end);
			}
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
