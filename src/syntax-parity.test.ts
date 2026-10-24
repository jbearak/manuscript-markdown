// The preview and Word export read the same inline syntax in the same
// places (see inline-syntax.ts): each parser's tokens, as the kinds of span
// they read at the top of each paragraph's inline text, before the rules
// that rework them run, are the same.
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type Token from 'markdown-it/lib/token.mjs';
import { createMarkdownIt, parseMd, preprocessCriticMarkup } from './md-to-docx';
import { preprocessBlocks } from './block-preprocess';
import { createMarkdownItWithPlugin } from './test-helpers';
import { VALID_COLOR_IDS } from './highlight-colors';
import { formatHighlightAt, criticSpanAt } from './inline-syntax';

type Snapshot = Pick<Token, 'type' | 'content' | 'meta' | 'attrs'>;

/** A format highlight, with the color it names, where the preview knows
 *  it, as it shows only those (the default color being yellow) */
function highlightSpan(color: string | undefined): string {
  return color !== undefined && VALID_COLOR_IDS.includes(color) ? 'format_highlight:' + color : 'format_highlight';
}

const EXPORT_CRITIC_KINDS: Record<string, string> = {
  critic_add: 'addition',
  critic_del: 'deletion',
  critic_sub: 'substitution',
  critic_highlight: 'highlight',
  critic_comment: 'comment',
};

/** The spans export reads at the top of each paragraph's inline text */
function exportSpans(markdown: string): string[] {
  const tokens = createMarkdownIt().parse(preprocessCriticMarkup(preprocessBlocks(markdown).output), {});
  const spans: string[] = [];
  for (const block of tokens) {
    for (const token of block.type === 'inline' ? block.children ?? [] : []) {
      const fields = token as Token & { criticType?: string; commentId?: string };
      if (token.type === 'critic_markup') spans.push(EXPORT_CRITIC_KINDS[fields.criticType!]);
      else if (token.type === 'comment_body_with_id') spans.push('comment#' + fields.commentId);
      else if (token.type === 'comment_range_start') spans.push('range_start#' + fields.commentId);
      else if (token.type === 'comment_range_end') spans.push('range_end#' + fields.commentId);
      else if (token.type === 'highlight_open') spans.push(highlightSpan((token as Token & { color?: string }).color));
      else if (token.type === 'citation') spans.push('citation');
      else if (token.type === 'cross_reference') spans.push('cross_reference');
      else if (token.type === 'link_open') spans.push('link');
    }
  }
  return spans;
}

const PREVIEW_SPAN = /^manuscript_markdown_(addition|deletion|substitution|highlight|comment|format_highlight)_(open|close)$/;

/** The spans the preview reads at the top of each paragraph's inline text,
 *  as its inline rules leave them, before its core rules rework them, as
 *  into comments on the elements they follow. A substitution with one side
 *  empty is a change of the other, as export reads it. */
function previewSpans(markdown: string): string[] {
  const md = createMarkdownItWithPlugin('github');
  let inlines: Snapshot[][] = [];
  md.core.ruler.after('inline', 'parity_snapshot', state => {
    inlines = state.tokens.filter(token => token.type === 'inline').map(token =>
      (token.children ?? []).map(child => ({ type: child.type, content: child.content, meta: child.meta ? { ...child.meta } : child.meta, attrs: child.attrs?.map(([name, value]) => [name, value]) ?? null })));
  });
  md.parse(markdown, {});
  const spans: string[] = [];
  for (const children of inlines) {
    let depth = 0;
    for (let i = 0; i < children.length; i++) {
      const { type, meta } = children[i];
      const span = PREVIEW_SPAN.exec(type);
      if (span) {
        const [, kind, side] = span;
        if (side === 'open' && depth === 0) {
          if (kind === 'substitution') {
            let newOpen = i + 1;
            while (children[newOpen].type !== 'manuscript_markdown_substitution_new_open') newOpen++;
            const oldEmpty = children[i + 2].type === 'manuscript_markdown_substitution_old_close';
            const newEmpty = children[newOpen + 1].type === 'manuscript_markdown_substitution_new_close';
            spans.push(oldEmpty === newEmpty ? 'substitution' : oldEmpty ? 'addition' : 'deletion');
          } else {
            spans.push(kind === 'comment' && meta?.id !== undefined ? 'comment#' + meta.id
              : kind === 'format_highlight' ? highlightSpan(/manuscript-markdown-highlight-(\S+)/.exec(children[i].attrs?.find(([name]) => name === 'class')?.[1] ?? '')?.[1])
              : kind);
          }
        }
        // A format highlight's text is read with the paragraph's, as export
        // reads it, but CriticMarkup's is its own
        if (kind !== 'format_highlight') depth += side === 'open' ? 1 : -1;
        continue;
      }
      if (depth > 0 || type.startsWith('manuscript_markdown_substitution_')) continue;
      if (type === 'manuscript_markdown_range_marker') spans.push((meta.type === 'start' ? 'range_start#' : 'range_end#') + meta.id);
      else if (type === 'manuscript_citation') spans.push('citation');
      else if (type === 'manuscript_cross_reference') spans.push('cross_reference');
      else if (type === 'link_open') spans.push('link');
    }
  }
  return spans;
}

// Pieces of inline syntax, whole and in part, on one line. Not $, which
// export reads as math and the preview leaves to VS Code's math extension,
// nor a footnote's reference, which the preview doesn't read.
const PIECES = [
  '{++', '++}', '{--', '--}', '{~~', '~>', '~~}', '{==', '==}', '==', '{>>', '<<}',
  '{#a}', '{/a}', '{#a>>', '{#fig-a}', '{red}', '{yellow}', '{', '}', '\\',
  '[@k]', '[see @k, p. 2]', '[', '](u)', ']', '@fig-a', '[@fig-a]',
  '*', '`', '<!--', '-->', '<b>', '</b>', 'a', 'b', ' ',
];

describe('preview and export read the same inline syntax', () => {
  test.each([
    // A critic highlight's opener with no closer opens no format highlight
    ']{==b==',
    '{=={--[<b>==](u)',
    // A link around a citation or a cross-reference stays a link
    '[see [@k]](u)',
    '[a [@fig-a] b](u)',
    // A highlight's color, whose name the export keeps
    '==a=={red} ==b=={yellow} ==c=={nocolor}',
    // CriticMarkup only within a link's text
    '[a {++b](u) c++}',
    // Each kind, whole
    '{++a++} {--b--} {~~c~>d~~} {==e==}{>>f<<} {#x}g{/x}{#x>>h<<} ==i=={red} [@k] [@fig-a]',
  ])('%s', (markdown: string) => {
    expect(previewSpans(markdown)).toEqual(exportSpans(markdown));
  });

  test('in any text on one line', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...PIECES), { maxLength: 12 }), pieces => {
      const markdown = pieces.join('');
      expect(previewSpans(markdown)).toEqual(exportSpans(markdown));
    }), { numRuns: 3000 });
  }, 60_000);
});

describe('export reads the spans as the preview shows them', () => {
  test('an unclosed critic highlight is text', () => {
    expect(parseMd(']{==b==')[0].runs).toEqual([expect.objectContaining({ type: 'text', text: ']{==b==' })]);
  });

  test('a link around a citation keeps its link', () => {
    const runs = parseMd('[see [@k]](https://e.org) b')[0].runs;
    expect(runs.map(run => [run.type, run.text, run.href])).toEqual([
      ['text', 'see ', 'https://e.org'],
      ['citation', '@k', 'https://e.org'],
      ['text', ' b', undefined],
    ]);
  });
});

describe('a span ends by the end of the text read', () => {
  test('a color past it is none', () => {
    expect(formatHighlightAt({ src: '==a=={red}', posMax: 9 }, 0)).toEqual({ contentStart: 2, contentEnd: 3, color: undefined, end: 5 });
    expect(formatHighlightAt({ src: '==a=={red}', posMax: 10 }, 0)).toEqual({ contentStart: 2, contentEnd: 3, color: 'red', end: 10 });
  });

  test('CriticMarkup whose closer is past it is none', () => {
    expect(criticSpanAt({ src: '{++a++}', posMax: 6 }, 0)).toBeUndefined();
    expect(criticSpanAt({ src: '{>>a<<}', posMax: 6 }, 0)).toBeUndefined();
    expect(criticSpanAt({ src: '{#a>>b<<}', posMax: 8 }, 0)).toBeUndefined();
    expect(criticSpanAt({ src: '{#a}', posMax: 3 }, 0)).toBeUndefined();
    expect(criticSpanAt({ src: '{++a++}', posMax: 7 }, 0)).toEqual({ kind: 'addition', contentStart: 3, contentEnd: 4, end: 7 });
  });
});
