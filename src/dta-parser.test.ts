import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import JSZip from 'jszip';
import { MISSING, writeDta } from '@jbearak/dta-parser';
import { parseDta } from './dta-parser';
import { convertMdToDocx } from './md-to-docx';
import type { EmbedResolver } from './embed-preprocess';

const FIXTURE_PATH = join(__dirname, '..', 'test', 'fixtures', 'tables', 'embed.dta');
const FIXTURE_DATA = new Uint8Array(readFileSync(FIXTURE_PATH));

describe('parseDta', () => {
  it('returns an HTML table with variable names as default headers', () => {
    const html = parseDta(FIXTURE_DATA, { path: 'embed.dta' });
    expect(html).toContain('<table');
    expect(html).toContain('</table>');
    // Variable names should appear as headers
    expect(html).toContain('<th>Fruit</th>');
    expect(html).toContain('<th>Season</th>');
    expect(html).toContain('<th>Color</th>');
  });

  it('renders value labels for labeled values', () => {
    const html = parseDta(FIXTURE_DATA, { path: 'embed.dta' });
    // Season column should show value labels, not numeric codes
    expect(html).toContain('Autumn');
    expect(html).toContain('Summer');
    expect(html).toContain('Spring');
  });

  it('renders string values', () => {
    const html = parseDta(FIXTURE_DATA, { path: 'embed.dta' });
    expect(html).toContain('Apple');
    expect(html).toContain('Mango');
    expect(html).toContain('Strawberry');
    expect(html).toContain('Red');
    expect(html).toContain('Orange');
  });

  it('wraps missing values in mm-missing-value span', () => {
    const html = parseDta(FIXTURE_DATA, { path: 'embed.dta' });
    // The .a missing value in Season has label "Refused"
    expect(html).toContain('<span class="mm-missing-value">Refused</span>');
  });

  it('uses data rows as headers when headers=N is specified', () => {
    const html = parseDta(FIXTURE_DATA, { path: 'embed.dta', headers: 1 });
    // First data row ("Apple", "Autumn", "Red") becomes the header
    expect(html).toContain('<th>Apple</th>');
    expect(html).toContain('>Autumn</th>');
    expect(html).toContain('<th>Red</th>');
    // Variable names should NOT appear
    expect(html).not.toContain('<th>Fruit</th>');
    expect(html).not.toContain('<th>Season</th>');
    expect(html).not.toContain('<th>Color</th>');
  });

  it('applies display formats, each variable\'s own value labels, and missing codes', () => {
    const data = writeDta({
      valueLabels: {
        yn: new Map([[1, 'Yes'], [2, 'No']]),
        agree: new Map<number | typeof MISSING['.'], string>([[1, 'Agree'], [MISSING['.d'], "Don't know"]]),
      },
      variables: [
        { name: 'q1', type: 'byte', valueLabels: 'yn', values: [1, 2] },
        { name: 'q2', type: 'byte', valueLabels: 'agree', values: [1, MISSING['.d']] },
        { name: 'share', format: '%9.2f', values: [0.4567, MISSING['.b']] },
        { name: 'born', type: 'long', format: '%td', values: [22949, 0] },
        { name: 'note', type: 'strL', values: ['<b>&', ''] },
      ],
    });
    const html = parseDta(data, { path: 'data.dta' });
    expect(html).toContain('<td data-mm-kind="number" data-mm-raw="0.4567" data-mm-format="%9.2f">0.46</td>');
    expect(html).toContain('<span class="mm-missing-value">.b</span>');
    expect(html).toContain('<td data-mm-kind="date" data-mm-format="%td">2022-10-31</td>');
    expect(html).toContain('<td>&lt;b&gt;&amp;</td>');
    expect(html).toContain('<tr><td data-mm-kind="label">Yes</td><td data-mm-kind="label">Agree</td>');
    expect(html).toContain('<tr><td data-mm-kind="label">No</td><td data-mm-kind="missing"><span class="mm-missing-value">Don\'t know</span>');
  });

  it('shows %tc values by their mask', () => {
    const t = Date.UTC(2010, 0, 20, 15, 15, 30, 987) - Date.UTC(1960, 0, 1);
    const masks = [
      '%tcHH:MM:SS.sss', '%tcCCYY.NN.DD_HH:MM', '%tcMonth_dd,_CCYY_hh:MM_am', '%tcDay_Mon_DD_HH:MM:SS_CCYY',
      '%tc+hh+:+MM+A.M.', '%tcDAYNAME|', '%tcJJJ!h_q_WW_.s_.ss', '%-tcyy/nn/dd\\hH:mm:ss', '%tcHH:MM_Q', '%tCHH:MM',
    ];
    const data = writeDta({
      variables: [
        { name: 'tiny', type: 'double', format: masks[0], values: [1, 2, -1] },
        ...masks.slice(1).map((format, i) => ({ name: 'v' + i, type: 'double' as const, format, values: [t, t, t] })),
      ],
    });
    const html = parseDta(data, { path: 'clock.dta' });
    const cell = (format: string, display: string) =>
      '<td data-mm-kind="time" data-mm-format="' + format + '">' + display + '</td>';
    expect(html).toContain(cell(masks[0], '00:00:00.001') + cell(masks[1], '2010.01.20 15:15'));
    expect(html).toContain(cell(masks[0], '00:00:00.002'));
    // Truncated, not rounded, as Stata shows times.
    expect(html).toContain(cell(masks[0], '23:59:59.999'));
    expect(html).toContain(cell(masks[2], 'January 20, 2010 3:15 pm'));
    expect(html).toContain(cell(masks[3], 'Wed Jan 20 15:15:30 2010'));
    expect(html).toContain(cell(masks[4], '3:15P.M.'));
    // Not a mask code: the whole value shows as the library shows it.
    expect(html).toContain(cell(masks[5], '2010-01-20 15:15:30'));
    expect(html).toContain(cell(masks[6], '020h 1 03 .9 .98'));
    expect(html).toContain(cell(masks[7], '10/1/20\\15:15:30'));
    expect(html).toContain(cell(masks[8], '2010-01-20 15:15:30'));
    // %tC counts leap seconds, which a mask read as %tc would put some
    // seconds off, so it stays the library's.
    expect(html).toContain(cell(masks[9], '2010-01-20 15:15:30'));
  });

  // The manual lists hh as 0 to 12: midnight's hour is 0, noon's 12.
  it('shows the 12-hour clock as 0 to 12', () => {
    const hour = (h: number) => Date.UTC(2010, 0, 20, h, 5) - Date.UTC(1960, 0, 1);
    const data = writeDta({
      variables: [
        { name: 't', type: 'double', format: '%tchh:MM_am', values: [hour(0), hour(12), hour(13)] },
        { name: 'd', type: 'long', format: '%-td', values: [0, 0, 0] },
      ],
    });
    const html = parseDta(data, { path: 'clock.dta' });
    expect(html).toContain('>0:05 am</td>');
    expect(html).toContain('>12:05 pm</td>');
    expect(html).toContain('>1:05 pm</td>');
    expect(html).toContain('<td data-mm-kind="date" data-mm-format="%-td">1960-01-01</td>');
  });

  // Format-114 files name no encoding. R's foreign::write.dta writes
  // UTF-8 bytes; pandas to_stata(version=114) writes Latin-1.
  it('reads UTF-8 text in a pre-118 file as UTF-8', () => {
    const data = Uint8Array.from(Buffer.from(
      'cgIBAAEAAQAAAFdyaXR0ZW4gYnkgUi4gICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdjaXR5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJTdzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGNpdHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUXXDqWJlYw==',
      'base64'));
    const html = parseDta(data, { path: 'r.dta' });
    expect(html).toContain('<td>Québec</td>');
  });

  it('reads non-UTF-8 text in a pre-118 file as windows-1252', () => {
    const data = Uint8Array.from(Buffer.from(
      'cgIBAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADI0IE5vdiAyMDI2IDIxOjA0AAZjaXR5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJTZzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUXXpYmVjWvxyaWNo',
      'base64'));
    const html = parseDta(data, { path: 'pandas.dta' });
    expect(html).toContain('<td>Québec</td>');
    expect(html).toContain('<td>Zürich</td>');
  });

  // The cell is "CAFÉ" + U+00A0 + "BAR" in Latin-1, whose bytes C9 A0
  // also read as UTF-8 (U+0260). The data label "Marché" ends in a lone
  // E9, which UTF-8 can't read, so the file is windows-1252.
  it('counts the data label when choosing a pre-118 file\'s encoding', () => {
    const data = Uint8Array.from(Buffer.from(
      'cgIBAAEAAQAAAE1hcmNo6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADI1IE5vdiAyMDI2IDA2OjUwAAhzdG9yZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJThzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ0FGyaBCQVI=',
      'base64'));
    const html = parseDta(data, { path: 'pandas.dta' });
    expect(html).toContain('<td>CAFÉ BAR</td>');
  });

  // A format-114 file written as UTF-8, whose data label holds a U+FFFD
  // of its own (EF BF BD): valid UTF-8, not a byte UTF-8 couldn't read.
  it('reads a pre-118 UTF-8 file that holds a replacement character itself as UTF-8', () => {
    const data = Uint8Array.from(Buffer.from('cgIBAAEAAQAAAO+/vQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdjaXR5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJTdzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGNpdHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUXXDqWJlYw==', 'base64'));
    expect(parseDta(data, { path: 'label.dta' })).toContain('<td>Québec</td>');
  });

  // The same file with a characteristic too short to read. They are only
  // evidence of the encoding, so the table still reads.
  it('reads a pre-118 file whose characteristics are damaged', () => {
    const data = Uint8Array.from(Buffer.from('cgIBAAEAAQAAAFdyaXR0ZW4gYnkgUi4gICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdjaXR5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJTdzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGNpdHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAABRdcOpYmVj', 'base64'));
    expect(parseDta(data, { path: 'short.dta' })).toContain('<td>Québec</td>');
  });

  // A format-114 file with one strN variable `s` whose values are the
  // bytes given, each cut or NUL-padded to the width.
  function dta114(width: number, values: (string | number[])[]): Uint8Array {
    const bytes: number[] = [114, 2, 1, 0, 1, 0, values.length & 255, values.length >> 8, 0, 0];
    const field = (value: string | number[], length: number) => {
      const b = typeof value === 'string' ? [...Buffer.from(value, 'utf8')] : value;
      for (let i = 0; i < length; i++) bytes.push(i < b.length ? b[i] : 0);
    };
    field('', 81); field('', 18); // data label, timestamp
    bytes.push(width); field('s', 33); field('', 4); field('%' + width + 's', 49); field('', 33); field('', 81);
    field('', 5); // no characteristics
    for (const value of values) field(value, width);
    return Uint8Array.from(bytes);
  }

  // A writer that sizes str6 for "Montré" in characters but cuts its
  // bytes leaves the value ending in the first byte of é.
  it('reads a pre-118 UTF-8 file with a string cut mid-character as UTF-8', () => {
    const html = parseDta(dta114(6, ['Québec', 'Montréal']), { path: 'cut.dta' });
    expect(html).toContain('<td>Québe</td>');
    expect(html).toContain('<td>Montr</td>');
  });

  it('reads pre-118 UTF-8 strings cut inside 3- and 4-byte characters as UTF-8', () => {
    expect(parseDta(dta114(4, ['é', 'ab€']), { path: 'cut.dta' })).toContain('<td>ab</td>');
    expect(parseDta(dta114(5, ['é', 'ab\u{1F600}']), { path: 'cut.dta' })).toContain('<td>ab</td>');
  });

  it('keeps a U+FFFD the file holds next to a string cut mid-character', () => {
    const html = parseDta(dta114(6, ['Qu�b', 'Montréal']), { path: 'cut.dta' });
    expect(html).toContain('<td>Qu�b</td>');
    expect(html).toContain('<td>Montr</td>');
  });

  // Latin-1 "Café" fills its str4 and ends in E9, the start of a 3-byte
  // UTF-8 character: no whole UTF-8 character says the file is UTF-8.
  it('reads a pre-118 file whose only non-ASCII byte ends a full string as windows-1252', () => {
    expect(parseDta(dta114(4, [[0x43, 0x61, 0x66, 0xe9]]), { path: 'cafe.dta' })).toContain('<td>Café</td>');
  });

  it('reads a pre-118 file with a cut string and a byte UTF-8 can\'t read as windows-1252', () => {
    const html = parseDta(dta114(6, ['Québec', 'Montréal', [0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68]]), { path: 'cut.dta' });
    expect(html).toContain('<td>Zürich</td>');
  });

  // Only a value that fills its width can have been cut.
  it('reads a pre-118 file with a lone lead byte ending a short string as windows-1252', () => {
    const html = parseDta(dta114(8, ['Québec', [0x4d, 0x6f, 0x6e, 0x74, 0x72, 0xc3]]), { path: 'short.dta' });
    expect(html).toContain('<td>QuÃ©bec</td>');
    expect(html).toContain('<td>MontrÃ</td>');
  });

  it('rejects files exceeding the size limit', () => {
    const html = parseDta(FIXTURE_DATA, { path: 'embed.dta' }, 1);
    expect(html).toContain('exceeds maximum size');
  });

  it('exports missing values as plain text in DOCX (no styling artifacts)', async () => {
    const md = '---\ntitle: Test\n---\n\n<!-- embed: data.dta -->\n';
    const resolver: EmbedResolver = {
      readFile: () => FIXTURE_DATA,
      resolveRelative: (_base, rel) => rel,
    };
    const { docx } = await convertMdToDocx(md, { embedResolver: resolver, documentPath: '/doc/test.md' });
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    // "Refused" is the value label for the .a missing value
    expect(xml).toContain('Refused');
    // No mm-missing-value class or span artifacts in DOCX
    expect(xml).not.toContain('mm-missing-value');
  });
});
