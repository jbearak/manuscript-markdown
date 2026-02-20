import { BibtexEntry } from './bibtex-parser';
import { latexToOmml } from './latex-to-omml';
import { loadStyle, loadStyleAsync, loadLocale } from './csl-loader';

// citeproc is a CommonJS module exporting the CSL namespace
let CSL: any;
try {
  CSL = require('citeproc');
} catch {
  // citeproc not available — fallback rendering will be used
}

export interface CitationResult {
  xml: string;
  warning?: string;
  missingKeys?: string[];
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Convert citeproc HTML output (e.g. `<i>1</i>`) to OOXML runs with
 * proper formatting.  Handles `<i>`, `<b>`, `<sup>`, `<sub>`, and
 * `<span style="...small-caps...">`.
 */
export function htmlToOoxmlRuns(html: string): string {
  const runs: { text: string; italic: boolean; bold: boolean; sup: boolean; sub: boolean; smallCaps: boolean }[] = [];

  let pos = 0;
  let currentText = '';
  let italic = false;
  let bold = false;
  let sup = false;
  let sub = false;
  let smallCaps = false;

  while (pos < html.length) {
    if (html[pos] === '<') {
      if (currentText) {
        runs.push({ text: currentText, italic, bold, sup, sub, smallCaps });
        currentText = '';
      }

      const tagEnd = html.indexOf('>', pos);
      if (tagEnd === -1) {
        currentText += html.slice(pos);
        break;
      }

      const tag = html.slice(pos + 1, tagEnd).trim();

      if (tag === 'i') italic = true;
      else if (tag === '/i') italic = false;
      else if (tag === 'b') bold = true;
      else if (tag === '/b') bold = false;
      else if (tag === 'sup') sup = true;
      else if (tag === '/sup') sup = false;
      else if (tag === 'sub') sub = true;
      else if (tag === '/sub') sub = false;
      else if (tag.startsWith('span') && tag.includes('small-caps')) smallCaps = true;
      else if (tag === '/span') smallCaps = false;

      pos = tagEnd + 1;
    } else {
      currentText += html[pos];
      pos++;
    }
  }

  if (currentText) {
    runs.push({ text: currentText, italic, bold, sup, sub, smallCaps });
  }

  return runs.map(run => {
    const rPr: string[] = [];
    if (run.italic) rPr.push('<w:i/>');
    if (run.bold) rPr.push('<w:b/>');
    if (run.sup) rPr.push('<w:vertAlign w:val="superscript"/>');
    if (run.sub) rPr.push('<w:vertAlign w:val="subscript"/>');
    if (run.smallCaps) rPr.push('<w:smallCaps/>');

    const rPrXml = rPr.length > 0 ? '<w:rPr>' + rPr.join('') + '</w:rPr>' : '';
    return '<w:r>' + rPrXml + '<w:t xml:space="preserve">' + escapeXml(run.text) + '</w:t></w:r>';
  }).join('');
}

export interface CreateEngineResult {
  engine?: any;
  styleNotFound?: boolean;
}

/**
 * Create a citeproc CSL.Engine instance from BibTeX entries, a CSL style name,
 * and an optional locale.  Returns undefined if citeproc is not available or
 * the style cannot be loaded synchronously (bundled/local only).
 */
export function createCiteprocEngine(
  entries: Map<string, BibtexEntry>,
  styleName: string,
  locale?: string
): any | undefined {
  if (!CSL) return undefined;

  let styleXml: string;
  try {
    styleXml = loadStyle(styleName);
  } catch {
    return undefined;
  }

  return buildEngine(entries, styleXml, locale);
}

/**
 * Try to create a citeproc engine using only bundled/local styles (no download).
 * Returns `{ engine }` on success, or `{ styleNotFound: true }` if the style
 * is not available locally.
 */
export function createCiteprocEngineLocal(
  entries: Map<string, BibtexEntry>,
  styleName: string,
  locale?: string
): CreateEngineResult {
  if (!CSL) return {};

  let styleXml: string;
  try {
    styleXml = loadStyle(styleName);
  } catch {
    return { styleNotFound: true };
  }

  const engine = buildEngine(entries, styleXml, locale);
  return engine ? { engine } : {};
}

/**
 * Async version that tries to download the style if not bundled.
 * Returns `{ engine }` on success, or `{ styleNotFound: true }` if the
 * style could not be found or downloaded.
 */
export async function createCiteprocEngineAsync(
  entries: Map<string, BibtexEntry>,
  styleName: string,
  locale?: string
): Promise<CreateEngineResult> {
  if (!CSL) return {};

  let styleXml: string;
  try {
    styleXml = await loadStyleAsync(styleName);
  } catch {
    return { styleNotFound: true };
  }

  const engine = buildEngine(entries, styleXml, locale);
  return engine ? { engine } : {};
}

function buildEngine(
  entries: Map<string, BibtexEntry>,
  styleXml: string,
  locale?: string
): any | undefined {
  // Build CSL-JSON item map keyed by citation key
  const items = new Map<string, any>();
  for (const [key, entry] of entries) {
    const itemData = buildItemData(entry);
    itemData.id = key;
    items.set(key, itemData);
  }

  const sys = {
    retrieveLocale: (lang: string) => {
      try { return loadLocale(lang); } catch { return ''; }
    },
    retrieveItem: (id: string) => items.get(id),
  };

  try {
    const engine = new CSL.Engine(sys, styleXml, locale || 'en-US');
    // Register all item IDs
    engine.updateItems([...items.keys()]);
    return engine;
  } catch {
    return undefined;
  }
}

/**
 * Use a citeproc engine to render a citation cluster for the given keys/locators.
 * Returns the formatted citation text, or undefined if rendering fails.
 */
export function renderCitationText(
  engine: any,
  keys: string[],
  locators?: Map<string, string>
): string | undefined {
  if (!engine || !CSL) return undefined;

  try {
    const rawList = keys.map(key => {
      const item: any = { id: key };
      const locator = locators?.get(key);
      if (locator) {
        const parsed = parseLocator(locator);
        item.locator = parsed.locator;
        item.label = parsed.label;
      }
      return item;
    });

    return engine.makeCitationCluster(rawList) as string;
  } catch {
    return undefined;
  }
}

/**
 * Use a citeproc engine to render the bibliography.
 * Returns an array of formatted bibliography entry strings (HTML-ish),
 * or undefined if rendering fails.
 */
export function renderBibliography(engine: any): { bibStart: string; bibEnd: string; entries: string[] } | undefined {
  if (!engine || !CSL) return undefined;

  try {
    const result = engine.makeBibliography();
    if (!result || !result[1]) return undefined;
    const [meta, entries] = result;
    return {
      bibStart: meta.bibstart || '',
      bibEnd: meta.bibend || '',
      entries: entries as string[],
    };
  } catch {
    return undefined;
  }
}

/**
 * Generate OOXML paragraphs for missing citation keys, to appear after the bibliography.
 */
export function generateMissingKeysXml(missingKeys: string[]): string {
  return missingKeys.map(key =>
    '<w:p><w:r><w:t xml:space="preserve">Citation data for @' + escapeXml(key) +
    ' was not found in the bibliography file.</w:t></w:r></w:p>'
  ).join('');
}

/**
 * Generate a random 8-character alphanumeric citation ID.
 * Zotero requires each citation in the document to carry a unique random ID
 * so it can track and update individual citations during "Add/Edit Citation"
 * round-trips.  A deterministic ID (e.g. hash of keys) would collide when the
 * same source is cited more than once.
 */
export function generateCitationId(usedIds?: Set<string>): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!usedIds || !usedIds.has(id)) {
      usedIds?.add(id);
      return id;
    }
  }
}

function resolveVisibleText(
  keys: string[],
  entries: Map<string, BibtexEntry>,
  locators: Map<string, string> | undefined,
  citeprocEngine: any | undefined
): string {
  if (citeprocEngine) {
    const rendered = renderCitationText(citeprocEngine, keys, locators);
    if (rendered) return rendered;
  }
  return generateFallbackText(keys, entries, locators);
}

function buildCitationFieldCode(
  keys: string[],
  entries: Map<string, BibtexEntry>,
  locators: Map<string, string> | undefined,
  citeprocEngine: any | undefined,
  visibleTextOverride?: string,
  usedCitationIds?: Set<string>,
  itemIdMap?: Map<string, number>
): string {
  // Resolve visible text first so we can populate properties (Defect 2)
  const visibleText = visibleTextOverride ?? resolveVisibleText(keys, entries, locators, citeprocEngine);

  const citationItems: any[] = [];
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry) continue;
    const itemData = buildItemData(entry);
    itemData['citation-key'] = key;        // preserve citekey for round-trip

    // Defect 4: assign stable numeric id via itemIdMap
    if (itemIdMap) {
      let numericId = itemIdMap.get(key);
      if (numericId === undefined) {
        numericId = itemIdMap.size + 1;
        itemIdMap.set(key, numericId);
      }
      itemData.id = numericId;
    }

    const citationItem: any = { id: itemData.id, itemData };
    if (entry.zoteroUri) {
      citationItem.uris = [entry.zoteroUri];
    }
    const locator = locators?.get(key);
    if (locator) {
      const parsed = parseLocator(locator);
      citationItem.locator = parsed.locator;
      citationItem.label = parsed.label;
    }
    citationItems.push(citationItem);
  }

  // Defect 3: key ordering — citationID, properties, citationItems, schema
  const cslCitation = {
    citationID: generateCitationId(usedCitationIds),                    // Defect 1
    properties: {
      formattedCitation: visibleText,                                   // Defect 2
      plainCitation: stripHtmlTags(visibleText),                        // Defect 2
      noteIndex: 0,
    },
    citationItems,
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json',
  };
  const json = JSON.stringify(cslCitation);

  return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + escapeXml(json) + ' </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    htmlToOoxmlRuns(visibleText) +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
}

export function generateCitation(
  run: { keys?: string[]; locators?: Map<string, string>; text: string },
  entries: Map<string, BibtexEntry>,
  citeprocEngine?: any,
  usedCitationIds?: Set<string>,
  itemIdMap?: Map<string, number>
): CitationResult {
  if (!run.keys || run.keys.length === 0) {
    return { xml: '<w:r><w:t>[@' + escapeXml(run.text) + ']</w:t></w:r>' };
  }

  // Classify keys into resolved (have bib data) vs missing
  const resolvedKeys: string[] = [];
  const missingKeys: string[] = [];
  const warnings: string[] = [];

  for (const key of run.keys) {
    const entry = entries.get(key);
    if (!entry) {
      missingKeys.push(key);
      warnings.push(`Citation key not found: ${key}`);
    } else {
      resolvedKeys.push(key);
    }
  }

  // All resolved — emit field code (works for both Zotero and non-Zotero entries)
  if (resolvedKeys.length > 0 && missingKeys.length === 0) {
    const xml = buildCitationFieldCode(resolvedKeys, entries, run.locators, citeprocEngine, undefined, usedCitationIds, itemIdMap);
    return { xml };
  }

  // Pure missing — emit @citekey references as plain text
  if (resolvedKeys.length === 0) {
    const missingText = '(' + missingKeys.map(k => '@' + k).join('; ') + ')';
    return {
      xml: '<w:r><w:t>' + escapeXml(missingText) + '</w:t></w:r>',
      warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      missingKeys
    };
  }

  // Mixed (some resolved, some missing) — resolved get field code, missing get plain text
  const missingText = '(' + missingKeys.map(k => '@' + k).join('; ') + ')';
  const xml = buildCitationFieldCode(resolvedKeys, entries, run.locators, citeprocEngine, undefined, usedCitationIds, itemIdMap) +
    '<w:r><w:t xml:space="preserve"> </w:t></w:r>' +
    '<w:r><w:t>' + escapeXml(missingText) + '</w:t></w:r>';

  return {
    xml,
    warning: warnings.join('; '),
    missingKeys
  };
}

export function buildItemData(entry: BibtexEntry): any {
  const itemData: any = {
    type: mapBibtexTypeToCSL(entry.type)
  };

  const lowerType = entry.type.toLowerCase();
  if (lowerType === 'mastersthesis') itemData.genre = "Master's thesis";
  else if (lowerType === 'phdthesis') itemData.genre = "PhD thesis";

  const title = entry.fields.get('title');
  if (title) itemData.title = title;

  const author = entry.fields.get('author');
  if (author) itemData.author = parseAuthors(author);

  const year = entry.fields.get('year');
  if (year && /^\d+$/.test(year)) {
    itemData.issued = { 'date-parts': [[parseInt(year, 10)]] };
  }

  const journal = entry.fields.get('journal');
  if (journal) itemData['container-title'] = journal;

  const volume = entry.fields.get('volume');
  if (volume) itemData.volume = volume;

  const pages = entry.fields.get('pages');
  if (pages) itemData.page = pages;

  const doi = entry.fields.get('doi');
  if (doi) itemData.DOI = doi;

  // Editor (parsed like authors, supports institutional editors)
  const editor = entry.fields.get('editor');
  if (editor) itemData.editor = parseAuthors(editor);

  const publisher = entry.fields.get('publisher');
  if (publisher) itemData.publisher = publisher;

  const address = entry.fields.get('address');
  if (address) itemData['publisher-place'] = address;

  const url = entry.fields.get('url');
  if (url) itemData.URL = url;

  const isbn = entry.fields.get('isbn');
  if (isbn) itemData.ISBN = isbn;

  const issn = entry.fields.get('issn');
  if (issn) itemData.ISSN = issn;

  const number = entry.fields.get('number');
  if (number) itemData.issue = number;

  const edition = entry.fields.get('edition');
  if (edition) itemData.edition = edition;

  // booktitle → container-title, but only if journal didn't already set it
  const booktitle = entry.fields.get('booktitle');
  if (booktitle && !journal) itemData['container-title'] = booktitle;

  const abstract_ = entry.fields.get('abstract');
  if (abstract_) itemData.abstract = abstract_;

  const note = entry.fields.get('note');
  if (note) itemData.note = note;

  const series = entry.fields.get('series');
  if (series) itemData['collection-title'] = series;

  return itemData;
}

function mapBibtexTypeToCSL(bibtexType: string): string {
  switch (bibtexType.toLowerCase()) {
    case 'article': return 'article-journal';
    case 'book': return 'book';
    case 'inproceedings': return 'paper-conference';
    case 'incollection': return 'chapter';
    case 'inbook': return 'chapter';
    case 'phdthesis': return 'thesis';
    case 'mastersthesis': return 'thesis';
    case 'techreport': return 'report';
    case 'misc': return 'article';
    default: return 'article';
  }
}

/** Split an author string on ` and ` while respecting brace depth. */
export function splitAuthorString(authorString: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  const sep = ' and ';
  for (let i = 0; i < authorString.length; i++) {
    if (authorString[i] === '{') { depth++; continue; }
    if (authorString[i] === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && authorString.slice(i, i + sep.length) === sep) {
      result.push(authorString.slice(start, i).trim());
      i += sep.length - 1;
      start = i + 1;
    }
  }
  result.push(authorString.slice(start).trim());
  return result.filter(s => s.length > 0);
}

export function parseAuthors(authorString: string): any[] {
  const authors = splitAuthorString(authorString);
  return authors.map(author => {
    // Institutional/corporate author: wrapped in braces (after BibTeX parser
    // stripped the outer field braces, institutional names arrive as {Name}).
    if (author.startsWith('{') && author.endsWith('}')) {
      return { literal: author.slice(1, -1) };
    }
    const commaPos = author.indexOf(',');
    if (commaPos !== -1) {
      const family = author.slice(0, commaPos).trim();
      const given = author.slice(commaPos + 1).trim();
      return { family, given };
    }
    const parts = author.split(' ');
    if (parts.length >= 2) {
      const given = parts.slice(0, -1).join(' ');
      const family = parts[parts.length - 1];
      return { family, given };
    }
    return { family: author };
  });
}

function parseLocator(locator: string): { locator: string; label: string } {
  const trimmed = locator.trim();
  if (trimmed.startsWith('p.') || trimmed.startsWith('pp.')) {
    const pageMatch = trimmed.match(/^pp?\.\s*(.+)$/);
    if (pageMatch) {
      return { locator: pageMatch[1], label: 'page' };
    }
  }
  return { locator: trimmed, label: 'page' };
}

export function generateFallbackText(keys: string[], entries: Map<string, BibtexEntry>, locators?: Map<string, string>): string {
  const parts = keys.map(key => {
    const entry = entries.get(key);
    if (!entry) return key;

    const author = entry.fields.get('author');
    const year = entry.fields.get('year');

    let text = '';
    if (author) {
      const firstAuthor = splitAuthorString(author)[0] || author.trim();
      if (firstAuthor.startsWith('{') && firstAuthor.endsWith('}')) {
        // Institutional author — use the full name
        text = firstAuthor.slice(1, -1);
      } else {
        const commaPos = firstAuthor.indexOf(',');
        text = commaPos !== -1 ? firstAuthor.slice(0, commaPos).trim() : firstAuthor.split(' ').pop() || firstAuthor;
      }
    } else {
      text = key;
    }

    if (year) text += ' ' + year;

    const locator = locators?.get(key);
    if (locator) text += ', ' + locator;

    return text;
  });

  return '(' + parts.join('; ') + ')';
}

/**
 * Generate OOXML for a ZOTERO_BIBL field code with rendered bibliography.
 */
export function generateBibliographyXml(
  citeprocEngine: any,
  biblData?: { uncited?: any[]; omitted?: any[]; custom?: any[] }
): string {
  const biblPayload = JSON.stringify({
    uncited: biblData?.uncited || [],
    omitted: biblData?.omitted || [],
    custom: biblData?.custom || [],
  });

  const bib = renderBibliography(citeprocEngine);

  // Generate bibliography paragraphs with proper formatting
  let bibParagraphs = '';
  if (bib && bib.entries.length > 0) {
    for (const entry of bib.entries) {
      const trimmed = entry.trim();
      if (trimmed) {
        bibParagraphs += '<w:p>' + htmlToOoxmlRuns(trimmed) + '</w:p>';
      }
    }
  }

  // Wrap in field code
  return '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL ' + escapeXml(biblPayload) + ' CSL_BIBLIOGRAPHY </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>' +
    bibParagraphs +
    '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
}

export function generateMathXml(latex: string, display: boolean): string {
  const omml = latexToOmml(latex);

  if (display) {
    return '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>';
  } else {
    return '<m:oMath>' + omml + '</m:oMath>';
  }
}
