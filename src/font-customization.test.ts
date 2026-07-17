import { describe, it, expect } from 'bun:test';
import {
  stylesXml,
  resolveFontOverrides,
  applyFontOverridesToTemplate,
  convertMdToDocx,
  parseMd,
  type FontOverrides,
} from './md-to-docx';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { extractHtmlTables } from './html-table-parser';

// Helper: extract a <w:style ...styleId="X"...>...</w:style> block from styles XML
function extractStyleBlock(xml: string, styleId: string): string | null {
  const re = new RegExp(
    '<w:style\\b[^>]*\\bw:styleId="' + styleId + '"[^>]*>[\\s\\S]*?</w:style>'
  );
  const m = re.exec(xml);
  return m ? m[0] : null;
}

// Helper: extract w:sz val from a style block
function extractSzVal(block: string): number | null {
  const m = /w:sz w:val="(\d+)"/.exec(block);
  return m ? parseInt(m[1], 10) : null;
}

// Helper: extract w:rFonts ascii from a style block
function extractRFontsAscii(block: string): string | null {
  const m = /w:rFonts w:ascii="([^"]*)"/.exec(block);
  return m ? m[1] : null;
}

describe('Font customization unit tests', () => {
  // ---------------------------------------------------------------
  // 1. Default behavior: no font fields → styles identical to current output
  // Validates: Requirement 3.6
  // ---------------------------------------------------------------
  describe('default behavior (no overrides)', () => {
    it('produces default styles when no overrides are given', () => {
      const xml = stylesXml();
      const xmlWithUndefined = stylesXml(undefined);
      expect(xml).toBe(xmlWithUndefined);

      // Normal: sz=22
      const normal = extractStyleBlock(xml, 'Normal')!;
      expect(normal).toBeDefined();
      expect(extractSzVal(normal)).toBe(22);

      // Heading1: sz=32
      const h1 = extractStyleBlock(xml, 'Heading1')!;
      expect(extractSzVal(h1)).toBe(32);

      // CodeBlock: sz=20, font=Consolas
      const codeBlock = extractStyleBlock(xml, 'CodeBlock')!;
      expect(extractSzVal(codeBlock)).toBe(20);
      expect(extractRFontsAscii(codeBlock)).toBe('Consolas');

      // CodeChar: font=Consolas, no explicit size
      const codeChar = extractStyleBlock(xml, 'CodeChar')!;
      expect(extractRFontsAscii(codeChar)).toBe('Consolas');
    });
  });

  // ---------------------------------------------------------------
  // 2. Specific example: font-size: 14 → Normal=28hp, H1=41hp, CodeBlock=26hp
  // Validates: Requirements 2.1, 3.3, 3.5
  // ---------------------------------------------------------------
  describe('font-size: 14 example', () => {
    it('resolves correct half-point sizes', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: 14\n---\n');
      expect(metadata.fontSize).toBe(14);

      const overrides = resolveFontOverrides(metadata)!;
      expect(overrides).toBeDefined();
      expect(overrides.bodySizeHp).toBe(28);
      // Inferred code size: 28 - 2 = 26
      expect(overrides.codeSizeHp).toBe(26);
    });

    it('generates correct style sizes in XML', () => {
      const overrides = resolveFontOverrides({ fontSize: 14 })!;
      const xml = stylesXml(overrides);

      const normal = extractStyleBlock(xml, 'Normal')!;
      expect(extractSzVal(normal)).toBe(28);

      // H1: Math.round(32 / 22 * 28) = Math.round(40.727...) = 41
      const h1 = extractStyleBlock(xml, 'Heading1')!;
      expect(extractSzVal(h1)).toBe(41);

      const codeBlock = extractStyleBlock(xml, 'CodeBlock')!;
      expect(extractSzVal(codeBlock)).toBe(26);
    });
  });

  // ---------------------------------------------------------------
  // 3. Edge cases: invalid font-size values → ignored
  // Validates: Requirements 1.5, 1.6
  // ---------------------------------------------------------------
  describe('invalid font-size values', () => {
    it('font-size: abc → fontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: abc\n---\n');
      expect(metadata.fontSize).toBeUndefined();
    });

    it('font-size: -5 → fontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: -5\n---\n');
      expect(metadata.fontSize).toBeUndefined();
    });

    it('font-size: 0 → fontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\nfont-size: 0\n---\n');
      expect(metadata.fontSize).toBeUndefined();
    });

    it('code-font-size: abc → codeFontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\ncode-font-size: abc\n---\n');
      expect(metadata.codeFontSize).toBeUndefined();
    });

    it('code-font-size: -5 → codeFontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\ncode-font-size: -5\n---\n');
      expect(metadata.codeFontSize).toBeUndefined();
    });

    it('code-font-size: 0 → codeFontSize is undefined', () => {
      const { metadata } = parseFrontmatter('---\ncode-font-size: 0\n---\n');
      expect(metadata.codeFontSize).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // 4. Edge case: font-size: 1 → code-font-size clamped to minimum
  // Validates: Requirement 2.1 (clamping)
  // ---------------------------------------------------------------
  describe('font-size: 1 clamping', () => {
    it('clamps inferred codeSizeHp to minimum 1', () => {
      const overrides = resolveFontOverrides({ fontSize: 1 })!;
      expect(overrides).toBeDefined();
      // bodySizeHp = 1 * 2 = 2
      expect(overrides.bodySizeHp).toBe(2);
      // codeSizeHp = Math.max(1, 2 - 2) = Math.max(1, 0) = 1
      expect(overrides.codeSizeHp).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // 5. Template passthrough: no overrides → unmodified
  // Validates: Requirement 4.2
  // ---------------------------------------------------------------
  describe('template passthrough', () => {
    it('returns auto-shrink overrides even when no font fields set', () => {
      const overrides = resolveFontOverrides({});
      expect(overrides).toBeDefined();
      // Default auto-shrink: 22hp - 4 = 18hp (9pt)
      expect(overrides.tableSizeHp).toBe(18);
      expect(overrides.tableSizeFromDefault).toBe(true);
    });

    it('leaves template unmodified when overrides have no applicable values', () => {
      const templateXml =
        '<?xml version="1.0"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:styleId="Normal">' +
        '<w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
        '</w:style>' +
        '</w:styles>';
      const bytes = new TextEncoder().encode(templateXml);

      // Override with only codeFont set — Normal is not a code style, so it won't be modified
      const codeFontOnlyOverrides: FontOverrides = {
        codeFont: 'Courier',
      };
      const result = applyFontOverridesToTemplate(bytes, codeFontOnlyOverrides);
      // Normal is not a code style, so codeFont doesn't affect it → template unchanged
      expect(result).toBe(templateXml);
    });

    it('modifies the style-level rPr, not the one nested inside pPr', () => {
      const templateXml =
        '<?xml version="1.0"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:styleId="Normal">' +
        '<w:pPr><w:keepNext/><w:rPr><w:b/></w:rPr></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Times" w:hAnsi="Times"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
        '</w:style>' +
        '</w:styles>';
      const bytes = new TextEncoder().encode(templateXml);
      const overrides: FontOverrides = { bodyFont: 'Georgia', bodySizeHp: 28 };
      const result = applyFontOverridesToTemplate(bytes, overrides);
      // pPr-level rPr must be untouched
      expect(result).toContain('<w:pPr><w:keepNext/><w:rPr><w:b/></w:rPr></w:pPr>');
      // Style-level rPr must have the new font and size (old font removed)
      expect(result).toContain('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>');
      expect(result).not.toContain('w:ascii="Times"');
      expect(result).toContain('<w:sz w:val="28"/>');
      expect(result).toContain('<w:szCs w:val="28"/>');
    });
  });

  // ---------------------------------------------------------------
  // 6. Integration: full convertMdToDocx with font frontmatter
  // Validates: Requirements 3.3, 3.5, 3.6
  // ---------------------------------------------------------------
  describe('integration: convertMdToDocx with font frontmatter', () => {
    it('applies font and size overrides to output DOCX styles', async () => {
      const markdown = '---\nfont: Georgia\nfont-size: 14\n---\nHello world';
      const result = await convertMdToDocx(markdown);
      expect(result.docx).toBeInstanceOf(Uint8Array);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);

      const stylesFile = zip.file('word/styles.xml');
      expect(stylesFile).toBeDefined();
      const stylesContent = await stylesFile!.async('string');

      // Normal: font=Georgia, sz=28
      const normal = extractStyleBlock(stylesContent, 'Normal')!;
      expect(normal).toBeDefined();
      expect(extractRFontsAscii(normal)).toBe('Georgia');
      expect(extractSzVal(normal)).toBe(28);

      // Heading1: font=Georgia, sz=41
      const h1 = extractStyleBlock(stylesContent, 'Heading1')!;
      expect(h1).toBeDefined();
      expect(extractRFontsAscii(h1)).toBe('Georgia');
      expect(extractSzVal(h1)).toBe(41);

      // CodeBlock: font=Consolas (default code font), sz=26 (inferred)
      const codeBlock = extractStyleBlock(stylesContent, 'CodeBlock')!;
      expect(codeBlock).toBeDefined();
      expect(extractRFontsAscii(codeBlock)).toBe('Consolas');
      expect(extractSzVal(codeBlock)).toBe(26);
    });

    it('uses default styles with auto-shrink TableParagraph when no font frontmatter is present', async () => {
      const markdown = 'Just plain text';
      const result = await convertMdToDocx(markdown);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');

      // Auto-shrink always applies: TableParagraph with sz=18 (9pt = 11pt body - 2pt)
      const tablePara = extractStyleBlock(stylesContent, 'TableParagraph')!;
      expect(tablePara).toBeDefined();
      expect(extractSzVal(tablePara)).toBe(18);
    });

    it('applies code-font override to code styles', async () => {
      const markdown = '---\ncode-font: Fira Code\n---\nSome text';
      const result = await convertMdToDocx(markdown);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');

      const codeBlock = extractStyleBlock(stylesContent, 'CodeBlock')!;
      expect(extractRFontsAscii(codeBlock)).toBe('Fira Code');

      const codeChar = extractStyleBlock(stylesContent, 'CodeChar')!;
      expect(extractRFontsAscii(codeChar)).toBe('Fira Code');
    });

    it('applies code-font override to code block run properties in document body', async () => {
      const markdown = '---\ncode-font: Fira Code\n---\n\n```\nhello\n```';
      const result = await convertMdToDocx(markdown);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');

      expect(docContent).toContain('w:ascii="Fira Code"');
      expect(docContent).toContain('w:hAnsi="Fira Code"');
      expect(docContent).not.toContain('w:ascii="Consolas"');
    });
  });

  // ---------------------------------------------------------------
  // 7. Table font frontmatter parsing
  // ---------------------------------------------------------------
  describe('table font frontmatter', () => {
    it('parses table-font and table-font-size', () => {
      const { metadata } = parseFrontmatter('---\ntable-font: Arial\ntable-font-size: 9\n---\n');
      expect(metadata.tableFont).toBe('Arial');
      expect(metadata.tableFontSize).toBe(9);
    });

    it('ignores invalid table-font-size', () => {
      const { metadata } = parseFrontmatter('---\ntable-font-size: abc\n---\n');
      expect(metadata.tableFontSize).toBeUndefined();
    });

    it('serializes table-font and table-font-size', () => {
      const fm = serializeFrontmatter({ tableFont: 'Arial', tableFontSize: 9 });
      expect(fm).toContain('table-font: Arial');
      expect(fm).toContain('table-font-size: 9');
    });
  });

  // ---------------------------------------------------------------
  // 8. resolveFontOverrides with table fields
  // ---------------------------------------------------------------
  describe('resolveFontOverrides table fields', () => {
    it('sets tableSizeHp from explicit table-font-size', () => {
      const overrides = resolveFontOverrides({ tableFontSize: 9 })!;
      expect(overrides).toBeDefined();
      expect(overrides.tableSizeHp).toBe(18);
    });

    it('sets tableFont from table-font', () => {
      const overrides = resolveFontOverrides({ tableFont: 'Arial' })!;
      expect(overrides).toBeDefined();
      expect(overrides.tableFont).toBe('Arial');
    });

    it('auto-shrinks: body - 2pt when only font-size is set', () => {
      const overrides = resolveFontOverrides({ fontSize: 12 })!;
      expect(overrides).toBeDefined();
      // body = 24hp, auto-shrink = 24 - 4 = 20hp = 10pt
      expect(overrides.tableSizeHp).toBe(20);
    });

    it('does not auto-shrink when table-font-size is explicit', () => {
      const overrides = resolveFontOverrides({ fontSize: 12, tableFontSize: 11 })!;
      expect(overrides.tableSizeHp).toBe(22);
    });

    it('auto-shrinks when table-font is set without table-font-size', () => {
      const overrides = resolveFontOverrides({ fontSize: 12, tableFont: 'Arial' })!;
      // auto-shrink applies regardless of tableFont: body 24hp - 4 = 20hp
      expect(overrides.tableSizeHp).toBe(20);
    });

    it('clamps auto-shrink to minimum 1hp', () => {
      const overrides = resolveFontOverrides({ fontSize: 1 })!;
      // body = 2hp, auto-shrink = max(1, 2 - 4) = 1
      expect(overrides.tableSizeHp).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // 9. table-borders frontmatter
  // ---------------------------------------------------------------
  describe('table-borders frontmatter', () => {
    it('parses table-borders: horizontal', () => {
      const { metadata } = parseFrontmatter('---\ntable-borders: horizontal\n---\n');
      expect(metadata.tableBorders).toBe('horizontal');
    });

    it('parses table-borders: solid', () => {
      const { metadata } = parseFrontmatter('---\ntable-borders: solid\n---\n');
      expect(metadata.tableBorders).toBe('solid');
    });

    it('parses table-borders: none', () => {
      const { metadata } = parseFrontmatter('---\ntable-borders: none\n---\n');
      expect(metadata.tableBorders).toBe('none');
    });

    it('is case insensitive', () => {
      const { metadata } = parseFrontmatter('---\ntable-borders: Solid\n---\n');
      expect(metadata.tableBorders).toBe('solid');
    });

    it('ignores invalid values', () => {
      const { metadata } = parseFrontmatter('---\ntable-borders: dashed\n---\n');
      expect(metadata.tableBorders).toBeUndefined();
    });

    it('serializes table-borders', () => {
      const fm = serializeFrontmatter({ tableBorders: 'none' });
      expect(fm).toContain('table-borders: none');
    });

    it('resolves tableBorders in FontOverrides', () => {
      const overrides = resolveFontOverrides({ tableBorders: 'none' });
      expect(overrides.tableBorders).toBe('none');
    });

    it('defaults to undefined in FontOverrides when not set', () => {
      const overrides = resolveFontOverrides({});
      expect(overrides.tableBorders).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // 10. stylesXml TableParagraph style output
  // ---------------------------------------------------------------
  describe('stylesXml TableParagraph', () => {
    it('includes TableParagraph when table overrides exist', () => {
      const overrides = resolveFontOverrides({ tableFontSize: 9 })!;
      const xml = stylesXml(overrides);
      const block = extractStyleBlock(xml, 'TableParagraph');
      expect(block).toBeDefined();
      expect(extractSzVal(block!)).toBe(18);
    });

    it('includes tableFont in TableParagraph', () => {
      const overrides = resolveFontOverrides({ tableFont: 'Arial', tableFontSize: 9 })!;
      const xml = stylesXml(overrides);
      const block = extractStyleBlock(xml, 'TableParagraph')!;
      expect(extractRFontsAscii(block)).toBe('Arial');
    });

    it('omits TableParagraph when no table overrides', () => {
      const xml = stylesXml();
      const block = extractStyleBlock(xml, 'TableParagraph');
      expect(block).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // 10. Per-table directive comment parsing in parseMd
  // ---------------------------------------------------------------
  describe('per-table directive parsing', () => {
    it('transfers table-font-size directive to table token', () => {
      const tokens = parseMd('<!-- table-font-size: 8 -->\n\n| A | B |\n|---|---|\n| 1 | 2 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFontSize).toBe(8);
      // Directive comment should be spliced out
      expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment' && r.text.includes('table-font-size')))).toHaveLength(0);
    });

    it('transfers table-font directive to table token', () => {
      const tokens = parseMd('<!-- table-font: Times New Roman -->\n\n| A |\n|---|\n| 1 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFont).toBe('Times New Roman');
    });

    it('transfers table-font-size directive when intervening HTML comment exists', () => {
      const tokens = parseMd('<!-- table-font-size: 8 -->\n\n<!-- some comment -->\n\n| A | B |\n|---|---|\n| 1 | 2 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFontSize).toBe(8);
      // Directive comment should be spliced out, but the other comment remains
      expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment' && r.text.includes('table-font-size')))).toHaveLength(0);
      expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment' && r.text.includes('some comment')))).toHaveLength(1);
    });

    it('transfers table-font directive when intervening HTML comment exists', () => {
      const tokens = parseMd('<!-- table-font: Times New Roman -->\n\n<!-- Begin Table -->\n\n| A |\n|---|\n| 1 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFont).toBe('Times New Roman');
    });

    it('transfers table-orientation directive when intervening HTML comment exists', () => {
      const tokens = parseMd('<!-- table-orientation: landscape -->\n\n<!-- Supplemental Table -->\n\n| A |\n|---|\n| 1 |');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableOrientation).toBe('landscape');
    });

    it('ignores directives not followed by a table', () => {
      const tokens = parseMd('<!-- table-font-size: 8 -->\n\nHello');
      expect(tokens.filter(t => t.runs.some(r => r.type === 'html_comment'))).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------
  // 11. HTML table data-font-size / data-font attribute parsing
  // ---------------------------------------------------------------
  describe('HTML table font attributes', () => {
    it('extracts data-font-size from <table> tag', () => {
      const tables = extractHtmlTables('<table data-font-size="8"><tr><td>A</td></tr></table>');
      expect(tables).toHaveLength(1);
      expect(tables[0].fontSize).toBe(8);
    });

    it('extracts data-font from <table> tag', () => {
      const tables = extractHtmlTables('<table data-font="Arial"><tr><td>A</td></tr></table>');
      expect(tables).toHaveLength(1);
      expect(tables[0].font).toBe('Arial');
    });

    it('preserves apostrophes in double-quoted data-font value', () => {
      const tables = extractHtmlTables('<table data-font="O\'Brien Sans"><tr><td>A</td></tr></table>');
      expect(tables).toHaveLength(1);
      expect(tables[0].font).toBe("O'Brien Sans");
    });

    it('preserves double quotes in single-quoted data-font value', () => {
      const tables = extractHtmlTables("<table data-font='My \"Special\" Font'><tr><td>A</td></tr></table>");
      expect(tables).toHaveLength(1);
      expect(tables[0].font).toBe('My "Special" Font');
    });

    it('parseMd transfers HTML table data attributes to MdToken', () => {
      const tokens = parseMd('<table data-font-size="8" data-font="Arial"><tr><td>A</td></tr></table>');
      const tables = tokens.filter(t => t.type === 'table');
      expect(tables).toHaveLength(1);
      expect(tables[0].tableFontSize).toBe(8);
      expect(tables[0].tableFont).toBe('Arial');
    });
  });

  // ---------------------------------------------------------------
  // 12. Integration: table cell paragraphs get font styling in docx
  // ---------------------------------------------------------------
  describe('integration: table font in docx output', () => {
    it('applies table-font-size to table cell paragraphs', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');
      // Should have TableParagraph style reference and size 18hp (9pt)
      expect(docContent).toContain('w:val="TableParagraph"');
      const stylesContent = await zip.file('word/styles.xml')!.async('string');
      const block = extractStyleBlock(stylesContent, 'TableParagraph')!;
      expect(block).toBeDefined();
      expect(extractSzVal(block)).toBe(18);
    });

    it('auto-shrinks table font when font-size is set', async () => {
      const markdown = '---\nfont-size: 12\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');
      const block = extractStyleBlock(stylesContent, 'TableParagraph')!;
      expect(block).toBeDefined();
      // 12pt body = 24hp, auto-shrink = 20hp = 10pt
      expect(extractSzVal(block)).toBe(20);
    });

    it('per-table directive overrides document-level table font', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n<!-- table-font-size: 7 -->\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');
      // Per-table override: 7pt = 14hp, should appear as w:sz inside w:rPr
      expect(docContent).toMatch(/<w:rPr>[\s\S]*?<w:sz w:val="14"\/>/);
    });

    it('HTML table data-font-size applies to cell paragraphs', async () => {
      const markdown = '<table data-font-size="8"><tr><td>A</td></tr></table>';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docContent = await zip.file('word/document.xml')!.async('string');
      // 8pt = 16hp, should appear as w:sz inside w:rPr
      expect(docContent).toMatch(/<w:rPr>[\s\S]*?<w:sz w:val="16"\/>/);
    });

    it('table-font family is written to styles.xml', async () => {
      const markdown = '---\ntable-font: "O\'Brien Sans"\ntable-font-size: 8\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const stylesContent = await zip.file('word/styles.xml')!.async('string');
      expect(stylesContent).toMatch(/w:rFonts[^>]*O'Brien Sans/);
    });
  });

  // ---------------------------------------------------------------
  // 13. Round-trip: md → docx → md
  // ---------------------------------------------------------------
  describe('round-trip table font', () => {
    it('round-trips document-level table-font-size', async () => {
      // Use 8pt (16hp) which differs from auto-shrink default (18hp) to survive suppression
      const markdown = '---\ntable-font-size: 8\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableFontSize).toBe(8);
    });

    it('round-trips document-level table-font', async () => {
      // Use 8pt to avoid auto-shrink suppression
      const markdown = '---\ntable-font: Arial\ntable-font-size: 8\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableFont).toBe('Arial');
      expect(metadata.tableFontSize).toBe(8);
    });

    it('auto-shrink value is suppressed on round-trip (auto-shrink reproduces it)', async () => {
      const markdown = '---\nfont-size: 12\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      // Auto-shrink = 10pt = auto default, suppressed since auto-shrink reproduces it
      expect(metadata.tableFontSize).toBeUndefined();
    });

    it('auto-shrink applies when table-font is set without explicit table-font-size', async () => {
      // body 12pt + table-font: Arial → auto-shrink gives tables 10pt
      const markdown = '---\nfont-size: 12\ntable-font: Arial\n---\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableFont).toBe('Arial');
      // Auto-shrink = 10pt = auto default, suppressed since auto-shrink reproduces it
      expect(metadata.tableFontSize).toBeUndefined();
    });

    it('per-table font-size directive applies inline rPr on runs', async () => {
      const markdown = '---\ntable-font-size: 10\n---\n\n<!-- table-font-size: 8 -->\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docXml = await zip.file('word/document.xml')!.async('string');
      // Runs in the 8pt table must have inline w:sz inside w:rPr (not just pPr > rPr)
      expect(docXml).toMatch(/<w:r><w:rPr>[\s\S]*?<w:sz w:val="16"\/>/);
    });

    it('round-trips per-table font-size directive for pipe tables', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n<!-- table-font-size: 7 -->\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('<!-- table-font-size: 7 -->');
    });

    it('round-trips per-table font-size for HTML tables via data-font-size', async () => {
      const markdown = '---\ntable-font-size: 9\npipe-table-max-line-width: 0\n---\n\n<table data-font-size="7">\n  <tr>\n    <td>\n      <p>A</p>\n    </td>\n  </tr>\n</table>';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('data-font-size="7"');
    });

    it('round-trips per-table font override with apostrophe in name', async () => {
      const markdown = '---\ntable-font-size: 9\n---\n\n<!-- table-font: O\'Brien Sans -->\n\n| A |\n|---|\n| 1 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docXml = await zip.file('word/document.xml')!.async('string');
      // Per-table font should produce w:rFonts in run rPr
      expect(docXml).toMatch(/w:rFonts[^>]*O'Brien Sans/);
      // Round-trip: convert back to markdown and check the directive is preserved
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain("table-font: O'Brien Sans");
    });
  });

  // ---------------------------------------------------------------
  // 14. Round-trip: table column widths
  // ---------------------------------------------------------------
  describe('round-trip table col-widths', () => {
    it('round-trips frontmatter table-col-widths', async () => {
      const markdown = '---\ntable-col-widths: 2 1 1\n---\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableColWidths).toEqual([2, 1, 1]);
    });

    it('round-trips frontmatter table-col-widths: equal', async () => {
      const markdown = '---\ntable-col-widths: equal\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const { metadata } = parseFrontmatter(converted.markdown);
      expect(metadata.tableColWidths).toBe('equal');
    });

    it('generates correct OOXML for col-widths', async () => {
      const markdown = '---\ntable-col-widths: 2 1 1\n---\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docXml = await zip.file('word/document.xml')!.async('string');
      expect(docXml).toContain('<w:tblW w:w="5000" w:type="pct"/>');
      // gridCol elements have explicit dxa widths (not bare) for Word Online compatibility
      expect(docXml).toContain('<w:gridCol w:w=');
      expect(docXml).toContain('<w:tcW w:w="2500" w:type="pct"/>');
    });

    it('round-trips per-table col-widths directive for pipe tables', async () => {
      const markdown = '<!-- table-col-widths: 3 1 -->\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('<!-- table-col-widths: 3 1 -->');
    });

    it('round-trips per-table col-widths for HTML tables via data-col-widths', async () => {
      const markdown = '---\npipe-table-max-line-width: 0\n---\n\n<table data-col-widths="2,1">\n  <tr>\n    <td>A</td>\n    <td>B</td>\n  </tr>\n</table>';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('data-col-widths="2 1"');
    });

    it('directives appear before sentinel comments on round-trip', async () => {
      // Use table-font-size: 8 (differs from auto-shrink default of 9pt) so it survives round-trip
      const markdown = '---\ntable-font-size: 10\n---\n\n<!-- table-font-size: 8 -->\n\n<!-- Begin Table -->\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const lines = converted.markdown.split('\n');
      const fontSizeLine = lines.findIndex(l => l.includes('table-font-size: 8'));
      const sentinelLine = lines.findIndex(l => l.includes('Begin Table'));
      expect(fontSizeLine).toBeGreaterThanOrEqual(0);
      expect(sentinelLine).toBeGreaterThanOrEqual(0);
      // Directive must come before the sentinel, preserving original order
      expect(fontSizeLine).toBeLessThan(sentinelLine);
    });

    it('auto directive overrides frontmatter default', async () => {
      const markdown = '---\ntable-col-widths: 2 1\n---\n\n<!-- table-col-widths: auto -->\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(result.docx);
      const docXml = await zip.file('word/document.xml')!.async('string');
      // The table with auto should have tblW auto (no column widths)
      // Note: there's only one table, so check for auto
      expect(docXml).toContain('<w:tblW w:w="0" w:type="auto"/>');
    });

    it('round-trips col-widths directive on a footnote table', async () => {
      const markdown = 'Text[^fn1]\n\n[^fn1]: <!-- table-col-widths: 3 1 -->\n\n    | A | B |\n    |---|---|\n    | 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('table-col-widths: 3 1');
    });

    it('round-trips col-widths directive on a later footnote table', async () => {
      const markdown = 'Text[^fn1]\n\n[^fn1]: Intro paragraph.\n\n    <!-- table-col-widths: 2 1 -->\n\n    | A | B |\n    |---|---|\n    | 1 | 2 |';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      expect(converted.markdown).toContain('table-col-widths: 2 1');
    });

    it('directive before table inside landscape fence does not hoist past sentinel', async () => {
      const markdown = '<!-- landscape -->\n\n<!-- table-col-widths: 3 1 -->\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<!-- /landscape -->';
      const result = await convertMdToDocx(markdown);
      const { convertDocx } = await import('./converter');
      const converted = await convertDocx(result.docx);
      const md = converted.markdown;
      // The landscape sentinel must appear before the col-widths directive
      const landscapeIdx = md.indexOf('<!-- landscape -->');
      const colWidthsIdx = md.indexOf('<!-- table-col-widths:');
      expect(landscapeIdx).toBeGreaterThanOrEqual(0);
      expect(colWidthsIdx).toBeGreaterThan(landscapeIdx);
    });
  });
});
