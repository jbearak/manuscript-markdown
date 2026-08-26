import { findMatchingClose, restoreCriticLineBreaks } from './critic-markup';

export type CriticMathPart =
  | { type: 'math'; content: string }
  | { type: 'addition' | 'deletion' | 'highlight' | 'comment'; content: string }
  | { type: 'substitution'; oldContent: string; newContent: string };

const SIMPLE_MARKERS = [
  { open: '{++', close: '++}', type: 'addition' as const },
  { open: '{--', close: '--}', type: 'deletion' as const },
  { open: '{==', close: '==}', type: 'highlight' as const },
];

function isEscaped(src: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && src.charAt(i) === '\\'; i--) slashCount++;
  return slashCount % 2 === 1;
}

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
  src = restoreCriticLineBreaks(src);
  const parts: CriticMathPart[] = [];
  let textStart = 0;
  let pos = 0;
  let found = false;

  const pushMathBefore = (index: number) => {
    if (index > textStart) parts.push({ type: 'math', content: src.slice(textStart, index) });
  };

  while (pos < src.length - 2) {
    if (src.charAt(pos) !== '{' || isEscaped(src, pos)) {
      pos++;
      continue;
    }

    const simple = SIMPLE_MARKERS.find(marker => src.startsWith(marker.open, pos));
    if (simple) {
      const contentStart = pos + simple.open.length;
      const closePos = src.indexOf(simple.close, contentStart);
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
      const closePos = src.indexOf('~~}', contentStart);
      if (closePos !== -1) {
        const content = src.slice(contentStart, closePos);
        const separatorPos = content.indexOf('~>');
        if (separatorPos !== -1) {
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
    }

    if (src.startsWith('{>>', pos)) {
      const contentStart = pos + 3;
      const closePos = findMatchingClose(src, contentStart);
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
