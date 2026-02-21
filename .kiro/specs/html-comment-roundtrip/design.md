# HTML Comment Roundtrip Bugfix Design

## Overview

HTML comments (`<!-- ... -->`) are silently dropped during MD → DOCX conversion because `processInlineChildren()` in `src/md-to-docx.ts` only handles `<u>`, `<sup>`, `<sub>` formatting tags for `html_inline` tokens, and `convertTokens()` only handles HTML tables for `html_block` tokens. Any `<!-- ... -->` content is discarded.

The fix encodes HTML comments as invisible (vanish-styled) `w:r` runs in the DOCX output, using a `\u200B` (zero-width space) prefix to mark them as hidden comment carriers. On re-import, `extractDocumentContent()` in `src/converter.ts` detects these hidden runs and restores the original `<!-- ... -->` syntax. This mirrors the LaTeX `%` comment preservation pattern but operates at the document level (`w:r` runs with `<w:vanish/>`) rather than inside OMML math elements.

HTML comment delimiters inside inert zones (LaTeX math, code spans/blocks, CriticMarkup regions) are NOT treated as HTML comments — they pass through as literal text.

## Glossary

- **Bug_Condition (C)**: The input contains an HTML comment (`<!-- ... -->`) outside of inert zones, and the system is performing MD → DOCX → MD roundtrip
- **Property (P)**: The HTML comment is preserved through the roundtrip — encoded as an invisible run in DOCX and restored on re-import
- **Preservation**: All existing behavior for non-HTML-comment content must remain unchanged: formatting tags, HTML tables, CriticMarkup, LaTeX equations, code blocks, mouse clicks, etc.
- **`processInlineChildren()`**: The function in `src/md-to-docx.ts` that converts markdown-it inline tokens to `MdRun[]` — currently drops `html_inline` tokens that aren't `<u>/<sup>/<sub>` tags
- **`convertTokens()`**: The function in `src/md-to-docx.ts` that converts markdown-it block tokens to `MdToken[]` — currently only handles HTML tables for `html_block` tokens
- **`extractDocumentContent()`**: The function in `src/converter.ts` that walks DOCX XML and produces `ContentItem[]` — currently has no vanish/hidden run detection
- **Inert Zone**: A region where `<!-- -->` is literal text, not an HTML comment: LaTeX math (`$...$`, `$$...$$`), code regions (`` ` ``, ``` `` ```, etc.), CriticMarkup regions (`{>> <<}`, `{++ ++}`, `{-- --}`, `{== ==}`, `{~~ ~~}`)
- **Vanish Run**: A `w:r` element with `<w:vanish/>` in its `w:rPr`, making the text invisible in Word but present in the XML

## Bug Details

### Fault Condition

The bug manifests when a Markdown document contains HTML comments (`<!-- ... -->`) outside of inert zones. The `processInlineChildren()` function encounters `html_inline` tokens with comment content but has no handler for them — the `switch` statement's `html_inline` case only checks for `<u>`, `</u>`, `<sup>`, `</sup>`, `<sub>`, `</sub>`. Similarly, `convertTokens()` encounters `html_block` tokens containing standalone comments but only extracts HTML tables from them.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { markdown: string, tokenType: string, content: string }
  OUTPUT: boolean

  RETURN (input.tokenType == 'html_inline' OR input.tokenType == 'html_block')
         AND input.content matches /^<!--[\s\S]*?-->$/
         AND NOT isInsideInertZone(input.markdown, input.content)
END FUNCTION

FUNCTION isInsideInertZone(markdown, commentContent)
  RETURN isInsideLatexMath(markdown, commentContent)
         OR isInsideCodeRegion(markdown, commentContent)
         OR isInsideCriticMarkup(markdown, commentContent)
END FUNCTION
```

### Examples

- Inline comment: `text <!-- hidden note --> more text` → currently produces `text  more text` in DOCX (comment dropped); expected: comment encoded as invisible run, restored on re-import
- Standalone comment: `<!-- TODO: revise -->` on its own line → currently dropped entirely; expected: encoded as invisible run in its own paragraph
- Multiple comments: `A <!-- c1 --> B <!-- c2 --> C` → both comments dropped; expected: each encoded as separate invisible run
- Multi-line comment: `<!-- line1\nline2 -->` → dropped; expected: full content preserved including newlines
- Comment inside LaTeX: `$x <!-- not a comment --> y$` → should NOT be treated as HTML comment, passes through as LaTeX content (unchanged behavior)
- Comment inside code: `` `<!-- not a comment -->` `` → should NOT be treated as HTML comment, passes through as code content (unchanged behavior)
- Comment inside CriticMarkup: `{>> <!-- note --> <<}` → should NOT be treated as HTML comment, passes through as CriticMarkup content (unchanged behavior)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- HTML formatting tags (`<u>`, `<sup>`, `<sub>`) must continue to apply formatting in DOCX
- HTML tables in `html_block` tokens must continue to convert to Word tables
- LaTeX `%` comment preservation via OMML hidden runs must continue to work
- CriticMarkup (additions, deletions, substitutions, highlights, comments) must continue to convert to tracked changes and Word comments
- Code blocks and inline code must continue to convert to code-styled content
- Documents with no HTML comments must produce identical DOCX output
- `<!-- -->` inside inert zones must pass through as literal text unchanged

**Scope:**
All inputs that do NOT contain HTML comments outside inert zones should be completely unaffected by this fix. This includes:
- All existing formatting (bold, italic, underline, strikethrough, highlight)
- All existing structural elements (headings, lists, blockquotes, tables, code blocks)
- All existing special content (citations, footnotes, math equations)
- All existing CriticMarkup patterns
- Mouse/keyboard interactions in Word with adjacent hidden runs

## Hypothesized Root Cause

Based on the bug description and code analysis, the issues are:

1. **Missing `html_inline` comment handler in `processInlineChildren()`**: The `html_inline` case (line ~817 of `md-to-docx.ts`) only checks for `<u>`, `</u>`, `<sup>`, `</sup>`, `<sub>`, `</sub>`. When markdown-it produces an `html_inline` token with `<!-- ... -->` content, it falls through without producing any `MdRun`, silently dropping the comment.

2. **Missing `html_block` comment handler in `convertTokens()`**: The `html_block` case (line ~702 of `md-to-docx.ts`) only calls `extractHtmlTables()`. When a standalone `<!-- ... -->` appears as an `html_block` token, `extractHtmlTables()` finds no tables and produces nothing, silently dropping the comment.

3. **No vanish run detection in `extractDocumentContent()`**: Even if we encode comments as invisible runs in DOCX, the re-import path in `converter.ts` has no logic to detect `<w:vanish/>` in `w:rPr` and restore HTML comments. The `w:t` handler (line ~1613) just pushes text content items without checking for hidden run markers.

4. **No `html_comment` run type in `MdRun`**: The `MdRun` interface has no type for HTML comments, so `generateRuns()` has no case to emit vanish-styled runs for them.

## Correctness Properties

Property 1: Fault Condition - HTML Comments Preserved Through Roundtrip

_For any_ Markdown input containing one or more HTML comments (`<!-- ... -->`) outside of inert zones (LaTeX math, code regions, CriticMarkup), the fixed MD → DOCX conversion SHALL encode each comment as an invisible (vanish-styled) `w:r` run with a `\u200B` prefix in the DOCX output, and the fixed DOCX → MD re-import SHALL detect these hidden runs and restore the original `<!-- ... -->` syntax at the correct position, producing output identical to the input for the comment portions.

Property 2: Preservation - Non-Comment Content Unchanged

_For any_ Markdown input that does NOT contain HTML comments outside inert zones (including inputs with no HTML comments at all, inputs with HTML formatting tags, inputs with HTML tables, inputs with `<!-- -->` inside LaTeX/code/CriticMarkup), the fixed code SHALL produce exactly the same DOCX output and re-imported Markdown as the original code, preserving all existing functionality.

Property 3: Inert Zone Exclusion - Comments Inside Inert Zones Are Literal Text

_For any_ Markdown input where `<!-- -->` appears inside a LaTeX math region, code region, or CriticMarkup region, the fixed code SHALL NOT treat the `<!-- -->` as an HTML comment and SHALL pass it through as literal text within that region, identical to current behavior.

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/md-to-docx.ts`

**1. Add `html_comment` to `MdRun.type` union**:
- Extend the type union to include `'html_comment'`
- The `text` field carries the full comment content including `<!-- -->` delimiters

**2. Handle `html_inline` comments in `processInlineChildren()`**:
- In the `html_inline` case, before checking for formatting tags, check if `token.content` matches `<!--` prefix
- If so, push an `MdRun` with `type: 'html_comment'` and `text: token.content`
- Existing formatting tag handling remains unchanged

**3. Handle `html_block` comments in `convertTokens()`**:
- In the `html_block` case, before calling `extractHtmlTables()`, check if `token.content` matches an HTML comment pattern
- If so, create a paragraph `MdToken` with an `html_comment` run
- Existing HTML table handling remains unchanged

**4. Emit vanish-styled runs in `generateRuns()`**:
- Add an `else if (run.type === 'html_comment')` case
- Generate: `<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">\u200B<!-- comment --></w:t></w:r>`
- The `\u200B` prefix marks this as a hidden comment carrier (same pattern as LaTeX comments in OMML)

**5. Detect vanish runs in `extractDocumentContent()` in `src/converter.ts`**:
- In the `w:r` handler, after parsing `w:rPr`, check for `<w:vanish/>` presence
- If vanish is detected and the text starts with `\u200B`, extract the payload after the prefix
- If the payload matches `<!-- ... -->`, push a `ContentItem` with the HTML comment text
- Otherwise fall through to normal text handling

**6. Restore HTML comments in `buildMarkdown()` / `renderInlineRange()`**:
- When rendering text content items, detect the `\u200B`-prefixed HTML comment pattern and emit the raw `<!-- ... -->` syntax
- Alternatively, add an `'html_comment'` content item type to `ContentItem` for cleaner separation

### Encoding Format

The hidden run in DOCX XML will look like:
```xml
<w:r>
  <w:rPr><w:vanish/></w:rPr>
  <w:t xml:space="preserve">​<!-- hidden note --></w:t>
</w:r>
```
(where `​` is `\u200B`, the zero-width space prefix)

On re-import, the converter detects:
1. `w:vanish` in `w:rPr` → this is a hidden run
2. Text starts with `\u200B` → this is a comment carrier
3. Payload after `\u200B` starts with `<!--` → restore as HTML comment

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that parse Markdown containing HTML comments through `parseMd()` and `processInlineChildren()`, then check whether `html_comment` runs are produced. Run on UNFIXED code to observe that comments are silently dropped.

**Test Cases**:
1. **Inline Comment Drop Test**: Parse `text <!-- note --> more` and verify no `html_comment` run is produced (will fail to find comment on unfixed code)
2. **Block Comment Drop Test**: Parse `<!-- standalone -->` as `html_block` and verify it produces no output (will produce empty result on unfixed code)
3. **Multiple Comment Drop Test**: Parse `A <!-- c1 --> B <!-- c2 --> C` and verify both comments are missing (will fail on unfixed code)
4. **Roundtrip Loss Test**: Convert `text <!-- note --> more` to DOCX and back, verify comment is missing in output (will fail on unfixed code)

**Expected Counterexamples**:
- `processInlineChildren()` produces no run for `html_inline` tokens containing `<!-- ... -->`
- `convertTokens()` produces no token for `html_block` tokens containing only `<!-- ... -->`
- Roundtrip output is missing the `<!-- ... -->` portions entirely

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  docx := convertMdToDocx_fixed(input.markdown)
  ASSERT docxContainsVanishRun(docx, input.commentContent)
  markdown_out := convertDocx_fixed(docx)
  ASSERT markdown_out CONTAINS input.commentContent
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT convertMdToDocx_original(input) = convertMdToDocx_fixed(input)
  ASSERT convertDocx_original(input) = convertDocx_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for documents without HTML comments, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Formatting Tag Preservation**: Verify `<u>`, `<sup>`, `<sub>` tags continue to produce correct formatting runs after the fix
2. **HTML Table Preservation**: Verify HTML tables in `html_block` tokens continue to convert to Word tables
3. **LaTeX Comment Preservation**: Verify LaTeX `%` comments in equations continue to roundtrip via OMML hidden runs
4. **CriticMarkup Preservation**: Verify CriticMarkup patterns continue to convert to tracked changes
5. **Inert Zone Literal Preservation**: Verify `<!-- -->` inside code/math/CriticMarkup passes through as literal text

### Unit Tests

- Test `processInlineChildren()` with `html_inline` comment tokens → produces `html_comment` run
- Test `convertTokens()` with `html_block` comment tokens → produces paragraph with `html_comment` run
- Test `generateRuns()` with `html_comment` run → produces vanish-styled `w:r` XML
- Test `extractDocumentContent()` with vanish run containing `\u200B<!-- ... -->` → produces HTML comment content item
- Test full roundtrip: MD → DOCX → MD preserves inline, block, multiple, and multi-line comments
- Test inert zone exclusion: `<!-- -->` inside `$...$`, backtick regions, CriticMarkup is not treated as comment

### Property-Based Tests

- Generate random Markdown with HTML comments at various positions and verify roundtrip preservation (use fast-check with short bounded generators per AGENTS.md)
- Generate random Markdown WITHOUT HTML comments and verify DOCX output is identical before and after fix
- Generate random comment content (including special characters, newlines) and verify encoding/decoding roundtrip

### Integration Tests

- Test full `convertMdToDocx()` → `convertDocx()` pipeline with inline HTML comments
- Test full pipeline with standalone HTML comments
- Test full pipeline with mixed content: HTML comments + formatting + CriticMarkup + math + code
- Test that Word-edited documents with adjacent visible text preserve hidden comment runs
