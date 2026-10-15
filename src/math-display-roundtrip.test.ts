import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { join } from 'node:path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';
import { roundTrip, parserOptions } from './test-omml-helpers';
import { xmlParser } from './xml-parser';

const repoRoot = join(__dirname, '..');

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function displayMathBodies(md: string): string[] {
  const bodies: string[] = [];
  const re = /\$\$\n([\s\S]*?)\n\$\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

describe('latexToOmml: multi-line arguments and labeled braces', () => {
  it('binds a brace group after a newline as the next command argument', () => {
    const omml = latexToOmml('\\frac{\\text{a}}\n{\\text{b}}');
    expect(omml).toContain('<m:den><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>b</m:t></m:r></m:den>');
    expect(omml).not.toContain('<m:den></m:den>');
  });

  it('binds a brace group after spaces as the next command argument', () => {
    const omml = latexToOmml('\\frac{a}  {b}');
    expect(omml).toContain('<m:den><m:r><m:t>b</m:t></m:r></m:den>');
  });

  it('renders \\underbrace{x}_{label} as m:limLow around the brace', () => {
    const omml = latexToOmml('\\underbrace{x}_{\\text{label}}');
    expect(omml).toContain('<m:limLow>');
    expect(omml).toContain('<m:groupChr>');
    expect(omml).toContain('<m:chr m:val="⏟"/>');
    expect(omml).toContain('<m:lim><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>label</m:t></m:r></m:lim>');
    // The brace must be inside the limLow base, not the other way around
    expect(omml.indexOf('<m:limLow>')).toBeLessThan(omml.indexOf('<m:groupChr>'));
    expect(omml).not.toContain('<m:sSub>');
  });

  it('renders \\overbrace{x}^{label} as m:limUpp around the brace', () => {
    const omml = latexToOmml('\\overbrace{x+y}^{\\text{sum}}');
    expect(omml).toContain('<m:limUpp>');
    expect(omml).toContain('<m:chr m:val="⏞"/>');
    expect(omml.indexOf('<m:limUpp>')).toBeLessThan(omml.indexOf('<m:groupChr>'));
    expect(omml).not.toContain('<m:sSup>');
  });

  it('leaves unlabeled braces as plain m:groupChr', () => {
    expect(latexToOmml('\\underbrace{x+y}')).not.toContain('<m:limLow>');
    expect(latexToOmml('\\overbrace{x+y}')).not.toContain('<m:limUpp>');
  });

  it('still emits sSup for \\underbrace{x}^{y} (mismatched script)', () => {
    const omml = latexToOmml('\\underbrace{x}^{y}');
    expect(omml).toContain('<m:sSup>');
    expect(omml).not.toContain('<m:limLow>');
  });

  it('recognizes the brace label across whitespace before the script operator', () => {
    const under = latexToOmml('\\underbrace{x} _{a}');
    expect(under).toContain('<m:limLow>');
    expect(under).not.toContain('<m:sSub>');
    const over = latexToOmml('\\overbrace{x}\n^{a}');
    expect(over).toContain('<m:limUpp>');
    expect(over).not.toContain('<m:sSup>');
  });
});

describe('ommlToLatex: labeled braces and \\text{} preservation', () => {
  it('round-trips \\underbrace{x}_{label}', () => {
    const latex = roundTrip('\\underbrace{x}_{\\text{share at risk}}');
    expect(latex).toBe('\\underbrace{x}_{\\text{share at risk}}');
  });

  it('round-trips \\overbrace{x}^{label}', () => {
    // Whitespace-free \text{} normalizes to \mathrm{} (renders identically)
    const latex = roundTrip('\\overbrace{x+y}^{\\text{sum}}');
    expect(latex).toBe('\\overbrace{x+y}^{\\mathrm{sum}}');
    const multiWord = roundTrip('\\overbrace{x+y}^{\\text{the sum}}');
    expect(multiWord).toBe('\\overbrace{x+y}^{\\text{the sum}}');
  });

  it('keeps \\underset/\\overset for non-brace bases', () => {
    const under = roundTrip('\\underset{a}{X}');
    expect(under).toBe('\\underset{a}{X}');
    const over = roundTrip('\\overset{a}{X}');
    expect(over).toBe('\\overset{a}{X}');
  });

  it('emits \\text{} for plain-style runs containing spaces', () => {
    const latex = roundTrip('\\text{women aged 15–49}');
    expect(latex).toBe('\\text{women aged 15–49}');
  });

  it('keeps \\mathrm{} for plain-style runs without spaces', () => {
    const latex = roundTrip('\\mathrm{UPR}');
    expect(latex).toBe('\\mathrm{UPR}');
  });

  it('still recognizes known functions whose name is a \\text run', () => {
    const latex = roundTrip('\\sin{x}');
    expect(latex).toBe('\\sin{x}');
  });

  it('does not emit \\text{} for synthetic command-separator spaces (αx)', () => {
    // αx needs a separator after \alpha; that is not prose whitespace, so
    // \mathrm{} must be kept. Inside the group the separator is {}, since a
    // space there would re-export as a space.
    const omml =
      '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>αx</m:t></m:r>';
    const parsed = xmlParser(parserOptions).parse('<m:oMath>' + omml + '</m:oMath>');
    expect(ommlToLatex(parsed[0]['m:oMath'])).toBe('\\mathrm{\\alpha{}x}');
  });

  it('does not rewrite limLow/limUpp as braces when chr or pos mismatches', () => {
    const parse = (xml: string) => {
      const parsed = xmlParser(parserOptions).parse('<m:oMath>' + xml + '</m:oMath>');
      return ommlToLatex(parsed[0]['m:oMath']);
    };
    // Underbrace chr but top position: not a labeled underbrace
    const mismatchedPos =
      '<m:limLow><m:e><m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="top"/></m:groupChrPr>' +
      '<m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:e><m:lim><m:r><m:t>n</m:t></m:r></m:lim></m:limLow>';
    expect(parse(mismatchedPos)).toBe('\\underset{n}{\\underbrace{x}}');
    // Bottom position but non-brace character: not a labeled overbrace
    const mismatchedChr =
      '<m:limUpp><m:e><m:groupChr><m:groupChrPr><m:chr m:val="⏜"/><m:pos m:val="top"/></m:groupChrPr>' +
      '<m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:e><m:lim><m:r><m:t>a</m:t></m:r></m:lim></m:limUpp>';
    expect(parse(mismatchedChr)).toContain('\\overset{a}{');
  });
});

describe('counterfactuals fixture round-trip', () => {
  it('md→docx→md preserves display math structure', async () => {
    const md = readFileSync(join(repoRoot, 'test/fixtures/counterfactuals.md'), 'utf8');
    const { docx, warnings } = await convertMdToDocx(md);
    expect(warnings).toEqual([]);

    const rt = await convertDocx(docx);
    const body = stripFrontmatter(rt.markdown);

    const blocks = displayMathBodies(body);
    expect(blocks.length).toBe(3);

    // Block 1: simple fraction — denominator must survive the line-wrapped source
    expect(blocks[0]).toContain('\\frac{\\text{unintended pregnancies}}{\\text{women aged 15–49}}');
    expect(blocks[0]).toContain('\\times 1000');

    // Block 2: both labeled underbraces with fractions inside
    expect(blocks[1]).toContain(
      '\\underbrace{\\frac{\\text{women who want to avoid pregnancy}}{\\text{women aged 15–49}}}_{\\text{share at risk}}'
    );
    expect(blocks[1]).toContain('_{\\text{conditional UPR}}');
    expect(blocks[1]).not.toContain('{}');

    // Block 3: text terms keep interior spaces
    expect(blocks[2]).toContain('\\text{share at risk} \\times \\text{conditional UPR}');
    // Single-word \text{abortions} normalizes to \mathrm{abortions} (renders identically)
    expect(blocks[2]).toContain('\\frac{\\mathrm{abortions}}{\\text{unintended pregnancies}}');

    // No empty fraction parts or unsupported placeholders anywhere
    expect(body).not.toContain('UNSUPPORTED');

    // Prose must survive intact
    expect(body).toContain('## How to read the counterfactuals');
    expect(body).toContain('**only one**');
    expect(body).toContain('*who want to avoid becoming pregnant*');
  });

  it('round-tripped markdown converts to docx again without warnings (second pass stability)', async () => {
    const md = readFileSync(join(repoRoot, 'test/fixtures/counterfactuals.md'), 'utf8');
    const first = await convertMdToDocx(md);
    const rt1 = await convertDocx(first.docx);
    const second = await convertMdToDocx(stripFrontmatter(rt1.markdown));
    expect(second.warnings).toEqual([]);
    const rt2 = await convertDocx(second.docx);
    // Math must be stable after the first round-trip normalizes formatting
    expect(displayMathBodies(stripFrontmatter(rt2.markdown))).toEqual(
      displayMathBodies(stripFrontmatter(rt1.markdown))
    );
  });
});

// Export gives Word display math in a heading in the heading's paragraph,
// but import wrote it after the heading, on lines of its own, as a heading
// can't go on past its line, so the next export gave Word an empty heading
// and the equation in a paragraph of its own. An equation that's all of its
// heading goes on the heading's line; any other goes after it, as before
describe('display math in a heading', () => {
  const fence = '$'.repeat(2);
  const roundTrip = async (md: string) => stripFrontmatter((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  // Each of Word's paragraphs, by its style and its text, with each display
  // equation as [equation] and each inline one as [math]
  const paragraphs = async (md: string) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(p => {
      const marked = p.replace(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/g, '<w:t>[equation]</w:t>').replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '<w:t>[math]</w:t>');
      return (/<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? '') + ': ' + [...marked.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
    });
  };

  it.each([
    ['alone', '# ' + fence + 'x' + fence + '\n', ['Heading1: [equation]']],
    ['of the second level', '## ' + fence + 'x' + fence + '\n', ['Heading2: [equation]']],
    ['in a heading between paragraphs', 'A.\n\n# ' + fence + 'x' + fence + '\n\nB.\n', [': A.', 'Heading1: [equation]', ': B.']],
    // Import writes the line ends of its rows as spaces
    ['of an environment\'s rows', '# ' + fence + '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}' + fence + '\n', ['Heading1: [equation]']],
    ['with a tracked change in it', '# ' + fence + '{++x++}' + fence + '\n', ['Heading1: [equation]']],
    // As before
    ['as inline math', '# a $x$ b\n', ['Heading1: a [math] b']],
  ])('keeps an equation in the heading: %s', async (_name, md, expected) => {
    const once = await paragraphs(md);
    expect(once).toEqual(expected);
    const back = await roundTrip(md);
    expect(back).toBe(md);
    expect(await paragraphs(back)).toEqual(once);
    expect(await roundTrip(back)).toBe(back);
  });

  // Export writes no heading in a list item, so the equation goes on in the
  // item's text, as before
  it('keeps the paragraphs of a heading in a list item', async () => {
    const md = '- # a ' + fence + 'x' + fence + ' b\n';
    const once = await paragraphs(md);
    expect(once).toHaveLength(1);
    expect(once[0]).toEndWith('a [equation] b');
    const back = await roundTrip(md);
    expect(back).toBe('- a\n  ' + fence + '\n  x\n  ' + fence + '&#32;b\n');
    expect(await paragraphs(back)).toEqual(once);
    expect(await roundTrip(back)).toBe(back);
  });

  /** A document from Word, `md`'s with its XML changed by `change` */
  const fromWord = async (md: string, change: (xml: string) => string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    zip.file('word/document.xml', change(await zip.file('word/document.xml')!.async('string')));
    return stripFrontmatter((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  const equation = '<m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>';
  const bold = /<w:r><w:rPr><w:b\/>(?:(?!<\/w:r>).)*XX<\/w:t><\/w:r>/;
  const after = fence + '\nx\n' + fence + '\n';

  // Any other goes after the heading, on lines of its own, as on main: one
  // beside an equation or text, whose $, \ or HTML tag would run into its
  // fences, one with a $ in its LaTeX, beside which a preview may read no
  // fence, a highlighted one, and one Word has after the heading
  it.each([
    ['right after an inline equation', () => fromWord('# $y$**XX**\n', xml => xml.replace(bold, () => equation)), '# $y$\n\n' + after],
    ['Word has outside the heading\'s paragraph', () => fromWord('# H\n', xml => xml.replace(/(<w:p[ >](?:(?!<\/w:p>)[\s\S])*?Heading1[\s\S]*?<\/w:p>)/, (_match, heading: string) => heading + equation)), '# H\n\n' + after],
    ['that\'s highlighted', () => roundTrip('# ==' + fence + 'x' + fence + '=={red}\n'), '# \n\n{====' + fence + '\nx\n' + fence + '=={red}==}\n'],
    // Two display equations' fences side by side, as $$x$$$$y$$, which a
    // preview may not read
    ['right beside another display equation', () => fromWord('# **XX**\n', xml => xml.replace(bold, () => equation + equation.replace('>x<', '>y<'))), '# \n\n' + after + fence + '\ny\n' + fence + '\n'],
    ['right after a dollar sign', () => fromWord('# Price \\$**XX**\n', xml => xml.replace(bold, () => equation)), '# Price $\n\n' + after],
    ['right after a backslash', () => fromWord('# Price \\\\**XX**\n', xml => xml.replace(bold, () => equation)), '# Price \\\\\n\n' + after],
    ['with text right after it', () => fromWord('# **XX**b\n', xml => xml.replace(bold, () => equation)), '# \n\n' + fence + '\nx\n' + fence + 'b\n'],
    ['with \\$ in it', () => roundTrip('# ' + fence + 'a\\$b' + fence + '\n'), '# \n\n' + fence + '\na\\$b\n' + fence + '\n'],
    ['ending in \\$', () => roundTrip('# ' + fence + 'x\\$ ' + fence + '\n'), '# \n\n' + fence + '\nx\\$\n' + fence + '\n'],
    // Its line ends, which a space can't take the place of in text
    ['holding an upright run over lines', () => fromWord('# **XX**\n', xml => xml.replace(bold, () => equation.replace('<m:r><m:t>x</m:t></m:r>', '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">a\n  b</m:t></m:r>'))),
      '# \n\n' + fence + '\n\\text{a\n  b}\n' + fence + '\n'],
  ])('keeps an equation %s out of the heading\'s line', async (_name, imported, expected) => {
    const back = await imported();
    expect(back).toBe(expected);
    expect(await roundTrip(back)).toBe(back);
    expect(await paragraphs(await roundTrip(back))).toEqual(await paragraphs(back));
  });

  // Which Markdown reads as a line end, so on the heading's line it ended
  // the heading in the equation. After the heading, import writes it as it
  // is, and export reads it as a line end, as on main, so it comes back
  // once as one
  it.each([
    ['a carriage return', 'x&#13;y', 'x\ry'],
    ['a carriage return and a line feed', 'x&#13;&#10;y', 'x\r\ny'],
  ])('keeps an equation holding %s out of the heading\'s line', async (_name, text, latex) => {
    const back = await fromWord('# **XX**\n', xml => xml.replace(bold, () => equation.replace('>x<', '>' + text + '<')));
    expect(back).toBe('# \n\n' + fence + '\n' + latex + '\n' + fence + '\n');
    const next = await roundTrip(back);
    expect(next).toBe('# \n\n' + fence + '\nx\ny\n' + fence + '\n');
    expect(await roundTrip(next)).toBe(next);
    expect(await paragraphs(next)).toEqual(await paragraphs(back));
    expect(await paragraphs(await roundTrip(next))).toEqual(await paragraphs(back));
  });

  // Main's form for an equation after text, whose space the next import
  // trims at the heading's end. Beside the text, <a title= $$a>b$$ would
  // read as an HTML tag, and the next export would write the fences as text
  it.each([
    ['after text', () => roundTrip('## a ' + fence + 'x' + fence + ' b\n'), '## a ', '\n\n' + fence + '\nx\n' + fence + '&#32;b\n'],
    ['after text that opens an HTML tag', () => fromWord('# &lt;a title= **XX**\n', xml => xml.replace(bold, () => equation.replace('>x<', '>a&gt;b<'))), '# <a title= ', '\n\n' + fence + '\na>b\n' + fence + '\n'],
  ])('writes an equation %s after the heading, as on main', async (_name, imported, heading, rest) => {
    const back = await imported();
    expect(back).toBe(heading + rest);
    const next = await roundTrip(back);
    expect(next).toBe(heading.trimEnd() + rest);
    expect(await roundTrip(next)).toBe(next);
    expect(await paragraphs(next)).toEqual(await paragraphs(back));
    expect(await paragraphs(await roundTrip(next))).toEqual(await paragraphs(back));
  });
});

// A display equation in a tracked change, in a paragraph with text around
// it, came back in its paragraph, as a\n{++...++}&#32;b., which export split
// into three paragraphs, the text before, the equation and the text after,
// as it gave any span of display math a paragraph of its own. A highlight
// on one there came back without it, as {==...==} would have split it too
describe('a tracked display equation in its paragraph', () => {
  const fence = '$'.repeat(2);
  const roundTrip = async (md: string) => stripFrontmatter((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  // Each of Word's paragraphs, by its style and its text, with each display
  // equation as [equation], or [highlighted equation], each inline one as
  // [math], an insertion as {+...+}, a deletion as {-...-} and a comment's
  // range as {c...c}
  const paragraphs = async (md: string) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:sectPr'));
    return (body.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(p => (/<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? '') + ': ' + p
      .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '')
      .replace(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/g, m => /<w:highlight /.test(m) ? '[highlighted equation]' : '[equation]')
      .replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '[math]')
      .replace(/<w:ins [^>]*>/g, '{+').replace(/<\/w:ins>/g, '+}').replace(/<w:del [^>]*>/g, '{-').replace(/<\/w:del>/g, '-}')
      .replace(/<w:commentRangeStart [^>]*>/g, '{c').replace(/<w:commentRangeEnd [^>]*>/g, 'c}')
      .replace(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g, '$1').replace(/<w:br\/>/g, '<br>')
      .replace(/<[^>]+>/g, ''));
  };
  /** The Markdown import writes for a document from Word, `md`'s with the
   *  run `target` matches put in place of `runs` */
  const fromWord = async (md: string, target: RegExp, runs: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toMatch(target);
    zip.file('word/document.xml', xml.replace(target, () => runs));
    return stripFrontmatter((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  const bold = /<w:r><w:rPr><w:b\/>(?:(?!<\/w:r>).)*XX<\/w:t><\/w:r>/;
  // The text a comment's range holds, as export writes {==XX==}{>>c<<}
  const commented = /<w:r><w:t>XX<\/w:t><\/w:r>/;
  const equation = (latex: string, rPr = '') => '<m:oMathPara><m:oMath><m:r>' + rPr + '<m:t>' + latex + '</m:t></m:r></m:oMath></m:oMathPara>';
  const highlighted = equation('x', '<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
  const inserted = (runs: string) => '<w:ins w:id="91" w:author="A" w:date="2024-01-01T00:00:00Z">' + runs + '</w:ins>';
  const deleted = (runs: string) => '<w:del w:id="92" w:author="A" w:date="2024-01-01T00:00:00Z">' + runs + '</w:del>';
  const x = fence + '\nx\n' + fence;
  const z = fence + '\nz\n' + fence;
  /** `md` with `prefix` on each line after its first, as a quote's */
  const within = (prefix: string, md: string) => md.replace(/\n(?=.)/g, '\n' + prefix);

  /** `md`, which import wrote, keeps Word's `paras` and stays the same over two trips */
  const keeps = async (md: string, paras: string[]) => {
    expect(await paragraphs(md)).toEqual(paras);
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await paragraphs(once)).toEqual(paras);
    expect(await roundTrip(once)).toBe(once);
  };

  it.each([
    ['an insertion', 'a **XX** b.\n', bold, inserted(equation('x')), 'a\n{++' + x + '++}&#32;b.\n', [': a {+[equation]+} b.']],
    ['a deletion', 'a **XX** b.\n', bold, deleted(equation('x')), 'a\n{--' + x + '--}&#32;b.\n', [': a {-[equation]-} b.']],
    // A deletion and an insertion, which import writes on lines of their own,
    // as two equations, whose line end export reads as a space between them
    ['a substitution', 'a **XX** b.\n', bold, deleted(equation('x')) + inserted(equation('z')), 'a\n{--' + x + '--}\n{++' + z + '++}&#32;b.\n',
      [': a {-[equation]-} {+[equation]+} b.']],
    ['a highlight', 'a **XX** b.\n', bold, highlighted, 'a\n{==' + x + '==}&#32;b.\n', [': a [highlighted equation] b.']],
    ['an insertion, with inline math after it', 'a **XX** b.\n', bold, inserted(equation('x')) + '<m:oMath><m:r><m:t>y</m:t></m:r></m:oMath>',
      'a\n{++' + x + '++}$y$ b.\n', [': a {+[equation]+}[math] b.']],
    // The span's lines after the first without the item's indent, as import
    // writes a span's lines in a list item
    ['an insertion, in a list item', '- a **XX** b.\n', bold, inserted(equation('x')), '- a\n  {++' + x + '++}&#32;b.\n', [': a {+[equation]+} b.']],
    ['a highlight, in a list item', '- a **XX** b.\n', bold, highlighted, '- a\n  {==' + x + '==}&#32;b.\n', [': a [highlighted equation] b.']],
    ['an insertion, in a quote', '> a **XX** b.\n', bold, inserted(equation('x')), '> ' + within('> ', 'a\n{++' + x + '++}&#32;b.\n'),
      [': ', 'GitHubBlockquote: a {+[equation]+} b.', ': ']],
    ['a deletion, in a quote', '> a **XX** b.\n', bold, deleted(equation('x')), '> ' + within('> ', 'a\n{--' + x + '--}&#32;b.\n'),
      [': ', 'GitHubBlockquote: a {-[equation]-} b.', ': ']],
    ['a highlight, in a quote', '> a **XX** b.\n', bold, highlighted, '> ' + within('> ', 'a\n{==' + x + '==}&#32;b.\n'),
      [': ', 'GitHubBlockquote: a [highlighted equation] b.', ': ']],
  ])('from Word, a display equation in %s stays in its paragraph', async (_name, md, target, runs, expected, paras) => {
    const back = await fromWord(md, target, runs);
    expect(back).toBe(expected);
    await keeps(back, paras);
  });

  // A comment on one, which import writes in IDs, with its body after the
  // paragraph. Export split one written as {==...==}{>>...<<} in the
  // paragraph too
  it('a comment on one in its paragraph stays in it', async () => {
    const md = 'a\n{==' + x + '==}{>>c<<}&#32;b.\n';
    const paras = [': a {c[equation]c} b.'];
    expect(await paragraphs(md)).toEqual(paras);
    const back = await roundTrip(md);
    expect(back).toBe('a\n{#1}' + x + '{/1}&#32;b.\n{#1>>c<<}\n');
    await keeps(back, paras);
  });

  // As before: one alone in its paragraph, an equation in no change in its
  // paragraph, a comment on one from Word in its paragraph, and one in a
  // heading's text, which goes after the heading, as a heading can't go on
  // past its line, as export splits it
  it.each([
    ['an insertion alone in its paragraph', '**XX**\n', bold, inserted(equation('x')), '{++' + x + '++}\n', [': {+[equation]+}']],
    ['a deletion alone in its paragraph', '**XX**\n', bold, deleted(equation('x')), '{--' + x + '--}\n', [': {-[equation]-}']],
    ['no change, in a paragraph', 'a **XX** b.\n', bold, equation('x'), 'a\n' + x + '&#32;b.\n', [': a [equation] b.']],
    ['a comment, in a paragraph', 'a {==XX==}{>>c<<} b.\n', commented, equation('x'), 'a\n{#1}' + x + '{/1}&#32;b.\n{#1>>c<<}\n', [': a {c[equation]c} b.']],
  ])('from Word, %s comes back as before', async (_name, md, target, runs, expected, paras) => {
    const back = await fromWord(md, target, runs);
    expect(back).toBe(expected);
    await keeps(back, paras);
  });

  it('one in a heading\'s text still goes after the heading', async () => {
    const md = '# a {++' + fence + 'x' + fence + '++} b\n';
    expect(await paragraphs(md)).toEqual(['Heading1: a ', ': {+[equation]+}', ':  b']);
    const back = await roundTrip(md);
    expect(back).toBe('# a\n\n{++' + x + '++}\n\n&#32;b\n');
    expect(await roundTrip(back)).toBe(back);
  });

  // A highlight on one with a comment right after it, a point comment, as
  // before, without the highlight, as {==...==}{>>...<<} would put the
  // comment over the equation; and with a comment over it, in IDs, which
  // the highlight doesn't go in, as before
  const point = /<w:r><w:rPr><w:b\/>(?:(?!<\/w:r>).)*XX<\/w:t><\/w:r>(?=<w:commentRangeStart)/;
  it.each([
    ['a point comment after a highlight on one', 'a **XX**{>>c<<} b.\n', point, highlighted, 'a\n' + x + '{>>c<<} b.\n',
      [': a [highlighted equation]{cc} b.'], [': a [equation]{cc} b.']],
    ['a point comment after a highlight on one alone in its paragraph', '**XX**{>>c<<}\n', point, highlighted, x + '{>>c<<}\n',
      [': [highlighted equation]{cc}'], [': [equation]{cc}']],
    ['a comment over a highlight on one', 'a {==XX==}{>>c<<} b.\n', commented, highlighted, 'a\n{#1}' + x + '{/1}&#32;b.\n{#1>>c<<}\n',
      [': a {c[highlighted equation]c} b.'], [': a {c[equation]c} b.']],
  ])('from Word, %s comes back as before', async (_name, md, target, runs, expected, before, paras) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toMatch(target);
    zip.file('word/document.xml', xml.replace(target, () => runs));
    const docx = await zip.generateAsync({ type: 'uint8array' });
    const back = stripFrontmatter((await convertDocx(docx)).markdown);
    expect(back).toBe(expected);
    await keeps(back, paras);
    expect(paras).not.toEqual(before);
  });

  it('a point comment after a highlight on one in a note stays after it', async () => {
    const md = 'Text.[^1]\n\n[^1]: a ==' + fence + 'x' + fence + '=={>>c<<} b.\n';
    const back = await roundTrip(md);
    expect(back).toBe('Text.[^1]\n\n[^1]:\n\n    a\n    ' + fence + '\n    x\n    ' + fence + '{>>c<<} b.\n');
    expect(await roundTrip(back)).toBe(back);
    const notes = await (await JSZip.loadAsync((await convertMdToDocx(back)).docx)).file('word/footnotes.xml')!.async('string');
    expect(notes).toMatch(/<w:commentRangeStart w:id="(\d+)"\/><w:commentRangeEnd w:id="\1"\/>/);
  });

  // A comment that doesn't start right after the fence, as one in a block
  // after the equation's, or over an equation after it in its paragraph,
  // which goes on the next line in IDs, keeps the highlight
  const start = '<w:commentRangeStart w:id="0"/>';
  const end = '<w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>';
  const paragraph = (runs: string) => '<w:p>' + runs + '</w:p>';
  it.each([
    // Word's equations at the body's level, outside any paragraph
    ['a comment on the next equation, in a block of its own', highlighted + start + equation('z') + end,
      '{==' + x + '==}\n\n{#1}' + z + '{/1}\n{#1>>c<<}\n', [': [highlighted equation]', ': {c[equation]c}']],
    ['a point comment at the next paragraph\'s start', highlighted + paragraph(start + end + '<w:r><w:t>b</w:t></w:r>'),
      '{==' + x + '==}\n\n{>>c<<}b\n', [': [highlighted equation]', ': {cc}b']],
    ['a point comment at the next paragraph\'s start, after one in a paragraph',
      paragraph('<w:r><w:t xml:space="preserve">a </w:t></w:r>' + highlighted) + paragraph(start + end + '<w:r><w:t>b</w:t></w:r>'),
      'a\n{==' + x + '==}\n\n{>>c<<}b\n', [': a [highlighted equation]', ': {cc}b']],
    ['a comment on the next equation in its paragraph',
      paragraph('<w:r><w:t xml:space="preserve">a </w:t></w:r>' + highlighted + start + equation('z') + end + '<w:r><w:t xml:space="preserve"> b</w:t></w:r>'),
      'a\n{==' + x + '==}\n{#1}' + z + '{/1}&#32;b\n{#1>>c<<}\n', [': a [highlighted equation] {c[equation]c} b']],
  ])('from Word, a highlight on one before %s stays', async (_name, body, expected, paras) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx('a{>>c<<}\n')).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/(<w:body>)[\s\S]*?(<w:sectPr)/, (_m, open: string, close: string) => open + body + close));
    const back = stripFrontmatter((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
    expect(back).toBe(expected);
    await keeps(back, paras);
  });

  // A span with a blank line, a paragraph break, between equations, which
  // go in paragraphs of their own either side of it, as before
  it.each([
    ['a highlight', '{==', '==}', ': [highlighted equation]'],
    ['an insertion', '{++', '++}', ': {+[equation]+}'],
    ['a deletion', '{--', '--}', ': {-[equation]-}'],
  ])('%s of equations with a paragraph break between them keeps the break', async (_name, open, close, para) => {
    const md = open + fence + 'x' + fence + '\n\n' + fence + 'z' + fence + close + '\n';
    expect(await paragraphs(md)).toEqual([para, para]);
    const back = await roundTrip(md);
    expect(back).toBe(open + x + close + '\n\n' + open + z + close + '\n');
    await keeps(back, [para, para]);
  });

  it.each([
    ['in a list item', '- {==' + fence + 'x' + fence + '\n\n  ' + fence + 'z' + fence + '==}\n'],
    ['in a quote', '> {==' + fence + 'x' + fence + '\n>\n> ' + fence + 'z' + fence + '==}\n'],
  ])('a highlight of equations with a paragraph break between them %s keeps the break', async (_name, md) => {
    const paras = (await paragraphs(md)).filter(para => para.includes('equation'));
    expect(paras).toEqual([expect.stringContaining('[highlighted equation]'), expect.stringContaining('[highlighted equation]')]);
    const back = await roundTrip(md);
    expect((await paragraphs(back)).filter(para => para.includes('equation'))).toEqual(paras);
    expect(await roundTrip(back)).toBe(back);
  });

  // With its sides' empty spans in each paragraph, as before
  it('a substitution of equations with a paragraph break between them keeps the break', async () => {
    const md = '{~~' + fence + 'x' + fence + '\n\n' + fence + 'z' + fence + '~>c~~}\n';
    expect(await paragraphs(md)).toEqual([': {-[equation]-}{++}', ': {-[equation]-}{++}', ': {--}{+c+}']);
    const paras = [': {-[equation]-}', ': {-[equation]-}', ': {+c+}'];
    const back = await roundTrip(md);
    expect(back).toBe('{--' + x + '--}\n\n{--' + z + '--}\n\n{++c++}\n');
    await keeps(back, paras);
  });
});

// An environment with no OMML form showed its \begin as text and lost its
// \end, and its argument's braces, so it came back as LaTeX that doesn't parse
describe('environments with no OMML form', () => {
  const fence = '$'.repeat(2);
  const roundTrip = async (md: string) => stripFrontmatter((await convertDocx((await convertMdToDocx(md)).docx)).markdown).trim();
  const equations = async (md: string) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    return xml.match(/<m:oMath>[\s\S]*?<\/m:oMath>/g) ?? [];
  };
  const wordText = (omml: string[]) => omml.map(math => [...math.matchAll(/<m:t[^>]*>([^<]*)<\/m:t>/g)].map(m => m[1]).join('')).join('');

  it.each([
    ['array', fence + '\n\\begin{array}{c|c} a & b \\\\ c & d \\end{array}\n' + fence],
    ['eqnarray', fence + '\n\\begin{eqnarray} a &=& b \\end{eqnarray}\n' + fence],
    ['dcases', fence + '\nf(x) = \\begin{dcases} 1 & x > 0 \\\\ 0 & x \\leq 0 \\end{dcases}\n' + fence],
    ['rcases', fence + '\n\\begin{rcases} a & b \\end{rcases}\n' + fence],
    ['subarray', 'A $\\sum_{\\begin{subarray}{c} i \\\\ j \\end{subarray}}x$ C.'],
    ['alignedat', fence + '\n\\begin{alignedat}{2} a &= b \\end{alignedat}\n' + fence],
    ['CD', fence + '\n\\begin{CD} A @>>> B \\end{CD}\n' + fence],
    ['array in an inline equation', 'A $\\begin{array}{c} a \\end{array} + 1$ C.'],
    ['array in a row of aligned', fence + '\n\\begin{aligned}\nx &= \\begin{array}{c} a \\end{array} \\\\\ny &= c\n\\end{aligned}\n' + fence],
    ['array with its argument after a space', 'A $\\begin{array} {c} a \\end{array}$ C.'],
    ['array in a deletion', 'A ${--\\begin{array}{c} a \\end{array}--} + 1$ C.'],
    ['an \\end{array} alone', 'A $a \\end{array} + 1$ C.'],
  ])('keeps %s as written', async (_name, md) => {
    const omml = await equations(md);
    for (const end of md.match(/\\end\{(?!aligned)[^}]*\}/g) ?? []) expect(wordText(omml)).toContain(end);
    const back = await roundTrip(md);
    expect(back).toBe(md);
    expect(await equations(back)).toEqual(omml);
    expect(await roundTrip(back)).toBe(back);
  });

  // An argument whose tokens aren't its source reads as before, as math, so
  // a comment in it stays hidden and a \relax between + and + keeps them
  // apart, with the \end kept
  it.each([
    ['a comment', fence + '\n\\begin{array}{c%\n} a \\end{array}\n' + fence, fence + '\n\\begin{array}c%\n a \\end{array}\n' + fence],
    ['a comment with text', fence + '\n\\begin{array}{c% cols\n} a \\end{array}\n' + fence, fence + '\n\\begin{array}c% cols\n a \\end{array}\n' + fence],
    ['+\\relax+', 'A $\\begin{array}{@{+\\relax+}c@{+\\relax+}} a \\end{array}$ C.', 'A $\\begin{array}@++c@++ a \\end{array}$ C.'],
    ['a \\relax at its end', 'A $\\begin{array}{c\\relax} a \\end{array}$ C.', 'A $\\begin{array}c a \\end{array}$ C.'],
  ])('reads an argument with %s as before, keeping the \\end', async (_name, md, expected) => {
    const omml = await equations(md);
    expect(wordText(omml)).toContain('\\end{array}');
    expect(wordText(omml)).not.toContain('\\begin{array}{');
    const back = await roundTrip(md);
    expect(back).toBe(expected);
    expect(await equations(back)).toEqual(omml);
    expect(await roundTrip(back)).toBe(back);
  });

  // With no \end of its own, an environment is read as before, as its
  // \begin and then math, so it takes no row or \end of one around it,
  // which a known environment's rows came back with
  it.each([
    ['in an inline equation', 'A $\\begin{array}{c} a$ C.', 'A $\\begin{array}c a$ C.'],
    ['in a row of aligned', fence + '\n\\begin{aligned}\nx &= \\begin{array}{c} a \\\\\ny &= c\n\\end{aligned}\n' + fence, fence + '\n\\begin{aligned}\nx &= \\begin{array}c a \\\\\ny &= c\n\\end{aligned}\n' + fence],
  ])('reads an environment with no \\end %s as before', async (_name, md, expected) => {
    const back = await roundTrip(md);
    expect(back).toBe(expected);
    expect(await equations(back)).toEqual(await equations(md));
    expect(await roundTrip(back)).toBe(back);
  });

  // Rejecting the insertion leaves the array with no \end, so that view is
  // read as before, and aligned keeps its rows and its one \end in both. It
  // comes back as a substitution of the whole equation, as before. Its sides
  // gained a blank line each on each trip, from the line ends of the fences
  // export wrote into Word, which it no longer does
  it('keeps the rows of aligned around an array whose \\end is inserted', async () => {
    const md = fence + '\n\\begin{aligned}\nx &= \\begin{array}{c} a {++\\end{array}++} \\\\\ny &= c\n\\end{aligned}\n' + fence;
    const expected = fence + '\n{~~\\begin{aligned} x &= \\begin{array}c a \\\\ y &= c \\end{aligned}' +
      '~>\\begin{aligned} x &= \\begin{array}{c} a \\end{array} \\\\ y &= c \\end{aligned}~~}\n' + fence;
    let back = md;
    for (let trip = 1; trip <= 3; trip++) {
      back = await roundTrip(back);
      expect(back).toBe(expected);
    }
  });

  it('warns once, for the environment, not for its \\\\', async () => {
    const { warnings } = await convertMdToDocx(fence + '\n\\begin{array}{c|c} a & b \\\\ c & d \\end{array}\n' + fence);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('\\begin{array}');
  });

  // As before
  it.each([
    ['cases', fence + '\n\\begin{cases}\na & b \\\\\nc & d\n\\end{cases}\n' + fence, fence + '\n\\begin{cases}\na & b \\\\\nc & d\n\\end{cases}\n' + fence],
    ['pmatrix', fence + '\n\\begin{pmatrix} a & b \\end{pmatrix}\n' + fence, fence + '\n\\begin{pmatrix} a & b \\end{pmatrix}\n' + fence],
    ['an \\end{pmatrix} alone, which shows nothing', 'A $a \\end{pmatrix} + 1$ C.', 'A $a  + 1$ C.'],
  ])('writes %s as before', async (_name, md, expected) => {
    expect(wordText(await equations(md))).not.toContain('\\');
    const back = await roundTrip(md);
    expect(back).toBe(expected);
    expect(await roundTrip(back)).toBe(back);
  });
});

// Fences on lines of their own wrote their line ends into Word as runs of a
// line feed alone at the equation's edges, which Word never writes, and an
// equation written on one line got them after its first trip
describe("the line ends at a display equation's fences", () => {
  const fence = '$'.repeat(2);
  const roundTrip = async (md: string) => stripFrontmatter((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  const equations = async (md: string) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    return xml.match(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/g) ?? [];
  };
  const lineFeeds = (omml: string[]) => omml.join('').match(/<m:t(?: [^>]*)?>\n<\/m:t>/g)?.length ?? 0;

  // With the number of line ends between rows, which stay
  it.each([
    ['in a paragraph, on lines of their own', 'See\n' + fence + '\nx\n' + fence + ' b.\n', 0],
    ['on the same line', 'See ' + fence + 'x' + fence + ' b.\n', 0],
    ['around a multi-row environment', 'See\n' + fence + '\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n' + fence + ' b.\n', 3],
    ['around rows without an environment', fence + '\na \\\\\nb\n' + fence + '\n', 1],
    ['around an equation that ends in a comment', 'See\n' + fence + '\nx % note\n' + fence + ' b.\n', 0],
    ['in a list item', '- See\n  ' + fence + '\n  x\n  ' + fence + ' b.\n', 0],
    ['in a quote', '> See\n> ' + fence + '\n> x\n> ' + fence + ' b.\n', 0],
    ['in a paragraph of their own', fence + '\nx\n' + fence + '\n', 0],
    ['around a numbered equation', fence + '\nx \\tag{1}\n' + fence + '\n', 0],
    ['around a tracked change', 'See\n' + fence + '\n{++x++}\n' + fence + ' b.\n', 0],
    ['around an equation Word records as replaced', fence + '\n{++\\frac++}{1}{2}\n' + fence + '\n', 0],
  ])('writes no line feed alone for fences %s', async (_name, md, between) => {
    const omml = await equations(md);
    expect(omml).toHaveLength(1);
    expect(lineFeeds(omml)).toBe(between);
    const back = await roundTrip(md);
    expect(await equations(back)).toEqual(omml);
    expect(await roundTrip(back)).toBe(back);
  });

  it("keeps a comment's line end at the equation's end", async () => {
    const md = 'See\n' + fence + '\nx % note\n' + fence + ' b.\n';
    expect((await equations(md))[0]).toContain(' % note\n</m:t>');
    expect(await roundTrip(md)).toContain('\nx % note\n' + fence);
  });
});

// Inline math right after a display equation in its paragraph ran into the
// equation's closing fence, a run of three dollars, after which export read
// the inline math's $ as text, and the next import escaped it. It goes on
// the line after the fence, which export reads as a space, as it does the
// line end before an opening fence, and where a preview shows it
describe('inline math right after a display equation', () => {
  const fence = '$'.repeat(2);
  const breaks = '---\nbreaks: true\n---\n';
  // Without its frontmatter, but where a line end is a line break
  const readBack = (md: string) => md.startsWith(breaks) ? md : stripFrontmatter(md);
  const roundTrip = async (md: string) => readBack((await convertDocx((await convertMdToDocx(md)).docx)).markdown);
  // Each of Word's paragraphs, by its style and its text, with each display
  // equation as [equation], each inline one as [math] and each line break
  // as <br>
  const paragraphs = async (md: string) => {
    const xml = await (await JSZip.loadAsync((await convertMdToDocx(md)).docx)).file('word/document.xml')!.async('string');
    return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(p => {
      const marked = p.replace(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/g, '<w:t>[equation]</w:t>').replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, '<w:t>[math]</w:t>');
      return (/<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? '') + ': ' + [...marked.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:br\/>/g)].map(m => m[1] ?? '<br>').join('');
    });
  };
  /** The Markdown import writes for a document from Word, `md`'s with its
   *  bold run's place taken by `runs` */
  const fromWord = async (md: string, runs: string) => {
    const zip = await JSZip.loadAsync((await convertMdToDocx(md)).docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(/<w:r><w:rPr><w:b\/>(?:(?!<\/w:r>).)*XX<\/w:t><\/w:r>/, () => runs));
    return readBack((await convertDocx(await zip.generateAsync({ type: 'uint8array' }))).markdown);
  };
  const display = (latex: string) => '<m:oMathPara><m:oMath><m:r><m:t>' + latex + '</m:t></m:r></m:oMath></m:oMathPara>';
  const inline = (latex: string) => '<m:oMath><m:r><m:t>' + latex + '</m:t></m:r></m:oMath>';
  const text = (t: string) => '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  /** `md` with `prefix` on each line after its first, as a list item's or a quote's */
  const within = (prefix: string, md: string) => md.replace(/\n(?=.)/g, '\n' + prefix);
  const x = fence + '\nx\n' + fence;
  const z = fence + '\nz\n' + fence;

  const back = async (md: string, runs: string, expected: string, paras: string[]) => {
    const once = await fromWord(md, runs);
    expect(once).toBe(expected);
    expect(await paragraphs(once)).toEqual(paras);
    const twice = await roundTrip(once);
    expect(twice).toBe(once);
    expect(await paragraphs(twice)).toEqual(paras);
    expect(await roundTrip(twice)).toBe(twice);
  };

  it.each([
    ['in a paragraph', 'a **XX** b.\n', display('x') + inline('y'), 'a\n' + x + '\n$y$ b.\n', [': a [equation] [math] b.']],
    ['alone with it in a paragraph', '**XX**\n', display('x') + inline('y'), x + '\n$y$\n', [': [equation] [math]']],
    ['between two display equations', 'a **XX** b.\n', display('x') + inline('y') + display('z'), 'a\n' + x + '\n$y$\n' + z + '&#32;b.\n',
      [': a [equation] [math] [equation] b.']],
    // A space there goes as the line end, which export reads as one, or the
    // first row would come back with it as &#32; on the fence's line
    ['after a space', 'a **XX** b.\n', display('x') + text(' ') + inline('y'), 'a\n' + x + '\n$y$ b.\n', [': a [equation] [math] b.']],
    ['in a list item', '- a **XX** b.\n', display('x') + inline('y'), '- ' + within('  ', 'a\n' + x + '\n$y$ b.\n'),
      [': a [equation] [math] b.']],
    ['between two display equations in a list item', '- a **XX** b.\n', display('x') + inline('y') + display('z'),
      '- ' + within('  ', 'a\n' + x + '\n$y$\n' + z + '&#32;b.\n'), [': a [equation] [math] [equation] b.']],
    ['in a quote', '> a **XX** b.\n', display('x') + inline('y'), '> ' + within('> ', 'a\n' + x + '\n$y$ b.\n'),
      [': ', 'GitHubBlockquote: a [equation] [math] b.', ': ']],
    ['between two display equations in a quote', '> a **XX** b.\n', display('x') + inline('y') + display('z'),
      '> ' + within('> ', 'a\n' + x + '\n$y$\n' + z + '&#32;b.\n'), [': ', 'GitHubBlockquote: a [equation] [math] [equation] b.', ': ']],
    // After a heading, where import writes an equation that isn't all of it
    ['in a heading', '# **XX**\n', display('x') + inline('y'), '# \n\n' + x + '\n$y$\n', ['Heading1: ', ': [equation] [math]']],
  ])('keeps inline math %s', async (_name, md, runs, expected, paras) => {
    await back(md, runs, expected, paras);
  });

  // Where a line end is a line break (breaks: true), export would write one
  // in Word for the line end after the fence, so a space there stays on the
  // fence's line, as on main
  it.each([
    ['in a paragraph', '**XX** b.\n', display('x') + text(' ') + inline('y'), x + '&#32;$y$ b.\n', [': [equation] [math] b.']],
    ['in a list item', '- **XX** b.\n', display('x') + text(' ') + inline('y'), '- ' + within('  ', x + '&#32;$y$ b.\n'), [': [equation] [math] b.']],
    ['in a quote', '> **XX** b.\n', display('x') + text(' ') + inline('y'), '> ' + within('> ', x + '&#32;$y$ b.\n'),
      [': ', 'GitHubBlockquote: [equation] [math] b.', ': ']],
  ])('keeps inline math after a space %s where a line end is a line break', async (_name, md, runs, expected, paras) => {
    await back(breaks + md, runs, breaks + expected, paras);
  });

  // As on main: inline math before the equation, on the line before its
  // fence; text between them, whose letter before the math is a reference;
  // more than a space, as references; a $ that starts text after it,
  // escaped; and inline math in a tracked change, whose {++ keeps it apart
  it.each([
    ['inline math before it', 'a **XX**b.\n', inline('y') + display('x'), 'a $y$\n' + x + 'b.\n', [': a [math] [equation]b.']],
    ['text between them', 'a **XX** b.\n', display('x') + text('c') + inline('y'), 'a\n' + x + '&#99;$y$ b.\n', [': a [equation]c[math] b.']],
    ['two spaces between them', 'a **XX** b.\n', display('x') + text('  ') + inline('y'), 'a\n' + x + '&#32;&#32;$y$ b.\n',
      [': a [equation]  [math] b.']],
    ['a dollar sign after it', 'a **XX** b.\n', display('x') + text('$y$'), 'a\n' + x + '\\$y$ b.\n', [': a [equation]$y$ b.']],
    ['inline math in a tracked change after it', 'a **XX** b.\n',
      display('x') + '<w:ins w:id="9" w:author="A" w:date="2024-01-01T00:00:00Z">' + inline('y') + '</w:ins>', 'a\n' + x + '{++$y$++} b.\n',
      [': a [equation][math] b.']],
    ['inline math before it in a list item', '- a **XX**b.\n', inline('y') + display('x'), '- ' + within('  ', 'a $y$\n' + x + 'b.\n'),
      [': a [math] [equation]b.']],
    ['text between them in a list item', '- a **XX** b.\n', display('x') + text('c') + inline('y'), '- ' + within('  ', 'a\n' + x + '&#99;$y$ b.\n'),
      [': a [equation]c[math] b.']],
    ['inline math before it in a quote', '> a **XX**b.\n', inline('y') + display('x'), '> ' + within('> ', 'a $y$\n' + x + 'b.\n'),
      [': ', 'GitHubBlockquote: a [math] [equation]b.', ': ']],
    ['text between them in a quote', '> a **XX** b.\n', display('x') + text('c') + inline('y'), '> ' + within('> ', 'a\n' + x + '&#99;$y$ b.\n'),
      [': ', 'GitHubBlockquote: a [equation]c[math] b.', ': ']],
  ])('writes %s as on main', async (_name, md, runs, expected, paras) => {
    await back(md, runs, expected, paras);
  });
});
