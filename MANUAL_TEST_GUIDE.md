# Manual Testing Guide

## Quick Start

### 1. Launch Extension Development Host

```bash
# Ensure extension is compiled
bun run compile

# Then press F5 in VS Code to launch Extension Development Host
# Or use: Run > Start Debugging
```

### 2. Open Test Document

In the Extension Development Host window:
- Open `test-multiline-manual.md`
- This file contains all test cases for multi-line CriticMarkup patterns

### 3. Test Syntax Highlighting

Simply observe the document:
- Multi-line additions should be highlighted (green/inserted style)
- Multi-line deletions should be highlighted (red/strikethrough style)
- Multi-line substitutions should show both old (red) and new (green) text
- Multi-line comments should be highlighted (comment style)
- Multi-line highlights should be highlighted (yellow/mark style)

**Key things to check:**
- Highlighting continues across line breaks
- Highlighting continues across empty lines within patterns
- All lines from opening marker to closing marker are styled

### 4. Test Navigation Commands

**Next Change Command:**
- Default keybinding: `Cmd+Shift+.` (Mac) or `Ctrl+Shift+.` (Windows/Linux)
- Or: Open Command Palette (Cmd+Shift+P / Ctrl+Shift+P) and type "CriticMarkup: Next Change"

**Previous Change Command:**
- Default keybinding: `Cmd+Shift+,` (Mac) or `Ctrl+Shift+,` (Windows/Linux)
- Or: Open Command Palette and type "CriticMarkup: Previous Change"

**What to verify:**
- Cursor moves to the next/previous CriticMarkup pattern
- The entire pattern is selected (from opening to closing marker)
- Multi-line patterns are fully selected across all lines
- Navigation wraps from last to first (and vice versa)

### 5. Test Preview Rendering

**Open Preview:**
- Keybinding: `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Windows/Linux)
- Or: Click the preview icon in the top-right corner
- Or: Command Palette > "Markdown: Open Preview"

**What to verify:**
- Additions render with `<ins>` tags (underlined)
- Deletions render with `<del>` tags (strikethrough)
- Substitutions show both old (strikethrough) and new (underlined) text
- Comments render with appropriate styling
- Highlights render with `<mark>` tags (highlighted background)
- Empty lines within patterns are preserved
- Multi-line content maintains proper line breaks

### 6. Test Specific Scenarios

Use the test document sections:

- **Test 1-5**: Basic multi-line patterns (one of each type)
- **Test 6**: Patterns with empty lines (critical test case)
- **Test 7**: Empty patterns
- **Test 8**: Whitespace-only patterns
- **Test 9**: Very long pattern (12 lines)
- **Test 10**: Mixed single and multi-line patterns
- **Test 11**: Multiple consecutive empty lines
- **Test 12**: Complex substitution with lists
- **Test 13**: Adjacent patterns
- **Test 14-15**: Patterns at document boundaries

## Common Issues to Watch For

### Syntax Highlighting Issues
- ❌ Highlighting stops at first line break
- ❌ Highlighting breaks at empty lines
- ❌ Markers themselves are not styled correctly
- ✅ All lines from opening to closing marker should be highlighted

### Navigation Issues
- ❌ Only first line of pattern is selected
- ❌ Selection doesn't include empty lines within pattern
- ❌ Navigation skips multi-line patterns
- ✅ Entire pattern should be selected, including all lines and empty lines

### Preview Issues
- ❌ Pattern is split at empty lines (renders as separate elements)
- ❌ Content is missing or truncated
- ❌ HTML tags are incorrect or missing
- ✅ Entire pattern should render as single HTML element with all content preserved

## Debugging Tips

### If syntax highlighting doesn't work:
1. Check that the extension is activated (look for CriticMarkup commands in Command Palette)
2. Verify the file is recognized as Markdown (check language mode in bottom-right)
3. Try reloading the Extension Development Host window
4. Check Developer Tools console for errors (Help > Toggle Developer Tools)

### If navigation doesn't work:
1. Verify commands are registered (Command Palette should show them)
2. Check that cursor is in a Markdown file
3. Try clicking in the document first to ensure it has focus
4. Check console for JavaScript errors

### If preview doesn't work:
1. Verify markdown-it plugin is loaded (check console)
2. Try closing and reopening the preview
3. Check for errors in Developer Tools console
4. Compare with a simple single-line pattern to isolate the issue

## Performance Testing

While testing, pay attention to:
- **Syntax highlighting**: Should appear instantly as you scroll
- **Navigation**: Should respond immediately to commands (< 50ms)
- **Preview**: Should render quickly when opened (< 200ms)
- **Typing**: Should not lag when editing multi-line patterns

If you notice lag or delays, note the specific scenario and document size.

## Reporting Results

Use `MANUAL_TEST_CHECKLIST.md` to track your testing progress and document any issues found.

For each issue, note:
- What you were testing
- What you expected to happen
- What actually happened
- Steps to reproduce
- Any error messages in the console

## Next Steps After Testing

If all tests pass:
- Mark task 5 as complete in `tasks.md`
- Consider moving to task 6 (documentation updates)

If issues are found:
- Document them clearly
- Determine if they require code fixes
- Prioritize based on severity
- Create follow-up tasks if needed
