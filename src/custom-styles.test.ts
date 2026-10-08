import { describe, it, expect } from 'bun:test';
import {
  stylesXml,
  convertMdToDocx,
  parseMd,
  customStyleId,
} from './md-to-docx';
import { parseFrontmatter, serializeFrontmatter, type CustomStyleDef } from './frontmatter';
import { convertDocx } from './converter';
import { styleFence } from './style-fence';
import { renderWithPlugin } from './test-helpers';
import { fastestRun } from './test-timing';

// Helper: extract a <w:style ...styleId="X"...>...</w:style> block from styles XML
function extractStyleBlock(xml: string, styleId: string): string | null {
  const re = new RegExp(
    '<w:style\\b[^>]*\\bw:styleId="' + styleId + '"[^>]*>[\\s\\S]*?</w:style>'
  );
  const m = re.exec(xml);
  return m ? m[0] : null;
}

// ============================================================
// Group A: Frontmatter Parsing
// ============================================================
describe('Custom Styles — Frontmatter Parsing', () => {
  it('parses all custom style properties', () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '    font-size: 14',
      '    font-style: bold-italic-center',
      '    spacing-before: 12',
      '    spacing-after: 6',
      '    paragraph-indent: 0.3',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    expect(metadata.styles).toBeDefined();
    const def = metadata.styles!['pullquote'];
    expect(def.font).toBe('Georgia');
    expect(def.fontSize).toBe(14);
    expect(def.fontStyle).toBe('bold-italic-center');
    expect(def.spacingBefore).toBe(12);
    expect(def.spacingAfter).toBe(6);
    expect(def.paragraphIndent).toBe(0.3);
  });

  it('parses paragraph-indent: none for a custom style', () => {
    const md = [
      '---',
      'styles:',
      '  caption:',
      '    paragraph-indent: none',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    expect(metadata.styles).toBeDefined();
    expect(metadata.styles!['caption'].paragraphIndent).toBe('none');
  });

  it('parses multiple styles in one block', () => {
    const md = [
      '---',
      'styles:',
      '  style-a:',
      '    font: Arial',
      '  style-b:',
      '    font-size: 10',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    expect(metadata.styles).toBeDefined();
    expect(Object.keys(metadata.styles!)).toEqual(['style-a', 'style-b']);
    expect(metadata.styles!['style-a'].font).toBe('Arial');
    expect(metadata.styles!['style-b'].fontSize).toBe(10);
  });

  it('empty styles block → undefined', () => {
    const md = '---\nstyles:\n---\nHello';
    const { metadata } = parseFrontmatter(md);
    expect(metadata.styles).toBeUndefined();
  });

  it('unknown sub-properties are ignored', () => {
    const md = [
      '---',
      'styles:',
      '  test:',
      '    font: Courier',
      '    color: red',
      '    margin: 5',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    const def = metadata.styles!['test'];
    expect(def.font).toBe('Courier');
    // Unknown props should not appear on the object
    expect((def as any).color).toBeUndefined();
    expect((def as any).margin).toBeUndefined();
  });

  it('normalizes font-style to canonical order', () => {
    const md = [
      '---',
      'styles:',
      '  test:',
      '    font-style: center-bold-italic',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    expect(metadata.styles!['test'].fontStyle).toBe('bold-italic-center');
  });

  it('ignores invalid font-style values', () => {
    const md = [
      '---',
      'styles:',
      '  test:',
      '    font-style: bold-bogus',
      '    font: Arial',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    expect(metadata.styles!['test'].fontStyle).toBeUndefined();
    expect(metadata.styles!['test'].font).toBe('Arial');
  });

  it('serialize → re-parse round-trip preserves styles', () => {
    const original: import('./frontmatter').Frontmatter = {
      styles: {
        pullquote: { font: 'Georgia', fontSize: 14, fontStyle: 'bold-italic-center', spacingBefore: 12, spacingAfter: 6, paragraphIndent: 0.3 },
        sidebar: { font: 'Helvetica', fontSize: 10, paragraphIndent: 'none' },
      },
    };
    const serialized = serializeFrontmatter(original);
    const { metadata } = parseFrontmatter(serialized + '\nHello');
    expect(metadata.styles).toEqual(original.styles);
  });

  it('missing optional properties → undefined', () => {
    const md = [
      '---',
      'styles:',
      '  minimal:',
      '    font: Arial',
      '---',
      'Hello',
    ].join('\n');
    const { metadata } = parseFrontmatter(md);
    const def = metadata.styles!['minimal'];
    expect(def.font).toBe('Arial');
    expect(def.fontSize).toBeUndefined();
    expect(def.fontStyle).toBeUndefined();
    expect(def.spacingBefore).toBeUndefined();
    expect(def.spacingAfter).toBeUndefined();
    expect(def.paragraphIndent).toBeUndefined();
  });
});

// ============================================================
// Group B: customStyleId
// ============================================================
describe('Custom Styles — customStyleId', () => {
  it('hyphenated: my-heading → MsCustomMyHeading', () => {
    expect(customStyleId('my-heading')).toBe('MsCustomMyHeading');
  });

  it('underscored: my_heading → MsCustomMyHeading', () => {
    expect(customStyleId('my_heading')).toBe('MsCustomMyHeading');
  });

  it('spaces: my heading → MsCustomMyHeading', () => {
    expect(customStyleId('my heading')).toBe('MsCustomMyHeading');
  });

  it('single word: pullquote → MsCustomPullquote', () => {
    expect(customStyleId('pullquote')).toBe('MsCustomPullquote');
  });

  it('collision: my-heading and my_heading produce same ID', () => {
    expect(customStyleId('my-heading')).toBe(customStyleId('my_heading'));
  });
});

// ============================================================
// Group C: Sentinel Conversion in parseMd
// ============================================================
describe('Custom Styles — parseMd Sentinels', () => {
  it('<!-- style: X --> → customStyleOpen sentinel', () => {
    const tokens = parseMd('<!-- style: pullquote -->\n\nHello\n\n<!-- /style -->');
    const open = tokens.find(t => t.customStyleOpen);
    expect(open).toBeDefined();
    expect(open!.customStyleOpen).toBe('pullquote');
  });

  it('<!-- /style --> after open → customStyleClose sentinel', () => {
    const tokens = parseMd('<!-- style: pullquote -->\n\nHello\n\n<!-- /style -->');
    const close = tokens.find(t => t.customStyleClose);
    expect(close).toBeDefined();
    expect(close!.customStyleClose).toBe(true);
  });

  it('stray <!-- /style --> without open → left as HTML comment', () => {
    const tokens = parseMd('<!-- /style -->');
    const close = tokens.find(t => t.customStyleClose);
    expect(close).toBeUndefined();
    // Should remain as a regular HTML comment run
    const htmlComment = tokens.find(t => t.runs.some(r => r.type === 'html_comment'));
    expect(htmlComment).toBeDefined();
  });

  it('style name with spaces → captured correctly', () => {
    const tokens = parseMd('<!-- style: My Custom Style -->\n\nHello\n\n<!-- /style -->');
    const open = tokens.find(t => t.customStyleOpen);
    expect(open).toBeDefined();
    expect(open!.customStyleOpen).toBe('My Custom Style');
  });

  it('single-line inline style → open + paragraph + close sentinels', () => {
    const tokens = parseMd('<!-- style: caption -->Table 1. Content<!-- /style -->');
    const open = tokens.find(t => t.customStyleOpen);
    expect(open).toBeDefined();
    expect(open!.customStyleOpen).toBe('caption');
    const close = tokens.find(t => t.customStyleClose);
    expect(close).toBeDefined();
    expect(close!.customStyleClose).toBe(true);
    // Content paragraph should be between sentinels
    const openIdx = tokens.indexOf(open!);
    const closeIdx = tokens.indexOf(close!);
    expect(closeIdx).toBe(openIdx + 2);
    const contentToken = tokens[openIdx + 1];
    expect(contentToken.type).toBe('paragraph');
    expect(contentToken.runs.some(r => r.type === 'text' && r.text.includes('Table 1. Content'))).toBe(true);
  });

  it('single-line inline style with formatted content preserves runs', () => {
    const tokens = parseMd('<!-- style: caption -->**Bold** and *italic*<!-- /style -->');
    const open = tokens.find(t => t.customStyleOpen);
    expect(open).toBeDefined();
    const openIdx = tokens.indexOf(open!);
    const contentToken = tokens[openIdx + 1];
    expect(contentToken.runs.some(r => r.bold && r.text === 'Bold')).toBe(true);
    expect(contentToken.runs.some(r => r.italic && r.text === 'italic')).toBe(true);
  });

  it('single-line inline style resolves a reference link with the document\'s definitions', () => {
    const tokens = parseMd('<!-- style: caption -->see [link][ref]<!-- /style -->\n\n[ref]: https://example.com');
    const contentToken = tokens[tokens.findIndex(t => t.customStyleOpen) + 1];
    expect(contentToken.runs.find(r => r.text === 'link')?.href).toBe('https://example.com');
  });

  it('multiple style blocks → correct sentinel sequence', () => {
    const md = [
      '<!-- style: alpha -->',
      '',
      'Para A',
      '',
      '<!-- /style -->',
      '',
      '<!-- style: beta -->',
      '',
      'Para B',
      '',
      '<!-- /style -->',
    ].join('\n');
    const tokens = parseMd(md);
    const opens = tokens.filter(t => t.customStyleOpen);
    const closes = tokens.filter(t => t.customStyleClose);
    expect(opens.length).toBe(2);
    expect(closes.length).toBe(2);
    expect(opens[0].customStyleOpen).toBe('alpha');
    expect(opens[1].customStyleOpen).toBe('beta');
  });

  it('reads a style block\'s fences with one function, in which no style\'s name holds -->', () => {
    expect(styleFence('  <!-- style: My Style -->\n')).toEqual({ kind: 'open', style: 'My Style' });
    expect(styleFence('<!-- /style -->')).toEqual({ kind: 'close' });
    expect(styleFence('<!-- style: box -->a<!-- /style -->')).toEqual({ kind: 'inline', style: 'box', content: 'a' });
    expect(styleFence('<!-- style: box --> a -->')).toBeUndefined();
    expect(styleFence('<!-- style: box -->a')).toBeUndefined();
    expect(styleFence('<!-- note -->')).toBeUndefined();
  });
});

// ============================================================
// Group D: OOXML Generation
// ============================================================
describe('Custom Styles — OOXML Generation', () => {
  function getStylesXmlWithCustom(customStyles: Record<string, CustomStyleDef>): string {
    return stylesXml(undefined, undefined, undefined, customStyles);
  }

  it('full properties: spacing, jc, rFonts, sz, b elements present', () => {
    const customStyles: Record<string, CustomStyleDef> = {
      pullquote: {
        font: 'Georgia',
        fontSize: 14,
        fontStyle: 'bold-center',
        spacingBefore: 12,
        spacingAfter: 6,
        paragraphIndent: 0.3,
      },
    };
    const xml = getStylesXmlWithCustom(customStyles);
    const block = extractStyleBlock(xml, 'MsCustomPullquote');
    expect(block).not.toBeNull();
    expect(block).toContain('w:before="240"');   // 12 * 20
    expect(block).toContain('w:after="120"');     // 6 * 20
    expect(block).toContain('<w:jc w:val="center"/>');
    expect(block).toContain('w:firstLine="432"');
    expect(block).toContain('w:ascii="Georgia"');
    expect(block).toContain('w:val="28"');        // 14 * 2
    expect(block).toContain('<w:b/>');
  });

  it('paragraph-indent: none emits explicit zero first-line indent', () => {
    const customStyles: Record<string, CustomStyleDef> = {
      caption: { paragraphIndent: 'none' },
    };
    const xml = getStylesXmlWithCustom(customStyles);
    const block = extractStyleBlock(xml, 'MsCustomCaption');
    expect(block).not.toBeNull();
    expect(block).toContain('w:firstLine="0"');
  });

  it('fontStyle: "normal" → no style flags', () => {
    const customStyles: Record<string, CustomStyleDef> = {
      plain: { fontStyle: 'normal' },
    };
    const xml = getStylesXmlWithCustom(customStyles);
    const block = extractStyleBlock(xml, 'MsCustomPlain');
    expect(block).not.toBeNull();
    expect(block).not.toContain('<w:b/>');
    expect(block).not.toContain('<w:i/>');
    expect(block).not.toContain('<w:smallCaps/>');
    expect(block).not.toContain('<w:caps/>');
  });

  it('fontStyle: "bold-smallcaps" → <w:b/> + <w:smallCaps/>', () => {
    const customStyles: Record<string, CustomStyleDef> = {
      fancy: { fontStyle: 'bold-smallcaps' },
    };
    const xml = getStylesXmlWithCustom(customStyles);
    const block = extractStyleBlock(xml, 'MsCustomFancy');
    expect(block).not.toBeNull();
    expect(block).toContain('<w:b/>');
    expect(block).toContain('<w:smallCaps/>');
    expect(block).not.toContain('<w:caps/>');
  });

  it('spacingBefore: 0 is omitted (default) but spacingAfter: 0 emits explicit zero', () => {
    const customStyles: Record<string, CustomStyleDef> = {
      tight: { spacingBefore: 0, spacingAfter: 0 },
    };
    const xml = getStylesXmlWithCustom(customStyles);
    const block = extractStyleBlock(xml, 'MsCustomTight');
    expect(block).not.toBeNull();
    // w:before="0" is the default — emitting it triggers Word dirty-flag (invariant #5)
    expect(block).not.toContain('w:before="0"');
    // w:after="0" must be emitted to override pPrDefault w:after="160"
    expect(block).toContain('w:after="0"');
  });

  it('collision dedup: two colliding names → only one style block', () => {
    const customStyles: Record<string, CustomStyleDef> = {
      'my-heading': { font: 'Arial' },
      'my_heading': { font: 'Times' },
    };
    const xml = getStylesXmlWithCustom(customStyles);
    // Both map to MsCustomMyHeading — the stylesXml function skips if already present
    const matches = xml.match(/w:styleId="MsCustomMyHeading"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});

// ============================================================
// Group E: Round-Trip MD → DOCX → MD
// ============================================================
describe('Custom Styles — Round-Trip', () => {
  it.each([
    ['indent', '720'],
    ['no-indent', '0'],
  ])('gives the paragraph of a style block on one line the %s of a directive before it', async (directive, firstLine) => {
    // Export skipped the block, a comment till its sentinels, as it does
    // comments, for the paragraph after it, so Word got the directive as a
    // hidden paragraph and the block's paragraph no indent of its own.
    // Import wrote the directive back before the block, which the next
    // export gave the paragraph, so Word's document changed, and the
    // directive came back in the block on the next trip
    const head = '---\nstyles:\n  box:\n    font-style: italic\n---\n\n';
    const JSZip = (await import('jszip')).default;
    const documentXml = async (docx: Uint8Array) => (await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string'))
      .replace(/ w(?:14)?:(?:paraId|textId|rsidR|rsidRDefault)="[^"]*"/g, '');
    const { docx } = await convertMdToDocx(head + '<!-- ' + directive + ' -->\n\n<!-- style: box -->p0<!-- /style -->\n');
    const xml = await documentXml(docx);
    expect(xml).toContain('<w:pPr><w:pStyle w:val="MsCustomBox"/><w:ind w:firstLine="' + firstLine + '"/></w:pPr><w:r><w:t>p0</w:t>');
    expect(xml).not.toContain(directive + ' --&gt;');
    // In the block, as import writes a directive before a paragraph in one
    const back = head + '<!-- style: box -->\n<!-- ' + directive + ' -->\np0\n<!-- /style -->\n';
    expect((await convertDocx(docx)).markdown).toBe(back);
    const again = await convertMdToDocx(back);
    expect(await documentXml(again.docx)).toBe(xml);
    expect((await convertDocx(again.docx)).markdown).toBe(back);
  });

  it('gives an indent directive before a style block on one line of comments alone to the paragraph after it', async () => {
    // Word shows nothing of the block's paragraph, which export doesn't
    // count among the paragraphs whose indent overrides it keeps, but it
    // gave the block the directive, so the paragraph after it kept the
    // indent of double spacing, and import lost the directive
    const head = '---\nline-spacing: double\nstyles:\n  box:\n    font-style: italic\n---\n\n';
    const JSZip = (await import('jszip')).default;
    const documentXml = async (docx: Uint8Array) => (await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string'))
      .replace(/ w(?:14)?:(?:paraId|textId|rsidR|rsidRDefault)="[^"]*"/g, '');
    const { docx } = await convertMdToDocx(head + 'x\n\n<!-- no-indent -->\n<!-- style: box --><!-- c --><!-- /style -->\n\np1\n');
    const xml = await documentXml(docx);
    expect(xml).toContain('<w:p><w:pPr><w:ind w:firstLine="720"/></w:pPr><w:r><w:t>x</w:t>');
    expect(xml).toContain('<w:p><w:r><w:t>p1</w:t>');
    const back = (await convertDocx(docx)).markdown;
    expect(back).toEndWith('<!-- /style -->\n\n<!-- no-indent -->\np1\n');
    const again = await convertMdToDocx(back);
    expect(await documentXml(again.docx)).toBe(xml);
    expect((await convertDocx(again.docx)).markdown).toBe(back);
  });

  it('parses many indent directives before a style block on one line in linear time', () => {
    // Four times as many take about four times as long, not sixteen. The
    // scan for each directive's paragraph parsed the block's text again,
    // and read each directive after it
    const md = (n: number) => '<!-- indent -->\n'.repeat(n) + '<!-- style: box -->' + '**b** '.repeat(n) + '<!-- /style -->\n';
    const [small, large] = [md(1000), md(4000)];
    expect(fastestRun(() => parseMd(large)) / fastestRun(() => parseMd(small))).toBeLessThan(8);
  }, 30000);

  it('single style wrapping one paragraph', async () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'Styled text here.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- style: pullquote -->');
    expect(result.markdown).toContain('Styled text here.');
    expect(result.markdown).toContain('<!-- /style -->');
  });

  it('one style wrapping multiple paragraphs', async () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'First paragraph.',
      '',
      'Second paragraph.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- style: pullquote -->');
    expect(result.markdown).toContain('First paragraph.');
    expect(result.markdown).toContain('Second paragraph.');
    expect(result.markdown).toContain('<!-- /style -->');
  });

  it('multiple different styles in same document', async () => {
    const md = [
      '---',
      'styles:',
      '  style-a:',
      '    font: Arial',
      '  style-b:',
      '    font: Courier',
      '---',
      '',
      '<!-- style: style-a -->',
      '',
      'Alpha text.',
      '',
      '<!-- /style -->',
      '',
      '<!-- style: style-b -->',
      '',
      'Beta text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    expect(result.markdown).toContain('<!-- style: style-a -->');
    expect(result.markdown).toContain('Alpha text.');
    expect(result.markdown).toContain('<!-- style: style-b -->');
    expect(result.markdown).toContain('Beta text.');
  });

  it('style with all properties → frontmatter preserved', async () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '    font-size: 14',
      '    font-style: bold-italic-center',
      '    spacing-before: 12',
      '    spacing-after: 6',
      '    paragraph-indent: 0.3',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'Styled text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata } = parseFrontmatter(result.markdown);
    expect(metadata.styles).toBeDefined();
    expect(metadata.styles!['pullquote']).toBeDefined();
    const def = metadata.styles!['pullquote'];
    expect(def.font).toBe('Georgia');
    expect(def.fontSize).toBe(14);
    expect(def.fontStyle).toContain('bold');
    expect(def.fontStyle).toContain('italic');
    expect(def.fontStyle).toContain('center');
    expect(def.spacingBefore).toBe(12);
    expect(def.spacingAfter).toBe(6);
    expect(def.paragraphIndent).toBe(0.3);
  });

  it('frontmatter styles deep-equal after round-trip', async () => {
    const originalStyles: Record<string, CustomStyleDef> = {
      sidebar: { font: 'Helvetica', fontSize: 10, spacingBefore: 8, spacingAfter: 4, paragraphIndent: 'none' },
    };
    const md = [
      serializeFrontmatter({ styles: originalStyles }),
      '',
      '<!-- style: sidebar -->',
      '',
      'Sidebar content.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata } = parseFrontmatter(result.markdown);
    expect(metadata.styles).toBeDefined();
    expect(metadata.styles!['sidebar']).toEqual(originalStyles['sidebar']);
  });

  it('falls back to styles.xml custom style extraction when custom properties are absent', async () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '    paragraph-indent: 0.3',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'Styled text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(docx);
    zip.remove('docProps/custom.xml');
    const stripped = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    const result = await convertDocx(stripped);
    const { metadata } = parseFrontmatter(result.markdown);
    expect(metadata.styles).toBeDefined();
    expect(metadata.styles!['pullquote']).toBeDefined();
    expect(metadata.styles!['pullquote'].font).toBe('Georgia');
    expect(metadata.styles!['pullquote'].paragraphIndent).toBe(0.3);
  });
});

describe('Custom Styles — List items', () => {
  const styled = '---\nstyles:\n  box:\n    font-style: italic\n---\n\n';
  const roundTrip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;

  it.each([
    ['an item after a list', '- a\n\n<!-- style: box -->\n- b\n<!-- /style -->\n'],
    ['an item and a paragraph after a list', '- a\n\n<!-- style: box -->\n- b\n\nstyled\n<!-- /style -->\n'],
    ['a list', '<!-- style: box -->\n- b\n- c\n<!-- /style -->\n'],
    ['a list after a paragraph', '<!-- style: box -->\nstyled\n\n- b\n<!-- /style -->\n'],
    ['a numbered item after a list', '1. a\n\n<!-- style: box -->\n2. b\n<!-- /style -->\n'],
    ['task items', '<!-- style: box -->\n- [ ] b\n- [x] c\n<!-- /style -->\n'],
    ['an item with a sublist, a paragraph and a quote', '<!-- style: box -->\n- b\n  - c\n\n  para\n\n  > q\n- d\n<!-- /style -->\n'],
    ['an item before more of its list', '- a\n\n<!-- style: box -->\n- b\n<!-- /style -->\n\n- c\n'],
    ['a list before a numbered list that starts over', '<!-- style: box -->\n1. b\n2. c\n<!-- /style -->\n\n1. d\n'],
    ['an item, after an item with a paragraph that isn\'t', '- a\n\n  para\n\n<!-- style: box -->\n- b\n<!-- /style -->\n'],
  ])('keeps %s in a style block', async (_name, body) => {
    // A list item took no style of the block's in Word, so import wrote it
    // out of the block, which went around the block's paragraphs alone
    const md = styled + body;
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  it('gives a list item in the block its style, under its numbering', async () => {
    const { docx } = await convertMdToDocx(styled + '<!-- style: box -->\n- b\n<!-- /style -->\n');
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toMatch(/<w:pPr><w:pStyle w:val="MsCustomBox"\/><w:numPr>(?:(?!<\/w:p>).)*<w:t>b<\/w:t>/);
  });

  it.each([
    ['a paragraph', '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n'],
    ['a paragraph, before the next item', '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n- b\n'],
    ['a paragraph, in a numbered item', '1. a\n\n   <!-- style: box -->\n   styled\n   <!-- /style -->\n'],
    ['two paragraphs', '- a\n\n  <!-- style: box -->\n  styled\n\n  more\n  <!-- /style -->\n'],
    ['a paragraph, before one that isn\'t', '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n\n  plain\n'],
    ['a paragraph, after one that isn\'t', '- a\n\n  plain\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n'],
    ['a paragraph, before one after the list', '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n\npara\n'],
    ['a paragraph, in a sublist\'s item', '- a\n  - b\n\n    <!-- style: box -->\n    styled\n    <!-- /style -->\n- c\n'],
    ['paragraphs, in two items', '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n\n- b\n\n  <!-- style: box -->\n  more\n  <!-- /style -->\n'],
    // Which export writes as paragraphs in the item too. Only a blank line
    // ends a <div>'s HTML block, so the closing fence goes after one
    ['an HTML block', '- a\n\n  <!-- style: box -->\n  <div>styled</div>\n\n  <!-- /style -->\n'],
    ['a paragraph and an HTML block', '- a\n\n  <!-- style: box -->\n  styled\n\n  <div>more</div>\n\n  <!-- /style -->\n'],
    ['a comment', '- a\n\n  <!-- style: box -->\n  <!-- c -->\n  <!-- /style -->\n'],
    ['a paragraph and a comment', '- a\n\n  <!-- style: box -->\n  styled\n\n  <!-- c -->\n  <!-- /style -->\n'],
    ['a comment, before one that isn\'t', '- a\n\n  <!-- style: box -->\n  <!-- c -->\n  <!-- /style -->\n\n  plain\n'],
    // Whose fences, which have no tokens, export found in the source for
    // those of the block at the top level, with the blank lines around them
    ['a paragraph, before a block of its style after the list', '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n\n<!-- style: box -->\n\nmore\n\n<!-- /style -->\n'],
  ])('keeps a style block of %s in a list item', async (_name, body) => {
    // Export dropped its fences, as HTML blocks in an item, and gave the
    // paragraph no style
    const md = styled + body;
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(await roundTrip(md))).toBe(md);
  });

  it('gives a paragraph in a style block in a list item its style, with the item\'s indent', async () => {
    const { docx, warnings } = await convertMdToDocx(styled + '- a\n\n  <!-- style: box -->\n  styled\n  <!-- /style -->\n');
    expect(warnings).toEqual([]);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toMatch(/<w:pPr><w:pStyle w:val="MsCustomBox"\/><w:ind w:left="720"\/><\/w:pPr>(?:(?!<\/w:p>).)*<w:t>styled<\/w:t>/);
  });

  it.each([
    ['Blockquote', '  > q\n'],
    ['List', '  - b\n'],
  ])('warns of a %s in a style block in a list item, which keeps no style', async (kind, block) => {
    const { warnings } = await convertMdToDocx(styled + '- a\n\n  <!-- style: box -->\n  styled\n\n' + block + '  <!-- /style -->\n');
    expect(warnings.some(warning => warning.startsWith(kind + ' inside a style block in a list item'))).toBe(true);
  });

  const twoStyles = '---\nstyles:\n  box:\n    font-style: italic\n  note:\n    font-style: bold\n---\n\n';
  /** Each paragraph's style and text in the document of `docx` */
  const paragraphStyles = async (docx: Uint8Array) => {
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<w:p\b[^>]*>((?:(?!<\/w:p>).)*)<\/w:p>/gs)].map(([, p]) =>
      (/<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? '') + ':' + [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join(''))
      .filter(p => !p.endsWith(':'));
  };

  it('keeps a style block in a list item in the style of a block the item is in', async () => {
    // Import wrote no fences around the paragraph, as the style was its
    // item's, but export gives a paragraph in an item in a block the
    // continuation's style, so the next export lost the paragraph's
    const md = twoStyles + '<!-- style: box -->\n- a\n\n  <!-- style: box -->\n  p\n  <!-- /style -->\n';
    const first = await convertMdToDocx(md);
    expect(await paragraphStyles(first.docx)).toEqual(['MsCustomBox:a', 'MsCustomBox:p']);
    const markdown = (await convertDocx(first.docx)).markdown;
    expect(markdown).toBe(md);
    expect(await paragraphStyles((await convertMdToDocx(markdown)).docx)).toEqual(['MsCustomBox:a', 'MsCustomBox:p']);
  });

  it('closes a style block a list item is in where a style block opens in the item, with a warning', async () => {
    // As a style block that opens in another closes it. Export left the
    // block the item is in open, so the items after it took its style
    const md = twoStyles + '<!-- style: box -->\n- a\n\n  <!-- style: note -->\n  p\n  <!-- /style -->\n- b\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual(['Nested <!-- style: --> directives are not supported; outer style "box" closed implicitly.']);
    expect(await paragraphStyles(docx)).toEqual(['MsCustomBox:a', 'MsCustomNote:p', ':b']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(md);
  });

  it('closes a style block in a list item where another opens in the item before its closing fence, with a warning', async () => {
    // As a style block that opens in another closes it, which a block at the
    // top level that a block in the item opens in warns of. In the item, the
    // second block took the place of the first with no warning
    const md = twoStyles + '- a\n\n  <!-- style: box -->\n  p\n\n  <!-- style: note -->\n  q\n  <!-- /style -->\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual(['Nested <!-- style: --> directives are not supported; outer style "box" closed implicitly.']);
    expect(await paragraphStyles(docx)).toEqual([':a', 'MsCustomBox:p', 'MsCustomNote:q']);
    // Import closes the first block before the second, which the next
    // export reads with no warning
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(twoStyles + '- a\n\n  <!-- style: box -->\n  p\n  <!-- /style -->\n\n  <!-- style: note -->\n  q\n  <!-- /style -->\n');
    const again = await convertMdToDocx(markdown);
    expect(again.warnings).toEqual([]);
    expect((await convertDocx(again.docx)).markdown).toBe(markdown);
  });

  it('closes a style block in a list item where a block opens in an item of its sublist, with a warning', async () => {
    // As a style block that opens in another closes it. The sublist's item
    // read its blocks alone, so the block in the item above it stayed open,
    // with no warning, and the item's paragraph after the sublist took its
    // style
    const md = twoStyles + '- a\n\n  <!-- style: box -->\n  p\n\n  - x\n\n    <!-- style: note -->\n    y\n    <!-- /style -->\n\n  q\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([
      'List inside a style block in a list item exported without the style (not supported). Move the style block outside the list for round-trip fidelity.',
      'Nested <!-- style: --> directives are not supported; outer style "box" closed implicitly.',
    ]);
    expect(await paragraphStyles(docx)).toEqual([':a', 'MsCustomBox:p', ':x', 'MsCustomNote:y', 'ManuscriptListContinuation:q']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(twoStyles + '- a\n\n  <!-- style: box -->\n  p\n  <!-- /style -->\n\n  - x\n\n    <!-- style: note -->\n    y\n    <!-- /style -->\n\n  q\n');
    const again = await convertMdToDocx(markdown);
    expect(again.warnings).toEqual([]);
    expect((await convertDocx(again.docx)).markdown).toBe(markdown);
  });

  it('keeps the place of a quote in a list item after a sublist and a style block in the item that closes one at the top level', async () => {
    // The block's close at the top level, which Word gets nothing for,
    // ended the items open as other blocks do, so export kept no record of
    // the quote's place, and import read it in the sublist's item, by its
    // indent
    const md = twoStyles + '<!-- style: box -->\n- a\n  - x\n\n  <!-- style: note -->\n  <!-- /style -->\n\n  > > > > q\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual(['Nested <!-- style: --> directives are not supported; outer style "box" closed implicitly.']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(twoStyles + '<!-- style: box -->\n- a\n  - x\n\n  > > > > q\n\n<!-- /style -->\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  it('keeps two quotes in a list item as one around a style block in the item that closes one at the top level', async () => {
    // Which Word has as one, with nothing between them. Export counted the
    // block's close at the top level, which Word gets nothing for, as the
    // end of the first, so the records of the quotes went to other groups
    // than import reads, and the second came back after the block's closing
    // fence, out of the list on the next trip
    const md = twoStyles + '<!-- style: box -->\n- a\n\n  > q1\n\n  <!-- style: note -->\n  <!-- /style -->\n\n  > q2\n';
    const markdown = (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
    expect(markdown).toBe(twoStyles + '<!-- style: box -->\n- a\n\n  > q1\n\n  > q2\n\n<!-- /style -->\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  it('writes nothing between a quote in a list item and the next item for a style block in the item that closes one at the top level', async () => {
    // Export took the block's close at the top level, which Word gets
    // nothing for, for the block after the quote, which isn't the list's
    // next item, and wrote an empty paragraph there, which ends the list in
    // Word
    const JSZip = (await import('jszip')).default;
    /** The paragraphs Word has between q and b, with no IDs */
    const between = async (md: string) => {
      const xml = await (await JSZip.loadAsync((await convertMdToDocx(twoStyles + md)).docx)).file('word/document.xml')!.async('string');
      const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>(?:(?!<\/w:p>).)*<\/w:p>|<w:p\/>/gs)].map(([p]) => p.replace(/ w(?:14)?:(?:paraId|textId|rsidR|rsidRDefault)="[^"]*"/g, ''));
      return paragraphs.slice(paragraphs.findIndex(p => p.includes('>q<')) + 1, paragraphs.findIndex(p => p.includes('>b<')));
    };
    expect(await between('<!-- style: box -->\n- a\n\n  > q\n\n  <!-- style: note -->\n  <!-- /style -->\n- b\n'))
      .toEqual(await between('<!-- style: box -->\n- a\n\n  > q\n- b\n'));
  });

  const listInBlockWarning = 'List inside a style block in a list item exported without the style (not supported). Move the style block outside the list for round-trip fidelity.';
  const nestedWarning = 'Nested <!-- style: --> directives are not supported; outer style "box" closed implicitly.';

  it('keeps a sublist in a list item where a style block in the item that closes one at the top level opens before it', async () => {
    // Import closed the block at the top level before the sublist, with a
    // fence there that ended the item, so the next trip read the sublist at
    // the top level, and the paragraph after it out of the item
    const md = twoStyles + '<!-- style: box -->\n- a\n\n  <!-- style: note -->\n\n  - x\n\n  p\n  <!-- /style -->\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([listInBlockWarning, nestedWarning]);
    expect(await paragraphStyles(docx)).toEqual(['MsCustomBox:a', ':x', 'MsCustomNote:p']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(md);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(md);
  });

  it('closes a style block at the top level in a list item before a sublist with nothing in a style block after it, as an empty block in the item', async () => {
    // Which closes the block at the top level as the one there did, as a
    // closing fence would end the item there
    const md = twoStyles + '<!-- style: box -->\n- a\n\n  <!-- style: note -->\n  - x\n  <!-- /style -->\n\n  q\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([listInBlockWarning, nestedWarning]);
    expect(await paragraphStyles(docx)).toEqual(['MsCustomBox:a', ':x', 'ManuscriptListContinuation:q']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(twoStyles + '<!-- style: box -->\n- a\n\n  <!-- style: box -->\n  <!-- /style -->\n  - x\n\n  q\n');
    const again = await convertMdToDocx(markdown);
    expect(again.warnings).toEqual([nestedWarning]);
    expect(await paragraphStyles(again.docx)).toEqual(['MsCustomBox:a', ':x', 'ManuscriptListContinuation:q']);
    expect((await convertDocx(again.docx)).markdown).toBe(markdown);
  });

  it('closes a style block at the top level in the item of a sublist before an item of it with no style, so the sublist stays one list', async () => {
    // Not in the item the sublist is in, before the item, which ends the
    // sublist there, so the next export started its numbering again
    const md = twoStyles + '<!-- style: box -->\n1. a\n   1. b\n\n      <!-- style: note -->\n   2. c\n   3. d\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([nestedWarning]);
    expect(await paragraphStyles(docx)).toEqual(['MsCustomBox:a', 'MsCustomBox:b', ':c', ':d']);
    const markdown = (await convertDocx(docx)).markdown;
    expect(markdown).toBe(twoStyles + '<!-- style: box -->\n1. a\n   1. b\n\n      <!-- style: box -->\n      <!-- /style -->\n   2. c\n   3. d\n');
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  it.each([
    ['in the item before it', styled + '- a\n\n  <!-- style: box -->\n  p\n  <!-- /style -->\n\n<!-- indent -->\n- b\n'],
    ['in the item before it, that closes one at the top level', twoStyles + '<!-- style: box -->\n- a\n\n  <!-- style: note -->\n  p\n  <!-- /style -->\n\n<!-- indent -->\n- b\n'],
    // Which import closes in the item
    ['with no closing fence in the item', styled + '- a\n\n  <!-- style: box -->\n  p\n\n<!-- no-indent -->\n- b\n',
      styled + '- a\n\n  <!-- style: box -->\n  p\n  <!-- /style -->\n\n<!-- no-indent -->\n- b\n'],
    ['at the top level', styled + '<!-- style: box -->\n- a\n<!-- /style -->\n\n<!-- indent -->\n- b\n'],
    // Which import writes after the fence
    ['at the top level after it', styled + '- a\n\n<!-- indent -->\n\n<!-- style: box -->\n- b\n<!-- /style -->\n',
      styled + '- a\n\n<!-- style: box -->\n<!-- indent -->\n- b\n<!-- /style -->\n'],
  ])('keeps an indent directive between list items beside a style block %s', async (_name, md, back = md) => {
    // Which reads as right after the item, as Word gets no paragraph for
    // the block's fences. Export took a fence for a block between the item
    // and the directive, so it kept no record of the directive, and the two
    // lists of bullets came back as one, with no directive
    expect(await roundTrip(md)).toBe(back);
    expect(await roundTrip(back)).toBe(back);
  });

  it('drops a style block in an item of a list in a quote, with a warning, so it closes no block around the quote', async () => {
    // The quote's items are its paragraphs, in its style, as it has no
    // lists, so the block's fences go, as they did before list items held
    // style blocks. The opening one closed the block around the quote, so
    // the paragraphs after the quote lost its style
    const md = twoStyles + '<!-- style: box -->\nx\n\n> - a\n>\n>   <!-- style: note -->\n>   p\n>   <!-- /style -->\n\ny\n<!-- /style -->\n';
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([
      'HTML block inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.',
      'List inside blockquote exported as quote paragraphs (not supported). Move it outside the quote for round-trip fidelity.',
    ]);
    expect(await paragraphStyles(docx)).toEqual(['MsCustomBox:x', 'GitHubBlockquote:a', 'GitHubBlockquote:p', 'MsCustomBox:y']);
  });

  it('parses style blocks in many list items in linear time', () => {
    // Four times as many take about four times as long, not sixteen. The
    // search of the source for each fence in an item, for the comments
    // after it, started at the first line, and each fence took the list's
    // lines as its own, which the spacing of quotes compared in full for each
    const md = (n: number) => Array.from({ length: n }, (_, k) => '- i' + k + '\n\n  <!-- style: box -->\n  p' + k + '\n  <!-- /style -->\n').join('\n');
    const [small, large] = [md(2000), md(8000)];
    expect(fastestRun(() => parseMd(large)) / fastestRun(() => parseMd(small))).toBeLessThan(8);
  }, 30000);

  it('drops a one-line style block in a list item, with a warning', async () => {
    // As it did before style blocks in items, which read the whole line as
    // an opening fence, with the text in the style's name, and dropped the
    // text with only a warning that no style of that name was declared
    const { docx, warnings } = await convertMdToDocx(styled + '- a\n\n  <!-- style: box -->styled<!-- /style -->\n\n  plain\n');
    expect(warnings).toEqual(['HTML block inside list item dropped during conversion (not supported). Move the content outside the list for round-trip fidelity.']);
    expect(await paragraphStyles(docx)).toEqual([':a', 'ManuscriptListContinuation:plain']);
  });

  it('keeps a style block in a list item that Word has at a level the list skips, with tabs', async () => {
    // Import wrote its paragraph at the level Markdown nests the item at,
    // but its fences at Word's, as code, which export dropped, with the
    // style
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync((await convertMdToDocx(styled + '- c\n\n\t<!-- style: box -->\n\tp\n\t<!-- /style -->\n\n- d\n\t- e\n')).docx);
    let xml = await zip.file('word/document.xml')!.async('string');
    const item = /<w:p\b[^>]*>(?:(?!<\/w:p>).)*?<w:t>c<\/w:t>/s.exec(xml)![0];
    xml = xml.replace(item, item.replace('<w:ilvl w:val="0"/>', '<w:ilvl w:val="2"/>'));
    const paragraph = /<w:p\b[^>]*>(?:(?!<\/w:p>).)*?<w:t>p<\/w:t>/s.exec(xml)![0];
    xml = xml.replace(paragraph, paragraph.replace('w:left="720"', 'w:left="2160"'));
    zip.file('word/document.xml', xml);
    const markdown = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    const expected = '-\tc\n\n\t<!-- style: box -->\n\tp\n\t<!-- /style -->\n\n-\td\n\t-\te\n';
    expect(markdown.endsWith('\n' + expected)).toBe(true);
    const again = await convertMdToDocx(markdown);
    expect(again.warnings).toEqual([]);
    expect(await paragraphStyles(again.docx)).toContain('MsCustomBox:p');
    expect((await convertDocx(again.docx)).markdown).toBe(markdown);
  });
});

// ============================================================
// Group F: Preview Plugin
// ============================================================
describe('Custom Styles — Preview Plugin', () => {
  it('generates CSS from style definitions', () => {
    const md = [
      '---',
      'header-font-style: bold',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '    font-size: 14',
      '    font-style: bold-italic',
      '    spacing-before: 12',
      '    spacing-after: 6',
      '    paragraph-indent: 0.3',
      '---',
      '',
      'Hello',
    ].join('\n');
    const html = renderWithPlugin(md, 'github');
    // CSS class and rules are generated (may be HTML-escaped in markdown-it output)
    expect(html).toContain('ms-custom-style-pullquote');
    expect(html).toContain('font-size: 14pt');
    expect(html).toContain('font-weight: bold');
    expect(html).toContain('font-style: italic');
    expect(html).toContain('margin-top: 12pt');
    expect(html).toContain('margin-bottom: 6pt');
    expect(html).toContain('text-indent: 0.3in');
  });

  it('generates custom style CSS without headerFontStyle', () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '    font-size: 14',
      '    spacing-before: 12',
      '---',
      '',
      'Hello',
    ].join('\n');
    const html = renderWithPlugin(md, 'github');
    expect(html).toContain('ms-custom-style-pullquote');
    expect(html).toContain('font-family: "Georgia"');
    expect(html).toContain('font-size: 14pt');
    expect(html).toContain('margin-top: 12pt');
  });

  it('generates zero text-indent for paragraph-indent: none', () => {
    const md = [
      '---',
      'styles:',
      '  caption:',
      '    paragraph-indent: none',
      '---',
      '',
      'Hello',
    ].join('\n');
    const html = renderWithPlugin(md, 'github');
    expect(html).toContain('text-indent: 0');
  });

  it('wraps style block in div with correct class', () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'Styled text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const html = renderWithPlugin(md, 'github');
    expect(html).toContain('<div class="ms-custom-style ms-custom-style-pullquote">');
  });

  it('close directive → </div>', () => {
    const md = [
      '---',
      'styles:',
      '  pullquote:',
      '    font: Georgia',
      '---',
      '',
      '<!-- style: pullquote -->',
      '',
      'Styled text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const html = renderWithPlugin(md, 'github');
    expect(html).toContain('</div>');
  });

  it('stray close without open → left as comment (no unmatched </div>)', () => {
    const md = '<!-- /style -->';
    const html = renderWithPlugin(md, 'github');
    // The only </div> should be the data-line wrapper, not an unmatched style close
    const divCloseCount = (html.match(/<\/div>/g) || []).length;
    const divOpenCount = (html.match(/<div[^>]*>/g) || []).length;
    expect(divCloseCount).toBe(divOpenCount);
    expect(html).toContain('<!-- /style -->');
  });

  it('opens no block for a style block on one line, which a stray closing fence would close', () => {
    // Its whole line read as an opening fence, of a style with the text in
    // its name
    const html = renderWithPlugin('<!-- style: box -->styled<!-- /style -->\n\npara\n\n<!-- /style -->', 'github');
    expect(html).not.toContain('ms-custom-style');
    expect(html).toContain('<div data-line="4"><!-- /style --></div>');
  });
});

// ============================================================
// Group G: Collision Warnings
// ============================================================
describe('Custom Styles — Collision Warnings', () => {
  it('two colliding names → warning in result.warnings', async () => {
    const md = [
      '---',
      'styles:',
      '  my-heading:',
      '    font: Arial',
      '  my_heading:',
      '    font: Times',
      '---',
      '',
      'Hello world.',
    ].join('\n');
    const { warnings } = await convertMdToDocx(md);
    const collision = warnings.find(w => w.includes('produce the same Word style ID'));
    expect(collision).toBeDefined();
    expect(collision).toContain('my-heading');
    expect(collision).toContain('my_heading');
    expect(collision).toContain('MsCustomMyHeading');
  });

  it('unique names → no collision warning', async () => {
    const md = [
      '---',
      'styles:',
      '  alpha:',
      '    font: Arial',
      '  beta:',
      '    font: Times',
      '---',
      '',
      'Hello world.',
    ].join('\n');
    const { warnings } = await convertMdToDocx(md);
    const collision = warnings.find(w => w.includes('produce the same Word style ID'));
    expect(collision).toBeUndefined();
  });

  it('colliding names still produce valid DOCX (no crash)', async () => {
    const md = [
      '---',
      'styles:',
      '  my-heading:',
      '    font: Arial',
      '  my_heading:',
      '    font: Times',
      '---',
      '',
      '<!-- style: my-heading -->',
      '',
      'Styled text.',
      '',
      '<!-- /style -->',
    ].join('\n');
    const { docx, warnings } = await convertMdToDocx(md);
    expect(docx).toBeInstanceOf(Uint8Array);
    expect(docx.length).toBeGreaterThan(0);
    // Should still have the collision warning
    expect(warnings.some(w => w.includes('produce the same Word style ID'))).toBe(true);
  });
});

// ============================================================
// Group: Template custom style replacement
// ============================================================
describe('Custom Styles — Template replacement', () => {
  it('replaces outdated custom style in template with updated definition', async () => {
    const JSZip = (await import('jszip')).default;

    // Step 1: generate a docx with font-size: 10 custom style
    const md1 = [
      '---',
      'font: Times New Roman',
      'font-size: 12',
      'styles:',
      '  big-text:',
      '    font-size: 10',
      '    font-style: center',
      '---',
      '',
      '<!-- style: big-text -->',
      'Hello World',
      '<!-- /style -->',
    ].join('\n');
    const result1 = await convertMdToDocx(md1);
    const zip1 = await JSZip.loadAsync(result1.docx);
    const styles1 = await zip1.file('word/styles.xml')!.async('string');
    const oldBlock = extractStyleBlock(styles1, customStyleId('big-text'))!;
    expect(oldBlock).toContain('w:sz w:val="20"'); // 10pt = 20hp

    // Step 2: save as template, re-generate with font-size: 18
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpPath = path.join(os.tmpdir(), 'test-template-custom-style-' + Date.now() + '.docx');
    fs.writeFileSync(tmpPath, Buffer.from(result1.docx));

    try {
      const md2 = [
        '---',
        'font: Times New Roman',
        'font-size: 12',
        'template: ' + tmpPath,
        'styles:',
        '  big-text:',
        '    font-size: 18',
        '    font-style: center',
        '---',
        '',
        '<!-- style: big-text -->',
        'Hello World',
        '<!-- /style -->',
      ].join('\n');
      const result2 = await convertMdToDocx(md2);
      const zip2 = await JSZip.loadAsync(result2.docx);
      const styles2 = await zip2.file('word/styles.xml')!.async('string');
      const newBlock = extractStyleBlock(styles2, customStyleId('big-text'))!;
      expect(newBlock).toContain('w:sz w:val="36"'); // 18pt = 36hp
      expect(newBlock).not.toContain('w:sz w:val="20"');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });
});
