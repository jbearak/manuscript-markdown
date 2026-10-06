import { describe, it, expect } from 'bun:test';
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { join } from 'path';
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

    // A tracked change's record of what a style was (w:rPrChange,
    // w:pPrChange), which Word doesn't show, goes as it was, last in its
    // container, as the schema has it
    it.each([
      ['properties to change', '<w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="32"/><w:szCs w:val="32"/>',
        '<w:jc w:val="center"/><w:outlineLvl w:val="0"/>', '<w:sz w:val="40"/><w:szCs w:val="40"/>'],
      // What's written goes before the record
      ['no properties to change', '', '<w:b/>', '<w:jc w:val="center"/>', '<w:sz w:val="40"/><w:szCs w:val="40"/>'],
    ])('changes a heading\'s own properties and leaves the records of its tracked changes as they were, with %s', async (_name, pPr, rPr, ownPPr, ownSize) => {
      const JSZip = (await import('jszip')).default;
      const { convertDocx } = await import('./converter');
      const pPrChange = '<w:pPrChange w:id="1" w:author="A"><w:pPr><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr></w:pPrChange>';
      const rPrChange = '<w:rPrChange w:id="2" w:author="A"><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:rPrChange>';
      const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n')).docx);
      const styles = await zip.file('word/styles.xml')!.async('string');
      const heading1 = /(<w:style\b[^>]*w:styleId="Heading1"[^>]*>)[\s\S]*?(<\/w:style>)/;
      expect(styles).toMatch(heading1);
      zip.file('word/styles.xml', styles.replace(heading1, (_match, open: string, close: string) => open + '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr>' + pPr + pPrChange + '</w:pPr><w:rPr>' + rPr + rPrChange + '</w:rPr>' + close));
      const templateDocx = await zip.generateAsync({ type: 'uint8array' });
      const md = '---\nheader-font: Georgia\nheader-font-size: 20\nheader-font-style: bold-center\n---\n\n# One\n';
      const heading1Of = async (docx: Uint8Array) => extractStyleBlock(await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string'), 'Heading1')!;
      const docx = (await convertMdToDocx(md, { templateDocx })).docx;
      const block = await heading1Of(docx);
      // What the style is now changes
      expect(block).toContain('<w:pPr>' + ownPPr + pPrChange + '</w:pPr>');
      expect(block).toContain(ownSize + rPrChange + '</w:rPr>');
      expect(block).toContain('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>');
      const { markdown } = await convertDocx(docx);
      const { headerFont, headerFontSize, headerFontStyle } = parseFrontmatter(md).metadata;
      expect(parseFrontmatter(markdown).metadata).toMatchObject({ headerFont, headerFontSize, headerFontStyle });
      expect(await heading1Of((await convertMdToDocx(markdown, { templateDocx: docx })).docx)).toBe(block);
    });

    // Import reads a style as it is now too, so a font style a tracked
    // change's record holds, which Word doesn't show, doesn't come back to be
    // applied again. A heading's rPr or pPr that's left with only its record
    // stays, as the record needs it
    it.each([
      ['an rPr left with only its record', '<w:outlineLvl w:val="0"/>', '<w:b/>', '<w:outlineLvl w:val="0"/>', ''],
      ['a pPr left with only its record', '<w:jc w:val="center"/>', '<w:sz w:val="32"/><w:szCs w:val="32"/>', '', '<w:sz w:val="32"/><w:szCs w:val="32"/>'],
    ])('a heading whose tracked changes\' records hold another font style reads back as export gave it, with %s', async (_name, pPr, rPr, ownPPr, ownRPr) => {
      const JSZip = (await import('jszip')).default;
      const { convertDocx } = await import('./converter');
      const pPrChange = '<w:pPrChange w:id="1" w:author="A"><w:pPr><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr></w:pPrChange>';
      const rPrChange = '<w:rPrChange w:id="2" w:author="A"><w:rPr><w:b/><w:i/><w:u w:val="single"/></w:rPr></w:rPrChange>';
      const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n')).docx);
      const styles = await zip.file('word/styles.xml')!.async('string');
      const heading1 = /(<w:style\b[^>]*w:styleId="Heading1"[^>]*>)[\s\S]*?(<\/w:style>)/;
      expect(styles).toMatch(heading1);
      zip.file('word/styles.xml', styles.replace(heading1, (_match, open: string, close: string) => open + '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr>' + pPr + pPrChange + '</w:pPr><w:rPr>' + rPr + rPrChange + '</w:rPr>' + close));
      const templateDocx = await zip.generateAsync({ type: 'uint8array' });
      const md = '---\nheader-font-style: normal\n---\n\n# One\n';
      const heading1Of = async (docx: Uint8Array) => extractStyleBlock(await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string'), 'Heading1')!;
      const docx = (await convertMdToDocx(md, { templateDocx })).docx;
      const block = await heading1Of(docx);
      expect(block).toContain('<w:pPr>' + ownPPr + pPrChange + '</w:pPr><w:rPr>' + ownRPr + rPrChange + '</w:rPr>');
      const { markdown } = await convertDocx(docx);
      expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(parseFrontmatter(md).metadata.headerFontStyle);
      expect(await heading1Of((await convertMdToDocx(markdown, { templateDocx: docx })).docx)).toBe(block);
    });

    // Export reads and changes a template's Normal, document defaults,
    // Bibliography and alert styles as they are now, as Word shows them, so
    // with tracked changes' records of what they were it writes what it
    // writes without them, and the records as they were
    it.each([
      ['the hanging indent', ''],
      ['no hanging indent', 'bibliography-hanging-indent: false\n'],
    ])('exports with a template\'s records of tracked changes of its styles as without them, and keeps the records, with %s', async (_name, fields) => {
      const JSZip = (await import('jszip')).default;
      const records = [
        '<w:pPrChange w:id="11" w:author="A"><w:pPr><w:spacing w:after="999" w:line="999" w:lineRule="auto"/></w:pPr></w:pPrChange>',
        '<w:rPrChange w:id="12" w:author="A"><w:rPr><w:rFonts w:ascii="Recorded" w:hAnsi="Recorded"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:rPrChange>',
        '<w:pPrChange w:id="13" w:author="A"><w:pPr><w:spacing w:after="999"/></w:pPr></w:pPrChange>',
        '<w:pPrChange w:id="14" w:author="A"><w:pPr><w:ind w:left="1" w:hanging="1"/></w:pPr></w:pPrChange>',
        '<w:pPrChange w:id="15" w:author="A"><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="4" w:color="123456"/></w:pBdr></w:pPr></w:pPrChange>',
      ];
      const withoutRecords = (xml: string) => records.reduce((text, record) => text.split(record).join(''), xml);
      const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n')).docx);
      let styles = await zip.file('word/styles.xml')!.async('string');
      const restyle = (id: string, inner: string) => {
        const style = new RegExp('(<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>)[\\s\\S]*?(</w:style>)');
        expect(styles).toMatch(style);
        styles = styles.replace(style, (_match, open: string, close: string) => open + inner + close);
      };
      restyle('Normal', '<w:name w:val="Normal"/><w:qFormat/><w:pPr>' + records[0] + '</w:pPr><w:rPr>' + records[1] + '</w:rPr>');
      restyle('Bibliography', '<w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:pPr>' + records[3] + '</w:pPr>');
      restyle('GitHubNote', '<w:name w:val="GitHub Note"/><w:basedOn w:val="Normal"/><w:pPr>' + records[4] + '</w:pPr>');
      expect(styles).toMatch(/<w:pPrDefault><w:pPr>[\s\S]*?<\/w:pPr><\/w:pPrDefault>/);
      styles = styles.replace(/<w:pPrDefault><w:pPr>[\s\S]*?<\/w:pPr><\/w:pPrDefault>/, () => '<w:pPrDefault><w:pPr>' + records[2] + '</w:pPr></w:pPrDefault>');
      const md = '---\nline-spacing: double\n' + fields + 'styles:\n  epigraph:\n    font-style: bold\n---\n\n# One\n\n> [!NOTE]\n> Noted.\n\n| h |\n|---|\n| c |\n\n<!-- style: epigraph -->\n\nStyled\n\n<!-- /style -->\n';
      const exported = async (template: string) => {
        zip.file('word/styles.xml', template);
        const docx = (await convertMdToDocx(md, { templateDocx: await zip.generateAsync({ type: 'uint8array' }) })).docx;
        const out = await JSZip.loadAsync(docx);
        // Each export gives its paragraphs IDs of their own
        return Promise.all(['word/styles.xml', 'word/document.xml'].map(async path =>
          (await out.file(path)!.async('string')).replace(/ (?:w14:paraId|w14:textId|w:rsid\w*)="[^"]*"/g, '')));
      };
      const [withRecords, document] = await exported(styles);
      // Each as it was, last in its container
      for (const record of records) expect(withRecords).toContain(record + (record.startsWith('<w:pPrChange') ? '</w:pPr>' : '</w:rPr>'));
      // A pPr or rPr that holds only its record stays for it, where without
      // the record it may go
      const asWithout = (xml: string) => withoutRecords(xml).replace(/<w:([pr])Pr><\/w:\1Pr>/g, '');
      const [without, withoutDocument] = await exported(withoutRecords(styles));
      expect([asWithout(withRecords), document]).toEqual([asWithout(without), withoutDocument]);
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

    const html = (attribute: string) => '<table ' + attribute + '>\n  <tr>\n    <td>\n      <p>A</p>\n    </td>\n  </tr>\n</table>\n';
    it.each([
      ['a pipe table\'s font size, the automatic size, 2pt under the body\'s', '<!-- table-font-size: 9 -->\n| A |\n| --- |\n| 1 |\n'],
      ['a pipe table\'s font size, the frontmatter\'s', '---\ntable-font-size: 8\n---\n\n<!-- table-font-size: 8 -->\n| A |\n| --- |\n| 1 |\n'],
      ['a pipe table\'s font, the frontmatter\'s', '---\ntable-font: Arial\n---\n\n<!-- table-font: Arial -->\n| A |\n| --- |\n| 1 |\n'],
      ['a pipe table\'s column widths, the frontmatter\'s', '---\ntable-col-widths: 30 70\n---\n\n<!-- table-col-widths: 30 70 -->\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'],
      ['an HTML table\'s font size, the automatic size', html('data-font-size="9"')],
      ['an HTML table\'s font, the frontmatter\'s', '---\ntable-font: Arial\n---\n\n' + html('data-font="Arial"')],
    ])('keeps %s, as the table keeps it if the document\'s changes', async (_, markdown) => {
      // Export kept a table's own value only where it differed from the
      // document's, so import left the table without it
      const { convertDocx } = await import('./converter');
      const once = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
      expect(once).toBe(markdown);
      expect((await convertDocx((await convertMdToDocx(once)).docx)).markdown).toBe(once);
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

    it.each([
      ['a blank line', 'A\n\n<!-- table-font-size: 7 -->\n\n<!-- c -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nD\n'],
      ['no blank line', 'A\n\n<!-- table-font-size: 7 -->\n<!-- c -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nD\n'],
      ['two comments, each with its gap', 'A\n\n<!-- table-font: Arial -->\n<!-- table-col-widths: 2 1 -->\n\n\n<!-- c -->\n<!-- d -->\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
      ['the comment first in the document', '<!-- table-font-size: 7 -->\n\n<!-- c -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
    ])('directives before a comment before a table keep their place with %s between', async (_name, markdown) => {
      const { convertDocx } = await import('./converter');
      const trip = async (md: string) => (await convertDocx((await convertMdToDocx(md)).docx)).markdown;
      const first = await trip(markdown);
      expect(first).toBe(markdown);
      expect(await trip(first)).toBe(first);
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

// XML allows any whitespace between an element's name and its attributes,
// and between attributes, as a line break where a tool wraps long lines
describe('styles with other whitespace before an attribute', () => {
  const md = '---\nheader-font-size: 20\nheader-font-style: bold-underline-center\nstyles:\n  pullquote:\n    font: Georgia\n---\n\n# One\n\n<!-- style: pullquote -->\n\nStyled text.\n\n<!-- /style -->\n';

  it.each([
    ['a line break before a style\'s first attribute', '<w:style w:', '<w:style\n  w:'],
    ['two spaces before a size', '<w:sz w:val=', '<w:sz  w:val='],
    ['a line break before an underline\'s value', '<w:u w:val=', '<w:u\n  w:val='],
    ['two spaces before a centering\'s value', '<w:jc w:val=', '<w:jc  w:val='],
    // Only the underline's own value turns it off
    ['an underline beside another property that is none', '<w:u w:val="single"/>', '<w:u w:val="single"/><w:effect w:val="none"/>'],
  ])('a heading\'s and a custom style\'s font reads back with %s', async (_name, from, to) => {
    const { convertDocx } = await import('./converter');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    // Without the copy export keeps, custom styles come from styles.xml
    zip.remove('docProps/custom.xml');
    zip.file('word/styles.xml', (await zip.file('word/styles.xml')!.async('string')).split(from).join(to));
    const { metadata } = parseFrontmatter((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect([metadata.headerFontSize, metadata.headerFontStyle, metadata.styles?.pullquote?.font]).toEqual([[20], ['bold-underline-center'], 'Georgia']);
  });
});

// An XML parser reads an attribute with whitespace around its =, and its
// value in single quotes as in double, as other tools may write them
describe('styles with attributes spelled other ways', () => {
  /** A document's styles.xml, as `edit` makes it, read back, without the
   *  copy of custom styles export keeps, so they come from styles.xml */
  const editedStyles = async (markdown: string, edit: (styles: string) => string) => {
    const { convertDocx } = await import('./converter');
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    zip.remove('docProps/custom.xml');
    const styles = await zip.file('word/styles.xml')!.async('string');
    zip.file('word/styles.xml', edit(styles));
    return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
  };

  it('reads the table paragraph style\'s font with whitespace around its attribute\'s =', async () => {
    // The frontmatter read only w:ascii=", so it had no table-font, and the
    // next export gave tables the theme's font
    const { convertDocx } = await import('./converter');
    const converted = await editedStyles('---\ntable-font: Courier New\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n', styles => {
      const edited = styles.replace(/(<w:style\b[^>]*w:styleId="TableParagraph"[\s\S]*?)<w:rFonts [^>]*\/>/,
        (_style, before: string) => before + '<w:rFonts w:ascii = "Courier New" w:hAnsi = "Courier New"/>');
      expect(edited).toContain('w:ascii = "Courier New"');
      return edited;
    });
    expect(parseFrontmatter(converted).metadata.tableFont).toBe('Courier New');
    expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
  });

  // A value for each of the frontmatter's fields that it reads from
  // styles.xml, by its fonts, sizes, toggles, centering, base, name, type,
  // spacing and indent
  const markdown = '---\ntitle: T\nfont: Georgia\nfont-size: 12\nheader-font: Verdana\nheader-font-size: 20\nheader-font-style: italic-underline-center\n'
    + 'title-font: Palatino\ntitle-font-size: 30\ntable-font: Courier New\ntable-font-size: 8\ncode-font: Menlo\ncode-font-size: 9\n'
    + 'styles:\n  pullquote:\n    font: Garamond\n    font-size: 13\n    spacing-before: 6\n    spacing-after: 12\n    paragraph-indent: 0.5\n---\n\n'
    + '# One\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```\n\n<!-- style: pullquote -->\n\nStyled text.\n\n<!-- /style -->\n';
  const quoted = (value: string) => value.includes("'") ? '"' + value + '"' : "'" + value + "'";
  it.each([
    ['in double quotes', (name: string, value: string) => name + '="' + value + '"'],
    ['with spaces around the =', (name: string, value: string) => name + ' = "' + value + '"'],
    ['in single quotes', (name: string, value: string) => name + '=' + quoted(value)],
    ['with a line break and a tab around the =, in single quotes', (name: string, value: string) => name + '\n\t=\t' + quoted(value)],
  ])('reads each style\'s fonts, sizes and settings with every attribute %s', async (name, spell) => {
    // Every attribute of every element of styles.xml but its declaration
    const converted = await editedStyles(markdown, styles => {
      const edited = styles.replace(/(<[^\s/>!?]+)((?:\s+[^\s=/>]+="[^"]*")+)/g, (_tag, start: string, attributes: string) =>
        start + attributes.replace(/(\s+)([^\s=/>]+)="([^"]*)"/g, (_attribute, space: string, attribute: string, value: string) => space + spell(attribute, value)));
      expect(edited === styles).toBe(name === 'in double quotes');
      return edited;
    });
    const { metadata } = parseFrontmatter(converted);
    expect([metadata.font, metadata.fontSize, metadata.headerFont, metadata.headerFontSize, metadata.headerFontStyle, metadata.titleFont, metadata.titleFontSize,
      metadata.tableFont, metadata.tableFontSize, metadata.codeFont, metadata.codeFontSize, metadata.styles?.pullquote]).toEqual(['Georgia', 12, ['Verdana'], [20],
      ['italic-underline-center'], ['Palatino'], [30], 'Courier New', 8, 'Menlo', 9, { font: 'Garamond', fontSize: 13, spacingBefore: 6, spacingAfter: 12, paragraphIndent: 0.5 }]);
  });
});

describe('empty run and paragraph properties', () => {
  // Word strips an empty w:rPr or w:pPr on open and marks the document
  // changed (dirty-flag invariant #5)
  const EMPTY_PROPERTIES = /<w:(rPr|pPr)(?:\s*\/>|>\s*<\/w:\1>)/;
  const body = '# One\n\n#### Four\n\n###### Six\n\nText *i* `code`[^1]\n\n[^1]: Note.\n\n> quote\n\n```\ncode\n```\n\n' +
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n<!-- style: epigraph -->\n\nStyled\n\n<!-- /style -->\n';
  const frontmatters = [
    '',
    'font: Georgia\nfont-size: 12\ncode-font: Menlo\ntable-font: Arial\nheader-font: Palatino',
    'header-font-style: normal',
    'header-font-style: center',
    'header-font-style: italic, normal, center, normal',
    'title-font-style: normal\ntitle-font-size: 20',
    'line-spacing: double\nparagraph-indent: none\nblockquote-style: Quote',
    'styles:\n  epigraph:\n    spacing-before: 12',
    'styles:\n  epigraph:\n    font-style: normal',
    'styles:\n  epigraph:\n    font-style: center\n    paragraph-indent: none',
  ];
  const markdown = (fields: string) => '---\ntitle: Title\n' + fields + '\n---\n\n' + body;

  /** A template whose Title holds only a centering pPr, which a title style
   *  that isn't centered removes, and whose Heading 2 has no rPr */
  async function barePropertiesTemplate(): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown(''))).docx);
    const style = (id: string, inner: string) => (xml: string) => xml.replace(
      new RegExp('(<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>)[\\s\\S]*?(</w:style>)'),
      (_match, open: string, close: string) => open + inner + close);
    const styles = [
      style('Title', '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr>'),
      style('Heading2', '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'),
    ].reduce((xml, edit) => edit(xml), await zip.file('word/styles.xml')!.async('string'));
    zip.file('word/styles.xml', styles);
    return zip.generateAsync({ type: 'uint8array' });
  }

  async function emptyProperties(md: string, templateDocx?: Uint8Array): Promise<string[]> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md, templateDocx ? { templateDocx } : undefined)).docx);
    const found: string[] = [];
    for (const part of ['word/styles.xml', 'word/document.xml']) {
      const xml = await zip.file(part)!.async('string');
      for (const style of xml.match(/<w:style\b[\s\S]*?<\/w:style>|<w:body>[\s\S]*<\/w:body>/g) ?? []) {
        if (EMPTY_PROPERTIES.test(style)) found.push(part + ': ' + (/w:styleId="([^"]*)"/.exec(style)?.[1] ?? 'body'));
      }
    }
    return found;
  }

  it('none in styles.xml or document.xml, with or without a template', async () => {
    const templates: Array<[string, Uint8Array | undefined]> = [
      ['no template', undefined],
      ['export\'s own', (await convertMdToDocx(markdown(''))).docx],
      ['bare properties', await barePropertiesTemplate()],
      ['sample.docx', new Uint8Array(readFileSync(join(__dirname, '..', 'test', 'fixtures', 'sample.docx')))],
    ];
    const found: string[] = [];
    for (const [name, template] of templates) {
      for (const fields of frontmatters) {
        for (const empty of await emptyProperties(markdown(fields), template)) found.push(name + ' | ' + JSON.stringify(fields) + ' | ' + empty);
      }
    }
    expect(found).toEqual([]);
  });

  it.each(['normal', 'center', 'italic, normal, center, normal'])('heading font style %s, which leaves Heading 4 no rPr, reads back', async (style) => {
    const { convertDocx } = await import('./converter');
    const md = '---\nheader-font-style: ' + style + '\n---\n\n#### Four\n';
    for (const templateDocx of [undefined, (await convertMdToDocx(markdown(''))).docx]) {
      const { markdown: back } = await convertDocx((await convertMdToDocx(md, templateDocx ? { templateDocx } : undefined)).docx);
      expect(parseFrontmatter(back).metadata.headerFontStyle).toEqual(parseFrontmatter(md).metadata.headerFontStyle);
    }
  });

  it('a heading or title style that changes nothing else keeps its other properties', async () => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown('title-font-style: italic\nheader-font-style: normal'), { templateDocx: await barePropertiesTemplate() })).docx);
    const styles = await zip.file('word/styles.xml')!.async('string');
    expect(extractStyleBlock(styles, 'Title')).toBe('<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>');
    expect(extractStyleBlock(styles, 'Heading2')).toBe('<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>');
    expect(extractStyleBlock(styles, 'Heading4')).not.toContain('<w:rPr');
  });
});

describe('heading and title styles based on another style', () => {
  const doc = '---\ntitle: Title\n---\n\n# One\n\n## Two\n\n### Three\n';
  const heading = (level: number, inner: string) => ['Heading' + level, '<w:name w:val="heading ' + level + '"/>' + inner] as [string, string];

  /** Export's own Word file with the given styles' content replaced, a style
   *  ID of rPrDefault or pPrDefault giving the document defaults' properties */
  async function withStyles(...replaced: Array<[string, string]>): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync((await convertMdToDocx(doc)).docx);
    let styles = await zip.file('word/styles.xml')!.async('string');
    for (const [id, inner] of replaced) {
      const defaults = /^(r|p)PrDefault$/.exec(id);
      if (defaults) {
        styles = styles.replace(new RegExp('(<w:' + id + '>)(?:<w:' + defaults[1] + 'Pr>[\\s\\S]*?</w:' + defaults[1] + 'Pr>)?'),
          (_match, open: string) => open + '<w:' + defaults[1] + 'Pr>' + inner + '</w:' + defaults[1] + 'Pr>');
        continue;
      }
      styles = styles.replace(new RegExp('(<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>)[\\s\\S]*?(</w:style>)'),
        (_match, open: string, close: string) => open + inner + close);
    }
    zip.file('word/styles.xml', styles);
    return zip.generateAsync({ type: 'uint8array' });
  }

  // A style inherits what it doesn't set from the style it's based on, so an
  // empty or missing rPr or pPr means inherit, not normal
  it.each([
    ['no rPr, based on a bold heading', [heading(2, '<w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], undefined, undefined],
    ['an rPr without bold, based on a bold heading', [heading(2, '<w:basedOn w:val="Heading1"/><w:rPr><w:color w:val="FF0000"/></w:rPr>')], undefined, undefined],
    ['bold turned off, based on a bold heading', [heading(2, '<w:basedOn w:val="Heading1"/><w:rPr><w:b w:val="0"/></w:rPr>')], ['bold', 'normal', 'bold'], undefined],
    ['no rPr or pPr, based on an italic, centered heading',
      [heading(1, '<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:i/></w:rPr>'), heading(2, '<w:basedOn w:val="Heading1"/>')],
      ['italic-center', 'italic-center', 'bold'], undefined],
    ['no rPr, based on Normal', [heading(2, '<w:basedOn w:val="Normal"/>')], ['bold', 'normal', 'bold'], undefined],
    ['a title with no rPr, based on a bold heading', [['Title', '<w:name w:val="Title"/><w:basedOn w:val="Heading1"/>']], undefined, ['bold']],
    ['styles based on each other', [heading(1, '<w:basedOn w:val="Heading2"/>'), heading(2, '<w:basedOn w:val="Heading1"/>')], ['normal', 'normal', 'bold'], undefined],
  ] as Array<[string, Array<[string, string]>, string[] | undefined, string[] | undefined]>)('%s reads back as the style shows', async (_name, replaced, headerFontStyle, titleFontStyle) => {
    const { convertDocx } = await import('./converter');
    const { markdown } = await convertDocx(await withStyles(...replaced));
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.headerFontStyle).toEqual(headerFontStyle);
    expect(metadata.titleFontStyle).toEqual(titleFontStyle);
    // Without the template, export gives each style what it showed
    const again = (await convertMdToDocx(markdown)).docx;
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // A style's own toggle property, such as bold, decides it rather than
  // toggling what its base gives (see inheritedStyle in converter.ts); caps
  // win over small caps; and the document defaults are the base of all
  it.each([
    ['bold set again on a bold heading\'s', [heading(2, '<w:basedOn w:val="Heading1"/><w:rPr><w:b/></w:rPr>')], undefined, undefined],
    ['bold set again on a bold title\'s base and its base', [heading(1, '<w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr>'),
      heading(2, '<w:basedOn w:val="Heading1"/><w:rPr><w:b/></w:rPr>'), ['Title', '<w:name w:val="Title"/><w:basedOn w:val="Heading2"/><w:rPr><w:b/></w:rPr>']],
    undefined, ['bold']],
    ['small caps on an all caps heading', [heading(1, '<w:basedOn w:val="Normal"/><w:rPr><w:caps/></w:rPr>'), heading(2, '<w:basedOn w:val="Heading1"/><w:rPr><w:smallCaps/></w:rPr>')],
      ['allcaps', 'allcaps', 'bold'], undefined],
    ['small caps beside all caps', [heading(2, '<w:basedOn w:val="Normal"/><w:rPr><w:b/><w:smallCaps/><w:caps/></w:rPr>')], ['bold', 'bold-allcaps', 'bold'], undefined],
    ['bold from the document defaults', [['rPrDefault', '<w:b/><w:sz w:val="24"/>'], heading(2, '<w:basedOn w:val="Normal"/>')], undefined, ['bold']],
    ['centering and italic from the document defaults', [['pPrDefault', '<w:jc w:val="center"/>'], ['rPrDefault', '<w:i/>'], heading(2, '<w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr>')],
      ['bold-italic-center'], ['italic-center']],
    ['bold the style turns off over the document defaults', [['rPrDefault', '<w:b/>'], heading(2, '<w:basedOn w:val="Normal"/><w:rPr><w:b w:val="0"/></w:rPr>')],
      ['bold', 'normal', 'bold'], ['bold']],
    // An element with a closing tag means what a self-closing one does
    ['bold from Normal, as <w:b></w:b>', [['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:b></w:b></w:rPr>'], heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')],
      undefined, ['bold']],
    ['bold turned off with a closing tag', [heading(2, '<w:basedOn w:val="Heading1"/><w:rPr><w:b w:val="0"></w:b></w:rPr>')], ['bold', 'normal', 'bold'], undefined],
    ['centering from Normal, with a closing tag', [['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"></w:jc></w:pPr>']], ['bold-center'], ['center']],
    // A tracked change's record of what a style was isn't what Word shows
    ['a heading with a tracked change\'s record of the italic and centering it had',
      [heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/><w:pPrChange w:id="1" w:author="A"><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange></w:pPr>' +
        '<w:rPr><w:b/><w:rPrChange w:id="2" w:author="A"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>')], undefined, undefined],
    ['the document defaults with a tracked change\'s record of the italic and centering they had',
      [['pPrDefault', '<w:pPrChange w:id="1" w:author="A"><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange>'],
        ['rPrDefault', '<w:rPrChange w:id="2" w:author="A"><w:rPr><w:i/></w:rPr></w:rPrChange>'], heading(2, '<w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr>')], undefined, undefined],
    ['no rPr, based on a bold heading through a w:basedOn with a line break', [heading(2, '<w:basedOn\n  w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], undefined, undefined],
  ] as Array<[string, Array<[string, string]>, string[] | undefined, string[] | undefined]>)('%s reads back as Word shows it', async (_name, replaced, headerFontStyle, titleFontStyle) => {
    const { convertDocx } = await import('./converter');
    const { markdown } = await convertDocx(await withStyles(...replaced));
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.headerFontStyle).toEqual(headerFontStyle);
    expect(metadata.titleFontStyle).toEqual(titleFontStyle);
    const again = (await convertMdToDocx(markdown)).docx;
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // Export keeps a template style's reset of what its base turns on
  it.each([
    ['italic', [['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:i/></w:rPr>'],
      heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:i w:val="0"/></w:rPr>')]],
    ['centering', [['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr>'],
      heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr>')]],
  ] as Array<[string, Array<[string, string]>]>)('a heading that turns off the %s its base turns on keeps that with the document as its template', async (_name, replaced) => {
    const { convertDocx } = await import('./converter');
    const original = await withStyles(...replaced);
    const { markdown } = await convertDocx(original);
    const again = (await convertMdToDocx(markdown, { templateDocx: original })).docx;
    const stylesOf = async (docx: Uint8Array) => (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string');
    expect(extractStyleBlock(await stylesOf(again), 'Heading2')).toBe(extractStyleBlock(await stylesOf(original), 'Heading2'));
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // Export writes a title's font style on its runs too, over the Title
  // style's, and its centering on its paragraph, which Word shows
  it.each([
    ['italic its style inherits, turned off on its runs', [['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:i/></w:rPr>'],
      ['Title', '<w:name w:val="Title"/><w:basedOn w:val="Normal"/>']], ['T'], ['bold']],
    ['each of two titles', [], ['A', 'B'], ['bold', 'italic']],
    ['the centering of each of two titles', [], ['A', 'B'], ['center', 'normal']],
  ] as Array<[string, Array<[string, string]>, string[], string[]]>)('a title\'s font style on its runs and paragraph reads back: %s', async (_name, replaced, title, titleFontStyle) => {
    const { convertDocx } = await import('./converter');
    const templateDocx = await withStyles(...replaced);
    const md = '---\n' + title.map(line => 'title: ' + line + '\n').join('') + 'title-font-style: [' + titleFontStyle.join(', ') + ']\n---\n\nText.\n';
    const docx = (await convertMdToDocx(md, { templateDocx })).docx;
    const { metadata } = parseFrontmatter((await convertDocx(docx)).markdown);
    expect([metadata.title, metadata.titleFontStyle]).toEqual([title, titleFontStyle]);
  });

  // A title's style by the ID the document gives it, as Word does in German
  it('a title\'s font style on its runs reads back where the document gives the Title style another ID', async () => {
    const { convertDocx } = await import('./converter');
    const zip = await JSZip.loadAsync((await convertMdToDocx('---\ntitle: A\ntitle: B\ntitle-font-style: [bold, italic]\n---\n\nText.\n')).docx);
    for (const part of ['word/styles.xml', 'word/document.xml']) {
      zip.file(part, (await zip.file(part)!.async('string')).split('w:styleId="Title"').join('w:styleId="Titel"').split('<w:pStyle w:val="Title"/>').join('<w:pStyle w:val="Titel"/>'));
    }
    const { metadata } = parseFrontmatter((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect([metadata.title, metadata.titleFontStyle]).toEqual([['A', 'B'], ['bold', 'italic']]);
  });

  // A tracked change keeps what a title's runs and paragraph had before it,
  // which Word doesn't show
  it.each([
    ['bold a run had', '<w:r><w:t>T</w:t>', '<w:r><w:rPr><w:rPrChange w:id="90" w:author="A" w:date="2026-01-01T00:00:00Z"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>T</w:t>'],
    ['centering the paragraph had', '<w:pStyle w:val="Title"/>', '<w:pStyle w:val="Title"/><w:pPrChange w:id="91" w:author="A" w:date="2026-01-01T00:00:00Z"><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange>'],
  ])('a title\'s font style leaves out the %s before a tracked change', async (_name, from, to) => {
    const { convertDocx } = await import('./converter');
    const zip = await JSZip.loadAsync((await convertMdToDocx('---\ntitle: T\n---\n\nText.\n')).docx);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    expect(documentXml).toContain(from);
    zip.file('word/document.xml', documentXml.replace(from, () => to));
    const { metadata } = parseFrontmatter((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect([metadata.title, metadata.titleFontStyle]).toEqual([['T'], undefined]);
  });

  // A paragraph that was a title, whose tracked change records the Title
  // style it had, isn't one
  it('a title\'s font style comes from the title, not an empty paragraph before it that was one', async () => {
    const { convertDocx } = await import('./converter');
    const zip = await JSZip.loadAsync((await convertMdToDocx('---\ntitle: T\ntitle-font-style: center\n---\n\nText.\n')).docx);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    expect(documentXml).toContain('<w:body>');
    zip.file('word/document.xml', documentXml.replace('<w:body>', () => '<w:body><w:p><w:pPr><w:jc w:val="left"/>' +
      '<w:pPrChange w:id="92" w:author="A" w:date="2026-01-01T00:00:00Z"><w:pPr><w:pStyle w:val="Title"/></w:pPr></w:pPrChange></w:pPr></w:p>'));
    const { markdown } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    const { metadata } = parseFrontmatter(markdown);
    expect([metadata.title, metadata.titleFontStyle]).toEqual([['T'], ['center']]);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  // An empty paragraph that only carries a section break isn't a title,
  // though it has the Title style, as import leaves it out
  it('a title\'s font style comes from the title, not a section break\'s empty paragraph of the Title style before it', async () => {
    const { convertDocx } = await import('./converter');
    const zip = await JSZip.loadAsync((await convertMdToDocx('---\ntitle: T\ntitle-font-style: bold\n---\n\nText.\n')).docx);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    expect(documentXml).toContain('<w:body>');
    zip.file('word/document.xml', documentXml.replace('<w:body>', () => '<w:body><w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/>' +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr></w:p>'));
    const { markdown } = await convertDocx(await zip.generateAsync({ type: 'uint8array' }));
    const { metadata } = parseFrontmatter(markdown);
    expect([metadata.title, metadata.titleFontStyle]).toEqual([['T'], ['bold']]);
    expect((await convertDocx((await convertMdToDocx(markdown)).docx)).markdown).toBe(markdown);
  });

  it('a heading\'s own off goes in schema order among what its font style turns on', async () => {
    const { convertDocx } = await import('./converter');
    const original = await withStyles(['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:i/></w:rPr>'],
      heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:i w:val="0"/></w:rPr>'));
    const docx = (await convertMdToDocx('---\nheader-font-style: [bold, bold-underline]\n---\n\n# One\n\n## Two\n', { templateDocx: original })).docx;
    const styles = await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string');
    expect(extractStyleBlock(styles, 'Heading2')).toContain('<w:rPr><w:b/><w:i w:val="0"/><w:u w:val="single"/></w:rPr>');
    expect(parseFrontmatter((await convertDocx(docx)).markdown).metadata.headerFontStyle?.[1]).toBe('bold-underline');
  });

  it('a heading based on a bold heading stays bold without the template', async () => {
    const { convertDocx } = await import('./converter');
    const { markdown } = await convertDocx(await withStyles(heading(2, '<w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')));
    const styles = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/styles.xml')!.async('string');
    expect(extractStyleBlock(styles, 'Heading2')).toContain('<w:b/>');
  });
});

describe('the styles export takes from a template', () => {
  /** styles.xml of export with `fields` and a template of export's own whose
   *  styles' content is replaced, a style ID of rPrDefault or pPrDefault
   *  giving the document defaults' properties */
  async function exportedStyles(fields: string, ...replaced: Array<[string, string]>): Promise<{ styles: string; docx: Uint8Array }> {
    const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n\n## Two\n')).docx);
    let styles = await zip.file('word/styles.xml')!.async('string');
    for (const [id, inner] of replaced) {
      const defaults = /^(r|p)PrDefault$/.exec(id);
      if (defaults) {
        styles = styles.replace(new RegExp('(<w:' + id + '>)(?:<w:' + defaults[1] + 'Pr>[\\s\\S]*?</w:' + defaults[1] + 'Pr>)?'),
          (_match, open: string) => open + '<w:' + defaults[1] + 'Pr>' + inner + '</w:' + defaults[1] + 'Pr>');
        continue;
      }
      styles = styles.replace(new RegExp('(<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>)[\\s\\S]*?(</w:style>)'),
        (_match, open: string, close: string) => open + inner + close);
    }
    zip.file('word/styles.xml', styles);
    const templateDocx = await zip.generateAsync({ type: 'uint8array' });
    const docx = (await convertMdToDocx('---\n' + fields + '\n---\n\n# One\n\n## Two\n', { templateDocx })).docx;
    return { styles: await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string'), docx };
  }

  // A style's children go name, base and the like, pPr, then rPr
  it.each([
    ['centering a title', 'title: T\ntitle-font-style: center', 'Title', '<w:name w:val="Title"/><w:basedOn w:val="Normal"/>', '<w:rPr><w:sz w:val="56"/></w:rPr>',
      '<w:pPr><w:jc w:val="center"/></w:pPr>'],
    ['line spacing on Normal', 'line-spacing: double', 'Normal', '<w:name w:val="Normal"/><w:qFormat/>', '<w:rPr><w:sz w:val="24"/></w:rPr>',
      '<w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr>'],
    ['the bibliography\'s hanging indent', '', 'Bibliography', '<w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/>', '<w:rPr><w:i/></w:rPr>',
      '<w:pPr><w:ind w:left="720" w:hanging="720"/></w:pPr>'],
  ])('the pPr export adds to a style without one for %s goes in schema order', async (_name, fields, id, head, rPr, pPr) => {
    const { styles } = await exportedStyles(fields, [id, head + rPr]);
    expect(extractStyleBlock(styles, id)).toMatch(/^<w:style\b[^>]*>/);
    expect(extractStyleBlock(styles, id)!.replace(/^<w:style\b[^>]*>/, '')).toBe(head + pPr + rPr + '</w:style>');
  });

  const heading = (level: number, inner: string): [string, string] => ['Heading' + level, '<w:name w:val="heading ' + level + '"/>' + inner];
  // These headings may take their size from Normal, which import may give as
  // header-font-size, and export then writes into each style on a second trip
  const noSize = (block: string | null) => block?.replace(/<w:sz(?:Cs)? w:val="\d+"\/>/g, '').replace('<w:rPr></w:rPr>', '');
  const boldH1 = heading(1, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr>');
  const fullH1 = heading(1, '<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>' +
    '<w:rPr><w:b/><w:i/><w:u w:val="single"/><w:smallCaps/></w:rPr>');
  const onH1 = (inner: string) => heading(2, '<w:basedOn w:val="Heading1"/>' + inner);

  // Word shows what a style's base turns on where the style doesn't set it,
  // so taking the style's own away isn't enough
  it.each([
    ['bold', 'header-font-style: [bold, normal]', [boldH1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>'],
    ['bold, beside the style\'s own color', 'header-font-style: [bold, italic]', [boldH1, onH1('<w:rPr><w:color w:val="FF0000"/></w:rPr>')], 'Heading2',
      '<w:rPr><w:b w:val="0"/><w:i/><w:color w:val="FF0000"/></w:rPr>'],
    ['each font style and centering', 'header-font-style: [bold-italic-underline-smallcaps-center, allcaps]', [fullH1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], 'Heading2',
      '<w:pPr><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/><w:i w:val="0"/><w:caps/><w:smallCaps w:val="0"/><w:u w:val="none"/></w:rPr>'],
    // Heading 1 is bold and centered once restyled, and Heading 2 takes that
    ['centering, where the style has no pPr', 'header-font-style: [bold-center, bold]', [fullH1, onH1('')], 'Heading2',
      '<w:pPr><w:jc w:val="left"/></w:pPr><w:rPr><w:b/></w:rPr>'],
    // w:jc goes before w:textDirection and w:textAlignment in a pPr
    ['centering, where the style has a text alignment and no outline level', 'header-font-style: [bold-center, bold]',
      [fullH1, onH1('<w:pPr><w:textDirection w:val="lrTb"/><w:textAlignment w:val="center"/></w:pPr>')], 'Heading2',
      '<w:pPr><w:jc w:val="left"/><w:textDirection w:val="lrTb"/><w:textAlignment w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr>'],
    // A container with nothing in it, self-closing, is one to fill
    ['bold, where the style has an empty rPr', 'header-font-style: [bold, normal]', [boldH1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr/>')], 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>'],
    ['centering, where the style has an empty pPr', 'header-font-style: [bold-center, bold]', [fullH1, onH1('<w:pPr/>')], 'Heading2',
      '<w:pPr><w:jc w:val="left"/></w:pPr><w:rPr><w:b/></w:rPr>'],
    ['bold, for the title', 'title: T\ntitle-font-style: italic', [boldH1, ['Title', '<w:name w:val="Title"/><w:basedOn w:val="Heading1"/>']], 'Title',
      '<w:rPr><w:b w:val="0"/><w:i/></w:rPr>'],
    ['bold, from the document defaults', 'header-font-style: [bold, italic]', [['rPrDefault', '<w:b/>'], heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/><w:i/></w:rPr>'],
    ['italic, from Normal', 'header-font-style: bold-underline',
      [['Normal', '<w:name w:val="Normal"/><w:rPr><w:i/></w:rPr>'], heading(1, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>')], 'Heading1',
      '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:i w:val="0"/><w:u w:val="single"/></w:rPr>'],
    ['italic, from a style that isn\'t a heading', 'header-font-style: bold-underline',
      [['Quote', '<w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr>'], heading(2, '<w:basedOn w:val="Quote"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:i w:val="0"/><w:u w:val="single"/></w:rPr>'],
  ] as Array<[string, string, Array<[string, string]>, string, string]>)('a heading or title whose font style turns off what its base turns on writes the off: %s', async (_name, fields, replaced, id, expected) => {
    const { convertDocx } = await import('./converter');
    const { styles, docx } = await exportedStyles(fields, ...replaced);
    expect(extractStyleBlock(styles, id)!.replace(/^<w:style\b[^>]*>[\s\S]*?<w:basedOn w:val="[^"]*"\/>/, '')).toBe(expected + '</w:style>');
    const { markdown } = await convertDocx(docx);
    const fieldsBack = parseFrontmatter(markdown).metadata;
    const fieldsSent = parseFrontmatter('---\n' + fields + '\n---\n').metadata;
    expect(fieldsBack.headerFontStyle).toEqual(fieldsSent.headerFontStyle);
    // A title the fields leave alone shows what Normal does
    if (fieldsSent.titleFontStyle) expect(fieldsBack.titleFontStyle).toEqual(fieldsSent.titleFontStyle);
    // Export to Word, which takes the Word file as its template
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), id))).toBe(noSize(extractStyleBlock(styles, id)));
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // Word writes run properties in schema order and reorders others on open,
  // marking the document changed, so what export writes into a template's
  // style, the offs among it, goes in that order with what the style has
  const orderedHeading = (level: number, rPr: string) => heading(level, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="' + (level - 1) + '"/></w:pPr><w:rPr>' + rPr + '</w:rPr>');
  it.each([
    ['all caps over small caps', 'header-font-style: [smallcaps, allcaps]', [orderedHeading(1, '<w:smallCaps/>'), onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')], 'Heading2',
      '<w:caps/><w:smallCaps w:val="0"/>'],
    ['a font, the font style and a size among the style\'s own', 'header-font: Georgia\nheader-font-size: 20\nheader-font-style: [italic-underline-allcaps, normal]',
      [orderedHeading(1, '<w:b/><w:smallCaps/><w:color w:val="2F5496"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:val="en-US"/>')], 'Heading1',
      '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:i/><w:caps/><w:color w:val="2F5496"/><w:sz w:val="40"/><w:szCs w:val="40"/><w:u w:val="single"/><w:lang w:val="en-US"/>'],
    // A size other than its base's, which it would otherwise take from it
    ['the offs a style with no rPr gets, with a font and size', 'header-font: Georgia\nheader-font-size: [20, 18]\nheader-font-style: [bold-italic-underline-smallcaps, allcaps]',
      [orderedHeading(1, '<w:b/><w:i/><w:smallCaps/><w:u w:val="single"/>'), heading(2, '<w:basedOn w:val="Heading1"/>')], 'Heading2',
      '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b w:val="0"/><w:i w:val="0"/><w:caps/><w:smallCaps w:val="0"/><w:sz w:val="36"/><w:szCs w:val="36"/><w:u w:val="none"/>'],
  ] as Array<[string, string, Array<[string, string]>, string, string]>)('the rPr export writes into a template\'s heading goes in schema order: %s', async (_name, fields, replaced, id, expected) => {
    const { convertDocx } = await import('./converter');
    const { styles, docx } = await exportedStyles(fields, ...replaced);
    // The style's rPr, last in it
    expect(/<w:rPr>([\s\S]*)<\/w:rPr><\/w:style>$/.exec(extractStyleBlock(styles, id)!.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ''))?.[1]).toBe(expected);
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(parseFrontmatter('---\n' + fields + '\n---\n').metadata.headerFontStyle);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), id))).toBe(noSize(extractStyleBlock(styles, id)));
  });

  // The style's own off stands for the explicit off, as it comes
  it('a heading that turns off itself what its base turns on keeps its own off, once and in order', async () => {
    const { convertDocx } = await import('./converter');
    const { styles, docx } = await exportedStyles('header-font-style: [bold, bold-underline]', ['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:i/></w:rPr>'],
      heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:i w:val="false"/><w:b/></w:rPr>'));
    expect(extractStyleBlock(styles, 'Heading2')).toContain('<w:rPr><w:b/><w:i w:val="false"/><w:u w:val="single"/></w:rPr>');
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(['bold', 'bold-underline']);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), 'Heading2'))).toBe(noSize(extractStyleBlock(styles, 'Heading2')));
  });

  // <w:b></w:b> turns bold on as <w:b/> does
  it('a heading based on a Normal bold as <w:b></w:b> keeps its style with the document as its template', async () => {
    const { convertDocx } = await import('./converter');
    const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n\n## Two\n')).docx);
    const stylesOf = async (docx: Uint8Array) => (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string');
    zip.file('word/styles.xml', (await zip.file('word/styles.xml')!.async('string'))
      .replace(/(<w:style\b[^>]*w:styleId="Normal"[^>]*>)[\s\S]*?(<\/w:style>)/, (_match, open: string, close: string) => open + '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:b></w:b></w:rPr>' + close)
      .replace(/(<w:style\b[^>]*w:styleId="Heading2"[^>]*>)[\s\S]*?(<\/w:style>)/, (_match, open: string, close: string) => open + heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')[1] + close));
    const original = await zip.generateAsync({ type: 'uint8array' });
    const { markdown } = await convertDocx(original);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toBeUndefined();
    const again = (await convertMdToDocx(markdown, { templateDocx: original })).docx;
    expect(noSize(extractStyleBlock(await stylesOf(again), 'Heading2'))).toBe(noSize(extractStyleBlock(await stylesOf(original), 'Heading2')));
  });

  // w:basedOn may have any whitespace before w:val
  it('a heading based on a bold heading named across a line break turns its bold off', async () => {
    const { convertDocx } = await import('./converter');
    const { styles, docx } = await exportedStyles('header-font-style: [bold, normal]', boldH1, heading(2, '<w:basedOn\n  w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'));
    expect(extractStyleBlock(styles, 'Heading2')).toContain('<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>');
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(['bold', 'normal']);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), 'Heading2'))).toBe(noSize(extractStyleBlock(styles, 'Heading2')));
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  /** A template of export's own whose styles' content is replaced, as
   *  exportedStyles does, then changed by `edit`, and the styles export
   *  gives with `fields` and the template, with the Word file */
  async function exportedWith(fields: string, edit: (styles: string) => string, ...replaced: Array<[string, string]>): Promise<{ styles: string; docx: Uint8Array }> {
    const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n\n## Two\n')).docx);
    let styles = await zip.file('word/styles.xml')!.async('string');
    for (const [id, inner] of replaced) {
      const style = new RegExp('(<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>)[\\s\\S]*?(</w:style>)');
      expect(styles).toMatch(style);
      styles = styles.replace(style, (_match, open: string, close: string) => open + inner + close);
    }
    zip.file('word/styles.xml', edit(styles));
    const docx = (await convertMdToDocx('---\n' + fields + '\n---\n\n# One\n\n## Two\n', { templateDocx: await zip.generateAsync({ type: 'uint8array' }) })).docx;
    return { styles: await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string'), docx };
  }

  // A style is found as import finds it: by the template's ID for a built-in
  // style, which Word in another language gives one, as `berschrift1` for
  // Heading 1, and with a style written as <w:style .../> before it, which the
  // next </w:style> doesn't close
  const GERMAN: Record<string, string> = { Normal: 'Standard', Heading1: 'berschrift1', Heading2: 'berschrift2' };
  const german = (styles: string) => styles.replace(/(w:styleId="|<w:(?:basedOn|next|link) w:val=")([A-Za-z0-9]+)"/g,
    (match, before: string, id: string) => GERMAN[id] ? before + GERMAN[id] + '"' : match);
  const plainBeforeHeading1 = (styles: string) => styles.replace(/<w:style\b[^>]*w:styleId="Heading1"/, style => '<w:style w:type="paragraph" w:styleId="Plain"/>' + style);
  // Spelled as XML may spell it, with whitespace around each =, single
  // quotes and a line break
  const respelledHeading1 = (styles: string) => styles.replace('<w:style w:type="paragraph" w:styleId="Heading1">', '<w:style w:type = \'paragraph\'\n  w:styleId = \'Heading1\'>');
  it.each([
    ['German Word\'s IDs for the headings', german, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'berschrift2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>'],
    ['a base after a style written as <w:style .../>', plainBeforeHeading1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>'],
    // Which turns nothing on, though the bold heading after it does
    ['a base written as <w:style .../>', plainBeforeHeading1, heading(2, '<w:basedOn w:val="Plain"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'],
    ['a base whose tag has its attributes spelled otherwise', respelledHeading1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>'],
    ['a base named with its value spelled otherwise', (styles: string) => styles, heading(2, '<w:basedOn w:val = \'Heading1\'/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'Heading2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>'],
    // Over a bold Normal, so the heading needs no off of its own
    ['a base that turns bold off with its value spelled otherwise', (styles: string) => styles
      .replace(/(<w:style\b[^>]*w:styleId="Normal"[^>]*>[\s\S]*?<w:rPr>)/, (_match, before: string) => before + '<w:b/>')
      .replace(/(<w:style\b[^>]*w:styleId="Quote"[^>]*>[\s\S]*?)(<\/w:style>)/, (_match, style: string, close: string) => style + '<w:rPr><w:b w:val = \'0\'/></w:rPr>' + close),
      heading(2, '<w:basedOn w:val="Quote"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'Heading2', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'],
    // Heading 1 is bold once restyled, as its font style, by its English ID, says
    ['German Word\'s IDs, for a base export makes bold', german, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'), 'berschrift2',
      '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr>', heading(1, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>')],
  ] as Array<[string, (styles: string) => string, [string, string], string, string, [string, string]?]>)('a heading whose base is found as import finds it writes the off its base needs: %s', async (_name, edit, heading2, id, expected, heading1 = boldH1) => {
    const { convertDocx } = await import('./converter');
    const fields = 'header-font-style: [bold, normal]';
    const { styles, docx } = await exportedWith(fields, edit, heading1, heading2);
    expect(extractStyleBlock(styles, id)!.replace(/^<w:style\b[^>]*>[\s\S]*?<w:basedOn\b[^>]*\/>/, '')).toBe(expected + '</w:style>');
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(['bold', 'normal']);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), id))).toBe(noSize(extractStyleBlock(styles, id)));
  });

  // A tracked change's record of what a style was isn't what Word shows
  const pPrChange = '<w:pPrChange w:id="1" w:author="A"><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange>';
  const rPrChange = '<w:rPrChange w:id="2" w:author="A"><w:rPr><w:b/><w:i/></w:rPr></w:rPrChange>';
  it.each([
    ['a Normal', [['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:pPr>' + pPrChange + '</w:pPr><w:rPr>' + rPrChange + '</w:rPr>']]],
    ['the document defaults', [['pPrDefault', pPrChange], ['rPrDefault', rPrChange]]],
  ] as Array<[string, Array<[string, string]>]>)('headings over %s with bold, italic and centering only in a tracked change\'s record get no off', async (_name, replaced) => {
    const { convertDocx } = await import('./converter');
    const { styles, docx } = await exportedStyles('header-font-style: [italic, normal]', ...replaced);
    for (const id of ['Heading1', 'Heading2']) {
      expect(extractStyleBlock(styles, id)).not.toMatch(/<w:[bi] w:val="0"\/>|<w:jc w:val="left"\/>/);
    }
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(['italic', 'normal']);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    const stylesAgain = await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string');
    for (const id of ['Heading1', 'Heading2']) expect(noSize(extractStyleBlock(stylesAgain, id))).toBe(noSize(extractStyleBlock(styles, id)));
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  // A tracked change's record of a style's properties holds a pPr or rPr,
  // which may be empty, and goes as it was
  it('a heading whose tracked changes record empty properties keeps them', async () => {
    const { convertDocx } = await import('./converter');
    const pPrChange = '<w:pPrChange w:id="1" w:author="A"><w:pPr/></w:pPrChange>';
    const rPrChange = '<w:rPrChange w:id="2" w:author="A"><w:rPr/></w:rPrChange>';
    const { styles, docx } = await exportedStyles('header-font-style: [bold, bold-italic]',
      heading(2, '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/>' + pPrChange + '</w:pPr><w:rPr><w:b/>' + rPrChange + '</w:rPr>'));
    expect(extractStyleBlock(styles, 'Heading2')).toContain(pPrChange);
    expect(extractStyleBlock(styles, 'Heading2')).toContain(rPrChange);
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(['bold', 'bold-italic']);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), 'Heading2'))).toBe(noSize(extractStyleBlock(styles, 'Heading2')));
  });

  it.each([
    // Export's own styles, based on Normal, which turns nothing on
    ['header-font-style: normal', []],
    ['header-font-style: [italic, normal, center]', []],
    ['title: T\ntitle-font-style: normal', []],
    // A base this export restyles, which no longer turns them on
    ['header-font-style: normal', [fullH1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')]],
    ['header-font-style: [bold, bold]', [fullH1, onH1('<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')]],
  ] as Array<[string, Array<[string, string]>]>)('writes no off where the base doesn\'t turn the property on: %s', async (fields, replaced) => {
    const { styles } = await exportedStyles(fields, ...replaced);
    for (const id of ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Title']) {
      expect(extractStyleBlock(styles, id) ?? '').not.toMatch(/<w:(?:b|i|smallCaps|caps) w:val="0"\/>|<w:u w:val="none"\/>|<w:jc w:val="left"\/>/);
    }
  });

  // A custom style is based on the template's Normal
  it.each([
    ['bold', 'bold', '<w:pPr><w:jc w:val="left"/></w:pPr>\n<w:rPr><w:b/><w:i w:val="0"/></w:rPr>\n', (styles: string) => styles],
    ['italic-center', 'italic-center', '<w:pPr><w:jc w:val="center"/></w:pPr>\n<w:rPr><w:i/></w:rPr>\n', (styles: string) => styles],
    // Found as import finds it
    ['bold, with German Word\'s ID for Normal', 'bold', '<w:pPr><w:jc w:val="left"/></w:pPr>\n<w:rPr><w:b/><w:i w:val="0"/></w:rPr>\n', german],
    // In schema order, as Word writes run properties
    ['allcaps, beside a Normal in small caps too', 'allcaps', '<w:pPr><w:jc w:val="left"/></w:pPr>\n<w:rPr><w:i w:val="0"/><w:caps/><w:smallCaps w:val="0"/></w:rPr>\n',
      (styles: string) => styles.replace(/(<w:style\b[^>]*w:styleId="Normal"[\s\S]*?)<w:rPr><w:i\/><\/w:rPr>/, (_match, before: string) => before + '<w:rPr><w:i/><w:smallCaps/></w:rPr>')],
  ])('a custom style whose font style, %s, leaves out what the template\'s Normal turns on turns it off', async (_name, fontStyle, expected, edit) => {
    const { convertDocx } = await import('./converter');
    const fields = 'styles:\n  epigraph:\n    font-style: ' + fontStyle;
    const normal: [string, string] = ['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/></w:rPr>'];
    const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n')).docx);
    zip.file('word/styles.xml', edit((await zip.file('word/styles.xml')!.async('string'))
      .replace(/(<w:style\b[^>]*w:styleId="Normal"[^>]*>)[\s\S]*?(<\/w:style>)/, (_match, open: string, close: string) => open + normal[1] + close)));
    const templateDocx = await zip.generateAsync({ type: 'uint8array' });
    const md = '---\n' + fields + '\n---\n\n<!-- style: epigraph -->\n\nStyled\n\n<!-- /style -->\n';
    const docx = (await convertMdToDocx(md, { templateDocx })).docx;
    const styles = await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string');
    expect(extractStyleBlock(styles, 'MsCustomEpigraph')!.replace(/^[\s\S]*<w:basedOn w:val="(?:Normal|Standard)"\/>\n/, '')).toBe(expected + '</w:style>');
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.styles?.epigraph?.fontStyle).toBe(fontStyle);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), 'MsCustomEpigraph')).toBe(extractStyleBlock(styles, 'MsCustomEpigraph'));
    expect((await convertDocx(again)).markdown).toBe(markdown);
  });

  it('a custom style without a font style takes what Normal has', async () => {
    const md = '---\nstyles:\n  epigraph:\n    spacing-before: 12\n---\n\n<!-- style: epigraph -->\n\nStyled\n\n<!-- /style -->\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx('# One\n')).docx);
    zip.file('word/styles.xml', (await zip.file('word/styles.xml')!.async('string'))
      .replace(/(<w:style\b[^>]*w:styleId="Normal"[^>]*>)[\s\S]*?(<\/w:style>)/, (_match, open: string, close: string) => open + '<w:name w:val="Normal"/><w:rPr><w:i/></w:rPr>' + close));
    const docx = (await convertMdToDocx(md, { templateDocx: await zip.generateAsync({ type: 'uint8array' }) })).docx;
    const styles = await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string');
    expect(extractStyleBlock(styles, 'MsCustomEpigraph')).not.toMatch(/w:val="(?:0|left|none)"/);
  });
});
