/** Inputs with as many runs, tokens, lines, comments, rows and the like as
 *  `n`, for spread-limit.test.ts, which runs each under Node, the
 *  extension's runtime, where a spread of that many into a call, as
 *  push(...items), overflowed the stack. Each gives a summary of what it
 *  made, by which the test knows it ran to the end. */
import JSZip from 'jszip';
import MarkdownIt from 'markdown-it';
import { convertDocx } from './converter';
import { convertMdToDocx, parseMd } from './md-to-docx';
import { htmlToOoxmlRuns } from './md-to-docx-citations';
import { parseTable } from './formatting';
import { scanOrientationDirectives } from './orientation-scan';
import { formatTableNumbers } from './table-number-format';
import { manuscriptMarkdownPlugin } from './preview/manuscript-markdown-plugin';
import { computeCodeRegions } from './code-regions';
import { dropRangesInCode, extractAllDecorationRanges } from './highlight-colors';

const repeat = (n: number, item: (i: number) => string, separator = '') => Array.from({ length: n }, (_, i) => item(i)).join(separator);
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

async function documentXml(docx: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
}

/** The Markdown Word's document gives back */
async function roundTrip(md: string, alwaysUseCommentIds = false): Promise<string> {
  return (await convertDocx((await convertMdToDocx(md)).docx, undefined, { alwaysUseCommentIds })).markdown;
}

/** The Markdown of Word's document after `edit` changes its XML */
async function editedRoundTrip(md: string, edit: (xml: string) => string, alwaysUseCommentIds = false): Promise<string> {
  const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
  const xml = await zip.file('word/document.xml')!.async('string');
  const edited = edit(xml);
  if (edited === xml) throw new Error('edit changed nothing');
  zip.file('word/document.xml', edited);
  return (await convertDocx(await zip.generateAsync({ type: 'uint8array' }), undefined, { alwaysUseCommentIds })).markdown;
}

const comments = (n: number) => repeat(n, () => 'a{>>c<<} ');
const MATH_FENCE = '$' + '$';

export const SPREAD_LIMIT_CASES: Record<string, (n: number) => Promise<string> | string> = {
  // Export

  'a highlight\'s tokens': n => String(parseMd('==' + '*b* '.repeat(n) + '==\n')[0].runs.length),
  'the paragraphs a revision goes on over': async n =>
    String(count(await documentXml((await convertMdToDocx('{++' + 'a\n\n'.repeat(n) + 'b++}\n')).docx), /<w:p[ >]/g)),
  'a list\'s items': n => String(parseMd('- a\n'.repeat(n)).length),
  'a list item\'s items': n => String(parseMd('- a\n' + '  - b\n'.repeat(n)).length),
  'a quote\'s paragraphs': n => String(parseMd('> a\n>\n'.repeat(n)).length),
  'a paragraph\'s runs': n => String(parseMd('*a* '.repeat(n) + '\n')[0].runs.length),
  'a list item\'s runs': n => String(parseMd('- ' + '*a* '.repeat(n) + '\n')[0].runs.length),
  'a deletion\'s comments': async n =>
    String(count(await documentXml((await convertMdToDocx('{--x {++' + comments(n) + '++}--}\n')).docx), /<w:commentReference /g)),
  'the runs on a line with a comment\'s body': async n =>
    String(count(await documentXml((await convertMdToDocx('{#1}x{/1}{#1>>c<<} ' + '*a* '.repeat(n) + '\n')).docx), /<w:i\/>/g)),
  // Alone, which Word gets nothing of to insert
  'the range markers in an addition with a comment\'s body': async n =>
    String(count(await documentXml((await convertMdToDocx('x {++' + repeat(n, i => '{#' + i + '}{/' + i + '}') + '++} {#1>>c<<}\n')).docx), /<w:commentRangeStart /g)),
  'the warnings of a table\'s numbers': async n =>
    String((await convertMdToDocx('---\ntable-digits: 2\n---\n\n| a |\n|---|\n' + repeat(n, i => '| 1,2,' + i + ' |\n'))).warnings.length),
  'the warnings of a note\'s table\'s numbers': async n =>
    String((await convertMdToDocx('---\ntable-digits: 2\n---\n\nT.[^1]\n\n[^1]: N.\n\n    | a |\n    |---|\n' + repeat(n, i => '    | 1,2,' + i + ' |\n'))).warnings.length),
  // Which export gives once each
  'the warnings of a note': async n => String((await convertMdToDocx('T.[^1]\n\n[^1]: N.\n\n' + '    - # h\n'.repeat(n))).warnings.length),

  // Import

  'a table\'s rows without its grid': async n => {
    const md = await editedRoundTrip('| a |\n|---|\n' + '| b |\n'.repeat(n), xml => xml.replace(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/, ''));
    return String(count(md, /\| b \|/g));
  },
  // URLs whose colons import escapes, so linkify doesn't link them, and
  // which only its search of the Markdown finds, where the tag after each
  // is a token of its own
  'the URLs before an = before a highlight': async n =>
    String(count(await roundTrip('a ' + 'https\\://e.com1.&lt;b> '.repeat(n) + 'x&#61;==b==\n'), /https\\:/g)),
  'the URLs before a scheme whose host is struck': async n =>
    String(count(await roundTrip('https\\://e.com1.&lt;b> '.repeat(n) + 'https\\://~~e.com~~\n'), /https\\:/g)),
  'a document\'s links': async n => String(count(await roundTrip(repeat(n, i => '[a](http://e.com/' + i + ')', ' ') + '\n'), /\]\(http/g)),
  'a pipe table\'s rows': async n => String(count(await roundTrip('| a |\n|---|\n' + '| b |\n'.repeat(n)), /\| b \|/g)),
  'a grid table\'s rows': async n => String(count(await roundTrip('+---+\n| a |\n+===+\n' + '| b |\n+---+\n'.repeat(n)), /\| b +\|/g)),
  // Each column's lines, of which import writes as many as the cell with
  // the most has
  'a grid table\'s columns': async n =>
    String(count(await roundTrip('+' + '---+'.repeat(n) + '\n|' + ' a |'.repeat(n) + '\n+' + '---+'.repeat(n) + '\n'), /\| a/g)),
  // Each formatting what's open in a citation's text, as a style's HTML
  // writes it, sets for the text inside
  'the HTML elements open in a citation\'s text': n => String(count(htmlToOoxmlRuns('<i>'.repeat(n) + 'a' + '</i>'.repeat(n)), /<w:t[ >]/g)),
  'a grid table\'s cell\'s lines': async n => String(count(await roundTrip('+---+\n| a |\n+===+\n' + '| b\\\\ |\n'.repeat(n) + '| c |\n+---+\n'), /\| b/g)),
  'the comments in a pipe table\'s header cell': async n => String(count(await roundTrip('| ' + comments(n) + '|\n|---|\n| b |\n', true), /\{#\d+>>/g)),
  'the comments in a pipe table\'s cell': async n => String(count(await roundTrip('| a |\n|---|\n| ' + comments(n) + '|\n', true), /\{#\d+>>/g)),
  'the comments in a grid table\'s cell': async n => String(count(await roundTrip('+---+\n| a |\n+===+\n| ' + comments(n) + '|\n+---+\n', true), /\{#\d+>>/g)),
  'the comments in an HTML table\'s cell': async n => {
    // Moved into the cell from the paragraph after, as a cell's HTML holds
    // no CriticMarkup, of a table a merged cell keeps HTML
    const md = await editedRoundTrip('<table><tr><td colspan="2">X</td></tr><tr><td>a</td><td>b</td></tr></table>\n\n' + comments(n) + '\n', xml => {
      const paragraph = /<w:p [^>]*>((?:(?!<w:p )[\s\S])*?<w:commentReference [\s\S]*?)<\/w:p>/.exec(xml)!;
      return xml.replace(paragraph[0], '').replace('<w:r><w:t>X</w:t></w:r>', paragraph[1]);
    }, true);
    return String(count(md, /\{#\d+>>/g));
  },
  'the comments before a table\'s directive': async n =>
    String(count(await roundTrip('<!-- c -->\n\n'.repeat(n) + '<!-- table-font: Courier -->\n| a |\n|---|\n| b |\n'), /<!-- c -->/g)),
  'the comments before a tracked paragraph break': async n => String(count(await roundTrip('{--a' + '{>>c<<}'.repeat(n) + '\n\nb--}\n'), /\{>>c<<\}/g)),
  'the comments on an equation text follows': async n =>
    String(count(await roundTrip('a ' + repeat(n, i => '{#' + i + '}') + MATH_FENCE + 'x' + MATH_FENCE + repeat(n, i => '{/' + i + '}') + ' text\n' + repeat(n, i => '{#' + i + '>>c<<}', '\n') + '\n', true), /\{#\d+>>/g)),
  'the comments in a note': async n => String(count(await roundTrip('T.[^1]\n\n[^1]: ' + comments(n) + '\n', true), /\{#\d+>>/g)),
  // Which import reaches the notes they reference by, from the document's
  'the references in a note': async n => String(count(await roundTrip('T.[^a]\n\n[^a]: N' + repeat(n, i => '[^b' + i + ']') + '.\n'
    + repeat(n, i => '\n[^b' + i + ']: B.\n')), /^\[\^[^\]]+\]: /gm)),
  'the comments in a note before its next paragraph': async n => String(count(await roundTrip('T.[^1]\n\n[^1]: ' + comments(n) + '\n\n    b\n', true), /\{#\d+>>/g)),
  'the comments in a note before its code': async n => String(count(await roundTrip('T.[^1]\n\n[^1]: ' + comments(n) + '\n\n    ```\n    x\n    ```\n', true), /\{#\d+>>/g)),
  'the comments in a note before its equation': async n => String(count(await roundTrip('T.[^1]\n\n[^1]: ' + comments(n) + '\n    ' + MATH_FENCE + 'x' + MATH_FENCE + '\n', true), /\{#\d+>>/g)),
  'the comments in a note before its table': async n => String(count(await roundTrip('T.[^1]\n\n[^1]: ' + comments(n) + '\n\n    | a |\n    |---|\n    | b |\n', true), /\{#\d+>>/g)),
  'the comments on an equation in a note': async n =>
    String(count(await roundTrip('T.[^1]\n\n[^1]: a ' + repeat(n, i => '{#' + i + '}') + MATH_FENCE + 'x' + MATH_FENCE + repeat(n, i => '{/' + i + '}') + ' text\n' + repeat(n, i => '    {#' + i + '>>c<<}', '\n') + '\n', true), /\{#\d+>>/g)),

  // The editor and the preview

  'a table\'s rows to reflow': n => String(parseTable('| a |\n|---|\n' + '| b |\n'.repeat(n))?.rows.length),
  'the ranges outside code to decorate': n => {
    const text = '`x`\n\n' + '{++a++} '.repeat(n) + '\n';
    const all = extractAllDecorationRanges(text, 'yellow');
    dropRangesInCode(all, computeCodeRegions(text));
    return String(all.additions.length);
  },
  'the directives in a note': n => String(scanOrientationDirectives('T.[^1]\n\n[^1]: N.\n\n' + '    <!-- landscape -->\n\n'.repeat(n)).length),
  'the numbers in an HTML table\'s cell': n =>
    String(count(formatTableNumbers('<table><tr><td>' + '1000.5 '.repeat(n) + '</td></tr></table>\n', { digits: 2 }).output, /1000\.50/g)),
  // Which close inside the one the strong emphasis ends, and open again
  // after it
  'the elements open where an element ends in the preview': n => {
    const md = new MarkdownIt({ html: true });
    md.use(manuscriptMarkdownPlugin);
    return String(count(md.render('**a ' + '<sup>'.repeat(n) + 'b** c\n'), /<sup>/g));
  },
  'the alerts in a quote\'s paragraph': n => {
    const md = new MarkdownIt();
    md.use(manuscriptMarkdownPlugin);
    return String(count(md.render('> [!NOTE]\n' + '> [!TIP]\n> a\n'.repeat(n)), /<blockquote/g));
  },
};
