import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { parseBibtex } from './bibtex-parser';
import {
  BUNDLED_STYLES,
  BUNDLED_STYLE_LABELS,
  isCslAvailable,
  loadStyle,
  resolveCslCachePath,
  zoteroStyleIdForName,
  publicStyleNameForZoteroId,
} from './csl-loader';
import {
  createCiteprocEngine,
  renderBibliography,
  renderCitationText,
} from './md-to-docx-citations';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

const ZOTERO_PREFIX = 'http://www.zotero.org/styles/';
const LICENSE = 'http://creativecommons.org/licenses/by-sa/3.0/';

const REPRESENTATIVE_BIBTEX = `
@article{article2024,
  author = {Rivera, Ana and Chen, Bo},
  title = {Climate Signals in Coastal Systems},
  journal = {Journal of Synthetic Research},
  volume = {12},
  number = {3},
  pages = {101-119},
  year = {2024},
  doi = {10.1234/example.2024.1}
}

@book{book2021,
  author = {Morgan, Elise},
  title = {The Very Long History of Example Scholarship},
  publisher = {Example University Press},
  address = {Boston},
  edition = {2},
  year = {2021}
}

@misc{web2023,
  author = {{Example Research Council}},
  title = {Annual Evidence Review},
  publisher = {Example Research Council},
  year = {2023},
  url = {https://example.org/evidence}
}
`;

function normalizeEntry(entry: string): string {
  return entry.trim().replace(/\n\s*/g, '');
}

function renderStyle(style: string): { citation: string | undefined; entries: string[] } {
  const entries = parseBibtex(REPRESENTATIVE_BIBTEX);
  const engine = createCiteprocEngine(entries, style);
  expect(engine).toBeDefined();
  engine!.updateItems(['article2024', 'book2021', 'web2023']);
  return {
    citation: renderCitationText(engine!, ['article2024']),
    entries: renderBibliography(engine!)!.entries.map(normalizeEntry),
  };
}

describe('refreshed CSL metadata', () => {
  const cases = [
    {
      name: 'bmj',
      title: 'BMJ',
      updated: '2024-06-06T09:34:02+00:00',
      author: 'Sebastian Karcher',
    },
    {
      name: 'chicago-author-date',
      title: 'Chicago Manual of Style 18th edition (author-date)',
      updated: '2025-02-09T00:00:00+00:00',
      author: 'Andrew Dunning',
    },
    {
      name: 'chicago-notes-bibliography',
      title: 'Chicago Manual of Style 18th edition (notes and bibliography)',
      updated: '2025-02-09T00:00:00+00:00',
      author: 'Andrew Dunning',
    },
    {
      name: 'chicago-shortened-notes-bibliography',
      title: 'Chicago Manual of Style 18th edition (shortened notes and bibliography)',
      updated: '2025-02-09T00:00:00+00:00',
      author: 'Andrew Dunning',
    },
    {
      name: 'nature',
      title: 'Nature',
      updated: '2025-09-10T18:26:21+00:00',
      author: 'Michael Berkowitz',
    },
  ] as const;

  for (const style of cases) {
    test(`preserves pinned upstream metadata for ${style.name}`, () => {
      const xml = loadStyle(style.name);
      expect(xml).toContain('<title>' + style.title + '</title>');
      expect(xml).toContain('<id>' + ZOTERO_PREFIX + style.name + '</id>');
      expect(xml).toContain('<updated>' + style.updated + '</updated>');
      expect(xml).toContain('<rights license="' + LICENSE + '">');
      expect(xml).toContain('<name>' + style.author + '</name>');
    });
  }
});

describe('Chicago 18 compatibility aliases', () => {
  const cases = [
    {
      alias: 'chicago-fullnote-bibliography',
      canonical: 'chicago-notes-bibliography',
    },
    {
      alias: 'chicago-note-bibliography',
      canonical: 'chicago-shortened-notes-bibliography',
    },
  ] as const;

  test('shows canonical styles and hides legacy aliases', () => {
    for (const style of cases) {
      expect(BUNDLED_STYLES).toContain(style.canonical);
      expect(BUNDLED_STYLES).not.toContain(style.alias);
      expect(BUNDLED_STYLE_LABELS.has(style.canonical)).toBe(true);
      expect(BUNDLED_STYLE_LABELS.has(style.alias)).toBe(false);
    }
  });

  for (const style of cases) {
    test(`resolves ${style.alias} to ${style.canonical}`, () => {
      expect(isCslAvailable(style.alias)).toBe(true);
      expect(loadStyle(style.alias)).toBe(loadStyle(style.canonical));
      expect(resolveCslCachePath('/cache', style.alias).endsWith(style.canonical + '.csl')).toBe(true);
      expect(zoteroStyleIdForName(style.alias)).toBe(ZOTERO_PREFIX + style.canonical);
      expect(publicStyleNameForZoteroId(ZOTERO_PREFIX + style.alias)).toBe(style.canonical);
      expect(publicStyleNameForZoteroId(ZOTERO_PREFIX + style.canonical)).toBe(style.canonical);
    });

    test(`canonicalizes ${style.alias} through a DOCX round trip`, async () => {
      const markdown = '---\ncsl: ' + style.alias + '\n---\n\nCitation [@article2024].\n';
      const exported = await convertMdToDocx(markdown, { bibtex: REPRESENTATIVE_BIBTEX });
      expect(exported.warnings).toEqual([]);

      const zip = await JSZip.loadAsync(exported.docx);
      const customXml = await zip.file('docProps/custom.xml')!.async('string');
      expect(customXml).toContain(ZOTERO_PREFIX + style.canonical);
      expect(customXml).not.toContain(ZOTERO_PREFIX + style.alias);

      const imported = await convertDocx(exported.docx);
      expect(imported.markdown).toContain('csl: ' + style.canonical);
      expect(imported.markdown).not.toContain('csl: ' + style.alias);
    });
  }
});

describe('refreshed CSL rendering', () => {
  test('BMJ renders representative citations and bibliography entries', () => {
    const rendered = renderStyle('bmj');
    expect(rendered.citation).toBe('[1]');
    expect(rendered.entries).toEqual([
      '<div class="csl-entry"><div class="csl-left-margin">1 </div><div class="csl-right-inline">Rivera A, Chen B. Climate Signals in Coastal Systems. <i>Journal of Synthetic Research</i>. 2024;12:101–19. doi: 10.1234/example.2024.1</div></div>',
      '<div class="csl-entry"><div class="csl-left-margin">2 </div><div class="csl-right-inline">Morgan E. <i>The Very Long History of Example Scholarship</i>. 2nd edn. Boston: Example University Press 2021.</div></div>',
      '<div class="csl-entry"><div class="csl-left-margin">3 </div><div class="csl-right-inline">Example Research Council. Annual Evidence Review. 2023.</div></div>',
    ]);
  });

  test('Chicago author-date renders representative citations and bibliography entries', () => {
    const rendered = renderStyle('chicago-author-date');
    expect(rendered.citation).toBe('(Rivera and Chen 2024)');
    expect(rendered.entries).toEqual([
      '<div class="csl-entry">Example Research Council. 2023. “Annual Evidence Review.” Preprint, Example Research Council. https://example.org/evidence.</div>',
      '<div class="csl-entry">Morgan, Elise. 2021. <i>The Very Long History of Example Scholarship</i>. 2nd ed. Example University Press.</div>',
      '<div class="csl-entry">Rivera, Ana, and Bo Chen. 2024. “Climate Signals in Coastal Systems.” <i>Journal of Synthetic Research</i> 12 (3): 101–19. https://doi.org/10.1234/example.2024.1.</div>',
    ]);
  });

  test('Chicago notes renders full notes and bibliography entries', () => {
    const rendered = renderStyle('chicago-notes-bibliography');
    expect(rendered.citation).toBe('Ana Rivera and Bo Chen, “Climate Signals in Coastal Systems,” <i>Journal of Synthetic Research</i> 12, no. 3 (2024): 101–19, https://doi.org/10.1234/example.2024.1.');
    expect(rendered.entries).toEqual([
      '<div class="csl-entry">Example Research Council. “Annual Evidence Review.” Preprint, Example Research Council, 2023. https://example.org/evidence.</div>',
      '<div class="csl-entry">Morgan, Elise. <i>The Very Long History of Example Scholarship</i>. 2nd ed. Example University Press, 2021.</div>',
      '<div class="csl-entry">Rivera, Ana, and Bo Chen. “Climate Signals in Coastal Systems.” <i>Journal of Synthetic Research</i> 12, no. 3 (2024): 101–19. https://doi.org/10.1234/example.2024.1.</div>',
    ]);
  });

  test('Chicago shortened notes renders shortened notes and bibliography entries', () => {
    const rendered = renderStyle('chicago-shortened-notes-bibliography');
    expect(rendered.citation).toBe('Rivera and Chen, “Climate Signals in Coastal Systems.”');
    expect(rendered.entries).toEqual([
      '<div class="csl-entry">Example Research Council. “Annual Evidence Review.” Preprint, Example Research Council, 2023. https://example.org/evidence.</div>',
      '<div class="csl-entry">Morgan, Elise. <i>The Very Long History of Example Scholarship</i>. 2nd ed. Example University Press, 2021.</div>',
      '<div class="csl-entry">Rivera, Ana, and Bo Chen. “Climate Signals in Coastal Systems.” <i>Journal of Synthetic Research</i> 12, no. 3 (2024): 101–19. https://doi.org/10.1234/example.2024.1.</div>',
    ]);
  });

  test('Nature preserves the space after bibliography numbers', () => {
    const rendered = renderStyle('nature');
    expect(rendered.citation).toBe('<sup>1</sup>');
    expect(rendered.entries).toEqual([
      '<div class="csl-entry"><div class="csl-left-margin">1. </div><div class="csl-right-inline">Rivera, A. &#38; Chen, B. Climate Signals in Coastal Systems. <i>Journal of Synthetic Research</i> <b>12</b>, 101–119 (2024).</div></div>',
      '<div class="csl-entry"><div class="csl-left-margin">2. </div><div class="csl-right-inline">Morgan, E. <i>The Very Long History of Example Scholarship</i>. (Example University Press, Boston, 2021).</div></div>',
      '<div class="csl-entry"><div class="csl-left-margin">3. </div><div class="csl-right-inline">Example Research Council. Annual Evidence Review. Preprint at https://example.org/evidence (2023).</div></div>',
    ]);
  });
});
