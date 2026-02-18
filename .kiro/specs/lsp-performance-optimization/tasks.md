# Implementation Plan: LSP Performance Optimization

## Overview

Incremental optimization of the Manuscript Markdown extension across LSP server, editor decorations, citation scanning, CriticMarkup preprocessing, preview parser, and TextMate grammar. Each task preserves behavioral equivalence with the existing implementation while improving performance.

## Tasks

- [x] 1. Bib Reverse Map and workspace scan removal
  - [x] 1.1 Add `bibReverseMap` data structure and maintenance functions to `src/lsp/server.ts`
    - Add module-level `Map<string, Set<string>>` mapping canonical bib paths to markdown doc URIs
    - Implement `updateBibReverseMap(docUri, docText)` and `removeBibReverseMapEntry(docUri)`
    - Hook into `documents.onDidOpen`, `documents.onDidChangeContent` (markdown), and `documents.onDidClose` (markdown)
    - _Requirements: 6.1, 6.2_
  - [x] 1.2 Simplify `findPairedMarkdownUris` to use same-basename + reverse map only
    - Remove the recursive workspace scan (step 3: `findMarkdownFilesRecursive` loop)
    - Replace open-doc iteration (step 2) with `getMarkdownUrisForBib()` lookup
    - Keep same-basename stat check (step 1) and canonical-path deduplication
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 1.3 Update `revalidateMarkdownDocsForBib` to use the reverse map
    - Replace the `documents.all()` loop + `resolveBibliographyPath` per doc with a `getMarkdownUrisForBib()` lookup
    - _Requirements: 6.3_
  - [x]* 1.4 Write unit tests for bib reverse map lifecycle
    - Test add/update/remove scenarios for the reverse map
    - Test that `findPairedMarkdownUris` returns correct results from both sources
    - Test that no recursive filesystem scan occurs
    - _Requirements: 1.1, 1.2, 1.3, 6.1, 6.2, 6.3_

- [x] 2. Targeted citation key scanner
  - [x] 2.1 Implement `findUsagesForKey(text, key)` in `src/lsp/citekey-language.ts`
    - Build a regex that matches only the specific key within citation segments `[@...]`
    - Escape regex-special characters in the key
    - Return `CitekeyUsage[]` with correct `keyStart`/`keyEnd` offsets
    - _Requirements: 2.1, 2.2_
  - [x] 2.2 Update `findReferencesForKey` in `src/lsp/server.ts` to use `findUsagesForKey`
    - Replace `scanCitationUsages(text).filter(...)` with `findUsagesForKey(text, key)`
    - _Requirements: 2.1, 2.3_
  - [x]* 2.3 Write property test for targeted key scanner equivalence
    - **Property 2: Targeted Key Scanner Equivalence**
    - **Validates: Requirements 2.1, 2.2, 2.3**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Single-pass decoration extraction
  - [x] 4.1 Implement `extractAllDecorationRanges` in `src/highlight-colors.ts`
    - Single function that scans text once and returns all range categories
    - Handle CriticMarkup highlights, colored format highlights, comments, additions, deletions, delimiters, substitution-new ranges
    - Inline the overlap exclusion logic (critic highlights exclude format highlights)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 4.2 Update `updateHighlightDecorations` in `src/extension.ts` to call `extractAllDecorationRanges`
    - Replace the six separate extraction calls with a single `extractAllDecorationRanges` call
    - Map the returned ranges to VS Code decoration types as before
    - _Requirements: 3.1_
  - [x]* 4.3 Write property test for single-pass decoration extraction equivalence
    - **Property 3: Single-Pass Decoration Extraction Equivalence**
    - **Validates: Requirements 3.1, 3.2, 3.3**

- [x] 5. Two-pointer overlap check in extractHighlightRanges
  - [x] 5.1 Replace `.some()` overlap check with two-pointer sweep in `extractHighlightRanges`
    - Both critic ranges and highlight matches are in scan order; use a moving pointer
    - Keep the existing function signature and return type unchanged
    - _Requirements: 4.1, 4.2_
  - [x]* 5.2 Write property test for two-pointer overlap exclusion equivalence
    - **Property 4: Two-Pointer Overlap Exclusion Equivalence**
    - **Validates: Requirements 4.1, 4.2**

- [x] 6. Local citekey resolution at cursor
  - [x] 6.1 Rewrite `findCitekeyAtOffset` in `src/lsp/citekey-language.ts` to use bounded local scan
    - Scan backward to `[` or line start, forward to `]` or line end
    - Run `scanCitationUsages` on just the bounded segment
    - Handle bare citation context (`@key` outside brackets)
    - _Requirements: 5.1, 5.2, 5.3_
  - [x]* 6.2 Write property test for local citekey resolution equivalence
    - **Property 5: Local Citekey Resolution Equivalence**
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Streaming CriticMarkup preprocessor
  - [x] 8.1 Rewrite `preprocessCriticMarkup` in `src/critic-markup.ts` to use segment collection
    - Replace repeated `result.slice(0, ...) + replaced + result.slice(...)` with array of segments joined once
    - Preserve all existing behavior including nested `{>>...<<}` and `{#id>>...<<}` handling
    - _Requirements: 7.1, 7.2_
  - [x]* 8.2 Write property test for streaming preprocessor equivalence
    - **Property 6: Streaming Preprocessor Equivalence**
    - **Validates: Requirements 7.1, 7.2**

- [x] 9. Preview parser micro-optimizations
  - [x] 9.1 Optimize `manuscriptMarkdownBlock` in `src/preview/manuscript-markdown-plugin.ts`
    - Replace `src.slice(pos, pos+3)` + `patterns.includes()` with direct charCode checks
    - _Requirements: 8.1, 8.2_
  - [x] 9.2 Add posMax bounds checking to `parseManuscriptMarkdown` closing marker searches
    - After `indexOf` finds a closing marker, verify `endPos <= state.posMax` before accepting
    - _Requirements: 8.3_

- [x] 10. TextMate grammar improvements
  - [x] 10.1 Fix injection selector to exclude code scopes in `syntaxes/manuscript-markdown.json`
    - Change `injectionSelector` from `L:text.html.markdown` to `L:text.html.markdown -string -meta.embedded -markup.inline.raw -markup.fenced_code`
    - _Requirements: 10.1, 10.2, 10.3_
  - [x] 10.2 Reorder patterns in `syntaxes/manuscript-markdown.json`
    - Move `citation_list`, `footnote_ref`, `footnote_def` before CriticMarkup patterns
    - Keep `colored_format_highlight` before `format_highlight`
    - Tighten character classes in match patterns where possible
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate behavioral equivalence between old and new implementations
- The existing individual extraction functions in `highlight-colors.ts` should be kept (they're used in tests and potentially other contexts) — the single-pass function is an addition, not a replacement
- Per AGENTS.md: use `fast-check` with bounded generators to avoid timeouts
