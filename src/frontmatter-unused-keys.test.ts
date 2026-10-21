import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { frontmatterLayout, serializeFrontmatter } from './frontmatter';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { fastestRun } from './test-timing';

const RECORD = 'MANUSCRIPT_FRONTMATTER_UNUSED_KEYS_';

/** The Markdown import writes from export's document, after `edit`, as a co-author's in Word */
async function roundTrip(markdown: string, edit?: (zip: JSZip) => Promise<void>): Promise<string> {
  const { docx } = await convertMdToDocx(markdown);
  if (!edit) return (await convertDocx(docx)).markdown;
  const zip = await JSZip.loadAsync(docx);
  await edit(zip);
  return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
}

/** An edit of one of a document's parts */
function editPart(path: string, change: (xml: string) => string): (zip: JSZip) => Promise<void> {
  return async zip => {
    zip.file(path, change(await zip.file(path)!.async('string')));
  };
}

/** The values of the record's properties in custom.xml, in order, of the document export writes */
async function recordValues(markdown: string): Promise<string[]> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
  const custom = await zip.file('docProps/custom.xml')?.async('string') ?? '';
  return [...custom.matchAll(new RegExp('name="' + RECORD + '\\d+"><vt:lpwstr>([^<]*)<', 'g'))].map(match => match[1]);
}

const FULL = `---
title: A Study of Things
subtitle: "With a subtitle: and a colon"
date: 2024-05-01
author: Jane Doe
# Pandoc and Quarto keys
abstract: |
  First paragraph of the abstract.

  Second paragraph: with a colon,   spaces and a # sign.
description: >-
  Folded
  text
keywords:
  - one
  - "two, three"
lang: fr-CA
format:
  docx:
    toc: true # a table of contents
    reference-doc: 'custom.docx'
  html: default
execute:
  echo: false
crossref: {fig-prefix: Figure, eq-prefix: "Eq."}
empty:
quoted: 'it''s "here"'
unicode: Ünïcödé — 😀 中文
csl: apa
---

Body text.
`;

describe('frontmatter keys export reads nothing from, through Word', () => {
  it('come back as written, in their places among the keys import writes', async () => {
    expect(await roundTrip(FULL)).toBe(FULL);
  });

  it('come back as written again after a second trip, from the same record', async () => {
    const markdown = await roundTrip(FULL);
    expect(await roundTrip(markdown)).toBe(FULL);
    expect(await recordValues(markdown)).toEqual(await recordValues(FULL));
  });

  it.each([
    ['a key with an empty value', '---\nempty:\n---\n\nBody.\n'],
    ['a key alone, with no key export reads', '---\ndate: 2024\n---\nBody.\n'],
    ['blank lines and comments between keys', '---\ntitle: T\n\n# Dates\ndate: 2024\n\n\nlang: en # English\n# the end\n---\n\nBody.\n'],
    ['a literal value with its line ends kept', '---\nnocite: |+\n  @a, @b\n\nauthor: A\n---\n\nBody.\n'],
    ['a blank line after a key held, before a key import writes', '---\ndate: 2024\n\n\n# Title\ntitle: T\n---\n\nBody.\n', '---\ndate: 2024\n\n\ntitle: T\n---\n\nBody.\n'],
    ['a list of mappings', '---\ntitle: T\naffiliations:\n- id: 1\n  name: "Uni, Dept."\n- id: 2\n  name: Lab\n---\n\nBody.\n'],
    ['a key in quotes and a key of a name export reads in another case', '---\n"title": Quoted\nTitle: Cased\n---\n\nBody.\n'],
    ['tabs and spaces at line ends', '---\ndate: 2024\t \nformat:\n\tdocx: default\n---\n\nBody.\n'],
  ])('come back as written: %s', async (_, markdown, expected = markdown) => {
    expect(await roundTrip(markdown)).toBe(expected);
  });

  it('come back from a record of many properties, each short enough for Word to show and on one line', async () => {
    const markdown = '---\ntitle: T\nabstract: |\n' + Array.from({ length: 30 }, (_, k) => '  Line ' + k + ' of the abstract, — ünïcödé 😀😀😀.').join('\n') + '\n---\n\nBody.\n';
    const values = await recordValues(markdown);
    expect(values.length).toBeGreaterThan(5);
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(240);
      expect(value).not.toMatch(/[\r\n]/);
    }
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  it('show nowhere in Word but in the document\'s custom properties', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(FULL)).docx);
    const parts = Object.keys(zip.files).filter(path => !zip.files[path].dir);
    const holding: string[] = [];
    for (const path of parts) {
      const text = await zip.file(path)!.async('string');
      if (['fr-CA', 'Ünïcödé', 'reference-doc', 'Folded'].some(value => text.includes(value))) holding.push(path);
    }
    expect(holding).toEqual(['docProps/custom.xml']);
  });

  it('go back where they were among the keys import writes when Word removes one, without a blank line that would end the frontmatter', async () => {
    const markdown = '---\ntitle: T\n\ndate: 2024\nauthor: A\nlang: en\n---\n\nBody.\n';
    const removeTitle = editPart('word/document.xml', xml => xml.replace(/<w:p [^>]*><w:pPr><w:pStyle w:val="Title"\/><\/w:pPr><w:r><w:t>T<\/w:t><\/w:r><\/w:p>/, ''));
    expect(await roundTrip(markdown, removeTitle)).toBe('---\ndate: 2024\nauthor: A\nlang: en\n---\n\nBody.\n');
    const removeAuthor = editPart('docProps/core.xml', xml => xml.replace(/<dc:creator>A<\/dc:creator>\n?/, ''));
    expect(await roundTrip(markdown, removeAuthor)).toBe('---\ntitle: T\n\ndate: 2024\nlang: en\n---\n\nBody.\n');
    // Nor at its end, as export reads it without one there
    expect(await roundTrip('---\nlang: en\n\ntitle: T\n---\n\nBody.\n', removeTitle)).toBe('---\nlang: en\n---\n\nBody.\n');
  });

  it('take the values Word has for the keys import writes, with an edit in Word', async () => {
    const markdown = '---\ntitle: T\ndate: 2024\nauthor: A\nlang: en\n---\n\nBody.\n';
    const edit = async (zip: JSZip) => {
      await editPart('word/document.xml', xml => xml.replace('<w:t>T</w:t>', '<w:t>Edited title</w:t>'))(zip);
      await editPart('docProps/core.xml', xml => xml.replace('<dc:creator>A</dc:creator>', '<dc:creator>Bob</dc:creator>'))(zip);
    };
    expect(await roundTrip(markdown, edit)).toBe('---\ntitle: Edited title\ndate: 2024\nauthor: Bob\nlang: en\n---\n\nBody.\n');
  });

  it('go before a key added in Word, which goes after the keys there were, as without them', async () => {
    const addTitle = editPart('word/document.xml', xml => xml.replace('<w:body>', '<w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>New</w:t></w:r></w:p>'));
    expect(await roundTrip('---\ndate: 2024\nauthor: A\nlang: en\n---\n\nBody.\n', addTitle))
      .toBe('---\ndate: 2024\nauthor: A\nlang: en\ntitle: New\n---\n\nBody.\n');
    expect(await roundTrip('---\nauthor: A\n---\n\nBody.\n', addTitle)).toBe('---\nauthor: A\ntitle: New\n---\n\nBody.\n');
  });

  it('are left out of a document without the record, as from Word or an earlier version', async () => {
    const markdown = '---\ntitle: T\ndate: 2024\nauthor: A\nformat:\n  docx: default\n---\n\nBody.\n';
    const dropRecord = editPart('docProps/custom.xml', xml => xml.replace(new RegExp('<property [^>]*name="' + RECORD + '\\d+">.*?</property>\\n?', 'g'), ''));
    expect(await roundTrip(markdown, dropRecord)).toBe('---\ntitle: T\nauthor: A\n---\n\nBody.\n');
    const dropProperties = async (zip: JSZip) => { zip.remove('docProps/custom.xml'); };
    expect(await roundTrip(markdown, dropProperties)).toBe(await roundTrip('---\ntitle: T\nauthor: A\n---\n\nBody.\n', dropProperties));
  });

  it('leave out an entry of a record export didn\'t write, with a line that would close the frontmatter', async () => {
    const tamper = editPart('docProps/custom.xml', xml => xml.replace('{"text":"date: 2024"}', '{"text":"date: 2024\\n---\\nlang: en"}'));
    expect(await roundTrip('---\ntitle: T\ndate: 2024\n---\n\nBody.\n', tamper)).toBe('---\ntitle: T\n---\n\nBody.\n');
  });

  it('are no record of frontmatter with only keys export reads, nor of one it reads a setting from', async () => {
    for (const markdown of [
      '---\ntitle: T\n# A comment\nauthor: A\ncsl: apa\nnotes: sidenotes\n---\n\nBody.\n',
      '---\nauthor:\n  - name: Jane\n    affiliation: Uni\n---\n\nBody.\n',
      '---\nkeywords:\n  - name: x\n    font: Arial\n---\n\nBody.\n',
      '---\nmeta:\n  title:\n    - A\n---\n\nBody.\n',
    ]) {
      expect(await recordValues(markdown)).toEqual([]);
    }
    // Which export reads as before, with a setting of a known key's name
    // under it, and import writes that setting
    expect(await roundTrip('---\nkeywords:\n  - name: x\n    font: Arial\n---\n\nBody.\n')).toBe('---\nfont: Arial\n---\n\nBody.\n');
  });
});

describe('frontmatterLayout', () => {
  it('names the keys parseFrontmatter reads and holds the rest as written, with the comments and blank lines before them', () => {
    expect(frontmatterLayout('---\n# T\ntitle: T\n\n# Dates\ndate: 2024\nyear: 2024\nauthor: A\n  more: x\nlang: en\n# end\n---\nBody'))
      .toEqual(['title', { text: '\n# Dates\ndate: 2024\nyear: 2024' }, 'author', { text: 'lang: en\n# end' }]);
  });

  it('holds the blank lines after a key held with it, and a comment with the key after it', () => {
    expect(frontmatterLayout('---\ndate: 1\n\n# c\ntitle: T\n \nauthor: A\n---\n')).toEqual([{ text: 'date: 1\n' }, 'title', 'author']);
  });

  it('names a key it reads as an alias, and once', () => {
    expect(frontmatterLayout('---\nbib: a.bib\ntitle: A\ndate: 1\ntitle: B\n---\n')).toEqual(['bib', 'title', { text: 'date: 1' }]);
  });

  it('names the keys it reads in a mapping under a key, which it doesn\'t hold', () => {
    expect(frontmatterLayout('---\ndate: 1\nmeta:\n  font: Arial\n  title: T\nlang: en\n---\n')).toEqual([{ text: 'date: 1' }, 'font', 'title', { text: 'lang: en' }]);
  });

  it('is undefined for frontmatter of keys it reads alone, or none', () => {
    for (const markdown of ['Body', '---\n---\n', '---\n# c\n---\n', '---\ntitle: T\n# c: x\n---\n', '---\n  title: T\n  date: 1\n---\n']) {
      expect(frontmatterLayout(markdown)).toBeUndefined();
    }
  });

  it('reads frontmatter of many keys and lines in linear time', () => {
    const shapes = [
      (n: number) => Array.from({ length: n }, (_, k) => 'key' + k + ': ' + k).join('\n'),
      (n: number) => Array.from({ length: n }, (_, k) => (k % 2 ? 'title: ' : 'date: ') + k).join('\n'),
      (n: number) => 'abstract: |\n' + '  a: line\n'.repeat(n),
      (n: number) => 'keywords:\n' + '  - a\n'.repeat(n),
      (n: number) => '# c\n\n'.repeat(n) + 'date: 1',
      (n: number) => 'format:\n' + '  docx:\n    toc: true\n'.repeat(n / 2),
    ];
    for (const shape of shapes) {
      const [small, large] = [16000, 64000].map(n => '---\n' + shape(n) + '\n---\n');
      const [smallTime, largeTime] = [fastestRun(() => frontmatterLayout(small)), fastestRun(() => frontmatterLayout(large))];
      expect(largeTime).toBeLessThan(2000);
      expect(largeTime).toBeLessThan(8 * smallTime + 100);
    }
  }, 60000);
});

describe('serializeFrontmatter with a layout', () => {
  it('writes the keys held in their places, and those it has values for by the layout\'s order', () => {
    expect(serializeFrontmatter({ title: ['T'], author: 'A' }, ['author', 'title'], [{ text: 'date: 1' }, 'title', { text: 'lang: en' }, 'author']))
      .toBe('---\ndate: 1\ntitle: T\nlang: en\nauthor: A\n---\n');
  });

  it('writes a key held first without the blank lines before it', () => {
    expect(serializeFrontmatter({ author: 'A' }, undefined, ['title', { text: '\n \n# c\ndate: 1' }, 'author'])).toBe('---\n# c\ndate: 1\nauthor: A\n---\n');
    expect(serializeFrontmatter({ title: ['T'] }, undefined, ['title', { text: '\n# c\ndate: 1' }])).toBe('---\ntitle: T\n\n# c\ndate: 1\n---\n');
  });

  it('writes as before without one', () => {
    expect(serializeFrontmatter({ title: ['T'], author: 'A' }, ['author', 'title'])).toBe('---\nauthor: A\ntitle: T\n---\n');
  });
});
