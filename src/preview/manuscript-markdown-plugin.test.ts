import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import { manuscriptMarkdownPlugin } from './manuscript-markdown-plugin';
import type { EmbedResolver } from '../embed-preprocess';
import { VALID_COLOR_IDS, setDefaultHighlightColor, getDefaultHighlightColor } from '../highlight-colors';
import { escapeHtml, stripHtmlTags, hasNoSpecialSyntax, renderWithPlugin, SIMPLE_CRITIC_TYPES } from '../test-helpers';
import { LINE_PLACEHOLDER, PARA_PLACEHOLDER } from '../critic-markup';
import * as fs from 'fs';
import * as path from 'path';

function makeEmbedResolver(files: Record<string, string>): EmbedResolver {
  return {
    readFile(absolutePath: string): Uint8Array | null {
      const content = files[absolutePath];
      if (content === undefined) return null;
      return new TextEncoder().encode(content);
    },
    resolveRelative(basePath: string, relativePath: string): string {
      const baseDir = basePath.replace(/\/[^/]*$/, '');
      return baseDir + '/' + relativePath;
    },
  };
}

function renderWithEmbedSetup(
  input: string,
  resolver: EmbedResolver,
  env?: Record<string, unknown>,
  documentPath?: string,
  getDocumentPath?: (src: string) => string | undefined,
): string {
  const md = new MarkdownIt({ html: true });
  (md as any).manuscriptEmbedResolver = resolver;
  if (documentPath) {
    (md as any).manuscriptDocumentPath = documentPath;
  }
  if (getDocumentPath) {
    (md as any).manuscriptGetDocumentPath = getDocumentPath;
  }
  md.use(manuscriptMarkdownPlugin);
  return md.render(input, env);
}

describe('Manuscript Markdown Plugin Property Tests', () => {
  describe('GFM alerts', () => {
    it('renders NOTE alert with title row and strips marker text', () => {
      const html = renderWithPlugin('> [!NOTE]\n> Useful information.');
      expect(html).toContain('markdown-alert markdown-alert-note');
      expect(html).toContain('markdown-alert-title');
      expect(html).toContain('octicon markdown-alert-icon');
      expect(html).toContain('Note');
      expect(html).toContain('Useful information.');
      expect(html).not.toContain('[!NOTE]');
    });

    it('omits alert title rows and injects the scoped fallback style when callout-labels is false', () => {
      const html = renderWithPlugin(
        '---\ncallout-labels: false\n---\n\n' +
        '> [!NOTE]\n> Useful information.'
      );
      expect(html).toContain('markdown-alert markdown-alert-note');
      expect(html).toContain('Useful information.');
      expect(html).not.toContain('<p class="markdown-alert-title">');
      expect(html).not.toContain('octicon markdown-alert-icon');
      expect(html).toContain('.markdown-alert > .markdown-alert-title { display: none !important; }');
      expect(html).not.toContain('[!NOTE]');
    });

    it('removes the marker line break when labels are hidden in breaks mode', () => {
      const html = renderWithPlugin(
        '---\ncallout-labels: false\nbreaks: true\n---\n\n' +
        '> [!NOTE] <!--a--> <!--b-->\n> Useful information.'
      );
      expect(html).toContain('<!--a--> <!--b-->');
      expect(html).toContain('Useful information.');
      const alertHtml = html.slice(html.indexOf('<blockquote'));
      expect(alertHtml).not.toContain('<br>');
    });

    it('removes an empty marker paragraph before block content', () => {
      const html = renderWithPlugin(
        '---\ncallout-labels: false\n---\n\n> [!NOTE] <!--a--> <!--b-->\n> - item'
      );
      const alertHtml = html.slice(html.indexOf('<blockquote'));
      expect(alertHtml).toContain('<!--a--> <!--b-->');
      expect(alertHtml).toContain('<li>item</li>');
      expect(alertHtml).not.toContain('<p><!--a--> <!--b--></p>');
      expect(alertHtml).not.toContain('<p></p>');
    });

    it('keeps alert labels enabled when callout-labels is true or omitted', () => {
      const explicit = renderWithPlugin('---\ncallout-labels: true\n---\n\n> [!TIP]\n> Explicit.');
      const omitted = renderWithPlugin('> [!TIP]\n> Default.');
      for (const html of [explicit, omitted]) {
        expect(html).toContain('<p class="markdown-alert-title">');
        expect(html).toContain('octicon markdown-alert-icon');
        expect(html).not.toContain('.markdown-alert > .markdown-alert-title { display: none !important; }');
      }
    });

    it('preserves alert colors, classes, and bodies when callout labels are disabled', () => {
      const html = renderWithPlugin(
        '---\ncallout-labels: false\ncolors: guttmacher\n---\n\n' +
        '> [!WARNING]\n> Colored warning.'
      );
      expect(html).toContain('markdown-alert-warning color-scheme-guttmacher');
      expect(html).toContain('Colored warning.');
      expect(html).not.toContain('<p class="markdown-alert-title">');
    });

    it('omits title rows for multiple adjacent alerts when callout labels are disabled', () => {
      const html = renderWithPlugin(
        '---\ncallout-labels: false\n---\n\n' +
        '> [!NOTE]\n> A note.\n> [!WARNING]\n> A warning.\n> [!TIP]\n> A tip.'
      );
      expect((html.match(/class="markdown-alert markdown-alert-/g) || []).length).toBe(3);
      expect(html).toContain('A note.');
      expect(html).toContain('A warning.');
      expect(html).toContain('A tip.');
      expect(html).not.toContain('<p class="markdown-alert-title">');
      expect(html).not.toContain('octicon markdown-alert-icon');
    });

    it('renders all alert variants with per-type classes and title case labels', () => {
      const html = renderWithPlugin(
        '> [!TIP]\n> tip text\n\n' +
        '> [!IMPORTANT]\n> important text\n\n' +
        '> [!WARNING]\n> warning text\n\n' +
        '> [!CAUTION]\n> caution text'
      );
      expect(html).toContain('markdown-alert-tip');
      expect(html).toContain('Tip</p>');
      expect(html).toContain('markdown-alert-important');
      expect(html).toContain('Important</p>');
      expect(html).toContain('markdown-alert-warning');
      expect(html).toContain('Warning</p>');
      expect(html).toContain('markdown-alert-caution');
      expect(html).toContain('Caution</p>');
    });

    it('keeps non-alert blockquotes unchanged', () => {
      const html = renderWithPlugin('> regular quote');
      expect(html).toContain('<blockquote>');
      expect(html).not.toContain('markdown-alert');
    });

    it('splits merged blockquote with multiple alert markers into separate alerts', () => {
      const src = '> [!NOTE]\n> A note.\n> [!WARNING]\n> A warning.\n> [!TIP]\n> A tip.';
      const html = renderWithPlugin(src);
      expect(html).toContain('markdown-alert-note');
      expect(html).toContain('markdown-alert-warning');
      expect(html).toContain('markdown-alert-tip');
      expect(html).toContain('Note</p>');
      expect(html).toContain('Warning</p>');
      expect(html).toContain('Tip</p>');
      expect(html).not.toContain('[!NOTE]');
      expect(html).not.toContain('[!WARNING]');
      expect(html).not.toContain('[!TIP]');
    });

    it('preserves plain blockquote content before first alert marker in merged blockquote', () => {
      const html = renderWithPlugin('> Plain text.\n> [!NOTE]\n> A note.');
      expect(html).toContain('Plain text.');
      expect(html).toContain('markdown-alert-note');
    });

    it('adds color-scheme-guttmacher class when frontmatter has colors: guttmacher', () => {
      const html = renderWithPlugin('---\ncolors: guttmacher\n---\n\n> [!NOTE]\n> Useful information.');
      expect(html).toContain('color-scheme-guttmacher');
      expect(html).toContain('markdown-alert-note');
    });

    it('adds color-scheme-guttmacher class by default (guttmacher is the default scheme)', () => {
      const html = renderWithPlugin('> [!NOTE]\n> Useful information.');
      expect(html).toContain('color-scheme-guttmacher');
      expect(html).toContain('markdown-alert-note');
    });

    it('does not add color-scheme class when frontmatter has colors: github', () => {
      const html = renderWithPlugin('---\ncolors: github\n---\n\n> [!NOTE]\n> Useful information.');
      expect(html).not.toContain('color-scheme-guttmacher');
      expect(html).toContain('markdown-alert-note');
    });

    it('applies color-scheme-guttmacher to all alert types', () => {
      const html = renderWithPlugin(
        '---\ncolors: guttmacher\n---\n\n' +
        '> [!NOTE]\n> note\n\n' +
        '> [!TIP]\n> tip\n\n' +
        '> [!IMPORTANT]\n> important\n\n' +
        '> [!WARNING]\n> warning\n\n' +
        '> [!CAUTION]\n> caution'
      );
      for (const type of ['note', 'tip', 'important', 'warning', 'caution']) {
        expect(html).toContain('markdown-alert-' + type + ' color-scheme-guttmacher');
      }
    });
  });

  // Property 1: Manuscript Markdown pattern transformation (genuine property-based tests)
  describe('Property 1: Manuscript Markdown pattern transformation', () => {
    it('should transform addition patterns into HTML with correct CSS class', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)),
          (text) => {
            const output = renderWithPlugin('{++' + text + '++}');
            expect(output).toContain('manuscript-markdown-addition');
            expect(output).toContain(escapeHtml(text));
            expect(output).toContain('<ins');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should transform deletion patterns into HTML with correct CSS class', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)),
          (text) => {
            const output = renderWithPlugin('{--' + text + '--}');
            expect(output).toContain('manuscript-markdown-deletion');
            expect(output).toContain(escapeHtml(text));
            expect(output).toContain('<del');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should transform comment patterns into HTML with correct CSS class', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('<') && !s.includes('>') && hasNoSpecialSyntax(s)),
          (text) => {
            const output = renderWithPlugin('{>>' + text + '<<}');
            expect(output).toContain('manuscript-markdown-comment');
            expect(output).toContain(escapeHtml(text));
            expect(output).toContain('<span');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should transform highlight patterns into HTML with correct CSS class', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)),
          (text) => {
            const output = renderWithPlugin('{==' + text + '==}');
            expect(output).toContain('manuscript-markdown-highlight');
            expect(output).toContain(escapeHtml(text));
            expect(output).toContain('<mark');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should transform substitution patterns into HTML with both deletion and addition styling', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          (oldText, newText) => {
            const output = renderWithPlugin('{~~' + oldText + '~>' + newText + '~~}');
            expect(output).toContain('manuscript-markdown-deletion');
            expect(output).toContain('manuscript-markdown-addition');
            expect(stripHtmlTags(output)).toContain(escapeHtml(oldText));
            expect(stripHtmlTags(output)).toContain(escapeHtml(newText));
            expect(output).toContain('<del');
            expect(output).toContain('<ins');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 2: Multiple instance consistency — parameterized over CriticMarkup types
  describe('Property 2: Multiple instance consistency', () => {
    for (const type of SIMPLE_CRITIC_TYPES) {
      const charFilter = (s: string) => {
        if (s.includes('{') || s.includes('}')) return false;
        if (type.name === 'comment' && (s.includes('<') || s.includes('>'))) return false;
        if (!hasNoSpecialSyntax(s)) return false;
        // Comments with only whitespace are silently removed by the plugin
        if (type.name === 'comment' && s.trim().length === 0) return false;
        // Exclude chars that trigger block-level parsing when they appear in
        // the joined string (e.g. # at start → heading, ( ) → link matching)
        if (s.includes('#') || s.includes('(') || s.includes(')')) return false;
        return true;
      };

      it('should render multiple ' + type.name + 's with consistent HTML structure', () => {
        fc.assert(
          fc.property(
            fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter(charFilter), { minLength: 2, maxLength: 5 }),
            (texts) => {
              const input = texts.map(t => type.open + t + type.close).join(' ');
              const output = renderWithPlugin(input);
              const classCount = (output.match(new RegExp(type.cssClass, 'g')) || []).length;
              expect(classCount).toBe(texts.length);
              texts.forEach(text => {
                const trimmed = escapeHtml(text.trim());
                if (trimmed.length > 0) {
                  // Comments store text in data-comment attrs; others use visible content
                  const searchTarget = (type.name === 'comment' || type.name === 'highlight') ? output : stripHtmlTags(output);
                  expect(searchTarget).toContain(trimmed);
                }
              });
            }
          ),
          { numRuns: 100 }
        );
      });
    }

    it('should render multiple substitutions with consistent HTML structure', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
              fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s))
            ),
            { minLength: 2, maxLength: 5 }
          ),
          (pairs) => {
            const input = pairs.map(([old, newText]) => '{~~' + old + '~>' + newText + '~~}').join(' ');
            const output = renderWithPlugin(input);
            const deletionCount = (output.match(/manuscript-markdown-deletion/g) || []).length;
            const additionCount = (output.match(/manuscript-markdown-addition/g) || []).length;
            expect(deletionCount).toBe(pairs.length);
            expect(additionCount).toBe(pairs.length);
            pairs.forEach(([old, newText]) => {
              const oldTrimmed = escapeHtml(old.trim());
              const newTrimmed = escapeHtml(newText.trim());
              if (oldTrimmed.length > 0) expect(stripHtmlTags(output)).toContain(oldTrimmed);
              if (newTrimmed.length > 0) expect(stripHtmlTags(output)).toContain(newTrimmed);
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 6: List structure preservation (unique list-specific logic, kept as-is)
  describe('Property 6: List structure preservation', () => {
    const validListItemContent = fc.stringMatching(/^[a-zA-Z0-9 ]+$/).filter(s => {
      if (!s || s.trim().length === 0) return false;
      if (s.trim().length < 1) return false;
      if (s.match(/^    /)) return false;
      if (s.trim().length === 0) return false;
      return true;
    });

    const manuscriptMarkdownPattern = fc.constantFrom(
      { type: 'addition', open: '{++', close: '++}', cssClass: 'manuscript-markdown-addition' },
      { type: 'deletion', open: '{--', close: '--}', cssClass: 'manuscript-markdown-deletion' },
      { type: 'comment', open: '{>>', close: '<<}', cssClass: 'manuscript-markdown-comment' },
      { type: 'highlight', open: '{==', close: '==}', cssClass: 'manuscript-markdown-highlight' }
    );

    const nonCommentPattern = fc.constantFrom(
      { type: 'addition', open: '{++', close: '++}', cssClass: 'manuscript-markdown-addition' },
      { type: 'deletion', open: '{--', close: '--}', cssClass: 'manuscript-markdown-deletion' },
      { type: 'highlight', open: '{==', close: '==}', cssClass: 'manuscript-markdown-highlight' }
    );

    it('should preserve unordered list structure with Manuscript Markdown', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(validListItemContent, manuscriptMarkdownPattern, validListItemContent),
            { minLength: 2, maxLength: 5 }
          ),
          (items) => {
            const input = items.map(([prefix, pattern, content]) =>
              '- ' + prefix + ' ' + pattern.open + content + pattern.close
            ).join('\n');
            const output = renderWithPlugin(input);
            expect(output).toContain('<ul>');
            expect(output).toContain('</ul>');
            const liCount = (output.match(/<li>/g) || []).length;
            expect(liCount).toBe(items.length);
            items.forEach(([prefix, pattern, content]) => {
              expect(output).toContain(pattern.cssClass);
              const trimmedContent = content.trim();
              const trimmedPrefix = prefix.trim();
              if (trimmedContent.length > 0) expect(output).toContain(escapeHtml(trimmedContent));
              if (trimmedPrefix.length > 0) expect(output).toContain(escapeHtml(trimmedPrefix));
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should preserve ordered list structure with Manuscript Markdown', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(validListItemContent, manuscriptMarkdownPattern, validListItemContent),
            { minLength: 2, maxLength: 5 }
          ),
          (items) => {
            const input = items.map(([prefix, pattern, content], idx) =>
              (idx + 1) + '. ' + prefix + ' ' + pattern.open + content + pattern.close
            ).join('\n');
            const output = renderWithPlugin(input);
            expect(output).toContain('<ol>');
            expect(output).toContain('</ol>');
            const liCount = (output.match(/<li>/g) || []).length;
            expect(liCount).toBe(items.length);
            items.forEach(([prefix, pattern, content]) => {
              expect(output).toContain(pattern.cssClass);
              const trimmedContent = content.trim();
              const trimmedPrefix = prefix.trim();
              if (trimmedContent.length > 0) expect(output).toContain(escapeHtml(trimmedContent));
              if (trimmedPrefix.length > 0) expect(output).toContain(escapeHtml(trimmedPrefix));
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should preserve list structure with multiple Manuscript Markdown patterns per item', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              validListItemContent,
              nonCommentPattern,
              validListItemContent,
              nonCommentPattern,
              validListItemContent
            ),
            { minLength: 2, maxLength: 4 }
          ),
          (items) => {
            const input = items.map(([text1, pattern1, text2, pattern2, text3]) =>
              '- ' + text1 + ' ' + pattern1.open + text2 + pattern1.close + ' ' + pattern2.open + text3 + pattern2.close
            ).join('\n');
            const output = renderWithPlugin(input);
            expect(output).toContain('<ul>');
            expect(output).toContain('</ul>');
            const liCount = (output.match(/<li>/g) || []).length;
            expect(liCount).toBe(items.length);
            items.forEach(([text1, pattern1, text2, pattern2, text3]) => {
              expect(output).toContain(pattern1.cssClass);
              expect(output).toContain(pattern2.cssClass);
              const trimmed1 = text1.trim();
              const trimmed2 = text2.trim();
              const trimmed3 = text3.trim();
              if (trimmed1.length > 0) expect(output).toContain(escapeHtml(trimmed1));
              if (trimmed2.length > 0) expect(output).toContain(escapeHtml(trimmed2));
              if (trimmed3.length > 0) expect(output).toContain(escapeHtml(trimmed3));
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should preserve list structure with substitution patterns', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              validListItemContent,
              validListItemContent.filter(s => !s.includes('~') && !s.includes('>')),
              validListItemContent.filter(s => !s.includes('~') && !s.includes('>'))
            ),
            { minLength: 2, maxLength: 5 }
          ),
          (items) => {
            const input = items.map(([prefix, oldText, newText]) =>
              '- ' + prefix + ' {~~' + oldText + '~>' + newText + '~~}'
            ).join('\n');
            const output = renderWithPlugin(input);
            expect(output).toContain('<ul>');
            expect(output).toContain('</ul>');
            const liCount = (output.match(/<li>/g) || []).length;
            expect(liCount).toBe(items.length);
            items.forEach(([prefix, oldText, newText]) => {
              expect(output).toContain('manuscript-markdown-substitution');
              const trimmedPrefix = prefix.trim();
              const trimmedOld = oldText.trim();
              const trimmedNew = newText.trim();
              if (trimmedPrefix.length > 0) expect(output).toContain(escapeHtml(trimmedPrefix));
              if (trimmedOld.length > 0) expect(output).toContain(escapeHtml(trimmedOld));
              if (trimmedNew.length > 0) expect(output).toContain(escapeHtml(trimmedNew));
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 3: Multiline content preservation — parameterized
  describe('Property 3: Multiline content preservation', () => {
    const isValidMultilineContent = (s: string) => {
      if (!s || s.trim().length === 0) return false;
      if (!hasNoSpecialSyntax(s)) return false;
      const trimmed = s.trim();
      if (trimmed.startsWith('#')) return false;
      if (trimmed.startsWith('>')) return false;
      if (trimmed.startsWith('-') || trimmed.startsWith('+')) return false;
      if (trimmed.match(/^\d+\./)) return false;
      if (trimmed.match(/^[=\-]+$/)) return false;
      return true;
    };

    for (const type of SIMPLE_CRITIC_TYPES) {
      const charFilter = (s: string) => !s.includes('{') && !s.includes('}') &&
        !s.includes('==') && !s.includes('~~') &&
        (type.name !== 'comment' ? true : !s.includes('<') && !s.includes('>')) &&
        isValidMultilineContent(s);

      it('should preserve line breaks in ' + type.name + ' patterns', () => {
        fc.assert(
          fc.property(
            fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter(charFilter), { minLength: 2, maxLength: 4 }),
            (lines) => {
              const text = lines.join('\n');
              const output = renderWithPlugin(type.open + text + type.close);
              expect(output).toContain(type.cssClass);
              lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.length > 0) expect(output).toContain(escapeHtml(trimmed));
              });
            }
          ),
          { numRuns: 100 }
        );
      });
    }

    it('should preserve line breaks in substitution patterns', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s) && s.trim().length > 0), { minLength: 2, maxLength: 3 }),
          fc.array(fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s) && s.trim().length > 0), { minLength: 2, maxLength: 3 }),
          (oldLines, newLines) => {
            const output = renderWithPlugin('{~~' + oldLines.join('\n') + '~>' + newLines.join('\n') + '~~}');
            expect(output).toContain('manuscript-markdown-deletion');
            expect(output).toContain('manuscript-markdown-addition');
            oldLines.forEach(line => { const t = line.trim(); if (t.length > 0) expect(output).toContain(escapeHtml(t)); });
            newLines.forEach(line => { const t = line.trim(); if (t.length > 0) expect(output).toContain(escapeHtml(t)); });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 5: Substitution dual rendering
  describe('Property 5: Substitution dual rendering', () => {
    it('should render substitution with both old text (deletion styling) and new text (addition styling)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          (oldText, newText) => {
            const output = renderWithPlugin('{~~' + oldText + '~>' + newText + '~~}');
            expect(output).toContain('manuscript-markdown-substitution');
            expect(output).toContain('manuscript-markdown-deletion');
            expect(output).toContain('<del');
            expect(output).toContain(escapeHtml(oldText));
            expect(output).toContain('manuscript-markdown-addition');
            expect(output).toContain('<ins');
            expect(output).toContain(escapeHtml(newText));
            const delIndex = output.indexOf('<del');
            const insIndex = output.indexOf('<ins');
            expect(delIndex).toBeLessThan(insIndex);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle substitutions where old and new text are different lengths', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          fc.string({ minLength: 30, maxLength: 80 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          (shortText, longText) => {
            const output1 = renderWithPlugin('{~~' + shortText + '~>' + longText + '~~}');
            expect(output1).toContain(escapeHtml(shortText));
            expect(output1).toContain(escapeHtml(longText));
            expect(output1).toContain('manuscript-markdown-deletion');
            expect(output1).toContain('manuscript-markdown-addition');

            const output2 = renderWithPlugin('{~~' + longText + '~>' + shortText + '~~}');
            expect(output2).toContain(escapeHtml(longText));
            expect(output2).toContain(escapeHtml(shortText));
            expect(output2).toContain('manuscript-markdown-deletion');
            expect(output2).toContain('manuscript-markdown-addition');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle substitutions with empty old or new text', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('{') && !s.includes('}') && !s.includes('~') && !s.includes('>') && hasNoSpecialSyntax(s)),
          (text) => {
            const output1 = renderWithPlugin('{~~' + text + '~>~~}');
            expect(output1).toContain('manuscript-markdown-substitution');
            const output2 = renderWithPlugin('{~~~>' + text + '~~}');
            expect(output2).toContain('manuscript-markdown-substitution');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

describe('GFM behavior in preview plugin', () => {
  it('renders bare URLs as links', () => {
    const output = renderWithPlugin('See https://example.com now.');
    expect(output).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('renders task list items with disabled checkbox inputs', () => {
    const output = renderWithPlugin('- [x] done\n- [ ] todo');
    expect(output).toContain('class="task-list-item"');
    expect(output).toContain('class="task-list-item-checkbox"');
    expect(output).toContain('type="checkbox"');
    expect(output).toContain('disabled checked');
    expect(output).toContain('done');
    expect(output).toContain('todo');
  });

  it('escapes GFM-disallowed raw HTML tags', () => {
    const output = renderWithPlugin('<script>alert(1)</script>');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).not.toContain('<script>alert(1)</script>');
  });
});

describe('Preview color suffix parsing edge cases', () => {
  it('should not consume malformed suffix content with spaces', () => {
    const output = renderWithPlugin('==hello=={see note} world');
    expect(output).toContain('<mark');
    expect(output).toContain('hello');
    expect(output).toContain('{see note} world');
  });

  it('should consume valid unknown color suffix but fall back styling', () => {
    const output = renderWithPlugin('==hello=={unknowncolor} world');
    expect(output).toContain('manuscript-markdown-format-highlight');
    expect(output).toContain('<mark');
    expect(output).toContain('hello');
    expect(output).toContain(' world');
    expect(output).not.toContain('{unknowncolor}');
  });
});

// Edge case unit tests — parameterized where possible
describe('Edge Cases', () => {

  // Unclosed patterns — parameterized
  describe('Unclosed patterns', () => {
    const unclosedCases = [
      { name: 'addition', input: '{++unclosed text', cssClass: 'manuscript-markdown-addition', literal: '{++unclosed text' },
      { name: 'deletion', input: '{--unclosed text', cssClass: 'manuscript-markdown-deletion', literal: '{--unclosed text' },
      { name: 'substitution', input: '{~~old~>new', cssClass: 'manuscript-markdown-substitution', literal: '{~~old~&gt;new' },
      { name: 'comment', input: '{>>unclosed comment', cssClass: 'manuscript-markdown-comment', literal: '{&gt;&gt;unclosed comment' },
      { name: 'highlight', input: '{==unclosed text', cssClass: 'manuscript-markdown-highlight', literal: '{==unclosed text' },
    ];

    for (const tc of unclosedCases) {
      it('should treat unclosed ' + tc.name + ' pattern as literal text', () => {
        const output = renderWithPlugin(tc.input);
        expect(output).not.toContain(tc.cssClass);
        expect(output).toContain(tc.literal);
      });
    }
  });

  // Empty patterns — parameterized
  describe('Empty patterns', () => {
    const emptyCases = [
      { name: 'addition', input: '{++++}', cssClass: 'manuscript-markdown-addition', tag: 'ins' },
      { name: 'deletion', input: '{----}', cssClass: 'manuscript-markdown-deletion', tag: 'del' },
      { name: 'substitution', input: '{~~~>~~}', cssClass: 'manuscript-markdown-substitution', tags: ['del', 'ins'] },
      { name: 'highlight', input: '{====}', cssClass: 'manuscript-markdown-highlight', tag: 'mark' },
    ];

    for (const tc of emptyCases) {
      it('should render empty ' + tc.name + ' pattern as empty styled element', () => {
        const output = renderWithPlugin(tc.input);
        expect(output).toContain(tc.cssClass);
        if (tc.tags) {
          for (const tag of tc.tags) expect(output).toContain('<' + tag);
        } else {
          expect(output).toContain('<' + tc.tag);
          expect(output).toContain('</' + tc.tag + '>');
        }
      });
    }

    it('should remove empty comment pattern silently', () => {
      const output = renderWithPlugin('{>><<}', 'github');
      expect(output).not.toContain('manuscript-markdown-comment');
      expect(output).not.toContain('data-comment');
      expect(output).toContain('<p></p>\n');
    });
  });

  describe('Manuscript Markdown in code blocks', () => {
    it('should not process Manuscript Markdown in fenced code blocks', () => {
      const output = renderWithPlugin('```\n{++addition++}\n{--deletion--}\n```');
      expect(output).not.toContain('manuscript-markdown-addition');
      expect(output).not.toContain('manuscript-markdown-deletion');
      expect(output).toContain('<code>');
      expect(output).toContain('{++addition++}');
      expect(output).toContain('{--deletion--}');
    });

    it('should not process Manuscript Markdown in indented code blocks', () => {
      const output = renderWithPlugin('    {++addition++}\n    {--deletion--}');
      expect(output).not.toContain('manuscript-markdown-addition');
      expect(output).not.toContain('manuscript-markdown-deletion');
      expect(output).toContain('<code>');
    });
  });

  describe('Manuscript Markdown in inline code', () => {
    it('should not process Manuscript Markdown in inline code', () => {
      const output = renderWithPlugin('This is `{++addition++}` in inline code');
      expect(output).not.toContain('manuscript-markdown-addition');
      expect(output).toContain('<code>');
      expect(output).toContain('{++addition++}');
    });

    it('should not process multiple Manuscript Markdown patterns in inline code', () => {
      const output = renderWithPlugin('Code: `{++add++} {--del--} {==highlight==}`');
      expect(output).not.toContain('manuscript-markdown-addition');
      expect(output).not.toContain('manuscript-markdown-deletion');
      expect(output).not.toContain('manuscript-markdown-highlight');
      expect(output).toContain('<code>');
    });
  });

  describe('Nested same-type patterns', () => {
    it('should process first complete addition pattern when nested', () => {
      const output = renderWithPlugin('{++outer {++inner++} text++}');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('outer');
      expect(output).toContain('{++inner');
    });

    it('should process first complete deletion pattern when nested', () => {
      const output = renderWithPlugin('{--outer {--inner--} text--}');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('outer');
      expect(output).toContain('{--inner');
    });

    it('should process first complete highlight pattern when nested', () => {
      const output = renderWithPlugin('{==outer {==inner==} text==}');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('outer');
      expect(output).toContain('{==inner');
    });
  });

  describe('Manuscript Markdown in Markdown lists', () => {
    it('should process Manuscript Markdown in unordered list items', () => {
      const input = '- Item with {++addition++}\n- Item with {--deletion--}\n- Item with {==highlight==}';
      const output = renderWithPlugin(input);
      expect(output).toContain('<ul>');
      expect(output).toContain('<li>');
      expect(output).toContain('</ul>');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('Item with');
      expect(output).toContain('addition');
      expect(output).toContain('deletion');
      expect(output).toContain('highlight');
    });

    it('should process Manuscript Markdown in ordered list items', () => {
      const input = '1. First item with {++addition++}\n2. Second item with {--deletion--}\n3. Third item with {>>comment<<}';
      const output = renderWithPlugin(input);
      expect(output).toContain('<ol>');
      expect(output).toContain('<li>');
      expect(output).toContain('</ol>');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('manuscript-markdown-comment');
      expect(output).toContain('First item');
      expect(output).toContain('Second item');
      expect(output).toContain('Third item');
    });

    it('should process Manuscript Markdown substitution in list items', () => {
      const input = '- Item with {~~old text~>new text~~}\n- Another item with {~~before~>after~~}';
      const output = renderWithPlugin(input);
      expect(output).toContain('<ul>');
      expect(output).toContain('<li>');
      expect(output).toContain('manuscript-markdown-substitution');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('old text');
      expect(output).toContain('new text');
      expect(output).toContain('before');
      expect(output).toContain('after');
    });

    it('should process multiple Manuscript Markdown patterns in a single list item', () => {
      const output = renderWithPlugin('- Item with {++addition++} and {--deletion--} and {==highlight==}');
      expect(output).toContain('<ul>');
      expect(output).toContain('<li>');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('addition');
      expect(output).toContain('deletion');
      expect(output).toContain('highlight');
    });

    it('should preserve nested list structure with Manuscript Markdown', () => {
      const input = '- Parent item {++added++}\n  - Nested item {--deleted--}\n  - Another nested {==highlighted==}\n- Another parent {>>comment<<}';
      const output = renderWithPlugin(input);
      expect(output).toContain('<ul>');
      expect(output).toContain('<li>');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('manuscript-markdown-comment');
      expect(output).toContain('Parent item');
      expect(output).toContain('Nested item');
      expect(output).toContain('Another nested');
      expect(output).toContain('Another parent');
    });
  });
});

describe('CriticMarkup headings in preview', () => {
  it('renders a heading marker inside an addition as a heading', () => {
    const output = renderWithPlugin('{++## Section Name++}');

    expect(output).toContain('<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>');
    expect(output).not.toContain('## Section Name');
  });

  it('renders a heading marker inside a deletion as a heading', () => {
    const output = renderWithPlugin('{--### Old Section--}');

    expect(output).toContain('<h3><del class="manuscript-markdown-deletion">Old Section</del></h3>');
    expect(output).not.toContain('### Old Section');
  });

  it('does not promote a Critic heading marker in a partial paragraph', () => {
    const output = renderWithPlugin('Before {++## not a heading++}');

    expect(output).toContain('<p>Before <ins class="manuscript-markdown-addition">## not a heading</ins></p>');
    expect(output).not.toContain('<h2>');
  });

  it('does not promote mixed top-level Critic and plain content', () => {
    for (const input of [
      '{++## One++} plain {++Two++}',
      '{++## One++}{--Two--}{++Three++}',
    ]) {
      const output = renderWithPlugin(input);
      expect(output).toContain('## One');
      expect(output).not.toContain('<h2>');
    }
  });

  it('does not promote an empty internal Critic heading', () => {
    for (const input of ['{++## ++}', '{--## --}']) {
      const output = renderWithPlugin(input);
      expect(output).toContain('## ');
      expect(output).not.toContain('<h2>');
    }
  });

  it('promotes an internal heading whose content continues in an adjacent revision span', () => {
    const output = renderWithPlugin('{++## ++}{++Section Name++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition"></ins>' +
      '<ins class="manuscript-markdown-addition">Section Name</ins></h2>'
    );
  });

  it('does not promote an internal heading with an attached comment run', () => {
    for (const input of [
      '{++## Section Name++}{>>note<<}',
      '{++## Section Name++} {>>note<<}',
    ]) {
      const output = renderWithPlugin(input);
      expect(output).toContain('## Section Name');
      expect(output).not.toContain('<h2>');
    }
  });

  it('leaves internal Critic heading markers literal in quotes and lists', () => {
    for (const input of ['> {++## Quoted++}', '- {++## Listed++}']) {
      const output = renderWithPlugin(input);
      expect(output).toContain('## ');
      expect(output).not.toContain('<h2>');
    }
  });

  it('ends a heading before a multiline addition continues into a paragraph', () => {
    const output = renderWithPlugin('## {++Section Name\n\nParagraph text.\n++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition">Paragraph text.\n</ins></p>'
    );
  });

  it('splits a paragraph-spanning addition after promoting its internal heading', () => {
    const output = renderWithPlugin('{++## Section Name\n\nParagraph text.\n++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition">Paragraph text.\n</ins></p>'
    );
  });

  it('ends both heading forms at a single source newline', () => {
    for (const input of [
      '## {++Section Name\nParagraph text.++}',
      '{++## Section Name\nParagraph text.++}',
    ]) {
      const output = renderWithPlugin(input);
      expect(output).toContain(
        '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
        '<p><ins class="manuscript-markdown-addition">Paragraph text.</ins></p>'
      );
    }
  });

  it('keeps later soft line breaks inside the body paragraph', () => {
    const output = renderWithPlugin('## {++Section Name\nFirst line\nSecond line++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition">First line\nSecond line</ins></p>'
    );
  });

  it('balances nested formatting and CriticMarkup across the heading boundary', () => {
    const output = renderWithPlugin('## {++Section Name\n\n**bold {--old--}**++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition"><strong>bold ' +
      '<del class="manuscript-markdown-deletion">old</del></strong></ins></p>'
    );
  });

  it('balances raw inline HTML across the heading boundary', () => {
    for (const [open, close] of [
      ['<em>', '</em>'],
      ['<span class="label">', '</span>'],
      ['<a href="/section">', '</a>'],
    ]) {
      const output = renderWithPlugin('## {++' + open + 'Section\n\nParagraph' + close + '++}');
      expect(output).toContain(
        '<h2><ins class="manuscript-markdown-addition">' + open + 'Section' + close + '</ins></h2>\n' +
        '<p><ins class="manuscript-markdown-addition">' + open + 'Paragraph' + close + '</ins></p>'
      );
    }
  });

  it('propagates an attached comment to every split Critic span', () => {
    const output = renderWithPlugin('## {++Section Name\n\nParagraph text.++}{>>note<<}');

    expect(output.match(/data-comment="note"/g)).toHaveLength(2);
  });

  it('ignores protected breaks inside an attached multiline comment when splitting', () => {
    const output = renderWithPlugin(
      '## {++Section Name\n\nParagraph text.++}{>>first\n\nsecond<<}'
    );

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition" data-comment="first\n\nsecond">' +
      'Section Name</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition" data-comment="first\n\nsecond">' +
      'Paragraph text.</ins></p>'
    );
  });

  it('uses emitted breaks when opaque inline content consumes a placeholder', () => {
    const output = renderWithPlugin('## {++`Section\nName`\n\nParagraph text.++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition"><code>Section Name</code></ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition">Paragraph text.</ins></p>'
    );
  });

  it('splits at breaks after escaped comment and code delimiters', () => {
    for (const body of [
      'Section \\{>>literal\n\ntext<<}\n\nParagraph',
      'Section \\{#note>>literal\n\ntext<<}\n\nParagraph',
      'Section \\`literal\n\ntext`\n\nParagraph',
    ]) {
      for (const input of ['## {++' + body + '++}', '{++## ' + body + '++}']) {
        const output = renderWithPlugin(input);
        expect(output).toContain('</h2>\n<p>');
        expect(output).toContain('Paragraph</ins></p>');
        expect(output).not.toContain('Paragraph</ins></h2>');
      }
    }
  });

  it('maps a split after opaque HTML attributes and image labels', () => {
    for (const body of [
      '<span title="Section\n\nName">Visible</span>\n\nParagraph',
      '![Section\n\nName](image.png)\n\nParagraph',
    ]) {
      for (const input of ['## {++' + body + '++}', '{++## ' + body + '++}']) {
        const md = new MarkdownIt({ html: true });
        md.use(manuscriptMarkdownPlugin);
        const blockMaps = md.parse(input, {})
          .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
          .map(token => token.map);
        expect(blockMaps).toEqual([[0, 3], [4, 5]]);
      }
    }
  });

  it('does not synthesize wrappers for GFM-disallowed raw HTML', () => {
    const output = renderWithPlugin('## {++<title>Section\n\nParagraph</title>++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition">&lt;title&gt;Section</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition">Paragraph&lt;/title&gt;</ins></p>'
    );
  });

  it('does not leak a protected newline after a Markdown escape', () => {
    const output = renderWithPlugin('## {++Section Name\\\nParagraph text.++}');

    expect(output).toContain(
      '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
      '<p><ins class="manuscript-markdown-addition">Paragraph text.</ins></p>'
    );
    expect(output).not.toContain(LINE_PLACEHOLDER);
    expect(output).not.toContain('\uE000');
  });

  it('does not leak an escaped protected paragraph break in either heading form', () => {
    for (const input of [
      '## {++Section Name\\\n\nParagraph text.++}',
      '{++## Section Name\\\n\nParagraph text.++}',
    ]) {
      const output = renderWithPlugin(input);
      expect(output).toContain(
        '<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>\n' +
        '<p><ins class="manuscript-markdown-addition">Paragraph text.</ins></p>'
      );
      expect(output).not.toContain('\uE000');
    }
  });

  it('assigns each generated block its own source map and standard token shape', () => {
    const md = new MarkdownIt({ html: true });
    md.use(manuscriptMarkdownPlugin);
    const tokens = md.parse('## {++Section Name\n\nParagraph text.++}', {});
    const blockOpens = tokens.filter(token =>
      token.type === 'heading_open' || token.type === 'paragraph_open'
    );
    const inlineTokens = tokens.filter(token => token.type === 'inline');

    expect(blockOpens.map(token => token.map)).toEqual([[0, 1], [2, 3]]);
    expect(blockOpens.every(token => token.block && token.level === 0)).toBe(true);
    expect(inlineTokens.map(token => token.map)).toEqual([[0, 1], [2, 3]]);
    expect(inlineTokens.every(token => token.block && token.level === 1)).toBe(true);
  });

  it('maps a visible split after hidden comment and code-span breaks', () => {
    const inputs = [
      '## {>>first\n\nsecond<<}{++Section\n\nParagraph++}',
      '## {++`Section\n\nName`\n\nParagraph++}',
    ];
    for (const input of inputs) {
      const md = new MarkdownIt({ html: true });
      md.use(manuscriptMarkdownPlugin);
      const tokens = md.parse(input, {});
      const blockMaps = tokens
        .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
        .map(token => token.map);
      expect(blockMaps).toEqual([[0, 3], [4, 5]]);
    }
  });

  it('maps CRLF heading boundaries as one physical newline each', () => {
    for (const [input, expectedMaps] of [
      ['{++## Section\r\nParagraph++}', [[0, 1], [1, 2]]],
      ['{++## Section\r\n\r\nParagraph++}', [[0, 1], [2, 3]]],
    ] as const) {
      const md = new MarkdownIt({ html: true });
      md.use(manuscriptMarkdownPlugin);
      const tokens = md.parse(input, {});
      const blockMaps = tokens
        .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
        .map(token => token.map);
      expect(blockMaps).toEqual(expectedMaps);
    }
  });

  it('maps bare-CR heading boundaries as physical newlines', () => {
    for (const [input, expectedMaps] of [
      ['{++## Section\rParagraph++}', [[0, 1], [1, 2]]],
      ['{++## Section\r\rParagraph++}', [[0, 1], [2, 3]]],
    ] as const) {
      const md = new MarkdownIt({ html: true });
      md.use(manuscriptMarkdownPlugin);
      const blockMaps = md.parse(input, {})
        .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
        .map(token => token.map);
      expect(blockMaps).toEqual(expectedMaps);
    }
  });

  it('maps headings exactly within surrounding content', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      for (const [open, close] of [['{++', '++}'], ['{--', '--}']]) {
        for (const [lineBreak, bodyStart] of [[eol, 3], [eol + eol, 4]] as const) {
          for (const revisedHeading of [
            '## ' + open + 'Section' + lineBreak + 'Paragraph' + close,
            open + '## Section' + lineBreak + 'Paragraph' + close,
          ]) {
            const input = 'Before' + eol + eol + revisedHeading + eol + eol + 'After';
            const md = new MarkdownIt({ html: true });
            md.use(manuscriptMarkdownPlugin);
            const revisedMaps = md.parse(input, {})
              .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
              .slice(1, 3)
              .map(token => token.map);
            expect(revisedMaps).toEqual([[2, 3], [bodyStart, bodyStart + 1]]);
          }
        }
      }
    }
  });

  it('maps adjacent collapsed Critic headings from their exact source starts', () => {
    const input =
      'Before\n\n{++## One\n\nBody1++}\n\n{++## Two\nBody2++}\n\nAfter';
    const md = new MarkdownIt({ html: true });
    md.use(manuscriptMarkdownPlugin);
    const revisedMaps = md.parse(input, {})
      .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
      .slice(1, 5)
      .map(token => token.map);

    expect(revisedMaps).toEqual([[2, 3], [4, 5], [6, 7], [7, 8]]);
  });

  it('counts protected breaks consumed by inline math before a visible split', () => {
    for (const mathCritic of [
      '{>>note\n\nmore<<}',
      '{--old\n\nmore--}',
      '{==marked\n\nmore==}',
      '{~~old\n\nmore~>new~~}',
    ]) {
      for (const input of [
        '## {++$x ' + mathCritic + ' y$\n\nParagraph++}',
        '{++## $x ' + mathCritic + ' y$\n\nParagraph++}',
      ]) {
        const md = new MarkdownIt({ html: true });
        md.use(manuscriptMarkdownPlugin);
        const blockMaps = md.parse(input, {})
          .filter(token => token.type === 'heading_open' || token.type === 'paragraph_open')
          .map(token => token.map);
        expect(blockMaps).toEqual([[0, 3], [4, 5]]);
      }
    }
  });

  it('does not emit an empty paragraph for a trailing blank segment', () => {
    const output = renderWithPlugin('## {++Section Name\n\n++}');

    expect(output).toContain('<h2><ins class="manuscript-markdown-addition">Section Name</ins></h2>');
    expect(output).not.toContain('<p>');
  });
});

// Property 4: Empty line preservation — parameterized
describe('Property 4: Empty line preservation', () => {
  it('renders paragraph breaks inside an addition without leaking the placeholder', () => {
    const output = renderWithPlugin(
      '{++First paragraph.\n\nSecond paragraph.\n\n++}## Statistical Model'
    );

    expect(output).toContain('First paragraph.');
    expect(output).toContain('Second paragraph.');
    expect(output).toContain('## Statistical Model');
    expect(output.match(/<br>/g)).toHaveLength(4);
    expect(output).not.toContain('PARA');
    expect(output).not.toContain('\uE000');
  });

  it('preserves nested CriticMarkup across a paragraph break', () => {
    const output = renderWithPlugin('{++outer {--one\n\ntwo--} end++}');

    expect(output).toContain('<ins class="manuscript-markdown-addition">');
    expect(output).toContain('<del class="manuscript-markdown-deletion">one<br>\n<br>\ntwo</del>');
    expect(output).not.toContain('{--');
    expect(output).not.toContain('PARA');
  });

  it('preserves emphasis across a paragraph break inside CriticMarkup', () => {
    const output = renderWithPlugin('{++**one\n\ntwo**++}');

    expect(output).toContain('<strong>one<br>\n<br>\ntwo</strong>');
    expect(output).not.toContain('PARA');
  });

  const multilineTextWithEmptyLines = fc.array(
    fc.oneof(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s =>
        !s.includes('{') && !s.includes('}') &&
        !s.includes('\n') &&
        hasNoSpecialSyntax(s) &&
        s.trim().length > 0
      ),
      fc.constant('')
    ),
    { minLength: 3, maxLength: 6 }
  ).filter(lines => lines.some(line => line === '') && lines.some(line => line.trim().length > 0));

  for (const type of SIMPLE_CRITIC_TYPES) {
    const arb = type.name === 'comment'
      ? multilineTextWithEmptyLines.filter(lines => lines.every(line => !line.includes('<') && !line.includes('>')))
      : multilineTextWithEmptyLines;

    it('should recognize ' + type.name + ' patterns containing empty lines as single patterns', () => {
      fc.assert(
        fc.property(arb, (lines) => {
          const text = lines.join('\n');
          const output = renderWithPlugin(type.open + text + type.close);
          expect(output).toContain(type.cssClass);
          expect(output).toContain('<' + type.tag);
          lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed.length > 0) expect(output).toContain(escapeHtml(trimmed));
          });
        }),
        { numRuns: 100 }
      );
    });
  }

  it('should recognize substitution patterns with empty lines in both old and new text', () => {
    const filtered = multilineTextWithEmptyLines.filter(lines =>
      lines.every(line => !line.includes('~') && !line.includes('>'))
    );
    fc.assert(
      fc.property(filtered, filtered, (oldLines, newLines) => {
        const output = renderWithPlugin('{~~' + oldLines.join('\n') + '~>' + newLines.join('\n') + '~~}');
        expect(output).toContain('manuscript-markdown-substitution');
        expect(output).toContain('manuscript-markdown-deletion');
        expect(output).toContain('manuscript-markdown-addition');
        oldLines.forEach(line => { const t = line.trim(); if (t.length > 0) expect(output).toContain(escapeHtml(t)); });
        newLines.forEach(line => { const t = line.trim(); if (t.length > 0) expect(output).toContain(escapeHtml(t)); });
      }),
      { numRuns: 100 }
    );
  });
});

// Property 3 (multiline-Manuscript Markdown-support): Multi-line preview rendering — parameterized
describe('Property 3: Multi-line preview rendering (multiline-Manuscript Markdown-support)', () => {
  const multilineText = fc.array(
    fc.string({ minLength: 1, maxLength: 50 }).filter(s =>
      !s.includes('{') && !s.includes('}') &&
      !s.includes('\n') &&
      hasNoSpecialSyntax(s) &&
      s.trim().length > 0
    ),
    { minLength: 2, maxLength: 5 }
  );

  for (const type of SIMPLE_CRITIC_TYPES) {
    const arb = type.name === 'comment'
      ? multilineText.filter(lines => lines.every(line => !line.includes('<') && !line.includes('>')))
      : multilineText;

    it('should render multi-line ' + type.name + ' patterns with correct HTML structure', () => {
      fc.assert(
        fc.property(arb, (lines) => {
          const text = lines.join('\n');
          const output = renderWithPlugin(type.open + text + type.close);
          expect(output).toContain(type.cssClass);
          expect(output).toContain('<' + type.tag);
          expect(output).toContain('</' + type.tag + '>');
          lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed.length > 0) expect(output).toContain(escapeHtml(trimmed));
          });
        }),
        { numRuns: 100 }
      );
    });
  }

  it('should render multi-line substitution patterns with correct HTML structure', () => {
    const filteredLines = multilineText.filter(lines =>
      lines.every(line => !line.includes('~') && !line.includes('>'))
    );
    fc.assert(
      fc.property(filteredLines, filteredLines, (oldLines, newLines) => {
        const output = renderWithPlugin('{~~' + oldLines.join('\n') + '~>' + newLines.join('\n') + '~~}');
        expect(output).toContain('manuscript-markdown-substitution');
        expect(output).toContain('manuscript-markdown-deletion');
        expect(output).toContain('manuscript-markdown-addition');
        expect(output).toContain('<del');
        expect(output).toContain('<ins');
        oldLines.forEach(line => { const t = line.trim(); if (t.length > 0) expect(output).toContain(escapeHtml(t)); });
        newLines.forEach(line => { const t = line.trim(); if (t.length > 0) expect(output).toContain(escapeHtml(t)); });
      }),
      { numRuns: 100 }
    );
  });
});

describe('Mid-line multi-line patterns', () => {
  it('should handle single-line patterns mid-line correctly', () => {
    const output = renderWithPlugin('Text {++add++} and {--del--} patterns');
    expect(output).toContain('manuscript-markdown-addition');
    expect(output).toContain('manuscript-markdown-deletion');
    expect(output).toContain('Text');
    expect(output).toContain('add');
    expect(output).toContain('and');
    expect(output).toContain('del');
    expect(output).toContain('patterns');
  });

  it('renders a mid-line pattern that continues across source lines', () => {
    const input = 'Text before {++multi\nline\naddition++}';
    const output = renderWithPlugin(input);
    expect(output).toContain('Text before');
    expect(output).toContain('<ins class="manuscript-markdown-addition">');
    expect(output).toContain('multi\nline\naddition');
    expect(output).not.toContain('{++');
  });
});

// Property 10: Preview ==highlight== rendering
describe('Property 10: Preview ==highlight== rendering', () => {
  it('should transform ==highlight== patterns into HTML with correct CSS class', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('=') && !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)),
        (text) => {
          const output = renderWithPlugin('==' + text + '==');
          expect(output).toContain('manuscript-markdown-format-highlight');
          expect(output).toContain(escapeHtml(text));
          expect(output).toContain('<mark');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Highlight color properties
describe('Property 2: Preview renders colored highlights with correct color class', () => {
  const colorIdGen = fc.constantFrom(...VALID_COLOR_IDS as string[]);
  const safeText = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s: string) => !s.includes('=') && !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)
  );

  it('should render ==text=={color} with manuscript-markdown-highlight-{color} class', () => {
    fc.assert(
      fc.property(safeText, colorIdGen, (text: string, color: string) => {
        const output = renderWithPlugin('==' + text + '=={' + color + '}');
        expect(output).toContain('manuscript-markdown-highlight-' + color);
        expect(output).toContain('<mark');
        expect(output).toContain(escapeHtml(text));
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 3: Preview renders default highlights with yellow/amber', () => {
  const safeText = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s: string) => !s.includes('=') && !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)
  );

  it('should render ==text== with manuscript-markdown-format-highlight class', () => {
    const originalDefault = getDefaultHighlightColor();
    try {
      setDefaultHighlightColor('yellow');
      fc.assert(
        fc.property(safeText, (text: string) => {
          const output = renderWithPlugin('==' + text + '==');
          expect(output).toContain('manuscript-markdown-format-highlight');
          expect(output).toContain('<mark');
          expect(output).toContain(escapeHtml(text));
        }),
        { numRuns: 100 }
      );
    } finally {
      setDefaultHighlightColor(originalDefault);
    }
  });
});

describe('Property 4: Preview renders CriticMarkup highlights with Comment_Gray', () => {
  const safeText = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s: string) => !s.includes('{') && !s.includes('}') && !s.includes('=') && hasNoSpecialSyntax(s)
  );

  it('should render {==text==} with manuscript-markdown-highlight class (not format-highlight)', () => {
    fc.assert(
      fc.property(safeText, (text: string) => {
        const output = renderWithPlugin('{==' + text + '==}');
        expect(output).toContain('class="manuscript-markdown-highlight"');
        expect(output).not.toContain('manuscript-markdown-format-highlight');
        expect(output).toContain('<mark');
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 5: Preview falls back for unrecognized colors', () => {
  const safeText = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s: string) => !s.includes('=') && !s.includes('{') && !s.includes('}') && hasNoSpecialSyntax(s)
  );
  const defaultColorGen = fc.constantFrom(...VALID_COLOR_IDS as string[]);
  const invalidColorGen = fc.stringMatching(/^[a-z][a-z0-9-]{1,9}$/).filter(
    (s: string) => !(VALID_COLOR_IDS as string[]).includes(s)
  );

  it('should render ==text=={invalid} using configured default color (yellow as second-level fallback)', () => {
    const originalDefault = getDefaultHighlightColor();
    try {
      fc.assert(
        fc.property(safeText, invalidColorGen, defaultColorGen, (text: string, badColor: string, defaultColor: string) => {
          setDefaultHighlightColor(defaultColor);
          const output = renderWithPlugin('==' + text + '=={' + badColor + '}');
          expect(output).toContain('manuscript-markdown-format-highlight');
          if (defaultColor !== 'yellow') {
            expect(output).toContain('manuscript-markdown-highlight-' + defaultColor);
          }
          expect(output).toContain('<mark');
        }),
        { numRuns: 100 }
      );
    } finally {
      setDefaultHighlightColor(originalDefault);
    }
  });

  it('should use yellow/amber fallback when configured default is invalid', () => {
    const originalDefault = getDefaultHighlightColor();
    try {
      setDefaultHighlightColor('not-a-color');
      fc.assert(
        fc.property(safeText, invalidColorGen, (text: string, badColor: string) => {
          const output = renderWithPlugin('==' + text + '=={' + badColor + '}');
          expect(output).toContain('manuscript-markdown-format-highlight');
          expect(output).not.toContain('manuscript-markdown-highlight-not-a-color');
        }),
        { numRuns: 100 }
      );
    } finally {
      setDefaultHighlightColor(originalDefault);
    }
  });
});

// Code region inertness — parameterized
describe('Code region inertness in preview', () => {
  const inlineCodeCases = [
    { name: 'CriticMarkup addition', input: '`{++added++}`', literal: '<code>{++added++}</code>', notContain: ['<ins', 'manuscript-markdown-addition'] },
    { name: 'CriticMarkup deletion', input: '`{--deleted--}`', literal: '<code>{--deleted--}</code>', notContain: ['<del', 'manuscript-markdown-deletion'] },
    { name: 'CriticMarkup substitution', input: '`{~~old~>new~~}`', literal: '<code>{~~old~&gt;new~~}</code>', notContain: ['manuscript-markdown-substitution'] },
    { name: 'CriticMarkup comment', input: '`{>>comment<<}`', literal: '<code>{&gt;&gt;comment&lt;&lt;}</code>', notContain: ['manuscript-markdown-comment'] },
    { name: 'CriticMarkup highlight', input: '`{==highlighted==}`', literal: '<code>{==highlighted==}</code>', notContain: ['manuscript-markdown-highlight'] },
    { name: 'format highlight', input: '`==highlighted==`', literal: '<code>==highlighted==</code>', notContain: ['<mark', 'manuscript-markdown-format-highlight'] },
    { name: 'colored highlight', input: '`==text=={red}`', literal: '<code>==text=={red}</code>', notContain: ['<mark'] },
    { name: 'citation', input: '`[@smith2020]`', literal: '<code>[@smith2020]</code>', notContain: [] },
  ];

  for (const tc of inlineCodeCases) {
    it('renders inline code with ' + tc.name + ' as literal text', () => {
      const output = renderWithPlugin(tc.input);
      expect(output).toContain(tc.literal);
      for (const nc of tc.notContain) {
        expect(output).not.toContain(nc);
      }
    });
  }

  it('renders fenced code block with CriticMarkup as literal text', () => {
    const output = renderWithPlugin('```\n{++added++}\n{--deleted--}\n{==highlighted==}\n==format==\n```');
    expect(output).toContain('<code>');
    expect(output).toContain('{++added++}');
    expect(output).toContain('{--deleted--}');
    expect(output).toContain('{==highlighted==}');
    expect(output).toContain('==format==');
    expect(output).not.toContain('<ins');
    expect(output).not.toContain('<del');
    expect(output).not.toContain('<mark');
    expect(output).not.toContain('manuscript-markdown');
  });

  it('renders multiline CriticMarkup in a fenced code block as literal text', () => {
    const html = renderWithPlugin('```markdown\n{++first\nsecond++}\n```');
    expect(html).toContain('{++first\nsecond++}');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
    expect(html).not.toContain('manuscript-markdown-addition');
  });

  it('renders multiline CriticMarkup in an indented code block as literal text', () => {
    const html = renderWithPlugin('    {++first\n    second++}');
    expect(html).toContain('{++first\nsecond++}');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
    expect(html).not.toContain('manuscript-markdown-addition');
  });

  it('keeps overlapping inline-code regions inert inside an indented code block', () => {
    const html = renderWithPlugin('    `x` `x` {++first\n    second++}');
    expect(html).toContain('`x` `x` {++first\nsecond++}');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
    expect(html).not.toContain('manuscript-markdown-addition');
  });

  it('renders fenced code block with language tag as literal text', () => {
    const output = renderWithPlugin('```markdown\n{++added++}\n```');
    expect(output).toContain('{++added++}');
    expect(output).not.toContain('<ins');
    expect(output).not.toContain('manuscript-markdown');
  });

  it('still processes CriticMarkup outside inline code', () => {
    const output = renderWithPlugin('Before `code` {++after++}');
    expect(output).toContain('<code>code</code>');
    expect(output).toContain('manuscript-markdown-addition');
    expect(output).toContain('<ins');
  });

  it('still processes CriticMarkup surrounding a code span', () => {
    const output = renderWithPlugin('{==`code`==}');
    expect(output).toContain('<code>code</code>');
    expect(output).toContain('manuscript-markdown-highlight');
  });
});

// Comment association tests (unique logic, kept as-is)
describe('Comment association in preview', () => {

  describe('Standalone comments', () => {
    it('should render standalone comment as indicator with data-comment', () => {
      const output = renderWithPlugin('{>>note<<}');
      expect(output).toContain('manuscript-markdown-comment-indicator');
      expect(output).toContain('data-comment="note"');
      expect(output).not.toMatch(/>note</);
    });

    it('should render standalone comment with special chars escaped in data-comment', () => {
      const output = renderWithPlugin('{>>a "quote" & <tag><<}');
      expect(output).toContain('manuscript-markdown-comment-indicator');
      expect(output).toContain('data-comment="a &quot;quote&quot; &amp; &lt;tag&gt;"');
    });

    it('should render multiple standalone comments as separate indicators', () => {
      const output = renderWithPlugin('{>>first<<} {>>second<<}');
      const indicatorCount = (output.match(/manuscript-markdown-comment-indicator/g) || []).length;
      expect(indicatorCount).toBe(2);
      expect(output).toContain('data-comment="first"');
      expect(output).toContain('data-comment="second"');
    });
  });

  describe('Adjacent comment association', () => {
    it('should associate comment with preceding highlight via data-comment', () => {
      const output = renderWithPlugin('{==text==}{>>comment<<}');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('data-comment="comment"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
      expect(output).not.toMatch(/>comment</);
    });

    it('should associate comment with preceding addition via data-comment', () => {
      const output = renderWithPlugin('{++added++}{>>why<<}');
      expect(output).toContain('manuscript-markdown-addition');
      expect(output).toContain('data-comment="why"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
    });

    it('should associate comment with preceding deletion via data-comment', () => {
      const output = renderWithPlugin('{--removed--}{>>reason<<}');
      expect(output).toContain('manuscript-markdown-deletion');
      expect(output).toContain('data-comment="reason"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
    });

    it('should associate comment with preceding substitution via data-comment', () => {
      const output = renderWithPlugin('{~~old~>new~~}{>>reason<<}');
      expect(output).toContain('manuscript-markdown-substitution');
      expect(output).toContain('data-comment="reason"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
    });

    it('should associate comment with preceding format highlight via data-comment', () => {
      const output = renderWithPlugin('==text=={>>note<<}');
      expect(output).toContain('manuscript-markdown-format-highlight');
      expect(output).toContain('data-comment="note"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
    });

    it('should concatenate multiple sequential comments with newline separator', () => {
      const output = renderWithPlugin('{==text==}{>>first<<}{>>second<<}');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('data-comment="first\nsecond"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
    });
  });

  describe('ID-based comment ranges', () => {
    it('should create comment range span with data-comment for ID-based comments', () => {
      const output = renderWithPlugin('{#1}text{/1}{#1>>comment<<}');
      expect(output).toContain('manuscript-markdown-comment-range');
      expect(output).toContain('data-comment="comment"');
      expect(output).toContain('>text</span>');
    });

    it('should leave range markers without matching comment as empty renders', () => {
      const output = renderWithPlugin('{#1}text{/1}');
      expect(output).not.toContain('manuscript-markdown-comment-range');
      expect(output).toContain('text');
    });

    it('should handle multiple ID-based ranges independently', () => {
      const output = renderWithPlugin('{#a}alpha{/a}{#b}beta{/b}{#a>>note-a<<}{#b>>note-b<<}');
      expect(output).toContain('data-comment="note-a"');
      expect(output).toContain('data-comment="note-b"');
    });
  });

  describe('Empty and edge cases', () => {
    it('should remove empty comment silently with no indicator', () => {
      const output = renderWithPlugin('text{>><<}more');
      expect(output).not.toContain('manuscript-markdown-comment');
      expect(output).not.toContain('data-comment');
      expect(output).toContain('textmore');
    });

    it('should not affect text surrounding associated comments', () => {
      const output = renderWithPlugin('before {==text==}{>>note<<} after');
      expect(output).toContain('before');
      expect(output).toContain('after');
      expect(output).toContain('text');
      expect(output).toContain('data-comment="note"');
    });

    it('should handle comment after highlight in a list item', () => {
      const output = renderWithPlugin('- Item {==text==}{>>note<<}');
      expect(output).toContain('<ul>');
      expect(output).toContain('manuscript-markdown-highlight');
      expect(output).toContain('data-comment="note"');
      expect(output).not.toContain('manuscript-markdown-comment-indicator');
    });
  });
});

// Whitespace-separated comment association
describe('Property 1: Whitespace-Separated Comment Association (Bug Condition Exploration)', () => {
  const elementTypes = [
    { name: 'highlight',        open: '{==', close: '==}', tag: 'mark' },
    { name: 'addition',         open: '{++', close: '++}', tag: 'ins'  },
    { name: 'deletion',         open: '{--', close: '--}', tag: 'del'  },
    { name: 'substitution',     open: '{~~', close: '~~}', tag: 'span' },
    { name: 'format highlight', open: '==',  close: '==',  tag: 'mark' },
  ];

  const elementTypeArb = fc.constantFrom(...elementTypes);
  const whitespaceArb = fc.array(fc.constantFrom(' ', '\t'), { minLength: 1, maxLength: 5 }).map(arr => arr.join(''));
  const commentTextArb = fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z0-9 ]+$/.test(s) && s.trim().length > 0);

  it('should associate comment with preceding CriticMarkup element when separated by whitespace', () => {
    fc.assert(
      fc.property(elementTypeArb, whitespaceArb, commentTextArb, (elemType, ws, commentText) => {
        let input: string;
        if (elemType.name === 'substitution') {
          input = elemType.open + 'old~>new' + elemType.close + ws + '{>>' + commentText + '<<}';
        } else {
          input = elemType.open + 'text' + elemType.close + ws + '{>>' + commentText + '<<}';
        }
        const output = renderWithPlugin(input);
        expect(output).toContain('data-comment="' + escapeHtml(commentText) + '"');
        expect(output).not.toContain('manuscript-markdown-comment-indicator');
      }),
      { numRuns: 50 }
    );
  });
});

describe('Property 2: Preservation — Non-Whitespace-Separated Behavior', () => {
  const elementTypes = [
    { name: 'highlight',        open: '{==', close: '==}', tag: 'mark',  cssClass: 'manuscript-markdown-highlight' },
    { name: 'addition',         open: '{++', close: '++}', tag: 'ins',   cssClass: 'manuscript-markdown-addition' },
    { name: 'deletion',         open: '{--', close: '--}', tag: 'del',   cssClass: 'manuscript-markdown-deletion' },
    { name: 'substitution',     open: '{~~', close: '~~}', tag: 'span',  cssClass: 'manuscript-markdown-substitution' },
    { name: 'format highlight', open: '==',  close: '==',  tag: 'mark',  cssClass: 'manuscript-markdown-format-highlight' },
  ];

  const elementTypeArb = fc.constantFrom(...elementTypes);
  const commentTextArb = fc.stringMatching(/^[a-zA-Z0-9]+$/).filter(s => s.length >= 1 && s.length <= 10);
  const nonWsSeparatorArb = fc.stringMatching(/^[a-zA-Z0-9]+$/).filter(s => s.length >= 1 && s.length <= 10);

  function buildElementInput(elemType: typeof elementTypes[number]): string {
    if (elemType.name === 'substitution') return elemType.open + 'old~>new' + elemType.close;
    return elemType.open + 'text' + elemType.close;
  }

  describe('Direct adjacency association', () => {
    it('should set data-comment on element tag when comment is directly adjacent', () => {
      fc.assert(
        fc.property(elementTypeArb, commentTextArb, (elemType, commentText) => {
          const output = renderWithPlugin(buildElementInput(elemType) + '{>>' + commentText + '<<}');
          expect(output).toContain('data-comment="' + escapeHtml(commentText) + '"');
          expect(output).not.toContain('manuscript-markdown-comment-indicator');
          expect(output).toContain(elemType.cssClass);
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Non-whitespace separation renders standalone indicator', () => {
    it('should render comment as standalone indicator when non-whitespace text separates it from element', () => {
      fc.assert(
        fc.property(elementTypeArb, nonWsSeparatorArb, commentTextArb, (elemType, separator, commentText) => {
          const output = renderWithPlugin(buildElementInput(elemType) + separator + '{>>' + commentText + '<<}');
          expect(output).toContain('manuscript-markdown-comment-indicator');
          expect(output).toContain('data-comment="' + escapeHtml(commentText) + '"');
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Standalone comment with no preceding element', () => {
    it('should render comment as indicator when no CriticMarkup element precedes it', () => {
      fc.assert(
        fc.property(commentTextArb, (commentText) => {
          const output = renderWithPlugin('{>>' + commentText + '<<}');
          expect(output).toContain('manuscript-markdown-comment-indicator');
          expect(output).toContain('data-comment="' + escapeHtml(commentText) + '"');
        }),
        { numRuns: 50 }
      );
    });

    it('should render comment as indicator when preceded only by plain text', () => {
      fc.assert(
        fc.property(nonWsSeparatorArb, commentTextArb, (plainText, commentText) => {
          const output = renderWithPlugin(plainText + ' {>>' + commentText + '<<}');
          expect(output).toContain('manuscript-markdown-comment-indicator');
          expect(output).toContain('data-comment="' + escapeHtml(commentText) + '"');
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Empty comment removal', () => {
    it('should silently remove empty comments', () => {
      const output = renderWithPlugin('{>><<}', 'github');
      expect(output).not.toContain('manuscript-markdown-comment');
      expect(output).not.toContain('data-comment');
      expect(output).toContain('<p></p>\n');
    });

    it('should silently remove empty comment adjacent to element without affecting element', () => {
      fc.assert(
        fc.property(elementTypeArb, (elemType) => {
          const output = renderWithPlugin(buildElementInput(elemType) + '{>><<}');
          expect(output).toContain(elemType.cssClass);
          expect(output).not.toContain('data-comment');
          expect(output).not.toContain('manuscript-markdown-comment-indicator');
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Multiple comment concatenation', () => {
    it('should concatenate multiple adjacent comments with newline in data-comment', () => {
      fc.assert(
        fc.property(elementTypeArb, commentTextArb, commentTextArb, (elemType, commentA, commentB) => {
          const output = renderWithPlugin(buildElementInput(elemType) + '{>>' + commentA + '<<}{>>' + commentB + '<<}');
          const expectedAttr = 'data-comment="' + escapeHtml(commentA) + '\n' + escapeHtml(commentB) + '"';
          expect(output).toContain(expectedAttr);
          expect(output).not.toContain('manuscript-markdown-comment-indicator');
          expect(output).toContain(elemType.cssClass);
        }),
        { numRuns: 50 }
      );
    });
  });
});

// Stylesheet declaration tests (moved from extension.test.ts)
describe('Stylesheet declaration', () => {
  it('should declare preview stylesheet in package.json', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.contributes).toBeDefined();
    expect(packageJson.contributes['markdown.previewStyles']).toBeDefined();
    expect(Array.isArray(packageJson.contributes['markdown.previewStyles'])).toBe(true);
    expect(packageJson.contributes['markdown.previewStyles']).toContain('./media/manuscript-markdown.css');
  });

  it('should declare markdown.markdownItPlugins in package.json', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.contributes).toBeDefined();
    expect(packageJson.contributes['markdown.markdownItPlugins']).toBe(true);
  });

  it('should have CSS file at declared path', () => {
    const cssPath = path.join(__dirname, '..', '..', 'media', 'manuscript-markdown.css');
    expect(fs.existsSync(cssPath)).toBe(true);
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toContain('.manuscript-markdown-addition');
    expect(cssContent).toContain('.manuscript-markdown-deletion');
    expect(cssContent).toContain('.manuscript-markdown-substitution');
    expect(cssContent).toContain('.manuscript-markdown-comment');
    expect(cssContent).toContain('.manuscript-markdown-highlight');
  });
});

describe('Grid table preview', () => {
  it('renders grid table as HTML table', () => {
    const gridMd = [
      '+------+------+',
      '| H1   | H2   |',
      '+======+======+',
      '| A    | B    |',
      '+------+------+',
    ].join('\n');
    const html = renderWithPlugin(gridMd);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>');
    expect(html).toContain('H1');
    expect(html).toContain('<td>');
    expect(html).toContain('A');
  });

  it('renders grid table without header', () => {
    const gridMd = [
      '+------+------+',
      '| A    | B    |',
      '+------+------+',
      '| C    | D    |',
      '+------+------+',
    ].join('\n');
    const html = renderWithPlugin(gridMd);
    expect(html).toContain('<table>');
    expect(html).toContain('A');
    expect(html).toContain('D');
  });
});

describe('Embed preview document resolution', () => {
  it('uses state.env.currentDocument to resolve embed paths', () => {
    const resolver = makeEmbedResolver({
      '/doc/data.csv': 'Name,Age\nAlice,30',
    });
    const html = renderWithEmbedSetup(
      '<!-- embed: data.csv -->',
      resolver,
      { currentDocument: { fsPath: '/doc/file.md' } },
    );

    expect(html).toContain('<table');
    expect(html).toContain('Alice');
  });

  it('prefers state.env.currentDocument over a stale manuscriptDocumentPath fallback', () => {
    const resolver = makeEmbedResolver({
      '/right/data.csv': 'Name,Age\nAlice,30',
      '/wrong/data.csv': 'Name,Age\nBob,25',
    });
    const html = renderWithEmbedSetup(
      '<!-- embed: data.csv -->',
      resolver,
      { currentDocument: { fsPath: '/right/file.md' } },
      '/wrong/file.md',
    );

    expect(html).toContain('Alice');
    expect(html).not.toContain('Bob');
  });

  it('uses manuscriptGetDocumentPath to resolve embed paths', () => {
    const resolver = makeEmbedResolver({
      '/dynamic/data.csv': 'Name,Age\nCarol,40',
    });
    const html = renderWithEmbedSetup(
      '<!-- embed: data.csv -->',
      resolver,
      undefined,
      undefined,
      (src) => src.includes('embed') ? '/dynamic/file.md' : undefined,
    );

    expect(html).toContain('Carol');
  });

  it('prefers manuscriptDocumentPath over manuscriptGetDocumentPath once set', () => {
    const resolver = makeEmbedResolver({
      '/cached/data.csv': 'Name,Age\nDana,35',
      '/dynamic/data.csv': 'Name,Age\nEvan,28',
    });
    const html = renderWithEmbedSetup(
      '<!-- embed: data.csv -->',
      resolver,
      undefined,
      '/cached/file.md',
      () => '/dynamic/file.md',
    );

    expect(html).toContain('Dana');
    expect(html).not.toContain('Evan');
  });
});

describe('Table numeric formatting preview', () => {
  it('applies document defaults and per-table source cancellation', () => {
    const input = [
      '---', 'table-digits: 2', 'table-decimal-mark: midpoint', '---', '',
      '| Value |', '| --- |', '| 12.3 |', '',
      '<!-- table-digits: source -->', '| Value |', '| --- |', '| 4.50 |',
    ].join('\n');
    const html = renderWithPlugin(input);
    expect(html).toContain('12\u00b730');
    expect(html).toContain('4\u00b750');
  });

  it('honors HTML table data attributes', () => {
    const html = renderWithPlugin('<table data-digits="1" data-decimal-mark="comma"><tr><td>12.34</td></tr></table>');
    expect(html).toContain('12,3');
  });

  it('formats embedded CSV and honors per-table overrides', () => {
    const resolver = makeEmbedResolver({ '/doc/data.csv': 'Value\n12.30' });
    const input = [
      '---', 'table-digits: 1', 'table-decimal-mark: midpoint', '---', '',
      '<!-- table-digits: source -->', '<!-- embed: data.csv -->',
    ].join('\n');
    const html = renderWithEmbedSetup(input, resolver, { currentDocument: { fsPath: '/doc/file.md' } });
    expect(html).toContain('12\u00b730');
  });
});

describe('CriticMarkup inside inline equations', () => {
  it('recognizes a math opener preceded by an even run of backslashes', () => {
    const html = renderWithPlugin('\\\\$a{++b++}$');

    expect(html).toContain('\\');
    expect(html).toContain('<span class="manuscript-markdown-math-fallback">a</span>');
    expect(html).toContain('<ins class="manuscript-markdown-addition">');
    expect(html).not.toContain('$a');
  });

  it('keeps currency-like dollars literal when the text contains CriticMarkup', () => {
    const md = new MarkdownIt({ html: true });
    md.inline.ruler.after('escape', 'test_permissive_host_math', (state: any, silent: boolean) => {
      if (state.src.charAt(state.pos) !== '$') return false;
      const close = state.src.indexOf('$', state.pos + 1);
      if (close === -1) return false;
      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.content = state.src.slice(state.pos + 1, close);
      }
      state.pos = close + 1;
      return true;
    });
    md.renderer.rules.math_inline = (tokens, idx) => '<katex>' + escapeHtml(tokens[idx].content) + '</katex>';
    md.use(manuscriptMarkdownPlugin);

    const html = md.render('Price $100 {++to $120++}');

    expect(html).toContain('Price $100 <ins class="manuscript-markdown-addition">to $120</ins>');
    expect(html).not.toContain('<katex>');
  });

  it('keeps the host math renderer and supplies boundary context for operator spacing', () => {
    const md = new MarkdownIt({ html: true });
    md.renderer.rules.math_inline = (tokens, idx) => '<katex>' + escapeHtml(tokens[idx].content) + '</katex>';
    md.use(manuscriptMarkdownPlugin);

    const html = md.render('$u^2{+++v^2++}$');
    expect(html).toContain('<katex>u^2{}</katex>');
    expect(html).toContain('<ins class="manuscript-markdown-addition"><katex>{}+v^2</katex></ins>');
  });

  it('renders a changed equation fragment outside the opaque math token', () => {
    const html = renderWithPlugin('The variance is $u_j^2{+++\\tau_{g_j}^2++}$.');

    expect(html).toContain('<span class="manuscript-markdown-math-fallback">u_j^2</span>');
    expect(html).toContain(
      '<ins class="manuscript-markdown-addition"><span class="manuscript-markdown-math-fallback">+\\tau_{g_j}^2</span></ins>'
    );
    expect(html).not.toContain('{++');
    expect(html).not.toContain('++}');
  });

  it('renders both math sides of a substitution', () => {
    const html = renderWithPlugin('$a{~~+b~>+c~~}$');

    expect(html).toContain('<del class="manuscript-markdown-deletion"><span class="manuscript-markdown-math-fallback">+b</span></del>');
    expect(html).toContain('<ins class="manuscript-markdown-addition"><span class="manuscript-markdown-math-fallback">+c</span></ins>');
    expect(html).not.toContain('{~~');
  });

  it('associates an in-equation comment with the preceding changed fragment', () => {
    const html = renderWithPlugin('$a{++b++}{>>why<<}$');

    expect(html).toContain('class="manuscript-markdown-addition" data-comment="why"');
    expect(html).not.toContain('{>>');
  });

  it('keeps a multiline addition around display math intact when blank lines contain whitespace', () => {
    const input = 'Before {++Here with\n   \n$$\\begin{aligned}x &= 1\\end{aligned}$$\n\t\nwhere $x$ is defined.++}';
    const html = renderWithPlugin(input);

    expect(html).toContain('<ins class="manuscript-markdown-addition">');
    expect(html).toContain('Here with');
    expect(html).toContain('where $x$ is defined.');
    expect(html).not.toContain('{++');
    expect(html).not.toContain('PARA');
  });

  it('handles a multiline addition whose opener ends the preceding paragraph', () => {
    const input = 'Earlier text.{++\nAdded paragraph.\n\n$$x^2$$\n\nAdded conclusion.++}';
    const html = renderWithPlugin(input);

    expect(html).toContain('<p>Earlier text.</p>');
    expect(html).toContain('<ins class="manuscript-markdown-addition">Added paragraph.');
    expect(html).toContain('Added conclusion.</ins>');
    expect(html).not.toContain('{++');
    expect(html).not.toContain('PARA');
  });

  it('does not hoist an incomplete multiline Critic opener', () => {
    const html = renderWithPlugin('Before.{++\nAfter');

    expect(html).toContain('Before.{++\nAfter');
    expect(html).not.toContain('</p>\n<p>');
    expect(html).not.toContain('manuscript-markdown-addition');
  });

  it('keeps an escaped multiline opener literal', () => {
    const html = renderWithPlugin('Literal \\{++\ntext++}');

    expect(html).toContain('Literal {++\ntext++}');
    expect(html).not.toContain('manuscript-markdown-addition');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
  });

  it('keeps a multiline addition inside its list item', () => {
    const html = renderWithPlugin('- Earlier.{++\n  Added.++}');

    expect(html).toContain('<li>Earlier.<ins class="manuscript-markdown-addition">');
    expect(html.indexOf('Added.')).toBeLessThan(html.indexOf('</li>'));
  });

  it('keeps a multiline addition inside a nested list item', () => {
    const html = renderWithPlugin('- outer\n    - Earlier.{++\n      Added.++}');

    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain('Earlier.<ins class="manuscript-markdown-addition">');
    expect(html.indexOf('Added.')).toBeLessThan(html.lastIndexOf('</li>'));
  });

  it('removes quote prefixes after nested-list indentation', () => {
    const input = '- outer\n    - inner\n      > {++before\n      >\n      > after++}';
    const html = renderWithPlugin(input);

    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ins class="manuscript-markdown-addition">before');
    expect(html).toContain('after</ins>');
    expect(html).not.toContain('&gt;');
  });

  it('keeps a multiline addition on a list continuation line inside the list', () => {
    const html = renderWithPlugin('- Intro\n  Earlier.{++\n  Added.++}');

    expect(html).toContain('Earlier.<ins class="manuscript-markdown-addition">');
    expect(html.indexOf('Added.')).toBeLessThan(html.indexOf('</li>'));
  });

  it('keeps a hoisted multiline addition inside its blockquote', () => {
    const html = renderWithPlugin('> Earlier.{++\n> Added.++}');

    expect(html).toContain('<blockquote>\n<p>Earlier.</p>');
    expect(html).toContain('<p><ins class="manuscript-markdown-addition">Added.</ins></p>');
    expect(html).toContain('</p>\n</blockquote>');
    expect(html).not.toContain('&gt; Added.');
  });

  it('removes repeated blockquote prefixes from protected Critic content', () => {
    const html = renderWithPlugin('> {++before\n>\n> after++}');

    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ins class="manuscript-markdown-addition">before');
    expect(html).toContain('after</ins>');
    expect(html).not.toContain('&gt;');
  });

  it('restores source newlines inside a revised inline-math fragment', () => {
    const html = renderWithPlugin('$a{++b\nc++}$');

    expect(html).toContain('<ins class="manuscript-markdown-addition"><span class="manuscript-markdown-math-fallback">b\nc</span></ins>');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
  });

  it('does not hoist a Critic opener out of multiline inline math', () => {
    const html = renderWithPlugin('$a+{++\n+b++}$');

    expect(html).toContain('<span class="manuscript-markdown-math-fallback">a+</span>');
    expect(html).toContain('<ins class="manuscript-markdown-addition"><span class="manuscript-markdown-math-fallback">\n+b</span></ins>');
    expect(html).not.toContain('{++');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
  });

  it('keeps Critic-shaped multiline text inside raw HTML blocks literal', () => {
    const input = '<pre>\n{++a\nb++}\n</pre>';
    const html = renderWithPlugin(input);

    expect(html).toContain(input);
    expect(html).not.toContain('manuscript-markdown-addition');
    expect(html).not.toContain(PARA_PLACEHOLDER);
    expect(html).not.toContain(LINE_PLACEHOLDER);
  });

  it('keeps malformed multiline substitutions in their original paragraph', () => {
    const html = renderWithPlugin('Before{~~\nliteral~~}');

    expect(html).toContain('<p>Before{~~\nliteral~~}</p>');
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(html).not.toContain('manuscript-markdown-substitution');
    expect(html).not.toContain(PARA_PLACEHOLDER);
    expect(html).not.toContain(LINE_PLACEHOLDER);
  });

  it('restores protected aligned-math newlines before the host math renderer runs', () => {
    const md = new MarkdownIt({ html: true });
    md.inline.ruler.after('escape', 'test_opaque_display_math', (state: any, silent: boolean) => {
      if (state.src.slice(state.pos, state.pos + 2) !== '$$') return false;
      const closePos = state.src.indexOf('$$', state.pos + 2);
      if (closePos === -1) return false;
      if (!silent) {
        const token = state.push('test_opaque_display_math', 'math', 0);
        token.content = state.src.slice(state.pos + 2, closePos);
      }
      state.pos = closePos + 2;
      return true;
    });
    md.renderer.rules.test_opaque_display_math = (tokens, idx) =>
      '<opaque-math>' + escapeHtml(tokens[idx].content) + '</opaque-math>';
    md.use(manuscriptMarkdownPlugin);

    const input = 'Earlier text.{++\nAdded paragraph.\n\n$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$\n\nAdded conclusion.++}';
    const html = md.render(input);
    expect(html).toContain('<opaque-math>\n\\begin{aligned}\nx &amp;= 1 \\\\\ny &amp;= 2\n\\end{aligned}\n</opaque-math>');
    expect(html).not.toContain('PARA');
    expect(html).not.toContain('LINE');
    expect(html).not.toContain('{++');
  });
});
