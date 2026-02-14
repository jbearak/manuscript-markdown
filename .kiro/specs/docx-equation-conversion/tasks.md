# Implementation Plan: DOCX Equation Conversion

## Overview

Implement OMML-to-LaTeX translation as a new `src/omml.ts` module, integrate it into the existing converter pipeline (`src/converter.ts`), and validate with property-based and unit tests. Tasks are ordered so each step builds on the previous, with checkpoints after core logic and integration.

## Tasks

- [ ] 1. Create `src/omml.ts` with core translation infrastructure
  - [ ] 1.1 Create `src/omml.ts` with helper functions and mapping tables
    - Implement `getOmmlAttr()` for `m:` namespace attribute extraction (`@_m:val`)
    - Implement `escapeLatex()` for reserved LaTeX character escaping
    - Implement `unicodeToLatex()` using `UNICODE_LATEX_MAP` (Greek letters, operators, symbols)
    - Implement `isMultiLetter()` for detecting multi-letter runs
    - Define `UNICODE_LATEX_MAP`, `ACCENT_MAP`, `NARY_MAP`, `KNOWN_FUNCTIONS` tables
    - Define `SKIP_TAGS` set for property/control tags to ignore
    - Export `ommlToLatex()` as the main entry point (initially just dispatching to `translateNode`)
    - _Requirements: 4.1, 4.2, 4.3, 4A.1, 4A.2_

  - [ ] 1.2 Implement `translateRun()` and `translateNode()` dispatch
    - `translateRun()`: extract text from `m:t` nodes, apply `unicodeToLatex`, handle `m:sty` val="p" for `\mathrm{}`, handle single-letter vs multi-letter wrapping
    - `translateNode()`: dispatch by tag name to handler functions, skip known property tags, emit fallback for unknown `m:*` tags
    - `ommlToLatex()`: iterate children, call `translateNode` for each, join results
    - _Requirements: 3.14, 3A.2, 3A.3, 3A.4, 6.1, 6.4_

  - [ ]* 1.3 Write property tests for helpers and math run translation
    - **Property 5: Unicode-to-LaTeX mapping correctness**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - **Property 6: LaTeX escaping of reserved characters**
    - **Validates: Requirements 4A.1, 4A.2**
    - **Property 11: Math run text handling**
    - **Validates: Requirements 3.14, 3A.2**

- [ ] 2. Implement OMML construct translators
  - [ ] 2.1 Implement fraction, superscript, subscript, sub-superscript translators
    - `translateFraction()`: extract `m:num`, `m:den`, emit `\frac{...}{...}`
    - `translateSuperscript()`: extract `m:e`, `m:sup`, emit `{base}^{sup}`
    - `translateSubscript()`: extract `m:e`, `m:sub`, emit `{base}_{sub}`
    - `translateSubSup()`: extract `m:e`, `m:sub`, `m:sup`, emit `{base}_{sub}^{sup}`
    - Handle missing children with fallback placeholder
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 6.2_

  - [ ] 2.2 Implement radical, n-ary, delimiter translators
    - `translateRadical()`: read `m:radPr`/`m:degHide`, emit `\sqrt{...}` or `\sqrt[deg]{...}`
    - `translateNary()`: read `m:naryPr` for `m:chr` (default `∫`), `m:limLoc`, `m:subHide`/`m:supHide`; emit operator with limits
    - `translateDelimiter()`: read `m:dPr` for `m:begChr`/`m:endChr`/`m:sepChr` (defaults `(`, `)`, `|`); emit delimited expression
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 3.9_

  - [ ] 2.3 Implement accent, matrix, function translators
    - `translateAccent()`: read `m:accPr`/`m:chr` (default `\u0302`), map via `ACCENT_MAP`, emit `\hat{...}` etc., fallback for unknown accents
    - `translateMatrix()`: iterate `m:mr` rows and `m:e` cells, emit `\begin{matrix}...\end{matrix}` with `\\` row separators and `&` cell separators
    - `translateFunction()`: extract function name from `m:fName`, check `KNOWN_FUNCTIONS` for `\sin` etc., use `\operatorname{name}` for unknown names
    - _Requirements: 3.10, 3.11, 3.12, 3.13_

  - [ ]* 2.4 Write property tests for OMML construct translation
    - **Property 3: Balanced braces invariant**
    - **Validates: Requirements 5.2, 3.9**
    - **Property 7: Deterministic output**
    - **Validates: Requirements 4A.4**
    - **Property 9: Formatting and control node invariance**
    - **Validates: Requirements 3A.3, 3A.4**
    - **Property 10: Fallback and continuation**
    - **Validates: Requirements 6.1, 6.4, 3B.2**

  - [ ]* 2.5 Write unit tests for each OMML construct
    - Test each translator with specific OMML XML structures (fraction, superscript, subscript, radical, n-ary, delimiter, accent, matrix, function)
    - Test empty math elements produce empty string (Req 6.3)
    - Test missing children produce fallback placeholder (Req 6.2)
    - Test unknown `m:*` elements produce fallback (Req 6.1)
    - Test unknown accent characters produce fallback (Req 3.11)
    - _Requirements: 3.1–3.14, 6.1, 6.2, 6.3_

- [ ] 3. Checkpoint — Ensure all `omml.ts` tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Integrate OMML translation into converter pipeline
  - [ ] 4.1 Extend `ContentItem` type and update `extractDocumentContent()`
    - Add `{ type: 'math'; latex: string; display: boolean }` to `ContentItem` union
    - Add `m:oMathPara` and `m:oMath` branches in `walk()` key-dispatch loop
    - `m:oMathPara` branch: extract `m:oMath` children, call `ommlToLatex`, push display math items
    - `m:oMath` branch: call `ommlToLatex`, push inline math items
    - Wrap `ommlToLatex` calls in try/catch for non-fatal error handling
    - Skip empty math elements (empty LaTeX → no content item)
    - Ensure `m:oMathPara` is checked before `m:oMath` to prevent double processing
    - _Requirements: 1.1, 2.1, 6.3, 6.4, 3A.1_

  - [ ] 4.2 Update `buildMarkdown()` for math content items
    - Add `'math'` type handler in the rendering loop
    - Inline math: emit `$...$` wrapping the LaTeX string
    - Display math: emit `$$...$$` with blank line separation from surrounding content
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.4_

  - [ ]* 4.3 Write property tests for converter integration
    - **Property 1: Delimiter selection matches element type**
    - **Validates: Requirements 1.1, 2.1**
    - **Property 2: Display equations are separated by blank lines**
    - **Validates: Requirements 2.2**
    - **Property 8: Mixed content preservation**
    - **Validates: Requirements 1.2, 3A.1**

  - [ ]* 4.4 Write integration unit tests for end-to-end DOCX with equations
    - Build synthetic DOCX ZIP with inline and display equations using JSZip (same pattern as existing tests)
    - Verify inline equations produce `$...$` in markdown output
    - Verify display equations produce `$$...$$` with blank line separation
    - Verify mixed text + equation paragraphs preserve both content types
    - Verify empty `m:oMath` elements are skipped
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 6.3_

- [ ] 5. Structural fidelity property test
  - [ ]* 5.1 Implement OMML tree generator and round-trip property test
    - Build `fast-check` `Arbitrary` for generating random bounded OMML trees (use `fc.letrec` with `depthSize: 'small'`)
    - Generate trees covering: fractions, superscripts, subscripts, radicals, n-ary, delimiters, accents, matrices, functions, math runs
    - Use bounded string generators (`maxLength: 10`) per AGENTS.md guidance
    - **Property 4: Structural fidelity round-trip**
    - **Validates: Requirements 5.1, 3.1–3.15**

- [ ] 6. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The OMML tree generator (task 5.1) is the most complex test infrastructure piece — use bounded depth (3–4) and short strings to avoid timeouts
