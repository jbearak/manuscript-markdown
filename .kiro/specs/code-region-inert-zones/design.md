# Code Region Inert Zones Bugfix Design

## Overview

CriticMarkup syntax and Manuscript Markdown extensions (format highlights, citations) are incorrectly parsed, decorated, and acted upon inside code regions (inline code spans and fenced code blocks). Code regions are inert zones in Markdown — their content is literal text and no markup should be interpreted within them. This fix adds code-region awareness to five subsystems: editor decorations/navigation, preview rendering, MD→DOCX conversion, DOCX→MD conversion, and the LSP citation scanner.

The TextMate grammar already correctly excludes CriticMarkup scopes from code regions via `injectionSelector` (requirement 3.8), so syntax highlighting is unaffected.

## Glossary

- **Bug_Condition (C)**: CriticMarkup or Manuscript Markdown syntax appears inside a code region (inline code span or fenced code block) and is interpreted as live markup instead of literal text
- **Property (P)**: All syntax inside code regions is treated as literal text — no decorations, no navigation stops, no preview rendering, no conversion interpretation, no LSP actions
- **Preservation**: All behavior for syntax outside code regions must remain unchanged; CriticMarkup surrounding code spans (delimiters outside backticks) must continue to work
- **Code Region**: Either an inline code span (backtick-delimited: `` `...` ``, ``` ``...`` ```, etc.) or a fenced code block (triple-backtick or tilde block)
- **`extractAllDecorationRanges()`**: Single-pass char-by-char scanner in `src/highlight-colors.ts` that extracts all decoration ranges (highlights, comments, additions, deletions, substitutions, delimiters)
- **`getAllMatches()`**: Regex-based scanner in `src/changes.ts` that finds all CriticMarkup/highlight matches for navigation
- **`scanCitationUsages()`**: Regex-based scanner in `src/lsp/citekey-language.ts` that finds all `[@key]` citation references
- **`manuscriptMarkdownPlugin`**: markdown-it plugin in `src/preview/manuscript-markdown-plugin.ts` that renders CriticMarkup in preview
- **`processInlineChildren()`**: Token processor in `src/md-to-docx.ts` that converts markdown-it inline tokens to `MdRun` objects for DOCX generation

## Bug Details

### Fault Condition

The bug manifests when CriticMarkup or Manuscript Markdown syntax appears inside a code region. Five subsystems fail to check whether a match position falls within a code region before acting on it.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { text: string, matchStart: number, matchEnd: number }
  OUTPUT: boolean

  codeRegions := computeCodeRegions(input.text)
  // A match is buggy if it overlaps any code region
  RETURN EXISTS region IN codeRegions WHERE
         input.matchStart >= region.start AND input.matchStart < region.end
         OR input.matchEnd > region.start AND input.matchEnd <= region.end
END FUNCTION

FUNCTION computeCodeRegions(text)
  // Returns array of {start, end} for all inline code spans and fenced code blocks
  // Inline: backtick-delimited spans per CommonMark §6.1
  // Fenced: triple-backtick or tilde blocks per CommonMark §4.5
  regions := []
  // 1. Find fenced code blocks (``` or ~~~) — these take priority
  // 2. Find inline code spans (`...`, ``...``, etc.) in remaining text
  RETURN regions
END FUNCTION
```

### Examples

- `` `{++added text++}` `` — editor shows addition decorations on "added text" inside the code span; should show no decorations
- `` `==highlighted==` `` — editor shows highlight decoration; should show plain code
- `` `{>>comment<<}` `` — navigation stops on this match; should skip it
- ````markdown
  ```
  {--deleted--}
  ```
  ```` — editor decorates the deletion inside the fenced block; should not
- `` `[@smith2020]` `` — LSP provides completion/diagnostics for `smith2020`; should treat `@` as literal
- In preview, `` `{++added++}` `` renders as `<ins>added</ins>` inside `<code>`; should show literal `{++added++}`

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- CriticMarkup outside any code region continues to receive decorations, navigation, preview rendering, and conversion as before
- Format highlights (`==text==`, `==text=={color}`) outside code regions continue to work
- CriticMarkup that surrounds a code span (e.g., `{==` `` `code` `` `==}{>>comment<<}`) continues to be treated as live markup — the delimiters are outside the code span
- MD→DOCX conversion of CriticMarkup outside code regions is unchanged
- DOCX→MD conversion of comments/formatting outside code regions is unchanged
- LSP completions, diagnostics, and references for citations outside code regions are unchanged
- Fenced code blocks and inline code with no CriticMarkup render identically to before
- TextMate grammar tokenization of code regions is unchanged (already correct)

**Scope:**
All inputs where CriticMarkup/highlight/citation syntax does NOT fall inside a code region should be completely unaffected by this fix. This includes:
- CriticMarkup in regular paragraph text
- CriticMarkup in headings, list items, blockquotes
- Format highlights in any non-code context
- Citations in any non-code context

## Hypothesized Root Cause

Based on code analysis, the root causes are:

1. **`extractAllDecorationRanges()` has no code-region awareness**: The char-by-char scanner in `src/highlight-colors.ts` processes the entire document text without identifying or skipping code regions. It matches `{++`, `{--`, `{~~`, `{>>`, `{==`, `==...==` patterns regardless of whether they fall inside backtick spans or fenced blocks.

2. **`getAllMatches()` has no code-region awareness**: The combined regex in `src/changes.ts` runs against the full document text. It finds all CriticMarkup/highlight matches without filtering out those inside code regions. Navigation commands then stop on these false matches.

3. **Preview plugin inline rules fire inside code content**: The markdown-it inline rules (`parseManuscriptMarkdown`, `parseFormatHighlight`) registered in `src/preview/manuscript-markdown-plugin.ts` run on all inline content. While markdown-it's built-in `backtick` rule normally consumes inline code before custom rules fire, there may be edge cases where CriticMarkup delimiters interact with backtick parsing (e.g., unbalanced backticks, CriticMarkup spanning across code boundaries).

4. **DOCX→MD converter emits formatting inside code runs**: In `src/converter.ts`, `wrapWithFormatting()` applies highlight/bold/italic/strikethrough wrapping even when `fmt.code` is true. When a DOCX code run also has bold or highlight formatting, the output is e.g., `**\`code\`**` which is correct, but if the code run has CriticMarkup-triggering formatting (track changes, comments), those get emitted inside the code span. Comments whose boundaries fall inside code runs need expansion to surround the entire code span.

5. **`scanCitationUsages()` has no code-region awareness**: The regex-based scanner in `src/lsp/citekey-language.ts` finds all `[@key]` patterns in the document text without checking whether they fall inside code regions. The LSP then provides completions, diagnostics, and references for these false citations.


## Correctness Properties

Property 1: Fault Condition - Code Region Inertness

_For any_ document text containing CriticMarkup, format highlight, or citation syntax inside a code region (inline code span or fenced code block), the fixed subsystems SHALL NOT produce any decoration ranges, navigation matches, preview rendering, conversion interpretation, or LSP actions for those matches. Specifically:
- `extractAllDecorationRanges()` returns no ranges overlapping code regions
- `getAllMatches()` returns no ranges overlapping code regions
- The preview plugin renders code region content as literal text
- `scanCitationUsages()` returns no usages overlapping code regions

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.10, 2.11**

Property 2: Preservation - Non-Code-Region Behavior Unchanged

_For any_ document text where CriticMarkup, format highlight, or citation syntax appears entirely outside code regions, the fixed subsystems SHALL produce exactly the same results as the original (unfixed) code. No decoration ranges, navigation matches, or LSP results outside code regions are affected.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

Property 3: DOCX→MD Comment Boundary Expansion

_For any_ DOCX document where a comment boundary (start or end) falls inside a code-styled run, the fixed DOCX→MD converter SHALL expand the comment boundary to fall outside the code region:
- Comment fully inside code → expand to surround entire code span
- Comment starting before code but ending inside → expand end outside code
- Comment starting inside code but ending after → expand start outside code

**Validates: Requirements 2.7, 2.8, 2.9**

Property 4: DOCX→MD Formatting Stripping in Code Runs

_For any_ DOCX document where a code-styled run also carries formatting (bold, italic, highlight, track changes), the fixed DOCX→MD converter SHALL strip all non-code formatting from the run content and emit plain code text only.

**Validates: Requirements 2.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

### 1. Shared Code Region Detection Utility

**File**: `src/code-regions.ts` (new)

Create a utility function that computes code region ranges from document text. This is shared across subsystems to ensure consistent detection.

**Specific Changes**:
1. **Fenced code block detection**: Scan for lines starting with `` ``` `` or `~~~`, track open/close pairs, record `{start, end}` ranges covering the entire block including fences
2. **Inline code span detection**: Implement CommonMark §6.1 backtick string matching — find opening backtick strings, match with equal-length closing strings, record the span range including backticks
3. **Priority**: Fenced blocks take priority (detected first); inline spans are only detected in text outside fenced blocks
4. **Return type**: Sorted array of `{start: number, end: number}` ranges
5. **Helper**: `isInsideCodeRegion(offset: number, regions: CodeRegion[]): boolean` — binary search for O(log n) lookup

### 2. Editor Decorations — `extractAllDecorationRanges()`

**File**: `src/highlight-colors.ts`

**Function**: `extractAllDecorationRanges`

**Specific Changes**:
1. **Compute code regions** at the start of the function using the shared utility
2. **Skip code regions** in the char-by-char loop: when `i` enters a code region, advance `i` to the end of that region
3. **Also skip in `scanFormatHighlights`**: the nested highlight scanner must also check code region boundaries

### 3. Navigation — `getAllMatches()`

**File**: `src/changes.ts`

**Function**: `getAllMatches`

**Specific Changes**:
1. **Compute code regions** from the document text
2. **Filter matches**: after the regex scan, filter out any match whose range overlaps a code region
3. The cache invalidation already handles this since it's keyed on document version

### 4. Preview Rendering — markdown-it Plugin

**File**: `src/preview/manuscript-markdown-plugin.ts`

**Specific Changes**:
1. **No changes needed for inline code**: markdown-it's built-in `backtick` rule runs before custom inline rules and consumes inline code content as `code_inline` tokens. Custom rules never see content inside backtick spans.
2. **No changes needed for fenced code blocks**: markdown-it's `fence` rule handles these at block level. The content is never passed to inline rules.
3. **Verify edge cases**: Confirm that unbalanced backticks or CriticMarkup spanning code boundaries don't cause issues. If edge cases exist, add a guard in `parseManuscriptMarkdown` and `parseFormatHighlight` to check `state.env` for code context.

> **Design Decision**: markdown-it's architecture already provides code-region inertness for the preview. The inline rules only fire on non-code inline content. This subsystem may require no code changes, only test verification.

### 5. MD→DOCX Converter

**File**: `src/md-to-docx.ts`

**Specific Changes**:
1. **No changes needed for inline code**: markdown-it's `code_inline` rule consumes backtick content before custom rules fire. The `processInlineChildren` function already handles `code_inline` tokens by creating `{ type: 'text', code: true }` runs with no CriticMarkup interpretation.
2. **No changes needed for fenced code blocks**: The `convertTokens` function handles `fence` tokens at block level, creating `code_block` tokens with plain text runs.
3. **Verify edge cases**: Same as preview — confirm markdown-it's built-in rules provide sufficient protection.

> **Design Decision**: markdown-it's token architecture already provides code-region inertness for MD→DOCX. This subsystem may require no code changes, only test verification.

### 6. DOCX→MD Converter — Formatting Stripping

**File**: `src/converter.ts`

**Function**: `wrapWithFormatting`

**Specific Changes**:
1. **Strip non-code formatting when `fmt.code` is true**: When the run has `code: true`, skip all other formatting wrapping (highlight, bold, italic, strikethrough, underline, superscript, subscript). Only apply the backtick fence.
2. This ensures that DOCX code runs with incidental formatting (e.g., bold code in Word) emit clean `` `code` `` without `**` or `==` wrappers.

### 7. DOCX→MD Converter — Comment Boundary Expansion

**File**: `src/converter.ts`

**Function**: `buildMarkdown` (or a new helper called during markdown assembly)

**Specific Changes**:
1. **Detect code runs in comment ranges**: During markdown assembly, when emitting comment annotations, check if any comment boundary (start/end marker) would fall inside a code span
2. **Expand boundaries**:
   - Comment fully inside code → move both start and end outside the code span, wrapping the entire `` `code` `` in `{==...==}{>>comment<<}`
   - Comment end inside code → move end marker to after the closing backtick(s)
   - Comment start inside code → move start marker to before the opening backtick(s)
3. **Document as intentional limitation**: This is a lossy transformation — the comment's precise anchoring within the code text is lost, but this is necessary because CriticMarkup cannot appear inside code regions

### 8. LSP — `scanCitationUsages()`

**File**: `src/lsp/citekey-language.ts`

**Function**: `scanCitationUsages`

**Specific Changes**:
1. **Compute code regions** from the input text using the shared utility
2. **Filter usages**: after scanning, filter out any usage whose `keyStart`–`keyEnd` range overlaps a code region
3. **Also update `findCitekeyAtOffset`**: the bounded local scan should skip code regions too

### 9. Documentation

**File**: `docs/converter.md`

**Specific Changes**:
1. Add a section under "Known Limitations" documenting the DOCX→MD comment boundary expansion behavior as an intentional design decision
2. Explain that comments anchored inside code runs are expanded to surround the code span because CriticMarkup cannot appear inside code regions

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that place CriticMarkup syntax inside inline code spans and fenced code blocks, then check whether the subsystems incorrectly process them. Run these tests on the UNFIXED code to observe failures.

**Test Cases**:
1. **Decoration in inline code**: Call `extractAllDecorationRanges` on text containing `` `{++added++}` `` — expect ranges returned (bug) vs. no ranges (fixed)
2. **Navigation in fenced block**: Call `getAllMatches` on text with CriticMarkup inside a fenced code block — expect matches returned (bug) vs. no matches (fixed)
3. **LSP citation in code**: Call `scanCitationUsages` on text containing `` `[@smith2020]` `` — expect usages returned (bug) vs. no usages (fixed)
4. **DOCX→MD formatting in code run**: Convert a DOCX with bold+code run — expect `**\`text\`**` (bug) vs. `` `text` `` (fixed)

**Expected Counterexamples**:
- `extractAllDecorationRanges` returns addition/deletion/highlight ranges for positions inside code spans
- `getAllMatches` returns ranges inside fenced code blocks
- `scanCitationUsages` returns citation usages inside code spans
- Possible causes: no code-region detection in any of these functions

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed functions produce the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  decorations := extractAllDecorationRanges_fixed(input.text)
  ASSERT no decoration range overlaps any code region

  matches := getAllMatches_fixed(input.text)
  ASSERT no match range overlaps any code region

  usages := scanCitationUsages_fixed(input.text)
  ASSERT no usage range overlaps any code region
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed functions produce the same results as the original functions.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT extractAllDecorationRanges_original(input) = extractAllDecorationRanges_fixed(input)
  ASSERT getAllMatches_original(input) = getAllMatches_fixed(input)
  ASSERT scanCitationUsages_original(input) = scanCitationUsages_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many text combinations automatically across the input domain
- It catches edge cases with unusual backtick/CriticMarkup interactions
- It provides strong guarantees that behavior is unchanged for all non-code inputs

**Test Plan**: Observe behavior on UNFIXED code first for text without code regions, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Decoration preservation**: Generate random text with CriticMarkup but no code regions — verify `extractAllDecorationRanges` returns identical results before and after fix
2. **Navigation preservation**: Generate random text with CriticMarkup but no code regions — verify `getAllMatches` returns identical results
3. **LSP preservation**: Generate random text with citations but no code regions — verify `scanCitationUsages` returns identical results
4. **DOCX→MD preservation**: Convert DOCX with formatting outside code — verify identical markdown output

### Unit Tests

- Test `computeCodeRegions()` with various inline code and fenced block patterns
- Test `isInsideCodeRegion()` with boundary positions
- Test `extractAllDecorationRanges()` with CriticMarkup inside/outside code regions
- Test `getAllMatches()` with CriticMarkup inside/outside code regions
- Test `scanCitationUsages()` with citations inside/outside code regions
- Test `wrapWithFormatting()` with `code: true` and other formatting flags
- Test DOCX→MD comment boundary expansion for all three overlap cases

### Property-Based Tests

- Generate random documents mixing CriticMarkup and code regions; verify no decoration/navigation/LSP ranges overlap code regions
- Generate random documents with CriticMarkup only outside code regions; verify results match unfixed behavior
- Generate random code region configurations; verify `computeCodeRegions()` correctly identifies all regions

### Integration Tests

- Full MD→DOCX→MD round-trip with CriticMarkup inside code regions — verify code content preserved as literal text
- Preview rendering of documents with CriticMarkup inside code — verify literal display
- LSP diagnostics on documents with citations inside code — verify no false diagnostics
