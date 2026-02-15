import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { extractAuthor, convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// --- Frontmatter parsing ---

describe('parseFrontmatter with author', () => {
  it('parses author field', () => {
    const md = '---\nauthor: Jane Doe\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.author).toBe('Jane Doe');
  });

  it('parses author alongside other fields', () => {
    const md = '---\ntitle: My Title\nauthor: Jane Doe\ncsl: apa\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.title).toEqual(['My Title']);
    expect(metadata.author).toBe('Jane Doe');
    expect(metadata.csl).toBe('apa');
  });

  it('ignores blank author', () => {
    const md = '---\nauthor: \n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.author).toBeUndefined();
  });

  it('strips quotes from author', () => {
    const md = '---\nauthor: "Jane Doe"\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.author).toBe('Jane Doe');
  });

  it('returns no author when absent', () => {
    const md = '---\ncsl: apa\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.author).toBeUndefined();
  });
});

// --- Frontmatter serialization ---

describe('serializeFrontmatter with author', () => {
  it('serializes author', () => {
    const result = serializeFrontmatter({ author: 'Jane Doe' });
    expect(result).toBe('---\nauthor: Jane Doe\n---\n');
  });

  it('places author after title and before csl', () => {
    const result = serializeFrontmatter({ title: ['My Title'], author: 'Jane Doe', csl: 'apa' });
    expect(result).toBe('---\ntitle: My Title\nauthor: Jane Doe\ncsl: apa\n---\n');
  });

  it('omits author when undefined', () => {
    const result = serializeFrontmatter({ csl: 'apa' });
    expect(result).not.toContain('author');
  });
});

// --- extractAuthor from DOCX ---

describe('extractAuthor', () => {
  it('extracts dc:creator from core.xml', async () => {
    const zip = new JSZip();
    zip.file('docProps/core.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:creator>Jane Doe</dc:creator>' +
      '</cp:coreProperties>');
    const author = await extractAuthor(zip);
    expect(author).toBe('Jane Doe');
  });

  it('returns undefined when dc:creator is missing', async () => {
    const zip = new JSZip();
    zip.file('docProps/core.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '</cp:coreProperties>');
    const author = await extractAuthor(zip);
    expect(author).toBeUndefined();
  });

  it('returns undefined when dc:creator is blank', async () => {
    const zip = new JSZip();
    zip.file('docProps/core.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:creator>   </dc:creator>' +
      '</cp:coreProperties>');
    const author = await extractAuthor(zip);
    expect(author).toBeUndefined();
  });

  it('returns undefined when core.xml is absent', async () => {
    const zip = new JSZip();
    const author = await extractAuthor(zip);
    expect(author).toBeUndefined();
  });
});

// --- md→docx round-trip ---

describe('author md→docx→md round-trip', () => {
  it('preserves author through round-trip', async () => {
    const md = '---\ntitle: Test\nauthor: Jane Doe\n---\n\nHello world.';
    const docxResult = await convertMdToDocx(md);
    const mdResult = await convertDocx(docxResult.docx);
    const { metadata } = parseFrontmatter(mdResult.markdown);
    expect(metadata.author).toBe('Jane Doe');
  });

  it('omits dc:creator when no author in frontmatter', async () => {
    const md = '---\ntitle: Test\n---\n\nHello world.';
    const docxResult = await convertMdToDocx(md);

    // Verify the generated docx has no dc:creator
    const zip = await JSZip.loadAsync(docxResult.docx);
    const coreXml = await zip.file('docProps/core.xml')!.async('string');
    expect(coreXml).not.toContain('dc:creator');
  });

  it('XML-escapes author with special characters', async () => {
    const md = '---\nauthor: O\'Brien & Sons <Ltd>\n---\n\nBody.';
    const docxResult = await convertMdToDocx(md);
    const zip = await JSZip.loadAsync(docxResult.docx);
    const coreXml = await zip.file('docProps/core.xml')!.async('string');
    expect(coreXml).toContain('<dc:creator>');
    expect(coreXml).not.toContain('& Sons');  // should be &amp;
    expect(coreXml).toContain('&amp; Sons');
    expect(coreXml).toContain('&lt;Ltd&gt;');
  });
});
