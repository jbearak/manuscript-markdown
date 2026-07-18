/**
 * Pure helper functions for YAML frontmatter language features.
 * Follows the pattern of csl-language.ts and comment-language.ts.
 *
 * A single declarative schema drives completions, hover, diagnostics,
 * and typo detection. No LSP types — returns offsets; server converts.
 */

import { normalizeFontStyle, parseColWidths } from '../frontmatter';
import { MAX_TABLE_DIGITS } from '../table-number-format';
import { getCslFieldInfo } from './csl-language';
import { BUNDLED_STYLE_LABELS } from '../csl-loader';

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

type FieldKind =
	| 'free-text'        // title, author, locale — no value completions, no validation
	| 'boolean'          // breaks, bibliography-hanging-indent
	| 'enum'             // blockquote-style, colors, table-borders, notes, zotero-notes
	| 'number'           // font-size, code-font-size, etc.
	| 'digits'           // source or a non-negative integer
	| 'font'             // font, code-font, table-font
	| 'code-font'        // code-font specifically (mono fonts)
	| 'font-style'       // header-font-style, title-font-style
	| 'line-spacing'     // single|1.5|double|number
	| 'paragraph-indent' // none|number
	| 'col-widths'       // equal|auto|numeric ratios
	| 'color-hex'        // code-background-color (6-digit hex, none, transparent)
	| 'color-hex-only'   // code-font-color (6-digit hex only)
	| 'timezone'         // +HH:MM / -HH:MM
	| 'bib-path'         // bibliography — file existence check
	| 'csl'              // special: CSL style name (delegates to csl-language)
	| 'styles-block';    // the styles: key itself

interface FieldDef {
	/** Canonical YAML key name */
	key: string;
	kind: FieldKind;
	/** Hover description */
	description: string;
	/** Alternate YAML key names */
	aliases?: string[];
	/** For kind='enum' */
	enumValues?: readonly EnumValue[];
	/** true only for 'title' (duplicate key allowed) */
	allowsMultiple?: boolean;
	/** Whether the value is a YAML inline array */
	arrayField?: boolean;
}

interface EnumValue {
	value: string;
	description?: string;
}

// ---------------------------------------------------------------------------
// Font lists (platform-specific)
// ---------------------------------------------------------------------------

const MACOS_BODY_FONTS = [
	'Georgia', 'Times New Roman', 'Palatino', 'Baskerville',
	'Helvetica Neue', 'Optima', 'Garamond',
];
const MACOS_MONO_FONTS = [
	'SF Mono', 'Menlo', 'Monaco', 'Courier New', 'Fira Code', 'JetBrains Mono',
];
const WINDOWS_BODY_FONTS = [
	'Cambria', 'Calibri', 'Times New Roman', 'Georgia',
	'Garamond', 'Book Antiqua', 'Palatino Linotype',
];
const WINDOWS_MONO_FONTS = [
	'Consolas', 'Courier New', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Lucida Console',
];
const LINUX_BODY_FONTS = [
	'DejaVu Serif', 'Liberation Serif', 'Times New Roman', 'Georgia', 'FreeSerif',
];
const LINUX_MONO_FONTS = [
	'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', 'Fira Code', 'JetBrains Mono',
];

function getBodyFonts(platform: string): string[] {
	if (platform === 'darwin') return MACOS_BODY_FONTS;
	if (platform === 'win32') return WINDOWS_BODY_FONTS;
	return LINUX_BODY_FONTS;
}

function getMonoFonts(platform: string): string[] {
	if (platform === 'darwin') return MACOS_MONO_FONTS;
	if (platform === 'win32') return WINDOWS_MONO_FONTS;
	return LINUX_MONO_FONTS;
}

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const BOOLEAN_VALUES: readonly EnumValue[] = [
	{ value: 'true' },
	{ value: 'false' },
];

const NOTES_VALUES: readonly EnumValue[] = [
	{ value: 'footnotes', description: 'Output notes as footnotes' },
	{ value: 'endnotes', description: 'Output notes as endnotes' },
];

const ZOTERO_NOTES_VALUES: readonly EnumValue[] = [
	{ value: 'in-text', description: 'Inline citations (default)' },
	{ value: 'footnotes', description: 'Footnote-style citations' },
	{ value: 'endnotes', description: 'Endnote-style citations' },
];

const TABLE_BORDERS_VALUES: readonly EnumValue[] = [
	{ value: 'horizontal', description: 'Top, bottom, and header-row borders only' },
	{ value: 'solid', description: 'Full grid borders' },
	{ value: 'none', description: 'No table borders' },
];

const TABLE_DECIMAL_MARK_VALUES: readonly EnumValue[] = [
	{ value: 'source' }, { value: 'point' }, { value: 'comma' }, { value: 'midpoint' },
];

const TABLE_DIGIT_GROUPING_VALUES: readonly EnumValue[] = [
	{ value: 'source' }, { value: 'none' }, { value: 'comma' }, { value: 'period' },
	{ value: 'space' }, { value: 'thin-space' },
];

const BLOCKQUOTE_STYLE_VALUES: readonly EnumValue[] = [
	{ value: 'Quote', description: 'Word "Quote" paragraph style' },
	{ value: 'IntenseQuote', description: 'Word "Intense Quote" paragraph style' },
	{ value: 'GitHub', description: 'Left-border blockquote (GitHub style)' },
];

const COLORS_VALUES: readonly EnumValue[] = [
	{ value: 'github', description: 'GitHub-style color scheme' },
	{ value: 'guttmacher', description: 'Guttmacher Institute color scheme' },
];

const LINE_SPACING_VALUES: readonly EnumValue[] = [
	{ value: 'single', description: 'Single (1x) line spacing' },
	{ value: '1.5', description: '1.5x line spacing' },
	{ value: 'double', description: 'Double (2x) line spacing' },
];

const PARAGRAPH_INDENT_VALUES: readonly EnumValue[] = [
	{ value: 'none', description: 'No first-line indent' },
];

const COL_WIDTHS_VALUES: readonly EnumValue[] = [
	{ value: 'equal', description: 'Equal column widths' },
	{ value: 'auto', description: 'Automatic column widths' },
];

const COLOR_HEX_SPECIAL_VALUES: readonly EnumValue[] = [
	{ value: 'none', description: 'Remove background color' },
	{ value: 'transparent', description: 'Transparent background' },
];

const FONT_STYLE_PARTS: readonly EnumValue[] = [
	{ value: 'bold' },
	{ value: 'italic' },
	{ value: 'underline' },
	{ value: 'smallcaps' },
	{ value: 'allcaps' },
	{ value: 'center' },
	{ value: 'normal', description: 'Reset to default style' },
	{ value: 'bold-italic' },
	{ value: 'bold-center' },
];

export const FRONTMATTER_SCHEMA: readonly FieldDef[] = [
	{ key: 'title', kind: 'free-text', allowsMultiple: true,
		description: 'Document title. Repeat the key for subtitle lines.\n\n**Accepted values:** Any string. Multiple `title:` lines are allowed.' },
	{ key: 'author', kind: 'free-text',
		description: 'Author name(s).\n\n**Accepted values:** Any string.' },
	{ key: 'csl', kind: 'csl',
		description: 'Citation Style Language style for bibliography formatting.\n\n**Accepted values:** A style name (e.g. `apa`, `chicago-author-date`, `nature`) or a path to a `.csl` file. Non-bundled style names are downloaded automatically.' },
	{ key: 'locale', kind: 'free-text',
		description: 'BCP 47 locale tag for citation language.\n\n**Accepted values:** Any valid BCP 47 locale tag (e.g. `en-US`, `de-DE`).' },
	{ key: 'zotero-notes', kind: 'enum', aliases: ['note-type'], enumValues: ZOTERO_NOTES_VALUES,
		description: 'Controls how Zotero-inserted citations are formatted.\n\n**Accepted values:** `in-text`, `footnotes`, `endnotes`.' },
	{ key: 'notes', kind: 'enum', enumValues: NOTES_VALUES,
		description: 'Whether document footnotes are rendered as footnotes or collected as endnotes.\n\n**Accepted values:** `footnotes`, `endnotes`.' },
	{ key: 'timezone', kind: 'timezone',
		description: 'UTC offset applied when rendering date fields.\n\n**Accepted values:** `+HH:MM` or `-HH:MM` format (e.g. `+05:30`, `-05:00`).' },
	{ key: 'bibliography', kind: 'bib-path', aliases: ['bib', 'bibtex'],
		description: 'Path to the BibTeX bibliography file.\n\n**Accepted values:** Relative or absolute path to a `.bib` file.' },
	{ key: 'font', kind: 'font',
		description: 'Body text font family.\n\n**Accepted values:** Font family name (e.g. `Georgia`, `Times New Roman`).' },
	{ key: 'code-font', kind: 'code-font',
		description: 'Monospace font for code blocks and inline code.\n\n**Accepted values:** Monospace font family name (e.g. `Fira Code`, `Consolas`).' },
	{ key: 'font-size', kind: 'number',
		description: 'Body text font size in points.\n\n**Accepted values:** Positive number (e.g. `12`).' },
	{ key: 'code-font-size', kind: 'number',
		description: 'Font size for code blocks and inline code, in points.\n\n**Accepted values:** Positive number (e.g. `10`).' },
	{ key: 'header-font', kind: 'font', arrayField: true,
		description: 'Font family for heading levels H1\u2013H6. Accepts a single font or an inline array.\n\n**Accepted values:** Font name, or `[H1font, H2font, ...]`.' },
	{ key: 'header-font-size', kind: 'number', arrayField: true,
		description: 'Font size(s) for headings in points.\n\n**Accepted values:** Positive number, or `[24, 20, 16, ...]`.' },
	{ key: 'header-font-style', kind: 'font-style', arrayField: true,
		description: 'Font style(s) for headings.\n\n**Accepted values:** `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal` \u2014 combine with `-` (e.g. `bold-italic`). `smallcaps` and `allcaps` are mutually exclusive.' },
	{ key: 'title-font', kind: 'font', arrayField: true,
		description: 'Font family for the document title block.\n\n**Accepted values:** Font name, or inline array for per-title-line overrides.' },
	{ key: 'title-font-size', kind: 'number', arrayField: true,
		description: 'Font size(s) for the title block in points.\n\n**Accepted values:** Positive number, or `[28, 24]`.' },
	{ key: 'title-font-style', kind: 'font-style', arrayField: true,
		description: 'Font style for the title block.\n\n**Accepted values:** `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal` \u2014 combine with `-` (e.g. `bold-italic`). `smallcaps` and `allcaps` are mutually exclusive.' },
	{ key: 'table-font', kind: 'font',
		description: 'Font family for table cell content.\n\n**Accepted values:** Font family name.' },
	{ key: 'table-font-size', kind: 'number',
		description: 'Font size for table cell content in points.\n\n**Accepted values:** Positive number.' },
	{ key: 'table-col-widths', kind: 'col-widths', enumValues: COL_WIDTHS_VALUES,
		description: 'Column width ratios for tables.\n\n**Accepted values:** `equal`, `auto`, space/comma-separated ratios (e.g. `2 1 1`), or `[2, 1, 1]` inline array.' },
	{ key: 'table-borders', kind: 'enum', enumValues: TABLE_BORDERS_VALUES,
		description: 'Border style applied to all tables.\n\n**Accepted values:** `horizontal`, `solid`, `none`.' },
	{ key: 'table-digits', kind: 'digits',
		description: 'Digits after the decimal mark in table numbers.\n\n**Accepted values:** `source` or an integer from 0 to 1000.' },
	{ key: 'table-decimal-mark', kind: 'enum', enumValues: TABLE_DECIMAL_MARK_VALUES,
		description: 'Decimal mark for table numbers.\n\n**Accepted values:** `source`, `point`, `comma`, `midpoint`.' },
	{ key: 'table-digit-grouping', kind: 'enum', enumValues: TABLE_DIGIT_GROUPING_VALUES,
		description: 'Digit grouping for table numbers.\n\n**Accepted values:** `source`, `none`, `comma`, `period`, `space`, `thin-space`.' },
	{ key: 'code-background-color', kind: 'color-hex', aliases: ['code-background'], enumValues: COLOR_HEX_SPECIAL_VALUES,
		description: 'Background color for code blocks.\n\n**Accepted values:** 6-digit hex without `#` (e.g. `F0F0F0`), `none`, or `transparent`.' },
	{ key: 'code-font-color', kind: 'color-hex-only', aliases: ['code-color'],
		description: 'Text color for code blocks.\n\n**Accepted values:** 6-digit hex without `#` (e.g. `333333`).' },
	{ key: 'code-block-inset', kind: 'number',
		description: 'Code-block shading border width, in eighths of a point.\n\n**Accepted values:** Positive integer.' },
	{ key: 'pipe-table-max-line-width', kind: 'number',
		description: 'Maximum source line width for pipe tables before switching to HTML. `0` always uses HTML.\n\n**Accepted values:** Non-negative integer.' },
	{ key: 'grid-table-max-line-width', kind: 'number',
		description: 'Maximum source line width for grid tables.\n\n**Accepted values:** Non-negative integer.' },
	{ key: 'blockquote-style', kind: 'enum', enumValues: BLOCKQUOTE_STYLE_VALUES,
		description: 'Paragraph style applied to blockquotes.\n\n**Accepted values:** `Quote`, `IntenseQuote`, `GitHub` (case-insensitive).' },
	{ key: 'colors', kind: 'enum', enumValues: COLORS_VALUES,
		description: 'Named color scheme for alert/callout borders.\n\n**Accepted values:** `github`, `guttmacher`.' },
	{ key: 'styles', kind: 'styles-block',
		description: 'Named custom paragraph styles. Each sub-key is a style name; under it, set `font`, `font-size`, `font-style`, `spacing-before`, `spacing-after`, `paragraph-indent`.\n\n**Accepted values:** Nested YAML block.' },
	{ key: 'breaks', kind: 'boolean', enumValues: BOOLEAN_VALUES,
		description: 'Whether to render hard line breaks (newlines in source become `<br>`).\n\n**Accepted values:** `true`, `false`.' },
	{ key: 'line-spacing', kind: 'line-spacing', enumValues: LINE_SPACING_VALUES,
		description: 'Line spacing for body text.\n\n**Accepted values:** `single`, `1.5`, `double`, or a positive numeric multiplier.' },
	{ key: 'paragraph-indent', kind: 'paragraph-indent', enumValues: PARAGRAPH_INDENT_VALUES,
		description: 'First-line paragraph indent in inches.\n\n**Accepted values:** Non-negative number (inches) or `none`.' },
	{ key: 'bibliography-hanging-indent', kind: 'boolean', enumValues: BOOLEAN_VALUES,
		description: 'Whether bibliography entries use a hanging indent.\n\n**Accepted values:** `true`, `false`.' },
];

export const STYLES_SUB_PROPS: readonly FieldDef[] = [
	{ key: 'font', kind: 'font',
		description: 'Font family for this style.\n\n**Accepted values:** Font family name.' },
	{ key: 'font-size', kind: 'number',
		description: 'Font size in points.\n\n**Accepted values:** Positive number.' },
	{ key: 'font-style', kind: 'font-style',
		description: 'Font style.\n\n**Accepted values:** `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal` \u2014 combine with `-` (e.g. `bold-italic`).' },
	{ key: 'spacing-before', kind: 'number',
		description: 'Space before paragraph in points.\n\n**Accepted values:** Non-negative number.' },
	{ key: 'spacing-after', kind: 'number',
		description: 'Space after paragraph in points.\n\n**Accepted values:** Non-negative number.' },
	{ key: 'paragraph-indent', kind: 'paragraph-indent', enumValues: PARAGRAPH_INDENT_VALUES,
		description: 'First-line indent in inches, or `none` for explicit zero.\n\n**Accepted values:** Non-negative number or `none`.' },
];

// ---------------------------------------------------------------------------
// Schema index (built once at module load)
// ---------------------------------------------------------------------------

/** Map from canonical key → FieldDef */
const SCHEMA_MAP = new Map<string, FieldDef>();
/** Map from alias → canonical key */
const ALIAS_TO_CANONICAL = new Map<string, string>();
/** All recognized keys (canonical + aliases) */
const ALL_KNOWN_KEYS = new Set<string>();

for (const def of FRONTMATTER_SCHEMA) {
	SCHEMA_MAP.set(def.key, def);
	ALL_KNOWN_KEYS.add(def.key);
	if (def.aliases) {
		for (const alias of def.aliases) {
			ALIAS_TO_CANONICAL.set(alias, def.key);
			ALL_KNOWN_KEYS.add(alias);
		}
	}
}

const STYLES_SUB_MAP = new Map<string, FieldDef>();
for (const def of STYLES_SUB_PROPS) {
	STYLES_SUB_MAP.set(def.key, def);
}

function resolveCanonical(key: string): string {
	return ALIAS_TO_CANONICAL.get(key) ?? key;
}

function lookupDef(key: string): FieldDef | undefined {
	return SCHEMA_MAP.get(resolveCanonical(key));
}

/** Check if a lowercased key matches a known key or alias (case mismatch). Returns the canonical key. */
function findCaseMatch(lowerKey: string): string | undefined {
	for (const def of FRONTMATTER_SCHEMA) {
		if (def.key === lowerKey) return def.key;
		if (def.aliases) {
			for (const alias of def.aliases) {
				if (alias === lowerKey) return def.key;
			}
		}
	}
	return undefined;
}

/** Check if a lowercased key matches a styles sub-property (case mismatch). */
function findStylesCaseMatch(lowerKey: string): string | undefined {
	for (const def of STYLES_SUB_PROPS) {
		if (def.key === lowerKey) return def.key;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Damerau-Levenshtein distance
// ---------------------------------------------------------------------------

export function damerauLevenshtein(a: string, b: string): number {
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;
	if (a === b) return 0;

	// Optimal string alignment distance (restricted edit distance)
	// Handles: insertion, deletion, substitution, adjacent transposition
	const d: number[][] = [];
	for (let i = 0; i <= la; i++) {
		d[i] = [];
		for (let j = 0; j <= lb; j++) {
			d[i][j] = 0;
		}
	}
	for (let i = 0; i <= la; i++) d[i][0] = i;
	for (let j = 0; j <= lb; j++) d[0][j] = j;

	for (let i = 1; i <= la; i++) {
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(
				d[i - 1][j] + 1,      // deletion
				d[i][j - 1] + 1,      // insertion
				d[i - 1][j - 1] + cost // substitution
			);
			// Transposition
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[la][lb];
}

/**
 * Given an unknown key, find typo suggestions from the schema.
 * Returns canonical key names only (never aliases).
 * Uses scaled threshold: max 1 for keys <=5 chars, max 2 for >5 chars.
 */
export function findTypoSuggestions(unknownKey: string): string[] {
	const maxDist = unknownKey.length <= 5 ? 1 : 2;
	const lower = unknownKey.toLowerCase();

	let bestDist = maxDist + 1;
	const candidates: Array<{ canonical: string; dist: number }> = [];

	// Check all canonical keys
	for (const def of FRONTMATTER_SCHEMA) {
		const dist = damerauLevenshtein(lower, def.key.toLowerCase());
		if (dist > 0 && dist <= maxDist && dist < bestDist) {
			bestDist = dist;
			candidates.length = 0;
			candidates.push({ canonical: def.key, dist });
		} else if (dist > 0 && dist <= maxDist && dist === bestDist) {
			candidates.push({ canonical: def.key, dist });
		}
	}

	// Check aliases — but resolve to canonical for suggestion
	for (const [alias, canonical] of ALIAS_TO_CANONICAL) {
		const dist = damerauLevenshtein(lower, alias.toLowerCase());
		if (dist > 0 && dist <= maxDist && dist < bestDist) {
			bestDist = dist;
			candidates.length = 0;
			candidates.push({ canonical, dist });
		} else if (dist > 0 && dist <= maxDist && dist === bestDist) {
			// Only add if canonical not already present
			if (!candidates.some(c => c.canonical === canonical)) {
				candidates.push({ canonical, dist });
			}
		}
	}

	return candidates.map(c => c.canonical);
}

/**
 * Find typo suggestions for a styles sub-property key.
 */
function findStylesTypoSuggestions(unknownKey: string): string[] {
	const maxDist = unknownKey.length <= 5 ? 1 : 2;
	const lower = unknownKey.toLowerCase();

	let bestDist = maxDist + 1;
	const candidates: Array<{ key: string; dist: number }> = [];

	for (const def of STYLES_SUB_PROPS) {
		const dist = damerauLevenshtein(lower, def.key.toLowerCase());
		if (dist > 0 && dist <= maxDist && dist < bestDist) {
			bestDist = dist;
			candidates.length = 0;
			candidates.push({ key: def.key, dist });
		} else if (dist > 0 && dist <= maxDist && dist === bestDist) {
			candidates.push({ key: def.key, dist });
		}
	}

	return candidates.map(c => c.key);
}

// ---------------------------------------------------------------------------
// Frontmatter line scanner (offset-aware)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?=\r?\n|$)/;

interface FmLine {
	/** Raw key name (left of colon) */
	key: string;
	/** Trimmed value string (right of colon, stripped of quotes) */
	rawValue: string;
	/** Character offset of the key text start */
	keyStart: number;
	/** Character offset past the key text end */
	keyEnd: number;
	/** Character offset of the value start (first non-space after colon) */
	valueStart: number;
	/** Character offset of the value end (before \r\n) */
	valueEnd: number;
	/** Matching quote pair stripped from the value completion range */
	valueQuote?: '"' | "'";
	/** Indentation level (number of leading spaces) */
	indent: number;
	/** Whether this line is inside the styles: block */
	inStylesBlock: boolean;
	/** For styles sub-properties: the style name this property belongs to */
	styleName?: string;
	/** Depth: 0 = top-level, 1 = style name, 2 = sub-property */
	stylesDepth?: number;
}

interface ParsedFrontmatter {
	lines: FmLine[];
	fmStart: number;   // offset of opening ---
	fmEnd: number;     // offset past closing ---
	bodyStart: number;  // offset of first line after opening ---
	closed: boolean;
}

function parseFrontmatterLines(text: string, allowUnclosed = false): ParsedFrontmatter | undefined {
	const fmMatch = FRONTMATTER_RE.exec(text);
	const unclosedMatch = allowUnclosed && !fmMatch ? /^---\r?\n/.exec(text) : undefined;
	if (!fmMatch && !unclosedMatch) return undefined;

	const fmStart = 0;
	const fmEnd = fmMatch ? fmMatch[0].length : text.length;
	const firstNewline = text.indexOf('\n', fmStart);
	if (firstNewline === -1) return undefined;
	const bodyStart = firstNewline + 1;

	const fmBody = fmMatch ? (fmMatch[1] ?? '') : text.slice(bodyStart);
	const rawLines = fmBody.split('\n');
	const lines: FmLine[] = [];

	let pos = bodyStart;
	let inStylesBlock = false;
	let stylesNameIndent = -1;
	let currentStyleName: string | undefined;

	for (const rawLine of rawLines) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		const lineStart = pos;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trimStart();
		const colonIdx = trimmed.indexOf(':');

		// YAML comments do not establish mapping depth or leave a styles block.
		if (trimmed.startsWith('#')) {
			pos += rawLine.length + 1;
			continue;
		}

		if (colonIdx >= 0) {
			const key = trimmed.slice(0, colonIdx).trim();
			const afterColon = trimmed.slice(colonIdx + 1);
			const valueRaw = afterColon.trim().replace(/^["']|["']$/g, '');

			// Compute offsets: keyStart is position of first non-space char
			const keyStart = lineStart + indent;
			const keyEnd = keyStart + key.length;

			// valueStart: offset of first non-space char after colon
			const colonOffset = keyStart + colonIdx;
			const afterColonStr = text.slice(colonOffset + 1, lineStart + line.length);
			const leadingSpaces = afterColonStr.match(/^\s*/)?.[0].length ?? 0;
			let valueStart = colonOffset + 1 + leadingSpaces;
			let valueEnd = lineStart + line.length;
			let valueQuote: '"' | "'" | undefined;

			// Strip quotes from value range (not just the string)
			const rawValueSlice = text.slice(valueStart, valueEnd);
			if ((rawValueSlice.startsWith('"') && rawValueSlice.endsWith('"')) ||
				(rawValueSlice.startsWith("'") && rawValueSlice.endsWith("'"))) {
				valueQuote = rawValueSlice[0] as '"' | "'";
				valueStart += 1;
				valueEnd -= 1;
			}

			// Track styles block
			if (indent === 0) {
				if (key === 'styles') {
					inStylesBlock = true;
					stylesNameIndent = -1;
					currentStyleName = undefined;
				} else {
					inStylesBlock = false;
					currentStyleName = undefined;
				}
			}

			let stylesDepth: number | undefined;
			let lineInStylesBlock = false;
			let lineStyleName: string | undefined;

			if (inStylesBlock && indent > 0) {
				lineInStylesBlock = true;
				if (stylesNameIndent < 0) stylesNameIndent = indent;
				if (indent <= stylesNameIndent) {
					// Style name level
					currentStyleName = key;
					stylesDepth = 1;
				} else {
					// Sub-property level
					stylesDepth = 2;
					lineStyleName = currentStyleName;
				}
			}

			lines.push({
				key,
				rawValue: valueRaw,
				keyStart,
				keyEnd,
				valueStart,
				valueEnd,
				valueQuote,
				indent,
				inStylesBlock: lineInStylesBlock,
				styleName: lineStyleName,
				stylesDepth,
			});
		} else if (trimmed.length > 0) {
			// Non-empty line without colon — track as a key-in-progress
			const keyStart = lineStart + indent;
			const keyEnd = lineStart + line.length;

			let lineInStylesBlock = false;
			let stylesDepth: number | undefined;
			if (inStylesBlock && indent > 0) {
				lineInStylesBlock = true;
				if (stylesNameIndent < 0) stylesNameIndent = indent;
				stylesDepth = indent <= stylesNameIndent ? 1 : 2;
			} else if (indent === 0) {
				inStylesBlock = false;
			}

			lines.push({
				key: trimmed,
				rawValue: '',
				keyStart,
				keyEnd,
				valueStart: keyEnd,
				valueEnd: keyEnd,
				indent,
				inStylesBlock: lineInStylesBlock,
				styleName: lineInStylesBlock && stylesDepth === 2 ? currentStyleName : undefined,
				stylesDepth,
			});
		}

		pos += rawLine.length + 1; // +1 for \n
	}

	return { lines, fmStart, fmEnd, bodyStart, closed: !!fmMatch };
}

// ---------------------------------------------------------------------------
// Location context
// ---------------------------------------------------------------------------

export interface FrontmatterLocation {
	kind: 'key' | 'value' | 'styles-key' | 'styles-value' | 'styles-name' | 'outside';
	/** The canonical key name (or raw name if unknown). For 'value', this is the key whose value is being edited. */
	key: string;
	keyStart: number;
	keyEnd: number;
	valueStart: number;
	valueEnd: number;
	/** For styles context: the user-defined style name */
	styleName?: string;
	/** Keys already declared in this frontmatter (canonical names) */
	declaredKeys: Set<string>;
	/** Whether the key under the cursor is also declared on another line */
	currentKeyHasOtherDeclaration?: boolean;
	/** Whether cursor is inside frontmatter at all */
	inFrontmatter: boolean;
	/** Whether a closing frontmatter delimiter is present */
	frontmatterClosed: boolean;
	/** Whether completion should be suppressed at punctuation outside an array item */
	suppressCompletions?: boolean;
	/** Formatting consumed by an array-item replacement range */
	completionPrefix?: string;
	completionSuffix?: string;
	/** Formatting before a key when completion was requested inside indentation */
	keyCompletionPrefix?: string;
	/** Matching quote pair stripped from the current value range */
	valueQuote?: '"' | "'";
	/** Frontmatter body start offset (first line after opening ---) */
	fmBodyStart?: number;
	/** Frontmatter end offset (past closing ---) */
	fmEnd?: number;
}

/**
 * Locate the frontmatter context at the given offset.
 */
export function getFrontmatterLocation(text: string, offset: number): FrontmatterLocation {
	const outside: FrontmatterLocation = {
		kind: 'outside', key: '', keyStart: 0, keyEnd: 0,
		valueStart: 0, valueEnd: 0, declaredKeys: new Set(),
		inFrontmatter: false, frontmatterClosed: false,
	};

	// Completion and hover should work while the user is still authoring the
	// block, before the closing delimiter exists. Validation remains stricter
	// and calls parseFrontmatterLines() without this opt-in.
	const parsed = parseFrontmatterLines(text, true);
	if (!parsed) return outside;
	if (
		offset < parsed.fmStart ||
		(parsed.closed ? offset >= parsed.fmEnd : offset > parsed.fmEnd)
	) return outside;

	// Collect all declared keys (canonical)
	const declaredKeys = new Set<string>();
	const declaredKeyCounts = new Map<string, number>();
	for (const line of parsed.lines) {
		if (!line.inStylesBlock || line.indent === 0) {
			const canonical = resolveCanonical(line.key);
			declaredKeys.add(canonical);
			declaredKeyCounts.set(canonical, (declaredKeyCounts.get(canonical) ?? 0) + 1);
		}
	}

	const currentKeyHasOtherDeclaration = (line: FmLine): boolean => {
		const canonical = resolveCanonical(line.key);
		return (declaredKeyCounts.get(canonical) ?? 0) > 1;
	};

	const completionValueRange = (
		line: FmLine,
	): { start: number; end: number; suppress?: boolean; prefix?: string; suffix?: string } => {
		const def = line.inStylesBlock ? STYLES_SUB_MAP.get(line.key) : lookupDef(line.key);
		if (!def?.arrayField || offset < line.valueStart || offset > line.valueEnd) {
			return { start: line.valueStart, end: line.valueEnd };
		}

		const value = text.slice(line.valueStart, line.valueEnd);
		const relativeOffset = offset - line.valueStart;
		const trimmedEnd = value.trimEnd().length;
		const contentStart = value.startsWith('[') ? 1 : 0;
		const contentEnd =
			value.startsWith('[') && value[trimmedEnd - 1] === ']'
				? trimmedEnd - 1
				: value.length;
		if (relativeOffset < contentStart || relativeOffset > contentEnd) {
			return { start: line.valueStart, end: line.valueEnd, suppress: true };
		}

		const commas: number[] = [];
		let quote: '"' | "'" | undefined;
		let escaped = false;
		for (let i = contentStart; i < contentEnd; i++) {
			const char = value[i];
			if (quote === '"') {
				if (escaped) {
					escaped = false;
				} else if (char === '\\') {
					escaped = true;
				} else if (char === quote) {
					quote = undefined;
				}
				continue;
			}
			if (quote === "'") {
				if (char === quote) {
					if (value[i + 1] === quote) {
						i++;
					} else {
						quote = undefined;
					}
				}
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
			} else if (char === ',') {
				commas.push(i);
			}
		}

		const previousComma = [...commas].reverse().find(index => index < relativeOffset) ?? -1;
		const nextComma = commas.find(index => index >= relativeOffset) ?? contentEnd;
		const start = Math.max(previousComma + 1, contentStart);
		const end = nextComma;
		let itemStart = start;
		let itemEnd = end;
		while (itemStart < itemEnd && /\s/.test(value[itemStart])) itemStart++;
		while (itemEnd > itemStart && /\s/.test(value[itemEnd - 1])) itemEnd--;

		let prefix = value.slice(start, itemStart);
		let suffix = value.slice(itemEnd, end);
		if (
			itemEnd - itemStart >= 2 &&
			(value[itemStart] === '"' || value[itemStart] === "'") &&
			value[itemEnd - 1] === value[itemStart]
		) {
			prefix += value[itemStart];
			suffix = value[itemEnd - 1] + suffix;
		}
		return {
			start: line.valueStart + start,
			end: line.valueStart + end,
			prefix,
			suffix,
		};
	};

	// Find which line the offset falls on
	// If offset is before any content line (on the --- delimiter), treat as key position on first line area
	for (const line of parsed.lines) {
		if (offset >= line.keyStart && offset <= line.valueEnd) {
			// Determine if cursor is in key or value position
			// The colon separates them; if line has no colon, it's in key position
			const colonOffset = line.keyEnd; // key ends at colon position

			if (line.inStylesBlock) {
				if (line.stylesDepth === 1) {
					// Style name level — no completions
					return {
						kind: 'styles-name', key: line.key,
						keyStart: line.keyStart, keyEnd: line.keyEnd,
						valueStart: line.valueStart, valueEnd: line.valueEnd,
						declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
						fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
					};
				}
				// Sub-property level
				if (offset <= colonOffset) {
					return {
						kind: 'styles-key', key: line.key,
						keyStart: line.keyStart, keyEnd: line.keyEnd,
						valueStart: line.valueStart, valueEnd: line.valueEnd,
						valueQuote: line.valueQuote,
						styleName: line.styleName, declaredKeys,
						currentKeyHasOtherDeclaration: currentKeyHasOtherDeclaration(line),
						inFrontmatter: true, frontmatterClosed: parsed.closed,
						fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
					};
				}
				const valueRange = completionValueRange(line);
				return {
					kind: 'styles-value', key: line.key,
					keyStart: line.keyStart, keyEnd: line.keyEnd,
					valueStart: valueRange.start, valueEnd: valueRange.end,
					styleName: line.styleName, declaredKeys,
					inFrontmatter: true, frontmatterClosed: parsed.closed,
					suppressCompletions: valueRange.suppress,
					completionPrefix: valueRange.prefix,
					completionSuffix: valueRange.suffix,
					fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
				};
			}

			// Top-level field
			if (offset <= colonOffset) {
				return {
					kind: 'key', key: line.key,
					keyStart: line.keyStart, keyEnd: line.keyEnd,
					valueStart: line.valueStart, valueEnd: line.valueEnd,
					valueQuote: line.valueQuote,
					declaredKeys,
					currentKeyHasOtherDeclaration: currentKeyHasOtherDeclaration(line),
					inFrontmatter: true, frontmatterClosed: parsed.closed,
					fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
				};
			}
			const valueRange = completionValueRange(line);
			return {
				kind: 'value', key: line.key,
				keyStart: line.keyStart, keyEnd: line.keyEnd,
				valueStart: valueRange.start, valueEnd: valueRange.end,
				declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
				suppressCompletions: valueRange.suppress,
				completionPrefix: valueRange.prefix,
				completionSuffix: valueRange.suffix,
				fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
			};
		}
	}

	// Offset is in frontmatter but not on any content line (blank line or delimiter)
	// Find which line context we're in by checking proximity
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const lineEnd = text.indexOf('\n', offset);
	const rawEnd = lineEnd === -1 ? text.length : lineEnd;
	const actualEnd =
		rawEnd > lineStart && text[rawEnd - 1] === '\r'
			? rawEnd - 1
			: rawEnd;
	const lineText = text.slice(lineStart, actualEnd);
	const trimmed = lineText.trimStart();
	const indent = lineText.length - trimmed.length;
	const fallbackKeyRange = (actualKeyStart: number): {
		keyStart: number;
		keyCompletionPrefix?: string;
	} => offset < actualKeyStart
		? {
			keyStart: offset,
			keyCompletionPrefix: text.slice(offset, actualKeyStart),
		}
		: { keyStart: actualKeyStart };
	const fallbackValueRange = (
		actualKeyStart: number,
		colonIdx: number,
	): { valueStart: number; valueEnd: number; valueQuote?: '"' | "'" } => {
		const colonOffset = actualKeyStart + colonIdx;
		const afterColon = text.slice(colonOffset + 1, actualEnd);
		const leadingSpaces = afterColon.match(/^\s*/)?.[0].length ?? 0;
		let valueStart = colonOffset + 1 + leadingSpaces;
		let valueEnd = actualEnd;
		let valueQuote: '"' | "'" | undefined;
		const rawValue = text.slice(valueStart, valueEnd);
		if (
			(rawValue.startsWith('"') && rawValue.endsWith('"')) ||
			(rawValue.startsWith("'") && rawValue.endsWith("'"))
		) {
			valueQuote = rawValue[0] as '"' | "'";
			valueStart++;
			valueEnd--;
		}
		return { valueStart, valueEnd, valueQuote };
	};

	// Check if we're in the styles block based on surrounding lines
	let inStyles = false;
	let styleName: string | undefined;
	let stylesBlockStart = -1;
	for (const line of parsed.lines) {
		if (line.keyStart > offset) break;
		if (line.key === 'styles' && line.indent === 0) {
			inStyles = true;
			stylesBlockStart = line.keyStart;
		} else if (line.indent === 0 && line.key !== 'styles') {
			inStyles = false;
			stylesBlockStart = -1;
		}
		if (inStyles && line.styleName) {
			styleName = line.styleName;
		}
	}

	if (inStyles && indent > 0) {
		// Inside styles block
		const parsedStyleName =
			parsed.lines.find(line =>
				line.inStylesBlock &&
				line.stylesDepth === 1 &&
				line.keyStart > stylesBlockStart &&
				line.keyStart < offset
			);
		if (!parsedStyleName || indent <= parsedStyleName.indent) {
			return {
				kind: 'styles-name', key: trimmed,
				keyStart: lineStart + indent, keyEnd: actualEnd,
				valueStart: actualEnd, valueEnd: actualEnd,
				styleName, declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
				fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
			};
		}
		if (trimmed.includes(':')) {
			// Has a colon — sub-property in progress
			const colonIdx = trimmed.indexOf(':');
			const key = trimmed.slice(0, colonIdx).trim();
			const actualKeyStart = lineStart + indent;
			const { keyStart, keyCompletionPrefix } = fallbackKeyRange(actualKeyStart);
			const { valueStart, valueEnd, valueQuote } = fallbackValueRange(actualKeyStart, colonIdx);
			if (offset <= actualKeyStart + key.length) {
				return {
					kind: 'styles-key', key,
					keyStart, keyEnd: actualKeyStart + key.length,
					valueStart, valueEnd, valueQuote, keyCompletionPrefix,
					styleName, declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
					fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
				};
			}
			return {
				kind: 'styles-value', key,
				keyStart, keyEnd: actualKeyStart + key.length,
				valueStart, valueEnd, valueQuote, keyCompletionPrefix,
				styleName, declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
				fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
			};
		}
		// No colon — key being typed
		const actualKeyStart = lineStart + indent;
		const { keyStart, keyCompletionPrefix } = fallbackKeyRange(actualKeyStart);
		return {
			kind: 'styles-key', key: trimmed,
			keyStart, keyEnd: actualKeyStart + trimmed.length,
			valueStart: actualEnd, valueEnd: actualEnd,
			keyCompletionPrefix,
			styleName, declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
			fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
		};
	}

	// Top-level: empty or partial line
	if (trimmed.includes(':')) {
		const colonIdx = trimmed.indexOf(':');
		const key = trimmed.slice(0, colonIdx).trim();
		const actualKeyStart = lineStart + indent;
		const { keyStart, keyCompletionPrefix } = fallbackKeyRange(actualKeyStart);
		const { valueStart, valueEnd, valueQuote } = fallbackValueRange(actualKeyStart, colonIdx);
		if (offset <= actualKeyStart + key.length) {
			return {
				kind: 'key', key,
				keyStart, keyEnd: actualKeyStart + key.length,
				valueStart, valueEnd, valueQuote, keyCompletionPrefix,
				declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
				fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
			};
		}
		return {
			kind: 'value', key,
			keyStart, keyEnd: actualKeyStart + key.length,
			valueStart, valueEnd, valueQuote, keyCompletionPrefix,
			declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
			fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
		};
	}

	// Bare text or empty line — key position
	const actualKeyStart = lineStart + indent;
	const { keyStart, keyCompletionPrefix } = fallbackKeyRange(actualKeyStart);
	return {
		kind: 'key', key: trimmed,
		keyStart, keyEnd: actualKeyStart + trimmed.length,
		valueStart: actualEnd, valueEnd: actualEnd,
		keyCompletionPrefix,
		declaredKeys, inFrontmatter: true, frontmatterClosed: parsed.closed,
		fmBodyStart: parsed.bodyStart, fmEnd: parsed.fmEnd,
	};
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

export interface FrontmatterCompletionItem {
	label: string;
	detail?: string;
	insertText: string;
	kind: 'property' | 'value';
	filterText: string;
	sortText: string;
	/** Ask the VS Code client to open value suggestions after inserting this property. */
	triggerValueCompletions?: boolean;
	/** Absolute end offset when a property edit must also replace an empty separator/value. */
	replacementEnd?: number;
	isIncomplete?: boolean; // for CSL (large list)
}

export function getFrontmatterCompletionItems(
	location: FrontmatterLocation,
	platform: string,
	cachedCslStyles?: string[],
): FrontmatterCompletionItem[] {
	if (
		!location.inFrontmatter ||
		location.kind === 'outside' ||
		location.kind === 'styles-name' ||
		location.suppressCompletions
	) {
		return [];
	}

	if (location.kind === 'key') {
		return getKeyCompletions(location, FRONTMATTER_SCHEMA);
	}

	if (location.kind === 'styles-key') {
		return getKeyCompletions(location, STYLES_SUB_PROPS);
	}

	if (location.kind === 'value' || location.kind === 'styles-value') {
		const items = getValueCompletions(location, platform, cachedCslStyles);
		if (!location.completionPrefix && !location.completionSuffix) return items;
		return items.map(item => ({
			...item,
			insertText: (location.completionPrefix ?? '') + item.insertText + (location.completionSuffix ?? ''),
		}));
	}

	return [];
}

function getKeyCompletions(location: FrontmatterLocation, schema: readonly FieldDef[]): FrontmatterCompletionItem[] {
	const prefix = location.key.toLowerCase();
	const items: FrontmatterCompletionItem[] = [];

	for (const def of schema) {
		// Skip already-declared keys (only for top-level, not styles sub-props)
		const editingThisKey = resolveCanonical(location.key) === def.key && !location.currentKeyHasOtherDeclaration;
		if (schema === FRONTMATTER_SCHEMA && location.declaredKeys.has(def.key) && !def.allowsMultiple && !editingThisKey) {
			continue;
		}
		if (prefix && !def.key.startsWith(prefix)) continue;
		const hasPopulatedValue = location.valueEnd > location.valueStart;
		const hasExistingSeparator = location.valueStart > location.keyEnd || hasPopulatedValue;
		const replacesEmptyQuotedValue = !!location.valueQuote && !hasPopulatedValue;
		const replacesEmptySeparator =
			!location.valueQuote &&
			location.valueStart > location.keyEnd &&
			!hasPopulatedValue;
		const rewritesEmptyValue = replacesEmptySeparator || replacesEmptyQuotedValue;
		const writesSeparator = !hasExistingSeparator || rewritesEmptyValue;
		const separator = replacesEmptyQuotedValue
			? ': ' + location.valueQuote
			: ': ';
		items.push({
			label: def.key,
			detail: def.description.split('\n')[0], // First line only
			insertText:
				(location.keyCompletionPrefix ?? '') +
				def.key +
				(writesSeparator ? separator : ''),
			kind: 'property',
			filterText: def.key,
			sortText: def.key,
			triggerValueCompletions: writesSeparator && hasGeneratedValueCompletions(def),
			replacementEnd: rewritesEmptyValue ? location.valueEnd : undefined,
		});
	}
	return items;
}

/**
 * Keep this predicate in lockstep with getValueCompletions().
 * It controls whether accepting a property completion immediately opens the
 * corresponding value suggestions.
 */
function hasGeneratedValueCompletions(def: FieldDef): boolean {
	switch (def.kind) {
		case 'boolean':
		case 'digits':
		case 'font':
		case 'code-font':
		case 'font-style':
		case 'line-spacing':
		case 'paragraph-indent':
		case 'col-widths':
		case 'color-hex':
		case 'csl':
			return true;
		case 'enum':
			return (def.enumValues?.length ?? 0) > 0;
		default:
			return false;
	}
}

function getValueCompletions(location: FrontmatterLocation, platform: string, cachedCslStyles?: string[]): FrontmatterCompletionItem[] {
	const canonicalKey = resolveCanonical(location.key);
	const def = location.kind === 'styles-value'
		? STYLES_SUB_MAP.get(location.key)
		: SCHEMA_MAP.get(canonicalKey);
	if (!def) return [];

	switch (def.kind) {
		case 'boolean':
			return makeValueItems(BOOLEAN_VALUES);
		case 'enum':
			return makeValueItems(def.enumValues ?? []);
		case 'digits':
			return makeValueItems([{ value: 'source' }]);
		case 'font':
			return makeValueItems(getBodyFonts(platform).map(f => ({ value: f })));
		case 'code-font':
			return makeValueItems(getMonoFonts(platform).map(f => ({ value: f })));
		case 'font-style':
			return makeValueItems(FONT_STYLE_PARTS);
		case 'line-spacing':
			return makeValueItems(LINE_SPACING_VALUES);
		case 'paragraph-indent':
			return makeValueItems(PARAGRAPH_INDENT_VALUES);
		case 'col-widths':
			return makeValueItems(COL_WIDTHS_VALUES);
		case 'color-hex':
			return makeValueItems(COLOR_HEX_SPECIAL_VALUES);
		case 'csl':
			return getCslValueCompletions(location, cachedCslStyles);
		default:
			return [];
	}
}

function makeValueItems(values: readonly EnumValue[]): FrontmatterCompletionItem[] {
	return values.map(v => ({
		label: v.value,
		detail: v.description,
		insertText: v.value,
		kind: 'value' as const,
		filterText: v.value,
		sortText: v.value,
	}));
}

function getCslValueCompletions(_location: FrontmatterLocation, cachedCslStyles?: string[]): FrontmatterCompletionItem[] {
	// Return full list — isIncomplete: true tells the client to re-query on
	// each keystroke, and filterText enables client-side prefix matching.
	const items: FrontmatterCompletionItem[] = [];
	const seen = new Set<string>();
	for (const [id, displayName] of BUNDLED_STYLE_LABELS) {
		seen.add(id);
		items.push({
			label: id,
			detail: displayName,
			insertText: id,
			kind: 'value',
			filterText: id,
			sortText: id,
			isIncomplete: true,
		});
	}
	// Add cached (downloaded) styles not already bundled
	if (cachedCslStyles) {
		for (const id of cachedCslStyles) {
			if (!seen.has(id)) {
				items.push({
					label: id,
					detail: 'Downloaded style',
					insertText: id,
					kind: 'value',
					filterText: id,
					sortText: id,
					isIncomplete: true,
				});
			}
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export interface FrontmatterHoverResult {
	markdown: string;
	hoverStart: number;
	hoverEnd: number;
}

export function getFrontmatterHover(location: FrontmatterLocation): FrontmatterHoverResult | undefined {
	if (!location.inFrontmatter || location.kind === 'outside') return undefined;

	if (location.kind === 'styles-name') return undefined;

	if (location.kind === 'styles-key' || location.kind === 'styles-value') {
		const def = STYLES_SUB_MAP.get(location.key);
		if (!def) return undefined;
		return {
			markdown: '**' + def.key + '**\n\n' + def.description,
			hoverStart: location.keyStart,
			hoverEnd: location.kind === 'styles-value' ? location.valueEnd : location.keyEnd,
		};
	}

	// Top-level key or value
	const canonicalKey = resolveCanonical(location.key);
	const def = SCHEMA_MAP.get(canonicalKey);
	if (!def) return undefined;

	let md = '**' + def.key + '**';
	if (def.aliases && def.aliases.length > 0) {
		md += '  \nAliases: ' + def.aliases.map(a => '`' + a + '`').join(', ');
	}
	md += '\n\n' + def.description;

	return {
		markdown: md,
		hoverStart: location.keyStart,
		hoverEnd: location.kind === 'value' ? location.valueEnd : location.keyEnd,
	};
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface FrontmatterDiagnostic {
	message: string;
	severity: 'error' | 'warning' | 'information';
	start: number;
	end: number;
}

export interface FrontmatterValidationCallbacks {
	fileExists: (absPath: string) => Promise<boolean>;
	isCslAvailable: (name: string, opts?: { cacheDirs?: string[]; sourceDir?: string }) => Promise<boolean>;
	cslSuggestions: (prefix: string) => string[];
	sourceDir?: string;
	cslCacheDirs?: string[];
	/**
	 * Resolve the bibliography path using full workspace-root fallback logic.
	 * Returns the absolute path only if the file exists; undefined otherwise.
	 * Callers treat a truthy return as proof of existence (like `fileExists`),
	 * so implementations must verify the file is present before returning.
	 */
	resolveBibliographyPath?: () => Promise<string | undefined>;
}

export async function validateFrontmatter(
	text: string,
	callbacks: FrontmatterValidationCallbacks,
): Promise<FrontmatterDiagnostic[]> {
	const parsed = parseFrontmatterLines(text);
	if (!parsed) return [];

	const diagnostics: FrontmatterDiagnostic[] = [];
	const seenCanonical = new Map<string, FmLine>(); // canonical → first occurrence

	for (const line of parsed.lines) {
		// Skip styles sub-properties for duplicate/typo detection at top level
		if (line.inStylesBlock && line.indent > 0) {
			// Validate styles sub-property values
			if (line.stylesDepth === 2) {
				const subDef = STYLES_SUB_MAP.get(line.key);
				if (subDef) {
					const valueDiag = validateValue(subDef, line);
					if (valueDiag) diagnostics.push(valueDiag);
				} else {
					// Unknown styles sub-property — check case mismatch first, then typo
					const stylesCaseMatch = findStylesCaseMatch(line.key.toLowerCase());
					if (stylesCaseMatch) {
						diagnostics.push({
							message: 'Frontmatter keys are case-sensitive. Did you mean `' + stylesCaseMatch + '`?',
							severity: 'information',
							start: line.keyStart,
							end: line.keyEnd,
						});
					} else {
						const suggestions = findStylesTypoSuggestions(line.key);
						if (suggestions.length > 0) {
							diagnostics.push({
								message: 'Did you mean ' + suggestions.map(s => '`' + s + '`').join(', ') + '?',
								severity: 'information',
								start: line.keyStart,
								end: line.keyEnd,
							});
						}
					}
				}
			}
			continue;
		}

		const canonical = resolveCanonical(line.key);
		const def = lookupDef(line.key);

		if (!def) {
			// Unknown key — check for case mismatch first, then typo
			if (!ALL_KNOWN_KEYS.has(line.key)) {
				const lower = line.key.toLowerCase();
				const caseMatch = findCaseMatch(lower);
				if (caseMatch) {
					diagnostics.push({
						message: 'Frontmatter keys are case-sensitive. Did you mean `' + caseMatch + '`?',
						severity: 'information',
						start: line.keyStart,
						end: line.keyEnd,
					});
				} else {
					const suggestions = findTypoSuggestions(line.key);
					if (suggestions.length > 0) {
						diagnostics.push({
							message: 'Did you mean ' + suggestions.map(s => '`' + s + '`').join(', ') + '?',
							severity: 'information',
							start: line.keyStart,
							end: line.keyEnd,
						});
					}
				}
			}
			continue;
		}

		// Duplicate key check
		if (seenCanonical.has(canonical)) {
			if (!def.allowsMultiple) {
				diagnostics.push({
					message: 'Duplicate key `' + line.key + '`' + (line.key !== canonical ? ' (alias of `' + canonical + '`)' : '') + '.',
					severity: 'warning',
					start: line.keyStart,
					end: line.keyEnd,
				});
			}
		} else {
			seenCanonical.set(canonical, line);
		}

		// Value validation
		if (line.rawValue || def.kind === 'styles-block') {
			const valueDiag = validateValue(def, line);
			if (valueDiag) diagnostics.push(valueDiag);
		}
	}

	// Async validations: CSL and bibliography file existence
	const decimalLine = seenCanonical.get('table-decimal-mark');
	const groupingLine = seenCanonical.get('table-digit-grouping');
	if (decimalLine && groupingLine) {
		const decimal = decimalLine.rawValue.toLowerCase();
		const grouping = groupingLine.rawValue.toLowerCase();
		if ((decimal === 'point' && grouping === 'period') || (decimal === 'comma' && grouping === 'comma')) {
			diagnostics.push({
				message: 'Decimal mark and digit grouping cannot use the same character.',
				severity: 'error', start: groupingLine.valueStart, end: groupingLine.valueEnd,
			});
		}
	}

	// Async validations: CSL and bibliography file existence
	await validateCsl(text, callbacks, diagnostics);
	await validateBibPath(parsed, callbacks, diagnostics);

	return diagnostics;
}

function validateValue(def: FieldDef, line: FmLine): FrontmatterDiagnostic | undefined {
	const value = line.rawValue;
	if (!value) return undefined;

	switch (def.kind) {
		case 'boolean':
			if (value !== 'true' && value !== 'false') {
				return { message: 'Invalid value. Expected `true` or `false`.', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;

		case 'enum': {
			if (!def.enumValues) break;
			const lower = value.toLowerCase();
			if (!def.enumValues.some(e => e.value.toLowerCase() === lower)) {
				const valid = def.enumValues.map(e => '`' + e.value + '`').join(', ');
				return { message: 'Invalid value. Expected one of: ' + valid + '.', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;
		}

		case 'number': {
			if (def.arrayField) {
				const parts = value.startsWith('[') ? value.slice(1, value.endsWith(']') ? -1 : undefined).split(',') : value.split(',');
				if (parts.some(p => p.trim() !== '' && (!isFinite(parseFloat(p.trim())) || parseFloat(p.trim()) < 0))) {
					return { message: 'Expected non-negative numbers.', severity: 'error', start: line.valueStart, end: line.valueEnd };
				}
			} else {
				const n = parseFloat(value);
				if (!isFinite(n) || n < 0) {
					return { message: 'Expected a non-negative number.', severity: 'error', start: line.valueStart, end: line.valueEnd };
				}
			}
			break;
		}

		case 'digits':
			if (value.toLowerCase() !== 'source' && (!/^\d+$/.test(value) || Number(value) > MAX_TABLE_DIGITS)) {
				return { message: 'Expected `source` or an integer from 0 to ' + MAX_TABLE_DIGITS + '.', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;

		case 'timezone':
			if (!/^[+-]\d{2}:\d{2}$/.test(value)) {
				return { message: 'Expected `+HH:MM` or `-HH:MM` format (e.g. `+05:30`).', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;

		case 'color-hex':
			if (!/^[0-9A-Fa-f]{6}$/.test(value) && value !== 'none' && value !== 'transparent') {
				return { message: 'Expected a 6-digit hex color (e.g. `F0F0F0`), `none`, or `transparent`.', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;

		case 'color-hex-only':
			if (!/^[0-9A-Fa-f]{6}$/.test(value)) {
				return { message: 'Expected a 6-digit hex color (e.g. `333333`).', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;

		case 'font-style': {
			if (def.arrayField) {
				// Validate each element of inline array
				const parts = value.startsWith('[') ? value.slice(1, value.endsWith(']') ? -1 : undefined).split(',') : value.split(',');
				for (const part of parts) {
					const trimmed = part.trim();
					if (trimmed && !normalizeFontStyle(trimmed)) {
						return { message: 'Invalid font style `' + trimmed + '`. Use `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal`, combined with `-`.', severity: 'error', start: line.valueStart, end: line.valueEnd };
					}
				}
			} else {
				if (!normalizeFontStyle(value)) {
					return { message: 'Invalid font style. Use `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal`, combined with `-`.', severity: 'error', start: line.valueStart, end: line.valueEnd };
				}
			}
			break;
		}

		case 'line-spacing': {
			const lower = value.toLowerCase();
			if (lower !== 'single' && lower !== '1.5' && lower !== 'double') {
				const n = parseFloat(value);
				if (!isFinite(n) || n <= 0) {
					return { message: 'Expected `single`, `1.5`, `double`, or a positive number.', severity: 'error', start: line.valueStart, end: line.valueEnd };
				}
			}
			break;
		}

		case 'paragraph-indent': {
			const lower = value.toLowerCase();
			if (lower !== 'none') {
				const n = parseFloat(value);
				if (!isFinite(n) || n < 0) {
					return { message: 'Expected a non-negative number (inches) or `none`.', severity: 'error', start: line.valueStart, end: line.valueEnd };
				}
			}
			break;
		}

		case 'col-widths': {
			const parsed = parseColWidths(value);
			if (parsed === undefined) {
				return { message: 'Expected `equal`, `auto`, or space/comma-separated positive numbers.', severity: 'error', start: line.valueStart, end: line.valueEnd };
			}
			break;
		}

		// free-text, font, code-font, bib-path, csl, styles-block: no sync validation
	}

	return undefined;
}

async function validateCsl(
	text: string,
	callbacks: FrontmatterValidationCallbacks,
	diagnostics: FrontmatterDiagnostic[],
): Promise<void> {
	const fieldInfo = getCslFieldInfo(text);
	if (!fieldInfo || !fieldInfo.value) return;

	const available = await callbacks.isCslAvailable(fieldInfo.value, {
		cacheDirs: callbacks.cslCacheDirs,
		sourceDir: callbacks.sourceDir,
	});

	if (available) return;

	const suggestions = callbacks.cslSuggestions(fieldInfo.value);
	let message = 'CSL style "' + fieldInfo.value + '" not found locally.';
	if (suggestions.length === 1) {
		message += ' Did you mean `' + suggestions[0] + '`?';
	} else if (suggestions.length > 0) {
		message += ' Did you mean ' + suggestions.map(s => '`' + s + '`').join(', ') + '?';
	}
	message += ' If the style exists online, the converter will download it automatically.';

	diagnostics.push({
		message,
		severity: 'warning',
		start: fieldInfo.valueStart,
		end: fieldInfo.valueEnd,
	});
}

async function validateBibPath(
	parsed: ParsedFrontmatter,
	callbacks: FrontmatterValidationCallbacks,
	diagnostics: FrontmatterDiagnostic[],
): Promise<void> {
	if (!callbacks.sourceDir) return;

	// Find the bibliography line
	for (const line of parsed.lines) {
		if (line.inStylesBlock) continue;
		const canonical = resolveCanonical(line.key);
		if (canonical !== 'bibliography') continue;
		if (!line.rawValue) continue;

		let bibPath = line.rawValue;
		if (!bibPath.endsWith('.bib')) bibPath = bibPath + '.bib';

		let exists: boolean;
		if (callbacks.resolveBibliographyPath) {
			exists = !!(await callbacks.resolveBibliographyPath());
		} else {
			const { resolve } = await import('path');
			const absPath = resolve(callbacks.sourceDir, bibPath);
			exists = await callbacks.fileExists(absPath);
		}
		if (!exists) {
			diagnostics.push({
				message: 'Bibliography file not found: `' + bibPath + '`.',
				severity: 'warning',
				start: line.valueStart,
				end: line.valueEnd,
			});
		}
		return; // Only check the first bibliography field
	}
}
