import { describe, test, expect } from 'bun:test';
import JSZip from 'jszip';
import { convertDocx } from './converter';
import { convertMdToDocx } from './md-to-docx';
import { fastestRunAsync } from './test-timing';

// Which row of a Word table import reads as its header: with Header Row
// on (tblLook's firstRow), the first row, but not where the table's style
// sets nothing for it and the row isn't all bold, as in a table Word
// inserts, whose Table Grid shows the row as the rest

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** The tblLook Word writes for a table it inserts: its first row's and
 *  first column's parts on, and banded rows */
const WORD_LOOK = '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';
const LOOK_OFF = '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/>';

const BORDER = 'w:val="single" w:sz="4" w:space="0"';

/** A table style `id` based on `basedOn`, with `own` properties, and
 *  `part` in its part for the first row, where given */
const tableStyle = (id: string, basedOn: string, part?: string, own = '') => '<w:style w:type="table" w:styleId="' + id + '">'
  + '<w:name w:val="' + id + '"/><w:basedOn w:val="' + basedOn + '"/>' + own
  + (part === undefined ? '' : '<w:tblStylePr w:type="firstRow">' + part + '</w:tblStylePr>') + '</w:style>';

/** Word's own styles.xml, in part: Normal, Strong, a bold paragraph
 *  style, Table Normal, Table Grid, and Grid Table 4 Accent 1, whose first
 *  row's part is bold and white on blue, with a style based on it */
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + W_NS + '>'
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="BoldPara"><w:name w:val="Bold Para"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/><w:bCs/></w:rPr></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
  + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/>'
  + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => '<w:' + side + ' ' + BORDER + ' w:color="auto"/>').join('')
  + '</w:tblBorders></w:tblPr></w:style>'
  + '<w:style w:type="table" w:styleId="GridTable4-Accent1"><w:name w:val="Grid Table 4 Accent 1"/><w:basedOn w:val="TableNormal"/>'
  + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
  + '<w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblStyleColBandSize w:val="1"/><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => '<w:' + side + ' ' + BORDER + ' w:color="8EAADB"/>').join('')
  + '</w:tblBorders></w:tblPr>'
  + '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/><w:color w:val="FFFFFF" w:themeColor="background1"/></w:rPr>'
  + '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="4472C4" w:themeFill="accent1"/></w:tcPr></w:tblStylePr>'
  + '<w:tblStylePr w:type="firstCol"><w:rPr><w:b/><w:bCs/></w:rPr></w:tblStylePr>'
  + '<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>'
  + '</w:style>'
  + '<w:style w:type="table" w:styleId="MyGallery"><w:name w:val="My Gallery"/><w:basedOn w:val="GridTable4-Accent1"/></w:style>'
  // Parts for the first row that set something, whether it shows or not:
  // keeping the row with the next, left alignment in a table centered,
  // shading of the table, a border, and a border based on that turned off
  + tableStyle('KeepNext', 'TableGrid', '<w:pPr><w:keepNext/></w:pPr>')
  + tableStyle('LeftFirstRow', 'TableGrid', '<w:pPr><w:jc w:val="left"/></w:pPr>', '<w:pPr><w:jc w:val="center"/></w:pPr>')
  + tableStyle('TableShaded', 'TableGrid', '<w:tblPr><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:tblPr>')
  + tableStyle('Ruled', 'TableNormal', '<w:tcPr><w:tcBorders><w:bottom w:val="single" w:sz="12" w:space="0" w:color="auto"/></w:tcBorders></w:tcPr>')
  + tableStyle('Unruled', 'Ruled', '<w:tcPr><w:tcBorders><w:bottom w:val="nil"/></w:tcBorders></w:tcPr>')
  // Styles that set nothing for the first row: a part with empty
  // properties, and banded rows alone
  + tableStyle('EmptyPart', 'TableGrid', '<w:rPr/><w:tcPr></w:tcPr>')
  + tableStyle('Banded', 'TableGrid', undefined, '<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>')
  + '</w:styles>';

/** A run of `text`, with `rPr`'s properties */
const run = (text: string, rPr = '') => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + text + '</w:t></w:r>';
/** A cell of one paragraph of `runs`, in the paragraph style `pStyle` */
const cell = (runs: string, pStyle = '') => '<w:tc><w:tcPr><w:tcW w:w="4675" w:type="dxa"/></w:tcPr><w:p>'
  + (pStyle ? '<w:pPr><w:pStyle w:val="' + pStyle + '"/></w:pPr>' : '') + runs + '</w:p></w:tc>';
/** A row of `cells`, with `trPr`'s properties */
const row = (cells: string[], trPr = '') => '<w:tr>' + (trPr ? '<w:trPr>' + trPr + '</w:trPr>' : '') + cells.join('') + '</w:tr>';
/** A table of `rows`, in the style `style`, with the tblLook `look` */
const table = (rows: string[], style = 'TableGrid', look = WORD_LOOK) => '<w:tbl><w:tblPr>'
  + (style ? '<w:tblStyle w:val="' + style + '"/>' : '') + '<w:tblW w:w="0" w:type="auto"/>' + look + '</w:tblPr>'
  + '<w:tblGrid><w:gridCol w:w="4675"/><w:gridCol w:w="4675"/></w:tblGrid>' + rows.join('') + '</w:tbl>';

/** The body rows of each table here: Ann, 30 */
const BODY = row([cell(run('Ann')), cell(run('30'))]);

/** A Word document of `body`, with `styles`, Word's by default, and
 *  `footnotes` */
async function wordDocx(body: string, footnotes?: string, styles = STYLES): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document ' + W_NS + '><w:body>' + body + '</w:body></w:document>');
  zip.file('word/styles.xml', styles);
  if (footnotes) {
    zip.file('word/footnotes.xml', '<?xml version="1.0"?><w:footnotes ' + W_NS + '>'
      + '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
      + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
      + footnotes + '</w:footnotes>');
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** Markdown without its frontmatter */
const strip = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

/** The Markdown of a Word document's `body`, and of its round trip:
 *  Markdown to Word and back, which must be the same */
async function imported(body: string, footnotes?: string, styles = STYLES): Promise<string> {
  const md = (await convertDocx(await wordDocx(body, footnotes, styles))).markdown;
  const again = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
  expect(strip(again)).toBe(strip(md));
  return strip(md);
}

const HEADERLESS = '+------+-----+\n| Name | Age |\n+------+-----+\n| Ann  | 30  |\n+------+-----+';
const PIPE = '| Name | Age |\n| --- | --- |\n| Ann | 30 |';
const BOLD_HEADERLESS = '+----------+---------+\n| **Name** | **Age** |\n+----------+---------+\n| Ann      | 30      |\n+----------+---------+';

/** A first row of Name and Age, each a run with `rPr`, in `pStyle` */
const firstRow = (rPr = '', pStyle = '') => row([cell(run('Name', rPr), pStyle), cell(run('Age', rPr), pStyle)]);

describe('the header row of a Word table', () => {
  test('a Table Grid table with Header Row on and a plain first row has no header row', async () => {
    // Word's Insert Table: Table Grid's first row looks like the rest
    expect(await imported(table([firstRow(), BODY]))).toBe(HEADERLESS);
    // Nor a table of no style, or of a style that sets nothing for its first
    // row, or one whose part for it sets nothing
    expect(await imported(table([firstRow(), BODY], ''))).toBe(HEADERLESS);
    expect(await imported(table([firstRow(), BODY], 'Banded'))).toBe(HEADERLESS);
    expect(await imported(table([firstRow(), BODY], 'EmptyPart'))).toBe(HEADERLESS);
  });

  test('with Header Row off, a first row is a header only where Word repeats it, as before', async () => {
    expect(await imported(table([firstRow(), BODY], 'TableGrid', LOOK_OFF))).toBe(HEADERLESS);
    expect(await imported(table([firstRow(), BODY], '', ''))).toBe(HEADERLESS);
    // A tblLook of its bits alone, as Word 2007 writes it
    expect(await imported(table([firstRow(), BODY], 'TableGrid', '<w:tblLook w:val="04A0"/>'))).toBe(HEADERLESS);
    // In bold, or in a style that formats a first row, too
    expect(await imported(table([firstRow('<w:b/>'), BODY], 'TableGrid', LOOK_OFF))).toBe(BOLD_HEADERLESS);
    expect(await imported(table([firstRow('<w:b/>'), BODY], '', ''))).toBe(BOLD_HEADERLESS);
    expect(await imported(table([firstRow(), BODY], 'GridTable4-Accent1', LOOK_OFF))).toBe(HEADERLESS);
  });

  test('a first row in bold is a header, its bold dropped as for a header export writes', async () => {
    expect(await imported(table([firstRow('<w:b/>'), BODY]))).toBe(PIPE);
    expect(await imported(table([firstRow('<w:b/>'), BODY], ''))).toBe(PIPE);
  });

  test('a first row that may be bold, by any style or for complex scripts, is a header', async () => {
    expect(await imported(table([firstRow('<w:rStyle w:val="Strong"/>'), BODY]))).toBe(PIPE);
    expect(await imported(table([firstRow('', 'BoldPara'), BODY]))).toBe(PIPE);
    // Bold for complex scripts alone, as Arabic's, and bold on with it off
    expect(await imported(table([firstRow('<w:bCs/>'), BODY]))).toBe(PIPE);
    expect(await imported(table([firstRow('<w:b/><w:bCs w:val="0"/>'), BODY]))).toBe(PIPE);
    // Bold a run turns off over its character style's, bold of a paragraph
    // style and a character style both, which Word turns off, and a
    // character style styles.xml doesn't have
    expect(await imported(table([firstRow('<w:rStyle w:val="Strong"/><w:b w:val="0"/><w:bCs w:val="0"/>'), BODY]))).toBe(PIPE);
    expect(await imported(table([firstRow('<w:rStyle w:val="Strong"/>', 'BoldPara'), BODY]))).toBe(PIPE);
    expect(await imported(table([firstRow('<w:rStyle w:val="Missing"/>'), BODY]))).toBe(PIPE);
  });

  test('a first row in bold but for whitespace, and empty cells, is a header', async () => {
    const header = row([cell(run('Na', '<w:b/>') + run(' ') + run('me', '<w:b/>')), cell(''), cell(run('Age', '<w:b/>'))]);
    const body = row([cell(run('Ann')), cell(''), cell(run('30'))]);
    expect(await imported(table([header, body]))).toBe('| Na me | | Age |\n| --- | --- | --- |\n| Ann | | 30 |');
  });

  test('a first row only partly in bold has no header row, and keeps its bold', async () => {
    const md = await imported(table([row([cell(run('Name', '<w:b/>')), cell(run('Age'))]), BODY]));
    expect(md).toBe('+----------+-----+\n| **Name** | Age |\n+----------+-----+\n| Ann      | 30  |\n+----------+-----+');
  });

  test('a first row of no text has no header row', async () => {
    const md = await imported(table([row([cell(''), cell('')]), BODY]));
    expect(md).not.toContain('===');
    expect(md).not.toContain('| --- |');
  });

  test('a style with a part for the first row makes it a header, whatever the part sets', async () => {
    // Grid Table 4 Accent 1, directly, through a style based on it, and as
    // the default table style of a table of no style of its own
    expect(await imported(table([firstRow(), BODY], 'GridTable4-Accent1'))).toBe(PIPE);
    expect(await imported(table([firstRow(), BODY], 'MyGallery'))).toBe(PIPE);
    const galleryDefault = STYLES.replace(' w:default="1" w:styleId="TableNormal"', ' w:styleId="TableNormal"')
      .replace('w:styleId="GridTable4-Accent1"', 'w:default="1" w:styleId="GridTable4-Accent1"');
    expect(await imported(table([firstRow(), BODY], ''), undefined, galleryDefault)).toBe(PIPE);
    // What Word shows apart or not, as before
    for (const style of ['KeepNext', 'LeftFirstRow', 'TableShaded', 'Ruled', 'Unruled']) {
      expect(await imported(table([firstRow(), BODY], style))).toBe(PIPE);
    }
  });

  test('a symbol and a non-breaking hyphen count for a first row in bold', async () => {
    // A symbol's run, or a hyphen's, not in bold, beside bold text, is a
    // body row, which the next export doesn't make bold
    const symbol = (char: string, rPr = '') => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:sym w:font="Symbol" w:char="' + char + '"/></w:r>';
    expect(await imported(table([row([cell(run('Name', '<w:b/>')), cell(symbol('F061'))]), BODY])))
      .toBe('+----------+-----+\n| **Name** | α   |\n+----------+-----+\n| Ann      | 30  |\n+----------+-----+');
    const hyphenated = (rPr: string) => cell(run('A', '<w:b/>') + '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:noBreakHyphen/></w:r>' + run('B', '<w:b/>'));
    expect(await imported(table([row([cell(run('Name', '<w:b/>')), hyphenated('')]), BODY])))
      .toBe('+----------+-------------+\n| **Name** | **A**‑**B** |\n+----------+-------------+\n| Ann      | 30          |\n+----------+-------------+');
    // A symbol of a font import can't read, which Word shows still
    expect(await imported(table([row([cell(run('Name', '<w:b/>')), cell('<w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r>')]), BODY])))
      .not.toContain('| --- |');
    // In bold, they're a header row's, as symbols alone are
    expect(await imported(table([row([cell(run('Name', '<w:b/>')), hyphenated('<w:b/>')]), BODY])))
      .toBe('| Name | A‑B |\n| --- | --- |\n| Ann | 30 |');
    expect(await imported(table([row([cell(symbol('F061', '<w:b/>')), cell(symbol('F062', '<w:b/>'))]), BODY])))
      .toBe('| α | β |\n| --- | --- |\n| Ann | 30 |');
  });

  test('a row Word repeats as a header is one', async () => {
    const repeated = row([cell(run('Name')), cell(run('Age'))], '<w:tblHeader/>');
    expect(await imported(table([repeated, BODY]))).toBe(PIPE);
    expect(await imported(table([repeated, BODY], 'TableGrid', LOOK_OFF))).toBe(PIPE);
  });

  test('a header row after a body row stays HTML, and a plain first row before it a body row', async () => {
    const md = await imported(table([firstRow(), row([cell(run('H')), cell(run('I'))], '<w:tblHeader/>'), BODY]));
    expect(md).toContain('<td>');
    expect(md).toContain('<th>');
    expect(md.indexOf('<td>')).toBeLessThan(md.indexOf('<th>'));
  });

  test('a note\'s table with a plain first row has no header row, and one in bold has', async () => {
    const note = (first: string) => '<w:footnote w:id="1"><w:p><w:r><w:t>Note.</w:t></w:r></w:p>' + table([first, BODY]) + '<w:p/></w:footnote>';
    const body = '<w:p><w:r><w:t>Text.</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>';
    const plain = await imported(body, note(firstRow()));
    expect(plain).toContain('    ' + HEADERLESS.split('\n').join('\n    '));
    const bold = await imported(body, note(firstRow('<w:b/>')));
    expect(bold).toContain('    ' + PIPE.split('\n').join('\n    '));
  });
});

describe('the header row of a table export wrote', () => {
  /** The Markdown of `md`'s round trip, and the XML of its export */
  const roundTrip = async (md: string) => {
    const docx = (await convertMdToDocx(md)).docx;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return { md: (await convertDocx(docx)).markdown, xml };
  };

  test('a grid table without a header row, its first row bold, stays as it is', async () => {
    const md = '+-------+-------+\n| **A** | **B** |\n+-------+-------+\n| 1     | 2     |\n+-------+-------+\n';
    const { md: back, xml } = await roundTrip(md);
    expect(back).toBe(md);
    // Export writes no tblLook and no header row
    expect(xml).not.toContain('w:tblLook');
    expect(xml).not.toContain('w:tblHeader');
  });

  test('a grid table without a header row writes its first row plain', async () => {
    const md = '+-----+-----+\n| A   | B   |\n+-----+-----+\n| 1   | 2   |\n+-----+-----+\n';
    const { md: back, xml } = await roundTrip(md);
    expect(back).toBe(md);
    expect(xml).not.toContain('w:tblLook');
    expect(xml).not.toContain('w:tblHeader');
    expect(xml).not.toContain('<w:b/>');
  });

  test('an HTML table without a header row, its first row bold, stays without one', async () => {
    const { md: back } = await roundTrip('<table>\n<tr><td><b>A</b></td><td><b>B</b></td></tr>\n<tr><td>1</td><td>2</td></tr>\n</table>\n');
    expect(back).not.toContain('<th');
    expect(back).toContain('<p><b>A</b></p>');
  });

  test('a pipe table\'s header stays its header, written repeating and bold', async () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const { md: back, xml } = await roundTrip(md);
    expect(back).toBe(md);
    expect(xml).toContain('<w:tblLook w:val="0020" w:firstRow="1"/>');
    expect(xml).toContain('<w:tblHeader/>');
  });

  test('a grid table\'s header stays its header', async () => {
    const md = '+-----+-----+\n| A   | B   |\n+=====+=====+\n| 1   | 2   |\n|     | 3   |\n+-----+-----+\n';
    expect((await roundTrip(md)).md).toBe(md);
  });

  test('a pipe table whose header Word stopped repeating stays a pipe table, by its bold', async () => {
    // With Header Row on, which export writes with the header, and the
    // bold export gives it
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:trPr><w:tblHeader/></w:trPr>');
    zip.file('word/document.xml', xml.replace('<w:trPr><w:tblHeader/></w:trPr>', ''));
    expect((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown).toBe(md);
  });
});

describe('the time to read a Word table\'s header row', () => {
  test('takes time in proportion to its first row\'s runs', async () => {
    // Each run of the first row is read once, for its text and its bold
    const time = async (runs: number) => {
      const first = row([cell(Array.from({ length: runs }, (_, k) => run('w' + k + ' ', '<w:rStyle w:val="Strong"/>')).join('')), cell(run('Age', '<w:b/>'))]);
      const docx = await wordDocx(table([first, BODY]));
      return fastestRunAsync(async () => convertDocx(docx));
    };
    await time(4000);
    const small = await time(16000);
    const large = await time(64000);
    expect(large).toBeLessThan(8 * small + 100);
    expect(large).toBeLessThan(20000);
  }, 120000);
});
