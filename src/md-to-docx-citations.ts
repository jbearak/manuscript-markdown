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
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export function generateCitation(
  run: { keys?: string[]; locators?: Map<string, string>; text: string },
  entries: Map<string, BibtexEntry>,
  citeprocEngine?: any
): CitationResult {
  if (!run.keys || run.keys.length === 0) {
    return { xml: '<w:r><w:t>[@' + escapeXml(run.text) + ']</w:t></w:r>' };
  }

  const citationItems: any[] = [];
  const warnings: string[] = [];
  let hasZoteroData = false;
  let shouldFallbackToPlain = false;

  for (const key of run.keys) {
    const entry = entries.get(key);
    if (!entry) {
      warnings.push(`Citation key not found: ${key}`);
      shouldFallbackToPlain = true;
      continue;
    }

    if (entry.zoteroKey && entry.zoteroUri) {
      hasZoteroData = true;
      const itemData = buildItemData(entry);
      const citationItem: any = {
        uris: [entry.zoteroUri],
        itemData
      };

      const locator = run.locators?.get(key);
      if (locator) {
        const parsed = parseLocator(locator);
        citationItem.locator = parsed.locator;
        citationItem.label = parsed.label;
      }

      citationItems.push(citationItem);
    } else {
      shouldFallbackToPlain = true;
    }
  }

  if (hasZoteroData && citationItems.length > 0 && !shouldFallbackToPlain) {
    const cslCitation = {
      citationItems,
      properties: { noteIndex: 0 }
    };

    const json = JSON.stringify(cslCitation);

    // Use citeproc-rendered text if available, otherwise fallback
    let visibleText: string;
    if (citeprocEngine) {
      const rendered = renderCitationText(citeprocEngine, run.keys, run.locators);
      visibleText = rendered || generateFallbackText(run.keys, entries, run.locators);
    } else {
      visibleText = generateFallbackText(run.keys, entries, run.locators);
    }

    const xml = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + escapeXml(json) + ' </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>' + escapeXml(visibleText) + '</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

    return { xml, warning: warnings.length > 0 ? warnings.join('; ') : undefined };
  }
  if (hasZoteroData && shouldFallbackToPlain) {
    warnings.push('Mixed Zotero and non-Zotero citations in grouped citation; emitted plain-text fallback to avoid partial field code');
  }

  // No Zotero data, emit plain text — still use citeproc if available
  let fallbackText: string;
  if (citeprocEngine) {
    const rendered = renderCitationText(citeprocEngine, run.keys, run.locators);
    fallbackText = rendered || generateFallbackText(run.keys, entries, run.locators);
  } else {
    fallbackText = generateFallbackText(run.keys, entries, run.locators);
  }
  return {
    xml: '<w:r><w:t>' + escapeXml(fallbackText) + '</w:t></w:r>',
    warning: warnings.length > 0 ? warnings.join('; ') : undefined
  };
}

export function buildItemData(entry: BibtexEntry): any {
  const itemData: any = {
    type: mapBibtexTypeToCSL(entry.type)
  };

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

function parseAuthors(authorString: string): any[] {
  const authors = authorString.split(' and ').map(a => a.trim());
  return authors.map(author => {
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
      const firstAuthor = author.split(' and ')[0].trim();
      const commaPos = firstAuthor.indexOf(',');
      const family = commaPos !== -1 ? firstAuthor.slice(0, commaPos).trim() : firstAuthor.split(' ').pop() || firstAuthor;
      text = family;
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
  let bibText = '';
  if (bib && bib.entries.length > 0) {
    // Strip HTML tags from bibliography entries for plain text display
    bibText = bib.entries.map(e => e.replace(/<[^>]+>/g, '').trim()).join('\n');
  }

  // Generate bibliography paragraphs
  let bibParagraphs = '';
  if (bibText) {
    const lines = bibText.split('\n').filter(l => l.trim());
    for (const line of lines) {
      bibParagraphs += '<w:p><w:r><w:t xml:space="preserve">' + escapeXml(line) + '</w:t></w:r></w:p>';
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
