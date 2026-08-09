import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { wrapSelection, wrapLines, wrapLinesNumbered, formatHeading, highlightAndComment, wrapCodeBlock, substituteAndComment, additionAndComment, deletionAndComment, reflowTable, compactTable, parseTable, isTableRow, findTableRangeAtOffset } from './formatting';
import { scanCitationDocument } from './citation-scanner';
import { preprocessGridTables } from './grid-table-preprocess';

describe('Formatting Module Property Tests', () => {
  
  // Feature: markdown-context-menu, Property 1: Text wrapping preserves content
  // Validates: Requirements 1.2, 1.3, 1.5, 2.2, 2.3, 2.4, 2.5
  describe('Property 1: Text wrapping preserves content', () => {
    it('should preserve original text for addition markup', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '{++', '++}');
          const extracted = result.newText.slice(3, -3);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for deletion markup', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '{--', '--}');
          const extracted = result.newText.slice(3, -3);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for highlight markup', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '{==', '==}');
          const extracted = result.newText.slice(3, -3);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for bold formatting', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '**', '**');
          const extracted = result.newText.slice(2, -2);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for italic formatting', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '_', '_');
          const extracted = result.newText.slice(1, -1);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for underline formatting', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '<u>', '</u>');
          const extracted = result.newText.slice(3, -4);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for inline code formatting', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '`', '`');
          const extracted = result.newText.slice(1, -1);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text for bold italic formatting', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '***', '***');
          const extracted = result.newText.slice(3, -3);
          return extracted === text;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 2: Substitution wrapping structure
  // Validates: Requirements 1.4
  describe('Property 2: Substitution wrapping structure', () => {
    it('should produce correct substitution structure with cursor positioned after ~>', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapSelection(text, '{~~', '~>~~}', 3 + text.length + 2);
          
          // Check structure: starts with {~~, contains original text, followed by ~>~~}
          const startsCorrectly = result.newText.startsWith('{~~');
          const endsCorrectly = result.newText.endsWith('~>~~}');
          const containsText = result.newText.slice(3, 3 + text.length) === text;
          const cursorAfterMarker = result.cursorOffset === 3 + text.length + 2;
          
          return startsCorrectly && endsCorrectly && containsText && cursorAfterMarker;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 3: Highlight and comment combination
  // Validates: Requirements 1.7
  describe('Property 3: Highlight and comment combination', () => {
    it('should wrap text in highlight and append comment with cursor positioned correctly', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = highlightAndComment(text);
          
          // Expected structure: {==<text>==}{>><<}
          const expectedHighlight = `{==${text}==}`;
          const expectedFull = expectedHighlight + '{>><<}';
          
          // Check structure matches
          const structureCorrect = result.newText === expectedFull;
          
          // Check cursor is positioned between >> and <<
          const expectedCursorPos = expectedHighlight.length + 3; // after {>>
          const cursorCorrect = result.cursorOffset === expectedCursorPos;
          
          return structureCorrect && cursorCorrect;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Property test for substitute and comment combination
  describe('Substitute and comment combination', () => {
    it('should wrap text in substitution and append comment with cursor positioned correctly', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = substituteAndComment(text);
          
          // Expected structure: {~~<text>~>~~}{>><<}
          const expectedSubstitution = `{~~${text}~>~~}`;
          const expectedFull = expectedSubstitution + '{>><<}';
          
          // Check structure matches
          const structureCorrect = result.newText === expectedFull;
          
          // Check cursor is positioned between >> and <<
          const expectedCursorPos = expectedSubstitution.length + 3; // after {>>
          const cursorCorrect = result.cursorOffset === expectedCursorPos;
          
          return structureCorrect && cursorCorrect;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Property test for addition and comment combination
  describe('Addition and comment combination', () => {
    it('should wrap text in addition and append comment with cursor positioned correctly', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = additionAndComment(text);
          
          // Expected structure: {++<text>++}{>><<}
          const expectedAddition = `{++${text}++}`;
          const expectedFull = expectedAddition + '{>><<}';
          
          // Check structure matches
          const structureCorrect = result.newText === expectedFull;
          
          // Check cursor is positioned between >> and <<
          const expectedCursorPos = expectedAddition.length + 3; // after {>>
          const cursorCorrect = result.cursorOffset === expectedCursorPos;
          
          return structureCorrect && cursorCorrect;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Property test for deletion and comment combination
  describe('Deletion and comment combination', () => {
    it('should wrap text in deletion and append comment with cursor positioned correctly', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = deletionAndComment(text);
          
          // Expected structure: {--<text>--}{>><<}
          const expectedDeletion = `{--${text}--}`;
          const expectedFull = expectedDeletion + '{>><<}';
          
          // Check structure matches
          const structureCorrect = result.newText === expectedFull;
          
          // Check cursor is positioned between >> and <<
          const expectedCursorPos = expectedDeletion.length + 3; // after {>>
          const cursorCorrect = result.cursorOffset === expectedCursorPos;
          
          return structureCorrect && cursorCorrect;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 4: Code block wrapping with newlines
  // Validates: Requirements 2.6
  describe('Property 4: Code block wrapping with newlines', () => {
    it('should wrap text with ``` on separate lines before and after', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = wrapCodeBlock(text);
          
          // Check that result starts with ``` followed by newline
          const startsCorrectly = result.newText.startsWith('```\n');
          
          // Check that result ends with newline followed by ```
          const endsCorrectly = result.newText.endsWith('\n```');
          
          // Check that the text is in between
          const extractedText = result.newText.slice(4, -4);
          
          return startsCorrectly && endsCorrectly && extractedText === text;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 5: Line prefixing applies to all lines
  // Validates: Requirements 3.2, 4.2
  describe('Property 5: Line prefixing applies to all lines', () => {
    it('should prefix every non-empty line with bullet marker', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 1 }),
          (lines) => {
            const text = lines.join('\n');
            const result = wrapLines(text, '- ');
            const resultLines = result.newText.split('\n');
            
            // Check that every non-empty line starts with '- '
            return resultLines.every((line, idx) => {
              if (lines[idx].trim() === '') {
                return line === lines[idx]; // Empty lines unchanged
              }
              return line.startsWith('- ') && line.slice(2) === lines[idx];
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should prefix every non-empty line with quote marker', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 1 }),
          (lines) => {
            const text = lines.join('\n');
            const result = wrapLines(text, '> ');
            const resultLines = result.newText.split('\n');
            
            // Check that every non-empty line starts with '> '
            return resultLines.every((line, idx) => {
              if (lines[idx].trim() === '') {
                return line === lines[idx]; // Empty lines unchanged
              }
              return line.startsWith('> ') && line.slice(2) === lines[idx];
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 6: Numbered list sequential numbering
  // Validates: Requirements 3.3
  describe('Property 6: Numbered list sequential numbering', () => {
    it('should number each non-empty line sequentially starting from 1', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
          (lines) => {
            const text = lines.join('\n');
            const result = wrapLinesNumbered(text);
            const resultLines = result.newText.split('\n');
            
            let expectedNumber = 1;
            return resultLines.every((line, idx) => {
              if (lines[idx].trim() === '') {
                return line === lines[idx]; // Empty lines unchanged
              }
              const expectedPrefix = `${expectedNumber}. `;
              const hasCorrectPrefix = line.startsWith(expectedPrefix);
              const hasCorrectContent = line.slice(expectedPrefix.length) === lines[idx];
              expectedNumber++;
              return hasCorrectPrefix && hasCorrectContent;
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 7: Quote block idempotence
  // Validates: Requirements 4.3
  describe('Property 7: Quote block idempotence', () => {
    it('should produce the same result when applied twice (no double prefixes)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 1 }),
          (lines) => {
            const text = lines.join('\n');
            const firstApplication = wrapLines(text, '> ', true);
            const secondApplication = wrapLines(firstApplication.newText, '> ', true);
            
            // Applying twice should give the same result as applying once
            return firstApplication.newText === secondApplication.newText;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 8: Multi-paragraph line independence
  // Validates: Requirements 6.4
  describe('Property 8: Multi-paragraph line independence', () => {
    it('should transform each non-empty line independently without affecting blank lines', () => {
      fc.assert(
        fc.property(
          fc.array(fc.oneof(fc.string(), fc.constant('')), { minLength: 1 }),
          (lines) => {
            const text = lines.join('\n');
            const result = wrapLines(text, '- ');
            const resultLines = result.newText.split('\n');
            
            // Check that blank lines remain unchanged and non-empty lines are transformed
            return resultLines.every((line, idx) => {
              if (lines[idx].trim() === '') {
                return line === lines[idx]; // Blank lines unchanged
              }
              return line === '- ' + lines[idx]; // Non-empty lines prefixed
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: markdown-context-menu, Property 9: Heading level replacement
  // Validates: Requirements 2.9
  describe('Property 9: Heading level replacement', () => {
    it('should remove existing heading indicators and prepend exactly N # characters followed by a space for heading level N', () => {
      fc.assert(
        fc.property(
          fc.string().filter(s => !s.split('\n').some(l => /^#+\s/.test(l))),
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 0, max: 6 }), // existing heading level (0 means no heading)
          (baseText, newLevel, existingLevel) => {
            // Create text with or without existing heading
            const text = existingLevel > 0 
              ? '#'.repeat(existingLevel) + ' ' + baseText 
              : baseText;
            
            const result = formatHeading(text, newLevel);
            const expectedPrefix = '#'.repeat(newLevel) + ' ';
            
            // Check that result starts with correct number of # followed by space
            const hasCorrectPrefix = result.newText.startsWith(expectedPrefix);
            
            // Check that the base text (without any heading indicators) follows the prefix
            const hasCorrectContent = result.newText.slice(expectedPrefix.length) === baseText;
            
            // Ensure no double heading indicators
            const afterPrefix = result.newText.slice(expectedPrefix.length);
            const noDoubleHeading = !afterPrefix.match(/^#+\s/);
            
            return hasCorrectPrefix && hasCorrectContent && noDoubleHeading;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: author-name-in-comments, Property 1: Comment format with author name
  // Validates: Requirements 1.2
  describe('Property 1: Comment format with author name', () => {
    it('should format comment with author name in the format {>>@Username | <<} and position cursor correctly', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (username) => {
          const result = wrapSelection('', '{>>', '<<}', 3, username);
          const trimmed = username.trim();

          if (!trimmed) {
            // Whitespace-only names are treated as no author
            return result.newText === '{>><<}' && result.cursorOffset === 3;
          }

          // Expected format: {>>@Username | <<}
          const expectedText = `{>>@${trimmed} | <<}`;
          const structureCorrect = result.newText === expectedText;

          // Cursor should be positioned after "@Username | " (after the pipe and space)
          const expectedCursorPos = 3 + trimmed.length + 4; // 3 for '{>>', trimmed length, 4 for '@', ' ', '|', ' '
          const cursorCorrect = result.cursorOffset === expectedCursorPos;

          return structureCorrect && cursorCorrect;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: author-name-in-comments, Property 2: Highlight-and-comment format with author name
  // Validates: Requirements 1.4
  describe('Property 2: Highlight-and-comment format with author name', () => {
    it('should format highlight-and-comment with author name in the format {==text==}{>>@Username | <<} and position cursor correctly', () => {
      fc.assert(
        fc.property(fc.string(), fc.string({ minLength: 1 }), (text, username) => {
          const result = highlightAndComment(text, username);
          const trimmed = username.trim();

          if (!trimmed) {
            // Whitespace-only names are treated as no author
            const expectedText = `{==${text}==}{>><<}`;
            const highlightLength = `{==${text}==}`.length;
            return result.newText === expectedText && result.cursorOffset === highlightLength + 3;
          }

          // Expected format: {==text==}{>>@Username | <<}
          const expectedText = `{==${text}==}{>>@${trimmed} | <<}`;
          const structureCorrect = result.newText === expectedText;

          // Cursor should be positioned after "@Username | " in the comment section
          const highlightLength = `{==${text}==}`.length;
          const authorPrefixLen = trimmed.length + 4; // '@', ' ', '|', ' '
          const expectedCursorPos = highlightLength + 3 + authorPrefixLen;
          const cursorCorrect = result.cursorOffset === expectedCursorPos;

          return structureCorrect && cursorCorrect;
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: author-name-in-comments, Property 4: Special characters preservation
  // Validates: Requirements 3.3
  describe('Property 4: Special characters preservation', () => {
    it('should preserve special characters in username without modification or escaping', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            // Generate usernames with various special characters
            fc.string({ minLength: 1 }).map(s => s + '@'),
            fc.string({ minLength: 1 }).map(s => s + ':'),
            fc.string({ minLength: 1 }).map(s => s + '{'),
            fc.string({ minLength: 1 }).map(s => s + '}'),
            fc.string({ minLength: 1 }).map(s => s + '<'),
            fc.string({ minLength: 1 }).map(s => s + '>'),
            fc.string({ minLength: 1 }).map(s => s + ' '),
            fc.string({ minLength: 1 }).map(s => s + '🎉'), // Unicode emoji
            fc.string({ minLength: 1 }).map(s => s + 'é'), // Unicode accented character
            fc.string({ minLength: 1 }) // Regular strings
          ),
          (username) => {
            const result = wrapSelection('', '{>>', '<<}', 3, username);
            const trimmed = username.trim();

            if (!trimmed) {
              // Whitespace-only names are treated as no author
              return result.newText === '{>><<}';
            }

            // The trimmed username should appear in the output
            const expectedText = `{>>@${trimmed} | <<}`;
            const structureCorrect = result.newText === expectedText;

            return structureCorrect;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

describe('grid table support for Expand Table and Compact Table', () => {
  it('reflowTable expands Pandoc-style grid tables while preserving separator style', () => {
    const input = [
      '+-------+----+',
      '| Name | Age |',
      '+=======+====+',
      '| Al | 9 |',
      '+-------+----+',
      '| Beatrice | 10 |',
      '+-------+----+',
    ].join('\n');

    const result = reflowTable(input);
    const expected = [
      '+----------+-----+',
      '| Name     | Age |',
      '+==========+=====+',
      '| Al       | 9   |',
      '+----------+-----+',
      '| Beatrice | 10  |',
      '+----------+-----+',
    ].join('\n');

    if (result.newText !== expected) {
      throw new Error('Expected:\n' + expected + '\n\nGot:\n' + result.newText);
    }
  });

  it('compactTable compacts Pandoc-style grid tables while preserving separator style', () => {
    const input = [
      '+------------+-------+',
      '| Name       | Age   |',
      '+============+=======+',
      '| Alice      | 30    |',
      '+------------+-------+',
      '| Bob        | 7     |',
      '+------------+-------+',
    ].join('\n');

    const result = compactTable(input);
    const expected = [
      '+-------+-----+',
      '| Name  | Age |',
      '+=======+=====+',
      '| Alice | 30  |',
      '+-------+-----+',
      '| Bob   | 7   |',
      '+-------+-----+',
    ].join('\n');

    if (result.newText !== expected) {
      throw new Error('Expected:\n' + expected + '\n\nGot:\n' + result.newText);
    }
  });
});

describe('Formatting Module Unit Tests - Author Name Edge Cases', () => {
  // Test comment insertion with null author name
  it('should insert comment without author prefix when author name is null', () => {
    const result = wrapSelection('', '{>>', '<<}', 3, null);
    const expected = '{>><<}';
    
    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }
    if (result.cursorOffset !== 3) {
      throw new Error(`Expected cursor offset 3 but got ${result.cursorOffset}`);
    }
  });

  // Test comment insertion with undefined author name
  it('should insert comment without author prefix when author name is undefined', () => {
    const result = wrapSelection('', '{>>', '<<}', 3, undefined);
    const expected = '{>><<}';
    
    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }
    if (result.cursorOffset !== 3) {
      throw new Error(`Expected cursor offset 3 but got ${result.cursorOffset}`);
    }
  });

  // Test highlight-and-comment with empty selection
  it('should handle highlight-and-comment with empty selection', () => {
    const result = highlightAndComment('', 'TestUser');
    const expected = '{====}{>>@TestUser | <<}';

    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }

    // Cursor should be after the author prefix in the comment
    const expectedCursorPos = '{====}{>>@TestUser | '.length;
    if (result.cursorOffset !== expectedCursorPos) {
      throw new Error(`Expected cursor offset ${expectedCursorPos} but got ${result.cursorOffset}`);
    }
  });

  // Test cursor positioning with author name
  it('should position cursor correctly with author name', () => {
    const result = wrapSelection('', '{>>', '<<}', 3, 'Alice');
    const expected = '{>>@Alice | <<}';

    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }

    // Cursor should be after "@Alice | "
    const expectedCursorPos = '{>>@Alice | '.length;
    if (result.cursorOffset !== expectedCursorPos) {
      throw new Error(`Expected cursor offset ${expectedCursorPos} but got ${result.cursorOffset}`);
    }
  });

  // Test cursor positioning without author name
  it('should position cursor correctly without author name', () => {
    const result = wrapSelection('', '{>>', '<<}', 3, null);
    const expected = '{>><<}';
    
    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }
    
    // Cursor should be between >> and <<
    if (result.cursorOffset !== 3) {
      throw new Error(`Expected cursor offset 3 but got ${result.cursorOffset}`);
    }
  });

  // Test highlight-and-comment without author name
  it('should handle highlight-and-comment without author name', () => {
    const result = highlightAndComment('test text', null);
    const expected = '{==test text==}{>><<}';
    
    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }
    
    // Cursor should be between >> and <<
    const expectedCursorPos = '{==test text==}{>>'.length;
    if (result.cursorOffset !== expectedCursorPos) {
      throw new Error(`Expected cursor offset ${expectedCursorPos} but got ${result.cursorOffset}`);
    }
  });
});
        
  


// Feature: markdown-table-reflow, Property 1: Content preservation through reflow
// Validates: Requirements 1.4
describe('Property 1: Content preservation through reflow', () => {
  it('should preserve all cell contents exactly when reflowing a table', () => {
    // Generator for table cell content (non-empty strings without pipes)
    const cellContentArb = fc.string({ minLength: 1, maxLength: 20 })
      .filter(s => !s.includes('|') && !s.includes('\n'));
    
    // Generator for a table row (array of cells)
    const tableRowArb = fc.array(cellContentArb, { minLength: 1, maxLength: 5 });
    
    // Generator for a complete table (array of rows with consistent column count)
    const tableArb = fc.integer({ min: 2, max: 6 }).chain(numRows => {
      return fc.integer({ min: 1, max: 5 }).chain(numCols => {
        return fc.array(
          fc.array(cellContentArb, { minLength: numCols, maxLength: numCols }),
          { minLength: numRows, maxLength: numRows }
        );
      });
    });
    
    fc.assert(
      fc.property(tableArb, (rows) => {
        // Build a markdown table from the rows
        const tableText = rows.map(row => '| ' + row.join(' | ') + ' |').join('\n');
        
        // Reflow the table
        const result = reflowTable(tableText);
        
        // Parse both original and reflowed tables to extract cell contents
        const originalParsed = parseTable(tableText);
        const reflowedParsed = parseTable(result.newText);
        
        if (!originalParsed || !reflowedParsed) {
          return false;
        }
        
        // Extract all cell contents from both tables
        const originalCells = originalParsed.rows
          .filter(row => !row.isSeparator)
          .flatMap(row => row.cells);
        
        const reflowedCells = reflowedParsed.rows
          .filter(row => !row.isSeparator)
          .flatMap(row => row.cells);
        
        // Check that all cell contents are preserved
        if (originalCells.length !== reflowedCells.length) {
          return false;
        }
        
        return originalCells.every((cell, i) => cell === reflowedCells[i]);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: markdown-table-reflow, Property 2: Separator row preservation
// Validates: Requirements 1.5
describe('Property 2: Separator row preservation', () => {
  it('should maintain a valid separator row in the same position with appropriate hyphen padding', () => {
    // Generator for table cell content (strings without pipes or newlines)
    const cellContentArb = fc.string({ minLength: 0, maxLength: 20 })
      .filter(s => !s.includes('|') && !s.includes('\n'));
    
    // Generator for a table with a header row, separator, and data rows
    const tableWithSeparatorArb = fc.integer({ min: 1, max: 5 }).chain(numCols => {
      return fc.integer({ min: 1, max: 5 }).chain(numDataRows => {
        // Generate header row
        const headerArb = fc.array(cellContentArb, { minLength: numCols, maxLength: numCols });
        // Generate data rows
        const dataRowsArb = fc.array(
          fc.array(cellContentArb, { minLength: numCols, maxLength: numCols }),
          { minLength: numDataRows, maxLength: numDataRows }
        );
        
        return fc.tuple(headerArb, dataRowsArb).map(([header, dataRows]) => {
          return { header, dataRows, numCols };
        });
      });
    });
    
    fc.assert(
      fc.property(tableWithSeparatorArb, ({ header, dataRows, numCols }) => {
        // Build a markdown table with header, separator, and data rows
        const headerLine = '| ' + header.join(' | ') + ' |';
        const separatorLine = '| ' + Array(numCols).fill('---').join(' | ') + ' |';
        const dataLines = dataRows.map(row => '| ' + row.join(' | ') + ' |');
        const tableText = [headerLine, separatorLine, ...dataLines].join('\n');
        
        // Reflow the table
        const result = reflowTable(tableText);
        
        // Parse the reflowed table
        const parsed = parseTable(result.newText);
        if (!parsed) {
          return false;
        }
        
        // Check that there's exactly one separator row
        const separatorRows = parsed.rows.filter(row => row.isSeparator);
        if (separatorRows.length !== 1) {
          return false;
        }
        
        // Check that the separator is in the second position (index 1)
        if (!parsed.rows[1].isSeparator) {
          return false;
        }
        
        // Check that the separator row has the correct number of cells
        const separatorRow = parsed.rows[1];
        if (separatorRow.cells.length !== numCols) {
          return false;
        }
        
        // Check that each cell in the separator row contains only hyphens
        // and has the appropriate width (at least 3 hyphens for standard markdown)
        for (let i = 0; i < separatorRow.cells.length; i++) {
          const cell = separatorRow.cells[i];
          // Cell should contain only hyphens
          if (!/^-+$/.test(cell)) {
            return false;
          }
          // Cell should have at least 3 hyphens (standard markdown)
          // or match the column width, whichever is greater
          const expectedWidth = Math.max(parsed.columnWidths[i], 3);
          if (cell.length !== expectedWidth) {
            return false;
          }
        }
        
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// Unit tests for table formatting
describe('Table Formatting Unit Tests', () => {
  it('should format a basic 2x2 table correctly', () => {
    const input = '| A | B |\n| C | D |';
    const result = reflowTable(input);
    const expected = '| A | B |\n| C | D |';
    
    if (result.newText !== expected) {
      throw new Error(`Expected:\n${expected}\n\nGot:\n${result.newText}`);
    }
  });

  it('should format a table with empty cells', () => {
    const input = '| A |  |\n|  | D |';
    const result = reflowTable(input);
    const expected = '| A |   |\n|   | D |';
    
    if (result.newText !== expected) {
      throw new Error(`Expected:\n${expected}\n\nGot:\n${result.newText}`);
    }
  });

  it('should format a table with varying column widths', () => {
    const input = '| Short | VeryLongContent |\n| X | Y |';
    const result = reflowTable(input);
    const expected = '| Short | VeryLongContent |\n| X     | Y               |';
    
    if (result.newText !== expected) {
      throw new Error(`Expected:\n${expected}\n\nGot:\n${result.newText}`);
    }
  });

  it('should handle malformed table (non-table input) gracefully', () => {
    const input = 'This is not a table';
    const result = reflowTable(input);
    
    // Should return original text unchanged
    if (result.newText !== input) {
      throw new Error(`Expected original text to be returned unchanged`);
    }
  });

  it('should format a table with header separator', () => {
    const input = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
    const result = reflowTable(input);
    const expected = '| Name  | Age |\n| ----- | --- |\n| Alice | 30  |\n| Bob   | 25  |';
    
    if (result.newText !== expected) {
      throw new Error(`Expected:\n${expected}\n\nGot:\n${result.newText}`);
    }
  });

  it('should handle tables with inconsistent column counts', () => {
    const input = '| A | B |\n| C | D | E |';
    const result = reflowTable(input);
    
    // Should still parse and format, treating missing cells as empty
    const parsed = parseTable(result.newText);
    if (!parsed) {
      throw new Error('Failed to parse reflowed table');
    }
    
    // Check that all rows have been formatted
    if (parsed.rows.length !== 2) {
      throw new Error(`Expected 2 rows, got ${parsed.rows.length}`);
    }
  });
});

// Feature: markdown-table-reflow, Property 4: Whitespace preservation within cells
// Validates: Requirements 3.4
describe('Property 4: Whitespace preservation within cells', () => {
  it('should preserve internal whitespace within cell content', () => {
    // Generator for cell content with internal spaces
    // We generate strings that have non-whitespace characters with spaces in between
    const cellWithInternalSpacesArb = fc.tuple(
      fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim().length > 0 && !s.includes('|') && !s.includes('\n')),
      fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim().length > 0 && !s.includes('|') && !s.includes('\n'))
    ).map(([a, b]) => a.trim() + ' ' + b.trim()); // Ensure there's a space in the middle
    
    // Generator for a table with cells containing internal spaces
    const tableArb = fc.integer({ min: 2, max: 4 }).chain(numRows => {
      return fc.integer({ min: 1, max: 3 }).chain(numCols => {
        return fc.array(
          fc.array(cellWithInternalSpacesArb, { minLength: numCols, maxLength: numCols }),
          { minLength: numRows, maxLength: numRows }
        );
      });
    });
    
    fc.assert(
      fc.property(tableArb, (rows) => {
        // Build a markdown table from the rows
        const tableText = rows.map(row => '| ' + row.join(' | ') + ' |').join('\n');
        
        // Reflow the table
        const result = reflowTable(tableText);
        
        // Parse both original and reflowed tables
        const originalParsed = parseTable(tableText);
        const reflowedParsed = parseTable(result.newText);
        
        if (!originalParsed || !reflowedParsed) {
          return false;
        }
        
        // Extract all cell contents from both tables
        const originalCells = originalParsed.rows
          .filter(row => !row.isSeparator)
          .flatMap(row => row.cells);
        
        const reflowedCells = reflowedParsed.rows
          .filter(row => !row.isSeparator)
          .flatMap(row => row.cells);
        
        // Check that all cell contents are preserved (including internal spaces)
        if (originalCells.length !== reflowedCells.length) {
          return false;
        }
        
        return originalCells.every((cell, i) => cell === reflowedCells[i]);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: markdown-table-reflow, Property 3: Column alignment consistency
// Validates: Requirements 1.3, 3.1, 3.2, 3.3, 3.5
describe('Property 3: Column alignment consistency', () => {
  it('should align all pipes vertically, pad cells to column width, and maintain single space between pipes and content', () => {
    // Generator for table cell content (strings without pipes or newlines)
    const cellContentArb = fc.string({ minLength: 0, maxLength: 20 })
      .filter(s => !s.includes('|') && !s.includes('\n'));
    
    // Generator for a complete table with consistent column count
    const tableArb = fc.integer({ min: 2, max: 6 }).chain(numRows => {
      return fc.integer({ min: 1, max: 5 }).chain(numCols => {
        return fc.array(
          fc.array(cellContentArb, { minLength: numCols, maxLength: numCols }),
          { minLength: numRows, maxLength: numRows }
        );
      });
    });
    
    fc.assert(
      fc.property(tableArb, (rows) => {
        // Build a markdown table from the rows
        const tableText = rows.map(row => '| ' + row.join(' | ') + ' |').join('\n');
        
        // Reflow the table
        const result = reflowTable(tableText);
        
        // Split into lines
        const lines = result.newText.split('\n');
        
        if (lines.length === 0) {
          return false;
        }
        
        // Check that all lines have the same pipe positions (vertical alignment)
        const pipePositions = lines.map(line => {
          const positions: number[] = [];
          for (let i = 0; i < line.length; i++) {
            if (line[i] === '|') {
              positions.push(i);
            }
          }
          return positions;
        });
        
        // All rows should have the same number of pipes
        const firstPipeCount = pipePositions[0].length;
        if (!pipePositions.every(positions => positions.length === firstPipeCount)) {
          return false;
        }
        
        // All pipes at the same column index should be at the same position (vertical alignment)
        for (let colIdx = 0; colIdx < firstPipeCount; colIdx++) {
          const firstPos = pipePositions[0][colIdx];
          if (!pipePositions.every(positions => positions[colIdx] === firstPos)) {
            return false;
          }
        }
        
        // Check that there's exactly one space between pipes and content
        for (const line of lines) {
          // Split by pipe and check each cell
          const parts = line.split('|').slice(1, -1); // Remove first and last empty parts
          for (const part of parts) {
            // Each part should start and end with exactly one space
            if (!part.startsWith(' ') || !part.endsWith(' ')) {
              return false;
            }
          }
        }
        
        // Check that cells are padded to match column width by examining the formatted output
        // Extract the column widths from the formatted table
        const parsed = parseTable(result.newText);
        if (!parsed) {
          return false;
        }
        
        // For each line, check that the content between pipes (excluding the single space padding)
        // has the correct width
        for (const line of lines) {
          const parts = line.split('|').slice(1, -1);
          for (let i = 0; i < parts.length; i++) {
            // Remove the single space padding from each side
            const contentWithPadding = parts[i].slice(1, -1);
            // The content (with padding) should have length equal to the column width
            const expectedWidth = parsed.columnWidths[i];
            if (contentWithPadding.length !== expectedWidth) {
              return false;
            }
          }
        }
        
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: markdown-table-reflow, Property 5: Column alignment preservation
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
describe('Property 5: Column alignment preservation', () => {
  it('should preserve alignment specifications for all column types when reflowing tables', () => {
    // Generator for column alignment
    const alignmentArb = fc.constantFrom<ColumnAlignment>('left', 'right', 'center', 'default');
    
    // Generator for table cell content (strings without pipes or newlines)
    const cellContentArb = fc.string({ minLength: 1, maxLength: 15 })
      .filter(s => !s.includes('|') && !s.includes('\n') && s.trim().length > 0);
    
    // Generator for a complete table with header, separator, and data rows
    const tableWithAlignmentArb = fc.integer({ min: 2, max: 5 }).chain(numCols => {
      return fc.tuple(
        // Header row
        fc.array(cellContentArb, { minLength: numCols, maxLength: numCols }),
        // Alignments for each column
        fc.array(alignmentArb, { minLength: numCols, maxLength: numCols }),
        // Data rows (1-4 rows)
        fc.integer({ min: 1, max: 4 }).chain(numRows =>
          fc.array(
            fc.array(cellContentArb, { minLength: numCols, maxLength: numCols }),
            { minLength: numRows, maxLength: numRows }
          )
        )
      );
    });
    
    fc.assert(
      fc.property(tableWithAlignmentArb, ([header, alignments, dataRows]) => {
        // Build separator row based on alignments
        const separatorCells = alignments.map(align => {
          switch (align) {
            case 'left': return ':---';
            case 'right': return '---:';
            case 'center': return ':---:';
            case 'default': return '---';
          }
        });
        
        // Build the markdown table
        const headerLine = '| ' + header.join(' | ') + ' |';
        const separatorLine = '| ' + separatorCells.join(' | ') + ' |';
        const dataLines = dataRows.map(row => '| ' + row.join(' | ') + ' |');
        const tableText = [headerLine, separatorLine, ...dataLines].join('\n');
        
        // Reflow the table
        const result = reflowTable(tableText);
        
        // Parse the reflowed table
        const parsed = parseTable(result.newText);
        if (!parsed) {
          return false;
        }
        
        // Check that all alignments are preserved
        if (parsed.alignments.length !== alignments.length) {
          return false;
        }
        
        for (let i = 0; i < alignments.length; i++) {
          if (parsed.alignments[i] !== alignments[i]) {
            return false;
          }
        }
        
        // Also verify that the separator row in the output contains the correct indicators
        const lines = result.newText.split('\n');
        if (lines.length < 2) {
          return false;
        }
        
        const outputSeparatorLine = lines[1];
        const outputSeparatorCells = outputSeparatorLine.split('|').slice(1, -1).map(c => c.trim());
        
        for (let i = 0; i < alignments.length; i++) {
          const cell = outputSeparatorCells[i];
          const expectedAlign = alignments[i];
          
          switch (expectedAlign) {
            case 'left':
              if (!cell.startsWith(':') || cell.endsWith(':')) {
                return false;
              }
              break;
            case 'right':
              if (cell.startsWith(':') || !cell.endsWith(':')) {
                return false;
              }
              break;
            case 'center':
              if (!cell.startsWith(':') || !cell.endsWith(':')) {
                return false;
              }
              break;
            case 'default':
              if (cell.includes(':')) {
                return false;
              }
              break;
          }
        }
        
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// Unit tests for alignment preservation
describe('Table Alignment Preservation Unit Tests', () => {
  it('should preserve left-aligned columns (:---)', () => {
    const input = '| Name | Age |\n| :--- | :--- |\n| Alice | 30 |\n| Bob | 25 |';
    const result = reflowTable(input);
    
    // Parse the result to check alignment
    const parsed = parseTable(result.newText);
    if (!parsed) {
      throw new Error('Failed to parse reflowed table');
    }
    
    // Check that alignments are preserved
    if (parsed.alignments[0] !== 'left' || parsed.alignments[1] !== 'left') {
      throw new Error(`Expected left alignment for both columns, got ${parsed.alignments[0]} and ${parsed.alignments[1]}`);
    }
    
    // Check that the separator row contains the alignment indicators
    const lines = result.newText.split('\n');
    const separatorLine = lines[1];
    if (!separatorLine.includes(':---')) {
      throw new Error(`Expected separator line to contain ':---' but got: ${separatorLine}`);
    }
  });

  it('should preserve right-aligned columns (---:)', () => {
    const input = '| Name | Age |\n| ---: | ---: |\n| Alice | 30 |\n| Bob | 25 |';
    const result = reflowTable(input);
    
    // Parse the result to check alignment
    const parsed = parseTable(result.newText);
    if (!parsed) {
      throw new Error('Failed to parse reflowed table');
    }
    
    // Check that alignments are preserved
    if (parsed.alignments[0] !== 'right' || parsed.alignments[1] !== 'right') {
      throw new Error(`Expected right alignment for both columns, got ${parsed.alignments[0]} and ${parsed.alignments[1]}`);
    }
    
    // Check that the separator row contains the alignment indicators
    const lines = result.newText.split('\n');
    const separatorLine = lines[1];
    if (!separatorLine.includes('---:')) {
      throw new Error(`Expected separator line to contain '---:' but got: ${separatorLine}`);
    }
  });

  it('should preserve center-aligned columns (:---:)', () => {
    const input = '| Name | Age |\n| :---: | :---: |\n| Alice | 30 |\n| Bob | 25 |';
    const result = reflowTable(input);
    
    // Parse the result to check alignment
    const parsed = parseTable(result.newText);
    if (!parsed) {
      throw new Error('Failed to parse reflowed table');
    }
    
    // Check that alignments are preserved
    if (parsed.alignments[0] !== 'center' || parsed.alignments[1] !== 'center') {
      throw new Error(`Expected center alignment for both columns, got ${parsed.alignments[0]} and ${parsed.alignments[1]}`);
    }
    
    // Check that the separator row contains the alignment indicators
    const lines = result.newText.split('\n');
    const separatorLine = lines[1];
    if (!separatorLine.includes(':---:')) {
      throw new Error(`Expected separator line to contain ':---:' but got: ${separatorLine}`);
    }
  });

  it('should preserve default alignment (---)', () => {
    const input = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
    const result = reflowTable(input);
    
    // Parse the result to check alignment
    const parsed = parseTable(result.newText);
    if (!parsed) {
      throw new Error('Failed to parse reflowed table');
    }
    
    // Check that alignments are preserved
    if (parsed.alignments[0] !== 'default' || parsed.alignments[1] !== 'default') {
      throw new Error(`Expected default alignment for both columns, got ${parsed.alignments[0]} and ${parsed.alignments[1]}`);
    }
    
    // Check that the separator row contains only hyphens (no colons)
    const lines = result.newText.split('\n');
    const separatorLine = lines[1];
    // Extract the separator cells
    const separatorCells = separatorLine.split('|').slice(1, -1).map(c => c.trim());
    for (const cell of separatorCells) {
      if (cell.includes(':')) {
        throw new Error(`Expected separator cells to not contain colons for default alignment, but got: ${cell}`);
      }
      if (!/^-+$/.test(cell)) {
        throw new Error(`Expected separator cells to contain only hyphens, but got: ${cell}`);
      }
    }
  });

  it('should preserve mixed alignments in a single table', () => {
    const input = '| Name | Age | Score | Status |\n| :--- | ---: | :---: | --- |\n| Alice | 30 | 95 | Active |\n| Bob | 25 | 87 | Inactive |';
    const result = reflowTable(input);
    
    // Parse the result to check alignment
    const parsed = parseTable(result.newText);
    if (!parsed) {
      throw new Error('Failed to parse reflowed table');
    }
    
    // Check that alignments are preserved correctly
    const expectedAlignments: ColumnAlignment[] = ['left', 'right', 'center', 'default'];
    for (let i = 0; i < expectedAlignments.length; i++) {
      if (parsed.alignments[i] !== expectedAlignments[i]) {
        throw new Error(`Expected alignment ${expectedAlignments[i]} for column ${i}, got ${parsed.alignments[i]}`);
      }
    }
    
    // Check that the separator row contains the correct alignment indicators
    const lines = result.newText.split('\n');
    const separatorLine = lines[1];
    const separatorCells = separatorLine.split('|').slice(1, -1).map(c => c.trim());
    
    // Check each cell for correct alignment indicator
    if (!separatorCells[0].startsWith(':') || separatorCells[0].endsWith(':')) {
      throw new Error(`Expected left alignment (:---) for column 0, got: ${separatorCells[0]}`);
    }
    if (separatorCells[1].startsWith(':') || !separatorCells[1].endsWith(':')) {
      throw new Error(`Expected right alignment (---:) for column 1, got: ${separatorCells[1]}`);
    }
    if (!separatorCells[2].startsWith(':') || !separatorCells[2].endsWith(':')) {
      throw new Error(`Expected center alignment (:---:) for column 2, got: ${separatorCells[2]}`);
    }
    if (separatorCells[3].includes(':')) {
      throw new Error(`Expected default alignment (---) for column 3, got: ${separatorCells[3]}`);
    }
  });
});

// Property 9: Highlight formatting command wraps with == delimiters
describe('Property 9: Highlight formatting command wraps with == delimiters', () => {
  it('should wrap non-empty text with == delimiters', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (text) => {
        const result = wrapSelection(text, '==', '==');
        return result.newText === '==' + text + '==';
      }),
      { numRuns: 100 }
    );
  });
});

describe('compactTable', () => {
  it('removes padding whitespace from a padded table', () => {
    const input = [
      '| Name   | Age |',
      '| ------ | --- |',
      '| Alice  | 30  |',
      '| Bob    | 7   |',
    ].join('\n');
    const result = compactTable(input);
    const expected = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 7 |',
    ].join('\n');
    if (result.newText !== expected) {
      throw new Error('Expected:\n' + expected + '\n\nGot:\n' + result.newText);
    }
  });

  it('preserves alignment indicators in compact form', () => {
    const input = [
      '| Left   | Center | Right  |',
      '| :----- | :----: | -----: |',
      '| a      | b      | c      |',
    ].join('\n');
    const result = compactTable(input);
    const lines = result.newText.split('\n');
    const sepCells = lines[1].split('|').slice(1, -1).map(c => c.trim());
    // Column 0 → left (:--- but NOT :---:)
    if (!sepCells[0].startsWith(':') || sepCells[0].endsWith(':'))
      throw new Error('Missing left alignment, got: ' + sepCells[0]);
    // Column 1 → center (:---:)
    if (!sepCells[1].startsWith(':') || !sepCells[1].endsWith(':'))
      throw new Error('Missing center alignment, got: ' + sepCells[1]);
    // Column 2 → right (---:)
    if (sepCells[2].startsWith(':') || !sepCells[2].endsWith(':'))
      throw new Error('Missing right alignment, got: ' + sepCells[2]);
  });

  it('preserves cell content through compaction', () => {
    const cellContentArb = fc.string({ minLength: 1, maxLength: 20 })
      .filter(s => !s.includes('|') && !s.includes('\n'));

    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }).chain(numRows =>
          fc.integer({ min: 1, max: 4 }).chain(numCols =>
            fc.array(
              fc.array(cellContentArb, { minLength: numCols, maxLength: numCols }),
              { minLength: numRows, maxLength: numRows }
            )
          )
        ),
        (rows) => {
          const tableText = rows.map(row => '| ' + row.join(' | ') + ' |').join('\n');
          const result = compactTable(tableText);
          const originalParsed = parseTable(tableText);
          const compactedParsed = parseTable(result.newText);
          if (!originalParsed || !compactedParsed) return false;
          const origCells = originalParsed.rows.filter(r => !r.isSeparator).flatMap(r => r.cells);
          const compCells = compactedParsed.rows.filter(r => !r.isSeparator).flatMap(r => r.cells);
          return origCells.length === compCells.length &&
            origCells.every((c, i) => c === compCells[i]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns original text for non-table input', () => {
    const text = 'not a table';
    const result = compactTable(text);
    if (result.newText !== text) throw new Error('Should return original text');
  });

  it('keeps empty cells compact with single-space separators', () => {
    const input = [
      '| H1 | H2 | H3 |',
      '| --- | --- | --- |',
      '| A | | C |',
    ].join('\n');
    const result = compactTable(input);
    if (!result.newText.includes('| A | | C |')) {
      throw new Error('Expected compact empty-cell row, got: ' + result.newText);
    }
    if (result.newText.includes('| A |  | C |')) {
      throw new Error('Should not add double-space empty cell padding: ' + result.newText);
    }
  });

  it('is the inverse of reflowTable (reflow then compact removes padding)', () => {
    const input = '| a | bb | ccc |\n| --- | --- | --- |\n| d | ee | fff |';
    const reflowed = reflowTable(input);
    const compacted = compactTable(reflowed.newText);
    if (compacted.newText !== input) throw new Error('compactTable(reflowTable(input)) should equal input, got: "' + compacted.newText + '"');
  });

  it('handles escaped pipes in cell content', () => {
    const input = [
      '| Header |',
      '| --- |',
      '| a\\|b |',
    ].join('\n');
    const parsed = parseTable(input);
    if (!parsed) throw new Error('Should parse table with escaped pipe');
    // The escaped pipe should be part of the cell, not a delimiter
    if (parsed.rows[2].cells.length !== 1)
      throw new Error('Expected 1 cell, got ' + parsed.rows[2].cells.length);
    if (parsed.rows[2].cells[0] !== 'a\\|b')
      throw new Error('Expected "a\\|b", got "' + parsed.rows[2].cells[0] + '"');

    // Compact should preserve escaped pipes
    const compacted = compactTable(input);
    if (!compacted.newText.includes('a\\|b'))
      throw new Error('Compacted table lost escaped pipe');
  });

  it('recognizes row ending with escaped pipe in last cell', () => {
    // | a | b\| has the trailing \| as content, not a closing delimiter,
    // but the row still has 2 unescaped pipes (opening + mid) so it's valid.
    if (!isTableRow('| a | b\\|')) throw new Error('Should recognize row with escaped trailing pipe');
  });

  it('splits on pipe after escaped backslash (\\\\|)', () => {
    // \\| means escaped backslash followed by unescaped pipe (delimiter)
    const input = [
      '| A | B |',
      '| --- | --- |',
      '| x\\\\ | y |',
    ].join('\n');
    const parsed = parseTable(input);
    if (!parsed) throw new Error('Should parse table');
    if (parsed.rows[2].cells.length !== 2)
      throw new Error('Expected 2 cells, got ' + parsed.rows[2].cells.length);
  });
});

describe('HTML table support for Expand/Compact Table', () => {
  it('mixed text + HTML table selection remains unchanged', () => {
    const html = '<table><tr><th>Name</th></tr><tr><td>Alice</td></tr></table>';
    const mixed = 'Intro\n' + html + '\nOutro';
    const reflowed = reflowTable(mixed);
    const compacted = compactTable(mixed);
    if (reflowed.newText !== mixed) throw new Error('Expected reflowTable to preserve mixed selection');
    if (compacted.newText !== mixed) throw new Error('Expected compactTable to preserve mixed selection');
  });
  it('finds table-specific cursor ranges without adjacent prose', () => {
    const cases = [
      {
        text: 'Intro prose\n| A | B |\n| --- | --- |\n| 1 | 2 |\nOutro prose',
        cursor: '1 | 2',
        expected: '| A | B |\n| --- | --- |\n| 1 | 2 |',
      },
      {
        text: 'Intro\n+---+\n| H |\n+===+\n\n| long body |\n+----------------+\nOutro',
        cursor: 'long body',
        expected: '+---+\n| H |\n+===+\n\n| long body |\n+----------------+',
      },
      {
        text: 'Intro\n<table>\n<tr><th>H</th></tr>\n\n<tr><td>A</td></tr>\n</table>\nOutro',
        cursor: '<td>A',
        expected: '<table>\n<tr><th>H</th></tr>\n\n<tr><td>A</td></tr>\n</table>',
      },
    ];
    for (const { text, cursor, expected } of cases) {
      const range = findTableRangeAtOffset(text, text.indexOf(cursor));
      if (!range || text.slice(range.start, range.end) !== expected) {
        throw new Error('Unexpected table range for ' + cursor + ': ' + JSON.stringify(range));
      }
    }
    for (const { text, cursor } of [
      {
        text: '| H |\n| --- |\n| `code` |',
        cursor: 'H',
      },
      {
        text: '<table><tr><th>H</th></tr><tr><td>`code`</td></tr></table>',
        cursor: '<th>H',
      },
    ]) {
      const range = findTableRangeAtOffset(text, text.indexOf(cursor));
      if (!range || text.slice(range.start, range.end) !== text) {
        throw new Error('Inline code inside a table must not hide its range');
      }
    }
    const fenced = '```md\n| A |\n| --- |\n```';
    if (findTableRangeAtOffset(fenced, fenced.indexOf('| A |'))) {
      throw new Error('Fenced table text must not be selected');
    }
  });

  it('handles adjacent tables, boundaries, nesting, and CRLF ranges', () => {
    const firstGrid = '+---+\n| A |\n+---+';
    const secondGrid = '+---+\n| B |\n+---+';
    const adjacent = firstGrid + '\n\n' + secondGrid;
    for (const { cursor, expected } of [
      { cursor: adjacent.indexOf('| A |'), expected: firstGrid },
      { cursor: adjacent.indexOf('| B |'), expected: secondGrid },
    ]) {
      const range = findTableRangeAtOffset(adjacent, cursor);
      if (!range || adjacent.slice(range.start, range.end) !== expected) {
        throw new Error('Adjacent grid table range crossed a boundary');
      }
    }
    if (findTableRangeAtOffset(adjacent, firstGrid.length + 1)) {
      throw new Error('Blank line between grid tables must not select either table');
    }

    const pipe = '| A |\n| --- |\n| 1 |';
    const pipeAtEnd = findTableRangeAtOffset(pipe, pipe.length);
    if (!pipeAtEnd || pipe.slice(pipeAtEnd.start, pipeAtEnd.end) !== pipe) {
      throw new Error('Cursor at table line end should select the table');
    }

    const html = '<table><tr><td>A</td></tr></table>';
    const followed = html + 'after';
    if (findTableRangeAtOffset(followed, html.length)) {
      throw new Error('Cursor after an inline HTML table must not select it');
    }

    const nested = '<table><tr><td>before'
      + '<table><tr><td>inner</td></tr></table>'
      + 'after</td></tr></table>';
    const nestedRange = findTableRangeAtOffset(nested, nested.indexOf('inner'));
    if (!nestedRange || nested.slice(nestedRange.start, nestedRange.end) !== nested) {
      throw new Error('Nested HTML table cursor should select the complete outer table');
    }

    const crlf = 'Intro\r\n| A |\r\n| --- |\r\n| 1 |\r\nOutro';
    const crlfExpected = '| A |\r\n| --- |\r\n| 1 |';
    const crlfRange = findTableRangeAtOffset(crlf, crlf.indexOf('| 1 |'));
    if (!crlfRange || crlf.slice(crlfRange.start, crlfRange.end) !== crlfExpected) {
      throw new Error('CRLF table range did not preserve source boundaries');
    }
  });

  it('simple HTML → expanded pipe table', () => {
    const html = '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('| Name')) throw new Error('Expected pipe table header, got: ' + result.newText);
    if (!result.newText.includes('| Alice')) throw new Error('Expected pipe table body');
    // Should have separator
    if (!result.newText.includes('---')) throw new Error('Expected separator row');
    // Should be padded
    if (!result.newText.includes('| Name  |')) throw new Error('Expected padded header, got: ' + result.newText);
  });

  it('simple HTML → compact pipe table', () => {
    const html = '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>';
    const result = compactTable(html);
    if (!result.newText.includes('| Name |')) throw new Error('Expected compact header');
    if (!result.newText.includes('| --- |')) throw new Error('Expected minimal separator');
  });

  it('uses one grid header boundary for multiple leading HTML header rows', () => {
    const html = '<table>'
      + '<tr><th>Header 1</th></tr>'
      + '<tr><th>Header 2</th></tr>'
      + '<tr><td>Body 1</td></tr>'
      + '<tr><th>Later header tag</th></tr>'
      + '<tr><td>Body 2</td></tr>'
      + '</table>';
    for (const transform of [reflowTable, compactTable]) {
      const result = transform(html).newText;
      if (!result.startsWith('+') || !result.includes('+======')) {
        throw new Error('Expected one grid table with a header boundary, got: ' + result);
      }
      for (const value of [
        'Header 1', 'Header 2', 'Body 1', 'Later header tag', 'Body 2',
      ]) {
        if (!result.includes(value)) {
          throw new Error('Missing ' + value + ' from grid table: ' + result);
        }
      }

      const preprocessed = preprocessGridTables(result);
      const encoded = /<!-- MANUSCRIPT_GRID_TABLE:([^ ]+) -->/.exec(preprocessed)?.[1];
      if (!encoded) throw new Error('Generated grid table did not preprocess: ' + result);
      const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString()) as {
        rows: Array<{ header: boolean }>;
      };
      const headerFlags = parsed.rows.map(row => row.header);
      if (JSON.stringify(headerFlags) !== JSON.stringify([
        true, true, false, false, false,
      ])) {
        throw new Error('Later header tag changed grid header flags: ' + headerFlags);
      }
    }
  });

  it('ignores structural closers inside raw text and comments', () => {
    const html = '<table><tr><th>H</th></tr><tr><td>'
      + '<script>"</td></tr></table>"</script>'
      + '<!-- </td></tr></table> -->after'
      + '</td></tr></table>';
    for (const transform of [reflowTable, compactTable]) {
      const result = transform(html).newText;
      if (!result.includes('"&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;"after')) {
        throw new Error('Expected full structurally scanned cell, got: ' + result);
      }
    }
  });

  it('escapes entity-authored citation and angle syntax on output', () => {
    const html = '<table><tr><th>H</th></tr><tr>'
      + '<td>&#64;smith</td>'
      + '<td>[@jones, &lt;em&gt;x&lt;/em&gt;]</td>'
      + '</tr></table>';
    for (const transform of [reflowTable, compactTable]) {
      const result = transform(html).newText;
      if (!result.includes('\\@smith')) {
        throw new Error('Expected entity-authored @ to stay escaped, got: ' + result);
      }
      if (!result.includes('[@jones, &lt;em&gt;x&lt;/em&gt;]')) {
        throw new Error('Expected entity-authored angles to stay literal, got: ' + result);
      }
      if (result.includes('[@smith]') || result.includes('<em>x</em>')) {
        throw new Error('Entity-authored syntax became active: ' + result);
      }
    }
  });

  it('keeps GFM-disallowed raw HTML text literal during formatting', () => {
    const rawText = '<em>@hidden</em><!-- note -->';
    const expected = '&lt;em&gt;\\@hidden&lt;/em&gt;&lt;!-- note --&gt;';
    for (const tag of [
      'title', 'textarea', 'style', 'xmp', 'iframe',
      'noembed', 'noframes', 'script', 'plaintext',
    ]) {
      const html = '<table><tr><th>H</th></tr><tr><td><' + tag + '>'
        + rawText + '</' + tag + '></td></tr></table>';
      for (const transform of [reflowTable, compactTable]) {
        const result = transform(html).newText;
        if (scanCitationDocument(result).usages.length > 0) {
          throw new Error('Raw HTML text became a citation: ' + result);
        }
        if (!result.includes(expected)) {
          throw new Error('Expected raw HTML syntax to stay literal, got: ' + result);
        }
        if (result.includes('<em>') || result.includes('<!-- note -->')) {
          throw new Error('Raw HTML text became active markup: ' + result);
        }
      }
    }
  });

  it('keeps entity-derived at-signs literal across backslash parity', () => {
    for (let backslashes = 0; backslashes <= 3; backslashes++) {
      const html = '<table><tr><th>H</th></tr><tr><td>'
        + '\\'.repeat(backslashes) + '&#64;hidden</td></tr></table>';
      const expected = '\\'.repeat(backslashes * 2 + 1) + '@hidden';
      for (const transform of [reflowTable, compactTable]) {
        const result = transform(html).newText;
        if (!result.includes(expected)) {
          throw new Error('Expected literal backslash parity ' + expected + ', got: ' + result);
        }
        if (scanCitationDocument(result).usages.length > 0) {
          throw new Error('Entity-authored @ became a citation: ' + result);
        }
      }
    }
  });

  it('keeps data-embed-idx cells citation-literal during formatting', () => {
    const html = '<table data-embed-idx="0"><tr><th>H</th></tr>'
      + '<tr><td>@smith [@jones]</td></tr></table>';
    for (const transform of [reflowTable, compactTable]) {
      const result = transform(html).newText;
      if (!result.includes('\\@smith [\\@jones]')) {
        throw new Error('Expected embedded citations to stay escaped, got: ' + result);
      }
    }
  });

  it('HTML citations retain narrative, bracketed, and suppress-author syntax', () => {
    const html = '<table><tr><th>Citations</th></tr><tr><td>@alpha [@beta] [-@gamma]</td></tr></table>';
    for (const transform of [reflowTable, compactTable]) {
      const result = transform(html);
      for (const citation of ['@alpha', '[@beta]', '[-@gamma]']) {
        if (!result.newText.includes(citation)) {
          throw new Error('Expected ' + citation + ' in converted table, got: ' + result.newText);
        }
      }
    }
  });

  it('canonicalizes formatting boundaries inside atomic HTML citations', () => {
    const cases = [
      {
        html: '<table><tr><th>Citation</th></tr><tr><td><em>[@alpha</em>; @beta]</td></tr></table>',
        expected: '*[@alpha; @beta]*',
      },
      {
        html: '<table><tr><th>Citation</th></tr><tr><td>[@alpha; <em>@beta] inside</em></td></tr></table>',
        expected: '[@alpha; @beta]* inside*',
      },
      {
        html: '<table><tr><th>Citation</th></tr><tr><td>[<em>-@alpha</em>]</td></tr></table>',
        expected: '[-@alpha]',
      },
      {
        html: '<table><tr><th>Citation</th></tr><tr><td><em>before [@alpha] after</em></td></tr></table>',
        expected: '*before [@alpha] after*',
      },
      {
        html: '<table><tr><th>Citation</th></tr><tr><td>[@alpha&#59; @beta]</td></tr></table>',
        expected: '[@alpha; @beta]',
      },
      {
        html: '<table><tr><th>Citation</th></tr><tr><td><em>[@alpha; <em>@beta] inner</em> outer</em></td></tr></table>',
        expected: '*[@alpha; @beta] inner outer*',
      },
      {
        html: '<table><tr><th>Citation</th></tr><tr><td>[@smith, &lt;em&gt;x&lt;/em&gt;]</td></tr></table>',
        expected: '[@smith, &lt;em&gt;x&lt;/em&gt;]',
      },
    ];
    for (const transform of [reflowTable, compactTable]) {
      for (const { html, expected } of cases) {
        const result = transform(html);
        if (!result.newText.includes(expected)) {
          throw new Error('Expected ' + expected + ' in converted table, got: ' + result.newText);
        }
        if (result.newText.includes('<em>') || result.newText.includes('</em>')) {
          throw new Error('Expected internal citation tags to be canonicalized, got: ' + result.newText);
        }
      }
    }
  });

  it('HTML with bold, italic, code → markdown formatting in cells', () => {
    const html = '<table><tr><th>Col</th></tr><tr><td><b>bold</b> and <i>italic</i> and <code>code</code></td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('**bold**')) throw new Error('Expected bold markdown');
    if (!result.newText.includes('*italic*')) throw new Error('Expected italic markdown');
    if (!result.newText.includes('`code`')) throw new Error('Expected code markdown');
  });

  it('HTML code containing double backticks uses a longer fence', () => {
    const html = '<table><tr><th>Code</th></tr><tr><td><code>``test``</code></td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('``` ``test`` ```')) {
      throw new Error('Expected dynamic backtick fence, got: ' + result.newText);
    }
  });

  it('HTML with <a href> → [text](url) in cells', () => {
    const html = '<table><tr><th>Link</th></tr><tr><td><a href="https://example.com">click</a></td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('[click](https://example.com)')) throw new Error('Expected link markdown, got: ' + result.newText);
  });

  it('HTML with | in cell text → escaped \\| in pipe table', () => {
    const html = '<table><tr><th>Col</th></tr><tr><td>a|b</td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('a\\|b')) throw new Error('Expected escaped pipe, got: ' + result.newText);
  });

  it('HTML with backslash+pipe in cell text keeps one table cell', () => {
    const html = '<table><tr><th>Col</th></tr><tr><td>a\\|b</td></tr></table>';
    const result = reflowTable(html);
    const parsed = parseTable(result.newText);
    if (!parsed) throw new Error('Expected converted markdown table to parse');
    if (parsed.rows[2].cells.length !== 1) {
      throw new Error('Expected 1 body cell, got: ' + parsed.rows[2].cells.length + '\n' + result.newText);
    }
    if (parsed.rows[2].cells[0] !== 'a\\|b') {
      throw new Error('Expected preserved backslash+pipe content, got: ' + parsed.rows[2].cells[0]);
    }
  });

  it('HTML link URL containing | does not split table cells', () => {
    const html = '<table><tr><th>Col</th></tr><tr><td><a href=\"https://example.com/A|B\">x</a></td></tr></table>';
    const result = reflowTable(html);
    const parsed = parseTable(result.newText);
    if (!parsed) throw new Error('Expected converted markdown table to parse');
    if (parsed.rows[2].cells.length !== 1) {
      throw new Error('Expected 1 body cell, got: ' + parsed.rows[2].cells.length + '\n' + result.newText);
    }
    if (!result.newText.includes('[x](https://example.com/A\\|B)')) {
      throw new Error('Expected escaped pipe in URL, got: ' + result.newText);
    }
  });

  it('HTML with <p> multi-paragraph cells → grid table output', () => {
    const html = '<table><tr><th>Col</th></tr><tr><td><p>para1</p><p>para2</p></td></tr></table>';
    const result = reflowTable(html);
    // Grid tables use +---+ borders
    if (!/\+-+\+/.test(result.newText)) throw new Error('Expected grid table with +---+ borders, got: ' + result.newText);
    if (!result.newText.includes('para1')) throw new Error('Expected para1');
    if (!result.newText.includes('para2')) throw new Error('Expected para2');
  });

  it('HTML code-span with href preserves link', () => {
    const html = '<table><tr><th>Name</th></tr><tr><td><a href="https://example.com"><code>foo</code></a></td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('[`foo`](https://example.com)')) {
      throw new Error('Expected code-span link [`foo`](https://example.com), got: ' + result.newText);
    }
  });

  it('HTML code-span with href uses angle brackets for URLs with parens', () => {
    const html = '<table><tr><th>Name</th></tr><tr><td><a href="https://example.com/a(b)"><code>bar</code></a></td></tr></table>';
    const result = reflowTable(html);
    if (!result.newText.includes('[`bar`](<https://example.com/a(b)>)')) {
      throw new Error('Expected angle-bracket URL, got: ' + result.newText);
    }
  });

  it('grid table cells with pipes do not create phantom columns', () => {
    const html = '<table><tr><th>Col</th></tr><tr><td><p>a|b</p><p>c</p></td></tr></table>';
    const result = reflowTable(html);
    // The pipe in cell content must be escaped in grid output
    if (!result.newText.includes('\\|')) {
      throw new Error('Expected escaped pipe in grid table cell, got: ' + result.newText);
    }
    // Verify it's a grid table
    if (!/\+-+\+/.test(result.newText)) throw new Error('Expected grid table output');
  });

  it('mixed th/td row is treated as header', () => {
    const html = '<table><tr><th>Name</th><td>Value</td></tr><tr><td>a</td><td>b</td></tr></table>';
    const result = reflowTable(html);
    const lines = result.newText.split('\n');
    // First row (mixed th/td) should be header, so line[1] must be a separator
    if (!lines[1].includes('---')) {
      throw new Error('Expected separator after mixed th/td header row, got: ' + result.newText);
    }
  });

  it('HTML with colspan → returns original text unchanged', () => {
    const html = '<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>';
    const result = reflowTable(html);
    if (result.newText !== html) throw new Error('Expected original text for colspan table');
  });

  it('HTML with rowspan → returns original text unchanged', () => {
    const html = '<table><tr><td rowspan="2">tall</td><td>a</td></tr><tr><td>b</td></tr></table>';
    const result = compactTable(html);
    if (result.newText !== html) throw new Error('Expected original text for rowspan table');
  });

  it('non-HTML text → returns original text unchanged', () => {
    const plain = 'This is just some text without any tables.';
    const result = reflowTable(plain);
    if (result.newText !== plain) throw new Error('Expected original text for non-HTML');
  });

  it('HTML table with no <th> rows → first row treated as header', () => {
    const html = '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>';
    const result = reflowTable(html);
    // First row should be header, followed by separator
    const lines = result.newText.split('\n');
    if (!lines[0].includes('A')) throw new Error('Expected first row as header');
    if (!lines[1].includes('---')) throw new Error('Expected separator after header');
    if (!lines[2].includes('1')) throw new Error('Expected body row');
  });

  it('preserves source row order when a later row is header-tagged', () => {
    const html = '<table><tr><td>row1</td></tr><tr><th>row2h</th></tr><tr><td>row3</td></tr></table>';
    const result = reflowTable(html);
    const lines = result.newText.split('\n');
    if (!lines[0].includes('row1')) throw new Error('Expected first source row to remain first');
    if (!lines[2].includes('row2h')) throw new Error('Expected later header-tagged row to keep order');
    if (!lines[3].includes('row3')) throw new Error('Expected trailing row to keep order');
  });

  it('roundtrip: compactTable(reflowTable(htmlInput)) produces consistent output', () => {
    const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>bar</td></tr></table>';
    const expanded = reflowTable(html);
    const compacted = compactTable(expanded.newText);
    // Re-expanding the compacted result should match
    const reExpanded = reflowTable(compacted.newText);
    if (reExpanded.newText !== expanded.newText)
      throw new Error('Roundtrip inconsistent:\n' + expanded.newText + '\nvs\n' + reExpanded.newText);
  });
});
