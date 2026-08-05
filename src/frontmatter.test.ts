import { describe, expect, it } from 'bun:test';
import { maskFrontmatter, parseFrontmatter, serializeFrontmatter } from './frontmatter';
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
