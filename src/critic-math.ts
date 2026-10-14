import { criticCloserSearch, restoreCriticLineBreaks } from './critic-markup';
import { isEscapedAt } from './math-delimiters';

export type CriticMathPart =
  | { type: 'math'; content: string }
  | { type: 'addition' | 'deletion' | 'highlight' | 'comment'; content: string }
  | { type: 'substitution'; oldContent: string; newContent: string };

const SIMPLE_MARKERS = [
  { open: '{++', close: '++}', type: 'addition' as const },
  { open: '{--', close: '--}', type: 'deletion' as const },
  { open: '{==', close: '==}', type: 'highlight' as const },
];
const CRITIC_MATH_OPENER_RE = /\{(?:\+\+|--|==|~~|>>)/;

/**
 * Split an inline equation containing CriticMarkup into renderable math and
 * annotation parts. Returns undefined when the equation has no complete
 * CriticMarkup span, so the normal math parser can handle it unchanged.
 *
 * Each annotated payload is intentionally treated as a self-contained LaTeX
 * fragment. That lets the preview and DOCX exporter put semantic CriticMarkup
 * wrappers around only the changed portion of an equation.
 */
export function splitCriticMarkupInMath(src: string): CriticMathPart[] | undefined {
  if (!CRITIC_MATH_OPENER_RE.test(src)) return undefined;
  src = restoreCriticLineBreaks(src);
  // Each opener's closer, and a substitution's ~>, from one search of the
  // equation for each, as each unclosed opener searched the rest of it
  const closers = criticCloserSearch(src);
  const parts: CriticMathPart[] = [];
  let textStart = 0;
  let pos = 0;
  let found = false;

  const pushMathBefore = (index: number) => {
    if (index > textStart) parts.push({ type: 'math', content: src.slice(textStart, index) });
  };

  while (pos < src.length - 2) {
    if (src.charAt(pos) !== '{' || isEscapedAt(src, pos)) {
      pos++;
      continue;
    }

    const simple = SIMPLE_MARKERS.find(marker => src.startsWith(marker.open, pos));
    if (simple) {
      const contentStart = pos + simple.open.length;
      const closePos = closers.next(simple.close, contentStart);
      if (closePos !== -1) {
        pushMathBefore(pos);
        parts.push({ type: simple.type, content: src.slice(contentStart, closePos) });
        pos = closePos + simple.close.length;
        textStart = pos;
        found = true;
        continue;
      }
    }

    if (src.startsWith('{~~', pos)) {
      const contentStart = pos + 3;
      const closePos = closers.next('~~}', contentStart);
      // The first ~> in the span, which none is in where the first after
      // its opener is past its closer
      const separatorAt = closePos === -1 ? -1 : closers.next('~>', contentStart);
      if (separatorAt !== -1 && separatorAt < closePos) {
        const content = src.slice(contentStart, closePos);
        const separatorPos = separatorAt - contentStart;
        pushMathBefore(pos);
        parts.push({
          type: 'substitution',
          oldContent: content.slice(0, separatorPos),
          newContent: content.slice(separatorPos + 2),
        });
        pos = closePos + 3;
        textStart = pos;
        found = true;
        continue;
      }
    }

    if (src.startsWith('{>>', pos)) {
      const contentStart = pos + 3;
      const closePos = closers.matching(contentStart);
      if (closePos !== -1) {
        pushMathBefore(pos);
        parts.push({ type: 'comment', content: src.slice(contentStart, closePos) });
        pos = closePos + 3;
        textStart = pos;
        found = true;
        continue;
      }
    }

    pos++;
  }

  if (!found) return undefined;
  if (textStart < src.length) parts.push({ type: 'math', content: src.slice(textStart) });
  return parts;
}
