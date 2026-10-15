import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import { preprocessCriticMarkup, PARA_PLACEHOLDER, LINE_PLACEHOLDER, findMatchingClose, criticCloserSearch, criticPayloadRanges } from './critic-markup';
import { computeCodeRegions, isInsideCodeRegion } from './code-regions';
import { fastestRun } from './test-timing';

function isEscapedAt(content: string, offset: number): boolean {
  let backslashes = 0;
  for (let i = offset - 1; i >= 0 && content.charCodeAt(i) === 0x5C; i--) backslashes++;
  return backslashes % 2 === 1;
}

const blockCodeParser = new MarkdownIt();
const htmlBlockParser = new MarkdownIt({ html: true });

function mergeReferenceRegions(regions: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  regions.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const region of regions) {
    const previous = merged[merged.length - 1];
    if (previous && region.start <= previous.end) previous.end = Math.max(previous.end, region.end);
    else merged.push({ ...region });
  }
  return merged;
}

function hasReferenceHtmlBlock(content: string): boolean {
  return htmlBlockParser.parse(content, {}).some(token => token.type === 'html_block');
}

function computeReferenceListRegions(content: string): Array<{ start: number; end: number }> {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    if (char === 0x0D) {
      if (content.charCodeAt(i + 1) === 0x0A) i++;
      lineStarts.push(i + 1);
    } else if (char === 0x0A) {
      lineStarts.push(i + 1);
    }
  }
  const regions: Array<{ start: number; end: number }> = [];
  for (const token of blockCodeParser.parse(content, {})) {
    if (token.type !== 'list_item_open' || !token.map) continue;
    regions.push({
      start: lineStarts[token.map[0]] ?? content.length,
      end: lineStarts[token.map[1]] ?? content.length,
    });
  }
  return mergeReferenceRegions(regions);
}

function quoteDepthAt(content: string, offset: number): number {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  let prefix = content.slice(lineStart, offset);
  let depth = 0;
  while (true) {
    const match = prefix.match(/^[ \t]*>[ \t]?/);
    if (!match) return depth;
    depth++;
    prefix = prefix.slice(match[0].length);
  }
}

function stripQuoteContinuationPrefixes(content: string, depth: number): string {
  if (depth === 0 || !content.includes('\n')) return content;
  return content.replace(/\n([^\n]*)/g, (_full, line: string) => {
    let remainder = line;
    for (let level = 0; level < depth; level++) {
      const match = remainder.match(/^[ \t]*>[ \t]?/);
      if (!match) return '\n' + line;
      remainder = remainder.slice(match[0].length);
    }
    return '\n' + remainder;
  });
}

function isInsideDollarMathAt(content: string, offset: number, codeRegions: Array<{ start: number; end: number }>): boolean {
  const findClose = (start: number, delimiterLength: 1 | 2): number => {
    for (let i = start; i < content.length; i++) {
      if (content.charCodeAt(i) !== 0x24 || isEscapedAt(content, i) || isInsideCodeRegion(i, codeRegions)) continue;
      let runLength = 1;
      while (i + runLength < content.length && content.charCodeAt(i + runLength) === 0x24) runLength++;
      if (runLength === delimiterLength) return i;
      i += runLength - 1;
    }
    return -1;
  };

  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) !== 0x24 || isEscapedAt(content, i) || isInsideCodeRegion(i, codeRegions)) continue;
    let runLength = 1;
    while (i + runLength < content.length && content.charCodeAt(i + runLength) === 0x24) runLength++;
    if (runLength > 2) {
      i += runLength - 1;
      continue;
    }
    if (runLength === 1 && ((i > 0 && /\w/.test(content.charAt(i - 1))) ||
        /^\d[\d,.]*(?:\s|$)/.test(content.slice(i + 1)))) continue;

    const delimiterLength = runLength as 1 | 2;
    const close = findClose(i + delimiterLength, delimiterLength);
    if (close === -1 || (delimiterLength === 1 && /\w/.test(content.charAt(close + 1)))) continue;
    if (offset >= i && offset < close + delimiterLength) return true;
    i = close + delimiterLength - 1;
  }
  return false;
}

// Reference: original slice-and-rebuild implementation
function preprocessCriticMarkupReference(markdown: string): string {
  if (!markdown.includes('{++') && !markdown.includes('{--') &&
      !markdown.includes('{~~') && !markdown.includes('{>>') &&
      !markdown.includes('{==') && !markdown.includes('{#')) {
    return markdown;
  }
  const initialCodeRegions = computeCodeRegions(markdown);
  const initialListRegions = computeReferenceListRegions(markdown);
  markdown = markdown.replace(
    /(\{\+\+|\{--|\{~~|\{==|\{>>)(\n(?:[ \t]*(?:>[ \t]*)?\n)?)([ \t]*(?:(?:>[ \t]*)+)?)/g,
    (full, open: string, leadingBreak: string, nextPrefix: string, offset: number) => {
      if (isInsideCodeRegion(offset, initialCodeRegions) || isEscapedAt(markdown, offset) ||
          isInsideDollarMathAt(markdown, offset, initialCodeRegions) ||
          isInsideCodeRegion(offset, initialListRegions)) return full;
      const contentStart = offset + open.length;
      const closePos = open === '{>>'
        ? findMatchingClose(markdown, contentStart)
        : markdown.indexOf(open === '{++' ? '++}' : open === '{--' ? '--}' : open === '{==' ? '==}' : '~~}', contentStart);
      if (closePos === -1) return full;
      if (open === '{~~') {
        const separatorPos = markdown.indexOf('~>', contentStart);
        if (separatorPos === -1 || separatorPos >= closePos) return full;
      }
      if (/^\s*$/.test(stripQuoteContinuationPrefixes(markdown.slice(contentStart, closePos), quoteDepthAt(markdown, offset)))) return full;
      const lineStart = markdown.lastIndexOf('\n', offset - 1) + 1;
      const linePrefix = markdown.slice(lineStart, offset);
      if (linePrefix.trim().length === 0) return full;
      const quoteMatch = linePrefix.match(/^((?:[ \t]{0,3}>[ \t]?)+)/);
      const blankLine = leadingBreak !== '\n';
      if (quoteMatch) {
        const quoteDepth = (quoteMatch[1].match(/>/g) ?? []).length;
        const nextQuoteDepth = (nextPrefix.match(/>/g) ?? []).length;
        if (nextQuoteDepth < quoteDepth) return full;
        const paragraphBreak = blankLine
          ? leadingBreak
          : '\n' + quoteMatch[1].trimEnd() + '\n';
        return paragraphBreak + nextPrefix + open;
      }
      const paragraphBreak = blankLine ? leadingBreak : '\n\n';
      return paragraphBreak + open + nextPrefix;
    },
  );
  const result = markdown;
  const codeRegions = computeCodeRegions(result);
  // Keep source offsets stable so an earlier replacement cannot change the
  // line or container context used for a later opener.
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const openerRe = /\{\+\+|\{--|\{~~|\{>>|\{==|\{#[a-zA-Z0-9_-]+>>/g;
  let searchFrom = 0;
  while (true) {
    openerRe.lastIndex = searchFrom;
    const match = openerRe.exec(result);
    if (!match) break;
    const openIdx = match.index;
    const open = match[0];
    const contentStart = openIdx + open.length;
    if (isInsideCodeRegion(openIdx, codeRegions) || isEscapedAt(result, openIdx)) {
      searchFrom = contentStart;
      continue;
    }
    const nested = open === '{>>' || open.startsWith('{#');
    const close = nested
      ? '<<}'
      : open === '{++' ? '++}' : open === '{--' ? '--}' : open === '{==' ? '==}' : '~~}';
    const closeIdx = nested
      ? findMatchingClose(result, contentStart)
      : result.indexOf(close, contentStart);
    if (closeIdx === -1) {
      searchFrom = contentStart;
      continue;
    }
    if (open === '{~~') {
      const separatorPos = result.indexOf('~>', contentStart);
      if (separatorPos === -1 || separatorPos >= closeIdx) {
        searchFrom = contentStart;
        continue;
      }
    }
    const content = result.slice(contentStart, closeIdx);
    if (content.includes('\n')) {
      const replaced = stripQuoteContinuationPrefixes(content, quoteDepthAt(result, openIdx))
        .replace(/\n[ \t]*\n/g, PARA_PLACEHOLDER)
        .replace(/\n/g, LINE_PLACEHOLDER);
      edits.push({ start: contentStart, end: closeIdx, replacement: replaced });
    }
    searchFrom = closeIdx + close.length;
  }
  let rebuilt = result;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    rebuilt = rebuilt.slice(0, edit.start) + edit.replacement + rebuilt.slice(edit.end);
  }
  return rebuilt;
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
    fc.oneof(
      criticPatternGen,
      criticWithParaGen,
      fc.string({ maxLength: 40 }),
    ),
    { minLength: 1, maxLength: 8 }
  ).map(parts => parts.join(' '));

  test('streaming builder matches original slice-and-rebuild', () => {
    // The reference reads no equation, an opener in which pairs only with a
    // closer in it (see equationsAtOpeners in critic-markup.ts)
    fc.assert(
      fc.property(textGen.filter(text => !hasReferenceHtmlBlock(text) && !text.includes('$')), (text) => {
        expect(preprocessCriticMarkup(text)).toBe(preprocessCriticMarkupReference(text));
      }),
      { numRuns: 200 }
    );
  });

  test('matches the reference in container edge cases', () => {
    for (const text of [
      '- Intro\n  Earlier.{++\n  Added.++}',
      '> {++before\n>\n> after++}',
      '- outer\n    - inner\n      > {++before\n      >\n      > after++}',
      '    `x` `x` {++first\n    second++}',
      'Before{~~\nliteral~~}',
      '{~~old\n\n# heading~~}',
      '{#abc>>>\n\n><<} {>>\n\n<<} {==>\n\n>==}',
      '> {--\n\n--} {>>>\n\n><<} {==\n\n==}',
      '> {#abc>>\n\n<<} {==>\n\n>==} ',
    ]) {
      if (text.includes('{~~')) expect(preprocessCriticMarkup(text)).toBe(text);
      expect(preprocessCriticMarkup(text)).toBe(preprocessCriticMarkupReference(text));
    }
  });

  test('leaves CriticMarkup line breaks inside HTML blocks inert', () => {
    expect(preprocessCriticMarkup('<? {--\n\n--} {~~~>~~}'))
      .toBe('<? {--\n\n--} {~~~>~~}');
    expect(preprocessCriticMarkup('{++<?\n\n<?++} {==\n\n==} {~~~>~~}'))
      .toBe('{++<?' + PARA_PLACEHOLDER + '<?++} {==\n\n==} {~~~>~~}');
  });

  test('discovers many same-type and nested-comment openers without suffix rescans', () => {
    for (const marker of ['{++x++}', '{>>x<<}', '{#id>>x<<}']) {
      const input = Array.from({ length: 128_000 }, () => marker).join(' ');
      expect(fastestRun(() => expect(preprocessCriticMarkup(input)).toBe(input))).toBeLessThan(1_000);
    }
  }, 30000);
});

describe('CriticMarkup closers', () => {
  // Each opener's search for its closer read the rest of the text again
  // where none was, so a text of many openers without one took time in the
  // square of their number. The closers are found once each
  const pieces = ['{>>', '<<}', '{#a>>', '{#', '>>', '<<', '{', '}', '{++', '++}', '{~~', '~~}', '~>', '{==', '==}', '--}', 'a', ' ', '-', '\n'];

  test('gives each search the result of indexOf, and of findMatchingClose for a comment', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 40 }), parts => {
      const src = parts.join('');
      const closers = criticCloserSearch(src);
      for (let from = src.length + 1; from >= 0; from--) {
        for (const closer of ['++}', '--}', '~~}', '==}', '<<}', '~>']) {
          expect(closers.next(closer, from)).toBe(src.indexOf(closer, from));
        }
        expect(closers.matching(from)).toBe(findMatchingClose(src, from));
      }
    }), { numRuns: 500 });
  });

  test.each([
    // Codex's: as each top-level span's payload is read
    ['the spans of openers without their closers', (n: number) => 'p {++ a\n\n'.repeat(n) + '{>> b\n\n'.repeat(n),
      (text: string) => expect(criticPayloadRanges(text)).toEqual([])],
    // As an opener at a line's end, which is moved where it has a closer
    ['openers without their closers at a line\'s end', (n: number) => 'p {++\nq\n\n'.repeat(n) + 'p {>>\nq\n\n'.repeat(n),
      (text: string) => expect(preprocessCriticMarkup(text)).toBe(text)],
  ])('reads %s in time linear in their number', (_name, input, read) => {
    const time = (n: number) => {
      const text = input(n);
      return fastestRun(() => read(text));
    };
    time(20000);
    const small = time(20000);
    expect(time(80000) / small).toBeLessThan(8);
  }, 60000);
});

describe('Openers at a line\'s end in a quote', () => {
  // Whether each opener's span is only whitespace once its lines' quote
  // markers are taken off, which leaves the opener where it is
  test('are moved as the reference moves them', () => {
    const lines = ['> p {++', '> p {--', '> {==', '> > p {++', 'p {++', '>', '> >', '> ', '>\t', '  >  >', '', ' \t', '\u00a0', '> q', 'q', '++}', '> ++}', '> > --}', '==}'];
    fc.assert(fc.property(fc.array(fc.constantFrom(...lines), { minLength: 1, maxLength: 12 }), parts => {
      const text = parts.join('\n');
      fc.pre(!hasReferenceHtmlBlock(text));
      expect(preprocessCriticMarkup(text)).toBe(preprocessCriticMarkupReference(text));
    }), { numRuns: 1000 });
    // Whitespace that isn't a space or a tab, and a line with fewer
    // markers than the quote, which keeps the ones it has
    for (const text of ['p {++\n\u00a0\n++}', 'p {++\n\r\n++}', '> > p {++\n> >\n>\n> > ++}', '> > p {++\n> > \u3000\n> > ++}']) {
      expect(preprocessCriticMarkup(text)).toBe(preprocessCriticMarkupReference(text));
    }
  });

  test('that share one closer are read in time linear in their number', () => {
    // The check took the markers off all of the span, to the closer, for
    // each opener
    const input = (n: number) => '> p {++\n> q\n>\n'.repeat(n) + '++}';
    expect(preprocessCriticMarkup(input(3))).toBe(preprocessCriticMarkupReference(input(3)));
    const time = (n: number) => {
      const text = input(n);
      return fastestRun(() => preprocessCriticMarkup(text));
    };
    time(2000);
    const small = time(2000);
    expect(time(8000) / small).toBeLessThan(8);
  }, 60000);
});
