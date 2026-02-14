import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';

// We'll test the regex pattern directly since we can't import vscode in tests
// This is the same pattern used in changes.ts
// Using [\s\S]*? to match zero or more characters (including newlines) to support empty patterns
const combinedPattern = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{>>([\s\S]*?)<<\}|\{==([\s\S]*?)==\}|(?<!\{)==([^}=]+)==\{[a-z0-9-]+\}|(?<!\{)==([^}=]+)==(?!\})|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

// Helper function to find all pattern matches in text
function findAllPatterns(text: string): Array<{ start: number; end: number; matched: string }> {
  const matches: Array<{ start: number; end: number; matched: string }> = [];
  let match;
  
  // Reset regex state
  combinedPattern.lastIndex = 0;
  
  while ((match = combinedPattern.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      matched: match[0]
    });
  }
  
  return matches;
}

// Generator for multi-line text that avoids mdmarkup special characters
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

describe('Multi-line mdmarkup Pattern Recognition', () => {
  
  // Feature: multiline-mdmarkup-support, Property 1: Multi-line pattern recognition
  // Validates: Requirements 1.1, 2.1, 3.1, 4.1, 5.1
  describe('Property 1: Multi-line pattern recognition', () => {
    
    it('should recognize complete multi-line patterns for all mdmarkup types', () => {
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

  // Feature: multiline-mdmarkup-support, Property 2: Multi-line navigation correctness
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
      
      // Check if it starts and ends with valid mdmarkup markers
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
