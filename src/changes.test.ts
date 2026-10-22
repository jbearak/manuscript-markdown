import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { navigationMatches } from './navigation-matches';
import { findMatchingClose } from './critic-markup';
import { fastestRun } from './test-timing';

// We'll test the regex pattern directly since we can't import vscode in tests
// This is the same pattern used in changes.ts
// Using [\s\S]*? to match zero or more characters (including newlines) to support empty patterns
const combinedPattern = /\{(?<!(?<!\\)(?:\\\\)*\\\{)(?:\+\+([\s\S]*?)\+\+\}|--([\s\S]*?)--\}|\~\~([\s\S]*?)\~\~\}|#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|>>([\s\S]*?)<<\}|#(?!(?:fig|tbl)-[a-zA-Z0-9_-])[a-zA-Z0-9_-]+\}|\/[a-zA-Z0-9_-]+\}|==([\s\S]*?)==\})|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\}|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)(?![}=])|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

// Helper function to find all pattern matches in text, as getAllMatches
// finds them
function findAllPatterns(text: string): Array<{ start: number; end: number; matched: string }> {
  return navigationMatches(combinedPattern, text).map(({ start, end }) => ({ start, end, matched: text.slice(start, end) }));
}

// The matches a global exec of the pattern finds one after another, but
// that a comment's goes on to the <<} export pairs with its opener, past its
// replies', as {>>note {>>reply<<}<<}, and one export pairs with none, which
// it reads no comment, starts none
function execAll(text: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const re = new RegExp(combinedPattern.source, combinedPattern.flags);
  let match;
  while ((match = re.exec(text)) !== null) {
    let end = match.index + match[0].length;
    const opener = /^\{(?:#[a-zA-Z0-9_-]+)?>>/.exec(match[0]);
    if (opener) {
      const close = findMatchingClose(text, match.index + opener[0].length);
      if (close === -1) {
        re.lastIndex = match.index + 1;
        continue;
      }
      end = close + 3;
      re.lastIndex = end;
    }
    matches.push({ start: match.index, end });
  }
  return matches;
}

// Generator for multi-line text that avoids Manuscript Markdown special characters
const multiLineTextGen = fc.array(
  fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
  { minLength: 1, maxLength: 10 }
).map(lines => lines.join('\n'));

// Generator for pattern types
const patternTypeGen = fc.constantFrom(
  { name: 'addition', open: '{++', close: '++}' },
  { name: 'deletion', open: '{--', close: '--}' },
  { name: 'comment', open: '{>>', close: '<<}' },
  { name: 'highlight', open: '{==', close: '==}' }
);

describe('Multi-line Manuscript Markdown Pattern Recognition', () => {
  
  // Feature: multiline-Manuscript Markdown-support, Property 1: Multi-line pattern recognition
  // Validates: Requirements 1.1, 2.1, 3.1, 4.1, 5.1
  describe('Property 1: Multi-line pattern recognition', () => {
    
    it('should recognize complete multi-line patterns for all Manuscript Markdown types', () => {
      fc.assert(
        fc.property(
          multiLineTextGen,
          patternTypeGen,
          (text, patternType) => {
            // Create content with the pattern
            const content = `${patternType.open}${text}${patternType.close}`;
            
            // Find all matches
            const matches = findAllPatterns(content);
            
            // Should find exactly one match
            if (matches.length !== 1) {
              return false;
            }
            
            // The match should span the entire pattern
            const match = matches[0];
            
            // Verify the matched text is the complete pattern
            return match.matched === content;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should recognize multi-line substitution patterns', () => {
      fc.assert(
        fc.property(
          multiLineTextGen,
          multiLineTextGen,
          (oldText, newText) => {
            // Create a substitution pattern
            const content = `{~~${oldText}~>${newText}~~}`;
            
            // Find all matches
            const matches = findAllPatterns(content);
            
            // Should find exactly one match
            if (matches.length !== 1) {
              return false;
            }
            
            // The match should span the entire pattern
            const match = matches[0];
            
            // Verify the matched text is the complete pattern
            return match.matched === content;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should recognize patterns containing empty lines', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
              fc.constant('')
            ),
            { minLength: 3, maxLength: 10 }
          ),
          patternTypeGen,
          (lines, patternType) => {
            // Ensure at least one empty line exists
            const hasEmptyLine = lines.some(line => line === '');
            if (!hasEmptyLine) {
              lines[Math.floor(lines.length / 2)] = '';
            }
            
            const text = lines.join('\n');
            const content = `${patternType.open}${text}${patternType.close}`;
            
            // Find all matches
            const matches = findAllPatterns(content);
            
            // Should find exactly one match
            if (matches.length !== 1) {
              return false;
            }
            
            // The match should span the entire pattern including empty lines
            const match = matches[0];
            
            // Verify the matched text is the complete pattern
            return match.matched === content;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should recognize multiple multi-line patterns in a document', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              text: multiLineTextGen,
              patternType: patternTypeGen
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (patterns) => {
            // Create content with multiple patterns separated by plain text
            const content = patterns.map((p, i) => 
              `${p.patternType.open}${p.text}${p.patternType.close}`
            ).join('\n\nPlain text\n\n');
            
            // Find all matches
            const matches = findAllPatterns(content);
            
            // Should find exactly as many matches as patterns
            if (matches.length !== patterns.length) {
              return false;
            }
            
            // Each match should correspond to a complete pattern
            return matches.every((match, i) => {
              const expectedPattern = `${patterns[i].patternType.open}${patterns[i].text}${patterns[i].patternType.close}`;
              return match.matched === expectedPattern;
            });
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should handle patterns spanning many lines', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
            { minLength: 10, maxLength: 50 }
          ),
          patternTypeGen,
          (lines, patternType) => {
            const text = lines.join('\n');
            const content = `${patternType.open}${text}${patternType.close}`;
            
            // Find all matches
            const matches = findAllPatterns(content);
            
            // Should find exactly one match
            if (matches.length !== 1) {
              return false;
            }
            
            // The match should span multiple lines (contains newlines)
            const match = matches[0];
            const spansMultipleLines = match.matched.includes('\n');
            
            // Verify the matched text is the complete pattern
            const isCompletePattern = match.matched === content;
            
            return spansMultipleLines && isCompletePattern;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: multiline-Manuscript Markdown-support, Property 2: Multi-line navigation correctness
  // Validates: Requirements 1.3, 2.3, 3.3, 4.3, 5.3
  describe('Property 2: Multi-line navigation correctness', () => {
    
    // Helper to convert character positions to line/column positions
    function positionFromOffset(text: string, offset: number): { line: number; character: number } {
      const lines = text.substring(0, offset).split('\n');
      return {
        line: lines.length - 1,
        character: lines[lines.length - 1].length
      };
    }
    
    // Helper to verify a range corresponds to a complete pattern
    function isCompletePattern(text: string, start: number, end: number): boolean {
      const matched = text.substring(start, end);
      
      // Check if it starts and ends with valid Manuscript Markdown markers
      const validPatterns = [
        { open: '{++', close: '++}' },
        { open: '{--', close: '--}' },
        { open: '{~~', close: '~~}' },
        { open: '{>>', close: '<<}' },
        { open: '{==', close: '==}' }
      ];
      
      return validPatterns.some(p => 
        matched.startsWith(p.open) && matched.endsWith(p.close)
      );
    }
    
    it('should identify complete multi-line patterns with correct ranges', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
            { minLength: 2, maxLength: 10 }
          ),
          patternTypeGen,
          (lines, patternType) => {
            const text = lines.join('\n');
            const pattern = `${patternType.open}${text}${patternType.close}`;
            
            // Add some plain text before and after
            const document = `Some plain text\n\n${pattern}\n\nMore plain text`;
            
            // Find all matches
            const matches = findAllPatterns(document);
            
            // Should find exactly one match
            if (matches.length !== 1) {
              return false;
            }
            
            const match = matches[0];
            
            // Verify the range corresponds to a complete pattern
            if (!isCompletePattern(document, match.start, match.end)) {
              return false;
            }
            
            // Verify the matched text is exactly the pattern
            const matchedText = document.substring(match.start, match.end);
            if (matchedText !== pattern) {
              return false;
            }
            
            // Verify the pattern spans multiple lines
            const startPos = positionFromOffset(document, match.start);
            const endPos = positionFromOffset(document, match.end);
            
            return endPos.line > startPos.line;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should correctly identify ranges for multiple multi-line patterns', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              lines: fc.array(
                fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
                { minLength: 2, maxLength: 5 }
              ),
              patternType: patternTypeGen
            }),
            { minLength: 2, maxLength: 5 }
          ),
          (patternConfigs) => {
            // Build document with multiple patterns
            const patterns = patternConfigs.map(config => {
              const text = config.lines.join('\n');
              return `${config.patternType.open}${text}${config.patternType.close}`;
            });
            
            const document = patterns.join('\n\nPlain text\n\n');
            
            // Find all matches
            const matches = findAllPatterns(document);
            
            // Should find exactly as many matches as patterns
            if (matches.length !== patterns.length) {
              return false;
            }
            
            // Each match should correspond to a complete pattern
            return matches.every((match, i) => {
              const matchedText = document.substring(match.start, match.end);
              return matchedText === patterns[i] && 
                     isCompletePattern(document, match.start, match.end);
            });
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should handle multi-line patterns with empty lines', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
              fc.constant('')
            ),
            { minLength: 3, maxLength: 10 }
          ),
          patternTypeGen,
          (lines, patternType) => {
            // Ensure at least one empty line
            const hasEmptyLine = lines.some(line => line === '');
            if (!hasEmptyLine) {
              lines[Math.floor(lines.length / 2)] = '';
            }
            
            const text = lines.join('\n');
            const pattern = `${patternType.open}${text}${patternType.close}`;
            const document = `Plain text\n\n${pattern}\n\nMore text`;
            
            // Find all matches
            const matches = findAllPatterns(document);
            
            // Should find exactly one match
            if (matches.length !== 1) {
              return false;
            }
            
            const match = matches[0];
            const matchedText = document.substring(match.start, match.end);
            
            // Verify the matched text includes all empty lines
            if (matchedText !== pattern) {
              return false;
            }
            
            // Verify it's a complete pattern
            if (!isCompletePattern(document, match.start, match.end)) {
              return false;
            }
            
            // Verify the pattern spans multiple lines
            const startPos = positionFromOffset(document, match.start);
            const endPos = positionFromOffset(document, match.end);
            
            return endPos.line > startPos.line;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('should correctly order ranges in document order', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              lines: fc.array(
                fc.string().filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<') && !s.includes('=')),
                { minLength: 1, maxLength: 5 }
              ),
              patternType: patternTypeGen
            }),
            { minLength: 2, maxLength: 5 }
          ),
          (patternConfigs) => {
            // Build document with multiple patterns
            const patterns = patternConfigs.map(config => {
              const text = config.lines.join('\n');
              return `${config.patternType.open}${text}${config.patternType.close}`;
            });
            
            const document = patterns.join('\n\n');
            
            // Find all matches
            const matches = findAllPatterns(document);
            
            // Should find exactly as many matches as patterns
            if (matches.length !== patterns.length) {
              return false;
            }
            
            // Verify ranges are in document order (each start is after the previous end)
            for (let i = 1; i < matches.length; i++) {
              if (matches[i].start <= matches[i - 1].end) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// Feature: highlight-colors, Property 7: Navigation regex matches colored highlight patterns
describe('Property 7: Navigation regex matches colored highlights', () => {
  const { VALID_COLOR_IDS } = require('./highlight-colors');
  const colorIdGen = fc.constantFrom(...VALID_COLOR_IDS as string[]);
  const safeTextGen = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s: string) => !s.includes('=') && !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<')
  );

  it('should match ==text=={color} as a single match', () => {
    fc.assert(
      fc.property(safeTextGen, colorIdGen, (text: string, color: string) => {
        const doc = '==' + text + '=={' + color + '}';
        const matches = findAllPatterns(doc);
        expect(matches.length).toBe(1);
        expect(matches[0].matched).toBe(doc);
      }),
      { numRuns: 100 }
    );
  });

  it('should match plain ==text== as a single match', () => {
    fc.assert(
      fc.property(safeTextGen, (text: string) => {
        const doc = '==' + text + '==';
        const matches = findAllPatterns(doc);
        expect(matches.length).toBe(1);
        expect(matches[0].matched).toBe(doc);
      }),
      { numRuns: 100 }
    );
  });

  it('should not match plain ==text== when immediately followed by =', () => {
    const doc = 'some ==text=== more';
    const matches = findAllPatterns(doc);
    expect(matches.length).toBe(0);
  });
});

// An == after an odd run of backslashes opens no highlight, as export and
// the preview read it: the last backslash escapes its first =. One before a
// closing == escapes nothing, as in export.
describe('Navigation regex skips an escaped highlight opener', () => {
  it.each<[string, string, string[]]>([
    ['an escaped opener before a highlight', 'a \\== b ==c==', ['==c==']],
    ['an escaped opener', '\\==x==', []],
    ['an opener after three backslashes', '\\\\\\==x== y', []],
    ['an escaped opener of a colored highlight', 'x \\==a=={red} y', []],
    ['the opener after an escaped one', '\\==a==b==', ['==b==']],
    ['an escaped opener right after a highlight', '==a\\==\\==b==', ['==a\\==']],
    ['a highlight', 'a ==x== b', ['==x==']],
    ['a colored highlight', 'a ==x=={red} b', ['==x=={red}']],
    ['a critic highlight', 'a {==x==} b', ['{==x==}']],
    ['a highlight after an escaped backslash', 'a \\\\==x== b', ['==x==']],
    ['a highlight after two escaped backslashes', 'a \\\\\\\\==x== b', ['==x==']],
    ['a colored highlight after an escaped backslash', '\\\\==x=={red}', ['==x=={red}']],
    ['a backslash before the closer, which escapes none', '==a\\== b', ['==a\\==']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
  });

  it('is the pattern changes.ts scans with, as each other test copy is', () => {
    for (const file of ['changes.ts', 'changes.property.test.ts', 'code-regions.test.ts', 'code-regions.property.test.ts']) {
      expect(fs.readFileSync(path.join(__dirname, file), 'utf-8')).toContain(combinedPattern.toString());
    }
  });
});

// Feature: highlight-colors, Property 8: Overlapping pattern filtering with colored highlights
describe('Property 8: Overlapping pattern filtering with colored highlights', () => {
  // Helper: filter contained ranges (same logic as changes.ts getAllMatches)
  function filterContained(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
    const filtered: Array<{ start: number; end: number }> = [];
    let lastKept: { start: number; end: number } | undefined;
    for (const range of ranges) {
      if (!lastKept || !(lastKept.start <= range.start && range.end <= lastKept.end)) {
        filtered.push(range);
        lastKept = range;
      }
    }
    return filtered;
  }

  it('should not produce duplicate stops for CriticMarkup and colored highlights at different positions', () => {
    const { VALID_COLOR_IDS } = require('./highlight-colors');
    const colorIdGen = fc.constantFrom(...VALID_COLOR_IDS as string[]);
    const safeTextGen = fc.string({ minLength: 1, maxLength: 30 }).filter(
      (s: string) => !s.includes('=') && !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && !s.includes('<')
    );

    fc.assert(
      fc.property(safeTextGen, safeTextGen, colorIdGen, (t1: string, t2: string, color: string) => {
        const doc = '{==' + t1 + '==} some text ==' + t2 + '=={' + color + '}';
        const matches = findAllPatterns(doc);
        const filtered = filterContained(matches);
        // Both patterns should survive filtering (they don't overlap)
        expect(filtered.length).toBe(2);
      }),
      { numRuns: 100 }
    );
  });
});

// A { after an odd run of backslashes opens no CriticMarkup, as export and
// the preview read it: the last backslash escapes it
describe('Navigation regex skips an escaped CriticMarkup opener', () => {
  it.each<[string, string, string[]]>([
    ['an escaped insertion', 'a \\{++x++} b', []],
    ['an escaped deletion', 'a \\{--x--} b', []],
    ['an escaped substitution, whose ~~ strike through its text', 'a \\{~~x~>y~~} b', ['~~x~>y~~']],
    ['an escaped comment', 'a \\{>>c<<} b', []],
    ['an escaped critic highlight', 'a \\{==x==} b', []],
    ['an escaped range start', 'a \\{#1}x{/1}{#1>>c<<} b', ['{/1}', '{#1>>c<<}']],
    ['an escaped range end', 'a {#1}x\\{/1}{#1>>c<<} b', ['{#1}', '{#1>>c<<}']],
    ['an escaped comment with an ID', 'a {#1}x{/1}\\{#1>>c<<} b', ['{#1}', '{/1}']],
    ['an insertion after three backslashes', 'a \\\\\\{++x++} b', []],
    ['an insertion', 'a {++x++} b', ['{++x++}']],
    ['an insertion after an escaped backslash', 'a \\\\{++x++} b', ['{++x++}']],
    ['a deletion after two escaped backslashes', 'a \\\\\\\\{--x--} b', ['{--x--}']],
    ['a substitution', 'a {~~x~>y~~} b', ['{~~x~>y~~}']],
    ['a critic highlight and its comment', 'a {==x==}{>>c<<} b', ['{==x==}', '{>>c<<}']],
    ['a comment\'s range and body', 'a {#1}x{/1}{#1>>c<<} b', ['{#1}', '{/1}', '{#1>>c<<}']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
  });
});

// An == right after a { that an odd run of backslashes escapes opens a
// highlight, as export and the preview read it: the { is text, as in
// \{==x==\}, which import writes for Word's literal braces around a
// highlight. One right after a { no odd run escapes opens none, as before
describe('Navigation regex reads an == after an escaped { as a highlight\'s opener', () => {
  it.each<[string, string, string[]]>([
    ['an escaped { and } around a highlight', '\\{==x==\\}', ['==x==']],
    ['a highlight after three backslashes and a {', '\\\\\\{==x==\\}', ['==x==']],
    ['an escaped { and } around a highlight in text', 'a \\{==x==\\} b', ['==x==']],
    ['a colored highlight after an escaped {', 'a \\{==x=={red} b', ['==x=={red}']],
    ['a highlight after an escaped { without a closing brace', 'a \\{==x== b', ['==x==']],
    ['an escaped critic highlight, whose == before a } closes none', 'a \\{==x==} b', []],
    ['a critic highlight', 'a {==x==} b', ['{==x==}']],
    ['a critic highlight after an escaped backslash', 'a \\\\{==x==} b', ['{==x==}']],
    ['a highlight', 'a ==x== b', ['==x==']],
    ['an escaped opener', 'a \\==x== b', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
  });

  // Export reads a highlight there, its { text, but the preview none, and
  // only a search past it for its ==} could tell the two apart
  it('reads no highlight after a {== that no ==} closes, as the preview does', () => {
    expect(findAllPatterns('a {==x== b').map(m => m.matched)).toEqual([]);
  });
});

// A closing == right after a { that no odd run of backslashes escapes, a
// {=='s, closes no highlight, as export, the preview and the decorations
// read it: a == b {==c==}{>>n<<}, which import writes for Word's a == b
// before a commented c, is a critic highlight on c and its comment, not a
// highlight of " b {". One after an escaped { closes one, as before
describe('Navigation regex reads no highlight that a {==\'s == would close', () => {
  it.each<[string, string, string[]]>([
    ['an == in text before a commented critic highlight', 'P a == b {==c==}{>>n<<} Q', ['{==c==}', '{>>n<<}']],
    ['an opener before a critic highlight', 'P ==a {==c==} Q', ['{==c==}']],
    ['an opener after an escaped one before a critic highlight', 'P \\==a b== {==c==} Q', ['{==c==}']],
    ['an opener right before a critic highlight', 'P =={==c==} Q', ['{==c==}']],
    ['an opener before a critic highlight after an escaped backslash', 'P ==a \\\\{==c==} Q', ['{==c==}']],
    ['an opener before a {== that no ==} closes', 'P ==a {==c Q', []],
    ['a colored highlight\'s opener before a {== that no ==} closes', 'P ==a {=={red} Q', []],
    // As before
    ['a highlight closed after an escaped {', 'P ==a \\{==c Q', ['==a \\{==']],
    ['a colored highlight closed after an escaped {', 'P ==a \\{=={red} Q', ['==a \\{=={red}']],
    ['a highlight closed after three backslashes and a {', 'P ==a \\\\\\{==c Q', ['==a \\\\\\{==']],
    ['a highlight', '==a==', ['==a==']],
    ['a critic highlight', '{==a==}', ['{==a==}']],
    ['an escaped { and } around a highlight', '\\{==a==\\}', ['==a==']],
    ['a { in a highlight', '==a {b==', ['==a {b==']],
    ['a { and a backslash in a highlight', '==a\\b {c\\== d', ['==a\\b {c\\==']],
    ['an == in text', 'a == b', []],
    ['a highlight whose closing == a } follows', '==a==}', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
    expect(navigationMatches(combinedPattern, text)).toEqual(execAll(text));
  });

  // Limits from before, which this leaves as they were: export reads a
  // highlight of a in the first, where the preview and the decorations read
  // one of b, and one of a=b in the second, where the decorations read none
  it.each<[string, string, string[]]>([
    ['a critic highlight with no closer before a highlight', '{==a==b==', ['==b==']],
    ['a highlight with an = in it', '==a=b==', []],
  ])('reads %s as before', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
    expect(navigationMatches(combinedPattern, text)).toEqual(execAll(text));
  });
});

// A comment holds its replies, as import writes them, {>>note {>>reply<<}<<},
// so navigation selects it to the <<} export pairs with its opener, as it
// selects each of the comments of {>>note<<}{>>reply<<}
describe('Navigation selects a comment with its replies', () => {
  it.each<[string, string, string[]]>([
    ['a comment with a reply in it', '{==a==}{>>note\n  {>>reply<<}\n<<} b', ['{==a==}', '{>>note\n  {>>reply<<}\n<<}']],
    ['a comment in a heading with a reply in it', '## {==a==}{>>@p (2026-10-22 10:36) | note\n  {>>reply<<}\n<<}', ['{==a==}', '{>>@p (2026-10-22 10:36) | note\n  {>>reply<<}\n<<}']],
    ['a comment with replies one after another', '{>>note<<}{>>reply<<}', ['{>>note<<}', '{>>reply<<}']],
    ['a comment with two replies in it', '{>>note {>>r1<<} {>>r2<<}<<} b', ['{>>note {>>r1<<} {>>r2<<}<<}']],
    ['a comment body with an ID and a reply in it', '{#1}a{/1}\n\n{#1>>note\n  {>>reply<<}\n<<}', ['{#1}', '{/1}', '{#1>>note\n  {>>reply<<}\n<<}']],
    ['a comment whose own <<} is missing, before its reply', '{>>note {>>reply<<} b', ['{>>reply<<}']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
    expect(navigationMatches(combinedPattern, text)).toEqual(execAll(text));
  });
});

// An opener with no closer after it searched the rest of the text for one
describe('Navigation steps past an opener with no closer after it', () => {
  const fragment = fc.constantFrom('{', '}', '+', '-', '~', '=', '>', '<', '#', '/', '!', '\\', 'a', ' ', '\n',
    '{++', '++}', '{--', '--}', '{~~', '~~}', '~>', '{==', '==}', '{>>', '<<}', '{#a>>', '{#a-1>>', '{#a}', '{/a}',
    '<!--', '-->', '==', '~~', '{red}', '\\{', '<!-->', '<!---->');

  it('finds what a global exec of the pattern finds', () => {
    fc.assert(fc.property(fc.array(fragment, { maxLength: 40 }).map(parts => parts.join('')), text => {
      expect(navigationMatches(combinedPattern, text)).toEqual(execAll(text));
    }), { numRuns: 2000 });
  });

  it.each<[string, string, string[]]>([
    ['an insertion with no closer before one that has one', '{++a {++b++}', ['{++a {++b++}']],
    ['an insertion after the last ++}', 'a++} {++b', []],
    ['a comment with an ID after the last <<}', '{#a>>b <<} {#c>>d', ['{#a>>b <<}']],
    ['a comment with an ID and no closer before a range end', '{#a>>b {/a}', ['{/a}']],
    ['an HTML comment whose --> is in its opener', '<!--> a', []],
    ['a substitution with no closer, whose ~~ strike through', '{~~a~~ b', ['~~a~~']],
    ['a critic highlight with no closer before a highlight', '{==a ==b==', ['==b==']],
  ])('reads %s as a global exec does', (_name, text, expected) => {
    expect(findAllPatterns(text).map(m => m.matched)).toEqual(expected);
    expect(navigationMatches(combinedPattern, text)).toEqual(execAll(text));
  });

  it.each(['{>>', '{++', '{--', '{~~', '{==', '{#c1>>', '<!--'])('finds the changes in a text of many %s with no closer in linear time', (opener) => {
    const text = '{++a++} ' + ('word ' + opener + ' more text here\n').repeat(20_000) + '{#1}';
    let found: Array<{ start: number; end: number }> = [];
    // Searching the rest of the text from each opener took seconds here;
    // linear takes milliseconds
    expect(fastestRun(() => { found = navigationMatches(combinedPattern, text); })).toBeLessThan(1000);
    // The ~~ of a {~~ with no ~~} strikes through to the next {~~'s
    expect(found.map(({ start, end }) => text.slice(start, end)).filter(m => !m.startsWith('~~'))).toEqual(['{++a++}', '{#1}']);
  }, 30000);

  // Export pairs none of these {>> with the one <<}, but for the last, so
  // each of them is skipped, and the pattern's not tried from each, which
  // would search on to the <<}
  it.each(['{>>', '{#c1>>'])('finds the changes in a text of many %s with one <<} at its end in linear time', (opener) => {
    const text = '{++a++} ' + ('word ' + opener + ' more text here\n').repeat(20_000) + '<<}';
    let found: Array<{ start: number; end: number }> = [];
    expect(fastestRun(() => { found = navigationMatches(combinedPattern, text); })).toBeLessThan(1000);
    expect(found.map(({ start, end }) => text.slice(start, end))).toEqual(['{++a++}', opener + ' more text here\n<<}']);
  }, 30000);
});

describe('Caption labels', () => {
  it('stops at no caption label, which is no comment range\'s start, but at a range of an ID that is fig- alone', () => {
    const text = '![Map](map.png){#fig-map} {#tbl-est} {#fig-}x{/fig-} {#fig-1>>c<<}';
    expect(findAllPatterns(text).map(match => match.matched)).toEqual(['{#fig-}', '{/fig-}', '{#fig-1>>c<<}']);
  });
});
