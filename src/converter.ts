import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

/** Matches a "Sources" heading (with or without leading `#` markers). */
const SOURCES_HEADING_RE = /^(?:#+\s*)?Sources\s*$/;

// Types

export interface Comment {
  author: string;
  text: string;
  date: string;
}

export interface CitationMetadata {
  authors: Array<{ family?: string; given?: string }>;
  title: string;
  year: string;
  journal: string;
  volume: string;
  pages: string;
  doi: string;
  type: string;
  fullItemData: Record<string, any>;
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
  superscript: boolean;
  subscript: boolean;
}

/** List metadata for a paragraph */
export interface ListMeta {
  type: 'bullet' | 'ordered';
  level: number; // 0-based indentation level
}

export const DEFAULT_FORMATTING: RunFormatting = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  highlight: false,
  superscript: false,
  subscript: false,
};

export type ContentItem =
  | {
      type: 'text';
      text: string;
      commentIds: Set<string>;
      formatting: RunFormatting;
      href?: string;           // hyperlink URL if inside w:hyperlink
    }
  | { type: 'citation'; text: string; commentIds: Set<string>; pandocKeys: string[] }
  | {
      type: 'para';
      headingLevel?: number;   // 1–6 if heading, undefined otherwise
      listMeta?: ListMeta;     // present if list item
    };

export type CitationKeyFormat = 'authorYearTitle' | 'authorYear' | 'numeric';

export interface ConvertResult {
  markdown: string;
  bibtex: string;
}

// XML helpers

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
};

export async function parseRelationships(zip: JSZip): Promise<Map<string, string>> {
  const relationships = new Map<string, string>();
  const parsed = await readZipXml(zip, 'word/_rels/document.xml.rels');
  if (!parsed) { return relationships; }

  for (const node of findAllDeep(parsed, 'Relationship')) {
    const rel = node.Relationship;
    if (!rel) continue;
    
    const id = getAttr(rel, 'Id');
    const type = getAttr(rel, 'Type');
    const target = getAttr(rel, 'Target');
    const targetMode = getAttr(rel, 'TargetMode');
    
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
    
    const abstractNumId = getAttr(abstractNum, 'abstractNumId');
    const levels = new Map<string, 'bullet' | 'ordered'>();
    
    for (const lvlNode of findAllDeep(abstractNum, 'w:lvl')) {
      const lvl = lvlNode['w:lvl'];
      if (!lvl) continue;
      
      const ilvl = getAttr(lvl, 'ilvl');
      const numFmtNodes = findAllDeep(lvl, 'w:numFmt');
      if (numFmtNodes.length > 0) {
        const numFmt = numFmtNodes[0]['w:numFmt'];
        const val = getAttr(numFmt, 'val');
        levels.set(ilvl, val === 'bullet' ? 'bullet' : 'ordered');
      }
    }
    
    abstractNums.set(abstractNumId, levels);
  }

  // Resolve numId → abstractNumId
  for (const node of findAllDeep(parsed, 'w:num')) {
    const num = node['w:num'];
    if (!num) continue;
    
    const numId = getAttr(num, 'numId');
    const abstractNumIdNodes = findAllDeep(num, 'w:abstractNumId');
    if (abstractNumIdNodes.length > 0) {
      const abstractNumId = getAttr(abstractNumIdNodes[0]['w:abstractNumId'], 'val');
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
  
  return {
    type,
    level: parseInt(ilvl, 10)
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
  return val === 'true' || val === '1';
}

/** Parse run properties and return RunFormatting */
export function parseRunProperties(rPrChildren: any[]): RunFormatting {
  const formatting: RunFormatting = { ...DEFAULT_FORMATTING };
  
  formatting.bold = isToggleOn(rPrChildren, 'w:b');
  formatting.italic = isToggleOn(rPrChildren, 'w:i');
  formatting.strikethrough = isToggleOn(rPrChildren, 'w:strike');
  
  // underline: w:u with w:val ≠ "none"
  const uElement = rPrChildren.find(child => child['w:u'] !== undefined);
  if (uElement) {
    const val = getAttr(uElement, 'val');
    formatting.underline = val !== 'none';
  }
  
  // highlight: w:highlight with w:val ≠ "none", OR w:shd with w:fill ≠ "" and ≠ "auto"
  const highlightElement = rPrChildren.find(child => child['w:highlight'] !== undefined);
  if (highlightElement) {
    const val = getAttr(highlightElement, 'val');
    formatting.highlight = val !== 'none';
  } else {
    const shdElement = rPrChildren.find(child => child['w:shd'] !== undefined);
    if (shdElement) {
      const fill = getAttr(shdElement, 'fill');
      formatting.highlight = fill !== '' && fill !== 'auto';
    }
  }
  
  // superscript/subscript: w:vertAlign
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
        return {
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
      });

      citations.push({ plainCitation, items });
    } catch {
      // Push a placeholder so positional indices stay aligned with ZOTERO_ITEM occurrences
      citations.push({ plainCitation: '', items: [] });
    }
  }
  return citations;
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

function itemIdentifier(meta: CitationMetadata): string {
  // Use DOI if available, otherwise title+year
  if (meta.doi) { return `doi:${meta.doi}`; }
  return `${meta.title}::${meta.year}`;
}

function getSurname(meta: CitationMetadata): string {
  if (meta.authors.length > 0 && meta.authors[0].family) {
    return meta.authors[0].family;
  }
  return meta.fullItemData.publisher || meta.journal || 'unknown';
}

/** Get pandoc keys for a citation's items */
export function citationPandocKeys(
  citation: ZoteroCitation,
  keyMap: Map<string, string>
): string[] {
  return citation.items
    .map(meta => keyMap.get(itemIdentifier(meta)))
    .filter((k): k is string => k !== undefined);
}

// Document content extraction

export async function extractDocumentContent(
  data: Uint8Array | JSZip,
  zoteroCitations: ZoteroCitation[],
  keyMap: Map<string, string>
): Promise<ContentItem[]> {
  const zip = data instanceof JSZip ? data : await loadZip(data);
  const parsed = await readZipXml(zip, 'word/document.xml');
  if (!parsed) { return []; }

  // Parse relationships and numbering definitions
  const relationshipMap = await parseRelationships(zip);
  const numberingDefs = await parseNumberingDefinitions(zip);

  // Build a lookup: instrText index -> ZoteroCitation (in order of appearance)
  let citationIdx = 0;

  const content: ContentItem[] = [];
  const activeComments = new Set<string>();
  let inField = false;
  let inCitationField = false;
  let fieldInstrParts: string[] = [];
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];
  let currentHref: string | undefined;

  function walk(nodes: any[], currentFormatting: RunFormatting = DEFAULT_FORMATTING): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') { continue; }

        if (key === 'w:fldChar') {
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
                currentCitation = zoteroCitations[citationIdx++];
                citationTextParts = [];
              }
            }
          } else if (fldType === 'end') {
            if (inCitationField && currentCitation) {
              const pandocKeys = citationPandocKeys(currentCitation, keyMap);
              content.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(activeComments),
                pandocKeys,
              });
            }
            inField = false;
            inCitationField = false;
            currentCitation = undefined;
          }
        } else if (key === 'w:instrText' && inField) {
          fieldInstrParts.push(nodeText(node['w:instrText'] || []));
        } else if (key === 'w:commentRangeStart') {
          activeComments.add(getAttr(node, 'id'));
        } else if (key === 'w:commentRangeEnd') {
          activeComments.delete(getAttr(node, 'id'));
        } else if (key === 'w:hyperlink') {
          const rId = getAttr(node, 'id');
          const prevHref = currentHref;
          currentHref = relationshipMap.get(rId);
          if (Array.isArray(node[key])) { walk(node[key], currentFormatting); }
          currentHref = prevHref;
        } else if (key === 'w:r') {
          // Process run - extract formatting from w:rPr
          let runFormatting = currentFormatting;
          const runChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const child of runChildren) {
            if (child['w:rPr']) {
              const rPrChildren = Array.isArray(child['w:rPr']) ? child['w:rPr'] : [child['w:rPr']];
              runFormatting = parseRunProperties(rPrChildren);
              break;
            }
          }
          walk(runChildren, runFormatting);
        } else if (key === 'w:t') {
          const text = nodeText(node['w:t'] || []);
          if (text) {
            if (inCitationField) {
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
              content.push(textItem);
            }
          }
        } else if (key === 'w:p') {
          // Process paragraph - extract heading level and list metadata
          let headingLevel: number | undefined;
          let listMeta: ListMeta | undefined;
          
          const paraChildren = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const child of paraChildren) {
            if (child['w:pPr']) {
              const pPrChildren = Array.isArray(child['w:pPr']) ? child['w:pPr'] : [child['w:pPr']];
              headingLevel = parseHeadingLevel(pPrChildren);
              listMeta = parseListMeta(pPrChildren, numberingDefs);
              break;
            }
          }
          
          // Push para item if: this is the first paragraph with heading/list metadata,
          // OR there's content and the last item isn't already a para
          const needsPara = (headingLevel || listMeta) 
            ? content.length === 0 || content[content.length - 1].type !== 'para'
            : content.length > 0 && content[content.length - 1].type !== 'para';
          
          if (needsPara) {
            const paraItem: ContentItem = { type: 'para' };
            if (headingLevel) paraItem.headingLevel = headingLevel;
            if (listMeta) paraItem.listMeta = listMeta;
            content.push(paraItem);
          }
          walk(paraChildren, currentFormatting);
        } else if (Array.isArray(node[key])) {
          walk(node[key], currentFormatting);
        }
      }
    }
  }

  walk(Array.isArray(parsed) ? parsed : [parsed]);
  return content;
}

// Markdown generation

function formattingEquals(a: RunFormatting, b: RunFormatting): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
         a.strikethrough === b.strikethrough && a.highlight === b.highlight &&
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

export function buildMarkdown(
  content: ContentItem[],
  comments: Map<string, Comment>,
): string {
  const mergedContent = mergeConsecutiveRuns(content);
  const output: string[] = [];
  let i = 0;
  let lastWasList = false;

  while (i < mergedContent.length) {
    const item = mergedContent[i];

    if (item.type === 'para') {
      const isCurrentList = item.listMeta !== undefined;
      
      if (lastWasList && isCurrentList) {
        output.push('\n');
      } else {
        output.push('\n\n');
      }
      
      lastWasList = isCurrentList;
      
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

    if (item.type === 'citation') {
      if (item.pandocKeys.length > 0) {
        output.push(` [${item.pandocKeys.map(k => `@${k}`).join('; ')}]`);
      } else {
        output.push(item.text);
      }
      i++;
      continue;
    }

    // text with comments
    if (item.commentIds.size > 0) {
      output.push(`{==${item.text}==}`);
      for (const cid of [...item.commentIds].sort()) {
        const c = comments.get(cid);
        if (!c) { continue; }
        let dateStr = '';
        if (c.date) {
          try {
            const dt = new Date(c.date);
            if (!isNaN(dt.getTime())) {
              const pad = (n: number) => String(n).padStart(2, '0');
              dateStr = ` (${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())})`;
            }
          } catch { dateStr = ` (${c.date})`; }
        }
        output.push(`{>>${c.author}${dateStr}: ${c.text}<<}`);
      }
      i++;
      continue;
    }

    // regular text with formatting and hyperlinks
    let formattedText = wrapWithFormatting(item.text, item.formatting);
    if (item.href) {
      formattedText = `[${formattedText}](${item.href})`;
    }
    output.push(formattedText);
    i++;
  }

  return output.join('');
}

// BibTeX generation

/** Escape special LaTeX/BibTeX characters in field values. */
function escapeBibtex(s: string): string {
  return s.replace(/([&%$#_{}~^\\])/g, '\\$1');
}

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

      const authorStr = meta.authors
        .map(a => [a.family, a.given].filter((s): s is string => Boolean(s)).map(escapeBibtex).join(', '))
        .join(' and ');

      const entryType = (meta.journal || meta.volume) ? 'article' : 'misc';
      const fields: string[] = [];
      if (authorStr) { fields.push(`  author = {${authorStr}}`); }
      if (meta.title) { fields.push(`  title = {{${escapeBibtex(meta.title)}}}`); }
      if (meta.journal) { fields.push(`  journal = {${escapeBibtex(meta.journal)}}`); }
      if (meta.volume) { fields.push(`  volume = {${escapeBibtex(meta.volume)}}`); }
      if (meta.pages) { fields.push(`  pages = {${escapeBibtex(meta.pages)}}`); }
      if (meta.year) { fields.push(`  year = {${escapeBibtex(meta.year)}}`); }
      if (meta.doi) { fields.push(`  doi = {${meta.doi}}`); }

      entries.push(`@${entryType}{${key},\n${fields.join(',\n')},\n}`);
    }
  }

  return entries.join('\n\n');
}

// Main conversion

export async function convertDocx(
  data: Uint8Array,
  format: CitationKeyFormat = 'authorYearTitle'
): Promise<ConvertResult> {
  const zip = await loadZip(data);
  const [comments, zoteroCitations] = await Promise.all([
    extractComments(zip),
    extractZoteroCitations(zip),
  ]);

  const keyMap = buildCitationKeyMap(zoteroCitations, format);
  const docContent = await extractDocumentContent(zip, zoteroCitations, keyMap);
  let markdown = buildMarkdown(docContent, comments);

  // Strip Sources section if present
  const lines = markdown.split('\n');
  const sourcesIdx = lines.findIndex(l => SOURCES_HEADING_RE.test(l.trim()));
  if (sourcesIdx >= 0) {
    markdown = lines.slice(0, sourcesIdx).join('\n').trimEnd();
  }

  const bibtex = generateBibTeX(zoteroCitations, keyMap);
  return { markdown, bibtex };
}
