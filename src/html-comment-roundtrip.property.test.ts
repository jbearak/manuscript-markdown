// src/html-comment-roundtrip.property.test.ts
// Bug condition exploration test: HTML comments are silently dropped during MD → DOCX conversion
// This test encodes the EXPECTED behavior — it will FAIL on unfixed code (confirming the bug)
// and PASS after the fix is implemented.

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { parseMd, type MdRun } from './md-to-docx';

/**
 * Checks whether any run in a flat list of MdRun[] contains the given comment text.
 * Looks for a run whose text includes the comment content (with or without delimiters).
 */
function runsContainComment(runs: MdRun[], commentText: string): boolean {
  return runs.some(r =>
    r.text.includes(commentText) &&
    (r.text.includes('<!--') || r.type === 'html_comment')
  );
}

// Short alphanumeric generator per AGENTS.md guidance (short bounded generators)
const shortAlphaNum = fc.string({ minLength: 1, maxLength: 10 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s));

describe('Property 1: Fault Condition — HTML Comments Dropped During MD → DOCX Conversion', () => {

  /**
   * **Validates: Requirements 1.1**
   *
   * Inline comment: `text <!-- c --> more` parsed through parseMd()
   * should yield a run containing the comment — but on unfixed code,
   * processInlineChildren() produces no run for html_inline comment tokens.
   */
  test('inline HTML comment must be preserved as a run in parsed tokens', () => {
    fc.assert(
      fc.property(shortAlphaNum, (c) => {
        const md = 'text <!-- ' + c + ' --> more';
        const tokens = parseMd(md);

        // Should produce at least one paragraph token
        expect(tokens.length).toBeGreaterThan(0);
        const para = tokens.find(t => t.type === 'paragraph');
        expect(para).toBeDefined();

        // The paragraph's runs should contain the comment content
        const runs = para!.runs;
        const hasComment = runsContainComment(runs, c);
        expect(hasComment).toBe(true);
      }),
      { numRuns: 20, verbose: true }
    );
  }, { timeout: 10000 });

  /**
   * **Validates: Requirements 1.2**
   *
   * Standalone block comment: `<!-- c -->` on its own line parsed as html_block
   * should produce a token preserving the comment — but on unfixed code,
   * convertTokens() only extracts HTML tables from html_block, producing nothing.
   */
  test('standalone block HTML comment must produce a token', () => {
    fc.assert(
      fc.property(shortAlphaNum, (c) => {
        const md = '<!-- ' + c + ' -->';
        const tokens = parseMd(md);

        // On unfixed code, this produces zero tokens (comment silently dropped)
        // On fixed code, should produce a token containing the comment
        expect(tokens.length).toBeGreaterThan(0);

        // At least one token should have a run referencing the comment
        const hasComment = tokens.some(t => runsContainComment(t.runs, c));
        expect(hasComment).toBe(true);
      }),
      { numRuns: 20, verbose: true }
    );
  }, { timeout: 10000 });

  /**
   * **Validates: Requirements 1.4**
   *
   * Multiple inline comments: `A <!-- c1 --> B <!-- c2 --> C`
   * Both comments should be present in the parsed runs — but on unfixed code,
   * both are silently dropped by processInlineChildren().
   */
  test('multiple inline HTML comments must all be preserved', () => {
    fc.assert(
      fc.property(shortAlphaNum, shortAlphaNum, (c1, c2) => {
        fc.pre(c1 !== c2);
        const md = 'A <!-- ' + c1 + ' --> B <!-- ' + c2 + ' --> C';
        const tokens = parseMd(md);

        expect(tokens.length).toBeGreaterThan(0);
        const para = tokens.find(t => t.type === 'paragraph');
        expect(para).toBeDefined();

        const runs = para!.runs;

        // Both comments should be present
        const hasFirst = runsContainComment(runs, c1);
        const hasSecond = runsContainComment(runs, c2);
        expect(hasFirst).toBe(true);
        expect(hasSecond).toBe(true);
      }),
      { numRuns: 20, verbose: true }
    );
  }, { timeout: 10000 });
});
