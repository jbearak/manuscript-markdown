# Implementation Plan: DOCX Formatting Conversion

## Overview

Extend the mdmarkup converter to handle rich DOCX formatting (bold, italic, underline, strikethrough, highlight, superscript, subscript, hyperlinks, headings, lists) and add `==highlight==` editor support (command, syntax highlighting, preview rendering). Implementation is incremental: types first, then extraction helpers, then buildMarkdown updates, then editor features, with tests woven in throughout.

## Tasks

- [x] 1. Extend ContentItem types and add formatting helpers
  - [x] 1.1 Add `RunFormatting` interface, `ListMeta` interface, and update `ContentItem` type union in `src/converter.ts`
  - [x] 1.2 Implement `isToggleOn()`, `parseRunProperties()`, and `wrapWithFormatting()` helper functions in `src/converter.ts`
  - [x] 1.3 Write property tests for `wrapWithFormatting()`

- [x] 2. Implement XML parsing helpers for relationships and numbering
  - [x] 2.1 Implement `parseRelationships()` in `src/converter.ts`
  - [x] 2.2 Implement `parseNumberingDefinitions()` in `src/converter.ts`
  - [x] 2.3 Implement `parseHeadingLevel()` and `parseListMeta()` helpers in `src/converter.ts`

- [x] 3. Update `extractDocumentContent()` to populate formatting metadata
  - [x] 3.1 Update `extractDocumentContent()` to call `parseRelationships()` and `parseNumberingDefinitions()` at the start
  - [x] 3.2 Update the walk function to read `w:rPr` from each run and populate `RunFormatting`
  - [x] 3.3 Update the walk function to handle `w:hyperlink` nodes
  - [x] 3.4 Update the walk function to read `w:pPr` for headings and lists

- [x] 4. Update `buildMarkdown()` to render formatting, hyperlinks, headings, and lists
  - [x] 4.1 Add run merging logic to `buildMarkdown()`
  - [x] 4.2 Update text item rendering to apply formatting delimiters and hyperlink syntax
  - [x] 4.3 Update para item rendering for headings and lists
  - [x] 4.4 Write property tests for `buildMarkdown()` formatting and structure

- [x] 5. Checkpoint - Ensure converter tests pass

- [x] 6. Add end-to-end fixture tests for `formatting_sample.docx`
  - [x] 6.1 Add end-to-end test in `src/converter.test.ts` that converts `test/fixtures/formatting_sample.docx` and verifies formatting output
  - [x] 6.2 Write unit tests for edge cases

- [x] 7. Add `==highlight==` editor command and menu entry
  - [x] 7.1 Register `mdmarkup.formatHighlight` command in `src/extension.ts` and add to `package.json`
  - [x] 7.2 Write property test for highlight formatting command

- [x] 8. Add `==highlight==` syntax highlighting in TextMate grammar
  - [x] 8.1 Add `format_highlight` pattern to `syntaxes/mdmarkup.json`

- [x] 9. Add `==highlight==` preview rendering
  - [x] 9.1 Add inline rule for `==…==` in `src/preview/mdmarkup-plugin.ts`
  - [x] 9.2 Add CSS styles for `.mdmarkup-format-highlight` in `media/mdmarkup.css`
  - [x] 9.3 Write property test for preview ==highlight== rendering

- [x] 10. Final checkpoint - Ensure all tests pass
    - Test highlight detection via w:shd with non-auto fill
    - Test unresolvable hyperlink r:id falls back to plain text
    - Test non-heading pStyle produces no # prefix
    - _Requirements: 1.3, 2.3, 3.2, 4.3, 5.2, 9.3, 10.3_

- [ ] 7. Add `==highlight==` editor command and menu entry
  - [ ] 7.1 Register `mdmarkup.formatHighlight` command in `src/extension.ts` and add to `package.json`
    - Add command registration: `wrapSelection(text, '==', '==')`
    - Add command declaration in `contributes.commands`
    - Add menu entry in `markdown.formatting` submenu at `1_format@6`
    - Shift inline code to `1_format@7` and code block to `1_format@8`
    - _Requirements: 14.1, 14.2, 14.3_
  - [ ]* 7.2 Write property test for highlight formatting command
    - **Property 9: Highlight formatting command wraps with == delimiters**
    - **Validates: Requirements 14.1**

- [ ] 8. Add `==highlight==` syntax highlighting in TextMate grammar
  - [ ] 8.1 Add `format_highlight` pattern to `syntaxes/mdmarkup.json`
    - Match `==…==` but NOT `{==…==}` using negative lookbehind for `{`
    - Assign scope `markup.highlight.mdmarkup`
    - Add to top-level patterns array
    - _Requirements: 15.1, 15.2, 15.3_

- [ ] 9. Add `==highlight==` preview rendering
  - [ ] 9.1 Add inline rule for `==…==` in `src/preview/mdmarkup-plugin.ts`
    - Detect `==` at current position, but only when NOT preceded by `{`
    - Find closing `==` (not followed by `}`)
    - Emit `mdmarkup_format_highlight_open` / `_close` tokens with `<mark>` tag and `mdmarkup-format-highlight` CSS class
    - Register renderer rules for the new token types
    - _Requirements: 16.1, 16.3_
  - [ ] 9.2 Add CSS styles for `.mdmarkup-format-highlight` in `media/mdmarkup.css`
    - Light theme: yellow/amber background (distinct from purple CriticMarkup highlight)
    - Dark theme: darker amber background
    - _Requirements: 16.2_
  - [ ]* 9.3 Write property test for preview ==highlight== rendering
    - **Property 10: Preview ==highlight== rendering**
    - **Validates: Requirements 16.1**

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- Per AGENTS.md: use `bun test` to run tests, use bounded `fast-check` generators to avoid timeouts
