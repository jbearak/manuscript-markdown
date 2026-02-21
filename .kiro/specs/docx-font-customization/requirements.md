# Requirements Document

## Introduction

Add YAML frontmatter support for customizing fonts and font sizes in DOCX output. Four new frontmatter fields (`font`, `code-font`, `font-size`, `code-font-size`) allow authors to override the default typography across all styles in the generated DOCX, including when a template `.docx` file is used. When `font-size` is specified without `code-font-size`, the system preserves the default size difference between body and code text.

## Glossary

- **Converter**: The Markdown-to-DOCX conversion module (`src/md-to-docx.ts`) that transforms Manuscript Markdown into OOXML.
- **Frontmatter**: The YAML metadata block delimited by `---` at the start of a Manuscript Markdown file, parsed by `parseFrontmatter()`.
- **Body_Font**: The font family used for normal prose text and headings (no explicit default is set — the rendering application's default font is used).
- **Code_Font**: The monospace font family used for inline code and code blocks (default: Consolas).
- **Body_Font_Size**: The font size in points for the Normal style (default: 11pt).
- **Code_Font_Size**: The font size in points for code styles — CodeBlock and CodeChar (default: 10pt).
- **Default_Size_Difference**: The difference between the default Body_Font_Size and Code_Font_Size, which is 1pt.
- **Template_DOCX**: An optional `.docx` file whose `word/styles.xml` is used as the base for styling in the output.
- **Style**: A named OOXML paragraph or character style (e.g., Normal, Heading1, CodeBlock, CodeChar, Title, FootnoteText, Quote).

## Requirements

### Requirement 1: Parse font frontmatter fields

**User Story:** As an author, I want to specify `font`, `code-font`, `font-size`, and `code-font-size` in YAML frontmatter, so that I can control the typography of my exported DOCX.

#### Acceptance Criteria

1. WHEN the Frontmatter contains a `font` field, THE Converter SHALL store the value as the Body_Font override.
2. WHEN the Frontmatter contains a `code-font` field, THE Converter SHALL store the value as the Code_Font override.
3. WHEN the Frontmatter contains a `font-size` field with a numeric value, THE Converter SHALL store the value as the Body_Font_Size override in points.
4. WHEN the Frontmatter contains a `code-font-size` field with a numeric value, THE Converter SHALL store the value as the Code_Font_Size override in points.
5. WHEN the Frontmatter contains a `font-size` field with a non-numeric value, THE Converter SHALL ignore the field and use the default Body_Font_Size.
6. WHEN the Frontmatter contains a `code-font-size` field with a non-numeric value, THE Converter SHALL ignore the field and use the default Code_Font_Size.

### Requirement 2: Infer code-font-size from font-size

**User Story:** As an author, I want code text to stay proportionally smaller than body text when I change the body font size, so that I do not have to manually calculate the code font size.

#### Acceptance Criteria

1. WHEN the Frontmatter specifies `font-size` without specifying `code-font-size`, THE Converter SHALL set Code_Font_Size to the specified Body_Font_Size minus the Default_Size_Difference (1pt).
2. WHEN the Frontmatter specifies both `font-size` and `code-font-size`, THE Converter SHALL use the explicitly specified Code_Font_Size and ignore the Default_Size_Difference.
3. WHEN the Frontmatter specifies `code-font-size` without specifying `font-size`, THE Converter SHALL use the specified Code_Font_Size with the default Body_Font_Size.

### Requirement 3: Apply font overrides to generated styles

**User Story:** As an author, I want my font choices to apply to all text styles in the DOCX output, so that the entire document uses a consistent typography.

#### Acceptance Criteria

1. WHEN a Body_Font override is specified, THE Converter SHALL set the `w:rFonts` `ascii` and `hAnsi` attributes to the Body_Font value in all non-code paragraph and character styles (Normal, Heading1–Heading6, Title, Quote, IntenseQuote, FootnoteText, EndnoteText).
2. WHEN a Code_Font override is specified, THE Converter SHALL set the `w:rFonts` `ascii` and `hAnsi` attributes to the Code_Font value in the CodeChar and CodeBlock styles.
3. WHEN a Body_Font_Size override is specified, THE Converter SHALL set the `w:sz` and `w:szCs` attributes in the Normal style to the override value converted to half-points.
4. WHEN a Body_Font_Size override is specified, THE Converter SHALL scale heading sizes proportionally relative to the new Body_Font_Size, preserving the ratio between each heading size and the default Body_Font_Size.
5. WHEN a Code_Font_Size override is specified (explicitly or inferred), THE Converter SHALL set the `w:sz` and `w:szCs` attributes in the CodeBlock style to the override value converted to half-points.
6. WHEN no font overrides are specified, THE Converter SHALL produce styles identical to the current defaults (no explicit body font, 11pt body size, Consolas 10pt code).

### Requirement 4: Override template DOCX fonts

**User Story:** As an author, I want frontmatter font settings to take precedence over template formatting, so that I can use a template for layout while controlling fonts separately.

#### Acceptance Criteria

1. WHEN a Template_DOCX is provided and font frontmatter fields are specified, THE Converter SHALL modify the template's `word/styles.xml` to apply the font and size overrides to all matching styles.
2. WHEN a Template_DOCX is provided and no font frontmatter fields are specified, THE Converter SHALL use the template's `word/styles.xml` without modification.
3. WHEN a Template_DOCX is provided and the Body_Font override is specified, THE Converter SHALL replace font references in all non-code styles within the template's `word/styles.xml`.
4. WHEN a Template_DOCX is provided and the Code_Font override is specified, THE Converter SHALL replace font references in code-related styles within the template's `word/styles.xml`.

### Requirement 5: Serialize font frontmatter fields

**User Story:** As an author, I want font settings to survive DOCX-to-Markdown round-trips, so that I do not lose my typography preferences.

#### Acceptance Criteria

1. THE Serializer SHALL include `font`, `code-font`, `font-size`, and `code-font-size` fields in the YAML frontmatter output when the corresponding values are present in the Frontmatter object.
2. THE Serializer SHALL omit `font`, `code-font`, `font-size`, and `code-font-size` fields from the YAML frontmatter output when the corresponding values are not present in the Frontmatter object.
3. FOR ALL valid Frontmatter objects containing font fields, parsing then serializing then parsing SHALL produce an equivalent Frontmatter object (round-trip property).

### Requirement 6: Update specification documentation

**User Story:** As a developer or contributor, I want the specification to document the new font frontmatter fields, so that the feature is discoverable and well-defined.

#### Acceptance Criteria

1. THE Specification SHALL list `font`, `code-font`, `font-size`, and `code-font-size` in the YAML Frontmatter field table with descriptions and default values.
2. THE Specification SHALL document the code-font-size inference behavior when only font-size is specified.
3. THE Specification SHALL include an example YAML frontmatter block demonstrating font customization.
