import { describe, it, expect } from 'bun:test';
import * as formatting from './formatting';
import * as fs from 'fs';
import * as path from 'path';
import * as fc from 'fast-check';
import { readCitationItems } from './citation-syntax';

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

describe('Syntax grammar citation keys', () => {
  const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json'), 'utf-8'));
  const rule = grammar.repository.citation_list;
  // A pattern of the grammar's as a JS regex: Oniguruma's possessive
  // quantifiers as greedy ones, which match the same here, and \G, where
  // the begin pattern's match ended, as right after the [ a line starts
  // with, which each line here does
  const asRegExp = (source: string, flags: string) => new RegExp(source.replace(/([+*?])\+/g, '$1').replace(/\\G/g, '(?<=^\\[)'), flags);
  const KEY_SCOPE = 'support.function.citation.manuscript-markdown';

  /** The keys the grammar colors in `line`, a citation on one line, each
   *  with where it starts: from after the [ its begin pattern reads, at
   *  each step the earliest match of its end or of a pattern in it, its
   *  end first where they tie, as vscode-textmate scans, from where the
   *  last ended; and of each match, the text in the key's scope, but for
   *  the @ that starts it */
  const coloredKeys = (line: string): Array<[number, string]> => {
    if (!asRegExp(rule.begin, 'yu').test(line)) return [];
    const end = asRegExp(rule.end, 'gdu');
    const patterns = (rule.patterns as Array<{ match: string; name?: string; captures?: Record<string, { name?: string }> }>)
      .map(pattern => ({ ...pattern, regex: asRegExp(pattern.match, 'gdu') }));
    const keys: Array<[number, string]> = [];
    for (let at = 1; at < line.length;) {
      end.lastIndex = at;
      let best = end.exec(line);
      let bestPattern: (typeof patterns)[number] | undefined;
      for (const pattern of patterns) {
        pattern.regex.lastIndex = at;
        const match = pattern.regex.exec(line);
        if (match && (!best || match.index < best.index)) {
          best = match;
          bestPattern = pattern;
        }
      }
      if (!best || !bestPattern) break;
      const ranges: Array<[number, number]> = bestPattern.name === KEY_SCOPE ? [best.indices![0]] : [];
      for (const [group, capture] of Object.entries(bestPattern.captures ?? {})) {
        const range = best.indices![Number(group)];
        if (capture.name === KEY_SCOPE && range && range[0] < range[1]) ranges.push(range);
      }
      ranges.sort((a, b) => a[0] - b[0]);
      if (ranges.length > 0) {
        const start = line[ranges[0][0]] === '@' ? ranges[0][0] + 1 : ranges[0][0];
        const stop = ranges[ranges.length - 1][1];
        const first = ranges.find(range => range[1] > start);
        if (first && start < stop) keys.push([Math.max(start, first[0]), line.slice(Math.max(start, first[0]), stop)]);
      }
      at = Math.max(best.index + best[0].length, at + 1);
    }
    return keys;
  };
  // The keys export reads in it, each with where it starts (see
  // readCitationItem)
  const readKeys = (line: string): Array<[number, string]> => readCitationItems(line.slice(1, line.indexOf(']')))
    .filter(item => item.markStart !== -1 && item.key)
    .map(item => [1 + item.itemStart + item.keyStart, item.key]);

  // Which colored a key's letters, digits, _, : and -, so only smith of
  // smith.2020, where export reads a key to its item's comma
  it.each([
    ['a period', '[@smith.2020]'],
    ['a slash, after a prefix, before a locator', '[see @a/b, p. 3]'],
    ['letters of another language', '[@\u00E9t\u00E9; -@b2]'],
    ['an @ in it, and an @ in a prefix', '[me@x.com @a@b]'],
    ['a space after its @', '[@ smith]'],
    ['an @ in its locator', '[@a, see @b; @c]'],
    ['an @ after a [ in its locator', '[@a, [ @b]'],
    ['an @ after a [ that starts an item', '[@a; [@b; x [@c]'],
  ])('colors a key with %s as export reads it', (_name, line) => {
    expect(coloredKeys(line)).toEqual(readKeys(line));
    expect(coloredKeys(line).length).toBeGreaterThan(0);
  });

  /**
   * The grammar colors each key of a citation on one line as export reads
   * it (see readCitationItem): after the @ at its item's start or after a
   * space, to its item's comma, without the spaces at its edges, and none
   * in a prefix or a locator.
   */
  it('colors each key of a citation as export reads it', () => {
    const word = fc.array(fc.constantFrom('a', 'Z', '0', '_', '.', '/', ':', '-', '+', "'", '\u00E9', '@', '[', '`', '\\', '#', '$', '&'), { minLength: 1, maxLength: 4 })
      .map(chars => chars.join(''));
    const words = fc.array(word, { minLength: 1, maxLength: 3 }).map(parts => parts.join(' '));
    const item = fc.tuple(fc.option(words, { nil: undefined }), fc.constantFrom('', '-'), fc.constantFrom('', ' '), words, fc.option(words, { nil: undefined }), fc.constantFrom('', ' '))
      .map(([prefix, dash, space, key, locator, pad]) => pad + (prefix ? prefix + ' ' : '') + dash + '@' + space + key + (locator ? ', ' + locator : '') + pad);
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 3 }), items => {
        const line = '[' + items.join(';') + ']';
        // A citation the grammar reads as one, at its [
        if (!asRegExp(rule.begin, 'yu').test(line)) return true;
        const colored = coloredKeys(line);
        const read = readKeys(line);
        if (JSON.stringify(colored) !== JSON.stringify(read)) throw new Error(JSON.stringify(line) + ' colored ' + JSON.stringify(colored) + ', not ' + JSON.stringify(read));
        return true;
      }),
      { numRuns: 3000 }
    );
  });
});

describe('Syntax grammar format highlights', () => {
  const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'manuscript-markdown.json'), 'utf-8'));
  const HIGHLIGHT_SCOPES = ['markup.highlight.colored.manuscript-markdown', 'markup.highlight.manuscript-markdown'];
  type MatchRule = { match: string; name?: string; captures?: Record<string, { name?: string }> };
  // Its two format highlight patterns, in the order its patterns list them,
  // as JS regexes: Oniguruma's possessive quantifiers as greedy ones, which
  // match the same here
  const rules = ['colored_format_highlight', 'format_highlight'].map(key => {
    const rule = grammar.repository[key] as MatchRule;
    return { rule, regex: new RegExp(rule.match.replace(/([+*?])\+/g, '$1'), 'gd') };
  });

  /** The text the grammar scopes as a format highlight in `line`: at each
   *  step the earliest match of either pattern, the first listed where they
   *  tie, from where the last ended, as vscode-textmate scans, other
   *  patterns aside */
  const highlighted = (line: string): string[] => {
    const found: string[] = [];
    for (let at = 0; at < line.length;) {
      let best: RegExpExecArray | null = null;
      let bestRule: MatchRule | undefined;
      for (const { rule, regex } of rules) {
        regex.lastIndex = at;
        const match = regex.exec(line);
        if (match && (!best || match.index < best.index)) {
          best = match;
          bestRule = rule;
        }
      }
      if (!best || !bestRule) break;
      const groups = Object.entries(bestRule.captures ?? {})
        .filter(([, capture]) => HIGHLIGHT_SCOPES.includes(capture.name ?? ''))
        .map(([group]) => Number(group));
      if (HIGHLIGHT_SCOPES.includes(bestRule.name ?? '')) groups.push(0);
      for (const group of groups) {
        const [start, end] = best.indices![group];
        found.push(line.slice(start, end));
      }
      at = Math.max(best.index + best[0].length, at + 1);
    }
    return found;
  };

  // An == after an odd run of backslashes opens no highlight, as export and
  // the preview read it: the last backslash escapes its first =. One before
  // a closing == escapes nothing, as in export.
  it.each<[string, string, string[]]>([
    ['an escaped opener before a highlight', 'a \\== b ==c==', ['==c==']],
    ['an escaped opener', '\\==x==', []],
    ['an opener after three backslashes', '\\\\\\==x== y', []],
    ['an escaped opener of a colored highlight', 'x \\==a=={red} y', []],
    ['the opener after an escaped one', '\\==a==b==', ['==b==']],
    ['an escaped opener right after a highlight', '==a\\==\\==b==', ['==a\\==']],
    ['a highlight', 'a ==x== b', ['==x==']],
    ['a colored highlight', 'a ==x=={red} b', ['==x=={red}']],
    ['a critic highlight, which another rule reads', 'a {==x==} b', []],
    ['a highlight after an escaped backslash', 'a \\\\==x== b', ['==x==']],
    ['a highlight after two escaped backslashes', 'a \\\\\\\\==x== b', ['==x==']],
    ['a colored highlight after an escaped backslash', '\\\\==x=={red}', ['==x=={red}']],
    ['a backslash before the closer, which escapes none', '==a\\== b', ['==a\\==']],
  ])('scopes %s as export reads it', (_name, line, expected) => {
    expect(highlighted(line)).toEqual(expected);
  });
});
