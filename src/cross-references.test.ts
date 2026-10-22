import { afterAll, describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import * as fs from 'fs';
import JSZip from 'jszip';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { join } from 'path';
import { citationEnd, crossRefAt, isCitableKey, isCrossRefKey } from './citation-syntax';
import { convertDocx } from './converter';
import { convertMdToDocx, createMarkdownIt, parseMd, type MdRun } from './md-to-docx';
import { renderWithPlugin } from './test-helpers';
import { fastestRun, fastestRunAsync } from './test-timing';
import { crossRefCompletions, findCrossRefDefinition, findCrossRefProblems, getCrossRefCompletionContext, scanCrossRefLabels, scanCrossRefs } from './lsp/crossref-language';
import { getCompletionContextAtOffset, scanCitationUsages } from './lsp/citekey-language';

// A cross-reference to a figure or a table, as Quarto writes one: @fig-map
// or @tbl-rates, @Fig-map for its title capitalized, and [@fig-map], which
// reads as @fig-map. Export writes Word's REF field to the caption's
// bookmark, which shows its title and number, as Word's Cross-reference
// dialog writes one of "Only label and number"; import reads one back
// where it shows what the caption does; the preview shows its title and
// number, linked to it; the LSP completes, checks and finds the labels.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'cross-references-'));
writeFileSync(join(dir, 'map.png'), PNG);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIGURES = '\n\n![A map](map.png){#fig-map}\n\n![B](map.png){#fig-a--b}\n\n![C](map.png){#fig-under_}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n: Rates {#tbl-x}\n';

async function exported(md: string) {
  const { docx, warnings } = await convertMdToDocx(md, { sourceDir: dir });
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file('word/document.xml')!.async('string');
  const body = document.slice(document.indexOf('<w:body>'), document.indexOf('<w:sectPr'))
    .replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '<TABLE/>')
    .replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '<DRAWING/>')
    .replace(/ w14:paraId="[^"]*" w14:textId="[^"]*" w:rsidR="[^"]*" w:rsidRDefault="[^"]*"/g, '');
  const footnotes = await zip.file('word/footnotes.xml')?.async('string');
  return { docx, body, footnotes, warnings };
}

const imported = async (docx: Uint8Array) => (await convertDocx(docx)).markdown;
/** Markdown `md`, with the figures and the table it refers to, as it comes back, to the figures */
async function trip(md: string): Promise<string> {
  const back = await imported((await convertMdToDocx(md + FIGURES, { sourceDir: dir })).docx);
  return back.slice(0, back.indexOf('![A map]')).trimEnd();
}

/** A REF field to `bookmark`, showing `shown` */
function refField(bookmark: string, shown: string, switches = ' \\h', rPr = ''): string {
  return '<w:r>' + rPr + '<w:fldChar w:fldCharType="begin"/></w:r><w:r>' + rPr + '<w:instrText xml:space="preserve"> REF ' + bookmark + switches + ' </w:instrText></w:r><w:r>' + rPr + '<w:fldChar w:fldCharType="separate"/></w:r><w:r>' + rPr + '<w:t>' + shown + '</w:t></w:r><w:r>' + rPr + '<w:fldChar w:fldCharType="end"/></w:r>';
}

describe('exporting a cross-reference', () => {
  it('writes a REF field to the caption\'s bookmark, showing its title and number, in the reference\'s formatting', async () => {
    const { body, warnings } = await exported('See @fig-map, **[@tbl-x]** and @Fig-map.' + FIGURES);
    expect(warnings).toEqual([]);
    expect(body).toContain('<w:r><w:t xml:space="preserve">See </w:t></w:r>' + refField('fig_map', 'Figure 1') + '<w:r><w:t xml:space="preserve">, </w:t></w:r>');
    expect(body).toContain(refField('tbl_x', 'Table 1', ' \\h', '<w:rPr><w:b/></w:rPr>'));
    expect(body).toContain(refField('fig_map', 'Figure 1', ' \\h \\* FirstCap'));
    // The caption's bookmark covers its title and number
    expect(body).toContain('<w:bookmarkStart w:id="0" w:name="fig_map"/><w:r><w:t xml:space="preserve">Figure </w:t></w:r>');
  });

  it('refers to a figure after it, as to one before, by the document\'s order of figures', async () => {
    const { body } = await exported('![First](map.png){#fig-one}\n\nSee @fig-two and @fig-one.\n\n![Second](map.png){#fig-two}\n');
    expect(body).toContain(refField('fig_two', 'Figure 2'));
    expect(body).toContain(refField('fig_one', 'Figure 1'));
  });

  it('shows the frontmatter\'s title, capitalized for @Fig-', async () => {
    const { body } = await exported('---\ncrossref:\n  fig-title: fig.\n---\n\n@Fig-map and @fig-map.\n\n![A map](map.png){#fig-map}\n');
    expect(body).toContain(refField('fig_map', 'Fig. 1', ' \\h \\* FirstCap'));
    expect(body).toContain(refField('fig_map', 'fig. 1'));
  });

  it('writes a reference to a label no figure or table has as text, and warns', async () => {
    const { body, warnings } = await exported('See @fig-none and [@tbl-none].' + FIGURES);
    expect(body).toContain('<w:r><w:t>@fig-none</w:t></w:r>');
    expect(body).toContain('<w:r><w:t>[@tbl-none]</w:t></w:r>');
    expect(warnings).toEqual([
      'Cross-reference @fig-none has no figure or table labeled {#fig-none}, so Word gets it as text.',
      'Cross-reference @tbl-none has no figure or table labeled {#tbl-none}, so Word gets it as text.',
    ]);
  });

  it('writes a citation\'s brackets with a cross-reference among other text as text, and warns', async () => {
    const { body, warnings } = await exported('A [-@fig-map], [see @fig-map, p. 2] and [@a; @fig-map].' + FIGURES);
    expect(body).toContain('<w:r><w:t>[-@fig-map]</w:t></w:r>');
    expect(body).toContain('<w:r><w:t>[see @fig-map, p. 2]</w:t></w:r>');
    expect(body).toContain('<w:r><w:t>[@a; @fig-map]</w:t></w:r>');
    expect(body).not.toContain('REF ');
    expect(body).not.toContain('ZOTERO');
    expect(warnings).toContain('The citation [-@fig-map] has a cross-reference in it, which Word gets as text: a cross-reference is @fig-label or [@fig-label] alone, of a figure, or @tbl-label of a table.');
    expect(warnings).toHaveLength(3);
  });

  it('keeps an email address, an escaped @, code and a link\'s text as text', async () => {
    const { body, warnings } = await exported('Mail me@fig-map.org, \\@fig-map, `@fig-map`, [see @fig-map](https://x.org), a/@fig-map and x.@fig-map.' + FIGURES);
    expect(body).not.toContain('REF ');
    expect(warnings).toEqual([]);
  });

  it('reads a key as Pandoc does, to its last letter or digit, and a label after an opening mark', async () => {
    const { body } = await exported('(@fig-map). "@fig-map" @fig-map\'s, @fig-map: and @tbl-x.' + FIGURES);
    expect(body.match(/REF fig_map \\h/g)).toHaveLength(4);
    expect(body).toContain('REF tbl_x \\h');
  });

  it('writes a tracked one\'s field in the change, its instruction deleted in a deletion', async () => {
    const { body } = await exported('Added {++@fig-map++} and cut {--@tbl-x--}.' + FIGURES);
    expect(body).toMatch(/<w:ins [^>]*>(?:<w:r><w:fldChar w:fldCharType="begin"\/><\/w:r>)<w:r><w:instrText xml:space="preserve"> REF fig_map \\h <\/w:instrText><\/w:r>/);
    expect(body).toContain('<w:delInstrText xml:space="preserve"> REF tbl_x \\h </w:delInstrText>');
    expect(body).toContain('<w:delText>Table 1</w:delText>');
  });

  it('goes to the first of two figures labeled alike, and warns', async () => {
    const { body, warnings } = await exported('@fig-map\n\n![One](map.png){#fig-map}\n\n![Two](map.png){#fig-map}\n');
    expect(body).toContain(refField('fig_map', 'Figure 1'));
    expect(warnings).toContain('More than one figure or table is labeled {#fig-map}; its cross-references go to the first.');
  });

  it('writes one in a note, and one in a table\'s cell', async () => {
    const { body, footnotes } = await exported('Text.[^1]\n\n[^1]: See @fig-map.\n\n| h |\n|---|\n| @tbl-x |\n' + FIGURES);
    expect(footnotes).toContain(refField('fig_map', 'Figure 1'));
    expect(body).toContain('<TABLE/>');
    const { docx } = await exported('| h |\n|---|\n| @tbl-x |\n' + FIGURES);
    const document = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(document).toContain(' REF tbl_x \\h ');
  });

  it('writes one in a caption as its Markdown, which Word reads no field in, and warns', async () => {
    const { body, warnings } = await exported('![As @fig-map](map.png){#fig-b}' + FIGURES);
    expect(body).not.toContain('REF ');
    expect(warnings).toContain('The caption of figure {#fig-b} has a citation, a cross-reference, a note, a comment, a tracked change, a line break or an image, which Word gets as its Markdown, as text, in its caption.');
  });

  it('cites no key of a cross-reference\'s', () => {
    expect(isCrossRefKey('fig-map')).toBe(true);
    expect(isCrossRefKey('Tbl-x')).toBe(true);
    expect(isCrossRefKey('fig-')).toBe(false);
    expect(isCrossRefKey('figure')).toBe(false);
    expect(isCitableKey('fig-map')).toBe(false);
    expect(isCitableKey('smith2020')).toBe(true);
    const md = createMarkdownIt();
    const state = { src: '[@fig-map] [see @tbl-x] [@smith]', md, env: {} };
    expect(citationEnd(state, 0)).toBe(-1);
    expect(citationEnd(state, 11)).toBe(-1);
    expect(citationEnd(state, 24)).toBe(31);
    const runs = parseMd('[@fig-map] and [@smith]')[0].runs;
    expect(runs.map(run => run.type)).toEqual(['text', 'text', 'citation']);
    expect(runs[0].crossRef).toEqual({ key: 'fig-map', form: 'bracket' });
  });
});

describe('importing a cross-reference', () => {
  it.each([
    ['a bare one', 'See @fig-map, and @tbl-x.'],
    ['a capitalized one', '@Fig-map shows it.'],
    ['one in formatting', '**see @fig-map** and *@tbl-x* and <u>@fig-map</u>, ~~@fig-map~~, ==@fig-map==.'],
    ['one in tracked changes', 'Added {++@fig-map++}, cut {--@fig-map--} and {~~@fig-map~>@tbl-x~~}.'],
    ['one in a comment\'s range', '{==@fig-map==}{>>Which?<<} and {==see @tbl-x==}{>>Yes<<}.'],
    ['one in punctuation', 'See (@fig-map) and "@fig-map", @fig-map\'s, @fig-map: x.'],
    ['one whose label isn\'t a whole key, in brackets', 'See [@fig-a--b] and [@fig-under_].'],
    ['one in a list and a heading', '# On @tbl-x\n\n- item @fig-map'],
    ['one in a quote', '> Quote @fig-map here.'],
    ['one in a pipe table\'s cell', '| a | b |\n| --- | --- |\n| @fig-map | x [@fig-map]a |'],
    ['one in a grid table\'s cell', '+----------+-----+\n| a        | b   |\n+==========+=====+\n| @fig-map | x   |\n|          |     |\n| more     |     |\n+----------+-----+'],
    ['one in an HTML table\'s cell, which is text', '<table>\n  <tr>\n    <td>\n      <p>See @fig-map</p>\n    </td>\n  </tr>\n</table>'],
    ['an escaped @ and an email address', 'Not \\@fig-map, nor [\\@fig-map], nor a@fig-map.org.'],
    ['one in code and a link\'s text', '`@fig-map` and [link @fig-map](https://x.org).'],
    ['an unknown label and a citation\'s brackets with one', '@fig-none and [-@fig-map].'],
  ])('round trips %s', async (_name, md) => {
    expect(await trip(md)).toBe(md);
  });

  it('reads [@fig-map] back as @fig-map, and brackets one whose text would take its @', async () => {
    expect(await trip('See [@fig-map].')).toBe('See @fig-map.');
    expect(await trip('A word@fig-map is text.')).toBe('A word@fig-map is text.');
  });

  it('writes Word\'s REF field in a cell only an HTML table holds as its text, and one in another\'s as a reference', async () => {
    const md = '<table>\n  <tr>\n    <td colspan="2"><p>X</p></td>\n  </tr>\n  <tr>\n    <td><p>See Y</p></td>\n    <td><p>b</p></td>\n  </tr>\n</table>\n';
    const { docx } = await convertMdToDocx(md + FIGURES, { sourceDir: dir });
    const zip = await JSZip.loadAsync(docx);
    const document = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', document.replace('<w:r><w:t>X</w:t></w:r>', refField('fig_map', 'Figure 1')));
    const merged = await imported(await zip.generateAsync({ type: 'uint8array' }));
    expect(merged).toContain('<td colspan="2">\n      <p>Figure 1</p>');
    // A table that merges no cells is one that holds the reference
    const { docx: plain } = await convertMdToDocx('<table>\n  <tr>\n    <td><p>See Y</p></td>\n    <td><p>b</p></td>\n  </tr>\n</table>\n' + FIGURES, { sourceDir: dir });
    const plainZip = await JSZip.loadAsync(plain);
    const plainDocument = await plainZip.file('word/document.xml')!.async('string');
    plainZip.file('word/document.xml', plainDocument.replace('<w:r><w:t>See Y</w:t></w:r>', '<w:r><w:t xml:space="preserve">See </w:t></w:r>' + refField('fig_map', 'Figure 1')));
    const back = await imported(await plainZip.generateAsync({ type: 'uint8array' }));
    expect(back).toContain('| See @fig-map | b   |');
  });

  it('reads one in a note back', async () => {
    const back = await imported((await convertMdToDocx('Text.[^1]\n\n[^1]: See @fig-map and [@tbl-x].' + FIGURES, { sourceDir: dir })).docx);
    expect(back).toContain('[^1]: See @fig-map and @tbl-x.');
  });

  it('escapes Word\'s text that reads as a reference to a label the document has, but no other', async () => {
    const md = 'See @fig-map and @fig-none.' + FIGURES;
    const { docx } = await convertMdToDocx(md, { sourceDir: dir });
    // Word's text, with the field taken out
    const zip = await JSZip.loadAsync(docx);
    const document = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', document.replace(/<w:r><w:fldChar w:fldCharType="begin"\/><\/w:r>[\s\S]*?<w:fldChar w:fldCharType="end"\/><\/w:r>(?=<w:r><w:t xml:space="preserve"> and)/, '<w:r><w:t>@fig-map</w:t></w:r>'));
    const back = await imported(await zip.generateAsync({ type: 'uint8array' }));
    expect(back.slice(0, back.indexOf('\n'))).toBe('See \\@fig-map and @fig-none.');
  });

  it('leaves a REF field\'s result as text where it shows other than its caption\'s title and number', async () => {
    const { docx } = await convertMdToDocx('See @fig-map.' + FIGURES, { sourceDir: dir });
    const zip = await JSZip.loadAsync(docx);
    const document = await zip.file('word/document.xml')!.async('string');
    // As Word shows a field not updated since the figures moved
    zip.file('word/document.xml', document.replace('<w:t>Figure 1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/>', '<w:t>Figure 2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/>'));
    const back = await imported(await zip.generateAsync({ type: 'uint8array' }));
    expect(back.slice(0, back.indexOf('\n'))).toBe('See Figure 2.');
  });

  it('reads a REF field to a Word bookmark in the caption, as Word\'s dialog writes one, and its switches', async () => {
    const { docx } = await convertMdToDocx('See X and Y and Z.' + FIGURES, { sourceDir: dir });
    const zip = await JSZip.loadAsync(docx);
    let document = await zip.file('word/document.xml')!.async('string');
    // Word's own bookmark around the caption's title and number
    document = document.replace('<w:bookmarkStart w:id="0" w:name="fig_map"/>', '<w:bookmarkStart w:id="0" w:name="fig_map"/><w:bookmarkStart w:id="90" w:name="_Ref123456"/>')
      .replace('<w:bookmarkEnd w:id="0"/>', '<w:bookmarkEnd w:id="0"/><w:bookmarkEnd w:id="90"/>')
      .replace('<w:t>See X and Y and Z.</w:t></w:r>', '<w:t xml:space="preserve">See </w:t></w:r>' + refField('_Ref123456', 'Figure 1', ' \\h  \\* MERGEFORMAT')
        + '<w:r><w:t xml:space="preserve"> and </w:t></w:r>' + refField('_Ref123456', 'Figure 1', ' \\p \\h') + '<w:r><w:t xml:space="preserve"> and </w:t></w:r>' + refField('_REF123456', 'Figure 1', '') + '<w:r><w:t>.</w:t></w:r>');
    zip.file('word/document.xml', document);
    const back = await imported(await zip.generateAsync({ type: 'uint8array' }));
    // \p, which adds "above" or "below", isn't one
    expect(back.slice(0, back.indexOf('\n'))).toBe('See @fig-map and Figure 1 and @fig-map.');
  });
});

describe('previewing a cross-reference', () => {
  it('shows its title and number, linked to its figure or table', () => {
    const html = renderWithPlugin('See @fig-map, [@tbl-x], @Fig-map and @fig-none.' + FIGURES);
    expect(html).toContain('See <a href="#fig-map" class="manuscript-markdown-cross-reference">Figure 1</a>, <a href="#tbl-x" class="manuscript-markdown-cross-reference">Table 1</a>, <a href="#fig-map" class="manuscript-markdown-cross-reference">Figure 1</a> and <span class="mm-missing-value" title="No figure or table is labeled {#fig-none}">?@fig-none</span>.');
  });

  it('shows a citation\'s brackets with one among other text as text, and the frontmatter\'s title', () => {
    expect(renderWithPlugin('A [-@fig-map] b' + FIGURES)).toContain('<p>A [-@fig-map] b</p>');
    expect(renderWithPlugin('---\ncrossref:\n  fig-title: fig.\n---\n\n@Fig-map and @fig-map\n\n![A](map.png){#fig-map}\n')).toContain('>Fig. 1</a> and <a href="#fig-map" class="manuscript-markdown-cross-reference">fig. 1</a>');
  });

  it('reads them as export does', () => {
    const reads = (runs: MdRun[] | undefined): boolean => !!runs?.some(run => run.crossRef && run.crossRef.form !== 'literal' || reads(run.innerRuns));
    for (const md of ['Mail me@fig-map.org', '`@fig-map`', '[see @fig-map](https://x.org)', '\\@fig-map', 'x.@fig-map', '{++@fig-map++}', '==@fig-map==']) {
      const exportReads = reads(parseMd(md)[0].runs);
      expect(renderWithPlugin(md + FIGURES).includes('cross-reference')).toBe(exportReads);
    }
  });
});

describe('the LSP and cross-references', () => {
  const doc = '---\ntitle: "@fig-map"\n---\n\nSee @fig-map, [@tbl-x], @fig-none, [-@fig-map] and `@fig-code`.\n\n![A](map.png){#fig-map}\n\n![B](map.png){#fig-map width=50%}\n\n| a |\n|---|\n| 1 |\n\n: Rates {#tbl-x}\n';

  it('reads the labels and the references outside code and the frontmatter', () => {
    expect(scanCrossRefLabels(doc).map(label => label.label)).toEqual(['fig-map', 'fig-map', 'tbl-x']);
    expect(scanCrossRefs(doc).map(usage => [usage.form, usage.key, doc.slice(usage.start, usage.end)])).toEqual([
      ['bare', 'fig-map', '@fig-map'],
      ['bracket', 'tbl-x', '@tbl-x'],
      ['bare', 'fig-none', '@fig-none'],
      ['literal', '', '[-@fig-map]'],
    ]);
  });

  it('warns of a label no figure or table has, one more than one has, and a citation\'s brackets with one', () => {
    expect(findCrossRefProblems(doc).map(problem => [doc.slice(problem.start, problem.end), problem.message])).toEqual([
      ['@fig-none', 'No figure or table is labeled {#fig-none}, so Word gets @fig-none as text.'],
      ['[-@fig-map]', 'A cross-reference in a citation\'s brackets with other text, as [-@fig-x], [see @fig-x] or [@fig-a; @fig-b], is text in Word: write @fig-x or [@fig-x] alone.'],
      ['fig-map', 'Another figure or table is labeled {#fig-map} before this one; its cross-references go to the first.'],
    ]);
  });

  it('completes a label after an @ that can start a reference, capitalized after @Fig-', () => {
    const at = (text: string) => getCrossRefCompletionContext(text, text.length);
    const labels = (text: string) => { const context = at(doc + text); return context ? crossRefCompletions(doc + text, context) : undefined; };
    expect(labels('See @')).toEqual(['fig-map', 'tbl-x']);
    expect(labels('See @fig-')).toEqual(['fig-map']);
    expect(labels('See [@t')).toEqual(['tbl-x']);
    expect(labels('See @Fig-m')).toEqual(['Fig-map']);
    expect(labels('{++@fig')).toEqual(['fig-map']);
    expect(labels('me@fig-')).toBeUndefined();
    expect(labels('See @smith')).toBeUndefined();
  });

  it('finds a reference\'s figure', () => {
    const offset = doc.indexOf('@fig-map,') + 3;
    const definition = findCrossRefDefinition(doc, offset)!;
    expect(doc.slice(definition.start - 2, definition.end + 1)).toBe('{#fig-map}');
    expect(definition.start).toBe(doc.indexOf('{#fig-map}') + 2);
    expect(findCrossRefDefinition(doc, doc.indexOf('@fig-none') + 2)).toBeUndefined();
  });

  it('reads no citation key in a cross-reference, nor in brackets with one', () => {
    expect(scanCitationUsages('[@fig-map] [@smith; @tbl-x] [@jones]').map(usage => usage.key)).toEqual(['jones']);
    expect(getCompletionContextAtOffset('See @', 5)).toBeDefined();
  });
});

describe('the grammar and cross-references', () => {
  const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json'), 'utf-8'));
  const patterns = ['cross_reference', 'cross_reference_in_citation', 'cross_reference_bare']
    .map(name => grammar.repository[name] as { match: string; captures?: Record<string, { name?: string }> })
    .map(pattern => ({ regex: new RegExp(pattern.match, 'gdu'), captures: pattern.captures ?? {} }));
  const KEY_SCOPE = 'support.function.cross-reference.manuscript-markdown';

  /** The keys the grammar colors in `line`, as vscode-textmate scans its
   *  patterns: from where the last match ended, the earliest match, of
   *  the patterns in their order where they tie. A citation's brackets
   *  are no matter, as the grammar is injected into them before their own
   *  patterns, and begin none with a cross-reference's key in them. */
  const coloredKeys = (line: string): string[] => {
    const keys: string[] = [];
    for (let at = 0; at < line.length;) {
      let best: RegExpExecArray | null = null;
      let bestPattern: (typeof patterns)[number] | undefined;
      for (const pattern of patterns) {
        pattern.regex.lastIndex = at;
        const match = pattern.regex.exec(line);
        if (match && (!best || match.index < best.index)) {
          best = match;
          bestPattern = pattern;
        }
      }
      if (!best || !bestPattern) break;
      const key = Object.entries(bestPattern.captures).filter(([, capture]) => capture.name === KEY_SCOPE)
        .map(([group]) => best![Number(group)] ?? '').join('').replace(/^@/, '');
      if (key) keys.push(key);
      at = best.index + Math.max(best[0].length, 1);
    }
    return keys;
  };
  /** The keys export reads as references in `line` */
  const readKeys = (line: string): string[] => parseMd(line).flatMap(token => token.runs ?? [])
    .flatMap((run: MdRun) => run.crossRef && run.crossRef.form !== 'literal' ? [run.crossRef.key] : []);

  it.each([
    ['bare', 'See @fig-map and @Tbl-x.'],
    ['bracketed', 'See [@fig-a--b] and [@fig-map].'],
    ['after punctuation', '(@fig-map) "@tbl-x"'],
    ['an email address', 'me@fig-map.org'],
    ['a citation\'s brackets with one', '[-@fig-map] [see @tbl-x] [@a; @fig-b]'],
    ['a link\'s text', '[see @fig-map](https://x.org)'],
    ['a key as Pandoc reads one', '@fig-a.b. @fig-c-'],
    ['an escaped bracket', '\\[see @fig-map] \\[@tbl-x]'],
    ['a bracket with no key first', '[;@fig-map] [@a [@fig-b x]'],
  ])('colors a %s reference as export reads it', (_name, line) => {
    expect(coloredKeys(line)).toEqual(readKeys(line));
  });

  it('colors each reference of a line as export reads it', () => {
    // Not a backtick, as the grammar is injected in no code
    const piece = fc.constantFrom('@', '@fig-', '@Fig-', '@tbl-', 'fig-', '[', ']', ' ', 'a', 'B', '1', '-', '.', ';', ',', '_', '/', ':', 'x@', '-@', '\u00E9',
      '*', '(', ')', '\\', '!', '{', '}', '+', '=', '~', '<', '>', '#', '"');
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 12 }), pieces => {
        const line = pieces.join('');
        // A link's or a reference's brackets, which export reads by the
        // document's definitions and destinations, which the grammar can't,
        // and a citation, whose text the grammar is injected into too, as
        // into all text, which it can't tell from its own
        if (/\][([]/.test(line) || /^\s*\[[^\]]*\]:/.test(line) || parseMd(line).some(token => token.runs?.some(run => run.type === 'citation'))) return true;
        const colored = coloredKeys(line);
        const read = readKeys(line);
        if (JSON.stringify(colored) !== JSON.stringify(read)) throw new Error(JSON.stringify(line) + ' colored ' + JSON.stringify(colored) + ', not ' + JSON.stringify(read));
        return true;
      }),
      { numRuns: 3000 }
    );
  });
});

describe('cross-references in linear time', () => {
  it('reads many references, and brackets with one, in time linear in their length', () => {
    for (const unit of ['@fig-a ', '[@fig-a ', '[@a [@fig-a', '[@fig-a', '[see @fig-a ', '@fig-a-']) {
      const text = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + ']\n';
      const small = fastestRun(() => parseMd(text(16000)));
      const large = fastestRun(() => parseMd(text(64000)));
      expect(large).toBeLessThan(8 * small + 100);
      expect(large).toBeLessThan(4000);
      const smallPreview = fastestRun(() => renderWithPlugin(text(16000)));
      const largePreview = fastestRun(() => renderWithPlugin(text(64000)));
      expect(largePreview).toBeLessThan(8 * smallPreview + 100);
      expect(largePreview).toBeLessThan(6000);
      const smallLsp = fastestRun(() => findCrossRefProblems(text(16000)));
      const largeLsp = fastestRun(() => findCrossRefProblems(text(64000)));
      expect(largeLsp).toBeLessThan(8 * smallLsp + 100);
      expect(largeLsp).toBeLessThan(2000);
    }
  });

  it('finds a citation\'s end in a run of brackets in time linear in its length', () => {
    const md = createMarkdownIt();
    for (const unit of ['[@a ', '[@fig-a ', '[@a @fig-b ']) {
      const ends = (n: number) => {
        const state = { src: unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + ']', md, env: {} };
        for (let at = state.src.length - 1; at >= 0; at--) if (state.src[at] === '[') { citationEnd(state, at); crossRefAt(state, at); }
      };
      const small = fastestRun(() => ends(16000));
      const large = fastestRun(() => ends(64000));
      expect(large).toBeLessThan(8 * small + 100);
      expect(large).toBeLessThan(2000);
    }
  });

  it('exports and imports many references in time linear in their number', async () => {
    const doc = (n: number) => Array.from({ length: n }, (_, i) => 'See @fig-f' + i + ' and @fig-f' + (n - 1 - i) + '.\n\n![F](map.png){#fig-f' + i + '}\n').join('\n');
    const small = doc(50);
    const large = doc(200);
    const smallExport = await fastestRunAsync(() => convertMdToDocx(small, { sourceDir: dir }));
    const largeExport = await fastestRunAsync(() => convertMdToDocx(large, { sourceDir: dir }));
    expect(largeExport).toBeLessThan(8 * smallExport + 100);
    expect(largeExport).toBeLessThan(6000);
    const smallDocx = (await convertMdToDocx(small, { sourceDir: dir })).docx;
    const largeDocx = (await convertMdToDocx(large, { sourceDir: dir })).docx;
    const smallImport = await fastestRunAsync(() => convertDocx(smallDocx));
    const largeImport = await fastestRunAsync(() => convertDocx(largeDocx));
    expect(largeImport).toBeLessThan(8 * smallImport + 100);
    expect(largeImport).toBeLessThan(6000);
    expect((await convertDocx(largeDocx)).markdown).toContain('See @fig-f199 and @fig-f0.');
  });
});
