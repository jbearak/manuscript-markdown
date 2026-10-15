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
