import { describe, test, expect } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';

// WordprocessingML lets a comment's w:commentReference alone mark it at a
// point, with no w:commentRangeStart or w:commentRangeEnd; import dropped
// such a comment, text and all.

/** `md` exported, with `edit` applied to `part`'s XML, imported */
async function roundTrip(md: string, edit: (xml: string) => string, part = 'word/document.xml'): Promise<string> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
  zip.file(part, edit(await zip.file(part)!.async('string')));
  return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
}

const noRanges = (xml: string) => xml.replace(/<w:commentRange(?:Start|End) w:id="\d+"\/>/g, '');

describe('comments marked by their reference alone', () => {
  for (const md of [
    'Body.{>>note<<}\n',
    'One {>>a<<}two{>>b<<} three.\n',
    '---\ntitle: T\n---\n\n{>>note<<}\n\nBody.\n',
  ]) {
    test('import keeps ' + JSON.stringify(md), async () => {
      expect(await roundTrip(md, noRanges)).toBe(md);
    });
  }

  test('keep their authors, dates and replies', async () => {
    const md = 'Body.{>>@alice (2024-01-15 14:30) | note\n  {>>@bob (2024-01-16 09:00) | reply<<}\n<<} More.\n';
    const ranged = await roundTrip(md, xml => xml);
    expect(ranged).toContain('@bob');
    expect(await roundTrip(md, noRanges)).toBe(ranged);
  });

  test('beside a comment with a range, each reads as its own', async () => {
    const md = '{==Marked==}{>>a<<} and here{>>b<<}.\n';
    const ranged = await roundTrip(md, xml => xml);
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const ids = [...xml.matchAll(/<w:commentReference w:id="(\d+)"\/>/g)].map(m => m[1]);
    expect(ids.length).toBe(2);
    const second = new RegExp('<w:commentRange(?:Start|End) w:id="' + ids[1] + '"/>', 'g');
    expect(await roundTrip(md, x => x.replace(second, ''))).toBe(ranged);
  });

  test('after the text before the reference in its run', async () => {
    const out = await roundTrip('Body.{>>note<<}\n', xml => noRanges(xml).replace(
      /<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr>(<w:commentReference w:id="\d+"\/>)<\/w:r>/,
      '<w:r><w:t>X</w:t>$1</w:r>'));
    expect(out).toBe('Body.X{>>note<<}\n');
  });

  /** 'One {>>first<<}two{>>second<<} three.' exported, with its two
   *  comments marked only by references in the run that `run` gives */
  const inOneRun = (run: (refs: string[]) => string) => roundTrip('One {>>first<<}two{>>second<<} three.\n', xml => {
    const refs = [...xml.matchAll(/<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr>(<w:commentReference w:id="\d+"\/>)<\/w:r>/g)];
    expect(refs).toHaveLength(2);
    // The paragraph's runs, from its first to its last, as `run`
    return xml.replace(/<w:r>.*<\/w:r>(?=<\/w:p>)/s, () => run(refs.map(m => m[1])));
  });

  test('before the text after the reference in its run', async () => {
    const out = await inOneRun(([a, b]) => '<w:r>' + a + '<w:t xml:space="preserve">BODY</w:t>' + b + '</w:r>');
    expect(out).toBe('{>>first<<}BODY{>>second<<}\n');
    expect(await roundTrip(out, xml => xml)).toBe(out);
  });

  test('between the texts its run has on each side of the reference', async () => {
    const out = await inOneRun(([a, b]) => '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">One </w:t>' + a
      + '<w:t>two</w:t>' + b + '<w:t xml:space="preserve"> three.</w:t></w:r>');
    expect(out).toBe('**One {>>first<<}two{>>second<<} three.**\n');
    expect(await roundTrip(out, xml => xml)).toBe(out);
  });

  test('after a hidden run it is in the middle of, which stays whole', async () => {
    // Export hides an HTML comment in one run, which import reads as one
    const md = 'A <!--draft text--> B{>>note<<}\n';
    const out = await roundTrip(md, xml => {
      const ref = xml.match(/<w:commentReference w:id="\d+"\/>/)![0];
      const hidden = /(<w:t>[^<]*draft )(text--&gt;<\/w:t>)/;
      expect(xml).toMatch(hidden);
      return xml.replace(/<w:commentRange(?:Start|End) w:id="\d+"\/>|<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="\d+"\/><\/w:r>/g, '')
        .replace(hidden, (_, before, after) => before + '</w:t>' + ref + '<w:t>' + after);
    });
    expect(out).toBe('A <!--draft text-->{>>note<<} B\n');
  });

  test('in a footnote', async () => {
    const md = 'Text.[^1]\n\n[^1]: Note.{>>c<<}\n';
    const ranged = await roundTrip(md, xml => xml, 'word/footnotes.xml');
    expect(ranged).toContain('{>>c<<}');
    expect(await roundTrip(md, noRanges, 'word/footnotes.xml')).toBe(ranged);
  });

  test('before, on and after a title, in a code block, on a section break and mid-run in one document, with a thread split', async () => {
    const md = '---\ntitle: TITLE\n---\n\n```r\nCODE\n```\n\nBODY\n\n'
      + ['first\n  {>>reply<<}\n', 'second', 'third', 'fourth', 'fifth'].map(c => '{==x==}{>>' + c + '<<}').join(' ') + '\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const comments = await zip.file('word/comments.xml')!.async('string');
    const ref = (text: string) => '<w:r><w:commentReference w:id="' + comments.match(new RegExp('<w:comment w:id="(\\d+)"(?:(?!</w:comment>).)*>' + text + '<', 's'))![1] + '"/></w:r>';
    const section = '<w:pPr><w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>';
    const xml = (await zip.file('word/document.xml')!.async('string'))
      .replace(/<w:commentRange(?:Start|End) w:id="\d+"\/>|<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="\d+"\/><\/w:r>/g, '')
      // Before the title, in an empty paragraph, the thread's reply in the code
      .replace('<w:body>', '<w:body><w:p>' + ref('first') + '</w:p>')
      .replace(/<w:t>TITLE<\/w:t><\/w:r>/, s => s + ref('second'))
      .replace(/<w:t>CODE<\/w:t><\/w:r>/, s => s + ref('reply') + ref('third'))
      // On a section break's paragraph after the code, and mid-run
      .replace(/<w:p\b[^>]*>(?=<w:r><w:t>BODY)/, s => '<w:p>' + section + ref('fourth') + '</w:p>' + s)
      .replace('<w:t>BODY</w:t>', '<w:t>BO</w:t>' + ref('fifth').slice(5, -6) + '<w:t>DY</w:t>');
    zip.file('word/document.xml', xml);
    const { markdown } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    expect(markdown).toStartWith('---\ntitle: TITLE\n---\n\n{>>first\n  {>>reply<<}\n<<}{>>second<<}\n\n```r\nCODE\n```\n\n{>>third<<}\n');
    expect(markdown).toContain('BO{>>fifth<<}DY');
    const order = ['first', 'reply', 'second', 'third', 'fourth', 'fifth'].map(c => markdown.indexOf('{>>' + c));
    expect(order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1]))).toBe(true);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  /** The XML with the comment's markers taken out and put back in the last
   *  cross-reference's result: its reference, or its range's start and end,
   *  each before the number (`before`) or after it */
  const inCrossReference = (where: { ref?: 'before' | 'after'; start?: 'before' | 'after'; end?: 'before' | 'after' }) => (xml: string) => {
    const ref = xml.match(/<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="\d+"\/><\/w:r>/)![0];
    const id = ref.match(/w:id="(\d+)"/)![1];
    const marks = { ref, start: '<w:commentRangeStart w:id="' + id + '"/>', end: '<w:commentRangeEnd w:id="' + id + '"/>' };
    const stripped = xml.replace(ref, '').replace(marks.start, '').replace(marks.end, '');
    const results = [...stripped.matchAll(/(<w:fldChar w:fldCharType="separate"\/><\/w:r>)(<w:r>(?:(?!<\/w:r>).)*<w:t>\d<\/w:t><\/w:r>)/g)];
    expect(results.length).toBeGreaterThan(0);
    const last = results[results.length - 1];
    const at = (side: 'before' | 'after') => (['start', 'end', 'ref'] as const).filter(k => where[k] === side).map(k => marks[k]).join('');
    return stripped.slice(0, last.index) + last[1] + at('before') + last[2] + at('after') + stripped.slice(last.index + last[0].length);
  };

  describe('in a cross-reference to a note, which Markdown writes whole', () => {
    const md = 'One[^1] two three[^1]{>>c<<}.\n\n[^1]: Note.\n';
    for (const side of ['before', 'after'] as const) {
      test('goes after the cross-reference, from ' + side + ' its number', async () => {
        const out = await roundTrip(md, inCrossReference({ ref: side }));
        expect(out).toBe(md);
        expect(await roundTrip(out, xml => xml)).toBe(out);
      });
    }

    test('with an empty range there, as a point', async () => {
      expect(await roundTrip(md, inCrossReference({ start: 'after', end: 'after', ref: 'after' }))).toBe(md);
    });

    test('while a range on its number still takes the cross-reference', async () => {
      expect(await roundTrip(md, inCrossReference({ start: 'before', end: 'after', ref: 'after' })))
        .toBe('One[^1] two three{==[^1]==}{>>c<<}.\n\n[^1]: Note.\n');
    });

    test('in a footnote', async () => {
      const notes = 'One[^1] two[^2].\n\n[^1]: Note.\n\n[^2]: See[^1]{>>c<<} more.\n';
      const out = await roundTrip(notes, inCrossReference({ ref: 'before' }), 'word/footnotes.xml');
      expect(out).toBe(notes);
      expect(await roundTrip(out, xml => xml)).toBe(out);
    });
  });

  test('in a citation\'s result, which Markdown writes whole, goes after the citation', async () => {
    const bibtex = '@article{a2020, author={Alpha, A}, title={A}, journal={J}, year={2020}}';
    const md = 'Text [@a2020]{>>c<<} more.\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md, { bibtex })).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const ref = xml.match(/<w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="\d+"\/><\/w:r>/)![0];
    const separate = '<w:fldChar w:fldCharType="separate"/></w:r>';
    expect(xml).toContain(separate + '<w:r><w:t>(Alpha, 2020)</w:t>');
    zip.file('word/document.xml', noRanges(xml).replace(ref, '').replace(separate, separate + ref));
    const { markdown } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    expect(markdown).toBe(md);
  });
});
