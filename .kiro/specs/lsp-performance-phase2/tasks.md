# Implementation Plan: LSP Performance Phase 2

## Overview

Six internal performance optimizations for the Manuscript Markdown VS Code extension: debounced LSP validation, async filesystem calls with LRU cache, single-pass decoration extraction, debounced word count, cached navigation matches, and shared frontmatter parsing. All changes are internal refactors with no user-facing API changes. Implementation language: TypeScript.

## Tasks

- [x] 1. Implement LRU cache and async filesystem calls
  - [x] 1.1 Create `LruCache<K, V>` class in `src/lsp/citekey-language.ts`
    - Implement generic LRU cache with `get`, `set`, `delete`, `clear` methods and configurable `maxSize`
    - Use insertion-ordered `Map` for O(1) LRU eviction (delete + re-insert on access)
    - Instantiate `canonicalCache` with max 256 entries
    - _Requirements: 2.3_

  - [x] 1.2 Write property test for LRU cache correctness (Property 2)
    - **Property 2: LRU cache returns correct canonical paths**
    - Generate random sequences of >256 distinct path strings; assert cache size never exceeds 256
    - Assert `canonicalizeFsPathAsync(p)` returns same value as `canonicalizeFsPath(p)` for any path
    - Test file: `src/lsp/lru-cache.property.test.ts`
    - **Validates: Requirements 2.3**

  - [x] 1.3 Add `canonicalizeFsPathAsync()` in `src/lsp/citekey-language.ts`
    - Use `fs.promises.realpath()` instead of `fs.realpathSync.native()`
    - Check `canonicalCache` before filesystem call; populate cache on miss
    - Preserve existing error handling (catch and fall back to `path.resolve` + `path.normalize`)
    - Keep sync `canonicalizeFsPath()` unchanged for non-LSP callers
    - _Requirements: 2.1, 2.3_

  - [x] 1.4 Add `isExistingFileAsync()` and `resolveBibliographyPathAsync()` in `src/lsp/citekey-language.ts`
    - `isExistingFileAsync`: use `fs.promises.stat()` instead of `fs.statSync()`
    - `resolveBibliographyPathAsync`: accept optional `metadata?: Frontmatter` parameter; fall back to `parseFrontmatter(text)` when not provided
    - Use `isExistingFileAsync` for candidate checking
    - _Requirements: 2.2, 2.5, 6.2, 6.4_

  - [x] 1.5 Add `invalidateCanonicalCache()` export in `src/lsp/citekey-language.ts`
    - Invalidate cache entry for a given `fsPath` (via `path.resolve`)
    - _Requirements: 2.4_

  - [x] 1.6 Update all LSP callers to use async versions in `src/lsp/server.ts`
    - Update `updateBibReverseMap`, `validateCitekeys`, `resolveSymbolAtPosition`, `onCompletion` to call `resolveBibliographyPathAsync` and await results
    - Call `invalidateCanonicalCache` on `.bib` file change events
    - _Requirements: 2.4, 2.5_

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Implement debounced LSP validation with shared frontmatter parse
  - [x] 3.1 Add debounce infrastructure in `src/lsp/server.ts`
    - Create `validationTimers: Map<string, ReturnType<typeof setTimeout>>` for per-document timers
    - Add `VALIDATION_DEBOUNCE_MS = 300` constant
    - Implement `scheduleValidation(uri)`: cancel existing timer, set new timer, call `runValidationPipeline` on expiry
    - _Requirements: 1.1, 1.2_

  - [x] 3.2 Create `runValidationPipeline()` with shared frontmatter parse in `src/lsp/server.ts`
    - Parse frontmatter once via `parseFrontmatter(text)` and pass `metadata` to all three validation functions
    - Update `updateBibReverseMap` signature to accept optional `metadata?: Frontmatter`
    - Update `validateCitekeys` signature to accept optional `metadata?: Frontmatter` and pass through to `resolveBibliographyPathAsync`
    - Update `validateCslField` signature to accept optional `metadata?: Frontmatter`
    - _Requirements: 1.3, 6.1, 6.2, 6.3_

  - [x] 3.3 Wire debounce into `onDidChangeContent` and keep `onDidOpen` immediate in `src/lsp/server.ts`
    - `onDidChangeContent`: call `scheduleValidation(uri)` for markdown documents
    - `onDidOpen`: call `runValidationPipeline(doc)` directly (no debounce)
    - Clean up pending timers on `documents.onDidClose` and LSP shutdown
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 3.4 Write property test for debounce consolidation (Property 1)
    - **Property 1: Debounce consolidates rapid changes**
    - Generate random sequences of N change events within debounce interval; assert pipeline executes exactly once with final text
    - Test file: `src/lsp/server-debounce.property.test.ts`
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [x] 3.5 Write property test for pre-parsed frontmatter equivalence (Property 7)
    - **Property 7: Pre-parsed frontmatter equivalence**
    - Generate random markdown texts with YAML frontmatter; assert `resolveBibliographyPathAsync(uri, text, roots, parseFrontmatter(text).metadata)` returns same result as `resolveBibliographyPathAsync(uri, text, roots)`
    - Test file: `src/lsp/frontmatter-equiv.property.test.ts`
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement single-pass decoration extraction
  - [x] 5.1 Fold highlight detection into the existing char-by-char loop in `src/highlight-colors.ts`
    - Extend `extractAllDecorationRanges` to detect `{==...==}` critic highlights and `==...==` / `==...=={color}` format highlights within the same loop
    - Format highlights inside any CriticMarkup span (including `{==...==}`, `{++...++}`, `{--...--}`, `{~~...~~}`) must still be detected; no CriticMarkup span type suppresses nested format highlights
    - Parse optional `{color}` suffix after closing `==` for colored format highlights
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 5.2 Remove calls to `extractHighlightRanges()` and `maskCriticDelimiters()` from `extractAllDecorationRanges()`
    - The single-pass loop now handles all highlight extraction
    - Keep `extractHighlightRanges` and `maskCriticDelimiters` as standalone exports for tests and other callers
    - _Requirements: 3.5_

  - [x] 5.3 Write property test for single-pass extraction equivalence (Property 3)
    - **Property 3: Single-pass decoration extraction equivalence**
    - Generate random text with mixed CriticMarkup and format highlights; assert single-pass `extractAllDecorationRanges` produces highlight ranges identical to standalone `extractHighlightRanges`
    - Include nested patterns: format highlights inside any CriticMarkup span (including `{==...==}`, `{++...++}`), colored highlights
    - Use bounded string generators to avoid timeouts
    - Test file: `src/highlight-colors.property.test.ts`
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 6. Implement debounced word count updates
  - [x] 6.1 Add debounce logic to `WordCountController` in `src/wordcount.ts`
    - Add `debounceTimer` field and `DEBOUNCE_MS = 500` constant
    - Add `scheduleUpdate()` method: cancel existing timer, set new timer, call `updateWordCount` on expiry
    - Wire `onDidChangeTextDocument` to `scheduleUpdate()` instead of direct `updateWordCount()`
    - Keep `onDidChangeActiveTextEditor` calling `updateWordCount()` immediately
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 6.2 Add selection-aware logic to `onDidChangeTextEditorSelection` in `src/wordcount.ts`
    - Skip update entirely when all selections are empty (cursor movement only)
    - Debounce update when at least one selection is non-empty
    - _Requirements: 4.4, 4.5_

  - [x] 6.3 Clear debounce timer in `dispose()` in `src/wordcount.ts`
    - _Requirements: 4.1_

  - [x] 6.4 Write property test for word count debounce consolidation (Property 4)
    - **Property 4: Word count debounce consolidates rapid text changes**
    - Generate random sequences of N text change events within debounce interval; assert `updateWordCount` executes exactly once
    - Test file: `src/wordcount.property.test.ts`
    - **Validates: Requirements 4.1, 4.2**

  - [x] 6.5 Write property test for empty selection skip (Property 5)
    - **Property 5: Empty selections skip word count update**
    - Generate random selection change events with empty/non-empty selections; assert empty-only events do not trigger update, non-empty events trigger debounced update
    - Test file: `src/wordcount.property.test.ts`
    - **Validates: Requirements 4.4, 4.5**

- [x] 7. Implement cached navigation match results
  - [x] 7.1 Add version-keyed cache to `getAllMatches()` in `src/changes.ts`
    - Add module-level `cachedUri`, `cachedVersion`, `cachedRanges` variables
    - Return cached ranges when `(uri, version)` matches; perform fresh scan and cache on mismatch
    - Discard cache when document URI changes
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 7.2 Write property test for navigation cache correctness (Property 6)
    - **Property 6: Navigation cache correctness and idempotence**
    - Generate random document texts; assert two calls with same version return identical arrays; assert call with new version matches fresh scan
    - Test file: `src/changes.property.test.ts`
    - **Validates: Requirements 5.2, 5.3**

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with `bun:test`, minimum 100 iterations, bounded string generators
- Existing standalone extraction functions (`extractHighlightRanges`, `maskCriticDelimiters`, etc.) are preserved for backward compatibility
- Sync `canonicalizeFsPath` and `resolveBibliographyPath` are kept for non-LSP callers
