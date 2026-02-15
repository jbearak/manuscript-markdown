import { BibtexEntry } from './bibtex-parser';
import { latexToOmml } from './latex-to-omml';

export interface CitationResult {
  xml: string;
  warning?: string;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateCitation(
  run: { keys?: string[]; locators?: Map<string, string>; text: string },
  entries: Map<string, BibtexEntry>
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
    const fallbackText = generateFallbackText(run.keys, entries, run.locators);
    
    const xml = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ' + escapeXml(json) + ' </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>' + escapeXml(fallbackText) + '</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    
    return { xml, warning: warnings.length > 0 ? warnings.join('; ') : undefined };
  }
  if (hasZoteroData && shouldFallbackToPlain) {
    warnings.push('Mixed Zotero and non-Zotero citations in grouped citation; emitted plain-text fallback to avoid partial field code');
  }

  // No Zotero data, emit plain text
  const fallbackText = generateFallbackText(run.keys, entries, run.locators);
  return { 
    xml: '<w:r><w:t>' + escapeXml(fallbackText) + '</w:t></w:r>',
    warning: warnings.length > 0 ? warnings.join('; ') : undefined
  };
}

function buildItemData(entry: BibtexEntry): any {
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

function generateFallbackText(keys: string[], entries: Map<string, BibtexEntry>, locators?: Map<string, string>): string {
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

export function generateMathXml(latex: string, display: boolean): string {
  const omml = latexToOmml(latex);
  
  if (display) {
    return '<m:oMathPara><m:oMath>' + omml + '</m:oMath></m:oMathPara>';
  } else {
    return '<m:oMath>' + omml + '</m:oMath>';
  }
}
