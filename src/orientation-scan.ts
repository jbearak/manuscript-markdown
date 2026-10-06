import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { computeLineStarts } from './code-regions';
import { htmlBlockKind, listItemHtmlBlock } from './html-blocks';
import { preprocessBlocks } from './block-preprocess';

export interface OrientationDiagnostic {
  /** list-item: in a list item, which export drops it from; note: in a
   *  note, which has no sections, so export ignores it */
  kind: 'unclosed' | 'orphaned' | 'nested' | 'crossed' | 'list-item' | 'note';
  /** The directive name that triggered the diagnostic (e.g. 'landscape') */
  directiveName: string;
  /** For list-item/note: whether the directive is a close, as <!-- /landscape --> */
  close?: boolean;
  /** Character (UTF-16 code unit) offset of the diagnostic directive, suitable for use with LSP positionAt() */
  start: number;
  /** Character (UTF-16 code unit) end offset of the diagnostic directive */
  end: number;
  /** For nested/crossed: the name of the conflicting opener */
  relatedName?: string;
  /** For nested/crossed: character (UTF-16 code unit) offset of the conflicting opener */
  relatedStart?: number;
  /** For nested/crossed: character (UTF-16 code unit) end offset of the conflicting opener */
  relatedEnd?: number;
}

interface Directive {
  name: string;
  close: boolean;
  start: number;
  end: number;
  where: 'top' | 'list-item' | 'note';
}

const blockParser = new MarkdownIt({ html: true });
// A comment that is all of its HTML block, as export reads a directive (see
// ORIENTATION_OPEN_RE in md-to-docx.ts)
const DIRECTIVE_BLOCK_RE = /^<!--\s*(\/?)(landscape|portrait)\s*-->$/i;
const DIRECTIVE_RE = /<!--\s*\/?(?:landscape|portrait)\s*-->/gi;
// A note's definition, as extractFootnoteDefinitions in md-to-docx.ts reads one
const NOTE_DEFINITION_RE = /^\[\^[a-zA-Z0-9_-]+\]:\s?/;
const NOTE_CONTINUATION_RE = /^(?: {4}|\t)/;

/**
 * The orientation directives in `source`, each an HTML block of its own, as
 * markdown-it reads them, and where export reads each: at the top level, as
 * a directive, or in a list item, which drops one after the item's text. Not
 * one in fenced or indented code, in a paragraph, or in an HTML block with
 * more in it, which export keeps as text or a comment, nor the first block of
 * a list item, which is the item's text, nor one in a quote, which keeps it as
 * a comment. In a note's body, `inNote`, one at its top level is the note's,
 * which has no sections. `lineOffset` gives the offset in the scanned text of
 * a line of `source`, from which the directive is found.
 */
function blockDirectives(source: string, text: string, lineOffset: (line: number) => number, inNote: boolean): Directive[] {
  const tokens: Token[] = [];
  // The block parser alone, which reads a carriage return as a line end, as
  // markdown-it's core does, over the lines export reads, after its grid
  // tables, quotes and LaTeX environments, as a grid table's placeholder,
  // which ends a list it was indented in, with the line of `source` each
  // comes from
  const blocks = preprocessBlocks(source.replace(/\r\n?/g, '\n'));
  blockParser.block.parse(blocks.output, blockParser, {}, tokens);
  const directives: Directive[] = [];
  // The open list items and quotes, an item with whether a block that ends
  // its text, or one after it, came yet (see extractListItems in md-to-docx.ts)
  const containers: Array<{ item: boolean; hasBlock: boolean }> = [];
  const markBlock = (): void => {
    const top = containers[containers.length - 1];
    if (top?.item) top.hasBlock = true;
  };
  for (const [index, token] of tokens.entries()) {
    switch (token.type) {
      case 'list_item_open': containers.push({ item: true, hasBlock: false }); continue;
      case 'blockquote_open': markBlock(); containers.push({ item: false, hasBlock: false }); continue;
      case 'list_item_close': case 'blockquote_close': containers.pop(); continue;
      case 'bullet_list_open': case 'ordered_list_open': case 'paragraph_open': case 'heading_open': markBlock(); continue;
    }
    if (token.type !== 'html_block' || !token.map) continue;
    const top = containers[containers.length - 1];
    const first = !!top?.item && !top.hasBlock;
    // An HTML block an item skips or drops, as a table, is none of its text,
    // so a block after it can be, as export reads it
    const kind = htmlBlockKind(token.content);
    if (top?.item && listItemHtmlBlock(tokens, index, () => kind === 'tables' || kind === 'grid') === 'kept') markBlock();
    const m = DIRECTIVE_BLOCK_RE.exec(token.content.trim());
    if (!m) continue;
    if (first || containers.some(container => !container.item)) continue;
    DIRECTIVE_RE.lastIndex = lineOffset(blocks.lines[token.map[0]]);
    const found = DIRECTIVE_RE.exec(text);
    if (!found) continue;
    directives.push({
      name: m[2].toLowerCase(),
      close: m[1] === '/',
      start: found.index,
      end: found.index + found[0].length,
      where: top ? 'list-item' : inNote ? 'note' : 'top',
    });
  }
  return directives;
}

/**
 * The orientation directives of `text`, as export reads them: its body's,
 * past its notes' definitions, which export takes out before it reads the
 * body, and then those in the notes, each of whose bodies it reads as a
 * document of its own, without the indent of its lines.
 */
function directivesOf(text: string): Directive[] {
  const lineStarts = computeLineStarts(text);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // The lines of fenced code and HTML blocks, which hold no definition
  const literal = new Set<number>();
  if (lines.some(line => NOTE_DEFINITION_RE.test(line))) {
    const tokens: Token[] = [];
    blockParser.block.parse(lines.join('\n'), blockParser, {}, tokens);
    for (const token of tokens) {
      if ((token.type === 'fence' || token.type === 'html_block') && token.map) {
        for (let k = token.map[0]; k < token.map[1]; k++) literal.add(k);
      }
    }
  }
  // Each note's body: for each of its lines, the line of `text` and the
  // length of the definition's start or indent before it
  const notes: Array<Array<{ line: number; skip: number }>> = [];
  let note: Array<{ line: number; skip: number }> | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (note && NOTE_CONTINUATION_RE.test(line)) {
      note.push({ line: i, skip: NOTE_CONTINUATION_RE.exec(line)![0].length });
      continue;
    }
    // A blank line goes on in the note where an indented line comes after it
    if (note && line.trim() === '') {
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === '') next++;
      if (next < lines.length && NOTE_CONTINUATION_RE.test(lines[next])) {
        for (; i < next; i++) note.push({ line: i, skip: NOTE_CONTINUATION_RE.exec(lines[i])?.[0].length ?? lines[i].length });
        i--;
        continue;
      }
    }
    note = undefined;
    if (literal.has(i)) continue;
    const definition = NOTE_DEFINITION_RE.exec(line);
    if (definition) {
      note = [{ line: i, skip: definition[0].length }];
      notes.push(note);
    }
  }
  const noteLines = new Set(notes.flat().map(noteLine => noteLine.line));
  // The body, its notes' lines left blank, so that its lines keep their numbers
  const body = noteLines.size === 0 ? text : lines.map((line, k) => noteLines.has(k) ? '' : line).join('\n');
  const directives = blockDirectives(body, text, line => lineStarts[line] ?? text.length, false);
  for (const noteBody of notes) {
    const source = noteBody.map(({ line, skip }) => lines[line].slice(skip)).join('\n');
    directives.push(...blockDirectives(source, text, k => (lineStarts[noteBody[k].line] ?? text.length) + noteBody[k].skip, true));
  }
  return directives;
}

/**
 * Scan text for orientation directive errors: unclosed opens, orphaned closes,
 * nested opens, and crossed (out-of-order) closes, among the directives export
 * reads as directives (see blockDirectives), and directives it drops from a
 * list item or ignores in a note, which pair with none.
 *
 * Only one orientation can be active at a time — opening `<!-- portrait -->`
 * while `<!-- landscape -->` is active (or vice versa) is reported as nested.
 */
export function scanOrientationDirectives(text: string): OrientationDiagnostic[] {
  const openStack: { name: string; start: number; end: number }[] = [];
  const results: OrientationDiagnostic[] = [];

  for (const directive of directivesOf(text).sort((a, b) => a.start - b.start)) {
    const { name, start, end } = directive;
    if (directive.where !== 'top') {
      results.push({ kind: directive.where, directiveName: name, close: directive.close, start, end });
      continue;
    }

    if (!directive.close) {
      if (openStack.length > 0) {
        const existing = openStack[openStack.length - 1];
        results.push({
          kind: 'nested',
          directiveName: name,
          start,
          end,
          relatedName: existing.name,
          relatedStart: existing.start,
          relatedEnd: existing.end,
        });
        // Don't push — keep original opener so "unclosed" points to the root.
        // The converter in md-to-docx.ts handles graceful recovery (close + reopen)
        // independently; this scanner's job is accurate diagnostics.
      } else {
        openStack.push({ name, start, end });
      }
    } else {
      if (openStack.length > 0) {
        const top = openStack[openStack.length - 1];
        if (top.name === name) {
          openStack.pop();
        } else {
          // Crossed close: <!-- /portrait --> while <!-- landscape --> is active
          results.push({
            kind: 'crossed',
            directiveName: name,
            start,
            end,
            relatedName: top.name,
            relatedStart: top.start,
            relatedEnd: top.end,
          });
          // Don't pop — the wrong opener stays active
        }
      } else {
        results.push({
          kind: 'orphaned',
          directiveName: name,
          start,
          end,
        });
      }
    }
  }

  for (const entry of openStack) {
    results.push({
      kind: 'unclosed',
      directiveName: entry.name,
      start: entry.start,
      end: entry.end,
    });
  }

  return results;
}
