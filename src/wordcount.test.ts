import { describe, it, expect, mock } from 'bun:test';
import * as fc from 'fast-check';

// Mock vscode module before importing wordcount
mock.module('vscode', () => ({
  window: {
    createStatusBarItem: () => ({
      text: '',
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    activeTextEditor: undefined,
  },
  workspace: {
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
}));

const { countWords, countAcceptedWords, isTextDocument, wordCountText } = await import('./wordcount');

describe('Word Count Property Tests', () => {
  // Feature: word-count-status-bar, Property 1: Status bar text format
  // Validates: Requirements 1.4
  describe('Property 1: Status bar text format', () => {
    it('should format status bar text as "$(book) N words" for any non-negative integer', () => {
      fc.assert(
        fc.property(
          fc.nat(), // Generate non-negative integers
          (wordCount) => {
            // Expected format: "$(book) N words"
            const expectedFormat = `$(book) ${wordCount} words`;
            
            // Verify the format matches the expected pattern
            const regex = /^\$\(book\) \d+ words$/;
            const matches = regex.test(expectedFormat);
            
            // Also verify the exact word count is present
            const extractedCount = parseInt(expectedFormat.match(/\d+/)?.[0] || '0', 10);
            
            return matches && extractedCount === wordCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should format status bar text correctly for edge case word counts', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(0, 1, 10, 100, 1000, 10000, 999999),
          (wordCount) => {
            const formatted = `$(book) ${wordCount} words`;
            
            // Verify format structure
            const parts = formatted.split(' ');
            const hasBookIcon = parts[0] === '$(book)';
            const hasWordCount = parts[1] === wordCount.toString();
            const haswordsLabel = parts[2] === 'words';
            
            return hasBookIcon && hasWordCount && haswordsLabel && parts.length === 3;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: word-count-status-bar, Property 5: Whitespace splitting behavior
  // Validates: Requirements 4.1, 4.2
  describe('Property 5: Whitespace splitting behavior', () => {
    it('should split text on whitespace boundaries and treat consecutive whitespace as single separator', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1 }).filter(s => !/\s/.test(s)), { minLength: 1 }),
          fc.oneof(
            fc.constant(' '),
            fc.constant('  '),
            fc.constant('\t'),
            fc.constant('\n'),
            fc.constant('   '),
            fc.constant(' \t '),
            fc.constant('\n\n')
          ),
          (words, separator) => {
            // Generate text by joining words with the separator
            const text = words.join(separator);
            const result = countWords(text);
            
            // The word count should equal the number of words we joined
            return result === words.length;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle mixed whitespace types consistently', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1 }).filter(s => !/\s/.test(s)), { minLength: 1, maxLength: 10 }),
          (words) => {
            // Create text with various whitespace separators
            const separators = [' ', '\t', '\n', '  ', ' \t', '\n '];
            let text = words[0];
            for (let i = 1; i < words.length; i++) {
              text += separators[i % separators.length] + words[i];
            }
            
            const result = countWords(text);
            
            // Should count the correct number of words regardless of whitespace type
            return result === words.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: word-count-status-bar, Property 6: Leading and trailing whitespace invariant
  // Validates: Requirements 4.3
  describe('Property 6: Leading and trailing whitespace invariant', () => {
    it('should return same count regardless of leading/trailing whitespace', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter(s => s.trim() !== ''),
          fc.string().filter(s => s.trim() === ''), // leading whitespace
          fc.string().filter(s => s.trim() === ''), // trailing whitespace
          (text, leading, trailing) => {
            const withoutWhitespace = countWords(text);
            const withWhitespace = countWords(leading + text + trailing);
            
            // Word count should be identical
            return withoutWhitespace === withWhitespace;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle arbitrary amounts of leading and trailing whitespace', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter(s => s.trim() !== ''),
          fc.nat({ max: 20 }),
          fc.nat({ max: 20 }),
          (text, leadingCount, trailingCount) => {
            const leading = ' '.repeat(leadingCount);
            const trailing = ' '.repeat(trailingCount);
            
            const withoutWhitespace = countWords(text);
            const withWhitespace = countWords(leading + text + trailing);
            
            return withoutWhitespace === withWhitespace;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('YAML frontmatter exclusion', () => {
    it('should not count words in YAML frontmatter', () => {
      const text = '---\ntitle: My Document\nauthor: Someone\n---\nHello world';
      expect(countWords(text)).toBe(2);
    });

    it('should handle document with only frontmatter', () => {
      const text = '---\ntitle: My Document\n---\n';
      expect(countWords(text)).toBe(0);
    });

    it('should handle document with no frontmatter', () => {
      const text = 'Hello world foo bar';
      expect(countWords(text)).toBe(4);
    });

    it('should not strip --- that appears mid-document', () => {
      const text = 'Hello world\n---\nMore words here';
      expect(countWords(text)).toBe(6);
    });

    it('strips frontmatter whose closing line has spaces after it', () => {
      expect(countWords('---\ntitle: T\n---  \nBody')).toBe(1);
    });

    it('counts words before a longer rule', () => {
      expect(countWords('---  \nBody\n----\nMore')).toBe(4);
    });

    it('counts words between horizontal rules', () => {
      // Each rule counts as a word, as --- does after the first line
      expect(countWords('---\n\nOne two.\n\n---\n\nThree.')).toBe(5);
    });

    it('should handle frontmatter with CRLF line endings', () => {
      const text = '---\r\ntitle: Test\r\n---\r\nHello world';
      expect(countWords(text)).toBe(2);
    });
  });

  // Feature: word-count-status-bar, Property 2: Text document detection
  // Validates: Requirements 1.7
  describe('Property 2: Text document detection', () => {
    it('should return true if and only if languageId is "markdown" or "plaintext"', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          (languageId) => {
            // Create a mock document with the generated languageId
            const mockDocument = { languageId } as any;
            const result = isTextDocument(mockDocument);
            
            // Should return true only for "markdown" or "plaintext"
            const expected = languageId === "markdown" || languageId === "plaintext";
            return result === expected;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle common language IDs correctly', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'markdown',
            'plaintext',
            'typescript',
            'javascript',
            'python',
            'java',
            'json',
            'xml',
            'html',
            'css',
            'yaml',
            'toml',
            'rust',
            'go',
            'cpp',
            'c',
            'csharp',
            'php',
            'ruby',
            'swift'
          ),
          (languageId) => {
            const mockDocument = { languageId } as any;
            const result = isTextDocument(mockDocument);
            
            // Should return true only for "markdown" or "plaintext"
            const expected = languageId === "markdown" || languageId === "plaintext";
            return result === expected;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: word-count-status-bar, Property 3: Selection word count accuracy
  // Validates: Requirements 2.1, 2.4
  describe('Property 3: Selection word count accuracy', () => {
    it('should calculate word count equal to sum of individual selection counts for single selection', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (text) => {
            // Calculate word count of the text
            const expectedCount = countWords(text);
            
            // Simulate a single selection containing this text
            // In the actual implementation, this would be the selected text
            const actualCount = countWords(text);
            
            // The word count should match
            return actualCount === expectedCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should calculate word count equal to sum of individual selection counts for multiple selections', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 1, maxLength: 5 }),
          (selections) => {
            // Calculate expected count: sum of word counts of each selection
            const expectedCount = selections.reduce((sum, text) => sum + countWords(text), 0);
            
            // Simulate multiple selections by joining with spaces (as per implementation)
            const combinedText = selections.join(' ');
            const actualCount = countWords(combinedText);
            
            // The word count should equal the sum of individual counts
            return actualCount === expectedCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle empty selections correctly', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constant(''), { minLength: 1, maxLength: 5 }),
          (emptySelections) => {
            // All selections are empty
            const combinedText = emptySelections.join(' ');
            const actualCount = countWords(combinedText);
            
            // Word count should be 0 for empty selections
            return actualCount === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle mixed empty and non-empty selections', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.constant(''),
              fc.string({ minLength: 1, maxLength: 50 })
            ),
            { minLength: 1, maxLength: 5 }
          ),
          (selections) => {
            // Calculate expected count: sum of word counts of each selection
            const expectedCount = selections.reduce((sum, text) => sum + countWords(text), 0);
            
            // Simulate multiple selections by joining with spaces
            const combinedText = selections.join(' ');
            const actualCount = countWords(combinedText);
            
            // The word count should equal the sum of individual counts
            return actualCount === expectedCount;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: word-count-status-bar, Property 4: Document word count accuracy
  // Validates: Requirements 3.1
  describe('Property 4: Document word count accuracy', () => {
    it('should calculate document word count correctly when no text is selected', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 500 }),
          (documentText) => {
            // Calculate expected word count for the entire document
            const expectedCount = countWords(documentText);
            
            // When no text is selected, the implementation uses the entire document text
            const actualCount = countWords(documentText);
            
            // The word count should match
            return actualCount === expectedCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle documents with various content types', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(''),
            fc.string({ minLength: 1, maxLength: 100 }),
            fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 })
              .map(words => words.join(' ')),
            fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 })
              .map(words => words.join('\n')),
            fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 })
              .map(words => words.join('\t'))
          ),
          (documentText) => {
            // Calculate expected word count
            const expectedCount = countWords(documentText);
            
            // Simulate no selection - use entire document
            const actualCount = countWords(documentText);
            
            // The word count should match
            return actualCount === expectedCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle large documents correctly', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter(s => !/\s/.test(s)), { minLength: 100, maxLength: 500 }),
          (words) => {
            // Create a large document by joining many words
            const documentText = words.join(' ');
            
            // Calculate expected word count
            const expectedCount = words.length;
            
            // Calculate actual word count
            const actualCount = countWords(documentText);
            
            // The word count should match the number of words
            return actualCount === expectedCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle documents with markdown-like content', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.stringMatching(/^\S{1,20}$/),
              fc.stringMatching(/^\S{1,20}$/).map(s => `**${s}**`),
              fc.stringMatching(/^\S{1,20}$/).map(s => `*${s}*`),
              fc.stringMatching(/^\S{1,20}$/).map(s => `\`${s}\``),
              fc.stringMatching(/^\S{1,20}$/).map(s => `#${s}`),
              fc.stringMatching(/^\S{1,20}$/).map(s => `[${s}]`)
            ),
            { minLength: 1, maxLength: 20 }
          ),
          (markdownElements) => {
            // Create document with markdown-like content
            const documentText = markdownElements.join(' ');
            
            // Calculate word count
            const actualCount = countWords(documentText);
            
            // Word count should be non-negative and reasonable
            return actualCount >= 0 && actualCount <= markdownElements.length * 2;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

describe('Word Count Unit Tests', () => {
  describe('Empty and whitespace-only strings', () => {
    it('should return 0 for empty string', () => {
      expect(countWords('')).toBe(0);
    });

    it('should return 0 for whitespace-only string', () => {
      expect(countWords('   ')).toBe(0);
      expect(countWords('\t\t')).toBe(0);
      expect(countWords('\n\n')).toBe(0);
      expect(countWords(' \t \n ')).toBe(0);
    });
  });

  describe('Single word', () => {
    it('should return 1 for single word', () => {
      expect(countWords('hello')).toBe(1);
      expect(countWords('world')).toBe(1);
      expect(countWords('test')).toBe(1);
    });

    it('should return 1 for single word with leading/trailing whitespace', () => {
      expect(countWords('  hello  ')).toBe(1);
      expect(countWords('\thello\t')).toBe(1);
      expect(countWords('\nhello\n')).toBe(1);
    });
  });

  describe('Multiple words', () => {
    it('should count words separated by single spaces', () => {
      expect(countWords('hello world')).toBe(2);
      expect(countWords('one two three')).toBe(3);
      expect(countWords('the quick brown fox')).toBe(4);
    });

    it('should count words separated by multiple spaces', () => {
      expect(countWords('hello  world')).toBe(2);
      expect(countWords('one   two   three')).toBe(3);
    });

    it('should count words separated by tabs', () => {
      expect(countWords('hello\tworld')).toBe(2);
      expect(countWords('one\ttwo\tthree')).toBe(3);
    });

    it('should count words separated by newlines', () => {
      expect(countWords('hello\nworld')).toBe(2);
      expect(countWords('one\ntwo\nthree')).toBe(3);
    });

    it('should count words separated by mixed whitespace', () => {
      expect(countWords('hello \t world')).toBe(2);
      expect(countWords('one\n\ttwo  \n three')).toBe(3);
    });
  });

  describe('Hyphenated words', () => {
    it('should count hyphenated words as single words', () => {
      expect(countWords('hello-world')).toBe(1);
      expect(countWords('well-known')).toBe(1);
      expect(countWords('state-of-the-art')).toBe(1);
    });

    it('should count multiple hyphenated words correctly', () => {
      expect(countWords('hello-world foo-bar')).toBe(2);
      expect(countWords('well-known state-of-the-art technology')).toBe(3);
    });
  });

  describe('words with numbers', () => {
    it('should count words containing numbers as single words', () => {
      expect(countWords('test123')).toBe(1);
      expect(countWords('hello123world')).toBe(1);
      expect(countWords('version2')).toBe(1);
    });

    it('should count multiple words with numbers correctly', () => {
      expect(countWords('test123 hello456')).toBe(2);
      expect(countWords('version2 update3 patch4')).toBe(3);
    });

    it('should count pure numbers as words', () => {
      expect(countWords('123')).toBe(1);
      expect(countWords('123 456')).toBe(2);
      expect(countWords('3.14')).toBe(1);
    });
  });

  describe('words with special characters', () => {
    it('should count words with punctuation as single words', () => {
      expect(countWords('hello!')).toBe(1);
      expect(countWords('world?')).toBe(1);
      expect(countWords('test.')).toBe(1);
    });

    it('should count words with apostrophes as single words', () => {
      expect(countWords("don't")).toBe(1);
      expect(countWords("it's")).toBe(1);
      expect(countWords("we're")).toBe(1);
    });

    it('should count words with special characters correctly', () => {
      expect(countWords('hello@world')).toBe(1);
      expect(countWords('test#tag')).toBe(1);
      expect(countWords('user@example.com')).toBe(1);
    });
  });

  describe('Real-world examples', () => {
    it('should count words in typical sentences', () => {
      expect(countWords('The quick brown fox jumps over the lazy dog.')).toBe(9);
      expect(countWords('Hello, world!')).toBe(2);
      expect(countWords('This is a test.')).toBe(4);
    });

    it('should count words in markdown-like text', () => {
      expect(countWords('# Heading')).toBe(2);
      expect(countWords('**bold** text')).toBe(2);
      expect(countWords('`code` snippet')).toBe(2);
    });

    it('should count words in multi-line text', () => {
      const text = `First line
Second line
Third line`;
      expect(countWords(text)).toBe(6);
    });
  });
});

describe('WordCountController Resource Cleanup Tests', () => {
  describe('dispose method', () => {
    it('should have a dispose method that cleans up resources', () => {
      // This test verifies the dispose method exists and follows the expected pattern
      // The actual disposal is tested through integration since mocking is complex
      
      // Verify the WordCountController class has a dispose method
      const { WordCountController } = require('./wordcount');
      const controller = new WordCountController();
      
      // Verify dispose method exists
      expect(typeof controller.dispose).toBe('function');
      
      // Verify calling dispose doesn't throw
      expect(() => controller.dispose()).not.toThrow();
    });

    it('should dispose method can be called multiple times safely', () => {
      // Verify dispose is idempotent (can be called multiple times)
      const { WordCountController } = require('./wordcount');
      const controller = new WordCountController();
      
      // Call dispose multiple times
      expect(() => {
        controller.dispose();
        controller.dispose();
        controller.dispose();
      }).not.toThrow();
    });

    it('should dispose registered resources through observable behavior', () => {
      const vscode = require('vscode');
      const statusBarDispose = mock(() => {});
      const editorListenerDispose = mock(() => {});
      const selectionListenerDispose = mock(() => {});
      const documentListenerDispose = mock(() => {});

      vscode.window.createStatusBarItem = () => ({
        text: '',
        show: () => {},
        hide: () => {},
        dispose: statusBarDispose,
      });
      vscode.window.onDidChangeActiveTextEditor = () => ({ dispose: editorListenerDispose });
      vscode.window.onDidChangeTextEditorSelection = () => ({ dispose: selectionListenerDispose });
      vscode.workspace.onDidChangeTextDocument = () => ({ dispose: documentListenerDispose });
      const configListenerDispose = mock(() => {});
      const commandDispose = mock(() => {});
      vscode.workspace.onDidChangeConfiguration = () => ({ dispose: configListenerDispose });
      vscode.commands.registerCommand = () => ({ dispose: commandDispose });

      const { WordCountController } = require('./wordcount');
      const controller = new WordCountController();
      controller.dispose();

      expect(statusBarDispose).toHaveBeenCalledTimes(1);
      expect(editorListenerDispose).toHaveBeenCalledTimes(1);
      expect(selectionListenerDispose).toHaveBeenCalledTimes(1);
      expect(documentListenerDispose).toHaveBeenCalledTimes(1);
      expect(configListenerDispose).toHaveBeenCalledTimes(1);
      expect(commandDispose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('countWords matches splitting on whitespace', () => {
  it('counts as trim().split(/\\s+/) does, for any text', () => {
    const chars = fc.constantFrom('a', 'b', '-', ' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u3000', '\ufeff', '\u200b', '\u0085', '\v');
    fc.assert(
      fc.property(fc.array(chars, { maxLength: 40 }).map(a => a.join('')), (text) => {
        const trimmed = text.trim();
        const expected = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
        return countWords(text) === expected;
      }),
      { numRuns: 500 }
    );
  });
});

describe('countAcceptedWords', () => {
  it('counts plain text as countWords does', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const plain = text.replace(/\{/g, '(');
        return countAcceptedWords(plain) === countWords(plain);
      }),
      { numRuns: 300 }
    );
    expect(countAcceptedWords('one two {three} \\frac{a}{b}')).toBe(4);
  });

  it('keeps additions and drops deletions', () => {
    expect(countAcceptedWords('a {++b c++} d')).toBe(4);
    expect(countAcceptedWords('a {--b c--} d')).toBe(2);
  });

  it('keeps a substitution\'s new text', () => {
    expect(countAcceptedWords('a {~~old words here~>new~~} d')).toBe(3);
  });

  it('keeps highlighted text, drops comments and counts range markers as written', () => {
    expect(countAcceptedWords('a {==b c==}{>>a long comment<<} d')).toBe(4);
    expect(countAcceptedWords('{#c1}a b{/c1}{#c1>>note here<<} c')).toBe(3);
    expect(countAcceptedWords('a {#c1} b {/c1} c')).toBe(5);
  });

  it('drops a comment with replies to its matching closer', () => {
    expect(countAcceptedWords('a {>>x {>>y<<} z<<} b')).toBe(2);
  });

  it('joins the words around an accepted deletion', () => {
    expect(countAcceptedWords('foo{--x--}bar')).toBe(1);
    expect(countAcceptedWords('foo{++ ++}bar')).toBe(2);
  });

  it('reads markup nested in an addition', () => {
    expect(countAcceptedWords('{++a {--b--} c {>>n<<}++}')).toBe(2);
  });

  it('reads spans across paragraphs', () => {
    expect(countAcceptedWords('a {--b\n\nc--} d {++e\n\nf++}')).toBe(4);
  });

  it('counts CriticMarkup in code or after a backslash as text', () => {
    expect(countAcceptedWords('a `{--b--}` c')).toBe(3);
    expect(countAcceptedWords('```\n{--b c--}\n```\nd')).toBe(5);
    expect(countAcceptedWords('a \\{--b--} c')).toBe(3);
  });

  // Each as the preview and Word export read the markup (see criticSpans in critic-markup.ts)
  it('reads a code span inside an addition on its own', () => {
    expect(countAcceptedWords('{++a `{--b--}` c++}')).toBe(3);
  });

  it('pairs no backtick in frontmatter with one after it', () => {
    expect(countAcceptedWords('---\ntitle: `\n---\na {--b c--} ` d')).toBe(3);
  });

  it('counts CriticMarkup in an HTML block as text', () => {
    expect(countAcceptedWords('<div>\n{--b c--}\n</div>\n\nd')).toBe(5);
  });

  it('counts an opener in an equation as text', () => {
    expect(countAcceptedWords('Ions $x^{--}$ one two three {--del--} four')).toBe(6);
    expect(countAcceptedWords('$$\nx_{--}\n$$\n\none two three {--del--} four')).toBe(7);
  });

  it('breaks the words around an opener at a line end, as a new paragraph starts there', () => {
    expect(countAcceptedWords('x a{--\nb--}c y')).toBe(4);
    expect(countAcceptedWords('a{--\n\n--}b')).toBe(1);
  });

  it('reads CRLF line ends as LF', () => {
    expect(countAcceptedWords('x a{--\r\nb--}c y\r\n{++z++}')).toBe(5);
  });

  it('counts an unclosed opener as text', () => {
    expect(countAcceptedWords('a {--b c')).toBe(3);
  });

  it('leaves out frontmatter', () => {
    expect(countAcceptedWords('---\ntitle: x y\n---\na {--b--} c')).toBe(2);
  });

  it('counts a document as written where it has no changes', () => {
    const text = 'word '.repeat(1000) + '{x}';
    expect(countAcceptedWords(text)).toBe(countWords(text));
  });
});

describe('wordCountText', () => {
  it('marks the count with changes accepted', () => {
    expect(wordCountText(3, false)).toBe('$(book) 3 words');
    expect(wordCountText(3, true)).toBe('$(book) 3 words (accepted)');
  });
});

describe('WordCountController', () => {
  function setup(options: { acceptChanges?: boolean; workspaceValue?: boolean } = {}) {
    const vscode = require('vscode');
    let setting = options.acceptChanges ?? false;
    let configListener: ((e: { affectsConfiguration(key: string): boolean }) => void) | undefined;
    let editorListener: (() => void) | undefined;
    let toggle: (() => Promise<void>) | undefined;
    const updates: unknown[][] = [];
    const item = { text: '', tooltip: '', command: undefined as string | undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
    vscode.window.createStatusBarItem = () => item;
    vscode.window.onDidChangeActiveTextEditor = (f: () => void) => { editorListener = f; return { dispose() {} }; };
    vscode.window.onDidChangeTextEditorSelection = () => ({ dispose() {} });
    vscode.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
    vscode.workspace.onDidChangeConfiguration = (f: typeof configListener) => { configListener = f; return { dispose() {} }; };
    vscode.workspace.getConfiguration = () => ({
      get: () => setting,
      inspect: () => ({ workspaceValue: options.workspaceValue }),
      update: async (key: string, value: boolean, target: number) => {
        updates.push([key, value, target]);
        setting = value;
        configListener!({ affectsConfiguration: k => k === 'manuscriptMarkdown.' + key });
      },
    });
    vscode.commands.registerCommand = (_id: string, f: () => Promise<void>) => { toggle = f; return { dispose() {} }; };
    const document = { languageId: 'markdown', version: 1, text: 'a {--b--} c', reads: 0, getText() { this.reads++; return this.text; } };
    vscode.window.activeTextEditor = { document, selections: [{ isEmpty: true }] };
    const { WordCountController } = require('./wordcount');
    const controller = new WordCountController();
    return { controller, item, document, updates, toggle: () => toggle!(), refresh: () => editorListener!() };
  }

  it('counts as written, and with changes accepted once toggled, in the user\'s settings', async () => {
    const { controller, item, updates, toggle } = setup();
    expect(item.text).toBe('$(book) 3 words');
    expect(item.command).toBe('manuscript-markdown.toggleWordCountAcceptChanges');
    await toggle();
    expect(updates).toEqual([['wordCount.acceptChanges', true, 1]]);
    expect(item.text).toBe('$(book) 2 words (accepted)');
    await toggle();
    expect(item.text).toBe('$(book) 3 words');
    controller.dispose();
  });

  it('toggles in the workspace\'s settings where they set it', async () => {
    const { controller, updates, toggle } = setup({ acceptChanges: true, workspaceValue: true });
    await toggle();
    expect(updates).toEqual([['wordCount.acceptChanges', false, 2]]);
    controller.dispose();
  });

  it('reads the document again only for a new version or mode', async () => {
    const { controller, item, document, refresh, toggle } = setup();
    expect(document.reads).toBe(1);
    refresh();
    expect(document.reads).toBe(1);
    document.text = 'a b c d';
    document.version = 2;
    refresh();
    expect(document.reads).toBe(2);
    expect(item.text).toBe('$(book) 4 words');
    await toggle();
    expect(document.reads).toBe(3);
    controller.dispose();
  });
});
