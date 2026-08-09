import { describe, it, expect } from 'bun:test';
import * as formatting from './formatting';
import * as fs from 'fs';
import * as path from 'path';
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
} from 'vscode-textmate';
import {
  loadWASM,
  OnigScanner,
  OnigString,
} from 'vscode-oniguruma';

let onigurumaReady: Promise<void> | undefined;

async function prepareOniguruma(): Promise<void> {
  if (!onigurumaReady) {
    const modulePath = require.resolve('vscode-oniguruma');
    const wasm = fs.readFileSync(path.join(path.dirname(modulePath), 'onig.wasm'));
    const buffer = wasm.buffer.slice(
      wasm.byteOffset,
      wasm.byteOffset + wasm.byteLength,
    ) as ArrayBuffer;
    onigurumaReady = loadWASM(buffer);
  }
  await onigurumaReady;
}

const onigLib = Promise.resolve({
  createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
  createOnigString: (text: string) => new OnigString(text),
});

async function loadTextMateGrammar(grammarPath: string): Promise<IGrammar> {
  await prepareOniguruma();

  const rawGrammar = parseRawGrammar(
    fs.readFileSync(grammarPath, 'utf-8'),
    grammarPath,
  );
  const registry = new Registry({
    onigLib,
    loadGrammar: async scopeName => (
      scopeName === rawGrammar.scopeName
        ? rawGrammar
        : null
    ),
  });
  const grammar = await registry.loadGrammar(rawGrammar.scopeName);
  if (!grammar) {
    throw new Error('Could not load TextMate grammar ' + rawGrammar.scopeName);
  }
  return grammar;
}

async function loadMarkdownGrammarWithInjection(
  injectionPath: string,
): Promise<IGrammar> {
  await prepareOniguruma();

  const markdownPath = path.join(
    __dirname,
    '..',
    'test',
    'fixtures',
    'vscode-markdown.tmLanguage.json',
  );
  const markdownGrammar = parseRawGrammar(
    fs.readFileSync(markdownPath, 'utf-8'),
    markdownPath,
  );
  const injectionGrammar = parseRawGrammar(
    fs.readFileSync(injectionPath, 'utf-8'),
    injectionPath,
  );
  const htmlDerivativeGrammar = parseRawGrammar(JSON.stringify({
    scopeName: 'text.html.derivative',
    patterns: [{
      begin: '(?i)(</?)([a-z][a-z0-9-]*)',
      beginCaptures: {
        '1': { name: 'punctuation.definition.tag.begin.html' },
        '2': { name: 'entity.name.tag.html' },
      },
      end: '(/?>)',
      endCaptures: {
        '1': { name: 'punctuation.definition.tag.end.html' },
      },
      name: 'meta.tag.inline.any.html',
    }],
  }), 'text.html.derivative.tmLanguage.json');
  const grammars = new Map([
    [markdownGrammar.scopeName, markdownGrammar],
    [injectionGrammar.scopeName, injectionGrammar],
    [htmlDerivativeGrammar.scopeName, htmlDerivativeGrammar],
  ]);
  const registry = new Registry({
    onigLib,
    loadGrammar: async scopeName => grammars.get(scopeName) ?? null,
    getInjections: scopeName => (
      scopeName === markdownGrammar.scopeName
        ? [injectionGrammar.scopeName]
        : []
    ),
  });
  const grammar = await registry.loadGrammar(markdownGrammar.scopeName);
  if (!grammar) {
    throw new Error('Could not load TextMate grammar ' + markdownGrammar.scopeName);
  }
  return grammar;
}

function scopesForText(
  grammar: IGrammar,
  source: string,
  target: string,
): string[][] {
  let stack = INITIAL;
  const scopes: string[][] = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    for (const token of result.tokens) {
      if (line.slice(token.startIndex, token.endIndex).includes(target)) {
        scopes.push(token.scopes);
      }
    }
  }
  return scopes;
}

function scopesAtOffset(
  grammar: IGrammar,
  source: string,
  offset: number,
): string[] {
  let stack = INITIAL;
  let lineStart = 0;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    if (offset <= lineStart + line.length) {
      const column = offset - lineStart;
      const token = result.tokens.find(candidate =>
        candidate.startIndex <= column && candidate.endIndex > column,
      );
      if (token) return token.scopes;
      break;
    }
    lineStart += rawLine.length + 1;
  }
  throw new Error('No TextMate token at offset ' + offset);
}

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

  it('highlights supported bracket citations and boundary-safe bare citations', async () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    expect(grammar.patterns).toEqual([
      { include: '#citation_paragraph' },
      { include: '#citation_container_paragraph' },
      { include: '#bare_citation_paragraph' },
      { include: '#footnote_ref_paragraph' },
      { include: '#footnote_def_paragraph' },
      { include: '#manuscript_inline' },
    ]);
    expect(grammar.repository.manuscript_inline.patterns.slice(0, 9)).toEqual([
      { include: '#raw_text_element' },
      { include: '#plaintext_element' },
      { include: '#email_address' },
      { include: '#citation_list' },
      { include: '#noncitation_bracket' },
      { include: '#multiline_noncitation_bracket' },
      { include: '#bare_citation' },
      { include: '#footnote_ref' },
      { include: '#footnote_def' },
    ]);
    const citationOpener = '(?:(?<![!\\\\])(\\[)|(?<!\\\\)((?:\\\\\\\\)+)(\\[)|(?<!\\\\)((?:\\\\\\\\)*\\\\!)(\\[))';
    expect(grammar.repository.citation_list.begin).toContain(citationOpener);
    expect(grammar.repository.citation_list.begin).toContain(
      'citation_definition_url',
    );
    expect(grammar.repository.citation_list.begin).toContain(
      '(?i:javascript|file)',
    );
    expect(grammar.repository.citation_list.begin).toContain(
      'citation_link_url',
    );
    expect(grammar.repository.citation_list.begin).not.toContain('| \\[\\]');
    const citationBeginCaptures = {
      '2': { name: 'punctuation.definition.brackets.begin.manuscript-markdown' },
      '3': { name: 'constant.character.escape.markdown' },
      '4': { name: 'punctuation.definition.brackets.begin.manuscript-markdown' },
      '5': { name: 'constant.character.escape.markdown' },
      '6': { name: 'punctuation.definition.brackets.begin.manuscript-markdown' },
    };
    expect(grammar.repository.citation_list.beginCaptures).toEqual(
      citationBeginCaptures,
    );
    const hostParagraphWhile = '(^|\\G)((?=\\s*[-=]{3,}\\s*$)|[ ]{4,}(?=[^ \\t\\n]))';
    const hostInlinePatterns = [
      { include: '#manuscript_inline' },
      { include: 'text.html.markdown#inline' },
      { include: 'text.html.derivative' },
    ];
    expect(grammar.repository.host_paragraph_tail).toEqual({
      begin: '\\G',
      while: hostParagraphWhile,
      patterns: [
        ...hostInlinePatterns,
        { include: 'text.html.markdown#heading-setext' },
      ],
    });
    expect(grammar.repository.citation_indented_paragraph_tail).toEqual({
      begin: '^[ ]{4,}(?=[^ \\t\\n])',
      end: '(?=^)',
      patterns: [{ include: '#host_paragraph_tail' }],
    });
    expect(grammar.repository.footnote_definition_tail).toEqual({
      begin: '\\G',
      while: '(^|\\G)[ ]{4,}(?=[^ \\t\\n])',
      patterns: hostInlinePatterns,
    });
    const citationParagraphCaptures = {
      '0': { name: 'meta.citation.manuscript-markdown' },
      ...citationBeginCaptures,
      '10': { name: 'support.function.citation.manuscript-markdown' },
    };
    expect(grammar.repository.citation_paragraph).toMatchObject({
      beginCaptures: citationParagraphCaptures,
      end: '(?=^)',
      name: 'meta.paragraph.markdown meta.paragraph.manuscript-markdown',
    });
    expect(grammar.repository.citation_paragraph.begin).toStartWith(
      '^[ ]{0,3}',
    );
    expect(grammar.repository.citation_paragraph.begin).toContain(
      citationOpener,
    );
    expect(grammar.repository.citation_paragraph.patterns).toEqual([
      {
        begin: '\\G',
        end: grammar.repository.citation_list.end,
        endCaptures: grammar.repository.citation_list.endCaptures,
        name: 'meta.citation.manuscript-markdown',
        patterns: grammar.repository.citation_list.patterns,
      },
      { include: '#citation_host_paragraph_tail' },
    ]);
    expect(grammar.repository.citation_container_paragraph).toMatchObject({
      beginCaptures: citationParagraphCaptures,
      name: 'meta.paragraph.markdown meta.paragraph.manuscript-markdown',
      patterns: grammar.repository.citation_paragraph.patterns,
    });
    expect(grammar.repository.citation_container_paragraph.begin).toStartWith(
      '\\G(?:(?<=[-+*][ \\t])',
    );
    expect(grammar.repository.citation_container_paragraph.while).not.toContain(
      '[*+->]',
    );
    expect(grammar.repository.citation_host_paragraph_tail).toEqual({
      begin: '(?<=\\])',
      end: '(?=^)',
      patterns: [{ include: '#host_paragraph_tail' }],
    });
    for (const [wrapperName, ruleName] of [
      ['bare_citation_paragraph', 'bare_citation'],
      ['footnote_ref_paragraph', 'footnote_ref'],
    ] as const) {
      expect(grammar.repository[wrapperName]).toEqual({
        begin: '^[ ]{0,3}' + grammar.repository[ruleName].match,
        beginCaptures: grammar.repository[ruleName].captures,
        end: '(?=^)',
        name: 'meta.paragraph.markdown meta.paragraph.manuscript-markdown',
        patterns: [{ include: '#host_paragraph_tail' }],
      });
    }
    expect(grammar.repository.footnote_def_paragraph).toEqual({
      begin: '^[ ]{0,3}' + grammar.repository.footnote_def.match.slice(1),
      beginCaptures: grammar.repository.footnote_def.captures,
      end: '(?=^)',
      name: 'meta.paragraph.markdown meta.paragraph.manuscript-markdown',
      patterns: [{ include: '#footnote_definition_tail' }],
    });
    await prepareOniguruma();
    const citationListBegin = new OnigScanner([
      grammar.repository.citation_list.begin,
    ]);
    const citationMatch = (source: string) =>
      citationListBegin.findNextMatchSync(new OnigString(source), 0);
    for (const citation of [
      '[@smith2020]',
      '[-@smith2020]',
      '[@alpha] then [site](url)',
      '[@alpha]:',
      'See [@smith]: result',
    ]) {
      expect(citationMatch(citation)).not.toBeNull();
    }
    for (const noncitation of [
      '[see -@smith2020]',
      '[ordinary link label]',
      '[contact user@example.com]',
      '[user@example.com]',
      '![@image]',
      '[@reference]: destination.md',
      '[@label](@destination)',
      '[@label][reference]',
      '[@label][]',
      '[@label\\]](@destination)',
    ]) {
      expect(citationMatch(noncitation)).toBeNull();
    }
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      const match = citationMatch('\\'.repeat(slashCount) + '![@image]');
      const opener = match?.captureIndices
        .find((capture, index) => [2, 4, 6].includes(index) && capture.length > 0);
      expect(opener ? '[' : undefined).toBe(
        slashCount % 2 === 1 ? '[' : undefined,
      );
    }
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      const match = citationMatch(
        'x' + '\\'.repeat(slashCount) + '[-@escaped]',
      );
      const opener = match?.captureIndices
        .find((capture, index) => [2, 4, 6].includes(index) && capture.length > 0);
      expect(opener ? '[' : undefined).toBe(
        slashCount % 2 === 0 ? '[' : undefined,
      );
    }
    expect(grammar.repository.bare_citation.match).toBe('(?:(?<![\\p{L}\\p{M}\\p{N}._:\\-/+\\x3d`@\\\\])(@[A-Za-z0-9_:-]++)(?!@)|(?<!\\\\)((?:\\\\\\\\)+)(@[A-Za-z0-9_:-]++)(?!@))');
    expect(grammar.repository.bare_citation.name).toBeUndefined();
    expect(grammar.repository.bare_citation.captures).toEqual({
      '1': { name: 'support.function.citation.manuscript-markdown' },
      '2': { name: 'constant.character.escape.markdown' },
      '3': { name: 'support.function.citation.manuscript-markdown' },
    });
    const bareCitationScanner = new OnigScanner([
      grammar.repository.bare_citation.match,
    ]);
    const bareCitationMatch = (source: string) =>
      bareCitationScanner.findNextMatchSync(new OnigString(source), 0);
    expect(bareCitationMatch('@alpha')).not.toBeNull();
    expect(bareCitationMatch('α@_beta')).toBeNull();
    expect(bareCitationMatch('\u00E9@precomposed')).toBeNull();
    expect(bareCitationMatch('e\u0301@decomposed')).toBeNull();
    expect(bareCitationMatch('@user@example.com')).toBeNull();
    expect(bareCitationMatch('@@key')).toBeNull();
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      const source = 'x' + '\\'.repeat(slashCount) + '@escaped';
      const match = bareCitationMatch(source);
      const citekey = match?.captureIndices
        .find((capture, index) => [1, 3].includes(index) && capture.length > 0);
      expect(citekey ? source.slice(citekey.start, citekey.end) : undefined).toBe(
        slashCount % 2 === 0 ? '@escaped' : undefined,
      );
    }
    expect(grammar.repository.citation_list.patterns).toEqual([
      { include: '#citation_indented_paragraph_tail' },
      { include: '#nested_citation_list' },
      { include: '#nested_noncitation_bracket' },
      { include: '#citation_list_content' },
    ]);
    const citationListContent = grammar.repository.citation_list_content.patterns;
    expect(citationListContent[0]).toMatchObject({
      begin: '(;)(?=[ \\t]*(?:(?:<!--(?:[^-]|-(?!->))*-->|<[^>\\r\\n]*>)[ \\t]*)*(?:<!--[^\\r\\n]*)?$)',
      beginCaptures: {
        '1': { name: 'punctuation.separator.sequence.manuscript-markdown' },
      },
      endCaptures: {
        '1': { name: 'support.function.citation.manuscript-markdown' },
      },
      name: 'meta.citation-item-continuation.manuscript-markdown',
      patterns: [{
        begin: '<!--',
        end: '-->|(?=^[ \\t]*(?:$|#{1,6}(?:[ \\t]|$)|(?:[-+*]|[0-9]+[.)])[ \\t]+|(?:(?:\\*[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:-[ \\t]*){3,})$|>[ \\t]?|`{3,}|~{3,}))',
        name: 'comment.block.html',
      }],
    });
    expect(citationListContent[0].end).toContain('<!--');
    expect(citationListContent[1]).toEqual({
      match: '\\G[ \\t]*-?(@[A-Za-z0-9_:-]++)',
      captures: {
        '1': { name: 'support.function.citation.manuscript-markdown' },
      },
    });
    expect(citationListContent[2].match).toBe('(?<=;)[ \\t]*(?:(?:<!--(?:[^-]|-(?!->))*-->|<[^>\\r\\n]*>)[ \\t]*)*-?(@[A-Za-z0-9_:-]++)');
    expect(citationListContent[2].captures).toEqual(
      citationListContent[1].captures,
    );
    expect(citationListContent[3]).toEqual({
      match: ';',
      name: 'punctuation.separator.sequence.manuscript-markdown',
    });
    const continuedCitation = new RegExp(
      citationListContent[2].match.replaceAll('++', '+'),
      'u',
    );
    expect(continuedCitation.exec(';  -@beta')?.slice(1).find(Boolean))
      .toBe('@beta');
    for (const supported of [
      '; <!-- note --> @beta',
      '; <span></span> -@beta',
    ]) {
      expect(continuedCitation.exec(supported)?.slice(1).find(Boolean))
        .toBe('@beta');
    }
    for (const unsupported of [
      '; see @beta',
      ', text mentioning @beta',
      '\n @beta',
      '; "quoted"@example.com',
      '; "quoted"@x..com',
    ]) {
      expect(continuedCitation.exec(unsupported)).toBeNull();
    }
    const emailAddress = new RegExp(grammar.repository.email_address.match, 'u');
    expect(emailAddress.test('"quoted local"@example.com')).toBe(true);
    expect(emailAddress.test('δοκιμή@παράδειγμα.δοκιμή')).toBe(true);
    expect(emailAddress.test('𐐀@example.dev')).toBe(true);
    expect(emailAddress.test('caf\u00E9@example.com')).toBe(true);
    expect(emailAddress.test('cafe\u0301@example.com')).toBe(true);
    expect(emailAddress.test('cafe@example\u0301.com')).toBe(true);
    for (const malformed of [
      '"quoted"@x..com',
      '"quoted"@-x.com',
      '"quoted"@x-.com',
      '"quoted"@x.com-',
    ]) {
      expect(emailAddress.test(malformed)).toBe(false);
    }
    expect(emailAddress.test('“@citation”')).toBe(false);
    expect(grammar.repository.nested_citation_list.begin).toContain(
      citationOpener,
    );
    expect(grammar.repository.nested_citation_list.begin).toContain(
      '[^@\\]\\r\\n]*$',
    );
    const ordinaryOpener = '(?:(?<!\\\\)(\\[)|(?<!\\\\)((?:\\\\\\\\)+)(\\[))';
    expect(grammar.repository.nested_noncitation_bracket.begin)
      .toBe(ordinaryOpener + '(?!\\^)(?!-?@)');
    expect(grammar.repository.noncitation_bracket.begin).toContain(
      ordinaryOpener + '(?=(?:[^\\[\\]\\\\\\r\\n]|\\\\[^\\r\\n]|\\[)*\\])'
        + '(?!\\^)(?!-?@)',
    );
    expect(grammar.repository.noncitation_bracket.begin).toContain(
      'citation_definition_url',
    );
    expect(grammar.repository.noncitation_bracket.begin).toContain(
      '(?<noncitation_shallow_url>',
    );
    expect(grammar.repository.noncitation_bracket.begin).toContain(
      '(?<noncitation_square>',
    );
    expect(grammar.repository.noncitation_bracket.begin).toContain(
      '(?<noncitation_url>',
    );
    const ordinaryBeginCaptures = {
      '1': { name: 'punctuation.definition.brackets.begin.manuscript-markdown' },
      '2': { name: 'constant.character.escape.markdown' },
      '3': { name: 'punctuation.definition.brackets.begin.manuscript-markdown' },
    };
    expect(grammar.repository.noncitation_bracket.beginCaptures).toEqual({
      '2': ordinaryBeginCaptures['1'],
      '3': ordinaryBeginCaptures['2'],
      '4': ordinaryBeginCaptures['3'],
    });
    expect(grammar.repository.nested_noncitation_bracket.beginCaptures)
      .toEqual(ordinaryBeginCaptures);
    expect(grammar.repository.nested_citation_list.beginCaptures).toEqual({
      '1': citationBeginCaptures['2'],
      '2': citationBeginCaptures['3'],
      '3': citationBeginCaptures['4'],
      '4': citationBeginCaptures['5'],
      '5': citationBeginCaptures['6'],
    });
    expect(grammar.repository.nested_citation_list.name).toBeUndefined();
    expect(grammar.repository.nested_noncitation_bracket.name).toBeUndefined();
    await prepareOniguruma();
    const noncitationBracket = new OnigScanner([
      grammar.repository.noncitation_bracket.begin,
    ]);
    const noncitationMatch = (source: string) =>
      noncitationBracket.findNextMatchSync(new OnigString(source), 0);
    expect(noncitationMatch('[see @unsupported]')).not.toBeNull();
    expect(noncitationMatch('[discussion [@key]]')).not.toBeNull();
    expect(noncitationMatch(
      '[see @hidden](destination with spaces)',
    )?.captureIndices[0].start).toBe(0);
    expect(noncitationMatch('[reference]: destination.md')).toBeNull();
    for (const link of [
      '[See @label](https://example.test)',
      '[outer [inner]](https://example.test)',
      '[outer [inner]][reference]',
      '[outer [inner]][]',
    ]) {
      expect(noncitationMatch(link)?.captureIndices[0].start ?? -1).not.toBe(0);
    }
    expect(noncitationMatch('[outer [inner]] []')?.captureIndices[0].start)
      .toBe(0);
    expect(noncitationMatch('[^note]')).toBeNull();
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      const match = noncitationMatch(
        'x' + '\\'.repeat(slashCount) + '[ordinary]',
      );
      const opener = match?.captureIndices
        .find((capture, index) => [2, 4].includes(index) && capture.length > 0);
      expect(opener ? '[' : undefined).toBe(
        slashCount % 2 === 0 ? '[' : undefined,
      );
    }
    const ordinaryClose = '(?:(?<!\\\\)(\\])|(?<!\\\\)(?:\\\\\\\\)+(\\]))';
    expect(grammar.repository.citation_list.end.startsWith(ordinaryClose + '|'))
      .toBe(true);
    expect(grammar.repository.citation_list.end).toContain(
      '(?:[-+*]|[0-9]+[.)])[ \\t]+',
    );
    expect(grammar.repository.citation_list.end).toContain(
      '<!--|</?[A-Za-z]|\\|',
    );
    for (const ordinaryRule of [
      grammar.repository.noncitation_bracket,
      grammar.repository.nested_noncitation_bracket,
      grammar.repository.multiline_noncitation_bracket,
    ]) {
      expect(ordinaryRule.end.startsWith(ordinaryClose + '|')).toBe(true);
      expect(ordinaryRule.end).toContain(
        '(?:[-+*]|[0-9]+[.)])[ \\t]+',
      );
    }
    expect(grammar.repository.nested_noncitation_bracket.end).toBe(
      grammar.repository.noncitation_bracket.end,
    );
    expect(grammar.repository.multiline_noncitation_bracket.end).toBe(
      grammar.repository.noncitation_bracket.end,
    );
    expect(grammar.repository.noncitation_bracket.endCaptures).toEqual(
      grammar.repository.citation_list.endCaptures,
    );
    const bracketEnd = new RegExp(grammar.repository.citation_list.end, 'm');
    expect(bracketEnd.exec('[@unfinished\nLater @valid')?.[0]).toBe('');
    const bracketClose = new RegExp(grammar.repository.noncitation_bracket.end);
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      const match = bracketClose.exec(' ' + '\\'.repeat(slashCount) + ']');
      expect(match?.slice(1, 3).find(Boolean) ?? undefined).toBe(
        slashCount % 2 === 0 ? ']' : undefined,
      );
    }
    const ordinaryNestedPatterns = [
      { include: '#ordinary_bracket_inline' },
    ];
    expect(grammar.repository.nested_noncitation_bracket.patterns)
      .toEqual(ordinaryNestedPatterns);
    expect(grammar.repository.noncitation_bracket.patterns)
      .toEqual(ordinaryNestedPatterns);
    expect(grammar.repository.multiline_noncitation_bracket).toMatchObject({
      begin: ordinaryOpener
        + '(?!\\^)(?!-?@)(?=(?:[^\\[\\]\\\\\\r\\n]|\\\\[^\\r\\n]|\\[)*\\\\?$)',
      name: 'meta.embedded.noncitation-bracket.manuscript-markdown',
      patterns: ordinaryNestedPatterns,
    });
    expect(grammar.injectionSelector).toContain('-comment');
    expect(grammar.injectionSelector).toContain('-meta.embedded');
    expect(grammar.injectionSelector).toContain('-meta.tag');
    expect(grammar.injectionSelector).toContain('-meta.citation.manuscript-markdown');
    expect(grammar.injectionSelector).toContain('-meta.paragraph.manuscript-markdown');
    expect(grammar.injectionSelector).toContain(
      'R:meta.paragraph.manuscript-markdown',
    );
    expect(grammar.injectionSelector).toContain('-markup.underline.link');
    expect(grammar.injectionSelector).toContain('-constant.other.reference.link');
    expect(grammar.repository.comment.patterns).toEqual([
      { include: '#critic_attribution' },
      { include: '#comment_inline' },
    ]);
    expect(grammar.repository.comment_with_id.patterns).toEqual(grammar.repository.comment.patterns);
    expect(grammar.repository.critic_attribution.match).toBe('\\G\\s*@[^|\\r\\n]*\\|');
  });

  it('registers a frontmatter-only nocite injection grammar', () => {
    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown-frontmatter.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf-8'));
    expect(grammar.injectionSelector).toBe('L:meta.embedded.block.frontmatter');
    expect(grammar.patterns).toEqual([
      { include: '#frontmatter_root' },
    ]);
    expect(grammar.repository.frontmatter_root).toMatchObject({
      begin: '^([ \\t]*)(?=(?:[^ \\t#-]|-(?![ \\t]))[^\\r\\n]*:)',
      while: '^(?!(?:---|\\.\\.\\.)[ \\t]*$)(?:\\1(?!(?:[^\\s#-]|-(?![ \\t])).*?:)|[ \\t]*(?:#.*)?$)',
      name: 'meta.frontmatter-root.manuscript-markdown',
      patterns: [
        { include: '#nocite_block' },
        { include: '#nocite_flow_sequence_value' },
        { include: '#nocite_flow_mapping_value' },
        { include: '#nocite_multiline' },
        { include: '#nocite_inline' },
      ],
    });
    expect(grammar.repository.citation_key.match).toBe('(?:(?<![\\p{L}\\p{M}\\p{N}._:\\-/+\\x3d`\\\\])(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++))|(?<![\\p{L}\\p{M}\\p{N}._:\\-/+\\x3d`\\\\])(?:\\\\\\\\)*\\\\?-(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++))|(?<!\\\\)(?:\\\\\\\\)+(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++)))');
    expect(grammar.repository.citation_key.name).toBeUndefined();
    expect(grammar.repository.citation_key.captures).toEqual({
      '1': { name: 'support.function.citation.manuscript-markdown' },
      '2': { name: 'support.function.citation.manuscript-markdown' },
      '3': { name: 'support.function.citation.manuscript-markdown' },
    });
    expect(grammar.repository.double_quoted_citation_key.match).toBe('(?:(?<![\\p{L}\\p{M}\\p{N}._:\\-/+\\x3d`\\\\])(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++))|(?<![\\p{L}\\p{M}\\p{N}._:\\-/+\\x3d`\\\\])(?:\\\\\\\\)*\\\\?-(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++))|(?<!\\\\)(?:\\\\\\\\\\\\\\\\)+(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++)))');
    expect(grammar.repository.double_quoted_citation_key.captures)
      .toEqual(grammar.repository.citation_key.captures);
    expect(grammar.repository.email_address.match).toContain('\\p{L}');
    const nociteKey = new RegExp(grammar.repository.citation_key.match.replaceAll('++', '+'), 'u');
    expect(nociteKey.test('@alpha')).toBe(true);
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      for (const citation of ['@escaped', '@*']) {
        const match = nociteKey.exec('x' + '\\'.repeat(slashCount) + citation);
        expect(match?.slice(1).find(Boolean) ?? undefined).toBe(
          slashCount % 2 === 0 ? citation : undefined,
        );
      }
    }
    expect(nociteKey.exec('-@suppressed')?.slice(1).find(Boolean)).toBe('@suppressed');
    for (let slashCount = 0; slashCount <= 4; slashCount++) {
      const marker = '\\'.repeat(slashCount) + '-@suppressed';
      const match = nociteKey.exec(marker);
      expect(match?.slice(1).find(Boolean)).toBe('@suppressed');
      expect(
        nociteKey.exec('x' + marker)?.slice(1).find(Boolean),
      ).toBeUndefined();
    }
    expect(nociteKey.test('person@example.com')).toBe(false);
    expect(nociteKey.test('prefix:@colon')).toBe(false);
    expect(nociteKey.test('prefix-@hyphen')).toBe(false);
    expect(nociteKey.test('--@double-hyphen')).toBe(false);
    expect(nociteKey.test('name@*suffix')).toBe(false);
    expect(nociteKey.test('@**')).toBe(false);
    expect(nociteKey.test('α@_beta')).toBe(false);
    expect(nociteKey.test('\u00E9@precomposed')).toBe(false);
    expect(nociteKey.test('e\u0301@decomposed')).toBe(false);
    const doubleQuotedNociteKey = new RegExp(
      grammar.repository.double_quoted_citation_key.match.replaceAll('++', '+'),
      'u',
    );
    for (let slashCount = 0; slashCount <= 8; slashCount++) {
      const citation = '\\'.repeat(slashCount) + '@quoted';
      const match = doubleQuotedNociteKey.exec(citation);
      expect(match?.slice(1).find(Boolean) ?? undefined).toBe(
        slashCount % 4 === 0 ? '@quoted' : undefined,
      );
    }
    expect(doubleQuotedNociteKey.test('@**')).toBe(false);
    expect(doubleQuotedNociteKey.test('\\u0040encoded')).toBe(false);
    expect(doubleQuotedNociteKey.exec('@al\\u0070ha')?.slice(1).find(Boolean)).toBe('@al');
    expect(doubleQuotedNociteKey.test('\\t@encoded-boundary')).toBe(false);
    const doubleQuotedEmail = new RegExp(
      grammar.repository.double_quoted_email_address.match,
      'u',
    );
    for (const openingSlashes of [1, 3, 5, 7]) {
      for (const closingSlashes of [1, 3, 5, 7]) {
        const source = '\\'.repeat(openingSlashes) + '"quoted.local'
          + '\\'.repeat(closingSlashes) + '"@example.com';
        expect(doubleQuotedEmail.test(source)).toBe(
          openingSlashes % 4 === 1 && closingSlashes % 4 === 1,
        );
      }
    }
    expect(doubleQuotedEmail.test(
      '\\' + '"quoted' + '\\' + '"' + '\\' + '"@example.com',
    )).toBe(false);
    expect(doubleQuotedEmail.test(
      '\\' + '"quoted' + '\\\\\\' + '"local' + '\\' + '"@example.com',
    )).toBe(true);
    const nociteEmail = new RegExp(grammar.repository.email_address.match, 'u');
    expect(nociteEmail.test('caf\u00E9@example.com')).toBe(true);
    expect(nociteEmail.test('cafe\u0301@example.com')).toBe(true);
    expect(nociteEmail.test('cafe@example\u0301.com')).toBe(true);
    for (const malformed of [
      '"quoted"@x..com',
      '"quoted"@-x.com',
      '"quoted"@x-.com',
      '"quoted"@x.com-',
    ]) {
      expect(nociteEmail.test(malformed)).toBe(false);
    }
    expect(grammar.repository.yaml_comment.begin).toBe('(?<!\\S)#');
    expect(grammar.repository.single_quoted_value.begin)
      .toBe("(?:\\G[ \\t]*(?:-[ \\t]+)?|[\\[\\{,:?][ \\t]*)(')");
    expect(grammar.repository.single_quoted_value.beginCaptures).toEqual({
      '1': { name: 'punctuation.definition.string.begin.yaml' },
    });
    expect(grammar.repository.single_quoted_value.end)
      .toBe("'(?=\\s*(?:,|[\\]}]|#.*|$))");
    expect(grammar.repository.single_quoted_value.patterns).toContainEqual({
      match: "''",
      name: 'constant.character.escape.yaml',
    });
    expect(grammar.repository.single_quoted_value.patterns).toContainEqual({ include: '#citation_key' });
    expect(grammar.repository.double_quoted_value.begin)
      .toBe('(?:\\G[ \\t]*(?:-[ \\t]+)?|[\\[\\{,:?][ \\t]*)(")');
    expect(grammar.repository.double_quoted_value.beginCaptures).toEqual({
      '1': { name: 'punctuation.definition.string.begin.yaml' },
    });
    expect(grammar.repository.double_quoted_value.end).toBe('(?:(?<!\\\\)(\")|(?<!\\\\)(?:\\\\\\\\)+(\"))(?=\\s*(?:,|[\\]}]|#.*|$))');
    expect(grammar.repository.double_quoted_value.endCaptures).toEqual({
      '1': { name: 'punctuation.definition.string.end.yaml' },
      '2': { name: 'punctuation.definition.string.end.yaml' },
    });
    const doubleQuoteEnd = new RegExp(grammar.repository.double_quoted_value.end);
    for (let slashCount = 1; slashCount <= 4; slashCount++) {
      const match = doubleQuoteEnd.exec('\\'.repeat(slashCount) + '"');
      expect(match?.slice(1).find(Boolean) ?? undefined).toBe(
        slashCount % 2 === 0 ? '"' : undefined,
      );
    }
    expect(grammar.repository.double_quoted_value.patterns).toEqual([
      { include: '#double_quoted_email_address' },
      { include: '#email_address' },
      { include: '#double_quoted_citation_key' },
      { match: '\\\\.', name: 'constant.character.escape.yaml' },
    ]);
    const nociteKeyPrefix = '\\G((?:nocite|\'nocite\'|"(?:n|\\\\u006[eE])(?:o|\\\\u006[fF])(?:c|\\\\u0063)(?:i|\\\\u0069)(?:t|\\\\u0074)(?:e|\\\\u0065)"))';
    expect(grammar.repository.nocite_inline.begin).toStartWith(nociteKeyPrefix);
    expect(grammar.repository.nocite_multiline.begin).toStartWith(nociteKeyPrefix);
    expect(grammar.repository.nocite_block.begin).toStartWith(nociteKeyPrefix);
    expect(grammar.repository.nocite_initial_citation_key).toEqual({
      match: '\\G(?:(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++))|(?:\\\\\\\\)*\\\\?-(@(?:\\*(?![A-Za-z0-9_*:-])|[A-Za-z0-9_:-]++)))',
      captures: {
        '1': { name: 'support.function.citation.manuscript-markdown' },
        '2': { name: 'support.function.citation.manuscript-markdown' },
      },
    });
    expect(grammar.repository.nocite_inline.patterns).toEqual([
      { include: '#nocite_initial_citation_key' },
      { include: '#nocite_yaml_value' },
    ]);
    expect(grammar.repository.nocite_multiline.patterns).toEqual([{ include: '#nocite_yaml_value' }]);
    expect(grammar.repository.nocite_block.patterns).toEqual([
      { include: '#email_address' },
      { include: '#citation_key' },
    ]);
    expect(grammar.repository.nocite_multiline.end).toBe('(?=\\G(?:(?:---|\\.\\.\\.)[ \\t]*$|[\\]}](?:[ \\t].*)?$|(?:[^\\s#-]|-(?![ \\t])).*?:))');
    expect(grammar.repository.nocite_block.end).toBe('(?=\\G[^ \\t\\r\\n].*)');
    const nociteBlockEnd = new RegExp(
      '^' + grammar.repository.nocite_block.end.replace('\\G', ''),
    );
    for (const rootLine of ['-custom: @outside', 'title @outside']) {
      expect(nociteBlockEnd.test(rootLine)).toBe(true);
    }
    for (const scalarLine of ['  @inside', '  # literal content', '  prose', '']) {
      expect(nociteBlockEnd.test(scalarLine)).toBe(false);
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    expect(packageJson.contributes.grammars).toContainEqual({
      path: './syntaxes/manuscript-markdown-frontmatter.json',
      scopeName: 'manuscript-markdown.frontmatter.injection',
      injectTo: ['text.html.markdown'],
    });
  });

  it('tokenizes multiline citations with persistent TextMate state', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadTextMateGrammar(grammarPath);
    const scopes = scopesForText(
      grammar,
      '[@alpha;\n @beta]',
      '@beta',
    );

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toContain('meta.citation.manuscript-markdown');
    expect(scopes[0]).toContain(
      'meta.citation-item-continuation.manuscript-markdown',
    );
    expect(scopes[0]).toContain(
      'support.function.citation.manuscript-markdown',
    );

    const commentScopes = scopesForText(
      grammar,
      '[@alpha; <!--\n note --> -@beta]',
      '@beta',
    );
    expect(commentScopes).toHaveLength(1);
    expect(commentScopes[0]).toContain(
      'meta.citation.manuscript-markdown',
    );
    expect(commentScopes[0]).toContain(
      'meta.citation-item-continuation.manuscript-markdown',
    );
    expect(commentScopes[0]).toContain(
      'support.function.citation.manuscript-markdown',
    );

    for (const ordinary of [
      '[discussion @hidden] then [site](url)',
      '[ordinary text\n @hidden]',
    ]) {
      expect(
        scopesForText(grammar, ordinary, '@hidden').flat(),
      ).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    for (const thematicBreak of ['---', '***', '___', '- - -']) {
      const recoveredScopes = scopesForText(
        grammar,
        '[outer [ordinary\n' + thematicBreak + '\nBody cites @valid',
        '@valid',
      ).flat();
      expect(recoveredScopes).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(recoveredScopes).not.toContain(
        'meta.embedded.noncitation-bracket.manuscript-markdown',
      );
    }

    const linkLabelScopes = scopesForText(
      grammar,
      '[@smith](https://example.test)',
      '@smith',
    ).flat();
    expect(linkLabelScopes).not.toContain(
      'meta.citation.manuscript-markdown',
    );
    expect(linkLabelScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );

    for (const malformed of [
      '[@unfinished\nBody cites @valid',
      '[@unfinished;\n\nBody cites @valid',
      '[@unfinished; <!--\n\nBody cites @valid',
      '[@unfinished; <!--\n# Heading @valid',
      '[@unfinished; <!--\n- Item @valid',
      '[@unfinished; <!--\n> Quote @valid',
      '[@unfinished; <!--\n```md\ncode\n```\nBody @valid',
    ]) {
      const validScopes = scopesForText(
        grammar,
        malformed,
        '@valid',
      ).flat();
      expect(validScopes).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(validScopes).not.toContain(
        'meta.citation.manuscript-markdown',
      );
    }
  });

  it('preserves Markdown link and reference scopes around nested labels', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);

    const inline = '[outer [inner]](url)';
    expect(scopesAtOffset(grammar, inline, 0)).toContain(
      'meta.link.inline.markdown',
    );
    expect(scopesAtOffset(grammar, inline, inline.indexOf('url'))).toContain(
      'markup.underline.link.markdown',
    );

    const reference = '[outer [inner]][ref]';
    expect(scopesAtOffset(grammar, reference, 0)).toContain(
      'meta.link.reference.markdown',
    );
    expect(scopesAtOffset(grammar, reference, reference.indexOf('ref')))
      .toContain('constant.other.reference.link.markdown');

    const collapsed = '[outer [inner]][]';
    expect(scopesAtOffset(grammar, collapsed, 0)).toContain(
      'meta.link.reference.markdown',
    );

    const spacedCollapsed = '[outer [inner]] []';
    const spacedCollapsedScopes = scopesAtOffset(grammar, spacedCollapsed, 0);
    expect(spacedCollapsedScopes).toContain(
      'meta.embedded.noncitation-bracket.manuscript-markdown',
    );
    expect(spacedCollapsedScopes).not.toContain(
      'meta.link.reference.literal.markdown',
    );

    for (const [source, target, scope] of [
      ['[outer [inner](url)', 'url', 'markup.underline.link.markdown'],
      ['[outer [inner][ref]', 'ref', 'constant.other.reference.link.markdown'],
      [
        '[outer [inner] []',
        'inner',
        'meta.embedded.noncitation-bracket.manuscript-markdown',
      ],
    ] as const) {
      expect(scopesAtOffset(grammar, source, source.indexOf(target)))
        .toContain(scope);
    }

    for (const citation of ['[@key]', '[-@key]']) {
      const offset = citation.indexOf('@key');
      expect(scopesAtOffset(grammar, citation, offset)).toContain(
        'meta.citation.manuscript-markdown',
      );
      expect(scopesAtOffset(grammar, citation, offset)).toContain(
        'support.function.citation.manuscript-markdown',
      );
    }
    expect(scopesAtOffset(grammar, '[^note]', 2)).toContain(
      'entity.name.footnote.manuscript-markdown',
    );

    const image = '![@figure]\n\n[@figure]: figure.png';
    const imageUsage = image.indexOf('@figure');
    const imageDefinition = image.lastIndexOf('@figure');
    for (const offset of [imageUsage, imageDefinition]) {
      expect(scopesAtOffset(grammar, image, offset)).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(scopesAtOffset(grammar, image, offset)).not.toContain(
        'meta.citation.manuscript-markdown',
      );
    }

    const escapedNested = '[@outer; \\[@fake]]';
    expect(scopesAtOffset(
      grammar,
      escapedNested,
      escapedNested.indexOf('@fake'),
    )).not.toContain('support.function.citation.manuscript-markdown');
    const structuralNested = '[@outer; \\\\[@real]]';
    expect(scopesAtOffset(
      grammar,
      structuralNested,
      structuralNested.indexOf('@real'),
    )).toContain('support.function.citation.manuscript-markdown');
  });

  it('preserves host scopes after column-zero citations and footnotes', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);
    const expectHostLink = (source: string): void => {
      const urlScopes = scopesAtOffset(grammar, source, source.indexOf('url'));
      expect(urlScopes).toContain('meta.link.inline.markdown');
      expect(urlScopes).toContain('markup.underline.link.markdown');
    };

    for (const source of [
      '[@key] then [site](url)',
      '[-@key] then [site](url)',
      '\\\\[@key] then [site](url)',
      '\\![@key] then [site](url)',
    ]) {
      const citationScopes = scopesAtOffset(
        grammar,
        source,
        source.indexOf('@key'),
      );
      expect(citationScopes).toContain('meta.paragraph.markdown');
      expect(citationScopes).toContain('meta.citation.manuscript-markdown');
      expect(citationScopes).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expectHostLink(source);
    }

    for (const bare of [
      '@key then [site](url)',
      '\\\\@key then [site](url)',
    ]) {
      const bareScopes = scopesAtOffset(grammar, bare, bare.indexOf('@key'));
      expect(bareScopes).toContain('meta.paragraph.markdown');
      expect(bareScopes).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expectHostLink(bare);
    }

    for (const source of [
      '[^note] then [site](url)',
      '[^note]: prose then [site](url)',
    ]) {
      const footnoteScopes = scopesAtOffset(
        grammar,
        source,
        source.indexOf('note'),
      );
      expect(footnoteScopes).toContain('meta.paragraph.markdown');
      expect(footnoteScopes).toContain(
        'entity.name.footnote.manuscript-markdown',
      );
      expectHostLink(source);
    }

    const multiline = '[@alpha;\n @beta] then [site](url)';
    const continuedScopes = scopesAtOffset(
      grammar,
      multiline,
      multiline.indexOf('@beta'),
    );
    expect(continuedScopes).toContain('meta.paragraph.markdown');
    expect(continuedScopes).toContain('meta.citation.manuscript-markdown');
    expect(continuedScopes).toContain(
      'meta.citation-item-continuation.manuscript-markdown',
    );
    expect(continuedScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expectHostLink(multiline);

    const linkedTitle = '[@key] then [See @label](url)';
    const linkedCitationScopes = scopesAtOffset(
      grammar,
      linkedTitle,
      linkedTitle.indexOf('@label'),
    );
    expect(linkedCitationScopes).toContain('meta.link.inline.markdown');
    expect(linkedCitationScopes).toContain(
      'string.other.link.title.markdown',
    );
    expect(linkedCitationScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expectHostLink(linkedTitle);

    const definition = '[@reference]: destination.md';
    const definitionKeyScopes = scopesAtOffset(
      grammar,
      definition,
      definition.indexOf('@reference'),
    );
    expect(definitionKeyScopes).toContain(
      'constant.other.reference.link.markdown',
    );
    expect(definitionKeyScopes).not.toContain(
      'meta.citation.manuscript-markdown',
    );
    expect(definitionKeyScopes).not.toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(scopesAtOffset(
      grammar,
      definition,
      definition.indexOf('destination.md'),
    )).toContain('markup.underline.link.markdown');

    const recovered = '[@unfinished\n# Heading [site](url)';
    expect(scopesAtOffset(
      grammar,
      recovered,
      recovered.indexOf('Heading'),
    )).toContain('markup.heading.markdown');
    expectHostLink(recovered);
  });

  it('defers only host-valid links and definitions', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);

    for (const [source, hostScope] of [
      ['[@smith](url)', 'meta.link.inline.markdown'],
      ['[@smith][ref]', 'meta.link.reference.markdown'],
      ['[@smith][]', 'meta.link.reference.markdown'],
    ] as const) {
      const keyScopes = scopesAtOffset(grammar, source, source.indexOf('@smith'));
      expect(keyScopes).toContain(hostScope);
      expect(keyScopes).toContain('string.other.link.title.markdown');
      expect(keyScopes).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(keyScopes).not.toContain('meta.citation.manuscript-markdown');
    }
    const spacedCollapsedScopes = scopesAtOffset(
      grammar,
      '[@smith] []',
      '[@smith] []'.indexOf('@smith'),
    );
    expect(spacedCollapsedScopes).toContain(
      'meta.citation.manuscript-markdown',
    );
    expect(spacedCollapsedScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(spacedCollapsedScopes).not.toContain(
      'meta.link.reference.literal.markdown',
    );
    expect(scopesAtOffset(grammar, '[@smith](url)', 10)).toContain(
      'markup.underline.link.markdown',
    );
    expect(scopesAtOffset(
      grammar,
      '[@smith][ref]',
      '[@smith][ref]'.indexOf('ref'),
    )).toContain('constant.other.reference.link.markdown');

    const laterLinkedCitation = '[@lead] then [@label](url)';
    expect(scopesAtOffset(
      grammar,
      laterLinkedCitation,
      laterLinkedCitation.indexOf('@label'),
    )).toContain('meta.link.inline.markdown');
    expect(scopesAtOffset(
      grammar,
      laterLinkedCitation,
      laterLinkedCitation.indexOf('@label'),
    )).toContain('support.function.citation.manuscript-markdown');
    expect(scopesAtOffset(
      grammar,
      laterLinkedCitation,
      laterLinkedCitation.indexOf('url'),
    )).toContain('markup.underline.link.markdown');

    const malformedLink = '[see @hidden](destination with spaces)';
    const malformedKeyScopes = scopesAtOffset(
      grammar,
      malformedLink,
      malformedLink.indexOf('@hidden'),
    );
    expect(malformedKeyScopes).toContain(
      'meta.embedded.noncitation-bracket.manuscript-markdown',
    );
    expect(malformedKeyScopes).not.toContain(
      'support.function.citation.manuscript-markdown',
    );

    for (const source of ['[@alpha]:', 'See [@smith]: result']) {
      const key = source.includes('@alpha') ? '@alpha' : '@smith';
      const scopes = scopesAtOffset(grammar, source, source.indexOf(key));
      expect(scopes).toContain('meta.citation.manuscript-markdown');
      expect(scopes).toContain('support.function.citation.manuscript-markdown');
    }
    for (const definition of [
      '[@reference]: destination.md',
      '   [@reference]: destination.md',
    ]) {
      const keyScopes = scopesAtOffset(
        grammar,
        definition,
        definition.indexOf('@reference'),
      );
      expect(keyScopes).toContain('constant.other.reference.link.markdown');
      expect(keyScopes).not.toContain('meta.citation.manuscript-markdown');
    }
  });

  it('preserves multiline citations in indented and list paragraphs', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);

    for (const source of [
      '[@smith,\n p. 42]',
      '[@smith2020,\n pp. 10–12]',
    ]) {
      const locator = source.slice(source.indexOf('\n') + 1, source.indexOf(']'))
        .trim();
      expect(scopesAtOffset(
        grammar,
        source,
        source.indexOf(locator),
      )).toContain('meta.citation.manuscript-markdown');
    }
    const semicolonCluster = '[@alpha\n; @beta]';
    const betaScopes = scopesAtOffset(
      grammar,
      semicolonCluster,
      semicolonCluster.indexOf('@beta'),
    );
    expect(betaScopes).toContain('meta.citation.manuscript-markdown');
    expect(betaScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );

    const listCitation = '- [@alpha;\n  @beta] then [site](url)';
    const listBetaScopes = scopesAtOffset(
      grammar,
      listCitation,
      listCitation.indexOf('@beta'),
    );
    expect(listBetaScopes).toContain('markup.list.unnumbered.markdown');
    expect(listBetaScopes).toContain('meta.citation.manuscript-markdown');
    expect(listBetaScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );
    const listUrlScopes = scopesAtOffset(
      grammar,
      listCitation,
      listCitation.indexOf('url'),
    );
    expect(listUrlScopes).toContain('meta.link.inline.markdown');
    expect(listUrlScopes).toContain('markup.underline.link.markdown');

    for (let indent = 1; indent <= 3; indent++) {
      const source = ' '.repeat(indent) + '[@key] then [site](url)';
      const keyScopes = scopesAtOffset(grammar, source, source.indexOf('@key'));
      expect(keyScopes).toContain('meta.paragraph.manuscript-markdown');
      expect(keyScopes).toContain('meta.citation.manuscript-markdown');
      expect(scopesAtOffset(grammar, source, source.indexOf('url'))).toContain(
        'markup.underline.link.markdown',
      );
    }

    const crlf = '[@alpha;\r\n @beta] then [site](url)\r\nBody @valid';
    expect(scopesForText(grammar, crlf, '@beta').flat()).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(scopesAtOffset(grammar, crlf, crlf.indexOf('@beta'))).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(scopesAtOffset(grammar, crlf, crlf.indexOf('url'))).toContain(
      'markup.underline.link.markdown',
    );
    expect(scopesAtOffset(grammar, crlf, crlf.indexOf('@valid'))).toContain(
      'support.function.citation.manuscript-markdown',
    );
  });

  it('bounds malformed brackets while preserving paragraph continuation', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);

    const continuedLink = '[@unfinished\n    [site](url)\nBody @valid';
    const continuedUrlScopes = scopesAtOffset(
      grammar,
      continuedLink,
      continuedLink.indexOf('url'),
    );
    expect(continuedUrlScopes).toContain('meta.paragraph.markdown');
    expect(continuedUrlScopes).toContain('meta.link.inline.markdown');
    expect(continuedUrlScopes).toContain('markup.underline.link.markdown');
    expect(continuedUrlScopes).not.toContain('markup.raw.block.markdown');
    expect(scopesAtOffset(
      grammar,
      continuedLink,
      continuedLink.indexOf('@valid'),
    )).not.toContain('meta.citation.manuscript-markdown');

    const repeatedNested = [
      '[@outer [ordinary',
      '[@outer [ordinary',
      'Body @valid',
    ].join('\n');
    for (const lineStart of [0, repeatedNested.indexOf('\n') + 1]) {
      const scopes = scopesAtOffset(
        grammar,
        repeatedNested,
        repeatedNested.indexOf('@outer', lineStart),
      );
      expect(scopes.filter(scope =>
        scope === 'meta.paragraph.manuscript-markdown'
      )).toHaveLength(1);
      expect(scopes.filter(scope =>
        scope === 'meta.embedded.noncitation-bracket.manuscript-markdown'
      )).toHaveLength(0);
    }
    const recoveredKeyScopes = scopesAtOffset(
      grammar,
      repeatedNested,
      repeatedNested.indexOf('@valid'),
    );
    expect(recoveredKeyScopes).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(recoveredKeyScopes).not.toContain(
      'meta.embedded.noncitation-bracket.manuscript-markdown',
    );

    for (const ordinary of [
      '[ordinary\\\n @hidden]',
      '[ordinary\n    # literal @hidden\n]',
    ]) {
      const scopes = scopesAtOffset(
        grammar,
        ordinary,
        ordinary.indexOf('@hidden'),
      );
      expect(scopes).toContain(
        'meta.embedded.noncitation-bracket.manuscript-markdown',
      );
      expect(scopes).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(scopes).not.toContain('markup.raw.block.markdown');
    }

    const nestedDefinition = '[@outer; [ordinary\n[ref]: destination';
    expect(scopesAtOffset(
      grammar,
      nestedDefinition,
      nestedDefinition.indexOf('ref'),
    )).toContain('constant.other.reference.link.markdown');
    expect(scopesAtOffset(
      grammar,
      nestedDefinition,
      nestedDefinition.indexOf('destination'),
    )).toContain('markup.underline.link.markdown');

    for (const [source, target, scope] of [
      ['[outer [ordinary\n<!-- host HTML -->', 'host HTML', 'comment.block.html'],
      ['[outer [ordinary\n| cell | value |', 'cell', 'markup.table.markdown'],
      ['[outer [ordinary\n\tindented code', 'indented code', 'markup.raw.block.markdown'],
    ] as const) {
      expect(scopesAtOffset(grammar, source, source.indexOf(target))).toContain(
        scope,
      );
    }
  });

  it('preserves host escape and inline HTML scopes', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);

    for (const [source, key] of [
      ['\\\\[@key] then [site](url)', '@key'],
      ['\\![@key] then [site](url)', '@key'],
      ['\\\\@key then [site](url)', '@key'],
    ] as const) {
      expect(scopesAtOffset(grammar, source, 0)).toContain(
        'constant.character.escape.markdown',
      );
      expect(scopesAtOffset(grammar, source, source.indexOf(key))).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(scopesAtOffset(grammar, source, source.indexOf('url'))).toContain(
        'markup.underline.link.markdown',
      );
    }

    const html = '[@lead] then <span title="@hidden">text</span> @visible';
    const hiddenScopes = scopesAtOffset(
      grammar,
      html,
      html.indexOf('@hidden'),
    );
    expect(hiddenScopes).toContain('meta.tag.inline.any.html');
    expect(hiddenScopes).not.toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(scopesAtOffset(
      grammar,
      html,
      html.indexOf('@visible'),
    )).toContain('support.function.citation.manuscript-markdown');
  });

  it('mirrors the pinned Markdown paragraph lifecycle after wrappers', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadMarkdownGrammarWithInjection(grammarPath);

    const setext = '[@key] Setext title\n===';
    const setextScopes = scopesAtOffset(
      grammar,
      setext,
      setext.indexOf('==='),
    );
    expect(setextScopes).toContain('meta.paragraph.markdown');
    expect(setextScopes).toContain('markup.heading.setext.1.markdown');

    const footnoteSeparator = '[^note]: explanation\n---';
    const separatorScopes = scopesAtOffset(
      grammar,
      footnoteSeparator,
      footnoteSeparator.indexOf('---'),
    );
    expect(separatorScopes).toContain('meta.separator.markdown');
    expect(separatorScopes).not.toContain('markup.heading.setext.2.markdown');

    const continuedLink = '@key paragraph\n    [site](url)';
    const continuedUrlScopes = scopesAtOffset(
      grammar,
      continuedLink,
      continuedLink.indexOf('url'),
    );
    expect(continuedUrlScopes).toContain('meta.paragraph.markdown');
    expect(continuedUrlScopes).toContain('meta.link.inline.markdown');
    expect(continuedUrlScopes).toContain('markup.underline.link.markdown');

    const linkDefinition = '[@unfinished\n[@reference]: destination.md';
    expect(scopesAtOffset(
      grammar,
      linkDefinition,
      linkDefinition.indexOf('@reference'),
    )).toContain('constant.other.reference.link.markdown');
    expect(scopesAtOffset(
      grammar,
      linkDefinition,
      linkDefinition.indexOf('destination.md'),
    )).toContain('markup.underline.link.markdown');

    const html = '[@unfinished\n<!-- host HTML -->';
    expect(scopesAtOffset(
      grammar,
      html,
      html.indexOf('host HTML'),
    )).toContain('comment.block.html');

    const table = '[@unfinished\n| cell | value |';
    expect(scopesAtOffset(
      grammar,
      table,
      table.indexOf('cell'),
    )).toContain('markup.table.markdown');

    const rawBlock = '[@unfinished\n\tindented code';
    expect(scopesAtOffset(
      grammar,
      rawBlock,
      rawBlock.indexOf('indented code'),
    )).toContain('markup.raw.block.markdown');

    const repeated = '[@first\n[@second\nBody [site](url)';
    for (const key of ['@first', '@second']) {
      const scopes = scopesAtOffset(grammar, repeated, repeated.indexOf(key));
      expect(scopes.filter(scope => scope === 'meta.paragraph.markdown'))
        .toHaveLength(1);
      expect(scopes.filter(scope =>
        scope === 'meta.paragraph.manuscript-markdown'
      )).toHaveLength(1);
      expect(scopes).toContain('meta.citation.manuscript-markdown');
    }
    const repeatedUrlScopes = scopesAtOffset(
      grammar,
      repeated,
      repeated.indexOf('url'),
    );
    expect(repeatedUrlScopes).toContain('markup.underline.link.markdown');
    expect(repeatedUrlScopes).not.toContain(
      'meta.paragraph.manuscript-markdown',
    );

    const unclosedComment = '[@key] then {>>unclosed\n# Heading';
    const headingScopes = scopesAtOffset(
      grammar,
      unclosedComment,
      unclosedComment.indexOf('Heading'),
    );
    expect(headingScopes).toContain('markup.heading.markdown');
    expect(headingScopes).not.toContain('meta.comment.manuscript-markdown');

    const unclosedCritic = '@key then {++unclosed\n```md\ncode\n```';
    const fenceScopes = scopesAtOffset(
      grammar,
      unclosedCritic,
      unclosedCritic.indexOf('```md'),
    );
    expect(fenceScopes).toContain('markup.fenced_code.block.markdown');
    expect(fenceScopes).not.toContain('markup.inserted.manuscript-markdown');
  });

  it('tokenizes deeply nested ordinary brackets without quadratic scaling', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown.json',
    );
    const grammar = await loadTextMateGrammar(grammarPath);
    const elapsed = (depth: number): number => {
      const source = '[x'.repeat(depth) + 'value' + ']'.repeat(depth);
      let fastest = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now();
        const result = grammar.tokenizeLine(source, INITIAL);
        fastest = Math.min(fastest, performance.now() - started);
        expect(
          result.tokens.filter(token => token.scopes.some(scope =>
            scope.startsWith('punctuation.definition.brackets.'),
          )),
        ).toHaveLength(depth * 2);
        const valueOffset = depth * 2;
        expect(result.tokens.find(token =>
          token.startIndex <= valueOffset && token.endIndex >= valueOffset + 5,
        )?.scopes).toContain(
          'meta.embedded.noncitation-bracket.manuscript-markdown',
        );
      }
      return fastest;
    };

    elapsed(100);
    const shallow = elapsed(600);
    const deep = elapsed(2400);
    // A fourfold input increase should remain well below quadratic (16x).
    // The absolute allowance keeps short shallow timings from making this
    // ratio unstable on contended shared CI runners.
    expect(deep).toBeLessThan(Math.max(shallow * 12 + 25, 1500));
  });

  it('limits frontmatter nocite scopes to the logical root', async () => {
    const grammarPath = path.join(
      __dirname,
      '..',
      'syntaxes',
      'manuscript-markdown-frontmatter.json',
    );
    const grammar = await loadTextMateGrammar(grammarPath);
    for (const key of [
      '"nocite"',
      "'nocite'",
      '"no\\u0063ite"',
    ]) {
      expect(
        scopesForText(grammar, key + ': @quoted', '@quoted').flat(),
      ).toContain(
        'support.function.citation.manuscript-markdown',
      );
    }
    expect(
      scopesForText(grammar, 'nocite:@compact', '@compact').flat(),
    ).toContain(
      'support.function.citation.manuscript-markdown',
    );
    const compactNextKey = [
      'nocite:',
      '  - @active',
      'other:value @hidden',
    ].join('\n');
    expect(
      scopesForText(grammar, compactNextKey, '@hidden').flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );

    const flowList = [
      'nocite: [',
      '  @alpha,',
      '  @beta',
      ']',
      'title: @hidden',
    ].join('\n');
    for (const key of ['@alpha', '@beta']) {
      expect(
        scopesForText(grammar, flowList, key).flat(),
      ).toContain(
        'support.function.citation.manuscript-markdown',
      );
    }
    expect(
      scopesForText(grammar, flowList, '@hidden').flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );

    const itemOnOpener = 'nocite: ["@alpha",\n "@beta"]';
    for (const key of ['@alpha', '@beta']) {
      expect(
        scopesForText(grammar, itemOnOpener, key).flat(),
      ).toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    for (const source of [
      'nocite: [{key: @inner}, @after]\ntitle: @outside',
      'nocite: {items: [@inner], tail: @after}\ntitle: @outside',
    ]) {
      for (const key of ['@inner', '@after']) {
        expect(scopesForText(grammar, source, key).flat()).toContain(
          'support.function.citation.manuscript-markdown',
        );
      }
      expect(scopesForText(grammar, source, '@outside').flat()).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    const multilineQuoted = [
      'nocite:',
      '  - "note',
      '    \\\\@hidden"',
      "  - 'note",
      "    \\@also-hidden'",
      '  - @active',
    ].join('\n');
    for (const key of ['@hidden', '@also-hidden']) {
      expect(scopesForText(grammar, multilineQuoted, key).flat()).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }
    expect(scopesForText(grammar, multilineQuoted, '@active').flat()).toContain(
      'support.function.citation.manuscript-markdown',
    );

    const quotedFlowCloser = [
      'nocite: [',
      '  "literal',
      '    ]",',
      '  @active',
      ']',
      'title: @outside',
    ].join('\n');
    expect(scopesForText(grammar, quotedFlowCloser, '@active').flat()).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(scopesForText(grammar, quotedFlowCloser, '@outside').flat())
      .not.toContain('support.function.citation.manuscript-markdown');

    for (const source of [
      '  nocite: [\n    @inside\n  title: Draft @outside',
      '  nocite: {\n    key: @inside\n  title: Draft @outside',
    ]) {
      expect(scopesForText(grammar, source, '@inside').flat()).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(scopesForText(grammar, source, '@outside').flat()).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    for (const source of [
      "nocite: [{key: '@inner}, @after]\ntitle: @outside",
      'nocite: [{key: "@inner}, @after]\ntitle: @outside',
    ]) {
      for (const key of ['@inner', '@after']) {
        expect(scopesForText(grammar, source, key).flat()).toContain(
          'support.function.citation.manuscript-markdown',
        );
      }
      expect(scopesForText(grammar, source, '@outside').flat()).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    for (const source of [
      'nocite: [\n  \'@inner\n-custom: @outside',
      'nocite: [\n  "@inner\n-custom: @outside',
    ]) {
      expect(scopesForText(grammar, source, '@inner').flat()).toContain(
        'support.function.citation.manuscript-markdown',
      );
      expect(scopesForText(grammar, source, '@outside').flat()).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    for (const source of [
      'nocite: [@first, {nested: @second}]\ntitle: @outside',
      'nocite:\n  - @first\n  - nested: @second\ntitle: @outside',
    ]) {
      for (const key of ['@first', '@second']) {
        expect(scopesForText(grammar, source, key).flat()).toContain(
          'support.function.citation.manuscript-markdown',
        );
      }
      expect(scopesForText(grammar, source, '@outside').flat()).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    for (const source of [
      'nocite: [\n  @alpha\n] @outside',
      'nocite: [\n  @alpha\n}\ntitle: @outside',
      'nocite:\n-custom: @outside',
      'nocite: [\n  @alpha\n-custom: @outside',
    ]) {
      expect(
        scopesForText(grammar, source, '@outside').flat(),
      ).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }
    expect(
      scopesForText(
        grammar,
        'nocite: |++\n  @hidden',
        '@hidden',
      ).flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );

    const plainApostrophe = [
      "nocite: author's note # @hidden",
      'title: Draft',
    ].join('\n');
    expect(
      scopesForText(grammar, plainApostrophe, '@hidden').flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );
    const titleScopes = scopesForText(
      grammar,
      plainApostrophe,
      'Draft',
    ).flat();
    expect(titleScopes).not.toContain(
      'meta.nocite.manuscript-markdown',
    );
    expect(titleScopes).not.toContain(
      'string.quoted.single.yaml',
    );
    expect(
      scopesForText(
        grammar,
        "nocite: [author's note, '@active']",
        '@active',
      ).flat(),
    ).toContain(
      'support.function.citation.manuscript-markdown',
    );

    const blockScalarOutdent = [
      'nocite: |',
      '  @inside',
      '  # literal scalar comment with @comment',
      '  @after-comment',
      '-custom: @outside',
      'title @also-outside',
    ].join('\n');
    for (const key of ['@inside', '@comment', '@after-comment']) {
      expect(
        scopesForText(grammar, blockScalarOutdent, key).flat(),
      ).toContain(
        'support.function.citation.manuscript-markdown',
      );
    }
    for (const key of ['@outside', '@also-outside']) {
      expect(
        scopesForText(grammar, blockScalarOutdent, key).flat(),
      ).not.toContain(
        'support.function.citation.manuscript-markdown',
      );
    }

    const nested = [
      '  settings:',
      '# outdented comment',
      '    nocite: \'@nested\'',
      '  nocite: |',
      '    label: @root',
      '  title: @not-nocite',
    ].join('\n');

    expect(
      scopesForText(grammar, nested, '@nested')
        .flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(
      scopesForText(grammar, nested, '@root')
        .flat(),
    ).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(
      scopesForText(grammar, nested, '@not-nocite')
        .flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );

    const tabIndented = [
      '\tnocite:',
      '\t\t- @tab-root',
      '\ttitle: @tab-not-nocite',
    ].join('\n');
    expect(
      scopesForText(grammar, tabIndented, '@tab-root')
        .flat(),
    ).toContain(
      'support.function.citation.manuscript-markdown',
    );
    expect(
      scopesForText(grammar, tabIndented, '@tab-not-nocite')
        .flat(),
    ).not.toContain(
      'support.function.citation.manuscript-markdown',
    );

    const closed = [
      'title: Example',
      '---',
      'Body cites @body',
    ].join('\n');
    expect(
      scopesForText(grammar, closed, '@body')
        .flat(),
    ).not.toContain(
      'meta.frontmatter-root.manuscript-markdown',
    );
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
