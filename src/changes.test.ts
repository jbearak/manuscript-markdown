import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { navigationMatches, navigationRanges } from './navigation-matches';
import { fastestRun } from './test-timing';

// We'll test the regex pattern directly since we can't import vscode in tests
// This is the same pattern used in changes.ts
// Using [\s\S]*? to match zero or more characters (including newlines) to support empty patterns
const combinedPattern = /\{(?<!(?<!\\)(?:\\\\)*\\\{)(?:\+\+([\s\S]*?)\+\+\}|--([\s\S]*?)--\}|\~\~([\s\S]*?)\~\~\}|#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|>>([\s\S]*?)<<\}|#[a-zA-Z0-9_-]+\}|\/[a-zA-Z0-9_-]+\}|==([\s\S]*?)==\})|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)\{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\}|(?<!=)==(?<!(?<!\\)(?:\\\\)*\\==)(?<!(?<!\\)(?:\\\\)*\{==)([^}=]+)==(?<!(?<!\\)(?:\\\\)*\{==)(?![}=])|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

// Helper function to find all pattern matches in text, as getAllMatches
// finds them
function findAllPatterns(text: string): Array<{ start: number; end: number; matched: string }> {
  return navigationMatches(combinedPattern, text).map(({ start, end }) => ({ start, end, matched: text.slice(start, end) }));
}

// The matches a global exec of the pattern finds one after another
function execAll(text: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const re = new RegExp(combinedPattern.source, combinedPattern.flags);
  let match;
  while ((match = re.exec(text)) !== null) matches.push({ start: match.index, end: match.index + match[0].length });
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
});

// One == navigation read as a format highlight's opener, as x == y in a
// paragraph or keep if foreign == 1 in a Stata block, took the next
// highlight's opener as its closer, and so on through the document: the
// pattern read past a paragraph's end, and getAllMatches dropped what
// overlapped code only after. Export and the preview read each highlight in
// its paragraph's text alone, and in a table's cell's.
describe('Navigation pairs no highlight past its paragraph', () => {
  /** The text of each range navigation stops at, as getAllMatches finds them */
  const stops = (text: string) => navigationRanges(combinedPattern, text).map(({ start, end }) => text.slice(start, end));

  it.each<[string, string, string[]]>([
    ['an == in a paragraph before one with highlights', 'If x == y then.\n\nSee ==a== and ==b==.', ['==a==', '==b==']],
    ['an == in a code span before a paragraph with highlights', 'A `x == y` b.\n\nSee ==a== and ==b==.', ['==a==', '==b==']],
    ['an == in a code span before one highlight', 'A `x == y` b.\n\nSee ==a==.', ['==a==']],
    ['an == in a fenced block', '```stata\nkeep if foreign == 1\n```\n\nSee ==a== and ==b==.', ['==a==', '==b==']],
    ['an == in an indented block', '    keep if foreign == 1\n\nSee ==a== and ==b==.', ['==a==', '==b==']],
    ['an == before colored highlights', 'If x == y.\n\n==a=={red} and ==b=={blue}', ['==a=={red}', '==b=={blue}']],
    ['an == in a list item before the next', '- x == y\n- See ==a== and ==b==', ['==a==', '==b==']],
    ['an == in a heading before the paragraph under it', '# x == y\nSee ==a== and ==b==', ['==a==', '==b==']],
    ['an == in a quote\'s paragraph before its next', '> x == y\n>\n> See ==a== and ==b==', ['==a==', '==b==']],
    ['an == in a table\'s row before the next', '| x == y |\n|---|\n| ==a== and ==b== |', ['==a==', '==b==']],
    ['an opener and a closer a blank line apart', '==a\n\nb==', []],
    ['an opener and a closer a fenced block apart', '==a\n```\nx\n```\nb== and ==c==', ['== and ==']],
    ['an opener and a closer in a table\'s cells', '| a | b |\n|---|---|\n| ==x | y== |', []],
    ['an == before a paragraph with highlights and a code span', 'x == y\n\n`code` ==a== and ==b==', ['==a==', '==b==']],
    // Its paragraph's == that export reads as text closed it before
    ['an == before an equation that holds one', 'x == y\n\n$a == b$ ==real==', ['==real==']],
    ['an == before a link whose destination holds one', 'x == y\n\n[l](u==v) ==real==', ['==real==']],
    ['an == before an HTML comment that holds one', 'x == y\n\na <!-- == --> ==real==', ['<!-- == -->', '==real==']],
    ['a highlight after a fenced block a span\'s fence line opens', '==\n\n{--a\n--}\n```\n==\n```\n==l==', ['{--a\n--}', '==l==']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // As before, and as export and the preview read them
  it.each<[string, string, string[]]>([
    ['a highlight over a line end in its paragraph', '==a\nb==', ['==a\nb==']],
    ['a highlight over a line end in a list item', '- ==a\n  b==', ['==a\n  b==']],
    ['a highlight over a line end in a quote', '> ==a\n> b==', ['==a\n> b==']],
    ['an == before a highlight in its paragraph, which export pairs with the highlight\'s opener', 'If x == y then ==a==.', ['== y then ==']],
    ['an insertion over a blank line', '{++a\n\nb++}', ['{++a\n\nb++}']],
    ['a critic highlight over a blank line', '{==a\n\nb==}', ['{==a\n\nb==}']],
    ['a comment over a blank line', '{>>a\n\nb<<}', ['{>>a\n\nb<<}']],
    ['an escaped opener', '\\==a\n\nb ==c==', ['==c==']],
    ['highlights and CriticMarkup in code', '`==a== {++b++}`\n\n```\n{--c--}\n```', []],
    ['a highlight that holds a code span', '==a `b` c==', []],
    ['an insertion that holds a code span', '{++a `b` c++}', []],
    ['an insertion whose closer is in a code span', '{++a `x++}` b++} {++c++}', ['{++c++}']],
    // Where a paragraph holds an == that export reads as text, as one in
    // code, the highlights navigation read before, in that paragraph, and
    // a match from an opener in code where it read that match before
    ['an == in code before an HTML comment that holds one', '`x == y` <!-- == --> ==real==', ['==real==']],
    ['an == before a paragraph that holds one in code', 'x == y\n\n`==` ==real==', ['==real==']],
    ['the spans after a substitution\'s opener in code before a ~~~}', '`{~~` ~~~} {++added++} {~~old~>new~~}', ['{++added++}', '{~~old~>new~~}']],
    ['the insertion in a comment with no closer of its own after an == in code', 'a `c== ` {>> `==a` {++b++} {>>b<<} c', ['{++b++}', '{>>b<<}']],
    ['the spans after an opener in code that a highlight took before', '```\nx == y\n{++\n```\n\n`==a==` {++i++}\n==g=={blue}', ['{++i++}', '==g=={blue}']],
  ])('reads %s as before', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // An == or an opener in code still pairs as before, so export and the
  // preview read a and b in each, where navigation reads as before
  it.each<[string, string, string[]]>([
    ['an == in a code span before highlights in its paragraph', 'A `x == y` b ==a== and ==b==.', ['== and ==']],
    ['an insertion\'s opener in a code span', 'A `{++` b.\n\nSee {++a++} and {++b++}.', ['{++b++}']],
  ])('still reads %s as before', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // Each paragraph's end is found by binary search, and each match's
  // overlap with code too, where each stepped through every code region
  // before it, which took seconds here; linear takes milliseconds
  it.each<[string, (n: number) => string]>([
    ['many lone == in paragraphs', n => 'If x == y then.\n\n'.repeat(n) + 'See ==a==.'],
    ['many lone == in one paragraph', n => 'x == y '.repeat(n) + '\n'],
    ['many code spans holding ==, each before a highlight', n => 'A `x == y` b ==a==.\n'.repeat(n)],
    ['many code spans before many highlights', n => '`x` '.repeat(n) + '\n\n' + '==a== '.repeat(n)],
    ['many openers with no closer in code', n => 'a `{++` `{--` `{~~` `{==` `{>>` `{#c1>>` `<!--` b\n'.repeat(n) + '{++c++}'],
    ['many table rows with highlights across cells', n => '| a | b |\n|---|---|\n' + '| ==x | y== and ==z== |\n'.repeat(n)],
    ['many paragraphs that hold an == in code, each after a lone ==', n => 'x == y\n\n`==` ==a==\n\n'.repeat(n)],
    ['many paragraphs that hold an == after a <, a [ or a $', n => 'x == y\n\na <b ==c [d ==e] $f == g\n\n'.repeat(n)],
    ['many openers in code, each in a highlight before', n => 'x == `{++` y\n\n==a== {++b++}\n\n'.repeat(n)],
  ])('finds the stops in %s in linear time', (_name, input) => {
    const text = input(100_000);
    expect(fastestRun(() => navigationRanges(combinedPattern, text))).toBeLessThan(1000);
  }, 120000);

  it('reads what those texts hold', () => {
    expect(stops('If x == y then.\n\n'.repeat(3) + 'See ==a==.')).toEqual(['==a==']);
    expect(stops('A `x == y` b ==a==.\n'.repeat(2))).toEqual(['==a==']);
    expect(stops('a `{++` `{--` `{~~` `{==` `{>>` `{#c1>>` `<!--` b\n'.repeat(2) + '{++c++}')).toEqual([]);
    expect(stops('| a | b |\n|---|---|\n' + '| ==x | y== and ==z== |\n'.repeat(2))).toEqual(['== and ==', '== and ==']);
    expect(stops('x == y\n\n`==` ==a==\n\n'.repeat(2))).toEqual(['==a==', '==a==']);
    expect(stops('x == y\n\na <b ==c [d ==e] $f == g\n\n'.repeat(2))).toEqual(['==e] $f ==', '==e] $f ==']);
    expect(stops('x == `{++` y\n\n==a== {++b++}\n\n'.repeat(2))).toEqual(['==a==', '{++b++}', '==a==', '{++b++}']);
  });
});

describe('Navigation reads the blocks a span over lines joins', () => {
  /** The text of each range navigation stops at, as getAllMatches finds them */
  const stops = (text: string) => navigationRanges(combinedPattern, text).map(({ start, end }) => text.slice(start, end));

  // Export and the preview join a span's lines before they read the blocks,
  // so the lines after it go on in its paragraph, where a parse of the text
  // reads a heading or a table. And a bare ~~ or a {~~ in code, and an
  // opener in code before HTML blocks and definitions, as before
  it.each<[string, string, string[]]>([
    ['a highlight after an insertion over a heading\'s line', '{++a\n# b++} ==c\nd==', ['{++a\n# b++}', '==c\nd==']],
    ['a highlight after a comment over a heading\'s line', '{>>a\n# b<<} ==c\nd==', ['{>>a\n# b<<}', '==c\nd==']],
    ['a highlight after an insertion over a table\'s rows', '{++a\n| b |\n| - |\n++} ==c\nd==', ['{++a\n| b |\n| - |\n++}', '==c\nd==']],
    ['a highlight after an insertion over a heading\'s line, with \\r\\n', '{++a\r\n# b++} ==c\r\nd==', ['{++a\r\n# b++}', '==c\r\nd==']],
    ['a substitution after a bare ~~ in code', '    ~~\n~~{~~~>n~~}', ['{~~~>n~~}']],
    ['a substitution after a {~~ in code whose span ends past it', '    {~~\n~~}{~~~>n~~}', ['{~~~>n~~}']],
    ['an insertion in an HTML block after an opener in code', '```{++```\n<!--{++b++}', []],
    ['a critic highlight in a link\'s definition after an opener in code', '[1]:`{==`{==c==}', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // As before
  it.each<[string, string, string[]]>([
    ['a highlight after an insertion over a list item\'s line', '{++a\n- b++} ==c\nd==', ['{++a\n- b++}', '==c\nd==']],
    ['a bare ~~ in a code span, which takes the next ~~', 'A `~~` b.\n\nSee ~~a~~ and ~~b~~.', ['~~ and ~~']],
    ['a substitution wholly in a code span', '`{~~~~}`{~~~>n~~}', ['{~~~>n~~}']],
    ['an HTML comment\'s block', '<!--\n{++a++}\n-->', ['<!--\n{++a++}\n-->']],
    ['an insertion in a note\'s definition, which export reads in the note', '[^1]: {++a++}', ['{++a++}']],
  ])('reads %s as before', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // The blocks are read from what preprocessing writes, by offsets it maps
  // once, and each span in code from its closer, found by binary search
  it.each<[string, number, (n: number) => string]>([
    ['many substitutions\' openers in code whose spans end past it', 100_000, n => 'a `{~~` b\n'.repeat(n) + '~~}'],
    ['many spans wholly in code', 100_000, n => '`{~~a~~}` '.repeat(n)],
    ['many spans over lines', 50_000, n => '{++a\n# b++} ==c\nd==\n\n'.repeat(n)],
    ['many HTML blocks and links\' definitions', 50_000, n => '<div>\n==a== {++b++}\n</div>\n\n[l]: u\n\n'.repeat(n)],
  ])('finds the stops in %s in linear time', (_name, n, input) => {
    const text = input(n);
    expect(fastestRun(() => navigationRanges(combinedPattern, text))).toBeLessThan(1000);
  }, 120000);

  it('reads what those texts hold', () => {
    expect(stops('a `{~~` b\n'.repeat(2) + '~~}')).toEqual([]);
    expect(stops('`{~~a~~}` '.repeat(2))).toEqual([]);
    expect(stops('{++a\n# b++} ==c\nd==\n\n'.repeat(2))).toEqual(['{++a\n# b++}', '==c\nd==', '{++a\n# b++}', '==c\nd==']);
    expect(stops('<div>\n==a== {++b++}\n</div>\n\n[l]: u\n\n'.repeat(2))).toEqual(['==a==', '{++b++}', '==a==', '{++b++}']);
  });
});

describe('Navigation reads as before where export may read the blocks otherwise', () => {
  /** The text of each range navigation stops at, as getAllMatches finds them */
  const stops = (text: string) => navigationRanges(combinedPattern, text).map(({ start, end }) => text.slice(start, end));

  // A note's definition's later line, which a parse reads as a link's
  // title, and a span after a backtick that the parse of code spans pairs
  // across an HTML block, which export reads. And a span after code spans
  // whose backticks the parse pairs across blocks
  it.each<[string, string, string[]]>([
    ['an insertion on a note\'s definition\'s later line', 'See[^1].\n\n[^1]: https://example.com\n    "{++added++}"', ['{++added++}']],
    ['an insertion after a backtick a code span\'s parse pairs across an HTML block', 'Before `\n<div>\n</div>\n\n` {++added++}\n# After `', ['{++added++}']],
    ['a deletion after code spans whose backticks pair across blocks', '- `{>>` x ` b\n\n- `{--` y\n\n# `<<}`\n\n{--d--}', ['{--d--}']],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // Where neither the opener nor the closer either reading takes is in such
  // a block, though what navigation read before held one
  it.each<[string, string, string[]]>([
    ['an == in a paragraph before an HTML comment\'s block and a paragraph with highlights', 'If x == y.\n\n<!-- note -->\n\nSee ==a== and ==b==.', ['<!-- note -->', '==a==', '==b==']],
    ['an opener and a closer an HTML block apart', '==b\n\n<div>\n\nc== d', []],
  ])('reads %s as export does', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  // Where the highlight that a lone == took before ends in an HTML block,
  // which export reads as HTML, or on a quote's lazy line, before which
  // export ends the quote. And spans from code, as before
  it.each<[string, string, string[]]>([
    ['an insertion in an HTML block after an opener in code', '`{++`\n\n<div>\n{++b++}\n</div>', []],
    ['a highlight in an HTML block after an == in code', '`x == y`\n\n<div>\n==h==\n</div>', []],
    ['an HTML comment\'s block after a lone == in a list item', '- a == `b`\n\n<!--\n==h==\n-->', []],
    ['an insertion in an HTML comment\'s block in a comment from code', '`{#x>>`\n\n<!--\n{++i++}\n-->\n\n```\n<<}\n```', []],
    ['a highlight from a quote\'s line to a lazy line after an == in code', '```\nx == 1\n```\n\n> q ==h\ni==', []],
  ])('reads %s as before', (_name, text, expected) => {
    expect(stops(text)).toEqual(expected);
  });

  it('reads the highlight after one before a span across a table\'s rows, as before', () => {
    // Its opener's scan read past the row's end
    expect(stops('| x == y |\n|---|\n| ==b {++c |\n| d++} ==e== |')).toContain('==e==');
  });

  // An == in an HTML block that closed a highlight before, which navigation
  // reads as before, closes none and opens none, as before
  it('reads the highlight after an HTML block whose == closed one before, as before', () => {
    expect(stops('x == y\n\n==a==\n\n<div>\n==\n</div>\n\n==b==')).toContain('==b==');
  });

  it('reads the highlights around an HTML block whose == closed one before as export does', () => {
    expect(stops('x == y\n\n==a==\n\n<div>\n==\n</div>\n\n==b==')).toEqual(['==a==', '==b==']);
  });

  it('reads the rows of a table with a span across them as export does', () => {
    // Before, the first row's lone == took the second's opener
    expect(stops('| x == y |\n|---|\n| ==b {++c |\n| d++} ==e== |')).toEqual(['{++c |\n| d++}', '==e==']);
  });

  // What navigation read before is read once at most, and each unsure
  // region's overlap found by binary search
  it.each<[string, number, (n: number) => string]>([
    ['many openers in code before HTML blocks', 50_000, n => '`{++`\n\n<div>\n{++b++}\n</div>\n\n'.repeat(n)],
    ['many == in code before HTML blocks', 50_000, n => '`x == y`\n\n<div>\n==h==\n</div>\n\n'.repeat(n)],
    ['many lone == before an HTML block', 100_000, n => 'x == y\n\n'.repeat(n) + '<div>\n==h==\n</div>'],
    ['many lone == each before an HTML comment\'s block and a highlight', 50_000, n => 'x == y\n\n<!-- c -->\n\n==a==\n\n'.repeat(n)],
    ['many highlights each before an HTML block that holds an ==', 50_000, n => 'x == y\n\n==a==\n\n<div>\n==\n</div>\n\n'.repeat(n)],
    ['many quotes with a lazy line', 50_000, n => '> a ==h\nb==\n\n'.repeat(n)],
    ['many code spans whose backticks pair across blocks', 100_000, n => '`{>>` x ` b\n\n'.repeat(n) + '<<}'],
    ['many HTML comments\' openers in code before HTML blocks', 50_000, n => '`<!--`\n\n<div>\n-->\n</div>\n\n'.repeat(n)],
  ])('finds the stops in %s in linear time', (_name, n, input) => {
    const text = input(n);
    expect(fastestRun(() => navigationRanges(combinedPattern, text))).toBeLessThan(1000);
  }, 120000);

  it('reads what those texts hold', () => {
    expect(stops('`{++`\n\n<div>\n{++b++}\n</div>\n\n'.repeat(2))).toEqual([]);
    expect(stops('`x == y`\n\n<div>\n==h==\n</div>\n\n'.repeat(2))).toEqual(['==h==']);
    expect(stops('x == y\n\n'.repeat(2) + '<div>\n==h==\n</div>')).toEqual(['==h==']);
    expect(stops('`{>>` x ` b\n\n'.repeat(2) + '<<}')).toEqual([]);
    expect(stops('`<!--`\n\n<div>\n-->\n</div>\n\n'.repeat(2))).toEqual([]);
    expect(stops('x == y\n\n<!-- c -->\n\n==a==\n\n'.repeat(2))).toEqual(['<!-- c -->', '==a==', '<!-- c -->', '==a==']);
    expect(stops('x == y\n\n==a==\n\n<div>\n==\n</div>\n\n'.repeat(2))).toEqual(['==a==', '==a==']);
  });
});
