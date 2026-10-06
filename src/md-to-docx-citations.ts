import { BibtexEntry } from './bibtex-parser';
import { latexToOmml, trackedLatexToOmml, CRITIC_DELETION_COMMAND, CRITIC_INSERTION_COMMAND, type TrackChange } from './latex-to-omml';
import type { CriticMathPart } from './critic-math';
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
  accessed?: { 'date-parts': number[][] };
  'container-title'?: string;
  'container-title-short'?: string;
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
  prefix?: string;
  itemData?: CiteprocItemData;
  uris?: string[];
}

interface CiteprocBibliographyMeta {
  bibstart?: string;
  bibend?: string;
}

export interface CiteprocEngine {
  makeCitationCluster(items: CiteprocCitationItem[]): string;
  makeBibliography(): [CiteprocBibliographyMeta, string[]] | false | null;
  updateItems(ids: string[]): unknown;
  /** citeproc-js internal: the style's in-cluster sort keys. makeCitationCluster
   *  sorts whenever these are non-empty; it has no "unsorted" option. */
  citation_sort?: { tokens: unknown[] };
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

export interface CitationResult {
  xml: string;
  warning?: string;
  missingKeys?: string[];
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

/** Text as `w:t` (or `w:delText`) elements. A tab becomes the `<w:tab/>`
 *  element Word writes for it, since Word shows a tab inside `w:t` as a space. */
const RUN_CHARACTER_ELEMENTS: Array<[string, string]> = [
  ['\t', '<w:tab/>'], ['\u2011', '<w:noBreakHyphen/>'], ['\u00AD', '<w:softHyphen/>'],
];

export function textElements(text: string, tag: 'w:t' | 'w:delText' = 'w:t'): string {
  // A tab, non-breaking hyphen or optional hyphen as Word's element for it
  for (const [character, element] of RUN_CHARACTER_ELEMENTS) {
    if (text.includes(character)) return text.split(character).map(part => part ? textElements(part, tag) : '').join(element);
  }
  const escaped = escapeXmlText(text);
  const preserve = escaped.length > 0 && (escaped[0] === ' ' || escaped[escaped.length - 1] === ' ');
  return '<' + tag + (preserve ? ' xml:space="preserve"' : '') + '>' + escaped + '</' + tag + '>';
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

/** CT_RPr's children in schema order. */
const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs',
  'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
];

/**
 * Run properties, empty elements such as `<w:b/>`, in schema order, so ones
 * composed from several sources (a citation's style, a highlight, a table's
 * font) don't make Word reorder them on open and mark the document modified.
 * Anything else comes back as it was.
 */
export function orderRPr(children: string): string {
  const elements = children.match(/<w:[A-Za-z]+(?:\s[^>]*)?\/>/g) ?? [];
  const rank = (element: string) => RPR_ORDER.indexOf(element.slice(3).split(/[\s/]/)[0]);
  if (elements.join('') !== children || elements.some(element => rank(element) < 0)) return children;
  return elements.sort((a, b) => rank(a) - rank(b)).join('');
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

    const rPrXml = rPr.length > 0 ? '<w:rPr>' + orderRPr(rPr.join('')) + '</w:rPr>' : '';
    return '<w:r>' + rPrXml + textElements(decodeHtmlEntities(run.text)) + '</w:r>';
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
  prefixes?: string[]
): string | undefined {
  if (!engine || !CSL) return undefined;

  // Like Pandoc, keep a cluster with prefixes in written order so a leading
  // "e.g.," stays in front; the field code sets properties.unsorted to match.
  const sort = prefixes?.some(Boolean) ? engine.citation_sort : undefined;
  const sortTokens = sort?.tokens;
  try {
    const rawList = keys.map((key, i) => {
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
      const prefix = prefixes?.[i];
      if (prefix) item.prefix = prefix;
      return item;
    });

    if (sort) sort.tokens = [];
    return engine.makeCitationCluster(rawList) as string;
  } catch {
    return undefined;
  } finally {
    if (sort && sortTokens) sort.tokens = sortTokens;
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

/** A key's or locator's text as Word shows it, where a line end in it,
 *  and the spaces around it, is a space */
function oneLine(text: string): string {
  return text.split('\n').map(line => line.trim()).join(' ');
}

/**
 * Generate OOXML paragraphs for missing citation keys, to appear after the bibliography.
 * A key's line ends are spaces, as Word shows them, so each paragraph is one
 * line, which export finds to strip (see MISSING_KEY_LINE).
 */
export function generateMissingKeysXml(missingKeys: string[]): string {
  return missingKeys.map(key =>
    '<w:p><w:r><w:t xml:space="preserve">Citation data for @' + escapeXml(oneLine(key)) +
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
  prefixes?: string[]
): string {
  if (citeprocEngine) {
    const rendered = renderCitationText(citeprocEngine, keys, locators, suppressAuthorKeys, prefixes);
    if (rendered) return rendered;
  }
  return generateFallbackText(keys, entries, locators, suppressAuthorKeys, prefixes);
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
  prefixes?: string[],
  extraRPr?: string
): string {
  // Resolve visible text first so we can populate properties (Defect 2)
  // Note: visibleTextOverride bypasses suppressAuthorKeys processing — callers
  // should not provide both, as the override text would include the author
  // while the CSL item has suppress-author set to true.
  const visibleText = visibleTextOverride ?? resolveVisibleText(keys, entries, locators, citeprocEngine, suppressAuthorKeys, prefixes);

  const citationItems: CiteprocCitationItem[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
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
    if (suppressAuthorKeys?.has(key)) {
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
    const prefix = prefixes?.[i];
    if (prefix) citationItem.prefix = prefix;
    citationItems.push(citationItem);
  }

  // Defect 3: key ordering — citationID, properties, citationItems, schema
  const cslCitation = {
    citationID: generateCitationId(usedCitationIds),                    // Defect 1
    properties: {
      formattedCitation: visibleText,                                   // Defect 2
      plainCitation: stripHtmlTags(visibleText),                        // Defect 2
      noteIndex: 0,
      // Zotero's "Keep Sources Sorted" off, matching renderCitationText
      ...(citationItems.some(item => item.prefix) ? { unsorted: true } : {}),
    },
    citationItems,
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json',
  };
  const json = JSON.stringify(cslCitation);

  return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + escapeXml(json) + ' </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    htmlToOoxmlRuns(visibleText, extraRPr) +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
}

/** A citation's XML: a field for the keys the bibliography has, with
 *  `extraRPr`, and its text for those it hasn't, with `textRPr`, the whole
 *  rPr of the formatting around it, which Word shows on text as on any
 *  other, and import reads back. */
export function generateCitation(
  run: { keys?: string[]; locators?: Map<string, string>; text: string; suppressAuthorKeys?: Set<string>; prefixes?: string[] },
  entries: Map<string, BibtexEntry>,
  citeprocEngine?: CiteprocEngine,
  usedCitationIds?: Set<string>,
  itemIdMap?: Map<string, string | number>,
  extraRPr?: string,
  textRPr?: string
): CitationResult {
  const rPrOpen = textRPr ?? (extraRPr ? '<w:rPr>' + extraRPr + '</w:rPr>' : '');
  if (!run.keys || run.keys.length === 0) {
    return { xml: '<w:r>' + rPrOpen + textElements('[' + run.text + ']') + '</w:r>' };
  }

  // Classify items into resolved (have bib data) vs missing. Track positions
  // because prefixes are per occurrence, not per key.
  const keys = run.keys;
  const resolved: number[] = [];
  const missing: number[] = [];
  const warnings: string[] = [];

  keys.forEach((key, i) => {
    if (!entries.has(key)) {
      missing.push(i);
      warnings.push(`Citation key not found: ${key}`);
    } else {
      resolved.push(i);
    }
  });
  const resolvedKeys = resolved.map(i => keys[i]);
  const resolvedPrefixes = run.prefixes && resolved.map(i => run.prefixes![i]);
  const missingKeys = missing.map(i => keys[i]);

  // All resolved — emit field code (works for both Zotero and non-Zotero entries)
  if (resolvedKeys.length > 0 && missingKeys.length === 0) {
    const xml = buildCitationFieldCode(resolvedKeys, entries, run.locators, citeprocEngine, undefined, usedCitationIds, itemIdMap, run.suppressAuthorKeys, resolvedPrefixes, extraRPr);
    return { xml };
  }

  // A key's and locator's line ends as spaces, as Word shows them and the
  // key's note writes it, where import, which reads a line end in Word's
  // text as one, wouldn't read [@a<line end>b] as a citation
  const missingText = '[' + missing.map(i => {
    const key = keys[i];
    const prefix = run.prefixes?.[i];
    const locator = run.locators?.get(key);
    return (prefix ? prefix + ' ' : '') + (run.suppressAuthorKeys?.has(key) ? '-@' : '@') + oneLine(key) + (locator ? ', ' + oneLine(locator) : '');
  }).join('; ') + ']';

  // Pure missing — emit @citekey references as plain text, preserving bracket format
  if (resolvedKeys.length === 0) {
    return {
      xml: '<w:r>' + rPrOpen + textElements(missingText) + '</w:r>',
      warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      missingKeys
    };
  }

  // Mixed (some resolved, some missing) — resolved get field code, missing get plain text
  const xml = buildCitationFieldCode(resolvedKeys, entries, run.locators, citeprocEngine, undefined, usedCitationIds, itemIdMap, run.suppressAuthorKeys, resolvedPrefixes, extraRPr) +
    '<w:r>' + rPrOpen + '<w:t xml:space="preserve"> </w:t></w:r>' +
    '<w:r>' + rPrOpen + textElements(missingText) + '</w:r>';

  return {
    xml,
    warning: warnings.join('; '),
    missingKeys
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
  const containerTitle = entry.fields.get('container-title');
  if (journal || containerTitle) itemData['container-title'] = journal ?? containerTitle;

  const containerTitleShort = entry.fields.get('container-title-short');
  if (containerTitleShort) itemData['container-title-short'] = containerTitleShort;

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

  const accessed = entry.fields.get('accessed');
  const accessedMatch = accessed?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (accessedMatch) {
    itemData.accessed = {
      'date-parts': [[
        parseInt(accessedMatch[1], 10),
        parseInt(accessedMatch[2], 10),
        parseInt(accessedMatch[3], 10),
      ]],
    };
  }

  const isbn = entry.fields.get('isbn');
  if (isbn) itemData.ISBN = isbn;

  const issn = entry.fields.get('issn');
  if (issn) itemData.ISSN = issn;

  const number = entry.fields.get('number');
  if (number) itemData.issue = number;

  const edition = entry.fields.get('edition');
  if (edition) itemData.edition = edition;

  // booktitle → container-title, but only if no explicit container was set
  const booktitle = entry.fields.get('booktitle');
  if (booktitle && !itemData['container-title']) itemData['container-title'] = booktitle;

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
    case 'webpage': return 'webpage';
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

export function generateFallbackText(keys: string[], entries: Map<string, BibtexEntry>, locators?: Map<string, string>, suppressAuthorKeys?: Set<string>, prefixes?: string[]): string {
  const parts = keys.map((key, i) => {
    const entry = entries.get(key);
    if (!entry) return key;

    const author = entry.fields.get('author');
    const year = entry.fields.get('year');
    const keySuppressed = suppressAuthorKeys?.has(key);

    let text: string;
    if (!keySuppressed && author) {
      const firstAuthor = splitAuthorString(author)[0] || author.trim();
      if (firstAuthor.startsWith('{') && firstAuthor.endsWith('}')) {
        // Institutional author — use the full name
        text = firstAuthor.slice(1, -1);
      } else {
        const commaPos = firstAuthor.indexOf(',');
        text = commaPos !== -1 ? firstAuthor.slice(0, commaPos).trim() : firstAuthor.split(' ').pop() || firstAuthor;
      }
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

    const prefix = prefixes?.[i];
    if (prefix) text = prefix + (text ? ' ' + text : '');

    return text;
  });

  return '(' + parts.join('; ') + ')';
}

/**
 * Generate OOXML for a ZOTERO_BIBL field code with rendered bibliography.
 * Without an engine, the field is empty, and marks the bibliography's place.
 */
export function generateBibliographyXml(
  citeprocEngine: CiteprocEngine | undefined,
  biblData?: { uncited?: unknown[]; omitted?: unknown[]; custom?: unknown[] },
  hangingIndent?: boolean
): string {
  const biblPayload = JSON.stringify({
    uncited: biblData?.uncited || [],
    omitted: biblData?.omitted || [],
    custom: biblData?.custom || [],
  });

  const bib = citeprocEngine && renderBibliography(citeprocEngine);

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

/**
 * The OMML for an equation. Each LaTeX command or environment with no OMML
 * form adds a warning to `warnings`; the converter drops duplicate warnings.
 */
function equationOmml(latex: string, warnings?: string[]): string {
  return latexToOmml(latex, unknownCommandWarning(warnings));
}

function unknownCommandWarning(warnings?: string[]): ((command: string) => void) | undefined {
  return warnings && (command => warnings.push(
    'Equation uses unsupported LaTeX "' + command + '"; Word shows it as literal text.',
  ));
}

const LATEX_OPENER: Record<string, string> = { '}': '{', '\\right': '\\left', '\\end': '\\begin' };
// What can open or close a structure, plus escapes and % comments, which can't
const LATEX_STRUCTURE_RE = /\\(?:left|right|begin|end)(?![a-zA-Z])|\\.|%[^\n]*|[{}]/g;

/** The private commands of trackedEquationLatex, as a user might also write them */
const PRIVATE_COMMAND_RE = /\\mmCritic(?:Ins|Del)(?![A-Za-z])/;

/** Whether `latex` closes every unescaped brace, \left and \begin it opens, in order, and opens every one it closes. */
function latexSelfContained(latex: string): boolean {
  const open: string[] = [];
  for (const [token] of latex.matchAll(LATEX_STRUCTURE_RE)) {
    if (token.startsWith('%')) continue;
    if (token === '{' || token === '\\left' || token === '\\begin') open.push(token);
    else if (LATEX_OPENER[token] !== undefined && open.pop() !== LATEX_OPENER[token]) return false;
  }
  return open.length === 0;
}

/** Whether `latex` ends in a % comment, which would take in what follows it. */
function endsInComment(latex: string): boolean {
  let last: RegExpMatchArray | undefined;
  for (const match of latex.matchAll(LATEX_STRUCTURE_RE)) last = match;
  return !!last && last[0].startsWith('%') && last.index! + last[0].length === latex.length;
}

/**
 * An equation with CriticMarkup inside as LaTeX in which each tracked span is
 * a private command (CRITIC_INSERTION_COMMAND, CRITIC_DELETION_COMMAND), so it
 * parses as one expression and a change inside a fraction or script stays in
 * it. With `untracked`, each span is a plain group instead, which shows every
 * part where it belongs. Undefined when a span opens a brace, \left or \begin
 * it doesn't close or closes one it doesn't open, as in {++a}{b++} or
 * {++\left(++}x\right), which no single expression can hold, or when the
 * LaTeX already uses the private commands' names.
 */
export function trackedEquationLatex(parts: CriticMathPart[], untracked = false): string | undefined {
  const contents = parts.flatMap(part => part.type === 'substitution' ? [part.oldContent, part.newContent] : [part.content]);
  if (contents.some(content => PRIVATE_COMMAND_RE.test(content))) return undefined;
  // A newline ends a comment that would otherwise take the closing brace
  const tracked = (command: string, latex: string) => latexSelfContained(latex)
    ? (untracked ? '' : command) + '{' + latex + (endsInComment(latex) ? '\n' : '') + '}'
    : undefined;
  let latex = '';
  for (const part of parts) {
    let piece: string | undefined;
    if (part.type === 'math') piece = part.content;
    else if (part.type === 'addition') piece = tracked(CRITIC_INSERTION_COMMAND, part.content);
    else if (part.type === 'deletion') piece = tracked(CRITIC_DELETION_COMMAND, part.content);
    else if (part.type === 'substitution') {
      const oldLatex = tracked(CRITIC_DELETION_COMMAND, part.oldContent);
      const newLatex = tracked(CRITIC_INSERTION_COMMAND, part.newContent);
      piece = oldLatex !== undefined && newLatex !== undefined ? oldLatex + newLatex : undefined;
    }
    if (piece === undefined) return undefined;
    latex += (endsInComment(latex) ? '\n' : '') + piece;
  }
  return latex;
}

/** The LaTeX of an equation with CriticMarkup inside once every change is
 *  accepted, or rejected. */
function equationViewLatex(parts: CriticMathPart[], accepted: boolean): string {
  let latex = '';
  for (const part of parts) {
    const piece = part.type === 'math' ? part.content
      : part.type === 'substitution' ? (accepted ? part.newContent : part.oldContent)
        : part.type === (accepted ? 'addition' : 'deletion') ? part.content : '';
    // A newline ends a comment that would otherwise take what follows, and {}
    // a command that would otherwise run into a letter, as in {++\alpha++}x
    if (piece) latex += (endsInComment(latex) ? '\n' : /\\[A-Za-z]+$/.test(latex) && /^[A-Za-z]/.test(piece) ? '{}' : '') + piece;
  }
  return latex;
}

/** The OMML of one view of an equation (see equationViewLatex). LaTeX that's
 *  only whitespace, as {++ ++} accepted is, is a run of it, where
 *  equationOmml gives nothing, as for an empty equation. */
function equationViewOmml(latex: string, warnings?: string[]): string {
  return latex && !latex.trim() ? '<m:r><m:t>' + latex + '</m:t></m:r>' : equationOmml(latex, warnings);
}

/** `omml` with adjacent runs of the same properties joined, which Word shows
 *  the same way as one run. */
function joinedRuns(omml: string): string {
  const pair = /<m:r>((?:<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)?)<m:t>([^<]*)<\/m:t><\/m:r><m:r>\1<m:t>/g;
  let joined = omml.replace(/ xml:space="preserve"/g, '');
  for (let previous = ''; joined !== previous;) {
    previous = joined;
    joined = joined.replace(pair, (_match, props: string, text: string) => '<m:r>' + props + '<m:t>' + text);
  }
  return joined;
}

/**
 * Whether tracking the changes in `latex` (see trackedEquationLatex) in place
 * gives what Accept All and Reject All should: the equation with every change
 * accepted, and rejected. Word tracks runs, so a span that holds syntax
 * rather than math doesn't, as in a{++&++}b in a matrix, x{++^2++},
 * \sum{++\limits++} or {++\frac++}{1}{2}.
 */
function tracksInPlace(latex: string, parts: CriticMathPart[]): boolean {
  const omml = trackedLatexToOmml(latex, (element, content) => '<' + element + '>' + content + '</' + element + '>');
  const view = (accepted: boolean) => {
    const [keep, drop] = accepted ? ['w:ins', 'w:del'] : ['w:del', 'w:ins'];
    return omml.replace(new RegExp('<' + drop + '>[\\s\\S]*?</' + drop + '>', 'g'), '').replace(new RegExp('</?' + keep + '>', 'g'), '');
  };
  return [true, false].every(accepted => joinedRuns(view(accepted)) === joinedRuns(equationViewOmml(equationViewLatex(parts, accepted))));
}

/**
 * An equation with CriticMarkup inside, as Word records an edit to an
 * equation: one m:oMath with each changed part in w:ins or w:del. `track`
 * wraps a part's OMML in the revision element. When the changes can't be
 * tracked in place (see tracksInPlace), the equation is recorded as
 * replaced, as Word records an edit that changes a structure: the deleted
 * equation is what Reject All leaves, and the inserted one what Accept All
 * leaves.
 */
export function generateTrackedMathXml(parts: CriticMathPart[], track: TrackChange, warnings?: string[], display = false): string {
  const equation = (omml: string) => display ? '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>' : '<m:oMath>' + omml + '</m:oMath>';
  const latex = trackedEquationLatex(parts);
  if (latex !== undefined && tracksInPlace(latex, parts)) {
    return equation(trackedLatexToOmml(latex, track, unknownCommandWarning(warnings)));
  }
  const view = (accepted: boolean) => {
    const omml = equationViewOmml(equationViewLatex(parts, accepted), warnings);
    return omml ? track(accepted ? 'w:ins' : 'w:del', omml) : '';
  };
  return equation(view(false) + view(true));
}

/** Generate an equation, warning as equationOmml does. */
export function generateMathXml(latex: string, display: boolean, warnings?: string[]): string {
  const omml = equationOmml(latex, warnings);

  if (display) {
    return '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>';
  } else {
    return '<m:oMath>' + omml + '</m:oMath>';
  }
}
