# AGENTS.md - LLM Guidance for Manuscript Markdown

This file is intentionally short. It's a map to the docs and a short list of invariants that are easy to regress.

IMPORTANT: Treat this as a living document. When you fix a subtle bug or a recurring LLM mistake, update **"Learnings"** (and keep the pointers and invariants current) as part of the same change.

## What to read (in order)

User-facing:
- `README.md`
- `docs/` (guides and feature documentation)

Code (authoritative for behavior):
- Navigation: `src/changes.ts`
- Formatting: `src/formatting.ts`
- Preview: `src/preview/manuscript-markdown-plugin.ts`
- Syntax highlighting: `syntaxes/manuscript-markdown.json`

## Key invariants (do not regress)

- **Multi-line pattern support**
  - Patterns can span multiple lines including empty lines
  - Multi-line patterns must start at beginning of line for **preview rendering** only
  - Navigation commands (next/previous change) work for patterns at any position
  - See `src/changes.ts` getAllMatches() for pattern detection

- **Pattern filtering**
  - Overlapping/nested patterns are filtered to prevent duplicates
  - Use strict containment checks to identify overlapping matches

- **Configuration**
  - Author name handling respects `manuscriptMarkdown.authorName` setting and falls back to OS username
  - Timestamps are ISO 8601 format
  - See `src/author.ts` for implementation

- **Preview rendering**
  - markdown-it plugin handles both inline and block-level patterns
  - Multi-line patterns must start at line beginning for block-level detection
  - CSS classes are standardized in `media/manuscript-markdown.css`

## Quick commands

- Setup: `bun install`
- Compile: `bun run compile`
- Watch: `bun run watch`
- Test: `bun test`
- Package: `bunx vsce package`

## Learnings

- Multi-line pattern regex: Use `[\s\S]*?` for content (including newlines), not just `.+`
- TextMate grammar has limitations with complex multi-line patterns; focus on correctness in code, not perfect highlighting
- When filtering overlapping patterns, ensure the containment check covers both start and end positions
- table reflow: Preserve existing alignment/padding patterns; only reflow when explicitly requested
- Author name configuration: Always check settings first, then fall back to username via `os.userInfo()`
- Property tests: Use fast-check with constraints to avoid timeout on large generated strings; prefer shorter bounded generators
- Multi-line preview rendering: markdown-it requires patterns to start at block level (line beginning); use the block rule, not inline
- Table parsing: Handle edge cases like cells with pipes in code or quotes; use careful boundary detection
- VSIX packaging: Do not exclude `node_modules/**` in `.vscodeignore` when runtime deps are imported from `out/*.js`; doing so causes extension activation failure and "command not found" errors in installed builds (even if it works in extension development host)
- DOCX conversion outputs: Before writing `${base}.md` / `${base}.bib`, detect pre-existing targets and prompt with overwrite/rename/cancel to prevent silent data loss
- DOCX commented text rendering: Group adjacent text runs by identical `commentIds` even when run formatting differs, emit one `{==...==}` block + one annotation sequence, and clear per-run `highlight` inside that block to avoid `{====...====}` output
- DOCX run formatting inheritance: Apply `w:pPr/w:rPr` paragraph defaults to child runs and only override inherited formatting for properties explicitly present in run-level `w:rPr`
- DOCX hyperlink Markdown safety: When URLs contain parentheses/whitespace, emit link destinations in angle brackets (`[text](<url>)`) to avoid broken Markdown link parsing
- DOCX hyperlink Markdown safety: Also wrap destinations containing `[` or `]` in angle brackets, since square brackets in raw destinations can break link parsing in common Markdown parsers
- TextMate inline highlight regex should exclude `=` inside `==...==` captures (e.g., `[^}=]+`) so multiple inline highlights on one line tokenize as separate spans and stay consistent with preview rendering
- Template literal corruption: Never use `$$` inside JS/TS template literals in tool edits — the `$` is interpreted as end-of-expression. Use string concatenation instead (e.g., `'$$' + '\n' + val + '\n' + '$$'`)
- Colored highlight syntax `==text=={color}`: The `{color}` suffix is unambiguous with CriticMarkup `{==text==}` because CriticMarkup uses `{` *before* `==`, not after
- Navigation regex ordering: Colored format highlights `==text=={color}` must appear before plain `==text==` in the combined pattern so the color suffix is consumed greedily
- Preview plugin config access: Use module-level get/set functions in a shared module (e.g., `highlight-colors.ts`) to pass VS Code settings to the markdown-it plugin without importing `vscode` in the plugin file
- Editor decorations: Use `DecorationRenderOptions` `light` and `dark` sub-properties for theme-aware backgrounds; VS Code auto-selects the correct variant
- Preview suffix parsing: In `==text=={color}`, only treat `{...}` as a color suffix when the closing `}` is within parse bounds and the identifier matches `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?` (no leading/trailing `-`); otherwise keep it as literal text so adjacent CriticMarkup (for example `{--...--}`) is not swallowed as a color suffix
- Highlight fallback hierarchy: For `==text=={invalid}`, use configured `manuscriptMarkdown.defaultHighlightColor` first; only fall back to yellow/amber when the configured default is invalid/unavailable, and keep preview/editor extraction behavior aligned
- Deletion editor styling: Do not set an explicit foreground color decoration for `{--...--}` content; this can briefly show TextMate/theme `markup.deleted` color, then get overridden by extension decorations (visible flicker). Apply only strikethrough in the decoration and let theme token colors drive foreground.
- Comment editor styling: Do not set an explicit foreground color decoration for `{>>...<<}` content; this can briefly show theme token color, then get overridden by extension decorations (visible flicker). Keep only background + italic so theme token foreground remains stable.
- Comment token scope mapping: In TextMate grammar, scope `{>>...<<}` as `meta.comment*` (not `comment.block*`). The `comment.block` scope suppresses VS Code editor features (bracket matching, auto-complete, snippets) inside those regions. CriticMarkup comments are editorial annotations, not code comments, so `meta.comment` preserves editor functionality while still allowing theme customization.
- Zotero URI key extraction: The regex `/\/items\/([A-Z0-9]{8})$/` works for all three Zotero URI formats (local, synced, group) since they all end with `/items/{KEY}`
- Zotero field code `citationItems`: Check both `uris` (array) and `uri` (singular) as fallback since different Zotero versions may use either form
- Zotero locators belong in Markdown Pandoc citations (`[@key, p. 20]`), not in BibTeX entries, because locators are per-citation-instance, not per-bibliographic-entry
- Zotero numeric locators: Some Zotero versions/plugins may serialize locators as JSON numbers instead of strings; coerce to string with `String()` during extraction and in `sanitizeLocator()` to prevent silent data loss
- Verbatim BibTeX/CSL fields: DOI, URL, ISBN, and ISSN are machine-readable identifiers, not LaTeX text — do NOT apply `escapeBibtex()` to them. They are listed in `VERBATIM_BIBTEX_FIELDS` (`bibtex-parser.ts`) and `VERBATIM_CSL_FIELDS` (`converter.ts`) and emitted as-is. Escaping these fields corrupts their values (e.g., underscores in DOIs become `\_`)
- LaTeX script binding: In LaTeX-to-OMML conversion, apply `^`/`_` to the nearest preceding atom (not the whole accumulated expression), and attach body scripts inside n-ary `<m:e>` content when parsing `\\sum`/`\\int` style operators
- Zotero grouped citations: Mixed groups are split — Zotero entries become a field code, non-Zotero entries become plain formatted text, missing keys appear as `@citekey` inline with a post-bibliography note. Configurable via `mixedCitationStyle`: `separate` (default, maintains clean Zotero refresh by isolating field codes) or `unified` (single parenthetical, cleaner appearance but may desync on Zotero refresh)
- CSL year reconstruction: Only set `issued.date-parts` when BibTeX `year` is fully numeric; never emit `date-parts:[[null]]`
- BibTeX entry scanning: Quote-state detection must count consecutive preceding backslashes before `\"` to avoid mis-parsing entries containing escaped backslashes and quotes
- BibTeX scanner literals: When comparing `input[k]` (single character), compare against `'\\'` (or char code), not `'\\\\'` (two-character runtime string), otherwise backslash counts silently stay zero
- CSL file path resolution order: file-like values (ending `.csl` or absolute) resolve relative to `sourceDir` first, then fall through to bundled/cache/download; bundled style names are unaffected
- Delimiter parsing (`\\left...\\right`): If the right-delimiter token is combined text like `)+c`, preserve trailing text by re-inserting `+c` into the token stream after consuming the delimiter character
- Delimiter inner parsing: Script operators (`^`, `_`) inside `\\left...\\right` must be parsed with script-binding logic (not emitted as literal text runs)
- OMML text extraction: `<m:t>` content is XML-escaped; unescape entities before passing it back through `escapeXmlChars()` to avoid double-escaping (e.g. `&amp;` → `&amp;amp;`)
- CLI flag parsing: For value-taking flags, validate both missing-next-arg and next-token-is-another-flag (`--...`) before consuming; otherwise `args[++i]` can silently propagate `undefined` into downstream file I/O
- CLI output path derivation: If extension detection is case-insensitive, derive basenames by stripping `path.extname(inputPath)` (actual-case extension) rather than a hard-coded lowercase suffix to avoid doubled extensions like `.DOCX.md`
- CLI DOCX→MD conflicts: Preserve the up-front combined `.md` + `.bib` conflict check so when both exist, one error reports both paths (Requirement 3.3) instead of surfacing them in separate runs
- Bun compile targets: Keep `scripts/build-binary.ts` target list aligned with targets actually downloadable in pinned Bun; on Bun `1.3.9`, `bun-windows-aarch64` is unavailable, so including Windows ARM64 causes deterministic CI release-build failures
- Frontmatter bibliography field: Accepts `bibliography`, `bib`, or `bibtex` as key names (first match wins). Normalize `.bib` extension with `normalizeBibPath()`. Resolution order: relative to `.md` dir → workspace root (VS Code only) → fallback `{basename}.bib`. For `/`-prefixed paths: workspace root → absolute OS path → fallback. Warn only when `hasCitations()` is true. CLI `--bib` flag takes precedence over frontmatter value
- HTML entity decoding order: In `decodeHtmlEntities()`, decode `&amp;` after other named entities (`&lt;`, `&gt;`, etc.) to avoid over-decoding double-encoded literals like `&amp;lt;...&amp;gt;`
- Numeric HTML entities: Use `String.fromCodePoint()` (not `String.fromCharCode()`) when decoding `&#...;` / `&#x...;` so supplementary-plane characters (above U+FFFF) decode correctly
- DOCX table import rendering: Prefer HTML table output over pipe tables for DOCX→Markdown so long/multi-paragraph cells remain structured, and preserve in-cell semantics (comments, Critic changes/highlights, citations, math, links) by reusing existing run-level rendering rules inside each cell paragraph
- LSP references from markdown — intentional asymmetry: When `onReferences` is invoked from a markdown file, we return only the .bib declaration by default. VS Code's built-in Markdown Language Features extension already finds all `@citekey` occurrences across workspace markdown files (it treats `@`-words as word-level symbols). Since VS Code merges results from every provider, returning markdown locations ourselves would duplicate them. From a .bib file the built-in extension is not involved, so we return the full set of markdown usages. This is working as intended — do not "fix" the asymmetry. Users who want our results anyway (e.g. built-in extension disabled) can enable `manuscriptMarkdown.citekeyReferencesFromMarkdown`.
- LSP references dedupe: When aggregating references from open docs + workspace scans, dedupe by canonical filesystem path (realpath + normalized case on macOS/Windows) plus range, not raw URI string, to avoid duplicate hits from symlink/alias URI variants
- LSP BibTeX key offsets: In `parseBibDataFromText()`, locate keys starting after the opening `{` (not first substring match in the whole entry header) so keys like `book` in `@book{book,...}` map to the correct definition range
- LSP references request coalescing: Some clients may issue near-identical back-to-back reference requests that differ only by `includeDeclaration`; coalesce the second response to declaration-only when the usage set is unchanged to avoid doubled markdown usage entries in the references UI
- Extension DOCX->MD settings parity: Keep `manuscriptMarkdown.alwaysUseCommentIds` wired in both CLI and VS Code command paths; otherwise users get divergent conversion output depending on entrypoint
- Table HTML emission with ID comments: In `alwaysUseCommentIds` mode, emit deferred `{#id>>...<<}` bodies outside cell `<p>` tags (same as paragraph-level flow) so paragraph content and annotation blocks remain structurally separated
- TextMate comment grammar for `{>>...<<}`: Use `begin`/`end` (not single-line `match`) to preserve multi-line comment highlighting
- TextMate comment-with-ID grammar for `{#id>>...<<}`: Use `begin`/`end` with explicit `endCaptures` for `<<` and `}` so closing delimiters keep tag punctuation scope instead of inheriting comment-body scope
- Delimiter decoration extraction: `extractCriticDelimiterRanges()` must skip comment delimiters (`{>>` and `<<}`) and highlight delimiters (`{==` and `==}`), including `{#id>>...<<}` closers, so editor decoration foreground does not override TextMate tag punctuation scopes on those delimiters
- Comment ID remap coverage: When building 1-indexed markdown comment IDs, collect IDs from both top-level inline content and nested table-cell paragraphs; otherwise table-only comments can leak raw DOCX IDs
- Cross-paragraph comment overlap detection: Overlap detection must be performed globally across the entire document during metadata collection in `buildMarkdown`, not per-segment during rendering. Use `detectGlobalOverlaps()` to build comment ranges across all content (including table cells) and mark all overlapping comment IDs in `forceIdCommentIds`. This ensures comments that overlap anywhere use ID syntax consistently everywhere, preventing duplicate body emission when a comment spans multiple paragraphs with varying overlap states
- CriticMarkup auto-closing pairs: `language-configuration.json` adds multi-character auto-closing pairs (`{>>`→`<<}`, `{++`→`++}`, etc.) for Markdown. VS Code merges these with built-in Markdown pairs. Multi-character pairs take precedence over single-character `{`→`}`, preventing unwanted extra characters when typing CriticMarkup delimiters
- Non-numeric comment ID roundtrip: Persist markdown↔OOXML comment ID mapping in `docProps/custom.xml` under `MANUSCRIPT_COMMENT_IDS[_N]` (240-char chunks). On DOCX→MD, prefer mapped IDs first and only allocate fresh numeric IDs for unmapped comments (collision-safe fallback)
- LSP completion triggers: Keep `completionProvider.triggerCharacters` narrow (`@`, `:`) and handle ongoing value/citekey edits via editor-side retriggering; broad trigger characters (especially space) can cause noisy global “no suggestions” popups in unrelated contexts
- Editor-side `csl:` auto-suggest retriggering: Trigger only on direct single-character typing/backspace edits; do not retrigger on replacement edits from completion acceptance (e.g., Tab), or the suggest menu may re-open and appear “stuck”
- Editor-side citekey auto-suggest retriggering: Apply the same direct single-character typing/backspace gate and retrigger when cursor remains in citekey completion context (`[@...`) so suggestions appear while editing existing citekeys, not only immediately after typing `@`
- Citekey delimiter UX: When user types `;` (and immediate following space) to move to the next citation in a grouped cite (`[@a; @b]`), explicitly dismiss the suggest widget based on citation-segment context to avoid showing an empty “no suggestions” menu state
- CSL completion range boundaries: `getCslCompletionContext()` must return `valueStart/valueEnd` for the full editable CSL value (excluding surrounding quotes) and return `undefined` when the cursor is still in the `csl:` key prefix, so LSP `textEdit.range` is never inverted and does not consume YAML quotes
- Set Citation Style EOL safety: In `setCitationStyle`, use `TextDocument.eol` for inserted frontmatter/new lines and avoid replacing trailing `\r` when updating an existing `csl:` line, so CRLF documents do not gain mixed line endings
- Cross-scope citation key dedup: `buildCitationKeyMap` accepts optional `existingKeys?: Set<string>` to seed its `seen` set; pass document-level key values when building note-scope keys to prevent ambiguous `[@key]` references from independently-generated identical keys in different scopes
- Footnote body multi-line indentation: When `bodyParts[0]` is multi-line, use block form (`[^label]:\n\n    indented`); all continuation parts and deferred comments must be indented per-line (every `\n`-separated line gets 4-space prefix), not just the first line
- Footnote definition fence detection: In `extractFootnoteDefinitions`, check for continuation lines (4-space/tab indent) before fence markers when `currentLabel` is defined, so indented code fences inside footnote bodies are captured as definition content rather than leaking into cleaned output
- Footnote display math rendering: In `buildMarkdown` note-body emission, treat `item.type === 'math' && item.display` as its own body part (`$$...$$`) rather than letting inline rendering absorb it, so footnote definitions keep block separation
- Footnote body stopBeforeDisplayMath: All `renderInlineRange` calls in the footnote body rendering loop must pass `{ stopBeforeDisplayMath: true }` (not `undefined`), otherwise display math items are consumed inline *and* emitted as separate block parts, producing duplicated equations in the markdown output
