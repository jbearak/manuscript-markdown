# Requirements Document

## Introduction

Second round of performance optimizations for the Manuscript Markdown VS Code extension. Phase 1 addressed workspace-scan removal, targeted key search, bib reverse-map, streaming preprocessing, preview parser micro-optimizations, and TextMate grammar improvements. This phase targets the remaining hot-path inefficiencies: missing debounce on LSP validation, synchronous filesystem calls blocking the LSP thread, incomplete single-pass decoration extraction, missing debounce on word count updates, uncached navigation scanning, and redundant frontmatter parsing within the same event handler cycle.

## Glossary

- **LSP_Server**: The language server process (`src/lsp/server.ts`) handling diagnostics, references, hover, and completion for Manuscript Markdown files.
- **Validation_Pipeline**: The sequence of `updateBibReverseMap`, `validateCitekeys`, and `validateCslField` calls triggered by `documents.onDidChangeContent` in the LSP_Server.
- **Decoration_Pipeline**: The extraction functions in `src/highlight-colors.ts` that compute editor decoration ranges, currently delegating highlight extraction to a separate multi-pass function.
- **Word_Count_Controller**: The `WordCountController` class in `src/wordcount.ts` that updates the status bar word count on editor events.
- **Navigation_Scanner**: The `getAllMatches()` function in `src/changes.ts` that finds all CriticMarkup ranges for next/prev change navigation.
- **Frontmatter_Cache**: A per-document cache of parsed frontmatter metadata, keyed by document URI and text version, to avoid redundant parsing within a single event cycle.
- **Canonicalize_Cache**: An in-memory LRU cache for `canonicalizeFsPath()` results to avoid repeated synchronous `fs.realpathSync.native()` calls for the same paths.

## Requirements

### Requirement 1: Debounced LSP Validation on Content Change

**User Story:** As a user typing in a markdown document, I want the LSP server to debounce validation so that diagnostics are not recomputed on every keystroke, reducing CPU usage during active editing.

#### Acceptance Criteria

1. WHEN `documents.onDidChangeContent` fires for a markdown document, THE LSP_Server SHALL delay the Validation_Pipeline invocation by a configurable debounce interval (default 300ms).
2. WHEN a subsequent content change arrives before the debounce interval elapses, THE LSP_Server SHALL cancel the pending validation and restart the debounce timer.
3. WHEN the debounce interval elapses without further changes, THE LSP_Server SHALL execute the full Validation_Pipeline (`updateBibReverseMap`, `validateCitekeys`, `validateCslField`) for the most recent document text.
4. WHEN a markdown document is first opened via `documents.onDidOpen`, THE LSP_Server SHALL run validation immediately without debounce.

### Requirement 2: Asynchronous Filesystem Calls in LSP Hot Paths

**User Story:** As a user invoking hover, definition, completion, or validation, I want the LSP server to use asynchronous filesystem calls instead of synchronous ones, so that the server thread is not blocked by disk I/O.

#### Acceptance Criteria

1. WHEN `canonicalizeFsPath()` resolves a filesystem path, THE LSP_Server SHALL use `fs.promises.realpath()` (or an async equivalent) instead of `fs.realpathSync.native()`.
2. WHEN `resolveBibliographyPath()` checks whether a candidate bibliography file exists, THE LSP_Server SHALL use `fs.promises.stat()` instead of `fs.statSync()`.
3. WHEN `canonicalizeFsPath()` is converted to async, THE LSP_Server SHALL cache results in a Canonicalize_Cache (LRU, max 256 entries) so that repeated lookups for the same path do not issue redundant filesystem calls.
4. WHEN a `.bib` file change event is received, THE LSP_Server SHALL invalidate the Canonicalize_Cache entry for that path.
5. WHEN `resolveBibliographyPath()` is converted to async, all callers (`updateBibReverseMap`, `validateCitekeys`, `resolveSymbolAtPosition`, `onCompletion`) SHALL be updated to await the result.

### Requirement 3: True Single-Pass Decoration Extraction

**User Story:** As a user editing a document with mixed CriticMarkup and format highlights, I want all decoration ranges to be extracted in one character-by-character traversal, so that the document text is not scanned multiple times.

#### Acceptance Criteria

1. WHEN `extractAllDecorationRanges()` is called, THE Decoration_Pipeline SHALL extract highlight ranges (both CriticMarkup `{==...==}` and format `==...==` / `==...=={color}`) within the same character-by-character loop that already extracts additions, deletions, substitutions, comments, and delimiters.
2. WHEN the single-pass scanner encounters `==` outside a CriticMarkup span, THE Decoration_Pipeline SHALL scan forward for the closing `==` and optional `{color}` suffix, assigning the range to the correct color bucket.
3. WHEN the single-pass scanner encounters `{==`, THE Decoration_Pipeline SHALL record a critic highlight range and skip to the closing `==}`, while still detecting any format highlights `==...==` nested within the critic highlight content.
4. WHEN the single-pass extraction is complete, THE Decoration_Pipeline SHALL produce results identical to the current multi-pass implementation for all inputs, including nested patterns and edge cases.
5. WHEN the single-pass scanner is adopted, THE Decoration_Pipeline SHALL no longer call `extractHighlightRanges()` or `maskCriticDelimiters()` from within `extractAllDecorationRanges()`.

### Requirement 4: Debounced Word Count Updates

**User Story:** As a user typing in a markdown document, I want the word count status bar to update with a debounce delay, so that the entire document text is not re-split on every keystroke and cursor movement.

#### Acceptance Criteria

1. WHEN `onDidChangeTextDocument` fires, THE Word_Count_Controller SHALL delay the `updateWordCount()` call by a debounce interval of 500ms.
2. WHEN a subsequent text change arrives before the debounce interval elapses, THE Word_Count_Controller SHALL cancel the pending update and restart the debounce timer.
3. WHEN `onDidChangeActiveTextEditor` fires, THE Word_Count_Controller SHALL update the word count immediately without debounce, since the user switched to a different file.
4. WHEN `onDidChangeTextEditorSelection` fires and the selection is non-empty, THE Word_Count_Controller SHALL delay the `updateWordCount()` call by the same debounce interval, since selection-based word count is informational and not latency-sensitive.
5. WHEN `onDidChangeTextEditorSelection` fires and all selections are empty (cursor movement only), THE Word_Count_Controller SHALL schedule a debounced update so the status bar resets to the full-document word count when a selection is cleared.

### Requirement 5: Cached Navigation Match Results

**User Story:** As a user rapidly navigating through changes with next/prev commands, I want the navigation scanner to reuse cached match results when the document has not changed, so that the full-document regex scan is not repeated on every command invocation.

#### Acceptance Criteria

1. WHEN `getAllMatches()` is called, THE Navigation_Scanner SHALL check whether cached results exist for the current document version.
2. WHEN cached results exist and the document version matches, THE Navigation_Scanner SHALL return the cached ranges without re-scanning.
3. WHEN the document text has changed since the last scan, THE Navigation_Scanner SHALL perform a fresh regex scan, cache the results with the current document version, and return them.
4. WHEN a different document becomes active, THE Navigation_Scanner SHALL discard the cache for the previous document.

### Requirement 6: Shared Frontmatter Parse Within Validation Cycle

**User Story:** As a user editing a markdown document, I want the LSP server to parse frontmatter only once per validation cycle, so that `updateBibReverseMap`, `validateCitekeys`, and `validateCslField` do not each independently re-parse the same YAML block.

#### Acceptance Criteria

1. WHEN the debounced Validation_Pipeline executes for a document, THE LSP_Server SHALL parse the document frontmatter once and pass the result to `updateBibReverseMap`, `validateCitekeys`, and `validateCslField`.
2. WHEN `resolveBibliographyPath()` is called within the validation cycle, THE LSP_Server SHALL accept pre-parsed frontmatter metadata as an optional parameter instead of re-parsing from raw text.
3. WHEN `validateCslField()` is called within the validation cycle, THE LSP_Server SHALL accept pre-parsed frontmatter metadata or a pre-extracted CSL field info as an optional parameter instead of re-parsing from raw text.
4. WHEN callers outside the validation cycle invoke `resolveBibliographyPath()` without pre-parsed metadata (e.g., from `onCompletion` or `resolveSymbolAtPosition`), THE LSP_Server SHALL fall back to parsing frontmatter from the raw text, preserving backward compatibility.
