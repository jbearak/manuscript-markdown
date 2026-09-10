import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';

for (const quoting of ['', '"', "'"]) {
  it('exports a table with spaces in its path, quoting=' + quoting, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manuscript table '));
    mkdirSync(join(dir, 'my data'));
    writeFileSync(join(dir, 'my data/some table.csv'), 'Name,Age\nAlice,30');
    try {
      const { docx } = await convertMdToDocx(
        '<!-- embed: ' + quoting + 'my data/some table.csv' + quoting + ' headers=1 -->',
        {
          documentPath: join(dir, 'paper.md'),
          embedResolver: {
            resolveRelative: (_base, relative) => join(dir, relative),
            readFile: absolute => readFileSync(absolute),
          },
        },
      );
      const zip = await JSZip.loadAsync(docx);
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml).toContain('<w:tbl>');
      expect(xml).toContain('<w:t>Alice</w:t>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('exports an image whose bare path contains spaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manuscript image '));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNl7BcQAAAABJRU5ErkJggg==', 'base64');
  mkdirSync(join(dir, 'my figures'));
  writeFileSync(join(dir, 'my figures/some image.png'), png);
  try {
    const { docx } = await convertMdToDocx('![description](my figures/some image.png)', { sourceDir: dir });
    const zip = await JSZip.loadAsync(docx);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:drawing>');
    const media = zip.file(/^word\/media\/.*\.png$/);
    expect(media).toHaveLength(1);
    expect(await media[0].async('nodebuffer')).toEqual(png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
