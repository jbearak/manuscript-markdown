# Implementation Plan

> Requirement numbers (e.g., 1.1, 2.3, 3.5) refer to [bugfix.md](./bugfix.md).

- [x] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - HTML Comments Dropped During MD → DOCX Conversion
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate HTML comments are silently dropped
  - **Scoped PBT Approach**: Use fast-check with short bounded generators (per AGENTS.md) to generate HTML comment content and verify roundtrip behavior
  - Create test file `src/html-comment-roundtrip.property.test.ts`
  - Import `parseMd`, `MdRun` from `./md-to-docx`
  - Property: for any short alphanumeric comment text `c`, parsing `text <!-- ${c} --> more` through `parseMd()` and inspecting the resulting `MdToken[]` runs should yield a run containing the comment content — but on unfixed code, no `html_comment` run exists (comment is silently dropped)
  - Also test standalone block comments: `<!-- ${c} -->` parsed as `html_block` should produce a token preserving the comment — but on unfixed code, it produces nothing
  - Also test multiple inline comments: `A <!-- ${c1} --> B <!-- ${c2} --> C` — both should be present but are dropped
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found: e.g., `processInlineChildren()` produces no run for `html_inline` tokens containing `<!-- ... -->`
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Comment HTML Tags and Existing Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Create test file `src/html-comment-preservation.property.test.ts`
  - Import `parseMd`, `processInlineChildren`, `generateParagraph` from `./md-to-docx`
  - Observe on UNFIXED code: `<u>text</u>` produces an `MdRun` with `underline: true`; `<sup>text</sup>` produces `superscript: true`; `<sub>text</sub>` produces `subscript: true`
  - Observe on UNFIXED code: plain text paragraphs with no HTML comments produce identical `MdToken[]` output
  - Observe on UNFIXED code: `<!-- comment -->` inside backtick code spans (`` `<!-- c -->` ``) passes through as literal code content
  - Write property-based test (fast-check, short bounded generators per AGENTS.md):
    - Property 2a: For any short alphanumeric text, `<u>${text}</u>` parsed through `processInlineChildren()` produces a run with `underline: true` and the text content — formatting tag handling is preserved
    - Property 2b: For any short alphanumeric text, `<sup>${text}</sup>` produces `superscript: true` and `<sub>${text}</sub>` produces `subscript: true`
    - Property 2c: For any short alphanumeric text with no HTML comments, `parseMd()` output is stable (same input → same token structure)
  - Verify tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix for HTML comment roundtrip preservation

  - [x] 3.1 Add `html_comment` to `MdRun.type` union and handle in `processInlineChildren()`
    - Extend the `MdRun` `type` union to include `'html_comment'`
    - In `processInlineChildren()`, in the `html_inline` case, before checking for formatting tags (`<u>`, `<sup>`, `<sub>`), check if `token.content` starts with `<!--`
    - If so, push an `MdRun` with `type: 'html_comment'` and `text: token.content`
    - Existing formatting tag handling remains unchanged
    - _Bug_Condition: isBugCondition(input) where input.tokenType == 'html_inline' AND input.content matches `<!--...-->`_
    - _Expected_Behavior: processInlineChildren() produces an MdRun with type 'html_comment' for HTML comment tokens_
    - _Preservation: Existing `<u>`, `<sup>`, `<sub>` handling must remain unchanged_
    - _Requirements: 2.1, 2.4, 3.2_

  - [x] 3.2 Handle `html_block` comments in `convertTokens()`
    - In the `html_block` case, before calling `extractHtmlTables()`, check if `token.content` matches an HTML comment pattern (`<!--...-->`)
    - If so, create a paragraph `MdToken` with an `html_comment` run carrying the comment content
    - Existing HTML table handling remains unchanged
    - _Bug_Condition: isBugCondition(input) where input.tokenType == 'html_block' AND input.content matches `<!--...-->`_
    - _Expected_Behavior: convertTokens() produces a paragraph MdToken with html_comment run for standalone HTML comments_
    - _Preservation: Existing HTML table extraction must remain unchanged_
    - _Requirements: 2.2, 3.3_

  - [x] 3.3 Emit vanish-styled runs in `generateRuns()` for `html_comment` type
    - Add an `html_comment` case in `generateRuns()`
    - Generate: `<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">\u200B<!-- comment --></w:t></w:r>`
    - The `\u200B` prefix marks this as a hidden comment carrier (same pattern as LaTeX comments in OMML)
    - _Bug_Condition: MdRun with type 'html_comment' has no handler in generateRuns()_
    - _Expected_Behavior: generateRuns() emits a vanish-styled w:r run with \u200B prefix for html_comment runs_
    - _Preservation: All other run type handling must remain unchanged_
    - _Requirements: 2.1, 2.2, 2.5_

  - [x] 3.4 Detect vanish runs in `extractDocumentContent()` in `src/converter.ts`
    - In the `w:r` handler, after parsing `w:rPr`, check for `<w:vanish/>` presence
    - If vanish is detected and the text starts with `\u200B`, extract the payload after the prefix
    - If the payload matches `<!-- ... -->`, push a `ContentItem` with the HTML comment text (or use a dedicated content item type)
    - Otherwise fall through to normal text handling
    - _Bug_Condition: extractDocumentContent() has no vanish run detection for HTML comments_
    - _Expected_Behavior: extractDocumentContent() detects vanish runs with \u200B prefix and restores HTML comment content_
    - _Preservation: Normal text runs and LaTeX OMML hidden runs must remain unchanged_
    - _Requirements: 2.3, 2.5, 3.4_

  - [x] 3.5 Restore HTML comments in markdown output during DOCX → MD conversion
    - Added a dedicated `'html_comment'` content item type to the `ContentItem` union (with `text` and `commentIds` fields) for clean type-safe separation
    - In both CriticMarkup and ID-based markdown renderers, `html_comment` items emit the raw `<!-- ... -->` syntax directly
    - Multi-line comment content (including internal newlines) is preserved
    - _Bug_Condition: DOCX → MD path has no logic to restore HTML comments from hidden runs_
    - _Expected_Behavior: Re-imported markdown contains the original `<!-- ... -->` at the correct position_
    - _Preservation: All other content item rendering must remain unchanged_
    - _Requirements: 2.3, 2.4, 2.5, 3.1, 3.7_

  - [x] 3.6 Ensure HTML comments inside inert zones are not processed
    - Verify that `<!-- -->` inside LaTeX math regions (`$...$`, `$$...$$`) is NOT treated as an HTML comment — markdown-it should already tokenize these as math content, not `html_inline`
    - Verify that `<!-- -->` inside code regions (backtick spans, fenced code blocks) passes through as literal code — markdown-it should already tokenize these as code content
    - Verify that `<!-- -->` inside CriticMarkup regions passes through as plain text within the CriticMarkup content
    - Add targeted unit tests for each inert zone type if not already covered by property tests
    - _Bug_Condition: N/A (this is exclusion logic — these inputs should NOT trigger the bug condition)_
    - _Expected_Behavior: `<!-- -->` inside inert zones passes through as literal text, unchanged from current behavior_
    - _Preservation: Inert zone content must remain unchanged_
    - _Requirements: 2.6, 2.7, 2.8_

  - [x] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - HTML Comments Preserved Through Roundtrip
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Comment HTML Tags and Existing Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Run `bun test` to ensure all tests pass (existing and new)
  - Ensure no regressions in formatting tags, HTML tables, CriticMarkup, LaTeX equations, or code blocks
  - Ask the user if questions arise
