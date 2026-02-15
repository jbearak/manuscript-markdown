# Manuscript Markdown Specification

Manuscript Markdown extends standard Markdown with CriticMarkup annotations, Pandoc citation syntax, and custom extensions for manuscript editing.

## YAML Frontmatter

Manuscript Markdown files may begin with a YAML frontmatter block delimited by `---`. The `title` field stores the document title:

```yaml
---
title: My Document Title
author: Jane Smith
csl: apa
locale: en-US
note-type: in-text
timezone: -05:00
---
```

Multi-paragraph titles use multiple `title` entries:

```yaml
---
title: First Paragraph of Title
title: Second Paragraph of Title
---
```

The frontmatter may also include citation-related fields (`csl`, `locale`, `note-type`) and metadata (`author`, `timezone`). See [converter](converter.md) for details on how these fields are handled during conversion.

| Field | Description |
|-------|-------------|
| `title` | Document title. Multiple `title:` entries create multi-paragraph titles. |
| `author` | Document author. Written as `dc:creator` in Document Properties on DOCX export. |
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`) or absolute path to a `.csl` file. Controls citation and bibliography formatting. |
| `locale` | Locale override for citation formatting (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `note-type` | Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`). Auto-generated on DOCX import for idempotent date roundtripping. |

## Standard Markdown

Manuscript Markdown supports all [CommonMark](https://commonmark.org/) and [GitHub Flavored Markdown](https://github.github.com/gfm/) syntax:

- **Formatting**: bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`), underline (`<u>text</u>`), superscript (`<sup>text</sup>`), subscript (`<sub>text</sub>`), inline code (`` `code` ``)
- **Headings**: `# H1` through `###### H6`
- **Lists**: bulleted (`- item`), numbered (`1. item`), task lists (`- [ ] item`)
- **Links**: `[text](url)`
- **Code blocks**: fenced with triple backticks
- **Blockquotes**: `> quoted text`
- **Tables**: pipe-delimited with alignment support

## Pandoc Extensions

### Citations

Pandoc-style citations using BibTeX keys:

- Single citation: `[@smith2020]`
- With locator: `[@smith2020, p. 20]`
- Multiple citations: `[@smith2020; @jones2021]`
- Suppress author: `[-@smith2020]`

Citations reference entries in a companion `.bib` file (see [BibTeX Companion File](#bibtex-companion-file) below).

### BibTeX Companion File

Citations reference a companion `.bib` file with the same base name as the Markdown file (e.g., `paper.md` uses `paper.bib`). Each entry contains standard BibTeX fields:

- `author`, `title`, `journal`/`booktitle`, `year`, `volume`, `number`, `pages`
- `doi`, `url`, `publisher`, `edition`, `abstract`

When exported from Zotero via DOCX import, entries also include identity fields for roundtrip reconstruction:

- `zotero-key` — the Zotero item key
- `zotero-uri` — the Zotero item URI

These fields allow the Markdown-to-DOCX exporter to reconstruct Zotero field codes in the output document. See [Zotero Citation Roundtrip](zotero-roundtrip.md) for details.

## LaTeX Equations

Manuscript Markdown supports LaTeX math notation, which is converted to and from Word's OMML equation format during roundtrip conversion.

- **Inline math**: `$...$` — renders within the text flow
- **Display math**: `$$...$$` — renders as a centered block equation

Supported LaTeX elements include:

- Fractions (`\frac{a}{b}`), roots (`\sqrt{x}`, `\sqrt[n]{x}`)
- Greek letters (`\alpha`, `\beta`, `\Gamma`, etc.)
- Operators and relations (`\sum`, `\int`, `\leq`, `\geq`, `\neq`, etc.)
- Matrices (`\begin{matrix}...\end{matrix}`)
- Accents and decorations (`\hat{x}`, `\bar{x}`, `\vec{x}`, etc.)
- Subscripts and superscripts (`x_i`, `x^2`)

## CriticMarkup

Five annotation operations for tracking changes. See [CriticMarkup Syntax](criticmarkup.md) for details.

- Addition: `{++text++}`
- Deletion: `{--text--}`
- Substitution: `{~~old~>new~~}`
- Comment: `{>>text<<}`
- Highlight: `{==text==}`

## Custom Extensions

Manuscript Markdown adds colored highlights and comment attribution. See [Custom Extensions](custom-extensions.md) for details.

- Colored highlights: `==text=={color}`
- Comment attribution: `{>>author (date): text<<}`
