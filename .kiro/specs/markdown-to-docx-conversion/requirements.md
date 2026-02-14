# Requirements Document

## Introduction

Convert Markdown documents to DOCX (OOXML) format, generating valid `.docx` archives that open correctly in Microsoft Word, LibreOffice, and Google Docs. This is the inverse of the existing DOCX-to-Markdown converter in `converter.ts`. The converter must handle character-level formatting (bold, italic, underline, strikethrough, highlight, superscript, subscript), hyperlinks, headings (levels 1–6), and lists (bulleted and numbered).

## Glossary

- **OOXML**: Office Open XML, the ISO/ECMA standard format used by `.docx` files.
- **Run**: A `w:r` element representing a contiguous span of text sharing the same formatting properties.
- **Run Properties**: The `w:rPr` child of a Run that declares character-level formatting.
- **Paragraph Properties**: The `w:pPr` child of a `w:p` element that declares paragraph-level formatting (heading style, numbering).
- **ST_OnOff**: The OOXML simple type for boolean toggle values. Six valid values: `"true"`, `"false"`, `"on"`, `"off"`, `"1"`, `"0"`. Convention for generation is to use bare elements (no `w:val` attribute) for true, and omit the element for false.
- **Content Types**: The `[Content_Types].xml` file at the archive root that declares MIME types for each part in the package.
- **Relationship Map**: The `word/_rels/document.xml.rels` file that maps relationship IDs (`r:id`) to target URIs.

## Requirements

### Requirement 1: DOCX Archive Structure

**User Story:** As a user exporting Markdown to DOCX, I want the output to be a valid `.docx` zip archive that opens in Word without errors.

#### Acceptance Criteria

1. THE Converter SHALL produce a zip archive containing at minimum: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, and `word/styles.xml`.
2. THE `[Content_Types].xml` SHALL declare the correct content types for all parts in the archive.
3. THE `_rels/.rels` SHALL reference `word/document.xml` as the main document part.
4. WHEN the document contains lists, THE Converter SHALL include `word/numbering.xml` in the archive with proper content type declaration.
5. WHEN the document contains hyperlinks, THE Converter SHALL include `word/_rels/document.xml.rels` with relationship entries for each unique URL.

### Requirement 2: Bold Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `**bold**` text to produce bold runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `**text**`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains a bare `<w:b/>` element (no `w:val` attribute).
2. WHEN text is not bold, THE Converter SHALL omit the `w:b` element from `w:rPr`.

### Requirement 3: Italic Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `*italic*` text to produce italic runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `*text*`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains a bare `<w:i/>` element.
2. WHEN text is not italic, THE Converter SHALL omit the `w:i` element from `w:rPr`.

### Requirement 4: Underline Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `<u>underlined</u>` text to produce underlined runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `<u>text</u>`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains `<w:u w:val="single"/>`. The explicit `w:val="single"` is preferred over a bare element for interoperability.
2. WHEN text is not underlined, THE Converter SHALL omit the `w:u` element from `w:rPr`.

### Requirement 5: Strikethrough Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `~~strikethrough~~` text to produce strikethrough runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `~~text~~`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains a bare `<w:strike/>` element. (`w:strike` is used, not `w:dstrike`, since Markdown has no double-strikethrough distinction.)
2. WHEN text is not strikethrough, THE Converter SHALL omit the `w:strike` element from `w:rPr`.

### Requirement 6: Highlight Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `==highlighted==` text to produce highlighted runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `==text==`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains `<w:highlight w:val="yellow"/>`. (`w:highlight` is used rather than `w:shd` for semantic highlighting; `"yellow"` is the default color.)
2. WHEN text is not highlighted, THE Converter SHALL omit the `w:highlight` element from `w:rPr`.

### Requirement 7: Superscript Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `<sup>text</sup>` to produce superscript runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `<sup>text</sup>`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains `<w:vertAlign w:val="superscript"/>`. (Note: `w:vertAlign` is NOT a toggle — it takes an ST_VerticalAlignRun enum value.)
2. WHEN text is not superscript, THE Converter SHALL omit the `w:vertAlign` element from `w:rPr` (or set `w:val="baseline"`).

### Requirement 8: Subscript Formatting

**User Story:** As a user exporting Markdown to DOCX, I want `<sub>text</sub>` to produce subscript runs in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `<sub>text</sub>`, THE Converter SHALL emit a `w:r` element whose `w:rPr` contains `<w:vertAlign w:val="subscript"/>`.
2. WHEN text is not subscript, THE Converter SHALL omit the `w:vertAlign` element from `w:rPr`.

### Requirement 9: Combined Formatting

**User Story:** As a user exporting Markdown to DOCX, I want text with multiple Markdown formatting styles to produce DOCX runs with all corresponding run properties set.

#### Acceptance Criteria

1. WHEN a text span has multiple active Markdown formats (e.g., `***bold italic***`), THE Converter SHALL emit a single `w:rPr` containing all applicable formatting elements.
2. THE Converter SHALL produce well-formed XML where all run property elements appear in the correct order within `w:rPr`.

### Requirement 10: Hyperlinks

**User Story:** As a user exporting Markdown to DOCX, I want `[text](url)` links to produce OOXML hyperlinks in the DOCX output.

#### Acceptance Criteria

1. WHEN the Markdown contains `[text](url)`, THE Converter SHALL emit a `w:hyperlink` element with an `r:id` attribute referencing a relationship entry in `word/_rels/document.xml.rels`.
2. THE relationship entry SHALL have `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"`, `TargetMode="External"`, and `Target` set to the URL.
3. Each unique URL SHALL produce exactly one relationship entry; multiple links to the same URL SHALL share the same `r:id`.
4. THE `r:id` values SHALL be unique across all relationships in the document.
5. WHEN a hyperlink contains formatted text (e.g., `[**bold link**](url)`), THE Converter SHALL apply run properties to the runs inside the `w:hyperlink` element.

### Requirement 11: Headings

**User Story:** As a user exporting Markdown to DOCX, I want `# Heading` through `###### Heading` to produce DOCX heading paragraphs.

#### Acceptance Criteria

1. WHEN the Markdown contains a heading (level 1–6), THE Converter SHALL emit a `w:p` element whose `w:pPr` contains `<w:pStyle w:val="HeadingN"/>` where N is the heading level. (PascalCase `Heading1`–`Heading6` is the conventional English built-in style ID.)
2. THE `word/styles.xml` SHALL define style entries for `Heading1` through `Heading6` so that Word recognizes them as built-in heading styles.
3. WHEN a heading contains formatted runs, THE Converter SHALL apply character-level formatting within the heading paragraph.

### Requirement 12: Unordered (Bulleted) Lists

**User Story:** As a user exporting Markdown to DOCX, I want `- item` lists to produce DOCX bulleted lists.

#### Acceptance Criteria

1. WHEN the Markdown contains an unordered list item, THE Converter SHALL emit a `w:p` element whose `w:pPr` contains a `w:numPr` referencing a bullet numbering definition.
2. THE bullet numbering definition in `word/numbering.xml` SHALL use a `w:abstractNum` with `<w:numFmt w:val="bullet"/>` and a corresponding `w:num` entry. (The two-level indirection — `w:abstractNum` → `w:num` — is required by OOXML.)
3. WHEN a list item is nested (indentation level > 0), THE Converter SHALL set the `w:ilvl` value in `w:numPr` to the appropriate level.

### Requirement 13: Ordered (Numbered) Lists

**User Story:** As a user exporting Markdown to DOCX, I want `1. item` lists to produce DOCX numbered lists.

#### Acceptance Criteria

1. WHEN the Markdown contains an ordered list item, THE Converter SHALL emit a `w:p` element whose `w:pPr` contains a `w:numPr` referencing an ordered numbering definition.
2. THE ordered numbering definition in `word/numbering.xml` SHALL use a `w:abstractNum` with `<w:numFmt w:val="decimal"/>` and a corresponding `w:num` entry.
3. WHEN a list item is nested (indentation level > 0), THE Converter SHALL set the `w:ilvl` value in `w:numPr` to the appropriate level.

### Requirement 14: Round-Trip Fidelity

**User Story:** As a user, I want Markdown→DOCX→Markdown conversion to preserve my formatting, so that I don't lose information when round-tripping.

#### Acceptance Criteria

1. WHEN a Markdown document containing supported formatting is converted to DOCX and back to Markdown using the existing DOCX-to-Markdown converter, THE output Markdown SHALL be semantically equivalent to the input for all supported formatting types.
2. THE round-trip test SHALL cover: bold, italic, underline, strikethrough, highlight, superscript, subscript, hyperlinks, headings (levels 1–6), bullet lists, and numbered lists.

## ECMA-376 References

- ST_OnOff: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_ST_OnOff_topic_ID0EK6C3.html
- ST_Underline: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_ST_Underline_topic_ID0EC323.html
- ST_HighlightColor: https://schemas.liquid-technologies.com/officeopenxml/2006/st_highlightcolor.html
- ST_VerticalAlignRun: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_vertAlign_topic_ID0EWE4O.html
- ST_NumberFormat: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_ST_NumberFormat_topic_ID0EDNB3.html
- w:hyperlink: https://ooxml.info/docs/17/17.16/17.16.22/
- w:strike/w:dstrike: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_strike_topic_ID0EWR1O.html
- w:pStyle: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_pStyle_topic_ID0E6OIM.html
