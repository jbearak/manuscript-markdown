import { escapeXmlText, textElements, orderPPr, orderRPr, generateCitation, generateMathXml, generateTrackedMathXml, createCiteprocEngineLocal, createCiteprocEngineAsync, generateBibliographyXml, generateMissingKeysXml, HIDDEN_PARAGRAPH_PPR, type CiteprocEngine } from './md-to-docx-citations';
import { downloadStyle, resolveCslCachePath } from './csl-loader';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { parseBibtex, BibtexEntry } from './bibtex-parser';
import { parseFrontmatter, maskFrontmatter, frontmatterLayout, Frontmatter, type ColorScheme, type CustomStyleDef, expandColWidths, colWidthsToPct } from './frontmatter';
import { formatTableNumbers } from './table-number-format';
import { paragraphStartFingerprint, tableContentsFingerprint, tableFirstRowText, tableIdentity, type TableIdentity, type TableNumberFormat } from './table-metadata';
import { alertColorsByScheme, getDefaultColorScheme } from './alert-colors';
import { type ListMeta, type UnnumberedListParagraph, listPlacesOf, runContentShows, styleListMeta, ZoteroBiblData } from './converter';
import { gfmAlertTitle, type GfmAlertType } from './gfm';
import { closingFenceAtEnd } from './orientation-scan';
import { pixelsToEmu, isSupportedImageFormat, getImageContentType, readImageDimensions, computeMissingDimension, IMAGE_WARNINGS } from './image-utils';
import { preprocessGridTables, preprocessGridTablesWithSourceMap } from './grid-table-preprocess';
import { preprocessEmbedsTracked } from './embed-preprocess';
import { xmlInteger } from './xml-elements';
export { commentsEnd, isLineBreakBlock } from './html-blocks';
import { preprocessBlocks } from './block-preprocess';
import { maxOf, pushAll } from './arrays';
import { captionBookmarkName, captionLabelText, captionOptions, captionSeparator, isCaptionText, labelOfBookmark, seqIdentifiers, type CaptionOptions } from './captions';
import { readTemplateSections, addTemplateSectionParts, withRelationshipIds, decodeXml, asUtf8, relatedPartPath, templateLayoutRecord, TEMPLATE_LAYOUT_PROPERTY, type LayoutEntry, type TemplateSections } from './template-sections';
import { escapeXmlAttribute, hasNonXmlCharacter, withoutNonXmlCharacters } from './xml-parser';
import { WORDPROCESSINGML, elementsIn, isNamed } from './scoped-xml';
export { preprocessGridTables } from './grid-table-preprocess';
export { extractHtmlTables } from './html-table-parser';

// --- Implementation notes ---
// - decodeXmlText(): decode &amp; after other named entities to avoid over-decoding;
//   HTML's own references, as an <img>'s alt's, read as the browser reads
//   them (see decodeHtmlAttribute)
// - Numeric entities: use String.fromCodePoint() not String.fromCharCode() for
//   supplementary-plane chars
// - CriticMarkup recursive formatting: parse inner payloads with markdown-it
//   (Critic/comment/citation/math/footnote rules included); carry structured
//   inner runs on MdRun (innerRuns / oldRuns / newRuns)
//
// --- Word dirty-flag prevention ---
// The following invariants prevent Word from marking generated .docx files as
// modified upon opening. Violating any of these causes Word to normalize the
// XML on open and set the "unsaved changes" flag:
//
// 1. xml:space="preserve": only emit on <w:t> when text starts/ends with a
//    space. Word strips it from text that doesn't need it. Use wt() helper.
//    The same goes for an equation's <m:t> (see keepWhitespaceChanges in
//    latex-to-omml.ts).
// 2. Zip directory entries: do not include explicit folder entries (word/,
//    _rels/, etc.) in the zip. Word omits them and normalizes if present.
//    Delete dir entries from zip.files before generateAsync().
// 3. pPr element ordering: CT_PPrBase's schema order, as keepNext and
//    widowControl before pBdr before spacing before ind before jc. Word
//    normalizes out-of-order elements. Applies to styles AND inline paragraph
//    properties. Put what export adds to a template's pPr through orderPPr.
// 4. rPr element ordering: CT_RPr's schema order, as rFonts before b, caps
//    before smallCaps, color before sz/szCs before u before shd. Put run
//    properties composed from several parts through orderRPr.
// 5. Redundant style properties: do not emit w:sz/w:szCs on a derived style
//    when the value matches the base style (e.g. Heading4 sz=22 from Normal).
//    Do not emit w:before="0" (it's the default and Word strips it), nor an
//    empty <w:rPr> or <w:pPr>, as a heading style with nothing to change
//    has, which Word strips too. On a paragraph, the zero stays only where
//    its style may give it space before, as a template's may (see
//    generateBibliographyXml).
// 6. Sequential rId numbering: all relationship IDs must be sequential with no
//    gaps. Gaps trigger Word to renumber all rIds on open.
// 7. vt:lpwstr encoding: only escape &, <, > in custom property text values.
//    Do NOT escape quotes — Word decodes &quot; to " and marks dirty.
// 8. w:proofState: do not include. Word removes it from third-party files.
// 9. Font completeness: include w:sig on all fonts, and include Calibri Light
//    (referenced by theme minorFont/majorFont).
// 10. Heading styles: include w:outlineLvl in pPr for all heading levels.
// 11. sectPr completeness: include w:cols w:space="720" and w:rsidR, in a
//     template's sectPr too where it hasn't them (see completedSectPr).
// 12. DEFLATE compression: use DEFLATE (not STORE) when generating the zip.
//     Word re-compresses uncompressed entries on open and marks the file dirty.
//
// Known limitation — Word recalculation triggers dirty flag:
//   - Tables: Word recalculates column widths/layout on open.
//   - Citation field codes: Word recalculates Zotero/citation fields on open.
// In both cases, even Word's own saved version of the document is marked as
// modified when re-opened. This is inherent Word behavior that cannot be
// prevented by any XML structure we emit.

// Placeholder for deferred bibliography insertion (NUL bytes cannot appear in valid XML)
const BIBL_PLACEHOLDER = '\x00MANUSCRIPT_BIBL_MARKER\x00';
// Placeholder for the break that gives a bibliography between two sections a
// section of its own, written only where the bibliography shows something
const BIBL_BREAK_PLACEHOLDER = '\x00MANUSCRIPT_BIBL_BREAK\x00';

// Map Manuscript Markdown color names to OOXML ST_HighlightColor values
const COLOR_TO_OOXML: Record<string, string> = {
  'yellow': 'yellow', 'green': 'green', 'blue': 'blue', 'red': 'red', 'black': 'black',
  'turquoise': 'cyan', 'pink': 'magenta', 'dark-blue': 'darkBlue',
  'teal': 'darkCyan', 'violet': 'darkMagenta', 'dark-red': 'darkRed',
  'dark-yellow': 'darkYellow', 'gray-50': 'darkGray', 'gray-25': 'lightGray',
};

const ALERT_STYLE_BY_TYPE: Record<GfmAlertType, string> = {
  note: 'GitHubNote',
  tip: 'GitHubTip',
  important: 'GitHubImportant',
  warning: 'GitHubWarning',
  caution: 'GitHubCaution',
};

// Map user-facing blockquote style option to OOXML styleId
const BLOCKQUOTE_STYLE_ID: Record<string, string> = {
  'GitHub': 'GitHubBlockquote',
  'Quote': 'Quote',
  'IntenseQuote': 'IntenseQuote',
};

const ALERT_GLYPH_BY_TYPE: Record<GfmAlertType, string> = {
  note: '※',
  tip: '◈',
  important: '‼',
  warning: '▲',
  caution: '⛒',
};

import { PARA_PLACEHOLDER, LINE_PLACEHOLDER, preprocessCriticMarkup } from './critic-markup';
import { crossRefLabel } from './citation-syntax';
import { type LineEdit, type LineMap, lineCount, linesAfterEdits, sameLines, throughLines, withEnd } from './line-map';
import { normalizeNewlines } from './newlines';
import { DOCUMENT_START, bodyClosingSectPrXml, fencedBodySectPrXml, isLandscapeSectPr, nextPageSectPrXml, pageContentWidthPx, parseTemplateMargins, parseTemplatePgSz, sectPrPropertyIn, sectionBreakSectPrXml, sectionIsLandscape, textWidthTwips, wAttributeOf, withTemplateSectPrs, writableWidthTwips } from './md-to-docx-sections';
import { CODE_BLOCK_INSET_TWIPS, type CodeBlockConfig, type FontOverrides, GITHUB_BLOCKQUOTE_BORDER_COLOR, GITHUB_BLOCKQUOTE_BORDER_SIZE, GITHUB_BLOCKQUOTE_BORDER_SPACE, GITHUB_BLOCKQUOTE_INDENT, RAW_HTML_STYLE_ID, SINGLE_LINE_SPACING, applyAlertColorsToTemplate, applyLineSpacingToTemplate, codeFontName, customStyleId, ensureManuscriptStyles, extractNormalStyleSizeHp, holdsRawHtmlLineEnd, rawHtmlTextElements, resolveAtIndex, resolveFontOverrides, resolveLineSpacingTwips, stylesXml, tableFontOnRuns, tableRFonts, templateStyleIds, templateWithFontOverrides, withCaptionStyle, withTemplateStyleIds, withoutInheritedSizes } from './md-to-docx-styles';
import { type ListLevels, type NumberingOverride, listNumIds, numberingXml, styleNumIds, templateListLevels, templateNumIdsInUse, withNumberingOverrides, withOwnNums, withoutUnusedNums } from './md-to-docx-numbering';
import { appPropsXml, contentTypesXml, corePropsXml, defaultThemeXml, documentRelsXml, fontTableXml, noteRelsXml, relsXml, settingsXml, webSettingsXml } from './md-to-docx-parts';
import { type CustomPropEntry, type ListItemRead, annotateHtmlCommentIndices, bibDataProps, bibKeyOrderProps, bibliographyHangingIndentProps, bibliographyPathProps, chunkCustomProps, codeBlockLanguageProps, codeBlockStylingProps, commentIdMappingProps, consecutiveReplyProps, customPropsXml, defaultCslProps, footnoteBookmarkName, footnoteCrossRefProps, footnoteIdMappingProps, frontmatterBlankLineProps, frontmatterFieldOrderProps, frontmatterLayoutProps, frontmatterSettingsProps, gridTableMaxLineWidthProps, htmlCommentAfterGapProps, htmlCommentGapProps, indentOverrideProps, lineSpacingProps, listBlankLineProps, listIndentOverrideProps, listIndentProps, listItemIndentOverrideProps, noteCodeBlockProps, paragraphIndentProps, pipeTableMaxLineWidthProps, recordListBlankLine, recordListItemsRead, zoteroCustomProps } from './md-to-docx-custom-props';
import { type BlockquotePlace, EMPTY_NOTE_CODE_WARNING, HTML_AROUND_TABLE_WARNING, type MdRun, type MdTableRow, type MdToken, NOTE_BLOCK_WARNINGS, NOTE_ORIENTATION_WARNING, type QuoteGroupIdentity, type TableFormat, applyCustomStyleSentinels, blockquoteListPlaces, blockquoteSpacingMaps, citationTextParser, commentBodiesOmitted, compareNoteLabels, decodeXmlText, detectListIndent, extractFootnoteDefinitions, holdsOnlyCommentBodies, isBreakRun, isCommentBodyParagraph, isCommentMarkerRun, isEmptyCodeBlock, isImplicitStyleClose, isNonRenderingAlertLeadRun, isOrientationDirective, isOrphanedOrientationClose, isQuoteCommentBodies, isStyleDirective, linkDefinitionsOf, marksSectionOrBibliography, moveHiddenAlertLeadComments, noteKeyParser, parseMd, processInlineChildren, showsInWord, splitAtCriticMarkup, splitsInHighlight, startsAdjacentList, startsStyleBlock, takesQuoteCommentBodies, toTextRunFromInner, unstyledInStyleBlock, withoutCommentBodyLines } from './md-to-docx-parse';
export { blocksAsRead, citationEndInText, compareNoteLabels, createMarkdownIt, detectListIndent, directiveRest, endsParagraph, exportReads, extractFootnoteDefinitions, holdsDirective, htmlBlocksIn, imageLabelEnd, itemDropsComment, linkifiedColons, linkifiedText, linkifyMatches, outsideComments, parseMd, readsAsParagraph, readsCommentsInline, showsAsText, startsHtmlBlock, type ListContinuation, type MdRun, type MdTableCell, type MdTableRow, type MdToken, type TableCaption, type TableFormat, withoutSpaceOutsideComments } from './md-to-docx-parse';
export { parseTemplatePgSz } from './md-to-docx-sections';
export { CODE_BLOCK_MARGIN_INDENT, TABLE_FONT_SLOTS, THEME_MINOR_FONT, applyAlertColorsToTemplate, applyFontOverridesToTemplate, codeFontName, customStyleId, resolveAtIndex, resolveFontOverrides, stylesXml, tableFontOnRuns, tableRFonts, tableStyleFont, tableTextDefaultFont, templateStyleIds, type CodeBlockConfig, type FontOverrides } from './md-to-docx-styles';
export { annotateHtmlCommentIndices, countsForIndent, recordListBlankLine } from './md-to-docx-custom-props';
export { PARA_PLACEHOLDER, LINE_PLACEHOLDER, preprocessCriticMarkup };

/** A note's self-reference mark `selfRefRun` in the bookmark that
 *  cross-references to note `noteId` point to (see noteReferenceXml) */
function bookmarkedSelfRef(selfRefRun: string, noteId: number, state: DocxGenState): string {
  const bkmkId = state.nextBookmarkId++;
  return '<w:bookmarkStart w:id="' + bkmkId + '" w:name="' + footnoteBookmarkName(noteId) + '"/>' + selfRefRun + '<w:bookmarkEnd w:id="' + bkmkId + '"/>';
}

/** The start of a paragraph with no text, which a later paragraph of its
 *  group replaces as the group's start */
const blankParagraphStart = paragraphStartFingerprint('');

/** The place of each group in `places`, with what tells import it's that
 *  group, the number of groups that it tells of, as a quote Word added
 *  with the same text tells of the one export wrote too, and import then
 *  can't tell which is which, and the group's place among them, as one
 *  Word added with other text before them moves each one's index to the
 *  next one's */
export function blockquoteListLevelProps(places: Map<number, BlockquotePlace>, identities: Map<number, QuoteGroupIdentity>): CustomPropEntry[] {
  const key = (identity: QuoteGroupIdentity) => identity.paragraphs + ':' + identity.start;
  const groups = new Map<string, number>();
  const orders = new Map<number, number>();
  for (const [index, identity] of [...identities].sort(([a], [b]) => a - b)) {
    if (identity.paragraphs === 0) continue;
    orders.set(index, groups.get(key(identity)) ?? 0);
    groups.set(key(identity), (groups.get(key(identity)) ?? 0) + 1);
  }
  const mapping: Record<string, [number, number, string, number, number, number]> = {};
  for (const [index, [listLevel, level]] of places) {
    const identity = identities.get(index);
    if (identity?.start !== undefined && identity.paragraphs > 0) {
      mapping[String(index)] = [listLevel, level, identity.start, identity.paragraphs, groups.get(key(identity))!, orders.get(index)!];
    }
  }
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_LIST_LEVELS_', JSON.stringify(mapping));
}

/** What tells import each quote group export wrote, by group index, for
 *  the records export keeps of the groups by index (see
 *  blockquoteSpacingMaps): the number of its paragraphs, the fingerprint of
 *  its start and its kind (see QuoteGroupIdentity). Word can add a quote
 *  before one, or take one out, which moves the index of each after it, so
 *  import finds each group's records by these (see readQuoteGroups in
 *  converter.ts) */
export function blockquoteIdentityProps(identities: Map<number, QuoteGroupIdentity>): CustomPropEntry[] {
  const mapping: Record<string, [number, string, string]> = {};
  for (const [index, identity] of identities) {
    if (identity.start !== undefined && identity.paragraphs > 0) mapping[String(index)] = [identity.paragraphs, identity.start, identity.kind];
  }
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_IDENTITIES_', JSON.stringify(mapping));
}

// Assign a sequential blockquoteGroupIndex to each blockquote token so the
// gap map can be correlated during docx→md conversion.  Groups are delimited
// by alertFirst/alertLast boundaries set by annotateBlockquoteBoundaries.
export function annotateBlockquoteGroupIndices(tokens: MdToken[]): void {
  let groupIndex = 0;
  let inGroup = false;
  for (const token of tokens) {
    if (isImplicitStyleClose(token)) continue;
    if (token.type !== 'blockquote') {
      if (inGroup) {
        groupIndex++;
        inGroup = false;
      }
      continue;
    }
    if (!inGroup) {
      inGroup = true;
    }
    token.blockquoteGroupIndex = groupIndex;
    if (token.alertLast) {
      groupIndex++;
      inGroup = false;
    }
  }
}

// Serialize blockquote gap metadata as custom XML properties, following the
// same chunked-JSON pattern used by codeBlockLanguageProps.
export function blockquoteGapProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_GAPS_', JSON.stringify(mapping));
}
export function blockquoteAlertMarkerStyleProps(inlineByGroup: Map<number, boolean>): CustomPropEntry[] {
  if (inlineByGroup.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, isInline] of inlineByGroup) {
    mapping[String(index)] = isInline ? 1 : 0;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_ALERT_STYLE_', JSON.stringify(mapping));
}
/** The alerts whose marker is a paragraph of its own, which export writes
 *  no paragraph for with the label hidden, by group index (see alertAlone) */
export function blockquoteAlertMarkerAloneProps(aloneByGroup: Map<number, boolean>): CustomPropEntry[] {
  if (aloneByGroup.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, alone] of aloneByGroup) {
    if (alone) mapping[String(index)] = 1;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_ALERT_MARKER_ALONE_', JSON.stringify(mapping));
}
export function blockquotePreContentBlankLineProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_PRE_CONTENT_BLANK_LINES_', JSON.stringify(mapping));
}
export function blockquotePostContentBlankLineProps(gaps: Map<number, number>): CustomPropEntry[] {
  if (gaps.size === 0) return [];
  const mapping: Record<string, number> = {};
  for (const [index, count] of gaps) {
    mapping[String(index)] = count;
  }
  return chunkCustomProps('MANUSCRIPT_BLOCKQUOTE_POST_CONTENT_BLANK_LINES_', JSON.stringify(mapping));
}

export function noteImageFormatProps(imageFormats: Map<string, string>): CustomPropEntry[] {
  if (imageFormats.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [rId, syntax] of imageFormats) {
    mapping[rId] = syntax;
  }
  return chunkCustomProps('MANUSCRIPT_NOTE_IMAGE_FORMATS_', JSON.stringify(mapping));
}

export function imageFormatProps(imageFormats: Map<string, string>): CustomPropEntry[] {
  if (imageFormats.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [rId, syntax] of imageFormats) {
    mapping[rId] = syntax;
  }
  return chunkCustomProps('MANUSCRIPT_IMAGE_FORMATS_', JSON.stringify(mapping));
}

export function tableFormatProps(tableFormats: Map<number, TableFormat>): CustomPropEntry[] {
  if (tableFormats.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [idx, fmt] of tableFormats) {
    mapping[String(idx)] = fmt;
  }
  return chunkCustomProps('MANUSCRIPT_TABLE_FORMATS_', JSON.stringify(mapping));
}

// A table's own font size, font and column widths, from its directive or
// data- attribute, each kept where it's the document's too, as the table
// keeps it if the document's changes

export function tableFontSizeProps(sizes: Map<number, number>): CustomPropEntry[] {
  const mapping: Record<string, string> = {};
  for (const [idx, pt] of sizes) mapping[String(idx)] = String(pt);
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_TABLE_FONT_SIZES_', JSON.stringify(mapping));
}

export function tableFontProps(fonts: Map<number, string>): CustomPropEntry[] {
  const mapping: Record<string, string> = {};
  for (const [idx, font] of fonts) mapping[String(idx)] = font;
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_TABLE_FONTS_', JSON.stringify(mapping));
}

export function tableColWidthsProps(colWidths: Map<number, string>): CustomPropEntry[] {
  const mapping: Record<string, string> = {};
  for (const [idx, val] of colWidths) mapping[String(idx)] = val;
  if (Object.keys(mapping).length === 0) return [];
  return chunkCustomProps('MANUSCRIPT_TABLE_COL_WIDTHS_', JSON.stringify(mapping));
}

function tableNumberFormatProps(prefix: string, values: Map<number, string>): CustomPropEntry[] {
  if (values.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [idx, value] of values) mapping[String(idx)] = value;
  return chunkCustomProps(prefix, JSON.stringify(mapping));
}

export function landscapeTableProps(landscapeTables: Set<number>): CustomPropEntry[] {
  if (landscapeTables.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const idx of landscapeTables) {
    mapping[String(idx)] = 'landscape';
  }
  return chunkCustomProps('MANUSCRIPT_LANDSCAPE_TABLES_', JSON.stringify(mapping));
}

export function portraitTableProps(portraitTables: Set<number>): CustomPropEntry[] {
  if (portraitTables.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const idx of portraitTables) {
    mapping[String(idx)] = 'portrait';
  }
  return chunkCustomProps('MANUSCRIPT_PORTRAIT_TABLES_', JSON.stringify(mapping));
}

export function portraitBreakProps(portraitBreakOrdinals: Set<number>): CustomPropEntry[] {
  if (portraitBreakOrdinals.size === 0) return [];
  return chunkCustomProps('MANUSCRIPT_PORTRAIT_BREAKS_', JSON.stringify([...portraitBreakOrdinals]));
}

/** The sections, by the ordinal of the break that ends each, a references
 *  marker before their opening fence is written at the start of */
export function referencesBeforeSectionsProps(ordinals: number[] | undefined): CustomPropEntry[] {
  if (!ordinals?.length) return [];
  return chunkCustomProps('MANUSCRIPT_REFERENCES_BEFORE_SECTIONS_', JSON.stringify(ordinals));
}

/** The hidden paragraphs export writes in a section, by the ordinal of the
 *  break that ends it, as many as each has: those at its start that come
 *  before its opening fence, or those at its end that come after its
 *  closing fence */
export function hiddenOutsideSectionsProps(prefix: string, counts: Map<number, number> | undefined): CustomPropEntry[] {
  if (!counts?.size) return [];
  return chunkCustomProps(prefix, JSON.stringify(Object.fromEntries(counts)));
}

export function embedDirectiveProps(mapping: Map<number, string>): CustomPropEntry[] {
  if (mapping.size === 0) return [];
  const obj: Record<string, string> = {};
  for (const [idx, directive] of mapping) {
    obj[String(idx)] = directive;
  }
  return chunkCustomProps('MANUSCRIPT_EMBED_DIRECTIVES_', JSON.stringify(obj));
}

export function gridSourceColWidthsProps(mapping: Map<number, number[]>): CustomPropEntry[] {
  if (mapping.size === 0) return [];
  const obj: Record<string, string> = {};
  for (const [idx, widths] of mapping) {
    obj[String(idx)] = widths.join(',');
  }
  return chunkCustomProps('MANUSCRIPT_GRID_SOURCE_COL_WIDTHS_', JSON.stringify(obj));
}

export function pipeTableAlignedProps(aligned: Map<number, boolean>): CustomPropEntry[] {
  if (aligned.size === 0) return [];
  const mapping: Record<string, string> = {};
  for (const [idx, val] of aligned) {
    mapping[String(idx)] = String(val);
  }
  return chunkCustomProps('MANUSCRIPT_PIPE_TABLE_ALIGNED_', JSON.stringify(mapping));
}

/** The text of each cell of each row of a table generateTable wrote, as
 *  import reads it (see tableCellText in converter.ts): its runs' text,
 *  shown or deleted, as a tracked change's, with a tab, non-breaking or
 *  optional hyphen as the character Word's element for it is, and a line
 *  feed in the text as the space Word shows, but not a hidden run's, as an
 *  HTML comment's, or a field's, as a citation's, which import reads as
 *  what they are, and no cell that goes on a merge above */
function wordTableTexts(xml: string): string[][] {
  return [...xml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map(row => [...row[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)]
    .filter(cell => !/<w:vMerge\/>/.test(cell[1]))
    .map(cell => wordText(cell[1])));
}

/** The text of the runs in `xml`, as import reads it, but for a field's and
 *  hidden text, as a comment's */
function wordText(xml: string): string {
  let text = '';
  let fields = 0;
  for (const run of xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    // The element, as text can't hold a <, which its attribute's can
    const fieldChar = /<w:fldChar\s[^>]*w:fldCharType="(begin|end)"/.exec(run[1])?.[1];
    if (fieldChar === 'begin') fields++;
    else if (fieldChar === 'end') fields = Math.max(0, fields - 1);
    else if (fields === 0 && !run[1].includes('<w:vanish/>')) {
      for (const piece of run[1].matchAll(/<w:(t|delText)(?:\s[^>]*)?>([^<]*)<\/w:\1>|<w:(tab|noBreakHyphen|softHyphen)\/>/g)) {
        text += piece[3] ? { tab: '\t', noBreakHyphen: '\u2011', softHyphen: '\u00AD' }[piece[3]] : decodeXmlText(piece[2]).replace(/\r\n?|\n/g, ' ');
      }
    }
  }
  return text;
}

// OOXML Generation Layer

interface TemplateParts {
  parts: Map<string, Uint8Array>;
  sections: TemplateSections; // trailing <w:sectPr> from template document.xml, and its headers and footers
}

/** A run's text, deleted text or field code, or an equation's text */
const TEXT_ELEMENT = /<((?:w|m):(?:t|delText|instrText|delInstrText))(\s[^>]*)?>([^<]*)<\/\1>/g;

/** Remove the characters XML can't hold from the package's XML, of the
 *  parts at `paths` or all of them, as the Markdown's text, URLs or
 *  comments can have, which made a part Word can't read, and return how
 *  many: a control character other than a tab or line end, or U+FFFE or
 *  U+FFFF (see hasNonXmlCharacter). Half a surrogate pair is one too, but
 *  JSZip writes it as U+FFFD before the pass reads the part */
async function removeCharactersXmlCantHold(zip: import('jszip'), paths = Object.keys(zip.files)): Promise<number> {
  let removed = 0;
  for (const path of paths) {
    if (zip.files[path].dir || !/\.(?:xml|rels)$/.test(path)) continue;
    const bytes = await zip.file(path)!.async('uint8array');
    // A template's part in UTF-16, which goes as it came
    if (bytes[0] === 0 || bytes[1] === 0 || bytes[0] === 0xFF && bytes[1] === 0xFE || bytes[0] === 0xFE && bytes[1] === 0xFF) continue;
    const xml = new TextDecoder().decode(bytes);
    if (!hasNonXmlCharacter(xml)) continue;
    const strip = (text: string) => {
      const kept = withoutNonXmlCharacters(text);
      removed += kept.removed;
      return kept.text;
    };
    zip.file(path, strip(xml.replace(TEXT_ELEMENT, (element, tag: string, attrs = '', text: string) => {
      if (!hasNonXmlCharacter(text)) return element;
      const rest = strip(text);
      // A space the character kept from the edge of the text, which Word
      // drops there without
      const preserve = !attrs.includes('xml:space') && (rest.startsWith(' ') || rest.endsWith(' '));
      return '<' + tag + attrs + (preserve ? ' xml:space="preserve"' : '') + '>' + rest + '</' + tag + '>';
    })));
  }
  return removed;
}

async function extractTemplateParts(templateDocx: Uint8Array): Promise<TemplateParts> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(templateDocx);
  const parts = new Map<string, Uint8Array>();

  for (const path of ['word/styles.xml', 'word/numbering.xml', 'word/settings.xml']) {
    const file = zip.file(path);
    if (file) {
      parts.set(path, await file.async('uint8array'));
    }
  }
  // The theme the document's relationship names, whatever its part's name,
  // as import reads it, which export writes as theme1.xml
  const theme = zip.file(await relatedPartPath(zip, 'word/document.xml', 'theme') ?? 'word/theme/theme1.xml');
  if (theme) parts.set('word/theme/theme1.xml', await theme.async('uint8array'));

  // The document-level <w:sectPr> (direct child of <w:body>), to preserve
  // template page layout (size, margins, orientation), and the headers and
  // footers its sections show (see template-sections.ts).
  // Invariant: reuse ONLY the trailing body-level sectPr (the final <w:sectPr>
  // before </w:body>). Paragraph-level section breaks may contain <w:sectPr>
  // inside <w:pPr>; selecting from an earlier sectPr corrupts template reuse.
  return { parts, sections: await readTemplateSections(zip) };
}

export interface MdToDocxOptions {
  bibtex?: string;
  authorName?: string;
  templateDocx?: Uint8Array;
  zoteroBiblData?: ZoteroBiblData;
  /** Directory for caching downloaded CSL styles (e.g. VS Code global storage). */
  cslCacheDir?: string;
  /** Directory of the source markdown file, used to resolve relative CSL paths. */
  sourceDir?: string;
  /** Called when a CSL style is not bundled or found locally.
   *  Return true to attempt downloading from the CSL repository. */
  onStyleNotFound?: (styleName: string) => Promise<boolean>;
  /** Word paragraph style to use for blockquotes. */
  blockquoteStyle?: 'Quote' | 'IntenseQuote' | 'GitHub';
  /** Color scheme for alert callouts. */
  colors?: ColorScheme;
  /** Whether alert callouts include the generated glyph/title label. */
  calloutLabels?: boolean;
  /** Absolute path to the source markdown file (for resolving embed directives). */
  documentPath?: string;
  /** Resolver for reading embedded files (CSV, TSV, XLSX, MD). */
  embedResolver?: import('./embed-preprocess').EmbedResolver;
  /** Maximum .dta file size in bytes (default 10 MB). */
  maxDtaFileSize?: number;
}

export interface MdToDocxResult {
  docx: Uint8Array;
  warnings: string[];
}

export interface FootnoteEntry {
  id: number;
  bodyXml: string;
}

export interface DocxGenState {
  commentId: number;
  comments: CommentEntry[];
  commentIdMap: Map<string, number>; // markdown ID -> OOXML numeric ID
  // While the body is written: the comments' bodies whose ranges it holds
  // none of, as a range in a note, whose ID registers after (see
  // addIdCommentBody)
  deferredCommentBodies?: MdRun[];
  // The IDs of the comments' bodies in the text and its notes, without one
  // of which a range writes nothing (see prescanCommentIds)
  commentBodyIds?: ReadonlySet<string>;
  relationships: Map<string, string>; // URL -> rId
  nextRId: number;
  rIdOffset: number; // reserved rIds for fixed relationships (styles, numbering, comments, theme, settings)
  warnings: string[];
  hasList: boolean;
  listStartOverrides: NumberingOverride[]; // ordered lists after the first
  firstOverrideNumId?: number; // numIds below it are bullets', numbers', and a template's styles' and headers' (default 3)
  bulletNumId?: number; // the numId bullets take (default 1; see listNumIds)
  decimalNumId?: number; // the numId numbers take (default 2)
  usedOrderedNumId?: boolean; // whether an ordered list, or a bullet in the same count, has used numbers' numId, so the next needs its own
  templateListLevels?: ListLevels; // how Word numbers the template's numbered lists, by level
  hasComments: boolean;
  hasFootnotes: boolean;
  hasEndnotes: boolean;
  footnoteId: number;           // next available note ID (starts at 1)
  footnoteEntries: FootnoteEntry[];
  footnoteLabelToId: Map<string, number>;
  notesMode: 'footnotes' | 'endnotes';
  missingKeys: Set<string>;
  citationIds: Set<string>;
  citationItemIds: Map<string, string | number>;
  timezone?: string; // UTC offset from frontmatter (e.g. "-05:00")
  replyRanges: Array<{replyId: number; parentId: number}>;
  nextParaId: number;
  codeBlockIndex: number;
  codeBlockLanguages: Map<number, string>;
  /** The index of each note's first code block, by the note's key on import
   *  (see noteCodeBlockProps) */
  noteCodeBlockStarts: Map<string, number>;
  citedKeys: Set<string>;
  codeFont: string;
  codeShadingMode: boolean;
  blockquoteGaps: Map<number, number>; // gap (blank-line count) after each blockquote group, keyed by group index
  blockquotePreContentBlankLines: Map<number, number>; // blank lines before group when previous non-blank source line is non-blockquote content
  blockquotePostContentBlankLines: Map<number, number>; // blank lines after group when next non-blank line is non-blockquote content
  blockquoteAlertMarkerInlineByGroup: Map<number, boolean>; // alert group index -> inline marker style
  blockquotePlaces: Map<number, BlockquotePlace>; // the place of a quote group its indent doesn't tell, by group index (see blockquoteListPlaces)
  blockquoteIdentities: Map<number, QuoteGroupIdentity>; // what tells import each quote group is the one written, by group index
  // Image tracking
  imageRelationships: Map<string, { rId: string; mediaPath: string }>; // dedup key (absPath + '\0' + syntax) -> { rId, media path }
  imageMediaPaths: Map<string, string>; // absPath -> mediaPath (for binary dedup across syntaxes)
  imageBinaries: Map<string, Uint8Array>; // media path -> binary data
  imageFormats: Map<string, string>; // rId -> syntax ("md" | "html") — document-body only
  noteImageFormats: Map<string, string>; // part:rId, as footnotes:rId1 -> syntax ("md" | "html") — note-body only
  imageExtensions: Set<string>; // collected extensions for content types
  rsid: string; // Revision Save ID for paragraph-level w:rsidR attributes
  nextImageDocPrId: number;
  tableIndex: number;
  tableFormats: Map<number, TableFormat>; // table index -> source format
  tableFontSizes: Map<number, number>; // table index -> per-table font size (pt)
  tableFonts: Map<number, string>;     // table index -> per-table font name
  tableColWidths: Map<number, string>; // table index -> serialized col widths (e.g. "2 1 1" or "equal")
  tableDigits: Map<number, string>;
  tableDecimalMarks: Map<number, string>;
  tableDigitGroupings: Map<number, string>;
  tableHtmlAround: Map<number, [string, string, string, string, string, string, string]>; // table index -> the HTML before and after it in its block, its first row and contents, the count of tables alike in both before it, its note's kind and ID, or '' in the body, and the count of tables alike in both export wrote in all
  tablesAlike: Map<string, number>; // a table's note, first row and contents -> the tables so far with all three
  tableIdentities: TableIdentity[]; // table index -> its note, first row and contents, which import finds its settings by
  fontOverrides?: FontOverrides;       // document-level font overrides for table default resolution
  listIndent: 'tab' | 'spaces'; // indentation style for nested list items
  consecutiveReplyParaIds: Set<string>; // parent paraIds whose replies were in consecutive format
  htmlCommentGaps: Map<number, number>; // blank-line-before count per HTML comment index (non-default only)
  htmlCommentAfterGaps: Map<number, number>; // blank-line-after count per HTML comment index (non-default only)
  tableRunRPrExtra: string; // extra rPr elements injected into every run inside a table cell (per-table size overrides)
  tableRunFont?: string; // the table's font, its directive's or the frontmatter's, which tableRunRPr writes on the runs tableFontOnRuns says
  landscapeTables: Set<number>; // table indices that have data-orientation="landscape"
  portraitTables: Set<number>;  // table indices that have data-orientation="portrait"
  inLandscapeSection: boolean;  // tracks current landscape state during generation
  inPortraitSection: boolean;   // tracks current portrait fence state during generation
  inLastSection?: boolean;      // whether the section being written is the last, which keeps the template's page (see sectionIsLandscape)
  lastSectionLandscape?: boolean; // whether the last section's page, the body's own properties', is on its side
  noteLandscape?: Map<string, boolean>; // whether the page of each note's owning reference is on its side, by label
  noteNumbering?: NoteNumbering; // how Word numbers the notes (see noteNumberingOf)
  noteNumbers?: Map<number, string>; // the number Word shows for each note the body references, by ID, which a reference again shows (see noteNumbersIn)
  noteSectionLandscape?: boolean; // while a note is written, whether the page it's on is on its side: a footnote's owning reference's, or an endnote's, at the document's end, the last section's
  sectionBreakOrdinal: number;  // counter for paragraph-level sectPr emissions (for portrait round-trip)
  portraitBreakOrdinals: Set<number>; // ordinals of portrait-fence close section breaks
  referencesBeforeSections?: number[]; // ordinals of the breaks ending the sections a references marker before their opening fence is written at the start of
  hiddenBeforeSections?: Map<number, number>; // the hidden paragraphs before a section's opening fence written at its start, by the ordinal of the break that ends it
  hiddenAfterSections?: Map<number, number>; // the hidden paragraphs after the last fenced section's closing fence written at its end, by the ordinal of the break that ends it
  templatePageSection?: number; // the last section's ordinal, the number of breaks before it, where it takes the template's landscape page, which no fence set
  templateLayout?: LayoutEntry[]; // the last section's layout, its break type, page and columns, as export wrote it and as the template had it, where export changed it, which a later export that takes this one as its template puts back
  templateSectPr?: string;      // trailing <w:sectPr> from template document.xml
  templateStyles?: boolean;     // whether styles.xml is the template's, not the one export writes (see stylesXml), whose default paragraph style, Normal, and docDefaults give no space before
  templateSections?: TemplateSections; // the template's, whose headers, footers and page numbering the sectPrs written take
  pipeTableAligned: Map<number, boolean>; // table index -> whether pipe table was column-aligned
  gridSourceColWidths: Map<number, number[]>; // table index -> original grid table column char-widths
  sentinelGaps: Record<string, number>; // before-gap for landscape/portrait sentinels (e.g. "pc0" → blankLinesBefore for first portrait_close)
  styleBlockEdges: Record<string, number>; // the blocks Word can't give a style block's style at each block's edges (see styleBlock in generateDocumentXml)
  activeCustomStyle?: string; // currently active <!-- style: X --> block name
  customStyles?: Record<string, CustomStyleDef>; // declared styles for indent inheritance/overrides
  activeListStartOverrides: Map<number, number>; // ilvl → numId of the ordered list open at that level
  listItemNumbers?: (number | undefined)[]; // the number of the last item at each level of the open list, to its level, or undefined for a bullet
  inNoteBody: boolean; // true while generating footnote/endnote body XML
  noteRelationships: Map<string, string>; // URL -> rId for hyperlinks inside footnote/endnote bodies
  noteImageRelationships: Map<string, { rId: string; mediaPath: string }>; // dedup key -> { rId, media path } for images inside footnote/endnote bodies
  noteNextRId: number; // next rId for footnotes.xml.rels (independent of document rIds)
  footnoteCrossRefLabels: Set<string>; // footnote labels that have 2+ references (need bookmarks + cross-ref fields)
  untrackedNoteLabels?: Set<string>; // note labels with a reference outside any tracked change (see noteReferenceXml)
  trackedNoteReference?: boolean;    // whether a note reference sits in a tracked change
  ownedNoteLabels?: Set<string>;     // note labels whose Word note reference has been written
  noteRevision?: 'addition';         // set while generating inserted content
  nextBookmarkId: number; // counter for unique bookmark IDs within footnotes/endnotes XML
  captions: CaptionOptions; // the words a caption shows and where it goes, from the frontmatter (see captions.ts)
  figureNumber: number; // the figures numbered so far
  tableNumber: number; // the tables with captions numbered so far
  captionBookmarks: Set<string>; // the names of the bookmarks of the captions so far, in lower case, as Word compares them
  captionLabels: Map<string, string>; // each caption's bookmark's name, by which import reads its label, to the label, where the name alone doesn't give it (see labelOfBookmark)
  captionTargets?: Map<string, CaptionTarget>; // each label's first caption, which a cross-reference to it shows (see crossRefXml)
  labelsCaptioned?: Set<string>; // the labels of more than one caption
  crossRefs?: CrossRef[]; // the cross-references written so far, each a field whose caption is known once the document is (see withCrossRefs)
  tableRecords?: TableRecord[]; // each table's XML, whose identity is read once the cross-references in it are (see recordTableIdentity)
  captionedImages: Set<MdRun>; // the images of figures, which take a caption, and of no others (see figureImageOf)
  uncaptionedLabels: Set<string>; // the labels of images that aren't figures, each of which has had its warning
  firstLineIndentTwips?: number;   // undefined = no indent mode
  indentMode: boolean;       // true when first-line indent is active (controls inter-paragraph spacing removal)
  afterHeading: boolean;           // suppress indent on first para after heading
  indentOverrides: Map<number, 'indent' | 'no-indent'>; // body paragraph index → override
  bodyParagraphIndex: number;      // counter for body paragraphs (for indent override tracking)
  listIndentOverrides: Map<number, 'indent' | 'no-indent'>; // list block index → override
  listItemIndentOverrides: Map<number, Map<number, 'indent' | 'no-indent'>>; // list block index → the place in it of an item after a directive → override
  listBlockIndex: number;          // counter for list blocks (consecutive groups of list_items)
  listItemOrdinal: number;         // the place of the next list item in its list block
  listBlankLines: Map<number, number[]>; // list block index → the places in it of items with a blank line before them
  listItemsRead: ListItemRead[]; // where a template's styles number paragraphs, each list item, which the records take the list block and place of from the written document (see listPlacesOf)
  listByStyle?: (styleId: string | undefined) => ListMeta | UnnumberedListParagraph | undefined; // the list a template's style numbers its paragraphs in, by style ID, where its styles number any (see styleListMeta)
  embedDirectiveMap: Map<number, string>; // table index → original embed directive text
  embedDirectives: string[]; // ordered list of embed directive texts from preprocessing
}

function recordTableMetadata(token: MdToken, state: DocxGenState): void {
  const tableIndex = state.tableIndex;

  if (token.sourceFormat) state.tableFormats.set(tableIndex, token.sourceFormat);
  if (token.pipeAligned) state.pipeTableAligned.set(tableIndex, true);
  if (token.gridSourceColWidths) state.gridSourceColWidths.set(tableIndex, token.gridSourceColWidths);
  if (token.tableFontSize !== undefined) state.tableFontSizes.set(tableIndex, token.tableFontSize);
  if (token.tableFont) state.tableFonts.set(tableIndex, token.tableFont);
  if (token.tableColWidths) {
    const value = token.tableColWidths === 'equal' ? 'equal'
      : token.tableColWidths === 'auto' ? 'auto'
      : token.tableColWidths.join(' ');
    state.tableColWidths.set(tableIndex, value);
  }
  if (token.tableDigits !== undefined) state.tableDigits.set(tableIndex, String(token.tableDigits));
  if (token.tableDecimalMark) state.tableDecimalMarks.set(tableIndex, token.tableDecimalMark);
  if (token.tableDigitGrouping) state.tableDigitGroupings.set(tableIndex, token.tableDigitGrouping);
  // But for the line end or spaces before another table, which Word doesn't
  // need to show
  if (token.tableHtmlAround && /\S/.test(token.tableHtmlAround.join('')) && !state.warnings.includes(HTML_AROUND_TABLE_WARNING)) state.warnings.push(HTML_AROUND_TABLE_WARNING);
}

/** A table's XML, as generateTable wrote it, of the table at `index`, in
 *  the note `scope` or the body (see recordTableIdentity) */
interface TableRecord { token: MdToken; xml: string; index: number; scope: string }

/** Records the table `token`, whose XML is `xml`, the state's table at
 *  tableIndex, for its identity, read once the document is written (see
 *  settleTableIdentities), when each cross-reference in it shows what
 *  Word shows */
function recordTableIdentity(token: MdToken, xml: string, state: DocxGenState, scope: string): void {
  (state.tableRecords ??= []).push({ token, xml, index: state.tableIndex, scope });
}

/** Records each table's identity, which import finds its settings by, as
 *  its format and font, which recordTableMetadata records by its index, as
 *  one Word added or deleted would shift the tables' indices; and the HTML
 *  around it in its block with its identity, to put the HTML back with no
 *  other: its first row, as its cells' count and text, its text, as the
 *  Word table's XML holds it once `final` gives it, and the count of
 *  tables alike in both before it in the body or its note (`scope`), in
 *  the order they were written, which import counts too, but for one it
 *  writes as its embed directive, whose HTML it doesn't write either, and,
 *  once all are written, the count of them all */
function settleTableIdentities(state: DocxGenState, final: (xml: string) => string): void {
  for (const { token, xml, index, scope } of state.tableRecords ?? []) {
    const texts = wordTableTexts(final(xml));
    state.tableIdentities[index] = tableIdentity(texts, scope);
    const firstRow = tableFirstRowText(texts[0] ?? []);
    const contents = tableContentsFingerprint(texts);
    const key = scope + '\n' + firstRow + '\n' + contents;
    const alikeBefore = state.tablesAlike.get(key) ?? 0;
    if (token.embedIdx !== undefined && token.embedIdx < state.embedDirectives.length) continue;
    state.tablesAlike.set(key, alikeBefore + 1);
    if (token.tableHtmlAround) state.tableHtmlAround.set(index, [...token.tableHtmlAround, firstRow, contents, String(alikeBefore), scope, '']);
  }
  state.tableRecords = [];
}

interface CommentEntry {
  id: number;
  author: string;
  date: string;
  text: string;
  paraId: string;            // generated 8-hex-char ID
  parentParaId?: string;     // set for replies
}

// What a state's comments and replies' ranges hold, by id, kept by each
// array with those added since the last look, as a search of all of them
// for each comment took time in the square of their number. Each array
// only grows
const commentIdsSeen = new WeakMap<CommentEntry[], { seen: number; ids: Set<number> }>();
const replyRangesSeen = new WeakMap<DocxGenState['replyRanges'], { seen: number; byParent: Map<number, DocxGenState['replyRanges']> }>();

/** Whether `comments` has one with `id` */
function hasCommentWithId(comments: CommentEntry[], id: number): boolean {
  let known = commentIdsSeen.get(comments);
  if (!known) commentIdsSeen.set(comments, known = { seen: 0, ids: new Set() });
  for (; known.seen < comments.length; known.seen++) known.ids.add(comments[known.seen].id);
  return known.ids.has(id);
}

/** The ranges in `ranges` of the replies to the comment with `parentId`, in
 *  their order there, as of now, which the next look adds to */
function replyRangesOf(ranges: DocxGenState['replyRanges'], parentId: number): Readonly<DocxGenState['replyRanges']> {
  let known = replyRangesSeen.get(ranges);
  if (!known) replyRangesSeen.set(ranges, known = { seen: 0, byParent: new Map() });
  for (; known.seen < ranges.length; known.seen++) {
    const range = ranges[known.seen];
    const forParent = known.byParent.get(range.parentId);
    if (forParent) forParent.push(range);
    else known.byParent.set(range.parentId, [range]);
  }
  return known.byParent.get(parentId) ?? [];
}

/**
 * Normalize a date string to UTC ISO format for Word XML.
 * Handles:
 * - ISO with offset: "2024-01-15T10:30-05:00" → "2024-01-15T15:30:00Z"
 * - ISO with Z: "2024-01-15T15:30:00Z" → passed through
 * - Local format without offset: "2024-01-15 10:30" → uses fallbackTz to build UTC
 * - Already UTC ISO: returned as-is
 */
export function normalizeToUtcIso(dateStr: string, fallbackTz?: string): string {
  if (!dateStr) return '';

  // If the string already has a timezone offset (+ or - after time, or trailing Z), parse directly
  const hasOffset = /[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/.test(dateStr);
  if (hasOffset) {
    const dt = new Date(dateStr);
    if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());
  }

  // Local date format like "2024-01-15T10:30" or "2024-01-15 10:30"
  // Append fallback timezone to interpret correctly
  const normalized = dateStr.replace(' ', 'T');
  if (fallbackTz) {
    const dt = new Date(normalized + fallbackTz);
    if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());
  }

  // Last resort: parse as-is (system local time interpretation)
  const dt = new Date(normalized);
  if (!isNaN(dt.getTime())) return stripMillis(dt.toISOString());

  // If nothing works, return the original string
  return dateStr;
}

function stripMillis(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** The w:highlight property for a highlighted run, or nothing. */
/** An equation's OMML with `highlight`, a w:highlight, in each of its runs'
 *  properties, where Word holds a highlight on an equation, which import
 *  reads (see mathHighlight in converter.ts) */
function mathWithHighlight(omml: string, highlight: string): string {
  return omml.replace(/<m:r>((?:<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)?)(?:<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>)?/g,
    (_run, mathProps: string, props: string | undefined) => '<m:r>' + mathProps + '<w:rPr>' + orderRPr((props ?? '') + highlight) + '</w:rPr>');
}

function highlightRPr(run: MdRun): string {
  return run.highlight ? '<w:highlight w:val="' + (COLOR_TO_OOXML[run.highlightColor || 'yellow'] || 'yellow') + '"/>' : '';
}

export function generateRPr(run: MdRun, extraRPr?: string): string {
  const parts: string[] = [];

  if (run.code) parts.push('<w:rStyle w:val="CodeChar"/>');
  else if (holdsRawHtmlLineEnd(run)) parts.push('<w:rStyle w:val="' + RAW_HTML_STYLE_ID + '"/>');
  if (run.bold) parts.push('<w:b/>');
  if (run.italic) parts.push('<w:i/>');
  if (run.strikethrough) parts.push('<w:strike/>');
  if (run.highlight) parts.push(highlightRPr(run));
  if (run.underline) parts.push('<w:u w:val="single"/>');
  if (run.superscript) parts.push('<w:vertAlign w:val="superscript"/>');
  else if (run.subscript) parts.push('<w:vertAlign w:val="subscript"/>');
  // A table's font and size go between these
  if (extraRPr) return '<w:rPr>' + orderRPr(parts.join('') + extraRPr) + '</w:rPr>';

  return parts.length > 0 ? '<w:rPr>' + parts.join('') + '</w:rPr>' : '';
}

// Wrap text in <w:t>, adding xml:space="preserve" only when the text has
// leading or trailing spaces. Word strips the attribute from text that doesn't
// need it, which sets the dirty flag. See dirty-flag invariant #1.
function wt(text: string): string {
  // escapeXmlText (not escapeXml) inside: quotes don't need escaping in element
  // text content, and &quot; triggers Word's dirty flag (see invariant #7 note).
  return textElements(text);
}

function delText(text: string): string {
  return textElements(text, 'w:delText');
}

export function generateRun(text: string, rPr: string): string {
  return '<w:r>' + rPr + wt(text) + '</w:r>';
}

/**
 * Hides an image export can't embed in the text, as its Markdown, so import
 * writes it back; a ZWSP closes it, since Word can split the run.
 */
function generateUnembeddedImageRun(run: MdRun, deleted = false): string {
  // A ZWSP of the image's own as a character reference, apart from the one
  // that closes it
  const source = run.imageSource?.replace(/\u200B/g, '&#8203;');
  return source ? generateHiddenHtmlCommentRun(source + '\u200B', deleted ? 'w:delText' : 'w:t') : '';
}

function generateHiddenHtmlCommentRun(text: string, tag: 'w:t' | 'w:delText' = 'w:t'): string {
  const textXml = tag === 'w:t' ? wt : delText;
  // Each line end as \n, as the Markdown's are by now, and also one that a
  // character reference decodes to after that, as &#13;&#10; in an image's
  // title or attributes, whose Markdown this writes, so no \r goes into
  // Word's text beside the break, which Word reads as a second line end
  const lines = normalizeNewlines(text).split('\n');
  // vanish hides the run in Word Desktop; white color makes it invisible in Word Online
  // (which shows hidden text in editing mode regardless of showDraftContent).
  // Schema order: vanish precedes color in CT_RPr.
  let xml = '<w:r><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr>';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      xml += '<w:br/>';
    }
    const line = lines[i];
    if (i === 0) {
      xml += textXml('\u200B' + line);
    } else if (line.length > 0) {
      xml += textXml(line);
    }
  }
  xml += '</w:r>';
  return xml;
}

function mergeRunFormatting(inner: MdRun, outer: MdRun, forced: Partial<MdRun> = {}): MdRun {
  const merged: MdRun = { ...inner, type: 'text', text: inner.text };

  merged.code = inner.code || outer.code || forced.code ? true : undefined;
  merged.bold = inner.bold || outer.bold || forced.bold ? true : undefined;
  merged.italic = inner.italic || outer.italic || forced.italic ? true : undefined;
  merged.underline = inner.underline || outer.underline || forced.underline ? true : undefined;
  merged.strikethrough = inner.strikethrough || outer.strikethrough || forced.strikethrough ? true : undefined;
  merged.superscript = inner.superscript || outer.superscript || forced.superscript ? true : undefined;
  merged.subscript = inner.subscript || outer.subscript || forced.subscript ? true : undefined;

  const hasHighlight = !!inner.highlight || !!outer.highlight || !!forced.highlight;
  merged.highlight = hasHighlight ? true : undefined;
  merged.highlightColor = hasHighlight
    ? (inner.highlightColor || outer.highlightColor || forced.highlightColor)
    : undefined;

  merged.href = inner.href || outer.href || forced.href;
  return merged;
}

function formatCriticInnerRuns(runs: MdRun[] | undefined, outer: MdRun, forced: Partial<MdRun> = {}): MdRun[] | undefined {
  if (!runs || runs.length === 0) return undefined;
  const formatted: MdRun[] = [];
  for (const run of runs) {
    // A line break takes the formatting around it, as its text does, which
    // Word shows on it, as a highlight or an underline, as of {====a\\\nb====}
    if (run.type === 'hardbreak') {
      formatted.push({ ...mergeRunFormatting(run, outer, forced), type: 'hardbreak', text: run.text });
      continue;
    }
    if (run.type === 'softbreak') {
      formatted.push(run);
      continue;
    }
    if (run.type === 'citation' || run.type === 'footnote_ref') {
      // Citation visible text comes from the field result (CSL/fallback), and
      // a note reference takes Word's reference style, so other outer
      // formatting is not merged in, as outside CriticMarkup. A highlight
      // marks a range, though, and covers them like its text.
      const highlight = run.highlight || outer.highlight || forced.highlight;
      formatted.push(highlight
        ? { ...run, highlight: true, highlightColor: run.highlightColor || outer.highlightColor || forced.highlightColor }
        : run);
      continue;
    }
    if (run.type === 'image') {
      // In the link around it, as text is
      const href = run.href || outer.href || forced.href;
      formatted.push(href ? { ...run, href } : run);
      continue;
    }
    if ((outer.highlight || forced.highlight) && splitsInHighlight(run)) {
      pushAll(formatted, formatCriticInnerRuns(splitAtCriticMarkup(run), outer, forced) ?? []);
      continue;
    }
    if (run.type === 'math' && (run.display || !run.mathParts) && (outer.highlight || forced.highlight)) {
      // Math takes a highlight around it, which Word holds in the
      // equation's runs (see mathWithHighlight), as a citation does; but not
      // an inline equation with a tracked change in it, as before (see
      // generateRuns)
      formatted.push({ ...run, highlight: true, highlightColor: run.highlightColor || outer.highlightColor || forced.highlightColor });
      continue;
    }
    if (run.type === 'math' || isCommentMarkerRun(run)) {
      formatted.push(run);
      continue;
    }
    if (run.type === 'critic_add' || run.type === 'critic_del' || run.type === 'critic_sub' || run.type === 'critic_comment' || run.type === 'critic_highlight') {
      const updated = { ...run };
      if (updated.innerRuns) updated.innerRuns = formatCriticInnerRuns(updated.innerRuns, outer, forced);
      if (updated.oldRuns) updated.oldRuns = formatCriticInnerRuns(updated.oldRuns, outer, forced);
      if (updated.newRuns) updated.newRuns = formatCriticInnerRuns(updated.newRuns, outer, forced);
      formatted.push(updated);
      continue;
    }
    if (run.type !== 'text') continue;
    formatted.push(mergeRunFormatting(run, outer, forced));
  }
  return formatted;
}

function generateInlineCriticContent(
  runs: MdRun[] | undefined,
  fallbackText: string,
  outer: MdRun,
  state: DocxGenState,
  options?: MdToDocxOptions,
  bibEntries?: Map<string, BibtexEntry>,
  citeprocEngine?: CiteprocEngine,
  forced: Partial<MdRun> = {}
): string {
  const formattedRuns = formatCriticInnerRuns(runs, outer, forced);
  if (formattedRuns && formattedRuns.length > 0) {
    return generateRuns(formattedRuns, state, options, bibEntries, citeprocEngine);
  }
  const fallbackRun = mergeRunFormatting({ type: 'text', text: fallbackText }, outer, forced);
  return generateRun(fallbackText, generateRPr(fallbackRun, tableRunRPr(state, fallbackRun)));
}

/** Whether runs hold a comment, a comment range marker or a comment body, at any depth */
function hasCommentRuns(runs: MdRun[] | undefined): boolean {
  return !!runs?.some(run => run.type === 'critic_comment' || isCommentMarkerRun(run)
    || hasCommentRuns(run.innerRuns) || hasCommentRuns(run.oldRuns) || hasCommentRuns(run.newRuns));
}

/**
 * Runs for generateRuns that delete `runs`, the payload of `deletion`, with
 * `outer`'s formatting, and keep their comments, in the form import writes
 * for a comment on deleted text, {--a --}{=={--b--}==}{>>c<<}: the text
 * between comments deleted as `deletion` deletes it, a {==...==} anchor
 * around its own deleted text, and a comment, range marker or body between
 * the deletions, so its reference isn't deleted text.
 * generateDeletedCriticContent skips comments, so a comment in a deletion or
 * a substitution's old text was lost.
 */
function deletionWithComments(runs: MdRun[] | undefined, outer: MdRun, deletion: MdRun): MdRun[] {
  const pieces: MdRun[] = [];
  let deleted: MdRun[] = [];
  const flush = () => {
    if (deleted.length === 0) return;
    pieces.push({ ...deletion, type: 'critic_del', text: deleted.map(run => run.text).join(''), innerRuns: deleted, oldRuns: undefined, newRuns: undefined, newText: undefined });
    deleted = [];
  };
  const formatted = formatCriticInnerRuns(runs, outer) ?? [];
  for (let i = 0; i < formatted.length; i++) {
    const run = formatted[i];
    if (run.type === 'critic_comment' || isCommentMarkerRun(run)) {
      flush();
      pieces.push(run);
    } else if (run.type === 'critic_highlight' && (formatted[i + 1]?.type === 'critic_comment' || hasCommentRuns(run.innerRuns))) {
      flush();
      pieces.push({ ...run, innerRuns: deletionWithComments(run.innerRuns ?? [toTextRunFromInner(run)], run, deletion) });
    } else if (hasCommentRuns(run.innerRuns) || hasCommentRuns(run.oldRuns) || hasCommentRuns(run.newRuns)) {
      // A revision in a deletion is deleted with it, both sides of a substitution
      flush();
      for (const side of [run.innerRuns, run.oldRuns, run.newRuns]) pushAll(pieces, deletionWithComments(side, run, deletion));
    } else {
      // A break takes the formatting around it, as it would in `outer`, where
      // the deletion it goes in has only `deletion`'s
      deleted.push(isBreakRun(run) ? { ...mergeRunFormatting(run, outer), type: run.type } : run);
    }
  }
  flush();
  return pieces;
}

function generateDeletedCriticContent(
  runs: MdRun[] | undefined,
  fallbackText: string,
  outer: MdRun,
  forced: Partial<MdRun>,
  warnings: string[] | undefined,
  state: DocxGenState,
  options?: MdToDocxOptions,
): string {
  const formattedRuns = formatCriticInnerRuns(runs, outer, forced);
  if (!formattedRuns || formattedRuns.length === 0) {
    const fallbackRun = mergeRunFormatting({ type: 'text', text: fallbackText }, outer, forced);
    const rPr = generateRPr(fallbackRun, tableRunRPr(state, fallbackRun));
    return '<w:r>' + (rPr ? rPr : '') + delText(fallbackText) + '</w:r>';
  }

  let xml = '';
  // A link's runs, and its line breaks, go in one element, as generateRuns
  // writes a link, but for the next link to the same place, which starts
  // another; the element stays open while the link goes on
  let link: { href: string; rId: string; xml: string } | undefined;
  const close = () => {
    if (link) xml += '<' + DELETED_LINK + ' rId="' + link.rId + '">' + link.xml + '</' + DELETED_LINK + '>';
    link = undefined;
  };
  const emit = (runXml: string, run?: MdRun) => {
    if (!run?.href) {
      close();
      xml += runXml;
      return;
    }
    if (link?.href !== run.href || run.linkStart) {
      close();
      link = { href: run.href, rId: hyperlinkRelationshipId(run.href, state), xml: '' };
    }
    link.xml += runXml;
  };
  for (const run of formattedRuns) {
    if (run.type === 'softbreak') {
      const merged = mergeRunFormatting(run, outer, forced);
      const rPr = generateRPr(merged, tableRunRPr(state, merged));
      emit('<w:r>' + (rPr ? rPr : '') + delText(' ') + '</w:r>', run);
      continue;
    }
    if (run.type === 'hardbreak') {
      const rPr = generateRPr(run, tableRunRPr(state, run));
      emit('<w:r>' + (rPr ? rPr : '') + '<w:br/></w:r>', run);
      continue;
    }
    if (run.type === 'math') {
      // An inline equation in its link's element, as generateRuns writes it
      emit(generateMathXml(run.text, !!run.display, warnings), run.display ? undefined : run);
      continue;
    }
    if (run.type === 'critic_add' || run.type === 'critic_del') {
      emit(generateDeletedCriticContent(run.innerRuns, run.text, run, {}, warnings, state, options));
      continue;
    }
    if (run.type === 'critic_sub') {
      emit(generateDeletedCriticContent(run.oldRuns, run.text, run, {}, warnings, state, options));
      if (run.newText) emit(generateDeletedCriticContent(run.newRuns, run.newText, run, {}, warnings, state, options));
      continue;
    }
    if (run.type === 'critic_highlight' || run.type === 'critic_comment') {
      if (run.type === 'critic_highlight' && run.text) {
        emit(generateDeletedCriticContent(run.innerRuns, run.text, run, {}, warnings, state, options));
      }
      continue;
    }
    if (run.type === 'footnote_ref') {
      emit(noteReferenceXml(run.footnoteLabel || '', state, 'deletion', highlightRPr(run)), run);
      continue;
    }
    if (run.type === 'image') {
      emit(imageRunXml(run, state, options, true), run);
      continue;
    }
    if (run.type === 'citation') {
      // A live Zotero field inside <w:del> is unsafe (Word serializes deleted
      // field instructions as w:delInstrText, and Zotero may refresh deleted
      // fields), so deleted citations keep their literal source syntax.
      // As text, with the citation's formatting, which import writes
      // inside the deletion, as {--*[@key]*--}
      const literal = '[' + run.text + ']';
      const { bold, italic, underline, strikethrough, superscript, subscript, highlight, highlightColor } = run;
      const merged = mergeRunFormatting({ type: 'text', text: literal, bold, italic, underline, strikethrough, superscript, subscript, highlight, highlightColor }, outer, forced);
      const rPr = generateRPr(merged, tableRunRPr(state, merged));
      emit('<w:r>' + (rPr ? rPr : '') + delText(literal) + '</w:r>');
      continue;
    }
    if (run.type !== 'text' || !run.text) continue;
    const rPr = generateRPr(run, tableRunRPr(state, run));
    if (run.crossRef) emit(crossRefXml(run, state, rPr, true), run);
    else emit('<w:r>' + (rPr ? rPr : '') + (holdsRawHtmlLineEnd(run) ? rawHtmlTextElements(run, 'w:delText') : delText(run.text)) + '</w:r>', run);
  }
  close();
  return xml;
}

/** Inserted content from `generate`, with its note references marked as inserted. */
function insertedContent(state: DocxGenState, generate: () => string): string {
  const saved = state.noteRevision;
  state.noteRevision = 'addition';
  try {
    return generate();
  } finally {
    state.noteRevision = saved;
  }
}

// The number a reference again shows for a note until the note's number
// is known, where the document is written (see withNoteNumbers): the note's
// ID between NULs, which no XML holds, as BIBL_BREAK_PLACEHOLDER
const NOTE_NUMBER_MARK = '\x00MANUSCRIPT_NOTE_NUMBER_';
const noteNumberMark = (noteId: number) => NOTE_NUMBER_MARK + noteId + '\x00';

/** How Word numbers the document's notes, from the template's section
 *  properties, which each section has (see sectionBreakSectPrXml): its
 *  w:footnotePr, or w:endnotePr for endnotes, as Word reads it, their
 *  format, w:numFmt, start, w:numStart, and where they start again,
 *  w:numRestart (ECMA-376 Part 1 §17.11.11, §17.11.17 to §17.11.20). Word
 *  numbers endnotes in lowercase roman numerals where nothing says how,
 *  footnotes in decimal ([MS-OI29500] Part 1 Section 17.11.17), and notes
 *  in a bullet format in decimal. Export's settings say none of this. */
interface NoteNumbering { format: string; start: number; restart: string }
function noteNumberingOf(state: DocxGenState): NoteNumbering {
  const endnotes = state.notesMode === 'endnotes';
  const notePr = sectPrPropertyIn(state.templateSectPr, endnotes ? 'endnotePr' : 'footnotePr');
  const value = (local: string) => {
    const child = notePr && elementsIn(notePr.node, notePr.scope).find(child => isNamed(child.node, child.scope, WORDPROCESSINGML, local));
    return child && wAttributeOf(child, 'val');
  };
  const format = value('numFmt') ?? (endnotes ? 'lowerRoman' : 'decimal');
  // An integer as import reads one, with a sign too
  const start = xmlInteger(value('numStart')) ?? 1;
  return { format: format === 'bullet' ? 'decimal' : format, start, restart: value('numRestart') ?? 'continuous' };
}

/** A note's number, `n`, as a note number format shows it: in decimal,
 *  roman numerals, letters, which Word repeats past z, as aa, or the
 *  symbols of the Chicago Manual of Style, *, †, ‡ and §, which Word
 *  repeats past them, as **. Others, which notes seldom have, in decimal */
export function noteNumberText(n: number, format: string): string {
  if (n < 1) return String(n);
  if (format === 'lowerRoman' || format === 'upperRoman') {
    let roman = '', rest = n;
    for (const [value, numeral] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) {
      for (; rest >= value; rest -= value) roman += numeral;
    }
    return format === 'lowerRoman' ? roman.toLowerCase() : roman;
  }
  if (format === 'lowerLetter' || format === 'upperLetter') {
    const letter = String.fromCharCode((format === 'lowerLetter' ? 97 : 65) + (n - 1) % 26);
    return letter.repeat(Math.floor((n - 1) / 26) + 1);
  }
  if (format === 'chicago') return '*\u2020\u2021\u00A7'[(n - 1) % 4].repeat(Math.floor((n - 1) / 4) + 1);
  if (format === 'decimalZero') return n < 10 ? '0' + n : String(n);
  return String(n);
}

/** The number Word shows for each note a document's body references, by
 *  its ID: in the order of the references that own them, from the start,
 *  and from the start again in each section where the numbering restarts
 *  in each, or on each page, of which a section has at least one, since
 *  export can't know where its pages end. A section ends with the
 *  paragraph whose properties hold its sectPr */
function noteNumbersIn(bodyXml: string, numbering: NoteNumbering): Map<number, string> {
  const numbers = new Map<number, string>();
  let section = 0, ending = false, noteSection = 0, count = 0;
  for (const [tag, id] of bodyXml.matchAll(/<w:(?:footnote|endnote)Reference\b[^>]*?\sw:id="(\d+)"[^>]*>|<\/w:sectPr>\s*<\/w:pPr>|<\/w:p>/g)) {
    if (id !== undefined) {
      if (numbering.restart !== 'continuous' && section !== noteSection) count = 0;
      noteSection = section;
      if (!numbers.has(Number(id))) numbers.set(Number(id), noteNumberText(numbering.start + count++, numbering.format));
    } else if (tag.startsWith('</w:sectPr')) {
      ending = true;
    } else if (ending) {
      section++;
      ending = false;
    }
  }
  return numbers;
}

/** XML with the number each reference again to a note shows, in place of
 *  its mark (see noteNumberMark): the note's (see noteNumbersIn), or, for
 *  a note no reference in the body owns, as a note in a note, the one its
 *  ID would have */
function withNoteNumbers(xml: string, numbers: ReadonlyMap<number, string>, numbering: NoteNumbering): string {
  const [before, ...marked] = xml.split(NOTE_NUMBER_MARK);
  return before + marked.map(part => {
    const end = part.indexOf('\x00'), id = Number(part.slice(0, end));
    return (numbers.get(id) ?? noteNumberText(numbering.start + id - 1, numbering.format)) + part.slice(end + 1);
  }).join('');
}

/**
 * A reference to the note `label`, inside a tracked change of `revision` or
 * none. The reference that owns the note gets Word's note reference; any
 * other cross-references it with a NOTEREF field, whose instruction Word
 * keeps as w:delInstrText inside a deletion. A tracked reference owns its
 * note only when no untracked reference does, so accepting or rejecting the
 * change can't take the note from a reference that stays.
 */
function noteReferenceXml(label: string, state: DocxGenState, revision?: 'addition' | 'deletion', extraRPr = ''): string {
  let noteId = state.footnoteLabelToId.get(label);
  if (noteId === undefined) {
    noteId = state.footnoteId++;
    state.footnoteLabelToId.set(label, noteId);
  }
  const owned = state.ownedNoteLabels ??= new Set();
  const owns = !owned.has(label) && !(revision && state.untrackedNoteLabels?.has(label));
  if (state.notesMode === 'endnotes') state.hasEndnotes = true;
  else state.hasFootnotes = true;
  const noteExtraRPr = tableRunRPr(state) ?? '';
  const refStyleName = state.notesMode === 'endnotes' ? 'EndnoteReference' : 'FootnoteReference';
  const rPr = '<w:rPr>' + orderRPr('<w:rStyle w:val="' + refStyleName + '"/>' + extraRPr + noteExtraRPr) + '</w:rPr>';
  if (owns) {
    owned.add(label);
    (state.noteLandscape ??= new Map()).set(label, sectionIsLandscape(state));
    const tag = state.notesMode === 'endnotes' ? 'w:endnoteReference' : 'w:footnoteReference';
    return '<w:r>' + rPr + '<' + tag + ' w:id="' + noteId + '"/></w:r>';
  }
  // Cross-reference field pointing to the bookmark around the note's self-ref mark
  state.footnoteCrossRefLabels.add(label);
  const bkmkName = footnoteBookmarkName(noteId);
  const instrTag = revision === 'deletion' ? 'w:delInstrText' : 'w:instrText';
  return '<w:r>' + rPr + '<w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r>' + rPr + '<' + instrTag + ' xml:space="preserve"> NOTEREF ' + bkmkName + ' \\f \\h </' + instrTag + '></w:r>'
    + '<w:r>' + rPr + '<w:fldChar w:fldCharType="separate"/></w:r>'
    // The note's number, once it's known (see withNoteNumbers)
    + '<w:r>' + rPr + (revision === 'deletion' ? delText(noteNumberMark(noteId)) : '<w:t>' + noteNumberMark(noteId) + '</w:t>') + '</w:r>'
    + '<w:r>' + rPr + '<w:fldChar w:fldCharType="end"/></w:r>';
}

/** A caption a cross-reference goes to: its bookmark's name, and what it
 *  shows of its title and number, as `Figure 1` (see captionXml) */
interface CaptionTarget { bookmark: string; text: string }

/** A cross-reference written, as crossRefXml wrote it: its key, its
 *  Markdown, its runs' properties, and whether it's deleted */
interface CrossRef { key: string; text: string; rPr: string; deleted: boolean }

// A cross-reference's field until the captions are known, once the
// document is written (see withCrossRefs): its index after this, between
// NULs, which no XML holds, as noteNumberMark, then the field as it would
// be, but for its result, which is its Markdown, then CROSS_REF_END
const CROSS_REF_MARK = '\x00MANUSCRIPT_CROSS_REF_';
const CROSS_REF_END = '\x00MANUSCRIPT_CROSS_REF_END\x00';
// eslint-disable-next-line no-control-regex
const CROSS_REF_RE = /\x00MANUSCRIPT_CROSS_REF_(\d+)\x00[\s\S]*?\x00MANUSCRIPT_CROSS_REF_END\x00/g;

/** A REF field to the bookmark `bookmark`, of instruction switches
 *  `switches`, showing `shown`, each run of properties `rPr`, deleted
 *  (`deleted`) or not, whose instruction Word keeps as w:delInstrText
 *  inside a deletion */
function refFieldXml(bookmark: string, switches: string, shown: string, rPr: string, deleted: boolean): string {
  const instrTag = deleted ? 'w:delInstrText' : 'w:instrText';
  return '<w:r>' + rPr + '<w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r>' + rPr + '<' + instrTag + ' xml:space="preserve"> REF ' + bookmark + switches + ' </' + instrTag + '></w:r>'
    + '<w:r>' + rPr + '<w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r>' + rPr + (deleted ? delText(shown) : wt(shown)) + '</w:r>'
    + '<w:r>' + rPr + '<w:fldChar w:fldCharType="end"/></w:r>';
}

/**
 * A cross-reference, `run`, of runs of properties `rPr`, deleted or not
 * (`deleted`): a REF field to its figure's or table's caption's bookmark,
 * showing its title and number, as `Figure 1`, as Word's Cross-reference
 * dialog writes one of "Only label and number", in a hyperlink to it
 * (\h), its first letter a capital (\* FirstCap) for `@Fig-` or `@Tbl-`.
 * Which caption that is, the document's first of the label, is known once
 * the document is written, so this writes a mark of the field for
 * withCrossRefs to write it in place of; one with no caption is its
 * Markdown, as text. A citation's brackets with one in them are text.
 */
function crossRefXml(run: MdRun, state: DocxGenState, rPr: string, deleted = false): string {
  if (run.crossRef!.form === 'literal') {
    const warning = 'The citation [' + run.text.slice(1, -1) + '] has a cross-reference in it, which Word gets as text: a cross-reference is @fig-label or [@fig-label] alone, of a figure, or @tbl-label of a table.';
    if (!state.warnings.includes(warning)) state.warnings.push(warning);
    return '<w:r>' + rPr + (deleted ? delText(run.text) : wt(run.text)) + '</w:r>';
  }
  const index = (state.crossRefs ??= []).push({ key: run.crossRef!.key, text: run.text, rPr, deleted }) - 1;
  return CROSS_REF_MARK + index + '\x00' + refFieldXml('', '', run.text, rPr, deleted) + CROSS_REF_END;
}

/** XML with each cross-reference's field, or its Markdown, in place of
 *  the mark crossRefXml wrote, once the captions are known */
function withCrossRefs(xml: string, state: DocxGenState): string {
  if (!xml.includes(CROSS_REF_MARK)) return xml;
  return xml.replace(CROSS_REF_RE, (_mark, index: string) => {
    const { key, text, rPr, deleted } = state.crossRefs![Number(index)];
    const target = state.captionTargets?.get(crossRefLabel(key));
    if (!target) return '<w:r>' + rPr + (deleted ? delText(text) : wt(text)) + '</w:r>';
    const capital = crossRefLabel(key) !== key;
    const shown = capital ? target.text.charAt(0).toUpperCase() + target.text.slice(1) : target.text;
    return refFieldXml(target.bookmark, ' \\h' + (capital ? ' \\* FirstCap' : ''), shown, rPr, deleted);
  });
}

/** The fingerprint of a quote's paragraph `xml`, past the alert's label
 *  `label` it starts with, if any (see QuoteGroupIdentity) */
function quoteStart(xml: string, label: string): string {
  const text = wordText(xml);
  return paragraphStartFingerprint(label && text.startsWith(label) ? text.slice(label.length) : text);
}

/** Each quote's start where a paragraph before the one it was taken from
 *  has a cross-reference, whose field `final` writes: the first of them
 *  with text then, as one with no caption shows its Markdown, or else the
 *  one it was taken from. A paragraph with text before stays so. */
function settleQuoteStarts(state: DocxGenState, final: (xml: string) => string): void {
  for (const identity of state.blockquoteIdentities.values()) {
    for (const { xml, label } of identity.startsPending ?? []) {
      const start = quoteStart(final(xml), label);
      if (start === blankParagraphStart) {
        identity.start ??= start;
        continue;
      }
      identity.start = start;
      break;
    }
    delete identity.startsPending;
  }
}

/** The warnings of the cross-references written: one for each label no
 *  caption has, and one for each that more than one has */
function crossRefWarnings(state: DocxGenState): void {
  const warned = new Set<string>();
  for (const { key } of state.crossRefs ?? []) {
    const label = crossRefLabel(key);
    if (warned.has(label)) continue;
    warned.add(label);
    if (!state.captionTargets?.has(label)) state.warnings.push('Cross-reference @' + key + ' has no figure or table labeled {#' + label + '}, so Word gets it as text.');
    else if (state.labelsCaptioned?.has(label)) state.warnings.push('More than one figure or table is labeled {#' + label + '}; its cross-references go to the first.');
  }
}

/** The ID of the relationship to `href`, in the notes' part in a note */
function hyperlinkRelationshipId(href: string, state: DocxGenState): string {
  if (state.inNoteBody) {
    let rId = state.noteRelationships.get(href);
    if (!rId) {
      rId = 'rId' + state.noteNextRId;
      state.noteRelationships.set(href, rId);
      state.noteNextRId++;
    }
    return rId;
  }
  let rId = state.relationships.get(href);
  if (!rId) {
    rId = 'rId' + (state.nextRId + state.rIdOffset);
    state.relationships.set(href, rId);
    state.nextRId++;
  }
  return rId;
}

/** A deleted link's runs in generateDeletedCriticContent's XML, in an
 *  element of this name for deletionXml to take out, which no text can
 *  look like, as its escaped XML has no < */
const DELETED_LINK = 'manuscriptDeletedLink';
const DELETED_LINK_RE = new RegExp('<' + DELETED_LINK + ' rId="([^"]*)">([\\s\\S]*?)</' + DELETED_LINK + '>', 'g');

/** A hyperlink generateRuns writes, which holds no other */
const HYPERLINK_RE = /<w:hyperlink r:id="([^"]*)">([\s\S]*?)<\/w:hyperlink>/g;

/** A tracked change, `tag`, around `contentXml`, whose links, as `links`
 *  finds them, each go in a hyperlink around a change of their own, as Word
 *  writes a link in a change, since a w:ins or w:del holds only runs. */
function trackedChangeXml(tag: 'w:ins' | 'w:del', contentXml: string, links: RegExp, author: string, dateAttr: string, state: DocxGenState): string {
  const change = (content: string) => '<' + tag + ' w:id="' + (state.commentId++) + '" w:author="' + escapeXmlAttribute(author) + '"' + dateAttr + '>' + content + '</' + tag + '>';
  let xml = '';
  let last = 0;
  for (const link of contentXml.matchAll(links)) {
    if (link.index > last) xml += change(contentXml.slice(last, link.index));
    xml += '<w:hyperlink r:id="' + link[1] + '">' + change(link[2]) + '</w:hyperlink>';
    last = link.index + link[0].length;
  }
  return last === 0 || last < contentXml.length ? xml + change(contentXml.slice(last)) : xml;
}

/** Deleted content, from generateDeletedCriticContent, in w:del */
function deletionXml(deletedXml: string, author: string, dateAttr: string, state: DocxGenState): string {
  return trackedChangeXml('w:del', deletedXml, DELETED_LINK_RE, author, dateAttr, state);
}

/** Inserted content, from generateRuns, in w:ins */
function insertionXml(insertedXml: string, author: string, dateAttr: string, state: DocxGenState): string {
  return trackedChangeXml('w:ins', insertedXml, HYPERLINK_RE, author, dateAttr, state);
}

/** The runs a link's hyperlink holds: its text, line breaks, images, note references and tracked changes */
const LINK_RUN_TYPES = new Set<MdRun['type']>(['text', 'softbreak', 'hardbreak', 'image', 'critic_add', 'critic_del', 'critic_sub', 'footnote_ref']);

/** Whether a link's hyperlink holds the run: one of LINK_RUN_TYPES, or an
 *  inline equation, which import reads back in the link's text. Not display
 *  math, which import writes on lines of its own, out of the link. */
function inHyperlink(run: MdRun): boolean {
  return LINK_RUN_TYPES.has(run.type) || run.type === 'math' && !run.display;
}

/** Whether a run's tracked change holds a link to somewhere other than `href` */
function holdsOtherLink(run: MdRun, href: string): boolean {
  return [run.innerRuns, run.oldRuns, run.newRuns].some(runs =>
    runs?.some(inner => inner.href !== undefined && inner.href !== href || holdsOtherLink(inner, href)));
}

export function generateRuns(inputRuns: MdRun[], state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: CiteprocEngine): string {
  let xml = '';
  for (let ri = 0; ri < inputRuns.length; ri++) {
    const run = inputRuns[ri];
    const nextRun = inputRuns[ri + 1];
    if (run.href && inHyperlink(run) && !holdsOtherLink(run, run.href)) {
      // The link's runs, with its line breaks and tracked changes, go in one
      // hyperlink, as Word writes one, which import reads back as one link;
      // the next link to the same place starts another. Inside it, no run,
      // nor one in a tracked change, is a link of its own. A tracked change
      // that holds a link to another place ends it, and goes as it would
      // outside a link, which keeps that link.
      let end = ri + 1;
      while (end < inputRuns.length && inputRuns[end].href === run.href && !inputRuns[end].linkStart && inHyperlink(inputRuns[end])
        && !holdsOtherLink(inputRuns[end], run.href)) end++;
      const withoutLink = (linkRun: MdRun): MdRun => ({
        ...linkRun, href: undefined,
        ...(linkRun.type === 'image' ? { linkRId: hyperlinkRelationshipId(run.href!, state) } : {}),
        ...(linkRun.innerRuns ? { innerRuns: linkRun.innerRuns.map(withoutLink) } : {}),
        ...(linkRun.oldRuns ? { oldRuns: linkRun.oldRuns.map(withoutLink) } : {}),
        ...(linkRun.newRuns ? { newRuns: linkRun.newRuns.map(withoutLink) } : {}),
      });
      const inner = generateRuns(inputRuns.slice(ri, end).map(withoutLink), state, options, bibEntries, citeprocEngine);
      xml += '<w:hyperlink r:id="' + hyperlinkRelationshipId(run.href, state) + '">' + inner + '</w:hyperlink>';
      ri = end - 1;
    } else if (run.type === 'text' && holdsRawHtmlLineEnd(run)) {
      xml += '<w:r>' + generateRPr(run, tableRunRPr(state, run)) + rawHtmlTextElements(run, 'w:t') + '</w:r>';
    } else if (run.type === 'text' && run.crossRef) {
      xml += crossRefXml(run, state, generateRPr(run, tableRunRPr(state, run)));
    } else if (run.type === 'text') {
      const rPr = generateRPr(run, tableRunRPr(state, run));
      xml += generateRun(run.text, rPr);
    } else if (run.type === 'softbreak') {
      const rPr = generateRPr(run, tableRunRPr(state, run));
      xml += '<w:r>' + (rPr ? rPr : '') + '<w:t xml:space="preserve"> </w:t></w:r>';
    } else if (run.type === 'hardbreak') {
      const rPr = generateRPr(run, tableRunRPr(state, run));
      xml += '<w:r>' + (rPr ? rPr : '') + '<w:br/></w:r>';
    } else if (run.type === 'critic_add') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const dateAttr = date ? ' w:date="' + escapeXmlAttribute(date) + '"' : '';
      const contentXml = insertedContent(state, () => generateInlineCriticContent(run.innerRuns, run.text, run, state, options, bibEntries, citeprocEngine));
      xml += insertionXml(contentXml, author, dateAttr, state);
    } else if (run.type === 'critic_del' && hasCommentRuns(run.innerRuns)) {
      xml += generateRuns(deletionWithComments(run.innerRuns, run, run), state, options, bibEntries, citeprocEngine);
    } else if (run.type === 'critic_del') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const dateAttr = date ? ' w:date="' + escapeXmlAttribute(date) + '"' : '';
      const deletedXml = generateDeletedCriticContent(run.innerRuns, run.text, run, {}, state.warnings, state, options);
      xml += deletionXml(deletedXml, author, dateAttr, state);
    } else if (run.type === 'critic_sub' && hasCommentRuns(run.oldRuns)) {
      const deletion: MdRun = { ...run, type: 'critic_del', innerRuns: run.oldRuns, oldRuns: undefined, newRuns: undefined, newText: undefined };
      const addition: MdRun = { ...run, type: 'critic_add', text: run.newText || '', innerRuns: run.newRuns, oldRuns: undefined, newRuns: undefined, newText: undefined };
      xml += generateRuns([deletion, addition], state, options, bibEntries, citeprocEngine);
    } else if (run.type === 'critic_sub') {
      const author = run.author || options?.authorName || 'Unknown';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const dateAttr = date ? ' w:date="' + escapeXmlAttribute(date) + '"' : '';
      const deletedXml = generateDeletedCriticContent(run.oldRuns, run.text, run, {}, state.warnings, state, options);
      const insertedXml = insertedContent(state, () => generateInlineCriticContent(run.newRuns, run.newText || '', run, state, options, bibEntries, citeprocEngine));
      xml += deletionXml(deletedXml, author, dateAttr, state);
      xml += insertionXml(insertedXml, author, dateAttr, state);
    } else if (run.type === 'critic_highlight') {
      if (nextRun?.type === 'critic_comment') {
        const reserved = run.reservedCommentId;
        const commentId = reserved !== undefined && !hasCommentWithId(state.comments, reserved) ? reserved : state.commentId++;
        const author = nextRun.author ?? '';
        const date = normalizeToUtcIso(nextRun.date || '', state.timezone);
        const commentBody = nextRun.commentText || '';
        const parentParaId = generateParaId(state);
        state.comments.push({ id: commentId, author, date, text: commentBody, paraId: parentParaId });
        state.hasComments = true;
        // Store allocated reply IDs so anchor generation uses exact IDs
        // (not commentId+1 which could drift if generateInlineCriticContent
        // allocates intervening IDs for track-change revisions).
        const nestedReplyIds: number[] = [];
        if (nextRun.replies && nextRun.replies.length > 0) {
          for (const reply of nextRun.replies) {
            const replyId = state.commentId++;
            nestedReplyIds.push(replyId);
            const replyParaId = generateParaId(state);
            const replyAuthor = reply.author ?? '';
            const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
            state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId, parentParaId });
          }
        }
        // Collect consecutive-reply IDs before emitting XML so all
        // rangeStarts can be grouped together (overlapping the parent range).
        ri++;
        const consecutiveReplyIds: number[] = [];
        let absorbedConsecutiveReply = false;
        while (ri + 1 < inputRuns.length && inputRuns[ri + 1].type === 'critic_comment') {
          const replyRun = inputRuns[ri + 1];
          const replyId = state.commentId++;
          consecutiveReplyIds.push(replyId);
          const replyParaId = generateParaId(state);
          const replyAuthor = replyRun.author ?? '';
          const replyDate = normalizeToUtcIso(replyRun.date || '', state.timezone);
          state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: replyRun.commentText || '', paraId: replyParaId, parentParaId });
          // Preserve reply-on-reply blocks for consecutive replies instead of
          // dropping them; these are emitted as child comments of this reply.
          if (replyRun.replies && replyRun.replies.length > 0) {
            for (const nestedReply of replyRun.replies) {
              const nestedReplyId = state.commentId++;
              consecutiveReplyIds.push(nestedReplyId);
              const nestedReplyParaId = generateParaId(state);
              const nestedReplyAuthor = nestedReply.author ?? '';
              const nestedReplyDate = normalizeToUtcIso(nestedReply.date || '', state.timezone);
              state.comments.push({
                id: nestedReplyId,
                author: nestedReplyAuthor,
                date: nestedReplyDate,
                text: nestedReply.text,
                paraId: nestedReplyParaId,
                parentParaId: replyParaId
              });
            }
          }
          absorbedConsecutiveReply = true;
          ri++;
        }
        if (absorbedConsecutiveReply) {
          state.consecutiveReplyParaIds.add(parentParaId);
        }
        const allReplyIds = [...nestedReplyIds, ...consecutiveReplyIds];
        // Word requires reply ranges to overlap with the parent range for
        // proper threading display — open all ranges together, then close
        // parent first followed by replies (matching real Word output).
        xml += '<w:commentRangeStart w:id=\"' + commentId + '\"/>';
        for (const rid of allReplyIds) {
          xml += '<w:commentRangeStart w:id=\"' + rid + '\"/>';
        }
        xml += generateInlineCriticContent(
          run.innerRuns,
          run.text,
          run,
          state,
          options,
          bibEntries,
          citeprocEngine,
          run.highlight ? { highlight: true, highlightColor: run.highlightColor } : {}
        );
        xml += '<w:commentRangeEnd w:id=\"' + commentId + '\"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + commentId + '\"/></w:r>';
        for (const rid of allReplyIds) {
          xml += '<w:commentRangeEnd w:id=\"' + rid + '\"/>';
          xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + rid + '\"/></w:r>';
        }
      } else {
        xml += generateInlineCriticContent(
          run.innerRuns,
          run.text,
          run,
          state,
          options,
          bibEntries,
          citeprocEngine,
          { highlight: true, highlightColor: run.highlightColor }
        );
      }
    } else if (run.type === 'critic_comment') {
      const commentId = state.commentId++;
      const author = run.author ?? '';
      const date = normalizeToUtcIso(run.date || '', state.timezone);
      const commentBody = run.commentText || '';
      const parentParaId = generateParaId(state);

      state.comments.push({ id: commentId, author, date, text: commentBody, paraId: parentParaId });
      state.hasComments = true;

      // Generate reply entries — store allocated IDs for anchor generation
      const standaloneReplyIds: number[] = [];
      if (run.replies && run.replies.length > 0) {
        for (const reply of run.replies) {
          const replyId = state.commentId++;
          standaloneReplyIds.push(replyId);
          const replyParaId = generateParaId(state);
          const replyAuthor = reply.author ?? '';
          const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
          state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId, parentParaId });
        }
      }

      // Open all ranges together so replies overlap with the parent range
      xml += '<w:commentRangeStart w:id=\"' + commentId + '\"/>';
      for (const rid of standaloneReplyIds) {
        xml += '<w:commentRangeStart w:id=\"' + rid + '\"/>';
      }
      if (run.text) {
        xml += generateInlineCriticContent(
          run.innerRuns,
          run.text,
          run,
          state,
          options,
          bibEntries,
          citeprocEngine,
          run.highlight ? { highlight: true, highlightColor: run.highlightColor } : {}
        );
      }
      xml += '<w:commentRangeEnd w:id=\"' + commentId + '\"/>';
      xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + commentId + '\"/></w:r>';
      for (const rid of standaloneReplyIds) {
        xml += '<w:commentRangeEnd w:id=\"' + rid + '\"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + rid + '\"/></w:r>';
      }
    } else if (run.type === 'footnote_ref') {
      xml += noteReferenceXml(run.footnoteLabel || '', state, state.noteRevision, highlightRPr(run));
    } else if (run.type === 'citation') {
      const result = generateCitation(run, bibEntries || new Map(), citeprocEngine, state.citationIds, state.citationItemIds,
        orderRPr(highlightRPr(run) + (tableRunRPr(state, run) ?? '')) || undefined, generateRPr(run, tableRunRPr(state, run)));
      xml += result.xml;
      if (result.warning) state.warnings.push(result.warning);
      if (result.missingKeys) {
        for (const k of result.missingKeys) state.missingKeys.add(k);
      }
      if (run.keys && bibEntries) {
        for (const k of run.keys) {
          if (bibEntries.has(k)) state.citedKeys.add(k);
        }
      }
    } else if (run.type === 'math') {
      const math = run.mathParts
        ? generateTrackedMathXml(run.mathParts, revisionWrapper(run, state, options), state.warnings, !!run.display)
        : generateMathXml(run.text, !!run.display, state.warnings);
      // Not inline math with a tracked change in it, or in one, whose
      // highlight import doesn't read (see mathHighlight in converter.ts)
      xml += (run.display || (!run.mathParts && !state.noteRevision)) && run.highlight ? mathWithHighlight(math, highlightRPr(run)) : math;
    } else if ((run.type === 'comment_range_start' || run.type === 'comment_range_end') && run.innerRangeMarker) {
      continue;
    } else if (run.type === 'comment_range_start') {
      const mdId = run.commentId || '';
      let numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        numericId = state.commentId++;
        state.commentIdMap.set(mdId, numericId);
      }
      // Its ID has its number, which the warning of a range with no body
      // reads, but Word gets nothing of it
      if (run.unwrittenRangeMarker) continue;
      xml += '<w:commentRangeStart w:id="' + numericId + '"/>';
      const replyRanges = replyRangesOf(state.replyRanges, numericId);
      for (const reply of replyRanges) {
        xml += '<w:commentRangeStart w:id=\"' + reply.replyId + '\"/>';
      }
      state.hasComments = true;
    } else if (run.type === 'comment_range_end') {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId === undefined) {
        state.warnings.push(`Unmatched comment range end marker: {/${mdId}}`);
        continue;
      }
      if (run.unwrittenRangeMarker) continue;
      xml += '<w:commentRangeEnd w:id="' + numericId + '"/>';
      xml += '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + numericId + '"/></w:r>';
      const replyRanges = replyRangesOf(state.replyRanges, numericId);
      for (const reply of replyRanges) {
        xml += '<w:commentRangeEnd w:id=\"' + reply.replyId + '\"/>';
        xml += '<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"' + reply.replyId + '\"/></w:r>';
      }
    } else if (run.type === 'comment_body_with_id') {
      if (state.commentIdMap.get(run.commentId || '') === undefined && state.deferredCommentBodies) state.deferredCommentBodies.push(run);
      else addIdCommentBody(run, state);
    } else if (run.type === 'html_comment') {
      xml += generateHiddenHtmlCommentRun(run.text);
    } else if (run.type === 'image') {
      xml += imageRunXml(run, state, options);
    }
  }
  return xml;
}

/** The comment a body by ID writes, `{#id>>...<<}`, with its replies, once
 *  for its ID, where a range of its ID has one, or else a warning. A body
 *  whose range is in a note, which the body is written before, waits for
 *  the notes' ranges (see deferredCommentBodies). */
function addIdCommentBody(run: MdRun, state: DocxGenState): void {
  const mdId = run.commentId || '';
  const numericId = state.commentIdMap.get(mdId);
  if (numericId === undefined) {
    state.warnings.push(`Comment body {#${mdId}>>...<<} has no matching range markers {#${mdId}}...{/${mdId}}`);
    return;
  }
  // Only emit the comment entry once per ID (multi-paragraph comments
  // may produce duplicate body markers in the markdown).
  if (!hasCommentWithId(state.comments, numericId)) {
    const author = run.author ?? '';
    const date = normalizeToUtcIso(run.date || '', state.timezone);
    const commentBody = run.commentText || '';
    const parentParaId = generateParaId(state);
    state.comments.push({ id: numericId, author, date, text: commentBody, paraId: parentParaId });
    if (run.consecutiveReplies) state.consecutiveReplyParaIds.add(parentParaId);

    // Generate reply comment entries (reply IDs may have been
    // pre-allocated by the pre-scan in generateDocumentXml)
    if (run.replies && run.replies.length > 0) {
      const preAllocated = replyRangesOf(state.replyRanges, numericId);
      const replyParaIds: string[] = [];
      for (let i = 0; i < run.replies.length; i++) {
        const reply = run.replies[i];
        const replyId = i < preAllocated.length ? preAllocated[i].replyId : state.commentId++;
        const replyParaId = generateParaId(state);
        replyParaIds.push(replyParaId);
        const replyAuthor = reply.author ?? '';
        const replyDate = normalizeToUtcIso(reply.date || '', state.timezone);
        state.comments.push({ id: replyId, author: replyAuthor, date: replyDate, text: reply.text, paraId: replyParaId,
          parentParaId: reply.parentReply !== undefined ? replyParaIds[reply.parentReply] : parentParaId });
        if (i >= preAllocated.length) {
          state.replyRanges.push({ replyId, parentId: numericId });
        }
      }
    }
  }
  state.hasComments = true;
}

/** `xml` without the range markers and reference runs of the comments of
 *  `ids`, as generateRuns writes them. A reference to no comment makes the
 *  document invalid, and a range marker with none is one no comment ends
 *  or starts. A range whose ID has no body writes none (see
 *  prescanCommentIds), but one whose body isn't written, as in a note no
 *  reference makes, would */
function withoutCommentMarkers(xml: string, ids: ReadonlySet<number>): string {
  if (ids.size === 0) return xml;
  return xml.replace(/<w:commentRange(?:Start|End) w:id="(\d+)"\/>|<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="(\d+)"\/><\/w:r>/g,
    (marker: string, rangeId: string | undefined, referenceId: string | undefined) => ids.has(Number(rangeId ?? referenceId)) ? '' : marker);
}

/** An image's run: its drawing, or if export can't embed the image, its
 *  Markdown hidden in the text, deleted text in a deletion */
function imageRunXml(run: MdRun, state: DocxGenState, options: MdToDocxOptions | undefined, deleted = false): string {
  const label = run.figure?.attributes.label;
  if (label && !state.captionedImages.has(run) && !state.uncaptionedLabels.has(label)) {
    state.uncaptionedLabels.add(label);
    state.warnings.push('The image labeled {#' + label + '} is no figure, so Word gets no caption for it: a figure is an image alone in its paragraph, not in a list, a quote, a table, a note, a link, a style block or a tracked change.');
  }
  const src = run.imageSrc || '';
  const alt = run.imageAlt || '';
  const syntax = run.imageSyntax || 'md';
  // Detect unsupported URL/data URI sources
  if (/^(https?:|data:)/i.test(src)) {
    state.warnings.push('Image "' + src.slice(0, 80) + '" is a URL or data URI; only local file paths are supported');
    return generateUnembeddedImageRun(run, deleted);
  }
  const srcBase = src.split('?')[0].split('#')[0];
  const ext = srcBase.split('.').pop()?.toLowerCase() || '';
  if (!isSupportedImageFormat(ext)) {
    state.warnings.push(IMAGE_WARNINGS.unsupportedFormat(ext, src));
    return generateUnembeddedImageRun(run, deleted);
  }
  // Resolve file path
  const absPath = options?.sourceDir ? resolve(options.sourceDir, src) : resolve(src);
  // Check deduplication: same file + same syntax reuses the same rId
  const dedupeKey = absPath + '\0' + syntax;
  const imgRelMap = state.inNoteBody ? state.noteImageRelationships : state.imageRelationships;
  let imgEntry = imgRelMap.get(dedupeKey);
  if (!imgEntry) {
    // Check if media binary already loaded (different syntax, same file)
    let mediaPath = state.imageMediaPaths.get(absPath);
    if (!mediaPath) {
      // Read file
      let fileData: Uint8Array;
      try {
        fileData = new Uint8Array(readFileSync(absPath));
      } catch (err: unknown) {
        const errorCode = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        const candidateMessage = err && typeof err === 'object' && 'message' in err ? err.message : undefined;
        const errorMessage = typeof candidateMessage === 'string' && candidateMessage ? candidateMessage : String(err);
        if (errorCode === 'ENOENT') {
          state.warnings.push(IMAGE_WARNINGS.notFound(src));
        } else {
          state.warnings.push(IMAGE_WARNINGS.readError(src, errorMessage));
        }
        return generateUnembeddedImageRun(run, deleted);
      }
      const mediaFilename = 'image' + state.imageMediaPaths.size + '.' + ext;
      mediaPath = 'media/' + mediaFilename;
      state.imageMediaPaths.set(absPath, mediaPath);
      state.imageBinaries.set(mediaPath, fileData);
      state.imageExtensions.add(ext);
    }
    let rId: string;
    if (state.inNoteBody) {
      rId = 'rId' + state.noteNextRId;
      state.noteNextRId++;
    } else {
      rId = 'rId' + (state.nextRId + state.rIdOffset);
      state.nextRId++;
    }
    imgEntry = { rId, mediaPath };
    imgRelMap.set(dedupeKey, imgEntry);
    // A note's rId is its part's, footnotes' or endnotes', which another
    // part, as Word can add, numbers the same
    if (state.inNoteBody) state.noteImageFormats.set((state.notesMode === 'endnotes' ? 'endnotes' : 'footnotes') + ':' + rId, syntax);
    else state.imageFormats.set(rId, syntax);
  }
  // Determine dimensions
  let width = run.imageWidth;
  let height = run.imageHeight;
  if (!width || !height) {
    const data = state.imageBinaries.get(imgEntry.mediaPath);
    if (data) {
      const intrinsic = readImageDimensions(data, ext);
      if (intrinsic) {
        const dims = computeMissingDimension({ width, height }, intrinsic);
        width = dims.width;
        height = dims.height;
      } else {
        if (!width) width = 100;
        if (!height) height = 100;
        state.warnings.push(IMAGE_WARNINGS.defaultDimensions(src));
      }
    } else {
      if (!width) width = 100;
      if (!height) height = 100;
    }
  }
  // Word does not automatically constrain an inline drawing to the page.
  // Downscale oversized images to the current section's writable width while
  // preserving their aspect ratio; never enlarge smaller authored images.
  const maxWidth = pageContentWidthPx(state);
  if (width > maxWidth) {
    const scale = maxWidth / width;
    width = maxWidth;
    height *= scale;
  }
  const cx = pixelsToEmu(width);
  const cy = pixelsToEmu(height);
  const docPrId = state.nextImageDocPrId++;
  // A linked picture clicks to its link, which the hyperlink around its run
  // holds too, as Word writes one
  const linkRId = run.linkRId ?? (run.href ? hyperlinkRelationshipId(run.href, state) : undefined);
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + '<wp:extent cx="' + cx + '" cy="' + cy + '"/>'
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + '<wp:docPr id="' + docPrId + '" name="' + escapeXmlAttribute(src) + '" descr="' + escapeXmlAttribute(alt) + '"'
    + (linkRId ? '><a:hlinkClick xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:id="' + linkRId + '"/></wp:docPr>' : '/>')
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:nvPicPr><pic:cNvPr id="' + docPrId + '" name="' + escapeXmlAttribute(src) + '"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="' + imgEntry.rId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic>'
    + '</wp:inline></w:drawing></w:r>';
}

/** Wraps content in a w:ins or w:del attributed the way generateRuns attributes the run's revisions. */
function revisionWrapper(run: MdRun, state: DocxGenState, options?: MdToDocxOptions): (element: 'w:ins' | 'w:del', content: string) => string {
  const author = run.author || options?.authorName || 'Unknown';
  const date = normalizeToUtcIso(run.date || '', state.timezone);
  const dateAttr = date ? ' w:date="' + escapeXmlAttribute(date) + '"' : '';
  return (element, content) => '<' + element + ' w:id="' + (state.commentId++) + '" w:author="' + escapeXmlAttribute(author) + '"' + dateAttr + '>' + content + '</' + element + '>';
}

/** The w:ins or w:del that tracks a block's paragraph mark (see criticParaMark), or ''. */
function paragraphMarkRevision(token: MdToken, state: DocxGenState, options?: MdToDocxOptions): string {
  if (!token.criticParaMark) return '';
  const run = token.criticParaMarkRun ?? token.runs[0];
  const author = run?.author || options?.authorName || 'Unknown';
  const date = normalizeToUtcIso(run?.date || '', state.timezone);
  const dateAttr = date ? ' w:date="' + escapeXmlAttribute(date) + '"' : '';
  const el = token.criticParaMark === 'addition' ? 'w:ins' : 'w:del';
  return '<' + el + ' w:id="' + (state.commentId++) + '" w:author="' + escapeXmlAttribute(author) + '"' + dateAttr + '/>';
}

/** Add a paragraph-mark revision to a pPr. Revision elements come first in a
 *  paragraph mark's rPr, and rPr comes last in every pPr this file writes.
 *  With replacers, as a replacement string reads a $&, $` or $' in the
 *  revision's author, or one its escaping makes, as A$<B's A$&lt;B, as what
 *  it matched or the text around it. */
function withParagraphMarkRevision(pPr: string, revision: string): string {
  if (!revision) return pPr;
  if (pPr.includes('<w:rPr>')) return pPr.replace('<w:rPr>', () => '<w:rPr>' + revision);
  if (pPr) return pPr.replace('</w:pPr>', () => '<w:rPr>' + revision + '</w:rPr></w:pPr>');
  return '<w:pPr><w:rPr>' + revision + '</w:rPr></w:pPr>';
}

/**
 * What Word shows of a table row's cells as export writes them (`xml`),
 * each part by the tracked change it's in, the innermost where one is in
 * another, as a deletion in an insertion: its kind, `ins` or `del`, or ''
 * for none, and the change's attributes. A part is text but whitespace, a
 * deletion's too, a symbol, the rest of a run's content that shows
 * something, as a drawing, a non-breaking hyphen or a note's reference,
 * but not a tab or a line break, which show no more than spaces, a
 * comment's reference or a field's instruction (see runContentShows in
 * converter), an equation's text but whitespace, and a character an
 * equation's structure draws: a fraction's bar, a radical, a bar, a box,
 * an accent's, an operator's or a group's character, or a delimiter, but
 * not an empty one, as `\left.\right.`'s. Not a hidden run's text, as of
 * an image export can't embed, which it hides in the text, nor what a
 * phantom Word hides holds, as `\phantom{x}`'s, nor a paragraph mark's
 * change or a comment's range.
 */
function shownChanges(xml: string): { kind: string; attrs: string }[] {
  const shown: { kind: string; attrs: string }[] = [];
  const open: string[] = [];
  const changes: { kind: string; attrs: string }[] = [];
  const runs: { hidden: boolean }[] = [];
  // Whether each phantom open is one Word hides, as its m:show says
  const phantoms: boolean[] = [];
  // Equations' structures whose characters are in their properties
  const structures: { tag: string; change: { kind: string; attrs: string }; chars: Map<string, string> }[] = [];
  const none = { kind: '', attrs: '' };
  const show = () => { if (!runs[runs.length - 1]?.hidden && !phantoms.includes(true)) shown.push(changes[changes.length - 1] ?? none); };
  const val = (attrs: string) => /\s[wm]:val="([^"]*)"/.exec(attrs)?.[1];
  for (const match of xml.matchAll(/<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, closing, tag, attrs, selfClosing, text] = match;
    if (text !== undefined) {
      const parent = open[open.length - 1];
      if ((parent === 'w:t' || parent === 'w:delText' || parent === 'm:t') && /\S/.test(text)) show();
      continue;
    }
    if (closing) {
      open.pop();
      if (tag === 'w:ins' || tag === 'w:del') changes.pop();
      else if (tag === 'w:r' || tag === 'm:r') runs.pop();
      else if (tag === 'm:phant') phantoms.pop();
      else if (structures[structures.length - 1]?.tag === tag) {
        const { change, chars } = structures.pop()!;
        const draws = tag === 'm:f' ? chars.get('m:type') !== 'noBar'
          : tag === 'm:d' ? (chars.get('m:begChr') ?? '(') !== '' || (chars.get('m:endChr') ?? ')') !== ''
            : chars.get('m:chr') !== '';
        if (draws && !phantoms.includes(true)) shown.push(change);
      }
      continue;
    }
    if (tag === 'w:vanish' && open[open.length - 1] === 'w:rPr' && /^[wm]:r$/.test(open[open.length - 2] ?? '')
        && !['0', 'false', 'off'].includes(val(attrs) ?? '')) {
      runs[runs.length - 1].hidden = true;
    } else if (['w:sym', 'm:rad', 'm:bar', 'm:borderBox'].includes(tag) || runContentShows(tag)) {
      show();
    } else if (['m:type', 'm:chr', 'm:begChr', 'm:endChr'].includes(tag) && structures.length > 0) {
      structures[structures.length - 1].chars.set(tag, val(attrs) ?? '');
    } else if (tag === 'm:show' && open[open.length - 1] === 'm:phantPr' && phantoms.length > 0) {
      phantoms[phantoms.length - 1] = ['0', 'false', 'off'].includes(val(attrs) ?? '');
    }
    if (selfClosing) continue;
    open.push(tag);
    if (tag === 'w:ins' || tag === 'w:del') changes.push({ kind: tag.slice(2), attrs });
    else if (tag === 'w:r' || tag === 'm:r') runs.push({ hidden: false });
    else if (tag === 'm:phant') phantoms.push(false);
    else if (['m:f', 'm:d', 'm:acc', 'm:nary', 'm:groupChr'].includes(tag)) {
      structures.push({ tag, change: changes[changes.length - 1] ?? none, chars: new Map() });
    }
  }
  return shown;
}

/**
 * The w:ins or w:del that tracks a table row as inserted or deleted, or '':
 * where all that Word shows of its cells as export writes them (`cellsXml`,
 * see shownChanges) is in insertions, or all in deletions, with the first
 * change's author and date. Whitespace and comments outside the changes
 * don't count, as a comment's anchor around one, `{=={++c++}==}`, as import
 * writes a row Word tracks so. Accepting or rejecting the change then takes
 * the row or keeps it, whole, where with its cells' text alone it left an
 * empty row. A row where nothing shows, as an empty one, isn't tracked, as
 * rejecting it would delete a row with nothing to see.
 */
function rowRevision(cellsXml: string, state: DocxGenState): string {
  const shown = shownChanges(cellsXml);
  const kind = shown[0]?.kind;
  if (!kind || shown.some(part => part.kind !== kind)) return '';
  const attrs = ['author', 'date'].map(name => new RegExp('\\sw:' + name + '="[^"]*"').exec(shown[0].attrs)?.[0] ?? '').join('');
  return '<w:' + kind + ' w:id="' + (state.commentId++) + '"' + attrs + '/>';
}

/** Paragraph XML with something import reads: a run, as text, deleted
 *  text, an image, a note or comment reference, or math. */
const PARAGRAPH_CONTENT_RE = /<w:r[ >]|<m:oMath[ >]/;

/** The style of a paragraph in a list item: that of a style block in the
 *  item, where the frontmatter declares it, which import reads the block
 *  back in the item by, with the item's indent, or else the continuation's */
function listContinuationStyleId(token: MdToken, state: DocxGenState): string {
  return token.itemCustomStyle && state.customStyles?.[token.itemCustomStyle] ? customStyleId(token.itemCustomStyle) : 'ManuscriptListContinuation';
}

/** Whether a paragraph is comments alone, as `<!-- a note -->` or a
 *  directive that applies to nothing, which Word gets hidden. */
function isHiddenParagraph(token: MdToken): boolean {
  return token.type === 'paragraph' && token.runs.length > 0 && token.runs.every(r => r.type === 'html_comment');
}

/** Whether the style block that opens at tokens[at] holds only blocks Word
 *  can't give its style (see unstyledInStyleBlock), at least one, up to its
 *  closing fence. Word has no paragraph of its style, so import drops its
 *  fences, and writes those blocks as it would with none */
function stylesNothing(tokens: MdToken[], at: number): boolean {
  for (let j = at + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.customStyleClose && !isImplicitStyleClose(token)) return j > at + 1;
    if (!unstyledInStyleBlock(token)) return false;
  }
  return false;
}

/** Whether `token`, a block after the closing fence of a block of code
 *  alone, is a paragraph of text, a list item, a heading or a quote */
function followsCodeAlone(token: MdToken): boolean {
  if (token.type === 'paragraph') return !marksSectionOrBibliography(token) && token.runs.some(run => run.type === 'text' && !run.rawHtml && run.text.trim() !== '');
  return token.type === 'list_item' || token.type === 'heading' || token.type === 'blockquote';
}

/** Whether `token`, a block right after a code block's closing fence, is
 *  one import writes a blank line before: a paragraph Word shows, a list
 *  item, a heading, a table or a thematic break, and not a quote, which
 *  gets the empty paragraph anyway, nor a comment, which import writes
 *  right after the code */
function followsCodeAfterBlankLine(token: MdToken): boolean {
  if (token.type === 'paragraph') return !isHiddenParagraph(token) && !marksSectionOrBibliography(token);
  return token.type === 'list_item' || token.type === 'heading' || token.type === 'table' || token.type === 'hr';
}

/** Whether the style block of `style` that opens at tokens[at] holds a
 *  section's fence, or the bibliography's place where export places the
 *  fences import writes there (`bibliography`, see atBibliography in
 *  generateDocumentXml), at which import closes it and opens it again once
 *  it has a paragraph in its style after, and nothing else import may end
 *  it at: no block Word can't give its style (see unstyledInStyleBlock),
 *  nor the bibliography's place otherwise, up to its closing fence or the
 *  document's end, and not a block of another style or one in a list item,
 *  which would close it there (see startsStyleBlock and
 *  isImplicitStyleClose). Nor a section's opening fence with no closing one
 *  after it, which import writes no fence for, nor ends the block at */
function splitsAtSections(tokens: MdToken[], at: number, style: string, bibliography = false): boolean {
  let sections = false;
  for (let j = at + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.customStyleOpen) {
      if (startsStyleBlock(style, token.customStyleOpen)) return false;
    } else if (token.customStyleClose) {
      return sections && !isImplicitStyleClose(token);
    } else if (token.bibliographyMarker && !bibliography || unstyledInStyleBlock(token)) {
      return false;
    } else if (marksSectionOrBibliography(token)) {
      if ((token.landscapeOpen || token.portraitOpen) && !closesSection(tokens, j)) return false;
      sections = true;
    }
  }
  return sections;
}

/** The bibliography's place among `tokens`, where it's in a style block,
 *  or -1: import closes the block there and opens it again, with fences
 *  that take no place among the fences, so those after take the blank lines
 *  of the ones before. A document has one at most (see parseMd) */
function bibliographyInStyleBlock(tokens: MdToken[]): number {
  let open = false;
  for (const [j, token] of tokens.entries()) {
    if (token.customStyleOpen) open = true;
    else if (token.customStyleClose) open = false;
    else if (token.bibliographyMarker) return open ? j : -1;
  }
  return -1;
}

/** Whether import may read two blocks of a style in `tokens` as one, as
 *  where Word has nothing between their paragraphs (see closedBlock in
 *  generateDocumentXml). It errs toward yes: two blocks of a style with
 *  nothing outside a block between them but fences and paragraphs of
 *  comment bodies, which Word gets nothing for, and no paragraph of
 *  another style, or any block in a list item that closes one at the top
 *  level (see isImplicitStyleClose) */
function mayReadBlocksAsOne(tokens: MdToken[]): boolean {
  // The styles of the blocks since the last paragraph of another style or
  // anything outside a block, and the block open
  let near = new Set<string>();
  let open: { style: string; styled: boolean } | undefined;
  for (const token of tokens) {
    if (isImplicitStyleClose(token)) return true;
    if (token.customStyleOpen) {
      if (!startsStyleBlock(open?.style, token.customStyleOpen)) continue;
      if (open?.styled) near = new Set([open.style]);
      if (near.has(token.customStyleOpen)) return true;
      near.add(token.customStyleOpen);
      open = { style: token.customStyleOpen, styled: false };
    } else if (token.customStyleClose) {
      if (open?.styled) near = new Set([open.style]);
      open = undefined;
    } else if (isCommentBodyParagraph(token)) {
      continue;
    } else if (!open) {
      near.clear();
    } else if (!marksSectionOrBibliography(token) && !unstyledInStyleBlock(token)) {
      open.styled = true;
    }
  }
  return false;
}

/** Whether the section a fence opens at tokens[at] has a closing fence */
function closesSection(tokens: MdToken[], at: number): boolean {
  for (let j = at + 1; j < tokens.length; j++) {
    if (isOrientationDirective(tokens[j])) return !!(tokens[j].landscapeClose || tokens[j].portraitClose);
  }
  return false;
}

/**
 * Tokens with each quote paragraph of comment bodies only moved into the
 * paragraph of its quote before it, or else the one after, which takes its
 * place at the quote's edge, so Word gets no empty quoted paragraph. An alert
 * lead takes them only when it shows text, since one that doesn't collapses,
 * and a quote of bodies alone stays.
 */
function withQuoteCommentBodiesMerged(tokens: MdToken[]): MdToken[] {
  const merged: MdToken[] = [];
  const sameQuote = (other: MdToken | undefined, token: MdToken): other is MdToken =>
    other?.type === 'blockquote' && other.blockquoteGroupIndex === token.blockquoteGroupIndex && takesQuoteCommentBodies(other);
  const lineBreak: MdRun = { type: 'softbreak', text: '\n' };
  // The tokens this made, whose runs are their own, which the next
  // paragraph's go on the end of, as a copy for each paragraph of many in a
  // row took time for each before it
  const made = new Set<MdToken>();
  const joinedRuns = (before: MdToken, after: MdRun[]): MdRun[] => {
    const runs = made.has(before) ? before.runs : [...before.runs];
    runs.push(lineBreak);
    pushAll(runs, after);
    return runs;
  };
  let carried: MdToken | undefined;
  for (const token of tokens) {
    const bodiesOnly = isQuoteCommentBodies(token);
    if (carried && sameQuote(token, carried)) {
      const joined = { ...token, runs: joinedRuns(carried, token.runs), alertFirst: token.alertFirst || carried.alertFirst };
      made.add(joined);
      // Bodies go on until the quote shows something
      if (bodiesOnly) {
        carried = joined;
      } else {
        merged.push(joined);
        carried = undefined;
      }
      continue;
    }
    if (carried) {
      merged.push(carried);
      carried = undefined;
    }
    if (!bodiesOnly) {
      merged.push(token);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (sameQuote(prev, token)) {
      merged[merged.length - 1] = { ...prev, runs: joinedRuns(prev, token.runs), alertLast: prev.alertLast || token.alertLast };
      made.add(merged[merged.length - 1]);
    } else {
      carried = token;
    }
  }
  if (carried) merged.push(carried);
  return merged;
}

/**
 * The image of the figure the block `token` is, as Quarto reads one: a
 * paragraph whose one run is an image with a figure's label after it, as
 * `![Caption](map.png){#fig-map}`, in no link, at the top level of the
 * body, in no list item, style block or note, and with no tracked change
 * to its mark. Its paragraph is the image's, as before, and a caption
 * goes with it (see captionXml).
 */
function figureImageOf(token: MdToken, state: DocxGenState): MdRun | undefined {
  if (token.type !== 'paragraph' || token.listContinuation || state.activeCustomStyle || state.inNoteBody || token.criticParaMark || token.runs.length !== 1) return undefined;
  const run = token.runs[0];
  return run.type === 'image' && run.figure && !run.href ? run : undefined;
}

/** A paragraph's XML with keepNext in its properties, in their order, so
 *  Word keeps it on the page with the paragraph after it */
function withKeepNext(paragraphXml: string): string {
  const start = /^<w:p(?:\s[^>]*)?>/.exec(paragraphXml)![0];
  const rest = paragraphXml.slice(start.length);
  if (!rest.startsWith('<w:pPr>')) return start + '<w:pPr><w:keepNext/></w:pPr>' + rest;
  const end = rest.indexOf('</w:pPr>');
  return start + '<w:pPr>' + orderPPr(rest.slice('<w:pPr>'.length, end) + '<w:keepNext/>') + rest.slice(end);
}

/** The run types a figure's caption keeps, of what the image's text has,
 *  which import reads back as a caption's: text, in any formatting and
 *  link, and an inline equation */
function captionKeeps(run: MdRun): boolean {
  // An equation with CriticMarkup in it, which Word gets as a tracked change
  // or a comment in it, not, nor a cross-reference, whose field import
  // reads in no caption
  return run.type === 'text' && (!run.crossRef || run.crossRef.form === 'literal') || run.type === 'softbreak' || run.type === 'math' && !run.display && !run.mathParts;
}

/** A comment's Markdown, its ID's where it has one, with its author and
 *  date, and its replies, in it or after it as they were written (see
 *  consecutiveReplies), each in the one it replies to */
function commentMarkdown(run: MdRun, id: string | undefined): string {
  const header = (author: string | undefined, date: string | undefined) => author ? '@' + author + (date ? ' (' + date + ')' : '') + ' | ' : '';
  const replies = run.replies ?? [];
  // Each reply's replies, and the comment's, by the index of the one they reply to
  const children = new Map<number | undefined, number[]>();
  replies.forEach((reply, k) => {
    const parent = reply.parentReply !== undefined && reply.parentReply < k ? reply.parentReply : undefined;
    (children.get(parent) ?? children.set(parent, []).get(parent)!).push(k);
  });
  const reply = (k: number): string => '{>>' + header(replies[k].author, replies[k].date) + replies[k].text
    + (children.get(k) ?? []).map(child => ' ' + reply(child)).join('') + '<<}';
  const top = (children.get(undefined) ?? []).map(reply);
  const open = '{' + (id !== undefined ? '#' + id : '') + '>>' + header(run.author, run.date) + (run.commentText ?? '');
  return run.consecutiveReplies ? open + '<<}' + top.join('') : open + top.map(r => ' ' + r).join('') + '<<}';
}

/** An equation's Markdown, with the CriticMarkup in it */
function mathMarkdown(run: MdRun): string {
  if (!run.mathParts) return '$' + run.text + '$';
  return '$' + run.mathParts.map(part => {
    switch (part.type) {
      case 'math': return part.content;
      case 'addition': return '{++' + part.content + '++}';
      case 'deletion': return '{--' + part.content + '--}';
      case 'highlight': return '{==' + part.content + '==}';
      case 'comment': return '{>>' + part.content + '<<}';
      case 'substitution': return '{~~' + part.oldContent + '~>' + part.newContent + '~~}';
    }
  }).join('') + '$';
}

/** A run a caption can't hold, as text: its Markdown, which holds all of
 *  it, as `{>>note<<}` for a comment, with its replies, `[^n]` for a note's
 *  reference, `{~~old~>new~~}` for a substitution and `$x{++y++}$` for an
 *  equation with CriticMarkup in it, and a space for a line break */
function captionFallbackText(run: MdRun): string {
  switch (run.type) {
    case 'hardbreak': case 'softbreak': return ' ';
    case 'citation': return '[' + run.text + ']';
    case 'footnote_ref': return '[^' + (run.footnoteLabel ?? '') + ']';
    case 'critic_add': return '{++' + run.text + '++}';
    case 'critic_del': return '{--' + run.text + '--}';
    case 'critic_sub': return '{~~' + run.text + '~>' + (run.newText ?? '') + '~~}';
    case 'critic_highlight': return '{==' + run.text + '==}';
    case 'critic_comment': return commentMarkdown(run, undefined);
    case 'comment_body_with_id': return commentMarkdown(run, run.commentId);
    case 'math': return mathMarkdown(run);
    // A caption's label's ID is # and the label (see commentRangeRule)
    case 'comment_range_start': return '{' + (run.commentId?.startsWith('#') ? '' : '#') + (run.commentId ?? '') + '}';
    case 'comment_range_end': return '{/' + (run.commentId ?? '') + '}';
    case 'image': return run.imageSource ?? run.imageAlt ?? '';
    default: return run.text;
  }
}

/**
 * The caption of a figure or a table, `kind`, of the label `label` and the
 * text `captionRuns`, as Word's Insert Caption writes one: a paragraph in
 * the Caption style, which a template gives or export adds (see
 * captionStyleAdded), with the caption's title, as Figure or Table, and its
 * number, in a SEQ field, numbered here in document order, figures and
 * tables apart, its result as Word would update it, in a bookmark a
 * cross-reference goes to, then the delimiter and the caption's text. A
 * caption above its figure or table is kept on the page with it.
 *
 * The bookmark's name is the label as Word can name one (see
 * captionBookmarkName), which import reads the label back by, or else by
 * the custom property MANUSCRIPT_CAPTION_LABELS_. Its ID is the next of
 * those of the notes' bookmarks, which no other bookmark has. Where the
 * captions go, the custom properties MANUSCRIPT_FIG_CAP_LOCATION and
 * MANUSCRIPT_TBL_CAP_LOCATION keep.
 *
 * A caption with what Word's caption would show other than as import reads
 * it back, as a citation, a note, a comment, a tracked change or a line
 * break, gets each of those as its Markdown, as text (see
 * captionFallbackText), so Word shows all of it.
 */
function captionXml(kind: 'figure' | 'table', label: string, captionRuns: MdRun[], state: DocxGenState, options: MdToDocxOptions | undefined, bibEntries: Map<string, BibtexEntry> | undefined, citeprocEngine: CiteprocEngine | undefined): string {
  const { titleDelim } = state.captions;
  const title = kind === 'figure' ? state.captions.figTitle : state.captions.tblTitle;
  const location = kind === 'figure' ? state.captions.figCapLocation : state.captions.tblCapLocation;
  const number = kind === 'figure' ? ++state.figureNumber : ++state.tableNumber;
  const name = captionBookmarkName(label, state.captionBookmarks);
  if (labelOfBookmark(name) !== label) state.captionLabels.set(name, label);
  // The first caption of a label is the one its cross-references go to
  const targets = state.captionTargets ??= new Map();
  if (targets.has(label)) (state.labelsCaptioned ??= new Set()).add(label);
  else targets.set(label, { bookmark: name, text: captionLabelText(title, number) });
  let runs = captionRuns;
  if (!runs.every(captionKeeps)) {
    runs = runs.map(run => captionKeeps(run) ? run : { type: 'text', text: captionFallbackText(run) });
    state.warnings.push('The caption of ' + kind + ' {#' + label + '} has a citation, a cross-reference, a note, a comment, a tracked change, a line break or an image, which Word gets as its Markdown, as text, in its caption.');
  }
  const hasText = runs.some(run => run.type === 'math' || run.type === 'text' && isCaptionText(run.text));
  const separator = captionSeparator(titleDelim, hasText);
  const id = state.nextBookmarkId++;
  return '<w:p><w:pPr><w:pStyle w:val="Caption"/>' + (location === 'top' ? '<w:keepNext/>' : '') + '</w:pPr>'
    + '<w:bookmarkStart w:id="' + id + '" w:name="' + name + '"/>'
    + '<w:r>' + wt(title + ' ') + '</w:r>'
    + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> SEQ ' + escapeXmlText(seqIdentifiers(state.captions.figTitle, state.captions.tblTitle)[kind]) + ' \\* ARABIC </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r><w:rPr><w:noProof/></w:rPr><w:t>' + number + '</w:t></w:r>'
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    + '<w:bookmarkEnd w:id="' + id + '"/>'
    + (separator ? '<w:r>' + wt(separator) + '</w:r>' : '')
    + (hasText ? generateRuns(runs, state, options, bibEntries, citeprocEngine) : '')
    + '</w:p>';
}

export function generateParagraph(token: MdToken, state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: CiteprocEngine): string {
  let pPr = '';

  // Apply custom style when inside a <!-- style: X --> block (to plain
  // paragraphs here, and to list items in their case below)
  if (token.type === 'paragraph' && state.activeCustomStyle) {
    const styleDef = state.customStyles?.[state.activeCustomStyle];
    const twips = state.firstLineIndentTwips || 720;
    let indXml = '';
    if (token.indentOverride === 'indent') {
      indXml = '<w:ind w:firstLine="' + twips + '"/>';
    } else if (token.indentOverride === 'no-indent') {
      indXml = '<w:ind w:firstLine="0"/>';
    } else if (styleDef?.paragraphIndent === undefined && state.firstLineIndentTwips && !state.afterHeading) {
      // Undeclared custom-style paragraph-indent inherits the document-level indent behavior.
      indXml = '<w:ind w:firstLine="' + state.firstLineIndentTwips + '"/>';
    }
    pPr = '<w:pPr><w:pStyle w:val="' + customStyleId(state.activeCustomStyle) + '"/>' + indXml + '</w:pPr>';
  }

  switch (token.type) {
    case 'paragraph':
      if (token.listContinuation) {
        const leftIndent = 720 * token.listContinuation.level;
        // In a style block in the item, the block's style, with the item's
        // indent, which import reads it back in the item by
        const undeclared = token.itemCustomStyle && !state.customStyles?.[token.itemCustomStyle]
          ? 'Custom style "' + token.itemCustomStyle + '" used in <!-- style: --> directive but not declared in frontmatter styles.' : undefined;
        if (undeclared && !state.warnings.includes(undeclared)) state.warnings.push(undeclared);
        pPr = '<w:pPr><w:pStyle w:val="' + listContinuationStyleId(token, state) + '"/><w:ind w:left="' + leftIndent + '"/></w:pPr>';
      }
      break;
    case 'heading': {
      // Paragraph-mark revision for headings promoted from full-paragraph
      // {++### ...++} / {--### ...--} spans. Marking the paragraph mark as
      // inserted/deleted is how Word represents a wholly added/removed
      // paragraph, and it lets the converter reconstruct the original
      // {++### ...++} form (marker inside the Critic span) on round-trip.
      const paraMarkRevision = paragraphMarkRevision(token, state, options);
      const paraMarkRPr = paraMarkRevision ? '<w:rPr>' + paraMarkRevision + '</w:rPr>' : '';
      pPr = '<w:pPr><w:pStyle w:val="Heading' + (token.level || 1) + '"/>' + paraMarkRPr + '</w:pPr>';
      break;
    }
    case 'list_item':
      // A bulleted task item shows its checkbox in place of a bullet; a
      // numbered one keeps its number
      if (token.taskChecked !== undefined && !token.ordered) {
        const leftIndent = 720 * (token.level || 1);
        pPr = '<w:pPr><w:ind w:left="' + leftIndent + '" w:hanging="360"/></w:pPr>';
      } else {
        let numId = String(token.ordered ? state.decimalNumId ?? 2 : state.bulletNumId ?? 1);
        const ilvl = (token.level || 1) - 1;
        // Word counts on through every paragraph of a numbering instance, so
        // each ordered list after the first gets one of its own, which
        // starts at its own number. Its items share it. The first sublist of
        // a numbered item stays in its parent's instance, which Word starts
        // over after each parent item, so a template can number it as 2.1,
        // unless the template's w:lvlRestart has the level go on there: 0,
        // or a level above the parent's. One below the level is ignored.
        // The first list takes the instance numbers take, and a sublist its
        // parent's instance, only where Word would start it at its number:
        // from the level's start, or that instance's start override for the
        // level, which Word applies at its first paragraph there, so a
        // sublist in it needs both to agree. Paragraphs the template's styles
        // number in the same count, as headings can be, would move it on
        // before either, so with those each list gets its own start, and
        // bullets in the same count move it on for the lists after them. A
        // sublist in its parent's instance starts over after the parent, past
        // any bullets before it.
        const parentNumId = ilvl > 0 && state.listItemNumbers?.length === ilvl && state.listItemNumbers[ilvl - 1] !== undefined
          ? state.activeListStartOverrides.get(ilvl - 1) : undefined;
        const levels = state.templateListLevels;
        if (!token.ordered && levels?.bulletsCount) state.usedOrderedNumId = true;
        const restart = levels?.restarts.get(ilvl);
        const startsAfterParent = restart === undefined || restart >= ilvl;
        const levelStart = levels?.starts.get(ilvl) ?? 1, startOverride = levels?.startOverrides.get(ilvl);
        if (token.ordered && (token.listStart || !state.activeListStartOverrides.has(ilvl))) {
          const start = token.startNumber ?? 1;
          if (parentNumId !== undefined && !levels?.numberedByStyles && startsAfterParent && start === levelStart
            && (parentNumId !== (state.decimalNumId ?? 2) || (startOverride ?? start) === start)) {
            state.activeListStartOverrides.set(ilvl, parentNumId);
          } else if (!state.usedOrderedNumId && !levels?.numberedByStyles && start === (startOverride ?? levelStart)) {
            state.activeListStartOverrides.set(ilvl, state.decimalNumId ?? 2);
          } else {
            const overrideNumId = (state.firstOverrideNumId ?? 3) + state.listStartOverrides.length;
            state.listStartOverrides.push({ numId: overrideNumId, ilvl, start });
            state.activeListStartOverrides.set(ilvl, overrideNumId);
          }
          state.usedOrderedNumId = true;
        }
        if (token.ordered) numId = String(state.activeListStartOverrides.get(ilvl));
        pPr = '<w:pPr><w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr></w:pPr>';
        state.hasList = true;
      }
      {
        const ilvl = (token.level || 1) - 1;
        const previous = token.listStart ? undefined : state.listItemNumbers?.[ilvl];
        const number = token.ordered ? (previous !== undefined ? previous + 1 : token.startNumber ?? 1) : undefined;
        state.listItemNumbers = [...(state.listItemNumbers ?? []).slice(0, ilvl), number];
      }
      // In a style block, the item takes the block's style, as a paragraph
      // does, under its numbering, which import reads back as an item in
      // the block
      if (state.activeCustomStyle) pPr = pPr.replace('<w:pPr>', () => '<w:pPr><w:pStyle w:val="' + customStyleId(state.activeCustomStyle!) + '"/>');
      break;
    case 'blockquote': {
      const bqStyleOpt = options?.blockquoteStyle ?? 'GitHub';
      const bqStyle = token.alertType ? ALERT_STYLE_BY_TYPE[token.alertType] : (BLOCKQUOTE_STYLE_ID[bqStyleOpt] ?? bqStyleOpt);
      const bqIndentUnit = bqStyle.startsWith('GitHub') ? GITHUB_BLOCKQUOTE_INDENT : 720;
      const bqLevel = token.level || 1;
      const continuationIndent = token.listContinuation ? 720 * token.listContinuation.level : 0;
      const bqLeftIndent = bqIndentUnit * bqLevel + continuationIndent;
      // Only add inline overrides when they differ from the style defaults (level > 1).
      // Level 1 inherits spacing and indent from the style; redundant overrides
      // cause Word to strip them on open, setting the dirty flag.
      if (bqLevel > 1 || token.listContinuation) {
        pPr = '<w:pPr><w:pStyle w:val="' + bqStyle + '"/><w:spacing w:after="0"/><w:ind w:left="' + bqLeftIndent + '"/></w:pPr>';
      } else {
        pPr = '<w:pPr><w:pStyle w:val="' + bqStyle + '"/></w:pPr>';
      }
      break;
    }
    case 'code_block':
      pPr = '<w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>';
      if (token.language) {
        state.codeBlockLanguages.set(state.codeBlockIndex, token.language);
      }
      state.codeBlockIndex++;
      break;
    case 'hr':
      pPr = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr>';
      break;
  }

  // First-line indent for body paragraphs.
  // Per-paragraph overrides (<!-- indent --> / <!-- no-indent -->) take precedence,
  // then document-level indent mode (non-single spacing) applies to undecorated paragraphs.
  if (token.type === 'paragraph' && !state.activeCustomStyle && !pPr) {
    if (token.indentOverride === 'indent') {
      // Force indent even after headings or without document-level indent mode
      const twips = state.firstLineIndentTwips || 720; // default 0.5 inch
      pPr = '<w:pPr><w:ind w:firstLine="' + twips + '"/></w:pPr>';
    } else if (token.indentOverride === 'no-indent') {
      // Suppress indent — leave pPr unset (no firstLine)
    } else if (state.firstLineIndentTwips && !state.afterHeading) {
      pPr = '<w:pPr><w:ind w:firstLine="' + state.firstLineIndentTwips + '"/></w:pPr>';
    }
  }

  // Pure HTML-comment paragraphs are hidden (vanish) — collapse their spacing
  // so they don't contribute visible gaps in Word's layout engine.
  // The paragraph mark is also vanished (via pPr>rPr) so the paragraph is
  // completely hidden; without this, Word Online may show the paragraph after
  // Word Desktop saves its "Show Hidden Text" preference into settings.xml.
  if (token.type === 'paragraph' && token.runs.length > 0 && token.runs.every(r => r.type === 'html_comment')) {
    // One in a list item keeps a continuation's style, or that of a style
    // block in the item, and indent, which import reads it in the item by,
    // and one in a style block the block's style, which import reads the
    // block by
    pPr = token.listContinuation
      ? '<w:pPr><w:pStyle w:val="' + listContinuationStyleId(token, state) + '"/><w:spacing w:after="0" w:line="1" w:lineRule="exact"/><w:ind w:left="' + 720 * token.listContinuation.level + '"/><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr></w:pPr>'
      : state.activeCustomStyle
        ? '<w:pPr><w:pStyle w:val="' + customStyleId(state.activeCustomStyle) + '"/>' + HIDDEN_PARAGRAPH_PPR.slice('<w:pPr>'.length)
        : HIDDEN_PARAGRAPH_PPR;
  }

  if (token.type === 'code_block') {
    const lines = (token.runs[0]?.text || '').replace(/\n$/, '').split('\n');
    const rpr = '<w:rPr><w:rFonts w:ascii="' + escapeXmlAttribute(state.codeFont) + '" w:hAnsi="' + escapeXmlAttribute(state.codeFont) + '"/></w:rPr>';
    if (state.codeShadingMode) {
      return lines.map((line) => '<w:p>' + pPr + generateRun(line, rpr) + '</w:p>').join('');
    }
    const inset = CODE_BLOCK_INSET_TWIPS;
    return lines.map((line, i) => {
      let linePPr = pPr;
      if (lines.length === 1) {
        linePPr = '<w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="' + inset + '" w:after="' + inset + '" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>';
      } else if (i === 0) {
        linePPr = '<w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="' + inset + '" w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>';
      } else if (i === lines.length - 1) {
        linePPr = '<w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:after="' + inset + '" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>';
      }
      return '<w:p>' + linePPr + generateRun(line, rpr) + '</w:p>';
    }).join('');
  }
  
  if (token.type === 'hr') {
    return '<w:p>' + pPr + '</w:p>';
  }
  
  const alertColorMap = alertColorsByScheme(options?.colors ?? getDefaultColorScheme());
  const hidesAlertLabel = token.type === 'blockquote' && token.alertType && token.alertLead && options?.calloutLabels === false;
  let paragraphRuns = withoutCommentBodyLines(token.runs);
  if (hidesAlertLabel) {
    let separatorIndex = 0;
    while (
      paragraphRuns[separatorIndex]?.type === 'html_comment'
      || (paragraphRuns[separatorIndex]?.type === 'text'
        && paragraphRuns[separatorIndex].text.trim().length === 0)
    ) {
      separatorIndex++;
    }
    const separator = paragraphRuns[separatorIndex];
    if (separator?.type === 'softbreak' || separator?.type === 'hardbreak') {
      paragraphRuns = [...paragraphRuns.slice(0, separatorIndex), ...paragraphRuns.slice(separatorIndex + 1)];
    }
  }
  const runs = generateRuns(paragraphRuns, state, options, bibEntries, citeprocEngine);
  const taskPrefix = token.type === 'list_item' && token.taskChecked !== undefined
    ? generateRun(token.taskChecked ? '☒ ' : '☐ ', '')
    : '';
  const alertPrefix = token.type === 'blockquote' && token.alertType && token.alertLead && !hidesAlertLabel
    ? generateRun(ALERT_GLYPH_BY_TYPE[token.alertType] + ' ' + gfmAlertTitle(token.alertType), '<w:rPr><w:b/><w:color w:val="' + alertColorMap[token.alertType] + '"/></w:rPr>')
      + '<w:r><w:br/></w:r>'
    : '';

  // Comment bodies show nothing, and generateRuns has registered them
  const visuallyEmptyHiddenAlertLead = hidesAlertLabel
    && paragraphRuns.every(run => run.type === 'comment_body_with_id' || isNonRenderingAlertLeadRun(run));
  const omitEmptyAlertLead = visuallyEmptyHiddenAlertLead
    && paragraphRuns.every(run => run.type === 'comment_body_with_id')
    && token.alertHasBodyParagraph;
  if (visuallyEmptyHiddenAlertLead && !omitEmptyAlertLead) {
    const collapsedSpacing = '<w:spacing w:after="0" w:line="1" w:lineRule="exact"/>';
    if (pPr.includes('<w:spacing ')) {
      pPr = pPr.replace(/<w:spacing\b[^>]*\/>/, collapsedSpacing);
    } else if (pPr.includes('<w:ind ')) {
      pPr = pPr.replace('<w:ind ', collapsedSpacing + '<w:ind ');
    } else {
      pPr = pPr.replace('</w:pPr>', collapsedSpacing + '</w:pPr>');
    }
    pPr = pPr.replace(
      '</w:pPr>',
      '<w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr></w:pPr>'
    );
  }
  // Headings place their paragraph-mark revision above
  if (token.type !== 'heading') pPr = withParagraphMarkRevision(pPr, paragraphMarkRevision(token, state, options));
  let xml = omitEmptyAlertLead
    ? ''
    : '<w:p>' + pPr + alertPrefix + taskPrefix + runs + '</w:p>';

  // Blockquote spacer paragraphs: exact-height empty paragraphs with an
  // inline left border (no pStyle, so the converter ignores them).  The left
  // rule extends symmetrically above/below content regardless of font size.
  if (token.type === 'blockquote' && (token.alertFirst || token.alertLast)) {
    const borderColor = token.alertType ? alertColorMap[token.alertType] : GITHUB_BLOCKQUOTE_BORDER_COLOR;
    const spacerBqStyleOpt = options?.blockquoteStyle ?? 'GitHub';
    const spacerBqStyle = token.alertType ? ALERT_STYLE_BY_TYPE[token.alertType] : (BLOCKQUOTE_STYLE_ID[spacerBqStyleOpt] ?? spacerBqStyleOpt);
    const spacerIndentUnit = spacerBqStyle.startsWith('GitHub') ? GITHUB_BLOCKQUOTE_INDENT : 720;
    const spacerContinuationIndent = token.listContinuation ? 720 * token.listContinuation.level : 0;
    const spacerLeftIndent = spacerIndentUnit * (token.level || 1) + spacerContinuationIndent;
    const borderPPr = '<w:pBdr><w:left w:val="single" w:sz="' + GITHUB_BLOCKQUOTE_BORDER_SIZE + '" w:space="' + GITHUB_BLOCKQUOTE_BORDER_SPACE + '" w:color="' + borderColor + '"/></w:pBdr>';
    const indPPr = '<w:ind w:left="' + spacerLeftIndent + '"/>';
    if (token.alertFirst) {
      // pPr ordering: pBdr before spacing before ind — see dirty-flag invariant #3.
      const firstPPr = '<w:pPr>' + borderPPr + '<w:spacing w:after="0" w:line="1" w:lineRule="exact"/>' + indPPr + '</w:pPr>';
      xml = '<w:p>' + firstPPr + '</w:p>' + xml;
    }
    if (token.alertLast) {
      const lastPPr = '<w:pPr>' + borderPPr + '<w:spacing w:after="0" w:line="1" w:lineRule="exact"/>' + indPPr + '</w:pPr>';
      xml = xml + '<w:p>' + lastPPr + '</w:p>';
    }
  }

  return xml;
}

/** A table's grid columns, as its cells and their spans fill them, and the
 *  columns rowspan cells from previous rows occupy, at least one */
function tableGridColumns(rows: MdTableRow[]): number {
  let totalCols = 0;
  const simMerge = new Map<number, { remaining: number; colspan: number }>();
  for (const row of rows) {
    let gridCol = 0;
    let ci = 0;
    // Walk the grid for this row, skipping columns occupied by rowspan continuations
    while (ci < row.cells.length) {
      // Skip columns occupied by pending vertical merges
      let pending = simMerge.get(gridCol);
      while (pending && pending.remaining > 0) {
        pending.remaining--;
        if (pending.remaining === 0) simMerge.delete(gridCol);
        gridCol += pending.colspan;
        pending = simMerge.get(gridCol);
      }
      const cell = row.cells[ci++];
      const cs = cell.colspan || 1;
      const rs = cell.rowspan || 1;
      if (rs > 1) {
        simMerge.set(gridCol, { remaining: rs - 1, colspan: cs });
      }
      gridCol += cs;
    }
    // Skip any trailing columns still occupied by merges
    let pending = simMerge.get(gridCol);
    while (pending && pending.remaining > 0) {
      pending.remaining--;
      if (pending.remaining === 0) simMerge.delete(gridCol);
      gridCol += pending.colspan;
      pending = simMerge.get(gridCol);
    }
    if (gridCol > totalCols) totalCols = gridCol;
  }
  return totalCols || 1;
}

/** The run properties a table gives a run of its text, `run`, or a note's
 *  reference where none is given, past the run's own: the table's font,
 *  where export writes it on the run (see tableFontOnRuns), and its size,
 *  where it's the table's own. None out of a table. */
function tableRunRPr(state: DocxGenState, run?: MdRun): string | undefined {
  const font = tableFontOnRuns(state.fontOverrides, state.tableRunFont, run) ? tableRFonts(state.tableRunFont!) : '';
  return font + state.tableRunRPrExtra || undefined;
}

export function generateTable(token: MdToken, state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: CiteprocEngine): string {
  if (!token.rows) return '';

  // Resolve effective table font/size: per-table token > document-level overrides
  const fo = state.fontOverrides;
  const effectiveTableSizeHp = token.tableFontSize !== undefined
    ? Math.round(token.tableFontSize * 2)
    : fo?.tableSizeHp;
  const effectiveTableFont = token.tableFont ?? fo?.tableFont;
  // Build pPr for table cell paragraphs (style ref + inline overrides for per-table diffs)
  // Always suppress paragraph spacing-after inside table cells (pPrDefault sets after="160"
  // which creates asymmetric vertical padding — cell margin alone should control inset).
  const spacingZero = '<w:spacing w:after="0"/>';
  let tablePPr: string;
  let runSizeRPr = '';
  if (effectiveTableSizeHp || effectiveTableFont) {
    const hasDocLevelStyle = !!(fo?.tableSizeHp || fo?.tableFont);
    // Per-table overrides that differ from doc-level require inline rPr on both pPr and runs
    const needsInlineSize = effectiveTableSizeHp && effectiveTableSizeHp !== fo?.tableSizeHp;
    let pPrInner = '';
    if (hasDocLevelStyle) pPrInner += '<w:pStyle w:val="TableParagraph"/>';
    pPrInner += spacingZero;
    let sizeRPr = '';
    if (needsInlineSize || (!hasDocLevelStyle && effectiveTableSizeHp)) {
      sizeRPr = '<w:sz w:val="' + effectiveTableSizeHp + '"/><w:szCs w:val="' + effectiveTableSizeHp + '"/>';
    }
    // The paragraph mark's font, as a run's (see tableFontOnRuns)
    const rPrInner = (tableFontOnRuns(fo, effectiveTableFont) ? tableRFonts(effectiveTableFont!) : '') + sizeRPr;
    tablePPr = '<w:pPr>' + pPrInner + (rPrInner ? '<w:rPr>' + rPrInner + '</w:rPr>' : '') + '</w:pPr>';
    // Run-level rPr: the same size, and the font where tableRunRPr writes it,
    // so runs take per-table font/size (pPr > rPr only sets the paragraph
    // mark, not run properties)
    runSizeRPr = sizeRPr;
  } else {
    tablePPr = '<w:pPr>' + spacingZero + '</w:pPr>';
  }

  // Compute total grid columns by simulating grid occupancy (accounts for
  // columns implicitly occupied by rowspan cells from previous rows).
  const totalCols = tableGridColumns(token.rows);

  // Compute the table's width in dxa for gridCol w:w attributes (required for Word Online):
  // the page's text width, or the narrowest of the template's columns, which each section
  // takes (see pageContentWidthPx). Use landscape page width (pgSz.h) when the table lives
  // in a section whose page is on its side (see sectionIsLandscape) or carries a per-table
  // landscape orientation, otherwise use portrait width (pgSz.w).
  const pgSz = parseTemplatePgSz(state.templateSectPr);
  const marginsStr = parseTemplateMargins(state.templateSectPr);
  // Mirror the guard in generateDocumentXml: table-only landscape orientation is only
  // active when NOT already inside a portrait fence (in that case no landscape section
  // break is emitted, so the table renders in portrait context).
  const isLandscape = sectionIsLandscape(state) ||
    (token.tableOrientation === 'landscape' && !state.inPortraitSection);
  const textWidthDxa = writableWidthTwips(state, textWidthTwips(isLandscape ? pgSz.h : pgSz.w, marginsStr));

  // Resolve column widths.
  // colWidthPcts: set when user explicitly specifies table-col-widths — drives tblW pct,
  //   tblLayout fixed, tcW pct, and gridCol dxa.  Preserves Word Desktop fixed-layout.
  // implicitGridColDxa: set when no explicit widths — only drives gridCol w:w so Word
  //   Online has a column grid to work from.  tblW/tblLayout/tcW stay as "auto" so
  //   Word Desktop continues to auto-size the table (no full-page-width forcing).
  let colWidthPcts: number[] | undefined;
  let implicitGridColDxa: number[] | undefined;
  const resolvedWidths = token.tableColWidths ?? fo?.tableColWidths;
  if (resolvedWidths && resolvedWidths !== 'auto') {
    const expanded = expandColWidths(resolvedWidths, totalCols);
    colWidthPcts = colWidthsToPct(expanded);
  } else if (!resolvedWidths) {
    // No explicit setting: compute proportional dxa widths for gridCol only.
    // Grid tables use source proportions; pipe tables use equal weights.
    const implicitWeights = token.gridSourceColWidths ?? new Array(totalCols).fill(1);
    const expanded = expandColWidths(implicitWeights, totalCols);
    const pcts = colWidthsToPct(expanded);
    implicitGridColDxa = pcts.map(p => Math.round(p / 5000 * textWidthDxa));
  }

  // Check if any cell uses colspan or rowspan
  const hasSpans = token.rows.some(row =>
    row.cells.some(cell => (cell.colspan && cell.colspan > 1) || (cell.rowspan && cell.rowspan > 1))
  );

  // tblLook's firstRow, which import reads as a header first row, goes only
  // on a table whose first row is one: a <th> row after a <td> row is the
  // only header row. Word repeats only leading header rows, but a later
  // row's tblHeader stays in the file
  const firstRowIsHeader = !!token.rows[0]?.header;

  // Resolve border style: default is 'horizontal'
  const borderStyle = fo?.tableBorders ?? 'horizontal';

  // Word strips border entries with w:val="none" on open and marks the file
  // dirty.  Only emit borders that have a visible style.
  let tblBorders: string;
  if (borderStyle === 'none') {
    tblBorders = '';
  } else if (borderStyle === 'horizontal') {
    // Grey horizontal separators between body rows, no vertical/outer borders.
    // Header underline is applied per-cell via tcBorders below.
    tblBorders = '<w:tblBorders>'
      + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
      + '</w:tblBorders>';
  } else {
    // 'solid': all borders single black
    tblBorders = '<w:tblBorders>'
      + '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
      + '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
      + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
      + '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
      + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
      + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
      + '</w:tblBorders>';
  }

  let xml = '<w:tbl>';
  const tblLayout = colWidthPcts
    ? '<w:tblLayout w:type="fixed"/>'
    : '';
  const tblW = colWidthPcts
    ? '<w:tblW w:w="5000" w:type="pct"/>'
    : '<w:tblW w:w="0" w:type="auto"/>';
  // tblPr element order: tblW before tblBorders (Word normalizes out-of-order).
  // Omit default left/right cell margins (108 dxa) — Word strips these as defaults.
  xml += '<w:tblPr>' + tblW + tblBorders + tblLayout + '<w:tblCellMar><w:top w:w="36" w:type="dxa"/><w:bottom w:w="36" w:type="dxa"/></w:tblCellMar>' + (firstRowIsHeader ? '<w:tblLook w:val="0020" w:firstRow="1"/>' : '') + '</w:tblPr>';

  // Emit tblGrid (required when widths or spans are present).
  // Include w:w in dxa on each gridCol so Word Online can size columns correctly;
  // without explicit widths, Word Online collapses all columns to a single character wide.
  if (hasSpans || colWidthPcts || implicitGridColDxa) {
    xml += '<w:tblGrid>';
    for (let c = 0; c < totalCols; c++) {
      if (colWidthPcts) {
        xml += '<w:gridCol w:w="' + Math.round(colWidthPcts[c] / 5000 * textWidthDxa) + '"/>';
      } else if (implicitGridColDxa) {
        xml += '<w:gridCol w:w="' + implicitGridColDxa[c] + '"/>';
      } else {
        xml += '<w:gridCol/>';
      }
    }
    xml += '</w:tblGrid>';
  }

  // Track pending vertical merges: gridCol -> { remaining: number; colspan: number }
  const mergeMap = new Map<number, { remaining: number; colspan: number }>();

  // For 'horizontal' borders, find the last header row index to apply the black underline
  let lastHeaderRowIdx = -1;
  if (borderStyle === 'horizontal') {
    for (let i = token.rows.length - 1; i >= 0; i--) {
      if (token.rows[i].header) { lastHeaderRowIdx = i; break; }
    }
  }

  // Set per-table run rPr so generateRuns injects font/size on each run
  const prevRunRPrExtra = state.tableRunRPrExtra;
  const prevRunFont = state.tableRunFont;
  state.tableRunRPrExtra = runSizeRPr;
  state.tableRunFont = effectiveTableFont;

  for (let rowIdx = 0; rowIdx < token.rows.length; rowIdx++) {
    const row = token.rows[rowIdx];
    // For horizontal borders: cells in last header row get black bottom border
    const isLastHeaderRow = borderStyle === 'horizontal' && rowIdx === lastHeaderRowIdx;
    const horizontalCellBorders = isLastHeaderRow
      ? '<w:tcBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders>'
      : '';
    // The row's cells, which its own change goes by (see rowRevision)
    let cellsXml = '';
    let cellIdx = 0;
    let gridCol = 0;

    while (gridCol < totalCols) {
      // Check for pending vertical merge continuation at this column
      const pending = mergeMap.get(gridCol);
      if (pending && pending.remaining > 0) {
        let tcPr = '<w:tcPr>';
        if (colWidthPcts) {
          let w = 0;
          for (let ci = 0; ci < pending.colspan && gridCol + ci < colWidthPcts.length; ci++) w += colWidthPcts[gridCol + ci];
          tcPr += '<w:tcW w:w="' + w + '" w:type="pct"/>';
        } else {
          tcPr += '<w:tcW w:w="0" w:type="auto"/>';
        }
        if (pending.colspan > 1) {
          tcPr += '<w:gridSpan w:val="' + pending.colspan + '"/>';
        }
        tcPr += '<w:vMerge/>';
        if (horizontalCellBorders) tcPr += horizontalCellBorders;
        tcPr += '</w:tcPr>';
        cellsXml += '<w:tc>' + tcPr + '<w:p/></w:tc>';
        pending.remaining--;
        if (pending.remaining === 0) mergeMap.delete(gridCol);
        gridCol += pending.colspan;
        continue;
      }

      // Emit real cell
      if (cellIdx >= row.cells.length) {
        // Pad with empty cells if row is short
        if (colWidthPcts && gridCol < colWidthPcts.length) {
          cellsXml += '<w:tc><w:tcPr><w:tcW w:w="' + colWidthPcts[gridCol] + '" w:type="pct"/></w:tcPr><w:p/></w:tc>';
        } else {
          cellsXml += '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p/></w:tc>';
        }
        gridCol++;
        continue;
      }

      const cell = row.cells[cellIdx++];
      const cs = cell.colspan || 1;
      const rs = cell.rowspan || 1;

      let tcPr = '';
      {
        // ECMA-376 §17.4.66 tcPr children order: tcW → gridSpan → vMerge → tcBorders
        const parts: string[] = [];
        if (colWidthPcts) {
          let w = 0;
          for (let ci = 0; ci < cs && gridCol + ci < colWidthPcts.length; ci++) w += colWidthPcts[gridCol + ci];
          parts.push('<w:tcW w:w="' + w + '" w:type="pct"/>');
        } else {
          // Word adds tcW auto to every cell on open — emit it to prevent dirty flag
          parts.push('<w:tcW w:w="0" w:type="auto"/>');
        }
        if (cs > 1) parts.push('<w:gridSpan w:val="' + cs + '"/>');
        if (rs > 1) parts.push('<w:vMerge w:val="restart"/>');
        if (horizontalCellBorders) parts.push(horizontalCellBorders);
        if (parts.length > 0) tcPr = '<w:tcPr>' + parts.join('') + '</w:tcPr>';
      }

      // Register vertical merge for subsequent rows
      if (rs > 1) {
        mergeMap.set(gridCol, { remaining: rs - 1, colspan: cs });
      }

      cellsXml += '<w:tc>' + tcPr;
      // Auto-bold header cells to match Word's default table header styling.
      // Word applies bold to header rows via table styles; we reproduce that here.
      const cellRuns = withoutCommentBodyLines(row.header ? cell.runs.map(boldHeaderRun) : cell.runs);
      // The column's or cell's alignment, which jc sets after spacing
      const cellPPr = cell.align
        ? tablePPr.replace(spacingZero, spacingZero + '<w:jc w:val="' + cell.align + '"/>')
        : tablePPr;
      // An HTML cell's paragraphs, each a paragraph of the Word cell
      let paragraphRuns: MdRun[] = [];
      for (const run of [...cellRuns, { type: 'hardbreak', text: '\n', cellParagraphBreak: true } as MdRun]) {
        if (!run.cellParagraphBreak) {
          paragraphRuns.push(run);
          continue;
        }
        // With its mark tracked where the break after it is (see htmlCellRuns)
        const mark = run.cellParagraphMark ? paragraphMarkRevision({ type: 'paragraph', runs: [], criticParaMark: run.cellParagraphMark }, state, options) : '';
        cellsXml += '<w:p>' + withParagraphMarkRevision(cellPPr, mark) + generateRuns(paragraphRuns, state, options, bibEntries, citeprocEngine) + '</w:p>';
        paragraphRuns = [];
      }
      cellsXml += '</w:tc>';
      gridCol += cs;
    }
    // A row's own change goes after the rest of its properties
    const revision = rowRevision(cellsXml, state);
    xml += '<w:tr>' + (row.header || revision ? '<w:trPr>' + (row.header ? '<w:tblHeader/>' : '') + revision + '</w:trPr>' : '') + cellsXml + '</w:tr>';
  }

  state.tableRunRPrExtra = prevRunRPrExtra;
  state.tableRunFont = prevRunFont;

  xml += '</w:tbl>';
  return xml;
}

/** A header cell's run in bold, and a tracked change's or a comment's range
 *  in it, whose text import reads without the bold too */
function boldHeaderRun(run: MdRun): MdRun {
  if (run.type === 'text') return run.bold ? run : { ...run, bold: true };
  if (run.type !== 'critic_add' && run.type !== 'critic_del' && run.type !== 'critic_sub' && run.type !== 'critic_highlight') return run;
  return {
    ...run, bold: true,
    ...(run.innerRuns ? { innerRuns: run.innerRuns.map(boldHeaderRun) } : {}),
    ...(run.oldRuns ? { oldRuns: run.oldRuns.map(boldHeaderRun) } : {}),
    ...(run.newRuns ? { newRuns: run.newRuns.map(boldHeaderRun) } : {}),
  };
}

function generateParaId(state: DocxGenState): string {
  return (state.nextParaId++).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Add w14:paraId and w14:textId to every <w:p> element that doesn't already
 * carry a w14:paraId.  Applied as post-processing to document.xml,
 * footnotes.xml, and endnotes.xml before they go into the zip.
 *
 * Why: OneDrive's server-side co-authoring processor expects every paragraph
 * in a modern (compatibilityMode ≥ 15) document to have a unique paraId.
 * When document paragraphs lack them but comments.xml paragraphs have them,
 * OneDrive considers the file structurally inconsistent, reassigns all paraIds,
 * and strips paraIdParent from commentsExtended.xml — destroying comment
 * threading.  This works together with w14:docId, w15:docId, and
 * webSettings.xml (see settingsXml()) to present a complete modern document
 * that OneDrive won't "upgrade".
 *
 * Handles all <w:p> variants: <w:p>, <w:p/>, <w:p attr...>.
 * Skips elements that already have w14:paraId (e.g. comment paragraphs).
 */
function injectParaIds(xml: string, state: DocxGenState): string {
  return xml.replace(/<w:p(\s[^>]*)?(\/?>)/g, (match, attrs, close) => {
    // Already has a paraId (e.g. comment paragraphs) — leave it alone
    if (attrs && attrs.includes('w14:paraId')) return match;
    return paraIdTag(generateParaId(state), state, attrs || '', close);
  });
}

/** A paragraph's start tag with its w14:paraId, `id`, as injectParaIds
 *  writes it, and its other attributes, `attrs` */
function paraIdTag(id: string, state: DocxGenState, attrs: string, close: string): string {
  return '<w:p w14:paraId="' + id + '" w14:textId="77777777" w:rsidR="' + state.rsid + '" w:rsidRDefault="' + state.rsid + '"' + attrs + close;
}

/** `xml`, a paragraph, with its w14:paraId `id`, as injectParaIds gives it,
 *  where export needs it before then */
function withParaId(xml: string, id: string, state: DocxGenState): string {
  return xml.replace(/^<w:p(\s[^>]*)?(\/?>)/, (match, attrs, close) => attrs && attrs.includes('w14:paraId') ? match : paraIdTag(id, state, attrs || '', close));
}

function authorInitials(author: string): string {
  // By character, not UTF-16 unit, which would take half of one outside
  // the BMP, as 𠮷
  const initials = author
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => [...part][0].toUpperCase());
  return initials.slice(0, 8).join('');
}

/**
 * Comment threading in OOXML requires four coordinated files:
 *
 *   comments.xml        — comment bodies; the LAST <w:p> in each comment carries
 *                         w14:paraId (the identifier commentsExtended links to)
 *   commentsExtended.xml — one <w15:commentEx> per comment with w15:paraId; replies
 *                         include w15:paraIdParent pointing to the parent's paraId
 *   commentsIds.xml     — maps each paraId to a durableId (persistent across edits)
 *   commentsExtensible.xml — maps durableId to dateUtc for each comment
 *
 * For OneDrive compatibility, the document must also include:
 *   - w14:paraId on every <w:p> in document.xml / footnotes / endnotes (injectParaIds)
 *   - w14:docId + w15:docId in settings.xml
 *   - webSettings.xml
 * Without these, OneDrive's co-authoring processor rewrites the file and strips
 * paraIdParent, destroying threading.  See settingsXml() for details.
 */
function commentsXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15 w16cid">';
  for (const c of comments) {
    const dateAttr = c.date ? ' w:date="' + escapeXmlAttribute(c.date) + '"' : '';
    const initials = authorInitials(c.author);
    const initialsAttr = initials ? ' w:initials="' + escapeXmlAttribute(initials) + '"' : '';
    xml += '<w:comment w:id="' + c.id + '" w:author="' + escapeXmlAttribute(c.author) + '"' + initialsAttr + dateAttr + '>';
    // Split on \n\n for paragraph breaks within the comment.
    // Per OOXML spec, commentsExtended.xml links via the paraId of the
    // LAST paragraph in each comment, so place w14:paraId there.
    const paragraphs = c.text.split('\n\n');
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const isLast = pi === paragraphs.length - 1;
      const paraIdAttr = isLast ? ' w14:paraId="' + c.paraId + '" w14:textId="77777777"' : '';
      const annotationRefRun = pi === 0
        ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : '';
      // A line's end in a paragraph is a line break, as Word writes it
      xml += '<w:p' + paraIdAttr + '>' + annotationRefRun + '<w:r>' + paragraphs[pi].split('\n').map(wt).join('<w:br/>') + '</w:r></w:p>';
    }
    xml += '</w:comment>';
  }
  xml += '</w:comments>';
  return xml;
}

function footnotesXml(entries: FootnoteEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:footnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">';
  // Separator (id=-1)
  xml += '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>';
  // Continuation separator (id=0)
  xml += '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
  for (const entry of entries) {
    xml += '<w:footnote w:id="' + entry.id + '">' + entry.bodyXml + '</w:footnote>';
  }
  xml += '</w:footnotes>';
  return xml;
}

function endnotesXml(entries: FootnoteEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w:endnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">';
  // Separator (id=-1)
  xml += '<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>';
  // Continuation separator (id=0)
  xml += '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>';
  for (const entry of entries) {
    xml += '<w:endnote w:id="' + entry.id + '">' + entry.bodyXml + '</w:endnote>';
  }
  xml += '</w:endnotes>';
  return xml;
}
function commentsExtendedXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15">';
  for (const c of comments) {
    if (c.parentParaId) {
      xml += '<w15:commentEx w15:paraId="' + c.paraId + '" w15:paraIdParent="' + c.parentParaId + '" w15:done="0"/>';
    } else {
      xml += '<w15:commentEx w15:paraId="' + c.paraId + '" w15:done="0"/>';
    }
  }
  xml += '</w15:commentsEx>';
  return xml;
}

function durableIdFromParaId(paraId: string): string {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < paraId.length; i++) {
    hash ^= paraId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0');
}

function commentsIdsXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">';
  for (const c of comments) {
    xml += '<w16cid:commentId w16cid:paraId="' + c.paraId + '" w16cid:durableId="' + durableIdFromParaId(c.paraId) + '"/>';
  }
  xml += '</w16cid:commentsIds>';
  return xml;
}

function commentsExtensibleXml(comments: CommentEntry[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex">';
  for (const c of comments) {
    const dateUtcAttr = c.date ? ' w16cex:dateUtc="' + escapeXmlAttribute(c.date) + '"' : '';
    xml += '<w16cex:commentExtensible w16cex:durableId="' + durableIdFromParaId(c.paraId) + '"' + dateUtcAttr + '/>';
  }
  xml += '</w16cex:commentsExtensible>';
  return xml;
}

function peopleXml(comments: CommentEntry[]): string {
  const authors = [...new Set(comments.map(c => c.author).filter(a => !!a && a.trim().length > 0))];
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">';
  for (const author of authors) {
    xml += '<w15:person w15:author="' + escapeXmlAttribute(author) + '"/>';
  }
  xml += '</w15:people>';
  return xml;
}

/**
 * Pre-scan: assign comment IDs and discover reply relationships so that
 * replyRanges is populated before range start/end markers are emitted, and a
 * body before its range finds it. Without this, replyRanges would be empty
 * when comment_range_start is processed because comment_body_with_id (which
 * populates replyRanges) usually appears after the range markers in the token
 * stream. The document and each note are scanned before they're written.
 */
function prescanCommentIds(tokens: MdToken[], state: DocxGenState): void {
  const hasIdRange = (runs: MdRun[] | undefined): boolean => !!runs?.some(run => run.type === 'comment_range_start'
    || hasIdRange(run.innerRuns) || hasIdRange(run.oldRuns) || hasIdRange(run.newRuns));
  const prescanRuns = (runs: MdRun[] = []) => {
    runs.forEach((run, i) => {
      // A {==...==} anchor's comment gets its ID before the ID ranges in its
      // text, as it starts first. Import starts ranges that start together in
      // ID order, and ends those that end together in the order they
      // started, so with their IDs the other way round, the order of their
      // markers flipped on each round trip.
      if (run.type === 'critic_highlight' && runs[i + 1]?.type === 'critic_comment' && hasIdRange(run.innerRuns)) {
        run.reservedCommentId = state.commentId++;
      }
      prescanRun(run);
    });
  };
  const prescanRun = (run: MdRun) => {
    if (run.type === 'comment_range_start') {
      const mdId = run.commentId || '';
      if (!state.commentIdMap.has(mdId)) {
        state.commentIdMap.set(mdId, state.commentId++);
      }
    } else if (run.type === 'comment_body_with_id' && run.replies && run.replies.length > 0) {
      const mdId = run.commentId || '';
      const numericId = state.commentIdMap.get(mdId);
      if (numericId !== undefined && replyRangesOf(state.replyRanges, numericId).length === 0) {
        for (let replyIndex = 0; replyIndex < run.replies.length; replyIndex++) {
          const replyId = state.commentId++;
          state.replyRanges.push({ replyId, parentId: numericId });
        }
      }
    }
    // Markers and bodies can be in a revision's or a highlight's text too
    prescanRuns(run.innerRuns);
    prescanRuns(run.oldRuns);
    prescanRuns(run.newRuns);
  };
  for (const token of tokens) {
    prescanRuns(token.runs);
    // Also scan runs inside table cells
    if (token.rows) {
      for (const row of token.rows) {
        for (const cell of row.cells) {
          prescanRuns(cell.runs);
        }
      }
    }
  }
  // Word takes a comment's ID in one range, so an ID with more than one, as
  // import writes a comment that reaches into a table in a range of each
  // paragraph and cell, gets one from its first start to its last end. As
  // the preview reads them, a range with no end after its start ends with
  // the paragraph or cell it starts in (see unended below). An end before
  // its ID's first start here, as one in a note whose start is in the
  // text, and the markers of an ID no body has anywhere, as a Pandoc
  // heading ID's in `# Intro {#intro}`, are of no range Word gets, and
  // write nothing, so that Word gets no range marker without its comment
  // and its other end
  const bodies = state.commentBodyIds ?? commentBodyIdsIn(tokens);
  // The markers of each ID, with the paragraph or cell each is in and
  // where it is among them all
  const markers = new Map<string, Array<{ run: MdRun; owner: { runs: MdRun[] }; at: number }>>();
  let count = 0;
  const collectMarkers = (runs: MdRun[] = [], owner: { runs: MdRun[] }) => {
    for (const run of runs) {
      if (run.type === 'comment_range_start' || run.type === 'comment_range_end') {
        const mdId = run.commentId || '';
        const marker = { run, owner, at: count++ };
        const seen = markers.get(mdId);
        if (seen) seen.push(marker);
        else markers.set(mdId, [marker]);
      }
      collectMarkers(run.innerRuns, owner);
      collectMarkers(run.oldRuns, owner);
      collectMarkers(run.newRuns, owner);
    }
  };
  for (const token of tokens) {
    collectMarkers(token.runs, token);
    for (const row of token.rows ?? []) for (const cell of row.cells) collectMarkers(cell.runs, cell);
  }
  let unwritten = false;
  // The ends of the ranges that end with a paragraph or cell, which go at
  // its end, there in the order the ranges start, as import ends ranges
  // that end together
  const ends = new Map<{ runs: MdRun[] }, Array<{ end: MdRun; at: number }>>();
  for (const [mdId, found] of markers) {
    const first = found.findIndex(({ run }) => run.type === 'comment_range_start');
    // The last end after the first start, if any, and the last start
    let last = found.length - 1;
    while (last > first && found[last].run.type !== 'comment_range_end') last--;
    if (last <= first) last = -1;
    let lastStart = found.length - 1;
    while (lastStart > first && found[lastStart].run.type !== 'comment_range_start') lastStart--;
    const ranged = first !== -1 && bodies.has(mdId);
    // A start no end comes after ends with its paragraph or cell, so the
    // one range Word gets ends with the last such start's, which keeps
    // all the preview shows of each, as `{#a}one`, then `{#a}two`, with no
    // `{/a}`, gives Word one range over both
    const unended = ranged && lastStart > last;
    found.forEach(({ run }, k) => {
      if (!ranged || k < first) {
        run.unwrittenRangeMarker = true;
        unwritten = true;
      } else if (k !== first && (unended || k !== last)) {
        run.innerRangeMarker = true;
      }
    });
    if (unended) {
      const end: MdRun = { type: 'comment_range_end', text: '', commentId: mdId };
      const { owner } = found[lastStart];
      const owned = ends.get(owner);
      if (owned) owned.push({ end, at: found[first].at });
      else ends.set(owner, [{ end, at: found[first].at }]);
    }
  }
  for (const [owner, owned] of ends) owner.runs = owner.runs.concat(owned.sort((a, b) => a.at - b.at).map(({ end }) => end));
  if (!unwritten) return;
  for (const token of tokens) {
    token.runs = withoutUnwrittenMarkerSpaces(token.runs, true);
    for (const row of token.rows ?? []) for (const cell of row.cells) cell.runs = withoutUnwrittenMarkerSpaces(cell.runs, true);
  }
}

/** The IDs of the comments' bodies, `{#id>>...<<}`, in `tokens`, in their
 *  table cells and revisions' and highlights' text too, added to `ids` */
function commentBodyIdsIn(tokens: MdToken[], ids = new Set<string>()): Set<string> {
  const collect = (runs: MdRun[] = []) => {
    for (const run of runs) {
      if (run.type === 'comment_body_with_id') ids.add(run.commentId || '');
      collect(run.innerRuns);
      collect(run.oldRuns);
      collect(run.newRuns);
    }
  };
  for (const token of tokens) {
    collect(token.runs);
    for (const row of token.rows ?? []) for (const cell of row.cells) collect(cell.runs);
  }
  return ids;
}

/**
 * `runs` without the spaces and tabs on one side of each range marker that
 * writes nothing (see prescanCommentIds) where it has a space or a line's
 * start or end on each side, as taking a word out there would leave them:
 * `Text {#sec} here.`, where no body has the ID `sec`, gives Word `Text
 * here.`, and `# Intro {#intro}` gives it `Intro`, as import writes them
 * back. A line starts and ends at a line break, and at the paragraph's or
 * cell's start and end where `edges` says `runs` start and end it, which a
 * revision's or a highlight's text doesn't. The spaces after the marker go,
 * or where they can't, the spaces before it: code and a link keep theirs.
 * Returns `runs` itself where nothing changes.
 */
function withoutUnwrittenMarkerSpaces(runs: MdRun[], edges: boolean): MdRun[] {
  for (const run of runs) {
    for (const key of ['innerRuns', 'oldRuns', 'newRuns'] as const) {
      const side = run[key];
      if (side) run[key] = withoutUnwrittenMarkerSpaces(side, false);
    }
  }
  if (!runs.some(run => run.unwrittenRangeMarker)) return runs;
  const lineEdge = (run: MdRun | undefined) => run === undefined ? edges : run.type === 'softbreak' || run.type === 'hardbreak';
  const SPACES_AT_START = /^[ \t]+/;
  const SPACES_AT_END = /[ \t]+$/;
  // Whether text's spaces can go: not code's, a link's or raw HTML's, which
  // are its own, nor, where none stays, at a line's start or end, a
  // highlight's or a mark's, which show
  const loses = (run: MdRun, atLineEdge: boolean) => run.type === 'text' && !(run.code || run.href || run.rawHtml)
    && !(atLineEdge && (run.highlight || run.underline || run.strikethrough));
  const out: MdRun[] = [];
  // The last run Word gets something of in `out`, and where it is
  let shown: MdRun | undefined;
  let shownAt = -1;
  // The index of the run whose spaces at its start go
  let trimAt = -1;
  // In place of a run of spaces alone the marker after it took
  const emptied: MdRun = { type: 'text', text: '' };
  for (let i = 0; i < runs.length;) {
    const run = runs[i];
    if (!run.unwrittenRangeMarker) {
      const kept = i === trimAt ? { ...run, text: run.text.replace(SPACES_AT_START, '') } : run;
      // A run of spaces alone the marker before it took goes
      if (kept === run || kept.text) {
        shown = kept;
        shownAt = out.length;
        out.push(kept);
      }
      i++;
      continue;
    }
    let end = i;
    while (end < runs.length && runs[end].unwrittenRangeMarker) out.push(runs[end++]);
    const after = runs[end];
    const textBefore = shown?.type === 'text' && SPACES_AT_END.test(shown.text);
    const textAfter = after?.type === 'text' && SPACES_AT_START.test(after.text);
    if ((lineEdge(shown) || textBefore) && (lineEdge(after) || textAfter)) {
      if (textAfter && loses(after, lineEdge(shown))) trimAt = end;
      else if (textBefore && loses(shown!, lineEdge(after))) {
        const text = shown!.text.replace(SPACES_AT_END, '');
        // A run of spaces alone the marker after it took goes
        out[shownAt] = text ? { ...shown!, text } : emptied;
      }
    }
    i = end;
  }
  return out.includes(emptied) ? out.filter(run => run !== emptied) : out;
}

/** A tracked change in a title line: an addition, a deletion or a
 *  substitution, whose old side ends at the first ~~} after it, so a
 *  {~~ with no ~> takes in no substitution after it */
const TITLE_CHANGE_RE = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~((?:(?!~~\})[\s\S])*?)~>([\s\S]*?)~~\}/g;

/**
 * The runs of a title line, in `rPr`, its additions, deletions and
 * substitutions, as `{++new++}`, `{--old--}` and `{~~old~>new~~}`, as Word's
 * tracked changes, attributed as generateRuns attributes the body's. The
 * rest of the line is text as it is, as the title takes no other Markdown,
 * and so is an opener with no closer. Import writes them back (see
 * extractTitleLines).
 */
function titleRunsXml(title: string, rPr: string, state: DocxGenState, options?: MdToDocxOptions): string {
  const author = options?.authorName || 'Unknown';
  const inserted = (text: string) => text ? insertionXml(generateRun(text, rPr), author, '', state) : '';
  const deleted = (text: string) => text ? deletionXml('<w:r>' + rPr + delText(text) + '</w:r>', author, '', state) : '';
  let xml = '';
  let last = 0;
  for (const change of title.matchAll(TITLE_CHANGE_RE)) {
    if (change.index > last) xml += generateRun(title.slice(last, change.index), rPr);
    if (change[1] !== undefined) xml += inserted(change[1]);
    else if (change[2] !== undefined) xml += deleted(change[2]);
    else xml += deleted(change[3]) + inserted(change[4]);
    last = change.index + change[0].length;
  }
  // A line with no text, as `title:` alone, still gets its empty run
  return last < title.length || !xml ? xml + generateRun(title.slice(last), rPr) : xml;
}

export function generateDocumentXml(tokens: MdToken[], state: DocxGenState, options?: MdToDocxOptions, bibEntries?: Map<string, BibtexEntry>, citeprocEngine?: CiteprocEngine, frontmatter?: Frontmatter): string {
  tokens = withQuoteCommentBodiesMerged(tokens);
  const omitsCommentBodies = commentBodiesOmitted(tokens);
  // The index of the block Word gets after the one at index ti
  const nextBlockAt = (ti: number): number => {
    let next = ti + 1;
    while (next < tokens.length && (omitsCommentBodies(next, tokens[ti]) || isImplicitStyleClose(tokens[next]))) next++;
    return next;
  };
  let body = '';
  // The empty paragraphs export writes to keep blocks apart, with no
  // numbering where a template's default paragraph style numbers its
  // paragraphs, as Word would show it, and import read it, as an empty list
  // item: after a code block or a quote, with no space after it, and
  // between two code blocks or two tables (`plainSeparator`), with Normal's
  const unnumbered = state.listByStyle?.(undefined) ? '<w:numPr><w:numId w:val="0"/></w:numPr>' : '';
  const separatorParagraph = '<w:p><w:pPr>' + unnumbered + '<w:spacing w:after="0"/></w:pPr></w:p>';
  const plainSeparator = unnumbered ? '<w:p><w:pPr>' + unnumbered + '</w:pPr></w:p>' : '<w:p/>';

  prescanCommentIds(tokens, state);

  // Emit title paragraphs from frontmatter before body content
  if (frontmatter?.title) {
    const fo = resolveFontOverrides(frontmatter);
    for (let i = 0; i < frontmatter.title.length; i++) {
      let rPr = '';
      if (fo) {
        let inner = '';
        const style = resolveAtIndex(fo.titleStyles, i);
        if (style) {
          // Explicitly enable or disable each toggle to override inherited Title style
          inner += style.includes('bold') ? '<w:b/>' : '<w:b w:val="0"/>';
          inner += style.includes('italic') ? '<w:i/>' : '<w:i w:val="0"/>';
          inner += style.includes('underline') ? '<w:u w:val="single"/>' : '<w:u w:val="none"/>';
          // smallcaps/allcaps: mutually exclusive, and 'smallcaps' contains 'allcaps' as substring
          if (style.includes('smallcaps')) {
            inner += '<w:smallCaps/>';
            inner += '<w:caps w:val="0"/>';
          } else if (style.includes('allcaps')) {
            inner += '<w:smallCaps w:val="0"/>';
            inner += '<w:caps/>';
          } else {
            inner += '<w:smallCaps w:val="0"/>';
            inner += '<w:caps w:val="0"/>';
          }
        }
        const font = resolveAtIndex(fo.titleFonts, i);
        if (font) inner += '<w:rFonts w:ascii="' + escapeXmlAttribute(font) + '" w:hAnsi="' + escapeXmlAttribute(font) + '"/>';
        const sizeHp = resolveAtIndex(fo.titleSizesHp, i);
        if (sizeHp) inner += '<w:sz w:val="' + sizeHp + '"/><w:szCs w:val="' + sizeHp + '"/>';
        // In schema order, the font first, caps before smallCaps and
        // underline after the size (dirty-flag invariant #4)
        if (inner) rPr = '<w:rPr>' + orderRPr(inner) + '</w:rPr>';
      }
      const style = resolveAtIndex(fo?.titleStyles, i);
      const wantsCenter = style && style.includes('center');
      const titleStyleHasCenter = fo?.titleStyles?.[0]?.includes('center');
      // Explicit left override needed when the shared Title style has centering but this paragraph does not
      const jcEl = wantsCenter ? '<w:jc w:val="center"/>' : (titleStyleHasCenter ? '<w:jc w:val="left"/>' : '');
      body += '<w:p><w:pPr><w:pStyle w:val="Title"/>' + jcEl + '</w:pPr>' + titleRunsXml(frontmatter.title[i], rPr, state, options) + '</w:p>';
    }
    // Title acts like heading — suppress first-line indent on next paragraph
    state.afterHeading = true;
  }

  // Compute page size and margins for section break injection
  const pgSz = parseTemplatePgSz(state.templateSectPr);
  const margins = parseTemplateMargins(state.templateSectPr);

  // The section break paragraphs, each empty but for its section's properties
  const portraitBreak = '<w:p><w:pPr>' + sectionBreakSectPrXml(false, pgSz, margins, state.rsid, state.templateSectPr) + '</w:pPr></w:p>';
  const landscapeBreak = '<w:p><w:pPr>' + sectionBreakSectPrXml(true, pgSz, margins, state.rsid, state.templateSectPr) + '</w:pPr></w:p>';
  // Helper: emit a portrait section break paragraph and increment ordinal
  function emitPortraitBreak(): void {
    body += portraitBreak;
    state.sectionBreakOrdinal++;
    breakSection();
  }
  function emitLandscapeBreak(): void {
    body += landscapeBreak;
    state.sectionBreakOrdinal++;
    breakSection();
  }

  let prevToken: MdToken | undefined;
  // Whether the block before the style fences since it is code, which a
  // code block after them joins in Word, as the fences write nothing
  let codeBeforeFence = false;
  // A code block that was all of a style block, right before the fence that
  // closes it, which import drops with the block's fences, as Word has no
  // paragraph of its style (see recording), and writes the empty paragraph
  // after a code block for
  let codeAloneBefore: MdToken | undefined;
  // A code block right before the opening fence of a style block that
  // styles nothing, whose fences import drops (see stylesNothing), so it
  // writes the block in it as right after the code. Not the last block of
  // one a paragraph took the style of, which import closes with a fence
  // there, after which the next export writes no empty paragraph
  let codeBeforeUnstyled: MdToken | undefined;
  // The token before this one as import counts list blocks: a style fence
  // writes no paragraph, so import finds no boundary at one, and the lists
  // on either side of it are one block there (see listBlockPlaces)
  let listPrevToken: MdToken | undefined;
  // The document's start, before a title, starts a section as a close does,
  // so a section that opens the document needs no break before it, which
  // would end an empty section, a blank first page
  let preserveCloseForNextToken = body === '';
  // Whether a bibliography marker is all that's written since a section
  // ended, before the next section starts
  let biblAtSectionStart = false;
  // The ordinals the breaks would have that give such a bibliography its own
  // section, where it shows something, the next break's
  const biblBreakOrdinals: number[] = [];
  const emitBiblBreak = (): void => {
    body += BIBL_BREAK_PLACEHOLDER;
    biblBreakOrdinals.push(state.sectionBreakOrdinal);
    breakSection();
  };
  // The hidden paragraphs, comments alone, written since a section ended,
  // with nothing else, and the XML of those written since anything else
  // was. A section that starts after them starts with them, as a custom
  // property records, so they get no section of their own, which would show
  // nothing, a blank page
  let hiddenAtSectionStart = 0;
  let hiddenXml: string[] = [];
  const hiddenBeforeSections = new Map<number, number>();
  // Track before-gap for each sentinel type (sequential index → blankLinesBefore)
  let sentinelLoIdx = 0, sentinelLcIdx = 0, sentinelPoIdx = 0, sentinelPcIdx = 0;
  let sentinelCsoIdx = 0, sentinelCscIdx = 0;
  const sentinelGaps: Record<string, number> = {};
  // The blank lines around a style block's opening fence, at the place
  // among the fences import writes, once the block has a paragraph in its
  // style. Import finds a block by those, so it writes no fence of one
  // without, and takes no place for it, and only the first of a block that
  // opens again in its style (see startsStyleBlock), or that it reads as
  // the block before going on (see closedBlock)
  //
  // Where a section's fence, opening or closing one, comes right after it,
  // before anything of the block, with the bibliography's place right after
  // that, if it is (`run`, the gaps' keys and fence of each), import writes
  // the block's fence after those, as Word's section break comes before the
  // block's first paragraph, so each takes the place among the lines of the
  // one before it in the source: the first the blank lines before the
  // block's, each one after it those between it and the one before, and the
  // block's those between the last two, and after the last (see
  // swapClosingGaps for the closing fences)
  const recordOpeningGaps = (fence: MdToken, run: Array<{ before: string; after: string; fence: MdToken }> = []): void => {
    let { blankLinesBefore: before, blankLinesAfter: after } = fence;
    for (const other of run) {
      setGap(other.before, before);
      setGap(other.after, other.fence.blankLinesBefore);
      before = other.fence.blankLinesBefore;
      after = other.fence.blankLinesAfter;
    }
    if (before !== undefined) sentinelGaps['cso' + sentinelCsoIdx] = before;
    if (after !== undefined) sentinelGaps['csoa' + sentinelCsoIdx] = after;
    sentinelCsoIdx++;
  };
  /** The section's fence at tokens[at], if it is one, with the keys of its
   *  gaps, which it took already, as the last of its kind */
  function sectionFence(at: number): { before: string; after: string; fence: MdToken } | undefined {
    const fence = tokens[at];
    const key = fence?.landscapeOpen ? 'lo' + (sentinelLoIdx - 1) : fence?.portraitOpen ? 'po' + (sentinelPoIdx - 1)
      : fence?.landscapeClose ? 'lc' + (sentinelLcIdx - 1) : fence?.portraitClose ? 'pc' + (sentinelPcIdx - 1) : undefined;
    return key === undefined ? undefined : { before: key, after: key.slice(0, 2) + 'a' + key.slice(2), fence };
  }
  /** Records `count` blank lines for `key` among the fences' gaps, or none */
  function setGap(key: string, count: number | undefined): void {
    if (count === undefined) delete sentinelGaps[key];
    else sentinelGaps[key] = count;
  }
  /** Where a style block's closing fence, at the place `close` among the
   *  closing fences, comes right after a section's fence, opening or
   *  closing one (`section`, its gaps' keys and fence), import writes the
   *  block's fence first, as Word's section break comes after the block's
   *  last paragraph, so the two take each other's places among the lines,
   *  as the opening fences do (see recordOpeningGaps) */
  function swapClosingGaps(close: number, fence: MdToken, section: { before: string; after: string; fence: MdToken }): void {
    setGap('csc' + close, section.fence.blankLinesBefore);
    setGap('csca' + close, fence.blankLinesBefore);
    setGap(section.before, fence.blankLinesBefore);
    setGap(section.after, fence.blankLinesAfter);
  }
  // A style block's blocks Word can't give its style, as a heading, a
  // quote, code, a table or a thematic break, which keep their own. Import
  // can't tell them from those before or after the block by their style,
  // and places them by what this records, for the block's
  // place among those at the top level Word has something of, which import
  // opens a block for each of: how many it starts with, before its first
  // paragraph in its style (csl), and ends with, after its last (cst), and
  // that it has such blocks between its paragraphs (csi), which import
  // keeps in it, where it would otherwise read the block as ending there and
  // another of its style starting, as one does after only such blocks (see
  // the fence pass in convertDocx).
  // The block open at the top level, of `style`, with its place, once Word
  // has something of it, whether Word has had a paragraph of it, the
  // blocks it has had before that and since its last, whether it has had
  // such blocks between its paragraphs, and the blocks outside it before it
  const styleBlockEdges: Record<string, number> = {};
  // A block that splitsAtSections, which import writes as a block of its
  // own for each part between them Word has a paragraph of in its style,
  // has those apart, and whether import closed it at a section's fence
  // since its last such paragraph, with no place counted yet for that
  // closing fence. With the token of its last paragraph in its style, and
  // whether the first of the blocks since came right after it (see
  // closesBeforeTrail)
  let styleBlock: { style: string; index?: number; styled: boolean; lead: number; trail: number; inner: boolean; before: number; fence: MdToken; sections: boolean; cut: boolean; last: number; trailsParagraph: boolean } | undefined;
  let blocksShown = 0;
  // The block of a style closed last, with only such blocks after it, and
  // such blocks outside any since the last block. `place` is its closing
  // fence's among the closing fences, where it took the last one, and
  // `items` whether import has read paragraphs or quotes of a list item in
  // it since (see unfenced)
  let closedBlock: { index: number; style: string; trail: number; inner: boolean; place?: number; items?: boolean } | undefined;
  let unitsOutside = 0;
  // Whether import counts the blocks so far as export does. It has no
  // paragraph to count a block of only such blocks by, it closes a block
  // and opens another at a section break in it or the bibliography's place
  // in it, and it has no paragraph of an alert's lead export leaves out
  // with its label. Past one of these, export records nothing, and import
  // places such blocks as it did before any record
  let recording = true;
  // Whether the style fences export has placed so far are those import
  // writes, one for one, which the blank lines it swaps with a section's
  // fence beside one need, as they go by place (see recordOpeningGaps and
  // swapClosingGaps). Not past a section break or the bibliography's place
  // in a block that doesn't split there (see splitsAtSections), once Word
  // has a paragraph of it, where import closes the block and opens it again
  // with no place for either, nor past what else stops export recording but
  // a section break, as a block of only such blocks. Nor, once it stops, past
  // such blocks between a block's paragraphs, where import ends the block
  // and opens it again, or two blocks of a style import may read as one,
  // with no fences between, which export places (see goesOn). Past one, the
  // blank lines go as before
  let inStep = true;
  const biblInBlock = bibliographyInStyleBlock(tokens);
  // Whether export places the fences import writes where it closes the
  // block that holds the bibliography's place there and opens it again, as
  // at a section's fence (see splitsAtSections). Not where import may read
  // two blocks of a style as one: the places such blocks take as two, as
  // past where export stops counting blocks as import does (see recording
  // and goesOn), made up for those fences there before, so export places
  // none, as before
  const atBibliography = biblInBlock >= 0 && !mayReadBlocksAsOne(tokens);
  const record = (key: string, count: number): void => {
    if (recording) styleBlockEdges[key] = count;
  };
  /** A section break written while a block is open at the top level, as at
   *  a section's fence or around a table in a section of its own, where
   *  import closes the block and opens another, but export goes on with
   *  the one: past it, export records nothing more */
  function breakSection(): void {
    if (!styleBlock) return;
    recording = false;
    if (styleBlock.styled && !styleBlock.sections) inStep = false;
  }
  /** Whether import closes the block open at the top level right after its
   *  last paragraph in its style, before the blocks it ends with that Word
   *  can't give its style, as it has no record of them (see recording),
   *  where the first comes right after that paragraph. The closing fence it
   *  writes there has a blank line after it, before the first, as one
   *  import adds has (see placeUnfencedClose), and not the blank lines
   *  after the block's own closing fence, which come after those blocks,
   *  as the document's end, which has none */
  function closesBeforeTrail(): boolean {
    return !!styleBlock?.styled && styleBlock.trail > 0 && styleBlock.trailsParagraph && !recording;
  }
  /** Records the block open at the top level as its closing fence ends it,
   *  or the document's end, where import closes it too */
  const closeStyleBlock = (): void => {
    if (!styleBlock) return;
    const { style, index, styled, trail, inner, before } = styleBlock;
    // One Word has nothing of is none to import, which the blocks before it
    // are before what comes next
    if (index === undefined) {
      unitsOutside += before;
      return;
    }
    if (styled) {
      if (trail > 0) record('cst' + index, trail);
      closedBlock = { index, style, trail, inner };
    } else {
      // Of such blocks alone, with no paragraph of its style in Word
      recording = inStep = false;
    }
  };
  // The place, among those of the blocks Word has a paragraph of, of a
  // block that one opening in a list item closed with no fence (see
  // isImplicitStyleClose), while the blocks after it are paragraphs and
  // quotes in list items with no custom style, which import reads in it
  let unfenced: number | undefined;
  // Whether a block Word has a paragraph of has closed where one of
  // another style opened at the top level, with no fence, while that one
  // has no paragraph in its style yet
  let unfencedBeforeBlock = false;
  /** The place among the closing fences of the fence import writes where a
   *  block closed with no fence, before `next`, with a blank line on each
   *  side, as import writes one between blocks. It parts two quotes it's
   *  between, as a fence on a line of its own does, so the fences and
   *  quotes after it keep their own. Word's paragraphs stay as they are:
   *  the empty ones between the quotes went in already */
  const placeUnfencedClose = (next?: MdToken): void => {
    sentinelGaps['csc' + sentinelCscIdx] = 1;
    sentinelGaps['csca' + sentinelCscIdx] = 1;
    sentinelCscIdx++;
    const group = next?.type === 'blockquote' ? next.blockquoteGroupIndex : undefined;
    if (group !== undefined && (state.blockquoteGaps.get(group - 1) ?? -1) >= 0) {
      state.blockquoteGaps.set(group - 1, -1);
      state.blockquotePostContentBlankLines.set(group - 1, 1);
      state.blockquotePreContentBlankLines.set(group, 1);
    }
  };
  /** The place among the opening fences of the fence import writes where a
   *  block goes on after a section's fence, with no blank lines of its own
   *  before it, so import writes the section fence's there, and a blank
   *  line after it. The closing fence import wrote before the section's
   *  takes its place first (see placeUnfencedClose) */
  const placeUnfencedOpen = (): void => {
    sentinelGaps['csoa' + sentinelCsoIdx] = 1;
    sentinelCsoIdx++;
  };
  // Whether the list open at each level is ordered, so a quote in a list item
  // can tell whether the next item continues its list or an ancestor's
  const openListOrdered: boolean[] = [];
  // Whether the last top-level list item, while its list is open, is ordered
  let lastTopItem: { ordered: boolean } | undefined;
  // The last block that can start a section with a break, a fence's opener
  // or a table of its own orientation, after which the last section is
  let lastSectionStart = -1;
  for (const [ti, token] of tokens.entries()) {
    if (token.landscapeOpen || token.portraitOpen || token.type === 'table' && token.tableOrientation) lastSectionStart = ti;
  }
  for (const [ti, token] of tokens.entries()) {
    state.inLastSection = ti > lastSectionStart;
    // A paragraph of comment bodies only registers them: Word gets no
    // paragraph, and the blocks around it meet as if it weren't there
    if (omitsCommentBodies(ti, prevToken)) {
      generateRuns(withoutCommentBodyLines(token.runs), state, options, bibEntries, citeprocEngine);
      // Outside a list item, it still ends a restarted list's numbering
      if (!token.listContinuation) {
        state.activeListStartOverrides.clear();
        state.listItemNumbers = [];
      }
      continue;
    }
    // Import writes a closing fence at the top level for such a block
    // where Word's paragraphs of it end, which the source has no line of,
    // before a paragraph or an item of the list at the top level, or a
    // block Word can't give the block's style, which import doesn't read in
    // the block, as it has no record of such blocks between its paragraphs
    // (see planRun in convertDocx). That fence takes its place among the
    // closing ones (see placeUnfencedClose). Before anything else, export
    // counts nothing, as before: before a fence, past which import may read
    // a block of its style as the same, as it does past an empty block of
    // another, or a paragraph in a custom style in a list item or an item
    // of a sublist, where import writes a block in the item, which ends the
    // one at the top level with no fence there
    if (isImplicitStyleClose(token)) {
      if (styleBlock?.styled) unfenced = styleBlock.index;
    } else if (unfenced !== undefined && !(token.listContinuation && (token.type === 'blockquote' || listContinuationStyleId(token, state) === 'ManuscriptListContinuation'))) {
      const fenced = token.type === 'paragraph' && !token.listContinuation && !isStyleDirective(token) && !marksSectionOrBibliography(token)
        || token.type === 'list_item' && (token.level ?? 1) === 1
        || unstyledInStyleBlock(token) && !styleBlockEdges['csi' + unfenced];
      unfenced = undefined;
      if (fenced) placeUnfencedClose(token);
    }
    const codeAcrossFence = codeBeforeFence && token.type === 'code_block';
    const codeAlone = codeAloneBefore;
    const codeOverFence = codeBeforeUnstyled;
    if (!isStyleDirective(token)) {
      codeBeforeFence = false;
      codeAloneBefore = undefined;
      codeBeforeUnstyled = undefined;
      // Not a section's fence or the bibliography's place, which Word gets
      // no paragraph of the block's for
      const marker = marksSectionOrBibliography(token);
      if (unstyledInStyleBlock(token)) {
        if (token.alertLead && options?.calloutLabels === false) recording = inStep = false;
        if (!styleBlock) unitsOutside++;
        else {
          styleBlock.index ??= blocksShown++;
          if (styleBlock.styled) {
            if (styleBlock.trail === 0) styleBlock.trailsParagraph = styleBlock.last === ti - 1;
            styleBlock.trail++;
          } else styleBlock.lead++;
        }
      } else if (styleBlock && !marker) {
        // The block's first paragraph in its style, after the block of its
        // style closed last. With nothing between their paragraphs in Word,
        // import reads the two as one, which the records follow. It writes
        // neither the closing fence of the one before nor the opening fence
        // of this one, so neither takes a place among the fences, and the
        // fences after keep their own blank lines. Past what export can't
        // count as import does, they take them as before (see recording),
        // as they do in a document with the bibliography's place in a
        // block, which takes one fewer of each, so the fences after it came
        // out right with them (see bibliographyInStyleBlock)
        let goesOn = false;
        if (styleBlock.index === undefined && closedBlock?.style === styleBlock.style && closedBlock.trail === 0 && styleBlock.before === 0) {
          styleBlock.index = closedBlock.index;
          styleBlock.inner = closedBlock.inner;
          goesOn = recording && biblInBlock < 0;
          if (!goesOn) inStep = false;
          if (goesOn && closedBlock.place !== undefined && closedBlock.place === sentinelCscIdx - 1) {
            sentinelCscIdx--;
            delete sentinelGaps['csc' + sentinelCscIdx];
            delete sentinelGaps['csca' + sentinelCscIdx];
          }
          closedBlock = undefined;
        }
        styleBlock.index ??= blocksShown++;
        if (!styleBlock.styled) {
          // After a block of its style with such blocks between its
          // paragraphs and only such blocks since, which import can't tell
          // from those between them, so it reads each as an end, as before
          // any record, and counts blocks no more as export does
          if (closedBlock?.style === styleBlock.style && closedBlock.inner && !closedBlock.items) {
            delete styleBlockEdges['csi' + closedBlock.index];
            delete styleBlockEdges['cst' + closedBlock.index];
            recording = inStep = false;
          }
          if (styleBlock.lead > 0) record('csl' + styleBlock.index, styleBlock.lead);
          // Import closes the block before it with a fence, as its style
          // changes at this paragraph, whatever is between them, which
          // planRun closes it in, too (see convertDocx)
          if (unfencedBeforeBlock) placeUnfencedClose();
          unfencedBeforeBlock = false;
        } else if (styleBlock.trail > 0 && !styleBlock.inner) {
          styleBlock.inner = true;
          record('csi' + styleBlock.index, 1);
          // With no record of them, import ends the block at such blocks
          // and opens it again after, with fences export places none for
          if (!recording) inStep = false;
        }
        if (!styleBlock.styled) {
          // A section's fence right after the block's, and the
          // bibliography's place right after that, if it is, before the
          // block's first paragraph in its style, and the blocks it starts
          // with, which import writes in it where it records them, where the
          // fences so far are import's (see inStep)
          const { lead } = styleBlock;
          const before = ti - 1 - lead;
          let run: Array<{ before: string; after: string; fence: MdToken }> = [];
          if (inStep && (lead === 0 || recording)) {
            const section = sectionFence(tokens[before - 1] === styleBlock.fence ? before : before - 1);
            if (section && tokens[before - 1] === styleBlock.fence) run = [section];
            else if (section && tokens[before - 2] === styleBlock.fence && tokens[before].bibliographyMarker) run = [section, { before: 'ref0', after: 'refa0', fence: tokens[before] }];
          }
          if (!goesOn) recordOpeningGaps(styleBlock.fence, run);
        } else if (styleBlock.cut) {
          placeUnfencedClose();
          placeUnfencedOpen();
        }
        styleBlock.styled = true;
        styleBlock.cut = false;
        styleBlock.trail = 0;
        styleBlock.last = ti;
        closedBlock = undefined;
      } else if (styleBlock) {
        // The bibliography's place in the block, which import closes it at,
        // as at a section break, but which has one only between two
        // sections (see breakSection)
        if (token.bibliographyMarker) {
          recording = false;
          if (styleBlock.styled && !styleBlock.sections) inStep = false;
        }
        // A section's fence, or the bibliography's place where export
        // places the fences import writes there (see atBibliography),
        // before which import closes the block, where Word has had a
        // paragraph of it. Where the block has one after it, import opens it
        // again, and that closing fence has no line of the source's. Where
        // it has none, that's the last one import writes for the block,
        // which takes the place, and the blank lines, of the block's own
        if (styleBlock.sections && styleBlock.styled) styleBlock.cut = true;
      } else if (unfenced === undefined) {
        // Anything else outside a block ends import's run of them, as a
        // comment's hidden paragraph does too, but for a paragraph or quote
        // in a list item that import reads in the block one in the item
        // closed (see unfenced)
        closedBlock = undefined;
      } else if (closedBlock) {
        closedBlock.items = true;
      }
    }
    // Whether the list open at the item's level before it is ordered, as a
    // list beside the one the item starts (see besideList)
    const besideOrdered = token.type === 'list_item' ? openListOrdered[(token.level ?? 1) - 1] : undefined;
    if (token.type === 'list_item') {
      openListOrdered.length = token.level ?? 1;
      openListOrdered[(token.level ?? 1) - 1] = !!token.ordered;
    } else if (!token.listContinuation && !isImplicitStyleClose(token)) {
      openListOrdered.length = 0;
    }
    // Any close sentinel, or table with its own section, directly preceding any
    // open sentinel, or such a table, skips the open's break
    // to avoid an empty intermediate section that renders as a blank page.
    const prevWasClose: boolean = !!preserveCloseForNextToken;
    preserveCloseForNextToken = false;
    const biblFirst = biblAtSectionStart;
    biblAtSectionStart = false;
    const hiddenBefore = hiddenAtSectionStart;
    const hiddenXmlBefore = hiddenXml;
    hiddenAtSectionStart = 0;
    hiddenXml = [];

    // Bibliography marker: emit placeholder that will be replaced after the loop
    // once all citedKeys have been collected. Between two sections, as in
    // <!-- /landscape --><!-- references --><!-- landscape -->, a bibliography
    // that shows something gets a section of its own, as other content there
    // does, so it isn't in the second. One with nothing to list, an empty
    // field, which Word shows nothing of, gets none, which would be a blank
    // page: the next section starts with it, as before the close-sentinel
    // status preserved across it, and a custom property puts the marker
    // back before the section's opening fence on import.
    if (token.bibliographyMarker) {
      // The blank lines around it, as around a fence, of which there is
      // one, the first (see parseMd), which import writes them by
      if (token.blankLinesBefore !== undefined) sentinelGaps['ref0'] = token.blankLinesBefore;
      if (token.blankLinesAfter !== undefined) sentinelGaps['refa0'] = token.blankLinesAfter;
      body += BIBL_PLACEHOLDER;
      preserveCloseForNextToken = !!prevWasClose;
      biblAtSectionStart = prevWasClose && !state.inLandscapeSection && !state.inPortraitSection;
      hiddenAtSectionStart = hiddenBefore;
      if (prevToken?.type === 'heading') state.afterHeading = true;
      prevToken = listPrevToken = undefined;
      continue;
    }

    // Custom style sentinels: update active custom style state (no OOXML output,
    // just a state flag that generateParagraph reads), for which Word gets no
    // paragraph (see isStyleDirective).
    if (isStyleDirective(token)) {
      let closesCodeAlone = false;
      // Whether the block open before this fence has a paragraph in its
      // style, which import closes with a fence of its own after its last
      // block, even where this one opens another with none
      const closesStyled = !!styleBlock?.styled;
      if (token.customStyleOpen && frontmatter?.styles && !frontmatter.styles[token.customStyleOpen]) {
        // Validate that the style is declared in frontmatter
        state.warnings.push('Custom style "' + token.customStyleOpen + '" used in <!-- style: --> directive but not declared in frontmatter styles.');
      } else if (token.customStyleOpen) {
        // One of the style of the block open, which no fence closed, goes on
        // in it in Word, and one of another ends it. Its gaps wait for the
        // block's first paragraph in its style (see recordOpeningGaps)
        if (startsStyleBlock(styleBlock?.style, token.customStyleOpen)) {
          // The block open closes with no fence, which import writes once
          // this one has a paragraph in its style. With none, import may
          // write none, as where the block before goes on in Word, and
          // export counts nothing
          unfencedBeforeBlock = !!styleBlock?.styled;
          closeStyleBlock();
          styleBlock = { style: token.customStyleOpen, styled: false, lead: 0, trail: 0, inner: false, before: unitsOutside, fence: token, sections: splitsAtSections(tokens, ti, token.customStyleOpen, atBibliography), cut: false, last: -1, trailsParagraph: false };
          unitsOutside = 0;
        }
        state.activeCustomStyle = token.customStyleOpen;
        biblAtSectionStart = biblFirst;
      } else {
        // One that closes with no fence takes its place where import writes
        // one, if it does (see unfenced), and one of a block Word has no
        // paragraph of in its style, whose fences import can't write (see
        // recordOpeningGaps), none. One import closed at a section's fence
        // since its last paragraph in its style takes the place of that
        // closing fence (see splitsAtSections)
        const placed = !isImplicitStyleClose(token) && !!styleBlock?.styled;
        closesCodeAlone = !isImplicitStyleClose(token) && !!styleBlock && !styleBlock.styled && styleBlock.lead === 1;
        if (placed) {
          if (token.blankLinesBefore !== undefined) sentinelGaps['csc' + sentinelCscIdx] = token.blankLinesBefore;
          if (token.blankLinesAfter !== undefined) sentinelGaps['csca' + sentinelCscIdx] = token.blankLinesAfter;
          // Right after a section's fence, itself right after the block's
          // last paragraph in its style, where the fences so far are
          // import's (see inStep)
          const section = sectionFence(ti - 1);
          const last = tokens[ti - 2];
          if (inStep && section && last && styleBlock?.trail === 0 && !isStyleDirective(last) && !marksSectionOrBibliography(last)) swapClosingGaps(sentinelCscIdx, token, section);
          if (closesBeforeTrail()) {
            sentinelGaps['csca' + sentinelCscIdx] = 1;
            // The section's fence right before this one, which import
            // writes after those blocks, has the blank lines this one has
            // after it, before what comes next
            if (section) setGap(section.after, token.blankLinesAfter);
          }
          sentinelCscIdx++;
        }
        // A block that one opening in a list item closes ends there as at
        // a fence, since Word gets nothing for either, so import reads what
        // comes next as it would after a fence (see closeStyleBlock)
        closeStyleBlock();
        if (placed && closedBlock) closedBlock.place = sentinelCscIdx - 1;
        styleBlock = undefined;
        unfencedBeforeBlock = false;
        state.activeCustomStyle = undefined;
        biblAtSectionStart = biblFirst;
      }
      // Not a section boundary — just thread close-status through (unlike landscapeClose/portraitClose which set true)
      preserveCloseForNextToken = !!prevWasClose;
      hiddenAtSectionStart = hiddenBefore;
      hiddenXml = hiddenXmlBefore;
      if (prevToken?.type === 'heading') state.afterHeading = true;
      if (prevToken?.type === 'code_block') codeBeforeFence = true;
      codeBeforeUnstyled = token.customStyleOpen && !closesStyled && prevToken?.type === 'code_block' && stylesNothing(tokens, ti) ? prevToken : undefined;
      // Only right after the fence that closes the block, a blank line
      // before what comes next, as one opening after it starts a block
      // import may write
      codeAloneBefore = closesCodeAlone && token.blankLinesAfter === 1 && prevToken?.type === 'code_block' ? prevToken : undefined;
      // Which goes between a list item's paragraphs, where nothing else does
      if (!isImplicitStyleClose(token)) prevToken = undefined;
      continue;
    }

    // Landscape sentinels: emit section break paragraphs
    if (token.landscapeOpen) {
      if (token.blankLinesBefore !== undefined) sentinelGaps['lo' + sentinelLoIdx] = token.blankLinesBefore;
      if (token.blankLinesAfter !== undefined) sentinelGaps['loa' + sentinelLoIdx] = token.blankLinesAfter;
      sentinelLoIdx++;
      if (!prevWasClose) {
        emitPortraitBreak();
      } else if (biblFirst) {
        emitBiblBreak();
      }
      if (hiddenBefore > 0) hiddenBeforeSections.set(state.sectionBreakOrdinal, hiddenBefore);
      state.inLandscapeSection = true;
      preserveCloseForNextToken = !!prevWasClose;
      if (prevToken?.type === 'heading') state.afterHeading = true;
      prevToken = listPrevToken = undefined;
      continue;
    }
    if (token.landscapeClose) {
      if (token.blankLinesBefore !== undefined) sentinelGaps['lc' + sentinelLcIdx] = token.blankLinesBefore;
      if (token.blankLinesAfter !== undefined) sentinelGaps['lca' + sentinelLcIdx] = token.blankLinesAfter;
      sentinelLcIdx++;
      // End the landscape section with an empty paragraph carrying landscape sectPr
      emitLandscapeBreak();
      state.inLandscapeSection = false;
      preserveCloseForNextToken = true;
      if (prevToken?.type === 'heading') state.afterHeading = true;
      prevToken = listPrevToken = undefined;
      continue;
    }

    // Portrait sentinels: emit portrait section break paragraphs (same page dims, own page)
    if (token.portraitOpen) {
      if (token.blankLinesBefore !== undefined) sentinelGaps['po' + sentinelPoIdx] = token.blankLinesBefore;
      if (token.blankLinesAfter !== undefined) sentinelGaps['poa' + sentinelPoIdx] = token.blankLinesAfter;
      sentinelPoIdx++;
      if (!prevWasClose) {
        emitPortraitBreak();
      } else if (biblFirst) {
        emitBiblBreak();
      }
      if (hiddenBefore > 0) hiddenBeforeSections.set(state.sectionBreakOrdinal, hiddenBefore);
      state.inPortraitSection = true;
      preserveCloseForNextToken = !!prevWasClose;
      if (prevToken?.type === 'heading') state.afterHeading = true;
      prevToken = listPrevToken = undefined;
      continue;
    }
    if (token.portraitClose) {
      if (token.blankLinesBefore !== undefined) sentinelGaps['pc' + sentinelPcIdx] = token.blankLinesBefore;
      if (token.blankLinesAfter !== undefined) sentinelGaps['pca' + sentinelPcIdx] = token.blankLinesAfter;
      sentinelPcIdx++;
      // Record the ordinal of this portrait close break for round-trip detection
      state.portraitBreakOrdinals.add(state.sectionBreakOrdinal);
      emitPortraitBreak();
      state.inPortraitSection = false;
      preserveCloseForNextToken = true;
      if (prevToken?.type === 'heading') state.afterHeading = true;
      prevToken = listPrevToken = undefined;
      continue;
    }

    // Insert an empty paragraph between consecutive code blocks so they
    // don't merge into a single block on DOCX→MD round-trip, and between
    // two with only style fences between them
    if (token.type === 'code_block' && (prevToken?.type === 'code_block' || codeAcrossFence)) {
      body += plainSeparator;
    }
    // Code blocks have w:after="0", so insert a borderless separator when
    // they are followed by non-code content.  Two cases:
    //   (a) Source had a blank line after the fence → always insert separator.
    //   (b) Callout alert immediately follows (no blank line) → still need a
    //       separator so the callout border doesn't sit flush against the code.
    // Past the fence of a block of code alone, before a paragraph of text,
    // a list, a heading or a quote, which import writes after a blank line
    // past the code, and not, as before, a table, whose separator import
    // writes as blank lines (see dropCodeBlockSeparators), or HTML or a
    // comment, which it writes right after the code
    // And right after the fence, before a block import writes after a blank
    // line past the code, as where the source had one, so that the next
    // trip gives Word the same paragraphs. Not in a style block, where
    // import can write the block's fence between them, as it does before a
    // list where a template's style numbers paragraphs, after which the next
    // export writes none. In one that styles nothing, though, import drops
    // the fences (see stylesNothing), and writes the block in it as right
    // after the code
    const codeBefore = prevToken?.type === 'code_block' ? prevToken : codeOverFence ?? (followsCodeAlone(token) ? codeAlone : undefined);
    if (codeBefore && token.type !== 'code_block') {
      const needsSep = codeBefore.trailingBlankLine || (token.type === 'blockquote' && token.alertFirst)
        || (codeBefore === prevToken && !state.activeCustomStyle || codeBefore === codeOverFence) && followsCodeAfterBlankLine(token);
      if (needsSep) {
        body += separatorParagraph;
      }
    }
    // Reset active list start override when leaving a list context
    if (token.type !== 'list_item' && !token.listContinuation) {
      state.activeListStartOverrides.clear();
      state.listItemNumbers = [];
    }
    // Track list block index for indent override round-trip.
    // A new list block starts when we see a list_item after a non-list-item,
    // or where import sees a top-level item change type, or start a new
    // numbering instance: at each ordered list after the first.
    // Where a template's styles number paragraphs, Word's numbering decides
    // the blocks import reads, with the paragraphs it numbers by their style
    // alone, which export writes with none of their own, as a bulleted task
    // item, and where it starts the count over, which only the document
    // says once it's written. Export reads them from it then (see
    // listItemsRead), and counts none here
    const isTopItem = token.type === 'list_item' && (token.level ?? 1) === 1;
    const startsTopList = token.type === 'list_item' && startsAdjacentList(token, lastTopItem?.ordered);
    const startsBlock = token.type === 'list_item' && ((listPrevToken?.type !== 'list_item' && !listPrevToken?.listContinuation) || startsTopList);
    if (startsBlock) {
      if (token.indentOverride && !state.listByStyle) {
        state.listIndentOverrides.set(state.listBlockIndex, token.indentOverride);
      }
      state.listBlockIndex++;
      state.listItemOrdinal = 0;
    } else if (token.type === 'list_item' && token.listDirective && !state.listByStyle) {
      const block = state.listBlockIndex - 1;
      const places = state.listItemIndentOverrides.get(block) ?? new Map<number, 'indent' | 'no-indent'>();
      places.set(state.listItemOrdinal, token.listDirective);
      state.listItemIndentOverrides.set(block, places);
    }
    let readParaId: string | undefined;
    if (token.type === 'list_item') {
      // A blank line before an item after its block's first, as between
      // items or before a sublist, which makes its list loose. Not after a
      // quote, whose blank lines after it the source had are the quote's
      // (see blockquotePostContentBlankLines), as the parsed text has one
      // there deLazifyBlockquotes put in where the source had none. Nor
      // after a style fence, where the item starts a list of its own, which
      // the blank line doesn't make loose. Nor before the first item of a
      // list that markdown-it starts right after an item of another list at
      // its level or deeper, as at another bullet or delimiter: at the top
      // level, where the blank line makes neither list loose, and in an
      // item, where both are of bullets, which Word has as one list, so the
      // record would make that list loose. In an item, the blank line makes
      // the item's list loose, which import keeps where it writes the lists
      // apart, as lists of two types, or of numbers, which Word starts over,
      // but not two of bullets. A sublist's first item comes right after its
      // parent item instead, and there the blank line makes the parent's
      // list loose. An item after a directive keeps the blank line before
      // the directive, which import writes back before it
      const level = token.level ?? 1;
      const besideList = !!token.listStart && !token.listDirective && prevToken?.type === 'list_item' && (prevToken.level ?? 1) >= level
        && (level === 1 || !token.ordered && besideOrdered === false);
      const blankLine = !!token.blankLineBefore && !!prevToken && prevToken.type !== 'blockquote' && !besideList;
      if (state.listByStyle) {
        readParaId = generateParaId(state);
        state.listItemsRead.push({ paraId: readParaId, blankLine, ...(token.indentOverride ? { indentOverride: token.indentOverride } : {}), ...(token.listDirective ? { listDirective: token.listDirective } : {}) });
      } else if (blankLine && state.listItemOrdinal > 0) {
        recordListBlankLine(state.listBlankLines, state.listBlockIndex - 1, state.listItemOrdinal);
      }
      state.listItemOrdinal++;
    }
    if (isTopItem) lastTopItem = { ordered: !!token.ordered };
    else if (token.type !== 'list_item' && !token.listContinuation) lastTopItem = undefined;
    if (token.type === 'table') {
      recordTableMetadata(token, state);
      // After a table with nothing between them in Word, as a directive's
      // comment is none, an empty paragraph, as Word joins tables with none
      // between them into one, which import reads as nothing
      // Its caption, above it or below it, which keeps it from another
      // table, as an empty paragraph does (see attachTableCaptions)
      const table = () => {
        const xml = generateTable(token, state, options, bibEntries, citeprocEngine);
        recordTableIdentity(token, xml, state, '');
        const caption = token.tableCaption ? captionXml('table', token.tableCaption.label, token.tableCaption.runs, state, options, bibEntries, citeprocEngine) : '';
        if (caption && state.captions.tblCapLocation === 'top') return caption + xml;
        return (body.endsWith('</w:tbl>') ? plainSeparator : '') + xml + caption;
      };
      // Table-only landscape: wrap with section breaks (skip if already in fence-based landscape).
      // Its section is one as a fence's is, so a section that ends right
      // before it ends the one before it, and the next one starts right after
      // it, with no empty section, a blank page, between them.
      if (token.tableOrientation === 'landscape' && !state.inLandscapeSection && !state.inPortraitSection) {
        state.landscapeTables.add(state.tableIndex);
        if (!prevWasClose) emitPortraitBreak();
        else if (biblFirst) emitBiblBreak();
        if (hiddenBefore > 0) hiddenBeforeSections.set(state.sectionBreakOrdinal, hiddenBefore);
        // Its cells' images fit its landscape page
        state.inLandscapeSection = true;
        body += table();
        state.inLandscapeSection = false;
        emitLandscapeBreak();
        preserveCloseForNextToken = true;
      } else if (token.tableOrientation === 'portrait' && !state.inPortraitSection && !state.inLandscapeSection) {
        // Table-only portrait: wrap with portrait section breaks
        state.portraitTables.add(state.tableIndex);
        if (!prevWasClose) emitPortraitBreak();
        else if (biblFirst) emitBiblBreak();
        if (hiddenBefore > 0) hiddenBeforeSections.set(state.sectionBreakOrdinal, hiddenBefore);
        body += table();
        state.portraitBreakOrdinals.add(state.sectionBreakOrdinal);
        emitPortraitBreak();
        preserveCloseForNextToken = true;
      } else {
        body += table();
      }
      // Record embed directive for round-trip if this table came from an embed
      if (token.embedIdx !== undefined && token.embedIdx < state.embedDirectives.length) {
        state.embedDirectiveMap.set(state.tableIndex, token.embedIdx + '\t' + state.embedDirectives[token.embedIdx]);
      }
      state.tableIndex++;
    } else {
      state.afterHeading = prevToken?.type === 'heading' || (!prevToken && state.afterHeading);
      const figureImage = figureImageOf(token, state);
      if (figureImage) state.captionedImages.add(figureImage);
      let paragraphXml = generateParagraph(token, state, options, bibEntries, citeprocEngine);
      // A figure's caption, where Word got its image, with the image's
      // paragraph kept on the page with the caption below it. Neither side
      // counts it among the body's paragraphs, as import reads it with the
      // image (see readCaptions in converter.ts).
      const caption = figureImage && paragraphXml.includes('<w:drawing>')
        ? captionXml('figure', figureImage.figure!.attributes.label, figureImage.figure!.captionRuns, state, options, bibEntries, citeprocEngine) : '';
      if (caption && state.captions.figCapLocation === 'bottom') paragraphXml = withKeepNext(paragraphXml);
      if (readParaId) paragraphXml = withParaId(paragraphXml, readParaId, state);
      // Track body paragraph index for indent override round-trip. Import
      // counts the paragraphs that show something, by countsForIndent as
      // here; one whose only image couldn't be read has no run, so it
      // doesn't count.
      if (showsInWord(token) && PARAGRAPH_CONTENT_RE.test(paragraphXml)) {
        if (token.indentOverride) {
          state.indentOverrides.set(state.bodyParagraphIndex, token.indentOverride);
        }
        state.bodyParagraphIndex++;
      }
      // The group's start is its first paragraph with text past an alert's
      // label, which tells nothing of which alert it is: Word can add
      // another alert of the kind before it, whose label alone is the same
      const group = token.type === 'blockquote' ? token.blockquoteGroupIndex : undefined;
      if (group !== undefined) {
        let identity = state.blockquoteIdentities.get(group);
        if (!identity) state.blockquoteIdentities.set(group, identity = { paragraphs: 0, kind: token.alertType ?? '' });
        if (identity.start === undefined || identity.start === blankParagraphStart) {
          const label = token.alertType && token.alertLead && options?.calloutLabels !== false ? ALERT_GLYPH_BY_TYPE[token.alertType] + ' ' + gfmAlertTitle(token.alertType) : '';
          if (paragraphXml.includes(CROSS_REF_MARK)) (identity.startsPending ??= []).push({ xml: paragraphXml, label });
          else identity.start = quoteStart(paragraphXml, label);
        }
        // The quote's paragraph, in its style, which an alert's hidden
        // label alone doesn't get, and not the spacers around it, which
        // have none
        if (paragraphXml.includes('<w:pStyle ')) identity.paragraphs++;
      }
      body += !caption ? paragraphXml : state.captions.figCapLocation === 'top' ? caption + paragraphXml : paragraphXml + caption;
      // A hidden paragraph after a section ends, with nothing else since,
      // leaves the next section to start before it. Not one in a list, nor
      // one in a style block, which import reads by its style.
      if (prevWasClose && isHiddenParagraph(token) && !token.listContinuation && !state.activeCustomStyle) {
        preserveCloseForNextToken = true;
        biblAtSectionStart = biblFirst;
        hiddenAtSectionStart = hiddenBefore + 1;
        // The run's own array, which nothing else holds: each token takes it
        // and leaves a new one, unless the run goes on, as a copy for each
        // paragraph of a long run took time for each before it
        hiddenXmlBefore.push(paragraphXml);
        hiddenXml = hiddenXmlBefore;
      }
    }
    // An empty paragraph in a list ends it on import, so before more of the
    // list, a quote in a list item keeps its spacing in the metadata alone.
    // An item that starts another list, as 1. y does after - x, gets the
    // empty paragraphs as after any quote.
    const nextAt = nextBlockAt(ti);
    const nextToken = tokens[nextAt];
    const nextLevel = nextToken?.level ?? 1;
    const listGoesOn = !!token.listContinuation && (nextToken?.type === 'list_item'
      ? nextLevel > token.listContinuation.level || openListOrdered[nextLevel - 1] === !!nextToken.ordered
      : !!nextToken?.listContinuation);
    // Whether separators go after the token, empty paragraphs, at which
    // import ends a list block, so that a list after them starts another
    // there (see listBlockPlaces), as an item of another type after a quote
    // in a list item does,
    let separated = false;
    if (token.type === 'blockquote' && token.alertLast && token.blockquoteGroupIndex !== undefined && !listGoesOn) {
      // Inter-blockquote gap: insert separators between consecutive blockquote
      // groups when the source markdown had blank lines between them.
      const interGap = state.blockquoteGaps.get(token.blockquoteGroupIndex) ?? 0;
      if (interGap > 0) {
        for (let bi = 0; bi < interGap; bi++) {
          body += separatorParagraph;
        }
      }
      // Post-blockquote blank lines before non-blockquote content. One
      // before a list, a heading, code or a table right after the quote,
      // which import writes after a blank line, so that Word gets what
      // the source with one gives, and the next trip the same. So for a
      // paragraph Word shows, a rule or HTML right after a quote in a list
      // item, which import writes at least one blank line before (see
      // blankLinesAfterListQuote), but for a comment or a fence, which it
      // writes as they were, or the empty paragraph of comment bodies that
      // ends the list before another (see commentBodiesOmitted). Past the
      // opening fence of a style block that styles nothing, whose fences
      // import drops (see stylesNothing), as it writes the block in it as
      // right after the quote: a quote of no alert at the top level too,
      // after a blank line, where this one ends at the top level in no list
      // item, and any other in this quote, with no empty paragraph between.
      // Not where this quote ends a block a paragraph took the style of,
      // which import closes with a fence after it, as after code (see
      // codeBeforeUnstyled)
      const unstyled = !styleBlock?.styled && !!nextToken?.customStyleOpen && stylesNothing(tokens, nextAt);
      const shownNext = unstyled ? tokens[nextAt + 1] : nextToken;
      let blankCount = state.blockquotePostContentBlankLines.get(token.blockquoteGroupIndex) ?? 0;
      if (blankCount === 0 && state.blockquotePostContentBlankLines.has(token.blockquoteGroupIndex)
        && (['list_item', 'heading', 'code_block', 'table'].includes(shownNext?.type ?? '')
          || unstyled && !token.listContinuation && token.level === 1 && shownNext.type === 'blockquote' && shownNext.level === 1 && !shownNext.alertType
          || !!token.listContinuation && (shownNext?.type === 'hr'
            || nextToken?.type === 'paragraph' && !isHiddenParagraph(nextToken) && !isCommentBodyParagraph(nextToken) && !isStyleDirective(nextToken)
              && !marksSectionOrBibliography(nextToken)))) {
        blankCount = 1;
        state.blockquotePostContentBlankLines.set(token.blockquoteGroupIndex, 1);
      }
      for (let bi = 0; bi < blankCount; bi++) {
        body += separatorParagraph;
      }
      separated = interGap > 0 || blankCount > 0;
    }
    prevToken = token;
    // A paragraph or quote in an item after them goes on in no block, as
    // import starts none there, so the item after it starts one
    listPrevToken = separated || token.listContinuation && !listPrevToken ? undefined : token;
    // where the next block's first top-level item starts none, as it
    // follows none in the block
    if (separated) lastTopItem = undefined;
  }
  // A block with no closing fence, which import closes at the end, or
  // before the blocks it ends with
  if (closesBeforeTrail()) sentinelGaps['csca' + sentinelCscIdx] = 1;
  closeStyleBlock();

  // Register only the actually-cited keys so makeBibliography() outputs
  // only entries that were referenced in the markdown.
  if (citeprocEngine) {
    citeprocEngine.updateItems([...state.citedKeys]);
  }

  // Generate bibliography + missing-keys XML, then place at marker or append at end.
  // Uses split/join (not replace) to avoid $-corruption in replacement strings.
  const hasBiblMarker = body.includes(BIBL_PLACEHOLDER);
  let biblXml = '';
  // Keep imported Zotero metadata even when there are no live citation fields.
  // A marker with no entries to list, or no citeproc engine, still gets the
  // field, empty, which import reads back as the marker, so the marker keeps
  // its place, and the missing-key notes after it theirs. At the end of the
  // body, where the bibliography goes anyway, import drops the marker, even
  // before the notes' definitions, which Markdown writes after the body, so
  // there it gets none.
  if (citeprocEngine && (state.citedKeys.size > 0 || options?.zoteroBiblData)
    || hasBiblMarker && !body.endsWith(BIBL_PLACEHOLDER)) {
    biblXml += generateBibliographyXml(citeprocEngine, options?.zoteroBiblData, frontmatter?.bibliographyHangingIndent, state.templateStyles);
  }
  // An empty field is one hidden paragraph, which Word shows nothing of
  const biblShows = biblXml !== '' && !biblXml.startsWith('<w:p>' + HIDDEN_PARAGRAPH_PPR) || state.missingKeys.size > 0;
  if (state.missingKeys.size > 0) {
    biblXml += generateMissingKeysXml([...state.missingKeys]);
  }
  if (hasBiblMarker) {
    body = body.split(BIBL_PLACEHOLDER).join(biblXml);
  } else {
    body += biblXml;
  }
  // A bibliography between two sections that shows something ends a section
  // of its own, which moves each break after it on by one. One that doesn't
  // starts the next section, which import reads back before its fence.
  if (biblBreakOrdinals.length > 0) {
    if (biblShows) {
      body = body.split(BIBL_BREAK_PLACEHOLDER).join(portraitBreak);
      const portraitBreakOrdinals = [...state.portraitBreakOrdinals];
      state.portraitBreakOrdinals.clear();
      for (const ordinal of portraitBreakOrdinals) state.portraitBreakOrdinals.add(ordinal + biblBreakOrdinals.filter(b => b <= ordinal).length);
      // And they count among the breaks, which number the last section
      state.sectionBreakOrdinal += biblBreakOrdinals.length;
      // Hidden paragraphs before such a bibliography are in its section
      const hiddenBefore = [...hiddenBeforeSections].filter(([ordinal]) => !biblBreakOrdinals.includes(ordinal));
      hiddenBeforeSections.clear();
      for (const [ordinal, count] of hiddenBefore) hiddenBeforeSections.set(ordinal + biblBreakOrdinals.filter(b => b <= ordinal).length, count);
    } else {
      body = body.split(BIBL_BREAK_PLACEHOLDER).join('');
      state.referencesBeforeSections = biblBreakOrdinals;
    }
  }

  state.hiddenBeforeSections = hiddenBeforeSections;

  // Store sentinel gap metadata on state for custom property emission
  state.sentinelGaps = sentinelGaps;
  state.styleBlockEdges = styleBlockEdges;

  // Append body-closing sectPr (preserves template page layout). A section
  // that ends the document, with nothing after its break, has the body's
  // properties, as Word writes the last section's, and no break, which
  // would leave the last section empty, a blank last page. Its page is
  // turned to its fence's orientation where the template's isn't. Not where
  // the section is empty, whose break is all it has, nor where it's the
  // only one, whose orientation import reads as the page's (see
  // extractDocumentContent in converter.ts). Hidden paragraphs alone after
  // its break, which would be all the last section has, a blank last page,
  // go before it, at the end of its section, as a custom property records.
  let closingSectPr = bodyClosingSectPrXml(pgSz, margins, state.templateSectPr, state.rsid);
  const hiddenTail = preserveCloseForNextToken && body.endsWith(hiddenXml.join('')) ? hiddenXml.join('') : '';
  const beforeTail = body.slice(0, body.length - hiddenTail.length);
  const lastBreak = beforeTail.endsWith(landscapeBreak) ? landscapeBreak : beforeTail.endsWith(portraitBreak) ? portraitBreak : undefined;
  const beforeLastBreak = lastBreak && beforeTail.slice(0, beforeTail.length - lastBreak.length);
  const breakEnd = '</w:sectPr></w:pPr></w:p>';
  if (lastBreak && beforeLastBreak && beforeLastBreak.includes(breakEnd) && !beforeLastBreak.endsWith(breakEnd)) {
    body = beforeLastBreak + hiddenTail;
    if (hiddenTail) state.hiddenAfterSections = new Map([[state.sectionBreakOrdinal - 1, hiddenXml.length]]);
    const landscape = lastBreak === landscapeBreak;
    if (landscape || isLandscapeSectPr(closingSectPr)) closingSectPr = fencedBodySectPrXml(landscape, pgSz, margins, state.templateSectPr, state.rsid);
  } else if (state.sectionBreakOrdinal > 0 && state.templateSectPr && isLandscapeSectPr(closingSectPr)) {
    // Import reads the last section's orientation from these properties, so
    // where they're a template's landscape page, which no fence set, a custom
    // property says so, by the number of breaks before the section
    state.templatePageSection = state.sectionBreakOrdinal;
  }
  // The last section, after a break, starts on a new page, as each section
  // export adds does, where the template's last section starts on the same
  // page, or an odd or even one, which would run it on after a fence's
  // section, or leave a blank page before it: the template's w:type
  // becomes nextPage in its place, and no w:type is a new page already, as
  // a tracked change's old properties keep theirs. Not where the section is
  // empty, after a break that ends the document.
  if (body.includes(breakEnd) && !body.endsWith(breakEnd)) closingSectPr = nextPageSectPrXml(closingSectPr);
  // What of the template's own last section that changed, its page turned
  // for a final fence and its columns fitted to it, or its break type, a
  // custom property records, so that an export that takes this one as its
  // template lays its sections out with the template's own, as this one
  // does, not with what this one fitted to its last section
  if (state.templateSectPr) state.templateLayout = templateLayoutRecord(state.templateSectPr, closingSectPr);
  state.lastSectionLandscape = isLandscapeSectPr(closingSectPr);
  ({ body, closingSectPr } = withTemplateSectPrs(body, closingSectPr, state.templateSections));
  // Each reference again to a note shows the number Word gives the note,
  // which the notes, written after, show too (see withNoteNumbers)
  state.noteNumbering = noteNumberingOf(state);
  state.noteNumbers = noteNumbersIn(body, state.noteNumbering);
  body = withNoteNumbers(body, state.noteNumbers, state.noteNumbering);

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    DOCUMENT_START + '\n' +
    '<w:body>\n' + body + '\n' + closingSectPr + '\n</w:body>\n' +
    '</w:document>';
}

/** Whether `runs` hold a citation, in a revision's or a highlight's runs too */
function runsCite(runs: MdRun[] | undefined): boolean {
  return !!runs?.some(run => run.type === 'citation' || runsCite(run.innerRuns) || runsCite(run.oldRuns) || runsCite(run.newRuns));
}

/** Whether `tokens` hold a citation, in a table's cells too */
function tokensCite(tokens: MdToken[]): boolean {
  return tokens.some(token => runsCite(token.runs) || !!token.rows?.some(row => row.cells.some(cell => runsCite(cell.runs))));
}

/**
 * Whether export reads a citation in `markdown`, which the CLI and the
 * extension ask before they warn that a bibliography is missing: as
 * convertMdToDocx parses the body, without its frontmatter and its notes'
 * definitions, after its grid tables, and each note's body, with the
 * body's link definitions. So a citation counts where export reads one, as
 * in a CriticMarkup span that holds an HTML block, which export joins into
 * a paragraph, and not where it reads none, as in code, in an HTML block it
 * writes as text, in an HTML table's cell or in a CriticMarkup comment.
 * Not in an embedded file, which this has no
 * resolver for, nor one only number formatting could change, which formats
 * no citation. A deleted citation counts, as the Markdown holds it.
 */
export function hasCitations(source: string): boolean {
  // Every citation holds an @
  if (!source.includes('@')) return false;
  // Each line end as markdown-it reads it, as \n, as convertMdToDocx reads
  // the text, whose steps it runs, as the editor's text can have \r\n
  const { body } = parseFrontmatter(normalizeNewlines(source));
  const { cleaned, definitions } = extractFootnoteDefinitions(body);
  const tokens = parseMd(preprocessGridTables(cleaned));
  if (tokensCite(tokens)) return true;
  for (const note of definitions.values()) {
    if (tokensCite(parseMd(preprocessGridTables(note), undefined, false, undefined, linkDefinitionsOf.get(tokens), undefined, true))) return true;
  }
  return false;
}

export async function convertMdToDocx(
  source: string,
  options?: MdToDocxOptions
): Promise<MdToDocxResult> {
  // Each line end as markdown-it reads it, \r\n or a \r alone as well as \n,
  // as \n, so each step before it splits lines where it does
  const written = normalizeNewlines(source);
  // A section left open at the document's end ends there: export reads the
  // document as if a closing fence ended it, after a blank line, so that
  // each step reads what the section ends with as it reads it before that
  // fence. The warning of the open section reads the document as written
  // (see parseMd)
  const closing = closingFenceAtEnd(maskFrontmatter(written));
  const markdown = closing ? written.slice(0, closing.end) + closing.fence : written;
  // Parse frontmatter for CSL style and other metadata
  const { metadata: frontmatter, body, fieldOrder, warnings: frontmatterWarnings } = parseFrontmatter(markdown);
  // Where the frontmatter has keys export reads nothing from, as Pandoc's
  // or Quarto's, where they are among those it reads, for import
  const unusedFrontmatter = frontmatterLayout(markdown);
  // Count blank lines between frontmatter closing --- and body content.
  // parseFrontmatter strips the closing line's end; the line ends left at
  // the body's start are the blank lines
  const hadFrontmatter = body !== markdown;
  const frontmatterBlankLines = hadFrontmatter
    ? (body.match(/^\n*/)?.[0] ?? '').length
    : -1; // -1 means no frontmatter present
  const fontOverrides = resolveFontOverrides(frontmatter);
  const isInsetMode = frontmatter.codeBackgroundColor === 'none' || frontmatter.codeBackgroundColor === 'transparent';
  const codeBlockConfig: CodeBlockConfig = {
    insetMode: isInsetMode,
    background: !isInsetMode && frontmatter.codeBackgroundColor && /^[0-9A-Fa-f]{6}$/.test(frontmatter.codeBackgroundColor) ? frontmatter.codeBackgroundColor : undefined,
    codeFontColor: frontmatter.codeFontColor,
    codeBlockInset: frontmatter.codeBlockInset,
  };
  // Strip previously-generated "Citation data for @key was not found" paragraphs
  // so they don't accumulate on successive round-trips. The missing-key mechanism
  // regenerates these from the actual unresolved citation keys, which run
  // to a comma, spaces and all, as in [@a b], and hold no ; or ], which end
  // an item or the citation.
  // A note is a top-level paragraph of its own, as export reads one, not a
  // line of one, of a list or quote, or of code or HTML: as parseMd reads
  // the body, without the notes' definitions and after its preprocessing,
  // where a line after a quote's, a grid table's or a definition is its own
  // and a CriticMarkup span's lines are one.
  // Lines end as markdown-it ends them. Its text is as Word shows it, with
  // import's escapes and character references, as of a key's < in
  // @a&lt;b, decoded, HTML export writes as text, as a key's <span>, but
  // not a comment, break or formatting, and a URL as written.
  const MISSING_KEY_TEXT = /^Citation data for @[^,;\]]+ was not found in the bibliography file\.$/;
  // A line a note could be, whatever its key, and one export stripped by
  // the line alone before, of a key of no spaces
  const NOTE_LINE = /^Citation data for @.+ was not found in the bibliography file\.[ \t]*$/;
  const BARE_NOTE_LINE = /^Citation data for @\S+ was not found in the bibliography file\.$/;
  const bodyParts = body.split(/(\n)/);
  const lines = bodyParts.filter((_part, k) => k % 2 === 0);
  let notes: Set<number> | undefined;
  if (lines.some(line => NOTE_LINE.test(line))) {
    const md = citationTextParser();
    // Each line a note could be ends in its index between two of a
    // private-use character the body lacks, past CriticMarkup's, so it's
    // found again however the preprocessing moves and joins lines. A
    // CriticMarkup span's end, as <<}, in a line export stripped before
    // ends none there, as the span may be a citation's of its key, as in
    // [@a<<}{>>b] before its note.
    let markCode = 0xE001;
    while (body.includes(String.fromCharCode(markCode))) markCode++;
    const mark = String.fromCharCode(markCode);
    const markedIndex = new RegExp(mark + '(\\d+)' + mark + '$');
    const marked = lines.map((line, k) => NOTE_LINE.test(line)
      ? (BARE_NOTE_LINE.test(line) ? line.replace(/(?:\+\+|--|~~|==|<<)\}/g, close => close.slice(0, 2)) : line.trimEnd()) + mark + k + mark
      : line);
    const parsed = md.parse(preprocessCriticMarkup(preprocessBlocks(extractFootnoteDefinitions(marked.join('\n')).cleaned).output), {});
    notes = new Set(parsed.flatMap((token, t) => {
      if (token.type !== 'paragraph_open' || token.level !== 0 || !token.map || token.map[1] - token.map[0] !== 1) return [];
      // The line alone
      const content = parsed[t + 1]?.content ?? '';
      const index = markedIndex.exec(content);
      if (!index || content !== marked[Number(index[1])]) return [];
      const k = Number(index[1]);
      // Its key as export reads the line, in runs of plain text alone
      const children = noteKeyParser().parseInline(lines[k].trim(), {})[0]?.children;
      const runs = children?.every(child => child.type === 'text' || child.type === 'html_inline') ? processInlineChildren(children) : [];
      return runs.every(run => run.type === 'text'
        && !(run.bold || run.italic || run.underline || run.strikethrough || run.superscript || run.subscript))
        && MISSING_KEY_TEXT.test(runs.map(run => run.text).join('')) ? [k] : [];
    }));
  }
  const joinedBody = bodyParts
    // A note's line, and the line end after it
    .filter((_part, k) => !notes?.has((k - k % 2) / 2))
    .join('');
  const trailingBlankLines = /\n{3,}$/.exec(joinedBody);
  const bodyStripped = joinedBody.replace(/\n{3,}$/, '\n'); // trim trailing excess blank lines from removed block
  // For each line of the body as it goes to parseMd, and one past the last,
  // the line of the Markdown it comes from (see line-map.ts), after the
  // frontmatter, without the notes' lines, the notes' definitions, and the
  // lines embeds and grid tables wrote in place of others. Quote spacing
  // reads the blank lines around each quote there.
  const frontmatterLines = lineCount(markdown.slice(0, markdown.length - body.length)) - 1;
  let bodyLines: LineMap = sameLines(lineCount(body)).map(line => line + frontmatterLines);
  const noteLineEdits: LineEdit[] = [];
  let partStart = 0;
  bodyParts.forEach((part, k) => {
    if (k % 2 === 0 && notes?.has(k / 2)) noteLineEdits.push({ start: partStart, end: partStart + part.length + (bodyParts[k + 1]?.length ?? 0), text: '' });
    partStart += part.length;
  });
  if (noteLineEdits.length > 0) bodyLines = throughLines(linesAfterEdits(body, noteLineEdits), bodyLines);
  if (trailingBlankLines) bodyLines = throughLines(linesAfterEdits(joinedBody, [{ start: trailingBlankLines.index, end: joinedBody.length, text: '\n' }]), bodyLines);

  // Extract footnote definitions before markdown parsing
  const { cleaned: bodyWithoutFootnotes, definitions: footnoteDefs, lines: withoutFootnotesLines } = extractFootnoteDefinitions(bodyStripped);
  bodyLines = throughLines(withoutFootnotesLines, bodyLines);
  const parseWarnings: string[] = [];
  // Preprocess embeds before tokenization so embedded files resolve to HTML tables.
  let embedDirectives: string[] = [];
  let bodyForParsing = bodyWithoutFootnotes;
  if (options?.embedResolver && options?.documentPath) {
    const embedOpts = options.maxDtaFileSize != null ? { maxDtaFileSize: options.maxDtaFileSize } : undefined;
    const embedResult = preprocessEmbedsTracked(bodyWithoutFootnotes, options.embedResolver, options.documentPath, 0, embedOpts);
    bodyForParsing = embedResult.output;
    embedDirectives = embedResult.embedDirectives;
    bodyLines = throughLines(embedResult.lines, bodyLines);
    // Also expand embeds inside footnote/endnote definitions
    for (const [label, noteBody] of footnoteDefs) {
      const noteResult = preprocessEmbedsTracked(noteBody, options.embedResolver, options.documentPath, embedDirectives.length, embedOpts);
      if (noteResult.output !== noteBody) {
        footnoteDefs.set(label, noteResult.output);
        pushAll(embedDirectives, noteResult.embedDirectives);
      }
    }
  }

  // Numeric table formatting runs on the shared HTML/pipe/grid representation so
  // preview and DOCX export apply exactly the same transformations.
  const gridTables = preprocessGridTablesWithSourceMap(bodyForParsing);
  bodyLines = throughLines(withEnd(gridTables.lines, bodyForParsing.split('\n').length), bodyLines);
  bodyForParsing = gridTables.output;
  const tableNumberFormat: TableNumberFormat = {
    digits: frontmatter.tableDigits,
    decimalMark: frontmatter.tableDecimalMark,
    digitGrouping: frontmatter.tableDigitGrouping,
  };
  const numberResult = formatTableNumbers(bodyForParsing, tableNumberFormat);
  const numbersFormatted = numberResult.output !== bodyForParsing;
  const unformattedBody = bodyForParsing;
  // Number formatting rewrites a table's cells, which can take its lines out
  // or put them in, as a cell of lines of a dash a number takes the place of
  if (numberResult.edits.length > 0) bodyLines = throughLines(linesAfterEdits(bodyForParsing, numberResult.edits), bodyLines);
  bodyForParsing = numberResult.output;
  pushAll(parseWarnings, numberResult.warnings);
	// A note's body from before number formatting, where it formatted any
	const unformattedNotes = new Map<string, string>();
	for (const [label, noteBody] of footnoteDefs) {
		const noteNumberResult = formatTableNumbers(preprocessGridTables(noteBody), {
			digits: frontmatter.tableDigits,
			decimalMark: frontmatter.tableDecimalMark,
			digitGrouping: frontmatter.tableDigitGrouping,
		});
		if (noteNumberResult.output !== noteBody) unformattedNotes.set(label, noteBody);
		footnoteDefs.set(label, noteNumberResult.output);
		pushAll(parseWarnings, noteNumberResult.warnings);
	}
  // The line the body starts on, after the frontmatter and the blank lines
  // after it, which frontmatterBlankLines holds. The masked frontmatter's
  // lines read as blank, which a comment or fence that starts the body
  // counted in the blank lines before it: import puts those nowhere at the
  // document's start, but between two fences where it writes another first
  const bodyStartLine = hadFrontmatter
    ? (markdown.slice(0, markdown.length - body.length) + (body.match(/^\n*/) ?? [''])[0]).split('\n').length - 1
    : 0;
  const tokens = parseMd(bodyForParsing, parseWarnings, frontmatter.breaks ?? false, { text: maskFrontmatter(markdown), lines: bodyLines, written: maskFrontmatter(written) },
    undefined, numbersFormatted ? unformattedBody : undefined, false, bodyStartLine);

  // Number quote groups and collect the source spacing parseMd recorded on them
  annotateBlockquoteGroupIndices(tokens);
  const blockquoteSpacing = blockquoteSpacingMaps(tokens);
  const blockquotePlaces = blockquoteListPlaces(tokens);
  const blockquoteGaps = blockquoteSpacing.gaps;
  const blockquotePreContentBlankLines = blockquoteSpacing.before;
  const blockquotePostContentBlankLines = blockquoteSpacing.after;
  const blockquoteAlertMarkerInlineByGroup = blockquoteSpacing.alertInline;
  const { beforeGaps: htmlCommentGaps, afterGaps: htmlCommentAfterGaps } = annotateHtmlCommentIndices(tokens);

  // Parse BibTeX if provided
  let bibEntries: Map<string, BibtexEntry> | undefined;
  if (options?.bibtex) {
    bibEntries = parseBibtex(options.bibtex);
  }

  // Create citeproc engine if CSL style specified in frontmatter
  let citeprocEngine: CiteprocEngine | undefined;
  // What the frontmatter's reading leaves out first, as of a block list's
  const earlyWarnings: string[] = [...frontmatterWarnings ?? [], ...parseWarnings];

  // Detect custom style name collisions (e.g. 'my-heading' and 'my_heading' both → MsCustomMyHeading)
  if (frontmatter.styles && Object.keys(frontmatter.styles).length > 1) {
    const idToNames = new Map<string, string[]>();
    for (const name of Object.keys(frontmatter.styles)) {
      const sid = customStyleId(name);
      const existing = idToNames.get(sid);
      if (existing) existing.push(name);
      else idToNames.set(sid, [name]);
    }
    for (const [sid, names] of idToNames) {
      if (names.length > 1) {
        earlyWarnings.push(
          'Custom style names ' + names.map(n => '"' + n + '"').join(' and ') +
          ' produce the same Word style ID "' + sid + '"; only the first definition will be used.'
        );
      }
    }
  }

  // A bibliography file is sufficient to request formatted references. Use a
  // bundled default when no style was selected, and record it in Zotero prefs,
  // and that it was the default, which import leaves out of the frontmatter
  // (see defaultCslProps).
  const defaultCsl = !frontmatter.csl && bibEntries && bibEntries.size > 0 ? 'apa' : undefined;
  if (defaultCsl) frontmatter.csl = defaultCsl;
  if (frontmatter.csl && bibEntries) {
    let styleName = frontmatter.csl;

    // 0. Resolve file-like CSL values (relative or absolute paths)
    const isFileLike = styleName.endsWith('.csl') || isAbsolute(styleName);
    if (isFileLike && !isAbsolute(styleName)) {
      if (options?.sourceDir) {
        const resolved = join(options.sourceDir, styleName);
        if (existsSync(resolved)) {
          styleName = resolved;
        } else {
          earlyWarnings.push(`CSL file "${styleName}" not found in source directory (${options.sourceDir}).`);
        }
      } else {
        earlyWarnings.push(`Relative CSL path "${styleName}" cannot be resolved without a source directory.`);
      }
    }

    // 1. Try bundled styles
    let result = createCiteprocEngineLocal(bibEntries, styleName, frontmatter.locale);

    // 2. Try CSL cache directory (e.g. VS Code global storage)
    const cslCacheDir = options?.cslCacheDir;
    const cachedStylePath = cslCacheDir ? resolveCslCachePath(cslCacheDir, styleName) : undefined;
    if (result.styleNotFound && cachedStylePath && existsSync(cachedStylePath)) {
      result = createCiteprocEngineLocal(bibEntries, cachedStylePath, frontmatter.locale);
    }

    // 3. Ask user whether to download
    if (result.styleNotFound) {
      let shouldDownload = false;
      if (options?.onStyleNotFound) {
        shouldDownload = await options.onStyleNotFound(styleName);
      }
      if (shouldDownload && cslCacheDir && cachedStylePath) {
        try {
          await downloadStyle(styleName, cslCacheDir);
          result = createCiteprocEngineLocal(bibEntries, cachedStylePath, frontmatter.locale);
        } catch {
          earlyWarnings.push(`CSL style "${styleName}" could not be downloaded. Export completed without CSL citation formatting.`);
        }
      } else if (shouldDownload) {
        // No cslCacheDir — fall back to async download into bundled dir
        result = await createCiteprocEngineAsync(bibEntries, styleName, frontmatter.locale);
        if (result.styleNotFound) {
          earlyWarnings.push(`CSL style "${styleName}" could not be downloaded. Export completed without CSL citation formatting.`);
        }
      } else {
        earlyWarnings.push(`CSL style "${styleName}" is not bundled. Export completed without CSL citation formatting.`);
      }
    }

    citeprocEngine = result.engine;
    // updateItems() is deferred until after the cited-keys pre-scan below
    // so that citation numbers reflect document order, not bib-file order.
  }

  // Extract template parts if provided
  let templateParts: Map<string, Uint8Array> | undefined;
  let templateSections: TemplateSections | undefined;
  if (options?.templateDocx) {
    const extracted = await extractTemplateParts(options.templateDocx);
    templateParts = extracted.parts;
    templateSections = extracted.sections;
  }
  // The template's headers and footers take document.xml's first relationships
  const templateRelCount = templateSections?.relationships.length ?? 0;
  // The numbering of a template's styles and headers, its references to its
  // relationships, as a picture bullet's image, numbered from rId1 as its
  // relationships go with it, and the numIds the document's lists take in it
  const templateNumbering = templateParts?.has('word/numbering.xml')
    ? withRelationshipIds(decodeXml(templateParts.get('word/numbering.xml')!), templateSections?.numberingRels?.ids) : undefined;
  const templateStyles = templateParts?.has('word/styles.xml') ? decodeXml(templateParts.get('word/styles.xml')!) : undefined;
  // The template's own IDs for the built-in styles the parts refer to, as
  // Word in another language gives them (see templateStyleIds)
  const templateIds = templateStyleIds(templateStyles);
  const numIdsInUse = templateNumIdsInUse(templateStyles, templateSections?.numIds);
  const listNumbering = listNumIds(templateNumbering, templateStyles, numIdsInUse);

  const hasTheme = true; // always include a theme (template or default)

  // Recompute auto-shrink baseline from template Normal style BEFORE document
  // generation so generateTable() compares per-table sizes against the correct
  // document-level default (not the hardcoded DEFAULT_BODY_HP fallback).
  if (fontOverrides.tableSizeFromDefault && templateParts?.has('word/styles.xml')) {
    const templateBodyHp = extractNormalStyleSizeHp(decodeXml(templateParts.get('word/styles.xml')!));
    if (templateBodyHp !== undefined) {
      fontOverrides.tableSizeHp = Math.max(1, templateBodyHp - 4);
    }
  }

  const notesMode = frontmatter.notes === 'endnotes' ? 'endnotes' as const : 'footnotes' as const;

  // Reserve rId slots: the template's headers and footers, then styles,
  // numbering, comments, optional notes/comment-thread rels/theme/settings/webSettings/fontTable.
  // Reserve max optional slots to avoid hyperlink rId collisions.
  const rIdOffset = templateRelCount + 3 + 6 + (hasTheme ? 1 : 0) + 3; // +6 optional rels (foot/end/commentsExtended/commentsIds/commentsExtensible/people), +3 fixed settings/webSettings/fontTable

  // The numbering numbers take, where it is the template's, and not export's
  // own (see withOwnNums)
  const listTemplateNumbering = listNumbering.own.has(listNumbering.decimal) ? undefined : templateNumbering;
  const state: DocxGenState = {
    commentId: 0,
    comments: [],
    commentIdMap: new Map(),
    relationships: new Map(),
    nextRId: 1,
    rIdOffset,
    warnings: [...earlyWarnings],
    hasList: false,
    listStartOverrides: [],
    bulletNumId: listNumbering.bullet,
    decimalNumId: listNumbering.decimal,
    firstOverrideNumId: Math.max(maxOf(numIdsInUse, 2), listNumbering.bullet, listNumbering.decimal) + 1,
    usedOrderedNumId: false,
    templateListLevels: templateListLevels(listTemplateNumbering, listNumbering.decimal, styleNumIds(templateStyles),
      listNumbering.own.has(listNumbering.bullet) ? undefined : listNumbering.bullet),
    hasComments: false,
    hasFootnotes: false,
    hasEndnotes: false,
    footnoteId: 1,
    footnoteEntries: [],
    footnoteLabelToId: new Map(),
    notesMode,
    missingKeys: new Set(),
    citationIds: new Set(),
    citationItemIds: new Map(),
    timezone: frontmatter.timezone,
    replyRanges: [],
    // Start document paraIds at a high offset to avoid collisions with template-
    // assigned IDs (which Word typically allocates starting near 0).  Comment paraIds
    // are allocated first during comment generation; document/footnote/endnote paraIds
    // are allocated later by injectParaIds().  All share this single counter so they
    // never collide.  Valid range: 0x00000001–0x7FFFFFFF (Word ignores 0 and ≥ 0x80000000).
    nextParaId: 0x10000000,
    codeBlockIndex: 0,
    codeBlockLanguages: new Map(),
    noteCodeBlockStarts: new Map(),
    citedKeys: new Set(),
    codeFont: codeFontName(fontOverrides),
    codeShadingMode: !isInsetMode,
    blockquoteGaps: blockquoteGaps,
    blockquotePreContentBlankLines,
    blockquotePostContentBlankLines,
    blockquoteAlertMarkerInlineByGroup,
    blockquotePlaces,
    blockquoteIdentities: new Map(),
    imageRelationships: new Map(),
    imageMediaPaths: new Map(),
    imageBinaries: new Map(),
    imageFormats: new Map(),
    noteImageFormats: new Map(),
    imageExtensions: new Set(),
    rsid: Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, '0'),
    nextImageDocPrId: 1,
    tableIndex: 0,
    tableFormats: new Map(),
    tableFontSizes: new Map(),
    tableFonts: new Map(),
    tableColWidths: new Map(),
    tableDigits: new Map(),
    tableDecimalMarks: new Map(),
    tableDigitGroupings: new Map(),
    tableHtmlAround: new Map(),
    tablesAlike: new Map(),
    tableIdentities: [],
    pipeTableAligned: new Map(),
    gridSourceColWidths: new Map(),
    fontOverrides,
    listIndent: detectListIndent(bodyWithoutFootnotes),
    consecutiveReplyParaIds: new Set(),
    htmlCommentGaps,
    htmlCommentAfterGaps,
    tableRunRPrExtra: '',
    landscapeTables: new Set(),
    portraitTables: new Set(),
    inLandscapeSection: false,
    inPortraitSection: false,
    sectionBreakOrdinal: 0,
    portraitBreakOrdinals: new Set(),
    templateSectPr: templateSections?.sectPr,
    templateSections,
    templateStyles: templateStyles !== undefined,
    sentinelGaps: {},
    styleBlockEdges: {},
    customStyles: frontmatter.styles,
    activeListStartOverrides: new Map(),
    inNoteBody: false,
    noteRelationships: new Map(),
    noteImageRelationships: new Map(),
    noteNextRId: 1,
    footnoteCrossRefLabels: new Set(),
    nextBookmarkId: 0,
    captions: captionOptions(frontmatter),
    figureNumber: 0,
    tableNumber: 0,
    captionBookmarks: new Set(),
    captionLabels: new Map(),
    captionedImages: new Set(),
    uncaptionedLabels: new Set(),
    indentMode: false,
    afterHeading: false,
    indentOverrides: new Map(),
    bodyParagraphIndex: 0,
    listIndentOverrides: new Map(),
    listItemIndentOverrides: new Map(),
    listBlockIndex: 0,
    listItemOrdinal: 0,
    listBlankLines: new Map(),
    listItemsRead: [],
    listByStyle: templateStyles ? await styleListMeta(ensureManuscriptStyles(templateStyles), templateNumbering) : undefined,
    embedDirectiveMap: new Map(),
    embedDirectives,
  };

  // Compute indent mode: when line-spacing is non-single, auto-enable first-line indent
  // unless paragraph-indent is explicitly 'none'.
  {
    const lsTwips = resolveLineSpacingTwips(frontmatter.lineSpacing);
    const isNonSingle = lsTwips !== 240 && lsTwips !== 276; // 276 = default 1.15
    if (frontmatter.paragraphIndent === 'none') {
      // Explicitly disabled — no indent
    } else if (typeof frontmatter.paragraphIndent === 'number' && frontmatter.paragraphIndent > 0) {
      state.firstLineIndentTwips = Math.round(frontmatter.paragraphIndent * 1440); // inches to twips
    } else if (isNonSingle) {
      state.firstLineIndentTwips = 720; // default 0.5 inch
    }
    state.indentMode = state.firstLineIndentTwips !== undefined;
  }

  // Pre-scan the note references and the citations that become fields, in
  // the order generateRuns reaches them. Deleted CriticMarkup content
  // ({--...--} innerRuns, {~~old~>...~~} oldRuns) renders citations as
  // literal deleted text, not fields, so its keys aren't registered.
  type Reached = { label: string; tracked: boolean } | { keys: string[] };
  const collectReached = (runs: MdRun[] | undefined, reached: Reached[], tracked: boolean, deleted: boolean) => {
    for (const run of runs ?? []) {
      if (run.type === 'footnote_ref') {
        if (run.footnoteLabel) reached.push({ label: run.footnoteLabel, tracked });
      } else if (run.type === 'citation') {
        if (run.keys && !deleted) reached.push({ keys: run.keys });
      } else if (run.type === 'critic_sub') {
        collectReached(run.oldRuns, reached, true, true);
        collectReached(run.newRuns, reached, true, deleted);
      } else {
        collectReached(run.innerRuns, reached, tracked || run.type === 'critic_add' || run.type === 'critic_del', deleted || run.type === 'critic_del');
      }
    }
  };
  const reachedIn = (tokenList: MdToken[]) => {
    const reached: Reached[] = [];
    for (const token of tokenList) {
      collectReached(token.runs, reached, false, false);
      for (const row of token.rows ?? []) {
        for (const cell of row.cells) collectReached(cell.runs, reached, false, false);
      }
    }
    return reached;
  };
  // The order of the labels' first references, tracked or not, which import
  // writes notes in where their labels tie (see compareNoteLabels)
  const firstReferences = new Map<string, number>();
  {
    // Register only cited keys, in document order, so numeric styles number
    // citations by it, not by bib-file order. A note's citations come where
    // the reference that owns the note is.
    const registerKeys = (keys: string[]) => {
      for (const k of keys) {
        if (bibEntries?.has(k)) state.citedKeys.add(k);
      }
    };
    const scannedNotes = new Set<string>();
    const scanNote = (label: string) => {
      if (!bibEntries || scannedNotes.has(label)) return;
      scannedNotes.add(label);
      const bodyText = footnoteDefs.get(label);
      if (!bodyText) return;
      // Parse the note as a note (inNote), as the real note parse below does:
      // a note leaves a quote's or a list item's bare environment as written,
      // so a citation in it is a field, and the scan must register it too.
      for (const item of reachedIn(parseMd(bodyText, undefined, false, undefined, linkDefinitionsOf.get(tokens), undefined, true))) {
        if ('keys' in item) registerKeys(item.keys);
        else scanNote(item.label);
      }
    };
    // A reference outside any tracked change owns its note when there is one
    // (see noteReferenceXml). Word numbers notes in the order of the
    // references that own them, so number each note where its owner is, and
    // a cross-reference's cached number is the one Word shows.
    const reached = reachedIn(tokens);
    for (const item of reached) {
      if ('label' in item && !firstReferences.has(item.label)) firstReferences.set(item.label, firstReferences.size);
    }
    const untracked = new Set(reached.flatMap(item => 'label' in item && !item.tracked ? [item.label] : []));
    for (const item of reached) {
      if ('keys' in item) {
        registerKeys(item.keys);
      } else if (!state.footnoteLabelToId.has(item.label) && !(item.tracked && untracked.has(item.label))) {
        state.footnoteLabelToId.set(item.label, state.footnoteId++);
        scanNote(item.label);
      }
    }
    state.untrackedNoteLabels = untracked;
    state.trackedNoteReference = reached.some(item => 'label' in item && item.tracked);
  }

  // Register only cited keys with citeproc so citation numbers reflect
  // document order (not bib-file order) for numeric styles.
  if (citeprocEngine && state.citedKeys.size > 0) {
    citeprocEngine.updateItems([...state.citedKeys]);
  }

  // Resolve effective blockquote style: frontmatter > options > default
  const effectiveBlockquoteStyle = frontmatter.blockquoteStyle ?? options?.blockquoteStyle ?? 'GitHub';
  // Resolve effective color scheme: frontmatter > options > default
  const effectiveColors: ColorScheme = frontmatter.colors ?? options?.colors ?? getDefaultColorScheme();
  // Resolve generated callout labels: frontmatter > options > default enabled.
  const explicitCalloutLabels = frontmatter.calloutLabels ?? options?.calloutLabels;
  const effectiveCalloutLabels = explicitCalloutLabels ?? true;
  const resolvedOptions = options
    ? { ...options, blockquoteStyle: effectiveBlockquoteStyle, colors: effectiveColors, calloutLabels: effectiveCalloutLabels }
    : { blockquoteStyle: effectiveBlockquoteStyle, colors: effectiveColors, calloutLabels: effectiveCalloutLabels };
  if (!effectiveCalloutLabels) {
    moveHiddenAlertLeadComments(tokens);
  }

  // The notes the text reaches go in the order import writes them back in,
  // which their tables' and code blocks' indices follow (see
  // compareNoteLabels): the body's, whose first references break ties, and
  // then those only another note refers to, which import writes after
  // those, as the notes before reach them, and so after the note that gives
  // each its ID. All are parsed before the body is written, and before any
  // note is made, so that a comment's range in one registers before its
  // body in another, whatever their order, and a range's markers know
  // whether a body of their ID is anywhere (see commentBodyIds).
  const noteQueue = [...footnoteDefs.keys()].filter(label => firstReferences.has(label))
    .sort((a, b) => compareNoteLabels(a, b) || firstReferences.get(a)! - firstReferences.get(b)!);
  const queuedNotes = new Set(noteQueue);
  const parsedNotes = new Map<string, { tokens: MdToken[]; warnings: string[] }>();
  for (let k = 0; k < noteQueue.length; k++) {
    const label = noteQueue[k];
    const warnings: string[] = [];
    const noteBody = parseMd(footnoteDefs.get(label)!, warnings, frontmatter.breaks ?? false, undefined, linkDefinitionsOf.get(tokens),
      unformattedNotes.get(label), true);
    applyCustomStyleSentinels(noteBody, warnings);
    parsedNotes.set(label, { tokens: noteBody, warnings });
    for (const item of reachedIn(noteBody)) {
      if ('label' in item && footnoteDefs.has(item.label) && !queuedNotes.has(item.label)) {
        queuedNotes.add(item.label);
        noteQueue.push(item.label);
      }
    }
  }
  const commentBodyIds = commentBodyIdsIn(tokens);
  for (const { tokens: noteBody } of parsedNotes.values()) commentBodyIdsIn(noteBody, commentBodyIds);
  state.commentBodyIds = commentBodyIds;

  // A body whose range is in a note waits for the notes' ranges, which
  // register after the body is written, so that the body's IDs, and the
  // changes', stay as they are
  state.deferredCommentBodies = [];
  const documentXml = generateDocumentXml(tokens, state, resolvedOptions, bibEntries, citeprocEngine, frontmatter);

  // Build footnote/endnote body OOXML from definitions.
  // Set inNoteBody so hyperlinks/images route to note-scoped relationship maps
  // (footnotes.xml has its own .rels file, separate from document.xml.rels).
  state.inNoteBody = true;
  for (const { tokens: noteBody } of parsedNotes.values()) prescanCommentIds(noteBody, state);
  // The bodies the body holds of the notes' ranges, which the notes' range
  // markers then write the replies' ranges beside
  const deferredBodies = state.deferredCommentBodies;
  state.deferredCommentBodies = undefined;
  for (const run of deferredBodies) addIdCommentBody(run, state);
  const madeNotes = new Set<string>();
  // The notes without a bookmark, which a later note can cross-reference
  const unmarkedNotes: { label: string; noteId: number; entry: { id: number; bodyXml: string }; selfRefRun: string }[] = [];
  for (const label of noteQueue) {
    // One whose references write none, which gives no ID, isn't made
    const noteId = state.footnoteLabelToId.get(label);
    if (noteId === undefined) continue;
    madeNotes.add(label);
    const { tokens: bodyTokens, warnings: parseWarnings } = parsedNotes.get(label)!;
    pushAll(state.warnings, parseWarnings);
    const noteWarnings = new Set(bodyTokens.map(t => isEmptyCodeBlock(t) ? EMPTY_NOTE_CODE_WARNING
      : isOrientationDirective(t) || isOrphanedOrientationClose(t) ? NOTE_ORIENTATION_WARNING : NOTE_BLOCK_WARNINGS[t.type]));
    for (const warning of noteWarnings) {
      if (warning) state.warnings.push(warning + ' (not supported). Move it outside the note for round-trip fidelity.');
    }
    const noteTokens = bodyTokens.flatMap((t): MdToken[] => {
      if (t.type === 'hr' || isEmptyCodeBlock(t) || isOrientationDirective(t)) return [];
      // An alert's text starts after the line end that follows its marker,
      // and an empty list item, heading or alert is no paragraph, which
      // import would drop
      const start = t.alertLead ? t.runs.findIndex(run => run.type !== 'softbreak') : 0;
      if (start === -1 || (t.type === 'list_item' || t.type === 'heading' || t.type === 'blockquote') && t.runs.length === 0) return [];
      return [start > 0 ? { ...t, runs: t.runs.slice(start) } : t];
    });
    // Generate paragraph OOXML for the note body
    const selfRefTag = state.notesMode === 'endnotes' ? 'w:endnoteRef' : 'w:footnoteRef';
    const pStyle = state.notesMode === 'endnotes' ? 'EndnoteText' : 'FootnoteText';
    const refStyle = state.notesMode === 'endnotes' ? 'EndnoteReference' : 'FootnoteReference';
    // The note's key on import, which counts the tables alike in it
    const tableScope = (state.notesMode === 'endnotes' ? 'endnote' : 'footnote') + ':' + noteId;
    const firstCodeBlock = state.codeBlockIndex;
    let bodyXml = '';
    const paragraphPPr = '<w:pPr><w:pStyle w:val="' + pStyle + '"/></w:pPr>';
    // If this footnote is cross-referenced, wrap the self-ref run in a bookmark
    // so NOTEREF fields in the document body can point to it.
    const unmarkedSelfRefRun = '<w:r><w:rPr><w:rStyle w:val="' + refStyle + '"/></w:rPr><' + selfRefTag + '/></w:r>';
    const marked = state.footnoteCrossRefLabels.has(label);
    const selfRefRun = marked ? bookmarkedSelfRef(unmarkedSelfRefRun, noteId, state) : unmarkedSelfRefRun;
    const savedCustomStyle = state.activeCustomStyle;
    // Its images and tables fit the page it's on: a footnote's, its owning
    // reference's, and an endnote's, at the document's end, the last
    // section's. Endnotes go at each section's end only where the document's
    // settings say so, w:endnotePr's w:pos, which a section's properties
    // can't (ECMA-376 Part 1 §17.11.22: there "it shall be ignored"), and
    // export's settings (see settingsXml) don't, whatever the template's do
    state.noteSectionLandscape = (state.notesMode === 'endnotes' ? undefined : state.noteLandscape?.get(label)) ?? !!state.lastSectionLandscape;
    let isFirstContent = true;
    let afterCodeBlock = false;
    for (let ti = 0; ti < noteTokens.length; ti++) {
      const t = noteTokens[ti];
      // Handle custom style sentinels inside footnotes
      if (t.customStyleOpen) { state.activeCustomStyle = t.customStyleOpen; continue; }
      if (t.customStyleClose) { state.activeCustomStyle = undefined; continue; }
      // As in the body, a paragraph of comment bodies only registers them. A
      // note writes a quote as plain paragraphs, so a quoted one does too.
      if ((t.type === 'paragraph' || t.type === 'blockquote') && holdsOnlyCommentBodies(t)) {
        generateRuns(withoutCommentBodyLines(t.runs), state, options, bibEntries, citeprocEngine);
        continue;
      }
      const stylePPr = (t.type === 'paragraph' && state.activeCustomStyle)
        ? '<w:pPr><w:pStyle w:val="' + customStyleId(state.activeCustomStyle) + '"/></w:pPr>'
        : paragraphPPr;
      // Note paragraphs are all FootnoteText, so a heading's whole-heading mark doesn't apply
      const effectivePPr = t.type === 'heading' ? stylePPr : withParagraphMarkRevision(stylePPr, paragraphMarkRevision(t, state, options));
      // A code block is code paragraphs, as in the body, which take the
      // note's mark no more than a table does, and after one before it, an
      // empty paragraph, which import ends the one before at
      if (t.type === 'code_block') {
        if (isFirstContent) bodyXml += '<w:p>' + paragraphPPr + selfRefRun + '</w:p>';
        else if (afterCodeBlock) bodyXml += '<w:p>' + paragraphPPr + '</w:p>';
        isFirstContent = false;
        bodyXml += generateParagraph(t, state, options, bibEntries, citeprocEngine);
        afterCodeBlock = true;
        continue;
      }
      afterCodeBlock = false;
      if (isFirstContent) {
        isFirstContent = false;
        if (t.type === 'table') {
          recordTableMetadata(t, state);
          bodyXml += '<w:p>' + paragraphPPr + selfRefRun + '</w:p>';
          const xml = generateTable(t, state, options, bibEntries, citeprocEngine);
          recordTableIdentity(t, xml, state, tableScope);
          bodyXml += xml;
          if (t.embedIdx !== undefined && t.embedIdx < state.embedDirectives.length) {
            state.embedDirectiveMap.set(state.tableIndex, t.embedIdx + '\t' + state.embedDirectives[t.embedIdx]);
          }
          state.tableIndex++;
        } else {
          const firstRuns = withoutCommentBodyLines(t.runs);
          const runs = generateRuns(firstRuns, state, options, bibEntries, citeprocEngine);
          // A space after the note's mark, as Word puts one there, which
          // import takes off (see parseNoteBody), so the note's text, and
          // whitespace it starts with, comes after it as in Word's own notes
          const separator = '<w:r><w:t xml:space="preserve"> </w:t></w:r>';
          bodyXml += '<w:p>' + effectivePPr + selfRefRun + separator + runs + '</w:p>';
        }
      } else {
        if (t.type === 'table') {
          recordTableMetadata(t, state);
          // And after a table, an empty paragraph, as in the body
          if (bodyXml.endsWith('</w:tbl>')) bodyXml += '<w:p>' + paragraphPPr + '</w:p>';
          const xml = generateTable(t, state, options, bibEntries, citeprocEngine);
          recordTableIdentity(t, xml, state, tableScope);
          bodyXml += xml;
          if (t.embedIdx !== undefined && t.embedIdx < state.embedDirectives.length) {
            state.embedDirectiveMap.set(state.tableIndex, t.embedIdx + '\t' + state.embedDirectives[t.embedIdx]);
          }
          state.tableIndex++;
        } else {
          const runs = generateRuns(withoutCommentBodyLines(t.runs), state, options, bibEntries, citeprocEngine);
          bodyXml += '<w:p>' + effectivePPr + runs + '</w:p>';
        }
      }
    }
    state.activeCustomStyle = savedCustomStyle;
    if (state.codeBlockIndex > firstCodeBlock) state.noteCodeBlockStarts.set(tableScope, firstCodeBlock);
    if (noteTokens.length === 0 || isFirstContent) {
      // No content tokens (empty body or all sentinels) — emit self-ref paragraph
      if (!bodyXml) bodyXml = '<w:p>' + paragraphPPr + selfRefRun + '</w:p>';
    }
    const entry = { id: noteId, bodyXml };
    state.footnoteEntries.push(entry);
    if (!marked) unmarkedNotes.push({ label, noteId, entry, selfRefRun });
  }
  state.noteSectionLandscape = undefined;
  for (const label of footnoteDefs.keys()) {
    if (!madeNotes.has(label)) state.warnings.push(`Footnote definition [^${label}] has no matching reference in the document.`);
  }
  // A note made before a later one cross-referenced it, as the order can
  // put it, takes its bookmark now, which the reference points to
  for (const { label, noteId, entry, selfRefRun } of unmarkedNotes) {
    if (state.footnoteCrossRefLabels.has(label)) entry.bodyXml = entry.bodyXml.replace(selfRefRun, () => bookmarkedSelfRef(selfRefRun, noteId, state));
  }
  // A reference again to a note in a note shows the note's number, as one
  // in the body does
  for (const entry of state.footnoteEntries) entry.bodyXml = withNoteNumbers(entry.bodyXml, state.noteNumbers ?? new Map(), state.noteNumbering ?? noteNumberingOf(state));
  state.inNoteBody = false;

  // Each cross-reference's field, to its caption, now that the captions
  // are known, and the tables' identities, with the fields in them
  const documentXmlWithRefs = withCrossRefs(documentXml, state);
  for (const entry of state.footnoteEntries) entry.bodyXml = withCrossRefs(entry.bodyXml, state);
  settleTableIdentities(state, xml => withCrossRefs(xml, state));
  settleQuoteStarts(state, xml => withCrossRefs(xml, state));
  crossRefWarnings(state);

  // Warn for orphaned references (use footnoteLabelToId, not the pre-body-processing
  // snapshot, so cross-references allocated during footnote body generation are covered)
  for (const [label] of state.footnoteLabelToId) {
    if (!footnoteDefs.has(label)) {
      state.warnings.push(`Footnote reference [^${label}] has no matching definition.`);
    }
  }

  // Word gets the comments' part where it gets a comment, which a range
  // whose ID has no body doesn't give it (see prescanCommentIds)
  state.hasComments = state.comments.length > 0;
  const hasCommentsExtended = state.hasComments && state.comments.some(c => c.parentParaId);
  const hasThreadedComments = hasCommentsExtended;
  const hasCommentsIds = hasThreadedComments;
  const hasCommentsExtensible = hasThreadedComments;
  const hasPeople = hasThreadedComments;
  // Word requires both footnotes.xml and endnotes.xml whenever either is present.
  const hasNotes = state.hasFootnotes || state.hasEndnotes;

  // The template's numbering goes with its headers and footers, whose
  // lists, directly or through their styles, can use it, though the
  // Markdown has no list
  const hasNumbering = state.hasList || !!(templateParts?.has('word/numbering.xml') && templateSections?.references);

  // Dirty-flag invariant #6: rIds must be sequential with no gaps.
  // rIdOffset reserved max slots for optional rels; now that all hasX flags are known,
  // compute actual fixed count and remap dynamic rIds to close any gap.
  const actualFixedCount = templateRelCount + 1 /* styles */ +
    (hasNumbering ? 1 : 0) +
    (state.hasComments ? 1 : 0) +
    (hasNotes ? 2 : 0) /* both footnotes + endnotes always included together */ +
    (hasCommentsExtended ? 1 : 0) +
    (hasCommentsIds ? 1 : 0) +
    (hasCommentsExtensible ? 1 : 0) +
    (hasPeople ? 1 : 0) +
    (hasTheme ? 1 : 0) +
    3 /* settings + webSettings + fontTable */;

  // A range whose comment no body writes writes no markers, nor do its
  // replies', which Word would hold with no comment, only the warning below
  const commentsWritten = new Set(state.comments.map(comment => comment.id));
  const unwritten = new Set<number>();
  for (const id of state.commentIdMap.values()) if (!commentsWritten.has(id)) unwritten.add(id);
  for (const { replyId } of state.replyRanges) if (!commentsWritten.has(replyId)) unwritten.add(replyId);
  for (const entry of state.footnoteEntries) entry.bodyXml = withoutCommentMarkers(entry.bodyXml, unwritten);
  let finalDocumentXml = withoutCommentMarkers(documentXmlWithRefs, unwritten);
  if (actualFixedCount < state.rIdOffset) {
    const shift = state.rIdOffset - actualFixedCount;
    // Remap dynamic rId references in XML attribute contexts only
    const rIdAttrRe = /(?<=r:id="|r:embed="|r:link=")rId(\d+)/g;
    const remapRId = (match: string, numStr: string) => {
      const n = parseInt(numStr, 10);
      return n > state.rIdOffset ? 'rId' + (n - shift) : match;
    };
    finalDocumentXml = finalDocumentXml.replace(rIdAttrRe, remapRId);
    // Note: footnote/endnote body rIds are in a separate namespace (footnotes.xml.rels)
    // and do not need remapping here.
    // Remap relationship maps
    for (const [url, relId] of state.relationships) {
      const m = relId.match(/^rId(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > state.rIdOffset) state.relationships.set(url, 'rId' + (n - shift));
      }
    }
    for (const [key, entry] of state.imageRelationships) {
      const m = entry.rId.match(/^rId(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > state.rIdOffset) state.imageRelationships.set(key, { ...entry, rId: 'rId' + (n - shift) });
      }
    }
    // Remap rId keys in imageFormats (used for MANUSCRIPT_IMAGE_FORMATS_ custom property)
    const remappedFormats = new Map<string, string>();
    for (const [rId, syntax] of state.imageFormats) {
      const m = rId.match(/^rId(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        remappedFormats.set(n > state.rIdOffset ? 'rId' + (n - shift) : rId, syntax);
      } else {
        remappedFormats.set(rId, syntax);
      }
    }
    state.imageFormats = remappedFormats;
    state.rIdOffset = actualFixedCount;
  }

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('word/document.xml', withTemplateStyleIds(injectParaIds(finalDocumentXml, state), templateIds));

  // Use template styles if available, otherwise default; apply font/color overrides when present
  if (templateParts?.has('word/styles.xml') && fontOverrides) {
    const withFonts = templateWithFontOverrides(
      templateParts.get('word/styles.xml')!,
      fontOverrides,
      frontmatter.styles
    );
    let mutated = applyLineSpacingToTemplate(withFonts.xml, frontmatter.lineSpacing, state.indentMode, frontmatter.bibliographyHangingIndent);
    mutated = applyAlertColorsToTemplate(mutated, effectiveColors);
    // The styles export adds to the template's are based on its Normal. A
    // size given a heading or the title goes where its base gives the same,
    // last, against the styles as Word reads them, with all export adds, as
    // a custom style the frontmatter defines or the Bibliography, which a
    // heading may be based on (dirty-flag invariant #5)
    mutated = withoutInheritedSizes(ensureManuscriptStyles(mutated), withFonts.sizedStyleIds, withFonts.ids);
    if (state.figureNumber + state.tableNumber > 0) mutated = withCaptionStyle(mutated, templateIds);
    zip.file('word/styles.xml', withTemplateStyleIds(mutated, templateIds));
  } else if (templateParts?.has('word/styles.xml')) {
    let decoded = asUtf8(decodeXml(templateParts.get('word/styles.xml')!));
    decoded = applyLineSpacingToTemplate(decoded, frontmatter.lineSpacing, state.indentMode, frontmatter.bibliographyHangingIndent);
    decoded = ensureManuscriptStyles(applyAlertColorsToTemplate(decoded, effectiveColors));
    if (state.figureNumber + state.tableNumber > 0) decoded = withCaptionStyle(decoded, templateIds);
    zip.file('word/styles.xml', withTemplateStyleIds(decoded, templateIds));
  } else {
    const styles = stylesXml(fontOverrides, codeBlockConfig, effectiveColors, frontmatter.styles, frontmatter.lineSpacing, state.indentMode, frontmatter.bibliographyHangingIndent);
    zip.file('word/styles.xml', state.figureNumber + state.tableNumber > 0 ? withCaptionStyle(styles, new Map()) : styles);
  }

  // Always use generated settings.xml to guarantee compatibilityMode >= 15
  // (template settings.xml may have compatibilityMode < 15, causing "unreadable content" errors)
  zip.file('word/settings.xml', settingsXml(state.rsid, hasNotes, hasNotes, hasThreadedComments, templateSections?.evenAndOddHeaders));
  zip.file('word/webSettings.xml', webSettingsXml());

  // Always include fontTable.xml
  zip.file('word/fontTable.xml', fontTableXml());

  // Handle numbering - use template as base but ensure bullet/decimal definitions exist.
  // Export's bullets and numbers join a template's numbering where it has
  // none in their format (see listNumIds), and start overrides join it as
  // instances of the abstract numbering numbers take. Only a template
  // without numbering, or with numbering that doesn't parse, gets fresh
  // numbering.
  let numberingFromTemplate = false;
  if (hasNumbering) {
    const used = templateNumbering !== undefined ? withoutUnusedNums(templateNumbering,
      new Set([...numIdsInUse, listNumbering.bullet, listNumbering.decimal])) : undefined;
    const complete = used !== undefined ? (state.hasList ? withOwnNums(used, listNumbering.own) : used) : undefined;
    const numbering = complete !== undefined
      ? (state.listStartOverrides.length === 0 ? complete : withNumberingOverrides(complete, state.listStartOverrides, listNumbering.decimal))
      : undefined;
    numberingFromTemplate = !!numbering;
    zip.file('word/numbering.xml', numbering ? asUtf8(numbering) : numberingXml(state.listStartOverrides));
  }

  // Include theme: template theme if available, otherwise default
  if (templateParts?.has('word/theme/theme1.xml')) {
    zip.file('word/theme/theme1.xml', templateParts.get('word/theme/theme1.xml')!);
  } else {
    zip.file('word/theme/theme1.xml', defaultThemeXml());
  }

  if (state.hasComments) {
    zip.file('word/comments.xml', withTemplateStyleIds(commentsXml(state.comments), templateIds));
    if (hasCommentsExtended) {
      zip.file('word/commentsExtended.xml', commentsExtendedXml(state.comments));
    }
    if (hasCommentsIds) {
      zip.file('word/commentsIds.xml', commentsIdsXml(state.comments));
    }
    if (hasCommentsExtensible) {
      zip.file('word/commentsExtensible.xml', commentsExtensibleXml(state.comments));
    }
    if (hasPeople) {
      zip.file('word/people.xml', peopleXml(state.comments));
    }
  }

  // Sort footnote entries by ID — definitions may appear in a different order than
  // references in the document body, but Word requires ascending ID order.
  state.footnoteEntries.sort((a, b) => a.id - b.id);

  if (hasNotes) {
    zip.file('word/footnotes.xml', withTemplateStyleIds(injectParaIds(footnotesXml(
      state.hasFootnotes ? state.footnoteEntries : []), state), templateIds));
    zip.file('word/endnotes.xml', withTemplateStyleIds(injectParaIds(endnotesXml(
      state.hasEndnotes ? state.footnoteEntries : []), state), templateIds));
  }

  // Generate footnotes/endnotes .rels file for hyperlinks/images scoped to the notes part
  if (hasNotes && (state.noteRelationships.size > 0 || state.noteImageRelationships.size > 0)) {
    const noteRelsTarget = state.notesMode === 'endnotes' ? 'word/_rels/endnotes.xml.rels' : 'word/_rels/footnotes.xml.rels';
    zip.file(noteRelsTarget, noteRelsXml(state.noteRelationships, state.noteImageRelationships));
  }

  // Document properties
  zip.file('docProps/core.xml', corePropsXml(frontmatter.author));
  zip.file('docProps/app.xml', appPropsXml());

  // The custom properties, from the records export has. Where it reads its
  // document back for the records of its lists (see listItemsRead), which
  // only the finished document gives, it builds them again after, with
  // those (see below), so it writes custom.xml in its place here even with
  // none yet
  const customPropsOf = (): CustomPropEntry[] => {
    const customProps: CustomPropEntry[] = [];
    if (frontmatter.csl) {
      pushAll(customProps, zoteroCustomProps(frontmatter));
    }
    pushAll(customProps, defaultCslProps(defaultCsl));
    pushAll(customProps, commentIdMappingProps(state.commentIdMap));
    // The labels of captions their bookmarks' names don't give (see captionXml)
    if (state.captionLabels.size > 0) pushAll(customProps, chunkCustomProps('MANUSCRIPT_CAPTION_LABELS_', JSON.stringify(Object.fromEntries(state.captionLabels))));
    // Where the figures' captions went, which import can't always tell, as
    // where a plain picture is next to a figure's (see readCaptions)
    if (state.figureNumber > 0) customProps.push({ name: 'MANUSCRIPT_FIG_CAP_LOCATION', value: state.captions.figCapLocation });
    if (state.tableNumber > 0) customProps.push({ name: 'MANUSCRIPT_TBL_CAP_LOCATION', value: state.captions.tblCapLocation });
    pushAll(customProps, footnoteIdMappingProps(state.footnoteLabelToId, !!state.trackedNoteReference));
    pushAll(customProps, footnoteCrossRefProps(state.footnoteCrossRefLabels, state.footnoteLabelToId, state.notesMode));
    pushAll(customProps, codeBlockLanguageProps(state.codeBlockLanguages));
    pushAll(customProps, noteCodeBlockProps(state.noteCodeBlockStarts));
    pushAll(customProps, codeBlockStylingProps(frontmatter));
    pushAll(customProps, pipeTableMaxLineWidthProps(frontmatter));
    pushAll(customProps, gridTableMaxLineWidthProps(frontmatter));
    pushAll(customProps, lineSpacingProps(frontmatter));
    pushAll(customProps, paragraphIndentProps(frontmatter));
    pushAll(customProps, bibliographyHangingIndentProps(frontmatter));
    pushAll(customProps, indentOverrideProps(state.indentOverrides));
    pushAll(customProps, listIndentOverrideProps(state.listIndentOverrides));
    pushAll(customProps, listItemIndentOverrideProps(state.listItemIndentOverrides));
    pushAll(customProps, listBlankLineProps(state.listBlankLines));
    pushAll(customProps, blockquoteGapProps(state.blockquoteGaps));
    pushAll(customProps, blockquotePreContentBlankLineProps(state.blockquotePreContentBlankLines));
    pushAll(customProps, blockquotePostContentBlankLineProps(state.blockquotePostContentBlankLines));
    pushAll(customProps, blockquoteAlertMarkerStyleProps(state.blockquoteAlertMarkerInlineByGroup));
    pushAll(customProps, blockquoteListLevelProps(state.blockquotePlaces, state.blockquoteIdentities));
    // Word shows the label's paragraph of an alert whose marker is one of its
    // own, and with the label hidden, has none
    const alertAlone = !effectiveCalloutLabels ? blockquoteSpacing.alertAlone : new Map<number, boolean>();
    pushAll(customProps, blockquoteAlertMarkerAloneProps(alertAlone));
    // Which group each of those records by index is
    if ([state.blockquoteGaps, state.blockquotePreContentBlankLines, state.blockquotePostContentBlankLines, state.blockquoteAlertMarkerInlineByGroup, alertAlone].some(records => records.size > 0)) {
      pushAll(customProps, blockquoteIdentityProps(state.blockquoteIdentities));
    }
    if (explicitCalloutLabels !== undefined) {
      customProps.push({ name: 'MANUSCRIPT_CALLOUT_LABELS', value: String(explicitCalloutLabels) });
    }
    pushAll(customProps, imageFormatProps(state.imageFormats));
    pushAll(customProps, noteImageFormatProps(state.noteImageFormats));
    pushAll(customProps, tableFormatProps(state.tableFormats));
    if (state.tableIdentities.length > 0) pushAll(customProps, chunkCustomProps('MANUSCRIPT_TABLE_IDENTITIES_', JSON.stringify(state.tableIdentities)));
    if (state.tableHtmlAround.size > 0) {
      // The count of tables alike export wrote in all, which is known only now
      for (const around of state.tableHtmlAround.values()) around[6] = String(state.tablesAlike.get(around[5] + '\n' + around[2] + '\n' + around[3]) ?? 0);
      pushAll(customProps, chunkCustomProps('MANUSCRIPT_TABLE_HTML_AROUND_', JSON.stringify(Object.fromEntries(state.tableHtmlAround))));
    }
    pushAll(customProps, pipeTableAlignedProps(state.pipeTableAligned));
    pushAll(customProps, gridSourceColWidthsProps(state.gridSourceColWidths));
    pushAll(customProps, tableFontSizeProps(state.tableFontSizes));
    pushAll(customProps, tableFontProps(state.tableFonts));
    pushAll(customProps, tableColWidthsProps(state.tableColWidths));
    const defaultColWidthsStr = fontOverrides?.tableColWidths
      ? (typeof fontOverrides.tableColWidths === 'string' ? fontOverrides.tableColWidths : fontOverrides.tableColWidths.join(' '))
      : undefined;
    pushAll(customProps, tableNumberFormatProps('MANUSCRIPT_TABLE_DIGITS_', state.tableDigits));
    pushAll(customProps, tableNumberFormatProps('MANUSCRIPT_TABLE_DECIMAL_MARKS_', state.tableDecimalMarks));
    pushAll(customProps, tableNumberFormatProps('MANUSCRIPT_TABLE_DIGIT_GROUPINGS_', state.tableDigitGroupings));
    if (frontmatter.tableColWidths) {
      customProps.push({ name: 'MANUSCRIPT_DEFAULT_TABLE_COL_WIDTHS', value: defaultColWidthsStr! });
    }
    pushAll(customProps, embedDirectiveProps(state.embedDirectiveMap));
    pushAll(customProps, landscapeTableProps(state.landscapeTables));
    pushAll(customProps, portraitTableProps(state.portraitTables));
    pushAll(customProps, portraitBreakProps(state.portraitBreakOrdinals));
    pushAll(customProps, referencesBeforeSectionsProps(state.referencesBeforeSections));
    pushAll(customProps, hiddenOutsideSectionsProps('MANUSCRIPT_HIDDEN_BEFORE_SECTIONS_', state.hiddenBeforeSections));
    pushAll(customProps, hiddenOutsideSectionsProps('MANUSCRIPT_HIDDEN_AFTER_SECTIONS_', state.hiddenAfterSections));
    if (state.templatePageSection !== undefined) {
      pushAll(customProps, chunkCustomProps('MANUSCRIPT_TEMPLATE_PAGE_SECTIONS_', JSON.stringify([state.templatePageSection])));
    }
    if (state.templateLayout?.length) pushAll(customProps, chunkCustomProps(TEMPLATE_LAYOUT_PROPERTY, JSON.stringify(state.templateLayout)));
    pushAll(customProps, listIndentProps(state));
    pushAll(customProps, consecutiveReplyProps(state));
    pushAll(customProps, htmlCommentGapProps(state.htmlCommentGaps));
    pushAll(customProps, htmlCommentAfterGapProps(state.htmlCommentAfterGaps));
    if (Object.keys(state.sentinelGaps).length > 0) {
      pushAll(customProps, chunkCustomProps('MANUSCRIPT_SENTINEL_GAPS_', JSON.stringify(state.sentinelGaps)));
    }
    if (Object.keys(state.styleBlockEdges).length > 0) {
      pushAll(customProps, chunkCustomProps('MANUSCRIPT_STYLE_BLOCK_EDGES_', JSON.stringify(state.styleBlockEdges)));
    }
    if (frontmatter.tableFontSize !== undefined) {
      customProps.push({ name: 'MANUSCRIPT_EXPLICIT_TABLE_FONT_SIZE', value: '1' });
    }
    if (frontmatter.tableBorders) {
      customProps.push({ name: 'MANUSCRIPT_TABLE_BORDERS', value: frontmatter.tableBorders });
    }
    if (frontmatter.tableDigits !== undefined) customProps.push({ name: 'MANUSCRIPT_DEFAULT_TABLE_DIGITS', value: String(frontmatter.tableDigits) });
    if (frontmatter.tableDecimalMark) customProps.push({ name: 'MANUSCRIPT_DEFAULT_TABLE_DECIMAL_MARK', value: frontmatter.tableDecimalMark });
    if (frontmatter.tableDigitGrouping) customProps.push({ name: 'MANUSCRIPT_DEFAULT_TABLE_DIGIT_GROUPING', value: frontmatter.tableDigitGrouping });
    if (frontmatter.styles && Object.keys(frontmatter.styles).length > 0) {
      pushAll(customProps, chunkCustomProps('MANUSCRIPT_CUSTOM_STYLES_', JSON.stringify(frontmatter.styles)));
    }
    pushAll(customProps, frontmatterBlankLineProps(frontmatterBlankLines));
    pushAll(customProps, frontmatterSettingsProps(frontmatter));
    pushAll(customProps, frontmatterFieldOrderProps(fieldOrder));
    pushAll(customProps, frontmatterLayoutProps(unusedFrontmatter));
    pushAll(customProps, bibKeyOrderProps(bibEntries));
    pushAll(customProps, bibDataProps(options?.bibtex));
    pushAll(customProps, bibliographyPathProps(frontmatter));
    // The template's properties its copied headers' and footers' fields show,
    // after export's own, which keep their pids
    const ownProps = new Set(customProps.map(p => p.name.toLowerCase()));
    pushAll(customProps, (templateSections?.customProperties ?? []).filter(p => !ownProps.has(p.name.toLowerCase())));
    return customProps;
  };
  const customProps = customPropsOf();
  const readsBack = state.listItemsRead.length > 0;
  const hasCustomProps = customProps.length > 0;
  if (hasCustomProps || readsBack) {
    zip.file('docProps/custom.xml', customPropsXml(customProps));
  }

  // Store image binaries in word/media/
  for (const [mediaPath, data] of state.imageBinaries) {
    zip.file('word/' + mediaPath, data);
  }

  // The template's headers and footers, after the parts export writes,
  // whose names they then don't take
  const extensionTypes = new Map<string, string>([['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']]);
  for (const ext of state.imageExtensions) {
    const ct = getImageContentType(ext);
    if (ct) extensionTypes.set(ext.toLowerCase(), ct);
  }
  const templateCopy = templateSections && addTemplateSectionParts(zip, templateSections, state.nextImageDocPrId, extensionTypes, numberingFromTemplate);

  // The parts that say whether the package has custom properties, which
  // the read-back below can change
  const writePackageParts = (withCustomProps: boolean) => {
    zip.file('[Content_Types].xml', contentTypesXml({
      hasList: hasNumbering,
      hasComments: state.hasComments,
      hasTheme,
      hasCustomProps: withCustomProps,
      hasFootnotes: hasNotes,
      hasEndnotes: hasNotes,
      hasCommentsExtended,
      hasCommentsIds,
      hasCommentsExtensible,
      hasPeople,
      imageExtensions: state.imageExtensions.size > 0 ? state.imageExtensions : undefined,
      templateDefaults: templateCopy?.defaults,
      templateOverrides: templateCopy?.overrides,
    }));
    zip.file('_rels/.rels', relsXml(withCustomProps));
  };
  writePackageParts(hasCustomProps);
  zip.file('word/_rels/document.xml.rels', documentRelsXml({
    relationships: state.relationships,
    hasList: hasNumbering,
    hasComments: state.hasComments,
    hasTheme,
    hasFootnotes: hasNotes,
    hasEndnotes: hasNotes,
    hasCommentsExtended,
    hasCommentsIds,
    hasCommentsExtensible,
    hasPeople,
    imageRelationships: state.imageRelationships.size > 0 ? state.imageRelationships : undefined,
    templateRelationships: templateCopy?.relationships,
  }));

  // Check for comment range markers without corresponding bodies
  for (const [mdId, numericId] of state.commentIdMap) {
    if (mdId.startsWith('#')) {
      // A caption's label no image took (see commentRangeRule)
      state.warnings.push('The label {' + mdId + '} labels no ' + (mdId.startsWith('#fig-')
        ? 'figure: a label goes right after an image alone in its paragraph, as ![Caption](map.png){' + mdId + '}'
        : 'table: a label ends a paragraph right after a table at the top level that starts with a colon, as : Caption {' + mdId + '}') + '. Word gets no label there.');
    } else if (!hasCommentWithId(state.comments, numericId)) {
      state.warnings.push(`Comment range markers {#${mdId}}...{/${mdId}} exist without corresponding body {#${mdId}>>...<<}`);
    }
  }

  const removed = await removeCharactersXmlCantHold(zip);
  // The list blocks import reads where a template's styles number
  // paragraphs, from the finished document, as convertDocx reads it (see
  // listPlacesOf), and the records of the lists by them. The custom
  // properties, with them, go in custom.xml again, in its place, as one
  // write of them all gives it, or it goes where there are none, and the
  // parts that say whether there are any are written again where that
  // changes
  if (readsBack) {
    recordListItemsRead(state, state.listItemsRead, await listPlacesOf(zip, new Set(state.listItemsRead.map(item => item.paraId))));
    const finalProps = customPropsOf();
    const rewritten: string[] = [];
    if (finalProps.length > 0) {
      zip.file('docProps/custom.xml', customPropsXml(finalProps));
      rewritten.push('docProps/custom.xml');
    } else {
      zip.remove('docProps/custom.xml');
    }
    if (finalProps.length > 0 !== hasCustomProps) {
      writePackageParts(finalProps.length > 0);
      rewritten.push('[Content_Types].xml', '_rels/.rels');
    }
    // Their characters XML can't hold were counted above, as the records of
    // the lists add none
    await removeCharactersXmlCantHold(zip, rewritten);
  }
  if (removed > 0) {
    state.warnings.push('Removed ' + removed + ' character' + (removed === 1 ? '' : 's') + ' a Word document can\'t hold, such as control characters');
  }

  // Remove directory entries — Word marks files with explicit folder entries as modified on open.
  // Cannot use zip.remove() as it also removes children; instead delete from the files map directly.
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path]?.dir) delete (zip.files as Record<string, unknown>)[path];
  }
  // DEFLATE compression prevents Word from marking the file as modified on open.
  // Word re-compresses STORE-d (uncompressed) entries and sets the dirty flag.
  const docx = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { docx, warnings: [...new Set(state.warnings)] };
}
