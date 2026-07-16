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
});
