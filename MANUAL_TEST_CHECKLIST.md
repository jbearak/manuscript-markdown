# Manual Testing Checklist for Multi-line CriticMarkup Support

## Prerequisites
- [ ] Extension compiled successfully (`bun run compile`)
- [ ] Extension loaded in VS Code (F5 to launch Extension Development Host)
- [ ] Test document `test-multiline-manual.md` opened in the Extension Development Host

## Test 1: Syntax Highlighting - Basic Multi-line Patterns

Open `test-multiline-manual.md` and verify:

- [ ] **Test 1 (Addition)**: All 3 lines of the addition are highlighted with insertion styling
- [ ] **Test 2 (Deletion)**: All 3 lines of the deletion are highlighted with deletion styling
- [ ] **Test 3 (Substitution)**: Both old and new text across multiple lines are highlighted appropriately
- [ ] **Test 4 (Comment)**: All 3 lines of the comment are highlighted with comment styling
- [ ] **Test 5 (Highlight)**: All 3 lines are highlighted with highlight styling

**Expected**: Each pattern type should have consistent highlighting across all lines from opening to closing marker.

## Test 2: Syntax Highlighting - Patterns with Empty Lines

Verify in Test 6 section:

- [ ] **Addition with empty line**: Highlighting continues across the empty line
- [ ] **Deletion with empty line**: Highlighting continues across the empty line
- [ ] **Substitution with empty lines**: Both old and new sections maintain highlighting across empty lines
- [ ] **Comment with empty line**: Highlighting continues across the empty line
- [ ] **Highlight with empty line**: Highlighting continues across the empty line

**Expected**: Empty lines within patterns should maintain the same highlighting as surrounding lines.

## Test 3: Syntax Highlighting - Edge Cases

- [ ] **Test 7 (Empty patterns)**: Empty patterns are recognized and highlighted
- [ ] **Test 8 (Whitespace-only)**: Patterns with only whitespace are highlighted
- [ ] **Test 9 (Very long pattern)**: All 12 lines maintain consistent highlighting
- [ ] **Test 11 (Multiple empty lines)**: Highlighting continues across multiple consecutive empty lines

**Expected**: Edge cases should be handled gracefully with proper highlighting.

## Test 4: Navigation Commands - Next Change

Starting from the top of the document:

1. [ ] Place cursor at line 1 (before any patterns)
2. [ ] Execute command: `CriticMarkup: Next Change` (default: Cmd+Shift+. on Mac, Ctrl+Shift+. on Windows/Linux)
3. [ ] Verify: Cursor moves to Test 1 addition and entire pattern is selected
4. [ ] Execute `Next Change` again
5. [ ] Verify: Cursor moves to Test 2 deletion and entire pattern is selected
6. [ ] Continue through all patterns in document
7. [ ] Verify: Each multi-line pattern is fully selected (from opening to closing marker)
8. [ ] At the last pattern, execute `Next Change`
9. [ ] Verify: Navigation wraps to first pattern

**Expected**: Navigation should smoothly move through all patterns, selecting complete multi-line ranges.

## Test 5: Navigation Commands - Previous Change

Starting from the bottom of the document:

1. [ ] Place cursor at the end of the document
2. [ ] Execute command: `CriticMarkup: Previous Change` (default: Cmd+Shift+, on Mac, Ctrl+Shift+, on Windows/Linux)
3. [ ] Verify: Cursor moves to Test 15 addition and entire pattern is selected
4. [ ] Execute `Previous Change` again
5. [ ] Verify: Cursor moves backward through patterns
6. [ ] Continue backward through all patterns
7. [ ] Verify: Each multi-line pattern is fully selected
8. [ ] At the first pattern, execute `Previous Change`
9. [ ] Verify: Navigation wraps to last pattern

**Expected**: Backward navigation should work symmetrically to forward navigation.

## Test 6: Navigation - Patterns with Empty Lines

Focus on Test 6 section:

1. [ ] Navigate to addition with empty line
2. [ ] Verify: Selection includes both paragraphs and the empty line between them
3. [ ] Navigate to deletion with empty line
4. [ ] Verify: Selection includes both paragraphs and the empty line
5. [ ] Navigate to substitution with empty lines
6. [ ] Verify: Selection includes entire pattern (old text, separator, new text, and all empty lines)
7. [ ] Navigate to comment with empty line
8. [ ] Verify: Selection includes both paragraphs and the empty line
9. [ ] Navigate to highlight with empty line
10. [ ] Verify: Selection includes both paragraphs and the empty line

**Expected**: Navigation should treat patterns with empty lines as single complete units.

## Test 7: Preview Rendering - Basic Patterns

Open Markdown preview (Cmd+Shift+V or Ctrl+Shift+V):

- [ ] **Test 1 (Addition)**: Rendered with `<ins>` tag, all 3 lines visible
- [ ] **Test 2 (Deletion)**: Rendered with `<del>` tag, all 3 lines visible with strikethrough
- [ ] **Test 3 (Substitution)**: Old text shown with `<del>`, new text with `<ins>`, both multi-line
- [ ] **Test 4 (Comment)**: Rendered with comment styling, all 3 lines visible
- [ ] **Test 5 (Highlight)**: Rendered with `<mark>` tag, all 3 lines highlighted

**Expected**: Preview should render all lines of multi-line patterns with appropriate HTML tags and styling.

## Test 8: Preview Rendering - Patterns with Empty Lines

In preview, verify Test 6 section:

- [ ] **Addition with empty line**: Both paragraphs visible with empty line preserved between them
- [ ] **Deletion with empty line**: Both paragraphs visible with empty line preserved
- [ ] **Substitution with empty lines**: Both old and new text show paragraph breaks
- [ ] **Comment with empty line**: Both paragraphs visible with empty line preserved
- [ ] **Highlight with empty line**: Both paragraphs highlighted with empty line preserved

**Expected**: Empty lines within patterns should be preserved in the rendered HTML output.

## Test 9: Preview Rendering - Edge Cases

- [ ] **Test 7 (Empty patterns)**: Empty patterns render without errors
- [ ] **Test 8 (Whitespace-only)**: Whitespace is preserved in rendering
- [ ] **Test 9 (Very long pattern)**: All 12 lines render correctly
- [ ] **Test 11 (Multiple empty lines)**: Multiple consecutive empty lines are preserved
- [ ] **Test 12 (Complex substitution)**: Lists and formatting within patterns are preserved

**Expected**: Edge cases should render without errors, preserving content structure.

## Test 10: Preview Rendering - Adjacent Patterns

Verify Test 13 section:

- [ ] Adjacent single-line patterns render correctly side-by-side
- [ ] Adjacent multi-line patterns render correctly with proper separation
- [ ] No unexpected spacing or layout issues

**Expected**: Multiple patterns in close proximity should render cleanly.

## Test 11: Performance Testing

1. [ ] Open `test-multiline-manual.md` (contains ~15 multi-line patterns)
2. [ ] Observe: Syntax highlighting appears immediately (< 100ms perceived)
3. [ ] Execute navigation commands rapidly
4. [ ] Observe: Navigation responds immediately (< 50ms perceived)
5. [ ] Open preview
6. [ ] Observe: Preview renders quickly (< 200ms perceived)

**Expected**: Extension should feel responsive with no noticeable lag.

## Test 12: Integration Testing

Test complete workflow:

1. [ ] Create a new markdown file
2. [ ] Type a multi-line addition pattern manually
3. [ ] Verify: Syntax highlighting appears as you type
4. [ ] Use snippet to insert a multi-line pattern (type `cm-add` and press Tab)
5. [ ] Add content across multiple lines
6. [ ] Verify: Highlighting updates correctly
7. [ ] Navigate to the pattern using commands
8. [ ] Verify: Pattern is selected correctly
9. [ ] Open preview
10. [ ] Verify: Pattern renders correctly

**Expected**: Complete user workflow should work smoothly from creation to preview.

## Test 13: Regression Testing

Verify single-line patterns still work:

- [ ] **Test 10**: Single-line patterns are highlighted correctly
- [ ] **Test 10**: Navigation works for single-line patterns
- [ ] **Test 10**: Preview renders single-line patterns correctly
- [ ] Mixed single and multi-line patterns work together without interference

**Expected**: Existing single-line functionality should remain unchanged.

## Summary

After completing all tests, verify:

- [ ] All multi-line patterns are recognized and highlighted correctly
- [ ] Navigation commands work smoothly for all pattern types
- [ ] Preview renders all patterns correctly with proper HTML structure
- [ ] Empty lines within patterns are handled correctly
- [ ] Edge cases (empty patterns, whitespace, very long patterns) work
- [ ] Performance is acceptable
- [ ] No regressions in single-line pattern support

## Issues Found

Document any issues discovered during testing:

1. 
2. 
3. 

## Notes

Add any additional observations or comments:

