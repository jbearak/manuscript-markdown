// src/html-comment-inert-zones.test.ts
// Task 3.6: Verify that <!-- --> inside inert zones (code, math, CriticMarkup)
// is NOT treated as an HTML comment. markdown-it should tokenize these as their
// respective content types, not as html_inline or html_block.
//
// Property 3: Inert Zone Exclusion — Comments Inside Inert Zones Are Literal Text
// **Validates: Requirements 2.6, 2.7, 2.8**

import { describe, test, expect } from 'bun:test';
import { parseMd, type MdToken, type MdRun } from './md-to-docx';

/** Recursively collect all runs from parsed tokens */
function allRuns(tokens: MdToken[]): MdRun[] {
  return tokens.flatMap(t => t.runs);
}

describe('Inert Zone Exclusion — <!-- --> inside inert zones is NOT an HTML comment', () => {

  // Requirement 2.7: code regions
  describe('Code regions (Requirement 2.7)', () => {

    test('inline code: `<!-- comment -->` produces code_inline, not html_comment', () => {
      const md = 'before `<!-- comment -->` after';
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a code run containing the literal <!-- comment -->
      const codeRuns = runs.filter(r => r.code === true);
      expect(codeRuns.length).toBe(1);
      expect(codeRuns[0].text).toBe('<!-- comment -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });

    test('fenced code block: <!-- comment --> is code_block content, not html_block', () => {
      const md = '```\n<!-- comment -->\n```';
      const tokens = parseMd(md);

      // Should produce a code_block token
      const codeBlock = tokens.find(t => t.type === 'code_block');
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.runs[0].text).toContain('<!-- comment -->');
      expect(codeBlock!.runs[0].type).toBe('text');

      // Must NOT have any paragraph with html_comment runs
      const commentRuns = allRuns(tokens).filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });
  });

  // Requirement 2.6: LaTeX math regions
  describe('LaTeX math regions (Requirement 2.6)', () => {

    test('inline math: $<!-- comment -->$ produces math run, not html_comment', () => {
      const md = 'before $<!-- comment -->$ after';
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a math run containing the literal <!-- comment -->
      const mathRuns = runs.filter(r => r.type === 'math');
      expect(mathRuns.length).toBe(1);
      expect(mathRuns[0].text).toBe('<!-- comment -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });

    test('display math: $$ with <!-- comment --> produces math run, not html_comment', () => {
      // Per AGENTS.md: never use $$ in code touched by tool text-replacement operations.
      // Use string concatenation to build the markdown.
      // Note: this markdown-it config uses an inline rule for display math,
      // so $$...$$ must be on the same line (not separated by newlines).
      const dollarSign = '$';
      const md = dollarSign + dollarSign + 'x + <!-- comment --> + y' + dollarSign + dollarSign;
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a math run (display) containing the comment text as literal math content
      const mathRuns = runs.filter(r => r.type === 'math' && r.display === true);
      expect(mathRuns.length).toBe(1);
      expect(mathRuns[0].text).toContain('<!-- comment -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });
  });

  // Requirement 2.8: CriticMarkup regions
  describe('CriticMarkup regions (Requirement 2.8)', () => {

    test('CriticMarkup comment: {>> <!-- note --> <<} passes through as CriticMarkup content', () => {
      const md = 'text {>> <!-- note --> <<} more';
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a critic_comment run, not an html_comment run
      const criticRuns = runs.filter(r => r.type === 'critic_comment');
      expect(criticRuns.length).toBe(1);

      // The comment text should contain the <!-- note --> as literal text
      const criticRun = criticRuns[0];
      expect(criticRun.commentText).toContain('<!-- note -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });

    test('CriticMarkup addition: {++ <!-- added --> ++} passes through as CriticMarkup content', () => {
      const md = 'text {++ <!-- added --> ++} more';
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a critic_add run containing the literal <!-- added -->
      const addRuns = runs.filter(r => r.type === 'critic_add');
      expect(addRuns.length).toBe(1);
      expect(addRuns[0].text).toContain('<!-- added -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });

    test('CriticMarkup deletion: {-- <!-- deleted --> --} passes through as CriticMarkup content', () => {
      const md = 'text {-- <!-- deleted --> --} more';
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a critic_del run containing the literal <!-- deleted -->
      const delRuns = runs.filter(r => r.type === 'critic_del');
      expect(delRuns.length).toBe(1);
      expect(delRuns[0].text).toContain('<!-- deleted -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });

    test('CriticMarkup highlight: {== <!-- highlighted --> ==} passes through as CriticMarkup content', () => {
      const md = 'text {== <!-- highlighted --> ==} more';
      const tokens = parseMd(md);

      const para = tokens.find(t => t.type === 'paragraph');
      expect(para).toBeDefined();

      const runs = para!.runs;
      // Should have a critic_highlight run
      const hlRuns = runs.filter(r => r.type === 'critic_highlight');
      expect(hlRuns.length).toBe(1);
      // The text (after stripping ==...==) should contain the comment literal
      expect(hlRuns[0].text).toContain('<!-- highlighted -->');

      // Must NOT have any html_comment run
      const commentRuns = runs.filter(r => r.type === 'html_comment');
      expect(commentRuns.length).toBe(0);
    });
  });
});
