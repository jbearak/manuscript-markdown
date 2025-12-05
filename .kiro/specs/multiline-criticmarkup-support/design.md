# Design Document: Multi-line CriticMarkup Support

## Overview

This design enables CriticMarkup patterns to span multiple lines in the VS Code extension. The current implementation already has partial multi-line support in the preview plugin (using `indexOf` for end marker detection) and navigation code (using `[\s\S]+?` regex patterns), but the TextMate grammar may have limitations in how it handles multi-line patterns for syntax highlighting.

The solution involves:
1. Verifying and potentially updating the TextMate grammar to ensure proper multi-line matching
2. Ensuring the navigation commands correctly handle multi-line patterns
3. Confirming the preview plugin properly renders multi-line patterns
4. Adding comprehensive tests to validate multi-line behavior across all five CriticMarkup pattern types

## Architecture

The extension has three main components that need to support multi-line patterns:

1. **TextMate Grammar** (`syntaxes/criticmarkup.json`): Provides syntax highlighting through pattern injection into Markdown documents
2. **Navigation Module** (`src/changes.ts`): Finds and navigates between CriticMarkup patterns using regex
3. **Preview Plugin** (`src/preview/criticmarkup-plugin.ts`): Renders CriticMarkup in the Markdown preview using markdown-it

### Current State Analysis

**TextMate Grammar:**
- Uses `begin`/`end` patterns but **does not currently work for multi-line patterns**
- TextMate grammars in VS Code may have limitations with newline handling
- This is the primary component that needs fixing

**Navigation Module:**
- Uses `[\s\S]+?` in regex patterns, which explicitly matches any character including newlines
- Should already support multi-line patterns
- Needs testing to confirm behavior

**Preview Plugin:**
- Uses `indexOf` to find end markers, which works across newlines
- **Currently works for multi-line patterns BUT fails when there are empty lines within the pattern**
- The issue with empty lines needs to be investigated and fixed

## Components and Interfaces

### TextMate Grammar Updates

The grammar file currently uses this structure for each pattern:

```json
{
  "begin": "\\{\\+\\+",
  "end": "\\+\\+\\}",
  "name": "markup.inserted"
}
```

**Problem**: While TextMate grammars theoretically support multi-line matching, VS Code's implementation does not properly handle newlines within these patterns. The grammar needs to be modified to explicitly support multi-line content.

**Solution approaches to investigate**:

1. **Add contentName**: Use `contentName` to apply styling to the content between begin/end markers
2. **Use patterns array**: Add a `patterns` array within each rule to match content including newlines
3. **Explicit newline matching**: Add patterns that explicitly match newline characters
4. **Block-level patterns**: Consider if patterns need to be treated as block-level rather than inline

The most promising approach is to add a `patterns` array that includes a pattern matching any content:

```json
{
  "begin": "\\{\\+\\+",
  "end": "\\+\\+\\}",
  "name": "markup.inserted",
  "patterns": [
    {
      "match": "(?s:.)",
      "name": "markup.inserted"
    }
  ]
}
```

Or use `contentName` to apply the scope to all content:

```json
{
  "begin": "\\{\\+\\+",
  "end": "\\+\\+\\}",
  "name": "markup.inserted.criticmarkup",
  "contentName": "markup.inserted"
}
```

### Navigation Module Interface

The `changes.ts` module exports:

```typescript
// Get all CriticMarkup pattern matches in a document
export function getAllMatches(document: vscode.TextDocument): vscode.Range[]

// Navigate to next pattern
export function next(): void

// Navigate to previous pattern
export function prev(): void
```

The `combinedPattern` regex already uses `[\s\S]+?` which matches across newlines.

### Preview Plugin Interface

The plugin exports:

```typescript
export function criticmarkupPlugin(md: MarkdownIt): void
```

The inline parsing function uses `indexOf` to find end markers, which works across newlines for simple cases.

**Problem**: The preview plugin fails when patterns contain empty lines. This is likely because markdown-it treats empty lines as paragraph breaks, which interrupts inline parsing.

**Solution**: The plugin needs to handle block-level parsing or prevent markdown-it from breaking up patterns at empty lines. Possible approaches:

1. **Block-level rule**: Register a block-level rule that runs before paragraph parsing
2. **Escape empty lines**: Pre-process to protect empty lines within patterns
3. **Custom tokenization**: Use a more sophisticated tokenization strategy that preserves pattern boundaries

The most robust solution is to add a block-level rule that identifies CriticMarkup patterns before markdown-it's paragraph parser splits them up.

## Data Models

### Pattern Match Range

A CriticMarkup pattern match is represented as a `vscode.Range`:

```typescript
interface Range {
  start: Position  // Start position in document
  end: Position    // End position in document
}
```

For multi-line patterns, `start.line` will be less than `end.line`.

### Pattern Types

All five CriticMarkup patterns need multi-line support:

1. **Addition**: `{++text++}` - Marks inserted text
2. **Deletion**: `{--text--}` - Marks removed text
3. **Substitution**: `{~~old~>new~~}` - Marks replaced text
4. **Comment**: `{>>text<<}` - Adds editorial comments
5. **Highlight**: `{==text==}` - Highlights important text

## 
Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

After analyzing the acceptance criteria, we identified that syntax highlighting (requirements 1.2, 2.2, 3.2, 4.2, 5.2) and performance requirements (6.1, 6.2, 6.3) are not suitable for property-based testing. Syntax highlighting is a visual rendering concern controlled by VS Code's TextMate engine, and performance testing requires different methodologies than property-based testing.

The testable requirements fall into three categories: pattern recognition, navigation, and preview rendering. Rather than creating separate properties for each of the five CriticMarkup types, we consolidate them into comprehensive properties that test all types together.

### Property 1: Multi-line pattern recognition

*For any* CriticMarkup pattern type (addition, deletion, substitution, comment, or highlight) and any text content containing newlines, when that content is wrapped in the appropriate pattern markers, the getAllMatches function should return a range that encompasses the entire pattern from opening marker to closing marker.

**Validates: Requirements 1.1, 2.1, 3.1, 4.1, 5.1**

### Property 2: Multi-line navigation correctness

*For any* document containing one or more multi-line CriticMarkup patterns, when calling the next() or prev() navigation functions, the selected range should correspond to a complete CriticMarkup pattern (from opening to closing marker) and should include all lines spanned by that pattern.

**Validates: Requirements 1.3, 2.3, 3.3, 4.3, 5.3**

### Property 3: Multi-line preview rendering

*For any* CriticMarkup pattern type and any text content containing newlines (including empty lines), when that pattern is rendered through the markdown-it plugin, the output HTML should contain the appropriate HTML tag (ins, del, span, or mark) with the correct CSS class, and the content should be preserved including all newline characters and empty lines.

**Validates: Requirements 1.4, 2.4, 3.4, 4.4, 5.4, 6.2**

### Property 4: Empty line preservation

*For any* CriticMarkup pattern containing one or more empty lines, the pattern should be recognized as a single complete pattern (not split at empty lines), and all components (navigation, preview rendering) should treat it as a single unit preserving all empty lines.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4**

### Property 5: Mid-line multi-line pattern recognition

*For any* CriticMarkup pattern type and any text content containing newlines, when that pattern appears after other text on the same line (mid-line position), the pattern should be recognized correctly by all components (navigation, preview rendering). The position of the pattern on the line should not affect its recognition or processing.

**Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.3, 2.4, 3.1, 3.3, 3.4, 4.1, 4.3, 4.4, 5.1, 5.3, 5.4**

## Error Handling

### Invalid Pattern Structures

Multi-line patterns may encounter several error conditions:

1. **Unclosed patterns**: Pattern starts but never closes (e.g., `{++text without closing`)
   - TextMate grammar: Will not highlight beyond the line
   - Navigation: Will not match incomplete patterns
   - Preview: Will not render as CriticMarkup, will appear as plain text

2. **Nested patterns**: One pattern inside another (e.g., `{++outer {--inner--}++}`)
   - Current implementation filters contained ranges
   - Outer pattern takes precedence

3. **Malformed substitutions**: Missing separator (e.g., `{~~text without separator~~}`)
   - Preview plugin checks for `~>` separator
   - Will not render as substitution if separator is missing

### Edge Cases

1. **Empty lines within patterns**: Patterns containing blank lines (e.g., `{++text\n\nmore text++}`)
   - **Current issue**: Preview plugin fails because markdown-it treats empty lines as paragraph breaks
   - **Solution**: Block-level parsing or pre-processing to protect pattern boundaries

2. **Empty patterns**: Patterns with no content (e.g., `{++\n\n++}`)
   - Should be recognized as valid patterns
   - Preview plugin explicitly handles empty content

3. **Patterns with only whitespace**: (e.g., `{++   \n   ++}`)
   - Should be treated as valid patterns
   - Content should be preserved including whitespace

4. **Very long patterns**: Patterns spanning hundreds of lines
   - Regex with `[\s\S]+?` uses non-greedy matching to avoid catastrophic backtracking
   - Should handle efficiently

## Testing Strategy

We will use a dual testing approach combining unit tests for specific examples and property-based tests for universal properties.

### Property-Based Testing

We will use **fast-check** (already a dev dependency) for property-based testing. Each property test will run a minimum of 100 iterations to ensure thorough coverage of the input space.

**Test generators needed:**

1. **Multi-line text generator**: Generates strings containing newline characters
   - Should avoid CriticMarkup special characters (`{`, `}`, `~`, `>`, `<`, `=`, `+`, `-`)
   - Should generate varying numbers of lines (1-10)
   - Should include edge cases like empty lines, whitespace-only lines

2. **Pattern type generator**: Generates one of the five CriticMarkup pattern types
   - Returns pattern configuration (opening marker, closing marker, HTML tag, CSS class)

3. **Document generator**: Generates complete Markdown documents with multiple CriticMarkup patterns
   - Mixes single-line and multi-line patterns
   - Includes plain text between patterns
   - Varies pattern types

**Property test implementations:**

Each property-based test will be tagged with a comment explicitly referencing the correctness property:
- Format: `// Feature: multiline-criticmarkup-support, Property {number}: {property_text}`

1. **Property 1 test**: Generate random multi-line text and pattern types, wrap text in markers, call getAllMatches, verify returned range covers entire pattern
2. **Property 2 test**: Generate random documents with multi-line patterns, call navigation functions, verify selected ranges are complete patterns
3. **Property 3 test**: Generate random multi-line text and pattern types, render through markdown-it plugin, verify HTML output structure and content preservation

### Unit Testing

Unit tests will cover specific examples and edge cases:

1. **Specific multi-line examples**: Test each pattern type with known multi-line content
2. **Edge cases**: Empty patterns, whitespace-only patterns, patterns with special characters in content
3. **Substitution separator**: Test substitutions with multi-line old and new text
4. **Navigation wrapping**: Test that navigation wraps from last to first pattern
5. **Nested pattern filtering**: Test that contained ranges are properly filtered

### Integration Testing

Manual testing will verify:

1. **Syntax highlighting**: Visual confirmation that multi-line patterns are highlighted correctly in the editor
2. **Performance**: Subjective assessment of responsiveness with large documents
3. **User workflow**: End-to-end testing of creating and navigating multi-line patterns

## Implementation Notes

### TextMate Grammar Fix

The current grammar does NOT support multi-line matching in VS Code. We need to:

1. **Add `contentName` or `patterns`**: Explicitly define how content between markers should be styled
2. **Test different approaches**: VS Code's TextMate implementation may have quirks
3. **Verify with real examples**: Test with actual multi-line content in the editor
4. **Consider limitations**: If TextMate cannot handle this, we may need to use VS Code's decoration API as a fallback

### Preview Plugin Fix for Empty Lines

The preview plugin needs to handle empty lines within patterns:

1. **Add block-level rule**: Register a rule that runs before paragraph parsing
2. **Priority ordering**: Ensure CriticMarkup patterns are identified before markdown-it splits on empty lines
3. **Preserve content**: Ensure all content including empty lines is preserved in the output

### Mid-line Multi-line Pattern Bug

**Issue Discovered**: The current `criticmarkupBlock` function only detects patterns that start at the beginning of a line. It checks the first 3 characters of each line (`lineStart`) and returns false if they don't match a CriticMarkup opening marker.

**Impact**: Multi-line patterns that start mid-line (e.g., `Some text {++multi\nline++}`) are not recognized by:
- The block-level parser (fails to capture them)
- The inline parser (can't span line boundaries in markdown-it)
- Navigation commands (document isn't parsed correctly)
- Preview rendering (markdown-it splits them at line boundaries)

**Root Cause**: The block-level rule was designed to prevent markdown-it from splitting patterns at empty lines, but it only checks if a line **starts** with a pattern. This was an implementation oversight not caught by tests, which only generated patterns at the beginning of strings.

**Fix Approach**: Modify the `criticmarkupBlock` function to:
1. Scan the entire line content, not just the beginning
2. Detect CriticMarkup opening markers at any position on the line
3. When a multi-line pattern is found mid-line, handle the text before it as a separate paragraph
4. Process the CriticMarkup pattern as a block
5. Continue processing any text after the closing marker

**Alternative Approach**: Instead of modifying the block rule, we could:
1. Pre-process the source text to protect CriticMarkup patterns
2. Replace patterns with placeholders before markdown-it parsing
3. Restore patterns after parsing
4. This is more complex but might be more robust

The first approach (modifying the block rule) is preferred as it's more aligned with markdown-it's architecture and doesn't require text manipulation.

### Regex Pattern Considerations

The navigation module uses `[\s\S]+?` which is correct for multi-line matching:
- `\s` matches whitespace including newlines
- `\S` matches non-whitespace
- `[\s\S]` matches any character
- `+?` is non-greedy, matching as few characters as possible

This approach is more reliable than using the `s` (dotAll) flag, which may not be supported in all JavaScript environments.

### Preview Plugin Robustness

The preview plugin uses `indexOf` for end marker detection, which is simple and efficient:
- Works naturally across newlines
- No regex complexity
- Clear error handling when end marker not found

This approach is preferred over regex for the preview plugin because it's more predictable and easier to debug.

## Dependencies

- **fast-check**: Already installed as dev dependency for property-based testing
- **VS Code API**: For document manipulation and range handling
- **markdown-it**: For preview rendering
- **TypeScript**: For type safety and compilation

## Migration and Compatibility

This feature is backward compatible:
- Existing single-line patterns continue to work unchanged
- No breaking changes to API or user interface
- Users can adopt multi-line patterns gradually

## Future Enhancements

Potential future improvements:

1. **Folding support**: Allow collapsing multi-line patterns in the editor
2. **Diff view**: Show before/after for multi-line substitutions
3. **Pattern validation**: Real-time feedback for unclosed patterns
4. **Performance optimization**: Incremental parsing for very large documents
