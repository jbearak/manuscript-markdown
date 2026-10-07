import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
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
import { getDisplayWidth } from './grid-table-preprocess';
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
    tableHtmlAround: new Map(),
    tablesAlike: new Map(),
    tableIdentities: [],
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
    expect(generateRPr(run)).toBe('<w:rPr><w:rStyle w:val="CodeChar"/><w:b/><w:i/><w:strike/><w:highlight w:val="blue"/><w:u w:val="single"/><w:vertAlign w:val="superscript"/></w:rPr>');
  });
});

describe('GFM support in Markdown→DOCX parser', () => {
  it('parses bare URLs as links (autolink literals)', () => {
    const tokens = parseMd('Visit https://example.com for docs.');
    const hrefRun = tokens[0].runs.find(run => run.href === 'https://example.com');
    expect(hrefRun).toBeDefined();
    expect(hrefRun?.text).toBe('https://example.com');
  });

  it('leaves bare domain names as text, as the VS Code preview does', () => {
    // Fuzzy linkify reads sd.ky (the .ky TLD) and README.md (.md) as links,
    // and a protocol-relative link has no scheme for Word to open
    const tokens = parseMd('Uses sd.ky[3,2], README.md, //example.com and www.example.com, or me@example.com.');
    const hrefs = tokens[0].runs.filter(run => run.href).map(run => run.href);
    expect(hrefs).toEqual(['mailto:me@example.com']);
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

  it.each([
    ['code', '`[ ] a`'], ['bold', '**[ ] a**'], ['italic', '*[x] a*'], ['a link', '[[ ] a](https://e.com)'],
    ['strikethrough', '~~[ ] a~~'], ['a highlight', '==[ ] a=='], ['an escaped bracket', '\\[ ] a'], ['after an image', '![](x.png) [ ] a'],
    ['a bracket written as an entity', '&#91; ] a'], ['a bracket written as a named entity', '&lbrack; ] a'],
  ])('reads a task\'s box only from text that starts the item, not in %s', (_name, item) => {
    // As GFM: export read one through code, formatting, a link or an
    // escape, which a Word list item's text, as import writes it, can start
    // with
    const [listItem] = parseMd('- ' + item).filter(t => t.type === 'list_item');
    expect(listItem.taskChecked).toBeUndefined();
    expect(listItem.runs.map(r => r.text).join('')).toContain('] a');
  });

  it('reads a task\'s box only from the item\'s first block, not a paragraph after a list', () => {
    // As GFM and the preview, which read no box where a list comes first
    const [listItem] = parseMd('-\n  - child\n\n  [ ] later').filter(t => t.type === 'list_item');
    expect(listItem.taskChecked).toBeUndefined();
  });

  it.each([
    ['code', '> `[!NOTE]`'], ['bold', '> **[!NOTE]**'], ['a link', '> [[!NOTE]](https://e.com)'], ['an escaped bracket', '> \\[!NOTE]'],
    ['a bracket written as an entity', '> &lbrack;!NOTE]'],
    ['mid-line', '> a **b** [!NOTE]'], ['bold, on a later line', '> a\n> **[!TIP]**'],
  ])('reads an alert\'s marker only from text that starts a line, not in %s', (_name, md) => {
    const tokens = parseMd(md);
    expect(tokens.some(t => t.alertType)).toBe(false);
    expect(tokens.map(t => t.runs.map(r => r.text).join('')).join('')).toContain('[!');
  });

  it('reads alerts\' markers that start a quote\'s lines', () => {
    expect(parseMd('> [!NOTE]\n> b\n> [!TIP]\n> c').map(t => t.alertType)).toEqual(['note', 'tip']);
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

  // Import writes these where Markdown's delimiters wouldn't read as emphasis
  it.each([
    ['<b>', 'a<b>.b</b>c', 'bold'],
    ['<strong>', 'a<strong>.b</strong>c', 'bold'],
    ['<i>', 'a<i>.b</i>c', 'italic'],
    ['<em>', 'a<em>.b</em>c', 'italic'],
    ['<s>', 'a<s>.b</s>c', 'strikethrough'],
    ['<del>', 'a<del>.b</del>c', 'strikethrough'],
    ['<strike>', 'a<strike>.b</strike>c', 'strikethrough'],
    ['<B>', 'a<B>.b</B>c', 'bold'],
  ] as const)('reads %s as formatting', (_tag, md, format) => {
    const runs = parseMd(md)[0].runs;
    expect(runs.map(run => [run.text, !!run[format]])).toEqual([['a', false], ['.b', true], ['c', false]]);
  });

  it('keeps formatting on past a tag of it closing inside its delimiters', () => {
    const runs = parseMd('**a <b>b</b> c** d *e <i>f</i>* g')[0].runs;
    expect(runs.map(run => [run.text, !!run.bold, !!run.italic])).toEqual([
      ['a ', true, false], ['b', true, false], [' c', true, false], [' d ', false, false],
      ['e ', false, true], ['f', false, true], [' g', false, false],
    ]);
  });

  it('reads a tag with a space before its >, as markdown-it does', () => {
    const runs = parseMd('a <b >b</b > c <u\t>d</u\t> e')[0].runs;
    expect(runs.map(run => [run.text, !!run.bold, !!run.underline])).toEqual([
      ['a ', false, false], ['b', true, false], [' c ', false, false], ['d', false, true], [' e', false, false],
    ]);
  });

  it('keeps a tag with attributes as text', () => {
    const runs = parseMd('a <b class="x">b</b>')[0].runs;
    expect(runs.some(run => run.bold)).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe('a <b class="x">b</b>');
  });

  it('keeps a closing tag no tag opened as text, in emphasis of its kind', () => {
    // </b> closed the bold of **, which ended before c
    const runs = parseMd('**a <b class="x">b</b> c** d </i>')[0].runs;
    expect(runs.map(run => [run.text, !!run.bold])).toEqual([
      ['a ', true], ['<b class="x">', true], ['b', true], ['</b>', true], [' c', true], [' d ', false], ['</i>', false],
    ]);
  });

  it('keeps the closing tag of a tag with attributes as text, in a tag of its kind', () => {
    // The inner </b> closed the outer <b>, which ended before c
    const runs = parseMd('<b>a <b class="x">b</b> c</b> d')[0].runs;
    expect(runs.map(run => [run.text, !!run.bold])).toEqual([
      ['a ', true], ['<b class="x">', true], ['b', true], ['</b>', true], [' c', true], [' d', false],
    ]);
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

  it.each([
    ['after a table', '<table><tr><td>a</td></tr></table>\n<!-- <table><tr><td>b</td></tr></table> -->', ['table']],
    // Which is a block of HTML with no table, kept as text
    ['in a div', '<div><!-- <table><tr><td>b</td></tr></table> --></div>', ['<div><!-- <table><tr><td>b</td></tr></table> --></div>']],
    ['before a table', '<!-- <table><tr><td>b</td></tr></table> --><table><tr><td>a</td></tr></table>', ['table']],
    // That runs to the end, with no -->
    ['with no end', '<!-- <table><tr><td>b</td></tr></table>', ['<!-- <table><tr><td>b</td></tr></table>']],
    ['with no end in a div', '<div><!-- <table><tr><td>b</td></tr></table>', ['<div><!-- <table><tr><td>b</td></tr></table>']],
  ])('reads no table in a comment %s', (_name, markdown, expected) => {
    // A table commented out was one in Word
    const tokens = parseMd(markdown);
    expect(tokens.map(t => t.type === 'table' ? 'table' : t.runs.map(r => r.text).join(''))).toEqual(expected);
    const table = tokens.find(t => t.type === 'table');
    if (table) expect(table.rows?.[0].cells[0].runs[0].text).toBe('a');
  });

  it.each([
    ['row', '<table>\n<!-- <tr><td>old</td></tr> -->\n<tr><td>a</td></tr>\n</table>'],
    ['row with no end', '<table>\n<tr><td>a</td></tr>\n<!-- <tr><td>old</td></tr>\n</table>'],
    ['cell', '<table><tr><!-- <td>old</td> --><td>a</td></tr></table>'],
  ])('reads no %s in a comment', (_name, markdown) => {
    // A row or cell commented out, which the preview hides, was one in Word
    const table = parseMd(markdown).find(t => t.type === 'table');
    expect(table?.rows?.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual([['a']]);
  });

  it('warns of a comment between a table\'s rows, which Word\'s table can\'t hold', async () => {
    const { warnings } = await convertMdToDocx('<table>\n<!-- <tr><td>old</td></tr> -->\n<tr><td>a</td></tr>\n</table>');
    expect(warnings).toContain('Comment between an HTML table\'s rows or cells dropped during conversion (not supported). Move it outside the table for round-trip fidelity.');
  });

  it.each([
    ['a row', '<table><!-- <tr><td>old</td></tr> --></table>'],
    ['a cell', '<table><tr><!-- <td>old</td> --></tr></table>'],
    ['rows, in a div with a caption,', '<div>\n<p>Cap</p>\n<table>\n<!-- <tr><td>a</td></tr> -->\n<!-- <tr><td>b</td></tr> -->\n</table>\n</div>'],
  ])('writes a table with only %s in comments as text, as other HTML, with a warning', async (_name, markdown) => {
    // Which Word's table can't hold, and hidden, lost the rest of the block
    const tokens = parseMd(markdown);
    expect(tokens.map(t => t.type)).toEqual(['paragraph']);
    expect(tokens[0].runs).toEqual([{ type: 'text', text: markdown }]);
    const { warnings } = await convertMdToDocx(markdown);
    expect(warnings).toContain('HTML table whose rows are all in comments exported as text (not supported). Move the comments outside the table for round-trip fidelity.');
  });

  it('applies no directive in a comment in a table with only comments', async () => {
    // Which, as a comment of its own, set the next table's font size
    const { docx } = await convertMdToDocx('<table><!-- table-font-size: 24 --></table>\n\n| a |\n| --- |\n| b |\n');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toContain('<w:sz w:val="48"/>');
  });

  it.each([
    ['between paragraphs', '<p>a</p><!-- c --><p>b</p>', ['a', '<!-- c -->', '\n', 'b']],
    ['before a paragraph', '<!-- c --><p>a</p>', ['<!-- c -->', 'a']],
    ['after a paragraph', '<p>a </p><!-- c -->', ['a', '<!-- c -->']],
    ['before a paragraph, after one', '<p>a</p>\n<!-- c -->\n<p> b</p>', ['a', '<!-- c -->', '\n', 'b']],
  ])('starts no paragraph of a cell for a comment %s', (_name, cell, texts) => {
    // Which showed in Word as an empty paragraph, though the preview hides it
    const table = parseMd('<table><tr><td>' + cell + '</td></tr></table>').find(t => t.type === 'table');
    expect(table?.rows?.[0].cells[0].runs.map(run => run.text)).toEqual(texts);
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

  it.each([
    ['display columns, a wide character taking two', ['+------+-----+', '| x    | y   |', '+======+=====+', '| 中文 | b   |', '+------+-----+']],
    ['characters, as Expand Table pads them', ['+-----+-----+', '| x   | y   |', '+=====+=====+', '| 中文  | b   |', '+-----+-----+']],
  ])('reads the cells of a grid table padded by %s', (_name, lines) => {
    // The cells were cut at the + signs' indices, so a wide character moved
    // the text after it into the next cell, with the | between them
    const table = parseMd(lines.join('\n')).find(t => t.type === 'table');
    expect(table?.rows?.[1].cells.map(cell => cell.runs.map(run => run.text).join(''))).toEqual(['中文', 'b']);
  });

  it('keeps a | at the start of a grid table\'s cell', () => {
    // It was taken for the | at the cell's edge
    const table = parseMd('+-----+-----+\n| x   | y   |\n+=====+=====+\n| |a  | b|  |\n+-----+-----+').find(t => t.type === 'table');
    expect(table?.rows?.[1].cells.map(cell => cell.runs.map(run => run.text).join(''))).toEqual(['|a', 'b|']);
  });

  it('keeps no-break and ideographic spaces at the edges of a grid table cell\'s line', () => {
    // They went with the spaces and tabs padding the line
    const table = parseMd('+-----+\n| x   |\n+=====+\n| \u00a0\u00a0b |\n| c\u3000 |\n+-----+').find(t => t.type === 'table');
    expect(table?.rows?.[1].cells[0].runs.map(run => run.type === 'hardbreak' ? '\n' : run.text).join('')).toBe('\u00a0\u00a0b\nc\u3000');
  });

  it('reads the cells of a grid table Pandoc pads around emoji and combining marks', () => {
    // Pandoc 3.11's padding, by display width, where a skin tone, a joiner's
    // emoji, a flag's second letter and a mark count none, and a variation
    // selector-16 makes a narrow character wide; each counted one, or a flag
    // four, so a cell took the next one's |
    const lines = ['+-------+----+', '| x     | y  |', '+=======+====+'];
    for (const [k, text] of ['a👍🏽', 'a🇺🇸', 'aที่นี่', 'a👨‍👩‍👧', 'a✔️', 'a✅', 'a☺', 'a\u00adb'].entries()) {
      lines.push('| ' + text + ' '.repeat(5 - getDisplayWidth(text)) + ' | ' + String(k).padEnd(2) + ' |', '+-------+----+');
    }
    const table = parseMd(lines.join('\n')).find(t => t.type === 'table');
    expect(table?.rows?.slice(1).map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual(
      ['a👍🏽', 'a🇺🇸', 'aที่นี่', 'a👨‍👩‍👧', 'a✔️', 'a✅', 'a☺', 'a\u00adb'].map((text, k) => [text, String(k)]));
  });

  it.each([
    ['an escaped |', '+----------+---------+\n| 𝑎𝑏𝑐𝑑 | x\\|中文文字 |\n+----------+---------+', ['𝑎𝑏𝑐𝑑', 'x|中文文字']],
    ['a | in code', '+----------+----------+\n| 𝑎𝑏𝑐𝑑 | `x|中文文字` |\n+----------+----------+', ['𝑎𝑏𝑐𝑑', '`x|中文文字`']],
    ['a | in its one cell', '+----------+\n| 中文文字 | a |\n+----------+', ['中文文字 | a']],
    ['a spaced | in code', '+----------+-----------+\n| 𝑎𝑏𝑐𝑑 | ` | 中文文字` |\n+----------+-----------+', ['𝑎𝑏𝑐𝑑', '` | 中文文字`']],
    ['a spaced | in code that ends in a backslash', '+----------+------------+\n| 𝑎𝑏𝑐𝑑 | ` | 中文文字\\` |\n+----------+------------+', ['𝑎𝑏𝑐𝑑', '` | 中文文字\\`']],
    ['backticks in two cells', '+-------------+-----------+\n| 𝑎𝑏𝑐𝑑𝑒` | a` |中文文字文 |\n+-------------+-----------+', ['𝑎𝑏𝑐𝑑𝑒`', 'a` |中文文字文']],
  ])('reads a grid table Expand Table pads by characters, with %s under a + by display columns', (_name, md, cells) => {
    // Both ways lined up, and the | in the cell under the + was taken for
    // the cell's edge, so the cells' text moved
    const table = parseMd(md).find(t => t.type === 'table');
    expect(table?.rows?.[0].cells.map(cell => cell.runs.map(run => run.code ? '`' + run.text + '`' : run.text).join(''))).toEqual(cells);
  });

  it.each([
    ['characters', ['| 𝑎𝑏𝑐𝑑 | a | 中文文字 |', '| 中文' + ' '.repeat(7) + '| b' + ' '.repeat(8) + '|'], [['𝑎𝑏𝑐𝑑', 'a | 中文文字'], ['中文', 'b']]],
    ['characters, with an edge that touches its text', ['| 𝑎𝑏𝑐𝑑a| a | 中文文字 |', '| 中文' + ' '.repeat(7) + '| b' + ' '.repeat(8) + '|'], [['𝑎𝑏𝑐𝑑a', 'a | 中文文字'], ['中文', 'b']]],
    ['display columns', ['| 𝑎𝑏𝑐𝑑 | a | 中文文字 |', '| 中文' + ' '.repeat(5) + '| b' + ' '.repeat(8) + '|'], [['𝑎𝑏𝑐𝑑 | a', '中文文字'], ['中文', 'b']]],
  ])('reads a line that lines up both ways, with a | in a cell under a +, as its table\'s other line padded by %s', (_name, lines, rows) => {
    const sep = '+----------+----------+';
    const table = parseMd([sep, ...lines.flatMap(line => [line, sep])].join('\n')).find(t => t.type === 'table');
    expect(table?.rows?.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual(rows);
  });

  it('keeps a grid table cell\'s edge right after a backslash at the cell\'s end', () => {
    const table = parseMd('+-----+-----+\n| abc\\| b|  |\n+-----+-----+').find(t => t.type === 'table');
    expect(table?.rows?.[0].cells.map(cell => cell.runs.map(run => run.text).join(''))).toEqual(['abc\\', 'b|']);
  });

  it.each(['👍🏽', '🇺🇸', '👨‍👩‍👧', '✔️'])('keeps a | after %s in a grid table\'s cell', (emoji) => {
    // Each character's width was counted alone, as a skin tone two, so the
    // cell's | was taken for the one under the +
    const text = emoji + ' |';
    const table = parseMd('+------+-----+\n| ' + text + ' '.repeat(4 - getDisplayWidth(text)) + ' | b   |\n+------+-----+').find(t => t.type === 'table');
    expect(table?.rows?.[0].cells.map(cell => cell.runs.map(run => run.text).join(''))).toEqual([text, 'b']);
  });

  it('keeps a | in a grid table\'s cell after joined emoji Pandoc pads as the last of each', () => {
    // 🏳 is narrow and 🌈 wide, and the sequence was counted as 🏳
    const table = parseMd('+--------------------+--------------------+\n| 🏳\u200d🌈🏳\u200d🌈🏳\u200d🌈             | a|x                |\n+--------------------+--------------------+').find(t => t.type === 'table');
    expect(table?.rows?.[0].cells.map(cell => cell.runs.map(run => run.text).join(''))).toEqual(['🏳\u200d🌈🏳\u200d🌈🏳\u200d🌈', 'a|x']);
  });

  it.each([
    ['👍🏽', 2], ['☝🏽', 2], ['👩🏽‍💻', 2], ['🧑🏽‍🦰', 2], ['🇺🇸', 2], ['🇺', 1], ['ที่นี่', 2], ['e\u0301', 1], ['👨‍👩‍👧', 2], ['🏳️‍🌈', 2], ['✔️', 2], ['#️⃣', 2],
    ['✅', 2], ['⭐', 2], ['🅰', 1], ['🅰️', 2], ['🏽', 2], ['中', 2], ['１', 2], ['ｱ', 1], ['a\u00adb', 2], ['a\u200db', 2], ['☺\ufe0e', 1],
    ['🏳\u200d🌈', 2], ['🌈\u200d🏳', 1], ['🌈\u200da', 1], ['🌈\u200d', 0], ['🇺🇸\u200d🌈', 3], ['☝\ufe0f🏽', 4], ['🌈🏽', 4], ['a🏽', 3], ['a\ufe0f', 1], ['⌚\ufe0f\u200da', 3], ['#\u200d🌈', 2],
  ])('counts %j as %d columns wide, as Pandoc does', (text, width) => {
    expect(getDisplayWidth(text)).toBe(width);
  });

  it('cuts a grid table\'s line that lines up neither way at the | nearest each +', () => {
    // An emoji whose width an editor counts otherwise, two columns off
    const table = parseMd('+-----+-----+\n| x   | y   |\n+=====+=====+\n| a| | b   |\n+-----+-----+\n| 🧑‍🦰   | c |\n+-----+-----+').find(t => t.type === 'table');
    expect(table?.rows?.slice(1).map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual([['a|', 'b'], ['🧑‍🦰', 'c']]);
  });

  it('keeps a | in the last cell of a grid table\'s line that lines up neither way', () => {
    // The | nearest the last + was in the cell's text, before the line's edge
    const table = parseMd('+-----+\n| a|     |\n+-----+').find(t => t.type === 'table');
    expect(table?.rows?.map(row => row.cells.map(cell => cell.runs.map(run => run.text).join('')))).toEqual([['a|']]);
  });

  it('reads a grid table with no padding, as Compact Table wrote one', () => {
    // Its | signs, under no + sign, were in the cells' text
    const compact = '+--------+---+\n| a | c |\n| b | d |\n+--------+---+\n| abcdef | e |\n+--------+---+';
    const table = parseMd(compact).find(t => t.type === 'table');
    expect(table?.rows?.map(row => row.cells.map(cell => cell.runs.map(run => run.type === 'hardbreak' ? '\n' : run.text).join('')))).toEqual([['a\nb', 'c\nd'], ['abcdef', 'e']]);
  });

  it('reads no line breaks from the blank lines padding a grid table cell', () => {
    // A cell with fewer lines than its row's ended in a line break for each
    const table = parseMd('+-----+-----+\n| x   | y   |\n+=====+=====+\n| a   | b   |\n|     | c   |\n|     | d   |\n+-----+-----+').find(t => t.type === 'table');
    expect(table?.rows?.[1].cells[0].runs.map(run => run.type)).toEqual(['text']);
  });

  it('reads a line break from a backslash before the blank lines padding a grid table cell', () => {
    // The blank line was trimmed with the line end the backslash escapes,
    // leaving the backslash text
    const table = parseMd('+-----+-----+\n| a\\  | b   |\n|     |     |\n+-----+-----+').find(t => t.type === 'table');
    expect(table?.rows?.[0].cells.map(cell => cell.runs.map(run => run.type === 'hardbreak' ? '\n' : run.text).join(''))).toEqual(['a\n', 'b']);
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

  it.each([
    ['in a <div> after a table', '<div>\n<table><tr><td>a</td></tr></table>\n+---+\n| g |\n+---+\n</div>'],
    ['right after a <div>', '<div>\n+---+\n| g |\n+---+\n</div>'],
    ['in a comment', '<!--\n+---+\n| g |\n+---+\n-->'],
    ['in a list item\'s <div>', '- <div>\n  +---+\n  | g |\n  +---+\n  </div>'],
  ])('preprocessGridTables leaves a grid table %s as the HTML block\'s text, as markdown-it reads it', (_name, markdown) => {
    // The placeholder and the blank lines around it split the block
    expect(preprocessGridTables(markdown)).toBe(markdown);
  });

  it('preprocessGridTables replaces a grid table after an HTML block\'s blank line', () => {
    const result = preprocessGridTables('<div>\n\n+---+\n| g |\n+---+\n\n</div>');
    expect(result).toContain('<!-- MANUSCRIPT_GRID_TABLE:');
    expect(result).not.toContain('+---+');
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

  it('numbers a numbered task list item', () => {
    const token: MdToken = {
      type: 'list_item',
      level: 1,
      ordered: true,
      taskChecked: false,
      runs: [{ type: 'text', text: 'todo item' }]
    };
    const result = generateParagraph(token, createState());
    expect(result).toContain('<w:numPr>');
    expect(result).toContain('<w:r><w:t xml:space="preserve">☐ </w:t></w:r>');
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

  it('writes a link\'s tracked change in its hyperlink, and the next link to the same place in another', () => {
    const href = 'https://example.com';
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'a ', href, linkStart: true }, { type: 'critic_del', text: 'b', innerRuns: [{ type: 'text', text: 'b' }], href },
        { type: 'text', text: 'c', href, linkStart: true },
      ],
    };
    // A deletion went outside the hyperlink, without the link
    expect(generateParagraph(token, createState()).replace(/ w:author="[^"]*"| w:date="[^"]*"/g, '')).toBe('<w:p><w:hyperlink r:id="rId4">'
      + '<w:r><w:t xml:space="preserve">a </w:t></w:r><w:del w:id="0"><w:r><w:delText>b</w:delText></w:r></w:del>'
      + '</w:hyperlink><w:hyperlink r:id="rId4"><w:r><w:t>c</w:t></w:r></w:hyperlink></w:p>');
  });

  it('writes a link\'s runs and line breaks in one hyperlink', () => {
    const href = 'https://example.com';
    const token: MdToken = {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'a ', href }, { type: 'text', text: 'b', bold: true, href },
        { type: 'softbreak', text: '\n', href }, { type: 'hardbreak', text: '\n', href },
        { type: 'text', text: 'c', href }, { type: 'text', text: ' d' },
      ],
    };
    // Each run, but not a line break, was a hyperlink of its own
    expect(generateParagraph(token, createState())).toBe('<w:p><w:hyperlink r:id="rId4">'
      + '<w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r>'
      + '<w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:br/></w:r><w:r><w:t>c</w:t></w:r>'
      + '</w:hyperlink><w:r><w:t xml:space="preserve"> d</w:t></w:r></w:p>');
  });

  it.each([
    ['two links to one place', '<a href="https://e.com">a</a><a href="https://e.com">b</a>', 2],
    ['a link with formatting', '<a href="https://e.com">a <b>b</b></a>', 1],
  ])('writes %s in an HTML table\'s cell as a hyperlink each', async (_name, cell, count) => {
    // An <a>'s runs were a hyperlink each, and then two <a>s one
    const { docx } = await convertMdToDocx('<table>\n<tr><td>' + cell + '</td><td>x</td></tr>\n</table>');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:hyperlink /g)?.length).toBe(count);
  });

  it.each([
    ['a deleted link of several runs', '{--[a **b**\\\nc](https://e.com)--}', 1],
    ['deleted links to one place', '{--[a](https://e.com)[b](https://e.com)--}', 2],
  ])('writes %s as a hyperlink each', async (_name, md, count) => {
    // Each run of a deleted link was a hyperlink of its own
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/<w:hyperlink /g)?.length).toBe(count);
  });

  it.each([
    ['an insertion', '[a {++[b](https://other.com)++} c](https://e.com)'],
    ['a deletion', '[a {--[b](https://other.com)--} c](https://e.com)'],
    ['a substitution', '[a {~~[b](https://other.com)~>x~~} c](https://e.com)'],
  ])('keeps the link to another place in %s inside a link', async (_name, md) => {
    // The link's hyperlink took the change's runs, without their own link
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    const id = /Id="(rId\d+)"[^>]*Target="https:\/\/other\.com"/.exec(rels)?.[1];
    expect(id).toBeDefined();
    expect(xml).toMatch(new RegExp('<w:hyperlink r:id="' + id + '"><w:(?:ins|del) [^>]*><w:r><w:(?:t|delText)>b</w:(?:t|delText)>'));
  });

  it.each([
    ['an insertion', 'x {++[a](https://e.com)b++} y', 'w:ins'],
    ['a deletion', 'x {--[a](https://e.com)b--} y', 'w:del'],
    ['a substitution\'s insertion', 'x {~~b~>[a](https://e.com)c~~} y', 'w:ins'],
    ['a substitution\'s deletion', 'x {~~[a](https://e.com)c~>b~~} y', 'w:del'],
  ])('writes a link in %s as a hyperlink around a change of its own', async (_name, md, tag) => {
    // An insertion held the hyperlink, which Word's schema doesn't allow
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).not.toMatch(/<w:(?:ins|del) [^>]*>(?:(?!<\/w:(?:ins|del)>).)*<w:hyperlink/);
    expect(xml).toMatch(new RegExp('<w:hyperlink r:id="rId\\d+"><' + tag + ' [^>]*><w:r><w:(?:t|delText)>a</w:(?:t|delText)></w:r></' + tag + '></w:hyperlink><' + tag + ' '));
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

  it.each([
    ['an insertion and a deletion', '| a {++x++} {--y--} |\n| --- |\n| b |'],
    ['a substitution', '| a {~~x~>y~~} |\n| --- |\n| b |'],
    ['emphasis in an insertion', '| a {++*x*++} {--**y**--} |\n| --- |\n| b |'],
    ['an insertion in a grid table', '+-----------+\n| a {++x++} |\n| {--y--}   |\n+===========+\n| b         |\n+-----------+'],
  ])('makes %s in a header cell bold', async (_name, md) => {
    // Its text was plain, and import strips a header's bold from it as
    // from the rest of the header's text, so the bold Word had was lost
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    const header = xml.slice(xml.indexOf('<w:tr>'), xml.indexOf('</w:tr>'));
    const changed = [...header.matchAll(/<w:(ins|del)\b[^>]*>([\s\S]*?)<\/w:\1>/g)].flatMap(m => m[2].match(/<w:r>[\s\S]*?<\/w:r>/g) ?? []);
    expect(changed.length).toBeGreaterThanOrEqual(2);
    for (const run of changed) expect(run).toContain('<w:b/>');
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

  it('writes CriticMarkup inside an inline equation as tracked runs in one equation', async () => {
    const { docx } = await convertMdToDocx('See $a {++b++} c {~~d~>e~~}$ here.');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const equations = xml.match(/<m:oMath>[\s\S]*?<\/m:oMath>/g) ?? [];
    expect(equations).toHaveLength(1);
    expect(equations[0]).toMatch(/<w:ins w:id="\d+" w:author="[^"]+"[^>]*><m:r>(?:(?!<\/m:r>).)*<m:t>b<\/m:t><\/m:r><\/w:ins>/);
    expect(equations[0]).toMatch(/<w:del w:id="\d+"[^>]*><m:r>(?:(?!<\/m:r>).)*<m:t>d<\/m:t><\/m:r><\/w:del><w:ins w:id="\d+"[^>]*><m:r>(?:(?!<\/m:r>).)*<m:t>e<\/m:t>/);
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

  it('takes an author\'s initials by character, not half of one outside the BMP', async () => {
    const { docx } = await convertMdToDocx('Text {==a==}{>>@𠮷野 太郎 (2024-01-15 14:30) | note<<}');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/comments.xml')!.async('string');
    expect(xml).toContain('w:initials="𠮷太"');
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

  it('parses CriticMarkup inside inline math as one math run with tracked parts', () => {
    const token = parseMd('The variance is $u_j^2{+++\\tau_{g_j}^2++}$.')[0];
    const math = token.runs.filter(run => run.type === 'math');

    expect(math).toHaveLength(1);
    expect(token.runs.some(run => run.type === 'critic_add')).toBe(false);
    expect(math[0].mathParts).toEqual([
      { type: 'math', content: 'u_j^2' },
      { type: 'addition', content: '+\\tau_{g_j}^2' },
    ]);
  });

  it('restores source newlines in revised inline math for Word export', () => {
    const math = parseMd('$a{++b\nc++}$')[0].runs.find(run => run.type === 'math');

    expect(math?.mathParts).toEqual([
      { type: 'math', content: 'a' },
      { type: 'addition', content: 'b\nc' },
    ]);
    expect(math?.text).not.toContain('LINE');
  });

  it('keeps a next-line Critic opener inside inline math for Word export', () => {
    const math = parseMd('$a+{++\n+b++}$')[0].runs.find(run => run.type === 'math');

    expect(math?.mathParts).toEqual([
      { type: 'math', content: 'a+' },
      { type: 'addition', content: '\n+b' },
    ]);
  });

  it('ignores escaped dollars when closing revised inline math for Word export', () => {
    const token = parseMd('$a+\\$+{++b++}$')[0];
    const math = token.runs.find(run => run.type === 'math');

    expect(math?.mathParts).toEqual([
      { type: 'math', content: 'a+\\$+' },
      { type: 'addition', content: 'b' },
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

    expect(result.match(/<m:oMath>/g)).toHaveLength(1);
    expect(result).toMatch(/<m:oMath>(?:(?!<\/m:oMath>).)*<w:del w:id="\d+" w:author="Default"[^>]*>.*<\/w:del><w:ins w:id="\d+" w:author="Default"[^>]*>/);
    expect(result).not.toContain('{~~');
  });

  it('records an equation as replaced when its changes can\'t be tracked in place', () => {
    // Word can't track half a structure: the deletion is what Reject All
    // leaves, and the insertion what Accept All leaves
    for (const [md, rejected, structure] of [
      ['$a{++\\left(++}x\\right)$', 'ax)', '<m:d>'],
      ['${++\\begin{matrix}++} a \\end{matrix}$', ' a ', '<m:m>'],
      // Nor a span around a root's degree, or a script, apart from what it's on
      ['$\\sqrt{++[3]++}{x}$', 'x', '<m:deg>'],
      ['$\\sin{++^2++}(x)$', 'sin(x)', '<m:sSup>'],
      ['$\\sum{++_i++}^n x$', 'nx', '<m:sub><m:r>'],
      // Nor one that holds syntax rather than math, which Word can't track
      ['$\\begin{matrix}a{++&++}b\\end{matrix}$', 'ab', '<m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e>'],
      ['$\\sum{++\\limits++}_{i}^{n} x$', 'inx', '<m:limLoc m:val="undOvr"/>'],
      ['${++\\frac++}{1}{2}$', '12', '<m:f>'],
    ] as const) {
      const result = generateParagraph(parseMd(md)[0], createState(), { authorName: 'Default' });
      const deleted = [...result.matchAll(/<w:del [^>]*>(.*?)<\/w:del>/g)].map(m => m[1]);
      const inserted = [...result.matchAll(/<w:ins [^>]*>(.*?)<\/w:ins>/g)].map(m => m[1]);
      expect(deleted.map(omml => omml.replace(/<[^>]+>/g, ''))).toEqual([rejected]);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toContain(structure);
      expect(result.match(/<m:oMath>/g)).toHaveLength(1);
    }
  });

  it('leaves the private commands to tracked parts', async () => {
    const { trackedEquationLatex } = await import('./md-to-docx-citations');
    const parts = [{ type: 'math' as const, content: 'a ' }, { type: 'addition' as const, content: 'b' }];
    expect(trackedEquationLatex(parts)).toBe('a \\mmCriticIns{b}');
    // Rendered without a tracker, as inside a deleted span, every part shows
    expect(trackedEquationLatex(parts, true)).toBe('a {b}');
    // A user's own command of that name is unsupported, as any other is
    expect(trackedEquationLatex([{ type: 'math', content: '\\mmCriticIns{x}' }, { type: 'addition', content: 'b' }])).toBeUndefined();
    const state = createState();
    const result = generateParagraph(parseMd('$a {++\\mmCriticIns{x}++} b$')[0], state, { authorName: 'Default' });
    expect(result).toContain('mmCriticIns');
    expect(state.warnings.some(warning => warning.includes('mmCriticIns'))).toBe(true);
  });

  it('tracks a change in place when it splits styled text into runs or ends in a command', () => {
    // Word shows adjacent runs of one style as one, so this is what accepting
    // or rejecting the change should give. Accepting {++\alpha++}x gives
    // \alpha then x, not \alphax.
    for (const md of ['$\\text{a {++b++} c}$', '$\\mathbf{a{--b--}}$', '$\\operatorname{mar{++gin++}}x$', '${++\\alpha++}x$']) {
      const result = generateParagraph(parseMd(md)[0], createState(), { authorName: 'Default' });
      expect(result.match(/<w:(?:ins|del) /g)).toHaveLength(1);
      expect(result).not.toMatch(/<w:(?:ins|del) [^>]*><m:(?:f|rad|func)\b/);
    }
  });

  it('tracks a change in place that is all of a \\text{}, which is an empty run without it', () => {
    // Word shows an empty run as nothing, so rejecting {++x++} in \text{}
    // gives what \text{} does
    for (const md of ['$\\text{{++x++}}$', '$\\text{{--x--}}$', '$\\text{{++ ++}}$', '$\\text{{++x++}} + 1$']) {
      const result = generateParagraph(parseMd(md)[0], createState(), { authorName: 'Default' });
      expect(result.match(/<w:(?:ins|del) /g)).toHaveLength(1);
      expect(result).not.toContain('<m:t></m:t>');
    }
  });

  it('writes CriticMarkup inside a display equation as tracked runs in it', () => {
    const fence = '$'.repeat(2);
    const result = generateParagraph(parseMd(fence + '\na {++b++} c\n' + fence)[0], createState(), { authorName: 'Default' });
    expect(result).toContain('<m:oMathPara><m:oMath>');
    expect(result).toMatch(/<w:ins [^>]*><m:r><m:t>b<\/m:t><\/m:r><\/w:ins>/);
    expect(result.match(/<m:oMath>/g)).toHaveLength(1);
    expect(result).not.toContain('++');
  });

  it('ends a LaTeX comment before the brace that closes a tracked part', async () => {
    const { trackedEquationLatex } = await import('./md-to-docx-citations');
    expect(trackedEquationLatex([{ type: 'math', content: 'a ' }, { type: 'addition', content: 'b % c' }, { type: 'math', content: ' d' }]))
      .toBe('a \\mmCriticIns{b % c\n} d');
    expect(trackedEquationLatex([{ type: 'math', content: 'a % c' }, { type: 'addition', content: 'b' }]))
      .toBe('a % c\n\\mmCriticIns{b}');
    // Braces in a comment don't count toward balance
    expect(trackedEquationLatex([{ type: 'addition', content: 'a % }\nb' }])).toBe('\\mmCriticIns{a % }\nb}');
  });

  it('keeps highlights and comments inside inline math as separate equations', () => {
    const runs = parseMd('$a {==b==}{>>note<<} c$')[0].runs;
    expect(runs.filter(run => run.type === 'math').every(run => !run.mathParts)).toBe(true);
    expect(runs.some(run => run.type === 'critic_highlight')).toBe(true);
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
    expect(tokens.map(token => token.type)).toEqual(['blockquote', 'blockquote']);
    expect(tokens.map(token => token.runs[0].innerRuns?.map(run => run.text).join('')))
      .toEqual(['before', 'after']);
  });

  it('removes blockquote prefixes after nested-list indentation', () => {
    const input = '- outer\n    - inner\n      > {++before\n      >\n      > after++}';
    const blockquotes = parseMd(input).filter(token => token.type === 'blockquote');
    expect(blockquotes).toHaveLength(2);
    for (const blockquote of blockquotes) {
      expect(blockquote.listContinuation).toEqual({ type: 'bullet', level: 2 });
    }
    expect(blockquotes.map(token => token.runs[0].innerRuns?.map(run => run.text).join('')))
      .toEqual(['before', 'after']);
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

  it('keeps a span of a paragraph break alone where it is, with a quote\'s markers', () => {
    // The markers counted as text in it, and the break moved out of it,
    // which left the span empty and the paragraph mark untracked
    expect(preprocessCriticMarkup('a{--\n\n--}b')).toBe('a{--' + PARA_PLACEHOLDER + '--}b');
    expect(preprocessCriticMarkup('> a{--\n>\n> --}b')).toBe('> a{--' + PARA_PLACEHOLDER + '--}b');
    expect(preprocessCriticMarkup('> > a{++\n> >\n> > ++}b')).toBe('> > a{++' + PARA_PLACEHOLDER + '++}b');
    // A > outside a quote is text, and the span's opener still moves
    expect(preprocessCriticMarkup('a{++\n>++}')).toBe('a\n\n{++>++}');
  });

  it('does not hoist or protect a substitution without its separator', () => {
    const input = 'Before{~~\nliteral~~}';
    expect(preprocessCriticMarkup(input)).toBe(input);

    const runs = parseMd(input).flatMap(token => token.runs);
    expect(runs.some(run => run.type === 'critic_sub')).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe(input);
  });

  it('does not treat currency dollars as an inline-math region when moving a stranded opener', () => {
    const input = 'Cost $100 and\nchange {++\nAdded++}\n$ later';
    expect(preprocessCriticMarkup(input)).toBe(
      'Cost $100 and\nchange \n\n{++Added++}\n$ later',
    );
  });

  it('treats CR-only blank lines as paragraph breaks inside CriticMarkup', () => {
    const input = '{++a\r\rb++}';
    expect(preprocessCriticMarkup(input)).toBe('{++a' + PARA_PLACEHOLDER + 'b++}');
  });

  it('does not backtrack one CRLF into a paragraph break', () => {
    expect(preprocessCriticMarkup('{++a\r\nb++}'))
      .toBe('{++a' + LINE_PLACEHOLDER + 'b++}');
    expect(preprocessCriticMarkup('{++a\r\n\r\nb++}'))
      .toBe('{++a' + PARA_PLACEHOLDER + 'b++}');
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
    const highlightRuns = allRuns.filter(r => r.type === 'text' && r.highlight);
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
    expect(tokens).toHaveLength(2);
    expect(addRuns.length).toBe(2);
  });

  it('parses multi-paragraph deletion', () => {
    const tokens = parseMd('{--deleted\n\nmore--}');
    const delRuns = tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_del');
    expect(tokens).toHaveLength(2);
    expect(delRuns.length).toBe(2);
  });

  it('splits a multi-paragraph substitution into its deletion and addition', () => {
    const tokens = parseMd('{~~old\n\ntext~>new\n\ntext~~}');
    expect(tokens.flatMap(t => t.runs).filter(r => r.type === 'critic_sub')).toHaveLength(0);
    expect(tokens.map(t => t.runs.map(r => r.type + ':' + r.text))).toEqual([
      ['critic_del:old'],
      ['critic_del:text', 'critic_add:new'],
      ['critic_add:text'],
    ]);
    // Each break tracks the paragraph mark before it with its own side's revision
    expect(tokens.map(t => t.criticParaMark)).toEqual(['deletion', 'addition', undefined]);
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
    expect(addRuns.map(run => run.innerRuns?.map(inner => inner.text).join(''))).toEqual(['added', 'more']);
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

  it('writes a deleted link\'s runs in a deletion of their own in its hyperlink', () => {
    // They went without the hyperlink, which a w:del can't hold
    const state = createState();
    const result = generateParagraph(parseMd('P {--A [a](https://e.com/ab) B--} Q.')[0], state, { authorName: 'R' });
    const rId = state.relationships.get('https://e.com/ab');
    expect(rId).toBeDefined();
    expect(result).toContain('<w:del w:id="0" w:author="R"><w:r><w:delText xml:space="preserve">A </w:delText></w:r></w:del>'
      + '<w:hyperlink r:id="' + rId + '"><w:del w:id="1" w:author="R"><w:r><w:delText>a</w:delText></w:r></w:del></w:hyperlink>'
      + '<w:del w:id="2" w:author="R"><w:r><w:delText xml:space="preserve"> B</w:delText></w:r></w:del>');
  });

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
  it('generates references for an added citation when no CSL style is specified', async () => {
    const doc = await getDocumentXml('{++[@smith2020]++}');
    expect(doc).toContain('ZOTERO_BIBL');
    const ins = doc.match(/<w:ins[^>]*>([\s\S]*?)<\/w:ins>/);
    expect(ins?.[1]).toContain('ZOTERO_ITEM');
    expect(doc.slice(doc.indexOf('ZOTERO_BIBL'))).toContain('Title');
  });

  it('generates references for a replacement citation without a CSL style', async () => {
    const doc = await getDocumentXml('{~~(hand-typed cite)~>[@smith2020]~~}');
    expect(doc).toContain('<w:delText>(hand-typed cite)</w:delText>');
    const ins = doc.match(/<w:ins[^>]*>([\s\S]*?)<\/w:ins>/);
    expect(ins?.[1]).toContain('ZOTERO_ITEM');
    expect(doc).toContain('ZOTERO_BIBL');
    expect(doc.slice(doc.indexOf('ZOTERO_BIBL'))).toContain('Title');
  });

  it('defaults ordinary citations to APA and records the style for Zotero', async () => {
    const { docx } = await convertMdToDocx('[@smith2020]', { bibtex: bib });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('text');
    expect(doc).toContain('ZOTERO_BIBL');
    expect(doc).toContain('(Smith, 2020)');
    const props = await zip.file('docProps/custom.xml')!.async('text');
    expect(props).toContain('http://www.zotero.org/styles/apa');
  });

  it('omits deleted-only references when using the default style', async () => {
    const doc = await getDocumentXml('{++[@smith2020]++} {--[@jones2021]--}');
    const bibliography = doc.slice(doc.indexOf('ZOTERO_BIBL'));
    expect(bibliography).toContain('Smith');
    expect(bibliography).not.toContain('Jones');
  });

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

  it('keeps prefixes and suppress-author markers in deleted citation literals', async () => {
    const doc = await getDocumentXml('{--Removed [e.g., @smith2020; -@jones2021]--}');
    const delMatch = doc.match(/<w:del[^>]*>([\s\S]*?)<\/w:del>/);
    expect(delMatch).toBeTruthy();
    expect(delMatch![1]).toContain('<w:delText>[e.g., @smith2020; -@jones2021]</w:delText>');
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

  it.each([
    ['a paragraph', '[^1]: First.\n\n\n    Second.\n\nBody.', 'First.\n\n\nSecond.'],
    ['code', '[^1]: Code:\n\n    ```python\n    a = 1\n\n\n    b = 2\n    ```\n\nBody.', 'Code:\n\n```python\na = 1\n\n\nb = 2\n```'],
    ['code\'s spaces', '[^1]: Code:\n\n    ```python\n    a = """\n\n      \n    """\n    ```\n\nBody.', 'Code:\n\n```python\na = """\n\n  \n"""\n```'],
  ])('keeps %s in the note after two blank lines', (_name, input, body) => {
    // The note ended at the second blank line, which markdown-it and Pandoc
    // read past, and the rest became indented code in the body
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe(body);
    expect(cleaned).toBe('\nBody.');
  });

  it.each([
    // Its info can't hold a backtick, so it's text, a code span's
    ['a line of backticks with a backtick after them', 'One \\\n```c``c``` end'],
    ['an indented line of backticks', '    ```'],
    ['a line of tildes indented as code', '    ~~~ x'],
  ])('reads a definition after %s, which opens no fenced code', (_name, before) => {
    // The rest of the document was fenced code, and the definition in it
    const { cleaned, definitions } = extractFootnoteDefinitions('T [^1]\n\n' + before + '\n\n[^1]: Note.');
    expect(definitions.get('1')).toBe('Note.');
    expect(cleaned).toBe('T [^1]\n\n' + before + '\n');
  });

  it('reads no definition in fenced code past a line of backticks with text after them', () => {
    // Which closed the fence, though a closing fence holds nothing after its marker
    const input = 'T [^1]\n\n```\nx\n``` js\n[^1]: Code.\n```\n\n[^1]: Note.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('Note.');
    expect(cleaned).toBe('T [^1]\n\n```\nx\n``` js\n[^1]: Code.\n```\n');
  });

  it('keeps a note\'s code going past a blank line, which reads as a list item\'s code', () => {
    // The definition follows the item with no blank line, so markdown-it
    // reads the note's fence as the item's, and the note ended at the blank
    // line in it
    const input = 'T [^1]\n\n- item\n[^1]: Code:\n\n    ```\n    a\n\n    b\n    ```\n\nBody.';
    const { cleaned, definitions } = extractFootnoteDefinitions(input);
    expect(definitions.get('1')).toBe('Code:\n\n```\na\n\nb\n```');
    expect(cleaned).toBe('T [^1]\n\n- item\n\nBody.');
  });

  it.each([
    ['a <pre> of fenced code', '<pre>\n```\n[^1]: Not a note.\n```\n</pre>'],
    ['a <div>', '<div>\n[^1]: Not a note.\n</div>'],
    ['a comment', '<!--\n[^1]: Not a note.\n-->'],
  ])('reads no definition in %s, which markdown-it reads as HTML', (_name, block) => {
    // It went to a note no reference had, and out of the HTML
    const { cleaned, definitions } = extractFootnoteDefinitions('T.\n\n' + block + '\n\nEnd.');
    expect(definitions.size).toBe(0);
    expect(cleaned).toBe('T.\n\n' + block + '\n\nEnd.');
  });

  it.each([
    ['<pre>', 'T [^1] {>>Use this tag:\n<pre>\nfor the example.<<}'],
    ['a fence', 'T [^1] {>>Use:\n```\nfor the example.<<}'],
    ['<div> after a blank line', 'T [^1] {>>Use:\n\n<div>\n\nx<<}'],
  ])('reads a definition after a comment with %s in it, which starts no block', (_name, before) => {
    // The comment's text, which parseMd keeps on one line, read as an HTML
    // block or fence to the end, which hid the definition
    const { cleaned, definitions } = extractFootnoteDefinitions(before + '\n\n[^1]: Footnote.');
    expect(definitions.get('1')).toBe('Footnote.');
    expect(cleaned).toBe(before + '\n');
  });

  it('counts the lines of a comment whose opener ends a line, to find where HTML after it ends', () => {
    // The definition right after the </pre> line, which ends the block
    const before = 'T [^1] {>>\n<pre>\nx<<}\n\n<pre>\n[^2]: Not a note.\n</pre>';
    const { cleaned, definitions } = extractFootnoteDefinitions(before + '\n[^1]: Footnote.');
    expect([...definitions]).toEqual([['1', 'Footnote.']]);
    expect(cleaned).toBe(before);
  });

  it('reads a definition after fenced code after a bare carriage return, as a line end', () => {
    // markdown-it reads a bare \r as one, which put the fence's lines one
    // later, and the definition in them
    const { cleaned, definitions } = extractFootnoteDefinitions('T [^1]\r```\nx\n```\n[^1]: Note.');
    expect(definitions.get('1')).toBe('Note.');
    expect(cleaned).toBe('T [^1]\n```\nx\n```');
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

  it.each([
    ['whose label comes first', 'Text[^outer].\n\n[^outer]: Outer[^inner].\n\n[^inner]: Inner.\n', [' Outer.', ' Inner.']],
    ['defined first', 'Text[^a].\n\n[^b]: B.\n\n[^a]: A[^b].\n', [' A.', ' B.']],
    ['through another', 'T[^c].\n\n[^a]: A.\n\n[^b]: B[^a].\n\n[^c]: C[^b].\n', [' C.', ' B.', ' A.']],
  ])('writes a note only another refers to, %s', async (_name, md, texts) => {
    // It got its ID only as the other was made, after its own turn, which
    // left a reference to a note that wasn't there
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/footnotes.xml')!.async('string');
    const notes = [...xml.matchAll(/<w:footnote w:id="(\d+)">([\s\S]*?)<\/w:footnote>/g)].filter(m => Number(m[1]) > 0);
    expect(notes.map(m => m[2].replace(/<[^>]+>/g, ''))).toEqual(texts);
    for (const ref of xml.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)) {
      expect(notes.some(m => m[1] === ref[1])).toBe(true);
    }
  });

  it('keeps a comment whose body is in a note made before the one its range is in', async () => {
    // Notes go in their labels' order, which made a, with the body, before
    // b, with the range, which wasn't there for the body to find
    const { convertDocx } = await import('./converter');
    const { docx, warnings } = await convertMdToDocx('T[^b] and[^a].\n\n[^b]: {#c}B.{/c}\n\n[^a]: A.\n\n    {#c>>Comment text<<}\n');
    expect(warnings).toEqual([]);
    expect((await convertDocx(docx)).markdown).toContain('[^b]: {==B.==}{>>Comment text<<}');
  });

  it('bookmarks a note a later one cross-references', async () => {
    // Notes go in their labels' order, which made a before b, whose
    // reference to a made a cross-reference, to a bookmark a didn't have
    const { docx } = await convertMdToDocx('T[^a] and[^b].\n\n[^b]: B[^a].\n\n[^a]: A.\n');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/footnotes.xml')!.async('string');
    const target = /NOTEREF (_Ref\d+)/.exec(xml)![1];
    expect(xml).toMatch(new RegExp('<w:footnote w:id="1">[^]*?<w:bookmarkStart w:id="\\d+" w:name="' + target + '"/><w:r>[^]*?<w:footnoteRef/></w:r><w:bookmarkEnd'));
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

  it('resolves a reference link in a footnote with a definition in the document', async () => {
    const md = 'Text[^1] here.\n\n[^1]: See [example][ref] for details.\n\n[ref]: https://example.com';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
    expect(footnotesXml).toContain('<w:hyperlink r:id="rId1">');
    expect(footnotesXml).not.toContain('[ref]');
    expect(await zip.file('word/_rels/footnotes.xml.rels')!.async('string')).toContain('https://example.com');
  });

  it('resolves a reference link in a footnote with the footnote\'s own definition first', async () => {
    const md = 'Text[^1] here.\n\n[^1]: See [example][ref].\n\n    [ref]: https://local.example\n\n[ref]: https://global.example';
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const noteRelsXml = await (await JSZip.loadAsync(docx)).file('word/_rels/footnotes.xml.rels')!.async('string');
    expect(noteRelsXml).toContain('https://local.example');
    expect(noteRelsXml).not.toContain('https://global.example');
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
  async function roundTripBody(md: string): Promise<string> {
    const { convertDocx } = await import('./converter');
    const { docx } = await convertMdToDocx(md);
    return (await convertDocx(docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  }

  it('keeps the blank lines before a quote nested in a list item', async () => {
    for (const md of [
      '- x\n\n  > q',
      '- x\n  > q',
      '1. x\n\n   > q',
      '- x\n  - y\n\n    > q',
      '- x\n\n  > q\n- next',
      '- x\n\n  > [!NOTE]\n  > q',
    ]) {
      expect(await roundTripBody(md)).toBe(md);
    }
  });

  it('keeps an alert after a quote in the same list item separate', async () => {
    const md = '- x\n\n  > a\n\n  > [!NOTE]\n  > b';
    expect(await roundTripBody(md)).toBe(md);
  });

  it('keeps a top-level quote after a quote nested in a list separate', async () => {
    const md = '- x\n  - y\n\n    > q\n\n> top';
    expect(await roundTripBody(md)).toBe(md);
  });

  it('keeps later quote spacing after two quotes a blank line apart or code holding a > line', async () => {
    // The two quotes stay two, and the spacing of later quotes doesn't shift
    expect(await roundTripBody('> a\n\n> b\n\npara\n\n\n> c')).toBe('> a\n\n> b\n\npara\n\n\n> c');
    const fenced = '```\n> code\n```\n\npara\n\n\n> c';
    expect(await roundTripBody(fenced)).toBe(fenced);
    // Nor match the same text in a code block above it
    const same = '```\n> c\n```\n\npara\n\n\n> c\n\n\nend';
    expect(await roundTripBody(same)).toBe(same);
    expect(await roundTripBody('- > n\n\n' + same)).toBe('- \n  > n\n\n' + same);
    // Export ends a quote before a lazy line, so the line after it starts another
    const lazy = '> a\nb\n> c\n\npara\n\n\n> d';
    expect(await roundTripBody(lazy)).toBe(lazy);
  });

  it('keeps the spacing of a quote holding a table whose numbers export formats', async () => {
    // The quote's table doesn't come back as a table, but the blank lines around it do
    const table = '<table data-digits=1><tr><td>12.34</td></tr></table>';
    expect(await roundTripBody('> a ' + table + '\n\n\np')).toMatch(/\n\n\np$/);
    // A quote that holds only a table goes with it, which export drops
    expect(await roundTripBody('- x\n\n  > ' + table + '\n\n\np')).toBe('- x\n\np');
  });

  it('keeps later quote spacing after a quote on a list marker line or in another item', async () => {
    // Import writes a quote that starts a list item on the line after the
    // marker, but the quotes after it keep their spacing
    expect(await roundTripBody('- > q\n\npara\n\n\n> tail')).toBe('- \n  > q\n\npara\n\n\n> tail');
    expect(await roundTripBody('1. > q\n\n\n> tail')).toBe('1. \n   > q\n\n\n> tail');
    // Quotes in two list items are two quotes, even with only blank lines between
    expect(await roundTripBody('- x\n\n  > q\n\n- > r\n\n\n> tail')).toBe('- x\n\n  > q\n\n- \n  > r\n\n\n> tail');
    // Blank lines before a marker line belong before the item, not in it
    expect(await roundTripBody('paragraph\n\n- > r')).toBe('paragraph\n\n- \n  > r');
  });

  it('keeps a list going after a quote in one of its items', async () => {
    // Export writes no empty paragraph after the quote, which would end the
    // list and restart its numbering on import
    for (const md of ['- x\n\n  > q\n\n- y', '1. x\n\n   > q\n\n2. y', '- x\n\n  > q\n\npara']) {
      expect(await roundTripBody(md)).toBe(md);
    }
    expect(await roundTripBody('1. > a\n\n2. b')).toBe('1. \n   > a\n\n2. b');
  });

  it('keeps the empty paragraphs after a quote in a list item before another list', async () => {
    // Only more of the same list needs them left out; Word shows them as the
    // source's blank lines before a list that starts over
    const JSZip = (await import('jszip')).default;
    const emptyParagraphsBeforeLast = async (md: string) => {
      const { docx } = await convertMdToDocx(md);
      const xml = await (await JSZip.loadAsync(docx)).files['word/document.xml'].async('string');
      const texts = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(m => m[0].replace(/<[^>]+>/g, ''));
      return texts.length - 1 - texts.lastIndexOf('q') - 1;
    };
    const sameList = await emptyParagraphsBeforeLast('- x\n\n  > q\n\n\n- y');
    expect(await emptyParagraphsBeforeLast('- x\n\n  > q\n\n\n1. y')).toBe(sameList + 2);
    expect(await emptyParagraphsBeforeLast('1. x\n\n   > q\n\n\n- y')).toBe(sameList + 2);
    expect(await emptyParagraphsBeforeLast('- x\n  - y\n\n    > q\n\n\n1. z')).toBe(sameList + 2);
    expect(await emptyParagraphsBeforeLast('- x\n  - y\n\n    > q\n\n\n- z')).toBe(sameList);
  });

  it('keeps the spacing and alert style of a quote after a list in a quote', async () => {
    // Export flattens the quoted list into one quote group, as import reads it
    const md = await roundTripBody('> - a\n> - b\n\n> [!NOTE] inline\n> x');
    expect(md).toMatch(/b\n\n> \[!NOTE\] inline/);
  });

  it('keeps the spacing of a quote holding a multi-line change or before a table', async () => {
    // Preprocessing joins the change's lines, which the source must match
    expect(await roundTripBody('para\n\n\n> {++before\n>\n> after++}')).toMatch(/^para\n\n\n> /);
    // A table after a quote in a list item ends the list, so its spacer stays
    expect(await roundTripBody('- x\n\n  > q\n\n\n| a |\n|---|\n| 1 |')).toMatch(/^- x\n\n  > q\n\n\n\| a \|/);
  });

  it('keeps the spacing after quote groups that share a line', async () => {
    // In > - > q the outer quote and the one in its list item start on one line
    expect(await roundTripBody('> - > q\n\n\npara')).toMatch(/q\n\n\npara$/);
  });

  it('keeps the blank lines before a list continuation paragraph after a quote', async () => {
    for (const md of ['- x\n\n  > q\n\n\n  continuation', '- x\n\n  > q\n\n  continuation']) {
      expect(await roundTripBody(md)).toBe(md);
    }
  });

  it('keeps later quote spacing after a lazy line or a quote in a list in a quote', async () => {
    // Four spaces in, the lazy line stays in the quote, as it does on export
    expect(await roundTripBody('- x\n  - y\n    > q\n    lazy\n\n> top')).toBe('- x\n  - y\n    > q lazy\n\n> top');
    expect(await roundTripBody('> - x\n>\n>   > q\n\n> tail')).toMatch(/[^\n]\n\n> tail$/);
  });

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

describe('Quotes a blank line separates', () => {
  /** Each paragraph of Word's body: a quote's spacer, an empty paragraph,
   *  or its style and text */
  async function paragraphs(docx: Uint8Array): Promise<string[]> {
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return [...xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('<w:sectPr')).matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([p]) => {
      if (/w:lineRule="exact"/.test(p) && /<w:pBdr>/.test(p)) return 'spacer';
      const text = [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join('');
      return text ? (/<w:pStyle w:val="(\w+)"/.exec(p)?.[1] ?? '') + ' ' + text : 'empty';
    });
  }

  it('writes two quotes as two in Word, with an empty paragraph between', async () => {
    // Word had one quote of two paragraphs, as for > A\n>\n> B
    expect(await paragraphs((await convertMdToDocx('> A\n\n> B')).docx)).toEqual([
      'spacer', 'GitHubBlockquote A', 'spacer', 'empty', 'spacer', 'GitHubBlockquote B', 'spacer',
    ]);
    expect(await paragraphs((await convertMdToDocx('> A\n>\n> B')).docx)).toEqual([
      'spacer', 'GitHubBlockquote A', 'GitHubBlockquote B', 'spacer',
    ]);
  });

  it.each([
    ['two quotes', '> A\n\n> B'],
    ['two quotes with two blank lines between', '> A\n\n\n> B'],
    ['three quotes', '> A\n\n> B\n\n> C'],
    ['two quotes between paragraphs', 'p\n\n> A\n\n> B\n\nq'],
    ['two nested quotes', '> > A\n\n> > B'],
    ['two nested quotes in one quote', '> > A\n>\n> > B'],
    ['two quotes in a list item', '- x\n\n  > A\n\n  > B'],
    ['two quotes in a numbered item before the next', '1. x\n\n   > A\n\n   > B\n\n2. y'],
    ['two quotes in the Quote style', '---\nblockquote-style: Quote\n---\n\n> A\n\n> B'],
  ])('keeps %s apart', async (_name, md) => {
    const { convertDocx } = await import('./converter');
    const first = (await convertMdToDocx(md)).docx;
    const once = (await convertDocx(first)).markdown;
    expect(once).toBe(md + '\n');
    const second = (await convertMdToDocx(once)).docx;
    expect(await paragraphs(second)).toEqual(await paragraphs(first));
    expect((await convertDocx(second)).markdown).toBe(once);
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

  it.each([1, 2])('splits a long mapping between characters, not in an emoji, at offset %d', async (offset) => {
    const md = '```' + 'a'.repeat(offset) + '📊'.repeat(150) + '\ncode\n```\n';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toContain('MANUSCRIPT_CODE_BLOCK_LANGS_2');
    expect(customXml).not.toContain('\ufffd');
    const { convertDocx } = await import('./converter');
    expect((await convertDocx(result.docx)).markdown).toBe(md);
  });

  it.each([0, 1])('splits Zotero\'s preferences between characters, not in an emoji, at offset %d', async (offset) => {
    const md = '---\ncsl: ' + 'a'.repeat(offset) + '📊'.repeat(150) + '\n---\n\nText.\n';
    const result = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.docx);
    const customXml = await zip.file('docProps/custom.xml')?.async('string');
    expect(customXml).toContain('ZOTERO_PREF_2');
    expect(customXml).not.toContain('\ufffd');
    const { extractZoteroPrefs } = await import('./converter');
    expect((await extractZoteroPrefs(result.docx))?.styleId).toBe('http://www.zotero.org/styles/' + 'a'.repeat(offset) + '📊'.repeat(150));
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
          sourceRange: [0, 3],
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

    it.each([
      ['no page or margins of its own', ''],
      ['a page and margins of its own', '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>'],
    ])('gives the sections a template with %s and a tracked change\'s old ones has its own page and margins, not the old ones', (_, own) => {
      // A section break took the old properties' page and margins, where the
      // template had none of its own
      const state = makeState();
      state.templateSectPr = '<w:sectPr>' + own + '<w:cols w:space="720"/><w:sectPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:sectPr>'
        + '<w:pgSz w:w="15840" w:h="24480"/><w:pgMar w:top="100" w:right="100" w:bottom="100" w:left="100" w:header="100" w:footer="100" w:gutter="0"/></w:sectPr></w:sectPrChange></w:sectPr>';
      expect(parseTemplatePgSz(state.templateSectPr)).toEqual(own ? { w: 11906, h: 16838 } : { w: 12240, h: 15840 });
      const xml = generateDocumentXml(parseMd('A.\n\n<!-- landscape -->\n\nB.\n\n<!-- /landscape -->\n\nC.'), state);
      const breaks = [...xml.matchAll(/<w:pPr><w:sectPr\b[^>]*>([\s\S]*?)<\/w:sectPr><\/w:pPr>/g)].map(match => match[1]);
      expect(breaks).toHaveLength(2);
      for (const sectPr of breaks) {
        expect(sectPr).not.toContain('24480');
        expect(sectPr).not.toContain('w:top="100"');
        expect(sectPr).toContain(own ? 'w:top="720"' : 'w:top="1440"');
      }
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

    it.each([
      ['landscape', 'Intro\n\n<!-- landscape -->\n\nWide\n\n<!-- /landscape -->\n\nAfter'],
      ['portrait', 'Intro\n\n<!-- portrait -->\n\nTall\n\n<!-- /portrait -->\n\nAfter'],
    ])('writes the properties of each section a %s block makes in the order CT_SectPr has them', async (_name, md) => {
      // Its w:type came after w:cols, out of the schema's order
      const ORDER = ['headerReference|footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders',
        'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter',
        'docGrid', 'printerSettings', 'sectPrChange'];
      const rank = (name: string) => ORDER.findIndex(names => names.split('|').includes(name));
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      const sectPrs = [...xml.matchAll(/<w:sectPr\b[^>]*>([\s\S]*?)<\/w:sectPr>/g)].map(match => match[1]);
      expect(sectPrs).toHaveLength(3);
      for (const sectPr of sectPrs) {
        const ranks = [...sectPr.matchAll(/<w:(\w+)\b/g)].map(match => rank(match[1]));
        expect(ranks).not.toContain(-1);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      }
      expect(xml.match(/<w:type w:val="nextPage"\/>/g)).toHaveLength(2);
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

    it('turns the template\'s page for a landscape section that ends the document, and keeps the rest of its properties', () => {
      // The section's properties are the body's, with no break after it
      const state = makeState();
      state.templateSectPr = '<w:sectPr><w:headerReference w:type="default" r:id="rId99"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="700" w:footer="700" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>';
      const xml = generateDocumentXml(parseMd('A.\n\n<!-- landscape -->\n\nB.\n\n<!-- /landscape -->'), state);
      expect(xml.slice(xml.lastIndexOf('<w:sectPr'))).toStartWith('<w:sectPr><w:headerReference w:type="default" r:id="rId99"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1000"');
      expect(xml.match(/w:orient="landscape"/g)).toHaveLength(1);
    });

    it.each([
      ['a page size with a closing tag', '<w:pgSz w:w="11906" w:h="16838"></w:pgSz>', ''],
      ['no page size', '', ''],
      ['no page size but in a tracked change\'s old properties', '', '<w:sectPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:sectPrChange>'],
    ])('turns the page of a template with %s for a landscape section that ends the document, and keeps the rest of its properties', (_, page, change) => {
      // The template's properties were left out for a page of its own
      const state = makeState();
      state.templateSectPr = '<w:sectPr><w:headerReference w:type="default" r:id="rId99"/>' + page + '<w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="700" w:footer="700" w:gutter="0"/><w:pgNumType w:start="5"/><w:cols w:num="2" w:space="720"/>' + change + '</w:sectPr>';
      const xml = generateDocumentXml(parseMd('A.\n\n<!-- landscape -->\n\nB.\n\n<!-- /landscape -->'), state);
      // The page's size is the template's, or else the default
      const bodySectPr = xml.slice(xml.lastIndexOf('<w:sectPr>', xml.lastIndexOf('<w:headerReference')));
      expect(bodySectPr.replace(/<w:pgSz w:w="\d+" w:h="\d+" w:orient="landscape"\/>/, '<pgSz/>')).toStartWith('<w:sectPr><w:headerReference w:type="default" r:id="rId99"/><pgSz/>'
        + '<w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="700" w:footer="700" w:gutter="0"/><w:pgNumType w:start="5"/><w:cols w:num="2" w:space="720"/>' + change + '</w:sectPr>');
    });

    it.each([
      ['no attributes', '<w:sectPr/>', '<w:sectPr>'],
      ['attributes', '<w:sectPr w:rsidR="00AB12CD"/>', '<w:sectPr w:rsidR="00AB12CD">'],
    ])('turns the page of a template whose properties are an empty element with %s for a landscape section that ends the document', (_, sectPr, open) => {
      // The page went inside the element's tag, which has no closing tag
      // to go before
      const state = makeState();
      state.templateSectPr = sectPr;
      const xml = generateDocumentXml(parseMd('A.\n\n<!-- landscape -->\n\nB.\n\n<!-- /landscape -->'), state);
      expect(xml.slice(xml.lastIndexOf('<w:sectPr'))).toStartWith(open + '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/></w:sectPr>\n</w:body>');
      expect(XMLValidator.validate(xml)).toBe(true);
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
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Landscape' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Portrait' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
      ];
      const state = makeState();
      const xml = generateDocumentXml(tokens, state);
      // 3 breaks: landscapeOpen portrait break, landscapeClose landscape break (skip portraitOpen), portraitClose portrait break
      const nextPageCount = (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length;
      expect(nextPageCount).toBe(3);
    });

    it('does not emit blank page between portrait close and landscape open', () => {
      const tokens: MdToken[] = [
        { type: 'paragraph', runs: [{ type: 'text', text: 'Before' }] },
        { type: 'paragraph', runs: [], portraitOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Portrait' }] },
        { type: 'paragraph', runs: [], portraitClose: true },
        { type: 'paragraph', runs: [], landscapeOpen: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'Landscape' }] },
        { type: 'paragraph', runs: [], landscapeClose: true },
        { type: 'paragraph', runs: [{ type: 'text', text: 'After' }] },
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
      // With no citeproc engine, the marker still gets the bibliography's
      // field, empty, which import reads back as the marker
      expect(xml).toContain('Before');
      expect(xml).toContain('After');
      const beforeIdx = xml.indexOf('Before');
      const fieldIdx = xml.indexOf('ADDIN ZOTERO_BIBL');
      const afterIdx = xml.indexOf('After');
      expect(beforeIdx).toBeLessThan(fieldIdx);
      expect(fieldIdx).toBeLessThan(afterIdx);
    });
  });

  describe('with no bibliography entries', () => {
    // Export wrote nothing at the marker, so import lost it, and the notes on
    // missing keys export wrote there went to the end on the next round trip
    const note = 'Citation data for @a was not found in the bibliography file.';
    const roundTrip = async (md: string, bibtex?: string) => {
      const { convertDocx } = await import('./converter');
      return (await convertDocx((await convertMdToDocx(md, { bibtex })).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    };

    it.each([
      ['with nothing to list', 'A.\n\n<!-- references -->\n\nB.', 'A.\n\n<!-- references -->\n\nB.'],
      ['before the notes on missing keys', 'A [@a].\n\n<!-- references -->\n\nB.', 'A [@a].\n\n<!-- references -->\n\n' + note + '\n\nB.'],
      ['first in the document', '<!-- references -->\n\n[@a]', '<!-- references -->\n\n' + note + '\n\n[@a]'],
      ['in a landscape section',
        'A.\n\n<!-- landscape -->\n\nX [@a].\n\n<!-- references -->\n\nY.\n\n<!-- /landscape -->\n\nB.',
        'A.\n\n<!-- landscape -->\n\nX [@a].\n\n<!-- references -->\n\n' + note + '\n\nY.\n\n<!-- /landscape -->\n\nB.'],
      ['spelled bibliography, as references', 'A.\n\n<!-- bibliography -->\n\nB.', 'A.\n\n<!-- references -->\n\nB.'],
    ])('MD→DOCX→MD keeps the marker %s, and the next round trip all of it', async (_, md, expected) => {
      const once = await roundTrip(md);
      expect(once).toBe(expected);
      expect(await roundTrip(once)).toBe(expected);
    });

    it('MD→DOCX→MD leaves out the marker at the end of the body, before the notes\' definitions, where the bibliography goes anyway', async () => {
      expect(await roundTrip('A.[^1]\n\n<!-- references -->\n\n[^1]: Note.')).toBe('A.[^1]\n\n[^1]: Note.');
      expect(await roundTrip('A.[^1]\n\n[^1]: Note.')).toBe('A.[^1]\n\n[^1]: Note.');
    });

    it('MD→DOCX→MD keeps the marker with a bibliography that has none of the cited keys', async () => {
      const bibtex = '@article{key1, author={Smith}, title={Title}, journal={J}, year={2020}}';
      expect(await roundTrip('A.\n\n<!-- references -->\n\nB.', bibtex)).toBe('A.\n\n<!-- references -->\n\nB.');
      expect(await roundTrip('A [@a].\n\n<!-- references -->\n\nB.', bibtex))
        .toBe('A [@a].\n\n<!-- references -->\n\n' + note + '\n\nB.');
    });

    it('DOCX→MD→DOCX writes the empty field again, and a marker at the end gets none', async () => {
      const { convertDocx } = await import('./converter');
      const JSZip = (await import('jszip')).default;
      // Without the revision IDs, which each export draws anew
      const documentXml = async (docx: Uint8Array) =>
        (await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).replace(/ w:rsid\w*="\w+"/g, '');
      const { docx } = await convertMdToDocx('A [@a].\n\n<!-- references -->\n\nB.');
      const xml = await documentXml(docx);
      const fieldIdx = xml.indexOf('ADDIN ZOTERO_BIBL');
      expect(fieldIdx).toBeGreaterThan(xml.indexOf('>A '));
      expect(fieldIdx).toBeLessThan(xml.indexOf(note));
      expect(xml.indexOf(note)).toBeLessThan(xml.indexOf('>B.<'));
      expect(await documentXml((await convertMdToDocx((await convertDocx(docx)).markdown)).docx)).toBe(xml);
      // Where the bibliography goes anyway, import drops the marker, and the
      // next export would drop the field
      expect(await documentXml((await convertMdToDocx('A.\n\n<!-- references -->')).docx)).not.toContain('ZOTERO_BIBL');
      expect(await documentXml((await convertMdToDocx('A.[^1]\n\n<!-- references -->\n\n[^1]: Note.')).docx)).not.toContain('ZOTERO_BIBL');
    });

    it('writes the empty field as one hidden paragraph, which Word shows nothing of', async () => {
      // It was two paragraphs, as around a bibliography's entries, which Word
      // showed as blank lines where the Markdown has a comment alone
      const JSZip = (await import('jszip')).default;
      const { docx } = await convertMdToDocx('A [@a].\n\n<!-- references -->\n\nB.');
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      const paragraphs = xml.match(/<w:p [^>]*>.*?<\/w:p>/g)!.map(paragraph => paragraph.replace(/^<w:p [^>]*>/, ''));
      expect(paragraphs).toHaveLength(4);
      expect(paragraphs[1]).toBe(
        '<w:pPr><w:spacing w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:vanish/><w:color w:val="FFFFFF"/></w:rPr></w:pPr>'
        + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        + '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {&quot;uncited&quot;:[],&quot;omitted&quot;:[],&quot;custom&quot;:[]} CSL_BIBLIOGRAPHY </w:instrText></w:r>'
        + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
      expect(paragraphs[2]).toContain(note);
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

  it.each([
    ['the first paragraph', '<!-- no-indent -->\nZ.\n\nZZ.'],
    ['the second paragraph with no heading', 'A.\n\n<!-- no-indent -->\nZ.\n\nZZ.'],
    ['a paragraph after a quote', 'A.\n\n> q\n\n<!-- indent -->\nZ.\n\nZZ.'],
    ['a paragraph after an alert', '> [!NOTE]\n> q\n\n<!-- indent -->\nZ.\n\nZZ.'],
    ['a paragraph after a code block', '```\nx\n```\n\n<!-- no-indent -->\nZ.\n\nZZ.'],
    ['a paragraph after a deletion', '{--gone--}\n\n<!-- indent -->\nZ.\n\nZZ.'],
    ['a deletion', '# H\n\n<!-- indent -->\n{--gone--}\n\nZZ.'],
  ])('MD→DOCX→MD keeps the sentinel on %s', async (_, md) => {
    const { convertDocx } = await import('./converter');
    const roundTrip = async (source: string) =>
      (await convertDocx((await convertMdToDocx(source)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    // Not the paragraph after, where a miscounted index would put it
    expect(await roundTrip(md)).toBe(md);
  });

  it('MD→DOCX→MD keeps the sentinel after an image that can\'t be read', async () => {
    const { convertDocx } = await import('./converter');
    const { docx } = await convertMdToDocx('![](missing.png)\n\n<!-- indent -->\nZ.\n\nZZ.');
    // Word gets no image, nor a paragraph import would count
    expect((await convertDocx(docx)).markdown).toContain('<!-- indent -->\nZ.\n\nZZ.');
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

describe('A horizontal rule at the start', () => {
  it('keeps the text before the next rule', async () => {
    // Not frontmatter, as --- before a blank line opens none
    const { docx } = await convertMdToDocx('---\n\nKept.\n\n---\n\nAfter.');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('Kept.');
    expect(xml).toContain('After.');
  });

  it('stores no frontmatter spacing for it', async () => {
    const { docx } = await convertMdToDocx('---\n\nKept.');
    const JSZip = (await import('jszip')).default;
    const custom = await (await JSZip.loadAsync(docx)).file('docProps/custom.xml')?.async('string') ?? '';
    expect(custom).not.toContain('MANUSCRIPT_FRONTMATTER_BLANK_LINES');
  });
});

describe('Characters XML can\'t hold', () => {
  it('removes them, which made a part Word can\'t read', async () => {
    const { docx, warnings } = await convertMdToDocx('---\ntitle: t\u0007\n---\n\na\u0002b {==c==}{>>d\u000B<<} \uFFFF');
    const zip = await (await import('jszip')).default.loadAsync(docx);
    for (const path of Object.keys(zip.files).filter(path => /\.(?:xml|rels)$/.test(path))) {
      expect(await zip.file(path)!.async('string')).not.toMatch(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u);
    }
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('>ab <');
    expect(warnings).toContain('Removed 4 characters a Word document can\'t hold, such as control characters');
  });

  it('keeps a space it leaves at the edge of a run\'s text', async () => {
    // Written without xml:space="preserve", which a space at the edge needs
    // and the character had kept from it, Word dropped the space
    const { docx } = await convertMdToDocx('a \u0007**b** \u0002c');
    const xml = await (await import('jszip')).default.loadAsync(docx).then(zip => zip.file('word/document.xml')!.async('string'));
    expect(xml).toContain('<w:t xml:space="preserve">a </w:t>');
    expect(xml).toContain('<w:t xml:space="preserve"> c</w:t>');
  });

  it('keeps a template\'s part in UTF-16 as it is', async () => {
    // Read as UTF-8, its bytes of 0 went, and it was neither
    const JSZip = (await import('jszip')).default;
    const template = await JSZip.loadAsync((await convertMdToDocx('a')).docx);
    const theme = await template.file('word/theme/theme1.xml')!.async('string');
    const utf16 = new Uint8Array(2 + theme.length * 2);
    utf16.set([0xFF, 0xFE]);
    for (let k = 0; k < theme.length; k++) utf16.set([theme.charCodeAt(k) & 0xFF, theme.charCodeAt(k) >> 8], 2 + k * 2);
    template.file('word/theme/theme1.xml', utf16);
    const { docx } = await convertMdToDocx('b', { templateDocx: await template.generateAsync({ type: 'uint8array' }) });
    expect(await (await JSZip.loadAsync(docx)).file('word/theme/theme1.xml')!.async('uint8array')).toEqual(utf16);
  });
});

describe('Line breaks in tracked changes and comments', () => {
  const documentXml = async (md: string) => {
    const zip = await (await import('jszip')).default.loadAsync((await convertMdToDocx(md)).docx);
    return zip.file('word/document.xml')!.async('string');
  };

  it.each([
    ['deleted, underlined', 'x{--<u>a\\\nb</u>--}y', '<w:u w:val="single"/>'],
    ['deleted, highlighted', 'x{--==a\\\nb==--}y', '<w:highlight w:val="yellow"/>'],
    ['deleted in a highlight', '==x{--a\\\nb--}y==', '<w:highlight w:val="yellow"/>'],
    ['inserted in an underline', '<u>x{++a\\\nb++}y</u>', '<w:u w:val="single"/>'],
    ['highlighted in a comment\'s range', 'x{====a\\\nb====}{>>c<<}y', '<w:highlight w:val="yellow"/>'],
    ['struck on a substitution\'s old side', 'x{~~<s>a\\\nb</s>~>c~~}y', '<w:strike/>'],
  ])('gives a line break %s the formatting around it', async (_name, md, rPr) => {
    // It went plain, where Word shows the formatting on it
    const xml = await documentXml(md);
    expect(xml).toMatch(new RegExp('<w:r><w:rPr>(?:(?!</w:rPr>).)*' + rPr + '(?:(?!</w:rPr>).)*</w:rPr><w:br/></w:r>'));
    expect(xml).not.toContain('<w:r><w:br/></w:r>');
  });

  it.each([
    'x{--<u>a\\\nb</u>--}y\n', 'x{--==a\\\nb==--}y\n', 'x{====a\\\nb====}{>>c<<}y\n', 'x{~~<u>a\\\nb</u>~><u>c\\\nd</u>~~}y\n',
  ])('reads %j back from Word as it is', async (md) => {
    // Its break came back outside the formatting, which split the span
    const { convertDocx } = await import('./converter');
    const back = async (markdown: string) => (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(await back(md)).toBe(md);
  });
});

describe('Line breaks in an HTML table\'s cell', () => {
  const TABLE = '<table><tr><td colspan="2">h</td></tr><tr><td>XX</td><td>z</td></tr></table>';
  const documentXml = async (cell: string) => {
    const zip = await (await import('jszip')).default.loadAsync((await convertMdToDocx(TABLE.replace('XX', cell))).docx);
    return zip.file('word/document.xml')!.async('string');
  };

  it.each([
    ['underlined', 'x<u>a<br>b</u>y', '<w:u w:val="single"/>'],
    ['struck', 'x<s><br>a</s>y', '<w:strike/>'],
    ['in code', 'x<code>a<br>b</code>y', '<w:rStyle w:val="CodeChar"/>'],
  ])('gives a line break %s the formatting around it', async (_name, cell, rPr) => {
    // It went plain, where Word shows the formatting on it
    const xml = await documentXml(cell);
    expect(xml).toMatch(new RegExp('<w:r><w:rPr>(?:(?!</w:rPr>).)*' + rPr + '(?:(?!</w:rPr>).)*</w:rPr><w:br/></w:r>'));
    expect(xml).not.toContain('<w:r><w:br/></w:r>');
  });

  it.each([
    ['at its end', '<a href="https://e.org">a<br></a>y'],
    ['at its start', 'x<a href="https://e.org"><br>a</a>'],
    ['in it', '<a href="https://e.org">a<br>b</a>'],
  ])('keeps a line break %s in a link\'s hyperlink', async (_name, cell) => {
    // It was no link's, so the hyperlink ended at it
    const xml = await documentXml(cell);
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    expect(xml.replace(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g, '')).not.toContain('<w:br/>');
  });
});

describe('Comments a paragraph reads inline', () => {
  // The fastest of five runs of each, by turns, which a pause for garbage
  // collection slows neither more than the other, and the large's time over
  // the small's
  const growth = (small: () => unknown, large: () => unknown) => {
    const time = (work: () => unknown) => {
      const start = performance.now();
      work();
      return performance.now() - start;
    };
    let smallTime = Infinity;
    let largeTime = Infinity;
    for (let k = 0; k < 5; k++) {
      largeTime = Math.min(largeTime, time(large));
      smallTime = Math.min(smallTime, time(small));
    }
    return largeTime / smallTime;
  };
  it.each(['<br>', ' <br> <br>'])('reads a long comment before %s in linear time', (breaks) => {
    // As import writes one a line break ends, whose block the regex that
    // found the comments at its start read many times slower past some
    // tens of thousands of a comment's characters: about 35 before, 2.5 after
    const read = (n: number) => () => parseMd('<!-- ' + 'a'.repeat(n) + ' -->' + breaks + '\n');
    expect(parseMd('<!-- a -->' + breaks + '\n')[0].runs?.map(run => run.type)).toContain('hardbreak');
    expect(growth(read(40000), read(160000))).toBeLessThan(8);
  });

  // Under Node, the extension's runtime, from a bundle for it, as
  // esbuild.mjs builds the extension
  const node = Bun.which('node');
  it.skipIf(!node)('reads a comment before more line breaks than a call takes arguments', async () => {
    // A spread of the line breaks and the spaces before them into push
    // overflowed the stack, in Node past about 120,000 arguments. Bun takes
    // some 500,000, but Bun 1.3.9 reads a block of more than some 700,000
    // line breaks as text, as its regex for one fails there.
    const dir = mkdtempSync(join(tmpdir(), 'md-to-docx-'));
    try {
      const bundle = join(dir, 'md-to-docx.cjs');
      await build({ entryPoints: [join(import.meta.dir, 'md-to-docx.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: bundle, logLevel: 'error' });
      const script = 'const runs = require(' + JSON.stringify(bundle) + ").parseMd('<!-- c -->' + ' <br>'.repeat(200000) + '\\n')[0].runs;"
        + "console.log(runs.length, runs.filter(run => run.type === 'hardbreak').length);";
      const result = Bun.spawnSync([node!, '-e', script]);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.toString()).toBe('400001 200000\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it.each([
    ['alone, a line each', '<br>\n'.repeat(800000), 800000],
    ['after a comment', '<!-- c -->' + ' <br>'.repeat(800000) + '\n', 1600001],
  ])('reads a block of more line breaks than Bun 1.3.9 matched in one regex, %s', (_name, md, runs) => {
    // Bun 1.3.9, which CI tests and builds the CLI with, found no match of
    // /^(?:<br\s*\/?>\s*)+$/i, nor of the one for breaks after comments, past
    // some 700,000 breaks, so export read them as text. It reads each break
    // in turn.
    const tokens = parseMd(md);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].runs).toHaveLength(runs);
    expect(tokens[0].runs.filter(run => run.type === 'hardbreak')).toHaveLength(800000);
  });

  it('reads the line breaks of a block one at a time as the regexes for all of them read them', async () => {
    const { commentsEnd, isLineBreakBlock } = await import('./html-blocks');
    const byRegex = (content: string) => {
      const text = content.trim();
      const end = commentsEnd(text);
      return /^(?:<br\s*\/?>\s*)+$/i.test(text) || end > 0 && /^<br\s*\/?>(?:[ \t]*<br\s*\/?>)*$/i.test(text.slice(end));
    };
    const part = fc.constantFrom('<br>', '<BR/>', '<br />', '<bR\t/>', '<br\n>', '<br', '/>', '>', ' ', '\t', '\n', ' ', ' ', '﻿',
      '<!-- c -->', '<!--', '-->', 'x');
    fc.assert(fc.property(fc.array(part, { maxLength: 10 }).map(parts => parts.join('')), text => {
      expect(isLineBreakBlock(text)).toBe(byRegex(text));
    }), { numRuns: 5000 });
  });

  // A hidden run of `n` comments with 100 spaces between them
  const payload = (n: number) => Array.from({ length: n }, (_, i) => '<!-- c' + i + ' -->').join(' '.repeat(100));

  it('reads a hidden run of many comments in linear time', async () => {
    // Taking each comment out of all the run's text in turn took time in
    // the square of their number. Four times the comments take about four
    // times as long, not sixteen.
    const { readsCommentsInline } = await import('./md-to-docx');
    const run = (n: number) => {
      const text = payload(n);
      return () => readsCommentsInline('&#32;' + text, [text]);
    };
    expect(growth(run(4000), run(16000))).toBeLessThan(8);
  }, 60000);

  it('finds the text outside the comments of a hidden run of many in linear time', async () => {
    // Import reads it in each paragraph's runs. Taking each comment out of
    // all the text in turn took time in the square of their number.
    const { outsideComments } = await import('./md-to-docx');
    const run = (n: number) => {
      const text = payload(n);
      return () => outsideComments(text);
    };
    expect(growth(run(4000), run(16000))).toBeLessThan(8);
  }, 60000);
});

describe('Links linkify finds in long text', () => {
  // linkify-it searched what was left of a text after each link it found
  // from its start, for an email address and for a scheme, so text of many
  // links took time quadratic in its length. It gets the text in pieces.
  it('finds in pieces the links it finds in all of the text', async () => {
    const { linkifyMatches } = await import('./md-to-docx');
    const part = fc.constantFrom('https://a.com', 'http://e.co/x', 'ftp://f.org', 'mailto:a@b.cd', 'x@y.com', '//e.com', 'www.e.com',
      ' ', '\t', '\n', ' ', '　', ' ', '\x7f', '(', ')', '[', ']', '.', ',', ';', '!', '?', '"', '\'', '<', '>', '-', '_',
      ':', '/', '\\', '@', '=', '｜', 'é', 'a', '1', ':80', '.com');
    const links = (text: string, pieceLength: number) => linkifyMatches(text, pieceLength).map(link => [link.schema, link.index, link.lastIndex]);
    fc.assert(fc.property(fc.array(part, { maxLength: 60 }).map(parts => parts.join('')), fc.integer({ min: 1, max: 40 }), (text, pieceLength) => {
      expect(links(text, pieceLength)).toEqual(links(text, Infinity));
    }), { numRuns: 2000 });
  });

  it('reads a paragraph of many email addresses in linear time', () => {
    // Export's linkify rule found each address after a search to the end of
    // the paragraph. Four times the addresses took about eleven times as long.
    const read = (n: number) => () => parseMd('a@b.com '.repeat(n) + 'x\n');
    expect(read(5)()[0].runs.filter(run => run.href === 'mailto:a@b.com')).toHaveLength(5);
    const time = (work: () => unknown) => {
      const start = performance.now();
      work();
      return performance.now() - start;
    };
    // The fastest of five runs of each, by turns
    let small = Infinity;
    let large = Infinity;
    for (let k = 0; k < 5; k++) {
      large = Math.min(large, time(read(8000)));
      small = Math.min(small, time(read(2000)));
    }
    expect(large / small).toBeLessThan(8);
  }, 60000);
});

describe('Character references in HTML', () => {
  // A table's body cell's text in Word, and in the preview, as markdown-it
  // writes a Markdown table
  const wordCell = async (md: string) => {
    const zip = await (await import('jszip')).default.loadAsync((await convertMdToDocx(md)).docx);
    const row = [...(await zip.file('word/document.xml')!.async('string')).matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)][1][0];
    return unescape([...row.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''));
  };
  const previewCell = async (md: string) => unescape(/<td>([^<]*)<\/td>/.exec((await import('./test-helpers')).renderWithPlugin(md))![1]);
  const unescape = (xml: string) => xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  it.each([
    ['&#128;', '€'], ['&#x80;', '€'], ['&#X9F;', 'Ÿ'], ['&#150;', '–'], ['&#153;', '™'], ['&#128', '€'],
    ['&#129;', '\u0081'], ['&#0;', '\uFFFD'], ['&#xD800;', '\uFFFD'], ['&#x110000;', '\uFFFD'],
  ])('reads %s in an HTML cell as the browser does, in Word and in Compact Table', async (reference, shown) => {
    // What the browser shows, as the preview of the HTML does: HTML reads a
    // numeric reference from 0x80 to 0x9F as Windows-1252's character, but
    // for the five it has none for, as &#129;, and one to no character as
    // U+FFFD, and one without its ; or with an X too. Export read &#128; as
    // U+0080, which Word showed as nothing, and Compact Table wrote it so.
    const html = '<table><tr><th>h</th></tr><tr><td>a' + reference + 'b</td></tr></table>';
    expect(await wordCell(html)).toBe('a' + shown + 'b');
    const compacted = (await import('./formatting')).compactTable(html).newText;
    expect(await previewCell(compacted)).toBe('a' + shown + 'b');
    expect(await wordCell(compacted)).toBe('a' + shown + 'b');
  });

  it.each([
    ['&copy;', '©'], ['&mdash;', '—'], ['&euro;', '€'], ['&frac12;', '½'], ['&AMP;', '&'], ['&nbsp;', '\u00a0'],
    ['&NBSP;', '&NBSP;'], ['&nosuch;', '&nosuch;'],
  ])('reads %s in an HTML cell by HTML\'s names, as the browser does, in Word and in Compact Table', async (reference, shown) => {
    // Export read only &nbsp;, &lt;, &gt;, &quot;, &apos; and &amp;, so Word
    // showed &copy; as it was written
    const html = '<table><tr><th>h</th></tr><tr><td>a' + reference + 'b</td></tr></table>';
    expect(await wordCell(html)).toBe('a' + shown + 'b');
    const compacted = (await import('./formatting')).compactTable(html).newText;
    expect(await previewCell(compacted)).toBe('a' + shown + 'b');
    expect(await wordCell(compacted)).toBe('a' + shown + 'b');
  });

  it.each([
    ['&copy ', '\u00a9 '], ['&copyx', '\u00a9x'], ['&COPY ', '\u00a9 '], ['&notin ', '\u00acin '], ['&ltx', '<x'],
    ['&frac12x', '\u00bdx'], ['&amp ', '& '],
    // No legacy name starts them, so the browser reads them only with a ;
    ['&hellip ', '&hellip '], ['&Copy ', '&Copy '],
  ])('reads %s in an HTML cell by a legacy name without its ;, as the browser does, in export, import and a second trip', async (reference, shown) => {
    // HTML reads about a hundred of its older names, as &copy, without the
    // ;, in text, by the longest such name the letters start with, which
    // export read only with it, so Word showed &copy as it was written
    const { convertDocx } = await import('./converter');
    const html = '<table><tr><th>h</th></tr><tr><td>a' + reference + 'b</td></tr></table>';
    expect(await wordCell(html)).toBe('a' + shown + 'b');
    const imported = (await convertDocx((await convertMdToDocx(html)).docx)).markdown;
    expect(await wordCell(imported)).toBe('a' + shown + 'b');
    expect(await wordCell((await convertDocx((await convertMdToDocx(imported)).docx)).markdown)).toBe('a' + shown + 'b');
    const compacted = (await import('./formatting')).compactTable(html).newText;
    expect(await previewCell(compacted)).toBe('a' + shown + 'b');
    expect(await wordCell(compacted)).toBe('a' + shown + 'b');
  });

  it('reads a legacy name without its ; in an <img>\'s src or alt as the browser does in an attribute', () => {
    // Read where what follows it isn't a letter, a digit or an =
    const image = parseMd('<img src="a&copy.png" alt="a&copy b &copy=x &copyx &copy-x">').flatMap(token => token.runs ?? []).find(run => run.type === 'image');
    expect(image?.imageSrc).toBe('a\u00a9.png');
    expect(image?.imageAlt).toBe('a\u00a9 b &copy=x &copyx \u00a9-x');
  });

  // Hundreds of digits, which the entities package's numeric reading took
  // as a number past JavaScript's, and threw on, as it found 0 times it
  // not a number
  const zeros = '0'.repeat(309);
  const longReferences: [string, string, string][] = [
    ['decimal with leading zeros', '&#' + zeros + '65;', 'A'],
    ['decimal with leading zeros without its ;', '&#' + zeros + '65 ', 'A '],
    ['hexadecimal with leading zeros', '&#x' + zeros + '41;', 'A'],
    ['hexadecimal with leading zeros without its ;', '&#X' + zeros + '41 ', 'A '],
    ['Windows-1252\'s with leading zeros', '&#' + zeros + '128;', '\u20ac'],
    ['decimal past U+10FFFF', '&#' + '9'.repeat(400) + ';', '\uFFFD'],
    ['decimal past U+10FFFF without its ;', '&#' + '9'.repeat(400) + ' ', '\uFFFD '],
    ['hexadecimal past U+10FFFF', '&#x' + 'F'.repeat(300) + ';', '\uFFFD'],
    ['hexadecimal past U+10FFFF without its ;', '&#x' + 'f'.repeat(300) + ' ', '\uFFFD '],
    ['past U+10FFFF with leading zeros', '&#' + zeros + '1114112;', '\uFFFD'],
  ];

  it.each(longReferences)('reads a numeric reference of hundreds of digits, %s, in an HTML cell as the browser does, in Word and in Compact Table', async (_name, reference, shown) => {
    // Leading zeros don't count, and a number past U+10FFFF is U+FFFD
    // (https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state)
    const html = '<table><tr><th>h</th></tr><tr><td>a' + reference + 'b</td></tr></table>';
    expect(await wordCell(html)).toBe('a' + shown + 'b');
    const compacted = (await import('./formatting')).compactTable(html).newText;
    expect(await previewCell(compacted)).toBe('a' + shown + 'b');
    expect(await wordCell(compacted)).toBe('a' + shown + 'b');
  });

  it.each(longReferences)('formats the values of an HTML table with a numeric reference of hundreds of digits, %s', async (_name, reference) => {
    const { formatTableNumbers } = await import('./table-number-format');
    const html = (value: string) => '<table><tr><td>' + reference + '</td><td>' + value + '</td></tr></table>';
    expect(formatTableNumbers(html('1234.5'), { digits: 2 }).output).toBe(html('1234.50'));
  });

  it('formats a value after a $ written as a numeric reference with hundreds of leading zeros', async () => {
    const { formatTableNumbers } = await import('./table-number-format');
    const html = (value: string) => '<table><tr><td>&#' + zeros + '36;' + value + '</td><td>&#x' + zeros + '24;' + value + '</td></tr></table>';
    expect(formatTableNumbers(html('1234.5'), { digits: 2 }).output).toBe(html('1234.50'));
  });

  it.each(longReferences)('reads a numeric reference of hundreds of digits, %s, in an <img>\'s src and alt', (_name, reference, shown) => {
    const image = parseMd('<img src="a' + reference + '.png" alt="a' + reference + 'b">').flatMap(token => token.runs ?? []).find(run => run.type === 'image');
    expect(image?.imageSrc).toBe('a' + shown + '.png');
    expect(image?.imageAlt).toBe('a' + shown + 'b');
  });

  it.each([
    ['a block of its own', '<img src="a&#128;.png" alt="&#128; &#x110000; &#150;">'],
    ['a paragraph', 'x <img src="a&#128;.png" alt="&#128; &#x110000; &#150;"> y'],
  ])('reads an <img>\'s alt and src in %s as the browser does', (_name, md) => {
    // Export read &#128; as U+0080, and threw on &#x110000;
    const image = parseMd(md).flatMap(token => token.runs ?? []).find(run => run.type === 'image');
    expect(image?.imageAlt).toBe('€ \uFFFD –');
    expect(image?.imageSrc).toBe('a€.png');
  });

  it('reads a line end written as a reference in an HTML cell as whitespace HTML collapses, however it is written', async () => {
    // &NewLine; and &#10 without its ; were line ends in the cell's text,
    // which Compact Table made a grid table's lines of, as line breaks
    const html = '<table><tr><th>h</th></tr><tr><td>a&NewLine;b&#10c&#XA;d&#13e &#0010; f&#100;g</td></tr></table>';
    expect(await wordCell(html)).toBe('a b c d e fdg');
    const compacted = (await import('./formatting')).compactTable(html).newText;
    expect(compacted.split('\n')).toHaveLength(3);
    expect(await previewCell(compacted)).toBe('a b c d e fdg');
    expect(await wordCell(compacted)).toBe('a b c d e fdg');
  });

  it('reads a named reference in an <img>\'s src or alt only by a whole name, as the browser does in an attribute', () => {
    // &notit; read as ¬it;, by &not, which HTML reads without its ; in text
    const image = parseMd('<img src="cover&notit;.png" alt="a&notit;b &not; &notin;">').flatMap(token => token.runs ?? []).find(run => run.type === 'image');
    expect(image?.imageSrc).toBe('cover&notit;.png');
    expect(image?.imageAlt).toBe('a&notit;b \u00ac \u2209');
  });

  it('reads a legacy name without its ; in Markdown as text, as markdown-it does, in the preview and in Word', async () => {
    // CommonMark reads a name only with its ;, so only HTML reads &copy b as © b
    const md = '| h |\n| --- |\n| a&copy b &amp c |';
    expect(await previewCell(md)).toBe('a&copy b &amp c');
    expect(await wordCell(md)).toBe('a&copy b &amp c');
  });

  it.each([['&#128;'], ['&#150;'], ['&#0;']])('reads %s in Markdown as markdown-it does, in the preview and in Word', async (reference) => {
    // Markdown's own text isn't HTML, so U+FFFD for a control character's
    const md = '| h |\n| --- |\n| a' + reference + 'b |';
    expect(await previewCell(md)).toBe('a\uFFFDb');
    expect(await wordCell(md)).toBe('a\uFFFDb');
  });
});
