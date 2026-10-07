# Manuscript Markdown Specification

Manuscript Markdown extends standard Markdown with CriticMarkup annotations, citations, footnotes, and custom extensions for manuscript editing.

## YAML Frontmatter

Manuscript Markdown files may begin with a [YAML](https://yaml.org) frontmatter block delimited by `---`. The `title` field stores the document title:

```yaml
---
title: My Document Title
author: Jane Smith
csl: apa
locale: en-US
zotero-notes: in-text
timezone: -05:00
bibliography: shared/references
---
```

Multi-paragraph titles use multiple `title` entries:

```yaml
---
title: First Paragraph of Title
title: Second Paragraph of Title
---
```

The frontmatter may also include citation-related fields (`csl`, `locale`, `zotero-notes`) and metadata (`author`, `timezone`). See [converter](converter.md) for details on how these fields are handled during conversion.

| Field | Description |
|-------|-------------|
| `title` | Document title. Multiple `title:` entries create multi-paragraph titles. |
| `author` | Document author. Written as `dc:creator` in Document Properties on DOCX export. |
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`) or absolute path to a `.csl` file. Controls citation and bibliography formatting. Defaults to `apa`. Non-bundled styles are downloaded automatically by the converter on first use. |
| `locale` | Locale override for citation formatting (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `zotero-notes` | Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. Legacy alias: `note-type`. |
| `notes` | Controls footnote/endnote OOXML generation: `footnotes` (default) or `endnotes`. See [Footnotes](#footnotes). |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`) for comment and revision dates. Kept through a DOCX round trip, with comment dates written in it; import doesn't add it. |
| `bibliography` | Path to a `.bib` file for citation resolution. Aliases: `bib`, `bibtex`. The `.bib` extension is optional. Relative paths resolve from the `.md` file directory, then workspace root. `/`-prefixed paths resolve from workspace root, then as absolute OS paths. Falls back to `{basename}.bib` if not found. |
| `font` | Body font family for non-code styles. No default (uses rendering application's default). |
| `code-font` | Monospace font family for code styles. Default: Consolas. |
| `font-size` | Body font size in points. Default: 11. |
| `code-font-size` | Code font size in points. Default: 10. When `font-size` is specified without `code-font-size`, the code font size is automatically set to 1pt less than the body font size, preserving the default size difference. |
| `table-font` | Table font family. Falls back to `font` if not set. |
| `table-font-size` | Table font size in points. When `font-size` is specified without `table-font-size`, the table font size is automatically set to 2pt less than the body font size. |
| `table-col-widths` | Column width ratios for tables. Accepts space-separated (`2 1 1`), comma-separated (`2,1,1`), array (`[2, 1, 1]`), `equal`, or `auto`. Last value repeats for tables with more columns. Default: `auto` (Word auto-sizing). |
| `table-borders` | Table border style: `horizontal` (gray row separators, default), `solid` (all borders), or `none`. |
| `table-digits` | Digits after the decimal mark in table numbers: `source` or an integer from 0 to 1000. The safety limit bounds generated document size and prevents a precision setting from exhausting memory. |
| `table-decimal-mark` | Table decimal mark: `source`, `point`, `comma`, or `midpoint`. |
| `table-digit-grouping` | Table digit grouping: `source`, `none`, `comma`, `period`, `space`, or `thin-space`. |
| `header-font` | Heading font family. Accepts a single value or a comma-separated list for per-level control (H1–H6). Falls back to `font` if not set. |
| `header-font-size` | Heading font sizes in points. Accepts a single value or a comma-separated list. Overrides proportional scaling from `font-size`. |
| `header-font-style` | Heading font styles. Default: `bold`. See [valid font style values](#heading-and-title-font-configuration) below. |
| `title-font` | Title paragraph font family. Accepts a single value or a comma-separated list (one per title paragraph). Falls back to `font` if not set. |
| `title-font-size` | Title paragraph font sizes in points. Accepts a single value or a comma-separated list. |
| `title-font-style` | Title paragraph font styles. Same values as `header-font-style`. No default style. |
| `code-background-color` | Code block and inline code background color. A 6-digit hex value (e.g., `E8E8E8`) enables shading mode; `none` or `transparent` falls back to indentation-based inset mode. Default: `E8E8E8` (shading mode). Alias: `code-background`. |
| `code-font-color` | Code block and inline code text color. A 6-digit hex value (e.g., `2E2E2E`). Default: `2E2E2E`. Alias: `code-color`. |
| `code-block-inset` | Border width for code blocks in shading mode, in eighths of a point (`w:sz`). A positive integer. Default: `48`. Does not affect inline code. |
| `blockquote-style` | Word paragraph style for blockquotes: `Quote`, `IntenseQuote`, or `GitHub` (gray left border bar). Case-insensitive. Default: `GitHub`. Overrides the VS Code setting. Kept through a DOCX round trip. Without one stored by export, as in a document from Word, import sets it from the style most of the document's quote paragraphs are in, not counting alerts. |
| `callout-labels` | Whether alert callouts show their type label (for example, **Note** or **Warning**) in preview and DOCX output. Accepts only `true` or `false`. Default: `true`. When `false`, the label row is hidden while the callout body, type, colors, border, and other styling are preserved. |
| `colors` | Named color scheme for alert callouts: `github` or `guttmacher`. |
| `pipe-table-max-line-width` | Maximum line width for pipe tables in DOCX→MD conversion. Tables wider than this fall back to HTML. `0` disables pipe tables entirely. Default: `120`. Overrides the VS Code `pipeTableMaxLineWidth` setting but is itself overridden by the CLI `--pipe-table-max-line-width` flag. |
| `grid-table-max-line-width` | Maximum source line width for grid tables. Tables wider than this fall back to HTML, unless their cells hold what an HTML cell can't (see [Format Selection on DOCX→MD Conversion](#format-selection-on-docxmd-conversion)). Default: inherited from `pipe-table-max-line-width`. |
| `breaks` | When `true`, bare newlines within a paragraph are treated as hard line breaks (`<w:br/>`) in DOCX output. When `false` (default), bare newlines are soft breaks rendered as spaces — use a trailing `\` for an explicit hard line break. See [Line Breaks](#line-breaks). |
| `line-spacing` | Line spacing for body text: `single`, `1.5`, `double`, or a numeric multiplier (e.g., `1.8`). When set to a non-single value (other than the default 1.15), inter-paragraph spacing is removed and first-line paragraph indentation is automatically enabled (see [Line Spacing and Paragraph Indent](#line-spacing-and-paragraph-indent)). |
| `paragraph-indent` | First-line paragraph indentation in inches (e.g., `0.5`, `0.3`). Auto-enabled at 0.5 inches when `line-spacing` is non-single. Set to `none` to disable auto-indent while keeping line spacing. |
| `bibliography-hanging-indent` | When `true` (default), bibliography entries use a hanging indent (0.5 inch) with single-line spacing regardless of document line spacing. Set to `false` to disable. |
| `styles` | Custom paragraph style definitions. A YAML map of style names to property objects. See [Custom Styles](#custom-styles). |

### Heading and Title Font Configuration

The `header-font`, `header-font-size`, and `header-font-style` fields control heading typography independently of body text. Each field accepts a single value (applied to all heading levels) or a comma-separated list of up to six values (one per heading level H1–H6).

The `title-font`, `title-font-size`, and `title-font-style` fields provide the same per-element control over title paragraphs, where each array element maps to a successive title paragraph.

Two equivalent syntaxes are available for specifying multiple values:

**Bare comma-separated** (simpler, more casual):
```yaml
---
header-font: Georgia, Palatino, Helvetica
header-font-size: 24, 20, 16
header-font-style: bold-italic, bold, normal
---
```

**YAML inline array** (more formal):
```yaml
---
header-font: [Georgia, Palatino, Helvetica]
header-font-size: [24, 20, 16]
header-font-style: [bold-italic, bold, normal]
---
```

Both syntaxes are equivalent and produce identical results.

When an array has fewer than six elements, deeper heading levels inherit the last specified value. For example, `header-font: Georgia, Palatino` sets H1 to Georgia and H2–H6 to Palatino.

Title font fields work the same way, with array elements mapping to title paragraphs by position:

```yaml
---
title: Main Title
title: Subtitle
title-font: Georgia, Palatino
title-font-size: 28, 20
title-font-style: bold, italic
---
```

The `title` field also supports inline array syntax as a secondary alternative to repeated keys:

```yaml
---
title: [Main Title, Subtitle]
---
```

Valid font style values: `bold`, `italic`, `underline`, `smallcaps`, `allcaps`, `center`, `normal`, or hyphenated combinations (e.g., `bold-italic`, `bold-center`, `bold-smallcaps`). `smallcaps` and `allcaps` are mutually exclusive. `normal` means no bold, no italic, no underline — useful for headings, which default to bold. `normal` may only appear alone (not in hyphenated combinations). Hyphenated combinations are order-independent.

### Font Customization Example

```yaml
---
font: Georgia
code-font: Fira Code
font-size: 12
code-font-size: 10
---
```

### Tables

Manuscript Markdown provides per-table directives and document defaults for controlling table appearance and numeric display.

| Setting | Frontmatter | Comment directive | `data-` attribute | Notes |
|---------|:-----------:|:-----------------:|:-----------------:|-------|
| `table-font` | ✓ | ✓ | `data-font` | Falls back to `font` |
| `table-font-size` | ✓ | ✓ | `data-font-size` | Auto-shrink: body size − 2pt |
| `table-col-widths` | ✓ | ✓ | `data-col-widths` | `auto`, `equal`, or ratios |
| `table-orientation` | — | ✓ | `data-orientation` | Per-table only; see [Page Orientation Sections](#page-orientation-sections) |
| `table-borders` | ✓ | — | — | Frontmatter only |
| `table-digits` | ✓ | ✓ | `data-digits` | Digits after the decimal mark |
| `table-decimal-mark` | ✓ | ✓ | `data-decimal-mark` | `source`, point, comma, or midpoint |
| `table-digit-grouping` | ✓ | ✓ | `data-digit-grouping` | Three-digit groups; spaces are nonbreaking |

Per-table directives override frontmatter defaults for that table only. For pipe and grid tables, place an HTML comment before the table (`<!-- table-font-size: 9 -->`). For HTML tables, use `data-` attributes on the `<table>` element (`data-font-size="9"`). Multiple directives can precede the same table. A table keeps its own directive or attribute through a DOCX round trip even where its value is the document's, such as `<!-- table-font-size: 9 -->` with the automatic 9pt, so it still holds if the document's changes.

Priority (highest to lowest): per-table override → frontmatter default → built-in default.

A table's settings, and its format as a pipe, grid or HTML table, go to Word and back with the table, not its place in the document's order of tables: export stores each table's first row and text, and import gives each table the settings of the one export wrote that it is. So where Word adds or deletes a table before it, a table keeps its own, and one Word adds takes none. Import matches the tables alike in all their text in order, then, between them, one whose cells were edited in Word by its first row, and then the rest by their order, where as many are left on each side.

#### Numeric Table Formatting

The three numeric settings inherit independently. An omitted per-table property inherits the document value; an explicit `source` cancels that inherited property and preserves the source display. `table-digits: N` rounds or pads numeric values to exactly N decimal places. Separator-only changes preserve source precision and trailing zeroes, so `12.30%` becomes `12·30%`, not `12·3%`.

```markdown
<!-- table-digits: 2 -->
<!-- table-decimal-mark: midpoint -->
<!-- table-digit-grouping: thin-space -->
```

Excel cells use Excel's displayed value and number format by default; Stata cells use their display format. Percent, currency, and scientific semantics are retained. Value labels, missing values, dates, Booleans, and identifiers are not treated as ordinary numbers. Markdown and CSV/TSV cells are formatted only when the whole cell matches a strict numeric or statistical grammar; ambiguous punctuation is left unchanged. Decimal and grouping settings that use the same character are invalid.

#### Table Font Configuration

The `table-font` and `table-font-size` frontmatter fields control table typography independently of body text.

**Auto-shrink behavior**: When `font-size` is specified without an explicit `table-font-size`, tables automatically use a font size 2pt smaller than the body font size. For example, `font-size: 12` produces 10pt table text. Setting `table-font-size` explicitly disables auto-shrink. Setting `table-font` alone does not affect the 2pt reduction — it only changes the font family while auto-shrink still applies to the size.

**Per-table overrides** allow individual tables to use different font settings. Two mechanisms are supported:

**HTML comment directive** — place a comment immediately before the table. Supported directives: `table-font-size` and `table-font`.

```markdown
<!-- table-font-size: 8 -->
| Column A | Column B |
|----------|----------|
| data     | data     |
```

**HTML `<table>` data attributes** — for HTML tables, use `data-font-size` and `data-font` attributes:

```html
<table data-font-size="8" data-font="Arial Narrow">
  <tr><td>data</td><td>data</td></tr>
</table>
```

**Priority** (highest to lowest): per-table override → document-level frontmatter → auto-shrink default.

Per-table overrides are preserved through DOCX round-trips: comment directives and data attributes are re-emitted on conversion back to Markdown.

#### Table Column Widths

The `table-col-widths` frontmatter field controls column width ratios for all tables in the document.

**Accepted formats**: space-separated (`2 1 1`), comma-separated (`2,1,1`), array (`[2, 1, 1]`), the keyword `equal` (all columns same width), or `auto` (explicit no-op — uses Word's default auto-sizing).

**Repeat-last-value**: when a table has more columns than specified ratios, the last ratio is repeated. For example, `2 1` applied to a 4-column table produces ratios `2 1 1 1`.

**Per-table overrides** allow individual tables to use different column widths:

**HTML comment directive** — place a comment immediately before the table:

```markdown
<!-- table-col-widths: 2 1 1 -->
| Wide Column | A | B |
|-------------|---|---|
| data        | 1 | 2 |
```

**HTML `<table>` data attribute** — for HTML tables, use `data-col-widths`:

```html
<table data-col-widths="2,1,1">
  <tr><td>Wide</td><td>A</td><td>B</td></tr>
</table>
```

**`auto` keyword**: use `auto` in a per-table directive (`<!-- table-col-widths: auto -->` or `data-col-widths="auto"`) to override a frontmatter default and restore Word's default auto-sizing for that specific table. In frontmatter (`table-col-widths: auto`), it acts as an explicit no-op that round-trips through DOCX.

**Priority** (highest to lowest): per-table override → frontmatter default → auto (Word default).

Per-table overrides and frontmatter defaults are preserved through DOCX round-trips, a per-table override even where it's the frontmatter's.

### Page Orientation Sections

Orientation fences (`<!-- landscape -->` / `<!-- portrait -->`) isolate content on its own page with page breaks before and after. Two common use cases: fitting a wide table on a landscape page, or isolating a table or figure on its own portrait page with explicit section breaks.

#### Landscape

Use `<!-- landscape -->` / `<!-- /landscape -->` fencing to place content on landscape-oriented pages. All content between the fences — including table titles, notes, and the table itself — is rendered on landscape pages in the DOCX output.

```markdown
<!-- landscape -->

Table 1. Regression Results

| Variable | Model 1 | Model 2 | Model 3 | Model 4 | Model 5 |
|----------|---------|---------|---------|---------|---------|
| X1       | 0.42    | 0.38    | 0.41    | 0.39    | 0.40    |

Note: Standard errors in parentheses.

<!-- /landscape -->
```

For a single table without title or notes, use the `data-orientation` attribute on the `<table>` tag or a comment directive:

```html
<table data-orientation="landscape">
  <tr><td>wide content</td></tr>
</table>
```

```markdown
<!-- table-orientation: landscape -->

| A | B | C | D | E |
|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 |
```

#### Portrait

Use `<!-- portrait -->` / `<!-- /portrait -->` fencing to explicitly place content on portrait-oriented pages. This is useful for isolating a table or figure on its own page, or creating explicit section breaks between portrait content.

```markdown
<!-- portrait -->

Content on a portrait-oriented page.

<!-- /portrait -->
```

For a single table, use the `data-orientation` attribute or a comment directive:

```html
<table data-orientation="portrait">
  <tr><td>content</td></tr>
</table>
```

```markdown
<!-- table-orientation: portrait -->

| A | B |
|---|---|
| 1 | 2 |
```

#### Shared behavior

- Orientation sections produce OOXML section breaks. The page size and margins are derived from the template document's own section properties if available, not a tracked change's old ones, defaulting to US Letter with one-inch margins. The template's headers, footers and page number format continue through them, and the page numbers count on through them.
- Sections are preserved through DOCX round-trips. DOCX import reads the last section's orientation from the body's own section properties, where Word keeps it, so a Word document that ends with a landscape section after another section gets fences around that section. A document of one section has its orientation as its page setup, as a template's, and gets no fences. Nor does a last section that export gave a landscape template's page, which no fence set, as a custom property records; a section after a break added in Word is still read as its page is. DOCX export writes a section that ends the document after another the same way, with no section break after its last paragraph, which would leave an empty last section, a blank last page, and with the template's page turned to the section's orientation where it isn't already. The section still starts on a new page, as its break did, where the template's last section starts on the same page or on an odd or even one.
- **Nested fences**: An opening fence inside an already-open block of the same type is treated as a close followed by an open (a section break) and produces a warning.
- **Fences in list items and notes**: A list item can't hold a fence after its text, so export drops one there, and a note has no sections, so export ignores one in a note; each gives a warning, and pairs with no fence outside it. The language server flags them as export does, along with unclosed, orphaned, nested, and crossed fences, reading the blocks export reads after its preprocessing: a grid table indented in a list item ends the list, so a fence after it is the document's. A fence that is a list item's first block, or its first after blocks the item can't hold and export drops, as code or an HTML table, is the item's text, one in a quote is a comment, and one on a line of its own in a CriticMarkup span of more than one paragraph is the span's text, which neither flags.
- **Consecutive fences**: Transitions between orientation sections (or consecutive sections of the same type) do not produce blank intermediate pages. For example, a `<!-- /landscape -->` with a `<!-- portrait -->` on the next line, or after a blank line, transitions directly without an empty page in between. Each directive is a comment on a line of its own: two on one line, as `<!-- /landscape --><!-- portrait -->`, are one comment, which export keeps, hidden, and reads as neither, as the language server does. A table with its own orientation, from `data-orientation` or a `table-orientation` directive, is a section here too, so one right after a fence, before one, or after another such table starts or ends its section with no empty page either. A section that opens the document, before any other content or a title, starts on the first page, with no section break and so no empty page before it.
- **Hidden comments between sections**: Comments alone in their paragraphs, which export writes hidden, as `<!-- a note -->`, a directive that applies to nothing, as `<!-- indent -->` before a fence, or an orphaned fence, get no section of their own between two sections, before the first or after the last, which would show nothing, an empty page. They start the section after them, or, after the last, end it, where it ends the document after another, as above. DOCX import puts them back before its opening fence, or after its closing one, as a custom property records. Ones in a style block keep a section of their own.

#### Embedded Tables

Embed tables from external files using an HTML comment directive:

```markdown
<!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
```

File paths are resolved relative to the markdown file. Values support optional single or double quotes for paths with spaces.

| Param | Applies to | Default | Description |
|-------|-----------|---------|-------------|
| `sheet` | .xlsx | First sheet | Sheet name or 1-based index |
| `range` | .xlsx | Auto-detect bounding rectangle | Cell range (e.g. `A1:F20`) or named range |
| `headers` | .csv, .tsv, .xlsx | `1` | Number of header rows |

Supported file types: `.csv`, `.tsv`, `.xlsx`, and `.md` (tables only). Table directives (`table-font-size`, `table-font`, `table-orientation`, `table-col-widths`) placed before the embed comment apply to the resulting table, same as with inline tables.

See [Embedded Tables](embedded-tables.md) for file-type details, a worked example, error diagnostics, and round-trip behavior.

### Code Block Styling Example

```yaml
---
code-background-color: E8E8E8
code-font-color: 2E2E2E
code-block-inset: 48
---
```

To disable the colored background and use indentation-based inset mode:

```yaml
---
code-background-color: none
---
```

### Custom Styles

The `styles` frontmatter field defines custom paragraph styles that can be applied to blocks of content using HTML comment directives. Each style is a named map of typographic properties:

```yaml
---
styles:
  epigraph:
    font: Palatino
    font-size: 10
    font-style: italic
    spacing-before: 12
    spacing-after: 12
    paragraph-indent: none
  block-title:
    font-style: bold-smallcaps-center
    spacing-before: 6
    spacing-after: 3
---
```

#### Style Properties

| Property | Description |
|----------|-------------|
| `font` | Font family. |
| `font-size` | Font size in points. |
| `font-style` | Same [font style values](#heading-and-title-font-configuration) as `header-font-style`. Since custom styles inherit from Normal, the default is already non-bold — `normal` is rarely needed here. |
| `spacing-before` | Spacing before the paragraph in points. |
| `spacing-after` | Spacing after the paragraph in points. |
| `paragraph-indent` | First-line paragraph indentation in inches (for example `0.5`) or `none` to explicitly suppress inherited indent. |

All properties are optional. Unspecified properties inherit from the Normal style.

#### Block Directive Syntax

Apply a custom style to a range of paragraphs using `<!-- style: name -->` / `<!-- /style -->` fencing, analogous to orientation fences:

```markdown
<!-- style: epigraph -->

The mind is not a vessel to be filled, but a fire to be kindled.

— Plutarch

<!-- /style -->
```

All paragraphs between the opening and closing directives receive the named style. Nested style directives are not supported — opening a new style implicitly closes the previous one (with a warning).

#### Round-Trip

Custom styles are preserved through DOCX round-trips. On export, each style is created as a Word paragraph style (basedOn Normal) with a `MsCustomXxx` style ID. The style definitions are stored in the `MANUSCRIPT_CUSTOM_STYLES` custom property in `docProps/custom.xml`. On import, the custom property is read back and the style definitions are emitted in the frontmatter `styles` block, with `<!-- style: name -->` / `<!-- /style -->` directives re-emitted around the styled paragraphs. An HTML comment on lines of its own in the block, which Word hides with its paragraph, keeps the block's style too, so it comes back inside the block.

### Line Spacing and Paragraph Indent

The `line-spacing` frontmatter field controls the line spacing for body text in the DOCX output. Accepted values are `single`, `1.5`, `double`, or any positive numeric multiplier (e.g., `1.8`). When omitted, the default is 1.15 (Word's standard).

```yaml
---
line-spacing: double
---
```

When line spacing is set to a non-single value (anything other than `single` or the default 1.15), the converter automatically:

1. Removes inter-paragraph spacing (`w:after="0"` on the Normal style)
2. Applies a 0.5-inch first-line indent to body paragraphs

This matches the academic manuscript convention of double-spaced text with paragraph indentation instead of inter-paragraph gaps.

**First paragraph after a heading**: The first-line indent is automatically suppressed on the first paragraph following a heading or title, following standard typographic convention.

**Overriding the default indent**: Use `paragraph-indent` to customize:

```yaml
---
line-spacing: double
paragraph-indent: 0.3
---
```

**Disabling auto-indent**: Set `paragraph-indent: none` to keep the line spacing without paragraph indentation:

```yaml
---
line-spacing: double
paragraph-indent: none
---
```

**Explicit indent without line spacing**: `paragraph-indent` can be set independently of `line-spacing` to add first-line indentation at any line spacing:

```yaml
---
paragraph-indent: 0.5
---
```

#### Per-Paragraph Indent Overrides

Use `<!-- no-indent -->` and `<!-- indent -->` HTML comment directives to override the indentation of individual paragraphs or lists. Each directive applies to the immediately following paragraph or list block:

```markdown
---
line-spacing: double
---

# Introduction

First paragraph (auto-suppressed indent after heading).

Second paragraph (indented by default).

<!-- no-indent -->
Third paragraph (indent explicitly suppressed).

<!-- indent -->
Fourth paragraph (indent explicitly forced).

<!-- no-indent -->
1. First item
2. Second item
```

- `<!-- no-indent -->` suppresses the first-line indent on the next paragraph, even when document-level indent mode is active. When placed before a list, it applies to all items in the list.
- `<!-- indent -->` forces a first-line indent on the next paragraph, even after a heading or without document-level indent mode. Uses the document's `paragraph-indent` value (default 0.5 inches). Also applies to lists.

Both directives are consumed during parsing (they do not appear in the DOCX) and are preserved through round-trips via `MANUSCRIPT_INDENT_OVERRIDES` and `MANUSCRIPT_LIST_INDENT_OVERRIDES` custom properties.

#### Bibliography

The `bibliography-hanging-indent` field controls whether bibliography entries use a hanging indent. When `true` (default), bibliography entries are formatted with a 0.5-inch hanging indent and single-line spacing, regardless of the document's line spacing setting.

Export writes each entry's text as a browser shows the HTML citeproc formats it as: whitespace runs together into one space, and there is none at the entry's edges. In a style that puts each entry's number in the margin (one with `second-field-align`, such as `ieee` or `vancouver`), a tab follows the number, as Zotero writes it in Word, so the text starts at the hanging indent. A part of an entry that a style puts on a line of its own starts after a line break.

```yaml
---
bibliography-hanging-indent: false
---
```

All three settings are preserved through DOCX round-trips via custom properties in `docProps/custom.xml`.

## Standard Markdown

Manuscript Markdown supports CommonMark plus the implemented [GitHub Flavored Markdown](https://github.github.com/gfm/) extension set.

- **Formatting**: bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`), underline (`<u>text</u>`), superscript (`<sup>text</sup>`), subscript (`<sub>text</sub>`), inline code (`` `code` ``). The HTML tags `<b>` and `<strong>` are bold too, `<i>` and `<em>` italic, and `<s>`, `<del>` and `<strike>` strikethrough. DOCX→MD conversion writes `<b>`, `<i>` or `<s>` where Word's formatting starts or ends at a point Markdown's delimiters can't: `a**.b**` isn't bold, since `**` after a letter can't open before punctuation, so a bold `.b` after an `a` is `a<b>.b</b>`. The same goes for formatting that would run into the delimiter of a neighbour, as italic `a` before bold `b` would in `*a***b**`. Struck text with whitespace or a line break at its edges, or whitespace alone, goes in `<s>`, which holds the whitespace, as `<s>a </s>b` and `<s>a\` + newline + `</s>b`: Word shows the strike on it, and `~~` can't close after a space or at a line's start. A line break of its own that Word underlines or strikes goes in `<u>` or `<s>`, as `a<u>\` + newline + `</u>b`. Formatting around inline code, as `` **`code`** ``, is the code's in Word, and DOCX→MD conversion writes Word's formatting of code around its backticks, where Markdown reads it. A line break in Word's code, which a code span can't hold, goes between spans of the code on each side of it, inside the formatting around them, as ``==`a`\`` + newline + `` `b`==``, or in the highlight of a span that an `==` in highlighted code splits it into, so Word shows a highlight, an underline or a strikethrough on it again, though not code's own style.
- **Headings**: `# H1` through `###### H6`
- **Lists**: bulleted (`- item`), numbered (`1. item`), task lists (`- [ ] item`, `- [x] item`). Blockquote continuation blocks and HTML blocks inside list items are preserved; see [List item limitations](#list-item-block-content) for the remaining unsupported block content.
- **Links**: `[text](url)` plus autolink literals (bare URLs/emails)
- **Code blocks**: fenced with triple backticks. Optional language annotation (e.g., `` ```stata ``) is preserved on round-trip via the `MANUSCRIPT_CODE_BLOCK_LANGS` custom property in the DOCX, and for a note's code blocks, the index of the note's first in `MANUSCRIPT_NOTE_CODE_BLOCKS`, by the note's ID, so each note keeps its own languages wherever Word shows it, and a code block Word adds to a note gets none. In Word, code blocks use the "Code Block" paragraph style (Consolas, shaded background). Consecutive code blocks are separated by an empty paragraph to prevent merging. A code block in a footnote or endnote takes the same style, and the note's mark goes in a paragraph of its own when the note starts with one.
- **Blockquotes**: `> quoted text`. A quote holds paragraphs, nested quotes, alerts, HTML blocks and display math; see [Blockquote limitations](#blockquote-block-content) for the rest. Two quotes with a blank line between them stay two in Word, with an empty paragraph for each blank line, as two alerts do, where the paragraphs of one quote, which a line of `>` alone separates, have none between them. On DOCX import, two quotes at the same level with nothing between them come back a blank line apart, or, nested, with a line of the `>` of the quote around them between.
- **Tables**: pipe tables, grid tables, and HTML tables. See [Tables](#tables) for syntax, examples, and comparison.

### Line Breaks

Manuscript Markdown follows CommonMark line break semantics by default:

- **Soft break** (bare newline): A plain newline within a paragraph is treated as a space. It does not produce a line break in DOCX output.
- **Hard break** (trailing `\` or two trailing spaces): A backslash or two spaces at the end of a line followed by a newline produces a hard line break (`<w:br/>` in DOCX). The trailing `\` form is preferred because trailing spaces are invisible and easily stripped by editors.

```
This line has a backslash\
and this continues on a new line.

This line has nothing special
and this flows into the same paragraph (no line break).
```

The `breaks: true` frontmatter setting changes the default behavior so that bare newlines within a paragraph are treated as hard line breaks, matching the behavior of some other Markdown tools.

**Grid tables**: Within grid table cells, bare newlines are always treated as hard line breaks regardless of the `breaks` setting, since the grid structure makes every line placement deliberate.

**DOCX→MD**: When converting from Word, line breaks (`<w:br/>`) are emitted as `\` + newline in the Markdown output, making the hard break intent explicit. Markdown can't hold that form at the end of a paragraph, where the `\` would be text, or in a heading, which would end at it, so there a line break is emitted as `<br>`. So is one at the end of a table cell, which a pipe table can't hold as a line end, and where a grid table's blank lines pad the cell. So is one before an HTML comment that would start the next line, where the comment would start an HTML block, which ends the paragraph and leaves the `\` as text. Not where the comment's hidden run starts with spaces or tabs, which import keeps at a line's start and writes there as character references, `&#32;<!-- c -->`, after which no block starts, but for those before a comment over lines, which is a block's. The comment then goes after the `<br>` with the rest of its line, and the comments on that line before anything it shows go without the whitespace their hidden runs hold outside them, such as the block's indent before the first, which Word hides and the paragraph would show. The comments after text on that line go as they do after text on any line. This happens only where export reads the line after a `<br>` as part of the paragraph or heading it's in, with each comment whole. A comment with a blank line in it, or a line that would start a block, or one over lines in a heading, stays in its HTML block, which keeps it hidden. So do the comments on a line whose hidden runs hold other text outside them, as the `x` of `<!-- a -->x<!-- b -->`, which the paragraph would show but a block that starts and ends with a comment hides. So does a line break on a line of an HTML block that a comment at the paragraph's start began. In a table's cell, which starts no block, a line break before a comment stays as the cell writes one, but the comments at its line's start, before anything it shows, still go without the whitespace their hidden runs hold outside them, which the cell would show after the break. Export reads `<br>`, `<br/>`, and `<br />` as a line break in a paragraph's text, and on lines of their own, which markdown-it reads as an HTML block, where such tags are all the block holds. A `<br>` that is text in Word is escaped as `&lt;br&gt;`.

A line feed or carriage return inside Word's text (`<w:t>`) is not a line break. Word writes its line breaks as `<w:br/>` or `<w:cr/>`, never in the text, and shows one that another tool writes there as a space, so import writes a space for it, not a line's end. A carriage return and the line feed after it are one line end, as other tools write one, even where Word's runs split them, but not where a tracked change or a comment holds one and not the other. A paragraph whose text is an HTML block of its own, as export writes one with its line ends in the text, keeps them, as Markdown reads the block by its lines, all but one at the end of its text, which ends the block's last line as the paragraph's end does. So does one a comment's point comes after, which import writes as text, as the comment would go in the block, with its line ends as `&#10;`, as in `\<div>&#10;# heading&#10;</div>{>>c<<}`, one at its end too. A reference is no line's end, and Markdown shows it as a space, as Word does. Where anything else keeps the paragraph from being the block, as a comment's range on it or a note's mark after it, its line feeds are spaces. So does a tag import writes as HTML, as `<span title="a` with `b">` on the next line, in shown or deleted text, in a paragraph that can hold lines, but not in a heading, a table's cell or code, nor in a tag it writes as text, as `&lt;b class="x"&gt;`. The tag is read over the runs import writes as one text, as runs alike, or a run's text on each side of a tab, or whitespace in bold or italic alone between them, which import writes with no delimiters, but not runs formatted apart otherwise, which it writes in parts. Whether it is one is read from the text import writes for the paragraph, so what shows nothing, as an empty run or a content control around its runs, doesn't count, nor does a note's mark and the space after it, and formatting its paragraph mark has that its runs turn off is none. A heading or title can't hold one, but a note's paragraph in a heading's style, which a note doesn't read, can.

### GitHub Flavored Markdown Extension Notes

- **Autolink literals** are enabled in parser and preview (for example, `https://example.com` is linkified without explicit `[]()` markup). A URL that is text in Word, not a link, comes back from DOCX with its colon escaped, `https\://example.com`, so it stays text, also where its formatting changes inside it, as a plain `https://` before a struck `example.com` does: `https\://~~example.com~~`.
- **Strikethrough** uses standard GitHub `~~text~~` behavior.
- **Task list items** are parsed semantically as checkbox list items, not only plain text prefixes. As in GFM, the box must be plain text at the very start of the item: `` - `[ ] a` ``, `- **[ ] a**`, `- [[ ] a](url)` and `- \[ ] a` are ordinary list items. The box takes the whitespace written after it, but not whitespace written as character references after that, which is the item's text: `- [ ] &#32;a` goes to Word as `☐  a`, as import writes a task item whose text starts with a space. An alert's marker, likewise, must be plain text at the start of a quote's line: `` > `[!NOTE]` `` and `> \[!NOTE]` are ordinary quotes.
- **Disallowed raw HTML** follows the GitHub extension set (`title`, `textarea`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `script`, `plaintext`) and is treated as literal text in preview/conversion paths.
- **Intentional HTML exceptions**: HTML comments (`<!-- ... -->`) and supported inline HTML formatting tags used by this project (for example `<u>`, `<sup>`, `<sub>`, `<b>`, `<i>`, `<s>`) remain supported.
- **Alerts** use GitHub's blockquote-based syntax with `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]` markers at the start of a line. Alert content follows on subsequent `>` lines, and a marker at the start of a later line starts another alert. That's a line of the source, after a line end or a `\` and one, not after a `<br>`, after which a marker is text. Content can also follow the marker on its line. The marker takes the whitespace written after it, but not whitespace written as character references after that, which is the alert's text: `> [!NOTE] &#32;a` goes to Word as ` a` after the label, as import writes an alert whose text on the marker's line starts with a space. Alerts are displayed with colored left borders and type-specific header icons in preview and are preserved through DOCX round-trip. Type labels are shown by default; set `callout-labels: false` in frontmatter to hide the label row in both preview and DOCX output without removing the callout's body, type, colors, border, or other styling. An explicit `true` or `false` value round-trips through DOCX via the `MANUSCRIPT_CALLOUT_LABELS` custom property. On DOCX import, a comment Word put on an alert's label and on its text, as on the whole paragraph, starts after the label, which the marker stands for, as `> [!NOTE]` + newline + `> {==text==}{>>c<<}`. A comment on the label alone, or a tracked change to it, keeps the label as text after the marker, as one on a task item's box keeps the box. So does a link on the label, which import keeps, and a comment on the line break or space after the label alone, which keeps that as its text. Where import writes another comment's range as starting before the label, as one from a code block before the alert, which holds no markers, the label stays as text too, with the line break after it. So does a label whose line break or space has formatting or a link, as a highlight, which import keeps, or where a comment of no width is, or a comment starts. Import moves a comment only where it starts on the label and goes on in the text.

## Tables

Manuscript Markdown supports three inline table formats, plus embedding from external files. The DOCX converter chooses the simplest inline format that can represent each table's content.

### Pipe Tables

The most common format — simple, compact tables using pipe delimiters with optional column alignment:

```markdown
| Left | Center | Right |
|:-----|:------:|------:|
| a    |   b    |     c |
| d    |   e    |     f |
```

Pipe tables support column alignment via `:` in the separator row, which sets the alignment of the column's paragraphs in Word, but do not support multi-line cells, colspan, or rowspan. Tables support per-table font and column-width overrides via comment directives (`<!-- table-font-size: N -->`) and HTML data attributes (`data-font-size`, `data-font`); see [Table Font Configuration](#table-font-configuration).

The line-width threshold for pipe tables is controlled by the `pipe-table-max-line-width` frontmatter field, the VS Code `pipeTableMaxLineWidth` setting, or the CLI `--pipe-table-max-line-width` flag.

### Grid Tables

Grid tables use [Pandoc grid table syntax](https://pandoc.org/MANUAL.html#extension-grid_tables) and support multi-line cells that pipe tables cannot represent:

```
+----------+----------+
| Header 1 | Header 2 |
+==========+==========+
| Cell 1   | Cell 2   |
|          | line 2   |
+----------+----------+
| Cell 3   | Cell 4   |
+----------+----------+
```

- Column boundaries are defined by `+` positions in the separator line, counted in display columns as Pandoc counts them: a wide character, such as a CJK one or an emoji, takes two, and a combining mark none. An emoji sequence takes what Pandoc pads it to: a skin tone or a variation selector-16 makes the emoji before it wide, and emoji joined by joiners count as the last of them, so 🏳‍🌈 takes two. A table whose `|` signs line up with the `+` signs by character count instead, as Expand Table pads one, is read that way, and a line that lines up neither way is cut at its edges and at the `|` nearest each `+` between
- The `=` separator distinguishes header rows from body rows, so a table's header rows lead it, and a table without one has no header row. On DOCX import, a Word table with a header row after a body row is HTML, which keeps that row's header
- A `:` at either end of a column's `=` in the header's separator sets its alignment, as in `+:===+===:+` (left, then right); a table without a header takes them in its top line
- Multiple content lines between separators form a single logical row with multi-line cells. Blank lines at a cell's end pad it to its row's height, as Pandoc reads them, and aren't line breaks, though a `\` before them ends its line in one
- A cell's padding is the spaces and tabs at each line's end, the space or tab at its start, as Pandoc reads it, and all of them at the cell's start. A line after the first reads as a paragraph's line does: its text drops the spaces and tabs it starts with, but a comment over lines, or other text Markdown keeps as it is, as code, keeps them
- Grid tables do not support colspan or rowspan (use HTML tables for spans)
- A grid table's lines in an HTML block, as on the lines after a `<div>` or a `</table>` before a blank line, or in a comment, are the block's text, as markdown-it reads them and a pipe table's there, and not a table, in the preview or in Word. A blank line before the table ends the block, so `<div>`, a blank line and then the table make a table
- On round-trip, grid tables are stored with `sourceFormat: 'grid'` metadata so the format is preserved

The line-width threshold for grid tables is controlled by the `grid-table-max-line-width` frontmatter field (defaults to `pipe-table-max-line-width`).

### HTML Tables

HTML tables support the full range of table features including colspan, rowspan, and multi-paragraph cells:

```html
<table>
  <tr>
    <th colspan="2">Merged Header</th>
  </tr>
  <tr>
    <td>Cell 1</td>
    <td rowspan="2">Tall cell</td>
  </tr>
  <tr>
    <td>Cell 3</td>
  </tr>
</table>
```

A cell takes HTML formatting only. Markdown, CriticMarkup, comments, citations and math in a cell export as literal text. Each `<p>` in a cell exports as a paragraph of the Word cell, and `<br>` as a line break, in the formatting around it, as text is, which Word shows on it, as the underline of `<u>a<br>b</u>`, and in the hyperlink of the `<a>` it's in, if any. A `<pre>` exports as a paragraph that keeps its spaces and tabs, with each line end as a line break, as HTML shows it: not the line end right after `<pre>`, which HTML drops, nor its last line end or `<br>`, which starts no line with anything on it. A carriage return by reference, as `&#13;`, or without its `;`, as `&#13` before a character that isn't a digit, shows nothing in a browser, so it exports as nothing, and `&#13;&#10;` as one line end. The text on either side of it stays apart, as in the browser, so `&&#13;#10;` exports as the text `&#10;`, not a line end. Import writes it as a `<p>`, with `<br>` between its lines. A cell's `align="left"`, `"center"` or `"right"`, or a `text-align` style, sets its alignment. A row with a `<th>` is a header row in Word. Word repeats a header row on each page only when it leads the table, but one after a `<td>` row stays a header row through export and import, and the rows before it stay body rows.

A table, row or cell commented out, as `<!-- <table>...</table> -->`, is none, as in the preview, and a comment in a cell is hidden in Word, as one in a paragraph is. One with no end, which runs to the end of the cell, imports with one, and one the browser ends at a `--!>` imports with a `-->` where the table can't stay HTML, as inline Markdown reads a comment on past a `--!>`. One with a blank line, which a grid table's cell holds, imports without it where the table can only be HTML, as the blank line would end the table's HTML block. Word's table can't hold a comment between its rows or cells, so DOCX export drops one, with a warning, and writes a table whose rows are all commented out as HTML around another table in its block, or else the block as text, as other HTML, with a warning. Expand Table and Compact Table leave a table with such a comment as it is, as they do one with a comment in a cell that holds a line end or a `|`, or that inline Markdown doesn't read as a comment, as one with no end. The rest of a table's HTML block, such as a `<div>` around the table, a caption in a `<p>` on the line before it, or text on the lines after it, isn't shown in Word, with a warning, but goes with the table, so import writes it back around the table, on the table's lines as it was, and a table after another in its block on in it, where Word put nothing between them. A block that starts and ends with a comment but holds a table outside it is a table, not a comment. Import finds the table by its first row and all its text, and the count of tables alike in both before it, so neither one Word adds or deletes before it nor one alike without HTML takes the HTML; a table whose text was edited in Word gets the HTML export wrote with the table it matches, as its settings do (see [Tables](#tables)), if its first row is the same and the table the HTML was written with isn't still there. A table that gets the HTML stays HTML, as it was written, though Word added or deleted a table before it. A table that can't stay HTML, as one a tracked change in Word now holds, gets it as blocks of their own around it, which the next export shows as text: its HTML as it was, but with each comment's end one Markdown reads as the browser does, as `-->` for `--!>`, and for a comment alone that would read as a directive, as `<!-- table-font-size: 11 -->` would, which is dropped, and its other text escaped, so that `# Source` stays text and isn't a heading, with the lines of a paragraph of it on one, as the browser shows them and Word holds them. A paragraph of that text is written as import writes the Word paragraph export makes of it, with a tag that formats text, as `<b>b</b>`, as Markdown's `**b**`, where that reads as it, a character reference, as `&amp;`, as its character, and a `<br>` as a line break, but with a citation's brackets escaped, as `\[@key]`, as the HTML held them as text, though the next import reads Word's text of a citation whose key the document cites as a citation (see [Round-Trip Features](converter.md#round-trip-features)), and as it was where a reference, as `&#13;`, is a line end's, and a blank line goes between each of its paragraphs and HTML blocks and the next, as between Word's paragraphs, but next to a comment, so the next round trip leaves them as they are.

On DOCX import, a column whose cells share an alignment takes it in a pipe or grid table, and an HTML table's cell takes its own. A line break that Word underlines or strikes in an HTML table's cell imports inside the `<u>` or `<s>`, as `<u>a<br></u>b`. A cell's alignment is its paragraphs', set on them or by their style or the table's.

Expand Table and Compact Table write an HTML table as import writes Word's: as a pipe table, or a grid table where it starts with more than one `<th>` row or a cell has a line break before its last text. A cell with two line breaks in a row before its last text, as a `<pre>` with a blank line, makes a pipe table, as `a<br><br>b`, since the preview shows a grid table's blank line in a cell as one line break, and a table that also starts with more than one `<th>` row stays HTML. A cell's text stays the text it is in HTML, so it takes an escape wherever the pipe or grid cell would read it as Markdown, as `\*a\*` for `*a*` or `\[@key]` for `[@key]`. A table neither can hold as it is, as one with merged cells, a cell of paragraphs, or a control character, which Word can't hold either, stays HTML. A pipe table's header is its first row, so a table that doesn't start with a `<th>` row gets one there.

Per-table overrides use `data-` attributes directly on the `<table>` element (`data-font-size`, `data-font`, `data-col-widths`, `data-orientation`):

```html
<table data-font-size="9" data-col-widths="2,1,1">
  <tr><th>Wide Column</th><th>A</th><th>B</th></tr>
  <tr><td>data</td><td>1</td><td>2</td></tr>
</table>
```

A character reference in an HTML table, in a cell's text, a link's URL or an attribute, or in an `<img>`'s `src` or `alt`, reads as the browser reads it, so Word shows what the preview does: a named one by any of HTML's names, as `&copy;` for ©, with its `;`, or by one of about a hundred older names without it, as `&copy b` for © b, though not in an attribute before a letter, a digit or an `=`, as in `href="?a=1&copy=2"`, and a numeric one from `&#128;` to `&#159;` as the Windows-1252 character HTML takes it for, as `&#128;` for €, but for the five Windows-1252 has none for, one without its `;`, as `&#128`, or with an `X`, as `&#X80;`, too, and one to no character, as `&#0;`, a surrogate or one past U+10FFFF, as U+FFFD. A numeric one's leading zeros don't count, so `&#00065;` is A, however many there are, and a number of hundreds of digits past U+10FFFF is U+FFFD too. Markdown's own text, outside HTML, reads one as markdown-it does, by CommonMark's rules, so `&#128;` there is U+FFFD and `&copy b` stays as it is, in the preview and in Word.

### Format Selection on DOCX→MD Conversion

When converting from DOCX to Markdown, the converter selects the simplest format that preserves the table's content:

1. **Pipe table** — used when all cells are single-line, the first row is the table's one header row, and the table fits within the configured line width
2. **Grid table** — used when the original table was grid format and cells require multi-line content, or when a pipe table can't hold the table's header, as a table without a header row, which a grid table without a `=` separator holds
3. **HTML table** — fallback for tables with colspan, rowspan, multi-paragraph cells, or that exceed the configured line width

A table whose cells hold what an HTML cell can't, such as a comment, a tracked change or a highlight, is a grid table of any width where it would otherwise be HTML, even with a line width of 0. That keeps its cells' content, but not a cell's own alignment, which a grid table holds only for a column. It stays HTML if it has merged cells, which only HTML holds, a cell of more than one paragraph, which a grid table's cell holds as lines, a header row after a body row, which a grid table's header can't hold, or a font or column widths with `-->`, which no directive's comment can hold. There, a cell's comment, tracked change, highlight, equation, citation or image exports as literal text, an equation as its Markdown with a line break for each of its line ends. Import writes a comment, a citation or an image there as that text reads back from Word, with its `<`, `>` and `&` as character references, but for the `>` and `<` of CriticMarkup's `{>>`, `<<}` and `~>`, which export reads as text as they are, so the editor still shows a comment and a substitution's sides there: a comment on `b` whose body is `x<b>y` comes in as `{==b==}{>>x&lt;b&gt;y<<}`, whose tag stays text.

### Embedded Tables

Tables can also be embedded from external `.csv`, `.tsv`, `.xlsx`, and `.md` files using the `<!-- embed: -->` directive. Embedded tables support the same formatting directives as inline tables and are expanded into full tables on Word export. See [Embedded Tables](embedded-tables.md) for syntax, parameters, and examples.

## Citations

Manuscript Markdown uses [Pandoc citation syntax](https://pandoc.org/MANUAL.html#citations) with BibTeX keys:

- Single citation: `[@smith2020]`
- With locator: `[@smith2020, p. 20]`
- Multiple citations: `[@smith2020; @jones2021]`
- Suppress author: `[-@smith2020]`
- With prefix: `[e.g., @smith2020; @jones2021]`, or per item: `[@smith2020; see also @jones2021]`

Separate keys with semicolons even after a prefix. Write `[e.g., @smith2020; @jones2021]`, not `[e.g., @smith2020 and @jones2021]`. A citation with a prefix keeps its keys in the order written, even when the style would otherwise sort them, so a leading "e.g.," stays first. A prefix is plain text. Punctuation such as `=` or `<` is fine, but if the text before the first key contains Markdown formatting, such as code, emphasis, or CriticMarkup, the brackets stay ordinary text. To keep a character literal, escape it with a backslash, as in `[see \*also\* @smith2020]`. Keys and locators are read as written, so a tag such as `<b>` in one is text, and the preview shows a citation as text too. On DOCX import, Word's text that reads as a citation stays one only where it is all one run of formatting. Where formatting, a tracked change or a comment changes inside it, export would take the delimiters for the key's, locator's or prefix's text, so its `[` is escaped: plain `[@smith2020, p. ` before a bold `2` and a plain `]` comes back as `\[@smith2020, p. **2**]`. Text with a key right after its `[` and no `]`, before a citation or a footnote reference, has its `[` escaped too, as export would read from it to the citation's or reference's `]` and take that for its key: Word's `see [@a ` before a Zotero citation comes back as `see \[@a [@smith2020]`.

Citations reference entries in a companion `.bib` file (see [BibTeX Companion File](#bibtex-companion-file) below).

### Bibliography Placement

DOCX export puts the bibliography at the end of the document, followed by a note for each cited key the `.bib` file lacks, as `Citation data for @key was not found in the bibliography file.` A `<!-- references -->` comment in a paragraph of its own, or `<!-- bibliography -->`, puts them there instead. Only the first marker counts.

```markdown
Main text [@smith2020].

<!-- references -->

## Appendix
```

In Word, the marker is the bibliography's `ZOTERO_BIBL` field. When there are no entries to list, as without a `.bib` file or when it has none of the cited keys, the field is empty, in a hidden paragraph that takes no space, so Word shows nothing at the marker. DOCX import writes the field back as `<!-- references -->`, before the notes, which export drops and writes again from the citations. Right after a fence, as `<!-- /landscape -->` or `<!-- landscape -->`, or a comment of its own, the marker comes back on the next line, or after the blank lines it had, as it was. A marker at the end of the document, where the bibliography goes anyway, gets no empty field, and import leaves out a marker there. That includes a marker that only footnote or endnote definitions follow, as they come after the body in Markdown but in their own part in Word. Word has the bibliography at the end of the body either way, so a marker put right before the notes on purpose comes back without it, and the next round trip changes nothing. A marker between two orientation sections, as after `<!-- /landscape -->` and before `<!-- landscape -->`, puts the bibliography on a page of its own between them, in the document's orientation, as other content there goes. Where there's nothing to list, that page would be blank, so the empty field goes at the start of the next section instead, and import puts the marker back before the section's opening fence. A marker right after `<!-- landscape -->` puts the bibliography at the start of that landscape section.

### BibTeX Companion File

By default, citations reference a companion `.bib` file with the same base name as the Markdown file (e.g., `paper.md` uses `paper.bib`). You can override this by specifying a `bibliography` field in the YAML frontmatter:

```yaml
---
bibliography: shared/references.bib
---
```

The `.bib` extension is optional (`bibliography: shared/references` also works). Relative paths resolve from the `.md` file directory first, then the workspace root. Paths starting with `/` resolve from the workspace root first, then as absolute OS paths.

Each entry contains standard BibTeX fields:

- `author`, `title`, `journal`/`booktitle`, `year`, `volume`, `number`, `pages`
- `doi`, `url`, `publisher`, `edition`, `abstract`

A field's whitespace reads as BibTeX reads it: each run of spaces, tabs and line ends is one space, with none at either end, so a value wrapped across lines reads as one line. A `note` keeps its line ends, as Zotero keeps its Extra field there, which citeproc reads a line at a time (`original-date: 1850`). `doi`, `url`, `isbn`, `issn` and `file` stay as written.

When exported from Zotero via DOCX import, entries also include identity fields for roundtrip reconstruction:

- `zotero-key` — the Zotero item key
- `zotero-uri` — the Zotero item URI

These fields allow the Markdown-to-DOCX exporter to reconstruct Zotero field codes in the output document. See [Zotero Citation Roundtrip](zotero-roundtrip.md) for details.

## Footnotes

Manuscript Markdown uses [Pandoc footnote syntax](https://pandoc.org/MANUAL.html#footnotes):

- **Reference** (inline): `[^1]` or `[^my-note]` (named labels supported)
- **Definition** (block, at end of document): `[^1]: Footnote text.`
- **Multi-paragraph**: continuation lines indented 4 spaces. Blank lines before one don't end the note, however many there are, as in Pandoc

```markdown
This has a footnote[^1] and a named one[^my-note].

[^1]: This is a simple footnote.

[^my-note]: This is a named footnote.

    Second paragraph of the named footnote.
```

In Word, a note's text follows its mark and a space, as Word writes a note. Import takes off the space or tab right after the mark, and no other whitespace the note's text starts with, so a note that starts with spaces keeps them, as `[^1]: &#32;&#32;a`. It takes it off in the range of a comment that goes on over the note's text, as a comment Word puts on the whole note, mark and all, which then starts at the text, and after a comment on the mark alone, which comes before the text: `[^1]: {>>c<<}a`.

A note holds paragraphs, display equations, tables and code blocks. Export warns of each block a note can't hold: a list, quote or heading exports as the note's paragraphs, a horizontal rule or empty code block is dropped, and an orientation directive is ignored, as a note has no sections. An alert's text goes without its marker, and an empty list item, heading or alert is no paragraph.

The `notes` frontmatter field controls whether footnotes or endnotes are generated in the DOCX output. Default is `footnotes`. Only `endnotes` needs to be specified explicitly:

```yaml
---
notes: endnotes
---
```

On DOCX import, the `notes` field is auto-detected from whether `word/footnotes.xml` or `word/endnotes.xml` exists. It is only emitted in frontmatter when endnotes are detected (since footnotes is the default).

Named labels (e.g., `[^my-note]`) are preserved through DOCX round-trips via a `MANUSCRIPT_FOOTNOTE_IDS` mapping stored in `docProps/custom.xml`.

DOCX import writes the notes in the order of their labels, numbered labels by value and then named ones, whatever order they were defined in. Labels of one number, as `1a` and `1b`, keep the order of their references. A table in a note keeps its own settings, as its font size, either way. A note can refer to another, as `[^1]: See also[^2].` Word has no note in a note, so where the text refers to that note too, export writes the reference in the note as a cross-reference to it, which Word shows as the note's number, and otherwise as a note reference in the note, which Word's own editing doesn't make. Import reads both as the reference, and writes a note only other notes refer to after the notes the text refers to, in the order the notes before it reach it. Each note's tables and code blocks keep their settings and languages whatever turn import writes the note in, as where Word hides the text's references to a note another note shows, which then goes after the others.

A reference inside a highlight, `==as reported.[^1]==`, keeps its note too, and comes back from Word inside the highlight. See [Markdown in a highlight](#markdown-in-a-highlight).

A reference can sit inside a tracked change. `{++as reported.[^1]++}` exports as a note inserted with its text, and `{--as reported.[^1]--}` as one deleted with it. When a label has more than one reference, Word's note belongs to one of them and the others cross-reference it. A reference outside any tracked change gets the note when there is one, so accepting or rejecting a change never takes the note from a reference that stays. On DOCX import, a cross-reference stands for the number Word shows for it: one whose number Word tracked as an insertion or a deletion comes back in that change, as `{++[^1]++}`, and one whose number is hidden, which Word shows nothing of, is left out. A number Word updated with tracking on, the old one deleted and the new one inserted, is the same reference, and comes back as it was.

## LaTeX Equations

Manuscript Markdown supports LaTeX math notation, which is converted to and from Word's OMML equation format during roundtrip conversion.

- **Inline math**: `$...$` — renders within the text flow
- **Display math**: `$$...$$` — renders as a centered block equation
- **Bare environments**: `\begin{align}...\end{align}` — treated as `$$\begin{align}...\end{align}$$`

Bare environments are recognized for all supported amsmath display-math environments (`equation`, `align`, `gather`, `cases`, matrices, etc.). On round-trip through DOCX, bare environments are converted to the `$$`-wrapped form.

Supported LaTeX elements include fractions, roots, Greek letters, operators, matrices, accents, subscripts, superscripts, delimiters, and amsmath environments. See [LaTeX Equations](latex-equations.md) for the full syntax reference and [DOCX Converter](converter.md#latex-equations) for converter details.

## Images

Image paths can contain spaces: `![alt text](my figures/some image.png)`. Angle brackets and percent-encoded spaces also work: `![alt text](<my figures/some image.png>)` and `![alt text](my%20figures/some%20image.png)`.

Manuscript Markdown supports two syntaxes for images with optional dimension attributes.

An image can be a link's text, or part of it, as in `[![alt text](image.png)](https://example.com)`. In Word it's a linked picture.

### Attribute Syntax

```markdown
![alt text](folder/image.png){width=640 height=480}
```

The curly-brace block after the image reference specifies dimensions. Bare numbers and `px` are pixels; absolute units `in`, `cm`, `mm`, `pt`, and `pc` are converted at 96 px per inch. Both `width` and `height` are optional — when only one is provided, the other is computed from the image's intrinsic aspect ratio. A brace escaped as `\{`, or written as `&#123;`, right after the image is text, not its block: `![alt text](image.png)\{x}`. DOCX import escapes one so after an image with no size.

### HTML Image Syntax

```html
<img src="folder/image.png" alt="alt text" width="640" height="480">
```

Standard HTML `<img>` tags are also supported, with `width` and `height` attributes using the same units as attribute syntax.

### Supported Formats

PNG, JPG/JPEG, GIF, and SVG.

### Image Folder

When converting from DOCX, extracted images are saved to a folder named after the Markdown file's basename. For example, `paper.docx` produces `paper.md` with images in `paper/`.

## CriticMarkup

Five annotation operations for tracking changes. See [CriticMarkup Syntax](criticmarkup.md) for details.

- Addition: `{++text++}`
- Deletion: `{--text--}`
- Substitution: `{~~old~>new~~}`
- Comment: `{>>text<<}`
- Highlight: `{==text==}`

> [!NOTE]
> We use CriticMarkup's `{==text==}` highlight syntax to denote text associated with a comment. To colorize text without commenting on it, see [color highlights](#color-highlights) below.

## Manuscript Extensions

Manuscript Markdown extends CriticMarkup with colored highlights, comment attribution, and overlapping comments.

### Color Highlights

Standard Markdown highlight syntax with an optional color suffix:

```markdown
==highlighted text==          (default color)
==highlighted text=={red}     (red highlight)
==highlighted text=={blue}    (blue highlight)
```

#### Available Colors

14 colors matching the MS Word highlight palette:

| Color | Syntax |
|-------|--------|
| Yellow (default) | `==text==` or `==text=={yellow}` |
| Green | `==text=={green}` |
| Turquoise | `==text=={turquoise}` |
| Pink | `==text=={pink}` |
| Blue | `==text=={blue}` |
| Red | `==text=={red}` |
| Dark Blue | `==text=={dark-blue}` |
| Teal | `==text=={teal}` |
| Violet | `==text=={violet}` |
| Dark Red | `==text=={dark-red}` |
| Dark Yellow | `==text=={dark-yellow}` |
| Gray 50% | `==text=={gray-50}` |
| Gray 25% | `==text=={gray-25}` |
| Black | `==text=={black}` |

#### Distinction from CriticMarkup Highlights

- `{==text==}` is a **CriticMarkup highlight** (rendered with grey background) — denotes a commented-on region
- `==text==` is a **format highlight** (rendered with the configured default color) — denotes colored text
- The `{color}` suffix is unambiguous because CriticMarkup uses `{` *before* `==`, not after

#### Markdown in a highlight

A highlight's content is Markdown. Emphasis, code, equations, citations and footnote references inside `==...==` export to Word as they do elsewhere. The highlight covers code, a citation and a footnote reference mark, but not an equation.

On DOCX import, highlighted code, citations and footnote references come back inside the highlight, with any equations between them: `==see [@smith2020]==`, `==as reported.[^1]==`, `==a $x$ b==`, also inside a tracked change, `{++==as reported.[^1]==++}`. Where one span of the change can't hold them, as with code holding the change's closer, which puts the span on one side of a substitution, and a struck `}` or a `~>`, which that side can't hold, they come back in highlights of their own, each in a span that holds it: ``{--~~==\}==~~--}{~~==`a --}`[^1]==~>~~}``. Emphasis comes back inside the highlight too, `==a *b* c==`, but a tracked change comes back in a highlight of its own: `==a *b* {++c++}==` comes back as `==a *b* =={++==c==++}`. Highlighted code with `==` in it, which would close the highlight even in code, comes back in spans highlighted apart, split between the two `=`, each with its color named, yellow too: ``==`x =`=={yellow}==`=`=={yellow}``. Export writes a run for each span, formatted alike, which Word shows as one. A highlight keeps the spaces and line breaks at its edges, which Word highlights: `==a ==b`, and `==a\` + newline + `==b`. At the end of a paragraph, where `==` alone on the last line would read as a heading's underline, the line break before it is `<br>`: `==a<br>==`. It keeps them next to an `=` or another highlight too, where import writes no `===`, which the editor reads as no highlight. An `=` right before a highlight comes back as a character reference, `a&#61;== b==`, and so does one that ends its text, `==[^1]a&#61;==`. A highlight of the default color right before another, as of code or another color, comes back with its color, `==a =={yellow}==b=={red}`. Text right after a highlight that its `==` would take, a `}`, an `=` or a color such as `{red}`, is escaped: `==b==\=c`.

#### Nesting with CriticMarkup

Format highlights and CriticMarkup can nest in both directions:

**Format highlight inside a critic highlight** — a highlighted word within a commented-on sentence:

```markdown
{==sentence with ==highlighted== word==}{>>comment<<}
```

**Critic highlight inside a format highlight** — a commented phrase within highlighted text:

```markdown
==text with {==commented==}{>>comment<<} word.==
```

**Other CriticMarkup inside a format highlight** — additions, deletions, comments, and substitutions can appear within `==...==`:

```markdown
==text {++added++} more==
==text {>>note<<} more==
```

**Highlight spanning a comment boundary (ID-based syntax)** — when a highlight starts before and ends within a commented-on region, the converter produces separate `==...==` regions on each side of the `{#id}` boundary:

```markdown
==before =={#1}==overlap== after{/1}
```

#### Configuration

The default highlight color can be configured via VS Code settings:

```json
{
  "manuscriptMarkdown.defaultHighlightColor": "yellow"
}
```

Unrecognized color values fall back to the configured default.

### Comment Attribution

Comments can include author name and timestamp:

```markdown
{>>@alice (2024-01-15 14:30) | This needs revision<<}
```

A blank line in a comment's text separates two of the Word comment's paragraphs, and a single line's end is a line break. In a quote, each of the comment's lines after the first starts with the quote's `>`. On DOCX import, a comment in a table cell whose text has more than one line takes [ID syntax](#overlapping-comments), with its body below the table, because a pipe table's cell can't hold a line's end. So does a comment on an HTML comment outside a table, `{#1}<!-- a -->{/1}`, because `{==...==}` would show the HTML comment as text, and a line that starts with the comment and its body is an HTML block. Its range covers all of the HTML comment where Word started or ended it inside the comment's hidden text. In ID syntax the HTML comment is a paragraph, which a blank line keeps apart from text on the lines before and after it, even where its block had none. An HTML comment a paragraph can't hold, one with a blank line, a line of `***` or `---`, or a line that starts with `<!--`, stays an HTML block, with the Word comment after it, `{>>...<<}`, which the block shows as text. So does one in a paragraph that starts with another HTML comment out of the range, or that holds one a paragraph can't, as `<!-- b --->`, and so do the other HTML comments in that Word comment's range. A range whose comment the file has no body for, which Word shows nothing of, imports as its text alone, as `{==text==}` with no comment after it would be a highlight.

#### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `manuscriptMarkdown.includeAuthorNameInComments` | `true` | Include author name |
| `manuscriptMarkdown.authorName` | `""` | Override author name (empty = OS username) |
| `manuscriptMarkdown.includeTimestampInComments` | `true` | Include timestamp |

Timestamp format: `yyyy-mm-dd hh:mm` in local timezone.

### Overlapping Comments

Standard CriticMarkup comment syntax (`{==text==}{>>comment<<}`) does not support overlapping comment ranges. Manuscript Markdown adds ID-based comment syntax that allows comment ranges to overlap, nest, or share boundaries.

#### Syntax

##### Range Markers

- **Range start**: `{#id}` — marks where the comment's highlighted range begins
- **Range end**: `{/id}` — marks where the highlighted range ends

##### Comment Body with ID

`{#id>>comment text<<}`

The `#id` appears between `{` and `>>`, extending the existing comment syntax. Author attribution uses `@Author (Date) | text` format — see [Comment Attribution](#comment-attribution).

A body can go on the lines after its paragraph, in a paragraph of its own, or at either end of a line. It adds no text to Word: the line ends and spaces around it, and a paragraph that holds only bodies, don't export. A line break written as one, a `\` or a `<br>`, does, as at the end of a range before its body, `{#1}a<br>{/1}{#1>>note<<}`, though a line end in `breaks` mode or a grid table's cell doesn't. On DOCX import, bodies go on the lines after their paragraph, in a note's too, inside its quote if it has one, or after a blank line below a table. An HTML table's cells don't take comment syntax (see [HTML Tables](#html-tables)).

#### Examples

##### Nested Overlapping comments

```markdown
This is the first sentence of a {#1}paragraph. {#2}This is the second
sentence of a paragraph.{/2}{/1}

{#1>>@alice (2024-01-15 14:30) | This is comment 1.<<}
{#2>>@bob (2024-01-15 14:31) | This is comment 2.<<}
```

Comment 1 covers "paragraph. This is the second sentence of a paragraph." while comment 2 covers only "This is the second sentence of a paragraph." — their ranges overlap.

Non-numeric identifiers also work:

```markdown
{#outer}The entire {#inner}important{/inner} sentence.{/outer}

{#outer>>@alice | General note<<}
{#inner>>@bob | Key word<<}
```

##### Non-overlapping with IDs

When `alwaysUseCommentIds` is enabled, even non-overlapping comments use ID syntax:

```markdown
{#1}highlighted text{/1}{#1>>@alice | note<<}
```

##### Non-nested overlapping comments

Overlapping comments need not be nested. E.g., comment 1 can begin before, and end inside of, comment 2:

```markdown
This is the first sentence of a {#1}paragraph. {#2}This is the{/1} second
sentence of a paragraph.{/2}
```

In this example, comment 1 refers to `paragraph. This is the`.

On DOCX import, ranges that end at the same place end in the order they start, as `{#1}a {#2}b{/1}{/2}`, whatever IDs Word gave the comments, which keeps them the same through the next round trip.

An ID can have more than one range. DOCX import writes a comment that goes from a paragraph into a table so, with a range in each paragraph and each cell, as `{#1}Before.{/1}` and `| {#1}a{/1} | b |`, since a cell can't hold a range that goes on past it. Word takes one range for each comment, so export writes one, from the ID's first start to its last end.

#### ID Format

IDs use `[a-zA-Z0-9_-]+` — alphanumeric characters, hyphens, and underscores. No spaces. The DOCX-to-Markdown converter generates numeric IDs; users may write descriptive IDs like `intro-note`.

#### Backward Compatibility

`{==text==}{>>comment<<}` continues to work unchanged. The new syntax is only required when comment ranges overlap. By default, the converter uses the traditional syntax for non-overlapping comments and switches to ID-based syntax only when overlapping is detected.

#### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `manuscriptMarkdown.alwaysUseCommentIds` | `false` | Always use ID-based comment syntax (`{#id}...{/id}{#id>>...<<}`) even for non-overlapping comments |

CLI flag: `--always-use-comment-ids`

## Known Limitations

### List Item Block Content

The Markdown-to-DOCX converter preserves the first paragraph, nested sublists, blockquote continuation blocks, and HTML blocks within a list item. A comment alone in its block is hidden in Word, as one at the top level is. So is a block that starts and ends with a comment, as `<!-- c --><div>a</div><!-- d -->`, whole, with what's between its comments, as at the top level. A block that starts with a comment and goes on, as `<!-- c --><div>a</div>`, exports as text, as at the top level, and imports as it was. Other block-level content in list continuation — such as fenced code blocks, indented code blocks, horizontal rules, and tables, whether in Markdown or HTML — is still dropped during conversion and will not survive a round-trip. So is a comment after the item's text that reads as a directive, as `<!-- landscape -->`, which a list item can't hold. A heading in a list item keeps its text as a paragraph but loses its level. Each of these gives a warning. So does a `<pre>`, `<script>`, `<style>`, or `<textarea>` block, or a comment, with a blank line in it, which ends the block inside a list item and is dropped.

The converter emits a warning when block content inside a list item is dropped.

To preserve such content through DOCX round-trip, move it outside the list:

````markdown
1. First item
2. Second item

```python
# Now outside the list — survives round-trip
print("hello")
```

3. Third item
````

### Blockquote Block Content

The Markdown-to-DOCX converter doesn't carry a list, heading, code block, table or horizontal rule inside a quote. It exports a list, heading or code block there as the quote's paragraphs, which keep its text but not its markers, a code block's lines as lines of one paragraph, and drops a table, a horizontal rule or an empty code block. It emits a warning for each. A grid table's lines in a quote aren't a table, in the preview or in Word, but the quote's text.

To keep one through a round-trip, end the quote before it and start another after.
