# Requirements Document

## Introduction

Enhance the existing docx-to-markdown converter in the mdmarkup VS Code extension to handle rich formatting from OOXML documents. The converter currently extracts plain text, comments, and Zotero citations. This feature adds support for character-level formatting (bold, italic, underline, strikethrough, highlight, superscript, subscript), hyperlinks, headings (levels 1–6), and lists (bulleted and numbered).

## Glossary

- **Converter**: The `converter.ts` module that transforms `.docx` files into Markdown and BibTeX output.
- **ContentItem**: A tagged-union type representing a unit of extracted document content (text run, citation, paragraph break, etc.).
- **Run**: A `w:r` element in OOXML representing a contiguous span of text sharing the same formatting properties.
- **Run_Properties**: The `w:rPr` child of a Run that declares character-level formatting (bold, italic, underline, strikethrough, highlight).
- **Paragraph_Properties**: The `w:pPr` child of a `w:p` element that declares paragraph-level formatting (heading style, numbering).
- **Numbering_Definitions**: The `word/numbering.xml` file inside a `.docx` archive that maps numbering IDs and levels to list formats (bullet vs. decimal).
- **Relationship_Map**: The `word/_rels/document.xml.rels` file that maps relationship IDs (`r:id`) to target URIs for hyperlinks and other references.
- **Highlight_Syntax**: The `==text==` Markdown syntax used to represent highlighted text, distinct from CriticMarkup `{==text==}` which denotes tracked-change additions.

## Requirements

### Requirement 1: Bold Formatting

**User Story:** As a user converting a docx file, I want bold text to be converted to Markdown bold syntax, so that emphasis is preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:b` element in its Run_Properties, THE Converter SHALL wrap the Run text in `**` delimiters in the Markdown output.
2. WHEN consecutive Runs share identical bold formatting, THE Converter SHALL merge them into a single `**…**` span.
3. WHEN a Run contains `w:b` with attribute `w:val="false"`, `w:val="0"`, or `w:val="off"`, THE Converter SHALL treat the Run as non-bold. (The OOXML `ST_OnOff` type defines six valid values: `"true"`, `"false"`, `"on"`, `"off"`, `"1"`, `"0"`. Values `"true"`, `"1"`, and `"on"` are truthy; `"false"`, `"0"`, and `"off"` are falsy.)

### Requirement 2: Italic Formatting

**User Story:** As a user converting a docx file, I want italic text to be converted to Markdown italic syntax, so that emphasis is preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:i` element in its Run_Properties, THE Converter SHALL wrap the Run text in `*` delimiters in the Markdown output.
2. WHEN consecutive Runs share identical italic formatting, THE Converter SHALL merge them into a single `*…*` span.
3. WHEN a Run contains `w:i` with attribute `w:val="false"`, `w:val="0"`, or `w:val="off"`, THE Converter SHALL treat the Run as non-italic. (Same `ST_OnOff` semantics as bold.)

### Requirement 3: Underline Formatting

**User Story:** As a user converting a docx file, I want underlined text to be converted to HTML underline tags, so that underline formatting is preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:u` element in its Run_Properties with a `w:val` attribute other than `"none"`, THE Converter SHALL wrap the Run text in `<u>` and `</u>` tags in the Markdown output. A bare `<w:u/>` with no `w:val` attribute defaults to `"single"` (underlined). All 18 OOXML `ST_Underline` values (`single`, `words`, `double`, `thick`, `dotted`, `dottedHeavy`, `dash`, `dashedHeavy`, `dashLong`, `dashLongHeavy`, `dotDash`, `dashDotHeavy`, `dotDotDash`, `dashDotDotHeavy`, `wave`, `wavyHeavy`, `wavyDouble`, `none`) other than `"none"` are treated as underlined. The `"words"` value (underline non-space characters only) is treated as regular underline for simplicity.
2. WHEN a Run contains `w:u` with attribute `w:val="none"`, THE Converter SHALL treat the Run as non-underlined.

### Requirement 4: Strikethrough Formatting

**User Story:** As a user converting a docx file, I want strikethrough text to be converted to Markdown strikethrough syntax, so that deleted text styling is preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:strike` or `w:dstrike` (double strikethrough) element in its Run_Properties, THE Converter SHALL wrap the Run text in `~~` delimiters in the Markdown output. (`w:strike` and `w:dstrike` are mutually exclusive per ECMA-376; both map to `~~` since Markdown has no double-strikethrough syntax.)
2. WHEN consecutive Runs share identical strikethrough formatting, THE Converter SHALL merge them into a single `~~…~~` span.
3. WHEN a Run contains `w:strike` or `w:dstrike` with attribute `w:val="false"`, `w:val="0"`, or `w:val="off"`, THE Converter SHALL treat the Run as non-strikethrough. (Same `ST_OnOff` semantics as bold.)

### Requirement 5: Highlight Formatting

**User Story:** As a user converting a docx file, I want highlighted text to be converted to `==text==` syntax, so that highlights are preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:highlight` element in its Run_Properties with a `w:val` attribute other than `"none"`, THE Converter SHALL wrap the Run text in `==` delimiters in the Markdown output.
2. WHEN a Run contains a `w:shd` element in its Run_Properties with a non-empty, non-`"auto"` `w:fill` attribute, THE Converter SHALL wrap the Run text in `==` delimiters in the Markdown output.
3. WHEN consecutive Runs share identical highlight formatting, THE Converter SHALL merge them into a single `==…==` span.

### Requirement 6: Superscript Formatting

**User Story:** As a user converting a docx file, I want superscript text to be converted to HTML superscript tags, so that superscript formatting is preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:vertAlign` element in its Run_Properties with attribute `w:val="superscript"`, THE Converter SHALL wrap the Run text in `<sup>` and `</sup>` tags in the Markdown output.
2. WHEN consecutive Runs share identical superscript formatting, THE Converter SHALL merge them into a single `<sup>…</sup>` span.

### Requirement 7: Subscript Formatting

**User Story:** As a user converting a docx file, I want subscript text to be converted to HTML subscript tags, so that subscript formatting is preserved in the output.

#### Acceptance Criteria

1. WHEN a Run contains a `w:vertAlign` element in its Run_Properties with attribute `w:val="subscript"`, THE Converter SHALL wrap the Run text in `<sub>` and `</sub>` tags in the Markdown output.
2. WHEN consecutive Runs share identical subscript formatting, THE Converter SHALL merge them into a single `<sub>…</sub>` span.

### Requirement 8: Combined Formatting

**User Story:** As a user converting a docx file, I want text with multiple formatting styles to be correctly nested in the Markdown output, so that all formatting is preserved.

#### Acceptance Criteria

1. WHEN a Run has multiple active formatting properties (e.g. bold and italic), THE Converter SHALL nest the Markdown delimiters in a consistent order: bold outermost, then italic, then strikethrough, then underline, then highlight, then superscript/subscript innermost.
2. THE Converter SHALL produce valid Markdown where all opened delimiters are properly closed within the same text span.

### Requirement 9: Hyperlinks

**User Story:** As a user converting a docx file, I want hyperlinks to be converted to Markdown link syntax, so that clickable references are preserved.

#### Acceptance Criteria

1. WHEN a `w:hyperlink` element with an `r:id` attribute is encountered, THE Converter SHALL resolve the relationship ID against the Relationship_Map to obtain the target URL.
2. WHEN a hyperlink target URL is resolved, THE Converter SHALL output the link text and URL in `[text](url)` Markdown syntax.
3. IF a hyperlink `r:id` cannot be resolved in the Relationship_Map, THEN THE Converter SHALL output the link text as plain text without link syntax.
4. WHEN a hyperlink contains Runs with character-level formatting, THE Converter SHALL apply the formatting delimiters inside the link text portion of the Markdown link.

### Requirement 10: Headings

**User Story:** As a user converting a docx file, I want headings to be converted to Markdown heading syntax, so that document structure is preserved.

#### Acceptance Criteria

1. WHEN a paragraph has a `w:pStyle` value matching `Heading1` through `Heading6` (case-insensitive) in its Paragraph_Properties, THE Converter SHALL prefix the paragraph text with the corresponding number of `#` characters followed by a space. (Note: style IDs are defined per-document in `word/styles.xml`. The case-insensitive match handles common English variants like `Heading1` and `heading1`. Non-English localized style IDs, e.g., German `"Überschrift1"`, are not supported — this is a known limitation.)
2. WHEN a heading paragraph contains formatted Runs, THE Converter SHALL apply character-level formatting within the heading text.
3. WHEN a paragraph has a `w:pStyle` value that does not match any heading pattern, THE Converter SHALL treat the paragraph as a normal paragraph.

### Requirement 11: Unordered (Bulleted) Lists

**User Story:** As a user converting a docx file, I want bulleted lists to be converted to Markdown unordered list syntax, so that list structure is preserved.

#### Acceptance Criteria

1. WHEN a paragraph has `w:numPr` in its Paragraph_Properties and the referenced numbering format in Numbering_Definitions is `bullet`, THE Converter SHALL prefix the paragraph text with `- ` (dash followed by space).
2. WHEN a bulleted list item has an indentation level (`w:ilvl`) greater than 0, THE Converter SHALL indent the list marker by two spaces per level.
3. WHEN consecutive paragraphs belong to the same bulleted list, THE Converter SHALL output them as consecutive Markdown list items without extra blank lines between them.

### Requirement 12: Ordered (Numbered) Lists

**User Story:** As a user converting a docx file, I want numbered lists to be converted to Markdown ordered list syntax, so that list structure and numbering are preserved.

#### Acceptance Criteria

1. WHEN a paragraph has `w:numPr` in its Paragraph_Properties and the referenced numbering format in Numbering_Definitions is `decimal` (or another numeric format), THE Converter SHALL prefix the paragraph text with `1. ` (using Markdown's lazy numbering convention).
2. WHEN a numbered list item has an indentation level (`w:ilvl`) greater than 0, THE Converter SHALL indent the list marker by three spaces per level.
3. WHEN consecutive paragraphs belong to the same numbered list, THE Converter SHALL output them as consecutive Markdown list items without extra blank lines between them.

### Requirement 13: End-to-End Fixture Testing

**User Story:** As a developer, I want end-to-end tests that convert `test/fixtures/formatting_sample.docx` and verify the output, so that formatting conversion is validated against a real docx file.

#### Acceptance Criteria

1. THE Converter SHALL produce correct Markdown output when converting `test/fixtures/formatting_sample.docx`, with all supported formatting (bold, italic, underline, strikethrough, highlight, superscript, subscript, hyperlinks, headings, and lists) accurately represented.
2. WHEN `formatting_sample.docx` contains text with combined formatting, THE Converter SHALL produce properly nested delimiters in the output.
3. WHEN `formatting_sample.docx` contains headings at various levels, THE Converter SHALL produce the corresponding `#`-prefixed lines in the output.
4. WHEN `formatting_sample.docx` contains bulleted and numbered lists, THE Converter SHALL produce correctly prefixed and indented Markdown list items in the output.

### Requirement 14: Highlight Formatting Command

**User Story:** As a user editing Markdown, I want a "Highlight" command in the Formatting menus (editor toolbar and right-click context menu), so that I can quickly wrap selected text in `==text==` syntax.

#### Acceptance Criteria

1. THE Extension SHALL register a `mdmarkup.formatHighlight` command that wraps the selected text in `==` delimiters (producing `==text==`).
2. THE Extension SHALL add the `formatHighlight` command to the `markdown.formatting` submenu in both the editor title bar and the editor context menu, placed after Underline in the `1_format` group.
3. WHEN no text is selected, THE Extension SHALL expand the selection to the word at the cursor position before applying highlight formatting, consistent with other formatting commands.

### Requirement 15: Highlight Syntax Highlighting

**User Story:** As a user editing Markdown, I want `==highlighted text==` to be visually distinguished in the editor, so that I can see highlighted regions at a glance.

#### Acceptance Criteria

1. THE Extension SHALL add a TextMate grammar pattern to `syntaxes/mdmarkup.json` that matches `==…==` (the formatting highlight syntax, distinct from CriticMarkup `{==…==}`).
2. THE TextMate grammar pattern SHALL assign a scope name that produces a visually distinct style (e.g. `markup.highlight.mdmarkup`).
3. THE TextMate grammar pattern SHALL NOT match CriticMarkup highlight syntax `{==…==}`, which is handled by the existing `highlight` pattern.

### Requirement 16: Highlight Preview Rendering

**User Story:** As a user previewing Markdown, I want `==highlighted text==` to render with a visible highlight style in the VS Code Markdown preview, so that highlights are visible in the rendered output.

#### Acceptance Criteria

1. THE markdown-it plugin SHALL detect `==…==` syntax (distinct from CriticMarkup `{==…==}`) and render the content with a highlight CSS class.
2. THE preview CSS SHALL define a style for the formatting highlight class that applies a visible background color, distinct from the CriticMarkup highlight style.
3. THE markdown-it plugin SHALL handle `==…==` syntax that appears both inline and at the start of a line.

### Requirement 17: Formatting-Aware Content Extraction

**User Story:** As a developer, I want the ContentItem type to carry formatting metadata, so that buildMarkdown can render formatting delimiters.

#### Acceptance Criteria

1. THE Converter SHALL extend the `text` ContentItem variant to include a formatting descriptor that records which character-level formats (bold, italic, underline, strikethrough, highlight, superscript, subscript) are active.
2. THE Converter SHALL extend the `text` ContentItem variant to include an optional hyperlink URL field.
3. THE Converter SHALL extend the `para` ContentItem variant to include an optional heading level (1–6).
4. THE Converter SHALL extend the `para` ContentItem variant to include optional list metadata (list type and indentation level).
5. WHEN extracting document content, THE Converter SHALL read Run_Properties from each Run and populate the formatting descriptor accordingly.
6. WHEN extracting document content, THE Converter SHALL parse Paragraph_Properties for heading styles and list numbering and populate the para metadata accordingly.
7. WHEN extracting document content, THE Converter SHALL parse the Relationship_Map from `word/_rels/document.xml.rels` to resolve hyperlink targets.
8. WHEN extracting document content, THE Converter SHALL parse Numbering_Definitions from `word/numbering.xml` to determine list types and levels.

### Known Limitations

The following OOXML features are intentionally not supported or are simplified:

1. **Localized heading style IDs**: Only English-language style IDs (`Heading1`–`Heading6`, case-insensitive) are recognized. Non-English localized IDs are treated as normal paragraphs.
2. **Bookmark hyperlinks (`w:anchor`)**: Only external hyperlinks via `r:id` are resolved. Internal document links using `w:anchor` are treated as plain text.
3. **Style hierarchy toggle behavior**: Toggle properties (`w:b`, `w:i`, `w:strike`) are interpreted as simple true/false in direct formatting. The ECMA-376 style-inheritance toggle semantics (where setting a toggle in a style *inverts* the inherited state) are not implemented.
4. **`w:numFmt="none"`**: Treated as ordered list rather than suppressing the list prefix. This value is rare in practice.
5. **`w:shd` pattern shading**: Only `w:fill` is checked for background shading detection. Patterns (`w:val` ≠ `"clear"`) with non-auto `w:color` are not detected as highlighted.
