import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { wrapSelection, wrapLines, wrapLinesNumbered, formatHeading, highlightAndComment, wrapCodeBlock, substituteAndComment, additionAndComment, deletionAndComment, reflowTable, parseTable } from './formatting';

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
          fc.string(),
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
    it('should format comment with author name in the format {>>@Username: <<} and position cursor correctly', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (username) => {
          const result = wrapSelection('', '{>>', '<<}', 3, username);
          
          // Expected format: {>>@Username: <<}
          const expectedText = `{>>@${username}: <<}`;
          const structureCorrect = result.newText === expectedText;
          
          // Cursor should be positioned after "@Username: " (after the colon and space)
          const expectedCursorPos = 3 + username.length + 3; // 3 for '{>>', username length, 3 for '@', ':', ' '
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
    it('should format highlight-and-comment with author name in the format {==text==}{>>@Username: <<} and position cursor correctly', () => {
      fc.assert(
        fc.property(fc.string(), fc.string({ minLength: 1 }), (text, username) => {
          const result = highlightAndComment(text, username);
          
          // Expected format: {==text==}{>>@Username: <<}
          const expectedText = `{==${text}==}{>>@${username}: <<}`;
          const structureCorrect = result.newText === expectedText;
          
          // Cursor should be positioned after "@Username: " in the comment section
          const highlightLength = `{==${text}==}`.length;
          const expectedCursorPos = highlightLength + 3 + username.length + 3; // highlight + '{>>' + '@' + username + ': '
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
            
            // The username should appear exactly as provided in the output
            const expectedText = `{>>@${username}: <<}`;
            const structureCorrect = result.newText === expectedText;
            
            // Verify the username is not escaped or modified
            const extractedUsername = result.newText.slice(4, 4 + username.length);
            const usernamePreserved = extractedUsername === username;
            
            return structureCorrect && usernamePreserved;
          }
        ),
        { numRuns: 100 }
      );
    });
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
    const expected = '{====}{>>@TestUser: <<}';
    
    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }
    
    // Cursor should be after the author prefix in the comment
    const expectedCursorPos = '{====}{>>@TestUser: '.length;
    if (result.cursorOffset !== expectedCursorPos) {
      throw new Error(`Expected cursor offset ${expectedCursorPos} but got ${result.cursorOffset}`);
    }
  });

  // Test cursor positioning with author name
  it('should position cursor correctly with author name', () => {
    const result = wrapSelection('', '{>>', '<<}', 3, 'Alice');
    const expected = '{>>@Alice: <<}';
    
    if (result.newText !== expected) {
      throw new Error(`Expected "${expected}" but got "${result.newText}"`);
    }
    
    // Cursor should be after "@Alice: "
    const expectedCursorPos = '{>>@Alice: '.length;
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
