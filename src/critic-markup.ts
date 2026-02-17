// Placeholder used to preserve paragraph breaks inside CriticMarkup spans.
// Uses Private Use Area characters to avoid markdown-it's normalize step
// which replaces \u0000 with \uFFFD.
export const PARA_PLACEHOLDER = '\uE000PARA\uE000';

/**
 * Preprocess markdown source: replace \n\n inside CriticMarkup spans with a
 * placeholder so markdown-it's block parser doesn't split them into separate
 * paragraphs.
 */
export function preprocessCriticMarkup(markdown: string): string {
  // Fast path: if no CriticMarkup opening markers, return unchanged
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==') && !markdown.includes('{#')) {
    return markdown;
  }

  const markers: Array<{ open: string; close: string }> = [
    { open: '{++', close: '++}' },
    { open: '{--', close: '--}' },
    { open: '{~~', close: '~~}' },
    { open: '{>>', close: '<<}' },
    { open: '{==', close: '==}' },
  ];

  let result = markdown;
  for (const { open, close } of markers) {
    let searchFrom = 0;
    while (true) {
      const openIdx = result.indexOf(open, searchFrom);
      if (openIdx === -1) break;
      const contentStart = openIdx + open.length;
      const closeIdx = result.indexOf(close, contentStart);
      if (closeIdx === -1) {
        searchFrom = contentStart;
        continue;
      }
      const content = result.slice(contentStart, closeIdx);
      if (content.includes('\n\n')) {
        const replaced = content.replace(/\n\n/g, PARA_PLACEHOLDER);
        result = result.slice(0, contentStart) + replaced + result.slice(closeIdx);
        // Advance past the replaced span
        searchFrom = contentStart + replaced.length + close.length;
      } else {
        searchFrom = closeIdx + close.length;
      }
    }
  }

  // Handle {#id>>...<<} comment bodies with IDs (variable-length open marker)
  let idSearchFrom = 0;
  while (true) {
    const idCommentRe = /\{#[a-zA-Z0-9_-]+>>/;
    const match = idCommentRe.exec(result.slice(idSearchFrom));
    if (!match) break;
    const matchIndex = idSearchFrom + match.index;
    const contentStart = matchIndex + match[0].length;
    const closeIdx = result.indexOf('<<}', contentStart);
    if (closeIdx === -1) {
      idSearchFrom = contentStart;
      continue;
    }
    const content = result.slice(contentStart, closeIdx);
    if (content.includes('\n\n')) {
      const replaced = content.replace(/\n\n/g, PARA_PLACEHOLDER);
      result = result.slice(0, contentStart) + replaced + result.slice(closeIdx);
      idSearchFrom = contentStart + replaced.length + 3;
    } else {
      idSearchFrom = closeIdx + 3;
    }
  }

  return result;
}
