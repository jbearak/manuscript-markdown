import { describe, it, expect } from 'bun:test';
import { scanOrientationDirectives } from './orientation-scan';

describe('scanOrientationDirectives', () => {
  it('returns empty for matched pair', () => {
    const text = '<!-- landscape -->\nContent\n<!-- /landscape -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('detects unclosed open', () => {
    const text = 'Before\n\n<!-- landscape -->\n\nContent';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('unclosed');
    expect(findings[0].directiveName).toBe('landscape');
  });

  it('detects orphaned close', () => {
    const text = 'Before\n\n<!-- /portrait -->\n\nAfter';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('orphaned');
    expect(findings[0].directiveName).toBe('portrait');
  });

  it('detects nested same-name open', () => {
    const text = '<!-- landscape -->\nP1\n<!-- landscape -->\nP2\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('nested');
    expect(findings[0].directiveName).toBe('landscape');
    expect(findings[0].relatedName).toBe('landscape');
  });

  it('detects nested cross-type open (portrait inside landscape)', () => {
    // The scanner keeps the original opener on the stack for accurate diagnostics.
    // portrait is nested, /landscape still matches the original opener and pops cleanly.
    const text = '<!-- landscape -->\n<!-- portrait -->\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'nested', directiveName: 'portrait', relatedName: 'landscape' }),
    ]);
  });

  it('detects crossed close', () => {
    const text = '<!-- landscape -->\n<!-- /portrait -->\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'crossed', directiveName: 'portrait', relatedName: 'landscape' }),
    ]);
  });

  it('skips directives inside fenced code blocks', () => {
    const text = '```\n<!-- landscape -->\n```';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('skips directive-like comments inside raw HTML blocks', () => {
    const text = '<div>\n<!-- landscape -->\n</div>';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('returns correct byte offsets', () => {
    const text = 'abc\n<!-- landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].start).toBe(4);
    expect(findings[0].end).toBe(4 + '<!-- landscape -->'.length);
  });

  it('handles multiple independent pairs', () => {
    const text = '<!-- landscape -->\nA\n<!-- /landscape -->\n<!-- portrait -->\nB\n<!-- /portrait -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('ignores inline directives (non-standalone)', () => {
    const text = 'Text <!-- landscape --> more text';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('ignores 4-space indented directives (code block)', () => {
    const text = '    <!-- landscape -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('ignores tab-indented directives (code block)', () => {
    const text = '\t<!-- landscape -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('still detects 3-space indented directive', () => {
    const text = '   <!-- landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('unclosed');
  });

  it('still detects directive with trailing whitespace', () => {
    const text = '<!-- landscape -->   ';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('unclosed');
  });

  it.each([
    ['a carriage return alone', '\r'],
    ['a carriage return and a line feed', '\r\n'],
  ])('reads a directive on a line ended by %s as one', async (_name, end) => {
    // Its line went on to the next line feed, past the text after it, so
    // it was inline, and the close after it orphaned, though export, like
    // markdown-it, read the line's end there and the directive
    const text = 'A\n\n<!-- landscape -->' + end + 'B\n\n<!-- /landscape -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
    const { convertMdToDocx } = await import('./md-to-docx');
    expect((await convertMdToDocx(text)).warnings).toEqual([]);
  });

  it.each(['\r', '\r\n', '\n'])('reports a directive\'s line in export\'s warning after lines ended by %j', async (end) => {
    // A carriage return alone wasn't counted
    const { convertMdToDocx } = await import('./md-to-docx');
    const { warnings } = await convertMdToDocx('First' + end + 'Second' + end + '<!-- /landscape -->');
    expect(warnings.some(w => w.includes('near line 3'))).toBe(true);
  });

  it('enforces single active orientation', () => {
    // landscape open then portrait open — portrait is nested because landscape is active.
    // The scanner keeps the original opener (landscape), so /portrait is crossed
    // and /landscape pops cleanly. Only two diagnostics: nested + crossed.
    const text = '<!-- landscape -->\n<!-- portrait -->\n<!-- /portrait -->\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'nested', directiveName: 'portrait', relatedName: 'landscape' }),
      expect.objectContaining({ kind: 'crossed', directiveName: 'portrait', relatedName: 'landscape' }),
    ]);
  });
});
