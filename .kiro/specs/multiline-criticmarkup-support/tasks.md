# Implementation Plan

- [x] 1. Fix TextMate grammar to support multi-line patterns
  - Modify `syntaxes/criticmarkup.json` to add `contentName` or `patterns` array for each CriticMarkup type
  - Test different approaches (contentName vs patterns array) to find what works in VS Code
  - Verify that syntax highlighting works for multi-line patterns in the editor
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 6.4_

- [x] 1.1 Write property test for multi-line pattern recognition
  - **Property 1: Multi-line pattern recognition**
  - **Validates: Requirements 1.1, 2.1, 3.1, 4.1, 5.1**

- [x] 2. Fix preview plugin to handle empty lines within patterns
  - Investigate why markdown-it splits patterns at empty lines
  - Add block-level rule to `src/preview/criticmarkup-plugin.ts` that runs before paragraph parsing
  - Ensure CriticMarkup patterns are identified before markdown-it processes empty lines as paragraph breaks
  - Test with patterns containing empty lines
  - _Requirements: 1.4, 2.4, 3.4, 4.4, 5.4, 6.1, 6.2_

- [x] 2.1 Write property test for empty line preservation in preview
  - **Property 4: Empty line preservation**
  - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

- [x] 2.2 Write property test for multi-line preview rendering
  - **Property 3: Multi-line preview rendering**
  - **Validates: Requirements 1.4, 2.4, 3.4, 4.4, 5.4, 6.2**

- [x] 3. Verify navigation module handles multi-line patterns
  - Review `src/changes.ts` to confirm `[\s\S]+?` regex patterns work correctly
  - Test navigation with multi-line patterns including empty lines
  - Fix any issues with range calculation for multi-line patterns
  - _Requirements: 1.3, 2.3, 3.3, 4.3, 5.3, 6.3_

- [x] 3.1 Write property test for multi-line navigation
  - **Property 2: Multi-line navigation correctness**
  - **Validates: Requirements 1.3, 2.3, 3.3, 4.3, 5.3**

- [x] 4. Write unit tests for specific edge cases
  - Test empty patterns (e.g., `{++\n\n++}`)
  - Test patterns with only whitespace
  - Test substitutions with multi-line old and new text
  - Test patterns with empty lines at various positions (start, middle, end)
  - Test very long patterns (100+ lines)
  - _Requirements: All_

- [x] 5. Manual testing and verification
  - Create test document with various multi-line patterns
  - Verify syntax highlighting appears correctly in editor
  - Test navigation commands work smoothly
  - Verify preview renders correctly
  - Test with patterns containing empty lines
  - _Requirements: All_

- [x] 6. Update documentation
  - Update README.md to mention multi-line support
  - Add examples of multi-line patterns
  - Document any limitations or known issues
  - _Requirements: All_

- [ ] 7. Fix mid-line multi-line pattern support
  - Modify `criticmarkupBlock` function in `src/preview/criticmarkup-plugin.ts` to detect patterns starting mid-line
  - Current implementation only checks if line starts with pattern markers
  - Need to scan entire line content, not just the beginning
  - Ensure block-level rule captures patterns regardless of position on line
  - Test with patterns that start after other text on the same line
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4_

- [ ] 7.1 Write property test for mid-line multi-line patterns
  - **Property 5: Mid-line multi-line pattern recognition**
  - Generate random text before and after multi-line patterns
  - Verify patterns are recognized regardless of position on line
  - Test with navigation, preview, and syntax highlighting
  - **Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.3, 2.4, 3.1, 3.3, 3.4, 4.1, 4.3, 4.4, 5.1, 5.3, 5.4**

- [ ] 7.2 Add unit tests for specific mid-line cases
  - Test pattern starting mid-line with text before
  - Test pattern starting mid-line with text before and after
  - Test multiple patterns on same line
  - Test mid-line pattern followed by another pattern on next line
  - _Requirements: All_
