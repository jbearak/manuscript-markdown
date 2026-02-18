import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { preprocessCriticMarkup, PARA_PLACEHOLDER, findMatchingClose } from './critic-markup';

// Reference: original slice-and-rebuild implementation
function preprocessCriticMarkupReference(markdown: string): string {
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==') && !markdown.includes('{#')) {
    return markdown;
  }
  const markers = [
    { open: '{++', close: '++}' },
    { open: '{--', close: '--}' },
    { open: '{~~', close: '~~}' },
    { open: '{>>', close: '<<}', nested: true },
    { open: '{==', close: '==}' },
  ];
  let result = markdown;
  for (const { open, close, nested } of markers) {
    let searchFrom = 0;
    while (true) {
      const openIdx = result.indexOf(open, searchFrom);
      if (openIdx === -1) break;
      const contentStart = openIdx + open.length;
      let closeIdx: number;
      if (nested) {
        closeIdx = findMatchingClose(result, contentStart);
      } else {
        closeIdx = result.indexOf(close, contentStart);
      }
      if (closeIdx === -1) { searchFrom = contentStart; continue; }
      const content = result.slice(contentStart, closeIdx);
      if (content.includes('\n\n')) {
        const replaced = content.replace(/\n\n/g, PARA_PLACEHOLDER);
        result = result.slice(0, contentStart) + replaced + result.slice(closeIdx);
        searchFrom = contentStart + replaced.length + close.length;
      } else {
        searchFrom = closeIdx + close.length;
      }
    }
  }
  let idSearchFrom = 0;
  while (true) {
    const idCommentRe = /\{#[a-zA-Z0-9_-]+>>/;
    const match = idCommentRe.exec(result.slice(idSearchFrom));
    if (!match) break;
    const matchIndex = idSearchFrom + match.index;
    const contentStart = matchIndex + match[0].length;
    const closeIdx = findMatchingClose(result, contentStart);
    if (closeIdx === -1) { idSearchFrom = contentStart; continue; }
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

describe('Property 6: Streaming Preprocessor Equivalence', () => {
  const criticPatternGen = fc.oneof(
    fc.string({ maxLength: 30 }).map(s => '{++' + s.replace(/\+\+\}/g, '') + '++}'),
    fc.string({ maxLength: 30 }).map(s => '{--' + s.replace(/--\}/g, '') + '--}'),
    fc.string({ maxLength: 30 }).map(s => '{~~' + s.replace(/~~\}/g, '').replace(/~>/g, '') + '~>' + s.replace(/~~\}/g, '') + '~~}'),
    fc.string({ maxLength: 30 }).map(s => '{>>' + s.replace(/<<\}/g, '') + '<<}'),
    fc.string({ maxLength: 30 }).map(s => '{==' + s.replace(/==\}/g, '') + '==}'),
    fc.string({ maxLength: 20 }).map(s => '{#id1>>' + s.replace(/<<\}/g, '') + '<<}'),
  );

  // Include \n\n in some patterns to trigger replacement
  const criticWithParaGen = fc.oneof(
    fc.string({ maxLength: 15 }).map(s => '{++' + s + '\n\n' + s + '++}'),
    fc.string({ maxLength: 15 }).map(s => '{--' + s + '\n\n' + s + '--}'),
    fc.string({ maxLength: 15 }).map(s => '{>>' + s + '\n\n' + s + '<<}'),
    fc.string({ maxLength: 15 }).map(s => '{==' + s + '\n\n' + s + '==}'),
    fc.string({ maxLength: 10 }).map(s => '{#abc>>' + s + '\n\n' + s + '<<}'),
  );

  const textGen = fc.array(
    fc.oneof(criticPatternGen, criticWithParaGen, fc.string({ maxLength: 40 })),
    { minLength: 1, maxLength: 8 }
  ).map(parts => parts.join(' '));

  test('streaming builder matches original slice-and-rebuild', () => {
    fc.assert(
      fc.property(textGen, (text) => {
        expect(preprocessCriticMarkup(text)).toBe(preprocessCriticMarkupReference(text));
      }),
      { numRuns: 200 }
    );
  });
});
