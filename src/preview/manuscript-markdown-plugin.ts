import type MarkdownIt from 'markdown-it';
import { imagePathsWithSpaces } from '../image-paths';
import { codeSpansOfSpaces } from '../code-spans';
import { linearInlineComments } from '../inline-html-comments';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { VALID_COLOR_IDS, getDefaultHighlightColor } from '../highlight-colors';
import {
  PARA_PLACEHOLDER,
  LINE_PLACEHOLDER,
  criticBreaksEndLinks,
  criticBreaksInRawHtml,
  criticBreaksLeftOver,
  criticCloserSearchOf,
  commentTooltipText,
  hasCriticBreak,
  iterateCriticBreaks,
  matchCriticBreakAt,
  matchCriticHeadingPrefix,
  restoreCriticLineBreaks,
  type CriticBreakKind,
} from '../critic-markup';
import { GRID_TABLE_PLACEHOLDER_PREFIX, gridColumnAlign } from '../grid-table-preprocess';
import { preprocessGridTablesWithMap, wrapBareLatexEnvironmentsWithMap, preprocessCriticMarkupWithMap } from './preprocess-with-map';
import { LineMap } from './line-map';
import { pushAll, spliceAll } from '../arrays';
import { attributeValue, captionLabelText, captionOptions, captionSeparator, DEFAULT_CAPTION_OPTIONS, isCaptionLabelId, isCaptionText, tableCaptionSource, type CaptionOptions, type FigureAttributes } from '../captions';
import { preprocessEmbedsWithMap, type EmbedResolver, type EmbedOptions } from '../embed-preprocess';
import { isGfmDisallowedRawHtml, escapeHtmlText, parseTaskListMarker, parseGfmAlertMarker, gfmAlertTitle, type GfmAlertType } from '../gfm';
import { blockListAfter, parseFrontmatter, type ColorScheme } from '../frontmatter';
import { styleFence } from '../style-fence';
import { htmlBlockKind } from '../html-blocks';
import { extractHtmlTables } from '../html-table-parser';
import { formatTableNumbers } from '../table-number-format';
import { getDefaultColorScheme } from '../alert-colors';
import { splitCriticMarkupInMath, type CriticMathPart } from '../critic-math';
import { findDollarMathAt } from '../math-delimiters';
import { CITATION_ITEM_START_RE, citationEnd, citationPrefixText, crossRefAt, crossRefLabel } from '../citation-syntax';
import { normalizeNewlines } from '../newlines';

export interface ManuscriptMarkdownIt extends MarkdownIt {
  manuscriptColors?: ColorScheme;
  manuscriptEmbedResolver?: EmbedResolver;
  manuscriptEmbedOptions?: EmbedOptions;
  manuscriptDocumentPath?: string;
  manuscriptGetDocumentPath?: (src: string) => string | undefined;
  manuscriptPreviewMarkup?: PreviewMarkup;
}

/** How much of the tracked changes the preview shows, as Word's markup
 *  views do: 'all' shows each change as marked, and 'none' the text as it
 *  reads with every change accepted, with its comments still shown */
export type PreviewMarkup = 'all' | 'none';

interface PreviewEnvironment {
  /** The words and separator a caption shows, and where it goes (see captions.ts) */
  captions?: CaptionOptions;
  calloutLabels?: boolean;
  colorScheme?: ColorScheme;
  currentDocument?: string | { fsPath?: unknown };
  lineMap?: LineMap;
  manuscriptInlineSourceBase?: number;
}

function getPreviewEnvironment(state: StateCore): PreviewEnvironment {
  return state.env as PreviewEnvironment;
}

/** Escape HTML special characters for use in attribute values */
function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function alertOcticonSvg(type: GfmAlertType): string {
  const common = 'class="octicon markdown-alert-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"';
  switch (type) {
    case 'note':
      return '<svg ' + common + '><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>';
    case 'tip':
      return '<svg ' + common + '><path d="M8 1.5a4.5 4.5 0 0 0-2.106 8.478.75.75 0 0 1 .356.643v.629h3.5v-.63a.75.75 0 0 1 .356-.642A4.5 4.5 0 0 0 8 1.5ZM2 6a6 6 0 1 1 11.693 1.897 6.5 6.5 0 0 1-2.044 2.213c-.015.01-.024.024-.024.04v.85A1.5 1.5 0 0 1 10.125 12h-4.25a1.5 1.5 0 0 1-1.5-1.5v-.85c0-.015-.009-.03-.024-.04A6.501 6.501 0 0 1 2 6Zm3.75 7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z"/></svg>';
    case 'important':
      return '<svg ' + common + '><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>';
    case 'warning':
      return '<svg ' + common + '><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>';
    case 'caution':
      return '<svg ' + common + '><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>';
    default: {
      return '';
    }
  }
}

interface AlertHit { inlineIdx: number; paraOpenIdx: number; type: GfmAlertType; rest: string }

/**
 * Whether children[c] can hold a task's box or an alert's marker, as GFM
 * reads one: text, not code, formatting, a link or an escaped [, that starts
 * the paragraph, after any empty text, or with `afterBreak` a line.
 */
function holdsMarker(children: Token[], c: number, afterBreak = false): boolean {
  if (children[c]?.type !== 'text') return false;
  for (let k = c - 1; k >= 0; k--) {
    if (afterBreak && (children[k].type === 'softbreak' || children[k].type === 'hardbreak')) return true;
    if (children[k].type !== 'text' || children[k].content !== '') return false;
  }
  return true;
}

function alertBlockquoteRule(state: StateCore): void {
  // Each top-level quote's tokens on their own, so a splice in one moves
  // that quote's tokens after it, not all of the document's
  const tokens = state.tokens;
  const out: Token[] = [];
  for (let i = 0; i < tokens.length;) {
    if (tokens[i].type !== 'blockquote_open') {
      out.push(tokens[i++]);
      continue;
    }
    let depth = 0;
    let end = i;
    do {
      if (tokens[end].type === 'blockquote_open') depth++;
      else if (tokens[end].type === 'blockquote_close') depth--;
      end++;
    } while (depth > 0 && end < tokens.length);
    const quote = tokens.slice(i, end);
    splitAlertsInQuote(state, quote);
    pushAll(out, quote);
    i = end;
  }
  tokens.length = 0;
  pushAll(tokens, out);
}

/** Alerts in `tokens`, those of one top-level quote, marked on their quotes,
 *  with each of more than one in a quote or a paragraph in a quote of its
 *  own */
function splitAlertsInQuote(state: StateCore, tokens: Token[]): void {
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type !== 'blockquote_open') { i++; continue; }
    let depth = 1;
    let closeIdx = i + 1;
    while (closeIdx < tokens.length) {
      if (tokens[closeIdx].type === 'blockquote_open') depth++;
      else if (tokens[closeIdx].type === 'blockquote_close') {
        depth--;
        if (depth === 0) break;
      }
      closeIdx++;
    }
    if (closeIdx >= tokens.length) { i++; continue; }

    // Pre-pass: when a single inline token contains multiple [!TYPE] markers
    // (merged blockquotes without blank lines), split it into separate
    // paragraph_open/inline/paragraph_close groups within the blockquote.
    for (let j = i + 1; j < closeIdx; j++) {
      const inlineToken = tokens[j];
      const children = inlineToken.children;
      if (inlineToken.type !== 'inline' || !children) continue;
      // Find all child indices that are alert markers
      const markerChildIndices: number[] = [];
      for (let c = 0; c < children.length; c++) {
        if (holdsMarker(children, c, true) && parseGfmAlertMarker(children[c].content)) {
          markerChildIndices.push(c);
        }
      }
      if (markerChildIndices.length === 0) continue;
      // Single marker that IS the first text child — no split needed
      const firstTextChildIdx = children.findIndex(c => c.type === 'text' && c.content.length > 0);
      if (markerChildIndices.length === 1 && markerChildIndices[0] === firstTextChildIdx) continue;

      // Find the paragraph_open and paragraph_close around this inline
      let pOpenIdx = j - 1;
      while (pOpenIdx > i && tokens[pOpenIdx].type !== 'paragraph_open') pOpenIdx--;
      let pCloseIdx = j + 1;
      while (pCloseIdx < closeIdx && tokens[pCloseIdx].type !== 'paragraph_close') pCloseIdx++;

      // Build replacement tokens: one paragraph group per marker segment
      const replacement: Token[] = [];
      // Content before first marker (plain blockquote paragraph)
      if (markerChildIndices[0] > 0) {
        let preChildren = children.slice(0, markerChildIndices[0]);
        // Strip trailing softbreaks
        while (preChildren.length > 0 && preChildren[preChildren.length - 1].type === 'softbreak') preChildren = preChildren.slice(0, -1);
        if (preChildren.length > 0) {
          const pOpen = new state.Token('paragraph_open', 'p', 1);
          replacement.push(pOpen);
          const inlineTok = new state.Token('inline', '', 0);
          inlineTok.children = preChildren;
          inlineTok.content = preChildren.map(c => c.content || '').join('');
          replacement.push(inlineTok);
          replacement.push(new state.Token('paragraph_close', 'p', -1));
        }
      }
      for (let m = 0; m < markerChildIndices.length; m++) {
        const start = markerChildIndices[m];
        const end = m + 1 < markerChildIndices.length ? markerChildIndices[m + 1] : children.length;
        let segChildren = children.slice(start, end);
        // Strip leading/trailing softbreaks
        while (segChildren.length > 0 && segChildren[0].type === 'softbreak') segChildren = segChildren.slice(1);
        while (segChildren.length > 0 && segChildren[segChildren.length - 1].type === 'softbreak') segChildren = segChildren.slice(0, -1);
        if (segChildren.length > 0) {
          const pOpen = new state.Token('paragraph_open', 'p', 1);
          replacement.push(pOpen);
          const inlineTok = new state.Token('inline', '', 0);
          inlineTok.children = segChildren;
          inlineTok.content = segChildren.map(c => c.content || '').join('');
          replacement.push(inlineTok);
          replacement.push(new state.Token('paragraph_close', 'p', -1));
        }
      }
      // Replace paragraph_open/inline/paragraph_close with expanded groups
      const removeCount = pCloseIdx - pOpenIdx + 1;
      spliceAll(tokens, pOpenIdx, removeCount, replacement);
      closeIdx += replacement.length - removeCount;
      // Re-scan from current position
      j = pOpenIdx - 1;
    }

    // Collect all top-level inline tokens that start with an alert marker.
    // Track the paragraph_open index preceding each hit for splitting.
    const hits: AlertHit[] = [];
    let nestedDepth = 0;
    for (let j = i + 1; j < closeIdx; j++) {
      const token = tokens[j];
      if (token.type === 'blockquote_open') { nestedDepth++; continue; }
      if (token.type === 'blockquote_close') { nestedDepth--; continue; }
      if (nestedDepth > 0) continue;
      if (token.type !== 'inline' || !token.children) continue;
      const firstTextIdx = token.children.findIndex(child => child.type === 'text' && child.content.length > 0);
      if (!holdsMarker(token.children, firstTextIdx)) continue;
      const parsed = parseGfmAlertMarker(token.children[firstTextIdx].content);
      if (!parsed) continue;
      let paraOpenIdx = j - 1;
      while (paraOpenIdx > i && tokens[paraOpenIdx].type !== 'paragraph_open') paraOpenIdx--;
      hits.push({ inlineIdx: j, paraOpenIdx, type: parsed.type, rest: parsed.rest });
    }

    if (hits.length === 0) { i++; continue; }

    // Strip marker text from all hits. When the generated title is hidden,
    // also remove the source-line separator so breaks mode does not render
    // an empty first row before the authored body.
    const hidesAlertLabels = getPreviewEnvironment(state).calloutLabels === false;
    for (const hit of hits) {
      const children = tokens[hit.inlineIdx].children;
      if (!children) continue;
      const firstTextIdx = children.findIndex(child => child.type === 'text' && child.content.length > 0);
      if (firstTextIdx === -1) continue;
      children[firstTextIdx].content = hit.rest;
      if (hidesAlertLabels && hit.rest.length === 0) {
        let separatorIndex = firstTextIdx + 1;
        while (
          (children[separatorIndex]?.type === 'html_inline'
            && /^<!--[\s\S]*-->$/.test(children[separatorIndex].content.trim()))
          || (children[separatorIndex]?.type === 'text'
            && children[separatorIndex].content.trim().length === 0)
        ) {
          separatorIndex++;
        }
        const separator = children[separatorIndex];
        if (separator?.type === 'softbreak' || separator?.type === 'hardbreak') {
          children.splice(separatorIndex, 1);
        }
        const markerParagraphIsEmpty = children.every(child =>
          (child.type === 'text' && child.content.trim().length === 0)
          || (child.type === 'html_inline'
            && /^<!--[\s\S]*-->$/.test(child.content.trim()))
        );
        if (markerParagraphIsEmpty) {
          tokens[hit.paraOpenIdx].hidden = true;
          const paragraphClose = tokens[hit.inlineIdx + 1];
          if (paragraphClose?.type === 'paragraph_close') {
            paragraphClose.hidden = true;
          }
        }
      }
    }

    if (hits.length === 1) {
      // Single alert — just annotate the blockquote_open
      tokens[i].meta = {
        ...(tokens[i].meta || {}),
        gfmAlertType: hits[0].type,
        gfmAlertTitle: gfmAlertTitle(hits[0].type),
      };
      i = closeIdx + 1;
      continue;
    }

    // Multiple alert markers — rebuild the token segment.
    // Collect inner tokens (between blockquote_open and blockquote_close).
    const inner = tokens.slice(i + 1, closeIdx);
    // Map all hit paraOpenIdx to offsets within inner (subtract i+1)
    const allOffsets = hits.map(h => h.paraOpenIdx - (i + 1));

    const rebuilt: Token[] = [];

    // Content before the first alert marker becomes a plain blockquote
    if (allOffsets[0] > 0) {
      const bqOpen = new state.Token('blockquote_open', 'blockquote', 1);
      bqOpen.markup = '>';
      bqOpen.map = tokens[i].map;
      rebuilt.push(bqOpen);
      for (let k = 0; k < allOffsets[0]; k++) {
        rebuilt.push(inner[k]);
      }
      const bqClose = new state.Token('blockquote_close', 'blockquote', -1);
      bqClose.markup = '>';
      rebuilt.push(bqClose);
    }

    for (let h = 0; h < hits.length; h++) {
      const startOffset = allOffsets[h];
      const endOffset = h + 1 < hits.length ? allOffsets[h + 1] : inner.length;
      const bqOpen = new state.Token('blockquote_open', 'blockquote', 1);
      bqOpen.markup = '>';
      bqOpen.map = tokens[i].map;
      bqOpen.meta = { gfmAlertType: hits[h].type, gfmAlertTitle: gfmAlertTitle(hits[h].type) };
      rebuilt.push(bqOpen);
      for (let k = startOffset; k < endOffset; k++) {
        rebuilt.push(inner[k]);
      }
      const bqClose = new state.Token('blockquote_close', 'blockquote', -1);
      bqClose.markup = '>';
      rebuilt.push(bqClose);
    }

    // Replace original blockquote_open...blockquote_close with rebuilt
    spliceAll(tokens, i, closeIdx - i + 1, rebuilt);
    // Don't increment i — re-process from same position since rebuilt tokens
    // are already annotated and won't match the hits scan again
    i += rebuilt.length;
  }
}

/** A display equation's fence, as VS Code's math extension reads one */
const DISPLAY_MATH_FENCE = '$'.repeat(2);

/**
 * Core rule: the text after a display equation's closing fence on its
 * line, as import writes the text that goes on in the equation's paragraph,
 * in a paragraph after the equation, as text on the next line is, or at the
 * start of the paragraph on the next line, which goes on from it, as export
 * writes both in the equation's Word paragraph. VS Code's math extension's
 * block rule ends the equation at that fence and leaves the rest of the line
 * out, so the preview showed none of that text. A $ right after the fence
 * stays text, as export opens no inline math there, after the fence's $.
 * In passes over the tokens, each once, for a document of many equations.
 */
function displayMathTailRule(state: StateCore): void {
  const tokens = state.tokens;
  let lines: string[] | undefined;
  // The text after each equation's closing fence, by its token's index
  const tails = new Map<number, { text: string; closing: number }>();
  // The line the block after the token at hand starts on
  let nextStart = Infinity;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    const after = nextStart;
    if (token.map) nextStart = token.map[0];
    if (token.type !== 'math_block' || token.markup !== DISPLAY_MATH_FENCE || !token.map) continue;
    // Its last line, which holds the closing fence, where the rule found
    // one: not the opening fence's, which ends with it if it closes there,
    // nor one the block after it starts on, as where it found none
    const closing = token.map[1] - 1;
    if (closing <= token.map[0] || after <= closing) continue;
    lines ??= state.src.split('\n');
    const line = lines[closing] ?? '';
    const fence = line.indexOf(DISPLAY_MATH_FENCE);
    // At the line's start, after a list item's indent or a quote's >, as
    // import writes it; a line that ends with a fence holds the equation's
    // text before it
    if (fence === -1 || !/^[ \t>]*$/.test(line.slice(0, fence)) || line.trimEnd().endsWith(DISPLAY_MATH_FENCE)) continue;
    const rest = line.slice(fence + DISPLAY_MATH_FENCE.length);
    // Without the spaces before it, as a paragraph's line, but with those
    // after it, a line break's before a line that goes on from it
    const text = (rest.startsWith('$') ? '\\' : '') + rest.replace(/^[ \t]+/, '');
    if (text.trim()) tails.set(i, { text, closing });
  }
  if (tails.size === 0) return;
  // Whether each list's paragraphs are hidden, as a tight list's are, by
  // the list's token: the block each token at a level is in is the last
  // one opened at the level before it. From its paragraphs, or, in a list
  // of equations alone, as markdown-it reads one tight: with no blank line
  // between its items' blocks, nor at the end of one that another follows
  const openAt: Token[] = [];
  const tight = new Map<Token, boolean>();
  const blocks = new Map<Token, { end: number; loose: boolean }>();
  const blank = (line: number) => /^[ \t>]*$/.test(lines![line] ?? '');
  for (const token of tokens) {
    const item = openAt[token.level - 1];
    if (item?.type === 'list_item_open' && token.map && token.nesting !== -1) {
      const list = openAt[token.level - 2];
      if (token.type === 'paragraph_open') tight.set(list, token.hidden);
      const before = blocks.get(list);
      let loose = before?.loose ?? false;
      for (let line = before ? before.end - 1 : token.map[0]; !loose && line < token.map[0]; line++) loose = blank(line);
      blocks.set(list, { end: token.map[1], loose });
    }
    if (token.nesting === 1) openAt[token.level] = token;
  }
  const output: Token[] = [];
  openAt.length = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    output.push(token);
    if (token.nesting === 1) openAt[token.level] = token;
    const tail = tails.get(i);
    if (!tail) continue;
    const { text, closing } = tail;
    // The paragraph on the next line, which goes on from the text
    const next = tokens[i + 1];
    if (next?.type === 'paragraph_open' && next.map?.[0] === closing + 1 && tokens[i + 2]?.type === 'inline') {
      const inline = tokens[i + 2];
      inline.content = text + '\n' + inline.content;
      next.map = [closing, next.map[1]];
      if (inline.map) inline.map = [closing, inline.map[1]];
      continue;
    }
    const list = openAt[token.level - 2];
    const hidden = openAt[token.level - 1]?.type === 'list_item_open' && (tight.get(list) ?? !blocks.get(list)?.loose);
    const open = new state.Token('paragraph_open', 'p', 1);
    const inline = new state.Token('inline', '', 0);
    const close = new state.Token('paragraph_close', 'p', -1);
    open.map = inline.map = [closing, closing + 1];
    open.level = close.level = token.level;
    inline.level = token.level + 1;
    open.block = inline.block = close.block = true;
    open.hidden = close.hidden = hidden;
    inline.content = text.trim();
    inline.children = [];
    output.push(open, inline, close);
  }
  state.tokens = output;
}

function autolinkLiteralsRule(state: StateCore): void {
  const urlPattern = /https?:\/\/[^\s<]+/g;
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    const nextChildren: Token[] = [];
    let insideLink = false;
    for (const child of blockToken.children) {
      if (child.type === 'link_open') {
        insideLink = true;
        nextChildren.push(child);
        continue;
      }
      if (child.type === 'link_close') {
        insideLink = false;
        nextChildren.push(child);
        continue;
      }
      if (insideLink || child.type !== 'text' || !urlPattern.test(child.content)) {
        urlPattern.lastIndex = 0;
        nextChildren.push(child);
        continue;
      }
      urlPattern.lastIndex = 0;
      let cursor = 0;
      let match: RegExpExecArray | null;
      while ((match = urlPattern.exec(child.content)) !== null) {
        const start = match.index;
        let url = match[0];
        while (/[).,!?;:]$/.test(url)) {
          url = url.slice(0, -1);
        }
        const end = start + url.length;
        if (start > cursor) {
          const textBefore = new state.Token('text', '', 0);
          textBefore.content = child.content.slice(cursor, start);
          nextChildren.push(textBefore);
        }
        const open = new state.Token('link_open', 'a', 1);
        open.attrSet('href', url);
        nextChildren.push(open);
        const text = new state.Token('text', '', 0);
        text.content = url;
        nextChildren.push(text);
        nextChildren.push(new state.Token('link_close', 'a', -1));
        cursor = end;
      }
      if (cursor < child.content.length) {
        const textAfter = new state.Token('text', '', 0);
        textAfter.content = child.content.slice(cursor);
        nextChildren.push(textAfter);
      }
    }
    blockToken.children = nextChildren;
  }
}

/** Core rule: detect GFM task list markers at list item starts and mark list_item_open tokens. */
function taskListRule(state: StateCore): void {
  // Each open list item, and whether its first block has gone by, as GFM
  // reads a box only at the start of an item's first paragraph
  const stack: Array<{ index: number; started: boolean }> = [];
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'list_item_open') {
      stack.push({ index: i, started: false });
      continue;
    }
    if (token.type === 'list_item_close') {
      stack.pop();
      continue;
    }
    const item = stack[stack.length - 1];
    if (!item || item.started || token.nesting === -1 || token.type === 'inline') continue;
    item.started = true;
    const inline = state.tokens[i + 1];
    if (token.type !== 'paragraph_open' || inline?.type !== 'inline' || !inline.children) continue;

    const listItemOpen = state.tokens[item.index];
    if (listItemOpen.meta?.taskChecked !== undefined) continue;
    const children = inline.children;

    const firstTextIdx = children.findIndex(child => child.type === 'text' && child.content.length > 0);
    if (!holdsMarker(children, firstTextIdx)) continue;
    const firstText = children[firstTextIdx];
    const parsed = parseTaskListMarker(firstText.content);
    if (!parsed) continue;

    listItemOpen.meta = { ...(listItemOpen.meta || {}), taskChecked: parsed.checked };
    firstText.content = parsed.rest;
  }
}

interface CriticBreakSource {
  kind: CriticBreakKind;
  sourceOffset: number;
}

interface CriticHeadingBoundary {
  kind: CriticBreakKind;
  sourceOffset?: number;
}

/** Record absolute inline-source offsets so nested payload breaks retain their original positions. */
function collectProtectedBreaks(content: string, sourceBase: number): CriticBreakSource[] {
  const breaks: CriticBreakSource[] = [];
  for (const match of iterateCriticBreaks(content)) {
    breaks.push({ kind: match.kind, sourceOffset: sourceBase + match.index });
  }
  return breaks;
}

/** Copy mutable token attributes and metadata before reusing a wrapper in another paragraph. */
function cloneInlineToken(state: StateCore, source: Token): Token {
  const clone = Object.assign(new state.Token(source.type, source.tag, source.nesting), source);
  clone.attrs = source.attrs?.map(([name, value]) => [name, value]) ?? null;
  clone.map = source.map ? [...source.map] : null;
  clone.meta = source.meta ? { ...source.meta } : null;
  return clone;
}

/** Create a matching closing token when a paragraph boundary interrupts an open inline wrapper. */
function closeTokenFor(state: StateCore, open: Token): Token {
  const type = open.type.endsWith('_open')
    ? open.type.slice(0, -'_open'.length) + '_close'
    : open.type;
  const close = new state.Token(type, open.tag, -1);
  close.level = open.level;
  close.markup = open.markup;
  close.block = open.block;
  close.hidden = open.hidden;
  return close;
}

function isEntirelyCriticKind(children: Token[], criticType: 'addition' | 'deletion'): boolean {
  const openType = 'manuscript_markdown_' + criticType + '_open';
  const closeType = 'manuscript_markdown_' + criticType + '_close';
  let depth = 0;
  for (const child of children) {
    if (depth === 0) {
      if (child.type !== openType) return false;
      depth = 1;
      continue;
    }
    if (child.nesting === 1) depth++;
    if (child.nesting === -1) {
      depth--;
      if (depth === 0 && child.type !== closeType) return false;
    }
  }
  return depth === 0;
}

function isVisibleInlineToken(token: Token, content = token.content): boolean {
  // A range's marker, which writes nothing, or only a span's tag (see
  // commentRangeSpansRule)
  if (token.nesting !== 0 || token.type === 'softbreak' || token.type === 'hardbreak' || token.type === 'manuscript_markdown_range_marker') return false;
  if (token.type === 'text' || token.type === 'html_inline') return content.trim().length > 0;
  return true;
}

function hasHeadingContent(children: Token[], firstTextIndex: number, markerLength: number): boolean {
  for (let index = firstTextIndex; index < children.length; index++) {
    const token = children[index];
    if (token.type === 'softbreak' || token.type === 'hardbreak') return false;
    const content = index === firstTextIndex ? token.content.slice(markerLength) : token.content;
    if (isVisibleInlineToken(token, content)) return true;
  }
  return false;
}

function promoteFullParagraphCriticHeading(tokens: Token[], index: number): void {
  const paragraphOpen = tokens[index];
  const inline = tokens[index + 1];
  const paragraphClose = tokens[index + 2];
  if (paragraphOpen?.type !== 'paragraph_open' || inline?.type !== 'inline' ||
      paragraphClose?.type !== 'paragraph_close' || paragraphOpen.level !== 0 ||
      !inline.children) return;

  const children = inline.children;
  const first = children[0];
  const criticType = first?.type === 'manuscript_markdown_addition_open'
    ? 'addition'
    : first?.type === 'manuscript_markdown_deletion_open'
      ? 'deletion'
      : undefined;
  if (!criticType) return;

  const openMarker = criticType === 'addition' ? '{++' : '{--';
  if (!inline.content.startsWith(openMarker)) return;

  const body = inline.content.slice(openMarker.length);
  const headingPrefix = matchCriticHeadingPrefix(body);
  if (!headingPrefix || !isEntirelyCriticKind(children, criticType)) return;

  const firstTextIndex = children.findIndex((child, childIndex) =>
    childIndex > 0 && child.type === 'text' && child.content.length > 0
  );
  const firstText = children[firstTextIndex];
  if (!firstText?.content.startsWith(headingPrefix.prefix)) return;
  if (!hasHeadingContent(children, firstTextIndex, headingPrefix.prefix.length)) return;
  firstText.content = firstText.content.slice(headingPrefix.prefix.length);
  if (!firstText.content) children.splice(firstTextIndex, 1);

  paragraphOpen.type = 'heading_open';
  paragraphOpen.tag = 'h' + headingPrefix.level;
  paragraphOpen.markup = headingPrefix.marker;
  paragraphClose.type = 'heading_close';
  paragraphClose.tag = 'h' + headingPrefix.level;
  paragraphClose.markup = headingPrefix.marker;
  inline.content = openMarker + body.slice(headingPrefix.prefix.length);
  inline.meta = {
    ...(inline.meta || {}),
    manuscriptCriticHeadingRemovedPrefix: headingPrefix.prefix.length,
  };
}

interface CriticHeadingSourceSegment {
  content: string;
  startLineOffset: number;
  endLineOffset: number;
}

/** Map rendered block boundaries to source segments, counting both protected and ordinary newlines. */
function splitCriticHeadingSource(
  content: string,
  boundaries: CriticHeadingBoundary[],
  sourceOffsetAdjustment: number,
): CriticHeadingSourceSegment[] {
  const segments: CriticHeadingSourceSegment[] = [];
  let segmentStart = 0;
  let segmentStartLine = 0;
  let currentLine = 0;
  let boundaryIndex = 0;
  let sourceCursor = 0;
  for (const match of iterateCriticBreaks(content)) {
    currentLine += (content.slice(sourceCursor, match.index).match(/\n/g) ?? []).length;
    const boundary = boundaries[boundaryIndex];
    const expectedOffset = boundary?.sourceOffset === undefined
      ? undefined
      : boundary.sourceOffset - sourceOffsetAdjustment;
    const shouldSplit = boundary !== undefined && match.kind === boundary.kind &&
      (expectedOffset === undefined || match.index === expectedOffset);
    if (shouldSplit) {
      segments.push({
        content: content.slice(segmentStart, match.index),
        startLineOffset: segmentStartLine,
        endLineOffset: currentLine + 1,
      });
    }
    currentLine += match.lineCount;
    sourceCursor = match.index + match.length;
    if (shouldSplit) {
      segmentStart = match.index + match.length;
      segmentStartLine = currentLine;
      boundaryIndex++;
    }
  }
  if (boundaryIndex !== boundaries.length) return [];
  currentLine += (content.slice(sourceCursor).match(/\n/g) ?? []).length;
  segments.push({
    content: content.slice(segmentStart),
    startLineOffset: segmentStartLine,
    endLineOffset: currentLine + 1,
  });
  return segments;
}

interface CriticHeadingChildSplit {
  segments: Token[][];
  boundaries: CriticHeadingBoundary[];
  // How many wrappers each segment opens again at its start, those open at
  // the break before it
  reopened: number[];
}

type ActiveInlineWrapper =
  | { kind: 'token'; open: Token }
  | { kind: 'html'; open: Token; tag: string };

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function rawHtmlTag(token: Token): { kind: 'open' | 'close'; tag: string } | undefined {
  if (token.type !== 'html_inline' || isGfmDisallowedRawHtml(token.content)) return undefined;
  const close = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(token.content);
  if (close) return { kind: 'close', tag: close[1].toLowerCase() };
  const open = /^<([A-Za-z][A-Za-z0-9-]*)(?:\s|>)/.exec(token.content);
  if (!open || /\/\s*>$/.test(token.content)) return undefined;
  const tag = open[1].toLowerCase();
  return VOID_HTML_TAGS.has(tag) ? undefined : { kind: 'open', tag };
}

/** Whether a token is the start or end of a range's span (see
 *  commentRangeSpansRule) */
function isRangeSpan(token: Token): boolean {
  return token.type === 'manuscript_markdown_comment_range_open' || token.type === 'manuscript_markdown_comment_range_close';
}

/**
 * What an inline token does to the elements open around the tokens after
 * it, for the rules that close and open them again where a paragraph break
 * (see splitInlineChildrenAtCriticBreaks) or an element's end (see
 * nestCrossedElements) comes inside them: opens one, as a token that nests
 * or a raw HTML start tag but a void element's (see rawHtmlTag), or closes
 * one that `closes` matches, by its type or tag, and a range's span by its
 * ID too, or neither.
 */
function inlineWrapperStep(token: Token):
  { kind: 'open'; wrapper: ActiveInlineWrapper } | { kind: 'close'; closes: (wrapper: ActiveInlineWrapper) => boolean } | undefined {
  if (token.nesting === 1) return { kind: 'open', wrapper: { kind: 'token', open: token } };
  if (token.nesting === -1) {
    const openType = token.type.replace(/_close$/, '_open');
    return { kind: 'close', closes: wrapper => wrapper.kind === 'token' && wrapper.open.type === openType
      && (!isRangeSpan(token) || wrapper.open.meta?.id === token.meta?.id) };
  }
  const htmlTag = rawHtmlTag(token);
  if (htmlTag?.kind === 'open') return { kind: 'open', wrapper: { kind: 'html', open: token, tag: htmlTag.tag } };
  if (htmlTag?.kind === 'close') return { kind: 'close', closes: wrapper => wrapper.kind === 'html' && wrapper.tag === htmlTag.tag };
  return undefined;
}

/** The index in `stack` of the nearest element `closes` matches (see
 *  inlineWrapperStep), or -1 */
function closedWrapperIndex(stack: ActiveInlineWrapper[], closes: (wrapper: ActiveInlineWrapper) => boolean): number {
  let at = stack.length - 1;
  while (at >= 0 && !closes(stack[at])) at--;
  return at;
}

function closeActiveWrapper(state: StateCore, wrapper: ActiveInlineWrapper): Token {
  if (wrapper.kind === 'token') return closeTokenFor(state, wrapper.open);
  const close = cloneInlineToken(state, wrapper.open);
  close.content = '</' + wrapper.tag + '>';
  return close;
}

function reopenActiveWrapper(state: StateCore, wrapper: ActiveInlineWrapper): Token {
  return cloneInlineToken(state, wrapper.open);
}

/** Balance inline wrappers across protected paragraph boundaries and a heading's first line break. */
function splitInlineChildrenAtCriticBreaks(state: StateCore, inline: Token, isHeading: boolean): CriticHeadingChildSplit {
  const children = inline.children ?? [];
  const segments: Token[][] = [];
  const boundaries: CriticHeadingBoundary[] = [];
  const openStack: ActiveInlineWrapper[] = [];
  const reopened = [0];
  let segment: Token[] = [];
  let splitFirstLineBreak = isHeading;
  let afterParagraphBreak = false;
  for (let index = 0; index < children.length; index++) {
    const token = children[index];
    const next = children[index + 1];
    const sourceOffset = token.meta?.manuscriptCriticBreakSourceOffset;
    const isParagraphBreak = (token.type === 'hardbreak' || token.type === 'softbreak') &&
      next?.type === token.type && typeof sourceOffset === 'number' &&
      next.meta?.manuscriptCriticBreakSourceOffset === sourceOffset;
    const isLineBreak = token.type === 'softbreak' || (token.type === 'hardbreak' && !isParagraphBreak);
    const insideRevision = openStack.some(wrapper => wrapper.kind === 'token' &&
      (wrapper.open.type === 'manuscript_markdown_addition_open' ||
       wrapper.open.type === 'manuscript_markdown_deletion_open'));
    const shouldSplit = (isParagraphBreak && (isHeading || insideRevision)) ||
      (splitFirstLineBreak && isLineBreak) ||
      (afterParagraphBreak && isLineBreak && typeof sourceOffset === 'number');
    if (shouldSplit) {
      for (let stackIndex = openStack.length - 1; stackIndex >= 0; stackIndex--) {
        segment.push(closeActiveWrapper(state, openStack[stackIndex]));
      }
      segments.push(segment);
      segment = openStack.map(wrapper => reopenActiveWrapper(state, wrapper));
      reopened.push(openStack.length);
      boundaries.push({
        kind: isParagraphBreak ? 'paragraph' : 'line',
        sourceOffset: typeof sourceOffset === 'number' ? sourceOffset : undefined,
      });
      splitFirstLineBreak = false;
      // Extra blank lines form empty segments, which are omitted below. Keep
      // their source boundaries so the next paragraph's line map skips them.
      afterParagraphBreak = isParagraphBreak || afterParagraphBreak;
      if (isParagraphBreak) index++;
      continue;
    }

    afterParagraphBreak = false;
    segment.push(token);
    // An element's end closes its own start, which the next segment opens
    // again only while it's open, whatever opened inside it
    const step = inlineWrapperStep(token);
    if (step?.kind === 'open') {
      openStack.push(step.wrapper);
    } else if (step?.kind === 'close') {
      const at = closedWrapperIndex(openStack, step.closes);
      if (at !== -1) openStack.splice(at, 1);
    }
  }
  segments.push(segment);
  return { segments, boundaries, reopened };
}

/** Exclude wrapper and break tokens when deciding whether a segment is blank padding. */
function hasVisibleInlineContent(children: Token[]): boolean {
  return children.some(token => isVisibleInlineToken(token));
}

/** Mark a source map as original so later preview synchronization does not remap it twice. */
function setOriginalTokenMap(token: Token, map: [number, number]): void {
  token.map = map;
  token.meta = { ...(token.meta || {}), manuscriptMapIsOriginal: true };
}

/** Build a block with its original source map, omitting empty continuation segments. */
function createCriticBlockSegment(
  state: StateCore,
  headingTokens: [Token, Token, Token],
  children: Token[],
  sourceSegment: CriticHeadingSourceSegment,
  originalStart: number,
  isHeading: boolean,
): [Token, Token, Token] | undefined {
  if (!isHeading && !hasVisibleInlineContent(children)) return undefined;

  const [headingOpen, headingInline, headingClose] = headingTokens;
  const blockOpen = isHeading ? headingOpen : new state.Token('paragraph_open', 'p', 1);
  const blockInline = isHeading ? headingInline : new state.Token('inline', '', 0);
  const blockClose = isHeading ? headingClose : new state.Token('paragraph_close', 'p', -1);
  const blockLevel = headingOpen.level;
  blockOpen.level = blockLevel;
  blockOpen.block = true;
  blockInline.level = blockLevel + 1;
  blockInline.block = true;
  blockClose.level = blockLevel;
  blockClose.block = true;

  const segmentMap: [number, number] = [
    originalStart + sourceSegment.startLineOffset,
    originalStart + sourceSegment.endLineOffset,
  ];
  setOriginalTokenMap(blockOpen, segmentMap);
  setOriginalTokenMap(blockInline, segmentMap);
  blockInline.content = sourceSegment.content;
  blockInline.children = children;
  return [blockOpen, blockInline, blockClose];
}

/**
 * Each range's start or end, as Pass 2 of associateCommentsRule paired them,
 * in a segment createCriticBlockSegment omits, as the blank lines of
 * `{++{#1}a` and a blank line before `b` and another before `{/1}++}` make
 * one, moved to a segment it keeps, where the range covers the same text: a
 * start to the start of the kept segment after it, after the wrappers it
 * opens again, as the start was in them, and an end, or a range that starts
 * and ends in the segments omitted between two kept ones, which covers no
 * text, to the end of the kept segment before it, after the wrappers it
 * closes, as the span opens again before them in the paragraph after (see
 * commentRangeSpansRule). Where no segment is kept on that side, to the
 * other. As the segment went with its markers, a range lost its end, so its
 * span ended with its start's paragraph, or its start, so it had none.
 */
function keepRangeMarkers(segments: Token[][], kept: boolean[], reopened: number[]): void {
  const paired = (token: Token) => token.type === 'manuscript_markdown_range_marker'
    && (token.meta?.commentText !== undefined || token.meta?.start !== undefined);
  // The last kept segment before the omitted ones
  let before = -1;
  for (let index = 0; index < segments.length;) {
    if (kept[index]) {
      before = index++;
      continue;
    }
    // The omitted segments from here, and the kept one after them
    let after = index;
    while (after < segments.length && !kept[after]) after++;
    const markers = segments.slice(index, after).flat().filter(paired);
    const omitted = new Set(markers);
    const forward = markers.filter(marker => marker.meta.type === 'start' && !omitted.has(marker.meta.end));
    if (after < segments.length) spliceAll(segments[after], reopened[after], 0, before === -1 ? markers : forward);
    if (before !== -1) pushAll(segments[before], after < segments.length ? markers.filter(marker => !forward.includes(marker)) : markers);
    index = after;
  }
}

function promoteCriticHeadingsRule(state: StateCore): void {
  if (!state.src.includes('{++#') && !state.src.includes('{--#')) return;
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length - 2; index++) {
    promoteFullParagraphCriticHeading(tokens, index);
  }
}

/** Restore paragraph boundaries hidden from block parsing by CriticMarkup placeholders. */
function splitCriticBlocksRule(state: StateCore): void {
  if (!hasCriticBreak(state.src)) return;
  const tokens = state.tokens;
  let rewritten: Token[] | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const headingOpen = tokens[index];
    const inline = tokens[index + 1];
    const headingClose = tokens[index + 2];
    const isHeading = headingOpen?.type === 'heading_open';
    if ((!isHeading && headingOpen?.type !== 'paragraph_open') || inline?.type !== 'inline' ||
        headingClose?.type !== (isHeading ? 'heading_close' : 'paragraph_close') ||
        !hasCriticBreak(inline.content)) {
      if (rewritten) rewritten.push(headingOpen);
      continue;
    }

    const childSplit = splitInlineChildrenAtCriticBreaks(state, inline, isHeading);
    const childSegments = childSplit.segments;
    if (childSegments.length < 2 || (!isHeading && !childSegments.some(hasVisibleInlineContent))) {
      if (rewritten) rewritten.push(headingOpen);
      continue;
    }
    const removedPrefix = inline.meta?.manuscriptCriticHeadingRemovedPrefix;
    const sourceSegments = splitCriticHeadingSource(
      inline.content,
      childSplit.boundaries,
      typeof removedPrefix === 'number' ? removedPrefix : 0,
    );
    if (sourceSegments.length !== childSegments.length) {
      if (rewritten) rewritten.push(headingOpen);
      continue;
    }

    if (!rewritten) rewritten = tokens.slice(0, index);
    const lineMap = getPreviewEnvironment(state).lineMap;
    const originalStart = inline.map ? (lineMap?.remap(inline.map[0]) ?? inline.map[0]) : 0;
    const headingTokens: [Token, Token, Token] = [headingOpen, inline, headingClose];
    keepRangeMarkers(childSegments, childSegments.map((children, segmentIndex) => (isHeading && segmentIndex === 0) || hasVisibleInlineContent(children)), childSplit.reopened);
    for (let segmentIndex = 0; segmentIndex < childSegments.length; segmentIndex++) {
      const segment = createCriticBlockSegment(
        state,
        headingTokens,
        childSegments[segmentIndex],
        sourceSegments[segmentIndex],
        originalStart,
        isHeading && segmentIndex === 0,
      );
      // eslint-disable-next-line no-restricted-syntax -- a segment's three tokens
      if (segment) rewritten.push(...segment);
    }
    index += 2;
  }
  if (rewritten) state.tokens = rewritten;
}

/**
 * Defines a Manuscript Markdown pattern configuration
 */
interface manuscriptMarkdownPattern {
  name: string;           // Pattern identifier (e.g., 'addition', 'deletion')
  regex: RegExp;          // Regular expression to match the pattern
  cssClass: string;       // CSS class to apply to rendered HTML
  htmlTag: string;        // HTML tag to use for wrapping content
}

/**
 * Pattern configurations for all five Manuscript Markdown types
 * Note: Using .*? instead of .+? to allow empty patterns
 */
const patterns: manuscriptMarkdownPattern[] = [
  { 
    name: 'addition', 
    regex: /\{\+\+(.*?)\+\+\}/gs, 
    cssClass: 'manuscript-markdown-addition', 
    htmlTag: 'ins' 
  },
  { 
    name: 'deletion', 
    regex: /\{--(.*?)--\}/gs, 
    cssClass: 'manuscript-markdown-deletion', 
    htmlTag: 'del' 
  },
  { 
    name: 'substitution', 
    regex: /\{~~(.*?)~>(.*?)~~\}/gs, 
    cssClass: 'manuscript-markdown-substitution', 
    htmlTag: 'span' 
  },
  { 
    name: 'comment', 
    regex: /\{>>(.*?)<<\}/gs, 
    cssClass: 'manuscript-markdown-comment', 
    htmlTag: 'span' 
  },
  { 
    name: 'highlight', 
    regex: /\{==(.*?)==\}/gs, 
    cssClass: 'manuscript-markdown-highlight', 
    htmlTag: 'mark' 
  }
];

/**
 * Helper function to add parsed inline content tokens to the state
 * @param state - The inline parsing state
 * @param content - The content to parse
 */
function inlineSourceOffset(state: StateInline, localOffset: number): number {
  const env = state.env as PreviewEnvironment;
  const base = env.manuscriptInlineSourceBase;
  return (typeof base === 'number' ? base : 0) + localOffset;
}

function pushParsedInlineTokens(state: StateInline, childTokens: Token[]): void {
  for (const childToken of childTokens) {
    const token = state.push(childToken.type, childToken.tag, childToken.nesting);
    token.content = childToken.content;
    token.markup = childToken.markup;
    token.meta = childToken.meta ? { ...childToken.meta } : null;
    if (childToken.attrs) {
      for (const [key, value] of childToken.attrs) {
        token.attrSet(key, value);
      }
    }
    if (childToken.children) token.children = childToken.children;
  }
}

function setCriticBreakSourceOffset(token: Token, sourceOffset: number | undefined): void {
  if (sourceOffset === undefined) return;
  token.meta = { ...(token.meta || {}), manuscriptCriticBreakSourceOffset: sourceOffset };
}

function addInlineContent(state: StateInline, content: string, sourceStart?: number): void {
  // Handle empty content - no tokens to add
  if (content.length === 0) {
    return;
  }

  // Parse the entire body before expanding protected paragraph breaks. Splitting
  // the source first would prevent delimiters that cross a blank line (such as
  // nested CriticMarkup or emphasis) from matching.
  const childTokens: Token[] = [];
  const env = state.env as PreviewEnvironment;
  const previousSourceBase = env.manuscriptInlineSourceBase;
  const nestedSourceBase = sourceStart ?? inlineSourceOffset(state, 0);
  if (sourceStart !== undefined) env.manuscriptInlineSourceBase = sourceStart;
  try {
    state.md.inline.parse(content, state.md, state.env, childTokens);
  } finally {
    if (previousSourceBase === undefined) delete env.manuscriptInlineSourceBase;
    else env.manuscriptInlineSourceBase = previousSourceBase;
  }

  const protectedBreaks = collectProtectedBreaks(content, nestedSourceBase);
  if (protectedBreaks.length === 0) {
    pushParsedInlineTokens(state, childTokens);
    return;
  }
  let protectedBreakIndex = 0;
  const claimProtectedBreak = (kind: CriticBreakKind): CriticBreakSource | undefined => {
    for (; protectedBreakIndex < protectedBreaks.length; protectedBreakIndex++) {
      const candidate = protectedBreaks[protectedBreakIndex];
      if (candidate.kind !== kind) continue;
      protectedBreakIndex++;
      return candidate;
    }
    return undefined;
  };
  const claimThroughSourceOffset = (sourceOffset: number): void => {
    while (protectedBreakIndex < protectedBreaks.length &&
        protectedBreaks[protectedBreakIndex].sourceOffset <= sourceOffset) {
      protectedBreakIndex++;
    }
  };
  const claimTokenBreak = (token: Token): void => {
    const sourceOffsets = token.meta?.manuscriptCriticConsumedBreakSourceOffsets;
    if (Array.isArray(sourceOffsets)) {
      for (const sourceOffset of sourceOffsets) {
        if (typeof sourceOffset === 'number') claimThroughSourceOffset(sourceOffset);
      }
      return;
    }
    const ownSourceOffset = token.meta?.manuscriptCriticBreakSourceOffset;
    if (typeof ownSourceOffset === 'number') claimThroughSourceOffset(ownSourceOffset);
  };
  const claimContentBreaks = (tokenContent: string): void => {
    for (const match of iterateCriticBreaks(tokenContent)) {
      claimProtectedBreak(match.kind);
    }
  };

  const expandParagraphBreaks = (tokens: Token[]): Token[] => {
    const expanded: Token[] = [];
    for (const token of tokens) {
      claimTokenBreak(token);
      const hasChildren = token.children !== null && token.children !== undefined;
      if (token.children) {
        token.children = expandParagraphBreaks(token.children);
      }

      if (token.type === 'text' && hasCriticBreak(token.content)) {
        let textStart = 0;
        for (const match of iterateCriticBreaks(token.content)) {
          if (match.index > textStart) {
            const textToken = new state.Token('text', '', 0);
            textToken.content = token.content.slice(textStart, match.index);
            expanded.push(textToken);
          }
          const sourceBreak = claimProtectedBreak(match.kind);
          const tokenType = match.kind === 'paragraph' ? 'hardbreak' : 'softbreak';
          for (let count = 0; count < match.lineCount; count++) {
            const breakToken = new state.Token(tokenType, 'br', 0);
            setCriticBreakSourceOffset(breakToken, sourceBreak?.sourceOffset);
            expanded.push(breakToken);
          }
          textStart = match.index + match.length;
        }
        if (textStart < token.content.length) {
          const textToken = new state.Token('text', '', 0);
          textToken.content = token.content.slice(textStart);
          expanded.push(textToken);
        }
        continue;
      }

      // Code and other opaque inline tokens do not expose their content as text
      // children, but the implementation placeholder must never reach HTML.
      if (hasCriticBreak(token.content)) {
        if (!hasChildren) claimContentBreaks(token.content);
        token.content = token.type === 'code_inline'
          ? token.content.split(PARA_PLACEHOLDER).join(' ').split(LINE_PLACEHOLDER).join(' ')
          : restoreCriticLineBreaks(token.content);
      }
      expanded.push(token);
    }
    return expanded;
  };

  pushParsedInlineTokens(state, expandParagraphBreaks(childTokens));
}

function pushInlineMathToken(state: StateInline, content: string, hasBefore = false, hasAfter = false): void {
  if (!content) return;
  const token = state.push('math_inline', 'math', 0);
  token.markup = '$';
  token.meta = { ...(token.meta || {}), manuscriptMathSource: content };
  // KaTeX classifies a leading/trailing binary operator as unary when an
  // equation is split across several tokens. Invisible empty groups retain
  // the original operator spacing at CriticMarkup boundaries.
  token.content = (hasBefore ? '{}' : '') + content + (hasAfter ? '{}' : '');
}

function pushCriticMathParts(state: StateInline, parts: CriticMathPart[]): void {
  const hasVisibleMath = (part: CriticMathPart): boolean => {
    if (part.type === 'comment') return false;
    if (part.type === 'substitution') return part.oldContent.length > 0 || part.newContent.length > 0;
    return part.content.length > 0;
  };

  let remainingVisible = parts.reduce((count, part) => count + (hasVisibleMath(part) ? 1 : 0), 0);
  let hasBefore = false;
  for (const part of parts) {
    const partIsVisible = hasVisibleMath(part);
    if (partIsVisible) remainingVisible--;
    const hasAfter = remainingVisible > 0;
    if (part.type === 'math') {
      pushInlineMathToken(state, part.content, hasBefore, hasAfter);
      if (partIsVisible) hasBefore = true;
      continue;
    }

    if (part.type === 'comment') {
      const tokenOpen = state.push('manuscript_markdown_comment_open', 'span', 1);
      tokenOpen.attrSet('class', 'manuscript-markdown-comment');
      tokenOpen.meta = { commentText: commentTooltipText(part.content) };
      addInlineContent(state, part.content);
      state.push('manuscript_markdown_comment_close', 'span', -1);
      continue;
    }

    if (part.type === 'substitution') {
      const tokenOpen = state.push('manuscript_markdown_substitution_open', 'span', 1);
      tokenOpen.attrSet('class', 'manuscript-markdown-substitution');
      const oldOpen = state.push('manuscript_markdown_substitution_old_open', 'del', 1);
      oldOpen.attrSet('class', 'manuscript-markdown-deletion');
      pushInlineMathToken(state, part.oldContent, hasBefore, hasAfter);
      state.push('manuscript_markdown_substitution_old_close', 'del', -1);
      const newOpen = state.push('manuscript_markdown_substitution_new_open', 'ins', 1);
      newOpen.attrSet('class', 'manuscript-markdown-addition');
      pushInlineMathToken(state, part.newContent, hasBefore, hasAfter);
      state.push('manuscript_markdown_substitution_new_close', 'ins', -1);
      state.push('manuscript_markdown_substitution_close', 'span', -1);
      if (partIsVisible) hasBefore = true;
      continue;
    }

    const tokenType = part.type === 'addition'
      ? 'addition'
      : part.type === 'deletion'
        ? 'deletion'
        : 'highlight';
    const tag = part.type === 'addition' ? 'ins' : part.type === 'deletion' ? 'del' : 'mark';
    const tokenOpen = state.push('manuscript_markdown_' + tokenType + '_open', tag, 1);
    tokenOpen.attrSet('class', 'manuscript-markdown-' + tokenType);
    pushInlineMathToken(state, part.content, hasBefore, hasAfter);
    state.push('manuscript_markdown_' + tokenType + '_close', tag, -1);
    if (partIsVisible) hasBefore = true;
  }
}

/** Parse CriticMarkup inside a single-dollar inline equation before VS Code's math rule consumes it. */
function parseCriticMarkupInInlineMath(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const match = findDollarMathAt(state.src, start);
  if (!match) return false;
  if (match.kind === 'currency') {
    // The DOCX parser leaves this opening dollar literal. Consume it here as
    // text so VS Code's later, more permissive math rule cannot swallow a
    // following Critic span or pair it with another currency amount.
    if (!silent) state.pending += '$';
    state.pos = start + 1;
    return true;
  }
  if (match.delimiterLength !== 1) return false;

  const mathContent = state.src.slice(match.contentStart, match.contentEnd);
  const parts = splitCriticMarkupInMath(mathContent);
  if (!parts) return false;
  if (!silent) {
    if (state.pending) state.pushPending();
    const firstTokenIndex = state.tokens.length;
    pushCriticMathParts(state, parts);
    const consumedBreakSourceOffsets = collectProtectedBreaks(
      mathContent,
      inlineSourceOffset(state, match.contentStart),
    ).map(sourceBreak => sourceBreak.sourceOffset);
    const firstToken = state.tokens[firstTokenIndex];
    if (firstToken && consumedBreakSourceOffsets.length > 0) {
      firstToken.meta = {
        ...(firstToken.meta || {}),
        manuscriptCriticConsumedBreakSourceOffsets: consumedBreakSourceOffsets,
      };
    }
  }
  state.pos = match.end;
  return true;
}

/**
 * Fallback block-level rule for multiline Manuscript Markdown that starts at
 * the beginning of a line. The source preprocessor normally protects all line
 * breaks inside complete spans, including mid-line spans, so they reach the
 * inline parser without being split into separate Markdown blocks.
 * 
 * @param state - The block parsing state
 * @param startLine - Starting line number
 * @param endLine - Ending line number
 * @param silent - Whether to only check without creating tokens
 * @returns true if a Manuscript Markdown block was found and processed
 */
function manuscriptMarkdownBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  
  // Quick check: does this line start with a potential Manuscript Markdown pattern?
  if (pos + 3 > max) return false;
  
  const src = state.src;
  
  // Quick check: first char must be {
  if (src.charCodeAt(pos) !== 0x7B /* { */) return false;
  
  const ch2 = src.charCodeAt(pos + 1);
  const ch3 = src.charCodeAt(pos + 2);
  
  let closeMarker: string;
  let isNested = false;
  if (ch2 === 0x2B /* + */ && ch3 === 0x2B /* + */) closeMarker = '++}';
  else if (ch2 === 0x2D /* - */ && ch3 === 0x2D /* - */) closeMarker = '--}';
  else if (ch2 === 0x7E /* ~ */ && ch3 === 0x7E /* ~ */) closeMarker = '~~}';
  else if (ch2 === 0x3E /* > */ && ch3 === 0x3E /* > */) { closeMarker = '<<}'; isNested = true; }
  else if (ch2 === 0x3D /* = */ && ch3 === 0x3D /* = */) closeMarker = '==}';
  else return false;
  
  // Search for the closing marker starting from current position, among
  // the closers of the text, found once for all the rule's calls, as each
  // line's unclosed opener searched the rest of it
  const searchStart = pos + 3;
  const closers = criticCloserSearchOf(state);
  let closePos: number;
  if (isNested) {
    // Use depth-aware matching so nested {>>...<<} replies don't close early
    closePos = closers.matching(searchStart);
  } else {
    closePos = closers.next(closeMarker, searchStart);
  }
  if (closePos === -1) {
    return false;
  }
  
  // Check if the pattern contains any newlines (making it multi-line)
  const patternContent = src.slice(pos, closePos + closeMarker.length);
  const hasNewline = patternContent.includes('\n');
  
  if (!hasNewline) {
    // Single-line pattern, let the inline parser handle it
    return false;
  }
  
  // Find which line the closing marker is on
  const patternEnd = closePos + closeMarker.length;
  let nextLine = startLine;
  
  // Scan through lines to find where the pattern ends
  while (nextLine < endLine) {
    const lineEnd = state.eMarks[nextLine];
    if (lineEnd >= patternEnd) {
      // The pattern ends on or before this line
      nextLine++;
      break;
    }
    nextLine++;
  }
  
  if (silent) return true;
  
  // Create a paragraph token that contains the entire Manuscript Markdown pattern
  const token = state.push('paragraph_open', 'p', 1);
  token.map = [startLine, nextLine];
  
  const contentToken = state.push('inline', '', 0);
  contentToken.content = patternContent;
  contentToken.map = [startLine, nextLine];
  contentToken.children = [];
  
  state.push('paragraph_close', 'p', -1);
  
  // Advance state.line to skip all lines we've consumed
  state.line = nextLine;
  return true;
}

/** A citation, as export reads one (see citationEnd), as the text export
 *  takes it for: its keys and locators as they are, and each prefix with
 *  its escapes decoded, so a tag, emphasis or CriticMarkup in one shows as
 *  written, as in Word, not as HTML or formatting */
function citationRule(state: StateInline, silent: boolean): boolean {
  // Not where markdown-it scans a link's label, which it alone does
  // silently, and which a token that takes a [ in it ends: a link around a
  // citation stays a link
  if (silent) return false;
  const start = state.pos;
  if (start + 2 >= state.posMax) return false;
  const end = citationEnd(state, start);
  if (end === -1) return false;
  // With the line breaks CriticMarkup protected in it, before which a key
  // starts as after a space
  const items = restoreCriticLineBreaks(state.src.slice(start + 1, end)).split(';').map(item => {
    const key = CITATION_ITEM_START_RE.exec(item);
    return key ? citationPrefixText(state, item.slice(0, key.index)) + item.slice(key.index) : item;
  });
  // Text once the rules that read text tokens, as linkify, have run (see
  // manuscript_citation_text)
  const token = state.push('manuscript_citation', '', 0);
  token.content = '[' + items.join(';') + ']';
  // The line breaks CriticMarkup protected in it, which its text no longer
  // holds, for the source lines after it (see addInlineContent)
  const consumedBreakSourceOffsets = collectProtectedBreaks(state.src.slice(start, end + 1), inlineSourceOffset(state, start))
    .map(sourceBreak => sourceBreak.sourceOffset);
  if (consumedBreakSourceOffsets.length > 0) token.meta = { manuscriptCriticConsumedBreakSourceOffsets: consumedBreakSourceOffsets };
  state.pos = end + 1;
  return true;
}

/** A cross-reference, as export reads one (see crossRefAt), which shows
 *  its figure's or table's title and number once captionsRule numbers
 *  them, or a citation's brackets with one in them, which are their text,
 *  as in Word */
function crossRefRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  // As a citation, none where markdown-it scans a link's label
  if (silent && state.src.charAt(start) === '[') return false;
  const ref = crossRefAt(state, start);
  if (!ref) return false;
  if (!silent) {
    const token = state.push('manuscript_cross_reference', '', 0);
    const source = restoreCriticLineBreaks(state.src.slice(start, ref.end));
    token.content = ref.form === 'literal' ? state.md.utils.unescapeAll(source).replace(/\r\n?|\n/g, ' ') : source;
    // Its source and where it starts in its inline token's text, by which
    // the language server finds it in the document (see crossref-language.ts)
    token.meta = { key: ref.key, form: ref.form, source, offset: inlineSourceOffset(state, start) };
    const consumedBreakSourceOffsets = collectProtectedBreaks(state.src.slice(start, ref.end), inlineSourceOffset(state, start))
      .map(sourceBreak => sourceBreak.sourceOffset);
    if (consumedBreakSourceOffsets.length > 0) token.meta.manuscriptCriticConsumedBreakSourceOffsets = consumedBreakSourceOffsets;
  }
  state.pos = ref.end;
  return true;
}

/** Whether the == at `at` is a {=='s, whose { no backslash escapes, as
 *  export reads it in a format highlight (findClosingHighlightMarker) */
function opensCriticHighlight(src: string, at: number): boolean {
  if (src.charCodeAt(at - 1) !== 0x7B /* { */) return false;
  let slashes = 0;
  while (src.charCodeAt(at - 2 - slashes) === 0x5C /* \ */) slashes++;
  return slashes % 2 === 0;
}

const criticHighlightEnds = new WeakMap<object, { src: string; byMax: Map<number, Map<number, number>> }>();

/**
 * Where the critic highlight that the {== at `at` (its ==) opens in a
 * format highlight ends, as export reads it: just past the ==} that closes
 * it, once each {== in it is closed in turn, or -1 if none does before the
 * state's posMax. Each {=='s end is found once for the state's text and
 * posMax, as a search from each == before a {== that never closes read the
 * rest of the text again.
 */
function criticHighlightEnd(state: StateInline, at: number): number {
  const src = state.src;
  const max = state.posMax;
  let memo = criticHighlightEnds.get(state);
  if (!memo || memo.src !== src) criticHighlightEnds.set(state, memo = { src, byMax: new Map() });
  let ends = memo.byMax.get(max);
  if (!ends) memo.byMax.set(max, ends = new Map());
  const known = ends.get(at);
  if (known !== undefined) return known;
  // The {=='s still open, innermost last
  const open = [at];
  let pos = at + 2;
  while (open.length > 0) {
    if (pos >= max) {
      // None closes, nor any that holds it
      for (const opener of open) ends.set(opener, -1);
      return -1;
    }
    if (src.charCodeAt(pos) === 0x3D /* = */ && pos + 1 < max && src.charCodeAt(pos + 1) === 0x3D /* = */) {
      if (opensCriticHighlight(src, pos)) {
        const end = ends.get(pos);
        if (end === undefined) {
          open.push(pos);
          pos += 2;
        } else if (end === -1) {
          pos = max;
        } else {
          pos = end;
        }
        continue;
      }
      if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7D /* } */) {
        ends.set(open.pop()!, pos + 3);
        pos += 3;
        continue;
      }
    }
    pos++;
  }
  return ends.get(at)!;
}

const unbracedEquals = new WeakMap<object, { src: string; at: number[] }>();

/**
 * The first == at or after `from` that a format highlight's search for its
 * closing == stops at: a {=='s, or one that no } follows before the
 * state's posMax, or posMax if none is. Their offsets are found once for
 * the state's text, as reading on past each ==} read the rest of the text
 * again for each == before it, as in ==} repeated.
 */
function nextUnbracedEquals(state: StateInline, from: number): number {
  const src = state.src;
  const max = state.posMax;
  let memo = unbracedEquals.get(state);
  if (!memo || memo.src !== src) {
    const at: number[] = [];
    for (let k = src.indexOf('=='); k !== -1; k = src.indexOf('==', k + 1)) {
      if (src.charCodeAt(k + 2) !== 0x7D /* } */ || opensCriticHighlight(src, k)) at.push(k);
    }
    unbracedEquals.set(state, memo = { src, at });
  }
  // The first at or after `from`
  const at = memo.at;
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  let next = lo < at.length && at[lo] + 1 < max ? at[lo] : max;
  // An == right before posMax, whose } is past it
  const last = max - 2;
  if (last >= from && last < next && src.charCodeAt(last) === 0x3D /* = */ && src.charCodeAt(last + 1) === 0x3D /* = */) next = last;
  return next;
}

/**
 * Inline rule for ==highlight== patterns (not CriticMarkup)
 * @param state - The inline parsing state
 * @param silent - Whether to only check without creating tokens
 * @returns true if a pattern was found and processed
 */
function parseFormatHighlight(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;
  const resolveDefaultColor = (): string => {
    const color = getDefaultHighlightColor();
    return VALID_COLOR_IDS.includes(color) ? color : 'yellow';
  };

  // Check if we're at ==
  if (src.charCodeAt(start) !== 0x3D /* = */ || src.charCodeAt(start + 1) !== 0x3D /* = */) {
    return false;
  }

  // Check if preceded by { (to avoid matching CriticMarkup {==...==}), but
  // for one an odd run of backslashes escapes, which is text, as export
  // reads it: \{==x==\} is a {, the highlighted x and a }, which import
  // writes for Word's literal braces around a highlight
  if (opensCriticHighlight(src, start)) {
    return false;
  }

  // Find closing ==. As export reads it (findClosingHighlightMarker in
  // md-to-docx.ts), the == of a {== in the highlight is no closing ==: it
  // opens a critic highlight, read past to the ==} that closes it, and one
  // that never closes leaves the highlight unclosed.
  let pos = start + 2;
  while (pos < max) {
    if (src.charCodeAt(pos) === 0x3D /* = */ && pos + 1 < max && src.charCodeAt(pos + 1) === 0x3D /* = */) {
      if (opensCriticHighlight(src, pos)) {
        pos = criticHighlightEnd(state, pos);
        if (pos === -1) return false;
        continue;
      }
      // Check if followed by } (to avoid matching CriticMarkup {==...==}),
      // and go on to the next == that isn't, or that opens one
      if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7D /* } */) {
        pos = nextUnbracedEquals(state, pos + 2);
        continue;
      }
      
      // Found closing ==
      if (!silent) {
        const content = src.slice(start + 2, pos);
        const tokenOpen = state.push('manuscript_markdown_format_highlight_open', 'mark', 1);
        
        // Check for optional {color} suffix after closing ==
        // Implementation note: Only treat {…} as a color suffix when the closing } is within
        // parse bounds and the identifier matches [a-z0-9](?:[a-z0-9-]*[a-z0-9])? (no
        // leading/trailing -); otherwise keep as literal text so adjacent CriticMarkup
        // (e.g. {--…--}) is not swallowed as a color suffix.
        let cssClass = 'manuscript-markdown-format-highlight';
        let endPos = pos + 2;
        let hasColorSuffix = false;
        if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7B /* { */) {
          const closeBrace = src.indexOf('}', pos + 3);
          if (closeBrace !== -1 && closeBrace < max) {
            const colorId = src.slice(pos + 3, closeBrace);
            if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(colorId)) {
              hasColorSuffix = true;
              if (VALID_COLOR_IDS.includes(colorId)) {
                cssClass = 'manuscript-markdown-format-highlight manuscript-markdown-highlight-' + colorId;
              } else {
                const defaultColor = resolveDefaultColor();
                if (defaultColor !== 'yellow') {
                  cssClass = 'manuscript-markdown-format-highlight manuscript-markdown-highlight-' + defaultColor;
                }
              }
              endPos = closeBrace + 1;
            }
          }
        }
        if (!hasColorSuffix && cssClass === 'manuscript-markdown-format-highlight') {
          // Apply configurable default color only for ==text== without color suffix
          const defaultColor = resolveDefaultColor();
          if (defaultColor !== 'yellow') {
            cssClass = 'manuscript-markdown-format-highlight manuscript-markdown-highlight-' + defaultColor;
          }
        }
        tokenOpen.attrSet('class', cssClass);
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content, inlineSourceOffset(state, start + 2));
        
        state.push('manuscript_markdown_format_highlight_close', 'mark', -1);
        state.pos = endPos;
      } else {
        // In silent mode, still need to advance past {color} suffix
        let endPos = pos + 2;
        if (pos + 2 < max && src.charCodeAt(pos + 2) === 0x7B /* { */) {
          const closeBrace = src.indexOf('}', pos + 3);
          if (closeBrace !== -1 && closeBrace < max) {
            const colorId = src.slice(pos + 3, closeBrace);
            if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(colorId)) {
              endPos = closeBrace + 1;
            }
          }
        }
        state.pos = endPos;
      }
      return true;
    }
    pos++;
  }

  return false;
}

/**
 * Inline rule function that scans for Manuscript Markdown patterns and creates tokens
 * @param state - The inline parsing state
 * @param silent - Whether to only check without creating tokens
 * @returns true if a pattern was found and processed
 */
function parseManuscriptMarkdown(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  const src = state.src;

  // Check if we're at a potential Manuscript Markdown start
  if (src.charCodeAt(start) !== 0x7B /* { */) {
    return false;
  }
  // Each closer among those of the inline text, found once for all the
  // rule's calls, as each unclosed opener searched the rest of it
  const closers = criticCloserSearchOf(state);

  // Check for addition {++text++}
  if (src.charCodeAt(start + 1) === 0x2B /* + */ && src.charCodeAt(start + 2) === 0x2B /* + */) {
    const endMarker = '++}';
    const endPos = closers.next(endMarker, start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_addition_open', 'ins', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-addition');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content, inlineSourceOffset(state, start + 3));
        
        state.push('manuscript_markdown_addition_close', 'ins', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  // Check for deletion {--text--}
  if (src.charCodeAt(start + 1) === 0x2D /* - */ && src.charCodeAt(start + 2) === 0x2D /* - */) {
    const endMarker = '--}';
    const endPos = closers.next(endMarker, start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_deletion_open', 'del', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-deletion');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content, inlineSourceOffset(state, start + 3));
        
        state.push('manuscript_markdown_deletion_close', 'del', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  // Check for substitution {~~old~>new~~}
  if (src.charCodeAt(start + 1) === 0x7E /* ~ */ && src.charCodeAt(start + 2) === 0x7E /* ~ */) {
    const endMarker = '~~}';
    const endPos = closers.next(endMarker, start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
      // The first ~> in the span, which none is in where the first after
      // its opener is past its closer
      const separatorAt = closers.next('~>', start + 3);
      const separatorPos = separatorAt !== -1 && separatorAt < endPos ? separatorAt - (start + 3) : -1;
      if (separatorPos !== -1) {
        const fullContent = src.slice(start + 3, endPos);
        if (!silent) {
          const oldText = fullContent.slice(0, separatorPos);
          const newText = fullContent.slice(separatorPos + 2);
          
          const tokenOpen = state.push('manuscript_markdown_substitution_open', 'span', 1);
          tokenOpen.attrSet('class', 'manuscript-markdown-substitution');
          
          // Old text with deletion styling
          const tokenOldOpen = state.push('manuscript_markdown_substitution_old_open', 'del', 1);
          tokenOldOpen.attrSet('class', 'manuscript-markdown-deletion');
          
          // Add parsed inline content to allow nested Markdown processing
          addInlineContent(state, oldText, inlineSourceOffset(state, start + 3));
          
          state.push('manuscript_markdown_substitution_old_close', 'del', -1);
          
          // New text with addition styling
          const tokenNewOpen = state.push('manuscript_markdown_substitution_new_open', 'ins', 1);
          tokenNewOpen.attrSet('class', 'manuscript-markdown-addition');
          
          // Add parsed inline content to allow nested Markdown processing
          addInlineContent(
            state,
            newText,
            inlineSourceOffset(state, start + 3 + separatorPos + 2),
          );
          
          state.push('manuscript_markdown_substitution_new_close', 'ins', -1);
          
          state.push('manuscript_markdown_substitution_close', 'span', -1);
        }
        state.pos = endPos + endMarker.length;
        return true;
      }
    }
  }

  // Check for {#id>>...<<} comment body with ID, {#id} range start, or {/id} range end
  if (src.charCodeAt(start + 1) === 0x23 /* # */) {
    // Find end of ID: [a-zA-Z0-9_-]+
    let idEnd = start + 2;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd > start + 2) {
      // Check for {#id>>...<<} comment body with ID (depth-aware for nested replies)
      if (idEnd + 1 < max && src.charCodeAt(idEnd) === 0x3E /* > */ && src.charCodeAt(idEnd + 1) === 0x3E /* > */) {
        const endPos = closers.matching(idEnd + 2);
        if (endPos !== -1 && endPos + 3 <= max) {
          if (!silent) {
            const id = src.slice(start + 2, idEnd);
            const content = src.slice(idEnd + 2, endPos);
            const tokenOpen = state.push('manuscript_markdown_comment_open', 'span', 1);
            tokenOpen.attrSet('class', 'manuscript-markdown-comment');
            tokenOpen.meta = {
              id,
              commentText: commentTooltipText(restoreCriticLineBreaks(content)),
            };
            addInlineContent(state, content, inlineSourceOffset(state, idEnd + 2));
            state.push('manuscript_markdown_comment_close', 'span', -1);
          }
          state.pos = endPos + 3;
          return true;
        }
      }
      // Check for {#id} range start marker. A caption's label, as
      // {#fig-map}, is none (see captions.ts): one an image doesn't take is
      // a marker of no range, its ID one no comment has, which shows nothing
      if (idEnd < max && src.charCodeAt(idEnd) === 0x7D /* } */) {
        if (!silent) {
          const id = src.slice(start + 2, idEnd);
          const token = state.push('manuscript_markdown_range_marker', 'span', 0);
          token.attrSet('class', 'manuscript-markdown-range-marker');
          token.meta = { id: isCaptionLabelId(id) ? '#' + id : id, type: 'start' };
        }
        state.pos = idEnd + 1;
        return true;
      }
    }
  }

  // Check for {/id} range end marker
  if (src.charCodeAt(start + 1) === 0x2F /* / */) {
    let idEnd = start + 2;
    while (idEnd < max && /[a-zA-Z0-9_-]/.test(src.charAt(idEnd))) idEnd++;
    if (idEnd > start + 2 && idEnd < max && src.charCodeAt(idEnd) === 0x7D /* } */) {
      if (!silent) {
        const id = src.slice(start + 2, idEnd);
        const token = state.push('manuscript_markdown_range_marker', 'span', 0);
        token.attrSet('class', 'manuscript-markdown-range-marker');
        token.meta = { id, type: 'end' };
      }
      state.pos = idEnd + 1;
      return true;
    }
  }

  // Check for comment {>>text<<} (depth-aware for nested replies)
  if (src.charCodeAt(start + 1) === 0x3E /* > */ && src.charCodeAt(start + 2) === 0x3E /* > */) {
    const endPos = closers.matching(start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_comment_open', 'span', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-comment');
        tokenOpen.meta = { commentText: commentTooltipText(restoreCriticLineBreaks(content)) };

        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content, inlineSourceOffset(state, start + 3));

        state.push('manuscript_markdown_comment_close', 'span', -1);
      }
      state.pos = endPos + 3;
      return true;
    }
  }

  // Check for highlight {==text==}
  if (src.charCodeAt(start + 1) === 0x3D /* = */ && src.charCodeAt(start + 2) === 0x3D /* = */) {
    const endMarker = '==}';
    const endPos = closers.next(endMarker, start + 3);
    if (endPos !== -1 && endPos + 3 <= max) {
      if (!silent) {
        const content = src.slice(start + 3, endPos);
        const tokenOpen = state.push('manuscript_markdown_highlight_open', 'mark', 1);
        tokenOpen.attrSet('class', 'manuscript-markdown-highlight');
        
        // Add parsed inline content to allow nested Markdown processing
        addInlineContent(state, content, inlineSourceOffset(state, start + 3));
        
        state.push('manuscript_markdown_highlight_close', 'mark', -1);
      }
      state.pos = endPos + endMarker.length;
      return true;
    }
  }

  return false;
}

/** Check if a token type is a CriticMarkup or format highlight close token */
function isCriticMarkupClose(type: string): boolean {
  return type === 'manuscript_markdown_highlight_close' ||
    type === 'manuscript_markdown_addition_close' ||
    type === 'manuscript_markdown_deletion_close' ||
    type === 'manuscript_markdown_substitution_close' ||
    type === 'manuscript_markdown_format_highlight_close';
}

/** Find the index of the matching open token in an array, searching backwards from closeIdx */
function findMatchingOpenIdx(tokens: Token[], closeIdx: number): number {
  const closeType = tokens[closeIdx].type;
  const openType = closeType.replace('_close', '_open');
  let depth = 1;
  for (let i = closeIdx - 1; i >= 0; i--) {
    if (tokens[i].type === closeType) depth++;
    if (tokens[i].type === openType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The index of the comment_close of the comment_open at `open` in
 *  `children`, past those of the comments in it, or the last index where
 *  it has none */
function matchingCommentClose(children: Token[], open: number): number {
  let closeIdx = open + 1;
  let depth = 1;
  while (closeIdx < children.length) {
    if (children[closeIdx].type === 'manuscript_markdown_comment_open') depth++;
    if (children[closeIdx].type === 'manuscript_markdown_comment_close') {
      depth--;
      if (depth === 0) break;
    }
    closeIdx++;
  }
  return closeIdx;
}

/** The texts of the comments with no ID right after the comment_close at
 *  `close`, each right after the one before, as {#1>>note<<}{>>a<<}{>>b<<},
 *  which export reads as replies to the comment that closes there, and the
 *  index of the last one's comment_close, or `close` where none is. A space
 *  between them makes the next a comment of its own, as export reads it */
function repliesAfter(children: Token[], close: number): { texts: string[]; end: number } {
  const texts: string[] = [];
  let end = close;
  while (children[end + 1]?.type === 'manuscript_markdown_comment_open' && !children[end + 1].meta?.id) {
    texts.push(children[end + 1].meta?.commentText || '');
    end = matchingCommentClose(children, end + 1);
  }
  return { texts: texts.filter(text => text.length > 0), end };
}

/**
 * Core rule that associates comment tokens with their annotated elements.
 * Runs after inline parsing to post-process the token stream.
 *
 * Pass 1: Build a map of comment ID → comment text
 * Pass 2: Pair range markers ({#id}/{/id}) into ranges, which commentRangeSpansRule writes as spans
 * Pass 3: Process inline comments — associate with preceding CriticMarkup elements or create indicators
 */
function associateCommentsRule(state: StateCore): void {
  // Pass 1: Build comment ID → text map from all inline tokens, with the
  // replies written right after an ID's body, which export reads as its
  // replies, as {#1>>note<<}{>>reply<<} (see repliesAfter)
  const commentIdMap = new Map<string, string>();
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    const children = blockToken.children;
    children.forEach((child, at) => {
      if (child.type === 'manuscript_markdown_comment_open' && child.meta?.id && child.meta?.commentText) {
        const { texts } = repliesAfter(children, matchingCommentClose(children, at));
        commentIdMap.set(child.meta.id, [child.meta.commentText, ...texts].join('\n'));
      }
    });
  }

  // Pass 2: Pair range markers with matching comments into ranges. An end
  // ends the range of its ID that started last before it, in its paragraph
  // or table cell or an earlier one, and one where none is open writes
  // nothing. A marker in a comment's body, which Pass 3 takes out with the
  // body, is its text, not a range's start or end. Each range's markers stay
  // markers, which the rules that split a paragraph, as an alert's quote or
  // a CriticMarkup paragraph break does, move as they do text, until
  // commentRangeSpansRule writes the spans.
  // The range markers outside comments' bodies
  const rangeMarkers = (children: Token[]): Set<Token> => {
    const markers = new Set<Token>();
    let depth = 0;
    for (const child of children) {
      if (child.type === 'manuscript_markdown_comment_open') depth++;
      else if (child.type === 'manuscript_markdown_comment_close') depth = Math.max(0, depth - 1);
      else if (depth === 0 && child.type === 'manuscript_markdown_range_marker' && child.meta?.id) markers.add(child);
    }
    return markers;
  };
  // The starts of ranges with no end yet, in the order they started
  const started: Token[] = [];
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    const markers = rangeMarkers(blockToken.children);
    blockToken.children = blockToken.children.filter(child => {
      if (!markers.has(child)) return true;
      const commentText = commentIdMap.get(child.meta.id);
      if (commentText === undefined) return true;
      if (child.meta.type === 'start') {
        child.meta = { ...child.meta, commentText };
        started.push(child);
        return true;
      }
      let at = started.length - 1;
      while (at >= 0 && started[at].meta.id !== child.meta.id) at--;
      if (at === -1) return false;
      const [start] = started.splice(at, 1);
      start.meta.end = child;
      child.meta = { ...child.meta, start };
      return true;
    });
  }

  // Pass 3: Process inline comments — associate with preceding elements or create indicators
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;

    const children = blockToken.children;
    const newChildren: Token[] = [];
    // The element the last comment went on, while nothing has come after it
    let replyTo: Token | undefined;
    let i = 0;

    while (i < children.length) {
      if (children[i].type === 'manuscript_markdown_comment_open') {
        const commentText: string = children[i].meta?.commentText || '';
        const commentId: string | undefined = children[i].meta?.id;

        const closeIdx = matchingCommentClose(children, i);

        // Empty comment — remove silently
        if (commentText.length === 0) {
          i = closeIdx + 1;
          continue;
        }

        // ID-based comment — already handled by Pass 2, just remove tokens,
        // and those of the replies right after it, which Pass 1 gave its ID
        if (commentId) {
          i = repliesAfter(children, closeIdx).end + 1;
          replyTo = undefined;
          continue;
        }

        // Right after a comment on an element, a reply to it
        if (replyTo) {
          replyTo.attrSet('data-comment', replyTo.attrGet('data-comment') + '\n' + commentText);
          i = closeIdx + 1;
          continue;
        }

        // Check for adjacent CriticMarkup close token, skipping whitespace-only text tokens
        let candidateIdx = newChildren.length - 1;
        while (candidateIdx >= 0 && newChildren[candidateIdx].type === 'text' && /^\s+$/.test(newChildren[candidateIdx].content)) {
          candidateIdx--;
        }
        const candidateToken = candidateIdx >= 0 ? newChildren[candidateIdx] : null;
        if (candidateToken && isCriticMarkupClose(candidateToken.type)) {
          const openIdx = findMatchingOpenIdx(newChildren, candidateIdx);
          if (openIdx !== -1) {
            const openToken = newChildren[openIdx];
            // A comment on an element that has one is a reply to it only
            // right after it, as export reads it (replyTo): after a space,
            // it's one of its own
            if (!openToken.attrGet('data-comment')) {
              openToken.attrSet('data-comment', commentText);
              replyTo = openToken;
              i = closeIdx + 1;
              continue;
            }
          }
        }

        // Standalone comment — create indicator token
        const indicator = new state.Token('manuscript_markdown_comment_indicator', 'span', 0);
        indicator.attrSet('data-comment', commentText);
        newChildren.push(indicator);
        i = closeIdx + 1;
        continue;
      }

      newChildren.push(children[i]);
      replyTo = undefined;
      i++;
    }

    blockToken.children = newChildren;
  }
}

/**
 * Core rule that writes each range Pass 2 of associateCommentsRule paired as
 * a span in each paragraph or table cell it covers: a range that goes on
 * past its paragraph or cell, to a later one, closes its span at the end of
 * each and opens one at the start of each after it, up to its end, as the
 * browser ends a span the first cell's end closes, so the cells after it
 * lost the highlight. A range with no end ends with its own paragraph or
 * cell. It runs after the rules that split a paragraph, as an alert's quote
 * or a CriticMarkup paragraph break does, so a span opens again at the start
 * of each paragraph they make, as at any other. Then the elements a span
 * crosses nest (see nestCrossedElements), and each token takes its level
 * (see withLevels).
 */
function commentRangeSpansRule(state: StateCore): void {
  // A range's start or end, as Pass 2 paired them
  const inRange = (token: Token) => token.type === 'manuscript_markdown_range_marker'
    && (token.meta?.commentText !== undefined || token.meta?.start !== undefined);
  // The ends still in the document, but for any a rule dropped with its paragraph
  const ends = new Set<Token>();
  for (const blockToken of state.tokens) {
    for (const child of blockToken.type === 'inline' && blockToken.children ? blockToken.children : []) {
      if (inRange(child) && child.meta.type === 'end') ends.add(child);
    }
  }
  const spanOpen = (start: Token) => {
    const open = new state.Token('manuscript_markdown_comment_range_open', 'span', 1);
    open.attrSet('class', 'manuscript-markdown-comment-range');
    open.attrSet('data-comment', start.meta.commentText);
    open.meta = { id: start.meta.id, type: 'start' };
    return open;
  };
  const spanClose = (start: Token) => {
    const close = new state.Token('manuscript_markdown_comment_range_close', 'span', -1);
    close.meta = { id: start.meta.id, type: 'end' };
    return close;
  };
  // The starts of the ranges open from an earlier paragraph or cell, in the
  // order they started
  let active: Token[] = [];
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    // The starts of the ranges whose span is open here
    const open = [...active];
    const children = active.map(spanOpen);
    for (const child of blockToken.children) {
      if (!inRange(child)) {
        children.push(child);
      } else if (child.meta.type === 'start') {
        open.push(child);
        if (ends.has(child.meta.end)) active.push(child);
        children.push(spanOpen(child));
      } else {
        const at = open.indexOf(child.meta.start);
        if (at === -1) continue;
        open.splice(at, 1);
        active = active.filter(start => start !== child.meta.start);
        children.push(spanClose(child.meta.start));
      }
    }
    for (const start of open.reverse()) children.push(spanClose(start));
    blockToken.children = withLevels(nestCrossedElements(children, state));
  }
}

/**
 * Inline tokens with the level markdown-it's inline parser gives each, by
 * the elements open around it, as the ones a rule writes have none: linkify,
 * which runs after, skips a link's text from its end back to the first
 * token at the link's level, so a span's end inside the link stopped it
 * there, the text before read as outside the link, and a URL in it became
 * a link in the link.
 */
function withLevels(children: Token[]): Token[] {
  let level = 0;
  for (const child of children) {
    if (child.nesting === -1) level--;
    child.level = level;
    if (child.nesting === 1) level++;
  }
  return children;
}

/**
 * An inline token's children with no element ending inside another that
 * started after it, where either is a range's span: a span, which can end
 * inside a tracked change, emphasis or raw HTML, as `{--b{/1} c--}` or
 * `<sup>b{/1} c</sup>`, or start in one that ends inside it, or one
 * reopened at the start of a paragraph or cell (see commentRangeSpansRule)
 * that ends in one, or another range's span, as the browser would end the
 * inner one there, so the text after it lost its formatting. The elements
 * inside the one that ends end before it and open again after it. What
 * counts as an element, and which start an end closes, is
 * inlineWrapperStep's, as for a CriticMarkup paragraph break. Elements that
 * cross with no range's span among them, as raw HTML around emphasis's end
 * in `**a <sup>b** c</sup>`, are the author's, which the preview writes as
 * Markdown does.
 */
function nestCrossedElements(children: Token[], state: StateCore): Token[] {
  const out: Token[] = [];
  const stack: ActiveInlineWrapper[] = [];
  for (const child of children) {
    out.push(child);
    const step = inlineWrapperStep(child);
    if (step?.kind === 'open') stack.push(step.wrapper);
    if (step?.kind !== 'close') continue;
    const at = closedWrapperIndex(stack, step.closes);
    if (at === -1) continue;
    const inside = stack.splice(at + 1);
    stack.pop();
    if (!isRangeSpan(child) && !inside.some(wrapper => isRangeSpan(wrapper.open))) {
      // As written, the elements inside still open
      pushAll(stack, inside);
      continue;
    }
    out.pop();
    for (const wrapper of [...inside].reverse()) out.push(closeActiveWrapper(state, wrapper));
    out.push(child);
    for (const wrapper of inside) {
      const reopened = reopenActiveWrapper(state, wrapper);
      out.push(reopened);
      stack.push({ ...wrapper, open: reopened });
    }
  }
  return out;
}

/** The opens whose element, and everything in it, accepting every change
 *  drops: a deletion, and a substitution's old text */
const REJECTED_CHANGE_OPENS = new Set([
  'manuscript_markdown_deletion_open',
  'manuscript_markdown_substitution_old_open',
]);

/** The opens and closes whose element accepting every change unwraps,
 *  keeping what's in it: an addition, a substitution, and its new text */
const ACCEPTED_CHANGE_TYPES = new Set([
  'manuscript_markdown_addition_open',
  'manuscript_markdown_addition_close',
  'manuscript_markdown_substitution_open',
  'manuscript_markdown_substitution_close',
  'manuscript_markdown_substitution_new_open',
  'manuscript_markdown_substitution_new_close',
]);

/**
 * Core rule that, where the preview shows no markup, gives each element
 * with a comment on it, as a change or a highlight, a key of its own,
 * before the rules that split one over paragraphs or a range's span copy
 * its open (see cloneInlineToken), so its comment shows once however many
 * pieces it's in (see commentsOnAcceptedText). Runs after
 * associateCommentsRule puts each comment on its element.
 */
function keyElementCommentsRule(state: StateCore): void {
  for (const token of state.tokens) {
    for (const child of token.type === 'inline' && token.children ? token.children : []) {
      if (child.nesting === 1 && child.attrGet('data-comment')) {
        child.meta = { ...(child.meta || {}), manuscriptCommentKey: {} };
      }
    }
  }
}

/** A range's span for a comment, keyed by the comment it shows (see
 *  commentsOnAcceptedText) */
function commentSpanOpen(state: StateCore, comment: string, key: unknown): Token {
  const span = new state.Token('manuscript_markdown_comment_range_open', 'span', 1);
  span.attrSet('class', 'manuscript-markdown-comment-range');
  span.attrSet('data-comment', comment);
  span.meta = { manuscriptCommentKey: key };
  return span;
}

function commentSpanClose(state: StateCore): Token {
  return new state.Token('manuscript_markdown_comment_range_close', 'span', -1);
}

/** Whether a token shows a comment, which a deletion keeps (see acceptChanges) */
function isCommentToken(token: Token): boolean {
  return isRangeSpan(token) || token.type === 'manuscript_markdown_comment_indicator';
}

/** An inline token's children as they read with every change accepted. A
 *  comment on a change is a range's span over the text the change leaves,
 *  none for a deletion, as is a comment on an element or a range's span in
 *  deleted text, which
 *  commentsOnAcceptedText shows as an indicator where all its text went.
 *  An image's alt text reads the same */
function acceptChanges(children: Token[], state: StateCore): Token[] {
  const out: Token[] = [];
  // For each unwrapped open still open, by its type, the range span it
  // became, or undefined where it wrote nothing
  const opened = new Map<string, Array<Token | undefined>>();
  for (let i = 0; i < children.length; i++) {
    const token = children[i];
    if (REJECTED_CHANGE_OPENS.has(token.type)) {
      const comment = token.attrGet('data-comment');
      if (comment) out.push(commentSpanOpen(state, comment, token.meta?.manuscriptCommentKey ?? token));
      const closeType = token.type.slice(0, -'_open'.length) + '_close';
      let depth = 1;
      while (depth > 0 && ++i < children.length) {
        if (children[i].type === token.type) depth++;
        else if (children[i].type === closeType) depth--;
        else if (isCommentToken(children[i])) out.push(children[i]);
        else if (children[i].nesting === 1 && children[i].attrGet('data-comment')) {
          // A comment on an element in the deleted text
          const inner = children[i];
          out.push(commentSpanOpen(state, inner.attrGet('data-comment')!, inner.meta?.manuscriptCommentKey ?? inner), commentSpanClose(state));
        }
      }
      if (comment) out.push(commentSpanClose(state));
      continue;
    }
    if (!ACCEPTED_CHANGE_TYPES.has(token.type)) {
      if (token.children) token.children = acceptChanges(token.children, state);
      out.push(token);
      continue;
    }
    const kind = token.type.slice(0, token.type.lastIndexOf('_'));
    const stack = opened.get(kind) ?? [];
    opened.set(kind, stack);
    if (token.nesting === 1) {
      const comment = token.attrGet('data-comment');
      const span = comment
        ? commentSpanOpen(state, comment, token.meta?.manuscriptCommentKey ?? token)
        : undefined;
      if (span) out.push(span);
      stack.push(span);
    } else if (stack.pop()) {
      out.push(commentSpanClose(state));
    }
  }
  return withLevels(out);
}

/** Whether a token shows anything once every change is accepted: as
 *  isVisibleInlineToken, but for a raw HTML tag that wraps text, as <em>
 *  or </em>, which shows nothing of its own */
function isAcceptedTextVisible(token: Token): boolean {
  return isVisibleInlineToken(token) && rawHtmlTag(token) === undefined;
}

/** The index of the close of the element that opens at `open` */
function elementClose(children: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < children.length; i++) {
    depth += children[i].nesting;
    if (depth === 0) return i;
  }
  return children.length;
}

/**
 * A comment whose elements, in every paragraph or piece they're in, hold no
 * text once every change is accepted, as one on a deletion, on text
 * deleted, or on a highlight of deleted text, shows as an indicator where
 * its first element was, once. A range's span with no text goes in its
 * place; another element stays, with no comment. An element's key is its
 * comment's ID, for a range's span, or the key of the element the comment
 * is on (see keyElementCommentsRule).
 */
function commentsOnAcceptedText(inlines: Token[], state: StateCore): void {
  const keyOf = (open: Token): unknown => open.meta?.manuscriptCommentKey ?? open.meta?.id ?? open;
  const carries = (token: Token): boolean => token.nesting === 1 && !!token.attrGet('data-comment');
  const shown = new Set<unknown>();
  for (const inline of inlines) {
    const children = inline.children!;
    children.forEach((child, at) => {
      if (!carries(child)) return;
      const inside = children.slice(at + 1, elementClose(children, at));
      if (inside.some(isAcceptedTextVisible)) shown.add(keyOf(child));
    });
  }
  const placed = new Set<unknown>();
  for (const inline of inlines) {
    const out: Token[] = [];
    // For each range's span open, whether it stays
    const kept: boolean[] = [];
    for (const child of inline.children!) {
      const isSpan = child.type === 'manuscript_markdown_comment_range_open';
      if (child.type === 'manuscript_markdown_comment_range_close') {
        if (kept.pop()) out.push(child);
        continue;
      }
      if (!carries(child) || shown.has(keyOf(child))) {
        if (isSpan) kept.push(true);
        out.push(child);
        continue;
      }
      const key = keyOf(child);
      if (!placed.has(key)) {
        placed.add(key);
        const indicator = new state.Token('manuscript_markdown_comment_indicator', 'span', 0);
        indicator.attrSet('data-comment', child.attrGet('data-comment') || '');
        out.push(indicator);
      }
      if (isSpan) {
        kept.push(false);
      } else {
        child.attrs = child.attrs?.filter(([name]) => name !== 'data-comment') ?? null;
        out.push(child);
      }
    }
    inline.children = withLevels(out);
  }
}

/** The containers a paragraph's removal can leave with nothing in them */
const EMPTIABLE_CONTAINERS = new Set(['list_item', 'bullet_list', 'ordered_list', 'blockquote']);

/**
 * Core rule that, where the preview shows no markup, writes the document as
 * it reads with every change accepted (see acceptChanges), with each
 * comment still shown (see commentsOnAcceptedText). A paragraph or heading
 * that held only deleted text goes, as Word drops a paragraph whose text
 * and mark are deleted, and so does a list item, list or quote that held
 * only such paragraphs.
 */
function acceptChangesRule(state: StateCore): void {
  const tokens = state.tokens;
  const inlines = tokens.filter(token => token.type === 'inline' && token.children);
  const hasText = (inline: Token): boolean => inline.children!.some(isAcceptedTextVisible);
  const hadContent = new Set(inlines.filter(hasText));
  for (const inline of inlines) inline.children = acceptChanges(inline.children!, state);
  commentsOnAcceptedText(inlines, state);
  for (let i = 0; i < tokens.length; i++) {
    const inline = tokens[i];
    if (!hadContent.has(inline) || hasText(inline)) continue;
    const open = tokens[i - 1];
    if (open?.type !== 'paragraph_open' && open?.type !== 'heading_open') continue;
    // The paragraph's open, inline and close, then each container left empty
    let start = i - 1;
    let end = i + 2;
    while (
      start > 0 && end < tokens.length &&
      tokens[start - 1].nesting === 1 && tokens[end].nesting === -1 &&
      EMPTIABLE_CONTAINERS.has(tokens[start - 1].type.slice(0, -'_open'.length)) &&
      tokens[end].type === tokens[start - 1].type.slice(0, -'_open'.length) + '_close'
    ) {
      start--;
      end++;
    }
    tokens.splice(start, end - start);
    i = start - 1;
  }
}

/** Inline rule that converts the paragraph placeholder back into line breaks in the token stream. */
function paraPlaceholderRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0xE000) return false; // \uE000
  const sourceBreak = matchCriticBreakAt(state.src, start);
  if (sourceBreak?.kind !== 'paragraph') return false;

  if (!silent) {
    const sourceOffset = inlineSourceOffset(state, start);
    for (let count = 0; count < sourceBreak.lineCount; count++) {
      setCriticBreakSourceOffset(state.push('softbreak', 'br', 0), sourceOffset);
    }
  }
  state.pos = start + sourceBreak.length;
  return true;
}

/** Preserve Markdown breaks whose source newlines were protected inside CriticMarkup. */
function escapedCriticBreakPlaceholderRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5C /* \ */) return false;
  const sourceBreak = matchCriticBreakAt(state.src, start + 1);
  if (!sourceBreak) return false;

  if (!silent) {
    const sourceOffset = inlineSourceOffset(state, start + 1);
    for (let count = 0; count < sourceBreak.lineCount; count++) {
      setCriticBreakSourceOffset(state.push('hardbreak', 'br', 0), sourceOffset);
    }
  }
  state.pos = start + 1 + sourceBreak.length;
  return true;
}


/**
 * Block rule that detects grid table placeholder comments and emits
 * standard markdown-it table tokens. Runs before the built-in paragraph
 * rule so placeholders are consumed before they become paragraphs.
 */
function gridTableBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const lineText = state.src.slice(pos, max);

  if (!lineText.startsWith(GRID_TABLE_PLACEHOLDER_PREFIX)) return false;
  if (!lineText.endsWith(' -->')) return false;

  if (silent) return true;

  const b64 = lineText.slice(GRID_TABLE_PLACEHOLDER_PREFIX.length, -4);
  let gridData: { rows: Array<{ cells: string[]; header: boolean }>; aligns?: Array<string | null> };
  try {
    const jsonStr = Buffer.from(b64, 'base64').toString();
    gridData = JSON.parse(jsonStr);
  } catch {
    return false;
  }

  // Split into header and body rows
  const headerRows = gridData.rows.filter(r => r.header);
  const bodyRows = gridData.rows.filter(r => !r.header);

  const tableOpen = state.push('table_open', 'table', 1);
  tableOpen.map = [startLine, startLine + 1];

  if (headerRows.length > 0) {
    state.push('thead_open', 'thead', 1);
    for (const row of headerRows) {
      state.push('tr_open', 'tr', 1);
      for (const [ci, cellText] of row.cells.entries()) {
        const open = state.push('th_open', 'th', 1);
        if (gridColumnAlign(gridData, ci)) open.attrSet('style', 'text-align:' + gridColumnAlign(gridData, ci));
        const inlineTok = state.push('inline', '', 0);
        inlineTok.content = cellText.replace(/\n/g, '  \n');
        inlineTok.children = [];
        state.push('th_close', 'th', -1);
      }
      state.push('tr_close', 'tr', -1);
    }
    state.push('thead_close', 'thead', -1);
  }

  if (bodyRows.length > 0) {
    state.push('tbody_open', 'tbody', 1);
    for (const row of bodyRows) {
      state.push('tr_open', 'tr', 1);
      for (const [ci, cellText] of row.cells.entries()) {
        const tag = headerRows.length === 0 && bodyRows.indexOf(row) === 0 ? 'th' : 'td';
        const open = state.push(tag + '_open', tag, 1);
        if (gridColumnAlign(gridData, ci)) open.attrSet('style', 'text-align:' + gridColumnAlign(gridData, ci));
        const inlineTok = state.push('inline', '', 0);
        inlineTok.content = cellText.replace(/\n/g, '  \n');
        inlineTok.children = [];
        state.push(tag + '_close', tag, -1);
      }
      state.push('tr_close', 'tr', -1);
    }
    state.push('tbody_close', 'tbody', -1);
  }

  state.push('table_close', 'table', -1);
  state.line = startLine + 1;
  return true;
}

function getEmbedDocumentPath(md: ManuscriptMarkdownIt, state: StateCore): string | undefined {
  const env = getPreviewEnvironment(state);
  const currentDocument = env?.currentDocument;
  if (currentDocument && typeof currentDocument === 'object' && typeof currentDocument.fsPath === 'string') {
    return currentDocument.fsPath;
  }
  if (typeof currentDocument === 'string' && currentDocument.length > 0) {
    return currentDocument;
  }

  // Once a preview instance has latched onto a document, keep using that base
  // path instead of re-scanning open editors by source text on every render.
  const fallbackPath = md.manuscriptDocumentPath;
  if (typeof fallbackPath === 'string' && fallbackPath.length > 0) {
    return fallbackPath;
  }

  const getDocPath = md.manuscriptGetDocumentPath;
  if (typeof getDocPath === 'function') {
    const resolved = getDocPath(state.src);
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  }

  return undefined;
}

/** Whether a caption's inline tokens, `children`, have text to show, which
 *  takes the delimiter before it (see isCaptionText): an equation or an
 *  image, which export writes as its Markdown, is some, and a tag, as <b>
 *  or <br>, which export reads as formatting or a break, is none */
function captionHasText(children: Token[]): boolean {
  return children.some(child => child.type.includes('math') || child.type === 'image'
    || child.type !== 'html_inline' && isCaptionText(child.content));
}

/**
 * The tokens of a table's caption in a paragraph's inline tokens,
 * `children`, whose text, `content`, reads as one (see tableCaptionSource),
 * as `: Caption {#tbl-x}`, and its label: those between the colon, with
 * the whitespace after it as written, and the label, which is the last
 * token, without the whitespace and line ends before the label, as export
 * reads it (see tableCaptionOf in md-to-docx.ts)
 */
function tableCaptionTokens(content: string, children: Token[]): { label: string; children: Token[] } | undefined {
  const source = tableCaptionSource(content);
  const first = children[0];
  const last = children[children.length - 1];
  if (!source || children.length < 2 || last.type !== 'manuscript_markdown_range_marker' || last.meta?.id !== '#' + source.label
    || first.type !== 'text' || !first.content.startsWith(':') || first.content.length < source.lead) return undefined;
  const caption = children.slice(0, -1);
  const rest = first.content.slice(source.lead);
  if (rest) caption[0] = Object.assign(Object.create(Object.getPrototypeOf(first)), first, { content: rest });
  else caption.shift();
  while (caption.length > 0) {
    const end = caption[caption.length - 1];
    if (end.type === 'softbreak' || end.type === 'hardbreak') {
      caption.pop();
    } else if (end.type === 'text' && /\s$/.test(end.content)) {
      const text = end.content.trimEnd();
      if (text) {
        caption[caption.length - 1] = Object.assign(Object.create(Object.getPrototypeOf(end)), end, { content: text });
        break;
      }
      caption.pop();
    } else {
      break;
    }
  }
  return { label: source.label, children: caption };
}

/**
 * Each figure and each table's caption, as Quarto's, which export gives a
 * caption in Word (see figureImageOf and attachTableCaptions in
 * md-to-docx.ts), at the top level, in no style block. A figure is a
 * paragraph whose one inline token is an image with a figure's label after
 * it, as `![A map](map.png){#fig-map}`, which the image took (see
 * imagePathsWithSpaces). The paragraph is a figure, with the label as its
 * ID, and its caption, `Figure 1: A map`, numbered in order, below or above
 * the image, as the frontmatter says. The image's alt text is its fig-alt,
 * where it has one, and its width and height its attributes'. A table's
 * caption is the paragraph right after the table, as `: A map {#tbl-map}`,
 * which shows `Table 1: A map`, with the label as its ID, numbered in
 * order apart from the figures, and goes above the table or stays below
 * it, as the frontmatter says. An HTML block's table is one where export
 * reads the block as tables, and the last, which the caption goes with,
 * isn't an embed's, which export gives none. The caption goes above that
 * table, which starts a block of its own where HTML is before it, as
 * another table.
 */
function captionsRule(state: StateCore): void {
  const options = getPreviewEnvironment(state).captions ?? DEFAULT_CAPTION_OPTIONS;
  const tokens = state.tokens;
  let styleDepth = 0;
  let number = 0;
  let tableNumber = 0;
  // Where the last table at the top level starts, in no style block, while
  // nothing has come after it, and in an HTML block, where the line of its
  // last table starts, where HTML is before it
  let tableStart: number | undefined;
  let tableLine: number | undefined;
  // What each label's first figure or table shows of its title and number,
  // which a cross-reference to it shows
  const targets = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const afterTable = tableStart;
    const lastTableLine = tableLine;
    tableStart = tableLine = undefined;
    if (token.type === 'html_block' && token.level === 0) {
      const content = token.content || '';
      const fence = styleFence(content);
      if (fence?.kind === 'open') styleDepth++;
      else if (fence?.kind === 'close') styleDepth = Math.max(0, styleDepth - 1);
      else if (styleDepth === 0 && /<table[\s>]/i.test(content) && htmlBlockKind(content) === 'tables') {
        const shown = extractHtmlTables(content).filter(meta => meta.rows.length > 0);
        const last = shown[shown.length - 1];
        if (last.embedIdx === undefined) {
          tableStart = i;
          const line = content.lastIndexOf('\n', (last.start ?? 0) - 1) + 1;
          if (/\S/.test(content.slice(0, line))) tableLine = line;
        }
      }
      continue;
    }
    if (token.type === 'table_open' && token.level === 0 && styleDepth === 0) {
      let close = i + 1;
      while (close < tokens.length && !(tokens[close].type === 'table_close' && tokens[close].level === 0)) close++;
      if (close < tokens.length) tableStart = i;
      i = close;
      continue;
    }
    if (token.type !== 'paragraph_open' || token.level !== 0 || token.hidden || styleDepth > 0) continue;
    const inline = tokens[i + 1];
    const table = afterTable !== undefined && inline?.type === 'inline' && tokens[i + 2]?.type === 'paragraph_close'
      ? tableCaptionTokens(inline.content, inline.children ?? []) : undefined;
    if (table) {
      tableNumber++;
      if (!targets.has(table.label)) targets.set(table.label, captionLabelText(options.tblTitle, tableNumber));
      token.attrSet('id', table.label);
      token.attrJoin('class', 'manuscript-markdown-table-caption');
      const label = new state.Token('text', '', 0);
      label.content = captionLabelText(options.tblTitle, tableNumber) + captionSeparator(options.titleDelim, captionHasText(table.children));
      inline.children = [label, ...table.children];
      if (options.tblCapLocation === 'top') {
        const paragraph = tokens.splice(i, 3);
        if (lastTableLine === undefined) {
          spliceAll(tokens, afterTable!, 0, paragraph);
        } else {
          // The block's HTML before the table, then the caption, then the
          // table, each a block of its own, from the lines they were on
          const block = tokens[afterTable!];
          const content = block.content;
          const before = Object.assign(new state.Token('html_block', '', 0), block, { content: content.slice(0, lastTableLine) });
          const rest = Object.assign(new state.Token('html_block', '', 0), block, { content: content.slice(lastTableLine) });
          if (block.map) {
            const split = block.map[0] + (before.content.match(/\n/g) ?? []).length;
            before.map = [block.map[0], split];
            rest.map = [split, block.map[1]];
          }
          spliceAll(tokens, afterTable!, 1, [before, ...paragraph, rest]);
          i++;
        }
      }
      i += 2;
      continue;
    }
    const image = inline?.type === 'inline' && inline.children?.length === 1 ? inline.children[0] : undefined;
    const figure: FigureAttributes | undefined = image?.type === 'image' ? image.meta?.figure : undefined;
    if (!image || !figure || tokens[i + 2]?.type !== 'paragraph_close') continue;
    number++;
    if (!targets.has(figure.label)) targets.set(figure.label, captionLabelText(options.figTitle, number));
    token.tag = 'figure';
    tokens[i + 2].tag = 'figure';
    token.attrSet('id', figure.label);
    token.attrJoin('class', 'manuscript-markdown-figure');
    const children = image.children ?? [];
    const caption: Token[] = [];
    const open = new state.Token('manuscript_figcaption_open', 'figcaption', 1);
    const label = new state.Token('text', '', 0);
    // Its delimiter only where it has text to show
    label.content = captionLabelText(options.figTitle, number) + captionSeparator(options.titleDelim, captionHasText(children));
    caption.push(open, label);
    for (const child of children) caption.push(Object.assign(new state.Token(child.type, child.tag, child.nesting), child));
    caption.push(new state.Token('manuscript_figcaption_close', 'figcaption', -1));
    const alt = attributeValue(figure.block, 'fig-alt');
    if (alt !== undefined) {
      const text = new state.Token('text', '', 0);
      text.content = alt;
      image.children = [text];
    }
    const style: string[] = [];
    for (const name of ['width', 'height'] as const) {
      const value = attributeValue(figure.block, name);
      if (value === undefined) continue;
      if (/^\d+(?:\.\d+)?$/.test(value)) image.attrSet(name, value);
      else if (/^\d*\.?\d+(?:px|in|cm|mm|pt|pc)$/.test(value)) style.push(name + ': ' + value);
    }
    if (style.length > 0) image.attrSet('style', style.join('; '));
    inline.children = options.figCapLocation === 'top' ? [...caption, image] : [image, ...caption];
  }
  // Each cross-reference's text, its first letter a capital for `@Fig-`
  const shownIn = (children: Token[] | null): void => {
    for (const child of children ?? []) {
      if (child.type === 'manuscript_cross_reference' && child.meta?.form !== 'literal') {
        const shown = targets.get(crossRefLabel(child.meta.key));
        if (shown !== undefined) child.meta.shown = crossRefLabel(child.meta.key) === child.meta.key ? shown : shown.charAt(0).toUpperCase() + shown.slice(1);
      }
      shownIn(child.children);
    }
  };
  for (const token of tokens) if (token.type === 'inline') shownIn(token.children);
}

/**
 * Main plugin function that registers Manuscript Markdown parsing with markdown-it
 * @param md - The MarkdownIt instance to extend
 */
/** A title's value, or a block list's item, of one line that YAML reads
 *  as export does but for the quoting, which can go on it: not a block
 *  scalar, an anchor, an alias or a tag (`|`, `>`, `&`, `*`, `!`), nor one
 *  that opens more braces or brackets than it closes, which YAML reads on
 *  into the lines after it, whatever their indent */
function quotableTitleValue(value: string): boolean {
  if (/^[|>&*!]/.test(value)) return false;
  // Not those in quotes, as in `["on (0, 1]"`, which close nothing
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '');
  const count = (pattern: RegExp) => unquoted.match(pattern)?.length ?? 0;
  return count(/\{/g) <= count(/\}/g) && count(/\[/g) <= count(/\]/g);
}

/**
 * The frontmatter's YAML, `content`, with its title as YAML reads it as
 * export does, for VS Code's preview, which parses the frontmatter as YAML
 * for its table and shows "Failed to parse frontmatter" where it can't. YAML
 * holds a key once, so a title of several lines, `title:` repeated, failed,
 * and it reads a value that starts with a brace, as `{++New++} title`, as a
 * mapping, in a value, a list's item or an inline array's. So where the
 * title has several lines, or a brace in any of them, it's one key, before
 * the other keys where it was first, holding each line quoted, in a list
 * where it has several. Only where each of its entries is as export writes
 * them, a value of one line or a block list of such items (see
 * quotableTitleValue), in YAML with no anchor an alias refers to, so the
 * YAML that parsed still does.
 * Otherwise the YAML stays as it is, which the preview's code block of it
 * shows.
 */
export function frontmatterYamlForPreview(content: string): string {
  // Not YAML with an alias, as `author: *t`, a value or item that starts
  // with one, or an anchor one refers to, as `x: &t v`, which quoting the
  // title could take away, or move after the alias, or show an alias that
  // a title YAML read on into took in, as after `title: {a}{b}`
  if (/(?:^|[:,[{-])[ \t]*\*[^\s,[\]{}]/m.test(content)) return content;
  for (const [, name] of content.matchAll(/&([^\s,[\]{}]+)/g)) {
    if (content.includes('*' + name)) return content;
  }
  const lines = content.split('\n');
  // Each title entry's lines: its key's, and its block list's, with the
  // blank lines and comments between its items, as parseFrontmatter reads
  // it (see blockListAfter)
  const entries: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < lines.length; k++) {
    if (!/^title\s*:/.test(lines[k])) continue;
    const list = blockListAfter(lines, k);
    if (list) {
      if (list.items.some(item => item.more.length > 0 || !quotableTitleValue(item.text))) return content;
    } else if (!quotableTitleValue(lines[k].replace(/^title\s*:/, '').trim())) return content;
    const end = list ? list.last + 1 : k + 1;
    // Not a value YAML reads over more lines: the line after it, past blank
    // lines and comments, is another key's, or there's none, not one
    // indented, as a block scalar's, nor a collection's closer, as `]`
    const after = lines.slice(end).find(line => line.trim() !== '' && !line.startsWith('#'));
    if (after !== undefined && !/^[^\s#\-[\]{}?:,][^:]*:(?:[ \t]|$)/.test(after)) return content;
    entries.push({ start: k, end });
    k = end - 1;
  }
  // A brace anywhere in the title, which YAML can read as a mapping's, in a
  // value, a list's item or an inline array's
  const holdsBrace = entries.some(({ start, end }) => lines.slice(start, end).some(line => line.includes('{')));
  if (entries.length < 2 && !holdsBrace) return content;
  // The title lines its entries give, which must be those export reads from
  // the whole frontmatter: not where it reads others, as from a `title:`
  // indented under another key, nor none, as from frontmatter with a blank
  // line first, which it doesn't read
  const titleYaml = entries.map(({ start, end }) => lines.slice(start, end).join('\n')).join('\n');
  const titles = parseFrontmatter('---\n' + titleYaml + '\n---\n').metadata.title ?? [];
  const exported = parseFrontmatter('---\n' + content + '\n---\n').metadata.title ?? [];
  if (titles.length === 0 || JSON.stringify(exported) !== JSON.stringify(titles)) return content;
  const title = titles.length === 1 ? ['title: ' + JSON.stringify(titles[0])]
    : ['title:', ...titles.map(line => '  - ' + JSON.stringify(line))];
  const out: string[] = [];
  let next = 0;
  for (const [n, { start, end }] of entries.entries()) {
    pushAll(out, lines.slice(next, start));
    if (n === 0) pushAll(out, title);
    next = end;
  }
  pushAll(out, lines.slice(next));
  return out.join('\n');
}

export function manuscriptMarkdownPlugin(md: ManuscriptMarkdownIt): void {
  md.use(imagePathsWithSpaces);
  md.use(codeSpansOfSpaces);
  md.use(linearInlineComments);
  md.use(criticBreaksEndLinks);
  md.use(criticBreaksInRawHtml);
  // Standalone markdown-it consumers (including unit tests) do not load VS
  // Code's math extension. Keep CriticMarkup-in-math output readable there;
  // VS Code's KaTeX renderer wins when it is already registered or loads later.
  if (!md.renderer.rules.math_inline) {
    md.renderer.rules.math_inline = (tokens, idx) => {
      const source = typeof tokens[idx].meta?.manuscriptMathSource === 'string'
        ? tokens[idx].meta.manuscriptMathSource
        : tokens[idx].content;
      return '<span class="manuscript-markdown-math-fallback">' + escapeHtmlText(source) + '</span>';
    };
  }

  // Preprocess source before block parsing to handle multi-paragraph CriticMarkup
  md.core.ruler.before('normalize', 'manuscript_markdown_preprocess', (state: StateCore) => {
    // The document's path, before its line ends change, as the extension's
    // fallback finds the document whose text is the source as it is (see
    // manuscriptGetDocumentPath in extension.ts)
    const docPath = getEmbedDocumentPath(md, state);
    // Each line end as markdown-it's normalize rule, after this one, reads
    // it, as \n, so each step splits lines where markdown-it does. The lines
    // keep their numbers, so the line map needs no step for it.
    state.src = normalizeNewlines(state.src);
    // Parse frontmatter to extract color scheme before preprocessing.
    // Priority: frontmatter > md.manuscriptColors (set by extension) > module-level default
    const { metadata } = parseFrontmatter(state.src);
    const defaultScheme = md.manuscriptColors ?? getDefaultColorScheme();
    const env = getPreviewEnvironment(state);
    env.calloutLabels = metadata.calloutLabels ?? true;
    env.captions = captionOptions(metadata);
    env.colorScheme = metadata.colors || defaultScheme;
    md.set({ breaks: metadata.breaks ?? false });
    // Embed preprocessing runs first so embedded .md files with grid tables get
    // processed by the subsequent grid table preprocessor.
    const embedResolver = md.manuscriptEmbedResolver;
    const embedOptions = md.manuscriptEmbedOptions;
    const r0 = (embedResolver && docPath)
      ? preprocessEmbedsWithMap(state.src, embedResolver, docPath, embedOptions)
      : { output: state.src, map: LineMap.identity() };
    const r1 = preprocessGridTablesWithMap(r0.output);
    const numberResult = formatTableNumbers(r1.output, {
      digits: metadata.tableDigits,
      decimalMark: metadata.tableDecimalMark,
      digitGrouping: metadata.tableDigitGrouping,
    });
    const rNumber = { output: numberResult.output, map: LineMap.identity() };
    const r2 = wrapBareLatexEnvironmentsWithMap(rNumber.output);
    const r3 = preprocessCriticMarkupWithMap(r2.output);
    state.src = r3.output;
    env.lineMap = LineMap.chain(LineMap.chain(LineMap.chain(LineMap.chain(r0.map, r1.map), rNumber.map), r2.map), r3.map);
  });

  // The frontmatter VS Code's preview reads, as YAML it can parse (see
  // frontmatterYamlForPreview). VS Code adds its rule for frontmatter, and
  // its renderer, after this plugin, so this rewrites the token its rule
  // made, which its renderer reads
  md.core.ruler.push('manuscript_front_matter_yaml', (state: StateCore) => {
    const token = state.tokens[0];
    if (token?.type === 'front_matter' && typeof token.meta?.content === 'string') {
      token.meta.content = frontmatterYamlForPreview(token.meta.content);
    }
  });

  // Inject <style> block for header-font-style and custom styles preview
  md.core.ruler.push('manuscript_header_font_style', (state: StateCore) => {
    const { metadata } = parseFrontmatter(state.src);
    let css = '';
    // Header font style CSS (gated on headerFontStyle being set)
    const styles = metadata.headerFontStyle;
    if (styles && styles.length > 0) {
      for (let i = 0; i < 6; i++) {
        const style = i < styles.length ? styles[i] : styles[styles.length - 1];
        const rules: string[] = [];
        if (style === 'normal') {
          rules.push('font-weight: normal', 'font-style: normal', 'text-decoration: none', 'font-variant: normal', 'text-transform: none', 'text-align: left');
        } else {
          rules.push(style.includes('bold') ? 'font-weight: bold' : 'font-weight: normal');
          rules.push(style.includes('italic') ? 'font-style: italic' : 'font-style: normal');
          rules.push(style.includes('underline') ? 'text-decoration: underline' : 'text-decoration: none');
          // smallcaps/allcaps: check smallcaps first since 'smallcaps' contains 'allcaps' as substring
          if (style.includes('smallcaps')) {
            rules.push('font-variant: small-caps', 'text-transform: none');
          } else if (style.includes('allcaps')) {
            rules.push('font-variant: normal', 'text-transform: uppercase');
          } else {
            rules.push('font-variant: normal', 'text-transform: none');
          }
          rules.push(style.includes('center') ? 'text-align: center' : 'text-align: left');
        }
        css += 'h' + (i + 1) + ' { ' + rules.join('; ') + '; }\n';
      }
    }
    // Custom named styles CSS (independent of headerFontStyle)
    if (metadata.styles) {
      for (const [name, def] of Object.entries(metadata.styles)) {
        const safeName = name.replace(/[^a-zA-Z0-9-]/g, '-');
        const csRules: string[] = [];
        if (def.font) csRules.push('font-family: "' + def.font + '"');
        if (def.fontSize !== undefined) csRules.push('font-size: ' + def.fontSize + 'pt');
        const fs = def.fontStyle ?? '';
        if (fs.includes('bold')) csRules.push('font-weight: bold');
        if (fs.includes('italic')) csRules.push('font-style: italic');
        if (fs.includes('underline')) csRules.push('text-decoration: underline');
        if (fs.includes('smallcaps')) csRules.push('font-variant: small-caps');
        else if (fs.includes('allcaps')) csRules.push('text-transform: uppercase');
        if (fs.includes('center')) csRules.push('text-align: center');
        if (def.spacingBefore !== undefined) csRules.push('margin-top: ' + def.spacingBefore + 'pt');
        if (def.spacingAfter !== undefined) csRules.push('margin-bottom: ' + def.spacingAfter + 'pt');
        if (def.paragraphIndent !== undefined) csRules.push('text-indent: ' + (def.paragraphIndent === 'none' ? '0' : def.paragraphIndent + 'in'));
        if (csRules.length > 0) {
          css += '.ms-custom-style-' + safeName + ' p { ' + csRules.join('; ') + '; }\n';
        }
      }
    }
    if (!css) return;
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n' + css + '</style>\n';
    state.tokens.unshift(token);
  });

  // Inject <style> block for table-borders preview
  md.core.ruler.push('manuscript_table_borders', (state: StateCore) => {
    const { metadata } = parseFrontmatter(state.src);
    const borders = metadata.tableBorders ?? 'horizontal';
    const css = borders === 'none'
      ? 'table { border-collapse: collapse; }\n'
        + 'table th, table td { border: none; }\n'
      : borders === 'solid'
        ? 'table { border-collapse: collapse; }\n'
          + 'table th, table td { border: 1px solid var(--vscode-editor-foreground, currentColor); }\n'
        // 'horizontal': light separators between body rows, stronger header underline, no vertical borders
        : 'table { border-collapse: collapse; }\n'
          + 'table th, table td { border: none; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground, currentColor) 25%, transparent); padding: 6px 8px; }\n'
          + 'table thead th { border-bottom: 1px solid var(--vscode-editor-foreground, currentColor); }\n';
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n' + css + '</style>\n';
    state.tokens.unshift(token);
  });

  // Inject <style> block for missing-value colorization in embedded .dta tables
  md.core.ruler.push('manuscript_missing_value_style', (state: StateCore) => {
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n.mm-missing-value { color: var(--vscode-editorError-foreground); }\n</style>\n';
    state.tokens.unshift(token);
  });

  // Register grid table block rule before html_block so the placeholder comment
  // is consumed before markdown-it's html_block rule can swallow it (VS Code's
  // preview enables html: true).
  md.block.ruler.before('html_block', 'manuscript_grid_table_block', gridTableBlockRule);

  // Register the block-level rule to handle multi-line patterns with empty lines
  // This must run very early, before heading and paragraph parsing
  md.block.ruler.before('heading', 'manuscript_markdown_block', manuscriptMarkdownBlock);

  // After block parsing, where VS Code's math extension's block rule, which
  // can register before or after this plugin, has made its tokens
  md.core.ruler.after('block', 'manuscript_display_math_tail', displayMathTailRule);

  // Register inline rule for paragraph placeholder (before other inline rules)
  md.inline.ruler.before('emphasis', 'para_placeholder', paraPlaceholderRule);
  md.inline.ruler.before('escape', 'critic_escaped_break_placeholder', escapedCriticBreakPlaceholderRule);

  // VS Code's math extension registers its inline rule immediately after
  // `escape`, before our general CriticMarkup rule. Intercept only equations
  // that contain complete CriticMarkup spans before that opaque math token is
  // created; ordinary equations continue through VS Code's normal rule.
  md.inline.ruler.before('escape', 'manuscript_markdown_critic_math', parseCriticMarkupInInlineMath);

  // Register the inline rule for Manuscript Markdown parsing
  // Run before emphasis and other inline rules to handle Manuscript Markdown first
  md.inline.ruler.before('emphasis', 'manuscript_markdown', parseManuscriptMarkdown);
  
  // Register the inline rule for ==highlight== patterns
  // Run after Manuscript Markdown to avoid conflicts with {==...==}
  md.inline.ruler.after('manuscript_markdown', 'manuscript_markdown_format_highlight', parseFormatHighlight);

  // A citation is text to export, as it is here, where export reads one
  md.inline.ruler.before('emphasis', 'manuscript_markdown_citation', citationRule);
  // A cross-reference, before a citation, whose brackets it can take
  md.inline.ruler.before('manuscript_markdown_citation', 'manuscript_markdown_cross_reference', crossRefRule);
  // A link to its figure or table, by its label, showing its title and
  // number, as Word's field does, or else, where none has its label, the
  // reference, marked as missing, as a value of a .dta table's is
  md.renderer.rules.manuscript_cross_reference = (tokens, idx) => {
    const token = tokens[idx];
    if (token.meta?.form === 'literal') return escapeHtmlText(token.content);
    const label = crossRefLabel(token.meta?.key ?? '');
    if (token.meta?.shown === undefined) return '<span class="mm-missing-value" title="No figure or table is labeled ' + escapeHtmlAttr('{#' + label + '}') + '">?@' + escapeHtmlText(token.meta?.key ?? '') + '</span>';
    return '<a href="#' + escapeHtmlAttr(label) + '" class="manuscript-markdown-cross-reference">' + escapeHtmlText(token.meta.shown) + '</a>';
  };

  // Register core rule to associate comments with annotated elements
  // Runs after inline parsing to post-process the token stream
  md.core.ruler.after('inline', 'manuscript_markdown_autolink_literals', autolinkLiteralsRule);
  md.core.ruler.after('manuscript_markdown_autolink_literals', 'manuscript_markdown_promote_critic_headings', promoteCriticHeadingsRule);
  md.core.ruler.after('manuscript_markdown_promote_critic_headings', 'manuscript_markdown_associate_comments', associateCommentsRule);
  md.core.ruler.after('manuscript_markdown_associate_comments', 'manuscript_markdown_key_element_comments', (state: StateCore) => {
    if (md.manuscriptPreviewMarkup === 'none') keyElementCommentsRule(state);
  });
  md.core.ruler.after('manuscript_markdown_key_element_comments', 'manuscript_markdown_split_critic_blocks', splitCriticBlocksRule);
  md.core.ruler.after('manuscript_markdown_split_critic_blocks', 'manuscript_markdown_task_list', taskListRule);
  md.core.ruler.after('manuscript_markdown_task_list', 'manuscript_markdown_alert_blockquote', alertBlockquoteRule);

  // Figures and tables' captions, before the style blocks' fences are divs
  md.core.ruler.after('manuscript_markdown_alert_blockquote', 'manuscript_figures', captionsRule);

  // Core rule: wrap <!-- style: X -->...<!-- /style --> blocks in <div class="ms-custom-style ms-custom-style-{name}">
  md.core.ruler.after('manuscript_figures', 'manuscript_custom_style_wrap', (state: StateCore) => {
    const tokens = state.tokens;
    // First pass (reverse): find close directives and record their indices
    const closeIndices: number[] = [];
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      if (tok.type !== 'html_block') continue;
      if (styleFence(tok.content || '')?.kind === 'close') closeIndices.push(i);
    }
    // Second pass (reverse): match opens with closes (stack-based pairing)
    const pairedCloses = new Set<number>();
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      if (tok.type !== 'html_block') continue;
      const fence = styleFence(tok.content || '');
      if (fence?.kind === 'open') {
        // Find the nearest unpaired close after this open
        const closeIdx = closeIndices.find(ci => ci > i && !pairedCloses.has(ci));
        if (closeIdx !== undefined) {
          pairedCloses.add(closeIdx);
          const safeName = fence.style.replace(/[^a-zA-Z0-9-]/g, '-');
          const divOpen = new state.Token('html_block', '', 0);
          divOpen.content = '<div class="ms-custom-style ms-custom-style-' + safeName + '">\n';
          tokens.splice(i, 1, divOpen);
        }
      }
    }
    // Replace paired closes with </div>; leave unpaired closes as-is
    for (const ci of pairedCloses) {
      const divClose = new state.Token('html_block', '', 0);
      divClose.content = '</div>\n';
      tokens.splice(ci, 1, divClose);
    }
  });

  // Comment ranges' spans, after the rules that split a paragraph
  md.core.ruler.after('manuscript_custom_style_wrap', 'manuscript_markdown_comment_range_spans', commentRangeSpansRule);
  // With no markup, the text with every change accepted, once each comment
  // has gone on its element and each range is a span (see acceptChangesRule)
  md.core.ruler.after('manuscript_markdown_comment_range_spans', 'manuscript_markdown_accept_changes', (state: StateCore) => {
    if (md.manuscriptPreviewMarkup === 'none') acceptChangesRule(state);
  });

  // Inject a hidden marker element so the preview script can apply the color scheme
  // class to alert elements (needed because VS Code's built-in GFM alert renderer
  // overrides our blockquote_open renderer and doesn't include our color class).
  // Keep in sync with ColorScheme in frontmatter.ts and CSS in manuscript-markdown.css.
  const ALLOWED_PREVIEW_SCHEMES = new Set<ColorScheme>(['guttmacher']);
  md.core.ruler.push('manuscript_color_scheme_marker', (state: StateCore) => {
    const scheme = getPreviewEnvironment(state).colorScheme;
    if (scheme && ALLOWED_PREVIEW_SCHEMES.has(scheme)) {
      const token = new state.Token('html_block', '', 0);
      token.content = '<span data-manuscript-color-scheme="' + scheme + '" style="display:none"></span>\n';
      state.tokens.unshift(token);
    }
  });

  // VS Code's built-in GFM renderer may replace our blockquote renderer, so use
  // a trusted, narrowly-scoped style token as a fallback when labels are disabled.
  md.core.ruler.push('manuscript_callout_labels_style', (state: StateCore) => {
    if (getPreviewEnvironment(state).calloutLabels !== false) return;
    const token = new state.Token('manuscript_style', '', 0);
    token.content = '<style>\n.markdown-alert > .markdown-alert-title { display: none !important; }\n</style>\n';
    state.tokens.unshift(token);
  });

  // Remap token .map values from preprocessed line numbers back to original
  // source line numbers so VS Code's data-line scroll sync attributes are correct.
  // Must run after all other core rules that create or modify tokens.
  md.core.ruler.push('manuscript_scroll_sync_remap', (state: StateCore) => {
    const lineMap = getPreviewEnvironment(state).lineMap;
    if (!lineMap || lineMap.isIdentity) return;
    for (const token of state.tokens) {
      if (token.map && !token.meta?.manuscriptMapIsOriginal) {
        token.map = [lineMap.remap(token.map[0]), lineMap.remap(token.map[1])];
      }
    }
  });

  // A citation is text, as to export, once linkify and the rules that read
  // text tokens, which export runs on none in one, are done: the host's
  // heading IDs and an image's alt text are made of text tokens alone.
  // Whatever the source holds, as a grid table's cells, which preprocessing
  // writes as a placeholder, have tokens of their own. So is a
  // cross-reference in an image's alt text, its content as written, which
  // export writes there too, as of `![See @fig-map](map.png)`, though not
  // in a figure's caption, which captionsRule copied from it.
  md.core.ruler.push('manuscript_citation_text', (state: StateCore) => {
    const citationsAsText = (tokens: Token[] | null, inImage: boolean): void => {
      for (const token of tokens ?? []) {
        if (token.type === 'manuscript_citation' || inImage && token.type === 'manuscript_cross_reference') token.type = 'text';
        citationsAsText(token.children, inImage || token.type === 'image');
      }
    };
    citationsAsText(state.tokens, false);
  });
  md.use(criticBreaksLeftOver);

  // Register renderers for each Manuscript Markdown token type
  for (const pattern of patterns) {
    md.renderer.rules[`manuscript_markdown_${pattern.name}_open`] = (tokens, idx) => {
      const token = tokens[idx];
      const className = token.attrGet('class') || pattern.cssClass;
      const dataComment = token.attrGet('data-comment');
      let attrs = `class="${className}"`;
      if (dataComment) {
        attrs += ` data-comment="${escapeHtmlAttr(dataComment)}"`;
      }
      return `<${pattern.htmlTag} ${attrs}>`;
    };
    
    md.renderer.rules[`manuscript_markdown_${pattern.name}_close`] = (tokens, idx) => {
      const token = tokens[idx];
      return `</${token.tag}>`;
    };
  }
  
  // Special renderers for substitution sub-parts
  md.renderer.rules['manuscript_markdown_substitution_old_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || '';
    return `<del class="${className}">`;
  };
  
  md.renderer.rules['manuscript_markdown_substitution_old_close'] = () => {
    return '</del>';
  };
  
  md.renderer.rules['manuscript_markdown_substitution_new_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || '';
    return `<ins class="${className}">`;
  };
  
  md.renderer.rules['manuscript_markdown_substitution_new_close'] = () => {
    return '</ins>';
  };
  
  // Renderer for ==highlight== patterns
  md.renderer.rules['manuscript_markdown_format_highlight_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || 'manuscript-markdown-format-highlight';
    const dataComment = token.attrGet('data-comment');
    let attrs = `class="${className}"`;
    if (dataComment) {
      attrs += ` data-comment="${escapeHtmlAttr(dataComment)}"`;
    }
    return `<mark ${attrs}>`;
  };
  
  md.renderer.rules['manuscript_markdown_format_highlight_close'] = () => {
    return '</mark>';
  };

  // A figure's caption, around its title, number and text (see figuresRule)
  md.renderer.rules['manuscript_figcaption_open'] = () => '<figcaption>';
  md.renderer.rules['manuscript_figcaption_close'] = () => '</figcaption>';

  // Renderer for range markers ({#id} and {/id}) without matching comments — render as empty string
  md.renderer.rules['manuscript_markdown_range_marker'] = () => {
    return '';
  };

  // Renderers for ID-based comment ranges (range markers with matching comments)
  md.renderer.rules['manuscript_markdown_comment_range_open'] = (tokens, idx) => {
    const token = tokens[idx];
    const className = token.attrGet('class') || 'manuscript-markdown-comment-range';
    const dataComment = token.attrGet('data-comment');
    let attrs = `class="${className}"`;
    if (dataComment) {
      attrs += ` data-comment="${escapeHtmlAttr(dataComment)}"`;
    }
    return `<span ${attrs}>`;
  };

  md.renderer.rules['manuscript_markdown_comment_range_close'] = () => {
    return '</span>';
  };

  // Renderer for standalone comment indicators (comments not associated with annotated text)
  md.renderer.rules['manuscript_markdown_comment_indicator'] = (tokens, idx) => {
    const token = tokens[idx];
    const dataComment = token.attrGet('data-comment') || '';
    return `<span class="manuscript-markdown-comment-indicator" data-comment="${escapeHtmlAttr(dataComment)}"></span>`;
  };

  // GFM disallowed raw HTML tags must be rendered as escaped text, not live HTML.
  md.renderer.rules.html_inline = (tokens, idx) => {
    const content = tokens[idx].content || '';
    return isGfmDisallowedRawHtml(content) ? escapeHtmlText(content) : content;
  };
  md.renderer.rules.html_block = (tokens, idx) => {
    const token = tokens[idx];
    const content = token.content || '';
    if (isGfmDisallowedRawHtml(content)) {
      return '<p>' + escapeHtmlText(content) + '</p>\n';
    }
    if (token.map) {
      return '<div data-line="' + token.map[0] + '">' + content + '</div>\n';
    }
    return content;
  };

  // Trusted internal style blocks injected by manuscript rules — bypass GFM filtering.
  md.renderer.rules.manuscript_style = (tokens, idx) => tokens[idx].content || '';

  // GFM task list rendering.
  md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
    const checked = tokens[idx].meta?.taskChecked;
    if (checked !== undefined) {
      tokens[idx].attrJoin('class', 'task-list-item');
    }
    const rendered = self.renderToken(tokens, idx, options);
    if (checked === undefined) return rendered;
    const checkbox = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> `;
    return rendered + checkbox;
  };

  md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const alertType: GfmAlertType | undefined = token.meta?.gfmAlertType;
    if (!alertType) {
      return self.renderToken(tokens, idx, options);
    }
    const dataLine = token.map ? ' data-line="' + token.map[0] + '"' : '';
    const previewEnv = env as PreviewEnvironment;
    const colorScheme = previewEnv.colorScheme;
    const schemeClass = colorScheme && ALLOWED_PREVIEW_SCHEMES.has(colorScheme) ? ' color-scheme-' + colorScheme : '';
    const blockquote = '<blockquote' + dataLine + ' class="markdown-alert markdown-alert-' + alertType + schemeClass + '">';
    if (previewEnv.calloutLabels === false) return blockquote + '\n';
    const title = token.meta?.gfmAlertTitle || gfmAlertTitle(alertType);
    return blockquote + '<p class="markdown-alert-title">' + alertOcticonSvg(alertType) + ' ' + escapeHtmlText(title) + '</p>\n';
  };

}
