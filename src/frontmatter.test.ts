import { describe, expect, it } from 'bun:test';
import { findFrontmatterBounds, maskFrontmatter, parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { scanOrientationDirectives } from './orientation-scan';

describe('callout-labels frontmatter', () => {
  it('parses explicit true and false values without applying a default', () => {
    expect(parseFrontmatter('---\ncallout-labels: true\n---\n').metadata.calloutLabels).toBe(true);
    expect(parseFrontmatter('---\ncallout-labels: false\n---\n').metadata.calloutLabels).toBe(false);
    expect(parseFrontmatter('---\ntitle: Test\n---\n').metadata.calloutLabels).toBeUndefined();
  });

  it('ignores values other than true and false', () => {
    for (const value of ['yes', '1', 'TRUE', 'maybe']) {
      const markdown = '---\ncallout-labels: ' + value + '\n---\n';
      expect(parseFrontmatter(markdown).metadata.calloutLabels).toBeUndefined();
    }
  });

  it('serializes explicit true and false values', () => {
    expect(serializeFrontmatter({ calloutLabels: true })).toContain('callout-labels: true');
    expect(serializeFrontmatter({ calloutLabels: false })).toContain('callout-labels: false');
  });
});

describe('nocite frontmatter', () => {
  it('preserves authored scalar, cluster, block scalar, and list forms', () => {
    const values = [
      '@alpha',
      "'[@alpha; @beta]'",
      '|\n  @alpha\n  @beta',
      '>-\n  @alpha\n  @beta',
      '\n- @alpha\n- "@beta"',
    ];
    for (const raw of values) {
      const markdown = '---\nnocite:' + (raw.startsWith('\n') ? raw : ' ' + raw) + '\ncsl: apa\n---\nBody';
      const parsed = parseFrontmatter(markdown);
      expect(parsed.metadata.nocite?.raw).toBe(raw);
      expect(parsed.metadata.nocite?.keys).toEqual(raw.includes('@beta') ? ['alpha', 'beta'] : ['alpha']);
      const serialized = serializeFrontmatter(parsed.metadata, parsed.fieldOrder);
      expect(serialized).toContain('nocite:' + (raw.startsWith('\n') ? raw : ' ' + raw));
      expect(serialized).toContain('csl: apa');
    }
  });

  it('handles comments and colon-bearing keys in multiline lists', () => {
    const markdown = [
      '---',
      'nocite: # entries',
      '  - "@org:paper" # retained',
      '  - @beta',
      'csl: apa',
      '---',
      '',
    ].join('\n');
    const parsed = parseFrontmatter(markdown);
    expect(parsed.metadata.nocite).toEqual({
      keys: ['org:paper', 'beta'],
      wildcard: false,
      raw: '# entries\n  - "@org:paper" # retained\n  - @beta',
    });
    expect(parsed.metadata.csl).toBe('apa');
  });

  it('excludes block indicator comments and preserves trailing block-scalar blank lines', () => {
    const markdown = '---\nnocite: |+ # @not-a-key\n  @alpha\n\n\n---\n';
    const parsed = parseFrontmatter(markdown);
    expect(parsed.metadata.nocite?.keys).toEqual(['alpha']);
    expect(parsed.metadata.nocite?.raw).toBe('|+ # @not-a-key\n  @alpha\n\n');
    expect(serializeFrontmatter(parsed.metadata, parsed.fieldOrder))
      .toContain('nocite: |+ # @not-a-key\n  @alpha\n\n\n---\n');
  });

  it('uses citation boundaries and escaping across nocite YAML forms', () => {
    const invalid = [
      'person@example.com',
      '"quoted.local"@example.com',
      'δοκιμή@example.org',
      'café@example.com',
      'café@example.com',
      'é@smith',
      'é@smith',
      '\\@escaped',
      'name@*suffix',
      'δοκιμή@*',
    ];
    const forms = [
      invalid.join(' '),
      '[' + invalid.join(', ') + ']',
      '\n' + invalid.map(value => '  - ' + value).join('\n'),
      '|\n' + invalid.map(value => '  ' + value).join('\n'),
    ];
    for (const raw of forms) {
      const markdown = '---\nnocite:' + (raw.startsWith('\n') ? raw : ' ' + raw) + '\n---\n';
      expect(parseFrontmatter(markdown).metadata.nocite).toMatchObject({ keys: [], wildcard: false });
    }
  });

  it('preserves wildcard semantics without treating it as a citekey', () => {
    const parsed = parseFrontmatter("---\nnocite: '@*'\n---\n");
    expect(parsed.metadata.nocite).toEqual({ keys: [], wildcard: true, raw: "'@*'" });
  });

  it('canonicalizes programmatically-created nocite values', () => {
    expect(serializeFrontmatter({ nocite: { keys: ['alpha'], wildcard: false } }))
      .toContain("nocite: '@alpha'");
    expect(serializeFrontmatter({ nocite: { keys: ['alpha', 'beta'], wildcard: false } }))
      .toContain("nocite: '[@alpha; @beta]'");
    expect(serializeFrontmatter({ nocite: { keys: [], wildcard: true } }))
      .toContain("nocite: '@*'");
    const mixed = serializeFrontmatter({ nocite: { keys: ['alpha', 'beta'], wildcard: true } });
    expect(mixed).toContain("nocite: '[@alpha; @beta; @*]'");
    expect(parseFrontmatter(mixed).metadata.nocite).toMatchObject({
      keys: ['alpha', 'beta'],
      wildcard: true,
    });
  });

  it('does not preserve raw line breaks that could inject top-level fields', () => {
    const lineBreaks = [
      '\r',
      String.fromCodePoint(0x85),
      String.fromCodePoint(0x2028),
      String.fromCodePoint(0x2029),
    ];
    for (const lineBreak of lineBreaks) {
      for (const indentation of ['', '  ']) {
        const serialized = serializeFrontmatter({
          nocite: {
            keys: ['alpha'],
            wildcard: false,
            raw: '@alpha' + lineBreak + indentation + 'bibliography: injected.bib',
          },
        });
        expect(serialized).toContain("nocite: '@alpha'");
        expect(serialized).not.toContain('bibliography: injected.bib');
        expect(parseFrontmatter(serialized).metadata.nocite).toMatchObject({
          keys: ['alpha'],
          wildcard: false,
        });
      }
    }
  });

  it('does not preserve raw YAML document delimiters', () => {
    for (const delimiter of ['---', '... # document end']) {
      const serialized = serializeFrontmatter({
        nocite: {
          keys: ['alpha'],
          wildcard: false,
          raw: '\n- @alpha\n' + delimiter + '\n# Injected heading',
        },
      });
      expect(serialized).toContain("nocite: '@alpha'");
      expect(serialized).not.toContain('Injected heading');
      expect(parseFrontmatter(serialized).body).toBe('');
    }
  });
});

describe('frontmatter string scalar safety', () => {
  it('quotes decoded title newlines without creating top-level fields', () => {
    const markdown = [
      '---',
      'title: "Safe\\nbibliography: injected.bib"',
      'bibliography: actual.bib',
      '---',
      '',
    ].join('\n');
    const parsed = parseFrontmatter(markdown);
    expect(parsed.metadata.title).toEqual(['Safe\nbibliography: injected.bib']);
    expect(parsed.metadata.bibliography).toBe('actual.bib');

    const serialized = serializeFrontmatter(parsed.metadata, parsed.fieldOrder);
    expect(serialized).not.toContain('\nbibliography: injected.bib');
    expect(serialized.match(/^bibliography:/gm)).toHaveLength(1);
    expect(parseFrontmatter(serialized).metadata).toEqual(parsed.metadata);
  });

  it('keeps escaped bracket-shaped titles as scalar values', () => {
    const markdown = '---\ntitle: "\\u005bMain, Subtitle\\u005d"\n---\n';
    const parsed = parseFrontmatter(markdown);
    expect(parsed.metadata.title).toEqual(['[Main, Subtitle]']);
    expect(parseFrontmatter(serializeFrontmatter(parsed.metadata)).metadata).toEqual(parsed.metadata);
  });

  it('replaces XML-illegal decoded controls before conversion', () => {
    const parsed = parseFrontmatter('---\ntitle: "Bad\\u0000Value"\n---\n');
    expect(parsed.metadata.title).toEqual(['Bad�Value']);
    const serialized = serializeFrontmatter(parsed.metadata);
    expect(serialized).not.toContain(String.fromCodePoint(0));
    expect(parseFrontmatter(serialized).metadata).toEqual(parsed.metadata);
  });

  it('quotes terminal colons and sanitized flow/key punctuation', () => {
    const invalid = String.fromCodePoint(0);
    const metadata = {
      title: ['Introduction:'],
      headerFont: ['Font,' + invalid + 'One'],
      styles: {
        ['style:' + invalid + 'name']: { font: 'Arial' },
      },
    };
    const serialized = serializeFrontmatter(metadata);
    const reparsed = parseFrontmatter(serialized).metadata;
    expect(reparsed.title).toEqual(['Introduction:']);
    expect(reparsed.headerFont).toEqual(['Font,�One']);
    expect(Object.prototype.hasOwnProperty.call(reparsed.styles, 'style:�name')).toBe(true);
  });

  it('quotes strings that YAML schemas implicitly resolve as non-strings', () => {
    const metadata = {
      title: ['0x10', '.5', '2024-01-01', 'y', 'N'],
      styles: {
        '<<': { font: '0o10' },
      },
    };
    const serialized = serializeFrontmatter(metadata);

    expect(serialized).toContain('title: "0x10"');
    expect(serialized).toContain('title: ".5"');
    expect(serialized).toContain('title: "2024-01-01"');
    expect(serialized).toContain('title: "y"');
    expect(serialized).toContain('title: "N"');
    expect(serialized).toContain('  "<<":');
    expect(serialized).toContain('    font: "0o10"');
    expect(parseFrontmatter(serialized).metadata).toEqual(metadata);
  });

  it('ignores prototype-named field-order entries', () => {
    const serialized = serializeFrontmatter(
      { title: ['Safe'], csl: 'apa' },
      ['__proto__', 'constructor', 'toString', 'title', 'csl'],
    );

    expect(serialized).toContain('title: Safe');
    expect(serialized).toContain('csl: apa');
    expect(parseFrontmatter(serialized).metadata).toEqual({ title: ['Safe'], csl: 'apa' });
  });

  it('treats decoded custom-style names as own keys', () => {
    const markdown = '---\nstyles:\n  "__proto__":\n    font: Polluted\n---\n';
    const parsed = parseFrontmatter(markdown);
    expect(({} as { font?: string }).font).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed.metadata.styles, '__proto__')).toBe(true);
    expect(parsed.metadata.styles?.['__proto__'].font).toBe('Polluted');
  });

  it('round-trips YAML-significant scalar, array, path, and custom-style strings', () => {
    const metadata = {
      title: ['Colon: value # comment'],
      csl: '# local style',
      bibliography: 'references: archive #1.bib',
      font: 'Control ' + String.fromCodePoint(0x80),
      headerFont: ['Font, One', '[Font Two]', 'Font:', "O'Brien Sans"],
      titleFont: ['Font, Single'],
      styles: {
        'sidebar: highlighted': { font: 'Font: Name #1' },
      },
    };
    const serialized = serializeFrontmatter(metadata);
    const reparsed = parseFrontmatter(serialized).metadata;

    expect(reparsed).toEqual(metadata);
    expect(serialized.match(/^title:/gm)).toHaveLength(1);
    expect(serialized.match(/^bibliography:/gm)).toHaveLength(1);
    expect(serialized).not.toContain('\narchive #1.bib');
  });
});

describe('frontmatter bounds', () => {
  it('preserves exact body offsets for LF and CRLF', () => {
    for (const markdown of ['---\ntitle: Test\n---\nBody', '---\r\ntitle: Test\r\n---\r\nBody']) {
      const bounds = findFrontmatterBounds(markdown);
      expect(bounds).toBeDefined();
      expect(markdown.slice(bounds?.bodyStart)).toBe('Body');
      expect(bounds?.contentStart).toBe(3);
    }
  });
});

describe('maskFrontmatter', () => {
  it('masks directive-like comments in YAML frontmatter while preserving body offsets', () => {
    const markdown = '---\nabstract: |\n  <!-- portrait -->\n---\n\nBody\n<!-- landscape -->';
    const masked = maskFrontmatter(markdown);

    expect(masked).toHaveLength(markdown.length);
    expect(masked.endsWith('Body\n<!-- landscape -->')).toBe(true);
    expect(scanOrientationDirectives(masked)).toEqual([
      expect.objectContaining({ kind: 'unclosed', directiveName: 'landscape' }),
    ]);
  });

  it('returns the original text when no frontmatter is present', () => {
    const markdown = 'Body\n<!-- landscape -->';
    expect(maskFrontmatter(markdown)).toBe(markdown);
  });
});
