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
});

describe('Title tracked changes', () => {
  const fmt = { bold: false, italic: false, underline: false, strikethrough: false, highlight: false, superscript: false, subscript: false, code: false };
  const text = (t: string, revision?: { type: 'addition' | 'deletion'; author: string; date: string }): ContentItem =>
    ({ type: 'text', text: t, commentIds: new Set(), formatting: fmt, ...(revision ? { revision } : {}) });

  it('exports additions, deletions and substitutions as Word revisions in the title', async () => {
    const md = '---\ntitle: A {++new++} {--old--} {~~x~>y~~} title\n---\n\nBody.';
    const { docx } = await convertMdToDocx(md, { authorName: 'Ann' });
    const xml = await (await (await import('jszip')).default.loadAsync(docx)).file('word/document.xml')!.async('string');
    const title = xml.match(/<w:p [^>]*><w:pPr><w:pStyle w:val="Title"\/>[\s\S]*?<\/w:p>/)![0];
    expect(title).toContain('<w:ins w:id="0" w:author="Ann"><w:r><w:t>new</w:t></w:r></w:ins>');
    expect(title).toContain('<w:del w:id="1" w:author="Ann"><w:r><w:delText>old</w:delText></w:r></w:del>');
    expect(title).toContain('<w:del w:id="2" w:author="Ann"><w:r><w:delText>x</w:delText></w:r></w:del>'
      + '<w:ins w:id="3" w:author="Ann"><w:r><w:t>y</w:t></w:r></w:ins>');
    expect(title).not.toContain('{++');
  });

  it('keeps an opener with no closer as text', () => {
    const state: DocxGenState = {
      commentId: 0, comments: [], relationships: new Map(), nextRId: 1, rIdOffset: 3, warnings: [], hasList: false,
      listStartOverrides: [], hasComments: false, missingKeys: new Set<string>(), activeListStartOverrides: new Map(),
    };
    const xml = generateDocumentXml([], state, undefined, undefined, undefined, { title: ['A {++ b'] });
    expect(xml).toContain('<w:t>A {++ b</w:t>');
    expect(xml).not.toContain('<w:ins');
  });

  it('ends a substitution\'s old side at its first closer', () => {
    const state: DocxGenState = {
      commentId: 0, comments: [], relationships: new Map(), nextRId: 1, rIdOffset: 3, warnings: [], hasList: false,
      listStartOverrides: [], hasComments: false, missingKeys: new Set<string>(), activeListStartOverrides: new Map(),
    };
    const xml = generateDocumentXml([], state, undefined, undefined, undefined, { title: ['{~~literal~~} then {~~old~>new~~}'] });
    expect(xml).toContain('<w:t xml:space="preserve">{~~literal~~} then </w:t>');
    expect(xml).toContain('<w:delText>old</w:delText>');
    expect(xml).toContain('<w:t>new</w:t>');
  });

  it('imports a title run\'s revision as CriticMarkup', () => {
    const ann = { author: 'Ann', date: '2026-01-01T00:00:00Z' };
    const content: ContentItem[] = [
      { type: 'para', isTitle: true },
      text('A '),
      text('new', { type: 'addition', ...ann }),
      text(' '),
      text('old', { type: 'deletion', ...ann }),
      text(' '),
      text('x', { type: 'deletion', ...ann }),
      text('y', { type: 'addition', ...ann }),
      text(' '),
      text('p', { type: 'deletion', ...ann }),
      text('q', { type: 'addition', author: 'Bob', date: ann.date }),
    ];
    expect(extractTitleLines(content)).toEqual(['A {++new++} {--old--} {~~x~>y~~} {--p--}{++q++}']);
  });

  it('drops tracked whitespace beside a title\'s line breaks, and a line of it alone', () => {
    const ann = { author: 'Ann', date: '2026-01-01T00:00:00Z' };
    const content: ContentItem[] = [
      { type: 'para', isTitle: true },
      text('A'),
      text(' ', { type: 'addition', ...ann }),
      text('\\\n'),
      text(' ', { type: 'addition', ...ann }),
      text('\\\n'),
      text(' ', { type: 'deletion', ...ann }),
      text('B'),
    ];
    expect(extractTitleLines(content)).toEqual(['A', 'B']);
  });

  it('MD→DOCX→MD keeps a deleted title line\'s font style', async () => {
    const md = '---\ntitle: A\ntitle: {--B--}\ntitle-font-style: [bold, italic]\n---\n\nBody.';
    const { docx } = await convertMdToDocx(md);
    const { metadata } = parseFrontmatter((await convertDocx(docx)).markdown);
    expect(metadata.title).toEqual(['A', '{--B--}']);
    expect(metadata.titleFontStyle).toEqual(['bold', 'italic']);
  });

  it('MD→DOCX→MD reads a title line\'s font style from its shown text over its deletions', async () => {
    const md = '---\ntitle: A\ntitle: X {--Y--}\ntitle-font-style: [bold, italic]\n---\n\nBody.';
    const { docx } = await convertMdToDocx(md);
    const zip = await (await import('jszip')).default.loadAsync(docx);
    // Word's text of the deletion in another style than the line's
    const xml = (await zip.file('word/document.xml')!.async('string'))
      .replace(/(<w:del [^>]*><w:r><w:rPr><w:b w:val="0"\/>)<w:i\/>/, '$1<w:i w:val="0"/>');
    zip.file('word/document.xml', xml);
    const edited = await zip.generateAsync({ type: 'uint8array' });
    const { metadata } = parseFrontmatter((await convertDocx(edited)).markdown);
    expect(xml).toContain('<w:i w:val="0"/><w:caps w:val="0"/><w:smallCaps w:val="0"/><w:u w:val="none"/></w:rPr><w:delText>Y');
    expect(metadata.title).toEqual(['A', 'X {--Y--}']);
    expect(metadata.titleFontStyle).toEqual(['bold', 'italic']);
  });

  it('MD→DOCX→MD preserves tracked changes in the title', async () => {
    const md = '---\ntitle: My {++new ++}title {--draft--}\ntitle: {~~Old~>New~~} subtitle\n---\n\nBody paragraph.';
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(parseFrontmatter(result.markdown).metadata.title).toEqual(['My {++new ++}title {--draft--}', '{~~Old~>New~~} subtitle']);
  });
});

describe('Title comments', () => {
  const thread = '{>>@Ann Lee (2024-01-01 10:00) | Which journal?\n  {>>@Ben Ray (2024-01-02 10:00) | A public health one<<}\n<<}';

  /** Export's DOCX of `md`, with the markers of its body's comments moved as
   *  `move` moves them in document.xml, as Word has them on the title */
  async function withCommentsMoved(md: string, move: (xml: string, markers: string[]) => string): Promise<Uint8Array> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    let xml = await zip.file('word/document.xml')!.async('string');
    const markers = xml.match(/<w:commentRange(?:Start|End) [^>]*\/>|<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference [^>]*\/><\/w:r>/g)!;
    for (const marker of markers) xml = xml.replace(marker, '');
    zip.file('word/document.xml', move(xml, markers));
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('imports a comment thread on the title\'s text as comments right after the frontmatter', async () => {
    // As Word has a comment and its reply on the title's last word
    const docx = await withCommentsMoved('---\ntitle: Births from 1965 to 2023\n---\n\n{==Body==}' + thread + ' text.\n', (xml, markers) => {
      const starts = markers.filter(marker => marker.includes('RangeStart')).join('');
      const ends = markers.filter(marker => !marker.includes('RangeStart')).join('');
      return xml.replace('<w:r><w:t>Births from 1965 to 2023</w:t></w:r>',
        '<w:r><w:t xml:space="preserve">Births from 1965 to </w:t></w:r>' + starts + '<w:r><w:t>2023</w:t></w:r>' + ends);
    });
    const { markdown } = await convertDocx(docx);
    expect(markdown).toBe('---\ntitle: Births from 1965 to 2023\n---\n\n' + thread + '\n\nBody text.\n');
  });

  it('writes a comment from the title into the body once where its range goes on there', async () => {
    const docx = await withCommentsMoved('---\ntitle: T\n---\n\n{==Body==}{>>@Ann Lee (2024-01-01 10:00) | c<<} text.\n', (xml, markers) =>
      xml.replace('<w:t>T</w:t></w:r>', '<w:t>T</w:t></w:r>' + markers[0]).replace('<w:r><w:t>Body</w:t></w:r>', '<w:r><w:t>Body</w:t></w:r>' + markers.slice(1).join('')));
    const { markdown } = await convertDocx(docx);
    expect(markdown.match(/\| c<</g)).toHaveLength(1);
    expect(parseFrontmatter(markdown).metadata.title).toEqual(['T']);
  });

  it('MD→DOCX writes comments alone right after the title on the title, and back', async () => {
    const body = thread + '\n\n```r\nx <- 1\n```\n\n- a\n\n- b\n\n> Quoted.\n\nBody text.\n';
    const md = '---\ntitle: First\ntitle: Second\n---\n\n' + body;
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const paragraphs = xml.match(/<w:p\b(?:(?!<\/w:p>).)*<\/w:p>/gs)!;
    // On the last title paragraph, with no paragraph of their own
    expect(paragraphs[1]).toContain('<w:pStyle w:val="Title"/>');
    expect(paragraphs[1].match(/<w:commentReference /g)).toHaveLength(2);
    expect(paragraphs[2]).not.toContain('<w:comment');
    expect((await convertDocx(docx)).markdown).toBe(md);
  });

  it('MD→DOCX→MD keeps a comment on nothing with replies one after another, in ID syntax, on the title', async () => {
    const md = '---\ntitle: T\n---\n\n{#1}{/1}\n{#1>>@Ann Lee (2024-01-01 10:00) | c<<}{>>@Ben Ray (2024-01-02 10:00) | r<<}\n\nBody.\n';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:p\b(?:(?!<\/w:p>).)*<\/w:p>/gs)![0]).toContain('<w:commentReference w:id="1"/>');
    expect((await convertDocx(docx)).markdown).toBe(md);
  });
});

describe('Title comments, kept in the body', () => {
  it('writes a comment from the title once where its range goes on into a table', async () => {
    const JSZip = (await import('jszip')).default;
    const md = '---\ntitle: T\n---\n\n| A | B |\n|---|---|\n| {==x==}{>>note<<} | y |\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    let xml = await zip.file('word/document.xml')!.async('string');
    const start = xml.match(/<w:commentRangeStart [^>]*\/>/)![0];
    xml = xml.replace(start, '').replace('<w:t>T</w:t></w:r>', '<w:t>T</w:t></w:r>' + start);
    zip.file('word/document.xml', xml);
    const { markdown } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    // No paragraph of the comment's before the table
    expect(markdown.split('\n---\n')[1].trimStart()).toStartWith('|');
    expect(markdown.match(/note<</g)).toHaveLength(1);
  });

  it('keeps a first paragraph of comments with an indent directive in a paragraph of its own', async () => {
    const md = '---\ntitle: T\n---\n\n<!-- no-indent -->\n{>>@Ann Lee (2024-01-01 10:00) | c<<}\n\nBody.\n';
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    const paragraphs = xml.match(/<w:p\b(?:(?!<\/w:p>).)*<\/w:p>/gs)!;
    expect(paragraphs[0]).not.toContain('<w:commentReference');
    expect(paragraphs[1]).toContain('<w:commentReference');
  });
});
