# Implementation Plan: Highlight Colors

## Overview

Implement colored highlight support for the mdmarkup VS Code extension. The work proceeds bottom-up: shared color map → formatting function → preview rendering → editor decorations → toolbar/menu reorganization → TextMate grammar → navigation support → configuration setting.

## Tasks

- [x] 1. Create shared color map module
  - [x] 1.1 Create `src/highlight-colors.ts` with `HIGHLIGHT_COLORS` map, `CRITIC_HIGHLIGHT_BG`, `HIGHLIGHT_DECORATION_COLORS`, and `VALID_COLOR_IDS`
    - Define the 14 MS Word highlight color name-to-hex mappings
    - Export `HIGHLIGHT_DECORATION_COLORS` with `{ light, dark }` rgba strings for each color (theme-aware opacity)
    - Export `CRITIC_HIGHLIGHT_BG` constant (#D9D9D9) and `CRITIC_HIGHLIGHT_DECORATION` with light/dark variants
    - Export `VALID_COLOR_IDS` array
    - _Requirements: 5.1, 5.2, 5.4, 2.2_

  - [x]* 1.2 Write property test for colored highlight wrapping (Property 1)
    - **Property 1: Colored highlight wrapping preserves content and produces correct syntax**
    - **Validates: Requirements 1.4, 2.4**

- [x] 2. Implement formatting function
  - [x] 2.1 Add `wrapColoredHighlight(text, color)` to `src/formatting.ts`
    - Returns `{ newText: '==' + text + '=={' + color + '}', cursorOffset: undefined }`
    - _Requirements: 1.4, 2.4_

- [x] 3. Update preview rendering
  - [x] 3.1 Update `src/preview/mdmarkup-plugin.ts` to parse `==text=={color}` syntax
    - Extend `parseFormatHighlight` to detect optional `{color}` suffix after closing `==`
    - Apply CSS class `mdmarkup-format-highlight mdmarkup-highlight-{color}` for valid colors
    - For unrecognized colors, fall back to configured default color; if unresolved, fall back to `mdmarkup-format-highlight` (yellow/amber)
    - Import `VALID_COLOR_IDS` from `highlight-colors.ts`
    - _Requirements: 2.1, 3.1, 3.2, 3.4_

  - [x] 3.2 Update CriticMarkup highlight rendering to use Comment_Gray
    - Change the CSS class or styling for `{==text==}` to use Comment_Gray background
    - _Requirements: 3.3, 5.3_

  - [x] 3.3 Add color CSS classes to `media/mdmarkup.css`
    - Add `.mdmarkup-highlight-{color}` class for each of the 14 colors with light-theme rgba values
    - Add `@media (prefers-color-scheme: dark)` overrides with dark-theme rgba values for each color
    - Update `.mdmarkup-highlight` (CriticMarkup) to use Comment_Gray background with light/dark theme variants
    - Keep `.mdmarkup-format-highlight` as existing yellow/amber default (already theme-aware via CSS variables)
    - Bright colors get higher opacity on light, lower on dark; dark colors get the inverse
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 5.1_

  - [x]* 3.4 Write property tests for preview rendering (Properties 2-5)
    - **Property 2: Preview renders colored highlights with correct color class**
    - **Validates: Requirements 2.1, 3.1**
    - **Property 3: Preview renders default format highlights with existing yellow/amber styling**
    - **Validates: Requirements 3.2**
    - **Property 4: Preview renders CriticMarkup highlights with Comment_Gray**
    - **Validates: Requirements 3.3**
    - **Property 5: Preview falls back to configured default color for unrecognized colors (with yellow/amber as second-level fallback)**
    - **Validates: Requirements 3.4**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement editor decorations
  - [x] 5.1 Add highlight decoration logic to `src/extension.ts`
    - Create `TextEditorDecorationType` instances using `DecorationRenderOptions` with `light` and `dark` sub-properties for theme-aware backgrounds
    - Import `HIGHLIGHT_DECORATION_COLORS` and `CRITIC_HIGHLIGHT_DECORATION` from `highlight-colors.ts`
    - For each color: `{ light: { backgroundColor: colors.light }, dark: { backgroundColor: colors.dark } }`
    - For CriticMarkup: `{ light: { backgroundColor: CRITIC_HIGHLIGHT_DECORATION.light }, dark: { backgroundColor: CRITIC_HIGHLIGHT_DECORATION.dark } }`
    - Implement `updateHighlightDecorations(editor)` function that scans document text, groups matches by color, and applies decorations
    - Register `onDidChangeActiveTextEditor` and `onDidChangeTextDocument` listeners to trigger updates
    - For default highlights (`==text==`), read `mdmarkup.defaultHighlightColor` setting to determine color
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.3_

  - [x]* 5.2 Write property test for highlight range extraction (Property 6)
    - **Property 6: Highlight range extraction finds colored highlights and CriticMarkup highlights**
    - **Validates: Requirements 4.1, 4.2, 4.4**

- [x] 6. Update toolbar and menu structure
  - [x] 6.1 Add 14 color commands to `package.json` contributes.commands
    - One command per color: `mdmarkup.formatHighlight_{color}` with title matching the color name
    - _Requirements: 1.3, 1.4_

  - [x] 6.2 Add `markdown.highlightColor` submenu to `package.json` contributes.submenus
    - Label: "Highlight Color"
    - _Requirements: 1.2_

  - [x] 6.3 Reorganize `markdown.formatting` menu in `package.json`
    - Move `mdmarkup.formatHighlight` from `1_format` group to new `1a_highlight` group
    - Add `markdown.highlightColor` submenu to `1a_highlight` group
    - Add all 14 color commands to `markdown.highlightColor` submenu
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 6.4 Register color commands in `src/extension.ts`
    - Loop over `VALID_COLOR_IDS` and register `mdmarkup.formatHighlight_{color}` commands
    - Each command calls `applyFormatting` with `wrapColoredHighlight`
    - _Requirements: 1.4_

- [x] 7. Update TextMate grammar
  - [x] 7.1 Add colored highlight pattern to `syntaxes/mdmarkup.json`
    - Add `colored_format_highlight` pattern before `format_highlight` in the patterns array
    - Match `==text=={color}` with captures for content and color suffix
    - _Requirements: 6.1, 6.2_

- [x] 8. Update navigation support
  - [x] 8.1 Extend `combinedPattern` regex in `src/changes.ts`
    - Add `==text=={color}` as an alternative before existing patterns
    - Ensure colored highlights are matched as a single unit including the color suffix
    - _Requirements: 7.1, 7.2_

  - [x]* 8.2 Write property tests for navigation (Properties 7-8)
    - **Property 7: Navigation regex matches colored highlight patterns**
    - **Validates: Requirements 7.1**
    - **Property 8: Overlapping pattern filtering with colored highlights**
    - **Validates: Requirements 7.2**

- [x] 9. Add configurable default highlight color setting
  - [x] 9.1 Add `mdmarkup.defaultHighlightColor` to `package.json` contributes.configuration
    - Type: string enum with all 14 color identifiers
    - Default: "yellow"
    - _Requirements: 8.1, 8.4_

  - [x] 9.2 Wire the setting into preview plugin and editor decorations
    - Preview plugin reads the setting to determine CSS class for `==text==` without color suffix
    - Editor decoration logic reads the setting to determine which decoration type to apply for default highlights
    - _Requirements: 8.2, 8.3_

  - [x]* 9.3 Write property test for configurable default (Property 9)
    - **Property 9: Default highlight color respects configuration**
    - **Validates: Requirements 8.2, 8.3, 8.4**

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- Use bounded string generators (maxLength: 50) per AGENTS.md learnings to avoid timeouts
- The shared color map in `src/highlight-colors.ts` is the single source of truth for color mappings
