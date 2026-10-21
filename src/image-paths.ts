import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import image from 'markdown-it/lib/rules_inline/image.mjs';
import { figureAttributesAt, nextIndexFinder } from './captions';

// For each inline parse, its finder of the next of a character (see
// nextIndexFinder), as the parse goes over its text from the start
const finders = new WeakMap<StateInline, (ch: string, from: number) => number>();

/**
 * Take the figure's attribute block right after an image, as `{#fig-map}`
 * (see figureAttributesAt), which then is the image's, in its token's
 * `meta.figure`, and no comment's range start. It goes with the image in
 * a silent parse too, as in a link's text, as one that isn't silent has it.
 */
function takeFigureAttributes(state: StateInline, silent: boolean): void {
  let next = finders.get(state);
  if (!next) finders.set(state, next = nextIndexFinder(state.src));
  const figure = figureAttributesAt(state.src, state.pos, state.posMax, next);
  if (!figure) return;
  const token = state.tokens[state.tokens.length - 1];
  if (!silent && token?.type === 'image') token.meta = { ...token.meta, figure };
  state.pos = figure.end;
}

/** Accept bare image paths with spaces after the standard image parser has
 * declined them. Keep this inline so code, HTML, and ordinary links are untouched.
 * Preview and Word export must install the same rule.
 */
export function imagePathsWithSpaces(md: MarkdownIt): void {
  md.inline.ruler.at('image', (state, silent) => {
    const start = state.pos;
    if (image(state, silent)) {
      // An inline image's Markdown as written, which export keeps when it
      // can't embed the image; a reference's definition doesn't go to Word
      const token = state.tokens[state.tokens.length - 1];
      const labelEnd = md.helpers.parseLinkLabel(state, start + 1, false);
      if (!silent && token?.type === 'image' && state.src[labelEnd + 1] === '(') {
        token.meta = { ...token.meta, source: state.src.slice(start, state.pos) };
      }
      takeFigureAttributes(state, silent);
      return true;
    }
    if (state.src.slice(start, start + 2) !== '![') return false;
    const labelEnd = md.helpers.parseLinkLabel(state, start + 1, false);
    if (labelEnd < 0 || state.src[labelEnd + 1] !== '(') return false;

    const pathStart = labelEnd + 2;
    let depth = 0;
    let pos = pathStart;
    let pathEnd = -1;
    let title = '';
    for (; pos < state.posMax; pos++) {
      const ch = state.src[pos];
      if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === '<' || ch === '>') return false;
      if (ch === '\\') {
        const escaped = state.src.charCodeAt(pos + 1);
        if (pos + 1 >= state.posMax || escaped < 32 || escaped === 127) return false;
        pos++;
        continue;
      }
      if (ch === ' ' && depth === 0) {
        let titleStart = pos;
        while (state.src[titleStart] === ' ') titleStart++;
        const parsed = md.helpers.parseLinkTitle(state.src, titleStart, state.posMax);
        if (parsed.ok) {
          let end = parsed.pos;
          while (state.src[end] === ' ') end++;
          if (state.src[end] === ')') {
            pathEnd = pos;
            title = parsed.str;
            pos = end;
            break;
          }
        }
      }
      if (ch === '(' && ++depth > 32) return false;
      if (ch === ')') {
        if (depth === 0) { pathEnd = pos; break; }
        depth--;
      }
    }
    if (pathEnd < 0) return false;
    const path = state.src.slice(pathStart, pathEnd).trim();
    if (!path.includes(' ')) return false;
    const href = md.normalizeLink(md.utils.unescapeAll(path));
    if (!md.validateLink(href)) return false;

    if (!silent) {
      const content = state.src.slice(start + 2, labelEnd);
      const token = state.push('image', 'img', 0);
      token.attrs = [['src', href], ['alt', '']];
      if (title) token.attrSet('title', title);
      token.content = content;
      token.meta = { ...token.meta, source: state.src.slice(start, pos + 1) };
      token.children = [];
      md.inline.parse(content, md, state.env, token.children);
    }
    state.pos = pos + 1;
    takeFigureAttributes(state, silent);
    return true;
  });
}
