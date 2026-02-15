import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { parseMd, prettyPrintMd, MdToken, MdRun } from './md-to-docx';

describe('Feature: md-to-docx-conversion', () => {
  describe('Property 1: Markdown parser round-trip', () => {
    const safeChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?';
    const textGen = fc.array(fc.constantFrom(...safeChars.split('')), { minLength: 1, maxLength: 20 }).map(arr => arr.join('')).filter(s => s.trim().length > 0 && s === s.trim());
    const authorGen = fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s) && s.trim().length > 0);
    const dateGen = fc.date().map(d => d.toISOString().split('T')[0]);
    const colorGen = fc.constantFrom('yellow', 'green', 'turquoise', 'pink', 'blue', 'red');
    const keyGen = fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));
    const locatorGen = fc.string({ minLength: 1, maxLength: 15 }).filter(s => !s.includes(';') && !s.includes(']') && s.trim().length > 0 && s === s.trim());
    
    const basicRunGen = fc.record({
      type: fc.constant('text' as const),
      text: textGen,
      bold: fc.option(fc.boolean()),
      italic: fc.option(fc.boolean()),
      underline: fc.option(fc.boolean()),
      strikethrough: fc.option(fc.boolean()),
      code: fc.option(fc.boolean()),
      superscript: fc.option(fc.boolean()),
      subscript: fc.option(fc.boolean())
    }).map(run => {
      // Code formatting conflicts with other formatting
      if (run.code) {
        return {
          type: run.type,
          text: run.text,
          code: true
        };
      }
      
      return {
        type: run.type,
        text: run.text,
        ...(run.bold ? { bold: run.bold } : {}),
        ...(run.italic ? { italic: run.italic } : {}),
        ...(run.underline ? { underline: run.underline } : {}),
        ...(run.strikethrough ? { strikethrough: run.strikethrough } : {}),
        ...(run.superscript ? { superscript: run.superscript } : {}),
        ...(run.subscript ? { subscript: run.subscript } : {})
      };
    });
    
    const criticAddGen = fc.record({
      type: fc.constant('critic_add' as const),
      text: textGen
    });
    
    const criticDelGen = fc.record({
      type: fc.constant('critic_del' as const),
      text: textGen
    });
    
    const criticSubGen = fc.record({
      type: fc.constant('critic_sub' as const),
      text: textGen,
      newText: textGen
    });
    
    const criticHighlightGen = fc.record({
      type: fc.constant('critic_highlight' as const),
      text: textGen.filter(s => !s.includes('=')),
      highlight: fc.constant(true),
      highlightColor: fc.option(colorGen)
    }).map(highlight => ({
      ...highlight,
      highlightColor: highlight.highlightColor || undefined
    }));
    
    const criticCommentGen = fc.oneof(
      // Empty comment
      fc.record({
        type: fc.constant('critic_comment' as const),
        text: fc.constant(''),
        commentText: fc.constant('')
      }),
      // Comment with text that doesn't look like an author name
      fc.record({
        type: fc.constant('critic_comment' as const),
        text: fc.constant(''),
        commentText: textGen.filter(s => !/^[a-zA-Z0-9_-]+$/.test(s) || s.includes(' '))
      }),
      // Comment with just author
      fc.record({
        type: fc.constant('critic_comment' as const),
        text: fc.constant(''),
        author: authorGen
      }),
      // Comment with author, date, and text
      fc.record({
        type: fc.constant('critic_comment' as const),
        text: fc.constant(''),
        author: authorGen,
        date: dateGen,
        commentText: textGen
      })
    );
    
    const citationGen = fc.record({
      type: fc.constant('citation' as const),
      text: textGen,
      keys: fc.array(keyGen, { minLength: 1, maxLength: 3 })
    }).chain(citation => {
      // Generate locators that match the keys
      const locatorsGen = fc.option(
        fc.record(
          Object.fromEntries(
            citation.keys.map(key => [key, locatorGen])
          )
        ).map(dict => new Map(Object.entries(dict)))
      );
      
      return locatorsGen.map(locators => ({
        ...citation,
        locators: locators || undefined
      }));
    });
    
    const mathGen = fc.record({
      type: fc.constant('math' as const),
      text: fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789+=-'.split('')), { minLength: 1, maxLength: 15 }).map(arr => arr.join('')),
      display: fc.option(fc.boolean())
    }).map(math => {
      // Only set display: true for display math, leave undefined for inline
      if (math.display === true) {
        return { ...math, display: true };
      } else {
        return { type: math.type, text: math.text };
      }
    });
    
    const runGen: fc.Arbitrary<MdRun> = fc.oneof(
      basicRunGen,
      criticAddGen,
      criticDelGen,
      criticSubGen,
      criticHighlightGen,
      criticCommentGen,
      citationGen,
      mathGen
    );
    
    const paragraphGen = fc.record({
      type: fc.constant('paragraph' as const),
      runs: fc.array(runGen, { minLength: 1, maxLength: 3 })
    });
    
    const headingGen = fc.record({
      type: fc.constant('heading' as const),
      level: fc.integer({ min: 1, max: 6 }),
      runs: fc.array(runGen, { minLength: 1, maxLength: 2 })
    });
    
    const listItemGen = fc.record({
      type: fc.constant('list_item' as const),
      ordered: fc.boolean(),
      level: fc.constant(1),
      runs: fc.array(runGen, { minLength: 1, maxLength: 2 })
    });
    
    const codeBlockGen = fc.record({
      type: fc.constant('code_block' as const),
      language: fc.option(fc.constantFrom('javascript', 'python', 'rust', 'typescript')),
      runs: fc.array(fc.record({
        type: fc.constant('text' as const),
        text: fc.string({ minLength: 1, maxLength: 50 })
      }), { minLength: 1, maxLength: 1 })
    }).map(codeBlock => ({
      ...codeBlock,
      language: codeBlock.language || undefined
    }));
    
    const hrGen = fc.record({
      type: fc.constant('hr' as const),
      runs: fc.constant([])
    });
    
    const tokenGen: fc.Arbitrary<MdToken> = fc.oneof(
      paragraphGen,
      headingGen,
      listItemGen,
      codeBlockGen,
      hrGen
    );
    
    const tokensGen = fc.array(tokenGen, { minLength: 1, maxLength: 5 });
    
    // Normalize tokens by merging adjacent text runs with identical formatting
    function normalizeRuns(runs: MdRun[]): MdRun[] {
      const result: MdRun[] = [];
      for (const run of runs) {
        const prev = result[result.length - 1];
        if (prev && prev.type === 'text' && run.type === 'text' &&
            !!prev.bold === !!run.bold && !!prev.italic === !!run.italic &&
            !!prev.underline === !!run.underline && !!prev.strikethrough === !!run.strikethrough &&
            !!prev.code === !!run.code && !!prev.superscript === !!run.superscript &&
            !!prev.subscript === !!run.subscript && !!prev.highlight === !!run.highlight &&
            prev.highlightColor === run.highlightColor && prev.href === run.href) {
          prev.text += run.text;
        } else {
          result.push({ ...run });
        }
      }
      return result;
    }
    
    it('should preserve semantic meaning through parse -> pretty-print -> parse cycle', () => {
      fc.assert(
        fc.property(tokensGen, (originalTokens) => {
          // Pretty-print the tokens to markdown
          const markdown = prettyPrintMd(originalTokens);
          
          // Parse the markdown back to tokens
          const reparsedTokens = parseMd(markdown);
          
          // Compare semantic equivalence
          expect(reparsedTokens).toHaveLength(originalTokens.length);
          
          for (let i = 0; i < originalTokens.length; i++) {
            const original = originalTokens[i];
            const reparsed = reparsedTokens[i];
            
            expect(reparsed.type).toBe(original.type);
            
            if (original.level !== undefined) {
              expect(reparsed.level).toBe(original.level);
            }
            
            if (original.ordered !== undefined) {
              expect(reparsed.ordered).toBe(original.ordered);
            }
            
            if (original.language !== undefined) {
              expect(reparsed.language).toBe(original.language);
            }
            
            // Compare runs (normalized to merge adjacent same-formatted text runs)
            const origRuns = normalizeRuns(original.runs);
            const reparsedRuns = normalizeRuns(reparsed.runs);
            expect(reparsedRuns).toHaveLength(origRuns.length);
            
            for (let j = 0; j < origRuns.length; j++) {
              const origRun = origRuns[j];
              const reparsedRun = reparsedRuns[j];
              
              expect(reparsedRun.type).toBe(origRun.type);
              
              // Special handling for code block content - markdown-it adds trailing newline
              if (original.type === 'code_block' && origRun.type === 'text') {
                const expectedText = origRun.text.endsWith('\n') ? origRun.text : origRun.text + '\n';
                expect(reparsedRun.text).toBe(expectedText);
              } else if (origRun.type === 'citation') {
                // Citation text is derived from keys, not original text
                if (origRun.keys && origRun.locators && origRun.locators.size > 0) {
                  const parts = origRun.keys.map((key, idx) => {
                    const prefix = idx === 0 ? '' : '@';
                    const locator = origRun.locators!.get(key);
                    return locator ? prefix + key + ', ' + locator : prefix + key;
                  });
                  expect(reparsedRun.text).toBe(parts.join('; '));
                } else if (origRun.keys) {
                  expect(reparsedRun.text).toBe(origRun.keys.map((k, i) => i === 0 ? k : '@' + k).join('; '));
                }
              } else {
                expect(reparsedRun.text).toBe(origRun.text);
              }
              
              // Check formatting flags
              if (origRun.bold) expect(reparsedRun.bold).toBe(true);
              if (origRun.italic) expect(reparsedRun.italic).toBe(true);
              if (origRun.underline) expect(reparsedRun.underline).toBe(true);
              if (origRun.strikethrough) expect(reparsedRun.strikethrough).toBe(true);
              if (origRun.code) expect(reparsedRun.code).toBe(true);
              if (origRun.superscript) expect(reparsedRun.superscript).toBe(true);
              if (origRun.subscript) expect(reparsedRun.subscript).toBe(true);
              if (origRun.highlight) expect(reparsedRun.highlight).toBe(true);
              
              // Check type-specific properties
              if (origRun.newText !== undefined) {
                expect(reparsedRun.newText).toBe(origRun.newText);
              }
              
              if (origRun.highlightColor !== undefined) {
                expect(reparsedRun.highlightColor).toBe(origRun.highlightColor);
              }
              
              if (origRun.author !== undefined) {
                expect(reparsedRun.author).toBe(origRun.author);
              }
              
              if (origRun.date !== undefined) {
                expect(reparsedRun.date).toBe(origRun.date);
              }
              
              if (origRun.commentText !== undefined) {
                expect(reparsedRun.commentText).toBe(origRun.commentText);
              } else if (origRun.type === 'critic_comment') {
                // Empty comment should parse as empty string
                expect(reparsedRun.commentText).toBe('');
              }
              
              if (origRun.keys !== undefined) {
                expect(reparsedRun.keys).toEqual(origRun.keys);
              }
              
              if (origRun.locators !== undefined) {
                expect(reparsedRun.locators).toEqual(origRun.locators);
              }
              
              if (origRun.display !== undefined) {
                expect(reparsedRun.display).toBe(origRun.display);
              }
            }
          }
        }),
        { numRuns: 100 }
      );
    });
    
    it('should handle simple markdown elements correctly', () => {
      const testCases = [
        '# Heading',
        'Simple paragraph',
        '**bold text**',
        '*italic text*',
        '~~strikethrough~~',
        '`inline code`',
        '{++addition++}',
        '{--deletion--}',
        '{~~old~>new~~}',
        '==highlight==',
        '==colored=={blue}',
        '{>>author (2023-01-01): comment<<}',
        '[@citation]',
        '[@key, p. 20]',
        '$inline math$',
        '$$' + '\ndisplay math\n' + '$$',
        '- list item',
        '1. ordered item',
        '> blockquote',
        '```\ncode block\n```',
        '---'
      ];
      
      for (const markdown of testCases) {
        const tokens = parseMd(markdown);
        const reparsed = prettyPrintMd(tokens);
        const retokens = parseMd(reparsed);
        
        expect(retokens.length).toBeGreaterThan(0);
        if (retokens[0].type !== 'hr') {
          expect(retokens[0].runs.length).toBeGreaterThan(0);
        }
      }
    });
  });
});