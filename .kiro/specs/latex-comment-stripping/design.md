# LaTeX Comment Stripping Bugfix Design

## Overview

LaTeX `%` comments are passed through as literal text in OMML output because `tokenize()` in `src/latex-to-omml.ts` has no handling for the `%` character — it falls into the "regular text" branch and gets emitted as visible content. The fix adds comment-aware tokenization that strips comment text from visible output, embeds comments as non-visible OMML elements (using a hidden `m:r` run with a custom style marker), and restores them on re-import via `ommlToLatex()` in `src/omml.ts`. Escaped `\%` (already handled as a single-char command token) remains unaffected.

## Glossary

- **Bug_Condition (C)**: The input LaTeX contains an unescaped `%` character (not preceded by `\`) — everything from `%` to end-of-line is a comment
- **Property (P)**: Comments are stripped from visible OMML output and embedded as non-visible inline elements preserving the comment text and preceding whitespace
- **Preservation**: All non-comment LaTeX conversion behavior remains identical — escaped `\%`, equations without `%`, mouse/keyboard interactions, and roundtrip fidelity for comment-free equations
- **`tokenize()`**: The function in `src/latex-to-omml.ts` that splits a LaTeX string into tokens (commands, braces, text, etc.) — currently has no `%` handling
- **`ommlToLatex()`**: The function in `src/omml.ts` that walks parsed OMML XML and translates each node back to LaTeX
- **`translateRun()`**: The function in `src/omml.ts` that converts an `m:r` (run) element to LaTeX text
- **`translateNode()`**: The dispatcher in `src/omml.ts` that routes each OMML element to its translator

## Bug Details

### Fault Condition

The bug manifests when a LaTeX equation string contains an unescaped `%` character. The `tokenize()` function's "regular text" branch collects all characters that are not `\`, `{`, `}`, `^`, `_`, or `&` — which includes `%` and everything after it on the line. This text token is then emitted as a visible `<m:r><m:t>...</m:t></m:r>` run in the OMML output.

**Formal Specification:**
```text
FUNCTION isBugCondition(input)
  INPUT: input of type string (LaTeX equation source)
  OUTPUT: boolean

  FOR each character ch at position i in input:
    IF ch == '%':
      count := 0
      j := i - 1
      WHILE j >= 0 AND input[j] == '\\':
        count := count + 1
        j := j - 1
      IF count is even:   // 0 backslashes = unescaped, 2 = double-escaped, etc.
        RETURN true
  RETURN false
END FUNCTION
```

### Examples

- `x^2 % superscript` → Currently outputs `% superscript` as visible text in Word. Expected: only `x^2` visible; comment embedded as hidden element with preceding whitespace (spaces between `2` and `%`)
- Multi-line `align*` with `x^2          % superscript\nx_i          % subscript` → Currently shows both comments as visible text. Expected: only equation content visible; each comment embedded with its preceding whitespace preserved
- `x + y% line continuation\n+ z` → Currently shows `% line continuation` as visible text. Expected: lines joined as `x + y+ z` with a hidden line-continuation marker
- `50\% discount` → Currently works correctly (escaped `\%` produces literal `%`). Expected: no change — `\%` is tokenized as a single-char command `\%` before the `%` check runs

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Escaped `\%` must continue to render as a literal `%` symbol in OMML output (already handled as a single-char command token by the `\\` branch of `tokenize()`)
- Equations without any `%` characters must produce identical OMML output
- The non-comment portion of equations containing `%` comments must convert to OMML identically
- Comment-free equations roundtripped through MD → DOCX → MD must produce semantically equivalent LaTeX
- All existing OMML element translations (`m:f`, `m:sSup`, `m:sSub`, `m:rad`, `m:nary`, `m:d`, `m:acc`, `m:m`, `m:func`, `m:eqArr`, etc.) remain unchanged

**Scope:**
All inputs that do NOT contain an unescaped `%` character should be completely unaffected by this fix. This includes:
- Equations with only `\%` (escaped percent)
- Equations with no percent characters at all
- All existing OMML-to-LaTeX translations for non-comment elements

## Hypothesized Root Cause

Based on the bug description and code analysis, the root cause is clear:

1. **Missing `%` handling in `tokenize()`**: The tokenizer in `src/latex-to-omml.ts` (line 107) has branches for `\`, `{`, `}`, `^`, `_`, and `&`, but no branch for `%`. The fallback "regular text" branch at the end collects `%` and all subsequent characters until it hits one of the handled special characters or end-of-string. Since newline `\n` is not a stop character either, the comment text (and potentially the newline) gets bundled into a text token.

2. **No comment-aware OMML element**: There is no mechanism to embed a non-visible comment in the OMML output. We need a convention for a hidden run that `translateNode()`/`translateRun()` in `src/omml.ts` can recognize on re-import.

3. **No extraction logic in `ommlToLatex()`**: The `translateRun()` function in `src/omml.ts` extracts text from `m:t` nodes and maps Unicode back to LaTeX, but has no logic to detect hidden comment markers and restore them as `%` comments.

4. **No line-continuation handling**: The `%` at end-of-line in LaTeX suppresses the newline whitespace (line continuation). The tokenizer has no concept of this — it would need to strip the `%`, the newline, and any leading whitespace on the next line, while embedding a marker for roundtrip restoration.

## Correctness Properties

Property 1: Fault Condition - Comments Stripped and Embedded

_For any_ LaTeX input where an unescaped `%` appears (isBugCondition returns true), the fixed `latexToOmml` function SHALL produce OMML output where (a) no comment text appears in any visible `m:t` element, and (b) each comment is embedded as a non-visible inline element that stores the comment text and the preceding whitespace (spaces/tabs between equation content and `%`).

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Non-Comment Conversion Unchanged

_For any_ LaTeX input where no unescaped `%` appears (isBugCondition returns false), the fixed `latexToOmml` function SHALL produce exactly the same OMML output as the original function, preserving all existing conversion behavior for equations, escaped `\%`, and all OMML element types.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

Property 3: Roundtrip - Comment Restoration on Re-Import

_For any_ OMML output containing embedded non-visible comment elements (produced by the fixed `latexToOmml`), the fixed `ommlToLatex` function SHALL extract the hidden elements and restore them as LaTeX `%` comments at their original positions, including the original whitespace (spaces/tabs) before the `%` character.

**Validates: Requirements 2.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/latex-to-omml.ts`

**Function**: `tokenize()`

**Specific Changes**:
1. **Add `%` branch to tokenizer**: Before the "regular text" fallback, add a check for `%`. When an unescaped `%` is encountered:
   - Capture the preceding whitespace (spaces/tabs) between the last non-whitespace content and the `%` by looking back in the current text accumulation or by trimming trailing whitespace from the preceding text token
   - Capture the comment text (everything from `%` to end-of-line or end-of-string)
   - Emit a new `comment` token type containing both the whitespace prefix and comment text
   - If the `%` is at end-of-line (line continuation), also consume the newline character and emit a `line_continuation` token variant
2. **Add `comment` token type to `Token` interface**: Extend the type union with `'comment' | 'line_continuation'`
3. **Handle comment tokens in `Parser.parseToken()`**: For `comment` tokens, emit a non-visible OMML element instead of a visible run. The hidden element should use a convention like `<m:r><m:rPr><m:sty m:val="p"/><m:nor/></m:rPr><m:t xml:space="preserve">%COMMENT:ws:text</m:t></m:r>` wrapped in a recognizable structure — or better, use a dedicated approach such as an `m:r` with a distinctive run property that `translateRun()` can detect. A practical approach: emit a zero-width run with a custom annotation, e.g., `<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>&#x200B;%COMMENT{ws}{text}</m:t></m:r>` — but this risks the zero-width space being visible. A cleaner approach: use Word's `w:vanish` property or simply store the comment in an `m:t` element with a prefix marker that `translateRun()` can detect and suppress. The simplest reliable approach: use a run with a known prefix like `\u200B` (zero-width space) followed by a structured comment payload, and have `translateRun()` detect this prefix and skip visible output.

   **Recommended approach**: Emit comments as `<m:r><m:rPr><m:nor/></m:rPr><m:t xml:space="preserve">\u200B%{base64(ws)}:{comment_text}</m:t></m:r>`. The `m:nor` (normal text) property combined with the `\u200B` prefix creates a unique signature. On re-import, `translateRun()` checks for the `\u200B%` prefix and restores the comment. No base64 needed if we use a simpler delimiter — store as `\u200B%{ws_length}:{comment_text}` where `ws_length` encodes the whitespace as a repeat count, or just store the raw whitespace since `xml:space="preserve"` keeps it.

   **Simplest viable approach**: Store as `<m:r><m:rPr><m:nor/></m:rPr><m:t>\u200B%COMMENT:</m:t></m:r>` where the full payload is `\u200B` + `%` + whitespace + `COMMENT_TEXT`. The `\u200B%` prefix is the detection key. The whitespace between `\u200B%` and the comment text IS the original whitespace. Wait — that conflates the whitespace. Better: `\u200B` + preceding_whitespace + `%` + comment_text. Then on re-import, split on first `%` after the `\u200B` to recover whitespace and comment text.

4. **For line-continuation `%`**: Emit a marker like `\u200B%\n` (zero-width space + percent + newline) to distinguish from regular comments. On re-import, restore as `%\n`.

**File**: `src/omml.ts`

**Function**: `translateRun()`

**Specific Changes**:
5. **Detect hidden comment runs**: After extracting text from `m:t` nodes, check if the text starts with `\u200B`. If so, parse it as a comment marker and emit the restored LaTeX comment (`whitespace` + `%` + `comment_text` + `\n`). For line-continuation markers, emit `%\n` (no trailing newline in the LaTeX output — the `%` suppresses it).

**File**: `docs/latex-equations.md`

6. **Add Comments section**: Document that `%` starts a line comment in LaTeX, everything after it to end-of-line is ignored, and that comments are preserved through roundtrip (invisible in Word, restored on re-import).

**File**: `docs/converter.md`

7. **Add comment handling documentation**: In the LaTeX Equations section, document that comments are stripped from visible OMML, embedded as non-visible elements, and restored on re-import.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that call `latexToOmml()` with LaTeX strings containing `%` comments and assert that the comment text does NOT appear in visible `m:t` elements. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:
1. **Single-line comment test**: `latexToOmml('x^2 % superscript')` — assert output does not contain `superscript` in any `m:t` element (will fail on unfixed code)
2. **Multi-line comment test**: `latexToOmml('x^2          % superscript\nx_i          % subscript')` — assert neither comment appears visibly (will fail on unfixed code)
3. **Line-continuation test**: `latexToOmml('x + y%\n+ z')` — assert `%` is not visible and lines are joined (will fail on unfixed code)
4. **Escaped percent test**: `latexToOmml('50\\% discount')` — assert `%` IS visible as literal text (should pass on unfixed code — confirms `\%` is unaffected)

**Expected Counterexamples**:
- `latexToOmml('x^2 % superscript')` produces OMML containing `<m:t>% superscript</m:t>` or similar visible text
- Root cause confirmed: `%` falls through to the "regular text" branch in `tokenize()`

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```text
FOR ALL input WHERE isBugCondition(input) DO
  result := latexToOmml_fixed(input)
  ASSERT no visible m:t element contains unescaped % or comment text
  ASSERT hidden comment elements are present in the OMML
  ASSERT preceding whitespace is stored in the hidden element
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```text
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT latexToOmml_original(input) = latexToOmml_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many LaTeX strings without `%` and verifies identical OMML output
- It catches edge cases in tokenizer changes that manual tests might miss
- It provides strong guarantees that the `%` branch doesn't interfere with other token types

**Test Plan**: Capture `latexToOmml()` output on UNFIXED code for various comment-free inputs, then write property-based tests verifying the fixed code produces identical output.

**Test Cases**:
1. **Escaped percent preservation**: Verify `latexToOmml('50\\% discount')` produces identical output before and after fix
2. **Comment-free equation preservation**: Verify equations like `\frac{a}{b}`, `x^2`, `\sum_{i=0}^{n}` produce identical OMML
3. **Roundtrip preservation**: Verify comment-free equations roundtripped through `latexToOmml` → parse → `ommlToLatex` produce semantically equivalent LaTeX

### Unit Tests

- Test `tokenize()` produces `comment` tokens for `%` and `line_continuation` tokens for end-of-line `%`
- Test `tokenize()` does NOT produce comment tokens for `\%`
- Test `latexToOmml()` strips comment text from visible output
- Test `latexToOmml()` embeds hidden comment elements with correct whitespace
- Test `translateRun()` detects hidden comment markers and restores `%` comments
- Test roundtrip: `latexToOmml('x^2 % superscript')` → parse OMML → `ommlToLatex()` restores `x^2 % superscript`
- Test roundtrip with multi-line aligned comments preserves whitespace alignment
- Test line-continuation `%` roundtrip

### Property-Based Tests

- Generate random LaTeX strings WITHOUT `%` using fast-check with short bounded generators; verify `latexToOmml` output is identical before and after fix
- Generate random LaTeX strings WITH `%` comments; verify no comment text appears in visible `m:t` elements and hidden markers are present
- Generate random comment text and whitespace; verify roundtrip through embed → extract restores original content exactly

### Integration Tests

- Test full MD → DOCX export pipeline with equations containing `%` comments — verify comments are not visible in OMML
- Test full DOCX → MD import pipeline with OMML containing hidden comment elements — verify `%` comments are restored
- Test roundtrip MD → DOCX → MD with multi-line aligned comments — verify whitespace alignment preserved
