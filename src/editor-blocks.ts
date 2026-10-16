/**
 * How the editor's decorations and navigation read a document's blocks:
 * where code is, which nothing opens in, and where the text a format
 * highlight may hold ends.
 */

import { type CodeRegion, codeOverlapTest, computeLineStarts, computeMarkdownRegions, formatHighlightLimit, mergeRegions } from './code-regions';
import { preprocessCriticMarkupWithLines } from './critic-markup';
import { normalizeNewlines } from './newlines';

/** How the editor's decorations and navigation read a document's blocks
 *  (see editorBlocks) */
export interface EditorBlocks {
	/** The code spans and blocks, as computeCodeRegions finds them, where
	 *  the editor shows nothing (see dropRangesInCode) */
	codeRegions: CodeRegion[];
	/** Whether code holds `offset`. Nothing opens there: an == or a
	 *  CriticMarkup opener in code pairs with nothing, as export and the
	 *  preview read none in code. A search from an opener before the code
	 *  for its closer still reads the code's text, as theirs does. */
	inCode(offset: number): boolean;
	/** The end of the run of code from `offset`, or `offset` where code
	 *  doesn't hold it */
	codeEnd(offset: number): number;
	/** Where the text that a format highlight opening at `offset` may hold
	 *  ends (see editorBlocks) */
	limitAt(offset: number): number;
	/** Whether [start, end) holds what export may read otherwise than the
	 *  text's parse does: an HTML block, which export reads as HTML, a line
	 *  that may be a link's definition, to the next blank line, or a code
	 *  span whose backticks the parse pairs across blocks, with the text of
	 *  the paragraphs or other blocks it starts and ends in, whose code
	 *  spans export pairs in each block's text alone (see editorBlocks) */
	unsure(start: number, end: number): boolean;
	/** Whether [start, end) holds what unsure reads that holds a
	 *  CriticMarkup opener or an ==, which the editor read before where a
	 *  span or a highlight from code didn't hide it */
	unsureMarks(start: number, end: number): boolean;
}

/**
 * The code and the paragraphs of `text` for the editor's decorations and
 * navigation. A lone == that one read as a highlight's opener, as x == y in
 * a paragraph or keep if foreign == 1 in a Stata block, took the next
 * highlight's opener as its closer, and so on through the document, as an
 * opener in code took the next closer of its kind; export and the preview
 * read each highlight in its paragraph's text alone, and nothing in code.
 *
 * Code is what the text's parse reads, as the editor drops what holds it.
 * A highlight's text ends where a block does in both the text's parse and
 * export's, which reads the blocks after preprocessCriticMarkup joins each
 * span's lines: a span over a line end can take the lines after it into its
 * paragraph, as {++a, then # b++} ==c and d==, which export reads as one
 * paragraph, with c and d highlighted, where the text's parse reads a
 * heading and a paragraph. Where the two differ, a highlight reads on to
 * the next end both share, as the editor read one before. A span across a
 * table's rows, which preprocessing leaves as it is, ends at its row's end
 * to export, so a highlight before it reads its opener as text.
 *
 * Where the editor reads an opener in code or a highlight otherwise than it
 * did before, and the opener, or the closer either reading takes, is in
 * what export may read otherwise than the text's parse (see unsure), it
 * reads it as before. So does an opener in code whose span or highlight
 * before held an opener or an == there (see unsureMarks): it hid them, and
 * where they are in an HTML block, export doesn't read them either. A lone
 * == before an HTML block still pairs with nothing, where before it took a
 * highlight's opener past the block (see extractAllDecorationRanges and
 * navigationMatches).
 */
export function editorBlocks(text: string): EditorBlocks {
	const { codeRegions, blockCodeRegions, inlineBlocks } = computeMarkdownRegions(text, { inlineBlocks: true });
	const lineStarts = computeLineStarts(text);
	const code = new Uint8Array(text.length);
	for (const { start, end } of codeRegions) code.fill(1, start, end);
	// For each offset, the end of the run of code from it, found once
	let runEnds: Int32Array | undefined;
	const unsure = unsureRegions(text, lineStarts, codeRegions, blockCodeRegions, inlineBlocks);
	return {
		codeRegions,
		inCode: offset => code[offset] === 1,
		codeEnd: offset => {
			if (!runEnds) {
				runEnds = new Int32Array(text.length + 1);
				runEnds[text.length] = text.length;
				for (let at = text.length - 1; at >= 0; at--) runEnds[at] = code[at] === 0 ? at : runEnds[at + 1];
			}
			return runEnds[offset];
		},
		limitAt: sharedLimit(text, lineStarts, inlineBlocks),
		unsure: codeOverlapTest(unsure),
		// Each region is read once, as none overlaps another
		unsureMarks: codeOverlapTest(unsure.filter(({ start, end }) => MARK_RE.test(text.slice(start, end)))),
	};
}

/** A CriticMarkup opener or an == */
const MARK_RE = /\{(?:\+\+|--|~~|==|>>|#)|==/;

/** The HTML blocks of `text`, whose lines start at `lineStarts`, the lines
 *  from one that may be a link's definition to the next blank line, and
 *  each of `codeRegions` that is in no code block, of `blockCodeRegions`,
 *  nor in one paragraph's or other block's text, of `inlineBlocks`, nor on
 *  one line, from the start of the text of the one of `inlineBlocks` it
 *  starts in to the end of the one it ends in, sorted and merged (see unsure
 *  in EditorBlocks) */
function unsureRegions(text: string, lineStarts: readonly number[], codeRegions: readonly CodeRegion[], blockCodeRegions: readonly CodeRegion[], inlineBlocks: readonly CodeRegion[]): CodeRegion[] {
	const regions = text.includes('<') ? computeMarkdownRegions(text, { includeCode: false, html: 'all' }).htmlRegions : [];
	const blank = new RegExp(BLANK_LINE_RE.source, 'g');
	// The end of the last definition's lines, which hold any after it
	let definitionsEnd = 0;
	for (const match of text.matchAll(DEFINITION_RE)) {
		if (match.index < definitionsEnd) continue;
		blank.lastIndex = match.index;
		const end = blank.exec(text);
		definitionsEnd = end ? end.index + 1 : text.length;
		regions.push({ start: match.index, end: definitionsEnd });
	}
	for (const region of codeRegions) {
		const within = (outer: CodeRegion | undefined) => outer !== undefined && region.end <= outer.end;
		const startBlock = inlineBlocks[before(inlineBlocks, region.start, r => r.start)];
		if (within(blockCodeRegions[before(blockCodeRegions, region.start, r => r.start)]) || within(startBlock)) continue;
		// The start of the line after the region's first
		const next = lineStarts[before(lineStarts, region.start, start => start) + 1] ?? text.length;
		if (region.end <= next) continue;
		const endBlock = inlineBlocks[before(inlineBlocks, region.end - 1, r => r.start)];
		regions.push({
			start: startBlock !== undefined && startBlock.end > region.start ? startBlock.start : region.start,
			end: endBlock !== undefined && endBlock.end >= region.end ? endBlock.end : region.end,
		});
	}
	return mergeRegions(regions);
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
 *  past a quote's and a list item's markers, or a note's */
const DEFINITION_RE = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+[ \t>]*)?\[[^\]\n]*\]:/gm;
/** A blank line, from the line end before it */
const BLANK_LINE_RE = /\n[ \t>]*(?:\r?\n|$)/;

/**
 * For an offset of `text`, whose lines start at `lineStarts`, the start of
 * the first line after its line before which a block ends both in the
 * text's parse, of `inlineBlocks`, and in the parse of what
 * preprocessCriticMarkup writes for it, as export reads it, at the line it
 * comes from (see preprocessCriticMarkupWithLines), or the text's end. Each
 * block ends as formatHighlightLimit reads it. Each line's is found once,
 * and each offset's line by binary search.
 */
function sharedLimit(text: string, lineStarts: readonly number[], inlineBlocks: readonly CodeRegion[]): (offset: number) => number {
	const lineCount = lineStarts.length;
	const ends = blockEnds(text, lineStarts, formatHighlightLimit(text, inlineBlocks));
	const normalized = normalizeNewlines(text);
	const joined = preprocessCriticMarkupWithLines(normalized);
	if (joined.output !== normalized) {
		const joinedStarts = computeLineStarts(joined.output);
		const joinedBlocks = computeMarkdownRegions(joined.output, { includeCode: false, inlineBlocks: true }).inlineBlocks;
		const joinedEnds = blockEnds(joined.output, joinedStarts, formatHighlightLimit(joined.output, joinedBlocks));
		// The lines of `text` before which a block ends in what it writes
		const shared = new Uint8Array(lineCount + 1);
		for (let line = 0; line < joinedEnds.length; line++) if (joinedEnds[line] === 1) shared[joined.lines[line]] = 1;
		for (let line = 0; line < lineCount; line++) ends[line] &= shared[line];
	}
	// For each line, the first line after it before which a block ends
	const next = new Int32Array(lineCount);
	let nearest = lineCount;
	for (let line = lineCount - 1; line >= 0; line--) {
		next[line] = nearest;
		if (ends[line] === 1) nearest = line;
	}
	return offset => {
		const end = next[Math.max(before(lineStarts, offset, start => start), 0)];
		return end < lineCount ? lineStarts[end] : text.length;
	};
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
