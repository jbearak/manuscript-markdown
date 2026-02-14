import { describe, it, expect } from 'bun:test';
import { 
  generateRPr, 
  generateRun, 
  generateParagraph, 
  generateTable, 
  convertMdToDocx,
  type MdRun,
  type MdToken,
  type MdTableRow
} from './md-to-docx';

describe('generateRPr', () => {
  it('returns empty string for no formatting', () => {
    const run: MdRun = { type: 'text', text: 'hello' };
    expect(generateRPr(run)).toBe('');
  });

  it('generates code style', () => {
    const run: MdRun = { type: 'text', text: 'code', code: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr>');
  });

  it('generates bold', () => {
    const run: MdRun = { type: 'text', text: 'bold', bold: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:b/></w:rPr>');
  });

  it('generates italic', () => {
    const run: MdRun = { type: 'text', text: 'italic', italic: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:i/></w:rPr>');
  });

  it('generates strikethrough', () => {
    const run: MdRun = { type: 'text', text: 'strike', strikethrough: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:strike/></w:rPr>');
  });

  it('generates underline', () => {
    const run: MdRun = { type: 'text', text: 'underline', underline: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:u w:val="single"/></w:rPr>');
  });

  it('generates highlight with default color', () => {
    const run: MdRun = { type: 'text', text: 'highlight', highlight: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
  });

  it('generates highlight with custom color', () => {
    const run: MdRun = { type: 'text', text: 'highlight', highlight: true, highlightColor: 'green' };
    expect(generateRPr(run)).toBe('<w:rPr><w:highlight w:val="green"/></w:rPr>');
  });

  it('generates superscript', () => {
    const run: MdRun = { type: 'text', text: 'super', superscript: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>');
  });

  it('generates subscript', () => {
    const run: MdRun = { type: 'text', text: 'sub', subscript: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:vertAlign w:val="subscript"/></w:rPr>');
  });

  it('prioritizes superscript over subscript', () => {
    const run: MdRun = { type: 'text', text: 'both', superscript: true, subscript: true };
    expect(generateRPr(run)).toBe('<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>');
  });

  it('combines multiple formatting options in correct order', () => {
    const run: MdRun = { 
      type: 'text', 
      text: 'formatted', 
      code: true,
      bold: true, 
      italic: true, 
      strikethrough: true,
      underline: true,
      highlight: true,
      highlightColor: 'blue',
      superscript: true
    };
    expect(generateRPr(run)).toBe('<w:rPr><w:rStyle w:val="CodeChar"/><w:b/><w:i/><w:strike/><w:u w:val="single"/><w:highlight w:val="blue"/><w:vertAlign w:val="superscript"/></w:rPr>');
  });
});

describe('generateRun', () => {
  it('generates basic run', () => {
    const result = generateRun('hello', '');
    expect(result).toBe('<w:r><w:t xml:space="preserve">hello</w:t></w:r>');
  });

  it('generates run with formatting', () => {
    const result = generateRun('bold', '<w:rPr><w:b/></w:rPr>');
    expect(result).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t></w:r>');
  });

  it('escapes XML characters', () => {
    const result = generateRun('<test> & "quotes"', '');
    expect(result).toBe('<w:r><w:t xml:space="preserve">&lt;test&gt; &amp; "quotes"</w:t></w:r>');
  });
});

describe('generateParagraph', () => {
  const createState = () => ({
    commentId: 0,
    comments: [],
    relationships: new Map(),
    nextRId: 1,
    warnings: [],
    hasList: false,
    hasComments: false
  });

  it('generates basic paragraph', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'text', text: 'Hello world' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:r><w:t xml:space="preserve">Hello world</w:t></w:r></w:p>');
  });

  it('generates heading level 1', () => {
    const token: MdToken = {
      type: 'heading',
      level: 1,
      runs: [{ type: 'text', text: 'Title' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Title</w:t></w:r></w:p>');
  });

  it('generates heading level 6', () => {
    const token: MdToken = {
      type: 'heading',
      level: 6,
      runs: [{ type: 'text', text: 'Subtitle' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Heading6"/></w:pPr><w:r><w:t xml:space="preserve">Subtitle</w:t></w:r></w:p>');
  });

  it('generates bullet list item', () => {
    const token: MdToken = {
      type: 'list_item',
      ordered: false,
      level: 1,
      runs: [{ type: 'text', text: 'Item 1' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item 1</w:t></w:r></w:p>');
    expect(state.hasList).toBe(true);
  });

  it('generates ordered list item', () => {
    const token: MdToken = {
      type: 'list_item',
      ordered: true,
      level: 2,
      runs: [{ type: 'text', text: 'Item 2' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item 2</w:t></w:r></w:p>');
    expect(state.hasList).toBe(true);
  });

  it('generates blockquote', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      runs: [{ type: 'text', text: 'Quote text' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Quote"/><w:ind w:left="720"/></w:pPr><w:r><w:t xml:space="preserve">Quote text</w:t></w:r></w:p>');
  });

  it('generates nested blockquote', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 3,
      runs: [{ type: 'text', text: 'Nested quote' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Quote"/><w:ind w:left="2160"/></w:pPr><w:r><w:t xml:space="preserve">Nested quote</w:t></w:r></w:p>');
  });

  it('generates code block with multiple lines', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'line1\nline2\nline3' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t xml:space="preserve">line1</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t xml:space="preserve">line2</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t xml:space="preserve">line3</w:t></w:r></w:p>');
  });

  it('generates horizontal rule', () => {
    const token: MdToken = {
      type: 'hr',
      runs: []
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>');
  });

  it('generates hyperlink', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'text', text: 'Link text', href: 'https://example.com' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:hyperlink r:id="rId4"><w:r><w:t xml:space="preserve">Link text</w:t></w:r></w:hyperlink></w:p>');
    expect(state.relationships.get('https://example.com')).toBe('rId4');
  });

  it('generates softbreak', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'Line 1' },
        { type: 'softbreak', text: '\n' },
        { type: 'text', text: 'Line 2' }
      ]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:r><w:t xml:space="preserve">Line 1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">Line 2</w:t></w:r></w:p>');
  });
});

describe('generateTable', () => {
  const createState = () => ({
    commentId: 0,
    comments: [],
    relationships: new Map(),
    nextRId: 1,
    warnings: [],
    hasList: false,
    hasComments: false
  });

  it('generates basic table', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          [{ type: 'text', text: 'Header 1' }],
          [{ type: 'text', text: 'Header 2' }]
        ]
      },
      {
        header: false,
        cells: [
          [{ type: 'text', text: 'Cell 1' }],
          [{ type: 'text', text: 'Cell 2' }]
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const state = createState();
    const result = generateTable(token, state);
    
    expect(result).toContain('<w:tbl>');
    expect(result).toContain('<w:tblBorders>');
    expect(result).toContain('<w:tr>');
    expect(result).toContain('<w:tc>');
    expect(result).toContain('Header 1');
    expect(result).toContain('Header 2');
    expect(result).toContain('Cell 1');
    expect(result).toContain('Cell 2');
    expect(result).toContain('</w:tbl>');
  });

  it('makes header cells bold', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          [{ type: 'text', text: 'Header' }]
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const state = createState();
    const result = generateTable(token, state);
    
    expect(result).toContain('<w:b/>');
  });

  it('preserves existing bold formatting in header cells', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          [{ type: 'text', text: 'Bold Header', bold: true }]
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const state = createState();
    const result = generateTable(token, state);
    
    // Should only have one <w:b/> tag
    const boldMatches = result.match(/<w:b\/>/g);
    expect(boldMatches?.length).toBe(1);
  });
});

describe('convertMdToDocx', () => {
  it('generates valid zip for empty document', async () => {
    const result = await convertMdToDocx('');
    expect(result.docx).toBeInstanceOf(Uint8Array);
    expect(result.warnings).toEqual([]);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    expect(zip.files['[Content_Types].xml']).toBeDefined();
    expect(zip.files['_rels/.rels']).toBeDefined();
    expect(zip.files['word/document.xml']).toBeDefined();
    expect(zip.files['word/styles.xml']).toBeDefined();
  });

  it('includes numbering.xml for lists', async () => {
    const markdown = '- Item 1\n- Item 2';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    expect(zip.files['word/numbering.xml']).toBeDefined();
    
    const contentTypes = await zip.files['[Content_Types].xml'].async('string');
    expect(contentTypes).toContain('numbering.xml');
  });

  it('includes document.xml.rels for hyperlinks', async () => {
    const markdown = '[Link](https://example.com)';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    expect(zip.files['word/_rels/document.xml.rels']).toBeDefined();
    
    const rels = await zip.files['word/_rels/document.xml.rels'].async('string');
    expect(rels).toContain('https://example.com');
    expect(rels).toContain('TargetMode="External"');
  });

  it('generates correct heading styles', async () => {
    const markdown = '# Heading 1\n## Heading 2';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    const document = await zip.files['word/document.xml'].async('string');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it('generates correct formatting', async () => {
    const markdown = '**bold** *italic* `code`';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    const document = await zip.files['word/document.xml'].async('string');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:i/>');
    expect(document).toContain('<w:rStyle w:val="CodeChar"/>');
  });

  it('handles complex document structure', async () => {
    const markdown = `# Title

This is a paragraph with **bold** and *italic* text.

- List item 1
- List item 2

> Blockquote text

\`\`\`javascript
console.log('code');
\`\`\`

| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |

---`;

    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    // Verify all expected files are present
    expect(zip.files['[Content_Types].xml']).toBeDefined();
    expect(zip.files['_rels/.rels']).toBeDefined();
    expect(zip.files['word/document.xml']).toBeDefined();
    expect(zip.files['word/styles.xml']).toBeDefined();
    expect(zip.files['word/numbering.xml']).toBeDefined();
    
    const document = await zip.files['word/document.xml'].async('string');
    
    // Verify content structure
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:i/>');
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(document).toContain('<w:pStyle w:val="Quote"/>');
    expect(document).toContain('<w:pStyle w:val="CodeBlock"/>');
    expect(document).toContain('<w:tbl>');
    expect(document).toContain('<w:pBdr>');
  });

  it('verifies zip contains expected file count', async () => {
    const markdown = '# Test\n\n- List item\n\n[Link](https://example.com)';
    const result = await convertMdToDocx(markdown);
    
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    
    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain('[Content_Types].xml');
    expect(fileNames).toContain('_rels/.rels');
    expect(fileNames).toContain('word/document.xml');
    expect(fileNames).toContain('word/styles.xml');
    expect(fileNames).toContain('word/numbering.xml');
    expect(fileNames).toContain('word/_rels/document.xml.rels');
    
    // JSZip includes directory entries, so we expect more than just the 6 files
    expect(fileNames.length).toBeGreaterThanOrEqual(6);
  });
});