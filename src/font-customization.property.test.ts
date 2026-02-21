// Feature: docx-font-customization, Property 1: Font string field parsing
import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { parseFrontmatter } from './frontmatter';

// --- Shared XML extraction helpers ---

function extractStyleBlock(xml: string, styleId: string): string | null {
  const openPattern = '<w:style ';
  let searchFrom = 0;
  while (true) {
    const idx = xml.indexOf(openPattern, searchFrom);
    if (idx === -1) return null;
    const closeTag = xml.indexOf('</w:style>', idx);
    if (closeTag === -1) return null;
    const block = xml.substring(idx, closeTag + '</w:style>'.length);
    const idAttr = 'w:styleId="' + styleId + '"';
    if (block.includes(idAttr)) {
      return block;
    }
    searchFrom = closeTag + '</w:style>'.length;
  }
}

function extractSzVal(block: string): number | null {
  const prefix = '<w:sz w:val="';
  const idx = block.indexOf(prefix);
  if (idx === -1) return null;
  const start = idx + prefix.length;
  const end = block.indexOf('"', start);
  if (end === -1) return null;
  return Number(block.substring(start, end));
}

function extractRFontsAscii(block: string): string | null {
  const prefix = 'w:ascii="';
  const idx = block.indexOf(prefix);
  if (idx === -1) return null;
  const start = idx + prefix.length;
  const end = block.indexOf('"', start);
  if (end === -1) return null;
  return block.substring(start, end);
}

/**
 * Property 1: Font string field parsing
 *
 * For any non-empty string value, a YAML frontmatter block containing
 * `font: <value>` or `code-font: <value>` should produce a Frontmatter
 * object where the corresponding field (`font` or `codeFont`) equals
 * that string value.
 *
 * Validates: Requirements 1.1, 1.2
 */
describe('Font Customization Property Tests', () => {
  // Generator for non-empty font name strings that are safe for YAML values.
  // The parser trims whitespace and strips surrounding quotes from values,
  // so we generate strings that equal their trimmed form and avoid YAML-special
  // characters: colons (key delimiter), newlines, hash (comment start).
  const fontNameArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        s.trim() === s &&
        s.length > 0 &&
        !s.includes('\n') &&
        !s.includes('\r') &&
        !s.includes(':') &&
        !s.includes('#') &&
        !/^["']/.test(s) &&
        !/["']$/.test(s)
    );

  it('Property 1a: font field is parsed correctly from frontmatter', () => {
    fc.assert(
      fc.property(fontNameArb, (fontName) => {
        const yaml = '---\nfont: ' + fontName + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.font !== fontName) {
          throw new Error(
            'Expected font "' + fontName + '" but got "' + metadata.font + '"'
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 1b: code-font field is parsed correctly from frontmatter', () => {
    fc.assert(
      fc.property(fontNameArb, (fontName) => {
        const yaml = '---\ncode-font: ' + fontName + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.codeFont !== fontName) {
          throw new Error(
            'Expected codeFont "' + fontName + '" but got "' + metadata.codeFont + '"'
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 1c: both font and code-font fields are parsed together', () => {
    fc.assert(
      fc.property(fontNameArb, fontNameArb, (font, codeFont) => {
        const yaml =
          '---\nfont: ' + font + '\ncode-font: ' + codeFont + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.font !== font) {
          throw new Error(
            'Expected font "' + font + '" but got "' + metadata.font + '"'
          );
        }
        if (metadata.codeFont !== codeFont) {
          throw new Error(
            'Expected codeFont "' +
              codeFont +
              '" but got "' +
              metadata.codeFont +
              '"'
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  // Feature: docx-font-customization, Property 2: Numeric size field parsing
  // Validates: Requirements 1.3, 1.4

  // Generator for positive finite numbers in a bounded range suitable for font sizes.
  const fontSizeArb = fc.double({ min: 0.5, max: 72, noNaN: true });

  it('Property 2a: font-size field is parsed correctly from frontmatter', () => {
    fc.assert(
      fc.property(fontSizeArb, (size) => {
        const yaml = '---\nfont-size: ' + String(size) + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        const expected = parseFloat(String(size));
        if (metadata.fontSize !== expected) {
          throw new Error(
            'Expected fontSize ' + expected + ' but got ' + metadata.fontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 2b: code-font-size field is parsed correctly from frontmatter', () => {
    fc.assert(
      fc.property(fontSizeArb, (size) => {
        const yaml = '---\ncode-font-size: ' + String(size) + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        const expected = parseFloat(String(size));
        if (metadata.codeFontSize !== expected) {
          throw new Error(
            'Expected codeFontSize ' + expected + ' but got ' + metadata.codeFontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 2c: both font-size and code-font-size fields are parsed together', () => {
    fc.assert(
      fc.property(fontSizeArb, fontSizeArb, (fontSize, codeFontSize) => {
        const yaml =
          '---\nfont-size: ' + String(fontSize) +
          '\ncode-font-size: ' + String(codeFontSize) + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        const expectedFontSize = parseFloat(String(fontSize));
        const expectedCodeFontSize = parseFloat(String(codeFontSize));
        if (metadata.fontSize !== expectedFontSize) {
          throw new Error(
            'Expected fontSize ' + expectedFontSize + ' but got ' + metadata.fontSize
          );
        }
        if (metadata.codeFontSize !== expectedCodeFontSize) {
          throw new Error(
            'Expected codeFontSize ' + expectedCodeFontSize + ' but got ' + metadata.codeFontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});

// Feature: docx-font-customization, Property 3: Non-numeric size rejection

/**
 * Property 3: Non-numeric size rejection
 *
 * For any string that is not a finite positive number (e.g., alphabetic strings,
 * empty strings, NaN, Infinity, negative numbers, zero), a YAML frontmatter block
 * containing `font-size: <value>` or `code-font-size: <value>` should produce a
 * Frontmatter object where the corresponding size field is `undefined`.
 *
 * Validates: Requirements 1.5, 1.6
 */
describe('Property 3: Non-numeric size rejection', () => {
  // Generator for strings that parseFloat does NOT parse to a finite positive number.
  // Note: parseFloat("0.5px") === 0.5 which IS a valid positive number, so strings
  // like "12px" are actually accepted by the parser. We must filter to only keep
  // strings where parseFloat yields NaN, Infinity, negative, or zero.
  const nonNumericStringArb = fc.oneof(
    // Pure alphabetic strings (e.g., "large", "abc") — parseFloat returns NaN
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z]+$/.test(s)),
    // Special non-numeric constants
    fc.constantFrom('NaN', 'Infinity', '-Infinity', 'null', 'undefined', 'true', 'false', 'none'),
    // Empty string
    fc.constant(''),
    // Negative number strings
    fc.double({ min: -1000, max: -0.001, noNaN: true }).map((n) => String(n)),
    // Zero as string
    fc.constant('0')
  ).filter((s) => {
    // Safety net: ensure parseFloat does NOT yield a finite positive number
    const n = parseFloat(s);
    return !(isFinite(n) && n > 0);
  });

  // Numbers <= 0 (negative and zero)
  const nonPositiveNumberArb = fc.oneof(
    fc.constant(0),
    fc.double({ min: -1000, max: -0.001, noNaN: true })
  );

  it('Property 3a: font-size with non-numeric string values is rejected', () => {
    fc.assert(
      fc.property(nonNumericStringArb, (value) => {
        const yaml = '---\nfont-size: ' + value + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.fontSize !== undefined) {
          throw new Error(
            'Expected fontSize to be undefined for value "' + value + '" but got ' + metadata.fontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 3b: code-font-size with non-numeric string values is rejected', () => {
    fc.assert(
      fc.property(nonNumericStringArb, (value) => {
        const yaml = '---\ncode-font-size: ' + value + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.codeFontSize !== undefined) {
          throw new Error(
            'Expected codeFontSize to be undefined for value "' + value + '" but got ' + metadata.codeFontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 3c: font-size with negative numbers and zero is rejected', () => {
    fc.assert(
      fc.property(nonPositiveNumberArb, (value) => {
        const yaml = '---\nfont-size: ' + String(value) + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.fontSize !== undefined) {
          throw new Error(
            'Expected fontSize to be undefined for value ' + value + ' but got ' + metadata.fontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 3d: code-font-size with negative numbers and zero is rejected', () => {
    fc.assert(
      fc.property(nonPositiveNumberArb, (value) => {
        const yaml = '---\ncode-font-size: ' + String(value) + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.codeFontSize !== undefined) {
          throw new Error(
            'Expected codeFontSize to be undefined for value ' + value + ' but got ' + metadata.codeFontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 3e: both font-size and code-font-size with non-numeric values are rejected together', () => {
    fc.assert(
      fc.property(nonNumericStringArb, nonNumericStringArb, (fsValue, cfsValue) => {
        const yaml =
          '---\nfont-size: ' + fsValue +
          '\ncode-font-size: ' + cfsValue + '\n---\n';
        const { metadata } = parseFrontmatter(yaml);
        if (metadata.fontSize !== undefined) {
          throw new Error(
            'Expected fontSize to be undefined for value "' + fsValue + '" but got ' + metadata.fontSize
          );
        }
        if (metadata.codeFontSize !== undefined) {
          throw new Error(
            'Expected codeFontSize to be undefined for value "' + cfsValue + '" but got ' + metadata.codeFontSize
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});


// Feature: docx-font-customization, Property 9: Frontmatter font field round-trip

/**
 * Property 9: Frontmatter font field round-trip
 *
 * For any valid Frontmatter object containing any combination of font fields
 * (font, codeFont, fontSize, codeFontSize), serializing it with
 * serializeFrontmatter() and then parsing the result with parseFrontmatter()
 * should produce a Frontmatter object with equivalent font field values.
 *
 * Validates: Requirements 5.1, 5.2, 5.3
 */
import { serializeFrontmatter } from './frontmatter';
import type { Frontmatter } from './frontmatter';

describe('Property 9: Frontmatter font field round-trip', () => {
  // Reuse the same generators as Properties 1-2
  const fontNameArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        s.trim() === s &&
        s.length > 0 &&
        !s.includes('\n') &&
        !s.includes('\r') &&
        !s.includes(':') &&
        !s.includes('#') &&
        !/^["']/.test(s) &&
        !/["']$/.test(s)
    );

  const fontSizeArb = fc.double({ min: 0.5, max: 72, noNaN: true });

  // Generator for a Frontmatter object with any combination of font fields
  const fontFrontmatterArb = fc.record({
    font: fc.option(fontNameArb, { nil: undefined }),
    codeFont: fc.option(fontNameArb, { nil: undefined }),
    fontSize: fc.option(fontSizeArb, { nil: undefined }),
    codeFontSize: fc.option(fontSizeArb, { nil: undefined }),
  });

  it('Property 9: serialize then parse preserves font fields', () => {
    fc.assert(
      fc.property(fontFrontmatterArb, (fm: Frontmatter) => {
        const serialized = serializeFrontmatter(fm);

        // If all fields are undefined, serializer returns empty string
        // and parser returns empty metadata — both should have no font fields
        const { metadata } = parseFrontmatter(serialized);

        // String fields: direct equality
        if (fm.font !== undefined) {
          if (metadata.font !== fm.font) {
            throw new Error(
              'font mismatch: expected "' + fm.font + '" but got "' + metadata.font + '"'
            );
          }
        } else {
          if (metadata.font !== undefined) {
            throw new Error(
              'font should be undefined but got "' + metadata.font + '"'
            );
          }
        }

        if (fm.codeFont !== undefined) {
          if (metadata.codeFont !== fm.codeFont) {
            throw new Error(
              'codeFont mismatch: expected "' + fm.codeFont + '" but got "' + metadata.codeFont + '"'
            );
          }
        } else {
          if (metadata.codeFont !== undefined) {
            throw new Error(
              'codeFont should be undefined but got "' + metadata.codeFont + '"'
            );
          }
        }

        // Numeric fields: compare via parseFloat(String(value)) to handle
        // floating point representation differences in serialization round-trip
        if (fm.fontSize !== undefined) {
          const expected = parseFloat(String(fm.fontSize));
          if (metadata.fontSize !== expected) {
            throw new Error(
              'fontSize mismatch: expected ' + expected + ' but got ' + metadata.fontSize
            );
          }
        } else {
          if (metadata.fontSize !== undefined) {
            throw new Error(
              'fontSize should be undefined but got ' + metadata.fontSize
            );
          }
        }

        if (fm.codeFontSize !== undefined) {
          const expected = parseFloat(String(fm.codeFontSize));
          if (metadata.codeFontSize !== expected) {
            throw new Error(
              'codeFontSize mismatch: expected ' + expected + ' but got ' + metadata.codeFontSize
            );
          }
        } else {
          if (metadata.codeFontSize !== undefined) {
            throw new Error(
              'codeFontSize should be undefined but got ' + metadata.codeFontSize
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});


// Feature: docx-font-customization, Property 4: Code-font-size inference

/**
 * Property 4: Code-font-size inference
 *
 * For any valid positive font-size value S, when resolveFontOverrides is called
 * with fontSize = S and no codeFontSize, the resolved codeSizeHp should equal
 * Math.max(1, S * 2 - 2) (body size minus 1pt in half-points, clamped to min 1hp).
 * When both fontSize and codeFontSize are explicitly provided, codeSizeHp should
 * equal codeFontSize * 2 regardless of fontSize. When only codeFontSize is provided,
 * bodySizeHp should be undefined and codeSizeHp should equal codeFontSize * 2.
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 */
import { resolveFontOverrides } from './md-to-docx';

describe('Property 4: Code-font-size inference', () => {
  const fontSizeArb = fc.double({ min: 0.5, max: 72, noNaN: true });

  it('Property 4a: fontSize without codeFontSize infers codeSizeHp = Math.max(1, fontSize * 2 - 2)', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const result = resolveFontOverrides({ fontSize });
        if (result === undefined) {
          throw new Error('Expected FontOverrides but got undefined for fontSize=' + fontSize);
        }
        const expectedBodyHp = Math.round(fontSize * 2);
        const expectedCodeHp = Math.max(1, expectedBodyHp - 2);
        if (result.bodySizeHp !== expectedBodyHp) {
          throw new Error(
            'bodySizeHp: expected ' + expectedBodyHp + ' but got ' + result.bodySizeHp
          );
        }
        if (result.codeSizeHp !== expectedCodeHp) {
          throw new Error(
            'codeSizeHp: expected ' + expectedCodeHp + ' but got ' + result.codeSizeHp
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 4b: both fontSize and codeFontSize provided uses explicit codeFontSize * 2', () => {
    fc.assert(
      fc.property(fontSizeArb, fontSizeArb, (fontSize, codeFontSize) => {
        const result = resolveFontOverrides({ fontSize, codeFontSize });
        if (result === undefined) {
          throw new Error('Expected FontOverrides but got undefined');
        }
        const expectedCodeHp = Math.round(codeFontSize * 2);
        if (result.codeSizeHp !== expectedCodeHp) {
          throw new Error(
            'codeSizeHp: expected ' + expectedCodeHp + ' (codeFontSize * 2) but got ' + result.codeSizeHp
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 4c: only codeFontSize provided leaves bodySizeHp undefined', () => {
    fc.assert(
      fc.property(fontSizeArb, (codeFontSize) => {
        const result = resolveFontOverrides({ codeFontSize });
        if (result === undefined) {
          throw new Error('Expected FontOverrides but got undefined');
        }
        if (result.bodySizeHp !== undefined) {
          throw new Error(
            'bodySizeHp: expected undefined but got ' + result.bodySizeHp
          );
        }
        const expectedCodeHp = Math.round(codeFontSize * 2);
        if (result.codeSizeHp !== expectedCodeHp) {
          throw new Error(
            'codeSizeHp: expected ' + expectedCodeHp + ' but got ' + result.codeSizeHp
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});


// Feature: docx-font-customization, Property 5: Body font application to non-code styles

/**
 * Property 5: Body font application to non-code styles
 *
 * For any non-empty font name string, the styles XML generated with that body
 * font override should contain w:rFonts elements with w:ascii and w:hAnsi
 * attributes set to that font name in every non-code style (Normal, Heading1-6,
 * Title, Quote, IntenseQuote, FootnoteText, EndnoteText), and should NOT set
 * that font in code styles (CodeChar, CodeBlock).
 *
 * Validates: Requirements 3.1
 */
import { stylesXml } from './md-to-docx';
import type { FontOverrides } from './md-to-docx';

describe('Property 5: Body font application to non-code styles', () => {
  // Generator for font names safe for both YAML and XML (no < > & " characters)
  const xmlSafeFontNameArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        s.trim() === s &&
        s.length > 0 &&
        !s.includes('\n') &&
        !s.includes('\r') &&
        !s.includes('<') &&
        !s.includes('>') &&
        !s.includes('&') &&
        !s.includes('"')
    );

  // Non-code styles that should receive the body font
  const nonCodeStyles = [
    'Normal',
    'Heading1',
    'Heading2',
    'Heading3',
    'Heading4',
    'Heading5',
    'Heading6',
    'Title',
    'Quote',
    'IntenseQuote',
    'FootnoteText',
    'EndnoteText',
  ];

  // Code styles that should NOT receive the body font
  const codeStyles = ['CodeChar', 'CodeBlock'];

  it('Property 5a: body font appears in all non-code styles', () => {
    fc.assert(
      fc.property(xmlSafeFontNameArb, (fontName) => {
        const overrides: FontOverrides = { bodyFont: fontName };
        const xml = stylesXml(overrides);

        const expectedRFonts = 'w:ascii="' + fontName + '" w:hAnsi="' + fontName + '"';

        for (const styleId of nonCodeStyles) {
          const block = extractStyleBlock(xml, styleId);
          if (block === null) {
            throw new Error('Style block not found for styleId: ' + styleId);
          }
          if (!block.includes(expectedRFonts)) {
            throw new Error(
              'Expected w:rFonts with "' + fontName + '" in style ' + styleId +
              ' but it was not found. Block: ' + block.substring(0, 200)
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 5b: body font does NOT appear in code styles (they keep Consolas)', () => {
    fc.assert(
      fc.property(
        xmlSafeFontNameArb.filter((s) => s !== 'Consolas'),
        (fontName) => {
          const overrides: FontOverrides = { bodyFont: fontName };
          const xml = stylesXml(overrides);

          const bodyRFonts = 'w:ascii="' + fontName + '" w:hAnsi="' + fontName + '"';
          const consolasRFonts = 'w:ascii="Consolas" w:hAnsi="Consolas"';

          for (const styleId of codeStyles) {
            const block = extractStyleBlock(xml, styleId);
            if (block === null) {
              throw new Error('Style block not found for styleId: ' + styleId);
            }
            if (block.includes(bodyRFonts)) {
              throw new Error(
                'Body font "' + fontName + '" should NOT appear in code style ' + styleId +
                ' but it was found. Block: ' + block.substring(0, 200)
              );
            }
            if (!block.includes(consolasRFonts)) {
              throw new Error(
                'Code style ' + styleId + ' should still have Consolas but it was not found. Block: ' + block.substring(0, 200)
              );
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});


// Feature: docx-font-customization, Property 6: Code font application to code styles

/**
 * Property 6: Code font application to code styles
 *
 * For any non-empty font name string, the styles XML generated with that code
 * font override should contain w:rFonts elements with w:ascii and w:hAnsi
 * attributes set to that font name in CodeChar and CodeBlock styles, and should
 * NOT affect the w:rFonts in non-code styles.
 *
 * Validates: Requirements 3.2
 */
describe('Property 6: Code font application to code styles', () => {
  // Generator for font names safe for XML (no < > & " characters)
  const xmlSafeFontNameArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        s.trim() === s &&
        s.length > 0 &&
        !s.includes('\n') &&
        !s.includes('\r') &&
        !s.includes('<') &&
        !s.includes('>') &&
        !s.includes('&') &&
        !s.includes('"')
    );

  // Code styles that should receive the code font
  const codeStyles = ['CodeChar', 'CodeBlock'];

  // Non-code styles that should NOT receive the code font
  const nonCodeStyles = [
    'Normal',
    'Heading1',
    'Heading2',
    'Heading3',
    'Heading4',
    'Heading5',
    'Heading6',
    'Title',
    'Quote',
    'IntenseQuote',
    'FootnoteText',
    'EndnoteText',
  ];

  it('Property 6a: code font appears in CodeChar and CodeBlock styles', () => {
    fc.assert(
      fc.property(xmlSafeFontNameArb, (fontName) => {
        const overrides: FontOverrides = { codeFont: fontName };
        const xml = stylesXml(overrides);

        const expectedRFonts = 'w:ascii="' + fontName + '" w:hAnsi="' + fontName + '"';

        for (const styleId of codeStyles) {
          const block = extractStyleBlock(xml, styleId);
          if (block === null) {
            throw new Error('Style block not found for styleId: ' + styleId);
          }
          if (!block.includes(expectedRFonts)) {
            throw new Error(
              'Expected w:rFonts with "' + fontName + '" in style ' + styleId +
              ' but it was not found. Block: ' + block.substring(0, 200)
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 6b: code font does NOT appear in non-code styles', () => {
    fc.assert(
      fc.property(
        xmlSafeFontNameArb.filter((s) => s !== 'Consolas'),
        (fontName) => {
          const overrides: FontOverrides = { codeFont: fontName };
          const xml = stylesXml(overrides);

          const codeRFonts = 'w:ascii="' + fontName + '" w:hAnsi="' + fontName + '"';

          for (const styleId of nonCodeStyles) {
            const block = extractStyleBlock(xml, styleId);
            if (block === null) {
              // Some styles like Quote may not have w:rPr when no body font is set — that's fine
              continue;
            }
            if (block.includes(codeRFonts)) {
              throw new Error(
                'Code font "' + fontName + '" should NOT appear in non-code style ' + styleId +
                ' but it was found. Block: ' + block.substring(0, 200)
              );
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});


// Feature: docx-font-customization, Property 7: Size and heading proportional scaling

/**
 * Property 7: Size and heading proportional scaling
 *
 * For any valid positive body font size S (in points), the generated styles XML
 * should set Normal's w:sz to S * 2 (half-points), and each heading style's w:sz
 * should equal Math.round(defaultHeadingHp / 22 * S * 2), preserving the ratio
 * between each heading and the default 11pt body size. CodeBlock's w:sz should
 * reflect the resolved code size (explicit or inferred).
 *
 * Validates: Requirements 3.3, 3.4, 3.5
 */
describe('Property 7: Size and heading proportional scaling', () => {
  const fontSizeArb = fc.double({ min: 0.5, max: 72, noNaN: true });

  // Default heading sizes in half-points (must match DEFAULT_HEADING_SIZES_HP in md-to-docx.ts)
  const defaultHeadingSizesHp: Record<string, number> = {
    Heading1: 32,
    Heading2: 26,
    Heading3: 24,
    Heading4: 22,
    Heading5: 20,
    Heading6: 18,
    Title: 56,
    FootnoteText: 20,
    EndnoteText: 20,
  };

  /**
   * Helper: extract the content of a <w:style> block by styleId from the XML string.
   */
  it('Property 7a: Normal style w:sz equals fontSize * 2 (half-points)', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const overrides = resolveFontOverrides({ fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined for fontSize=' + fontSize);
        }
        const xml = stylesXml(overrides);
        const block = extractStyleBlock(xml, 'Normal');
        if (block === null) {
          throw new Error('Normal style block not found');
        }
        const szVal = extractSzVal(block);
        const expected = Math.round(fontSize * 2);
        if (szVal !== expected) {
          throw new Error(
            'Normal w:sz: expected ' + expected + ' but got ' + szVal
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 7b: heading styles have proportionally scaled w:sz values', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const overrides = resolveFontOverrides({ fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined for fontSize=' + fontSize);
        }
        const xml = stylesXml(overrides);
        const bodySizeHp = Math.round(fontSize * 2);

        const headingStyles = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];
        for (const styleId of headingStyles) {
          const block = extractStyleBlock(xml, styleId);
          if (block === null) {
            throw new Error('Style block not found for ' + styleId);
          }
          const szVal = extractSzVal(block);
          const defaultHp = defaultHeadingSizesHp[styleId];
          const expected = Math.round(defaultHp / 22 * bodySizeHp);
          if (szVal !== expected) {
            throw new Error(
              styleId + ' w:sz: expected ' + expected + ' but got ' + szVal +
              ' (defaultHp=' + defaultHp + ', bodySizeHp=' + bodySizeHp + ')'
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 7c: Title has proportionally scaled w:sz', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const overrides = resolveFontOverrides({ fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined for fontSize=' + fontSize);
        }
        const xml = stylesXml(overrides);
        const bodySizeHp = Math.round(fontSize * 2);

        const block = extractStyleBlock(xml, 'Title');
        if (block === null) {
          throw new Error('Title style block not found');
        }
        const szVal = extractSzVal(block);
        const expected = Math.round(56 / 22 * bodySizeHp);
        if (szVal !== expected) {
          throw new Error(
            'Title w:sz: expected ' + expected + ' but got ' + szVal
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 7d: FootnoteText and EndnoteText have proportionally scaled w:sz', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const overrides = resolveFontOverrides({ fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined for fontSize=' + fontSize);
        }
        const xml = stylesXml(overrides);
        const bodySizeHp = Math.round(fontSize * 2);

        for (const styleId of ['FootnoteText', 'EndnoteText']) {
          const block = extractStyleBlock(xml, styleId);
          if (block === null) {
            throw new Error(styleId + ' style block not found');
          }
          const szVal = extractSzVal(block);
          const expected = Math.round(20 / 22 * bodySizeHp);
          if (szVal !== expected) {
            throw new Error(
              styleId + ' w:sz: expected ' + expected + ' but got ' + szVal
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 7e: CodeBlock has inferred code size (fontSize * 2 - 2, clamped to min 1)', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const overrides = resolveFontOverrides({ fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined for fontSize=' + fontSize);
        }
        const xml = stylesXml(overrides);

        const block = extractStyleBlock(xml, 'CodeBlock');
        if (block === null) {
          throw new Error('CodeBlock style block not found');
        }
        const szVal = extractSzVal(block);
        const expected = Math.max(1, Math.round(fontSize * 2) - 2);
        if (szVal !== expected) {
          throw new Error(
            'CodeBlock w:sz: expected ' + expected + ' but got ' + szVal
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });
});


// Feature: docx-font-customization, Property 8: Template font override application

/**
 * Property 8: Template font override application
 *
 * For any valid styles XML string from a template and any font override,
 * applying applyFontOverridesToTemplate should produce XML where the overridden
 * styles contain the specified font/size values, while styles not targeted by
 * the override remain unchanged. When no overrides are provided, the template
 * XML should pass through unmodified.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4
 */
import { applyFontOverridesToTemplate } from './md-to-docx';

describe('Property 8: Template font override application', () => {
  // Generator for font names safe for XML (no < > & " characters)
  const xmlSafeFontNameArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        s.trim() === s &&
        s.length > 0 &&
        !s.includes('\n') &&
        !s.includes('\r') &&
        !s.includes('<') &&
        !s.includes('>') &&
        !s.includes('&') &&
        !s.includes('"')
    );

  const fontSizeArb = fc.double({ min: 0.5, max: 72, noNaN: true });

  // Default heading sizes in half-points (must match DEFAULT_HEADING_SIZES_HP in md-to-docx.ts)
  const defaultHeadingSizesHp: Record<string, number> = {
    Heading1: 32,
    Heading2: 26,
    Heading3: 24,
    Heading4: 22,
    Heading5: 20,
    Heading6: 18,
    Title: 56,
    FootnoteText: 20,
    EndnoteText: 20,
  };

  // A minimal but realistic template styles XML with existing fonts and sizes
  const templateStylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="Normal">' +
    '<w:name w:val="Normal"/>' +
    '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
    '<w:name w:val="heading 1"/>' +
    '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock">' +
    '<w:name w:val="Code Block"/>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="character" w:styleId="CodeChar">' +
    '<w:name w:val="Code Char"/>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="CustomStyle">' +
    '<w:name w:val="Custom Style"/>' +
    '<w:rPr><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>' +
    '</w:style>' +
    '</w:styles>';

  function toBytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  /**
   * Helper: extract the content of a <w:style> block by styleId from the XML string.
   */
  // Non-code styles present in the template
  const nonCodeStylesInTemplate = ['Normal', 'Heading1'];
  // Code styles present in the template
  const codeStylesInTemplate = ['CodeBlock', 'CodeChar'];

  it('Property 8a: bodyFont override replaces font in non-code template styles', () => {
    fc.assert(
      fc.property(xmlSafeFontNameArb, (fontName) => {
        const overrides: FontOverrides = { bodyFont: fontName };
        const result = applyFontOverridesToTemplate(toBytes(templateStylesXml), overrides);

        for (const styleId of nonCodeStylesInTemplate) {
          const block = extractStyleBlock(result, styleId);
          if (block === null) {
            throw new Error('Style block not found for ' + styleId);
          }
          const ascii = extractRFontsAscii(block);
          if (ascii !== fontName) {
            throw new Error(
              styleId + ' w:rFonts ascii: expected "' + fontName + '" but got "' + ascii + '"'
            );
          }
        }

        // Code styles should NOT have the body font
        for (const styleId of codeStylesInTemplate) {
          const block = extractStyleBlock(result, styleId);
          if (block === null) {
            throw new Error('Style block not found for ' + styleId);
          }
          const ascii = extractRFontsAscii(block);
          if (ascii === fontName && fontName !== 'Consolas') {
            throw new Error(
              'Code style ' + styleId + ' should NOT have body font "' + fontName + '"'
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 8b: codeFont override replaces font in code template styles', () => {
    fc.assert(
      fc.property(xmlSafeFontNameArb, (fontName) => {
        const overrides: FontOverrides = { codeFont: fontName };
        const result = applyFontOverridesToTemplate(toBytes(templateStylesXml), overrides);

        for (const styleId of codeStylesInTemplate) {
          const block = extractStyleBlock(result, styleId);
          if (block === null) {
            throw new Error('Style block not found for ' + styleId);
          }
          const ascii = extractRFontsAscii(block);
          if (ascii !== fontName) {
            throw new Error(
              styleId + ' w:rFonts ascii: expected "' + fontName + '" but got "' + ascii + '"'
            );
          }
        }

        // Non-code styles should NOT have the code font (they keep original)
        for (const styleId of nonCodeStylesInTemplate) {
          const block = extractStyleBlock(result, styleId);
          if (block === null) {
            throw new Error('Style block not found for ' + styleId);
          }
          const ascii = extractRFontsAscii(block);
          // The original fonts are Times New Roman (Normal) and Arial (Heading1)
          if (ascii === fontName && fontName !== 'Times New Roman' && fontName !== 'Arial') {
            throw new Error(
              'Non-code style ' + styleId + ' should NOT have code font "' + fontName + '"'
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 8c: bodySizeHp override sets size in Normal and proportional heading sizes', () => {
    fc.assert(
      fc.property(fontSizeArb, (fontSize) => {
        const overrides = resolveFontOverrides({ fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined');
        }
        const result = applyFontOverridesToTemplate(toBytes(templateStylesXml), overrides);
        const bodySizeHp = Math.round(fontSize * 2);

        // Normal should have the body size
        const normalBlock = extractStyleBlock(result, 'Normal');
        if (normalBlock === null) {
          throw new Error('Normal style block not found');
        }
        const normalSz = extractSzVal(normalBlock);
        if (normalSz !== bodySizeHp) {
          throw new Error(
            'Normal w:sz: expected ' + bodySizeHp + ' but got ' + normalSz
          );
        }

        // Heading1 should have proportionally scaled size
        const h1Block = extractStyleBlock(result, 'Heading1');
        if (h1Block === null) {
          throw new Error('Heading1 style block not found');
        }
        const h1Sz = extractSzVal(h1Block);
        const expectedH1 = Math.round(defaultHeadingSizesHp['Heading1'] / 22 * bodySizeHp);
        if (h1Sz !== expectedH1) {
          throw new Error(
            'Heading1 w:sz: expected ' + expectedH1 + ' but got ' + h1Sz
          );
        }

        // CodeBlock should have the inferred code size
        const codeBlock = extractStyleBlock(result, 'CodeBlock');
        if (codeBlock === null) {
          throw new Error('CodeBlock style block not found');
        }
        const codeSz = extractSzVal(codeBlock);
        const expectedCode = Math.max(1, bodySizeHp - 2);
        if (codeSz !== expectedCode) {
          throw new Error(
            'CodeBlock w:sz: expected ' + expectedCode + ' but got ' + codeSz
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 8d: codeSizeHp override sets size in CodeBlock template style', () => {
    fc.assert(
      fc.property(fontSizeArb, (codeFontSize) => {
        const overrides: FontOverrides = { codeSizeHp: Math.round(codeFontSize * 2) };
        const result = applyFontOverridesToTemplate(toBytes(templateStylesXml), overrides);

        const block = extractStyleBlock(result, 'CodeBlock');
        if (block === null) {
          throw new Error('CodeBlock style block not found');
        }
        const szVal = extractSzVal(block);
        const expected = Math.round(codeFontSize * 2);
        if (szVal !== expected) {
          throw new Error(
            'CodeBlock w:sz: expected ' + expected + ' but got ' + szVal
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 8e: CustomStyle not targeted by overrides remains unchanged', () => {
    fc.assert(
      fc.property(xmlSafeFontNameArb, fontSizeArb, (fontName, fontSize) => {
        const overrides = resolveFontOverrides({ font: fontName, fontSize });
        if (overrides === undefined) {
          throw new Error('Expected FontOverrides but got undefined');
        }
        const result = applyFontOverridesToTemplate(toBytes(templateStylesXml), overrides);

        // CustomStyle is not in BODY_STYLE_IDS or CODE_STYLE_IDS, so it should be untouched
        const originalBlock = extractStyleBlock(templateStylesXml, 'CustomStyle');
        const resultBlock = extractStyleBlock(result, 'CustomStyle');
        if (originalBlock !== resultBlock) {
          throw new Error(
            'CustomStyle should be unchanged but was modified.\nOriginal: ' +
            originalBlock + '\nResult: ' + resultBlock
          );
        }
      }),
      { numRuns: 100 }
    );
  }, { timeout: 30000 });

  it('Property 8f: empty FontOverrides passes template through unmodified', () => {
    // An empty FontOverrides object (no fields set) should not modify any styles
    const emptyOverrides: FontOverrides = {};
    const result = applyFontOverridesToTemplate(toBytes(templateStylesXml), emptyOverrides);

    if (result !== templateStylesXml) {
      throw new Error(
        'Template should pass through unmodified with empty overrides but was changed'
      );
    }
  }, { timeout: 30000 });
});
