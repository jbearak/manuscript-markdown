# DOCX Converter

The DOCX converter transforms Microsoft Word documents into Manuscript Markdown format, preserving formatting, comments, citations, and equations.

## What's Preserved

- **Title**: Word `Title` paragraph style extracted to `title:` frontmatter (multiple title paragraphs become multiple entries)
- **Author**: `dc:creator` from Document Properties extracted to `author:` frontmatter (only if non-blank)
- **Text formatting**: bold, italic, underline, strikethrough, superscript, subscript
- **Headings**: H1 through H6 from Word heading styles
- **Lists**: bulleted and numbered lists with nesting
- **Comments**: converted to CriticMarkup `{==highlighted text==}{>>author: comment<<}` format
- **Track changes**: insertions and deletions mapped to CriticMarkup `{++...++}` and `{--...--}`
- **Citations**: Zotero field codes converted to Pandoc `[@key]` syntax with BibTeX export
- **Zotero document preferences**: CSL style, locale, and note type extracted and preserved as YAML frontmatter (`csl`, `locale`, `note-type`)
- **Bibliography fields**: `ZOTERO_BIBL` field codes detected and omitted from Markdown output (bibliography is regenerated on export)
- **Math**: OMML equations converted to LaTeX (`$inline$` and `$$display$$`)
- **Hyperlinks**: preserved as Markdown links with proper escaping
- **Highlights**: colored highlights converted to `==text=={color}` syntax

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

- **Tables**: Not converted (complex Word table formats don't map cleanly to Markdown)
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

- **Title**: `title:` frontmatter entries rendered as Word Title-styled paragraphs at the beginning of the document
- **Author**: `author:` frontmatter written as `dc:creator` in Document Properties (omitted if no author specified)
- **Text formatting**: bold, italic, underline, strikethrough, superscript, subscript, highlights (including colored)
- **Headings**: H1 through H6 with proper Word heading styles
- **Lists**: bulleted and numbered lists with nesting
- **Blockquotes**: indented paragraphs with Quote style
- **Code**: inline code with monospace character style, fenced code blocks with shaded paragraph style
- **Hyperlinks**: preserved with proper relationship entries
- **Tables**: pipe-delimited tables with header formatting and borders
- **Track changes**: CriticMarkup additions/deletions/substitutions mapped to Word revisions (`w:ins`/`w:del`)
- **Comments**: CriticMarkup comments mapped to Word comments with author and date
- **Citations**: Pandoc `[@key]` citations reconstructed as Zotero field codes when BibTeX contains `zotero-key` and `zotero-uri` fields; visible text formatted by the CSL style if `csl` frontmatter is present. Mixed Zotero/non-Zotero grouped citations are split — Zotero entries become a field code and non-Zotero entries become plain text (configurable via `mixedCitationStyle`). Missing keys appear inline as `@citekey` with a post-bibliography note.
- **Bibliography**: automatically generated and appended as a `ZOTERO_BIBL` field when a CSL style is specified
- **Zotero document preferences**: `csl`, `locale`, and `note-type` from frontmatter written to `docProps/custom.xml` as `ZOTERO_PREF_*` properties, so Zotero can manage the document after export
- **Math**: LaTeX equations converted to OMML (inline and display)

### Template Support

When using **Export to Word (with template)**, the converter extracts styling parts from the template:

- `word/styles.xml` — heading fonts, body text formatting, spacing
- `word/theme/theme1.xml` — theme colors and fonts
- `word/numbering.xml` — list definitions
- `word/settings.xml` — document-level settings

The template controls appearance while the Markdown controls content.
