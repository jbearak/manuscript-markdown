import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import {
  attributeValue, captionBookmarkName, captionOptions, captionSeparator, captionSeparatorAt,
  captionSlug, delimiterOfSeparator, figureAttributesAt, isCaptionLabelId, labelOfBookmark, nextIndexFinder, parseAttributeBlock, quotedAttributeValue,
  seqIdentifier,
} from './captions';
import { parseFrontmatter, serializeFrontmatter, yamlScalar, yamlScalarText } from './frontmatter';

describe('caption labels', () => {
  it('reserves fig- and tbl- IDs, which no comment range starts', () => {
    expect(isCaptionLabelId('fig-map')).toBe(true);
    expect(isCaptionLabelId('tbl-est')).toBe(true);
    expect(isCaptionLabelId('fig-')).toBe(false);
    expect(isCaptionLabelId('figure')).toBe(false);
    expect(isCaptionLabelId('c1')).toBe(false);
    expect(isCaptionLabelId('Fig-map')).toBe(false);
  });
});

describe('parseAttributeBlock', () => {
  it('reads an ID, classes, bare values and values in quotes', () => {
    expect(parseAttributeBlock('#fig-map .wide width=640 fig-alt="A \\"map\\" &amp; more&#10;of it&#125;"')).toEqual({
      id: 'fig-map', classes: ['wide'], attributes: [['width', '640'], ['fig-alt', 'A "map" & more\nof it}']],
    });
  });

  it('reads none where a value in quotes is open, an ID repeats or text is no attribute', () => {
    expect(parseAttributeBlock('#fig-a fig-alt="open')).toBeUndefined();
    expect(parseAttributeBlock('#fig-a #fig-b')).toBeUndefined();
    expect(parseAttributeBlock('#fig-a and more')).toBeUndefined();
    expect(parseAttributeBlock('fig-alt="x"y')).toBeUndefined();
  });

  it('reads back each value quotedAttributeValue writes, as one block on one line', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), value => {
      const inner = '#fig-x fig-alt=' + quotedAttributeValue(value);
      const src = 'x{#fig-x}{' + inner + '} after}';
      const figure = figureAttributesAt(src, 9, src.length, nextIndexFinder(src));
      expect(figure?.end).toBe(src.length - 7);
      expect(figure?.label).toBe('fig-x');
      expect(figure && attributeValue(figure.block, 'fig-alt')).toBe(value);
    }), { numRuns: 500 });
  });
});

describe('figureAttributesAt', () => {
  it('reads a figure\'s block to its first }, with no { or line end in it', () => {
    const at = (src: string, pos = 0) => figureAttributesAt(src, pos, src.length, nextIndexFinder(src));
    expect(at('{#fig-map width=3in} more}')).toMatchObject({ label: 'fig-map', written: '#fig-map width=3in', end: 20 });
    expect(at('{#fig-map fig-alt="a}"}')).toBeUndefined();
    expect(at('{#fig-map fig-alt="{"}')).toBeUndefined();
    expect(at('{#fig-map\nwidth=3in}')).toBeUndefined();
    expect(at('{#tbl-map}')).toBeUndefined();
    expect(at('{#fig-map .wide #fig-b}')).toBeUndefined();
    expect(at('{#fig-ma*p}')).toBeUndefined();
  });

  it('finds each next character as indexOf does, over indices that grow or not', () => {
    fc.assert(fc.property(fc.stringMatching(/^[ab{}\n]{0,40}$/), fc.array(fc.tuple(fc.constantFrom('{', '}', '\n'), fc.nat(45)), { maxLength: 20 }), (src, asks) => {
      const next = nextIndexFinder(src);
      for (const [ch, from] of asks) expect(next(ch, from)).toBe(src.indexOf(ch, from));
    }), { numRuns: 500 });
  });
});

describe('caption separators', () => {
  it('writes the delimiter and a space, the delimiter alone where it ends in whitespace, and nothing with no text', () => {
    expect(captionSeparator(':', true)).toBe(': ');
    expect(captionSeparator('.', true)).toBe('. ');
    expect(captionSeparator('', true)).toBe(' ');
    expect(captionSeparator('.\t', true)).toBe('.\t');
    expect(captionSeparator(':', false)).toBe('');
  });

  it('reads back the delimiter of each separator it writes', () => {
    for (const delim of [':', '.', '', ' —', '.\t', ' |', '\t']) {
      expect(delimiterOfSeparator(captionSeparator(delim, true))).toBe(delim);
    }
  });

  it('reads no delimiter from a separator none writes', () => {
    expect(delimiterOfSeparator('.')).toBeUndefined();
    expect(delimiterOfSeparator('')).toBeUndefined();
  });

  it('finds the separator Word captions use', () => {
    expect(captionSeparatorAt('. Rates')).toBe('. ');
    expect(captionSeparatorAt(': Rates')).toBe(': ');
    expect(captionSeparatorAt(' – Rates')).toBe(' – ');
    expect(captionSeparatorAt('\tRates')).toBe('\t');
    expect(captionSeparatorAt('Rates')).toBe('');
    // A space after that is the text's
    expect(captionSeparatorAt(':  Rates')).toBe(': ');
    expect(captionSeparatorAt('.\t Rates')).toBe('.\t');
  });
});

describe('SEQ identifiers', () => {
  it('names a caption\'s series from its title, as Word does', () => {
    expect(seqIdentifier('Figure')).toBe('Figure');
    expect(seqIdentifier('Fig.')).toBe('Fig');
    expect(seqIdentifier('Supplementary Figure')).toBe('Supplementary_Figure');
    expect(seqIdentifier('Abbildung')).toBe('Abbildung');
    expect(seqIdentifier('123')).toBe('Figure');
    expect(seqIdentifier('')).toBe('Figure');
  });
});

describe('caption bookmarks', () => {
  it('names a bookmark for each label, as Word can, and reads the label back', () => {
    const taken = new Set<string>();
    const names = ['fig-map', 'fig-rates-by-region', 'fig-a.b', 'fig-a_b', 'fig-MAP', 'fig-map'].map(label => captionBookmarkName(label, taken));
    expect(names).toEqual(['fig_map', 'fig_rates_by_region', 'fig_a_b', 'fig_a_b_2', 'fig_MAP_2', 'fig_map_3']);
    expect(labelOfBookmark('fig_map')).toBe('fig-map');
    expect(labelOfBookmark('fig_rates_by_region')).toBe('fig-rates-by-region');
    expect(labelOfBookmark('_Ref123')).toBeUndefined();
    expect(labelOfBookmark('Figure1')).toBeUndefined();
  });

  it('keeps each name to 40 characters, none twice, whatever their case', () => {
    fc.assert(fc.property(fc.array(fc.stringMatching(/^fig-[A-Za-z0-9_.-]{1,60}$/), { maxLength: 30 }), labels => {
      const taken = new Set<string>();
      const names = labels.map(label => captionBookmarkName(label, taken));
      for (const name of names) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
      expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    }), { numRuns: 300 });
  });
});

describe('captionSlug', () => {
  it('makes a label of a caption\'s first words', () => {
    expect(captionSlug('Child penalties by region, 2010–2020', 1)).toBe('fig-child-penalties-by-region-2010');
    expect(captionSlug('Évolution des taux', 2)).toBe('fig-evolution-des-taux');
    expect(captionSlug('', 3)).toBe('fig-3');
    expect(captionSlug('图表', 4)).toBe('fig-4');
    expect(captionSlug('Supercalifragilisticexpialidocious-and-more-words', 5)).toBe('fig-supercalifragilisticexpialidoc');
  });
});

describe('crossref frontmatter', () => {
  it('reads the crossref keys export reads, as YAML values, and fig-cap-location', () => {
    const { metadata, fieldOrder } = parseFrontmatter('---\ntitle: T\ncrossref:\n  fig-title: "Fig."\n  title-delim: \'.\'\n  fig-prefix: Figure # not read\n  labels:\n    fig-title: no\nfig-cap-location: top\n---\nBody\n');
    expect(metadata.crossref).toEqual({ figTitle: 'Fig.', titleDelim: '.' });
    expect(metadata.figCapLocation).toBe('top');
    expect(fieldOrder).toEqual(['title', 'crossref', 'fig-cap-location']);
  });

  it('reads the crossref keys past a comment, at any indentation, as YAML does', () => {
    expect(parseFrontmatter('---\ncrossref:\n# a comment\n  fig-title: Fig.\n# another\n  title-delim: "."\n# more\nfig-cap-location: top\n---\nBody\n').metadata)
      .toEqual({ crossref: { figTitle: 'Fig.', titleDelim: '.' }, figCapLocation: 'top' });
  });

  it('writes them back as it reads them', () => {
    for (const crossref of [{ figTitle: 'Fig.' }, { titleDelim: '.' }, { titleDelim: ' —' }, { figTitle: 'Supplementary Figure', tblTitle: 'Tab', titleDelim: '' }, { titleDelim: ':' }]) {
      const yaml = serializeFrontmatter({ crossref, figCapLocation: 'top' });
      expect(parseFrontmatter(yaml + '\n').metadata).toEqual({ crossref, figCapLocation: 'top' });
    }
    expect(serializeFrontmatter({ crossref: { figTitle: 'Fig.', titleDelim: '.' } })).toBe('---\ncrossref:\n  fig-title: Fig.\n  title-delim: "."\n---\n');
  });

  it('reads back each value yamlScalarText writes', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), value => {
      if (/[\n\r]/.test(value)) return;
      expect(yamlScalar(yamlScalarText(value))).toBe(value);
    }), { numRuns: 500 });
  });

  it('gives Quarto\'s defaults where the frontmatter sets none', () => {
    expect(captionOptions(undefined)).toEqual({ figTitle: 'Figure', tblTitle: 'Table', titleDelim: ':', figCapLocation: 'bottom' });
    expect(captionOptions(parseFrontmatter('---\ncrossref:\n  title-delim: "."\n---\n').metadata).titleDelim).toBe('.');
  });
});
