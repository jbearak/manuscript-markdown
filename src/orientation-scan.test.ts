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

  it('reads two directives on one line as one comment, as export does', () => {
    expect(scanOrientationDirectives('A\n\n<!-- /landscape --><!-- portrait -->\n\nB')).toEqual([]);
    // So the fences around it pair as though it weren't there
    const text = '<!-- landscape -->\nA\n<!-- /landscape --><!-- portrait -->\nB\n<!-- /landscape -->';
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

  describe('in a list item or a note', () => {
    // A list item can't hold a directive, so export drops one after its
    // text, and a note has no sections, so export ignores one in it. Each
    // paired with the directives around it, so that a pair in a list item
    // went unflagged, one alone was unclosed, and one in a note, indented as
    // code, went unseen.
    const kinds = (text: string) => scanOrientationDirectives(text).map(f => f.kind + ' ' + (f.close ? '/' : '') + f.directiveName + ' ' + text.slice(f.start, f.end));

    it.each([
      ['a pair', '- item\n\n  <!-- landscape -->\n\n  text\n\n  <!-- /landscape -->\n\nAfter', ['list-item landscape <!-- landscape -->', 'list-item /landscape <!-- /landscape -->']],
      ['an opener alone', '- item\n\n  <!-- landscape -->\n\nAfter', ['list-item landscape <!-- landscape -->']],
      ['an opener on the line after its text', '- item\n  <!-- landscape -->\n\nAfter', ['list-item landscape <!-- landscape -->']],
      ['an opener, closed outside the list', '- item\n\n  <!-- landscape -->\n\nAfter\n\n<!-- /landscape -->', ['list-item landscape <!-- landscape -->', 'orphaned landscape <!-- /landscape -->']],
      ['a close, opened outside the list', '<!-- landscape -->\n\n- item\n\n  <!-- /landscape -->\n\nAfter', ['list-item /landscape <!-- /landscape -->', 'unclosed landscape <!-- landscape -->']],
      ['an opener in a sublist', '- item\n  - sub\n\n    <!-- portrait -->\n\nAfter', ['list-item portrait <!-- portrait -->']],
      ['an opener in an ordered list', '1. item\n\n   <!-- landscape -->\n\nAfter', ['list-item landscape <!-- landscape -->']],
      // A comment, as a style fence, is the item's text, so one after it isn't
      ['an opener after a comment that is the item\'s text', '- <!-- style: Quote -->\n\n  <!-- landscape -->\n\nAfter', ['list-item landscape <!-- landscape -->']],
      ['an opener after an HTML block that is the item\'s text', '- <div>a</div>\n\n  <!-- landscape -->\n\nAfter', ['list-item landscape <!-- landscape -->']],
    ])('flags %s in a list item as dropped, as export does, and pairs it with none', async (_, text, expected) => {
      expect(kinds(text)).toEqual(expected);
      const { convertMdToDocx } = await import('./md-to-docx');
      const { warnings } = await convertMdToDocx(text);
      expect(warnings).toContain('HTML block inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.');
      expect(warnings.filter(w => w.startsWith('Unclosed') || w.startsWith('Orphaned'))).toHaveLength(expected.filter(k => /^(unclosed|orphaned)/.test(k)).length);
    });

    it.each([
      ['as the first block of a list item', '- <!-- landscape -->\n\nAfter'],
      ['as the first block of a list item, on the line after its marker', '-\n  <!-- landscape -->\n\nAfter'],
      ['in a quote', '> <!-- landscape -->\n>\n> q\n\nAfter'],
      ['in a quote in a list item', '- item\n\n  > <!-- landscape -->\n\nAfter'],
      // Export drops the block before it, which an item can't hold, so the
      // comment is the item's text, which the scan flagged as dropped
      ['after an HTML table that starts a sublist\'s item', '- a\n  - <table><tr><td>x</td></tr></table>\n\n    <!-- landscape -->\n\nAfter'],
      ['after an HTML table that starts a list item', '- <table><tr><td>x</td></tr></table>\n\n  <!-- landscape -->\n\nAfter'],
      ['after a <pre> without its end that starts a list item', '- <pre>\n  x\n\n  <!-- landscape -->\n\nAfter'],
      ['after fenced code that starts a list item', '- ```\n  x\n  ```\n\n  <!-- landscape -->\n\nAfter'],
      ['after a rule that starts a list item', '- ***\n\n  <!-- landscape -->\n\nAfter'],
    ])('flags none %s, which export keeps as a comment', async (_, text) => {
      expect(scanOrientationDirectives(text)).toEqual([]);
      const { convertMdToDocx } = await import('./md-to-docx');
      const { docx, warnings } = await convertMdToDocx(text);
      expect(warnings.filter(w => w.includes('landscape'))).toEqual([]);
      const JSZip = (await import('jszip')).default;
      expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).not.toContain('w:orient="landscape"');
    });

    // Export reads the Markdown after its block preprocessing, which writes
    // a grid table as a placeholder at the line's start, which ends a list
    // the table was indented in, so a fence after it is the document's. The
    // scan read the list going on, and flagged the fence as dropped, which
    // left its close orphaned
    const grid = '  +---+\n  | x |\n  +---+\n';
    it.each([
      ['a pair', '- a\n\n' + grid + '\n  <!-- landscape -->\n\nB.\n\n<!-- /landscape -->\n', [], 1],
      ['an opener alone', '- a\n\n' + grid + '\n  <!-- landscape -->\n\nB.\n', ['unclosed landscape <!-- landscape -->'], 0],
      ['an opener on the line after the table', '- a\n' + grid + '  <!-- landscape -->\n\nB.\n', ['unclosed landscape <!-- landscape -->'], 0],
    ])('reads %s after a grid table in a list item as the document\'s, as export does', async (_, text, expected, sections) => {
      expect(kinds(text)).toEqual(expected);
      const { convertMdToDocx } = await import('./md-to-docx');
      const { docx, warnings } = await convertMdToDocx(text);
      expect(warnings.filter(w => /landscape|list item/.test(w))).toEqual(expected.length ? ['Unclosed <!-- landscape --> (opened near line ' + (text.slice(0, text.indexOf('<!-- landscape')).split('\n').length) + ') \u2014 no matching <!-- /landscape --> found.'] : []);
      const JSZip = (await import('jszip')).default;
      expect((await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).match(/w:orient="landscape"/g)?.length ?? 0).toBe(sections);
    });

    it.each([
      ['a grid table', '+---+\n| x |\n+---+\n\nA.\n\n<!-- landscape -->\n\nB.\n', 7],
      ['a LaTeX environment with blank lines, which export collapses', '\\begin{equation}\nx\n\n\ny\n\\end{equation}\n\n<!-- landscape -->\n\nB.\n', 8],
      ['a quote ended without a blank line', '> q\nA.\n\n<!-- landscape -->\n\nB.\n', 4],
      ['a fence in a LaTeX environment after a blank line, which export collapses', 'A.\n\n\\begin{equation}\nx\n\n<!-- landscape -->\n\n\\end{equation}\n', 6],
    ])('gives the line of a fence after %s as it is in the Markdown', async (_, text, line) => {
      const [finding] = scanOrientationDirectives(text);
      expect(finding.kind).toBe('unclosed');
      expect(text.slice(finding.start, finding.end)).toBe('<!-- landscape -->');
      expect(text.slice(0, finding.start).split('\n').length).toBe(line);
    });

    it.each([
      ['a pair in its body', 'Text[^1]\n\n[^1]: Note.\n\n    <!-- landscape -->\n\n    More.\n\n    <!-- /landscape -->\n', ['note landscape <!-- landscape -->', 'note /landscape <!-- /landscape -->']],
      ['an opener on its first line', 'Text[^1]\n\n[^1]: <!-- landscape -->\n', ['note landscape <!-- landscape -->']],
      ['an opener indented with a tab', 'Text[^1]\n\n[^1]: Note.\n\n\t<!-- portrait -->\n', ['note portrait <!-- portrait -->']],
      ['an opener, with a pair in the body after it', 'Text[^1]\n\n[^1]: Note.\n\n    <!-- landscape -->\n\n<!-- landscape -->\n\nA\n\n<!-- /landscape -->\n', ['note landscape <!-- landscape -->']],
    ])('flags %s of a note as ignored, as export does, and pairs it with none', async (_, text, expected) => {
      expect(kinds(text)).toEqual(expected);
      const { convertMdToDocx } = await import('./md-to-docx');
      const { warnings } = await convertMdToDocx(text);
      expect(warnings).toContain('Orientation directive inside a note ignored (not supported). Move it outside the note for round-trip fidelity.');
    });

    it.each([
      ['an opener alone', 'Text[^1]\n\n[^1]: Note.\n\n    <!-- landscape -->\n'],
      ['an opener on its first line', 'Text[^1]\n\n[^1]: <!-- landscape -->\n'],
      ['a close alone', 'Text[^1]\n\n[^1]: Note.\n\n    <!-- /portrait -->\n'],
      ['an opener nested in another', 'Text[^1]\n\n[^1]: Note.\n\n    <!-- landscape -->\n\n    <!-- portrait -->\n'],
    ])('warns of %s in a note once, as ignored', async (_, text) => {
      // Export read the note's body as a document of its own, and warned of
      // an opener there as unclosed too, at a line of the note's
      const { convertMdToDocx } = await import('./md-to-docx');
      const { warnings } = await convertMdToDocx(text);
      expect(warnings).toEqual(['Orientation directive inside a note ignored (not supported). Move it outside the note for round-trip fidelity.']);
    });

    it('reads a note\'s indented code as code', () => {
      expect(scanOrientationDirectives('Text[^1]\n\n[^1]: Note.\n\n        <!-- landscape -->\n')).toEqual([]);
    });

    it('reads a definition-like line in fenced code as code', () => {
      expect(scanOrientationDirectives('```\n[^1]: <!-- landscape -->\n```\n')).toEqual([]);
    });

    it('reads a definition-like line in fenced code after a CriticMarkup span with a fence\'s marker as code, as export does', async () => {
      // The scan read the span's marker as a fence's, which the code's
      // opening one closed, so the line was a note's
      const text = '{++a\n```\nb++}\n\n```\n[^1]: <!-- landscape -->\n```\n\nText.\n';
      expect(scanOrientationDirectives(text)).toEqual([]);
      const { convertMdToDocx } = await import('./md-to-docx');
      expect((await convertMdToDocx(text)).warnings.filter(w => w.includes('landscape'))).toEqual([]);
    });
  });

  it.each([
    ['an insertion of two paragraphs', 'A\n\n{++B\n\n<!-- landscape -->\n\nC++}\n\nD', []],
    ['a comment of two paragraphs', 'A\n\n{>>B\n\n<!-- landscape -->\n\nC<<}\n\nD', []],
    ['a deletion of two paragraphs, with a close after it', 'A\n\n{--B\n\n<!-- landscape -->\n\nC--}\n\n<!-- /landscape -->\n\nD', ['orphaned']],
  ])('reads a directive on a line of its own in %s as its text, as export does', async (_, text, kinds) => {
    // Export reads the span's paragraphs as one, so the comment is no block
    // of its own, but the scan read it as an opener
    expect(scanOrientationDirectives(text).map(f => f.kind)).toEqual(kinds);
    const { convertMdToDocx } = await import('./md-to-docx');
    const { docx, warnings } = await convertMdToDocx(text);
    expect(warnings.filter(w => w.includes('landscape'))).toHaveLength(kinds.length);
    const JSZip = (await import('jszip')).default;
    expect(await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).not.toContain('</w:sectPr></w:pPr>');
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
