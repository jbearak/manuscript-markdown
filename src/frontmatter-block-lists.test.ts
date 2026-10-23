import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { ARRAY_KEYS, SINGLE_VALUE_KEYS, blockListAfter, parseFrontmatter } from './frontmatter';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { fastestRun } from './test-timing';

const fm = (yaml: string): string => '---\n' + yaml + '\n---\n\nP.\n';
const read = (yaml: string) => parseFrontmatter(fm(yaml));

/** The parts of Word's document that frontmatter sets, without the revision IDs that differ on each export */
async function wordParts(markdown: string): Promise<{ document: string; styles: string; custom: string; creator: string | undefined; warnings: string[] }> {
  const { docx, warnings } = await convertMdToDocx(markdown);
  const zip = await JSZip.loadAsync(docx);
  const part = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
  return {
    document: (await part('word/document.xml')).replace(/ w:rsid\w*="[^"]*"/g, ''),
    styles: await part('word/styles.xml'),
    custom: await part('docProps/custom.xml'),
    creator: (await part('docProps/core.xml')).match(/<dc:creator>(.*?)<\/dc:creator>/)?.[1],
    warnings,
  };
}

/** The texts of Word's Title paragraphs */
async function titles(markdown: string): Promise<string[]> {
  const { document } = await wordParts(markdown);
  return document.split('</w:p>')
    .filter(p => p.includes('<w:pStyle w:val="Title"/>'))
    .map(p => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(t => t[1]).join(''));
}

/** Import's frontmatter, its lines between the fences */
async function importedFrontmatter(markdown: string): Promise<string> {
  const { docx } = await convertMdToDocx(markdown);
  const { markdown: imported } = await convertDocx(docx);
  return imported.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
}

describe('a block list in frontmatter', () => {
  it('reads a title written as a block list as the key repeated', () => {
    const { metadata, fieldOrder, warnings } = read('title:\n  - One\n  - Two');
    expect(metadata.title).toEqual(['One', 'Two']);
    expect(metadata).toEqual(read('title: One\ntitle: Two').metadata);
    expect(fieldOrder).toEqual(['title']);
    expect(warnings).toBeUndefined();
  });

  it.each([
    ['header-font', 'Georgia', 'Arial'],
    ['header-font-size', '24', '20'],
    ['header-font-style', 'bold-italic', 'normal'],
    ['title-font', 'Georgia', 'Palatino'],
    ['title-font-size', '28', '20'],
    ['title-font-style', 'bold', 'italic'],
    ['table-col-widths', '2', '1'],
  ])('reads %s written as a block list as its inline array', (key, a, b) => {
    const { metadata, warnings } = read(key + ':\n  - ' + a + '\n  - ' + b);
    expect(Object.keys(metadata)).toHaveLength(1);
    expect(metadata).toEqual(read(key + ': [' + a + ', ' + b + ']').metadata);
    expect(warnings).toBeUndefined();
  });

  it('reads an inline array\'s keys, and those alone, as one', () => {
    expect([...ARRAY_KEYS].sort()).toEqual(['header-font', 'header-font-size', 'header-font-style',
      'table-col-widths', 'title-font', 'title-font-size', 'title-font-style']);
  });

  const singleValues: [string, string][] = [
    ['author', 'Jane Doe'], ['csl', 'chicago-author-date'], ['locale', 'en-GB'],
    ['zotero-notes', 'footnotes'], ['note-type', 'endnotes'], ['notes', 'endnotes'],
    ['timezone', '+05:30'], ['bibliography', 'refs.bib'], ['bib', 'refs'], ['bibtex', 'refs.bib'],
    ['font', 'Georgia'], ['code-font', 'Menlo'], ['font-size', '12'], ['code-font-size', '9'],
    ['code-background-color', 'F0F0F0'], ['code-background', 'none'], ['code-font-color', '333333'],
    ['code-color', '333333'], ['code-block-inset', '24'], ['table-font', 'Arial'], ['table-font-size', '9'],
    ['pipe-table-max-line-width', '80'], ['grid-table-max-line-width', '0'], ['table-borders', 'solid'],
    ['table-digits', '2'], ['table-decimal-mark', 'comma'], ['table-digit-grouping', 'space'],
    ['blockquote-style', 'Quote'], ['callout-labels', 'false'], ['colors', 'guttmacher'],
    ['breaks', 'true'], ['line-spacing', 'double'], ['paragraph-indent', '0.3'],
    ['bibliography-hanging-indent', 'false'], ['fig-cap-location', 'top'], ['tbl-cap-location', 'bottom'],
  ];

  it('checks each key that takes one value', () => {
    expect(singleValues.map(([key]) => key).sort()).toEqual([...SINGLE_VALUE_KEYS].sort());
  });

  it.each(singleValues)('reads %s written as a block list of one item as the key with that value', (key, value) => {
    const { metadata, warnings } = read(key + ':\n  - ' + value);
    expect(Object.keys(metadata)).toHaveLength(1);
    expect(metadata).toEqual(read(key + ': ' + value).metadata);
    expect(warnings).toBeUndefined();
  });

  it.each([
    ['author', 'Jane Doe', 'John Smith'],
    ['bibliography', 'refs.bib', 'more.bib'],
    ['csl', 'apa', 'nature'],
    ['colors', 'github', 'guttmacher'],
  ])('reads %s, which takes one value, written as a block list of two as the key repeated, and warns', (key, a, b) => {
    const { metadata, warnings } = read(key + ':\n  - ' + a + '\n  - ' + b);
    expect(metadata).toEqual(read(key + ': ' + a + '\n' + key + ': ' + b).metadata);
    expect(warnings).toEqual(['Frontmatter `' + key + '` takes one value, but its list has 2 items. Export used only one, as it does for `' + key + '` repeated.']);
  });

  it.each([
    ['quoted items', 'title:\n  - "One"\n  - \'Two\'', ['One', 'Two']],
    ['a quoted item with a colon', 'title:\n  - "a: b"', ['a: b']],
    ['a colon before other text', 'title:\n  - https://x.org\n  - 10:30', ['https://x.org', '10:30']],
    ['a quoted item as a scalar is read', 'title:\n  - \'it\'\'s\'', read("title: 'it''s'").metadata.title],
    ['a comment after an item, as after a scalar', 'title:\n  - One # main\n  - #2: x', read('title: One # main\ntitle: #2: x').metadata.title],
    ['blank lines and comments in the list', 'title:\n\n  # the title\n  - One\n\n  - Two\n# after\n', ['One', 'Two']],
    ['an item with no value, as the key with none', 'title:\n  - One\n  -\n  - Two', read('title: One\ntitle:\ntitle: Two').metadata.title],
    ['items indented more', 'title:\n    - One\n    - Two', ['One', 'Two']],
    ['items at the key\'s indentation', 'title:\n- One\n- Two\nauthor: A', ['One', 'Two']],
    ['a comment line more indented than an item', 'title:\n  - "One"\n    # 1 of 2\n  - Two', ['One', 'Two']],
    ['a comment as the key\'s value', 'title: # the title\n  - One', ['One']],
    ['CRLF line ends', 'title:\r\n  - One\r\n  - Two\r', ['One', 'Two']],
  ])('reads %s', (_, yaml, expected) => {
    const { metadata, warnings } = read(yaml as string);
    expect(metadata.title).toEqual(expected as string[]);
    expect(warnings).toBeUndefined();
  });

  it.each([
    ['an item over two lines', 'title:\n  - A long title\n    that goes on\n  - Two', 'title: A long title\n    that goes on\ntitle: Two'],
    ['a quoted item over two lines', 'title:\n  - "A long\n    title"', 'title: "A long\n    title"'],
    ['a quoted item that goes on over a line that starts with #', 'title:\n  - "Results\n    #1 of 3"', 'title: "Results\n    #1 of 3"'],
    ['a quoted item that goes on over a blank line', 'title:\n  - "Results\n\n    in full"\n  - Two', 'title: "Results\n\n    in full"\ntitle: Two'],
    ['a quote its line doesn\'t close', 'title:\n  - \'90s Music', 'title: \'90s Music'],
    ['an item\'s text on the line after its -', 'title:\n  -\n    One', 'title:\n    One'],
    ['an item more indented than the one before', 'title:\n  - One\n    - Two', 'title: One\n    - Two'],
    ['heading fonts over two lines', 'header-font:\n  - Times\n    New Roman\n  - Arial', 'header-font: [Times, Arial]\n    New Roman'],
  ])('reads %s as a value after the key that goes on is read, its line alone, and warns', (_, yaml, written) => {
    const { metadata, warnings } = read(yaml);
    expect(metadata).toEqual(read(written).metadata);
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain('goes on past its line');
  });

  it('reads no mapping as an item, as before, and warns', () => {
    const pandoc = read('author:\n  - name: Jane\n    affiliation: Uni\ntitle: T');
    expect(pandoc.metadata).toEqual({ title: ['T'] });
    expect(pandoc.warnings).toEqual(['Frontmatter `author` has a list item that is a mapping, which export doesn\'t read: `- name: Jane`. Put the item in quotes to read it as text.']);
    // As YAML reads an item with `: ` in it, unless it's in quotes
    expect(read('title:\n  - Main: A Subtitle').warnings).toHaveLength(1);
    expect(read('title:\n  - "Main: A Subtitle"').metadata).toEqual({ title: ['Main: A Subtitle'] });
    // Among items of text, which it reads
    const mixed = read('title:\n  - One\n  - "Two": x\n  - Three');
    expect(mixed.metadata.title).toEqual(['One', 'Three']);
    expect(mixed.warnings).toHaveLength(1);
    // No value, as the item's is the lines under it
    expect(read('title:\n  -\n    sub: x').metadata).toEqual({});
    // Its lines, of which export reads no key, as they're indented
    const nested = read('keywords:\n  - name: x\n    font: Arial');
    expect(nested.metadata).toEqual({});
    expect(nested.warnings).toEqual(['Frontmatter `font` is indented under `keywords`, which makes it part of `keywords`, so export doesn\'t read it. To set `font`, move it to the start of its line.']);
    // Under a key export doesn't read, without a warning
    expect(read('keywords:\n  - name: x').warnings).toBeUndefined();
  });

  it.each([
    ['an inline array', 'title: [One, Two]\nheader-font: [Georgia, Arial]', { title: ['One', 'Two'], headerFont: ['Georgia', 'Arial'] }],
    ['repeated keys', 'title: One\ntitle: Two\nauthor: A\nauthor: B', { title: ['One', 'Two'], author: 'B' }],
    ['scalars', 'title: "One"\nauthor: Jane\ncsl: apa', { title: ['One'], author: 'Jane', csl: 'apa' }],
    ['an empty value', 'title:\nauthor: A', { title: [''], author: 'A' }],
    ['an empty value before a blank line and a key', 'title:\n\nauthor: A', { title: [''], author: 'A' }],
    ['an empty value at the end', 'author:', {}],
    ['a styles mapping', 'styles:\n  Note:\n    font: Arial\n    font-size: 9\ntitle: T', { styles: { Note: { font: 'Arial', fontSize: 9 } }, title: ['T'] }],
    ['a styles mapping with a list under it', 'styles:\n  - Note\ntitle: T', { title: ['T'] }],
    ['a key whose value is a mapping', 'format:\n  docx:\n    toc: true\nfont: Georgia', { font: 'Georgia' }],
    ['a list under a key export doesn\'t read', 'keywords:\n  - a\n  - b\ntitle: T', { title: ['T'] }],
    ['a - line after a key with a value', 'title: One\n- Two', { title: ['One'] }],
    ['- lines in a literal value', 'abstract: |\n  - x\ntitle: T', { title: ['T'] }],
  ])('reads %s as before', (_, yaml, metadata) => {
    const result = read(yaml);
    expect(result.metadata).toEqual(metadata);
    expect(result.warnings).toBeUndefined();
  });

  it('reads the lists of many keys, of many lines, in linear time', () => {
    const lists = Array.from({ length: 4000 }, (_, k) => 'title:\n  - T' + k + '\n  # c\n\n  - U' + k + '\n    more').join('\n');
    const blanks = Array.from({ length: 4000 }, () => 'title:\n' + '\n# c\n'.repeat(10)).join('') + 'title: T';
    const items = 'title:\n' + '  - T\n    more of it\n'.repeat(20000);
    for (const yaml of [lists, blanks, items]) {
      // Quadratic reading took seconds here; linear takes milliseconds
      expect(fastestRun(() => read(yaml))).toBeLessThan(2000);
    }
    expect(read(lists).metadata.title).toHaveLength(8000);
    expect(read(items).metadata.title).toHaveLength(20000);
  }, 30000);

  it('finds an item\'s text in its line', () => {
    expect(blockListAfter(['title:', '  -   "One"  ', '  -', '    more', '  - ', '  - "a', '  # b"'], 0)).toEqual({
      items: [
        { line: 1, start: 6, end: 11, more: [], text: '"One"', mapping: false, continued: false },
        { line: 2, start: 3, end: 3, more: [3], text: '', mapping: false, continued: true },
        // Past the space after the `-`
        { line: 4, start: 4, end: 4, more: [], text: '', mapping: false, continued: false },
        { line: 5, start: 4, end: 6, more: [], text: '"a', mapping: false, continued: true },
      ],
      last: 5,
    });
    expect(blockListAfter(['  title:', '  - One'], 0)).toBeUndefined();
    expect(blockListAfter(['title: One', '  - Two'], 0)).toBeUndefined();
    expect(blockListAfter(['title:', 'author: A'], 0)).toBeUndefined();
  });
});

describe('a block list in frontmatter in Word', () => {
  it('gives Word a Title paragraph for each item', async () => {
    expect(await titles(fm('title:\n  - One\n  - Two'))).toEqual(['One', 'Two']);
  });

  it.each([
    ['a title', 'title:\n  - One\n  - "Two: a subtitle"', 'title: One\ntitle: Two: a subtitle'],
    ['an author', 'author:\n  - Jane Doe', 'author: Jane Doe'],
    ['heading fonts, sizes and styles', 'header-font:\n  - Georgia\n  - Arial\nheader-font-size:\n  - 24\n  - 20\nheader-font-style:\n  - bold-italic\n  - normal',
      'header-font: [Georgia, Arial]\nheader-font-size: [24, 20]\nheader-font-style: [bold-italic, normal]'],
    ['title fonts, sizes and styles', 'title: [One, Two]\ntitle-font:\n  - Georgia\n  - Palatino\ntitle-font-size:\n  - 28\n  - 20\ntitle-font-style:\n  - bold-center\n  - italic',
      'title: [One, Two]\ntitle-font: [Georgia, Palatino]\ntitle-font-size: [28, 20]\ntitle-font-style: [bold-center, italic]'],
    ['column widths', 'table-col-widths:\n  - 2\n  - 1', 'table-col-widths: [2, 1]'],
    ['a bibliography and other settings', 'bibliography:\n  - refs.bib\nfont:\n  - Georgia\nline-spacing:\n  - double\ncolors:\n  - guttmacher',
      'bibliography: refs.bib\nfont: Georgia\nline-spacing: double\ncolors: guttmacher'],
  ])('gives Word %s as the key without a list does', async (_, list, written) => {
    const body = '\n# H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const fromList = await wordParts(fm(list) + body);
    const fromWritten = await wordParts(fm(written) + body);
    expect(fromList.document).toBe(fromWritten.document);
    expect(fromList.styles).toBe(fromWritten.styles);
    expect(fromList.custom).toBe(fromWritten.custom);
    expect(fromList.creator).toBe(fromWritten.creator);
    expect(fromList.warnings).toEqual([]);
  });

  it('gives Word the author export reads from a list of several, and warns', async () => {
    const { creator, warnings } = await wordParts(fm('author:\n  - Jane Doe\n  - John Smith'));
    expect(creator).toBe('John Smith');
    expect(warnings).toContain('Frontmatter `author` takes one value, but its list has 2 items. Export used only one, as it does for `author` repeated.');
    expect((await wordParts(fm('title:\n  - name: x'))).warnings).toHaveLength(1);
  });

  it.each([
    ['a title', 'title:\n  - One\n  - Two', 'title: One\ntitle: Two'],
    ['an author', 'author:\n  - Jane Doe', 'author: Jane Doe'],
    ['heading fonts', 'header-font:\n  - Georgia\n  - Arial', 'header-font: [Georgia, Arial]'],
    ['a title font', 'title:\n  - One\ntitle-font:\n  - Georgia', 'title: One\ntitle-font: Georgia'],
    ['column widths', 'table-col-widths:\n  - 2\n  - 1', 'table-col-widths: 2 1'],
    ['a bibliography', 'bibliography:\n  - refs.bib', 'bibliography: refs.bib'],
  ])('comes back from Word as %s import writes, which export reads the same', async (_, list, imported) => {
    const markdown = fm(list);
    const back = await importedFrontmatter(markdown);
    expect(back).toContain(imported);
    // The next trip gives Word the same
    const again = '---\n' + back + '\n---\n\nP.\n';
    expect((await wordParts(again)).document).toBe((await wordParts(markdown)).document);
    expect((await wordParts(again)).styles).toBe((await wordParts(markdown)).styles);
    expect(await importedFrontmatter(again)).toBe(back);
  });
});

describe('Keys indented under another key', () => {
  it('reads no title, or other setting, indented under another key, and warns of each', () => {
    const { metadata, warnings } = read('title: Real\nauthor:\n  title: Prof\nmeta:\n  bibliography: x.bib\n  font: Arial');
    expect(metadata.title).toEqual(['Real']);
    expect(metadata.bibliography).toBeUndefined();
    expect(metadata.font).toBeUndefined();
    expect(warnings).toEqual([
      'Frontmatter `title` is indented under `author`, which makes it part of `author`, so export doesn\'t read it. To set `title`, move it to the start of its line.',
      'Frontmatter `bibliography` is indented under `meta`, which makes it part of `meta`, so export doesn\'t read it. To set `bibliography`, move it to the start of its line.',
      'Frontmatter `font` is indented under `meta`, which makes it part of `meta`, so export doesn\'t read it. To set `font`, move it to the start of its line.',
    ]);
  });

  it('reads no value of a key with none on its line and lines indented under it, its value', () => {
    expect(read('title:\n  text: My title\ntitle: T').metadata).toEqual({ title: ['T'] });
    expect(read('csl:\n\n  # a style\n  path: x.csl').metadata).toEqual({});
    // A key with none, before another key, as before
    expect(read('title:\n# c\nauthor: A').metadata).toEqual({ title: [''], author: 'A' });
  });

  it('reads no list under a key indented, nor a key on a line after an item of text, which is the item\'s', () => {
    const list = read('meta:\n  title:\n    - A');
    expect(list.metadata).toEqual({});
    expect(list.warnings).toEqual(['Frontmatter `title` is indented under `meta`, which makes it part of `meta`, so export doesn\'t read it. To set `title`, move it to the start of its line.']);
    const after = read('title:\n  - One\n    font: Arial');
    expect(after.metadata).toEqual({ title: ['One'] });
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings![0]).toContain('goes on past its line');
  });

  it('reads no key under a list item, past comments and deeper mappings', () => {
    const { metadata, warnings } = read('authors:\n  - name: Jane\n    # her role\n    title: Prof\naffil:\n  dept:\n    font: Arial');
    expect(metadata.title).toBeUndefined();
    expect(metadata.font).toBeUndefined();
    expect(warnings?.map(w => w.slice(0, w.indexOf(',')))).toEqual([
      'Frontmatter `title` is indented under `authors`',
      'Frontmatter `font` is indented under `affil`',
    ]);
  });

  it('warns of no line of a value that starts on its key\'s line, at any indentation', () => {
    for (const yaml of ['meta:\n  abstract: |\n    title: This is prose', 'meta:\n  note: >-\n\n    # a\n    font: Arial',
      'authors:\n  - name: Jane\n    bio: |\n      title: Prof', 'meta:\n  - One\n    title: more of it', 'meta:\n- bio: "a\n    title: b"',
      'abstract:\n  title:subtitle', 'meta:\n  note: "One\n  title: Prof"', 'meta:\n  names: [\n  title: Prof\n  ]', 'meta:\n  - {a: 1,\n  title: x}']) {
      const { metadata, warnings } = read(yaml);
      expect(metadata).toEqual({});
      expect(warnings).toBeUndefined();
    }
    // A key after the value, at the key's indentation or a list item's text's
    const after = read('meta:\n  abstract: |\n    prose\n  title: T\nauthors:\n- name: Jane\n  font: Arial\nlists:\n  - - x\n    - name: Jane\n      title: Prof');
    expect(after.warnings?.map(w => w.slice(0, w.indexOf(',')))).toEqual([
      'Frontmatter `title` is indented under `meta`',
      'Frontmatter `font` is indented under `authors`',
      'Frontmatter `title` is indented under `lists`',
    ]);
  });

  it('warns of no line of a value that starts on its key\'s line, nor of styles\' and crossref\'s keys', () => {
    const { metadata, warnings } = read('abstract: |\n  title: In the text\nstyles:\n  Quote:\n    font: Arial\ncrossref:\n  fig-title: Figure');
    expect(metadata.title).toBeUndefined();
    expect(metadata.styles?.Quote.font).toBe('Arial');
    expect(metadata.crossref?.figTitle).toBe('Figure');
    expect(warnings).toBeUndefined();
  });

  it('reads no key in frontmatter indented as a whole, and says to move each to its line\'s start', () => {
    const { metadata, warnings } = read('  title: T\n  font: Arial');
    expect(metadata).toEqual({});
    expect(warnings).toEqual([
      'Frontmatter `title` is indented, so export doesn\'t read it. To set `title`, move it to the start of its line.',
      'Frontmatter `font` is indented, so export doesn\'t read it. To set `font`, move it to the start of its line.',
    ]);
  });

  it('exports one Title paragraph, with the title at the line\'s start, and the warning', async () => {
    const markdown = fm('title: Real\nauthor:\n  name: Jane\n  title: Prof');
    expect(await titles(markdown)).toEqual(['Real']);
    const { warnings } = await wordParts(markdown);
    expect(warnings.some(w => w.startsWith('Frontmatter `title` is indented under `author`'))).toBe(true);
  });
});
