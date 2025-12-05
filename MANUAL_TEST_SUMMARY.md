# Manual Testing Summary

## Status: Ready for Manual Testing

All automated tests have passed successfully (204 tests). The extension is ready for manual verification.

## What Has Been Prepared

### 1. Test Document: `test-multiline-manual.md`
A comprehensive test document containing:
- 15 test sections covering all CriticMarkup pattern types
- Multi-line patterns with various line counts
- Patterns with empty lines (critical test case)
- Edge cases: empty patterns, whitespace-only, very long patterns
- Mixed single and multi-line patterns
- Adjacent patterns
- Patterns at document boundaries

### 2. Testing Checklist: `MANUAL_TEST_CHECKLIST.md`
A detailed checklist organized into 13 test categories:
- Syntax highlighting tests (basic, with empty lines, edge cases)
- Navigation command tests (forward, backward, with empty lines)
- Preview rendering tests (basic, with empty lines, edge cases)
- Performance testing
- Integration testing
- Regression testing

### 3. Testing Guide: `MANUAL_TEST_GUIDE.md`
Step-by-step instructions for:
- Launching the Extension Development Host
- Opening and using the test document
- Testing each component (highlighting, navigation, preview)
- Debugging tips if issues arise
- Performance considerations

## How to Perform Manual Testing

### Quick Start (5 minutes)

1. **Launch Extension Development Host**
   ```bash
   # Press F5 in VS Code
   # Or: Run > Start Debugging
   ```

2. **Open test document**
   - In the Extension Development Host, open `test-multiline-manual.md`

3. **Quick visual check**
   - Scroll through the document
   - Verify multi-line patterns are highlighted correctly
   - Look for any obvious highlighting breaks at line boundaries

4. **Test navigation**
   - Press `Cmd+Shift+.` (Mac) or `Ctrl+Shift+.` (Windows/Linux) repeatedly
   - Verify cursor moves through all patterns
   - Check that multi-line patterns are fully selected

5. **Test preview**
   - Press `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Windows/Linux)
   - Verify all patterns render correctly
   - Check that empty lines within patterns are preserved

### Comprehensive Testing (30-45 minutes)

Follow the detailed checklist in `MANUAL_TEST_CHECKLIST.md` to systematically test:
- All pattern types (addition, deletion, substitution, comment, highlight)
- All components (syntax highlighting, navigation, preview)
- All edge cases (empty lines, empty patterns, very long patterns)
- Performance and integration

## Critical Test Cases

These are the most important scenarios to verify:

### 1. Patterns with Empty Lines (Test 6)
**Why critical**: This was the main issue that needed fixing. The preview plugin previously failed when patterns contained empty lines.

**What to check**:
- Syntax highlighting continues across empty lines
- Navigation selects the entire pattern including empty lines
- Preview renders the pattern as a single HTML element with empty lines preserved

### 2. Multi-line Navigation (Tests 1-5, 10)
**Why critical**: Ensures the navigation commands work correctly with multi-line patterns.

**What to check**:
- Entire pattern is selected (from opening to closing marker)
- Selection spans all lines
- Navigation doesn't skip any patterns

### 3. Preview Rendering (All tests in preview)
**Why critical**: Verifies the markdown-it plugin correctly handles multi-line patterns.

**What to check**:
- Correct HTML tags (`<ins>`, `<del>`, `<mark>`, `<span>`)
- Correct CSS classes
- Content preservation including line breaks
- No splitting of patterns at empty lines

## Expected Results

### Syntax Highlighting
- ✅ Multi-line patterns highlighted from opening to closing marker
- ✅ Highlighting continues across line breaks
- ✅ Highlighting continues across empty lines
- ✅ All five pattern types work correctly

### Navigation
- ✅ Commands move cursor to next/previous pattern
- ✅ Entire multi-line pattern is selected
- ✅ Selection includes all lines and empty lines
- ✅ Navigation wraps from last to first pattern

### Preview
- ✅ Patterns render with correct HTML structure
- ✅ Content is preserved including line breaks
- ✅ Empty lines within patterns are preserved
- ✅ No splitting of patterns at empty lines

## Known Limitations

Based on the design document, these are expected limitations:

1. **Nested patterns**: Outer pattern takes precedence
2. **Unclosed patterns**: Will not be highlighted or rendered as CriticMarkup
3. **Malformed substitutions**: Missing `~>` separator will not render correctly

These are by design and should not be considered bugs.

## Reporting Issues

If you find any issues during manual testing:

1. **Document the issue** in the "Issues Found" section of `MANUAL_TEST_CHECKLIST.md`
2. **Include details**:
   - Which test case revealed the issue
   - What you expected to happen
   - What actually happened
   - Steps to reproduce
   - Any console errors (Help > Toggle Developer Tools)

3. **Categorize severity**:
   - **Critical**: Feature doesn't work at all
   - **Major**: Feature works but has significant issues
   - **Minor**: Small visual or behavioral issues
   - **Enhancement**: Ideas for improvement

## Next Steps

After completing manual testing:

1. **If all tests pass**:
   - Mark task 5 as complete
   - Consider moving to task 6 (documentation updates)
   - The multi-line CriticMarkup support feature is complete!

2. **If issues are found**:
   - Document them clearly
   - Determine if they require code fixes
   - Create follow-up tasks if needed
   - Discuss with the team

## Automated Test Coverage

For reference, these aspects are already covered by automated tests:
- ✅ Pattern recognition (Property 1)
- ✅ Navigation correctness (Property 2)
- ✅ Preview rendering (Property 3)
- ✅ Empty line preservation (Property 4)
- ✅ Edge cases (empty patterns, whitespace, very long patterns)
- ✅ All five CriticMarkup pattern types

Manual testing focuses on:
- Visual verification of syntax highlighting
- User experience with navigation commands
- Visual verification of preview rendering
- Performance and responsiveness
- Integration of all components

## Questions?

If you have questions during testing:
- Check `MANUAL_TEST_GUIDE.md` for detailed instructions
- Check `MANUAL_TEST_CHECKLIST.md` for specific test cases
- Review the design document at `.kiro/specs/multiline-criticmarkup-support/design.md`
- Check the Developer Tools console for errors
