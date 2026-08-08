import { describe, it, expect } from 'bun:test';
import {
  stylesXml,
  convertMdToDocx,
  parseMd,
  customStyleId,
} from './md-to-docx';
import { parseFrontmatter, serializeFrontmatter, type CustomStyleDef } from './frontmatter';
import { convertDocx } from './converter';
import { renderWithPlugin } from './test-helpers';

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

  it('preserves protected custom-style keys through DOCX round-trip', async () => {
    const md = [
      '---',
      'styles:',
      '  "__proto__":',
      '    font: Georgia',
      '---',
      '',
      'Body.',
    ].join('\n');
    const { docx } = await convertMdToDocx(md);
    const result = await convertDocx(docx);
    const { metadata } = parseFrontmatter(result.markdown);
    expect(({} as { font?: string }).font).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(metadata.styles, '__proto__')).toBe(true);
    expect(metadata.styles?.['__proto__'].font).toBe('Georgia');
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
