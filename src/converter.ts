import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { asXmlNodes, ommlToLatex, type XmlNode } from './omml';
import { resolveMarkdownColor } from './highlight-colors';
import { Frontmatter, NotesMode, serializeFrontmatter, noteTypeFromNumber, parseColWidths, type CustomStyleDef } from './frontmatter';
import { gfmAlertTitle, parseGfmAlertMarker, toGfmAlertMarker, type GfmAlertType } from './gfm';
import { emuToPixels, isSupportedImageFormat, resolveImageFilename } from './image-utils';
import { parseBibtex, parseBibtexWithRaw, mergeBibtex } from './bibtex-parser';
import { customStyleId } from './md-to-docx';
import { parseTableDigits, parseTableDecimalMark, parseTableDigitGrouping } from './table-number-format';
import { publicStyleNameForZoteroId, zoteroStyleIdForName } from './csl-loader';

// --- Implementation notes ---
// Table parsing:
// - Handle pipes in code/quotes; careful boundary detection
// - Prefer HTML table output; preserve in-cell semantics
// - Table HTML with ID comments: emit deferred bodies outside <p> tags
//
// Commented text:
// - Group adjacent runs by identical commentIds even when formatting differs
// - Comment ID remap: collect IDs from top-level and nested table-cell paragraphs
// - Cross-paragraph overlap detection: global via detectGlobalOverlaps() during
//   buildMarkdown metadata collection, not per-segment
// - Non-numeric comment ID roundtrip: persist mapping in docProps/custom.xml under
//   MANUSCRIPT_COMMENT_IDS[_N]
//
// Run formatting:
// - Apply w:pPr/w:rPr defaults; only override for explicit run-level w:rPr
//
// Hyperlinks:
// - Wrap URLs with parens, whitespace, [, or ] in angle brackets
//
// Zotero:
// - URI key extraction: /\/items\/([A-Z0-9]{8})$/ works for all three URI formats
// - citationItems: check both uris (array) and uri (singular)
// - Locators: belong in Pandoc citations ([@key, p. 20]), not BibTeX entries
// - Numeric locators: coerce to string with String() during extraction
// - Grouped citations: mixed groups always produce unified output
//
// CSL:
// - Year: only set issued.date-parts when year is fully numeric; never emit [[null]]
//
// Citations:
// - buildCitationKeyMap: accepts existingKeys?: Set<string> to prevent cross-scope ambiguity
//
// Footnotes:
// - Multi-line indent: use block form when bodyParts[0] is multi-line; indent all
//   continuation lines
// - Fence detection: check for continuation lines before fence markers when currentLabel
//   is defined
// - Display math: treat item.type === 'math' && item.display as its own body part
// - stopBeforeDisplayMath: body/footnote renderInlineRange calls must pass
//   { stopBeforeDisplayMath: true }; table-cell calls (via renderInlineSegment)
//   intentionally omit this since display math doesn't split table cells

/** Matches a "Sources" heading (with or without leading `#` markers). */
const SOURCES_HEADING_RE = /^(?:#+\s*)?Sources\s*$/;

// Types

export interface Comment {
  author: string;
  text: string;
  date: string;
  paraId?: string;         // w14:paraId from <w:p> in comments.xml
  replies?: CommentReply[];
  consecutiveReplies?: boolean; // true when original MD used consecutive {>>...<<} format for replies
}
export async function extractBlockquotePreContentBlankLineMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_PRE_CONTENT_BLANK_LINES');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      // Preserve sentinel -1 (used when non-blockquote content exists between
      // groups in source) in addition to non-negative blank-line counts.
      if (isNaN(groupIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < -1) continue;
      mapping.set(groupIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}
export async function extractBlockquotePostContentBlankLineMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_POST_CONTENT_BLANK_LINES');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      if (isNaN(groupIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < -1) continue;
      mapping.set(groupIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

const ALERT_STYLE_TO_TYPE: Record<string, GfmAlertType> = {
  githubnote: 'note',
  githubtip: 'tip',
  githubimportant: 'important',
  githubwarning: 'warning',
  githubcaution: 'caution',
};

const ALERT_GLYPH_TO_TYPE: Record<string, GfmAlertType> = {
  '※': 'note',
  '◈': 'tip',
  '‼': 'important',
  '▲': 'warning',
  '⛒': 'caution',
};

export interface CommentReply {
  author: string;
  text: string;
  date: string;
}

export interface CitationMetadata {
  authors: Array<{ family?: string; given?: string; literal?: string }>;
  title: string;
  year: string;
  journal: string;
  volume: string;
  pages: string;
  doi: string;
  type: string;
  fullItemData: Record<string, unknown>;
  zoteroKey?: string;
  zoteroUri?: string;
  locator?: string;
  citationKey?: string;   // CSL citation-key preserved for round-trip
  suppressAuthor?: boolean; // [-@key] Pandoc suppress-author form
}

/** Each Zotero field in the document produces one of these. */
export interface ZoteroCitation {
  /** The plainCitation text from Zotero (e.g. "(Bearak et al. 2020)") */
  plainCitation: string;
  /** Metadata for each cited item in this field */
  items: CitationMetadata[];
}

/** Character-level formatting flags */
export interface RunFormatting {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  highlight: boolean;
  highlightColor?: string;
  superscript: boolean;
  subscript: boolean;
  code: boolean;
}

/** Returns true when any formatting flag is set (text won't survive GFM autolink). */
function hasFormatting(fmt: RunFormatting): boolean {
  return fmt.bold || fmt.italic || fmt.underline || fmt.strikethrough ||
    fmt.highlight || fmt.superscript || fmt.subscript || fmt.code;
}

/** List metadata for a paragraph */
export interface ListMeta {
  type: 'bullet' | 'ordered';
  level: number; // 0-based indentation level
  startNumber?: number; // ordered list start number (when ≠ 1)
  bulletMarker?: '-' | '*' | '+'; // authored unordered-list marker for round-trip
}

export const DEFAULT_FORMATTING: Readonly<RunFormatting> = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  highlight: false,
  superscript: false,
  subscript: false,
  code: false,
});

// Revision-bearing elements mapped to their CriticMarkup type.
// w:ins/w:moveTo → addition, w:del/w:moveFrom → deletion.
const REVISION_ELEMENTS: Record<string, 'addition' | 'deletion'> = {
  'w:ins': 'addition', 'w:del': 'deletion',
  'w:moveTo': 'addition', 'w:moveFrom': 'deletion',
};

// Tags that are interpreted semantically by the MD→DOCX parser/preview pipeline
// and therefore must be escaped when they occur as literal plain text in DOCX.
const MARKDOWN_HTML_SENSITIVE_TAGS = new Set([
  'u',
  'sup',
  'sub',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
]);

function escapeSensitiveHtmlLikeTags(text: string): string {
  return text.replace(/<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*?)?>/g, (fullMatch, tagName: string) => {
    if (!MARKDOWN_HTML_SENSITIVE_TAGS.has(tagName.toLowerCase())) return fullMatch;
    return fullMatch.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
}

/** Escape markdown-sensitive characters that would otherwise be interpreted as formatting. */
function escapeMarkdownChars(text: string): string {
  // Escape * which always triggers bold/italic in CommonMark.
  // Do NOT escape _ (only triggers emphasis in flanking contexts — blanket escaping
  // changes visible text) or ~ (rare, only triggers strikethrough with ~~).
  return text.replace(/\*/g, '\\*');
}

export type RevisionInfo = { type: 'addition' | 'deletion'; author: string; date: string };

export interface ListContinuation {
  type: 'bullet' | 'ordered';
  level: number; // 0-based parent list nesting level for Markdown rendering
  markerWidth?: number; // ordered-list marker width (e.g. "10. " => 4)
}

interface StructuralListContext {
  type: 'bullet' | 'ordered';
  level: number;
  markerWidth?: number;
}

export type ContentItem =
  | {
      type: 'text';
      text: string;
      commentIds: Set<string>;
      formatting: RunFormatting;
      href?: string;           // hyperlink URL if inside w:hyperlink
      revision?: RevisionInfo;
    }
  | { type: 'citation'; text: string; commentIds: Set<string>; pandocKeys: string[]; revision?: RevisionInfo }
  | { type: 'table'; rows: TableRow[] }
  | {
      type: 'para';
      headingLevel?: number;   // 1–6 if heading, undefined otherwise
      listMeta?: ListMeta;     // present if list item
      isTitle?: boolean;       // true if Word "Title" paragraph style
      blockquoteLevel?: number; // 1+ if Quote/IntenseQuote paragraph style
      listContinuation?: ListContinuation; // parent list context for blockquote continuation blocks
      alertType?: GfmAlertType; // present for GitHub alert styles
      isCodeBlock?: boolean;   // true if Word "Code Block" paragraph style
      blockquoteGroupIndex?: number; // sequential group index from md→docx gap metadata
      isBlockquoteSpacer?: boolean; // generated visual spacer; retained only as an import grouping boundary
      customStyleName?: string;      // user-defined custom style name (from MsCustomXxx pStyle)
      paragraphLeftIndentTwips?: number; // raw OOXML left indent for structural inference
      blockquoteIndentUnitTwips?: 240 | 720; // base indent unit for blockquote styles
      emptyParagraphCount?: number; // count of collapsed consecutive empty paragraphs
      indentOverride?: 'indent' | 'no-indent'; // per-paragraph indent override for round-trip
      paraMarkRevision?: RevisionInfo; // w:ins/w:del on the paragraph mark (pPr > rPr) — whole paragraph inserted/deleted
    }
  | { type: 'math'; latex: string; display: boolean; commentIds: Set<string>; revision?: RevisionInfo }
  | { type: 'footnote_ref'; noteId: string; noteKind: 'footnote' | 'endnote'; commentIds: Set<string>; revision?: RevisionInfo }
  | { type: 'html_comment'; text: string; commentIds: Set<string> }
  | { type: 'image'; rId: string; src: string; alt: string; widthPx: number; heightPx: number; commentIds: Set<string>; revision?: RevisionInfo }
  | { type: 'landscape_open' }
  | { type: 'landscape_close' }
  | { type: 'portrait_open' }
  | { type: 'portrait_close' }
  | { type: 'bibliography_marker' }
  | { type: 'custom_style_open'; styleName: string }
  | { type: 'custom_style_close' };
export interface FootnoteBody {
  id: string;
  content: ContentItem[];
}

/** Context for parsing rich content in footnote/endnote bodies. */
interface NoteBodyContext {
  relationshipMap: Map<string, string>;
  zoteroCitations: ZoteroCitation[];
  keyMap: Map<string, string>;
  numberingDefs: NumberingDefs;
  numberingStartOverrides?: NumberingStartOverrides;
  format: CitationKeyFormat;
}

export interface TableRow {
  isHeader: boolean;
  cells: TableCell[];
}
export interface TableCell {
  paragraphs: ContentItem[][];
  colspan?: number;
  rowspan?: number;
}

export type CitationKeyFormat = 'authorYearTitle' | 'authorYear' | 'numeric';

export interface ZoteroDocPrefs {
  styleId: string;
  locale?: string;
  noteType?: number;
}

export interface ZoteroBiblData {
  uncited?: unknown[];
  omitted?: unknown[];
  custom?: unknown[];
}

export interface ConvertResult {
  markdown: string;
  bibtex: string;
  zoteroPrefs?: ZoteroDocPrefs;
  zoteroBiblData?: ZoteroBiblData;
  images?: Map<string, Uint8Array>;
}

// XML helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value);
}

function parseCslAuthors(value: unknown): CitationMetadata['authors'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(author => {
    if (!isRecord(author)) return [];
    const parsed: CitationMetadata['authors'][number] = {};
    if (typeof author.family === 'string' && author.family.trim()) parsed.family = author.family;
    if (typeof author.given === 'string' && author.given.trim()) parsed.given = author.given;
    if (typeof author.literal === 'string' && author.literal.trim()) parsed.literal = author.literal;
    return Object.keys(parsed).length > 0 ? [parsed] : [];
  });
}

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxTotalExpansions: 10000,
    maxExpandedLength: 1000000,
  },
};

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function parseRelationships(
  zip: JSZip,
  relsPath = 'word/_rels/document.xml.rels'
): Promise<Map<string, string>> {
  const relationships = new Map<string, string>();
  const parsed = await readZipXml(zip, relsPath);
  if (!parsed) { return relationships; }

  for (const node of findAllDeep(parsed, 'Relationship')) {
    const id = getAttr(node, 'Id');
    const type = getAttr(node, 'Type');
    const target = getAttr(node, 'Target');
    const targetMode = getAttr(node, 'TargetMode');

    if (type.endsWith('/hyperlink') && targetMode === 'External') {
      relationships.set(id, target);
    }
  }

  return relationships;
}

export async function parseDocumentRelationships(
  zip: JSZip,
): Promise<{ hyperlinks: Map<string, string>; images: Map<string, string> }> {
  const hyperlinks = new Map<string, string>();
  const images = new Map<string, string>();
  const parsed = await readZipXml(zip, 'word/_rels/document.xml.rels');
  if (!parsed) return { hyperlinks, images };
  for (const node of findAllDeep(parsed, 'Relationship')) {
    const id = getAttr(node, 'Id');
    const type = getAttr(node, 'Type');
    const target = getAttr(node, 'Target');
    const targetMode = getAttr(node, 'TargetMode');
    if (type.endsWith('/hyperlink') && targetMode === 'External') {
      hyperlinks.set(id, target);
    } else if (type.endsWith('/image')) {
      images.set(id, target);
    }
  }
  return { hyperlinks, images };
}

export async function extractImageFormatMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_IMAGE_FORMATS');
}

export async function extractNoteImageFormatMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_NOTE_IMAGE_FORMATS');
}

export interface NumberingLevelDef {
  type: 'bullet' | 'ordered';
}

export type NumberingDefs = Map<string, Map<string, NumberingLevelDef>>;
export type NumberingStartOverrides = Map<string, Map<string, number>>; // numId → ilvl → start

export async function parseNumberingDefinitions(zip: JSZip): Promise<{ defs: NumberingDefs; startOverrides: NumberingStartOverrides }> {
  const numberingDefs: NumberingDefs = new Map();
  const startOverrides: NumberingStartOverrides = new Map();
  const parsed = await readZipXml(zip, 'word/numbering.xml');
  if (!parsed) { return { defs: numberingDefs, startOverrides }; }

  // Build abstractNumId → levels map
  const abstractNums = new Map<string, Map<string, NumberingLevelDef>>();
  for (const node of findAllDeep(parsed, 'w:abstractNum')) {
    const abstractNum = asXmlNodes(node['w:abstractNum']);
    if (abstractNum.length === 0) continue;

    const abstractNumId = getAttr(node, 'abstractNumId');
    const levels = new Map<string, NumberingLevelDef>();

    for (const lvlNode of findAllDeep(abstractNum, 'w:lvl')) {
      const lvl = asXmlNodes(lvlNode['w:lvl']);
      if (lvl.length === 0) continue;

      const ilvl = getAttr(lvlNode, 'ilvl');
      const numFmtNodes = findAllDeep(lvl, 'w:numFmt');
      if (numFmtNodes.length > 0) {
        const val = getAttr(numFmtNodes[0], 'val');
        if (val === 'bullet') {
          levels.set(ilvl, { type: 'bullet' });
        } else {
          levels.set(ilvl, { type: 'ordered' });
        }
      }
    }

    abstractNums.set(abstractNumId, levels);
  }

  // Resolve numId → abstractNumId, and read lvlOverride/startOverride
  for (const node of findAllDeep(parsed, 'w:num')) {
    const num = asXmlNodes(node['w:num']);
    if (num.length === 0) continue;

    const numId = getAttr(node, 'numId');
    const abstractNumIdNodes = findAllDeep(num, 'w:abstractNumId');
    if (abstractNumIdNodes.length > 0) {
      const abstractNumId = getAttr(abstractNumIdNodes[0], 'val');
      const levels = abstractNums.get(abstractNumId);
      if (levels) {
        numberingDefs.set(numId, levels);
      }
    }

    // Read w:lvlOverride → w:startOverride
    for (const lvlOverrideNode of findAllDeep(num, 'w:lvlOverride')) {
      const ilvl = getAttr(lvlOverrideNode, 'ilvl');
      const lvlOverride = asXmlNodes(lvlOverrideNode['w:lvlOverride']);
      if (lvlOverride.length === 0) continue;
      for (const startNode of findAllDeep(lvlOverride, 'w:startOverride')) {
        const startVal = parseInt(getAttr(startNode, 'val'), 10);
        if (!isNaN(startVal) && startVal !== 1) {
          if (!startOverrides.has(numId)) startOverrides.set(numId, new Map());
          startOverrides.get(numId)!.set(ilvl, startVal);
        }
      }
    }
  }

  return { defs: numberingDefs, startOverrides };
}

export function parseHeadingLevel(pPrChildren: XmlNode[]): number | undefined {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return undefined;

  const val = getAttr(pStyleElement, 'val').toLowerCase();
  const match = val.match(/^heading(\d)$/);
  if (match) {
    const level = parseInt(match[1], 10);
    return level >= 1 && level <= 6 ? level : undefined;
  }

  return undefined;
}

/** Detect a custom style (MsCustomXxx) and return the user-facing name, or undefined. */
export function parseCustomStyleName(pPrChildren: XmlNode[], knownStyles?: Record<string, CustomStyleDef>): string | undefined {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return undefined;
  const val = getAttr(pStyleElement, 'val');
  if (!val.startsWith('MsCustom')) return undefined;
  // Reverse-lookup: if we have the known styles map, find the name whose customStyleId matches
  if (knownStyles) {
    for (const name of Object.keys(knownStyles)) {
      if (customStyleId(name) === val) return name;
    }
  }
  // Fallback: derive name from PascalCase by lowering and inserting hyphens
  const suffix = val.slice('MsCustom'.length);
  return suffix.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function parseTitleStyle(pPrChildren: XmlNode[]): boolean {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return false;
  return getAttr(pStyleElement, 'val').toLowerCase() === 'title';
}

function parseParagraphLeftIndentTwips(pPrChildren: XmlNode[]): number | undefined {
  const indElement = pPrChildren.find(child => child['w:ind'] !== undefined);
  if (!indElement) return undefined;
  const left = parseInt(getAttr(indElement, 'left'), 10);
  return !isNaN(left) && left > 0 ? left : undefined;
}

function parseBlockquoteInfo(pPrChildren: XmlNode[]): { level?: number; indentUnitTwips?: 240 | 720 } {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return {};
  const val = getAttr(pStyleElement, 'val').toLowerCase();
  const isAlertStyle = ALERT_STYLE_TO_TYPE[val] !== undefined;
  const isGithubBlockquoteStyle = val === 'github' || val === 'githubblockquote';
  if (val !== 'quote' && val !== 'intensequote' && !isGithubBlockquoteStyle && !isAlertStyle) return {};

  // Extract left indent to determine nesting level
  const indentUnitTwips: 240 | 720 = (isGithubBlockquoteStyle || isAlertStyle) ? 240 : 720;
  const left = parseParagraphLeftIndentTwips(pPrChildren);
  if (left !== undefined) {
    if (left > 0) {
      return { level: Math.max(1, Math.round(left / indentUnitTwips)), indentUnitTwips };
    }
  }
  return { level: 1, indentUnitTwips };
}

export function parseBlockquoteLevel(pPrChildren: XmlNode[]): number | undefined {
  const info = parseBlockquoteInfo(pPrChildren);
  if (info.level !== undefined) {
    return info.level;
  }
  return undefined;
}

export function parseAlertType(pPrChildren: XmlNode[]): GfmAlertType | undefined {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return undefined;
  const val = getAttr(pStyleElement, 'val').toLowerCase();
  return ALERT_STYLE_TO_TYPE[val];
}

export function parseCodeBlockStyle(pPrChildren: XmlNode[]): boolean {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return false;
  return getAttr(pStyleElement, 'val').toLowerCase() === 'codeblock';
}

export function parseListMeta(pPrChildren: XmlNode[], numberingDefs: NumberingDefs, numberingStartOverrides?: NumberingStartOverrides): ListMeta | undefined {
  const numPrElement = pPrChildren.find(child => child['w:numPr'] !== undefined);
  if (!numPrElement) return undefined;

  const numPr = numPrElement['w:numPr'];
  if (!Array.isArray(numPr)) return undefined;

  let numId = '';
  let ilvl = '';

  for (const child of numPr) {
    if (child['w:numId']) {
      numId = getAttr(child, 'val');
    }
    if (child['w:ilvl']) {
      ilvl = getAttr(child, 'val');
    }
  }

  if (!numId || !ilvl) return undefined;

  const levels = numberingDefs.get(numId);
  if (!levels) return undefined;

  const def = levels.get(ilvl);
  if (!def) return undefined;

  const level = parseInt(ilvl, 10);
  if (isNaN(level) || level < 0) return undefined;

  const startNumber = numberingStartOverrides?.get(numId)?.get(ilvl);
  return {
    type: def.type,
    level,
    ...(startNumber !== undefined ? { startNumber } : {}),
  };
}

async function loadZip(data: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

async function readZipXml(zip: JSZip, path: string): Promise<XmlNode[] | null> {
  const file = zip.file(path);
  if (!file) { return null; }
  const xml = await file.async('string');
  const parsed: unknown = new XMLParser(parserOptions).parse(xml);
  return asXmlNodes(parsed);
}

function findAllDeep(nodes: XmlNode[], tagName: string, depth = 0, maxDepth = 50): XmlNode[] {
  if (depth >= maxDepth) { return []; }
  const results: XmlNode[] = [];
  for (const node of nodes) {
    if (node[tagName] !== undefined) { results.push(node); }
    for (const key of Object.keys(node)) {
      if (key !== ':@' && Array.isArray(node[key])) {
        results.push(...findAllDeep(node[key], tagName, depth + 1, maxDepth));
      }
    }
  }
  return results;
}

function getAttr(node: XmlNode | undefined, attr: string): string {
  const value = node?.[':@']?.[`@_w:${attr}`] ?? node?.[':@']?.[`@_${attr}`];
  return value === undefined ? '' : String(value);
}

/** Extract text from a node's children (handles #text in preserveOrder mode) */
function nodeText(children: XmlNode[]): string {
  if (!Array.isArray(children)) { return ''; }
  const parts: string[] = [];
  for (const c of children) {
    if (c['#text'] !== undefined) { parts.push(String(c['#text'])); }
  }
  // Also recurse into w:t children
  for (const c of children) {
    if (c['w:t'] !== undefined && Array.isArray(c['w:t'])) {
      parts.push(nodeText(c['w:t']));
    }
  }
  return parts.join('');
}

/**
 * Walk the parsed XML tree and extract complete field instructions by
 * accumulating w:instrText fragments between w:fldChar begin and
 * separate/end markers.  Returns one concatenated instruction string
 * per complex field, in document order.
 */
function extractFieldInstructions(nodes: XmlNode[]): string[] {
  const results: string[] = [];
  let accumulating = false;
  let buffer = '';

  function walk(items: XmlNode[]): void {
    for (const node of items) {
      for (const key of Object.keys(node)) {
        if (key === ':@') { continue; }

        if (key === 'w:fldChar') {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'begin') {
            accumulating = true;
            buffer = '';
          } else if (fldType === 'separate' || fldType === 'end') {
            if (accumulating) {
              results.push(buffer);
              accumulating = false;
              buffer = '';
            }
          }
        } else if (key === 'w:instrText' && accumulating) {
          buffer += nodeText(asXmlNodes(node['w:instrText']));
        } else if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(nodes);
  return results;
}

// Formatting helpers

/** Detect OOXML boolean toggle pattern */
export function isToggleOn(children: XmlNode[], tagName: string): boolean {
  const element = children.find(child => child[tagName] !== undefined);
  if (!element) return false;
  
  const val = getAttr(element, 'val');
  if (!val) return true; // present with no w:val attribute → true
  return val === 'true' || val === '1' || val === 'on';
}

/** Parse run properties and return RunFormatting */
export function parseRunProperties(
  rPrChildren: XmlNode[],
  baseFormatting: RunFormatting = DEFAULT_FORMATTING
): RunFormatting {
  const formatting: RunFormatting = { ...baseFormatting };
  
  // OOXML toggles: only override inherited value if property is explicitly present.
  const bElement = rPrChildren.find(child => child['w:b'] !== undefined);
  if (bElement) {
    const val = getAttr(bElement, 'val');
    formatting.bold = !val || val === 'true' || val === '1' || val === 'on';
  }

  const iElement = rPrChildren.find(child => child['w:i'] !== undefined);
  if (iElement) {
    const val = getAttr(iElement, 'val');
    formatting.italic = !val || val === 'true' || val === '1' || val === 'on';
  }

  // strikethrough: w:strike or w:dstrike (double strikethrough) — both map to ~~
  const strikeElement = rPrChildren.find(child => child['w:strike'] !== undefined);
  const dstrikeElement = rPrChildren.find(child => child['w:dstrike'] !== undefined);
  if (strikeElement) {
    const val = getAttr(strikeElement, 'val');
    formatting.strikethrough = !val || val === 'true' || val === '1' || val === 'on';
  } else if (dstrikeElement) {
    const val = getAttr(dstrikeElement, 'val');
    formatting.strikethrough = !val || val === 'true' || val === '1' || val === 'on';
  }
  
  // underline: w:u with w:val ≠ "none"
  const uElement = rPrChildren.find(child => child['w:u'] !== undefined);
  if (uElement) {
    const val = getAttr(uElement, 'val');
    // OOXML: bare <w:u/> defaults to single underline; only w:val="none" disables it.
    formatting.underline = val !== 'none';
  }
  
  // highlight: w:highlight with w:val ≠ "none", OR w:shd with w:fill ≠ "" and ≠ "auto"
  // w:highlight takes priority over w:shd per ECMA-376
  const highlightElement = rPrChildren.find(child => child['w:highlight'] !== undefined);
  if (highlightElement) {
    const val = getAttr(highlightElement, 'val');
    formatting.highlight = val !== 'none';
    if (formatting.highlight && val) {
      formatting.highlightColor = val;
    } else {
      formatting.highlightColor = undefined;
    }
  } else {
    const shdElement = rPrChildren.find(child => child['w:shd'] !== undefined);
    if (shdElement) {
      const fill = getAttr(shdElement, 'fill');
      formatting.highlight = fill !== '' && fill !== 'auto';
      if (formatting.highlight && fill) {
        formatting.highlightColor = fill;
      } else {
        formatting.highlightColor = undefined;
      }
    }
  }
  
  // superscript/subscript: w:vertAlign (explicit value overrides inherited pair)
  const vertAlignElement = rPrChildren.find(child => child['w:vertAlign'] !== undefined);
  if (vertAlignElement) {
    const val = getAttr(vertAlignElement, 'val');
    formatting.superscript = val === 'superscript';
    formatting.subscript = val === 'subscript';
  }

  // inline code: w:rStyle with val matching "CodeChar" (case-insensitive)
  const rStyleElement = rPrChildren.find(child => child['w:rStyle'] !== undefined);
  if (rStyleElement) {
    const val = getAttr(rStyleElement, 'val');
    formatting.code = !!(val && val.toLowerCase() === 'codechar');
  }

  return formatting;
}

/** Apply formatting delimiters in nesting order, keeping edge whitespace outside markers. */
function wrapMarkdownDelimited(text: string, open: string, close = open, suffix = ''): string {
  const match = text.match(/^(\s*)(.*?)(\s*)$/s);
  if (!match) return open + text + close + suffix;
  const [, leading, core, trailing] = match;
  if (!core) return text;
  return leading + open + core + close + suffix + trailing;
}

export function wrapWithFormatting(text: string, fmt: RunFormatting): string {
  let result = text;

  // Apply in reverse nesting order (innermost to outermost)
  // Code is innermost — applied first
  if (fmt.code) {
    // Find the longest run of consecutive backticks in the text
    let maxRun = 0;
    const backtickRuns = result.match(/`+/g);
    if (backtickRuns) {
      for (const run of backtickRuns) {
        if (run.length > maxRun) maxRun = run.length;
      }
    }
    const fence = '`'.repeat(maxRun + 1);
    // Add padding space if content starts/ends with a backtick, or if
    // content has both leading and trailing spaces (CommonMark §6.1 would
    // strip one space from each end, losing the original whitespace).
    const hasLeadingTrailingSpaces = result.startsWith(' ') && result.endsWith(' ') && result.trim().length > 0;
    const needsPadding = result.startsWith('`') || result.endsWith('`') || hasLeadingTrailingSpaces;
    result = needsPadding ? `${fence} ${result} ${fence}` : `${fence}${result}${fence}`;
    return result;
  }

  result = escapeSensitiveHtmlLikeTags(result);

  // Escape markdown-sensitive characters so they round-trip faithfully.
  // Only applies to non-code text (code is already fenced with backticks above).
  result = escapeMarkdownChars(result);

  // If both superscript and subscript are true, superscript takes precedence
  if (fmt.superscript) {
    result = `<sup>${result}</sup>`;
  } else if (fmt.subscript) {
    result = `<sub>${result}</sub>`;
  }
  if (fmt.highlight) {
    const color = fmt.highlightColor ? resolveMarkdownColor(fmt.highlightColor) : undefined;
    if (color && color !== 'yellow') {
      result = wrapMarkdownDelimited(result, '==', '==', '{' + color + '}');
    } else {
      result = wrapMarkdownDelimited(result, '==', '==');
    }
  }
  if (fmt.underline) result = `<u>${result}</u>`;
  if (fmt.strikethrough) result = wrapMarkdownDelimited(result, '~~', '~~');
  if (fmt.italic) result = wrapMarkdownDelimited(result, '*');
  if (fmt.bold) result = wrapMarkdownDelimited(result, '**');

  return result;
}

function formatHrefForMarkdown(href: string): string {
  return /[()\[\]\s]/.test(href) ? `<${href}>` : href;
}

// Comment extraction

export async function extractComments(data: Uint8Array | JSZip): Promise<Map<string, Comment>> {
  const comments = new Map<string, Comment>();
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/comments.xml');
  if (!parsed) { return comments; }

  for (const node of findAllDeep(parsed, 'w:comment')) {
    const id = getAttr(node, 'id');
    const author = getAttr(node, 'author');
    const date = getAttr(node, 'date') || '';
    // Collect all w:t text within this comment
    const tNodes = findAllDeep(asXmlNodes(node['w:comment']), 'w:t');
    const text = tNodes.map(t => nodeText(asXmlNodes(t['w:t']))).join('');
    // Extract w14:paraId from the last comment paragraph. md-to-docx emits
    // paraId on the last <w:p> (per commentsExtended linking expectations),
    // but keep a first-paragraph fallback for third-party documents.
    const pNodes = findAllDeep(asXmlNodes(node['w:comment']), 'w:p');
    let paraId: string | undefined;
    for (let i = pNodes.length - 1; i >= 0; i--) {
      const candidate = pNodes[i]?.[':@']?.['@_w14:paraId'];
      if (candidate) {
        paraId = candidate;
        break;
      }
    }
    if (!paraId) {
      paraId = pNodes[0]?.[':@']?.['@_w14:paraId'];
    }
    comments.set(id, { author, text, date, paraId });
  }
  return comments;
}

/** Parse word/commentsExtended.xml and return paraId→parentParaId map for reply comments. */
export async function extractCommentThreads(data: Uint8Array | JSZip): Promise<Map<string, string>> {
  const threads = new Map<string, string>();
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/commentsExtended.xml');
  if (!parsed) { return threads; }

  for (const node of findAllDeep(parsed, 'w15:commentEx')) {
    const paraId = node?.[':@']?.['@_w15:paraId'] ?? '';
    const parentParaId = node?.[':@']?.['@_w15:paraIdParent'] ?? '';
    if (paraId && parentParaId) {
      threads.set(paraId, parentParaId);
    }
  }
  return threads;
}

/**
 * Group reply comments under their parent as CommentReply entries.
 * Returns the set of reply comment IDs (to exclude from ranges).
 */
export function groupCommentThreads(
  comments: Map<string, Comment>,
  threads: Map<string, string>
): Set<string> {
  const replyIds = new Set<string>();
  if (threads.size === 0) return replyIds;

  // Build paraId→commentId lookup
  const paraIdToCommentId = new Map<string, string>();
  for (const [id, comment] of comments) {
    if (comment.paraId) {
      paraIdToCommentId.set(comment.paraId, id);
    }
  }

  // Attach replies to parents, flattening deeper chains to the root parent.
  // Word UI only produces flat reply lists, but third-party generators could
  // create deeper chains (reply-to-reply). We resolve these by walking up
  // the thread until we find the root (non-reply) comment.
  for (const [childParaId, parentParaId] of threads) {
    const childId = paraIdToCommentId.get(childParaId);
    if (!childId) continue;

    // Walk up to the root parent (with cycle detection for malformed DOCX)
    let resolvedParaId = parentParaId;
    const visited = new Set<string>();
    while (threads.has(resolvedParaId)) {
      if (visited.has(resolvedParaId)) break;
      visited.add(resolvedParaId);
      resolvedParaId = threads.get(resolvedParaId)!;
    }
    const parentId = paraIdToCommentId.get(resolvedParaId);
    if (!parentId) continue;

    const parent = comments.get(parentId);
    const child = comments.get(childId);
    if (!parent || !child) continue;

    if (!parent.replies) parent.replies = [];
    parent.replies.push({ author: child.author, text: child.text, date: child.date });
    replyIds.add(childId);
  }

  // Sort replies by date so ordering is deterministic regardless of
  // the element order in commentsExtended.xml.
  for (const comment of comments.values()) {
    if (comment.replies && comment.replies.length > 1) {
      comment.replies.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    }
  }

  return replyIds;
}

/** Matches the 8-character Zotero item key at the end of a URI. */
export const ZOTERO_KEY_RE = /\/items\/([A-Z0-9]{8})$/;

// Zotero document preferences extraction

export async function extractZoteroPrefs(data: Uint8Array | JSZip): Promise<ZoteroDocPrefs | undefined> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return undefined;

  // Find ZOTERO_PREF_* properties and concatenate in order
  const prefParts: Array<{ index: number; value: string }> = [];
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (!name.startsWith('ZOTERO_PREF_')) continue;

    const idxStr = name.replace('ZOTERO_PREF_', '');
    const idx = parseInt(idxStr, 10);
    if (isNaN(idx)) continue;

    const children = propNode['property'];
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const val = nodeText(asXmlNodes(child['vt:lpwstr']));
        prefParts.push({ index: idx, value: val });
      }
    }
  }

  if (prefParts.length === 0) return undefined;

  prefParts.sort((a, b) => a.index - b.index);
  const prefString = prefParts.map(p => p.value).join('');

  // Try JSON parse (dataVersion 4)
  try {
    const prefObj = JSON.parse(prefString);
    const styleId: string = prefObj?.style?.styleID ?? '';
    const locale: string = prefObj?.style?.locale ?? '';
    const noteType: number | undefined = prefObj?.prefs?.noteType;
    if (!styleId) return undefined;
    return {
      styleId,
      locale: locale || undefined,
      noteType: noteType !== undefined && noteType !== 0 ? noteType : undefined,
    };
  } catch {
    // Try XML parse (dataVersion 3)
    try {
      const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const xmlData = xmlParser.parse(prefString);
      const styleId: string = xmlData?.data?.style?.['@_id'] ?? '';
      const locale: string = xmlData?.data?.style?.['@_locale'] ?? '';
      const noteType: number | undefined = xmlData?.data?.prefs?.['@_noteType'] != null
        ? parseInt(xmlData.data.prefs['@_noteType'], 10) : undefined;
      if (!styleId) return undefined;
      return {
        styleId,
        locale: locale || undefined,
        noteType: noteType !== undefined && !isNaN(noteType) && noteType !== 0 ? noteType : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
/**
 * Read chunked custom property values from a DOCX ZIP and join them into a single string.
 * Handles two naming conventions:
 * - Strict: PREFIX_1, PREFIX_2, … (prefix ends with '_')
 * - Flexible: PREFIX (index 1), PREFIX_2, PREFIX_3, … (prefix without trailing '_')
 * Returns null if no matching properties are found.
 */
async function extractChunkedCustomProp(data: Uint8Array | JSZip, propPrefix: string): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const strict = propPrefix.endsWith('_');
  const parts: Array<{ index: number; value: string }> = [];
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (!name.startsWith(propPrefix)) continue;

    let idx: number;
    if (strict) {
      const chunkMatch = name.slice(propPrefix.length).match(/^(\d+)$/);
      if (!chunkMatch) continue;
      idx = parseInt(chunkMatch[1], 10);
      if (isNaN(idx)) continue;
    } else {
      idx = 1;
      if (name !== propPrefix) {
        if (!name.startsWith(propPrefix + '_')) continue;
        const chunkMatch = name.slice(propPrefix.length + 1).match(/^(\d+)$/);
        if (!chunkMatch) continue;
        idx = parseInt(chunkMatch[1], 10);
        if (isNaN(idx)) continue;
      }
    }

    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const val = nodeText(asXmlNodes(child['vt:lpwstr']));
        parts.push({ index: idx, value: val });
      }
    }
  }

  if (parts.length === 0) return null;
  parts.sort((a, b) => a.index - b.index);
  return parts.map(p => p.value).join('');
}

export async function extractBlockquoteAlertStyleMapping(data: Uint8Array | JSZip): Promise<Map<number, boolean> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_ALERT_STYLE');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, boolean>();
    for (const [key, isInline] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      if (isNaN(groupIdx) || typeof isInline !== 'number') continue;
      mapping.set(groupIdx, isInline === 1);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

async function extractIdMappingFromCustomXml(
  data: Uint8Array | JSZip,
  propPrefix: string,
): Promise<Map<string, string> | null> {
  const mappingJson = await extractChunkedCustomProp(data, propPrefix);
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<string, string>();
    for (const [numericId, originalId] of Object.entries(parsedJson)) {
      if (typeof originalId !== 'string' || !originalId) continue;
      mapping.set(String(numericId), originalId);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

export async function extractCommentIdMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_COMMENT_IDS');
}
// Footnote/endnote extraction

export async function extractFootnoteIdMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_FOOTNOTE_IDS');
}

/** Extract bookmark-name → "noteKind:noteId" mapping for footnote cross-references. */
export async function extractFootnoteCrossRefMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_FOOTNOTE_CROSSREFS');
}

export async function extractCodeBlockLanguageMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_CODE_BLOCK_LANGS');
}

export async function extractCodeBlockStyling(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_CODE_BLOCK_STYLING');
}

export async function extractTableFormatMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_FORMATS');
}

export async function extractPipeTableAlignedMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_PIPE_TABLE_ALIGNED');
}

export async function extractGridSourceColWidthsMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_GRID_SOURCE_COL_WIDTHS');
}

export async function extractTableFontSizeMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_FONT_SIZES');
}

export async function extractTableFontMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_FONTS');
}

export async function extractTableColWidthsMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_COL_WIDTHS');
}

export async function extractTableDigitsMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_DIGITS');
}

export async function extractTableDecimalMarkMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_DECIMAL_MARKS');
}

export async function extractTableDigitGroupingMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_TABLE_DIGIT_GROUPINGS');
}

export async function extractEmbedDirectiveMapping(data: Uint8Array | JSZip): Promise<Map<string, string> | null> {
  return extractIdMappingFromCustomXml(data, 'MANUSCRIPT_EMBED_DIRECTIVES');
}

export async function extractDefaultTableColWidths(data: Uint8Array | JSZip): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_DEFAULT_TABLE_COL_WIDTHS') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child?.['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        return raw || null;
      }
    }
  }
  return null;
}

export async function extractLandscapeTableMapping(data: Uint8Array | JSZip): Promise<Set<number> | null> {
  const mapping = await extractIdMappingFromCustomXml(data, 'MANUSCRIPT_LANDSCAPE_TABLES_');
  if (!mapping) return null;
  const result = new Set<number>();
  for (const [key, val] of mapping) {
    if (val === 'landscape') {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) result.add(n);
    }
  }
  return result.size > 0 ? result : null;
}

export async function extractPortraitTableMapping(data: Uint8Array | JSZip): Promise<Set<number> | null> {
  const mapping = await extractIdMappingFromCustomXml(data, 'MANUSCRIPT_PORTRAIT_TABLES_');
  if (!mapping) return null;
  const result = new Set<number>();
  for (const [key, val] of mapping) {
    if (val === 'portrait') {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) result.add(n);
    }
  }
  return result.size > 0 ? result : null;
}

export async function extractPortraitBreakOrdinals(data: Uint8Array | JSZip): Promise<Set<number> | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_PORTRAIT_BREAKS_');
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    const result = new Set<number>();
    for (const v of arr) {
      if (typeof v === 'number' && Number.isFinite(v)) result.add(v);
    }
    return result.size > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Extract custom style definitions from MANUSCRIPT_CUSTOM_STYLES_ custom property. */
export async function extractCustomStyles(data: Uint8Array | JSZip): Promise<Record<string, CustomStyleDef> | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_CUSTOM_STYLES');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Validate structure
    const result: Record<string, CustomStyleDef> = {};
    for (const [name, def] of Object.entries(parsed)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const styleDef: CustomStyleDef = {};
      if (typeof d.font === 'string') styleDef.font = d.font;
      if (typeof d.fontSize === 'number') styleDef.fontSize = d.fontSize;
      if (typeof d.fontStyle === 'string') styleDef.fontStyle = d.fontStyle;
      if (typeof d.spacingBefore === 'number') styleDef.spacingBefore = d.spacingBefore;
      if (typeof d.spacingAfter === 'number') styleDef.spacingAfter = d.spacingAfter;
      if (d.paragraphIndent === 'none' || d.paragraphIndent === 0) styleDef.paragraphIndent = 'none';
      else if (typeof d.paragraphIndent === 'number' && d.paragraphIndent > 0) styleDef.paragraphIndent = d.paragraphIndent;
      result[name] = styleDef;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function extractListIndent(data: Uint8Array | JSZip): Promise<'tab' | 'spaces' | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_LIST_INDENT') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (raw === 'tab') return 'tab';
      }
    }
  }
  return null;
}

export async function extractConsecutiveReplyParaIds(data: Uint8Array | JSZip): Promise<Set<string> | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_CONSECUTIVE_REPLY_COMMENTS') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (raw) return new Set(raw.split(',').map(id => id.trim()).filter(Boolean));
      }
    }
  }
  return null;
}

export async function extractFrontmatterBlankLines(data: Uint8Array | JSZip): Promise<number | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_FRONTMATTER_BLANK_LINES') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 0) return n;
      }
    }
  }
  return null;
}

export async function extractHtmlCommentAfterGapMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_HTML_COMMENT_AFTER_GAPS_');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const commentIdx = parseInt(key, 10);
      if (isNaN(commentIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
      mapping.set(commentIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

export async function extractSentinelGapMapping(data: Uint8Array | JSZip): Promise<Record<string, number> | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_SENTINEL_GAPS_');
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'number' && Number.isInteger(val) && val >= 0) result[key] = val;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function extractFrontmatterFieldOrder(data: Uint8Array | JSZip): Promise<string[] | null> {
  const json = await extractChunkedCustomProp(data, 'MANUSCRIPT_FRONTMATTER_FIELD_ORDER_');
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr.filter((s: unknown): s is string => typeof s === 'string');
  } catch {
    return null;
  }
}

export async function extractExplicitTableFontSize(data: Uint8Array | JSZip): Promise<boolean> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return false;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_EXPLICIT_TABLE_FONT_SIZE') continue;
    return true;
  }
  return false;
}

export async function extractTableBorders(data: Uint8Array | JSZip): Promise<'horizontal' | 'solid' | 'none' | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_TABLE_BORDERS') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) return null;
    for (const child of children) {
      if (child?.['vt:lpwstr'] !== undefined) {
        const val = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (val === 'horizontal' || val === 'solid' || val === 'none') return val;
        return null;
      }
    }
    return null;
  }
  return null;
}

/** Layer 2: read comma-separated bib key order from chunked MANUSCRIPT_BIB_KEY_ORDER_* custom props. */
export async function extractBibKeyOrder(data: Uint8Array | JSZip): Promise<string[] | null> {
  const csv = await extractChunkedCustomProp(data, 'MANUSCRIPT_BIB_KEY_ORDER_');
  if (!csv) return null;
  const keys = csv.split(',').map(k => k.trim()).filter(Boolean);
  return keys.length > 0 ? keys : null;
}

/** Layer 1: read full .bib text from chunked MANUSCRIPT_BIB_DATA_* custom props. */
export async function extractBibData(data: Uint8Array | JSZip): Promise<string | null> {
  const text = await extractChunkedCustomProp(data, 'MANUSCRIPT_BIB_DATA_');
  if (!text) return null;
  return text.trim().length > 0 ? text : null;
}

export async function extractBibliographyPath(data: Uint8Array | JSZip): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_BIBLIOGRAPHY_PATH') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr']));
        return raw.trim().length > 0 ? raw : null;
      }
    }
  }
  return null;
}

export async function extractPipeTableMaxLineWidth(data: Uint8Array | JSZip): Promise<number | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_PIPE_TABLE_MAX_LINE_WIDTH') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (!/^\d+$/.test(raw)) continue;
        return parseInt(raw, 10);
      }
    }
  }
  return null;
}

export async function extractGridTableMaxLineWidth(data: Uint8Array | JSZip): Promise<number | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== 'MANUSCRIPT_GRID_TABLE_MAX_LINE_WIDTH') continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        if (!/^\d+$/.test(raw)) continue;
        return parseInt(raw, 10);
      }
    }
  }
  return null;
}

async function extractStringCustomProp(data: Uint8Array | JSZip, propName: string): Promise<string | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (name !== propName) continue;
    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const raw = nodeText(asXmlNodes(child['vt:lpwstr'])).trim();
        return raw.length > 0 ? raw : null;
      }
    }
  }
  return null;
}

export async function extractLineSpacing(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_LINE_SPACING');
}

export async function extractParagraphIndent(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_PARAGRAPH_INDENT');
}

export async function extractBibliographyHangingIndent(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_BIBLIOGRAPHY_HANGING_INDENT');
}

export async function extractCalloutLabels(data: Uint8Array | JSZip): Promise<boolean | null> {
  const raw = await extractStringCustomProp(data, 'MANUSCRIPT_CALLOUT_LABELS');
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

export async function extractDefaultTableDigits(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_TABLE_DIGITS');
}

export async function extractDefaultTableDecimalMark(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_TABLE_DECIMAL_MARK');
}

export async function extractDefaultTableDigitGrouping(data: Uint8Array | JSZip): Promise<string | null> {
  return extractStringCustomProp(data, 'MANUSCRIPT_DEFAULT_TABLE_DIGIT_GROUPING');
}

export async function extractIndentOverrides(data: Uint8Array | JSZip): Promise<Map<number, string> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_INDENT_OVERRIDES');
  if (!mappingJson) return null;
  try {
    const obj = JSON.parse(mappingJson);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const map = new Map<number, string>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && (v === 'indent' || v === 'no-indent')) map.set(idx, v as string);
    }
    return map.size > 0 ? map : null;
  } catch { return null; }
}

export async function extractListIndentOverrides(data: Uint8Array | JSZip): Promise<Map<number, string> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_LIST_INDENT_OVERRIDES');
  if (!mappingJson) return null;
  try {
    const obj = JSON.parse(mappingJson);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const map = new Map<number, string>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && (v === 'indent' || v === 'no-indent')) map.set(idx, v as string);
    }
    return map.size > 0 ? map : null;
  } catch { return null; }
}

// Extract blockquote gap metadata from custom XML properties.
// Returns a Map<number, number> mapping group index → blank-line count between
// that group and the next.  Uses the same chunked-JSON pattern as code block
// language props, with key prefix MANUSCRIPT_BLOCKQUOTE_GAPS.
export async function extractBlockquoteGapMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_BLOCKQUOTE_GAPS');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const groupIdx = parseInt(key, 10);
      if (isNaN(groupIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < -1) continue;
      mapping.set(groupIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

// Extract HTML comment gap metadata from custom XML properties.
// Returns a Map<number, number> mapping HTML comment index → blank-line-before count.
export async function extractHtmlCommentGapMapping(data: Uint8Array | JSZip): Promise<Map<number, number> | null> {
  const mappingJson = await extractChunkedCustomProp(data, 'MANUSCRIPT_HTML_COMMENT_GAPS');
  if (!mappingJson) return null;
  try {
    const parsedJson = JSON.parse(mappingJson);
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    const mapping = new Map<number, number>();
    for (const [key, count] of Object.entries(parsedJson)) {
      const commentIdx = parseInt(key, 10);
      if (isNaN(commentIdx) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
      mapping.set(commentIdx, count);
    }
    return mapping.size > 0 ? mapping : null;
  } catch {
    return null;
  }
}

async function extractNotes(
  zip: JSZip,
  xmlPath: string,
  tagName: string,
  context?: NoteBodyContext,
): Promise<Map<string, FootnoteBody>> {
  const notes = new Map<string, FootnoteBody>();
  const parsed = await readZipXml(zip, xmlPath);
  if (!parsed) return notes;

  // When context is provided, extract Zotero citations from the notes XML
  // (separate from the document-level citations) and build a file-scoped
  // context with a shared citation counter across all notes in this file.
  let fileContext: NoteBodyContext | undefined;
  if (context) {
    const noteCitations = extractZoteroCitationsFromParsed(parsed);
    const noteKeyMap = buildCitationKeyMap(noteCitations, context.format, new Set(context.keyMap.values()));
    // Merge document-level keyMap with note-specific keys
    const mergedKeyMap = new Map([...noteKeyMap, ...context.keyMap]);
    fileContext = {
      ...context,
      zoteroCitations: noteCitations,
      keyMap: mergedKeyMap,
    };
  }

  // Shared citation counter across all notes in this file
  const citationCounter = { idx: 0 };

  for (const node of findAllDeep(parsed, tagName)) {
    const id = getAttr(node, 'id');
    if (!id || id === '-1' || id === '0') continue;

    // Skip separator and continuationSeparator types
    const noteType = getAttr(node, 'type');
    if (noteType === 'separator' || noteType === 'continuationSeparator') continue;

    const noteChildren = node[tagName];
    if (!Array.isArray(noteChildren)) continue;

    const content = parseNoteBody(noteChildren, tagName, fileContext, citationCounter);
    notes.set(id, { id, content });
  }
  return notes;
}

/**
 * Parse footnote/endnote body content from OOXML.
 *
 * When `context` is provided, handles hyperlinks, math, field codes (Zotero
 * citations), and tables using the same logic as the main document `walk()`.
 * Without context, only basic text formatting is parsed.
 */
function parseNoteBody(
  noteChildren: XmlNode[],
  tagName: string,
  context?: NoteBodyContext,
  citationCounter?: { idx: number },
): ContentItem[] {
  const content: ContentItem[] = [];
  // Determine self-ref tag: w:footnoteRef or w:endnoteRef
  const selfRefTag = tagName === 'w:footnote' ? 'w:footnoteRef' : 'w:endnoteRef';
  let skippedSelfRef = false;

  // Field-tracking state (only used when context is provided)
  let inField = false;
  let inCitationField = false;
  let fieldInstrParts: string[] = [];
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];
  const cCounter = citationCounter ?? { idx: 0 };
  let currentHref: string | undefined;

  function walkNoteBody(
    nodes: XmlNode[],
    currentFormatting: RunFormatting = DEFAULT_FORMATTING,
    target: ContentItem[] = content,
    inTableCell = false,
    currentRevision?: RevisionInfo
  ): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') continue;

        if (key === selfRefTag && !skippedSelfRef) {
          skippedSelfRef = true;
          continue;
        } else if (key in REVISION_ELEMENTS) {
          const author = getAttr(node, 'author');
          const date = getAttr(node, 'date');
          const rev = { type: REVISION_ELEMENTS[key], author, date };
          if (Array.isArray(node[key])) walkNoteBody(node[key], currentFormatting, target, inTableCell, rev);
        } else if (key === 'w:fldChar' && context) {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'begin') {
            inField = true;
            fieldInstrParts = [];
            inCitationField = false;
          } else if (fldType === 'separate') {
            if (inField) {
              const instrText = fieldInstrParts.join('');
              if (instrText.includes('ZOTERO_ITEM')) {
                inCitationField = true;
                currentCitation = context.zoteroCitations[cCounter.idx++];
                citationTextParts = [];
              }
            }
          } else if (fldType === 'end') {
            if (inCitationField && currentCitation) {
              const pandocKeys = citationPandocKeys(currentCitation, context.keyMap);
              target.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(),
                pandocKeys,
                ...(currentRevision ? { revision: currentRevision } : {}),
              });
            }
            inField = false;
            inCitationField = false;
            currentCitation = undefined;
          }
        } else if (key === 'w:instrText' && inField && context) {
          fieldInstrParts.push(nodeText(asXmlNodes(node['w:instrText'])));

        // --- Hyperlinks ---
        } else if (key === 'w:hyperlink' && context) {
          const rId = node?.[':@']?.['@_r:id'] ?? getAttr(node, 'id');
          const prevHref = currentHref;
          currentHref = context.relationshipMap.get(rId);
          if (Array.isArray(node[key])) { walkNoteBody(node[key], currentFormatting, target, inTableCell, currentRevision); }
          currentHref = prevHref;

        // --- Tables ---
        } else if (key === 'w:tbl' && context && !inTableCell) {
          const tblChildren = asXmlNodes(node[key]);
          const rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> }> = [];
          const firstRowHeaderByLook = tableHasFirstRowHeader(tblChildren);
          for (const tr of tblChildren.filter((c) => c['w:tr'] !== undefined)) {
            const trChildren = asXmlNodes(tr['w:tr']);
            const cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> = [];
            for (const tc of trChildren.filter((c) => c['w:tc'] !== undefined)) {
              const tcChildren = asXmlNodes(tc['w:tc']);
              let colspan = 1;
              let vMergeType: 'restart' | 'continue' | undefined;
              const tcPrNode = tcChildren.find((c) => c['w:tcPr'] !== undefined);
              if (tcPrNode) {
                const tcPrChildren = asXmlNodes(tcPrNode['w:tcPr']);
                const gridSpanNode = tcPrChildren.find((c) => c['w:gridSpan'] !== undefined);
                if (gridSpanNode) {
                  const val = parseInt(getAttr(gridSpanNode, 'val'), 10);
                  if (val > 1) colspan = val;
                }
                const vMergeNode = tcPrChildren.find((c) => c['w:vMerge'] !== undefined);
                if (vMergeNode) {
                  const val = getAttr(vMergeNode, 'val');
                  vMergeType = val === 'restart' ? 'restart' : 'continue';
                }
              }
              const cellItems: ContentItem[] = [];
              walkNoteBody(tcChildren, currentFormatting, cellItems, true, currentRevision);
              cells.push({ paragraphs: splitCellParagraphs(cellItems), colspan, vMergeType });
            }
            rawRows.push({ isHeader: rowHasHeaderProp(trChildren), cells });
          }
          if (firstRowHeaderByLook && rawRows.length > 0) {
            rawRows[0].isHeader = true;
          }
          const rows = computeRowspans(rawRows);
          if (rows.length > 0) {
            target.push({ type: 'table', rows });
          }

        // --- Math ---
        } else if (key === 'm:oMathPara' && context) {
          const mathParaChildren = asXmlNodes(node[key]);
          const oMathNodes = mathParaChildren.filter((c) => c['m:oMath'] !== undefined);
          for (const oMathNode of oMathNodes) {
            try {
              const latex = ommlToLatex(asXmlNodes(oMathNode['m:oMath']));
              if (latex) {
                target.push({ type: 'math', latex, display: true, commentIds: new Set(), ...(currentRevision ? { revision: currentRevision } : {}) });
              }
            } catch {
              target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: true, commentIds: new Set(), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          }
        } else if (key === 'm:oMath' && context) {
          const mathChildren = asXmlNodes(node[key]);
          try {
            const latex = ommlToLatex(mathChildren);
            if (latex) {
              target.push({ type: 'math', latex, display: false, commentIds: new Set(), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          } catch {
            target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: false, commentIds: new Set(), ...(currentRevision ? { revision: currentRevision } : {}) });
          }

        // --- Basic text elements (always handled) ---
        } else if (key === 'w:t' || key === 'w:delText') {
          const text = nodeText(asXmlNodes(node[key]));
          if (text) {
            if (inCitationField && context) {
              citationTextParts.push(text);
            } else {
              const textItem: ContentItem = {
                type: 'text',
                text,
                commentIds: new Set(),
                formatting: currentFormatting,
                ...(currentRevision ? { revision: currentRevision } : {}),
              };
              if (currentHref) {
                textItem.href = currentHref;
              }
              target.push(textItem);
            }
          }
        } else if (key === 'w:br') {
          const brType = getAttr(node, 'type');
          if (!brType || brType === 'textWrapping') {
            target.push({
              type: 'text',
              text: '\\\n',
              commentIds: new Set(),
              formatting: currentFormatting,
              ...(currentRevision ? { revision: currentRevision } : {}),
            });
          }
        } else if (key === 'w:p') {
          const paraChildren = asXmlNodes(node[key]);
          let paraFormatting = currentFormatting;
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = asXmlNodes(child['w:pPr']);
              const pRPrElement = pPrChildren.find((c) => c['w:rPr'] !== undefined);
              if (pRPrElement) {
                const pRPrChildren = asXmlNodes(pRPrElement['w:rPr']);
                paraFormatting = parseRunProperties(pRPrChildren, currentFormatting);
              }
              break;
            }
          }
          // Push para separator for multi-paragraph notes (skip first)
          const needsPara = inTableCell
            ? true
            : target.length > 0 && target[target.length - 1].type !== 'para';
          if (needsPara) {
            target.push({ type: 'para' });
          }
          walkNoteBody(paraChildren, paraFormatting, target, inTableCell, currentRevision);
        } else if (key === 'w:r') {
          let runFormatting = currentFormatting;
          const runChildren = asXmlNodes(node[key]);
          for (const child of runChildren) {
            if (child['w:rPr']) {
              const rPrChildren = asXmlNodes(child['w:rPr']);
              runFormatting = parseRunProperties(rPrChildren, currentFormatting);
              break;
            }
          }
          walkNoteBody(runChildren, runFormatting, target, inTableCell, currentRevision);
        } else if (Array.isArray(node[key])) {
          walkNoteBody(node[key], currentFormatting, target, inTableCell, currentRevision);
        }
      }
    }
  }

  walkNoteBody(noteChildren);
  return content;
}

async function extractFootnotes(zip: JSZip, context?: NoteBodyContext): Promise<Map<string, FootnoteBody>> {
  return extractNotes(zip, 'word/footnotes.xml', 'w:footnote', context);
}

async function extractEndnotes(zip: JSZip, context?: NoteBodyContext): Promise<Map<string, FootnoteBody>> {
  return extractNotes(zip, 'word/endnotes.xml', 'w:endnote', context);
}

/** Strip the Zotero styles URL prefix and map canonical IDs to public aliases. */
export function zoteroStyleShortName(styleId: string): string {
  return publicStyleNameForZoteroId(styleId);
}

/** Build the canonical Zotero style URL from a public style name. */
export function zoteroStyleFullId(shortName: string): string {
  return zoteroStyleIdForName(shortName);
}

// Zotero metadata extraction

/** Extract Zotero citations from an already-parsed XML tree. */
function extractZoteroCitationsFromParsed(parsed: XmlNode[]): ZoteroCitation[] {
  return extractZoteroCitationsFromInstructions(extractFieldInstructions(parsed));
}

function extractZoteroCitationsFromInstructions(instructions: string[]): ZoteroCitation[] {
  const citations: ZoteroCitation[] = [];
  for (const instrText of instructions) {
    if (!instrText.includes('ZOTERO_ITEM')) { continue; }

    const jsonStart = instrText.indexOf('{');
    if (jsonStart < 0) {
      citations.push({ plainCitation: '', items: [] });
      continue;
    }

    try {
      const parsedData: unknown = JSON.parse(instrText.slice(jsonStart));
      if (!isRecord(parsedData)) throw new Error('Invalid Zotero citation payload');
      const properties = isRecord(parsedData.properties) ? parsedData.properties : {};
      const plainCitation = stringField(properties, 'plainCitation');
      const cslItems = Array.isArray(parsedData.citationItems)
        ? parsedData.citationItems.filter(isRecord)
        : [];

      const items: CitationMetadata[] = cslItems.map(item => {
        const d = isRecord(item.itemData) ? item.itemData : {};
        const issued = isRecord(d.issued) ? d.issued : {};
        const dateParts = Array.isArray(issued['date-parts']) ? issued['date-parts'] : [];
        const firstDatePart = Array.isArray(dateParts[0]) ? dateParts[0][0] : undefined;
        const year = firstDatePart ? String(firstDatePart) : '';

        const result: CitationMetadata = {
          authors: parseCslAuthors(d.author),
          title: stringField(d, 'title'),
          year,
          journal: stringField(d, 'container-title'),
          volume: stringField(d, 'volume'),
          pages: stringField(d, 'page'),
          doi: stringField(d, 'DOI'),
          type: stringField(d, 'type') || 'article-journal',
          fullItemData: d,
        };

        // Extract citation-key (CSL standard field) for round-trip preservation
        if (d['citation-key'] != null) {
          const ck = String(d['citation-key']).trim();
          if (ck) {
            result.citationKey = ck;
          }
        }

        // Extract Zotero URI and key
        const uris = item.uris ?? item.uri ?? [];
        const uriValue = Array.isArray(uris) ? uris[0] : uris;
        const uri = uriValue == null ? '' : String(uriValue);
        if (uri) {
          result.zoteroUri = uri;
          const zKey = extractZoteroKey(uri);
          if (zKey) {
            result.zoteroKey = zKey;
          }
        }

        // Extract locator (coerce to string for numeric locators)
        if (item.locator != null) {
          const loc = String(item.locator).trim();
          if (loc) {
            result.locator = loc;
          }
        }

        // Extract suppress-author flag (Pandoc [-@key] form)
        if (item['suppress-author']) {
          result.suppressAuthor = true;
        }

        return result;
      });

      citations.push({ plainCitation, items });
    } catch {
      // Push a placeholder so positional indices stay aligned with ZOTERO_ITEM occurrences
      citations.push({ plainCitation: '', items: [] });
    }
  }
  return citations;
}

export async function extractZoteroCitations(data: Uint8Array | JSZip): Promise<ZoteroCitation[]> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/document.xml');
  if (!parsed) { return []; }
  return extractZoteroCitationsFromParsed(parsed);
}

// Zotero URI key extraction

/** Extract the 8-character Zotero item key from a Zotero URI, or undefined if it doesn't match. */
export function extractZoteroKey(uri: string): string | undefined {
  const m = uri.match(ZOTERO_KEY_RE);
  return m ? m[1] : undefined;
}

// Citation key generation

export function generateCitationKey(
  surname: string, year: string, title: string, format: CitationKeyFormat = 'authorYearTitle'
): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const cleanSurname = clean(surname);
  const cleanYear = year.replace(/[^0-9]/g, '');
  if (format === 'authorYear') { return `${cleanSurname}${cleanYear}`; }
  if (format === 'numeric') { return ''; }
  const words = title.toLowerCase().match(/\b[a-zA-Z]+\b/g) ?? [];
  const firstWord = words.find(w => !['the', 'a', 'an'].includes(w)) ?? 'unknown';
  return `${cleanSurname}${cleanYear}${firstWord}`;
}

/**
 * Build a map from Zotero item URI (or title+year as fallback) to citation key.
 * Returns a function that maps a ZoteroCitation to its pandoc keys.
 */
export function buildCitationKeyMap(
  allCitations: ZoteroCitation[],
  format: CitationKeyFormat = 'authorYearTitle',
  existingKeys?: Set<string>
): Map<string, string> {
  const keyMap = new Map<string, string>(); // itemId -> citationKey
  const seen = new Set<string>(existingKeys);
  let numericCounter = 1;

  for (const citation of allCitations) {
    for (const meta of citation.items) {
      const itemId = itemIdentifier(meta);
      if (keyMap.has(itemId)) { continue; }

      if (format === 'numeric') {
        keyMap.set(itemId, String(numericCounter++));
        continue;
      }

      // Prefer stored citation-key from round-trip or Zotero
      if (meta.citationKey && !seen.has(meta.citationKey)) {
        seen.add(meta.citationKey);
        keyMap.set(itemId, meta.citationKey);
        continue;
      }

      const surname = getSurname(meta);
      const baseKey = generateCitationKey(surname, meta.year, meta.title, format);
      let key = baseKey;
      let counter = 2;
      while (seen.has(key)) { key = `${baseKey}${counter++}`; }
      seen.add(key);
      keyMap.set(itemId, key);
    }
  }
  return keyMap;
}

export function itemIdentifier(meta: CitationMetadata): string {
  // Use DOI if available, otherwise title+year
  if (meta.doi) { return `doi:${meta.doi}`; }
  return `${meta.title}::${meta.year}`;
}

function getSurname(meta: CitationMetadata): string {
  if (meta.authors.length > 0) {
    const first = meta.authors[0];
    if (first.literal) return first.literal;
    if (first.family) return first.family;
  }
  const publisher = meta.fullItemData.publisher;
  return (typeof publisher === 'string' && publisher) || meta.journal || 'unknown';
}

/** Strip characters that are significant in Pandoc citation syntax. */
function sanitizeLocator(locator: string | number): string {
  return String(locator).replace(/[\[\];@]/g, '');
}

/** Get pandoc keys for a citation's items.
 *  Keys prefixed with '-' indicate suppress-author ([-@key] form). */
export function citationPandocKeys(
  citation: ZoteroCitation,
  keyMap: Map<string, string>
): string[] {
  return citation.items
    .map(meta => {
      const k = keyMap.get(itemIdentifier(meta));
      if (!k) return undefined;
      const prefix = meta.suppressAuthor ? '-' : '';
      if (meta.locator) {
        const safe = sanitizeLocator(meta.locator);
        return safe ? prefix + k + ', p. ' + safe : prefix + k;
      }
      return prefix + k;
    })
    .filter((k): k is string => k !== undefined);
}

// Document content extraction

export interface ImageExtractionEntry {
  rId: string;
  mediaPath: string;
  outputFilename: string;
}

export interface DocumentContentResult {
  content: ContentItem[];
  zoteroBiblData?: ZoteroBiblData;
  imageEntries?: ImageExtractionEntry[];
}
function splitCellParagraphs(cellContent: ContentItem[]): ContentItem[][] {
  const paragraphs: ContentItem[][] = [];
  let current: ContentItem[] = [];
  let sawPara = false;

  for (const item of cellContent) {
    if (item.type === 'para') {
      if (!sawPara) {
        sawPara = true;
      } else {
        paragraphs.push(current);
        current = [];
      }
      continue;
    }
    current.push(item);
  }

  if (sawPara) {
    paragraphs.push(current);
  } else if (current.length > 0) {
    paragraphs.push(current);
  }

  if (paragraphs.length === 0) {
    paragraphs.push([]);
  }

  return paragraphs;
}

function tableHasFirstRowHeader(tblChildren: XmlNode[]): boolean {
  const tblPrNode = tblChildren.find((c) => c['w:tblPr'] !== undefined);
  if (!tblPrNode) return false;
  const tblPrChildren = asXmlNodes(tblPrNode['w:tblPr']);
  const tblLookNode = tblPrChildren.find((c) => c['w:tblLook'] !== undefined);
  if (!tblLookNode) return false;
  const firstRow = getAttr(tblLookNode, 'firstRow');
  return firstRow === '1' || firstRow === 'true' || firstRow === 'on';
}

function rowHasHeaderProp(trChildren: XmlNode[]): boolean {
  const trPrNode = trChildren.find((c) => c['w:trPr'] !== undefined);
  if (!trPrNode) return false;
  const trPrChildren = asXmlNodes(trPrNode['w:trPr']);
  const tblHeaderNode = trPrChildren.find((c) => c['w:tblHeader'] !== undefined);
  if (!tblHeaderNode) return false;
  const val = getAttr(tblHeaderNode, 'val');
  if (!val) return true;
  return val === '1' || val === 'true' || val === 'on';
}

/**
 * Convert raw rows (with vMerge annotations) into clean TableRows with numeric rowspan.
 * Continuation cells (vMerge without val="restart") are removed and the originating
 * cell's rowspan is set to the total number of merged rows.
 */
export function computeRowspans(
  rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> }>
): TableRow[] {
  // Build a 2D grid: grid[rowIdx][gridCol] = reference to the raw cell
  const numRows = rawRows.length;
  // Determine total grid columns
  let totalCols = 0;
  for (const row of rawRows) {
    let cols = 0;
    for (const cell of row.cells) cols += cell.colspan;
    if (cols > totalCols) totalCols = cols;
  }

  // Map (rowIdx, gridCol) -> cell reference
  type CellRef = { rowIdx: number; cellIdx: number; cell: typeof rawRows[0]['cells'][0] };
  const grid: (CellRef | undefined)[][] = [];
  for (let r = 0; r < numRows; r++) {
    const gridRow: (CellRef | undefined)[] = new Array(totalCols).fill(undefined);
    let col = 0;
    for (let ci = 0; ci < rawRows[r].cells.length; ci++) {
      const cell = rawRows[r].cells[ci];
      for (let s = 0; s < cell.colspan && col + s < totalCols; s++) {
        gridRow[col + s] = { rowIdx: r, cellIdx: ci, cell };
      }
      col += cell.colspan;
    }
    grid.push(gridRow);
  }

  // For each column, scan downward: when "restart" found, count consecutive "continue" below
  const rowspanMap = new Map<string, number>(); // "rowIdx,cellIdx" -> rowspan
  const continuationCells = new Set<string>(); // "rowIdx,cellIdx" to remove

  for (let col = 0; col < totalCols; col++) {
    for (let r = 0; r < numRows; r++) {
      const ref = grid[r][col];
      if (!ref) continue;
      if (ref.cell.vMergeType === 'restart') {
        let span = 1;
        for (let r2 = r + 1; r2 < numRows; r2++) {
          const ref2 = grid[r2][col];
          if (ref2 && ref2.cell.vMergeType === 'continue') {
            span++;
            continuationCells.add(r2 + ',' + ref2.cellIdx);
          } else {
            break;
          }
        }
        if (span > 1) {
          rowspanMap.set(r + ',' + ref.cellIdx, span);
        }
      }
    }
  }

  // Build cleaned rows
  const result: TableRow[] = [];
  for (let r = 0; r < numRows; r++) {
    const cells: TableCell[] = [];
    for (let ci = 0; ci < rawRows[r].cells.length; ci++) {
      if (continuationCells.has(r + ',' + ci)) continue;
      const raw = rawRows[r].cells[ci];
      const cell: TableCell = { paragraphs: raw.paragraphs };
      if (raw.colspan > 1) cell.colspan = raw.colspan;
      const rs = rowspanMap.get(r + ',' + ci);
      if (rs && rs > 1) cell.rowspan = rs;
      cells.push(cell);
    }
    result.push({ isHeader: rawRows[r].isHeader, cells });
  }

  return result;
}

export async function extractDocumentContent(
  data: Uint8Array | JSZip,
  zoteroCitations: ZoteroCitation[],
  keyMap: Map<string, string>,
  options?: {
    numberingDefs?: NumberingDefs;
    numberingStartOverrides?: NumberingStartOverrides;
    relationshipMap?: Map<string, string>;
    replyIds?: Set<string>;
    imageRelationships?: Map<string, string>;
    imageFolder?: string;
    portraitBreakOrdinals?: Set<number>;
    customStyles?: Record<string, CustomStyleDef>;
    /** Bookmark name → "noteKind:noteId" for resolving NOTEREF cross-reference fields. */
    footnoteCrossRefMap?: Map<string, string>;
  }
): Promise<DocumentContentResult> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/document.xml');
  if (!parsed) { return { content: [] }; }

  // Parse relationships and numbering definitions
  const relationshipMap = options?.relationshipMap ?? await parseRelationships(zip);
  const numberingResult = options?.numberingDefs ? { defs: options.numberingDefs, startOverrides: options.numberingStartOverrides ?? new Map() } : await parseNumberingDefinitions(zip);
  const numberingDefs = numberingResult.defs;
  const numberingStartOverrides = numberingResult.startOverrides;
  const replyIds = options?.replyIds;
  const imageRelMap = options?.imageRelationships ?? new Map<string, string>();
  const imageFolder = options?.imageFolder ?? '';
  const imageEntries: ImageExtractionEntry[] = [];
  const extractedImageFilenames = new Set<string>();

  // Build a lookup: instrText index -> ZoteroCitation (in order of appearance)
  let citationIdx = 0;

  const content: ContentItem[] = [];
  const activeComments = new Set<string>();
  const commentStartTargetIndex = new Map<string, { target: ContentItem[], index: number }>();
  let inField = false;
  let inCitationField = false;
  let inBibliographyField = false;
  let inNoterefField = false;
  let noterefInfo: { noteId: string; noteKind: 'footnote' | 'endnote' } | undefined;
  let fieldInstrParts: string[] = [];
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];
  let currentHref: string | undefined;
  let zoteroBiblData: ZoteroBiblData | undefined;
  const crossRefMap = options?.footnoteCrossRefMap;

  // Section detection state
  let sectionStartIndex = 0; // index into `content` where the current section started
  let sectionBreakOrdinal = 0; // counter for paragraph-level sectPr occurrences
  const portraitBreakOrdinals = options?.portraitBreakOrdinals;

  function walk(
    nodes: XmlNode[],
    currentFormatting: RunFormatting = DEFAULT_FORMATTING,
    target: ContentItem[] = content,
    inTableCell = false,
    currentRevision?: RevisionInfo
  ): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') { continue; }

        if (key === 'w:fldChar') {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'begin') {
            inField = true;
            fieldInstrParts = [];
            inCitationField = false;
            inBibliographyField = false;
            inNoterefField = false;
            noterefInfo = undefined;
          } else if (fldType === 'separate') {
            if (inField) {
              const instrText = fieldInstrParts.join('');
              if (instrText.includes('ZOTERO_ITEM')) {
                inCitationField = true;
                currentCitation = zoteroCitations[citationIdx++];
                citationTextParts = [];
              } else if (instrText.includes('ZOTERO_BIBL')) {
                inBibliographyField = true;
                // Extract bibliography JSON payload
                const jsonStart = instrText.indexOf('{');
                const jsonEnd = instrText.lastIndexOf('}');
                if (jsonStart >= 0 && jsonEnd > jsonStart) {
                  try {
                    const biblJson = JSON.parse(instrText.slice(jsonStart, jsonEnd + 1));
                    zoteroBiblData = {
                      uncited: biblJson?.uncited,
                      omitted: biblJson?.omitted,
                      custom: biblJson?.custom,
                    };
                  } catch { /* ignore parse errors */ }
                }
              } else if (instrText.includes('NOTEREF')) {
                // Cross-reference to a footnote/endnote bookmark.
                // Always suppress display text for NOTEREF fields (even when
                // the mapping is unavailable) to prevent stray "1" literals.
                inNoterefField = true;
                const noterefMatch = instrText.match(/NOTEREF\s+(\S+)/);
                if (noterefMatch && crossRefMap) {
                  const bkmkName = noterefMatch[1];
                  const resolved = crossRefMap.get(bkmkName);
                  if (resolved) {
                    const colonIdx = resolved.indexOf(':');
                    const noteKind = resolved.slice(0, colonIdx);
                    const noteId = resolved.slice(colonIdx + 1);
                    if (colonIdx !== -1 && noteId && (noteKind === 'footnote' || noteKind === 'endnote')) {
                      noterefInfo = { noteId, noteKind };
                    }
                  }
                }
              }
            }
          } else if (fldType === 'end') {
            if (inNoterefField && noterefInfo) {
              target.push({
                type: 'footnote_ref',
                noteId: noterefInfo.noteId,
                noteKind: noterefInfo.noteKind,
                commentIds: new Set(activeComments),
                ...(currentRevision ? { revision: currentRevision } : {}),
              });
            }
            if (inCitationField && currentCitation) {
              const pandocKeys = citationPandocKeys(currentCitation, keyMap);
              target.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(activeComments),
                pandocKeys,
                ...(currentRevision ? { revision: currentRevision } : {}),
              });
            }
            if (inBibliographyField) {
              target.push({ type: 'bibliography_marker' });
            }
            inField = false;
            inCitationField = false;
            inBibliographyField = false;
            inNoterefField = false;
            noterefInfo = undefined;
            currentCitation = undefined;
          }
        } else if (key === 'w:instrText' && inField) {
          fieldInstrParts.push(nodeText(asXmlNodes(node['w:instrText'])));
        } else if (key in REVISION_ELEMENTS) {
          const author = getAttr(node, 'author');
          const date = getAttr(node, 'date');
          const rev = { type: REVISION_ELEMENTS[key], author, date };
          if (Array.isArray(node[key])) walk(node[key], currentFormatting, target, inTableCell, rev);
        } else if (key === 'w:commentRangeStart') {
          const id = getAttr(node, 'id');
          if (!replyIds?.has(id)) {
            activeComments.add(id);
            commentStartTargetIndex.set(id, { target, index: target.length });
          }
        } else if (key === 'w:commentRangeEnd') {
          const id = getAttr(node, 'id');
          if (!replyIds?.has(id)) {
            // Check if any content item was created with this comment ID
            const startInfo = commentStartTargetIndex.get(id);
            if (startInfo && startInfo.target === target) {
              let found = false;
              for (let ci = startInfo.index; ci < target.length; ci++) {
                const item = target[ci];
                if ('commentIds' in item && item.commentIds?.has(id)) {
                  found = true;
                  break;
                }
              }
              if (!found) {
                // Zero-width comment range: emit a synthetic empty text item
                target.push({ type: 'text', text: '', formatting: currentFormatting, commentIds: new Set(activeComments), href: undefined });
              }
            }
            commentStartTargetIndex.delete(id);
            activeComments.delete(id);
          }
        } else if (key === 'w:footnoteReference') {
          const noteId = getAttr(node, 'id');
          if (noteId && noteId !== '0' && noteId !== '-1') {
            target.push({ type: 'footnote_ref', noteId, noteKind: 'footnote', commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
          }
        } else if (key === 'w:endnoteReference') {
          const noteId = getAttr(node, 'id');
          if (noteId && noteId !== '0' && noteId !== '-1') {
            target.push({ type: 'footnote_ref', noteId, noteKind: 'endnote', commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
          }
        } else if (key === 'w:hyperlink') {
          const rId = node?.[':@']?.['@_r:id'] ?? getAttr(node, 'id');
          const prevHref = currentHref;
          currentHref = relationshipMap.get(rId);
          if (Array.isArray(node[key])) { walk(node[key], currentFormatting, target, inTableCell, currentRevision); }
          currentHref = prevHref;
        } else if (key === 'w:tbl' && !inTableCell) {
          const tblChildren = asXmlNodes(node[key]);
          const rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> }> = [];
          const firstRowHeaderByLook = tableHasFirstRowHeader(tblChildren);
          for (const tr of tblChildren.filter((c) => c['w:tr'] !== undefined)) {
            const trChildren = asXmlNodes(tr['w:tr']);
            const cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> = [];
            for (const tc of trChildren.filter((c) => c['w:tc'] !== undefined)) {
              const tcChildren = asXmlNodes(tc['w:tc']);
              // Parse cell properties
              let colspan = 1;
              let vMergeType: 'restart' | 'continue' | undefined;
              const tcPrNode = tcChildren.find((c) => c['w:tcPr'] !== undefined);
              if (tcPrNode) {
                const tcPrChildren = asXmlNodes(tcPrNode['w:tcPr']);
                const gridSpanNode = tcPrChildren.find((c) => c['w:gridSpan'] !== undefined);
                if (gridSpanNode) {
                  const val = parseInt(getAttr(gridSpanNode, 'val'), 10);
                  if (val > 1) colspan = val;
                }
                const vMergeNode = tcPrChildren.find((c) => c['w:vMerge'] !== undefined);
                if (vMergeNode) {
                  const val = getAttr(vMergeNode, 'val');
                  vMergeType = val === 'restart' ? 'restart' : 'continue';
                }
              }
              const cellItems: ContentItem[] = [];
              walk(tcChildren, currentFormatting, cellItems, true, currentRevision);
              cells.push({ paragraphs: splitCellParagraphs(cellItems), colspan, vMergeType });
            }
            rawRows.push({ isHeader: rowHasHeaderProp(trChildren), cells });
          }
          if (firstRowHeaderByLook && rawRows.length > 0) {
            rawRows[0].isHeader = true;
          }
          const rows = computeRowspans(rawRows);
          if (rows.length > 0) {
            target.push({ type: 'table', rows });
          }
        } else if (key === 'w:r') {
          // Process run - extract formatting from w:rPr
          let runFormatting = currentFormatting;
          const runChildren = asXmlNodes(node[key]);
          let rPrChildren: XmlNode[] | undefined;
          for (const child of runChildren) {
            if (child['w:rPr']) {
              rPrChildren = asXmlNodes(child['w:rPr']);
              runFormatting = parseRunProperties(rPrChildren, currentFormatting);
              break;
            }
          }

          // Detect vanish runs carrying HTML comments (encoded with \u200B prefix).
          // LaTeX OMML hidden runs and other vanish runs without the prefix fall through.
          const hasVanish = rPrChildren?.some((c) => c['w:vanish'] !== undefined) ?? false;
          if (hasVanish) {
            // Collect text from w:t/w:delText elements in this run and preserve
            // explicit break elements so multiline hidden payloads survive.
            let runText = '';
            for (const child of runChildren) {
              if (child['w:t'] !== undefined) {
                runText += nodeText(asXmlNodes(child['w:t']));
              } else if (child['w:delText'] !== undefined) {
                runText += nodeText(asXmlNodes(child['w:delText']));
              } else if (child['w:br'] !== undefined || child['w:cr'] !== undefined) {
                runText += '\n';
              }
            }
            const hiddenPayload = runText.replace(/^\u200B+/, '');
            const lastItem = target.length > 0 ? target[target.length - 1] : undefined;
            const canContinueHiddenHtmlComment = lastItem?.type === 'html_comment'
              && commentSetsEqual(lastItem.commentIds, activeComments);
            if (hiddenPayload.trimStart().startsWith('<!--')) {
              const payload = hiddenPayload;
              target.push({
                type: 'html_comment',
                text: payload,
                commentIds: new Set(activeComments),
              });
              continue; // skip normal walk for this run
            }
            // Word may split a hidden HTML comment across many vanish runs on
            // save (first run "<!--", following runs for lines/breaks/"-->").
            // Reassemble contiguous hidden fragments into the preceding
            // html_comment item instead of dropping continuation runs.
            if (canContinueHiddenHtmlComment && hiddenPayload.length > 0) {
              lastItem.text += hiddenPayload;
              continue;
            }
            // Legacy backward-compat path: older exports stored internal
            // round-trip metadata in hidden \u200B-prefixed runs. Ignore and
            // strip those markers so they never leak into markdown output.
            if (hiddenPayload.startsWith('_bqg') || hiddenPayload.startsWith('_lic:') || hiddenPayload.startsWith('_lim:')) {
              continue;
            }
            // Hidden metadata markers are not user-visible content. This avoids
            // leaking internal sentinels when Word splits \u200B-prefixed runs.
            continue;
          }

          walk(runChildren, runFormatting, target, inTableCell, currentRevision);
        } else if (key === 'w:br') {
          // Line break within a run (Shift+Enter in Word).
          // Only emit for default/textWrapping breaks; skip page/column breaks.
          const brType = getAttr(node, 'type');
          if (!brType || brType === 'textWrapping') {
            if (!inBibliographyField && !inCitationField) {
              target.push({
                type: 'text',
                text: '\\\n',
                commentIds: new Set(activeComments),
                formatting: currentFormatting,
                ...(currentRevision ? { revision: currentRevision } : {}),
              });
            }
          }
        } else if (key === 'w:t' || key === 'w:delText') {
          const text = nodeText(asXmlNodes(node[key]));
          if (text) {
            if (inBibliographyField || inNoterefField) {
              // Skip display text inside ZOTERO_BIBL / NOTEREF fields
            } else if (inCitationField) {
              citationTextParts.push(text);
            } else {
              const textItem: ContentItem = { 
                type: 'text', 
                text, 
                commentIds: new Set(activeComments),
                formatting: currentFormatting,
                ...(currentRevision ? { revision: currentRevision } : {}),
              };
              if (currentHref) {
                textItem.href = currentHref;
              }
              target.push(textItem);
            }
          }
        } else if (key === 'w:p') {
          // Process paragraph - extract heading level, list metadata, and title style
          let headingLevel: number | undefined;
          let listMeta: ListMeta | undefined;
          let isTitle = false;
          let blockquoteLevel: number | undefined;
          let blockquoteIndentUnitTwips: 240 | 720 | undefined;
          let alertType: GfmAlertType | undefined;
          let isCodeBlock = false;
          let customStyle: string | undefined;
          let paragraphLeftIndentTwips: number | undefined;
          let paraFormatting = currentFormatting;
          let isSpacerParagraph = false;
          let isSectionBreakHandled = false;
          let paraMarkRevision: RevisionInfo | undefined;

          const paraChildren = asXmlNodes(node[key]);
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = asXmlNodes(child['w:pPr']);

              // Detect and skip spacer paragraphs: exact-height empty <w:p>
              // with inline left border and no pStyle, generated by
              // alertFirst/alertLast in md→docx for visual padding.
              // Signature: no pStyle, w:spacing line="1" lineRule="exact",
              // w:pBdr with w:left border.
              const hasPStyle = pPrChildren.some((c) => c['w:pStyle'] !== undefined);
              if (!hasPStyle) {
                const spacingNode = pPrChildren.find((c) => c['w:spacing'] !== undefined);
                const pBdrNode = pPrChildren.find((c) => c['w:pBdr'] !== undefined);
                if (spacingNode && pBdrNode) {
                  const lineVal = getAttr(spacingNode, 'line');
                  const lineRule = getAttr(spacingNode, 'lineRule');
                  const pBdrChildren = asXmlNodes(pBdrNode['w:pBdr']);
                  const hasLeftBorder = pBdrChildren.some((c) => c['w:left'] !== undefined);
                  if (lineVal === '1' && lineRule === 'exact' && hasLeftBorder) {
                    isSpacerParagraph = true;
                    break;
                  }
                }
              }

              // Detect section break (w:sectPr inside w:pPr)
              const sectPrNode = pPrChildren.find((c) => c['w:sectPr'] !== undefined);
              if (sectPrNode && !inTableCell) {
                const currentOrdinal = sectionBreakOrdinal++;
                const sectPrChildren = asXmlNodes(sectPrNode['w:sectPr']);
                const pgSzNode = sectPrChildren.find((c) => c['w:pgSz'] !== undefined);
                let isLandscapeSect = false;
                if (pgSzNode) {
                  const orient = getAttr(pgSzNode, 'orient');
                  const w = parseInt(getAttr(pgSzNode, 'w') || '0', 10);
                  const h = parseInt(getAttr(pgSzNode, 'h') || '0', 10);
                  isLandscapeSect = orient === 'landscape' || (w > 0 && h > 0 && w > h);
                }
                if (isLandscapeSect) {
                  // This paragraph ends a landscape section.
                  // Insert landscape_open at the start of this section.
                  target.splice(sectionStartIndex, 0, { type: 'landscape_open' });
                  // Walk paragraph children to capture any content in this paragraph
                  walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
                  // Push landscape_close after this paragraph
                  target.push({ type: 'landscape_close' });
                  sectionStartIndex = target.length;
                  isSectionBreakHandled = true;
                  break;
                }
                // Portrait section break: check if this ordinal is a portrait fence close
                if (portraitBreakOrdinals?.has(currentOrdinal)) {
                  target.splice(sectionStartIndex, 0, { type: 'portrait_open' });
                  walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
                  target.push({ type: 'portrait_close' });
                  sectionStartIndex = target.length;
                  isSectionBreakHandled = true;
                  break;
                }
                // Regular portrait section break: just update section start for next section
                // and skip this paragraph (it's typically an empty section-break carrier)
                sectionStartIndex = target.length;
                // Check if paragraph has any content runs (not just sectPr)
                const hasContent = paraChildren.some((c) => c['w:r'] !== undefined || c['w:hyperlink'] !== undefined);
                if (!hasContent) {
                  isSectionBreakHandled = true;
                  break;
                }
              }

              headingLevel = parseHeadingLevel(pPrChildren);
              listMeta = parseListMeta(pPrChildren, numberingDefs, numberingStartOverrides);
              isTitle = parseTitleStyle(pPrChildren);
              const blockquoteInfo = parseBlockquoteInfo(pPrChildren);
              blockquoteLevel = blockquoteInfo.level;
              blockquoteIndentUnitTwips = blockquoteInfo.indentUnitTwips;
              alertType = parseAlertType(pPrChildren);
              isCodeBlock = parseCodeBlockStyle(pPrChildren);
              customStyle = parseCustomStyleName(pPrChildren, options?.customStyles ?? undefined);
              paragraphLeftIndentTwips = parseParagraphLeftIndentTwips(pPrChildren);
              const pRPrElement = pPrChildren.find(pprChild => pprChild['w:rPr'] !== undefined);
              if (pRPrElement) {
                const pRPrChildren = asXmlNodes(pRPrElement['w:rPr']);
                paraFormatting = parseRunProperties(pRPrChildren, currentFormatting);
                // Paragraph-mark revision (w:ins/w:del inside pPr > rPr):
                // the whole paragraph was inserted/deleted as a unit.
                for (const rPrChild of pRPrChildren) {
                  const revKey = Object.keys(rPrChild).find(k => k in REVISION_ELEMENTS);
                  if (revKey) {
                    paraMarkRevision = {
                      type: REVISION_ELEMENTS[revKey],
                      author: getAttr(rPrChild, 'author'),
                      date: getAttr(rPrChild, 'date'),
                    };
                    break;
                  }
                }
              }
              break;
            }
          }
          if (isSpacerParagraph) {
            // Keep a structural-only boundary so adjacent same-type alerts remain
            // separate even when generated labels are disabled. Table cells cannot
            // contain alert groups, and their nested content bypasses top-level cleanup.
            if (!inTableCell) target.push({ type: 'para', isBlockquoteSpacer: true });
            continue;
          }
          if (isSectionBreakHandled) {
            continue;
          }

          // Skip paragraphs inside bibliography field — text is already suppressed,
          // but we must also suppress the para markers to avoid trailing blank lines.
          if (inBibliographyField) {
            // Still need to walk children so field end markers are processed
            walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
            continue;
          }

          // Always push a new para when heading/list/title/blockquote/codeblock metadata is present (so metadata
          // isn't silently dropped after empty paragraphs).  For plain paragraphs,
          // push only when the previous item isn't already a plain para separator.
          // If the previous para is structural (heading/list/title/blockquote/codeblock),
          // we must push a new plain para to preserve paragraph boundaries.
          const prevItem = target.length > 0 ? target[target.length - 1] : undefined;
          const prevIsCodeBlockPara = prevItem?.type === 'para' && prevItem.isCodeBlock;
          const prevIsStructuralPara = prevItem?.type === 'para' && (
            prevItem.headingLevel !== undefined ||
            prevItem.listMeta !== undefined ||
            prevItem.isTitle === true ||
            prevItem.isBlockquoteSpacer === true ||
            prevItem.blockquoteLevel !== undefined ||
            prevItem.isCodeBlock === true ||
            prevItem.customStyleName !== undefined
          );
          const needsPara = inTableCell || (headingLevel || listMeta || isTitle || blockquoteLevel || isCodeBlock || customStyle)
            ? true
            : target.length > 0 && (prevItem!.type !== 'para' || prevIsCodeBlockPara || prevIsStructuralPara);

          const targetLenBeforePara = target.length;
          if (needsPara) {
            const paraItem: ContentItem = { type: 'para' };
            if (headingLevel) paraItem.headingLevel = headingLevel;
            if (listMeta) paraItem.listMeta = listMeta;
            if (isTitle) paraItem.isTitle = true;
            if (blockquoteLevel) paraItem.blockquoteLevel = blockquoteLevel;
            if (blockquoteIndentUnitTwips) paraItem.blockquoteIndentUnitTwips = blockquoteIndentUnitTwips;
            if (alertType) paraItem.alertType = alertType;
            if (isCodeBlock) paraItem.isCodeBlock = true;
            if (customStyle) paraItem.customStyleName = customStyle;
            if (paragraphLeftIndentTwips !== undefined) paraItem.paragraphLeftIndentTwips = paragraphLeftIndentTwips;
            if (paraMarkRevision && headingLevel) paraItem.paraMarkRevision = paraMarkRevision;
            target.push(paraItem);
          }
          walk(paraChildren, paraFormatting, target, inTableCell, currentRevision);
          // If walking this paragraph's children entered a bibliography field
          // (i.e. the field-begin + separate markers were in this paragraph),
          // remove the para we just pushed — it would become a trailing blank line.
          if (inBibliographyField && needsPara && target.length > targetLenBeforePara) {
            target.splice(targetLenBeforePara, 1);
          } else if (needsPara) {
            const paraItem = target[targetLenBeforePara];
            if (
              paraItem?.type === 'para' &&
              target.length === targetLenBeforePara + 1 &&
              !paraItem.headingLevel &&
              !paraItem.listMeta &&
              !paraItem.isTitle &&
              !paraItem.blockquoteLevel &&
              !paraItem.isCodeBlock &&
              !paraItem.customStyleName
            ) {
              paraItem.emptyParagraphCount = 1;
              const prevItem = targetLenBeforePara > 0 ? target[targetLenBeforePara - 1] : undefined;
              if (
                prevItem?.type === 'para' &&
                prevItem.emptyParagraphCount !== undefined &&
                !prevItem.headingLevel &&
                !prevItem.listMeta &&
                !prevItem.isTitle &&
                !prevItem.blockquoteLevel &&
                !prevItem.isCodeBlock &&
                !prevItem.customStyleName
              ) {
                prevItem.emptyParagraphCount += paraItem.emptyParagraphCount;
                target.splice(targetLenBeforePara, 1);
              }
            }
          } else if (
            target.length === targetLenBeforePara &&
            !headingLevel &&
            !listMeta &&
            !isTitle &&
            !blockquoteLevel &&
            !isCodeBlock &&
            !customStyle
          ) {
            const prevItem = target.length > 0 ? target[target.length - 1] : undefined;
            if (
              prevItem?.type === 'para' &&
              prevItem.emptyParagraphCount !== undefined &&
              !prevItem.headingLevel &&
              !prevItem.listMeta &&
              !prevItem.isTitle &&
              !prevItem.blockquoteLevel &&
              !prevItem.isCodeBlock &&
              !prevItem.customStyleName
            ) {
              prevItem.emptyParagraphCount += 1;
            }
          }
        } else if (key === 'm:oMathPara') {
          // Display equation — extract m:oMath children from within
          const mathParaChildren = asXmlNodes(node[key]);
          const oMathNodes = mathParaChildren.filter((c) => c['m:oMath'] !== undefined);
          for (const oMathNode of oMathNodes) {
            try {
              const latex = ommlToLatex(asXmlNodes(oMathNode['m:oMath']));
              if (latex) {
                target.push({ type: 'math', latex, display: true, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
              }
            } catch {
              target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: true, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          }
        } else if (key === 'm:oMath') {
          // Inline equation
          const mathChildren = asXmlNodes(node[key]);
          try {
            const latex = ommlToLatex(mathChildren);
            if (latex) {
              target.push({ type: 'math', latex, display: false, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
            }
          } catch {
            target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: false, commentIds: new Set(activeComments), ...(currentRevision ? { revision: currentRevision } : {}) });
          }
        } else if (key === 'w:drawing') {
          // Image extraction from <w:drawing> containing <wp:inline> or <wp:anchor>
          const drawingChildren = asXmlNodes(node[key]);
          for (const child of drawingChildren) {
            const inlineOrAnchor = child['wp:inline'] || child['wp:anchor'];
            if (!inlineOrAnchor) continue;
            const elements = asXmlNodes(inlineOrAnchor);
            // Extract extent, docPr, and blip from the inline/anchor element
            let cx = 0, cy = 0, alt = '', docPrName = '', blipRId = '';
            for (const el of elements) {
              if (el['wp:extent'] !== undefined) {
                cx = parseInt(getAttr(el, 'cx') || '0', 10);
                cy = parseInt(getAttr(el, 'cy') || '0', 10);
              } else if (el['wp:docPr'] !== undefined) {
                alt = getAttr(el, 'descr') || '';
                docPrName = getAttr(el, 'name') || '';
              } else if (el['a:graphic'] !== undefined) {
                // Dig into a:graphic > a:graphicData > pic:pic > pic:blipFill > a:blip
                const graphicData = findAllDeep([el], 'a:graphicData');
                for (const gd of graphicData) {
                  const blips = findAllDeep([gd], 'a:blip');
                  for (const blip of blips) {
                    const embed = blip?.[':@']?.['@_r:embed'] ?? getAttr(blip, 'embed');
                    if (embed) blipRId = embed;
                  }
                }
              }
            }
            if (!blipRId) continue;
            const mediaPath = imageRelMap.get(blipRId);
            if (!mediaPath) continue;
            // Check supported format
            const mediaFilename = mediaPath.split('/').pop() || '';
            const ext = mediaFilename.split('.').pop()?.toLowerCase() || '';
            if (!isSupportedImageFormat(ext)) continue;
            const outputFilename = resolveImageFilename(docPrName, mediaFilename);
            const src = imageFolder ? imageFolder.replace(/\/$/, '') + '/' + outputFilename : outputFilename;
            const widthPx = cx > 0 ? emuToPixels(cx) : 0;
            const heightPx = cy > 0 ? emuToPixels(cy) : 0;
            target.push({
              type: 'image', rId: blipRId, src, alt,
              widthPx, heightPx, commentIds: new Set(activeComments),
              ...(currentRevision ? { revision: currentRevision } : {}),
            });
            if (!extractedImageFilenames.has(outputFilename)) {
              extractedImageFilenames.add(outputFilename);
              imageEntries.push({ rId: blipRId, mediaPath, outputFilename });
            }
          }
        } else if (Array.isArray(node[key])) {
          walk(node[key], currentFormatting, target, inTableCell, currentRevision);
        }
      }
    }
  }

  walk(parsed);
  return { content, zoteroBiblData, imageEntries: imageEntries.length > 0 ? imageEntries : undefined };
}

// Markdown generation

function formattingEquals(a: RunFormatting, b: RunFormatting): boolean {
  return a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.highlight === b.highlight &&
    a.highlightColor === b.highlightColor &&
    a.superscript === b.superscript &&
    a.subscript === b.subscript &&
    a.code === b.code;
}

function revisionsEqual(a: RevisionInfo | undefined, b: RevisionInfo | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.author === b.author && a.date === b.date;
}

// Avoid literal '$$' — tool text-replacement corrupts '$' in replacement
// strings. See CLAUDE.md "Template literal corruption" rule.
const MATH_FENCE = '$'.repeat(2);
function canonicalizeDisplayMathLatex(latex: string): string {
  const trimmed = latex.trim();
  const envMatch = trimmed.match(/^\\begin\{([a-zA-Z*]+)\}\s*([\s\S]*?)\s*\\end\{\1\}$/);
  if (!envMatch) return trimmed;
  const envName = envMatch[1];
  const multilineEnvs = new Set(['aligned', 'align', 'align*', 'gathered', 'cases']);
  if (!multilineEnvs.has(envName)) return trimmed;
  const inner = envMatch[2].trim();
  if (!inner) return `\\begin{${envName}}\n\\end{${envName}}`;
  const rows = inner.split(/\\\\/).map(row => row.trim()).filter(row => row.length > 0);
  if (rows.length === 0) return `\\begin{${envName}}\n\\end{${envName}}`;
  return `\\begin{${envName}}\n${rows.join(' \\\\\n')}\n\\end{${envName}}`;
}

function wrapWithRevision(text: string, rev?: RevisionInfo): string {
  if (!rev) return text;
  if (rev.type === 'addition') return `{++${text}++}`;
  if (rev.type === 'deletion') return `{--${text}--}`;
  return text;
}


function commentSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Render a CriticMarkup substitution `{~~old~>new~~}` when a deletion and
 *  addition of the same type are adjacent with matching author/date.
 *  Returns the substitution string, or `null` if the pair cannot be rendered
 *  as a substitution (e.g. unsupported type). */
function tryRenderSubstitution(
  deletion: ContentItem & { type: 'text' | 'citation' | 'math' },
  addition: ContentItem & { type: 'text' | 'citation' | 'math' },
  precedingText: string,
): string | null {
  if (deletion.type !== addition.type) return null;

  let oldText = '';
  if (deletion.type === 'text') {
    oldText = wrapWithFormatting(deletion.text, deletion.formatting);
    if (deletion.href) oldText = `[${oldText}](${formatHrefForMarkdown(deletion.href)})`;
  } else if (deletion.type === 'citation') {
    oldText = deletion.pandocKeys.length > 0
      ? (precedingText.endsWith(' ') ? '' : ' ') + '[' + deletion.pandocKeys.map(k => k.startsWith('-') ? '-@' + k.slice(1) : '@' + k).join('; ') + ']'
      : deletion.text;
  } else if (deletion.type === 'math') {
    oldText = deletion.display
      ? MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(deletion.latex) + '\n' + MATH_FENCE
      : '$' + deletion.latex + '$';
  }

  let newText = '';
  if (addition.type === 'text') {
    newText = wrapWithFormatting(addition.text, addition.formatting);
    if (addition.href) newText = `[${newText}](${formatHrefForMarkdown(addition.href)})`;
  } else if (addition.type === 'citation') {
    newText = addition.pandocKeys.length > 0
      ? (oldText.endsWith(' ') ? '' : ' ') + '[' + addition.pandocKeys.map(k => k.startsWith('-') ? '-@' + k.slice(1) : '@' + k).join('; ') + ']'
      : addition.text;
  } else if (addition.type === 'math') {
    newText = addition.display
      ? MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(addition.latex) + '\n' + MATH_FENCE
      : '$' + addition.latex + '$';
  }

  if (oldText && newText) {
    return '{~~' + oldText + '~>' + newText + '~~}';
  }
  return null;
}

function mergeConsecutiveRuns(content: ContentItem[]): ContentItem[] {
  const merged: ContentItem[] = [];
  let i = 0;

  while (i < content.length) {
    const item = content[i];
    
    if (item.type !== 'text') {
      merged.push(item);
      i++;
      continue;
    }

    let mergedText = item.text;
    let j = i + 1;
    
    while (j < content.length) {
      const next = content[j];
      if (next.type !== 'text' ||
          !formattingEquals(item.formatting, next.formatting) ||
          item.href !== next.href ||
          !commentSetsEqual(item.commentIds, next.commentIds) ||
          !revisionsEqual(item.revision, next.revision)) {
        break;
      }
      mergedText += next.text;
      j++;
    }

    merged.push({
      type: 'text',
      text: mergedText,
      commentIds: item.commentIds,
      formatting: item.formatting,
      href: item.href,
      ...(item.revision ? { revision: item.revision } : {}),
    });
    i = j;
  }

  return merged;
}

function renderInlineSegment(
  segment: ContentItem[],
  comments: Map<string, Comment>,
  renderOpts?: RenderOpts
): { text: string; deferredComments: string[] } {
  const result = renderInlineRange(segment, 0, comments, undefined, renderOpts);
  return {
    // Keep parity with paragraph-level emission behavior.
    text: result.text.replace(/(\\?\n)+$/, ''),
    deferredComments: result.deferredComments,
  };
}

/** Check whether any position in the segment has more than one active comment. */
function hasOverlappingComments(segment: ContentItem[]): boolean {
  const allIds = new Set<string>();
  for (const item of segment) {
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') && item.commentIds) {
      for (const id of item.commentIds) allIds.add(id);
    }
  }
  if (allIds.size <= 1) return false;

  // Two or more comment IDs exist — check if their ranges actually overlap
  // by seeing if any single run is covered by 2+ comments
  for (const item of segment) {
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') && item.commentIds) {
      if (item.commentIds.size > 1) return true;
    }
  }

  // Even if no single run has 2+, overlapping can occur if comment ranges
  // interleave across runs. Check via boundary analysis.
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let pos = 0;
  let prevIds = new Set<string>();
  for (const item of segment) {
    if (item.type !== 'text' && item.type !== 'citation' && item.type !== 'footnote_ref' && item.type !== 'math' && item.type !== 'html_comment' && item.type !== 'image') { pos++; continue; }
    if (!item.commentIds) { pos++; continue; }
    const ids = item.commentIds;
    for (const id of ids) {
      if (!prevIds.has(id)) starts.set(id, Math.min(starts.get(id) ?? pos, pos));
    }
    for (const id of prevIds) {
      if (!ids.has(id)) ends.set(id, Math.max(ends.get(id) ?? pos, pos));
    }
    prevIds = ids;
    pos++;
  }
  for (const id of prevIds) {
    if (!ends.has(id)) {
      ends.set(id, pos);
    }
  }

  // Check if any pair of comment ranges overlaps
  const ranges = [...allIds].map(id => ({ id, start: starts.get(id) ?? 0, end: ends.get(id) ?? 0 }));
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      if (ranges[a].start < ranges[b].end && ranges[b].start < ranges[a].end) {
        return true;
      }
    }
  }
  return false;
}

function formatDateSuffix(date: string | undefined): string {
  if (!date) return '';
  try {
    return ` (${formatLocalIsoMinute(date)})`;
  } catch { return ` (${date})`; }
}

function formatCommentAttribution(author: string | undefined, date: string | undefined, text: string): string {
  const trimmedAuthor = (author || '').trim();
  if (!trimmedAuthor) return text;
  return '@' + trimmedAuthor + formatDateSuffix(date) + ' | ' + text;
}

function formatCommentBody(_cid: string, c: Comment): string {
  if (c.consecutiveReplies && c.replies && c.replies.length > 0) {
    // Consecutive format: each reply is a separate {>>...<<} block
    let body = `{>>${formatCommentAttribution(c.author, c.date, c.text)}<<}`;
    for (const reply of c.replies) {
      body += `{>>${formatCommentAttribution(reply.author, reply.date, reply.text)}<<}`;
    }
    return body;
  }
  let body = `{>>${formatCommentAttribution(c.author, c.date, c.text)}`;
  if (c.replies && c.replies.length > 0) {
    for (const reply of c.replies) {
      body += `\n  {>>${formatCommentAttribution(reply.author, reply.date, reply.text)}<<}`;
    }
    body += '\n<<}';
  } else {
    body += '<<}';
  }
  return body;
}

function formatCommentBodyWithId(cid: string, c: Comment): string {
  if (c.consecutiveReplies && c.replies && c.replies.length > 0) {
    // Consecutive format: each reply is a separate {>>...<<} block
    let body = `{#${cid}>>${formatCommentAttribution(c.author, c.date, c.text)}<<}`;
    for (const reply of c.replies) {
      body += `{>>${formatCommentAttribution(reply.author, reply.date, reply.text)}<<}`;
    }
    return body;
  }
  let body = `{#${cid}>>${formatCommentAttribution(c.author, c.date, c.text)}`;
  if (c.replies && c.replies.length > 0) {
    for (const reply of c.replies) {
      body += `\n  {>>${formatCommentAttribution(reply.author, reply.date, reply.text)}<<}`;
    }
    body += '\n<<}';
  } else {
    body += '<<}';
  }
  return body;
}

function computeSegmentEnd(
  segment: ContentItem[],
  startIndex: number,
  opts?: { stopBeforeDisplayMath?: boolean }
): number {
  let idx = startIndex;
  while (idx < segment.length) {
    const item = segment[idx];
    if (item.type === 'para' || item.type === 'table' || item.type === 'landscape_open' || item.type === 'landscape_close' || item.type === 'portrait_open' || item.type === 'portrait_close' || item.type === 'bibliography_marker' || item.type === 'custom_style_open' || item.type === 'custom_style_close') break;
    if (opts?.stopBeforeDisplayMath && item.type === 'math' && item.display) break;
    idx++;
  }
  return idx;
}

function renderInlineRange(
  segment: ContentItem[],
  startIndex: number,
  comments: Map<string, Comment>,
  opts?: { stopBeforeDisplayMath?: boolean },
  renderOpts?: RenderOpts
): { text: string; nextIndex: number; deferredComments: string[] } {
  let out = '';
  let i = startIndex;

  // Determine if we should use ID-based syntax for this inline segment only
  const segmentEnd = computeSegmentEnd(segment, startIndex, opts);
  const forceIdCommentIds = renderOpts?.forceIdCommentIds;
  const hasForcedIdCommentInSegment = !!forceIdCommentIds && [...segment.slice(startIndex, segmentEnd)].some(item => (
    (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') &&
    item.commentIds && [...item.commentIds].some(id => forceIdCommentIds.has(id))
  ));
  const useIds = renderOpts?.alwaysUseCommentIds || hasForcedIdCommentInSegment || hasOverlappingComments(segment.slice(startIndex, segmentEnd));

  if (useIds) {
    return renderInlineRangeWithIds(segment, startIndex, comments, opts, renderOpts?.commentIdRemap, renderOpts?.emittedIdCommentBodies, renderOpts?.noteLabels, renderOpts?.imageFormatMapping);
  }

  while (i < segment.length) {
    const item = segment[i];
    if (i >= segmentEnd) break;

    // Detect substitution: a deletion followed immediately by an addition
    // with identical author and date. Skip if either item has comments to
    // avoid unbalancing comment markers.
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'math') && item.revision?.type === 'deletion' && item.commentIds.size === 0) {
      const next = segment[i + 1];
      if (next && next.type === item.type && (next.type === 'text' || next.type === 'citation' || next.type === 'math') &&
          next.revision?.type === 'addition' &&
          next.revision.author === item.revision.author &&
          next.revision.date === item.revision.date &&
          next.commentIds.size === 0) {

        const result = tryRenderSubstitution(item, next, out);
        if (result !== null) {
          out += result;
          i += 2;
          continue;
        }
      }
    }

    if (item.type === 'citation') {
      let citeText: string;
      if (item.pandocKeys.length > 0) {
        const citeSep = out.endsWith(' ') ? '' : ' ';
        citeText = citeSep + '[' + item.pandocKeys.map(k => k.startsWith('-') ? '-@' + k.slice(1) : '@' + k).join('; ') + ']';
      } else {
        citeText = item.text;
      }
      out += wrapWithRevision(citeText, item.revision);
      i++;
      continue;
    }

    if (item.type === 'math') {
      // Check if this inline math is between bold/italic text items that share
      // formatting. If so, the caller (text rendering below) already handled it
      // as part of a formatting group. If not, emit standalone.
      const mathText = item.display ? MATH_FENCE + '\n' + item.latex + '\n' + MATH_FENCE : '$' + item.latex + '$';
      out += wrapWithRevision(mathText, item.revision);
      i++;
      continue;
    }

    if (item.type === 'footnote_ref') {
      const noteKey = item.noteKind + ':' + item.noteId;
      const label = renderOpts?.noteLabels?.get(noteKey) ?? item.noteId;
      out += wrapWithRevision(`[^${label}]`, item.revision);
      i++;
      continue;
    }

    if (item.type === 'image') {
      const syntax = renderOpts?.imageFormatMapping?.get(item.rId) || 'md';
      let imgText: string;
      if (syntax === 'html') {
        imgText = '<img src="' + escapeHtmlAttr(item.src) + '" alt="' + escapeHtmlAttr(item.alt) + '"';
        if (item.widthPx > 0) imgText += ' width="' + item.widthPx + '"';
        if (item.heightPx > 0) imgText += ' height="' + item.heightPx + '"';
        imgText += '>';
      } else {
        const safeAlt = item.alt.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        imgText = '![' + safeAlt + '](' + formatHrefForMarkdown(item.src) + ')';
        if (item.widthPx > 0 || item.heightPx > 0) {
          const parts: string[] = [];
          if (item.widthPx > 0) parts.push('width=' + item.widthPx);
          if (item.heightPx > 0) parts.push('height=' + item.heightPx);
          imgText += '{' + parts.join(' ') + '}';
        }
      }
      out += wrapWithRevision(imgText, item.revision);
      if (item.commentIds.size > 0) {
        for (const cid of [...item.commentIds].sort()) {
          const c = comments.get(cid);
          if (!c) continue;
          out += formatCommentBody(cid, c);
        }
      }
      i++;
      continue;
    }

    // html_comment: emit the raw <!-- ... --> syntax directly
    if (item.type === 'html_comment') {
      out += item.text;
      if (item.commentIds.size > 0) {
        for (const cid of [...item.commentIds].sort()) {
          const c = comments.get(cid);
          if (!c) { continue; }
          out += formatCommentBody(cid, c);
        }
      }
      i++;
      continue;
    }

    if (item.type !== 'text') {
      i++;
      continue;
    }

    if (item.commentIds.size > 0) {
      const commentSet = item.commentIds;
      const groupedCommentText: string[] = [];
      let j = i;

      while (j < segment.length) {
        const seg = segment[j];
        if (seg.type !== 'text' || !commentSetsEqual(seg.commentIds, commentSet)) {
          break;
        }
        // IMPORTANT: Do NOT suppress highlights here. The outer {==...==} is CriticMarkup
        // comment syntax, while ==text== is color-highlight syntax. They are semantically
        // distinct: Word text that is both highlighted AND commented needs both layers,
        // producing {====text====} (highlight nested inside comment delimiters).
        let segText = wrapWithFormatting(seg.text, seg.formatting);
        if (seg.href) {
          if (seg.text !== seg.href || hasFormatting(seg.formatting)) {
            segText = `[${segText}](${formatHrefForMarkdown(seg.href)})`;
          }
        }
        segText = wrapWithRevision(segText, seg.revision);
        groupedCommentText.push(segText);
        j++;
      }

      const anchorText = groupedCommentText.join('');
      if (anchorText) {
        out += `{==${anchorText}==}`;
      }
      for (const cid of [...commentSet].sort()) {
        const c = comments.get(cid);
        if (!c) { continue; }
        out += formatCommentBody(cid, c);
      }

      i = j;
      continue;
    }

    // Hard line breaks must not be wrapped in formatting markers (e.g. **\\\n**)
    // because the backslash must be the final character on its line.
    if (item.text === '\\\n') {
      out += '\\\n';
      i++;
      continue;
    }

    // Detect formatting groups: text items with bold/italic interspersed with
    // inline math. Emit shared formatting markers around the entire group so
    // that e.g. **Ex. 1: $y = Y$ and $k = 1$** stays as one bold run.
    if ((item.formatting.bold || item.formatting.italic) && !item.revision && !item.href && item.commentIds.size === 0) {
      // Look ahead: collect text+math items that form a formatting group
      let groupEnd = i + 1;
      while (groupEnd < segmentEnd) {
        const next = segment[groupEnd];
        if (next.type === 'math' && !next.display && !next.revision && next.commentIds.size === 0) {
          groupEnd++;
          continue;
        }
        if (next.type === 'text' && !next.revision && !next.href && next.commentIds.size === 0 &&
            next.formatting.bold === item.formatting.bold &&
            next.formatting.italic === item.formatting.italic &&
            next.text !== '\\\n') {
          groupEnd++;
          continue;
        }
        break;
      }
      // Only use group rendering if there's actually math interspersed
      const hasMathInGroup = groupEnd > i + 1 && segment.slice(i, groupEnd).some(it => it.type === 'math');
      if (hasMathInGroup) {
        // Render the group: apply bold/italic around everything, inner formatting per-text-item
        let groupText = '';
        for (let g = i; g < groupEnd; g++) {
          const gItem = segment[g];
          if (gItem.type === 'math' && !gItem.display) {
            groupText += '$' + gItem.latex + '$';
          } else if (gItem.type === 'text') {
            // Apply inner formatting (everything except bold/italic which wraps the group)
            const innerFmt: RunFormatting = { ...gItem.formatting, bold: false, italic: false };
            groupText += wrapWithFormatting(gItem.text, innerFmt);
          }
        }
        if (item.formatting.italic) groupText = wrapMarkdownDelimited(groupText, '*');
        if (item.formatting.bold) groupText = wrapMarkdownDelimited(groupText, '**');
        out += groupText;
        i = groupEnd;
        continue;
      }
    }

    if (item.href) {
      // Bare URL autolink: if the link text equals the URL (no formatting), emit bare text.
      // Bare email autolink: if href is mailto:text (no formatting), emit bare text.
      const isBareUrl = item.text === item.href && !hasFormatting(item.formatting);
      const isBareEmail = item.href === 'mailto:' + item.text && !hasFormatting(item.formatting);
      if (isBareUrl || isBareEmail) {
        out += wrapWithRevision(item.text, item.revision);
      } else {
        const formattedText = wrapWithFormatting(item.text, item.formatting);
        out += wrapWithRevision('[' + formattedText + '](' + formatHrefForMarkdown(item.href) + ')', item.revision);
      }
    } else {
      out += wrapWithRevision(wrapWithFormatting(item.text, item.formatting), item.revision);
    }
    i++;
  }
  return { text: out, nextIndex: i, deferredComments: [] };
}

/** Render inline content using ID-based comment syntax ({#id}...{/id}).
 *  Comment bodies are deferred (not emitted inline) and returned separately. */
function renderInlineRangeWithIds(
  segment: ContentItem[],
  startIndex: number,
  comments: Map<string, Comment>,
  opts?: { stopBeforeDisplayMath?: boolean },
  commentIdRemap?: Map<string, string>,
  emittedIdCommentBodies?: Set<string>,
  noteLabels?: Map<string, string>,
  imageFormatMapping?: Map<string, string>
): { text: string; nextIndex: number; deferredComments: string[] } {
  let out = '';
  let i = startIndex;
  let prevCommentIds = new Set<string>();
  const collectedBodies = new Set<string>();
  const deferred: Array<{ remappedId: string; body: string }> = [];
  const segmentEnd = computeSegmentEnd(segment, startIndex, opts);

  const remap = (id: string) => commentIdRemap?.get(id) ?? id;

  function collectBody(cid: string): void {
    if (collectedBodies.has(cid)) return;
    if (emittedIdCommentBodies?.has(cid)) return;
    const c = comments.get(cid);
    if (!c) return;
    collectedBodies.add(cid);
    emittedIdCommentBodies?.add(cid);
    deferred.push({ remappedId: remap(cid), body: formatCommentBodyWithId(remap(cid), c) });
  }

  while (i < segment.length) {
    const item = segment[i];
    if (i >= segmentEnd) break;

    // Detect substitution: a deletion followed immediately by an addition
    // with identical author and date. Skip if comment context differs to
    // avoid unbalancing comment markers.
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'math') && item.revision?.type === 'deletion') {
      const next = segment[i + 1];
      if (next && next.type === item.type && (next.type === 'text' || next.type === 'citation' || next.type === 'math') &&
          next.revision?.type === 'addition' &&
          next.revision.author === item.revision.author &&
          next.revision.date === item.revision.date &&
          commentSetsEqual(item.commentIds, prevCommentIds) &&
          commentSetsEqual(next.commentIds, prevCommentIds)) {

        const result = tryRenderSubstitution(item, next, out);
        if (result !== null) {
          out += result;
          i += 2;
          continue;
        }
      }
    }

    if (item.type === 'citation') {
      const currentIds = item.commentIds;
      for (const cid of [...prevCommentIds].sort()) {
        if (!currentIds.has(cid)) {
          out += `{/${remap(cid)}}`;
          collectBody(cid);
        }
      }
      for (const cid of [...currentIds].sort()) {
        if (!prevCommentIds.has(cid)) {
          out += `{#${remap(cid)}}`;
        }
      }
      prevCommentIds = new Set(currentIds);

      let citeText: string;
      if (item.pandocKeys.length > 0) {
        const citeSep = out.endsWith(' ') ? '' : ' ';
        citeText = citeSep + '[' + item.pandocKeys.map(k => k.startsWith('-') ? '-@' + k.slice(1) : '@' + k).join('; ') + ']';
      } else {
        citeText = item.text;
      }
      out += wrapWithRevision(citeText, item.revision);
      i++;
      continue;
    }

    if (item.type === 'math') {
      const currentIds = item.commentIds;
      for (const cid of [...prevCommentIds].sort()) {
        if (!currentIds.has(cid)) {
          out += `{/${remap(cid)}}`;
          collectBody(cid);
        }
      }
      for (const cid of [...currentIds].sort()) {
        if (!prevCommentIds.has(cid)) {
          out += `{#${remap(cid)}}`;
        }
      }
      prevCommentIds = new Set(currentIds);

      const mathText = item.display ? MATH_FENCE + '\n' + item.latex + '\n' + MATH_FENCE : '$' + item.latex + '$';
      out += wrapWithRevision(mathText, item.revision);
      i++;
      continue;
    }

    if (item.type === 'footnote_ref') {
      const currentIds = item.commentIds;
      for (const cid of [...prevCommentIds].sort()) {
        if (!currentIds.has(cid)) {
          out += `{/${remap(cid)}}`;
          collectBody(cid);
        }
      }
      for (const cid of [...currentIds].sort()) {
        if (!prevCommentIds.has(cid)) {
          out += `{#${remap(cid)}}`;
        }
      }
      prevCommentIds = new Set(currentIds);
      const noteKey = item.noteKind + ':' + item.noteId;
      const label = noteLabels?.get(noteKey) ?? item.noteId;
      out += wrapWithRevision(`[^${label}]`, item.revision);
      i++;
      continue;
    }

    // image: emit with comment ID tracking
    if (item.type === 'image') {
      const currentIds = item.commentIds;
      for (const cid of [...prevCommentIds].sort()) {
        if (!currentIds.has(cid)) {
          out += `{/${remap(cid)}}`;
          collectBody(cid);
        }
      }
      for (const cid of [...currentIds].sort()) {
        if (!prevCommentIds.has(cid)) {
          out += `{#${remap(cid)}}`;
        }
      }
      prevCommentIds = new Set(currentIds);
      const syntax = imageFormatMapping?.get(item.rId) || 'md';
      let imgText: string;
      if (syntax === 'html') {
        imgText = '<img src="' + escapeHtmlAttr(item.src) + '" alt="' + escapeHtmlAttr(item.alt) + '"';
        if (item.widthPx > 0) imgText += ' width="' + item.widthPx + '"';
        if (item.heightPx > 0) imgText += ' height="' + item.heightPx + '"';
        imgText += '>';
      } else {
        const safeAlt = item.alt.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        imgText = '![' + safeAlt + '](' + formatHrefForMarkdown(item.src) + ')';
        if (item.widthPx > 0 || item.heightPx > 0) {
          const parts: string[] = [];
          if (item.widthPx > 0) parts.push('width=' + item.widthPx);
          if (item.heightPx > 0) parts.push('height=' + item.heightPx);
          imgText += '{' + parts.join(' ') + '}';
        }
      }
      out += wrapWithRevision(imgText, item.revision);
      i++;
      continue;
    }

    // html_comment: emit raw <!-- ... --> with comment ID tracking
    if (item.type === 'html_comment') {
      const currentIds = item.commentIds;
      for (const cid of [...prevCommentIds].sort()) {
        if (!currentIds.has(cid)) {
          out += `{/${remap(cid)}}`;
          collectBody(cid);
        }
      }
      for (const cid of [...currentIds].sort()) {
        if (!prevCommentIds.has(cid)) {
          out += `{#${remap(cid)}}`;
        }
      }
      prevCommentIds = new Set(currentIds);
      out += item.text;
      i++;
      continue;
    }

    if (item.type !== 'text') {
      i++;
      continue;
    }

    const currentIds = item.commentIds;

    for (const cid of [...prevCommentIds].sort()) {
      if (!currentIds.has(cid)) {
        out += `{/${remap(cid)}}`;
        collectBody(cid);
      }
    }

    for (const cid of [...currentIds].sort()) {
      if (!prevCommentIds.has(cid)) {
        out += `{#${remap(cid)}}`;
      }
    }

    prevCommentIds = new Set(currentIds);

    // Hard line breaks must not be wrapped in formatting markers (e.g. **\\\n**)
    // because the backslash must be the final character on its line.
    if (item.text === '\\\n') {
      out += '\\\n';
      i++;
      continue;
    }

    // Detect formatting groups: text items with bold/italic interspersed with
    // inline math (same logic as renderInlineRange).
    if ((item.formatting.bold || item.formatting.italic) && !item.revision && !item.href && item.commentIds.size === 0) {
      let groupEnd = i + 1;
      while (groupEnd < segmentEnd) {
        const next = segment[groupEnd];
        if (next.type === 'math' && !next.display && !next.revision && next.commentIds.size === 0) {
          groupEnd++;
          continue;
        }
        if (next.type === 'text' && !next.revision && !next.href && next.commentIds.size === 0 &&
            next.formatting.bold === item.formatting.bold &&
            next.formatting.italic === item.formatting.italic &&
            next.text !== '\\\n') {
          groupEnd++;
          continue;
        }
        break;
      }
      const hasMathInGroup = groupEnd > i + 1 && segment.slice(i, groupEnd).some(it => it.type === 'math');
      if (hasMathInGroup) {
        let groupText = '';
        for (let g = i; g < groupEnd; g++) {
          const gItem = segment[g];
          if (gItem.type === 'math' && !gItem.display) {
            groupText += '$' + gItem.latex + '$';
          } else if (gItem.type === 'text') {
            const innerFmt: RunFormatting = { ...gItem.formatting, bold: false, italic: false };
            groupText += wrapWithFormatting(gItem.text, innerFmt);
          }
        }
        if (item.formatting.italic) groupText = wrapMarkdownDelimited(groupText, '*');
        if (item.formatting.bold) groupText = wrapMarkdownDelimited(groupText, '**');
        out += groupText;
        i = groupEnd;
        continue;
      }
    }

    if (item.href) {
      const isBareUrl = item.text === item.href && !hasFormatting(item.formatting);
      const isBareEmail = item.href === 'mailto:' + item.text && !hasFormatting(item.formatting);
      if (isBareUrl || isBareEmail) {
        out += wrapWithRevision(item.text, item.revision);
      } else {
        const formattedText = wrapWithFormatting(item.text, item.formatting);
        out += wrapWithRevision('[' + formattedText + '](' + formatHrefForMarkdown(item.href) + ')', item.revision);
      }
    } else {
      out += wrapWithRevision(wrapWithFormatting(item.text, item.formatting), item.revision);
    }
    i++;
  }

  // Close any remaining open comments
  for (const cid of [...prevCommentIds].sort()) {
    out += `{/${remap(cid)}}`;
    collectBody(cid);
  }

  // Sort deferred comments by remapped ID (numeric then lexicographic)
  deferred.sort((a, b) => {
    const na = parseInt(a.remappedId, 10);
    const nb = parseInt(b.remappedId, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.remappedId.localeCompare(b.remappedId);
  });

  return { text: out, nextIndex: i, deferredComments: deferred.map(d => d.body) };
}

function renderHtmlTable(table: { rows: TableRow[] }, comments: Map<string, Comment>, indent: string = '  ', renderOpts?: RenderOpts, extraAttrs: string = ''): string {
  const i1 = indent;  // tr level
  const i2 = indent + indent;  // td/th level
  const i3 = indent + indent + indent;  // content level
  const lines: string[] = ['<table' + extraAttrs + '>'];
  for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
    const row = table.rows[rowIdx];
    lines.push(i1 + '<tr>');
    for (const cell of row.cells) {
      const tag = row.isHeader ? 'th' : 'td';
      let attrs = '';
      if (cell.colspan && cell.colspan > 1) attrs += ' colspan="' + cell.colspan + '"';
      if (cell.rowspan && cell.rowspan > 1) attrs += ' rowspan="' + cell.rowspan + '"';
      lines.push(i2 + '<' + tag + attrs + '>');
      for (const para of cell.paragraphs) {
        const rendered = renderInlineSegment(mergeConsecutiveRuns(para), comments, renderOpts);
        lines.push(i3 + '<p>' + rendered.text + '</p>');
        if (rendered.deferredComments.length > 0) {
          lines.push(i3 + rendered.deferredComments.join('\n' + i3));
        }
      }
      lines.push(i2 + '</' + tag + '>');
    }
    lines.push(i1 + '</tr>');
  }
  lines.push('</table>');
  return lines.join('\n');
}

type RenderOpts = { alwaysUseCommentIds?: boolean; commentIdRemap?: Map<string, string>; forceIdCommentIds?: Set<string>; emittedIdCommentBodies?: Set<string>; noteLabels?: Map<string, string>; imageFormatMapping?: Map<string, string>; noteImageFormatMapping?: Map<string, string>; tableFormatMapping?: Map<string, string>; pipeTableAlignedMapping?: Map<string, string>; gridSourceColWidthsMapping?: Map<string, string>; tableFontSizeMapping?: Map<string, string>; tableFontMapping?: Map<string, string>; tableColWidthsMapping?: Map<string, string>; tableDigitsMapping?: Map<string, string>; tableDecimalMarkMapping?: Map<string, string>; tableDigitGroupingMapping?: Map<string, string>; landscapeTableIndices?: Set<number>; portraitTableIndices?: Set<number>; embedDirectiveMapping?: Map<string, string> };

// East Asian Wide / Fullwidth code-point ranges (UAX #11).  Characters in
// these ranges occupy two terminal columns; everything else is treated as
// single-width.  This is intentionally conservative — zero-width joiners,
// combining marks, etc. are counted as width-1 which is acceptable for the
// "does the pipe table fit?" heuristic.
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK Radicals, Kangxi, Symbols
    (cp >= 0x3040 && cp <= 0x33bf) ||  // Hiragana, Katakana, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Extension A
    (cp >= 0x4e00 && cp <= 0xa4cf) ||  // CJK Unified, Yi
    (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe6f) ||  // Vertical forms, CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) ||  // Fullwidth Latin/Symbols
    (cp >= 0xffe0 && cp <= 0xffe6) ||  // Fullwidth Signs
    (cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji & symbols
    (cp >= 0x20000 && cp <= 0x2ffff) || // CJK Extension B–F
    (cp >= 0x30000 && cp <= 0x3ffff)    // CJK Extension G+
  );
}

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    width += isFullWidth(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Try to render a table as a GFM pipe table. Returns null if the table is
 * ineligible (spans, multi-paragraph cells, newlines in content, or width
 * exceeding the limit). Rendering and eligibility checking are combined into
 * one pass so that renderInlineSegment side-effects (e.g. emittedIdCommentBodies)
 * are not duplicated.
 */
function tryRenderPipeTable(table: { rows: TableRow[] }, maxLineWidth: number, comments: Map<string, Comment>, renderOpts?: RenderOpts, aligned?: boolean): string | null {
  if (maxLineWidth <= 0) return null;
  const rows = table.rows;
  if (rows.length === 0) return null;

  // Structural checks first (no side effects)
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.colspan && cell.colspan > 1) return null;
      if (cell.rowspan && cell.rowspan > 1) return null;
      if (cell.paragraphs.length > 1) return null;
    }
  }

  const numCols = Math.max(...rows.map(r => r.cells.length));

  // GFM pipe tables support exactly one header row (the first).  Bail out if
  // the DOCX marks multiple header rows or a non-first row as header.
  const explicitHeaderRows = rows.reduce((n, r) => n + (r.isHeader ? 1 : 0), 0);
  if (explicitHeaderRows > 1) return null;
  if (explicitHeaderRows === 1 && !rows[0].isHeader) return null;

  // Snapshot emittedIdCommentBodies so we can restore on fallback.
  // renderInlineSegment marks deferred comment bodies as emitted; if we
  // bail out after rendering (newline or width), the HTML path must be
  // able to re-render them.
  const emittedSnapshot = renderOpts?.emittedIdCommentBodies
    ? new Set(renderOpts.emittedIdCommentBodies) : undefined;
  const rollback = () => {
    if (emittedSnapshot && renderOpts?.emittedIdCommentBodies) {
      renderOpts.emittedIdCommentBodies.clear();
      for (const v of emittedSnapshot) renderOpts.emittedIdCommentBodies.add(v);
    }
  };

  // Render all cell contents (single pass — side effects happen here)
  const rendered: { text: string; deferred: string[] }[][] = [];
  for (const row of rows) {
    const rowCells: { text: string; deferred: string[] }[] = [];
    for (const cell of row.cells) {
      if (cell.paragraphs.length > 0) {
        // Strip auto-bold from header row cells — md-to-docx forces bold on
        // header cells, so we undo it here to avoid spurious **...** on round-trip.
        const items = row.isHeader
          ? cell.paragraphs[0].map(item =>
              item.type === 'text' && item.formatting?.bold
                ? { ...item, formatting: { ...item.formatting, bold: false } }
                : item)
          : cell.paragraphs[0];
        const r = renderInlineSegment(mergeConsecutiveRuns(items), comments, renderOpts);
        if (r.text.includes('\n')) { rollback(); return null; }
        // Escape pipes for GFM table cells: \| in source must become \\\| (escaped
        // backslash + escaped pipe); bare | must become \|. Single-pass callback
        // avoids double-escape issues with two-step approaches.
        const escaped = r.text.replace(/\\?\|/g, m => m.length === 2 ? '\\\\\\|' : '\\|');
        rowCells.push({ text: escaped, deferred: r.deferredComments });
      } else {
        rowCells.push({ text: '', deferred: [] });
      }
    }
    while (rowCells.length < numCols) {
      rowCells.push({ text: '', deferred: [] });
    }
    rendered.push(rowCells);
  }

  // Check row widths (using display width to account for wide characters)
  for (const rowCells of rendered) {
    // | + (space + content + space + |) per cell
    let width = 1;
    for (const c of rowCells) {
      width += 1 + getDisplayWidth(c.text) + 1 + 1; // space + content + space + |
    }
    if (width > maxLineWidth) { rollback(); return null; }
  }

  // Separator row: | --- | --- | ... | — each column occupies 6 chars
  const separatorWidth = 1 + numCols * 6;
  if (separatorWidth > maxLineWidth) { rollback(); return null; }

  // Build pipe table lines
  const lines: string[] = [];
  const deferredAll: string[] = [];

  // Compute column widths for aligned mode
  let colWidths: number[] | undefined;
  if (aligned) {
    colWidths = new Array(numCols).fill(3); // minimum separator width
    for (const row of rendered) {
      for (let ci = 0; ci < row.length; ci++) {
        const w = getDisplayWidth(row[ci].text);
        if (w > colWidths[ci]) colWidths[ci] = w;
      }
    }
  }

  const formatPipeRow = (cells: { text: string; deferred: string[] }[]): string => {
    let line = '|';
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      if (colWidths) {
        const pad = colWidths[ci] - getDisplayWidth(c.text);
        line += ' ' + c.text + ' '.repeat(pad) + ' |';
      } else if (c.text.length === 0) {
        line += ' |';
      } else {
        line += ' ' + c.text + ' |';
      }
    }
    return line;
  };

  // GFM pipe tables always require a header row. If the DOCX table has no
  // header signal, the first row is promoted — an accepted round-trip trade-off.
  const headerCells = rendered[0];
  lines.push(formatPipeRow(headerCells));
  for (const c of headerCells) deferredAll.push(...c.deferred);

  if (colWidths) {
    let sep = '|';
    for (let ci = 0; ci < numCols; ci++) {
      sep += '-'.repeat(colWidths[ci] + 2) + '|';
    }
    lines.push(sep);
  } else {
    lines.push('| ' + Array(numCols).fill('---').join(' | ') + ' |');
  }

  for (let i = 1; i < rendered.length; i++) {
    const rowCells = rendered[i];
    lines.push(formatPipeRow(rowCells));
    for (const c of rowCells) deferredAll.push(...c.deferred);
  }

  let result = lines.join('\n');
  if (deferredAll.length > 0) {
    result += '\n' + deferredAll.join('\n');
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Hardened alert prefix stripping: matches the exact format emitted by
// generateParagraph (`GLYPH + ' ' + Title + <w:br/>`) as well as bold-wrapped,
// colon-suffixed, and bare-title variants.  The plain-glyph-title pattern
// is checked first (most common roundtrip case) so we don't rely on the
// more permissive regexes for the happy path.
function stripAlertLeadPrefix(text: string, alertType: GfmAlertType): string {
  // 1. Standard [!TYPE] marker (e.g. from a re-imported markdown)
  const marker = parseGfmAlertMarker(text.trimStart());
  if (marker?.type === alertType) {
    return text.replace(/^\s*\[![A-Za-z]+\](?:[ \t]+|\\?\n\s*|$)/, '');
  }
  const title = gfmAlertTitle(alertType);
  const glyphAlternation = Object.keys(ALERT_GLYPH_TO_TYPE).map(escapeRegExp).join('|');

  // 2. Exact generateParagraph format: `GLYPH ' ' Title` followed by
  //    optional space or `\\\n` (line break from <w:br/>).  This is the
  //    most common roundtrip format — check it before the bold-wrapped
  //    and colon-suffixed variants.
  const exactPlain = new RegExp(
    '^\\s*(?:' + glyphAlternation + ') ' + escapeRegExp(title) + '(?:\\\\?\\n\\s*| )'
  );
  if (exactPlain.test(text)) return text.replace(exactPlain, '');

  // 3. Bold-wrapped: **GLYPH Title** or __GLYPH Title__
  const titleCore = '(?:' + glyphAlternation + ')\\s*' + escapeRegExp(title);
  const boldWrapped = text.match(/^\s*(\*\*|__)(.+?)\1\s*(?:\\?\n\s*)?/);
  if (boldWrapped) {
    const inner = boldWrapped[2].trim();
    if (new RegExp('^' + titleCore + '\\s*[:：-]?$').test(inner)) {
      return text.slice(boldWrapped[0].length);
    }
  }

  // 4. Glyph + title with optional colon/dash separator
  const withGlyph = new RegExp('^\\s*(?:' + glyphAlternation + ')\\s*' + escapeRegExp(title) + '(?:\\s*[:：-]\\s*|\\s+|\\\\?\\n\\s*|$)');
  if (withGlyph.test(text)) return text.replace(withGlyph, '');

  // 5. Bare title with required colon/dash (e.g. "Note:" without glyph)
  const titleOnly = new RegExp('^\\s*' + escapeRegExp(title) + '\\s*[:：-]\\s*(?:\\\\?\\n\\s*)?');
  if (titleOnly.test(text)) return text.replace(titleOnly, '');

  return text;
}


/** Render a table as a grid table if possible; returns null if not feasible. */
function tryRenderGridTable(
  table: { rows: TableRow[] },
  comments: Map<string, Comment>,
  renderOpts?: RenderOpts,
  maxLineWidth?: number,
  sourceColWidths?: number[],
): string | null {
  if (maxLineWidth !== undefined && maxLineWidth <= 0) return null;
  const rows = table.rows;
  if (rows.length === 0) return null;

  // Grid tables don't support colspan/rowspan
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.colspan && cell.colspan > 1) return null;
      if (cell.rowspan && cell.rowspan > 1) return null;
    }
  }

  const numCols = Math.max(...rows.map(r => r.cells.length));

  // Snapshot emittedIdCommentBodies for rollback
  const emittedSnapshot = renderOpts?.emittedIdCommentBodies
    ? new Set(renderOpts.emittedIdCommentBodies) : undefined;
  const rollback = () => {
    if (emittedSnapshot && renderOpts?.emittedIdCommentBodies) {
      renderOpts.emittedIdCommentBodies.clear();
      for (const v of emittedSnapshot) renderOpts.emittedIdCommentBodies.add(v);
    }
  };

  // Render all cells: each cell may have multiple paragraphs → multiple lines
  const rendered: { lines: string[]; deferred: string[] }[][] = [];
  for (const row of rows) {
    const rowCells: { lines: string[]; deferred: string[] }[] = [];
    for (const cell of row.cells) {
      const cellLines: string[] = [];
      const cellDeferred: string[] = [];
      for (const para of cell.paragraphs) {
        // Strip auto-bold from header row cells — md-to-docx forces bold on
        // header cells, so we undo it here to avoid spurious **...** on round-trip.
        const items = row.isHeader
          ? para.map(item =>
              item.type === 'text' && item.formatting?.bold
                ? { ...item, formatting: { ...item.formatting, bold: false } }
                : item)
          : para;
        const r = renderInlineSegment(mergeConsecutiveRuns(items), comments, renderOpts);
        // Split on newlines within a paragraph (e.g. hard breaks).
        // Strip trailing backslash from each line — grid table cells treat
        // bare newlines as hard breaks, so the backslash is redundant.
        cellLines.push(...r.text.split('\n').map(l => l.replace(/\\$/, '')));
        cellDeferred.push(...r.deferredComments);
      }
      if (cellLines.length === 0) cellLines.push('');
      rowCells.push({ lines: cellLines, deferred: cellDeferred });
    }
    // Pad to numCols
    while (rowCells.length < numCols) {
      rowCells.push({ lines: [''], deferred: [] });
    }
    rendered.push(rowCells);
  }

  // Compute column widths (minimum 3 for separator dashes, or source widths if available).
  // sourceColWidths are inner widths (between +...+), which include 2 padding spaces;
  // colWidths here are content widths (the renderer adds padding), so subtract 2.
  const colWidths: number[] = Array(numCols).fill(3);
  let validSourceWidths = false;
  if (sourceColWidths && sourceColWidths.length === numCols) {
    validSourceWidths = sourceColWidths.every(w => Number.isFinite(w) && w >= 0);
  }
  if (validSourceWidths) {
    for (let c = 0; c < numCols; c++) {
      const contentWidth = sourceColWidths![c] - 2;
      if (contentWidth > colWidths[c]) colWidths[c] = contentWidth;
    }
  }
  for (const rowCells of rendered) {
    for (let c = 0; c < numCols; c++) {
      for (const line of rowCells[c].lines) {
        const w = getDisplayWidth(line);
        if (w > colWidths[c]) colWidths[c] = w;
      }
    }
  }

  // Check width limit (separator line is always the widest)
  if (maxLineWidth !== undefined && Number.isFinite(maxLineWidth)) {
    const totalWidth = colWidths.reduce((s, w) => s + w + 3, 1);
    if (totalWidth > maxLineWidth) { rollback(); return null; }
  }

  // Build separator line
  const makeSep = (ch: string) =>
    '+' + colWidths.map(w => ch.repeat(w + 2)).join('+') + '+';

  const normalSep = makeSep('-');
  const headerSep = makeSep('=');

  // Find header boundary
  const headerEnd = rows.findIndex(r => !r.isHeader);
  const hasHeader = headerEnd > 0;

  // Build output lines
  const lines: string[] = [];
  const deferredAll: string[] = [];

  lines.push(normalSep);

  for (let ri = 0; ri < rendered.length; ri++) {
    const rowCells = rendered[ri];
    // Number of content lines in this row
    const rowHeight = Math.max(...rowCells.map(c => c.lines.length));

    for (let li = 0; li < rowHeight; li++) {
      let line = '|';
      for (let c = 0; c < numCols; c++) {
        const text = rowCells[c].lines[li] || '';
        const pad = colWidths[c] - getDisplayWidth(text);
        line += ' ' + text + ' '.repeat(pad + 1) + '|';
      }
      lines.push(line);
    }

    for (const cell of rowCells) {
      deferredAll.push(...cell.deferred);
    }

    // Separator after row
    if (hasHeader && ri === headerEnd - 1) {
      lines.push(headerSep);
    } else {
      lines.push(normalSep);
    }
  }

  // If something went wrong with rendering, rollback
  if (lines.length <= 2) {
    rollback();
    return null;
  }

  let result = lines.join('\n');
  if (deferredAll.length > 0) {
    result += '\n' + deferredAll.join('\n');
  }
  return result;
}

/** Render a table as a grid table, GFM pipe table, or HTML fallback, depending on feasibility and stored format.
 *  Returns { directivePrefix, body } so callers can position directives before preceding HTML comments. */
/**
 * Build the comment-style directive prefix for a table (font-size, font, col-widths, orientation).
 * Returns the prefix string and a flag indicating whether a font value is comment-unsafe.
 */
function buildTableDirectivePrefix(
  renderOpts: RenderOpts | undefined,
  tableIndex: number | undefined,
): { fontPrefix: string; commentUnsafeFont: boolean } {
  let fontPrefix = '';
  let commentUnsafeFont = false;
  const isLandscapeTable = tableIndex !== undefined && renderOpts?.landscapeTableIndices?.has(tableIndex);
  const isPortraitTable = tableIndex !== undefined && renderOpts?.portraitTableIndices?.has(tableIndex);
  if (tableIndex !== undefined && renderOpts) {
    const fontSize = renderOpts.tableFontSizeMapping?.get(String(tableIndex));
    const font = renderOpts.tableFontMapping?.get(String(tableIndex));
    if (fontSize) fontPrefix += '<!-- table-font-size: ' + fontSize + ' -->\n';
    if (font) {
      if (font.includes('-->')) {
        commentUnsafeFont = true;
      } else {
        fontPrefix += '<!-- table-font: ' + font + ' -->\n';
      }
    }
    const colWidths = renderOpts.tableColWidthsMapping?.get(String(tableIndex));
    if (colWidths) {
      if (colWidths.includes('-->')) {
        commentUnsafeFont = true;
      } else {
        fontPrefix += '<!-- table-col-widths: ' + colWidths + ' -->\n';
      }
    }
    const digits = renderOpts.tableDigitsMapping?.get(String(tableIndex));
    const decimalMark = renderOpts.tableDecimalMarkMapping?.get(String(tableIndex));
    const digitGrouping = renderOpts.tableDigitGroupingMapping?.get(String(tableIndex));
    if (digits) fontPrefix += '<!-- table-digits: ' + digits + ' -->\n';
    if (decimalMark) fontPrefix += '<!-- table-decimal-mark: ' + decimalMark + ' -->\n';
    if (digitGrouping) fontPrefix += '<!-- table-digit-grouping: ' + digitGrouping + ' -->\n';
    if (isLandscapeTable) fontPrefix += '<!-- table-orientation: landscape -->\n';
    if (isPortraitTable) fontPrefix += '<!-- table-orientation: portrait -->\n';
  }
  return { fontPrefix, commentUnsafeFont };
}

const STRUCTURAL_SENTINEL_RE = /^<!--\s*(?:\/?(?:landscape|portrait|references|bibliography|style)\b.*?)\s*-->$/i;
const HTML_COMMENT_RE = /^<!--[\s\S]*?-->$/;

/**
 * Insert a directive prefix + body into the output array, hoisting the prefix
 * above any immediately-preceding HTML comment entries so that table directives
 * appear above user sentinel comments (preserving original document order).
 */
function pushWithHoistedPrefix(output: string[], directivePrefix: string, body: string): void {
  if (!directivePrefix) {
    output.push(body);
    return;
  }
  let scanIdx = output.length;
  while (scanIdx > 0) {
    const prev = output[scanIdx - 1];
    const trimmedPrev = prev.trim();
    if (STRUCTURAL_SENTINEL_RE.test(trimmedPrev)) break;
    if (HTML_COMMENT_RE.test(trimmedPrev)) { scanIdx--; continue; }
    if (/^\s*$/.test(prev) && scanIdx >= 2 && HTML_COMMENT_RE.test(output[scanIdx - 2].trim())
        && !STRUCTURAL_SENTINEL_RE.test(output[scanIdx - 2].trim())) {
      scanIdx--; continue;
    }
    break;
  }
  const commentBlock = output.splice(scanIdx);
  const userComments = commentBlock.filter(e => !/^\s*$/.test(e));
  const combined = directivePrefix.replace(/\n+$/, '')
    + (userComments.length > 0 ? '\n' + userComments.join('\n') : '');
  output.push(combined);
  output.push('\n' + body);
}

function renderTableOrFallback(
  item: { rows: TableRow[] },
  comments: Map<string, Comment>,
  options?: { pipeTableMaxLineWidth?: number; gridTableMaxLineWidth?: number; tableIndent?: string },
  renderOpts?: RenderOpts,
  storedFormat?: string,
  tableIndex?: number,
): { directivePrefix: string; body: string } {
  const { fontPrefix, commentUnsafeFont: forceHtmlTable } = buildTableDirectivePrefix(renderOpts, tableIndex);
  let htmlFontAttrs = '';
  const isLandscapeTable = tableIndex !== undefined && renderOpts?.landscapeTableIndices?.has(tableIndex);
  const isPortraitTable = tableIndex !== undefined && renderOpts?.portraitTableIndices?.has(tableIndex);
  if (tableIndex !== undefined && renderOpts) {
    const fontSize = renderOpts.tableFontSizeMapping?.get(String(tableIndex));
    const font = renderOpts.tableFontMapping?.get(String(tableIndex));
    if (fontSize) htmlFontAttrs += ' data-font-size="' + escapeHtmlAttr(fontSize) + '"';
    if (font) htmlFontAttrs += ' data-font="' + escapeHtmlAttr(font) + '"';
    const colWidths = renderOpts.tableColWidthsMapping?.get(String(tableIndex));
    if (colWidths) htmlFontAttrs += ' data-col-widths="' + escapeHtmlAttr(colWidths) + '"';
    const digits = renderOpts.tableDigitsMapping?.get(String(tableIndex));
    const decimalMark = renderOpts.tableDecimalMarkMapping?.get(String(tableIndex));
    const digitGrouping = renderOpts.tableDigitGroupingMapping?.get(String(tableIndex));
    if (digits) htmlFontAttrs += ' data-digits="' + escapeHtmlAttr(digits) + '"';
    if (decimalMark) htmlFontAttrs += ' data-decimal-mark="' + escapeHtmlAttr(decimalMark) + '"';
    if (digitGrouping) htmlFontAttrs += ' data-digit-grouping="' + escapeHtmlAttr(digitGrouping) + '"';
    if (isLandscapeTable) htmlFontAttrs += ' data-orientation="landscape"';
    if (isPortraitTable) htmlFontAttrs += ' data-orientation="portrait"';
  }
  const r = (body: string) => ({ directivePrefix: fontPrefix, body });
  const rHtml = (body: string) => ({ directivePrefix: '', body });
  // If the original format was HTML or font value is comment-unsafe, emit HTML directly
  if (storedFormat === 'html' || forceHtmlTable) {
    return rHtml(renderHtmlTable(item, comments, options?.tableIndent, renderOpts, htmlFontAttrs));
  }
  // Parse stored grid source column widths for this table
  const gridSrcWidthsStr = tableIndex !== undefined ? renderOpts?.gridSourceColWidthsMapping?.get(String(tableIndex)) : undefined;
  let gridSrcWidths = gridSrcWidthsStr ? gridSrcWidthsStr.split(',').map(Number) : undefined;
  if (gridSrcWidths) {
    const numCols = item.rows.length > 0 ? Math.max(...item.rows.map(r => r.cells.length)) : 0;
    if (gridSrcWidths.length !== numCols || !gridSrcWidths.every(w => Number.isFinite(w) && w >= 0)) {
      gridSrcWidths = undefined;
    }
  }
  // If original was grid, try grid then fall back to HTML (skip pipe, skip width check to preserve format)
  if (storedFormat === 'grid') {
    const gridResult = tryRenderGridTable(item, comments, renderOpts, undefined, gridSrcWidths);
    if (gridResult !== null) return r(gridResult);
    return rHtml(renderHtmlTable(item, comments, options?.tableIndent, renderOpts, htmlFontAttrs));
  }
  // When the original was a pipe table, skip the width check to preserve format
  const pipeMax = storedFormat === 'pipe' ? Infinity : (options?.pipeTableMaxLineWidth ?? 120);
  const pipeAligned = tableIndex !== undefined && renderOpts?.pipeTableAlignedMapping?.get(String(tableIndex)) === 'true';
  const pipeResult = tryRenderPipeTable(item, pipeMax, comments, renderOpts, pipeAligned);
  if (pipeResult !== null) {
    return r(pipeResult);
  }
  // For tables without a stored format, try grid before falling back to HTML
  if (storedFormat !== 'pipe') {
    const gridResult = tryRenderGridTable(item, comments, renderOpts, options?.gridTableMaxLineWidth, gridSrcWidths);
    if (gridResult !== null) return r(gridResult);
  }
  return rHtml(renderHtmlTable(item, comments, options?.tableIndent, renderOpts, htmlFontAttrs));
}

function isStructuralBoundaryItem(item: ContentItem): boolean {
  return item.type === 'para'
    || item.type === 'table'
    || item.type === 'landscape_open'
    || item.type === 'landscape_close'
    || item.type === 'portrait_open'
    || item.type === 'portrait_close'
    || item.type === 'bibliography_marker'
    || item.type === 'custom_style_open'
    || item.type === 'custom_style_close';
}

function paragraphHasContent(content: ContentItem[], paraIndex: number): boolean {
  for (let i = paraIndex + 1; i < content.length; i++) {
    if (isStructuralBoundaryItem(content[i])) return false;
    return true;
  }
  return false;
}

function isPlainEmptyParagraph(item: Extract<ContentItem, { type: 'para' }>): boolean {
  return !item.headingLevel
    && !item.listMeta
    && !item.isTitle
    && !item.blockquoteLevel
    && !item.isCodeBlock
    && !item.customStyleName
    && item.emptyParagraphCount !== undefined;
}

function clearListContextsFromLevel(contexts: Map<number, StructuralListContext>, minLevel: number): void {
  for (const level of [...contexts.keys()]) {
    if (level >= minLevel) contexts.delete(level);
  }
}

function inferOrderedMarkerWidth(
  listMeta: ListMeta,
  orderedCounters: Map<number, number>,
  listTypesByLevel: Map<number, 'bullet' | 'ordered'>,
  lastListLevel: number | undefined,
  lastListType: 'bullet' | 'ordered' | undefined,
): number | undefined {
  if (listMeta.type !== 'ordered') return undefined;
  const levelType = listTypesByLevel.get(listMeta.level);
  const isNewListContext = levelType !== 'ordered' && (!lastListType || lastListType !== 'ordered');
  const isNewSubList = lastListLevel !== undefined && listMeta.level > lastListLevel;
  if (listMeta.startNumber !== undefined && (isNewListContext || isNewSubList)) {
    orderedCounters.set(listMeta.level, listMeta.startNumber);
  } else if (isNewListContext || isNewSubList) {
    orderedCounters.set(listMeta.level, 1);
  }
  const currentNumber = listMeta.startNumber !== undefined && (isNewListContext || isNewSubList)
    ? listMeta.startNumber
    : (orderedCounters.get(listMeta.level) ?? 1);
  orderedCounters.set(listMeta.level, currentNumber + 1);
  return String(currentNumber).length + 2;
}

function inferListContinuationForBlockquote(
  item: Extract<ContentItem, { type: 'para' }>,
  listContexts: Map<number, StructuralListContext>,
): { blockquoteLevel: number; listContinuation?: ListContinuation } | undefined {
  if (!item.blockquoteLevel || item.paragraphLeftIndentTwips === undefined || item.blockquoteIndentUnitTwips === undefined) {
    return undefined;
  }
  const fallback = { blockquoteLevel: item.blockquoteLevel };
  if (listContexts.size === 0) return fallback;

  const rawIndent = item.paragraphLeftIndentTwips;
  const unit = item.blockquoteIndentUnitTwips;
  const candidates = [...listContexts.values()].sort((a, b) => b.level - a.level);
  for (const context of candidates) {
    const continuationIndent = 720 * (context.level + 1);
    const adjustedIndent = rawIndent - continuationIndent;
    if (adjustedIndent < unit || adjustedIndent % unit !== 0) continue;
    const inferredLevel = adjustedIndent / unit;
    if (!Number.isInteger(inferredLevel) || inferredLevel < 1) continue;
    return {
      blockquoteLevel: inferredLevel,
      listContinuation: {
        type: context.type,
        level: context.level,
        ...(context.markerWidth !== undefined ? { markerWidth: context.markerWidth } : {}),
      },
    };
  }

  return fallback;
}

function alertGlyphForType(alertType: GfmAlertType): string | undefined {
  for (const [glyph, type] of Object.entries(ALERT_GLYPH_TO_TYPE)) {
    if (type === alertType) return glyph;
  }
  return undefined;
}

function paragraphStartsWithExportedAlertLead(
  content: ContentItem[],
  paraIndex: number,
  alertType: GfmAlertType,
): boolean {
  const glyph = alertGlyphForType(alertType);
  if (!glyph) return false;
  const expectedLead = glyph + ' ' + gfmAlertTitle(alertType) + ' ';
  let sawLead = false;

  for (let i = paraIndex + 1; i < content.length; i++) {
    const item = content[i];
    if (isStructuralBoundaryItem(item)) break;
    if (item.type !== 'text') return false;
    if (!sawLead) {
      if (!item.formatting.bold || item.text !== expectedLead) return false;
      sawLead = true;
      continue;
    }
    return item.text.startsWith('\\\n');
  }

  return false;
}

function isRenderableNonBlockquoteStructuralItem(
  content: ContentItem[],
  contentIndex: number,
  item: ContentItem,
): boolean {
  if (item.type === 'table') return true;
  if (item.type !== 'para') return false;
  if (item.blockquoteLevel) return false;
  return !isPlainEmptyParagraph(item) || paragraphHasContent(content, contentIndex);
}

function hasRenderableInlineContent(content: ContentItem[], startIndex: number, endIndex: number): boolean {
  for (let i = startIndex; i < endIndex; i++) {
    if (!isStructuralBoundaryItem(content[i])) return true;
  }
  return false;
}

function deriveBlockquoteSpacingFromStructure(content: ContentItem[]): {
  derivedBlockquoteGaps: Map<number, number>;
  derivedBlockquotePreContentBlankLines: Map<number, number>;
  derivedBlockquotePostContentBlankLines: Map<number, number>;
} {
  const structuralItems = content.flatMap((item, index) =>
    isStructuralBoundaryItem(item) && !(item.type === 'para' && item.isBlockquoteSpacer)
      ? [{ item, index }]
      : []
  );
  const groups: Array<{ groupIndex: number; startPos: number; endPos: number }> = [];

  for (let pos = 0; pos < structuralItems.length; pos++) {
    const entry = structuralItems[pos];
    if (entry.item.type !== 'para' || entry.item.blockquoteGroupIndex === undefined) continue;
    const currentGroupIndex = entry.item.blockquoteGroupIndex;
    const lastGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (lastGroup && lastGroup.groupIndex === currentGroupIndex) {
      lastGroup.endPos = pos;
    } else {
      groups.push({ groupIndex: currentGroupIndex, startPos: pos, endPos: pos });
    }
  }

  const derivedBlockquoteGaps = new Map<number, number>();
  const derivedBlockquotePreContentBlankLines = new Map<number, number>();
  const derivedBlockquotePostContentBlankLines = new Map<number, number>();

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];

    let preBlankCount = 0;
    let prePos = group.startPos - 1;
    while (prePos >= 0) {
      const entry = structuralItems[prePos];
      if (entry.item.type === 'para' && isPlainEmptyParagraph(entry.item) && !paragraphHasContent(content, entry.index)) {
        preBlankCount += entry.item.emptyParagraphCount ?? 1;
        prePos--;
        continue;
      }
      break;
    }
    const preRangeStart = prePos >= 0 ? structuralItems[prePos].index + 1 : 0;
    const preRangeEnd = preBlankCount > 0
      ? structuralItems[prePos + 1].index
      : structuralItems[group.startPos].index;
    const hasPrecedingContent = (prePos >= 0
      && isRenderableNonBlockquoteStructuralItem(content, structuralItems[prePos].index, structuralItems[prePos].item))
      || hasRenderableInlineContent(content, preRangeStart, preRangeEnd);
    if (preBlankCount > 0 && hasPrecedingContent) {
      derivedBlockquotePreContentBlankLines.set(group.groupIndex, preBlankCount);
    }

    let postBlankCount = 0;
    let postPos = group.endPos + 1;
    while (postPos < structuralItems.length) {
      const entry = structuralItems[postPos];
      if (entry.item.type === 'para' && isPlainEmptyParagraph(entry.item) && !paragraphHasContent(content, entry.index)) {
        postBlankCount += entry.item.emptyParagraphCount ?? 1;
        postPos++;
        continue;
      }
      break;
    }
    const postRangeStart = postBlankCount > 0
      ? structuralItems[postPos - 1].index + 1
      : structuralItems[group.endPos].index + 1;
    const postRangeEnd = postPos < structuralItems.length ? structuralItems[postPos].index : content.length;
    const hasFollowingContent = (postPos < structuralItems.length
      && isRenderableNonBlockquoteStructuralItem(content, structuralItems[postPos].index, structuralItems[postPos].item))
      || hasRenderableInlineContent(content, postRangeStart, postRangeEnd);
    if (postBlankCount > 0 && hasFollowingContent) {
      derivedBlockquotePostContentBlankLines.set(group.groupIndex, postBlankCount);
    }

    const nextGroup = gi + 1 < groups.length ? groups[gi + 1] : undefined;
    if (!nextGroup) continue;

    let gapBlankCount = 0;
    let sawInterveningContent = false;
    for (let pos = group.endPos + 1; pos < nextGroup.startPos; pos++) {
      const entry = structuralItems[pos];
      if (entry.item.type === 'para' && isPlainEmptyParagraph(entry.item) && !paragraphHasContent(content, entry.index)) {
        gapBlankCount += entry.item.emptyParagraphCount ?? 1;
      } else if (isRenderableNonBlockquoteStructuralItem(content, entry.index, entry.item)) {
        sawInterveningContent = true;
      }
    }
    derivedBlockquoteGaps.set(group.groupIndex, sawInterveningContent ? -1 : gapBlankCount);
  }

  return {
    derivedBlockquoteGaps,
    derivedBlockquotePreContentBlankLines,
    derivedBlockquotePostContentBlankLines,
  };
}

function annotateStructuralParagraphMetadata(content: ContentItem[]): {
  derivedBlockquoteGaps: Map<number, number>;
  derivedBlockquotePreContentBlankLines: Map<number, number>;
  derivedBlockquotePostContentBlankLines: Map<number, number>;
} {
  const listContexts = new Map<number, StructuralListContext>();
  const listTypesByLevel = new Map<number, 'bullet' | 'ordered'>();
  const orderedCounters = new Map<number, number>();
  let lastListLevel: number | undefined;
  let lastListType: 'bullet' | 'ordered' | undefined;
  let nextBlockquoteGroupIndex = 0;
  let currentBlockquoteGroupIndex: number | undefined;
  let lastBlockquoteLevel: number | undefined;
  let lastBlockquoteType: GfmAlertType | 'plain' | undefined;

  for (let i = 0; i < content.length; i++) {
    const item = content[i];

    if (item.type === 'para') {
      if (item.isBlockquoteSpacer) {
        currentBlockquoteGroupIndex = undefined;
        lastBlockquoteLevel = undefined;
        lastBlockquoteType = undefined;
        continue;
      }
      if (item.listMeta) {
        clearListContextsFromLevel(listContexts, item.listMeta.level + 1);
        for (const level of [...listTypesByLevel.keys()]) {
          if (level > item.listMeta.level) listTypesByLevel.delete(level);
        }
        for (const level of [...orderedCounters.keys()]) {
          if (level > item.listMeta.level) orderedCounters.delete(level);
        }
        const markerWidth = inferOrderedMarkerWidth(
          item.listMeta,
          orderedCounters,
          listTypesByLevel,
          lastListLevel,
          lastListType,
        );
        listTypesByLevel.set(item.listMeta.level, item.listMeta.type);
        listContexts.set(item.listMeta.level, {
          type: item.listMeta.type,
          level: item.listMeta.level,
          ...(markerWidth !== undefined ? { markerWidth } : {}),
        });
        lastListLevel = item.listMeta.level;
        lastListType = item.listMeta.type;
        currentBlockquoteGroupIndex = undefined;
        lastBlockquoteLevel = undefined;
        lastBlockquoteType = undefined;
        continue;
      }

      if (item.blockquoteLevel) {
        const inferred = inferListContinuationForBlockquote(item, listContexts);
        if (inferred) {
          item.blockquoteLevel = inferred.blockquoteLevel;
          item.listContinuation = inferred.listContinuation;
        }
        const currentType: GfmAlertType | 'plain' = item.alertType || 'plain';
        const startsNewGroup = currentBlockquoteGroupIndex === undefined
          || item.blockquoteLevel !== lastBlockquoteLevel
          || currentType !== lastBlockquoteType
          || (item.alertType !== undefined && paragraphStartsWithExportedAlertLead(content, i, item.alertType));
        if (startsNewGroup) {
          currentBlockquoteGroupIndex = nextBlockquoteGroupIndex++;
        }
        item.blockquoteGroupIndex = currentBlockquoteGroupIndex;
        lastBlockquoteLevel = item.blockquoteLevel;
        lastBlockquoteType = currentType;
        lastListLevel = undefined;
        lastListType = undefined;
        continue;
      }

      if (!isPlainEmptyParagraph(item) || paragraphHasContent(content, i)) {
        listContexts.clear();
        listTypesByLevel.clear();
        orderedCounters.clear();
        lastListLevel = undefined;
        lastListType = undefined;
      }
      currentBlockquoteGroupIndex = undefined;
      lastBlockquoteLevel = undefined;
      lastBlockquoteType = undefined;
      continue;
    }

    if (isStructuralBoundaryItem(item)) {
      listContexts.clear();
      listTypesByLevel.clear();
      orderedCounters.clear();
      lastListLevel = undefined;
      lastListType = undefined;
      currentBlockquoteGroupIndex = undefined;
      lastBlockquoteLevel = undefined;
      lastBlockquoteType = undefined;
    }
  }

  return deriveBlockquoteSpacingFromStructure(content);
}

export function buildMarkdown(
  content: ContentItem[],
  comments: Map<string, Comment>,
  options?: { tableIndent?: string; alwaysUseCommentIds?: boolean; pipeTableMaxLineWidth?: number; gridTableMaxLineWidth?: number; commentIdMapping?: Map<string, string> | null; notes?: { map: Map<string, { label: string; body: ContentItem[]; noteKind: 'footnote' | 'endnote' }>; assignedLabels: Map<string, string> }; codeBlockLangs?: Map<string, string> | null; blockquoteGaps?: Map<number, number> | null; blockquotePreContentBlankLines?: Map<number, number> | null; blockquotePostContentBlankLines?: Map<number, number> | null; blockquoteAlertInlineByGroup?: Map<number, boolean> | null; calloutLabels?: boolean | null; imageFormatMapping?: Map<string, string> | null; noteImageFormatMapping?: Map<string, string> | null; tableFormatMapping?: Map<string, string> | null; pipeTableAlignedMapping?: Map<string, string> | null; gridSourceColWidthsMapping?: Map<string, string> | null; tableFontSizeMapping?: Map<string, string> | null; tableFontMapping?: Map<string, string> | null; tableColWidthsMapping?: Map<string, string> | null; tableDigitsMapping?: Map<string, string> | null; tableDecimalMarkMapping?: Map<string, string> | null; tableDigitGroupingMapping?: Map<string, string> | null; landscapeTableIndices?: Set<number> | null; portraitTableIndices?: Set<number> | null; listIndent?: 'tab' | 'spaces'; htmlCommentGaps?: Map<number, number> | null; htmlCommentAfterGaps?: Map<number, number> | null; sentinelGaps?: Record<string, number> | null; embedDirectiveMapping?: Map<string, string> | null },
): string {
  const mergedContent = mergeConsecutiveRuns(content);

  // Build 1-indexed comment ID remap (order of first appearance in document)
  const commentIdRemap = new Map<string, string>();
  const usedRemapIds = new Set<string>();
  // Comments that overlap anywhere in the document should use ID syntax
  // consistently across all their occurrences (including non-overlapping
  // paragraphs), to avoid mixed-format duplicate comment body emission.
  const forceIdCommentIds = new Set<string>();
  const emittedIdCommentBodies = new Set<string>();
  let nextRemapId = 1;
  function nextAvailableNumericId(): string {
    while (usedRemapIds.has(String(nextRemapId))) {
      nextRemapId++;
    }
    const id = String(nextRemapId);
    usedRemapIds.add(id);
    nextRemapId++;
    return id;
  }
  function assignRemappedId(id: string): string {
    const mapped = options?.commentIdMapping?.get(id);
    if (mapped && !usedRemapIds.has(mapped)) {
      usedRemapIds.add(mapped);
      return mapped;
    }
    return nextAvailableNumericId();
  }
  function collectCommentMetadata(items: ContentItem[]): void {
    for (const item of items) {
      if (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') {
        if (item.commentIds) {
          const ids = [...item.commentIds];
          for (const id of ids) {
            if (!commentIdRemap.has(id)) {
              commentIdRemap.set(id, assignRemappedId(id));
            }
          }
          if (ids.length > 1) {
            for (const id of ids) {
              forceIdCommentIds.add(id);
            }
          }
        }
      } else if (item.type === 'table') {
        for (const row of item.rows) {
          for (const cell of row.cells) {
            for (const para of cell.paragraphs) {
              collectCommentMetadata(para);
            }
          }
        }
      }
    }
  }
  collectCommentMetadata(mergedContent);

  // Global overlap detection: mark comments that overlap anywhere in the document
  function detectGlobalOverlaps(items: ContentItem[]): void {
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    let pos = 0;
    let prevIds = new Set<string>();

    function scan(itemList: ContentItem[]): void {
      for (const item of itemList) {
        if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math' || item.type === 'html_comment' || item.type === 'image') && item.commentIds) {
          const ids = item.commentIds;
          for (const id of ids) {
            if (!prevIds.has(id)) starts.set(id, Math.min(starts.get(id) ?? pos, pos));
          }
          for (const id of prevIds) {
            if (!ids.has(id)) ends.set(id, Math.max(ends.get(id) ?? pos, pos));
          }
          prevIds = ids;
          pos++;
        } else if (item.type === 'table') {
          for (const row of item.rows) {
            for (const cell of row.cells) {
              for (const para of cell.paragraphs) {
                scan(para);
              }
            }
          }
        }
      }
    }
    scan(items);
    for (const id of prevIds) {
      if (!ends.has(id)) ends.set(id, pos);
    }

    const allIds = [...commentIdRemap.keys()];
    const ranges = allIds.map(id => ({ id, start: starts.get(id) ?? 0, end: ends.get(id) ?? 0 }));
    for (let a = 0; a < ranges.length; a++) {
      for (let b = a + 1; b < ranges.length; b++) {
        if (ranges[a].start < ranges[b].end && ranges[b].start < ranges[a].end) {
          forceIdCommentIds.add(ranges[a].id);
          forceIdCommentIds.add(ranges[b].id);
        }
      }
    }
  }
  detectGlobalOverlaps(mergedContent);

  const noteLabels = options?.notes?.assignedLabels;
  const renderOpts = {
    alwaysUseCommentIds: options?.alwaysUseCommentIds,
    commentIdRemap,
    forceIdCommentIds,
    emittedIdCommentBodies,
    noteLabels,
    imageFormatMapping: options?.imageFormatMapping ?? undefined,
    noteImageFormatMapping: options?.noteImageFormatMapping ?? undefined,
    tableFormatMapping: options?.tableFormatMapping ?? undefined,
    pipeTableAlignedMapping: options?.pipeTableAlignedMapping ?? undefined,
    gridSourceColWidthsMapping: options?.gridSourceColWidthsMapping ?? undefined,
    tableFontSizeMapping: options?.tableFontSizeMapping ?? undefined,
    tableFontMapping: options?.tableFontMapping ?? undefined,
    tableColWidthsMapping: options?.tableColWidthsMapping ?? undefined,
    tableDigitsMapping: options?.tableDigitsMapping ?? undefined,
    tableDecimalMarkMapping: options?.tableDecimalMarkMapping ?? undefined,
    tableDigitGroupingMapping: options?.tableDigitGroupingMapping ?? undefined,
    landscapeTableIndices: options?.landscapeTableIndices ?? undefined,
    portraitTableIndices: options?.portraitTableIndices ?? undefined,
    embedDirectiveMapping: options?.embedDirectiveMapping ?? undefined,
  };

  function listContinuationIndent(list: ListContinuation): string {
    const useTab = options?.listIndent === 'tab';
    if (useTab) {
      return '\t'.repeat(list.level + 1);
    }
    if (list.type === 'bullet') {
      return ' '.repeat(2 * (list.level + 1));
    }
    const markerWidth = list.markerWidth ?? 3;
    return ' '.repeat(3 * list.level + markerWidth);
  }

  function blockquotePrefix(item: Extract<ContentItem, { type: 'para' }>): string {
    const quotePrefix = '> '.repeat(item.blockquoteLevel || 1);
    return (item.listContinuation ? listContinuationIndent(item.listContinuation) : '') + quotePrefix;
  }

  const output: string[] = [];
  let i = 0;
  let tableIndex = 0;
  let lastListType: 'bullet' | 'ordered' | undefined;
  let lastListLevel: number | undefined;
  const listTypeByLevel = new Map<number, 'bullet' | 'ordered'>(); // per-level list type tracking
  const orderedListCounters = new Map<number, number>(); // per-level counters for ordered list items
  let codeBlockGroupIndex = 0;
  let lastAlertParagraphKey: string | undefined;
  let pendingAlertPrefixStrip: GfmAlertType | undefined;
  // Fallback for imports without alert-style metadata: stripAlertLeadPrefix can
  // consume a hard line break after the glyph/title lead (e.g. "※ Note" + w:br).
  // If we've already emitted an inline marker (`> [!TYPE] `), rewrite it to the
  // marker-only form (`> [!TYPE]\n> ...`) so callout/paragraph boundaries stay
  // stable on DOCX -> MD conversion.
  let pendingAlertInlinePrefixForHardBreak: string | undefined;
  // Heading whose paragraph mark is inserted/deleted (whole-paragraph track
  // change): the `### ` marker must be re-inserted inside the leading Critic
  // span ({++### heading++}) rather than emitted before it. revType is kept
  // so a heading with no inline content (empty inserted paragraph) can still
  // be serialized as its own {++### ++} / {--### --} span instead of leaking
  // the marker into the next paragraph.
  let pendingHeadingCriticMarker: { marker: string; revType: 'addition' | 'deletion' } | undefined;
  const flushPendingHeadingCriticMarker = () => {
    if (pendingHeadingCriticMarker === undefined) return;
    const { marker, revType } = pendingHeadingCriticMarker;
    output.push(revType === 'addition' ? '{++' + marker + '++}' : '{--' + marker + '--}');
    pendingHeadingCriticMarker = undefined;
  };
  let lastBlockquoteGroupIndex: number | undefined;
  let pendingPostContentGroupIndex: number | undefined;
  // Track previous blockquote type to detect group boundaries when gap
  // metadata is absent (plain↔alert or alert↔different-alert transitions).
  let lastBlockquoteAlertType: GfmAlertType | 'plain' | undefined;
  let lastBlockquoteLevel: number | undefined;
  const codeBlockLangs = options?.codeBlockLangs;
  const blockquoteGaps = options?.blockquoteGaps;
  const blockquotePreContentBlankLines = options?.blockquotePreContentBlankLines;
  const blockquotePostContentBlankLines = options?.blockquotePostContentBlankLines;
  const htmlCommentGaps = options?.htmlCommentGaps;
  const htmlCommentAfterGaps = options?.htmlCommentAfterGaps;
  let htmlCommentIndex = 0;
  let lastRenderedHtmlCommentIndex: number | undefined;
  let lastWasSectionSentinel = false; // true after landscape/portrait open/close rendering
  let lastSentinelAfterGapKey: string | undefined; // after-gap key of the last rendered sentinel
  let skipNextLandscapeClose = false;
  let skipNextPortraitClose = false;
  const sentinelGaps = options?.sentinelGaps;
  let sentinelLoIdx = 0, sentinelLcIdx = 0, sentinelPoIdx = 0, sentinelPcIdx = 0;
  let sentinelCsoIdx = 0, sentinelCscIdx = 0;
  // Emit separator before a sentinel using stored gap metadata.
  // Returns true if a gap-aware separator was emitted, false otherwise.
  function emitSentinelSep(gapKey: string): boolean {
    if (!sentinelGaps) return false;
    const gapCount = sentinelGaps[gapKey];
    if (gapCount === undefined) return false;
    const desiredNewlines = gapCount + 1;
    let existingNewlines = 0;
    for (let oi = output.length - 1; oi >= 0; oi--) {
      const s = output[oi];
      let j = s.length - 1;
      while (j >= 0 && s[j] === '\n') { existingNewlines++; j--; }
      if (j >= 0) break;
    }
    const needed = desiredNewlines - existingNewlines;
    if (needed > 0) {
      output.push('\n'.repeat(needed));
    } else if (needed < 0) {
      let toRemove = -needed;
      while (toRemove > 0 && output.length > 0) {
        const last = output[output.length - 1];
        let trailingNL = 0;
        for (let j = last.length - 1; j >= 0 && last[j] === '\n'; j--) trailingNL++;
        if (trailingNL === 0) break;
        const removeFromThis = Math.min(toRemove, trailingNL);
        if (removeFromThis === last.length) {
          output.pop();
        } else {
          output[output.length - 1] = last.slice(0, last.length - removeFromThis);
        }
        toRemove -= removeFromThis;
      }
    }
    return true;
  }

  while (i < mergedContent.length) {
    const item = mergedContent[i];

    // Compute incoming separator from the previous item (consumed once per iteration).
    // null means "no special handling, use default \n\n".
    let incomingSep: string | null = null;
    if (lastRenderedHtmlCommentIndex !== undefined) {
      const gapCount = htmlCommentAfterGaps?.get(lastRenderedHtmlCommentIndex);
      if (gapCount !== undefined) {
        incomingSep = '\n' + '\n'.repeat(gapCount);
      }
      lastRenderedHtmlCommentIndex = undefined;
    } else if (lastWasSectionSentinel) {
      // Use after-gap metadata from the last sentinel if available
      const afterGap = lastSentinelAfterGapKey && sentinelGaps ? sentinelGaps[lastSentinelAfterGapKey] : undefined;
      if (afterGap !== undefined) {
        incomingSep = '\n' + '\n'.repeat(afterGap);
      } else {
        incomingSep = '\n';
      }
      lastWasSectionSentinel = false;
      lastSentinelAfterGapKey = undefined;
    }

    if (item.type === 'para') {
      // A pending heading marker still unconsumed here means the revised
      // heading paragraph had no inline content — serialize it as its own
      // empty span before starting the next paragraph.
      flushPendingHeadingCriticMarker();
      if (item.isBlockquoteSpacer) {
        i++;
        continue;
      }
      if (
        isPlainEmptyParagraph(item) &&
        !paragraphHasContent(mergedContent, i)
      ) {
        let nextStructuralIdx = i + 1;
        while (nextStructuralIdx < mergedContent.length) {
          const nextItem = mergedContent[nextStructuralIdx];
          if (
            nextItem.type !== 'para'
            || !isPlainEmptyParagraph(nextItem)
            || paragraphHasContent(mergedContent, nextStructuralIdx)
          ) {
            break;
          }
          nextStructuralIdx++;
        }

        const nextCandidate = nextStructuralIdx < mergedContent.length ? mergedContent[nextStructuralIdx] : undefined;
        const nextPara = nextCandidate?.type === 'para'
          ? nextCandidate
          : undefined;

        if (
          nextPara?.blockquoteLevel &&
          nextPara.blockquoteGroupIndex !== undefined &&
          blockquotePreContentBlankLines?.has(nextPara.blockquoteGroupIndex)
        ) {
          i++;
          continue;
        }
      }

      // Code block grouping: collect consecutive code-block paragraphs into a fenced block
      if (item.isCodeBlock) {
        if (output.length > 0) {
          output.push('\n\n');
        }
        lastListType = undefined;
        lastListLevel = undefined;
        listTypeByLevel.clear();
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;

        const lang = codeBlockLangs?.get(String(codeBlockGroupIndex)) || '';
        const codeLines: string[] = [];

        // Collect text from consecutive code-block paragraphs.
        // Each code line in DOCX is: { type: 'para', isCodeBlock: true } followed by
        // optional { type: 'text', text: '...' }. Consecutive isCodeBlock paras are
        // part of the same group; a non-isCodeBlock para (separator) ends the group.
        let lineText = '';
        let firstLine = true;
        while (i < mergedContent.length) {
          const next = mergedContent[i];
          if (next.type === 'para' && next.isCodeBlock) {
            if (!firstLine) {
              codeLines.push(lineText);
              lineText = '';
            }
            firstLine = false;
            i++;
            continue;
          }
          if (next.type === 'para' && !next.isCodeBlock) {
            // Non-code-block para — separator between groups or end of block
            break;
          }
          if (next.type === 'text') {
            lineText += next.text;
          } else {
            // Non-para, non-text item (shouldn't typically occur inside a code block)
            break;
          }
          i++;
        }
        // Push the last collected line
        if (!firstLine) {
          codeLines.push(lineText);
        }

        // Trim trailing empty lines (artifact of markdown-it's trailing \n in fence content)
        while (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') {
          codeLines.pop();
        }

        // Compute fence length: must exceed any backtick run in the content
        let maxRun = 0;
        for (const line of codeLines) {
          const matches = line.match(/`+/g);
          if (matches) {
            for (const m of matches) {
              if (m.length > maxRun) maxRun = m.length;
            }
          }
        }
        const fence = '`'.repeat(Math.max(3, maxRun + 1));
        output.push(fence + lang + '\n' + codeLines.join('\n') + '\n' + fence);
        codeBlockGroupIndex++;
        // Skip a plain separator para that was inserted during export between
        // consecutive code-block groups or before a blockquote group.  Only
        // skip when the next item after the separator is either a code-block
        // para or a blockquote para (proving it's a separator, not real
        // content).
        const sep = i < mergedContent.length ? mergedContent[i] : undefined;
        const afterSep = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        if (sep && sep.type === 'para' && !sep.isCodeBlock && afterSep && afterSep.type === 'para' && (afterSep.isCodeBlock || afterSep.blockquoteLevel)) {
          i++;
        }
        continue;
      }

      const isCurrentList = item.listMeta !== undefined;

      if (output.length > 0) {
        if (lastListType && isCurrentList && item.listMeta!.type === lastListType) {
          output.push('\n');
        } else if (
          item.blockquoteLevel &&
          item.listContinuation &&
          lastListType === item.listContinuation.type &&
          lastListLevel === item.listContinuation.level
        ) {
          output.push('\n');
        } else if (incomingSep !== null) {
          output.push(incomingSep);
        } else if (
          blockquoteGaps &&
          item.blockquoteLevel &&
          item.blockquoteGroupIndex !== undefined &&
          lastBlockquoteGroupIndex !== undefined &&
          item.blockquoteGroupIndex !== lastBlockquoteGroupIndex
        ) {
          // Transitioning between blockquote groups — use gap metadata to
          // emit the exact number of blank lines from the original source.
          const gapCount = blockquoteGaps.get(lastBlockquoteGroupIndex);
          if (gapCount !== undefined && gapCount >= 0) {
            // gapCount blank lines = gapCount+1 newline characters
            output.push('\n' + '\n'.repeat(gapCount));
          } else if (gapCount === -1) {
            // Non-blockquote content existed between the groups in source;
            // use pre-content spacing metadata for this group when available.
            const preBlankCount = blockquotePreContentBlankLines?.get(item.blockquoteGroupIndex);
            if (preBlankCount !== undefined && preBlankCount >= 0) {
              output.push('\n' + '\n'.repeat(preBlankCount));
            } else {
              output.push('\n');
            }
          } else {
            output.push('\n\n');
          }
        } else if (
          blockquotePreContentBlankLines &&
          item.blockquoteLevel &&
          item.blockquoteGroupIndex !== undefined
        ) {
          // Blockquote group following non-blockquote content: preserve the
          // authored blank-line count before this group exactly.
          const blankCount = blockquotePreContentBlankLines.get(item.blockquoteGroupIndex);
          if (blankCount !== undefined && blankCount >= 0) {
            output.push('\n' + '\n'.repeat(blankCount));
          } else {
            output.push('\n\n');
          }
        } else if (
          item.blockquoteLevel &&
          lastBlockquoteLevel !== undefined &&
          lastBlockquoteAlertType !== undefined
        ) {
          // Detect blockquote group boundary by type transition when gap
          // metadata is absent: plain↔alert or alert↔different-alert at
          // the same (or different) nesting level.
          const currentType: GfmAlertType | 'plain' = item.alertType || 'plain';
          if (currentType !== lastBlockquoteAlertType || item.blockquoteLevel !== lastBlockquoteLevel) {
            // Type or level changed — this is a group boundary.  Use gap
            // metadata if available, otherwise default double-newline.
            if (blockquoteGaps && lastBlockquoteGroupIndex !== undefined) {
              const gapCount = blockquoteGaps.get(lastBlockquoteGroupIndex);
              if (gapCount !== undefined && gapCount >= 0) {
                output.push('\n' + '\n'.repeat(gapCount));
              } else {
                output.push('\n\n');
              }
            } else {
              output.push('\n\n');
            }
          } else {
            output.push('\n\n');
          }
        } else if (
          blockquotePostContentBlankLines &&
          !item.blockquoteLevel &&
          pendingPostContentGroupIndex !== undefined &&
          !item.headingLevel &&
          !item.listMeta &&
          !item.isCodeBlock
        ) {
          // Non-blockquote paragraph after a blockquote group: restore the
          // authored blank-line count exactly (including zero-blank adjacency).
          const next = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
          const nextIsBlockquotePara = next?.type === 'para' && !!next.blockquoteLevel;
          const nextIsStructuralPara = next?.type === 'para' && (
            !!next.headingLevel || !!next.listMeta || !!next.isCodeBlock
          );
          if (nextIsBlockquotePara) {
            // Structural separator between blockquote groups — let the
            // blockquote gap logic handle spacing at the next group boundary.
          } else if (nextIsStructuralPara) {
            // Structural separator before heading/list/code-block content.
            // Keep pending metadata so spacing is emitted at the real content.
          } else {
            const blankCount = blockquotePostContentBlankLines.get(pendingPostContentGroupIndex)
              ?? item.emptyParagraphCount;
            if (blankCount !== undefined && blankCount >= 0) {
              output.push('\n' + '\n'.repeat(blankCount));
            } else {
              output.push('\n\n');
            }
            // Consume once: this metadata applies only to the first real
            // content paragraph after a blockquote group.
            pendingPostContentGroupIndex = undefined;
          }
        } else if (
          blockquoteGaps &&
          !item.blockquoteLevel &&
          lastBlockquoteGroupIndex !== undefined &&
          !item.headingLevel &&
          !item.listMeta &&
          !item.isCodeBlock
        ) {
          // Non-blockquote empty para between blockquote groups: check if
          // the gap metadata indicates a direct blockquote-to-blockquote gap
          // (>= 0). Suppress only when the *next* para is a blockquote, so
          // real content paragraphs are never swallowed by this optimization.
          const gapCount = blockquoteGaps.get(lastBlockquoteGroupIndex);
          const next = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
          const nextIsBlockquotePara = next?.type === 'para' && !!next.blockquoteLevel;
          if (gapCount !== undefined && (gapCount >= 0 || gapCount === -1) && nextIsBlockquotePara) {
            // Suppress — gap handled at next blockquote para transition
          } else {
            output.push('\n\n');
          }
        } else {
          output.push('\n\n');
        }
      }

      // Capture previous blockquote group index BEFORE updating, so the
      // alert-marker logic below can detect same-type group boundaries.
      const prevBlockquoteGroupIndex = lastBlockquoteGroupIndex;

      // Track blockquote group index for gap reconstruction.
      // Keep the index across non-blockquote paras so we can detect
      // group transitions even when structural separator paras intervene.
      if (item.blockquoteLevel && item.blockquoteGroupIndex !== undefined) {
        lastBlockquoteGroupIndex = item.blockquoteGroupIndex;
        pendingPostContentGroupIndex = item.blockquoteGroupIndex;
      } else if (item.headingLevel || item.listMeta || item.isCodeBlock) {
        // Real non-blockquote content resets the tracking
        lastBlockquoteGroupIndex = undefined;
        pendingPostContentGroupIndex = undefined;
      }

      // Track blockquote type for boundary detection (plain↔alert, alert↔alert).
      if (item.blockquoteLevel) {
        lastBlockquoteAlertType = item.alertType || 'plain';
        lastBlockquoteLevel = item.blockquoteLevel;
      } else if (item.headingLevel || item.listMeta || item.isCodeBlock) {
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;
      }

      // Emit per-paragraph/list indent sentinel
      if (item.indentOverride && !item.headingLevel && !item.blockquoteLevel && !item.isCodeBlock) {
        if (item.listMeta) {
          // Emit sentinel only before the first item of a list block
          if (!lastListType) {
            // Indent the sentinel to match the list nesting level so it doesn't
            // break an enclosing list as a top-level HTML block (CommonMark §4.6).
            const useTab = options?.listIndent === 'tab';
            const sentinelIndent = useTab
              ? '\t'.repeat(item.listMeta.level)
              : item.listMeta.type === 'bullet'
                ? ' '.repeat(2 * item.listMeta.level)
                : ' '.repeat(3 * item.listMeta.level);
            output.push(sentinelIndent + '<!-- ' + item.indentOverride + ' -->\n');
          }
        } else if (!item.listContinuation) {
          // Skip continuation paragraphs (list items with indented blockquotes) —
          // they're part of the enclosing list block, not standalone paragraphs.
          output.push('<!-- ' + item.indentOverride + ' -->\n');
        }
      }

      if (item.headingLevel) {
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        if (item.paraMarkRevision) {
          // Whole-paragraph insertion/deletion (paragraph mark carries
          // w:ins/w:del): the heading marker belongs inside the Critic span
          // ({++### heading++}), so defer it to the rendered inline text.
          pendingHeadingCriticMarker = {
            marker: '#'.repeat(item.headingLevel) + ' ',
            revType: item.paraMarkRevision.type,
          };
        } else {
          output.push('#'.repeat(item.headingLevel) + ' ');
        }
      } else if (item.listMeta) {
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        const useTab = options?.listIndent === 'tab';
        const indent = useTab
          ? '\t'.repeat(item.listMeta.level)
          : item.listMeta.type === 'bullet'
            ? ' '.repeat(2 * item.listMeta.level)
            : ' '.repeat(3 * item.listMeta.level);
        // For ordered lists: use per-level counters to handle nested lists correctly.
        // startNumber is only applied at a new list boundary (not for continuation items
        // that share the same numId override and thus all carry startNumber).
        if (item.listMeta.type === 'ordered') {
          // Check if the list at this level is continuing or new.
          // `listTypeByLevel` tracks the list type at each nesting level independently,
          // so returning from a nested sub-list (e.g. ordered → bullet → back to ordered)
          // correctly identifies the parent ordered list as a continuation — without this,
          // `lastListType` alone would see "bullet" and reset the counter to 1.
          const levelType = listTypeByLevel.get(item.listMeta.level);
          const isNewListContext = levelType !== 'ordered' && (!lastListType || lastListType !== 'ordered');
          const isNewSubList = lastListLevel !== undefined && item.listMeta.level > lastListLevel;
          if (item.listMeta.startNumber !== undefined && (isNewListContext || isNewSubList)) {
            orderedListCounters.set(item.listMeta.level, item.listMeta.startNumber);
          } else if (isNewListContext) {
            orderedListCounters.set(item.listMeta.level, 1); // new list starts at 1
          } else if (isNewSubList) {
            orderedListCounters.set(item.listMeta.level, 1); // new nested sub-list starts at 1
          }
        }
        listTypeByLevel.set(item.listMeta.level, item.listMeta.type);
        const orderedNum = orderedListCounters.get(item.listMeta.level) ?? 1;
        const marker = item.listMeta.type === 'bullet'
          ? (useTab ? (item.listMeta.bulletMarker ?? '-') + '\t' : (item.listMeta.bulletMarker ?? '-') + ' ')
          : (useTab ? orderedNum + '.\t' : orderedNum + '. ');
        if (item.listMeta.type === 'ordered') orderedListCounters.set(item.listMeta.level, orderedNum + 1);
        output.push(indent + marker);
      } else if (item.blockquoteLevel) {
        const itemPrefix = blockquotePrefix(item);
        output.push(itemPrefix);
        if (item.alertType) {
          const alertKey = item.blockquoteLevel + ':' + item.alertType;
          // A new alert group starts when the key differs OR when the
          // blockquoteGroupIndex has changed (same-type alerts in
          // different groups must each get their own [!TYPE] marker).
          const groupChanged = item.blockquoteGroupIndex !== undefined
            && prevBlockquoteGroupIndex !== undefined
            && item.blockquoteGroupIndex !== prevBlockquoteGroupIndex;
          const isAlertStart = lastAlertParagraphKey !== alertKey || groupChanged;
          if (isAlertStart) {
            output.push(toGfmAlertMarker(item.alertType));
            const isInlineMarker = options?.blockquoteAlertInlineByGroup?.get(item.blockquoteGroupIndex ?? -1) === true;
            if (isInlineMarker) {
              output.push(' ');
              pendingAlertInlinePrefixForHardBreak = item.listContinuation ? itemPrefix : undefined;
            } else {
              output.push('\n' + itemPrefix);
              pendingAlertInlinePrefixForHardBreak = undefined;
            }
            const next = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
            pendingAlertPrefixStrip = (next && next.type !== 'para') ? item.alertType : undefined;
            if (!pendingAlertPrefixStrip) {
              pendingAlertInlinePrefixForHardBreak = undefined;
            }
          } else {
            pendingAlertPrefixStrip = undefined;
            pendingAlertInlinePrefixForHardBreak = undefined;
          }
          lastAlertParagraphKey = alertKey;
        } else {
          lastAlertParagraphKey = undefined;
          pendingAlertPrefixStrip = undefined;
          pendingAlertInlinePrefixForHardBreak = undefined;
        }
      } else {
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
      }

      lastListType = isCurrentList ? item.listMeta!.type : undefined;
      lastListLevel = isCurrentList ? item.listMeta!.level : undefined;
      if (!isCurrentList) listTypeByLevel.clear();

      i++;
      continue;
    }

    if (item.type === 'landscape_open') {
      const gapKey = 'lo' + sentinelLoIdx;
      sentinelLoIdx++;
      // Check if this is a single-table landscape section (table-only, no title/notes).
      // If the custom property says so, suppress the fences and let the table's
      // data-orientation attribute handle it instead.
      if (renderOpts?.landscapeTableIndices?.has(tableIndex)) {
        // Peek ahead: landscape_open → table → landscape_close
        const nextItem = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        const afterTable = i + 2 < mergedContent.length ? mergedContent[i + 2] : undefined;
        if (nextItem?.type === 'table' && afterTable?.type === 'landscape_close') {
          // Skip the open fence; the table will be rendered next with data-orientation.
          // We also need to skip the close fence after the table. Set a flag.
          skipNextLandscapeClose = true;
          i++;
          continue;
        }
      }
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- landscape -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('lo', 'loa');
      i++;
      continue;
    }
    if (item.type === 'landscape_close') {
      const gapKey = 'lc' + sentinelLcIdx;
      sentinelLcIdx++;
      if (skipNextLandscapeClose) {
        skipNextLandscapeClose = false;
        i++;
        continue;
      }
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- /landscape -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('lc', 'lca');
      i++;
      continue;
    }

    if (item.type === 'portrait_open') {
      const gapKey = 'po' + sentinelPoIdx;
      sentinelPoIdx++;
      if (renderOpts?.portraitTableIndices?.has(tableIndex)) {
        const nextItem = i + 1 < mergedContent.length ? mergedContent[i + 1] : undefined;
        const afterTable = i + 2 < mergedContent.length ? mergedContent[i + 2] : undefined;
        if (nextItem?.type === 'table' && afterTable?.type === 'portrait_close') {
          skipNextPortraitClose = true;
          i++;
          continue;
        }
      }
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- portrait -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('po', 'poa');
      i++;
      continue;
    }
    if (item.type === 'portrait_close') {
      const gapKey = 'pc' + sentinelPcIdx;
      sentinelPcIdx++;
      if (skipNextPortraitClose) {
        skipNextPortraitClose = false;
        i++;
        continue;
      }
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- /portrait -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('pc', 'pca');
      i++;
      continue;
    }

    if (item.type === 'bibliography_marker') {
      if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- references -->');
      lastListType = undefined;
      lastListLevel = undefined;
      listTypeByLevel.clear();
      lastAlertParagraphKey = undefined;
      pendingAlertPrefixStrip = undefined;
      pendingAlertInlinePrefixForHardBreak = undefined;
      lastBlockquoteAlertType = undefined;
      lastBlockquoteLevel = undefined;
      i++;
      continue;
    }

    if (item.type === 'custom_style_open') {
      const gapKey = 'cso' + sentinelCsoIdx;
      sentinelCsoIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- style: ' + item.styleName + ' -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('cso', 'csoa');
      i++;
      continue;
    }
    if (item.type === 'custom_style_close') {
      const gapKey = 'csc' + sentinelCscIdx;
      sentinelCscIdx++;
      if (emitSentinelSep(gapKey)) {
        // gap metadata handled it
      } else if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('<!-- /style -->');
      lastWasSectionSentinel = true;
      lastSentinelAfterGapKey = gapKey.replace('csc', 'csca');
      i++;
      continue;
    }

    if (item.type === 'math' && item.display) {
      // Ensure blank line before display math
      if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      const mathBlock = MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(item.latex) + '\n' + MATH_FENCE;
      output.push(item.revision ? wrapWithRevision(mathBlock, item.revision) : mathBlock);
      // A display math block breaks list flow; reset list continuation state.
      lastListType = undefined;
      lastListLevel = undefined;
      listTypeByLevel.clear();
      lastAlertParagraphKey = undefined;
      pendingAlertPrefixStrip = undefined;
      pendingAlertInlinePrefixForHardBreak = undefined;
      lastBlockquoteAlertType = undefined;
      lastBlockquoteLevel = undefined;
      i++;
      continue;
    }

    if (item.type === 'table') {
      flushPendingHeadingCriticMarker();
      if (incomingSep !== null) {
        output.push(incomingSep);
      } else if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      // If this table was originally an embed directive, emit the directive instead of
      // rendering the table. Table directives (font-size, etc.) are emitted as a prefix
      // before the embed directive. Multi-table embeds (e.g. a .md file with 2 tables)
      // produce multiple consecutive tables sharing the same directive — emit it once
      // and skip the rest to avoid snowballing duplicates on round-trip.
      const rawEmbedValue = renderOpts?.embedDirectiveMapping?.get(String(tableIndex));
      if (rawEmbedValue) {
        // Stored value may be prefixed with embedIdx + tab to distinguish
        // separate embed occurrences that share the same directive text.
        const tabPos = rawEmbedValue.indexOf('\t');
        const embedDirective = tabPos >= 0 ? rawEmbedValue.substring(tabPos + 1) : rawEmbedValue;
        const { fontPrefix: embedPrefix } = buildTableDirectivePrefix(renderOpts, tableIndex);
        pushWithHoistedPrefix(output, embedPrefix, embedDirective);
        tableIndex++;
        i++;
        // Skip subsequent tables from the same embed occurrence (same raw stored value).
        // Tolerate intervening empty paragraphs that Word may insert between tables.
        while (i < mergedContent.length) {
          const cur = mergedContent[i];
          if (cur.type === 'table'
            && renderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === rawEmbedValue) {
            tableIndex++;
            i++;
          } else if (cur.type === 'para' && isPlainEmptyParagraph(cur)
            && !paragraphHasContent(mergedContent, i)) {
            // Peek ahead: only skip the empty paragraph if a table from the
            // same embed follows (avoid swallowing trailing blank lines).
            let peek = i + 1;
            while (peek < mergedContent.length && mergedContent[peek].type === 'para'
              && isPlainEmptyParagraph(mergedContent[peek] as Extract<ContentItem, { type: 'para' }>)
              && !paragraphHasContent(mergedContent, peek)) {
              peek++;
            }
            if (peek < mergedContent.length && mergedContent[peek].type === 'table'
              && renderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === rawEmbedValue) {
              // Skip empty paragraphs up to and including the next embed table
              i = peek;
              // The table itself will be consumed on the next loop iteration
            } else {
              break;
            }
          } else {
            break;
          }
        }
        lastListType = undefined;
        lastListLevel = undefined;
        listTypeByLevel.clear();
        lastAlertParagraphKey = undefined;
        pendingAlertPrefixStrip = undefined;
        pendingAlertInlinePrefixForHardBreak = undefined;
        lastBlockquoteAlertType = undefined;
        lastBlockquoteLevel = undefined;
        continue;
      }
      const storedFormat = renderOpts?.tableFormatMapping?.get(String(tableIndex));
      const tableResult = renderTableOrFallback(item, comments, options, renderOpts, storedFormat, tableIndex);
      pushWithHoistedPrefix(output, tableResult.directivePrefix, tableResult.body);
      tableIndex++;
      lastListType = undefined;
      lastListLevel = undefined;
      listTypeByLevel.clear();
      lastAlertParagraphKey = undefined;
      pendingAlertPrefixStrip = undefined;
      pendingAlertInlinePrefixForHardBreak = undefined;
      lastBlockquoteAlertType = undefined;
      lastBlockquoteLevel = undefined;
      i++;
      continue;
    }

    // Track standalone HTML comment paragraphs for gap metadata and emit their
    // separator. A leading comment in an alert paragraph is inline content;
    // pendingAlertPrefixStrip means its blockquote prefix was already emitted.
    if (item.type === 'html_comment' && !pendingAlertPrefixStrip) {
      if (output.length > 0) {
        if (incomingSep !== null) {
          output.push(incomingSep);
        } else {
          // Use before-gap metadata for this html_comment.
          // The empty para marker that precedes the html_comment item may have
          // already contributed newlines to the output (via the para separator
          // chain).  Count existing trailing newlines and only add the delta so
          // the total matches the original source gap.
          const gapCount = htmlCommentGaps?.get(htmlCommentIndex);
          if (gapCount !== undefined) {
            const desiredNewlines = gapCount + 1; // gapCount blank lines = gapCount+1 \n
            // Count trailing newlines already in output
            let existingNewlines = 0;
            for (let oi = output.length - 1; oi >= 0; oi--) {
              const s = output[oi];
              let j = s.length - 1;
              while (j >= 0 && s[j] === '\n') { existingNewlines++; j--; }
              if (j >= 0) break; // hit non-newline content, stop
            }
            const needed = desiredNewlines - existingNewlines;
            if (needed > 0) {
              output.push('\n'.repeat(needed));
            } else if (needed < 0) {
              // Too many trailing newlines — trim excess from the output tail
              let toRemove = -needed;
              while (toRemove > 0 && output.length > 0) {
                const last = output[output.length - 1];
                let trailingNL = 0;
                for (let j = last.length - 1; j >= 0 && last[j] === '\n'; j--) trailingNL++;
                if (trailingNL === 0) break;
                const removeFromThis = Math.min(toRemove, trailingNL);
                if (removeFromThis === last.length) {
                  output.pop();
                } else {
                  output[output.length - 1] = last.slice(0, last.length - removeFromThis);
                }
                toRemove -= removeFromThis;
              }
            }
          } else if (!output[output.length - 1].endsWith('\n\n')) {
            output.push('\n\n');
          }
        }
      }
      lastRenderedHtmlCommentIndex = htmlCommentIndex;
      htmlCommentIndex++;
    }

    const rendered = renderInlineRange(mergedContent, i, comments, { stopBeforeDisplayMath: true }, renderOpts);
    if (rendered.nextIndex <= i) {
      throw new Error('Invariant violated: renderInlineRange did not advance index');
    }
    let strippedAlertLeadHadHardBreak = false;
    let textOut = rendered.text;
    if (pendingAlertPrefixStrip) {
      if (options?.calloutLabels === false) {
        // Marker-only alerts retain one parser-introduced leading space when the
        // generated label/break is absent; remove only that known artifact.
        if (textOut.startsWith(' ')) textOut = textOut.slice(1);
      } else {
        textOut = stripAlertLeadPrefix(rendered.text, pendingAlertPrefixStrip);
        const removedLen = rendered.text.length - textOut.length;
        if (removedLen > 0 && rendered.text.slice(0, removedLen).includes('\n')) {
          strippedAlertLeadHadHardBreak = true;
        }
      }
    }
    if (pendingAlertInlinePrefixForHardBreak !== undefined && (textOut.startsWith('\n') || textOut.startsWith('\\\n') || strippedAlertLeadHadHardBreak)) {
      const markerIdx = output.length - 1;
      const continuationPrefix = '\n' + pendingAlertInlinePrefixForHardBreak;
      if (markerIdx >= 0 && output[markerIdx].endsWith(' ')) {
        output[markerIdx] = output[markerIdx].slice(0, -1) + continuationPrefix;
      } else {
        output.push(continuationPrefix);
      }
      if (textOut.startsWith('\\\n')) {
        textOut = textOut.slice(2);
      } else if (textOut.startsWith('\n')) {
        textOut = textOut.slice(1);
      }
    }
    pendingAlertPrefixStrip = undefined;
    pendingAlertInlinePrefixForHardBreak = undefined;
    if (pendingHeadingCriticMarker !== undefined) {
      // Re-insert the heading marker inside the leading Critic span so the
      // whole-paragraph form {++### heading++} round-trips. If the inline
      // content doesn't start with a Critic addition/deletion (unexpected),
      // fall back to a plain heading prefix.
      const openMatch = /^\{(\+\+|--)/.exec(textOut);
      if (openMatch) {
        textOut = textOut.slice(0, openMatch[0].length) + pendingHeadingCriticMarker.marker + textOut.slice(openMatch[0].length);
      } else {
        textOut = pendingHeadingCriticMarker.marker + textOut;
      }
      pendingHeadingCriticMarker = undefined;
    }
    if (rendered.deferredComments.length > 0) {
      // Strip trailing newlines (from <w:br/> between comment references in round-tripped DOCX)
      output.push(textOut.replace(/(\\?\n)+$/, ''));
      output.push('\n');
      output.push(rendered.deferredComments.join('\n'));
    } else {
      output.push(textOut);
    }
    i = rendered.nextIndex;
  }
  // Trailing empty revised heading: serialize its deferred marker.
  flushPendingHeadingCriticMarker();

  // Append footnote definitions
  if (options?.notes) {
    const notesInfo = options.notes;
    // Sort entries by label (numeric first, then alpha)
    const entries = [...notesInfo.map.values()].sort((a, b) => {
      const na = parseInt(a.label, 10);
      const nb = parseInt(b.label, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.label.localeCompare(b.label);
    });
    // Use note-specific image format mapping when rendering note bodies,
    // merging with the document-body mapping so note overrides fall back
    // to the original imageFormatMapping where keys are missing.
    const noteRenderOpts = renderOpts.noteImageFormatMapping
      ? { ...renderOpts, imageFormatMapping: { ...renderOpts.imageFormatMapping, ...renderOpts.noteImageFormatMapping } }
      : renderOpts;
    for (const entry of entries) {
      output.push('\n\n');
      const bodyMerged = mergeConsecutiveRuns(entry.body);
      // Render body, splitting on para/table markers for multi-paragraph footnotes
      const bodyParts: string[] = [];
      const deferredAll: string[] = [];
      let partStart = 0;
      for (let bi = 0; bi < bodyMerged.length; bi++) {
        const item = bodyMerged[bi];
        if (item.type === 'para') {
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            bodyParts.push(part.text);
            deferredAll.push(...part.deferredComments);
          }
          partStart = bi + 1;
        } else if (item.type === 'math' && item.display) {
          // Flush preceding inline content and keep display math as its own block part.
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            bodyParts.push(part.text);
            deferredAll.push(...part.deferredComments);
          }
          const mathBlock = MATH_FENCE + '\n' + canonicalizeDisplayMathLatex(item.latex) + '\n' + MATH_FENCE;
          bodyParts.push(item.revision ? wrapWithRevision(mathBlock, item.revision) : mathBlock);
          partStart = bi + 1;
        } else if (item.type === 'table') {
          // Flush preceding inline content
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
            bodyParts.push(part.text);
            deferredAll.push(...part.deferredComments);
          }
          const noteRawEmbedValue = noteRenderOpts?.embedDirectiveMapping?.get(String(tableIndex));
          if (noteRawEmbedValue) {
            const noteTabPos = noteRawEmbedValue.indexOf('\t');
            const noteEmbedDirective = noteTabPos >= 0 ? noteRawEmbedValue.substring(noteTabPos + 1) : noteRawEmbedValue;
            const { fontPrefix: noteEmbedPrefix } = buildTableDirectivePrefix(noteRenderOpts, tableIndex);
            bodyParts.push(noteEmbedPrefix + noteEmbedDirective);
            tableIndex++;
            bi++;
            // Skip subsequent tables from the same embed occurrence,
            // including Word-inserted empty paragraphs between them
            while (bi < bodyMerged.length) {
              const next = bodyMerged[bi];
              if (next.type === 'table'
                && noteRenderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === noteRawEmbedValue) {
                tableIndex++;
                bi++;
              } else if (next.type === 'para' && isPlainEmptyParagraph(next)
                && !paragraphHasContent(bodyMerged, bi)) {
                // Only skip plain empty spacer paragraphs when they sit
                // between tables from the same embed occurrence.
                let peek = bi + 1;
                while (peek < bodyMerged.length && bodyMerged[peek].type === 'para'
                  && isPlainEmptyParagraph(bodyMerged[peek] as Extract<ContentItem, { type: 'para' }>)
                  && !paragraphHasContent(bodyMerged, peek)) {
                  peek++;
                }
                if (peek < bodyMerged.length && bodyMerged[peek].type === 'table'
                  && noteRenderOpts?.embedDirectiveMapping?.get(String(tableIndex)) === noteRawEmbedValue) {
                  bi = peek;
                } else {
                  break;
                }
              } else if (next.type === 'text' && !next.text?.trim()) {
                bi++;
              } else {
                break;
              }
            }
            partStart = bi;
            bi--; // compensate for the for-loop's bi++ on continue
            continue;
          } else {
            const noteStoredFormat = noteRenderOpts?.tableFormatMapping?.get(String(tableIndex));
            const noteTableResult = renderTableOrFallback(item, comments, options, noteRenderOpts, noteStoredFormat, tableIndex);
            if (noteTableResult.directivePrefix) {
              bodyParts.push(noteTableResult.directivePrefix.replace(/\n+$/, '') + '\n' + noteTableResult.body);
            } else {
              bodyParts.push(noteTableResult.body);
            }
          }
          tableIndex++;
          partStart = bi + 1;
        }
      }
      if (partStart < bodyMerged.length) {
        const part = renderInlineRange(bodyMerged, partStart, comments, { stopBeforeDisplayMath: true }, noteRenderOpts);
        bodyParts.push(part.text);
        deferredAll.push(...part.deferredComments);
      }
      if (bodyParts.length === 0) {
        bodyParts.push('');
      }
      const indent4 = (s: string) => s.split('\n').map(l => '    ' + l).join('\n');
      const first = bodyParts[0].replace(/^\s+/, '');
      if (first.includes('\n')) {
        // Block form: label on its own line, blank line, then indented body
        output.push(`[^${entry.label}]:\n\n` + indent4(first));
      } else {
        output.push(`[^${entry.label}]: ${first}`);
      }
      for (let pi = 1; pi < bodyParts.length; pi++) {
        output.push('\n\n' + indent4(bodyParts[pi]));
      }
      if (deferredAll.length > 0) {
        output.push('\n');
        output.push(deferredAll.map(l => indent4(l)).join('\n'));
      }
    }
  }

  return output.join('');
}

function formatOffsetString(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatLocalIsoMinute(ts: string): string {
  const dt = new Date(ts);
  if (isNaN(dt.getTime())) {
    throw new Error(`Invalid timestamp: ${ts}`);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function getLocalTimezoneOffset(): string {
  return formatOffsetString(-new Date().getTimezoneOffset());
}

// BibTeX generation

/**
 * Escape special LaTeX/BibTeX characters in field values.
 * Note: this converter-side helper escapes normalized metadata directly; parser-side
 * `src/bibtex-parser.ts` uses an idempotent escape path for round-trip safety.
 */
export function escapeBibtex(s: string): string {
  return s.replace(/([&%$#_{}~^\\])/g, '\\$1');
}

/** Map CSL type back to the most appropriate BibTeX entry type. */
export function mapCSLTypeToBibtex(cslType: string, genre?: string): string {
  switch (cslType) {
    case 'article-journal':
    case 'article-magazine':
    case 'article-newspaper':
      return 'article';
    case 'book':
      return 'book';
    case 'chapter':
      return 'incollection';
    case 'paper-conference':
      return 'inproceedings';
    case 'thesis':
      return genre && /master/i.test(genre) ? 'mastersthesis' : 'phdthesis';
    case 'report':
      return 'techreport';
    default:
      return 'misc';
  }
}

/** Serialize a single CSL name entry to BibTeX author format. */
function serializeAuthor(a: { family?: string; given?: string; literal?: string }): string {
  if (a.literal) return `{${escapeBibtex(a.literal)}}`;
  return [a.family, a.given].filter((s): s is string => Boolean(s)).map(escapeBibtex).join(', ');
}

/** CSL fields whose values are verbatim identifiers — not LaTeX text.
 *  These must NOT be run through escapeBibtex because escaping `_`, `%`,
 *  `#`, `~` corrupts URLs, DOIs, and similar machine-readable strings. */
const VERBATIM_CSL_FIELDS: ReadonlySet<string> = new Set([
  'DOI', 'URL', 'ISBN', 'ISSN',
]);

/** CSL-JSON field → BibTeX field mapping (for fields stored in fullItemData). */
const CSL_TO_BIBTEX: Record<string, string> = {
  'editor': 'editor',
  'publisher': 'publisher',
  'publisher-place': 'address',
  'URL': 'url',
  'ISBN': 'isbn',
  'ISSN': 'issn',
  'issue': 'number',
  'edition': 'edition',
  'abstract': 'abstract',
  'note': 'note',
  'collection-title': 'series',
};

export function generateBibTeX(
  zoteroCitations: ZoteroCitation[],
  keyMap: Map<string, string>,
  originalKeyOrder?: string[] | null,
): string {
  const entries: string[] = [];
  const entryByKey = originalKeyOrder ? new Map<string, string>() : null;
  const emitted = new Set<string>();

  for (const citation of zoteroCitations) {
    for (const meta of citation.items) {
      const id = itemIdentifier(meta);
      if (emitted.has(id)) { continue; }
      emitted.add(id);

      const key = keyMap.get(id);
      if (!key) { continue; }

      const authorStr = meta.authors.map(serializeAuthor).join(' and ');

      const genre = meta.fullItemData.genre;
      const entryType = mapCSLTypeToBibtex(meta.type, typeof genre === 'string' ? genre : undefined);
      const fields: string[] = [];
      const alreadyEmitted = new Set<string>();

      if (authorStr) { fields.push(`  author = {${authorStr}}`); alreadyEmitted.add('author'); }
      if (meta.title) { fields.push(`  title = {{${escapeBibtex(meta.title)}}}`); alreadyEmitted.add('title'); }

      // Emit container-title as journal or booktitle depending on entry type
      if (meta.journal) {
        if (entryType === 'incollection' || entryType === 'inproceedings') {
          fields.push(`  booktitle = {${escapeBibtex(meta.journal)}}`);
        } else {
          fields.push(`  journal = {${escapeBibtex(meta.journal)}}`);
        }
        alreadyEmitted.add('container-title');
      }

      if (meta.volume) { fields.push(`  volume = {${escapeBibtex(meta.volume)}}`); alreadyEmitted.add('volume'); }
      if (meta.pages) { fields.push(`  pages = {${escapeBibtex(meta.pages)}}`); alreadyEmitted.add('page'); }
      if (meta.year) { fields.push(`  year = {${escapeBibtex(meta.year)}}`); alreadyEmitted.add('issued'); }
      if (meta.doi) { fields.push(`  doi = {${meta.doi}}`); alreadyEmitted.add('DOI'); }

      // Editor from fullItemData
      const editorData = meta.fullItemData?.editor;
      if (Array.isArray(editorData) && editorData.length > 0) {
        const editorStr = editorData.map(serializeAuthor).join(' and ');
        if (editorStr) { fields.push(`  editor = {${editorStr}}`); }
        alreadyEmitted.add('editor');
      }

      // Institution for techreport entries: prefer explicit x-institution
      // (BibTeX roundtrip), then fall back to publisher (Zotero maps its
      // "Institution" field to CSL publisher for report types).
      if (entryType === 'techreport') {
        const xInstitution = meta.fullItemData?.['x-institution'];
        if (typeof xInstitution === 'string' && xInstitution) {
          fields.push(`  institution = {${escapeBibtex(xInstitution)}}`);
        } else {
          const pub = meta.fullItemData?.publisher;
          if (typeof pub === 'string' && pub) {
            fields.push(`  institution = {${escapeBibtex(pub)}}`);
            alreadyEmitted.add('publisher');
          }
        }
      }

      // Additional CSL→BibTeX fields from fullItemData
      for (const [cslField, bibtexField] of Object.entries(CSL_TO_BIBTEX)) {
        if (alreadyEmitted.has(cslField)) continue;
        if (cslField === 'editor') continue; // handled above
        const val = meta.fullItemData?.[cslField];
        if (val != null && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
          const strVal = String(val);
          fields.push(`  ${bibtexField} = {${VERBATIM_CSL_FIELDS.has(cslField) ? strVal : escapeBibtex(strVal)}}`);
          alreadyEmitted.add(cslField);
        }
      }

      if (meta.zoteroKey) { fields.push(`  zotero-key = {${meta.zoteroKey}}`); }
      if (meta.zoteroUri) { fields.push(`  zotero-uri = {${escapeBibtex(meta.zoteroUri)}}`); }

      const entryStr = `@${entryType}{${key},\n${fields.join(',\n')},\n}`;
      entries.push(entryStr);
      if (entryByKey) entryByKey.set(key, entryStr);
    }
  }

  // Reorder output to match original key order when provided (used by Layer 2 caller)
  if (originalKeyOrder && originalKeyOrder.length > 0 && entryByKey) {
    const ordered: string[] = [];
    const remaining = new Map(entryByKey);
    for (const key of originalKeyOrder) {
      const entry = remaining.get(key);
      if (entry) {
        ordered.push(entry);
        remaining.delete(key);
      }
    }
    // Append any entries not in the original order (new citations added in Word)
    for (const entry of remaining.values()) {
      ordered.push(entry);
    }
    return ordered.join('\n\n');
  }

  return entries.join('\n\n');
}

/**
 * Extract consecutive Title-styled paragraphs from the beginning of the document.
 * Returns the plain text of each title paragraph. Removes the extracted items
 * (para markers and their text runs) from the content array in place.
 */
export function extractTitleLines(content: ContentItem[]): string[] {
  const titles: string[] = [];
  let i = 0;

  while (i < content.length) {
    const item = content[i];
    // Skip leading plain para separators (no heading/list/title) that precede the first title
    if (item.type === 'para' && !item.isTitle && !item.headingLevel && !item.listMeta && titles.length === 0) {
      i++;
      continue;
    }
    if (item.type !== 'para' || !item.isTitle) break;

    // Collect text runs following this title para marker
    const startIdx = i;
    i++;
    let text = '';
    while (i < content.length && content[i].type === 'text') {
      text += (content[i] as { type: 'text'; text: string }).text;
      i++;
    }
    titles.push(text);
    // Remove extracted items
    content.splice(startIdx, i - startIdx);
    i = startIdx;
  }

  return titles;
}

/** Extract dc:creator from docProps/core.xml (the document author). */
export async function extractAuthor(zip: JSZip): Promise<string | undefined> {
  const parsed = await readZipXml(zip, 'docProps/core.xml');
  if (!parsed) return undefined;
  for (const node of findAllDeep(parsed, 'dc:creator')) {
    const text = nodeText(asXmlNodes(node['dc:creator'])).trim();
    if (text) return text;
  }
  return undefined;
}

type AwaitedRecord<T extends Record<string, PromiseLike<unknown>>> = {
  [K in keyof T]: Awaited<T[K]>;
};

async function allNamed<T extends Record<string, PromiseLike<unknown>>>(promises: T): Promise<AwaitedRecord<T>> {
  const entries = await Promise.all(Object.entries(promises).map(
    async ([key, promise]) => [key, await promise] as const,
  ));
  return Object.fromEntries(entries) as AwaitedRecord<T>;
}

// Main conversion

/** Extract heading/title font properties from word/styles.xml for round-trip. */
function extractFontOverridesFromStyles(stylesXml: string, opts?: { explicitTableFontSize?: boolean }): Partial<Frontmatter> {
  const result: Partial<Frontmatter> = {};

  // Helper: find a style block by styleId and extract rPr content
  function getStyleRPr(styleId: string): string | null {
    let searchFrom = 0;
    while (true) {
      const idx = stylesXml.indexOf('<w:style ', searchFrom);
      if (idx === -1) return null;
      const closeTag = stylesXml.indexOf('</w:style>', idx);
      if (closeTag === -1) return null;
      const block = stylesXml.substring(idx, closeTag + '</w:style>'.length);
      if (block.includes('w:styleId="' + styleId + '"')) {
        // Skip past pPr to find style-level rPr
        const pPrEnd = block.indexOf('</w:pPr>');
        const rPrStart = block.indexOf('<w:rPr>', pPrEnd !== -1 ? pPrEnd : 0);
        const rPrEnd = block.indexOf('</w:rPr>', rPrStart !== -1 ? rPrStart : 0);
        if (rPrStart !== -1 && rPrEnd !== -1) return block.substring(rPrStart, rPrEnd + '</w:rPr>'.length);
        return null;
      }
      searchFrom = closeTag + '</w:style>'.length;
    }
  }

  function extractAttr(rpr: string, prefix: string): string | null {
    const idx = rpr.indexOf(prefix);
    if (idx === -1) return null;
    const start = idx + prefix.length;
    const end = rpr.indexOf('"', start);
    return end !== -1 ? rpr.substring(start, end) : null;
  }

  function extractFont(rpr: string): string | undefined {
    const v = extractAttr(rpr, 'w:ascii="');
    return v || undefined;
  }

  function extractSizeHp(rpr: string): number | undefined {
    const v = extractAttr(rpr, '<w:sz w:val="');
    return v ? Number(v) : undefined;
  }

  function isXmlToggleOn(rpr: string, tag: string): boolean {
    // Self-closing with no attributes: <w:b/>
    if (rpr.includes('<' + tag + '/>')) return true;
    // Tag with attributes: <w:b w:val="true"/>  or  <w:b w:val="1">
    const re = new RegExp('<' + tag + '\\s[^>]*?(?:/>|>)');
    const m = re.exec(rpr);
    if (!m) return false;
    const vm = /w:val="([^"]*)"/.exec(m[0]);
    if (!vm) return true; // present with no w:val → on
    const v = vm[1];
    return v === 'true' || v === '1' || v === 'on';
  }

  function extractStyle(rpr: string, ppr?: string | null): string {
    const parts: string[] = [];
    if (isXmlToggleOn(rpr, 'w:b')) parts.push('bold');
    if (isXmlToggleOn(rpr, 'w:i')) parts.push('italic');
    // Underline: bare <w:u/> or any w:val except "none"
    if (rpr.includes('<w:u/>') || (rpr.includes('<w:u ') && !rpr.includes('w:val="none"'))) parts.push('underline');
    if (isXmlToggleOn(rpr, 'w:smallCaps')) parts.push('smallcaps');
    if (isXmlToggleOn(rpr, 'w:caps')) parts.push('allcaps');
    // Center alignment from pPr (paragraph-level property)
    if (ppr && ppr.includes('<w:jc w:val="center"/>')) parts.push('center');
    return parts.length > 0 ? parts.join('-') : 'normal';
  }

  /** Extract pPr content from a style block. */
  function getStylePPr(styleId: string): string | null {
    let searchFrom = 0;
    while (true) {
      const idx = stylesXml.indexOf('<w:style ', searchFrom);
      if (idx === -1) return null;
      const closeTag = stylesXml.indexOf('</w:style>', idx);
      if (closeTag === -1) return null;
      const block = stylesXml.substring(idx, closeTag + '</w:style>'.length);
      if (block.includes('w:styleId="' + styleId + '"')) {
        const pPrStart = block.indexOf('<w:pPr');
        const pPrEnd = block.indexOf('</w:pPr>');
        if (pPrStart !== -1 && pPrEnd !== -1) return block.substring(pPrStart, pPrEnd + '</w:pPr>'.length);
        return null;
      }
      searchFrom = closeTag + '</w:style>'.length;
    }
  }

  // Extract Normal (body) font for comparison
  const normalRpr = getStyleRPr('Normal');
  const bodyFont = normalRpr ? extractFont(normalRpr) : undefined;
  const bodySizeHp = normalRpr ? extractSizeHp(normalRpr) : undefined;

  // Emit body font/fontSize when they differ from Word defaults
  if (bodyFont && bodyFont !== 'Calibri') result.font = bodyFont;
  if (bodySizeHp !== undefined && bodySizeHp !== 22) result.fontSize = bodySizeHp / 2;

  // Default heading sizes in half-points
  const defaultHp: Record<string, number> = {
    Heading1: 32, Heading2: 26, Heading3: 24, Heading4: 22, Heading5: 20, Heading6: 18,
  };
  const ids = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];

  const fonts: (string | undefined)[] = [];
  const sizes: (number | undefined)[] = [];
  const styles: (string | undefined)[] = [];

  for (const id of ids) {
    const rpr = getStyleRPr(id);
    if (rpr) {
      fonts.push(extractFont(rpr));
      sizes.push(extractSizeHp(rpr));
      styles.push(extractStyle(rpr, getStylePPr(id)));
    } else {
      fonts.push(undefined);
      sizes.push(undefined);
      styles.push(undefined);
    }
  }

  // Trim trailing duplicates helper
  function trimTrailing<T>(arr: T[]): T[] {
    let end = arr.length;
    while (end > 1 && arr[end - 1] === arr[end - 2]) end--;
    return arr.slice(0, end);
  }

  // headerFont: emit if any heading font differs from body font
  const hFonts = fonts.map(f => f || bodyFont);
  if (hFonts.some(f => f && f !== bodyFont)) {
    const trimmed = trimTrailing(hFonts.filter((f): f is string => !!f));
    if (trimmed.length > 0) result.headerFont = trimmed;
  }

  // headerFontSize: emit if any heading size differs from default
  // Fill undefined entries with defaults to preserve positional alignment
  if (sizes.some((s, i) => s !== undefined && s !== defaultHp[ids[i]])) {
    const ptSizes = sizes.map((s, i) => (s !== undefined ? s : defaultHp[ids[i]]) / 2);
    result.headerFontSize = trimTrailing(ptSizes);
  }

  // headerFontStyle: emit if any heading style differs from default (bold)
  // Fill undefined entries with 'bold' (default heading style) to preserve positional alignment
  if (styles.some(s => s !== undefined && s !== 'bold')) {
    const filled = styles.map(s => s !== undefined ? s : 'bold');
    result.headerFontStyle = trimTrailing(filled);
  }

  // Title extraction
  const titleRpr = getStyleRPr('Title');
  if (titleRpr) {
    const tFont = extractFont(titleRpr);
    if (tFont && tFont !== bodyFont) result.titleFont = [tFont];
    const tSizeHp = extractSizeHp(titleRpr);
    if (tSizeHp !== undefined && tSizeHp !== 56) result.titleFontSize = [tSizeHp / 2];
    const tStyle = extractStyle(titleRpr, getStylePPr('Title'));
    if (tStyle !== 'normal') result.titleFontStyle = [tStyle];
  }

  // TableParagraph extraction
  const tableRpr = getStyleRPr('TableParagraph');
  if (tableRpr) {
    const tblFont = extractFont(tableRpr);
    if (tblFont && tblFont !== bodyFont) result.tableFont = tblFont;
    const tblSizeHp = extractSizeHp(tableRpr);
    if (tblSizeHp !== undefined) {
      const bsHp = bodySizeHp ?? 22;
      // Suppress table-font-size when it matches auto-shrink default (body - 4hp),
      // since auto-shrink always reproduces it on import — unless the original
      // frontmatter explicitly set table-font-size (explicitTableFontSize flag).
      const autoDefault = Math.max(1, bsHp - 4);
      if (opts?.explicitTableFontSize || tblSizeHp !== autoDefault) {
        result.tableFontSize = tblSizeHp / 2;
      }
    }
  }

  // Custom named styles: detect "Custom: ..." styles for fallback extraction
  const extractedCustomStyles: Record<string, CustomStyleDef> = {};
  let csSearchPos = 0;
  while (true) {
    const idx = stylesXml.indexOf('w:customStyle="1"', csSearchPos);
    if (idx === -1) break;
    // Find enclosing <w:style> block
    const styleStart = stylesXml.lastIndexOf('<w:style ', idx);
    const styleEnd = stylesXml.indexOf('</w:style>', idx);
    if (styleStart === -1 || styleEnd === -1) { csSearchPos = idx + 17; continue; }
    const block = stylesXml.substring(styleStart, styleEnd + '</w:style>'.length);
    const nameMatch = block.match(/w:name\s+w:val="Custom:\s*([^"]+)"/);
    if (!nameMatch) { csSearchPos = styleEnd + 10; continue; }
    const styleName = nameMatch[1].trim();
    const csStyleIdMatch = block.match(/w:styleId="([^"]+)"/);
    const csStyleId = csStyleIdMatch ? csStyleIdMatch[1] : '';
    const def: CustomStyleDef = {};
    const csRpr = getStyleRPr(csStyleId);
    if (csRpr) {
      const f = extractFont(csRpr);
      if (f && f !== bodyFont) def.font = f;
      const s = extractSizeHp(csRpr);
      if (s !== undefined) def.fontSize = s / 2;
      const st = extractStyle(csRpr, getStylePPr(csStyleId));
      if (st !== 'normal') def.fontStyle = st;
    }
    const csPpr = getStylePPr(csStyleId);
    if (csPpr) {
      const beforeMatch = csPpr.match(/w:before="(\d+)"/);
      if (beforeMatch) def.spacingBefore = parseInt(beforeMatch[1], 10) / 20;
      const afterMatch = csPpr.match(/w:after="(\d+)"/);
      if (afterMatch) def.spacingAfter = parseInt(afterMatch[1], 10) / 20;
      const firstLineMatch = csPpr.match(/w:firstLine="(\d+)"/);
      if (firstLineMatch) {
        const firstLineTwips = parseInt(firstLineMatch[1], 10);
        def.paragraphIndent = firstLineTwips === 0 ? 'none' : firstLineTwips / 1440;
      }
    }
    extractedCustomStyles[styleName] = def;
    csSearchPos = styleEnd + 10;
  }
  if (Object.keys(extractedCustomStyles).length > 0) result.styles = extractedCustomStyles;

  return result;
}

export async function convertDocx(
  data: Uint8Array,
  format: CitationKeyFormat = 'authorYearTitle',
  options?: { tableIndent?: string; alwaysUseCommentIds?: boolean; imageFolder?: string; pipeTableMaxLineWidth?: number; pipeTableMaxLineWidthDefault?: number; gridTableMaxLineWidth?: number; gridTableMaxLineWidthDefault?: number; existingBibtex?: string; preferredBibliographyPath?: string },
): Promise<ConvertResult> {
  const zip = await loadZip(data);
  const {
    comments,
    zoteroCitations,
    zoteroPrefs,
    author,
    commentIdMapping,
    footnoteIdMapping,
    footnoteCrossRefMapping,
    codeBlockLangMapping,
    threads,
    codeBlockStyling,
    blockquoteGapMapping,
    blockquotePreContentBlankLineMapping,
    blockquotePostContentBlankLineMapping,
    blockquoteAlertStyleMapping,
    imageFormatMapping,
    noteImageFormatMapping,
    tableFormatMapping,
    pipeTableAlignedMapping,
    gridSourceColWidthsMapping,
    tableFontSizeMapping,
    tableFontMapping,
    tableColWidthsMapping,
    tableDigitsMapping,
    tableDecimalMarkMapping,
    tableDigitGroupingMapping,
    storedPipeTableMaxLineWidth,
    storedGridTableMaxLineWidth,
    storedListIndent,
    consecutiveReplyParaIds,
    storedFrontmatterBlankLines,
    htmlCommentGapMapping,
    bibKeyOrder,
    storedBibData,
    storedBibliographyPath,
    landscapeTableMapping,
    portraitTableMapping,
    portraitBreaks,
    explicitTableFontSize,
    storedFieldOrder,
    htmlCommentAfterGapMapping,
    sentinelGapMapping,
    defaultTableColWidths,
    storedCustomStyles,
    storedTableBorders,
    storedLineSpacing,
    storedParagraphIndent,
    storedBibHangingIndent,
    storedCalloutLabels,
    storedIndentOverrides,
    storedListIndentOverrides,
    embedDirectiveMapping,
    defaultTableDigits,
    defaultTableDecimalMark,
    defaultTableDigitGrouping,
  } = await allNamed({
    comments: extractComments(zip),
    zoteroCitations: extractZoteroCitations(zip),
    zoteroPrefs: extractZoteroPrefs(zip),
    author: extractAuthor(zip),
    commentIdMapping: extractCommentIdMapping(zip),
    footnoteIdMapping: extractFootnoteIdMapping(zip),
    footnoteCrossRefMapping: extractFootnoteCrossRefMapping(zip),
    codeBlockLangMapping: extractCodeBlockLanguageMapping(zip),
    threads: extractCommentThreads(zip),
    codeBlockStyling: extractCodeBlockStyling(zip),
    blockquoteGapMapping: extractBlockquoteGapMapping(zip),
    blockquotePreContentBlankLineMapping: extractBlockquotePreContentBlankLineMapping(zip),
    blockquotePostContentBlankLineMapping: extractBlockquotePostContentBlankLineMapping(zip),
    blockquoteAlertStyleMapping: extractBlockquoteAlertStyleMapping(zip),
    imageFormatMapping: extractImageFormatMapping(zip),
    noteImageFormatMapping: extractNoteImageFormatMapping(zip),
    tableFormatMapping: extractTableFormatMapping(zip),
    pipeTableAlignedMapping: extractPipeTableAlignedMapping(zip),
    gridSourceColWidthsMapping: extractGridSourceColWidthsMapping(zip),
    tableFontSizeMapping: extractTableFontSizeMapping(zip),
    tableFontMapping: extractTableFontMapping(zip),
    tableColWidthsMapping: extractTableColWidthsMapping(zip),
    tableDigitsMapping: extractTableDigitsMapping(zip),
    tableDecimalMarkMapping: extractTableDecimalMarkMapping(zip),
    tableDigitGroupingMapping: extractTableDigitGroupingMapping(zip),
    storedPipeTableMaxLineWidth: extractPipeTableMaxLineWidth(zip),
    storedGridTableMaxLineWidth: extractGridTableMaxLineWidth(zip),
    storedListIndent: extractListIndent(zip),
    consecutiveReplyParaIds: extractConsecutiveReplyParaIds(zip),
    storedFrontmatterBlankLines: extractFrontmatterBlankLines(zip),
    htmlCommentGapMapping: extractHtmlCommentGapMapping(zip),
    bibKeyOrder: extractBibKeyOrder(zip),
    storedBibData: extractBibData(zip),
    storedBibliographyPath: extractBibliographyPath(zip),
    landscapeTableMapping: extractLandscapeTableMapping(zip),
    portraitTableMapping: extractPortraitTableMapping(zip),
    portraitBreaks: extractPortraitBreakOrdinals(zip),
    explicitTableFontSize: extractExplicitTableFontSize(zip),
    storedFieldOrder: extractFrontmatterFieldOrder(zip),
    htmlCommentAfterGapMapping: extractHtmlCommentAfterGapMapping(zip),
    sentinelGapMapping: extractSentinelGapMapping(zip),
    defaultTableColWidths: extractDefaultTableColWidths(zip),
    storedCustomStyles: extractCustomStyles(zip),
    storedTableBorders: extractTableBorders(zip),
    storedLineSpacing: extractLineSpacing(zip),
    storedParagraphIndent: extractParagraphIndent(zip),
    storedBibHangingIndent: extractBibliographyHangingIndent(zip),
    storedCalloutLabels: extractCalloutLabels(zip),
    storedIndentOverrides: extractIndentOverrides(zip),
    storedListIndentOverrides: extractListIndentOverrides(zip),
    embedDirectiveMapping: extractEmbedDirectiveMapping(zip),
    defaultTableDigits: extractDefaultTableDigits(zip),
    defaultTableDecimalMark: extractDefaultTableDecimalMark(zip),
    defaultTableDigitGrouping: extractDefaultTableDigitGrouping(zip),
  });

  // Resolve pipeTableMaxLineWidth: explicit override > stored DOCX value > caller default > 120
  // Each tier is validated so NaN / negative / non-integer values are treated as "no value".
  const validWidth = (v: number | null | undefined): number | undefined =>
    v != null && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : undefined;
  const resolvedPipeTableMaxLineWidth = validWidth(options?.pipeTableMaxLineWidth)
    ?? validWidth(storedPipeTableMaxLineWidth)
    ?? validWidth(options?.pipeTableMaxLineWidthDefault)
    ?? 120;

  const resolvedGridTableMaxLineWidth = validWidth(options?.gridTableMaxLineWidth)
    ?? validWidth(storedGridTableMaxLineWidth)
    ?? validWidth(options?.gridTableMaxLineWidthDefault)
    ?? 120;

  // Group reply comments under their parents and get IDs to exclude from ranges
  const replyIds = groupCommentThreads(comments, threads);

  // Mark parent comments whose replies were originally in consecutive format
  if (consecutiveReplyParaIds && consecutiveReplyParaIds.size > 0) {
    for (const comment of comments.values()) {
      if (comment.paraId && consecutiveReplyParaIds.has(comment.paraId) && comment.replies && comment.replies.length > 0) {
        comment.consecutiveReplies = true;
      }
    }
  }

  const keyMap = buildCitationKeyMap(zoteroCitations, format);

  // Parse note-specific rels and numbering for footnote/endnote body parsing
  const [numberingResult, docRelsParsed, fnRels, enRels] = await Promise.all([
    parseNumberingDefinitions(zip),
    parseDocumentRelationships(zip),
    parseRelationships(zip, 'word/_rels/footnotes.xml.rels'),
    parseRelationships(zip, 'word/_rels/endnotes.xml.rels'),
  ]);
  const numberingDefs = numberingResult.defs;
  const numberingStartOverrides = numberingResult.startOverrides;
  const docRels = docRelsParsed.hyperlinks;
  const imageRels = docRelsParsed.images;

  // Build note contexts with merged rels (note rels + document rels as fallback)
  const fnRelsMerged = new Map([...docRels, ...fnRels]);
  const enRelsMerged = new Map([...docRels, ...enRels]);
  const fnContext: NoteBodyContext = { relationshipMap: fnRelsMerged, zoteroCitations, keyMap, numberingDefs, numberingStartOverrides, format };
  const enContext: NoteBodyContext = { relationshipMap: enRelsMerged, zoteroCitations, keyMap, numberingDefs, numberingStartOverrides, format };

  const [{ content: docContent, zoteroBiblData, imageEntries }, footnotes, endnotes] = await Promise.all([
    extractDocumentContent(zip, zoteroCitations, keyMap, { numberingDefs, numberingStartOverrides, relationshipMap: docRels, replyIds, imageRelationships: imageRels, imageFolder: options?.imageFolder, portraitBreakOrdinals: portraitBreaks ?? undefined, customStyles: storedCustomStyles ?? undefined, footnoteCrossRefMap: footnoteCrossRefMapping ?? undefined }),
    extractFootnotes(zip, fnContext),
    extractEndnotes(zip, enContext),
  ]);

  const {
    derivedBlockquoteGaps,
    derivedBlockquotePreContentBlankLines,
    derivedBlockquotePostContentBlankLines,
  } = annotateStructuralParagraphMetadata(docContent);
  // Spacer markers have served their sole purpose as grouping boundaries; remove
  // them before all later structural scans and Markdown rendering.
  for (let i = docContent.length - 1; i >= 0; i--) {
    const item = docContent[i];
    if (item.type === 'para' && item.isBlockquoteSpacer) docContent.splice(i, 1);
  }

  // Post-process: apply per-paragraph indent overrides from custom properties.
  // Uses the same body-paragraph counting as md-to-docx generation: count
  // non-heading, non-title, non-code, non-list, non-blockquote para items that
  // have inline content following them (i.e. not empty separator paragraphs).
  if (storedIndentOverrides) {
    let bodyIdx = 0;
    for (let ci = 0; ci < docContent.length; ci++) {
      const item = docContent[ci];
      if (item.type !== 'para' || item.headingLevel || item.isTitle || item.isCodeBlock
          || item.listMeta || item.blockquoteLevel) continue;
      // Skip empty separator paragraphs (no inline content follows before next structural item)
      if (isPlainEmptyParagraph(item)) continue;
      // Check if this para has any non-html_comment inline content after it
      let hasNonCommentContent = false;
      for (let j = ci + 1; j < docContent.length; j++) {
        if (isStructuralBoundaryItem(docContent[j])) break;
        if (docContent[j].type !== 'html_comment') { hasNonCommentContent = true; break; }
      }
      if (!hasNonCommentContent) { continue; }
      const override = storedIndentOverrides.get(bodyIdx);
      if (override) item.indentOverride = override as 'indent' | 'no-indent';
      bodyIdx++;
    }
  }

  // Post-process: apply per-list-block indent overrides from custom properties.
  // A list block is a maximal sequence of consecutive 'para' items with listMeta.
  if (storedListIndentOverrides) {
    let listBlockIdx = 0;
    let inList = false;
    for (const item of docContent) {
      if (item.type === 'para' && item.listMeta) {
        if (!inList) {
          // Start of a new list block
          const override = storedListIndentOverrides.get(listBlockIdx);
          if (override) item.indentOverride = override as 'indent' | 'no-indent';
          inList = true;
          listBlockIdx++;
        }
        // Propagate the override from the first list item to all items in this block
        if (item.indentOverride === undefined) {
          // Look back to find the override from the first item of this block
          // (already set above for the first item)
        }
      } else if ((item.type === 'para' && !item.listContinuation) || item.type === 'table'
          || isStructuralBoundaryItem(item)) {
        inList = false;
      }
    }
    // Second pass: propagate override to all items in each list block
    inList = false;
    let currentOverride: 'indent' | 'no-indent' | undefined;
    for (const item of docContent) {
      if (item.type === 'para' && item.listMeta) {
        if (!inList) {
          currentOverride = item.indentOverride;
          inList = true;
        } else if (currentOverride) {
          item.indentOverride = currentOverride;
        }
      } else if ((item.type === 'para' && !item.listContinuation) || item.type === 'table'
          || isStructuralBoundaryItem(item)) {
        inList = false;
        currentOverride = undefined;
      }
    }
  }

  // Post-process: inject custom_style_open/custom_style_close sentinels around
  // runs of paragraphs that share a customStyleName.
  {
    let activeStyle: string | undefined;
    for (let i = 0; i < docContent.length; i++) {
      const item = docContent[i];
      // Only structural items (para, table, landscape/portrait sentinels,
      // bibliography_marker) should trigger style transitions. Inline items
      // (text, image, math, hardbreak, etc.) live inside a para and don't
      // carry customStyleName — skip them to avoid premature style close.
      const isStructural = item.type === 'para' || item.type === 'table'
        || item.type === 'landscape_open' || item.type === 'landscape_close'
        || item.type === 'portrait_open' || item.type === 'portrait_close'
        || item.type === 'bibliography_marker';
      if (!isStructural) continue;
      const styleName = (item.type === 'para' && item.customStyleName) ? item.customStyleName : undefined;
      if (styleName && styleName !== activeStyle) {
        // Close previous style if open
        if (activeStyle) {
          docContent.splice(i, 0, { type: 'custom_style_close' });
          i++; // skip past the close we just inserted
        }
        // Open new style
        docContent.splice(i, 0, { type: 'custom_style_open', styleName });
        i++; // skip past the open we just inserted
        activeStyle = styleName;
      } else if (!styleName && activeStyle) {
        // Style run ended
        docContent.splice(i, 0, { type: 'custom_style_close' });
        i++; // skip past the close we just inserted
        activeStyle = undefined;
      }
    }
    // Close any still-open style at end of document
    if (activeStyle) {
      docContent.push({ type: 'custom_style_close' });
    }
  }

  // Build unified notes map with renumbered labels
  const notesMap = new Map<string, { label: string; body: ContentItem[]; noteKind: 'footnote' | 'endnote' }>();
  let noteCounter = 1;
  // Collect all footnote_ref items to assign labels in document order
  const refOrder: { noteId: string; noteKind: 'footnote' | 'endnote' }[] = [];
  function collectRefs(items: ContentItem[]) {
    for (const item of items) {
      if (item.type === 'footnote_ref') {
        refOrder.push({ noteId: item.noteId, noteKind: item.noteKind });
      } else if (item.type === 'table') {
        // Recursively collect refs from table cells
        for (const row of item.rows) {
          for (const cell of row.cells) {
            for (const para of cell.paragraphs) {
              collectRefs(para);
            }
          }
        }
      }
    }
  }
  collectRefs(docContent);

  const assignedLabels = new Map<string, string>(); // "kind:noteId" -> label
  const usedLabels = new Set<string>();
  for (const ref of refOrder) {
    const key = ref.noteKind + ':' + ref.noteId;
    if (assignedLabels.has(key)) continue;
    const source = ref.noteKind === 'footnote' ? footnotes : endnotes;
    const body = source.get(ref.noteId);
    if (!body) continue;
    const mappedLabel = footnoteIdMapping?.get(ref.noteId);
    let label: string;
    if (mappedLabel) {
      if (usedLabels.has(mappedLabel)) {
        while (usedLabels.has(String(noteCounter))) noteCounter++;
        label = String(noteCounter++);
      } else {
        label = mappedLabel;
      }
    } else {
      while (usedLabels.has(String(noteCounter))) noteCounter++;
      label = String(noteCounter++);
    }
    usedLabels.add(label);
    assignedLabels.set(key, label);
    notesMap.set(key, { label, body: body.content, noteKind: ref.noteKind });
  }

  // Detect which note kind is used for the frontmatter notes field.
  // Default (undefined) means footnotes. Only set 'endnotes' when endnotes are
  // present and footnotes are not — mixed documents omit the notes field.
  let detectedNotesMode: NotesMode | undefined;
  if (endnotes.size > 0 && footnotes.size === 0) {
    detectedNotesMode = 'endnotes';
  }

  // Extract consecutive Title-styled paragraphs from the beginning of the document
  const titleLines = extractTitleLines(docContent);

  let markdown = buildMarkdown(docContent, comments, {
    tableIndent: options?.tableIndent,
    alwaysUseCommentIds: options?.alwaysUseCommentIds,
    pipeTableMaxLineWidth: resolvedPipeTableMaxLineWidth,
    gridTableMaxLineWidth: resolvedGridTableMaxLineWidth,
    commentIdMapping,
    notes: notesMap.size > 0 ? { map: notesMap, assignedLabels } : undefined,
    codeBlockLangs: codeBlockLangMapping,
    blockquoteGaps: blockquoteGapMapping ?? derivedBlockquoteGaps,
    blockquotePreContentBlankLines: blockquotePreContentBlankLineMapping ?? derivedBlockquotePreContentBlankLines,
    blockquotePostContentBlankLines: blockquotePostContentBlankLineMapping ?? derivedBlockquotePostContentBlankLines,
    blockquoteAlertInlineByGroup: blockquoteAlertStyleMapping,
    calloutLabels: storedCalloutLabels,
    imageFormatMapping,
    noteImageFormatMapping,
    tableFormatMapping,
    pipeTableAlignedMapping,
    gridSourceColWidthsMapping,
    tableFontSizeMapping,
    tableFontMapping,
    tableColWidthsMapping,
    tableDigitsMapping,
    tableDecimalMarkMapping,
    tableDigitGroupingMapping,
    landscapeTableIndices: landscapeTableMapping,
    portraitTableIndices: portraitTableMapping,
    embedDirectiveMapping,
    listIndent: storedListIndent ?? 'spaces',
    htmlCommentGaps: htmlCommentGapMapping,
    htmlCommentAfterGaps: htmlCommentAfterGapMapping,
    sentinelGaps: sentinelGapMapping,
  });

  // Strip Sources section if present (fallback for docs without ZOTERO_BIBL field codes)
  if (!zoteroBiblData) {
    const lines = markdown.split('\n');
    const sourcesIdx = lines.findIndex(l => SOURCES_HEADING_RE.test(l.trim()));
    if (sourcesIdx >= 0) {
      markdown = lines.slice(0, sourcesIdx).join('\n');
    }
  }

  // Strip trailing <!-- references --> marker when bibliography is at the end of the
  // document (default position) so we don't inject a marker that wasn't in the original.
  markdown = markdown.replace(/\n*<!--\s*references\s*-->\s*$/, '');

  // Prepend YAML frontmatter if title or Zotero prefs were found
  const fm: Frontmatter = {};
  if (titleLines.length > 0) {
    fm.title = titleLines;
  }
  if (author) {
    fm.author = author;
  }
  if (zoteroPrefs) {
    fm.csl = zoteroStyleShortName(zoteroPrefs.styleId);
    // Only emit locale when it differs from the default (en-US)
    if (zoteroPrefs.locale && zoteroPrefs.locale !== 'en-US') {
      fm.locale = zoteroPrefs.locale;
    }
    fm.zoteroNotes = zoteroPrefs.noteType !== undefined ? noteTypeFromNumber(zoteroPrefs.noteType) : undefined;
  }
  if (detectedNotesMode === 'endnotes') {
    fm.notes = 'endnotes';
  }
  if (storedBibliographyPath) {
    fm.bibliography = storedBibliographyPath;
  } else if (options?.preferredBibliographyPath) {
    fm.bibliography = options.preferredBibliographyPath;
  }
  // Note: timezone is intentionally omitted from frontmatter to avoid injecting
  // fields that weren't in the original. Dates without explicit offsets are
  // interpreted in the system timezone by normalizeToUtcIso, which is correct.
  // Extract heading/title font overrides from styles.xml for round-trip
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const stylesStr = await stylesFile.async('string');
    const fontFields = extractFontOverridesFromStyles(stylesStr, { explicitTableFontSize });
    Object.assign(fm, fontFields);
  }
  // Restore custom styles from custom property (primary source)
  if (storedCustomStyles) {
    fm.styles = storedCustomStyles;
  }
  if (codeBlockStyling) {
    const bg = codeBlockStyling.get('bg');
    if (bg) fm.codeBackgroundColor = bg;
    const fc = codeBlockStyling.get('fc');
    if (fc) fm.codeFontColor = fc;
    const insetStr = codeBlockStyling.get('inset');
    if (insetStr) { const n = parseInt(insetStr, 10); if (n > 0) fm.codeBlockInset = n; }
  }
  // Emit pipe-table-max-line-width when the resolved value differs from the
  // default, OR when the DOCX explicitly stored a value (even if it equals 120)
  // so that an intentional `pipe-table-max-line-width: 120` survives round-trip.
  if (resolvedPipeTableMaxLineWidth !== 120 || storedPipeTableMaxLineWidth != null || validWidth(options?.pipeTableMaxLineWidth) != null) {
    fm.pipeTableMaxLineWidth = resolvedPipeTableMaxLineWidth;
  }
  if (resolvedGridTableMaxLineWidth !== 120 || storedGridTableMaxLineWidth != null || validWidth(options?.gridTableMaxLineWidth) != null) {
    fm.gridTableMaxLineWidth = resolvedGridTableMaxLineWidth;
  }
  // Reconstruct table-col-widths from stored default custom property
  if (defaultTableColWidths) {
    const parsed = parseColWidths(defaultTableColWidths);
    if (parsed) fm.tableColWidths = parsed;
  }
  if (defaultTableDigits) {
    const parsed = parseTableDigits(defaultTableDigits);
    if (parsed !== undefined) fm.tableDigits = parsed;
  }
  if (defaultTableDecimalMark) {
    const parsed = parseTableDecimalMark(defaultTableDecimalMark);
    if (parsed) fm.tableDecimalMark = parsed;
  }
  if (defaultTableDigitGrouping) {
    const parsed = parseTableDigitGrouping(defaultTableDigitGrouping);
    if (parsed) fm.tableDigitGrouping = parsed;
  }
  // Reconstruct table-borders from stored custom property
  if (storedTableBorders) {
    fm.tableBorders = storedTableBorders;
  }
  // Reconstruct line-spacing, paragraph-indent, bibliography-hanging-indent.
  // Normalize to lowercase before comparing so values like 'Double' or 'NONE'
  // stored in docProps/custom.xml survive the round-trip (frontmatter.ts already
  // lowercases on the write path, but external tools might uppercase).
  if (storedLineSpacing) {
    const ls = storedLineSpacing.toLowerCase();
    const n = parseFloat(ls);
    if (ls === 'single' || ls === '1.5' || ls === 'double') {
      fm.lineSpacing = ls as 'single' | '1.5' | 'double';
    } else if (isFinite(n) && n > 0) {
      fm.lineSpacing = n;
    }
  }
  if (storedParagraphIndent) {
    const pi = storedParagraphIndent.toLowerCase();
    if (pi === 'none') {
      fm.paragraphIndent = 'none';
    } else {
      const n = parseFloat(pi);
      if (isFinite(n) && n >= 0) fm.paragraphIndent = n;
    }
  }
  if (storedBibHangingIndent) {
    const bhi = storedBibHangingIndent.toLowerCase();
    if (bhi === 'true') fm.bibliographyHangingIndent = true;
    else if (bhi === 'false') fm.bibliographyHangingIndent = false;
  }
  if (storedCalloutLabels !== null) {
    fm.calloutLabels = storedCalloutLabels;
  }
  const frontmatterStr = serializeFrontmatter(fm, storedFieldOrder ?? undefined);
  if (frontmatterStr) {
    // Restore the original number of blank lines after frontmatter.
    // Default to 1 blank line (conventional) when no stored value exists.
    const blankLines = storedFrontmatterBlankLines ?? 1;
    markdown = frontmatterStr + '\n'.repeat(blankLines) + markdown;
  }

  // Layered .bib restoration:
  // Layer 1: full .bib stored in custom properties (survives Word editing)
  // Layer 2: key order in custom properties — regenerate with original order
  // Layer 3: regenerate from Zotero citations (backward compatible)
  let bibtex: string;
  if (storedBibData) {
    // Layer 1: stored .bib is authoritative — preserve verbatim.
    // Only append genuinely new Zotero entries (citations added in Word).
    const storedKeys = new Set(parseBibtex(storedBibData).keys());
    const generated = generateBibTeX(zoteroCitations, keyMap);
    // Let the parser delimit the entries.  Splitting on blank lines would cut
    // an entry in half the moment a field value contains one — `abstract` and
    // `note` come through from Zotero verbatim and routinely do — and the
    // half without the header would then be dropped as keyless, appending
    // truncated BibTeX to the file.
    const newEntries = parseBibtexWithRaw(generated)
      .ranges.filter(range => !storedKeys.has(range.key))
      .map(range => generated.slice(range.start, range.end));
    bibtex = newEntries.length > 0
      ? storedBibData.trimEnd() + '\n\n' + newEntries.join('\n\n')
      : storedBibData;
  } else if (bibKeyOrder) {
    // Layer 2: regenerate but sort to match original key order
    bibtex = generateBibTeX(zoteroCitations, keyMap, bibKeyOrder);
  } else {
    // Layer 3: backward compatible — generate from Zotero citations
    bibtex = generateBibTeX(zoteroCitations, keyMap);
  }

  // Post-processing: merge with on-disk .bib — preserves all existing entries/fields.
  // Length check is a fast-path skip; mergeBibtex handles whitespace-only gracefully.
  if (options?.existingBibtex && options.existingBibtex.length > 0) {
    bibtex = mergeBibtex(options.existingBibtex, bibtex);
  }

  // Extract image binaries from the ZIP
  let images: Map<string, Uint8Array> | undefined;
  if (imageEntries && imageEntries.length > 0) {
    images = new Map();
    for (const entry of imageEntries) {
      const rawPath = entry.mediaPath.startsWith('word/') ? entry.mediaPath : 'word/' + entry.mediaPath;
      // Normalize ../ segments (e.g. "word/../media/image1.png" -> "media/image1.png")
      const pathParts = rawPath.split('/');
      const resolved: string[] = [];
      for (const p of pathParts) {
        if (p === '..') resolved.pop();
        else if (p !== '.') resolved.push(p);
      }
      const mediaPath = resolved.join('/');
      const file = zip.file(mediaPath);
      if (file) {
        images.set(entry.outputFilename, await file.async('uint8array'));
      }
    }
    if (images.size === 0) images = undefined;
  }

  // Ensure the output ends with exactly one newline (POSIX convention)
  markdown = markdown.replace(/\n*$/, '\n');

  return { markdown, bibtex, zoteroPrefs, zoteroBiblData, images };
}
