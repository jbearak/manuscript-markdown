import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import {
  parseInlineArray,
  normalizeFontStyle,
  parseFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from "./frontmatter";
import {
  resolveAtIndex,
  resolveFontOverrides,
  stylesXml,
  applyFontOverridesToTemplate,
  type FontOverrides,
} from "./md-to-docx";

// Feature: header-font-config, Property 1: Inline array parsing equivalence
describe("Property 1: Inline array parsing equivalence", () => {
  it("bracketed and bare comma-separated produce identical results", () => {
    const safeStr = fc
      .string({ minLength: 1, maxLength: 12 })
      .filter(
        (s) =>
          s.trim().length > 0 &&
          !s.includes(",") &&
          !s.includes("[") &&
          !s.includes("]") &&
          /^[a-zA-Z0-9 ]+$/.test(s),
      );
    fc.assert(
      fc.property(fc.array(safeStr, { minLength: 1, maxLength: 6 }), (arr) => {
        const trimmed = arr.map((s) => s.trim());
        const bracketed = "[" + trimmed.join(", ") + "]";
        const bare = trimmed.join(", ");
        const fromBracketed = parseInlineArray(bracketed);
        const fromBare = parseInlineArray(bare);
        expect(fromBracketed).toEqual(trimmed);
        expect(fromBare).toEqual(trimmed);
      }),
      { numRuns: 150 },
    );
  });

  it("single value without commas returns one-element array", () => {
    const safeStr = fc
      .string({ minLength: 1, maxLength: 15 })
      .filter(
        (s) => s.trim().length > 0 && !s.includes(",") && /^[a-z ]+$/.test(s),
      );
    fc.assert(
      fc.property(safeStr, (val) => {
        expect(parseInlineArray(val)).toEqual([val.trim()]);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: header-font-config, Property 2: Font style normalization is canonical and idempotent
describe("Property 2: Font style normalization is canonical and idempotent", () => {
  const ALL_PARTS = ["bold", "italic", "underline", "smallcaps", "allcaps", "center"];

  it("normalizes any permutation to canonical order and is idempotent", () => {
    fc.assert(
      fc.property(
        fc.subarray(ALL_PARTS, { minLength: 1, maxLength: 4 }).filter(
          (s) => !(s.includes("smallcaps") && s.includes("allcaps")),
        ),
        (subset) => {
          // Generate all permutations of subset
          const permute = (a: string[]): string[][] => {
            if (a.length <= 1) return [a];
            const result: string[][] = [];
            for (let i = 0; i < a.length; i++) {
              const rest = [...a.slice(0, i), ...a.slice(i + 1)];
              for (const p of permute(rest)) result.push([a[i], ...p]);
            }
            return result;
          };
          const canonical = [...subset]
            .sort((a, b) => ALL_PARTS.indexOf(a) - ALL_PARTS.indexOf(b))
            .join("-");
          for (const perm of permute(subset)) {
            const input = perm.join("-");
            const result = normalizeFontStyle(input);
            expect(result).toBe(canonical);
            // Idempotence
            expect(normalizeFontStyle(result!)).toBe(canonical);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('normalizes "normal" to "normal"', () => {
    expect(normalizeFontStyle("normal")).toBe("normal");
    expect(normalizeFontStyle("Normal")).toBe("normal");
    expect(normalizeFontStyle("NORMAL")).toBe("normal");
  });
});

// Feature: header-font-config, Property 3: Invalid font styles are rejected
describe("Property 3: Invalid font styles are rejected", () => {
  it("rejects duplicate parts", () => {
    const part = fc.constantFrom("bold", "italic", "underline", "smallcaps", "allcaps", "center");
    fc.assert(
      fc.property(part, (p) => {
        expect(normalizeFontStyle(p + "-" + p)).toBeUndefined();
      }),
      { numRuns: 50 },
    );
  });

  it("rejects unrecognized parts", () => {
    const badParts = [
      "heavy",
      "light",
      "strikethrough",
      "bolder",
      "oblique",
      "none",
      "auto",
      "",
    ];
    for (const bad of badParts) {
      expect(normalizeFontStyle(bad)).toBeUndefined();
      expect(normalizeFontStyle("bold-" + bad)).toBeUndefined();
    }
  });

  it("rejects mutually exclusive smallcaps-allcaps", () => {
    expect(normalizeFontStyle("smallcaps-allcaps")).toBeUndefined();
    expect(normalizeFontStyle("allcaps-smallcaps")).toBeUndefined();
    expect(normalizeFontStyle("bold-smallcaps-allcaps")).toBeUndefined();
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(normalizeFontStyle("")).toBeUndefined();
    expect(normalizeFontStyle("  ")).toBeUndefined();
  });
});

// Feature: header-font-config, Property 4: Invalid font sizes are filtered
describe("Property 4: Invalid font sizes are filtered", () => {
  it("only valid positive finite numbers survive parsing", () => {
    const validNum = fc.double({
      min: 0.5,
      max: 200,
      noNaN: true,
      noDefaultInfinity: true,
    });
    const invalidStr = fc.constantFrom(
      "abc",
      "-5",
      "0",
      "NaN",
      "Infinity",
      "",
      "-Infinity",
      "0.0",
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            validNum.map((n) => String(n)),
            invalidStr,
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (values) => {
          const yaml =
            "---\nheader-font-size: [" + values.join(", ") + "]\n---\n\nBody.";
          const { metadata } = parseFrontmatter(yaml);
          if (metadata.headerFontSize) {
            for (const n of metadata.headerFontSize) {
              expect(n).toBeGreaterThan(0);
              expect(isFinite(n)).toBe(true);
            }
          }
          // Also test title-font-size
          const yaml2 =
            "---\ntitle-font-size: [" + values.join(", ") + "]\n---\n\nBody.";
          const { metadata: m2 } = parseFrontmatter(yaml2);
          if (m2.titleFontSize) {
            for (const n of m2.titleFontSize) {
              expect(n).toBeGreaterThan(0);
              expect(isFinite(n)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

// Feature: header-font-config, Property 5: Repeated keys use last occurrence
describe("Property 5: Repeated keys use last occurrence", () => {
  it("last header-font value wins on repeated keys", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    fc.assert(
      fc.property(
        fc.array(fontName, { minLength: 2, maxLength: 4 }),
        (fonts) => {
          const lines = fonts.map((f) => "header-font: " + f);
          const yaml = "---\n" + lines.join("\n") + "\n---\n\nBody.";
          const { metadata } = parseFrontmatter(yaml);
          expect(metadata.headerFont).toEqual([fonts[fonts.length - 1]]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("last header-font-style value wins on repeated keys", () => {
    const styles = ["bold", "italic", "underline", "normal", "bold-italic", "smallcaps", "allcaps", "bold-smallcaps", "center", "bold-center"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...styles), { minLength: 2, maxLength: 4 }),
        (vals) => {
          const lines = vals.map((v) => "header-font-style: " + v);
          const yaml = "---\n" + lines.join("\n") + "\n---\n\nBody.";
          const { metadata } = parseFrontmatter(yaml);
          const expected = normalizeFontStyle(vals[vals.length - 1]);
          expect(metadata.headerFontStyle).toEqual(
            expected ? [expected] : undefined,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: header-font-config, Property 7: Serialization format correctness
describe("Property 7: Serialization format correctness", () => {
  it("single-element arrays serialize as plain values, multi as bracketed", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    fc.assert(
      fc.property(
        fc.array(fontName, { minLength: 1, maxLength: 6 }),
        (fonts) => {
          const fm: Frontmatter = { headerFont: fonts };
          const yaml = serializeFrontmatter(fm);
          if (fonts.length === 1) {
            expect(yaml).not.toContain("header-font: [");
          } else {
            expect(yaml).toContain("header-font: [");
          }
          expect(parseFrontmatter(yaml).metadata.headerFont).toEqual(fonts);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("undefined or empty arrays are omitted", () => {
    const fm1: Frontmatter = { font: "Palatino" };
    const yaml1 = serializeFrontmatter(fm1);
    expect(yaml1).not.toContain("header-font");
    expect(yaml1).not.toContain("title-font");

    const fm2: Frontmatter = { headerFont: [] };
    const yaml2 = serializeFrontmatter(fm2);
    expect(yaml2).not.toContain("header-font");
  });

  it("title serializes as repeated keys", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 15 })
            .filter((s) => /^[a-z ]+$/.test(s)),
          { minLength: 1, maxLength: 3 },
        ),
        (titles) => {
          const fm: Frontmatter = { title: titles };
          const yaml = serializeFrontmatter(fm);
          expect(yaml.match(/^title:/gm)).toHaveLength(titles.length);
          expect(parseFrontmatter(yaml).metadata.title).toEqual(titles);
          // Should NOT use bracketed format for title
          expect(yaml).not.toMatch(/title: \[/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("numeric arrays serialize correctly", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
          { minLength: 1, maxLength: 6 },
        ),
        (sizes) => {
          const fm: Frontmatter = { headerFontSize: sizes };
          const yaml = serializeFrontmatter(fm);
          expect(yaml).toContain("header-font-size:");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: header-font-config, Property 8: Parse-serialize-parse round-trip
describe("Property 8: Parse-serialize-parse round-trip", () => {
  it("parse(serialize(fm)) produces equivalent metadata for header/title font fields", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    const fontSize = fc.double({
      min: 1,
      max: 100,
      noNaN: true,
      noDefaultInfinity: true,
    });
    const fontStyle = fc.constantFrom(
      "bold",
      "italic",
      "underline",
      "normal",
      "bold-italic",
      "bold-underline",
      "italic-underline",
      "bold-italic-underline",
      "smallcaps",
      "allcaps",
      "bold-smallcaps",
      "bold-allcaps",
      "italic-smallcaps",
      "bold-italic-smallcaps",
      "center",
      "bold-center",
      "bold-italic-center",
    );

    fc.assert(
      fc.property(
        fc.record({
          headerFont: fc.option(
            fc.array(fontName, { minLength: 1, maxLength: 4 }),
            { nil: undefined },
          ),
          headerFontStyle: fc.option(
            fc.array(fontStyle, { minLength: 1, maxLength: 4 }),
            { nil: undefined },
          ),
          titleFont: fc.option(
            fc.array(fontName, { minLength: 1, maxLength: 3 }),
            { nil: undefined },
          ),
          titleFontStyle: fc.option(
            fc.array(fontStyle, { minLength: 1, maxLength: 3 }),
            { nil: undefined },
          ),
        }),
        (fields) => {
          const fm: Frontmatter = { ...fields };
          const yaml = serializeFrontmatter(fm);
          if (!yaml) return; // empty frontmatter, nothing to round-trip
          const { metadata } = parseFrontmatter(yaml + "\nBody.");
          if (fm.headerFont) expect(metadata.headerFont).toEqual(fm.headerFont);
          else expect(metadata.headerFont).toBeUndefined();
          if (fm.headerFontStyle)
            expect(metadata.headerFontStyle).toEqual(fm.headerFontStyle);
          else expect(metadata.headerFontStyle).toBeUndefined();
          if (fm.titleFont) expect(metadata.titleFont).toEqual(fm.titleFont);
          else expect(metadata.titleFont).toBeUndefined();
          if (fm.titleFontStyle)
            expect(metadata.titleFontStyle).toEqual(fm.titleFontStyle);
          else expect(metadata.titleFontStyle).toBeUndefined();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("round-trips font sizes through parse-serialize-parse", () => {
    const fontSize = fc.integer({ min: 1, max: 100 });
    fc.assert(
      fc.property(
        fc.array(fontSize, { minLength: 1, maxLength: 4 }),
        fc.array(fontSize, { minLength: 1, maxLength: 3 }),
        (hSizes, tSizes) => {
          const fm: Frontmatter = {
            headerFontSize: hSizes,
            titleFontSize: tSizes,
          };
          const yaml = serializeFrontmatter(fm);
          const { metadata } = parseFrontmatter(yaml + "\nBody.");
          expect(metadata.headerFontSize).toEqual(hSizes);
          expect(metadata.titleFontSize).toEqual(tSizes);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: header-font-config, Property 6: Array inheritance resolution
describe("Property 6: Array inheritance resolution", () => {
  it("returns arr[i] when i < length, arr[last] when i >= length", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: 0, max: 7 }),
        (arr, idx) => {
          const result = resolveAtIndex(arr, idx);
          if (idx < arr.length) {
            expect(result).toBe(arr[idx]);
          } else {
            expect(result).toBe(arr[arr.length - 1]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns undefined for empty or undefined arrays", () => {
    expect(resolveAtIndex(undefined, 0)).toBeUndefined();
    expect(resolveAtIndex([], 0)).toBeUndefined();
  });
});

// Feature: header-font-config, Property 9: Font fallback to body font
describe("Property 9: Font fallback to body font", () => {
  it("heading levels use font value when headerFont is undefined", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    fc.assert(
      fc.property(fontName, (font) => {
        const fm: Frontmatter = { font };
        const overrides = resolveFontOverrides(fm);
        expect(overrides).toBeDefined();
        if (overrides?.headingFonts) {
          for (const [, f] of overrides.headingFonts) {
            expect(f).toBe(font);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("title uses font value when titleFont is undefined", () => {
    const fm: Frontmatter = { font: "Georgia" };
    const overrides = resolveFontOverrides(fm);
    expect(overrides?.titleFonts).toEqual(["Georgia"]);
  });
});

// Feature: header-font-config, Property 10: header-font-size takes precedence over proportional scaling
describe("Property 10: header-font-size takes precedence over proportional scaling", () => {
  it("explicit headerFontSize overrides proportional scaling from fontSize", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 30 }),
        fc.array(fc.integer({ min: 8, max: 72 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (bodySize, headerSizes) => {
          const fm: Frontmatter = {
            fontSize: bodySize,
            headerFontSize: headerSizes,
          };
          const overrides = resolveFontOverrides(fm);
          expect(overrides).toBeDefined();
          const ids = [
            "Heading1",
            "Heading2",
            "Heading3",
            "Heading4",
            "Heading5",
            "Heading6",
          ];
          for (let i = 0; i < 6; i++) {
            const expected = resolveAtIndex(headerSizes, i);
            if (expected !== undefined) {
              expect(overrides!.headingSizesHp!.get(ids[i])).toBe(
                Math.round(expected * 2),
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: header-font-config, Property 13: Backward compatibility of existing font fields
describe("Property 13: Backward compatibility of existing font fields", () => {
  it("produces identical results when only pre-existing fields are set", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    fc.assert(
      fc.property(
        fc.option(fontName, { nil: undefined }),
        fc.option(fontName, { nil: undefined }),
        fc.option(fc.integer({ min: 8, max: 30 }), { nil: undefined }),
        fc.option(fc.integer({ min: 6, max: 20 }), { nil: undefined }),
        (font, codeFont, fontSize, codeFontSize) => {
          const fm: Frontmatter = {};
          if (font) fm.font = font;
          if (codeFont) fm.codeFont = codeFont;
          if (fontSize !== undefined) fm.fontSize = fontSize;
          if (codeFontSize !== undefined) fm.codeFontSize = codeFontSize;
          const overrides = resolveFontOverrides(fm);
          if (
            !font &&
            !codeFont &&
            fontSize === undefined &&
            codeFontSize === undefined
          ) {
            // No font-related fields set: font/code overrides should be absent
            // (tableSizeHp is always set due to auto-shrink, so the object is non-empty)
            expect(overrides.bodyFont).toBeUndefined();
            expect(overrides.codeFont).toBeUndefined();
            expect(overrides.bodySizeHp).toBeUndefined();
            return;
          }
          if (font) expect(overrides!.bodyFont).toBe(font);
          if (codeFont) expect(overrides!.codeFont).toBe(codeFont);
          if (fontSize !== undefined) {
            expect(overrides!.bodySizeHp).toBe(Math.round(fontSize * 2));
          }
          if (codeFontSize !== undefined) {
            expect(overrides!.codeSizeHp).toBe(Math.round(codeFontSize * 2));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- Shared XML extraction helpers ---
function extractStyleBlock(xml: string, styleId: string): string | null {
  let searchFrom = 0;
  while (true) {
    const idx = xml.indexOf("<w:style ", searchFrom);
    if (idx === -1) return null;
    const closeTag = xml.indexOf("</w:style>", idx);
    if (closeTag === -1) return null;
    const block = xml.substring(idx, closeTag + "</w:style>".length);
    if (block.includes('w:styleId="' + styleId + '"')) return block;
    searchFrom = closeTag + "</w:style>".length;
  }
}

function extractRPr(block: string): string {
  const start = block.indexOf("<w:rPr>");
  const end = block.indexOf("</w:rPr>");
  if (start === -1 || end === -1) return "";
  return block.substring(start, end + "</w:rPr>".length);
}

function extractPPr(block: string): string {
  const start = block.indexOf("<w:pPr>");
  const end = block.indexOf("</w:pPr>");
  if (start === -1 || end === -1) return "";
  return block.substring(start, end + "</w:pPr>".length);
}

// Feature: header-font-config, Property 11: stylesXml heading and title output correctness
describe("Property 11: stylesXml heading and title output correctness", () => {
  it("heading styles reflect per-heading font overrides", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    fc.assert(
      fc.property(
        fc.array(fontName, { minLength: 1, maxLength: 6 }),
        (fonts) => {
          const headingFonts = new Map<string, string>();
          const ids = [
            "Heading1",
            "Heading2",
            "Heading3",
            "Heading4",
            "Heading5",
            "Heading6",
          ];
          for (let i = 0; i < 6; i++) {
            const f = i < fonts.length ? fonts[i] : fonts[fonts.length - 1];
            headingFonts.set(ids[i], f);
          }
          const overrides: FontOverrides = { headingFonts };
          const xml = stylesXml(overrides);
          for (let i = 0; i < 6; i++) {
            const block = extractStyleBlock(xml, ids[i]);
            expect(block).not.toBeNull();
            const rpr = extractRPr(block!);
            const expectedFont =
              i < fonts.length ? fonts[i] : fonts[fonts.length - 1];
            expect(rpr).toContain('w:ascii="' + expectedFont + '"');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("heading styles reflect per-heading style overrides", () => {
    const styleValues = [
      "bold",
      "italic",
      "underline",
      "normal",
      "bold-italic",
      "bold-underline",
      "italic-underline",
      "bold-italic-underline",
      "smallcaps",
      "allcaps",
      "bold-smallcaps",
      "bold-allcaps",
      "italic-smallcaps",
      "center",
      "bold-center",
      "bold-italic-center",
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...styleValues), {
          minLength: 1,
          maxLength: 6,
        }),
        (styles) => {
          const headingStyles = new Map<string, string>();
          const ids = [
            "Heading1",
            "Heading2",
            "Heading3",
            "Heading4",
            "Heading5",
            "Heading6",
          ];
          for (let i = 0; i < 6; i++) {
            const s = i < styles.length ? styles[i] : styles[styles.length - 1];
            headingStyles.set(ids[i], s);
          }
          const overrides: FontOverrides = { headingStyles };
          const xml = stylesXml(overrides);
          for (let i = 0; i < 6; i++) {
            const block = extractStyleBlock(xml, ids[i]);
            expect(block).not.toBeNull();
            const rpr = extractRPr(block!);
            const s = i < styles.length ? styles[i] : styles[styles.length - 1];
            if (s === "normal") {
              expect(rpr).not.toContain("<w:b/>");
              expect(rpr).not.toContain("<w:i/>");
              expect(rpr).not.toContain("<w:u ");
              expect(rpr).not.toContain("<w:smallCaps/>");
              expect(rpr).not.toContain("<w:caps/>");
            } else {
              if (s.includes("bold")) expect(rpr).toContain("<w:b/>");
              else expect(rpr).not.toContain("<w:b/>");
              if (s.includes("italic")) expect(rpr).toContain("<w:i/>");
              else expect(rpr).not.toContain("<w:i/>");
              if (s.includes("underline"))
                expect(rpr).toContain('<w:u w:val="single"/>');
              else expect(rpr).not.toContain("<w:u ");
              // smallcaps/allcaps: check smallcaps first since 'smallcaps' contains 'allcaps' as substring
              if (s.includes("smallcaps")) {
                expect(rpr).toContain("<w:smallCaps/>");
                expect(rpr).not.toContain("<w:caps/>");
              } else if (s.includes("allcaps")) {
                expect(rpr).toContain("<w:caps/>");
                expect(rpr).not.toContain("<w:smallCaps/>");
              } else {
                expect(rpr).not.toContain("<w:smallCaps/>");
                expect(rpr).not.toContain("<w:caps/>");
              }
              // center: paragraph-level property in pPr
              const ppr = extractPPr(block!);
              if (s.includes("center")) {
                expect(ppr).toContain('<w:jc w:val="center"/>');
              } else {
                expect(ppr).not.toContain('<w:jc w:val="center"/>');
              }
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("default heading style is bold when no override", () => {
    const xml = stylesXml();
    const ids = [
      "Heading1",
      "Heading2",
      "Heading3",
      "Heading4",
      "Heading5",
      "Heading6",
    ];
    for (const id of ids) {
      const block = extractStyleBlock(xml, id);
      expect(block).not.toBeNull();
      const rpr = extractRPr(block!);
      expect(rpr).toContain("<w:b/>");
    }
  });

  it("title style reflects title font/style overrides", () => {
    const overrides: FontOverrides = {
      titleFonts: ["Georgia"],
      titleSizesHp: [48],
      titleStyles: ["bold-italic"],
    };
    const xml = stylesXml(overrides);
    const block = extractStyleBlock(xml, "Title");
    expect(block).not.toBeNull();
    const rpr = extractRPr(block!);
    expect(rpr).toContain('w:ascii="Georgia"');
    expect(rpr).toContain('<w:sz w:val="48"/>');
    expect(rpr).toContain("<w:b/>");
    expect(rpr).toContain("<w:i/>");
  });
});

// Feature: header-font-config, Property 12: Template application preserves unmodified styles
describe("Property 12: Template application preserves unmodified styles", () => {
  // Build a minimal template styles.xml with heading styles
  function buildTemplateXml(headingFonts: Record<string, string>): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>';
    xml +=
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">';
    xml += '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">';
    xml +=
      '<w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>';
    const ids = [
      "Heading1",
      "Heading2",
      "Heading3",
      "Heading4",
      "Heading5",
      "Heading6",
    ];
    for (const id of ids) {
      const font = headingFonts[id] || "Calibri";
      xml += '<w:style w:type="paragraph" w:styleId="' + id + '">';
      xml += '<w:name w:val="heading"/><w:basedOn w:val="Normal"/>';
      xml +=
        '<w:rPr><w:b/><w:rFonts w:ascii="' +
        font +
        '" w:hAnsi="' +
        font +
        '"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>';
    }
    xml += '<w:style w:type="paragraph" w:styleId="Title">';
    xml += '<w:name w:val="Title"/><w:basedOn w:val="Normal"/>';
    xml +=
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>';
    xml += "</w:styles>";
    return xml;
  }

  it("modifies only styles with overrides, preserves others", () => {
    const fontName = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-z]+$/.test(s));
    fc.assert(
      fc.property(
        fontName,
        fc.integer({ min: 1, max: 6 }),
        (newFont, headingIdx) => {
          const styleId = "Heading" + headingIdx;
          const headingFonts = new Map<string, string>();
          headingFonts.set(styleId, newFont);
          const overrides: FontOverrides = { headingFonts };
          const templateXml = buildTemplateXml({});
          const bytes = new TextEncoder().encode(templateXml);
          const result = applyFontOverridesToTemplate(bytes, overrides);
          // Modified style should have new font
          const modifiedBlock = extractStyleBlock(result, styleId);
          expect(modifiedBlock).not.toBeNull();
          expect(modifiedBlock).toContain('w:ascii="' + newFont + '"');
          // Unmodified styles should keep original font
          for (let i = 1; i <= 6; i++) {
            const otherId = "Heading" + i;
            if (otherId === styleId) continue;
            const otherBlock = extractStyleBlock(result, otherId);
            expect(otherBlock).not.toBeNull();
            expect(otherBlock).toContain('w:ascii="Calibri"');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("applies heading style overrides (bold/italic/underline)", () => {
    const headingStyles = new Map<string, string>();
    headingStyles.set("Heading1", "italic");
    const overrides: FontOverrides = { headingStyles };
    const templateXml = buildTemplateXml({});
    const bytes = new TextEncoder().encode(templateXml);
    const result = applyFontOverridesToTemplate(bytes, overrides);
    const h1Block = extractStyleBlock(result, "Heading1");
    expect(h1Block).not.toBeNull();
    const rpr = extractRPr(h1Block!);
    expect(rpr).toContain("<w:i/>");
    expect(rpr).not.toContain("<w:b/>");
    // Heading2 should still have bold (unchanged)
    const h2Block = extractStyleBlock(result, "Heading2");
    expect(h2Block).not.toBeNull();
    expect(extractRPr(h2Block!)).toContain("<w:b/>");
  });

  it("applies title font/style overrides", () => {
    const overrides: FontOverrides = {
      titleFonts: ["Georgia"],
      titleSizesHp: [48],
      titleStyles: ["bold-underline"],
    };
    const templateXml = buildTemplateXml({});
    const bytes = new TextEncoder().encode(templateXml);
    const result = applyFontOverridesToTemplate(bytes, overrides);
    const titleBlock = extractStyleBlock(result, "Title");
    expect(titleBlock).not.toBeNull();
    const rpr = extractRPr(titleBlock!);
    expect(rpr).toContain('w:ascii="Georgia"');
    expect(rpr).toContain('<w:sz w:val="48"/>');
    expect(rpr).toContain("<w:b/>");
    expect(rpr).toContain('<w:u w:val="single"/>');
  });

  it("preserves Title when no title overrides", () => {
    const overrides: FontOverrides = { bodyFont: "Palatino" };
    const templateXml = buildTemplateXml({});
    const bytes = new TextEncoder().encode(templateXml);
    const result = applyFontOverridesToTemplate(bytes, overrides);
    const titleBlock = extractStyleBlock(result, "Title");
    expect(titleBlock).not.toBeNull();
    // Body font should be applied to Title (since it's in BODY_STYLE_IDS)
    expect(titleBlock).toContain('w:ascii="Palatino"');
    // Size should be preserved
    expect(titleBlock).toContain('<w:sz w:val="56"/>');
  });
});

// Feature: header-font-config, Property 14: Full pipeline round-trip (md→docx→md)
import { convertMdToDocx } from "./md-to-docx";
import { convertDocx } from "./converter";

describe("Property 14: Full pipeline round-trip (md→docx→md)", () => {
  it("header font fields survive md→docx→md round-trip", async () => {
    const fm: Frontmatter = {
      title: ["Test Document"],
      headerFont: ["Georgia", "Palatino"],
      headerFontSize: [24, 18],
      headerFontStyle: ["bold-italic", "italic"],
    };
    const yaml = serializeFrontmatter(fm);
    const md = yaml + "\n# Heading 1\n\n## Heading 2\n\nBody text.";
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.headerFont).toEqual(["Georgia", "Palatino"]);
    expect(metadata.headerFontSize).toEqual([24, 18]);
    expect(metadata.headerFontStyle).toEqual(["bold-italic", "italic"]);
  });

  it("smallcaps/allcaps header font styles survive md→docx→md round-trip", async () => {
    const fm: Frontmatter = {
      title: ["Test Document"],
      headerFontStyle: ["bold-smallcaps", "allcaps"],
    };
    const yaml = serializeFrontmatter(fm);
    const md = yaml + "\n# Heading 1\n\n## Heading 2\n\nBody text.";
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.headerFontStyle).toEqual(["bold-smallcaps", "allcaps"]);
  });

  it("center header font style survives md→docx→md round-trip", async () => {
    const fm: Frontmatter = {
      title: ["Test Document"],
      headerFontStyle: ["bold-center", "center"],
    };
    const yaml = serializeFrontmatter(fm);
    const md = yaml + "\n# Heading 1\n\n## Heading 2\n\nBody text.";
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.headerFontStyle).toEqual(["bold-center", "center"]);
  });

  it("title font fields survive md→docx→md round-trip", async () => {
    const fm: Frontmatter = {
      title: ["My Title"],
      titleFont: ["Georgia"],
      titleFontSize: [24],
      titleFontStyle: ["bold"],
    };
    const yaml = serializeFrontmatter(fm);
    const md = yaml + "\nBody text.";
    const { docx } = await convertMdToDocx(md);
    const { markdown } = await convertDocx(docx);
    const { metadata } = parseFrontmatter(markdown);
    expect(metadata.titleFont).toEqual(["Georgia"]);
    expect(metadata.titleFontSize).toEqual([24]);
    expect(metadata.titleFontStyle).toEqual(["bold"]);
  });
});
