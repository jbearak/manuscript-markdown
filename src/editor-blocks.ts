/**
 * How the editor's decorations and navigation read a document's blocks:
 * where code is, where nothing opens, and where the text a format highlight
 * may hold ends.
 */

import { type CodeRegion, computeMarkdownRegions, formatHighlightLimit } from './code-regions';
import { linkHoldsCriticBreak, preprocessCriticMarkupWithOffsets } from './critic-markup';
import { normalizeNewlines } from './newlines';

/** How the editor's decorations and navigation read a document's blocks
 *  (see editorBlocks) */
export interface EditorBlocks {
	/** The code spans and blocks, as computeCodeRegions finds them */
	codeRegions: CodeRegion[];
	/** Whether code holds `offset`, as export and the preview read the
	 *  blocks (see editorBlocks) */
	inCode(offset: number): boolean;
	/** Whether code, an HTML block or a link's definition holds `offset`,
	 *  as export and the preview read the blocks, where nothing opens: an ==
	 *  or a CriticMarkup opener there pairs with nothing, as they read none
	 *  there. A search from an opener before the code for its closer still
	 *  reads the code's text, as theirs does. */
	inert(offset: number): boolean;
	/** The end of the run of characters from `offset` that inert reads
	 *  true of, or `offset` where it reads it false */
	inertEnd(offset: number): number;
	/** Where the text that a format highlight opening at `offset` may hold
	 *  ends: its paragraph's end, as export and the preview read the blocks
	 *  (see formatHighlightLimit) */
	limitAt(offset: number): number;
}

/**
 * The code and the paragraphs of `text` for the editor's decorations and
 * navigation. A lone == that one read as a highlight's opener, as x == y in
 * a paragraph or keep if foreign == 1 in a Stata block, took the next
 * highlight's opener as its closer, and so on through the document, as an
 * opener in code took the next closer of its kind; export and the preview
 * read each highlight in its paragraph's text alone, and nothing in code.
 *
 * They read the blocks after preprocessCriticMarkup joins each CriticMarkup
 * span's lines, so a span over a line end can take the lines after it into
 * its paragraph, as {++a, then # b++} ==c and d==, which they read as one
 * paragraph, with c and d highlighted, where a parse of the text reads a
 * heading and a paragraph. A line of code there is text to them, and a
 * fence line in a span is, so the next fence line opens a block where the
 * parse closed one. So where preprocessing changes the text, the blocks
 * are read from what it writes, by the offsets it comes from (see
 * preprocessCriticMarkupWithOffsets). And they read HTML, so a line that
 * starts with <!-- or <div> starts a block that holds no Markdown, as a
 * link's definition, as [1]: {++a++}, holds none. Main read an opener in
 * code as one, which hid the spans up to its closer, as those in such a
 * block after it. The text is parsed once where neither can change what it
 * reads, as in a text with no span over a line end and no <.
 */
export function editorBlocks(text: string): EditorBlocks {
	const raw = computeMarkdownRegions(text, { inlineBlocks: true, definitions: true });
	const read = readsAfterPreprocessing(text);
	// The text they read, and its offsets in the document's and back
	const readText = read?.output ?? text;
	const toText = read ? read.fromOutput : (offset: number) => offset;
	const fromText = read ? read.toOutput : (offset: number) => offset;
	const blocks = read || text.includes('<')
		? computeMarkdownRegions(readText, { html: 'all', inlineBlocks: true, definitions: true, linkCheck: url => !linkHoldsCriticBreak(url) })
		: raw;
	// 1 in code, 2 in an HTML block or a link's definition
	const kinds = new Uint8Array(text.length);
	// Each region's characters, and those preprocessing took out between
	// them, as a quote's markers in a span
	const fill = ({ start, end }: CodeRegion, kind: number) => {
		if (end > start) kinds.fill(kind, toText(start), toText(end - 1) + 1);
	};
	for (const region of blocks.htmlRegions) fill(region, 2);
	// A link's definition, but not a note's, whose text export reads as the
	// note's (see extractFootnoteDefinitions in md-to-docx.ts)
	for (const region of blocks.definitionRegions) if (!FOOTNOTE_LINE_RE.test(readText.slice(region.start, region.end))) fill(region, 2);
	for (const region of blocks.codeRegions) fill(region, 1);
	const readLimit = formatHighlightLimit(readText, blocks.inlineBlocks);
	// For each offset, the end of the run inert reads from it, found once
	let runEnds: Int32Array | undefined;
	return {
		codeRegions: raw.codeRegions,
		inCode: offset => kinds[offset] === 1,
		inert: offset => kinds[offset] !== 0,
		inertEnd: offset => {
			if (!runEnds) {
				runEnds = new Int32Array(text.length + 1);
				runEnds[text.length] = text.length;
				for (let at = text.length - 1; at >= 0; at--) runEnds[at] = kinds[at] === 0 ? at : runEnds[at + 1];
			}
			return runEnds[offset];
		},
		limitAt: offset => toText(readLimit(fromText(offset))),
	};
}

/** A line whose first [ starts a note's label, as [^1]: */
const FOOTNOTE_LINE_RE = /^[^[\n]*\[\^/;

/** What preprocessCriticMarkup writes for `text`, read with its line ends
 *  as markdown-it reads them (see normalizeNewlines), and the offsets of
 *  each in the other: for an offset of what it writes, and one past its
 *  end, the offset of `text` it comes from, and for an offset of `text`,
 *  and one past its end, the first of what it writes that comes from it or
 *  after it. None where it writes the text as it is. */
function readsAfterPreprocessing(text: string): { output: string; fromOutput(offset: number): number; toOutput(offset: number): number } | undefined {
	const normalized = normalizeNewlines(text);
	const { output, offsets } = preprocessCriticMarkupWithOffsets(normalized);
	if (!offsets) return undefined;
	// For each offset of `text`, and one past its end, the offset of the
	// normalized text, where a \r\n is a \n, and the reverse, its \r's
	const toNormalized = new Int32Array(text.length + 1);
	const fromNormalized = new Int32Array(normalized.length + 1);
	for (let at = 0, n = 0; at <= text.length; at++) {
		// A \r\n's \n, whose line end is its \r's
		if (at > 0 && text.charCodeAt(at - 1) === 0x0D && text.charCodeAt(at) === 0x0A) {
			toNormalized[at] = n - 1;
			continue;
		}
		toNormalized[at] = n;
		fromNormalized[n++] = at;
	}
	// The first offset of the output from the normalized offset or after it,
	// as `offsets` never goes down
	const toOutput = new Int32Array(normalized.length + 1);
	for (let n = 0, at = 0; n <= normalized.length; n++) {
		while (offsets[at] < n) at++;
		toOutput[n] = at;
	}
	return {
		output,
		fromOutput: offset => fromNormalized[offsets[offset]],
		toOutput: offset => toOutput[toNormalized[offset]],
	};
}
