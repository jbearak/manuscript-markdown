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

    describe('a size Word set on a table', () => {
      // Word sets the size on each of the table's runs, where its text is
      // all selected, or on the runs of the text it is
      // and then the table's XML as `edit` makes it
      const sizedInWord = async (markdown: string, halfPoints: number, runs = Infinity, edit = (table: string) => table,
        sz = '<w:sz w:val="' + halfPoints + '"/><w:szCs w:val="' + halfPoints + '"/>') => {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        let sized = 0;
        const edited = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table => edit(table
          .replace(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?/g, (run, rPr: string | undefined) => sized++ >= runs ? run
            : '<w:r><w:rPr>' + (rPr ?? '').replace(/<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>/, '') + sz + '</w:rPr>')));
        expect(edited).not.toBe(xml);
        zip.file('word/document.xml', edited);
        return zip.generateAsync({ type: 'uint8array' });
      };
      const tableSizes = async (markdown: string) => {
        const JSZip = (await import('jszip')).default;
        const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
        return [...new Set([...xml.matchAll(/<w:r><w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?<w:sz w:val="(\d+)"/g)].map(m => m[1]))];
      };
      const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';

      it.each([
        ['one of its own', '<!-- table-font-size: 11 -->\n' + TABLE, 14, '<!-- table-font-size: 7 -->\n' + TABLE, ['14']],
        ['none of its own', TABLE, 14, '<!-- table-font-size: 7 -->\n' + TABLE, ['14']],
        ['one of its own, to the document\'s', '<!-- table-font-size: 11 -->\n' + TABLE, 18, '<!-- table-font-size: 9 -->\n' + TABLE, []],
        ['none of its own, to the document\'s', TABLE, 18, '<!-- table-font-size: 9 -->\n' + TABLE, []],
        ['one of its own, to a half point', TABLE, 21, '<!-- table-font-size: 10.5 -->\n' + TABLE, ['21']],
      ])('writes the size Word shows on a table with %s', async (_name, markdown, halfPoints, expected, sizes) => {
        // The table took the size export stored, or none, as Word's was lost
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await sizedInWord(markdown, halfPoints))).markdown;
        expect(parseFrontmatter(converted).body).toBe(expected);
        expect(await tableSizes(converted)).toEqual(sizes);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['with a leading zero', '014'],
        ['with whitespace around it', ' 14 '],
        ['with a plus sign', '+14'],
      ])('writes the size Word set on a table where a run spells it %s', async (_name, spelled) => {
        // Each run's size compared as text, so 14 and 014, both 7 points,
        // read as two sizes, and the table kept the size Word took off
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await sizedInWord('<!-- table-font-size: 11 -->\n' + TABLE, 14, Infinity, table => {
          const edited = table.replace('<w:sz w:val="14"/><w:szCs w:val="14"/>', '<w:sz w:val="' + spelled + '"/><w:szCs w:val="' + spelled + '"/>');
          expect(edited).not.toBe(table);
          return edited;
        }))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 7 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['as a universal measure, which import doesn\'t read', '7pt'],
        ['as no number', 'x'],
      ])('keeps the size of its own where a run of a table Word set another on has its size %s', async (_name, spelled) => {
        // What the size Word shows is can't be told
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await sizedInWord('<!-- table-font-size: 11 -->\n' + TABLE, 14, Infinity, table => {
          const edited = table.replace('<w:sz w:val="14"/><w:szCs w:val="14"/>', '<w:sz w:val="' + spelled + '"/><w:szCs w:val="' + spelled + '"/>');
          expect(edited).not.toBe(table);
          return edited;
        }))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 11 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('reads the body font size of a style that spells it with a plus sign', async () => {
        // An ST_HpsMeasure is an xsd:unsignedLong, which may have one, as
        // the table's runs' sizes may
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx('---\nfont-size: 15\n---\n\nText.\n')).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const edited = styles.replace('<w:sz w:val="30"/>', '<w:sz w:val="+30"/>');
        expect(edited).not.toBe(styles);
        zip.file('word/styles.xml', edited);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).metadata.fontSize).toBe(15);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps the size of its own where Word set another on some of its text', async () => {
        // Markdown has no size for part of a table
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await sizedInWord('<!-- table-font-size: 11 -->\n' + TABLE, 14, 1))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 11 -->\n' + TABLE);
      });

      it('writes the size Word shows on a table where it set it on some of the text and the rest takes it from the style', async () => {
        // All of it shows in 9 points, the table paragraph style's, but some
        // had it of its own, so it read as two settings
        const { convertDocx } = await import('./converter');
        const sized = await sizedInWord('<!-- table-font-size: 11 -->\n' + TABLE, 18, 1, table => {
          const edited = table.replace(/<w:sz w:val="22"\/><w:szCs w:val="22"\/>/g, '');
          expect(edited).not.toBe(table);
          return edited;
        });
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 9 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      const EQUATION ='<!-- table-font-size: 11 -->\n| A | B |\n| --- | --- |\n| $x$ | 2 |\n';
      it.each([
        ['set none on an equation', EQUATION, Infinity, (table: string) => table],
        ['set none on a symbol', '<!-- table-font-size: 11 -->\n' + TABLE, Infinity,
          (table: string) => table.replace(/<\/w:p><\/w:tc><\/w:tr><\/w:tbl>$/, '<w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r>$&')],
        ['set another on text it shows, though it has a vanish turned off', '<!-- table-font-size: 11 -->\n' + TABLE, 1,
          (table: string) => table.replace(/(<w:r><w:rPr>(?:<w:b\/>)?)<w:sz w:val="22"/g, '$1<w:vanish w:val="0"/><w:sz w:val="22"')],
      ])('keeps the size of its own where Word %s', async (_name, markdown, runs, edit) => {
        // Its text in another size, which an equation, a symbol or a run
        // with w:vanish off is, went unread
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await sizedInWord(markdown, 14, runs, edit))).markdown;
        expect(parseFrontmatter(converted).body).toBe(markdown);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps a size of its own on a table whose text is all equations', async () => {
        // Export sets no size on an equation, which read as the document's
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font-size: 7 -->\n| $a$ | $b$ |\n| --- | --- |\n| $x$ | $y$ |\n';
        const converted = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
        expect(parseFrontmatter(converted).body).toBe(markdown);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['a non-breaking hyphen', '<w:noBreakHyphen/>'],
        ['an optional hyphen', '<w:softHyphen/>'],
        ['a tab', '<w:tab/>'],
      ])('keeps the size of its own where Word set another on all of its text but %s', async (_name, character) => {
        // Import writes it as a character of the text, whose size went
        // unread: here between the 2 and a 3 after it, in its own size
        const { convertDocx } = await import('./converter');
        const sized = await sizedInWord('<!-- table-font-size: 11 -->\n' + TABLE, 14, Infinity,
          table => table.replace(/<w:t>2<\/w:t><\/w:r>/, '$&<w:r><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>' + character
            + '</w:r><w:r><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr><w:t>3</w:t></w:r>'));
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toStartWith('<!-- table-font-size: 11 -->\n| A | B |');
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['a note\'s reference', '| A | B |\n| --- | --- |\n| 1[^n] | 2 |\n\n[^n]: Note.\n',
          (table: string) => table.replace(/(<w:rStyle w:val="FootnoteReference"\/>)<w:sz w:val="14"\/><w:szCs w:val="14"\/>/, '$1<w:sz w:val="22"/><w:szCs w:val="22"/>')],
        ['a line break', '| A | B |\n| --- | --- |\n| 1 | 2<br>3 |\n',
          (table: string) => table.replace(/<w:sz w:val="14"\/><w:szCs w:val="14"\/>(<\/w:rPr><w:br\/>)/, '<w:sz w:val="22"/><w:szCs w:val="22"/>$1')],
      ])('keeps the size of its own where Word set another on all of its text but %s, which shows in its own', async (_name, table, edit) => {
        // A run with no text went unread, though Word shows it in its size
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font-size: 11 -->\n' + table;
        const converted = (await convertDocx(await sizedInWord(markdown, 14, Infinity, sized => {
          const edited = edit(sized);
          expect(edited).not.toBe(sized);
          return edited;
        }))).markdown;
        expect(parseFrontmatter(converted).body).toBe(markdown);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      const SIZED = (halfPoints: number) => '<w:rPr><w:sz w:val="' + halfPoints + '"/><w:szCs w:val="' + halfPoints + '"/></w:rPr>';
      // A table's XML with content after the run of its 2, in its paragraph,
      // or after that paragraph, in its cell
      const inParagraph = (content: string) => (table: string) => table.replace(/<w:t>2<\/w:t><\/w:r>/, (run: string) => run + content);
      const inCell = (content: string) => (table: string) => table.replace(/<w:t>2<\/w:t><\/w:r><\/w:p>/, (paragraph: string) => paragraph + content);
      it.each([
        ['a phonetic guide, whose base is in its own', inParagraph('<w:r><w:ruby><w:rubyPr><w:hps w:val="11"/><w:hpsBaseText w:val="22"/></w:rubyPr>'
          + '<w:rt><w:r>' + SIZED(11) + '<w:t>x</w:t></w:r></w:rt><w:rubyBase><w:r>' + SIZED(22) + '<w:t>3</w:t></w:r></w:rubyBase></w:ruby></w:r>')],
        ['alternate content in a run in its own', inParagraph('<w:r>' + SIZED(22) + '<mc:AlternateContent><mc:Choice Requires="w14"><w:t>3</w:t></mc:Choice>'
          + '<mc:Fallback><w:t>3</w:t></mc:Fallback></mc:AlternateContent></w:r>')],
        ['alternate content in a paragraph, whose choice Word shows import can\'t tell', inParagraph('<mc:AlternateContent><mc:Choice Requires="w14"><w:r>' + SIZED(14)
          + '<w:t>3</w:t></w:r></mc:Choice><mc:Fallback><w:r>' + SIZED(14) + '<w:t>3</w:t></w:r></mc:Fallback></mc:AlternateContent>')],
        ['a text box, whose text is in its own', inParagraph('<w:r>' + SIZED(14) + '<w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r>'
          + SIZED(22) + '<w:t>3</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')],
        ['an equation whose radical is in its own', inParagraph('<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/><m:ctrlPr>' + SIZED(22) + '</m:ctrlPr></m:radPr>'
          + '<m:deg/><m:e><m:r>' + SIZED(14) + '<m:t>x</m:t></m:r></m:e></m:rad></m:oMath>')],
        ['an equation of delimiters alone, as `$\\left(\\right)$`, in their own', inParagraph('<m:oMath><m:d><m:dPr><m:ctrlPr>' + SIZED(22) + '</m:ctrlPr></m:dPr><m:e/></m:d></m:oMath>')],
        ['an equation of its own paragraph', inCell('<w:p><m:oMathPara><m:oMath><m:r>' + SIZED(14) + '<m:t>x</m:t></m:r></m:oMath></m:oMathPara></w:p>')],
        ['a table in a cell, whose runs take its own style', inCell('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
          + '<w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr>'
          + '<w:p><w:r>' + SIZED(14) + '<w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>')],
        ['runs in an element import doesn\'t know', inParagraph('<w:unknown><w:r>' + SIZED(14) + '<w:t>3</w:t></w:r></w:unknown>')],
        ['an element import doesn\'t know', inParagraph('<w:unknown/>')],
      ])('keeps the size of its own where Word set another on a table with %s', async (_name, edit) => {
        // The walk of the table's runs read what it didn't know as showing
        // nothing, or as both of alternate content's choices, and an
        // equation's runs or a table's in a cell as the table's own
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font-size: 11 -->\n' + TABLE;
        const sized = await sizedInWord(markdown, 14, Infinity, table => {
          const edited = edit(table);
          expect(edited).not.toBe(table);
          return edited;
        });
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toMatch(/^(?:<!-- table-font-size: 11 -->\n\| A \| B \||<table data-font-size="11")/);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the size Word set on a table with a bookmark, a spelling mark, a content control and a link around its runs, which show them as they are', async () => {
        // What the walk of its runs knows shows nothing, or its runs as they
        // are, which a run's size goes through
        const { convertDocx } = await import('./converter');
        const sized = await sizedInWord('<!-- table-font-size: 11 -->\n' + TABLE, 14, Infinity, table => {
          const edited = table.replace(/<w:r><w:rPr>(?:(?!<\/w:r>)[\s\S])*?<w:t>1<\/w:t><\/w:r>/, (run: string) => '<w:bookmarkStart w:id="0" w:name="_GoBack"/>'
            + '<w:proofErr w:type="spellStart"/><w:sdt><w:sdtPr><w:rPr><w:sz w:val="48"/></w:rPr></w:sdtPr><w:sdtContent><w:hyperlink w:anchor="_GoBack">' + run
            + '</w:hyperlink></w:sdtContent></w:sdt><w:proofErr w:type="spellEnd"/><w:bookmarkEnd w:id="0"/>');
          expect(edited).not.toBe(table);
          return edited;
        });
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toStartWith('<!-- table-font-size: 7 -->\n| A | B |');
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the size Word set on a table with a field and a comment, whose code and reference show nothing', async () => {
        const { convertDocx } = await import('./converter');
        const table = '| A | B |\n| --- | --- |\n| {==1==}{>>note<<} | 2 |\n';
        const field = ['<w:fldChar w:fldCharType="begin"/>', '<w:instrText xml:space="preserve"> PAGE </w:instrText>', '<w:fldChar w:fldCharType="separate"/>',
          '<w:lastRenderedPageBreak/><w:t>3</w:t>', '<w:fldChar w:fldCharType="end"/>'].map(content => '<w:r>' + SIZED(14) + content + '</w:r>').join('');
        const sized = await sizedInWord('<!-- table-font-size: 11 -->\n' + table, 14, Infinity, xml => {
          expect(xml).toContain('<w:commentReference');
          return xml.replace(/<w:t>2<\/w:t><\/w:r>/, (run: string) => run + field);
        });
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toStartWith('<!-- table-font-size: 7 -->\n| A | B |');
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the size Word set on a table with a note\'s reference, on its mark too', async () => {
        // The mark's characters, which this doesn't read, show in the size
        // Word set for either kind of character
        const { convertDocx } = await import('./converter');
        const table = '| A | B |\n| --- | --- |\n| 1[^n] | 2 |\n\n[^n]: Note.\n';
        const converted = (await convertDocx(await sizedInWord('<!-- table-font-size: 11 -->\n' + table, 14))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 7 -->\n' + table);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps the size of its own where Word set another on a table\'s equations too, whose parts may show in their own', async () => {
        // An equation's runs read as the table's text, though Word shows a
        // radical or a delimiter in the size of its own properties
        const { convertDocx } = await import('./converter');
        const sized = await sizedInWord(EQUATION, 14, Infinity, table => table.replace(/<m:r>/g, '<m:r><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr>'));
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toBe(EQUATION);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['text it marks complex script, in its complex script size', TABLE, '<w:cs/>', '11'],
        ['text of a complex script it marks right-to-left, in its complex script size', '| א | ב |\n| --- | --- |\n| ג | ד |\n', '<w:rtl/>', '11'],
        ['text of a complex script it doesn\'t mark so, in its size for the rest', '| א | ב |\n| --- | --- |\n| ג | ד |\n', '', '7'],
        ['text of a complex script it marks neither right-to-left nor complex script, in its size for the rest', '| א | ב |\n| --- | --- |\n| ג | ד |\n',
          '<w:cs w:val="0"/><w:rtl w:val="0"/>', '7'],
      ])('writes the size Word shows on a table\'s %s', async (_name, table, marks, size) => {
        // Word shows a run's text in its w:szCs where the run is marked
        // right-to-left or complex script, and else in its w:sz, whatever
        // its characters (MS-OI29500, Part 1 17.3.2.39), but a complex
        // script's characters were read as in its w:szCs
        const { convertDocx } = await import('./converter');
        const sized = await sizedInWord('<!-- table-font-size: 9 -->\n' + table, 14, Infinity, undefined, marks + '<w:sz w:val="14"/><w:szCs w:val="22"/>');
        const converted = (await convertDocx(sized)).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: ' + size + ' -->\n' + table);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps a size of its own, the document\'s, where the style sets it with more whitespace', async () => {
        // The document's size for tables went unread, so it seemed another
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const markdown = '---\ntable-font-size: 8\n---\n<!-- table-font-size: 8 -->\n' + TABLE;
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const spaced = styles.replace(/(<w:style\b[^>]*w:styleId="TableParagraph"[\s\S]*?)<w:sz w:val="16"\/>/, '$1<w:sz  w:val="16"/>');
        expect(spaced).not.toBe(styles);
        zip.file('word/styles.xml', spaced);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 8 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      /** markdown's export, with the table's XML as `table` makes it and
       *  styles.xml as `styles` does, read back */
      const editedInWord = async (markdown: string, table: (xml: string) => string, styles: (xml: string) => string) => {
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
        const documentXml = await zip.file('word/document.xml')!.async('string');
        const stylesXml = await zip.file('word/styles.xml')!.async('string');
        const [editedDocument, editedStyles] = [documentXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table), styles(stylesXml)];
        expect(editedDocument).not.toBe(documentXml);
        expect(editedStyles).not.toBe(stylesXml);
        zip.file('word/document.xml', editedDocument);
        zip.file('word/styles.xml', editedStyles);
        return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
      };
      const withoutSizes = (table: string) => table.replace(/<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>/g, '');
      const tableParagraph = /(<w:style\b[^>]*w:styleId="TableParagraph"[^>]*>)([\s\S]*?)(<\/w:style>)/;
      const HEBREW = '| \u05d0 | \u05d1 |\n| --- | --- |\n| \u05d2 | \u05d3 |\n';
      it.each([
        ['a size the table paragraph style takes from its base', '<!-- table-font-size: 7 -->\n' + TABLE, withoutSizes,
          (styles: string) => styles.replace(tableParagraph, (_style, open: string, body: string, close: string) => open
            + body.replace(/<w:basedOn w:val="[^"]*"\/>/, '<w:basedOn w:val="TableBase"/>').replace(/<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>/, '') + close)
            .replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="TableBase"><w:name w:val="Table Base"/><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr></w:style></w:styles>'),
          '<!-- table-font-size: 7 -->\n' + TABLE],
        ['a character style its runs name in another case', '<!-- table-font-size: 7 -->\n' + TABLE,
          (table: string) => withoutSizes(table).replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="smalltext"/>'),
          (styles: string) => styles.replace('</w:styles>', '<w:style w:type="character" w:styleId="SmallText"><w:name w:val="Small Text"/><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr></w:style></w:styles>'),
          '<!-- table-font-size: 7 -->\n' + TABLE],
        ['the complex script size, as a character style marks its runs right-to-left', '<!-- table-font-size: 8 -->\n' + TABLE,
          (table: string) => withoutSizes(table).replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="RightToLeft"/><w:sz w:val="14"/><w:szCs w:val="22"/>'),
          (styles: string) => styles.replace('</w:styles>', '<w:style w:type="character" w:styleId="RightToLeft"><w:name w:val="Right To Left"/><w:rPr><w:rtl/></w:rPr></w:style></w:styles>'),
          '<!-- table-font-size: 11 -->\n' + TABLE],
        ['the table paragraph style\'s complex script size, for text of a complex script it marks right-to-left', '<!-- table-font-size: 11 -->\n' + HEBREW,
          (table: string) => withoutSizes(table).replace(/<w:r><w:rPr>/g, '$&<w:rtl/>'),
          (styles: string) => styles.replace(tableParagraph, (_style, open: string, body: string, close: string) => open + body.replace(/<w:szCs w:val="\d+"\/>/, '<w:szCs w:val="22"/>') + close),
          '<!-- table-font-size: 11 -->\n' + HEBREW],
      ])('writes the size Word shows on a table whose text takes %s', async (_name, markdown, table, styles, expected) => {
        // Text with no size of its own seemed to take the document's size
        // for tables, and a run's size the one its own marks gave it
        const { convertDocx } = await import('./converter');
        const converted = await editedInWord(markdown, table, styles);
        expect(parseFrontmatter(converted).body).toBe(expected);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the size Word shows on a table whose text takes it from a style where a tracked change took the table paragraph style\'s size off', async () => {
        // The size the change records the style had was read as the document's
        // for tables, though the frontmatter has none, so export gives the
        // table another
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(TABLE)).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const changed = styles.replace(/(<w:style\b[^>]*w:styleId="TableParagraph"[\s\S]*?<w:rPr>)<w:sz w:val="18"\/><w:szCs w:val="18"\/>/,
          (_style, before: string) => before + '<w:rPrChange w:id="90" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrChange>');
        expect(changed).not.toBe(styles);
        zip.file('word/styles.xml', changed);
        expect(await zip.file('word/document.xml')!.async('string')).not.toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?<w:sz /);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        // Normal's 11 points, which the style is based on
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 11 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps a size of its own, the document\'s, where a character style has the table paragraph style\'s ID', async () => {
        // A paragraph takes no character style, but its size was read as the
        // document's for tables, so the table's seemed another
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const markdown = '---\ntable-font-size: 8\n---\n<!-- table-font-size: 8 -->\n' + TABLE;
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const character = '<w:style w:type="character" w:styleId="TableParagraph"><w:name w:val="Table Paragraph Char"/><w:rPr><w:sz w:val="48"/></w:rPr></w:style>';
        const added = styles.replace(/<w:style\b[^>]*w:styleId="TableParagraph"/, character + '$&');
        expect(added).not.toBe(styles);
        zip.file('word/styles.xml', added);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 8 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['a paragraph style', '<!-- table-font-size: 7 -->\n', ['14'],
          (table: string) => table.replace(/<w:pStyle w:val="TableParagraph"\/>/g, '<w:pStyle w:val="SmallTable"/>')],
        ['a character style', '<!-- table-font-size: 7 -->\n', ['14'],
          (table: string) => table.replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="SmallText"/>')],
        ['a character style that sets none, the document\'s', '', [],
          (table: string) => table.replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="Plain"/>')],
      ])('writes the size of a table whose text takes it from %s', async (_name, directive, sizes, edit) => {
        // Text with no size of its own in another style than the table
        // paragraph style's isn't in the document's
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- table-font-size: 7 -->\n' + TABLE)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        const edited = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table => edit(table.replace(/<w:sz w:val="14"\/><w:szCs w:val="14"\/>/g, '')));
        expect(edited).not.toContain('w:val="14"');
        zip.file('word/document.xml', edited);
        const styles = await zip.file('word/styles.xml')!.async('string');
        zip.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:customStyle="1" w:styleId="SmallTable">'
          + '<w:name w:val="Small Table"/><w:basedOn w:val="TableParagraph"/><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr></w:style>'
          + '<w:style w:type="character" w:customStyle="1" w:styleId="SmallText"><w:name w:val="Small Text"/><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr></w:style>'
          + '<w:style w:type="character" w:customStyle="1" w:styleId="Plain"><w:name w:val="Plain"/><w:rPr><w:i w:val="0"/></w:rPr></w:style></w:styles>'));
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body).toBe(directive + TABLE);
        expect(await tableSizes(converted)).toEqual(sizes);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      /** styles.xml with `rPr` in the style `id` */
      const withRunProperties = (id: string, rPr: string) => (styles: string) =>
        styles.replace(new RegExp('(<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>)([\\s\\S]*?)(</w:style>)'),
          (_style, open: string, body: string, close: string) => open + body + '<w:rPr>' + rPr + '</w:rPr>' + close);
      it.each([
        ['marks complex script', 'DefaultParagraphFont', '<w:cs/>'],
        ['marks right-to-left', 'DefaultParagraphFont', '<w:rtl/>'],
        ['marks complex script, named in another case', 'defaultparagraphfont', '<w:cs/>'],
      ])('keeps the size Word shows on a table whose runs name the default paragraph font, a style whose properties Word ignores, that %s', async (_name, rStyle, marks) => {
        // Word ignores the elements of DefaultParagraphFont, NoList and
        // TableNormal (MS-OI29500, Part 1 17.7.4.17), but the mark read as
        // the runs', so they seemed to show their complex script size
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font-size: 7 -->\n' + TABLE;
        const converted = await editedInWord(markdown,
          table => withoutSizes(table).replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="' + rStyle + '"/><w:sz w:val="14"/><w:szCs w:val="22"/>'),
          withRunProperties('DefaultParagraphFont', marks));
        expect(parseFrontmatter(converted).body).toBe(markdown);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      // The table's runs at 7 points, as Word sets them all
      const resized = (table: string) => table.replace(/<w:sz w:val="22"\/><w:szCs w:val="22"\/>/g, '<w:sz w:val="14"/><w:szCs w:val="14"/>');
      /** styles.xml with `element` first in the table paragraph style's run properties */
      const inTableParagraph = (element: string) => (styles: string) => styles.replace(tableParagraph,
        (_style, open: string, body: string, close: string) => open + body.replace('<w:rPr>', '<w:rPr>' + element) + close);
      it.each([
        ['the table paragraph style turns off, by 0', resized, inTableParagraph('<w:vanish w:val="0"/>'), '7'],
        ['the table paragraph style turns off, by false', resized, inTableParagraph('<w:vanish w:val="false"/>'), '7'],
        ['the table paragraph style turns off, by off', resized, inTableParagraph('<w:vanish w:val="off"/>'), '7'],
        ['a character style turns off', (table: string) => resized(table).replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="Shown"/>'),
          (styles: string) => styles.replace('</w:styles>', '<w:style w:type="character" w:styleId="Shown"><w:name w:val="Shown"/><w:rPr><w:vanish w:val="0"/></w:rPr></w:style></w:styles>'), '7'],
        // Which may hide it, so the size Word shows is unknown
        ['the table paragraph style turns on', resized, inTableParagraph('<w:vanish/>'), '11'],
      ])('writes the size Word set on a table whose text\'s hidden property %s', async (_name, table, styles, size) => {
        // A style's w:vanish read as on by its presence alone, though its
        // value turned it off, so the text seemed hidden and the size
        // unknown, and the table kept the size Word took off
        const { convertDocx } = await import('./converter');
        const converted = await editedInWord('<!-- table-font-size: 11 -->\n' + TABLE, table, styles);
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: ' + size + ' -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      /** The table's paragraphs without a style, as the default paragraph
       *  style's, and its runs at 7 points, or 11 where they're marked
       *  complex script, by `tblPr`, if given, in its tblPr */
      const defaultStyled = (tblPr = '') => (table: string) => withoutSizes(table).replace('<w:tblPr>', '<w:tblPr>' + tblPr)
        .replace(/<w:pStyle w:val="TableParagraph"\/>/g, '').replace(/<w:r><w:rPr>/g, '$&<w:sz w:val="14"/><w:szCs w:val="22"/>');
      /** styles.xml with `element` first in Normal's run properties, and
       *  Normal's start tag as `tag` makes it */
      const inNormal = (element: string, tag = (open: string) => open) => (styles: string) =>
        styles.replace(/(<w:style\b[^>]*w:styleId="Normal"[^>]*>)([\s\S]*?)(<\/w:style>)/,
          (_style, open: string, body: string, close: string) => tag(open) + body.replace('<w:rPr>', '<w:rPr>' + element) + close);
      it.each([
        // Normal's mark read before the table style's, as though Normal
        // came after it, though the table style's comes after the default
        // paragraph style's
        ['a table style marks right-to-left over the default paragraph style\'s mark', defaultStyled('<w:tblStyle w:val="RightToLeft"/>'),
          (styles: string) => inNormal('<w:rtl w:val="0"/>')(styles)
            .replace('</w:styles>', '<w:style w:type="table" w:styleId="RightToLeft"><w:name w:val="Right To Left"/><w:rPr><w:rtl/></w:rPr></w:style></w:styles>')],
        // A style without a w:type is a paragraph style, but the default
        // was read only where its w:type said so
        ['the default paragraph style, which has no type, marks right-to-left', defaultStyled(),
          inNormal('<w:rtl/>', open => open.replace(' w:type="paragraph"', ''))],
      ])('keeps the size Word shows on a table whose paragraphs are the default paragraph style\'s, where %s', async (_name, table, styles) => {
        // The runs seemed to show their size for the rest, 7 points, and not
        // their complex script size, 11 points
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font-size: 11 -->\n' + TABLE;
        const converted = await editedInWord(markdown, table, styles);
        expect(parseFrontmatter(converted).body).toBe(markdown);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the size Word set on a table of the default table style, whose properties Word ignores', async () => {
        // A mark in TableNormal, which Word ignores, read as the table
        // style's, which may set it by where the cell is, so the size
        // seemed unknown
        const { convertDocx } = await import('./converter');
        const converted = await editedInWord('<!-- table-font-size: 11 -->\n' + TABLE,
          table => withoutSizes(table).replace(/<w:r><w:rPr>/g, '$&<w:sz w:val="14"/><w:szCs w:val="22"/>'), withRunProperties('TableNormal', '<w:rtl/>'));
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font-size: 7 -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      // An embed's files: a CSV of one table, and Markdown of two
      const EMBEDS = {
        readFile: (path: string) => new TextEncoder().encode(path.endsWith('.md')
          ? '| H | I |\n| --- | --- |\n| a | b |\n\nText.\n\n| J | K |\n| --- | --- |\n| c | d |\n' : 'H,I\na,b\n'),
        resolveRelative: (_base: string, relative: string) => relative,
      };
      const EMBED_OPTIONS = { embedResolver: EMBEDS, documentPath: '/doc/paper.md' };
      it.each([
        ['a CSV', '<!-- table-font-size: 11 -->\n<!-- embed: t.csv headers=1 -->\n', Infinity, '7'],
        ['a CSV in a note', 'A[^1].\n\n[^1]: Note.\n\n    <!-- table-font-size: 11 -->\n    <!-- embed: t.csv headers=1 -->\n', Infinity, '7'],
        // Export gives the directive to the first table only
        ['a file of two tables, on the first, which the directive is for', '<!-- table-font-size: 11 -->\n<!-- embed: two.md -->\n', 1, '7'],
      ])('writes the size Word set on the table of %s embedded with a size of its own', async (_name, markdown, tables, size) => {
        // An embed's directive took the size export stored, as its table's
        // size went unread
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown, EMBED_OPTIONS)).docx);
        let resized = 0;
        for (const part of ['word/document.xml', 'word/footnotes.xml']) {
          const xml = await zip.file(part)?.async('string');
          if (xml !== undefined) zip.file(part, xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, table => resized++ >= tables ? table
            : table.replace(/<w:sz w:val="\d+"\/><w:szCs w:val="\d+"\/>/g, '<w:sz w:val="14"/><w:szCs w:val="14"/>')));
        }
        expect(resized).toBeGreaterThan(0);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(converted).toBe(markdown.replace('table-font-size: 11', 'table-font-size: ' + size));
        expect((await convertDocx((await convertMdToDocx(converted, EMBED_OPTIONS)).docx)).markdown).toBe(converted);
      });
    });

    describe('a font Word set on a table', () => {
      // Word sets the font on each of the table's runs, where its text is
      // all selected, or on the runs of the text it is, and clearing the
      // formatting takes it off, and then the table's XML as `edit` makes it
      const fontInWord = async (markdown: string, font: string | null, runs = Infinity, edit = (table: string) => table) => {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        const rFonts = font === null ? '' : '<w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:cs="' + font + '"/>';
        let set = 0;
        const edited = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table => edit(table
          .replace(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?/g, (run, rPr: string | undefined) => set++ >= runs ? run
            : '<w:r><w:rPr>' + rFonts + (rPr ?? '').replace(/<w:rFonts [^>]*\/>/, '') + '</w:rPr>')));
        expect(edited).not.toBe(xml);
        zip.file('word/document.xml', edited);
        return zip.generateAsync({ type: 'uint8array' });
      };
      const tableFonts = async (markdown: string) => {
        const JSZip = (await import('jszip')).default;
        const xml = await (await JSZip.loadAsync((await convertMdToDocx(markdown)).docx)).file('word/document.xml')!.async('string');
        const table = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(xml)![0];
        return [...new Set([...table.matchAll(/<w:r><w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?<w:rFonts w:ascii="([^"]+)"/g)].map(m => m[1]))];
      };
      const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
      const HTML = (attributes: string) => '<table' + attributes + '>\n  <tr>\n    <td>\n      <p>A</p>\n    </td>\n  </tr>\n</table>\n';
      const DOCUMENT = '---\ntable-font: Courier New\n---\n\n';
      const EQUATION = '<!-- table-font: Georgia -->\n| A | B |\n| --- | --- |\n| $x$ | 2 |\n';
      const HEBREW = '| \u05d0 | \u05d1 |\n| --- | --- |\n| \u05d2 | \u05d3 |\n';
      const CHINESE = '| \u4e2d | \u6587 |\n| --- | --- |\n| \u8868 | \u683c |\n';
      const GREEK = '| \u03b1 | \u03b2 |\n| --- | --- |\n| \u03b3 | \u03b4 |\n';

      it.each([
        ['one of its own', '<!-- table-font: Georgia -->\n' + TABLE, 'Arial', '<!-- table-font: Arial -->\n' + TABLE, ['Arial']],
        ['none of its own', TABLE, 'Arial', '<!-- table-font: Arial -->\n' + TABLE, ['Arial']],
        ['one of its own, to the document\'s', DOCUMENT + '<!-- table-font: Georgia -->\n' + TABLE, 'Courier New', '<!-- table-font: Courier New -->\n' + TABLE, []],
        ['none of its own, to the document\'s', DOCUMENT + TABLE, 'Courier New', '<!-- table-font: Courier New -->\n' + TABLE, []],
        ['one of its own, in HTML', HTML(' data-font="Georgia"'), 'Arial', HTML(' data-font="Arial"'), ['Arial']],
        ['none of its own, in HTML', HTML(''), 'Arial', HTML(' data-font="Arial"'), ['Arial']],
        ['one of its own, taken off its text, which then takes the document\'s', DOCUMENT + '<!-- table-font: Georgia -->\n' + TABLE, null, TABLE, []],
      ])('writes the font Word shows on a table with %s', async (_name, markdown, font, expected, fonts) => {
        // The table took the font export stored, or none, as Word's was lost
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await fontInWord(markdown, font))).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe(expected);
        expect(await tableFonts(converted)).toEqual(fonts);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes no font on a table whose text takes the document\'s body font where that\'s export\'s default, Calibri', async () => {
        // The frontmatter import writes leaves out a body font of Calibri,
        // the theme's, which text without a font of its own takes, so the
        // table's text, in Calibri from the table paragraph style, took
        // Calibri as a font of its own, which a later body font didn't reach
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx((await convertMdToDocx('---\nfont: Calibri\n---\n\n' + TABLE)).docx)).markdown;
        expect(converted).toBe(TABLE);
        expect(await tableFonts('---\nfont: Georgia\n---\n\n' + converted)).toEqual([]);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the font Word shows on a table where it set it on some of the text and the rest takes it from the style', async () => {
        // All of it shows in Courier New, the table paragraph style's, but
        // some had it of its own, so it read as two fonts
        const { convertDocx } = await import('./converter');
        const set = await fontInWord(DOCUMENT + '<!-- table-font: Georgia -->\n' + TABLE, 'Courier New', 1, table => {
          const edited = table.replace(/<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"\/>/g, '');
          expect(edited).not.toBe(table);
          return edited;
        });
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: Courier New -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      /** A table with a directive for Georgia, after `frontmatter`, whose
       *  runs' w:rFonts Word set to `rFonts` */
      const rFontsInWord = async (table: string, rFonts: string, frontmatter = '') => {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync((await convertMdToDocx(frontmatter + '<!-- table-font: Georgia -->\n' + table)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        const edited = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, found => found.replace(/<w:rFonts [^>]*\/>/g, rFonts));
        expect(edited).not.toBe(xml);
        zip.file('word/document.xml', edited);
        return zip.generateAsync({ type: 'uint8array' });
      };

      it.each([
        ['set another on some of its text', () => fontInWord('<!-- table-font: Georgia -->\n' + TABLE, 'Arial', 1)],
        ['took it off its text, which then takes the theme\'s, by the document\'s default', () => fontInWord('<!-- table-font: Georgia -->\n' + TABLE, null)],
        ['set a theme\'s on its text', () => rFontsInWord(TABLE, '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>')],
        ['set a theme\'s on its text with a name, which the theme goes before', () => rFontsInWord(TABLE,
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>')],
        ['set one for ASCII and another for the other characters of a cell with both', () => rFontsInWord('| A | B |\n| --- | --- |\n| 1 | A\u03b1 |\n',
          '<w:rFonts w:ascii="Arial" w:hAnsi="Times New Roman"/>')],
        ['set one for ASCII and another for the characters of a cell without it', () => rFontsInWord('| A | B |\n| --- | --- |\n| 1 | \u03b1 |\n',
          '<w:rFonts w:ascii="Arial" w:hAnsi="Times New Roman"/>')],
        ['set one for ASCII and the rest and another for East Asian text, on a cell with both, a small form\'s', () => rFontsInWord('| A | B |\n| --- | --- |\n| 1 | A\ufe56 |\n',
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="MS Mincho"/>')],
        ['set another on all of its text but an equation, in the document\'s font for equations', () => fontInWord(EQUATION, 'Arial')],
        ['set another on all of its text but a symbol, in a font of its own', () => fontInWord('<!-- table-font: Georgia -->\n' + TABLE, 'Arial', Infinity,
          table => table.replace(/<\/w:p><\/w:tc><\/w:tr><\/w:tbl>$/, '<w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r>$&'))],
        ['set another on all of its text but a non-breaking hyphen', () => fontInWord('<!-- table-font: Georgia -->\n' + TABLE, 'Arial', Infinity,
          table => table.replace(/<w:t>2<\/w:t><\/w:r>/, '$&<w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:noBreakHyphen/></w:r>'
            + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t>3</w:t></w:r>'))],
        ['set another on text it shows, though it has a vanish turned off', () => fontInWord('<!-- table-font: Georgia -->\n' + TABLE, 'Arial', 1,
          table => table.replace(/(<w:rFonts w:ascii="Georgia"[^>]*\/>)/g, '$1<w:vanish w:val="0"/>'))],
      ])('keeps the font of its own where Word %s', async (_name, docx) => {
        // Markdown has no font for part of a table, nor one by a theme's, nor
        // one for some characters
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await docx())).markdown;
        expect(parseFrontmatter(converted).body).toStartWith('<!-- table-font: Georgia -->\n| A | B |');
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps the font of its own where Word set another on a table\'s equations too, whose parts may show in fonts of their own', async () => {
        // An equation's runs read as the table's text, though Word shows a
        // radical or a delimiter in the font of its own properties
        const { convertDocx } = await import('./converter');
        const set = await fontInWord(EQUATION, 'Arial', Infinity, table => table.replace(/<m:r>/g, '<m:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>'));
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body).toBe(EQUATION);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the font Word set on a table whose runs name the default paragraph font, a style whose properties Word ignores, that marks them right-to-left', async () => {
        // Word ignores the elements of DefaultParagraphFont (MS-OI29500,
        // Part 1 17.7.4.17), but its mark read as the runs', so they seemed
        // to show its complex script font, the style's, which can't be told
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx('<!-- table-font: Georgia -->\n' + TABLE)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        const edited = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table => table.replace(/<w:rFonts [^>]*\/>/g,
          '<w:rStyle w:val="DefaultParagraphFont"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'));
        const styles = await zip.file('word/styles.xml')!.async('string');
        const marked = styles.replace(/(<w:style\b[^>]*w:styleId="DefaultParagraphFont"[^>]*>[\s\S]*?)(<\/w:style>)/,
          (_style, body: string, close: string) => body + '<w:rPr><w:rFonts w:cs="Times New Roman"/><w:rtl/></w:rPr>' + close);
        expect(edited).not.toBe(xml);
        expect(marked).not.toBe(styles);
        zip.file('word/document.xml', edited);
        zip.file('word/styles.xml', marked);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: Arial -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['a CSV', '<!-- table-font: Georgia -->\n<!-- embed: t.csv headers=1 -->\n'],
        ['a CSV in a note', 'A[^1].\n\n[^1]: Note.\n\n    <!-- table-font: Georgia -->\n    <!-- embed: t.csv headers=1 -->\n'],
      ])('writes the font Word set on the table of %s embedded with a font of its own', async (_name, markdown) => {
        // An embed's directive took the font export stored, as its table's
        // font went unread
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const options = { embedResolver: { readFile: () => new TextEncoder().encode('H,I\na,b\n'), resolveRelative: (_base: string, relative: string) => relative }, documentPath: '/doc/paper.md' };
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown, options)).docx);
        let set = 0;
        for (const part of ['word/document.xml', 'word/footnotes.xml']) {
          const xml = await zip.file(part)?.async('string');
          if (xml !== undefined) zip.file(part, xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, table => (set++, table.replace(/<w:rFonts [^>]*\/>/g, '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'))));
        }
        expect(set).toBe(1);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(converted).toBe(markdown.replace('Georgia', 'Arial'));
        expect((await convertDocx((await convertMdToDocx(converted, options)).docx)).markdown).toBe(converted);
      });

      const ARIAL = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr>';
      // A table's XML with content after the run of its 2, in its paragraph,
      // or after that paragraph, in its cell
      const inParagraph = (content: string) => (table: string) => table.replace(/<w:t>2<\/w:t><\/w:r>/, (run: string) => run + content);
      const inCell = (content: string) => (table: string) => table.replace(/<w:t>2<\/w:t><\/w:r><\/w:p>/, (paragraph: string) => paragraph + content);
      it.each([
        ['a phonetic guide', inParagraph('<w:r><w:ruby><w:rubyPr><w:hps w:val="11"/><w:hpsBaseText w:val="22"/></w:rubyPr>'
          + '<w:rt><w:r>' + ARIAL + '<w:t>x</w:t></w:r></w:rt><w:rubyBase><w:r>' + ARIAL + '<w:t>3</w:t></w:r></w:rubyBase></w:ruby></w:r>')],
        ['alternate content in a run', inParagraph('<w:r>' + ARIAL + '<mc:AlternateContent><mc:Choice Requires="w14"><w:t>3</w:t></mc:Choice>'
          + '<mc:Fallback><w:t>3</w:t></mc:Fallback></mc:AlternateContent></w:r>')],
        ['alternate content in a paragraph', inParagraph('<mc:AlternateContent><mc:Choice Requires="w14"><w:r>' + ARIAL
          + '<w:t>3</w:t></w:r></mc:Choice><mc:Fallback><w:r>' + ARIAL + '<w:t>3</w:t></w:r></mc:Fallback></mc:AlternateContent>')],
        ['a text box', inParagraph('<w:r>' + ARIAL + '<w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r>'
          + ARIAL + '<w:t>3</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')],
        ['an equation whose radical is in a font of its own', inParagraph('<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/><m:ctrlPr>'
          + '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr></m:ctrlPr></m:radPr><m:deg/><m:e><m:r>' + ARIAL + '<m:t>x</m:t></m:r></m:e></m:rad></m:oMath>')],
        ['an equation of delimiters alone, as `$\\left(\\right)$`', inParagraph('<m:oMath><m:d><m:dPr><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'
          + '</m:ctrlPr></m:dPr><m:e/></m:d></m:oMath>')],
        ['an equation of its own paragraph', inCell('<w:p><m:oMathPara><m:oMath><m:r>' + ARIAL + '<m:t>x</m:t></m:r></m:oMath></m:oMathPara></w:p>')],
        ['a table in a cell, whose runs take its own style', inCell('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
          + '<w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr>'
          + '<w:p><w:r>' + ARIAL + '<w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>')],
        ['runs in an element import doesn\'t know', inParagraph('<w:unknown><w:r>' + ARIAL + '<w:t>3</w:t></w:r></w:unknown>')],
        ['an element import doesn\'t know', inParagraph('<w:unknown/>')],
      ])('keeps the font of its own where Word set another on a table with %s, though its runs are in it too', async (_name, edit) => {
        // The walk of the table's runs read what it didn't know as showing
        // nothing, or as both of alternate content's choices, and an
        // equation's runs or a table's in a cell as the table's own
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font: Georgia -->\n' + TABLE;
        const set = await fontInWord(markdown, 'Arial', Infinity, table => {
          const edited = edit(table);
          expect(edited).not.toBe(table);
          return edited;
        });
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body).toMatch(/^(?:<!-- table-font: Georgia -->\n\| A \| B \||<table data-font="Georgia")/);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['marks complex script', '<w:cs/>', 'Times New Roman'],
        ['marks not complex script', '<w:cs w:val="0"/>', 'Arial'],
      ])('writes the font Word shows on a table whose text it %s', async (_name, cs, font) => {
        // A w:cs turned off still took the text for complex script's
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(TABLE, '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Times New Roman"/>' + cs))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: ' + font + ' -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['with whitespace around an attribute\'s =, which the frontmatter reads as the document\'s font for tables, so the table has no directive',
          DOCUMENT + '<!-- table-font: Georgia -->\n' + TABLE, '<w:rFonts w:ascii = "Courier New" w:hAnsi = "Courier New"/>', TABLE],
        ['with a theme\'s for the rest, which its ASCII text doesn\'t take, so the table has no directive',
          DOCUMENT + TABLE, '<w:rFonts w:ascii="Courier New" w:hAnsiTheme="minorHAnsi"/>', TABLE],
        ['as its East Asian font too, for Chinese text, which export doesn\'t set a table\'s font as, so the table keeps having no directive',
          DOCUMENT + CHINESE, '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:eastAsia="Courier New"/>', CHINESE],
      ])('writes the font of a table whose text takes the table paragraph style\'s, %s', async (_name, markdown, rFonts, expected) => {
        // The document's font for tables was read from the style apart from
        // the frontmatter, which export gives the table's text with none of
        // its own: as the style's ASCII font, where the frontmatter has none,
        // or as none, for the theme's font for the rest, or as the East
        // Asian font, which the frontmatter's isn't but export can't set
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table => table.replace(/<w:rFonts [^>]*\/>/g, '')));
        const styles = await zip.file('word/styles.xml')!.async('string');
        const set = styles.replace(/(<w:style\b[^>]*w:styleId="TableParagraph"[\s\S]*?)<w:rFonts [^>]*\/>/, (_style, before: string) => before + rFonts);
        expect(set).not.toBe(styles);
        zip.file('word/styles.xml', set);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe(expected);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps a font of its own, the document\'s, where the style sets it with more whitespace', async () => {
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(DOCUMENT + '<!-- table-font: Courier New -->\n' + TABLE)).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const spaced = styles.replace(/(<w:style\b[^>]*w:styleId="TableParagraph"[\s\S]*?)<w:rFonts w:ascii=/, '$1<w:rFonts \n  w:ascii=');
        expect(spaced).not.toBe(styles);
        zip.file('word/styles.xml', spaced);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: Courier New -->\n' + TABLE);
      });

      it('keeps a font of its own, the document\'s, where a character style has the table paragraph style\'s ID', async () => {
        // A paragraph takes no character style, but its font was read as the
        // document's for tables, so the table's seemed another
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(DOCUMENT + '<!-- table-font: Courier New -->\n' + TABLE)).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const character = '<w:style w:type="character" w:styleId="TableParagraph"><w:name w:val="Table Paragraph Char"/><w:rPr><w:rFonts w:ascii="Impact" w:hAnsi="Impact"/></w:rPr></w:style>';
        const added = styles.replace(/<w:style\b[^>]*w:styleId="TableParagraph"/, character + '$&');
        expect(added).not.toBe(styles);
        zip.file('word/styles.xml', added);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: Courier New -->\n' + TABLE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the font Word set for ASCII on a table whose text is all ASCII', async () => {
        // Its East Asian font, which no character of the text takes, isn't shown
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(TABLE, '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="MS Mincho"/>'))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: Arial -->\n' + TABLE);
      });

      it.each([
        ['Hebrew', HEBREW],
        ['Chinese', CHINESE],
      ])('keeps a font of its own on a table whose text is all %s', async (_name, table) => {
        // Export sets the font for ASCII and the rest, not for a complex
        // script's or East Asian characters, which read as Word took it off
        const { convertDocx } = await import('./converter');
        const markdown = '<!-- table-font: Arial -->\n' + table;
        const converted = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
        expect(parseFrontmatter(converted).body).toBe(markdown);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps the font of its own where Word set a theme\'s for a complex script on its text in one, marked right-to-left', async () => {
        // Its w:cstheme went unread, so its complex script font seemed set
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(HEBREW,
          '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Courier New" w:cstheme="majorBidi"/><w:rtl/>'))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: Georgia -->\n' + HEBREW);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['Hebrew, which Word shows in its ASCII font where nothing marks it right-to-left', HEBREW, '', 'Arial'],
        ['Hebrew, which Word shows in its complex script font where a run marks it right-to-left', HEBREW, '<w:rtl/>', 'Times New Roman'],
      ])('writes the font Word shows on a table whose text is all %s', async (_name, table, rtl, font) => {
        // Its complex script font was read for a complex script's text, as
        // its size is
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(table, '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Times New Roman"/>' + rtl))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: ' + font + ' -->\n' + table);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['ASCII and the rest are in one, its ASCII font', '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Times New Roman" w:hint="eastAsia"/>', 'Arial'],
        ['ASCII and the rest are in two, its East Asian font', '<w:rFonts w:ascii="Arial" w:hAnsi="Verdana" w:eastAsia="Times New Roman" w:hint="eastAsia"/>', 'Times New Roman'],
      ])('writes the font Word shows on a table of Greek it shows in its East Asian font, by an East Asian hint, which is Times New Roman, where %s', async (_name, rFonts, font) => {
        // Word shows East Asian text in the ASCII font where the East Asian
        // one is Times New Roman and the ASCII font and the font for the
        // rest are one
        const { convertDocx } = await import('./converter');
        const set = await rFontsInWord(GREEK, rFonts);
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: ' + font + ' -->\n' + GREEK);
        const exported = (await convertMdToDocx(converted)).docx;
        expect(await shownFonts(exported)).toEqual(await shownFonts(set));
        expect((await convertDocx(exported)).markdown).toBe(converted);
      });

      // A font for each of a w:rFonts' fonts Word may show a character in,
      // but its complex script one, without and with an East Asian hint
      const SLOTS = 'w:ascii="Arial" w:hAnsi="Verdana" w:eastAsia="MS Mincho"';
      const PLAIN = '<w:rFonts ' + SLOTS + '/>';
      const HINTED = '<w:rFonts ' + SLOTS + ' w:hint="eastAsia"/>';
      /** A table whose text is all `character` */
      const ALL = (character: string) => '| ' + character + ' | ' + character + ' |\n| --- | --- |\n| ' + character + ' | ' + character + ' |\n';

      it.each([
        ['Basic Latin, in its ASCII font', 'A', PLAIN, 'Arial'],
        ['Basic Latin, in its ASCII font, whatever its hint', 'A', HINTED, 'Arial'],
        ['Latin-1 Supplement, in its font for the rest', '\u00c4', PLAIN, 'Verdana'],
        ['Latin-1 Supplement, in its font for the rest, whatever its hint', '\u00c4', HINTED, 'Verdana'],
        ['Latin-1 Supplement that an East Asian hint takes, in its East Asian font', '\u00b0', HINTED, 'MS Mincho'],
        ['Latin-1 Supplement that an East Asian hint takes in Chinese, in the one font it has for the rest and East Asian text', '\u00e9',
          '<w:rFonts w:ascii="Arial" w:hAnsi="Verdana" w:eastAsia="Verdana" w:hint="eastAsia"/>', 'Verdana'],
        ['Greek, in its font for the rest', '\u03b1', PLAIN, 'Verdana'],
        ['Greek, in its East Asian font, by its hint', '\u03b1', HINTED, 'MS Mincho'],
        ['Hebrew, in its ASCII font, whatever its hint', '\u05d0', HINTED, 'Arial'],
        ['Thai, in its font for the rest, as the table lists no range for it', '\u0e01', PLAIN, 'Verdana'],
        ['Bopomofo Extended, in its font for the rest, as the table lists no range for it', '\u31a0', PLAIN, 'Verdana'],
        ['Katakana Phonetic Extensions, in its font for the rest, as the table lists no range for it', '\u31ff', PLAIN, 'Verdana'],
        ['Latin ligatures, in its font for the rest', '\ufb00', PLAIN, 'Verdana'],
        ['Latin ligatures, in its East Asian font, by its hint', '\ufb00', HINTED, 'MS Mincho'],
        ['Hebrew presentation forms, in its ASCII font, whatever its hint', '\ufb2a', HINTED, 'Arial'],
      ])('writes the font Word shows on a table all of %s', async (_name, character, rFonts, font) => {
        // Word picks the font for a character by its range and the run's
        // w:hint (MS-OI29500, Part 1 17.3.2.26), which was read only roughly: Thai as
        // in either font, a small form's character as not East Asian, and
        // a hint as for East Asian text and the rest alike
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(ALL(character), rFonts))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: ' + font + ' -->\n' + ALL(character));
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['Chinese', '\u4e2d'],
        ['Kanbun', '\u319f'],
        ['Enclosed CJK Letters and Months', '\u3200'],
        ['small forms', '\ufe56'],
        ['a character beyond the Basic Multilingual Plane', '\u{20000}'],
      ])('keeps the font of its own on a table all of %s, which Word shows in its East Asian font, which export doesn\'t set a table\'s font as', async (_name, character) => {
        // Its East Asian font was written as the table's, which export
        // showed none of its text in
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(ALL(character), PLAIN))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: Georgia -->\n' + ALL(character));
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      /**
       * The font Word shows each character of a DOCX's first table in, as
       * `character: font`, for the XML export writes, or Word as
       * rFontsInWord sets it: the font of its run's w:rFonts, else its
       * character style's, as CodeChar's for inline code, else its
       * paragraph's style's, the table paragraph style's or Normal's for
       * none, else Normal's, else the document's default,
       * each font apart, as `theme minorHAnsi` for a theme's, that Word
       * picks for it: the complex script one for a run marked so, else the
       * one its range and the hint take (see characterFontSlots), but the
       * ASCII one for the East Asian one where that's Times New Roman and
       * the ASCII one and the one for the rest are one
       */
      const shownFonts = async (docx: Uint8Array) => {
        const JSZip = (await import('jszip')).default;
        const { characterFontSlots } = await import('./converter');
        const zip = await JSZip.loadAsync(docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        const styles = await zip.file('word/styles.xml')!.async('string');
        const rFontsIn = (xmlPart: string | undefined) => xmlPart === undefined ? undefined : /<w:rFonts\b[^>]*\/>/.exec(xmlPart)?.[0];
        const styleRFonts = (id: string) => rFontsIn(new RegExp('<w:style\\b[^>]*w:styleId="' + id + '"[^>]*>[\\s\\S]*?</w:style>').exec(styles)?.[0]);
        const defaults = rFontsIn(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/.exec(styles)?.[0]);
        const table = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(xml)![0];
        const shown: string[] = [];
        const runs = [...table.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].flatMap(([paragraph]) =>
          [...paragraph.matchAll(/<w:r>(?:<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>)?<w:t(?: [^>]*)?>([^<]*)<\/w:t><\/w:r>/g)]
            .map(([, rPr, text]): [string | undefined, string, string] => [rPr, text, /<w:pStyle w:val="([^"]*)"\/>/.exec(paragraph)?.[1] ?? 'Normal']));
        for (const [rPr, text, pStyle] of runs) {
          const rStyle = /<w:rStyle w:val="([^"]*)"\/>/.exec(rPr ?? '')?.[1];
          const chain = [rFontsIn(rPr), rStyle && styleRFonts(rStyle), styleRFonts(pStyle), styleRFonts('Normal'), defaults];
          const attribute = (name: string) => chain.map(rFonts => rFonts && new RegExp(' w:' + name + '="([^"]*)"').exec(rFonts)?.[1]).find(value => value !== undefined);
          const font = (slot: string) => {
            for (const rFonts of chain) {
              const theme = rFonts && new RegExp(' w:' + (slot === 'cs' ? 'cstheme' : slot + 'Theme') + '="([^"]*)"').exec(rFonts)?.[1];
              if (theme !== undefined) return 'theme ' + theme;
              const name = rFonts && new RegExp(' w:' + slot + '="([^"]*)"').exec(rFonts)?.[1];
              if (name !== undefined) return name;
            }
            return 'none';
          };
          const marked = /<w:(?:rtl|cs)\/>/.test(rPr ?? '');
          for (const character of text) {
            const slots = marked ? ['cs'] : characterFontSlots(character, attribute('hint') === 'eastAsia');
            expect(slots).toHaveLength(1);
            const asAscii = slots[0] === 'eastAsia' && font('eastAsia').toLowerCase() === 'times new roman' && font('ascii') === font('hAnsi');
            shown.push(character + ': ' + font(asAscii ? 'ascii' : slots[0]));
          }
        }
        expect(shown).not.toEqual([]);
        return shown;
      };
      const MIXED = '| A | 中 |\n| --- | --- |\n| 1 | 文 |\n';

      it.each([
        ['an East Asian font on its Chinese text', CHINESE, '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="MS Mincho"/>'],
        ['one font on all its Chinese text', CHINESE, '<w:rFonts w:ascii="MS Mincho" w:hAnsi="MS Mincho" w:eastAsia="MS Mincho"/>'],
        ['one font on its text, Latin and Chinese', MIXED, '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial"/>'],
        ['its ASCII font on its Chinese text, by an East Asian font of Times New Roman', CHINESE,
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Times New Roman"/>'],
      ])('keeps the font of its own where Word set %s, which export can\'t show the table\'s East Asian text in', async (_name, table, rFonts) => {
        // Export sets a table's font as its font for ASCII and the rest
        // only, so its directive for the font Word showed East Asian text in,
        // which import wrote, showed that text in the document's East Asian
        // font
        const { convertDocx } = await import('./converter');
        const set = await rFontsInWord(table, rFonts);
        const shown = await shownFonts(set);
        const font = shown[0].replace(/^.*?: /, '');
        expect(shown.every(character => character.endsWith(': ' + font))).toBe(true);
        expect(await shownFonts((await convertMdToDocx('<!-- table-font: ' + font + ' -->\n' + table)).docx)).not.toEqual(shown);
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: Georgia -->\n' + table);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['Greek, in its East Asian font, by an East Asian hint, which export shows it in as its font for the rest', ALL('α'), HINTED, 'MS Mincho'],
        ['Latin, with an East Asian font no character takes', TABLE, '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="MS Mincho"/>', 'Arial'],
        ['Hebrew marked right-to-left, in its complex script font, which export shows it in as its ASCII font', HEBREW,
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Times New Roman"/><w:rtl/>', 'Times New Roman'],
      ])('writes the font Word set on a table of %s, which export shows each character in again', async (_name, table, rFonts, font) => {
        const { convertDocx } = await import('./converter');
        const set = await rFontsInWord(table, rFonts);
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: ' + font + ' -->\n' + table);
        const exported = (await convertMdToDocx(converted)).docx;
        expect(await shownFonts(exported)).toEqual(await shownFonts(set));
        expect((await convertDocx(exported)).markdown).toBe(converted);
      });

      const CODE = '| A | `code` |\n| --- | --- |\n| 1 | 2 |\n';
      it.each([
        ['the document\'s font for tables', '---\ntable-font: Arial\n---\n\n', 'Arial'],
        ['the document\'s font for tables and code', '---\ntable-font: Courier New\ncode-font: Arial\n---\n\n', 'Courier New'],
      ])('keeps the font of its own where Word set %s on a table with inline code, which export shows in the code font', async (_name, frontmatter, font) => {
        // Export leaves the document's font for tables to the table
        // paragraph style, which inline code doesn't show, as CodeChar's
        // font goes over it, so the directive for that font, which import
        // wrote, showed the code in the code font
        const { convertDocx } = await import('./converter');
        const set = await rFontsInWord(CODE, '<w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '"/>', frontmatter);
        const shown = await shownFonts(set);
        expect(shown.every(character => character.endsWith(': ' + font))).toBe(true);
        expect(await shownFonts((await convertMdToDocx(frontmatter + '<!-- table-font: ' + font + ' -->\n' + CODE)).docx)).not.toEqual(shown);
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: Georgia -->\n' + CODE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('writes the code font Word set on a table with inline code, where it\'s the document\'s font for tables', async () => {
        // Export shows all of the table's text in the code font, its own and
        // CodeChar's
        const { convertDocx } = await import('./converter');
        const frontmatter = '---\ntable-font: Consolas\n---\n\n';
        const set = await rFontsInWord(CODE, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>', frontmatter);
        const converted = (await convertDocx(set)).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: Consolas -->\n' + CODE);
        const exported = (await convertMdToDocx(converted)).docx;
        expect(await shownFonts(exported)).toEqual(await shownFonts(set));
        expect((await convertDocx(exported)).markdown).toBe(converted);
      });

      it('writes the font Word set on a table of inline code, links and notes\' references only where export shows all its text in it again', async () => {
        // Import wrote a directive for the font Word showed, whatever the
        // runs export would leave to their character style's font
        const fc = (await import('fast-check')).default;
        const { convertDocx } = await import('./converter');
        const FONTS = ['Arial', 'Georgia', 'Consolas', 'Courier New'];
        const CELLS = ['a', '`c`', '[l](https://example.com)', '**b**', 'n[^n]'];
        /** The table directive of Markdown import wrote, or none */
        const directiveOf = (markdown: string) => /<!-- table-font: (.*?) -->/.exec(markdown)?.[1];
        await fc.assert(fc.asyncProperty(
          fc.option(fc.constantFrom(...FONTS), { nil: undefined }), fc.option(fc.constantFrom(...FONTS), { nil: undefined }),
          fc.option(fc.constantFrom(...FONTS), { nil: undefined }), fc.array(fc.constantFrom(...CELLS), { minLength: 4, maxLength: 4 }),
          fc.constantFrom(...FONTS),
          async (tableFont, codeFont, directive, cells, font) => {
            const frontmatter = tableFont || codeFont ? '---\n' + (tableFont ? 'table-font: ' + tableFont + '\n' : '')
              + (codeFont ? 'code-font: ' + codeFont + '\n' : '') + '---\n\n' : '';
            let notes = 0;
            const row = (texts: string[]) => '| ' + texts.map(text => text === 'n[^n]' ? 'n[^' + ++notes + ']' : text).join(' | ') + ' |\n';
            const table = row(cells.slice(0, 2)) + '| --- | --- |\n' + row(cells.slice(2));
            const definitions = Array.from({ length: notes }, (_, i) => '\n[^' + (i + 1) + ']: Note.\n').join('');
            const markdown = (directive: string | undefined) => frontmatter + (directive ? '<!-- table-font: ' + directive + ' -->\n' : '') + table + definitions;
            // Word sets the font on each of the table's runs
            const zip = await JSZip.loadAsync((await convertMdToDocx(markdown(directive))).docx);
            const xml = await zip.file('word/document.xml')!.async('string');
            const rFonts = '<w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:eastAsia="' + font + '" w:cs="' + font + '"/>';
            zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, found => found
              .replace(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?/g, (_run, rPr: string | undefined) => '<w:r><w:rPr>' + rFonts + (rPr ?? '').replace(/<w:rFonts [^>]*\/>/, '') + '</w:rPr>')));
            const set = await zip.generateAsync({ type: 'uint8array' });
            const shown = await shownFonts(set);
            expect(shown.every(character => character.endsWith(': ' + font))).toBe(true);
            const converted = (await convertDocx(set)).markdown;
            const exported = (await convertMdToDocx(converted)).docx;
            // A directive import changed shows the text as Word did
            if (directiveOf(converted) !== directive) expect(await shownFonts(exported)).toEqual(shown);
            // And import changes it where one for Word's font would
            if ((await shownFonts((await convertMdToDocx(markdown(font))).docx)).join('\n') === shown.join('\n')) expect(directiveOf(converted)).toBe(font);
            expect((await convertDocx(exported)).markdown).toBe(converted);
          }), { numRuns: 40 });
      });

      it('gives each character the font the table of MS-OI29500 gives its range, by the run\'s hint, and the font for the rest where it lists none', async () => {
        // A row of the table import reads it by joined ranges with a gap
        // between them, 31A0-31FF, as Bopomofo Extended, so a table of such
        // text read as in its East Asian font. Each row of the table, as the
        // spec has it (MS-OI29500, Part 1 17.3.2.26, rFonts, note b), by its
        // first and last code point, and the font Word shows its characters
        // in: one of a w:rFonts' fonts, or `hint`, its font for the rest but
        // its East Asian font where the run's hint is eastAsia, or
        // `language`, the same, but only where the run's language, or for
        // some ranges the East Asian font's character set, is Chinese too
        const { characterFontSlots } = await import('./converter');
        type Rule = 'ascii' | 'hAnsi' | 'eastAsia' | 'hint' | 'language';
        const spec: [number, number, Rule][] = [
          [0x0000, 0x007F, 'ascii'], // Basic Latin
          // Latin-1 Supplement, 00A0-00FF, in its font for the rest but these
          [0x00A1, 0x00A1, 'hint'], [0x00A4, 0x00A4, 'hint'], [0x00A7, 0x00A8, 'hint'], [0x00AA, 0x00AA, 'hint'], [0x00AD, 0x00AD, 'hint'],
          [0x00AF, 0x00AF, 'hint'], [0x00B0, 0x00B4, 'hint'], [0x00B6, 0x00BA, 'hint'], [0x00BC, 0x00BF, 'hint'], [0x00D7, 0x00D7, 'hint'],
          [0x00F7, 0x00F7, 'hint'], [0x00E0, 0x00E1, 'language'], [0x00E8, 0x00EA, 'language'], [0x00EC, 0x00ED, 'language'],
          [0x00F2, 0x00F3, 'language'], [0x00F9, 0x00FA, 'language'], [0x00FC, 0x00FC, 'language'],
          [0x0100, 0x017F, 'language'], // Latin Extended-A
          [0x0180, 0x024F, 'language'], // Latin Extended-B
          [0x0250, 0x02AF, 'language'], // IPA Extensions
          [0x02B0, 0x02FF, 'hint'], // Spacing Modifier Letters
          [0x0300, 0x036F, 'hint'], // Combining Diacritical Marks
          [0x0370, 0x03CF, 'hint'], // Greek
          [0x0400, 0x04FF, 'hint'], // Cyrillic
          [0x0590, 0x05FF, 'ascii'], // Hebrew
          [0x0600, 0x06FF, 'ascii'], // Arabic
          [0x0700, 0x074F, 'ascii'], // Syriac
          [0x0750, 0x077F, 'ascii'], // Arabic Supplement
          [0x0780, 0x07BF, 'ascii'], // Thaana
          [0x1100, 0x11FF, 'eastAsia'], // Hangul Jamo
          [0x1E00, 0x1EFF, 'language'], // Latin Extended Additional
          [0x2000, 0x206F, 'hint'], // General Punctuation
          [0x2070, 0x209F, 'hint'], // Superscripts and Subscripts
          [0x20A0, 0x20CF, 'hint'], // Currency Symbols
          [0x20D0, 0x20FF, 'hint'], // Combining Diacritical Marks for Symbols
          [0x2100, 0x214F, 'hint'], // Letter-like Symbols
          [0x2150, 0x218F, 'hint'], // Number Forms
          [0x2190, 0x21FF, 'hint'], // Arrows
          [0x2200, 0x22FF, 'hint'], // Mathematical Operators
          [0x2300, 0x23FF, 'hint'], // Miscellaneous Technical
          [0x2400, 0x243F, 'hint'], // Control Pictures
          [0x2440, 0x245F, 'hint'], // Optical Character Recognition
          [0x2460, 0x24FF, 'hint'], // Enclosed Alphanumerics
          [0x2500, 0x257F, 'hint'], // Box Drawing
          [0x2580, 0x259F, 'hint'], // Block Elements
          [0x25A0, 0x25FF, 'hint'], // Geometric Shapes
          [0x2600, 0x26FF, 'hint'], // Miscellaneous Symbols
          [0x2700, 0x27BF, 'hint'], // Dingbats
          [0x2E80, 0x2EFF, 'hint'], // CJK Radicals Supplement
          [0x2F00, 0x2FDF, 'eastAsia'], // Kangxi Radicals
          [0x2FF0, 0x2FFF, 'eastAsia'], // Ideographic Description Characters
          [0x3000, 0x303F, 'eastAsia'], // CJK Symbols and Punctuation
          [0x3040, 0x309F, 'eastAsia'], // Hiragana
          [0x30A0, 0x30FF, 'eastAsia'], // Katakana
          [0x3100, 0x312F, 'eastAsia'], // Bopomofo
          [0x3130, 0x318F, 'eastAsia'], // Hangul Compatibility Jamo
          [0x3190, 0x319F, 'eastAsia'], // Kanbun
          [0x3200, 0x32FF, 'eastAsia'], // Enclosed CJK Letters and Months
          [0x3300, 0x33FF, 'eastAsia'], // CJK Compatibility
          [0x3400, 0x4DBF, 'eastAsia'], // CJK Unified Ideographs Extension A
          [0x4E00, 0x9FAF, 'eastAsia'], // CJK Unified Ideographs
          [0xA000, 0xA48F, 'eastAsia'], // Yi Syllables
          [0xA490, 0xA4CF, 'eastAsia'], // Yi Radicals
          [0xAC00, 0xD7AF, 'eastAsia'], // Hangul Syllables
          [0xD800, 0xDB7F, 'eastAsia'], // High Surrogates
          [0xDB80, 0xDBFF, 'eastAsia'], // High Private Use Surrogates
          [0xDC00, 0xDFFF, 'eastAsia'], // Low Surrogates
          [0xE000, 0xF8FF, 'hint'], // Private Use Area
          [0xF900, 0xFAFF, 'eastAsia'], // CJK Compatibility Ideographs
          // Alphabetic Presentation Forms, FB00-FB4F
          [0xFB00, 0xFB1C, 'hint'], [0xFB1D, 0xFB4F, 'ascii'],
          [0xFB50, 0xFDFF, 'ascii'], // Arabic Presentation Forms-A
          [0xFE30, 0xFE4F, 'eastAsia'], // CJK Compatibility Forms
          [0xFE50, 0xFE6F, 'eastAsia'], // Small Form Variants
          [0xFE70, 0xFEFE, 'ascii'], // Arabic Presentation Forms-B
          [0xFF00, 0xFFEF, 'eastAsia'], // Halfwidth and Fullwidth Forms
        ];
        const slots = (rule: Rule, hint: boolean | undefined) => rule === 'hint' ? (hint === undefined ? ['hAnsi', 'eastAsia'] : hint ? ['eastAsia'] : ['hAnsi'])
          : rule === 'language' ? (hint === false ? ['hAnsi'] : ['hAnsi', 'eastAsia']) : [rule];
        // Each row's first and last code point, and those around it, where
        // a gap between rows starts or ends
        const codes = new Set(spec.flatMap(([first, last]) => [first - 1, first, last, last + 1]).filter(code => code >= 0 && code <= 0xFFFF));
        const drift: string[] = [];
        for (const code of codes) {
          const rule = spec.find(([first, last]) => first <= code && code <= last)?.[2] ?? 'hAnsi';
          for (const hint of [false, true, undefined]) {
            const read = characterFontSlots(String.fromCharCode(code), hint);
            if (read.join() !== slots(rule, hint).join()) drift.push(code.toString(16).toUpperCase().padStart(4, '0') + ' with hint ' + hint + ': ' + read.join() + ', not ' + slots(rule, hint).join());
          }
        }
        expect(codes.size).toBeGreaterThan(spec.length * 2);
        expect(drift).toEqual([]);
      });

      it.each([
        ['Latin-1 Supplement that an East Asian hint takes in Chinese', '\u00e9'],
        ['Latin Extended-A, which an East Asian hint takes in Chinese or with a Chinese East Asian font', '\u0101'],
        ['Latin Extended Additional, which an East Asian hint takes in Chinese', '\u1ea1'],
      ])('keeps the font of its own on a table all of %s, with the hint, where its font for the rest and its East Asian font differ', async (_name, character) => {
        // Word shows it in either, by the run's language or the East Asian
        // font's character set, which import doesn't read
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(ALL(character), HINTED))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: Georgia -->\n' + ALL(character));
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      const NOTE = '| A | B |\n| --- | --- |\n| 1[^n] | 2 |\n\n[^n]: Note.\n';
      it.each([
        ['writes the font Word set on a table with a note\'s reference, on its mark too, for all its kinds of text',
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial"/>', 'Arial'],
        ['keeps the font of its own on a table with a note\'s reference where Word set another for ASCII and the rest only',
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>', 'Georgia'],
      ])('%s', async (_name, rFonts, font) => {
        // The mark's characters, which import doesn't read, as it doesn't
        // the notes' numbering, may show in any of the fonts, though a run
        // with none went unread
        const { convertDocx } = await import('./converter');
        const converted = (await convertDocx(await rFontsInWord(NOTE, rFonts))).markdown;
        expect(parseFrontmatter(converted).body).toBe('<!-- table-font: ' + font + ' -->\n' + NOTE);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['one font for ASCII and another for the rest', '<w:rFonts w:ascii="Arial" w:hAnsi="Georgia"/>'],
        ['a theme\'s font', '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>'],
      ])('keeps the font of its own, the document\'s, where the table paragraph style its text takes sets %s', async (_name, rFonts) => {
        // Text that takes the style's font was read as in the document's
        // font for tables, by the style's ASCII font or none, so the table's
        // seemed another
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const table = '| A | B |\n| --- | --- |\n| 1 | \u03b1 |\n';
        const zip = await JSZip.loadAsync((await convertMdToDocx('---\ntable-font: Georgia\n---\n\n<!-- table-font: Georgia -->\n' + table)).docx);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const set = styles.replace(/(<w:style\b[^>]*w:styleId="TableParagraph"[\s\S]*?)<w:rFonts [^>]*\/>/, (_style, before: string) => before + rFonts);
        expect(set).not.toBe(styles);
        zip.file('word/styles.xml', set);
        expect(await zip.file('word/document.xml')!.async('string')).not.toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?<w:rFonts/);
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: Georgia -->\n' + table);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it.each([
        ['a paragraph style', '<!-- table-font: Georgia -->\n', ['Georgia'],
          (table: string) => table.replace(/<w:pStyle w:val="TableParagraph"\/>/g, '<w:pStyle w:val="GeorgiaTable"/>')],
        ['a character style', '<!-- table-font: Georgia -->\n', ['Georgia'],
          (table: string) => table.replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="GeorgiaText"/>')],
        ['a character style that sets none, the document\'s', '', [],
          (table: string) => table.replace(/<w:r><w:rPr>/g, '$&<w:rStyle w:val="Plain"/>')],
      ])('writes the font of a table whose text takes it from %s', async (_name, directive, fonts, edit) => {
        // Text with no font of its own in another style than the table
        // paragraph style's isn't in the document's
        const JSZip = (await import('jszip')).default;
        const { convertDocx } = await import('./converter');
        const zip = await JSZip.loadAsync((await convertMdToDocx(DOCUMENT + '<!-- table-font: Georgia -->\n' + TABLE)).docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        const edited = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table => edit(table.replace(/<w:rFonts [^>]*\/>/g, '')));
        expect(edited).not.toContain('<w:rFonts');
        zip.file('word/document.xml', edited);
        const styles = await zip.file('word/styles.xml')!.async('string');
        const georgia = '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr>';
        zip.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:customStyle="1" w:styleId="GeorgiaTable">'
          + '<w:name w:val="Georgia Table"/><w:basedOn w:val="TableParagraph"/>' + georgia + '</w:style>'
          + '<w:style w:type="character" w:customStyle="1" w:styleId="GeorgiaText"><w:name w:val="Georgia Text"/>' + georgia + '</w:style>'
          + '<w:style w:type="character" w:customStyle="1" w:styleId="Plain"><w:name w:val="Plain"/><w:rPr><w:i w:val="0"/></w:rPr></w:style></w:styles>'));
        const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe(directive + TABLE);
        expect(await tableFonts(converted)).toEqual(fonts);
        expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
      });

      it('keeps a font of its own, the document\'s, whose name has a character XML escapes', async () => {
        // The document's, in styles.xml as A &amp; B, didn't match the table's
        const { convertDocx } = await import('./converter');
        const markdown = '---\ntable-font: A & B\n---\n\n<!-- table-font: A & B -->\n' + TABLE;
        const converted = (await convertDocx((await convertMdToDocx(markdown)).docx)).markdown;
        expect(parseFrontmatter(converted).body.replace(/^\n/, '')).toBe('<!-- table-font: A & B -->\n' + TABLE);
      });
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

describe('styles whose elements Word ignores', () => {
  it('reads no custom style from a style with the ID of one, as NoList', async () => {
    // Word ignores the elements of NoList, DefaultParagraphFont and
    // TableNormal (MS-OI29500, Part 1 17.7.4.17), its name and properties
    // too, but the frontmatter read the custom style's font and size
    const { convertDocx } = await import('./converter');
    const markdown = '---\nstyles:\n  pullquote:\n    font: Garamond\n    font-size: 13\n---\n\n<!-- style: pullquote -->\n\nStyled text.\n\n<!-- /style -->\n';
    const zip = await JSZip.loadAsync((await convertMdToDocx(markdown)).docx);
    // Without the copy of custom styles export keeps, so they come from styles.xml
    zip.remove('docProps/custom.xml');
    const styles = await zip.file('word/styles.xml')!.async('string');
    const id = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>\s*<w:name w:val="Custom: pullquote"/.exec(styles)![1];
    const renamed = (xml: string) => xml.split('w:styleId="NoList"').join('w:styleId="NoListOther"').split('"' + id + '"').join('"NoList"');
    zip.file('word/styles.xml', renamed(styles));
    zip.file('word/document.xml', renamed(await zip.file('word/document.xml')!.async('string')));
    const converted = (await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown;
    expect(parseFrontmatter(converted).metadata.styles).toBeUndefined();
    expect((await convertDocx((await convertMdToDocx(converted)).docx)).markdown).toBe(converted);
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

  // Word writes run properties in schema order and reorders others on open,
  // marking the document changed
  it.each([
    ['a heading', 'header-font: Georgia\nheader-font-size: 13\nheader-font-style: bold-underline-smallcaps', 'Heading1',
      '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:smallCaps/><w:sz w:val="26"/><w:szCs w:val="26"/><w:u w:val="single"/>'],
    ['the title', 'title-font: Georgia\ntitle-font-style: italic-underline-allcaps', 'Title',
      '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:i/><w:caps/><w:sz w:val="56"/><w:szCs w:val="56"/><w:u w:val="single"/>'],
    ['a custom style', 'styles:\n  epigraph:\n    font: Georgia\n    font-size: 13\n    font-style: bold-underline-smallcaps', 'MsCustomEpigraph',
      '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:smallCaps/><w:sz w:val="26"/><w:szCs w:val="26"/><w:u w:val="single"/>'],
  ])('the rPr export writes into its own style for %s goes in schema order', async (_name, fields, id, expected) => {
    const { convertDocx } = await import('./converter');
    const md = '---\n' + fields + '\ntitle: T\n---\n\n# One\n\n<!-- style: epigraph -->\n\nStyled\n\n<!-- /style -->\n';
    const docx = (await convertMdToDocx(md)).docx;
    const styles = await (await JSZip.loadAsync(docx)).file('word/styles.xml')!.async('string');
    expect(/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(extractStyleBlock(styles, id)!)?.[1]).toBe(expected);
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata).toMatchObject(parseFrontmatter(md).metadata);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), id)).toBe(extractStyleBlock(styles, id));
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

  // Word strips an empty pPr
  it.each([
    ['only the indent', '<w:pPr><w:ind w:left="720" w:hanging="720"/></w:pPr>', ''],
    ['the indent and spacing', '<w:pPr><w:spacing w:after="200"/><w:ind w:left="720" w:hanging="720"/></w:pPr>', '<w:pPr><w:spacing w:after="200"/></w:pPr>'],
  ])('a template\'s bibliography style with %s keeps no empty pPr without its hanging indent', async (_name, pPr, expected) => {
    const { convertDocx } = await import('./converter');
    const head = '<w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/>';
    const { styles, docx } = await exportedStyles('bibliography-hanging-indent: false', ['Bibliography', head + pPr]);
    expect(extractStyleBlock(styles, 'Bibliography')!.replace(/^<w:style\b[^>]*>/, '')).toBe(head + expected + '</w:style>');
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.bibliographyHangingIndent).toBe(false);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), 'Bibliography')).toBe(extractStyleBlock(styles, 'Bibliography'));
    expect((await convertDocx(again)).markdown).toBe(markdown);
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

  // Word writes a style's properties on lines of their own where it's
  // asked to indent its XML, and orders them all the same
  it('the off export writes into a template\'s heading whose rPr is indented goes in schema order', async () => {
    const { convertDocx } = await import('./converter');
    const indented = '\n      <w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>\n      <w:sz w:val="32"/>\n      <w:szCs w:val="32"/>\n    ';
    const { styles, docx } = await exportedStyles('header-font-style: normal', ['Normal', '<w:name w:val="Normal"/><w:qFormat/><w:rPr><w:b/></w:rPr>'],
      heading(1, '\n    <w:basedOn w:val="Normal"/>\n    <w:rPr>' + indented + '</w:rPr>\n  '));
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(extractStyleBlock(styles, 'Heading1')!)![1];
    expect(rPr.replace(/>\s+</g, '><').trim()).toBe('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b w:val="0"/><w:sz w:val="32"/><w:szCs w:val="32"/>');
    const { markdown } = await convertDocx(docx);
    expect(parseFrontmatter(markdown).metadata.headerFontStyle).toEqual(['normal']);
    const again = (await convertMdToDocx(markdown, { templateDocx: docx })).docx;
    expect(noSize(extractStyleBlock(await (await JSZip.loadAsync(again)).file('word/styles.xml')!.async('string'), 'Heading1'))).toBe(noSize(extractStyleBlock(styles, 'Heading1')));
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
