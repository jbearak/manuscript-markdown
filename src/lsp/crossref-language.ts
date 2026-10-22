// Cross-references to figures and tables, as `@fig-map` or `[@tbl-rates]`,
// as the LSP reads them: the labels the document gives its figures and
// tables, as `{#fig-map}`, where export captions one, the references to
// them, completion of a label after `@fig-` or `@tbl-`, and the diagnostics
// of a label no figure or table has, a label more than one has, and a
// citation's brackets with a cross-reference in them, which Word gets as
// text. Both labels and references are read from one parse of the text by
// the preview's parser, which reads cross-references by crossRefAt in
// citation-syntax.ts, as export does, with export's notes, quotes and
// equations: so none in code, HTML, an equation, a link's text or an
// image's alt text, and a citation's brackets over lines are read as export
// reads them.

import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { deLazifyBlockquotesWithLines } from '../block-preprocess';
import { computeCodeRegions, computeMarkdownRegions, isInsideCodeRegion, mergeRegions, type CodeRegion } from '../code-regions';
import { maskFrontmatter } from '../frontmatter';
import { CROSS_REF_AFTER_RE, crossRefLabel } from '../citation-syntax';
import { DOCX_DOLLAR_MATH_OPTIONS, findDollarMathAt, isEscapedAt } from '../math-delimiters';
import { normalizeNewlines } from '../newlines';
import { manuscriptMarkdownPlugin } from '../preview/manuscript-markdown-plugin';

/** A figure's or a table's label, as `fig-map` in `{#fig-map}`, from
 *  `start` to `end`, the label's own characters */
export interface CrossRefLabelDefinition {
	label: string;
	start: number;
	end: number;
}

/** A cross-reference, from `start` to `end`, its @ and key, inside its
 *  brackets for a bracketed one, or for a citation's brackets with one in
 *  them, which are text (`literal`), the brackets */
export interface CrossRefUsage {
	key: string;
	label: string;
	start: number;
	end: number;
	form: 'bare' | 'bracket' | 'literal';
}

/** `text` with its code and frontmatter as spaces, its offsets kept */
function scannable(text: string): string {
	const masked = maskFrontmatter(text);
	const regions = computeCodeRegions(masked);
	if (regions.length === 0) return masked;
	let out = '';
	let at = 0;
	for (const region of regions) {
		if (region.start < at) continue;
		out += masked.slice(at, region.start) + masked.slice(region.start, region.end).replace(/[^\r\n]/g, ' ');
		at = region.end;
	}
	return out + masked.slice(at);
}

// A label in an attribute block, as `{#fig-map}` or `{#fig-map width=50%}`,
// which export reads after an image or at a table's caption's end
const LABEL_RE = /\{#((?:fig|tbl)-[A-Za-z0-9_-]+)(?=[\s}])/g;
// The key after a bare @, as Pandoc reads one (see crossRefAt)
const BARE_KEY_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*/uy;

/** An equation, as export reads one (see mathRule in md-to-docx.ts), which
 *  holds no cross-reference, where the preview leaves equations to VS
 *  Code's math, which its parser here doesn't have */
function equationRule(state: StateInline, silent: boolean): boolean {
	const start = state.pos;
	if (start >= state.posMax || state.src.charAt(start) !== '$') return false;
	const match = findDollarMathAt(state.src, start, DOCX_DOLLAR_MATH_OPTIONS);
	if (!match || match.kind !== 'math') return false;
	if (!silent) state.push('math_inline', 'math', 0).content = state.src.slice(match.contentStart, match.contentEnd);
	state.pos = match.end;
	return true;
}

/** The preview's parser, which captions the figures and tables export
 *  does, and no others (see captionsRule there), and reads the
 *  cross-references export does (see crossRefRule there), with export's
 *  equations */
let parser: MarkdownIt | undefined;

/** The document's parse, as export reads its blocks */
interface DocumentParse {
	tokens: Token[];
	/** For each line the parser read, the document's line it comes from */
	lines: number[];
	/** Where each of the document's lines starts */
	lineStarts: number[];
}

// The last text parsed, which the language server asks of again and again
let lastParse: { text: string; parse: DocumentParse } | undefined;

// A note's definition's label, at the start of its line
const NOTE_DEFINITION_RE = /^\[\^[a-zA-Z0-9_-]+\]:/;

/**
 * `text`, whose line ends are \n, with each note's definition text, as
 * export reads it (see extractFootnoteDefinitions in md-to-docx.ts): its
 * label, as `[^1]:`, and the note's indent of each line of it that starts
 * a block of it, after a blank line, as no-break spaces, which markdown-it
 * reads as text, not a link's definition or code, after the line's own
 * indent, as code's. Each line keeps its length.
 */
function notesAsText(text: string): string {
	if (!/^\[\^[a-zA-Z0-9_-]+\]:/m.test(text)) return text;
	const lines = text.split('\n');
	let inNote = false;
	for (let i = 0; i < lines.length; i++) {
		const definition = NOTE_DEFINITION_RE.exec(lines[i]);
		if (definition) {
			lines[i] = '\u00A0'.repeat(definition[0].length) + lines[i].slice(definition[0].length);
			inNote = true;
			continue;
		}
		if (!inNote) continue;
		const indent = /^(?: {4}|\t)/.exec(lines[i]);
		if (indent) {
			// Its indent past the note's, as code's, then the note's
			if (i > 0 && lines[i - 1].trim() === '') {
				const rest = lines[i].slice(indent[0].length);
				const own = /^[ \t]*/.exec(rest)![0];
				lines[i] = own + '\u00A0'.repeat(indent[0].length) + rest.slice(own.length);
			}
			continue;
		}
		// A blank line goes on in the note where an indented line is next
		if (lines[i].trim() === '') {
			let next = i + 1;
			while (next < lines.length && lines[next].trim() === '') next++;
			if (next < lines.length && /^(?: {4}|\t)/.test(lines[next])) continue;
		}
		inNote = false;
	}
	return lines.join('\n');
}

/** `text` parsed by the preview's parser, with its frontmatter masked, its
 *  notes' definitions read as their text (see notesAsText), and its quotes
 *  ended before a line with no >, as export ends them (see
 *  deLazifyBlockquotesWithLines in block-preprocess.ts), where markdown-it
 *  would go on with them */
function parseOf(text: string): DocumentParse {
	if (lastParse?.text === text) return lastParse.parse;
	if (!parser) {
		parser = new MarkdownIt({ html: true }).use(manuscriptMarkdownPlugin);
		parser.inline.ruler.before('emphasis', 'export_equation', equationRule);
	}
	const quotes = deLazifyBlockquotesWithLines(notesAsText(normalizeNewlines(maskFrontmatter(text))));
	const lineStarts = [0];
	for (const end of text.matchAll(/\r\n?|\n/g)) lineStarts.push(end.index + end[0].length);
	const parse = { tokens: parser.parse(quotes.output, {}), lines: quotes.lines, lineStarts };
	lastParse = { text, parse };
	return parse;
}

/** The document's lines a block's map, from its first to past its last,
 *  of the lines the parser read, covers */
function documentLines(parse: DocumentParse, map: [number, number]): [number, number] {
	const last = Math.max(map[0], map[1] - 1);
	return [parse.lines[map[0]] ?? map[0], (parse.lines[last] ?? last) + 1];
}

/** The lines of each paragraph that's a figure or a table's caption, as
 *  the preview and export read them, from its first to past its last, by
 *  its label */
function captionLines(text: string): Map<string, Array<[number, number]>> {
	const parse = parseOf(text);
	const lines = new Map<string, Array<[number, number]>>();
	for (const token of parse.tokens) {
		const label = token.type === 'paragraph_open' ? token.attrGet('id') : null;
		if (!label || !token.map || !/^(?:fig|tbl)-/.test(label)) continue;
		if (!lines.has(label)) lines.set(label, []);
		lines.get(label)!.push(documentLines(parse, token.map));
	}
	return lines;
}

/** The labels the document gives its figures and tables, in order, each
 *  time one is given: a figure's, after an image alone in its paragraph,
 *  or a table's caption's, at the end of a paragraph after the table,
 *  where export captions one, not one that labels nothing, as in a
 *  sentence. Of a caption's paragraph, its last, as a figure's alt text
 *  or a caption's text comes before its label. */
export function scanCrossRefLabels(text: string): CrossRefLabelDefinition[] {
	const captions = captionLines(text);
	if (captions.size === 0) return [];
	const scan = scannable(text);
	const labels: CrossRefLabelDefinition[] = [];
	// The caption each of them is of
	const of: Array<[number, number]> = [];
	// The line each match is on, counted on from the last
	let line = 0;
	let counted = 0;
	for (const match of scan.matchAll(LABEL_RE)) {
		for (let newline = scan.indexOf('\n', counted); newline !== -1 && newline < match.index; newline = scan.indexOf('\n', counted)) {
			line++;
			counted = newline + 1;
		}
		const caption = captions.get(match[1])?.find(([first, end]) => line >= first && line < end);
		if (!caption) continue;
		if (of[of.length - 1] === caption) {
			labels.pop();
			of.pop();
		}
		labels.push({ label: match[1], start: match.index + 2, end: match.index + 2 + match[1].length });
		of.push(caption);
	}
	return labels;
}

/** Where each line of an inline token's text starts, and how far on in
 *  the document each is, as found (see SourceFinder), of the lines the
 *  parser read, `map`, the token's, or a table cell's row's */
interface InlineLines {
	map: [number, number];
	starts: number[];
	shifts: Array<number | null | undefined>;
}

/** A cross-reference the parser read, with its source as written and where
 *  it starts in its inline token's text (see crossRefRule in the preview) */
interface ParsedCrossRef {
	key: string;
	form: CrossRefUsage['form'];
	source: string;
	offset: number | undefined;
}

/** The cross-references among `tokens`, in order, but not in an image's
 *  alt text, which is text (see the preview's manuscript_citation_text) */
function parsedCrossRefs(tokens: Token[] | null, out: ParsedCrossRef[]): ParsedCrossRef[] {
	for (const token of tokens ?? []) {
		if (token.type === 'manuscript_cross_reference' && typeof token.meta?.source === 'string') {
			out.push({ key: token.meta.key, form: token.meta.form, source: token.meta.source, offset: typeof token.meta.offset === 'number' ? token.meta.offset : undefined });
		}
		if (token.type !== 'image') parsedCrossRefs(token.children, out);
	}
	return out;
}

/**
 * Where the parser's cross-references are in the document: each, of an
 * inline token, where its offset in the token's text falls in the
 * document, the token's lines being the ends of the document's lines, as
 * a paragraph's are past their quote's markers or their list item's
 * indent, or else the first place its source is in the token's lines that
 * no other took, outside code, as in a table's cell or a heading with
 * closing #s. One the parser read in text the preview rewrote, which isn't
 * there, is none.
 */
class SourceFinder {
	private readonly taken = new Set<number>();
	// Where each window's search goes on from
	private readonly cursors = new Map<string, number>();
	// Where the last inline token on each line placed ended (see place)
	private readonly placed = new Map<number, number>();
	// The code and HTML a search passes over
	private outside: CodeRegion[] | undefined;

	constructor(private readonly text: string, private readonly parse: DocumentParse) {}

	private lineEnd(line: number): number {
		const next = this.parse.lineStarts[line + 1];
		if (next === undefined) return this.text.length;
		return this.text.charAt(next - 2) === '\r' && this.text.charAt(next - 1) === '\n' ? next - 2 : next - 1;
	}

	/** How far on in the document line `k` of inline token `inline`'s
	 *  text is from where it is in the text, whose lines `lines` says
	 *  start, or null where the line isn't the end of the document's */
	private shift(inline: Token, lines: InlineLines, k: number): number | null {
		const content = inline.content;
		const lineText = content.slice(lines.starts[k], k + 1 < lines.starts.length ? lines.starts[k + 1] - 1 : content.length);
		const line = this.parse.lines[lines.map[0] + k];
		if (line === undefined || this.parse.lineStarts[line] === undefined) return null;
		const start = this.parse.lineStarts[line];
		let documentLine = this.text.slice(start, this.lineEnd(line));
		// markdown-it trims the text's end
		if (k === lines.starts.length - 1) documentLine = documentLine.trimEnd();
		if (!documentLine.endsWith(lineText)) return null;
		return start + documentLine.length - lineText.length - lines.starts[k];
	}

	/**
	 * Where inline token `inline`'s text, whose lines are `lines`, is in
	 * the document, where it's on one line, which more than one may share,
	 * as a table row's cells do, or a heading's text with closing #s: the
	 * end of the line, or else its text first after the last such token's
	 * on the line, as the cells are in order. Each such token comes here,
	 * whether it has a cross-reference or not, so each is found after
	 * those before it.
	 */
	place(inline: Token, lines: InlineLines): void {
		if (lines.starts.length !== 1 || lines.map[1] - lines.map[0] !== 1) return;
		lines.shifts[0] = this.shift(inline, lines, 0);
		const line = this.parse.lines[lines.map[0]];
		const lineStart = line === undefined ? undefined : this.parse.lineStarts[line];
		if (lineStart === undefined) return;
		const from = this.placed.get(line!) ?? lineStart;
		let at = lines.shifts[0] ?? -1;
		if (at < from) {
			at = inline.content ? this.text.indexOf(inline.content, from) : -1;
			if (at === -1 || at >= this.lineEnd(line!)) {
				lines.shifts[0] = null;
				return;
			}
			lines.shifts[0] = at;
		}
		this.placed.set(line!, at + inline.content.length);
	}

	/** Where offset `offset` of inline token `inline`'s text is in the
	 *  document, or undefined, each line's shift found once */
	private mapped(inline: Token, lines: InlineLines, offset: number): number | undefined {
		let low = 0;
		let high = lines.starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (lines.starts[mid] <= offset) low = mid;
			else high = mid - 1;
		}
		if (lines.shifts[low] === undefined) lines.shifts[low] = this.shift(inline, lines, low);
		const shift = lines.shifts[low];
		return shift === null || shift === undefined ? undefined : shift + offset;
	}

	/** Where `ref`'s source ends in the document, from `start`, its lines
	 *  past the prefixes of the lines after its first, or -1 */
	private endFrom(ref: ParsedCrossRef, start: number): number {
		const lines = ref.source.split('\n');
		if (!this.text.startsWith(lines[0], start)) return -1;
		let at = start + lines[0].length;
		for (let k = 1; k < lines.length; k++) {
			if (this.text.charAt(at) === '\r') at++;
			if (this.text.charAt(at) !== '\n') return -1;
			at++;
			while (/[ \t>]/.test(this.text.charAt(at))) at++;
			const line = lines[k].replace(/^[ \t]+/, '');
			if (!this.text.startsWith(line, at)) return -1;
			at += line.length;
		}
		return at;
	}

	/** Whether `ref` reads at `start` as the parser read it */
	private readsAt(ref: ParsedCrossRef, start: number): boolean {
		if (this.taken.has(start)) return false;
		if (ref.form === 'bare') {
			const before = start >= 2 && /[\uDC00-\uDFFF]/.test(this.text.charAt(start - 1)) ? this.text.slice(start - 2, start) : this.text.charAt(start - 1);
			BARE_KEY_RE.lastIndex = start + 1;
			return !CROSS_REF_AFTER_RE.test(before) && BARE_KEY_RE.exec(this.text)?.[0] === ref.key;
		}
		return !isEscapedAt(this.text, start);
	}

	/** Where `ref`, of inline token `inline`, whose text's lines are
	 *  `lines`, is, from its start to its end */
	find(ref: ParsedCrossRef, inline: Token, lines: InlineLines | undefined): [number, number] | undefined {
		const [first, past] = lines ? documentLines(this.parse, lines.map) : [0, this.parse.lineStarts.length];
		const window = first + ':' + past;
		if (ref.offset !== undefined && lines) {
			const start = this.mapped(inline, lines, ref.offset);
			const end = start === undefined ? -1 : this.endFrom(ref, start);
			if (start !== undefined && end !== -1 && this.readsAt(ref, start)) {
				this.taken.add(start);
				this.cursors.set(window, Math.max(this.cursors.get(window) ?? 0, end));
				return [start, end];
			}
		}
		// Else in the token's lines, from where the last one there ended,
		// outside code and HTML
		const to = this.parse.lineStarts[past] ?? this.text.length;
		const needle = ref.source.split('\n')[0];
		for (let at = this.text.indexOf(needle, this.cursors.get(window) ?? this.parse.lineStarts[first] ?? 0); at !== -1 && at < to; at = this.text.indexOf(needle, at + 1)) {
			const end = this.endFrom(ref, at);
			if (end === -1 || !this.readsAt(ref, at)) continue;
			if (!this.outside) {
				const regions = computeMarkdownRegions(this.text, { html: 'all', inlineHtml: true });
				this.outside = mergeRegions([...regions.codeRegions, ...regions.htmlRegions, ...regions.inlineHtmlRegions]);
			}
			if (isInsideCodeRegion(at, this.outside)) continue;
			this.taken.add(at);
			this.cursors.set(window, end);
			return [at, end];
		}
		return undefined;
	}
}

/** The document's cross-references, in order, as export reads them: a
 *  citation's brackets with one key alone in them, as `[@fig-map]`, a bare
 *  @ and a key after a character CROSS_REF_AFTER_RE doesn't match, and
 *  brackets with one in them among other text, which are text, as the
 *  preview's parser reads them (see parseOf). */
export function scanCrossRefs(text: string): CrossRefUsage[] {
	// None without a key, which saves the parse
	if (!/@[FfTt](?:ig|bl)-/.test(text)) return [];
	const parse = parseOf(text);
	const finder = new SourceFinder(text, parse);
	const usages: CrossRefUsage[] = [];
	// The line of the last block on one, as a pipe table's row, whose
	// cells' inline tokens have none of their own. Not a grid table's, whose
	// rows have none, nor the table's lines, which a grid table's aren't.
	let blockMap: [number, number] | null = null;
	for (const token of parse.tokens) {
		if (token.type !== 'inline') {
			if (token.map) blockMap = token.map[1] - token.map[0] === 1 ? token.map : null;
			continue;
		}
		const map = token.map ?? blockMap;
		// Where each line of its text starts
		const lines: InlineLines | undefined = map ? { map, starts: [0], shifts: [] } : undefined;
		if (lines) for (let at = token.content.indexOf('\n'); at !== -1; at = token.content.indexOf('\n', at + 1)) lines.starts.push(at + 1);
		if (lines) finder.place(token, lines);
		for (const ref of parsedCrossRefs(token.children, [])) {
			// Else, of a token with no lines of its own, anywhere
			const found = finder.find(ref, token, lines) ?? (!token.map && lines ? finder.find(ref, token, undefined) : undefined);
			if (!found) continue;
			const key = ref.form === 'literal' ? '' : ref.key;
			// A bracketed one's @ and key, inside its brackets
			const inside = ref.form === 'bracket' ? 1 : 0;
			usages.push({ key, label: crossRefLabel(key), start: found[0] + inside, end: found[1] - inside, form: ref.form });
		}
	}
	return usages.sort((a, b) => a.start - b.start);
}

/** A diagnostic of the cross-references, from `start` to `end` */
export interface CrossRefProblem {
	start: number;
	end: number;
	message: string;
}

/** The cross-references' problems: a reference to a label no figure or
 *  table has, a label more than one has after the first, and a citation's
 *  brackets with a cross-reference among other text */
export function findCrossRefProblems(text: string): CrossRefProblem[] {
	const problems: CrossRefProblem[] = [];
	const labels = new Set<string>();
	for (const { label, start, end } of scanCrossRefLabels(text)) {
		if (labels.has(label)) problems.push({ start, end, message: 'Another figure or table is labeled {#' + label + '} before this one; its cross-references go to the first.' });
		labels.add(label);
	}
	for (const usage of scanCrossRefs(text)) {
		if (usage.form === 'literal') {
			problems.push({ start: usage.start, end: usage.end, message: 'A cross-reference in a citation\'s brackets with other text, as [-@fig-x], [see @fig-x] or [@fig-a; @fig-b], is text in Word: write @fig-x or [@fig-x] alone.' });
		} else if (!labels.has(usage.label)) {
			problems.push({ start: usage.start, end: usage.end, message: 'No figure or table is labeled {#' + usage.label + '}, so Word gets @' + usage.key + ' as text.' });
		}
	}
	return problems.sort((a, b) => a.start - b.start);
}

/** Where a label completes at `offset`, after an @ in a context export
 *  reads a cross-reference in, with what's typed of it so far, `prefix`,
 *  which `fig-` or `tbl-` can start, its first letter a capital or not */
export interface CrossRefCompletionContext {
	/** Where the label starts, which a completion replaces from */
	replaceStart: number;
	prefix: string;
}

export function getCrossRefCompletionContext(text: string, offset: number): CrossRefCompletionContext | undefined {
	if (offset < 0 || offset > text.length) return undefined;
	let replaceStart = offset;
	while (replaceStart > 0 && /[A-Za-z0-9_-]/.test(text.charAt(replaceStart - 1)) && offset - replaceStart < 200) replaceStart--;
	const prefix = text.slice(replaceStart, offset);
	const lower = crossRefLabel(prefix);
	const begun = lower.length >= 4 ? /^(?:fig|tbl)-/.test(lower) : 'fig-'.startsWith(lower) || 'tbl-'.startsWith(lower);
	if (!begun || text.charAt(replaceStart - 1) !== '@') return undefined;
	const before = text.charAt(replaceStart - 2);
	if (before !== '[' && CROSS_REF_AFTER_RE.test(before)) return undefined;
	if (isInsideCodeRegion(replaceStart - 1, computeCodeRegions(text))) return undefined;
	return { replaceStart, prefix };
}

/** The labels a completion at `context` offers, each once, in order, as
 *  written there: `Fig-` or `Tbl-` after a capital */
export function crossRefCompletions(text: string, context: CrossRefCompletionContext): string[] {
	const seen = new Set<string>();
	const lowerPrefix = crossRefLabel(context.prefix);
	const capital = context.prefix !== lowerPrefix;
	const labels: string[] = [];
	for (const { label } of scanCrossRefLabels(text)) {
		if (seen.has(label) || !label.startsWith(lowerPrefix)) continue;
		seen.add(label);
		labels.push(capital ? label.charAt(0).toUpperCase() + label.slice(1) : label);
	}
	return labels;
}

/** The label the cross-reference at `offset` refers to, where one is, and
 *  where its first figure or table gives it, or undefined */
export function findCrossRefDefinition(text: string, offset: number): CrossRefLabelDefinition | undefined {
	const usage = scanCrossRefs(text).find(found => found.form !== 'literal' && offset >= found.start && offset <= found.end);
	if (!usage) return undefined;
	return scanCrossRefLabels(text).find(definition => definition.label === usage.label);
}
