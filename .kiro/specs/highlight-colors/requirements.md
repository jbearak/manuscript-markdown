# Requirements Document

## Introduction

This feature extends the mdmarkup VS Code extension's highlight functionality to support colored highlights. It introduces a new syntax for specifying highlight colors (based on the standard MS Word highlight color palette), reorganizes the Formatting toolbar to expose color options via a submenu, renders colored highlights in the Markdown preview with appropriate background colors, and applies matching background-color decorations in the VS Code text editor itself.

## Glossary

- **Extension**: The mdmarkup VS Code extension that provides Markdown formatting and CriticMarkup annotation tools.
- **Formatting_Menu**: The "Markdown Formatting" submenu displayed in the editor title bar and context menu.
- **Highlight_Color_Submenu**: A new submenu nested inside the Formatting_Menu that lists individual highlight color commands.
- **Color_Suffix**: A color identifier appended after the closing `==` of a format highlight, using the syntax `==text=={color}`, where `color` is a lowercase kebab-case color name.
- **Default_Highlight**: A format highlight (`==text==`) that does not specify a Color_Suffix. The background color used for default highlights is configurable via the `mdmarkup.defaultHighlightColor` setting.
- **Colored_Highlight**: A format highlight that includes a Color_Suffix, e.g. `==text=={yellow}`.
- **Word_Highlight_Colors**: The set of 14 standard MS Word highlight colors: Yellow, Green, Turquoise, Pink, Blue, Red, Dark Blue, Teal, Violet, Dark Red, Dark Yellow, Gray-50%, Gray-25%, Black.
- **Preview**: The VS Code Markdown preview pane rendered by the markdown-it plugin.
- **Editor_Decoration**: A VS Code `TextEditorDecorationType` used to apply visual styling (background color) to text ranges in the code editor.
- **Comment_Gray**: The gray background color that MS Word uses for commented/annotated text (RGB approximately #D9D9D9 / light-theme equivalent). This applies to CriticMarkup highlights (`{==text==}`), which represent annotated/commented-on text.
- **Light_Theme**: A VS Code color theme with a light background (detected via `prefers-color-scheme: light` in CSS, or the `light` property of `DecorationRenderOptions` in the extension API).
- **Dark_Theme**: A VS Code color theme with a dark background (detected via `prefers-color-scheme: dark` in CSS, or the `dark` property of `DecorationRenderOptions` in the extension API).

## Requirements

### Requirement 1: Toolbar Reorganization

**User Story:** As a user, I want the Highlight button separated into its own group in the Formatting menu with a color submenu, so that I can quickly access both plain and colored highlighting.

#### Acceptance Criteria

1. THE Formatting_Menu SHALL display the existing "Highlight" command in a dedicated highlight group, separate from the inline-formatting group that contains Bold, Italic, Strikethrough, Underline, Inline Code, Code Block, and Link.
2. THE Formatting_Menu SHALL display a Highlight_Color_Submenu in the same highlight group as the Highlight command.
3. THE Highlight_Color_Submenu SHALL contain one command for each of the 14 Word_Highlight_Colors.
4. WHEN a user selects a color from the Highlight_Color_Submenu, THE Extension SHALL wrap the selected text using the Colored_Highlight syntax `==text=={color}`.

### Requirement 2: Colored Highlight Syntax

**User Story:** As a user, I want a clear syntax for specifying highlight colors in Markdown, so that I can apply different background colors to text.

#### Acceptance Criteria

1. THE Extension SHALL recognize the syntax `==text=={color}` as a Colored_Highlight, where `color` is a lowercase kebab-case identifier from the Word_Highlight_Colors set.
2. THE Extension SHALL recognize the following color identifiers: `yellow`, `green`, `turquoise`, `pink`, `blue`, `red`, `dark-blue`, `teal`, `violet`, `dark-red`, `dark-yellow`, `gray-50`, `gray-25`, `black`.
3. WHEN the Extension encounters `==text==` without a Color_Suffix, THE Extension SHALL treat the text as a Default_Highlight.
4. THE Extension SHALL preserve the original text content exactly when wrapping with Colored_Highlight syntax.

### Requirement 3: Preview Rendering of Colored Highlights

**User Story:** As a user, I want colored highlights to render with the correct background colors in the Markdown preview, so that I can visually distinguish different highlight colors.

#### Acceptance Criteria

1. WHEN the Preview encounters a Colored_Highlight `==text=={color}`, THE Preview SHALL render the text with the background color corresponding to the specified Word_Highlight_Color.
2. WHEN the Preview encounters a Default_Highlight `==text==`, THE Preview SHALL render the text with the existing yellow/amber background color unchanged.
3. WHEN the Preview encounters a CriticMarkup highlight `{==text==}`, THE Preview SHALL render the text with the Comment_Gray background color, matching the MS Word style for annotated/commented-on text.
4. WHEN the Preview encounters a Colored_Highlight with an unrecognized color identifier, THE Preview SHALL render the text using the configured `mdmarkup.defaultHighlightColor`; IF that configured color cannot be resolved, THEN THE Preview SHALL fall back to the existing yellow/amber default highlight background.
5. THE Preview CSS SHALL provide theme-aware color values for each highlight color, using `@media (prefers-color-scheme: dark)` to adjust background opacity or tint so that highlights remain legible on both Light_Theme and Dark_Theme backgrounds.
6. FOR bright highlight colors (Yellow, Green, Turquoise, Pink) on Dark_Theme, THE Preview CSS SHALL reduce opacity or darken the background to avoid washing out text. FOR dark highlight colors (Dark Blue, Teal, Violet, Dark Red, Dark Yellow, Black) on Light_Theme, THE Preview CSS SHALL increase opacity or lighten the background to ensure the highlight is visible.

### Requirement 4: Editor Decoration of Highlights

**User Story:** As a user, I want highlights to be visually styled in the VS Code text editor (not just the preview), so that I can see highlight colors while editing.

#### Acceptance Criteria

1. WHEN a Markdown file is opened or edited, THE Extension SHALL scan the document for Colored_Highlight patterns and apply Editor_Decorations with the corresponding background colors.
2. WHEN a Markdown file is opened or edited, THE Extension SHALL scan the document for CriticMarkup highlight patterns (`{==text==}`) and apply an Editor_Decoration with the Comment_Gray background color.
3. WHEN the document text changes, THE Extension SHALL update all Editor_Decorations to reflect the current highlight patterns.
4. IF a Colored_Highlight contains an unrecognized color identifier, THEN THE Extension SHALL apply the configured `mdmarkup.defaultHighlightColor`; IF that configured color cannot be resolved, THEN THE Extension SHALL apply the default yellow/amber highlight background as a fallback decoration.
5. EACH Editor_Decoration SHALL use the VS Code `DecorationRenderOptions` `light` and `dark` properties to provide theme-appropriate background colors, so that highlights are legible on both Light_Theme and Dark_Theme editor backgrounds.
6. FOR bright highlight colors on Dark_Theme, THE Extension SHALL use a lower-opacity or tinted background to avoid washing out text. FOR dark highlight colors on Light_Theme, THE Extension SHALL use a higher-opacity or lightened background to ensure visibility.

### Requirement 5: Color Mapping

**User Story:** As a user, I want the highlight colors to match the standard MS Word highlight palette, so that documents converted from DOCX maintain visual consistency.

#### Acceptance Criteria

1. THE Extension SHALL map each Word_Highlight_Color identifier to a specific RGB hex value consistent with the MS Word highlight palette.
2. THE Extension SHALL use the same color mapping for Preview rendering and Editor_Decoration styling.
3. THE Extension SHALL use Comment_Gray as the background for CriticMarkup highlights (`{==text==}`) in both Preview and Editor_Decoration styling.
4. THE color map module SHALL export both a light-theme and dark-theme background color variant for each highlight color, so that consumers (CSS, decorations) can apply the appropriate variant per theme.

### Requirement 6: Syntax Highlighting in Editor

**User Story:** As a user, I want the TextMate grammar to recognize colored highlight syntax, so that the editor provides appropriate tokenization.

#### Acceptance Criteria

1. THE Extension SHALL include a TextMate grammar pattern that tokenizes `==text=={color}` as a highlight with a color suffix.
2. WHEN the TextMate grammar tokenizes a Colored_Highlight, THE Extension SHALL assign a scope that distinguishes the color suffix from the highlighted content.

### Requirement 7: Navigation Support

**User Story:** As a user, I want the next/previous change navigation to recognize colored highlights, so that I can navigate between all markup patterns.

#### Acceptance Criteria

1. WHEN navigating with next/previous change commands, THE Extension SHALL include Colored_Highlight patterns (`==text=={color}`) in the set of navigable changes.
2. THE Extension SHALL filter overlapping patterns between Colored_Highlights and other CriticMarkup patterns to prevent duplicate navigation stops.

### Requirement 8: Configurable Default Highlight Color

**User Story:** As a user, I want to choose which MS Word highlight color is used when I apply a plain highlight (`==text==`), so that I can customize the default appearance to my preference.

#### Acceptance Criteria

1. THE Extension SHALL expose a `mdmarkup.defaultHighlightColor` configuration setting with a dropdown of all 14 Word_Highlight_Colors plus a "Yellow" default.
2. WHEN the Preview renders a Default_Highlight (`==text==`), THE Preview SHALL use the color specified by the `mdmarkup.defaultHighlightColor` setting.
3. WHEN the Editor_Decoration is applied to a Default_Highlight (`==text==`), THE Extension SHALL use the color specified by the `mdmarkup.defaultHighlightColor` setting.
4. IF the `mdmarkup.defaultHighlightColor` setting is not configured, THEN THE Extension SHALL use Yellow as the default highlight color.
