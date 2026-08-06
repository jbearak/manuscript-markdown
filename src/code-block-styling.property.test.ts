import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from './frontmatter';
import { stylesXml, type CodeBlockConfig, generateParagraph, type DocxGenState, type MdToken, CODE_BLOCK_MARGIN_INDENT } from './md-to-docx';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

describe('Code Block Styling Property Tests', () => {
  const hexColorArb = fc.array(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'), { minLength: 6, maxLength: 6 }).map(arr => arr.join(''));
  const codeBackgroundColorArb = fc.oneof(hexColorArb, fc.constant('none'), fc.constant('transparent'));
  const positiveIntArb = fc.integer({ min: 1, max: 200 });

  function extractStyleBlock(xml: string, styleId: string): string | null {
    let searchFrom = 0;
    while (true) {
      const idx = xml.indexOf('<w:style ', searchFrom);
      if (idx === -1) return null;
      const closeTag = xml.indexOf('</w:style>', idx);
      if (closeTag === -1) return null;
      const block = xml.substring(idx, closeTag + '</w:style>'.length);
      if (block.includes('w:styleId="' + styleId + '"')) return block;
      searchFrom = closeTag + '</w:style>'.length;
    }
  }

  it('Property 4: Frontmatter round-trip preservation', () => {
    fc.assert(fc.property(
      codeBackgroundColorArb,
      hexColorArb,
      positiveIntArb,
      (codeBackgroundColor, codeFontColor, codeBlockInset) => {
        const original: Frontmatter = {
          codeBackgroundColor,
          codeFontColor,
          codeBlockInset
        };

        const serialized = serializeFrontmatter(original);
        const { metadata: parsed } = parseFrontmatter(serialized + '\nsome body text');

        expect(parsed.codeBackgroundColor).toBe(original.codeBackgroundColor);
        expect(parsed.codeFontColor).toBe(original.codeFontColor);
        expect(parsed.codeBlockInset).toBe(original.codeBlockInset);
      }
    ), { numRuns: 100 });
  });

  it('Property 5: Invalid frontmatter values are ignored', () => {
    const invalidBackgroundArb = fc.string({ minLength: 1, maxLength: 10 })
      .filter(s => { const t = s.trim().replace(/^["']|["']$/g, ''); return !/^[0-9A-Fa-f]{6}$/.test(t) && t !== 'none' && t !== 'transparent' && !s.includes(':') && !s.includes('\n'); });
    const invalidColorArb = fc.string({ minLength: 1, maxLength: 10 })
      .filter(s => { const t = s.trim().replace(/^["']|["']$/g, ''); return !/^[0-9A-Fa-f]{6}$/.test(t) && !s.includes(':') && !s.includes('\n'); });
    const invalidInsetArb = fc.oneof(
      fc.integer({ max: 0 }).map(String),
      fc.string({ minLength: 1, maxLength: 10 }).filter(s => {
        const t = s.trim().replace(/^["']|["']$/g, '');
        const n = parseInt(t, 10);
        const isValidPositiveInt = Number.isInteger(n) && n > 0 && t === String(n);
        return !isValidPositiveInt && !s.includes(':') && !s.includes('\n');
      })
    );

    fc.assert(fc.property(
      invalidBackgroundArb,
      invalidColorArb,
      invalidInsetArb,
      (invalidBackground, invalidColor, invalidInset) => {
        const yaml = `---\ncode-background-color: ${invalidBackground}\ncode-font-color: ${invalidColor}\ncode-block-inset: ${invalidInset}\n---\n`;
        const { metadata } = parseFrontmatter(yaml);

        expect(metadata.codeBackgroundColor).toBeUndefined();
        expect(metadata.codeFontColor).toBeUndefined();
        expect(metadata.codeBlockInset).toBeUndefined();
      }
    ), { numRuns: 100 });
  });

  it('Property 11: Alias round-trip normalization', () => {
    fc.assert(fc.property(
      hexColorArb,
      hexColorArb,
      (backgroundHex, colorHex) => {
        const yaml = `---\ncode-background: ${backgroundHex}\ncode-color: ${colorHex}\n---\n`;
        const { metadata } = parseFrontmatter(yaml);
        const serialized = serializeFrontmatter(metadata);

        expect(serialized).toContain('code-background-color:');
        expect(serialized).toContain('code-font-color:');
        expect(serialized).not.toMatch(/code-background:\s/);
        expect(serialized).not.toMatch(/code-color:\s/);
      }
    ), { numRuns: 100 });
  });

  it('Property 1: Shading mode style structure', () => {
    fc.assert(fc.property(
      hexColorArb,
      positiveIntArb,
      (color, inset) => {
        const xml = stylesXml(undefined, { background: color, insetMode: false, codeBlockInset: inset });
        const codeBlock = extractStyleBlock(xml, 'CodeBlock');
        
        expect(codeBlock).not.toBeNull();
        expect(codeBlock!).toContain('w:shd');
        expect(codeBlock!).toContain('w:fill="' + color + '"');
        expect(codeBlock!).toContain('w:pBdr');
        expect(codeBlock!).toContain('w:color="' + color + '"');
        expect(codeBlock!).toContain('w:sz="' + inset + '"');
        expect(codeBlock!).toContain('w:ind w:left="' + CODE_BLOCK_MARGIN_INDENT + '" w:right="' + CODE_BLOCK_MARGIN_INDENT + '"');
      }
    ), { numRuns: 100 });
  });

  it('Property 2: Spacing invariant across modes', () => {
    fc.assert(fc.property(
      fc.boolean(),
      (insetMode) => {
        const config: CodeBlockConfig = { insetMode };
        const xml = stylesXml(undefined, config);
        const codeBlock = extractStyleBlock(xml, 'CodeBlock');
        
        expect(codeBlock).not.toBeNull();
        expect(codeBlock!).toContain('w:spacing w:after="0" w:line="240" w:lineRule="auto"');
      }
    ), { numRuns: 100 });
  });

  it('Property 3: Code font color in style run properties', () => {
    fc.assert(fc.property(
      hexColorArb,
      (color) => {
        const xml = stylesXml(undefined, { insetMode: false, codeFontColor: color });
        const codeBlock = extractStyleBlock(xml, 'CodeBlock');
        const codeChar = extractStyleBlock(xml, 'CodeChar');
        
        expect(codeBlock).not.toBeNull();
        expect(codeChar).not.toBeNull();
        expect(codeBlock!).toContain('w:color w:val="' + color + '"');
        expect(codeChar!).toContain('w:color w:val="' + color + '"');
      }
    ), { numRuns: 100 });
  });

  it('Property 8: Inline code shading in shading mode', () => {
    fc.assert(fc.property(
      hexColorArb,
      (color) => {
        const xml = stylesXml(undefined, { background: color, insetMode: false });
        const codeChar = extractStyleBlock(xml, 'CodeChar');
        
        expect(codeChar).not.toBeNull();
        expect(codeChar!).toContain('w:shd');
        expect(codeChar!).toContain('w:fill="' + color + '"');
        expect(codeChar!).toContain('w:type="character"');
        expect(codeChar!).not.toContain('w:pPr');
      }
    ), { numRuns: 100 });
  });

  it('Property 9: Inline code has no shading in inset mode', () => {
    fc.assert(fc.property(
      fc.constant(true),
      () => {
        const xml = stylesXml(undefined, { insetMode: true });
        const codeChar = extractStyleBlock(xml, 'CodeChar');
        
        expect(codeChar).not.toBeNull();
        expect(codeChar!).not.toContain('w:shd');
      }
    ), { numRuns: 100 });
  });

  it('Property 10: code-block-inset does not affect inline code', () => {
    fc.assert(fc.property(
      positiveIntArb,
      positiveIntArb,
      hexColorArb,
      (inset1, inset2, color) => {
        fc.pre(inset1 !== inset2);
        
        const xml1 = stylesXml(undefined, { background: color, insetMode: false, codeBlockInset: inset1 });
        const xml2 = stylesXml(undefined, { background: color, insetMode: false, codeBlockInset: inset2 });
        const codeChar1 = extractStyleBlock(xml1, 'CodeChar');
        const codeChar2 = extractStyleBlock(xml2, 'CodeChar');
        
        expect(codeChar1).not.toBeNull();
        expect(codeChar2).not.toBeNull();
        expect(codeChar1).toBe(codeChar2);
      }
    ), { numRuns: 100 });
  });

describe('Code Block Styling Round-Trip Tests', () => {
  it('preserves code-background-color through round-trip', async () => {
    const md = '---\ncode-background-color: ADD8E6\n---\n\nHello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeBackgroundColor).toBe('ADD8E6');
  });

  it('preserves code-font-color through round-trip', async () => {
    const md = '---\ncode-font-color: FF0000\n---\n\nHello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeFontColor).toBe('FF0000');
  });

  it('preserves code-block-inset through round-trip', async () => {
    const md = '---\ncode-block-inset: 72\n---\n\nHello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeBlockInset).toBe(72);
  });

  it('does not emit code-background-color when absent', async () => {
    const md = 'Hello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeBackgroundColor).toBeUndefined();
  });

  it('does not emit code-font-color when absent', async () => {
    const md = 'Hello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeFontColor).toBeUndefined();
  });

  it('does not emit code-block-inset when absent', async () => {
    const md = 'Hello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeBlockInset).toBeUndefined();
  });

  it('preserves all three fields together', async () => {
    const md = '---\ncode-background-color: AABBCC\ncode-font-color: 112233\ncode-block-inset: 96\n---\n\nHello\n\n```\ncode\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeBackgroundColor).toBe('AABBCC');
    expect(metadata.codeFontColor).toBe('112233');
    expect(metadata.codeBlockInset).toBe(96);
  });

  it('preserves none value for code-background-color', async () => {
    const md = '---\ncode-background-color: none\n---\n\nHello\n\n```\ncode here\n```\n';
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.codeBackgroundColor).toBe('none');
  });
  });

  function makeState(codeShadingMode: boolean): DocxGenState {
    return {
      commentId: 0, comments: [], commentIdMap: new Map(),
      relationships: new Map(), nextRId: 1, rIdOffset: 3,
      warnings: [], hasList: false, listStartOverrides: [], hasComments: false,
      hasFootnotes: false, hasEndnotes: false, footnoteId: 1,
      footnoteEntries: [], footnoteLabelToId: new Map(),
      notesMode: 'footnotes', missingKeys: new Set(),
      citationIds: new Set(), citationItemIds: new Map(),
      replyRanges: [], nextParaId: 1, codeBlockIndex: 0,
      codeBlockLanguages: new Map(), citedKeys: new Set(), bibliographyKeys: [],
      codeFont: 'Consolas', codeShadingMode,
    };
  }

  it('Property 6: Uniform paragraph treatment in shading mode', () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 0, maxLength: 20 }).filter(s => !s.includes('\n')), { minLength: 1, maxLength: 10 }),
      (lines) => {
        const token: MdToken = { type: 'code_block' as const, runs: [{ type: 'text' as const, text: lines.join('\n') }] };
        const state = makeState(true);
        const result = generateParagraph(token, state);
        
        const paragraphs = result.split('</w:p>').filter(p => p.trim());
        for (const paragraph of paragraphs) {
          const pPrMatch = paragraph.match(/<w:pPr>(.*?)<\/w:pPr>/);
          expect(pPrMatch).not.toBeNull();
          expect(pPrMatch![1]).toBe('<w:pStyle w:val="CodeBlock"/>');
          expect(paragraph).not.toContain('w:spacing w:before');
          expect(paragraph).not.toContain('w:spacing w:after');
        }
      }
    ), { numRuns: 100 });
  });

  it('Property 7: Inset mode first/last paragraph spacing', () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 0, maxLength: 20 }).filter(s => !s.includes('\n')), { minLength: 2, maxLength: 10 }),
      (lines) => {
        const token: MdToken = { type: 'code_block' as const, runs: [{ type: 'text' as const, text: lines.join('\n') }] };
        const state = makeState(false);
        const result = generateParagraph(token, state);
        
        const paragraphs = result.split('</w:p>').filter(p => p.trim());
        expect(paragraphs[0]).toContain('w:before="160"');
        expect(paragraphs[paragraphs.length - 1]).toContain('w:after="160"');
        
        for (let i = 1; i < paragraphs.length - 1; i++) {
          const pPrMatch = paragraphs[i].match(/<w:pPr>(.*?)<\/w:pPr>/);
          expect(pPrMatch).not.toBeNull();
          expect(pPrMatch![1]).toBe('<w:pStyle w:val="CodeBlock"/>');
        }
      }
    ), { numRuns: 100 });
  });
});

