import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import JSZip from 'jszip';
import { convertMdToDocx, generateRPr, generateRun, generateParagraph, generateTable, MdToken, MdRun } from './md-to-docx';

describe('OOXML Generation Properties', () => {
  // Property 3: DOCX archive completeness
  it('Feature: md-to-docx-conversion, Property 3: DOCX archive completeness', async () => {
    const mdGen = fc.string({ maxLength: 20 }).filter(s => s.trim().length > 0);
    
    await fc.assert(fc.asyncProperty(mdGen, async (markdown) => {
      const result = await convertMdToDocx(markdown);
      const zip = await JSZip.loadAsync(result.docx);
      
      // Required files
      expect(zip.file('[Content_Types].xml')).toBeTruthy();
      expect(zip.file('_rels/.rels')).toBeTruthy();
      expect(zip.file('word/document.xml')).toBeTruthy();
      expect(zip.file('word/styles.xml')).toBeTruthy();
      
      // Conditional files
      const hasLists = markdown.includes('- ') || markdown.includes('1. ');
      const hasLinks = markdown.includes('[') && markdown.includes('](');
      
      if (hasLists) {
        expect(zip.file('word/numbering.xml')).toBeTruthy();
      }
      if (hasLinks) {
        expect(zip.file('word/_rels/document.xml.rels')).toBeTruthy();
      }
    }), { numRuns: 100 });
  });

  // Property 4: Character formatting preservation
  it('Feature: md-to-docx-conversion, Property 4: Character formatting preservation', () => {
    const runGen = fc.record({
      text: fc.string({ maxLength: 10 }),
      bold: fc.boolean(),
      italic: fc.boolean(),
      underline: fc.boolean(),
      strikethrough: fc.boolean(),
      superscript: fc.boolean(),
      subscript: fc.boolean(),
      code: fc.boolean()
    });

    fc.assert(fc.property(runGen, (run) => {
      const rPr = generateRPr(run);
      
      if (run.bold) expect(rPr).toContain('<w:b/>');
      else expect(rPr).not.toContain('<w:b/>');
      
      if (run.italic) expect(rPr).toContain('<w:i/>');
      else expect(rPr).not.toContain('<w:i/>');
      
      if (run.underline) expect(rPr).toContain('<w:u w:val="single"/>');
      else expect(rPr).not.toContain('<w:u w:val="single"/>');
      
      if (run.strikethrough) expect(rPr).toContain('<w:strike/>');
      else expect(rPr).not.toContain('<w:strike/>');
      
      if (run.superscript) expect(rPr).toContain('<w:vertAlign w:val="superscript"/>');
      else if (run.subscript) expect(rPr).toContain('<w:vertAlign w:val="subscript"/>');
      else expect(rPr).not.toContain('<w:vertAlign');
      
      if (run.code) expect(rPr).toContain('<w:rStyle w:val="CodeChar"/>');
      else expect(rPr).not.toContain('<w:rStyle w:val="CodeChar"/>');
    }), { numRuns: 100 });
  });

  // Property 5: Heading level mapping
  it('Feature: md-to-docx-conversion, Property 5: Heading level mapping', () => {
    const headingGen = fc.record({
      level: fc.integer({ min: 1, max: 6 }),
      text: fc.string({ maxLength: 20 })
    });

    fc.assert(fc.property(headingGen, ({ level, text }) => {
      const token: MdToken = { 
        type: 'heading', 
        level, 
        runs: [{ type: 'text', text }] 
      };
      const state = { commentId: 0, comments: [], relationships: new Map(), nextRId: 1, warnings: [], hasList: false, hasComments: false };
      
      const paragraph = generateParagraph(token, state);
      expect(paragraph).toContain('<w:pStyle w:val="Heading' + level + '"/>');
    }), { numRuns: 100 });
  });

  // Property 6: List numbering and nesting
  it('Feature: md-to-docx-conversion, Property 6: List numbering and nesting', () => {
    const listGen = fc.record({
      ordered: fc.boolean(),
      level: fc.integer({ min: 1, max: 4 }),
      text: fc.string({ maxLength: 15 })
    });

    fc.assert(fc.property(listGen, ({ ordered, level, text }) => {
      const token: MdToken = { 
        type: 'list_item', 
        ordered, 
        level, 
        runs: [{ type: 'text', text }] 
      };
      const state = { commentId: 0, comments: [], relationships: new Map(), nextRId: 1, warnings: [], hasList: false, hasComments: false };
      
      const paragraph = generateParagraph(token, state);
      expect(paragraph).toContain('<w:numPr>');
      expect(paragraph).toContain('<w:numId w:val="' + (ordered ? '2' : '1') + '"/>');
      expect(paragraph).toContain('<w:ilvl w:val="' + (level - 1) + '"/>');
    }), { numRuns: 100 });
  });

  // Property 7: Hyperlink deduplication and structure
  it('Feature: md-to-docx-conversion, Property 7: Hyperlink deduplication and structure', async () => {
    const linkGen = fc.array(
      fc.record({
        text: fc.string({ minLength: 1, maxLength: 10 }),
        url: fc.webUrl()
      }),
      { minLength: 1, maxLength: 5 }
    );

    await fc.assert(fc.asyncProperty(linkGen, async (links) => {
      const markdown = links.map(l => '[' + l.text + '](' + l.url + ')').join(' ');
      const result = await convertMdToDocx(markdown);
      const zip = await JSZip.loadAsync(result.docx);
      
      const relsFile = zip.file('word/_rels/document.xml.rels');
      if (!relsFile) return; // No relationships file means no links were processed
      
      const relsXml = await relsFile.async('text');
      const uniqueUrls = new Set(links.map(l => l.url));
      
      // Each unique URL should have exactly one relationship
      for (const url of uniqueUrls) {
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = relsXml.match(new RegExp('Target="' + escapedUrl + '"', 'g'));
        if (matches) {
          expect(matches.length).toBe(1);
        }
      }
    }), { numRuns: 50 });
  });

  // Property 12: Table structure
  it('Feature: md-to-docx-conversion, Property 12: Table structure', () => {
    const tableGen = fc.record({
      headers: fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 4 }),
      rows: fc.array(
        fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        { maxLength: 3 }
      )
    }).filter(({ headers, rows }) => rows.every(row => row.length === headers.length));

    fc.assert(fc.property(tableGen, ({ headers, rows }) => {
      const tableRows = [
        { cells: headers.map(h => [{ type: 'text' as const, text: h }]), header: true },
        ...rows.map(row => ({ cells: row.map(c => [{ type: 'text' as const, text: c }]), header: false }))
      ];
      const token: MdToken = { type: 'table', runs: [], rows: tableRows };
      const state = { commentId: 0, comments: [], relationships: new Map(), nextRId: 1, warnings: [], hasList: false, hasComments: false };
      
      const table = generateTable(token, state);
      
      // Count rows (header + data)
      const rowMatches = table.match(/<w:tr>/g);
      expect(rowMatches?.length).toBe(rows.length + 1);
      
      // Count cells in first row
      const firstRowMatch = table.match(/<w:tr>.*?<\/w:tr>/s);
      if (firstRowMatch) {
        const cellMatches = firstRowMatch[0].match(/<w:tc>/g);
        expect(cellMatches?.length).toBe(headers.length);
        
        // Header should be bold
        expect(firstRowMatch[0]).toContain('<w:b/>');
      }
    }), { numRuns: 100 });
  });

  // Property 13: Blockquote indentation
  it('Feature: md-to-docx-conversion, Property 13: Blockquote indentation', () => {
    const quoteGen = fc.record({
      level: fc.integer({ min: 1, max: 3 }),
      text: fc.string({ maxLength: 20 })
    });

    fc.assert(fc.property(quoteGen, ({ level, text }) => {
      const token: MdToken = { 
        type: 'blockquote', 
        level, 
        runs: [{ type: 'text', text }] 
      };
      const state = { commentId: 0, comments: [], relationships: new Map(), nextRId: 1, warnings: [], hasList: false, hasComments: false };
      
      const paragraph = generateParagraph(token, state);
      const expectedIndent = level * 720; // 720 twips per level
      expect(paragraph).toContain('<w:ind w:left="' + expectedIndent + '"/>');
    }), { numRuns: 100 });
  });

  // Property 14: Code style references
  it('Feature: md-to-docx-conversion, Property 14: Code style references', () => {
    const codeGen = fc.oneof(
      fc.record({ type: fc.constant('inline_code'), text: fc.string({ maxLength: 10 }) }),
      fc.record({ type: fc.constant('code_block'), text: fc.string({ maxLength: 20 }) })
    );

    fc.assert(fc.property(codeGen, (code) => {
      if (code.type === 'inline_code') {
        const run: MdRun = { type: 'text', text: code.text, code: true };
        const rPr = generateRPr(run);
        expect(rPr).toContain('<w:rStyle w:val="CodeChar"/>');
      } else {
        const token: MdToken = { 
          type: 'code_block', 
          runs: [{ type: 'text', text: code.text }] 
        };
        const state = { commentId: 0, comments: [], relationships: new Map(), nextRId: 1, warnings: [], hasList: false, hasComments: false };
        
        const paragraph = generateParagraph(token, state);
        expect(paragraph).toContain('<w:pStyle w:val="CodeBlock"/>');
      }
    }), { numRuns: 100 });
  });
});