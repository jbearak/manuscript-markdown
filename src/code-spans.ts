import type MarkdownIt from 'markdown-it';
import backticks from 'markdown-it/lib/rules_inline/backticks.mjs';

/** Keep code of spaces alone as it is, as CommonMark §6.1 does, where
 * markdown-it strips a space from each end of it as of any other code, and
 * reads `   ` as one space. Preview and Word export must install the same rule.
 */
export function codeSpansOfSpaces(md: MarkdownIt): void {
  md.inline.ruler.at('backticks', (state, silent) => {
    const start = state.pos;
    const count = state.tokens.length;
    if (!backticks(state, silent)) return false;
    const token = state.tokens[state.tokens.length - 1];
    if (!silent && state.tokens.length > count && token.type === 'code_inline') {
      const fence = token.markup.length;
      const content = state.src.slice(start + fence, state.pos - fence).replace(/\n/g, ' ');
      if (/^ +$/.test(content)) token.content = content;
    }
    return true;
  });
}
