# DOCX Converter

The DOCX converter transforms Microsoft Word documents into Manuscript Markdown format, preserving formatting, comments, citations, and equations.

## Round-Trip Features

The converter supports DOCX → Markdown → DOCX round-tripping. The following features are preserved in both directions:

- **Title**: `title:` frontmatter ↔ Word `Title`-styled paragraphs (multiple entries supported)
- **Author**: `author:` frontmatter ↔ `dc:creator` in Document Properties (omitted if blank)
- **Text formatting**: Markdown syntax ↔ Word run formatting (bold, italic, underline, strikethrough, superscript, subscript)
- **Headings**: `#`–`######` Markdown headings ↔ Word heading styles (H1 through H6)
- **Lists**: Markdown list syntax ↔ Word numbering (bulleted and numbered with nesting)
- **Comments**: non-overlapping comments use CriticMarkup `{==highlighted text==}{>>author: comment<<}` format; overlapping comments use non-inline ID-based syntax (`{#1}highlighted text{/1}{#1>>alice: comment<<}`) — see [Specification](specification.md#overlapping-comments)
- **Track changes**: CriticMarkup `{++...++}` and `{--...--}` ↔ Word revisions (`w:ins`/`w:del`)
- **Citations**: Zotero field codes ↔ Pandoc `[@key]` syntax with BibTeX export. On import, `ZOTERO_BIBL` field codes are detected and omitted (bibliography is regenerated on export).
- **Zotero document preferences**: CSL style, locale, and note type round-tripped between YAML frontmatter (`csl`, `locale`, `note-type`) and `docProps/custom.xml` (`ZOTERO_PREF_*` properties)
- **Math**: OMML equations ↔ LaTeX (`$inline$` and `$$display$$`)
- **Hyperlinks**: Markdown links ↔ Word hyperlinks (with proper escaping)
- **Highlights**: colored highlights ↔ `==text=={color}` syntax
- **Blockquotes**: `> quoted text` ↔ Word Quote/Intense Quote paragraph style (with nesting)
- **Tables**: DOCX→Markdown import produces HTML tables (`<table>/<tr>/<th>/<td>`) to preserve multi-paragraph cell content; Markdown→DOCX export accepts both HTML tables and pipe-delimited tables (with `colspan` and `rowspan` support)

## Citation Key Formats

Configurable via `manuscriptMarkdown.citationKeyFormat`:

| Format | Example | Description |
|--------|---------|-------------|
| `authorYearTitle` (default) | `smith2020effects` | Author surname + year + first title word |
| `authorYear` | `smith2020` | Author surname + year |
| `numeric` | `1`, `2`, `3` | Sequential numbers |

## Usage

1. Right-click a `.docx` file in VS Code Explorer
2. Select **Export to Markdown**
3. Output: `filename.md` and `filename.bib` (if citations present)

Or use the command palette and select a file via dialog.

If output files already exist, you'll be prompted to replace, choose a new name, or cancel.

## Known Limitations

- **Complex nested tables**: nested `<table>` elements inside cells are not supported
- **Images**: Not extracted from DOCX
- **Footnotes/endnotes**: Not converted

## Export to Word

The converter also supports exporting Markdown back to DOCX, completing the round-trip workflow: DOCX → Markdown (edit) → DOCX (submit).

### Usage

1. Open a Markdown file in VS Code
2. Click the **Export to Word** submenu in the editor title bar
3. Choose **Export to Word** for default styling, or **Export to Word (with template)** to use a template DOCX for fonts, sizes, and spacing

If a companion `.bib` file exists with the same base name, it is automatically loaded for citation resolution. You can also specify a custom bibliography path in the YAML frontmatter using the `bibliography` field (see [Specification](specification.md#bibtex-companion-file)).

### YAML Frontmatter

When the Markdown file includes YAML frontmatter with a `csl` field, the converter uses [citeproc-js](https://github.com/Juris-M/citeproc-js) to format citations and bibliography according to the specified CSL style. This frontmatter is generated automatically when converting from DOCX (if the source document has Zotero preferences), but you can also add or change it manually:

```yaml
---
csl: apa
locale: en-US
note-type: in-text
bibliography: shared/references
---
```

| Field | Description |
|-------|-------------|
| `title` | Document title. Multiple `title:` entries create multi-paragraph titles. |
| `author` | Document author. Written as `dc:creator` in Document Properties on export. |
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`, `bmj`) or absolute path to a `.csl` file |
| `locale` | Optional locale override (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `note-type` | Optional Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. Legacy numeric values (0, 1, 2) are still accepted. |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`). Auto-generated on DOCX import for idempotent date roundtripping. |
| `bibliography` | Path to a `.bib` file (`.bib` extension optional). Aliases: `bib`, `bibtex`. See [Specification](specification.md#bibtex-companion-file). |

#### Bundled CSL styles

The following 16 styles are bundled and available without downloading:

`apa`, `bmj`, `chicago-author-date`, `chicago-fullnote-bibliography`, `chicago-note-bibliography`, `modern-language-association`, `ieee`, `nature`, `cell`, `science`, `american-medical-association`, `american-chemical-society`, `american-political-science-association`, `american-sociological-association`, `vancouver`, `harvard-cite-them-right`

If a style is not bundled, you will be prompted to download it from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Downloaded styles are cached in VS Code's global storage for reuse across workspaces.

### What's Exported

All [round-trip features](#round-trip-features) are preserved on export. The following additional features are supported:

- **Blockquotes**: indented paragraphs with Quote or Intense Quote style (configurable via `manuscriptMarkdown.blockquoteStyle`)
- **Code**: inline code with monospace character style, fenced code blocks with shaded paragraph style
- **Bibliography**: automatically generated and appended as a `ZOTERO_BIBL` field when a CSL style is specified
- **Mixed citations**: Mixed Zotero/non-Zotero grouped citations are split — Zotero entries become a field code and non-Zotero entries become plain text. The `manuscriptMarkdown.mixedCitationStyle` setting controls rendering: `"separate"` (default) gives each portion its own parentheses for clean Zotero refresh, while `"unified"` wraps everything in one set of parentheses (see [Zotero Round-Trip](zotero-roundtrip.md#mixedcitationstyle-setting)). Missing keys appear inline as `@citekey` with a post-bibliography note.

### Template Support

When using **Export to Word (with template)**, the converter extracts styling parts from the template:

- `word/styles.xml` — heading fonts, body text formatting, spacing
- `word/theme/theme1.xml` — theme colors and fonts
- `word/numbering.xml` — list definitions
- `word/settings.xml` — document-level settings

The template controls appearance while the Markdown controls content.
