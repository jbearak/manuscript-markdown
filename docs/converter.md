# DOCX Converter

The DOCX converter transforms Microsoft Word documents into Manuscript Markdown format, preserving formatting, comments, citations, and equations.

## What's Preserved

- **Text formatting**: bold, italic, underline, strikethrough, superscript, subscript
- **Headings**: H1 through H6 from Word heading styles
- **Lists**: bulleted and numbered lists with nesting
- **Comments**: converted to CriticMarkup `{==highlighted text==}{>>author: comment<<}` format
- **Track changes**: insertions and deletions mapped to CriticMarkup `{++...++}` and `{--...--}`
- **Citations**: Zotero field codes converted to Pandoc `[@key]` syntax with BibTeX export
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

If a companion `.bib` file exists with the same base name, it is automatically loaded for citation resolution.

### What's Exported

- **Text formatting**: bold, italic, underline, strikethrough, superscript, subscript, highlights (including colored)
- **Headings**: H1 through H6 with proper Word heading styles
- **Lists**: bulleted and numbered lists with nesting
- **Blockquotes**: indented paragraphs with Quote style
- **Code**: inline code with monospace character style, fenced code blocks with shaded paragraph style
- **Hyperlinks**: preserved with proper relationship entries
- **Tables**: pipe-delimited tables with header formatting and borders
- **Track changes**: CriticMarkup additions/deletions/substitutions mapped to Word revisions (`w:ins`/`w:del`)
- **Comments**: CriticMarkup comments mapped to Word comments with author and date
- **Citations**: Pandoc `[@key]` citations reconstructed as Zotero field codes when BibTeX contains `zotero-key` and `zotero-uri` fields
- **Math**: LaTeX equations converted to OMML (inline and display)

### Template Support

When using **Export to Word (with template)**, the converter extracts styling parts from the template:

- `word/styles.xml` — heading fonts, body text formatting, spacing
- `word/theme/theme1.xml` — theme colors and fonts
- `word/numbering.xml` — list definitions
- `word/settings.xml` — document-level settings

The template controls appearance while the Markdown controls content.
