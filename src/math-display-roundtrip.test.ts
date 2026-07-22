import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';
import { latexToOmml } from './latex-to-omml';
import { ommlToLatex } from './omml';
import { roundTrip, parserOptions } from './test-omml-helpers';
import { XMLParser } from 'fast-xml-parser';

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
    // unicodeToLatex maps αx → "\alpha x"; that space is a command
    // delimiter, not prose whitespace, so \mathrm{} must be kept.
    const omml =
      '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>αx</m:t></m:r>';
    const parsed = new XMLParser(parserOptions).parse('<m:oMath>' + omml + '</m:oMath>');
    expect(ommlToLatex(parsed[0]['m:oMath'])).toBe('\\mathrm{\\alpha x}');
  });

  it('does not rewrite limLow/limUpp as braces when chr or pos mismatches', () => {
    const parse = (xml: string) => {
      const parsed = new XMLParser(parserOptions).parse('<m:oMath>' + xml + '</m:oMath>');
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
