import { describe, it, expect, afterEach } from 'bun:test';
import * as fc from 'fast-check';
import { XMLValidator } from 'fast-xml-parser';
import { LATENT_STYLES } from './latent-styles';
import {
  generateRPr,
  generateRun,
  generateRuns,
  generateParagraph,
  generateTable,
  generateDocumentXml,
  convertMdToDocx,
  parseMd,
  extractFootnoteDefinitions,
  PARA_PLACEHOLDER,
  LINE_PLACEHOLDER,
  preprocessCriticMarkup,
  preprocessGridTables,
  stylesXml,
  applyAlertColorsToTemplate,
  parseTemplatePgSz,
  type MdRun,
  type MdToken,
  type MdTableRow,
  type DocxGenState
} from './md-to-docx';
import { type GfmAlertType } from './gfm';
import { parseFrontmatter, serializeFrontmatter, parseColWidths, expandColWidths, colWidthsToPct } from './frontmatter';
import { alertColorsByScheme, setDefaultColorScheme, getDefaultColorScheme, GITHUB_ALERT_COLORS, GUTTMACHER_ALERT_COLORS } from './alert-colors';

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
    listStartOverrides: [],
    hasComments: false,
    hasFootnotes: false,
    hasEndnotes: false,
    footnoteId: 1,
    footnoteEntries: [],
    footnoteLabelToId: new Map(),
    notesMode: 'footnotes',
    missingKeys: new Set(),
    replyRanges: [],
    nextParaId: 1,
    codeBlockIndex: 0,
    codeBlockLanguages: new Map(),
    codeFont: 'Consolas',
    codeShadingMode: false,
    citationIds: new Set(),
    citedKeys: new Set(),
    citationItemIds: new Map(),
    blockquoteGaps: new Map(),
    blockquotePostContentBlankLines: new Map(),
    blockquoteAlertMarkerInlineByGroup: new Map(),
    imageRelationships: new Map(),
    imageMediaPaths: new Map(),
    imageBinaries: new Map(),
    imageFormats: new Map(),
    noteImageFormats: new Map(),
    imageExtensions: new Set(),
    rsid: '00000001',
    nextImageDocPrId: 1,
    tableIndex: 0,
    tableFormats: new Map(),
    consecutiveReplyParaIds: new Set(),
    htmlCommentGaps: new Map(),
    htmlCommentAfterGaps: new Map(),
    listIndent: 'spaces',
    tableFontSizes: new Map(),
    tableFonts: new Map(),
    tableColWidths: new Map(),
    tableDigits: new Map(),
    tableDecimalMarks: new Map(),
    tableDigitGroupings: new Map(),
    tableRunRPrExtra: '',
    landscapeTables: new Set(),
    portraitTables: new Set(),
    inLandscapeSection: false,
    inPortraitSection: false,
    sectionBreakOrdinal: 0,
    portraitBreakOrdinals: new Set(),
    blockquotePreContentBlankLines: new Map(),
    pipeTableAligned: new Map(),
    gridSourceColWidths: new Map(),
    sentinelGaps: {},
    customStyles: undefined,
    activeListStartOverrides: new Map(),
    inNoteBody: false,
    noteRelationships: new Map(),
    noteImageRelationships: new Map(),
    noteNextRId: 1,
    footnoteCrossRefLabels: new Set(),
    nextBookmarkId: 0,
    indentMode: false,
    afterHeading: false,
    indentOverrides: new Map(),
    bodyParagraphIndex: 0,
    listIndentOverrides: new Map(),
    listBlockIndex: 0,
    embedDirectiveMap: new Map(),
    embedDirectives: [],
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

describe('GFM support in Markdown→DOCX parser', () => {
  it('parses bare URLs as links (autolink literals)', () => {
    const tokens = parseMd('Visit https://example.com for docs.');
    const hrefRun = tokens[0].runs.find(run => run.href === 'https://example.com');
    expect(hrefRun).toBeDefined();
    expect(hrefRun?.text).toBe('https://example.com');
  });

  it('parses task list markers semantically and strips literal marker text', () => {
    const tokens = parseMd('- [x] done\n- [ ] todo');
    const listItems = tokens.filter(t => t.type === 'list_item');
    expect(listItems).toHaveLength(2);
    expect(listItems[0].taskChecked).toBe(true);
    expect(listItems[1].taskChecked).toBe(false);
    expect(listItems[0].runs.map(r => r.text).join('')).toContain('done');
    expect(listItems[0].runs.map(r => r.text).join('')).not.toContain('[x]');
    expect(listItems[1].runs.map(r => r.text).join('')).toContain('todo');
    expect(listItems[1].runs.map(r => r.text).join('')).not.toContain('[ ]');
  });

  it('does not promote nested sublist paragraph to parent list item', () => {
    // Parent has no direct text — only a nested sublist.
    // The child's paragraph must NOT be captured as the parent's runs.
    const tokens = parseMd('- parent\n  - child text\n');
    const items = tokens.filter(t => t.type === 'list_item');
    expect(items).toHaveLength(2);
    expect(items[0].runs.map(r => r.text).join('')).toBe('parent');
    expect(items[1].runs.map(r => r.text).join('')).toBe('child text');
  });

  it('parent list item with only a nested sublist gets empty runs', () => {
    // A list item whose only content is a nested sublist should have empty runs.
    const md = '- - child only\n';
    const tokens = parseMd(md);
    const items = tokens.filter(t => t.type === 'list_item');
    // The outer item should have no text runs (it has no direct paragraph)
    const outerItem = items.find(i => i.level === 1);
    expect(outerItem).toBeDefined();
    expect(outerItem!.runs.map(r => r.text).join('')).toBe('');
    // The nested child item should exist and contain the expected text
    const childItem = items.find(i => i.level === 2);
    expect(childItem).toBeDefined();
    expect(childItem!.runs.map(r => r.text).join('')).toBe('child only');
  });

  it('preserves blockquote continuation blocks inside list items', () => {
    const warnings: string[] = [];
    const tokens = parseMd('* **Clinical phrasing:**\n  > quoted line\n', warnings);
    expect(warnings).toEqual([]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({
      type: 'list_item',
      level: 1,
      ordered: false,
    });
    expect(tokens[1]).toMatchObject({
      type: 'blockquote',
      level: 1,
      listContinuation: { type: 'bullet', level: 1 },
    });
    expect(tokens[1].runs.map(r => r.text).join('')).toBe('quoted line');
  });

  it('preserves alert blockquote continuation blocks inside list items', () => {
    const warnings: string[] = [];
    const tokens = parseMd('* Clinical phrasing:\n  > [!WARNING]\n  > quoted line\n', warnings);
    expect(warnings).toEqual([]);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatchObject({
      type: 'blockquote',
      level: 1,
      alertType: 'warning',
      alertLead: true,
      listContinuation: { type: 'bullet', level: 1 },
    });
    expect(tokens[1].runs.map(r => r.text).join('').trim()).toBe('quoted line');
  });

  it('preserves source order when a nested sublist comes before a continuation blockquote', () => {
    const tokens = parseMd('- parent\n  - child\n  > quoted line\n');
    expect(tokens.map(t => t.type + ':' + (t.level || 0))).toEqual([
      'list_item:1',
      'list_item:2',
      'blockquote:1',
    ]);
  });

  it('preserves source order when a continuation blockquote comes before a nested sublist', () => {
    const tokens = parseMd('- parent\n  > quoted line\n  - child\n');
    expect(tokens.map(t => t.type + ':' + (t.level || 0))).toEqual([
      'list_item:1',
      'blockquote:1',
      'list_item:2',
    ]);
  });

  it('escapes GFM-disallowed raw HTML tags into literal text runs', () => {
    const tokens = parseMd('<script>alert(1)</script>');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('paragraph');
    expect(tokens[0].runs[0]).toMatchObject({ type: 'text', text: '<script>alert(1)</script>' });
  });

  it('preserves inline HTML-like text tokens as literal text runs', () => {
    const tokens = parseMd('A <tag> B');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].runs.map(r => r.text).join('')).toBe('A <tag> B');
  });

  it('preserves non-table HTML blocks as literal text', () => {
    const tokens = parseMd('<div>alpha</div>');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('paragraph');
    expect(tokens[0].runs[0]).toMatchObject({ type: 'text', text: '<div>alpha</div>' });
  });

  it('keeps multiline Critic-shaped text inside raw HTML blocks literal', () => {
    const input = '<pre>\n{++a\nb++}\n</pre>';
    const tokens = parseMd(input);
    const runs = tokens.flatMap(token => token.runs);

    expect(runs.map(run => run.text).join('')).toBe(input);
    expect(runs.some(run => run.type === 'critic_add')).toBe(false);
    expect(runs.map(run => run.text).join('')).not.toContain(LINE_PLACEHOLDER);
  });

  it('parses alert blockquotes and strips raw [!TYPE] marker text', () => {
    const tokens = parseMd('> [!WARNING]\n> Heads up');
    const blockquoteTokens = tokens.filter(t => t.type === 'blockquote');
    expect(blockquoteTokens.length).toBeGreaterThan(0);
    expect(blockquoteTokens[0].alertType).toBe('warning');
    expect(blockquoteTokens[0].alertLead).toBe(true);
    expect(blockquoteTokens.map(t => t.runs.map(r => r.text).join('')).join('\n')).not.toContain('[!WARNING]');
  });

  it('splits merged blockquotes with multiple alert markers into separate tokens', () => {
    const md = '> [!NOTE]\n> A note.\n> [!WARNING]\n> A warning.\n> [!TIP]\n> A tip.';
    const tokens = parseMd(md);
    const bqTokens = tokens.filter(t => t.type === 'blockquote');
    const noteTokens = bqTokens.filter(t => t.alertType === 'note');
    const warningTokens = bqTokens.filter(t => t.alertType === 'warning');
    const tipTokens = bqTokens.filter(t => t.alertType === 'tip');
    expect(noteTokens.length).toBeGreaterThan(0);
    expect(warningTokens.length).toBeGreaterThan(0);
    expect(tipTokens.length).toBeGreaterThan(0);
    expect(noteTokens[0].alertLead).toBe(true);
    expect(warningTokens[0].alertLead).toBe(true);
    expect(tipTokens[0].alertLead).toBe(true);
  });

  it('marks alertFirst/alertLast boundaries on contiguous alert blockquotes', () => {
    const md = '> [!NOTE]\n> Line one.\n>\n> Line two.';
    const tokens = parseMd(md);
    const bqTokens = tokens.filter(t => t.type === 'blockquote');
    expect(bqTokens.length).toBeGreaterThanOrEqual(2);
    expect(bqTokens[0].alertFirst).toBe(true);
    expect(bqTokens[bqTokens.length - 1].alertLast).toBe(true);
  });

  it('marks alertFirst/alertLast on plain blockquotes too', () => {
    const md = '> Plain quote.';
    const tokens = parseMd(md);
    const bqTokens = tokens.filter(t => t.type === 'blockquote');
    expect(bqTokens.length).toBeGreaterThan(0);
    expect(bqTokens[0].alertFirst).toBe(true);
    expect(bqTokens[bqTokens.length - 1].alertLast).toBe(true);
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

    // Should produce: bold "A & B", hardbreak (HTML <br> is always a hard break), plain "line"
    expect(cellRuns).toHaveLength(3);
    expect(cellRuns?.[0]).toMatchObject({ type: 'text', text: 'A & B', bold: true });
    expect(cellRuns?.[1]).toMatchObject({ type: 'hardbreak' });
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

describe('parseMd table-col-widths directive', () => {
  it('keeps the closest duplicate numeric-format directive', () => {
    const markdown = [
      '<!-- table-digits: 1 -->', '<!-- table-digits: 3 -->',
      '<!-- table-decimal-mark: comma -->', '<!-- table-decimal-mark: midpoint -->',
      '<!-- table-digit-grouping: comma -->', '<!-- table-digit-grouping: thin-space -->',
      '| V |', '| --- |', '| 1234.5678 |',
    ].join('\n');
    const table = parseMd(markdown).find(token => token.type === 'table');
    expect(table?.tableDigits).toBe(3);
    expect(table?.tableDecimalMark).toBe('midpoint');
    expect(table?.tableDigitGrouping).toBe('thin-space');
  });

  it('reports an invalid numeric-format directive once during conversion', async () => {
    const markdown = '<!-- table-digits: nope -->\n| V |\n| --- |\n| 12.34 |';
    const result = await convertMdToDocx(markdown);
    expect(result.warnings.filter(warning => warning.includes('table-digits: nope'))).toHaveLength(1);
  });

  it('transfers <!-- table-col-widths --> directive to table token', () => {
    const md = '<!-- table-col-widths: 2 1 1 -->\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |';
    const tokens = parseMd(md);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.tableColWidths).toEqual([2, 1, 1]);
    // Directive should be consumed (not remain as a paragraph)
    expect(tokens.filter(t => t.type === 'paragraph').length).toBe(0);
  });

  it('parses equal directive', () => {
    const md = '<!-- table-col-widths: equal -->\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const tokens = parseMd(md);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.tableColWidths).toBe('equal');
  });

  it('parses auto directive', () => {
    const md = '<!-- table-col-widths: auto -->\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const tokens = parseMd(md);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.tableColWidths).toBe('auto');
  });

  it('parses data-col-widths on HTML table', () => {
    const md = '<table data-col-widths="2,1,1"><tr><td>A</td><td>B</td><td>C</td></tr></table>';
    const tokens = parseMd(md);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.tableColWidths).toEqual([2, 1, 1]);
  });

  it('parses data-col-widths equal on HTML table', () => {
    const md = '<table data-col-widths="equal"><tr><td>A</td><td>B</td></tr></table>';
    const tokens = parseMd(md);
    const table = tokens.find(t => t.type === 'table');
    expect(table?.tableColWidths).toBe('equal');
  });

  it('does not consume invalid col-widths directive and emits warning', () => {
    const md = '<!-- table-col-widths: 2x 1 1 -->\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |';
    const warnings: string[] = [];
    const tokens = parseMd(md, warnings);
    const table = tokens.find(t => t.type === 'table');
    // Invalid directive should not be consumed — table gets no col widths
    expect(table?.tableColWidths).toBeUndefined();
    // The directive paragraph should still be present
    const paras = tokens.filter(t => t.type === 'paragraph');
    expect(paras.length).toBeGreaterThan(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Invalid');
    expect(warnings[0]).toContain('2x 1 1');
  });
});

describe('parseMd grid tables', () => {
  it('parses a grid table with header', () => {
    const markdown = [
      '+------+------+',
      '| H1   | H2   |',
      '+======+======+',
      '| A    | B    |',
      '+------+------+',
    ].join('\n');
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');

    expect(table).toBeDefined();
    expect(table?.sourceFormat).toBe('grid');
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows?.[0].header).toBe(true);
    expect(table?.rows?.[0].cells[0].runs[0].text).toBe('H1');
    expect(table?.rows?.[1].header).toBe(false);
    expect(table?.rows?.[1].cells[1].runs[0].text).toBe('B');
  });

  it('parses multi-line cells in grid tables', () => {
    const markdown = [
      '+----------+----------+',
      '| Header 1 | Header 2 |',
      '+==========+==========+',
      '| Cell 1   | Cell 2   |',
      '|          | line 2   |',
      '+----------+----------+',
    ].join('\n');
    const tokens = parseMd(markdown);
    const table = tokens.find(t => t.type === 'table');

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
    // Multi-line cell: runs should contain the text
    const bodyRow = table?.rows?.[1];
    expect(bodyRow?.cells).toHaveLength(2);
  });

  it('preprocessGridTables replaces grid tables with placeholders', () => {
    const markdown = 'Before\n\n+------+------+\n| H1   | H2   |\n+======+======+\n| A    | B    |\n+------+------+\n\nAfter';
    const result = preprocessGridTables(markdown);
    expect(result).toContain('<!-- MANUSCRIPT_GRID_TABLE:');
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('+------+');
  });

  it('leaves non-grid-table content unchanged', () => {
    const markdown = '| H1 | H2 |\n| --- | --- |\n| A | B |';
    const result = preprocessGridTables(markdown);
    expect(result).toBe(markdown);
  });
});

describe('generateRun', () => {
  it('generates basic run', () => {
    const result = generateRun('hello', '');
    expect(result).toBe('<w:r><w:t>hello</w:t></w:r>');
  });

  it('generates run with formatting', () => {
    const result = generateRun('bold', '<w:rPr><w:b/></w:rPr>');
    expect(result).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>');
  });

  it('escapes XML characters', () => {
    const result = generateRun('<test> & "quotes"', '');
    // Quotes don't need escaping in element text (only in attributes).
    // Using &quot; triggers Word's dirty flag.
    expect(result).toBe('<w:r><w:t>&lt;test&gt; &amp; "quotes"</w:t></w:r>');
  });
});

describe('generateParagraph', () => {
  const createState = () => ({ ...makeState(), rIdOffset: 3 });

  it('generates basic paragraph', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'text', text: 'Hello world' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>');
  });

  it('collapses spacing on pure HTML-comment paragraphs', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'html_comment', text: '<!-- Begin Table 1 -->' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toContain('<w:spacing w:after="0" w:line="1" w:lineRule="exact"/>');
  });

  it('collapses spacing on paragraphs with multiple HTML-comment runs', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'html_comment', text: '<!-- comment 1 -->' },
        { type: 'html_comment', text: '<!-- comment 2 -->' },
      ]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toContain('<w:spacing w:after="0" w:line="1" w:lineRule="exact"/>');
  });

  it('does not collapse spacing on paragraphs with mixed runs including html_comment', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'Hello' },
        { type: 'html_comment', text: '<!-- note -->' },
      ]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).not.toContain('w:lineRule="exact"');
  });

  it('generates heading level 1', () => {
    const token: MdToken = {
      type: 'heading',
      level: 1,
      runs: [{ type: 'text', text: 'Title' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>');
  });

  it('generates heading level 6', () => {
    const token: MdToken = {
      type: 'heading',
      level: 6,
      runs: [{ type: 'text', text: 'Subtitle' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="Heading6"/></w:pPr><w:r><w:t>Subtitle</w:t></w:r></w:p>');
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
    expect(result).toBe('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item 1</w:t></w:r></w:p>');
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
    expect(result).toBe('<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Item 2</w:t></w:r></w:p>');
    expect(state.hasList).toBe(true);
  });

  it('generates unchecked task list item with indent and checkbox prefix', () => {
    const token: MdToken = {
      type: 'list_item',
      level: 1,
      taskChecked: false,
      runs: [{ type: 'text', text: 'todo item' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">☐ </w:t></w:r>' +
      '<w:r><w:t>todo item</w:t></w:r></w:p>'
    );
    expect(state.hasList).toBe(false);
  });

  it('generates checked task list item with indent and checkbox prefix', () => {
    const token: MdToken = {
      type: 'list_item',
      level: 1,
      taskChecked: true,
      runs: [{ type: 'text', text: 'done item' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">☒ </w:t></w:r>' +
      '<w:r><w:t>done item</w:t></w:r></w:p>'
    );
    expect(state.hasList).toBe(false);
  });

  it('generates blockquote', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      runs: [{ type: 'text', text: 'Quote text' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="GitHubBlockquote"/></w:pPr><w:r><w:t>Quote text</w:t></w:r></w:p>');
  });

  it('generates nested blockquote', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 3,
      runs: [{ type: 'text', text: 'Nested quote' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:pPr><w:pStyle w:val="GitHubBlockquote"/><w:spacing w:after="0"/><w:ind w:left="720"/></w:pPr><w:r><w:t>Nested quote</w:t></w:r></w:p>');
  });

  it('generates alert blockquote with GitHub alert style and title prefix', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'caution',
      alertLead: true,
      runs: [{ type: 'text', text: 'Watch out' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toContain('w:pStyle w:val=\"GitHubCaution\"');
    expect(result).toContain('⛒ Caution');
    expect(result).toContain('<w:br/>');
    expect(result).toContain('Watch out');
  });

  it('includes generated alert labels by default', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'note',
      alertLead: true,
      runs: [{ type: 'text', text: 'Content' }]
    };
    const result = generateParagraph(token, createState());
    expect(result).toContain('※ Note');
    expect(result).toContain('<w:r><w:br/></w:r>');
  });

  it('includes generated alert labels when explicitly enabled', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'note',
      alertLead: true,
      runs: [{ type: 'text', text: 'Content' }]
    };
    const result = generateParagraph(token, createState(), { calloutLabels: true });
    expect(result).toContain('※ Note');
    expect(result).toContain('<w:r><w:br/></w:r>');
  });

  it('omits only the generated alert label and following break when disabled', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'note',
      alertLead: true,
      alertFirst: true,
      alertLast: true,
      runs: [{ type: 'text', text: 'Content' }]
    };
    const result = generateParagraph(token, createState(), { calloutLabels: false, colors: 'github' });
    expect(result).not.toContain('※ Note');
    expect(result).not.toContain('<w:br/>');
    expect(result).toContain('w:pStyle w:val="GitHubNote"');
    expect(result).toContain('w:color="' + GITHUB_ALERT_COLORS.note + '"');
    expect(result.match(/w:line="1" w:lineRule="exact"/g)).toHaveLength(2);
    expect(result).toContain('Content');
  });

  it('generates bold colored alert title prefix', () => {
    for (const [type, color] of Object.entries(GITHUB_ALERT_COLORS)) {
      const token: MdToken = {
        type: 'blockquote',
        level: 1,
        alertType: type as GfmAlertType,
        alertLead: true,
        runs: [{ type: 'text', text: 'Content' }]
      };
      const result = generateParagraph(token, createState(), { colors: 'github' });
      expect(result).toContain('<w:b/>');
      expect(result).toContain('w:color w:val="' + color + '"');
    }
  });

  it('emits spacer paragraphs for alertFirst/alertLast blockquotes', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertType: 'note',
      alertLead: true,
      alertFirst: true,
      alertLast: true,
      runs: [{ type: 'text', text: 'Note text' }]
    };
    const result = generateParagraph(token, createState(), { colors: 'github' });
    // Should contain two spacer paragraphs (before and after)
    const spacerPattern = /w:line="1" w:lineRule="exact"/g;
    const spacers = result.match(spacerPattern);
    expect(spacers).toHaveLength(2);
    // Spacers carry inline pBdr with alert border color, not pStyle
    expect(result).toContain('w:color="' + GITHUB_ALERT_COLORS.note + '"');
    // The content paragraph should NOT have a spacer style
    expect((result.match(/w:pStyle/g) || []).length).toBe(1);
  });

  it('spacer paragraphs use correct border color for plain blockquotes', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      alertFirst: true,
      alertLast: true,
      runs: [{ type: 'text', text: 'Plain quote' }]
    };
    const result = generateParagraph(token, createState());
    expect(result).toContain('w:color="D0D7DE"');
  });

  it('generates list continuation blockquote with adjusted structural indent', () => {
    const token: MdToken = {
      type: 'blockquote',
      level: 1,
      blockquoteGroupIndex: 7,
      listContinuation: { type: 'bullet', level: 1 },
      runs: [{ type: 'text', text: 'Quoted in list' }]
    };
    const result = generateParagraph(token, createState());
    expect(result).toContain('<w:pPr><w:pStyle w:val="GitHubBlockquote"/><w:spacing w:after="0"/><w:ind w:left="960"/></w:pPr>');
    expect(result).not.toContain('_bqg');
    expect(result).not.toContain('_lic:');
    expect(result).not.toContain('<w:numPr>');
  });

  it('generates code block with multiple lines', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'line1\nline2\nline3' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>line1</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>line2</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>line3</w:t></w:r></w:p>'
    );
  });

  it('generates single-line code block with before and after spacing', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'solo line' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>solo line</w:t></w:r></w:p>'
    );
  });

  it('generates two-line code block with first and last spacing', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'first\nsecond' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>first</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>second</w:t></w:r></w:p>'
    );
  });

  it('generates empty code block with before and after spacing', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: '' }]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="160" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t></w:t></w:r></w:p>'
    );
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
    expect(result).toBe('<w:p><w:hyperlink r:id="rId4"><w:r><w:t>Link text</w:t></w:r></w:hyperlink></w:p>');
    expect(state.relationships.get('https://example.com')).toBe('rId4');
  });

  it('generates softbreak as space', () => {
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
    expect(result).toBe('<w:p><w:r><w:t>Line 1</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>Line 2</w:t></w:r></w:p>');
  });

  it('generates hardbreak as w:br', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'Line 1' },
        { type: 'hardbreak', text: '\n' },
        { type: 'text', text: 'Line 2' }
      ]
    };
    const state = createState();
    const result = generateParagraph(token, state);
    expect(result).toBe('<w:p><w:r><w:t>Line 1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Line 2</w:t></w:r></w:p>');
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
    expect(result).toContain('<w:tblLook w:val="0020" w:firstRow="1"/>');
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
    // gridCol elements have explicit dxa widths (equal: 9360/2 = 4680 each)
    expect(result).toContain('<w:gridCol w:w="4680"/>');
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
    // Grid should have 3 columns with explicit dxa widths (Word Online requirement)
    expect((result.match(/<w:gridCol w:w="\d+"\/>/g) || []).length).toBe(3);
    // 3 w:tr rows (2 explicit + vMerge continuation is implicit within the 2 rows)
    expect((result.match(/<w:tr>/g) || []).length).toBe(2);
  });

  it('emits tblGrid with dxa widths for Word Online even when no spans are present', () => {
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

    // tblGrid is always emitted (Word Online needs it to size columns correctly)
    expect(result).toContain('<w:tblGrid>');
    // gridCol elements have explicit dxa widths (equal: 9360/2 = 4680 each)
    expect(result).toContain('<w:gridCol w:w="4680"/><w:gridCol w:w="4680"/>');
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

  it('renders softbreaks as spaces in table cells', () => {
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
    expect(result).toContain('<w:t xml:space="preserve"> </w:t>');
    expect(result).toContain('line2');
    expect(result).not.toContain('<w:br/>');
  });

  it('renders hardbreaks as w:br in table cells', () => {
    const rows: MdTableRow[] = [
      {
        header: false,
        cells: [
          { runs: [
            { type: 'text', text: 'line1' },
            { type: 'hardbreak', text: '\n' },
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
    expect(result).not.toContain('<w:t xml:space="preserve"> </w:t>');
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

  it('emits column widths when tableColWidths is set', () => {
    const rows: MdTableRow[] = [
      { header: true, cells: [
        { runs: [{ type: 'text', text: 'A' }] },
        { runs: [{ type: 'text', text: 'B' }] },
        { runs: [{ type: 'text', text: 'C' }] },
      ] },
      { header: false, cells: [
        { runs: [{ type: 'text', text: '1' }] },
        { runs: [{ type: 'text', text: '2' }] },
        { runs: [{ type: 'text', text: '3' }] },
      ] },
    ];
    const token: MdToken = { type: 'table', runs: [], rows, tableColWidths: [2, 1, 1] };
    const result = generateTable(token, makeState());
    // tblW should be pct-based
    expect(result).toContain('<w:tblW w:w="5000" w:type="pct"/>');
    // gridCol elements have explicit dxa widths: [2,1,1] → pcts [2500,1250,1250] → dxa [4680,2340,2340]
    expect(result).toContain('<w:gridCol w:w="4680"/><w:gridCol w:w="2340"/><w:gridCol w:w="2340"/>');
    // Each cell should have tcW
    expect(result).toContain('<w:tcW w:w="2500" w:type="pct"/>');
    expect(result).toContain('<w:tcW w:w="1250" w:type="pct"/>');
  });

  it('colspan cell sums spanned column widths', () => {
    const rows: MdTableRow[] = [
      { header: false, cells: [
        { runs: [{ type: 'text', text: 'span' }], colspan: 2 },
        { runs: [{ type: 'text', text: 'C' }] },
      ] },
    ];
    const token: MdToken = { type: 'table', runs: [], rows, tableColWidths: [2, 1, 1] };
    const result = generateTable(token, makeState());
    // The colspan=2 cell should sum cols 0+1 = 2500+1250 = 3750
    expect(result).toContain('<w:tcW w:w="3750" w:type="pct"/>');
  });

  it('no col-widths: tblW stays auto but tblGrid gains dxa widths for Word Online', () => {
    const rows: MdTableRow[] = [
      { header: false, cells: [
        { runs: [{ type: 'text', text: 'A' }] },
        { runs: [{ type: 'text', text: 'B' }] },
      ] },
    ];
    const token: MdToken = { type: 'table', runs: [], rows };
    const result = generateTable(token, makeState());
    // tblW stays auto so Word Desktop continues to auto-size (no forced full-page-width)
    expect(result).toContain('<w:tblW w:w="0" w:type="auto"/>');
    // Every cell gets tcW auto so Word doesn't add it on open (dirty-flag prevention)
    expect((result.match(/<w:tcW w:w="0" w:type="auto"\/>/g) || []).length).toBe(2);
    // gridCol elements have explicit dxa widths (equal: 9360/2 = 4680 each) for Word Online
    expect(result).toContain('<w:gridCol w:w="4680"/>');
  });

  it('equal col-widths gives equal distribution', () => {
    const rows: MdTableRow[] = [
      { header: false, cells: [
        { runs: [{ type: 'text', text: 'A' }] },
        { runs: [{ type: 'text', text: 'B' }] },
        { runs: [{ type: 'text', text: 'C' }] },
      ] },
    ];
    const token: MdToken = { type: 'table', runs: [], rows, tableColWidths: 'equal' };
    const result = generateTable(token, makeState());
    expect(result).toContain('<w:tblW w:w="5000" w:type="pct"/>');
    // 5000 / 3 ≈ 1667 each (sum adjusted to 5000)
    const matches = result.match(/<w:tcW w:w="(\d+)"/g);
    expect(matches).toBeTruthy();
    const widths = matches!.map(m => parseInt(m.match(/\d+/)![0]));
    expect(widths.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it('auto col-widths skips width generation', () => {
    const rows: MdTableRow[] = [
      { header: false, cells: [
        { runs: [{ type: 'text', text: 'A' }] },
        { runs: [{ type: 'text', text: 'B' }] },
      ] },
    ];
    const token: MdToken = { type: 'table', runs: [], rows, tableColWidths: 'auto' };
    const state = makeState();
    state.fontOverrides = { tableColWidths: [2, 1] };
    const result = generateTable(token, state);
    expect(result).toContain('<w:tblW w:w="0" w:type="auto"/>');
    // Every cell gets tcW auto so Word doesn't add it on open (dirty-flag prevention)
    expect((result.match(/<w:tcW w:w="0" w:type="auto"\/>/g) || []).length).toBe(2);
  });

  it('frontmatter table-col-widths: auto round-trips through DOCX', async () => {
    const md = '---\ntable-col-widths: auto\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('table-col-widths: auto');
  });

  describe('table-borders', () => {
    const simpleRows: MdTableRow[] = [
      { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
      { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] },
    ];

    it('defaults to horizontal borders (grey insideH, no vertical)', () => {
      const token: MdToken = { type: 'table', runs: [], rows: simpleRows };
      const result = generateTable(token, makeState());
      expect(result).toContain('w:color="BFBFBF"');
      // val="none" borders are omitted (Word strips them on open and marks dirty)
      expect(result).not.toContain('<w:insideV');
      expect(result).not.toContain('<w:left w:val="none"');
      expect(result).not.toContain('<w:right w:val="none"');
    });

    it('horizontal style adds black bottom border on last header row cells', () => {
      const token: MdToken = { type: 'table', runs: [], rows: simpleRows };
      const result = generateTable(token, makeState());
      expect(result).toContain('<w:tcBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders>');
    });

    it('solid borders: all borders single black', () => {
      const state = makeState();
      state.fontOverrides = { tableBorders: 'solid' };
      const token: MdToken = { type: 'table', runs: [], rows: simpleRows };
      const result = generateTable(token, state);
      expect(result).toContain('<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>');
      expect(result).toContain('<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>');
      expect(result).not.toContain('w:color="BFBFBF"');
      expect(result).not.toContain('<w:tcBorders>');
    });

    it('none borders: all borders none', () => {
      const state = makeState();
      state.fontOverrides = { tableBorders: 'none' };
      const token: MdToken = { type: 'table', runs: [], rows: simpleRows };
      const result = generateTable(token, state);
      // val="none" borders are omitted entirely (Word strips them and marks dirty)
      expect(result).not.toMatch(/<w:tblBorders\b/);
      expect(result).not.toContain('<w:tcBorders>');
    });

    it('cell margins include top/bottom padding', () => {
      const token: MdToken = { type: 'table', runs: [], rows: simpleRows };
      const result = generateTable(token, makeState());
      expect(result).toContain('<w:top w:w="36" w:type="dxa"/>');
      expect(result).toContain('<w:bottom w:w="36" w:type="dxa"/>');
    });

    it('table-borders round-trips through DOCX', async () => {
      const md = '---\ntable-borders: none\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const { docx } = await convertMdToDocx(md);
      const { convertDocx } = await import('./converter');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('table-borders: none');
    });

    it('table-borders: solid round-trips through DOCX', async () => {
      const md = '---\ntable-borders: solid\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const { docx } = await convertMdToDocx(md);
      const { convertDocx } = await import('./converter');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('table-borders: solid');
    });

    it('table-borders: horizontal round-trips through DOCX', async () => {
      const md = '---\ntable-borders: horizontal\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const { docx } = await convertMdToDocx(md);
      const { convertDocx } = await import('./converter');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('table-borders: horizontal');
    });
  });
});

describe('parseColWidths', () => {
  it('parses space-separated values', () => {
    expect(parseColWidths('2 1 1')).toEqual([2, 1, 1]);
  });
  it('parses comma-separated values', () => {
    expect(parseColWidths('2,1,1')).toEqual([2, 1, 1]);
  });
  it('parses bracketed array', () => {
    expect(parseColWidths('[2, 1, 1]')).toEqual([2, 1, 1]);
  });
  it('parses equal', () => {
    expect(parseColWidths('equal')).toBe('equal');
    expect(parseColWidths('EQUAL')).toBe('equal');
  });
  it('parses auto', () => {
    expect(parseColWidths('auto')).toBe('auto');
  });
  it('parses float values', () => {
    expect(parseColWidths('1.5 1 0.5')).toEqual([1.5, 1, 0.5]);
  });
  it('rejects non-positive values', () => {
    expect(parseColWidths('2 0 1')).toBeUndefined();
    expect(parseColWidths('2 -1 1')).toBeUndefined();
  });
  it('rejects malformed tokens like "2x"', () => {
    expect(parseColWidths('2x 1 1')).toBeUndefined();
    expect(parseColWidths('1 abc 2')).toBeUndefined();
    expect(parseColWidths('1e2x')).toBeUndefined();
  });
  it('rejects empty', () => {
    expect(parseColWidths('')).toBeUndefined();
  });
});

describe('expandColWidths', () => {
  it('repeats last value for extra columns', () => {
    expect(expandColWidths([2, 1], 4)).toEqual([2, 1, 1, 1]);
  });
  it('truncates when more ratios than columns', () => {
    expect(expandColWidths([2, 1, 1], 2)).toEqual([2, 1]);
  });
  it('equal produces uniform array', () => {
    expect(expandColWidths('equal', 3)).toEqual([1, 1, 1]);
  });
});

describe('colWidthsToPct', () => {
  it('converts ratios to fiftieths-of-percent summing to 5000', () => {
    const pcts = colWidthsToPct([2, 1, 1]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(pcts[0]).toBe(2500);
    expect(pcts[1]).toBe(1250);
    expect(pcts[2]).toBe(1250);
  });
  it('handles equal distribution with rounding', () => {
    const pcts = colWidthsToPct([1, 1, 1]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(5000);
  });
  it('produces all-positive values for skewed ratios', () => {
    const pcts = colWidthsToPct([1, 100, 100]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(pcts.every(v => v > 0)).toBe(true);
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

    expect(runs?.find(r => r.text === '2' && (r as any).subscript)).toBeDefined();
    expect(runs?.find(r => r.text === '2' && (r as any).superscript)).toBeDefined();
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
    expect(document).toContain('<w:pStyle w:val="GitHubBlockquote"/>');
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
  const createState = () => ({ ...makeState(), rIdOffset: 3 });

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
    expect(result).toContain('<w:delText>deleted text</w:delText>');
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
    expect(result).toContain('<w:delText>old text</w:delText>');
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
    expect(state.comments[0]).toMatchObject({
      id: 0,
      author: 'Alice',
      date: '2024-01-04T00:00:00Z',
      text: 'This is a comment'
    });
    expect(state.comments[0].paraId).toMatch(/^[0-9A-F]{8}$/);
  });

  it('generates zero-width comment range for standalone comments', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{ type: 'critic_comment', text: '', commentText: 'Standalone comment', author: 'Charlie', date: '2024-01-05T00:00:00Z' }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:commentRangeStart w:id="0"/>');
    expect(result).toContain('<w:commentRangeEnd w:id="0"/>');
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

  it('renders recursive formatting inside critic additions', () => {
    const token = parseMd('{++**bold** and *italic*++}')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:ins');
    expect(result).toContain('<w:b/>');
    expect(result).toContain('<w:i/>');
    expect(result).not.toContain('**bold**');
    expect(result).not.toContain('*italic*');
  });

  it('renders recursive formatting inside critic substitutions', () => {
    const token = parseMd('{~~**old**~>*new*~~}')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del');
    expect(result).toContain('<w:ins');
    expect(result).toContain('<w:b/>');
    expect(result).toContain('<w:i/>');
    expect(result).not.toContain('**old**');
    expect(result).not.toContain('*new*');
  });

  it('renders recursive formatting in critic highlight with attached comment', () => {
    const token = parseMd('{==**bold** ==highlighted== text==}{>>comment<<}')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:commentRangeStart w:id="0"/>');
    expect(result).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(result).toContain('<w:commentReference w:id="0"/>');
    expect(result).toContain('<w:b/>');
    expect(result).toContain('<w:highlight w:val="yellow"/>');
    expect(result).not.toContain('**bold**');
    expect(result).not.toContain('==highlighted==');
  });

  it('parses CriticMarkup inside inline math as revised math runs', () => {
    const token = parseMd('The variance is $u_j^2{+++\\tau_{g_j}^2++}$.')[0];
    const math = token.runs.find(run => run.type === 'math');
    const addition = token.runs.find(run => run.type === 'critic_add');

    expect(math?.text).toBe('u_j^2');
    expect(addition?.text).toBe('$+\\tau_{g_j}^2$');
    expect(addition?.innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: '+\\tau_{g_j}^2' }),
    ]);
  });

  it('restores source newlines in revised inline math for Word export', () => {
    const token = parseMd('$a{++b\nc++}$')[0];
    const addition = token.runs.find(run => run.type === 'critic_add');

    expect(addition?.innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'b\nc' }),
    ]);
    expect(addition?.text).not.toContain('LINE');
  });

  it('keeps a next-line Critic opener inside inline math for Word export', () => {
    const token = parseMd('$a+{++\n+b++}$')[0];
    const addition = token.runs.find(run => run.type === 'critic_add');

    expect(token.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'math', text: 'a+' }),
      expect.objectContaining({ type: 'critic_add' }),
    ]));
    expect(addition?.innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: '\n+b' }),
    ]);
  });

  it('ignores escaped dollars when closing revised inline math for Word export', () => {
    const token = parseMd('$a+\\$+{++b++}$')[0];
    const math = token.runs.find(run => run.type === 'math');
    const addition = token.runs.find(run => run.type === 'critic_add');

    expect(math?.text).toBe('a+\\$+');
    expect(addition?.innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'b' }),
    ]);
    expect(token.runs.at(-1)?.text).not.toBe('$');
  });

  it('closes inline and display math immediately after an escaped dollar', () => {
    const inline = parseMd('$x+\\$$')[0].runs.find(run => run.type === 'math');
    const display = parseMd('$$x+\\$$$')[0].runs.find(run => run.type === 'math');

    expect(inline).toEqual(expect.objectContaining({ text: 'x+\\$' }));
    expect(display).toEqual(expect.objectContaining({ text: 'x+\\$', display: true }));
  });

  it('generates Word revisions for substituted fragments inside inline math', () => {
    const token = parseMd('$a{~~+b~>+c~~}$')[0];
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });

    expect(result).toContain('<w:del');
    expect(result).toContain('<w:ins');
    expect(result.match(/<m:oMath>/g)).toHaveLength(3);
    expect(result).not.toContain('{~~');
  });

  it('puts display math inside a multiline addition in its own Word paragraph', () => {
    const markdown = 'Before {++First paragraph.\n\n$$x^2$$\n\nAfter paragraph.++} Tail';
    const tokens = parseMd(markdown);

    expect(tokens).toHaveLength(3);
    expect(tokens[0].runs.map(run => run.type)).toEqual(['text', 'critic_add']);
    expect(tokens[1].runs).toHaveLength(1);
    expect(tokens[1].runs[0]).toEqual(expect.objectContaining({
      type: 'critic_add',
      innerRuns: [expect.objectContaining({ type: 'math', text: 'x^2', display: true })],
    }));
    expect(tokens[2].runs.map(run => run.type)).toEqual(['critic_add', 'text']);

    const state = createState();
    const xml = generateDocumentXml(tokens, state, { authorName: 'Default' });
    const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('</w:body>'));
    expect(body.match(/<w:p>/g)).toHaveLength(3);
    expect(body).toContain('<w:p><w:ins');
    expect(body).toContain('<m:oMathPara><m:oMath>');
    expect(body).not.toContain('<w:br/>');
  });

  it('keeps the first Critic display-math segment as a heading and demotes continuations', () => {
    const tokens = parseMd('# {++before\n\n$$x$$\n\nafter++}');
    const state = createState();
    const xml = generateDocumentXml(tokens, state, { authorName: 'Default' });

    expect(tokens.map(token => token.type)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(tokens[0].level).toBe(1);
    expect(tokens[1].level).toBeUndefined();
    expect(xml.match(/w:pStyle w:val="Heading1"/g)).toHaveLength(1);
    expect(xml).toContain('<m:oMathPara>');
  });

  it('puts display math inside a multiline highlight in its own Word paragraph', () => {
    const tokens = parseMd('{==before\n\n$$x$$\n\nafter==}');

    expect(tokens).toHaveLength(3);
    expect(tokens.every(token => token.runs[0]?.type === 'critic_highlight')).toBe(true);
    expect(tokens[1].runs[0].innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'x', display: true }),
    ]);
  });

  it('puts display math inside a multiline substitution in its own Word paragraph', () => {
    const tokens = parseMd('{~~before\n\n$$x$$\n\nafter~>new before\n\n$$y$$\n\nnew after~~}');

    expect(tokens).toHaveLength(3);
    expect(tokens.every(token => token.runs[0]?.type === 'critic_sub')).toBe(true);
    expect(tokens[1].runs[0].oldRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'x', display: true }),
    ]);
    expect(tokens[1].runs[0].newRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'y', display: true }),
    ]);
  });

  it('preserves old-before-new order for asymmetric substitution paragraphs', () => {
    const tokens = parseMd('{~~old\n\n$$x$$\n\nafter~>$$y$$~~}');
    const runs = tokens.map(token => token.runs[0]);

    expect(tokens).toHaveLength(4);
    expect(runs[0].oldRuns?.some(run => run.text.includes('old'))).toBe(true);
    expect(runs[1].oldRuns).toEqual([expect.objectContaining({ type: 'math', text: 'x', display: true })]);
    expect(runs[2].oldRuns?.some(run => run.text.includes('after'))).toBe(true);
    expect(runs[3].newRuns).toEqual([expect.objectContaining({ type: 'math', text: 'y', display: true })]);
  });

  it('keeps a multiline addition in a Word list item', () => {
    const tokens = parseMd('- Earlier.{++\n  Added.++}');
    const listItem = tokens.find(token => token.type === 'list_item');
    const addition = listItem?.runs.find(run => run.type === 'critic_add');

    expect(addition).toBeDefined();
    expect(addition?.innerRuns?.some(run => run.text.includes('Added.'))).toBe(true);
  });

  it('keeps a multiline addition in a nested Word list item', () => {
    const tokens = parseMd('- outer\n    - Earlier.{++\n      Added.++}');
    const nestedItem = tokens.find(token => token.type === 'list_item' && token.level === 2);
    const addition = nestedItem?.runs.find(run => run.type === 'critic_add');

    expect(addition).toBeDefined();
    expect(addition?.innerRuns?.some(run => run.text.includes('Added.'))).toBe(true);
  });

  it('keeps a multiline addition on a Word list continuation line', () => {
    const tokens = parseMd('- Intro\n  Earlier.{++\n  Added.++}');
    const listItem = tokens.find(token => token.type === 'list_item');
    const addition = listItem?.runs.find(run => run.type === 'critic_add');

    expect(addition?.innerRuns?.some(run => run.text.includes('Added.'))).toBe(true);
  });

  it('removes blockquote prefixes from revised Word text', () => {
    const tokens = parseMd('> {++before\n>\n> after++}');
    const addition = tokens[0].runs.find(run => run.type === 'critic_add');

    expect(addition?.innerRuns?.some(run => run.text.includes('after'))).toBe(true);
    expect(addition?.innerRuns?.some(run => run.text.includes('>'))).toBe(false);
  });

  it('removes blockquote prefixes after nested-list indentation', () => {
    const input = '- outer\n    - inner\n      > {++before\n      >\n      > after++}';
    const blockquote = parseMd(input).find(token => token.type === 'blockquote');
    const addition = blockquote?.runs.find(run => run.type === 'critic_add');

    expect(blockquote?.listContinuation).toEqual({ type: 'bullet', level: 2 });
    expect(addition?.text).toBe('before\n\nafter');
    expect(addition?.innerRuns?.some(run => run.text.includes('>'))).toBe(false);
  });

  it('splits Critic display math into Word list continuation paragraphs', () => {
    const tokens = parseMd('- {++before\n\n  $$x$$\n\n  after++}');
    const state = createState();
    const xml = generateDocumentXml(tokens, state, { authorName: 'Default' });

    expect(tokens.map(token => token.type)).toEqual(['list_item', 'paragraph', 'paragraph']);
    expect(tokens[1].listContinuation).toEqual({ type: 'bullet', level: 1 });
    expect(tokens[1].runs[0].innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'x', display: true }),
    ]);
    expect(xml.match(/<w:numPr>/g)).toHaveLength(1);
    expect(xml).toContain('<w:ind w:left="720"/>');
  });

  it('keeps restarted ordered-list numbering across generated continuation paragraphs', () => {
    const tokens = parseMd('5. {++before\n\n   $$x$$\n\n   after++}\n6. next');
    const state = createState();
    const xml = generateDocumentXml(tokens, state, { authorName: 'Default' });
    const orderedNumIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => match[1]);

    expect(tokens.map(token => token.type)).toEqual(['list_item', 'paragraph', 'paragraph', 'list_item']);
    expect(orderedNumIds).toEqual(['3', '3']);
    expect(state.listStartOverrides).toEqual([{ numId: 3, ilvl: 0, start: 5 }]);
    expect(xml.match(/w:pStyle w:val="ManuscriptListContinuation"/g)).toHaveLength(2);
    expect(xml).not.toContain('_lic:');
  });

  it('does not duplicate a single-quoted continuation style from a Word template', async () => {
    const JSZip = (await import('jszip')).default;
    const base = await convertMdToDocx('Body');
    const templateZip = await JSZip.loadAsync(base.docx);
    const templateStyles = await templateZip.file('word/styles.xml')!.async('string');
    templateZip.file(
      'word/styles.xml',
      templateStyles.replace(
        'w:styleId="ManuscriptListContinuation"',
        "w:styleId='ManuscriptListContinuation'",
      ),
    );
    const templateDocx = await templateZip.generateAsync({ type: 'uint8array' });

    const converted = await convertMdToDocx('- {++before\n\n  $$x$$\n\n  after++}', { templateDocx });
    const convertedZip = await JSZip.loadAsync(converted.docx);
    const convertedStyles = await convertedZip.file('word/styles.xml')!.async('string');
    expect(convertedStyles.match(/w:styleId\s*=\s*["']ManuscriptListContinuation["']/g)).toHaveLength(1);
  });

  it('splits Critic display math across Word blockquote paragraphs', () => {
    const tokens = parseMd('> {++before\n>\n> $$x$$\n>\n> after++}');

    expect(tokens).toHaveLength(3);
    expect(tokens.every(token => token.type === 'blockquote')).toBe(true);
    expect(tokens[1].runs[0].innerRuns).toEqual([
      expect.objectContaining({ type: 'math', text: 'x', display: true }),
    ]);
  });

  it('emits an alert lead only on the first split blockquote paragraph', () => {
    const tokens = parseMd('> [!NOTE]\n> {++before\n>\n> $$x$$\n>\n> after++}');

    expect(tokens).toHaveLength(3);
    expect(tokens.map(token => token.alertLead)).toEqual([true, undefined, undefined]);
    expect(tokens[0].alertFirst).toBe(true);
    expect(tokens[2].alertLast).toBe(true);
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

  it('does not hoist an incomplete multiline opener', () => {
    const input = 'Before.{++\nAfter';
    expect(preprocessCriticMarkup(input)).toBe(input);
  });

  it('leaves Critic-shaped text in raw HTML blocks unchanged', () => {
    for (const input of [
      '<pre>\n{++a\nb++}\n</pre>',
      '<pre>\nBefore{++\na++}\n</pre>',
    ]) {
      expect(preprocessCriticMarkup(input)).toBe(input);
    }
  });

  it('does not hoist or protect a substitution without its separator', () => {
    const input = 'Before{~~\nliteral~~}';
    expect(preprocessCriticMarkup(input)).toBe(input);

    const runs = parseMd(input).flatMap(token => token.runs);
    expect(runs.some(run => run.type === 'critic_sub')).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe(input);
  });

  it('treats CR-only blank lines as paragraph breaks inside CriticMarkup', () => {
    const input = '{++a\r\rb++}';
    expect(preprocessCriticMarkup(input)).toBe('{++a' + PARA_PLACEHOLDER + 'b++}');
  });

  it('does not protect CriticMarkup newlines in a CR-only indented code block', () => {
    const input = 'Intro\r\r    {++first\r    second++}';
    expect(preprocessCriticMarkup(input)).toBe(input);
  });

  it('leaves CriticMarkup literal in indented and container-nested fences', () => {
    for (const input of [
      '  ~~~\n  {++first\n  second++}\n  ~~~',
      '- item\n\n  ~~~\n  {++first\n  second++}\n  ~~~',
      '> ~~~\n> {++first\n> second++}\n> ~~~',
    ]) {
      expect(preprocessCriticMarkup(input)).toBe(input);
    }
  });

  it('does not let a CR-only fence hide later CriticMarkup', () => {
    const input = '~~~\r{++code\rline++}\r~~~\rAfter {++revision\rline++}';
    const processed = preprocessCriticMarkup(input);
    expect(processed).toContain('{++code\rline++}');
    expect(processed).toContain('{++revision' + LINE_PLACEHOLDER + 'line++}');
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

  it('protects whitespace-only blank lines and CRLF inside CriticMarkup', () => {
    const input = '{++before\r\n   \r\nafter++}';
    const result = preprocessCriticMarkup(input);
    expect(result).toContain('before' + PARA_PLACEHOLDER + 'after');
    expect(result).not.toContain('\r\n');
  });

  it('moves an empty leading paragraph break before a stranded Critic opener', () => {
    const input = 'Before.{++\n\nAfter.++}';
    expect(preprocessCriticMarkup(input)).toBe('Before.\n\n{++After.++}');
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
    const tokens = parseMd('{>>@Alice (2024-01-15T10:00:00Z) | para 1\n\npara 2<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    expect(commentRuns[0].author).toBe('Alice');
    expect(commentRuns[0].date).toBe('2024-01-15T10:00:00Z');
  });

  it('treats text without @ prefix as plain comment text, not author attribution', () => {
    const prose = 'Right now the section starts with detailed distributions (early 2020s, then early 2000s), and the reader has to work through several paragraphs before the big picture is clear. Giving that big picture first would help a lot: for example';
    const tokens = parseMd('{>>' + prose + '<<}');
    const commentRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_comment');
    expect(commentRuns.length).toBe(1);
    expect(commentRuns[0].author).toBeUndefined();
    expect(commentRuns[0].commentText).toBe(prose);
  });

  it('does not leak placeholder into comment text', () => {
    const tokens = parseMd('{>>@Alice (2024-01-15T10:00:00Z) | para 1\n\npara 2<<}');
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

  it('parses recursive formatting inside critic additions', () => {
    const tokens = parseMd('{++**bold** and *italic*++}');
    const addRun = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_add');
    expect(addRun).toBeDefined();
    expect(addRun?.innerRuns?.some(r => r.type === 'text' && r.bold && r.text === 'bold')).toBe(true);
    expect(addRun?.innerRuns?.some(r => r.type === 'text' && r.italic && r.text === 'italic')).toBe(true);
  });

  it('parses recursive formatting inside critic deletions with nested highlights', () => {
    const tokens = parseMd('{--*italic* and ==highlight==--}');
    const delRun = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_del');
    expect(delRun).toBeDefined();
    expect(delRun?.innerRuns?.some(r => r.type === 'text' && r.italic && r.text === 'italic')).toBe(true);
    expect(delRun?.innerRuns?.some(r => r.type === 'text' && r.highlight && r.text === 'highlight')).toBe(true);
  });

  it('parses recursive formatting on both sides of critic substitutions', () => {
    const tokens = parseMd('{~~**old**~>*new*~~}');
    const subRun = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_sub');
    expect(subRun).toBeDefined();
    expect(subRun?.oldRuns?.some(r => r.type === 'text' && r.bold && r.text === 'old')).toBe(true);
    expect(subRun?.newRuns?.some(r => r.type === 'text' && r.italic && r.text === 'new')).toBe(true);
  });

  it('parses recursive formatting in critic highlight with attached comment', () => {
    const tokens = parseMd('{==**bold** ==highlighted== text==}{>>comment<<}');
    const runs = tokens.flatMap(t => t.runs);
    const highlightRun = runs.find(r => r.type === 'critic_highlight');
    const commentRun = runs.find(r => r.type === 'critic_comment');
    expect(highlightRun).toBeDefined();
    expect(commentRun).toBeDefined();
    expect(highlightRun?.innerRuns?.some(r => r.type === 'text' && r.bold && r.text === 'bold')).toBe(true);
    expect(highlightRun?.innerRuns?.some(r => r.type === 'text' && r.highlight && r.text === 'highlighted')).toBe(true);
  });
});

describe('Nested critic runs in deletions and formatting propagation', () => {
  const createState = () => ({ ...makeState(), rIdOffset: 3 });

  it('renders nested addition inside deletion as delText', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_del', text: 'text added more', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'text ' },
          { type: 'critic_add', text: 'added', innerRuns: [{ type: 'text', text: 'added' }] },
          { type: 'text', text: ' more' }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:del');
    expect(result).toContain('<w:delText xml:space="preserve">text </w:delText>');
    expect(result).toContain('<w:delText>added</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve"> more</w:delText>');
    // Must NOT contain <w:ins> inside the deletion
    const delMatch = result.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    expect(delMatch).toBeTruthy();
    expect(delMatch![1]).not.toContain('<w:ins');
  });

  it('renders nested deletion inside deletion as delText', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_del', text: 'outer inner text', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'outer ' },
          { type: 'critic_del', text: 'inner', innerRuns: [{ type: 'text', text: 'inner' }] },
          { type: 'text', text: ' text' }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:delText xml:space="preserve">outer </w:delText>');
    expect(result).toContain('<w:delText>inner</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve"> text</w:delText>');
  });

  it('renders substitution inside deletion as delText', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_del', text: 'before old after', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'before ' },
          { type: 'critic_sub', text: 'old', newText: 'new', oldRuns: [{ type: 'text', text: 'old' }], newRuns: [{ type: 'text', text: 'new' }] },
          { type: 'text', text: ' after' }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    expect(result).toContain('<w:delText xml:space="preserve">before </w:delText>');
    expect(result).toContain('<w:delText>old</w:delText>');
    expect(result).toContain('<w:delText>new</w:delText>');
    expect(result).toContain('<w:delText xml:space="preserve"> after</w:delText>');
  });

  it('propagates bold formatting into nested critic innerRuns', () => {
    const token: MdToken = {
      type: 'paragraph',
      runs: [{
        type: 'critic_add', text: 'bold deleted', author: 'A', date: '2024-01-01T00:00:00Z',
        innerRuns: [
          { type: 'text', text: 'bold ', bold: true },
          { type: 'critic_del', text: 'deleted', bold: true, innerRuns: [{ type: 'text', text: 'deleted' }] }
        ]
      }]
    };
    const state = createState();
    const result = generateParagraph(token, state, { authorName: 'Default' });
    // The nested deletion should have bold formatting propagated to its inner text
    expect(result).toContain('<w:del');
    expect(result).toContain('<w:delText>deleted</w:delText>');
    // The deleted run should include bold rPr
    const delMatch = result.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    expect(delMatch).toBeTruthy();
    expect(delMatch![1]).toContain('<w:b/>');
  });
});

describe('Citations inside CriticMarkup', () => {
  const bib = '@article{smith2020, author={Smith, John}, title={Title}, journal={J}, year={2020}}\n' +
    '@article{jones2021, author={Jones, Ann}, title={Other}, journal={J}, year={2021}}';

  const getDocumentXml = async (md: string) => {
    const { docx } = await convertMdToDocx(md, { bibtex: bib });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    return zip.file('word/document.xml')!.async('text');
  };

  it('parseMd produces citation runs inside critic innerRuns', () => {
    const tokens = parseMd('{++Added [@smith2020]++}');
    const add = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_add');
    expect(add).toBeDefined();
    const citation = add!.innerRuns!.find(r => r.type === 'citation');
    expect(citation).toBeDefined();
    expect(citation!.keys).toEqual(['smith2020']);
  });

  it('parseMd produces citation runs on both sides of a substitution', () => {
    const tokens = parseMd('{~~Old [@smith2020]~>New [@jones2021]~~}');
    const sub = tokens.flatMap(t => t.runs).find(r => r.type === 'critic_sub');
    expect(sub).toBeDefined();
    expect(sub!.oldRuns!.find(r => r.type === 'citation')?.keys).toEqual(['smith2020']);
    expect(sub!.newRuns!.find(r => r.type === 'citation')?.keys).toEqual(['jones2021']);
  });

  it('exports a Zotero field inside w:ins for citations in additions', async () => {
    const doc = await getDocumentXml('This is an example {++with a citation [@smith2020]++}.');
    const insMatch = doc.match(/<w:ins[^>]*>([\s\S]*?)<\/w:ins>/);
    expect(insMatch).toBeTruthy();
    expect(insMatch![1]).toContain('ADDIN ZOTERO_ITEM CSL_CITATION');
    expect(insMatch![1]).toContain('smith2020');
  });

  it('exports the new-side citation of a substitution as a field and the old side as literal deleted text', async () => {
    const doc = await getDocumentXml('{~~Old [@smith2020]~>New [@jones2021]~~}');
    const delMatch = doc.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    const insMatch = doc.match(/<w:ins[^>]*>([\s\S]*?)<\/w:ins>/);
    expect(delMatch).toBeTruthy();
    expect(insMatch).toBeTruthy();
    // Old side: literal syntax as deleted text, no field
    expect(delMatch![1]).toContain('<w:delText>[@smith2020]</w:delText>');
    expect(delMatch![1]).not.toContain('ZOTERO_ITEM');
    // New side: live field
    expect(insMatch![1]).toContain('ADDIN ZOTERO_ITEM CSL_CITATION');
    expect(insMatch![1]).toContain('jones2021');
  });

  it('renders citations in deletions as literal deleted text without a field', async () => {
    const doc = await getDocumentXml('{--Removed [@smith2020]--}');
    const delMatch = doc.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    expect(delMatch).toBeTruthy();
    expect(delMatch![1]).toContain('<w:delText>[@smith2020]</w:delText>');
    expect(doc).not.toContain('ZOTERO_ITEM');
  });

  it('includes added citations in the bibliography but not deleted-only ones', async () => {
    const md = '---\ncsl: apa\n---\n{++Added [@smith2020]++} and {--removed [@jones2021]--}\n';
    const doc = await getDocumentXml(md);
    expect(doc).toContain('ZOTERO_BIBL');
    const biblMatch = doc.match(/ZOTERO_BIBL([\s\S]*)/);
    expect(biblMatch![1]).toContain('Smith');
    expect(biblMatch![1]).not.toContain('Jones');
  });

  it('does not warn about missing keys for resolvable citations inside additions', async () => {
    const { warnings } = await convertMdToDocx('{++Added [@smith2020]++}', { bibtex: bib });
    expect(warnings).toEqual([]);
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

  it('keeps indented fenced code blocks inside footnote bodies', () => {
    const input = 'Body text.\n\n[^1]: Here is code:\n\n    ```python\n    print(\"hello\")\n    ```';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('Here is code:\n\n```python\nprint(\"hello\")\n```');
    expect(cleaned).toBe('Body text.\n');
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
    const footnotesFile = zip.file('word/footnotes.xml');
    expect(footnotesFile).not.toBeNull();
    const footnotesXml = await footnotesFile!.async('string');
    expect(footnotesXml).toContain('xmlns:w14=');
    expect(footnotesXml).toContain('w:footnoteRef');
    expect(footnotesXml).toContain('A footnote.');
  });

	it('formats tables in note definitions with document numeric defaults', async () => {
		const md = '---\ntable-digits: 1\ntable-decimal-mark: midpoint\n---\n\nSee note[^1].\n\n[^1]: <table><tr><td>12.34</td></tr></table>';
		const { docx } = await convertMdToDocx(md);
		const JSZip = (await import('jszip')).default;
		const zip = await JSZip.loadAsync(docx);
		const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
		expect(footnotesXml).toContain('12\u00b73');
		expect(footnotesXml).not.toContain('12.34');
	});

  it('endnote mode via notes: endnotes frontmatter', async () => {
    const md = '---\nnotes: endnotes\n---\n\nHello[^1] world.\n\n[^1]: An endnote.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const endnotesFile = zip.file('word/endnotes.xml');
    expect(endnotesFile).not.toBeNull();
    // Word requires both footnotes.xml and endnotes.xml whenever either is present
    const footnotesFile = zip.file('word/footnotes.xml');
    expect(footnotesFile).not.toBeNull();
    // Footnotes.xml should have only separators (no actual footnote content)
    const footnotesXml = await footnotesFile!.async('string');
    expect(footnotesXml).not.toContain('An endnote.');
    const endnotesXml = await endnotesFile!.async('string');
    expect(endnotesXml).toContain('xmlns:w14=');
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

  it('ignores trailing semicolon in citation group', async () => {
    const bib = `@article{smith2020,\n  author = {Smith, John},\n  title = {Title},\n  year = {2020},\n}`;
    const md = 'Text [@smith2020;].';
    const { warnings } = await convertMdToDocx(md, { bibtex: bib });
    expect(warnings).toEqual([]);
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

describe('Footnote OOXML structure', () => {
  it('hyperlinks in footnotes go into footnotes.xml.rels, not document.xml.rels', async () => {
    const md = 'Text[^1] here.\n\n[^1]: See [example](https://example.com) for details.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);

    // footnotes.xml should have a hyperlink with r:id
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
    expect(footnotesXml).toContain('r:id="rId1"');
    expect(footnotesXml).toContain('example');

    // footnotes.xml.rels should exist and contain the hyperlink relationship
    const noteRels = zip.file('word/_rels/footnotes.xml.rels');
    expect(noteRels).not.toBeNull();
    const noteRelsXml = await noteRels!.async('string');
    expect(noteRelsXml).toContain('https://example.com');
    expect(noteRelsXml).toContain('rId1');

    // document.xml.rels should NOT contain the footnote hyperlink
    const docRels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(docRels).not.toContain('https://example.com');
  });

  it('footnote entries are sorted by ID regardless of definition order', async () => {
    // Definitions appear in reverse order (3, 2, 1) but references appear in order (1, 2, 3)
    const md = 'First[^a] second[^b] third[^c].\n\n[^c]: Third.\n\n[^b]: Second.\n\n[^a]: First.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');

    // Extract footnote IDs in order of appearance
    const ids = [...footnotesXml.matchAll(/w:footnote w:id="(\d+)"/g)].map(m => parseInt(m[1]));
    // Should be in ascending order
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('endnotes.xml is always present when footnotes.xml exists', async () => {
    const md = 'Text[^1] here.\n\n[^1]: A footnote.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    expect(zip.file('word/footnotes.xml')).not.toBeNull();
    expect(zip.file('word/endnotes.xml')).not.toBeNull();

    // endnotes.xml should have separators but no actual endnote content
    const endnotesXml = await zip.file('word/endnotes.xml')!.async('string');
    expect(endnotesXml).toContain('w:endnote w:type="separator"');
    expect(endnotesXml).not.toContain('A footnote.');

    // settings.xml should have both footnotePr and endnotePr
    const settingsXml = await zip.file('word/settings.xml')!.async('string');
    expect(settingsXml).toContain('w:footnotePr');
    expect(settingsXml).toContain('w:endnotePr');

    // document.xml.rels should have both footnotes and endnotes relationships
    const docRels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(docRels).toContain('footnotes');
    expect(docRels).toContain('endnotes');

    // [Content_Types].xml should have both overrides
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypes).toContain('footnotes.xml');
    expect(contentTypes).toContain('endnotes.xml');
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

  it('MD→DOCX→MD preserves repeated footnote references', async () => {
    const md = 'First reference.[^shared]\n\nSecond reference to the same note.[^shared]\n\n[^shared]: This footnote is referenced twice.';
    const { docx } = await convertMdToDocx(md);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);

    // Both references should round-trip as [^shared]
    const refs = result.markdown.match(/\[\^shared\]/g);
    expect(refs).not.toBeNull();
    expect(refs!.length).toBe(3); // 2 inline refs + 1 definition
    expect(result.markdown).toContain('[^shared]: This footnote is referenced twice.');
  });

  it('MD→DOCX→MD preserves repeated numeric footnote references', async () => {
    const md = 'First.[^1]\n\nSecond.[^1]\n\n[^1]: Shared footnote.';
    const { docx } = await convertMdToDocx(md);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);

    const refs = result.markdown.match(/\[\^1\]/g);
    expect(refs).not.toBeNull();
    expect(refs!.length).toBe(3); // 2 inline refs + 1 definition
    expect(result.markdown).toContain('[^1]: Shared footnote.');
  });
});

describe('List blockquote round-trip', () => {
  it('MD→DOCX→MD preserves blockquote continuation under a bullet list item', async () => {
    const md = '* **Clinical phrasing:**\n  > quoted line\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('\n  > quoted line');

    const tokens = parseMd(result.markdown);
    const blockquote = tokens.find(t => t.type === 'blockquote');
    expect(blockquote).toMatchObject({
      type: 'blockquote',
      level: 1,
      listContinuation: { type: 'bullet', level: 1 },
    });
  });

  it('MD→DOCX→MD preserves alert blockquote continuation under an ordered list item', async () => {
    const md = '1. Clinical phrasing:\n   > [!WARNING]\n   > quoted line\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('\n   > [!WARNING]');
    expect(result.markdown).toContain('\n   > quoted line');

    const tokens = parseMd(result.markdown);
    const blockquote = tokens.find(t => t.type === 'blockquote');
    expect(blockquote).toMatchObject({
      type: 'blockquote',
      level: 1,
      alertType: 'warning',
      listContinuation: { type: 'ordered', level: 1 },
    });
  });

  it('MD→DOCX→MD preserves multi-digit ordered indentation for continuation blockquotes', async () => {
    const md = '10. Clinical phrasing:\n    > quoted line\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('10. Clinical phrasing:\n    > quoted line');

    const tokens = parseMd(result.markdown);
    const blockquote = tokens.find(t => t.type === 'blockquote');
    expect(blockquote).toMatchObject({
      type: 'blockquote',
      listContinuation: { type: 'ordered', level: 1, markerWidth: 4 },
    });
  });

  it('does not warn on the rejoinder outline list-plus-blockquote pattern', async () => {
    const md = [
      '* **Clinical phrasing:**',
      '  > "In their reply, the authors devote considerable space to the difficulty of measuring abortion."',
    ].join('\n');
    const { warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);
  });
});

describe('Repeated footnote references (cross-references)', () => {
  it('first occurrence emits w:footnoteReference, subsequent emits NOTEREF field', async () => {
    const md = 'First[^1] and second[^1] reference.\n\n[^1]: Shared note.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);

    // document.xml should have both a footnoteReference and a NOTEREF field
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:footnoteReference');
    expect(docXml).toContain('NOTEREF');
    expect(docXml).toContain('_Ref100000001');
    expect(docXml).toContain('w:fldChar');

    // footnotes.xml should have a bookmark wrapping the self-ref
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
    expect(footnotesXml).toContain('w:bookmarkStart');
    expect(footnotesXml).toContain('_Ref100000001');
    expect(footnotesXml).toContain('w:bookmarkEnd');
    expect(footnotesXml).toContain('Shared note.');
  });

  it('only one footnote entry exists for repeated references', async () => {
    const md = 'First[^1] and second[^1] and third[^1].\n\n[^1]: Only one entry.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');

    // Should only have one actual footnote (plus the 2 separator stubs)
    const footnoteMatches = footnotesXml.match(/<w:footnote w:id="\d+"/g);
    expect(footnoteMatches).toHaveLength(1);
  });

  it('stores MANUSCRIPT_FOOTNOTE_CROSSREFS custom property', async () => {
    const md = 'First[^1] and second[^1].\n\n[^1]: Note.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customXml = await zip.file('docProps/custom.xml')!.async('string');
    expect(customXml).toContain('MANUSCRIPT_FOOTNOTE_CROSSREFS');
    expect(customXml).toContain('_Ref100000001');
    expect(customXml).toContain('footnote:1');
  });

  it('works with endnote mode', async () => {
    const md = '---\nnotes: endnotes\n---\n\nFirst[^1] and second[^1].\n\n[^1]: Shared endnote.';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);

    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:endnoteReference');
    expect(docXml).toContain('NOTEREF');
    expect(docXml).toContain('EndnoteReference');

    const endnotesXml = await zip.file('word/endnotes.xml')!.async('string');
    expect(endnotesXml).toContain('w:bookmarkStart');
    expect(endnotesXml).toContain('_Ref100000001');

    const customXml = await zip.file('docProps/custom.xml')!.async('string');
    expect(customXml).toContain('endnote:1');
  });

  it('NOTEREF field has \\f \\h switches and FootnoteReference style', async () => {
    const md = 'First[^1] second[^1].\n\n[^1]: Note.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');

    // instrText should contain both switches
    expect(docXml).toMatch(/NOTEREF\s+_Ref\d+\s+\\f\s+\\h/);
    // All field runs should have FootnoteReference style
    const fieldSection = docXml.slice(docXml.indexOf('NOTEREF'));
    expect(fieldSection).toContain('FootnoteReference');
  });

  it('non-repeated footnotes have no bookmarks', async () => {
    const md = 'First[^1] second[^2].\n\n[^1]: Note one.\n\n[^2]: Note two.';
    const { docx } = await convertMdToDocx(md);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');

    // No bookmarks since no cross-references needed
    expect(footnotesXml).not.toContain('w:bookmarkStart');
    expect(footnotesXml).not.toContain('w:bookmarkEnd');
  });
});
describe('parseMd list levels with blockquotes', () => {
  it('resets list level inside blockquote and preserves quote level', () => {
    const tokens = parseMd('- outer item\n> - quoted item');
    expect(tokens).toHaveLength(2);

    expect(tokens[0]).toMatchObject({
      type: 'list_item',
      level: 1,
      ordered: false,
    });

    expect(tokens[1]).toMatchObject({
      type: 'blockquote',
      level: 1,
      ordered: false,
    });
  });
});

describe('generateParagraph blockquoteStyle option', () => {
  it('uses GitHub style by default', () => {
    const token: MdToken = { type: 'blockquote', level: 1, runs: [{ type: 'text', text: 'hello' }] };
    const state = makeState();
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:pStyle w:val="GitHubBlockquote"');
  });

  it('uses IntenseQuote style when specified', () => {
    const token: MdToken = { type: 'blockquote', level: 1, runs: [{ type: 'text', text: 'hello' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'IntenseQuote' });
    expect(xml).toContain('w:pStyle w:val="IntenseQuote"');
    expect(xml).not.toContain('w:pStyle w:val="Quote"');
  });

  it('uses GitHub style when specified', () => {
    const token: MdToken = { type: 'blockquote', level: 1, runs: [{ type: 'text', text: 'hello' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'GitHub' });
    expect(xml).toContain('w:pStyle w:val="GitHubBlockquote"');
  });

  it('GitHub nested blockquote uses 240-twip indent unit', () => {
    const token: MdToken = { type: 'blockquote', level: 2, runs: [{ type: 'text', text: 'nested' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'GitHub' });
    expect(xml).toContain('w:ind w:left="480"');
    expect(xml).toContain('w:pStyle w:val="GitHubBlockquote"');
  });

  it('Quote style uses 720-twip indent unit for nesting', () => {
    const token: MdToken = { type: 'blockquote', level: 2, runs: [{ type: 'text', text: 'nested' }] };
    const state = makeState();
    const xml = generateParagraph(token, state, { blockquoteStyle: 'Quote' });
    expect(xml).toContain('w:ind w:left="1440"');
  });
});

describe('callout-labels DOCX export', () => {
  const alertMd = '> [!NOTE]\n> Useful information.';

  it('uses frontmatter over the programmatic option', async () => {
    const md = '---\ncallout-labels: false\n---\n\n' + alertMd;
    const { docx } = await convertMdToDocx(md, { calloutLabels: true });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).not.toContain('※ Note');
    expect(docXml).not.toContain('<w:br/>');
    expect(docXml).toContain('w:pStyle w:val="GitHubNote"');
  });

  it('removes the marker line break after hidden comments when labels are hidden', async () => {
    const md = '---\ncallout-labels: false\nbreaks: true\n---\n\n> [!NOTE] <!--a--> <!--b-->\n> Useful information.';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).not.toContain('<w:br/>');
    expect(docXml).toContain('&lt;!--a--&gt;');
    expect(docXml).toContain('&lt;!--b--&gt;');
    expect(docXml).toContain('Useful information.');

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown)
      .toContain('> [!NOTE] <!--a--> <!--b-->Useful information.');
    expect(result.markdown).not.toContain('\n\n<!--a-->');
  });

  it('omits the empty marker paragraph before block content', async () => {
    const md = '---\ncallout-labels: false\n---\n\n> [!NOTE]\n> - item';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml.match(/w:pStyle w:val="GitHubNote"/g)).toHaveLength(1);
    expect(docXml).toContain('<w:t>item</w:t>');
  });

  it('moves marker-line comments into block content without a blank lead', async () => {
    const md = '---\ncallout-labels: false\n---\n\n> [!NOTE] <!--a--> <!--b-->\n> - item';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml.match(/w:pStyle w:val="GitHubNote"/g)).toHaveLength(1);
    expect(docXml).toContain('&lt;!--a--&gt;');
    expect(docXml).toContain('&lt;!--b--&gt;');

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> [!NOTE] <!--a--> <!--b-->item');
    expect(result.markdown).not.toContain('\n\n<!--a-->');
  });

  it('retains a collapsed structural lead for alerts without a same-level body', async () => {
    const md = '---\ncallout-labels: false\n---\n\n> [!NOTE]\n> > nested';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val="GitHubNote"');
    expect(docXml).toContain('w:line="1" w:lineRule="exact"');

    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('> [!NOTE]');
    expect(result.markdown).toContain('> > nested');
  });

  it('stores every explicit true or false as a string custom property', async () => {
    const JSZip = (await import('jszip')).default;
    for (const calloutLabels of [true, false]) {
      const { docx } = await convertMdToDocx(alertMd, { calloutLabels });
      const zip = await JSZip.loadAsync(docx);
      const customXml = await zip.file('docProps/custom.xml')!.async('string');
      expect(customXml).toContain('name="MANUSCRIPT_CALLOUT_LABELS"');
      expect(customXml).toContain('<vt:lpwstr>' + String(calloutLabels) + '</vt:lpwstr>');
    }
  });

  it('omits the custom property when neither source is explicit', async () => {
    const { docx } = await convertMdToDocx(alertMd);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const customXml = await zip.file('docProps/custom.xml')!.async('string');
    expect(customXml).not.toContain('MANUSCRIPT_CALLOUT_LABELS');
  });
});

describe('blockquote-style frontmatter', () => {
  it('parseFrontmatter parses blockquote-style: GitHub', () => {
    const md = '---\nblockquote-style: GitHub\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.blockquoteStyle).toBe('GitHub');
  });

  it('parseFrontmatter is case-insensitive', () => {
    const md = '---\nblockquote-style: github\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.blockquoteStyle).toBe('GitHub');
  });

  it('parseFrontmatter rejects invalid value', () => {
    const md = '---\nblockquote-style: invalid\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.blockquoteStyle).toBeUndefined();
  });

  it('serializeFrontmatter includes blockquote-style', () => {
    const yaml = serializeFrontmatter({ blockquoteStyle: 'GitHub' });
    expect(yaml).toContain('blockquote-style: GitHub');
  });

  it('blockquote-style round-trips through serialize → parse', () => {
    for (const style of ['Quote', 'IntenseQuote', 'GitHub'] as const) {
      const yaml = serializeFrontmatter({ blockquoteStyle: style });
      const { metadata } = parseFrontmatter(yaml + '\nBody text');
      expect(metadata.blockquoteStyle).toBe(style);
    }
  });

  it('frontmatter blockquote-style overrides options in convertMdToDocx', async () => {
    const md = '---\nblockquote-style: IntenseQuote\n---\n\n> quoted text';
    const { docx } = await convertMdToDocx(md, { blockquoteStyle: 'Quote' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val="IntenseQuote"');
    expect(docXml).not.toContain('w:pStyle w:val="Quote"');
  });

  it('defaults to GitHub style when no frontmatter or options', async () => {
    const md = '> quoted text';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val="GitHubBlockquote"');
  });

  it('convertMdToDocx emits alert styles and monochrome title prefixes', async () => {
    const md = '> [!TIP]\n> Helpful advice';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:pStyle w:val=\"GitHubTip\"');
    expect(docXml).toContain('◈ Tip');
    expect(docXml).toContain('<w:br/>');
    expect(docXml).not.toContain('[!TIP]');
  });
});

describe('Code block language tracking', () => {
  it('records language in state when present', () => {
    const token: MdToken = {
      type: 'code_block',
      language: 'stata',
      runs: [{ type: 'text', text: 'display "hello"' }]
    };
    const state = makeState();
    generateParagraph(token, state);
    expect(state.codeBlockIndex).toBe(1);
    expect(state.codeBlockLanguages.get(0)).toBe('stata');
  });

  it('increments index without recording when no language', () => {
    const token: MdToken = {
      type: 'code_block',
      runs: [{ type: 'text', text: 'some code' }]
    };
    const state = makeState();
    generateParagraph(token, state);
    expect(state.codeBlockIndex).toBe(1);
    expect(state.codeBlockLanguages.size).toBe(0);
  });

  it('tracks multiple code blocks with mixed languages', () => {
    const state = makeState();
    generateParagraph({ type: 'code_block', language: 'python', runs: [{ type: 'text', text: 'print("hi")' }] }, state);
    generateParagraph({ type: 'code_block', runs: [{ type: 'text', text: 'plain code' }] }, state);
    generateParagraph({ type: 'code_block', language: 'r', runs: [{ type: 'text', text: 'cat("hi")' }] }, state);
    expect(state.codeBlockIndex).toBe(3);
    expect(state.codeBlockLanguages.get(0)).toBe('python');
    expect(state.codeBlockLanguages.has(1)).toBe(false);
    expect(state.codeBlockLanguages.get(2)).toBe('r');
  });
});

describe('Code block language custom properties', () => {
  it('stores language mapping in MANUSCRIPT_CODE_BLOCK_LANGS custom property', async () => {
    const md = '```stata\ndisplay "hello"\n```';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toBeDefined();
    expect(customXml).toContain('MANUSCRIPT_CODE_BLOCK_LANGS_1');
    expect(customXml).toContain('stata');
  });

  it('does not create custom property when no code block languages', async () => {
    const md = '```\nplain code\n```';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    // No custom.xml at all, or no code block langs property
    if (customXml) {
      expect(customXml).not.toContain('MANUSCRIPT_CODE_BLOCK_LANGS');
    }
  });
});

describe('Code block separator between consecutive blocks', () => {
  it('inserts empty paragraph between consecutive code blocks', async () => {
    const md = '```python\nprint("a")\n```\n\n```r\ncat("b")\n```';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toBeDefined();
    // The separator should be an empty <w:p .../> between the two code block groups
    expect(docXml).toMatch(/<w:p w14:paraId="[0-9A-F]+" w14:textId="[0-9A-F]+"[^/]*\/>/);
  });
});

describe('Blockquote to paragraph separators in DOCX export', () => {
  const separatorRe = /<w:p\s[^>]*><w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p>/g;
  it('inserts empty paragraph after callout when source has blank line before paragraph', async () => {
    const md = '> [!NOTE]\n> This is a note.\n\nThis is a paragraph.';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toBeDefined();
    expect(docXml).toContain('This is a note.');
    expect(docXml).toContain('This is a paragraph.');
    const separatorCount = (docXml!.match(separatorRe) || []).length;
    expect(separatorCount).toBe(1);
  });

  it('does not insert empty paragraph after callout when source has no blank line before paragraph', async () => {
    const md = '> [!NOTE]\n> This is a note.\nThis is a paragraph.';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const docXml = await zip.file('word/document.xml')?.async('string');
    expect(docXml).toBeDefined();
    expect(docXml).toContain('This is a note.');
    expect(docXml).toContain('This is a paragraph.');
    const separatorCount = (docXml!.match(separatorRe) || []).length;
    expect(separatorCount).toBe(0);
  });
});

// Feature: code-region-inert-zones, Task 8.2: Verify MD→DOCX converter handles code regions correctly
// Confirms that processInlineChildren handles code_inline tokens as { type: 'text', code: true } runs
// without CriticMarkup interpretation, and convertTokens handles fence tokens at block level with plain text.
// No code changes needed — markdown-it's token architecture provides sufficient protection.
describe('Code region inertness in MD→DOCX', () => {
  it('parses inline code with CriticMarkup addition as plain code run', () => {
    const tokens = parseMd('`{++added++}`');
    expect(tokens.length).toBe(1);
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{++added++}');
    expect(codeRun!.type).toBe('text');
    // No critic_add runs should exist
    expect(runs.filter(r => r.type === 'critic_add')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup deletion as plain code run', () => {
    const tokens = parseMd('`{--deleted--}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{--deleted--}');
    expect(runs.filter(r => r.type === 'critic_del')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup highlight as plain code run', () => {
    const tokens = parseMd('`{==highlighted==}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{==highlighted==}');
    expect(runs.filter(r => r.type === 'critic_highlight')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup comment as plain code run', () => {
    const tokens = parseMd('`{>>comment<<}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{>>comment<<}');
    expect(runs.filter(r => r.type === 'critic_comment')).toHaveLength(0);
  });

  it('parses inline code with CriticMarkup substitution as plain code run', () => {
    const tokens = parseMd('`{~~old~>new~~}`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('{~~old~>new~~}');
    expect(runs.filter(r => r.type === 'critic_sub')).toHaveLength(0);
  });

  it('parses inline code with format highlight as plain code run', () => {
    const tokens = parseMd('`==highlighted==`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('==highlighted==');
    expect(runs.filter(r => r.type === 'critic_highlight')).toHaveLength(0);
  });

  it('parses inline code with citation as plain code run', () => {
    const tokens = parseMd('`[@smith2020]`');
    const runs = tokens[0].runs;
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('[@smith2020]');
    expect(runs.filter(r => r.type === 'citation')).toHaveLength(0);
  });

  it('parses fenced code block with CriticMarkup as plain text code_block token', () => {
    const tokens = parseMd('```\n{++added++}\n{--deleted--}\n{==highlighted==}\n```');
    const codeBlock = tokens.find(t => t.type === 'code_block');
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.runs.length).toBe(1);
    expect(codeBlock!.runs[0].type).toBe('text');
    expect(codeBlock!.runs[0].text).toContain('{++added++}');
    expect(codeBlock!.runs[0].text).toContain('{--deleted--}');
    expect(codeBlock!.runs[0].text).toContain('{==highlighted==}');
  });

  it('parses fenced code block with language tag as plain text', () => {
    const tokens = parseMd('```python\n{++added++}\nprint("hello")\n```');
    const codeBlock = tokens.find(t => t.type === 'code_block');
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.language).toBe('python');
    expect(codeBlock!.runs[0].text).toContain('{++added++}');
  });

  it('still parses CriticMarkup outside inline code', () => {
    const tokens = parseMd('Before `code` {++after++}');
    const runs = tokens[0].runs;
    // Should have a code run for the inline code
    const codeRun = runs.find(r => r.code === true);
    expect(codeRun).toBeDefined();
    expect(codeRun!.text).toBe('code');
    // Should have a critic_add run for the CriticMarkup outside code
    const addRun = runs.find(r => r.type === 'critic_add');
    expect(addRun).toBeDefined();
    expect(addRun!.text).toBe('after');
  });

  it('parses indented code block as code_block token', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter(s => !s.includes('\n') && s.trim().length > 0),
        line => {
          const tokens = parseMd('    ' + line + '\n');
          const codeBlock = tokens.find(t => t.type === 'code_block');
          expect(codeBlock).toBeDefined();
          expect(codeBlock!.runs[0].text).toContain(line);
        }
      ),
      { numRuns: 10 }
    );
  });

  it('keeps multiline CriticMarkup literal inside an indented code block', () => {
    const tokens = parseMd('    {++first\n    second++}\n');
    const codeBlock = tokens.find(token => token.type === 'code_block');

    expect(codeBlock?.runs[0].text).toContain('{++first\nsecond++}');
    expect(codeBlock?.runs[0].text).not.toContain('PARA');
    expect(codeBlock?.runs[0].text).not.toContain('LINE');
    expect(tokens.flatMap(token => token.runs)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'critic_add' })]),
    );
  });

  it('keeps overlapping inline-code regions literal inside an indented code block', () => {
    const tokens = parseMd('    `x` `x` {++first\n    second++}\n');
    const codeBlock = tokens.find(token => token.type === 'code_block');

    expect(codeBlock?.runs[0].text).toContain('`x` `x` {++first\nsecond++}');
    expect(codeBlock?.runs[0].text).not.toContain('PARA');
    expect(codeBlock?.runs[0].text).not.toContain('LINE');
  });
});

describe('convertMdToDocx indented code blocks', () => {
  it('preserves indented code block content in docx', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 1, maxLength: 40 }).map(a => a.join('')),
        async line => {
          const markdown = '    ' + line + '\n';
          const result = await convertMdToDocx(markdown);

          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(result.docx);

          const document = await zip.files['word/document.xml'].async('string');
          expect(document).toContain(line);
          expect(document).toContain('CodeBlock');
        }
      ),
      { numRuns: 10 }
    );
  });
});

describe('colors frontmatter', () => {
  afterEach(() => {
    setDefaultColorScheme('guttmacher');
  });

  it('parseFrontmatter parses colors: guttmacher', () => {
    const md = '---\ncolors: guttmacher\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBe('guttmacher');
  });

  it('parseFrontmatter parses colors: github', () => {
    const md = '---\ncolors: github\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBe('github');
  });

  it('parseFrontmatter is case-insensitive for colors', () => {
    const md = '---\ncolors: Guttmacher\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBe('guttmacher');
  });

  it('parseFrontmatter rejects invalid colors value', () => {
    const md = '---\ncolors: rainbow\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.colors).toBeUndefined();
  });

  it('serializeFrontmatter includes colors', () => {
    const yaml = serializeFrontmatter({ colors: 'guttmacher' });
    expect(yaml).toContain('colors: guttmacher');
  });

  it('colors round-trips through serialize → parse', () => {
    for (const scheme of ['github', 'guttmacher'] as const) {
      const yaml = serializeFrontmatter({ colors: scheme });
      const { metadata } = parseFrontmatter(yaml + '\nBody text');
      expect(metadata.colors).toBe(scheme);
    }
  });

  it('generateParagraph uses guttmacher alert colors when specified', () => {
    const token: MdToken = {
      type: 'blockquote', level: 1, alertType: 'note', alertLead: true,
      runs: [{ type: 'text', text: 'info' }]
    };
    const state = makeState();
    const xml = generateParagraph(token, state, { colors: 'guttmacher' });
    expect(xml).toContain('w:val="' + GUTTMACHER_ALERT_COLORS.note + '"');
    expect(xml).not.toContain('w:val="' + GITHUB_ALERT_COLORS.note + '"');
  });

  it('generateParagraph uses guttmacher alert colors by default', () => {
    const token: MdToken = {
      type: 'blockquote', level: 1, alertType: 'note', alertLead: true,
      runs: [{ type: 'text', text: 'info' }]
    };
    const state = makeState();
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:val="' + GUTTMACHER_ALERT_COLORS.note + '"');
    expect(xml).not.toContain('w:val="' + GITHUB_ALERT_COLORS.note + '"');
  });

  it('guttmacher spacer border uses guttmacher colors', () => {
    const token: MdToken = {
      type: 'blockquote', level: 1, alertType: 'tip', alertFirst: true, alertLast: true,
      runs: [{ type: 'text', text: 'tip text' }]
    };
    const state = makeState();
    const xml = generateParagraph(token, state, { colors: 'guttmacher' });
    expect(xml).toContain('w:color="' + GUTTMACHER_ALERT_COLORS.tip + '"');
    expect(xml).not.toContain('w:color="' + GITHUB_ALERT_COLORS.tip + '"');
  });

  it('stylesXml uses guttmacher colors in alert styles', () => {
    const xml = stylesXml(undefined, undefined, 'guttmacher');
    for (const color of Object.values(GUTTMACHER_ALERT_COLORS)) {
      expect(xml).toContain(color);
    }
    for (const color of Object.values(GITHUB_ALERT_COLORS)) {
      expect(xml).not.toContain(color);
    }
  });

  it('stylesXml uses guttmacher colors by default', () => {
    const xml = stylesXml();
    for (const color of Object.values(GUTTMACHER_ALERT_COLORS)) {
      expect(xml).toContain(color);
    }
    for (const color of Object.values(GITHUB_ALERT_COLORS)) {
      expect(xml).not.toContain(color);
    }
  });

  it('frontmatter colors overrides options in convertMdToDocx', async () => {
    const md = '---\ncolors: guttmacher\n---\n\n> [!NOTE]\n> info text';
    const { docx } = await convertMdToDocx(md, { colors: 'github' });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain(GUTTMACHER_ALERT_COLORS.note);
    expect(docXml).not.toContain(GITHUB_ALERT_COLORS.note);
  });

  it('defaults to guttmacher colors when no frontmatter or options', async () => {
    const md = '> [!NOTE]\n> info text';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain(GUTTMACHER_ALERT_COLORS.note);
    expect(docXml).not.toContain(GITHUB_ALERT_COLORS.note);
  });

  it('applyAlertColorsToTemplate patches border colors for guttmacher', () => {
    // Generate a github styles.xml, then patch to guttmacher
    const original = stylesXml(undefined, undefined, 'github');
    expect(original).toContain(GITHUB_ALERT_COLORS.note);
    const patched = applyAlertColorsToTemplate(original, 'guttmacher');
    for (const color of Object.values(GUTTMACHER_ALERT_COLORS)) {
      expect(patched).toContain(color);
    }
    expect(patched).not.toContain(GITHUB_ALERT_COLORS.note);
  });

  it('applyAlertColorsToTemplate patches from guttmacher back to github', () => {
    const original = stylesXml(undefined, undefined, 'guttmacher');
    expect(original).toContain(GUTTMACHER_ALERT_COLORS.note);
    const patched = applyAlertColorsToTemplate(original, 'github');
    for (const color of Object.values(GITHUB_ALERT_COLORS)) {
      expect(patched).toContain(color);
    }
    expect(patched).not.toContain(GUTTMACHER_ALERT_COLORS.note);
  });

  it('applyAlertColorsToTemplate is a no-op for matching scheme', () => {
    for (const scheme of ['github', 'guttmacher'] as const) {
      const original = stylesXml(undefined, undefined, scheme);
      const patched = applyAlertColorsToTemplate(original, scheme);
      expect(patched).toBe(original);
    }
  });

  it('template-based export applies guttmacher colors to styles.xml', async () => {
    // First, generate a DOCX to use as template (with explicit github colors)
    const templateMd = '> [!NOTE]\n> template note';
    const { docx: templateDocx } = await convertMdToDocx(templateMd, { colors: 'github' });

    // Now convert with guttmacher using that template
    const md = '---\ncolors: guttmacher\n---\n\n> [!TIP]\n> guttmacher tip';
    const { docx } = await convertMdToDocx(md, { templateDocx: new Uint8Array(templateDocx) });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const stylesContent = await zip.file('word/styles.xml')!.async('string');
    // Template styles should have guttmacher colors patched in
    expect(stylesContent).toContain(GUTTMACHER_ALERT_COLORS.note);
    expect(stylesContent).toContain(GUTTMACHER_ALERT_COLORS.tip);
    expect(stylesContent).not.toContain(GITHUB_ALERT_COLORS.note);
  });
});

describe('alert-colors module', () => {
  afterEach(() => {
    setDefaultColorScheme('guttmacher');
  });

  it('alertColorsByScheme falls back to default scheme for unknown value', () => {
    // Default scheme is guttmacher, so unknown values should resolve to guttmacher colors
    expect(alertColorsByScheme('unknown' as any).note).toBe(GUTTMACHER_ALERT_COLORS.note);
  });

  it('setDefaultColorScheme rejects invalid values and falls back to guttmacher', () => {
    setDefaultColorScheme('github');
    setDefaultColorScheme('rainbow' as any);
    expect(getDefaultColorScheme()).toBe('guttmacher');
  });

  it('setDefaultColorScheme accepts valid values', () => {
    setDefaultColorScheme('guttmacher');
    expect(getDefaultColorScheme()).toBe('guttmacher');
    setDefaultColorScheme('github');
    expect(getDefaultColorScheme()).toBe('github');
  });
});

describe('landscape sections', () => {
  describe('parseMd', () => {
    it('converts <!-- landscape --> / <!-- /landscape --> to sentinel tokens', () => {
      const md = '<!-- landscape -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<!-- /landscape -->';
      const tokens = parseMd(md);
      expect(tokens[0].landscapeOpen).toBe(true);
      expect(tokens[0].runs).toEqual([]);
      const tableToken = tokens.find(t => t.type === 'table');
      expect(tableToken).toBeDefined();
      const closeToken = tokens[tokens.length - 1];
      expect(closeToken.landscapeClose).toBe(true);
    });

    it('nested <!-- landscape --> warns and produces close + open', () => {
      const warnings: string[] = [];
      const md = '<!-- landscape -->\n\nParagraph 1\n\n<!-- landscape -->\n\nParagraph 2\n\n<!-- /landscape -->';
      const tokens = parseMd(md, warnings);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Nested');
      expect(warnings[0]).toContain('near line 5');
      expect(warnings[0]).toContain('near line 1');
      // Should have: open, para1, close, open, para2, close
      const opens = tokens.filter(t => t.landscapeOpen);
      const closes = tokens.filter(t => t.landscapeClose);
      expect(opens.length).toBe(2);
      expect(closes.length).toBe(2);
    });

    it('unclosed <!-- landscape --> warns with line number', () => {
      const warnings: string[] = [];
      const md = 'Before\n\n<!-- landscape -->\n\nParagraph inside';
      parseMd(md, warnings);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Unclosed');
      expect(warnings[0]).toContain('landscape');
      expect(warnings[0]).toContain('near line 3');
    });

    it('orphaned <!-- /landscape --> warns with line number', () => {
      const warnings: string[] = [];
      const md = 'Before\n\n<!-- /landscape -->\n\nAfter';
      parseMd(md, warnings);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Orphaned');
      expect(warnings[0]).toContain('/landscape');
      expect(warnings[0]).toContain('near line 3');
    });

    it('portrait open inside active landscape warns as nested', () => {
      const warnings: string[] = [];
      const md = '<!-- landscape -->\n\nContent\n\n<!-- portrait -->\n\nMore\n\n<!-- /landscape -->';
      parseMd(md, warnings);
      expect(warnings.some(w => w.includes('Nested') && w.includes('portrait') && w.includes('near line 5'))).toBe(true);
    });

    it('crossed close warns about mismatch', () => {
      const warnings: string[] = [];
      const md = '<!-- landscape -->\n\nContent\n\n<!-- /portrait -->\n\nMore\n\n<!-- /landscape -->';
      parseMd(md, warnings);
      expect(warnings.some(w => w.includes('/portrait') && w.includes('landscape') && w.includes('near line 5'))).toBe(true);
    });

    it('matched <!-- landscape --> pair produces no warnings', () => {
      const warnings: string[] = [];
      const md = '<!-- landscape -->\n\nContent\n\n<!-- /landscape -->';
      parseMd(md, warnings);
      expect(warnings.length).toBe(0);
    });

    it('directives inside fenced code blocks do not warn', () => {
      const warnings: string[] = [];
      const md = '```\n<!-- landscape -->\n```';
      parseMd(md, warnings);
      expect(warnings.length).toBe(0);
    });

    it('directive-like comments inside raw HTML blocks do not warn or become sentinels', () => {
      const warnings: string[] = [];
      const md = '<div>\n<!-- landscape -->\n</div>';
      const tokens = parseMd(md, warnings);
      expect(warnings).toEqual([]);
      expect(tokens.some(t => t.landscapeOpen || t.landscapeClose)).toBe(false);
      expect(tokens).toEqual([
        {
          type: 'paragraph',
          runs: [{ type: 'text', text: '<div>\n<!-- landscape -->\n</div>' }],
        },
      ]);
    });

    it('inline orientation comments do not warn or become sentinels', () => {
      const warnings: string[] = [];
      const md = 'Paragraph <!-- landscape --> text\n\nMore text <!-- /landscape -->';
      const tokens = parseMd(md, warnings);
      expect(warnings).toEqual([]);
      expect(tokens.some(t => t.landscapeOpen || t.landscapeClose)).toBe(false);
      expect(tokens[0].runs.some(r => r.type === 'html_comment' && r.text === '<!-- landscape -->')).toBe(true);
      expect(tokens[1].runs.some(r => r.type === 'html_comment' && r.text === '<!-- /landscape -->')).toBe(true);
    });

    it('4-space and tab-indented orientation comments do not warn or become sentinels', () => {
      const warnings: string[] = [];
      const md = '    <!-- landscape -->\n\n\t<!-- /landscape -->';
      const tokens = parseMd(md, warnings);
      expect(warnings).toEqual([]);
      expect(tokens.some(t => t.landscapeOpen || t.landscapeClose)).toBe(false);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('code_block');
      expect(tokens[0].runs[0].text).toContain('<!-- landscape -->');
      expect(tokens[0].runs[0].text).toContain('<!-- /landscape -->');
    });

    it('cross-type nesting closes landscape and replaces it with portrait', () => {
      const warnings: string[] = [];
      const md = '<!-- landscape -->\n\nLandscape A\n\n<!-- portrait -->\n\nPortrait B\n\n<!-- /portrait -->\n\nLandscape C\n\n<!-- /landscape -->';
      const tokens = parseMd(md, warnings);
      expect(tokens.filter(t => t.landscapeOpen).length).toBe(1);
      expect(tokens.filter(t => t.landscapeClose).length).toBe(1);
      expect(tokens.filter(t => t.portraitOpen).length).toBe(1);
      expect(tokens.filter(t => t.portraitClose).length).toBe(1);
      const comments = tokens.filter(t => t.runs.length === 1 && t.runs[0].type === 'html_comment');
      expect(comments).toHaveLength(1);
      expect(comments[0].runs[0].text).toBe('<!-- /landscape -->');
      expect(warnings.some(w => w.includes('Nested') && w.includes('portrait'))).toBe(true);
    });

    it('cross-type close (<!-- /landscape --> while portrait active) closes portrait', () => {
      const warnings: string[] = [];
      // landscape opens, portrait nested-replaces it, /landscape is a cross-type close
      const md = '<!-- landscape -->\n\nContent\n\n<!-- portrait -->\n\nMore\n\n<!-- /landscape -->';
      const tokens = parseMd(md, warnings);
      // Converter should produce: landscapeOpen, para, landscapeClose, portraitOpen, para, portraitClose
      // The /landscape close is consumed as a portraitClose because portrait is what's actually active
      expect(tokens.filter(t => t.landscapeOpen).length).toBe(1);
      expect(tokens.filter(t => t.landscapeClose).length).toBe(1);
      expect(tokens.filter(t => t.portraitOpen).length).toBe(1);
      expect(tokens.filter(t => t.portraitClose).length).toBe(1);
      // No raw HTML comment should remain for the consumed directives
      expect(tokens.filter(t => t.runs.length === 1 && t.runs[0].type === 'html_comment').length).toBe(0);
    });

    it('orphaned close with no active orientation is left as raw comment', () => {
      const warnings: string[] = [];
      const md = 'Before\n\n<!-- /landscape -->\n\nAfter';
      const tokens = parseMd(md, warnings);
      // The close directive should survive as a raw html_comment paragraph
      const comments = tokens.filter(t => t.runs.length === 1 && t.runs[0].type === 'html_comment');
      expect(comments.length).toBe(1);
      expect(comments[0].runs[0].text).toContain('/landscape');
      // No sentinel flags should be set
      expect(tokens.every(t => !t.landscapeClose && !t.landscapeOpen)).toBe(true);
    });

    it('multiple cross-type transitions never restore prior orientations', () => {
      const warnings: string[] = [];
      // landscape → portrait → landscape, each nested-replacing the previous
      const md = '<!-- landscape -->\n\nA\n\n<!-- portrait -->\n\nB\n\n<!-- landscape -->\n\nC\n\n<!-- /landscape -->';
      const tokens = parseMd(md, warnings);
      expect(tokens.filter(t => t.landscapeOpen).length).toBe(2);
      expect(tokens.filter(t => t.landscapeClose).length).toBe(2);
      expect(tokens.filter(t => t.portraitOpen).length).toBe(1);
      expect(tokens.filter(t => t.portraitClose).length).toBe(1);
      // Two nested warnings (portrait nested in landscape, landscape nested in portrait)
      const nestedWarnings = warnings.filter(w => w.includes('Nested'));
      expect(nestedWarnings.length).toBe(2);
    });

    it('does not synthesize a restored outer section after malformed cross-type nesting', () => {
      const warnings: string[] = [];
      const md = '<!-- portrait -->\n\nA\n\n<!-- landscape -->\n\nB\n\n<!-- portrait -->\n\nC\n\n<!-- /portrait -->\n\nTail';
      const tokens = parseMd(md, warnings);
      expect(tokens.filter(t => t.landscapeOpen).length).toBe(1);
      expect(tokens.filter(t => t.landscapeClose).length).toBe(1);
      expect(tokens.filter(t => t.portraitOpen).length).toBe(2);
      expect(tokens.filter(t => t.portraitClose).length).toBe(2);
      expect(tokens.filter(t => t.runs.length === 1 && t.runs[0].type === 'html_comment').length).toBe(0);
      const finalSentinelIndex = tokens.findLastIndex(t => t.portraitClose || t.landscapeClose);
      expect(finalSentinelIndex).toBe(8);
      const tailParagraph = tokens[tokens.length - 1];
      expect(tailParagraph.type).toBe('paragraph');
      expect(tailParagraph.runs[0].type).toBe('text');
      expect(tailParagraph.runs[0].text).toBe('Tail');
    });

    it('convertMdToDocx propagates orientation warnings with line numbers', async () => {
      const md = 'Before\n\n<!-- landscape -->\n\nContent';
      const result = await convertMdToDocx(md);
      expect(result.warnings.some(w => w.includes('Unclosed') && w.includes('landscape') && w.includes('near line 3'))).toBe(true);
    });

    it('convertMdToDocx ignores directive-like comments in YAML frontmatter', async () => {
      const md = '---\nabstract: |\n  <!-- landscape -->\n---\n\nBody';
      const result = await convertMdToDocx(md);
      expect(result.warnings.some(w => w.includes('landscape'))).toBe(false);
    });

    it('transfers <!-- table-orientation: landscape --> to table token', () => {
      const md = '<!-- table-orientation: landscape -->\n\n| A | B |\n| - | - |\n| 1 | 2 |';
      const tokens = parseMd(md);
      const tableToken = tokens.find(t => t.type === 'table');
      expect(tableToken?.tableOrientation).toBe('landscape');
      // Directive comment should be spliced out
      expect(tokens.every(t => t.runs.length === 0 || t.runs[0].type !== 'html_comment' || !t.runs[0].text.includes('table-orientation'))).toBe(true);
    });

    it('transfers data-orientation="landscape" from HTML table', () => {
      const md = '<table data-orientation="landscape">\n<tr><td>A</td><td>B</td></tr>\n</table>';
      const tokens = parseMd(md);
      const tableToken = tokens.find(t => t.type === 'table');
      expect(tableToken?.tableOrientation).toBe('landscape');
    });
  });

  describe('parseTemplatePgSz', () => {
    it('returns US Letter defaults when no sectPr', () => {
      expect(parseTemplatePgSz(undefined)).toEqual({ w: 12240, h: 15840 });
    });

    it('parses portrait dimensions from sectPr', () => {
      const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
      expect(parseTemplatePgSz(sectPr)).toEqual({ w: 11906, h: 16838 });
    });

    it('normalizes landscape dimensions to portrait', () => {
      const sectPr = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>';
      expect(parseTemplatePgSz(sectPr)).toEqual({ w: 11906, h: 16838 });
    });
  });

  describe('generateDocumentXml', () => {
    it('emits trailing body sectPr with default US Letter', () => {
      const tokens: MdToken[] = [{ type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }] }];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // Should have a body-level sectPr with US Letter dimensions
      expect(xml).toMatch(/<w:sectPr[^>]*><w:pgSz w:w="12240" w:h="15840"\/>/);
      expect(xml).toContain('</w:sectPr>\n</w:body>');
    });

    it('emits section breaks for landscape sentinels', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'In landscape' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // Portrait section break before landscape content
      expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
      // Landscape section break after landscape content
      expect(xml).toContain('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>');
      // Both should have nextPage type
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(2);
    });

    it('does not emit blank portrait page between consecutive landscape blocks', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Landscape 1' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Landscape 2' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // Should have exactly 3 nextPage breaks: portrait→landscape1, landscape1→landscape2, landscape2→portrait
      // NOT 4 (which would include an empty portrait section between the two landscape blocks)
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(3);
      // Verify no empty portrait section between the two landscape sections:
      // the landscape sectPr from block 1's close should be immediately followed by landscape content,
      // not by another portrait sectPr
      const landscapeSectPrPattern = /w:orient="landscape"/g;
      const landscapeCount = (xml.match(landscapeSectPrPattern) || []).length;
      expect(landscapeCount).toBe(2);
    });

    it('emits section breaks for table-only landscape', () => {
      const tableToken: MdToken = {
        type: 'table',
        runs: [],
        tableOrientation: 'landscape',
        rows: [
          { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
          { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] },
        ],
      };
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        tableToken,
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      expect(xml).toContain('w:orient="landscape"');
      expect(state.landscapeTables.has(0)).toBe(true);
    });

    it('preserves template sectPr as body closing', () => {
      const tokens: MdToken[] = [{ type: 'paragraph', runs: [{ type: 'text', text: 'Test' }] }];
      const state = makeState();
      state.templateSectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
      const xml = generateDocumentXml(tokens, state);
      // Should reuse template sectPr as-is for the body closing
      expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
      expect(xml).toContain('</w:sectPr>\n</w:body>');
    });
  });

  describe('template reuse', () => {
    it('reuses only the trailing body-level sectPr when template contains landscape section breaks', async () => {
      const templateMd = [
        'Before',
        '',
        '<!-- landscape -->',
        '',
        'TEMPLATE_UNIQUE_MARKER',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '<!-- /landscape -->',
        '',
        'After',
      ].join('\n');
      const { docx: templateDocx } = await convertMdToDocx(templateMd);
      const { docx } = await convertMdToDocx('Hello world', { templateDocx: new Uint8Array(templateDocx) });

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(docx);
      const documentXml = await zip.file('word/document.xml')!.async('string');

      // Regression guard: old extraction could append a large tail from template body,
      // leaking template content and producing malformed XML.
      expect(documentXml).not.toContain('TEMPLATE_UNIQUE_MARKER');
      expect(XMLValidator.validate(documentXml)).toBe(true);
    });
  });
});

describe('portrait sections', () => {
  describe('parseMd', () => {
    it('converts <!-- portrait --> / <!-- /portrait --> to sentinel tokens', () => {
      const md = '<!-- portrait -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<!-- /portrait -->';
      const tokens = parseMd(md);
      expect(tokens[0].portraitOpen).toBe(true);
      expect(tokens[0].runs).toEqual([]);
      const tableToken = tokens.find(t => t.type === 'table');
      expect(tableToken).toBeDefined();
      const closeToken = tokens[tokens.length - 1];
      expect(closeToken.portraitClose).toBe(true);
    });

    it('nested <!-- portrait --> warns and produces close + open', () => {
      const warnings: string[] = [];
      const md = '<!-- portrait -->\n\nParagraph 1\n\n<!-- portrait -->\n\nParagraph 2\n\n<!-- /portrait -->';
      const tokens = parseMd(md, warnings);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Nested');
      expect(warnings[0]).toContain('near line 5');
      expect(warnings[0]).toContain('near line 1');
      const opens = tokens.filter(t => t.portraitOpen);
      const closes = tokens.filter(t => t.portraitClose);
      expect(opens.length).toBe(2);
      expect(closes.length).toBe(2);
    });

    it('unclosed <!-- portrait --> warns with line number', () => {
      const warnings: string[] = [];
      const md = 'Before\n\n<!-- portrait -->\n\nParagraph inside';
      parseMd(md, warnings);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Unclosed');
      expect(warnings[0]).toContain('portrait');
      expect(warnings[0]).toContain('near line 3');
    });

    it('orphaned <!-- /portrait --> warns with line number', () => {
      const warnings: string[] = [];
      const md = 'Before\n\n<!-- /portrait -->\n\nAfter';
      parseMd(md, warnings);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Orphaned');
      expect(warnings[0]).toContain('/portrait');
      expect(warnings[0]).toContain('near line 3');
    });

    it('matched <!-- portrait --> pair produces no warnings', () => {
      const warnings: string[] = [];
      const md = '<!-- portrait -->\n\nContent\n\n<!-- /portrait -->';
      parseMd(md, warnings);
      expect(warnings.length).toBe(0);
    });

    it('portrait directives inside fenced code blocks do not warn', () => {
      const warnings: string[] = [];
      const md = '```\n<!-- portrait -->\n```';
      parseMd(md, warnings);
      expect(warnings.length).toBe(0);
    });

    it('inline portrait comments do not warn or become sentinels', () => {
      const warnings: string[] = [];
      const md = 'Paragraph <!-- portrait --> text\n\nMore text <!-- /portrait -->';
      const tokens = parseMd(md, warnings);
      expect(warnings).toEqual([]);
      expect(tokens.some(t => t.portraitOpen || t.portraitClose)).toBe(false);
      expect(tokens[0].runs.some(r => r.type === 'html_comment' && r.text === '<!-- portrait -->')).toBe(true);
      expect(tokens[1].runs.some(r => r.type === 'html_comment' && r.text === '<!-- /portrait -->')).toBe(true);
    });

    it('transfers <!-- table-orientation: portrait --> to table token', () => {
      const md = '<!-- table-orientation: portrait -->\n\n| A | B |\n| - | - |\n| 1 | 2 |';
      const tokens = parseMd(md);
      const tableToken = tokens.find(t => t.type === 'table');
      expect(tableToken?.tableOrientation).toBe('portrait');
      expect(tokens.every(t => t.runs.length === 0 || t.runs[0].type !== 'html_comment' || !t.runs[0].text.includes('table-orientation'))).toBe(true);
    });

    it('transfers data-orientation="portrait" from HTML table', () => {
      const md = '<table data-orientation="portrait">\n<tr><td>A</td><td>B</td></tr>\n</table>';
      const tokens = parseMd(md);
      const tableToken = tokens.find(t => t.type === 'table');
      expect(tableToken?.tableOrientation).toBe('portrait');
    });
  });

  describe('generateDocumentXml', () => {
    it('emits portrait section breaks for portrait sentinels', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'In portrait fence' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // Two portrait section breaks (open + close), both with portrait dimensions
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(2);
      // No landscape orientation
      expect(xml).not.toContain('w:orient="landscape"');
      // Both breaks use portrait dimensions
      const portraitPgSzCount = (xml.match(/<w:pgSz w:w="12240" w:h="15840"\/>/g) || []).length;
      // 2 section breaks + 1 body closing = 3 portrait pgSz
      expect(portraitPgSzCount).toBe(3);
    });

    it('records portrait close ordinal in state', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Content' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
      ];
      const state = makeState();
      generateDocumentXml(tokens, state);
      // Open emits ordinal 0 (portrait break), close emits ordinal 1
      expect(state.portraitBreakOrdinals.has(1)).toBe(true);
      expect(state.sectionBreakOrdinal).toBe(2);
    });

    it('does not emit blank page between consecutive portrait blocks', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Portrait 1' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Portrait 2' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // 3 breaks: open1, close1 (skip open2), close2
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(3);
    });

    it('does not emit blank page between landscape close and portrait open', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Landscape' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Portrait' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // 3 breaks: landscapeOpen portrait break, landscapeClose landscape break (skip portraitOpen), portraitClose portrait break
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(3);
    });

    it('does not emit blank page between portrait close and landscape open', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Portrait' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Landscape' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // 3 breaks: portraitOpen portrait break, portraitClose portrait break (skip landscapeOpen), landscapeClose landscape break
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(3);
    });

    it('emits section breaks for table-only portrait', () => {
      const tableToken: MdToken = {
        type: 'table',
        runs: [],
        tableOrientation: 'portrait',
        rows: [
          { header: true, cells: [{ runs: [{ type: 'text', text: 'H' }] }] },
          { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] },
        ],
      };
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        tableToken,
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // Two portrait section breaks around the table
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(2);
      expect(xml).not.toContain('w:orient="landscape"');
      expect(state.portraitTables.has(0)).toBe(true);
      expect(state.portraitBreakOrdinals.size).toBe(1);
    });
  });
});

describe('bibliography marker', () => {
  describe('parseMd', () => {
    it('converts <!-- references --> to sentinel token', () => {
      const tokens = parseMd('Text\n\n<!-- references -->\n\nMore text');
      const marker = tokens.find(t => t.bibliographyMarker);
      expect(marker).toBeDefined();
      expect(marker!.runs).toEqual([]);
    });

    it('converts <!-- bibliography --> alias to sentinel token', () => {
      const tokens = parseMd('Text\n\n<!-- bibliography -->\n\nMore text');
      const marker = tokens.find(t => t.bibliographyMarker);
      expect(marker).toBeDefined();
    });

    it('is case-insensitive', () => {
      const tokens = parseMd('Text\n\n<!-- References -->\n\nMore text');
      expect(tokens.some(t => t.bibliographyMarker)).toBe(true);
    });

    it('warns on multiple markers and uses only the first', () => {
      const warnings: string[] = [];
      const tokens = parseMd('Text\n\n<!-- references -->\n\nMiddle\n\n<!-- references -->\n\nEnd', warnings);
      const markers = tokens.filter(t => t.bibliographyMarker);
      expect(markers.length).toBe(1);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Multiple');
    });
  });

  describe('generateDocumentXml', () => {
    it('places bibliography at marker position, not at end', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], bibliographyMarker: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // With no citeproc engine, the placeholder is just stripped — no bibliography XML.
      // But the "After" paragraph should still appear after the marker position.
      expect(xml).toContain('Before');
      expect(xml).toContain('After');
      const beforeIdx = xml.indexOf('Before');
      const afterIdx = xml.indexOf('After');
      expect(beforeIdx).toBeLessThan(afterIdx);
    });
  });
});

describe('LATENT_STYLES', () => {
  it('w:count matches actual lsdException count', () => {
    const countMatch = LATENT_STYLES.match(/w:count="(\d+)"/);
    expect(countMatch).not.toBeNull();
    const declaredCount = parseInt(countMatch![1], 10);
    const exceptions = LATENT_STYLES.match(/<w:lsdException\b/g);
    expect(exceptions).not.toBeNull();
    expect(exceptions!.length).toBe(declaredCount);
  });
});

describe('line spacing and paragraph indent', () => {
  it('double-spaced Normal style has w:line="480" and w:after="0"', () => {
    const xml = stylesXml(undefined, undefined, undefined, undefined, 'double', true);
    // Normal style
    const normalMatch = xml.match(/<w:style[^>]*w:styleId="Normal"[^>]*>([\s\S]*?)<\/w:style>/);
    expect(normalMatch).not.toBeNull();
    expect(normalMatch![1]).toContain('w:line="480"');
    expect(normalMatch![1]).toContain('w:after="0"');
    // pPrDefault also updated
    expect(xml).toContain('<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault>');
  });

  it('plain paragraph gets w:firstLine when indent mode active', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }] };
    const state = makeState();
    state.firstLineIndentTwips = 720;
    state.afterHeading = false;
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:firstLine="720"');
  });

  it('first paragraph after heading has no w:firstLine', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }] };
    const state = makeState();
    state.firstLineIndentTwips = 720;
    state.afterHeading = true;
    const xml = generateParagraph(token, state);
    expect(xml).not.toContain('w:firstLine');
  });

  it('custom-styled paragraph inherits document-level indent when style indent is unset', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }] };
    const state = makeState();
    state.activeCustomStyle = 'pullquote';
    state.customStyles = {
      pullquote: { font: 'Georgia' },
    };
    state.firstLineIndentTwips = 720;
    state.afterHeading = false;
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:pStyle w:val="MsCustomPullquote"');
    expect(xml).toContain('w:firstLine="720"');
  });

  it('custom-styled paragraph suppresses inherited document-level indent when style sets paragraph-indent: none', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }] };
    const state = makeState();
    state.activeCustomStyle = 'pullquote';
    state.customStyles = {
      pullquote: { paragraphIndent: 'none' },
    };
    state.firstLineIndentTwips = 720;
    state.afterHeading = false;
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:pStyle w:val="MsCustomPullquote"');
    expect(xml).not.toContain('w:firstLine="720"');
  });

  it('custom-styled first paragraph after heading still suppresses document-level indent when style indent is unset', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }] };
    const state = makeState();
    state.activeCustomStyle = 'pullquote';
    state.customStyles = {
      pullquote: { font: 'Georgia' },
    };
    state.firstLineIndentTwips = 720;
    state.afterHeading = true;
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:pStyle w:val="MsCustomPullquote"');
    expect(xml).not.toContain('w:firstLine');
  });

  it('bibliography paragraphs have Bibliography style by default', async () => {
    const md = '---\ncsl: apa\nbibliography: test.bib\n---\nSome text [@key1]\n';
    const { docx } = await convertMdToDocx(md, {
      bibtex: '@article{key1, author={Smith}, title={Title}, journal={J}, year={2020}}'
    });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    expect(doc).toContain('w:pStyle w:val="Bibliography"');
  });

  it('bibliography-hanging-indent: false produces bib paragraphs without style', async () => {
    const md = '---\ncsl: apa\nbibliography: test.bib\nbibliography-hanging-indent: false\n---\nSome text [@key1]\n';
    const { docx } = await convertMdToDocx(md, {
      bibtex: '@article{key1, author={Smith}, title={Title}, journal={J}, year={2020}}'
    });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    // When hanging-indent is false, bib paragraphs should NOT have the Bibliography style
    expect(doc).not.toContain('w:pStyle w:val="Bibliography"');
  });

  it('paragraph-indent: none with line-spacing: double produces no first-line indent', async () => {
    const md = '---\nline-spacing: double\nparagraph-indent: none\n---\n# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    expect(doc).not.toContain('w:firstLine');
    // But Normal style should still have double spacing
    const styles = await zip.file('word/styles.xml')!.async('text');
    const normalMatch = styles.match(/<w:style[^>]*w:styleId="Normal"[^>]*>([\s\S]*?)<\/w:style>/);
    expect(normalMatch![1]).toContain('w:line="480"');
    // paragraph-indent: none deactivates indent mode → inter-paragraph gap preserved
    expect(normalMatch![1]).toContain('w:after="200"');
  });

  it('custom-styled paragraphs inherit global indent in double-spaced documents, except after headings', async () => {
    const md = [
      '---',
      'line-spacing: double',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '---',
      '',
      '# Heading',
      '',
      '<!-- style: pullquote -->',
      '',
      'First paragraph.',
      '',
      'Second paragraph.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    expect(doc).toContain('<w:pStyle w:val="MsCustomPullquote"/>');
    expect(doc).toContain('First paragraph.</w:t>');
    expect(doc).toContain('Second paragraph.</w:t>');
    expect(doc).toContain('Second paragraph.</w:t></w:r></w:p>');
    expect(doc).toContain('w:firstLine="720"');
    const firstIdx = doc.indexOf('First paragraph.');
    const secondIdx = doc.indexOf('Second paragraph.');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    const firstWindow = doc.slice(Math.max(0, firstIdx - 250), firstIdx);
    const secondWindow = doc.slice(Math.max(0, secondIdx - 250), secondIdx);
    expect(firstWindow).not.toContain('w:firstLine="720"');
    expect(secondWindow).toContain('w:firstLine="720"');
  });

  it('custom-style paragraph-indent: none suppresses global indent in double-spaced documents', async () => {
    const md = [
      '---',
      'line-spacing: double',
      'styles:',
      '  pullquote:',
      '    paragraph-indent: none',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'Styled text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    const styles = await zip.file('word/styles.xml')!.async('text');
    expect(doc).not.toContain('w:firstLine="720"');
    expect(styles).toContain('w:styleId="MsCustomPullquote"');
    expect(styles).toContain('w:firstLine="0"');
  });

  it('Bibliography style has single-line spacing and hanging indent by default', () => {
    const xml = stylesXml(undefined, undefined, undefined, undefined, 'double', true);
    const bibMatch = xml.match(/<w:style[^>]*w:styleId="Bibliography"[^>]*>([\s\S]*?)<\/w:style>/);
    expect(bibMatch).not.toBeNull();
    expect(bibMatch![1]).toContain('w:line="240"');
    expect(bibMatch![1]).toContain('w:hanging="720"');
    expect(bibMatch![1]).toContain('w:after="200"');
  });

  it('Bibliography style omits hanging indent when disabled', () => {
    const xml = stylesXml(undefined, undefined, undefined, undefined, 'double', true, false);
    const bibMatch = xml.match(/<w:style[^>]*w:styleId="Bibliography"[^>]*>([\s\S]*?)<\/w:style>/);
    expect(bibMatch).not.toBeNull();
    expect(bibMatch![1]).not.toContain('w:hanging');
  });
});

describe('line spacing round-trip', () => {
  it('MD→DOCX→MD preserves line-spacing: double', async () => {
    const md = '---\nline-spacing: double\n---\n\nHello world.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('line-spacing: double');
  });

  it('MD→DOCX→MD preserves paragraph-indent: none', async () => {
    const md = '---\nline-spacing: double\nparagraph-indent: none\n---\n\nHello world.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('paragraph-indent: none');
  });

  it('MD→DOCX→MD preserves bibliography-hanging-indent: false', async () => {
    const md = '---\nbibliography-hanging-indent: false\n---\n\nHello world.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('bibliography-hanging-indent: false');
  });

  it('MD→DOCX→MD preserves numeric line-spacing', async () => {
    const md = '---\nline-spacing: 1.8\n---\n\nHello world.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('line-spacing: 1.8');
  });

  it('MD→DOCX→MD preserves paragraph-indent: 0.3', async () => {
    const md = '---\nparagraph-indent: 0.3\n---\n\nHello world.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('paragraph-indent: 0.3');
  });

  it('explicit paragraph-indent with single spacing activates indent mode (no inter-paragraph gap)', async () => {
    const md = '---\nparagraph-indent: 0.5\n---\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const styles = await zip.file('word/styles.xml')!.async('text');
    const normalMatch = styles.match(/<w:style[^>]*w:styleId="Normal"[^>]*>([\s\S]*?)<\/w:style>/);
    expect(normalMatch).not.toBeNull();
    // Explicit paragraph-indent activates indent mode → w:after="0" (no gap)
    expect(normalMatch![1]).toContain('w:after="0"');
    // End-to-end: document.xml paragraphs carry the expected first-line indent
    const doc = await zip.file('word/document.xml')!.async('text');
    expect(doc).toContain('w:firstLine="720"');
  });

  it('title suppresses first-line indent on next paragraph', async () => {
    const md = '---\ntitle: My Title\nline-spacing: double\n---\n\nFirst paragraph after title.\n\nSecond paragraph.\n';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    // Split on <w:p to get all paragraphs (some have attributes like w14:paraId)
    const paras = doc.split(/<w:p[\s>]/).slice(1);
    // Title paragraph has pStyle=Title
    const titleIdx = paras.findIndex(p => p.includes('w:pStyle w:val="Title"'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    const firstBodyPara = paras[titleIdx + 1];
    expect(firstBodyPara).toContain('First paragraph after title');
    expect(firstBodyPara).not.toContain('w:firstLine');
    // Second body paragraph should have the indent
    const secondBodyPara = paras[titleIdx + 2];
    expect(secondBodyPara).toContain('Second paragraph');
    expect(secondBodyPara).toContain('w:firstLine');
  });
});

describe('per-paragraph indent overrides', () => {
  it('parseMd transfers <!-- no-indent --> to next paragraph', () => {
    const tokens = parseMd('<!-- no-indent -->\nFirst paragraph.\n\nSecond paragraph.');
    const para = tokens.find(t => t.type === 'paragraph' && t.runs.some(r => r.text === 'First paragraph.'));
    expect(para).toBeDefined();
    expect(para!.indentOverride).toBe('no-indent');
    // Second paragraph should have no override
    const para2 = tokens.find(t => t.type === 'paragraph' && t.runs.some(r => r.text === 'Second paragraph.'));
    expect(para2).toBeDefined();
    expect(para2!.indentOverride).toBeUndefined();
  });

  it('parseMd transfers <!-- indent --> to next paragraph', () => {
    const tokens = parseMd('<!-- indent -->\nForced indent.');
    const para = tokens.find(t => t.type === 'paragraph' && t.runs.some(r => r.text === 'Forced indent.'));
    expect(para).toBeDefined();
    expect(para!.indentOverride).toBe('indent');
  });

  it('<!-- no-indent --> suppresses first-line indent in DOCX', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }], indentOverride: 'no-indent' };
    const state = makeState();
    state.firstLineIndentTwips = 720;
    state.afterHeading = false;
    const xml = generateParagraph(token, state);
    expect(xml).not.toContain('w:firstLine');
  });

  it('<!-- indent --> forces first-line indent even after heading', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }], indentOverride: 'indent' };
    const state = makeState();
    state.firstLineIndentTwips = 720;
    state.afterHeading = true;
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:firstLine="720"');
  });

  it('<!-- indent --> forces first-line indent without document-level indent mode', () => {
    const token: MdToken = { type: 'paragraph', runs: [{ type: 'text', text: 'Hello' }], indentOverride: 'indent' };
    const state = makeState();
    // No firstLineIndentTwips set (no document-level indent mode)
    const xml = generateParagraph(token, state);
    expect(xml).toContain('w:firstLine="720"'); // default 0.5 inch
  });

  it('MD→DOCX→MD round-trips <!-- no-indent --> sentinel', async () => {
    const md = '---\nline-spacing: double\n---\n\n# Heading\n\nFirst paragraph.\n\n<!-- no-indent -->\nSecond paragraph.\n\nThird paragraph.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- no-indent -->\nSecond paragraph.');
    // Third paragraph should not have a sentinel
    expect(result.markdown).not.toContain('<!-- no-indent -->\nThird paragraph.');
  });

  it('MD→DOCX→MD round-trips <!-- indent --> sentinel', async () => {
    const md = '---\nline-spacing: double\n---\n\n# Heading\n\n<!-- indent -->\nFirst paragraph after heading.\n\nSecond paragraph.\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- indent -->\nFirst paragraph after heading.');
  });

  it('parseMd transfers <!-- no-indent --> to all list items', () => {
    const tokens = parseMd('<!-- no-indent -->\n1. apple\n2. pear');
    // Directive should be consumed
    expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment' && r.text.includes('no-indent')))).toHaveLength(0);
    // All list items should have the override
    const listItems = tokens.filter(t => t.type === 'list_item');
    expect(listItems).toHaveLength(2);
    expect(listItems[0].indentOverride).toBe('no-indent');
    expect(listItems[1].indentOverride).toBe('no-indent');
  });

  it('parseMd transfers <!-- indent --> to bullet list items', () => {
    const tokens = parseMd('<!-- indent -->\n- alpha\n- beta\n- gamma');
    const listItems = tokens.filter(t => t.type === 'list_item');
    expect(listItems).toHaveLength(3);
    for (const item of listItems) {
      expect(item.indentOverride).toBe('indent');
    }
  });

  it('MD→DOCX→MD round-trips <!-- no-indent --> before a list', async () => {
    const md = '---\nline-spacing: double\n---\n\n# Heading\n\nSome text.\n\n<!-- no-indent -->\n1. apple\n2. pear\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- no-indent -->\n1. apple');
    expect(result.markdown).toContain('2. pear');
  });

  it('MD→DOCX→MD round-trips inline style sentinels without extra blank lines', async () => {
    const md = '<!-- style: caption -->**Table 1. Text**<!-- /style -->\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- style: caption -->\n**Table 1. Text**\n<!-- /style -->');
    expect(result.markdown).not.toContain('**Table 1. Text**\n\n<!-- /style -->');
  });

  it('MD→DOCX→MD round-trips blank line before separate style sentinel', async () => {
    const md = '---\nstyles:\n  caption: Caption\n---\n\nParagraph text.\n\n<!-- style: caption -->\n**Caption text**\n<!-- /style -->\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    // The blank line before <!-- style: caption --> must survive
    expect(result.markdown).toContain('Paragraph text.\n\n<!-- style: caption -->');
  });

  it('MD→DOCX→MD round-trips blank line before style sentinel with hard breaks and images', async () => {
    const md = '---\nstyles:\n  caption: Caption\n---\n\nParagraph text about age 40.\n\n<!-- style: caption -->\n**Figure 4. Title**\\\n![](image.png){width=624 height=312}\\\n*Notes here.*\n<!-- /style -->\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('age 40.\n\n<!-- style: caption -->');
  });

  it('MD→DOCX→MD preserves zero-gap before style sentinel', async () => {
    const md = '---\nstyles:\n  caption: Caption\n---\n\nParagraph text.\n<!-- style: caption -->\n**Caption text**\n<!-- /style -->\n';
    const { docx } = await convertMdToDocx(md);
    const { convertDocx } = await import('./converter');
    const result = await convertDocx(docx);
    // Zero gap (no blank line) before the sentinel must be preserved
    expect(result.markdown).toContain('Paragraph text.\n<!-- style: caption -->');
    expect(result.markdown).not.toContain('Paragraph text.\n\n<!-- style: caption -->');
  });
});
