// src/html-comment-preservation.property.test.ts
// Preservation property tests: verify that non-comment HTML tags and existing behavior
// remain unchanged. These tests MUST PASS on unfixed code (baseline behavior to preserve).

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { parseMd, type MdRun, type MdToken } from './md-to-docx';

// Short alphanumeric generator per AGENTS.md guidance (short bounded generators)
const shortAlphaNum = fc.string({ minLength: 1, maxLength: 8 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s));

describe('Property 2: Preservation — Non-Comment HTML Tags and Existing Behavior Unchanged', () => {

  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * Property 2a: For any short alphanumeric text, `<u>${text}</u>` parsed through
   * parseMd() produces a paragraph with a run that has underline: true and the text content.
   * Formatting tag handling is preserved.
   */
  test('2a: <u> tag produces underline formatting for any text', () => {
    fc.assert(
      fc.property(shortAlphaNum, (text) => {
        const md = '<u>' + text + '</u>';
        const tokens = parseMd(md);

        expect(tokens.length).toBeGreaterThan(0);
        const para = tokens.find(t => t.type === 'paragraph');
        expect(para).toBeDefined();

        const runs = para!.runs;
        // Should have exactly one text run with underline: true
        const underlineRuns = runs.filter(r => r.type === 'text' && r.underline === true);
        expect(underlineRuns.length).toBe(1);
        expect(underlineRuns[0].text).toBe(text);
      }),
      { numRuns: 30, verbose: true }
    );
  }, { timeout: 10000 });

  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * Property 2b: For any short alphanumeric text, `<sup>${text}</sup>` produces
   * superscript: true and `<sub>${text}</sub>` produces subscript: true.
   */
  test('2b: <sup> and <sub> tags produce superscript/subscript formatting', () => {
    fc.assert(
      fc.property(shortAlphaNum, (text) => {
        // Test superscript
        const supMd = '<sup>' + text + '</sup>';
        const supTokens = parseMd(supMd);

        expect(supTokens.length).toBeGreaterThan(0);
        const supPara = supTokens.find(t => t.type === 'paragraph');
        expect(supPara).toBeDefined();

        const supRuns = supPara!.runs.filter(r => r.type === 'text' && r.superscript === true);
        expect(supRuns.length).toBe(1);
        expect(supRuns[0].text).toBe(text);

        // Test subscript
        const subMd = '<sub>' + text + '</sub>';
        const subTokens = parseMd(subMd);

        expect(subTokens.length).toBeGreaterThan(0);
        const subPara = subTokens.find(t => t.type === 'paragraph');
        expect(subPara).toBeDefined();

        const subRuns = subPara!.runs.filter(r => r.type === 'text' && r.subscript === true);
        expect(subRuns.length).toBe(1);
        expect(subRuns[0].text).toBe(text);
      }),
      { numRuns: 30, verbose: true }
    );
  }, { timeout: 10000 });

  /**
   * **Validates: Requirements 3.1, 3.3, 3.4, 3.5, 3.6**
   *
   * Property 2c: For any short alphanumeric text with no HTML comments,
   * parseMd() output is stable — same input always produces the same token structure.
   */
  test('2c: parseMd output is stable for plain text without HTML comments', () => {
    fc.assert(
      fc.property(shortAlphaNum, (text) => {
        // Plain paragraph text (no HTML comments)
        const md = 'Hello ' + text + ' world';
        const tokens1 = parseMd(md);
        const tokens2 = parseMd(md);

        // Serialize to compare structure — same input must yield identical output
        const json1 = JSON.stringify(tokens1);
        const json2 = JSON.stringify(tokens2);
        expect(json1).toBe(json2);

        // Also verify basic structure: should produce at least one paragraph
        expect(tokens1.length).toBeGreaterThan(0);
        const para = tokens1.find(t => t.type === 'paragraph');
        expect(para).toBeDefined();
        // The paragraph should contain the text
        const allText = para!.runs.filter(r => r.type === 'text').map(r => r.text).join('');
        expect(allText).toContain(text);
      }),
      { numRuns: 30, verbose: true }
    );
  }, { timeout: 10000 });
});
