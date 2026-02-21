# Implementation Plan: DOCX Font Customization

## Overview

Implement four YAML frontmatter fields (`font`, `code-font`, `font-size`, `code-font-size`) for controlling typography in DOCX exports. Changes are contained within `src/frontmatter.ts`, `src/md-to-docx.ts`, and `docs/specification.md`, with new test files for property-based and unit tests.

## Tasks

- [x] 1. Extend Frontmatter interface and parsing
  - [x] 1.1 Add `font`, `codeFont`, `fontSize`, `codeFontSize` optional fields to the `Frontmatter` interface in `src/frontmatter.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Add `case` branches in `parseFrontmatter()` for `font`, `code-font`, `font-size`, `code-font-size`
    - `font` / `code-font`: store non-empty string value
    - `font-size` / `code-font-size`: `parseFloat(value)`, accept only if `isFinite()` and `> 0`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.3 Add serialization of font fields in `serializeFrontmatter()`
    - Emit `font`, `code-font`, `font-size`, `code-font-size` YAML keys when present
    - _Requirements: 5.1, 5.2_

  - [x] 1.4 Write property test: font string field parsing (Property 1)
    - **Property 1: Font string field parsing**
    - Generate random non-empty strings, build frontmatter YAML, parse, verify `font`/`codeFont` fields
    - **Validates: Requirements 1.1, 1.2**

  - [x] 1.5 Write property test: numeric size field parsing (Property 2)
    - **Property 2: Numeric size field parsing**
    - Generate random positive numbers, build frontmatter YAML, parse, verify `fontSize`/`codeFontSize` fields
    - **Validates: Requirements 1.3, 1.4**

  - [x] 1.6 Write property test: non-numeric size rejection (Property 3)
    - **Property 3: Non-numeric size rejection**
    - Generate non-numeric strings, build frontmatter YAML, parse, verify size fields are `undefined`
    - **Validates: Requirements 1.5, 1.6**

  - [x] 1.7 Write property test: frontmatter font field round-trip (Property 9)
    - **Property 9: Frontmatter font field round-trip**
    - Generate random Frontmatter objects with font fields, serialize then parse, verify equivalence
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [x] 2. Implement font override resolution
  - [x] 2.1 Add `FontOverrides` interface and `resolveFontOverrides()` pure function in `src/md-to-docx.ts`
    - Define constants for default sizes in half-points (Normal=22, H1=32, H2=26, H3=24, H4=22, H5=20, H6=18, Title=56, FootnoteText=20, EndnoteText=20, CodeBlock=20)
    - Implement code-font-size inference: when `fontSize` set without `codeFontSize`, `codeSizeHp = bodySizeHp - 2` (clamped to minimum 1hp)
    - Implement proportional heading scaling: `Math.round(defaultHeadingHp / 22 * bodySizeHp)`
    - Return `undefined` when no font fields are set
    - _Requirements: 2.1, 2.2, 2.3, 3.3, 3.4_

  - [x] 2.2 Write property test: code-font-size inference (Property 4)
    - **Property 4: Code-font-size inference**
    - Generate random positive font sizes, call `resolveFontOverrides` with various combinations, verify inference rules
    - **Validates: Requirements 2.1, 2.2, 2.3**

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Apply font overrides to generated styles
  - [x] 4.1 Modify `stylesXml()` to accept optional `FontOverrides` parameter
    - When `bodyFont` set: add `w:rFonts` with `ascii`/`hAnsi` to all non-code styles (Normal, Heading1–6, Title, Quote, IntenseQuote, FootnoteText, EndnoteText)
    - When `codeFont` set: add `w:rFonts` with `ascii`/`hAnsi` to CodeChar and CodeBlock
    - When `bodySizeHp` set: set `w:sz`/`w:szCs` in Normal; apply proportional sizes to headings, Title, FootnoteText, EndnoteText from `headingSizesHp`
    - When `codeSizeHp` set: set `w:sz`/`w:szCs` in CodeBlock
    - When no overrides: produce styles identical to current defaults
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 4.2 Write property test: body font application to non-code styles (Property 5)
    - **Property 5: Body font application to non-code styles**
    - Generate random font names, call `stylesXml` with body font override, parse output XML to verify `w:rFonts` placement
    - **Validates: Requirements 3.1**

  - [x] 4.3 Write property test: code font application to code styles (Property 6)
    - **Property 6: Code font application to code styles**
    - Generate random font names, call `stylesXml` with code font override, parse output XML to verify `w:rFonts` placement
    - **Validates: Requirements 3.2**

  - [x] 4.4 Write property test: size and heading proportional scaling (Property 7)
    - **Property 7: Size and heading proportional scaling**
    - Generate random positive body sizes, call `stylesXml`, parse output XML to verify proportional heading sizes
    - **Validates: Requirements 3.3, 3.4, 3.5**

- [x] 5. Implement template font override
  - [x] 5.1 Add `applyFontOverridesToTemplate()` function in `src/md-to-docx.ts`
    - Decode template `styles.xml` bytes to string
    - Parse `<w:style>` elements by `w:styleId`
    - Insert/replace `w:rFonts` and `w:sz`/`w:szCs` in `<w:rPr>` for matching styles
    - Non-code styles get body font/size overrides; code styles get code font/size overrides
    - Skip styles not present in template
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 5.2 Write property test: template font override application (Property 8)
    - **Property 8: Template font override application**
    - Generate font overrides, apply to a template styles XML, verify targeted styles are modified and others unchanged
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [x] 6. Wire integration in convertMdToDocx
  - [x] 6.1 Integrate `resolveFontOverrides()` and font override application into `convertMdToDocx()`
    - Call `resolveFontOverrides(frontmatter)` after frontmatter parsing
    - When template provided with overrides: call `applyFontOverridesToTemplate()`
    - When template provided without overrides: pass through unmodified
    - When no template: pass overrides to `stylesXml(fontOverrides)`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4_

  - [x] 6.2 Write unit tests for font customization
    - Test default behavior: no font fields → styles identical to current output
    - Test specific example: `font-size: 14` → Normal=28hp, H1=41hp, CodeBlock=26hp
    - Test edge cases: `font-size: abc`, `font-size: -5`, `font-size: 0` → ignored
    - Test edge case: `font-size: 1` → code-font-size clamped to minimum
    - Test template passthrough: template with no overrides → unmodified
    - Test integration: full `convertMdToDocx` with font frontmatter → verify styles in output DOCX ZIP
    - _Requirements: 1.5, 1.6, 2.1, 3.3, 3.5, 3.6, 4.2_

- [x] 7. Update specification documentation
  - [x] 7.1 Update `docs/specification.md` with font frontmatter fields
    - Add `font`, `code-font`, `font-size`, `code-font-size` to the YAML Frontmatter field table with descriptions and defaults
    - Document code-font-size inference behavior
    - Add example YAML frontmatter block demonstrating font customization
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 8. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with short bounded generators (maxLength: 20, sizes 0.5–72) per AGENTS.md guidance
- All property tests go in `src/font-customization.property.test.ts`; unit tests in `src/font-customization.test.ts`
- No new source files needed — implementation changes are in `src/frontmatter.ts` and `src/md-to-docx.ts`
