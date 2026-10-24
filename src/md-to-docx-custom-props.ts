// The custom properties export writes in docProps/custom.xml, which import
// reads back to write the Markdown as it was: Zotero's, and the layout, IDs
// and spacing Word doesn't keep. Split out of md-to-docx.ts, whose header's
// invariants hold here too.
import { BibtexEntry } from './bibtex-parser';
import type { DocxGenState, MdToken } from './md-to-docx';
import { Frontmatter, type FrontmatterLayout, noteTypeToNumber, serializeFrontmatter } from './frontmatter';
import { escapeXmlAttribute } from './xml-parser';
import { zoteroStyleFullId } from './converter';

/** Deterministic bookmark name for a footnote/endnote cross-reference target.
 * Uses _Ref + (100000000 + noteId) to follow Word's _Ref + digits convention
 * while remaining deterministic for reproducible output. */
export function footnoteBookmarkName(noteId: number): string {
  return '_Ref' + String(100000000 + noteId);
}

export interface CustomPropEntry {
  name: string;
  value: string;
  /** Its value's type, vt:lpwstr's lpwstr unless a template's property has another */
  type?: string;
}

/** Chunk a string value into numbered custom properties: PREFIX_1, PREFIX_2, … */
export function chunkCustomProps(prefix: string, data: string, chunkSize = 240): CustomPropEntry[] {
  const props: CustomPropEntry[] = [];
  for (let i = 0; i < data.length;) {
    // A chunk ends between characters, not in the surrogate pair of one
    // outside the BMP, as an emoji, which the XML can't hold half of
    let end = Math.min(i + chunkSize, data.length);
    if (end < data.length && /[\ud800-\udbff]/.test(data[end - 1])) end--;
    props.push({
      name: prefix + (props.length + 1),
      value: data.slice(i, end),
    });
    i = end;
  }
  return props;
}

export function customPropsXml(properties: CustomPropEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n';
  for (let i = 0; i < properties.length; i++) {
    const pid = i + 2; // fmtid starts at pid=2 per OOXML convention
    xml += '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + pid + '" name="' + escapeXmlAttribute(properties[i].name) + '">';
    // Use minimal escaping for text content: only <, >, & need escaping.
    // escapeXmlAttribute() also escapes " as &quot; which is valid but causes Word to
    // decode it on open and mark the document as modified.
    const type = 'vt:' + (properties[i].type ?? 'lpwstr');
    xml += '<' + type + '>' + properties[i].value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</' + type + '>';
    xml += '</property>\n';
  }
  xml += '</Properties>';
  return xml;
}

export function zoteroCustomProps(fm: Frontmatter): CustomPropEntry[] {
  const styleId = zoteroStyleFullId(fm.csl || '');
  const prefData = JSON.stringify({
    dataVersion: 4,
    zoteroVersion: '6.0',
    style: {
      styleID: styleId,
      locale: fm.locale || 'en-US',
      hasBibliography: true,
      bibliographyStyleHasBeenSet: true,
    },
    prefs: {
      fieldType: 'Field',
      noteType: fm.zoteroNotes ? noteTypeToNumber(fm.zoteroNotes) : 0,
    },
  });

  // Chunk the pref string into ZOTERO_PREF_1, ZOTERO_PREF_2, etc. (max 240 chars each)
  return chunkCustomProps('ZOTERO_PREF_', prefData);
}

/** The style export chose for frontmatter without one, which Zotero's
 *  preferences hold all the same, so that import, finding them the same,
 *  writes no `csl` the Markdown didn't have. */
export function defaultCslProps(defaultCsl: string | undefined): CustomPropEntry[] {
  return defaultCsl ? [{ name: 'MANUSCRIPT_DEFAULT_CSL', value: defaultCsl }] : [];
}

export function commentIdMappingProps(commentIdMap: Map<string, number>): CustomPropEntry[] {
  if (commentIdMap.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [mdId, numericId] of commentIdMap) {
    // Not a caption's label, which is no comment's (see commentRangeRule)
    if (!mdId.startsWith('#')) mapping[String(numericId)] = mdId;
  }
  return Object.keys(mapping).length > 0 ? chunkCustomProps('MANUSCRIPT_COMMENT_IDS_', JSON.stringify(mapping)) : [];
}

export function footnoteIdMappingProps(footnoteLabelToId: Map<string, number>, trackedReference: boolean): CustomPropEntry[] {
  if (footnoteLabelToId.size === 0) return [];
  // Import numbers notes in the order of their first references, which gives
  // the labels back only when each is its note's ID and no reference is
  // tracked, since a tracked one can cross-reference a note before the
  // reference that holds it.
  if (!trackedReference && [...footnoteLabelToId].every(([label, id]) => label === String(id))) return [];

  const mapping: Record<string, string> = {};
  for (const [label, numericId] of footnoteLabelToId) {
    mapping[String(numericId)] = label;
  }
  return chunkCustomProps('MANUSCRIPT_FOOTNOTE_IDS_', JSON.stringify(mapping));
}

export function footnoteCrossRefProps(
  crossRefLabels: Set<string>,
  footnoteLabelToId: Map<string, number>,
  notesMode: 'footnotes' | 'endnotes',
): CustomPropEntry[] {
  if (crossRefLabels.size === 0) return [];
  const mapping: Record<string, string> = {};
  const noteKind = notesMode === 'endnotes' ? 'endnote' : 'footnote';
  for (const label of crossRefLabels) {
    const noteId = footnoteLabelToId.get(label);
    if (noteId === undefined) continue;
    mapping[footnoteBookmarkName(noteId)] = noteKind + ':' + noteId;
  }
  return chunkCustomProps('MANUSCRIPT_FOOTNOTE_CROSSREFS_', JSON.stringify(mapping));
}

export function codeBlockLanguageProps(codeBlockLanguages: Map<number, string>): CustomPropEntry[] {
  if (codeBlockLanguages.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [index, language] of codeBlockLanguages) {
    mapping[String(index)] = language;
  }
  return chunkCustomProps('MANUSCRIPT_CODE_BLOCK_LANGS_', JSON.stringify(mapping));
}

/** The index of the first code block of each note that has one, by the
 *  note's key on import, as `footnote:2`, so that import finds each note's
 *  languages by the note, whatever turn it writes the note in: Word may show
 *  a note in another, or not at all, as where its references are hidden */
export function noteCodeBlockProps(starts: Map<string, number>): CustomPropEntry[] {
  if (starts.size === 0) return [];
  return chunkCustomProps('MANUSCRIPT_NOTE_CODE_BLOCKS_', JSON.stringify(Object.fromEntries([...starts].map(([key, start]) => [key, String(start)]))));
}

export function codeBlockStylingProps(fm: Frontmatter): CustomPropEntry[] {
  const obj: Record<string, string> = {};
  if (fm.codeBackgroundColor) obj.bg = fm.codeBackgroundColor;
  if (fm.codeFontColor) obj.fc = fm.codeFontColor;
  if (fm.codeBlockInset !== undefined) obj.inset = String(fm.codeBlockInset);
  if (Object.keys(obj).length === 0) return [];
  return [{ name: 'MANUSCRIPT_CODE_BLOCK_STYLING', value: JSON.stringify(obj) }];
}

export function pipeTableMaxLineWidthProps(fm: Frontmatter): CustomPropEntry[] {
  if (fm.pipeTableMaxLineWidth === undefined) return [];
  return [{ name: 'MANUSCRIPT_PIPE_TABLE_MAX_LINE_WIDTH', value: String(fm.pipeTableMaxLineWidth) }];
}

export function lineSpacingProps(fm: Frontmatter): CustomPropEntry[] {
  if (fm.lineSpacing === undefined) return [];
  return [{ name: 'MANUSCRIPT_LINE_SPACING', value: String(fm.lineSpacing) }];
}
export function paragraphIndentProps(fm: Frontmatter): CustomPropEntry[] {
  if (fm.paragraphIndent === undefined) return [];
  return [{ name: 'MANUSCRIPT_PARAGRAPH_INDENT', value: String(fm.paragraphIndent) }];
}
export function bibliographyHangingIndentProps(fm: Frontmatter): CustomPropEntry[] {
  if (fm.bibliographyHangingIndent === undefined) return [];
  return [{ name: 'MANUSCRIPT_BIBLIOGRAPHY_HANGING_INDENT', value: String(fm.bibliographyHangingIndent) }];
}
export function indentOverrideProps(overrides: Map<number, 'indent' | 'no-indent'>): CustomPropEntry[] {
  if (overrides.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [index, override] of overrides) {
    mapping[String(index)] = override;
  }
  return chunkCustomProps('MANUSCRIPT_INDENT_OVERRIDES_', JSON.stringify(mapping));
}
export function listIndentOverrideProps(overrides: Map<number, 'indent' | 'no-indent'>): CustomPropEntry[] {
  if (overrides.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [index, override] of overrides) {
    mapping[String(index)] = override;
  }
  return chunkCustomProps('MANUSCRIPT_LIST_INDENT_OVERRIDES_', JSON.stringify(mapping));
}
/** The directives before list items that start a Markdown list in a list
 *  block, by the block and the item's place in it, counting the items at
 *  every level. A directive right after a list ends it, but export writes
 *  nothing for one, and the list after it of the same type goes on in
 *  Word's, as bullets do, so the block's own override, at its start, can't
 *  hold it */
export function listItemIndentOverrideProps(overrides: Map<number, Map<number, 'indent' | 'no-indent'>>): CustomPropEntry[] {
  if (overrides.size === 0) return [];
  const mapping: Record<string, Record<string, string>> = {};
  for (const [block, places] of overrides) mapping[String(block)] = Object.fromEntries(places);
  return chunkCustomProps('MANUSCRIPT_LIST_ITEM_INDENT_OVERRIDES_', JSON.stringify(mapping));
}
/** Records a blank line before the item at `place` in list block `block`,
 *  in the block's places as they are, as a long loose list has one before
 *  each item */
export function recordListBlankLine(blankLines: Map<number, number[]>, block: number, place: number): void {
  const places = blankLines.get(block);
  if (places) places.push(place);
  else blankLines.set(block, [place]);
}

/** A list item export reads the list block and place of from its document:
 *  its paragraph's w14:paraId, whether a blank line before it makes its
 *  list loose, its indent directive, and the one right before it, after an
 *  item (see MdToken.listDirective) */
export interface ListItemRead { paraId: string; blankLine: boolean; indentOverride?: 'indent' | 'no-indent'; listDirective?: 'indent' | 'no-indent' }

/** The records of `items` in their list blocks and places, `places`, as
 *  import reads them: an item's blank line where it isn't its block's first,
 *  and its directive where it is, or the one right before it where it
 *  isn't (see listItemIndentOverrideProps). An item import reads in no block, which
 *  isn't one Word shows, has none */
export function recordListItemsRead(state: DocxGenState, items: ListItemRead[], places: Map<string, [number, number]>): void {
  for (const item of items) {
    const at = places.get(item.paraId);
    if (!at) continue;
    const [block, place] = at;
    if (place > 0 && item.blankLine) recordListBlankLine(state.listBlankLines, block, place);
    if (place === 0 && item.indentOverride) state.listIndentOverrides.set(block, item.indentOverride);
    else if (place > 0 && item.listDirective) {
      const directives = state.listItemIndentOverrides.get(block) ?? new Map<number, 'indent' | 'no-indent'>();
      directives.set(place, item.listDirective);
      state.listItemIndentOverrides.set(block, directives);
    }
  }
}

/** The items with a blank line before them in the source, by list block and
 *  their place in it, counting the items at every level. Word has nothing
 *  for the blank line, which makes a Markdown list loose, its items' text
 *  paragraphs, and import, which writes lists tight, puts it back */
export function listBlankLineProps(blankLines: Map<number, number[]>): CustomPropEntry[] {
  if (blankLines.size === 0) return [];
  return chunkCustomProps('MANUSCRIPT_LIST_BLANK_LINES_', JSON.stringify(Object.fromEntries(blankLines)));
}

export function gridTableMaxLineWidthProps(fm: Frontmatter): CustomPropEntry[] {
  if (fm.gridTableMaxLineWidth === undefined) return [];
  return [{ name: 'MANUSCRIPT_GRID_TABLE_MAX_LINE_WIDTH', value: String(fm.gridTableMaxLineWidth) }];
}

export function listIndentProps(state: DocxGenState): CustomPropEntry[] {
  if (state.listIndent === 'tab') {
    return [{ name: 'MANUSCRIPT_LIST_INDENT', value: 'tab' }];
  }
  return [];
}

export function consecutiveReplyProps(state: DocxGenState): CustomPropEntry[] {
  if (state.consecutiveReplyParaIds.size === 0) return [];
  return [{ name: 'MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS', value: [...state.consecutiveReplyParaIds].join(',') }];
}

/**
 * Settings the document has no other trace of, as frontmatter text, for
 * import to restore: notes and Zotero settings with no notes or citations to
 * show them, and settings for Markdown or for parts the document may lack.
 */
export function frontmatterSettingsProps(fm: Frontmatter): CustomPropEntry[] {
  const settings: Frontmatter = {
    locale: fm.locale, zoteroNotes: fm.zoteroNotes, notes: fm.notes, timezone: fm.timezone,
    blockquoteStyle: fm.blockquoteStyle, colors: fm.colors, breaks: fm.breaks,
    crossref: fm.crossref, figCapLocation: fm.figCapLocation, tblCapLocation: fm.tblCapLocation,
  };
  const yaml = serializeFrontmatter(settings);
  return yaml ? chunkCustomProps('MANUSCRIPT_FRONTMATTER_SETTINGS_', yaml) : [];
}

export function frontmatterBlankLineProps(count: number): CustomPropEntry[] {
  if (count < 0) return []; // no frontmatter
  return [{ name: 'MANUSCRIPT_FRONTMATTER_BLANK_LINES', value: String(count) }];
}

export function frontmatterFieldOrderProps(order: string[]): CustomPropEntry[] {
  if (order.length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_FRONTMATTER_FIELD_ORDER_', JSON.stringify(order));
}

/** The frontmatter's keys export reads nothing from, as written, among the
 *  names of those it reads (see frontmatterLayout), for import to put back.
 *  JSON, whose text is a line, holds the YAML's line ends as \n, so none
 *  goes to Word. */
export function frontmatterLayoutProps(layout: FrontmatterLayout | undefined): CustomPropEntry[] {
  return layout ? chunkCustomProps('MANUSCRIPT_FRONTMATTER_UNUSED_KEYS_', JSON.stringify(layout)) : [];
}

export function bibKeyOrderProps(bibEntries: Map<string, BibtexEntry> | undefined): CustomPropEntry[] {
  if (!bibEntries || bibEntries.size === 0) return [];
  return chunkCustomProps('MANUSCRIPT_BIB_KEY_ORDER_', [...bibEntries.keys()].join(','));
}

export function bibDataProps(bibtex: string | undefined): CustomPropEntry[] {
  if (!bibtex || bibtex.trim().length === 0) return [];
  // Larger chunk size: .bib data can be 10–50+ KB (vs 240 for small metadata).
  return chunkCustomProps('MANUSCRIPT_BIB_DATA_', bibtex, 4000);
}

export function bibliographyPathProps(fm: Frontmatter): CustomPropEntry[] {
  if (!fm.bibliography) return [];
  return [{ name: 'MANUSCRIPT_BIBLIOGRAPHY_PATH', value: fm.bibliography }];
}

/** Whether a paragraph is among the body paragraphs whose indexes indent
 *  overrides keep, from its parts in order: export's runs, as Word gets
 *  them, or the items import read from Word. It is if Word shows any of
 *  them. An HTML comment is a hidden run, and a Word comment's range and
 *  body take no room, but a space between two comments shows, and so does
 *  a range that holds nothing here: one that ends here is a comment at a
 *  point, and one that goes on past a paragraph of comments starts at its
 *  mark, as import reads each, with an item of its own (see
 *  startRangesAtMark). Export's count and import's both come from this, so
 *  they agree. */
export function countsForIndent(parts: Iterable<{ type: string; commentId?: string }>): boolean {
  // The HTML comments so far, as at the start of each range still open
  let comments = 0;
  const startedAt = new Map<string | undefined, number>();
  for (const part of parts) {
    if (part.type === 'html_comment') comments++;
    else if (part.type === 'comment_range_start') startedAt.set(part.commentId, comments);
    else if (part.type === 'comment_range_end') {
      if (startedAt.get(part.commentId) === comments) return true;
      startedAt.delete(part.commentId);
    } else if (part.type !== 'comment_body_with_id') return true;
  }
  if (comments > 0) for (const at of startedAt.values()) if (at === comments) return true;
  return false;
}

/** Whether a paragraph is HTML comments with the ID syntax of a Word comment
 *  on them, as import writes one Word put a comment on, {#1}<!-- c -->{/1}
 *  with the comment's body on the next line, which is among comments of
 *  their own, as the block of the comments alone is, with the spaces and
 *  tabs between them, but not one between the syntax and the first or
 *  last, which the paragraph keeps as text. Only the line end before a
 *  body goes with it; one in a range, as between two openers, is a space
 *  in Word, as import writes it. */
export function isCommentsWithIds(token: MdToken): boolean {
  if (token.type !== 'paragraph' || token.listContinuation) return false;
  const runs = token.runs.filter((run, k) => run.type !== 'comment_range_start' && run.type !== 'comment_range_end'
    && run.type !== 'comment_body_with_id' && !(run.type === 'softbreak' && token.runs[k + 1]?.type === 'comment_body_with_id'));
  return runs.length < token.runs.length && runs[0]?.type === 'html_comment' && runs[runs.length - 1].type === 'html_comment'
    && runs.every(run => run.type === 'html_comment' || run.type === 'softbreak' || run.type === 'text' && /^[ \t]*$/.test(run.text));
}

/** Assign sequential htmlCommentIndex to each HTML comment token and return
 *  maps from index → blankLinesBefore/After count (only for non-default values). */
export function annotateHtmlCommentIndices(tokens: MdToken[]): { beforeGaps: Map<number, number>; afterGaps: Map<number, number> } {
  const beforeGaps = new Map<number, number>();
  const afterGaps = new Map<number, number>();
  let idx = 0;
  for (const token of tokens) {
    // Not one in a list item, which import writes after the item's indent
    const isHtmlComment = token.type === 'paragraph'
      && token.runs.length === 1
      && token.runs[0].type === 'html_comment'
      && !token.listContinuation
      || isCommentsWithIds(token);
    if (isHtmlComment) {
      token.htmlCommentIndex = idx;
      if (token.blankLinesBefore !== undefined && token.blankLinesBefore !== 1) {
        beforeGaps.set(idx, token.blankLinesBefore);
      }
      if (token.blankLinesAfter !== undefined && token.blankLinesAfter !== 1) {
        afterGaps.set(idx, token.blankLinesAfter);
      }
      idx++;
    }
  }
  return { beforeGaps, afterGaps };
}

export function htmlCommentGapProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_HTML_COMMENT_GAPS_', JSON.stringify(mapping));
}

export function htmlCommentAfterGapProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_HTML_COMMENT_AFTER_GAPS_', JSON.stringify(mapping));
}
