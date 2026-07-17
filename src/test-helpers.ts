import MarkdownIt from 'markdown-it';
import { manuscriptMarkdownPlugin, type ManuscriptMarkdownIt } from './preview/manuscript-markdown-plugin';
import type { ColorScheme } from './frontmatter';

/** Escape HTML entities the same way markdown-it does. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip all HTML tags from a string. */
export function stripHtmlTags(str: string): string {
  return str.replace(/<[^>]+>/g, '');
}

/** Filter out strings with Markdown or HTML special characters that would be transformed. */
export const hasNoSpecialSyntax = (s: string) => {
  return !/[\\`*_\[\]&<>"']/.test(s);
};

/** Create a MarkdownIt instance with the Manuscript Markdown plugin and render input.
 *  Pass colorScheme to override the module-level default (e.g. 'github' to suppress the
 *  color marker span in tests that don't care about color scheme behavior). */
export function renderWithPlugin(input: string, colorScheme?: ColorScheme): string {
  const md: ManuscriptMarkdownIt = new MarkdownIt({ html: true });
  if (colorScheme !== undefined) md.manuscriptColors = colorScheme;
  md.use(manuscriptMarkdownPlugin);
  return md.render(input);
}

/** CriticMarkup type definitions for parameterized tests. */
export interface CriticType {
  name: string;
  open: string;
  close: string;
  cssClass: string;
  tag: string;
  /** For substitution: the separator between old and new text */
  separator?: string;
}

/** The 5 CriticMarkup types used in parameterized tests. */
export const CRITIC_TYPES: CriticType[] = [
  { name: 'addition', open: '{++', close: '++}', cssClass: 'manuscript-markdown-addition', tag: 'ins' },
  { name: 'deletion', open: '{--', close: '--}', cssClass: 'manuscript-markdown-deletion', tag: 'del' },
  { name: 'highlight', open: '{==', close: '==}', cssClass: 'manuscript-markdown-highlight', tag: 'mark' },
  { name: 'comment', open: '{>>', close: '<<}', cssClass: 'manuscript-markdown-comment', tag: 'span' },
  { name: 'substitution', open: '{~~', close: '~~}', cssClass: 'manuscript-markdown-substitution', tag: 'span', separator: '~>' },
];

/** CriticMarkup types excluding substitution (for simpler parameterized loops). */
export const SIMPLE_CRITIC_TYPES = CRITIC_TYPES.filter(t => t.name !== 'substitution');

/** Build a CriticMarkup pattern string from a type and content. */
export function buildCriticPattern(type: CriticType, content: string, newContent?: string): string {
  if (type.separator) {
    if (newContent === undefined) {
      throw new Error(
        'buildCriticPattern: newContent is required when CriticType.separator is set (type: ' + type.name + ')'
      );
    }
    return type.open + content + type.separator + newContent + type.close;
  }
  return type.open + content + type.close;
}

/** Typed CriticMarkup pattern extracted from markdown text. */
export interface CriticMarkupMatch {
  type: 'addition' | 'deletion' | 'substitution' | 'highlight' | 'comment';
  full: string;
  content: string;
  /** For substitution: the old text */
  oldText?: string;
  /** For substitution: the new text */
  newText?: string;
}

/**
 * Extract all CriticMarkup patterns from markdown text.
 * Returns typed objects with type, full match, and content.
 */
export function extractCriticMarkupPatterns(md: string): CriticMarkupMatch[] {
  const patterns: CriticMarkupMatch[] = [];
  const regex = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}|\{>>([\s\S]*?)<<\}/g;
  let match;
  while ((match = regex.exec(md)) !== null) {
    if (match[1] !== undefined) {
      patterns.push({ type: 'addition', full: match[0], content: match[1] });
    } else if (match[2] !== undefined) {
      patterns.push({ type: 'deletion', full: match[0], content: match[2] });
    } else if (match[3] !== undefined) {
      patterns.push({ type: 'substitution', full: match[0], content: match[3] + '~>' + match[4], oldText: match[3], newText: match[4] });
    } else if (match[5] !== undefined) {
      patterns.push({ type: 'highlight', full: match[0], content: match[5] });
    } else if (match[6] !== undefined) {
      patterns.push({ type: 'comment', full: match[0], content: match[6] });
    }
  }
  return patterns;
}
