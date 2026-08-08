import { describe, it, expect } from 'bun:test';
import * as formatting from './formatting';
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
      
      expect(result.newText).toBe('{>>@TestUser | <<}');
      expect(result.cursorOffset).toBe(15); // 3 + '@TestUser | '.length

      // Scenario 3: Settings changed - author names disabled
      authorName = null;
      result = formatting.wrapSelection('', '{>>', '<<}', 3, authorName);
      
      expect(result.newText).toBe('{>><<}');
      expect(result.cursorOffset).toBe(3);

      // Scenario 4: Settings changed - different override value
      authorName = 'NewUser';
      result = formatting.wrapSelection('', '{>>', '<<}', 3, authorName);
      
      expect(result.newText).toBe('{>>@NewUser | <<}');
      expect(result.cursorOffset).toBe(14); // 3 + '@NewUser | '.length

      // Scenario 5: Test with highlight-and-comment
      authorName = 'Alice';
      result = formatting.highlightAndComment('important', authorName);
      
      expect(result.newText).toBe('{==important==}{>>@Alice | <<}');
      expect(result.cursorOffset).toBe(27); // Position after '@Alice | '

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
    expect(commentRule.begin).toBe('(\\{)(>>)');
    expect(commentRule.end).toBe('(<<)(\\})');
    expect(commentRule.beginCaptures?.['1']?.name).toBe('punctuation.definition.tag.begin.manuscript-markdown');
    expect(commentRule.beginCaptures?.['2']?.name).toBe('punctuation.definition.tag.begin.manuscript-markdown');
    expect(commentRule.endCaptures?.['1']?.name).toBe('punctuation.definition.tag.end.manuscript-markdown');
    expect(commentRule.endCaptures?.['2']?.name).toBe('punctuation.definition.tag.end.manuscript-markdown');
    expect(commentRule.name).toBe('meta.comment.manuscript-markdown');
    expect(commentRule.contentName).toBe('meta.comment');
    expect(commentRule.match).toBeUndefined();
  });

  it('uses begin/end captures for comment_with_id so closing <<} is delimiter-scoped', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    const commentWithIdRule = grammar?.repository?.comment_with_id;

    expect(commentWithIdRule).toBeDefined();
    expect(commentWithIdRule.begin).toBe('(\\{#)([a-zA-Z0-9_-]++)(>>)');
    expect(commentWithIdRule.end).toBe('<<\\}');
    expect(commentWithIdRule.beginCaptures?.['1']?.name).toBe('punctuation.definition.tag.begin.manuscript-markdown');
    expect(commentWithIdRule.beginCaptures?.['3']?.name).toBe('punctuation.definition.tag.begin.manuscript-markdown');
    expect(commentWithIdRule.endCaptures?.['0']?.name).toBe('punctuation.definition.tag.end.manuscript-markdown');
    expect(commentWithIdRule.contentName).toBe('meta.comment.manuscript-markdown');
    expect(commentWithIdRule.match).toBeUndefined();
  });

  it('uses begin/end captures for highlight rule with tag punctuation scopes', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    const highlightRule = grammar?.repository?.highlight;

    expect(highlightRule).toBeDefined();
    expect(highlightRule.begin).toBe('(\\{)(==)');
    expect(highlightRule.end).toBe('(==)(\\})');
    expect(highlightRule.beginCaptures?.['1']?.name).toBe('punctuation.definition.tag.begin.manuscript-markdown');
    expect(highlightRule.beginCaptures?.['2']?.name).toBe('punctuation.definition.tag.begin.manuscript-markdown');
    expect(highlightRule.endCaptures?.['1']?.name).toBe('punctuation.definition.tag.end.manuscript-markdown');
    expect(highlightRule.endCaptures?.['2']?.name).toBe('punctuation.definition.tag.end.manuscript-markdown');
    expect(highlightRule.match).toBeUndefined();
  });

  it('highlights supported bracket citations and boundary-safe bare citations', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    expect(grammar.patterns.slice(0, 4)).toEqual([
      { include: '#email_address' },
      { include: '#citation_list' },
      { include: '#noncitation_bracket' },
      { include: '#bare_citation' },
    ]);
    expect(grammar.repository.citation_list.begin).toBe('\\[(?=-?@[A-Za-z0-9_:-])');
    const citationListBegin = new RegExp(grammar.repository.citation_list.begin);
    expect(citationListBegin.test('[@smith2020]')).toBe(true);
    expect(citationListBegin.test('[-@smith2020]')).toBe(true);
    expect(citationListBegin.test('[see -@smith2020]')).toBe(false);
    expect(citationListBegin.test('[ordinary link label]')).toBe(false);
    expect(citationListBegin.test('[contact user@example.com]')).toBe(false);
    expect(citationListBegin.test('[user@example.com]')).toBe(false);
    expect(grammar.repository.bare_citation.match).toBe('(?<![\\p{L}\\p{M}\\p{N}._:\\-/+\\x3d`\\\\])@[A-Za-z0-9_:-]++');
    expect(grammar.repository.bare_citation.name).toBe('support.function.citation.manuscript-markdown');
    const bareCitation = new RegExp(grammar.repository.bare_citation.match.replace('++', '+'), 'u');
    expect(bareCitation.test('@alpha')).toBe(true);
    expect(bareCitation.test('α@_beta')).toBe(false);
    expect(bareCitation.test('\u00E9@precomposed')).toBe(false);
    expect(bareCitation.test('e\u0301@decomposed')).toBe(false);
    expect(grammar.repository.citation_list.patterns[0].match).toBe('(?<![\\p{L}\\p{M}\\p{N}._/+\\x3d`\\\\])@[A-Za-z0-9_:-]++');
    const citationListKey = new RegExp(grammar.repository.citation_list.patterns[0].match.replace('++', '+'), 'u');
    expect(citationListKey.test('@alpha')).toBe(true);
    expect(citationListKey.test('e\u0301@decomposed')).toBe(false);
    expect(citationListKey.test('user@example.com')).toBe(false);
    expect(citationListKey.test('\\@escaped')).toBe(false);
    const emailAddress = new RegExp(grammar.repository.email_address.match, 'u');
    expect(emailAddress.test('"quoted local"@example.com')).toBe(true);
    expect(emailAddress.test('δοκιμή@παράδειγμα.δοκιμή')).toBe(true);
    expect(emailAddress.test('𐐀@example.dev')).toBe(true);
    expect(emailAddress.test('caf\u00E9@example.com')).toBe(true);
    expect(emailAddress.test('cafe\u0301@example.com')).toBe(true);
    expect(emailAddress.test('cafe@example\u0301.com')).toBe(true);
    expect(emailAddress.test('“@citation”')).toBe(false);
    const noncitationBracket = new RegExp(grammar.repository.noncitation_bracket.begin);
    expect(noncitationBracket.test('[see @unsupported]')).toBe(true);
    expect(noncitationBracket.test('[discussion [@key]]')).toBe(true);
    expect(noncitationBracket.test('[See @label](https://example.test)')).toBe(false);
    expect(noncitationBracket.test('[^note]')).toBe(false);
    expect(grammar.repository.noncitation_bracket.patterns).toEqual([
      { include: '#citation_list' },
      { include: '#noncitation_bracket' },
    ]);
    expect(grammar.injectionSelector).toContain('-comment');
    expect(grammar.injectionSelector).toContain('-meta.embedded');
    expect(grammar.injectionSelector).toContain('-meta.tag');
    expect(grammar.injectionSelector).toContain('-markup.underline.link');
    expect(grammar.injectionSelector).toContain('-constant.other.reference.link');
    expect(grammar.repository.comment.patterns).toEqual([
      { include: '#critic_attribution' },
      { include: '#email_address' },
      { include: '#citation_list' },
      { include: '#noncitation_bracket' },
      { include: '#bare_citation' },
    ]);
    expect(grammar.repository.comment_with_id.patterns).toEqual(grammar.repository.comment.patterns);
    expect(grammar.repository.critic_attribution.match).toBe('\\G\\s*@[^|\\r\\n]*\\|');
  });

  it('registers a frontmatter-only nocite injection grammar', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown-frontmatter.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    expect(grammar.injectionSelector).toBe('L:meta.embedded.block.frontmatter');
    expect(grammar.patterns.slice(0, 3)).toEqual([
      { include: '#nocite_block' },
      { include: '#nocite_multiline' },
      { include: '#nocite_inline' },
    ]);
    expect(grammar.repository.citation_key.match).toBe('(?<![\\p{L}\\p{M}\\p{N}._/+\\x3d`\\\\])@(\\*(?![A-Za-z0-9_:-])|[A-Za-z0-9_:-]++)');
    expect(grammar.repository.email_address.match).toContain('\\p{L}');
    const nociteKey = new RegExp(grammar.repository.citation_key.match.replace('++', '+'), 'u');
    expect(nociteKey.test('@alpha')).toBe(true);
    expect(nociteKey.test('\\@escaped')).toBe(false);
    expect(nociteKey.test('person@example.com')).toBe(false);
    expect(nociteKey.test('name@*suffix')).toBe(false);
    expect(nociteKey.test('α@_beta')).toBe(false);
    expect(nociteKey.test('\u00E9@precomposed')).toBe(false);
    expect(nociteKey.test('e\u0301@decomposed')).toBe(false);
    const nociteEmail = new RegExp(grammar.repository.email_address.match, 'u');
    expect(nociteEmail.test('caf\u00E9@example.com')).toBe(true);
    expect(nociteEmail.test('cafe\u0301@example.com')).toBe(true);
    expect(nociteEmail.test('cafe@example\u0301.com')).toBe(true);
    expect(grammar.repository.yaml_comment.begin).toBe('(?<!\\S)#');
    expect(grammar.repository.single_quoted_value.end).toContain('(?:,|\\]|#.*|$)');
    expect(grammar.repository.single_quoted_value.patterns).toContainEqual({
      match: "''",
      name: 'constant.character.escape.yaml',
    });
    expect(grammar.repository.single_quoted_value.patterns).toContainEqual({ include: '#citation_key' });
    expect(grammar.repository.double_quoted_value.end).toContain('(?:,|\\]|#.*|$)');
    expect(grammar.repository.double_quoted_value.end).toContain('(?<!\\\\)');
    expect(grammar.repository.double_quoted_value.patterns).toContainEqual({
      match: '\\\\.',
      name: 'constant.character.escape.yaml',
    });
    expect(grammar.repository.double_quoted_value.patterns).toContainEqual({ include: '#citation_key' });
    expect(grammar.repository.nocite_inline.patterns).toEqual([{ include: '#nocite_yaml_value' }]);
    expect(grammar.repository.nocite_multiline.patterns).toEqual([{ include: '#nocite_yaml_value' }]);
    expect(grammar.repository.nocite_block.patterns).toEqual([
      { include: '#email_address' },
      { include: '#citation_key' },
    ]);
    expect(grammar.repository.nocite_multiline.end).toContain('[^\\s#-][^:]*:');

    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    expect(packageJson.contributes.grammars).toContainEqual({
      path: './syntaxes/manuscript-markdown-frontmatter.json',
      scopeName: 'manuscript-markdown.frontmatter.injection',
      injectTo: ['text.html.markdown'],
    });
  });

  it('no repository rule contains both while and end (while silently overrides end)', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    const repo = grammar?.repository ?? {};

    for (const [name, rule] of Object.entries(repo)) {
      const r = rule as Record<string, unknown>;
      if (r.while !== undefined && r.end !== undefined) {
        throw new Error(`Rule "${name}" has both while and end; while silently overrides end in vscode-textmate`);
      }
    }
  });

  it('comment scopes use meta.comment family (not comment.block)', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));

    const commentRule = grammar?.repository?.comment;
    expect(commentRule).toBeDefined();
    expect(commentRule.name).toMatch(/^meta\.comment/);
    expect(commentRule.contentName).toMatch(/^meta\.comment/);

    const commentWithIdRule = grammar?.repository?.comment_with_id;
    expect(commentWithIdRule).toBeDefined();
    expect(commentWithIdRule.contentName).toMatch(/^meta\.comment/);
  });
});
