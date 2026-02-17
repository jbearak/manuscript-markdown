import { describe, it, expect } from 'bun:test';
import * as formatting from './formatting';
import MarkdownIt from 'markdown-it';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';
import * as fs from 'fs';
import * as path from 'path';

describe('Command Handler Unit Tests', () => {
  
  // Test empty selection handling (Requirements 6.1, 6.3)
  describe('Empty selection handling', () => {
    it('should handle empty text for wrapping operations', () => {
      const emptyText = '';
      
      // Test addition
      const addition = formatting.wrapSelection(emptyText, '{++', '++}');
      expect(addition.newText).toBe('{++++}');
      
      // Test deletion
      const deletion = formatting.wrapSelection(emptyText, '{--', '--}');
      expect(deletion.newText).toBe('{----}');
      
      // Test bold
      const bold = formatting.wrapSelection(emptyText, '**', '**');
      expect(bold.newText).toBe('****');
      
      // Test italic
      const italic = formatting.wrapSelection(emptyText, '_', '_');
      expect(italic.newText).toBe('__');
      
      // Test inline code
      const code = formatting.wrapSelection(emptyText, '`', '`');
      expect(code.newText).toBe('``');
      
      // Test bold italic
      const boldItalic = formatting.formatBoldItalic(emptyText);
      expect(boldItalic.newText).toBe('******');
    });

    it('should handle empty text for comment operations with cursor positioning', () => {
      const emptyText = '';
      
      // Test comment insertion
      const comment = formatting.wrapSelection(emptyText, '{>>', '<<}', 3);
      expect(comment.newText).toBe('{>><<}');
      expect(comment.cursorOffset).toBe(3);
      
      // Test highlight and comment
      const highlightComment = formatting.highlightAndComment(emptyText);
      expect(highlightComment.newText).toBe('{====}{>><<}');
      expect(highlightComment.cursorOffset).toBe(9); // Position between >> and <<
      
      // Test substitute and comment
      const substituteComment = formatting.substituteAndComment(emptyText);
      expect(substituteComment.newText).toBe('{~~~>~~}{>><<}');
      expect(substituteComment.cursorOffset).toBe(11); // Position between >> and <<
    });

    it('should handle empty text for substitution with cursor positioning', () => {
      const emptyText = '';
      const substitution = formatting.wrapSelection(emptyText, '{~~', '~>~~}', 5);
      expect(substitution.newText).toBe('{~~~>~~}');
      expect(substitution.cursorOffset).toBe(5); // Position after ~>
    });

    it('should handle empty lines for line-based operations', () => {
      const emptyText = '';
      
      // Test bulleted list
      const bullet = formatting.wrapLines(emptyText, '- ');
      expect(bullet.newText).toBe('');
      
      // Test numbered list
      const numbered = formatting.wrapLinesNumbered(emptyText);
      expect(numbered.newText).toBe('');
      
      // Test quote block
      const quote = formatting.wrapLines(emptyText, '> ', true);
      expect(quote.newText).toBe('');
    });
  });

  // Test cursor positioning for comment-related commands (Requirements 6.1, 6.3)
  describe('Cursor positioning for interactive commands', () => {
    it('should position cursor correctly for substitution', () => {
      const text = 'old text';
      const result = formatting.wrapSelection(text, '{~~', '~>~~}', text.length + 5);
      
      expect(result.newText).toBe('{~~old text~>~~}');
      expect(result.cursorOffset).toBe(13); // After "~>" for entering replacement (3 + 8 + 2 = 13)
    });

    it('should position cursor correctly for comment insertion', () => {
      const text = '';
      const result = formatting.wrapSelection(text, '{>>', '<<}', 3);
      
      expect(result.newText).toBe('{>><<}');
      expect(result.cursorOffset).toBe(3); // Between >> and <<
    });

    it('should position cursor correctly for highlight and comment', () => {
      const text = 'important text';
      const result = formatting.highlightAndComment(text);
      
      expect(result.newText).toBe('{==important text==}{>><<}');
      expect(result.cursorOffset).toBe(23); // Between >> and << in comment
    });

    it('should position cursor correctly for substitute and comment', () => {
      const text = 'old text';
      const result = formatting.substituteAndComment(text);
      
      expect(result.newText).toBe('{~~old text~>~~}{>><<}');
      expect(result.cursorOffset).toBe(19); // Between >> and << in comment
    });

    it('should position cursor correctly for addition and comment', () => {
      const text = 'new text';
      const result = formatting.additionAndComment(text);
      
      expect(result.newText).toBe('{++new text++}{>><<}');
      expect(result.cursorOffset).toBe(17); // Between >> and << in comment
    });

    it('should position cursor correctly for deletion and comment', () => {
      const text = 'removed text';
      const result = formatting.deletionAndComment(text);
      
      expect(result.newText).toBe('{--removed text--}{>><<}');
      expect(result.cursorOffset).toBe(21); // Between >> and << in comment
    });

    it('should not have cursor offset for simple wrapping operations', () => {
      const text = 'sample';
      
      const bold = formatting.wrapSelection(text, '**', '**');
      expect(bold.cursorOffset).toBeUndefined();
      
      const italic = formatting.wrapSelection(text, '_', '_');
      expect(italic.cursorOffset).toBeUndefined();
      
      const highlight = formatting.wrapSelection(text, '{==', '==}');
      expect(highlight.cursorOffset).toBeUndefined();
    });
  });

  // Test multi-selection support through formatting functions (Requirements 6.1, 6.3)
  describe('Multi-selection support', () => {
    it('should handle multiple text selections independently for wrapping', () => {
      const selections = ['first', 'second', 'third'];
      
      // Simulate processing multiple selections
      const results = selections.map(text => 
        formatting.wrapSelection(text, '**', '**')
      );
      
      expect(results[0].newText).toBe('**first**');
      expect(results[1].newText).toBe('**second**');
      expect(results[2].newText).toBe('**third**');
    });

    it('should handle multiple selections for line-based operations', () => {
      const selections = ['line one', 'line two', 'line three'];
      
      // Simulate processing multiple selections
      const results = selections.map(text => 
        formatting.wrapLines(text, '- ')
      );
      
      expect(results[0].newText).toBe('- line one');
      expect(results[1].newText).toBe('- line two');
      expect(results[2].newText).toBe('- line three');
    });

    it('should maintain cursor positioning for multiple selections with interactive commands', () => {
      const selections = ['text1', 'text2'];
      
      // Simulate processing multiple selections for substitution
      const results = selections.map(text => 
        formatting.wrapSelection(text, '{~~', '~>~~}', text.length + 5)
      );
      
      expect(results[0].newText).toBe('{~~text1~>~~}');
      expect(results[0].cursorOffset).toBe(10);
      
      expect(results[1].newText).toBe('{~~text2~>~~}');
      expect(results[1].cursorOffset).toBe(10);
    });
  });

  // Additional edge cases
  describe('Edge cases', () => {
    it('should handle text with existing formatting syntax', () => {
      const textWithBold = '**already bold**';
      const result = formatting.wrapSelection(textWithBold, '_', '_');
      expect(result.newText).toBe('_**already bold**_');
    });

    it('should format text as bold italic', () => {
      const text = 'important text';
      const result = formatting.formatBoldItalic(text);
      expect(result.newText).toBe('***important text***');
    });

    it('should handle multi-line selections for line-based operations', () => {
      const multiLine = 'line 1\nline 2\nline 3';
      
      const bullet = formatting.wrapLines(multiLine, '- ');
      expect(bullet.newText).toBe('- line 1\n- line 2\n- line 3');
      
      const numbered = formatting.wrapLinesNumbered(multiLine);
      expect(numbered.newText).toBe('1. line 1\n2. line 2\n3. line 3');
    });

    it('should handle selections with blank lines', () => {
      const textWithBlanks = 'line 1\n\nline 3';
      
      const bullet = formatting.wrapLines(textWithBlanks, '- ');
      expect(bullet.newText).toBe('- line 1\n\n- line 3');
      
      const quote = formatting.wrapLines(textWithBlanks, '> ');
      expect(quote.newText).toBe('> line 1\n\n> line 3');
    });

    it('should handle heading formatting on various text', () => {
      const text = 'My Heading';
      
      const h1 = formatting.formatHeading(text, 1);
      expect(h1.newText).toBe('# My Heading');
      
      const h3 = formatting.formatHeading(text, 3);
      expect(h3.newText).toBe('### My Heading');
      
      const h6 = formatting.formatHeading(text, 6);
      expect(h6.newText).toBe('###### My Heading');
    });
  });

  // Test that settings changes take effect immediately (Requirement 2.5)
  describe('Settings changes take effect immediately', () => {
    it('should use updated settings for subsequent comment insertions without reload', () => {
      // Simulate the getAuthorName() logic with different settings
      // This tests that the formatting functions respond to different author names
      // which demonstrates that settings changes take effect immediately
      
      // Scenario 1: No author name (disabled or unavailable)
      let authorName: string | null = null;
      let result = formatting.wrapSelection('', '{>>', '<<}', 3, authorName);
      
      expect(result.newText).toBe('{>><<}');
      expect(result.cursorOffset).toBe(3);

      // Scenario 2: Author name from override setting
      authorName = 'TestUser';
      result = formatting.wrapSelection('', '{>>', '<<}', 3, authorName);
      
      expect(result.newText).toBe('{>>TestUser: <<}');
      expect(result.cursorOffset).toBe(13); // 3 + 'TestUser: '.length

      // Scenario 3: Settings changed - author names disabled
      authorName = null;
      result = formatting.wrapSelection('', '{>>', '<<}', 3, authorName);
      
      expect(result.newText).toBe('{>><<}');
      expect(result.cursorOffset).toBe(3);

      // Scenario 4: Settings changed - different override value
      authorName = 'NewUser';
      result = formatting.wrapSelection('', '{>>', '<<}', 3, authorName);
      
      expect(result.newText).toBe('{>>NewUser: <<}');
      expect(result.cursorOffset).toBe(12); // 3 + 'NewUser: '.length

      // Scenario 5: Test with highlight-and-comment
      authorName = 'Alice';
      result = formatting.highlightAndComment('important', authorName);
      
      expect(result.newText).toBe('{==important==}{>>Alice: <<}');
      expect(result.cursorOffset).toBe(25); // Position after 'Alice: '

      // Scenario 6: Highlight-and-comment without author
      authorName = null;
      result = formatting.highlightAndComment('important', authorName);
      
      expect(result.newText).toBe('{==important==}{>><<}');
      expect(result.cursorOffset).toBe(18);
    });
  });
});

describe('Syntax grammar invariants', () => {
  it('uses begin/end for comment rule so multi-line comments are tokenized', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    const commentRule = grammar?.repository?.comment;

    expect(commentRule).toBeDefined();
    expect(commentRule.begin).toBe('\\{>>');
    expect(commentRule.end).toBe('<<\\}');
    expect(commentRule.match).toBeUndefined();
  });
});

// Integration tests for markdown-it plugin registration (Requirements 7.1)
describe('Markdown Preview Integration', () => {
  describe('Plugin registration', () => {
    it('should register Manuscript Markdown plugin with markdown-it', () => {
      const md = new MarkdownIt();
      
      // Apply the plugin (simulating what extendMarkdownIt does)
      const extendedMd = md.use(manuscriptMarkdownPlugin);
      
      expect(extendedMd).toBeDefined();
      
      // Test that Manuscript Markdown is processed
      const html = extendedMd.render('{++addition++}');
      expect(html).toContain('manuscript-markdown-addition');
      expect(html).toContain('<ins');
    });

    it('should process all Manuscript Markdown types through the plugin', () => {
      const md = new MarkdownIt();
      const extendedMd = md.use(manuscriptMarkdownPlugin);
      
      // Test addition
      const additionHtml = extendedMd.render('{++added text++}');
      expect(additionHtml).toContain('manuscript-markdown-addition');
      
      // Test deletion
      const deletionHtml = extendedMd.render('{--deleted text--}');
      expect(deletionHtml).toContain('manuscript-markdown-deletion');
      
      // Test substitution
      const substitutionHtml = extendedMd.render('{~~old~>new~~}');
      expect(substitutionHtml).toContain('manuscript-markdown-substitution');
      
      // Test comment
      const commentHtml = extendedMd.render('{>>comment text<<}');
      expect(commentHtml).toContain('manuscript-markdown-comment');
      
      // Test highlight
      const highlightHtml = extendedMd.render('{==highlighted text==}');
      expect(highlightHtml).toContain('manuscript-markdown-highlight');
    });
  });

  describe('Stylesheet declaration', () => {
    it('should declare preview stylesheet in package.json', () => {
      const packageJsonPath = path.join(__dirname, '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      
      expect(packageJson.contributes).toBeDefined();
      expect(packageJson.contributes['markdown.previewStyles']).toBeDefined();
      expect(Array.isArray(packageJson.contributes['markdown.previewStyles'])).toBe(true);
      expect(packageJson.contributes['markdown.previewStyles']).toContain('./media/manuscript-markdown.css');
    });

    it('should declare markdown.markdownItPlugins in package.json', () => {
      const packageJsonPath = path.join(__dirname, '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      
      expect(packageJson.contributes).toBeDefined();
      expect(packageJson.contributes['markdown.markdownItPlugins']).toBe(true);
    });

    it('should have CSS file at declared path', () => {
      const cssPath = path.join(__dirname, '..', 'media', 'manuscript-markdown.css');
      expect(fs.existsSync(cssPath)).toBe(true);
      
      const cssContent = fs.readFileSync(cssPath, 'utf-8');
      expect(cssContent).toContain('.manuscript-markdown-addition');
      expect(cssContent).toContain('.manuscript-markdown-deletion');
      expect(cssContent).toContain('.manuscript-markdown-substitution');
      expect(cssContent).toContain('.manuscript-markdown-comment');
      expect(cssContent).toContain('.manuscript-markdown-highlight');
    });
  });
});
