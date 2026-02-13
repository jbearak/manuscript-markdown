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

export type ContentItem =
  | { type: 'text'; text: string; commentIds: Set<string> }
  | { type: 'citation'; text: string; commentIds: Set<string>; pandocKeys: string[] }
  | { type: 'para' };

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

async function loadZip(data: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

async function readZipXml(zip: JSZip, path: string): Promise<any[] | null> {
  const file = zip.file(path);
  if (!file) { return null; }
  const xml = await file.async('string');
  return new XMLParser(parserOptions).parse(xml);
}

function findAllDeep(nodes: any[], tagName: string): any[] {
  const results: any[] = [];
  for (const node of nodes) {
    if (node[tagName] !== undefined) { results.push(node); }
    for (const key of Object.keys(node)) {
      if (key !== ':@' && Array.isArray(node[key])) {
        results.push(...findAllDeep(node[key], tagName));
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

  // NOTE: Split w:instrText across multiple w:r elements (common in
  // Zotero-generated DOCX) is not yet handled; we only match single-run fields.
  for (const node of findAllDeep(parsed, 'w:instrText')) {
    const instrText = nodeText(node['w:instrText'] || []);
    if (!instrText.includes('ZOTERO_ITEM')) { continue; }

    const jsonStart = instrText.indexOf('{');
    if (jsonStart < 0) { continue; }

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
  if (format === 'authorYear') { return `${cleanSurname}${year}`; }
  if (format === 'numeric') { return ''; }
  const words = title.toLowerCase().match(/\b[a-zA-Z]+\b/g) ?? [];
  const firstWord = words.find(w => !['the', 'a', 'an'].includes(w)) ?? 'unknown';
  return `${cleanSurname}${year}${firstWord}`;
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

  // Build a lookup: instrText index -> ZoteroCitation (in order of appearance)
  let citationIdx = 0;

  const content: ContentItem[] = [];
  const activeComments = new Set<string>();
  let inCitationField = false;
  let currentCitation: ZoteroCitation | undefined;
  let citationTextParts: string[] = [];

  // NOTE: walk relies on key-insertion-order preserved by fast-xml-parser with
  // preserveOrder: true so that w:instrText, w:fldChar, and w:t are visited in
  // document order within each node.
  function walk(nodes: any[]): void {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@') { continue; }

        if (key === 'w:instrText') {
          const text = nodeText(node['w:instrText'] || []);
          if (text.includes('ZOTERO_ITEM')) {
            inCitationField = true;
            currentCitation = zoteroCitations[citationIdx++];
            citationTextParts = [];
          }
        } else if (key === 'w:fldChar') {
          const fldType = getAttr(node, 'fldCharType');
          if (fldType === 'end' && inCitationField) {
            // Emit the citation
            if (currentCitation) {
              const pandocKeys = citationPandocKeys(currentCitation, keyMap);
              content.push({
                type: 'citation',
                text: citationTextParts.join(''),
                commentIds: new Set(activeComments),
                pandocKeys,
              });
            }
            inCitationField = false;
            currentCitation = undefined;
          }
        } else if (key === 'w:commentRangeStart') {
          activeComments.add(getAttr(node, 'id'));
        } else if (key === 'w:commentRangeEnd') {
          activeComments.delete(getAttr(node, 'id'));
        } else if (key === 'w:t') {
          const text = nodeText(node['w:t'] || []);
          if (text) {
            if (inCitationField) {
              citationTextParts.push(text);
            } else {
              content.push({ type: 'text', text, commentIds: new Set(activeComments) });
            }
          }
        } else if (key === 'w:p') {
          if (content.length > 0 && content[content.length - 1].type !== 'para') {
            content.push({ type: 'para' });
          }
          if (Array.isArray(node[key])) { walk(node[key]); }
        } else if (Array.isArray(node[key])) {
          walk(node[key]);
        }
      }
    }
  }

  walk(Array.isArray(parsed) ? parsed : [parsed]);
  return content;
}

// Markdown generation

export function buildMarkdown(
  content: ContentItem[],
  comments: Map<string, Comment>,
): string {
  const output: string[] = [];
  let i = 0;

  while (i < content.length) {
    const item = content[i];

    if (item.type === 'para') { output.push('\n\n'); i++; continue; }

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
      let fullText = item.text;
      const commentSet = item.commentIds;
      let j = i + 1;
      while (j < content.length) {
        const next = content[j];
        if (next.type !== 'text' || next.commentIds.size !== commentSet.size) { break; }
        let same = true;
        for (const id of commentSet) { if (!next.commentIds.has(id)) { same = false; break; } }
        if (!same) { break; }
        fullText += next.text;
        j++;
      }

      output.push(`{==${fullText}==}`);
      for (const cid of [...commentSet].sort()) {
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
      i = j;
      continue;
    }

    output.push(item.text);
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

// Reference parsing (for numeric-style documents with Sources section)

export function parseReferences(markdown: string): string[] {
  const refs: string[] = [];
  const lines = markdown.split('\n');
  let inSources = false;
  for (const line of lines) {
    if (SOURCES_HEADING_RE.test(line.trim())) { inSources = true; continue; }
    if (inSources && line.trim()) {
      const match = line.trim().match(/^(\d+)\.(.+)$/);
      if (match) { refs.push(match[2].trim()); }
    }
  }
  return refs;
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
