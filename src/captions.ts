// Figure captions, in Quarto's syntax, which export, import and the
// preview read alike: an image alone in its paragraph, with a `fig-` label
// in the attribute block after it, as `![Caption](img.png){#fig-x}`, is a
// figure, numbered in document order, whose caption Word gets as a Caption
// paragraph with "Figure " and a SEQ field, in a bookmark a cross-reference
// can point at (see figureCaptionXml in md-to-docx.ts and readFigureCaptions
// in converter.ts).
//
// A `{#fig-…}` or `{#tbl-…}` is a caption's label, never a comment's range
// start, as Quarto reserves the two prefixes. Export, the preview, the
// grammar and navigation read it so; a {/fig-…} still ends a range, and a
// body {#fig-…>>…<<} is still a comment's.

import { decodeHtmlCharacterReferences } from './html-entities';
import type { Frontmatter } from './frontmatter';

/** Whether `id`, the ID in a `{#id}`, is a caption's label, `fig-` or `tbl-`
 *  and more, which is no comment's range start */
export function isCaptionLabelId(id: string): boolean {
  return id.length > 4 && (id.startsWith('fig-') || id.startsWith('tbl-'));
}

/** A figure's label as Quarto writes one: `fig-` and the characters of a
 *  comment's ID */
export const FIGURE_LABEL_RE = /^fig-[A-Za-z0-9_-]+$/;

/** An attribute block's attributes, as Pandoc writes them after an image:
 *  `#id`, `.class`, `key=value` and `key="value"`, in order */
export interface AttributeBlock {
  id?: string;
  classes: string[];
  attributes: Array<[string, string]>;
}

/**
 * The attributes in `inner`, the text inside an attribute block's braces,
 * as `#fig-x width=640 fig-alt="A \"map\""`, or undefined where it reads as
 * none: a value in quotes takes a backslash's escape of the character after
 * it, and its character references are read, so `&#10;` is a line end and
 * `&#125;` a }, which import writes for those. A bare value goes to the
 * next whitespace. A second `#id` is undefined, as Pandoc reads none.
 */
export function parseAttributeBlock(inner: string): AttributeBlock | undefined {
  const block: AttributeBlock = { classes: [], attributes: [] };
  let at = 0;
  const skipSpace = () => { while (at < inner.length && /\s/.test(inner[at])) at++; };
  skipSpace();
  while (at < inner.length) {
    const ch = inner[at];
    if (ch === '#' || ch === '.') {
      let end = at + 1;
      while (end < inner.length && !/\s/.test(inner[end])) end++;
      const name = inner.slice(at + 1, end);
      if (!name) return undefined;
      if (ch === '#') {
        if (block.id !== undefined) return undefined;
        block.id = name;
      } else {
        block.classes.push(name);
      }
      at = end;
    } else {
      const key = /^[A-Za-z_][A-Za-z0-9_:.-]*=/.exec(inner.slice(at));
      if (!key) return undefined;
      at += key[0].length;
      let value = '';
      if (inner[at] === '"') {
        at++;
        let closed = false;
        while (at < inner.length) {
          const c = inner[at];
          if (c === '\\' && at + 1 < inner.length) {
            value += inner[at + 1];
            at += 2;
          } else if (c === '"') {
            at++;
            closed = true;
            break;
          } else {
            value += c;
            at++;
          }
        }
        if (!closed) return undefined;
        value = decodeHtmlCharacterReferences(value);
      } else {
        const start = at;
        while (at < inner.length && !/\s/.test(inner[at])) at++;
        value = inner.slice(start, at);
      }
      block.attributes.push([key[0].slice(0, -1), value]);
    }
    if (at < inner.length && !/\s/.test(inner[at])) return undefined;
    skipSpace();
  }
  return block;
}

/** The value of attribute `name` in `block`, the last one written */
export function attributeValue(block: AttributeBlock, name: string): string | undefined {
  let value: string | undefined;
  for (const [key, written] of block.attributes) if (key === name) value = written;
  return value;
}

/** A figure's attribute block, after its image, as `{#fig-map width=640}` */
export interface FigureAttributes {
  label: string;
  block: AttributeBlock;
  /** The block as written, inside its braces */
  written: string;
  /** Where it ends in the text, past its } */
  end: number;
}

/**
 * The figure's attribute block at `pos` in `src`, before `max`: `{#fig-`,
 * then the text to the first }, with no { or line end in it, which
 * parseAttributeBlock reads, with a figure's label as its ID. A } or { in
 * a value in quotes is written as a reference, as `&#125;`. `next` finds
 * the next of a character at or after an index (see nextIndexFinder),
 * which keeps the search for each image's block from going over the text
 * after it again.
 */
export function figureAttributesAt(src: string, pos: number, max: number, next: (ch: string, from: number) => number): FigureAttributes | undefined {
  if (!src.startsWith('{#fig-', pos)) return undefined;
  const close = next('}', pos);
  if (close < 0 || close >= max) return undefined;
  const open = next('{', pos + 1);
  const lineEnd = next('\n', pos);
  if (open >= 0 && open < close || lineEnd >= 0 && lineEnd < close) return undefined;
  const written = src.slice(pos + 1, close);
  const block = parseAttributeBlock(written);
  if (!block?.id || !FIGURE_LABEL_RE.test(block.id)) return undefined;
  return { label: block.id, block, written, end: close + 1 };
}

/**
 * A finder of the next of a character in `src` at or after an index, which
 * keeps the last it found of each character, so that over calls whose
 * indices only grow, as a parse's from the start of its text to the end,
 * it reads the text once for each character.
 */
export function nextIndexFinder(src: string): (ch: string, from: number) => number {
  const found = new Map<string, [number, number]>();
  return (ch, from) => {
    const last = found.get(ch);
    if (last && from >= last[0] && (last[1] < 0 || from <= last[1])) return last[1];
    const at = src.indexOf(ch, from);
    found.set(ch, [from, at]);
    return at;
  };
}

/** `value` as an attribute's value in quotes that parseAttributeBlock reads
 *  back as it is: a \ and a " escaped, and a line end, an &, a { and a }
 *  as character references, so the block stays on its line and ends at its
 *  } (see figureAttributesAt) */
export function quotedAttributeValue(value: string): string {
  return '"' + value.replace(/[\\"&\n\r{}]/g, c =>
    c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '&' ? '&amp;' : c === '\n' ? '&#10;' : c === '\r' ? '&#13;' : c === '{' ? '&#123;' : '&#125;') + '"';
}

/** What a Word caption's paragraph has of its label (see
 *  captionParagraphOf in converter.ts) */
export interface CaptionParagraph {
  /** Its SEQ field's identifier, as Figure, which numbers its series */
  identifier: string;
  /** Its text before the field, as `Figure ` */
  before: string;
  /** The field's result, its number as Word last updated it */
  result: string;
  /** The names of the bookmarks that start in it */
  bookmarks: string[];
}

/** Where a figure's caption goes, as Quarto's fig-cap-location says */
export type CaptionLocation = 'top' | 'bottom';

/** The words and separator a caption shows, from the frontmatter's Quarto
 *  keys: `crossref`'s fig-title, tbl-title and title-delim, and
 *  fig-cap-location */
export interface CaptionOptions {
  figTitle: string;
  tblTitle: string;
  titleDelim: string;
  figCapLocation: CaptionLocation;
}

export const DEFAULT_CAPTION_OPTIONS: Readonly<CaptionOptions> = { figTitle: 'Figure', tblTitle: 'Table', titleDelim: ':', figCapLocation: 'bottom' };

/** The caption options the frontmatter `fm` sets, Quarto's defaults for
 *  the rest */
export function captionOptions(fm: Frontmatter | undefined): CaptionOptions {
  return {
    figTitle: fm?.crossref?.figTitle ?? DEFAULT_CAPTION_OPTIONS.figTitle,
    tblTitle: fm?.crossref?.tblTitle ?? DEFAULT_CAPTION_OPTIONS.tblTitle,
    titleDelim: fm?.crossref?.titleDelim ?? DEFAULT_CAPTION_OPTIONS.titleDelim,
    figCapLocation: fm?.figCapLocation ?? DEFAULT_CAPTION_OPTIONS.figCapLocation,
  };
}

/** What follows a caption's number before its text: the delimiter, and a
 *  space, but where the delimiter ends in whitespace, as a tab, which is
 *  its own; nothing where the caption has no text. Quarto puts a space
 *  after the delimiter in every case. */
export function captionSeparator(titleDelim: string, hasText: boolean): string {
  if (!hasText) return '';
  return /\s$/.test(titleDelim) ? titleDelim : titleDelim + ' ';
}

/** Whether `text`, of a caption's, is text it shows after its number,
 *  which takes the delimiter before it: text with more than whitespace in
 *  it, as export, import and the preview read it alike, so that a caption
 *  of spaces alone, as `![ ](map.png){#fig-x}`'s, takes none. An equation
 *  is text too. */
export function isCaptionText(text: string): boolean {
  return /\S/.test(text);
}

/** A caption's label and number as Word and the preview show them, as
 *  `Figure 1` */
export function captionLabelText(title: string, number: number): string {
  return title + ' ' + number;
}

/**
 * The delimiter whose separator (see captionSeparator) is `separator`, the
 * text between a caption's number and its text in Word, or undefined where
 * none is: where the separator doesn't end in whitespace, or ends in two
 * spaces read as one plus a space. A space alone is the empty delimiter.
 */
export function delimiterOfSeparator(separator: string): string | undefined {
  if (!/\s$/.test(separator)) return undefined;
  const withoutSpace = separator.endsWith(' ') ? separator.slice(0, -1) : undefined;
  if (withoutSpace !== undefined && !/\s$/.test(withoutSpace)) return withoutSpace;
  return separator;
}

/** The separator between a Word caption's number and its text, at the
 *  start of `rest`: whitespace, a mark of punctuation Word captions use,
 *  and a space or a tab, as `. `, `: ` or ` – `. Whitespace after that is
 *  the text's, as a caption's that starts with a space. */
export function captionSeparatorAt(rest: string): string {
  return /^[ \t]*[.:;,|\u2013\u2014-]?[ \t]?/.exec(rest)![0];
}

/** The SEQ field identifier of a caption whose title is `title`, as Word's
 *  Insert Caption names one: its letters, digits and underscores, a space
 *  as an underscore, and Figure where it has none to start with */
export function seqIdentifier(title: string, fallback = 'Figure'): string {
  const identifier = title.trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
  return /^\p{L}/u.test(identifier) ? identifier.slice(0, 40) : fallback;
}

// Word's bookmark names: a letter, then letters, digits and underscores, 40
// characters at most, which Word compares whatever their case
const BOOKMARK_MAX = 40;

/**
 * A caption's bookmark, as Word can name one, for the label `label`: the
 * label with each character but a letter, a digit or an underscore as an
 * underscore, as `fig_map` for `fig-map`, cut to 40 characters, and, where
 * it's a name in `taken`, the names in lower case of the bookmarks before,
 * as Word compares them, with `_2`, `_3` and so on after it, cut to fit,
 * which then goes in `taken`.
 */
export function captionBookmarkName(label: string, taken: Set<string>): string {
  const base = label.replace(/[^A-Za-z0-9_]/g, '_').slice(0, BOOKMARK_MAX);
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = '_' + n;
    name = base.slice(0, BOOKMARK_MAX - suffix.length) + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** The label a bookmark export named (see captionBookmarkName) stands for,
 *  of a figure's, where it's the label as written, but its hyphens: `fig_`
 *  and the rest with each underscore a hyphen. Export keeps the others'
 *  labels in a custom property. */
export function labelOfBookmark(name: string): string | undefined {
  return /^fig_[A-Za-z0-9_]+$/.test(name) ? 'fig-' + name.slice(4).replace(/_/g, '-') : undefined;
}

/**
 * A label for a figure whose Word caption has none of export's, from the
 * caption's first words, `text`: `fig-` and the words, without accents, in
 * lower case, their letters and digits joined by hyphens, as many as fit
 * in 30 characters, at least one, and at most five, as
 * `fig-child-penalties-by-region`. With no letter or digit to take, it's
 * `fig-` and the figure's number.
 */
export function captionSlug(text: string, number: number): string {
  const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = '';
  for (const word of words.slice(0, 5)) {
    const next = slug ? slug + '-' + word : word.slice(0, 30);
    if (next.length > 30) break;
    slug = next;
  }
  return 'fig-' + (slug || String(number));
}

/** An XML instruction's text with its references read */
function xmlText(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9A-Fa-f]+)|(amp|lt|gt|quot|apos));/g, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name]!;
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
    return code <= 0x10FFFF ? String.fromCodePoint(code) : match;
  });
}

/**
 * Counts each SEQ field of the XML of a part, `xml`, by its identifier, in
 * `counts`: each complex field's, whose instruction its w:instrText or
 * w:delInstrText elements hold to its separate or end, a field nested in
 * it apart, and each w:fldSimple's. Word numbers each, wherever it is, as
 * in a table, a text box or a tracked deletion. It reads the XML once.
 */
export function countSeqFields(xml: string, counts: Map<string, number>): void {
  const count = (instruction: string) => {
    const identifier = /^\s*SEQ\s+([^\s\\"]+)/i.exec(xmlText(instruction))?.[1];
    if (identifier) counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
  };
  // The instructions of the complex fields open, each undefined once read
  const open: Array<string | undefined> = [];
  const FIELD_PART = /<w:fldChar\b([^>]*)>|<w:(?:del)?instrText\b[^>]*?(?:\/>|>([^<]*)<\/w:(?:del)?instrText>)|<w:fldSimple\b([^>]*)>/g;
  for (const match of xml.matchAll(FIELD_PART)) {
    if (match[1] !== undefined) {
      const type = /\bw:fldCharType\s*=\s*["']([a-z]+)["']/.exec(match[1])?.[1];
      if (type === 'begin') {
        open.push('');
      } else if ((type === 'separate' || type === 'end') && open.length > 0) {
        const instruction = open[open.length - 1];
        if (instruction !== undefined) count(instruction);
        if (type === 'end') open.pop();
        else open[open.length - 1] = undefined;
      }
    } else if (match[3] !== undefined) {
      const instruction = /\bw:instr\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(match[3]);
      if (instruction) count(instruction[1] ?? instruction[2]);
    } else if (match[2] !== undefined && open.length > 0 && open[open.length - 1] !== undefined) {
      open[open.length - 1] += match[2];
    }
  }
}

