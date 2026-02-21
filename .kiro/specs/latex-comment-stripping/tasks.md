# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - LaTeX % Comments Appear as Visible Text in OMML
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate `%` comment text leaks into visible OMML output
  - **Scoped PBT Approach**: Scope the property to concrete failing cases using fast-check with short bounded generators:
    - `latexToOmml('x^2 % superscript')` — assert no visible `m:t` element contains `% superscript` or `superscript`
    - `latexToOmml('x^2          % superscript\nx_i          % subscript')` — assert neither comment appears in any visible `m:t`
    - `latexToOmml('x + y%\n+ z')` — assert `%` is not visible and lines are joined
  - Property: for all LaTeX inputs containing an unescaped `%` (isBugCondition returns true), `latexToOmml(input)` SHALL produce OMML where no comment text appears in any visible `m:t` element, and each comment is embedded as a non-visible inline element storing the comment text and preceding whitespace
  - The test assertions should match the Expected Behavior Properties from design (Property 1: Fault Condition — Comments Stripped and Embedded)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists: `%` and comment text appear as literal visible text in OMML)
  - Document counterexamples found (e.g., `latexToOmml('x^2 % superscript')` produces `<m:t>% superscript</m:t>` as visible text)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Comment LaTeX Conversion Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - **Step 1 — Observe**: Run UNFIXED `latexToOmml()` on non-buggy inputs and record actual outputs:
    - Observe: `latexToOmml('x^2')` output on unfixed code
    - Observe: `latexToOmml('\\frac{a}{b}')` output on unfixed code
    - Observe: `latexToOmml('50\\% discount')` output on unfixed code (escaped percent — literal `%` visible)
    - Observe: `latexToOmml('\\sum_{i=0}^{n} x_i')` output on unfixed code
    - Observe: `latexToOmml('a + b')` output on unfixed code (simple text, no special chars)
  - **Step 2 — Write property-based tests**: Using fast-check with short bounded generators, generate random LaTeX strings that do NOT contain unescaped `%` (isBugCondition returns false) and assert `latexToOmml` output is identical before and after fix
  - Property: for all LaTeX inputs where `isBugCondition(input)` returns false, `latexToOmml_fixed(input) === latexToOmml_original(input)` — the output must be byte-identical
  - Include concrete preservation assertions:
    - Escaped `\%` continues to render as literal `%` in OMML (Requirement 3.1)
    - Equations without `%` produce identical OMML (Requirement 3.2)
    - Non-comment portions of equations are unaffected (Requirement 3.3)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Implement the fix for LaTeX % comment stripping

  - [x] 3.1 Add comment and line_continuation token types to tokenize() in src/latex-to-omml.ts
    - Extend the Token type union with `'comment' | 'line_continuation'`
    - Add a `%` branch to the tokenizer before the "regular text" fallback
    - When unescaped `%` is encountered: capture preceding whitespace (spaces/tabs) between last content and `%`, capture comment text (everything from `%` to end-of-line or end-of-string)
    - Emit `comment` token containing both the whitespace prefix and comment text
    - If `%` is at end-of-line with no comment text (line continuation), emit `line_continuation` token and consume the newline
    - Ensure `\%` (escaped percent, already handled by `\\` branch) is NOT affected
    - _Bug_Condition: isBugCondition(input) where input contains unescaped `%` (not preceded by `\`)_
    - _Expected_Behavior: comment tokens emitted for unescaped `%`; text tokens no longer contain `%` or comment text_
    - _Preservation: `\%` continues to be tokenized as single-char command; all other token types unchanged_
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

  - [x] 3.2 Emit hidden OMML runs for comment tokens in src/latex-to-omml.ts
    - Handle `comment` tokens in `Parser.parseToken()` (or equivalent emission point)
    - Emit a non-visible `m:r` run with `\u200B` (zero-width space) prefix: `<m:r><m:rPr><m:nor/></m:rPr><m:t>\u200B{preceding_whitespace}%{comment_text}</m:t></m:r>`
    - The `\u200B` prefix is the detection key for re-import
    - The whitespace between `\u200B` and `%` is the original preceding whitespace (spaces/tabs)
    - For `line_continuation` tokens, emit `<m:r><m:rPr><m:nor/></m:rPr><m:t>\u200B%\n</m:t></m:r>`
    - Use `xml:space="preserve"` on `m:t` to preserve whitespace
    - _Bug_Condition: comment/line_continuation tokens from tokenize()_
    - _Expected_Behavior: hidden OMML runs with \u200B% prefix embedded at comment positions_
    - _Preservation: no hidden runs emitted for non-comment tokens_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Detect hidden comment runs in translateRun() in src/omml.ts and restore % comments
    - In `translateRun()`, after extracting text from `m:t` nodes, check if text starts with `\u200B`
    - If detected, parse as comment marker: split on first `%` after `\u200B` to recover preceding whitespace and comment text
    - Emit restored LaTeX: `{whitespace}%{comment_text}\n` for regular comments
    - For line-continuation markers (`\u200B%\n`), emit `%\n` (the `%` suppresses the newline in LaTeX)
    - Skip normal run translation for hidden comment runs (do not emit visible LaTeX content)
    - _Bug_Condition: OMML contains m:r runs with \u200B% prefix in m:t text_
    - _Expected_Behavior: hidden runs restored as LaTeX % comments with original whitespace_
    - _Preservation: non-hidden runs translated identically to current behavior_
    - _Requirements: 2.4, 3.5, 3.6_

  - [x] 3.4 Update docs/latex-equations.md with a Comments section
    - Add a section documenting `%` comments in LaTeX equations
    - Explain that `%` starts a line comment — everything after it to end-of-line is ignored by the LaTeX engine
    - Explain roundtrip behavior: comments are preserved (but invisible) in exported Word `.docx` and restored on re-import back to markdown
    - _Requirements: 2.5, 2.6_

  - [x] 3.5 Update docs/converter.md with comment handling documentation
    - Add documentation explaining how LaTeX `%` comments are handled during export and import
    - Document: comments stripped from visible OMML output, embedded as non-visible elements within OMML structure, restored as LaTeX `%` comments on re-import from DOCX to markdown
    - _Requirements: 2.7_

  - [x] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - LaTeX % Comments Stripped and Embedded
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior (comments stripped from visible OMML, embedded as hidden elements)
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Comment LaTeX Conversion Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all preservation tests still pass after fix (escaped `\%`, comment-free equations, non-comment portions all produce identical OMML)

  - [x] 3.8 Write roundtrip property tests
    - **Property 3: Roundtrip** - Comment Restoration on Re-Import
    - Write property-based tests using fast-check with short bounded generators:
      - For any LaTeX input with `%` comments, `ommlToLatex(parse(latexToOmml(input)))` restores `%` comments at original positions
      - Preceding whitespace (spaces/tabs) before `%` is preserved exactly
      - Multi-line aligned comments maintain vertical alignment after roundtrip
      - Line-continuation `%` roundtrips correctly (lines joined on export, `%\n` restored on import)
    - Concrete roundtrip test cases:
      - `x^2 % superscript` → export → import → `x^2 % superscript`
      - Multi-line with aligned comments preserves whitespace alignment
      - `x + y%\n+ z` → export → import → `x + y%\n+ z`
    - _Requirements: 2.4, 3.5, 3.6_

  - [x] 3.9 Write unit tests for tokenize() comment handling
    - Test `tokenize()` produces `comment` tokens for `%` with correct whitespace and text
    - Test `tokenize()` produces `line_continuation` tokens for end-of-line `%`
    - Test `tokenize()` does NOT produce comment tokens for `\%` (escaped percent)
    - Test `tokenize()` handles `%` at start of line, middle of line, end of line
    - Test `tokenize()` handles multiple `%` comments across multiple lines
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1_

- [x] 4. Checkpoint — Ensure all tests pass
  - Run full test suite to verify all tests pass
  - Ensure exploration test (task 1) passes after fix
  - Ensure preservation tests (task 2) still pass after fix
  - Ensure roundtrip tests (task 3.8) pass
  - Ensure unit tests (task 3.9) pass
  - Ask the user if questions arise
