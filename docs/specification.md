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

Import writes a line break in a Word title paragraph the same way, each line of the paragraph in a `title` entry of its own, which export writes as a Title paragraph. So does a page or column break between the paragraph's text. It writes no entry for a break at the paragraph's start or end, or for the spaces beside one.

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
| `font` | Body font family for non-code styles. No default (uses rendering application's default). Export gives it to the body's styles, quotes, alerts and notes among them. On import, it's given only where export with the document as its template would leave the fonts each style shows Latin text in as they were, for ASCII text and for the rest, as accented letters (`w:ascii` and `w:hAnsi`). So a document whose quotes or notes show a font of their own, or whose accented letters are in another font, reads back without it, and export with the document as its template keeps their fonts. The title, tables and custom styles then get the font they show from Normal as their own `title-font`, `table-font` or style `font`, as export without a template gives them Calibri without one, a custom style the document records without a font (`MANUSCRIPT_CUSTOM_STYLES`) too, and the same goes for the headings' `header-font`. What the other font keys change doesn't count: `font` is left out only where export with it gives some style other fonts than export without it. A recorded custom style without a font gets the font it shows as its own unless import gives that font as `font`: where import gives another, as a theme font's typeface beside the font named in Normal, which the style names, and where it gives none. |
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
| `header-font` | Heading font family. Accepts a single value or a comma-separated list for per-level control (H1–H6). Falls back to `font` if not set. With a template, export sets a font as a style's `w:ascii` and `w:hAnsi`, in place of a theme font there, and keeps what the style names for other scripts, as `w:eastAsia`, for this and the other font keys. |
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

On import, `header-font-style` and `title-font-style` give the font style each heading and title style shows in Word, including what a style inherits from the style it's based on, or else from the document defaults, where it doesn't set bold, italic, underline, caps or alignment itself. A style that turns on small caps and inherits all caps, or the reverse, reads as `allcaps`. Export also writes each title's font style on its runs and its centering on its paragraph, which Word shows over the Title style's, so `title-font-style` gives each title what it sets itself first: a toggle all its runs set alike, and the alignment of its paragraph. On export with a template, a heading or title style keeps its own explicit off, such as `<w:i w:val="0"/>` or a `<w:jc>` that doesn't center, for what its font style leaves out. Where it has none, and its font style leaves out something the style it's based on, or the document defaults, turn on, it gets that property turned off explicitly, so Word shows the font style the frontmatter gives. Export finds the style it's based on as import does: by the template's ID for a built-in style, as `berschrift1` for Heading 1 in a template from German Word, or by an ID that differs only in case, and with a style written as `<w:style .../>`, which has no content, as its tag alone.

Likewise, `header-font`, `header-font-size`, `title-font` and `title-font-size` give the font and size each heading and title style shows in Word, inherited the same way where the style doesn't set them, and Word's 10pt where nothing does. A size appears only where some heading, or the title, shows one other than export would give it without that key: its default, scaled by `font-size` if there is one. A theme font alone adds no `font`, `header-font` or `title-font`, so a document in Word's own theme fonts reads back without them. A font named beside a theme font, as an older Word writes it, reads as the theme font's typeface, which Word shows, for `font` and `code-font` as for a heading. Export gives `code-font` to inline code too, so where that typeface isn't the font named, Code Block's theme font gives `code-font` only where Code Char shows it as well. `table-font` gives the font tables show, as `title-font` does the title's: one named in the Table Paragraph style or the styles it's based on, and with a `font`, which export gives tables without a `table-font`, a theme font too, by its typeface. Where some heading has a named font, or there is a `font`, which export gives a heading or the title without one, `header-font` and `title-font` give the font each shows: a theme font by its typeface in the document's theme, the part its relationship names, and a heading with no font at all the one export gives a heading without one, `font` or else Calibri, so the headings keep their places. A font key sets a style's font for ASCII text and for the rest of Latin text alike (`w:ascii` and `w:hAnsi`), so where a heading, the title, Table Paragraph or Code Block shows the two in different fonts, as in two theme fonts, import gives no `header-font`, `title-font`, `table-font` or `code-font`, and export with the document as its template keeps both.

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

A table's font is for its text, not its inline code, which shows in the code font (`code-font`, or Consolas) in a table as it does outside one, whatever the table's font, its own or the document's. The table's size is for its inline code too.

Per-table overrides are preserved through DOCX round-trips: comment directives and data attributes are re-emitted on conversion back to Markdown. A table's size is the one Word shows: where Word sets a size on all of a table's text, as when the table is selected and resized, import writes it as the table's `table-font-size` directive or `data-font-size`, whether or not it had one, the document's size for tables too, which Word's setting keeps if the document's changes. Text in the table paragraph style with no size of its own takes that style's size, or its base's, and where that's the document's size for tables, the one the frontmatter import writes gives a table, its `table-font-size` or else two points under its `font-size`, the table has no directive, unless its directive was for that size, but where any of the text has that size of its own, the table has it as its own too. Import changes or drops a table's directive only where it can tell the size Word shows all of the table's text in: it applies the styles in the order Word does, each over the last: the document's defaults, the default paragraph style where a paragraph has no style of its own, the table's style, the paragraph's style, the run's character style, and the run's own properties, so in a paragraph with no style of its own, a table style that marks a run right-to-left goes over a mark in Normal, though not in one of the table paragraph style, which takes Normal's mark through its base. It follows each style's base, matches a style's ID whatever its case, reads a style with no `w:type` as a paragraph style, which can be the default one, takes nothing from `DefaultParagraphFont`, `TableNormal` or `NoList`, whose properties and base Word ignores, and takes the complex script size of a run that it or its style marks right-to-left or complex script, and the size for the rest of any other, as Word does whatever the run's characters, so Arabic or Hebrew that nothing marks shows in the size for the rest. A table whose text takes its size from another paragraph or character style, or from the table's style, or that a style hides, keeps the size it had, as the style may be what gives it that size. A style hides text where it turns its hidden property on, not where it turns it off, as `<w:vanish w:val="0"/>`. Each size is read as Word reads it: as a number of half-points, so `14`, `014`, `+14` and ` 14 ` are one size, 7 points, or as a measure in points, as `7pt`, rounded down to a half-point, so `7.4pt` is 7 points too. Word ignores a size in inches, centimeters or millimeters, and isn't known to read one in picas, so import reads none of them, and the table keeps the size it had. Where Word shows more than one size in a table, which Markdown has no setting for, the table keeps the size it had: its symbols, tabs, hyphens, line breaks and notes' reference marks count, but not a picture, which Word shows in no size, nor a field's code, a comment's reference or a bookmark, which show nothing. An embedded table's directive, before its embed directive, is read the same way, from the embed's first table where it has more than one, as export gives the directive to that table only. A table keeps the size it had, too, where it has anything import doesn't read all of. Import reads a table's rows, cells and paragraphs, and the runs in a paragraph, a link, a tracked change, a content control, a smart tag, a simple field or a custom XML element. A table with anything else keeps its size: an equation, whose parts, as a radical or a delimiter, show in sizes of their own; a table in a cell, whose text takes its own table's style; a phonetic guide; alternate content, of which Word shows one choice; a text box; or an element import doesn't know. So it goes for a table's font, as its `table-font` directive or `data-font`: the one Word sets on all of its text, by its name, as `Arial`, each character in the font Word picks for it from a run's: its complex script font for all of a run that it or its style marks right-to-left or complex script, or else the one Word gives the character's range of Unicode, by the table in [MS-OI29500](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/aef3c9a6-5d6c-434b-90b7-85e761fd8e62): its ASCII font for ASCII and for Hebrew and Arabic, its East Asian font for East Asian text, as Chinese, Japanese and Korean and their punctuation and forms, and its font for the rest otherwise, as for Latin letters, Greek or Thai, but its East Asian font for some of those, as Greek, Cyrillic, symbols and punctuation, where the run's hint is East Asian, and its ASCII font for East Asian text too where the East Asian one is Times New Roman and its ASCII font and its font for the rest are one. Text in the table paragraph style with no font of its own takes that style's, or its base's, and where that's the document's font for tables, the one the frontmatter import writes gives a table, its `table-font` or else its `font`, or else Calibri, export's default, which import writes no `font` for, for ASCII and the rest, the table has no directive, unless its directive was for that font, but where any of the text has that font of its own, or shows in the style's East Asian or complex script font, as Greek in a run whose hint is East Asian or Hebrew in runs marked right-to-left, which the frontmatter has no font for, the table has it as its own too. The table keeps the font it had where Word shows more than one, as one for its ASCII characters and another for the rest, or a theme's body or heading font, which Word sets by the theme, with no name to write, or a symbol's font of its own, and where its text takes its font from another paragraph or character style or from the table's style, or has a note's reference mark, whose characters may be in any of a run's fonts, unless they're all one, or some Latin letters with accents, as é or ā, in a run whose hint is East Asian, which Word shows in its font for the rest or its East Asian font by the run's language or the East Asian font's character set, unless they're one. Export sets a table's font only as the font for ASCII and the rest, and marks no run right-to-left or complex script and gives none a hint, so it shows East Asian text, as Chinese, Japanese or Korean, in the document's East Asian font, whatever the table's font: a table with any East Asian text keeps the font it had, whatever font Word shows it in, as a directive for that font wouldn't show the text in it. Text Word shows in its East Asian or complex script font only by its run's hint or marks, as that Greek or Hebrew, export shows in the table's font, so Word's font for it comes back. Its inline code doesn't count, as a table's font isn't for it: the table's font is the one Word shows the rest of its text in, whatever font Word shows the code in.

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

A table with set widths spans its column: the width of its section's text, between its margins and any binding gutter, or the narrowest of the template's columns, which each section takes, fitted to that text, or, in a footnote, one of the footnotes' own columns, where the template gives them some. Without set widths, the table's grid, which Word Online sizes it by, divides that same width, while Word itself sizes the table to its content.

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

- Orientation sections produce OOXML section breaks. The page size and margins are derived from the template document's own section properties if available, not a tracked change's old ones, defaulting to US Letter with one-inch margins. The page size and margins are read as Word reads them, the section's own and not an extension's that Word ignores, whatever prefix the template gives them, and the margins keep the declarations they use, with the namespaces the template makes ignorable ignorable on them, as an extension's attribute. The template's headers, footers and page number format continue through them, and the page numbers count on through them. Export reads the template's header and footer references, title page and page numbering as Word reads them, by their namespace, whatever prefix the template gives it, and with the declarations they use, also where markup compatibility's alternatives hold them, from the choice Word reads or else the fallback, or where an extension's wrapper that `mc:ProcessContent` names holds them. It reads them only from the sections Word reads: not from a section in a branch of markup compatibility's alternatives that Word doesn't read, or in an extension's element that Word ignores. Where a section's properties break Namespaces in XML where they are, as with a prefix that nothing binds, which makes Word refuse the template, export reads none of them. The document's last section keeps the template's own section properties as Word reads them, which Word writes when it saves: the choice or fallback Word reads in place of markup compatibility's alternatives, and a wrapper's content in place of the wrapper. Wherever export takes the template's section properties as Word reads them, a namespace that `mc:MustUnderstand` names among them and Word doesn't understand, which makes Word refuse to open the template, is left out of that list, so Word opens the document. It has each of the references, title page and page numbering once, as export gives it, among its properties in CT_SectPr's order. Each section also takes the template's own section properties, as Word gives a section it inserts those of the section it splits: margins, columns, line numbering, document grid, footnote and endnote settings, vertical alignment and the like, with the page turned to the section's orientation. Where markup compatibility's alternatives hold some of them, each section export adds, or whose page it turns, has in their place what Word reads of them: the first choice that needs only namespaces Word understands, or else the fallback, and so on for alternatives within those, or within a property, as a choice of columns within the columns. So does an extension's wrapper that `mc:ProcessContent` names, in an ignorable namespace Word doesn't understand: Word reads its content as its parent's, and so does export, in the wrapper's place. Each property taken out of them keeps the namespaces they declare, and those they make ignorable stay ignorable on it. Export knows each of the template's section properties, and markup compatibility's elements and attributes, by its namespace, whatever prefix the template gives it there. Each section, the last too, has them under export's prefixes, and a namespace the template binds to one of those has a prefix of its own. Where the template's columns of their own widths add up to more than a section's turned page has, they are scaled down to fit it, and where its columns would be narrower than half an inch, Word's narrowest, as equal ones spaced for a landscape page can be on an upright one, the section has one column. Export reads the template's page size, margins and columns in twips or in any unit OOXML allows for them, as `210mm` or `0.5in`, as import and Word read them: one in centimetres or millimetres to the nearest twip, one in another unit down to a whole twip, and a number with a plus sign as that number. A table's own section takes the template's columns too. Each break starts a new page, and only the first section has the template's headers, footers, title page and page number start, which the sections after it continue. A tracked change to the template's section properties, and its printer settings, stay with the last section.
- Sections are preserved through DOCX round-trips. DOCX import reads the last section's orientation from the body's own section properties, where Word keeps it, so a Word document that ends with a landscape section after another section gets fences around that section. A document of one section has its orientation as its page setup, as a template's, and gets no fences. Nor does a last section that export gave a landscape template's page, which no fence set, as a custom property records; a section after a break added in Word is still read as its page is. DOCX export writes a section that ends the document after another the same way, with no section break after its last paragraph, which would leave an empty last section, a blank last page, and with the template's page turned to the section's orientation where it isn't already. The last section after a fence or a table's own section, whether it ends in a fence or not, starts on a new page, as each section a break starts does, where the template's last section starts on the same page or on an odd or even one, in its own properties, in any of markup compatibility's alternatives among them, or in an extension's wrapper among them whose content Word reads, but not in an extension's element that Word ignores, which stays as it is. A document of one section keeps the template's. Where export changes the template's own last section this way, its break type, its page turned for a final fence, or its columns fitted to that page, a custom property records the template's own. An export that takes such a document as its template reads the template's own back, so its sections are laid out as the first export's were, unless that last section's page, columns or break type has changed since, as in Word, whether export changed it or not, whose layout it then takes as it is. They count as unchanged where they say what export wrote, in any order of attributes, under any prefix, in any unit, or by leaving out what says the default or giving it, as a break type of a new page, no line between columns, or no space after a column, or in what Word ignores of them, as the number of columns of their own widths, the space after the last of them, or the widths of columns of equal width.
- **Nested fences**: An opening fence inside an already-open block of the same type is treated as a close followed by an open (a section break) and produces a warning. DOCX import writes that close as a closing fence, with the blank lines the opening fence had before it, then the opening fence, and the blank lines the opening fence had after it go after each.
- **Unclosed fences**: An opening fence with no closing fence after it produces a warning, and its section runs to the end of the document. Export reads the document as if a closing fence ended it, after a blank line, so Word gets what it gets for that document: the section has its own orientation, not the template's, and the blocks it ends with are spaced as before such a fence. DOCX import writes the section back with that closing fence. Where the fence there would be part of the last block, as in code or an HTML comment with no end, or where the document has a `<!--` with no `-->` after it, even in code, which the fence's `-->` would end, the section ends after the last block.
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
| `font-style` | Same [font style values](#heading-and-title-font-configuration) as `header-font-style`. Since custom styles inherit from Normal, the default is already non-bold — `normal` is rarely needed here. A font style is the whole of the style's: where a template's Normal is bold, italic or centered, a custom style with a font style that leaves that out turns it off. Without a font style, a custom style shows what Normal does. |
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

All paragraphs between the opening and closing directives receive the named style. So do list items, under their numbering, and import writes them back in the block. A paragraph or quote in a list item keeps the style export gives it there, and comes back in the block with its item. A style block can go in a list item too, as `- a`, a blank line, then `  <!-- style: box -->`, `  styled` and `  <!-- /style -->`, indented as the item's text. Its paragraphs take the style with the item's indent, and import writes the fences back around them in the item. A quote or list in such a block keeps its own style, with a warning. Opened in an item that's in a style block at the top level, such a block closes that one, as a block that opens in another does, with the same warning, so the items after it take no style. So does a block that opens in an item before the block already open in that item closes, and the item's paragraphs after it take only the new block's style, and one that opens in an item of a sublist while a block is open in an item above it, whose paragraphs after the sublist then take no style. Word gets nothing for such a close, so it ends no list or quote there. A paragraph in an item in a custom style comes back in a block in the item, even in the style of a block the item is in, as export gives a paragraph in an item only the block in the item's style. Where the block at the top level closes so at an item of a sublist, import writes the close as a block in an item, as a closing fence at the top level would end the list there: before the sublist, in the item it's in, where the item is the sublist's first, or else at the end of the item before it at its level. Elsewhere, as where the block in the item has no paragraph in its style, as one of only a quote, import writes a closing fence at the top level after the item, where the block's paragraphs end. Before a paragraph or a list item, or before a heading, quote, code block, table or thematic break where the block has none of those between its paragraphs, that fence has a blank line on each side, and the fences after it keep the blank lines around their own. Before the sublist, the block goes on past it to the item's paragraph right after it, in that paragraph's style, and where there's none, or elsewhere, it's empty, of the closed block's style. A style block on one line, as `<!-- style: box -->styled<!-- /style -->`, can't go in a list item, and is dropped there with a warning, as a directive is. So are the fences of a style block in an item of a list in a quote, whose items are the quote's paragraphs, in its style, so such a block closes no block open around the quote. A style's name can't hold `-->`, which ends its comment. A heading, a quote, a code block, a table or a thematic break keeps its own style in a block at the top level, and export records how many of them a block starts and ends with, and whether it has them between its paragraphs, so import writes them back in the block, between its paragraphs or at its start or end, and those outside it outside. A block of only such blocks still loses its fences, as Word has no paragraph of it, as does an empty one. A quote right before or after such a fence comes back as many blank lines from the block on the fence's other side as the side of the fence with more had. The blocks after it keep the blank lines around their own fences, as do those after a block that a second fence of its style opens again, which import writes once. So do those after two blocks of a style with nothing between their paragraphs in Word, as a closing fence and an opening fence of the style, an empty block of another style, or a block in a list item of only a quote, which import reads as one block, with no fences between. At a section's fence in a block, as `<!-- landscape -->`, or the bibliography's place in one, import closes the block before it and opens it again before its next paragraph or list item after it, each such fence with a blank line on each side. A section's fence right after a block's opening fence, or right before its closing fence, comes back on the other side of it, as Word's section break comes before the block's first paragraph or after its last, and the blank lines before, between and after the two fences stay where they were, as at the document's start, where none go before the first. So does the bibliography's place right after such a section's fence, which import writes before the block's fence too, and the blank lines before, between and after the three fences stay where they were. They stay so up to where import writes style fences export has no place for, or none where export has one, as at a section's fence or the bibliography's place in a block with a heading, quote, code block, table or thematic break, at a block of only such blocks, and, past a section's fence in a block, at such blocks between a block's paragraphs or two blocks of a style import reads as one. From there on, they go as before. The fences after keep the blank lines around their own where the block holds only paragraphs, lists, comments, sections that close and the bibliography's place, up to its closing fence or the document's end, and no block of another style opens in it or in a list item in it. With the bibliography's place in the block, they do only where import reads no two blocks of a style in the document as one, and elsewhere take the blank lines they did before. Past such a block, a section break in a block, as at a section's fence or around a table in a section of its own, or the bibliography's place in a block, an alert whose label and lead paragraph export leaves out, or a block with such blocks between its paragraphs that ends where another of its style starts after only such blocks, import reads such blocks as ending the block they're in, as before. Where those blocks come right after the block's last paragraph, the closing fence import writes between them has a blank line after it, and where a section's fence came right before the block's closing fence, that fence, which import writes after them, takes the blank lines after the block's. Display math, an HTML block and a list take the block's style. A quote at the end of a list item in a block keeps the block open past the empty paragraph export writes after it, before an item that starts another list or a paragraph after the list, or closes it at the item after it, so the list doesn't end there. Nested style directives are not supported — opening a new style implicitly closes the previous one (with a warning). Where the new block has a paragraph in its style, import writes a closing fence for the previous one before it, after a blank line, and the fences after it keep the blank lines around their own.

#### Round-Trip

Custom styles are preserved through DOCX round-trips. On export, each style is created as a Word paragraph style (basedOn Normal) with a `MsCustomXxx` style ID. The style definitions are stored in the `MANUSCRIPT_CUSTOM_STYLES` custom property in `docProps/custom.xml`. On import, the custom property is read back and the style definitions are emitted in the frontmatter `styles` block, with `<!-- style: name -->` / `<!-- /style -->` directives re-emitted around the styled paragraphs. Without the custom property, import reads each style's definition from its Word style, named `Custom: ` and the style's name, and the frontmatter and the directives both take that name, as `R&D`, but for a name that a directive or the frontmatter wouldn't give back as it is, as one that holds a `-->`, which would end the directive's comment, or a `:`, which would end the frontmatter's key, whose directives take a name from the style's ID, as before. An HTML comment on lines of its own in the block, which Word hides with its paragraph, keeps the block's style too, so it comes back inside the block. The blank lines before and after each directive, and each such comment, come back as they were, even where a code block or HTML block before it holds the same line.

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
- A directive applies to the next paragraph Word shows. Comments, a style block's fences and a block on one line of comments alone, which Word shows nothing of, don't count, so a directive before `<!-- style: box -->` applies to the block's first paragraph. So does one before a block on one line, as `<!-- style: box -->Text<!-- /style -->`, whose text is the paragraph. Import writes the directive right before its paragraph, after the block's opening fence.

Both directives are consumed during parsing (they do not appear in the DOCX) and are preserved through round-trips via `MANUSCRIPT_INDENT_OVERRIDES` and `MANUSCRIPT_LIST_INDENT_OVERRIDES` custom properties, and `MANUSCRIPT_LIST_ITEM_INDENT_OVERRIDES` for one between two lists of the same type, as of bullets, which Word has as one list.

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

- **Formatting**: bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`), underline (`<u>text</u>`), superscript (`<sup>text</sup>`), subscript (`<sub>text</sub>`), inline code (`` `code` ``). The HTML tags `<b>` and `<strong>` are bold too, `<i>` and `<em>` italic, and `<s>`, `<del>` and `<strike>` strikethrough. DOCX→MD conversion writes `<b>`, `<i>` or `<s>` where Word's formatting starts or ends at a point Markdown's delimiters can't: `a**.b**` isn't bold, since `**` after a letter can't open before punctuation, so a bold `.b` after an `a` is `a<b>.b</b>`. The same goes for formatting that would run into the delimiter of a neighbour, as italic `a` before bold `b` would in `*a***b**`. Struck text with whitespace or a line break at its edges, or whitespace alone, goes in `<s>`, which holds the whitespace, as `<s>a </s>b` and `<s>a\` + newline + `</s>b`: Word shows the strike on it, and `~~` can't close after a space or at a line's start. A line break of its own that Word underlines or strikes goes in `<u>` or `<s>`, as `a<u>\` + newline + `</u>b`. Formatting around inline code, as `` **`code`** ``, is the code's in Word, and DOCX→MD conversion writes Word's formatting of code around its backticks, where Markdown reads it. A line break in Word's code, which a code span can't hold, goes between spans of the code on each side of it, inside the formatting around them, as ``==`a`\`` + newline + `` `b`==``, or in the highlight of a span that an `==` in highlighted code splits it into, so Word shows a highlight, an underline or a strikethrough on it again, though not code's own style. DOCX→MD conversion writes a CriticMarkup comment between two pieces of bold, italic or struck text inside one pair of delimiters around both, as `*a {>>note<<} b*`, so the spaces next to the comment keep the formatting in Word. A comment at the start or end of such text goes inside the delimiters only where a space is next to it, as `*a {>>note<<}* b`. Elsewhere it goes outside them, which Word reads the same.
- **Headings**: `# H1` through `###### H6`
- **Lists**: bulleted (`- item`), numbered (`1. item`), task lists (`- [ ] item`, `- [x] item`). Blockquote continuation blocks and HTML blocks inside list items are preserved; see [List item limitations](#list-item-block-content) for the remaining unsupported block content.
- **Links**: `[text](url)` plus autolink literals (bare URLs/emails)
- **Code blocks**: fenced with triple backticks. Optional language annotation (e.g., `` ```stata ``) is preserved on round-trip via the `MANUSCRIPT_CODE_BLOCK_LANGS` custom property in the DOCX, and for a note's code blocks, the index of the note's first in `MANUSCRIPT_NOTE_CODE_BLOCKS`, by the note's ID, so each note keeps its own languages wherever Word shows it, and a code block Word adds to a note gets none. In Word, code blocks use the "Code Block" paragraph style (Consolas, shaded background). Consecutive code blocks are separated by an empty paragraph to prevent merging, which import drops, as it does the one export writes between a code block and a quote. An empty list item, heading or quote paragraph right after a code block isn't such a paragraph, and comes back. Outside a style block (in one, import can write the block's fence between them), a paragraph, list, heading, table, rule or display math right after a code block's closing fence comes back a blank line after it, and Word gets the empty paragraph a blank line there gives, so each trip gives Word the same paragraphs. A style block right after a code block that holds only headings, tables, rules, quotes or code, none of which Word can give its style, comes back without its fences, and Word gets the empty paragraph what it holds gets right after the code. Not where the code ends a style block of another style that holds a paragraph, whose closing fence import writes right after the code. Right after a section's or style block's fence, or a comment of its own, a code block comes back after the blank lines it had there, or on the next line, as other blocks do. A code block in a footnote or endnote takes the same style, and the note's mark goes in a paragraph of its own when the note starts with one.
- **Blockquotes**: `> quoted text`. A quote holds paragraphs, nested quotes, alerts, HTML blocks and display math; see [Blockquote limitations](#blockquote-block-content) for the rest. Two quotes with a blank line between them stay two in Word, with an empty paragraph for each blank line, as two alerts do, where the paragraphs of one quote, which a line of `>` alone separates, have none between them. On DOCX import, two quotes at the same level with nothing between them come back a blank line apart, or, nested, with a line of the `>` of the quote around them between. So do two quotes that had something between them that import doesn't write, as a style block of quotes alone or a block a list item drops, where it had no blank line after it. A paragraph after a list comes back at least a blank line after a quote at the end of its last item, which it would go on otherwise. A list, a heading, code or a table right after a quote's line, which ends the quote, comes back a blank line after it, and Word gets the empty paragraph a blank line there gives, so each trip gives Word the same paragraphs. So does a paragraph, a rule or HTML right after the line of a quote in a list item, out of the list, but for a comment or a fence, which comes back on the next line. So does each of these at the start of a style block right after the quote's line that holds only blocks Word can't give its style, whose fences import drops, and a quote there of no alert, where both quotes are at the top level and out of any list item. Not where the quote ends a style block of another style that holds a paragraph, whose closing fence import writes right after the quote. Two or more blank lines between a quote and a list, a heading or code come back as they were, as before a paragraph, with an empty paragraph in Word for each. What follows such a table comes back a blank line after the table, as after any table, which a paragraph there needs so as not to be read as a row of the table. A line without a `>` right after a quote's line ends the quote on export, but for a line of plain text after a quote's line that ends in a line break, a `\` or two spaces, which goes on the quote's paragraph after the break, as markdown-it reads it. So do the lines of plain text after it, where a blank line or the document's end follows them. Such a line may hold emphasis, or an equation, a citation or a note's reference that ends on the line, or start with one, as may the quote's lines, and the quote may be an alert. Import writes those lines with the quote's `>`. Display math right after a quote's line, which ends the quote, comes back right after it, as the source had it, so each trip gives Word the same paragraphs.
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

**DOCX→MD**: When converting from Word, line breaks (`<w:br/>`) are emitted as `\` + newline in the Markdown output, making the hard break intent explicit. So is a page or column break (`<w:br w:type="page"/>`) between a paragraph's text, as the line break it shows there, which keeps the words on either side apart. Export writes it back as a line break, not a page break. Where it shows no line, at the start or end of a paragraph, import writes nothing for it. Nor does it in a paragraph that holds an HTML tag, even one split between runs, as an HTML block, where a line break would be the HTML's line end or end the block, in a citation's or a cross-reference's text, which import writes as the citation or the reference, or between the runs of a hidden HTML comment Word split around it, which import joins. Markdown can't hold that form at the end of a paragraph, where the `\` would be text, or in a heading, which would end at it, so there a line break is emitted as `<br>`. So is one at the end of a table cell, which a pipe table can't hold as a line end, and where a grid table's blank lines pad the cell. So is one before an HTML comment that would start the next line, where the comment would start an HTML block, which ends the paragraph and leaves the `\` as text. Not where the comment's hidden run starts with spaces or tabs, which import keeps at a line's start and writes there as character references, `&#32;<!-- c -->`, after which no block starts, but for those before a comment over lines, which is a block's. The comment then goes after the `<br>` with the rest of its line, and the comments on that line before anything it shows go without the whitespace their hidden runs hold outside them, such as the block's indent before the first, which Word hides and the paragraph would show. The comments after text on that line go as they do after text on any line. This happens only where export reads the line after a `<br>` as part of the paragraph or heading it's in, with each comment whole. A comment with a blank line in it, or one over lines in a heading, stays in its HTML block, which keeps it hidden. Where such comments end a plain paragraph after the break, with nothing Word shows after the break, not even a space or tab, and only spaces and tabs around them in their hidden runs, the break goes as `<br>`, as at any paragraph's end, and each comment goes in an HTML block of its own after a blank line, as `Source<br>`, a blank line, then `<!-- a`, a blank line and `b -->`. Word then has the comments in a paragraph of their own, which it hides, and the `\` no longer shows. Import keeps that form only where export, reading the paragraph alone, reads each comment back hidden, none as a directive, and all the text Word shows as shown, with each line break where Word has it, and where no comment starts as a directive does, such as `<!-- table-font: X -->`, `<!-- /landscape -->` or `<!-- embed: x -->`, which export may read as one in a block of its own, by the table or section after the paragraph. A plain paragraph is one in the body that isn't a heading, title, list item, quote, alert or code, and holds only text, bold or italic or neither, and hidden comments, with no Word comment's range, tracked change or link. Elsewhere the comment stays in its block after the `\`, which shows. In a plain paragraph, a Word line break in a comment's hidden run outside the comment, as after its `-->`, is emitted as a line break of its own, a `\` + newline, or a `<br>` before a comment that would start the next line, by the same rules, where text Word shows goes before the comment in the paragraph and after it: Word's `a`, then a hidden `<!-- x -->` and line break, then `b`, comes back as `a<!-- x -->\`, then `b` on the next line. In the comment's text, the line end would read as a space, and before another comment it would start an HTML block, which the paragraph indents four spaces, as a space too. The break then shows in Word, where it was hidden, and the hidden spaces and tabs around it go. That happens only where each such line break in the paragraph can go so: where the hidden run holds only whitespace outside its comments, and no line end but Word's line breaks, as a line feed in Word's text reads as a space, and where export, reading the paragraph alone, reads it as Word has it. Elsewhere, and at a paragraph's start or end, the line end stays in the comment's text. A Word line break that Word shows, right after the hidden comments a plain paragraph starts with, with more than line breaks and whitespace after it, goes before them, as a `<br>`: Word's hidden `<!-- a -->`, then a line break, then `after`, comes back as `<br><!-- a -->after`. After the comment, its `\` would go in the HTML block the comment starts, which runs to the end of its line, so Word would show the `\` and the comment, and the next line would be a paragraph of its own. Word shows the same text and break, with the hidden comment after the break. That happens only where export, reading the paragraph alone, reads it as Word has it, and not where the first comment's run starts with spaces or tabs, which go as references, after which no block starts. So do the comments on a line whose hidden runs hold other text outside them, as the `x` of `<!-- a -->x<!-- b -->`, which the paragraph would show but a block that starts and ends with a comment hides. So does a line break on a line of an HTML block that a comment at the paragraph's start began. A line of a comment that would start a block is indented four spaces instead, as in any paragraph (see [converter](converter.md)), which keeps it in the paragraph. In a table's cell, which starts no block, a line break before a comment stays as the cell writes one, but the comments at its line's start, before anything it shows, still go without the whitespace their hidden runs hold outside them, which the cell would show after the break. Export reads `<br>`, `<br/>`, and `<br />` as a line break in a paragraph's text, and on lines of their own, which markdown-it reads as an HTML block, where such tags are all the block holds. A `<br>` that is text in Word is escaped as `&lt;br&gt;`.

A line feed or carriage return inside Word's text (`<w:t>`) is not a line break. Word writes its line breaks as `<w:br/>` or `<w:cr/>`, never in the text, and shows one that another tool writes there as a space, so import writes a space for it, not a line's end. A carriage return and the line feed after it are one line end, as other tools write one, even where Word's runs split them, but not where a tracked change or a comment holds one and not the other. Raw HTML that Markdown keeps as it is, an HTML block that Word shows as text or a tag, keeps its line ends through Word. Export writes each one as a line break in the raw HTML's runs, which take the hidden character style Manuscript HTML, and import reads such a line break, or a carriage return of Word's (`<w:cr/>`) in its place, as the HTML's line end again, so a `<pre>` keeps its lines and `<custom>` on a line of its own stays a block. That holds where the paragraph is still the HTML block, or the runs are still whole tags, with no formatting, tracked change or comment starting inside one, but for bold or italic alone on a line break or whitespace, which import writes with no delimiters; where an edit in Word makes them something else, the line breaks read as the line breaks Word shows. So do those of a tag that import writes as text, as one export would read as formatting but keeps as text for its attributes, as `<b class="k">`, or a processing instruction or declaration, as `<?php ?>`: `<b` and a line end before `class="k">` come back as `<b\` and a line end, a line break in text. In a heading, which ends at a line's end, a tag's line ends come back as spaces, the same whitespace to HTML, so `A <span` and a line end before `title="a">x</span>` in a setext heading come back as `## A <span title="a">x</span>`. In a list item, a tag's line ends come back with the item's indent after them, which Markdown leaves out of the tag, so the tag's own whitespace after them stays. That is a tag as Markdown reads one, not one in a comment's body, which stays as it is, nor one whose `<` a `\` escapes, though one after `\\` is a tag. Nor is it one in a CriticMarkup span's text, as `{++<span` and a line end before `title="a">x</span>++}`, whose line ends export keeps with the indent after them. In a table cell that import writes as HTML, as one with two paragraphs, where the tag is text, its line ends come back as `<br>`, the line breaks Word shows. A backslash just before one of the HTML's line ends, in a tag or a block, as `<span title="a\` with `b">` on the next line, or `a\` on a line of a `<pre>`, is the HTML's and stays, there and in a grid table's cell, which writes a line break as a bare line end without its backslash. A line break of Word's in a tag's text, not one export wrote, comes back as a line break with the tag's `<` escaped, so the tag is text, as `\<span title="a\` and a line end before `b">x</span>`, which Markdown would otherwise read as a tag with the line break's `\` in it. A paragraph whose text is an HTML block of its own, with its line ends as line feeds in the text, as export wrote one before, keeps them too, all but one at the end of its text, which ends the block's last line as the paragraph's end does. So does one a comment's point comes after, which import writes as text, as the comment would go in the block, with its line ends as `&#10;`, as in `\<div>&#10;# heading&#10;</div>{>>c<<}`, one at its end too, and a backslash before one escaped, as in `a\\&#10;`, which would escape the reference. A reference is no line's end, and Markdown shows it as a space, as Word does. Where anything else keeps the paragraph from being the block, as a comment's range on it or a note's mark after it, its line feeds are spaces, and a block whose line ends are line breaks in the Manuscript HTML style, with a comment's point after it, reads them as the line breaks Word shows. So does a tag import writes as HTML with a line feed in its text, as export wrote one before, in shown or deleted text, in a paragraph that can hold lines: not in a heading, a table's cell or code. The tag is read over the runs import writes as one text, as runs alike, or a run's text on each side of a tab, or whitespace in bold or italic alone between them, which import writes with no delimiters, but not runs formatted apart otherwise, which it writes in parts. Whether a paragraph is a block, and whether runs are whole tags, is read from the text import writes for the paragraph, so what shows nothing, as an empty run or a content control around runs, doesn't count, nor does a note's mark and the space after it, and formatting a paragraph mark has that its runs turn off is none. A heading or title can't hold a block, but a note's paragraph in a heading's style, which a note doesn't read, can.

### GitHub Flavored Markdown Extension Notes

- **Autolink literals** are enabled in parser and preview (for example, `https://example.com` is linkified without explicit `[]()` markup). A URL that is text in Word, not a link, comes back from DOCX with its colon escaped, `https\://example.com`, so it stays text, also where its formatting changes inside it, as a plain `https://` before a struck `example.com` does: `https\://~~example.com~~`.
- **Strikethrough** uses standard GitHub `~~text~~` behavior.
- **Task list items** are parsed semantically as checkbox list items, not only plain text prefixes. As in GFM, the box must be plain text at the very start of the item: `` - `[ ] a` ``, `- **[ ] a**`, `- [[ ] a](url)` and `- \[ ] a` are ordinary list items. The box takes the whitespace written after it, but not whitespace written as character references after that, which is the item's text: `- [ ] &#32;a` goes to Word as `☐  a`, as import writes a task item whose text starts with a space. An alert's marker, likewise, must be plain text at the start of a quote's line: `` > `[!NOTE]` `` and `> \[!NOTE]` are ordinary quotes.
- **Disallowed raw HTML** follows the GitHub extension set (`title`, `textarea`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `script`, `plaintext`) and is treated as literal text in preview/conversion paths.
- **Intentional HTML exceptions**: HTML comments (`<!-- ... -->`) and supported inline HTML formatting tags used by this project (for example `<u>`, `<sup>`, `<sub>`, `<b>`, `<i>`, `<s>`) remain supported.
- **Alerts** use GitHub's blockquote-based syntax with `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]` markers at the start of a line. Alert content follows on subsequent `>` lines, and a marker at the start of a later line starts another alert. That's a line of the source, after a line end or a `\` and one, not after a `<br>`, after which a marker is text. Content can also follow the marker on its line. The marker takes the whitespace written after it, but not whitespace written as character references after that, which is the alert's text: `> [!NOTE] &#32;a` goes to Word as ` a` after the label, as import writes an alert whose text on the marker's line starts with a space. Alerts are displayed with colored left borders and type-specific header icons in preview and are preserved through DOCX round-trip. Whether text follows the marker on its line, and the blank lines around each quote, which export records, import finds by the quote's kind, its number of paragraphs and the start of its text, past an alert's label, so they stay with the quote where Word added, took out or moved a quote before it. A quote Word added has its marker on a line of its own, and the blank lines Word's empty paragraphs give, as do two quotes Word put side by side that export didn't. Where Word changed a quote's text, it's the quote export wrote at its place, among those between two it can tell. Where Word added or took out one of two quotes of the same kind, text and number of paragraphs, import can't tell which, and reads them by their places, as before. So it does with an alert whose text starts with bold text like its label, with the labels hidden, and the quotes it can't tell between the same two. Type labels are shown by default; set `callout-labels: false` in frontmatter to hide the label row in both preview and DOCX output without removing the callout's body, type, colors, border, or other styling. An explicit `true` or `false` value round-trips through DOCX via the `MANUSCRIPT_CALLOUT_LABELS` custom property. A comment at the start of the line after the marker starts an HTML block, which ends the marker's paragraph: alone, the comment is a paragraph of its own in Word, and with text after it, the block is text, as at the top level. So where Word's alert text starts with a hidden comment on the line after the marker, import indents that line four spaces, which keeps it in the marker's paragraph: `> [!NOTE]` and then `>     <!-- c --> rest`. It doesn't where the paragraph couldn't hold the comment as it is, as one with a blank line or a line that starts a block in it, or one that ends in `--->`, which only the block keeps hidden. Nor does it where the alert's text is hidden runs of comments alone, one of which holds text outside its comments, as `<!-- a -->secret<!-- b -->`, which a paragraph would show. Whitespace the hidden runs before the line's first text hold outside their comments, which Word hides too, is dropped from the indented line, as `<!-- a --><!-- b -->` for a run of `<!-- a --> <!-- b -->`, since the paragraph would show it. Runs side by side are read together for that, as a comment that ends in `--->` goes on to the next run's `-->`, so the space of runs of `<!-- a --->` and ` <!-- b -->` is in that comment and stays. A hidden run after text on the line is as in any paragraph, with one space where it goes between two words. On DOCX import, a comment Word put on an alert's label and on its text, as on the whole paragraph, starts after the label, which the marker stands for, as `> [!NOTE]` + newline + `> {==text==}{>>c<<}`. A comment on the label alone, or a tracked change to it, keeps the label as text after the marker, as one on a task item's box keeps the box. So does a link on the label, which import keeps, and a comment on the line break or space after the label alone, which keeps that as its text. Where import writes another comment's range as starting before the label, as one from a code block before the alert, which holds no markers, the label stays as text too, with the line break after it. So does a label whose line break or space has formatting or a link, as a highlight, which import keeps, or where a comment of no width is, or a comment starts. Import moves a comment only where it starts on the label and goes on in the text.

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

A cell takes HTML formatting only. Markdown, CriticMarkup, comments, citations and math in a cell export as literal text, but for a tracked paragraph mark: a span of CriticMarkup that holds only the break between two of a cell's paragraphs, its opener ending one `<p>`'s text and its closer starting the next one's, as `<p>a{++</p><p>++}b</p>`, tracks the first one's mark, as `{++` and `++}` around a blank line do outside a table. Its delimiters are those characters as the HTML writes them: with a character reference in one, as `a&#123;++`, they're text, and so are they in `<code>` or a `<pre>`. DOCX import writes a cell's tracked mark so, but for its last paragraph's, which it drops, and writes a cell's text that ends one paragraph as such a span opens and starts the next as it closes, past the whitespace a paragraph's edges lose, with `&#123;` for its `{`. Each `<p>` in a cell exports as a paragraph of the Word cell, and `<br>` as a line break, in the formatting around it, as text is, which Word shows on it, as the underline of `<u>a<br>b</u>`, and in the hyperlink of the `<a>` it's in, if any. Each `<a>` is a hyperlink of its own, though the one next to it goes to the same place, and import writes each of Word's hyperlinks as an `<a>` of its own, ending it before a comment in it, as export ends the hyperlink there. A `<pre>` exports as a paragraph that keeps its spaces and tabs, with each line end as a line break, as HTML shows it: not the line end right after `<pre>`, which HTML drops, nor its last line end or `<br>`, which starts no line with anything on it. A carriage return by reference, as `&#13;`, or without its `;`, as `&#13` before a character that isn't a digit, shows nothing in a browser, so it exports as nothing, and `&#13;&#10;` as one line end. The text on either side of it stays apart, as in the browser, so `&&#13;#10;` exports as the text `&#10;`, not a line end. Import writes it as a `<p>`, with `<br>` between its lines. A cell's `align="left"`, `"center"` or `"right"`, or a `text-align` style, sets its alignment. A row with a `<th>` is a header row in Word. Word repeats a header row on each page only when it leads the table, but one after a `<td>` row stays a header row through export and import, and the rows before it stay body rows.

A table, row or cell commented out, as `<!-- <table>...</table> -->`, is none, as in the preview, and a comment in a cell is hidden in Word, as one in a paragraph is. One with no end, which runs to the end of the cell, imports with one, and one the browser ends at a `--!>` imports with a `-->` where the table can't stay HTML, as inline Markdown reads a comment on past a `--!>`. One with a blank line, which a grid table's cell holds, imports without it where the table can only be HTML, as the blank line would end the table's HTML block. Word's table can't hold a comment between its rows or cells, so DOCX export drops one, with a warning, and writes a table whose rows are all commented out as HTML around another table in its block, or else the block as text, as other HTML, with a warning. Expand Table and Compact Table leave a table with such a comment as it is, as they do one with a comment in a cell that holds a line end or a `|`, or that inline Markdown doesn't read as a comment, as one with no end. The rest of a table's HTML block, such as a `<div>` around the table, a caption in a `<p>` on the line before it, or text on the lines after it, isn't shown in Word, with a warning, but goes with the table, so import writes it back around the table, on the table's lines as it was, and a table after another in its block on in it, where Word put nothing between them. A block that starts and ends with a comment but holds a table outside it is a table, not a comment. Import finds the table by its first row and all its text, and the count of tables alike in both before it, so neither one Word adds or deletes before it nor one alike without HTML takes the HTML; a table whose text was edited in Word gets the HTML export wrote with the table it matches, as its settings do (see [Tables](#tables)), if its first row is the same and the table the HTML was written with isn't still there. A table that gets the HTML stays HTML, as it was written, though Word added or deleted a table before it. A table that can't stay HTML, as one a tracked change in Word now holds, gets it as blocks of their own around it, which the next export shows as text: its HTML as it was, but with each comment's end one Markdown reads as the browser does, as `-->` for `--!>`, and for a comment alone that would read as a directive, as `<!-- table-font-size: 11 -->` would, which is dropped, and its other text escaped, so that `# Source` stays text and isn't a heading, with the lines of a paragraph of it on one, as the browser shows them and Word holds them. A paragraph of that text is written as import writes the Word paragraph export makes of it, with a tag that formats text, as `<b>b</b>`, as Markdown's `**b**`, where that reads as it, a character reference, as `&amp;`, as its character, and a `<br>` as a line break, but with a citation's brackets escaped, as `\[@key]`, as the HTML held them as text, though the next import reads Word's text of a citation whose key the document cites as a citation (see [Round-Trip Features](converter.md#round-trip-features)), and as it was where a reference, as `&#13;`, is a line end's, and a blank line goes between each of its paragraphs and HTML blocks and the next, as between Word's paragraphs, but next to a comment, so the next round trip leaves them as they are.

On DOCX import, a column whose cells share an alignment takes it in a pipe or grid table, and an HTML table's cell takes its own. A line break that Word underlines or strikes in an HTML table's cell imports inside the `<u>` or `<s>`, as `<u>a<br></u>b`. A cell's alignment is its paragraphs', set on them, or else by their style, the table's style for where the cell is, or the default paragraph style where they have no other, in the order Word applies them.

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

Separate keys with semicolons even after a prefix. Write `[e.g., @smith2020; @jones2021]`, not `[e.g., @smith2020 and @jones2021]`. A citation with a prefix keeps its keys in the order written, even when the style would otherwise sort them, so a leading "e.g.," stays first. A prefix is plain text. Punctuation such as `=` or `<` is fine, but if the text before the first key contains Markdown formatting, such as code, emphasis, or CriticMarkup, the brackets stay ordinary text. To keep a character literal, escape it with a backslash, as in `[see \*also\* @smith2020]`. Keys and locators are read as written, so a tag such as `<b>` in one is text, and the preview shows a citation as text too. On DOCX import, Word's text in parentheses or brackets right after a citation with a prefix has its `(` or `[` escaped, as in `[see @smith2020]\(2019)`, since export reads such a citation right before a `(` or a `[` as a link's text. On DOCX import, Word's text that reads as a citation stays one only where it is all one run of formatting. Where formatting, a tracked change or a comment changes inside it, export would take the delimiters for the key's, locator's or prefix's text, so its `[` is escaped: plain `[@smith2020, p. ` before a bold `2` and a plain `]` comes back as `\[@smith2020, p. **2**]`. Text with a key right after its `[` and no `]`, before a citation or a footnote reference, has its `[` escaped too, as export would read from it to the citation's or reference's `]` and take that for its key: Word's `see [@a ` before a Zotero citation comes back as `see \[@a [@smith2020]`.

A key is the text after the `@` to the item's comma, as written, so `[@smith.2020]` cites `smith.2020`, and the editor colors all of it. A key with a `;`, a `]` or a backtick can't be cited: a `;` or `]` ends the item or the citation there, and a backtick with another after it makes code of the text between, which the language server reads no citation in. The language server reports such a key in the `.bib` file and leaves it out of completions.

Citations reference entries in a companion `.bib` file (see [BibTeX Companion File](#bibtex-companion-file) below).

### Bibliography Placement

DOCX export puts the bibliography at the end of the document, followed by a note for each cited key the `.bib` file lacks, as `Citation data for @key was not found in the bibliography file.` A `<!-- references -->` comment in a paragraph of its own, or `<!-- bibliography -->`, puts them there instead. Only the first marker counts.

```markdown
Main text [@smith2020].

<!-- references -->

## Appendix
```

In Word, the marker is the bibliography's `ZOTERO_BIBL` field. When there are no entries to list, as without a `.bib` file or when it has none of the cited keys, the field is empty, in a hidden paragraph that takes no space, so Word shows nothing at the marker. DOCX import writes the field back as `<!-- references -->`, before the notes, which export drops and writes again from the citations. The marker comes back with the blank lines it had before and after it, as a fence does, which a custom property records with the fences', after any block, and on the next line right after a fence, as `<!-- /landscape -->` or `<!-- landscape -->`, or a comment of its own, where it was. A marker at the end of the document, where the bibliography goes anyway, gets no empty field, and import leaves out a marker there. That includes a marker that only footnote or endnote definitions follow, as they come after the body in Markdown but in their own part in Word. Word has the bibliography at the end of the body either way, so a marker put right before the notes on purpose comes back without it, and the next round trip changes nothing. A marker between two orientation sections, as after `<!-- /landscape -->` and before `<!-- landscape -->`, puts the bibliography on a page of its own between them, in the document's orientation, as other content there goes. Where there's nothing to list, that page would be blank, so the empty field goes at the start of the next section instead, and import puts the marker back before the section's opening fence. A marker right after `<!-- landscape -->` puts the bibliography at the start of that landscape section.

### BibTeX Companion File

By default, citations reference a companion `.bib` file with the same base name as the Markdown file (e.g., `paper.md` uses `paper.bib`). You can override this by specifying a `bibliography` field in the YAML frontmatter:

```yaml
---
bibliography: shared/references.bib
---
```

The `.bib` extension is optional (`bibliography: shared/references` also works). Relative paths resolve from the `.md` file directory first, then the workspace root. Paths starting with `/` resolve from the workspace root first, then as absolute OS paths.

An entry's type is what BibTeX reads as one: after the `@` and any white space, a run of characters that doesn't start with a digit and has no white space and none of `"#%'(),={}`, so `@my-type{k,` and `@ article{k,` are entries `k`. An entry's key is what BibTeX and biber both read as one: after the entry's `{` or `(`, the text to a space, a comma or the entry's closing delimiter, with no `@` in it. BibTeX reads an `@` in a key, but biber reads none, so `@article{` with no key, followed by `@book{b,` on the next line, is an entry `b`, not one keyed `@book{b`. An entry with no fields, as `@article{k}`, is an entry `k`.

Each entry contains standard BibTeX fields:

- `author`, `title`, `journal`/`booktitle`, `year`, `volume`, `number`, `pages`
- `doi`, `url`, `publisher`, `edition`, `abstract`

A field's name is what BibTeX reads as one: everything up to a space, `=`, a comma, a brace, a parenthesis, `"`, `#`, `%` or `'`, so `:doi` and `x:doi` are names of their own, not `doi`, and `été` and `a+b` are names too. A name that starts with a digit is none, as BibTeX reads none, so `1doi = {…}` is no field, and nothing in its value is either. A bare value is a number, its digits, as `year = 2020`, or a macro's name, read as a name is, as `month = jan` or `month = x-y`; after a number, the rest of its run, as `.1/a` in `10.1/a`, is no field's. A space other than ASCII's, as a no-break space, reads as a space, where BibTeX reads it in a name.

A field's LaTeX reads as LaTeX prints it, in part. An accent, as `{\"o}` or `\'e`, is its letter, though braces a command could take as its argument, as below, keep their braces, so `\textit{\b{x}}` reads as `\textit{x̱}`. A letter's or symbol's command is the character LaTeX prints, as `\ss` is `ß`, `\o` `ø`, `\aa` `å`, `\l` `ł`, `\i` `ı`, `\textregistered` `®`, `\copyright` `©`, `\dag` `†`, `\S` `§` and `\textendash` `–`, alone, with an empty group, as `\ss{}`, or in braces, as `{\ss}`, though braces a command could take as its argument keep their braces, after a command's name or any group, with or without spaces between, as in `\textsc{\O}`, `\textsc {\O}`, `\textcolor{red} {\O}` and `\texorpdfstring{\ss}{\o}`, which read as `\textsc{Ø}`, `\textsc {Ø}`, `\textcolor{red} {Ø}` and `\texorpdfstring{ß}{ø}`. Whether a command comes before is read in the value as read so far, so a letter's or symbol's command read as its character takes no argument: `{\l}{\L}` is `łŁ`, `\ss{\O}` is `ßØ`, and `Stra\ss {}e` is `Straße`. The spaces and tabs after one end its command, as TeX reads them, so `Stra\ss e` is `Straße`, but not a note's line end or a no-break space, which TeX reads as characters. `\textbraceleft`, `\textbraceright` and `\textdollar` are `{`, `}` and `$`, as `\{`, `\}` and `\$` are, so `\textdollar{}5` is `$5`. An author's or editor's names keep these commands as written, for now: BibTeX splits names, and reads a word's case, before TeX reads a command, so a name needs them read once it's split, and the `.bib` file written back as it was read. `\SS`, which pandoc drops, and the commands this doesn't know stay as written, and so, for now, do the commands of the other characters that are BibTeX's or TeX's syntax, `\textbackslash`, whose escape, `\\`, LaTeX reads as a line break, `\textasciitilde`, `\textasciicircum`, `\textquotesingle` and `\textasciigrave`, and of characters that complete markup citeproc reads in a field, `\textless`, `\textgreater` and `\textquotedbl`, and a control space, `\ `, which as a space would complete a tag, as in `<span\ class="nocase">`.

Outside an author's or editor's names, a tie, `~`, is a no-break space, so `a~b` reads as `a b` with a space that doesn't break, and an empty group, `{}`, is nothing, so `a {} b` is `a b`, but one a command could take as its argument stays, after a command's name or any group, with or without spaces between, as in `\foo{}`, `\foo {}` and `\textcolor{red}{}`. `\~{}` and `\^{}` are `~` and `^`. `\url{...}` is its argument, a URL, as written, with no tie or other LaTeX read in it, but with its escaped characters, as `\_`, `\%` and `\^`, unescaped, as pandoc reads it, so `\url{https://e.com/a_b~c}` is `https://e.com/a_b~c`. A `\url` whose argument's braces, counting the escaped ones, don't pair, as `\url{\}x\{}`, is read as math is, as written but for its accents, symbols and escapes, since the `.bib` file written back would hold its argument's braces escaped, which BibTeX counts. Math, from a `$` to the next, or from a pair of them to the next pair, keeps its ties, empty groups, `\url`, `\~{}` and `\^{}`, as math isn't read yet; a `$` that ends no math, as in `$5`, is text, and `\$` is a dollar sign. The `url`, `doi`, `isbn`, `issn` and `file` fields are read as written. TeX's ligatures, outside math and a `\url`'s argument, read as the characters LaTeX prints: `---` is an em dash, `--` an en dash, as in `pages = {1--10}`, two backticks are `“` and two apostrophes `”`. An empty group keeps them apart, so `-{}-` is two hyphens, and DOCX import and a `.bib` file written back put one between two hyphens, backticks or apostrophes, as `-{}-`, so a value reads back as it was. An author's or editor's names keep their ties, empty groups, dashes, quotes, `\~{}`, `\^{}` and `\url` as written, and are written back without those empty groups, for now: BibTeX splits a name's words at a tie once it has split the names, so a name needs them read once it's split, and the `.bib` file written back as it was read.

A field's value is read twice over: as text, as citeproc reads it, and as TeX, where its escaped braces, backslashes and dollar signs stay escaped, as `\{`, so they're told from a group's braces, a command's backslash and math's `$`. The language server shows a title, journal and institution as plain text from the TeX, with groups' braces taken off and escaped characters as themselves, so `The {RNA} of \{x\}` shows as `The RNA of {x}`. A name, or a value whose text has changed since it was read, shows without its braces, as before. Export gives citeproc a field's TeX as text too, with each group's braces taken off, so `The {RNA} of {iPhone} users` shows as `The RNA of iPhone users`. A group is citeproc's nocase, so a style that changes the case, as chicago-author-date does a title's words and a publisher's first letter, leaves the group's as BibTeX does, and `{the iPhone} Press` shows as `the iPhone Press`. In a name, or a field citeproc reads as a number, as volume, pages, number and edition, a group is its text. A group TeX reads otherwise stays as written, for now: a command's argument, as in `\foo{B}` or `\textcolor{red}{x}`, after its star or an argument in brackets too, as in `\enquote*{x}` or `\textcolor[rgb]{1,0,0}{x}`, a group with a command in it, as `{\em x}`, and a group in math. So does a group whose tags don't pair in it, as in `{<i>RNA} study</i>`, since a span around it would cross them, which citeproc shows as text, and a note with citeproc's own field in braces, as `{:original-date: 1850}`, which citeproc reads in a note. A value whose text has changed since it was read goes to citeproc as before. A `.bib` file written back from the parsed values, as DOCX import's merge does for a field it can't copy as written, still holds the text escaped, so `The {RNA} of \textsc{Smith}` is written as `The \{RNA\} of \\textsc\{Smith\}`. Outside names, a brace that pairs with no other is written as its command, as `\textbraceleft{}`, by DOCX import too, since BibTeX counts an escaped brace. So `A \textbraceleft{} B` is written back as it was, where its `\{` would have read on past the entry's end. Where a .docx has no .bib file embedded, DOCX import writes one from its citations' data, with citeproc's nocase span, as Zotero stores one, as a group, so `The <span class="nocase">RNA</span> of iPhone users` is written as `title = {{The {RNA} of iPhone users}}`, which export shows as Zotero did. Other markup is written as it is, and so is a span in a note with citeproc's own field in braces, which citeproc would end at the group's `}`.

A field's value in braces goes to the brace that pairs with its first, as BibTeX reads it, however deep the groups in it nest and however long it is, and every brace counts, an escaped one, as `\{`, too. A value in quotes goes to the next `"` outside its groups, as BibTeX reads it, so `"a {"} b"` is `a {"} b`, with one difference: this extension reads on past a `"` that a backslash escapes, so `"a \" b"` is `a \" b`, where BibTeX ends the value at that `"`. A `"` in a group, as `{"}`, reads the same in both. A field's whitespace reads as BibTeX reads it: each run of spaces, tabs and line ends is one space, with none at either end, so a value wrapped across lines reads as one line. A `note` keeps its line ends, as Zotero keeps its Extra field there, which citeproc reads a line at a time (`original-date: 1850`). `doi`, `url`, `isbn`, `issn` and `file` stay as written. A field an entry gives more than once, in any case, as `title` and `Title`, reads as biber reads it, the last value; BibTeX reads the first and warns of the rest, so the language server reports such an entry on its key.

An `author` or `editor` field's names are split at `and` outside groups. A name is split as BibTeX splits it, outside its groups, so a group in braces is one word: at commas, and into words at white space and hyphens. Its parts are BibTeX's: First von Last, von Last, First, or von Last, Jr, First. So `Ludwig {van Beethoven}` has the given name `Ludwig` and the family name `van Beethoven`, and `{Smith, Jones} Associates` the family name `Associates`. The von part is the words from the first that starts with a lowercase letter (or from the start, in a name with a comma) to the last such word before the last word, as `van` in `Ludwig van Beethoven` and `de la` in `Charles de la Vall{\'e}e Poussin`. A group has no case, so `Ludwig {van} Beethoven` has the given name `Ludwig van`, but one that starts with a command, as `{\ss}`, has its letter's. With no von part, the family name is the last word. Words a hyphen joins count as one word here, where BibTeX splits them, so a von part starts and ends only at white space: `Ali al-Hassan` has the family name `al-Hassan`, where BibTeX reads `al` as a von part, `John Smith-Jones` the family name `Smith-Jones`, and `Jean-Paul de la Fontaine` the given name `Jean-Paul`, the von part `de la` and the family name `Fontaine`. Between two words a name keeps the first space or hyphen, so `John Smith -Jones` has the family name `Jones`. As pandoc reads a name, the von part is citeproc's dropping particle, so apa shows `Beethoven, L. van`, the Jr part is the suffix, as in `King, Jr., Martin Luther`, and the parts after a third comma are dropped. citeproc doesn't read a name with a von or Jr part for particles again, so `de Smith, John paul` keeps `de` as its particle, as pandoc shows it, `Smith, J. paul de` in apa, where citeproc would take `paul` for one. It still reads a name with neither, so a family name a group keeps whole, as `{van Gogh}, Vincent`, has its particle, `van`. DOCX import writes a name from a citation's data back in the same form, so it reads back the same: a dropping particle as the von part, as `van Beethoven, Ludwig`, and a suffix as the Jr part. A non-dropping particle, as Zotero's data can hold, goes with the family name, joined with no space after an apostrophe or a hyphen, as `d'Artagnan`, and in a group where it would read back as a von part, as `{van Gogh}, Vincent`, which citeproc and pandoc show as `van Gogh, V.` in apa. A part with a command, as `\textsc{Gogh}`, is written as it reads and gets no group, for a comma, an `and` or a particle, since a part with a command keeps its braces and the group would show. So a non-dropping particle before one reads back as a dropping one. A family name goes in a group where BibTeX would read some of its words as a particle, as `{García y Vega}, Juan`, and gets a comma after it where there's no given name and BibTeX would read its first word as one, as `García García,`. Like BibTeX, this counts every brace, an escaped one too. A name that is one group, as `{World Health Organization}`, is an organization's. A group's braces don't show in a given or family name, but one that holds a command, a `\` anywhere, as `\textsc{Smith}` or `{\sc Doe}`, keeps every brace as written.

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

A reference can be in a link's text, as in `[as reported[^1]](https://example.com)`, as Pandoc reads it. Export writes the note's reference inside the link's `<w:hyperlink>`, and import writes the hyperlink back as one link around it.

A reference can sit inside a tracked change. `{++as reported.[^1]++}` exports as a note inserted with its text, and `{--as reported.[^1]--}` as one deleted with it. When a label has more than one reference, Word's note belongs to one of them and the others cross-reference it. A cross-reference shows the number Word gives the note until Word updates it, as the template's note settings, which every section takes, number the notes: in their format, from their start, and from it again in each section where they restart in each section or on each page, since export can't know where a page ends. Without such settings, footnotes are numbered 1, 2, 3 and endnotes i, ii, iii, as Word numbers them. A reference outside any tracked change gets the note when there is one, so accepting or rejecting a change never takes the note from a reference that stays. On DOCX import, a cross-reference stands for the number Word shows for it: one whose number Word tracked as an insertion or a deletion comes back in that change, as `{++[^1]++}`, and one whose number is hidden, which Word shows nothing of, is left out. A number Word updated with tracking on, the old one deleted and the new one inserted, is the same reference, and comes back as it was.

## LaTeX Equations

Manuscript Markdown supports LaTeX math notation, which is converted to and from Word's OMML equation format during roundtrip conversion.

- **Inline math**: `$...$` — renders within the text flow
- **Display math**: `$$...$$` — renders as a centered block equation
- **Bare environments**: `\begin{align}...\end{align}` — treated as `$$\begin{align}...\end{align}$$`

Bare environments are recognized for all supported amsmath display-math environments (`equation`, `align`, `gather`, `cases`, matrices, etc.). On round-trip through DOCX, bare environments are converted to the `$$`-wrapped form.

Inline math can be in a link's text, as in `[the case $n = 1$](https://example.com)`. Export writes the equation inside the link's `<w:hyperlink>`, and import writes the hyperlink back as one link around it. Display math in a link's text stays out of the hyperlink. The link's text before it, if any, is one hyperlink, and its text after it, if any, is another, so a link whose whole text is display math exports with no hyperlink. The equation comes back on lines of its own, between those links.

Supported LaTeX elements include fractions, roots, Greek letters, operators, matrices, accents, subscripts, superscripts, delimiters, and amsmath environments. See [LaTeX Equations](latex-equations.md) for the full syntax reference and [DOCX Converter](converter.md#latex-equations) for converter details.

## Images

Image paths can contain spaces: `![alt text](my figures/some image.png)`. Angle brackets and percent-encoded spaces also work: `![alt text](<my figures/some image.png>)` and `![alt text](my%20figures/some%20image.png)`.

Manuscript Markdown supports two syntaxes for images with optional dimension attributes.

An image can be a link's text, or part of it, as in `[![alt text](image.png)](https://example.com)`. In Word it's a linked picture.

### Attribute Syntax

```markdown
![alt text](folder/image.png){width=640 height=480}
```

The curly-brace block after the image reference specifies dimensions. Bare numbers and `px` are pixels; absolute units `in`, `cm`, `mm`, `pt`, and `pc` are converted at 96 px per inch. Both `width` and `height` are optional — when only one is provided, the other is computed from the image's intrinsic aspect ratio. A brace escaped as `\{`, or written as `&#123;`, right after the image is text, not its block: `![alt text](image.png)\{x}`. DOCX import escapes one so after an image with no size. Export scales an image wider than its column down to fit it, keeping its aspect ratio: the width of its section's text, between its margins and any binding gutter, or of the narrowest of the template's columns, which each section takes, fitted to that text. A footnote's image fits one of the footnotes' own columns instead, where the template gives footnotes columns of their own, `w15:footnoteColumns`, as far apart as the section's columns, as Word lays them out.

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

A backslash before the opening `==` escapes it, as in Markdown: `\==text==` is the text `==text==`, which export, the preview and the editor don't highlight. One before the closing `==` escapes nothing: `==a\==` highlights `a\`.

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

A highlight's content is Markdown. Emphasis, code, equations, citations and footnote references inside `==...==` export to Word as they do elsewhere. The highlight covers code, a citation, a footnote reference mark and an equation, but not an inline equation with a tracked change in it or in an insertion. Word holds a highlight on an equation in each of its runs. Import writes a highlighted inline equation in `==...==`, with any highlighted text around it, as `==a $x$ b==` or `==$x$=={red}`, but writes one with an `=` or a `}` in it, as `$x = y$` or `$\frac{a}{b}$`, or one in a tracked change, without it. An `==` would end the highlight, and the editor's highlighting and navigation read no `=` or `}` inside `==...==`, so they would pair its closing `==` with the next highlight's opener. An equation takes no bold or italics, so in bold text a highlighted equation comes back with the bold on the text beside it, as `**a** ==$x$== **b**`. It writes a highlighted display equation in `{==...==}`, its lines as written, as in a tracked change, so `{==$$`, `\text{a`, `- b}`, `$$==}` comes back as it was, and with a color but the default in a highlight inside it, as `{====$$`...`$$=={red}==}`. An `==` in the equation would end that inner highlight, so an equation of a color but the default with one in it comes back without its highlight. In a list item, the span's lines after its first come back without the list's indent, which export keeps in a span's lines, so it would go into the equation's text, as it does for a tracked change's. An equation in a paragraph's text comes back without its highlight, as `{==...==}` would end the paragraph there. One with a comment on it comes back without the highlight, in the comment's ID form, `{#1}$$`...`$${/1}`, as export would put a comment's markers around a highlight in paragraphs of their own. A comment on a highlight that ends with display math, as `{==$$`...`$$==}{>>note<<}`, goes around the equation in its paragraph, as Word puts one, and comes back in that form too.

On DOCX import, highlighted code, citations, footnote references and equations come back inside the highlight. An equation that Word doesn't highlight ends it, so the next export doesn't highlight it either: `==a ==$x$== b==`; in a tracked change, where import reads no equation's highlight, it goes on inside, as before. For example: `==see [@smith2020]==`, `==as reported.[^1]==`, `==a $x$ b==`, also inside a tracked change, `{++==as reported.[^1]==++}`. Where one span of the change can't hold them, as with code holding the change's closer, which puts the span on one side of a substitution, and a struck `}` or a `~>`, which that side can't hold, they come back in highlights of their own, each in a span that holds it: ``{--~~==\}==~~--}{~~==`a --}`[^1]==~>~~}``. Emphasis comes back inside the highlight too, `==a *b* c==`, but a tracked change comes back in a highlight of its own: `==a *b* {++c++}==` comes back as `==a *b* =={++==c==++}`. Highlighted code with `==` in it, which would close the highlight even in code, comes back in spans highlighted apart, split between the two `=`, each with its color named, yellow too: ``==`x =`=={yellow}==`=`=={yellow}``. Export writes a run for each span, formatted alike, which Word shows as one. A highlight keeps the spaces and line breaks at its edges, which Word highlights: `==a ==b`, and `==a\` + newline + `==b`. At the end of a paragraph, where `==` alone on the last line would read as a heading's underline, the line break before it is `<br>`: `==a<br>==`. It keeps them next to an `=` or another highlight too, where import writes no `===`, which the editor reads as no highlight. An `=` right before a highlight comes back as a character reference, `a&#61;== b==`, and so does one that ends its text, `==[^1]a&#61;==`, or text before a note reference or an equation in it, `==a&#61;$x$==`. A highlight of the default color right before another, as of code or another color, comes back with its color, `==a =={yellow}==b=={red}`. Text right after a highlight that its `==` would take, a `}`, an `=` or a color such as `{red}`, is escaped: `==b==\=c`.

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

A blank line in a comment's text separates two of the Word comment's paragraphs, and a single line's end is a line break. In a quote, each of the comment's lines after the first starts with the quote's `>`. On DOCX import, a comment in a table cell whose text has more than one line takes [ID syntax](#overlapping-comments), with its body below the table, because a pipe table's cell can't hold a line's end. So does a comment on an HTML comment outside a table, `{#1}<!-- a -->{/1}`, because `{==...==}` would show the HTML comment as text, and a line that starts with the comment and its body is an HTML block. Its range covers all of the HTML comment where Word started or ended it inside the comment's hidden text. In ID syntax the HTML comment is a paragraph, which a blank line keeps apart from text on the lines before and after it, even where its block had none. An HTML comment a paragraph can't hold, one with a blank line, a line of `***` or `---`, or a line that starts with `<!--`, stays an HTML block, with the Word comment after it, `{>>...<<}`, which the block shows as text. A Word comment whose text or a reply's has a line break goes in a paragraph of its own after the block instead, a `{>>...<<}` on no text, with a blank line before and after it, in a quote or a list item too, where the item's indent goes on its first line alone, as the indent of a line in a CriticMarkup span is its text's: on the block's last line, its first line end would end the block, which would show the rest of that line as text and leave the rest of the comment a paragraph of its own. There it stays a Word comment, and the HTML comment stays hidden. So does one in a paragraph that starts with another HTML comment out of the range, or that holds one a paragraph can't, as `<!-- b --->`, and so do the other HTML comments in that Word comment's range. It stays on the block's line, as before, where a line break and text follow the block in its paragraph, whose `\` would end the block's line, or where a comment in the block starts as a directive does, which the block, alone in its paragraph, would be read as. A range whose comment the file has no body for, which Word shows nothing of, imports as its text alone, as `{==text==}` with no comment after it would be a highlight. A comment whose text, or a reply's, has a line after its first that reads as a table's delimiter row, as `--- | ---`, takes ID syntax too, but for one on no text at the start of a paragraph, whose opener already starts its line, and one on an HTML comment, as above. Written after its anchor, its lines would make a table with the opener in a cell, which reads it as text. In ID syntax, the body's opener starts the table's first line, before the table. Replies written one after another, as `{>>note<<}{>>reply<<}`, go in the body instead, each on a line of its own, where one of them has such a line, as its opener after the one before would be in the table's cell.

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

A body can go on the lines after its paragraph, in a paragraph of its own, or at either end of a line. It adds no text to Word: the line ends and spaces around it, and a paragraph that holds only bodies, don't export. A quote right before or after such a paragraph comes back as many blank lines from the block on its other side as the side of it with more had. A line break written as one, a `\` or a `<br>`, does, as at the end of a range before its body, `{#1}a<br>{/1}{#1>>note<<}`, though a line end in `breaks` mode or a grid table's cell doesn't. On DOCX import, bodies go on the lines after their paragraph, in a note's too, inside its quote if it has one, or after a blank line below a table. A range can go on over paragraphs, and over the cells of a pipe or grid table, from one cell to the next in the table's order, as `| {#1}c | d{/1} |`: and into and out of the table, as `| {#1}c | d |` then `After.{/1}` after the table: import writes a Word comment over several cells, or over cells and the text around their table, so, as one comment, where a comment in each paragraph and cell would give Word one for each. A range open over a whole table needs no ID markers in its cells, an HTML table's too. An HTML table's cells don't take comment syntax (see [HTML Tables](#html-tables)), so import writes a comment that starts or ends in a table that is HTML whatever its cells hold, for its shape, as one with merged cells, or a font or column widths with `-->`, or in a table written as its embed directive, whose cells it leaves out, as a copy in each paragraph and cell. The preview highlights a range in each paragraph and cell it covers, and where it starts or ends inside a tracked change, emphasis or another range, ends that and starts it again around the range's own end, so neither loses its formatting.

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

The Markdown-to-DOCX converter preserves the first paragraph, nested sublists, blockquote continuation blocks, and HTML blocks within a list item. A comment alone in its block is hidden in Word, as one at the top level is. So is a block that starts and ends with a comment, as `<!-- c --><div>a</div><!-- d -->`, whole, with what's between its comments, as at the top level. A block that starts with a comment and goes on, as `<!-- c --><div>a</div>`, exports as text, as at the top level, and imports as it was. Other block-level content in list continuation — such as fenced code blocks, indented code blocks, horizontal rules, and tables, whether in Markdown or HTML — is still dropped during conversion and will not survive a round-trip. So is a comment after the item's text that reads as a directive, as `<!-- landscape -->`, which a list item can't hold, but for a style block's fences, each on a line of its own (see Custom Styles). A heading in a list item keeps its text as a paragraph but loses its level. Each of these gives a warning. So does a `<pre>`, `<script>`, `<style>`, or `<textarea>` block, or a comment, with a blank line in it, which ends the block inside a list item and is dropped.

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
