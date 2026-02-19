# Implementation Plan

- [ ] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - Code Region Inertness
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate CriticMarkup/highlight/citation syntax inside code regions is incorrectly processed
  - **Scoped PBT Approach**: Generate documents containing CriticMarkup patterns (`{++...++}`, `{--...--}`, `{~~...~>...~~}`, `{>>...<<}`, `{==...==}`, `==...==`, `==...=={color}`) and citation patterns (`[@key]`) placed inside inline code spans (`` `...` ``) and fenced code blocks (`` ``` ``). Use fast-check with bounded generators per AGENTS.md guidance.
  - Create test file `src/code-regions.property.test.ts`
  - Import `extractAllDecorationRanges` from `./highlight-colors` and `scanCitationUsages` from `./lsp/citekey-language`
  - For `extractAllDecorationRanges`: assert that no returned range (highlights, comments, additions, deletions, substitutionNew, delimiters) overlaps any code region in the input text
  - For `scanCitationUsages`: assert that no returned usage has `keyStart`/`keyEnd` overlapping any code region
  - For navigation (`getAllMatches` pattern): replicate the `combinedPattern` regex from `src/changes.ts` in a test-local scanner (same approach as `changes.property.test.ts`) and assert no match overlaps a code region
  - Write a helper `computeCodeRegionsForTest(text)` that identifies inline code spans and fenced code blocks (CommonMark rules) to use as the oracle
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists in all three subsystems)
  - Document counterexamples found (e.g., `extractAllDecorationRanges` returns addition ranges inside `` `{++text++}` ``)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.10_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Code-Region Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - **IMPORTANT**: Write this test BEFORE implementing the fix
  - Observe: call `extractAllDecorationRanges` on text with CriticMarkup/highlights but NO code regions on unfixed code — record results
  - Observe: run `combinedPattern` regex (test-local scanner from `changes.property.test.ts` approach) on text with CriticMarkup but NO code regions — record results
  - Observe: call `scanCitationUsages` on text with `[@key]` patterns but NO code regions — record results
  - Write property-based tests in `src/code-regions.property.test.ts` (append to same file):
    - Generate random documents containing CriticMarkup/highlight/citation patterns with NO inline code spans and NO fenced code blocks (use generators from existing `highlight-colors.property.test.ts` as reference — `safeContent`, `criticHighlight`, `criticComment`, `criticAddition`, `criticDeletion`, `formatHighlight`, `coloredHighlight`)
    - Assert `extractAllDecorationRanges(text, defaultColor)` returns identical results before and after fix (snapshot the unfixed function output as baseline)
    - Assert test-local navigation scanner returns identical match set before and after fix
    - Assert `scanCitationUsages(text)` returns identical usages before and after fix
  - Since we cannot snapshot the unfixed function at test time, use the approach: for texts with NO code regions, the fixed functions should produce the same output as a fresh call (idempotence) — the fix only filters code-region matches, so no-code-region texts are unaffected
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7_

- [ ] 3. Implement shared code region detection utility
  - [ ] 3.1 Create `src/code-regions.ts` with `computeCodeRegions()` and `isInsideCodeRegion()`
    - `computeCodeRegions(text: string): Array<{start: number, end: number}>` — returns sorted array of code region ranges
    - Detect fenced code blocks first (lines starting with `` ``` `` or `~~~`, track open/close pairs, include fences in range)
    - Detect inline code spans in remaining text (CommonMark §6.1 backtick string matching — opening backtick string matched with equal-length closing string, include backticks in range)
    - Fenced blocks take priority; inline spans only detected outside fenced blocks
    - `isInsideCodeRegion(offset: number, regions: Array<{start, end}>): boolean` — binary search for O(log n) lookup
    - Export both functions
    - _Bug_Condition: isBugCondition(input) where matchStart/matchEnd overlaps a code region_
    - _Expected_Behavior: computeCodeRegions correctly identifies all inline code spans and fenced code blocks_
    - _Preservation: Only code regions are identified; no false positives for backticks in non-code contexts_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.10_

  - [ ] 3.2 Write unit tests for `computeCodeRegions()` and `isInsideCodeRegion()`
    - Test inline code: `` `code` ``, ``` ``code`` ```, backticks containing CriticMarkup
    - Test fenced code blocks: `` ``` `` and `~~~` delimiters, with and without language tags
    - Test mixed: document with both inline code and fenced blocks
    - Test edge cases: empty code spans, nested backticks, unclosed fences
    - Test `isInsideCodeRegion` at boundary positions (start, end, just inside, just outside)
    - _Requirements: 2.1, 2.2, 2.3_

- [ ] 4. Fix editor decorations — `extractAllDecorationRanges()`
  - [ ] 4.1 Add code-region skipping to `extractAllDecorationRanges` in `src/highlight-colors.ts`
    - Import `computeCodeRegions` from `./code-regions`
    - Compute code regions at the start of the function
    - In the main `while (i < len)` char-by-char loop: when `i` enters a code region, advance `i` to the end of that region (skip the entire code region)
    - Also ensure `scanFormatHighlights` respects code region boundaries (though in practice, if the outer loop skips code regions, `scanFormatHighlights` won't be called with code-region ranges)
    - _Bug_Condition: CriticMarkup/highlight syntax inside inline code or fenced code block_
    - _Expected_Behavior: No decoration ranges overlap any code region_
    - _Preservation: Decorations outside code regions unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2_

  - [ ] 4.2 Write unit tests for decoration skipping
    - Test `extractAllDecorationRanges` with `` `{++added++}` `` — expect no addition ranges
    - Test with `` `==highlighted==` `` — expect no highlight ranges
    - Test with `` `{>>comment<<}` `` — expect no comment ranges
    - Test with fenced code block containing `{--deleted--}` — expect no deletion ranges
    - Test with CriticMarkup both inside and outside code — expect only outside ranges returned
    - Test CriticMarkup surrounding a code span (e.g., `{==` `` `code` `` `==}`) — expect decoration ranges preserved (delimiters are outside code)
    - _Requirements: 2.1, 2.2, 2.3, 3.3_

- [ ] 5. Fix navigation — `getAllMatches()`
  - [ ] 5.1 Add code-region filtering to `getAllMatches` in `src/changes.ts`
    - Import `computeCodeRegions` from `./code-regions`
    - After the regex scan loop, compute code regions from the document text
    - Filter out any match whose `[match.index, match.index + match[0].length)` range overlaps a code region
    - Apply filtering before the contained-range dedup pass
    - Cache invalidation already handles this (keyed on document version)
    - _Bug_Condition: CriticMarkup/highlight syntax inside code regions matched by navigation regex_
    - _Expected_Behavior: No navigation matches overlap any code region_
    - _Preservation: Navigation matches outside code regions unchanged_
    - _Requirements: 2.4, 3.1, 3.2_

  - [ ] 5.2 Write unit tests for navigation filtering
    - Test `getAllMatches` (via test-local scanner replicating the regex + filter logic) with CriticMarkup inside inline code — expect no matches
    - Test with CriticMarkup inside fenced code block — expect no matches
    - Test with CriticMarkup both inside and outside code — expect only outside matches
    - _Requirements: 2.4, 3.1_

- [ ] 6. Fix LSP — `scanCitationUsages()` and `findCitekeyAtOffset()`
  - [ ] 6.1 Add code-region filtering to `scanCitationUsages` in `src/lsp/citekey-language.ts`
    - Import `computeCodeRegions` from `../code-regions`
    - Compute code regions from the input text
    - Filter out any usage whose `keyStart`–`keyEnd` range overlaps a code region
    - _Bug_Condition: Citation key `[@key]` inside inline code or fenced code block_
    - _Expected_Behavior: No citation usages overlap any code region_
    - _Preservation: Citation usages outside code regions unchanged_
    - _Requirements: 2.10, 3.6_

  - [ ] 6.2 Add code-region awareness to `findCitekeyAtOffset` in `src/lsp/citekey-language.ts`
    - Compute code regions from the text
    - If the offset falls inside a code region, return undefined (no citekey at this position)
    - _Bug_Condition: Cursor positioned on `@key` inside a code region_
    - _Expected_Behavior: No completion/hover/reference results for citations inside code_
    - _Requirements: 2.10_

  - [ ] 6.3 Write unit tests for LSP code-region filtering
    - Test `scanCitationUsages` with `` `[@smith2020]` `` — expect no usages
    - Test with `[@smith2020]` outside code — expect usage returned
    - Test with citations both inside and outside code — expect only outside usages
    - Test `findCitekeyAtOffset` at position inside `` `@key` `` — expect undefined
    - _Requirements: 2.10, 3.6_

- [ ] 7. Fix DOCX→MD converter — formatting stripping and comment boundary expansion
  - [ ] 7.1 Strip non-code formatting in `wrapWithFormatting` in `src/converter.ts`
    - When `fmt.code` is true, skip all other formatting wrapping (highlight, bold, italic, strikethrough, underline, superscript, subscript)
    - Only apply the backtick fence for code runs
    - This ensures DOCX code runs with incidental formatting (e.g., bold code in Word) emit clean `` `code` `` without `**` or `==` wrappers
    - _Bug_Condition: DOCX run has `code: true` AND other formatting flags (bold, italic, highlight, etc.)_
    - _Expected_Behavior: Output is plain `` `code` `` with no formatting wrappers_
    - _Preservation: Non-code runs with formatting continue to emit wrappers as before_
    - _Requirements: 2.6, 3.5_

  - [ ] 7.2 Implement comment boundary expansion for code runs in `src/converter.ts`
    - During markdown assembly in `buildMarkdown` (or a new helper), detect when a comment boundary (start/end marker) would fall inside a code span
    - Comment fully inside code → expand both boundaries to surround the entire `` `code` `` span, emitting `{==` `` `code` `` `==}{>>comment<<}`
    - Comment end inside code → move end marker to after the closing backtick(s)
    - Comment start inside code → move start marker to before the opening backtick(s)
    - This is a lossy transformation — document as intentional (precise anchoring within code text is lost)
    - _Bug_Condition: Comment boundary falls inside a code-styled run in DOCX_
    - _Expected_Behavior: Comment boundaries are outside code regions in output markdown_
    - _Preservation: Comments outside code regions emit unchanged_
    - _Requirements: 2.7, 2.8, 2.9, 3.5_

  - [ ] 7.3 Write unit tests for DOCX→MD formatting stripping and comment expansion
    - Test `wrapWithFormatting('text', { code: true, bold: true })` — expect `` `text` `` (no `**`)
    - Test `wrapWithFormatting('text', { code: true, highlight: true })` — expect `` `text` `` (no `==`)
    - Test `wrapWithFormatting('text', { code: true, italic: true, strikethrough: true })` — expect `` `text` `` (no `*` or `~~`)
    - Test `wrapWithFormatting('text', { code: false, bold: true })` — expect `**text**` (unchanged)
    - Test comment fully inside code run — expect expanded to surround code span
    - Test comment starting before code, ending inside — expect end expanded
    - Test comment starting inside code, ending after — expect start expanded
    - Test comment outside code — expect unchanged
    - _Requirements: 2.6, 2.7, 2.8, 2.9, 3.5_

- [ ] 8. Verify preview rendering and MD→DOCX converter (no changes expected)
  - [ ] 8.1 Verify markdown-it preview plugin handles code regions correctly
    - Confirm that markdown-it's built-in `backtick` rule consumes inline code content before custom `parseManuscriptMarkdown` and `parseFormatHighlight` rules fire
    - Confirm that fenced code blocks are handled at block level and content is never passed to inline rules
    - Write a verification test: render `` `{++added++}` `` through markdown-it with the plugin — expect `<code>{++added++}</code>` (literal text, not `<ins>`)
    - If edge cases are found, add guards; otherwise document that no changes are needed
    - _Requirements: 2.11, 3.1_

  - [ ] 8.2 Verify MD→DOCX converter handles code regions correctly
    - Confirm that `processInlineChildren` in `src/md-to-docx.ts` handles `code_inline` tokens by creating `{ type: 'text', code: true }` runs without CriticMarkup interpretation
    - Confirm that `convertTokens` handles `fence` tokens at block level with plain text runs
    - Write a verification test if feasible; otherwise document that markdown-it's token architecture provides sufficient protection
    - _Requirements: 2.5, 3.4_

- [ ] 9. Add documentation for comment boundary expansion
  - [ ] 9.1 Add section to `docs/converter.md` about comment boundary expansion
    - Document under "Known Limitations" that comments anchored inside code runs are expanded to surround the code span
    - Explain that CriticMarkup cannot appear inside code regions, so this is an intentional lossy transformation
    - Provide examples of the three expansion cases (fully inside, end inside, start inside)
    - _Requirements: 2.7, 2.8, 2.9_

- [ ] 10. Verify bug condition exploration test now passes
  - **Property 1: Expected Behavior** - Code Region Inertness
  - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
  - The test from task 1 encodes the expected behavior: no decoration/navigation/LSP ranges overlap code regions
  - When this test passes, it confirms the expected behavior is satisfied across all three subsystems
  - Run bug condition exploration test from step 1
  - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.10_

- [ ] 11. Verify preservation tests still pass
  - **Property 2: Preservation** - Non-Code-Region Behavior Unchanged
  - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
  - Run preservation property tests from step 2
  - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
  - Confirm all tests still pass after fix (no regressions)
  - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7_

- [ ] 12. Checkpoint — Ensure all tests pass
  - Run full test suite with `bun test`
  - Ensure all existing property tests still pass (especially `highlight-colors.property.test.ts`, `changes.property.test.ts`, `converter.property.test.ts`)
  - Ensure new code-region property tests pass (both fault condition and preservation)
  - Ensure all new unit tests pass
  - Ask the user if questions arise
