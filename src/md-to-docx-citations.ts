import { BibtexEntry, bibtexGroupsAsText, bibtexTexAsText } from './bibtex-parser';
import { latexToOmml, trackedLatexToOmml, CRITIC_DELETION_COMMAND, CRITIC_HIGHLIGHT_COMMAND, CRITIC_INSERTION_COMMAND, MATH_HIGHLIGHT_RPR, withEquationEscapes, withWordBackslashes, type TrackChange } from './latex-to-omml';
import type { CriticMathPart } from './critic-math';
import { loadStyle, loadStyleAsync, loadLocale } from './csl-loader';
import { decodeHtmlCharacterReferences } from './html-entities';

export interface CiteprocName {
  family?: string;
  given?: string;
  literal?: string;
  // BibTeX's von part, as pandoc reads it, which a style shows with the
  // given name where it inverts a name, as apa's Beethoven, L. van
  'dropping-particle'?: string;
  // BibTeX's Jr part
  suffix?: string;
  // Set where the reader read a particle or a suffix (see withNamesAsRead)
  'static-particles'?: boolean;
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

/** citeproc's HTML's text, as htmlToOoxmlRuns writes it, without its tags */
function stripHtmlTags(html: string): string {
  return decodeHtmlCharacterReferences(html.replace(/<[^>]+>/g, ''));
}

/** CT_RPr's children in schema order, the record of a tracked change to
 *  them last */
const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs',
  'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange',
];

/** CT_PPrBase's children in schema order, then those CT_PPr adds after
 *  them, the record of a tracked change to them last */
const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers',
  'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct',
  'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing',
  'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl',
  'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
];

// A comment, a CDATA section or a processing instruction, whose text may
// look like tags, or else a start, end or empty tag, its attributes in
// either quotes
const XML_TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/g;

/** The elements `xml` holds at its top level, whatever they hold, each
 *  with where it ends, and a comment, CDATA section or processing
 *  instruction there as one of them; or undefined where there's other text,
 *  or a tag left open, among them */
function topLevelElements(xml: string): Array<{ end: number; element: string }> | undefined {
  const elements: Array<{ end: number; element: string }> = [];
  const open: string[] = [];
  let start = 0;
  let at = 0;
  for (const match of xml.matchAll(XML_TAG_RE)) {
    const between = xml.slice(at, match.index);
    if (between.includes('<') || (open.length === 0 && !/^[ \t\r\n]*$/.test(between))) return undefined;
    const [tag, close, name, empty] = match;
    if (open.length === 0) start = match.index;
    if (name === undefined) {
      // Not markup, which goes with what holds it
    } else if (close) {
      if (empty || open.pop() !== name) return undefined;
    } else if (!empty) {
      open.push(name);
    }
    at = match.index + tag.length;
    if (open.length === 0) elements.push({ end: at, element: xml.slice(start, at) });
  }
  return open.length === 0 && /^[ \t\r\n]*$/.test(xml.slice(at)) ? elements : undefined;
}

/**
 * Properties' elements, `children`, in the schema order `order` gives them,
 * so ones composed from several sources don't make Word reorder them on open
 * and mark the document modified. An element may hold others, as a tracked
 * change's record does, and goes with the whitespace before it, so each
 * keeps its line where Word wrote them on lines of their own. One the order
 * doesn't know, as one of another namespace, stays in its place, and the
 * others go in order around it, as does a comment, a CDATA section or a
 * processing instruction among them, which Word doesn't write there. Text
 * among them leaves them as they were, and so do elements in order already.
 */
function inSchemaOrder(children: string, order: readonly string[]): string {
  const elements = topLevelElements(children);
  if (elements === undefined) return children;
  const rank = (element: string) => order.indexOf(/^<w:([A-Za-z]+)[\s/>]/.exec(element)?.[1] ?? '');
  // Each element with the whitespace before it
  const units = elements.map(({ end, element }, index) => ({ xml: children.slice(index === 0 ? 0 : elements[index - 1].end, end), rank: rank(element) }));
  const ordered = units.filter(unit => unit.rank >= 0).sort((a, b) => a.rank - b.rank);
  let next = 0;
  return units.map(unit => unit.rank >= 0 ? ordered[next++].xml : unit.xml).join('') + children.slice(elements.length > 0 ? elements[elements.length - 1].end : 0);
}

/** Run properties in schema order (see inSchemaOrder), as ones composed of a
 *  citation's style, a highlight, a table's font or what a template's style
 *  has */
export function orderRPr(children: string): string {
  return inSchemaOrder(children, RPR_ORDER);
}

/** Paragraph properties in schema order (see inSchemaOrder), as a template
 *  style's with what export adds to them */
export function orderPPr(children: string): string {
  return inSchemaOrder(children, PPR_ORDER);
}

/** The formatting citeproc's HTML sets, as htmlToOoxmlRuns writes it */
interface HtmlRunFormat {
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  smallCaps?: boolean;
  vertAlign?: 'superscript' | 'subscript' | 'baseline';
}

// The elements citeproc writes for formatting (CSL.Output.Formats.html):
// <em> is oblique, and the rest it writes as a span's style
const HTML_ELEMENT_FORMATS: Readonly<Record<string, HtmlRunFormat>> = {
  i: { italic: true }, em: { italic: true }, b: { bold: true },
  sup: { vertAlign: 'superscript' }, sub: { vertAlign: 'subscript' },
};

/** What a span's style sets: a declaration citeproc writes, as
 *  `font-style:normal;`, which turns off the italic of an element around
 *  it, or `baseline` alone, which it writes for vertical-align="baseline" */
function spanFormat(attrs: string): HtmlRunFormat {
  const format: HtmlRunFormat = {};
  const style = /\bstyle\s*=\s*"([^"]*)"/i.exec(attrs);
  for (const declaration of (style?.[1] ?? '').split(';')) {
    const [property, value = ''] = declaration.split(':').map(part => part.trim().toLowerCase());
    if (property === 'baseline' && !value) format.vertAlign = 'baseline';
    else if (property === 'font-style') format.italic = value === 'italic' || value === 'oblique';
    else if (property === 'font-weight') format.bold = value === 'bold';
    else if (property === 'font-variant') format.smallCaps = value === 'small-caps';
    else if (property === 'text-decoration') format.underline = value === 'underline';
  }
  return format;
}

/**
 * Convert citeproc HTML output (e.g. `<i>1</i>`) to OOXML runs with
 * proper formatting: that of `<i>`, `<em>`, `<b>`, `<sup>`, `<sub>`, and a
 * `<span>`'s style, small caps, underline, and the `:normal`, `none` and
 * `baseline` ones, each of which turns off for what it holds what an
 * element around it turned on, as in an italic title within an italic one,
 * and `<br>`, as Word's line break.
 */
export function htmlToOoxmlRuns(html: string, extraRPr?: string): string {
  const runs: { text: string; format: HtmlRunFormat; lineBreak?: true }[] = [];
  // The elements open, each with what it sets, the inner over the outer
  const open: { name: string; format: HtmlRunFormat }[] = [];
  const format = (): HtmlRunFormat => {
    const merged: HtmlRunFormat = {};
    for (const element of open) Object.assign(merged, element.format);
    return merged;
  };

  let pos = 0;
  let currentText = '';

  while (pos < html.length) {
    if (html[pos] === '<') {
      if (currentText) {
        runs.push({ text: currentText, format: format() });
        currentText = '';
      }

      const tagEnd = html.indexOf('>', pos);
      if (tagEnd === -1) {
        currentText += html.slice(pos);
        break;
      }

      const tag = /^(\/?)([A-Za-z][\w-]*)([\s\S]*)$/.exec(html.slice(pos + 1, tagEnd).trim());
      if (tag) {
        const name = tag[2].toLowerCase();
        // A line break, an element with no end, which sets nothing
        if (name === 'br' && !tag[1] && /^\s*\/?$/.test(tag[3])) {
          runs.push({ text: '', format: {}, lineBreak: true });
        } else if (tag[1]) {
          // The end of the last element of that name, and of any left open in it
          const at = open.map(element => element.name).lastIndexOf(name);
          if (at >= 0) open.length = at;
        } else if (!tag[3].endsWith('/')) {
          open.push({ name, format: name === 'span' ? spanFormat(tag[3]) : HTML_ELEMENT_FORMATS[name] ?? {} });
        }
      }

      pos = tagEnd + 1;
    } else {
      currentText += html[pos];
      pos++;
    }
  }

  if (currentText) {
    runs.push({ text: currentText, format: format() });
  }

  return runs.map(({ text, format: run, lineBreak }) => {
    if (lineBreak) return '<w:r><w:br/></w:r>';
    const rPr: string[] = [];
    if (run.italic) rPr.push('<w:i/>');
    if (run.bold) rPr.push('<w:b/>');
    if (run.underline) rPr.push('<w:u w:val="single"/>');
    if (run.vertAlign === 'superscript' || run.vertAlign === 'subscript') rPr.push('<w:vertAlign w:val="' + run.vertAlign + '"/>');
    if (run.smallCaps) rPr.push('<w:smallCaps/>');
    if (extraRPr) rPr.push(extraRPr);

    const rPrXml = rPr.length > 0 ? '<w:rPr>' + orderRPr(rPr.join('')) + '</w:rPr>' : '';
    // Each character reference read once, as the browser reads citeproc's
    // HTML, so the &#38;lt; it writes for a title's &lt; is that text, not <
    return '<w:r>' + rPrXml + textElements(decodeHtmlCharacterReferences(text)) + '</w:r>';
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

/** An item's data as citeproc gets it, with each name the reader read a
 *  particle or a suffix in marked so citeproc doesn't read its particles
 *  again: it would take a lowercase word at the end of the given name for
 *  a dropping particle, as paul in de Smith, John paul, in place of de. A
 *  name with neither keeps citeproc's reading, which splits a family name a
 *  group kept whole, as {van Gogh}, into its particle and the rest. */
function withNamesAsRead(item: CiteprocItemData): CiteprocItemData {
  const asRead = (names: CiteprocName[]) => names.map(name => name['dropping-particle'] || name.suffix ? { ...name, 'static-particles': true } : name);
  const read = { ...item };
  if (item.author) read.author = asRead(item.author);
  if (item.editor) read.editor = asRead(item.editor);
  return read;
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
    const itemData = withNamesAsRead(buildItemData(entry));
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
  // With no xml:space, which the text, starting and ending with no space,
  // needs none of, and Word strips (dirty-flag invariant #1)
  return missingKeys.map(key =>
    '<w:p><w:r><w:t>Citation data for @' + escapeXml(oneLine(key)) +
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
  // As HTML, as citeproc writes its text, which htmlToOoxmlRuns reads, so
  // the source's text shows as it is written there too
  return escapeXmlText(generateFallbackText(keys, entries, locators, suppressAuthorKeys, prefixes));
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
    // As citeproc gets it here, for Zotero's, where it refreshes the field
    const itemData = withNamesAsRead(buildItemData(entry));
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

// citeproc's own field in a note, which it reads there, to the first }
const CITEPROC_NOTE_FIELD = /\{:(?:[-_a-z]+|[A-Z]+):[^}]+\}/;
// The fields citeproc reads as numbers
const NUMBER_FIELDS: ReadonlySet<string> = new Set(['volume', 'pages', 'number', 'edition']);

/** A BibTeX field's text as citeproc's data holds it, with its groups'
 *  braces off, which keep its case in BibTeX, as citeproc's nocase, which a
 *  style that changes the case, as a title's or a publisher's first letter,
 *  keeps; citeproc showed the braces. In a field citeproc reads as a number,
 *  as volume, or where `plain`, as a name, as their text. A value with no
 *  TeX, or one whose text has changed since it was read, as it is, and so a
 *  note with citeproc's own field in braces, as {:original-date: 1850}, as a
 *  span would hide it (see bibtexGroupsAsText). */
export function citeprocFieldText(entry: BibtexEntry, field: string, plain = NUMBER_FIELDS.has(field)): string | undefined {
  const value = entry.fields.get(field);
  const tex = entry.texFields?.get(field);
  if (value === undefined || tex === undefined || bibtexTexAsText(tex) !== value) return value;
  if (field === 'note' && CITEPROC_NOTE_FIELD.test(tex)) return value;
  return plain ? bibtexGroupsAsText(tex) : bibtexGroupsAsText(tex, '<span class="nocase">', '</span>');
}

export function buildItemData(entry: BibtexEntry): CiteprocItemData {
  const itemData: CiteprocItemData = {
    type: mapBibtexTypeToCSL(entry.type)
  };
  const text = (field: string) => citeprocFieldText(entry, field);

  const lowerType = entry.type.toLowerCase();
  if (lowerType === 'mastersthesis') itemData.genre = "Master's thesis";
  else if (lowerType === 'phdthesis') itemData.genre = "PhD thesis";

  const title = text('title');
  if (title) itemData.title = title;

  const author = entry.fields.get('author');
  const institution = text('institution');
  if (author) {
    itemData.author = parseAuthors(author);
  } else if (institution) {
    // Fallback for entries (commonly @techreport) that credit an organization
    // via `institution` instead of `author`; map to CSL literal name form.
    itemData.author = [{ literal: citeprocFieldText(entry, 'institution', true)! }];
  }
  // Preserve institution in a custom field for techreport roundtrip fidelity.
  if (institution && entry.type.toLowerCase() === 'techreport') {
    itemData['x-institution'] = institution;
  }

  const year = entry.fields.get('year');
  if (year && /^\d+$/.test(year)) {
    itemData.issued = { 'date-parts': [[parseInt(year, 10)]] };
  }

  const journal = text('journal');
  const containerTitle = text('container-title');
  if (journal || containerTitle) itemData['container-title'] = journal ?? containerTitle;

  const containerTitleShort = text('container-title-short');
  if (containerTitleShort) itemData['container-title-short'] = containerTitleShort;

  const volume = text('volume');
  if (volume) itemData.volume = volume;

  const pages = text('pages');
  if (pages) itemData.page = pages;

  const doi = entry.fields.get('doi');
  if (doi) itemData.DOI = doi;

  // Editor (parsed like authors, supports institutional editors)
  const editor = entry.fields.get('editor');
  if (editor) itemData.editor = parseAuthors(editor);

  const publisher = text('publisher');
  if (publisher) itemData.publisher = publisher;

  const address = text('address');
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

  const number = text('number');
  if (number) itemData.issue = number;

  const edition = text('edition');
  if (edition) itemData.edition = edition;

  // booktitle → container-title, but only if no explicit container was set
  const booktitle = text('booktitle');
  if (booktitle && !itemData['container-title']) itemData['container-title'] = booktitle;

  const abstract_ = text('abstract');
  if (abstract_) itemData.abstract = abstract_;

  const note = text('note');
  if (note) itemData.note = note;

  const series = text('series');
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

// Where BibTeX splits a name: at a comma, and into its words at whitespace
// or a hyphen, one character at a time, but not at a no-break space
const NAME_COMMA = /,/y;
const NAME_WORD_BREAK = /[ \t\n\r\f-]/y;

/** `name` split where `at` matches outside its groups, as BibTeX splits a
 *  name, so a group is one word. Like BibTeX, it counts every brace, one a
 *  backslash escapes too, which the parsed value holds as a brace. */
function splitOutsideGroups(name: string, at: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '{') depth++;
    else if (name[i] === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      at.lastIndex = i;
      const match = at.exec(name);
      if (!match) continue;
      parts.push(name.slice(start, i));
      start = i + match[0].length;
      i = start - 1;
    }
  }
  parts.push(name.slice(start));
  return parts;
}

/** Whether `name` is one group from end to end, as {World Health
 *  Organization}, which BibTeX reads as a last name of one word, and
 *  citeproc takes as an organization's, a literal */
function isOneGroup(name: string): boolean {
  if (!name.startsWith('{')) return false;
  let depth = 0;
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '{') depth++;
    else if (name[i] === '}' && --depth === 0) return i === name.length - 1;
  }
  return false;
}

/** A part of a name, its given or family name, as BibTeX's output shows
 *  it: its groups without their braces. A part that holds a command, a \
 *  anywhere, as \textsc{Smith} or {\sc Doe}, keeps every brace as written,
 *  since reading a command's arguments is a later step's */
function namePartAsShown(part: string): string {
  let shown = part;
  if (!part.includes('\\')) {
    const dropped = new Set<number>();
    const open: number[] = [];
    for (let i = 0; i < part.length; i++) {
      if (part[i] === '{') open.push(i);
      else if (part[i] === '}') {
        const at = open.pop();
        if (at === undefined) continue;
        dropped.add(at);
        dropped.add(i);
      }
    }
    shown = '';
    for (let i = 0; i < part.length; i++) if (!dropped.has(i)) shown += part[i];
  }
  return shown.replace(/[ \t\n\r\f]+/g, ' ').trim();
}

/** A word of a name, and what came before it, a space or a hyphen */
interface NameWord { text: string; separator: string }

/** The words of a part of a name, outside its groups. Between two words
 *  BibTeX keeps the first of the characters between them (bibtex.web,
 *  "Name-process a sep_char"), so in John Smith -Jones a space comes
 *  before Jones, and in John Smith- Jones a hyphen */
function nameWords(part: string): NameWord[] {
  const words: NameWord[] = [];
  let between = '';
  let at = 0;
  for (const piece of splitOutsideGroups(part, NAME_WORD_BREAK)) {
    if (piece) {
      words.push({ text: piece, separator: between });
      between = '';
    }
    at += piece.length;
    const char = part[at++];
    if (char !== undefined && between === '') between = char === '-' ? '-' : ' ';
  }
  return words;
}

/** The words of a name as BibTeX joins them, each after what came before it */
const joinWords = (words: NameWord[]): string => words.map((word, k) => (k > 0 ? word.separator : '') + word.text).join('');

// The commands of letters whose case BibTeX's table gives: lowercase, as
// \ss, which starts a von part, or uppercase, as \O
const LOWERCASE_LETTER_COMMANDS: ReadonlySet<string> = new Set(['oe', 'ae', 'aa', 'o', 'l', 'i', 'j', 'ss']);
const UPPERCASE_LETTER_COMMANDS: ReadonlySet<string> = new Set(['OE', 'AE', 'AA', 'O', 'L']);

/** The index of the } that closes the group whose { is at `open` in
 *  `text`, counting every brace, as BibTeX does, or the text's length */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length;
}

/** Whether a word of a name starts BibTeX's von part, as van and de do:
 *  its first letter outside groups is lowercase (bibtex.web,
 *  von_token_found). A group, as {van}, has no case, so the letters after
 *  it decide, unless it starts with a command, as {\ss} or {\'e}, a
 *  special character, whose letter decides. The parser has read most
 *  accents as their letters already, as é. */
function isVonWord(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '{') {
      const end = groupEnd(word, i);
      if (word[i + 1] === '\\') {
        const command = /^[A-Za-z]*/.exec(word.slice(i + 2, end))![0];
        if (LOWERCASE_LETTER_COMMANDS.has(command)) return true;
        if (UPPERCASE_LETTER_COMMANDS.has(command)) return false;
        const letter = /\p{L}/u.exec(word.slice(i + 2 + command.length, end))?.[0];
        return letter !== undefined && /\p{Ll}/u.test(letter);
      }
      i = end;
    } else if (/\p{L}/u.test(word[i])) {
      return /\p{Ll}/u.test(word[i]);
    }
  }
  return false;
}

/** Where the von part of a name's `count` runs of words, from `start`,
 *  ends and its last part starts: after its last von run before the last */
function vonEnd(count: number, start: number, isVon: (run: number) => boolean): number {
  let end = count - 1;
  while (end > start && !isVon(end - 1)) end--;
  return Math.max(start, end);
}

/**
 * A BibTeX name's parts as BibTeX reads them: First von Last, von Last,
 * First, or von Last, Jr, First. The von part is the words from the first
 * that starts with a lowercase letter, or from the start of a name with a
 * comma, to the last such word before the last word, and the last part
 * the words after, so de la Vallée Poussin's last part is Vallée Poussin.
 * Without a von part, the last part is the last word. Words a hyphen
 * joins count as one word here, where BibTeX splits them, so a von part
 * starts and ends only at whitespace: al-Hassan and Smith-Jones stay family
 * names, as they were, and Jean-Paul a given name. Parts after a third,
 * which BibTeX warns of, are dropped, as pandoc drops them.
 */
export function bibtexNameParts(name: string): { first: string; von: string; last: string; jr: string } {
  const parts = splitOutsideGroups(name, NAME_COMMA);
  const words = nameWords(parts[0]);
  // Where each run of words that hyphens join starts. A run is von where
  // its first word is
  const starts = words.flatMap((word, k) => k === 0 || word.separator !== '-' ? [k] : []);
  const count = starts.length;
  const isVon = (run: number) => isVonWord(words[starts[run]].text);
  const runs = (from: number, to: number) =>
    joinWords(words.slice(starts[from] ?? words.length, starts[to] ?? words.length));
  if (parts.length > 1) {
    const end = vonEnd(count, 0, isVon);
    const jr = parts.length > 2 ? parts[1] : '';
    return { first: parts[parts.length > 2 ? 2 : 1], von: runs(0, end), last: runs(end, count), jr };
  }
  let start = starts.slice(0, -1).findIndex((_, run) => isVon(run));
  let end: number;
  if (start < 0) {
    start = Math.max(0, count - 1);
    end = start;
  } else {
    end = vonEnd(count, start, isVon);
  }
  return { first: runs(0, start), von: runs(start, end), last: runs(end, count), jr: '' };
}

export function parseAuthors(authorString: string): CiteprocName[] {
  const authors = splitAuthorString(authorString);
  return authors.map(author => {
    // Institutional/corporate author: one group (after BibTeX parser
    // stripped the outer field braces, institutional names arrive as {Name})
    if (isOneGroup(author)) return { literal: author.slice(1, -1) };
    // A group is one word, so Ludwig {van Beethoven}'s last part is van
    // Beethoven. The von part is citeproc's dropping particle, as pandoc
    // reads it, and the Jr part its suffix.
    const { first, von, last, jr } = bibtexNameParts(author);
    const name: CiteprocName = { family: namePartAsShown(last) };
    const given = namePartAsShown(first);
    const particle = namePartAsShown(von);
    const suffix = namePartAsShown(jr);
    if (given) name.given = given;
    if (particle) name['dropping-particle'] = particle;
    if (suffix) name.suffix = suffix;
    return name;
  });
}

function parseLocator(locator: string): { locator: string; label: string } {
  const trimmed = locator.trim();
  if (trimmed.startsWith('p.') || trimmed.startsWith('pp.')) {
    // Over a line break too, after which the page's text goes on
    const pageMatch = trimmed.match(/^pp?\.\s*([\s\S]+)$/);
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
      // The first author's family name, or an institution's whole name, as
      // citeproc's data has it (see parseAuthors)
      const first = parseAuthors(author)[0];
      text = first ? first.literal ?? first.family ?? '' : author.trim();
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

/** The properties of a paragraph Word shows nothing of: no space, and a
 *  hidden mark, as of a paragraph of HTML comments alone (see generateParagraph) */
export const HIDDEN_PARAGRAPH_PPR = '<w:pPr><w:spacing w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr></w:pPr>';

// The whitespace HTML runs together into one space as it lays out text,
// which a non-breaking space is not
const HTML_WHITESPACE = /[ \t\n\r\f]+/g;

/**
 * A bibliography entry's HTML, from citeproc, as a browser shows it, for
 * htmlToOoxmlRuns. Its whitespace runs together into one space, and is none
 * at a line's start or end, so the line ends and indentation citeproc writes
 * around its divs show nothing. Each div is a line of its own, after a line
 * break, but for the text after a number in the left margin (csl-left-margin,
 * of a style with second-field-align), which sits beside it after a tab, as
 * Zotero writes it in Word.
 */
export function bibliographyEntryAsShown(html: string): string {
  const parts: string[] = [];
  const divs: string[] = [];  // the classes of the divs open
  let lineStart = true;       // whether the line has no text yet
  let spaceAt = -1;           // the part whose text ends in a space, which is the line's last so far
  let breakAt = -1;           // where the line ended, before the next line's text
  let beside = false;         // whether the next line's text sits beside a number in the margin
  for (const part of html.split(/(<[^>]*>)/)) {
    if (!part) continue;
    const div = /^<(\/?)div\b(?:[^>]*?\bclass\s*=\s*"([^"]*)")?/i.exec(part);
    if (div) {
      // The line ends, and so does the space at its end
      if (spaceAt >= 0) parts[spaceAt] = parts[spaceAt].slice(0, -1);
      spaceAt = -1;
      let closed: string | undefined;
      if (div[1]) closed = divs.pop();
      else divs.push(div[2] ?? '');
      if (!lineStart) {
        breakAt = parts.length;
        beside = closed === 'csl-left-margin';
      }
      lineStart = true;
      parts.push(part);
    } else if (part.startsWith('<')) {
      parts.push(part);
    } else {
      let text = part.replace(HTML_WHITESPACE, ' ');
      if (lineStart || spaceAt >= 0) text = text.replace(/^ /, '');
      if (!text) continue;
      if (breakAt >= 0) parts.splice(breakAt, 0, beside ? '\t' : '<br>');
      breakAt = -1;
      lineStart = false;
      parts.push(text);
      spaceAt = text.endsWith(' ') ? parts.length - 1 : -1;
    }
  }
  if (spaceAt >= 0) parts[spaceAt] = parts[spaceAt].slice(0, -1);
  return parts.join('');
}

/**
 * Generate OOXML for a ZOTERO_BIBL field code with rendered bibliography.
 * Without an engine, the field is empty, and marks the bibliography's place.
 * `styleSpaceBefore` is false only where the style of a paragraph with no
 * pStyle is known to give it no space before, as the Normal of the styles
 * export writes.
 */
export function generateBibliographyXml(
  citeprocEngine: CiteprocEngine | undefined,
  biblData?: { uncited?: unknown[]; omitted?: unknown[]; custom?: unknown[] },
  hangingIndent?: boolean,
  styleSpaceBefore = true
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
        bibParagraphs += '<w:p>' + bibPPr + htmlToOoxmlRuns(bibliographyEntryAsShown(trimmed)) + '</w:p>';
      }
    }
  }

  // Wrap in field code.
  // Field-begin and field-end wrapper paragraphs use single spacing with zero
  // before/after to prevent them from rendering as visible blank lines when the
  // document uses non-single line spacing (the instrText is hidden in normal
  // view but the paragraph break still occupies vertical space). The zero
  // before is w:before="0" only where their style may give them space
  // before, as a template's may. Where it gives none, the zero only repeats
  // it, and Word strips it (dirty-flag invariant #5).
  const fieldPPr = '<w:pPr><w:spacing' + (styleSpaceBefore ? ' w:before="0"' : '') + ' w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';
  const fieldStart = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL ' + escapeXml(biblPayload) + ' CSL_BIBLIOGRAPHY </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const fieldEnd = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  // With no entries, the field is one hidden paragraph, which Word shows
  // nothing of, and Zotero's Refresh ignores, as it does any empty bibliography
  if (!bibParagraphs) return '<w:p>' + HIDDEN_PARAGRAPH_PPR + fieldStart + fieldEnd + '</w:p>';
  return '<w:p>' + fieldPPr + fieldStart + '</w:p>' +
    bibParagraphs +
    '<w:p>' + fieldPPr + fieldEnd + '</w:p>';
}

/**
 * The OMML for an equation. Each LaTeX command or environment with no OMML
 * form adds a warning to `warnings`; the converter drops duplicate warnings.
 * In `display` math a \tag is Word's equation number.
 */
function equationOmml(latex: string, warnings?: string[], display = false, numberBlank = false): string {
  return latexToOmml(latex, unknownCommandWarning(warnings), display, numberBlank);
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
const PRIVATE_COMMAND_RE = /\\mmCritic(?:Ins|Del|Hl)(?![A-Za-z])/;

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

/** Whether `latex` holds a % comment, which export writes as a hidden run */
export function holdsLatexComment(latex: string): boolean {
  for (const [token] of latex.matchAll(LATEX_STRUCTURE_RE)) if (token.startsWith('%')) return true;
  return false;
}

/** Whether `latex` ends in a % comment, which would take in what follows it. */
function endsInComment(latex: string): boolean {
  let last: RegExpMatchArray | undefined;
  for (const match of latex.matchAll(LATEX_STRUCTURE_RE)) last = match;
  return !!last && last[0].startsWith('%') && last.index! + last[0].length === latex.length;
}

/**
 * An equation with CriticMarkup inside as LaTeX in which each tracked or
 * highlighted span is a private command (CRITIC_INSERTION_COMMAND,
 * CRITIC_DELETION_COMMAND, CRITIC_HIGHLIGHT_COMMAND), so it parses as one
 * expression and a change or highlight inside a fraction or script stays in
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
    else if (part.type === 'highlight') piece = tracked(CRITIC_HIGHLIGHT_COMMAND, part.content);
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
    const piece = part.type === 'math' || part.type === 'highlight' ? part.content
      : part.type === 'substitution' ? (accepted ? part.newContent : part.oldContent)
        : part.type === (accepted ? 'addition' : 'deletion') ? part.content : '';
    // A newline ends a comment that would otherwise take what follows, and {}
    // a command that would otherwise run into a letter, as in {++\alpha++}x
    if (piece) latex += (endsInComment(latex) ? '\n' : /\\[A-Za-z]+$/.test(latex) && /^[A-Za-z]/.test(piece) ? '{}' : '') + piece;
  }
  return latex;
}

/** The OMML of one view of an equation (see equationViewLatex). LaTeX that's
 *  only whitespace, as {++ ++} accepted is, is a run of it, where equationOmml
 *  gives nothing, as for an empty equation. Word keeps it with
 *  xml:space="preserve", which a space such as an em space doesn't need. */
function equationViewOmml(latex: string, warnings?: string[], numbered = false, numberBlank = false): string {
  if (!latex || latex.trim()) return equationOmml(latex, warnings, numbered, numberBlank);
  return '<m:r>' + (/^[ \t\r\n]+$/.test(latex) ? '<m:t xml:space="preserve">' : '<m:t>') + latex + '</m:t></m:r>';
}

/** `omml` with adjacent runs of the same properties joined, which Word shows
 *  the same way as one run, and without empty runs, which Word shows as
 *  nothing, as \text{} writes one where a change fills it. */
function joinedRuns(omml: string): string {
  const pair = /<m:r>((?:<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)?)<m:t>([^<]*)<\/m:t><\/m:r><m:r>\1<m:t>/g;
  let joined = omml.replace(/ xml:space="preserve"/g, '').replace(/<m:r>(?:<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)?<m:t><\/m:t><\/m:r>/g, '');
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
 *
 * A change that is all of a row before its \tag, as in {--E--} \tag{1},
 * leaves the row of that view showing nothing, whose number export drops,
 * as of an equation of a \tag alone. In place, Word holds the number out of
 * the change, in the row, which import reads back as the \tag after the
 * change, and the view keeps it, as LaTeX shows the tag of an empty row. So
 * the view may have the number there too (see numberBlank in latexToOmml).
 * Without that, the equation was recorded as replaced, its number in the
 * deleted one, and import wrote the \tag in the deletion, which export then
 * dropped.
 */
function tracksInPlace(latex: string, parts: CriticMathPart[], numbered: boolean): boolean {
  // Each \backslash as Word's \ in the equation and its views alike. A view
  // could write one as text where the equation writes Word's \, as before
  // an insertion's content, which follows it in the accepted view, where the
  // insertion follows it in the equation (see literalBackslashes in
  // latex-to-omml.ts)
  return withWordBackslashes(() => {
    const omml = trackedLatexToOmml(latex, (element, content) => '<' + element + '>' + content + '</' + element + '>', undefined, numbered)
      .split(MATH_HIGHLIGHT_RPR).join('');
    const view = (accepted: boolean) => {
      const [keep, drop] = accepted ? ['w:ins', 'w:del'] : ['w:del', 'w:ins'];
      return omml.replace(new RegExp('<' + drop + '>[\\s\\S]*?</' + drop + '>', 'g'), '').replace(new RegExp('</?' + keep + '>', 'g'), '');
    };
    return [true, false].every(accepted => {
      const tracked = joinedRuns(view(accepted));
      const viewLatex = equationViewLatex(parts, accepted);
      return tracked === joinedRuns(equationViewOmml(viewLatex, undefined, numbered))
        || numbered && tracked === joinedRuns(equationViewOmml(viewLatex, undefined, true, true));
    });
  });
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
  // Its \{, \}, \_, \# and \& export as written, or not, alike in each view
  // and in the equation Word holds (see escapesAsText in latex-to-omml.ts)
  const views = [true, false].map(accepted => equationViewLatex(parts, accepted));
  const numbered = display && tagsNumbered(parts);
  return withEquationEscapes(views, () => trackedMathXml(parts, track, warnings, display, numbered), numbered);
}

/**
 * Whether display math with CriticMarkup inside numbers its rows by their
 * \tag. A \tag in CriticMarkup, or with CriticMarkup in it, is dropped, as
 * before: Word's number is the end of a row, which an edit in it can't add
 * or remove.
 */
function tagsNumbered(parts: CriticMathPart[]): boolean {
  const tags = (accepted: boolean) => (equationViewLatex(parts, accepted).match(/\\tag(?![A-Za-z])\*?\s*\{[^{}]*\}/g) ?? []).join();
  return tags(true) === tags(false) &&
    !parts.some(part => part.type !== 'math' && /\\tag(?![A-Za-z])/.test(part.type === 'substitution' ? part.oldContent + part.newContent : part.content));
}

function trackedMathXml(parts: CriticMathPart[], track: TrackChange, warnings: string[] | undefined, display: boolean, numbered: boolean): string {
  if (display) {
    parts = parts.map((part, k) => part.type === 'math' ? { ...part, content: withinFences(part.content, k === 0, k === parts.length - 1) } : part);
  }
  const equation = (omml: string) => display ? '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>' : '<m:oMath>' + omml + '</m:oMath>';
  const latex = trackedEquationLatex(parts);
  if (latex !== undefined && tracksInPlace(latex, parts, numbered)) {
    return equation(trackedLatexToOmml(latex, track, unknownCommandWarning(warnings), numbered, !display));
  }
  // An equation with highlights and no change in it is the equation, without
  // a highlight that holds syntax rather than math, as x{==^2==}
  if (parts.every(part => part.type === 'math' || part.type === 'highlight')) {
    return equation(equationViewOmml(equationViewLatex(parts, true), warnings, numbered));
  }
  const view = (accepted: boolean) => {
    const omml = equationViewOmml(equationViewLatex(parts, accepted), warnings, numbered);
    return omml ? track(accepted ? 'w:ins' : 'w:del', omml) : '';
  };
  return equation(view(false) + view(true));
}

/**
 * A display equation's LaTeX without the line ends its fences give it on
 * lines of their own: the one after the opening fence and the one before
 * the closing fence. Export would write each as a run of a line feed alone
 * at the equation's edge, which Word never writes, and import writes the
 * fences on lines of their own again. A comment on the last line keeps its
 * line end, which its hidden run holds wherever it is. Line ends between
 * rows are the source's and stay. `first` and `last` say which fences a
 * part of a tracked equation (see generateTrackedMathXml) is next to.
 */
function withinFences(latex: string, first = true, last = true): string {
  const inner = first ? latex.replace(/^[ \t]*\n/, '') : latex;
  if (!last) return inner;
  const trimmed = inner.replace(/\n[ \t]*$/, '');
  return endsInComment(trimmed) ? trimmed + '\n' : trimmed;
}

/** Generate an equation, warning as equationOmml does. */
export function generateMathXml(latex: string, display: boolean, warnings?: string[]): string {
  const omml = equationOmml(display ? withinFences(latex) : latex, warnings, display);

  if (display) {
    return '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>';
  } else {
    return '<m:oMath>' + omml + '</m:oMath>';
  }
}
