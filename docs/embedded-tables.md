# Embedded Tables

Tables can be written directly in your document as [pipe tables](specification.md#pipe-tables), [grid tables](specification.md#grid-tables), or [HTML tables](specification.md#html-tables). When your data lives in an external file — a [spreadsheet](#xlsx), a [CSV or TSV](#csv-and-tsv) export, a [Stata dataset](#stata-dataset-dta), or a shared [markdown file](#markdown) — you can embed it instead using a single directive. The embedded table behaves identically to an inline table for formatting, preview, and Word export.

## Syntax

```markdown
<!-- embed: <path> [sheet=<name>] [range=<ref>] [headers=<n>] -->
```

File paths are resolved relative to the markdown file containing the directive. All values (including the file path) support optional single or double quotes to allow spaces:

```markdown
<!-- embed: "my data/results.xlsx" sheet='Sheet One' range=A1:F20 headers=2 -->
```

### Parameters

| Param | Applies to | Default | Description |
|-------|-----------|---------|-------------|
| `sheet` | .xlsx | First sheet | Sheet name or 1-based index |
| `range` | .xlsx | Auto-detect bounding rectangle | Cell range (e.g. `A1:F20`) or named range |
| `headers` | .csv, .tsv, .xlsx, .dta | `1` (.csv/.tsv/.xlsx) or variable names (.dta) | Number of header rows. For .dta files, replaces variable names. |

## File Types

| Format | What is embedded |
|--------|------------------|
| `.xlsx` | A worksheet, cell range, or named range; merged cells are preserved |
| `.csv` | Comma-separated rows, with configurable header rows |
| `.tsv` | Tab-separated rows, with configurable header rows |
| `.md` | Pipe, Pandoc grid, and HTML tables from another Markdown file |
| `.dta` | A Stata dataset with variable names, value labels, display formats, and missing values |

### CSV and TSV

Embed a comma-separated or tab-separated file:

```markdown
<!-- embed: data/results.csv -->
<!-- embed: data/results.tsv headers=2 -->
```

CSV/TSV parsing follows [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180): quoted fields may contain embedded newlines and the delimiter character, and `""` within a quoted field produces a literal `"`. The `headers` parameter controls how many rows are treated as header rows (default: 1).

### XLSX

Embed a sheet (or part of a sheet) from an Excel workbook:

```markdown
<!-- embed: data/budget.xlsx -->
<!-- embed: data/budget.xlsx sheet=Summary range=A1:D10 -->
<!-- embed: data/budget.xlsx sheet=2 range=Q1Results -->
```

- **Sheet selection**: by name or 1-based index. If omitted, uses the first sheet.
- **Range**: a cell reference like `A1:D10`, or a named range defined in the workbook. If omitted, the bounding rectangle of all non-empty cells is used.
- **Merged cells**: preserved as `colspan`/`rowspan` in the output.
- **Number formats**: displayed values and Excel number-format semantics are preserved.

### Markdown

Embed tables from another markdown file:

```markdown
<!-- embed: shared/standard-table.md -->
```

Only table content (pipe tables, Pandoc grid tables, HTML tables) and table directives (`table-font-size`, `table-font`, `table-orientation`, `table-col-widths`, `table-digits`, `table-decimal-mark`, `table-digit-grouping`) are included from the embedded file. Grid tables support multi-line cells but not merged cells; use an HTML table with `colspan` or `rowspan` for spans. Non-table content is silently ignored, with an informational diagnostic in the editor. Cell content is rendered as plain Markdown only — Manuscript-specific syntax such as CriticMarkup, citations, and math is not processed within embedded `.md` tables.

### Stata dataset (.dta)

Embed a Stata dataset:

```markdown
<!-- embed: data/auto.dta -->
```

By default, **variable names** become the header row. Value labels and display formats are always applied — if a variable has an associated value label table, labels are shown instead of raw numeric codes.

To use data rows as headers instead of variable names, set `headers`:

```markdown
<!-- embed: data/auto.dta headers=1 -->
```

This replaces the variable name header with the first data row (or first N rows when `headers=N`).

**Missing values** (`.`, `.a`–`.z`) are displayed using their value label if one exists, or the raw missing code otherwise. In the VS Code preview, missing values are colorized using the editor's error color (typically red) to make them visually distinct. In Word export, missing values appear as plain text.

**File size limit:** To prevent accidentally embedding very large datasets, files larger than 10 MB are rejected by default. Adjust this limit with the `manuscriptMarkdown.embedDtaMaxFileSize` setting (value in bytes).

Supported Stata formats: Stata 8+ (file formats 113–115 and 117–119).

## Example

Suppose you have a CSV file `data/survey-results.csv`:

```csv
Question,Agree,Neutral,Disagree
The interface is intuitive,72%,18%,10%
Documentation is sufficient,65%,20%,15%
Response time is acceptable,80%,12%,8%
I would recommend the product,74%,16%,10%
```

To embed it in your document with a smaller font:

```markdown
<!-- table-font-size: 9 -->
<!-- embed: data/survey-results.csv -->
```

This renders as a normal table in both the preview and Word output. If you update the CSV file, the table updates automatically the next time you preview or export.

## Formatting Embedded Tables

Embedded tables use the same table settings as inline tables. Place per-table directives immediately before the embed comment to override formatting for that embedded table:

```markdown
<!-- table-font-size: 9 -->
<!-- table-font: Helvetica -->
<!-- table-col-widths: 2 1 1 1 -->
<!-- table-digits: 2 -->
<!-- table-decimal-mark: midpoint -->
<!-- embed: data/results.csv -->
```

Available per-table directives for embeds are `table-font-size`, `table-font`, `table-orientation`, `table-col-widths`, `table-digits`, `table-decimal-mark`, and `table-digit-grouping`. See the [Tables](specification.md#tables) section of the Specification for the full directive reference.

### Column widths

Use `table-col-widths` to set widths for an embedded table:

```markdown
<!-- table-col-widths: 3 1 1 1 -->
<!-- embed: data/results.csv -->
```

The values are ratios, not fixed measurements. In the example above, the first column gets three times as much width as each other column. Use `equal` to force equal-width columns, or `auto` to restore Word's default automatic sizing for a table that would otherwise inherit a document-wide default:

```markdown
<!-- table-col-widths: equal -->
<!-- embed: data/results.csv -->
```

If there are fewer width values than columns, the last value repeats. For example, `3 1` on a four-column table is treated as `3 1 1 1`.

### Numeric formatting

Use the three numeric directives independently or together:

```markdown
<!-- table-digits: 2 -->
<!-- table-decimal-mark: comma -->
<!-- table-digit-grouping: thin-space -->
<!-- embed: data/results.dta -->
```

| Directive | Accepted values | Effect |
|-----------|-----------------|--------|
| `table-digits` | `source` or an integer from 0 to 1000 | Rounds or pads numbers to exactly that many digits after the decimal mark |
| `table-decimal-mark` | `source`, `point`, `comma`, `midpoint` | Chooses the decimal character |
| `table-digit-grouping` | `source`, `none`, `comma`, `period`, `space`, `thin-space` | Chooses the separator between three-digit groups |

An omitted directive inherits its document-wide frontmatter value. Setting a per-table directive to `source` cancels that inherited setting and preserves the source display for that property. Decimal and grouping settings cannot use the same character.

Excel cells use their displayed value and number format; Stata cells use their display format. Percent, currency, and scientific notation are retained. Value labels, missing values, dates, Booleans, and identifiers are not reformatted as ordinary numbers. CSV, TSV, and Markdown cells are reformatted only when the entire cell is unambiguously numeric or statistical.

### Document-wide defaults

Document-wide table defaults set in [frontmatter](specification.md#yaml-frontmatter) apply to embedded tables automatically, with no per-table directive needed:

```yaml
---
table-font: Helvetica
table-font-size: 9
table-col-widths: 2 1 1 1
table-borders: horizontal
table-digits: source
table-decimal-mark: midpoint
table-digit-grouping: thin-space
---
```

Per-table directives placed before the embed comment override frontmatter defaults. `table-borders` is frontmatter-only; the other settings shown above can be overridden per table.

## Page Orientation and Isolation

When a table needs more horizontal space than a portrait page allows, or when you want a table (with its title and notes) on its own page, use orientation fences.

### Landscape pages for wide tables

Wrap the table and any surrounding text (title, notes) in `<!-- landscape -->` / `<!-- /landscape -->` fences. Everything between the fences is rendered on landscape-oriented pages in the Word output:

```markdown
<!-- landscape -->

Table 3. Full Regression Results

<!-- table-font-size: 9 -->
<!-- embed: data/regression.csv -->

Note: Standard errors in parentheses. * p < 0.05, ** p < 0.01.

<!-- /landscape -->
```

### Isolating tables on their own pages

Use `<!-- portrait -->` / `<!-- /portrait -->` fences to place a table on its own portrait page with explicit section breaks before and after:

```markdown
<!-- portrait -->

Table 2. Survey Demographics

<!-- embed: data/demographics.xlsx sheet=Summary -->

<!-- /portrait -->
```

This is useful when you want a table to start on a fresh page without affecting the flow of surrounding text, or when grouping several related tables together:

```markdown
<!-- portrait -->

Table 4. Treatment Group A

<!-- embed: data/results.xlsx sheet=GroupA -->

Table 5. Treatment Group B

<!-- embed: data/results.xlsx sheet=GroupB -->

<!-- /portrait -->
```

See [Specification: Page Orientation Sections](specification.md#page-orientation-sections) for full details on orientation fences.

## Custom Styles for Table Titles and Notes

If your document defines [custom styles](specification.md#custom-styles) in [YAML frontmatter](specification.md#yaml-frontmatter), you can apply them to table titles and notes using `<!-- style: name -->` / `<!-- /style -->` fencing. [Style directives](specification.md#block-directive-syntax) are independent of orientation fences: use them inside a `portrait` or `landscape` fence when a table is isolated, or directly in the normal document flow as shown below:

```markdown
<!-- style: table-title -->
Table 6. Descriptive Statistics by Region
<!-- /style -->

<!-- embed: data/descriptive-stats.csv -->

<!-- style: table-note -->
Note: All values are population-weighted. Source: 2024 Census Bureau estimates.
<!-- /style -->
```

See [Specification: Custom Styles](specification.md#custom-styles) for the frontmatter syntax and available properties.

## Round-Trip Behavior

When you export to Word, embed directives are expanded into full tables — the resulting DOCX contains the actual table data, not a reference to an external file. The original directive is preserved internally so that re-importing the DOCX recovers the embed reference rather than inlining the table as Markdown.

If the external file changes between export and re-import, the next export picks up the updated data. The embedded file is always the source of truth.

## Errors and Diagnostics

If something goes wrong with an embed, you'll see feedback in two places: an error message rendered in the preview (in place of the table) and a diagnostic in the editor's Problems panel.

| Condition | Severity | Message |
|-----------|----------|---------|
| File not found | Error | `could not embed <path> — file not found` |
| Malformed CSV or corrupt XLSX | Error | `could not embed <path> — parse error` |
| Sheet not found (XLSX) | Error | `sheet '<name>' not found in <path>` |
| Named range not found (XLSX) | Error | `range '<name>' not found in <path>` |
| Invalid parameter syntax | Error | `invalid embed parameter: <detail>` |
| File produces no table rows | Warning | `<path> produced an empty table` |
| Embedded .md has non-table content | Info | `non-table content in <path> was ignored` |
| .dta file exceeds size limit | Error | `.dta file exceeds maximum size (<limit>)` |
| Unsupported .dta format version | Error | `unsupported .dta format` |
