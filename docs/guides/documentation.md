# Writing Technical Documentation

Manuscript Markdown also works well for technical documentation and general prose.

## Why use Manuscript Markdown for Docs?

- **Roundtrip to Word**: Easily collaborate with stakeholders who require Word documents.
- **Review Workflow**: Use CriticMarkup annotations in Markdown, or Word's Track Changes — the two are interchangeable.
- **Rich Formatting**: Full support for tables, code blocks, GitHub-style callouts (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`), and complex formatting.
- **Image Support**: Images are extracted from DOCX on import and embedded on export, with dimension and alt text preservation.

## Workflow

### 1. Drafting

Write in standard Markdown. Use the **Preview** (`Cmd+K V` / `Ctrl+K V`) to see your document rendered in real-time.

### 2. Code Blocks

Use fenced code blocks for syntax highlighting:

```python
def hello():
    print("Hello, world!")
```

### 3. Review and Feedback

When collaborating with others:

- **Peers using VS Code**: Can use the annotation toolbar to add `{++suggestions++}` and `{>>comments<<}`.
- **Stakeholders using Word**: Export to Word, let them use Track Changes and comments, then import back to Markdown. The converter preserves their change tracking.

### 4. Callouts and Notes

Use blockquotes for simple callouts:

```markdown
> This is a note or aside.
```

For GitHub-style typed callouts:

```markdown
> [!NOTE]
> Highlights information readers should be aware of.

> [!TIP]
> Optional advice to help readers succeed.

> [!WARNING]
> Critical information about risks or unexpected behavior.
```

### 5. Tables

Manuscript Markdown supports three inline table formats—pipe tables, Pandoc grid tables, and HTML tables—as well as tables embedded from external files (`.xlsx`, `.csv`, `.tsv`, `.md`, and `.dta`). Use pipe tables for simple data:

```markdown
| Feature | Support |
|---------|---------|
| Tables  | Yes     |
| Code    | Yes     |
```

Pandoc grid tables support multi-line cells:

```markdown
+----------+----------+
| Feature  | Notes    |
+==========+==========+
| Tables   | Supports |
|          | multiple |
|          | lines    |
+----------+----------+
```

Grid tables do not support merged cells (`colspan` or `rowspan`). For inline tables, use HTML when cells must span columns or rows; HTML tables are fully supported and preserved during Word conversion. Merged cells in embedded `.xlsx` files are also preserved. See the [Tables specification](../specification.md#tables) for examples of all three inline formats.

When your data lives in an external file, embed it instead of copying it into your document:

```markdown
<!-- table-font-size: 9 -->
<!-- embed: data/metrics.csv -->
```

This embeds the external data as a table, with all the same formatting and export support as an inline table. Supported formats are `.csv`, `.tsv`, `.xlsx`, `.dta`, and `.md`. Stata embeds use variable names as headers by default and preserve value labels and display formats.

You can customize an embedded table by placing directives immediately before it:

```markdown
<!-- table-font-size: 9 -->
<!-- table-col-widths: 2 1 1 -->
<!-- table-digits: 2 -->
<!-- table-decimal-mark: comma -->
<!-- table-digit-grouping: thin-space -->
<!-- embed: data/results.dta -->
```

`table-digits` controls the number of digits after the decimal mark; `table-decimal-mark` accepts `source`, `point`, `comma`, or `midpoint`; and `table-digit-grouping` accepts `source`, `none`, `comma`, `period`, `space`, or `thin-space`. Put the same settings in YAML frontmatter to use them as document-wide defaults. See [Embedded Tables](../embedded-tables.md) for file-specific options and the [Tables specification](../specification.md#tables) for the complete formatting reference.

## Tips

- **Word Count**: Keep an eye on the status bar for document length.
- **Split View**: Open two different sections of the same document side by side, or view a reference file alongside your draft.
