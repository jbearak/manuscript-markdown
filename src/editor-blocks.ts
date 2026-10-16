/**
 * How the editor's decorations and navigation read a document's blocks:
 * where the text a format highlight may hold ends, and where they read a
 * highlight as they did before.
 */

import { type CodeRegion, codeOverlapTest, computeLineStarts, computeMarkdownRegions, formatHighlightLimit, mergeRegions } from './code-regions';
import { preprocessBlocks } from './block-preprocess';
import { preprocessCriticMarkupWithLines } from './critic-markup';
import { normalizeNewlines } from './newlines';

/** How the editor's decorations and navigation read a document's blocks
 *  (see editorBlocks) */
export interface EditorBlocks {
	/** The code spans and blocks, as computeCodeRegions finds them, where
	 *  the editor shows nothing (see dropRangesInCode) */
	codeRegions: CodeRegion[];
	/** Where the text that a format highlight opening at `offset` may hold
	 *  ends (see editorBlocks) */
	limitAt(offset: number): number;
	/** Whether [start, end) holds what export may read in other blocks than
	 *  the text's parse does: an HTML block, which export reads as HTML, a
	 *  line that may be a link's definition, to the next blank line, or a
	 *  line export's block preprocessing rewrites, as a quote's lazy line,
	 *  which it ends the quote before (see editorBlocks) */
	unsure(start: number, end: number): boolean;
	/** Whether the paragraph's text that holds `offset`, which ends where
	 *  its line's limitAt does, holds an == that export may read as text:
	 *  one in code, or in what may be inline HTML, an autolink, a link's text
	 *  or destination, or math (see inertMarks), or whether it is the text
	 *  of a block that a code span whose backticks the parse pairs across
	 *  blocks starts or ends in, whose code spans export pairs in that block
	 *  alone (see editorBlocks) */
	inertMarks(offset: number): boolean;
	/** Whether `offset` starts a CriticMarkup opener, an HTML comment's or
	 *  a ~~ that export may read as text, as inertMarks reads an == */
	inertOpener(offset: number): boolean;
}

/**
 * The paragraphs of `text` for the editor's decorations and navigation. A
 * lone == that one read as a highlight's opener, as x == y in a paragraph
 * or keep if foreign == 1 in a Stata block, took the next highlight's
 * opener as its closer, and so on through the document; export and the
 * preview read each highlight in its paragraph's text alone, and in a
 * table's cell's.
 *
 * A highlight's text ends where a block does in both the text's parse and
 * export's, which reads the blocks after preprocessCriticMarkup joins each
 * span's lines: a span over a line end can take the lines after it into its
 * paragraph, as {++a, then # b++} ==c and d==, which export reads as one
 * paragraph, with c and d highlighted, where the text's parse reads a
 * heading and a paragraph. Where the two differ, a highlight reads on to
 * the next end both share, as the editor read one before. A span across a
 * table's rows, which preprocessing leaves as it is, ends at its cell's end
 * to export, so a highlight before it reads its opener as text.
 *
 * Code is read as before: an == or an opener there pairs as any other, and
 * the editor drops what holds code. So a paragraph's text is read as
 * before, but from its own start, as export reads it, but where it holds an
 * == that export may read as text, as one in code or in inline HTML (see
 * inertMarks). There a highlight is one the editor read before, which may
 * have read on from a paragraph before, where it stays in this paragraph's
 * text. Navigation reads a match from an opener that export may read as
 * text as before too (see inertOpener): a highlight's match it read before
 * may have taken that opener. Where the editor reads a highlight otherwise
 * than it did before, and its opener, or the closer either reading takes,
 * is in what export may read in other blocks (see unsure), it reads it as
 * before, wherever that ends. As before is what the editor read before over
 * the whole text, read once: the highlight or match it read from that
 * opener, or none, where it read that == as text or as another's closer
 * (see extractAllDecorationRanges and navigationMatches).
 */
export function editorBlocks(text: string): EditorBlocks {
	const { codeRegions, blockCodeRegions, inlineBlocks, tableRegions } = computeMarkdownRegions(text, { inlineBlocks: true, includeTables: true });
	const lineStarts = computeLineStarts(text);
	const htmlRegions = text.includes('<') ? computeMarkdownRegions(text, { includeCode: false, html: 'all' }).htmlRegions : [];
	const unsure = mergeRegions([...htmlRegions, ...definitionRegions(text, lineStarts), ...blockRewrites(text, lineStarts)]);
	const { limitAt, paragraphAt } = sharedLimit(text, lineStarts, inlineBlocks, tableRegions);
	const { paragraphs: inert, openers } = inertMarks(text, lineStarts, codeRegions, paragraphAt);
	// The paragraphs a code span whose backticks pair across blocks starts
	// and ends in
	for (const region of codeRegions) {
		if (!acrossBlocks(region, text, lineStarts, blockCodeRegions, inlineBlocks)) continue;
		inert[paragraphAt(region.start)] = 1;
		inert[paragraphAt(region.end - 1)] = 1;
	}
	return {
		codeRegions,
		limitAt,
		unsure: codeOverlapTest(unsure),
		inertMarks: offset => inert[paragraphAt(offset)] === 1,
		inertOpener: offset => openers[offset] === 1,
	};
}

/**
 * The marks of `text` that export may read as text: each in code, of
 * `codeRegions`, or after an unescaped <, as in inline HTML or an
 * autolink, or after a tag, which the preview pairs no highlight across
 * where export does, after a [ with no ] after it, as in a link's text,
 * after a ]( with no ) after it, as in a link's destination, or after an
 * unescaped $, as in math, each outside code and in that mark's paragraph.
 * For each paragraph, by its paragraphAt (see sharedLimit), whether it
 * holds such an ==, and for each offset, whether it starts such an opener
 * of a CriticMarkup span or an HTML comment, or such a ~~ (see isOpener).
 * Each character is read once.
 */
function inertMarks(text: string, lineStarts: readonly number[], codeRegions: readonly CodeRegion[], paragraphAt: (offset: number) => number): { paragraphs: Uint8Array; openers: Uint8Array } {
	const paragraphs = new Uint8Array(lineStarts.length + 1);
	const openers = new Uint8Array(text.length);
	const code = new Uint8Array(text.length);
	for (const { start, end } of codeRegions) code.fill(1, start, end);
	let paragraph = -1;
	let html = false;
	let bracket = false;
	let destination = false;
	let math = false;
	// The backslashes just before
	let backslashes = 0;
	for (let line = 0; line < lineStarts.length; line++) {
		const at = lineStarts[line];
		if (paragraphAt(at) !== paragraph) {
			paragraph = paragraphAt(at);
			html = bracket = destination = math = false;
		}
		const lineEnd = lineStarts[line + 1] ?? text.length;
		for (let k = at; k < lineEnd; k++) {
			const ch = text.charCodeAt(k);
			if (code[k] === 1 || code[k + 1] === 1 || html || bracket || destination || math) {
				if (ch === 0x3D && text.charCodeAt(k + 1) === 0x3D) paragraphs[paragraph] = 1;
				else if (isOpener(text, k)) openers[k] = 1;
			}
			if (code[k] === 1) {
				backslashes = 0;
				continue;
			}
			const escaped = backslashes % 2 === 1;
			backslashes = ch === 0x5C ? backslashes + 1 : 0;
			if (escaped) continue;
			if (ch === 0x3C) html = true; // <
			else if (ch === 0x5B) bracket = true; // [
			else if (ch === 0x5D) { // ]
				bracket = false;
				if (text.charCodeAt(k + 1) === 0x28) destination = true; // (
			} else if (ch === 0x29) destination = false; // )
			else if (ch === 0x24) math = true; // $
		}
	}
	return { paragraphs, openers };
}

/** Whether `text` has at `at` a ~~, or the opener of a CriticMarkup span or
 *  an HTML comment */
function isOpener(text: string, at: number): boolean {
	const ch = text.charCodeAt(at);
	const next = text.charCodeAt(at + 1);
	if (ch === 0x7E) return next === ch; // ~~
	if (ch === 0x3C) return text.startsWith('!--', at + 1); // <!--
	if (ch !== 0x7B) return false; // {
	return next === 0x23 || next === 0x2F || (next === text.charCodeAt(at + 2) && (next === 0x2B || next === 0x2D || next === 0x7E || next === 0x3D || next === 0x3E));
}

/** Whether `region`, a code region of `text`, whose lines start at
 *  `lineStarts`, is in no code block, of `blockCodeRegions`, nor in one
 *  paragraph's or other block's text, of `inlineBlocks`, nor on one line:
 *  a code span whose backticks the parse pairs across blocks */
function acrossBlocks(region: CodeRegion, text: string, lineStarts: readonly number[], blockCodeRegions: readonly CodeRegion[], inlineBlocks: readonly CodeRegion[]): boolean {
	const within = (outer: CodeRegion | undefined) => outer !== undefined && region.end <= outer.end;
	if (within(blockCodeRegions[before(blockCodeRegions, region.start, r => r.start)]) || within(inlineBlocks[before(inlineBlocks, region.start, r => r.start)])) return false;
	// The start of the line after the region's first
	const next = lineStarts[before(lineStarts, region.start, start => start) + 1] ?? text.length;
	return region.end > next;
}

/** The lines of `text`, whose lines start at `lineStarts`, from each that
 *  may be a link's definition to the next blank line, sorted. Each line is
 *  read on its own (see DEFINITION_RE) */
function definitionRegions(text: string, lineStarts: readonly number[]): CodeRegion[] {
	const regions: CodeRegion[] = [];
	const definition = new RegExp(DEFINITION_RE.source, 'y');
	const blank = new RegExp(BLANK_LINE_RE.source, 'g');
	// The end of the last definition's lines, which hold any after it
	let definitionsEnd = 0;
	for (const start of lineStarts) {
		if (start < definitionsEnd) continue;
		definition.lastIndex = start;
		if (!definition.test(text)) continue;
		blank.lastIndex = start;
		const end = blank.exec(text);
		definitionsEnd = end ? end.index + 1 : text.length;
		regions.push({ start, end: definitionsEnd });
	}
	return regions;
}

/** The lines of `text`, whose lines start at `lineStarts`, that export's
 *  block preprocessing rewrites, drops or puts a line before (see
 *  preprocessBlocks), as a quote's lazy line, before which it ends the
 *  quote, a grid table's or a bare LaTeX environment's */
function blockRewrites(text: string, lineStarts: readonly number[]): CodeRegion[] {
	const normalized = normalizeNewlines(text);
	const blocks = preprocessBlocks(normalized);
	if (blocks.output === normalized) return [];
	const lines = normalized.split('\n');
	const outLines = blocks.output.split('\n');
	// For each line, how many lines are written for it, and whether one of
	// them differs from it
	const written = new Uint32Array(lines.length);
	const rewritten = new Uint8Array(lines.length);
	for (let at = 0; at < outLines.length; at++) {
		const line = blocks.lines[at];
		written[line]++;
		if (outLines[at] !== lines[line]) rewritten[line] = 1;
	}
	const regions: CodeRegion[] = [];
	for (let line = 0; line < lines.length; line++) {
		if (written[line] === 1 && rewritten[line] === 0) continue;
		regions.push({ start: lineStarts[line] ?? text.length, end: lineStarts[line + 1] ?? text.length });
	}
	return regions;
}

/** The index of the last of `sorted` whose `start` is at or before
 *  `offset`, or -1, by binary search */
function before<T>(sorted: readonly T[], offset: number, start: (item: T) => number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (start(sorted[mid]) <= offset) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

/** A line that may be a link's definition, as [1]: https://example.com,
 *  past a quote's and a list item's markers, or a note's, read from a
 *  line's start. No part of it reads past the line's end, a line feed or a
 *  carriage return, so each line is read in time linear in it. The spaces
 *  after a list item's marker and the quote markers after them are read by
 *  repetitions that don't overlap, so a line that isn't one is rejected in
 *  time linear in it */
const DEFINITION_RE = /[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:>[ \t>]*)?)?\[[^\]\n\r]*\]:/;
/** A blank line, from the line end before it */
const BLANK_LINE_RE = /\n[ \t>]*(?:\r?\n|$)/;

/**
 * For an offset of `text`, whose lines start at `lineStarts`, the start of
 * the first line after its line before which a block ends both in the
 * text's parse, of `inlineBlocks`, and in the parse of what
 * preprocessCriticMarkup writes for it, as export reads it, at the line it
 * comes from (see preprocessCriticMarkupWithLines), or the text's end: its
 * limitAt. On a table's row, of `tableRegions`, that both parses read, and
 * preprocessing writes as it is, the end of its cell, at the next | that no
 * backslash comes just before, as markdown-it splits a row, as export reads
 * each cell's text alone. And its paragraphAt, which is the line its line's
 * limit is at, or the number of lines. Each block ends as
 * formatHighlightLimit reads it. Each line's is found once, each cell's end
 * once, and each offset's line by binary search.
 */
function sharedLimit(text: string, lineStarts: readonly number[], inlineBlocks: readonly CodeRegion[], tableRegions: readonly CodeRegion[]): { limitAt(offset: number): number; paragraphAt(offset: number): number } {
	const lineCount = lineStarts.length;
	const lineOf = (offset: number) => Math.max(before(lineStarts, offset, start => start), 0);
	const ends = blockEnds(text, lineStarts, formatHighlightLimit(text, inlineBlocks));
	const rows = tableLines(lineStarts, tableRegions);
	const normalized = normalizeNewlines(text);
	const joined = preprocessCriticMarkupWithLines(normalized);
	if (joined.output !== normalized) {
		const joinedStarts = computeLineStarts(joined.output);
		const joinedRegions = computeMarkdownRegions(joined.output, { includeCode: false, inlineBlocks: true, includeTables: true });
		const joinedEnds = blockEnds(joined.output, joinedStarts, formatHighlightLimit(joined.output, joinedRegions.inlineBlocks));
		// The lines of `text` before which a block ends in what it writes
		const shared = new Uint8Array(lineCount + 1);
		for (let line = 0; line < joinedEnds.length; line++) if (joinedEnds[line] === 1) shared[joined.lines[line]] = 1;
		for (let line = 0; line < lineCount; line++) ends[line] &= shared[line];
		// The rows it writes as they are, once, in a table
		const joinedRows = tableLines(joinedStarts, joinedRegions.tableRegions);
		const lines = normalized.split('\n');
		const outLines = joined.output.split('\n');
		const written = new Uint32Array(lineCount);
		const kept = new Uint8Array(lineCount);
		for (let line = 0; line < outLines.length; line++) {
			const source = joined.lines[line];
			written[source]++;
			if (joinedRows[line] === 1 && outLines[line] === lines[source]) kept[source] = 1;
		}
		for (let line = 0; line < lineCount; line++) rows[line] &= written[line] === 1 ? kept[line] : 0;
	}
	// For each line, the first line after it before which a block ends
	const next = new Int32Array(lineCount);
	let nearest = lineCount;
	for (let line = lineCount - 1; line >= 0; line--) {
		next[line] = nearest;
		if (ends[line] === 1) nearest = line;
	}
	// For each offset on a row, the end of its cell, found once
	let cellEnds: Int32Array | undefined;
	const cellEnd = (offset: number): number => {
		if (!cellEnds) {
			cellEnds = new Int32Array(text.length + 1);
			for (let line = 0; line < lineCount; line++) {
				if (rows[line] === 0) continue;
				let end = lineStarts[line + 1] ?? text.length;
				for (let at = end - 1; at >= lineStarts[line]; at--) {
					if (text.charCodeAt(at) === 0x7C && text.charCodeAt(at - 1) !== 0x5C) end = at;
					cellEnds[at] = end;
				}
			}
		}
		return cellEnds[offset];
	};
	const paragraphAt = (offset: number) => next[lineOf(offset)];
	return {
		limitAt: offset => {
			const line = lineOf(offset);
			const end = next[line] < lineCount ? lineStarts[next[line]] : text.length;
			return rows[line] === 1 ? Math.min(end, cellEnd(offset)) : end;
		},
		paragraphAt,
	};
}

/** For each line, whose starts are `lineStarts`, whether one of
 *  `tableRegions`, which start at lines' starts, holds it */
function tableLines(lineStarts: readonly number[], tableRegions: readonly CodeRegion[]): Uint8Array {
	const rows = new Uint8Array(lineStarts.length);
	for (const { start, end } of tableRegions) {
		for (let line = before(lineStarts, start, at => at); line < lineStarts.length && lineStarts[line] < end; line++) rows[line] = 1;
	}
	return rows;
}

/** For each line of `text`, whose starts are `lineStarts`, and one past its
 *  last, which stands for its end, whether a block ends before it, as
 *  `limit` reads one (see formatHighlightLimit) */
function blockEnds(text: string, lineStarts: readonly number[], limit: (offset: number) => number): Uint8Array {
	const ends = new Uint8Array(lineStarts.length + 1);
	ends[lineStarts.length] = 1;
	// Each line's limit is a line's start, the same or later than the last
	let at = 0;
	for (const start of lineStarts) {
		const end = limit(start);
		if (end >= text.length) continue;
		while (lineStarts[at] < end) at++;
		ends[at] = 1;
	}
	return ends;
}
