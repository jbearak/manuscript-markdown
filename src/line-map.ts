// Where each line of a preprocessed text comes from in the text it was made
// from. Export preprocesses the Markdown before markdown-it reads it: it
// takes out the frontmatter, the notes' definitions and the notes of
// missing citations, trims the blank lines at the end, writes grid tables
// and embedded files as HTML, formats tables' numbers, puts blank lines in
// after a quote with none and around LaTeX environments, and joins a
// CriticMarkup span's lines.
// Each step says where the lines it wrote come from, and the maps of the
// steps in turn give the line of the Markdown each line markdown-it reads
// comes from, which quote and comment spacing read the blank lines around
// (see annotateBlockquoteSpacing and parseMd in md-to-docx.ts).
//
// Each line of the output, and one past its last, comes from a line of the
// input, in order:
//
// - A line that holds a character copied from the input, as its line end
//   can be, and isn't blank, comes from the line of the first.
// - A blank line, of no characters but spaces, tabs and its line end, or a
//   line that holds no copied character, which a step wrote or put in, comes
//   from a line from A to B, where B is the line of the first character
//   copied in it or after it, or the input's last where none is, and A the
//   line after that of the last copied before it, or the first where none
//   was, or B where that's sooner: the line it was put in before, or one it
//   was written in place of. linesAfterEdits takes A, as does the step that
//   takes out notes' definitions, and the steps that work by lines say which
//   they take.
// - One past the output's last line comes from one past the input's last.
//
// So a block goes from the line of its first line, which isn't blank, to
// the line of the line after its last, which, where the block holds a
// copied character, is after the line of the last it holds, as no step puts
// a line end between two characters of one line. Where that line is blank,
// as where the blank lines after a block are, it's the line after the
// block's last, though a step took out the lines after the block, as the
// note of a missing citation, which stood there as a line of text. A
// block's lines in the input are those, and the blank lines before and
// after them are the input's around it.

/** For each line of a text, and one past its last, the line of the text it
 *  was made from that it comes from, in order */
export type LineMap = number[];

/** Where each edit replaces [start, end) of a text with `text` */
export interface LineEdit { start: number; end: number; text: string }

/** A line end as markdown-it reads one: a line feed, or a carriage return
 *  alone or before one, which `at` is the last character of */
function endsLine(text: string, at: number): boolean {
  return text[at] === '\n' || (text[at] === '\r' && text[at + 1] !== '\n');
}

/** The number of lines of `text` */
export function lineCount(text: string): number {
  let count = 1;
  for (let at = 0; at < text.length; at++) if (endsLine(text, at)) count++;
  return count;
}

/** Each of `count` lines, and one past them, from its own line */
export function sameLines(count: number): LineMap {
  return Array.from({ length: count + 1 }, (_, line) => line);
}

/** `lines`, for each line of a text the line it comes from, with one past
 *  the last, which comes from one past the last of the `count` it was made
 *  from, as a step that copies each line keeps them */
export function withEnd(lines: readonly number[], count: number): LineMap {
  return [...lines, count];
}

/** The lines of a text in `outer`'s source, from `inner`, its lines in the
 *  text it was made from, and `outer`, that text's lines in its own */
export function throughLines(inner: readonly number[], outer: readonly number[]): LineMap {
  return inner.map(line => outer[Math.min(line, outer.length - 1)]);
}

/** Whether `text` is a blank line, as markdown-it reads one */
const isBlank = (text: string) => /^[ \t]*$/.test(text);

/** The lines of `input` with `edits` made to it, in order and apart, in
 *  `input`, as the contract above has them, character by character: a
 *  blank line, or one with no copied character, from the line after the
 *  last copied before it, or the line of the next where that's sooner */
export function linesAfterEdits(input: string, edits: Iterable<LineEdit>): LineMap {
  // The output in pieces, each copied from the input at `from`, or written
  const pieces: Array<{ text: string; from?: number }> = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start > cursor) pieces.push({ text: input.slice(cursor, edit.start), from: cursor });
    if (edit.text.length > 0) pieces.push({ text: edit.text });
    cursor = edit.end;
  }
  if (cursor < input.length) pieces.push({ text: input.slice(cursor), from: cursor });
  // Where the output's lines end, which a piece's last character can't tell
  // alone, as a carriage return copied before a line feed written
  const output = pieces.map(piece => piece.text).join('');
  // The line of `input` at `inputAt`
  let line = 0;
  let inputAt = 0;
  const lineAt = (position: number) => {
    for (; inputAt < position; inputAt++) if (endsLine(input, inputAt)) line++;
    return line;
  };
  // For each output line, the line after that of the last character copied
  // before it, the line of its first copied character, and whether it's
  // blank, by its text without its line end
  const afters: number[] = [];
  const firsts: Array<number | undefined> = [];
  const blanks: boolean[] = [];
  let after = 0;
  let first: number | undefined;
  let lineStart = 0;
  let at = 0;
  // The line after the last copied character before the line being written
  let afterAtStart = 0;
  for (const piece of pieces) {
    for (let k = 0; k < piece.text.length; k++, at++) {
      if (piece.from !== undefined) {
        const from = lineAt(piece.from + k);
        first ??= from;
        after = from + 1;
      }
      if (endsLine(output, at)) {
        afters.push(afterAtStart);
        firsts.push(first);
        blanks.push(isBlank(output.slice(lineStart, at + 1).replace(/\r?\n$|\r$/, '')));
        afterAtStart = after;
        first = undefined;
        lineStart = at + 1;
      }
    }
  }
  afters.push(afterAtStart);
  firsts.push(first);
  blanks.push(isBlank(output.slice(lineStart)));
  const last = lineAt(input.length);
  const lines: LineMap = new Array(firsts.length);
  // The line of the first character copied in the line or after it
  let next = last;
  for (let k = firsts.length - 1; k >= 0; k--) {
    const own = firsts[k];
    if (own !== undefined) next = own;
    lines[k] = own !== undefined && !blanks[k] ? own : Math.min(afters[k], next);
  }
  lines.push(last + 1);
  return lines;
}
