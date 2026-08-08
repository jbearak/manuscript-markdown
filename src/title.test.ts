import { describe, it, expect } from 'bun:test';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { extractTitleLines, ContentItem } from './converter';
import { convertMdToDocx, generateDocumentXml, type MdToken, type DocxGenState } from './md-to-docx';
import { convertDocx } from './converter';

describe('parseFrontmatter with title', () => {
  it('parses a single title entry', () => {
    const md = '---\ntitle: My Document Title\n---\n\nBody text.';
    const { metadata, body } = parseFrontmatter(md);
    expect(metadata.title).toEqual(['My Document Title']);
    expect(body.trim()).toBe('Body text.');
  });

  it('parses multiple title entries', () => {
    const md = '---\ntitle: First Paragraph\ntitle: Second Paragraph\n---\n\nBody text.';
    const { metadata, body } = parseFrontmatter(md);
    expect(metadata.title).toEqual(['First Paragraph', 'Second Paragraph']);
    expect(body.trim()).toBe('Body text.');
  });

  it('parses title with quotes', () => {
    const md = '---\ntitle: "Quoted Title"\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.title).toEqual(['Quoted Title']);
  });

  it('parses title alongside other fields', () => {
    const md = '---\ntitle: My Title\ncsl: apa\nlocale: en-US\nnote-type: in-text\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.title).toEqual(['My Title']);
    expect(metadata.csl).toBe('apa');
    expect(metadata.locale).toBe('en-US');
    expect(metadata.zoteroNotes).toBe('in-text');
  });

  it('returns no title when absent', () => {
    const md = '---\ncsl: apa\n---\n\nBody.';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.title).toBeUndefined();
  });
});

describe('serializeFrontmatter with title', () => {
  it('serializes a single title', () => {
    const result = serializeFrontmatter({ title: ['My Title'] });
    expect(result).toBe('---\ntitle: My Title\n---\n');
  });

  it('serializes multiple titles', () => {
    const result = serializeFrontmatter({ title: ['Line 1', 'Line 2'] });
    expect(result).toBe('---\ntitle: Line 1\ntitle: Line 2\n---\n');
  });

  it('serializes title before other fields', () => {
    const result = serializeFrontmatter({ title: ['My Title'], csl: 'apa', locale: 'en-US' });
    expect(result).toBe('---\ntitle: My Title\ncsl: apa\nlocale: en-US\n---\n');
  });

  it('returns empty string for empty title array', () => {
    const result = serializeFrontmatter({ title: [] });
    expect(result).toBe('');
  });

  it('returns empty string for no fields', () => {
    const result = serializeFrontmatter({});
    expect(result).toBe('');
  });
});

describe('extractTitleLines', () => {
  it('extracts title paragraphs from beginning of content', () => {
    const content: ContentItem[] = [
      { type: 'para', isTitle: true },
      { type: 'text', text: 'My Title', commentIds: new Set(), formatting: { bold: false, italic: false, underline: false, strikethrough: false, highlight: false, superscript: false, subscript: false, code: false } },
      { type: 'para' },
      { type: 'text', text: 'Body text', commentIds: new Set(), formatting: { bold: false, italic: false, underline: false, strikethrough: false, highlight: false, superscript: false, subscript: false, code: false } },
    ];
    const titles = extractTitleLines(content);
    expect(titles).toEqual(['My Title']);
    expect(content.length).toBe(2);
    expect(content[0].type).toBe('para');
    expect((content[1] as any).text).toBe('Body text');
  });

  it('extracts multiple consecutive title paragraphs', () => {
    const fmt = { bold: false, italic: false, underline: false, strikethrough: false, highlight: false, superscript: false, subscript: false, code: false };
    const content: ContentItem[] = [
      { type: 'para', isTitle: true },
      { type: 'text', text: 'Title Line 1', commentIds: new Set(), formatting: fmt },
      { type: 'para', isTitle: true },
      { type: 'text', text: 'Title Line 2', commentIds: new Set(), formatting: fmt },
      { type: 'para' },
      { type: 'text', text: 'Body', commentIds: new Set(), formatting: fmt },
    ];
    const titles = extractTitleLines(content);
    expect(titles).toEqual(['Title Line 1', 'Title Line 2']);
    expect(content.length).toBe(2);
  });

  it('returns empty array when no title paragraphs', () => {
    const fmt = { bold: false, italic: false, underline: false, strikethrough: false, highlight: false, superscript: false, subscript: false, code: false };
    const content: ContentItem[] = [
      { type: 'para' },
      { type: 'text', text: 'Body', commentIds: new Set(), formatting: fmt },
    ];
    const titles = extractTitleLines(content);
    expect(titles).toEqual([]);
    expect(content.length).toBe(2);
  });

  it('stops at non-title paragraph', () => {
    const fmt = { bold: false, italic: false, underline: false, strikethrough: false, highlight: false, superscript: false, subscript: false, code: false };
    const content: ContentItem[] = [
      { type: 'para', isTitle: true },
      { type: 'text', text: 'Title', commentIds: new Set(), formatting: fmt },
      { type: 'para', headingLevel: 1 },
      { type: 'text', text: 'Heading', commentIds: new Set(), formatting: fmt },
      { type: 'para', isTitle: true },
      { type: 'text', text: 'Not extracted', commentIds: new Set(), formatting: fmt },
    ];
    const titles = extractTitleLines(content);
    expect(titles).toEqual(['Title']);
    // The heading and second title remain
    expect(content.length).toBe(4);
  });
});

describe('MD→DOCX title generation', () => {
  it('generates Title-styled paragraphs from frontmatter', () => {
    const state: DocxGenState = {
      commentId: 0,
      comments: [],
      relationships: new Map(),
      nextRId: 1,
      rIdOffset: 3,
      warnings: [],
      hasList: false,
      listStartOverrides: [],
      hasComments: false,
      missingKeys: new Set<string>(),
      activeListStartOverrides: new Map(),
    };
    const tokens: MdToken[] = [
      { type: 'paragraph', runs: [{ type: 'text', text: 'Body text' }] },
    ];
    const xml = generateDocumentXml(tokens, state, undefined, undefined, undefined, { title: ['My Title'] });
    expect(xml).toContain('<w:pStyle w:val="Title"/>');
    expect(xml).toContain('My Title');
    // Title should come before body
    const titleIdx = xml.indexOf('My Title');
    const bodyIdx = xml.indexOf('Body text');
    expect(titleIdx).toBeLessThan(bodyIdx);
  });

  it('generates multiple Title paragraphs', () => {
    const state: DocxGenState = {
      commentId: 0,
      comments: [],
      relationships: new Map(),
      nextRId: 1,
      rIdOffset: 3,
      warnings: [],
      hasList: false,
      listStartOverrides: [],
      hasComments: false,
      missingKeys: new Set<string>(),
      activeListStartOverrides: new Map(),
    };
    const tokens: MdToken[] = [];
    const xml = generateDocumentXml(tokens, state, undefined, undefined, undefined, { title: ['Line 1', 'Line 2'] });
    const matches = xml.match(/<w:pStyle w:val="Title"\/>/g);
    expect(matches?.length).toBe(2);
    expect(xml).toContain('Line 1');
    expect(xml).toContain('Line 2');
  });
});

describe('Title roundtrip', () => {
  it('MD→DOCX→MD preserves single title', async () => {
    const md = '---\ntitle: My Document Title\n---\n\nBody paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata } = parseFrontmatter(result.markdown);
    expect(metadata.title).toEqual(['My Document Title']);
    expect(result.markdown).toContain('Body paragraph.');
  });

  it('MD→DOCX→MD preserves multiple titles', async () => {
    const md = '---\ntitle: First Title Line\ntitle: Second Title Line\n---\n\nBody paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata } = parseFrontmatter(result.markdown);
    expect(metadata.title).toEqual(['First Title Line', 'Second Title Line']);
  });

  it('MD→DOCX→MD preserves title with other frontmatter fields', async () => {
    const md = '---\ntitle: My Title\ncsl: apa\n---\n\n# Introduction\n\nSome text.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata, body } = parseFrontmatter(result.markdown);
    expect(metadata.title).toEqual(['My Title']);
    expect(metadata.csl).toBeDefined();
    expect(body).toContain('Introduction');
  });

  it('MD→DOCX→MD safely preserves an escaped title newline', async () => {
    const md = '---\ntitle: "Safe\\nbibliography: injected.bib"\nbibliography: actual.bib\n---\n\nBody paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata } = parseFrontmatter(result.markdown);

    expect(metadata.title).toEqual(['Safe\nbibliography: injected.bib']);
    expect(metadata.bibliography).toBe('actual.bib');
    expect(result.markdown).not.toContain('\nbibliography: injected.bib');
    expect(result.markdown.match(/^bibliography:/gm)).toHaveLength(1);
  });

  it('MD→DOCX→MD keeps an escaped bracket-shaped title scalar', async () => {
    const md = '---\ntitle: "\\u005bMain, Subtitle\\u005d"\n---\n\nBody paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(parseFrontmatter(result.markdown).metadata.title).toEqual(['[Main, Subtitle]']);
  });

  it('MD→DOCX→MD sanitizes XML-illegal decoded title controls', async () => {
    const md = '---\ntitle: "Bad\\u0000Value"\n---\n\nBody paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(parseFrontmatter(result.markdown).metadata.title).toEqual(['Bad�Value']);
    expect(result.markdown).not.toContain(String.fromCodePoint(0));
  });
});
