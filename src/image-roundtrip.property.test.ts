import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import {
  emuToPixels, pixelsToEmu, isSupportedImageFormat,
  computeMissingDimension, resolveImageFilename,
  SUPPORTED_IMAGE_EXTENSIONS
} from './image-utils';

describe('image-roundtrip properties', () => {
  // Feature: image-roundtrip, Property 1: EMU↔pixel conversion roundtrip
  it('P1: emuToPixels(pixelsToEmu(px)) === px for any positive integer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        (px) => {
          expect(emuToPixels(pixelsToEmu(px))).toBe(px);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: image-roundtrip, Property 9: Supported format filtering
  it('P9: supported formats accepted, unsupported rejected', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('png', 'jpg', 'jpeg', 'gif', 'svg'),
        (ext) => {
          expect(isSupportedImageFormat(ext)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
    fc.assert(
      fc.property(
        fc.constantFrom('bmp', 'tiff', 'webp', 'emf', 'wmf'),
        (ext) => {
          expect(isSupportedImageFormat(ext)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: image-roundtrip, Property 6: Aspect ratio preservation
  it('P6: single-dimension spec preserves aspect ratio within ±1px', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        (intrW, intrH, explicitDim) => {
          // Width-only
          const wOnly = computeMissingDimension({ width: explicitDim }, { width: intrW, height: intrH });
          const expectedH = Math.round(explicitDim * intrH / intrW);
          expect(Math.abs(wOnly.height - expectedH)).toBeLessThanOrEqual(1);
          expect(wOnly.width).toBe(explicitDim);

          // Height-only
          const hOnly = computeMissingDimension({ height: explicitDim }, { width: intrW, height: intrH });
          const expectedW = Math.round(explicitDim * intrW / intrH);
          expect(Math.abs(hOnly.width - expectedW)).toBeLessThanOrEqual(1);
          expect(hOnly.height).toBe(explicitDim);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: image-roundtrip, Property 10: Filename resolution priority
  it('P10: docPr name with valid ext used; otherwise media filename', () => {
    const arbExt = fc.constantFrom(...[...SUPPORTED_IMAGE_EXTENSIONS]);
    const arbBasename = fc.stringMatching(/^[a-z]{1,10}$/).filter(s => s.length > 0);
    fc.assert(
      fc.property(arbBasename, arbExt, arbBasename, arbExt, (docBase, docExt, mediaBase, mediaExt) => {
        const docPrName = docBase + '.' + docExt;
        const mediaFilename = mediaBase + '.' + mediaExt;
        // When docPr has valid extension, use it
        expect(resolveImageFilename(docPrName, mediaFilename)).toBe(docPrName);
        // When docPr has no extension, use media filename
        expect(resolveImageFilename(docBase, mediaFilename)).toBe(mediaFilename);
        // When docPr is undefined, use media filename
        expect(resolveImageFilename(undefined, mediaFilename)).toBe(mediaFilename);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: image-roundtrip, Property 11: Image format metadata serialization roundtrip
  it('P11: chunked-JSON image format mapping roundtrip', async () => {
    // We test the serialization/deserialization by going through the actual
    // custom property XML generation and extraction functions
    const { convertMdToDocx } = await import('./md-to-docx');
    const { extractImageFormatMapping } = await import('./converter');
    const JSZip = (await import('jszip')).default;

    const arbRId = fc.integer({ min: 1, max: 50 }).map(n => 'rId' + String(n));
    const arbSyntax = fc.constantFrom('md', 'html');
    const arbMapping = fc.array(fc.tuple(arbRId, arbSyntax), { minLength: 1, maxLength: 10 })
      .map(pairs => new Map(pairs));

    await fc.assert(
      fc.asyncProperty(arbMapping, async (mapping) => {
        // Serialize: build a minimal DOCX with MANUSCRIPT_IMAGE_FORMATS custom property
        const zip = new JSZip();
        const obj: Record<string, string> = {};
        for (const [k, v] of mapping) obj[k] = v;
        const json = JSON.stringify(obj);
        const CHUNK_SIZE = 240;
        let propsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n';
        for (let i = 0, idx = 1; i < json.length; i += CHUNK_SIZE, idx++) {
          propsXml += '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + (idx + 1) + '" name="MANUSCRIPT_IMAGE_FORMATS_' + idx + '"><vt:lpwstr>' + json.slice(i, i + CHUNK_SIZE) + '</vt:lpwstr></property>\n';
        }
        propsXml += '</Properties>';
        zip.file('docProps/custom.xml', propsXml);

        // Deserialize
        const result = await extractImageFormatMapping(zip);
        expect(result).not.toBeNull();
        if (result) {
          for (const [k, v] of mapping) {
            expect(result.get(k)).toBe(v);
          }
        }
      }),
      { numRuns: 50 }
    );
  });

  // Feature: image-roundtrip, Property 5: Image attribute parsing
  it('P5: parsing extracts correct src, alt, width, height from both syntaxes', () => {
    const { parseMd } = require('./md-to-docx');
    const arbDim = fc.integer({ min: 1, max: 5000 });
    const arbAlt = fc.stringMatching(/^[a-zA-Z0-9 ]{0,20}$/).filter(s => !s.includes(']'));
    const arbFilename = fc.stringMatching(/^[a-z]{1,8}$/).filter(s => s.length > 0).map(s => s + '.png');

    fc.assert(
      fc.property(arbFilename, arbAlt, arbDim, arbDim, (filename, alt, w, h) => {
        // Test attribute syntax: ![alt](path){width=W height=H}
        const mdSyntax = '![' + alt + '](' + filename + '){width=' + w + ' height=' + h + '}';
        const tokens = parseMd(mdSyntax);
        const imgRun = tokens[0]?.runs?.find((r: any) => r.type === 'image');
        expect(imgRun).toBeDefined();
        if (imgRun) {
          expect(imgRun.imageSrc).toBe(filename);
          expect(imgRun.imageAlt).toBe(alt);
          expect(imgRun.imageWidth).toBe(w);
          expect(imgRun.imageHeight).toBe(h);
          expect(imgRun.imageSyntax).toBe('md');
        }

        // Test HTML syntax: <img src="path" alt="alt" width="W" height="H">
        const htmlSyntax = '<img src="' + filename + '" alt="' + alt + '" width="' + w + '" height="' + h + '">';
        const htmlTokens = parseMd(htmlSyntax);
        const htmlRun = htmlTokens[0]?.runs?.find((r: any) => r.type === 'image');
        expect(htmlRun).toBeDefined();
        if (htmlRun) {
          expect(htmlRun.imageSrc).toBe(filename);
          expect(htmlRun.imageAlt).toBe(alt);
          expect(htmlRun.imageWidth).toBe(w);
          expect(htmlRun.imageHeight).toBe(h);
          expect(htmlRun.imageSyntax).toBe('html');
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: image-roundtrip, Property 5b: Image dimension unit parsing
  it('P5b: image dimensions accept absolute units and convert them to pixels', () => {
    const { parseMd } = require('./md-to-docx');

    const cases = [
      {
        md: '![alt](test.png){width=2in height=5.08cm}',
        width: 192,
        height: 192,
      },
      {
        md: '<img src="test.png" alt="alt" width="25.4mm" height="72pt">',
        width: 96,
        height: 96,
      },
      {
        md: '<img src="test.png" alt="alt" width=6pc height=96px>',
        width: 96,
        height: 96,
      },
    ];

    for (const c of cases) {
      const tokens = parseMd(c.md);
      const imgRun = tokens[0]?.runs?.find((r: any) => r.type === 'image');
      expect(imgRun).toBeDefined();
      expect(imgRun.imageWidth).toBe(c.width);
      expect(imgRun.imageHeight).toBe(c.height);
    }
  });

  // Feature: image-roundtrip, Property 5c: HTML image dimension attribute boundaries
  it('P5c: HTML image dimensions ignore longer attribute names', () => {
    const { parseMd } = require('./md-to-docx');
    const md = '<img src="test.png" alt="alt" data-width="2in" width="96" data-height="5.08cm" height="48">';
    const tokens = parseMd(md);
    const imgRun = tokens[0]?.runs?.find((r: any) => r.type === 'image');

    expect(imgRun).toBeDefined();
    expect(imgRun.imageWidth).toBe(96);
    expect(imgRun.imageHeight).toBe(48);
  });

  // --- Roundtrip property tests (P2, P3, P4, P7, P8) ---
  // These require a real image file on disk for MD→DOCX conversion.

  // Minimal valid 1x1 PNG binary
  const PNG_1x1 = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8-bit RGB
    0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
    0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
  ]);

  function setupTempImage(): { dir: string; imgPath: string; cleanup: () => void } {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-test-'));
    const imgPath = path.join(dir, 'test.png');
    fs.writeFileSync(imgPath, PNG_1x1);
    return { dir, imgPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  // Feature: image-roundtrip, Property 2: Dimension roundtrip
  it('P2: explicit dimensions survive MD→DOCX→MD roundtrip', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 624 }),
        fc.integer({ min: 1, max: 5000 }),
        async (w, h) => {
          const { dir, cleanup } = setupTempImage();
          try {
            const md = '![alt](test.png){width=' + w + ' height=' + h + '}';
            const { docx } = await convertMdToDocx(md, { sourceDir: dir });
            const result = await convertDocx(docx);
            const imgMatch = result.markdown.match(/\{width=(\d+)\s+height=(\d+)\}/);
            expect(imgMatch).not.toBeNull();
            if (imgMatch) {
              expect(parseInt(imgMatch[1], 10)).toBe(w);
              expect(parseInt(imgMatch[2], 10)).toBe(h);
            }
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('autofits an oversized image to the page text width and preserves its aspect ratio', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(dir, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"></svg>');
      const md = '![wide figure](wide.svg)';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });
      const zip = await JSZip.loadAsync(docx);
      const documentXml = await zip.file('word/document.xml')!.async('string');

      // US Letter with 1-inch margins has 6.5 inches = 624 px of writable width.
      expect(documentXml).toContain('<wp:extent cx="5943600" cy="2971800"/>');
      expect(documentXml).toContain('<a:ext cx="5943600" cy="2971800"/>');
    } finally {
      cleanup();
    }
  });

  it('uses the wider writable width inside a landscape section', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const md = '<!-- landscape -->\n\n![wide figure](test.png){width=1200 height=600}\n\n<!-- /landscape -->';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });
      const zip = await JSZip.loadAsync(docx);
      const documentXml = await zip.file('word/document.xml')!.async('string');

      // Landscape Letter with 1-inch margins has 9 inches = 864 px of writable width.
      expect(documentXml).toContain('<wp:extent cx="8229600" cy="4114800"/>');
    } finally {
      cleanup();
    }
  });

  it('uses the wider writable width in a table\'s own landscape section', async () => {
    // An image in the table took the width of a portrait page's text
    const { convertMdToDocx } = await import('./md-to-docx');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const md = 'A.\n\n<!-- table-orientation: landscape -->\n| h |\n| --- |\n| ![wide figure](test.png){width=1200 height=600} |\n\nB.\n';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });
      const zip = await JSZip.loadAsync(docx);
      const documentXml = await zip.file('word/document.xml')!.async('string');

      // Landscape Letter with 1-inch margins has 9 inches = 864 px of writable width.
      expect(documentXml).toContain('<wp:extent cx="8229600" cy="4114800"/>');
    } finally {
      cleanup();
    }
  });

  it.each([
    ['a landscape section', 'of equal width', '<w:cols w:num="2" w:space="720"/>', 'Intro.\n\n<!-- landscape -->\n\n![wide figure](test.png){width=1200 height=600}\n\n<!-- /landscape -->\n\nEnd.\n', 408],
    ['the body', 'of equal width', '<w:cols w:num="2" w:space="720"/>', '![wide figure](test.png){width=1200 height=600}\n', 288],
    ['the body', 'each of its own width', '<w:cols w:num="2" w:space="720" w:equalWidth="0"><w:col w:w="5760" w:space="720"/><w:col w:w="2880"/></w:cols>', '![wide figure](test.png){width=1200 height=600}\n', 192],
    // Word reads columns as of equal width where w:equalWidth isn't given
    // ([MS-OI29500] Part 1 Section 17.6.4, b), whatever widths they're given
    ['the body', 'of equal width where it gives each a width but not that they are not equal', '<w:cols w:num="2" w:space="720"><w:col w:w="5760" w:space="720"/><w:col w:w="2880"/></w:cols>', '![wide figure](test.png){width=1200 height=600}\n', 288],
    // Which says off as Word reads it, with XML's white space around it,
    // and was read as on, so the image took the width of the page's text
    ['the body', 'each of its own width, not equal written with white space around it', '<w:cols w:equalWidth=" false "><w:col w:w="4320" w:space="720"/><w:col w:w="4320"/></w:cols>', '![wide figure](test.png){width=1200 height=600}\n', 288],
    ['a landscape section', 'of equal width, under another prefix for their namespace', '<localw:cols localw:num="2" localw:space="720"/>', 'Intro.\n\n<!-- landscape -->\n\n![wide figure](test.png){width=1200 height=600}\n\n<!-- /landscape -->\n\nEnd.\n', 408],
    ['a table\'s own landscape section', 'of equal width', '<w:cols w:num="2" w:space="720"/>', 'Intro.\n\n<!-- table-orientation: landscape -->\n| h |\n| --- |\n| ![wide figure](test.png){width=1200 height=600} |\n\nEnd.\n', 408],
  ])('fits an oversized image in %s to the narrowest of the template\'s columns %s', async (_, __, cols, md, width) => {
    // An image took the width of the page's text, which two columns share,
    // so it ran over its column
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const JSZip = (await import('jszip')).default;
    const fs = require('fs');
    const path = require('path');

    const template = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
    const xml = await template.file('word/document.xml')!.async('string');
    template.file('word/document.xml', xml.replace(/<w:cols\b[^>]*\/>/, () => cols)
      .replace(/<w:sectPr\b(?![\s\S]*<w:sectPr\b)/, open => open + ' xmlns:localw="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'));
    const templateDocx = await template.generateAsync({ type: 'uint8array' });
    const { dir, cleanup } = setupTempImage();
    try {
      const { docx } = await convertMdToDocx(md, { sourceDir: dir, templateDocx });
      const documentXml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      // 1 px = 9525 EMU
      expect(documentXml).toContain('<wp:extent cx="' + width * 9525 + '" cy="' + width / 2 * 9525 + '"/>');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('{width=' + width + ' height=' + width / 2 + '}');
      for (const [name, bytes] of result.images ?? []) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
      }
      const again = await convertMdToDocx(result.markdown, { sourceDir: dir, templateDocx });
      expect((await convertDocx(again.docx)).markdown).toBe(result.markdown);
    } finally {
      cleanup();
    }
  });

  const wideFigure = '![wide figure](test.png){width=1200 height=600}';
  it.each([
    ['the only section', 'one column', '', wideFigure + '\n', 864],
    ['the only section', 'two columns', '<w:cols w:num="2" w:space="720"/>', wideFigure + '\n', 408],
    // Their space in inches, which reads as none by its number alone
    ['the only section', 'two columns half an inch apart', '<w:cols w:num="2" w:space="0.5in"/>', wideFigure + '\n', 408],
    ['the last section, after a fence', 'one column', '', 'Intro.\n\n<!-- landscape -->\n\nW.\n\n<!-- /landscape -->\n\n' + wideFigure + '\n', 864],
    ['the last section, after a table of its own orientation', 'one column', '', 'Intro.\n\n<!-- table-orientation: portrait -->\n| h |\n| --- |\n| x |\n\n' + wideFigure + '\n', 864],
    // A break gives the section it ends an upright page
    ['a section before a fence', 'one column', '', wideFigure + '\n\n<!-- landscape -->\n\nW.\n\n<!-- /landscape -->\n\nEnd.\n', 624],
    ['a table of its own portrait orientation', 'one column', '', 'Intro.\n\n<!-- table-orientation: portrait -->\n| h |\n| --- |\n| ' + wideFigure + ' |\n', 624],
    // Which can't hold them, so it has one
    ['a portrait section', 'two columns too far apart for its upright page', '<w:cols w:num="2" w:space="9600"/>', 'Intro.\n\n<!-- portrait -->\n\n' + wideFigure + '\n\n<!-- /portrait -->\n\nEnd.\n', 624],
    // Which it scales down to fit
    ['a portrait section', 'one column of its own width, the landscape text\'s', '<w:cols w:num="1" w:space="720" w:equalWidth="0"><w:col w:w="12960"/></w:cols>', 'Intro.\n\n<!-- portrait -->\n\n' + wideFigure + '\n\n<!-- /portrait -->\n\nEnd.\n', 624],
  ])('fits an oversized image in %s, under a landscape template of %s, to the page that section has', async (_, __, cols, md, width) => {
    // The last section keeps the template's page, on its side, but an image
    // took the width of an upright page's text
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const JSZip = (await import('jszip')).default;
    const fs = require('fs');
    const path = require('path');

    const template = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
    const xml = await template.file('word/document.xml')!.async('string');
    template.file('word/document.xml', xml.replace(/<w:pgSz\b[^>]*\/>/, '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
      .replace(/<w:cols\b[^>]*\/>/, match => cols || match));
    const templateDocx = await template.generateAsync({ type: 'uint8array' });
    const { dir, cleanup } = setupTempImage();
    try {
      const { docx } = await convertMdToDocx(md, { sourceDir: dir, templateDocx });
      const documentXml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      // Landscape Letter with 1-inch margins has 864 px of writable width,
      // or 408 for each of two columns 720 twips apart, and Letter upright 624.
      // 1 px = 9525 EMU
      expect(documentXml).toContain('<wp:extent cx="' + width * 9525 + '" cy="' + width / 2 * 9525 + '"/>');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('{width=' + width + ' height=' + width / 2 + '}');
      for (const [name, bytes] of result.images ?? []) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
      }
      const again = await convertMdToDocx(result.markdown, { sourceDir: dir, templateDocx });
      expect((await convertDocx(again.docx)).markdown).toBe(result.markdown);
    } finally {
      cleanup();
    }
  });

  it.each([
    ['one column', '<w:cols w:space="720"/>', 528],
    ['two columns 720 twips apart', '<w:cols w:num="2" w:space="720"/>', 240],
    // Which add up to 9900 twips with the space between, scaled to fit
    ['columns of their own widths, 6000 and 3000 twips, 900 apart, that it scales down', '<w:cols w:num="2" w:space="720" w:equalWidth="0"><w:col w:w="6000" w:space="900"/><w:col w:w="3000"/></w:cols>', 160],
  ])('fits an oversized image to the narrowest column of the text a template\'s binding gutter leaves, in %s', async (_, cols, width) => {
    // The text's width took no account of the gutter, so an image ran
    // into it, and columns of their own widths were scaled to fit the
    // text and the gutter both
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const JSZip = (await import('jszip')).default;
    const fs = require('fs');
    const path = require('path');

    const template = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
    const xml = await template.file('word/document.xml')!.async('string');
    template.file('word/document.xml', xml.replace(/<w:cols\b[^>]*\/>/, () => cols).replace(/w:gutter="0"/, 'w:gutter="1440"'));
    const templateDocx = await template.generateAsync({ type: 'uint8array' });
    const { dir, cleanup } = setupTempImage();
    try {
      const { docx } = await convertMdToDocx(wideFigure + '\n', { sourceDir: dir, templateDocx });
      const documentXml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(documentXml).toContain('w:gutter="1440"');
      // Letter's text, with one-inch margins and an inch of gutter, is 528
      // px wide, 7920 twips. 1 px = 9525 EMU
      expect(documentXml).toContain('<wp:extent cx="' + width * 9525 + '" cy="' + width / 2 * 9525 + '"/>');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('{width=' + width + ' height=' + width / 2 + '}');
      for (const [name, bytes] of result.images ?? []) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
      }
      const again = await convertMdToDocx(result.markdown, { sourceDir: dir, templateDocx });
      expect((await convertDocx(again.docx)).markdown).toBe(result.markdown);
    } finally {
      cleanup();
    }
  });

  const twoColumns = '<w:cols w:num="2" w:space="720"/>';
  it.each([
    ['a footnote', 'a template of two columns', 'one column of their own', false, twoColumns, '<w15:footnoteColumns w:val="1"/>', '', 'A[^1].\n\n', 624],
    ['a footnote', 'a template of two columns', 'none of their own', false, twoColumns, '', '', 'A[^1].\n\n', 288],
    // Word lays endnotes out in the section's columns
    ['an endnote', 'a template of two columns', 'one column of their own', false, twoColumns, '<w15:footnoteColumns w:val="1"/>', '---\nnotes: endnotes\n---\n', 'A[^1].\n\n', 288],
    // Whose columns are one, 720 twips apart, as they're too far apart for
    // its upright page
    ['a footnote in a portrait section', 'a landscape template of two columns 9600 twips apart', 'two columns of their own', true, '<w:cols w:num="2" w:space="9600"/>', '<w15:footnoteColumns w:val="2"/>', '',
      'Intro.\n\n<!-- portrait -->\n\nA[^1].\n\n<!-- /portrait -->\n\nEnd.\n\n', 288],
  ])('fits an oversized image in %s, under %s whose footnotes have %s, to the width the note has', async (_, __, ___, landscape, cols, footnoteColumns, front, body, width) => {
    // A footnote's image took the section's columns' width, where Word
    // lays footnotes out in one column of their own, the text's; and two
    // of them took the template's columns' space, not that of the columns
    // the section has, so they took the whole text, 624 px, where each is
    // 288
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const JSZip = (await import('jszip')).default;
    const fs = require('fs');
    const path = require('path');

    const template = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
    const xml = await template.file('word/document.xml')!.async('string');
    template.file('word/document.xml', xml.replace(/<w:cols\b[^>]*\/>/, () => cols)
      .replace(/<w:pgSz\b[^>]*\/>/, page => landscape ? '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' : page)
      .replace(/<\/w:sectPr>(?![\s\S]*<\/w:sectPr>)/, end => footnoteColumns + end));
    const templateDocx = await template.generateAsync({ type: 'uint8array' });
    const md = front + body + '[^1]: ' + wideFigure + '\n';
    const { dir, cleanup } = setupTempImage();
    try {
      const { docx } = await convertMdToDocx(md, { sourceDir: dir, templateDocx });
      const notesXml = await (await JSZip.loadAsync(docx)).file(front ? 'word/endnotes.xml' : 'word/footnotes.xml')!.async('string');
      // Letter's text is 624 px wide, or 288 for each of two columns 720
      // twips apart. 1 px = 9525 EMU
      expect(notesXml).toContain('<wp:extent cx="' + width * 9525 + '" cy="' + width / 2 * 9525 + '"/>');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('{width=' + width + ' height=' + width / 2 + '}');
      for (const [name, bytes] of result.images ?? []) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
      }
      const again = await convertMdToDocx(result.markdown, { sourceDir: dir, templateDocx });
      expect((await convertDocx(again.docx)).markdown).toBe(result.markdown);
    } finally {
      cleanup();
    }
  });

  const fenceAfter = '\n\n<!-- landscape -->\n\nW.\n\n<!-- /landscape -->\n\nEnd.\n\n';
  it.each([
    ['a footnote', 'a section before a fence', true, 'A[^1].' + fenceAfter, 624],
    ['a footnote', 'the last section', true, 'A.\n\n<!-- landscape -->\n\nW.\n\n<!-- /landscape -->\n\nEnd[^1].\n\n', 864],
    ['a footnote', 'a landscape section, without a template,', false, 'A.\n\n<!-- landscape -->\n\nW[^1].\n\n<!-- /landscape -->\n\nEnd.\n\n', 864],
    ['a footnote', 'a section before a fence, without a template,', false, 'A[^1].' + fenceAfter, 624],
    // Word puts endnotes at the document's end, in the last section
    ['an endnote', 'a section before a fence', true, '---\nnotes: endnotes\n---\nA[^1].' + fenceAfter, 864],
  ])('fits an oversized image in %s whose reference is in %s to the page the note is on', async (_, __, landscapeTemplate, md, width) => {
    // A note took the orientation of the section export wrote last, so a
    // footnote on an upright page ran over it under a landscape template,
    // and one on a landscape page took an upright page's width
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const JSZip = (await import('jszip')).default;
    const fs = require('fs');
    const path = require('path');

    const template = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
    const xml = await template.file('word/document.xml')!.async('string');
    template.file('word/document.xml', xml.replace(/<w:pgSz\b[^>]*\/>/, '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>'));
    const options = landscapeTemplate ? { templateDocx: await template.generateAsync({ type: 'uint8array' }) } : {};
    const { dir, cleanup } = setupTempImage();
    try {
      const { docx } = await convertMdToDocx(md + '[^1]: ' + wideFigure + '\n', { sourceDir: dir, ...options });
      const zip = await JSZip.loadAsync(docx);
      const notesXml = await zip.file(md.includes('endnotes') ? 'word/endnotes.xml' : 'word/footnotes.xml')!.async('string');
      // 1 px = 9525 EMU
      expect(notesXml).toContain('<wp:extent cx="' + width * 9525 + '" cy="' + width / 2 * 9525 + '"/>');
      const result = await convertDocx(docx);
      expect(result.markdown).toContain('{width=' + width + ' height=' + width / 2 + '}');
      for (const [name, bytes] of result.images ?? []) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
      }
      const again = await convertMdToDocx(result.markdown, { sourceDir: dir, ...options });
      expect((await convertDocx(again.docx)).markdown).toBe(result.markdown);
    } finally {
      cleanup();
    }
  });

  it('fits an oversized image in an endnote to the last section\'s page where the template puts endnotes at each section\'s end, as the export doesn\'t', async () => {
    // Export writes settings of its own, without the template's endnote
    // position, and a section's own, which its breaks take, is ignored
    // (ECMA-376 Part 1 §17.11.22), so its endnotes are at the document's end
    const { convertMdToDocx } = await import('./md-to-docx');
    const JSZip = (await import('jszip')).default;
    const template = await JSZip.loadAsync((await convertMdToDocx('x')).docx);
    const xml = await template.file('word/document.xml')!.async('string');
    template.file('word/document.xml', xml.replace(/<w:pgSz\b[^>]*\/>/, '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
      .replace(/(<w:sectPr\b[^>]*>)(?![\s\S]*<w:sectPr\b)/, open => open + '<w:endnotePr><w:pos w:val="sectEnd"/></w:endnotePr>'));
    const settings = await template.file('word/settings.xml')!.async('string');
    template.file('word/settings.xml', settings.replace('</w:settings>', '<w:endnotePr><w:pos w:val="sectEnd"/></w:endnotePr></w:settings>'));
    const templateDocx = await template.generateAsync({ type: 'uint8array' });
    const { dir, cleanup } = setupTempImage();
    try {
      const { docx } = await convertMdToDocx('---\nnotes: endnotes\n---\nA[^1].' + fenceAfter + '[^1]: ' + wideFigure + '\n', { sourceDir: dir, templateDocx });
      const zip = await JSZip.loadAsync(docx);
      expect(await zip.file('word/settings.xml')!.async('string')).not.toContain('<w:pos ');
      // 1 px = 9525 EMU
      expect(await zip.file('word/endnotes.xml')!.async('string')).toContain('<wp:extent cx="' + 864 * 9525 + '" cy="' + 432 * 9525 + '"/>');
    } finally {
      cleanup();
    }
  });

  // Feature: image-roundtrip, Property 3: Alt text roundtrip
  it('P3: alt text survives MD→DOCX→MD roundtrip', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');
    const arbAlt = fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/).filter(s => !s.includes(']') && s.length > 0);

    await fc.assert(
      fc.asyncProperty(arbAlt, async (alt) => {
        const { dir, cleanup } = setupTempImage();
        try {
          const md = '![' + alt + '](test.png){width=100 height=100}';
          const { docx } = await convertMdToDocx(md, { sourceDir: dir });
          const result = await convertDocx(docx);
          const imgMatch = result.markdown.match(/!\[([^\]]*)\]/);
          expect(imgMatch).not.toBeNull();
          if (imgMatch) {
            expect(imgMatch[1]).toBe(alt);
          }
        } finally {
          cleanup();
        }
      }),
      { numRuns: 20 }
    );
  });

  // Feature: image-roundtrip, Property 4: Syntax format roundtrip
  it('P4: image syntax format (md vs html) survives MD→DOCX→MD roundtrip', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const { convertDocx } = await import('./converter');

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('md', 'html'),
        async (syntax) => {
          const { dir, cleanup } = setupTempImage();
          try {
            const md = syntax === 'html'
              ? '<img src="test.png" alt="pic" width="100" height="100">'
              : '![pic](test.png){width=100 height=100}';
            const { docx } = await convertMdToDocx(md, { sourceDir: dir });
            const result = await convertDocx(docx);
            if (syntax === 'html') {
              expect(result.markdown).toContain('<img ');
            } else {
              expect(result.markdown).toContain('![');
            }
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  // Feature: image-roundtrip, Property 7: DOCX image structure validity
  it('P7: exported DOCX contains image binary, relationship, content type, and w:drawing', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const md = '![alt](test.png){width=200 height=150}';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });
      const zip = await JSZip.loadAsync(docx);

      // Check image binary exists in word/media/
      const mediaFiles = Object.keys(zip.files).filter(f => f.startsWith('word/media/'));
      expect(mediaFiles.length).toBeGreaterThan(0);

      // Check relationship entry
      const relsContent = await zip.file('word/_rels/document.xml.rels')!.async('string');
      expect(relsContent).toContain('/image');
      expect(relsContent).toContain('media/');

      // Check content type entry
      const ctContent = await zip.file('[Content_Types].xml')!.async('string');
      expect(ctContent).toContain('Extension="png"');
      expect(ctContent).toContain('image/png');

      // Check w:drawing in document.xml
      const docContent = await zip.file('word/document.xml')!.async('string');
      expect(docContent).toContain('w:drawing');
      expect(docContent).toContain('wp:inline');
      expect(docContent).toContain('a:blip');
    } finally {
      cleanup();
    }
  });

  // Feature: image-roundtrip, Property 8: Image deduplication
  it('P8: multiple references to same image produce one media entry and one relationship', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const md = '![first](test.png){width=100 height=100}\n\n![second](test.png){width=200 height=200}';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });
      const zip = await JSZip.loadAsync(docx);

      // Only one media file
      const mediaFiles = Object.keys(zip.files).filter(f => f.startsWith('word/media/') && !f.endsWith('/'));
      expect(mediaFiles.length).toBe(1);

      // Only one image relationship
      const relsContent = await zip.file('word/_rels/document.xml.rels')!.async('string');
      const imageRelMatches = relsContent.match(/relationships\/image/g);
      expect(imageRelMatches?.length).toBe(1);

      // But two w:drawing elements
      const docContent = await zip.file('word/document.xml')!.async('string');
      const drawingMatches = docContent.match(/w:drawing/g);
      expect(drawingMatches!.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  // Feature: image-roundtrip, Property 12: Footnote HTML image format stored in separate custom property
  it('P12: <img> in footnote body writes MANUSCRIPT_NOTE_IMAGE_FORMATS_ custom property', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const { extractNoteImageFormatMapping } = await import('./converter');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const md = 'Some text[^1]\n\n[^1]: <img src="test.png" alt="note pic" width="100" height="100">';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });

      // Verify MANUSCRIPT_NOTE_IMAGE_FORMATS_ custom property exists
      const zip = await JSZip.loadAsync(docx);
      const noteMapping = await extractNoteImageFormatMapping(zip);
      expect(noteMapping).not.toBeNull();
      expect(noteMapping!.size).toBeGreaterThan(0);
      // All entries should be 'html' since we used <img> syntax
      for (const [, syntax] of noteMapping!) {
        expect(syntax).toBe('html');
      }
    } finally {
      cleanup();
    }
  });

  // Feature: image-roundtrip, Property 13: Mixed document + footnote image formats stay separate
  it('P13: document-body md image + footnote html image use separate format maps', async () => {
    const { convertMdToDocx } = await import('./md-to-docx');
    const { extractImageFormatMapping, extractNoteImageFormatMapping } = await import('./converter');
    const JSZip = (await import('jszip')).default;

    const { dir, cleanup } = setupTempImage();
    try {
      const md = '![body pic](test.png){width=100 height=100}\n\nText[^1]\n\n[^1]: <img src="test.png" alt="note pic" width="100" height="100">';
      const { docx } = await convertMdToDocx(md, { sourceDir: dir });

      const zip = await JSZip.loadAsync(docx);
      const docMapping = await extractImageFormatMapping(zip);
      const noteMapping = await extractNoteImageFormatMapping(zip);

      // Document body should have 'md' entry, not 'html'
      expect(docMapping).not.toBeNull();
      expect([...docMapping!.values()]).toContain('md');
      expect([...docMapping!.values()]).not.toContain('html');

      // Note body should have 'html' entry, not 'md'
      expect(noteMapping).not.toBeNull();
      expect([...noteMapping!.values()]).toContain('html');
      expect([...noteMapping!.values()]).not.toContain('md');

      // rId keys should not overlap between the two maps
      const docRIds = new Set(docMapping!.keys());
      for (const noteRId of noteMapping!.keys()) {
        expect(docRIds.has(noteRId)).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  describe('An image\'s alt text in Word', () => {
    const xmlAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/[\t\n\r]/g, c => '&#' + c.charCodeAt(0) + ';');
    const fromXmlAttr = (text: string) => text.replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(+code)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const body = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '');

    /** The Markdown import writes for an image whose alt text Word has as
     *  `alt`, the alt text export gives it back, and the Markdown of that */
    async function altRoundTrip(alt: string) {
      const { convertMdToDocx } = await import('./md-to-docx');
      const { convertDocx } = await import('./converter');
      const JSZip = (await import('jszip')).default;
      const { dir, cleanup } = setupTempImage();
      try {
        const { docx } = await convertMdToDocx('![x](test.png){width=100 height=100}', { sourceDir: dir });
        const zip = await JSZip.loadAsync(docx);
        const xml = await zip.file('word/document.xml')!.async('string');
        zip.file('word/document.xml', xml.replace(/descr="[^"]*"/, 'descr="' + xmlAttr(alt) + '"'));
        const first = body((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
        const second = await convertMdToDocx(first, { sourceDir: dir });
        const exported = await (await JSZip.loadAsync(second.docx)).file('word/document.xml')!.async('string');
        const descr = /descr="([^"]*)"/.exec(exported)?.[1];
        return { first, alt: descr === undefined ? undefined : fromXmlAttr(descr), again: body((await convertDocx(second.docx)).markdown) };
      } finally {
        cleanup();
      }
    }

    it.each([
      'a [b] c', 'a [ b', 'a ] b', '[a](b)', '[x]{.mark}', '[@smith2020]', 'a [^1]',
      '*b*', '_b_', '`x`', '~~s~~', '==h==', '{==a==}', '{++a++}', '{>>c<<}',
      'a &amp; b', 'x $y$ z', '$x$', '<https://e.com>', 'a\\*b', 'line1\nline2',
      '<b>x</b>', '<b title="*">x</b>', '<span class="_x_">y</span>', 'a <!-- c --> b', 'a\\<b',
      'a\\\nb', 'a\\\\\nb', 'a\\\r\nb', '$a\nb$',
    ])('keeps alt text %j as Word has it', async (alt) => {
      const result = await altRoundTrip(alt);
      expect(result.alt).toBe(alt);
      expect(result.again).toBe(result.first);
    });

    /** The descr export writes for an image's Markdown */
    async function exportedDescr(markdown: string) {
      const { convertMdToDocx } = await import('./md-to-docx');
      const JSZip = (await import('jszip')).default;
      const { dir, cleanup } = setupTempImage();
      try {
        const { docx } = await convertMdToDocx(markdown, { sourceDir: dir });
        const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
        return /descr="([^"]*)"/.exec(xml)?.[1];
      } finally {
        cleanup();
      }
    }

    it.each([
      ['a soft break as a space, as in a paragraph', '![A chart of sales by\nregion](test.png)', 'A chart of sales by region'],
      ['a hard break as a line break', '![a\\\nb](test.png)', 'a&#xA;b'],
      ['a line break and tab the Markdown writes as references, as references', '![a&#10;b&#9;c](test.png)', 'a&#xA;b&#x9;c'],
      ['a line break in an <img> tag\'s alt text as a reference', '<img src="test.png" alt="a&#10;b">', 'a&#xA;b'],
    ])('gives Word %s', async (_name, markdown, descr) => {
      expect(await exportedDescr(markdown)).toBe(descr);
    });

    it('reads back alt text whose lines the Markdown wraps as one line', async () => {
      const { convertMdToDocx } = await import('./md-to-docx');
      const { convertDocx } = await import('./converter');
      const { dir, cleanup } = setupTempImage();
      try {
        const first = body((await convertDocx((await convertMdToDocx('![A chart of sales by\nregion](test.png)', { sourceDir: dir })).docx)).markdown);
        expect(first).toBe('![A chart of sales by region](test.png){width=1 height=1}\n');
        expect(body((await convertDocx((await convertMdToDocx(first, { sourceDir: dir })).docx)).markdown)).toBe(first);
      } finally {
        cleanup();
      }
    });

    it.each([
      'Figure 1: sales (2020).', 'snake_case', 'A & B', '$5 and $6', 'a = b', '# not a heading', 'a\\b', 'a > b',
    ])('writes alt text %j that reads as it is with no escapes', async (alt) => {
      const result = await altRoundTrip(alt);
      expect(result.first).toBe('![' + alt + '](test.png){width=100 height=100}\n');
      expect(result.alt).toBe(alt);
    });
  });
});
