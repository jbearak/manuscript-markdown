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
