import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ommlToLatex } from './omml';
import { Frontmatter, NotesMode, serializeFrontmatter, noteTypeFromNumber } from './frontmatter';

/** Matches a "Sources" heading (with or without leading `#` markers). */
const SOURCES_HEADING_RE = /^(?:#+\s*)?Sources\s*$/;

// Types

export interface Comment {
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
  fullItemData: Record<string, any>;
  zoteroKey?: string;
  zoteroUri?: string;
  locator?: string;
  citationKey?: string;   // CSL citation-key preserved for round-trip
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
}

/** List metadata for a paragraph */
export interface ListMeta {
  type: 'bullet' | 'ordered';
  level: number; // 0-based indentation level
}

export const DEFAULT_FORMATTING: Readonly<RunFormatting> = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  highlight: false,
  superscript: false,
  subscript: false,
});

export type ContentItem =
  | {
      type: 'text';
      text: string;
      commentIds: Set<string>;
      formatting: RunFormatting;
      href?: string;           // hyperlink URL if inside w:hyperlink
    }
  | { type: 'citation'; text: string; commentIds: Set<string>; pandocKeys: string[] }
  | { type: 'table'; rows: TableRow[] }
  | {
      type: 'para';
      headingLevel?: number;   // 1–6 if heading, undefined otherwise
      listMeta?: ListMeta;     // present if list item
      isTitle?: boolean;       // true if Word "Title" paragraph style
    }
  | { type: 'math'; latex: string; display: boolean; commentIds: Set<string> }
  | { type: 'footnote_ref'; noteId: string; noteKind: 'footnote' | 'endnote'; commentIds: Set<string> };
export interface FootnoteBody {
  id: string;
  content: ContentItem[];
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
  uncited?: any[];
  omitted?: any[];
  custom?: any[];
}

export interface ConvertResult {
  markdown: string;
  bibtex: string;
  zoteroPrefs?: ZoteroDocPrefs;
  zoteroBiblData?: ZoteroBiblData;
}

// XML helpers

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
};

export async function parseRelationships(zip: JSZip): Promise<Map<string, string>> {
  const relationships = new Map<string, string>();
  const parsed = await readZipXml(zip, 'word/_rels/document.xml.rels');
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

export async function parseNumberingDefinitions(zip: JSZip): Promise<Map<string, Map<string, 'bullet' | 'ordered'>>> {
  const numberingDefs = new Map<string, Map<string, 'bullet' | 'ordered'>>();
  const parsed = await readZipXml(zip, 'word/numbering.xml');
  if (!parsed) { return numberingDefs; }

  // Build abstractNumId → levels map
  const abstractNums = new Map<string, Map<string, 'bullet' | 'ordered'>>();
  for (const node of findAllDeep(parsed, 'w:abstractNum')) {
    const abstractNum = node['w:abstractNum'];
    if (!abstractNum) continue;
    
    const abstractNumId = getAttr(node, 'abstractNumId');
    const levels = new Map<string, 'bullet' | 'ordered'>();
    
    for (const lvlNode of findAllDeep(abstractNum, 'w:lvl')) {
      const lvl = lvlNode['w:lvl'];
      if (!lvl) continue;
      
      const ilvl = getAttr(lvlNode, 'ilvl');
      const numFmtNodes = findAllDeep(lvl, 'w:numFmt');
      if (numFmtNodes.length > 0) {
        const val = getAttr(numFmtNodes[0], 'val');
        levels.set(ilvl, val === 'bullet' ? 'bullet' : 'ordered');
      }
    }
    
    abstractNums.set(abstractNumId, levels);
  }

  // Resolve numId → abstractNumId
  for (const node of findAllDeep(parsed, 'w:num')) {
    const num = node['w:num'];
    if (!num) continue;
    
    const numId = getAttr(node, 'numId');
    const abstractNumIdNodes = findAllDeep(num, 'w:abstractNumId');
    if (abstractNumIdNodes.length > 0) {
      const abstractNumId = getAttr(abstractNumIdNodes[0], 'val');
      const levels = abstractNums.get(abstractNumId);
      if (levels) {
        numberingDefs.set(numId, levels);
      }
    }
  }
  
  return numberingDefs;
}

export function parseHeadingLevel(pPrChildren: any[]): number | undefined {
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

export function parseTitleStyle(pPrChildren: any[]): boolean {
  const pStyleElement = pPrChildren.find(child => child['w:pStyle'] !== undefined);
  if (!pStyleElement) return false;
  return getAttr(pStyleElement, 'val').toLowerCase() === 'title';
}

export function parseListMeta(pPrChildren: any[], numberingDefs: Map<string, Map<string, 'bullet' | 'ordered'>>): ListMeta | undefined {
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
  
  const type = levels.get(ilvl);
  if (!type) return undefined;
  
  const level = parseInt(ilvl, 10);
  if (isNaN(level) || level < 0) return undefined;

  return {
    type,
    level
  };
}

async function loadZip(data: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

async function readZipXml(zip: JSZip, path: string): Promise<any[] | null> {
  const file = zip.file(path);
  if (!file) { return null; }
  const xml = await file.async('string');
  return new XMLParser(parserOptions).parse(xml);
}

function findAllDeep(nodes: any[], tagName: string, depth = 0, maxDepth = 50): any[] {
  if (depth >= maxDepth) { return []; }
  const results: any[] = [];
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

function getAttr(node: any, attr: string): string {
  return node?.[':@']?.[`@_w:${attr}`] ?? node?.[':@']?.[`@_${attr}`] ?? '';
}

/** Extract text from a node's children (handles #text in preserveOrder mode) */
function nodeText(children: any[]): string {
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
function extractFieldInstructions(nodes: any[]): string[] {
  const results: string[] = [];
  let accumulating = false;
  let buffer = '';

  function walk(items: any[]): void {
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
          buffer += nodeText(node['w:instrText'] || []);
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
export function isToggleOn(children: any[], tagName: string): boolean {
  const element = children.find(child => child[tagName] !== undefined);
  if (!element) return false;
  
  const val = getAttr(element, 'val');
  if (!val) return true; // present with no w:val attribute → true
  return val === 'true' || val === '1' || val === 'on';
}

/** Parse run properties and return RunFormatting */
export function parseRunProperties(
  rPrChildren: any[],
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
  
  return formatting;
}

/** Apply formatting delimiters in nesting order */
export function wrapWithFormatting(text: string, fmt: RunFormatting): string {
  let result = text;
  
  // Apply in reverse nesting order (innermost to outermost)
  // If both superscript and subscript are true, superscript takes precedence
  if (fmt.superscript) {
    result = `<sup>${result}</sup>`;
  } else if (fmt.subscript) {
    result = `<sub>${result}</sub>`;
  }
  if (fmt.highlight) result = `==${result}==`;
  if (fmt.underline) result = `<u>${result}</u>`;
  if (fmt.strikethrough) result = `~~${result}~~`;
  if (fmt.italic) result = `*${result}*`;
  if (fmt.bold) result = `**${result}**`;
  
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
    const author = getAttr(node, 'author') || 'Unknown';
    const date = getAttr(node, 'date') || '';
    // Collect all w:t text within this comment
    const tNodes = findAllDeep(node['w:comment'] || [], 'w:t');
    const text = tNodes.map(t => nodeText(t['w:t'] || [])).join('');
    comments.set(id, { author, text, date });
  }
  return comments;
}

/** Matches the 8-character Zotero item key at the end of a URI. */
export const ZOTERO_KEY_RE = /\/items\/([A-Z0-9]{8})$/;

// Zotero document preferences extraction

const ZOTERO_STYLE_PREFIX = 'http://www.zotero.org/styles/';

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
        const val = nodeText(child['vt:lpwstr'] || []);
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

async function extractIdMappingFromCustomXml(
  data: Uint8Array | JSZip,
  propPrefix: string,
): Promise<Map<string, string> | null> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'docProps/custom.xml');
  if (!parsed) return null;

  const parts: Array<{ index: number; value: string }> = [];
  const propertyNodes = findAllDeep(parsed, 'property');
  for (const propNode of propertyNodes) {
    const name: string = propNode?.[':@']?.['@_name'] ?? getAttr(propNode, 'name');
    if (!name.startsWith(propPrefix)) continue;

    let idx = 1;
    if (name !== propPrefix) {
      if (!name.startsWith(propPrefix + '_')) continue;
      const chunkMatch = name.slice(propPrefix.length + 1).match(/^(\d+)$/);
      if (!chunkMatch) continue;
      idx = parseInt(chunkMatch[1], 10);
      if (isNaN(idx)) continue;
    }

    const children = propNode['property'];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child['vt:lpwstr'] !== undefined) {
        const val = nodeText(child['vt:lpwstr'] || []);
        parts.push({ index: idx, value: val });
      }
    }
  }

  if (parts.length === 0) return null;

  parts.sort((a, b) => a.index - b.index);
  const mappingJson = parts.map(p => p.value).join('');
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

async function extractNotes(
  zip: JSZip,
  xmlPath: string,
  tagName: string,
): Promise<Map<string, FootnoteBody>> {
  const notes = new Map<string, FootnoteBody>();
  const parsed = await readZipXml(zip, xmlPath);
  if (!parsed) return notes;

  for (const node of findAllDeep(parsed, tagName)) {
    const id = getAttr(node, 'id');
    if (!id || id === '-1' || id === '0') continue;

    // Skip separator and continuationSeparator types
    const noteType = getAttr(node, 'type');
    if (noteType === 'separator' || noteType === 'continuationSeparator') continue;

    const noteChildren = node[tagName];
    if (!Array.isArray(noteChildren)) continue;

    const content = parseNoteBody(noteChildren, tagName);
    notes.set(id, { id, content });
  }
  return notes;
}

/**
 * Parse footnote/endnote body content from OOXML.
 * 
 * V1 limitations: Only handles basic text formatting (w:t, w:br, w:p, w:r).
 * Silently drops:
 * - w:hyperlink (requires relationshipMap for href resolution)
 * - m:oMath/m:oMathPara (requires ommlToLatex for math conversion)
 * - w:fldChar (requires field state tracking)
 * - w:tbl (requires table/cell parsing functions)
 * 
 * Full support would require refactoring to accept additional context parameters.
 */
function parseNoteBody(noteChildren: any[], tagName: string): ContentItem[] {
  const content: ContentItem[] = [];
  // Determine self-ref tag: w:footnoteRef or w:endnoteRef
  const selfRefTag = tagName === 'w:footnote' ? 'w:footnoteRef' : 'w:endnoteRef';
  let skippedSelfRef = false;

  function walkNoteBody(nodes: any[], currentFormatting: RunFormatting = DEFAULT_FORMATTING): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') continue;

        if (key === selfRefTag && !skippedSelfRef) {
          skippedSelfRef = true;
          continue;
        }

        if (key === 'w:t') {
          const text = nodeText(node['w:t'] || []);
          if (text) {
            content.push({
              type: 'text',
              text,
              commentIds: new Set(),
              formatting: currentFormatting,
            });
          }
        } else if (key === 'w:br') {
          const brType = getAttr(node, 'type');
          if (!brType || brType === 'textWrapping') {
            content.push({
              type: 'text',
              text: '\n',
              commentIds: new Set(),
              formatting: currentFormatting,
            });
          }
        } else if (key === 'w:p') {
          const paraChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          let paraFormatting = currentFormatting;
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = Array.isArray(child['w:pPr']) ? child['w:pPr'] : [child['w:pPr']];
              const pRPrElement = pPrChildren.find((c: any) => c['w:rPr'] !== undefined);
              if (pRPrElement) {
                const pRPrChildren = Array.isArray(pRPrElement['w:rPr']) ? pRPrElement['w:rPr'] : [pRPrElement['w:rPr']];
                paraFormatting = parseRunProperties(pRPrChildren, currentFormatting);
              }
              break;
            }
          }
          // Push para separator for multi-paragraph notes (skip first)
          if (content.length > 0) {
            content.push({ type: 'para' });
          }
          walkNoteBody(paraChildren, paraFormatting);
        } else if (key === 'w:r') {
          let runFormatting = currentFormatting;
          const runChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const child of runChildren) {
            if (child['w:rPr']) {
              const rPrChildren = Array.isArray(child['w:rPr']) ? child['w:rPr'] : [child['w:rPr']];
              runFormatting = parseRunProperties(rPrChildren, currentFormatting);
              break;
            }
          }
          walkNoteBody(runChildren, runFormatting);
        } else if (Array.isArray(node[key])) {
          walkNoteBody(node[key], currentFormatting);
        }
      }
    }
  }

  walkNoteBody(noteChildren);
  return content;
}

async function extractFootnotes(zip: JSZip): Promise<Map<string, FootnoteBody>> {
  return extractNotes(zip, 'word/footnotes.xml', 'w:footnote');
}

async function extractEndnotes(zip: JSZip): Promise<Map<string, FootnoteBody>> {
  return extractNotes(zip, 'word/endnotes.xml', 'w:endnote');
}

/** Strip the Zotero styles URL prefix to get a short style name. */
export function zoteroStyleShortName(styleId: string): string {
  if (styleId.startsWith(ZOTERO_STYLE_PREFIX)) {
    return styleId.slice(ZOTERO_STYLE_PREFIX.length);
  }
  return styleId;
}

/** Build the full Zotero style URL from a short name. */
export function zoteroStyleFullId(shortName: string): string {
  if (shortName.startsWith('http://') || shortName.startsWith('https://')) {
    return shortName;
  }
  return ZOTERO_STYLE_PREFIX + shortName;
}

// Zotero metadata extraction

export async function extractZoteroCitations(data: Uint8Array | JSZip): Promise<ZoteroCitation[]> {
  const citations: ZoteroCitation[] = [];
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/document.xml');
  if (!parsed) { return citations; }

  for (const instrText of extractFieldInstructions(parsed)) {
    if (!instrText.includes('ZOTERO_ITEM')) { continue; }

    const jsonStart = instrText.indexOf('{');
    if (jsonStart < 0) {
      citations.push({ plainCitation: '', items: [] });
      continue;
    }

    try {
      const cslData = JSON.parse(instrText.slice(jsonStart));
      const plainCitation: string = cslData?.properties?.plainCitation ?? '';
      const cslItems: any[] = cslData?.citationItems ?? [];

      const items: CitationMetadata[] = cslItems.map((item: any) => {
        const d = item.itemData ?? {};
        const issued = d.issued ?? {};
        const dateParts = issued['date-parts'] ?? [[]];
        const year = dateParts[0]?.[0] ? String(dateParts[0][0]) : '';
        
        const result: CitationMetadata = {
          authors: d.author ?? [],
          title: d.title ?? '',
          year,
          journal: d['container-title'] ?? '',
          volume: d.volume ?? '',
          pages: d.page ?? '',
          doi: d.DOI ?? '',
          type: d.type ?? 'article-journal',
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
        const uri = Array.isArray(uris) ? uris[0] : uris;
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
  format: CitationKeyFormat = 'authorYearTitle'
): Map<string, string> {
  const keyMap = new Map<string, string>(); // itemId -> citationKey
  const seen = new Set<string>();
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
  return meta.fullItemData.publisher || meta.journal || 'unknown';
}

/** Strip characters that are significant in Pandoc citation syntax. */
function sanitizeLocator(locator: string | number): string {
  return String(locator).replace(/[\[\];@]/g, '');
}

/** Get pandoc keys for a citation's items */
export function citationPandocKeys(
  citation: ZoteroCitation,
  keyMap: Map<string, string>
): string[] {
  return citation.items
    .map(meta => {
      const k = keyMap.get(itemIdentifier(meta));
      if (!k) return undefined;
      if (meta.locator) {
        const safe = sanitizeLocator(meta.locator);
        return safe ? k + ', p. ' + safe : k;
      }
      return k;
    })
    .filter((k): k is string => k !== undefined);
}

// Document content extraction

export interface DocumentContentResult {
  content: ContentItem[];
  zoteroBiblData?: ZoteroBiblData;
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

function tableHasFirstRowHeader(tblChildren: any[]): boolean {
  const tblPrNode = tblChildren.find((c: any) => c['w:tblPr'] !== undefined);
  if (!tblPrNode) return false;
  const tblPrChildren = Array.isArray(tblPrNode['w:tblPr']) ? tblPrNode['w:tblPr'] : [tblPrNode['w:tblPr']];
  const tblLookNode = tblPrChildren.find((c: any) => c['w:tblLook'] !== undefined);
  if (!tblLookNode) return false;
  const firstRow = getAttr(tblLookNode, 'firstRow');
  return firstRow === '1' || firstRow === 'true' || firstRow === 'on';
}

function rowHasHeaderProp(trChildren: any[]): boolean {
  const trPrNode = trChildren.find((c: any) => c['w:trPr'] !== undefined);
  if (!trPrNode) return false;
  const trPrChildren = Array.isArray(trPrNode['w:trPr']) ? trPrNode['w:trPr'] : [trPrNode['w:trPr']];
  const tblHeaderNode = trPrChildren.find((c: any) => c['w:tblHeader'] !== undefined);
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
  keyMap: Map<string, string>
): Promise<DocumentContentResult> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/document.xml');
  if (!parsed) { return { content: [] }; }

  // Parse relationships and numbering definitions
  const relationshipMap = await parseRelationships(zip);
  const numberingDefs = await parseNumberingDefinitions(zip);

  // Build a lookup: instrText index -> ZoteroCitation (in order of appearance)
  let citationIdx = 0;

  const content: ContentItem[] = [];
  const activeComments = new Set<string>();
  let inField = false;
  let inCitationField = false;
  let inBibliographyField = false;
  let fieldInstrParts: string[] = [];
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];
  let currentHref: string | undefined;
  let zoteroBiblData: ZoteroBiblData | undefined;

  function walk(
    nodes: any[],
    currentFormatting: RunFormatting = DEFAULT_FORMATTING,
    target: ContentItem[] = content,
    inTableCell = false
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
              }
            }
          } else if (fldType === 'end') {
            if (inCitationField && currentCitation) {
              const pandocKeys = citationPandocKeys(currentCitation, keyMap);
              target.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(activeComments),
                pandocKeys,
              });
            }
            inField = false;
            inCitationField = false;
            inBibliographyField = false;
            currentCitation = undefined;
          }
        } else if (key === 'w:instrText' && inField) {
          fieldInstrParts.push(nodeText(node['w:instrText'] || []));
        } else if (key === 'w:commentRangeStart') {
          activeComments.add(getAttr(node, 'id'));
        } else if (key === 'w:commentRangeEnd') {
          activeComments.delete(getAttr(node, 'id'));
        } else if (key === 'w:footnoteReference') {
          const noteId = getAttr(node, 'id');
          if (noteId && noteId !== '0' && noteId !== '-1') {
            target.push({ type: 'footnote_ref', noteId, noteKind: 'footnote', commentIds: new Set(activeComments) });
          }
        } else if (key === 'w:endnoteReference') {
          const noteId = getAttr(node, 'id');
          if (noteId && noteId !== '0' && noteId !== '-1') {
            target.push({ type: 'footnote_ref', noteId, noteKind: 'endnote', commentIds: new Set(activeComments) });
          }
        } else if (key === 'w:hyperlink') {
          const rId = node?.[':@']?.['@_r:id'] ?? getAttr(node, 'id');
          const prevHref = currentHref;
          currentHref = relationshipMap.get(rId);
          if (Array.isArray(node[key])) { walk(node[key], currentFormatting, target, inTableCell); }
          currentHref = prevHref;
        } else if (key === 'w:tbl' && !inTableCell) {
          const tblChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          const rawRows: Array<{ isHeader: boolean; cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> }> = [];
          const firstRowHeaderByLook = tableHasFirstRowHeader(tblChildren);
          for (const tr of tblChildren.filter((c: any) => c['w:tr'] !== undefined)) {
            const trChildren = Array.isArray(tr['w:tr']) ? tr['w:tr'] : [tr['w:tr']];
            const cells: Array<{ paragraphs: ContentItem[][]; colspan: number; vMergeType?: 'restart' | 'continue' }> = [];
            for (const tc of trChildren.filter((c: any) => c['w:tc'] !== undefined)) {
              const tcChildren = Array.isArray(tc['w:tc']) ? tc['w:tc'] : [tc['w:tc']];
              // Parse cell properties
              let colspan = 1;
              let vMergeType: 'restart' | 'continue' | undefined;
              const tcPrNode = tcChildren.find((c: any) => c['w:tcPr'] !== undefined);
              if (tcPrNode) {
                const tcPrChildren = Array.isArray(tcPrNode['w:tcPr']) ? tcPrNode['w:tcPr'] : [tcPrNode['w:tcPr']];
                const gridSpanNode = tcPrChildren.find((c: any) => c['w:gridSpan'] !== undefined);
                if (gridSpanNode) {
                  const val = parseInt(getAttr(gridSpanNode, 'val'), 10);
                  if (val > 1) colspan = val;
                }
                const vMergeNode = tcPrChildren.find((c: any) => c['w:vMerge'] !== undefined);
                if (vMergeNode) {
                  const val = getAttr(vMergeNode, 'val');
                  vMergeType = val === 'restart' ? 'restart' : 'continue';
                }
              }
              const cellItems: ContentItem[] = [];
              walk(tcChildren, currentFormatting, cellItems, true);
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
          const runChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const child of runChildren) {
            if (child['w:rPr']) {
              const rPrChildren = Array.isArray(child['w:rPr']) ? child['w:rPr'] : [child['w:rPr']];
              runFormatting = parseRunProperties(rPrChildren, currentFormatting);
              break;
            }
          }
          walk(runChildren, runFormatting, target, inTableCell);
        } else if (key === 'w:br') {
          // Line break within a run (Shift+Enter in Word).
          // Only emit for default/textWrapping breaks; skip page/column breaks.
          const brType = getAttr(node, 'type');
          if (!brType || brType === 'textWrapping') {
            if (!inBibliographyField && !inCitationField) {
              target.push({
                type: 'text',
                text: '\n',
                commentIds: new Set(activeComments),
                formatting: currentFormatting,
              });
            }
          }
        } else if (key === 'w:t') {
          const text = nodeText(node['w:t'] || []);
          if (text) {
            if (inBibliographyField) {
              // Skip text inside ZOTERO_BIBL field
            } else if (inCitationField) {
              citationTextParts.push(text);
            } else {
              const textItem: ContentItem = { 
                type: 'text', 
                text, 
                commentIds: new Set(activeComments),
                formatting: currentFormatting
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
          let paraFormatting = currentFormatting;

          const paraChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = Array.isArray(child['w:pPr']) ? child['w:pPr'] : [child['w:pPr']];
              headingLevel = parseHeadingLevel(pPrChildren);
              listMeta = parseListMeta(pPrChildren, numberingDefs);
              isTitle = parseTitleStyle(pPrChildren);
              const pRPrElement = pPrChildren.find(pprChild => pprChild['w:rPr'] !== undefined);
              if (pRPrElement) {
                const pRPrChildren = Array.isArray(pRPrElement['w:rPr']) ? pRPrElement['w:rPr'] : [pRPrElement['w:rPr']];
                paraFormatting = parseRunProperties(pRPrChildren, currentFormatting);
              }
              break;
            }
          }

          // Always push a new para when heading/list/title metadata is present (so metadata
          // isn't silently dropped after empty paragraphs).  For plain paragraphs,
          // push only when the previous item isn't already a para separator.
          const needsPara = inTableCell || (headingLevel || listMeta || isTitle)
            ? true
            : target.length > 0 && target[target.length - 1].type !== 'para';

          if (needsPara) {
            const paraItem: ContentItem = { type: 'para' };
            if (headingLevel) paraItem.headingLevel = headingLevel;
            if (listMeta) paraItem.listMeta = listMeta;
            if (isTitle) paraItem.isTitle = true;
            target.push(paraItem);
          }
          walk(paraChildren, paraFormatting, target, inTableCell);
        } else if (key === 'm:oMathPara') {
          // Display equation — extract m:oMath children from within
          const mathParaChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          const oMathNodes = mathParaChildren.filter((c: any) => c['m:oMath'] !== undefined);
          for (const oMathNode of oMathNodes) {
            try {
              const latex = ommlToLatex(oMathNode['m:oMath']);
              if (latex) {
                target.push({ type: 'math', latex, display: true, commentIds: new Set(activeComments) });
              }
            } catch {
              target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: true, commentIds: new Set(activeComments) });
            }
          }
        } else if (key === 'm:oMath') {
          // Inline equation
          const mathChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          try {
            const latex = ommlToLatex(mathChildren);
            if (latex) {
              target.push({ type: 'math', latex, display: false, commentIds: new Set(activeComments) });
            }
          } catch {
            target.push({ type: 'math', latex: '\\text{[EQUATION ERROR]}', display: false, commentIds: new Set(activeComments) });
          }
        } else if (Array.isArray(node[key])) {
          walk(node[key], currentFormatting, target, inTableCell);
        }
      }
    }
  }

  walk(Array.isArray(parsed) ? parsed : [parsed]);
  return { content, zoteroBiblData };
}

// Markdown generation

function formattingEquals(a: RunFormatting, b: RunFormatting): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
         a.strikethrough === b.strikethrough && a.highlight === b.highlight &&
         a.highlightColor === b.highlightColor &&
         a.superscript === b.superscript && a.subscript === b.subscript;
}

function commentSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
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
          !commentSetsEqual(item.commentIds, next.commentIds)) {
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
    });
    i = j;
  }

  return merged;
}

function renderInlineSegment(
  segment: ContentItem[],
  comments: Map<string, Comment>,
  renderOpts?: { alwaysUseCommentIds?: boolean; commentIdRemap?: Map<string, string>; forceIdCommentIds?: Set<string>; emittedIdCommentBodies?: Set<string>; noteLabels?: Map<string, string> }
): { text: string; deferredComments: string[] } {
  const result = renderInlineRange(segment, 0, comments, undefined, renderOpts);
  return {
    // Keep parity with paragraph-level emission behavior.
    text: result.text.replace(/\n+$/, ''),
    deferredComments: result.deferredComments,
  };
}

/** Check whether any position in the segment has more than one active comment. */
function hasOverlappingComments(segment: ContentItem[]): boolean {
  const allIds = new Set<string>();
  for (const item of segment) {
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math') && item.commentIds) {
      for (const id of item.commentIds) allIds.add(id);
    }
  }
  if (allIds.size <= 1) return false;

  // Two or more comment IDs exist — check if their ranges actually overlap
  // by seeing if any single run is covered by 2+ comments
  for (const item of segment) {
    if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math') && item.commentIds) {
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
    if (item.type !== 'text' && item.type !== 'citation' && item.type !== 'footnote_ref' && item.type !== 'math') { pos++; continue; }
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

function formatCommentBody(_cid: string, c: Comment): string {
  return `{>>${c.author}${formatDateSuffix(c.date)}: ${c.text}<<}`;
}

function formatCommentBodyWithId(cid: string, c: Comment): string {
  return `{#${cid}>>${c.author}${formatDateSuffix(c.date)}: ${c.text}<<}`;
}

function computeSegmentEnd(
  segment: ContentItem[],
  startIndex: number,
  opts?: { stopBeforeDisplayMath?: boolean }
): number {
  let idx = startIndex;
  while (idx < segment.length) {
    const item = segment[idx];
    if (item.type === 'para' || item.type === 'table') break;
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
  renderOpts?: { alwaysUseCommentIds?: boolean; commentIdRemap?: Map<string, string>; forceIdCommentIds?: Set<string>; emittedIdCommentBodies?: Set<string>; noteLabels?: Map<string, string> }
): { text: string; nextIndex: number; deferredComments: string[] } {
  let out = '';
  let i = startIndex;

  // Determine if we should use ID-based syntax for this inline segment only
  const segmentEnd = computeSegmentEnd(segment, startIndex, opts);
  const forceIdCommentIds = renderOpts?.forceIdCommentIds;
  const hasForcedIdCommentInSegment = !!forceIdCommentIds && [...segment.slice(startIndex, segmentEnd)].some(item => (
    (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math') &&
    item.commentIds && [...item.commentIds].some(id => forceIdCommentIds.has(id))
  ));
  const useIds = renderOpts?.alwaysUseCommentIds || hasForcedIdCommentInSegment || hasOverlappingComments(segment.slice(startIndex, segmentEnd));

  if (useIds) {
    return renderInlineRangeWithIds(segment, startIndex, comments, opts, renderOpts?.commentIdRemap, renderOpts?.emittedIdCommentBodies, renderOpts?.noteLabels);
  }

  while (i < segment.length) {
    const item = segment[i];
    if (i >= segmentEnd) break;

    if (item.type === 'citation') {
      if (item.pandocKeys.length > 0) {
        out += ' [' + item.pandocKeys.map(k => '@' + k).join('; ') + ']';
      } else {
        out += item.text;
      }
      i++;
      continue;
    }

    if (item.type === 'math') {
      out += item.display ? '$$' + '\n' + item.latex + '\n' + '$$' : '$' + item.latex + '$';
      i++;
      continue;
    }

    if (item.type === 'footnote_ref') {
      const noteKey = item.noteKind + ':' + item.noteId;
      const label = renderOpts?.noteLabels?.get(noteKey) ?? item.noteId;
      out += `[^${label}]`;
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
        const fmtForComment: RunFormatting = { ...seg.formatting, highlight: false };
        let segText = wrapWithFormatting(seg.text, fmtForComment);
        if (seg.href) {
          segText = `[${segText}](${formatHrefForMarkdown(seg.href)})`;
        }
        groupedCommentText.push(segText);
        j++;
      }

      out += `{==${groupedCommentText.join('')}==}`;
      for (const cid of [...commentSet].sort()) {
        const c = comments.get(cid);
        if (!c) { continue; }
        out += formatCommentBody(cid, c);
      }

      i = j;
      continue;
    }

    let formattedText = wrapWithFormatting(item.text, item.formatting);
    if (item.href) {
      formattedText = `[${formattedText}](${formatHrefForMarkdown(item.href)})`;
    }
    out += formattedText;
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
  noteLabels?: Map<string, string>
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

      if (item.pandocKeys.length > 0) {
        out += ' [' + item.pandocKeys.map(k => '@' + k).join('; ') + ']';
      } else {
        out += item.text;
      }
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

      out += item.display ? '$$' + '\n' + item.latex + '\n' + '$$' : '$' + item.latex + '$';
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
      out += `[^${label}]`;
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

    const fmtForText: RunFormatting = currentIds.size > 0
      ? { ...item.formatting, highlight: false }
      : item.formatting;
    let formattedText = wrapWithFormatting(item.text, fmtForText);
    if (item.href) {
      formattedText = `[${formattedText}](${formatHrefForMarkdown(item.href)})`;
    }
    out += formattedText;
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

function renderHtmlTable(table: { rows: TableRow[] }, comments: Map<string, Comment>, indent: string = '  ', renderOpts?: { alwaysUseCommentIds?: boolean; commentIdRemap?: Map<string, string>; forceIdCommentIds?: Set<string>; emittedIdCommentBodies?: Set<string>; noteLabels?: Map<string, string> }): string {
  const i1 = indent;  // tr level
  const i2 = indent + indent;  // td/th level
  const i3 = indent + indent + indent;  // content level
  const lines: string[] = ['<table>'];
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

export function buildMarkdown(
  content: ContentItem[],
  comments: Map<string, Comment>,
  options?: { tableIndent?: string; alwaysUseCommentIds?: boolean; commentIdMapping?: Map<string, string> | null; notes?: { map: Map<string, { label: string; body: ContentItem[]; noteKind: 'footnote' | 'endnote' }>; assignedLabels: Map<string, string> } },
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
      if (item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math') {
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
        if ((item.type === 'text' || item.type === 'citation' || item.type === 'footnote_ref' || item.type === 'math') && item.commentIds) {
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
  };

  const output: string[] = [];
  let i = 0;
  let lastListType: 'bullet' | 'ordered' | undefined;

  while (i < mergedContent.length) {
    const item = mergedContent[i];

    if (item.type === 'para') {
      const isCurrentList = item.listMeta !== undefined;

      if (output.length > 0) {
        if (lastListType && isCurrentList && item.listMeta!.type === lastListType) {
          output.push('\n');
        } else {
          output.push('\n\n');
        }
      }

      lastListType = isCurrentList ? item.listMeta!.type : undefined;

      if (item.headingLevel) {
        output.push('#'.repeat(item.headingLevel) + ' ');
      } else if (item.listMeta) {
        const indent = item.listMeta.type === 'bullet'
          ? ' '.repeat(2 * item.listMeta.level)
          : ' '.repeat(3 * item.listMeta.level);
        const marker = item.listMeta.type === 'bullet' ? '- ' : '1. ';
        output.push(indent + marker);
      }

      i++;
      continue;
    }

    if (item.type === 'math' && item.display) {
      // Ensure blank line before display math
      if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push('$$' + '\n' + item.latex + '\n' + '$$');
      // A display math block breaks list flow; reset list continuation state.
      lastListType = undefined;
      i++;
      continue;
    }

    if (item.type === 'table') {
      if (output.length > 0 && !output[output.length - 1].endsWith('\n\n')) {
        output.push('\n\n');
      }
      output.push(renderHtmlTable(item, comments, options?.tableIndent, renderOpts));
      lastListType = undefined;
      i++;
      continue;
    }

    const rendered = renderInlineRange(mergedContent, i, comments, { stopBeforeDisplayMath: true }, renderOpts);
    if (rendered.nextIndex <= i) {
      throw new Error('Invariant violated: renderInlineRange did not advance index');
    }
    if (rendered.deferredComments.length > 0) {
      // Strip trailing newlines (from <w:br/> between comment references in round-tripped DOCX)
      output.push(rendered.text.replace(/\n+$/, ''));
      output.push('\n');
      output.push(rendered.deferredComments.join('\n'));
    } else {
      output.push(rendered.text);
    }
    i = rendered.nextIndex;
  }

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
    for (const entry of entries) {
      output.push('\n\n');
      const bodyMerged = mergeConsecutiveRuns(entry.body);
      // Render body, splitting on para markers for multi-paragraph footnotes
      const bodyParts: string[] = [];
      let partStart = 0;
      for (let bi = 0; bi < bodyMerged.length; bi++) {
        if (bodyMerged[bi].type === 'para') {
          if (bi > partStart) {
            const part = renderInlineRange(bodyMerged, partStart, comments, undefined, renderOpts);
            bodyParts.push(part.text);
          }
          partStart = bi + 1;
        }
      }
      if (partStart < bodyMerged.length) {
        const part = renderInlineRange(bodyMerged, partStart, comments, undefined, renderOpts);
        bodyParts.push(part.text);
      }
      if (bodyParts.length === 0) {
        bodyParts.push('');
      }
      // First line: [^label]: text (trim leading whitespace from note body)
      output.push(`[^${entry.label}]: ${bodyParts[0].replace(/^\s+/, '')}`);
      // Continuation paragraphs: indented 4 spaces
      for (let pi = 1; pi < bodyParts.length; pi++) {
        output.push('\n\n    ' + bodyParts[pi]);
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
  const offsetMinutes = -dt.getTimezoneOffset();
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}${formatOffsetString(offsetMinutes)}`;
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
  keyMap: Map<string, string>
): string {
  const entries: string[] = [];
  const emitted = new Set<string>();

  for (const citation of zoteroCitations) {
    for (const meta of citation.items) {
      const id = itemIdentifier(meta);
      if (emitted.has(id)) { continue; }
      emitted.add(id);

      const key = keyMap.get(id);
      if (!key) { continue; }

      const authorStr = meta.authors.map(serializeAuthor).join(' and ');

      const entryType = mapCSLTypeToBibtex(meta.type, meta.fullItemData?.genre);
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

      entries.push(`@${entryType}{${key},\n${fields.join(',\n')},\n}`);
    }
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
    const text = nodeText(node['dc:creator']).trim();
    if (text) return text;
  }
  return undefined;
}

// Main conversion

export async function convertDocx(
  data: Uint8Array,
  format: CitationKeyFormat = 'authorYearTitle',
  options?: { tableIndent?: string; alwaysUseCommentIds?: boolean },
): Promise<ConvertResult> {
  const zip = await loadZip(data);
  const [comments, zoteroCitations, zoteroPrefs, author, commentIdMapping, footnoteIdMapping] = await Promise.all([
    extractComments(zip),
    extractZoteroCitations(zip),
    extractZoteroPrefs(zip),
    extractAuthor(zip),
    extractCommentIdMapping(zip),
    extractFootnoteIdMapping(zip),
  ]);

  const keyMap = buildCitationKeyMap(zoteroCitations, format);
  const [{ content: docContent, zoteroBiblData }, footnotes, endnotes] = await Promise.all([
    extractDocumentContent(zip, zoteroCitations, keyMap),
    extractFootnotes(zip),
    extractEndnotes(zip),
  ]);

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
  // Pre-collect all mapped labels to avoid collision with auto-generated numeric labels
  const usedLabels = new Set<string>();
  for (const ref of refOrder) {
    const mapped = footnoteIdMapping?.get(ref.noteId);
    if (mapped) usedLabels.add(mapped);
  }
  for (const ref of refOrder) {
    const key = ref.noteKind + ':' + ref.noteId;
    if (assignedLabels.has(key)) continue;
    const source = ref.noteKind === 'footnote' ? footnotes : endnotes;
    const body = source.get(ref.noteId);
    if (!body) continue;
    const mappedLabel = footnoteIdMapping?.get(ref.noteId);
    let label: string;
    if (mappedLabel) {
      label = mappedLabel;
    } else {
      while (usedLabels.has(String(noteCounter))) noteCounter++;
      label = String(noteCounter++);
    }
    usedLabels.add(label);
    assignedLabels.set(key, label);
    notesMap.set(key, { label, body: body.content, noteKind: ref.noteKind });
  }

  // Detect which note kind is used for the frontmatter notes field.
  // V1: mixed footnote+endnote documents are uncommon; if both exist, endnotes wins.
  let detectedNotesMode: NotesMode | undefined;
  if (endnotes.size > 0) {
    detectedNotesMode = 'endnotes';
  }

  // Extract consecutive Title-styled paragraphs from the beginning of the document
  const titleLines = extractTitleLines(docContent);

  let markdown = buildMarkdown(docContent, comments, {
    tableIndent: options?.tableIndent,
    alwaysUseCommentIds: options?.alwaysUseCommentIds,
    commentIdMapping,
    notes: notesMap.size > 0 ? { map: notesMap, assignedLabels } : undefined,
  });

  // Strip Sources section if present (fallback for docs without ZOTERO_BIBL field codes)
  if (!zoteroBiblData) {
    const lines = markdown.split('\n');
    const sourcesIdx = lines.findIndex(l => SOURCES_HEADING_RE.test(l.trim()));
    if (sourcesIdx >= 0) {
      markdown = lines.slice(0, sourcesIdx).join('\n').trimEnd();
    }
  }

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
    fm.locale = zoteroPrefs.locale;
    fm.noteType = zoteroPrefs.noteType !== undefined ? noteTypeFromNumber(zoteroPrefs.noteType) : undefined;
  }
  if (detectedNotesMode === 'endnotes') {
    fm.notes = 'endnotes';
  }
  // Store the local timezone so md→docx can reconstruct UTC dates
  const hasCommentDates = [...comments.values()].some(c => !!c.date);
  if (hasCommentDates) {
    fm.timezone = getLocalTimezoneOffset();
  }
  const frontmatterStr = serializeFrontmatter(fm);
  if (frontmatterStr) {
    markdown = frontmatterStr + '\n' + markdown;
  }

  const bibtex = generateBibTeX(zoteroCitations, keyMap);
  return { markdown, bibtex, zoteroPrefs, zoteroBiblData };
}
