import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import JSZip from 'jszip';
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
