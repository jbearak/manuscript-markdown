import { BibtexEntry } from './bibtex-parser';
import { latexToOmml } from './latex-to-omml';
import { loadStyle, loadStyleAsync, loadLocale } from './csl-loader';

export interface CiteprocName {
  family?: string;
  given?: string;
  literal?: string;
}

export interface CiteprocItemData {
  id?: string | number;
  type: string;
  genre?: string;
  title?: string;
  author?: CiteprocName[];
  editor?: CiteprocName[];
  issued?: { 'date-parts': number[][] };
  'container-title'?: string;
  volume?: string;
  page?: string;
  DOI?: string;
  publisher?: string;
  'publisher-place'?: string;
  URL?: string;
  ISBN?: string;
  ISSN?: string;
  issue?: string;
  edition?: string;
  abstract?: string;
  note?: string;
  'collection-title'?: string;
  'citation-key'?: string;
  'x-institution'?: string;
}

interface CiteprocCitationItem {
  id?: string | number;
  locator?: string;
  label?: string;
  'suppress-author'?: boolean;
  itemData?: CiteprocItemData;
  uris?: string[];
}

interface CiteprocBibliographyMeta {
  bibstart?: string;
  bibend?: string;
}

interface CiteprocCitation {
  citationID?: string;
  citationItems: CiteprocCitationItem[];
  properties: {
    noteIndex: number;
    mode?: 'composite';
  };
}

export interface CiteprocEngine {
  makeCitationCluster(items: CiteprocCitationItem[]): string;
  previewCitationCluster(
    citation: CiteprocCitation,
    citationsPre: Array<[string, number]>,
    citationsPost: Array<[string, number]>,
    outputFormat: string,
  ): string;
  makeBibliography(): [CiteprocBibliographyMeta, string[]] | false | null;
  updateItems(ids: string[]): unknown;
}

interface CiteprocSystem {
  retrieveLocale(lang: string): string;
  retrieveItem(id: string): CiteprocItemData | undefined;
}

interface CiteprocNamespace {
  Engine: new (system: CiteprocSystem, styleXml: string, locale: string) => CiteprocEngine;
}

// citeproc is a CommonJS module exporting the CSL namespace
let CSL: CiteprocNamespace | undefined;
try {
  CSL = require('citeproc') as CiteprocNamespace;
} catch {
  // citeproc not available — fallback rendering will be used
}

export interface NarrativeCitationOrigin {
  citationId: string;
  citationKey: string;
  literalPrefix: string;
}

export interface CitationResult {
  xml: string;
  warning?: string;
  missingKeys?: string[];
  narrativeOrigin?: NarrativeCitationOrigin;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape for XML element text content — only &, <, > need escaping.
 *  Quotes do NOT need escaping in element text; using &quot; causes Word to
 *  decode them on open and set the dirty flag. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtmlTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ''));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, '\u00A0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Convert citeproc HTML output (e.g. `<i>1</i>`) to OOXML runs with
 * proper formatting.  Handles `<i>`, `<b>`, `<sup>`, `<sub>`, and
 * `<span style="...small-caps...">`.
 */
export function htmlToOoxmlRuns(html: string, extraRPr?: string): string {
  const runs: { text: string; italic: boolean; bold: boolean; sup: boolean; sub: boolean; smallCaps: boolean }[] = [];

  let pos = 0;
  let currentText = '';
  let italic = false;
  let bold = false;
  let sup = false;
  let sub = false;
  let smallCapsDepth = 0;
  let spanDepth = 0;

  while (pos < html.length) {
    if (html[pos] === '<') {
      if (currentText) {
        runs.push({ text: currentText, italic, bold, sup, sub, smallCaps: smallCapsDepth > 0 });
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
      else if (tag.startsWith('span')) {
        spanDepth++;
        if (tag.includes('small-caps')) smallCapsDepth = spanDepth;
      }
      else if (tag === '/span') {
        if (spanDepth === smallCapsDepth) smallCapsDepth = 0;
        spanDepth = Math.max(0, spanDepth - 1);
      }

      pos = tagEnd + 1;
    } else {
      currentText += html[pos];
      pos++;
    }
  }

  if (currentText) {
    runs.push({ text: currentText, italic, bold, sup, sub, smallCaps: smallCapsDepth > 0 });
  }

  return runs.map(run => {
    const rPr: string[] = [];
    if (run.italic) rPr.push('<w:i/>');
    if (run.bold) rPr.push('<w:b/>');
    if (run.sup) rPr.push('<w:vertAlign w:val="superscript"/>');
    if (run.sub) rPr.push('<w:vertAlign w:val="subscript"/>');
    if (run.smallCaps) rPr.push('<w:smallCaps/>');
    if (extraRPr) rPr.push(extraRPr);

    const rPrXml = rPr.length > 0 ? '<w:rPr>' + rPr.join('') + '</w:rPr>' : '';
    const escaped = escapeXmlText(decodeHtmlEntities(run.text));
    const needsPreserve = escaped.length > 0 && (escaped[0] === ' ' || escaped[escaped.length - 1] === ' ');
    const wt = needsPreserve ? '<w:t xml:space="preserve">' + escaped + '</w:t>' : '<w:t>' + escaped + '</w:t>';
    return '<w:r>' + rPrXml + wt + '</w:r>';
  }).join('');
}

export interface CreateEngineResult {
  engine?: CiteprocEngine;
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
): CiteprocEngine | undefined {
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
): CiteprocEngine | undefined {
  const citeproc = CSL;
  if (!citeproc) return undefined;

  // Build CSL-JSON item map keyed by citation key
  const items = new Map<string, CiteprocItemData>();
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
    const engine = new citeproc.Engine(sys, styleXml, locale || 'en-US');
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
  engine: CiteprocEngine,
  keys: string[],
  locators?: Map<string, string>,
  suppressAuthorKeys?: Set<string>,
  mode?: 'composite',
): string | undefined {
  if (!engine || !CSL) return undefined;

  try {
    const rawList = keys.map(key => {
      const item: CiteprocCitationItem = { id: key };
      const locator = locators?.get(key);
      if (locator) {
        const parsed = parseLocator(locator);
        item.locator = parsed.locator;
        item.label = parsed.label;
      }
      if (suppressAuthorKeys?.has(key)) {
        item['suppress-author'] = true;
      }
      return item;
    });

    if (mode === 'composite') {
      return engine.previewCitationCluster({
        citationItems: rawList,
        properties: { noteIndex: 0, mode },
      }, [], [], 'html');
    }
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
export function renderBibliography(engine: CiteprocEngine): { bibStart: string; bibEnd: string; entries: string[] } | undefined {
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
  citeprocEngine: CiteprocEngine | undefined,
  suppressAuthorKeys?: Set<string>,
  narrative?: boolean,
): string {
  if (citeprocEngine) {
    const rendered = renderCitationText(
      citeprocEngine,
      keys,
      locators,
      suppressAuthorKeys,
      narrative ? 'composite' : undefined,
    );
    if (rendered) return rendered;
  }
  return narrative
    ? generateNarrativeFallbackText(keys[0], entries, locators?.get(keys[0]))
    : generateFallbackText(keys, entries, locators, suppressAuthorKeys);
}

function buildCitationFieldCode(
  keys: string[],
  entries: Map<string, BibtexEntry>,
  locators: Map<string, string> | undefined,
  citeprocEngine: CiteprocEngine | undefined,
  visibleTextOverride?: string,
  usedCitationIds?: Set<string>,
  itemIdMap?: Map<string, string | number>,
  suppressAuthorKeys?: Set<string>,
  extraRPr?: string,
  narrative?: boolean,
): CitationResult {
  // Resolve visible text first so we can populate properties (Defect 2).
  // Composite mode is preferred, but citeproc emits [NO_PRINTED_FORM] for
  // styles whose citation layout cannot render an author-only component (for
  // example, numeric styles). In that case use a literal author followed by a
  // normal suppress-author field rather than storing a composite field that
  // Zotero would refresh to an error placeholder.
  let fieldNarrative = narrative ?? false;
  let fieldSuppressAuthorKeys = suppressAuthorKeys;
  let literalAuthorPrefix = '';
  let visibleText: string;
  if (visibleTextOverride !== undefined) {
    visibleText = visibleTextOverride;
  } else if (fieldNarrative) {
    const compositeText = citeprocEngine
      ? renderCitationText(citeprocEngine, keys, locators, suppressAuthorKeys, 'composite')
      : undefined;
    if (compositeText && !/\[(?:NO_PRINTED_FORM|CSL STYLE ERROR:)/.test(compositeText)) {
      visibleText = compositeText;
    } else {
      fieldNarrative = false;
      fieldSuppressAuthorKeys = new Set([...(suppressAuthorKeys ?? []), ...keys]);
      literalAuthorPrefix = generateNarrativeAuthorText(keys[0], entries).replace(/\s+/g, ' ').trim() + ' ';
      visibleText = resolveVisibleText(keys, entries, locators, citeprocEngine, fieldSuppressAuthorKeys);
    }
  } else {
    visibleText = resolveVisibleText(keys, entries, locators, citeprocEngine, suppressAuthorKeys);
  }

  const citationItems: CiteprocCitationItem[] = [];
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry) continue;
    const itemData = buildItemData(entry);
    itemData['citation-key'] = key;        // preserve citekey for round-trip

    // Defect 4: assign stable id via itemIdMap
    // Non-Zotero entries use the citation key string as the ID so it
    // cannot collide with any Zotero library item (Zotero uses numeric
    // IDs internally). Zotero-linked entries keep sequential numeric IDs
    // since Zotero resolves them by URI, not numeric ID.
    if (itemIdMap) {
      let itemId = itemIdMap.get(key);
      if (itemId === undefined) {
        if (entry.zoteroUri) {
          itemId = itemIdMap.size + 1;
        } else {
          itemId = key;
        }
        itemIdMap.set(key, itemId);
      }
      itemData.id = itemId;
    }

    const citationItem: CiteprocCitationItem = { id: itemData.id, itemData };
    if (fieldSuppressAuthorKeys?.has(key)) {
      citationItem['suppress-author'] = true;
    }
    if (entry.zoteroUri) {
      citationItem.uris = [entry.zoteroUri];
    } else {
      // Invariant: non-Zotero entries still need a synthetic uris array
      // so Zotero's loadItemData() path doesn't crash on uris.length. Use the
      // embedded/local URI shape to force graceful fallback to embedded itemData.
      citationItem.uris = ['http://zotero.org/users/local/embedded/items/' + key];
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
  const citationId = generateCitationId(usedCitationIds);
  const cslCitation = {
    citationID: citationId,                                             // Defect 1
    properties: {
      formattedCitation: visibleText,                                   // Defect 2
      plainCitation: stripHtmlTags(visibleText),                        // Defect 2
      noteIndex: 0,
      ...(fieldNarrative ? { mode: 'composite' as const } : {}),
    },
    citationItems,
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json',
  };
  const json = JSON.stringify(cslCitation);

  const xml = (literalAuthorPrefix ? htmlToOoxmlRuns(literalAuthorPrefix, extraRPr) : '') +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + escapeXml(json) + ' </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    htmlToOoxmlRuns(visibleText, extraRPr) +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const narrativeOrigin = narrative && literalAuthorPrefix && keys.length === 1
    ? { citationId, citationKey: keys[0], literalPrefix: literalAuthorPrefix }
    : undefined;
  return { xml, ...(narrativeOrigin ? { narrativeOrigin } : {}) };
}

export function generateCitation(
  run: { keys?: string[]; locators?: Map<string, string>; text: string; suppressAuthorKeys?: Set<string>; narrative?: boolean },
  entries: Map<string, BibtexEntry>,
  citeprocEngine?: CiteprocEngine,
  usedCitationIds?: Set<string>,
  itemIdMap?: Map<string, string | number>,
  extraRPr?: string
): CitationResult {
  const rPrOpen = extraRPr ? '<w:rPr>' + extraRPr + '</w:rPr>' : '';
  if (!run.keys || run.keys.length === 0) {
    return { xml: '<w:r>' + rPrOpen + '<w:t>[@' + escapeXml(run.text) + ']</w:t></w:r>' };
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
    return buildCitationFieldCode(resolvedKeys, entries, run.locators, citeprocEngine, undefined, usedCitationIds, itemIdMap, run.suppressAuthorKeys, extraRPr, run.narrative);
  }

  const missingText = run.narrative
    ? '@' + missingKeys[0]
    : '[' + missingKeys.map(k => (run.suppressAuthorKeys?.has(k) ? '-@' : '@') + k).join('; ') + ']';

  // Pure missing — emit @citekey references as plain text, preserving authored form.
  if (resolvedKeys.length === 0) {
    return {
      xml: '<w:r>' + rPrOpen + '<w:t>' + escapeXml(missingText) + '</w:t></w:r>',
      warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      missingKeys
    };
  }

  // Mixed (some resolved, some missing) — resolved get field code, missing get plain text
  const field = buildCitationFieldCode(resolvedKeys, entries, run.locators, citeprocEngine, undefined, usedCitationIds, itemIdMap, run.suppressAuthorKeys, extraRPr, run.narrative);
  const xml = field.xml +
    '<w:r>' + rPrOpen + '<w:t xml:space="preserve"> </w:t></w:r>' +
    '<w:r>' + rPrOpen + '<w:t>' + escapeXml(missingText) + '</w:t></w:r>';

  return {
    xml,
    warning: warnings.join('; '),
    missingKeys,
    ...(field.narrativeOrigin ? { narrativeOrigin: field.narrativeOrigin } : {}),
  };
}

export function buildItemData(entry: BibtexEntry): CiteprocItemData {
  const itemData: CiteprocItemData = {
    type: mapBibtexTypeToCSL(entry.type)
  };

  const lowerType = entry.type.toLowerCase();
  if (lowerType === 'mastersthesis') itemData.genre = "Master's thesis";
  else if (lowerType === 'phdthesis') itemData.genre = "PhD thesis";

  const title = entry.fields.get('title');
  if (title) itemData.title = title;

  const author = entry.fields.get('author');
  const institution = entry.fields.get('institution');
  if (author) {
    itemData.author = parseAuthors(author);
  } else if (institution) {
    // Fallback for entries (commonly @techreport) that credit an organization
    // via `institution` instead of `author`; map to CSL literal name form.
    itemData.author = [{ literal: institution }];
  }
  // Preserve institution in a custom field for techreport roundtrip fidelity.
  if (institution && entry.type.toLowerCase() === 'techreport') {
    itemData['x-institution'] = institution;
  }

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

export function parseAuthors(authorString: string): CiteprocName[] {
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

function displayAuthorName(author: string): string {
  const firstAuthor = splitAuthorString(author)[0] || author.trim();
  if (firstAuthor.startsWith('{') && firstAuthor.endsWith('}')) {
    return firstAuthor.slice(1, -1);
  }
  const commaPos = firstAuthor.indexOf(',');
  return commaPos !== -1
    ? firstAuthor.slice(0, commaPos).trim()
    : firstAuthor.split(' ').pop() || firstAuthor;
}

export function generateNarrativeAuthorText(
  key: string,
  entries: Map<string, BibtexEntry>,
): string {
  const entry = entries.get(key);
  if (!entry) return '@' + key;

  const author = entry.fields.get('author');
  const institution = entry.fields.get('institution');
  if (!author) return institution || key;
  return displayAuthorName(author);
}

export function generateNarrativeFallbackText(
  key: string,
  entries: Map<string, BibtexEntry>,
  locator?: string,
): string {
  const entry = entries.get(key);
  if (!entry) return '@' + key;

  const name = generateNarrativeAuthorText(key, entries);
  const year = entry.fields.get('year');
  let text = name + (year ? ' (' + year + ')' : '');
  if (locator) text += ', ' + locator;
  return text;
}

export function generateFallbackText(keys: string[], entries: Map<string, BibtexEntry>, locators?: Map<string, string>, suppressAuthorKeys?: Set<string>): string {
  const parts = keys.map(key => {
    const entry = entries.get(key);
    if (!entry) return key;

    const author = entry.fields.get('author');
    const year = entry.fields.get('year');
    const keySuppressed = suppressAuthorKeys?.has(key);

    let text: string;
    if (!keySuppressed && author) {
      text = displayAuthorName(author);
    } else if (keySuppressed) {
      // suppress-author: year only, no author name
      text = '';
    } else {
      // Prefer institution over raw citekey for display text (mirrors buildItemData fallback).
      const institution = entry.fields.get('institution');
      text = institution || key;
    }

    if (year) text += (text ? ' ' : '') + year;

    const locator = locators?.get(key);
    if (locator) text += ', ' + locator;

    return text;
  });

  return '(' + parts.join('; ') + ')';
}

function deduplicateUnknown(values: unknown): unknown[] {
  const result: unknown[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(values) ? values : []) {
    let key: string;
    try {
      key = typeof value + ':' + JSON.stringify(value);
    } catch {
      key = typeof value + ':' + String(value);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uncitedUri(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function mergeZoteroBibliographyData(
  biblData: { uncited?: unknown[]; omitted?: unknown[]; custom?: unknown[] } | undefined,
  nociteUris: readonly string[],
): { uncited: unknown[]; omitted: unknown[]; custom: unknown[] } {
  const uncited = deduplicateUnknown(biblData?.uncited);
  const omitted = deduplicateUnknown(biblData?.omitted);
  const custom = deduplicateUnknown(biblData?.custom);
  const seenUris = new Set(uncited.map(uncitedUri).filter((uri): uri is string => uri !== undefined));
  for (const uri of nociteUris) {
    if (seenUris.has(uri)) continue;
    seenUris.add(uri);
    uncited.push([uri]);
  }
  return { uncited, omitted, custom };
}

/**
 * Generate OOXML for a ZOTERO_BIBL field code with rendered bibliography.
 */
export function generateBibliographyXml(
  citeprocEngine: CiteprocEngine,
  biblData?: { uncited?: unknown[]; omitted?: unknown[]; custom?: unknown[] },
  hangingIndent?: boolean
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
        const bibPPr = hangingIndent !== false ? '<w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>' : '';
        bibParagraphs += '<w:p>' + bibPPr + htmlToOoxmlRuns(trimmed) + '</w:p>';
      }
    }
  }

  // Wrap in field code.
  // Field-begin and field-end wrapper paragraphs use single spacing with zero
  // before/after to prevent them from rendering as visible blank lines when the
  // document uses non-single line spacing (the instrText is hidden in normal
  // view but the paragraph break still occupies vertical space).
  const fieldPPr = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';
  return '<w:p>' + fieldPPr + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL ' + escapeXml(biblPayload) + ' CSL_BIBLIOGRAPHY </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>' +
    bibParagraphs +
    '<w:p>' + fieldPPr + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
}

export function generateMathXml(latex: string, display: boolean): string {
  const omml = latexToOmml(latex);

  if (display) {
    return '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>';
  } else {
    return '<m:oMath>' + omml + '</m:oMath>';
  }
}
