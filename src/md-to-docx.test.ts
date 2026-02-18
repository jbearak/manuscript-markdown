import { describe, it, expect } from 'bun:test';
import {
  generateRPr,
  generateRun,
  generateRuns,
  generateParagraph,
  generateTable,
  convertMdToDocx,
  parseMd,
  extractFootnoteDefinitions,
  preprocessCriticMarkup,
  type MdRun,
  type MdToken,
  type MdTableRow,
  type DocxGenState
} from './md-to-docx';

function makeState(): DocxGenState {
  return {
    commentId: 0,
    comments: [],
    commentIdMap: new Map(),
    relationships: new Map(),
    nextRId: 1,
    rIdOffset: 5,
    warnings: [],
    hasList: false,
    hasComments: false,
    hasFootnotes: false,
    hasEndnotes: false,
    footnoteId: 1,
    footnoteEntries: [],
    footnoteLabelToId: new Map(),
    notesMode: 'footnotes',
    missingKeys: new Set(),
  };
}

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

describe('parseMd HTML tables', () => {
  it('parses HTML table blocks into table tokens', () => {
    const markdown = '<table><tr><th>H1</th><th>H2</th></tr><tr><td>A</td><td>B</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows?.[0].header).toBe(true);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('H1');
    expect(table?.rows?.[1].cells[1].runs[0].text).toBe('B');
  });

  it('decodes entities and preserves inline formatting inside HTML table cells', () => {
    const markdown = '<table><tr><td><strong>A &amp; B</strong><br/>line</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    const cellRuns = table?.rows?.[0].cells[0].runs;

    // Should produce: bold "A & B", softbreak, plain "line"
    expect(cellRuns).toHaveLength(3);
    expect(cellRuns?.[0]).toMatchObject({ type: 'text', text: 'A & B', bold: true });
    expect(cellRuns?.[1]).toMatchObject({ type: 'softbreak' });
    expect(cellRuns?.[2]).toMatchObject({ type: 'text', text: 'line' });
  });

  it('does not over-decode double-encoded entities inside HTML table cells', () => {
    const markdown = '<table><tr><td>&amp;lt;tag&amp;gt;</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    const text = table?.rows?.[0].cells[0].runs[0].text;

    expect(text).toBe('&lt;tag&gt;');
  });

  it('decodes decimal and hex numeric entities beyond U+FFFF in HTML table cells', () => {
    const markdown = '<table><tr><td>&#128512; &#x1F600;</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    const text = table?.rows?.[0].cells[0].runs[0].text;

    expect(text).toBe('😀 😀');
  });

  it('parses colspan from HTML table cells', () => {
    const markdown = '<table><tr><td colspan="2">Span</td></tr><tr><td>A</td><td>B</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].colspan).toBe(2);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('Span');
    expect(table?.rows?.[1].cells[0].colspan).toBeUndefined();
  });

  it('parses rowspan from HTML table cells', () => {
    const markdown = '<table><tr><td rowspan="3">Tall</td><td>R1</td></tr><tr><td>R2</td></tr><tr><td>R3</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].rowspan).toBe(3);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('Tall');
    expect(table?.rows?.[0].cells[1].rowspan).toBeUndefined();
  });

  it('parses combined colspan and rowspan', () => {
    const markdown = '<table><tr><td colspan="2" rowspan="2">Big</td><td>C</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].colspan).toBe(2);
    expect(table?.rows?.[0].cells[0].rowspan).toBe(2);
  });

  it('ignores colspan=1 and rowspan=1', () => {
    const markdown = '<table><tr><td colspan="1" rowspan="1">Normal</td></tr></table>';
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].colspan).toBeUndefined();
    expect(table?.rows?.[0].cells[0].rowspan).toBeUndefined();
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
    expect(result).toBe('<w:r><w:t xml:space="preserve">&lt;test&gt; &amp; &quot;quotes&quot;</w:t></w:r>');
  });
});

describe('generateParagraph', () => {
  const createState = () => ({
    commentId: 0,
    comments: [],
    commentIdMap: new Map<string, number>(),
    relationships: new Map(),
    nextRId: 1, rIdOffset: 3,
    warnings: [],
    hasList: false,
    hasComments: false,
    missingKeys: new Set<string>()
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
  it('generates basic table', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          { runs: [{ type: 'text', text: 'Header 1' }] },
          { runs: [{ type: 'text', text: 'Header 2' }] }
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Cell 1' }] },
          { runs: [{ type: 'text', text: 'Cell 2' }] }
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const result = generateTable(token, makeState());
    
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
          { runs: [{ type: 'text', text: 'Header' }] }
        ]
      }
    ];

    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };

    const result = generateTable(token, makeState());

    expect(result).toContain('<w:b/>');
  });

  it('emits tblLook firstRow when table has header rows', () => {
    const rows: MdTableRow[] = [
      { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    expect(result).toContain('<w:tblLook w:firstRow="1"/>');
  });

  it('does not emit tblLook firstRow when no header rows', () => {
    const rows: MdTableRow[] = [
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    expect(result).not.toContain('<w:tblLook');
  });

  it('emits tblHeader on header rows', () => {
    const rows: MdTableRow[] = [
      { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    // Header row should have tblHeader
    expect(result).toContain('<w:trPr><w:tblHeader/></w:trPr>');
    // Only one tblHeader (not on the data row)
    const matches = result.match(/<w:tblHeader\/>/g);
    expect(matches?.length).toBe(1);
  });

  it('preserves existing bold formatting in header cells', () => {
    const rows: MdTableRow[] = [
      {
        header: true,
        cells: [
          { runs: [{ type: 'text', text: 'Bold Header', bold: true }] }
        ]
      }
    ];
    
    const token: MdToken = {
      type: 'table',
      runs: [],
      rows
    };
    
    const result = generateTable(token, makeState());
    
    // Should only have one <w:b/> tag
    const boldMatches = result.match(/<w:b\/>/g);
    expect(boldMatches?.length).toBe(1);
  });

  it('generates gridSpan for colspan', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Span' }], colspan: 2 },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'A' }] },
          { runs: [{ type: 'text', text: 'B' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:gridSpan w:val="2"/>');
    expect(result).toContain('<w:tblGrid>');
    expect(result).toContain('<w:gridCol/>');
    expect(result).toContain('Span');
  });

  it('generates vMerge for rowspan', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Tall' }], rowspan: 2 },
          { runs: [{ type: 'text', text: 'R1' }] },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'R2' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:vMerge w:val="restart"/>');
    expect(result).toContain('<w:vMerge/>');
    expect(result).toContain('Tall');
    expect(result).toContain('R1');
    expect(result).toContain('R2');
  });

  it('generates combined colspan+rowspan', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'Big' }], colspan: 2, rowspan: 2 },
          { runs: [{ type: 'text', text: 'C' }] },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'D' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:vMerge w:val="restart"/>');
    expect(result).toContain('<w:gridSpan w:val="2"/>');
    // Continuation row should have gridSpan + vMerge (ECMA-376 element order)
    expect(result).toContain('<w:gridSpan w:val="2"/><w:vMerge/>');
    expect(result).toContain('Big');
    expect(result).toContain('C');
    expect(result).toContain('D');
  });

  it('accounts for rowspan-occupied columns when computing grid width', () => {
    // Row 1 has 2 explicit cells, but row 0's rowspan occupies col 0 in row 1,
    // so the true grid has 3 columns.
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'A' }], rowspan: 2 },
          { runs: [{ type: 'text', text: 'B' }] },
        ]
      },
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'C' }] },
          { runs: [{ type: 'text', text: 'D' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    // All four cells must be present
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).toContain('D');
    // Grid should have 3 columns
    expect((result.match(/<w:gridCol\/>/g) || []).length).toBe(3);
    // 3 w:tr rows (2 explicit + vMerge continuation is implicit within the 2 rows)
    expect((result.match(/<w:tr>/g) || []).length).toBe(2);
  });

  it('does not emit tblGrid when no spans are present', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'A' }] },
          { runs: [{ type: 'text', text: 'B' }] },
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).not.toContain('<w:tblGrid>');
    expect(result).not.toContain('<w:gridSpan');
    expect(result).not.toContain('<w:vMerge');
  });

  it('renders hyperlinks in table cells', () => {
    const state = makeState();
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'text', text: 'click here', href: 'https://example.com' }] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, state);

    expect(result).toContain('<w:hyperlink r:id=');
    expect(result).toContain('click here');
    expect(state.relationships.has('https://example.com')).toBe(true);
  });

  it('renders softbreaks in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [
            { type: 'text', text: 'line1' },
            { type: 'softbreak', text: '\n' },
            { type: 'text', text: 'line2' },
          ] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('line1');
    expect(result).toContain('<w:r><w:br/></w:r>');
    expect(result).toContain('line2');
  });

  it('renders bold and italic formatting in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [
            { type: 'text', text: 'bold', bold: true },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', italic: true },
          ] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    expect(result).toContain('<w:rPr><w:b/></w:rPr>');
    expect(result).toContain('bold');
    expect(result).toContain('<w:rPr><w:i/></w:rPr>');
    expect(result).toContain('italic');
  });

  it('renders critic_add runs in table cells', () => {
    const state = makeState();
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'critic_add', text: 'inserted', author: 'Tester', date: '2024-01-01T00:00:00Z' }] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, state, { authorName: 'Default' });

    expect(result).toContain('<w:ins');
    expect(result).toContain('w:author="Tester"');
    expect(result).toContain('inserted');
  });

  it('renders math runs in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [{ type: 'math', text: 'x^2' }] }
        ]
      }
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());

    // Math runs produce OMML, check for the math namespace element
    expect(result).toContain('m:oMath');
  });
});

describe('parseHtmlCellRuns via parseMd', () => {
  it('preserves bold formatting from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><b>bold text</b></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'bold text', bold: true });
  });

  it('preserves italic formatting from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><em>italic</em></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'italic', italic: true });
  });

  it('preserves hyperlinks from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><a href="https://example.com">link</a></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'link', href: 'https://example.com' });
  });

  it('preserves nested formatting (bold + italic) from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><strong><em>both</em></strong></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'both', bold: true, italic: true });
  });

  it('preserves mixed content with plain and formatted text', () => {
    const tokens = parseMd('<table><tr><td>plain <b>bold</b> plain</td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(3);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'plain ' });
    expect(runs?.[1]).toMatchObject({ type: 'text', text: 'bold', bold: true });
    expect(runs?.[2]).toMatchObject({ type: 'text', text: ' plain' });
  });

  it('preserves strikethrough from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><s>deleted</s></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'deleted', strikethrough: true });
  });

  it('preserves code formatting from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td><code>x = 1</code></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ type: 'text', text: 'x = 1', code: true });
  });

  it('preserves superscript and subscript from HTML table cells', () => {
    const tokens = parseMd('<table><tr><td>H<sub>2</sub>O is x<sup>2</sup></td></tr></table>');
    const table = tokens.find(t => t.type === 'table');
    const runs = table?.rows?.[0].cells[0].runs;

    expect(runs?.find(r => r.text === '2' && (r as any).subscript)).toBeTruthy();
    expect(runs?.find(r => r.text === '2' && (r as any).superscript)).toBeTruthy();
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

  it('exports HTML table blocks to DOCX tables', async () => {
    const markdown = '<table><tr><th>H1</th><th>H2</th></tr><tr><td>A</td><td>B</td></tr></table>';
    const result = await convertMdToDocx(markdown);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const document = await zip.files['word/document.xml'].async('string');

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('H1');
    expect(document).toContain('H2');
    expect(document).toContain('A');
    expect(document).toContain('B');
  });

  it('exports HTML tables with thead/tbody structure', async () => {
    const markdown = '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>';
    const result = await convertMdToDocx(markdown);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const document = await zip.files['word/document.xml'].async('string');

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('Col');
    expect(document).toContain('Val');
  });

  it('exports HTML tables with colspan/rowspan to correct OOXML', async () => {
    const markdown = '<table><tr><td colspan="2">Span</td></tr><tr><td rowspan="2">Left</td><td>Right</td></tr><tr><td>Bottom</td></tr></table>';
    const result = await convertMdToDocx(markdown);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const document = await zip.files['word/document.xml'].async('string');

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('<w:tblGrid>');
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:vMerge/>');
    expect(document).toContain('Span');
    expect(document).toContain('Left');
    expect(document).toContain('Right');
    expect(document).toContain('Bottom');
  });
});

describe('CriticMarkup OOXML generation', () => {
  const createState = () => ({
    commentId: 0,
    comments: [] as { id: number; author: string; date: string; text: string }[],
    commentIdMap: new Map<string, number>(),
    relationships: new Map(),
    nextRId: 1, rIdOffset: 3,
    warnings: [],
    hasList: false,
    hasComments: false,
    missingKeys: new Set<string>()
  });

  it('generates w:ins for additions', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_add', text: 'added text', author: 'John', date: '2024-01-01T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:ins w:id="0" w:author="John" w:date="2024-01-01T00:00:00Z">');
    expect(result).toContain('added text');
    expect(result).toContain('</w:ins>');
  });

  it('generates w:del with w:delText for deletions', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_del', text: 'deleted text', author: 'Jane', date: '2024-01-02T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del w:id="0" w:author="Jane" w:date="2024-01-02T00:00:00Z">');
    expect(result).toContain('<w:delText xml:space="preserve">deleted text</w:delText>');
    expect(result).toContain('</w:del>');
  });

  it('generates w:del + w:ins for substitutions', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_sub', text: 'old text', newText: 'new text', author: 'Bob', date: '2024-01-03T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del w:id="0" w:author="Bob" w:date="2024-01-03T00:00:00Z">');
    expect(result).toContain('<w:delText xml:space="preserve">old text</w:delText>');
    expect(result).toContain('<w:ins w:id="1" w:author="Bob" w:date="2024-01-03T00:00:00Z">');
    expect(result).toContain('new text');
  });

  it('generates comment anchors and comments.xml entries', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_comment', text: 'highlighted text', commentText: 'This is a comment', author: 'Alice', date: '2024-01-04T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:commentRangeStart w:id="0"/>');
    expect(result).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(result).toContain('<w:commentReference w:id="0"/>');
    expect(result).toContain('highlighted text');
    expect(state.hasComments).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]).toEqual({
      id: 0,
      author: 'Alice',
      date: '2024-01-04T00:00:00Z',
      text: 'This is a comment'
    });
  });

  it('generates zero-width comment for standalone comments', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_comment', text: '', commentText: 'Standalone comment', author: 'Charlie', date: '2024-01-05T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).not.toContain('<w:commentRangeStart');
    expect(result).not.toContain('<w:commentRangeEnd');
    expect(result).toContain('<w:commentReference w:id="0"/>');
    expect(state.comments[0].text).toBe('Standalone comment');
  });

  it('uses author attribution from CriticMarkup', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_add', text: 'text', author: 'SpecificAuthor' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'DefaultAuthor' });
    expect(result).toContain('w:author="SpecificAuthor"');
  });

  it('falls back to options.authorName', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_add', text: 'text' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'FallbackAuthor' });
    expect(result).toContain('w:author="FallbackAuthor"');
  });

  it('generates highlighted text for critic_highlight', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_highlight', text: 'highlighted text', highlightColor: 'green' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:highlight w:val="green"/>');
    expect(result).toContain('highlighted text');
    expect(result).not.toContain('<w:ins');
    expect(result).not.toContain('<w:del');
  });
});

describe('preprocessCriticMarkup', () => {
  it('returns unchanged text when no CriticMarkup markers present', () => {
    const input = 'Hello world\n\nSecond paragraph';
    expect(preprocessCriticMarkup(input)).toBe(input);
  });

  it('returns unchanged text for single-line CriticMarkup', () => {
    const input = 'Some {>>comment<<} here';
    expect(preprocessCriticMarkup(input)).toBe(input);
  });

  it('replaces \\n\\n inside a multi-paragraph comment', () => {
    const input = '{>>para 1\n\npara 2<<}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
    expect(result).toContain('{>>');
    expect(result).toContain('<<}');
  });

  it('replaces \\n\\n inside a multi-paragraph highlight', () => {
    const input = '{==text\n\nmore text==}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('replaces \\n\\n inside a multi-paragraph addition', () => {
    const input = '{++added\n\nmore++}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('replaces \\n\\n inside a multi-paragraph deletion', () => {
    const input = '{--deleted\n\nmore--}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('replaces \\n\\n inside a multi-paragraph substitution', () => {
    const input = '{~~old\n\ntext~>new\n\ntext~~}';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
  });

  it('handles mid-line multi-paragraph span', () => {
    const input = 'some text {>>comment\n\npara 2<<} more text';
    const result = preprocessCriticMarkup(input);
    expect(result).not.toContain('\n\n');
    expect(result).toStartWith('some text {>>');
    expect(result).toEndWith('<<} more text');
  });
});

describe('parseMd multi-paragraph CriticMarkup', () => {
  it('parses multi-paragraph comment as single token', () => {
    const tokens = parseMd('{>>para 1\n\npara 2<<}');
    // Should produce a single paragraph (not split across multiple)
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
  });

  it('parses multi-paragraph highlight as single token', () => {
    const tokens = parseMd('{==text\n\nmore text==}');
    const highlightRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_highlight');
    expect(highlightRuns.length).toBe(1);
  });

  it('parses mid-line multi-paragraph comment', () => {
    const tokens = parseMd('some text {>>comment\n\npara 2<<} more text');
    const allRuns = tokens.flatMap(t => t.runs);
    const commentRuns = allRuns.filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    const textRuns = allRuns.filter(r => r.type === 'text');
    expect(textRuns.some(r => r.text.includes('some text'))).toBe(true);
    expect(textRuns.some(r => r.text.includes('more text'))).toBe(true);
  });

  it('parses highlight + multi-paragraph comment', () => {
    const tokens = parseMd('{==highlighted==}{>>para 1\n\npara 2<<}');
    const allRuns = tokens.flatMap(t => t.runs);
    const highlightRuns = allRuns.filter(r => r.type === 'critic_highlight');
    const commentRuns = allRuns.filter(r => r.type === 'critic_comment');
    expect(highlightRuns.length).toBe(1);
    expect(commentRuns.length).toBe(1);
  });

  it('does not treat adjacent Critic deletion as a highlight color suffix', () => {
    const tokens = parseMd('==a=={--a--}');
    const allRuns = tokens.flatMap(t => t.runs);
    const highlightRuns = allRuns.filter(r => r.type === 'critic_highlight');
    const deletionRuns = allRuns.filter(r => r.type === 'critic_del');
    expect(highlightRuns.length).toBe(1);
    expect(highlightRuns[0].text).toBe('a');
    expect(highlightRuns[0].highlightColor).toBeUndefined();
    expect(deletionRuns.length).toBe(1);
    expect(deletionRuns[0].text).toBe('a');
  });

  it('parses multi-paragraph addition', () => {
    const tokens = parseMd('{++added\n\nmore++}');
    const addRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_add');
    expect(addRuns.length).toBe(1);
  });

  it('parses multi-paragraph deletion', () => {
    const tokens = parseMd('{--deleted\n\nmore--}');
    const delRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_del');
    expect(delRuns.length).toBe(1);
  });

  it('parses multi-paragraph substitution', () => {
    const tokens = parseMd('{~~old\n\ntext~>new\n\ntext~~}');
    const subRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_sub');
    expect(subRuns.length).toBe(1);
  });

  it('parses multi-paragraph comment with author attribution', () => {
    const tokens = parseMd('{>>Alice (2024-01-15T10:00:00Z): para 1\n\npara 2<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    expect(commentRuns[0].author).toBe('Alice');
    expect(commentRuns[0].date).toBe('2024-01-15T10:00:00Z');
  });

  it('does not leak placeholder into comment text', () => {
    const tokens = parseMd('{>>Alice (2024-01-15T10:00:00Z): para 1\n\npara 2<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns[0].commentText).not.toContain('\u0000');
    expect(commentRuns[0].commentText).not.toContain('PARA');
    expect(commentRuns[0].commentText).toContain('para 1\n\npara 2');
  });

  it('does not leak placeholder into addition text', () => {
    const tokens = parseMd('{++added\n\nmore++}');
    const addRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_add');
    expect(addRuns[0].text).not.toContain('\u0000');
    expect(addRuns[0].text).not.toContain('PARA');
    expect(addRuns[0].text).toContain('added\n\nmore');
  });
});

describe('Footnote parsing', () => {
  it('parseMd produces footnote_ref runs for [^1]', () => {
    const tokens = parseMd('Hello[^1] world');
    const runs = tokens.flatMap(t => t.runs);
    const fnRef = runs.find(r => r.type === 'footnote_ref');
    expect(fnRef).toBeDefined();
    expect(fnRef!.footnoteLabel).toBe('1');
  });

  it('parseMd produces footnote_ref runs for named labels', () => {
    const tokens = parseMd('Text[^my-note] more');
    const runs = tokens.flatMap(t => t.runs);
    const fnRef = runs.find(r => r.type === 'footnote_ref');
    expect(fnRef).toBeDefined();
    expect(fnRef!.footnoteLabel).toBe('my-note');
  });

  it('does not parse [^label]: as a footnote reference', () => {
    // Definition lines are stripped by extractFootnoteDefinitions, not parsed as refs
    const input = 'Some text.\n\n[^1]: This is a definition.';
    const { cleaned } = extractFootnoteDefinitions(input);
    const tokens = parseMd(cleaned);
    const runs = tokens.flatMap(t => t.runs);
    const fnRef = runs.find(r => r.type === 'footnote_ref');
    expect(fnRef).toBeUndefined();
  });
});

describe('extractFootnoteDefinitions', () => {
  it('extracts single-line definition', () => {
    const input = 'Body text.\n\n[^1]: This is a footnote.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('This is a footnote.');
    expect(cleaned).toBe('Body text.\n');
  });

  it('extracts multi-paragraph definition', () => {
    const input = 'Text.\n\n[^1]: First paragraph.\n\n    Second paragraph.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('First paragraph.\n\nSecond paragraph.');
    expect(cleaned).toBe('Text.\n');
  });

  it('extracts multiple definitions', () => {
    const input = 'Text.\n\n[^1]: Note one.\n[^2]: Note two.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.size).toBe(2);
    expect(definitions.get('1')).toBe('Note one.');
    expect(definitions.get('2')).toBe('Note two.');
  });

  it('extracts named label definitions', () => {
    const input = 'Text.\n\n[^my-note]: Named footnote.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('my-note')).toBe('Named footnote.');
  });

  it('returns empty definitions for no footnotes', () => {
    const input = 'Just plain text.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.size).toBe(0);
    expect(cleaned).toBe('Just plain text.');
  });
});

describe('Footnote OOXML generation', () => {
  it('generateRuns emits footnoteReference for footnote_ref runs', () => {
    const state = makeState();
    const runs: MdRun[] = [{ type: 'footnote_ref', text: '', footnoteLabel: '1' }];
    const xml = generateRuns(runs, state);
    expect(xml).toContain('w:footnoteReference');
    expect(xml).toContain('FootnoteReference');
    expect(state.hasFootnotes).toBe(true);
    expect(state.footnoteLabelToId.get('1')).toBe(1);
  });

  it('generateRuns emits endnoteReference in endnote mode', () => {
    const state = makeState();
    state.notesMode = 'endnotes';
    const runs: MdRun[] = [{ type: 'footnote_ref', text: '', footnoteLabel: '1' }];
    const xml = generateRuns(runs, state);
    expect(xml).toContain('w:endnoteReference');
    expect(xml).toContain('EndnoteReference');
    expect(state.hasEndnotes).toBe(true);
  });
});

describe('Full MD→DOCX footnote generation', () => {
  it('convertMdToDocx produces DOCX with word/footnotes.xml', async () => {
    const md = 'Hello[^1] world.\n\n[^1]: A footnote.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    expect(zip.file('word/footnotes.xml')).not.toBeNull();

    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
    expect(footnotesXml).toContain('w:footnoteRef');
    expect(footnotesXml).toContain('A footnote.');
  });

  it('endnote mode via notes: endnotes frontmatter', async () => {
    const md = '---\nnotes: endnotes\n---\n\nHello[^1] world.\n\n[^1]: An endnote.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    expect(zip.file('word/endnotes.xml')).not.toBeNull();
    expect(zip.file('word/footnotes.xml')).toBeNull();

    const endnotesXml = await zip.file('word/endnotes.xml')!.async('string');
    expect(endnotesXml).toContain('w:endnoteRef');
    expect(endnotesXml).toContain('An endnote.');
  });

  it('warns for orphaned footnote reference', async () => {
    const md = 'Text[^1] without definition.';
    const { warnings } = await convertMdToDocx(md);
    expect(warnings.some(w => w.includes('[^1]') && w.includes('no matching definition'))).toBe(true);
  });

  it('warns for orphaned footnote definition', async () => {
    const md = 'Text without reference.\n\n[^1]: Orphaned definition.';
    const { warnings } = await convertMdToDocx(md);
    expect(warnings.some(w => w.includes('[^1]') && w.includes('no matching reference'))).toBe(true);
  });

  it('stores MANUSCRIPT_FOOTNOTE_IDS for named labels', async () => {
    const md = 'Text[^my-note] here.\n\n[^my-note]: Named note.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customFile = zip.file('docProps/custom.xml');
    expect(customFile).not.toBeNull();
    const customXml = await customFile!.async('string');
    expect(customXml).toContain('MANUSCRIPT_FOOTNOTE_IDS');
    expect(customXml).toContain('my-note');
  });

  it('does not store MANUSCRIPT_FOOTNOTE_IDS for numeric-only labels', async () => {
    const md = 'Text[^1] here.\n\n[^1]: Numeric note.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customFile = zip.file('docProps/custom.xml');
    if (customFile) {
      const customXml = await customFile.async('string');
      expect(customXml).not.toContain('MANUSCRIPT_FOOTNOTE_IDS');
    }
  });
});

describe('Footnote round-trip', () => {
  it('MD→DOCX→MD preserves footnotes', async () => {
    const md = 'Hello[^1] world.\n\n[^1]: A footnote.';
    const { docx } = await convertMdToDocx(md);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('[^1]');
    expect(result.markdown).toContain('[^1]: A footnote.');
  });

  it('MD→DOCX→MD preserves named labels via MANUSCRIPT_FOOTNOTE_IDS', async () => {
    const md = 'Text[^my-note] here.\n\n[^my-note]: Named note content.';
    const { docx } = await convertMdToDocx(md);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);

    expect(result.markdown).toContain('[^my-note]');
    expect(result.markdown).toContain('[^my-note]: Named note content.');
  });
});