// src/tokenize-comments.test.ts
// Unit tests for tokenize() comment handling (Task 3.9)
// Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1

import { describe, test, expect } from 'bun:test';
import { tokenize, Token } from './latex-to-omml';

/** Helper: return only tokens of the given type */
function tokensOfType(tokens: Token[], type: Token['type']): Token[] {
  return tokens.filter(t => t.type === type);
}

describe('tokenize() comment handling', () => {

  test('% in middle of line produces a comment token with whitespace and text', () => {
    const tokens = tokenize('x^2 % superscript');
    const comments = tokensOfType(tokens, 'comment');
    expect(comments).toHaveLength(1);
    // The comment token value should contain the preceding whitespace + % + comment text
    expect(comments[0].value).toContain('%');
    expect(comments[0].value).toContain('superscript');
    // Preceding whitespace (the space before %) should be captured
    expect(comments[0].value).toMatch(/^\s+%/);
  });

  test('% at start of line produces a comment token', () => {
    const tokens = tokenize('% start of line comment');
    const comments = tokensOfType(tokens, 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].value).toContain('%');
    expect(comments[0].value).toContain('start of line comment');
  });

  test('% at end of line with no text produces a line_continuation token', () => {
    const input = 'x + y%' + '\n' + '+ z';
    const tokens = tokenize(input);
    const continuations = tokensOfType(tokens, 'line_continuation');
    expect(continuations).toHaveLength(1);
    expect(continuations[0].value).toContain('%');
    // Should NOT produce a comment token for this case
    const comments = tokensOfType(tokens, 'comment');
    expect(comments).toHaveLength(0);
  });

  test('escaped \\% does NOT produce comment tokens', () => {
    const tokens = tokenize('50\\% discount');
    const comments = tokensOfType(tokens, 'comment');
    const continuations = tokensOfType(tokens, 'line_continuation');
    expect(comments).toHaveLength(0);
    expect(continuations).toHaveLength(0);
    // The \\% should be a command token
    const commands = tokensOfType(tokens, 'command');
    const percentCmd = commands.find(t => t.value === '\\%');
    expect(percentCmd).toBeDefined();
  });

  test('multiple % comments across multiple lines', () => {
    const input = 'x^2          % superscript' + '\n' + 'x_i          % subscript';
    const tokens = tokenize(input);
    const comments = tokensOfType(tokens, 'comment');
    expect(comments).toHaveLength(2);
    expect(comments[0].value).toContain('superscript');
    expect(comments[1].value).toContain('subscript');
  });

  test('comment token does not include text before %', () => {
    const tokens = tokenize('abc % comment');
    // The text 'abc' should be in a text token, not in the comment
    const textTokens = tokensOfType(tokens, 'text');
    const hasAbc = textTokens.some(t => t.value.includes('abc'));
    expect(hasAbc).toBe(true);
    // The comment token should not contain 'abc'
    const comments = tokensOfType(tokens, 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].value).not.toContain('abc');
  });

  test('comment token preserves preceding whitespace between content and %', () => {
    // Multiple spaces before %
    const tokens = tokenize('x^2          % superscript');
    const comments = tokensOfType(tokens, 'comment');
    expect(comments).toHaveLength(1);
    // The value should start with the whitespace, then %
    const val = comments[0].value;
    const percentIdx = val.indexOf('%');
    expect(percentIdx).toBeGreaterThan(0); // whitespace before %
    const ws = val.slice(0, percentIdx);
    // All characters before % should be whitespace
    expect(ws.trim()).toBe('');
    expect(ws.length).toBeGreaterThan(0);
  });

  test('line_continuation consumes the newline', () => {
    const input = 'a%' + '\n' + 'b';
    const tokens = tokenize(input);
    const continuations = tokensOfType(tokens, 'line_continuation');
    expect(continuations).toHaveLength(1);
    // After the line_continuation, the next token should be text 'b' (newline consumed)
    const textTokens = tokensOfType(tokens, 'text');
    const hasB = textTokens.some(t => t.value === 'b');
    expect(hasB).toBe(true);
    // No text token should contain a newline from the continuation
    const hasNewline = textTokens.some(t => t.value === '\n');
    expect(hasNewline).toBe(false);
  });
});
