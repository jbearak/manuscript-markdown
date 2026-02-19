# Requirements Document

## Introduction

Performance optimization of the Manuscript Markdown VS Code extension, targeting the LSP server (references, hover, diagnostics), editor decoration pipeline, and supporting utilities. The goal is to eliminate redundant work, reduce algorithmic complexity, and introduce caching/indexing where repeated computation currently occurs.

## Glossary

- **LSP_Server**: The language server process (`src/lsp/server.ts`) handling references, hover, completion, and diagnostics for Manuscript Markdown files.
- **Workspace_Index**: A cached mapping from bibliography file paths to the set of markdown files that reference them, maintained incrementally via file watchers.
- **Decoration_Pipeline**: The set of extraction functions in `src/extension.ts` and `src/highlight-colors.ts` that compute editor decoration ranges on each document change.
- **Single_Pass_Tokenizer**: A unified scanner that extracts all CriticMarkup and highlight range categories in one traversal of the document text.
- **Citation_Scanner**: The `scanCitationUsages()` function in `src/lsp/citekey-language.ts` that finds all `@citekey` references in a document.
- **Targeted_Key_Scanner**: A replacement for full citation scanning that searches for a single specific citekey using a focused regex.
- **Bib_Reverse_Map**: A mapping from resolved bibliography file paths to the set of open markdown document URIs that depend on them.
- **Streaming_Builder**: A string construction approach that collects segments and joins once, avoiding repeated intermediate string allocations.
- **Preview_Parser**: The markdown-it plugin (`src/preview/manuscript-markdown-plugin.ts`) that renders CriticMarkup patterns in the preview pane.
- **TextMate_Grammar**: The injection grammar (`syntaxes/manuscript-markdown.json`) providing syntax highlighting for CriticMarkup patterns.

## Requirements

### Requirement 1: Remove Workspace-Wide Filesystem Scan from Find References

**User Story:** As a user invoking "Find References" from a .bib file, I want the LSP server to resolve paired markdown files only from open documents and the same-basename convention, so that reference lookups never trigger a recursive workspace filesystem scan.

#### Acceptance Criteria

1. WHEN `findPairedMarkdownUris()` is called for a bibliography path, THE LSP_Server SHALL check for a same-basename markdown file (e.g. `paper.bib` → `paper.md` in the same directory).
2. WHEN `findPairedMarkdownUris()` is called for a bibliography path, THE LSP_Server SHALL look up dependent open markdown documents from the Bib_Reverse_Map (see Requirement 6) instead of iterating all open documents and re-resolving bibliography paths.
3. WHEN `findPairedMarkdownUris()` is called, THE LSP_Server SHALL return only the results from the same-basename check and the Bib_Reverse_Map lookup, without performing any recursive filesystem discovery of workspace roots.
4. WHEN results are collected from both sources, THE LSP_Server SHALL deduplicate by canonical filesystem path before returning.

### Requirement 2: Targeted Citation Key Search in Reference Lookups

**User Story:** As a user invoking "Find References" for a specific citekey, I want the LSP server to search only for that key in each document, so that reference lookups do not scan all citations and then filter.

#### Acceptance Criteria

1. WHEN `findReferencesForKey()` is called with a specific key, THE LSP_Server SHALL use a Targeted_Key_Scanner that matches only the requested key, rather than calling `scanCitationUsages()` and filtering.
2. WHEN the Targeted_Key_Scanner constructs a regex for the requested key, THE LSP_Server SHALL escape all regex-special characters in the key string.
3. WHEN the Targeted_Key_Scanner finds matches, THE LSP_Server SHALL return location results equivalent to those produced by the previous full-scan-and-filter approach.

### Requirement 3: Single-Pass Decoration Extraction

**User Story:** As a user editing a markdown document, I want editor decorations to be computed in a single pass over the document text, so that decoration updates are faster and scale linearly with document size.

#### Acceptance Criteria

1. WHEN `updateHighlightDecorations()` is triggered, THE Decoration_Pipeline SHALL extract all range categories (highlights by color, critic highlights, comments, additions, deletions, delimiters, substitution-new) in a single traversal of the document text.
2. WHEN the Single_Pass_Tokenizer encounters a CriticMarkup highlight `{==...==}`, THE Decoration_Pipeline SHALL record it as a critic highlight range and exclude it from format-highlight matching, preserving the existing overlap-exclusion behavior.
3. WHEN the Single_Pass_Tokenizer encounters a colored format highlight `==text=={color}`, THE Decoration_Pipeline SHALL assign it to the correct color bucket or the configured default color, matching existing behavior.
4. WHEN the Single_Pass_Tokenizer encounters nested CriticMarkup patterns, THE Decoration_Pipeline SHALL handle depth-aware matching for `{>>...<<}` comment delimiters.

### Requirement 4: Linear-Time Overlap Check in Highlight Extraction

**User Story:** As a user with a document containing many highlights and CriticMarkup ranges, I want the overlap check between format highlights and critic highlights to run in linear time, so that decoration updates do not degrade quadratically.

#### Acceptance Criteria

1. WHEN `extractHighlightRanges()` checks whether a format highlight overlaps a critic range, THE Decoration_Pipeline SHALL use a two-pointer sweep over the sorted ranges instead of nested iteration.
2. WHEN the two-pointer sweep is applied, THE Decoration_Pipeline SHALL produce identical overlap-exclusion results to the current `.some()` approach for all input orderings.

### Requirement 5: Local Citekey Resolution at Cursor

**User Story:** As a user hovering over or requesting the definition of a citekey, I want the LSP server to resolve the key by scanning only the local context around the cursor, so that point queries do not require a full-document citation scan.

#### Acceptance Criteria

1. WHEN `findCitekeyAtOffset()` is called, THE Citation_Scanner SHALL scan a bounded region around the given offset (backward to the nearest `[` or line start, forward to the nearest `]` or line end) instead of scanning the entire document.
2. WHEN the bounded scan finds a `@citekey` token containing the offset, THE Citation_Scanner SHALL return the key string.
3. IF the bounded scan does not find a matching citekey, THEN THE Citation_Scanner SHALL return undefined without falling back to a full-document scan.

### Requirement 6: Reverse-Map Bib Revalidation

**User Story:** As a user editing a .bib file, I want the LSP server to revalidate only the markdown documents that depend on that specific bib file, so that bib-change diagnostics do not iterate all open documents and re-resolve bibliography paths.

#### Acceptance Criteria

1. WHEN a markdown document is opened or its frontmatter bibliography field changes, THE LSP_Server SHALL update the Bib_Reverse_Map to associate the resolved bibliography path with that document URI.
2. WHEN a markdown document is closed, THE LSP_Server SHALL remove it from the Bib_Reverse_Map.
3. WHEN `revalidateMarkdownDocsForBib()` is called for a changed bib path, THE LSP_Server SHALL look up dependents from the Bib_Reverse_Map and revalidate only those documents, without iterating all open documents.

### Requirement 7: Streaming CriticMarkup Preprocessing

**User Story:** As a user with a document containing many CriticMarkup spans, I want the preprocessor to avoid repeated string slicing and rebuilding, so that preprocessing scales linearly with document size.

#### Acceptance Criteria

1. WHEN `preprocessCriticMarkup()` processes a document, THE preprocessor SHALL collect output segments into an array and join them once at the end, rather than repeatedly slicing and concatenating the result string.
2. WHEN the Streaming_Builder processes the document, THE preprocessor SHALL produce output identical to the current implementation for all inputs including nested `{>>...<<}` patterns and `{#id>>...<<}` patterns.

### Requirement 8: Preview Parser Efficiency

**User Story:** As a user previewing a large markdown document, I want the preview parser to minimize redundant string searches, so that preview rendering remains responsive.

#### Acceptance Criteria

1. WHEN `parseManuscriptMarkdown()` checks for a CriticMarkup pattern, THE Preview_Parser SHALL use character-code checks for the opening three characters before calling `indexOf` for the closing marker.
2. WHEN `manuscriptMarkdownBlock()` determines whether a line starts a multi-line pattern, THE Preview_Parser SHALL use character-code comparisons rather than slicing and array-inclusion checks.
3. WHEN the Preview_Parser searches for a closing marker, THE Preview_Parser SHALL limit the search to `state.posMax` (inline) or the block end boundary, avoiding scanning beyond the relevant region.

### Requirement 9: TextMate Grammar Injection Optimization

**User Story:** As a user editing a markdown document, I want the TextMate grammar injection patterns to be ordered and scoped for minimal per-line matching overhead, so that syntax highlighting remains responsive in large files.

#### Acceptance Criteria

1. WHEN the TextMate_Grammar injection patterns are evaluated, THE TextMate_Grammar SHALL order patterns so that the most frequently occurring and cheapest-to-match patterns (citation_list, footnote_ref, footnote_def) appear before more complex multi-character patterns.
2. WHEN the TextMate_Grammar defines match patterns, THE TextMate_Grammar SHALL use possessive quantifiers or atomic groups where supported to prevent unnecessary backtracking.
3. WHEN the TextMate_Grammar defines begin/end patterns, THE TextMate_Grammar SHALL use tight character-class constraints to minimize false-start matching attempts.

### Requirement 10: TextMate Grammar Code Scope Exclusion

**User Story:** As a user editing a markdown document containing inline code or fenced code blocks with CriticMarkup-like syntax (e.g. `{--...--}` in TypeScript), I want the Manuscript Markdown grammar injection to not apply inside code scopes, so that code content is not incorrectly highlighted as CriticMarkup.

#### Acceptance Criteria

1. WHEN the TextMate_Grammar injection selector is evaluated, THE TextMate_Grammar SHALL exclude inline code scopes (`markup.inline.raw`), fenced code block scopes (`markup.fenced_code`), embedded language scopes (`meta.embedded`), and string scopes (`string`) from injection.
2. WHEN a markdown document contains any Manuscript Markdown syntax (CriticMarkup delimiters like `{--`, `{++`, `{==`, format highlights like `==text==` or `==text=={color}`, citation brackets like `[@key]`, or footnote references like `[^ref]`) inside inline code or fenced code blocks, THE TextMate_Grammar SHALL NOT apply any Manuscript Markdown tokenization to that content.
3. WHEN CriticMarkup patterns appear in normal markdown prose (outside code scopes), THE TextMate_Grammar SHALL continue to tokenize them as before.
