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
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`) or absolute path to a `.csl` file. Controls citation and bibliography formatting. Non-bundled styles are downloaded automatically by the converter on first use. |
| `locale` | Locale override for citation formatting (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `zotero-notes` | Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. Legacy alias: `note-type`. |
| `notes` | Controls footnote/endnote OOXML generation: `footnotes` (default) or `endnotes`. See [Footnotes](#footnotes). |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`). Auto-generated on DOCX import for idempotent date roundtripping. |
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
| `blockquote-style` | Word paragraph style for blockquotes: `Quote`, `IntenseQuote`, or `GitHub` (gray left border bar). Case-insensitive. Default: `GitHub`. Overrides the VS Code setting. |
| `callout-labels` | Whether alert callouts show their type label (for example, **Note** or **Warning**) in preview and DOCX output. Accepts only `true` or `false`. Default: `true`. When `false`, the label row is hidden while the callout body, type, colors, border, and other styling are preserved. |
| `colors` | Named color scheme for alert callouts: `github` or `guttmacher`. |
| `pipe-table-max-line-width` | Maximum line width for pipe tables in DOCX→MD conversion. Tables wider than this fall back to HTML. `0` disables pipe tables entirely. Default: `120`. Overrides the VS Code `pipeTableMaxLineWidth` setting but is itself overridden by the CLI `--pipe-table-max-line-width` flag. |
| `grid-table-max-line-width` | Maximum source line width for grid tables. Tables wider than this fall back to HTML. Default: inherited from `pipe-table-max-line-width`. |
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

Per-table directives override frontmatter defaults for that table only. For pipe and grid tables, place an HTML comment before the table (`<!-- table-font-size: 9 -->`). For HTML tables, use `data-` attributes on the `<table>` element (`data-font-size="9"`). Multiple directives can precede the same table.

Priority (highest to lowest): per-table override → frontmatter default → built-in default.

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

Per-table overrides and frontmatter defaults are preserved through DOCX round-trips.

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

- Orientation sections produce OOXML section breaks. The page size is derived from the template document if available, defaulting to US Letter.
- Sections are preserved through DOCX round-trips.
- **Nested fences**: An opening fence inside an already-open block of the same type is treated as a close followed by an open (a section break) and produces a warning.
- **Consecutive fences**: Transitions between orientation sections (or consecutive sections of the same type) do not produce blank intermediate pages. For example, `<!-- /landscape --><!-- portrait -->` transitions directly without an empty page in between.

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

Custom styles are preserved through DOCX round-trips. On export, each style is created as a Word paragraph style (basedOn Normal) with a `MsCustomXxx` style ID. The style definitions are stored in the `MANUSCRIPT_CUSTOM_STYLES` custom property in `docProps/custom.xml`. On import, the custom property is read back and the style definitions are emitted in the frontmatter `styles` block, with `<!-- style: name -->` / `<!-- /style -->` directives re-emitted around the styled paragraphs.

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

```yaml
---
bibliography-hanging-indent: false
---
```

All three settings are preserved through DOCX round-trips via custom properties in `docProps/custom.xml`.

## Standard Markdown

Manuscript Markdown supports CommonMark plus the implemented [GitHub Flavored Markdown](https://github.github.com/gfm/) extension set.

- **Formatting**: bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`), underline (`<u>text</u>`), superscript (`<sup>text</sup>`), subscript (`<sub>text</sub>`), inline code (`` `code` ``)
- **Headings**: `# H1` through `###### H6`
- **Lists**: bulleted (`- item`), numbered (`1. item`), task lists (`- [ ] item`, `- [x] item`). Blockquote continuation blocks inside list items are preserved; see [List item limitations](#list-item-block-content) for the remaining unsupported block content.
- **Links**: `[text](url)` plus autolink literals (bare URLs/emails)
- **Code blocks**: fenced with triple backticks. Optional language annotation (e.g., `` ```stata ``) is preserved on round-trip via the `MANUSCRIPT_CODE_BLOCK_LANGS` custom property in the DOCX. In Word, code blocks use the "Code Block" paragraph style (Consolas, shaded background). Consecutive code blocks are separated by an empty paragraph to prevent merging.
- **Blockquotes**: `> quoted text`
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

**DOCX→MD**: When converting from Word, line breaks (`<w:br/>`) are always emitted as `\` + newline in the Markdown output, making the hard break intent explicit.

### GitHub Flavored Markdown Extension Notes

- **Autolink literals** are enabled in parser and preview (for example, `https://example.com` is linkified without explicit `[]()` markup).
- **Strikethrough** uses standard GitHub `~~text~~` behavior.
- **Task list items** are parsed semantically as checkbox list items, not only plain text prefixes.
- **Disallowed raw HTML** follows the GitHub extension set (`title`, `textarea`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `script`, `plaintext`) and is treated as literal text in preview/conversion paths.
- **Intentional HTML exceptions**: HTML comments (`<!-- ... -->`) and supported inline HTML formatting tags used by this project (for example `<u>`, `<sup>`, `<sub>`) remain supported.
- **Alerts** use GitHub's blockquote-based syntax with `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]` markers on the first line. Alert content follows on subsequent `>` lines. Alerts are displayed with colored left borders and type-specific header icons in preview and are preserved through DOCX round-trip. Type labels are shown by default; set `callout-labels: false` in frontmatter to hide the label row in both preview and DOCX output without removing the callout's body, type, colors, border, or other styling. An explicit `true` or `false` value round-trips through DOCX via the `MANUSCRIPT_CALLOUT_LABELS` custom property.

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

Pipe tables support column alignment via `:` in the separator row but do not support multi-line cells, colspan, or rowspan. Tables support per-table font and column-width overrides via comment directives (`<!-- table-font-size: N -->`) and HTML data attributes (`data-font-size`, `data-font`); see [Table Font Configuration](#table-font-configuration).

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

- Column boundaries are defined by `+` positions in the separator line
- The `=` separator distinguishes header rows from body rows
- Multiple content lines between separators form a single logical row with multi-line cells
- Grid tables do not support colspan or rowspan (use HTML tables for spans)
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

Per-table overrides use `data-` attributes directly on the `<table>` element (`data-font-size`, `data-font`, `data-col-widths`, `data-orientation`):

```html
<table data-font-size="9" data-col-widths="2,1,1">
  <tr><th>Wide Column</th><th>A</th><th>B</th></tr>
  <tr><td>data</td><td>1</td><td>2</td></tr>
</table>
```

### Format Selection on DOCX→MD Conversion

When converting from DOCX to Markdown, the converter selects the simplest format that preserves the table's content:

1. **Pipe table** — used when all cells are single-line and the table fits within the configured line width
2. **Grid table** — used when the original table was grid format and cells require multi-line content
3. **HTML table** — fallback for tables with colspan, rowspan, multi-paragraph cells, or that exceed the configured line width

### Embedded Tables

Tables can also be embedded from external `.csv`, `.tsv`, `.xlsx`, and `.md` files using the `<!-- embed: -->` directive. Embedded tables support the same formatting directives as inline tables and are expanded into full tables on Word export. See [Embedded Tables](embedded-tables.md) for syntax, parameters, and examples.

## Citations

Manuscript Markdown uses [Pandoc citation syntax](https://pandoc.org/MANUAL.html#citations) with BibTeX keys:

- Single citation: `[@smith2020]`
- With locator: `[@smith2020, p. 20]`
- Multiple citations: `[@smith2020; @jones2021]`
- Suppress author: `[-@smith2020]`

Citations reference entries in a companion `.bib` file (see [BibTeX Companion File](#bibtex-companion-file) below).

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

When exported from Zotero via DOCX import, entries also include identity fields for roundtrip reconstruction:

- `zotero-key` — the Zotero item key
- `zotero-uri` — the Zotero item URI

These fields allow the Markdown-to-DOCX exporter to reconstruct Zotero field codes in the output document. See [Zotero Citation Roundtrip](zotero-roundtrip.md) for details.

## Footnotes

Manuscript Markdown uses [Pandoc footnote syntax](https://pandoc.org/MANUAL.html#footnotes):

- **Reference** (inline): `[^1]` or `[^my-note]` (named labels supported)
- **Definition** (block, at end of document): `[^1]: Footnote text.`
- **Multi-paragraph**: continuation lines indented 4 spaces

```markdown
This has a footnote[^1] and a named one[^my-note].

[^1]: This is a simple footnote.

[^my-note]: This is a named footnote.

    Second paragraph of the named footnote.
```

The `notes` frontmatter field controls whether footnotes or endnotes are generated in the DOCX output. Default is `footnotes`. Only `endnotes` needs to be specified explicitly:

```yaml
---
notes: endnotes
---
```

On DOCX import, the `notes` field is auto-detected from whether `word/footnotes.xml` or `word/endnotes.xml` exists. It is only emitted in frontmatter when endnotes are detected (since footnotes is the default).

Named labels (e.g., `[^my-note]`) are preserved through DOCX round-trips via a `MANUSCRIPT_FOOTNOTE_IDS` mapping stored in `docProps/custom.xml`.

## LaTeX Equations

Manuscript Markdown supports LaTeX math notation, which is converted to and from Word's OMML equation format during roundtrip conversion.

- **Inline math**: `$...$` — renders within the text flow
- **Display math**: `$$...$$` — renders as a centered block equation
- **Bare environments**: `\begin{align}...\end{align}` — treated as `$$\begin{align}...\end{align}$$`

Bare environments are recognized for all supported amsmath display-math environments (`equation`, `align`, `gather`, `cases`, matrices, etc.). On round-trip through DOCX, bare environments are converted to the `$$`-wrapped form.

Supported LaTeX elements include fractions, roots, Greek letters, operators, matrices, accents, subscripts, superscripts, delimiters, and amsmath environments. See [LaTeX Equations](latex-equations.md) for the full syntax reference and [DOCX Converter](converter.md#latex-equations) for converter details.

## Images

Manuscript Markdown supports two syntaxes for images with optional dimension attributes.

### Attribute Syntax

```markdown
![alt text](folder/image.png){width=640 height=480}
```

The curly-brace block after the image reference specifies dimensions. Bare numbers and `px` are pixels; absolute units `in`, `cm`, `mm`, `pt`, and `pc` are converted at 96 px per inch. Both `width` and `height` are optional — when only one is provided, the other is computed from the image's intrinsic aspect ratio.

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

The Markdown-to-DOCX converter preserves the first paragraph, nested sublists, and blockquote continuation blocks within a list item. Other block-level content in list continuation — such as fenced code blocks, indented code blocks, HTML blocks, and tables — is still dropped during conversion and will not survive a round-trip.

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
