import type MarkdownIt from 'markdown-it';
import image from 'markdown-it/lib/rules_inline/image.mjs';

/** Accept bare image paths with spaces after the standard image parser has
 * declined them. Keep this inline so code, HTML, and ordinary links are untouched.
 * Preview and Word export must install the same rule.
 */
export function imagePathsWithSpaces(md: MarkdownIt): void {
  md.inline.ruler.at('image', (state, silent) => {
    if (image(state, silent)) return true;
    const start = state.pos;
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
      if (ch.charCodeAt(0) < 32 || ch === '<' || ch === '>') return false;
      if (ch === '\\') { pos++; continue; }
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
      token.children = [];
      md.inline.parse(content, md, state.env, token.children);
    }
    state.pos = pos + 1;
    return true;
  });
}
